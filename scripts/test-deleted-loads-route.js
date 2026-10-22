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
 *
 * WHAT IS REAL. The route registration, requireRole, periodLocksReadable,
 * isLocked, jobTrackingMonthCols, loadRowPeriods (and the date readers under
 * it), pickAddressColumn and resolveCityState (and the address split under it)
 * are lifted out of server.js and run as shipped; lib/deleted-loads-view.js and
 * normalizeLoadId() are required. The database is a better-sqlite3 :memory:
 * with the four tables the route reads. Stubbed: the Job Tracking read (made-up
 * rows) and tripDayLockCover() (null: the trip work-day rule is off).
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
function build(routeText, db, jobTracking) {
	const reads = { sheet: 0 };
	const getJobTrackingCached = async () => {
		reads.sheet++;
		if (jobTracking instanceof Error) throw jobTracking;
		return jobTracking;
	};
	let captured = null;
	const app = { get: (p, ...chain) => { captured = chain; } };
	const quiet = { log() {}, warn() {}, error() {} };
	const body = [
		...liftedConsts.map(([, t]) => t),
		...lifted.map(([, t]) => t),
		routeText,
		"return { requireRole };",
	].join("\n\n");
	const scope = new Function(
		"app", "db", "getJobTrackingCached", "tripDayLockCover", "deletedLoadsView", "normalizeLoadId", "APP_TIMEZONE", "console",
		body,
	)(app, db, getJobTrackingCached, () => null, deletedLoadsView, normalizeLoadId, "America/New_York", quiet);
	return { chain: captured, reads, requireRole: scope.requireRole };
}

const USERS = {
	"Super Admin": { id: 1, role: "Super Admin", username: "super_admin" },
	Dispatcher: { id: 2, role: "Dispatcher", username: "dispatch_test" },
	Driver: { id: 3, role: "Driver", username: "LogisX-9001", driverName: "Test Driver One" },
	Investor: { id: 4, role: "Investor", username: "investor_test" },
};
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

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
