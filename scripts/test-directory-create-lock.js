#!/usr/bin/env node
/**
 * POST /api/drivers-directory: a driver's first row is held to the month-end
 * lock (2026-10-03).
 *
 * THE BUG. Until a driver has a drivers_directory row, the money math pays them
 * at the defaults: fixed, at their truck's daily rate, with no carrier link.
 * PUT /api/drivers-directory/:id refuses a pay-structure change that would
 * restate a finalized month, but the POST had no such check. A first row with
 * pay_type "percentage" (or a day rate of their own, or a carrier an investor's
 * company name matches) re-derived that driver's pay across every finalized
 * month they had worked, and the POST created it with 200.
 *
 * THE FIX. directoryCreateLockBlockers() judges a first row as an edit away
 * from the defaults (directoryDefaultRow()), through directoryEditLockBlockers()'s
 * own predicate, as the delete guard does in the other direction. The driver's
 * exposure is sized off driverHistoryFloorMonth(), as POST /api/trucks sizes it:
 * a new hire has no truck_assignments row yet, and on that table alone would
 * read as working every finalized month. A row at the defaults is not judged,
 * and reads no Job Tracking.
 *
 * WHAT RUNS. The route lifted whole out of server.js over an in-memory SQLite,
 * with server.js's own pay helpers, name check and month-end lock
 * (directoryCreateLockBlockers, directoryEditLockBlockers, driverPayLockedMonths,
 * truckDailyRateCandidates, resolveDailyRate, lockedPeriodsDesc). Stubbed: Job
 * Tracking, the history floor (a per-driver answer; the floor itself is
 * scripts/test-truck-create-new-driver.js's subject), the investor-ledger lookup
 * (a per-carrier answer), and the 409 formatters, which record what they are
 * handed (scripts/test-refusal-audit-coverage.js covers the audit writer).
 *   §1 refused: percentage, a day rate or an investor's carrier, for a driver
 *      whose history reaches a finalized month: 409 from that month on, no row,
 *      audited as create_driver_pay_blocked
 *   §2 allowed: a new hire, history only in open months, a row at the defaults
 *      (no sheet read), a day rate equal to the truck's
 *   §3 period locks unreadable: a row that sets terms is held; one at the
 *      defaults is not
 *   §4 every other caller of directoryEditLockBlockers() is unchanged: with no
 *      history it sizes exposure off truck_assignments as before
 *
 * Pure: no server, no app.db, no network.
 *   node scripts/test-directory-create-lock.js
 *   SERVER_JS=/tmp/base.js node scripts/test-directory-create-lock.js   # a base commit: §1 fails
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
// The two helpers this change adds: absent from a base commit, whose route
// does not call them.
function liftNew(name) {
	return SRC.includes(`\nfunction ${name}(`) ? liftFunction(name) : "";
}
function liftConst(head, close = null) {
	const a = findOnce(`\n${head}`, `statement starting ${JSON.stringify(head)}`);
	const end = close ? SRC.indexOf(close, a) : SRC.indexOf(";\n", a);
	return SRC.slice(a, end + (close ? close.length : 1));
}
// The route, as registered now (async: it may read Job Tracking) or on a base
// commit (sync).
const ROUTE = (() => {
	const heads = [
		'app.post("/api/drivers-directory", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
		'app.post("/api/drivers-directory", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	].filter((h) => SRC.includes(`\n${h}`));
	if (heads.length !== 1) die("expected exactly 1 registration of POST /api/drivers-directory");
	const a = findOnce(`\n${heads[0]}`, "registration of POST /api/drivers-directory");
	return SRC.slice(a, SRC.indexOf("\n});", a) + "\n});".length);
})();

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
	liftNew("directoryDefaultRow"),
	liftNew("directoryCreateLockBlockers"),
].join("\n");
const MODULE_EXPORTS = [
	"logAudit", "logAuditRefusal", "auditText", "PAY_EDIT_ADMIN_ONLY", "directoryPayStruct", "directoryPayChanges",
	"refusePayEdit", "directoryPayValue", "DRIVER_PAY_DAILY_MAX", "directoryChangedColumns", "normalizeDriverName",
	"isBuiltInPropertyName", "findDriverNameClashes", "findDriverNameClash", "DIRECTORY_LOCK_REMEDY", "DIRECTORY_DEFAULT_STRUCT",
	"directoryEditLockBlockers", "resolveDailyRate",
	...(MODULE_SRC.includes("\nfunction directoryCreateLockBlockers(") ? ["directoryDefaultRow", "directoryCreateLockBlockers"] : []),
];

// ── fixtures ────────────────────────────────────────────────────────────────
const LOCKED = ["2026-06", "2026-07", "2026-08"];
const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
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
		pay_type TEXT DEFAULT 'fixed', pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0)`,
	"CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, assigned_driver TEXT DEFAULT '', driver_pay_daily REAL DEFAULT 0)",
	"CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '')",
	"CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked')",
];

// What the stubs answer, per test.
const S = {
	locksReadable: true,
	// normalized driver → driverHistoryFloorMonth()'s answer
	floors: {},
	jtReads: 0,
	floorAsked: [],
	refusals: [],
};
const JT = { headers: ["Load ID", "Driver", "Assigned Date"], data: [] };

function makeApp() {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	// Hal has driven truck 33 at $275/day since May, with no directory row: the
	// math pays him fixed at $275 in June, July and August.
	db.prepare("INSERT INTO trucks (id, unit_number, assigned_driver, driver_pay_daily) VALUES (1, '33', 'Hal History', 275)").run();
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (1, 'Hal History', '2026-05-04T12:00:00.000Z')").run();
	for (const p of LOCKED) db.prepare("INSERT INTO period_locks (period, status) VALUES (?, 'locked')").run(p);

	const m = new Function("db", "todayKeyCT", "periodLocksReadable", "investorsHoldingDriver",
		`"use strict";\n${MODULE_SRC}\nreturn { ${MODULE_EXPORTS.join(", ")} };`)(
		db, () => "2026-10-03",
		() => S.locksReadable,
		// An investor whose company name is the carrier holds the driver.
		(name, opts = {}) => new Set(String(opts.carrierOverride || "").toUpperCase() === INVESTOR_COMPANY ? [7] : []));
	let handler = null;
	const env = {
		app: { post: (p, guard, h) => { handler = h; } },
		requireRole: () => (req, res, next) => next(),
		db, ...m,
		periodLocksReadable: () => S.locksReadable,
		getJobTrackingCached: async () => { S.jtReads++; return JT; },
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
	new Function(...names, ROUTE)(...names.map((k) => env[k]));
	if (typeof handler !== "function") die("the lifted route did not register a handler");
	const post = async (cells) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
		const headers = Object.keys(cells);
		await handler({ session: { user: SUPER }, params: {}, query: {}, body: { headers, values: headers.map((h) => cells[h]) } }, res);
		return out;
	};
	return { db, m, post };
}

function reset(over = {}) {
	Object.assign(S, { locksReadable: true, floors: {}, jtReads: 0, floorAsked: [], refusals: [] }, over);
	return makeApp();
}
const rowOf = (db, name) => db.prepare("SELECT * FROM drivers_directory WHERE driver_name = ?").get(name);
const periodsOf = (r) => (r.body && r.body.periods) || [];
const fieldsOf = (r) => ((r.body && r.body.blockers) || []).map((b) => b.field);

(async () => {
	console.log("§1 a first row that restates a finalized month is refused");
	for (const [label, cells, floor, wantPeriods, wantFields] of [
		["Hal History, 20% (fixed at $275 in Jun-Aug)", { Driver: "Hal History", PayType: "percentage", PayPercentage: "20" },
			{ floor: "2026-05", unbounded: false }, LOCKED, ["pay_type", "pay_percentage"]],
		["Hal History, his own $300/day over the truck's $275", { Driver: "Hal History", PayType: "fixed", PayDaily: "300" },
			{ floor: "2026-05", unbounded: false }, LOCKED, ["pay_daily"]],
		["Late Hire, 20%, history from July", { Driver: "Late Hire", PayType: "percentage", PayPercentage: "20" },
			{ floor: "2026-07", unbounded: false }, ["2026-07", "2026-08"], ["pay_type", "pay_percentage"]],
		["Undated Dan, 20%, a record that cannot be dated", { Driver: "Undated Dan", PayType: "percentage", PayPercentage: "20" },
			{ floor: "", unbounded: true }, LOCKED, ["pay_type", "pay_percentage"]],
		["Cara Carrier, an investor's company as carrier, history from June", { Driver: "Cara Carrier", "Carrier Name": "Acme Leasing" },
			{ floor: "2026-06", unbounded: false }, LOCKED, ["carrier_name"]],
	]) {
		const { db, m, post } = reset();
		S.floors[m.normalizeDriverName(cells.Driver)] = floor;
		const r = await post(cells);
		check(`§1 ${label}: 409 PERIOD_FINALIZED over ${wantPeriods.join(", ")} (got ${r.status} ${(r.body || {}).code || ""} ${periodsOf(r).join(",")})`,
			r.status === 409 && r.body.code === "PERIOD_FINALIZED" && JSON.stringify(periodsOf(r)) === JSON.stringify(wantPeriods));
		check(`§1 ${label}: blocked on ${wantFields.join(", ")} (got ${fieldsOf(r).join(", ")})`,
			JSON.stringify(fieldsOf(r)) === JSON.stringify(wantFields));
		check(`§1 ${label}: no row is written`, !rowOf(db, cells.Driver));
		const refusal = S.refusals[0] || {};
		check(`§1 ${label}: audited as create_driver_pay_blocked, keyed on the name`,
			refusal.audit && refusal.audit.action === "create_driver_pay_blocked" && refusal.audit.entity === "driver" &&
			refusal.audit.entityId === cells.Driver);
		check(`§1 ${label}: each blocker reads as an add`,
			((r.body && r.body.blockers) || []).every((b) => b.detail.startsWith(`adding ${cells.Driver}: `)));
		check(`§1 ${label}: the history was asked for this driver, off Job Tracking`,
			S.jtReads === 1 && S.floorAsked.length === 1 && S.floorAsked[0].name === cells.Driver && S.floorAsked[0].jt === JT);
	}

	console.log("§2 a first row that restates nothing is created");
	for (const [label, cells, floor, want, reads] of [
		["New Hire, 20%, no history anywhere", { Driver: "New Hire", PayType: "percentage", PayPercentage: "20" },
			{ floor: "", unbounded: false }, ["percentage", 20, 0], 1],
		["Sept Start, 20%, history only from September (open)", { Driver: "Sept Start", PayType: "percentage", PayPercentage: "20" },
			{ floor: "2026-09", unbounded: false }, ["percentage", 20, 0], 1],
		["Hal History at the defaults", { Driver: "Hal History", PayType: "fixed", PayPercentage: "", PayDaily: "" },
			{ floor: "2026-05", unbounded: false }, ["fixed", 0, 0], 0],
		["Hal History, his own $275/day, the truck's rate", { Driver: "Hal History", PayType: "fixed", PayDaily: "275" },
			{ floor: "2026-05", unbounded: false }, ["fixed", 0, 275], 1],
		["Cara Carrier, a carrier no investor's company matches", { Driver: "Cara Carrier", "Carrier Name": "Cara Trucking LLC" },
			{ floor: "2026-06", unbounded: false }, ["fixed", 0, 0], 1],
	]) {
		const { db, m, post } = reset();
		S.floors[m.normalizeDriverName(cells.Driver)] = floor;
		const r = await post(cells);
		const made = rowOf(db, cells.Driver);
		check(`§2 ${label}: 200, created with ${JSON.stringify(want)} (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 200 && made && JSON.stringify([made.pay_type, made.pay_percentage, made.pay_daily]) === JSON.stringify(want));
		check(`§2 ${label}: Job Tracking read ${reads} time${reads === 1 ? "" : "s"} (got ${S.jtReads})`, S.jtReads === reads);
	}

	console.log("§3 period locks unreadable");
	{
		const { db, post } = reset({ locksReadable: false });
		const r = await post({ Driver: "New Hire", PayType: "percentage", PayPercentage: "20" });
		check(`§3 a row that sets terms is held: 409 PERIOD_LOCK_UNREADABLE, no row (got ${r.status} ${(r.body || {}).code || ""})`,
			r.status === 409 && r.body.code === "PERIOD_LOCK_UNREADABLE" && !rowOf(db, "New Hire") &&
			(S.refusals[0] || {}).audit && S.refusals[0].audit.action === "create_driver_pay_blocked");
	}
	{
		const { db, post } = reset({ locksReadable: false });
		const r = await post({ Driver: "New Hire", PayType: "fixed" });
		check(`§3 a row at the defaults is not held (got ${r.status} ${(r.body || {}).code || ""})`, r.status === 200 && !!rowOf(db, "New Hire"));
	}

	console.log("§4 the edit and the delete size exposure as before");
	{
		const { m } = reset();
		// A driver with a directory row and no truck_assignments row: with no
		// history handed in, every finalized month, as driverPayLockedMonths()
		// has always answered.
		const res = m.directoryEditLockBlockers(
			{ id: 9, driver_name: "No Rows", carrier_name: "", pay_type: "fixed", pay_percentage: 0, pay_daily: 0 }, { pay_type: "percentage" });
		check(`§4 directoryEditLockBlockers() with no history: every finalized month (got ${JSON.stringify(res.blockers.map((b) => b.periods))})`,
			JSON.stringify(res.blockers.map((b) => b.periods)) === JSON.stringify([LOCKED]));
		const hal = m.directoryEditLockBlockers(
			{ id: 10, driver_name: "Hal History", carrier_name: "", pay_type: "fixed", pay_percentage: 0, pay_daily: 0 }, { pay_type: "percentage" });
		check(`§4 ...and from the first assignment month for a driver with one (got ${JSON.stringify(hal.blockers.map((b) => b.periods))})`,
			JSON.stringify(hal.blockers.map((b) => b.periods)) === JSON.stringify([LOCKED]));
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
