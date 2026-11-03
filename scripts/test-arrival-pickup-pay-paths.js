#!/usr/bin/env node
/**
 * The arrival pickup date on the three pay paths (the weekly invoice, GET
 * /api/investor and the payout ledger), the driver-day override gate and the
 * three scripts that lift the invoice's days, behind ARRIVAL_PICKUP_DATE_ENABLED
 * and ARRIVAL_PICKUP_DATE_FROM (2026-11-20 unless a case says otherwise).
 *
 * The paths run lifted from server.js (scripts/lib/money-plans-world.js on
 * scripts/lib/work-days-world.js), with load_status_history rows written as the
 * arrival recorder writes them. Made-up data only: Amy Birch at $300 a day on
 * investor 5's truck T1 (no ELD unless a case gives one), Bo Wyn at 30% of
 * revenue; week W49 runs Sat Dec 5 - Fri Dec 11, 2026; shippers in the Central
 * zone.
 *
 *   P1  a late arrival: the three paths pay from it and agree day for day
 *   P2  an early arrival adds its day; the invoice lists the load on it (P11)
 *   P3  an arrival after the drop-off runs to the delivery, and the invoice names
 *       the 3-day extension; a 1-day one is not named
 *   P3b late at both ends: the window ends at the delivery (D11b (a))
 *   P4  a blank Pickup Appointment with an arrival pays from it on all three
 *   P5  no arrival, a staff set and a far tap: as today
 *   P6  Assigned before FROM; P7 no Assigned Date: as today
 *   P8  closing a month changes nothing; a FROM in a closed month gives one
 *       notice; an arrival in the month before still pays in the Assigned month
 *   P9  the trip work-day rule on: a load it pays keeps its trip days
 *   P10 the override gate: removing a day only the arrival window covers, in a
 *       load whose Assigned month is closed, is refused; off, as today
 *   P12 a percentage driver is unchanged, even where every arrival day would drop
 *   P13 the pre-dispatch rule on: the paths agree
 *   P14 the settings: only exactly "true"; a FROM that is no date stays off with
 *       one warning; the rule with the recorder off finds no arrival and warns
 *   P15 flag off, and flag on with nothing in scope: every answer is the base's
 *       own server.js on the same worlds (scripts/fixtures/arrival-pickup-flag-off.json,
 *       captured on the base with --capture=<file>)
 *   P16 the scripts: correct-weekly-invoice.js pays generate's days; the missed-
 *       week draft pays an arrival day, and its refusal names the arrival window;
 *       blank-pickup-dry-run.js lists what it could not read
 *   P17 a status history that can't be read (an older copy without the columns):
 *       the invoice pays the scheduled window and says ARRIVAL NOT READ, the
 *       ledger and the investor view pay it, the gate and both invoice scripts
 *       refuse
 *   N1-N3 the end is the first Delivered row of the current delivery, never the
 *       Status Update Date; a load completed outside the routes, or moved off
 *       Delivered since, pays its scheduled window and is named
 *   B1  the Friday batch (runWeeklyInvoiceBatch(), lifted) names each extension of
 *       2+ days in its summary, its in-app notice and its email, as ACTION NEEDED;
 *       a 1-day one is not named; flag off, nothing is kept or named (P15 pins the
 *       batch's flag-off output to the base's)
 *   B2  an invoice the driver generated and submitted before the batch (it answers
 *       INVOICE_EXISTS): still named, and the run is ACTION NEEDED with nothing
 *       submitted
 *   B3  a week the batch retries: the final attempt names attempt 1's invoice
 *   B4  a kept line whose invoice is no longer live is not named
 *   T   a DST night and local midnight; and §Z the window cases and B1 again under
 *       TZ America/New_York, America/Chicago, UTC and Asia/Manila
 *   M   mutants, each caught
 *
 * Every "on" case fails on a base without the rule (no flag); the pins pass on
 * both. Pure: no server, no app.db, no network.
 *   node scripts/test-arrival-pickup-pay-paths.js           # exits 1 on failure
 *   node scripts/test-arrival-pickup-pay-paths.js --capture=<file>   # on the base
 */
"use strict";
if (!process.env.ARRIVAL_PAY_PATHS_TZ_CHILD) process.env.TZ = "UTC"; // production's clock zone

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { spawnSync } = require("child_process");
const M = require("./lib/money-plans-world");
const { closure } = require("./lib/server-lift");
const { loadRow } = M;

const ROOT = M.ROOT;
const CHILD = !!process.env.ARRIVAL_PAY_PATHS_TZ_CHILD;
const CAPTURE = (process.argv.find((a) => a.startsWith("--capture=")) || "").slice("--capture=".length);
const FIXTURE = path.join(__dirname, "fixtures", "arrival-pickup-flag-off.json");
const ZONES = ["America/New_York", "America/Chicago", "UTC", "Asia/Manila"];

const AMY = "Amy Birch";
const BO = "Bo Wyn";
const FROM = "2026-11-20";
const ON = { ARRIVAL_PICKUP_DATE_ENABLED: "true", ARRIVAL_PICKUP_DATE_FROM: FROM, ARRIVAL_PICKUP_RECORDER_ENABLED: "true" };
const OFF = { ARRIVAL_PICKUP_RECORDER_ENABLED: "true" };
const NOW = Date.parse("2026-12-14T16:00:00Z");
const W49 = "2026-12-11";
const W48 = "2026-12-04";
const CHI = "America/Chicago";
const U = (s) => Date.parse(`${s.replace(" ", "T")}Z`);
const uniq = (a) => [...new Set(a)].sort();

