#!/usr/bin/env node
// scripts/kpi-followups-report.js — the read-only "what would change" report for
// the KPI follow-ups (R16 weekly figures; later parts add the other lanes). Run
// it on the server, from the app directory, before a KPI flag goes on.
//
// --part=weekly (KPI_WEEKLY_ENABLED). It lifts this checkout's KPI gatherers
// from server.js (scripts/lib/server-lift.js closure()) and runs this checkout's
// lib/kpi-metrics.js computeKpis() twice on one read of the data, weekly off and
// on, against a read-only handle of app.db and one read-only read of Job
// Tracking. Nothing is written: no kpi_* row, no setting, no audit row. It
// prints counts, metric keys and the server's display strings only (no name,
// load id or address), and:
//   1. per metric: its weekly mode, the last 4 complete weeks, last week's
//      comparison and the week to date (or why it is monthly only);
//   2. monthlyUnchanged: everything but the weekly blocks is identical between
//      the two runs;
//   3. approvalsUnchanged: every metric's approval, as GET /api/admin/kpis would
//      show it from the stored approvals, is the same with weekly figures on;
//   4. the kpi_series_weekly rows a run would write, and the compute time the
//      weekly rows add against the run's 4-minute box;
//   5. the comparisons withheld for coverage;
//   6. the weeks that cross a month end, and the closed months (period_locks)
//      the weeks touch, read only.
// Exit codes: 0 done, 1 a proof failed (2 or 3) or an error, 2 refused.
//
// Usage:
//   node scripts/kpi-followups-report.js --part=weekly --db=app.db --sheet-id=env [--as-of=YYYY-MM-DD] [--json]
//   --sheet-id=env         the SPREADSHEET_ID the app's .env sets (refused when none)
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      with a copy of the database under the temp directory only
//   --as-of=YYYY-MM-DD     the run's business day (default: today in APP_TIMEZONE)

"use strict";

const path = require("path");
const { createRequire } = require("module");
const { parseArgs, sheetFor, envFor, openDb } = require("./lib/ledger-world");
const { closure } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");

const ROOT = path.join(__dirname, "..");
const KPI_RUN_TIME_LIMIT_MS = 4 * 60 * 1000;
const ROOTS = ["kpiSheetLoads", "kpiGatherDbInputs", "kpiAssembleInputs", "kpiReadSettings", "kpiApprovalSettings", "parseSheet", "deduplicateLoads", "liveJobTrackingView", "APP_TIMEZONE"];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "fetch"];
// What the report must never lift: the KPI job's writers and sender, the HTTP
// server, sockets, the Sheets writer, the mailer, Drive.
const DENIED = ["kpiStoreResult", "runKpiSnapshot", "kpiClaimAndSend", "getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "jtCacheInvalidate", "sendEmail", "transporter", "getDrive"];
const LIFTED_REQUIRE_OK = (m) => m === "crypto" || /^\.\/lib\/[\w.-]+$/.test(m);

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

// The KPI gatherers, lifted from this checkout's server.js over a read-only db.
function liftKpi(db, env) {
	const SRC = serverSource({ root: ROOT });
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const lifted = closure(SRC, { roots: ROOTS, provided: PROVIDED, denied: DENIED });
	const liftedRequire = (m) => {
		if (!LIFTED_REQUIRE_OK(m)) throw new Error(`lifted code required ${m}, which this report does not load`);
		return appRequire(m);
	};
	const noFetch = () => { throw new Error("lifted code called fetch(); this report makes no network calls"); };
	const quiet = { log() {}, warn() {}, error: (...a) => console.error(...a) };
	const body = `"use strict";\n${lifted.text}\nreturn { kpiSheetLoads, kpiGatherDbInputs, kpiAssembleInputs, kpiReadSettings, kpiApprovalSettings, parseSheet, deduplicateLoads, liveJobTrackingView, APP_TIMEZONE };`;
	return new Function("db", "require", "console", "process", "__dirname", "fetch", body)(
		db, liftedRequire, quiet, { env: { ...env }, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } }, ROOT, noFetch,
	);
}

const stripWeekly = (result) => ({ ...result, metrics: result.metrics.map((m) => { const { weekly: _w, ...rest } = m; return rest; }) });

