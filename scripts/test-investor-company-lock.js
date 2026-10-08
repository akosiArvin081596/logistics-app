#!/usr/bin/env node
/**
 * An investor's company name is held to the month-end lock (2026-10-08).
 *
 * THE BUG. getInvestorDriverSet() legs 2 and 3 give an investor every driver
 * whose drivers_directory carrier or carrier_driver_history carrier is the
 * investor's users.company_name (trimmed, case aside), with no month dimension.
 * Nothing judged a write to that company name, or to whether the account is an
 * investor at all: PUT /api/users/:id {companyName} on an Investor, a role change
 * to or from Investor, and POST /api/users creating an Investor with a company
 * name each moved whole drivers onto or off an investor's ledger, finalized
 * months included, for every reader that recomputes them. (Accepting an investor
 * application is the third path: scripts/test-investor-accept-guards.js §10.)
 *
 * THE FIX. Each write is judged by the ledger membership it moves:
 * investorCompanyLockBlockers() compares the account's own getInvestorDriverSet()
 * before and after the write, key for key, with the carrier the same save's
 * directory sync writes already in the "after" directory, and sizes each moved
 * driver's exposure off driverHistoryFloorMonth(), the question
 * directoryEditLockBlockers() check (5) asks of a directory carrier. A move that
 * reaches a finalized month is refused whole through periodBlockedResponse(): 409
 * PERIOD_FINALIZED, nothing written, the refusal audited (update_user_blocked on
 * PUT, create_user_blocked on POST). A change that keeps every link (case or
 * edge spaces), a company no driver with finalized-month history is linked
 * through, and drivers the investor also holds through its own trucks go
 * through.
 *
 * WHAT RUNS. PUT /api/users/:id and POST /api/users lifted whole out of server.js
 * over an in-memory SQLite, with server.js's own getInvestorDriverSet(),
 * investorsHoldingDriver(), directory-sync judgement (accountDirectorySync()),
 * month-end lock, refusal responses and audit writers. Stubbed: bcrypt, Job
 * Tracking (a counter), the history floor (a per-driver answer), the rename
 * machinery (no case renames a driver), the directory sync's write (a counter)
 * and sessions.
 *   §1 a refused company change: off a ledger and onto one
 *   §2 an allowed rename that keeps every link, and a company that links nobody
 *   §3 drivers with no finalized-month history
 *   §4 role changes to and from Investor
 *   §5 POST /api/users creating an Investor with a company name
 *   §6 Job Tracking unreadable
 *
 * Pure: no server, no app.db, no network.
 *   node scripts/test-investor-company-lock.js
 *   SERVER_JS=/tmp/base.js node scripts/test-investor-company-lock.js   # a base commit: fails
 */
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
const failures = [];
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function check(label, cond) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.log(`  FAIL  ${label}`);
}

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run it under the .nvmrc Node`);
}

function findOnce(needle, what) {
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 ${what}, found ${hits}`);
	return SRC.indexOf(needle) + 1;
}
function liftFunction(name, prefix = "function") {
	const a = findOnce(`\n${prefix} ${name}(`, `definition of ${name}()`);
	return SRC.slice(a, SRC.indexOf("\n}\n", a) + 2);
}
function liftNew(name) {
	return SRC.includes(`\nfunction ${name}(`) ? liftFunction(name) : "";
}
function liftConst(head, close = null) {
	const a = findOnce(`\n${head}`, `statement starting ${JSON.stringify(head)}`);
	const end = close ? SRC.indexOf(close, a) : SRC.indexOf(";\n", a);
	return SRC.slice(a, end + (close ? close.length : 1));
}
function liftRoute(head, what) {
	const a = findOnce(`\n${head}`, `registration of ${what}`);
	return SRC.slice(a, SRC.indexOf("\n});", a) + "\n});".length);
}
const USERS_ROUTE = liftRoute('app.post("/api/users", requireRole("Super Admin"), async (req, res) => {', "POST /api/users");
const USER_PUT_ROUTE = liftRoute('app.put("/api/users/:id", requireRole("Super Admin"), async (req, res) => {', "PUT /api/users/:id");