// ── history rows, as the recorder writes them ─────────────────────────────────
const ev = (load, at, status, o = {}) => ({
	load, at, status, source: o.source || "manual", role: o.role === undefined ? "Driver" : o.role, old: o.old || "", actor: o.actor || AMY,
	fixMs: o.fixMs === undefined ? null : o.fixMs, zone: o.zone || "", tz: o.tz || "", hauling: o.hauling === undefined ? null : o.hauling,
});
const dispatchEv = (load, at) => ev(load, at, "Dispatched", { source: "dispatch", role: "Dispatcher", actor: "dispatcher_test" });
const geoEv = (load, at, fixAt, o = {}) => ev(load, at, "At Shipper", { source: "geofence", role: "system", old: o.old || "Heading to Shipper", fixMs: U(fixAt), zone: "inside", tz: CHI, hauling: o.hauling === undefined ? 0 : o.hauling });
const tapEv = (load, at, o = {}) => ev(load, at, "At Shipper", { old: o.old || "Heading to Shipper", zone: o.zone === undefined ? "inside" : o.zone, tz: CHI, role: o.role === undefined ? "Driver" : o.role });
const stepEv = (load, at, status, old) => ev(load, at, status, { old });
const deliveredEv = (load, at, old = "At Receiver") => ev(load, at, "Delivered", { old });
// A trip around an arrival event: dispatched, heading, the arrival, loading, in
// transit, at receiver, delivered.
function tripEvents(load, { dispatchAt, headingAt, arrival, loadingAt, receiverAt, deliveredAt }) {
	return [dispatchEv(load, dispatchAt), stepEv(load, headingAt, "Heading to Shipper", "Dispatched"), arrival,
		stepEv(load, loadingAt, "Loading", "At Shipper"), stepEv(load, loadingAt.replace(/:00$/, ":30"), "In Transit", "Loading"),
		stepEv(load, receiverAt, "At Receiver", "In Transit"), deliveredEv(load, deliveredAt)];
}
function addHistory(w, rows) {
	const st = w.db.prepare(`INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, reason, actor_role, fix_ms, pickup_zone, local_tz, other_load_hauling, changed_at)
		VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`);
	for (const r of rows) st.run(String(r.load).toLowerCase().replace(/^#/, ""), r.old, r.status, r.source, r.actor, r.role, r.fixMs, r.zone, r.tz, r.hauling, r.at);
}

// ── the loads (made up) ────────────────────────────────────────────────────────
const L = {
	// P1/P3b: picked up Mon 12/7 on the rate con, arrived Tue 12/8 08:40 CST, delivered Thu 12/10.
	late: () => ({
		row: loadRow({ id: "L-2101", driver: AMY, pickup: "2026-12-07 8:00", dropoff: "2026-12-09 17:00", assigned: "2026-12-04", done: "2026-12-10", truck: "T1" }),
		history: tripEvents("L-2101", { dispatchAt: "2026-12-04 15:00:00", headingAt: "2026-12-08 12:00:00", arrival: geoEv("L-2101", "2026-12-08 14:41:10", "2026-12-08 14:40:00"),
			loadingAt: "2026-12-08 16:00:00", receiverAt: "2026-12-10 15:00:00", deliveredAt: "2026-12-10 18:00:00" }),
	}),
	// P2: rate con Wed 12/9; the driver tapped "Arrived at Shipper" Tue 12/8 21:30 CST, inside the zone.
	early: () => ({
		row: loadRow({ id: "L-2102", driver: AMY, pickup: "2026-12-09 8:00", dropoff: "2026-12-10 17:00", assigned: "2026-12-04", done: "2026-12-10", truck: "T1" }),
		history: tripEvents("L-2102", { dispatchAt: "2026-12-04 15:00:00", headingAt: "2026-12-08 22:00:00", arrival: tapEv("L-2102", "2026-12-09 03:30:00"),
			loadingAt: "2026-12-09 15:00:00", receiverAt: "2026-12-10 20:00:00", deliveredAt: "2026-12-10 22:00:00" }),
	}),
	// P3: rate con Mon 12/7-Tue 12/8; arrived Thu 12/10 08:15 CST; delivered Fri 12/11.
	afterDropoff: () => ({
		row: loadRow({ id: "L-2103", driver: AMY, pickup: "2026-12-07 8:00", dropoff: "2026-12-08 17:00", assigned: "2026-12-04", done: "2026-12-11", truck: "T1" }),
		history: tripEvents("L-2103", { dispatchAt: "2026-12-04 15:00:00", headingAt: "2026-12-10 12:00:00", arrival: geoEv("L-2103", "2026-12-10 14:16:00", "2026-12-10 14:15:00"),
			loadingAt: "2026-12-10 16:00:00", receiverAt: "2026-12-11 18:00:00", deliveredAt: "2026-12-11 20:00:00" }),
	}),
	// P4: no Pickup Appointment; Assigned Mon 12/7; arrived Tue 12/8; delivered Wed 12/9.
	blankPickup: () => ({
		row: loadRow({ id: "L-2104", driver: AMY, pickup: "", dropoff: "2026-12-09 17:00", assigned: "2026-12-07", done: "2026-12-09", truck: "T1" }),
		history: tripEvents("L-2104", { dispatchAt: "2026-12-07 15:00:00", headingAt: "2026-12-08 12:00:00", arrival: geoEv("L-2104", "2026-12-08 14:41:00", "2026-12-08 14:40:00"),
			loadingAt: "2026-12-08 16:00:00", receiverAt: "2026-12-09 18:00:00", deliveredAt: "2026-12-09 20:00:00" }),
	}),
	// B1: rate con Mon 12/7-Wed 12/9; arrived Wed 12/9 08:00 CST; delivered Fri 12/11 12:00 CST, exactly 2 days past the drop-off.
	twoDays: () => ({
		row: loadRow({ id: "L-2114", driver: AMY, pickup: "2026-12-07 8:00", dropoff: "2026-12-09 17:00", assigned: "2026-12-04", done: "2026-12-11", truck: "T1" }),
		history: tripEvents("L-2114", { dispatchAt: "2026-12-04 15:00:00", headingAt: "2026-12-09 12:00:00", arrival: geoEv("L-2114", "2026-12-09 14:01:00", "2026-12-09 14:00:00"),
			loadingAt: "2026-12-09 16:00:00", receiverAt: "2026-12-11 15:00:00", deliveredAt: "2026-12-11 18:00:00" }),
	}),
};
// The invoice's extension lines for L-2103 (3 days) and L-2114 (2 days).
const EXT_2103 = "ARRIVAL WINDOW EXTENDED: load L-2103 is paid to 2026-12-11, 3 days after its Drop-off Appointment (2026-12-08), the day the status history shows it delivered.";
const EXT_2114 = "ARRIVAL WINDOW EXTENDED: load L-2114 is paid to 2026-12-11, 2 days after its Drop-off Appointment (2026-12-09), the day the status history shows it delivered.";
// The late load with another arrival event or history.
const lateWith = (arrival) => { const x = L.late(); x.history[2] = arrival; return x; };

function world(env, loads, opts = {}) {
	const w = M.startWorld({ env, drivers: [{ name: AMY, payDaily: 300 }, ...(opts.drivers || [])], rows: loads.map((x) => x.row), now: NOW, ...opts.world });
	addHistory(w, loads.flatMap((x) => x.history || []));
	if (opts.after) opts.after(w);
	return w;
}
// The days each path pays one driver (the invoice: the week's grid).
async function paths(w, { weekEnd = W49, driver = AMY } = {}) {
	const g = await M.generate(w, driver, weekEnd);
	if (g.status !== 200) throw new Error(`invoice: ${g.status} ${JSON.stringify(g.body).slice(0, 200)}`);
	const norm = driver.toLowerCase();
	const led = await M.ledger(w);
	const inv = await M.investorDays(w);
	const ledgerPay = led.pay.filter((p) => String(p.driver).toLowerCase() === norm);
	return {
		invoice: M.dayList(M.gridDays(g.data, weekEnd)),
		invoiceTotal: g.invoice ? g.invoice.total_earnings : null,
		warnings: g.warnings,
		grid: g.data && g.data.days,
		ledger: uniq(ledgerPay.filter((p) => p.day).map((p) => p.day)),
		ledgerMonths: M.monthDays(ledgerPay.filter((p) => p.day), norm),
		ledgerPay,
		investor: uniq(inv.days.filter((x) => String(x.driver).toLowerCase() === norm).map((x) => x.day)),
		investorMonths: M.monthDays(inv.days, norm),
		months: led.monthlyEarnings || [],
	};
}
const three = (p) => [p.invoice, p.ledger, p.investor];
const arrivalLines = (p) => p.warnings.filter((x) => /^ARRIVAL /.test(x));

// The driver-day override routes, lifted onto a world's database, sheet, clock and
// settings (from `src`, so a case can lift a mutated copy).
const OVERRIDE_HEADS = ['app.post("/api/admin/excluded-days",', 'app.delete("/api/admin/excluded-days/:id",'].map((p) => {
	const heads = M.SRC.split("\n").filter((l) => l.startsWith(p));
	if (heads.length !== 1) throw new Error(`expected one registration starting ${p}, found ${heads.length}`);
	return heads[0];
});
const OVERRIDE_PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "requireRole", "requireAuth", "refuseCrossOrigin",
	"notifyChange", "logAudit", "getJobTrackingCached", "jtCacheInvalidate", "getSheets", "SPREADSHEET_ID", "REPLICA", "SHEET_TARGET", "fs", "fetch", "io", "sendEmail"];
const OVERRIDE_LIFTS = new Map();
function overrideRoutes(w, env, src = M.SRC) {
	if (!OVERRIDE_LIFTS.has(src)) OVERRIDE_LIFTS.set(src, closure(src, { roots: ["parseSheet", "deduplicateLoads"], routes: OVERRIDE_HEADS, provided: OVERRIDE_PROVIDED, denied: ["server", "transporter", "getDrive", "KEY_FILE"] }));
	const routes = {};
	const register = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [w.clock.ms])); }
		static now() { return w.clock.ms; }
	}
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const deps = {
		db: w.db, require: Module.createRequire(path.join(ROOT, "server.js")), console: { log() {}, info() {}, error() {}, warn() {} },
		process: { env: { ...env }, argv: [], cwd: () => ROOT, pid: 4245 }, __dirname: ROOT, Date: FixedDate,
		app: { get: register("GET"), put: register("PUT"), post: register("POST"), delete: register("DELETE"), use() {} },
		requireRole: pass, requireAuth: pass(), refuseCrossOrigin: pass(), notifyChange: () => {}, logAudit: () => {},
		getJobTrackingCached: null, jtCacheInvalidate: () => {}, getSheets: null, SPREADSHEET_ID: "test-sheet", REPLICA: null, SHEET_TARGET: null,
		fs: null, fetch: () => { throw new Error("no network in a test"); }, io: null, sendEmail: async () => undefined,
	};
	const body = ['"use strict";', OVERRIDE_LIFTS.get(src).text,
		"getJobTrackingCached = async () => { const p = parseSheet({ values: __sheet() }); p.data = deduplicateLoads(p.data, p.headers); return p; };",
		"return null;"].join("\n");
	new Function(...Object.keys(deps), "__sheet", body)(...Object.values(deps), () => M.sheetValues(w.rows));
	return (key, req) => M.call(routes[key], { ...M.ADMIN, query: {}, params: {}, body: {}, ...req });
}

// The Friday batch (runWeeklyInvoiceBatch()) and the generate it calls, lifted onto a
// world's database, sheet, clock and settings (from `src`, so a case can lift a
// mutated copy). What it tells staff: its marker's summary (invoice_autogen_runs),
// its in-app notice (dispatch_notifications) and its email (captured here). The
// undated-load digest is off: scripts/test-invoice-week-selection.js covers it.
const BATCH_PROVIDED = [...OVERRIDE_PROVIDED.filter((n) => n !== "jtCacheInvalidate"), "renderPolicy", "DATA_DIR", "setTimeout"];
const BATCH_LIFTS = new Map();
function batchOn(w, env, src = M.SRC) {
	if (!BATCH_LIFTS.has(src)) {
		// Lifted by name, as scripts/lib/work-days-world.js lifts them: the closure walk
		// misses a call that starts the line after a comment ending in ".".
		const named = [...["assertInvoiceFileStillOwn"].filter((n) => src.includes(`\nfunction ${n}(`)), ...["_jtInflight"].filter((n) => src.includes(`\nlet ${n} =`))];
		BATCH_LIFTS.set(src, closure(src, { roots: ["runWeeklyInvoiceBatch", "generateInvoiceHandler", "parseSheet", "deduplicateLoads", ...named], provided: BATCH_PROVIDED, denied: ["server", "transporter", "getDrive", "KEY_FILE"] }));
	}
	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [w.clock.ms])); }
		static now() { return w.clock.ms; }
	}
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const emails = [];
	const logs = [];
	const log = (...a) => logs.push(a.join(" "));
	const deps = {
		db: w.db, require: Module.createRequire(path.join(ROOT, "server.js")), console: { log, info: log, error: log, warn: log },
		process: { env: { ...env, INVOICE_UNDATED_ALERT_ENABLED: "false", GMAIL_USER: "ops@example.invalid" }, argv: [], cwd: () => ROOT, pid: 4246 }, __dirname: ROOT, Date: FixedDate,
		app: { get() {}, put() {}, post() {}, delete() {}, use() {} },
		requireRole: pass, requireAuth: pass(), refuseCrossOrigin: pass(), notifyChange: () => {}, logAudit: () => {},
		getJobTrackingCached: null,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: M.sheetValues(w.rows) } }) } } }),
		SPREADSHEET_ID: "test-sheet", REPLICA: null, SHEET_TARGET: null,
		fs: { existsSync: () => true, mkdirSync: () => {}, readFileSync: () => "", writeFileSync: () => {}, renameSync: () => {}, unlinkSync: () => {} },
		fetch: () => { throw new Error("no network in a test"); }, io: null,
		sendEmail: async (to, subject, html) => { emails.push({ to, subject, html }); return true; },
		renderPolicy: async () => Buffer.from("%PDF-stub"), DATA_DIR: "/nonexistent-arrival-batch",
		// The batch races each driver against a 90 s timer: real, but never holding the process open.
		setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
	};
	const body = ['"use strict";', BATCH_LIFTS.get(src).text,
		"getJobTrackingCached = async () => { const p = parseSheet({ values: __sheet() }); p.data = deduplicateLoads(p.data, p.headers); return p; };",
		"return { runWeeklyInvoiceBatch, generateInvoiceHandler };"].join("\n");
	const api = new Function(...Object.keys(deps), "__sheet", body)(...Object.values(deps), () => M.sheetValues(w.rows));
	return {
		emails, logs,
		run: (weekEnd, attempt = 1) => api.runWeeklyInvoiceBatch(weekEnd, attempt),
		generate: (user, body) => M.call(api.generateInvoiceHandler, { session: { user }, headers: {}, query: {}, params: {}, body }),
		marker: (weekEnd) => w.db.prepare("SELECT attempts, created, submitted, skipped, failed, summary FROM invoice_autogen_runs WHERE week_end = ?").get(weekEnd) || null,
		notices: () => w.db.prepare("SELECT title, body, metadata FROM dispatch_notifications WHERE type = 'invoices-autogen' ORDER BY id").all(),
		kept: () => w.db.prepare("SELECT key, value FROM server_state WHERE substr(key, 1, 21) = 'arrival_pickup_lines:' ORDER BY key").all(),
	};
}
const AMY_DRIVER = { id: 9, role: "Driver", username: "abirch", driverName: AMY };
// One batch run of W49 and its three channels, for a check.
async function batchRun(w, env, { src = M.SRC } = {}) {
	const b = batchOn(w, env, src);
	await b.run(W49, 1);
	const m = b.marker(W49);
	return { b, marker: m, summary: (m && m.summary) || "", notices: b.notices(), emails: b.emails, kept: b.kept() };
}

