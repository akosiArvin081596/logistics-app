#!/usr/bin/env node
/**
 * The payout ledger's month math is byte-identical to the golden figures.
 *
 * computeInvestorMonthlyEarnings() is the payout function's input: every
 * investor payout, statement and month-end close is built on what it returns.
 * This runner pins its whole output (every month of every scope, the `exact`
 * figures, investorEarnings and the month drill-down) on one fixture that
 * exercises each rule it applies:
 *   - Owner ID decides a load; a blank Owner ID falls back to the driver set
 *     (an ended carrier_driver_history pairing included, as today);
 *   - a company truck (owner 0) and the fleet view (Super Admin, no owner);
 *   - driver pay: directory rate, truck rate, the $250 fallback for a $0
 *     truck, a percentage driver, a load spanning two months (its days in its
 *     Assigned month), a load with no drop-off date, ELD travel-day narrowing,
 *     override days removed and added;
 *   - receipts by posted_period, Pending counted, Rejected not;
 *   - maintenance fund (service only) and compliance (Paid only);
 *   - fixed costs from the in-service month, a retired truck, an Inactive
 *     truck, and an idle month at $0;
 *   - a per-investor split override.
 * The golden figures were recorded from the ledger before it moved onto
 * lib/financials-calc.js (scripts/fixtures/ledger-golden.json), so this proves
 * the move changed no payout. GOLDEN_WRITE=1 rewrites the file (only ever on
 * purpose, when a reviewed change is meant to move the figures).
 *
 * The shipped code runs, lifted out of server.js, on an in-memory SQLite built
 * from server.js's own DDL. Stubbed: the clock, the Job Tracking sheet read,
 * the ELD travel-day index (one truck, three days) and the address lookup.
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-ledger-golden.js    # exits 1 on failure
 */
"use strict";

process.env.TZ = "UTC"; // production's clock zone

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const GOLDEN = path.join(__dirname, "fixtures", "ledger-golden.json");

function die(msg) { console.error(`SETUP FAILED: ${msg}`); process.exit(1); }

let Database;
try { Database = require("better-sqlite3"); } catch (e) { die(`better-sqlite3 did not load (${e.message}); run npm ci under the .nvmrc Node`); }
const investorPayoutBasis = require(path.join(ROOT, "lib", "investor-payout-basis.js"));
const { normalizeLoadId } = require(path.join(ROOT, "lib", "ratecon-load.js"));
const financialsCalc = fs.existsSync(path.join(ROOT, "lib", "financials-calc.js")) ? require(path.join(ROOT, "lib", "financials-calc.js")) : null;

let pass = 0;
let fail = 0;
function check(cond, label, detail) {
	if (cond) { pass++; console.log(`  ok    ${label}`); } else { fail++; console.log(`  FAIL  ${label} — ${detail}`); }
}

// ── lifting ─────────────────────────────────────────────────────────────────
const count = (needle) => SRC.split(needle).length - 1;
const defined = (name) => count(`\nfunction ${name}(`) + count(`\nasync function ${name}(`) === 1;
function liftFn(name) {
	const needles = [`\nfunction ${name}(`, `\nasync function ${name}(`];
	const hits = needles.reduce((n, x) => n + count(x), 0);
	if (hits !== 1) die(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = SRC.indexOf(needles.find((x) => SRC.includes(x))) + 1;
	return SRC.slice(a, SRC.indexOf("\n}\n", a) + 2);
}
function liftDecl(kind, name) {
	const needle = `\n${kind} ${name} =`;
	if (count(needle) !== 1) die(`expected exactly 1 ${kind} ${name} in server.js, found ${count(needle)}`);
	const a = SRC.indexOf(needle) + 1;
	return SRC.slice(a, SRC.indexOf(";\n", a) + 1);
}
function tableDdl(table) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${table}`);
	return `CREATE TABLE ${table} (${m[1]}\n)`;
}
function trucksDdl() {
	const m = SRC.match(/CREATE TABLE trucks_new \(([\s\S]*?)\n\t\t\);/);
	if (!m) die("could not locate the trucks rebuild (CREATE TABLE trucks_new)");
	return `CREATE TABLE trucks (${m[1]}\n)`;
}
const alters = (table) => SRC.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN [^"\`]*`, "g")) || [];