async function weeklyPart(args) {
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let env;
	let dbFile;
	try {
		({ env, file: dbFile } = envFor({ root: ROOT, dbPath: args.db, envFile }));
	} catch (err) {
		refuse(err.message);
	}
	const db = openDb({ root: ROOT, dbFile, readonly: true });
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const kpiMetrics = appRequire("./lib/kpi-metrics");
	const kpiCatalog = appRequire("./lib/kpi-catalog");
	const appTime = appRequire("./lib/app-time");
	try {
		const k = liftKpi(db, env);
		const asOfDay = typeof args["as-of"] === "string" ? args["as-of"] : appTime.dayInZone(new Date(), k.APP_TIMEZONE);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDay)) refuse("--as-of must be YYYY-MM-DD");
		const values = await sheetFor(args, ROOT);
		const parsed = k.parseSheet(values);
		parsed.data = k.deduplicateLoads(parsed.data, parsed.headers);
		const sheet = k.kpiSheetLoads(k.liveJobTrackingView(parsed));
		const settings = k.kpiReadSettings();
		const dbIn = k.kpiGatherDbInputs(db, { asOfDay, timeZone: k.APP_TIMEZONE });
		const base = k.kpiAssembleInputs({ asOfDay, settings, sheet, dbIn });
		const offInputs = { ...base };
		delete offInputs.weekly;

		let t0 = Date.now();
		const off = kpiMetrics.computeKpis(offInputs);
		const offMs = Date.now() - t0;
		t0 = Date.now();
		const on = kpiMetrics.computeKpis({ ...offInputs, weekly: true });
		const onMs = Date.now() - t0;

		const monthlyUnchanged = JSON.stringify(stripWeekly(on)) === JSON.stringify(off);
		const approvals = db.prepare("SELECT metric_key, approved, definition_version, settings_hash, approved_by, approved_at FROM kpi_metric_approvals").all();
		const approvalSettings = k.kpiApprovalSettings(settings);
		const respond = (weekly) => kpiMetrics.buildKpiResponse({ asOfDay, settings, approvalSettings, approvals, snapshots: [], series: [], generatedAt: "", ...(weekly ? { weekly: true, weeklyRows: [] } : {}) });
		const approvalOf = (r) => r.metrics.map((m) => [m.key, m.approval.approved, m.approval.stale]);
		const approvalsUnchanged = JSON.stringify(approvalOf(respond(true))) === JSON.stringify(approvalOf(respond(false)));

		const metrics = [];
		const withheld = [];
		let rows = 0;
		const crossing = new Set();
		for (const m of on.metrics) {
			const w = m.weekly || {};
			if (w.mode !== "weekly") {
				metrics.push({ key: m.key, mode: w.mode || "none", reason: w.reason || "" });
				continue;
			}
			rows += w.rows.length;
			const complete = w.rows.filter((r) => !r.partial);
			const open = w.rows.find((r) => r.partial) || null;
			const last = complete[complete.length - 1] || null;
			for (const r of w.rows) {
				if (r.vs && r.vs.status === "withheld") withheld.push({ key: m.key, week: r.label });
				if (r.weekStart.slice(0, 7) !== r.to.slice(0, 7)) crossing.add(r.label);
			}
			metrics.push({
				key: m.key, mode: "weekly",
				lastFour: complete.slice(-4).map((r) => ({ week: r.label, display: r.display })),
				comparison: last && last.vs ? { label: last.vs.label, display: last.vs.display, status: last.vs.status } : null,
				toDate: open ? { week: open.label, display: open.display } : null,
			});
		}
		const weeks = (on.metrics.find((m) => m.weekly && m.weekly.mode === "weekly") || { weekly: { rows: [] } }).weekly.rows;
		const from = weeks.length ? weeks[0].weekStart : null;
		const months = new Set(weeks.flatMap((r) => [r.weekStart.slice(0, 7), r.to.slice(0, 7)]));
		let closedMonths = [];
		try {
			closedMonths = db.prepare("SELECT period FROM period_locks WHERE status = 'locked' ORDER BY period").all().map((r) => r.period).filter((p) => months.has(p));
		} catch {
			closedMonths = ["(period_locks not readable)"];
		}
		return {
			part: "weekly", asOfDay, timeZone: k.APP_TIMEZONE, weekRule: kpiCatalog.WEEK_RULE, weeksFrom: from,
			metrics, monthlyUnchanged, approvalsUnchanged,
			rowsWritten: rows, computeMsOff: offMs, computeMsOn: onMs, computeMsAdded: onMs - offMs, runTimeBoxMs: KPI_RUN_TIME_LIMIT_MS,
			withheld, weeksCrossingMonthEnd: [...crossing], closedMonthsTouched: closedMonths,
		};
	} finally {
		db.close();
	}
}

function printText(r) {
	const lines = [`KPI follow-ups report, part ${r.part} (read-only). As of ${r.asOfDay} (${r.timeZone}); weeks from ${r.weeksFrom || "-"}.`, r.weekRule, "", "1. Per metric:"];
	for (const m of r.metrics) {
		if (m.mode !== "weekly") { lines.push(`  ${m.key}: ${m.mode}. ${m.reason}`); continue; }
		lines.push(`  ${m.key}: ${m.lastFour.map((w) => `${w.week} ${w.display}`).join(" | ")}`);
		lines.push(`    last week ${m.comparison ? `${m.comparison.label}: ${m.comparison.display} (${m.comparison.status})` : "not compared"}; this week so far ${m.toDate ? `${m.toDate.week}: ${m.toDate.display}` : "-"}`);
	}
	lines.push("", `2. monthlyUnchanged: ${r.monthlyUnchanged ? "yes" : "NO"}`);
	lines.push(`3. approvalsUnchanged: ${r.approvalsUnchanged ? "yes" : "NO"}`);
	lines.push(`4. kpi_series_weekly rows a run would write: ${r.rowsWritten}. Compute: ${r.computeMsOff} ms off, ${r.computeMsOn} ms on (+${r.computeMsAdded} ms) of a ${r.runTimeBoxMs} ms run box.`);
	lines.push(`5. Comparisons withheld for coverage: ${r.withheld.length ? r.withheld.map((w) => `${w.key} ${w.week}`).join("; ") : "none"}`);
	lines.push(`6. Weeks crossing a month end: ${r.weeksCrossingMonthEnd.join("; ") || "none"}. Closed months the weeks touch (read only): ${r.closedMonthsTouched.join(", ") || "none"}.`);
	console.log(lines.join("\n"));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.part !== "weekly") refuse("--part=weekly is the one part this checkout has");
	if (!args.db || args.db === true) refuse("--db is required");
	const result = await weeklyPart(args);
	if (args.json === true) console.log(JSON.stringify(result, null, 1));
	else printText(result);
	if (!result.monthlyUnchanged || !result.approvalsUnchanged) process.exitCode = 1;
}

if (require.main === module) main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });

module.exports = { ROOTS, DENIED };
