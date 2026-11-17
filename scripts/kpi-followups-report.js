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
//      weekly rows add (the median of warm runs, signed) against the 4-minute box;
//   5. the comparisons withheld for coverage;
//   6. the weeks that cross a month end, and the closed months (period_locks)
//      the weeks touch, read only;
//   (a) R4: the Monday email as lib/kpi-digest.js builds it from this run's own
//      answer, for the next Monday and for a first Monday, never sent;
//   (b) the metrics approved now, each with its approval day, and those K29
//      asks to approve again for their weekly figures.
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
const ROOTS = ["kpiSheetLoads", "kpiGatherDbInputs", "kpiAssembleInputs", "kpiReadSettings", "kpiApprovalSettings", "parseSheet", "deduplicateLoads", "liveJobTrackingView", "APP_TIMEZONE",
	"kpiPayload", "kpiWeeklyRowsOf", "kpiEnforceApprovals", "KPI_SNAPSHOT_STATUSES", "KPI_CONFIDENCES"];
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
	const body = `"use strict";\n${lifted.text}\nreturn { kpiSheetLoads, kpiGatherDbInputs, kpiAssembleInputs, kpiReadSettings, kpiApprovalSettings, parseSheet, deduplicateLoads, liveJobTrackingView, APP_TIMEZONE, kpiPayload, kpiWeeklyRowsOf, kpiEnforceApprovals, KPI_SNAPSHOT_STATUSES, KPI_CONFIDENCES };`;
	return new Function("db", "require", "console", "process", "__dirname", "fetch", body)(
		db, liftedRequire, quiet, { env: { ...env }, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } }, ROOT, noFetch,
	);
}

const stripWeekly = (result) => ({ ...result, metrics: result.metrics.map((m) => { const { weekly: _w, ...rest } = m; return rest; }) });

// (a): the rows one run stores, as kpiStoreResult() maps them with the lifted
// kpiPayload() and kpiWeeklyRowsOf(), so the email reads what the server would.
const WEEKLY_COLUMNS = ["week_start", "week_end", "to_day", "partial", "label", "value", "display", "coverage", "vs_label", "vs_display", "vs_status"];
function storedRows(result, day, k, kpiCatalog) {
	const snapshots = result.metrics.map((m) => ({
		day, metric_key: m.key, value: Number.isFinite(m.value) ? m.value : null,
		display: typeof m.display === "string" ? m.display.slice(0, 120) : "",
		status: k.KPI_SNAPSHOT_STATUSES.includes(m.status) ? m.status : "missing",
		confidence: k.KPI_CONFIDENCES.includes(m.confidence) ? m.confidence : "none",
		definition_version: Number(kpiCatalog.metricByKey(m.key).definitionVersion) || 1,
		payload: k.kpiPayload(m, () => {}),
	}));
	const series = result.metrics.flatMap((m) => (Array.isArray(m.series) ? m.series : [])
		.filter((s) => s && /^\d{4}-\d{2}$/.test(String(s.period || "")))
		.map((s) => ({ metric_key: m.key, period: s.period, value: Number.isFinite(s.value) ? s.value : null, display: typeof s.display === "string" ? s.display.slice(0, 60) : "", coverage: Number.isFinite(s.coverage) ? s.coverage : null })));
	const weeklyRows = result.metrics.flatMap((m) => k.kpiWeeklyRowsOf(m).map((w) => Object.fromEntries([["metric_key", m.key], ...WEEKLY_COLUMNS.map((c, i) => [c, w[i]])])));
	return { snapshots, series, weeklyRows };
}

