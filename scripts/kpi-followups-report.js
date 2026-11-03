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
// --part=viewer (KPI_VIEWER_ENABLED, KPI_VIEWER_IDS; lane V, before it and at its steps 6 and 9). The
// database only, opened read-only; no settings file is read. It prints ids, counts, metric keys and
// field names only (no username, email or figure), and:
//   1-5. the users table as the rebuild script sees it: the live CREATE, the columns, the row count, the
//        highest id and the sequence, the four child tables' foreign keys, the sessions;
//   6. the rebuild script's dry-run verdict, its structural fingerprint and the foreign-key violations
//      already there (lib/users-role-migration.js);
//   7. the KPI Viewer accounts, each by id: enabled, must change its password, signed in yet;
//   8. the metrics approved now (key and day), the stale approvals, and those given after
//      kpi.weekly_since;
//   9. the shared page's answer on this data (lib/kpi-viewer.js), with weekly figures off and on: its
//      field names at every depth and its size, and that none is outside the allowlist;
//   10. a KPI Viewer's verdict on every registered route and mount (scripts/fixtures/route-snapshot.txt)
//       from this checkout's lifted requireAuth and requireRole;
//   11. the flag and the list, from the app's own [kpi-viewer] start-up line (--startup-log), never
//       from the settings file.
// Exit codes: 0 done, 1 a proof failed (9 or 10) or an error, 2 refused.
//
// Usage:
//   node scripts/kpi-followups-report.js --part=weekly --db=app.db --sheet-id=env [--as-of=YYYY-MM-DD] [--json]
//   node scripts/kpi-followups-report.js --part=viewer --db=app.db [--startup-log=<the app's log>] [--json]
//   --sheet-id=env         the SPREADSHEET_ID the app's .env sets (refused when none)
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      with a copy of the database under the temp directory only
//   --as-of=YYYY-MM-DD     the run's business day (default: today in APP_TIMEZONE)

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { parseArgs, sheetFor, envFor, openDb, dbScope } = require("./lib/ledger-world");
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

// ── --part=viewer ────────────────────────────────────────────────────────────────────────────────────
const VIEWER_ROOTS = ["kpiResponse", "kpiReadSettings", "kpiApprovalSettings", "requireAuth", "requireRole", "APP_TIMEZONE"];
// What the shared page's answer must never carry, at any depth (lib/kpi-viewer.js).
const NEVER_IN_ANSWER = ["job", "settings", "recipients", "approval", "definitionVersion", "breakdown", "coverage", "beforeAfter"];

function liftViewer(db, weekly) {
	const SRC = serverSource({ root: ROOT });
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const lifted = closure(SRC, { roots: VIEWER_ROOTS, provided: PROVIDED, denied: DENIED });
	const liftedRequire = (m) => {
		if (!LIFTED_REQUIRE_OK(m)) throw new Error(`lifted code required ${m}, which this report does not load`);
		return appRequire(m);
	};
	const noFetch = () => { throw new Error("lifted code called fetch(); this report makes no network calls"); };
	const quiet = { log() {}, warn() {}, error() {} };
	// The only setting the lifted code reads is whether weekly figures are on; nothing else is set.
	const env = weekly ? { KPI_WEEKLY_ENABLED: "true" } : {};
	const body = `"use strict";\n${lifted.text}\nreturn { kpiResponse, kpiReadSettings, kpiApprovalSettings, requireAuth, requireRole, APP_TIMEZONE };`;
	return new Function("db", "require", "console", "process", "__dirname", "fetch", body)(
		db, liftedRequire, quiet, { env, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } }, ROOT, noFetch,
	);
}

// Every field name in `value`, as a path ("metrics[].weekly.series[].label").
function fieldPaths(value, prefix = "", out = new Set()) {
	if (Array.isArray(value)) { for (const v of value) fieldPaths(v, `${prefix}[]`, out); return out; }
	if (!value || typeof value !== "object") return out;
	for (const [k, v] of Object.entries(value)) {
		const p = prefix ? `${prefix}.${k}` : k;
		out.add(p);
		fieldPaths(v, p, out);
	}
	return out;
}

