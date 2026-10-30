#!/usr/bin/env node
/**
 * The Financials overview: GET /api/financials/overview and its CSV
 * (lib/financials-overview.js, server.js buildFinancialsOverview()), on the
 * books fixture of test-financials-books.js: two investors (5 and 6) and a
 * company truck (C1); April and May closed and frozen at their close, March
 * closed before freezing existed, February frozen with a summary that differs
 * from its items. All data is made up.
 *
 *   §1 the flag and the gate: off, both routes answer 404 FEATURE_OFF and read
 *      no books; the gate runs first, flag on or off (401 signed out, 403
 *      Dispatcher, Driver and Investor); the route snapshot pins
 *      requireRole("Super Admin") first on both routes
 *   §2 truck and driver rows (catch-alls included) add up to the fleet on every
 *      line, counted line, total and net: a range over closed and open months, a
 *      mid-month range, one day, a week across a month end; "Not tied to a
 *      driver" is one row holding a driver-less load and driver-less costs
 *   §3 the fleet equals Fleet P&L (GET /api/financials/report) for the period
 *   §4 cost settings: fuel off in the open month only, reserve and depreciation,
 *      overhead, investor payouts, on the fleet, truck and driver tables
 *   §5 the checks: ok on every range, each naming its scope; (c) and (d) on
 *      whole months only; (d) skips the summary of a month closed before
 *      freezing existed; a frozen month's summary that differs from its items is
 *      an "as settled" note with the exact difference, not ok:false
 *   §6 a closed month shows as settled: a sheet edit after the close moves nothing
 *   §7 pay % of revenue is null, not 0, for a driver with no revenue; paid days
 *   §8 presets on the business day, and 400 INVALID_REPORT_QUERY for bad periods
 *   §9 a Personal credit row lands equally on its truck, its driver and the fleet
 *   §10 PAYOUT_RULES_V2, TRUCK_CHARGE_APP_DAY and LEDGER_DAY_ONCE each on (each
 *       moving a figure): the overview still equals Fleet P&L and its own rows
 *   §11 the CSV; the booked-not-delivered line; the pending line's known limit
 *   §12 each check can fail (pure, doctored inputs): a dropped truck or driver
 *       row fails (a) or (b), an unplaced item fails (c) and (d), an open month's
 *       summary difference fails (d) with ok false, a closed month's is a note;
 *       the CSV prints the mismatch
 *
 * The shipped code runs, lifted out of server.js (through
 * scripts/lib/server-source.js), on an in-memory SQLite built from server.js's
 * own DDL. Stubbed: the clock, the Job Tracking sheet and the ELD travel days.
 * On a server.js without the overview, its routes are stand-ins that answer 404,
 * so every case reports a failure instead of the run stopping.
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-financials-overview.js    # exits 1 on failure
 */
"use strict";

process.env.TZ = "UTC"; // production's clock zone

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();

function die(msg) { console.error(`SETUP FAILED: ${msg}`); process.exit(1); }

let Database;
try { Database = require("better-sqlite3"); } catch (e) { die(`better-sqlite3 did not load (${e.message}); run npm ci under the .nvmrc Node`); }
const investorPayoutBasis = require(path.join(ROOT, "lib", "investor-payout-basis.js"));
const financialsCalc = require(path.join(ROOT, "lib", "financials-calc.js"));
const financialsReport = require(path.join(ROOT, "lib", "financials-report.js"));
const financialsPresets = require(path.join(ROOT, "lib", "financials-presets.js"));
const { normalizeLoadId } = require(path.join(ROOT, "lib", "ratecon-load.js"));
let financialsOverview = null;
try { financialsOverview = require(path.join(ROOT, "lib", "financials-overview.js")); } catch { financialsOverview = null; }

let pass = 0;
let fail = 0;
function check(cond, label, detail) {
	if (cond) { pass++; console.log(`  ok    ${label}`); } else { fail++; console.log(`  FAIL  ${label} — ${detail}`); }
}
const section = (title) => console.log(`\n§ ${title}`);

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

const CONSTS = ["PAYOUT_RULES_V2_ENABLED", "PAYOUT_RULE_KEYS", "DRIVER_RATE_ONLY_FROM", "driverRateOnlyMonths", "PRE_DISPATCH_PAY_DAY_RULE_ENABLED", "FINANCIALS_GRANULARITIES", "FINANCIALS_GROUPINGS", "haulAssignmentsStmt", "LEDGER_ITEM_COLS", "EXPENSE_PNL_FILTER", "EXPENSE_PERIOD_EXPR", "CANCELED_STATUS_RE", "RFC2822_MONTHS", "PERIOD_FINALIZE_ENABLED",
	"INVESTOR_LEASE_PAYOUTS_ENABLED", "INVESTOR_LEASE_SETTINGS", "LEASE_SNAPSHOT_WARNED", "LOCKABLE_MONTH_KEY",
	"TRUCK_CHARGE_APP_DAY_RULE",
	"LOCK_PERIOD_MIN_YEAR", "LOCK_PERIOD_MAX_YEAR", "insertPayoutHistory"];
