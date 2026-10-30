#!/usr/bin/env node
// GET /api/admin/cancelled-loads, the Super Admin "Cancelled loads" list, run as
// server.js registers it (lifted through scripts/lib/server-source.js and
// server-lift.js) over a made-up sheet and a read-only SQLite.
//
//   §1  the role gate: 401 without a session; Dispatcher, Driver, Investor 403,
//       flag on and off; neither the sheet nor SQLite is read
//   §2  the flag off: a Super Admin gets 404 FEATURE_OFF before any read
//   §3  which loads: cancelled in the deduplicated view only (the money filter's
//       parity), the bottom copy, "also deleted"
//   §4  which record, through the route's own reads
//   §5  times and Eastern days
//   §6  the shared login
//   §7  Load IDs: every one through shownLoadId(req, ...); as stored for a Super Admin
//   §8  the rate con: #570's gate object and its sentences, no file reference
//   §9  view only: one GET; no write to SQLite, the sheet, the cache or the audit log
//   §10 failures: 503 SHEET_UNREADABLE or RECORDS_UNREADABLE, never a page of
//       blanks; 500 for anything else
//   §11 parameterized SQL only, and a mutant that re-admits Dispatcher is caught
//
// Made-up data only. A base run: SERVER_ROOT=<a checkout> reads its server.js and lib/.
//   node scripts/test-cancelled-loads-route.js      # exits 1 on any failure
"use strict";

// Before lib/app-time.js is first read: the business zone the route's days are in.
process.env.APP_TIMEZONE = "America/New_York";

const path = require("path");
const { serverSource } = require("./lib/server-source");
const { closure } = require("./lib/server-lift");