// A mutated copy of a lib module (and the modules after it, compiled fresh so they
// take it), swapped into the require cache while `fn` starts its worlds.
async function withLibs(changes, fn) {
	const saved = new Map();
	try {
		for (const [rel, edit] of changes) {
			const file = path.join(ROOT, rel);
			const text = fs.readFileSync(file, "utf8");
			const next = edit ? edit(text) : text;
			if (edit && next === text) throw new Error(`the mutant's anchor is not in ${rel}`);
			if (!saved.has(file)) saved.set(file, require.cache[file]);
			const m = new Module(file, null);
			m.filename = file;
			m.paths = Module._nodeModulePaths(path.dirname(file));
			m._compile(next, file);
			m.loaded = true;
			require.cache[file] = m;
		}
		return await fn();
	} finally {
		for (const [file, old] of saved) { if (old) require.cache[file] = old; else delete require.cache[file]; }
	}
}
const replace = (from, to) => (text) => (text.includes(from) ? text.replace(from, to) : text);

const R = M.createRunner(CHILD ? `TZ=${process.env.TZ}` : "The arrival pickup date on the three pay paths, the override gate and the scripts");
const test = R.test;
const DEC_7_9 = ["2026-12-07", "2026-12-08", "2026-12-09"];
const DEC_8_10 = ["2026-12-08", "2026-12-09", "2026-12-10"];

// ── P15: the answers the base's own server.js gives ─────────────────────────────
// Several made-up worlds, the three paths and the gate; flag off (and on with FROM
// after every load), these must be the base's to the byte.
async function flagOffAnswers(env) {
	const out = [];
	const bo = { name: BO, payType: "percentage", payPct: 30 };
	const sets = [
		["late, early, after the drop-off, blank pickup", [L.late(), L.early(), L.afterDropoff(), L.blankPickup()], {}],
		["an ELD truck", [L.late(), L.early()], { world: { trucks: [{ unit: "T1", driver: AMY, vid: "V1" }], pings: { V1: M.feed(1000).drive("2026-12-07", { miles: 210 }).park("2026-12-08").drive("2026-12-09", { miles: 300 }).drive("2026-12-10", { miles: 250 }).pings } } }],
		["a percentage driver beside", [L.late(), { row: loadRow({ id: "L-2112", driver: BO, pickup: "2026-12-07 8:00", dropoff: "2026-12-09 17:00", assigned: "2026-12-04", done: "2026-12-11", truck: "T2" }),
			history: tripEvents("L-2112", { dispatchAt: "2026-12-04 15:00:00", headingAt: "2026-12-10 12:00:00", arrival: { ...geoEv("L-2112", "2026-12-10 14:01:00", "2026-12-10 14:00:00"), actor: BO }, loadingAt: "2026-12-10 16:00:00", receiverAt: "2026-12-11 15:00:00", deliveredAt: "2026-12-11 18:00:00" }) }], { drivers: [bo] }],
	];
	for (const [label, loads, opts] of sets) {
		const w = world(env, loads, opts);
		const p = await paths(w);
		out.push([label, { invoice: M.gridDays({ days: p.grid }, W49), total: p.invoiceTotal, warnings: p.warnings, ledger: p.ledgerPay.map((x) => [x.month, x.day, x.cents, x.loadId || ""]),
			months: p.months, investor: p.investorMonths }]);
		if (opts.drivers) {
			const q = await paths(w, { driver: BO });
			out.push([`${label}: ${BO}`, { invoice: M.gridDays({ days: q.grid }, W49), total: q.invoiceTotal, ledger: q.ledgerPay.map((x) => [x.month, x.day, x.cents, x.days || 0]), investor: q.investorMonths }]);
		}
	}
	const gw = world(env, [L.early()], { world: { locks: ["2026-11"] } });
	const call = overrideRoutes(gw, env);
	const post = await call("POST /api/admin/excluded-days", { body: { driverName: AMY, date: "2026-12-08", action: "remove", reason: "test" } });
	out.push(["the gate", [post.status, post.body && post.body.code, post.body && post.body.periods]]);
	// The Friday batch over the first set's loads: what it tells staff, to the byte
	// (the email's HTML by its length and sha256).
	const batch = await batchRun(world(env, [L.late(), L.early(), L.afterDropoff(), L.blankPickup()]), env);
	out.push(["the Friday batch", { marker: batch.marker, notices: batch.notices,
		emails: batch.emails.map((e) => [e.to, e.subject, e.html.length, crypto.createHash("sha256").update(e.html).digest("hex")]) }]);
	return out;
}

