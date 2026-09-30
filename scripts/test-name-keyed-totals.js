#!/usr/bin/env node
/**
 * Name-keyed totals are built without inherited keys, and a driver name that
 * reads as a built-in property name is treated as unassigned.
 *
 * The money and ops code sums rows into maps keyed by a driver's name (and,
 * beside them, by the sheet's Truck and Load ID cells): revenue, active days,
 * pay, deductibles, queues, fuel spend, ratings. Every such map is a
 * null-prototype object, so a key is only ever what the data put there, and a
 * name for which isBuiltInPropertyName() is true ("__proto__", " Constructor ",
 * "toString", in any case or spacing) reads as blank through
 * driverNameForTotals(): the row counts wherever a blank-driver row counts, and
 * no total is filed or published under that name.
 *
 * WHAT IS ASSERTED — the shipping code, lifted out of server.js (it cannot be
 * required: it opens SQLite, reads a key and listens on import) and run against
 * an in-memory SQLite, a fake Job Tracking sheet and a fixed clock. Only I/O is
 * stubbed (the sheet read, the ELD day index, geocoded addresses, the audit log,
 * the fuel-event snapshots); every helper the totals call is the shipped one.
 *   §1 THE PREDICATE AND THE HELPER, on names that match and names that only
 *      look close; the predicate's lowercased names are built once and kept on
 *      the function itself.
 *   §2 THE SHARED HELPERS — getDriverPayStructures(), getAllExcludedDriverDays(),
 *      getDeductibleExpensesByDriverMonth(), foldExpenseTotalsByDriver(),
 *      expenseDriverKey() and computeDriverQueues(): null-prototype results, no
 *      key for such a name, a lookup by one finds nothing, and every override
 *      row after one still applies.
 *   §3 THE TOTALS — computeInvestorMonthlyEarnings(), GET /api/investor (fleet
 *      and investor scope), GET /api/financials (with the month drill-down),
 *      GET /api/expenses/fuel-analytics, GET /api/dashboard,
 *      GET /api/locations/latest, GET /api/trucks and
 *      GET /api/load-ratings/averages, each run on three copies of one data set:
 *        NAMED   rows carrying such names — Driver cells, expenses, invoices,
 *                override rows, ratings, queue responses — and such Truck cells;
 *        BLANK   the same rows with those driver names blank;
 *        NONE    without those rows.
 *      NAMED must answer exactly what BLANK answers (apart from the fields that
 *      echo a stored name as written), and every normal driver's figures must
 *      be exactly NONE's. Nothing throws or logs an error, no response carries
 *      such a key at any depth (a map keyed by unit number excepted: it lists
 *      every truck, see §3b), and the built-in objects are unchanged after
 *      every call. Every variant carries three trucks whose unit numbers read
 *      as built-in property names ("constructor" and "__proto__", active;
 *      "valueOf", inactive), stored as if before parseUnitNumber() refused
 *      such a number.
 *   §3b UNIT NUMBERS AND LOAD IDS — those three trucks are listed by GET
 *      /api/investor (perTruckData), GET /api/financials (perTruck and the
 *      month's trucks) and GET /api/trucks with well-formed figures, exactly
 *      the ones each gets under an ordinary unit number (the same data with
 *      "105", "106" and "107" in their place), and every other truck's
 *      figures and the fleet totals are unchanged; the fuel-gallons recovery
 *      (matchFuelEventsToReceipts()) matches episodes on such trucks and files
 *      each truck's reference under its own unit; GET
 *      /api/admin/scan-duplicates groups Load IDs so named like any other.
 *   §3c THE LOAD-RATING SAVE — PUT /api/load-ratings/:loadId refuses a
 *      driverName that reads as a built-in property name (400
 *      DRIVER_NAME_RESERVED, field driverName) and one that is not text (400,
 *      never a throw), with nothing written; an ordinary name is saved.
 *   §4 SOURCE PINS — every name-keyed and unit-keyed map this covers, per
 *      function or route, is declared null-prototype at each of its
 *      declarations, including the three §3 cannot run (the ELD poll, the HOS
 *      matchers, the stale-location scan); GET /api/investor asks whether a
 *      unit was given a share as an own-property test, never with `in`.
 *   §5 MUTANTS — a plain {} restored at one site, the blank rule removed, one
 *      per-driver map as it was before, the unit-keyed maps restored one at a
 *      time, and each load-rating refusal removed; each must fail an
 *      assertion in §1–§3c.
 *
 * Pure: no server, no app.db, no network, no Sheets.
 * Run: node scripts/test-name-keyed-totals.js     # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const geolib = require("geolib");
const fuelModel = require("../lib/fuel-model");
const { normalizeLoadId } = require("../lib/ratecon-load");
const investorReportOptions = require("../lib/investor-report-options");

const SHIPPED = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// The built-in names, read before any lifted code runs, for an oracle written
// apart from the shipped predicate.
const BUILTIN_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype).map((n) => n.toLowerCase()));
const readsAsBuiltIn = (s) => typeof s === "string" && BUILTIN_NAMES.has(s.trim().replace(/\s+/g, " ").toLowerCase());

// ───────────────────────────────────────────────────────────────── lifting
// Anchored on a newline and counted, so a mention in a comment is never taken
// for the definition and a second copy fails the run. A top-level function ends
// at the first column-0 "}" line; a route at the first "});".
function liftBetween(src, needle, terminator, label) {
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 ${label} in server.js, found ${hits}`);
	const a = src.indexOf(needle) + 1;
	const end = src.indexOf(terminator, a);
	if (end < 0) throw new Error(`no terminator after ${label}`);
	return src.slice(a, end + terminator.length);
}
function liftFn(src, name) {
	const asyncNeedle = `\nasync function ${name}(`;
	return src.includes(asyncNeedle)
		? liftBetween(src, asyncNeedle, "\n}\n", `async function ${name}()`)
		: liftBetween(src, `\nfunction ${name}(`, "\n}\n", `function ${name}()`);
}
const liftRoute = (src, head) => liftBetween(src, `\n${head}`, "\n});\n", head);
// A one-statement declaration; a line ending in "=" continues on the next.
function liftDecl(src, kind, name) {
	const needle = `\n${kind} ${name} =`;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 ${kind} ${name} in server.js, found ${hits}`);
	const start = src.indexOf(needle) + 1;
	let end = src.indexOf("\n", start);
	if (/=\s*$/.test(src.slice(start, end))) end = src.indexOf("\n", end + 1);
	return src.slice(start, end);
}

const CONSTS = ["EXPENSE_PNL_FILTER", "EXPENSE_PERIOD_EXPR", "CANCELED_STATUS_RE", "RFC2822_MONTHS",
	"BROKER_WITHHELD_RE", "MOVEMENT_MOVING_MPS", "MOVEMENT_ACTIVE_MS",
	// The fuel-gallons recovery's thresholds (§3b).
	"FUEL_EVENTS_MATCH_DAYS", "FUEL_MATCH_MIN_GAL_PER_100PCT", "FUEL_MATCH_MAX_GAL_PER_100PCT", "FUEL_MATCH_MIN_GALLONS",
	"FUEL_MATCH_MAX_KM", "FUEL_MATCH_AMBIGUITY_MARGIN", "FUEL_CALIB_MIN_RISE_PCT", "FUEL_ODOMETER_CONFLICT_MI"];
const LETS = ["lastPayStructShadowWarnMs"];
const FNS = [
	// Under test.
	"normalizeDriverName", "isBuiltInPropertyName", "driverNameForTotals",
	"getDriverPayStructures", "getAllExcludedDriverDays", "expenseDriverKey", "foldExpenseTotalsByDriver",
	"getDeductibleExpensesByDriverMonth", "computeDriverQueues", "computeInvestorMonthlyEarnings",
	// What the totals call, shipped as is.
	"findCol", "pickAddressColumn", "loadKeySet", "excludeDroppedLoads", "liveJobTrackingView", "moneySheetDate",
	"houstonDay", "getWeekRange", "resolveDailyRate", "resolveInvestorSplitPct", "resolvePreviewUser",
	"getCarrierDBFromSQLite", "getInvestorDriverSet", "getInvestorDriverMonthWindows", "investorExpenseScopeSql",
	"assignmentMonthKey", "intersectMonthWindow", "truckChargeFromMonth", "truckChargeUntilMonth",
	"truckChargedInMonth", "truckMonthlyFixed", "truckBilledMonthCount", "computeLossCarryForward",
	"resolveBrokerWithheldColumns", "sanitizeBrokerColumns", "sanitizeDetails", "parseRoutemateBearing",
	"classifyMovement", "reservedDriverNameRefusal",
	// The fuel-gallons recovery (§3b), run with persist: false, so nothing it
	// would write is reached.
	"matchFuelEventsToReceipts", "shiftDayKey", "fuelMatchDistanceKm", "isDefReceipt",
];
const ROUTES = {
	investor: 'app.get("/api/investor", requireRole("Super Admin", "Investor"), async (req, res) => {',
	financials: 'app.get("/api/financials", requireRole("Super Admin"), async (req, res) => {',
	fuel: 'app.get("/api/expenses/fuel-analytics", requireRole("Super Admin", "Dispatcher"), fuelAnalyticsLimiter, (req, res) => {',
	dashboard: 'app.get("/api/dashboard", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
	locations: 'app.get("/api/locations/latest", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
	trucks: 'app.get("/api/trucks", requireRole("Super Admin", "Dispatcher", "Investor"), async (req, res) => {',
	ratings: 'app.get("/api/load-ratings/averages", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	ratingsPut: 'app.put("/api/load-ratings/:loadId", requireRole("Super Admin"), (req, res) => {',
	scanDuplicates: 'app.get("/api/admin/scan-duplicates", requireRole("Super Admin"), async (req, res) => {',
};

const LIFT_CACHE = new Map();
function liftedFor(src) {
	if (!LIFT_CACHE.has(src)) {
		LIFT_CACHE.set(src, [
			...CONSTS.map((c) => liftDecl(src, "const", c)),
			...LETS.map((c) => liftDecl(src, "let", c)),
			...FNS.map((f) => liftFn(src, f)),
			...Object.values(ROUTES).map((h) => liftRoute(src, h)),
			`return { ${[...CONSTS, ...FNS].join(", ")} };`,
		].join("\n"));
	}
	return LIFT_CACHE.get(src);
}

// ───────────────────────────────────────────────────────────────── the clock
// Noon in Houston, 2026-09-27: every "now" in the lifted code reads this.
const NOW_MS = Date.UTC(2026, 8, 27, 17, 0, 0);
class FixedDate extends Date {
	constructor(...args) { super(...(args.length ? args : [NOW_MS])); }
	static now() { return NOW_MS; }
}

// ───────────────────────────────────────────────────────────────── fixtures
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Driver", "Pickup Address", "Pickup Appointment", "Drop-off Address",
	"Drop-off Appointment", "Job Status", "  Payment  ", "Broker Contact Name", "Assigned Date",
	"Status Update Date", "Truck", "Owner ID",
];
const jt = (loadId, driver, status, pickup, dropoff, assigned, pay, truck, owner) => ({
	"Contract ID": "", "Load ID": loadId, Details: "Dry van", Driver: driver, "Pickup Address": "",
	"Pickup Appointment": pickup, "Drop-off Address": "", "Drop-off Appointment": dropoff, "Job Status": status,
	"  Payment  ": pay, "Broker Contact Name": "", "Assigned Date": assigned, "Status Update Date": "",
	Truck: truck, "Owner ID": owner,
});
// Normal drivers: Pat Percent (percentage, 20%), Dee Dayrate (fixed, $300/day
// in the directory) and Sam Kelly (fixed, his truck's $260), each in more than
// one spelling, plus one row with a blank Driver cell.
const NORMAL_ROWS = [
	jt("1001", "Pat Percent", "Delivered", "7/6/2026 8:00", "7/7/2026 10:00", "7/5/2026", " $ 2,000.00 ", "101", "5"),
	jt("1002", "Pat Percent", "Delivered", "8/3/2026 8:00", "8/4/2026 10:00", "8/2/2026", "$1,500.00", "101", "5"),
	jt("1003", "Dee Dayrate", "Delivered", "7/14/2026 8:00", "7/15/2026 10:00", "7/13/2026", "$1,200.00", "102", "5"),
	jt("1004", "Dee  Dayrate", "Completed", "8/11/2026 8:00", "8/13/2026 10:00", "8/10/2026", "$1,800.00", "102", "5"),
	jt("1005", "Sam Kelly", "POD Received", "7/20/2026 8:00", "7/21/2026 10:00", "7/19/2026", "$900.00", "103", "0"),
	jt("1006", "sam kelly", "Delivered", "8/18/2026 8:00", "8/19/2026 10:00", "8/17/2026", "$1,100.00", "103", "0"),
	jt("1007", "", "Delivered", "8/20/2026 8:00", "8/20/2026 18:00", "8/19/2026", "$700.00", "", "5"),
	jt("2001", "Dee Dayrate", "Dispatched", "9/28/2026 8:00", "9/29/2026 10:00", "9/26/2026", "$1,000.00", "102", "5"),
	jt("2002", "Sam Kelly", "Assigned", "9/29/2026 8:00", "9/30/2026 10:00", "9/26/2026", "$1,000.00", "103", "0"),
	jt("2003", "Pat Percent", "In Transit", "9/26/2026 8:00", "9/27/2026 10:00", "9/25/2026", "$1,000.00", "101", "5"),
];
// Rows whose Driver cell reads as a built-in property name — completed ones
// that carry revenue (one scoped to the investor by Owner ID, one only by the
// driver fallback), queued ones, and working ones — two of them with such a
// Truck cell too. `driver` is the only field BLANK changes.
const NAMED_ROWS = [
	jt("3001", "__proto__", "Delivered", "8/5/2026 8:00", "8/6/2026 10:00", "8/4/2026", "$500.00", "__proto__", "5"),
	jt("3002", " Constructor ", "Delivered", "7/9/2026 8:00", "7/10/2026 10:00", "7/8/2026", "$450.00", "constructor", ""),
	jt("3003", "toString", "Delivered", "8/25/2026 8:00", "8/26/2026 10:00", "8/24/2026", "$300.00", "", "5"),
	jt("3004", "__proto__", "Dispatched", "9/28/2026 8:00", "9/29/2026 10:00", "9/26/2026", "$800.00", "", "5"),
	jt("3005", "CONSTRUCTOR", "Assigned", "9/28/2026 8:00", "9/29/2026 10:00", "9/26/2026", "$800.00", "", "0"),
	jt("3006", "hasOwnProperty", "In Transit", "9/26/2026 8:00", "9/27/2026 10:00", "9/25/2026", "$800.00", "", "0"),
	jt("3007", "valueOf", "Heading to Shipper", "9/27/2026 8:00", "9/28/2026 10:00", "9/26/2026", "$800.00", "", "0"),
];
// Every amount is a whole number of dollars, so a sum split across groups is
// exact whatever order it is added in.
const NORMAL_EXPENSES = [
	{ driver: "Pat Percent", type: "Fuel", amount: 100, date: "2026-07-08", status: "Approved", owner_id: 5, truck_unit: "101", gallons: 25, odometer: 200100 },
	{ driver: "pat  percent", type: "Maintenance", amount: 50, date: "2026-08-05", owner_id: 5, truck_unit: "101" },
	{ driver: "Pat Percent", type: "Fuel", amount: 999, date: "2026-08-06", status: "Rejected", owner_id: 5, truck_unit: "101", gallons: 200 },
	{ driver: "Pat Percent", type: "Fuel", amount: 110, date: "2026-08-14", owner_id: 5, truck_unit: "101", gallons: 27, odometer: 201600 },
	{ driver: "Dee Dayrate", type: "Fuel", amount: 80, date: "2026-07-16", owner_id: 5, truck_unit: "102", gallons: 20, odometer: 100500 },
	{ driver: "Dee Dayrate", type: "Fuel", amount: 90, date: "2026-08-12", owner_id: 5, truck_unit: "102", gallons: 22, odometer: 101200 },
	{ driver: "Sam Kelly", type: "Toll", amount: 20, date: "2026-08-19", owner_id: 0, truck_unit: "103" },
	{ driver: "", type: "Fuel", amount: 30, date: "2026-08-20", owner_id: 5, truck_unit: "", gallons: 8 },
];
const NAMED_EXPENSES = [
	{ driver: "__proto__", type: "Fuel", amount: 60, date: "2026-08-07", owner_id: 5, truck_unit: "", gallons: 15 },
	{ driver: "constructor", type: "Maintenance", amount: 70, date: "2026-07-11", owner_id: 5, truck_unit: "" },
	{ driver: "toString", type: "Fuel", amount: 25, date: "2026-08-27", owner_id: 0, truck_unit: "", gallons: 5 },
	{ driver: "Hasownproperty", type: "Fuel", amount: 10, date: "2026-08-28", owner_id: 0, truck_unit: "", gallons: 2 },
	{ driver: " ValueOf ", type: "Fuel", amount: 12, date: "2026-08-29", owner_id: 0, truck_unit: "", gallons: 3 },
	{ driver: "Constructor", type: "Fuel", amount: 14, date: "2026-08-29", owner_id: 5, truck_unit: "", gallons: 4 },
	{ driver: "__proto__", type: "Fuel", amount: 40, date: "2026-08-15", owner_id: 0, truck_unit: "__proto__", gallons: 10, odometer: 50100 },
	{ driver: "constructor", type: "Fuel", amount: 45, date: "2026-08-22", owner_id: 0, truck_unit: "__proto__", gallons: 11, odometer: 50900 },
];
const NORMAL_INVOICES = [
	{ driver: "Pat Percent", week_start: "2026-08-01", week_end: "2026-08-07", total_earnings: 500, adjustment: 0, status: "Approved" },
	{ driver: "Dee Dayrate", week_start: "2026-08-08", week_end: "2026-08-14", total_earnings: 900, adjustment: -50, status: "Submitted" },
];
const NAMED_INVOICES = [
	{ driver: "__proto__", week_start: "2026-08-08", week_end: "2026-08-14", total_earnings: 200, adjustment: 0, status: "Submitted" },
	{ driver: "Constructor", week_start: "2026-08-15", week_end: "2026-08-21", total_earnings: 100, adjustment: 5, status: "Draft" },
];
// Insertion order is the read order: the named rows sit between two normal ones,
// so a row after them is the one that must still apply.
const OVERRIDES = [
	{ driver_name: "dee dayrate", excluded_date: "2026-08-12", action: "remove", named: false },
	{ driver_name: "__proto__", excluded_date: "2026-08-10", action: "add", named: true },
	{ driver_name: "constructor", excluded_date: "2026-07-15", action: "remove", named: true },
	{ driver_name: "tostring", excluded_date: "2026-08-09", action: "add", named: true },
	{ driver_name: "sam kelly", excluded_date: "2026-08-25", action: "add", named: false },
];
// Trucks whose unit numbers read as built-in property names, as if stored
// before parseUnitNumber() refused such a number, each with the ordinary number
// §3b compares it with: the same data with that number in its place must give
// that truck exactly the same figures. Pairs, not an object literal: in a
// literal, `__proto__: …` is no key at all. Ids 5, 6 and 7, so each keeps its
// place among the trucks whichever number it carries.
const BUILTIN_UNITS = [["constructor", "105"], ["__proto__", "106"], ["valueOf", "107"]];
const TWIN_UNIT = new Map(BUILTIN_UNITS);
const RATINGS = [
	{ load_id: "1001", driver_name: "Pat Percent", rating: 5, named: false },
	{ load_id: "1003", driver_name: "Dee Dayrate", rating: 4, named: false },
	{ load_id: "3001", driver_name: "__proto__", rating: 1, named: true },
	{ load_id: "3002", driver_name: "Constructor", rating: 2, named: true },
];

const DDL = `
	CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT DEFAULT '', role TEXT DEFAULT '', company_name TEXT DEFAULT '', driver_name TEXT DEFAULT '', email TEXT DEFAULT '', rating REAL DEFAULT 0);
	CREATE TABLE investors (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, profile_picture_url TEXT DEFAULT '', full_name TEXT DEFAULT '', carrier_name TEXT DEFAULT '');
	CREATE TABLE investor_config (owner_id INTEGER DEFAULT 0, key TEXT, value TEXT);
	CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, carrier_name TEXT DEFAULT '', state TEXT DEFAULT '', city TEXT DEFAULT '', zip TEXT DEFAULT '', address TEXT DEFAULT '', trucks TEXT DEFAULT '', hazmat TEXT DEFAULT '', phone TEXT DEFAULT '', cell TEXT DEFAULT '', email TEXT DEFAULT '', dot TEXT DEFAULT '', mc TEXT DEFAULT '', rating TEXT DEFAULT '', status TEXT DEFAULT 'active', pay_type TEXT DEFAULT 'fixed', pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0);
	CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, make TEXT DEFAULT '', model TEXT DEFAULT '', year TEXT DEFAULT '', vin TEXT DEFAULT '', license_plate TEXT DEFAULT '', status TEXT DEFAULT 'Active', assigned_driver TEXT DEFAULT '', owner_id INTEGER DEFAULT 0, notes TEXT DEFAULT '', created_at TEXT DEFAULT '2026-06-01 00:00:00', in_service_date TEXT DEFAULT '', retired_at TEXT DEFAULT '', photo TEXT DEFAULT '', insurance_monthly REAL DEFAULT 0, eld_monthly REAL DEFAULT 0, truck_payment_monthly REAL DEFAULT 0, hvut_annual REAL DEFAULT 0, irp_annual REAL DEFAULT 0, admin_fee_pct REAL, driver_pay_daily REAL DEFAULT 0, purchase_price REAL DEFAULT 0, title_status TEXT DEFAULT 'Clean', title_state TEXT DEFAULT '', maintenance_fund_monthly REAL DEFAULT 0, fuel_tank_gallons REAL DEFAULT 0, avg_mpg REAL DEFAULT 0, routemate_vehicle_id TEXT DEFAULT '');
	CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT DEFAULT '', start_date TEXT DEFAULT '', end_date TEXT DEFAULT '');
	CREATE TABLE carrier_driver_history (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, carrier_name TEXT, started_at TEXT DEFAULT '', ended_at TEXT DEFAULT '');
	CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT NOT NULL DEFAULT '', load_id TEXT DEFAULT '', type TEXT, amount REAL, description TEXT DEFAULT '', date TEXT DEFAULT '', gallons REAL DEFAULT 0, odometer REAL DEFAULT 0, odometer_source TEXT DEFAULT '', gallons_source TEXT DEFAULT '', status TEXT DEFAULT '', owner_id INTEGER DEFAULT 0, truck_unit TEXT DEFAULT '', posted_period TEXT DEFAULT '', created_at TEXT DEFAULT '2026-09-01 00:00:00', location_city TEXT DEFAULT '', location_state TEXT DEFAULT '', vendor TEXT DEFAULT '', location_lat REAL, location_lng REAL, receipt_details TEXT DEFAULT '');
	CREATE TABLE excluded_driver_days (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, excluded_date TEXT, reason TEXT DEFAULT '', excluded_by TEXT DEFAULT '', excluded_at TEXT DEFAULT '2026-09-01 00:00:00', action TEXT DEFAULT 'remove');
	CREATE TABLE maintenance_fund (id INTEGER PRIMARY KEY AUTOINCREMENT, truck TEXT, amount REAL, date TEXT DEFAULT '', created_at TEXT DEFAULT '2026-09-01 00:00:00', type TEXT DEFAULT 'service');
	CREATE TABLE compliance_fees (id INTEGER PRIMARY KEY AUTOINCREMENT, truck TEXT, amount REAL, paid_date TEXT DEFAULT '', due_date TEXT DEFAULT '', created_at TEXT DEFAULT '2026-09-01 00:00:00', status TEXT DEFAULT 'Paid');
	CREATE TABLE load_coordinates (load_id TEXT PRIMARY KEY, origin_lat REAL, origin_lng REAL, dest_lat REAL, dest_lng REAL, distance_miles REAL);
	CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT NOT NULL, week_start TEXT, week_end TEXT, total_earnings REAL DEFAULT 0, adjustment REAL DEFAULT 0, status TEXT DEFAULT 'Draft', deleted_at TEXT DEFAULT '');
	CREATE TABLE load_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT, driver_name TEXT, response TEXT, responded_at TEXT);
	CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, type TEXT, metadata TEXT, created_at TEXT);
	CREATE TABLE load_ratings (load_id TEXT PRIMARY KEY, driver_name TEXT, rating INTEGER, rated_by INTEGER, updated_at TEXT);
	CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT, latitude REAL, longitude REAL, speed REAL, bearing TEXT, fuel_pct REAL, location_date_ms INTEGER, dropped_reason TEXT DEFAULT '', odometer REAL DEFAULT 0);
`;

// NAMED keeps a named row as it is, BLANK blanks its driver name, NONE drops it.
// Stored rows carry a fixed id, so dropping one moves no other row's id.
const NAMED = "NAMED", BLANK = "BLANK", NONE = "NONE";
function variantOf(variant, named, row, field) {
	if (!named || variant === NAMED) return row;
	if (variant === NONE) return null;
	return { ...row, [field]: "" };
}
const withIds = (rows, first) => rows.map((r, i) => ({ id: first + i, ...r }));
const variantRows = (variant, normal, namedRows, field) =>
	[...normal, ...namedRows.map((r) => variantOf(variant, true, r, field)).filter(Boolean)];

// `unit` names each truck: as stored, or (§3b) its ordinary twin number.
function seed(db, variant, unit = (x) => x) {
	const u = db.prepare("INSERT INTO users (id, username, role, company_name) VALUES (?, ?, ?, ?)");
	u.run(1, "super_admin", "Super Admin", "");
	u.run(5, "inv5", "Investor", "Acme Carrier");
	u.run(6, "dispatch1", "Dispatcher", "");
	db.prepare("INSERT INTO investors (user_id, full_name, carrier_name) VALUES (5, 'Ivy Investor', 'Acme Carrier')").run();
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	const d = db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_percentage, pay_daily) VALUES (?, ?, ?, ?, ?)");
	d.run("Pat Percent", "Acme Carrier", "percentage", 20, 0);
	d.run("Dee  Dayrate", "Acme Carrier", "fixed", 0, 300);
	d.run("Sam Kelly", "", "fixed", 0, 0);
	// A directory row named like a built-in property: it is not a driver-name
	// SOURCE of any total, so BLANK keeps it; the lookups beside it must still
	// find nothing for the rows that carry the name.
	if (variant !== NONE) d.run("Constructor", "Acme Carrier", "fixed", 0, 999);
	const t = db.prepare("INSERT INTO trucks (id, unit_number, assigned_driver, owner_id, driver_pay_daily, insurance_monthly, eld_monthly, purchase_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	t.run(1, "101", "Pat Percent", 5, 0, 1000, 50, 90000);
	t.run(2, "102", "Dee Dayrate", 5, 275, 900, 50, 80000);
	t.run(3, "103", "Sam Kelly", 0, 260, 800, 0, 70000);
	t.run(4, "104", "", 5, 0, 700, 0, 60000);
	// The trucks whose units read as built-in names (BUILTIN_UNITS), in every
	// variant: the investor's, with no driver. "constructor" carries a
	// maintenance row and no compliance row, "__proto__" the other way round,
	// so each unit-keyed map is read both for a unit it holds and for one it
	// does not; "valueOf" is inactive, so it is given no share of the take-home.
	const tb = db.prepare("INSERT INTO trucks (id, unit_number, assigned_driver, owner_id, status, insurance_monthly, eld_monthly, purchase_price) VALUES (?, ?, '', 5, ?, ?, ?, ?)");
	tb.run(5, unit("constructor"), "Active", 650, 25, 55000);
	tb.run(6, unit("__proto__"), "Active", 600, 25, 50000);
	tb.run(7, unit("valueOf"), "Inactive", 550, 0, 45000);
	const mf = db.prepare("INSERT INTO maintenance_fund (truck, amount, date, type) VALUES (?, ?, ?, 'service')");
	mf.run("101", 120, "2026-08-10");
	mf.run(unit("constructor"), 80, "2026-08-11");
	const cf = db.prepare("INSERT INTO compliance_fees (truck, amount, paid_date, status) VALUES (?, ?, ?, 'Paid')");
	cf.run("102", 50, "2026-08-12");
	cf.run(unit("__proto__"), 40, "2026-08-13");
	const a = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, '2026-06-01T12:00:00.000Z', '')");
	a.run(1, "Pat Percent");
	a.run(2, "Dee Dayrate");
	a.run(3, "Sam Kelly");
	const e = db.prepare(`INSERT INTO expenses (id, driver, type, amount, date, status, owner_id, truck_unit, gallons, odometer)
		VALUES (@id, @driver, @type, @amount, @date, @status, @owner_id, @truck_unit, @gallons, @odometer)`);
	for (const x of variantRows(variant, withIds(NORMAL_EXPENSES, 100), withIds(NAMED_EXPENSES, 200), "driver")) {
		const r = { status: "", truck_unit: "", gallons: 0, odometer: 0, ...x };
		e.run({ ...r, truck_unit: unit(r.truck_unit) });
	}
	const inv = db.prepare(`INSERT INTO invoices (id, driver, week_start, week_end, total_earnings, adjustment, status)
		VALUES (@id, @driver, @week_start, @week_end, @total_earnings, @adjustment, @status)`);
	for (const x of variantRows(variant, withIds(NORMAL_INVOICES, 100), withIds(NAMED_INVOICES, 200), "driver")) inv.run(x);
	const o = db.prepare("INSERT INTO excluded_driver_days (id, driver_name, excluded_date, reason, excluded_by, action) VALUES (?, ?, ?, 'test', 'super_admin', ?)");
	for (const x of withIds(OVERRIDES, 1)) {
		const r = variantOf(variant, x.named, x, "driver_name");
		if (r) o.run(r.id, r.driver_name, r.excluded_date, r.action);
	}
	const rt = db.prepare("INSERT INTO load_ratings (load_id, driver_name, rating, rated_by, updated_at) VALUES (?, ?, ?, 1, '2026-09-01 00:00:00')");
	for (const x of RATINGS) {
		const r = variantOf(variant, x.named, x, "driver_name");
		if (r) rt.run(r.load_id, r.driver_name, r.rating);
	}
	const lr = db.prepare("INSERT INTO load_responses (load_id, driver_name, response, responded_at) VALUES (?, ?, 'accepted', ?)");
	lr.run("2002", "sam kelly", "2026-09-26T10:00:00.000Z");
	const namedResponse = variantOf(variant, true, { driver_name: "constructor" }, "driver_name");
	if (namedResponse) lr.run("3005", namedResponse.driver_name, "2026-09-26T11:00:00.000Z");
	db.prepare("INSERT INTO notifications (driver_name, type, metadata, created_at) VALUES ('Dee Dayrate', 'load-assigned', '{\"loadId\":\"2001\"}', '2026-09-26 09:00:00')").run();
	const lc = db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng, distance_miles) VALUES (?, 29.76, -95.37, 32.78, -96.8, ?)");
	lc.run("1001", 240);
	lc.run("1003", 250);
	lc.run("1007", 50);
	lc.run("3001", 100);
	lc.run("2003", 239);
}

// ───────────────────────────────────────────────────────────────── the world
// The built-in objects, and every function Object.prototype holds: their own
// property names must be the same after every call as before the first.
const WATCHED = [["Object.prototype", Object.prototype], ["Object", Object], ["Function.prototype", Function.prototype],
	...Object.getOwnPropertyNames(Object.prototype)
		.map((n) => [`Object.prototype.${n}`, Object.getOwnPropertyDescriptor(Object.prototype, n).value])
		.filter(([, v]) => typeof v === "function")];
const namesOf = (o) => Reflect.ownKeys(o).map(String).sort();
const BUILTINS_AT_START = WATCHED.map(([label, o]) => [label, o, namesOf(o)]);
// What changed since the start, put back as it was so one failure cannot leak
// into the next assertion.
function builtinsChangedAndRestored() {
	const changed = [];
	for (const [label, o, names] of BUILTINS_AT_START) {
		const now = namesOf(o);
		const added = now.filter((n) => !names.includes(n));
		for (const n of added) { changed.push(`${label}.${n}`); delete o[n]; }
		for (const n of names) if (!now.includes(n)) changed.push(`${label} lost ${n}`);
	}
	return changed;
}

// `twins`: every truck in BUILTIN_UNITS carries its ordinary twin number
// instead, in the trucks table, the sheet's Truck cells, the receipts and the
// maintenance and compliance rows alike (§3b). `rows` is the one sheet every
// reader sees, so a check may append to w.rows.
function buildWorld(variant, { src = SHIPPED, twins = false } = {}) {
	const unit = (x) => (twins && TWIN_UNIT.has(x) ? TWIN_UNIT.get(x) : x);
	const db = new Database(":memory:");
	db.exec(DDL);
	seed(db, variant, unit);
	const rows = variantRows(variant, NORMAL_ROWS, NAMED_ROWS, "Driver").map((r) => ({ ...r, Truck: unit(r.Truck) }));
	const routes = {};
	const app = {};
	for (const verb of ["get", "post", "put", "patch", "delete"]) {
		app[verb] = (p, ...handlers) => { routes[`${verb.toUpperCase()} ${p}`] = handlers[handlers.length - 1]; };
	}
	const errors = [];
	const passthrough = (req, res, next) => (next ? next() : undefined);
	const deps = {
		db, app, geolib, fuelModel, normalizeLoadId, Date: FixedDate,
		requireRole: () => passthrough, requireAuth: passthrough, fuelAnalyticsLimiter: passthrough,
		getJobTrackingCached: async () => ({ headers: [...HEADERS], data: rows.map((r, i) => ({ _rowIndex: i + 2, ...r })) }),
		getDeletedLoadIds: () => new Set(),
		getEldTravelDaysByVehicleCached: () => Object.create(null),
		resolveCityState: (row, kind, loadId) => `${kind}:${loadId}`,
		resolveAddressParts: (row, kind, loadId) => ({ cityStateZip: `${kind}:${loadId}`, street: "" }),
		logAudit: () => {},
		getSheets: async () => ({ spreadsheets: { values: { get: async ({ range }) => ({ data: { values:
			/!1:1$/.test(range) ? [[...HEADERS]] : [[...HEADERS], ...rows.map((r) => HEADERS.map((h) => r[h] || ""))] } }) } } }),
		SPREADSHEET_ID: "test-sheet",
		getRoute: async () => null,
		duplicateReceiptGroups: () => ({ groups: [], summary: { groups: 0 } }),
		fuelReconciliationSnapshot: () => null,
		fuelTankCalibrationWire: () => null,
		// GET /api/investor answers reportRangeMode from it (not a figure).
		investorReportOptions,
		console: { log: () => {}, warn: () => {}, error: (...a) => errors.push(a.map(String).join(" ")) },
	};
	const fns = new Function(...Object.keys(deps), liftedFor(src))(...Object.values(deps));
	return { ...fns, db, routes, errors, rows };
}

const SUPER = { id: 1, role: "Super Admin", username: "super_admin", driverName: "" };
const INVESTOR = { id: 5, role: "Investor", username: "inv5", driverName: "" };

// A route's answer as the browser receives it, whether anything threw or was
// logged, and what it changed in the built-ins.
async function call(w, route, { user = SUPER, query = {}, params = {}, body = {} } = {}) {
	const res = {
		statusCode: 200, body: undefined,
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
	};
	const errorsBefore = w.errors.length;
	let threw = null;
	try { await w.routes[route]({ session: { user }, query, params, body, headers: {} }, res); } catch (err) { threw = err.message; }
	return {
		status: res.statusCode,
		body: res.body === undefined ? undefined : JSON.parse(JSON.stringify(res.body)),
		threw, logged: w.errors.slice(errorsBefore), builtins: builtinsChangedAndRestored(),
	};
}
async function runFn(w, fn) {
	const errorsBefore = w.errors.length;
	let value, threw = null;
	try { value = await fn(); } catch (err) { threw = err.message; }
	return {
		status: threw ? 500 : 200, body: value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
		threw, logged: w.errors.slice(errorsBefore), builtins: builtinsChangedAndRestored(),
	};
}

// Every key, at any depth, that reads as a built-in property name, except the
// keys of a map whose path is in `unitKeyed` ("$.production.perTruckData"):
// that map is keyed by unit number and lists every truck, the trucks so named
// included (§3b checks their entries). What such a map holds is still searched.
function builtInKeys(value, unitKeyed = [], at = "$", out = []) {
	if (Array.isArray(value)) value.forEach((v, i) => builtInKeys(v, unitKeyed, `${at}[${i}]`, out));
	else if (value && typeof value === "object") {
		for (const k of Object.keys(value)) {
			if (readsAsBuiltIn(k) && !unitKeyed.includes(at)) out.push(`${at}.${k}`);
			builtInKeys(value[k], unitKeyed, `${at}.${k}`, out);
		}
	}
	return out;
}
// Key-order-free JSON.
function canon(v) {
	if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
	if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
	return JSON.stringify(v);
}
// Blanks the fields that echo a stored driver name as written — a value, never a key.
function blankEchoes(list, field) {
	for (const x of list || []) if (x && readsAsBuiltIn(x[field])) x[field] = "";
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ───────────────────────────────────────────────────────────────── runner
let pass = 0;
const failures = [];
function report(checks) {
	for (const [label, actual, expected] of checks) {
		const a = JSON.stringify(actual), e = JSON.stringify(expected);
		if (a === e) { pass++; console.log(`ok    ${label}`); }
		else {
			failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
			console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
		}
	}
}
const failedLabels = (checks) => checks.filter(([, a, e]) => JSON.stringify(a) !== JSON.stringify(e)).map(([l]) => l);
function section(t) { console.log(`\n${t}`); }

// ═════════════════════════════════════════════════════ §1 predicate and helper
function battery1(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const w = buildWorld(NONE, { src });
	const matches = ["__proto__", " Constructor ", "constructor", "toString", "TOSTRING", "tostring", "hasOwnProperty",
		"valueOf", "  __Proto__  ", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__defineGetter__",
		"__lookupSetter__", "VALUEOF", "CONSTRUCTOR "];
	const near = ["", "   ", null, undefined, "Pat Percent", "proto", "__proto", "constructors", "to string",
		"toString()", "prototype", "Constructor Smith", "hasOwn"];
	t("§1 isBuiltInPropertyName() is true for every name that reads as a built-in property name, in any case or spacing",
		matches.filter((n) => !w.isBuiltInPropertyName(n)), []);
	t("§1 …and false for a blank name and for names that only look close",
		near.filter((n) => w.isBuiltInPropertyName(n)), []);
	t("§1 …and the shipped predicate agrees with an oracle over every built-in name, as written and upper-cased",
		Object.getOwnPropertyNames(Object.prototype).flatMap((n) => [n, n.toUpperCase(), ` ${n} `])
			.filter((n) => w.isBuiltInPropertyName(n) !== readsAsBuiltIn(n)), []);
	{
		// The lowercased names are built on the first call and kept on the
		// function itself, so a later call reuses them and a lifted copy needs
		// only normalizeDriverName() beside it.
		const f = w.isBuiltInPropertyName;
		f("constructor");
		const first = f.names;
		f("Pat Percent");
		t("§1 isBuiltInPropertyName() keeps every built-in name, lowercased, on itself, built once",
			[first instanceof Set, first === f.names, first instanceof Set ? [...first].sort() : null], [true, true, [...BUILTIN_NAMES].sort()]);
	}
	t("§1 driverNameForTotals() reads such a name as blank",
		matches.map((n) => w.driverNameForTotals(n)), matches.map(() => ""));
	t("§1 …and returns every other value unchanged, a non-string included",
		["Pat Percent", " Dee  Dayrate ", "", "   ", "proto", null, undefined, 5].map((n) => w.driverNameForTotals(n)),
		["Pat Percent", " Dee  Dayrate ", "", "   ", "proto", null, undefined, 5]);
	t("§1 expenseDriverKey(): such a name keys as '' — a blank name's key — and every other name as before",
		["__proto__", " CONSTRUCTOR ", "tostring", "pat  percent", "Pat Percent", "", "   ", null].map((n) => w.expenseDriverKey(n)),
		["", "", "", "pat percent", "pat percent", "", "   ", "null"]);
	return out;
}

// ═════════════════════════════════════════════════════ §2 the shared helpers
function battery2(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const named = buildWorld(NAMED, { src });
	const blank = buildWorld(BLANK, { src });
	const none = buildWorld(NONE, { src });
	const probes = ["__proto__", "constructor", "tostring", "hasownproperty", "valueof", "isprototypeof"];
	const found = (map, keys = probes) => keys.filter((k) => map[k] !== undefined);
	const isNullProto = (o) => o !== null && typeof o === "object" && Object.getPrototypeOf(o) === null;

	{
		const pay = none.getDriverPayStructures();
		t("§2 getDriverPayStructures() is a null-prototype object", isNullProto(pay), true);
		t("§2 …a lookup by a built-in name finds nothing", found(pay), []);
		t("§2 …and every normal driver's structure is there", canon(Object.keys(pay).sort()), canon(["dee dayrate", "pat percent", "sam kelly"]));
		const withRow = named.getDriverPayStructures();
		t("§2 with a directory row so named, the other built-in names still find nothing",
			found(withRow, probes.filter((k) => k !== "constructor")), []);
		t("§2 …and every normal driver's structure is unchanged", canon(["pat percent", "dee dayrate", "sam kelly"].map((k) => withRow[k])),
			canon(["pat percent", "dee dayrate", "sam kelly"].map((k) => pay[k])));
	}
	{
		const r = runFnSync(() => named.getAllExcludedDriverDays());
		const days = r.value || {};
		t("§2 getAllExcludedDriverDays() does not throw beside such override rows", r.threw, null);
		t("§2 …is a null-prototype object", isNullProto(days), true);
		t("§2 …holds only the normal drivers — such a row is skipped like a blank one", Object.keys(days).sort(), ["dee dayrate", "sam kelly"]);
		t("§2 …and the override row AFTER them still applies", days["sam kelly"] ? [...days["sam kelly"].add] : null, ["2026-08-25"]);
		t("§2 …the one before them too", days["dee dayrate"] ? [...days["dee dayrate"].remove] : null, ["2026-08-12"]);
		t("§2 …a lookup by a built-in name finds nothing", found(days), []);
		t("§2 …and the answer is the one BLANK gives", canon(serializeDays(days)), canon(serializeDays(blank.getAllExcludedDriverDays())));
		t("§2 …and the one NONE gives", canon(serializeDays(days)), canon(serializeDays(none.getAllExcludedDriverDays())));
		t("§2 …with no override rows at all it is still null-prototype", isNullProto(buildEmpty(src).getAllExcludedDriverDays()), true);
	}
	{
		const ded = named.getDeductibleExpensesByDriverMonth();
		t("§2 getDeductibleExpensesByDriverMonth() is a null-prototype object", isNullProto(ded), true);
		t("§2 …with no key that reads as a built-in name", Object.keys(ded).filter(readsAsBuiltIn), []);
		t("§2 …a lookup by a built-in name finds nothing", found(ded), []);
		t("§2 …the answer is the one BLANK gives (such receipts count under '')", canon(ded), canon(blank.getDeductibleExpensesByDriverMonth()));
		const n = none.getDeductibleExpensesByDriverMonth();
		t("§2 …and every normal driver's deduction is NONE's", canon(["pat percent", "dee dayrate"].map((k) => ded[k])),
			canon(["pat percent", "dee dayrate"].map((k) => n[k])));
	}
	{
		const rows = [{ d: "__proto__", t: 5 }, { d: "constructor", t: 6 }, { d: "", t: 1 }, { d: "pat percent", t: 2 },
			{ d: "pat  percent", t: 3 }, { d: "tostring", t: 4 }];
		const fold = named.foldExpenseTotalsByDriver(rows);
		t("§2 foldExpenseTotalsByDriver() is a null-prototype object", isNullProto(fold), true);
		t("§2 …such names sum into '' with the blank one; spellings still fold", canon(fold), canon({ "": 16, "pat percent": 5 }));
		t("§2 …a lookup by a built-in name finds nothing", found(fold), []);
	}
	{
		const q = (w) => runFnSync(() => w.computeDriverQueues(w.rows.map((r) => ({ ...r })), [...HEADERS]));
		const r = q(named);
		t("§2 computeDriverQueues() does not throw beside such Driver cells", r.threw, null);
		t("§2 …is a null-prototype object", isNullProto(r.value), true);
		t("§2 …queues only the normal drivers", Object.keys(r.value || {}).sort(), ["dee dayrate", "sam kelly"]);
		t("§2 …a lookup by a built-in name finds nothing", found(r.value || {}), []);
		t("§2 …the answer is the one BLANK gives", canon(r.value), canon(q(blank).value));
		t("§2 …and the one NONE gives", canon(r.value), canon(q(none).value));
		for (const [label, rows, headers] of [["no rows", [], [...HEADERS]], ["no Driver column", named.rows, ["Load ID"]],
			["no queued row", [NORMAL_ROWS[0]], [...HEADERS]]]) {
			const empty = named.computeDriverQueues(rows, headers);
			t(`§2 …its empty answer (${label}) is null-prototype too, so a lookup by a built-in name finds nothing`,
				[isNullProto(empty), found(empty)], [true, []]);
		}
	}
	t("§2 the built-in objects are unchanged", builtinsChangedAndRestored(), []);
	return out;
}
function runFnSync(fn) {
	try { return { value: fn(), threw: null }; } catch (err) { return { value: undefined, threw: err.message }; }
}
const serializeDays = (days) => Object.fromEntries(Object.entries(days).map(([k, v]) => [k, { remove: [...v.remove].sort(), add: [...v.add].sort() }]));
function buildEmpty(src) {
	const w = buildWorld(NONE, { src });
	w.db.exec("DELETE FROM excluded_driver_days");
	return w;
}

// ═════════════════════════════════════════════════════ §3 the totals
// Each surface: how to run it, which fields echo a stored name, and which
// figures are the normal drivers' own.
const SURFACES = [
	{
		name: "computeInvestorMonthlyEarnings() for the investor (the payouts and statement figures)",
		run: (w) => runFn(w, () => {
			const carrier = w.getCarrierDBFromSQLite();
			return w.computeInvestorMonthlyEarnings({
				user: { ...INVESTOR }, isSuperAdmin: false, investorOwnerId: 5, config: { investor_split_pct: "50" },
				investorDriverSet: w.getInvestorDriverSet(5, carrier.data, "Driver", "Carrier Name"), detailForMonth: "2026-08",
			});
		}),
		echoes: (b) => blankEchoes(b.detail && b.detail.tripExpenseItems, "driver"),
		own: (b) => [b.detail.driverPayRows, b.monthlyEarnings.map((m) => [m.month, m.exact.driverPay])],
	},
	{
		name: "computeInvestorMonthlyEarnings() fleet-wide",
		run: (w) => runFn(w, () => w.computeInvestorMonthlyEarnings({
			user: { ...SUPER }, isSuperAdmin: true, investorOwnerId: null, config: { investor_split_pct: "50" },
			investorDriverSet: null, detailForMonth: "2026-07",
		})),
		echoes: (b) => blankEchoes(b.detail && b.detail.tripExpenseItems, "driver"),
		own: (b) => [b.detail.driverPayRows, b.monthlyEarnings.map((m) => [m.month, m.exact.driverPay])],
	},
	{
		name: "GET /api/investor as the investor",
		run: (w) => call(w, "GET /api/investor", { user: INVESTOR }),
		echoes: (b) => { blankEchoes(b.myLoads && b.myLoads.pending, "driver"); blankEchoes(b.myLoads && b.myLoads.active, "driver"); },
		own: (b) => [b.production.driverPayDetails, b.production.totalDriverPay,
			b.production.monthlyEarnings.map((m) => [m.month, m.driverPay, m.driverDetails])],
		unitKeyed: ["$.production.perTruckData"],
	},
	{
		name: "GET /api/investor fleet-wide",
		run: (w) => call(w, "GET /api/investor", { user: SUPER }),
		echoes: (b) => { blankEchoes(b.myLoads && b.myLoads.pending, "driver"); blankEchoes(b.myLoads && b.myLoads.active, "driver"); },
		own: (b) => [b.production.driverPayDetails, b.production.totalDriverPay,
			b.production.monthlyEarnings.map((m) => [m.month, m.driverPay, m.driverDetails])],
		unitKeyed: ["$.production.perTruckData"],
	},
	{
		// The trucks named like built-ins earn from the named rows' Truck cells,
		// which NONE drops, so their rows are §3b's to judge, not this one's.
		name: "GET /api/financials with the 2026-08 drill-down",
		run: (w) => call(w, "GET /api/financials", { query: { month: "2026-08" } }),
		echoes: () => {},
		own: (b) => [b.drivers.filter((d) => !d.isUnassigned), b.expensesByCategory.driver_pay,
			b.perTruck.filter((x) => !readsAsBuiltIn(x.unitNumber)),
			b.monthlyPerformance.map((m) => [m.month, m.driverPay]), b.monthDetail.drivers,
			b.monthDetail.trucks.filter((x) => !readsAsBuiltIn(x.unitNumber))],
	},
	{
		name: "GET /api/expenses/fuel-analytics",
		run: (w) => call(w, "GET /api/expenses/fuel-analytics"),
		echoes: (b) => blankEchoes(b.recentFills, "driver"),
		own: (b) => Object.fromEntries(Object.entries(b.byDriver).filter(([k]) => k !== "")),
	},
	{
		name: "GET /api/dashboard",
		run: (w) => call(w, "GET /api/dashboard"),
		echoes: (b) => {
			delete b.timestamp;
			for (const k of ["unassignedJobs", "activeJobs", "completedJobs"]) blankEchoes(b[k], "Driver");
		},
		own: (b) => [b.driverQueues, b.fleet.filter((f) => !readsAsBuiltIn(f.Driver))],
	},
	{
		name: "GET /api/locations/latest",
		run: (w) => call(w, "GET /api/locations/latest"),
		echoes: () => {},
		own: (b) => b.locations.filter((l) => !readsAsBuiltIn(l.driver)),
	},
	{
		name: "GET /api/trucks",
		run: (w) => call(w, "GET /api/trucks"),
		echoes: () => {},
		own: (b) => b.trucks.filter((x) => !readsAsBuiltIn(x.UnitNumber)),
	},
];

async function battery3(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const worlds = { [NAMED]: buildWorld(NAMED, { src }), [BLANK]: buildWorld(BLANK, { src }), [NONE]: buildWorld(NONE, { src }) };
	for (const s of SURFACES) {
		const r = {};
		for (const v of [NAMED, BLANK, NONE]) r[v] = await s.run(worlds[v]);
		const n = r[NAMED];
		t(`§3 ${s.name}: answers 200 with nothing thrown or logged`, [n.status, n.threw, n.logged], [200, null, []]);
		t(`§3 ${s.name}: the built-in objects are unchanged`, n.builtins, []);
		t(`§3 ${s.name}: no key at any depth reads as a built-in name`, builtInKeys(n.body, s.unitKeyed), []);
		let same = false, own = false;
		try {
			const nb = clone(n.body), bb = clone(r[BLANK].body);
			s.echoes(nb); s.echoes(bb);
			same = canon(nb) === canon(bb);
			own = canon(s.own(n.body)) === canon(s.own(r[NONE].body));
		} catch (err) { same = `threw: ${err.message}`; }
		t(`§3 ${s.name}: the answer is exactly the one given with those names blank`, same, true);
		t(`§3 ${s.name}: every normal driver's figures are exactly the ones given without those rows`, own, true);
	}
	{
		// The ratings leave such a name out rather than folding it into ''.
		const r = {};
		for (const v of [NAMED, NONE]) r[v] = await call(worlds[v], "GET /api/load-ratings/averages");
		t("§3 GET /api/load-ratings/averages: answers 200, built-ins unchanged", [r[NAMED].status, r[NAMED].threw, r[NAMED].builtins], [200, null, []]);
		t("§3 GET /api/load-ratings/averages: no key reads as a built-in name", builtInKeys(r[NAMED].body), []);
		t("§3 GET /api/load-ratings/averages: every normal driver's average is exactly the one given without those rows",
			canon(r[NAMED].body), canon(r[NONE].body));
	}
	{
		// The totals the unassigned rows move, stated outright, so an agreement
		// between two wrong answers cannot pass. A read off a failed answer is a
		// failed assertion, never a crash of the run.
		const read = (fn) => { try { return fn(); } catch (err) { return `unreadable: ${err.message}`; } };
		const body = async (v, route, opts) => (await call(worlds[v], route, opts)).body || {};
		const fin = await body(NAMED, "GET /api/financials", { query: { month: "2026-08" } });
		const finNone = await body(NONE, "GET /api/financials", { query: { month: "2026-08" } });
		t("§3 GET /api/financials: the named rows' revenue is unassigned — $700 blank + $500 + $450 + $300",
			read(() => [fin.summary.unassignedRevenue, fin.summary.unassignedLoadCount]), [1950, 4]);
		t("§3 …and fleet revenue is NONE's plus exactly that $1,250",
			read(() => fin.summary.totalRevenue - finNone.summary.totalRevenue), 1250);
		t("§3 …while driver pay does not move",
			read(() => fin.expensesByCategory.driver_pay === finNone.expensesByCategory.driver_pay), true);
		const inv = await body(NAMED, "GET /api/investor", { user: INVESTOR });
		const invNone = await body(NONE, "GET /api/investor", { user: INVESTOR });
		t("§3 GET /api/investor as the investor: its Owner ID rows count ($500 + $300), the driver-fallback one does not",
			read(() => inv.production.totalRevenue - invNone.production.totalRevenue), 800);
		t("§3 Pat Percent's deduction is her receipts alone: $100 in July, $50 + $110 in August",
			read(() => canon(worlds[NAMED].getDeductibleExpensesByDriverMonth()["pat percent"])),
			canon({ _total: 260, "2026-07": 100, "2026-08": 160 }));
		const fuel = await body(NAMED, "GET /api/expenses/fuel-analytics");
		t("§3 GET /api/expenses/fuel-analytics: such names, in any case or spacing, are filed under '' with the blank receipt",
			read(() => canon(fuel.byDriver[""])),
			canon({ spend: 30 + 60 + 25 + 10 + 12 + 14 + 40 + 45, gallons: 8 + 15 + 5 + 2 + 3 + 4 + 10 + 11 }));
		const dash = await body(NAMED, "GET /api/dashboard");
		t("§3 GET /api/dashboard: a directory driver so named has no queue and no completed loads of its own",
			read(() => { const c = dash.fleet.find((f) => f.Driver === "Constructor"); return [c.Status, c.QueueCount, c.QueuedLoadIds, c.CompletedLoads]; }),
			["Available", 0, [], 0]);
		const loc = await body(NAMED, "GET /api/locations/latest");
		t("§3 GET /api/locations/latest: a normal driver's working load is on the panel",
			read(() => loc.locations.find((l) => l.driver === "Pat Percent").activeLoads.map((x) => x.loadId)), ["2003"]);
	}
	return out;
}

// ═════════════════════════════════════════════════════ §3b unit numbers and load ids
// What a per-truck entry holds, by kind. `projection` is null exactly while the
// truck is in service too briefly to project (insufficientData), a number
// otherwise; `numberOrNull` is null when the truck earns nothing a month.
const INVESTOR_TRUCK_FIELDS = {
	number: ["unitMonthlyGross", "unitMonthlyExpenses", "unitMonthlyTripExpenses", "estAnnualRevenue", "totalMiles", "loadCount",
		"windowRevenue", "windowRevenueShare"],
	string: ["status", "attributionMode"], boolean: ["insufficientData"],
	projection: ["monthlyInvestorEarnings", "estAnnualInvestorRevenue", "investorROI"], numberOrNull: ["breakEvenMonths"],
};
const FINANCIALS_TRUCK_FIELDS = {
	number: ["loadCount", "gross", "expenses", "net", "totalMiles", "ratePerMile", "monthlyCost", "operatingMonths", "driverPayPercentage"],
	string: ["unitNumber", "assignedDriver", "driverPayType", "attributionMode"], boolean: ["driverPayUsedDefault", "idle"],
	projection: [], numberOrNull: [],
};
// The fields of an entry that are missing or of the wrong kind: [] when it is
// well-formed.
function malformed(entry, spec) {
	if (entry === null || typeof entry !== "object") return ["(no entry)"];
	const bad = [];
	for (const k of spec.number) if (!Number.isFinite(entry[k])) bad.push(k);
	for (const k of spec.string) if (typeof entry[k] !== "string") bad.push(k);
	for (const k of spec.boolean) if (typeof entry[k] !== "boolean") bad.push(k);
	for (const k of spec.projection) if (!(entry.insufficientData === true ? entry[k] === null : Number.isFinite(entry[k]))) bad.push(k);
	for (const k of spec.numberOrNull) if (!(entry[k] === null || Number.isFinite(entry[k]))) bad.push(k);
	return bad;
}
const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
// The entry an array lists for `unit` under `field`, with the unit written as
// `as`, so a truck and its twin compare field for field; null when not listed.
function entryFor(list, field, unit, as = unit) {
	const hit = (list || []).find((x) => x && x[field] === unit);
	return hit ? { ...hit, [field]: as } : null;
}
const ORDINARY_UNITS = ["101", "102", "103", "104"];

async function battery3b(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const read = (fn) => { try { return fn(); } catch (err) { return `unreadable: ${err.message}`; } };
	const named = buildWorld(NAMED, { src });
	const twins = buildWorld(NAMED, { src, twins: true });

	// GET /api/investor as the investor: perTruckData, keyed by unit number.
	{
		const a = await call(named, "GET /api/investor", { user: INVESTOR });
		const b = await call(twins, "GET /api/investor", { user: INVESTOR });
		t("§3b GET /api/investor as the investor: answers 200 with nothing thrown or logged, built-ins unchanged",
			[a.status, a.threw, a.logged, a.builtins], [200, null, [], []]);
		const pa = read(() => a.body.production.perTruckData);
		const pb = read(() => b.body.production.perTruckData);
		t("§3b …perTruckData lists every one of the investor's trucks, those named like built-ins included",
			read(() => Object.keys(pa).sort()), ["101", "102", "104", "__proto__", "constructor", "valueOf"]);
		for (const [unit, twin] of BUILTIN_UNITS) {
			const e = hasOwn(pa, unit) ? pa[unit] : null;
			t(`§3b …the truck "${unit}": every figure well-formed`, malformed(e, INVESTOR_TRUCK_FIELDS), []);
			t(`§3b …the truck "${unit}": exactly the figures it gets as "${twin}"`, canon(e), canon(hasOwn(pb, twin) ? pb[twin] : null));
		}
		t("§3b …the other trucks' figures are unchanged",
			canon(["101", "102", "104"].map((u) => (hasOwn(pa, u) ? pa[u] : null))), canon(["101", "102", "104"].map((u) => (hasOwn(pb, u) ? pb[u] : null))));
		t("§3b …and so is everything else in the answer (fleet totals, months, asset)",
			read(() => canon({ ...a.body, production: { ...a.body.production, perTruckData: null } })),
			read(() => canon({ ...b.body, production: { ...b.body.production, perTruckData: null } })));
		// Stated outright, so an agreement between two wrong answers cannot pass.
		const p = hasOwn(pa, "__proto__") ? pa["__proto__"] : {};
		const v = hasOwn(pa, "valueOf") ? pa["valueOf"] : {};
		t("§3b …\"__proto__\" earns its $500 load by its Truck cell and gets a share; inactive \"valueOf\" gets none",
			[p.attributionMode, p.windowRevenue, p.loadCount, p.windowRevenueShare > 0, v.windowRevenueShare, v.estAnnualInvestorRevenue],
			["truck", 500, 1, true, 0, 0]);
	}
	// GET /api/financials: the active trucks' rows, and the month's.
	{
		const a = await call(named, "GET /api/financials", { query: { month: "2026-08" } });
		const b = await call(twins, "GET /api/financials", { query: { month: "2026-08" } });
		t("§3b GET /api/financials: answers 200 with nothing thrown or logged, built-ins unchanged",
			[a.status, a.threw, a.logged, a.builtins], [200, null, [], []]);
		const listed = read(() => a.body.perTruck.map((x) => x.unitNumber).sort());
		t("§3b …perTruck lists every active truck, those named like built-ins included", listed,
			["101", "102", "103", "104", "__proto__", "constructor"]);
		for (const [unit, twin] of BUILTIN_UNITS.filter(([u]) => u !== "valueOf")) {
			const e = read(() => entryFor(a.body.perTruck, "unitNumber", unit));
			t(`§3b …the truck "${unit}": every figure well-formed`, malformed(e, FINANCIALS_TRUCK_FIELDS), []);
			t(`§3b …the truck "${unit}": exactly the row it gets as "${twin}"`,
				canon(read(() => entryFor(a.body.perTruck, "unitNumber", unit, twin))), canon(read(() => entryFor(b.body.perTruck, "unitNumber", twin))));
			t(`§3b …the truck "${unit}": the same month row as "${twin}"`,
				canon(read(() => entryFor(a.body.monthDetail.trucks, "unitNumber", unit, twin))),
				canon(read(() => entryFor(b.body.monthDetail.trucks, "unitNumber", twin))));
		}
		t("§3b …the other trucks' rows are unchanged",
			canon(read(() => ORDINARY_UNITS.map((u) => entryFor(a.body.perTruck, "unitNumber", u)))),
			canon(read(() => ORDINARY_UNITS.map((u) => entryFor(b.body.perTruck, "unitNumber", u)))));
		t("§3b …and so are the fleet summary and the expense categories",
			canon(read(() => [a.body.summary, a.body.expensesByCategory])), canon(read(() => [b.body.summary, b.body.expensesByCategory])));
		t("§3b …\"__proto__\" and \"constructor\" each earn their load by their Truck cell ($500, $450)",
			read(() => { const p = entryFor(a.body.perTruck, "unitNumber", "__proto__"); const c = entryFor(a.body.perTruck, "unitNumber", "constructor");
				return [p.attributionMode, p.gross, p.loadCount, c.attributionMode, c.gross, c.loadCount]; }),
			["truck", 500, 1, "truck", 450, 1]);
	}
	// GET /api/trucks lists all seven.
	{
		const a = await call(named, "GET /api/trucks");
		const b = await call(twins, "GET /api/trucks");
		t("§3b GET /api/trucks: answers 200, built-ins unchanged", [a.status, a.threw, a.builtins], [200, null, []]);
		for (const [unit, twin] of BUILTIN_UNITS) {
			t(`§3b …the truck "${unit}": exactly the entry it gets as "${twin}"`,
				canon(read(() => entryFor(a.body.trucks, "UnitNumber", unit, twin))), canon(read(() => entryFor(b.body.trucks, "UnitNumber", twin))));
		}
	}
	// The fuel-gallons recovery: one fill and its receipt on each of two trucks
	// named like built-ins and on an ordinary one, each on its own day. A rise of
	// 50 points is exact, so each truck's reference is gallons × 2.
	{
		const w = buildWorld(NONE, { src });
		const fills = [["constructor", "2026-09-20", 100], ["__proto__", "2026-09-21", 125], ["101", "2026-09-22", 110]];
		const ins = w.db.prepare("INSERT INTO expenses (driver, type, amount, date, owner_id, truck_unit, gallons) VALUES ('', 'Fuel', ?, ?, 5, ?, ?)");
		const receiptIds = fills.map(([u, day, gallons]) => Number(ins.run(gallons * 4, day, u, gallons).lastInsertRowid));
		const events = fills.map(([u, day], i) => ({
			id: -(i + 1), routemate_vehicle_id: `rv-${i}`, unit: u, local_day: day,
			start_ms: Date.UTC(2026, 8, 20 + i, 15), end_ms: Date.UTC(2026, 8, 20 + i, 15, 20),
			pct_before: 25, pct_after: 75, odometer: 0, odo_span: 0, latitude: 0, longitude: 0,
		}));
		const r = runFnSync(() => w.matchFuelEventsToReceipts({ days: 10, persist: false, writeReceipts: false, events }));
		const v = r.value || {};
		t("§3b matchFuelEventsToReceipts(): does not throw on fills on trucks whose units read as built-in names", r.threw, null);
		t("§3b …matches each fill to its own receipt", read(() => v.matched.map((m) => [m.e.unit, m.r.id]).sort()),
			fills.map(([u], i) => [u, receiptIds[i]]).sort());
		t("§3b …files each truck's reference gallons under its own unit, and nothing else",
			read(() => Object.entries(v.refImplied).sort()), [["101", 220], ["__proto__", 250], ["constructor", 200]]);
		t("§3b …as a null-prototype object", read(() => Object.getPrototypeOf(v.refImplied)), null);
		t("§3b …the built-in objects are unchanged", builtinsChangedAndRestored(), []);
	}
	// GET /api/admin/scan-duplicates: Load IDs that read as built-in names are
	// grouped like any other ("#constructor" is "constructor").
	{
		const w = buildWorld(NONE, { src });
		const first = w.rows.length + 2; // the sheet row of the first appended load
		w.rows.push(
			jt("constructor", "Pat Percent", "Delivered", "", "", "", "", "", ""),
			jt("#constructor", "Dee Dayrate", "Dispatched", "", "", "", "", "", ""),
			jt("__proto__", "Sam Kelly", "Delivered", "", "", "", "", "", ""),
			jt("__proto__", "", "Delivered", "", "", "", "", "", ""),
			jt("toString", "Pat Percent", "Delivered", "", "", "", "", "", ""),
		);
		const r = await call(w, "GET /api/admin/scan-duplicates");
		const row = (n, rawId, status, driver) => ({ row: first + n, rawId, status, driver, oLat: "" });
		t("§3b GET /api/admin/scan-duplicates: groups Load IDs that read as built-in names like any other",
			[r.status, r.threw, r.builtins, r.body], [200, null, [], {
				total: 2, dangerous: 1, groups: [
					{ loadId: "constructor", dangerous: true, rows: [row(0, "constructor", "Delivered", "Pat Percent"), row(1, "#constructor", "Dispatched", "Dee Dayrate")] },
					{ loadId: "__proto__", dangerous: false, rows: [row(2, "__proto__", "Delivered", "Sam Kelly"), row(3, "__proto__", "Delivered", "(no driver)")] },
				],
			}]);
	}
	return out;
}

// ═════════════════════════════════════════════════════ §3c the load-rating save
// PUT /api/load-ratings/:loadId stores the driverName it is sent: one that reads
// as a built-in property name is refused 400 DRIVER_NAME_RESERVED, one that is
// not text 400, each before the write.
async function battery3c(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const put = (w, loadId, body) => call(w, "PUT /api/load-ratings/:loadId", { params: { loadId }, body });
	const ratings = (w) => canon(w.db.prepare("SELECT load_id, driver_name, rating, rated_by FROM load_ratings ORDER BY load_id").all());
	for (const name of ["__proto__", " Constructor ", "toString", "VALUEOF"]) {
		const w = buildWorld(NONE, { src });
		const before = ratings(w);
		const r = await put(w, "1002", { rating: 4, driverName: name });
		t(`§3c PUT /api/load-ratings/:loadId, driverName ${JSON.stringify(name)}: 400 DRIVER_NAME_RESERVED naming driverName, nothing written`,
			[r.status, r.threw, r.body && r.body.code, r.body && r.body.field, ratings(w) === before, r.builtins],
			[400, null, "DRIVER_NAME_RESERVED", "driverName", true, []]);
	}
	for (const [label, name] of [["a number", 7], ["an object", { name: "Pat Percent" }], ["an array", ["Pat Percent"]], ["true", true]]) {
		const w = buildWorld(NONE, { src });
		const before = ratings(w);
		const r = await put(w, "1002", { rating: 4, driverName: name });
		t(`§3c …driverName that is ${label}: 400 "Driver name must be text", not a throw, nothing written`,
			[r.status, r.threw, r.body, ratings(w) === before], [400, null, { error: "Driver name must be text" }, true]);
	}
	{
		const w = buildWorld(NONE, { src });
		const a = await put(w, "1002", { rating: 4, driverName: "Pat Percent" });
		const b = await put(w, "1004", { rating: 3, driverName: "Tostring Smith" });
		const row = (id) => w.db.prepare("SELECT driver_name, rating FROM load_ratings WHERE load_id = ?").get(id) || null;
		t("§3c …an ordinary name is saved, and so is one that only contains a built-in name (\"Tostring Smith\")",
			[a.status, a.threw, row("1002"), b.status, b.threw, row("1004")],
			[200, null, { driver_name: "Pat Percent", rating: 4 }, 200, null, { driver_name: "Tostring Smith", rating: 3 }]);
	}
	return out;
}

// ═════════════════════════════════════════════════════ §4 source pins
// Every name-keyed map, per function or route, declared null-prototype — the
// three §3 cannot run (the ELD poll, the HOS matchers and the stale-location
// scan) included — and each of those reads its Driver cell through the rule.
// A map re-declared as a plain {} fails here by name.
const PINNED = [
	["getDriverPayStructures()", "getDriverPayStructures", ["out"]],
	["getAllExcludedDriverDays()", "getAllExcludedDriverDays", ["map"]],
	["foldExpenseTotalsByDriver()", "foldExpenseTotalsByDriver", ["out"]],
	["getDeductibleExpensesByDriverMonth()", "getDeductibleExpensesByDriverMonth", ["out"]],
	["computeDriverQueues()", "computeDriverQueues", ["byDriver"]],
	["computeInvestorMonthlyEarnings()", "computeInvestorMonthlyEarnings",
		["unitToVid", "driverDaySets", "driverMonthlyDays", "driverMonthlyRevenue", "trucksByDriver"]],
	["GET /api/investor", ROUTES.investor,
		["milesByLoadId", "grossByDriver", "milesByDriver", "milesByTruck", "loadsByDriver", "loadsByTruck", "revenueByTruckMonth",
			"driverDaySets", "driverMonthlyDays", "driverMonthlyDayLoads", "driverDisplayName", "driverMonthlyRevenue", "unitToVid",
			"driverDaySource", "driverPayDetails", "trucksByDriver",
			// keyed by unit number
			"perTruckData", "maintByTruck", "compByTruck", "windowRevenue", "modeByUnit", "insufficient", "basis", "alloc"]],
	["GET /api/financials", ROUTES.financials,
		["milesByLoadId", "grossByDriver", "grossByTruck", "milesByDriver", "milesByTruck", "loadsByDriver", "loadsByTruck",
			"driverDaySets", "truckDaySets", "truckLoadDates", "driverMonthlyRevenue", "unitToVid", "driverMonthlyDays",
			"trucksByDriver", "driverPayDetails", "driverDisplayNames", "invByDriver",
			// keyed by unit number
			"expByTruck", "maintByTruck", "compByTruck"]],
	["matchFuelEventsToReceipts()", "matchFuelEventsToReceipts", ["seed", "refImplied"]],
	["GET /api/admin/scan-duplicates", ROUTES.scanDuplicates, ["byId"]],
	["GET /api/expenses/fuel-analytics", ROUTES.fuel, ["readingsByTruck", "byDriver"]],
	["GET /api/locations/latest", ROUTES.locations,
		["routemateByDriver", "assignmentByDriver", "loadMap", "driverActiveLoadMap", "driverActiveLoadsMap"]],
	["GET /api/trucks", ROUTES.trucks, ["loadsByTruck", "loadsByDriver"]],
	["GET /api/load-ratings/averages", ROUTES.ratings, ["averages"]],
	["routemateSyncTelemetry()", "routemateSyncTelemetry", ["loadIdByDriver", "activeLoadsByDriver"]],
	["GET /api/tracking/hos", 'app.get("/api/tracking/hos", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
		["byName", "byUnit", "driverByRvid", "rvidByLabel"]],
	["GET /api/admin/scan-stale-locations", 'app.get("/api/admin/scan-stale-locations", requireRole("Super Admin"), async (req, res) => {',
		["sheetLoads", "driverActiveLoads"]],
];
function battery4(src) {
	const out = [];
	const t = (label, actual, expected) => out.push([label, actual, expected]);
	const bodyOf = (target) => (target.startsWith("app.") ? liftRoute(src, target) : liftFn(src, target));
	// Every declaration of the name counts, so a second one in another shape
	// ({}, Object.fromEntries(), …) fails as surely as the first would.
	const declarations = (body, n) => [...body.matchAll(new RegExp(`\\b(?:const|let) ${n} = ([^\\n]*)`, "g"))].map((m) => m[1]);
	for (const [label, target, names] of PINNED) {
		const body = bodyOf(target);
		t(`§4 ${label}: ${names.join(", ")} — each declared Object.create(null), at every declaration`,
			names.filter((n) => {
				const found = declarations(body, n);
				return found.length === 0 || found.some((d) => !d.startsWith("Object.create(null);"));
			}), []);
	}
	{
		const inv = liftRoute(src, ROUTES.investor);
		t("§4 GET /api/investor: whether a unit was given a share is an own-property test, never `in`",
			[/\bin alloc\b/.test(inv), inv.includes("const allocated = (u) => Object.prototype.hasOwnProperty.call(alloc, u);"),
				(inv.match(/allocated\(unit\)/g) || []).length], [false, true, 2]);
	}
	t("§4 routemateSyncTelemetry(): the Driver cell is read through driverNameForTotals()",
		/const d = driverNameForTotals\(\(row\[driverCol\] \|\| ""\)\.toString\(\)\)/.test(liftFn(src, "routemateSyncTelemetry")), true);
	t("§4 GET /api/investor: the driver-keyed map inside each month's details is null-prototype too",
		liftRoute(src, ROUTES.investor).includes("monthlyDriverDetails[mk] = Object.create(null);"), true);
	return out;
}

// ═════════════════════════════════════════════════════ §5 mutants
// Each rewrites one guard inside one lifted function or route and must flip at
// least one assertion above.
const MUTANTS = [
	["M1 a plain {} for computeDriverQueues()' per-driver map", "\nfunction computeDriverQueues(",
		"const byDriver = Object.create(null);", "const byDriver = {};"],
	["M2 the blank rule removed from driverNameForTotals()", "\nfunction driverNameForTotals(",
		'return typeof name === "string" && isBuiltInPropertyName(name) ? "" : name;', "return name;"],
	["M3 the fuel analytics per-driver map as it was before", `\n${ROUTES.fuel}`,
		"const byDriver = Object.create(null);\n\t\tfuelExpenses.forEach((e) => {\n\t\t\tconst key = driverNameForTotals(e.driver);",
		"const byDriver = {};\n\t\tfuelExpenses.forEach((e) => {\n\t\t\tconst key = e.driver;"],
	["M4 a plain {} for GET /api/investor's perTruckData", `\n${ROUTES.investor}`,
		"const perTruckData = Object.create(null);", "const perTruckData = {};"],
	["M5 a plain {} for GET /api/investor's maintenance map", `\n${ROUTES.investor}`,
		"const maintByTruck = Object.create(null);", "const maintByTruck = {};"],
	["M6 a plain {} for GET /api/investor's attribution modes", `\n${ROUTES.investor}`,
		"const modeByUnit = Object.create(null);", "const modeByUnit = {};"],
	["M7 GET /api/investor's share map a plain {} again, asked with `in`", `\n${ROUTES.investor}`,
		"const alloc = Object.create(null);\n\t\t\tconst allocated = (u) => Object.prototype.hasOwnProperty.call(alloc, u);",
		"const alloc = {};\n\t\t\tconst allocated = (u) => u in alloc;"],
	["M8 a plain {} for GET /api/financials' per-truck receipt map", `\n${ROUTES.financials}`,
		"const expByTruck = Object.create(null);", "const expByTruck = {};"],
	["M9 a plain {} for the fuel-gallons recovery's per-truck samples", "\nfunction matchFuelEventsToReceipts(",
		"const seed = Object.create(null);", "const seed = {};"],
	["M10 a plain {} for GET /api/admin/scan-duplicates' Load ID map", `\n${ROUTES.scanDuplicates}`,
		"const byId = Object.create(null);", "const byId = {};"],
	["M11 PUT /api/load-ratings/:loadId takes a driver name that reads as a built-in property name", `\n${ROUTES.ratingsPut}`,
		'const reservedDriver = reservedDriverNameRefusal(driverName, "driverName");', "const reservedDriver = null;"],
	["M12 PUT /api/load-ratings/:loadId without its text check", `\n${ROUTES.ratingsPut}`,
		'if (typeof driverName !== "string") return res.status(400).json({ error: "Driver name must be text" });', ""],
];
function mutateWithin(anchor, find, replace, label) {
	if (SHIPPED.split(anchor).length - 1 !== 1) throw new Error(`mutant "${label}": its anchor is not found exactly once`);
	const start = SHIPPED.indexOf(anchor);
	const end = SHIPPED.indexOf(anchor.startsWith("\napp.") ? "\n});\n" : "\n}\n", start);
	const body = SHIPPED.slice(start, end);
	if (body.split(find).length - 1 !== 1) throw new Error(`mutant "${label}": its target is not found exactly once inside its anchor`);
	return SHIPPED.slice(0, start) + body.replace(find, () => replace) + SHIPPED.slice(end);
}
const BATTERIES = [["§1", battery1], ["§2", battery2], ["§3", battery3], ["§3b", battery3b], ["§3c", battery3c]];

// ═════════════════════════════════════════════════════ run
(async () => {
	try {
		section("§1 THE PREDICATE AND THE HELPER");
		report(battery1());
		section("§2 THE SHARED HELPERS");
		report(battery2());
		section("§3 THE TOTALS — NAMED vs BLANK vs NONE");
		report(await battery3());
		section("§3b UNIT NUMBERS AND LOAD IDS THAT READ AS BUILT-IN NAMES");
		report(await battery3b());
		section("§3c THE LOAD-RATING SAVE");
		report(await battery3c());
		section("§4 SOURCE PINS");
		report(battery4(SHIPPED));

		// Judged by §1–§3c alone: a mutant must be caught by what the code DOES,
		// not merely by the pins above.
		section("§5 MUTANTS — each must flip at least one behavioural assertion above");
		for (const [label, anchor, find, replace] of MUTANTS) {
			const src = mutateWithin(anchor, find, replace, label);
			const flipped = [];
			let threw = null;
			for (const [, battery] of BATTERIES) {
				try { flipped.push(...failedLabels(await battery(src))); } catch (err) { threw = err.message.split("\n")[0]; break; }
			}
			builtinsChangedAndRestored();
			report([[`MUTANT ${label} → ${threw ? `the harness THREW (${threw})` : flipped.length ? `${flipped[0]}${flipped.length > 1 ? ` (+${flipped.length - 1} more)` : ""}` : "NOTHING fails"}`,
				threw === null && flipped.length > 0, true]]);
		}
	} catch (err) {
		failures.push(`runner crashed: ${err && err.stack}`);
		console.log(`FAIL  runner crashed: ${err && err.stack}`);
	}
	const leftover = builtinsChangedAndRestored();
	if (leftover.length) failures.push(`built-ins changed at the end: ${leftover.join(", ")}`);
	console.log("\n" + "-".repeat(60));
	if (failures.length) {
		console.log(`FAILED — ${failures.length} of ${pass + failures.length} assertions:\n  ${failures.map((f) => f.split("\n")[0]).join("\n  ")}`);
		process.exit(1);
	}
	console.log(`OK — ${pass} assertions passed`);
})();