const NEW_HELPERS = ["investorAccountState", "investorCompanyMoves", "investorCompanyLockBlockers"];
const MODULE_SRC = [
	liftFunction("logAudit"),
	liftConst("const REFUSAL_AUDIT_WINDOW_MS = "),
	liftConst("const refusalAuditWindows = "),
	liftConst("const UNCOALESCED_REFUSAL_CODES = new Set([", "\n]);"),
	liftFunction("logAuditRefusal"),
	liftFunction("scrubPurgeMarker"),
	liftConst("const AUDITED_UPSTREAM = "),
	liftFunction("auditText"),
	liftFunction("periodRefusalDetail"),
	liftFunction("recordPeriodRefusal"),
	liftFunction("periodLabel"),
	liftFunction("periodBlockedResponse"),
	liftFunction("periodLockUnreadableResponse"),
	liftFunction("periodLockStmt"),
	liftFunction("isLocked"),
	liftFunction("periodLocksReadable"),
	liftFunction("lockedPeriodsDesc"),
	liftFunction("userUpdateLockBlockers"),
	liftFunction("directoryPayStruct"),
	liftConst("const DIRECTORY_PERIOD_COLUMNS = "),
	liftFunction("directoryChangedColumns"),
	liftFunction("normalizeDriverName"),
	liftFunction("isBuiltInPropertyName"),
	liftFunction("findDriverNameClashes"),
	liftFunction("findDriverNameClash"),
	liftFunction("findDirectoryRowForDriver"),
	liftFunction("findCol"),
	liftFunction("getCarrierDBFromSQLite"),
	liftFunction("getInvestorDriverSet"),
	liftFunction("investorsHoldingDriver"),
	liftConst("const DIRECTORY_DEFAULT_STRUCT = "),
	liftFunction("driverPayLockedMonths"),
	liftFunction("truckDailyRateCandidates"),
	liftFunction("resolveDailyRate"),
	liftFunction("directoryEditLockBlockers"),
	liftFunction("directoryDefaultRow"),
	liftFunction("directoryCreateLockBlockers"),
	liftFunction("accountDirectoryRowJudged"),
	liftFunction("accountDirectoryRowLock"),
	liftFunction("accountCompanyChange"),
	liftFunction("accountDirectorySync"),
	liftFunction("accountDirectorySyncLock"),
	...NEW_HELPERS.map(liftNew),
].join("\n");
const MODULE_EXPORTS = ["logAudit", "auditText", "recordPeriodRefusal", "periodBlockedResponse", "periodLockUnreadableResponse", "periodLabel",
	"userUpdateLockBlockers", "normalizeDriverName", "findDriverNameClash", "findDriverNameClashes", "findDirectoryRowForDriver",
	"accountDirectoryRowJudged", "accountDirectoryRowLock", "accountCompanyChange", "accountDirectorySync", "accountDirectorySyncLock",
	...NEW_HELPERS.filter((n) => SRC.includes(`\nfunction ${n}(`))];

const LOCKED = ["2026-06", "2026-07", "2026-08"];
const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };

function auditDdl() {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS audit_trail \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE audit_trail");
	return `CREATE TABLE audit_trail (${m[1]}\n)`;
}
const DDL = [
	auditDdl(),
	`CREATE TABLE drivers_directory (
		id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
		carrier_name TEXT DEFAULT '', email TEXT DEFAULT '', status TEXT DEFAULT 'active',
		pay_type TEXT DEFAULT 'fixed', pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0)`,
	`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT,
		driver_name TEXT DEFAULT '', email TEXT DEFAULT '', full_name TEXT DEFAULT '', company_name TEXT NOT NULL DEFAULT '')`,
	"CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, assigned_driver TEXT DEFAULT '', driver_pay_daily REAL DEFAULT 0, owner_id INTEGER DEFAULT 0)",
	"CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '')",
	"CREATE TABLE carrier_driver_history (id INTEGER PRIMARY KEY AUTOINCREMENT, carrier_name TEXT, driver_name TEXT, started_at TEXT, ended_at TEXT)",
	"CREATE TABLE investor_payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, period TEXT, status TEXT, paid_at TEXT DEFAULT '', finalized_at TEXT DEFAULT '')",
	"CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked')",
];