const CONSTS = ["PAYOUT_RULES_V2_ENABLED", "PAYOUT_RULE_KEYS", "PRE_DISPATCH_PAY_DAY_RULE_ENABLED", "EXPENSE_PNL_FILTER", "EXPENSE_PERIOD_EXPR", "CANCELED_STATUS_RE", "RFC2822_MONTHS",
	"INVESTOR_LEASE_PAYOUTS_ENABLED", "INVESTOR_LEASE_SETTINGS", "LEASE_SNAPSHOT_WARNED"];
const LETS = ["lastPayStructShadowWarnMs"];
const FNS = [
	"computeInvestorMonthlyEarnings",
	"assignDriverToTruck", "syncOpenCarrierPairing", "getInvestorDriverSet", "driverNameHeldByOtherSpelling",
	"driverNameHeldByOtherAccount", "findDriverNameClashes", "normalizeDriverName", "isBuiltInPropertyName",
	"driverNameForTotals", "findCol", "pickAddressColumn", "excludeDroppedLoads",
	"getDeletedLoadIds", "loadKeySet", "moneySheetDate", "appDay", "getAllExcludedDriverDays", "preDispatchPayDayFilter",
	"getDriverPayStructures", "getDeductibleExpensesByDriverMonth", "expenseDriverKey",
	"resolveDailyRate", "getInvestorDriverMonthWindows", "investorExpenseScopeSql", "assignmentMonthKey",
	"intersectMonthWindow", "truckChargeFromMonth", "truckChargeUntilMonth", "truckChargedInMonth",
	"truckMonthlyFixed", "resolveInvestorSplitPct", "payoutBasisContext", "getCarrierDBFromSQLite",
	// The ledger's own helpers once it moved onto lib/financials-calc.js.
	...["gatherLedgerScopeFacts", "payoutRules", "ledgerLoadRows"].filter(defined),
];
const BODY = [
	...CONSTS.map((c) => liftDecl("const", c)),
	...LETS.map((c) => liftDecl("let", c)),
	...FNS.map(liftFn),
	"return { computeInvestorMonthlyEarnings, assignDriverToTruck, getInvestorDriverSet, getCarrierDBFromSQLite };",
].join("\n");

const DDL = [
	tableDdl("users"), ...alters("users"),
	trucksDdl(), ...alters("trucks"),
	tableDdl("truck_assignments"), ...alters("truck_assignments"),
	tableDdl("carrier_driver_history"),
	tableDdl("drivers_directory"), ...alters("drivers_directory"),
	tableDdl("expenses"), ...alters("expenses"),
	tableDdl("excluded_driver_days"), ...alters("excluded_driver_days"),
	tableDdl("maintenance_fund"), tableDdl("compliance_fees"), tableDdl("deleted_loads"),
	tableDdl("investor_payouts"), ...alters("investor_payouts"),
	tableDdl("investor_payout_basis"),
	"CREATE TABLE investor_config (owner_id INTEGER DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id, key))",
];

// ── the clock ───────────────────────────────────────────────────────────────
let NOW_MS = 0;
const RealDate = Date;
class Clock extends RealDate {
	constructor(...a) { if (a.length) super(...a); else super(NOW_MS); }
	static now() { return NOW_MS; }
}
const setClock = (iso) => { NOW_MS = RealDate.parse(iso); };