async function cases() {
	// ══ window cases (also run under each process zone, §Z) ═════════════════════
	await test("P1/P3b late at both ends: rate con Dec 7-9, arrived Dec 8, delivered Dec 10: all three pay Dec 8-10 ($900, the days worked). Off: Dec 7-9", async ({ eq }) => {
		const on = await paths(world(ON, [L.late()]));
		const off = await paths(world(OFF, [L.late()]));
		eq("on: [invoice, ledger, investor view]", three(on), [DEC_8_10, DEC_8_10, DEC_8_10]);
		eq("on: invoice total", on.invoiceTotal, 900);
		eq("off: [invoice, ledger, investor view]", three(off), [DEC_7_9, DEC_7_9, DEC_7_9]);
		eq("on: a 1-day extension past the drop-off is not named; nothing else either", arrivalLines(on), []);
	});
	await test("P2/P11 an early arrival (tap inside, Tue Dec 8 21:30 CST) adds Dec 8 on all three, and the invoice lists the load on that day. Off: Dec 9-10", async ({ eq }) => {
		const on = await paths(world(ON, [L.early()]));
		const off = await paths(world(OFF, [L.early()]));
		eq("on", three(on), [DEC_8_10, DEC_8_10, DEC_8_10]);
		eq("off", three(off), [["2026-12-09", "2026-12-10"], ["2026-12-09", "2026-12-10"], ["2026-12-09", "2026-12-10"]]);
		eq("on: Tuesday lists L-2102, not \"(scheduled)\"", [on.grid.Tuesday.listed, on.grid.Tuesday.scheduled], [["L-2102"], []]);
	});
	await test("P3 an arrival after the drop-off (Thu Dec 10) runs to the delivery (Fri Dec 11) on all three, and the invoice names the 3-day extension. Off: Dec 7-8", async ({ eq }) => {
		const on = await paths(world(ON, [L.afterDropoff()]));
		const off = await paths(world(OFF, [L.afterDropoff()]));
		eq("on", three(on), [["2026-12-10", "2026-12-11"], ["2026-12-10", "2026-12-11"], ["2026-12-10", "2026-12-11"]]);
		eq("off", three(off), [["2026-12-07", "2026-12-08"], ["2026-12-07", "2026-12-08"], ["2026-12-07", "2026-12-08"]]);
		eq("on: the warning", arrivalLines(on), ["ARRIVAL WINDOW EXTENDED: load L-2103 is paid to 2026-12-11, 3 days after its Drop-off Appointment (2026-12-08), the day the status history shows it delivered."]);
		eq("off: no arrival warning", arrivalLines(off), []);
	});
	await test("P4 a blank Pickup Appointment with an arrival pays from the arrival on all three (Dec 8-9). Off: the invoice pays no day, the ledger and the investor view Dec 7-9", async ({ eq }) => {
		const on = await paths(world(ON, [L.blankPickup()]));
		const off = await paths(world(OFF, [L.blankPickup()]));
		eq("on", three(on), [["2026-12-08", "2026-12-09"], ["2026-12-08", "2026-12-09"], ["2026-12-08", "2026-12-09"]]);
		eq("off", [...three(off), off.invoiceTotal], [[], DEC_7_9, DEC_7_9, 0]);
		eq("on: no blank-pickup warning (the arrival starts the window, not the Assigned Date)", on.warnings.filter((x) => /Pickup Appointment blank/.test(x)), []);
	});
	await test("T1 the fall-back night: arrived 23:30 CST Sun Nov 1 (05:30 UTC Nov 2), rate con Mon Nov 2-Tue Nov 3, Assigned Fri Oct 30: Nov 1-3 on all three, counted in October", async ({ eq }) => {
		const env = { ...ON, ARRIVAL_PICKUP_DATE_FROM: "2026-10-25" };
		const load = (fix) => ({
			row: loadRow({ id: "L-2131", driver: AMY, pickup: "2026-11-02 8:00", dropoff: "2026-11-03 17:00", assigned: "2026-10-30", done: "2026-11-03", truck: "T1" }),
			history: tripEvents("L-2131", { dispatchAt: "2026-10-30 15:00:00", headingAt: "2026-11-01 20:00:00", arrival: geoEv("L-2131", fix.replace(/:00$/, ":40"), fix),
				loadingAt: "2026-11-02 15:00:00", receiverAt: "2026-11-03 18:00:00", deliveredAt: "2026-11-03 20:00:00" }),
		});
		const on = await paths(world(env, [load("2026-11-02 05:30:00")]), { weekEnd: "2026-11-06" });
		const nov = ["2026-11-01", "2026-11-02", "2026-11-03"];
		eq("on: [invoice, ledger, investor view]", three(on), [nov, nov, nov]);
		eq("on: the ledger and the investor view count them in October, the Assigned month", [on.ledgerMonths, on.investorMonths], [nov.map((d) => `2026-10 ${d}`), nov.map((d) => `2026-10 ${d}`)]);
		const before = await paths(world(env, [load("2026-11-02 05:59:00")]), { weekEnd: "2026-11-06" });
		const after = await paths(world(env, [load("2026-11-02 06:01:00")]), { weekEnd: "2026-11-06" });
		eq("23:59 CST is still Nov 1; 00:01 CST is Nov 2", [before.invoice[0], after.invoice[0], after.ledger[0]], ["2026-11-01", "2026-11-02", "2026-11-02"]);
	});
	// ══ the Friday batch: where staff see the lines ═════════════════════════════
	await test("B1 the Friday batch bills W49 and names L-2103 (3 days past its drop-off) and L-2114 (exactly 2) in its summary, its in-app notice and its email, as ACTION NEEDED; L-2101 (1 day) is not named. Off: nothing kept or named", async ({ eq, ok }) => {
		const loads = () => [L.late(), L.afterDropoff(), L.twoDays()];
		const on = await batchRun(world(ON, loads()), ON);
		const seg = ` · 2 ARRIVAL lines to check (Amy Birch: ${EXT_2103}; Amy Birch: ${EXT_2114})`;
		eq("on: the marker [submitted, failed]", on.marker && [on.marker.submitted, on.marker.failed], [1, 0]);
		ok("on: the summary names both", on.summary.includes(seg), on.summary);
		ok("on: ...and not L-2101", !/ARRIVAL[^;]*L-2101/.test(on.summary), on.summary);
		eq("on: one in-app notice, ACTION NEEDED, its body the summary", on.notices.map((n) => [n.title, n.body]), [["Weekly invoices — ACTION NEEDED · 2026-12-05 to 2026-12-11", on.summary]]);
		eq("on: one email, ACTION NEEDED", on.emails.map((e) => [e.to, e.subject]), [["ops@example.invalid", "Weekly Invoices — ACTION NEEDED — 2026-12-05 to 2026-12-11"]]);
		ok("on: the email names both", on.emails.length === 1 && on.emails[0].html.includes(`Amy Birch: ${EXT_2103}<br>Amy Birch: ${EXT_2114}</p>`), on.emails[0] && on.emails[0].html.slice(-900));
		const off = await batchRun(world(OFF, loads()), OFF);
		eq("off: nothing kept", off.kept.length, 0);
		ok("off: no ARRIVAL in the summary, the notice or the email", !/ARRIVAL|Arrival pickup/.test(JSON.stringify([off.summary, off.notices, off.emails])), off.summary);
		eq("off: the notice says generated", off.notices.map((n) => n.title), ["Weekly invoices generated · 2026-12-05 to 2026-12-11"]);
	});
}