// The history floor each driver's loads give (driverHistoryFloorMonth()'s answer).
const FLOORS = {
	"cara carrier": { floor: "2026-06", unbounded: false },
	"tara truck": { floor: "2026-06", unbounded: false },
	"hank history": { floor: "2026-07", unbounded: false },
	"dee history": { floor: "2026-08", unbounded: false },
	"ann owner": { floor: "2026-06", unbounded: false },
	"jon smith": { floor: "2026-07", unbounded: false },
	"nora norow": { floor: "2026-08", unbounded: false },
};
const S = { jtReads: 0, jtFails: false, syncs: 0 };
const JT = { headers: ["Load ID", "Driver", "Assigned Date"], data: [] };

// Fictional fleet. Acme Leasing (7) owns a truck Tara Truck drives, and its
// company name links Cara Carrier (directory) and Hank History (carrier history)
// besides; Beta Freight (8) owns a truck and links nobody by name; Gamma Haul (9)
// links only Gil New, a new hire; Delta Lines (11) owns no truck and links Dee
// History. Account 10 is a Dispatcher whose company name is Acme Leasing. Echo
// Haul (12) owns no truck and links Jon Smith through his directory row, while a
// carrier-history row files him under another spelling ("Jon  Smith") and another
// company ("Echo Haul Inc"). Account 13 is a Driver, Ann Owner, whose company and
// directory carrier are House Carrier, which no investor has. Accounts 14 and 15
// are Drivers with no directory row and no company: Nora Norow, with August
// loads, and Ned Newcomer, with none.
function seed(db) {
	for (const p of LOCKED) db.prepare("INSERT INTO period_locks (period, status) VALUES (?, 'locked')").run(p);
	const user = db.prepare("INSERT INTO users (id, username, role, company_name, email) VALUES (?, ?, ?, ?, ?)");
	user.run(1, "super_admin", "Super Admin", "", "ops@example.test");
	user.run(7, "acme", "Investor", "Acme Leasing", "acme@example.test");
	user.run(8, "beta", "Investor", "Beta Freight", "beta@example.test");
	user.run(9, "gamma", "Investor", "Gamma Haul", "gamma@example.test");
	user.run(10, "desk", "Dispatcher", "Acme Leasing", "desk@example.test");
	user.run(11, "delta", "Investor", "Delta Lines", "delta@example.test");
	user.run(12, "echo", "Investor", "Echo Haul", "echo@example.test");
	db.prepare("INSERT INTO users (id, username, role, driver_name, company_name, email) VALUES (13, 'ann', 'Driver', 'Ann Owner', 'House Carrier', 'ann@example.test')").run();
	db.prepare("INSERT INTO users (id, username, role, driver_name, company_name, email) VALUES (14, 'nora', 'Driver', 'Nora Norow', '', 'nora@example.test')").run();
	db.prepare("INSERT INTO users (id, username, role, driver_name, company_name, email) VALUES (15, 'ned', 'Driver', 'Ned Newcomer', '', 'ned@example.test')").run();
	db.prepare("INSERT INTO trucks (id, unit_number, assigned_driver, owner_id) VALUES (1, 'AC-1', 'Tara Truck', 7), (2, 'BF-1', 'Bo Beta', 8)").run();
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (1, 'Tara Truck', '2026-05-02T15:00:00.000Z'), (2, 'Bo Beta', '2026-05-02T15:00:00.000Z')").run();
	const dir = db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name) VALUES (?, ?)");
	dir.run("Cara Carrier", "Acme Leasing");
	dir.run("Tara Truck", "Acme Leasing");
	dir.run("Bo Beta", "");
	dir.run("Gil New", "Gamma Haul");
	dir.run("Ann Owner", "House Carrier");
	dir.run("Jon Smith", "Echo Haul");
	const hist = db.prepare("INSERT INTO carrier_driver_history (carrier_name, driver_name, started_at, ended_at) VALUES (?, ?, ?, NULL)");
	hist.run("Acme Leasing", "Hank History", "2026-07-03T15:00:00.000Z");
	hist.run("Delta Lines", "Dee History", "2026-08-04T15:00:00.000Z");
	hist.run("Echo Haul Inc", "Jon  Smith", "2026-07-05T15:00:00.000Z");
}