// A KPI Viewer's verdict on each registration in the route snapshot, from the lifted guards: the first
// guard the line names decides (a flag gate in front of it is taken as open).
function routeVerdicts(k, lib) {
	const text = fs.readFileSync(path.join(ROOT, "scripts", "fixtures", "route-snapshot.txt"), "utf8");
	const lines = text.slice(text.indexOf("[routes]\n") + 9, text.indexOf("\n[middleware]")).split("\n").filter(Boolean);
	const roleClosure = Function.prototype.toString.call(k.requireRole("Super Admin"));
	const anonFp = (lines.map((l) => (l.match(/requireRole\([^)]*\)=anon@([0-9a-f]{12})/) || [])[1]).find(Boolean)) || null;
	const user = { id: 1, username: "kpi_viewer_probe", role: lib.ROLE, mustChangePassword: false };
	const decide = (guard, method, routePath) => {
		const out = { status: null, body: null, nexted: false };
		const req = { method, url: routePath || "/uploads/x", originalUrl: routePath || "/uploads/x", headers: { "x-requested-with": "XMLHttpRequest" }, session: { user } };
		if (routePath) req.route = { path: routePath };
		const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
		guard(req, res, () => { out.nexted = true; });
		return out.nexted ? "allowed" : `${out.status} ${(out.body && (out.body.code || out.body.error)) || ""}`.trim();
	};
	const rows = [];
	for (const line of lines) {
		const [head, ...chain] = line.split(" · ");
		const sp = head.indexOf(" ");
		const method = head.slice(0, sp);
		const where = head.slice(sp + 1);
		const auth = chain.findIndex((h) => /^requireAuth@/.test(h));
		const role = chain.findIndex((h) => /^requireRole\(/.test(h) || (anonFp && h.startsWith(`anon@${anonFp}`)));
		const first = [auth, role].filter((i) => i >= 0).sort((a, b) => a - b)[0];
		const kind = method === "USE" ? "mount" : "route";
		const path0 = where.startsWith("[") ? JSON.parse(where)[0] : where;
		let verdict = "no guard";
		if (first !== undefined && first === auth) verdict = decide(k.requireAuth, method === "USE" ? "GET" : method === "ALL" ? "GET" : method, kind === "route" ? path0 : null);
		else if (first !== undefined) {
			const listed = (chain[first].match(/^requireRole\(([^)]*)\)/) || [])[1];
			const roles = listed ? listed.split(",").map((s) => JSON.parse(s.trim())) : ["(a lib mount's list)"];
			if (Function.prototype.toString.call(k.requireRole(...roles)) !== roleClosure) throw new Error("requireRole's closure isn't the one the snapshot fingerprints");
			verdict = decide(k.requireRole(...roles), method === "USE" || method === "ALL" ? "GET" : method, kind === "route" ? path0 : null);
		}
		rows.push({ kind, id: `${method} ${where}`, verdict });
	}
	return rows;
}

