#!/usr/bin/env node
/**
 * GET /api/investor: each truck's breakdown is what that truck earned and cost
 * (2026-10-04).
 *
 * THE BUG. production.perTruckData was keyed by each truck's CURRENT driver:
 * the driver's whole revenue, receipts and load count, and the browser added
 * the driver's whole pay. A truck just given a driver read "Revenue (0 loads) $0"
 * over that driver's entire pay, and the truck that hauled the loads, its
 * driver gone, showed none. Fixed costs were worked out in the browser.
 *
 * THE FIX. A load, its revenue and its share of the driver's pay count on the
 * truck the load names; a receipt on the truck it names; a record naming no
 * truck on the driver's assigned truck. A day-rate driver's pay is split by
 * their active days on each truck, a share-paid driver's by revenue. The server
 * sends each truck's monthly driver pay, fixed costs (the remainder, so the parts
 * add up to unitMonthlyExpenses) and the pay's basis.
 *
 * THE FIXTURE (investor 5, July and August, so every figure is over 2 months):
 *   201  Dee Dayrate ($250/day) hauled two loads on it (4 days, $2,000), then
 *        moved to 202; it has no driver now. A $100 fuel receipt names it.
 *   202  Dee's truck now. It has hauled nothing.
 *   203  Pat Percent's (20 %): a $2,000 load naming it and a $500 load naming no
 *        truck; Dee covered one day on it ($600 load). Pat's $50 fuel receipt
 *        names no truck.
 *   Each truck carries $1,000 a month of insurance.
 *
 *   §1 revenue and loads follow the truck named on each load
 *   §2 pay is split across the trucks it was earned on, with its basis
 *   §3 receipts follow the truck they name, else the driver's assigned truck
 *   §4 fixed costs come from the server and the parts add up
 *   §5 a day whose loads name two trucks counts on one of them
 *   §6 a day counts on the truck named by its first load that names one; only a
 *      day no load names a truck for goes to the assigned truck; a closed month's
 *      days stay where they were (2026-10-08)
 *   §7 the breakdown's bottom lines are the server's: Monthly Net, Est. Annual
 *      Take-Home (Monthly Net x 12), each truck's own months, ROI and the fleet
 *      totals; a Super Admin previewing the investor gets the same figures, and
 *      with no investor in view the scope says "fleet" (2026-10-08)
 *
 * Pure: no server, no app.db, no network, no Sheets.
 *   node scripts/test-investor-truck-breakdown.js
 *   SERVER_JS=/tmp/base.js node scripts/test-investor-truck-breakdown.js   # a base commit: fails
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const geolib = require("geolib");
const fuelModel = require("../lib/fuel-model");
const { normalizeLoadId } = require("../lib/ratecon-load");

const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
const failures = [];
function check(label, cond) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.log(`  FAIL  ${label}`);
}

// ── lifting (as scripts/test-name-keyed-totals.js lifts the same route) ─────
function liftBetween(needle, terminator, label) {
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 ${label} in server.js, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	return SRC.slice(a, SRC.indexOf(terminator, a) + terminator.length);
}
function liftFn(name) {
	return SRC.includes(`\nasync function ${name}(`)
		? liftBetween(`\nasync function ${name}(`, "\n}\n", name)
		: liftBetween(`\nfunction ${name}(`, "\n}\n", name);
}
function liftDecl(kind, name) {
	const needle = `\n${kind} ${name} =`;
	const start = SRC.indexOf(needle) + 1;
	let end = SRC.indexOf("\n", start);
	if (/=\s*$/.test(SRC.slice(start, end))) end = SRC.indexOf("\n", end + 1);
	return SRC.slice(start, end);
}
const CONSTS = ["PAYOUT_RULES_V2_ENABLED", "PAYOUT_RULE_KEYS", "EXPENSE_PNL_FILTER", "EXPENSE_PERIOD_EXPR", "CANCELED_STATUS_RE",
	"RFC2822_MONTHS", "BROKER_WITHHELD_RE"];
const LETS = ["lastPayStructShadowWarnMs"];
const FNS = [
	"normalizeDriverName", "isBuiltInPropertyName", "driverNameForTotals",
	"getDriverPayStructures", "getAllExcludedDriverDays", "expenseDriverKey", "foldExpenseTotalsByDriver",
	"getDeductibleExpensesByDriverMonth", "computeInvestorMonthlyEarnings", "gatherLedgerScopeFacts", "payoutRules",
	"findCol", "pickAddressColumn", "loadKeySet", "excludeDroppedLoads", "liveJobTrackingView", "moneySheetDate",
	"houstonDay", "getWeekRange", "resolveDailyRate", "resolveInvestorSplitPct", "resolvePreviewUser",
	"getCarrierDBFromSQLite", "getInvestorDriverSet", "getInvestorDriverMonthWindows", "investorExpenseScopeSql",
	"assignmentMonthKey", "intersectMonthWindow", "truckChargeFromMonth", "truckChargeUntilMonth",
	"truckChargedInMonth", "truckMonthlyFixed", "truckBilledMonthCount", "computeLossCarryForward",
	"resolveBrokerWithheldColumns", "sanitizeBrokerColumns", "sanitizeDetails", "getLoadMilesIndex",
	"periodLockStmt", "isLocked",
];
const ROUTE = liftBetween('\napp.get("/api/investor", requireRole("Super Admin", "Investor"), async (req, res) => {', "\n});\n", "GET /api/investor");
const MODULE = [
	...CONSTS.map((c) => liftDecl("const", c)),
	...LETS.map((c) => liftDecl("let", c)),
	...FNS.map(liftFn),
	ROUTE,
].join("\n");

const NOW_MS = Date.UTC(2026, 8, 27, 17, 0, 0);
class FixedDate extends Date {
	constructor(...args) { super(...(args.length ? args : [NOW_MS])); }
	static now() { return NOW_MS; }
}

const HEADERS = ["Load ID", "Driver", "Pickup Appointment", "Drop-off Appointment", "Job Status", "Payment", "Assigned Date", "Truck", "Owner ID"];
const jt = (loadId, driver, pickup, dropoff, assigned, pay, truck) => ({
	"Load ID": loadId, Driver: driver, "Pickup Appointment": pickup, "Drop-off Appointment": dropoff,
	"Job Status": "Delivered", Payment: pay, "Assigned Date": assigned, Truck: truck, "Owner ID": "5",
});
const ROWS = [
	jt("1", "Dee Dayrate", "7/6/2026 8:00", "7/7/2026 10:00", "7/5/2026", "$1,000.00", "201"),
	jt("2", "Dee Dayrate", "7/14/2026 8:00", "7/15/2026 10:00", "7/13/2026", "$1,000.00", "201"),
	jt("3", "Dee Dayrate", "8/3/2026 8:00", "8/3/2026 18:00", "8/2/2026", "$600.00", "203"),
	jt("4", "Pat Percent", "8/10/2026 8:00", "8/11/2026 10:00", "8/9/2026", "$2,000.00", "203"),
	jt("5", "Pat Percent", "8/20/2026 8:00", "8/20/2026 18:00", "8/19/2026", "$500.00", ""),
];

const DDL = `
	CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT DEFAULT '', role TEXT DEFAULT '', company_name TEXT DEFAULT '', driver_name TEXT DEFAULT '', email TEXT DEFAULT '', rating REAL DEFAULT 0);
	CREATE TABLE investors (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, profile_picture_url TEXT DEFAULT '', full_name TEXT DEFAULT '', carrier_name TEXT DEFAULT '');
	CREATE TABLE investor_config (owner_id INTEGER DEFAULT 0, key TEXT, value TEXT);
	CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, carrier_name TEXT DEFAULT '', status TEXT DEFAULT 'active', pay_type TEXT DEFAULT 'fixed', pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0);
	CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, make TEXT DEFAULT '', model TEXT DEFAULT '', year TEXT DEFAULT '', vin TEXT DEFAULT '', license_plate TEXT DEFAULT '', status TEXT DEFAULT 'Active', assigned_driver TEXT DEFAULT '', owner_id INTEGER DEFAULT 0, notes TEXT DEFAULT '', created_at TEXT DEFAULT '2026-06-01 00:00:00', in_service_date TEXT DEFAULT '', retired_at TEXT DEFAULT '', photo TEXT DEFAULT '', insurance_monthly REAL DEFAULT 0, eld_monthly REAL DEFAULT 0, truck_payment_monthly REAL DEFAULT 0, hvut_annual REAL DEFAULT 0, irp_annual REAL DEFAULT 0, admin_fee_pct REAL, driver_pay_daily REAL DEFAULT 0, purchase_price REAL DEFAULT 0, title_status TEXT DEFAULT 'Clean', title_state TEXT DEFAULT '', maintenance_fund_monthly REAL DEFAULT 0, fuel_tank_gallons REAL DEFAULT 0, avg_mpg REAL DEFAULT 0, routemate_vehicle_id TEXT DEFAULT '');
	CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT DEFAULT '', start_date TEXT DEFAULT '', end_date TEXT DEFAULT '');
	CREATE TABLE carrier_driver_history (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, carrier_name TEXT, started_at TEXT DEFAULT '', ended_at TEXT DEFAULT '');
	CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT NOT NULL DEFAULT '', load_id TEXT DEFAULT '', type TEXT, amount REAL, description TEXT DEFAULT '', date TEXT DEFAULT '', gallons REAL DEFAULT 0, odometer REAL DEFAULT 0, status TEXT DEFAULT '', owner_id INTEGER DEFAULT 0, truck_unit TEXT DEFAULT '', posted_period TEXT DEFAULT '', created_at TEXT DEFAULT '2026-09-01 00:00:00');
	CREATE TABLE excluded_driver_days (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, excluded_date TEXT, reason TEXT DEFAULT '', excluded_by TEXT DEFAULT '', excluded_at TEXT DEFAULT '2026-09-01 00:00:00', action TEXT DEFAULT 'remove');
	CREATE TABLE maintenance_fund (id INTEGER PRIMARY KEY AUTOINCREMENT, truck TEXT, amount REAL, date TEXT DEFAULT '', created_at TEXT DEFAULT '2026-09-01 00:00:00', type TEXT DEFAULT 'service');
	CREATE TABLE compliance_fees (id INTEGER PRIMARY KEY AUTOINCREMENT, truck TEXT, amount REAL, paid_date TEXT DEFAULT '', due_date TEXT DEFAULT '', created_at TEXT DEFAULT '2026-09-01 00:00:00', status TEXT DEFAULT 'Paid');
	CREATE TABLE load_coordinates (load_id TEXT PRIMARY KEY, origin_lat REAL, origin_lng REAL, dest_lat REAL, dest_lng REAL, distance_miles REAL);
	CREATE TABLE load_eld_miles (load_id TEXT PRIMARY KEY, loaded_miles REAL, deadhead_miles REAL, loaded_basis TEXT DEFAULT 'no-data', in_progress INTEGER DEFAULT 0);
	CREATE TABLE load_ratecon_miles (load_id TEXT PRIMARY KEY, miles REAL NOT NULL, match TEXT NOT NULL DEFAULT '');
	CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT NOT NULL, week_start TEXT, week_end TEXT, total_earnings REAL DEFAULT 0, adjustment REAL DEFAULT 0, status TEXT DEFAULT 'Draft', deleted_at TEXT DEFAULT '');
	CREATE TABLE investor_payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, period TEXT, amount REAL, adjustment REAL DEFAULT 0, finalized_breakdown TEXT DEFAULT '');
	CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked', finalized_at TEXT DEFAULT '');
	CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
	CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT, latitude REAL, longitude REAL, speed REAL, bearing TEXT, fuel_pct REAL, location_date_ms INTEGER, dropped_reason TEXT DEFAULT '', odometer REAL DEFAULT 0, engine_hours REAL DEFAULT 0, geocoded_location TEXT DEFAULT '', source TEXT DEFAULT '');
`;

function seed(db) {
	const u = db.prepare("INSERT INTO users (id, username, role, company_name) VALUES (?, ?, ?, ?)");
	u.run(1, "super_admin", "Super Admin", "");
	u.run(5, "inv5", "Investor", "Acme Carrier");
	db.prepare("INSERT INTO investors (user_id, full_name, carrier_name) VALUES (5, 'Ivy Investor', 'Acme Carrier')").run();
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	const d = db.prepare("INSERT INTO drivers_directory (driver_name, pay_type, pay_percentage, pay_daily) VALUES (?, ?, ?, ?)");
	d.run("Dee Dayrate", "fixed", 0, 250);
	d.run("Pat Percent", "percentage", 20, 0);
	const t = db.prepare("INSERT INTO trucks (id, unit_number, assigned_driver, owner_id, insurance_monthly, purchase_price) VALUES (?, ?, ?, 5, 1000, 80000)");
	t.run(1, "201", "");
	t.run(2, "202", "Dee Dayrate");
	t.run(3, "203", "Pat Percent");
	const a = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, ?, ?)");
	a.run(1, "Dee Dayrate", "2026-06-01T12:00:00.000Z", "2026-09-01T12:00:00.000Z");
	a.run(2, "Dee Dayrate", "2026-09-01T12:00:00.000Z", "");
	a.run(3, "Pat Percent", "2026-06-01T12:00:00.000Z", "");
	const e = db.prepare("INSERT INTO expenses (driver, type, amount, date, owner_id, truck_unit) VALUES (?, 'Fuel', ?, ?, 5, ?)");
	e.run("Dee Dayrate", 100, "2026-07-15", "201");
	e.run("Pat Percent", 50, "2026-08-20", "");
}

// `opts.seed(db)` adds to the fixture; `opts.session` and `opts.query` make the
// request (the investor by default).
async function investorView(rows = ROWS, opts = {}) {
	const db = new Database(":memory:");
	db.exec(DDL);
	seed(db);
	if (opts.seed) opts.seed(db);
	let handler = null;
	const passthrough = (req, res, next) => (next ? next() : undefined);
	const deps = {
		db, geolib, fuelModel, normalizeLoadId, loadMilesLib: require("../lib/load-miles"), Date: FixedDate,
		app: { get: (p, ...h) => { handler = h[h.length - 1]; } },
		requireRole: () => passthrough,
		getJobTrackingCached: async () => ({ headers: [...HEADERS], data: rows.map((r, i) => ({ _rowIndex: i + 2, ...r })) }),
		getDeletedLoadIds: () => new Set(),
		getEldTravelDaysByVehicleCached: () => Object.create(null),
		logAudit: () => {},
		investorReportOptions: require("../lib/investor-report-options"),
		investorPayoutBasis: require("../lib/investor-payout-basis"),
		financialsCalc: require("../lib/financials-calc.js"),
		loadHaul: require("../lib/load-haul"),
		haulAssignmentsStmt: { all: () => [] },
		eldFeedHealth: require("../lib/eld-feed-health"),
		payoutBasisContext: () => null,
		console: { log() {}, warn() {}, error() {} },
	};
	new Function(...Object.keys(deps), MODULE)(...Object.values(deps));
	const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
	await handler({ session: { user: opts.session || { id: 5, role: "Investor", username: "inv5" } }, query: opts.query || {}, params: {}, headers: {} }, res);
	return res;
}

(async () => {
	const res = await investorView();
	check(`GET /api/investor answers 200 (got ${res.statusCode} ${res.body && res.body.error ? res.body.error : ""})`, res.statusCode === 200);
	const per = (res.body && res.body.production && res.body.production.perTruckData) || {};
	const t201 = per["201"] || {}, t202 = per["202"] || {}, t203 = per["203"] || {};
	const show = (o) => JSON.stringify(o);

	console.log("§1 revenue and loads follow the truck named on each load (over 2 months)");
	check(`§1 201 keeps the two loads Dee hauled on it, though Dee has moved: 2 loads, $1,000 a month (got ${t201.loadCount}, ${t201.unitMonthlyGross})`,
		t201.loadCount === 2 && t201.unitMonthlyGross === 1000);
	check(`§1 202, Dee's truck now, has hauled nothing: 0 loads, $0 (got ${t202.loadCount}, ${t202.unitMonthlyGross})`,
		t202.loadCount === 0 && t202.unitMonthlyGross === 0);
	check(`§1 203: Pat's load naming it, Pat's load naming no truck, and Dee's day on it: 3 loads, $1,550 a month (got ${t203.loadCount}, ${t203.unitMonthlyGross})`,
		t203.loadCount === 3 && t203.unitMonthlyGross === 1550);

	console.log("§2 pay is split across the trucks it was earned on");
	// Dee: 5 days x $250 = $1,250, 4 days on 201 and 1 on 203. Pat: 20% of
	// ($2,500 revenue − $50 fuel) = $490, all on 203.
	check(`§2 201: Dee's 4 days, $1,000, $500 a month (got ${t201.unitMonthlyDriverPay}, ${show(t201.driverPay)})`,
		t201.unitMonthlyDriverPay === 500 && t201.driverPay && t201.driverPay.totalPay === 1000 && t201.driverPay.months === 2 &&
		t201.driverPay.drivers.length === 1 && t201.driverPay.drivers[0].name === "Dee Dayrate" &&
		t201.driverPay.drivers[0].activeDays === 4 && t201.driverPay.drivers[0].dailyRate === 250 && t201.driverPay.drivers[0].payType === "fixed");
	check(`§2 202: no pay, though Dee is its driver now (got ${t202.unitMonthlyDriverPay}, ${show(t202.driverPay)})`,
		t202.unitMonthlyDriverPay === 0 && t202.driverPay === null);
	const pat = t203.driverPay && t203.driverPay.drivers.find((x) => x.name === "Pat Percent");
	const dee = t203.driverPay && t203.driverPay.drivers.find((x) => x.name === "Dee Dayrate");
	check(`§2 203: Pat's $490 share and Dee's one day, $250: $740, $370 a month (got ${t203.unitMonthlyDriverPay}, ${show(t203.driverPay)})`,
		t203.unitMonthlyDriverPay === 370 && t203.driverPay && t203.driverPay.totalPay === 740 &&
		pat && pat.totalPay === 490 && pat.payType === "percentage" && pat.payPercentage === 20 &&
		dee && dee.totalPay === 250 && dee.activeDays === 1);
	const fleetPay = Object.values((res.body.production || {}).driverPayDetails || {}).reduce((s, d) => s + (d.totalPay || 0), 0);
	check(`§2 every dollar of pay sits on exactly one truck here (fleet $${fleetPay}, trucks $${(t201.driverPay || {}).totalPay + (t203.driverPay || {}).totalPay})`,
		fleetPay === 1740 && (t201.driverPay || {}).totalPay + (t203.driverPay || {}).totalPay === 1740);

	console.log("§3 receipts follow the truck they name, else the driver's assigned truck");
	check(`§3 201: the $100 receipt naming it, $50 a month (got ${t201.unitMonthlyTripExpenses})`, t201.unitMonthlyTripExpenses === 50);
	check(`§3 202: none (got ${t202.unitMonthlyTripExpenses})`, t202.unitMonthlyTripExpenses === 0);
	check(`§3 203: Pat's $50 receipt naming no truck, $25 a month (got ${t203.unitMonthlyTripExpenses})`, t203.unitMonthlyTripExpenses === 25);

	console.log("§4 fixed costs come from the server, and the parts add up");
	for (const [unit, row] of [["201", t201], ["202", t202], ["203", t203]]) {
		check(`§4 ${unit}: fixed costs $1,000 a month (got ${row.unitMonthlyFixedCosts})`, row.unitMonthlyFixedCosts === 1000);
		check(`§4 ${unit}: pay + fixed + trip = monthly expenses (${row.unitMonthlyDriverPay} + ${row.unitMonthlyFixedCosts} + ${row.unitMonthlyTripExpenses} vs ${row.unitMonthlyExpenses})`,
			row.unitMonthlyDriverPay + row.unitMonthlyFixedCosts + row.unitMonthlyTripExpenses === row.unitMonthlyExpenses);
	}

	console.log("§5 a day whose loads name two trucks counts on one of them");
	{
		// Dee also hauled a $400 load on 201 on August 3, the day of the load on 203.
		// Dee still has 5 days ($1,250); the day stays with 203 (the first load, in
		// sheet order), so each truck's "N days x $250" is the pay beside it.
		const r5 = await investorView([...ROWS, jt("6", "Dee Dayrate", "8/3/2026 12:00", "8/3/2026 20:00", "8/2/2026", "$400.00", "201")]);
		const p = (r5.body && r5.body.production && r5.body.production.perTruckData) || {};
		const dee201 = ((p["201"] || {}).driverPay || { drivers: [] }).drivers.find((x) => x.name === "Dee Dayrate") || {};
		const dee203 = ((p["203"] || {}).driverPay || { drivers: [] }).drivers.find((x) => x.name === "Dee Dayrate") || {};
		check(`§5 Dee's days on the two trucks add up to Dee's 5 (got ${dee201.activeDays} + ${dee203.activeDays})`,
			dee201.activeDays + dee203.activeDays === 5);
		check(`§5 …and each truck's pay is its days x $250 (got ${dee201.totalPay} on 201, ${dee203.totalPay} on 203)`,
			dee201.totalPay === dee201.activeDays * 250 && dee203.totalPay === dee203.activeDays * 250 && dee201.activeDays === 4);
		check(`§5 …while the load's revenue counts on the truck it names: 201 $2,400, $1,200 a month (got ${(p["201"] || {}).unitMonthlyGross})`,
			(p["201"] || {}).unitMonthlyGross === 1200 && (p["201"] || {}).loadCount === 3);
	}

	console.log("§6 a day counts on the truck named by its first load that names one");
	{
		// August 25: Dee's first load that day (in sheet order) names no truck, the
		// second names 201. The day is 201's; only a day no load names a truck for
		// goes to Dee's assigned truck (202).
		const AUG25 = [
			jt("7", "Dee Dayrate", "8/25/2026 8:00", "8/25/2026 18:00", "8/24/2026", "$300.00", ""),
			jt("8", "Dee Dayrate", "8/25/2026 12:00", "8/25/2026 20:00", "8/24/2026", "$200.00", "201"),
		];
		const deeOn = (p, unit) => (((p[unit] || {}).driverPay || { drivers: [] }).drivers.find((x) => x.name === "Dee Dayrate") || {});
		const r6 = await investorView([...ROWS, ...AUG25]);
		const p = (r6.body && r6.body.production && r6.body.production.perTruckData) || {};
		check(`§6 the day goes to 201, named by its second load: Dee has 5 days on 201, $1,250 (got ${deeOn(p, "201").activeDays}, ${deeOn(p, "201").totalPay})`,
			deeOn(p, "201").activeDays === 5 && deeOn(p, "201").totalPay === 1250);
		check(`§6 …and none on 202, Dee's assigned truck, which hauled nothing (got ${show((p["202"] || {}).driverPay)})`, (p["202"] || {}).driverPay === null);
		check(`§6 …the load naming no truck still counts its revenue on 202 (got ${(p["202"] || {}).unitMonthlyGross} a month, ${(p["202"] || {}).loadCount} load)`,
			(p["202"] || {}).unitMonthlyGross === 150 && (p["202"] || {}).loadCount === 1);
		// A day whose only load names no truck: the assigned truck, as before.
		const r6b = await investorView([...ROWS, AUG25[0]]);
		const pb = (r6b.body && r6b.body.production && r6b.body.production.perTruckData) || {};
		check(`§6 a day whose only load names no truck counts on 202, Dee's assigned truck (got ${deeOn(pb, "202").activeDays} day)`, deeOn(pb, "202").activeDays === 1);
		// August closed: the day stays where the first load put it, as recorded.
		const r6c = await investorView([...ROWS, ...AUG25], { seed: (db) => db.prepare("INSERT INTO period_locks (period, status) VALUES ('2026-08', 'locked')").run() });
		const pc = (r6c.body && r6c.body.production && r6c.body.production.perTruckData) || {};
		check(`§6 with August closed the day stays on 202, its first load's (got 201 ${deeOn(pc, "201").activeDays}, 202 ${deeOn(pc, "202").activeDays}; ${r6c.statusCode})`,
			r6c.statusCode === 200 && deeOn(pc, "201").activeDays === 4 && deeOn(pc, "202").activeDays === 1);
	}

	console.log("§7 the breakdown's bottom lines come from the server");
	{
		// 204 went into service in September: one month of its own inside the
		// fleet's two (July and August).
		const seed204 = (db) => db.prepare("INSERT INTO trucks (id, unit_number, owner_id, insurance_monthly, purchase_price, in_service_date) VALUES (4, '204', 5, 1000, 0, '2026-09-01')").run();
		const r7 = await investorView(ROWS, { seed: seed204 });
		const prod = (r7.body && r7.body.production) || {};
		const p = prod.perTruckData || {};
		for (const unit of ["201", "202", "203", "204"]) {
			const t = p[unit] || {};
			check(`§7 ${unit}: Monthly Net is revenue less costs, $${t.unitMonthlyGross} − $${t.unitMonthlyExpenses} (got ${t.unitMonthlyNet})`,
				Number.isFinite(t.unitMonthlyNet) && t.unitMonthlyNet === t.unitMonthlyGross - t.unitMonthlyExpenses);
			check(`§7 ${unit}: Est. Annual Take-Home is Monthly Net x 12 (got ${t.unitEstAnnualTakeHome})`,
				Number.isFinite(t.unitEstAnnualTakeHome) && t.unitEstAnnualTakeHome === t.unitMonthlyNet * 12);
		}
		check(`§7 201: Monthly Net −$550 ($1,000 − $500 pay − $1,000 fixed − $50 trip), −$6,600 a year (got ${(p["201"] || {}).unitMonthlyNet}, ${(p["201"] || {}).unitEstAnnualTakeHome})`,
			(p["201"] || {}).unitMonthlyNet === -550 && (p["201"] || {}).unitEstAnnualTakeHome === -6600);
		check(`§7 each truck carries the months its figures are averaged on: 201 2, 204 1 (in service in September), the fleet 2 (got ${(p["201"] || {}).months}, ${(p["204"] || {}).months}, ${prod.monthsOfOperation})`,
			(p["201"] || {}).months === 2 && (p["204"] || {}).months === 1 && prod.monthsOfOperation === 2);
		const roiOf = (t) => (t.estAnnualInvestorRevenue === null ? null : (t.purchasePrice > 0 ? Math.round((t.estAnnualInvestorRevenue / t.purchasePrice) * 1000) / 10 : 0));
		check(`§7 each truck carries its own purchase price and the ROI over it: 201 $80,000 (got ${(p["201"] || {}).purchasePrice}, ROI ${(p["201"] || {}).investorROI})`,
			(p["201"] || {}).purchasePrice === 80000 && ["201", "202", "203", "204"].every((u) => (p[u] || {}).investorROI === roiOf(p[u] || {})));
		check(`§7 204 has no recorded price: ROI 0 or no projection, not a ratio over the fleet's price (got ${(p["204"] || {}).investorROI})`,
			(p["204"] || {}).investorROI === 0 || (p["204"] || {}).investorROI === null);
		const projected = Object.values(p).filter((t) => t.estAnnualInvestorRevenue !== null).reduce((s, t) => s + t.estAnnualInvestorRevenue, 0);
		check(`§7 the Fleet Total is the trucks with a projection, summed: $${projected} (got ${prod.fleetEstAnnualInvestorRevenue})`,
			prod.fleetEstAnnualInvestorRevenue === projected);
		check(`§7 the Fleet ROI is that total over the fleet's $240,000 (got ${prod.fleetInvestorROI})`,
			prod.fleetInvestorROI === Math.round((projected / 240000) * 1000) / 10 && prod.totalPurchasePrice === 240000);
		check(`§7 the investor's own view is scoped "investor" (got ${JSON.stringify(prod.perTruckScope)})`, prod.perTruckScope === "investor");

		// The same truck and period, seen by a Super Admin previewing investor 5.
		const admin = { id: 1, role: "Super Admin", username: "super_admin" };
		const preview = await investorView(ROWS, { seed: seed204, session: admin, query: { as_user_id: "5" } });
		const pp = (preview.body && preview.body.production) || {};
		const same = (k) => JSON.stringify(pp[k]) === JSON.stringify(prod[k]);
		check(`§7 a Super Admin previewing the investor gets the same per-truck figures (${preview.statusCode})`,
			preview.statusCode === 200 && same("perTruckData") && Object.keys(pp.perTruckData || {}).length === 4);
		check("§7 …and the same fleet figures and months", ["fleetEstAnnualInvestorRevenue", "fleetInvestorROI", "monthsOfOperation", "totalPurchasePrice", "perTruckScope"].every(same));
		const fleet = await investorView(ROWS, { seed: seed204, session: admin });
		const fp = (fleet.body && fleet.body.production) || {};
		check(`§7 a Super Admin with no investor in view: scope "fleet", no per-truck figures (got ${JSON.stringify(fp.perTruckScope)}, ${Object.keys(fp.perTruckData || {}).length} trucks)`,
			fp.perTruckScope === "fleet" && Object.keys(fp.perTruckData || {}).length === 0);
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