function makeApp() {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	seed(db);
	const quiet = { error() {}, log() {}, warn() {} };
	const historyFloor = (name, jt) => (jt
		? FLOORS[String(name || "").trim().toLowerCase().replace(/\s+/g, " ")] || { floor: "", unbounded: false }
		: { floor: "", unbounded: true });
	const m = new Function("db", "driverHistoryFloorMonth", "console",
		`"use strict";\n${MODULE_SRC}\nreturn { ${MODULE_EXPORTS.join(", ")} };`)(db, historyFloor, quiet);
	const readJt = async () => { S.jtReads++; if (S.jtFails) throw new Error("Job Tracking could not be read"); return JT; };
	const env = {
		db, ...m,
		requireRole: () => (req, res, next) => next(),
		bcrypt: { hash: async () => "hash" },
		getJobTrackingCached: readJt,
		driverHistoryFloorMonth: historyFloor,
		syncDriverToCarrierSheet: () => { S.syncs++; },
		notifyChange: () => {},
		console: quiet,
		// PUT's rename machinery: no case here renames a driver.
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: [["Load ID", "Driver"]] } }) } } }),
		SPREADSHEET_ID: "not-a-sheet",
		driverRenameMergeScan: () => ({ mergeTargets: {}, mergeRows: 0 }),
		applyDriverRenameSqlite: () => ({ counts: {} }),
		purgeUserSessions: () => 0,
		refreshOwnSession: () => true,
	};
	const register = (method, src) => {
		let handler = null;
		const e = { ...env, app: { [method]: (p, guard, h) => { handler = h; } } };
		const names = Object.keys(e);
		new Function(...names, src)(...names.map((k) => e[k]));
		if (typeof handler !== "function") die(`the lifted ${method.toUpperCase()} route did not register a handler`);
		return handler;
	};
	const postHandler = register("post", USERS_ROUTE);
	const putHandler = register("put", USER_PUT_ROUTE);
	const call = async (handler, params, body) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
		await handler({ session: { user: SUPER }, sessionID: "sid", params, query: {}, body }, res);
		return out;
	};
	return {
		db,
		updateUser: (id, body) => call(putHandler, { id: String(id) }, body),
		createUser: (body) => call(postHandler, {}, body),
	};
}

function reset() {
	Object.assign(S, { jtReads: 0, jtFails: false, syncs: 0 });
	return makeApp();
}
// Everything these writes could change.
const fingerprint = (db) => JSON.stringify({
	users: db.prepare("SELECT id, username, role, company_name, email FROM users ORDER BY id").all(),
	directory: db.prepare("SELECT driver_name, carrier_name FROM drivers_directory ORDER BY id").all(),
	history: db.prepare("SELECT carrier_name, driver_name FROM carrier_driver_history ORDER BY id").all(),
	trucks: db.prepare("SELECT id, assigned_driver, owner_id FROM trucks ORDER BY id").all(),
});
const audits = (db, action) => db.prepare("SELECT action, entity, entity_id, details FROM audit_trail WHERE action = ? ORDER BY id").all(action);
const account = (db, id) => db.prepare("SELECT role, company_name FROM users WHERE id = ?").get(id);
const got = (r) => `got ${r.status} ${(r.body || {}).code || ""}`.trim();
const refused = (r, periods) => r.status === 409 && r.body && r.body.code === "PERIOD_FINALIZED" &&
	JSON.stringify(r.body.periods) === JSON.stringify(periods);
const driversIn = (r) => (r.body && Array.isArray(r.body.blockers) ? r.body.blockers.flatMap((b) => b.drivers || []) : []).sort();