async function viewerPart(args) {
	let file;
	try {
		({ file } = dbScope(args.db, ROOT));
	} catch (err) {
		refuse(err.message);
	}
	const db = openDb({ root: ROOT, dbFile: file, readonly: true });
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const migration = appRequire("./lib/users-role-migration");
	const lib = appRequire("./lib/kpi-viewer");
	const kpiCatalog = appRequire("./lib/kpi-catalog");
	try {
		const dry = migration.dryRunReport(db);
		const s = dry.structure;
		const accounts = s.admits
			? db.prepare("SELECT * FROM users WHERE role = ? ORDER BY id").all(lib.ROLE).map((r) => ({
				id: r.id, enabled: String(r.disabled_at ?? "") === "", mustChangePassword: !!r.must_change_password, signedIn: !!r.last_login_at,
			}))
			: [];
		const off = liftViewer(db, false);
		const on = liftViewer(db, true);
		const settings = off.kpiApprovalSettings(off.kpiReadSettings());
		let since = null;
		try { since = (db.prepare("SELECT value FROM server_state WHERE key = 'kpi.weekly_since'").get() || {}).value || null; } catch { since = null; }
		const approvalRows = db.prepare("SELECT metric_key, approved, definition_version, settings_hash, approved_at FROM kpi_metric_approvals ORDER BY metric_key").all();
		const valid = approvalRows.filter((r) => kpiCatalog.approvalIsValid(r, r.metric_key, settings));
		const stale = approvalRows.filter((r) => r.approved === 1 && !valid.includes(r)).map((r) => r.metric_key);
		const day = (v) => (typeof v === "string" ? v.slice(0, 10) : null);
		const after = since ? valid.filter((r) => Date.parse(r.approved_at) > Date.parse(since)).map((r) => r.metric_key) : [];
		const now = Date.now();
		const answers = {
			weeklyOff: lib.viewerAnswer(off.kpiResponse(now), { weeklySince: null }),
			weeklyOn: lib.viewerAnswer(on.kpiResponse(now), { weeklySince: since }),
		};
		const answer = Object.fromEntries(Object.entries(answers).map(([k, a]) => {
			const fields = [...fieldPaths(a)].sort();
			const outside = fields.filter((f) => NEVER_IN_ANSWER.includes(f.split(".").pop().replace(/\[\]$/, "")));
			return [k, { metrics: a.metrics.map((m) => m.key), fields, outside, bytes: Buffer.byteLength(JSON.stringify(a)) }];
		}));
		const verdicts = routeVerdicts(off, lib);
		const allowed = verdicts.filter((v) => v.verdict === "allowed").map((v) => v.id);
		const refused = (re) => verdicts.filter((v) => re.test(v.verdict));
		let startup = null;
		if (typeof args["startup-log"] === "string") {
			const lines = fs.readFileSync(args["startup-log"], "utf8").split("\n").filter((l) => /\[kpi-viewer\] (on|off)\b/.test(l));
			startup = lines.length ? lines[lines.length - 1].replace(/^.*?(\[kpi-viewer\])/, "$1") : "(no [kpi-viewer] start-up line in that log)";
		}
		return {
			part: "viewer",
			users: {
				ddl: s.ddl,
				columns: s.columns.map((c) => `${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ""}${c.pk ? " PRIMARY KEY" : ""}`),
				rows: dry.counts.rows, highestId: dry.counts.highestId, sequence: dry.counts.sequence, sessions: dry.counts.sessions,
				children: s.children.map((c) => `${c.table}: ${c.keys.map((k) => `${k.from} -> ${k.table}(${k.to})${k.on_delete && k.on_delete !== "NO ACTION" ? ` ON DELETE ${k.on_delete}` : ""}`).join(", ")}`),
			},
			rebuild: {
				verdict: dry.nothingToDo ? "nothing to do: the CHECK admits KPI Viewer" : dry.problems.length ? `refused: ${dry.problems.join("; ")}` : "would rebuild",
				fingerprint: dry.fingerprint, baseline: dry.baseline, violations: dry.counts.violations,
			},
			kpiViewers: accounts,
			approvals: { valid: valid.map((r) => ({ key: r.metric_key, day: day(r.approved_at) })), stale, weeklySince: since, afterWeeklySince: after },
			answer,
			routes: {
				allowed,
				ownWithoutGuard: verdicts.filter((v) => v.verdict === "no guard" && /^(GET \/api\/auth\/session|POST \/api\/auth\/(login|logout))$/.test(v.id)).map((v) => v.id),
				forbidden: refused(/^403 Forbidden$/).length,
				roleNotAllowed: refused(/^403 ROLE_NOT_ALLOWED$/).length,
				mountsRefused: verdicts.filter((v) => v.kind === "mount" && /^403 /.test(v.verdict)).map((v) => v.id),
				noGuard: verdicts.filter((v) => v.verdict === "no guard").length,
				other: verdicts.filter((v) => !/^(allowed|no guard|403 Forbidden|403 ROLE_NOT_ALLOWED)$/.test(v.verdict)).map((v) => `${v.id}: ${v.verdict}`),
			},
			startup,
			proofs: {
				answerWithinAllowlist: Object.values(answer).every((a) => a.outside.length === 0),
				onlyItsOwnRoutes: allowed.length === 2 && allowed.includes("POST /api/auth/change-password") && allowed.includes("GET /api/kpis/viewer"),
			},
		};
	} finally {
		db.close();
	}
}