// The Monday on or after `day`, and the first Monday dated the 1st to the 7th from it.
function mondaysFrom(day) {
	const plus = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
	let next = day;
	while (new Date(`${next}T12:00:00Z`).getUTCDay() !== 1) next = plus(next, 1);
	let first = next;
	while (+first.slice(8, 10) > 7) first = plus(first, 7);
	return { next, first };
}

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
	const kpiDigest = appRequire("./lib/kpi-digest");
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

		// L7: a warm-up of each mode, then the median of a few alternating runs.
		const RUNS = 3;
		kpiMetrics.computeKpis(offInputs);
		kpiMetrics.computeKpis({ ...offInputs, weekly: true });
		const times = { off: [], on: [] };
		let off;
		let on;
		for (let i = 0; i < RUNS; i++) {
			let t0 = Date.now();
			off = kpiMetrics.computeKpis(offInputs);
			times.off.push(Date.now() - t0);
			t0 = Date.now();
			on = kpiMetrics.computeKpis({ ...offInputs, weekly: true });
			times.on.push(Date.now() - t0);
		}
		const median = (list) => [...list].sort((x, y) => x - y)[Math.floor(list.length / 2)];
		const offMs = median(times.off);
		const onMs = median(times.on);

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

		// (a) and (b): this run's answer as GET would serve it with weekly figures
		// on; kpi.weekly_since is absent before the first switch-on.
		let sinceRow = null;
		try {
			sinceRow = db.prepare("SELECT value FROM server_state WHERE key = 'kpi.weekly_since'").get();
		} catch {
			sinceRow = null;
		}
		const stored = storedRows(on, asOfDay, k, kpiCatalog);
		const answer = k.kpiEnforceApprovals(kpiMetrics.buildKpiResponse({
			asOfDay, timeZone: k.APP_TIMEZONE, generatedAt: new Date().toISOString(), settings, approvalSettings, approvals, derived: on.derived,
			snapshots: stored.snapshots, series: stored.series, weekly: true, weeklyRows: stored.weeklyRows, weeklySince: sinceRow ? String(sinceRow.value) : null,
		}), approvals, approvalSettings);
		const mondays = mondaysFrom(asOfDay);
		const digestOn = (day) => {
			const d = kpiDigest.buildDigest({ response: answer, preview: false, asOfDay: day });
			return { day, subject: d.subject, text: d.text };
		};
		const email = { builtFrom: asOfDay, nextMonday: digestOn(mondays.next), firstMonday: digestOn(mondays.first) };
		const approvedNow = answer.metrics.filter((m) => m.approval && m.approval.approved === true).map((m) => {
			const mode = (kpiCatalog.weeklyModeOf(m.key) || {}).mode || "none";
			return { key: m.key, day: m.approval.at ? appTime.dayInZone(new Date(m.approval.at), k.APP_TIMEZONE) : null, mode, reapprove: mode === "weekly" && m.approval.coversWeekly !== true };
		});

		return {
			part: "weekly", asOfDay, timeZone: k.APP_TIMEZONE, weekRule: kpiCatalog.weekRuleText(kpiMetrics.weekCalendar(k.APP_TIMEZONE)), weeksFrom: from,
			metrics, monthlyUnchanged, approvalsUnchanged,
			rowsWritten: rows, computeMsOff: offMs, computeMsOn: onMs, computeMsAdded: onMs - offMs, computeRuns: RUNS, runTimeBoxMs: KPI_RUN_TIME_LIMIT_MS,
			withheld, weeksCrossingMonthEnd: [...crossing], closedMonthsTouched: closedMonths,
			email, approvedNow,
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
	const added = `${r.computeMsAdded < 0 ? "-" : "+"}${Math.abs(r.computeMsAdded)}`;
	lines.push(`4. kpi_series_weekly rows a run would write: ${r.rowsWritten}. Compute, the median of ${r.computeRuns} warm runs: ${r.computeMsOff} ms off, ${r.computeMsOn} ms on (${added} ms) of a ${r.runTimeBoxMs} ms run box.`);
	lines.push(`5. Comparisons withheld for coverage: ${r.withheld.length ? r.withheld.map((w) => `${w.key} ${w.week}`).join("; ") : "none"}`);
	lines.push(`6. Weeks crossing a month end: ${r.weeksCrossingMonthEnd.join("; ") || "none"}. Closed months the weeks touch (read only): ${r.closedMonthsTouched.join(", ") || "none"}.`);
	lines.push("", `(a) The Monday email from this run's figures (as of ${r.email.builtFrom}), built as the server builds it and never sent. On the day, the email reads that Monday morning's run.`);
	for (const [what, e] of [["the next Monday", r.email.nextMonday], ["a first Monday", r.email.firstMonday]]) lines.push("", `--- ${what}, ${e.day}. Subject: ${e.subject}`, e.text);
	const why = (x) => (x.mode !== "weekly" ? `${x.mode.replace("_", " ")}, nothing to approve again` : (x.reapprove ? "approve again for its weekly figures (K29)" : "its weekly figures are covered"));
	lines.push("", `(b) Approved now: ${r.approvedNow.length ? r.approvedNow.map((x) => `${x.key} (approved ${x.day}; ${why(x)})`).join("; ") : "none"}.`);
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
