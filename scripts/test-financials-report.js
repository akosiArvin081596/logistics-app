#!/usr/bin/env node
/**
 * Financials reports: periods, groupings, cost settings and the export.
 *
 * Part 1, the pure builder (lib/financials-report.js): the house week runs
 * Saturday to Friday; periods are clipped to the range; a month's costs are
 * spread over its days without losing a cent; a load's driver days outside its
 * Assigned month stay in that month; every grouping (truck, driver, load,
 * pickup state, delivery state, owner) adds up to the fleet; a cost line that is
 * switched off is reported but not counted; a Settlement adjustment is folded
 * into the line it corrects and reported beside the margin.
 *
 * Part 2, the routes on the books fixture of test-financials-books.js (two
 * investors and a company truck, April and May closed the old way and frozen):
 * GET /api/financials/report by truck, driver, load and state, each adding up
 * to the fleet and the fleet to the books; weeks add up to their month; a
 * closed month shows exactly what it settled at; PUT /api/financials/settings
 * switches overhead on for open months only (a closed month keeps the
 * settings it closed with); the CSV carries the same figures; bad queries 400.
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-financials-report.js    # exits 1 on failure
 */
"use strict";

process.env.TZ = "UTC"; // production's clock zone

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function die(msg) { console.error(`SETUP FAILED: ${msg}`); process.exit(1); }

let Database;
try { Database = require("better-sqlite3"); } catch (e) { die(`better-sqlite3 did not load (${e.message}); run npm ci under the .nvmrc Node`); }
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

const CONSTS = ["PAYOUT_RULES_V2_ENABLED", "PAYOUT_RULE_KEYS", "FINANCIALS_GRANULARITIES", "FINANCIALS_GROUPINGS", "haulAssignmentsStmt", "LEDGER_ITEM_COLS", "EXPENSE_PNL_FILTER", "EXPENSE_PERIOD_EXPR", "CANCELED_STATUS_RE", "RFC2822_MONTHS", "PERIOD_FINALIZE_ENABLED",
	"INVESTOR_LEASE_PAYOUTS_ENABLED", "INVESTOR_LEASE_SETTINGS", "LEASE_SNAPSHOT_WARNED", "LOCKABLE_MONTH_KEY",
	"LOCK_PERIOD_MIN_YEAR", "LOCK_PERIOD_MAX_YEAR", "insertPayoutHistory"];