const LETS = ["lastPayStructShadowWarnMs", "driverRateOnlyStart", "_jtEpoch"];
const FNS = [
	"requireRole",
	"reconcileInvestorPayouts", "computeInvestorMonthlyEarnings", "gatherLedgerScopeFacts", "payoutRules", "ledgerLoadRows", "getInvestorDriverSet", "assignDriverToTruck",
	"syncOpenCarrierPairing", "finalizePeriods",
	"driverNameHeldByOtherSpelling", "driverNameHeldByOtherAccount", "findDriverNameClashes", "normalizeDriverName",
	"isBuiltInPropertyName", "driverNameForTotals", "findCol", "pickAddressColumn", "excludeDroppedLoads",
	"getDeletedLoadIds", "loadKeySet", "moneySheetDate", "appDay", "appMonthStart", "getAllExcludedDriverDays", "preDispatchPayDayFilter",
	"getDriverPayStructures", "getDeductibleExpensesByDriverMonth", "expenseFrom", "personalLedgerPresent", "expenseDriverKey", "resolveDailyRate", "driverDayRater", "driverRateOnlyApplies", "driverRateOnlyStartRecord", "truckRatesByDriver", "recordDriverRateOnlyAtClose", "forgetDriverRateOnlyMonths",
	"getInvestorDriverMonthWindows", "investorExpenseScopeSql", "assignmentMonthKey", "intersectMonthWindow",
	"truckChargeFromMonth", "truckChargeUntilMonth", "truckChargedInMonth", "truckMonthlyFixed",
	"computeLossCarryForward", "resolveInvestorSplitPct", "lastFridayOfFollowingMonth", "periodLabel",
	"payoutRowBreakdown", "frozenPayoutBreakdown", "payoutBasisContext", "isLocked", "periodLockStmt",
	"periodLocksReadable", "periodWriteLocked", "appTodayKey", "appMonthKey", "settlementGraceDays",
	"graceEndsAt", "periodPhase", "isPlausibleLockPeriod", "getCarrierDBFromSQLite", "recordPayoutChange",
	"noteLateItemInClosedMonth", "logAudit", "listSettlableInvestors", "installPeriodLockTriggers",
	"closingFingerprint", "closedMonthFreezePlan", "financialsReportQuery", "buildFinancialsReport", "pendingReceiptsInPeriod", "getLoadMilesIndex", "buildHaulTruckResolver", "auditText", "scrubPurgeMarker", "closingLedgerItems", "financialsSettings", "financialsExtraItems", "closedMonthSettings", "computeFleetLedger", "settledMonthItems", "ambiguousBlankOwnerLoads", "buildHeldTruckIndex", "appNoonMs", "frozenPeriodSet", "settledPayoutRows", "writeLedgerFreeze", "ledgerItemFromRow", "buildFinancialsLedger", "completedLoadCancelRefusal", "loadRowAccountingMonths", "sheetCellMonths", "sheetCellDate",
	// What the payout rules read once PAYOUT_RULES_V2 is on (§10).
	"futureAwarePeriodExpr", "receiptSubmittedDaySql", "stampFutureReceipts", "loadPayRateIndex", "currentPayRates", "recordPayRateChanges",
];
const REOPEN_HEAD = 'app.post("/api/periods/:period/reopen", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const FREEZE_HEAD = 'app.post("/api/admin/financials/freeze-closed-months", requireRole("Super Admin"), refuseCrossOrigin, async (req, res) => {';
const ADJUST_HEAD = 'app.put("/api/investor/payouts/:id/adjust", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const REPORT_HEAD = 'app.get("/api/financials/report", requireRole("Super Admin"), async (req, res) => {';
const SETTINGS_PUT_HEAD = 'app.put("/api/financials/settings", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
// The gate is the first handler on both routes, as written.
const OVERVIEW_HEAD = 'app.get("/api/financials/overview", requireRole("Super Admin"), async (req, res) => {';
const OVERVIEW_CSV_HEAD = 'app.get("/api/financials/overview.csv", requireRole("Super Admin"), async (req, res) => {';
const BUILT = count(`\n${OVERVIEW_HEAD}`) === 1 && count(`\n${OVERVIEW_CSV_HEAD}`) === 1 && count("\nconst FINANCIALS_OVERVIEW_ENABLED =") === 1
	&& count("\nasync function buildFinancialsOverview(") === 1 && count("\nfunction financialsOverviewQuery(") === 1 && financialsOverview !== null;
// Without the overview, stand-ins with no gate, so every case below fails.
const OVERVIEW_PARTS = BUILT
	? [liftDecl("const", "FINANCIALS_OVERVIEW_ENABLED"), liftFn("financialsOverviewQuery"), liftFn("buildFinancialsOverview"), liftRoute(OVERVIEW_HEAD), liftRoute(OVERVIEW_CSV_HEAD)]
	: ['app.get("/api/financials/overview", (req, res) => res.status(404).json({ code: "NOT_BUILT" }));',
		'app.get("/api/financials/overview.csv", (req, res) => res.status(404).json({ code: "NOT_BUILT" }));'];
const BODY = [
	...CONSTS.map((c) => liftDecl("const", c)),
	...LETS.map((c) => liftDecl("let", c)),
	...FNS.map(liftFn),
	liftRoute(REOPEN_HEAD),
	liftRoute(ADJUST_HEAD),
	liftRoute(FREEZE_HEAD),
	liftRoute(REPORT_HEAD),
	liftRoute(SETTINGS_PUT_HEAD),
	...OVERVIEW_PARTS,
	"return { reconcileInvestorPayouts, assignDriverToTruck, finalizePeriods, getCarrierDBFromSQLite, installPeriodLockTriggers, buildFinancialsLedger };",
].join("\n");

const DDL = [
	tableDdl("users"), ...alters("users"),
	tableDdl("investors"), ...alters("investors"),
	tableDdl("audit_trail"),
	trucksDdl(), ...alters("trucks"),
	tableDdl("truck_assignments"), ...alters("truck_assignments"),
	tableDdl("carrier_driver_history"),
	tableDdl("drivers_directory"), ...alters("drivers_directory"),
	tableDdl("expenses"), ...alters("expenses"),
	tableDdl("excluded_driver_days"), ...alters("excluded_driver_days"),
	tableDdl("maintenance_fund"), tableDdl("compliance_fees"), tableDdl("deleted_loads"),
	tableDdl("investor_payouts"), ...alters("investor_payouts"),
	tableDdl("investor_payout_history"), tableDdl("investor_payout_basis"), tableDdl("period_locks"),
	tableDdl("financials_ledger_items"), tableDdl("financials_ledger_freezes"), tableDdl("app_settings"),
	tableDdl("load_coordinates"), ...alters("load_coordinates"), tableDdl("load_eld_miles"), tableDdl("load_ratecon_miles"),
	tableDdl("pay_rate_history"),
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
const load = (id, driver, assigned, pickup, dropoff, pay, truck, owner, status = "Delivered") => ({
	"Contract ID": "", "Load ID": id, Details: "Dry van", Driver: driver, "Pickup Address": "", "Pickup Appointment": pickup,
	"Drop-off Address": "", "Drop-off Appointment": dropoff, "Job Status": status, "  Payment  ": pay,
	"Broker Contact Name": "", "Assigned Date": assigned, "Status Update Date": "", Truck: truck, "Owner ID": owner,
});
const D = "Dave Driver";
const E = "Eve Earner";
const F = "Fay Fox";
const baseSheet = () => [
	load("8001", E, "4/6/2026", "4/7/2026 8:00", "4/8/2026 10:00", "$5,000.00", "T5", "5"),
	load("8002", F, "4/10/2026", "4/11/2026 8:00", "4/12/2026 10:00", "$4,000.00", "T6", "6"),
	load("8003", D, "4/15/2026", "4/16/2026 8:00", "4/16/2026 18:00", "$2,000.00", "C1", "0"),
	load("8004", E, "5/5/2026", "5/6/2026 8:00", "5/7/2026 10:00", "$3,000.00", "T5", "5"),
	load("8005", D, "5/20/2026", "5/21/2026 8:00", "5/21/2026 18:00", "$1,500.00", "C1", ""),
	load("8006", F, "6/3/2026", "6/4/2026 8:00", "6/5/2026 10:00", "$2,500.00", "T6", "6"),
	// A June load with no driver: "Not tied to a driver" holds it.
	load("8020", "", "6/12/2026", "6/13/2026 8:00", "6/13/2026 18:00", "$700.00", "C1", "0"),
	// Booked in June, not delivered: outside the P&L.
	load("8021", F, "6/20/2026", "6/21/2026 8:00", "6/22/2026 10:00", "$1,234.00", "T6", "6", "Dispatched"),
];

const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const OTHERS = [
	{ id: 10, username: "disp", role: "Dispatcher" },
	{ id: 11, username: "drv", role: "Driver" },
	{ id: 5, username: "inv5", role: "Investor" },
];

function buildWorld({ env = {}, sheet = baseSheet() } = {}) {
	const db = new Database(":memory:");
	for (const sql of DDL) {
		try { db.exec(sql); } catch (e) { if (!/duplicate column name/.test(e.message)) die(`DDL failed: ${e.message}\n${sql.slice(0, 120)}`); }
	}
	const warnings = [];
	const errors = [];
	const routes = {};
	let sheetReads = 0;
	const register = (method) => (p, ...h) => { routes[`${method} ${p}`] = h; };
	const deps = {
		appTime: require("../lib/app-time.js"), APP_TIMEZONE: require("../lib/app-time.js").appTimeZone(),
		db, investorPayoutBasis, normalizeLoadId, financialsCalc, financialsReport, financialsOverview, Date: Clock,
		app: { post: register("POST"), put: register("PUT"), get: register("GET") },
		// expenseFrom() reads lib/personal-expense.js once a Personal line exists.
		require: (p) => require(String(p).startsWith("./") ? path.join(ROOT, p) : p),
		logAuditRefusal: () => {},
		refuseCrossOrigin: (req, res, next) => next && next(),
		getJobTrackingCached: async () => {
			sheetReads++;
			return { headers: [...HEADERS], data: sheet.map((r, i) => ({ _rowIndex: i + 2, ...r })) };
		},
		getEldTravelDaysByVehicleCached: () => Object.create(null),
		// Each load's pickup in TX and delivery in OK, except 8002 (OK to TX).
		resolveCityState: (r, which, lid) => (String(lid) === "8002") === (which === "pickup") ? "Tulsa, OK 74103" : "Dallas, TX 75201",
		loadMilesLib: require(path.join(ROOT, "lib", "load-miles.js")),
		loadPayDays: require("../lib/load-pay-days.js"), loadHaul: require(path.join(ROOT, "lib", "load-haul.js")),
		csvRows: require(path.join(ROOT, "lib", "csv.js")).csvRows,
		notifyChange: () => {},
		insertDispatchNotification: { run: () => {} },
		process: { env },
		console: { log() {}, warn: (m) => warnings.push(String(m)), error: (...a) => errors.push(a.map(String).join(" ")) },
		crypto: require("crypto"),
	};
	let api;
	try {
		api = new Function(...Object.keys(deps), `"use strict";\n${BODY}`)(...Object.values(deps));
	} catch (e) { die(`lifted code did not assemble: ${e.message}`); }
	api.installPeriodLockTriggers(db);
	// `chain`: every handler in order, each passing on through next(), as Express
	// runs them; otherwise the route's own handler only.
	async function call(route, req, { chain = false } = {}) {
		const out = { status: 200, body: null, headers: {} };
		const res = {
			status(code) { out.status = code; return res; },
			json(b) { out.body = JSON.parse(JSON.stringify(b)); return res; },
			setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
			send(b) { out.body = b; return res; },
		};
		const handlers = routes[route] || [];
		for (const h of chain ? handlers : handlers.slice(-1)) {
			let next = false;
			await h({ method: "GET", headers: {}, query: {}, ...req }, res, () => { next = true; });
			if (!next) break;
		}
		return out;
	}
	return { db, api, call, sheet, errors, warnings, sheetReads: () => sheetReads };
}

// The fixture: test-financials-books.js's fleet, April and May closed (frozen at
// their close), March closed with no freeze, February frozen with a summary
// that says $123.45 of revenue though it holds no item.
async function seed(W) {
	const { db, api } = W;
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (?, ?, 'x', ?, ?)");
	user.run(1, "super_admin", "Super Admin", "");
	user.run(5, "inv5", "Investor", "Acme Carrier");
	user.run(6, "inv6", "Investor", "Beta Haul");
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	const truck = db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, insurance_monthly,
		eld_monthly, truck_payment_monthly, hvut_annual, irp_annual, driver_pay_daily, maintenance_fund_monthly, purchase_price) VALUES (?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	truck.run(1, "T5", 5, "2026-04-01", "2026-04-01 00:00:00", 1000, 50, 1500, 600, 1200, 300, 900, 120000);
	truck.run(2, "T6", 6, "2026-04-01", "2026-04-01 00:00:00", 800, 40, 0, 0, 0, 280, 0, 0);
	truck.run(3, "C1", 0, "2026-04-01", "2026-04-01 00:00:00", 600, 50, 0, 0, 0, 260, 0, 0);
	const dir = db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_daily) VALUES (?, ?, 'fixed', 0)");
	dir.run(E, "Acme Carrier");
	dir.run(F, "Beta Haul");
	dir.run(D, "");
	setClock("2026-04-01T17:00:00Z");
	api.assignDriverToTruck(1, E);
	api.assignDriverToTruck(2, F);
	api.assignDriverToTruck(3, D);
	const expense = db.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, status, owner_id, truck_unit, posted_period, load_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
	expense.run("2026-04-07T20:00:00.000Z", E, "Fuel", 300, "2026-04-07", "Approved", 5, "T5", "", "8001");
	expense.run("2026-04-15T20:00:00.000Z", D, "Fuel", 100, "2026-04-15", "Approved", 0, "C1", "", "8003");
	expense.run("2026-05-05T20:00:00.000Z", F, "Toll", 50, "2026-05-05", "Approved", 6, "T6", "", "");
	expense.run("2026-06-04T20:00:00.000Z", F, "Fuel", 80, "2026-06-04", "Pending", 6, "T6", "", "8006");
	// Dave has a June receipt and no June load: a driver with no revenue.
	expense.run("2026-06-15T20:00:00.000Z", D, "Fuel", 60, "2026-06-15", "Approved", 0, "C1", "", "");
	db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng, distance_miles) VALUES ('8001', 32.7, -96.8, 36.1, -95.9, 260), ('8002', 36.1, -95.9, 32.7, -96.8, 255)").run();
	setClock("2026-07-10T17:00:00Z");
	const ctxPay = () => ({ sessionUser: SUPER, carrierDB: api.getCarrierDBFromSQLite(), globalConfig: { investor_split_pct: "50" } });
	for (const owner of [5, 6]) await api.reconcileInvestorPayouts(owner, ctxPay());
	await api.finalizePeriods(["2026-04", "2026-05"], "system");
	db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-03', 'locked', '2026-06-08T05:00:00.000Z', 'baseline'), ('2026-02', 'locked', '2026-06-08T05:00:00.000Z', 'baseline')").run();
	db.prepare("INSERT INTO financials_ledger_freezes (freeze_id, period, source, frozen_at, frozen_by, item_count, summary) VALUES ('2026-02:test:1', '2026-02', 'test', '2026-06-08T05:00:00.000Z', 'test', 0, ?)")
		.run(JSON.stringify({ revenue: 123.45, driverPay: 0, fixedCosts: 0, tripExpenses: 0, maintFundCost: 0, complianceCost: 0, netProfit: 123.45 }));
	return { expense };
}

// ── helpers ─────────────────────────────────────────────────────────────────
const c = (v) => Math.round(Number(v || 0) * 100);
const KEYS = financialsReport.COST_KEYS;
const overview = (W, query, user = SUPER) => W.call("GET /api/financials/overview", { query, session: { user } }, { chain: true });
const fleetPnl = (W, query) => W.call("GET /api/financials/report", { query: { ...query, groupBy: "fleet" }, session: { user: SUPER } });
const putSettings = (W, body) => W.call("PUT /api/financials/settings", { body, session: { user: SUPER } });
const bodyOf = (r) => (r && r.status === 200 && r.body && r.body.fleet ? r.body : null);
const rowOf = (rows, key) => (rows || []).find((r) => r.key === key) || null;
// The figures a row or the fleet is checked on, in integer cents.
const metrics = (f) => [
	["revenue", c(f.revenue)],
	...KEYS.map((k) => [`costs.${k}`, c(f.costs && f.costs[k])]),
	...KEYS.map((k) => [`countedCosts.${k}`, f.countedCosts ? c(f.countedCosts[k]) : NaN]),
	["totalCosts", c(f.totalCosts)],
	["margin", c(f.margin)],
];
// The rows' sums against the fleet, worked out here, not read off the checks.
function sumGaps(rows, fleet) {
	if (!fleet || !Array.isArray(rows)) return ["no overview"];
	const want = metrics(fleet);
	return want.filter(([name, v], i) => rows.reduce((a, r) => a + metrics(r)[i][1], 0) !== v).map(([name]) => name);
}
// Every field Fleet P&L's figure has, equal in the overview's fleet.
function pnlGaps(ov, pnl) {
	if (!ov || !pnl || pnl.status !== 200) return ["no overview or report"];
	return Object.keys(pnl.body.total).filter((k) => JSON.stringify(ov.fleet[k]) !== JSON.stringify(pnl.body.total[k]));
}
const failedChecks = (ov) => (ov ? ov.reconciliation.checks.filter((x) => x.status === "failed") : [{ check: "no overview" }]);
const briefChecks = (ov) => (ov ? ov.reconciliation.checks.map((x) => `${x.check}/${x.part || ""}/${x.scope}:${x.status}`).join(" ") : "no overview");
async function safely(label, fn) {
	try { await fn(); } catch (e) { check(false, `${label}: ran to the end`, e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e)); }
}

const RANGES = {
	"closed and open months (May settled, June live)": { from: "2026-05-01", to: "2026-06-30" },
	"mid-month (Jun 10-20)": { from: "2026-06-10", to: "2026-06-20" },
	"one day (Jun 4)": { from: "2026-06-04", to: "2026-06-04" },
	"a week across a month end (Sat May 30 - Fri Jun 5)": { from: "2026-05-30", to: "2026-06-05" },
};

(async () => {
	console.log(BUILT ? "the overview is in this server.js" : "the overview is NOT in this server.js: its routes are stand-ins, so the cases below fail");

	// ═════════════════════════ §1 the flag and the gate ═════════════════════════
	section("1 the flag and the gate");
	await safely("§1", async () => {
		const off = buildWorld();
		await seed(off);
		const readsBefore = off.sheetReads();
		const offJson = await overview(off, { preset: "lastMonth" });
		const offCsv = await off.call("GET /api/financials/overview.csv", { query: { preset: "lastMonth" }, session: { user: SUPER } }, { chain: true });
		check(offJson.status === 404 && offJson.body && offJson.body.code === "FEATURE_OFF" && offCsv.status === 404 && offCsv.body && offCsv.body.code === "FEATURE_OFF",
			"flag off: both routes answer 404 FEATURE_OFF to a Super Admin", JSON.stringify([offJson.status, offJson.body, offCsv.status]));
		check(offJson.body && offJson.body.code === "FEATURE_OFF" && off.sheetReads() === readsBefore, "flag off: no books are built (the sheet is never read)", `${off.sheetReads() - readsBefore} sheet read(s)`);
		const on = buildWorld({ env: { FINANCIALS_OVERVIEW_ENABLED: "true" } });
		await seed(on);
		for (const [w, flag] of [[off, "off"], [on, "on"]]) {
			const signedOut = await w.call("GET /api/financials/overview", { query: {}, session: {} }, { chain: true });
			const signedOutCsv = await w.call("GET /api/financials/overview.csv", { query: {}, session: {} }, { chain: true });
			check(signedOut.status === 401 && signedOutCsv.status === 401, `flag ${flag}: signed out, both routes answer 401`, `${signedOut.status} ${signedOutCsv.status}`);
			for (const u of OTHERS) {
				const before = w.sheetReads();
				const r = await overview(w, { preset: "lastMonth" }, u);
				const rc = await w.call("GET /api/financials/overview.csv", { query: { preset: "lastMonth" }, session: { user: u } }, { chain: true });
				check(r.status === 403 && rc.status === 403 && w.sheetReads() === before, `flag ${flag}: ${u.role} gets 403 on both routes, before any books are read`, `${r.status} ${rc.status}`);
			}
		}
		const ok = await overview(on, { preset: "lastMonth" });
		check(ok.status === 200 && bodyOf(ok) !== null, "flag on (exactly \"true\"): a Super Admin gets the overview", `${ok.status}`);
		const loose = buildWorld({ env: { FINANCIALS_OVERVIEW_ENABLED: "1" } });
		await seed(loose);
		const looseRes = await overview(loose, { preset: "lastMonth" });
		check(looseRes.status === 404 && looseRes.body && looseRes.body.code === "FEATURE_OFF", "the flag set to \"1\" is still off (on only when exactly \"true\")", JSON.stringify(looseRes.body));
		check(count(`\n${OVERVIEW_HEAD}`) === 1 && count(`\n${OVERVIEW_CSV_HEAD}`) === 1,
			"server.js registers both routes at column 0 with requireRole(\"Super Admin\") as the first handler", "");
		const snapshot = fs.readFileSync(path.join(__dirname, "fixtures", "route-snapshot.txt"), "utf8");
		const gateOf = (route) => {
			const m = snapshot.match(new RegExp(`^GET ${route.replace(/[.]/g, "\\.")} · (requireRole\\("Super Admin"\\)=anon@[0-9a-f]{12}) · inline@[0-9a-f]{12}$`, "m"));
			return m ? m[1] : null;
		};
		const reportGate = gateOf("/api/financials/report");
		check(reportGate && gateOf("/api/financials/overview") === reportGate && gateOf("/api/financials/overview.csv") === reportGate,
			"the route snapshot pins both routes as requireRole(\"Super Admin\"), the report's own gate, then the handler: nothing else in front",
			JSON.stringify({ report: reportGate, overview: gateOf("/api/financials/overview"), csv: gateOf("/api/financials/overview.csv") }));
	});

	// One world for §2-§8 and §11.
	const W = buildWorld({ env: { FINANCIALS_OVERVIEW_ENABLED: "true" } });
	await seed(W);

	// ═════════════════════════ §2 rows add up, §3 equals Fleet P&L ══════════════
	section("2 trucks and drivers add up to the fleet; 3 the fleet equals Fleet P&L");
	await safely("§2-3", async () => {
		for (const [name, range] of Object.entries(RANGES)) {
			const ov = bodyOf(await overview(W, range));
			check(ov && sumGaps(ov.trucks, ov.fleet).length === 0, `${name}: the truck rows, catch-alls included, add up to the fleet on every line, counted line, total and net`, JSON.stringify(ov ? sumGaps(ov.trucks, ov.fleet) : "no overview"));
			check(ov && sumGaps(ov.drivers, ov.fleet).length === 0, `${name}: the driver rows add up to the fleet the same way`, JSON.stringify(ov ? sumGaps(ov.drivers, ov.fleet) : "no overview"));
			const pnl = await fleetPnl(W, range);
			check(pnlGaps(ov, pnl).length === 0, `${name}: the fleet is Fleet P&L's figure for the period, every field (lines, counted lines, states, totals, basis)`, JSON.stringify(pnlGaps(ov, pnl)));
			check(ov && ov.reconciliation.ok === true, `${name}: the checks agree (ok)`, briefChecks(ov));
		}
		const mixed = bodyOf(await overview(W, RANGES["closed and open months (May settled, June live)"]));
		const truckKeys = mixed ? mixed.trucks.map((r) => r.key) : [];
		check(mixed && mixed.period.basis === "mixed" && JSON.stringify(truckKeys.filter((k) => /^truck:./.test(k)).sort()) === JSON.stringify(["truck:c1", "truck:t5", "truck:t6"])
			&& mixed.trucks.slice(-1)[0].catchAll === true && mixed.trucks.filter((r) => r.catchAll).every((r) => financialsOverview.TRUCK_CATCH_ALLS.includes(r.key)),
			"May-June: basis mixed; rows for C1, T5 and T6, then the catch-alls (here the investor payouts) last", JSON.stringify(truckKeys));
		const june = bodyOf(await overview(W, { from: "2026-06-01", to: "2026-06-30" }));
		const noDriver = june ? june.drivers.filter((r) => r.key === "driver:") : [];
		check(noDriver.length === 1 && c(noDriver[0].revenue) === 70000 && c(noDriver[0].costs.fixedCosts) > 0 && noDriver[0].label === "Not tied to a driver",
			"June: \"Not tied to a driver\" is one row holding both the driver-less load ($700) and the driver-less costs (truck fixed costs)",
			JSON.stringify(noDriver.map((r) => [r.label, r.revenue, r.costs.fixedCosts])));
	});

	// ═════════════════════════ §4 cost settings ═════════════════════════════════
	section("4 cost settings (April and May closed on the defaults, June open)");
	await safely("§4", async () => {
		const range = { from: "2026-04-01", to: "2026-06-30" };
		const defaults = bodyOf(await overview(W, range));
		const allOk = async (label) => {
			const ov = bodyOf(await overview(W, range));
			const pnl = await fleetPnl(W, range);
			check(ov && ov.reconciliation.ok && sumGaps(ov.trucks, ov.fleet).length === 0 && sumGaps(ov.drivers, ov.fleet).length === 0 && pnlGaps(ov, pnl).length === 0,
				`${label}: the rows still add up, the checks agree, and the fleet is still Fleet P&L's`, JSON.stringify({ trucks: ov && sumGaps(ov.trucks, ov.fleet), drivers: ov && sumGaps(ov.drivers, ov.fleet), pnl: pnlGaps(ov, pnl) }));
			return ov;
		};
		await putSettings(W, { costs: { fuel: false } });
		const fuel = await allOk("fuel off");
		const t5 = fuel && rowOf(fuel.trucks, "truck:t5");
		const t6 = fuel && rowOf(fuel.trucks, "truck:t6");
		const eve = fuel && rowOf(fuel.drivers, "driver:eve earner");
		const fay = fuel && rowOf(fuel.drivers, "driver:fay fox");
		check(fuel && fuel.fleet.lineState.fuel === "partial" && c(fuel.fleet.costs.fuel) === 54000 && c(fuel.fleet.countedCosts.fuel) === 40000
			&& c(fuel.fleet.totalCosts) === c(defaults.fleet.totalCosts) - 14000,
			"fuel off in open June only: the fleet's fuel is partial, $540 of which only closed April's $400 counts; total costs drop by June's $140",
			JSON.stringify(fuel && { state: fuel.fleet.lineState.fuel, value: fuel.fleet.costs.fuel, counted: fuel.fleet.countedCosts.fuel, total: [defaults.fleet.totalCosts, fuel.fleet.totalCosts] }));
		check(t5 && c(t5.countedCosts.fuel) === 30000 && t5.lineState.fuel === "partial" && t6 && c(t6.costs.fuel) === 8000 && c(t6.countedCosts.fuel) === 0
			&& eve && c(eve.receipts) === 30000 && fay && c(fay.costs.fuel) === 8000 && c(fay.receipts) === 5000,
			"…by truck: T5 counts its April $300 (partial), T6 reports June's $80 and counts none; by driver: Eve's receipts $300 counted, Fay's are her May toll ($50) without June's $80 fuel",
			JSON.stringify({ t5: t5 && [t5.costs.fuel, t5.countedCosts.fuel, t5.lineState.fuel], t6: t6 && [t6.costs.fuel, t6.countedCosts.fuel], eve: eve && eve.receipts, fay: fay && fay.receipts }));
		await putSettings(W, { costs: { fuel: true, maintenanceReserve: true, depreciation: true } });
		const resDep = await allOk("reserve and depreciation on");
		const t5r = resDep && rowOf(resDep.trucks, "truck:t5");
		const nd = resDep && rowOf(resDep.drivers, "driver:");
		check(t5r && c(t5r.countedCosts.maintenanceReserve) === 90000 && c(t5r.countedCosts.depreciation) === 200000 && t5r.lineState.maintenanceReserve === "partial"
			&& nd && c(nd.countedCosts.maintenanceReserve) === 90000 && c(nd.countedCosts.depreciation) === 200000
			&& c(t5r.otherCosts) === c(t5r.countedCosts.maintenanceReserve) + c(t5r.countedCosts.depreciation) + c(t5r.countedCosts.tolls) + c(t5r.countedCosts.otherReceipts) + c(t5r.countedCosts.maintenanceFund) + c(t5r.countedCosts.complianceFees) + c(t5r.countedCosts.overhead) + c(t5r.countedCosts.investorPayouts),
			"reserve and depreciation on: open June's $900 and $2,000 on T5's row (in its Other costs) and in \"Not tied to a driver\"; partial over April-June",
			JSON.stringify({ t5: t5r && [t5r.countedCosts.maintenanceReserve, t5r.countedCosts.depreciation, t5r.otherCosts], noDriver: nd && [nd.countedCosts.maintenanceReserve, nd.countedCosts.depreciation] }));
		await putSettings(W, { costs: { maintenanceReserve: false, depreciation: false, overhead: true }, overheadMonthly: 1000 });
		const oh = await allOk("overhead on");
		const company = oh && rowOf(oh.trucks, "overhead");
		const ndo = oh && rowOf(oh.drivers, "driver:");
		check(company && company.catchAll && c(company.countedCosts.overhead) === 100000 && ndo && c(ndo.countedCosts.overhead) === 100000 && oh.fleet.lineState.overhead === "partial",
			"overhead on: June's $1,000 in \"Company overhead\" by truck and in \"Not tied to a driver\" by driver", JSON.stringify({ company: company && company.countedCosts.overhead, noDriver: ndo && ndo.countedCosts.overhead }));
		await putSettings(W, { costs: { overhead: false, investorPayouts: true }, overheadMonthly: 0 });
		const pay = await allOk("investor payouts on");
		const payT = pay && rowOf(pay.trucks, "investor_payouts");
		const payD = pay && rowOf(pay.drivers, "investor_payouts");
		const juneOnly = pay && pay.fleet.lineState.investorPayouts === "partial" && c(pay.fleet.countedCosts.investorPayouts) < c(pay.fleet.costs.investorPayouts);
		check(payT && payD && payT.catchAll && c(payT.countedCosts.investorPayouts) === c(pay.fleet.countedCosts.investorPayouts) && c(payD.countedCosts.investorPayouts) === c(pay.fleet.countedCosts.investorPayouts) && juneOnly
			&& c(payT.otherCosts) === c(payT.countedCosts.investorPayouts) && c(payT.totalCosts) === c(payT.otherCosts),
			"investor payouts on: an \"Investor payouts\" row in both tables; closed April and May (closed with them off) report theirs but count none (partial); the row's Other costs and total are the counted part only",
			JSON.stringify(pay && { fleet: [pay.fleet.costs.investorPayouts, pay.fleet.countedCosts.investorPayouts, pay.fleet.lineState.investorPayouts], truckRow: payT && [payT.costs.investorPayouts, payT.countedCosts.investorPayouts, payT.otherCosts] }));
		await putSettings(W, { costs: { investorPayouts: false } });
	});

	// ═════════════════════════ §5 the checks ════════════════════════════════════
	section("5 the checks");
	await safely("§5", async () => {
		const ov = bodyOf(await overview(W, { from: "2026-02-01", to: "2026-06-30" }));
		const checks = ov ? ov.reconciliation.checks : [];
		const find = (check, scope, part) => checks.find((x) => x.check === check && x.scope === scope && (part === undefined || x.part === part)) || null;
		check(ov && ov.reconciliation.ok === true && JSON.stringify(ov.period.wholeMonths) === JSON.stringify(["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]),
			"Feb-Jun: ok, over five whole months", JSON.stringify(ov && [ov.reconciliation.ok, ov.period.wholeMonths]));
		check(checks.length > 0 && checks.every((x) => typeof x.scope === "string" && x.scope && ["ok", "failed", "note", "skipped"].includes(x.status) && Array.isArray(x.differences)),
			"every check names its scope and its status", briefChecks(ov));
		check(find("a", "trucks") && find("a", "trucks").status === "ok" && find("b", "drivers") && find("b", "drivers").status === "ok",
			"(a) trucks and (b) drivers: ok", briefChecks(ov));
		const months = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
		check(months.every((mk) => find("c", mk) && find("c", mk).status === "ok") && months.every((mk) => find("d", mk, "ledger figures") && find("d", mk, "ledger figures").status === "ok"),
			"(c) each month's items add up to its lines, and (d) its lines are the ledger's figures, in every whole month", briefChecks(ov));
		const march = find("d", "2026-03", "recorded summary");
		check(march && march.status === "skipped" && /freezing/.test(march.reason || ""),
			"(d) March, closed before freezing existed: its summary part is skipped, saying why, not passed", JSON.stringify(march));
		check(["2026-04", "2026-05"].every((mk) => find("d", mk, "recorded summary") && find("d", mk, "recorded summary").status === "ok") && !find("d", "2026-06", "recorded summary"),
			"(d) April and May equal the summaries their freezes recorded; open June has none to check", briefChecks(ov));
		const feb = find("d", "2026-02", "recorded summary");
		check(feb && feb.status === "note" && feb.note === "as settled"
			&& JSON.stringify(feb.differences) === JSON.stringify([{ line: "revenue", expectedCents: 12345, actualCents: 0, diffCents: -12345 }]),
			"(d) February's summary says $123.45 of revenue it doesn't hold: an \"as settled\" note with the exact difference (−12345 cents), and ok stays true",
			JSON.stringify(feb));
		const mid = bodyOf(await overview(W, RANGES["mid-month (Jun 10-20)"]));
		const midChecks = mid ? mid.reconciliation.checks : [];
		check(mid && midChecks.filter((x) => x.check === "c" || x.check === "d").length === 2 && midChecks.filter((x) => x.check === "c" || x.check === "d").every((x) => x.status === "skipped" && x.scope === "period"),
			"Jun 10-20 holds no whole month: (c) and (d) are skipped for the period, not passed", briefChecks(mid));
	});

	// ═════════════════════════ §6 closed months as settled ══════════════════════
	section("6 a closed month shows as settled");
	await safely("§6", async () => {
		const april = { from: "2026-04-01", to: "2026-04-30" };
		const before = bodyOf(await overview(W, april));
		const paid = W.sheet[0]["  Payment  "];
		W.sheet[0]["  Payment  "] = "$5,500.00";
		const after = bodyOf(await overview(W, april));
		W.sheet[0]["  Payment  "] = paid;
		check(before && after && before.period.basis === "settled" && JSON.stringify(after.fleet) === JSON.stringify(before.fleet) && JSON.stringify(after.trucks) === JSON.stringify(before.trucks),
			"April (closed): a sheet edit after the close moves no figure; basis settled", JSON.stringify(before && after && [before.fleet.revenue, after.fleet.revenue, after.period.basis]));
	});

	// ═════════════════════════ §7 pay % and paid days ═══════════════════════════
	section("7 pay % of revenue; paid days");
	await safely("§7", async () => {
		const june = bodyOf(await overview(W, { from: "2026-06-01", to: "2026-06-30" }));
		const dave = june && rowOf(june.drivers, "driver:dave driver");
		const fay = june && rowOf(june.drivers, "driver:fay fox");
		check(dave && c(dave.revenue) === 0 && dave.driverPayPct === null && dave.marginPct === null && c(dave.receipts) === 6000,
			"Dave (a June receipt, no June load): pay % of revenue is null, not 0; his $60 receipt is his", JSON.stringify(dave && [dave.revenue, dave.driverPayPct, dave.receipts]));
		check(fay && fay.paidDays === 2 && c(fay.costs.driverPay) === 56000 && fay.driverPayPct === 22.4 && june.fleet.paidDays === june.drivers.reduce((a, r) => a + r.paidDays, 0),
			"Fay: 2 paid days ($560 at $280), 22.4% of her $2,500; the fleet's paid days are the rows'", JSON.stringify(fay && [fay.paidDays, fay.costs.driverPay, fay.driverPayPct, june.fleet.paidDays]));
		const day = bodyOf(await overview(W, { from: "2026-06-04", to: "2026-06-04" }));
		const fayDay = day && rowOf(day.drivers, "driver:fay fox");
		check(fayDay && fayDay.paidDays === 1 && c(fayDay.costs.driverPay) === 28000, "Jun 4 alone: Fay has 1 paid day ($280), the one inside the period", JSON.stringify(fayDay && [fayDay.paidDays, fayDay.costs.driverPay]));
	});

	// ═════════════════════════ §8 presets and errors ════════════════════════════
	section("8 presets on the business day; bad periods");
	await safely("§8", async () => {
		const wrong = [];
		for (const key of financialsPresets.PRESET_KEYS.filter((k) => k !== "custom")) {
			const ov = bodyOf(await overview(W, { preset: key }));
			const want = financialsPresets.presetRange(key, "2026-07-10");
			if (!ov || ov.period.from !== want.from || ov.period.to !== want.to || ov.period.preset !== key || ov.period.label !== financialsPresets.presetLabel(key)) wrong.push(key);
		}
		check(wrong.length === 0, "every preset resolves on Fri Jul 10, 2026 to lib/financials-presets.js's dates, with its label", wrong.join(", "));
		setClock("2026-07-11T03:30:00Z"); // Fri Jul 10, 11:30 PM EDT: already Saturday in UTC
		const late = bodyOf(await overview(W, { preset: "lastWeek" }));
		setClock("2026-07-10T17:00:00Z");
		check(late && late.period.from === "2026-06-27" && late.period.to === "2026-07-03", "at 11:30 PM ET on a Friday it is still Friday: Last week is Jun 27 - Jul 3", JSON.stringify(late && late.period));
		const plain = bodyOf(await overview(W, {}));
		check(plain && plain.period.preset === "last12" && plain.period.from === "2025-08-01" && plain.period.to === "2026-07-10", "nothing sent: the last 12 months", JSON.stringify(plain && plain.period));
		const custom = bodyOf(await overview(W, { from: "2026-05-03", to: "2026-06-09" }));
		check(custom && custom.period.preset === "custom" && custom.period.label === "Custom", "from and to: a custom period", JSON.stringify(custom && custom.period));
		for (const [q, why] of [[{ preset: "planet" }, "an unknown preset"], [{ preset: ["lastMonth", "ytd"] }, "a preset sent twice"], [{ from: "2026-02-31", to: "2026-03-31" }, "a day that does not exist"],
			[{ from: "2026-06-01", to: "2026-05-01" }, "from after to"], [{ preset: "lastMonth", from: "2026-01-01" }, "a preset with dates"], [{ preset: "custom", from: "2026-01-01" }, "custom without to"],
			[{ from: "9999-01-01", to: "9999-12-31" }, "a year past the app's range"]]) {
			const r = await overview(W, q);
			const rc = await W.call("GET /api/financials/overview.csv", { query: q, session: { user: SUPER } }, { chain: true });
			check(r.status === 400 && r.body.code === "INVALID_REPORT_QUERY" && rc.status === 400, `${why}: 400 INVALID_REPORT_QUERY on both routes`, `${r.status} ${JSON.stringify(r.body)} ${rc.status}`);
		}
	});

	// ═════════════════════════ §11 the CSV, booked, pending ════════════════════
	section("11 the CSV; booked, not yet delivered; pending receipts");
	await safely("§11", async () => {
		const range = { from: "2026-05-01", to: "2026-06-30" };
		const ov = bodyOf(await overview(W, range));
		const csv = await W.call("GET /api/financials/overview.csv", { query: range, session: { user: SUPER } }, { chain: true });
		const lines = String(csv.body || "").trim().split(/\r?\n/);
		const totals = lines.filter((l) => l.startsWith('"Fleet total"'));
		check(csv.status === 200 && /text\/csv/.test(csv.headers["content-type"] || "") && /financials-overview-2026-05-01-to-2026-06-30\.csv/.test(csv.headers["content-disposition"] || "")
			&& lines.some((l) => l === '"By truck"') && lines.some((l) => l === '"By driver"') && totals.length === 2
			&& ov && totals.every((l) => l.split(",")[2] === `"${ov.fleet.revenue}"`),
			"CSV: the truck and driver tables, each ending in a Fleet total row with the fleet's revenue", `${csv.status} ${JSON.stringify(totals)}`);
		check(ov && ov.trucks.every((r) => lines.some((l) => l.startsWith(`"${r.label}",`))) && lines.some((l) => /Trucks, drivers and Fleet P&L agree to the cent/.test(l)),
			"CSV: every truck row is there, and the reconciliation line", JSON.stringify(lines.slice(0, 4)));
		const june = bodyOf(await overview(W, { from: "2026-06-01", to: "2026-06-30" }));
		check(june && june.bookedNotDelivered.count === 1 && june.bookedNotDelivered.amount === 1234 && c(june.fleet.revenue) === 250000 + 70000,
			"June: booked, not yet delivered is 1 load, $1,234, and it is not in revenue ($2,500 + $700 delivered)", JSON.stringify(june && [june.bookedNotDelivered, june.fleet.revenue]));
		check(june && june.pendingReceipts.count === 1 && june.pendingReceipts.amount === 80 && typeof june.pendingReceipts.knownLimit === "string" && /not from the books/.test(june.pendingReceipts.knownLimit),
			"June: the pending line (1 receipt, $80) carries its known limit (it reads the receipts table, not the books)", JSON.stringify(june && june.pendingReceipts));
		check(W.errors.length === 0, "the lifted code logged no error", W.errors.join(" | "));
	});

	// ═════════════════════════ §9 a Personal credit row ═════════════════════════
	section("9 a Personal credit row");
	await safely("§9", async () => {
		const P = buildWorld({ env: { FINANCIALS_OVERVIEW_ENABLED: "true", PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" } });
		await seed(P);
		const june = { from: "2026-06-01", to: "2026-06-30" };
		const april = { from: "2026-04-01", to: "2026-04-30" };
		const before = { june: bodyOf(await overview(P, june)), april: bodyOf(await overview(P, april)) };
		// Eve's April fuel receipt ($300, T5, load 8001), $120 of it marked Personal
		// after April closed: a -$120 credit in open June carrying its truck, driver and load.
		P.db.exec(require(path.join(ROOT, "lib", "personal-expense.js")).SCHEMA_SQL);
		const receipt = P.db.prepare("SELECT id FROM expenses WHERE load_id = '8001'").get();
		P.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
			VALUES (?, 'deduct', 12000, 30000, 'Made-up Fuel Stop', '2026-04-07', '2026-06', 0, '2026-06-10', '2026-06-06', '2026-06-10T15:00:00.000Z', 'super_admin', 1, 'Super Admin')`).run(receipt.id);
		const after = { june: bodyOf(await overview(P, june)), april: bodyOf(await overview(P, april)) };
		const delta = (rows0, rows1, key) => c((rowOf(rows1, key) || { costs: {} }).costs.fuel) - c((rowOf(rows0, key) || { costs: {} }).costs.fuel);
		const ok = before.june && after.june;
		const otherRowsMoved = ok ? after.june.trucks.filter((r) => r.key !== "truck:t5" && JSON.stringify(r) !== JSON.stringify(rowOf(before.june.trucks, r.key))).map((r) => r.key) : ["no overview"];
		check(ok && c(after.june.fleet.costs.fuel) - c(before.june.fleet.costs.fuel) === -12000 && delta(before.june.trucks, after.june.trucks, "truck:t5") === -12000
			&& delta(before.june.drivers, after.june.drivers, "driver:eve earner") === -12000 && otherRowsMoved.length === 0,
			"the -$120 credit lands in June's fuel on the fleet, on T5's row and on Eve's row, equally; no other truck row moves",
			JSON.stringify(ok && { fleet: [before.june.fleet.costs.fuel, after.june.fleet.costs.fuel], t5: delta(before.june.trucks, after.june.trucks, "truck:t5"), eve: delta(before.june.drivers, after.june.drivers, "driver:eve earner"), otherRowsMoved }));
		check(ok && after.april && JSON.stringify(after.april.fleet) === JSON.stringify(before.april.fleet) && after.june.reconciliation.ok && sumGaps(after.june.trucks, after.june.fleet).length === 0
			&& pnlGaps(after.june, await fleetPnl(P, june)).length === 0,
			"…closed April is as it was; June's rows add up and equal Fleet P&L", JSON.stringify(ok && { april: after.april && after.april.fleet.costs.fuel, checks: briefChecks(after.june) }));
		check(P.errors.length === 0, "…the lifted code logged no error", P.errors.join(" | "));
	});

	// ═════════════════════════ §10 the flags that move the books ════════════════
	section("10 flags that move the books: the overview follows Fleet P&L");
	await safely("§10", async () => {
		const ON = { FINANCIALS_OVERVIEW_ENABLED: "true" };
		const same = async (w, range, label) => {
			const ov = bodyOf(await overview(w, range));
			const pnl = await fleetPnl(w, range);
			check(ov && pnlGaps(ov, pnl).length === 0 && sumGaps(ov.trucks, ov.fleet).length === 0 && sumGaps(ov.drivers, ov.fleet).length === 0 && ov.reconciliation.ok,
				`${label}: the overview equals Fleet P&L, its rows add up, and the checks agree`, JSON.stringify(ov && { pnl: pnlGaps(ov, pnl), trucks: sumGaps(ov.trucks, ov.fleet), checks: failedChecks(ov) }));
			check(w.errors.length === 0, `${label}: the lifted code logged no error`, w.errors.join(" | "));
			return ov;
		};

		// PAYOUT_RULES_V2: a receipt dated after the day it was submitted counts in
		// the month it was submitted (futureReceipts).
		const v2World = async (env) => {
			const w = buildWorld({ env: { ...ON, ...env } });
			const { expense } = await seed(w);
			expense.run("2026-07-09T20:00:00.000Z", D, "Fuel", 75, "2026-08-02", "Approved", 0, "C1", "", "");
			return w;
		};
		// A whole July: an August-dated receipt counted in July is placed on Jul 31.
		const julyWhole = { from: "2026-07-01", to: "2026-07-31" };
		const v2off = await same(await v2World({}), julyWhole, "PAYOUT_RULES_V2 off");
		const v2on = await same(await v2World({ PAYOUT_RULES_V2_ENABLED: "true" }), julyWhole, "PAYOUT_RULES_V2 on");
		check(v2off && v2on && c(v2on.fleet.costs.fuel) - c(v2off.fleet.costs.fuel) === 7500,
			"…the rule moves a figure: on, July carries the $75 receipt dated in August", JSON.stringify(v2off && v2on && [v2off.fleet.costs.fuel, v2on.fleet.costs.fuel]));

		// TRUCK_CHARGE_APP_DAY: a company truck with no in-service date added at
		// 9:15 PM EDT on Jul 31 starts on that business day, so July carries its
		// costs (a company load in July: a month with no activity carries none).
		const truckWorld = async (env) => {
			const sheet = baseSheet();
			sheet.push(load("8031", D, "7/6/2026", "7/7/2026 8:00", "7/7/2026 18:00", "$900.00", "C1", "0"));
			const w = buildWorld({ env: { ...ON, ...env }, sheet });
			await seed(w);
			w.db.prepare("INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, insurance_monthly, eld_monthly, driver_pay_daily) VALUES (7, 'T7', 0, 'Active', '', '2026-08-01 01:15:00', 900, 50, 240)").run();
			setClock("2026-08-20T17:00:00Z");
			return w;
		};
		const tOff = await same(await truckWorld({}), julyWhole, "TRUCK_CHARGE_APP_DAY off");
		const tOn = await same(await truckWorld({ TRUCK_CHARGE_APP_DAY_ENABLED: "true", TRUCK_CHARGE_APP_DAY_FROM: "2026-07" }), julyWhole, "TRUCK_CHARGE_APP_DAY on (FROM 2026-07)");
		setClock("2026-07-10T17:00:00Z");
		check(tOff && tOn && c(tOn.fleet.costs.fixedCosts) - c(tOff.fleet.costs.fixedCosts) === 95000 && rowOf(tOn.trucks, "truck:t7") && !rowOf(tOff.trucks, "truck:t7"),
			"…the rule moves a figure: on, July carries T7's $950 of fixed costs, on a T7 row", JSON.stringify(tOff && tOn && [tOff.fleet.costs.fixedCosts, tOn.fleet.costs.fixedCosts]));

		// LEDGER_DAY_ONCE: a June load whose window starts on a day closed May
		// already paid; from June on, that day is paid once.
		const dayOnceWorld = async (env) => {
			const sheet = baseSheet();
			sheet.push(load("8030", E, "6/1/2026", "5/7/2026 8:00", "6/1/2026 10:00", "$900.00", "T5", "5"));
			const w = buildWorld({ env: { ...ON, ...env }, sheet });
			await seed(w);
			return w;
		};
		const juneWhole = { from: "2026-06-01", to: "2026-06-30" };
		const dOff = await same(await dayOnceWorld({}), juneWhole, "LEDGER_DAY_ONCE off");
		const dOn = await same(await dayOnceWorld({ LEDGER_DAY_ONCE_ENABLED: "true", LEDGER_DAY_ONCE_FROM: "2026-06" }), juneWhole, "LEDGER_DAY_ONCE on (FROM 2026-06)");
		check(dOff && dOn && c(dOn.fleet.costs.driverPay) < c(dOff.fleet.costs.driverPay),
			"…the rule moves a figure: on, June pays less driver pay (the day closed May already paid)", JSON.stringify(dOff && dOn && [dOff.fleet.costs.driverPay, dOn.fleet.costs.driverPay]));
	});

	// ═════════════════════════ §12 each check can fail ══════════════════════════
	// Pure: lib/financials-overview.js on tiny made-up reports, doctored so each
	// check meets a mismatch it must report.
	section("12 each check reports a mismatch (pure, doctored inputs)");
	await safely("§12", async () => {
		if (!financialsOverview) { check(false, "lib/financials-overview.js loads", "not found"); return; }
		const items = [
			{ kind: "revenue", month: "2026-05", day: "2026-05-10", cents: 100000, loadId: "9000", driver: "pat sample", truck: "X1", basis: "settled" },
			{ kind: "revenue", month: "2026-06", day: "2026-06-04", cents: 250000, loadId: "9001", driver: "pat sample", truck: "X1", basis: "live" },
			{ kind: "revenue", month: "2026-06", day: "2026-06-12", cents: 120000, loadId: "9002", driver: "lee example", truck: "X2", basis: "live" },
			{ kind: "trip", expenseType: "Fuel", month: "2026-06", day: "2026-06-05", cents: 8000, driver: "pat sample", truck: "X1", basis: "live" },
			{ kind: "fixed", month: "2026-06", day: null, cents: 90000, truck: "X1", basis: "live" },
		];
		const ctx = {
			truckOf: (i) => i.truck || "", truckLabel: (t) => t, loadKey: (id) => String(id), loadOf: () => null,
			driverKey: (n) => String(n).trim().toLowerCase(), driverLabel: (k) => k, ownerLabel: () => "Company",
		};
		const rep = (groupBy) => financialsReport.buildReport({ items, from: "2026-05-01", to: "2026-06-30", granularity: "month", groupBy,
			settingsFor: () => financialsReport.DEFAULT_SETTINGS, milesOf: () => null, ctx });
		const input = (change = {}) => ({
			preset: "custom", from: "2026-05-01", to: "2026-06-30",
			fleetReport: { ...rep("fleet"), closedMonths: ["2026-05"], pendingReceipts: { count: 0, amount: 0, oldestDays: null }, overlaps: 0 },
			truckReport: rep("truck"), driverReport: rep("driver"), loadReport: rep("load"),
			items, driverKey: ctx.driverKey, lockedPeriods: new Set(["2026-05"]), frozenSummaries: new Map(),
			bookedNotDelivered: { count: 0, amount: 0 }, generatedAt: "2026-07-10T17:00:00.000Z",
			...change,
		});
		const run = (change) => financialsOverview.buildOverview(input(change));
		const find = (ov, chk, scope, part) => ov.reconciliation.checks.find((x) => x.check === chk && x.scope === scope && (part === undefined || x.part === part)) || null;
		const diffOf = (x, line) => (x ? x.differences.find((d) => d.line === line) || null : null);
		const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

		const clean = run();
		check(clean.reconciliation.ok === true && clean.reconciliation.checks.every((x) => x.status === "ok" || x.status === "skipped"),
			"the undoctored inputs agree (ok)", briefChecks(clean));

		const base = input();
		const noX2 = run({ truckReport: { ...base.truckReport, groups: base.truckReport.groups.filter((g) => g.key !== "truck:x2") } });
		const a = find(noX2, "a", "trucks");
		check(noX2.reconciliation.ok === false && a && a.status === "failed" && same(diffOf(a, "revenue"), { line: "revenue", expectedCents: 470000, actualCents: 350000, diffCents: -120000 }),
			"(a) a truck row dropped (X2's $1,200): failed, revenue expected 470000 actual 350000 (−120000 cents), ok false", JSON.stringify(a));
		const noLee = run({ driverReport: { ...base.driverReport, groups: base.driverReport.groups.filter((g) => g.key !== "driver:lee example") } });
		const b = find(noLee, "b", "drivers");
		check(noLee.reconciliation.ok === false && b && b.status === "failed" && same(diffOf(b, "revenue"), { line: "revenue", expectedCents: 470000, actualCents: 350000, diffCents: -120000 }),
			"(b) a driver row dropped: failed with the exact difference, ok false", JSON.stringify(b));

		const extra = run({ items: [...items, { kind: "trip", expenseType: "Toll", month: "2026-06", day: "2026-06-06", cents: 1500, truck: "X1", basis: "live" }] });
		const cJune = find(extra, "c", "2026-06");
		const dJune = find(extra, "d", "2026-06", "ledger figures");
		check(extra.reconciliation.ok === false && cJune && cJune.status === "failed" && same(cJune.differences, [{ line: "tolls", expectedCents: 1500, actualCents: 0, diffCents: -1500 }]),
			"(c) a June item the report never placed ($15 of tolls): failed, tolls −1500 cents", JSON.stringify(cJune));
		check(dJune && dJune.status === "failed" && same(dJune.differences, [{ line: "tripExpenses", expectedCents: 9500, actualCents: 8000, diffCents: -1500 }]),
			"(d) open June's lines against the ledger's figures: failed (not a note), tripExpenses −1500 cents", JSON.stringify(dJune));

		const summary = (revenue, fixed, trip) => ({ revenue, driverPay: 0, fixedCosts: fixed, tripExpenses: trip, maintFundCost: 0, complianceCost: 0 });
		const openOff = run({ frozenSummaries: new Map([["2026-06", summary(3800, 900, 80)]]) });
		const dOpen = find(openOff, "d", "2026-06", "recorded summary");
		check(openOff.reconciliation.ok === false && dOpen && dOpen.status === "failed" && !dOpen.note
			&& same(dOpen.differences, [{ line: "revenue", expectedCents: 380000, actualCents: 370000, diffCents: -10000 }]),
			"(d) an open month whose recorded summary is $100 off: failed, ok false", JSON.stringify(dOpen));
		const closedOff = run({ frozenSummaries: new Map([["2026-05", summary(1100, 0, 0)]]) });
		const dClosed = find(closedOff, "d", "2026-05", "recorded summary");
		check(closedOff.reconciliation.ok === true && dClosed && dClosed.status === "note" && dClosed.note === "as settled"
			&& same(dClosed.differences, [{ line: "revenue", expectedCents: 110000, actualCents: 100000, diffCents: -10000 }]),
			"(d) the same difference in closed May: an \"as settled\" note, ok true", JSON.stringify(dClosed));

		const rows = financialsOverview.overviewRows(noX2);
		check(rows.some((r) => r[0] === "Reconciliation" && /^Mismatch/.test(r[1])) && rows.some((r) => r[0] === "(a) trucks" && r[1] === "revenue" && r[2] === 4700 && r[3] === 3500 && r[4] === -1200),
			"CSV: a mismatch prints \"Mismatch\" and each failed row with both amounts and the difference", JSON.stringify(rows.filter((r) => /Reconciliation|^\(a\)/.test(String(r[0])))));
	});

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => die(`crashed: ${e.stack || e.message}`));
