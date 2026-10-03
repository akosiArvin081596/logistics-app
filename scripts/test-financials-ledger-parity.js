#!/usr/bin/env node
/**
 * GET /api/financials and the payout ledger give one month the same figures.
 *
 * WHAT IT REPRODUCES: the Financials monthly table and the investor payout math
 * compute a month two different ways. The fixture is a fleet that belongs
 * entirely to owner 5, so the fleet's month and the investor's month are the
 * same thing and must match to the cent.
 *   (a) OPEN MONTHS (July to October 2026, none locked). The shipped
 *       monthlyPerformance rows of GET /api/financials against the shipped
 *       computeInvestorMonthlyEarnings() (owner 5's scope, as the ledger reads
 *       it), on revenue, driverPay, fixedCosts, tripExpenses and netProfit:
 *         July       a $300 receipt dated in June (closed) and posted to July
 *                    (posted_period): Financials buckets it by its date
 *         August     an idle month for a truck in service: Financials charges
 *                    its fixed costs, the payout math charges $0
 *         September  a load assigned 09-28 running to 10-02: Financials puts
 *                    each day in its own calendar month, the payout math puts
 *                    every day in the load's Assigned month
 *         October    the current month, which holds only those spilled days
 *   (b) CLOSED MONTHS (May and June, locked by the shipped finalizePeriods()).
 *       Financials must show the figures the close froze in
 *       investor_payouts.finalized_breakdown. After the close, May's load was
 *       corrected from $6,000 to $6,250 in the sheet and the June receipt
 *       above was logged; the closed months must not move.
 *
 * The shipped code runs, lifted out of server.js: the whole GET /api/financials
 * handler (req/res stubbed), computeInvestorMonthlyEarnings(),
 * reconcileInvestorPayouts(), finalizePeriods(), assignDriverToTruck() and every
 * helper they call, on an in-memory SQLite built from server.js's own DDL.
 * Stubbed: the clock, the Job Tracking sheet read (getJobTrackingCached), the ELD
 * travel-day index (no truck is ELD-linked) and the drill-down's address lookup
 * (not reached). Every amount is whole dollars, so Financials' whole-dollar
 * rounding is not what fails here; figures are compared in integer cents.
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-financials-ledger-parity.js    # exits 1 on failure
 */
"use strict";

process.env.TZ = "UTC"; // production's clock zone

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function die(msg) { console.error(`SETUP FAILED: ${msg}`); process.exit(1); }

