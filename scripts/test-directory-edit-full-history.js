#!/usr/bin/env node
/**
 * PUT and DELETE /api/drivers-directory/:id size a driver's exposure off their
 * full history, as the create does (2026-10-04).
 *
 * THE BUG. The month-end lock on an edit or a delete asked which finalized
 * months a driver's pay reaches from truck_assignments alone: every month from
 * their first assignment row on. A driver whose loads in Job Tracking predate
 * that row (they drove before assignments were recorded, or an assignment was
 * re-made later) read as having no finalized month at all. So "add the driver on
 * the default terms, then edit them to a percentage" (or delete a row with terms
 * of its own) re-derived their pay in finalized months they worked, with 200.
 * POST /api/drivers-directory already sized exposure off driverHistoryFloorMonth()
 * (Job Tracking, excluded days, receipts and truck_assignments).
 *
 * THE FIX. The PUT and the DELETE read Job Tracking first (the handler's one
 * await, and only when the save could move one of the five settlement columns),
 * then hand driverHistoryFloorMonth()'s answer to the lock, for the row's name
 * and, on a rename, for the new name. Everything after the await re-reads the
 * row. A contact-only edit reads nothing.
 *
 * WHAT RUNS. Both routes lifted whole out of server.js over an in-memory SQLite,
 * with server.js's own pay helpers, name checks and month-end lock. Stubbed: Job
 * Tracking (a counter, or a failure), the history floor (a per-driver answer;
 * the floor itself is scripts/test-truck-create-new-driver.js's subject), the
 * investor-ledger lookup (a per-carrier answer), and the 409 formatters, which
 * record what they are handed.
 *   §1 refused: an edit to a percentage, a day rate or an investor's carrier, and
 *      a delete of a row with terms, for a driver whose only assignment starts in
 *      an open month but whose loads reach finalized ones
 *   §2 allowed: history only in open months; a driver with no record anywhere;
 *      a contact-only edit (no sheet read); a resend of the stored terms
 *   §3 a rename is judged on both names' histories
 *   §4 Job Tracking unreadable: a pay edit is held over every finalized month,
 *      a Dispatcher's pay change is still the audited 403, and a contact edit
 *      does not need it
 *   §5 period locks unreadable: held as before
 *
 * Pure: no server, no app.db, no network.
 *   node scripts/test-directory-edit-full-history.js
 *   SERVER_JS=/tmp/base.js node scripts/test-directory-edit-full-history.js   # a base commit: §1 fails
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

// ── lift the shipped code ───────────────────────────────────────────────────
function findOnce(needle, what) {
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 ${what}, found ${hits}`);
	return SRC.indexOf(needle) + 1;
}
function liftFunction(name) {
	const a = findOnce(`\nfunction ${name}(`, `definition of ${name}()`);
	return SRC.slice(a, SRC.indexOf("\n}\n", a) + 2);
}
function liftConst(head, close = null) {
	const a = findOnce(`\n${head}`, `statement starting ${JSON.stringify(head)}`);
	const end = close ? SRC.indexOf(close, a) : SRC.indexOf(";\n", a);
	return SRC.slice(a, end + (close ? close.length : 1));
}
// A route as registered now (async: it may read Job Tracking) or on a base
// commit (sync).
function liftRoute(verb, route, roles) {
	const heads = [`app.${verb}("${route}", ${roles}, async (req, res) => {`, `app.${verb}("${route}", ${roles}, (req, res) => {`]
		.filter((h) => SRC.includes(`\n${h}`));
	if (heads.length !== 1) die(`expected exactly 1 registration of ${verb.toUpperCase()} ${route}`);
	const a = findOnce(`\n${heads[0]}`, `registration of ${verb.toUpperCase()} ${route}`);
	return SRC.slice(a, SRC.indexOf("\n});", a) + "\n});".length);
}
const PUT_ROUTE = liftRoute("put", "/api/drivers-directory/:id", 'requireRole("Super Admin", "Dispatcher")');
const DELETE_ROUTE = liftRoute("delete", "/api/drivers-directory/:id", 'requireRole("Super Admin")');

const MODULE_SRC = [
	liftConst("const REFUSAL_AUDIT_WINDOW_MS = "),
	liftConst("const refusalAuditWindows = "),
	liftConst("const UNCOALESCED_REFUSAL_CODES = new Set([", "\n]);"),
	liftFunction("logAudit"),
	liftFunction("logAuditRefusal"),
	liftFunction("scrubPurgeMarker"),
	liftFunction("auditText"),
	liftConst("const PAY_EDIT_ADMIN_ONLY = "),
	liftFunction("directoryPayStruct"),
	liftFunction("directoryPayChanges"),
	liftFunction("refusePayEdit"),
	liftFunction("parsePlainDecimal"),
	liftConst("const DRIVER_PAY_DAILY_MAX = "),
	liftFunction("directoryPayValue"),
	liftConst("const DIRECTORY_PERIOD_COLUMNS = "),
	liftFunction("directoryChangedColumns"),
	liftFunction("normalizeDriverName"),
	liftFunction("isBuiltInPropertyName"),
	liftFunction("findDriverNameClashes"),
	liftFunction("findDriverNameClash"),
	liftConst("const DIRECTORY_DEFAULT_STRUCT = "),
	liftConst("const DIRECTORY_LOCK_REMEDY =", "\";\n"),
	liftFunction("lockedPeriodsDesc"),
	liftFunction("driverPayLockedMonths"),
	liftFunction("truckDailyRateCandidates"),
	liftFunction("resolveDailyRate"),
	liftFunction("directoryEditLockBlockers"),
	liftFunction("directoryDeleteLockBlockers"),
	liftFunction("directoryDefaultRow"),
	liftFunction("directoryCreateLockBlockers"),
	SRC.includes("\nfunction directoryEditMayMoveMoney(") ? liftFunction("directoryEditMayMoveMoney") : "",
].join("\n");
const MODULE_EXPORTS = [
	"logAudit", "auditText", "directoryPayChanges", "refusePayEdit", "directoryPayValue", "DRIVER_PAY_DAILY_MAX",
	"directoryChangedColumns", "normalizeDriverName", "isBuiltInPropertyName", "findDriverNameClashes", "findDriverNameClash",
	"DIRECTORY_LOCK_REMEDY", "directoryEditLockBlockers", "directoryDeleteLockBlockers", "directoryDefaultRow",
	...(MODULE_SRC.includes("\nfunction directoryEditMayMoveMoney(") ? ["directoryEditMayMoveMoney"] : []),
];

// ── fixtures ────────────────────────────────────────────────────────────────
const LOCKED = ["2026-06", "2026-07", "2026-08"];
const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const DISPATCHER = { id: 6, username: "dispatch1", role: "Dispatcher" };
const INVESTOR_COMPANY = "ACME LEASING";

function auditDdl() {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS audit_trail \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE audit_trail");
	return `CREATE TABLE audit_trail (${m[1]}\n)`;
}
const DDL = [
	auditDdl(),
	`CREATE TABLE drivers_directory (
		id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
		carrier_name TEXT DEFAULT '', state TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', address TEXT DEFAULT '',
		phone TEXT DEFAULT '', cell TEXT DEFAULT '', email TEXT DEFAULT '', dot TEXT DEFAULT '', mc TEXT DEFAULT '',
		trucks TEXT DEFAULT '', hazmat TEXT DEFAULT '', rating TEXT DEFAULT '', status TEXT DEFAULT 'active',
		pay_type TEXT DEFAULT 'fixed', pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0, profile_picture_url TEXT DEFAULT '')`,
	"CREATE TABLE legal_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_id INTEGER, file_url TEXT)",
	"CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, driver_name TEXT DEFAULT '')",
	"CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, assigned_driver TEXT DEFAULT '', driver_pay_daily REAL DEFAULT 0)",
	"CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '')",
	"CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked')",
];

const S = { locksReadable: true, floors: {}, jtReads: 0, jtFails: false, floorAsked: [], refusals: [] };
const JT = { headers: ["Load ID", "Driver", "Assigned Date"], data: [] };

// Sept Assign drives truck 33 at $275/day. Their only assignment row starts in
// September (open), but their loads in Job Tracking go back to June: the pay math
// prices June, July and August for them.
function makeApp() {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	db.prepare("INSERT INTO trucks (id, unit_number, assigned_driver, driver_pay_daily) VALUES (1, '33', 'Sept Assign', 275)").run();
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (1, 'Sept Assign', '2026-09-02T12:00:00.000Z')").run();
	for (const p of LOCKED) db.prepare("INSERT INTO period_locks (period, status) VALUES (?, 'locked')").run(p);
	const ins = db.prepare("INSERT INTO drivers_directory (id, driver_name, carrier_name, phone, pay_type, pay_percentage, pay_daily) VALUES (?, ?, ?, ?, ?, ?, ?)");
	ins.run(1, "Sept Assign", "", "555-0100", "fixed", 0, 0);                // at the defaults
	ins.run(2, "Pct Sept", "", "555-0101", "percentage", 20, 0);             // terms of their own
	ins.run(3, "Open Only", "", "555-0102", "fixed", 0, 0);                  // history from September only
	ins.run(4, "Nobody Yet", "", "555-0103", "fixed", 0, 0);                 // no record anywhere
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (1, 'Pct Sept', '2026-09-10T12:00:00.000Z')").run();

	const m = new Function("db", "todayKeyCT", "periodLocksReadable", "investorsHoldingDriver",
		`"use strict";\n${MODULE_SRC}\nreturn { ${MODULE_EXPORTS.join(", ")} };`)(
		db, () => "2026-10-04",
		() => S.locksReadable,
		(name, opts = {}) => new Set([opts.carrierOverride, opts.extraHistoryCarrier].some((c) => String(c || "").toUpperCase() === INVESTOR_COMPANY) ? [7] : []));
	const handlers = {};
	const env = {
		app: { put: (p, guard, h) => { handlers.put = h; }, delete: (p, guard, h) => { handlers.delete = h; } },
		requireRole: () => (req, res, next) => next(),
		db, ...m,
		fs: { existsSync: () => false, unlinkSync() {} },
		path, __dirname: "/nonexistent",
		periodLocksReadable: () => S.locksReadable,
		getJobTrackingCached: async () => {
			S.jtReads++;
			if (S.jtFails) throw new Error("Job Tracking could not be read");
			return JT;
		},
		driverHistoryFloorMonth: (name, jt) => {
			S.floorAsked.push({ name, jt });
			return S.floors[m.normalizeDriverName(name)] || { floor: "", unbounded: false };
		},
		periodBlockedResponse: (req, res, what, blockers, remedy, audit) => {
			S.refusals.push({ what, blockers, audit });
			return res.status(409).json({ code: "PERIOD_FINALIZED", periods: [...new Set(blockers.flatMap((b) => b.periods))].sort(), blockers });
		},
		periodLockUnreadableResponse: (req, res, what, audit) => {
			S.refusals.push({ what, audit });
			return res.status(409).json({ code: "PERIOD_LOCK_UNREADABLE" });
		},
		syncCarrierDriverHistory: () => {},
		notifyChange: () => {},
		recordPayRateChanges: () => {},
		console: { error() {}, log() {}, warn() {} },
	};
	const names = Object.keys(env);
	new Function(...names, PUT_ROUTE)(...names.map((k) => env[k]));
	new Function(...names, DELETE_ROUTE)(...names.map((k) => env[k]));
	if (typeof handlers.put !== "function" || typeof handlers.delete !== "function") die("the lifted routes did not register");
	const send = async (verb, id, cells, user = SUPER) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
		const body = cells ? { headers: Object.keys(cells), values: Object.values(cells) } : {};
		await handlers[verb]({ session: { user }, params: { id: String(id) }, query: {}, body }, res);
		return out;
	};
	// The edit form's whole-row resend (DriverTable.vue), with the fields changed.
	const put = (id, change, user = SUPER) => {
		const row = db.prepare("SELECT * FROM drivers_directory WHERE id = ?").get(id);
		return send("put", id, {
			Driver: row.driver_name, "Carrier Name": row.carrier_name, PhoneNumber: row.phone, Status: row.status,
			PayType: row.pay_type, PayPercentage: row.pay_type === "percentage" ? String(row.pay_percentage) : "",
			PayDaily: row.pay_type === "fixed" && row.pay_daily ? String(row.pay_daily) : "", ...change,
		}, user);
	};
	return { db, m, put, del: (id) => send("delete", id) };
}

function reset(over = {}) {
	Object.assign(S, { locksReadable: true, floors: {}, jtReads: 0, jtFails: false, floorAsked: [], refusals: [] }, over);
	const app = makeApp();
	const f = (n, floor) => { S.floors[app.m.normalizeDriverName(n)] = { floor, unbounded: false }; };
	f("Sept Assign", "2026-06"); f("Pct Sept", "2026-06"); f("Open Only", "2026-09");
	return app;
}
const rowById = (db, id) => db.prepare("SELECT * FROM drivers_directory WHERE id = ?").get(id);
const periodsOf = (r) => (r.body && r.body.periods) || [];
const fieldsOf = (r) => ((r.body && r.body.blockers) || []).map((b) => b.field);
const got = (r) => `got ${r.status} ${(r.body || {}).code || ""} ${periodsOf(r).join(",")}`.trim();

(async () => {
	console.log("§1 refused when the driver's loads reach a finalized month their assignment rows do not");
	for (const [label, id, change, wantFields] of [
		["Sept Assign, defaults → 20%", 1, { PayType: "percentage", PayPercentage: "20" }, ["pay_type", "pay_percentage"]],
		["Sept Assign, defaults → their own $300/day", 1, { PayDaily: "300" }, ["pay_daily"]],
		["Sept Assign, carrier → an investor's company", 1, { "Carrier Name": "Acme Leasing" }, ["carrier_name"]],
		["Pct Sept, 20% → 30%", 2, { PayPercentage: "30" }, ["pay_percentage"]],
	]) {
		const { db, put } = reset();
		const before = JSON.stringify(rowById(db, id));
		const r = await put(id, change);
		check(`§1 ${label}: 409 PERIOD_FINALIZED over ${LOCKED.join(", ")} (${got(r)})`,
			r.status === 409 && r.body.code === "PERIOD_FINALIZED" && JSON.stringify(periodsOf(r)) === JSON.stringify(LOCKED));
		check(`§1 ${label}: blocked on ${wantFields.join(", ")} (got ${fieldsOf(r).join(", ")})`, JSON.stringify(fieldsOf(r)) === JSON.stringify(wantFields));
		check(`§1 ${label}: the row is unchanged`, JSON.stringify(rowById(db, id)) === before);
		check(`§1 ${label}: audited as update_driver_pay_blocked`, (S.refusals[0] || {}).audit && S.refusals[0].audit.action === "update_driver_pay_blocked");
		check(`§1 ${label}: the history was read once, off Job Tracking (reads ${S.jtReads})`,
			S.jtReads === 1 && S.floorAsked.length >= 1 && S.floorAsked.every((a) => a.jt === JT));
	}
	{
		const { db, del } = reset();
		const r = await del(2);
		check(`§1 deleting Pct Sept (20%, loads from June): 409 PERIOD_FINALIZED over ${LOCKED.join(", ")} (${got(r)})`,
			r.status === 409 && JSON.stringify(periodsOf(r)) === JSON.stringify(LOCKED));
		check("§1 …the row is still there", !!rowById(db, 2));
		check("§1 …audited as delete_driver_blocked", (S.refusals[0] || {}).audit && S.refusals[0].audit.action === "delete_driver_blocked");
		check(`§1 …the history was read once (reads ${S.jtReads})`, S.jtReads === 1);
	}

	console.log("§2 allowed when nothing finalized is restated");
	{
		const { db, put } = reset();
		const r = await put(3, { PayType: "percentage", PayPercentage: "20" });
		check(`§2 Open Only (history from September), defaults → 20%: 200 (${got(r)})`, r.status === 200 && rowById(db, 3).pay_type === "percentage");
	}
	{
		// No assignment row, no load, no receipt: the edit restates nothing. Sized off
		// truck_assignments alone, "no rows" read as every finalized month.
		const { db, put } = reset();
		const r = await put(4, { PayType: "percentage", PayPercentage: "20" });
		check(`§2 Nobody Yet (no record anywhere), defaults → 20%: 200 (${got(r)})`, r.status === 200 && rowById(db, 4).pay_type === "percentage");
	}
	{
		const { db, put } = reset();
		const r = await put(1, { PhoneNumber: "555-0199" });
		check(`§2 a phone-number edit: 200 (${got(r)})`, r.status === 200 && rowById(db, 1).phone === "555-0199");
		check(`§2 …and no Job Tracking read (reads ${S.jtReads})`, S.jtReads === 0);
	}
	{
		const { put } = reset();
		const r = await put(2, {});
		check(`§2 Pct Sept, the stored terms resent unchanged: 200, no read (${got(r)}, reads ${S.jtReads})`, r.status === 200 && S.jtReads === 0);
	}
	{
		const { db, del } = reset();
		const r = await del(4);
		check(`§2 deleting a row at the defaults: 200, no read (${got(r)}, reads ${S.jtReads})`, r.status === 200 && !rowById(db, 4) && S.jtReads === 0);
	}

	console.log("§3 a rename is judged on both names' histories");
	{
		// Open Only (history from September) carries 20 %: renaming the row onto a
		// name whose loads reach June detaches those terms there.
		const { db, put, m } = reset();
		db.prepare("UPDATE drivers_directory SET pay_type = 'percentage', pay_percentage = 20 WHERE id = 3").run();
		S.floors[m.normalizeDriverName("June Name")] = { floor: "2026-06", unbounded: false };
		const r = await put(3, { Driver: "June Name" });
		check(`§3 renaming a 20% row onto a name with June loads: 409 over ${LOCKED.join(", ")} (${got(r)})`,
			r.status === 409 && JSON.stringify(periodsOf(r)) === JSON.stringify(LOCKED) && fieldsOf(r).includes("driver_name"));
		check("§3 …both names' histories were asked for",
			["Open Only", "June Name"].every((n) => S.floorAsked.some((a) => a.name === n)));
	}
	{
		const { db, put } = reset();
		db.prepare("UPDATE drivers_directory SET pay_type = 'percentage', pay_percentage = 20 WHERE id = 3").run();
		const r = await put(3, { Driver: "Fresh Name" });
		check(`§3 renaming it onto a name with no record anywhere: 200 (${got(r)})`, r.status === 200 && rowById(db, 3).driver_name === "Fresh Name");
	}

	console.log("§4 Job Tracking unreadable");
	{
		// The driver's history cannot be dated, so it reads as every finalized month.
		const { db, put } = reset({ jtFails: true });
		const before = JSON.stringify(rowById(db, 1));
		const r = await put(1, { PayType: "percentage", PayPercentage: "20" });
		check(`§4 a pay edit is held over every finalized month and writes nothing (${got(r)})`,
			r.status === 409 && r.body.code === "PERIOD_FINALIZED" && JSON.stringify(periodsOf(r)) === JSON.stringify(LOCKED) &&
			JSON.stringify(rowById(db, 1)) === before);
	}
	{
		// The pay check still answers first, and is audited.
		const { db, put } = reset({ jtFails: true });
		const before = JSON.stringify(rowById(db, 1));
		const r = await put(1, { PayType: "percentage", PayPercentage: "20" }, DISPATCHER);
		const audit = db.prepare("SELECT action FROM audit_trail WHERE action = 'pay_edit_blocked'").all();
		check(`§4 a Dispatcher's pay change is still 403 PAY_EDIT_ADMIN_ONLY, audited, nothing written (${got(r)}, ${audit.length} audit row)`,
			r.status === 403 && r.body.code === "PAY_EDIT_ADMIN_ONLY" && audit.length === 1 && JSON.stringify(rowById(db, 1)) === before);
	}
	{
		const { db, put } = reset({ jtFails: true });
		const r = await put(1, { PhoneNumber: "555-0199" });
		check(`§4 a phone-number edit does not need it: 200 (${got(r)})`, r.status === 200 && rowById(db, 1).phone === "555-0199");
	}

	console.log("§5 period locks unreadable");
	{
		const { db, put } = reset({ locksReadable: false });
		const r = await put(1, { PayType: "percentage", PayPercentage: "20" });
		check(`§5 a pay edit is held: 409 PERIOD_LOCK_UNREADABLE (${got(r)})`, r.status === 409 && r.body.code === "PERIOD_LOCK_UNREADABLE" && rowById(db, 1).pay_type === "fixed");
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