async function moreCases() {
	await test("P5 no arrival row, a staff set (dashboard dropdown) and a far tap: each paid as today on all three, flag on", async ({ eq }) => {
		const noRow = L.late();
		noRow.history = noRow.history.filter((r) => r.status !== "At Shipper");
		for (const [label, x] of [["no At Shipper", noRow], ["a staff set", lateWith(tapEv("L-2101", "2026-12-08 14:41:00", { role: "Super Admin" }))], ["a far tap", lateWith(tapEv("L-2101", "2026-12-08 14:41:00", { zone: "outside" }))]]) {
			eq(label, three(await paths(world(ON, [x]))), [DEC_7_9, DEC_7_9, DEC_7_9]);
		}
	});
	await test("P6/P7 Assigned before FROM (Nov 19), or no Assigned Date: paid as today, flag on", async ({ eq }) => {
		const before = L.late();
		before.row["Assigned Date"] = "11/19/2026";
		eq("Assigned Nov 19", three(await paths(world(ON, [before]))), [DEC_7_9, DEC_7_9, DEC_7_9]);
		const none = L.late();
		none.row["Assigned Date"] = "";
		const off = three(await paths(world(OFF, [none])));
		eq("no Assigned Date: as off", three(await paths(world(ON, [none]))), off);
	});
	await test("P8 closing December changes no day on any path; a FROM in a closed month gives one notice; an arrival on Nov 30 still pays in December, the Assigned month", async ({ eq, ok }) => {
		const w = world(ON, [L.late()]);
		const open = await paths(w);
		w.lock(["2026-12"]);
		const closed = await paths(w);
		eq("the same days after the close", three(closed), three(open));
		const n = world(ON, [L.late()], { world: { locks: ["2026-11"] } });
		const notices = n.warnings.filter((x) => /ARRIVAL_PICKUP_DATE_FROM is in or before 2026-11/.test(x));
		eq("one notice", notices.length, 1);
		ok("...which never asks to move FROM", /Never change ARRIVAL_PICKUP_DATE_FROM/.test(notices[0] || ""), notices);
		const nov30 = {
			row: loadRow({ id: "L-2108", driver: AMY, pickup: "2026-12-02 8:00", dropoff: "2026-12-03 17:00", assigned: "2026-12-01", done: "2026-12-03", truck: "T1" }),
			history: tripEvents("L-2108", { dispatchAt: "2026-11-30 13:00:00", headingAt: "2026-11-30 15:00:00", arrival: tapEv("L-2108", "2026-11-30 20:00:00"),
				loadingAt: "2026-12-02 15:00:00", receiverAt: "2026-12-03 15:00:00", deliveredAt: "2026-12-03 18:00:00" }),
		};
		const p = await paths(world(ON, [nov30]), { weekEnd: W48 });
		const want = ["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03"];
		eq("[invoice, ledger, investor view]", three(p), [want, want, want]);
		eq("the ledger counts Nov 30 in December", p.ledgerMonths, want.map((d) => `2026-12 ${d}`));
	});
	const TRIP = { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-11" };
	const tripLoad = () => ({
		row: loadRow({ id: "L-2109", driver: AMY, pickup: "2026-12-08 8:00", dropoff: "2026-12-09 17:00", assigned: "2026-12-04", done: "2026-12-09", truck: "T1" }),
		history: tripEvents("L-2109", { dispatchAt: "2026-12-04 15:00:00", headingAt: "2026-12-07 13:00:00", arrival: geoEv("L-2109", "2026-12-08 14:01:00", "2026-12-08 14:00:00"),
			loadingAt: "2026-12-08 15:00:00", receiverAt: "2026-12-09 15:00:00", deliveredAt: "2026-12-09 18:00:00" }),
	});
	const tripWorld = (env) => world({ ...env, ...TRIP }, [tripLoad()], { world: { trucks: [{ unit: "T1", driver: AMY, vid: "V1" }], pings: { V1: M.feed(1000).drive("2026-12-07", { miles: 280 }).drive("2026-12-08", { miles: 120 }).drive("2026-12-09", { miles: 300 }).pings } } });
	await test("P9 the trip work-day rule on: a load it pays keeps its trip days (the drive to the pickup, Mon Dec 7, included) on all three, the arrival flag on or off", async ({ eq }) => {
		const want = DEC_7_9;
		eq("arrival on: [invoice, ledger, investor view]", three(await paths(tripWorld(ON))), [want, want, want]);
		eq("arrival off", three(await paths(tripWorld(OFF))), [want, want, want]);
	});
	const lockLoad = () => ({
		row: loadRow({ id: "L-2110", driver: AMY, pickup: "2026-12-03 8:00", dropoff: "2026-12-04 17:00", assigned: "2026-11-28", done: "2026-12-04", truck: "T1" }),
		history: tripEvents("L-2110", { dispatchAt: "2026-11-28 15:00:00", headingAt: "2026-12-02 15:00:00", arrival: tapEv("L-2110", "2026-12-02 20:00:00"),
			loadingAt: "2026-12-03 15:00:00", receiverAt: "2026-12-04 15:00:00", deliveredAt: "2026-12-04 20:00:00" }),
	});
	const gateCase = async (env, src) => {
		const w = world(env, [lockLoad()], { world: { locks: ["2026-11"] } });
		const post = await overrideRoutes(w, env, src)("POST /api/admin/excluded-days", { body: { driverName: AMY, date: "2026-12-02", action: "remove", reason: "test" } });
		const w2 = world(env, [lockLoad()], { world: { locks: ["2026-11"], overrides: [{ driver: AMY, day: "2026-12-02" }] } });
		const id = w2.db.prepare("SELECT id FROM excluded_driver_days").get().id;
		const del = await overrideRoutes(w2, env, src)("DELETE /api/admin/excluded-days/:id", { params: { id: String(id) } });
		return { post, del, rows: [w.db.prepare("SELECT COUNT(*) AS n FROM excluded_driver_days").get().n, w2.db.prepare("SELECT COUNT(*) AS n FROM excluded_driver_days").get().n] };
	};
	await test("P10 the override gate, November closed: the load Assigned Nov 28 arrived Wed Dec 2, a day only its arrival window covers: removing or restoring Dec 2 answers 409 naming November. Off: 200 both", async ({ eq }) => {
		const on = await gateCase(ON);
		eq("on: POST [status, code, periods]", [on.post.status, on.post.body && on.post.body.code, on.post.body && on.post.body.periods], [409, "PERIOD_FINALIZED", ["2026-11"]]);
		eq("on: DELETE [status, code, periods]", [on.del.status, on.del.body && on.del.body.code, on.del.body && on.del.body.periods], [409, "PERIOD_FINALIZED", ["2026-11"]]);
		eq("on: nothing written", on.rows, [0, 1]);
		const off = await gateCase(OFF);
		eq("off: [POST, DELETE] go through as today", [off.post.status, off.del.status, off.rows], [200, 200, [1, 0]]);
	});
	const boLoad = () => ({
		row: loadRow({ id: "L-2112", driver: BO, pickup: "2026-12-07 8:00", dropoff: "2026-12-09 17:00", assigned: "2026-12-04", done: "2026-12-11", truck: "T2" }),
		history: tripEvents("L-2112", { dispatchAt: "2026-12-04 15:00:00", headingAt: "2026-12-10 12:00:00", arrival: { ...geoEv("L-2112", "2026-12-10 14:01:00", "2026-12-10 14:00:00"), actor: BO },
			loadingAt: "2026-12-10 16:00:00", receiverAt: "2026-12-11 15:00:00", deliveredAt: "2026-12-11 18:00:00" }),
	});
	const boWorld = (env) => world(env, [boLoad()], {
		drivers: [{ name: BO, payType: "percentage", payPct: 30 }],
		world: { trucks: [{ unit: "T1", driver: AMY }, { unit: "T2", driver: BO, vid: "V2" }], pings: { V2: M.feed(2000).drive("2026-12-07", { miles: 200 }).drive("2026-12-08", { miles: 250 }).drive("2026-12-09", { miles: 180 }).park("2026-12-10").park("2026-12-11").pings } },
	});
	await test("P12 a percentage driver is unchanged, the flag on: his scheduled days (Dec 7-9) still set his December pay, though every arrival day (Dec 10-11, parked) would drop", async ({ eq }) => {
		const on = await paths(boWorld(ON), { driver: BO });
		const off = await paths(boWorld(OFF), { driver: BO });
		eq("on = off: [invoice days, investor days, ledger items]", [on.invoice, on.investor, on.ledgerPay.map((x) => [x.month, x.days, x.cents])],
			[off.invoice, off.investor, off.ledgerPay.map((x) => [x.month, x.days, x.cents])]);
		eq("his December: 3 days, paid", [on.ledgerPay.map((x) => [x.month, x.days]), on.ledgerPay.every((x) => x.cents > 0)], [[["2026-12", 3]], true]);
	});
	await test("P13 the pre-dispatch rule on beside it: the three paths agree (the arrival window starts after the dispatch, so the rule drops none of it)", async ({ eq }) => {
		const PRE = { PRE_DISPATCH_PAY_DAY_RULE_ENABLED: "true", PRE_DISPATCH_PAY_DAY_RULE_FROM: "2026-11" };
		const x = {
			row: loadRow({ id: "L-2113", driver: AMY, pickup: "2026-12-05 8:00", dropoff: "2026-12-10 17:00", assigned: "2026-12-04", done: "2026-12-10", truck: "T1" }),
			history: tripEvents("L-2113", { dispatchAt: "2026-12-07 15:00:00", headingAt: "2026-12-07 16:00:00", arrival: geoEv("L-2113", "2026-12-07 17:01:00", "2026-12-07 17:00:00"),
				loadingAt: "2026-12-07 19:00:00", receiverAt: "2026-12-10 15:00:00", deliveredAt: "2026-12-10 18:00:00" }),
		};
		const opts = { world: { trucks: [{ unit: "T1", driver: AMY, vid: "V1" }], coords: { "L-2113": M.PICKUP },
			pings: { V1: M.feed(1000).park("2026-12-02").drive("2026-12-05", { miles: 7.5 }).park("2026-12-06").drive("2026-12-07", { miles: 200, visit: M.PICKUP }).drive("2026-12-08", { miles: 300 }).drive("2026-12-09", { miles: 300 }).drive("2026-12-10", { miles: 200 }).park("2026-12-12").pings } } };
		const want = ["2026-12-07", "2026-12-08", "2026-12-09", "2026-12-10"];
		eq("both on: [invoice, ledger, investor view]", three(await paths(world({ ...ON, ...PRE }, [x], opts))), [want, want, want]);
		eq("pre-dispatch alone: the same (it drops Dec 5, and Dec 6 never moved)", three(await paths(world({ ...OFF, ...PRE }, [x], opts))), [want, want, want]);
	});
	await test("P14 the settings: ENABLED \"TRUE\" or \"1\" is off; a FROM that is no date stays off with one warning naming the setting, never its value; the recorder off warns, and its rows give no arrival", async ({ eq, ok }) => {
		for (const v of ["TRUE", "1"]) eq(`ENABLED=${v}: as off`, three(await paths(world({ ...ON, ARRIVAL_PICKUP_DATE_ENABLED: v }, [L.late()]))), [DEC_7_9, DEC_7_9, DEC_7_9]);
		const bad = world({ ...ON, ARRIVAL_PICKUP_DATE_FROM: "2026-11" }, [L.late()]);
		const said = bad.warnings.filter((x) => /ARRIVAL_PICKUP_DATE_FROM/.test(x));
		eq("one warning", said.length, 1);
		ok("...never its value", !said.some((x) => x.includes("2026-11 ") || /"2026-11"/.test(x)), said);
		eq("...and the rule stays off", three(await paths(bad)), [DEC_7_9, DEC_7_9, DEC_7_9]);
		const noRecorder = { ...ON };
		delete noRecorder.ARRIVAL_PICKUP_RECORDER_ENABLED;
		const unrecorded = L.late();
		unrecorded.history = unrecorded.history.map((r) => ({ ...r, role: "", fixMs: null, zone: "", tz: "", hauling: null }));
		const w = world(noRecorder, [unrecorded]);
		ok("the recorder-off warning at start", w.warnings.some((x) => /ARRIVAL_PICKUP_RECORDER_ENABLED is off/.test(x)), w.warnings);
		eq("rows written without the recorder: no arrival, as today", three(await paths(w)), [DEC_7_9, DEC_7_9, DEC_7_9]);
	});
	await test("P15 flag off, and flag on with FROM after every load: every answer is the base server.js's (captured fixture)", async ({ eq, ok }) => {
		ok("the fixture exists", fs.existsSync(FIXTURE), FIXTURE);
		if (!fs.existsSync(FIXTURE)) return;
		const base = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).answers;
		eq("flag off", await flagOffAnswers(OFF), base);
		eq("flag on, FROM 2027-06-01 (nothing in scope)", await flagOffAnswers({ ...ON, ARRIVAL_PICKUP_DATE_FROM: "2027-06-01" }), base);
	});

	// ── N-M1: the window's end ──────────────────────────────────────────────────
	await test("N1 the end is the first Delivered row (Thu Dec 10), not the Status Update Date re-stamped Fri Dec 11: Dec 8-10 on all three", async ({ eq }) => {
		const x = L.late();
		x.row["Status Update Date"] = "12/11/2026 9:15";
		x.row["Completion Date"] = "12/11/2026";
		eq("on", three(await paths(world(ON, [x]))), [DEC_8_10, DEC_8_10, DEC_8_10]);
	});
	await test("N2/N3 completed outside the status routes (no Delivered row), or moved off Delivered since: the scheduled window on all three, and the invoice names it", async ({ eq }) => {
		const noDelivery = L.late();
		noDelivery.history = noDelivery.history.filter((r) => r.status !== "Delivered");
		const movedOff = L.late();
		movedOff.history.push(stepEv("L-2101", "2026-12-10 21:00:00", "At Receiver", "In Transit"));
		for (const [label, x] of [["no Delivered row", noDelivery], ["moved off Delivered", movedOff]]) {
			const p = await paths(world(ON, [x]));
			eq(`${label}: the scheduled window`, three(p), [DEC_7_9, DEC_7_9, DEC_7_9]);
			eq(`${label}: the warning`, arrivalLines(p).map((l) => l.replace(/: its delivery .*\. This/, ": <reason>. This")),
				["ARRIVAL RULE NOT APPLIED: load L-2101: <reason>. This invoice pays its scheduled window instead."]);
		}
	});

	// ── the Friday batch: invoices it did not generate ─────────────────────────
	await batchCases();

	// ── P17: a history that can't be read ───────────────────────────────────────
	const dropColumn = (w) => w.db.exec("ALTER TABLE load_status_history DROP COLUMN actor_role");
	await test("P17 an older copy without the recorder's columns: the invoice pays the scheduled window and says ARRIVAL NOT READ; the ledger and the investor view pay it; the gate refuses as unresolved", async ({ eq, ok }) => {
		const w = world(ON, [L.late()], { after: dropColumn });
		const p = await paths(w);
		eq("the scheduled window on all three", three(p), [DEC_7_9, DEC_7_9, DEC_7_9]);
		eq("the warning", arrivalLines(p), ["ARRIVAL NOT READ: load L-2101: the status history could not be read (no such column: actor_role). This invoice pays its scheduled window instead."]);
		ok("the ledger or the investor view logged it", w.warnings.some((x) => /\[arrival-pickup\] the status history could not be read/.test(x)), w.warnings);
		const g = world(ON, [lockLoad()], { world: { locks: ["2026-11"] }, after: dropColumn });
		const post = await overrideRoutes(g, ON)("POST /api/admin/excluded-days", { body: { driverName: AMY, date: "2026-12-02", action: "remove", reason: "test" } });
		eq("the gate: [status, code]", [post.status, post.body && post.body.code], [409, "PERIOD_UNRESOLVED"]);
	});

	// ── P16: the scripts ────────────────────────────────────────────────────────
	await scriptCases(dropColumn);
}