let Database, geolib;
try { Database = require("better-sqlite3"); geolib = require("geolib"); } catch (e) { die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`); }
const investorPayoutBasis = require(path.join(ROOT, "lib", "investor-payout-basis.js"));
const financialsCalc = require(path.join(ROOT, "lib", "financials-calc.js"));
const financialsReport = require(path.join(ROOT, "lib", "financials-report.js"));
const { normalizeLoadId } = require(path.join(ROOT, "lib", "ratecon-load.js"));

let pass = 0;
let fail = 0;
function check(cond, label, detail) {
	if (cond) { pass++; console.log(`  ok    ${label}`); } else { fail++; console.log(`  FAIL  ${label} — ${detail}`); }
}

// ── lifting ─────────────────────────────────────────────────────────────────
const count = (needle) => SRC.split(needle).length - 1;
function liftFn(name) {
	const needles = [`\nfunction ${name}(`, `\nasync function ${name}(`];
	const hits = needles.reduce((n, x) => n + count(x), 0);
	if (hits !== 1) die(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = SRC.indexOf(needles.find((x) => SRC.includes(x))) + 1;
	return SRC.slice(a, SRC.indexOf("\n}\n", a) + 2);
}
function liftRoute(head) {
	const needle = `\n${head}`;
	if (count(needle) !== 1) die(`expected exactly 1 registration ${JSON.stringify(head)}, found ${count(needle)}`);
	const a = SRC.indexOf(needle) + 1;
	return SRC.slice(a, SRC.indexOf("\n});\n", a) + "\n});".length);
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
// trucks is rebuilt by a migration (trucks_new, then renamed); that is its shape.
function trucksDdl() {
	const m = SRC.match(/CREATE TABLE trucks_new \(([\s\S]*?)\n\t\t\);/);
	if (!m) die("could not locate the trucks rebuild (CREATE TABLE trucks_new)");
	return `CREATE TABLE trucks (${m[1]}\n)`;
}
const alters = (table) => SRC.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN [^"\`]*`, "g")) || [];

const FINANCIALS_HEAD = 'app.get("/api/financials", requireRole("Super Admin"), async (req, res) => {';
const CONSTS = ["PAYOUT_RULES_V2_ENABLED", "PAYOUT_RULE_KEYS", "haulAssignmentsStmt", "LEDGER_ITEM_COLS", "EXPENSE_PNL_FILTER", "EXPENSE_PERIOD_EXPR", "CANCELED_STATUS_RE", "RFC2822_MONTHS", "PERIOD_FINALIZE_ENABLED",
	"INVESTOR_LEASE_PAYOUTS_ENABLED", "INVESTOR_LEASE_SETTINGS", "LEASE_SNAPSHOT_WARNED", "LOCKABLE_MONTH_KEY",
	"LOCK_PERIOD_MIN_YEAR", "LOCK_PERIOD_MAX_YEAR", "insertPayoutHistory", "FINANCIALS_GRANULARITIES", "FINANCIALS_GROUPINGS"];
const LETS = ["lastPayStructShadowWarnMs", "_jtEpoch"];
const FNS = [
	// Under test.
	"computeInvestorMonthlyEarnings", "gatherLedgerScopeFacts", "payoutRules", "ledgerLoadRows", "reconcileInvestorPayouts", "finalizePeriods",
	// What they and the Financials handler call, shipped as is.
	"assignDriverToTruck", "syncOpenCarrierPairing", "getInvestorDriverSet", "driverNameHeldByOtherSpelling",
	"driverNameHeldByOtherAccount", "findDriverNameClashes", "normalizeDriverName", "isBuiltInPropertyName",
	"driverNameForTotals", "findCol", "pickAddressColumn", "excludeDroppedLoads", "liveJobTrackingView",
	"getDeletedLoadIds", "loadKeySet", "moneySheetDate", "houstonDay", "getAllExcludedDriverDays",
	"getDriverPayStructures", "getDeductibleExpensesByDriverMonth", "expenseDriverKey", "foldExpenseTotalsByDriver",
	"resolveDailyRate", "getInvestorDriverMonthWindows", "investorExpenseScopeSql", "assignmentMonthKey",
	"intersectMonthWindow", "truckChargeFromMonth", "truckChargeUntilMonth", "truckChargedInMonth",
	"truckMonthlyFixed", "truckBilledMonthCount", "computeLossCarryForward", "resolveInvestorSplitPct",
	"lastFridayOfFollowingMonth", "periodLabel", "payoutRowBreakdown", "frozenPayoutBreakdown",
	"payoutBasisContext", "isLocked", "periodLockStmt", "periodLocksReadable", "periodWriteLocked", "todayKeyCT",
	"currentMonthKeyCT", "settlementGraceDays", "graceEndsAt", "periodPhase", "isPlausibleLockPeriod",
	"getCarrierDBFromSQLite", "recordPayoutChange", "listSettlableInvestors",
	"closingFingerprint", "closingLedgerItems", "financialsSettings", "financialsExtraItems", "closedMonthSettings", "computeFleetLedger", "settledMonthItems", "ambiguousBlankOwnerLoads", "buildHeldTruckIndex", "buildHaulTruckResolver", "frozenPeriodSet", "settledPayoutRows", "writeLedgerFreeze", "ledgerItemFromRow", "buildFinancialsLedger", "noteLateItemInClosedMonth", "logAudit", "installPeriodLockTriggers",
	"financialsReportQuery", "buildFinancialsReport", "getLoadMilesIndex",
];
const BODY = [
	...CONSTS.map((c) => liftDecl("const", c)),
	...LETS.map((c) => liftDecl("let", c)),
	...FNS.map(liftFn),
	liftRoute(FINANCIALS_HEAD),
	"return { computeInvestorMonthlyEarnings, reconcileInvestorPayouts, finalizePeriods, assignDriverToTruck, getInvestorDriverSet, getCarrierDBFromSQLite, installPeriodLockTriggers };",
].join("\n");

const DDL = [
	tableDdl("users"), ...alters("users"),
	tableDdl("investors"), ...alters("investors"),
	trucksDdl(), ...alters("trucks"),
	tableDdl("truck_assignments"), ...alters("truck_assignments"),
	tableDdl("carrier_driver_history"),
	tableDdl("drivers_directory"), ...alters("drivers_directory"),
	tableDdl("expenses"), ...alters("expenses"),
	tableDdl("excluded_driver_days"), ...alters("excluded_driver_days"),
	tableDdl("maintenance_fund"), tableDdl("compliance_fees"), tableDdl("deleted_loads"),
	tableDdl("load_coordinates"), ...alters("load_coordinates"), tableDdl("load_eld_miles"), tableDdl("load_ratecon_miles"),
	tableDdl("invoices"), ...alters("invoices"),
	tableDdl("investor_payouts"), ...alters("investor_payouts"),
	tableDdl("investor_payout_history"), tableDdl("investor_payout_basis"), tableDdl("period_locks"),
	tableDdl("audit_trail"), tableDdl("financials_ledger_items"), tableDdl("financials_ledger_freezes"), tableDdl("app_settings"),
	// The migrated shape (the CREATE is the pre-owner one; a migration rebuilds it).
	"CREATE TABLE investor_config (owner_id INTEGER DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id, key))",
];

// ── the clock: `new Date()` and Date.now() read NOW_MS ───────────────────────
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
const load = (id, assigned, pickup, dropoff, pay) => ({
	"Contract ID": "", "Load ID": id, Details: "Dry van", Driver: "Dave Driver", "Pickup Address": "", "Pickup Appointment": pickup,
	"Drop-off Address": "", "Drop-off Appointment": dropoff, "Job Status": "Delivered", "  Payment  ": pay,
	"Broker Contact Name": "", "Assigned Date": assigned, "Status Update Date": "", Truck: "T1", "Owner ID": "5",
});
const SHEET = [
	load("5001", "5/10/2026", "5/11/2026 8:00", "5/12/2026 10:00", "$6,000.00"),
	load("5002", "6/8/2026", "6/9/2026 8:00", "6/10/2026 10:00", "$5,500.00"),
	load("5003", "9/28/2026", "9/29/2026 8:00", "10/2/2026 10:00", "$4,000.00"),
];

function buildWorld() {
	const db = new Database(":memory:");
	for (const sql of DDL) {
		try { db.exec(sql); } catch (e) { if (!/duplicate column name/.test(e.message)) die(`DDL failed: ${e.message}\n${sql.slice(0, 120)}`); }
	}
	const routes = {};
	const errors = [];
	const deps = {
		db, geolib, investorPayoutBasis, normalizeLoadId, financialsCalc, financialsReport, loadHaul: require(path.join(__dirname, "..", "lib", "load-haul.js")), Date: Clock,
		app: { get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; } },
		requireRole: () => (req, res, next) => next && next(),
		getJobTrackingCached: async () => ({ headers: [...HEADERS], data: SHEET.map((r, i) => ({ _rowIndex: i + 2, ...r })) }),
		getEldTravelDaysByVehicleCached: () => Object.create(null),
		resolveCityState: () => "",
		insertDispatchNotification: { run() {} },
		// Miles are not money: the index of per-load miles is empty here.
		getLoadMilesIndex: () => new Map(),
		loadMilesLib: require(path.join(ROOT, "lib", "load-miles.js")),
		process: { env: {} },
		console: { log() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(" ")) },
	};
	let api;
	try {
		api = new Function(...Object.keys(deps), `"use strict";\n${BODY}`)(...Object.values(deps));
	} catch (e) { die(`lifted code did not assemble: ${e.message}`); }
	api.installPeriodLockTriggers(db);
	async function financials(month) {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = JSON.parse(JSON.stringify(b)); return res; } };
		await routes["GET /api/financials"]({ query: month ? { month } : {}, session: { user: SUPER } }, res);
		if (out.status !== 200) die(`GET /api/financials answered ${out.status}: ${JSON.stringify(out.body)} ${errors.join(" | ")}`);
		return out.body;
	}
	return { db, api, financials, errors };
}