const LETS = ["lastPayStructShadowWarnMs", "_jtEpoch"];
const FNS = [
	// Under test.
	"reconcileInvestorPayouts", "computeInvestorMonthlyEarnings", "gatherLedgerScopeFacts", "payoutRules", "ledgerLoadRows", "getInvestorDriverSet", "assignDriverToTruck",
	"syncOpenCarrierPairing", "finalizePeriods",
	// What they call, shipped as is.
	"driverNameHeldByOtherSpelling", "driverNameHeldByOtherAccount", "findDriverNameClashes", "normalizeDriverName",
	"isBuiltInPropertyName", "driverNameForTotals", "findCol", "pickAddressColumn", "excludeDroppedLoads",
	"getDeletedLoadIds", "loadKeySet", "moneySheetDate", "houstonDay", "getAllExcludedDriverDays",
	"getDriverPayStructures", "getDeductibleExpensesByDriverMonth", "expenseDriverKey", "resolveDailyRate",
	"getInvestorDriverMonthWindows", "investorExpenseScopeSql", "assignmentMonthKey", "intersectMonthWindow",
	"truckChargeFromMonth", "truckChargeUntilMonth", "truckChargedInMonth", "truckMonthlyFixed",
	"computeLossCarryForward", "resolveInvestorSplitPct", "lastFridayOfFollowingMonth", "periodLabel",
	"payoutRowBreakdown", "frozenPayoutBreakdown", "payoutBasisContext", "isLocked", "periodLockStmt",
	"periodLocksReadable", "periodWriteLocked", "todayKeyCT", "currentMonthKeyCT", "settlementGraceDays",
	"graceEndsAt", "periodPhase", "isPlausibleLockPeriod", "getCarrierDBFromSQLite", "recordPayoutChange",
	"noteLateItemInClosedMonth", "logAudit", "listSettlableInvestors", "installPeriodLockTriggers",
	"closingFingerprint", "closedMonthFreezePlan", "financialsReportQuery", "buildFinancialsReport", "pendingReceiptsInPeriod", "getLoadMilesIndex", "buildHaulTruckResolver", "auditText", "scrubPurgeMarker", "closingLedgerItems", "financialsSettings", "financialsExtraItems", "closedMonthSettings", "computeFleetLedger", "settledMonthItems", "ambiguousBlankOwnerLoads", "buildHeldTruckIndex", "frozenPeriodSet", "settledPayoutRows", "writeLedgerFreeze", "ledgerItemFromRow", "buildFinancialsLedger", "completedLoadCancelRefusal", "loadRowAccountingMonths", "sheetCellMonths", "sheetCellDate",
];
const REOPEN_HEAD = 'app.post("/api/periods/:period/reopen", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const FREEZE_HEAD = 'app.post("/api/admin/financials/freeze-closed-months", requireRole("Super Admin"), refuseCrossOrigin, async (req, res) => {';
const REPORT_HEAD = 'app.get("/api/financials/report", requireRole("Super Admin"), async (req, res) => {';
const CSV_HEAD = 'app.get("/api/financials/report.csv", requireRole("Super Admin"), async (req, res) => {';
const SETTINGS_PUT_HEAD = 'app.put("/api/financials/settings", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const ADJUST_HEAD = 'app.put("/api/investor/payouts/:id/adjust", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const BODY = [
	...CONSTS.map((c) => liftDecl("const", c)),
	...LETS.map((c) => liftDecl("let", c)),
	...FNS.map(liftFn),
	liftRoute(REOPEN_HEAD),
	liftRoute(ADJUST_HEAD),
	liftRoute(FREEZE_HEAD),
	liftRoute(REPORT_HEAD),
	liftRoute(CSV_HEAD),
	liftRoute(SETTINGS_PUT_HEAD),
	"return { reconcileInvestorPayouts, computeInvestorMonthlyEarnings, getInvestorDriverSet, assignDriverToTruck, finalizePeriods, getCarrierDBFromSQLite, installPeriodLockTriggers, computeFleetLedger, buildFinancialsLedger, pendingReceiptsInPeriod };",
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
const load = (id, driver, assigned, pickup, dropoff, pay, truck, owner) => ({
	"Contract ID": "", "Load ID": id, Details: "Dry van", Driver: driver, "Pickup Address": "", "Pickup Appointment": pickup,
	"Drop-off Address": "", "Drop-off Appointment": dropoff, "Job Status": "Delivered", "  Payment  ": pay,
	"Broker Contact Name": "", "Assigned Date": assigned, "Status Update Date": "", Truck: truck, "Owner ID": owner,
});
const D = "Dave Driver";
const E = "Eve Earner";
const F = "Fay Fox";
const SHEET = [
	load("8001", E, "4/6/2026", "4/7/2026 8:00", "4/8/2026 10:00", "$5,000.00", "T5", "5"),
	load("8002", F, "4/10/2026", "4/11/2026 8:00", "4/12/2026 10:00", "$4,000.00", "T6", "6"),
	load("8003", D, "4/15/2026", "4/16/2026 8:00", "4/16/2026 18:00", "$2,000.00", "C1", "0"),
	load("8004", E, "5/5/2026", "5/6/2026 8:00", "5/7/2026 10:00", "$3,000.00", "T5", "5"),
	load("8005", D, "5/20/2026", "5/21/2026 8:00", "5/21/2026 18:00", "$1,500.00", "C1", ""),
	load("8006", F, "6/3/2026", "6/4/2026 8:00", "6/5/2026 10:00", "$2,500.00", "T6", "6"),
];

function buildWorld({ onSheetRead = null } = {}) {
	const db = new Database(":memory:");
	for (const sql of DDL) {
		try { db.exec(sql); } catch (e) { if (!/duplicate column name/.test(e.message)) die(`DDL failed: ${e.message}\n${sql.slice(0, 120)}`); }
	}
	const warnings = [];
	const errors = [];
	const routes = {};
	const refusals = [];
	const notices = [];
	const deps = {
		db, investorPayoutBasis, normalizeLoadId, financialsCalc, financialsReport, Date: Clock,
		app: {
			post: (p, ...h) => { routes[`POST ${p}`] = h[h.length - 1]; },
			put: (p, ...h) => { routes[`PUT ${p}`] = h[h.length - 1]; },
			get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; },
		},
		logAuditRefusal: (req, action, entity, entityId, details, code) => refusals.push({ action, entityId: String(entityId), code }),
		requireRole: () => (req, res, next) => next && next(),
		refuseCrossOrigin: (req, res, next) => next && next(),
		getJobTrackingCached: async () => {
			if (onSheetRead) onSheetRead(db);
			return { headers: [...HEADERS], data: SHEET.map((r, i) => ({ _rowIndex: i + 2, ...r })) };
		},
		getEldTravelDaysByVehicleCached: () => Object.create(null),
		// Each load's pickup in TX and delivery in OK, except 8002 (OK to TX).
		resolveCityState: (r, which, lid) => (String(lid) === "8002") === (which === "pickup") ? "Tulsa, OK 74103" : "Dallas, TX 75201",
		loadMilesLib: require(path.join(ROOT, "lib", "load-miles.js")),
		loadHaul: require(path.join(ROOT, "lib", "load-haul.js")),
		csvRows: require(path.join(ROOT, "lib", "csv.js")).csvRows,
		notifyChange: () => {},
		insertDispatchNotification: { run: (type, title, body) => notices.push({ type, title, body }) },
		process: { env: {} },
		console: { log() {}, warn: (m) => warnings.push(String(m)), error: (...a) => errors.push(a.map(String).join(" ")) },
		crypto: require("crypto"),
	};
	let api;
	try {
		api = new Function(...Object.keys(deps), `"use strict";\n${BODY}`)(...Object.values(deps));
	} catch (e) { die(`lifted code did not assemble: ${e.message}`); }
	api.installPeriodLockTriggers(db);
	async function call(route, req) {
		const out = { status: 200, body: null };
		const res = {
			headers: {},
			status(c) { out.status = c; return res; },
			json(b) { out.body = JSON.parse(JSON.stringify(b)); return res; },
			setHeader(k, v) { res.headers[k.toLowerCase()] = v; out.headers = res.headers; },
			send(b) { out.body = b; return res; },
		};
		await routes[route](req, res);
		return out;
	}
	return { db, api, warnings, errors, call, refusals, notices };
}

const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const R = financialsReport;

(async () => {
	// ═══════════════════════════════ Part 1: the pure builder ══════════════════
	check(R.weekStart("2026-10-02") === "2026-09-26" && R.weekStart("2026-10-03") === "2026-10-03" && R.weekStart("2026-09-27") === "2026-09-26",
		"the house week starts on Saturday (Fri 10-02 → Sat 09-26; Sat 10-03 is its own start)", [R.weekStart("2026-10-02"), R.weekStart("2026-10-03")].join(" "));
	const months = R.periodsBetween("2026-03-15", "2026-05-10", "month");
	check(JSON.stringify(months.map((p) => [p.key, p.from, p.to])) === JSON.stringify([["2026-03", "2026-03-15", "2026-03-31"], ["2026-04", "2026-04-01", "2026-04-30"], ["2026-05", "2026-05-01", "2026-05-10"]]),
		"months are clipped to the range", JSON.stringify(months));
	const quarters = R.periodsBetween("2026-01-01", "2026-12-31", "quarter").map((p) => p.key);
	check(JSON.stringify(quarters) === JSON.stringify(["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"]), "quarters", JSON.stringify(quarters));
	const split = R.splitCents(-1001, 3);
	check(split.reduce((a, b) => a + b, 0) === -1001 && JSON.stringify(split) === JSON.stringify([-334, -334, -333]), "a split adds back to the whole, negatives too", JSON.stringify(split));
	const spread = R.placements({ kind: "fixed", month: "2026-03", day: null, cents: 310001 });
	check(spread.length === 31 && spread.reduce((a, p) => a + p.cents, 0) === 310001, "a month's cost is spread over its 31 days without losing a cent", `${spread.length} days`);
	check(JSON.stringify(R.placements({ kind: "driver_pay", month: "2026-09", day: "2026-10-02", cents: 25000 })) === JSON.stringify([{ day: "2026-09-30", cents: 25000 }]),
		"a load's driver day after its Assigned month stays in that month (on its last day)", "");

	const ctx = {
		truckOf: (i) => i.truck || "",
		truckLabel: (t) => t,
		loadKey: (id) => String(id).replace(/^#/, ""),
		loadOf: (lk) => ({ L1: { state: { pickup: "TX", delivery: "OK" }, truck: "T1", driver: "ann" }, L2: { state: { pickup: "OK", delivery: "TX" }, truck: "T2", driver: "bob" } }[lk] || null),
		driverKey: (name) => String(name).trim().toLowerCase(),
		driverLabel: (k) => k.toUpperCase(),
		ownerLabel: (id) => (id ? `Owner ${id}` : "Company"),
	};
	const items = [
		{ kind: "revenue", month: "2026-06", day: "2026-06-03", cents: 500000, loadId: "#L1", driver: "ann", truck: "T1", ownerId: 5, basis: "live" },
		{ kind: "revenue", month: "2026-06", day: "2026-06-20", cents: 300000, loadId: "L2", driver: "bob", truck: "T2", ownerId: 0, basis: "live" },
		{ kind: "driver_pay", month: "2026-06", day: "2026-06-04", cents: 30000, loadId: "L1", driver: "ann", truck: "T1", ownerId: 5, basis: "live" },
		{ kind: "trip", month: "2026-06", day: "2026-06-04", cents: 12000, expenseType: "Fuel", loadId: "L1", driver: "Ann ", truck: "T1", ownerId: 5, basis: "live" },
		{ kind: "trip", month: "2026-06", day: "2026-06-21", cents: 4000, expenseType: "Toll", loadId: "", driver: "bob", truck: "T2", ownerId: 0, basis: "live" },
		{ kind: "fixed", month: "2026-06", day: null, cents: 300000, truck: "T1", ownerId: 5, basis: "live" },
		{ kind: "maint_reserve", month: "2026-06", day: null, cents: 90000, truck: "T1", ownerId: 5, basis: "live" },
		{ kind: "settlement_adjustment", adjusts: "revenue", month: "2026-06", day: null, cents: -10000, ownerId: 5, basis: "settled" },
	];
	const settings = R.normalizeSettings(null);
	const rep = (groupBy, granularity = "month") => R.buildReport({ items, from: "2026-06-01", to: "2026-06-30", granularity, groupBy,
		settingsFor: () => settings, milesOf: (lk) => ({ L1: { miles: 400, source: "eld" }, L2: { miles: 300, source: "ratecon" } }[lk] || null), ctx });
	const fleet = rep("fleet").total;
	check(fleet.revenue === 7900 && fleet.totalCosts === 3460 && fleet.margin === 4440 && fleet.costs.maintenanceReserve === 900,
		"fleet: revenue includes its Settlement adjustment ($8,000 − $100); the reserve (off) is reported, not counted",
		JSON.stringify({ revenue: fleet.revenue, totalCosts: fleet.totalCosts, margin: fleet.margin, reserve: fleet.costs.maintenanceReserve }));
	check(fleet.settlementAdjustment === -100 && fleet.costs.fuel === 120 && fleet.costs.tolls === 40 && fleet.loads === 2 && fleet.miles === 700 && fleet.revenuePerMile === 11.29,
		"fleet: settlement −$100 reported beside the margin; fuel and tolls by receipt type; 2 loads, 700 mi, $11.29/mi", JSON.stringify(fleet));
	for (const g of ["truck", "driver", "load", "pickupState", "deliveryState", "owner"]) {
		const r = rep(g);
		const sum = (k) => Math.round(r.groups.reduce((a, x) => a + x.total[k] * 100, 0));
		check(sum("revenue") === Math.round(fleet.revenue * 100) && sum("totalCosts") === Math.round(fleet.totalCosts * 100),
			`by ${g}: the groups add up to the fleet`, JSON.stringify(r.groups.map((x) => [x.label, x.total.revenue, x.total.totalCosts])));
	}
	const byDriver = rep("driver").groups;
	const ann = byDriver.filter((x) => x.label === "ANN");
	check(ann.length === 1 && ann[0].total.revenue === 5000 && ann[0].total.costs.driverPay === 300 && ann[0].total.costs.fuel === 120,
		"by driver: one row per driver, its loads, pay and receipts together (a receipt typed 'Ann ' is ann's)", JSON.stringify(byDriver.map((x) => [x.key, x.total.revenue, x.total.costs.fuel])));
	const byOwner = rep("owner").groups;
	check(byOwner.find((x) => x.key === "owner:5").total.revenue === 4900 && !byOwner.some((x) => x.key === "settlement_adjustment"),
		"by owner: an owner's Settlement adjustment is part of its figures ($5,000 − $100), not a row of its own", JSON.stringify(byOwner.map((x) => [x.key, x.total.revenue])));
	const { csvCell } = require("../lib/csv.js");
	check(csvCell(-2000) === '"-2000"' && csvCell(-12.5) === '"-12.5"' && csvCell("-2+3") === `"'-2+3"` && csvCell("=1+1") === `"'=1+1"`,
		"CSV: a negative number stays a number; text that could be a formula is still guarded", [csvCell(-2000), csvCell("-2+3")].join(" "));
	const byLoad = rep("load");
	const l1 = byLoad.groups.find((x) => x.key === "load:L1");
	check(l1 && l1.total.revenue === 5000 && l1.total.totalCosts === 420 && l1.total.miles === 400 && l1.load.pickupState === "TX",
		"by load: load L1 ('#L1' and 'L1' are one load) carries its revenue, its fuel and its driver day; 400 mi; picked up in TX", JSON.stringify(l1));
	check(byLoad.groups.some((x) => x.key === "unallocated:t1" && x.total.totalCosts === 3000) && byLoad.groups.some((x) => x.key === "settlement_adjustment"),
		"by load: T1's fixed costs are an Unallocated line for T1; the Settlement adjustment is its own line", JSON.stringify(byLoad.groups.map((x) => x.key)));
	const byState = rep("pickupState");
	check(byState.groups.find((x) => x.key === "state:TX").total.revenue === 5000 && byState.groups.find((x) => x.key === "state:OK").total.revenue === 3000,
		"by pickup state: TX $5,000, OK $3,000", JSON.stringify(byState.groups.map((x) => [x.key, x.total.revenue])));
	const weeks = rep("fleet", "week");
	const weekSum = Object.values(weeks.totalByPeriod).reduce((a, f) => a + Math.round(f.totalCosts * 100), 0);
	check(weekSum === Math.round(fleet.totalCosts * 100), "by week: the weeks add up to the month's costs, spread costs included", `${weekSum} vs ${fleet.totalCosts * 100}`);
	const on = R.normalizeSettings({ costs: { maintenanceReserve: true } });
	const withReserve = R.buildReport({ items, from: "2026-06-01", to: "2026-06-30", granularity: "month", groupBy: "fleet", settingsFor: () => on, milesOf: () => null, ctx }).total;
	check(withReserve.totalCosts === 4360, "switched on, the reserve counts in total costs ($3,460 + $900)", String(withReserve.totalCosts));
	const rows = R.reportRows(rep("truck"), { groupLabel: "Truck" });
	check(rows[0][0] === "Period" && rows[0][1] === "Truck" && rows[rows.length - 1][1] === "All" && rows[rows.length - 1][3] === 7900, "the CSV rows: header, each group, the fleet total", JSON.stringify(rows[rows.length - 1]));

	// ═══════════════════════════════ Part 2: the routes ═════════════════════════
	const W = buildWorld();
	const { db, api, call } = W;
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
	db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng, distance_miles) VALUES ('8001', 32.7, -96.8, 36.1, -95.9, 260), ('8002', 36.1, -95.9, 32.7, -96.8, 255)").run();

	setClock("2026-07-10T17:00:00Z");
	const ctxPay = () => ({ sessionUser: SUPER, carrierDB: api.getCarrierDBFromSQLite(), globalConfig: { investor_split_pct: "50" } });
	for (const owner of [5, 6]) await api.reconcileInvestorPayouts(owner, ctxPay());
	await api.finalizePeriods(["2026-04", "2026-05"], "system");
	const report = async (query) => call("GET /api/financials/report", { query, session: { user: SUPER } });
	const range = { from: "2026-04-01", to: "2026-06-30" };
	const fleetR = await report({ ...range, groupBy: "fleet" });
	check(fleetR.status === 200 && JSON.stringify(fleetR.body.periods.map((p) => [p.key, p.basis])) === JSON.stringify([["2026-04", "settled"], ["2026-05", "settled"], ["2026-06", "live"]]),
		"report: April and May settled, June live", `${fleetR.status} ${JSON.stringify(fleetR.body.periods || fleetR.body)}`);
	const books = financialsCalc.monthFiguresFromItems((await api.buildFinancialsLedger()).items);
	const gaps = ["2026-04", "2026-05", "2026-06"].filter((mk) => {
		const f = fleetR.body.totalByPeriod[mk];
		const b = books[mk];
		const ledgerCosts = Math.round((b.driverPay + b.fixedCosts + b.tripExpenses + b.maintFundCost + b.complianceCost) * 100);
		return Math.round(f.revenue * 100) !== Math.round(b.revenue * 100) || Math.round(f.totalCosts * 100) !== ledgerCosts;
	});
	check(gaps.length === 0, "report: each month's revenue and costs are the books' (default settings = the payout ledger's lines)", gaps.join(", "));
	for (const groupBy of ["truck", "driver", "load", "pickupState", "deliveryState", "owner"]) {
		const r = await report({ ...range, groupBy });
		const sum = (k) => Math.round(r.body.groups.reduce((a, g) => a + g.total[k] * 100, 0));
		check(r.status === 200 && sum("revenue") === Math.round(fleetR.body.total.revenue * 100) && sum("totalCosts") === Math.round(fleetR.body.total.totalCosts * 100),
			`report by ${groupBy}: the groups add up to the fleet`, `${r.status} revenue ${sum("revenue")} vs ${Math.round(fleetR.body.total.revenue * 100)}`);
	}
	const byTruck = (await report({ ...range, groupBy: "truck" })).body;
	check(JSON.stringify(byTruck.groups.map((g) => g.label).sort()) === JSON.stringify(["C1", "Investor payouts", "T5", "T6"]),
		"report by truck: T5, T6, the company's C1, and the investor payouts as their own line", JSON.stringify(byTruck.groups.map((g) => g.label)));
	const payouts = byTruck.groups.find((g) => g.key === "investor_payouts");
	check(payouts.total.costs.investorPayouts > 0 && payouts.total.totalCosts === 0, "…the payouts line is reported but, switched off, not counted in margin", JSON.stringify(payouts.total));
	const byLoadR = (await report({ ...range, groupBy: "load" })).body;
	const l8001 = byLoadR.groups.find((g) => g.key === "load:8001");
	check(l8001 && l8001.total.revenue === 5000 && l8001.total.costs.fuel === 300 && l8001.total.miles === 260 && l8001.load.milesSource === "road" && l8001.load.pickupState === "TX",
		"report by load: 8001 has its $5,000, its $300 fuel, 260 road miles, picked up in TX", JSON.stringify(l8001));
	const byPickup = (await report({ ...range, groupBy: "pickupState" })).body;
	check(byPickup.groups.some((g) => g.key === "state:OK" && g.total.revenue === 4000), "report by pickup state: OK holds 8002's $4,000", JSON.stringify(byPickup.groups.map((g) => [g.key, g.total.revenue])));
	const weeksR = (await report({ from: "2026-06-01", to: "2026-06-30", granularity: "week" })).body;
	const juneR = (await report({ from: "2026-06-01", to: "2026-06-30" })).body;
	const weekCosts = Object.values(weeksR.totalByPeriod).reduce((a, f) => a + Math.round(f.totalCosts * 100), 0);
	check(weekCosts === Math.round(juneR.total.totalCosts * 100) && weeksR.periods[0].key === "2026-05-30", "report by week: Saturday weeks, adding up to June", `${weekCosts} vs ${juneR.total.totalCosts * 100}, first ${weeksR.periods[0].key}`);
	check(fleetR.body.pendingReceipts.count === 1 && fleetR.body.pendingReceipts.amount === 80, "report: the Pending receipt is on its own line (1 receipt, $80)", JSON.stringify(fleetR.body.pendingReceipts));
	const pendingJune = api.pendingReceiptsInPeriod("2026-06");
	check(pendingJune.length === 1 && pendingJune[0].amount === 80 && api.pendingReceiptsInPeriod("2026-05").length === 0,
		"close: the receipts still Pending review in a month are what its close lists (June: one)", JSON.stringify(pendingJune));

	// Settings: overhead on, open months only.
	const put = await call("PUT /api/financials/settings", { body: { costs: { overhead: true }, overheadMonthly: 1000 }, session: { user: SUPER } });
	const after = (await report({ ...range, groupBy: "fleet" })).body;
	const oh = (mk) => after.totalByPeriod[mk].costs.overhead;
	check(put.status === 200 && oh("2026-06") === 1000 && oh("2026-04") === 0 && oh("2026-05") === 0
		&& Math.round(after.totalByPeriod["2026-06"].totalCosts * 100) === Math.round(fleetR.body.totalByPeriod["2026-06"].totalCosts * 100) + 100000
		&& Math.round(after.totalByPeriod["2026-04"].totalCosts * 100) === Math.round(fleetR.body.totalByPeriod["2026-04"].totalCosts * 100),
		"settings: overhead switched on counts in open June; closed April and May keep the settings they closed with", JSON.stringify({ status: put.status, jun: oh("2026-06"), apr: oh("2026-04") }));
	const audit = db.prepare("SELECT details FROM audit_trail WHERE action = 'update_financials_settings'").all();
	check(audit.length === 1 && /overhead: off → on/.test(audit[0].details), "settings: the change is audited", JSON.stringify(audit));
	const before = (await report({ from: "2025-01-01", to: "2026-06-30", granularity: "year" })).body;
	check(before.totalByPeriod["2026"].costs.overhead === 1000 && !(before.totalByPeriod["2025"] && before.totalByPeriod["2025"].costs.overhead),
		"settings: no overhead before the books' first month (April): none in 2025 or January–March, and in 2026 only open June's $1,000",
		JSON.stringify(Object.fromEntries(Object.entries(before.totalByPeriod).map(([k, f]) => [k, f.costs.overhead]))));
	const ahead = (await report({ from: "2026-06-01", to: "2026-09-30" })).body;
	const aheadOh = ["2026-07", "2026-08", "2026-09"].map((mk) => (ahead.totalByPeriod[mk] ? ahead.totalByPeriod[mk].costs.overhead : 0));
	check(JSON.stringify(aheadOh) === JSON.stringify([1000, 0, 0]) && ahead.total.costs.overhead === 2000,
		"settings: a range running past this month adds no overhead to the months still to come", JSON.stringify(aheadOh));
	await call("PUT /api/financials/settings", { body: { costs: { depreciation: true } }, session: { user: SUPER } });
	const depJune = async () => (await report({ from: "2026-06-01", to: "2026-06-30" })).body.total.costs.depreciation;
	const inService = await depJune();
	db.prepare("UPDATE trucks SET in_service_date = '2020-01-01' WHERE id = 1").run();
	const pastYears = await depJune();
	db.prepare("UPDATE trucks SET in_service_date = '2026-04-01' WHERE id = 1").run();
	check(inService === 2000 && pastYears === 0, "depreciation: $120,000 over 5 years is $2,000 a month, and stops once those years have run",
		JSON.stringify({ inService, pastYears }));
	const pendingLater = (await report({ from: "2026-06-05", to: "2026-06-30" })).body.pendingReceipts;
	check(pendingLater.count === 0 && pendingLater.amount === 0, "report: a Pending receipt dated before the range is not listed as counted in it", JSON.stringify(pendingLater));
	// A close with optional lines on freezes them, and a later settings change
	// leaves the closed month as it closed.
	const settingsPut = (body) => call("PUT /api/financials/settings", { body, session: { user: SUPER } });
	const juneShown = async () => (await report({ from: "2026-06-01", to: "2026-06-30" })).body.total;
	const juneOpen = await juneShown();
	await api.finalizePeriods(["2026-06"], "system");
	await settingsPut({ costs: { depreciation: false, overhead: false } });
	const juneClosed = await juneShown();
	check(juneOpen.costs.depreciation === 2000 && juneOpen.costs.overhead === 1000 && juneClosed.costs.depreciation === 2000 && juneClosed.costs.overhead === 1000
		&& Math.round(juneClosed.totalCosts * 100) === Math.round(juneOpen.totalCosts * 100),
		"close: June closed with depreciation and overhead on keeps them, counted, after both are switched off",
		JSON.stringify({ open: juneOpen.costs, closed: juneClosed.costs }));
	// Fractional depreciation years run whole months: 2.3 years is 28 months.
	await settingsPut({ costs: { depreciation: true }, depreciationYears: 2.3 });
	const julyDep = (await report({ from: "2026-07-01", to: "2026-07-31" })).body.total.costs.depreciation;
	check(julyDep === 4285.71, "depreciation: 2.3 years charges $120,000 over 28 whole months ($4,285.71)", String(julyDep));
	// A truck whose owner is not a settlable investor: its lines are the company's.
	db.prepare("INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, maintenance_fund_monthly) VALUES (4, 'X9', 9, 'Active', '2026-04-01', '2026-04-01 00:00:00', 100)").run();
	await settingsPut({ costs: { maintenanceReserve: true } });
	const julyOwners = (await report({ from: "2026-07-01", to: "2026-07-31", groupBy: "owner" })).body.groups;
	const companyJuly = julyOwners.find((g) => g.key === "owner:0");
	check(!julyOwners.some((g) => g.key === "owner:9") && companyJuly && companyJuly.total.costs.maintenanceReserve >= 100,
		"by owner: a truck whose owner is not a settlable investor books its reserve to the company, as the ledger books its fixed costs",
		JSON.stringify(julyOwners.map((g) => [g.key, g.total.costs.maintenanceReserve])));
	const bad = await call("PUT /api/financials/settings", { body: { costs: { overhead: "yes" } }, session: { user: SUPER } });
	check(bad.status === 400, "settings: a value that is not true or false is refused", `${bad.status}`);

	// The export, and bad queries.
	const csv = await call("GET /api/financials/report.csv", { query: { ...range, groupBy: "truck" }, session: { user: SUPER } });
	const lines = String(csv.body || "").trim().split(/\r?\n/);
	check(csv.status === 200 && /text\/csv/.test(csv.headers["content-type"]) && /^"?Period"?,"?Truck"?,"?Basis"?,"?Revenue"?/.test(lines[0]) && lines.length > 3,
		"export: a CSV with the report's columns", `${csv.status} ${lines[0]}`);
	for (const [q, why] of [[{ from: "2026-13-01" }, "a bad date"], [{ granularity: "hour" }, "an unknown granularity"], [{ groupBy: "planet" }, "an unknown grouping"], [{ from: "2026-06-01", to: "2026-05-01" }, "from after to"],
		[{ from: "9999-12-01", to: "9999-12-31" }, "a year past 2100"], [{ from: "2026-02-31", to: "2026-03-31" }, "a day that does not exist"]]) {
		const r = await report(q);
		check(r.status === 400 && r.body.code === "INVALID_REPORT_QUERY", `report: ${why} answers 400`, `${r.status}`);
	}
	check(W.errors.length === 0, "the lifted code logged no error", W.errors.join(" | "));
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => die(`crashed: ${e.stack || e.message}`));