// ── B2-B4 the batch and the invoices it finds already there ───────────────────
// The driver's own invoice of W49, generated (and submitted) before the batch.
async function ownInvoice(w, b, { submit = true } = {}) {
	const g = await b.generate(AMY_DRIVER, { weekEnd: W49 });
	if (g.status !== 200) throw new Error(`the driver's generate: ${g.status} ${JSON.stringify(g.body).slice(0, 200)}`);
	if (submit) w.db.prepare("UPDATE invoices SET status = 'Submitted', submitted_at = '2026-12-10T15:00:00.000Z' WHERE id = ?").run(g.body.invoice.id);
	return g.body.invoice;
}
// A driver off the roster (no directory row) with a completed W49 load: worked but
// unbilled, so the batch retries the week.
const offRoster = () => ({ row: loadRow({ id: "L-2115", driver: "Cy Tester", pickup: "2026-12-08 8:00", dropoff: "2026-12-09 17:00", assigned: "2026-12-04", done: "2026-12-09" }) });
// Each scenario on `src` (the shipping server.js, or a mutant's copy): what the
// batch's channels said.
const told = (b) => ({ marker: b.marker(W49), summary: (b.marker(W49) || {}).summary || "", notices: b.notices(), emails: b.emails, kept: b.kept() });
const SCENARIOS = {
	// B2: Amy's own invoice, generated and submitted before the batch.
	async ownSubmitted(src) {
		const w = world(ON, [L.afterDropoff()]);
		const b = batchOn(w, ON, src);
		await ownInvoice(w, b);
		await b.run(W49, 1);
		return told(b);
	},
	// B3: three attempts; after attempt 1, what it had said.
	async retried(src) {
		const w = world(ON, [L.afterDropoff(), offRoster()]);
		const b = batchOn(w, ON, src);
		await b.run(W49, 1);
		const first = { marker: b.marker(W49), notices: b.notices().length, emails: b.emails.length };
		await b.run(W49, 2);
		await b.run(W49, 3);
		return { first, ...told(b) };
	},
	// B4: Amy's Draft deleted and L-2103 cancelled before the batch.
	async stale(src) {
		const w = world(ON, [L.afterDropoff()]);
		const b = batchOn(w, ON, src);
		const inv = await ownInvoice(w, b, { submit: false });
		w.db.prepare("UPDATE invoices SET deleted_at = '2026-12-10T15:00:00.000Z', deleted_by = 'super_admin' WHERE id = ?").run(inv.id);
		w.setRow("L-2103", { "Job Status": "Cancelled" });
		await b.run(W49, 1);
		return told(b);
	},
};
async function batchCases() {
	await test("B2 Amy generated and submitted her own W49 invoice before the batch (it answers INVOICE_EXISTS): the batch still names L-2103's extension, ACTION NEEDED though it submitted nothing", async ({ eq, ok }) => {
		const t = await SCENARIOS.ownSubmitted(M.SRC);
		eq("the batch: [submitted, skipped, failed]", t.marker && [t.marker.submitted, t.marker.skipped, t.marker.failed], [0, 1, 0]);
		ok("the summary names it", t.summary.includes(` · 1 ARRIVAL line to check (Amy Birch: ${EXT_2103})`), t.summary);
		eq("one in-app notice, ACTION NEEDED", t.notices.map((n) => [n.title, n.body.includes(EXT_2103)]), [["Weekly invoices — ACTION NEEDED · 2026-12-05 to 2026-12-11", true]]);
		eq("one email naming it", t.emails.map((e) => e.html.includes(`Amy Birch: ${EXT_2103}</p>`)), [true]);
	});
	await test("B3 a week the batch retries (Cy Tester, off the roster, worked it): attempt 1 bills Amy and tells no one; attempts 2-3 find her invoice there (INVOICE_EXISTS), and the final attempt's notice and email still name L-2103", async ({ eq, ok }) => {
		const t = await SCENARIOS.retried(M.SRC);
		eq("attempt 1: [submitted, failed, notices, emails]", [t.first.marker.submitted, t.first.marker.failed, t.first.notices, t.first.emails], [1, 1, 0, 0]);
		eq("attempt 3: [attempts, submitted, skipped, failed]", [t.marker.attempts, t.marker.submitted, t.marker.skipped, t.marker.failed], [3, 0, 1, 1]);
		ok("its summary names L-2103 beside the unbilled driver", t.summary.includes("WORKED-BUT-UNBILLED (cy tester)") && t.summary.includes(`(Amy Birch: ${EXT_2103})`), t.summary);
		eq("one notice and one email in all, both naming L-2103", [t.notices.map((n) => n.body.includes(EXT_2103)), t.emails.map((e) => e.html.includes(EXT_2103))], [[true], [true]]);
	});
	await test("B4 a kept line whose invoice is no longer Amy's live one is not named: her W49 Draft deleted and L-2103 cancelled before the batch", async ({ eq, ok }) => {
		const t = await SCENARIOS.stale(M.SRC);
		eq("the line was kept", t.kept.length, 1);
		ok("not named, and nobody is told", !/ARRIVAL/.test(t.summary) && t.notices.length === 0 && t.emails.length === 0, [t.summary, t.notices.length, t.emails.length]);
	});
}