const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const FIELDS = ["revenue", "driverPay", "fixedCosts", "tripExpenses", "netProfit"];
const cents = (v) => Math.round(Number(v || 0) * 100);
function diff(label, a, labelB, b) {
	return FIELDS.filter((f) => cents(a[f]) !== cents(b[f]))
		.map((f) => `${f}: ${label} ${cents(a[f])}¢, ${labelB} ${cents(b[f])}¢`);
}

(async () => {
	const { db, api, financials, errors } = buildWorld();

	// The fleet is owner 5's: truck T1, in service from May 2026, $2,700 a month
	// of fixed costs, $250 a day for its driver, Dave Driver.
	db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (1, 'super_admin', 'x', 'Super Admin', '')").run();
	db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (5, 'inv5', 'x', 'Investor', 'Acme Carrier')").run();
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, insurance_monthly, eld_monthly,
		truck_payment_monthly, hvut_annual, irp_annual, driver_pay_daily) VALUES (1, 'T1', 5, 'Active', '2026-05-01', '2026-05-01 00:00:00', 1000, 50, 1500, 600, 1200, 250)`).run();
	db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_daily) VALUES ('Dave Driver', 'Acme Carrier', 'fixed', 0)").run();
	const expense = db.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, status, owner_id, truck_unit, posted_period) VALUES (?, 'Dave Driver', 'Fuel', ?, ?, 'Approved', 5, 'T1', ?)");
	setClock("2026-05-01T17:00:00Z");
	api.assignDriverToTruck(1, "Dave Driver");
	expense.run("2026-05-12T20:00:00.000Z", 400, "2026-05-12", "");

	// 2026-07-10: the payouts screen reconciles owner 5, then the month-end close
	// locks May and June and freezes their rows.
	setClock("2026-07-10T17:00:00Z");
	const carrierDB = api.getCarrierDBFromSQLite();
	const ctx = { sessionUser: SUPER, carrierDB, globalConfig: { investor_split_pct: "50" } };
	await api.reconcileInvestorPayouts(5, ctx);
	await api.finalizePeriods(["2026-05", "2026-06"], "super_admin");
	const frozen = Object.fromEntries(db.prepare("SELECT period, finalized_at, finalized_breakdown FROM investor_payouts WHERE owner_id = 5 AND period IN ('2026-05', '2026-06')").all()
		.map((r) => [r.period, r.finalized_at ? JSON.parse(r.finalized_breakdown || "null") : null]));
	if (!frozen["2026-05"] || !frozen["2026-06"]) die(`the close did not freeze May and June for owner 5: ${JSON.stringify(frozen)}`);

	// After the close: a June receipt is logged into the open month (what POST
	// /api/expenses stores for a receipt dated in a closed month), and May's load
	// is corrected in the sheet.
	setClock("2026-07-12T17:00:00Z");
	expense.run("2026-07-12T17:00:00.000Z", 300, "2026-06-28", "2026-07");
	SHEET[0]["  Payment  "] = "$6,250.00";

	// 2026-10-05: read both sides.
	setClock("2026-10-05T17:00:00Z");
	const fin = await financials();
	const finByMonth = Object.fromEntries(fin.monthlyPerformance.map((m) => [m.month, m]));
	const set = api.getInvestorDriverSet(5, carrierDB.data, "Driver", "Carrier Name");
	const config = { investor_split_pct: "50" };
	const inv = await api.computeInvestorMonthlyEarnings({ user: { ...SUPER, id: 5 }, isSuperAdmin: false, investorDriverSet: set, investorOwnerId: 5, config });
	const fleet = await api.computeInvestorMonthlyEarnings({ user: SUPER, isSuperAdmin: true, investorDriverSet: null, investorOwnerId: null, config });
	const invByMonth = Object.fromEntries(inv.monthlyEarnings.map((m) => [m.month, m.exact]));
	const fleetByMonth = Object.fromEntries(fleet.monthlyEarnings.map((m) => [m.month, m.exact]));

	const months = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
	const missing = months.filter((m) => !finByMonth[m] || !invByMonth[m] || !fleetByMonth[m]);
	if (missing.length) die(`months missing from one side: ${missing.join(", ")}`);
	const scopeGap = months.flatMap((m) => diff("fleet", fleetByMonth[m], "owner 5", invByMonth[m]).map((d) => `${m} ${d}`));
	check(scopeGap.length === 0, "setup: the fleet is owner 5's, so the payout math's fleet and owner-5 months agree", scopeGap.join("; "));
	const lockedNow = db.prepare("SELECT period FROM period_locks WHERE status = 'locked' ORDER BY period").all().map((r) => r.period);
	check(JSON.stringify(lockedNow) === JSON.stringify(["2026-05", "2026-06"]), "setup: May and June are locked, July to October are open",
		`locked: ${JSON.stringify(lockedNow)}`);

	console.log("(a) open months: GET /api/financials == computeInvestorMonthlyEarnings()");
	for (const m of ["2026-07", "2026-08", "2026-09", "2026-10"]) {
		const d = diff("financials", finByMonth[m], "payout math", invByMonth[m]);
		check(d.length === 0, `(a) ${m}`, d.join("; "));
	}

	console.log("(b) closed months: GET /api/financials == the frozen finalized_breakdown");
	for (const m of ["2026-05", "2026-06"]) {
		const d = diff("financials", finByMonth[m], "frozen", frozen[m]);
		check(d.length === 0, `(b) ${m}`, d.join("; "));
	}

	// The month drill-down reconciles with its headline: September's load runs
	// 09-29 to 10-02 and is paid in September, all four days.
	const sep = await financials("2026-09");
	const md = sep.monthDetail || {};
	const driverPaySum = (md.drivers || []).reduce((a, d) => a + Math.round(d.pay * 100), 0);
	check(md.summary && cents(md.summary.driverPay) === 100000 && driverPaySum === 100000 && (md.drivers || [])[0].activeDays === 4,
		"the month drill-down's driver rows add up to its headline (September: 4 days, $1,000)", JSON.stringify({ summary: md.summary, drivers: md.drivers }));
	const shares = Object.values(md.expenseCategoryShares || {}).reduce((a, v) => a + v, 0);
	check(md.loads && md.loads.count === 1 && Math.round(shares) === 100, "…its loads are the month's revenue items, its category shares come from the server", JSON.stringify({ loads: md.loads, shares: md.expenseCategoryShares }));

	check(errors.length === 0, "the lifted code logged no error", errors.join(" | "));

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => die(`crashed: ${e.stack || e.message}`));