(async () => {
	console.log("§1 a refused company change");
	{
		// Off a ledger: the new name no longer matches Cara's directory row or Hank's
		// carrier history. Tara stays, held by Acme's own truck.
		const { db, updateUser } = reset();
		const before = fingerprint(db);
		const r = await updateUser(7, { companyName: "Acme Leasing Co" });
		check(`§1 an investor's company changed so two linked drivers with finalized-month history leave its ledger: 409 PERIOD_FINALIZED over ${LOCKED.join(", ")} (${got(r)})`,
			refused(r, LOCKED));
		check(`§1 …names the drivers that move and only those (got ${JSON.stringify(driversIn(r))})`,
			JSON.stringify(driversIn(r)) === JSON.stringify(["Cara Carrier", "Hank History"]));
		check("§1 …the reason is the server's message, naming the drivers and the finalized months",
			typeof r.body.error === "string" && /Cara Carrier/.test(r.body.error) && /Hank History/.test(r.body.error) && /June 2026/.test(r.body.error));
		check("§1 …nothing written", fingerprint(db) === before && S.syncs === 0);
		const rows = audits(db, "update_user_blocked");
		check(`§1 …the refusal is audited as update_user_blocked [PERIOD_FINALIZED], naming the company change (rows ${rows.length})`,
			rows.length === 1 && rows[0].entity === "user" && rows[0].entity_id === "7" && /\[PERIOD_FINALIZED\]/.test(rows[0].details) &&
			/Acme Leasing Co/.test(rows[0].details));
		check("§1 …and no update_user line", audits(db, "update_user").length === 0);
		check(`§1 …Job Tracking read once (reads ${S.jtReads})`, S.jtReads === 1);
	}
	{
		// Onto a ledger: Beta takes Acme's company name, and with it Cara, Hank and
		// Tara (Acme's truck holds Tara for Acme, not for Beta).
		const { db, updateUser } = reset();
		const before = fingerprint(db);
		const r = await updateUser(8, { companyName: "acme leasing" });
		check(`§1 an investor takes a company name that links drivers with finalized-month history: 409 PERIOD_FINALIZED (${got(r)})`,
			refused(r, LOCKED) && JSON.stringify(driversIn(r)) === JSON.stringify(["Cara Carrier", "Hank History", "Tara Truck"]));
		check("§1 …nothing written, audited", fingerprint(db) === before && audits(db, "update_user_blocked").length === 1);
	}
	{
		// The ledger keys a driver by name trimmed and lower-cased, nothing more, so
		// "Jon Smith" (the directory row, under the old name) and "Jon  Smith" (a
		// carrier-history row, under the new one) are two keys: the rename takes the
		// first off the ledger and puts the second on, each with its loads.
		const { db, updateUser } = reset();
		const before = fingerprint(db);
		const r = await updateUser(12, { companyName: "Echo Haul Inc" });
		check(`§1 a rename that swaps one spelling of a driver for another on the ledger: 409 PERIOD_FINALIZED over 2026-07, 2026-08, naming both (${got(r)}, ${JSON.stringify(driversIn(r))})`,
			refused(r, ["2026-07", "2026-08"]) && JSON.stringify(driversIn(r)) === JSON.stringify(["Jon  Smith", "Jon Smith"]));
		check("§1 …nothing written", fingerprint(db) === before);
	}

	console.log("§2 an allowed change that keeps every closed-month attribution");
	{
		// The ledger legs compare the name trimmed and case aside, so this keeps
		// every link.
		const { db, updateUser } = reset();
		const r = await updateUser(7, { companyName: "  ACME LEASING " });
		check(`§2 a change of case and edge spaces: 200, saved as sent (${got(r)}, stored ${JSON.stringify(account(db, 7).company_name)})`,
			r.status === 200 && account(db, 7).company_name === "  ACME LEASING ");
		check(`§2 …judged nothing: no Job Tracking read, no refusal (reads ${S.jtReads})`,
			S.jtReads === 0 && audits(db, "update_user_blocked").length === 0 && audits(db, "update_user").length === 1);
	}
	{
		const { db, updateUser } = reset();
		const r = await updateUser(8, { companyName: "Beta Freight Inc" });
		check(`§2 a rename whose old and new names link no driver: 200 (${got(r)}, reads ${S.jtReads})`,
			r.status === 200 && account(db, 8).company_name === "Beta Freight Inc" && S.jtReads === 0);
	}
	{
		const { db, updateUser } = reset();
		const r = await updateUser(7, { companyName: "Acme Leasing", email: "new@example.test", fullName: "Acme Leasing LLC" });
		check(`§2 the stored company name sent back with other fields: 200 (${got(r)})`,
			r.status === 200 && account(db, 7).company_name === "Acme Leasing" && S.jtReads === 0);
	}
	{
		// Every driver the old name links is held by the investor's own truck too.
		const { db, updateUser } = reset();
		db.prepare("DELETE FROM drivers_directory WHERE driver_name = 'Cara Carrier'").run();
		db.prepare("DELETE FROM carrier_driver_history WHERE driver_name = 'Hank History'").run();
		const r = await updateUser(7, { companyName: "Acme Leasing Co" });
		check(`§2 a rename whose only linked driver also drives the investor's truck: 200 (${got(r)})`,
			r.status === 200 && account(db, 7).company_name === "Acme Leasing Co");
	}

	console.log("§3 drivers with no finalized-month history");
	{
		const { db, updateUser } = reset();
		const r = await updateUser(9, { companyName: "Gamma Haul LLC" });
		check(`§3 an investor whose only linked driver has no finalized-month history: 200 (${got(r)}, reads ${S.jtReads})`,
			r.status === 200 && account(db, 9).company_name === "Gamma Haul LLC" && S.jtReads === 1 && audits(db, "update_user_blocked").length === 0);
	}
	{
		const { db, updateUser } = reset();
		const r = await updateUser(8, { companyName: "Gamma Haul" });
		check(`§3 an investor takes a company name whose drivers have no finalized-month history: 200 (${got(r)})`,
			r.status === 200 && account(db, 8).company_name === "Gamma Haul");
	}

	console.log("§4 role changes to and from Investor");
	{
		const { db, updateUser } = reset();
		const before = fingerprint(db);
		const r = await updateUser(10, { role: "Investor" });
		check(`§4 a Dispatcher whose company name links drivers with finalized-month history made an Investor: 409 PERIOD_FINALIZED (${got(r)})`,
			refused(r, LOCKED) && JSON.stringify(driversIn(r)) === JSON.stringify(["Cara Carrier", "Hank History", "Tara Truck"]));
		check("§4 …nothing written, audited as update_user_blocked", fingerprint(db) === before && account(db, 10).role === "Dispatcher" &&
			audits(db, "update_user_blocked").length === 1);
	}
	{
		const { db, updateUser } = reset();
		const before = fingerprint(db);
		const r = await updateUser(11, { role: "Dispatcher" });
		check(`§4 an Investor with no truck whose company name links a driver with finalized-month history made a Dispatcher: 409 PERIOD_FINALIZED over 2026-08 (${got(r)})`,
			refused(r, ["2026-08"]) && JSON.stringify(driversIn(r)) === JSON.stringify(["Dee History"]));
		check("§4 …nothing written", fingerprint(db) === before && account(db, 11).role === "Investor");
	}
	{
		const { db, updateUser } = reset();
		const r = await updateUser(10, { role: "Investor", companyName: "" });
		check(`§4 the same Dispatcher made an Investor with the company name cleared: 200 (${got(r)})`,
			r.status === 200 && account(db, 10).role === "Investor" && account(db, 10).company_name === "");
	}
	{
		const { db, updateUser } = reset();
		const r = await updateUser(9, { role: "Dispatcher" });
		check(`§4 an Investor whose linked driver has no finalized-month history made a Dispatcher: 200 (${got(r)})`,
			r.status === 200 && account(db, 9).role === "Dispatcher");
	}
	{
		// One save, two changes: the Driver becomes an Investor under a new company
		// name, and the directory sync then gives her own row that name as its
		// carrier. Neither change alone links her; together they put her own
		// finalized months on her new ledger.
		const { db, updateUser } = reset();
		const before = fingerprint(db);
		const r = await updateUser(13, { role: "Investor", companyName: "Ann Owner Trucking" });
		check(`§4 a Driver made an Investor under a company name the same save gives her own directory row: 409 PERIOD_FINALIZED (${got(r)}, ${JSON.stringify(driversIn(r))})`,
			refused(r, LOCKED) && JSON.stringify(driversIn(r)) === JSON.stringify(["Ann Owner"]));
		check("§4 …nothing written, no directory sync", fingerprint(db) === before && S.syncs === 0 && account(db, 13).role === "Driver");
	}
	{
		// The same save on a Driver with no directory row yet: the sync would add her
		// first row under the new company name.
		const { db, updateUser } = reset();
		const before = fingerprint(db);
		const r = await updateUser(14, { role: "Investor", companyName: "Nora Freight" });
		check(`§4 a Driver with no directory row made an Investor under a company name the sync would give her first row: 409 PERIOD_FINALIZED over 2026-08 (${got(r)}, ${JSON.stringify(driversIn(r))})`,
			refused(r, ["2026-08"]) && JSON.stringify(driversIn(r)) === JSON.stringify(["Nora Norow"]));
		check("§4 …nothing written, no directory sync", fingerprint(db) === before && S.syncs === 0);
	}
	{
		const { db, updateUser } = reset();
		const r = await updateUser(15, { role: "Investor", companyName: "Ned Freight" });
		check(`§4 the same save for a Driver with no finalized-month history: 200, saved, the directory sync run (${got(r)}, syncs ${S.syncs})`,
			r.status === 200 && account(db, 15).role === "Investor" && account(db, 15).company_name === "Ned Freight" && S.syncs === 1);
	}

	console.log("§5 POST /api/users creating an Investor with a company name");
	{
		const { db, createUser } = reset();
		const before = fingerprint(db);
		const r = await createUser({ username: "newinv", password: "pw-Long-enough-1", role: "Investor", companyName: "Acme Leasing" });
		check(`§5 a new Investor whose company name links drivers with finalized-month history: 409 PERIOD_FINALIZED (${got(r)})`,
			refused(r, LOCKED) && JSON.stringify(driversIn(r)) === JSON.stringify(["Cara Carrier", "Hank History", "Tara Truck"]));
		const rows = audits(db, "create_user_blocked");
		check("§5 …no account, audited as create_user_blocked [PERIOD_FINALIZED]",
			fingerprint(db) === before && rows.length === 1 && /\[PERIOD_FINALIZED\]/.test(rows[0].details) && /newinv/.test(rows[0].details));
	}
	for (const [label, company, reads] of [
		["a company name whose drivers have no finalized-month history", "Gamma Haul", 1],
		["a company name that links nobody", "Brand New Hauling", 0],
	]) {
		const { db, createUser } = reset();
		const r = await createUser({ username: "newinv", password: "pw-Long-enough-1", role: "Investor", companyName: company });
		const row = db.prepare("SELECT role, company_name FROM users WHERE username = 'newinv'").get();
		check(`§5 a new Investor, ${label}: 200, created with it (${got(r)}, reads ${S.jtReads})`,
			r.status === 200 && row && row.company_name === company && S.jtReads === reads);
	}
	{
		const { db, createUser } = reset();
		const r = await createUser({ username: "newdesk", password: "pw-Long-enough-1", role: "Dispatcher", companyName: "Acme Leasing" });
		check(`§5 a new Dispatcher with an investor's company name (not an investor): 200 (${got(r)}, reads ${S.jtReads})`,
			r.status === 200 && !!db.prepare("SELECT 1 FROM users WHERE username = 'newdesk'").get() && S.jtReads === 0);
	}

	console.log("§6 Job Tracking unreadable");
	{
		// A moved driver's history cannot be dated without the sheet, so every
		// finalized month is held.
		const { db, updateUser } = reset();
		S.jtFails = true;
		const before = fingerprint(db);
		const r = await updateUser(9, { companyName: "Gamma Haul LLC" });
		check(`§6 a move judged without Job Tracking: 409 PERIOD_FINALIZED over every finalized month, nothing written (${got(r)})`,
			refused(r, LOCKED) && fingerprint(db) === before);
	}
	{
		const { db, createUser } = reset();
		S.jtFails = true;
		const before = fingerprint(db);
		const r = await createUser({ username: "newinv", password: "pw-Long-enough-1", role: "Investor", companyName: "Gamma Haul" });
		check(`§6 POST /api/users, a new Investor whose company name links a driver, Job Tracking unreadable: 409 over every finalized month, no account (${got(r)})`,
			refused(r, LOCKED) && fingerprint(db) === before);
	}
	{
		// The Driver path of the same read (accountDirectoryRowLock()): without the
		// sheet a new hire's history cannot be dated either, so an investor's company
		// as the carrier of the row the account adds is held, not answered with a 500.
		const { db, createUser } = reset();
		S.jtFails = true;
		const before = fingerprint(db);
		const r = await createUser({ username: "pat", password: "pw-Long-enough-1", role: "Driver", driverName: "Pat Newhire", companyName: "Acme Leasing" });
		check(`§6 POST /api/users, a Driver whose company is an investor's, Job Tracking unreadable: 409 over every finalized month, no account (${got(r)})`,
			refused(r, LOCKED) && fingerprint(db) === before);
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
