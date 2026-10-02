#!/usr/bin/env node
/**
 * The 2026-10 payout rules (payoutRules()), each on its own, against the rules
 * as they ship (all off). Fixture: owner 5's truck T5 driven by E from March;
 * driver D on company truck C1 in January (blank Owner ID loads), moved onto T5
 * in August.
 *   - off: payoutRules() is all off with PAYOUT_RULES_V2_ENABLED unset, and
 *     D's January loads count for owner 5 (the driver set, ended pairings and
 *     all), as today;
 *   - datedAttribution: they belong to the truck D held in January, the
 *     company's, so owner 5 no longer has them and the company does;
 *   - datedRates: a day is priced at the rate in effect that day (T5 at $250
 *     until it was raised to $300), not at today's rate for every month;
 *   - datedRates also reads the rates without writing: a rate saved by a path
 *     that did not record it counts from today, and recording dates it then;
 *   - futureReceipts: a receipt dated after the day it was submitted counts in
 *     the month it was submitted; a close under the rule books it there, so it
 *     is counted exactly once after the month closes; a month closed without
 *     the rule settled it by its date, and it stays there;
 *   - frozenCarry: a closed month's loss is carried at what it settled, even
 *     when a recompute of that month now shows a profit, at the share it
 *     settled at (not today's split), and a closed month the recompute no
 *     longer reaches still carries what it settled;
 *   - the dry run lists each open-month payout that would change, by how much,
 *     and which rule moves it, and each load datedAttribution moves between
 *     owners, and writes nothing.
 *
 * The shipped code runs, lifted out of server.js, on an in-memory SQLite built
 * from server.js's own DDL. Pure: no server, no app.db, no network.
 * Run: node scripts/test-payout-rules.js    # exits 1 on failure
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

const CONSTS = ["PAYOUT_RULES_V2_ENABLED", "PAYOUT_RULE_KEYS", "haulAssignmentsStmt", "LEDGER_ITEM_COLS", "EXPENSE_PNL_FILTER", "EXPENSE_PERIOD_EXPR", "CANCELED_STATUS_RE", "RFC2822_MONTHS", "PERIOD_FINALIZE_ENABLED",
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
	"closingFingerprint", "buildHeldTruckIndex", "buildHaulTruckResolver", "loadPayRateIndex", "currentPayRates", "recordPayRateChanges", "stampFutureReceipts", "futureAwarePeriodExpr", "payoutRulesDryRun", "closingLedgerItems", "financialsSettings", "financialsExtraItems", "closedMonthSettings", "computeFleetLedger", "settledMonthItems", "settledPayoutRows", "writeLedgerFreeze", "ledgerItemFromRow", "buildFinancialsLedger", "completedLoadCancelRefusal", "loadRowAccountingMonths", "sheetCellMonths", "sheetCellDate",
];
const REOPEN_HEAD = 'app.post("/api/periods/:period/reopen", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const ADJUST_HEAD = 'app.put("/api/investor/payouts/:id/adjust", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const DRY_HEAD = 'app.get("/api/admin/payout-rules/dry-run", requireRole("Super Admin"), async (req, res) => {';
const BODY = [
	...CONSTS.map((c) => liftDecl("const", c)),
	...LETS.map((c) => liftDecl("let", c)),
	...FNS.map(liftFn),
	liftRoute(REOPEN_HEAD),
	liftRoute(ADJUST_HEAD),
	liftRoute(DRY_HEAD),
	"return { reconcileInvestorPayouts, computeInvestorMonthlyEarnings, computeLossCarryForward, getInvestorDriverSet, assignDriverToTruck, finalizePeriods, getCarrierDBFromSQLite, installPeriodLockTriggers, recordPayRateChanges, loadPayRateIndex, computeFleetLedger, payoutRules };",
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
	tableDdl("financials_ledger_items"), tableDdl("financials_ledger_freezes"), tableDdl("app_settings"), tableDdl("pay_rate_history"),
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
const SHEET = [
	// D, on company truck C1, January: blank Owner ID, $2,100 in all.
	load("7001", D, "1/5/2026", "1/6/2026 8:00", "1/6/2026 18:00", "$700.00", "C1", ""),
	load("7002", D, "1/12/2026", "1/13/2026 8:00", "1/13/2026 18:00", "$700.00", "C1", ""),
	load("7003", D, "1/19/2026", "1/20/2026 8:00", "1/20/2026 18:00", "$700.00", "C1", ""),
	// E, on owner 5's truck T5, one load a month from March to July.
	load("7101", E, "3/9/2026", "3/10/2026 8:00", "3/11/2026 10:00", "$6,000.00", "T5", "5"),
	load("7102", E, "4/13/2026", "4/14/2026 8:00", "4/15/2026 10:00", "$6,000.00", "T5", "5"),
	load("7103", E, "5/11/2026", "5/12/2026 8:00", "5/13/2026 10:00", "$6,000.00", "T5", "5"),
	load("7104", E, "6/8/2026", "6/9/2026 8:00", "6/10/2026 10:00", "$6,000.00", "T5", "5"),
	load("7105", E, "7/13/2026", "7/14/2026 8:00", "7/15/2026 10:00", "$6,000.00", "T5", "5"),
];

function buildWorld({ onSheetRead = null, env = {} } = {}) {
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
		resolveCityState: () => "",
		loadHaul: require(path.join(ROOT, "lib", "load-haul.js")),
		insertDispatchNotification: { run: (type, title, body) => notices.push({ type, title, body }) },
		process: { env },
		console: { log() {}, warn: (m) => warnings.push(String(m)), error: (...a) => errors.push(a.map(String).join(" ")) },
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
const RULES = ["datedAttribution", "datedRates", "futureReceipts", "frozenCarry"];
const only = (k) => Object.fromEntries(RULES.map((r) => [r, r === k]));
const NONE = only(null);
const c = (v) => Math.round(Number(v || 0) * 100);

(async () => {
	const W = buildWorld();
	const { db, api, call } = W;
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (?, ?, 'x', ?, ?)");
	user.run(1, "super_admin", "Super Admin", "");
	user.run(5, "inv5", "Investor", "Acme Carrier");
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	const truck = db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, insurance_monthly,
		eld_monthly, truck_payment_monthly, hvut_annual, irp_annual, driver_pay_daily) VALUES (?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, ?)`);
	truck.run(1, "T5", 5, "2026-03-01", "2026-03-01 00:00:00", 1000, 50, 1500, 600, 1200, 250);
	truck.run(2, "C1", 0, "2025-06-01", "2025-06-01 00:00:00", 900, 50, 0, 0, 0, 200);
	const dir = db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_daily) VALUES (?, ?, 'fixed', 0)");
	dir.run(D, "");
	dir.run(E, "Acme Carrier");
	setClock("2025-12-01T17:00:00Z");
	api.assignDriverToTruck(2, D);
	setClock("2026-03-01T17:00:00Z");
	api.assignDriverToTruck(1, E);
	api.recordPayRateChanges(); // the seeds: T5 at $250
	// T5's rate raised to $300 on 2026-06-01.
	setClock("2026-06-01T17:00:00Z");
	db.prepare("UPDATE trucks SET driver_pay_daily = 300 WHERE id = 1").run();
	api.recordPayRateChanges();
	setClock("2026-08-12T17:00:00Z");
	api.assignDriverToTruck(1, D); // D moves onto owner 5's truck

	// March closes at a loss: a $9,000 repair receipt. Then the receipt is
	// rejected after the close, so a recompute of March shows a profit.
	const expense = db.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, status, owner_id, truck_unit, posted_period) VALUES (?, ?, ?, ?, ?, 'Approved', 5, 'T5', '')");
	const repair = expense.run("2026-03-20T17:00:00.000Z", E, "Repair", 9000, "2026-03-20").lastInsertRowid;
	setClock("2026-04-10T17:00:00Z");
	const ctx = (rules) => ({ sessionUser: SUPER, carrierDB: api.getCarrierDBFromSQLite(), globalConfig: { investor_split_pct: "50" }, rules });
	await api.reconcileInvestorPayouts(5, ctx(NONE));
	await api.finalizePeriods(["2026-01", "2026-02", "2026-03"], "system");
	db.prepare("UPDATE expenses SET status = 'Rejected' WHERE id = ?").run(repair);
	// A receipt dated in the future: submitted 2026-08-10, dated 2026-09-20.
	expense.run("2026-08-10T17:00:00.000Z", E, "Fuel", 500, "2026-09-20");
	setClock("2026-09-10T17:00:00Z");

	const ledgerOf = async (A, rules, split = "50") => {
		const carrier = A.getCarrierDBFromSQLite();
		const set = A.getInvestorDriverSet(5, carrier.data, "Driver", "Carrier Name");
		const r = await A.computeInvestorMonthlyEarnings({ user: { ...SUPER, id: 5 }, isSuperAdmin: false, investorDriverSet: set, investorOwnerId: 5, config: { investor_split_pct: split }, rules });
		const carry = A.computeLossCarryForward(r.monthlyEarnings);
		return { months: Object.fromEntries(r.monthlyEarnings.map((m) => [m.month, m])), carry };
	};
	const ledger = (rules, split) => ledgerOf(api, rules, split);
	const base = await ledger(NONE);

	// ── off ──────────────────────────────────────────────────────────────────
	check(JSON.stringify(api.payoutRules()) === JSON.stringify(NONE), "off: payoutRules() is all off with PAYOUT_RULES_V2_ENABLED unset", JSON.stringify(api.payoutRules()));
	check(base.months["2026-01"] && c(base.months["2026-01"].exact.revenue) === 210000,
		"off: D's January loads count for owner 5 (today's driver set)", JSON.stringify(base.months["2026-01"] && base.months["2026-01"].exact));

	// ── datedAttribution ─────────────────────────────────────────────────────
	const dated = await ledger(only("datedAttribution"));
	check(!dated.months["2026-01"] || c(dated.months["2026-01"].exact.revenue) === 0,
		"datedAttribution: D's January loads are not owner 5's (D held company truck C1 then)", JSON.stringify(dated.months["2026-01"] && dated.months["2026-01"].exact));
	const fleetDated = await api.computeFleetLedger({ rules: only("datedAttribution") });
	const companyJan = fleetDated.scopes.find((s) => s.ownerId === 0).items.filter((i) => i.kind === "revenue" && i.month === "2026-01").reduce((a, i) => a + i.cents, 0);
	check(companyJan === 210000, "datedAttribution: …the company has them", String(companyJan));

	// ── datedRates ───────────────────────────────────────────────────────────
	const rated = await ledger(only("datedRates"));
	check(c(base.months["2026-04"].exact.driverPay) === 2 * 25000 && c(base.months["2026-07"].exact.driverPay) === 2 * 25000,
		"off: E, on no truck today, is priced at the $250 fallback in every month",
		`Apr ${c(base.months["2026-04"].exact.driverPay)}, Jul ${c(base.months["2026-07"].exact.driverPay)}`);
	check(c(rated.months["2026-04"].exact.driverPay) === 2 * 25000 && c(rated.months["2026-07"].exact.driverPay) === 2 * 30000,
		"datedRates: each day at the rate of the truck E held then, as it stood then (April $250, July $300 after the raise)",
		`Apr ${c(rated.months["2026-04"].exact.driverPay)}, Jul ${c(rated.months["2026-07"].exact.driverPay)}`);

	// ── futureReceipts ───────────────────────────────────────────────────────
	const future = await ledger(only("futureReceipts"));
	check(c(base.months["2026-09"].exact.tripExpenses) === 50000 && c(future.months["2026-09"].exact.tripExpenses) === 0 && c(future.months["2026-08"].exact.tripExpenses) === 50000,
		"futureReceipts: the receipt dated 09-20 but submitted 08-10 counts in August, not September",
		`base Sep ${c(base.months["2026-09"].exact.tripExpenses)}, rule Sep ${c(future.months["2026-09"].exact.tripExpenses)} Aug ${c(future.months["2026-08"].exact.tripExpenses)}`);

	// ── frozenCarry ──────────────────────────────────────────────────────────
	const frozen = await ledger(only("frozenCarry"));
	check(base.carry["2026-03"].raw > 0 && frozen.carry["2026-03"].raw < 0,
		"frozenCarry: March enters the settlement at the loss it settled at, not its recompute (a profit now)",
		`recompute ${base.carry["2026-03"].raw}, frozen ${frozen.carry["2026-03"].raw}`);
	check(frozen.carry["2026-04"].carriedIn > 0 && base.carry["2026-04"].carriedIn === 0,
		"frozenCarry: …so the loss is carried into April", `rule ${frozen.carry["2026-04"].carriedIn}, base ${base.carry["2026-04"].carriedIn}`);

	// ── the dry run ──────────────────────────────────────────────────────────
	const rowsBefore = JSON.stringify(db.prepare("SELECT * FROM investor_payouts ORDER BY id").all());
	const auditBefore = db.prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n;
	const historyBefore = db.prepare("SELECT COUNT(*) AS n FROM pay_rate_history").get().n;
	// D's August load on company truck C1, blank Owner ID, before D moved onto
	// T5: today's driver set gives it to owner 5; D held C1 that day.
	SHEET.push(load("7201", D, "8/5/2026", "8/6/2026 8:00", "8/6/2026 18:00", "$900.00", "C1", ""));
	const dry = await call("GET /api/admin/payout-rules/dry-run", { session: { user: SUPER } });
	SHEET.pop();
	check(dry.status === 200 && dry.body.flagOn === false && Array.isArray(dry.body.changes), "dry run: answers with the flag off", `${dry.status}`);
	const apr = (dry.body.changes || []).find((x) => x.ownerId === 5 && x.period === "2026-04");
	const jul = (dry.body.changes || []).find((x) => x.ownerId === 5 && x.period === "2026-07");
	check(apr && apr.delta < 0 && apr.byRule.frozenCarry < 0 && Object.keys(apr.byRule).join() === "frozenCarry",
		"dry run: April's payout is listed as moved down by frozenCarry alone", JSON.stringify(apr));
	check(jul && jul.byRule.datedRates < 0 && jul.figureChanges.driverPay === 100,
		"dry run: July's is listed with datedRates moving it (driver pay +$100)", JSON.stringify(jul));
	check((dry.body.changes || []).every((x) => !["2026-01", "2026-02", "2026-03"].includes(x.period)), "dry run: closed months are not listed", JSON.stringify((dry.body.changes || []).map((x) => x.period)));
	const moved = (dry.body.movedLoads || []).find((x) => x.loadId === "7201");
	check(moved && moved.from === 5 && moved.to === 0 && moved.amount === 900 && moved.period === "2026-08" && /C1/.test(moved.reason) && dry.body.movedLoads.length === 1,
		"dry run: the load datedAttribution moves is listed, from owner 5 to the company, because D held C1 that day", JSON.stringify(dry.body.movedLoads));
	check(JSON.stringify(db.prepare("SELECT * FROM investor_payouts ORDER BY id").all()) === rowsBefore && db.prepare("SELECT COUNT(*) AS n FROM audit_trail").get().n === auditBefore
		&& db.prepare("SELECT COUNT(*) AS n FROM pay_rate_history").get().n === historyBefore,
		"dry run: nothing is written", "");

	// ── frozenCarry: the share it settled at, and months the recompute no longer reaches
	const marchShare = JSON.parse(db.prepare("SELECT finalized_breakdown AS b FROM investor_payouts WHERE owner_id = 5 AND period = '2026-03'").get().b).monthShare;
	const resplit = await ledger(only("frozenCarry"), "60");
	check(marchShare < 0 && resplit.carry["2026-03"].raw === marchShare,
		"frozenCarry: a closed month carries the share it settled at, whatever the split is today (60%)", `settled ${marchShare}, carried ${resplit.carry["2026-03"].raw}`);
	const janShare = JSON.parse(db.prepare("SELECT finalized_breakdown AS b FROM investor_payouts WHERE owner_id = 5 AND period = '2026-01'").get().b).monthShare;
	const both = await ledger({ ...NONE, datedAttribution: true, frozenCarry: true });
	check(both.months["2026-01"] && c(both.months["2026-01"].exact.revenue) === 210000 && both.carry["2026-01"].raw === janShare,
		"frozenCarry: closed January, whose loads datedAttribution moves away, still carries what it settled",
		JSON.stringify({ jan: both.months["2026-01"] && both.months["2026-01"].exact, raw: both.carry["2026-01"] && both.carry["2026-01"].raw, janShare }));

	// ── datedRates: reading the rates writes nothing ─────────────────────────
	setClock("2026-09-15T17:00:00Z");
	db.prepare("UPDATE trucks SET driver_pay_daily = 350 WHERE id = 1").run();
	const idx = api.loadPayRateIndex();
	check(idx.at("truck", "1", "2026-09-15") === 350 && idx.at("truck", "1", "2026-09-14") === 300 && db.prepare("SELECT COUNT(*) AS n FROM pay_rate_history").get().n === historyBefore,
		"datedRates: reading the rates writes nothing; a rate saved without being recorded counts from today", JSON.stringify([idx.at("truck", "1", "2026-09-14"), idx.at("truck", "1", "2026-09-15")]));
	api.recordPayRateChanges();
	const recorded = db.prepare("SELECT rate, effective_from FROM pay_rate_history WHERE subject = 'truck' AND subject_key = '1' ORDER BY id DESC LIMIT 1").get();
	check(recorded.rate === 350 && recorded.effective_from.startsWith("2026-09-15"), "datedRates: recording the change dates it when it is recorded", JSON.stringify(recorded));
	const recordCalls = (SRC.match(/^\t+recordPayRateChanges\(\);$/gm) || []).length;
	check(recordCalls === 4, "datedRates: the truck and driver-directory create and edit routes record a rate the moment it is saved", `${recordCalls} call sites`);

	// ── futureReceipts across a close ────────────────────────────────────────
	// Closed without the rule (production today): August settled the receipt by
	// its date, so it stays in September.
	setClock("2026-10-10T17:00:00Z");
	db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-08', 'locked', '2026-10-01T05:00:00.000Z', 'system')").run();
	const afterOff = await ledger(only("futureReceipts"));
	const trip = (l, mk) => (l.months[mk] ? c(l.months[mk].exact.tripExpenses) : 0);
	check(trip(afterOff, "2026-08") === 0 && trip(afterOff, "2026-09") === 50000 && trip(afterOff, "2026-10") === 0,
		"futureReceipts: August closed without the rule settled the receipt by its date; it counts in September only",
		JSON.stringify(["2026-08", "2026-09", "2026-10"].map((mk) => trip(afterOff, mk))));
	// September closes too (settling the receipt), then August is reopened: the
	// receipt stays in September, where it settled, and is not counted again.
	db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-09', 'locked', '2026-10-05T05:00:00.000Z', 'system')").run();
	db.prepare("UPDATE period_locks SET status = 'reopened' WHERE period = '2026-08'").run();
	const reopened = await ledger(only("futureReceipts"));
	check(trip(reopened, "2026-08") === 0 && trip(reopened, "2026-09") === 50000,
		"futureReceipts: reopening the submission month does not pull back a receipt its closed date month settled",
		JSON.stringify(["2026-08", "2026-09"].map((mk) => trip(reopened, mk))));
	// Closed under the rule: the close books the receipt to August, and it is
	// counted there once, never again in a later month.
	const V = buildWorld({ env: { PAYOUT_RULES_V2_ENABLED: "true" } });
	const ALL = Object.fromEntries(RULES.map((r) => [r, true]));
	check(JSON.stringify(V.api.payoutRules()) === JSON.stringify(ALL), "on: PAYOUT_RULES_V2_ENABLED=true switches every rule on", JSON.stringify(V.api.payoutRules()));
	const vUser = V.db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (?, ?, 'x', ?, ?)");
	vUser.run(1, "super_admin", "Super Admin", "");
	vUser.run(5, "inv5", "Investor", "Acme Carrier");
	V.db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	V.db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, insurance_monthly, eld_monthly, truck_payment_monthly, hvut_annual, irp_annual, driver_pay_daily)
		VALUES (1, 'T5', 5, 'Active', '2026-03-01', '2026-03-01 00:00:00', 1000, 50, 1500, 600, 1200, 250), (2, 'C1', 0, 'Active', '2025-06-01', '2025-06-01 00:00:00', 900, 50, 0, 0, 0, 200)`).run();
	V.db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_daily) VALUES (?, '', 'fixed', 0), (?, 'Acme Carrier', 'fixed', 0)").run(D, E);
	setClock("2025-12-01T17:00:00Z");
	V.api.assignDriverToTruck(2, D);
	setClock("2026-03-01T17:00:00Z");
	V.api.assignDriverToTruck(1, E);
	V.api.recordPayRateChanges();
	const vReceipt = V.db.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, status, owner_id, truck_unit, posted_period) VALUES (?, ?, 'Fuel', 500, ?, 'Approved', 5, 'T5', '')")
		.run("2026-08-10T17:00:00.000Z", E, "2026-09-20").lastInsertRowid;
	setClock("2026-09-10T17:00:00Z");
	const closed = await V.api.finalizePeriods(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"], "system");
	const booked = V.db.prepare("SELECT posted_period FROM expenses WHERE id = ?").get(vReceipt).posted_period;
	const bookedAudit = V.db.prepare("SELECT entity_id, details FROM audit_trail WHERE action = 'receipt_period_booked'").all();
	check(closed.periods.includes("2026-08") && booked === "2026-08" && bookedAudit.length === 1 && bookedAudit[0].entity_id === "2026-08",
		"futureReceipts: a close under the rule books the receipt to August, audited", JSON.stringify({ periods: closed.periods, booked, bookedAudit }));
	const augPaid = JSON.parse(V.db.prepare("SELECT finalized_breakdown AS b FROM investor_payouts WHERE owner_id = 5 AND period = '2026-08'").get().b);
	setClock("2026-10-10T17:00:00Z");
	const onLater = await ledgerOf(V.api, ALL);
	check(c(augPaid.tripExpenses) === 50000 && trip(onLater, "2026-08") === 50000 && trip(onLater, "2026-09") === 0 && trip(onLater, "2026-10") === 0,
		"futureReceipts: after August closes, the receipt is counted once, in August, and in no later month",
		JSON.stringify({ settledAug: augPaid.tripExpenses, months: ["2026-08", "2026-09", "2026-10"].map((mk) => trip(onLater, mk)) }));
	check(V.errors.length === 0, "the lifted code logged no error (rules on)", V.errors.join(" | "));

	check(W.errors.length === 0, "the lifted code logged no error", W.errors.join(" | "));
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => die(`crashed: ${e.stack || e.message}`));
