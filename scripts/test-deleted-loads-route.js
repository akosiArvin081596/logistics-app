#!/usr/bin/env node
/**
 * scripts/test-deleted-loads-route.js — GET /api/admin/deleted-loads, the
 * Super Admin "Deleted loads" list (list only; nothing on it restores a load).
 *
 *   §1 the role gate: Dispatcher, Driver and Investor get 403, no session 401,
 *      and none of them reaches the handler (the sheet is never read).
 *   §2 Super Admin gets every deleted_loads row, newest first, each with its
 *      load ID as stored, route and driver from its Job Tracking row, the date
 *      deleted on the business clock (APP_TIMEZONE, US Eastern), who deleted it,
 *      its settlement month(s) and whether each is closed (period_locks status
 *      'locked'; 'reopened' is open). The months come from loadRowPeriods() on
 *      the matched row(s), matched the delete route's way (normalizeLoadId(), so
 *      "#X" in the sheet matches "x"); with no row giving a month, from the
 *      load's delete_load audit entry nearest the deletion; otherwise none.
 *   §3 an unreadable sheet answers 503 SHEET_UNREADABLE and an unreadable
 *      period_locks 503 PERIOD_LOCK_UNREADABLE: no months are guessed.
 *   §4 parameterized SQL only, and a mutant that re-admits Dispatcher is caught.
 *   §5 the module's edges (an impossible stamp, the audit text).
 *   §6 review lows on #568: every row carries its deleted_loads id (two deletes
 *      of one load in the same second stay two rows); when any matched row's
 *      dates can't be read, the delete record's months answer, not the readable
 *      rows' alone.
 *
 * RESTORE (lib/deleted-load-restore.js, DELETED_LOAD_RESTORE_ENABLED):
 *   §7  the wiring in server.js: the flag read, the mount between the list and
 *       the dashboard, the list's field, the notice type, the delete's digests.
 *   §8  the flag off: nothing mounted, the list answer byte-identical, every
 *       create and dashboard call inert without touching the database.
 *   §9  POST /api/admin/deleted-loads/:id/restore answers 403 to every role but
 *       Super Admin (a made-up "Admin" and an unknown one included), 401 signed
 *       out, and none of them reaches the handler or changes anything.
 *   §10 a closed month and a month that can't be read are refused in plain
 *       words, nothing changed.
 *   §11 no Job Tracking row, an unknown id, a bad id or mode, an unreadable lock
 *       table (before or after the sheet read) or sheet: refused, nothing changed.
 *   §12 a second press is the 404 no-op; two presses at once restore once.
 *   §13 the one audit row (restore_load, or clear_load_delete for "Create it as
 *       new"); "Create it as new" refused while a row that may be the delete's
 *       own is live; an audit write that fails leaves the delete in place.
 *   §14 restored, the load counts again (excludeDroppedLoads(), the live view)
 *       and leaves the deleted list.
 *
 * WHAT IS REAL. The route registration, requireRole, periodLocksReadable,
 * isLocked, jobTrackingMonthCols, loadRowPeriods (and the date readers under
 * it), pickAddressColumn and resolveCityState (and the address split under it),
 * lockedAmong, periodLabel and excludeDroppedLoads (and the reads under it)
 * are lifted out of server.js and run as shipped; lib/deleted-loads-view.js,
 * lib/deleted-load-restore.js and normalizeLoadId() are required. The database
 * is a better-sqlite3 :memory: with the tables the routes read. Stubbed: the
 * Job Tracking read (made-up rows), tripDayLockCover() (null: the trip
 * work-day rule is off) and refuseCrossSite (its own runner covers it).
 *
 * Made-up loads, people and places only. No server, no port, no network.
 * Run: node scripts/test-deleted-loads-route.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

function findRoot(start) {
	for (let d = start; ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, "server.js")) && fs.existsSync(path.join(d, "package.json"))) return d;
		if (path.dirname(d) === d) throw new Error(`no repo root above ${start}`);
	}
}
const ROOT = findRoot(__dirname);
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");
const Database = require("better-sqlite3");
const { normalizeLoadId } = require(path.join(ROOT, "lib", "ratecon-load.js"));

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
}
function eq(name, got, want) {
	const g = JSON.stringify(got);
	const w = JSON.stringify(want);
	ok(name, g === w, g === w ? "" : `got ${g}, want ${w}`);
}

// ------------------------------------------------------------- extraction
// A top-level function runs from its `function name(` line to the first line
// that is a bare "}" (server.js indents bodies with tabs). Lines, not brace
// counting: splitAddressLines() holds a "{" inside a comment.
const SRC_LINES = SRC.split("\n");
function liftFn(name) {
	const head = `function ${name}(`;
	const starts = SRC_LINES.reduce((a, l, i) => (l.startsWith(head) ? a.concat(i) : a), []);
	if (starts.length !== 1) return null;
	const end = SRC_LINES.indexOf("}", starts[0]);
	return end < 0 ? null : SRC_LINES.slice(starts[0], end + 1).join("\n");
}
function liftConst(name) {
	const m = SRC.match(new RegExp(`\\nconst ${name} = [^\\n]+;`));
	return m && SRC.split(`\nconst ${name} = `).length - 1 === 1 ? m[0] : null;
}
const ROUTE_PATH = "/api/admin/deleted-loads";
function registration(verb, p) {
	const head = `app.${verb}(${JSON.stringify(p)},`;
	if (SRC_LINES.filter((l) => l.startsWith(head)).length !== 1) return null;
	const s = SRC_LINES.findIndex((l) => l.startsWith(head));
	let e = s;
	while (e < SRC_LINES.length && SRC_LINES[e] !== ");" && SRC_LINES[e] !== "});") e++;
	return SRC_LINES.slice(s, e + 1).join("\n");
}

const FNS = [
	"requireRole", "periodLockStmt", "periodLocksReadable", "isLocked",
	"findCol", "jobTrackingMonthCols", "loadRowPeriods", "loadAssignedMonthKey", "loadWindowDays",
	"moneySheetDate", "jtParseSheetDate", "jtExpandDateRange", "jtFmtDate",
	"pickAddressColumn", "resolveCityState", "resolveAddressParts", "splitAddressLines",
	"parseOriginDestCity", "jsonAddressParts",
];
const CONSTS = ["LOCKABLE_MONTH_KEY", "RFC2822_MONTHS", "ADDRESS_MAX_CHARS", "COUNTRY_SUFFIX_RE"];
const lifted = FNS.map((n) => [n, liftFn(n)]);
const liftedConsts = CONSTS.map((n) => [n, liftConst(n)]);
for (const [n, t] of lifted) if (!t) ok(`${n}() is defined once in server.js`, false);
for (const [n, t] of liftedConsts) if (!t) ok(`${n} is defined once in server.js`, false);

const ROUTE = registration("get", ROUTE_PATH);
ok(`GET ${ROUTE_PATH} is registered once in server.js`, !!ROUTE);

let deletedLoadsView = null;
try { deletedLoadsView = require(path.join(ROOT, "lib", "deleted-loads-view.js")); }
catch (e) { ok("lib/deleted-loads-view.js loads", false, e.message); }

// The restore module. Missing on a checkout without it: §7-§14 then fail on
// that, and the list sections above still run.
let restoreLib = null;
let restoreLibError = "";
try { restoreLib = require(path.join(ROOT, "lib", "deleted-load-restore.js")); }
catch (e) { restoreLibError = e.message; }
const RESTORE_PATH = "/api/admin/deleted-loads/:id/restore";

// The pieces the restore route and the "is this load live?" check run on, lifted
// beside the ones above.
const MORE_FNS = ["lockedAmong", "periodLabel", "excludeDroppedLoads", "getDeletedLoadIds", "loadKeySet", "liveJobTrackingView", "auditText", "scrubPurgeMarker"];
const MORE_CONSTS = ["CANCELED_STATUS_RE"];
const liftedMore = MORE_FNS.map((n) => [n, liftFn(n)]);
const liftedMoreConsts = MORE_CONSTS.map((n) => [n, liftConst(n)]);
for (const [n, t] of liftedMore) if (!t) ok(`${n}() is defined once in server.js`, false);
for (const [n, t] of liftedMoreConsts) if (!t) ok(`${n} is defined once in server.js`, false);

// ---------------------------------------------------------------- fixture
// Made-up Job Tracking, in the header-keyed shape getJobTrackingCached() hands
// every caller (header order as on the real tab: Assigned Date before Status
// Update Date and Completion Date, so the month column is Assigned Date).
const HEADERS = ["Load ID", "Driver", "Job Status", "Pickup Appointment", "Pickup Address",
	"Drop-off Appointment", "Drop-off Address", "Assigned Date", "Status Update Date", "Completion Date", "Truck"];
function row(rowIndex, over) {
	const r = {
		"Job Status": "Delivered", "Pickup Appointment": "", "Pickup Address": "",
		"Drop-off Appointment": "", "Drop-off Address": "", "Assigned Date": "",
		"Status Update Date": "", "Completion Date": "", "Truck": "T-900",
		...over,
	};
	r._rowIndex = rowIndex;
	return r;
}
const JT = {
	headers: HEADERS,
	data: [
		// Closed month (2026-05 locked).
		row(2, { "Load ID": "LX-1001", Driver: "Test Driver One", "Assigned Date": "2026-05-11",
			"Pickup Appointment": "2026-05-12", "Drop-off Appointment": "2026-05-14",
			"Pickup Address": "100 Sample St, Springfield, IL 62701", "Drop-off Address": "200 Example Ave, Riverton, WY 82501" }),
		// Open month (2026-10, no lock row).
		row(3, { "Load ID": "LX-1002", Driver: "Test Driver Two", "Assigned Date": "2026-10-02",
			"Pickup Address": "Lakeview, OH 43331", "Drop-off Address": "Hilltop, KY 40001" }),
		// "#" in the sheet, stored without it; its month was reopened, so it is open.
		row(4, { "Load ID": "#LX-1005", Driver: "Test Driver Three", "Assigned Date": "2026-09-15",
			"Pickup Address": "Maple Town, TX 75001", "Drop-off Address": "Oak City, OK 73001" }),
		// Dates no reader can place: the row matches, but gives no month.
		row(6, { "Load ID": "LX-1006", Driver: "Test Driver Four", "Assigned Date": "TBD",
			"Pickup Address": "Pine Falls, GA 30001", "Drop-off Address": "Cedar Bay, FL 32001" }),
		// A live load nobody deleted: never listed.
		row(9, { "Load ID": "LX-2000", Driver: "Test Driver Five", "Assigned Date": "2026-10-03" }),
	],
};

function makeDb({ lockTable = true } = {}) {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL,
		row_index INTEGER DEFAULT 0, deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_by TEXT DEFAULT '')`);
	db.exec(`CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
		user_id INTEGER NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL,
		entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
	db.exec(`CREATE TABLE load_coordinates (load_id TEXT PRIMARY KEY, pickup_address TEXT, dropoff_address TEXT)`);
	db.exec(`CREATE TABLE dispatch_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL,
		body TEXT DEFAULT '', metadata TEXT DEFAULT '{}', read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
	if (lockTable) {
		db.exec(`CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked'
			CHECK(status IN ('locked','reopened')), finalized_at TEXT NOT NULL, finalized_by TEXT NOT NULL DEFAULT 'system',
			reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
		const lock = db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, ?, ?)");
		lock.run("2026-04", "locked", "2026-05-15T05:00:00Z");
		lock.run("2026-05", "locked", "2026-06-15T05:00:00Z");
		lock.run("2026-09", "reopened", "2026-10-15T05:00:00Z");
	}
	const del = db.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_at, deleted_by) VALUES (?, ?, ?, ?)");
	del.run("lx-1001", 2, "2026-09-01 02:30:00", "super_admin"); // 10:30 PM Aug 31 Eastern
	del.run("lx-1003", 7, "2026-10-05 15:00:00", "super_admin");
	del.run("lx-1002", 3, "2026-10-20 12:00:00", "admin_two");
	del.run("lx-1004", 0, "2026-10-21 09:00:00", "");
	del.run("lx-1005", 4, "2026-10-10 10:00:00", "super_admin");
	del.run("lx-1006", 6, "2026-10-12 10:00:00", "super_admin");
	const audit = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 1, 'super_admin', 'Super Admin', ?, 'load', ?, ?)");
	// LX-1003 has no sheet row: its months come from the delete's own audit entry,
	// the one nearest the deletion (an older delete of the same id named another month).
	audit.run("2026-01-20T10:00:00.000Z", "delete_load", "lx-1003",
		"Soft-deleted load LX-1003 (sheet row 7) — settlement month 2026-01. Reversible: DELETE FROM deleted_loads WHERE load_id = 'lx-1003'");
	audit.run("2026-10-05T15:00:00.412Z", "delete_load", "lx-1003",
		"Soft-deleted load LX-1003 (sheet row 7) — settlement months 2026-05, 2026-06. Reversible: DELETE FROM deleted_loads WHERE load_id = 'lx-1003'");
	// A refused delete names months too, under another action: never read.
	audit.run("2026-10-05T14:00:00.000Z", "delete_load_blocked", "lx-1003", "settlement month 2026-02");
	// LX-1006's row no longer gives a month: the audit entry does.
	audit.run("2026-10-12T10:00:01.000Z", "delete_load", "lx-1006",
		"Soft-deleted load LX-1006 (sheet row 6) — settlement month 2026-04. Reversible: DELETE FROM deleted_loads WHERE load_id = 'lx-1006'");
	// LX-1004: deleted with no Job Tracking row, so its audit names no month.
	audit.run("2026-10-21T09:00:00.100Z", "delete_load", "lx-1004",
		"Soft-deleted load LX-1004 — no matching Job Tracking row. Reversible: DELETE FROM deleted_loads WHERE load_id = 'lx-1004'");
	return db;
}

// One scope per database: periodLockStmt() caches its statement on itself.
// `restore` is the deleted-load-restore instance the route reads its extra
// field from (off unless a section turns it on).
const quiet = { log() {}, warn() {}, error() {} };
function build(routeText, db, jobTracking, { restoreOn = false } = {}) {
	const reads = { sheet: 0 };
	const getJobTrackingCached = async () => {
		reads.sheet++;
		if (jobTracking instanceof Error) throw jobTracking;
		return jobTracking;
	};
	let captured = null;
	const app = { get: (p, ...chain) => { captured = chain; } };
	const body = [
		...liftedConsts.map(([, t]) => t),
		...lifted.map(([, t]) => t),
		routeText,
		"return { requireRole };",
	].join("\n\n");
	const restore = restoreLib ? restoreLib.create({ db, enabled: restoreOn }) : { listFields: () => ({}) };
	const scope = new Function(
		"app", "db", "getJobTrackingCached", "tripDayLockCover", "deletedLoadsView", "normalizeLoadId", "APP_TIMEZONE", "console", "deletedLoadRestore",
		body,
	)(app, db, getJobTrackingCached, () => null, deletedLoadsView, normalizeLoadId, "America/New_York", quiet, restore);
	return { chain: captured, reads, requireRole: scope.requireRole };
}

// The server's own helpers in one scope over `db`, for the restore route's mount.
function helpersFor(db) {
	const body = [
		...liftedConsts.map(([, t]) => t),
		...liftedMoreConsts.map(([, t]) => t),
		...lifted.map(([, t]) => t),
		...liftedMore.map(([, t]) => t),
		"return { requireRole, periodLocksReadable, isLocked, jobTrackingMonthCols, loadRowPeriods, lockedAmong, periodLabel,",
		"\tpickAddressColumn, excludeDroppedLoads, getDeletedLoadIds, loadKeySet, liveJobTrackingView, findCol, auditText };",
	].join("\n\n");
	return new Function("db", "normalizeLoadId", "console", body)(db, normalizeLoadId, quiet);
}

// The restore route as mounted by the lib, over `db` and a made-up Job Tracking
// read. `rec` records what the route announces; `jt` may be an Error (unreadable)
// or a function called on each read (to change the world mid-request).
function restoreWorld({ db = makeDb(), jt = JT, enabled = true } = {}) {
	restoreLib.ensureSchema(db);
	const H = helpersFor(db);
	const rec = { changes: [], invalidations: 0, notices: [], reads: 0, crossSite: 0 };
	const routes = {};
	const app = {
		post: (p, ...chain) => { routes[`POST ${p}`] = chain; },
		get: (p, ...chain) => { routes[`GET ${p}`] = chain; },
	};
	const getJobTrackingCached = async () => {
		rec.reads++;
		await null;
		const v = typeof jt === "function" ? jt() : jt;
		if (v instanceof Error) throw v;
		return v;
	};
	const inst = restoreLib.create({ db, enabled, log: quiet, auditText: H.auditText });
	inst.mount(app, {
		requireRole: H.requireRole,
		refuseCrossSite: (req, res, next) => { rec.crossSite++; next(); },
		periodLocksReadable: H.periodLocksReadable,
		getJobTrackingCached,
		jobTrackingMonthCols: H.jobTrackingMonthCols,
		tripDayLockCover: () => null,
		loadRowPeriods: H.loadRowPeriods,
		lockedAmong: H.lockedAmong,
		periodLabel: H.periodLabel,
		notifyChange: (d) => rec.changes.push(d),
		jtCacheInvalidate: () => { rec.invalidations++; },
		pickAddressColumn: H.pickAddressColumn,
		excludeDroppedLoads: H.excludeDroppedLoads,
		notifySuperAdmins: (n) => rec.notices.push(n),
	});
	return { db, inst, H, rec, routes, chain: routes[`POST ${RESTORE_PATH}`] };
}

// What a request could change: every row of the tables the restore writes.
const FINGERPRINT_SQL = [
	"SELECT * FROM deleted_loads ORDER BY id",
	"SELECT * FROM audit_trail ORDER BY id",
	"SELECT * FROM dispatch_notifications ORDER BY id",
];
function fingerprint(db) {
	return JSON.stringify(FINGERPRINT_SQL.map((sql) => db.prepare(sql).all()));
}

const USERS = {
	"Super Admin": { id: 1, role: "Super Admin", username: "super_admin" },
	Dispatcher: { id: 2, role: "Dispatcher", username: "dispatch_test" },
	Driver: { id: 3, role: "Driver", username: "LogisX-9001", driverName: "Test Driver One" },
	Investor: { id: 4, role: "Investor", username: "investor_test" },
	// The role behind KPI_VIEWER_ENABLED, a made-up "Admin", one no list knows,
	// and Super Admin spelled another way: every one of them is someone else.
	"KPI Viewer": { id: 5, role: "KPI Viewer", username: "kpi_test" },
	Admin: { id: 6, role: "Admin", username: "admin_test" },
	"Night Auditor": { id: 7, role: "Night Auditor", username: "auditor_test" },
	"super admin": { id: 8, role: "super admin", username: "lower_test" },
};
const NOT_SUPER_ADMIN = ["Dispatcher", "Driver", "Investor", "KPI Viewer", "Admin", "Night Auditor", "super admin"];

// One POST to the restore route, as Express would run its chain. `csrf: false`
// leaves out X-Requested-With. The body carries a made-up reason (the 10-22
// Restore decision) unless it names its own.
const REASON = "Deleted in error; the load ran (made-up)";
async function callRestore(chain, user, { id, body = {}, csrf = true } = {}) {
	const url = `/api/admin/deleted-loads/${id}/restore`;
	const sent = Object.prototype.hasOwnProperty.call(body, "reason") ? body : { ...body, reason: REASON };
	const req = {
		method: "POST", path: url, url, originalUrl: url,
		params: { id: String(id) }, query: {}, body: sent, route: { path: RESTORE_PATH },
		headers: csrf ? { "x-requested-with": "XMLHttpRequest" } : {},
		session: user ? { user: { ...user } } : {},
	};
	const res = {
		statusCode: 200, body: undefined,
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
		setHeader() {}, end() { return this; },
	};
	for (const mw of chain.slice(0, -1)) {
		let nexted = false;
		await mw(req, res, () => { nexted = true; });
		if (!nexted) return { status: res.statusCode, body: res.body, reached: false };
	}
	await chain[chain.length - 1](req, res, (err) => { res.statusCode = 500; res.body = { error: String(err && err.message) }; });
	return { status: res.statusCode, body: res.body, reached: true };
}
const tombstoneId = (db, loadId) => (db.prepare("SELECT id FROM deleted_loads WHERE load_id = ? ORDER BY id").get(loadId) || {}).id;
async function call(chain, user) {
	const req = {
		method: "GET", path: ROUTE_PATH, url: ROUTE_PATH, originalUrl: ROUTE_PATH,
		params: {}, query: {}, body: {}, headers: {}, route: { path: ROUTE_PATH },
		session: user ? { user: { ...user } } : {},
	};
	const res = {
		statusCode: 200, body: undefined,
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
		setHeader() {}, end() { return this; },
	};
	for (const mw of chain.slice(0, -1)) {
		let nexted = false;
		await mw(req, res, () => { nexted = true; });
		if (!nexted) return { status: res.statusCode, body: res.body, reached: false };
	}
	await chain[chain.length - 1](req, res);
	return { status: res.statusCode, body: res.body, reached: true };
}

async function main() {
	const ready = ROUTE && deletedLoadsView && lifted.every(([, t]) => t) && liftedConsts.every(([, t]) => t);
	if (!ready) {
		console.log(`\n${passed} passed, ${failed} failed`);
		process.exit(1);
	}

	// ------------------------------------------------------------ §1 role gate
	console.log("\n§1 the role gate");
	ok("requireRole(\"Super Admin\") is the first middleware", /^app\.get\("\/api\/admin\/deleted-loads", requireRole\("Super Admin"\), /.test(ROUTE));
	{
		const { chain, reads } = build(ROUTE, makeDb(), JT);
		for (const role of ["Dispatcher", "Driver", "Investor"]) {
			const r = await call(chain, USERS[role]);
			ok(`${role} gets 403 and never reaches the handler`, r.status === 403 && !r.reached && !(r.body && r.body.loads), `${r.status}`);
		}
		const anon = await call(chain, null);
		ok("no session gets 401 and never reaches the handler", anon.status === 401 && !anon.reached, `${anon.status}`);
		eq("no refused caller read the sheet", reads.sheet, 0);
	}

	// ------------------------------------------------------------ §2 the rows
	console.log("\n§2 Super Admin's rows");
	const { chain, reads } = build(ROUTE, makeDb(), JT);
	const r = await call(chain, USERS["Super Admin"]);
	ok("Super Admin gets 200", r.status === 200 && r.reached, `${r.status} ${JSON.stringify(r.body)}`);
	const loads = (r.body && r.body.loads) || [];
	eq("one sheet read", reads.sheet, 1);
	eq("every deleted_loads row, newest first; a live load is never listed", loads.map((l) => l.loadId),
		["lx-1004", "lx-1002", "lx-1006", "lx-1005", "lx-1003", "lx-1001"]);
	eq("count is the number of rows", r.body && r.body.count, 6);
	const by = Object.fromEntries(loads.map((l) => [l.loadId, l]));

	const pick = (l) => l && {
		loadId: l.loadId, pickup: l.pickup, dropoff: l.dropoff, driver: l.driver,
		deletedAt: l.deletedAt, deletedDay: l.deletedDay, deletedBy: l.deletedBy,
		months: l.months, monthsFrom: l.monthsFrom,
	};
	eq("closed month: the row's route, driver, Eastern day, deleter, month locked", pick(by["lx-1001"]), {
		loadId: "lx-1001", pickup: "Springfield, IL 62701", dropoff: "Riverton, WY 82501", driver: "Test Driver One",
		deletedAt: "2026-09-01T02:30:00Z", deletedDay: "2026-08-31", deletedBy: "super_admin",
		months: [{ month: "2026-05", closed: true }], monthsFrom: "sheet",
	});
	eq("open month: no lock row means open", pick(by["lx-1002"]), {
		loadId: "lx-1002", pickup: "Lakeview, OH 43331", dropoff: "Hilltop, KY 40001", driver: "Test Driver Two",
		deletedAt: "2026-10-20T12:00:00Z", deletedDay: "2026-10-20", deletedBy: "admin_two",
		months: [{ month: "2026-10", closed: false }], monthsFrom: "sheet",
	});
	eq("a \"#\" Load ID in the sheet matches its stored key; a reopened month is open", pick(by["lx-1005"]), {
		loadId: "lx-1005", pickup: "Maple Town, TX 75001", dropoff: "Oak City, OK 73001", driver: "Test Driver Three",
		deletedAt: "2026-10-10T10:00:00Z", deletedDay: "2026-10-10", deletedBy: "super_admin",
		months: [{ month: "2026-09", closed: false }], monthsFrom: "sheet",
	});
	eq("no sheet row: the months of the delete's own audit entry (the nearest one), each with its lock", pick(by["lx-1003"]), {
		loadId: "lx-1003", pickup: "", dropoff: "", driver: "",
		deletedAt: "2026-10-05T15:00:00Z", deletedDay: "2026-10-05", deletedBy: "super_admin",
		months: [{ month: "2026-05", closed: true }, { month: "2026-06", closed: false }], monthsFrom: "audit",
	});
	eq("a matched row whose dates give no month: route and driver from the row, months from the audit", pick(by["lx-1006"]), {
		loadId: "lx-1006", pickup: "Pine Falls, GA 30001", dropoff: "Cedar Bay, FL 32001", driver: "Test Driver Four",
		deletedAt: "2026-10-12T10:00:00Z", deletedDay: "2026-10-12", deletedBy: "super_admin",
		months: [{ month: "2026-04", closed: true }], monthsFrom: "audit",
	});
	eq("no row and an audit naming no month: no months", pick(by["lx-1004"]), {
		loadId: "lx-1004", pickup: "", dropoff: "", driver: "",
		deletedAt: "2026-10-21T09:00:00Z", deletedDay: "2026-10-21", deletedBy: "",
		months: [], monthsFrom: "none",
	});

	// An empty table is an empty list, not an error.
	{
		const db = makeDb();
		db.exec("DELETE FROM deleted_loads");
		const e = await call(build(ROUTE, db, JT).chain, USERS["Super Admin"]);
		ok("no deleted loads: 200 with an empty list", e.status === 200 && Array.isArray(e.body.loads) && e.body.loads.length === 0 && e.body.count === 0, JSON.stringify(e.body));
	}

	// ------------------------------------------------------------ §3 unreadable
	console.log("\n§3 nothing is guessed");
	{
		const s = await call(build(ROUTE, makeDb(), new Error("made-up Sheets outage")).chain, USERS["Super Admin"]);
		ok("an unreadable sheet answers 503 SHEET_UNREADABLE with no rows",
			s.status === 503 && s.body && s.body.code === "SHEET_UNREADABLE" && !("loads" in s.body), `${s.status} ${JSON.stringify(s.body)}`);
		const built = build(ROUTE, makeDb({ lockTable: false }), JT);
		const p = await call(built.chain, USERS["Super Admin"]);
		ok("an unreadable period_locks answers 503 PERIOD_LOCK_UNREADABLE with no rows",
			p.status === 503 && p.body && p.body.code === "PERIOD_LOCK_UNREADABLE" && !("loads" in p.body), `${p.status} ${JSON.stringify(p.body)}`);
		eq("...before the sheet is read", built.reads.sheet, 0);
	}

	// ------------------------------------------------------------ §4 SQL, mutant
	console.log("\n§4 parameterized SQL; the gate discriminates");
	ok("no SQL is built from a template literal in the route", !/prepare\(\s*`[^`]*\$\{/.test(ROUTE));
	{
		const mutated = ROUTE.replace('requireRole("Super Admin")', 'requireRole("Super Admin", "Dispatcher")');
		const m = await call(build(mutated, makeDb(), JT).chain, USERS.Dispatcher);
		ok("MUTANT Dispatcher re-admitted: caught (it reaches the rows)", m.reached && m.status === 200);
	}

	// ------------------------------------------------------------ §5 the module's edges
	console.log("\n§5 lib/deleted-loads-view.js edges");
	eq("a stamp that is no date gives no time, not a guessed one",
		["2026-02-30 10:00:00", "", null, "yesterday"].map((v) => Number.isNaN(deletedLoadsView.sqliteUtcMs(v))), [true, true, true, true]);
	{
		const [row] = deletedLoadsView.deletedLoadRows({
			deleted: [{ load_id: "lx-3000", row_index: 0, deleted_at: "2026-02-30 10:00:00", deleted_by: "super_admin" }],
			rows: [], cols: { loadIdCol: "Load ID" }, auditsFor: () => [], laneOf: () => ({}),
			normalizeLoadId, loadRowPeriods: () => ({ periods: [], resolved: false }), isLocked: () => false, timeZone: "America/New_York",
		});
		eq("...and the row says so with blanks", [row.deletedAt, row.deletedDay, row.monthsFrom], ["", "", "none"]);
	}
	eq("audit text: one month, several, none", [
		"Soft-deleted load LX-1 — settlement month 2026-03. Reversible: …",
		"Soft-deleted load LX-1 — settlement months 2026-04, 2026-03. Reversible: …",
		"Soft-deleted load LX-1 — no matching Job Tracking row. Reversible: …",
		null,
	].map(deletedLoadsView.auditMonths), [["2026-03"], ["2026-03", "2026-04"], [], []]);

	// ------------------------------------------------------------ §6 review lows (#568)
	console.log("\n§6 one key per deleted_loads row; a partly readable load");
	{
		// L1: a second delete of the same load in the same second is a second row
		// with the same load ID, time and row index; only deleted_loads.id tells them apart.
		const db = makeDb();
		db.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_at, deleted_by) VALUES (?, ?, ?, ?)")
			.run("lx-1002", 3, "2026-10-20 12:00:00", "admin_two");
		const ids = db.prepare("SELECT id FROM deleted_loads ORDER BY id").all().map((x) => x.id);
		const got = await call(build(ROUTE, db, JT).chain, USERS["Super Admin"]);
		const rows = (got.body && got.body.loads) || [];
		eq("L1 every row carries its deleted_loads id", rows.map((l) => l.id).sort((a, b) => a - b), ids);
		const twins = rows.filter((l) => l.loadId === "lx-1002");
		ok("L1 the two same-second deletes of one load have different ids",
			twins.length === 2 && Number.isInteger(twins[0].id) && twins[0].id !== twins[1].id, JSON.stringify(twins.map((l) => l.id)));
	}
	{
		// L2: two rows carry one load (one spelled with "#"); one has an October
		// Assigned Date, the other dates nobody can read. The readable row alone
		// could miss a closed month, so the delete record's months answer.
		const jt = { headers: HEADERS, data: JT.data.concat([
			row(20, { "Load ID": "LX-7", Driver: "Test Driver Six", "Assigned Date": "2026-10-04",
				"Pickup Address": "Elm Grove, WI 53122", "Drop-off Address": "Birch Run, MI 48415" }),
			row(21, { "Load ID": "#lx-7", Driver: "Test Driver Six", "Assigned Date": "TBD" }),
			row(22, { "Load ID": "LX-8", Driver: "Test Driver Seven", "Assigned Date": "2026-10-06" }),
			row(23, { "Load ID": "lx-8", Driver: "Test Driver Seven", "Assigned Date": "TBD" }),
		]) };
		const db = makeDb();
		const del = db.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_at, deleted_by) VALUES (?, ?, ?, ?)");
		del.run("lx-7", 20, "2026-10-18 14:00:00", "super_admin");
		del.run("lx-8", 22, "2026-10-18 15:00:00", "super_admin");
		const audit = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 1, 'super_admin', 'Super Admin', ?, 'load', ?, ?)");
		audit.run("2026-10-18T14:00:00.300Z", "delete_load", "lx-7",
			"Soft-deleted load LX-7 (sheet row 20) — settlement months 2026-05, 2026-10. Reversible: DELETE FROM deleted_loads WHERE load_id = 'lx-7'");
		audit.run("2026-10-18T15:00:00.300Z", "delete_load", "lx-8",
			"Soft-deleted load LX-8 — no matching Job Tracking row. Reversible: DELETE FROM deleted_loads WHERE load_id = 'lx-8'");
		const got = await call(build(ROUTE, db, jt).chain, USERS["Super Admin"]);
		const byId = Object.fromEntries(((got.body && got.body.loads) || []).map((l) => [l.loadId, l]));
		const l7 = byId["lx-7"];
		eq("L2 one row readable, one not: the delete record's months, each with its lock",
			l7 && { months: l7.months, monthsFrom: l7.monthsFrom, pickup: l7.pickup, driver: l7.driver },
			{ months: [{ month: "2026-05", closed: true }, { month: "2026-10", closed: false }], monthsFrom: "audit",
				pickup: "Elm Grove, WI 53122", driver: "Test Driver Six" });
		const l8 = byId["lx-8"];
		eq("L2 ...and with a delete record naming none, no months rather than the readable row's alone",
			l8 && { months: l8.months, monthsFrom: l8.monthsFrom }, { months: [], monthsFrom: "none" });
	}

	await restoreSections();

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}

// ================================================================ RESTORE
async function restoreSections() {
	console.log("\n§7 the restore wiring in server.js");
	ok("lib/deleted-load-restore.js loads", !!restoreLib, restoreLibError);
	if (!restoreLib) return;
	const count = (needle) => SRC.split(needle).length - 1;
	const DECL = '\nconst deletedLoadRestore = require("./lib/deleted-load-restore").create({ db, enabled: process.env.DELETED_LOAD_RESTORE_ENABLED === "true", auditText });\n';
	eq("one instance, on only when the setting is exactly \"true\", cleaning reasons the audit trail's way", count(DECL), 1);
	eq("its column is added once, at start", count('\nrequire("./lib/deleted-load-restore").ensureSchema(db);\n'), 1);
	const MOUNT = "\ndeletedLoadRestore.mount(app, {\n";
	eq("mounted once", count(MOUNT), 1);
	const at = (needle) => SRC.indexOf(needle);
	const listHead = at(`\napp.get(${JSON.stringify(ROUTE_PATH)},`);
	const dashHead = at('\napp.get("/api/dashboard",');
	ok("mounted after the deleted-loads list and before GET /api/dashboard (its dashboard step runs first)",
		listHead > 0 && at(MOUNT) > listHead && dashHead > at(MOUNT), `${listHead} ${at(MOUNT)} ${dashHead}`);
	const mountBlock = at(MOUNT) > 0 ? SRC.slice(at(MOUNT), SRC.indexOf("\n});\n", at(MOUNT)) + 5) : "";
	ok("the mount hands over requireRole and refuseCrossSite", /\n\trequireRole, refuseCrossSite, /.test(mountBlock));
	ok("its notices are stored as dispatch notices and sent live to the super-admin room only",
		mountBlock.includes("insertDispatchNotification.run(notice.type, notice.title, notice.body, JSON.stringify(notice.metadata || {}));")
		&& mountBlock.includes('if (io) io.to("super-admin").emit("dispatch-notification", notice);')
		&& !/io\.(emit|to\("dispatch"\))/.test(mountBlock));
	ok("the list answer adds the lib's fields and nothing else",
		ROUTE.includes("res.json({ loads, count: loads.length, ...deletedLoadRestore.listFields() });"));
	const typesLine = (SRC.match(/\nconst SUPER_ADMIN_ONLY_NOTICE_TYPES = Object\.freeze\(\[[^\]\n]*\]\);/) || [""])[0];
	ok("the notice type is a Super Admin-only dispatch notice", typesLine.includes(`"${restoreLib.NOTICE_TYPE}"`) && restoreLib.NOTICE_TYPE === "load-hidden-by-delete", typesLine);
	ok("...and so is the restore's notice", typesLine.includes(`"${restoreLib.RESTORED_NOTICE_TYPE}"`) && restoreLib.RESTORED_NOTICE_TYPE === "deleted-load-restored", typesLine);
	const del = registration("delete", "/api/loads/:loadId") || "";
	ok("the delete keeps its tombstone's id and records the rows it hides",
		del.includes('const tombstone = db.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_by) VALUES (?, ?, ?)").run(lid, rowIndex, deletedBy);')
		&& del.includes("deletedLoadRestore.recordDigests(tombstone.lastInsertRowid, jobTracking, lid);"));

	console.log("\n§8 the flag off: exactly as before");
	{
		const w = restoreWorld({ enabled: false });
		eq("nothing is mounted", Object.keys(w.routes), []);
		eq("the instance says off", w.inst.enabled, false);
		const off = await call(build(ROUTE, makeDb(), JT).chain, USERS["Super Admin"]);
		eq("the list answer has its two keys only", Object.keys(off.body || {}), ["loads", "count"]);
		ok("...byte for byte", JSON.stringify(off.body) === JSON.stringify({ loads: off.body.loads, count: off.body.count }));
		const on = await call(build(ROUTE, makeDb(), JT, { restoreOn: true }).chain, USERS["Super Admin"]);
		eq("on, the same answer plus restore: { enabled: true }", [Object.keys(on.body || {}), on.body && on.body.restore,
			JSON.stringify(on.body && on.body.loads) === JSON.stringify(off.body.loads)], [["loads", "count", "restore"], { enabled: true }, true]);
		const untouchable = { prepare() { throw new Error("the database is not read with the flag off"); }, exec() { throw new Error("nor written"); }, transaction() { throw new Error("nor written"); } };
		const offInst = restoreLib.create({ db: untouchable, enabled: false });
		let threw = "";
		let answers = [];
		try {
			const sent = { session: { user: USERS["Super Admin"] }, body: { deletedLoadChoice: { action: "create_new", id: 1, count: 1 } } };
			answers = [
				offInst.onCreate(sent, { loadId: "LX-1002", rowIndex: null }),
				offInst.onCreate({ session: { user: USERS["Super Admin"] }, body: {} }, { loadId: "LX-1002", rowIndex: null, headerRead: false }),
				offInst.clearBeforeAppend(sent),
				offInst.onCreate({ session: { user: USERS.Dispatcher }, body: {} }, { loadId: "LX-1002", rowIndex: 3 }),
				offInst.hiddenLoads({ session: { user: USERS["Super Admin"] } }, JT),
				offInst.recordDigests(1, JT, "lx-1002"),
			];
		} catch (e) { threw = e.message; }
		eq("onCreate (an unread header row too), clearBeforeAppend, hiddenLoads and recordDigests answer nothing and touch no database",
			[threw, answers], ["", [null, null, null, null, null, undefined]]);
		eq("listFields() adds nothing", offInst.listFields(), {});
	}

	console.log("\n§9 the restore route answers 403 to every role but Super Admin");
	{
		const w = restoreWorld();
		eq("three links: the role gate, the cross-site guard, the handler", w.chain && w.chain.length, 3);
		const before = fingerprint(w.db);
		const id = tombstoneId(w.db, "lx-1002");
		for (const role of NOT_SUPER_ADMIN) {
			const r = await callRestore(w.chain, USERS[role], { id });
			ok(`${role} gets 403 and never reaches the handler`, r.status === 403 && !r.reached && !(r.body && r.body.restored), `${r.status} ${JSON.stringify(r.body)}`);
		}
		const anon = await callRestore(w.chain, null, { id });
		ok("signed out gets 401 and never reaches the handler", anon.status === 401 && !anon.reached, `${anon.status}`);
		const noHeader = await callRestore(w.chain, USERS["Super Admin"], { id, csrf: false });
		ok("a Super Admin's POST without X-Requested-With is refused 403 too", noHeader.status === 403 && !noHeader.reached, `${noHeader.status}`);
		eq("none of them got past the role gate or read the sheet", [w.rec.crossSite, w.rec.reads], [0, 0]);
		eq("nothing changed", fingerprint(w.db) === before, true);
	}

	console.log("\n§10 a closed month and an unreadable month are refused, nothing changed");
	{
		const span = { headers: HEADERS, data: JT.data.concat([
			// No Assigned Date: its window's days settle in April and May, both closed.
			row(30, { "Load ID": "LX-1009", Driver: "Test Driver Eight", "Pickup Appointment": "2026-04-29", "Drop-off Appointment": "2026-05-02" }),
		]) };
		const db = makeDb();
		db.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_at, deleted_by) VALUES ('lx-1009', 30, '2026-10-22 10:00:00', 'super_admin')").run();
		const w = restoreWorld({ db, jt: span });
		const before = fingerprint(w.db);
		const SA = USERS["Super Admin"];
		const locked = await callRestore(w.chain, SA, { id: tombstoneId(db, "lx-1001") });
		eq("a closed month: 409 PERIOD_FINALIZED in plain words", [locked.status, locked.body && locked.body.code, locked.body && locked.body.error, locked.body && locked.body.periods],
			[409, "PERIOD_FINALIZED", "Load lx-1001 is in a closed month (May 2026). Restoring it would change a settled payout, which is a payout question. Nothing was changed.", ["2026-05"]]);
		const two = await callRestore(w.chain, SA, { id: tombstoneId(db, "lx-1009") });
		eq("two closed months: named, plural", [two.status, two.body && two.body.code, two.body && two.body.error],
			[409, "PERIOD_FINALIZED", "Load lx-1009 is in closed months (April 2026, May 2026). Restoring it would change settled payouts, which is a payout question. Nothing was changed."]);
		const unres = await callRestore(w.chain, SA, { id: tombstoneId(db, "lx-1006") });
		eq("dates that give no month: 409 PERIOD_UNRESOLVED in plain words", [unres.status, unres.body && unres.body.code, unres.body && unres.body.error],
			[409, "PERIOD_UNRESOLVED", "Load lx-1006's dates in Job Tracking don't give a month, so it can't be told whether restoring it would change a closed month. Correct the dates on its row, then try again. Nothing was changed."]);
		eq("nothing changed and nothing was announced", [fingerprint(w.db) === before, w.rec.changes, w.rec.invalidations], [true, [], 0]);
	}

	console.log("\n§11 no row, no delete, a bad id or mode, an unreadable table or sheet: refused, nothing changed");
	{
		const SA = USERS["Super Admin"];
		const w = restoreWorld();
		const before = fingerprint(w.db);
		const gone = await callRestore(w.chain, SA, { id: tombstoneId(w.db, "lx-1003") });
		eq("no Job Tracking row: 409 NO_SHEET_ROW", [gone.status, gone.body && gone.body.code, gone.body && gone.body.error],
			[409, "NO_SHEET_ROW", "Load lx-1003 has no row in Job Tracking any more, so restoring it would bring nothing back. Nothing was changed."]);
		const unknown = await callRestore(w.chain, SA, { id: 999 });
		eq("no such delete: 404 NOT_DELETED", [unknown.status, unknown.body && unknown.body.code, unknown.body && unknown.body.error],
			[404, "NOT_DELETED", "This load isn't deleted any more; it may have been restored already. Nothing was changed."]);
		for (const bad of ["abc", "0", "-1", "1.5", "01", "1e3", "99999999999999999999"]) {
			const r = await callRestore(w.chain, SA, { id: bad });
			ok(`a bad id (${bad}) is 400 DELETED_LOAD_ID_INVALID`, r.status === 400 && r.body && r.body.code === "DELETED_LOAD_ID_INVALID", `${r.status} ${JSON.stringify(r.body)}`);
		}
		const badMode = await callRestore(w.chain, SA, { id: tombstoneId(w.db, "lx-1002"), body: { mode: "purge" } });
		eq("a mode that is neither restore nor create_new is 400", [badMode.status, badMode.body && badMode.body.code], [400, "RESTORE_MODE_INVALID"]);
		eq("none of these changed anything", fingerprint(w.db) === before, true);

		const noLocks = restoreWorld({ db: makeDb({ lockTable: false }) });
		const nl = await callRestore(noLocks.chain, SA, { id: 3 });
		eq("an unreadable lock table: 503 before the sheet is read", [nl.status, nl.body && nl.body.code, noLocks.rec.reads], [503, "PERIOD_LOCK_UNREADABLE", 0]);

		const db = makeDb();
		const midway = restoreWorld({ db, jt: () => { db.exec("DROP TABLE period_locks"); return JT; } });
		const mBefore = JSON.stringify(db.prepare("SELECT * FROM deleted_loads ORDER BY id").all());
		const m = await callRestore(midway.chain, SA, { id: tombstoneId(db, "lx-1002") });
		eq("a lock table that breaks during the sheet read: 503, the delete kept", [m.status, m.body && m.body.code, JSON.stringify(db.prepare("SELECT * FROM deleted_loads ORDER BY id").all()) === mBefore],
			[503, "PERIOD_LOCK_UNREADABLE", true]);

		const noSheet = restoreWorld({ jt: new Error("made-up Sheets outage") });
		const nsBefore = fingerprint(noSheet.db);
		const ns = await callRestore(noSheet.chain, SA, { id: tombstoneId(noSheet.db, "lx-1002") });
		eq("an unreadable sheet: 503 SHEET_UNREADABLE, nothing changed", [ns.status, ns.body && ns.body.code, fingerprint(noSheet.db) === nsBefore], [503, "SHEET_UNREADABLE", true]);
	}

	console.log("\n§12 a second press is a no-op; two at once restore once");
	{
		const SA = USERS["Super Admin"];
		const w = restoreWorld();
		const id = tombstoneId(w.db, "lx-1002");
		const first = await callRestore(w.chain, SA, { id });
		const second = await callRestore(w.chain, SA, { id });
		eq("the first restores, the second is 404 NOT_DELETED", [first.status, second.status, second.body && second.body.code], [200, 404, "NOT_DELETED"]);
		const restores = (lid) => w.db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action = 'restore_load' AND entity_id = ?").get(lid).n;
		eq("...and writes no second audit row", restores("lx-1002"), 1);
		const id5 = tombstoneId(w.db, "lx-1005");
		const both = await Promise.all([callRestore(w.chain, SA, { id: id5 }), callRestore(w.chain, SA, { id: id5 })]);
		eq("two presses at once: one 200, one 404", both.map((r) => r.status).sort(), [200, 404]);
		eq("...one audit row, the delete gone", [restores("lx-1005"), tombstoneId(w.db, "lx-1005")], [1, undefined]);
	}

	console.log("\n§13 the audit row");
	{
		const SA = USERS["Super Admin"];
		const w = restoreWorld();
		const id = tombstoneId(w.db, "lx-1002");
		const r = await callRestore(w.chain, SA, { id });
		eq("the answer: restored, its months, nothing else hiding it", r.body, { ok: true, mode: "restore", restored: { id, loadId: "lx-1002", months: ["2026-10"] }, remaining: 0 });
		const rows = w.db.prepare("SELECT * FROM audit_trail WHERE action IN ('restore_load', 'clear_load_delete') ORDER BY id").all();
		eq("exactly one row", rows.length, 1);
		const a = rows[0] || {};
		eq("the acting Super Admin, the action, the load", [a.user_id, a.username, a.role, a.action, a.entity, a.entity_id], [1, "super_admin", "Super Admin", "restore_load", "load", "lx-1002"]);
		ok("its time is an ISO instant", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(a.timestamp || ""), a.timestamp);
		ok("its details name the delete record, when and by whom, the month and the reason",
			[`deleted_loads row ${id}`, "2026-10-20T12:00:00Z", "by admin_two", "settlement month 2026-10", `Reason: ${REASON}`].every((s) => (a.details || "").includes(s)), a.details);
		eq("announced once, the cache dropped once", [w.rec.changes, w.rec.invalidations], [["dashboard"], 1]);
		eq("one Super Admin notice, naming the load, who restored it and the reason", w.rec.notices.map((n) => [n.type, n.title, n.body]),
			[["deleted-load-restored", "Load lx-1002 was restored", `Restored by super_admin. Reason: ${REASON}`]]);

		// "Create it as new" through the same route, for a delete made when no row held the ID (LX-2000 is live at row 9).
		const fresh = w.db.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_at, deleted_by) VALUES ('lx-2000', 0, '2026-10-23 10:00:00', 'admin_two')").run().lastInsertRowid;
		const asNew = await callRestore(w.chain, SA, { id: fresh, body: { mode: "create_new" } });
		const clear = w.db.prepare("SELECT * FROM audit_trail WHERE entity_id = 'lx-2000' ORDER BY id").all();
		eq("\"Create it as new\" through the same route: one clear_load_delete row with the reason, the delete gone, one more notice",
			[asNew.status, asNew.body && asNew.body.mode, clear.map((x) => x.action), (clear[0] && clear[0].details || "").endsWith(`Reason: ${REASON}`), tombstoneId(w.db, "lx-2000"), w.rec.notices.length],
			[200, "create_new", ["clear_load_delete"], true, undefined, 2]);
		// LX-1005's delete was made over its row 4 and recorded no rows or month, so that row may be its own (M3).
		const id5 = tombstoneId(w.db, "lx-1005");
		const before5 = fingerprint(w.db);
		const own = await callRestore(w.chain, SA, { id: id5, body: { mode: "create_new" } });
		eq("...refused 409 DELETED_ROWS_PRESENT while a row that may be the delete's own is live, naming it; nothing changed",
			[own.status, own.body && own.body.code, own.body && own.body.rows, own.body && own.body.error, fingerprint(w.db) === before5],
			[409, "DELETED_ROWS_PRESENT", [4], "Row 4 may be load lx-1005's row from before its delete, so creating it as new could bring that row back too. Restore the deleted load instead, or remove that row first. Nothing was changed.", true]);

		const db = makeDb();
		const failing = restoreWorld({ db });
		db.exec("ALTER TABLE audit_trail RENAME TO audit_trail_away");
		const before = JSON.stringify(db.prepare("SELECT * FROM deleted_loads ORDER BY id").all());
		const f = await callRestore(failing.chain, SA, { id: tombstoneId(db, "lx-1002") });
		db.exec("ALTER TABLE audit_trail_away RENAME TO audit_trail");
		eq("an audit row that can't be written: 500, the delete kept, nothing announced",
			[f.status, f.body && f.body.code, JSON.stringify(db.prepare("SELECT * FROM deleted_loads ORDER BY id").all()) === before, failing.rec.changes],
			[500, "RESTORE_FAILED", true, []]);
	}

	console.log("\n§14 restored, the load counts again");
	{
		const SA = USERS["Super Admin"];
		const db = makeDb();
		const w = restoreWorld({ db });
		const H = w.H;
		const has = (rows) => rows.some((x) => x["Load ID"] === "LX-1002");
		eq("before: excludeDroppedLoads() and the live view leave it out", [has(H.excludeDroppedLoads(JT.data, HEADERS)), has(H.liveJobTrackingView(JT).data)], [false, false]);
		await callRestore(w.chain, SA, { id: tombstoneId(db, "lx-1002") });
		eq("after: both count it", [has(H.excludeDroppedLoads(JT.data, HEADERS)), has(H.liveJobTrackingView(JT).data)], [true, true]);
		const list = await call(build(ROUTE, db, JT).chain, SA);
		eq("...and the deleted list no longer shows it", [((list.body && list.body.loads) || []).some((l) => l.loadId === "lx-1002"), list.body && list.body.count], [false, 5]);

		// A load deleted twice has two delete records; each is restored on its own.
		const twins = makeDb();
		twins.prepare("INSERT INTO deleted_loads (load_id, row_index, deleted_at, deleted_by) VALUES ('lx-1002', 3, '2026-10-20 12:00:00', 'admin_two')").run();
		const t = restoreWorld({ db: twins });
		const ids = twins.prepare("SELECT id FROM deleted_loads WHERE load_id = 'lx-1002' ORDER BY id").all().map((x) => x.id);
		const one = await callRestore(t.chain, SA, { id: ids[0] });
		eq("one of two: restored, the answer says one more still hides it, and it still doesn't count",
			[one.status, one.body && one.body.remaining, has(t.H.excludeDroppedLoads(JT.data, HEADERS))], [200, 1, false]);
		const other = await callRestore(t.chain, SA, { id: ids[1] });
		eq("the other: restored, none left, it counts", [other.status, other.body && other.body.remaining, has(t.H.excludeDroppedLoads(JT.data, HEADERS))], [200, 0, true]);
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
