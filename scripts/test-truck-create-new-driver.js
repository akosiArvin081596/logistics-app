#!/usr/bin/env node
/**
 * POST /api/trucks: a new truck may take a driver who has no history, and the
 * Add form's costs land — while the month-end lock still refuses a driver whose
 * history reaches a finalized month, and a truck that bills one.
 *
 * THE BUG. truckCreateLockBlockers() sized its two driver checks (the daily rate
 * and the investor driver set) with driverPayLockedMonths(), which answers EVERY
 * locked month for a driver with no truck_assignments rows. The guard runs
 * before the INSERT and before assignDriverToTruck(), so a brand-new driver
 * always has zero rows: a new hire's first truck was refused with 409
 * PERIOD_FINALIZED across all sixteen closed months whenever either check fired
 * — a rate other than the $250 default, or an investor owner — although nothing
 * of theirs existed in any of them. Separately, the INSERT dropped the Add
 * form's five fixed costs, admin fee and photo, and the guard was handed
 * hard-coded zeros for the five costs.
 *
 * THE FIX, as asserted here. driverHistoryFloorMonth() dates the earliest
 * pay-relevant record the driver has anywhere — Job Tracking (any status, every
 * date-like cell), excluded_driver_days, expenses, truck_assignments — and the
 * create guard sizes both driver checks off it: no record → no months, a floor →
 * every closed month from it onward, an undatable record → all of them. Every
 * other caller of driverPayLockedMonths() passes no history and is unchanged.
 * The route stores the costs, admin fee and photo for a Super Admin or a
 * Dispatcher and hands the guard the same cost object, whose check (1) fires
 * when any of the five amounts is non-zero.
 *
 * WHAT IS ASSERTED — the shipped code, lifted out of server.js, on an in-memory
 * SQLite seeded in production's shape (the six trucks, the sixteen locked months
 * 2025-05..2026-08, the three investors) with Job Tracking rows in the real
 * header layout and cell shapes:
 *   §1 driverHistoryFloorMonth() — each source, each cell shape, the earliest
 *      cell and row winning, any status, name variants, and every unbounded case.
 *   §2 driverPayLockedMonths() — with `history` omitted, the legacy answer; with
 *      it, its three outcomes, and all months for a malformed one.
 *   §3 truckCreateLockBlockers() — the new hire allowed (and refused without the
 *      history, reproducing the bug); history in a locked month refused from that
 *      month only; open-month history allowed; an undatable row refused in full;
 *      name variants; both wordings of check (2); day overrides and receipts as
 *      history; (h) fixed costs booked backwards — refused with the amounts, and
 *      so are a negative total, amounts that cancel to $0.00 and an annual line
 *      that rounds to $0.00/mo; Inactive, a blank in-service date or no costs
 *      allowed.
 *   §4 POST /api/trucks, the shipped handler with the REAL guard — the reported
 *      request succeeds, and so does a Dispatcher's add of the same driver; a
 *      refusal writes nothing and is audited; a failed sheet read refuses; the
 *      sheet is not read when no driver is named; a same-unit truck landing
 *      during the read is seen. (h) the Add form's costs, admin fee and photo:
 *      stored for a Super Admin or a Dispatcher and handed to the guard as
 *      stored, a back-dated Active truck carrying them refused, an Investor's
 *      add kept at the column defaults, a blank amount 0 and a negative one
 *      refused 400 INVALID_AMOUNT before the guard is asked, an admin
 *      fee kept when it is a number from 0 to 100, 50 when blank or not sent,
 *      and anything else refused 400 INVALID_AMOUNT (field admin_fee_pct) with
 *      nothing written, both audit lines naming the monthly fixed costs.
 *   §5 source pins — both awaits above canonicalDriverName(), the history
 *      computed after it and handed to the guard, the unit-number check after the
 *      last await, both driver checks sized off the history, one cost object
 *      feeding the guard and the INSERT, check (1) on any non-zero amount, the
 *      legacy branch of driverPayLockedMonths() intact.
 * The mutants for this guard were run by hand before shipping and are not
 * committed (see the PR).
 *
 * Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-truck-create-new-driver.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
const ok = (cond, label) => eq(!!cond, true, label);
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

// ── lift the shipped code ───────────────────────────────────────────────────
// Anchored on a newline and counted, so a mention in a comment cannot be taken
// for the definition and a second copy fails the run instead of lifting either.
function liftFunction(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${name}()`);
	return SRC.slice(a, end + 2);
}
function liftRoute(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n});", a);
	if (end < 0) die(`no column-0 "});" after ${head}`);
	return SRC.slice(a, end + "\n});".length);
}
// A one-line `const NAME = …;`, or a block from its head to `close`.
function liftConst(head, close = null) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 statement starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = close ? SRC.indexOf(close, a) : SRC.indexOf(";\n", a);
	if (end < 0) die(`no end found after ${head}`);
	return SRC.slice(a, end + (close ? close.length : 1));
}

// Everything the guard and the route call from module scope, verbatim. Only the
// clock (todayKeyCT) and periodLocksReadable() are stubbed; the lock table itself
// is real and read by the real lockedPeriodsDesc().
const FUNCTIONS = [
	// the subject
	"driverHistoryFloorMonth", "driverPayLockedMonths", "truckCreateLockBlockers",
	// what the guard reads
	"normalizeDriverName", "findCol", "moneySheetDate", "lockedPeriodsDesc",
	"truckFixedCostLockedMonths", "truckChargedInMonth", "truckChargeFromMonth", "truckChargeUntilMonth", "truckMonthlyFixed",
	"truckFeeLockedRows", "getDriverPayStructures", "resolveDailyRate", "truckDailyRateCandidates", "investorsHoldingDriver",
	// what the route calls
	"parseDriverPayDaily", "parseInServiceDate", "parseAdminFeePct", "parseTruckAmount", "parseTruckAmounts",
	"findDriverNameClashes", "canonicalDriverName", "assignDriverToTruck",
	"refusePayEdit", "periodBlockedResponse", "periodLockUnreadableResponse", "periodLabel",
	// the real refusal audit, so a refusal row is the row production writes
	"recordPeriodRefusal", "periodRefusalDetail", "logAudit", "logAuditRefusal", "scrubPurgeMarker", "auditText",
];
const FN_SRC = Object.fromEntries(FUNCTIONS.map((n) => [n, liftFunction(n)]));
const CONSTS = [
	liftConst("const RFC2822_MONTHS = "),
	liftConst("const EXPENSE_PERIOD_EXPR ="),
	liftConst("let lastPayStructShadowWarnMs = "),
	liftConst("const DRIVER_PAY_DAILY_MAX = "),
	liftConst("const IN_SERVICE_MAX_MONTHS_AHEAD = "),
	liftConst("const ADMIN_FEE_PCT_MAX = "),
	liftConst("const TRUCK_AMOUNT_MAX = "),
	liftConst("const TRUCK_AMOUNT_FIELDS = [", "\n];"),
	liftConst("const AUDITED_UPSTREAM = "),
	liftConst("const PAY_EDIT_ADMIN_ONLY = "),
	liftConst("const REFUSAL_AUDIT_WINDOW_MS = "),
	liftConst("const refusalAuditWindows = "),
	liftConst("const UNCOALESCED_REFUSAL_CODES = new Set([", "\n]);"),
].join("\n");
const ROUTE_POST = liftRoute('app.post("/api/trucks", requireRole("Super Admin", "Dispatcher", "Investor"), async (req, res) => {');
// The photo check the route runs for a Super Admin or a Dispatcher, verbatim
// (its own subject is scripts/test-stored-file-serving.js).
const PHOTO_CHECK = new Function("imageLimits",
	`"use strict";\n${liftFunction("storedFileForServing")}\n${liftFunction("truckPhotoForStorage")}\nreturn { storedFileForServing, truckPhotoForStorage };`
)(require("../lib/image-size"));

const TODAY = "2026-09-25";
function buildModule(db) {
	return new Function("db", "todayKeyCT", "periodLocksReadable",
		`"use strict";\n${CONSTS}\n${FUNCTIONS.map((n) => FN_SRC[n]).join("\n")}\nreturn { ${FUNCTIONS.join(", ")}, TRUCK_AMOUNT_FIELDS };`
	)(db, () => TODAY, () => true);
}

// ── fixtures: production's shape ────────────────────────────────────────────
// The sixteen locked months, 2025-05..2026-08. 2026-09 is the open month.
const LOCKED_ASC = [];
for (let i = 0; i < 16; i++) {
	const idx = 2025 * 12 + 4 + i;
	LOCKED_ASC.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`);
}
const LOCKED_DESC = [...LOCKED_ASC].reverse();
const lockedFrom = (m) => LOCKED_ASC.filter((p) => p >= m);

function ddl(table) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${table}`);
	return `CREATE TABLE ${table} (${m[1]}\n)`;
}
function alter(sqlStart) {
	const m = SRC.match(new RegExp(`${sqlStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"\`]*`));
	if (!m) die(`could not locate the migration ${sqlStart}`);
	return m[0];
}
const DDL = [
	ddl("users"),
	...["full_name", "company_name", "must_change_password", "last_login_at"].map((c) => alter(`ALTER TABLE users ADD COLUMN ${c} `)),
	ddl("audit_trail"),
	ddl("period_locks"),
	ddl("truck_assignments"),
	ddl("carrier_driver_history"),
	ddl("excluded_driver_days"),
	alter("ALTER TABLE excluded_driver_days ADD COLUMN action "),
	ddl("expenses"),
	...["owner_id", "truck_unit", "posted_period"].map((c) => alter(`ALTER TABLE expenses ADD COLUMN ${c} `)),
	ddl("maintenance_fund"),
	ddl("compliance_fees"),
	// The migrated production shapes (several migrations deep in server.js).
	`CREATE TABLE drivers_directory (
		id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
		carrier_name TEXT DEFAULT '', state TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', address TEXT DEFAULT '',
		phone TEXT DEFAULT '', cell TEXT DEFAULT '', email TEXT DEFAULT '', dot TEXT DEFAULT '', mc TEXT DEFAULT '',
		trucks TEXT DEFAULT '', hazmat TEXT DEFAULT '', rating TEXT DEFAULT '', status TEXT DEFAULT 'active',
		pay_type TEXT DEFAULT 'fixed', pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0)`,
	`CREATE TABLE trucks (
		id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT NOT NULL UNIQUE, make TEXT DEFAULT '', model TEXT DEFAULT '',
		year INTEGER DEFAULT 0, vin TEXT DEFAULT '', license_plate TEXT DEFAULT '',
		status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Inactive','Maintenance','OOS')),
		assigned_driver TEXT DEFAULT '', notes TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		owner_id INTEGER DEFAULT 0, photo TEXT DEFAULT '', insurance_monthly REAL DEFAULT 0, eld_monthly REAL DEFAULT 0,
		hvut_annual REAL DEFAULT 0, irp_annual REAL DEFAULT 0, admin_fee_pct REAL DEFAULT 50, driver_pay_daily REAL DEFAULT 0,
		fuel_tank_gallons REAL DEFAULT 0, avg_mpg REAL DEFAULT 0, purchase_price REAL DEFAULT 0, title_status TEXT DEFAULT 'Clean',
		title_state TEXT DEFAULT '', maintenance_fund_monthly REAL DEFAULT 0, truck_payment_monthly REAL DEFAULT 0,
		in_service_date TEXT DEFAULT '', retired_at TEXT DEFAULT '', routemate_vehicle_id TEXT DEFAULT '')`,
];

const NEW_HIRE = "Dana Newhire";

function makeDb() {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name, full_name, company_name) VALUES (?, ?, 'x', ?, ?, ?, ?)");
	user.run(1, "super_admin", "Super Admin", "", "", "");
	user.run(2, "kevin", "Dispatcher", "", "Kevin Dispatch", "");
	user.run(3, "sking", "Driver", "Shorn King", "Shorn King", "");
	user.run(5, "johnny", "Investor", "", "Johnny", "Johnny Rocks Spirits");
	user.run(41, "owner41", "Investor", "", "Owner Forty-One", "Owner 41 Freight LLC");
	user.run(42, "lx", "Investor", "", "LX", "Logistics Exchange");
	user.run(60, "dnewhire", "Driver", NEW_HIRE, NEW_HIRE, ""); // the new hire's account, minted on acceptance
	const dir = db.prepare("INSERT INTO drivers_directory (driver_name, status, pay_type, pay_percentage, pay_daily) VALUES (?, ?, 'fixed', 0, ?)");
	for (const [name, status, daily] of [
		["Howard Reddie", "active", 0], ["Jayden Morrison", "active", 0], ["Rodney Brown", "active", 0],
		["Lesline Johnson", "active", 0], ["Shorn King", "active", 300], ["Fleet Test Driver", "active", 0],
		[NEW_HIRE, "pending", 0],
	]) dir.run(name, status, daily);
	const truck = db.prepare(`INSERT INTO trucks (id, unit_number, status, owner_id, assigned_driver, driver_pay_daily, in_service_date, created_at,
		insurance_monthly, eld_monthly, truck_payment_monthly, hvut_annual, irp_annual) VALUES (?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	truck.run(2, "LogisX-#33", 5, "Howard Reddie", 150, "", "2026-04-15 03:10:50", 1630, 50, 1200, 580, 1380);
	truck.run(3, "LogisX-#2372", 0, "Jayden Morrison", 250, "", "2026-04-17 14:28:15", 1630, 50, 0, 295, 2007);
	truck.run(4, "LogisX-#302", 41, "Rodney Brown", 20, "", "2026-04-20 19:31:37", 1520, 0, 0, 0, 0);
	truck.run(5, "INV-24-A", 42, "Lesline Johnson", 0, "", "2026-04-20 20:16:38", 0, 0, 0, 0, 0);
	truck.run(11, "Logisx-#91", 5, "Shorn King", 300, "2026-08-04", "2026-05-21 12:07:08", 1680, 50, 1210, 580, 1410);
	truck.run(12, "LogisX-TEST", 0, "Fleet Test Driver", 250, "", "2026-05-30 01:16:45", 0, 0, 0, 0, 0);
	const assign = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, ?, '')");
	assign.run(2, "Howard Reddie", "2026-05-13T10:47:01.338Z");
	assign.run(11, "Shorn King", "2026-08-12T23:17:51.574Z");
	assign.run(3, "Jayden Morrison", "2026-04-17T14:28:15.000Z");
	assign.run(4, "Rodney Brown", "2026-04-20T19:31:37.000Z");
	const hist = db.prepare("INSERT INTO carrier_driver_history (carrier_name, driver_name, started_at) VALUES (?, ?, ?)");
	hist.run("Johnny Rocks Spirits", "Howard Reddie", "2026-05-13T10:47:01.338Z");
	hist.run("Johnny Rocks Spirits", "Shorn King", "2026-08-12T23:17:51.574Z");
	hist.run("Owner 41 Freight LLC", "Rodney Brown", "2026-04-20T19:31:37.000Z");
	const lock = db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, 'locked', ?)");
	for (const p of LOCKED_ASC) lock.run(p, `${p}-28T05:00:00.000Z`);
	return db;
}
function addExpense(db, driver, date, postedPeriod = "", createdAt = "2026-09-20 12:00:00") {
	db.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, posted_period, created_at) VALUES ('t', ?, 'Fuel', 412.5, ?, ?, ?)")
		.run(driver, date, postedPeriod, createdAt);
}
function addDayOverride(db, driver, date, action) {
	db.prepare("INSERT INTO excluded_driver_days (driver_name, excluded_date, reason, excluded_by, action) VALUES (?, ?, 'test', 'super_admin', ?)")
		.run(driver, date, action);
}

// Job Tracking, as getJobTrackingCached() returns it: the production header row
// (copied from the Dispatch Management layout, as test-status-override-guard.js
// does) and rows keyed by header.
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver",
	"Pickup Info", "Pickup Appointment", "Pickup Address",
	"Drop-off Info", "Drop-off Appointment", "Drop-off Address",
	"Job Status", "Phase of Progress", "Carrier Stage", "  Payment  ",
	"Broker Contact Name", "Phone Number", "Email", "Location Link", "Documents",
	"Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output",
];
function load(driver, c = {}) {
	const r = Object.fromEntries(HEADERS.map((h) => [h, ""]));
	Object.assign(r, {
		"Load ID": c.id || "T-0000", Driver: driver, "Job Status": c.status || "Delivered", "  Payment  ": "$1,450.00",
		"Assigned Date": c.assigned || "", "Pickup Appointment": c.pickup || "", "Drop-off Appointment": c.drop || "",
		"Status Update Date": c.update || "", "Completion Date": c.completion || "", Truck: c.truck || "", "Owner ID": c.owner || "",
	});
	return r;
}
// Real cell shapes: an RFC 2822 email date, "M/D/YY HH:MM Appt.", a locale
// timestamp and a bare ISO day.
const MARCH = { id: "T-2303", assigned: "Date: Tue, 17 Mar 2026 09:12:44 -0500", pickup: "3/18/26 08:00 Appt.", drop: "3/19/26 14:00 Appt.", update: "3/19/2026, 6:02:00 PM", completion: "2026-03-19" };
const SEPT = { id: "T-2309", assigned: "Date: Tue, 22 Sep 2026 10:05:00 -0500", pickup: "9/23/26 07:30 Appt.", drop: "9/24/26 12:00 Appt.", update: "9/24/2026, 4:23:00 PM", completion: "2026-09-24" };
const BACKGROUND = [
	load("Howard Reddie", { id: "T-2101", assigned: "Date: Tue, 20 Jan 2026 11:30:35 -0500", pickup: "1/20/26 11:00 Appt.", drop: "1/22/26 08:00 Appt.", update: "1/22/2026, 3:10:00 PM", completion: "2026-01-22", truck: "LogisX-#33", owner: "5" }),
	load("Howard Reddie", { id: "T-2105", assigned: "Date: Wed, 13 May 2026 08:02:11 -0500", pickup: "5/14/26 07:00 Appt.", drop: "5/15/26 12:00 Appt.", update: "5/15/2026, 4:00:00 PM", completion: "2026-05-15", truck: "LogisX-#33", owner: "5" }),
	load("Shorn King", { id: "T-2108", assigned: "Date: Tue, 04 Aug 2026 07:45:00 -0500", pickup: "8/5/26 06:00 Appt.", drop: "8/6/26 15:00 Appt.", update: "8/6/2026, 5:30:00 PM", completion: "2026-08-06", truck: "Logisx-#91", owner: "5" }),
	load("Jayden Morrison", { id: "T-2006", assigned: "Date: Mon, 16 Jun 2025 09:00:00 -0500", pickup: "6/17/25 08:00 Appt.", drop: "6/18/25 10:00 Appt.", completion: "2025-06-18" }),
	// A different person whose name merely starts the same way.
	load("Dana Newhire Jr.", { id: "T-2007", assigned: "Date: Tue, 15 Jul 2025 13:20:00 -0500", pickup: "7/16/25 09:00 Appt.", completion: "2025-07-17" }),
];
function makeJt(extra = [], headers = HEADERS) {
	return { headers: [...headers], data: [...BACKGROUND, ...extra].map((r, i) => ({ _rowIndex: i + 2, ...r })) };
}

// The object POST /api/trucks hands the guard, for the reported request.
const createTruck = (over = {}) => ({
	id: 0, unit_number: "LogisX-#23", status: "Active", owner_id: 5, assigned_driver: NEW_HIRE,
	driver_pay_daily: 300, in_service_date: TODAY, created_at: "2026-09-25 15:00:00",
	insurance_monthly: 0, eld_monthly: 0, truck_payment_monthly: 0, hvut_annual: 0, irp_annual: 0,
	routemate_vehicle_id: "", ...over,
});
const summary = (res) => res.blockers.map((b) => ({ field: b.field, effect: b.effect || null, periods: b.periods }));

// ═══════════════════════════════════════════════════════════════ §1
function historySection() {
	section("§1 driverHistoryFloorMonth()");
	const history = (setup, name = NEW_HIRE, rows = [], headers = HEADERS) => {
		const db = makeDb();
		if (setup) setup(db);
		return buildModule(db).driverHistoryFloorMonth(name, makeJt(rows, headers));
	};
	const NONE = { floor: "", unbounded: false };
	const ALL = { floor: "", unbounded: true };

	eq(history(null), NONE, "§1 a new hire with no record anywhere: no floor, bounded");
	{
		const m = buildModule(makeDb());
		eq(m.driverHistoryFloorMonth("", null), NONE, "§1 a blank name has no history (no sheet needed)");
		eq(m.driverHistoryFloorMonth("   ", makeJt()), NONE, "§1 a whitespace name has no history");
		eq(m.driverHistoryFloorMonth(NEW_HIRE, null), ALL, "§1 a named driver with no sheet to read: unbounded");
		eq(m.driverHistoryFloorMonth(NEW_HIRE, { headers: [], data: [] }), ALL, "§1 an empty sheet (no headers): unbounded");
	}
	eq(history(null, NEW_HIRE, [load(NEW_HIRE, MARCH)], HEADERS.map((h) => (h === "Driver" ? "Driver Name" : h))), ALL,
		"§1 a sheet without the pay math's ^Driver$ column: unbounded");

	// One cell at a time, each shape on its own.
	for (const [label, cell, value] of [
		["Assigned Date as an RFC 2822 email date", "assigned", MARCH.assigned],
		["Pickup Appointment as M/D/YY HH:MM Appt.", "pickup", MARCH.pickup],
		["Drop-off Appointment as M/D/YY HH:MM Appt.", "drop", MARCH.drop],
		["Status Update Date as a locale timestamp", "update", MARCH.update],
		["Completion Date as a bare ISO day", "completion", MARCH.completion],
	]) {
		eq(history(null, NEW_HIRE, [load(NEW_HIRE, { [cell]: value })]), { floor: "2026-03", unbounded: false }, `§1 only the ${label}: 2026-03`);
	}
	eq(history(null, NEW_HIRE, [load(NEW_HIRE, {
		assigned: "Date: Fri, 28 Aug 2026 16:40:10 -0500", pickup: "9/2/26 08:00 Appt.", drop: "9/3/26 13:00 Appt.", update: "9/9/2026, 4:23:00 PM",
	})]), { floor: "2026-08", unbounded: false }, "§1 the EARLIEST cell of a row wins (assigned Aug 28, picked up in September)");
	eq(history(null, NEW_HIRE, [load(NEW_HIRE, SEPT), load(NEW_HIRE, MARCH), load(NEW_HIRE, { completion: "2026-05-13" })]),
		{ floor: "2026-03", unbounded: false }, "§1 the earliest row wins");
	eq(history(null, NEW_HIRE, [load(NEW_HIRE, { ...MARCH, status: "Cancelled" })]), { floor: "2026-03", unbounded: false },
		"§1 a cancelled load still counts (any status — never reasoned about)");
	eq(history(null, NEW_HIRE, [load(NEW_HIRE, SEPT)]), { floor: "2026-09", unbounded: false }, "§1 open-month loads only: the open month");
	eq(history(null, NEW_HIRE, [load("  dana   NEWHIRE ", MARCH)]), { floor: "2026-03", unbounded: false },
		"§1 a sheet spelling in other case and spacing is the same driver");
	eq(history(null, "DANA  newhire", [load(NEW_HIRE, MARCH)]), { floor: "2026-03", unbounded: false },
		"§1 ...and so is the name asked about");
	eq(history(null), NONE, "§1 a different person whose name only starts the same way is not counted (\"Dana Newhire Jr.\", 2025-07)");
	eq(history(null, NEW_HIRE, [load(NEW_HIRE, { pickup: "14:00", drop: "TBD" })]), ALL,
		"§1 a matching row with no readable date (\"14:00\", \"TBD\", blanks): unbounded");
	eq(history(null, NEW_HIRE, [load(NEW_HIRE, SEPT), load(NEW_HIRE, {})]), ALL, "§1 ...even beside a datable row");

	// The SQLite sources.
	eq(history((db) => addDayOverride(db, "dana newhire", "2026-02-14", "add")), { floor: "2026-02", unbounded: false },
		"§1 an admin-added day (excluded_driver_days, action add)");
	eq(history((db) => addDayOverride(db, "dana newhire", "2025-12-01", "remove")), { floor: "2025-12", unbounded: false },
		"§1 an admin-removed day (action remove)");
	eq(history((db) => addDayOverride(db, "dana newhire", "", "add")), ALL, "§1 a day override with no readable date: unbounded");
	eq(history((db) => addExpense(db, NEW_HIRE, "2026-04-02")), { floor: "2026-04", unbounded: false }, "§1 a receipt dated in a locked month");
	eq(history((db) => addExpense(db, "DANA NEWHIRE", "2026-04-02")), { floor: "2026-04", unbounded: false },
		"§1 ...stored under another spelling");
	eq(history((db) => addExpense(db, NEW_HIRE, "2026-07-30", "2026-09")), { floor: "2026-07", unbounded: false },
		"§1 a receipt booked forward (posted_period 2026-09, dated 2026-07): the earlier month");
	eq(history((db) => addExpense(db, NEW_HIRE, "", "", "2026-06-15 10:00:00")), { floor: "2026-06", unbounded: false },
		"§1 a receipt with no date falls back to created_at, as EXPENSE_PERIOD_EXPR does");
	eq(history((db) => addExpense(db, NEW_HIRE, "", "2026-09", "")), { floor: "2026-09", unbounded: false },
		"§1 a receipt readable only through its posted_period");
	eq(history((db) => addExpense(db, NEW_HIRE, "not a date", "", "")), ALL, "§1 a receipt with no readable month: unbounded");
	eq(history(null, "Howard Reddie"), { floor: "2026-01", unbounded: false },
		"§1 Howard: January's load predates his 2026-05 assignment row, and the floor follows the load");
	eq(history(null, "Shorn King"), { floor: "2026-08", unbounded: false }, "§1 Shorn: loads and assignment both in 2026-08");
	eq(history((db) => db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (12, ?, '2025-10-02T14:00:00.000Z')").run(NEW_HIRE)),
		{ floor: "2025-10", unbounded: false }, "§1 an assignment row alone (start_date sliced)");
	eq(history((db) => db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (12, ?, '')").run(NEW_HIRE)), ALL,
		"§1 an assignment row with no readable start_date: unbounded, as before");

	{
		// The shared cache is handed in and never written.
		const db = makeDb();
		const jt = makeJt([load(NEW_HIRE, MARCH)]);
		const deepFreeze = (o) => { Object.freeze(o); for (const v of Object.values(o)) if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v); return o; };
		const before = JSON.stringify(jt);
		let threw = null;
		try { buildModule(db).driverHistoryFloorMonth(NEW_HIRE, deepFreeze(jt)); } catch (e) { threw = e.message; }
		ok(threw === null && JSON.stringify(jt) === before, "§1 the Job Tracking cache is read, never written (strict mode, deep-frozen)");
	}
}

// ═══════════════════════════════════════════════════════════════ §2
function lockedMonthsSection() {
	section("§2 driverPayLockedMonths()");
	const m = buildModule(makeDb());
	const L = LOCKED_DESC; // lockedPeriodsDesc()'s order, which every caller passes
	eq(m.lockedPeriodsDesc(), L, "§2 the fixture's sixteen locked months, newest first");

	// History omitted: the function it was.
	eq(m.driverPayLockedMonths(NEW_HIRE, L), L, "§2 omitted: a driver with no assignment row gets every locked month (unchanged)");
	eq(m.driverPayLockedMonths("Howard Reddie", L), lockedFrom("2026-05"), "§2 omitted: Howard from his first assignment, 2026-05 (unchanged)");
	eq(m.driverPayLockedMonths("Shorn King", L), ["2026-08"], "§2 omitted: Shorn from 2026-08 (unchanged)");
	eq(m.driverPayLockedMonths("", L), [], "§2 omitted: a blank name gets none (unchanged)");
	eq(m.driverPayLockedMonths(NEW_HIRE, []), [], "§2 omitted: no locked months, none (unchanged)");
	for (const name of [NEW_HIRE, "Howard Reddie", "Shorn King", "howard reddie", "Nobody At All"]) {
		eq(m.driverPayLockedMonths(name, L, undefined), m.driverPayLockedMonths(name, L), `§2 an explicit undefined is the omitted argument (${name})`);
	}

	// History given.
	eq(m.driverPayLockedMonths(NEW_HIRE, L, { floor: "", unbounded: false }), [], "§2 given, no record anywhere: none");
	eq(m.driverPayLockedMonths(NEW_HIRE, L, { floor: "2026-03", unbounded: false }), lockedFrom("2026-03"), "§2 given, a floor: every locked month from it, ascending");
	eq(m.driverPayLockedMonths(NEW_HIRE, L, { floor: "2024-01", unbounded: false }), LOCKED_ASC, "§2 given, a floor before every lock: all of them");
	eq(m.driverPayLockedMonths(NEW_HIRE, L, { floor: "2026-09", unbounded: false }), [], "§2 given, a floor in the open month: none");
	eq(m.driverPayLockedMonths(NEW_HIRE, L, { floor: "", unbounded: true }), L, "§2 given, unbounded: every locked month");
	for (const [label, h] of [["null", null], ["{}", {}], ["a floor that is not a month", { floor: "2026-3", unbounded: false }], ["a numeric floor", { floor: 202603, unbounded: false }]]) {
		eq(m.driverPayLockedMonths(NEW_HIRE, L, h), L, `§2 given ${label}: every locked month (cannot bound it)`);
	}
	eq(m.driverPayLockedMonths("", L, { floor: "", unbounded: true }), [], "§2 given, a blank name still gets none");
	eq(m.driverPayLockedMonths(NEW_HIRE, [], { floor: "", unbounded: true }), [], "§2 given, no locked months still gets none");
	eq(m.driverPayLockedMonths("Howard Reddie", L, m.driverHistoryFloorMonth("Howard Reddie", makeJt())), lockedFrom("2026-01"),
		"§2 Howard with his history: from January, where his loads start — wider than his assignment row");
}

// ═══════════════════════════════════════════════════════════════ §3
function guardSection() {
	section("§3 truckCreateLockBlockers()");
	const run = (truck, { rows = [], setup = null, withHistory = true } = {}) => {
		const db = makeDb();
		if (setup) setup(db);
		const m = buildModule(db);
		const h = m.driverHistoryFloorMonth(truck.assigned_driver, makeJt(rows));
		return withHistory ? m.truckCreateLockBlockers(truck, h) : m.truckCreateLockBlockers(truck);
	};
	const both = (from) => [
		{ field: "driver_pay_daily", effect: null, periods: lockedFrom(from) },
		{ field: "owner_id", effect: "driver_set", periods: lockedFrom(from) },
	];

	// (a) the reported request.
	eq(summary(run(createTruck())), [], "§3 (a) the reported request — a new hire, owner 5, $300/day, Active, in service today: no blockers");
	eq(summary(run(createTruck(), { withHistory: false })), both("2025-05"),
		"§3 (a) ...and without the history, the same call is refused across all sixteen months — the reported 409");
	eq(summary(run(createTruck({ insurance_monthly: 1680, eld_monthly: 50, truck_payment_monthly: 1210, hvut_annual: 580, irp_annual: 1410 }))), [],
		"§3 (a) ...with a full set of fixed costs, in service in the open month: still none");

	// (b) one load in a locked month.
	{
		const res = run(createTruck(), { rows: [load(NEW_HIRE, MARCH)] });
		eq(summary(res), both("2026-03"), "§3 (b) one load in 2026-03: the rate and the driver set are refused from 2026-03 only");
		eq((res.blockers[1] || {}).to, "5", "§3 (b) ...the driver set moving onto owner 5");
	}
	// (c) the open month only.
	eq(summary(run(createTruck(), { rows: [load(NEW_HIRE, SEPT)] })), [], "§3 (c) loads only in the open month: no blockers");
	// (d) a row that cannot be dated.
	eq(summary(run(createTruck(), { rows: [load(NEW_HIRE, SEPT), load(NEW_HIRE, { pickup: "14:00" })] })), both("2025-05"),
		"§3 (d) a matching row with no readable date: all sixteen months");
	// (e) name variants.
	eq(summary(run(createTruck(), { rows: [load("  dana   NEWHIRE ", MARCH)] })), both("2026-03"),
		"§3 (e) the sheet spelling the driver in other case and spacing still counts");
	eq(summary(run(createTruck(), { rows: [load("Dana Newhire Jr.", MARCH)] })), [],
		"§3 (e) ...a different person's load does not");

	// (f) the wording of check (2).
	{
		const res = run(createTruck(), { rows: [load(NEW_HIRE, MARCH)] });
		const d = (res.blockers[0] || {}).detail || "";
		ok(d.includes("assigning Dana Newhire to a new truck at $300.00/day replaces the $250.00/day default (they drive no truck yet), repricing their active days across 6 finalized months"),
			`§3 (f) a driver on no truck: "…replaces the $250.00/day default (they drive no truck yet)…" (got ${JSON.stringify(d)})`);
		ok(!d.includes("their current truck sets"), "§3 (f) ...and not the current-truck wording");
	}
	{
		const res = run(createTruck({ unit_number: "LogisX-#40", assigned_driver: "Howard Reddie" }));
		eq(summary(res), [{ field: "driver_pay_daily", effect: null, periods: lockedFrom("2026-01") }],
			"§3 (f) Howard ($150 on #33) onto a new $300 truck for the same owner: the rate, from his first load in 2026-01");
		const d = (res.blockers[0] || {}).detail || "";
		ok(d.includes("replaces the $150.00/day their current truck sets, repricing their active days across 8 finalized months"),
			`§3 (f) a driver on a truck keeps the current-truck wording (got ${JSON.stringify(d)})`);
	}
	eq(summary(run(createTruck({ unit_number: "LogisX-#40", assigned_driver: "Howard Reddie", owner_id: 41, driver_pay_daily: 150 }))),
		[{ field: "owner_id", effect: "driver_set", periods: lockedFrom("2026-01") }],
		"§3 (f) Howard at his own $150 onto owner 41: only the driver set moves, from 2026-01");
	eq(summary(run(createTruck({ unit_number: "LogisX-#40", assigned_driver: "Shorn King" }))), [],
		"§3 a driver whose own $300 pay_daily overrides the truck rate, onto the same owner: allowed, as before");

	// (g) day overrides and receipts are history.
	eq(summary(run(createTruck(), { setup: (db) => addDayOverride(db, "dana newhire", "2026-02-14", "add") })), both("2026-02"),
		"§3 (g) an admin-added day in 2026-02 counts as history");
	eq(summary(run(createTruck(), { setup: (db) => addDayOverride(db, "dana newhire", "2025-12-01", "remove") })), both("2025-12"),
		"§3 (g) an admin-removed day in 2025-12 counts as history");
	eq(summary(run(createTruck(), { setup: (db) => addExpense(db, NEW_HIRE, "2026-04-02") })), both("2026-04"),
		"§3 (g) a receipt dated 2026-04 counts as history");

	// (h) fixed costs booked backwards — check (1), on a truck with no driver so
	// that nothing else can answer.
	const noDriver = (over) => createTruck({ assigned_driver: "", driver_pay_daily: 0, unit_number: "LogisX-#24", ...over });
	const BACK = ["2026-06", "2026-07", "2026-08"];
	{
		const res = run(noDriver({ in_service_date: "2026-06-01", insurance_monthly: 1000 }));
		eq(summary(res), [{ field: "in_service_date", effect: null, periods: BACK }],
			"§3 (h) Active, in service 2026-06-01, $1,000/mo insurance: refused on in_service_date for 2026-06..2026-08");
		ok(((res.blockers[0] || {}).detail || "").endsWith("books $1,000.00/mo of fixed costs into 3 finalized months ($3,000.00) — insurance $1,000.00/mo"),
			`§3 (h) ...naming the total and the amount (got ${JSON.stringify((res.blockers[0] || {}).detail)})`);
	}
	{
		const res = run(noDriver({ in_service_date: "2026-06-01", insurance_monthly: 1630, eld_monthly: 50, truck_payment_monthly: 1200, hvut_annual: 580, irp_annual: 1380 }));
		ok(((res.blockers[0] || {}).detail || "").endsWith("books $3,043.33/mo of fixed costs into 3 finalized months ($9,129.99) — " +
			"insurance $1,630.00/mo, ELD fee $50.00/mo, truck payment $1,200.00/mo, HVUT $580.00/yr, IRP $1,380.00/yr"),
			`§3 (h) the Add form's full set is totalled by truckMonthlyFixed() and itemized as entered (got ${JSON.stringify((res.blockers[0] || {}).detail)})`);
	}
	{
		const res = run(noDriver({ in_service_date: "2026-06-01", insurance_monthly: 500, eld_monthly: -500 }));
		eq(summary(res), [{ field: "in_service_date", effect: null, periods: BACK }],
			"§3 (h) back-dated with amounts that cancel to a $0.00 total: refused — the drill-down itemizes the parts");
		ok(((res.blockers[0] || {}).detail || "").endsWith("books $0.00/mo of fixed costs into 3 finalized months ($0.00) — insurance $500.00/mo, ELD fee $-500.00/mo"),
			`§3 (h) ...naming both amounts, so a $0.00 total is not read as nothing (got ${JSON.stringify((res.blockers[0] || {}).detail)})`);
	}
	eq(summary(run(noDriver({ in_service_date: "2026-06-01", hvut_annual: 0.05 }))), [{ field: "in_service_date", effect: null, periods: BACK }],
		"§3 (h) back-dated with an annual HVUT that rounds to $0.00/mo: refused — the fleet accruals divide it unrounded");
	eq(summary(run(noDriver({ in_service_date: "2026-06-01", insurance_monthly: 1000, status: "Inactive" }))), [],
		"§3 (h) the same truck added Inactive: no blocker (it books nothing)");
	eq(summary(run(noDriver({ in_service_date: "", insurance_monthly: 1000 }))), [],
		"§3 (h) in-service date blank: bills from created_at, the open month — no blocker");
	eq(summary(run(noDriver({ in_service_date: "2026-06-01" }))), [],
		"§3 (h) back-dated with no costs: allowed to say so, since it bills nothing");
	eq(summary(run(noDriver({ in_service_date: "2026-06-01", insurance_monthly: -500 }))), [{ field: "in_service_date", effect: null, periods: BACK }],
		"§3 (h) back-dated with a NEGATIVE amount: refused too — it restates the months just the same");
}

// ═══════════════════════════════════════════════════════════════ §4
const NOW_ISO = `${TODAY}T15:00:00.000Z`;
// The route stamps created_at off `new Date()`; pinned so the open month is
// 2026-09 on any machine.
class FixedDate extends Date {
	constructor(...args) { if (args.length) super(...args); else super(NOW_ISO); }
	static now() { return Date.parse(NOW_ISO); }
}
const tick = () => new Promise((done) => setImmediate(done));
async function quiet(fn) {
	const e = console.error;
	console.error = () => {};
	try { return await fn(); } finally { console.error = e; }
}
const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const DISPATCHER = { id: 2, username: "kevin", role: "Dispatcher" };
const INVESTOR = { id: 42, username: "lx", role: "Investor" };

// `duringRead` runs inside the sheet read, after it has yielded — i.e. while the
// route is suspended between its checks and its writes.
function mountPost(db, { jt = makeJt(), jtFails = false, duringRead = null } = {}) {
	const m = buildModule(db);
	// `guard` records a copy of each truck the route asks its month-end lock
	// about; the real guard still answers.
	const calls = { jt: 0, activeLoad: 0, guard: [] };
	let handler = null;
	const grab = (p, ...rest) => { handler = rest[rest.length - 1]; };
	const env = {
		app: { post: grab }, requireRole: () => (req, res, next) => next(),
		...m, db,
		...PHOTO_CHECK,
		truckCreateLockBlockers: (truck, history) => { calls.guard.push({ ...truck }); return m.truckCreateLockBlockers(truck, history); },
		checkDriverActiveLoad: async () => { calls.activeLoad++; await tick(); return null; },
		getJobTrackingCached: async () => {
			calls.jt++;
			await tick();
			if (duringRead) duringRead();
			if (jtFails) throw new Error("Job Tracking could not be read (test)");
			return jt;
		},
		notifyChange: () => {},
		Date: FixedDate,
	};
	const names = Object.keys(env);
	new Function(...names, ROUTE_POST)(...names.map((k) => env[k]));
	if (typeof handler !== "function") die("the lifted POST /api/trucks did not register a handler");
	const post = (user, body) => quiet(async () => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; }, setHeader() {} };
		await handler({ params: {}, query: {}, body, session: { user }, sessionID: "t-sid" }, res);
		return out;
	});
	return { post, calls };
}
// The body AddTruckForm.vue's submit sends (`emit('submit', {...})`), for the
// reported request: a Super Admin adding LogisX-#23 for owner 5 with the new
// hire at $300/day, in service today, the cost fields at the form's defaults.
const addForm = (over = {}) => {
	const b = {
		unitNumber: "LogisX-#23", make: "Freightliner", model: "Cascadia", year: 2022, vin: "", licensePlate: "",
		status: "Active", assignedDriver: NEW_HIRE, ownerId: 5, notes: "", photo: "",
		insuranceMonthly: 0, eldMonthly: 0, truckPaymentMonthly: 0, hvutAnnual: 0, irpAnnual: 0, adminFeePct: 50,
		in_service_date: TODAY, inServiceDate: TODAY, driverPayDaily: 300,
		purchasePrice: 0, titleStatus: "Clean", maintenanceFundMonthly: 0, fuel_tank_gallons: 0, avg_mpg: 0, ...over,
	};
	for (const [k, v] of Object.entries(over)) if (v === undefined) delete b[k];
	return b;
};
const truckByUnit = (db, unit) => db.prepare("SELECT * FROM trucks WHERE unit_number = ?").get(unit);
const snapshot = (db) => JSON.stringify({
	trucks: db.prepare("SELECT * FROM trucks ORDER BY id").all(),
	assignments: db.prepare("SELECT * FROM truck_assignments ORDER BY id").all(),
	history: db.prepare("SELECT * FROM carrier_driver_history ORDER BY id").all(),
});
const audits = (db, action) => db.prepare("SELECT * FROM audit_trail WHERE action = ? ORDER BY id").all(action);

async function routeSection() {
	section("§4 POST /api/trucks (the shipped handler, the real guard)");
	{
		const db = makeDb();
		const { post, calls } = mountPost(db);
		const r = await post(SUPER, addForm());
		const t = truckByUnit(db, "LogisX-#23");
		ok(r.status === 200 && r.body && r.body.success === true, `§4 the reported request: 200 (got ${r.status} ${JSON.stringify(r.body)})`);
		ok(!!t && t.assigned_driver === NEW_HIRE && t.owner_id === 5 && t.driver_pay_daily === 300 && t.in_service_date === TODAY && t.status === "Active",
			"§4 ...the truck stored with the new hire, owner 5, $300/day, in service today");
		eq(db.prepare("SELECT driver_name, end_date FROM truck_assignments WHERE truck_id = ?").all(t && t.id), [{ driver_name: NEW_HIRE, end_date: "" }],
			"§4 ...and their first assignment row opened on it");
		eq(calls.jt, 1, "§4 ...having read Job Tracking once");
		eq(audits(db, "create_truck_blocked").length, 0, "§4 ...with no refusal row");
		const line = (audits(db, "create_truck")[0] || {}).details || "";
		ok(line === `Created truck LogisX-#23 (Active), in-service date: ${TODAY}, fixed costs: $0.00/mo`,
			`§4 ...and a create_truck line naming the in-service date and fixed costs (got ${JSON.stringify(line)})`);
	}
	{
		const db = makeDb();
		const { post } = mountPost(db);
		const r = await post(SUPER, addForm({ assignedDriver: "  dana   NEWHIRE " }));
		ok(r.status === 200 && (truckByUnit(db, "LogisX-#23") || {}).assigned_driver === NEW_HIRE,
			`§4 the driver named in other case and spacing: 200, stored under their spelling (got ${r.status})`);
	}
	{
		const db = makeDb();
		const { post } = mountPost(db, { jt: makeJt([load(NEW_HIRE, MARCH)]) });
		const before = snapshot(db);
		const r = await post(SUPER, addForm());
		const b = r.body || {};
		ok(r.status === 409 && b.code === "PERIOD_FINALIZED", `§4 the same request with a 2026-03 load on the sheet: 409 PERIOD_FINALIZED (got ${r.status} ${b.code})`);
		eq(b.periods, lockedFrom("2026-03"), "§4 ...for 2026-03..2026-08 only");
		eq((b.blockers || []).map((x) => x.field), ["driver_pay_daily", "owner_id"], "§4 ...naming the rate and the driver set");
		ok(snapshot(db) === before, "§4 ...and nothing written: no truck, no assignment, no carrier history");
		const [a] = audits(db, "create_truck_blocked");
		ok(!!a && a.details.includes("[PERIOD_FINALIZED]") && a.details.includes("fixed costs $0.00/mo") && a.details.includes(`driver ${NEW_HIRE}`) &&
			a.details.includes(`periods=${lockedFrom("2026-03").join(",")}`) && a.username === "super_admin",
			`§4 ...audited as create_truck_blocked with the periods, the driver and the fixed costs (got ${JSON.stringify(a && a.details)})`);
	}
	{
		const db = makeDb();
		const { post } = mountPost(db, { jt: makeJt([load(NEW_HIRE, SEPT)]) });
		const r = await post(SUPER, addForm());
		ok(r.status === 200, `§4 with loads only in the open month: 200 (got ${r.status} ${JSON.stringify(r.body)})`);
	}
	{
		const db = makeDb();
		const { post } = mountPost(db);
		const r = await post(DISPATCHER, addForm({ unitNumber: "LogisX-#25", driverPayDaily: 0 }));
		const t = truckByUnit(db, "LogisX-#25") || {};
		ok(r.status === 200 && t.assigned_driver === NEW_HIRE && t.owner_id === 5 && t.driver_pay_daily === 0,
			`§4 a Dispatcher adding the new hire with no rate: 200, the driver assigned (got ${r.status} ${JSON.stringify(r.body)})`);
	}
	{
		const db = makeDb();
		const { post, calls } = mountPost(db);
		const r = await post(SUPER, addForm({ unitNumber: "LogisX-#24", assignedDriver: "", driverPayDaily: 0 }));
		const t = truckByUnit(db, "LogisX-#24") || {};
		ok(r.status === 200 && t.assigned_driver === "" && calls.jt === 0 && calls.activeLoad === 0,
			`§4 no driver named: 200, and Job Tracking not read (got ${r.status} ${JSON.stringify(r.body)}, jt ${calls.jt})`);
	}
	{
		const db = makeDb();
		const { post } = mountPost(db, { jtFails: true });
		const before = snapshot(db);
		const r = await post(SUPER, addForm());
		ok(r.status === 500 && snapshot(db) === before, `§4 Job Tracking unreadable with a driver named: refused (500), nothing written (got ${r.status})`);
	}
	{
		// The unit-number check reads after the awaits: a truck that lands while the
		// route waits on the sheet, spelled in another case, is seen.
		const db = makeDb();
		const { post } = mountPost(db, { duringRead: () => db.prepare("INSERT INTO trucks (unit_number) VALUES ('logisx-#23')").run() });
		const r = await post(SUPER, addForm());
		const n = db.prepare("SELECT COUNT(*) AS n FROM trucks WHERE LOWER(unit_number) = 'logisx-#23'").get().n;
		ok(r.status === 400 && /already exists/.test((r.body || {}).error || "") && n === 1,
			`§4 a same-unit truck added in another case while the route waits on the sheet: 400, one row (got ${r.status}, ${n} rows)`);
	}
	{
		// An Investor cannot name a driver, so there is no driver to read history
		// for — even one whose only sheet row is undatable, which would refuse.
		const db = makeDb();
		const { post, calls } = mountPost(db, { jt: makeJt([load(NEW_HIRE, { pickup: "14:00" })]) });
		const r = await post(INVESTOR, addForm({ unitNumber: "INV-25-B", driverPayDaily: undefined }));
		const t = truckByUnit(db, "INV-25-B") || {};
		ok(r.status === 200 && t.assigned_driver === "" && t.owner_id === 42 && calls.jt === 0,
			`§4 an Investor naming a driver: 200, no driver, the sheet not read (got ${r.status} ${JSON.stringify(r.body)}, jt ${calls.jt})`);
	}

	// ── (h) the Add form's costs, admin fee and photo ──
	const fiveOf = (o) => o && [o.insurance_monthly, o.eld_monthly, o.truck_payment_monthly, o.hvut_annual, o.irp_annual];
	const storedOf = (t) => t && [...fiveOf(t), t.admin_fee_pct, t.photo];
	// A 4 × 3 JPEG header: the least checkImage() reads as a JPEG.
	const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/wAARCAADAAQDAAAAAAAAAAAA/9k=";
	const FULL = { insuranceMonthly: 1630, eldMonthly: "50", truckPaymentMonthly: 1200, hvutAnnual: 580, irpAnnual: "1380", adminFeePct: 40, photo: PHOTO };
	for (const [label, who, over] of [["a Super Admin", SUPER, {}], ["a Dispatcher", DISPATCHER, { driverPayDaily: 0 }]]) {
		const db = makeDb();
		const { post, calls } = mountPost(db);
		const r = await post(who, addForm({ ...FULL, ...over }));
		eq([r.status, storedOf(truckByUnit(db, "LogisX-#23"))], [200, [1630, 50, 1200, 580, 1380, 40, PHOTO]],
			`§4 (h) ${label} adding with the Add form's costs, admin fee and photo: stored as sent`);
		eq(calls.guard.map(fiveOf), [[1630, 50, 1200, 580, 1380]], `§4 (h) ...and the month-end lock asked about those same five amounts (${label})`);
		const line = (audits(db, "create_truck")[0] || {}).details || "";
		ok(line.endsWith(", fixed costs: $3,043.33/mo"), `§4 (h) ...and the create_truck line naming $3,043.33/mo (got ${JSON.stringify(line)})`);
	}
	// Back-dated into the finalized months, with no driver so that only check (1)
	// can answer.
	const backdated = (over = {}) => addForm({
		unitNumber: "LogisX-#24", assignedDriver: "", driverPayDaily: 0,
		in_service_date: "2026-06-01", inServiceDate: "2026-06-01", insuranceMonthly: 1000, ...over,
	});
	{
		const db = makeDb();
		const { post, calls } = mountPost(db);
		const before = snapshot(db);
		const r = await post(SUPER, backdated());
		const b = r.body || {};
		ok(r.status === 409 && b.code === "PERIOD_FINALIZED" && JSON.stringify((b.blockers || []).map((x) => x.field)) === '["in_service_date"]',
			`§4 (h) Active, in service 2026-06-01, $1,000/mo insurance: 409 PERIOD_FINALIZED on in_service_date (got ${r.status} ${JSON.stringify(b.blockers && b.blockers.map((x) => x.field))})`);
		eq(b.periods, ["2026-06", "2026-07", "2026-08"], "§4 (h) ...for 2026-06..2026-08");
		ok(snapshot(db) === before, "§4 (h) ...nothing written");
		eq(calls.jt, 0, "§4 (h) ...and no driver named, so Job Tracking was not read");
		ok(((audits(db, "create_truck_blocked")[0] || {}).details || "").includes("fixed costs $1,000.00/mo"),
			"§4 (h) ...the refusal row naming the monthly fixed costs");
	}
	{
		// A negative amount never reaches the guard now: it is refused as an amount
		// first. (The guard's own answer for one is in §3.)
		const db = makeDb();
		const { post, calls } = mountPost(db);
		const r = await post(SUPER, backdated({ insuranceMonthly: "-500" }));
		const b = r.body || {};
		ok(r.status === 400 && b.code === "INVALID_AMOUNT" && b.field === "insurance_monthly" && calls.guard.length === 0 && !truckByUnit(db, "LogisX-#24"),
			`§4 (h) the same truck with a negative amount: 400 INVALID_AMOUNT before the guard is asked, no truck (got ${r.status} ${b.code})`);
	}
	for (const [label, over, check] of [
		["with no costs", { insuranceMonthly: 0 }, (t) => t.in_service_date === "2026-06-01" && t.insurance_monthly === 0],
		["added Inactive", { status: "Inactive" }, (t) => t.status === "Inactive" && t.in_service_date === "2026-06-01" && t.insurance_monthly === 1000],
		["with the in-service date blank (bills from the open month)", { in_service_date: "", inServiceDate: "" }, (t) => t.in_service_date === "" && t.insurance_monthly === 1000],
	]) {
		const db = makeDb();
		const { post } = mountPost(db);
		const r = await post(SUPER, backdated(over));
		const t = truckByUnit(db, "LogisX-#24");
		ok(r.status === 200 && !!t && check(t), `§4 (h) the back-dated truck ${label}: 200, stored as sent (got ${r.status} ${JSON.stringify(r.body)})`);
	}
	{
		// An Investor's add keeps the column defaults, and the guard — asked about
		// the row that lands — sees $0, so a back-dated in-service date is allowed.
		const db = makeDb();
		const { post, calls } = mountPost(db);
		const r = await post(INVESTOR, backdated({ ...FULL, unitNumber: "INV-25-C", driverPayDaily: undefined }));
		eq([r.status, storedOf(truckByUnit(db, "INV-25-C"))], [200, [0, 0, 0, 0, 0, 50, ""]],
			"§4 (h) an Investor adding with costs, an admin fee and a photo: created with the defaults — $0, the 50% fee, no photo");
		eq(calls.guard.map(fiveOf), [[0, 0, 0, 0, 0]], "§4 (h) ...and the month-end lock asked about $0");
	}
	for (const [label, fee, expect] of [
		["blank (\"\")", "", 50], ["missing", undefined, 50], ["null", null, 50],
		["0 (a deliberate zero)", 0, 0], ["\"37.5\"", "37.5", 37.5], ["100 (the ceiling)", 100, 100],
	]) {
		const db = makeDb();
		const { post } = mountPost(db);
		const r = await post(SUPER, addForm({ adminFeePct: fee }));
		const t = truckByUnit(db, "LogisX-#23") || {};
		ok(r.status === 200 && t.admin_fee_pct === expect, `§4 (h) the admin fee ${label}: stored as ${expect} (got ${r.status}, ${t.admin_fee_pct})`);
	}
	// Anything that is not blank or a number from 0 to 100 refuses the add for the
	// two roles that store the fee, before the guard is asked and before any write.
	for (const [label, fee] of [
		["unreadable (\"abc\")", "abc"], ["\"Infinity\"", "Infinity"], ["100.01", 100.01], ["-1", -1], ["5000", 5000],
	]) {
		const db = makeDb();
		const { post, calls } = mountPost(db);
		const before = snapshot(db);
		const r = await post(SUPER, addForm({ adminFeePct: fee }));
		eq([r.status, r.body], [400, { error: "Admin fee must be a number between 0 and 100", code: "INVALID_AMOUNT", field: "admin_fee_pct" }],
			`§4 (h) the admin fee ${label}: 400 INVALID_AMOUNT naming admin_fee_pct`);
		ok(snapshot(db) === before && calls.guard.length === 0 && calls.jt === 0 && calls.activeLoad === 0,
			`§4 (h) the admin fee ${label}: nothing written, and neither the guard, the sheet nor the active-load check reached`);
	}
	{
		const db = makeDb();
		const { post } = mountPost(db);
		// (An unreadable amount is refused — scripts/test-truck-cost-amounts.js.)
		const r = await post(DISPATCHER, addForm({
			driverPayDaily: 0, insuranceMonthly: "", eldMonthly: "  ", truckPaymentMonthly: null, hvutAnnual: undefined, irpAnnual: "1380.5", photo: undefined,
		}));
		eq([r.status, storedOf(truckByUnit(db, "LogisX-#23"))], [200, [0, 0, 0, 0, 1380.5, 50, ""]],
			"§4 (h) blank and missing amounts: 0 for each, the rest as sent, no photo");
	}
	{
		const db = makeDb();
		const { post } = mountPost(db);
		const before = snapshot(db);
		const r = await post(SUPER, addForm({ photo: { src: PHOTO } }));
		const b = r.body || {};
		ok(r.status === 415 && b.code === "UNSUPPORTED_IMAGE_TYPE" && b.field === "photo" && snapshot(db) === before,
			`§4 (h) a photo that is not text: 415 UNSUPPORTED_IMAGE_TYPE on field "photo", nothing written (got ${r.status} ${JSON.stringify(b)})`);
	}
}

// ═══════════════════════════════════════════════════════════════ §5
function sourcePins() {
	section("§5 source pins");
	const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	const tpo = code(ROUTE_POST);
	const at = (s) => tpo.indexOf(s);
	const activeAt = at("await checkDriverActiveLoad(requestedDriver)");
	const jtAt = at("jt = await getJobTrackingCached();");
	const canonAt = at("const finalAssignedDriver = canonicalDriverName(requestedDriver);");
	const histAt = at("const history = driverHistoryFloorMonth(finalAssignedDriver, jt);");
	const guardAt = at("const createLock = truckCreateLockBlockers({");
	const insertAt = at("INSERT INTO trucks (");
	ok(activeAt > 0 && jtAt > activeAt && canonAt > jtAt, "§5 POST /api/trucks reads Job Tracking beside the active-load check, above canonicalDriverName()");
	ok(tpo.lastIndexOf("await ") < canonAt, "§5 ...and nothing awaits after canonicalDriverName(), so no await sits between the guard and the INSERT");
	ok(histAt > canonAt && histAt < guardAt, "§5 the history is computed after the name resolves and before the guard");
	const uniqueAt = at('db.prepare("SELECT id FROM trucks WHERE LOWER(unit_number) = LOWER(?)")');
	ok(uniqueAt > tpo.lastIndexOf("await ") && uniqueAt < guardAt, "§5 the unit-number check reads after the last await, before the guard");
	const guardCall = guardAt > 0 && insertAt > guardAt ? tpo.slice(guardAt, insertAt) : "";
	ok(guardCall.includes("}, history);"), "§5 the guard is handed the history");
	ok(guardCall.includes("...createCosts,") && !/insurance_monthly: 0, eld_monthly: 0/.test(tpo), "§5 the guard is handed the parsed costs, not zeros");
	ok(tpo.includes("createPhoto, createCosts.insurance_monthly, createCosts.eld_monthly, createCosts.truck_payment_monthly, createCosts.hvut_annual, createCosts.irp_annual, createAdminFee);"),
		"§5 the INSERT binds the same cost object");
	ok(tpo.includes('const costsAllowed = req.session.user.role === "Super Admin" || req.session.user.role === "Dispatcher";') &&
		tpo.includes("const feeParsed = costsAllowed ? parseAdminFeePct(adminFeePct) : { value: 50 };") &&
		tpo.includes("const createAdminFee = feeParsed.value ?? 50;"),
		"§5 the costs are honoured for the PUT's two roles only, the admin fee through the rule the PUT shares");

	const guard = code(FN_SRC.truckCreateLockBlockers);
	ok((guard.match(/driverPayLockedMonths\(driverName, locked, history\)/g) || []).length === 2 && !/driverPayLockedMonths\(driverName, locked\)/.test(guard),
		"§5 truckCreateLockBlockers() sizes both driver checks off the history");
	ok(guard.includes("const carried = AMOUNTS.filter(([col]) => (Number(truck[col]) || 0) !== 0);") &&
		guard.includes("if (fixedMonths.length && carried.length) {") && !/monthly\s*(?:>=?|!==?)\s*0\b/.test(guard),
		"§5 check (1) fires when any of the five amounts is non-zero, not on the monthly total");

	const dplm = code(FN_SRC.driverPayLockedMonths);
	ok(dplm.includes('"SELECT start_date FROM truck_assignments WHERE LOWER(driver_name) = LOWER(?)"') &&
		dplm.includes("if (!rows.length) return locked.slice();") &&
		dplm.includes("if (!/^\\d{4}-\\d{2}$/.test(from)) return locked.slice(); // unreadable → cannot bound it") &&
		dplm.includes("return locked.filter((p) => p >= earliest).sort();"),
		"§5 driverPayLockedMonths()'s assignment-only branch is intact for the callers that pass no history");
	ok(dplm.indexOf("if (history !== undefined) {") > 0 && dplm.indexOf("if (history !== undefined) {") < dplm.indexOf("const rows = db.prepare("),
		"§5 ...and the history, when given, is consulted instead of it");
	const helper = code(FN_SRC.driverHistoryFloorMonth);
	ok(!/\bawait\b|\basync\b/.test(helper), "§5 driverHistoryFloorMonth() is synchronous");
	ok(helper.includes("findCol(headers, /^driver$/i)") && helper.includes("headers.filter((h) => /date|appo/i.test(h))") && helper.includes("moneySheetDate(r[col])"),
		"§5 ...reading the pay math's Driver column and every date-like cell through moneySheetDate()");
}

(async () => {
	historySection();
	lockedMonthsSection();
	guardSection();
	await routeSection();
	sourcePins();

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`✗ ${failures.length} assertion(s) failed, ${pass} passed:`);
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