const HERE = path.join(__dirname, "..");
const ROOT = process.env.SERVER_ROOT ? path.resolve(process.env.SERVER_ROOT) : HERE;
const Database = require(path.join(HERE, "node_modules", "better-sqlite3"));
const { viewerGate, MESSAGES } = require(path.join(ROOT, "lib", "ratecon-pdf-route.js"));
const { fromSetting } = require(path.join(ROOT, "lib", "listed-accounts.js"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
// A section that throws (the route missing, a lift that fails) fails as a whole.
async function section(title, fn) {
	console.log(`\n${title}`);
	try {
		await fn();
	} catch (err) {
		failures.push(`${title}\n      threw: ${String(err && err.message).split("\n")[0]}`);
	}
}

const SRC = serverSource();
const ROUTE_PATH = "/api/admin/cancelled-loads";
const HEAD = `app.get("${ROUTE_PATH}", requireRole("Super Admin"), async (req, res) => {`;
const OFF = { error: "The cancelled loads list is switched off on this server.", code: "FEATURE_OFF" };
// Nothing that writes, sends or reaches Google may come along with the route.
const DENIED = ["getSheets", "sheets", "SPREADSHEET_ID", "io", "server", "jtCacheInvalidate", "sendEmail", "transporter", "getDrive",
	"logAudit", "logAuditRefusal", "recordStatusChange", "insertDispatchNotification", "insertNotification", "notifyChange"];
const libRequire = (m) => {
	if (!/^\.\/lib\/[\w.-]+$/.test(m)) throw new Error(`lifted code required ${m}, which this runner does not load`);
	return require(path.join(ROOT, m));
};

// parseSheet(), deduplicateLoads(), excludeDroppedLoads() and CANCELED_STATUS_RE as the server runs them.
function liftHelpers() {
	const names = ["parseSheet", "deduplicateLoads", "excludeDroppedLoads", "CANCELED_STATUS_RE"];
	const lifted = closure(SRC, { roots: names, provided: ["require", "getDeletedLoadIds"], denied: ["db", "app", "io", "server", "getSheets"] });
	const noDeletedRead = () => { throw new Error("the runner passes its own deleted set"); };
	return new Function("require", "getDeletedLoadIds", `"use strict";\n${lifted.text}\nreturn { ${names.join(", ")} };`)(libRequire, noDeletedRead);
}
const H = liftHelpers();

// ── the made-up sheet, frozen as the shared cache would be ───────────────────
const HEADERS = ["Load ID", "Job Status", "Driver", "Pickup Address", "Drop-off Address", "Pickup Appointment", "Status Update Date"];
const R = (id, status, driver = "") => [id, status, driver, "1 Made-up Way, Peoria, IL 61602", "2 Made-up Ave, Gary, IN 46402", "10/18/2026 08:00", "10/18/2026 09:00:00"];
const ROWS = [
	R("LD-RTE-0001", "Cancelled"), // 2: Cancel button with a reason
	R("LD-RTE-0002", "canceled"), // 3: Cancel button before reasons, the shared login
	R("LD-RTE-0003", " CANCEL "), // 4: status override
	R("LD-RTE-0004", "Cancelled", "Made-up Driver D"), // 5: driver status screen with its audit row
	R("LD-RTE-0005", "Cancelled", "Made-up Driver E"), // 6: a manual history row alone
	R("LD-RTE-0006", "Cancelled"), // 7: no record
	R("LD-RTE-0007", "Cancelled"), // 8: re-dispatched after its cancel
	R("LD-RTE-0008", "Cancelled"), // 9: an audit-only cancel
	R("LD-RTE-0009", "Cancelled"), // 10: twins 59 s apart
	R("LD-RTE-0010", "Cancelled"), // 11: 61 s apart
	R("LD-RTE-0011", "Cancelled"), // 12: a later audit row that doesn't parse
	R("LD-RTE-0012", "Dispatched", "Made-up Driver F"), // 13: live, with an old cancel record
	R("LD-RTE-0013", "Dispatched"), // 14: an earlier copy
	R("#LD-RTE-0013", "Cancelled"), // 15: the bottom copy wins
	R("LD-RTE-0014", "Cancelled"), // 16: also soft-deleted
	R("LD-RTE-0015", "Cancelled"), // 17: 11:30 PM EDT Oct 30
	R("LD-RTE-0016", "Cancelled"), // 18: 1:30 AM EDT Nov 1
	R("LD-RTE-0017", "Cancelled"), // 19: 1:30 AM EST Nov 1
	R("LD-RTE-0018", "Cancelled"), // 20: history at 2026-10-29 18:05:00, " Super_Admin "
	R("LD-RTE-0019", "Delivered"), // 21
];
function deepFreeze(o) {
	if (o && typeof o === "object" && !Object.isFrozen(o)) {
		Object.freeze(o);
		for (const v of Object.values(o)) deepFreeze(v);
	}
	return o;
}
const PARSED = H.parseSheet({ values: [HEADERS, ...ROWS] });
const JT = deepFreeze({ headers: PARSED.headers, data: H.deduplicateLoads(PARSED.data, PARSED.headers) });

// ── the read-only SQLite ──────────────────────────────────────────────────────
const REAL = new Database(":memory:");
REAL.exec(`
	CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '', new_status TEXT NOT NULL,
		source TEXT NOT NULL DEFAULT 'manual', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP, reason TEXT DEFAULT '');
	CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL,
		role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
	CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, row_index INTEGER DEFAULT 0, deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_by TEXT DEFAULT '');
	CREATE TABLE load_coordinates (load_id TEXT PRIMARY KEY, pickup_address TEXT DEFAULT '', dropoff_address TEXT DEFAULT '');
`);
{
	const h = REAL.prepare("INSERT INTO load_status_history (load_id, new_status, source, actor, changed_at, reason) VALUES (?, ?, ?, ?, ?, ?)");
	h.run("ld-rte-0001", "Cancelled", "cancel", "made-up-admin", "2026-10-20 14:00:00", "Broker called it off (made-up)");
	h.run("ld-rte-0002", "Cancelled", "cancel", "super_admin", "2026-07-01 15:00:00", "");
	h.run("ld-rte-0003", "Cancelled", "override", "made-up-dispatcher", "2026-07-02 16:00:00", "");
	h.run("ld-rte-0004", "Cancelled", "manual", "Made-up Driver D", "2026-07-03 17:00:00", "");
	h.run("ld-rte-0005", "Cancelled", "manual", "Made-up Driver E", "2026-07-04 18:00:00", "");
	h.run("ld-rte-0007", "Cancelled", "cancel", "made-up-admin", "2026-09-01 12:00:00", "First cancel (made-up)");
	h.run("ld-rte-0007", "Dispatched", "dispatch", "made-up-dispatcher", "2026-09-02 12:00:00", "");
	h.run("ld-rte-0009", "Cancelled", "cancel", "made-up-admin", "2026-09-04 10:00:00", "History reason 0009 (made-up)");
	h.run("ld-rte-0010", "Cancelled", "cancel", "made-up-admin", "2026-09-05 10:00:00", "History reason 0010 (made-up)");
	h.run("ld-rte-0011", "Cancelled", "cancel", "made-up-admin", "2026-09-06 10:00:00", "Reason 0011 (made-up)");
	h.run("ld-rte-0012", "Cancelled", "cancel", "made-up-admin", "2026-08-10 10:00:00", "Old cancel (made-up)");
	h.run("ld-rte-0014", "Cancelled", "cancel", "made-up-admin", "2026-08-11 10:00:00", "Reason 0014 (made-up)");
	h.run("ld-rte-0015", "Cancelled", "cancel", "made-up-admin", "2026-10-31 03:30:00", "");
	h.run("ld-rte-0016", "Cancelled", "cancel", "made-up-admin", "2026-11-01 05:30:00", "");
	h.run("ld-rte-0017", "Cancelled", "cancel", "made-up-admin", "2026-11-01 06:30:00", "");
	h.run("ld-rte-0018", "Cancelled", "cancel", " Super_Admin ", "2026-10-29 18:05:00", "");
	const a = REAL.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 7, ?, ?, ?, ?, ?, ?)");
	a.run("2026-10-20T14:00:00.400Z", "made-up-admin", "Super Admin", "cancel_load", "load", "LD-RTE-0001", "Cancelled load LD-RTE-0001 (driver: Made-up Driver A) — reason: Broker called it off (made-up)");
	a.run("2026-07-02T15:59:59.800Z", "made-up-dispatcher", "Dispatcher", "status_override", "load", "LD-RTE-0003", "Override \"Dispatched\" → \"Cancelled\" by made-up-dispatcher: Shipper closed for the week (made-up)");
	a.run("2026-07-03T16:59:59.500Z", "made-up-dispatcher", "Dispatcher", "update_status", "load", "LD-RTE-0004", "Status changed to \"Cancelled\" for load LD-RTE-0004 (driver: Made-up Driver D)");
	a.run("2026-09-01T12:00:00.300Z", "made-up-admin", "Super Admin", "cancel_load", "load", "LD-RTE-0007", "Cancelled load LD-RTE-0007 — reason: First cancel (made-up)");
	a.run("2026-09-02T12:00:00.200Z", "made-up-dispatcher", "Dispatcher", "dispatch_load", "load", "LD-RTE-0007", "Assigned driver Made-up Driver G to load LD-RTE-0007");
	a.run("2026-09-03T13:14:15.678Z", "made-up-admin", "Super Admin", "cancel_load", "load", "#LD-RTE-0008", "Cancelled load #LD-RTE-0008 — reason: Duplicate of another load (made-up)");
	a.run("2026-09-04T10:00:59.000Z", "made-up-admin-2", "Super Admin", "cancel_load", "load", "LD-RTE-0009", "Cancelled load LD-RTE-0009 — reason: Audit reason 0009 (made-up)");
	a.run("2026-09-05T10:01:01.000Z", "made-up-admin-2", "Super Admin", "cancel_load", "load", "LD-RTE-0010", "Cancelled load LD-RTE-0010 — reason: Audit reason 0010 (made-up)");
	a.run("2026-09-06T10:00:00.250Z", "made-up-admin", "Super Admin", "cancel_load", "load", "LD-RTE-0011", "Cancelled load LD-RTE-0011 — reason: Reason 0011 (made-up)");
	a.run("2026-09-06T12:00:00.000Z", "made-up-dispatcher", "Dispatcher", "status_override", "load", "LD-RTE-0011", "Override of an unexpected shape (made-up)");
	a.run("2026-09-07T10:00:00.000Z", "made-up-admin", "Super Admin", "cancel_load", "sheet_row", "LD-RTE-0006", "Another entity (made-up)");
	REAL.prepare("INSERT INTO deleted_loads (load_id, deleted_by) VALUES (?, ?)").run("#ld-rte-0014", "made-up-admin");
	REAL.prepare("INSERT INTO load_coordinates (load_id, pickup_address, dropoff_address) VALUES (?, ?, ?)").run("ld-rte-0001", "100 Made-up Rd, Springfield, IL 62701", "");
}
REAL.pragma("query_only = ON");
const prepared = [];
let failSql = null;
const DB = {
	prepare(sql) {
		prepared.push(String(sql));
		if (failSql && failSql.test(sql)) throw new Error("made-up table outage");
		return REAL.prepare(sql);
	},
};

// ── the stubs ─────────────────────────────────────────────────────────────────
let sheetCalls = 0;
let sheetFail = false;
const getJobTrackingCached = async () => {
	sheetCalls++;
	if (sheetFail) throw new Error("made-up sheet outage");
	return JT;
};
const quiet = { warn() {}, error() {} };
let gateNow = null;
const setGate = (raw) => { gateNow = viewerGate(fromSetting("RATECON_PDF_VIEWER_IDS", raw, quiet)); };
setGate(undefined);
// The route is handed one gate object for good; which list it reads changes per case.
const GATE = { refusal: (user) => gateNow.refusal(user) };

function buildWorld({ env = { CANCELLED_LOADS_PAGE_ENABLED: "true" }, src = SRC, head = HEAD, shower = null } = {}) {
	const extra = shower ? { shownLoadId: shower.shownLoadId, routeShownLoadIdIndex: shower.routeShownLoadIdIndex } : {};
	const provided = ["app", "db", "process", "require", "getJobTrackingCached", "rateconViewGate", ...Object.keys(extra)];
	const lifted = closure(src, { routes: [head], provided, denied: DENIED });
	const registered = [];
	const app = {};
	for (const m of ["get", "post", "put", "patch", "delete", "use", "all"]) app[m] = (p, ...h) => { registered.push({ method: m.toUpperCase(), path: p, handlers: h }); };
	const scope = { app, db: DB, process: { env: { ...env } }, require: libRequire, getJobTrackingCached, rateconViewGate: GATE, ...extra };
	new Function(...Object.keys(scope), `"use strict";\n${lifted.text}`)(...Object.values(scope));
	return { registered, text: lifted.text };
}

const SA = { id: 7, username: "made-up-admin", role: "Super Admin" };
const SA_LISTED = { id: 9, username: "made-up-owner", role: "Super Admin" };
const SHARED = { id: 1, username: "super_admin", role: "Super Admin" };
const SA_NO_ID = { username: "made-up-admin", role: "Super Admin" };
const DISPATCHER = { id: 11, username: "made-up-dispatcher", role: "Dispatcher" };
const DRIVER = { id: 12, username: "made-up-driver", role: "Driver", driverName: "Made-up Driver A" };
const INVESTOR = { id: 13, username: "made-up-investor", role: "Investor" };

async function call(world, user) {
	const reg = world.registered.find((r) => r.method === "GET" && r.path === ROUTE_PATH);
	if (!reg) throw new Error(`GET ${ROUTE_PATH} is not registered`);
	const req = { method: "GET", path: ROUTE_PATH, url: ROUTE_PATH, originalUrl: ROUTE_PATH, route: { path: ROUTE_PATH }, headers: {}, session: user ? { user } : {} };
	const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
	for (const handler of reg.handlers) {
		let advanced = false;
		await handler(req, res, () => { advanced = true; });
		if (!advanced) break;
	}
	return { status: res.statusCode, body: res.body };
}
// The route logs what it refused; the runner keeps those lines out of its output.
async function quietly(fn) {
	const saved = console.error;
	console.error = () => {};
	try { return await fn(); } finally { console.error = saved; }
}
const byId = (loads) => new Map((loads || []).map((l) => [l.hasLoadId ? l.loadId : `(row ${l.rowIndex})`, l]));
const pick = (row, keys) => (row ? Object.fromEntries(keys.map((k) => [k, row[k]])) : null);
const WHO = ["recordedBy", "cancelledAt", "cancelledBy", "cancelledByRole", "reason"];
const BLANK = (recordedBy) => ({ recordedBy, cancelledAt: "", cancelledBy: "", cancelledByRole: "", reason: "" });
const ROUTE_TEXT = (() => {
	const at = SRC.indexOf(`\n${HEAD}`);
	return at === -1 ? "" : SRC.slice(at + 1, SRC.indexOf("\n});\n", at + 1) + 4);
})();

let ON = null;
let OFF_WORLD = null;
let main = null;

(async () => {
	await section("§1  the role gate", async () => {
		ON = buildWorld();
		OFF_WORLD = buildWorld({ env: {} });
		for (const [label, world] of [["flag on", ON], ["flag off", OFF_WORLD]]) {
			const before = { sheet: sheetCalls, sql: prepared.length };
			const anon = await call(world, null);
			eq([anon.status, anon.body && anon.body.error], [401, "Not authenticated"], `§1 ${label}: no session is 401`);
			for (const user of [DISPATCHER, DRIVER, INVESTOR]) {
				const r = await call(world, user);
				eq([r.status, r.body && r.body.error], [403, "Forbidden"], `§1 ${label}: a ${user.role} is 403`);
			}
			eq([sheetCalls, prepared.length], [before.sheet, before.sql], `§1 ${label}: neither the sheet nor SQLite is read for a refused caller`);
		}
		ok(ON.registered.length === 1 && OFF_WORLD.registered.length === 1, "§1 the route registers whatever the flag");
	});

	await section("§2  the flag off", async () => {
		const before = { sheet: sheetCalls, sql: prepared.length };
		const r = await call(OFF_WORLD, SA);
		eq([r.status, r.body], [404, OFF], "§2 a Super Admin gets 404 FEATURE_OFF");
		eq([sheetCalls, prepared.length], [before.sheet, before.sql], "§2 ...before any sheet read or SQL");
		eq((await call(buildWorld({ env: { CANCELLED_LOADS_PAGE_ENABLED: "1" } }), SA)).status, 404, "§2 on only for exactly \"true\" (\"1\" is off)");
	});

	await section("§3  which loads", async () => {
		main = await call(ON, SA);
		eq(main.status, 200, "§3 a Super Admin gets the list");
		eq(Object.keys(main.body || {}).sort(), ["count", "loads", "rateCon"], "§3 the answer is { loads, count, rateCon }");
		const loads = main.body.loads;
		eq([main.body.count, loads.length], [17, 17], "§3 17 cancelled loads, and count says so");
		const live = H.excludeDroppedLoads(JT.data, JT.headers, new Set());
		const dropped = JT.data.filter((r) => !live.includes(r)).map((r) => r._rowIndex).sort((a, b) => a - b);
		eq(loads.map((l) => l.rowIndex).sort((a, b) => a - b), dropped, "§3 exactly the rows excludeDroppedLoads() drops for status");
		const m = byId(loads);
		ok(m.has("LD-RTE-0002") && m.has("LD-RTE-0003"), "§3 \"canceled\" and \" CANCEL \" count");
		ok(!m.has("LD-RTE-0012"), "§3 a live load with an old cancel record is not listed");
		ok(!m.has("LD-RTE-0019"), "§3 a delivered load is not listed");
		eq(pick(m.get("#LD-RTE-0013"), ["rowIndex", "recordedBy"]), { rowIndex: 15, recordedBy: "none" }, "§3 a load whose bottom copy is cancelled is listed");
		eq(loads.filter((l) => l.alsoDeleted).map((l) => l.loadId), ["LD-RTE-0014"], "§3 \"also deleted\" comes from deleted_loads");
		ok(/Springfield, IL/.test(m.get("LD-RTE-0001").pickup) && /Gary, IN/.test(m.get("LD-RTE-0001").dropoff),
			"§3 the route's cities come from resolveCityState(): the geocoded pickup, the sheet's drop-off");
		ok(/Peoria, IL/.test(m.get("LD-RTE-0006").pickup), "§3 ...and the sheet's pickup when nothing is geocoded");
		eq(m.get("LD-RTE-0006").pickupAt, "10/18/2026 08:00", "§3 the pickup appointment cell, as stored");
	});

	await section("§4  which record", async () => {
		const m = byId(main.body.loads);
		const got = (id) => pick(m.get(id), WHO);
		eq(got("LD-RTE-0001"), { recordedBy: "cancel-button", cancelledAt: "2026-10-20T14:00:00Z", cancelledBy: "made-up-admin", cancelledByRole: "Super Admin", reason: "Broker called it off (made-up)" },
			"§4 a Cancel button cancel with its reason");
		eq(m.get("LD-RTE-0001").driver, "Made-up Driver A", "§4 the driver recorded with the cancel");
		eq(got("LD-RTE-0002"), { recordedBy: "cancel-button", cancelledAt: "2026-07-01T15:00:00Z", cancelledBy: "super_admin", cancelledByRole: "", reason: "" },
			"§4 a Cancel button cancel before reasons were kept: time and account, reason blank");
		eq(got("LD-RTE-0003"), { recordedBy: "status-override", cancelledAt: "2026-07-02T16:00:00Z", cancelledBy: "made-up-dispatcher", cancelledByRole: "Dispatcher", reason: "Shipper closed for the week (made-up)" },
			"§4 a status override: the reason from the audit text");
		eq(got("LD-RTE-0004"), { recordedBy: "driver-status", cancelledAt: "2026-07-03T17:00:00Z", cancelledBy: "made-up-dispatcher", cancelledByRole: "Dispatcher", reason: "" },
			"§4 a driver status screen cancel with its update_status row: the account, no reason");
		eq(got("LD-RTE-0005"), { recordedBy: "driver-status", cancelledAt: "2026-07-04T18:00:00Z", cancelledBy: "", cancelledByRole: "", reason: "" },
			"§4 a manual history row without its audit row: the account is blank");
		eq(got("LD-RTE-0006"), BLANK("none"), "§4 no events: \"none\" (an audit row on another entity is not read)");
		eq(got("LD-RTE-0007"), BLANK("changed-after"), "§4 re-dispatched after the cancel: \"changed-after\"");
		eq(got("LD-RTE-0008"), { recordedBy: "cancel-button", cancelledAt: "2026-09-03T13:14:15Z", cancelledBy: "made-up-admin", cancelledByRole: "Super Admin", reason: "Duplicate of another load (made-up)" },
			"§4 an audit-only cancel_load, keyed by \"#\" + ID, is still shown");
		eq(pick(m.get("LD-RTE-0009"), ["cancelledAt", "cancelledBy", "reason"]), { cancelledAt: "2026-09-04T10:00:00Z", cancelledBy: "made-up-admin-2", reason: "History reason 0009 (made-up)" },
			"§4 twins 59 s apart merge");
		eq(pick(m.get("LD-RTE-0010"), ["cancelledAt", "cancelledBy", "reason"]), { cancelledAt: "2026-09-05T10:01:01Z", cancelledBy: "made-up-admin-2", reason: "Audit reason 0010 (made-up)" },
			"§4 61 s apart they don't");
		eq(got("LD-RTE-0011"), BLANK("changed-after"), "§4 an unparseable audit row later than the cancel: not recorded");
	});

	await section("§5  times and Eastern days", async () => {
		const m = byId(main.body.loads);
		eq(pick(m.get("LD-RTE-0015"), ["cancelledAt", "cancelledDay"]), { cancelledAt: "2026-10-31T03:30:00Z", cancelledDay: "2026-10-30" }, "§5 2026-10-31T03:30:00Z is Oct 30 in the business zone");
		eq(m.get("LD-RTE-0016").cancelledDay, "2026-11-01", "§5 2026-11-01T05:30:00Z (EDT) is Nov 1");
		eq(m.get("LD-RTE-0017").cancelledDay, "2026-11-01", "§5 2026-11-01T06:30:00Z (EST) is Nov 1");
		eq(m.get("LD-RTE-0018").cancelledAt, "2026-10-29T18:05:00Z", "§5 history changed_at 2026-10-29 18:05:00 is 2026-10-29T18:05:00Z");
	});

	await section("§6  the shared login", async () => {
		const m = byId(main.body.loads);
		eq(pick(m.get("LD-RTE-0018"), ["cancelledBy", "cancelledBySharedLogin"]), { cancelledBy: "Super_Admin", cancelledBySharedLogin: true }, "§6 \" Super_Admin \" is the shared login");
		eq(m.get("LD-RTE-0002").cancelledBySharedLogin, true, "§6 super_admin is the shared login");
		eq(m.get("LD-RTE-0001").cancelledBySharedLogin, false, "§6 a named account is not");
	});

	await section("§7  Load IDs", async () => {
		const m = byId(main.body.loads);
		ok(m.has("#LD-RTE-0013") && m.has("LD-RTE-0001"), "§7 as a Super Admin, each Load ID is as stored (the real shownLoadId())");
		const calls = [];
		const withholding = buildWorld({
			shower: {
				shownLoadId: (who, raw, opts) => { calls.push({ who, raw, opts }); return "Load (contact withheld)"; },
				routeShownLoadIdIndex: (jt) => ({ madeUpIndexOf: jt === JT }),
			},
		});
		const r = await call(withholding, SA);
		ok(r.status === 200 && r.body.loads.filter((l) => l.hasLoadId).every((l) => l.loadId === "Load (contact withheld)"), "§7 with a withholding shower, every Load ID is its text");
		ok(!/ld-rte/i.test(JSON.stringify(r.body)), "§7 ...and no raw ID appears anywhere in the answer");
		ok(calls.length === 17 && calls.every((c) => c.who && c.who.session && c.who.session.user === SA && c.opts && c.opts.row && c.opts.index && c.opts.index.madeUpIndexOf === true),
			"§7 the shower is given the request, the row and the route's own index for every load");
		ok(ROUTE_TEXT.includes("shownLoadId(req, raw, { row, index })"), "§7 the source names every load as shownLoadId(req, ...)");
	});

	await section("§8  the rate con", async () => {
		const rc = async (raw, user) => { setGate(raw); const r = await call(ON, user); setGate(undefined); return r.body && r.body.rateCon; };
		eq(await rc(undefined, SA), { canView: true, note: "" }, "§8 the setting unset: every Super Admin may view");
		eq(await rc("9", SA_LISTED), { canView: true, note: "" }, "§8 a listed account may view");
		eq(await rc("9", SA), { canView: false, note: MESSAGES.viewRestricted }, "§8 another Super Admin: no, with the owner sentence");
		eq(await rc("9", SHARED), { canView: false, note: MESSAGES.viewRestricted }, "§8 the shared login: no");
		eq(await rc("made-up", SA_LISTED), { canView: false, note: MESSAGES.viewRestricted }, "§8 an invalid setting: nobody");
		eq(await rc("9", SA_NO_ID), { canView: false, note: MESSAGES.signInAgain }, "§8 a session without an account id: sign in again");
		eq(MESSAGES.viewRestricted, "Viewing rate cons is limited to the owner.", "§8 (the owner sentence)");
		ok(main.body.loads.every((l) => Object.keys(l).every((k) => !/url|path|drive(?!r)|file/i.test(k))), "§8 no row names a file, path or Drive id");
		ok(ROUTE_TEXT.includes("rateconViewGate.refusal(req.session.user)"), "§8 the route asks #570's gate object itself");
		ok(ROUTE_TEXT && !/\/uploads|ratecon\.pdf|drive_file|drive_url|file_name|documents/i.test(ROUTE_TEXT), "§8 the route names no file, upload or rate-con path");
	});

	await section("§9  view only", async () => {
		const lines = SRC.split("\n").filter((l) => /^app\.[a-z]+\(/.test(l) && l.includes("cancelled-loads"));
		eq(lines.map((l) => l.slice(0, l.indexOf(","))), [`app.get("${ROUTE_PATH}"`], "§9 server.js registers one route that names cancelled loads, a GET");
		ok(prepared.length > 0 && prepared.every((s) => /^\s*SELECT\b/i.test(s)), "§9 every statement the route ran is a SELECT, on a handle that refuses writes");
		ok(Object.isFrozen(JT) && Object.isFrozen(JT.data[0]), "§9 the cached sheet the route read was frozen, and it answered 200: nothing was written to it");
		ok(DENIED.every((n) => !new RegExp(`\\b${n}\\(`).test(ROUTE_TEXT)), "§9 no audit row, notice, status record, sheet write or cache reset");
	});

	await section("§10 failures", async () => {
		await quietly(async () => {
			sheetFail = true;
			const s = await call(ON, SA);
			sheetFail = false;
			eq([s.status, s.body && s.body.code, s.body && "loads" in s.body], [503, "SHEET_UNREADABLE", false], "§10 an unreadable sheet: 503 SHEET_UNREADABLE, no rows");
			ok(!/made-up sheet outage/.test(JSON.stringify(s.body)), "§10 ...without the error's text");
			for (const table of ["load_status_history", "audit_trail", "deleted_loads"]) {
				failSql = new RegExp(`FROM ${table}\\b`);
				const r = await call(ON, SA);
				failSql = null;
				eq([r.status, r.body && r.body.code, r.body && "loads" in r.body], [503, "RECORDS_UNREADABLE", false], `§10 ${table} unreadable: 503 RECORDS_UNREADABLE, never a page of "Not recorded"`);
			}
			const broken = buildWorld({ shower: { shownLoadId: () => { throw new Error("made-up failure"); }, routeShownLoadIdIndex: () => null } });
			const e = await call(broken, SA);
			eq([e.status, e.body], [500, { error: "The cancelled loads could not be listed." }], "§10 anything else: 500 with a fixed sentence");
		});
	});

	await section("§11 parameterized SQL, and a mutant", async () => {
		ok(ROUTE_TEXT.length > 0 && !/\b(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/.test(ROUTE_TEXT), "§11 the route holds no SQL of its own: its statements are recordQueries()'");
		const prepares = ROUTE_TEXT.match(/db\.prepare\([^)]*\)/g) || [];
		ok(prepares.length > 0 && prepares.every((p) => p === "db.prepare(s.sql)"), "§11 every statement is prepared from recordQueries()' text, its keys bound as parameters");
		const mutantHead = HEAD.replace('requireRole("Super Admin")', 'requireRole("Super Admin", "Dispatcher")');
		const mutant = buildWorld({ src: SRC.replace(HEAD, mutantHead), head: mutantHead });
		const r = await call(mutant, DISPATCHER);
		ok(r.status !== 403, `§11 a mutant that re-admits Dispatcher answers ${r.status}, so §1's 403 check catches it`);
	});

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
})();