// ── P16/P17 the three scripts ─────────────────────────────────────────────────
async function scriptCases(dropColumn) {
	let CW = null;
	let MW = null;
	try { CW = require("./correct-weekly-invoice"); } catch { CW = null; }
	try { MW = require("./create-missed-week-invoice-draft"); } catch { MW = null; }
	const quiet = { log() {}, info() {}, warn() {}, error() {} };
	// generate W49 under `genEnv`, submit it, take Dec 9 off, and plan the correction under `scriptEnv`.
	const correction = async (genEnv, scriptEnv, { after = null } = {}) => {
		const w = world(genEnv, [L.late()]);
		const g = await M.generate(w, AMY, W49);
		if (g.status !== 200) throw new Error(`generate: ${g.status}`);
		w.db.prepare("UPDATE invoices SET status = 'Submitted', submitted_at = '2026-12-12T01:05:00.000Z' WHERE id = ?").run(g.invoice.id);
		const db = new M.Database(w.db.serialize());
		db.prepare("INSERT INTO excluded_driver_days (driver_name, excluded_date, reason, excluded_by, excluded_at, action) VALUES (?, ?, 'test', 'super_admin', '2026-12-12 14:00:00', 'remove')").run(AMY.toLowerCase(), "2026-12-09");
		if (after) after({ db });
		const dataDir = M.tempDir();
		fs.mkdirSync(path.join(dataDir, "uploads", "invoices"), { recursive: true });
		const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(g.invoice.id);
		fs.writeFileSync(path.join(dataDir, "uploads", "invoices", row.pdf_file_name), "%PDF-1.4 made up\n");
		const api = CW.buildWorld({ db, env: scriptEnv, dataDir, render: async () => Buffer.from("%PDF-1.4 stub\n"), log: quiet, now: Date.parse("2026-12-14T15:00:00Z") }).api;
		try {
			return { out: CW.plan(db, api, { values: M.sheetValues(w.rows) }, { invoice: row.invoice_number, apply: false, expect: null }, { dataDir, dbFile: path.join(dataDir, "app.db"), clock: () => Date.now(), commit: () => "0".repeat(40) }), g };
		} catch (err) { return { err, g }; }
	};
	await test("P16a correct-weekly-invoice.js, the flag on as generate had it: the recompute pays generate's days (Dec 8-10), and taking Dec 9 off plans; with the flag off it refuses", async ({ eq, ok }) => {
		ok("the script loads", !!CW);
		const on = await correction(ON, ON);
		eq("on: generate paid", M.dayList(M.gridDays(on.g.data, W49)), DEC_8_10);
		eq("on: [state, removed, kept]", on.err ? on.err.message : [on.out.state, on.out.removed.map((x) => x.day), on.out.kept], ["plan", ["2026-12-09"], ["2026-12-08", "2026-12-10"]]);
		const mixed = await correction(ON, OFF);
		ok("generated on, recomputed off: refused (another day would change)", !!mixed.err && /recompute pays .*2026-12-07/.test(mixed.err.message), mixed.err ? mixed.err.message : mixed.out && mixed.out.state);
	});
	await test("P17b correct-weekly-invoice.js with the flag on and a history it can't read: refused", async ({ ok }) => {
		const r = await correction(ON, ON, { after: ({ db }) => db.exec("ALTER TABLE load_status_history DROP COLUMN actor_role") });
		ok("refused, naming the status history", !!r.err && /status history could not be read/.test(r.err.message), r.err ? r.err.message : "no refusal");
	});

	const JO = "Jo Tester";
	const missedLoad = () => ({
		row: loadRow({ id: "M-2201", driver: JO, pickup: "2026-12-03 8:00", dropoff: "2026-12-03 17:00", assigned: "2026-12-01", done: "2026-12-05", truck: "T2" }),
		history: tripEvents("M-2201", { dispatchAt: "2026-12-01 15:00:00", headingAt: "2026-12-02 12:00:00", arrival: { ...geoEv("M-2201", "2026-12-02 14:01:00", "2026-12-02 14:00:00"), actor: JO },
			loadingAt: "2026-12-03 15:00:00", receiverAt: "2026-12-05 15:00:00", deliveredAt: "2026-12-05 18:00:00" }),
	});
	const missedWorld = (env, { pings = null, after = null } = {}) => {
		const w = world(env, [missedLoad()], {
			drivers: [{ name: JO, payDaily: 280 }],
			world: { trucks: [{ unit: "T1", driver: AMY }, { unit: "T2", driver: JO, vid: pings ? "V2" : null }], ...(pings ? { pings: { V2: pings } } : {}) },
			after,
		});
		w.db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (7, 'jtester', 'x', 'Driver', ?)").run(JO);
		return w;
	};
	const missed = async (w, env, day) => {
		const api = MW.buildWorld({ db: w.db, env, dataDir: M.tempDir(), render: async () => Buffer.from("%PDF-1.4 stub\n"), log: quiet }).api;
		try {
			return { out: await MW.run(w.db, api, { values: M.sheetValues(w.rows) }, { driver: JO, weekStart: "2026-11-28", weekEnd: W48, days: [day], date: "2026-12-12", loads: null, dryRun: true }, { today: "2026-12-14" }) };
		} catch (err) { return { err }; }
	};
	const parkedDec2 = () => M.feed(3000).park("2026-12-02").drive("2026-12-03", { miles: 300 }).drive("2026-12-04", { miles: 200 }).drive("2026-12-05", { miles: 150 }).pings;
	await test("P16b the missed-week draft, flag on: Wed Dec 2, a day only the arrival window of M-2201 (billed the next week) covers, is drafted; off it is refused, no window covering it", async ({ eq, ok }) => {
		ok("the script loads", !!MW);
		const on = await missed(missedWorld(ON), ON, "2026-12-02");
		eq("on (a dry run): [state, days, loads]", on.err ? on.err.message : [on.out.state, on.out.plan.perDay.map((p) => [p.day, p.loads.map((l) => l.loadId)])], ["draft", [["2026-12-02", ["M-2201"]]]]);
		const off = await missed(missedWorld(OFF), OFF, "2026-12-02");
		ok("off: refused, no window covers it", !!off.err && /no load billed in another week has a pay window covering it/.test(off.err.message), off.err ? off.err.message : "drafted");
	});
	await test("P16c the missed-week draft's refusal text reads the window generate pays: the truck parked on Dec 2 (flag on) names M-2201's arrival window and the ELD", async ({ ok }) => {
		const r = await missed(missedWorld(ON, { pings: parkedDec2() }), ON, "2026-12-02");
		ok("refused: the pay window of M-2201 covers it, but the ELD shows the truck parked", !!r.err && /the pay window of M-2201 covers it, but the rules drop it: ELD parked/.test(r.err.message), r.err ? r.err.message : "drafted");
	});
	await test("P17c the missed-week draft with the flag on and a history it can't read: refused", async ({ ok }) => {
		const r = await missed(missedWorld(ON, { after: dropColumn }), ON, "2026-12-02");
		ok("refused, naming the status history", !!r.err && /status history could not be read/.test(r.err.message), r.err ? r.err.message : "drafted");
	});
	await test("P16d/P17d blank-pickup-dry-run.js with the flag on in its settings: the arrival line, and the loads whose history it could not read", async ({ eq, ok }) => {
		const readable = world({}, [L.late()]);
		const unreadable = world({}, [L.late()], { after: dropColumn });
		const run = (w) => {
			const copy = M.saveCopy(w, ON);
			return M.runScript("scripts/blank-pickup-dry-run.js", [`--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`, "--ledger-from=2026-12"]);
		};
		const a = run(readable);
		const b = run(unreadable);
		eq("[exit codes]", [a.code, b.code], [0, 0]);
		ok("readable: the rule's line and none unread", /ARRIVAL_PICKUP_DATE is on from 2026-11-20/.test(a.stdout) && /Arrival not read \(status history unreadable; each paid its scheduled window\): none\./.test(a.stdout), a.stdout.slice(-600) + a.stderr.slice(0, 300));
		ok("unreadable: L-2101 listed", /Arrival not read [^\n]*: L-2101 \(the status history could not be read/.test(b.stdout), b.stdout.slice(-600) + b.stderr.slice(0, 300));
	});
}

// ── M mutants, each caught by the case it names ───────────────────────────────
async function mutants() {
	const FC = "lib/financials-calc.js";
	const LPD = "lib/load-pay-days.js";
	const AP = "lib/arrival-pickup.js";
	await test("M1 the ledger ignores the arrival: P1's paths disagree", async ({ ok }) => {
		const p = await withLibs([[FC, replace("const arrival = !trip && arrivalRule &&", "const arrival = !trip && null && arrivalRule &&")]], async () => paths(world(ON, [L.late()])));
		ok("caught: the ledger pays Dec 7-9 while the invoice pays Dec 8-10", JSON.stringify(p.ledger) !== JSON.stringify(p.invoice), three(p));
	});
	await test("M2 the window ends at the drop-off, D11b (b): P3b's last day drops on all three", async ({ ok }) => {
		const p = await withLibs([[LPD, replace("const ends = [localDayKey(dropoff), arrivalPickup.dayKeyOf(arrival.delivered)]", "const ends = [localDayKey(dropoff)]")], [FC, null]], async () => paths(world(ON, [L.late()])));
		ok("caught: Dec 8-9 instead of Dec 8-10", JSON.stringify(three(p)) !== JSON.stringify([DEC_8_10, DEC_8_10, DEC_8_10]), three(p));
	});
	await test("M3 the ledger's end from the Status Update Date (N1): the re-stamped day pays", async ({ ok }) => {
		const x = L.late();
		x.row["Status Update Date"] = "12/11/2026 9:15";
		x.row["Completion Date"] = "12/11/2026";
		const p = await withLibs([[FC, replace("loadPayDays.payWindow({ dropoff, arrival })", "loadPayDays.payWindow({ dropoff: r.completionDate || dropoff, arrival })")]], async () => paths(world(ON, [x])));
		ok("caught: the ledger pays Dec 11", p.ledger.includes("2026-12-11"), p.ledger);
	});
	await test("M4 the arrival paid ahead of the trip rule (P9): the drive day Mon Dec 7 drops from the ledger", async ({ ok }) => {
		const p = await withLibs([[FC, (t) => t
			.replace("const arrival = !trip && arrivalRule &&", "const arrival = arrivalRule &&")
			.replace("const win = trip ? null : ((arrival && arrival.start && loadPayDays.payWindow({ dropoff, arrival })) || window);", "const win = (arrival && arrival.start && loadPayDays.payWindow({ dropoff, arrival })) || (trip ? null : window);")
			.replace("load: { loadId: r.loadId, vid, settleMonth: assignedMonthKey || \"\" }, preDispatch, tripDays: trip,", "load: { loadId: r.loadId, vid, settleMonth: assignedMonthKey || \"\" }, preDispatch, tripDays: win && win.fromArrival ? null : trip,")]],
		async () => paths(world({ ...ON, TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-11" }, [{
			row: loadRow({ id: "L-2109", driver: AMY, pickup: "2026-12-08 8:00", dropoff: "2026-12-09 17:00", assigned: "2026-12-04", done: "2026-12-09", truck: "T1" }),
			history: tripEvents("L-2109", { dispatchAt: "2026-12-04 15:00:00", headingAt: "2026-12-07 13:00:00", arrival: geoEv("L-2109", "2026-12-08 14:01:00", "2026-12-08 14:00:00"),
				loadingAt: "2026-12-08 15:00:00", receiverAt: "2026-12-09 15:00:00", deliveredAt: "2026-12-09 18:00:00" }),
		}], { world: { trucks: [{ unit: "T1", driver: AMY, vid: "V1" }], pings: { V1: M.feed(1000).drive("2026-12-07", { miles: 280 }).drive("2026-12-08", { miles: 120 }).drive("2026-12-09", { miles: 300 }).pings } } })));
		ok("caught: the ledger no longer pays Dec 7", !p.ledger.includes("2026-12-07"), p.ledger);
	});
	await test("M5 the gate without the arrival cover (P10): removing Dec 2 goes through", async ({ ok }) => {
		const from = "const arrivalCover = action !== \"add\" && jobTracking ? arrivalDayLockCover(jobTracking.headers) : null;";
		ok("(anchor)", M.SRC.includes(from));
		const src = M.SRC.replace(from, "const arrivalCover = null;");
		const w = world(ON, [{
			row: loadRow({ id: "L-2110", driver: AMY, pickup: "2026-12-03 8:00", dropoff: "2026-12-04 17:00", assigned: "2026-11-28", done: "2026-12-04", truck: "T1" }),
			history: tripEvents("L-2110", { dispatchAt: "2026-11-28 15:00:00", headingAt: "2026-12-02 15:00:00", arrival: tapEv("L-2110", "2026-12-02 20:00:00"), loadingAt: "2026-12-03 15:00:00", receiverAt: "2026-12-04 15:00:00", deliveredAt: "2026-12-04 20:00:00" }),
		}], { world: { locks: ["2026-11"] } });
		const post = await overrideRoutes(w, ON, src)("POST /api/admin/excluded-days", { body: { driverName: AMY, date: "2026-12-02", action: "remove", reason: "test" } });
		ok("caught: 200", post.status === 200, post);
	});
	await test("M6 the percentage check dropped from the ledger (P12): the driver's December loses its days", async ({ ok }) => {
		const p = await withLibs([[FC, replace("const arrival = !trip && arrivalRule && (payStructures[driver] || {}).payType !== \"percentage\"", "const arrival = !trip && arrivalRule")]], async () => paths(world(ON, [{
			row: loadRow({ id: "L-2112", driver: BO, pickup: "2026-12-07 8:00", dropoff: "2026-12-09 17:00", assigned: "2026-12-04", done: "2026-12-11", truck: "T2" }),
			history: tripEvents("L-2112", { dispatchAt: "2026-12-04 15:00:00", headingAt: "2026-12-10 12:00:00", arrival: { ...geoEv("L-2112", "2026-12-10 14:01:00", "2026-12-10 14:00:00"), actor: BO }, loadingAt: "2026-12-10 16:00:00", receiverAt: "2026-12-11 15:00:00", deliveredAt: "2026-12-11 18:00:00" }),
		}], { drivers: [{ name: BO, payType: "percentage", payPct: 30 }], world: { trucks: [{ unit: "T1", driver: AMY }, { unit: "T2", driver: BO, vid: "V2" }], pings: { V2: M.feed(2000).drive("2026-12-07", { miles: 200 }).drive("2026-12-08", { miles: 250 }).drive("2026-12-09", { miles: 180 }).park("2026-12-10").park("2026-12-11").pings } } }), { driver: BO }));
		ok("caught: no paid December for him", !p.ledgerPay.some((x) => x.month === "2026-12" && x.days === 3), p.ledgerPay);
	});
	await test("M7 the invoice's arrival warnings dropped (P3, P17): no extension or not-read line", async ({ ok }) => {
		const p = await withLibs([[AP, replace("\tif (!notes) return [];", "\treturn [];")], [LPD, null], [FC, null]], async () => paths(world(ON, [L.afterDropoff()])));
		ok("caught: no ARRIVAL line", arrivalLines(p).length === 0, arrivalLines(p));
	});
	await test("M8 the missed-week refusal reads the cells only (P16c): it says no window covers Dec 2", async ({ ok }) => {
		if (!fs.existsSync(path.join(__dirname, "create-missed-week-invoice-draft.js"))) { ok("the script exists", false); return; }
		const file = path.join(__dirname, "create-missed-week-invoice-draft.js");
		const from = "if (paidWin && paidWin.arrival && paidWin.arrival.start && paidWin.win) {";
		const text = fs.readFileSync(file, "utf8");
		ok("(anchor)", text.includes(from));
		const mod = new Module(file, null);
		mod.filename = file;
		mod.paths = Module._nodeModulePaths(path.dirname(file));
		mod._compile(text.replace(from, "if (false) {"), file);
		const JO = "Jo Tester";
		const w = world(ON, [{
			row: loadRow({ id: "M-2201", driver: JO, pickup: "2026-12-03 8:00", dropoff: "2026-12-03 17:00", assigned: "2026-12-01", done: "2026-12-05", truck: "T2" }),
			history: tripEvents("M-2201", { dispatchAt: "2026-12-01 15:00:00", headingAt: "2026-12-02 12:00:00", arrival: { ...geoEv("M-2201", "2026-12-02 14:01:00", "2026-12-02 14:00:00"), actor: JO }, loadingAt: "2026-12-03 15:00:00", receiverAt: "2026-12-05 15:00:00", deliveredAt: "2026-12-05 18:00:00" }),
		}], { drivers: [{ name: JO, payDaily: 280 }], world: { trucks: [{ unit: "T1", driver: AMY }, { unit: "T2", driver: JO, vid: "V2" }], pings: { V2: M.feed(3000).park("2026-12-02").drive("2026-12-03", { miles: 300 }).drive("2026-12-04", { miles: 200 }).drive("2026-12-05", { miles: 150 }).pings } } });
		w.db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (7, 'jtester', 'x', 'Driver', ?)").run(JO);
		const api = mod.exports.buildWorld({ db: w.db, env: ON, dataDir: M.tempDir(), render: async () => Buffer.from("%PDF stub"), log: { log() {}, info() {}, warn() {}, error() {} } }).api;
		let err = null;
		try { await mod.exports.run(w.db, api, { values: M.sheetValues(w.rows) }, { driver: JO, weekStart: "2026-11-28", weekEnd: W48, days: ["2026-12-02"], date: "2026-12-12", loads: null, dryRun: true }, { today: "2026-12-14" }); } catch (e) { err = e; }
		ok("caught: the text says no window covers it", !!err && /no load billed in another week has a pay window covering it/.test(err.message), err ? err.message : "drafted");
	});

	// The Friday batch's mutants, each a copy of server.js with one change.
	const mutated = (from, to) => {
		if (M.SRC.split(from).length !== 2) throw new Error(`the mutant's anchor is not in server.js exactly once: ${JSON.stringify(from.slice(0, 70))}`);
		return M.SRC.replace(from, to);
	};
	const READ = "const arrivalLines = loadPayDays.arrivalPickup.ruleFromEnv(process.env)\n\t\t? loadPayDays.arrivalPickup.weekLines(";
	const KEEP = "if (arrival) {\n\t\t\ttry {\n\t\t\t\tloadPayDays.arrivalPickup.recordWeekLines(";
	const LIVE = "(e) => liveWeeklyInvoicesForDriverWeek(e.driver, range.weekStart).some((r) => r.id === e.invoiceId)";
	const START = "async function runWeeklyInvoiceBatch(weekEnd, attemptNum) {\n\tconst range = getWeekRange(weekEnd);";
	const b1 = (src) => batchRun(world(ON, [L.late(), L.afterDropoff(), L.twoDays()]), ON, { src });
	await test("MB1 the batch reads no kept line (B1): its summary names no extension", async ({ ok }) => {
		const p = await b1(mutated(READ, READ.replace("ruleFromEnv(process.env)", "ruleFromEnv(process.env) && false")));
		ok("caught: no ARRIVAL line", !p.summary.includes("ARRIVAL") && !p.emails.some((e) => e.html.includes(EXT_2103)), p.summary);
	});
	await test("MB2 generate keeps no line (B1): the batch names nothing", async ({ ok }) => {
		const p = await b1(mutated(KEEP, KEEP.replace("if (arrival) {", "if (false) {")));
		ok("caught: no ARRIVAL line", !p.summary.includes("ARRIVAL"), p.summary);
	});
	await test("MB3 lines kept only when the batch itself generates, as the batch reading its own responses would (B2): the driver's submitted invoice goes unnamed", async ({ ok }) => {
		const t = await SCENARIOS.ownSubmitted(mutated(KEEP, KEEP.replace("if (arrival) {", "if (arrival && user.username === \"auto-invoice\") {")));
		ok("caught: no ARRIVAL line, and nobody is told", !t.summary.includes("ARRIVAL") && t.notices.length === 0, [t.summary, t.notices.length]);
	});
	await test("MB4 the live check dropped (B4): the deleted Draft's line is named", async ({ ok }) => {
		const t = await SCENARIOS.stale(mutated(LIVE, "() => true"));
		ok("caught: named", t.summary.includes(EXT_2103), t.summary);
	});
	await test("MB5 the lines don't make the run ACTION NEEDED (B2): with nothing submitted, no notice or email goes out", async ({ ok }) => {
		const t = await SCENARIOS.ownSubmitted(mutated(" || closedWeekDraft.length > 0 || arrivalLines.length > 0;", " || closedWeekDraft.length > 0;"));
		ok("caught: no notice, no email", t.notices.length === 0 && t.emails.length === 0, [t.notices.length, t.emails.length]);
	});
	await test("MB6 the batch reads only what its own attempt generated (B3): the final attempt names nothing", async ({ ok }) => {
		const t = await SCENARIOS.retried(mutated(START, `${START}\n\tdb.prepare("DELETE FROM server_state WHERE substr(key, 1, 21) = 'arrival_pickup_lines:'").run();`));
		ok("caught: the final notice names no extension", !t.notices.some((n) => n.body.includes(EXT_2103)), t.notices.map((n) => n.body));
	});
}

// ── §Z the window cases under each process zone ───────────────────────────────
async function zones() {
	for (const zone of ZONES) {
		await test(`Z the window cases (P1-P4, T1) and B1 under TZ=${zone}`, ({ ok }) => {
			const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, TZ: zone, ARRIVAL_PAY_PATHS_TZ_CHILD: "1" }, encoding: "utf8", timeout: 120000 });
			ok(String(r.stdout || "").trim().split("\n").pop(), r.status === 0, `${String(r.stdout || "").trim()}\n${String(r.stderr || "").slice(0, 1500)}`);
		});
	}
}

(async () => {
	if (CAPTURE) {
		const answers = await flagOffAnswers(OFF);
		fs.writeFileSync(CAPTURE, `${JSON.stringify({ note: "Captured on the base's own server.js by scripts/test-arrival-pickup-pay-paths.js --capture; made-up data.", answers }, null, 1)}\n`);
		console.log(`captured ${CAPTURE}`);
		M.cleanup();
		return;
	}
	await cases();
	if (!CHILD) {
		await moreCases();
		await mutants();
		await zones();
	}
	R.finish();
})();