// ── the sheet (production header order) ─────────────────────────────────────
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Driver", "Pickup Address", "Pickup Appointment", "Drop-off Address",
	"Drop-off Appointment", "Job Status", "  Payment  ", "Broker Contact Name", "Assigned Date",
	"Status Update Date", "Truck", "Owner ID",
];
const load = (id, driver, assigned, pickup, dropoff, status, pay, truck, owner) => ({
	"Contract ID": "", "Load ID": id, Details: "Dry van", Driver: driver, "Pickup Address": "", "Pickup Appointment": pickup,
	"Drop-off Address": "", "Drop-off Appointment": dropoff, "Job Status": status, "  Payment  ": pay,
	"Broker Contact Name": "", "Assigned Date": assigned, "Status Update Date": "", Truck: truck, "Owner ID": owner,
});
const ANN = "Ann Alpha";
const BOB = "Bob Bravo";
const CAT = "Cat Charlie";
const DAN = "Dan Delta";
const EVE = "Eve Echo";
const SHEET = [
	load("L1", ANN, "3/10/2026", "3/11/2026 8:00", "3/13/2026 10:00", "Delivered", "$5,000.00", "T5A", "5"),
	load("L2", ANN, "3/28/2026", "3/29/2026 8:00", "4/2/2026 10:00", "Completed", "$4,200.50", "T5A", "5"),
	load("L3", BOB, "5/20/2026", "5/21/2026 8:00", "5/21/2026 18:00", "POD Received", "$1,800.25", "T5B", "5"),
	load("L4", BOB, "6/3/2026", "6/4/2026 8:00", "", "Delivered", "$2,000.00", "T5B", "5"),
	load("L5", ANN, "6/10/2026", "6/11/2026 8:00", "6/12/2026 8:00", "In Transit", "$3,000.00", "T5A", "5"),
	load("L6", CAT, "4/5/2026", "4/6/2026 8:00", "4/8/2026 10:00", "Delivered", "$3,300.00", "T6", "6"),
	load("L7", CAT, "4/20/2026", "4/21/2026 8:00", "4/22/2026 10:00", "Delivered", "$2,700.00", "T6", "6"),
	load("L8", EVE, "2/10/2026", "2/11/2026 8:00", "2/12/2026 10:00", "Delivered", "$1,500.00", "", ""),
	load("L9", DAN, "1/15/2026", "1/16/2026 8:00", "1/17/2026 10:00", "Delivered", "$1,200.00", "C1", "0"),
	load("L10", DAN, "7/7/2026", "7/8/2026 8:00", "7/10/2026 10:00", "Delivered", "$2,222.22", "C1", ""),
	load("L11", ANN, "8/5/2026", "8/6/2026 8:00", "8/8/2026 10:00", "Cancelled", "$999.00", "T5A", "5"),
	load("L12", ANN, "9/14/2026", "9/15/2026 8:00", "9/17/2026 10:00", "Delivered", "$3,456.78", "T5A", "5"),
	load("L13", BOB, "7/1/2026", "7/2/2026 8:00", "7/3/2026 10:00", "Delivered", "$1,000.00", "T5B", "5"),
	load("L14", CAT, "9/2/2026", "9/3/2026 8:00", "9/4/2026 10:00", "Delivered", "$4,000.00", "T6", "6"),
	load("L15", ANN, "10/1/2026", "10/2/2026 8:00", "10/3/2026 10:00", "Delivered", "$2,500.00", "T5A", "5"),
];

function buildWorld() {
	const db = new Database(":memory:");
	for (const sql of DDL) {
		try { db.exec(sql); } catch (e) { if (!/duplicate column name/.test(e.message)) die(`DDL failed: ${e.message}\n${sql.slice(0, 120)}`); }
	}
	const errors = [];
	const deps = {
		appTime: require("../lib/app-time.js"), APP_TIMEZONE: require("../lib/app-time.js").appTimeZone(),
		db, investorPayoutBasis, normalizeLoadId, financialsCalc, Date: Clock,
		getJobTrackingCached: async () => ({ headers: [...HEADERS], data: SHEET.map((r, i) => ({ _rowIndex: i + 2, ...r })) }),
		getEldTravelDaysByVehicleCached: () => ({
			v1: { travel: new Set(["2026-09-15", "2026-09-17"]), coverage: new Set(["2026-09-15", "2026-09-16", "2026-09-17"]) },
		}),
		resolveCityState: (r, which, lid) => `${which}:${lid}`,
		process: { env: {} },
		console: { log() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(" ")) },
	};
	let api;
	try {
		api = new Function(...Object.keys(deps), `"use strict";\n${BODY}`)(...Object.values(deps));
	} catch (e) { die(`lifted code did not assemble: ${e.message}`); }
	return { db, api, errors };
}

const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };

(async () => {
	const { db, api, errors } = buildWorld();
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (?, ?, 'x', ?, ?)");
	user.run(1, "super_admin", "Super Admin", "");
	user.run(5, "inv5", "Investor", "Acme Carrier");
	user.run(6, "inv6", "Investor", "Beta Haul");
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (6, 'investor_split_pct', '60')").run();
	const truck = db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, retired_at, insurance_monthly,
		eld_monthly, truck_payment_monthly, hvut_annual, irp_annual, driver_pay_daily, routemate_vehicle_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	truck.run(1, "T5A", 5, "Active", "2026-03-01", "2026-03-01 00:00:00", "", 1000, 50, 1500, 600, 1200, 300, "v1");
	truck.run(2, "T5B", 5, "Active", "2026-05-15", "2026-05-15 00:00:00", "2026-08-31", 800.33, 45, 0, 550, 0, 0, "");
	truck.run(3, "T6", 6, "Active", "2026-04-01", "2026-04-01 00:00:00", "", 900, 50, 1200, 0, 900, 280, "");
	truck.run(4, "T6X", 6, "Inactive", "2026-01-01", "2026-01-01 00:00:00", "", 700, 40, 0, 0, 0, 200, "");
	truck.run(5, "C1", 0, "Active", "2025-12-01", "2025-12-01 00:00:00", "", 600, 50, 0, 0, 0, 260, "");
	const dir = db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_percentage, pay_daily) VALUES (?, ?, ?, ?, ?)");
	dir.run(ANN, "Acme Carrier", "fixed", 0, 320);
	dir.run(BOB, "Acme Carrier", "fixed", 0, 0);
	dir.run(CAT, "Beta Haul", "percentage", 25, 0);
	dir.run(DAN, "", "fixed", 0, 0);
	dir.run(EVE, "", "fixed", 0, 0);
	db.prepare("INSERT INTO carrier_driver_history (carrier_name, driver_name, started_at, ended_at) VALUES ('Beta Haul', ?, '2026-01-01', '2026-03-01')").run(EVE);
	const excl = db.prepare("INSERT INTO excluded_driver_days (driver_name, excluded_date, action) VALUES (?, ?, ?)");
	excl.run(ANN, "2026-03-12", "remove");
	excl.run(BOB, "2026-06-20", "add");
	const expense = db.prepare(`INSERT INTO expenses (timestamp, driver, type, amount, date, status, owner_id, truck_unit, posted_period, load_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	expense.run("2026-03-12T20:00:00.000Z", ANN, "Fuel", 400.10, "2026-03-12", "Approved", 5, "T5A", "", "L1");
	expense.run("2026-04-01T20:00:00.000Z", ANN, "Fuel", 250.05, "2026-04-01", "Pending", 5, "T5A", "", "L2");
	expense.run("2026-06-15T20:00:00.000Z", BOB, "Repair", 1000, "2026-06-15", "Rejected", 5, "T5B", "", "");
	expense.run("2026-07-02T20:00:00.000Z", BOB, "Toll", 33.33, "2026-06-28", "Approved", 5, "T5B", "2026-07", "L13");
	expense.run("2026-04-07T20:00:00.000Z", CAT, "Fuel", 500, "2026-04-07", "Approved", 6, "T6", "", "L6");
	expense.run("2026-07-09T20:00:00.000Z", DAN, "Fuel", 120, "2026-07-09", "Approved", 0, "C1", "", "L10");
	expense.run("2026-02-11T20:00:00.000Z", EVE, "Food", 45.5, "2026-02-11", "Approved", 0, "", "", "L8");
	expense.run("2026-09-16T20:00:00.000Z", CAT, "Maintenance", 210.4, "2026-09-16", "Approved", 6, "T6", "", "");
	db.prepare("INSERT INTO maintenance_fund (truck, type, amount, date) VALUES ('T5A', 'service', 300, '2026-05-02'), ('T6', 'service', 150, '2026-04-15'), ('T6', 'contribution', 999, '2026-04-16')").run();
	db.prepare("INSERT INTO compliance_fees (truck, type, amount, status, paid_date, due_date) VALUES ('T5A', 'IRP', 120, 'Paid', '2026-03-20', '2026-03-31'), ('T6', 'IFTA', 80, 'Pending', '', '2026-04-30')").run();

	setClock("2025-12-01T17:00:00Z");
	api.assignDriverToTruck(5, DAN);
	setClock("2026-03-01T17:00:00Z");
	api.assignDriverToTruck(1, ANN);
	setClock("2026-04-01T17:00:00Z");
	api.assignDriverToTruck(3, CAT);
	setClock("2026-05-15T17:00:00Z");
	api.assignDriverToTruck(2, BOB);

	setClock("2026-10-05T17:00:00Z");
	const carrierDB = api.getCarrierDBFromSQLite();
	const setOf = (owner) => api.getInvestorDriverSet(owner, carrierDB.data, "Driver", "Carrier Name");
	const cfg = (owner) => {
		const c = {};
		db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all().forEach((r) => (c[r.key] = r.value));
		db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(owner).forEach((r) => (c[r.key] = r.value));
		return c;
	};
	const run = (args) => api.computeInvestorMonthlyEarnings(args);
	const out = {
		owner5: await run({ user: { ...SUPER, id: 5 }, isSuperAdmin: false, investorDriverSet: setOf(5), investorOwnerId: 5, config: cfg(5), detailForMonth: "2026-06" }),
		owner6: await run({ user: { ...SUPER, id: 6 }, isSuperAdmin: false, investorDriverSet: setOf(6), investorOwnerId: 6, config: cfg(6), detailForMonth: "2026-04" }),
		fleet: await run({ user: SUPER, isSuperAdmin: true, investorDriverSet: null, investorOwnerId: null, config: cfg(0), detailForMonth: "2026-07" }),
	};
	const actual = JSON.parse(JSON.stringify(out));

	if (process.env.GOLDEN_WRITE === "1") {
		fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
		fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, "\t") + "\n");
		console.log(`wrote ${path.relative(ROOT, GOLDEN)}`);
	}
	if (!fs.existsSync(GOLDEN)) die(`${path.relative(ROOT, GOLDEN)} is missing`);
	const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));

	// Sanity: the fixture reaches every rule it is meant to.
	const months = (k) => Object.fromEntries(actual[k].monthlyEarnings.map((m) => [m.month, m]));
	const o5 = months("owner5");
	check(o5["2026-08"] && o5["2026-08"].fixedCosts === 0 && o5["2026-08"].revenue === 0, "fixture: owner 5's August is idle, so its fixed costs are $0", JSON.stringify(o5["2026-08"]));
	check(actual.owner6.monthlyEarnings.some((m) => m.month === "2026-02" && m.revenue === 1500), "fixture: the blank-Owner-ID load L8 reaches owner 6 through Eve's pairing", JSON.stringify(actual.owner6.monthlyEarnings.slice(0, 3)));
	check(actual.owner6.detail.driverPayRows.some((r) => r.payType === "percentage"), "fixture: owner 6's April pays a percentage driver", JSON.stringify(actual.owner6.detail.driverPayRows));

	for (const scope of ["owner5", "owner6", "fleet"]) {
		for (const part of ["monthlyEarnings", "currentMonthKey", "detail"]) {
			const a = JSON.stringify(actual[scope][part]);
			const g = JSON.stringify(golden[scope][part]);
			let where = "";
			if (a !== g && part === "monthlyEarnings") {
				const gm = Object.fromEntries(golden[scope][part].map((m) => [m.month, m]));
				const bad = actual[scope][part].filter((m) => JSON.stringify(m) !== JSON.stringify(gm[m.month]));
				where = bad.slice(0, 2).map((m) => `${m.month}: got ${JSON.stringify(m)} golden ${JSON.stringify(gm[m.month])}`).join(" | ");
			}
			check(a === g, `${scope} ${part} is byte-identical to the golden figures`, where || `got ${a.slice(0, 400)} golden ${g.slice(0, 400)}`);
		}
	}
	// The line items behind the months add back to every month's figures, to the cent.
	if (financialsCalc) {
		for (const scope of ["owner5", "owner6", "fleet"]) {
			const fromItems = financialsCalc.monthFiguresFromItems(out[scope].items || []);
			const gaps = [];
			for (const m of out[scope].monthlyEarnings) {
				const f = fromItems[m.month] || {};
				for (const k of ["revenue", "driverPay", "fixedCosts", "tripExpenses", "maintFundCost", "complianceCost", "netProfit"]) {
					if (Math.round(Number(f[k] || 0) * 100) !== Math.round(m.exact[k] * 100)) gaps.push(`${m.month} ${k}: items ${Math.round(Number(f[k] || 0) * 100)}¢ ledger ${Math.round(m.exact[k] * 100)}¢`);
				}
			}
			check(gaps.length === 0, `${scope}: the line items add back to every month's figures to the cent`, gaps.slice(0, 4).join("; "));
		}
	}
	check(errors.length === 0, "the lifted code logged no error", errors.join(" | "));

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => die(`crashed: ${e.stack || e.message}`));
