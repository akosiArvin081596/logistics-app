#!/usr/bin/env node
/**
 * Financials' books: one calculation with the payout ledger, closed months as
 * settled, and the one-time freeze of months closed before freezing existed.
 *
 * Fleet: two investors (5 and 6, one truck each) and a company truck (C1,
 * owner 0) whose driver's loads carry Owner ID "0" or blank. Asserted:
 *   - every investor scope of computeFleetLedger() equals that investor's
 *     payout ledger (computeInvestorMonthlyEarnings()) month by month, to the
 *     cent; the company scope holds the company truck's loads, receipt and
 *     fixed costs; the fleet's books are the sum of the scopes;
 *   - April and May closed the old way (rows stamped, months locked, no frozen
 *     items), then a load and a receipt changed: Financials still shows each
 *     closed investor-month exactly as it settled, through "Settlement
 *     adjustment" lines, and the company's lines as they stand;
 *   - the one-time freeze: a dry run writes nothing and returns a fingerprint;
 *     a wrong fingerprint is refused (409 FREEZE_PLAN_CHANGED); the right one
 *     freezes both months without changing any figure Financials shows, logs a
 *     system audit row per month, and a second run freezes nothing;
 *   - frozen items: a later change to the sheet no longer moves a closed month;
 *     the triggers refuse an update, a delete, and a second freeze;
 *   - reopen releases the month's items, and the next close freezes it again;
 *   - a month's figures do not change when it closes (June: live the moment
 *     before the close, frozen after);
 *   - a month frozen with no items stays frozen; the freeze lists a closed
 *     month's blank-Owner-ID load that today's driver sets count for a different
 *     owner than the one whose truck its driver held then, and leaves that month
 *     out unless included on purpose, as it does a month holding an
 *     investor-month settled without a breakdown; a paid row's month
 *     re-closed after a reopen keeps the breakdown it settled at; and a failure
 *     in Financials' freeze never holds up the payout close.
 *
 * The shipped code runs, lifted out of server.js, on an in-memory SQLite built
 * from server.js's own DDL. Stubbed: the clock, the Job Tracking sheet read and
 * the ELD travel-day index (no truck is ELD-linked).
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-financials-books.js    # exits 1 on failure
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

const CONSTS = ["PAYOUT_RULES_V2_ENABLED", "PAYOUT_RULE_KEYS", "PRE_DISPATCH_PAY_DAY_RULE_ENABLED", "haulAssignmentsStmt", "LEDGER_ITEM_COLS", "EXPENSE_PNL_FILTER", "EXPENSE_PERIOD_EXPR", "CANCELED_STATUS_RE", "RFC2822_MONTHS", "PERIOD_FINALIZE_ENABLED",
	"INVESTOR_LEASE_PAYOUTS_ENABLED", "INVESTOR_LEASE_SETTINGS", "LEASE_SNAPSHOT_WARNED", "LOCKABLE_MONTH_KEY",
	"LOCK_PERIOD_MIN_YEAR", "LOCK_PERIOD_MAX_YEAR", "insertPayoutHistory", "FINANCIALS_GRANULARITIES", "FINANCIALS_GROUPINGS"];
const LETS = ["lastPayStructShadowWarnMs", "_jtEpoch"];
const FNS = [
	// Under test.
	"reconcileInvestorPayouts", "computeInvestorMonthlyEarnings", "gatherLedgerScopeFacts", "payoutRules", "ledgerLoadRows", "getInvestorDriverSet", "assignDriverToTruck",
	"syncOpenCarrierPairing", "finalizePeriods",
	// What they call, shipped as is.
	"driverNameHeldByOtherSpelling", "driverNameHeldByOtherAccount", "findDriverNameClashes", "normalizeDriverName",
	"isBuiltInPropertyName", "driverNameForTotals", "findCol", "pickAddressColumn", "excludeDroppedLoads",
	"getDeletedLoadIds", "loadKeySet", "moneySheetDate", "appDay", "getAllExcludedDriverDays", "preDispatchPayDayFilter",
	"getDriverPayStructures", "getDeductibleExpensesByDriverMonth", "expenseDriverKey", "resolveDailyRate",
	"getInvestorDriverMonthWindows", "investorExpenseScopeSql", "assignmentMonthKey", "intersectMonthWindow",
	"truckChargeFromMonth", "truckChargeUntilMonth", "truckChargedInMonth", "truckMonthlyFixed",
	"computeLossCarryForward", "resolveInvestorSplitPct", "lastFridayOfFollowingMonth", "periodLabel",
	"payoutRowBreakdown", "frozenPayoutBreakdown", "payoutBasisContext", "isLocked", "periodLockStmt",
	"periodLocksReadable", "periodWriteLocked", "appTodayKey", "appMonthKey", "settlementGraceDays",
	"graceEndsAt", "periodPhase", "isPlausibleLockPeriod", "getCarrierDBFromSQLite", "recordPayoutChange",
	"noteLateItemInClosedMonth", "logAudit", "listSettlableInvestors", "installPeriodLockTriggers",
	"closingFingerprint", "closedMonthFreezePlan", "closingLedgerItems", "financialsSettings", "financialsExtraItems", "closedMonthSettings", "computeFleetLedger", "settledMonthItems", "ambiguousBlankOwnerLoads", "buildHeldTruckIndex", "appNoonMs", "buildHaulTruckResolver", "frozenPeriodSet", "settledPayoutRows", "writeLedgerFreeze", "ledgerItemFromRow", "buildFinancialsLedger", "completedLoadCancelRefusal", "loadRowAccountingMonths", "sheetCellMonths", "sheetCellDate",
	// GET /api/financials and the report it reads.
	"financialsReportQuery", "buildFinancialsReport", "getLoadMilesIndex", "liveJobTrackingView",
];
const REOPEN_HEAD = 'app.post("/api/periods/:period/reopen", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const FREEZE_HEAD = 'app.post("/api/admin/financials/freeze-closed-months", requireRole("Super Admin"), refuseCrossOrigin, async (req, res) => {';
const ADJUST_HEAD = 'app.put("/api/investor/payouts/:id/adjust", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const FINANCIALS_HEAD = 'app.get("/api/financials", requireRole("Super Admin"), async (req, res) => {';
const BODY = [
	...CONSTS.map((c) => liftDecl("const", c)),
	...LETS.map((c) => liftDecl("let", c)),
	...FNS.map(liftFn),
	liftRoute(REOPEN_HEAD),
	liftRoute(ADJUST_HEAD),
	liftRoute(FREEZE_HEAD),
	liftRoute(FINANCIALS_HEAD),
	"return { reconcileInvestorPayouts, computeInvestorMonthlyEarnings, getInvestorDriverSet, assignDriverToTruck, finalizePeriods, getCarrierDBFromSQLite, installPeriodLockTriggers, computeFleetLedger, buildFinancialsLedger };",
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
	tableDdl("invoices"), ...alters("invoices"),
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

const W_FAIL = { states: false };
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
		appTime: require("../lib/app-time.js"), APP_TIMEZONE: require("../lib/app-time.js").appTimeZone(),
		db, investorPayoutBasis, normalizeLoadId, financialsCalc, financialsReport, loadPayDays: require("../lib/load-pay-days.js"), loadHaul: require(path.join(__dirname, "..", "lib", "load-haul.js")), Date: Clock,
		app: {
			post: (p, ...h) => { routes[`POST ${p}`] = h[h.length - 1]; },
			put: (p, ...h) => { routes[`PUT ${p}`] = h[h.length - 1]; },
			get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; },
		},
		loadMilesLib: require(path.join(__dirname, "..", "lib", "load-miles.js")),
		logAuditRefusal: (req, action, entity, entityId, details, code) => refusals.push({ action, entityId: String(entityId), code }),
		requireRole: () => (req, res, next) => next && next(),
		refuseCrossOrigin: (req, res, next) => next && next(),
		getJobTrackingCached: async () => {
			if (onSheetRead) onSheetRead(db);
			return { headers: [...HEADERS], data: SHEET.map((r, i) => ({ _rowIndex: i + 2, ...r })) };
		},
		getEldTravelDaysByVehicleCached: () => Object.create(null),
		resolveCityState: () => { if (W_FAIL.states) throw new Error("address lookup failed"); return ""; },
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
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = JSON.parse(JSON.stringify(b)); return res; } };
		await routes[route](req, res);
		return out;
	}
	return { db, api, warnings, errors, call, refusals, notices };
}

const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const FIGS = ["revenue", "driverPay", "fixedCosts", "tripExpenses", "maintFundCost", "complianceCost", "netProfit"];
const c = (v) => Math.round(Number(v || 0) * 100);
const sameFigures = (a, b) => FIGS.every((k) => c(a && a[k]) === c(b && b[k]));
const show = (f) => (f ? FIGS.map((k) => `${k} ${c(f[k])}`).join(", ") : "none");

(async () => {
	const W = buildWorld();
	const { db, api, call } = W;
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (?, ?, 'x', ?, ?)");
	user.run(1, "super_admin", "Super Admin", "");
	user.run(5, "inv5", "Investor", "Acme Carrier");
	user.run(6, "inv6", "Investor", "Beta Haul");
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	const truck = db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, insurance_monthly,
		eld_monthly, truck_payment_monthly, hvut_annual, irp_annual, driver_pay_daily) VALUES (?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, ?)`);
	truck.run(1, "T5", 5, "2026-04-01", "2026-04-01 00:00:00", 1000, 50, 1500, 600, 1200, 300);
	truck.run(2, "T6", 6, "2026-04-01", "2026-04-01 00:00:00", 800, 40, 0, 0, 0, 280);
	truck.run(3, "C1", 0, "2026-04-01", "2026-04-01 00:00:00", 600, 50, 0, 0, 0, 260);
	const dir = db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_daily) VALUES (?, ?, 'fixed', 0)");
	dir.run(E, "Acme Carrier");
	dir.run(F, "Beta Haul");
	dir.run(D, "");
	setClock("2026-04-01T17:00:00Z");
	api.assignDriverToTruck(1, E);
	api.assignDriverToTruck(2, F);
	api.assignDriverToTruck(3, D);
	const expense = db.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, status, owner_id, truck_unit, posted_period, load_id) VALUES (?, ?, ?, ?, ?, 'Approved', ?, ?, ?, ?)");
	expense.run("2026-04-07T20:00:00.000Z", E, "Fuel", 300, "2026-04-07", 5, "T5", "", "8001");
	expense.run("2026-04-15T20:00:00.000Z", D, "Fuel", 100, "2026-04-15", 0, "C1", "", "8003");
	expense.run("2026-05-05T20:00:00.000Z", F, "Toll", 50, "2026-05-05", 6, "T6", "", "");

	setClock("2026-07-10T17:00:00Z");
	const ctx = () => ({ sessionUser: SUPER, carrierDB: api.getCarrierDBFromSQLite(), globalConfig: { investor_split_pct: "50" } });
	const ledgerOf = async (owner) => {
		const carrier = api.getCarrierDBFromSQLite();
		const set = api.getInvestorDriverSet(owner, carrier.data, "Driver", "Carrier Name");
		const r = await api.computeInvestorMonthlyEarnings({ user: { ...SUPER, id: owner }, isSuperAdmin: false, investorDriverSet: set, investorOwnerId: owner, config: { investor_split_pct: "50" } });
		return Object.fromEntries(r.monthlyEarnings.map((m) => [m.month, m.exact]));
	};
	const books = async () => {
		const b = await api.buildFinancialsLedger();
		return { ...b, figures: financialsCalc.monthFiguresFromItems(b.items) };
	};

	// ── one calculation: scopes, the ledger, the fleet ────────────────────────
	const fleet = await api.computeFleetLedger();
	for (const owner of [5, 6]) {
		const ledger = await ledgerOf(owner);
		const scope = fleet.scopes.find((s) => s.ownerId === owner);
		const fromItems = financialsCalc.monthFiguresFromItems(scope.items);
		const gaps = Object.keys(ledger).filter((mk) => !sameFigures(fromItems[mk] || {}, ledger[mk])).map((mk) => `${mk}: books ${show(fromItems[mk])} / ledger ${show(ledger[mk])}`);
		check(gaps.length === 0, `owner ${owner}'s scope is its payout ledger, month by month, to the cent`, gaps.join(" | "));
	}
	const company = fleet.scopes.find((s) => s.ownerId === 0);
	const companyRevenue = company.items.filter((i) => i.kind === "revenue").map((i) => i.loadId).sort();
	check(JSON.stringify(companyRevenue) === JSON.stringify(["8003", "8005"]), "the company scope holds the company truck's loads (Owner ID 0 and blank)", JSON.stringify(companyRevenue));
	check(company.items.some((i) => i.kind === "trip" && i.cents === 10000) && company.items.some((i) => i.kind === "fixed" && i.truck === "C1"),
		"…and its receipt and the company truck's fixed costs", JSON.stringify(company.items.filter((i) => i.kind !== "revenue").map((i) => [i.kind, i.month, i.cents, i.truck])));
	const open = await books();
	const sumScopes = financialsCalc.monthFiguresFromItems(fleet.scopes.flatMap((s) => s.items));
	const fleetGaps = Object.keys(sumScopes).filter((mk) => !sameFigures(open.figures[mk], sumScopes[mk]));
	check(fleetGaps.length === 0, "with no month closed, the books are the sum of the scopes", fleetGaps.join(", "));

	// ── April and May closed the old way: rows stamped, months locked, no items ─
	for (const owner of [5, 6]) {
		const { payouts } = await api.reconcileInvestorPayouts(owner, ctx());
		for (const p of payouts.filter((x) => x.period === "2026-04" || x.period === "2026-05")) {
			db.prepare("UPDATE investor_payouts SET finalized_at = ?, finalized_amount = amount, finalized_breakdown = ? WHERE id = ?")
				.run("2026-06-08T05:00:00.000Z", JSON.stringify({ ...p.breakdown, lossCarriedIn: p.lossCarriedIn, lossDeferred: p.lossDeferred }), p.id);
		}
	}
	const settledBreakdown = (owner, period) => JSON.parse(db.prepare("SELECT finalized_breakdown AS b FROM investor_payouts WHERE owner_id = ? AND period = ?").get(owner, period).b);
	// Owner 6's May row settled before breakdowns were recorded (no breakdown).
	db.prepare("UPDATE investor_payouts SET finalized_breakdown = '' WHERE owner_id = 6 AND period = '2026-05'").run();
	db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-03', 'locked', '2026-06-08T05:00:00.000Z', 'baseline'), ('2026-04', 'locked', '2026-06-08T05:00:00.000Z', 'baseline'), ('2026-05', 'locked', '2026-06-08T05:00:00.000Z', 'baseline')").run();
	const companyApril = financialsCalc.monthFiguresFromItems(company.items)["2026-04"];

	// After the close, D moves onto owner 5's truck (undone after the check). D's
	// May load 8005 (blank Owner ID, driven on company truck C1) is now in owner
	// 5's driver set, so the dry run lists it for review.
	db.exec("SAVEPOINT driver_moved");
	setClock("2026-07-05T17:00:00Z");
	api.assignDriverToTruck(1, D);
	setClock("2026-07-10T17:00:00Z");
	const movedDry = await call("POST /api/admin/financials/freeze-closed-months", { body: {}, session: { user: SUPER } });
	const movedMay = (movedDry.body.periods || []).find((p) => p.period === "2026-05");
	const ambiguous = movedMay ? movedMay.ambiguousLoads : [];
	check(ambiguous.length === 1 && ambiguous[0].loadId === "8005" && ambiguous[0].countedFor === 5 && ambiguous[0].truckHeldBy === 0 && ambiguous[0].amount === 1500,
		"freeze: a closed month's blank-Owner-ID load that today's driver sets count for another owner than the truck its driver held then is listed for review",
		JSON.stringify(ambiguous));
	// Only the assignment history changes now (D held T5 on May 21, backdated):
	// the items stay as they are, the review list does not, and so does the
	// fingerprint, so the earlier dry run's fingerprint no longer applies.
	db.prepare("UPDATE truck_assignments SET end_date = '2026-05-01T05:00:00.000Z' WHERE truck_id = 3 AND LOWER(driver_name) = LOWER(?)").run(D);
	db.prepare("UPDATE truck_assignments SET start_date = '2026-05-01T05:00:00.000Z' WHERE truck_id = 1 AND LOWER(driver_name) = LOWER(?) AND end_date = ''").run(D);
	const backdated = await call("POST /api/admin/financials/freeze-closed-months", { body: {}, session: { user: SUPER } });
	const backdatedMay = (backdated.body.periods || []).find((p) => p.period === "2026-05");
	const stale = await call("POST /api/admin/financials/freeze-closed-months", { body: { apply: true, fingerprint: movedDry.body.fingerprint }, session: { user: SUPER } });
	check(backdatedMay && backdatedMay.itemCount === movedMay.itemCount && backdatedMay.ambiguousLoads.length === 0 && backdated.body.fingerprint !== movedDry.body.fingerprint
		&& stale.status === 409 && stale.body.code === "FREEZE_PLAN_CHANGED" && Array.isArray(stale.body.periods),
		"freeze: when only the review list changes, so does the fingerprint, and the earlier one is refused (409, with the current plan)",
		JSON.stringify({ items: [movedMay.itemCount, backdatedMay && backdatedMay.itemCount], ambiguous: backdatedMay && backdatedMay.ambiguousLoads, status: stale.status }));
	db.exec("ROLLBACK TO driver_moved; RELEASE driver_moved");

	// After the close: April's load corrected in the sheet, a receipt for April logged.
	SHEET[0]["  Payment  "] = "$5,500.00";
	expense.run("2026-07-10T17:00:00.000Z", E, "Repair", 200, "2026-04-20", 5, "T5", "", "");
	const before = await books();
	const settledApril = (owner) => settledBreakdown(owner, "2026-04");
	const aprilInvestors = (b) => {
		const out = {};
		for (const owner of [5, 6]) out[owner] = financialsCalc.monthFiguresFromItems(b.items.filter((i) => i.ownerId === owner))["2026-04"];
		return out;
	};
	const ai = aprilInvestors(before);
	check(sameFigures(ai[5], settledApril(5)) && sameFigures(ai[6], settledApril(6)),
		"closed April, before any freeze: each investor-month reads exactly as it settled (the load and receipt changed after)",
		`owner 5 ${show(ai[5])} vs settled ${show(settledApril(5))}`);
	const adj = before.items.filter((i) => i.kind === "settlement_adjustment" && i.month === "2026-04");
	check(adj.length === 2 && adj.some((i) => i.ownerId === 5 && i.adjusts === "revenue" && i.cents === -50000) && adj.some((i) => i.ownerId === 5 && i.adjusts === "trip" && i.cents === -20000),
		"…through Settlement adjustment lines (revenue −$500, trip −$200 for owner 5)", JSON.stringify(adj));
	check(before.items.filter((i) => i.month === "2026-04").every((i) => i.basis === "settled"), "…every April item is labelled settled", "");

	// ── GET /api/financials: the per-truck table, the leaderboard and the drill-
	// down come from the books, for the selected period ───────────────────────
	const fin = async (query) => call("GET /api/financials", { query, session: { user: SUPER } });
	const sumC = (rows, k) => rows.reduce((a, r) => a + c(r[k]), 0);
	const aprBooks = before.figures["2026-04"];
	const aprFin = (await fin({ month: "2026-04" })).body;
	check(aprFin.summary.from === "2026-04-01" && aprFin.summary.to === "2026-04-30" && c(aprFin.summary.totalRevenue) === c(aprBooks.revenue)
		&& sumC(aprFin.perTruck, "gross") === c(aprBooks.revenue) && sumC(aprFin.drivers, "grossRevenue") === c(aprBooks.revenue)
		&& aprFin.perTruck.some((r) => r.isSettlementAdjustment && c(r.gross) === -50000),
		"financials: April's per-truck table and leaderboard are the books for April, each adding up to its revenue (the Settlement adjustment as its own row)",
		JSON.stringify({ summary: aprFin.summary.totalRevenue, books: aprBooks.revenue, trucks: aprFin.perTruck.map((r) => [r.unitNumber, r.gross]), drivers: aprFin.drivers.map((r) => [r.name, r.grossRevenue]) }));
	const aprMay = (await fin({ from: "2026-04-01", to: "2026-05-31" })).body;
	check(c(aprMay.summary.totalRevenue) === c(aprBooks.revenue) + c(before.figures["2026-05"].revenue) && sumC(aprMay.perTruck, "gross") === c(aprMay.summary.totalRevenue),
		"financials: a from–to period covers its months (April and May)", JSON.stringify(aprMay.summary));
	const allFin = (await fin({})).body;
	const lastBooksMonth = before.months[before.months.length - 1];
	const lastBooksDay = `${lastBooksMonth}-${String(new Date(Date.UTC(Number(lastBooksMonth.slice(0, 4)), Number(lastBooksMonth.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`;
	check(allFin.summary.from === `${before.months[0]}-01` && allFin.summary.to === lastBooksDay
		&& c(allFin.summary.totalRevenue) === before.months.reduce((a, mk) => a + c((before.figures[mk] || {}).revenue), 0)
		&& c(allFin.summary.totalExpenses) === allFin.monthlyPerformance.reduce((a, m) => a + c(m.totalExpenses), 0),
		"financials: with no period, every month the books hold, whole (revenue and costs add up to the monthly rows)",
		JSON.stringify([allFin.summary.from, allFin.summary.to, allFin.summary.totalRevenue, allFin.summary.totalExpenses]));
	// The Financials cost settings (overhead on, fuel off) belong to the report
	// page; this endpoint stays on the ledger's lines.
	const shape = (b) => JSON.stringify([b.summary, b.perTruck, b.drivers, b.expensesByCategory]);
	const plain = { june: (await fin({ month: "2026-06" })).body, all: (await fin({})).body };
	db.prepare("INSERT INTO app_settings (key, value) VALUES ('financials.settings', ?)").run(JSON.stringify({ costs: { overhead: true, fuel: false }, overheadMonthly: 2000 }));
	const withSettings = { june: (await fin({ month: "2026-06" })).body, all: (await fin({})).body };
	db.prepare("DELETE FROM app_settings WHERE key = 'financials.settings'").run();
	check(shape(withSettings.june) === shape(plain.june) && shape(withSettings.all) === shape(plain.all),
		"financials: the cost settings (overhead on, fuel off) do not move it, open June or the whole books (one basis, the books')",
		JSON.stringify({ june: [plain.june.summary.totalExpenses, withSettings.june.summary.totalExpenses], all: [plain.all.summary.totalExpenses, withSettings.all.summary.totalExpenses] }));
	const badFin = await fin({ from: "2026-05-01", to: "2026-04-01" });
	check(badFin.status === 400 && badFin.body.code === "INVALID_REPORT_QUERY", "financials: a bad period answers 400", `${badFin.status}`);
	const md = aprFin.monthDetail;
	const catSum = Object.values(md.expenseCategories).reduce((a, v) => a + c(v), 0);
	check(c(md.settlementAdjustment.revenue) === -50000 && c(md.settlementAdjustment.costs) === -20000 && c(md.settlementAdjustment.byFigure.tripExpenses) === -20000
		&& catSum + c(md.settlementAdjustment.costs) === c(md.summary.totalExpenses) && md.basis === "settled",
		"drill-down: closed April shows its Settlement adjustment line (revenue −$500, receipts −$200); the categories plus that line are its expenses",
		JSON.stringify({ adj: md.settlementAdjustment, catSum, total: md.summary.totalExpenses }));
	check(sumC(md.drivers, "pay") === c(md.summary.driverPay) && sumC(md.drivers, "revenue") === c(md.summary.revenue)
		&& md.drivers.some((d) => d.isSettlementAdjustment && c(d.revenue) === -50000),
		"drill-down: the driver rows, with a Settlement adjustment row, add up to the month's revenue and driver pay",
		JSON.stringify(md.drivers.map((d) => [d.name, d.pay, d.revenue])));
	const companyAprilBefore = financialsCalc.monthFiguresFromItems(before.items.filter((i) => i.ownerId === 0))["2026-04"];
	check(sameFigures(companyAprilBefore, companyApril), "…and the company's April lines as they stand", `${show(companyAprilBefore)} vs ${show(companyApril)}`);

	// ── the one-time freeze ───────────────────────────────────────────────────
	const freeze = (body) => call("POST /api/admin/financials/freeze-closed-months", { body, session: { user: SUPER } });
	const itemsCount = () => db.prepare("SELECT COUNT(*) AS n FROM financials_ledger_items").get().n;
	check(/PERIOD_FINALIZED/.test((() => { try { db.prepare("INSERT INTO financials_ledger_items (period, owner_id, kind, cents, freeze_id, frozen_at) VALUES ('2026-04', 0, 'revenue', 100, 'made-up', 'x')").run(); return ""; } catch (e) { return e.message; } })()),
		"closed, not yet frozen: an item that comes from no active freeze of the month is refused", "");
	const dry = await freeze({});
	const plannedMay = (dry.body.periods || []).find((p) => p.period === "2026-05");
	check(dry.status === 200 && dry.body.dryRun === true && JSON.stringify(dry.body.periods.map((p) => p.period)) === JSON.stringify(["2026-03", "2026-04", "2026-05"]) && itemsCount() === 0,
		"freeze: the dry run plans March (empty), April and May and writes nothing", `${dry.status} ${JSON.stringify(dry.body).slice(0, 300)}`);
	check(plannedMay && plannedMay.unverifiedOwners.length === 1 && plannedMay.unverifiedOwners[0].ownerId === 6 && "settledPayout" in plannedMay.unverifiedOwners[0],
		"freeze: May lists owner 6, settled before breakdowns were recorded, with its settled payout", JSON.stringify(plannedMay && plannedMay.unverifiedOwners));
	check(dry.body.periods.every((p) => p.ambiguousLoads.length === 0), "freeze: with the driver back on the company truck, no load is listed as ambiguous", JSON.stringify(dry.body.periods.map((p) => p.ambiguousLoads)));
	const wrong = await freeze({ apply: true, fingerprint: "0".repeat(64) });
	check(wrong.status === 409 && wrong.body.code === "FREEZE_PLAN_CHANGED" && itemsCount() === 0, "freeze: a fingerprint that is not the plan's is refused, nothing written", `${wrong.status} ${JSON.stringify(wrong.body)}`);
	const applied = await freeze({ apply: true, fingerprint: dry.body.fingerprint });
	check(applied.status === 200 && JSON.stringify(applied.body.frozenPeriods) === JSON.stringify(["2026-03", "2026-04"]) && JSON.stringify(applied.body.leftForReview) === JSON.stringify(["2026-05"]),
		"freeze: the fingerprint freezes March and April; May (no breakdown for owner 6) is left for review", `${applied.status} ${JSON.stringify(applied.body)}`);
	const skippedAudit = db.prepare("SELECT username, entity_id, details FROM audit_trail WHERE action = 'financials_freeze_skipped'").all();
	check(skippedAudit.length === 1 && skippedAudit[0].entity_id === "2026-05" && skippedAudit[0].username === "system" && /owner 6/.test(skippedAudit[0].details),
		"freeze: the month left for review is logged in the audit log, with why", JSON.stringify(skippedAudit));
	const dryMay = await freeze({});
	const otherMonth = await freeze({ apply: true, fingerprint: dryMay.body.fingerprint, includePeriods: ["2026-06"] });
	check(otherMonth.body.frozenPeriods.length === 0 && JSON.stringify(otherMonth.body.leftForReview) === JSON.stringify(["2026-05"]),
		"freeze: including another month does not include May", JSON.stringify(otherMonth.body));
	const appliedMay = await freeze({ apply: true, fingerprint: dryMay.body.fingerprint, includePeriods: ["2026-05"] });
	check(JSON.stringify(dryMay.body.periods.map((p) => p.period)) === JSON.stringify(["2026-05"]) && JSON.stringify(appliedMay.body.frozenPeriods) === JSON.stringify(["2026-05"]),
		"freeze: included on purpose (includePeriods), May freezes", `${JSON.stringify(dryMay.body.periods.map((p) => p.period))} ${JSON.stringify(appliedMay.body)}`);
	const after = await books();
	const moved = ["2026-04", "2026-05"].filter((mk) => !sameFigures(after.figures[mk], before.figures[mk]));
	check(moved.length === 0, "freeze: Financials shows exactly what it showed before the freeze", moved.map((mk) => `${mk}: ${show(before.figures[mk])} -> ${show(after.figures[mk])}`).join(" | "));
	const audits = db.prepare("SELECT username, entity_id, details FROM audit_trail WHERE action = 'financials_freeze' ORDER BY id").all();
	check(audits.length === 3 && audits.every((a) => a.username === "system" && /at the request of super_admin/.test(a.details)),
		"freeze: one system audit row per month, naming who asked", JSON.stringify(audits.map((a) => [a.username, a.entity_id])));
	const again = await freeze({});
	const reapplied = await freeze({ apply: true, fingerprint: again.body.fingerprint });
	check(again.body.periods.length === 0 && reapplied.status === 200 && reapplied.body.frozenPeriods.length === 0, "freeze: a second run plans and writes nothing", JSON.stringify([again.body, reapplied.body]));

	// ── a month frozen with no items stays frozen ─────────────────────────────
	SHEET.push(load("8007", E, "3/20/2026", "3/21/2026 8:00", "3/21/2026 18:00", "$777.00", "T5", "5"));
	const marchNow = financialsCalc.monthFiguresFromItems((await books()).items)["2026-03"];
	check(!marchNow || c(marchNow.revenue) === 0, "frozen with no items: a load added to closed March afterwards does not appear in it", show(marchNow));
	check(/PERIOD_FINALIZED/.test((() => { try { db.prepare("INSERT INTO financials_ledger_items (period, owner_id, kind, cents, freeze_id, frozen_at) VALUES ('2026-03', 0, 'revenue', 77700, 'another', 'x')").run(); return ""; } catch (e) { return e.message; } })()),
		"frozen with no items: an item from another freeze is refused", "");
	SHEET.pop();

	// ── frozen items hold ─────────────────────────────────────────────────────
	SHEET[3]["  Payment  "] = "$9,999.00"; // 8004, May
	const later = await books();
	check(sameFigures(later.figures["2026-05"], after.figures["2026-05"]), "frozen: a later sheet change does not move closed May", `${show(after.figures["2026-05"])} -> ${show(later.figures["2026-05"])}`);
	const refused = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
	check(/PERIOD_FINALIZED/.test(refused(() => db.prepare("UPDATE financials_ledger_items SET cents = cents + 1 WHERE period = '2026-04'").run())), "frozen: an UPDATE of a closed month's items is refused", "");
	check(/PERIOD_FINALIZED/.test(refused(() => db.prepare("DELETE FROM financials_ledger_items WHERE period = '2026-04'").run())), "frozen: a DELETE of a closed month's items is refused", "");
	check(/PERIOD_FINALIZED/.test(refused(() => db.prepare("INSERT INTO financials_ledger_items (period, owner_id, kind, cents, freeze_id, frozen_at) VALUES ('2026-04', 0, 'revenue', 1, 'another', 'x')").run())),
		"frozen: a second freeze of a closed month is refused", "");
	const aprFreezeId = db.prepare("SELECT freeze_id FROM financials_ledger_freezes WHERE period = '2026-04' AND released_at = ''").get().freeze_id;
	check(/PERIOD_FINALIZED/.test(refused(() => db.prepare("INSERT INTO financials_ledger_items (period, owner_id, kind, cents, freeze_id, frozen_at) VALUES ('2026-04', 0, 'revenue', 1, ?, 'x')").run(aprFreezeId))),
		"frozen: an item added under the month's own freeze once it holds all its items is refused", "");
	check(/PERIOD_FINALIZED/.test(refused(() => db.prepare("UPDATE financials_ledger_freezes SET released_at = 'x' WHERE period = '2026-04'").run())),
		"frozen: the row that marks a closed month frozen cannot be released outside a reopen", "");
	check(/PERIOD_FINALIZED/.test(refused(() => db.prepare("DELETE FROM financials_ledger_freezes WHERE period = '2026-04'").run())),
		"frozen: …or deleted", "");
	check(/PERIOD_FINALIZED/.test(refused(() => db.prepare("INSERT INTO financials_ledger_freezes (freeze_id, period, source, frozen_at, frozen_by, item_count, summary) VALUES ('another', '2026-04', 'test', 'x', 'test', 0, '{}')").run())),
		"frozen: …and a second freeze row for it is refused", "");

	// ── reopen releases, the next close freezes again ─────────────────────────
	const reopen = await call("POST /api/periods/:period/reopen", { params: { period: "2026-05" }, body: { reason: "corrected load 8004" }, session: { user: SUPER } });
	const mayItems = () => db.prepare("SELECT COUNT(*) AS n FROM financials_ledger_items WHERE period = '2026-05'").get().n;
	const reopened = await books();
	check(reopen.status === 200 && mayItems() === 0 && c(reopened.figures["2026-05"].revenue) === c(9999 + 1500),
		"reopen: May's items are released and May reads live ($9,999 + $1,500 revenue)", `${reopen.status}, items ${mayItems()}, revenue ${c(reopened.figures["2026-05"] && reopened.figures["2026-05"].revenue)}`);
	await api.finalizePeriods(["2026-05"], "super_admin");
	const reclosed = await books();
	check(mayItems() > 0 && sameFigures(reclosed.figures["2026-05"], reopened.figures["2026-05"]),
		"reopen: the next close freezes May again, at the figures it read the moment before", `${show(reopened.figures["2026-05"])} -> ${show(reclosed.figures["2026-05"])}`);

	// ── a month's figures do not change when it closes ────────────────────────
	const juneBefore = (await books()).figures["2026-06"];
	await api.finalizePeriods(["2026-06"], "system");
	const juneAfter = (await books()).figures["2026-06"];
	const juneOwner6 = financialsCalc.monthFiguresFromItems((await books()).items.filter((i) => i.ownerId === 6))["2026-06"];
	check(sameFigures(juneBefore, juneAfter), "close: June's figures are the same the moment before and after it closes", `${show(juneBefore)} -> ${show(juneAfter)}`);
	check(sameFigures(juneOwner6, settledBreakdown(6, "2026-06")), "close: owner 6's frozen June equals the breakdown its payout was stamped with", `${show(juneOwner6)} vs ${show(settledBreakdown(6, "2026-06"))}`);
	check(db.prepare("SELECT COUNT(*) AS n FROM financials_ledger_items WHERE period = '2026-06' AND kind = 'settlement_adjustment'").get().n === 0,
		"close: a month frozen at its close needs no Settlement adjustment", "");

	// ── a paid month re-closed after a reopen keeps what it settled at ────────
	db.prepare("UPDATE investor_payouts SET status = 'paid', paid_at = '2026-07-10T17:00:00Z' WHERE owner_id = 6 AND period = '2026-06'").run();
	const junePaidBreakdown = settledBreakdown(6, "2026-06");
	await call("POST /api/periods/:period/reopen", { params: { period: "2026-06" }, body: { reason: "late correction" }, session: { user: SUPER } });
	SHEET[5]["  Payment  "] = "$3,100.00"; // 8006, June, owner 6
	await api.finalizePeriods(["2026-06"], "super_admin");
	const june6 = financialsCalc.monthFiguresFromItems((await books()).items.filter((i) => i.ownerId === 6))["2026-06"];
	check(sameFigures(june6, junePaidBreakdown) && c(june6.revenue) === 250000,
		"re-close: a paid row's month freezes at the breakdown it settled at ($2,500), not today's ($3,100)", `${show(june6)} vs ${show(junePaidBreakdown)}`);

	// ── a failure in Financials' freeze never holds up the payout close ───────
	W_FAIL.states = true;
	const closedAnyway = await api.finalizePeriods(["2026-01"], "system");
	W_FAIL.states = false;
	const janLock = db.prepare("SELECT status FROM period_locks WHERE period = '2026-01'").get();
	check(JSON.stringify(closedAnyway.periods) === JSON.stringify(["2026-01"]) && janLock && janLock.status === "locked"
		&& !db.prepare("SELECT 1 FROM financials_ledger_freezes WHERE period = '2026-01'").get()
		&& W.notices.some((n) => /Financials figures not frozen at close/.test(n.title)),
		"close: when Financials' items cannot be computed the month still closes, unfrozen, with a notice", JSON.stringify(closedAnyway));
	W.errors.splice(0, W.errors.length, ...W.errors.filter((e) => !/Financials items for 2026-01 not computed/.test(e)));

	// A freeze that fails partway is undone whole, and the payout close of both
	// months still goes ahead: May and June reopened, then closed together with
	// June's freeze write failing after May's was written.
	for (const period of ["2026-05", "2026-06"]) {
		await call("POST /api/periods/:period/reopen", { params: { period }, body: { reason: "re-close test" }, session: { user: SUPER } });
	}
	const juneFreezes = db.prepare("SELECT COUNT(*) AS n FROM financials_ledger_freezes WHERE period = '2026-06'").get().n;
	db.prepare("INSERT INTO financials_ledger_freezes (freeze_id, period, source, frozen_at, frozen_by, item_count, summary) VALUES (?, '1999-02', 'test', 'x', 'test', 0, '{}')")
		.run(`2026-06:close:${new Date(NOW_MS).toISOString()}:${juneFreezes + 1}`);
	const pairNotices = W.notices.length;
	const pair = await api.finalizePeriods(["2026-05", "2026-06"], "system");
	db.prepare("DELETE FROM financials_ledger_freezes WHERE period = '1999-02'").run();
	const activeFreeze = (p) => db.prepare("SELECT 1 FROM financials_ledger_freezes WHERE period = ? AND released_at = ''").get(p);
	const unstamped = db.prepare("SELECT COUNT(*) AS n FROM investor_payouts WHERE period IN ('2026-05', '2026-06') AND COALESCE(finalized_at, '') = ''").get().n;
	const pairLocked = db.prepare("SELECT COUNT(*) AS n FROM period_locks WHERE period IN ('2026-05', '2026-06') AND status = 'locked'").get().n;
	check(JSON.stringify(pair.periods) === JSON.stringify(["2026-05", "2026-06"]) && pairLocked === 2 && unstamped === 0
		&& !activeFreeze("2026-05") && !activeFreeze("2026-06")
		&& !db.prepare("SELECT 1 FROM financials_ledger_items WHERE period IN ('2026-05', '2026-06')").get()
		&& W.notices.slice(pairNotices).some((n) => /Financials figures not frozen at close/.test(n.title)),
		"close: a Financials freeze that fails partway is undone whole (May's too); both months close with every payout row stamped, and a notice",
		JSON.stringify({ periods: pair.periods, pairLocked, unstamped, may: !!activeFreeze("2026-05"), june: !!activeFreeze("2026-06") }));
	W.errors.splice(0, W.errors.length, ...W.errors.filter((e) => !/Financials items for 2026-05, 2026-06 not frozen/.test(e)));

	// A failed freeze write is undone alone: the payout close still goes ahead.
	const febFreezeId = `2026-02:close:${new Date(NOW_MS).toISOString()}:1`;
	db.prepare("INSERT INTO financials_ledger_freezes (freeze_id, period, source, frozen_at, frozen_by, item_count, summary) VALUES (?, '1999-01', 'test', 'x', 'test', 0, '{}')").run(febFreezeId);
	const noticesBefore = W.notices.length;
	const febClosed = await api.finalizePeriods(["2026-02"], "system");
	db.prepare("DELETE FROM financials_ledger_freezes WHERE period = '1999-01'").run();
	const febLock = db.prepare("SELECT status FROM period_locks WHERE period = '2026-02'").get();
	check(JSON.stringify(febClosed.periods) === JSON.stringify(["2026-02"]) && febLock && febLock.status === "locked"
		&& !db.prepare("SELECT 1 FROM financials_ledger_freezes WHERE period = '2026-02'").get()
		&& !db.prepare("SELECT 1 FROM financials_ledger_items WHERE period = '2026-02'").get()
		&& W.notices.slice(noticesBefore).some((n) => /Financials figures not frozen at close/.test(n.title)),
		"close: when writing Financials' items fails the month still closes, unfrozen, with a notice", JSON.stringify(febClosed));
	W.errors.splice(0, W.errors.length, ...W.errors.filter((e) => !/Financials items for 2026-02 not frozen/.test(e)));

	// A paid row re-closed after a reopen with no breakdown on record: its month
	// freezes as it stands, and the close says so.
	await call("POST /api/periods/:period/reopen", { params: { period: "2026-06" }, body: { reason: "no breakdown test" }, session: { user: SUPER } });
	db.prepare("UPDATE investor_payouts SET finalized_breakdown = '' WHERE owner_id = 6 AND period = '2026-06'").run();
	const unsettledNotices = W.notices.length;
	await api.finalizePeriods(["2026-06"], "system");
	const unsettledAudit = db.prepare("SELECT username, entity_id, details FROM audit_trail WHERE action = 'financials_freeze_unsettled'").all();
	check(W.notices.slice(unsettledNotices).some((n) => /Financials frozen as it stands/.test(n.title) && !/\$/.test(n.body))
		&& unsettledAudit.length === 1 && unsettledAudit[0].entity_id === "2026-06" && /owner 6 2026-06/.test(unsettledAudit[0].details),
		"re-close: a paid row with no recorded breakdown freezes as it stands, with a notice (no figures) and an audit row", JSON.stringify({ unsettledAudit, notices: W.notices.slice(unsettledNotices).map((n) => n.title) }));

	// Wear & Tear is its own category; a receipt dated outside the books' months
	// (a typo of a year) makes no month row and counts in no total.
	const finBefore = (await fin({})).body;
	const julBefore = (await fin({ month: "2026-07" })).body.monthDetail.expenseCategories;
	expense.run("2026-07-10T17:00:00.000Z", D, "Wear & Tear", 75, "2026-07-03", 0, "C1", "", "");
	expense.run("2026-07-10T17:00:00.000Z", D, "Fuel", 40, "2031-01-15", 0, "C1", "", "");
	expense.run("2026-07-10T17:00:00.000Z", D, "Fuel", 30, "2017-07-15", 0, "C1", "", "");
	const julAfter = (await fin({ month: "2026-07" })).body.monthDetail.expenseCategories;
	check(c(julAfter.wear_tear) === c(julBefore.wear_tear) + 7500 && c(julAfter.other) === c(julBefore.other),
		"categories: a Wear & Tear receipt is its own category, not Other", JSON.stringify({ julBefore, julAfter }));
	const finAfter = (await fin({})).body;
	const receipts = (cats) => ["fuel", "maintenance", "repair", "wear_tear", "toll", "food", "other"].reduce((sum, k) => sum + c(cats[k]), 0);
	check(!finAfter.monthlyPerformance.some((m) => m.month === "2031-01" || m.month === "2017-07") && finAfter.summary.outOfRange === 2
		&& c(finAfter.expensesByCategory.fuel) === c(finBefore.expensesByCategory.fuel)
		&& receipts(finAfter.expensesByCategory) === receipts(finBefore.expensesByCategory) + 7500,
		"books: receipts dated 2031 and 2017 make no month row and count in no total; they are reported as out of range",
		JSON.stringify({ months: finAfter.monthlyPerformance.map((m) => m.month), outOfRange: finAfter.summary.outOfRange, before: finBefore.expensesByCategory, after: finAfter.expensesByCategory }));

	// A load with no driver: the drill-down's "(Unassigned)" row keeps its rows
	// adding up to the month's revenue.
	SHEET.push(load("8010", "", "7/6/2026", "7/7/2026 8:00", "7/7/2026 18:00", "$640.00", "C1", "0"));
	const julMd = (await fin({ month: "2026-07" })).body.monthDetail;
	SHEET.pop();
	const julUnassigned = julMd.drivers.find((d) => d.isUnassigned);
	check(julUnassigned && c(julUnassigned.revenue) === 64000 && sumC(julMd.drivers, "revenue") === c(julMd.summary.revenue),
		"drill-down: revenue with no driver is an \"(Unassigned)\" row, and the rows add up to the month's revenue",
		JSON.stringify(julMd.drivers.map((d) => [d.name, d.revenue])));

	// Cents: the drill-down's rows carry them, so they add up to the headline to
	// the cent (whole-dollar rows left it up to $0.50 a row off).
	SHEET.push(load("8011", D, "7/8/2026", "7/9/2026 8:00", "7/9/2026 18:00", "$640.45", "C1", "0"));
	SHEET.push(load("8012", D, "7/9/2026", "7/10/2026 8:00", "7/10/2026 18:00", "$100.35", "C1", "0"));
	SHEET.push(load("8013", "", "7/9/2026", "7/10/2026 8:00", "7/10/2026 18:00", "$10.45", "C1", "0"));
	const julCents = (await fin({ month: "2026-07" })).body.monthDetail;
	SHEET.pop(); SHEET.pop(); SHEET.pop();
	const hasCents = (v) => c(v) % 100 !== 0;
	const daveCents = julCents.drivers.find((d) => d.name === D) || {};
	const unassignedCents = julCents.drivers.find((d) => d.isUnassigned) || {};
	check(sumC(julCents.drivers, "revenue") === c(julCents.summary.revenue) && sumC(julCents.drivers, "pay") === c(julCents.summary.driverPay)
		&& hasCents(daveCents.revenue) && hasCents(daveCents.margin) && c(unassignedCents.revenue) === 1045,
		"drill-down: rows carry cents and add up to the month's revenue and driver pay to the cent",
		JSON.stringify({ revenue: julCents.summary.revenue, rows: julCents.drivers.map((d) => [d.name, d.revenue, d.pay, d.margin]) }));

	check(W.errors.length === 0, "the lifted code logged no error", W.errors.join(" | "));
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => die(`crashed: ${e.stack || e.message}`));
