#!/usr/bin/env node
/**
 * The KPI admin routes: Super Admin only, writes same-origin and CSRF-checked,
 * every input validated at the boundary, every write audited, the recompute
 * single-flight and rate-limited, and a metric never shown approved without a
 * valid approval row.
 *
 * WHAT IS REAL. The whole KPI block is lifted out of server.js (from its
 * "KPI BOT" banner to the SPA catch-all banner) and executed against a fresh
 * in-memory SQLite: its own CREATE TABLE statements make the kpi_* tables, and
 * the tables it reads are made from server.js's own DDL. It registers its routes
 * on a real Express app listening on port 0, behind the real requireRole
 * (lifted), the real refuseCrossOrigin (the guard block, lifted) and the real
 * express-rate-limit. The session is a header the test sets. What the block
 * calls outside itself is a fake: the sheet, the books, Drive, email, and
 * Backend A's lib/kpi-catalog.js and lib/kpi-metrics.js (contract-shaped fakes,
 * so this runner does not depend on them). The fake response builder marks
 * EVERY metric approved, as a regression upstream would; the server's own
 * approval check is what §3 and §4 see through.
 *
 * §1 registrations: the four routes, each exactly once, each opening with
 *    requireRole("Super Admin"); writes add refuseCrossOrigin; the recompute's
 *    limiter comes after both; all of them above the SPA catch-all.
 * §2 the gates, over HTTP: no session 401; Driver, Investor, Dispatcher 403;
 *    a write without X-Requested-With 403 CSRF_HEADER_REQUIRED; a cross-site
 *    write 403 CROSS_SITE_REFUSED.
 * §3 GET /api/admin/kpis reads stored rows only (nothing computed, no sheet
 *    read) and shows no metric approved without a valid row.
 * §4 PUT /api/admin/kpis/approvals/:key: 404 UNKNOWN_METRIC, 400
 *    INVALID_APPROVAL (the string "true" included), 409 DEFINITION_CHANGED; the
 *    write, its audit row and its event; an approval lapses when the settings
 *    it used change.
 * §5 PUT /api/admin/kpis/settings: partial updates, normalised and audited;
 *    400 INVALID_KPI_SETTINGS with `field` for an unknown or __proto__ key, an
 *    MPG of 0 / 99 / NaN / "8", a malformed date, a bad recipient list; nothing
 *    written on a refusal.
 * §6 POST /api/admin/kpis/recompute: 202 { runId, status }, audited; 409 while
 *    any run is in progress; no Drive call; 429 once the budget is spent, and a
 *    refused request spends none of it.
 * §7 every server.js name the block uses is defined above it.
 * §8 MUTANTS: Dispatcher admitted; refuseCrossOrigin removed; requireAuth for
 *    requireRole; the string "true" accepted; a __proto__ key accepted; MPG 0 /
 *    NaN / 99 accepted; a malformed date accepted; the audit row dropped; the
 *    recompute not single-flight; the block moved below app.get("*"); a metric
 *    with no approval row shown approved.
 *
 * Hermetic: :memory: SQLite, 127.0.0.1 port 0, no network beyond it, nothing
 * written to disk.
 *
 * Run: node scripts/test-kpi-routes.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }

let Database, express, rateLimit, ipKeyGenerator;
try {
	Database = require("better-sqlite3");
	express = require("express");
	rateLimit = require("express-rate-limit");
	({ ipKeyGenerator } = require("express-rate-limit"));
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

// ── lift the shipped code ───────────────────────────────────────────────────
const BANNER = "// ============================================================\n";
const START_MARK = `${BANNER}// KPI BOT —`;
const END_MARK = `${BANNER}// SPA Catch-All`;
function blockOf(src) {
	const a = src.indexOf(START_MARK);
	const b = src.indexOf(END_MARK);
	if (a < 0 || b < 0 || src.split(START_MARK).length !== 2) die("could not locate the KPI block (its banner, once, and the SPA catch-all banner)");
	return a < b ? src.slice(a, b) : src.slice(a, src.indexOf("\n// ====", a + START_MARK.length));
}
const BLOCK = blockOf(SRC);
function liftFunction(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	return SRC.slice(a, end + 2);
}
function liftConst(head) {
	const needle = `\n${head}`;
	if (SRC.split(needle).length !== 2) die(`expected exactly 1 statement starting ${JSON.stringify(head)}`);
	const a = SRC.indexOf(needle) + 1;
	return SRC.slice(a, SRC.indexOf(";\n", a) + 1);
}
const HELPERS = [
	liftConst("const RFC2822_MONTHS = "), liftFunction("appDay"), liftFunction("findCol"), liftFunction("sheetDayKey"),
	liftConst("const CANCELED_STATUS_RE = "), liftFunction("getDeletedLoadIds"), liftFunction("loadKeySet"),
	liftFunction("excludeDroppedLoads"), liftFunction("liveJobTrackingView"),
	liftFunction("scrubPurgeMarker"), liftFunction("auditText"), liftFunction("logAudit"),
	liftConst("const RATECON_DOC_TYPES = "),
].join("\n");
// The guards log refusals (coalesced); kept out of this runner's output.
const QUIET = { log() {}, warn() {}, error() {} };
const requireRole = new Function("console", `${liftFunction("requireRole")}\nreturn requireRole;`)(QUIET);
const requireAuth = new Function("console", `${liftFunction("requireAuth")}\nreturn requireAuth;`)(QUIET);
const refuseCrossOrigin = (() => {
	const i0 = SRC.indexOf("function originIsSelf(req, origin) {");
	const j0 = SRC.indexOf("const refuseCrossOriginStrict = crossSiteGuard(", i0);
	if (i0 < 0 || j0 < 0) die("could not locate the cross-site guard block");
	return new Function("DRIVER_MOBILE_ORIGINS", "logAuditRefusal", `${SRC.slice(i0, SRC.indexOf(";", j0) + 1)}\nreturn refuseCrossOrigin;`)([], () => {});
})();

function tableDdl(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${name}`);
	return `CREATE TABLE ${name} (${m[1]}\n)`;
}
function alterDdl(table, col) {
	const m = SRC.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN ${col} [^"\`]*`));
	if (!m) die(`could not locate the ${table}.${col} migration`);
	return m[0];
}
const DEP_DDL = [
	tableDdl("trucks"), alterDdl("trucks", "in_service_date"), alterDdl("trucks", "retired_at"), alterDdl("trucks", "routemate_vehicle_id"),
	tableDdl("eld_miles_daily"), tableDdl("eld_device_assignments"),
	tableDdl("expenses"), alterDdl("expenses", "gallons"), alterDdl("expenses", "receipt_details"),
	tableDdl("audit_trail"), tableDdl("load_status_history"), tableDdl("invoice_autogen_runs"),
	tableDdl("load_eld_miles"), tableDdl("load_coordinates"), tableDdl("documents"), alterDdl("documents", "deleted_at"),
	tableDdl("app_settings"), tableDdl("server_state"), tableDdl("deleted_loads"),
];

// ── contract-shaped fakes of Backend A's modules ───────────────────────────
const METRIC_KEYS = [
	"freight_tons_stated", "freight_tons_estimated", "loads_delivered", "revenue", "miles_driven", "on_time_rate",
	"fleet_trucks", "active_units", "fuel_mpg", "fuel_savings", "co2_tonnes", "ai_tasks", "automated_tasks",
	"dispatch_calls", "truck_utilization", "paid_mile_share",
];
const SETTINGS_USED = { fuel_savings: ["baselineMpg"], truck_utilization: ["aiDispatchStart", "dedicatedStart"], paid_mile_share: ["dedicatedStart"] };
function fakeLibs(log) {
	const METRICS = METRIC_KEYS.map((key) => ({
		key, label: key, unit: "count", kind: key === "fuel_savings" ? "estimate" : "real", group: "ops",
		definition: "A sentence.", definitionVersion: 1, assumptions: [], source: null, settingsUsed: SETTINGS_USED[key] || [],
	}));
	const metricByKey = (k) => METRICS.find((m) => m.key === k) || null;
	const settingsHashFor = (k, s) => { const m = metricByKey(k); return m && m.settingsUsed.length ? JSON.stringify(m.settingsUsed.map((u) => s[u] ?? null)) : ""; };
	const catalog = {
		METRICS, METRIC_KEYS, metricByKey, settingsHashFor, KPI_SERIES_START: "2025-04",
		approvalIsValid: (row, k, s) => !!row && row.approved === 1 && row.definition_version === metricByKey(k).definitionVersion && row.settings_hash === settingsHashFor(k, s),
	};
	const metrics = {
		computeKpis(inputs) {
			log.computes++;
			return {
				metrics: METRIC_KEYS.map((key) => ({
					key, status: "ok", missingReason: null, value: 1, display: "1",
					current: { from: "2026-09-01", to: "2026-09-30", value: 1, display: "1", label: "September 2026" },
					totals: [], series: [{ period: "2026-09", value: 1, display: "1", coverage: 1 }], comparisons: [], beforeAfter: [],
					coverage: { num: 1, den: 1, ratio: 1, what: "loads", from: null, to: null }, confidence: "high", warnings: [], assumptions: [], breakdown: null,
				})),
				derived: { aiDispatchStart: { value: "2026-04-09", evidence: "First delivered load through the AI email path." } },
				inputsSeen: Boolean(inputs),
			};
		},
		buildKpiResponse(args) {
			log.builds++;
			log.lastBuild = args;
			return {
				asOfDay: args.asOfDay, timeZone: args.timeZone, generatedAt: new Date().toISOString(), job: args.job,
				settings: {
					aiDispatchStart: { value: args.settings.aiDispatchStart || args.derived.aiDispatchStart.value, source: args.settings.aiDispatchStart ? "admin" : "derived", evidence: args.derived.aiDispatchStart.evidence },
					dedicatedStart: { value: args.settings.dedicatedStart, source: args.settings.dedicatedStart ? "admin" : null },
					baselineMpg: args.settings.baselineMpg, recipients: args.settings.recipients, defaultRecipientConfigured: args.defaultRecipientConfigured,
				},
				metrics: METRICS.map((m) => ({ key: m.key, label: m.label, kind: m.kind, status: "ok", display: "1", approval: { approved: true, by: null, at: null, stale: false } })),
			};
		},
	};
	const weight = {
		MAX_PDF_BYTES: 3 * 1024 * 1024,
		parseWeight: (text) => (/\d{1,3},\d{3}\s{0,2}lbs/i.test(String(text || "")) ? { status: "ok", weightLb: 42000, evidence: "" } : { status: "none", weightLb: null, evidence: "" }),
		classifyPdfText: (text, n) => (n > 3 * 1024 * 1024 ? "too_large" : (String(text || "").trim() ? "ok" : "no_text")),
	};
	return { catalog, metrics, weight };
}

const USERS = {
	"Super Admin": { id: 1, username: "super_admin", role: "Super Admin" },
	Dispatcher: { id: 2, username: "dispatch1", role: "Dispatcher" },
	Driver: { id: 3, username: "LogisX-1001", role: "Driver" },
	Investor: { id: 4, username: "investor1", role: "Investor" },
};
const JT = {
	headers: ["Contract ID", "Load ID", "Status", "Driver", "Truck", "Details", "Pickup Appointment", "Drop-off Appointment", "Completion Date"],
	data: [
		{ _rowIndex: 2, "Contract ID": "", "Load ID": "L-100", Status: "Delivered", Driver: "Driver A", Truck: "101", Details: "", "Pickup Appointment": "", "Drop-off Appointment": "", "Completion Date": "2026-09-10" },
	],
};

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

// A fresh world: in-memory DB, the block executed on a real Express app.
async function startWorld(block = BLOCK) {
	const log = { computes: 0, builds: 0, sheetReads: 0, driveCalls: 0, events: [], logs: [] };
	const libs = fakeLibs(log);
	const db = new Database(":memory:");
	for (const sql of DEP_DDL) db.exec(sql);
	const app = express();
	app.use(express.json());
	app.use((req, res, next) => {
		const u = req.get("x-test-user");
		req.session = u ? { user: JSON.parse(u) } : {};
		next();
	});
	const gate = { current: null };
	const deps = {
		require: (p) => {
			const map = {
				"./lib/kpi-catalog": libs.catalog, "./lib/kpi-metrics": libs.metrics, "./lib/kpi-weight": libs.weight,
				"./lib/kpi-schedule": require(path.join(ROOT, "lib", "kpi-schedule.js")), "./lib/kpi-digest": require(path.join(ROOT, "lib", "kpi-digest.js")),
			};
			if (!(p in map)) throw new Error(`the KPI block required an unexpected module: ${p}`);
			return map[p];
		},
		process: { env: {} },
		console: { log: (...a) => log.logs.push(a.join(" ")), warn: (...a) => log.logs.push(a.join(" ")), error: (...a) => log.logs.push(a.join(" ")) },
		db, app,
		appTime: require(path.join(ROOT, "lib", "app-time.js")),
		APP_TIMEZONE: "America/New_York",
		publicFormInput: require(path.join(ROOT, "lib", "public-form-input.js")),
		normalizeLoadId: require(path.join(ROOT, "lib", "ratecon-load.js")).normalizeLoadId,
		getJobTrackingCached: async () => { log.sheetReads++; if (gate.current) await gate.current.promise; return JT; },
		buildFinancialsLedger: async () => ({ items: [] }),
		fetchDocumentBytes: async () => null,
		getDrive: async () => { log.driveCalls++; throw new Error("no Drive in this runner"); },
		RATECON_DRIVE_FOLDER_ID: "folder-under-test",
		rcIndexShared: require(path.join(ROOT, "lib", "ratecon-drive-index.js")),
		brokerInvoice: require(path.join(ROOT, "lib", "broker-invoice.js")),
		notifyChange: (d) => log.events.push(d),
		sendEmail: async () => false,
		ADMIN_NOTIFY_EMAIL: "admin@example.test",
		startsJob: () => false,
		requireRole, requireAuth, refuseCrossOrigin, rateLimit, ipKeyGenerator,
		setTimeout, setInterval, clearTimeout, setImmediate, Date,
	};
	const names = Object.keys(deps);
	const body = `"use strict";\n${HELPERS}\n${block}\nreturn { kpiSettingsPatch, state: () => ({ kpiRunning, kpiCurrentRunId }) };`;
	const internals = new Function(...names, body)(...names.map((n) => deps[n]));
	const server = http.createServer(app);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const call = (method, url, { user = USERS["Super Admin"], body: payload, xrw = true, headers = {} } = {}) => new Promise((resolve, reject) => {
		const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
		const h = { ...headers };
		if (user) h["x-test-user"] = JSON.stringify(user);
		if (xrw) h["x-requested-with"] = "XMLHttpRequest";
		if (data) { h["content-type"] = "application/json"; h["content-length"] = data.length; }
		const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: h }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let json = null;
				try { json = JSON.parse(text); } catch { json = null; }
				resolve({ status: res.statusCode, body: json });
			});
		});
		req.on("error", reject);
		if (data) req.write(data);
		req.end();
	});
	const waitIdle = async () => { for (let i = 0; i < 500 && internals.state().kpiRunning; i++) await new Promise((r) => setTimeout(r, 2)); };
	return { db, log, internals, call, gate, waitIdle, close: () => new Promise((r) => server.close(r)) };
}

const auditsOf = (w, action) => w.db.prepare("SELECT action, entity, entity_id, details, username FROM audit_trail WHERE action = ? ORDER BY id").all(action);

// ─────────────────────────────────────────── §1 registrations (source)
const HEADS = {
	get: 'app.get("/api/admin/kpis", requireRole("Super Admin"), (req, res) => {',
	approve: 'app.put("/api/admin/kpis/approvals/:key", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {',
	settings: 'app.put("/api/admin/kpis/settings", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {',
	recompute: 'app.post("/api/admin/kpis/recompute", requireRole("Super Admin"), refuseCrossOrigin, kpiRecomputeLimiter, (req, res) => {',
};
function orderSection(src) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const catchAll = src.indexOf('\napp.get("*"');
	t(catchAll > 0, "§1 the SPA catch-all is found");
	const block = src.indexOf(START_MARK);
	t(block > 0 && block < catchAll, "§1 the KPI block sits above app.get(\"*\")");
	const regs = [...src.matchAll(/^app\.(get|post|put|patch|delete)\("\/api\/admin\/kpis[^"]*"/gm)];
	t(regs.length === 4, `§1 four /api/admin/kpis registrations (${regs.length})`);
	t(regs.every((m) => m.index < catchAll), "§1 ...every one above the catch-all");
	for (const [k, head] of Object.entries(HEADS)) t(src.split(`\n${head}`).length === 2, `§1 ${k}: registered exactly once as ${head.slice(0, 70)}…`);
	return r;
}

// ─────────────────────────────────────────── §2 the gates (HTTP)
const ROUTES = [
	["GET", "/api/admin/kpis", undefined],
	["PUT", "/api/admin/kpis/approvals/loads_delivered", { approved: true, definitionVersion: 1 }],
	["PUT", "/api/admin/kpis/settings", { baselineMpg: 8 }],
	["POST", "/api/admin/kpis/recompute", {}],
];
async function gateSection(block) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const w = await startWorld(block);
	try {
		for (const [method, url, body] of ROUTES) {
			const label = `${method} ${url}`;
			const anon = await w.call(method, url, { user: null, body });
			t(anon.status === 401, `§2 ${label}: no session 401 (got ${anon.status})`);
			for (const role of ["Driver", "Investor", "Dispatcher"]) {
				const x = await w.call(method, url, { user: USERS[role], body });
				t(x.status === 403, `§2 ${label}: ${role} 403 (got ${x.status})`);
			}
			if (method !== "GET") {
				const csrf = await w.call(method, url, { body, xrw: false });
				t(csrf.status === 403 && csrf.body && csrf.body.code === "CSRF_HEADER_REQUIRED", `§2 ${label}: no X-Requested-With 403 CSRF_HEADER_REQUIRED (got ${csrf.status})`);
				const cross = await w.call(method, url, { body, headers: { "sec-fetch-site": "cross-site", origin: "https://elsewhere.example" } });
				t(cross.status === 403 && cross.body && cross.body.code === "CROSS_SITE_REFUSED", `§2 ${label}: cross-site 403 CROSS_SITE_REFUSED (got ${cross.status})`);
			}
			const sa = await w.call(method, url, { body, headers: { "sec-fetch-site": "same-origin" } });
			t(sa.status >= 200 && sa.status < 300, `§2 ${label}: Super Admin, same origin, gets through (got ${sa.status})`);
			await w.waitIdle();
		}
		t(auditsOf(w, "kpi_approval_set").length === 1 && auditsOf(w, "kpi_settings_update").length === 1, "§2 the refused writes wrote nothing (one audit row each, from the Super Admin's)");
	} catch (e) {
		t(false, `section threw: ${e && e.message}`);
	} finally { await w.close(); }
	return r;
}

// ─────────────────────────────────────────── §3 GET
async function getSection(block) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const w = await startWorld(block);
	try {
		const g = await w.call("GET", "/api/admin/kpis");
		t(g.status === 200 && Array.isArray(g.body.metrics) && g.body.metrics.length === 16, `§3 200 with the 16 metrics (got ${g.status})`);
		t(g.body.metrics.every((m) => m.approval && m.approval.approved === false), "§3 no approval row: every metric not approved, whatever the builder said");
		t(w.log.computes === 0 && w.log.sheetReads === 0, "§3 GET computed nothing and read no sheet");
		t(g.body.job && g.body.job.lastRun === null && g.body.job.preview.status === "pending", "§3 the job block: no run yet, preview pending");
		t(g.body.job.snapshotSchedule === "Daily at 4:00 AM Eastern (3:00 AM Central)" && g.body.job.enabled.snapshot === false, "§3 the schedule in words; not enabled where the job did not start");
		t(g.body.settings.defaultRecipientConfigured === true && g.body.settings.baselineMpg === null, "§3 settings: defaults, the default recipient configured");
		const b = w.log.lastBuild;
		t(b && Object.keys(b.settings).sort().join() === "aiDispatchStart,baselineMpg,dedicatedStart,recipients" && b.defaultRecipientConfigured === true && /Z$/.test(b.generatedAt) && b.timeZone === "America/New_York",
			"§3 the builder gets the saved settings object as approvals hash it, defaultRecipientConfigured and generatedAt");
	} catch (e) {
		t(false, `section threw: ${e && e.message}`);
	} finally { await w.close(); }
	return r;
}

// ─────────────────────────────────────────── §4 approvals
async function approvalSection(block) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const w = await startWorld(block);
	const put = (key, body) => w.call("PUT", `/api/admin/kpis/approvals/${key}`, { body });
	try {
		const unknown = await put("tons_of_fun", { approved: true, definitionVersion: 1 });
		t(unknown.status === 404 && unknown.body.code === "UNKNOWN_METRIC" && typeof unknown.body.error === "string", "§4 unknown metric: 404 UNKNOWN_METRIC");
		t((await put("__proto__", { approved: true, definitionVersion: 1 })).status === 404, "§4 __proto__ as a key: 404");
		for (const [label, body] of [["approved \"true\" (a string)", { approved: "true", definitionVersion: 1 }], ["approved \"false\" (a string)", { approved: "false", definitionVersion: 1 }],
			["approved 1", { approved: 1, definitionVersion: 1 }], ["no definitionVersion", { approved: true }], ["definitionVersion \"1\"", { approved: true, definitionVersion: "1" }],
			["an array", [true]]]) {
			const x = await put("loads_delivered", body);
			t(x.status === 400 && x.body.code === "INVALID_APPROVAL", `§4 ${label}: 400 INVALID_APPROVAL (got ${x.status})`);
		}
		const stale = await put("loads_delivered", { approved: true, definitionVersion: 2 });
		t(stale.status === 409 && stale.body.code === "DEFINITION_CHANGED", "§4 another definitionVersion: 409 DEFINITION_CHANGED");
		t(w.db.prepare("SELECT COUNT(*) AS n FROM kpi_metric_approvals").get().n === 0 && auditsOf(w, "kpi_approval_set").length === 0, "§4 ...and every refusal wrote nothing");
		const ok = await put("loads_delivered", { approved: true, definitionVersion: 1 });
		t(ok.status === 200 && ok.body.key === "loads_delivered" && ok.body.approval.approved === true && ok.body.approval.by === "super_admin", "§4 approve: 200 { key, approval }");
		const a = auditsOf(w, "kpi_approval_set");
		t(a.length === 1 && a[0].entity === "kpi" && a[0].entity_id === "loads_delivered" && a[0].details.startsWith("loads_delivered: not approved → approved"), `§4 ...audited as kpi_approval_set (${a[0] && a[0].details})`);
		t(w.log.events.includes("kpis"), "§4 ...and kpis:changed is emitted");
		let g = await w.call("GET", "/api/admin/kpis");
		t(g.body.metrics.filter((m) => m.approval.approved).map((m) => m.key).join() === "loads_delivered", "§4 GET: that metric alone is approved");
		await w.call("PUT", "/api/admin/kpis/settings", { body: { baselineMpg: 8 } });
		await put("fuel_savings", { approved: true, definitionVersion: 1 });
		g = await w.call("GET", "/api/admin/kpis");
		t(g.body.metrics.find((m) => m.key === "fuel_savings").approval.approved === true, "§4 fuel_savings approved under baseline 8");
		await w.call("PUT", "/api/admin/kpis/settings", { body: { baselineMpg: 9 } });
		g = await w.call("GET", "/api/admin/kpis");
		t(g.body.metrics.find((m) => m.key === "fuel_savings").approval.approved === false, "§4 ...lapses when the baseline it used changes");
		t(g.body.metrics.find((m) => m.key === "loads_delivered").approval.approved === true, "§4 ...and a metric that reads no setting keeps its approval");
		const derive = (day) => w.db.prepare("INSERT OR REPLACE INTO server_state (key, value) VALUES ('kpi.derived', ?)").run(JSON.stringify({ aiDispatchStart: { value: day, evidence: "x" } }));
		derive("2026-04-10");
		await put("truck_utilization", { approved: true, definitionVersion: 1 });
		g = await w.call("GET", "/api/admin/kpis");
		t(g.body.metrics.find((m) => m.key === "truck_utilization").approval.approved === true, "§4 truck_utilization approved under the derived AI start");
		derive("2026-04-20");
		g = await w.call("GET", "/api/admin/kpis");
		t(g.body.metrics.find((m) => m.key === "truck_utilization").approval.approved === false, "§4 ...lapses when the derived AI start it used moves");
		const off = await put("loads_delivered", { approved: false, definitionVersion: 1 });
		t(off.status === 200 && auditsOf(w, "kpi_approval_set").slice(-1)[0].details.startsWith("loads_delivered: approved → not approved"), "§4 withdraw: audited approved → not approved");
	} catch (e) {
		t(false, `section threw: ${e && e.message}`);
	} finally { await w.close(); }
	return r;
}

// ─────────────────────────────────────────── §5 settings
async function settingsSection(block) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const w = await startWorld(block);
	const put = (body) => w.call("PUT", "/api/admin/kpis/settings", { body });
	const stored = () => w.db.prepare("SELECT value FROM app_settings WHERE key = 'kpi.settings'").get();
	try {
		const bad = [
			["an unknown key", { colour: "red" }, "colour"],
			["a __proto__ key", JSON.parse('{"__proto__": {"baselineMpg": 8}, "baselineMpg": 8}'), "__proto__"],
			["a constructor key", { constructor: 1 }, "constructor"],
			["MPG 0", { baselineMpg: 0 }, "baselineMpg"],
			["MPG 99", { baselineMpg: 99 }, "baselineMpg"],
			["MPG \"8\" (a string)", { baselineMpg: "8" }, "baselineMpg"],
			["2026-02-31", { dedicatedStart: "2026-02-31" }, "dedicatedStart"],
			["2026-1-05", { dedicatedStart: "2026-1-05" }, "dedicatedStart"],
			["an ISO timestamp", { aiDispatchStart: "2026-01-05T00:00:00Z" }, "aiDispatchStart"],
			["a number for a date", { aiDispatchStart: 20260105 }, "aiDispatchStart"],
			["a date in 1999", { aiDispatchStart: "1999-01-05" }, "aiDispatchStart"],
			["recipients not a list", { recipients: "a@example.test" }, "recipients"],
			["a recipient that is not an address", { recipients: ["a@example.test", "not an address"] }, "recipients"],
			["two addresses in one entry", { recipients: ["a@example.test, b@example.test"] }, "recipients"],
			["eleven recipients", { recipients: Array.from({ length: 11 }, (_, i) => `r${i}@example.test`) }, "recipients"],
			["an array body", [1], null],
		];
		for (const [label, body, field] of bad) {
			const x = await put(body);
			t(x.status === 400 && x.body.code === "INVALID_KPI_SETTINGS" && x.body.field === field && typeof x.body.error === "string",
				`§5 ${label}: 400 INVALID_KPI_SETTINGS field ${field} (got ${x.status} ${x.body && x.body.field})`);
		}
		t(!stored() && auditsOf(w, "kpi_settings_update").length === 0, "§5 ...and no refusal wrote a setting or an audit row");
		const nan = w.internals.kpiSettingsPatch({ baselineMpg: NaN });
		const inf = w.internals.kpiSettingsPatch({ baselineMpg: Infinity });
		t(nan.error && nan.field === "baselineMpg" && inf.error, "§5 MPG NaN or Infinity (no JSON for them, so checked on the validator): refused");
		const ok = await put({ baselineMpg: 8, dedicatedStart: "2026-08-30", recipients: [" Ops@Example.test ", "ops@example.test", "owner@example.test"] });
		t(ok.status === 200 && ok.body.changed.join() === "dedicatedStart,baselineMpg,recipients", `§5 a partial update: 200, changed lists what changed (${ok.body && ok.body.changed})`);
		const saved = JSON.parse(stored().value);
		t(saved.baselineMpg === 8 && saved.dedicatedStart === "2026-08-30" && saved.aiDispatchStart === null && saved.recipients.join() === "ops@example.test,owner@example.test",
			"§5 stored normalised: recipients trimmed, lower-cased, de-duplicated");
		t(ok.body.settings && ok.body.settings.baselineMpg === 8 && ok.body.settings.dedicatedStart.value === "2026-08-30", "§5 the answer carries the settings as GET shows them");
		const a = auditsOf(w, "kpi_settings_update");
		t(a.length === 1 && a[0].entity === "kpi" && a[0].entity_id === "settings" && a[0].details.includes("baselineMpg: not set → 8") &&
			a[0].details.includes("recipients: 0 addresses → 2 addresses; added ops@example.test, owner@example.test"), `§5 audited, each recipient added named (${a[0] && a[0].details})`);
		const same = await put({ baselineMpg: 8 });
		t(same.status === 200 && same.body.changed.length === 0 && auditsOf(w, "kpi_settings_update").length === 1, "§5 a no-op save: changed [], no audit row");
		const cleared = await put({ dedicatedStart: null, baselineMpg: 3 });
		t(cleared.status === 200 && JSON.parse(stored().value).dedicatedStart === null && JSON.parse(stored().value).baselineMpg === 3, "§5 null clears a date; 3 is accepted");
	} catch (e) {
		t(false, `section threw: ${e && e.message}`);
	} finally { await w.close(); }
	return r;
}

// ─────────────────────────────────────────── §6 recompute
async function recomputeSection(block) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const w = await startWorld(block);
	try {
		w.gate.current = deferred();
		const first = await w.call("POST", "/api/admin/kpis/recompute", { body: {} });
		t(first.status === 202 && first.body.status === "running" && Number.isInteger(first.body.runId) && first.body.runId > 0, `§6 202 { runId, status: running } (got ${first.status} ${JSON.stringify(first.body)})`);
		const second = await w.call("POST", "/api/admin/kpis/recompute", { body: {} });
		t(second.status === 409 && second.body.code === "KPI_RUN_IN_PROGRESS", `§6 a second while it runs: 409 KPI_RUN_IN_PROGRESS (got ${second.status})`);
		w.gate.current.resolve();
		w.gate.current = null;
		await w.waitIdle();
		const run = w.db.prepare("SELECT kind, status FROM kpi_runs WHERE id = ?").get(first.body.runId);
		t(run && run.kind === "manual" && run.status === "ok", `§6 the run finished as a manual run (${run && run.status})`);
		t(w.db.prepare("SELECT COUNT(*) AS n FROM kpi_runs").get().n === 1, "§6 ...and it was the only run");
		t(w.log.driveCalls === 0, "§6 a recompute never calls Drive (the folder is configured here)");
		const a = auditsOf(w, "kpi_recompute");
		t(a.length === 1 && a[0].entity_id === String(first.body.runId), "§6 audited as kpi_recompute with the run id");

		const budgetUser = { id: 77, username: "super_admin", role: "Super Admin" };
		for (let i = 0; i < 5; i++) await w.call("POST", "/api/admin/kpis/recompute", { user: budgetUser, body: {}, xrw: false });
		const statuses = [];
		for (let i = 0; i < 6; i++) {
			const x = await w.call("POST", "/api/admin/kpis/recompute", { user: budgetUser, body: {} });
			statuses.push(x.status);
			await w.waitIdle();
		}
		t(statuses.every((s) => s === 202), `§6 six recomputes in the window: all 202, the refused ones spent none of the budget (${statuses.join(",")})`);
		const over = await w.call("POST", "/api/admin/kpis/recompute", { user: budgetUser, body: {} });
		t(over.status === 429 && over.body && over.body.code === "KPI_RECOMPUTE_RATE_LIMITED", `§6 the seventh: 429 (got ${over.status})`);
	} catch (e) {
		t(false, `section threw: ${e && e.message}`);
	} finally { await w.close(); }
	return r;
}

// ─────────────────────────────────────────── §7 names
function namesSection() {
	const r = [];
	const above = SRC.slice(0, SRC.indexOf(START_MARK));
	for (const name of ["db", "app", "appTime", "APP_TIMEZONE", "publicFormInput", "getJobTrackingCached", "buildFinancialsLedger", "fetchDocumentBytes",
		"getDrive", "RATECON_DRIVE_FOLDER_ID", "rcIndexShared", "brokerInvoice", "notifyChange", "sendEmail", "ADMIN_NOTIFY_EMAIL", "startsJob",
		"requireRole", "refuseCrossOrigin", "rateLimit", "ipKeyGenerator", "logAudit", "auditText", "findCol", "sheetDayKey", "liveJobTrackingView", "RATECON_DOC_TYPES"]) {
		const re = new RegExp(`^(?:(?:async )?function ${name}\\(|const ${name} = |let ${name} = |const \\{[^}\\n]*\\b${name}\\b[^}\\n]*\\} = )`, "m");
		r.push({ ok: re.test(above), name: `§7 ${name} is defined in server.js above the KPI block` });
	}
	return r;
}

// ─────────────────────────────────────────── runner
let pass = 0;
const failures = [];
function record(results) {
	for (const x of results) { if (x.ok) pass++; else failures.push(x.name); }
	console.log(`  ${results.filter((x) => x.ok).length}/${results.length} checks`);
}
const failed = (results) => results.some((x) => !x.ok);

(async () => {
	console.log("\n§1 registrations");
	record(orderSection(SRC));
	console.log("\n§2 the gates");
	record(await gateSection(BLOCK));
	console.log("\n§3 GET /api/admin/kpis");
	record(await getSection(BLOCK));
	console.log("\n§4 PUT /api/admin/kpis/approvals/:key");
	record(await approvalSection(BLOCK));
	console.log("\n§5 PUT /api/admin/kpis/settings");
	record(await settingsSection(BLOCK));
	console.log("\n§6 POST /api/admin/kpis/recompute");
	record(await recomputeSection(BLOCK));
	console.log("\n§7 the names the block uses");
	record(namesSection());

	console.log("\n§8 MUTANTS");
	const swap = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.replace(from, to); };
	const mutants = [];
	for (const [k, head] of Object.entries(HEADS)) {
		mutants.push([`Dispatcher admitted to ${k}`, () => gateSection(swap(BLOCK, head, head.replace('requireRole("Super Admin")', 'requireRole("Super Admin", "Dispatcher")')))]);
		mutants.push([`requireAuth instead of requireRole on ${k}`, () => gateSection(swap(BLOCK, head, head.replace('requireRole("Super Admin")', "requireAuth")))]);
		if (head.includes("refuseCrossOrigin")) mutants.push([`refuseCrossOrigin removed from ${k}`, () => gateSection(swap(BLOCK, head, head.replace("refuseCrossOrigin, ", "")))]);
	}
	mutants.push(["the string \"true\" accepted as a boolean",
		() => approvalSection(swap(BLOCK, `typeof body.approved !== "boolean" ||`, `body.approved === undefined ||`))]);
	mutants.push(["a __proto__ (or any unknown) key accepted",
		() => settingsSection(swap(BLOCK, `if (!KPI_SETTING_FIELDS.includes(k)) return { error: "That is not a KPI setting.", field: String(k).slice(0, 40) };`, "if (!KPI_SETTING_FIELDS.includes(k)) continue;"))]);
	mutants.push(["MPG 0 / NaN / 99 accepted",
		() => settingsSection(swap(BLOCK, "if (v !== null && !(typeof v === \"number\" && Number.isFinite(v) && v >= 3 && v <= 15)) {", "if (v !== null && typeof v !== \"number\") {"))]);
	mutants.push(["a malformed date accepted",
		() => settingsSection(swap(BLOCK, "if (v !== null && !kpiSettingDay(v)) return", "if (v !== null && typeof v !== \"string\") return"))]);
	mutants.push(["the settings audit row dropped",
		() => settingsSection(swap(BLOCK, `logAudit(req, "kpi_settings_update", "kpi", "settings",`, `(() => {})(req, "kpi_settings_update", "kpi", "settings",`))]);
	mutants.push(["the approval audit row dropped",
		() => approvalSection(swap(BLOCK, `logAudit(req, "kpi_approval_set", "kpi", key,`, `(() => {})(req, "kpi_approval_set", "kpi", key,`))]);
	mutants.push(["the recompute audit row dropped",
		() => recomputeSection(swap(BLOCK, `logAudit(req, "kpi_recompute", "kpi", String(runId), "Manual KPI recompute started");`, ""))]);
	mutants.push(["the recompute not single-flight",
		() => recomputeSection(swap(BLOCK, `if (kpiRunning) return res.status(409).json({ error: "A KPI run is already in progress.", code: "KPI_RUN_IN_PROGRESS" });`, ""))]);
	mutants.push(["approvals hashed against the saved settings only (a moved derived AI start keeps the approval)",
		() => approvalSection(swap(BLOCK, "return { ...saved, aiDispatchStart: kpiIsDay(saved.aiDispatchStart) ? saved.aiDispatchStart : derived };", "return { ...saved };"))]);
	mutants.push(["the settings audit names no recipient",
		() => settingsSection(swap(BLOCK, "auditText(changed.map(said).join(\"; \"), 2000));", "auditText(changed.map((k) => `${k}: ${shown(k, before[k])} → ${shown(k, next[k])}`).join(\"; \"), 2000));"))]);
	mutants.push(["a metric with no approval row shown approved",
		() => getSection(swap(BLOCK, "const valid = Boolean(row) && kpiCatalog.approvalIsValid(row, m.key, settings);", "const valid = !row || kpiCatalog.approvalIsValid(row, m.key, settings);"))]);
	mutants.push(["the KPI block moved below app.get(\"*\")", async () => {
		const catchAll = SRC.indexOf('\napp.get("*"');
		const catchAllEnd = SRC.indexOf("\n});\n", catchAll) + "\n});\n".length;
		const moved = SRC.slice(0, SRC.indexOf(START_MARK)) + SRC.slice(SRC.indexOf(END_MARK), catchAllEnd) + BLOCK + SRC.slice(catchAllEnd);
		return orderSection(moved);
	}]);
	const results = [];
	for (const [name, run] of mutants) {
		const out = await run();
		results.push({ ok: failed(out), name: `MUTANT ${name}: caught` });
	}
	record(results);

	if (failures.length) {
		console.error(`\nFAILURES (${failures.length}):`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		console.error(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\n✓ ${pass} assertions passed`);
	process.exit(0);
})().catch((e) => die(e && e.stack ? e.stack : String(e)));