function printViewer(r) {
	const u = r.users;
	const lines = [
		"KPI follow-ups report, part viewer (read-only; the database only).",
		"1. The users table:", `  ${u.ddl}`,
		"2. Columns:", ...u.columns.map((c) => `  ${c}`),
		`3. Rows ${u.rows}; highest id ${u.highestId}; sqlite_sequence ${u.sequence}.`,
		"4. Child tables' foreign keys:", ...u.children.map((c) => `  ${c}`),
		`5. Sessions: ${u.sessions}.`,
		`6. The rebuild's dry run: ${r.rebuild.verdict}. Structural fingerprint ${r.rebuild.fingerprint}; baseline ${r.rebuild.baseline}; violations already there: ${r.rebuild.violations.map((v) => `${v.table} ${v.count}`).join(", ") || "none"}.`,
		`7. KPI Viewer accounts: ${r.kpiViewers.length}${r.kpiViewers.map((a) => `\n  #${a.id}: ${a.enabled ? "enabled" : "disabled"}; ${a.mustChangePassword ? "must change its password" : "password changed"}; ${a.signedIn ? "has signed in" : "never signed in"}`).join("")}`,
		`8. Approved now: ${r.approvals.valid.map((a) => `${a.key} (${a.day})`).join(", ") || "none"}. Stale: ${r.approvals.stale.join(", ") || "none"}. Weekly figures since ${r.approvals.weeklySince || "(never)"}; approved after that: ${r.approvals.afterWeeklySince.join(", ") || "none"}.`,
		"9. The shared page's answer on this data:",
		...Object.entries(r.answer).map(([k, a]) => `  ${k}: ${a.metrics.length} metric(s) [${a.metrics.join(", ")}], ${a.bytes} bytes; fields: ${a.fields.join(", ")}; outside the allowlist: ${a.outside.join(", ") || "none"}`),
		`10. A KPI Viewer's verdict on every route and mount: allowed by its guard: ${r.routes.allowed.join(", ")}; its own with no guard: ${r.routes.ownWithoutGuard.join(", ")}; 403 Forbidden ${r.routes.forbidden}; 403 ROLE_NOT_ALLOWED ${r.routes.roleNotAllowed}; mounts refused: ${r.routes.mountsRefused.join(", ")}; no guard (as signed out) ${r.routes.noGuard}; other: ${r.routes.other.join("; ") || "none"}.`,
		`11. The flag and the list: ${r.startup || "not read; pass --startup-log=<the app's own log file> (this report never reads the settings file)"}`,
		"", `Proofs: answer within the allowlist ${r.proofs.answerWithinAllowlist ? "yes" : "NO"}; only its own routes allowed ${r.proofs.onlyItsOwnRoutes ? "yes" : "NO"}.`,
	];
	console.log(lines.join("\n"));
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
	if (args.part !== "weekly" && args.part !== "viewer") refuse("--part=weekly or --part=viewer");
	if (!args.db || args.db === true) refuse("--db is required");
	if (args.part === "viewer") {
		const result = await viewerPart(args);
		if (args.json === true) console.log(JSON.stringify(result, null, 1));
		else printViewer(result);
		if (!result.proofs.answerWithinAllowlist || !result.proofs.onlyItsOwnRoutes) process.exitCode = 1;
		return;
	}
	const result = await weeklyPart(args);
	if (args.json === true) console.log(JSON.stringify(result, null, 1));
	else printText(result);
	if (!result.monthlyUnchanged || !result.approvalsUnchanged) process.exitCode = 1;
}

if (require.main === module) main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });

module.exports = { ROOTS, DENIED, VIEWER_ROOTS, NEVER_IN_ANSWER };
