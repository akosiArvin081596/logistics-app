#!/usr/bin/env node
/**
 * A closed month gets no new payout row, and nothing else writes into it.
 *
 * WHAT IT REPRODUCES: "the January row created in August". Owner 5 has been
 * settled every month from March to July 2026, and the month-end close has
 * locked every month from January to July. Driver D drove a company truck in
 * January, and his three January loads carry a blank Owner ID. On 2026-08-12 D
 * is assigned to owner 5's truck. getInvestorDriverSet() answers "who is on my
 * trucks right now", so the next reconcile counts D's January loads as owner
 * 5's, its months now start in January, and reconcileInvestorPayouts() inserts
 * rows for January and February (both locked) and stamps them finalized.
 *
 * WHAT IS ASSERTED: after the reassignment and one reconcile, owner 5 has no row
 * for 2026-01, no row was created in any locked month, and every row that was
 * already frozen (March to July) is unchanged. The late January item is recorded
 * once, as a system audit row, for review. The closed-month triggers refuse a
 * direct INSERT, a figure UPDATE and a DELETE in a locked month while letting a
 * status move through. Reopening July still works: the route flips the lock,
 * clears the row's stamp, the reconcile moves it to the new figure, and the next
 * close freezes and locks it again. An adjustment on a closed month is refused
 * (409 PERIOD_FINALIZED, audited) and names the open month to post it on; an
 * adjustment on that open month goes through.
 *
 * The close itself, on a second database: it creates and stamps the row of an
 * investor nobody reconciled before it; a failed compute locks nothing; an
 * already-closed month in the batch is skipped; a receipt that lands while the
 * figures are being computed makes it close nothing (the next pass closes it,
 * receipt included); a correction larger than the month finally pays is reported
 * at close; a late item notifies once. And the cancel check: a completed load in
 * a closed month is refused, an open one or a load not yet completed is not.
 *
 * The shipped code runs, lifted out of server.js: reconcileInvestorPayouts(),
 * computeInvestorMonthlyEarnings(), getInvestorDriverSet(), assignDriverToTruck()
 * (with syncOpenCarrierPairing()), finalizePeriods(), the reopen route,
 * installPeriodLockTriggers() and every helper they call, on an in-memory SQLite
 * built from server.js's own DDL. Stubbed: the clock, the
 * Job Tracking sheet read (getJobTrackingCached), the ELD travel-day index (no
 * truck is ELD-linked) and the drill-down's address lookup (not reached).
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-closed-month-no-write.js    # exits 1 on failure
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
	"LOCK_PERIOD_MIN_YEAR", "LOCK_PERIOD_MAX_YEAR", "insertPayoutHistory"];
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
	"closingFingerprint", "closingLedgerItems", "financialsSettings", "financialsExtraItems", "closedMonthSettings", "computeFleetLedger", "settledMonthItems", "ambiguousBlankOwnerLoads", "buildHeldTruckIndex", "appNoonMs", "buildHaulTruckResolver", "frozenPeriodSet", "settledPayoutRows", "writeLedgerFreeze", "ledgerItemFromRow", "buildFinancialsLedger", "completedLoadCancelRefusal", "loadRowAccountingMonths", "sheetCellMonths", "sheetCellDate",
];
const REOPEN_HEAD = 'app.post("/api/periods/:period/reopen", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const ADJUST_HEAD = 'app.put("/api/investor/payouts/:id/adjust", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const BODY = [
	...CONSTS.map((c) => liftDecl("const", c)),
	...LETS.map((c) => liftDecl("let", c)),
	...FNS.map(liftFn),
	liftRoute(REOPEN_HEAD),
	liftRoute(ADJUST_HEAD),
	"return { reconcileInvestorPayouts, getInvestorDriverSet, assignDriverToTruck, finalizePeriods, getCarrierDBFromSQLite, installPeriodLockTriggers, completedLoadCancelRefusal };",
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
		insertDispatchNotification: { run: (type, title, body) => notices.push({ type, title, body }) },
		process: { env: {} },
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
const LOCKED = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
const ROW_COLS = "period, amount, status, finalized_at, finalized_amount, finalized_breakdown";

(async () => {
	const { db, api, warnings, errors, call, refusals, notices } = buildWorld();
	const rows = () => db.prepare(`SELECT ${ROW_COLS} FROM investor_payouts WHERE owner_id = 5 ORDER BY period`).all();
	const ctx = () => ({ sessionUser: SUPER, carrierDB: api.getCarrierDBFromSQLite(), globalConfig: { investor_split_pct: "50" } });
	const ownerSet = () => {
		const c = api.getCarrierDBFromSQLite();
		return api.getInvestorDriverSet(5, c.data, "Driver", "Carrier Name");
	};

	// The fleet: owner 5 (Acme Carrier) owns T5, in service from March 2026, with
	// $2,700 a month of fixed costs; C1 is a company truck.
	db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (1, 'super_admin', 'x', 'Super Admin', '')").run();
	db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (5, 'inv5', 'x', 'Investor', 'Acme Carrier')").run();
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	const truck = db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, insurance_monthly,
		eld_monthly, truck_payment_monthly, hvut_annual, irp_annual, driver_pay_daily) VALUES (?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, 250)`);
	truck.run(1, "T5", 5, "2026-03-01", "2026-03-01 00:00:00", 1000, 50, 1500, 600, 1200);
	truck.run(2, "C1", 0, "2025-06-01", "2025-06-01 00:00:00", 900, 50, 0, 0, 0);
	const dir = db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_daily) VALUES (?, ?, 'fixed', 0)");
	dir.run(D, "");
	dir.run(E, "Acme Carrier");

	// History, through the shipped assignDriverToTruck().
	setClock("2025-12-01T17:00:00Z");
	api.assignDriverToTruck(2, D);
	setClock("2026-03-01T17:00:00Z");
	api.assignDriverToTruck(1, E);

	// 2026-08-10: the payouts screen reconciles owner 5 (March to July), then the
	// month-end close locks January to July and freezes owner 5's rows.
	setClock("2026-08-10T17:00:00Z");
	await api.reconcileInvestorPayouts(5, ctx());
	await api.finalizePeriods(LOCKED, "super_admin");
	const frozen = rows();
	const lockedNow = db.prepare("SELECT period FROM period_locks WHERE status = 'locked' ORDER BY period").all().map((r) => r.period);
	if (JSON.stringify(lockedNow) !== JSON.stringify(LOCKED)) die(`the close did not lock ${LOCKED.join(", ")} (got ${lockedNow.join(", ")})`);
	if (JSON.stringify(frozen.map((r) => r.period)) !== JSON.stringify(LOCKED.slice(2)) || frozen.some((r) => !r.finalized_at)) {
		die(`owner 5 should have a frozen row for March to July only, got ${JSON.stringify(frozen.map((r) => [r.period, !!r.finalized_at]))}`);
	}
	check(!ownerSet().has(D.toLowerCase()), "setup: D is not one of owner 5's drivers before the reassignment",
		`getInvestorDriverSet(5) = ${JSON.stringify([...ownerSet()])}`);

	// 2026-08-12: D moves onto owner 5's T5; the next reconcile runs.
	setClock("2026-08-12T17:00:00Z");
	api.assignDriverToTruck(1, D);
	check(ownerSet().has(D.toLowerCase()), "setup: after the reassignment D is one of owner 5's drivers",
		`getInvestorDriverSet(5) = ${JSON.stringify([...ownerSet()])}`);
	warnings.length = 0;
	await api.reconcileInvestorPayouts(5, ctx());
	const after = rows();

	const jan = after.find((r) => r.period === "2026-01");
	check(!jan, "no payout row is created for the closed month 2026-01",
		`expected no row, got amount ${jan && Math.round(jan.amount * 100)}¢ (finalized_amount ${jan && Math.round(jan.finalized_amount * 100)}¢, finalized_at ${jan && jan.finalized_at}, status ${jan && jan.status}); logged: ${warnings.filter((w) => w.includes("2026-01")).join(" | ")}`);

	const frozenPeriods = new Set(frozen.map((r) => r.period));
	const created = after.filter((r) => !frozenPeriods.has(r.period) && LOCKED.includes(r.period));
	check(created.length === 0, "no payout row is created in any locked month",
		`expected [], got ${JSON.stringify(created.map((r) => `${r.period}: ${Math.round(r.amount * 100)}¢`))}`);

	const changed = frozen.filter((r) => JSON.stringify(after.find((x) => x.period === r.period)) !== JSON.stringify(r));
	check(changed.length === 0, "every frozen row (2026-03 to 2026-07) keeps its amount, finalized_amount and breakdown",
		`changed: ${JSON.stringify(changed.map((r) => r.period))}`);

	// ── the late item is recorded once, for review ──────────────────────────
	const lateRows = () => db.prepare("SELECT entity_id, username, details FROM audit_trail WHERE action = 'late_item_closed_month' ORDER BY id").all();
	const late = lateRows();
	check(late.length === 1 && late[0].entity_id === "5:2026-01" && late[0].username === "system" && /revenue \$2100\.00/.test(late[0].details),
		"the January item is recorded once as a system audit row (late_item_closed_month, 5:2026-01, revenue $2100.00)",
		`got ${JSON.stringify(late)}`);
	await api.reconcileInvestorPayouts(5, ctx());
	check(lateRows().length === 1, "a second reconcile records nothing new", `got ${lateRows().length} rows`);
	check(notices.filter((n) => /activity found after it closed/.test(n.title)).length === 1,
		"…and the finding is sent once as a month-close notice", JSON.stringify(notices.map((n) => n.title)));
	check(notices.every((n) => !/\$\s?\d/.test(`${n.title} ${n.body}`)), "…which carries no money figures (Dispatchers read these notices)",
		JSON.stringify(notices.map((n) => n.body)));

	// ── the triggers: nothing writes a figure into a locked month ────────────
	const storedTriggers = db.prepare("SELECT COUNT(*) AS n FROM main.sqlite_master WHERE type = 'trigger'").get().n;
	const tempTriggers = db.prepare("SELECT name FROM temp.sqlite_master WHERE type = 'trigger' ORDER BY name").all().map((r) => r.name);
	check(storedTriggers === 0 && JSON.stringify(tempTriggers) === JSON.stringify([
		"financials_ledger_freezes_locked_delete", "financials_ledger_freezes_locked_insert", "financials_ledger_freezes_locked_update",
		"financials_ledger_items_locked_delete", "financials_ledger_items_locked_insert", "financials_ledger_items_locked_update",
		"investor_payouts_locked_delete", "investor_payouts_locked_insert", "investor_payouts_locked_update"]),
		"the triggers are TEMP: on this connection only, none stored in the database file (a rollback to older code never meets them)",
		`stored ${storedTriggers}, temp ${JSON.stringify(tempTriggers)}`);
	const refused = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
	let msg = refused(() => db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status) VALUES (5, '2026-02', 10, '2026-03-27', 'owed')").run());
	check(/PERIOD_FINALIZED/.test(msg), "a direct INSERT into locked 2026-02 is refused by the trigger", `got ${JSON.stringify(msg)}`);
	msg = refused(() => db.prepare("UPDATE investor_payouts SET amount = amount + 1 WHERE owner_id = 5 AND period = '2026-05'").run());
	check(/PERIOD_FINALIZED/.test(msg), "a direct UPDATE of amount in locked 2026-05 is refused", `got ${JSON.stringify(msg)}`);
	msg = refused(() => db.prepare("UPDATE investor_payouts SET adjustment = 50 WHERE owner_id = 5 AND period = '2026-05'").run());
	check(/PERIOD_FINALIZED/.test(msg), "a direct UPDATE of adjustment in locked 2026-05 is refused", `got ${JSON.stringify(msg)}`);
	msg = refused(() => db.prepare("UPDATE investor_payouts SET period = '2026-08' WHERE owner_id = 5 AND period = '2026-05'").run());
	check(/PERIOD_FINALIZED/.test(msg), "moving a row out of locked 2026-05 is refused", `got ${JSON.stringify(msg)}`);
	msg = refused(() => db.prepare("DELETE FROM investor_payouts WHERE owner_id = 5 AND period = '2026-05'").run());
	check(/PERIOD_FINALIZED/.test(msg), "a direct DELETE in locked 2026-05 is refused", `got ${JSON.stringify(msg)}`);
	msg = refused(() => {
		db.prepare("UPDATE investor_payouts SET status = 'processing' WHERE owner_id = 5 AND period = '2026-05'").run();
		db.prepare("UPDATE investor_payouts SET status = 'owed' WHERE owner_id = 5 AND period = '2026-05'").run();
	});
	check(msg === "", "a status move on a locked month's row still goes through (settling is not a change of figures)", `got ${JSON.stringify(msg)}`);
	check(JSON.stringify(rows()) === JSON.stringify(after), "after the refused writes every row is exactly as before", "a refused write changed a row");

	// ── reopening a month still works ────────────────────────────────────────
	setClock("2026-08-14T17:00:00Z");
	const july = () => db.prepare(`SELECT ${ROW_COLS} FROM investor_payouts WHERE owner_id = 5 AND period = '2026-07'`).get();
	const julyBefore = july();
	const reopen = await call("POST /api/periods/:period/reopen", { params: { period: "2026-07" }, body: { reason: "receipt found after close" }, session: { user: SUPER } });
	const lock = db.prepare("SELECT status, reopen_reason FROM period_locks WHERE period = '2026-07'").get();
	check(reopen.status === 200 && lock.status === "reopened" && !july().finalized_at,
		"reopen: the route answers 200, flips the lock and clears July's stamp",
		`status ${reopen.status} ${JSON.stringify(reopen.body)}, lock ${JSON.stringify(lock)}, row ${JSON.stringify(july())}`);
	const reopenAudit = db.prepare("SELECT username, details FROM audit_trail WHERE action = 'period_reopen' AND entity_id = '2026-07'").all();
	check(reopenAudit.length === 1 && /receipt found after close/.test(reopenAudit[0].details),
		"reopen: the reopen is written to the audit log with its reason", `got ${JSON.stringify(reopenAudit)}`);
	db.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, status, owner_id, truck_unit) VALUES (?, ?, 'Repair', 200, '2026-07-20', 'Approved', 5, 'T5')")
		.run("2026-08-14T17:00:00.000Z", E);
	await api.reconcileInvestorPayouts(5, ctx());
	const julyReopened = july();
	check(Math.round(julyReopened.amount * 100) === Math.round(julyBefore.amount * 100) - 10000,
		"reopen: the reconcile moves the reopened month to the new figure (a $200 receipt is $100 less at 50%)",
		`before ${Math.round(julyBefore.amount * 100)}¢, after ${Math.round(julyReopened.amount * 100)}¢`);
	await api.finalizePeriods(["2026-07"], "super_admin");
	const julyClosed = july();
	const relocked = db.prepare("SELECT status FROM period_locks WHERE period = '2026-07'").get().status;
	check(relocked === "locked" && !!julyClosed.finalized_at && Math.round(julyClosed.finalized_amount * 100) === Math.round(julyReopened.amount * 100),
		"reopen: the next close freezes July at its new figure and locks it again",
		`lock ${relocked}, row ${JSON.stringify(julyClosed)}`);
	msg = refused(() => db.prepare("UPDATE investor_payouts SET amount = 1 WHERE owner_id = 5 AND period = '2026-07'").run());
	check(/PERIOD_FINALIZED/.test(msg), "reopen: once closed again, July refuses a figure write", `got ${JSON.stringify(msg)}`);

	// ── adjustments: closed months refuse, corrections post on an open month ──
	setClock("2026-09-10T17:00:00Z");
	await api.reconcileInvestorPayouts(5, ctx());
	const rowOf = (period) => db.prepare("SELECT id, amount, adjustment FROM investor_payouts WHERE owner_id = 5 AND period = ?").get(period);
	const may = rowOf("2026-05");
	const aug = rowOf("2026-08");
	if (!aug) die("the reconcile on 2026-09-10 did not create owner 5's open August row");
	const adjust = (id, adjustment) => call("PUT /api/investor/payouts/:id/adjust", {
		params: { id: String(id) }, body: { adjustment, adjustmentNote: "late fuel receipt for May" }, session: { user: SUPER },
	});
	const closedAdj = await adjust(may.id, -100);
	check(closedAdj.status === 409 && closedAdj.body.code === "PERIOD_FINALIZED" && closedAdj.body.openPeriod === "2026-08" && closedAdj.body.openPayoutId === aug.id,
		"an adjustment on closed May is refused (409 PERIOD_FINALIZED) and names the open month to post it on (August)",
		`got ${closedAdj.status} ${JSON.stringify(closedAdj.body)}`);
	check(refusals.length === 1 && refusals[0].action === "investor_payout_adjust_blocked" && refusals[0].code === "PERIOD_FINALIZED",
		"…and the refusal is audited", `got ${JSON.stringify(refusals)}`);
	check(Number(rowOf("2026-05").adjustment || 0) === Number(may.adjustment || 0), "…and May's row is unchanged", JSON.stringify(rowOf("2026-05")));
	const openAdj = await adjust(aug.id, 100);
	check(openAdj.status === 200 && Number(rowOf("2026-08").adjustment) === 100,
		"a correction posted on open August goes through (a $100 credit)", `got ${openAdj.status} ${JSON.stringify(openAdj.body)}, row ${JSON.stringify(rowOf("2026-08"))}`);

	// ── the close itself, on a second database ──────────────────────────────
	{
		let sheetHook = null;
		const B = buildWorld({ onSheetRead: (bdb) => { if (sheetHook) { const h = sheetHook; sheetHook = null; h(bdb); } } });
		const user = B.db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (?, ?, 'x', ?, ?)");
		user.run(1, "super_admin", "Super Admin", "");
		user.run(5, "inv5", "Investor", "Acme Carrier");
		user.run(6, "inv6", "Investor", "Beta Haul");
		B.db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
		const truck = B.db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, insurance_monthly,
			eld_monthly, truck_payment_monthly, hvut_annual, irp_annual, driver_pay_daily) VALUES (?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, 250)`);
		truck.run(1, "T5", 5, "2026-03-01", "2026-03-01 00:00:00", 1000, 50, 1500, 600, 1200);
		truck.run(3, "T6", 6, "2026-03-01", "2026-03-01 00:00:00", 500, 0, 0, 0, 0);
		const dirB = B.db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_daily) VALUES (?, ?, 'fixed', 0)");
		dirB.run(E, "Acme Carrier");
		dirB.run("Fay Fox", "Beta Haul");
		setClock("2026-03-01T17:00:00Z");
		B.api.assignDriverToTruck(1, E);
		B.api.assignDriverToTruck(3, "Fay Fox");
		SHEET.push(load("7301", "Fay Fox", "4/6/2026", "4/7/2026 8:00", "4/8/2026 10:00", "$3,000.00", "T6", "6"));
		const rowB = (owner, period) => B.db.prepare("SELECT amount, adjustment, finalized_at, finalized_amount FROM investor_payouts WHERE owner_id = ? AND period = ?").get(owner, period);
		const lockB = (period) => B.db.prepare("SELECT status, finalized_at FROM period_locks WHERE period = ?").get(period);
		setClock("2026-09-10T17:00:00Z");

		// A failed compute locks nothing.
		sheetHook = () => { throw new Error("Sheets unavailable"); };
		let threw = "";
		try { await B.api.finalizePeriods(["2026-03"], "system"); } catch (e) { threw = e.message; }
		check(/Sheets unavailable/.test(threw) && !lockB("2026-03") && !rowB(5, "2026-03"),
			"close: a compute that fails locks nothing and stamps nothing", `threw ${JSON.stringify(threw)}, lock ${JSON.stringify(lockB("2026-03"))}`);

		// An investor nobody reconciled before the close gets a row, stamped.
		check(!rowB(6, "2026-04"), "setup: owner 6 has no April row before the close", JSON.stringify(rowB(6, "2026-04")));
		const r34 = await B.api.finalizePeriods(["2026-03", "2026-04"], "system");
		const six = rowB(6, "2026-04");
		check(JSON.stringify(r34.periods) === JSON.stringify(["2026-03", "2026-04"]) && six && !!six.finalized_at && Math.round(six.finalized_amount * 100) === Math.round(six.amount * 100) && six.amount > 0,
			"close: an investor never reconciled before it gets their row created and stamped (owner 6, April)", `result ${JSON.stringify(r34)}, row ${JSON.stringify(six)}`);

		// A month already closed in the batch is skipped; the others close.
		const marchLock = lockB("2026-03");
		const r45 = await B.api.finalizePeriods(["2026-03", "2026-05"], "system");
		check(JSON.stringify(r45.periods) === JSON.stringify(["2026-05"]) && JSON.stringify(lockB("2026-03")) === JSON.stringify(marchLock),
			"close: a month already closed in the batch is skipped, untouched; the rest close", `result ${JSON.stringify(r45)}, march ${JSON.stringify(lockB("2026-03"))}`);

		// A receipt that lands while the figures are computed: nothing closes; the
		// next pass closes the month with the receipt in it.
		const juneBefore = (await B.api.reconcileInvestorPayouts(5, { sessionUser: SUPER, carrierDB: B.api.getCarrierDBFromSQLite(), globalConfig: { investor_split_pct: "50" } }))
			.payouts.find((p) => p.period === "2026-06").amount;
		sheetHook = (bdb) => bdb.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, status, owner_id, truck_unit) VALUES ('2026-09-10T17:00:00.000Z', ?, 'Repair', 400, '2026-06-20', 'Approved', 5, 'T5')").run(E);
		const raced = await B.api.finalizePeriods(["2026-06"], "system");
		check(raced.retry === true && raced.periods.length === 0 && !lockB("2026-06") && !rowB(5, "2026-06").finalized_at,
			"close: a receipt landing while the figures are computed makes it close nothing (retry)", `result ${JSON.stringify(raced)}, lock ${JSON.stringify(lockB("2026-06"))}`);
		await B.api.finalizePeriods(["2026-06"], "system");
		const june = rowB(5, "2026-06");
		check(lockB("2026-06") && lockB("2026-06").status === "locked" && Math.round(june.finalized_amount * 100) === Math.round((juneBefore - 200) * 100),
			"close: the next pass closes it with the receipt counted ($400 receipt, $200 less at 50%)", `before ${juneBefore}, row ${JSON.stringify(june)}`);

		// A correction bigger than the month finally pays is reported at close.
		const julyId = B.db.prepare("SELECT id, amount FROM investor_payouts WHERE owner_id = 5 AND period = '2026-07'").get();
		B.db.prepare("UPDATE investor_payouts SET adjustment = ? WHERE id = ?").run(-Math.round(julyId.amount), julyId.id);
		B.db.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, status, owner_id, truck_unit) VALUES ('2026-09-10T17:00:00.000Z', ?, 'Repair', 1000, '2026-07-20', 'Approved', 5, 'T5')").run(E);
		await B.api.finalizePeriods(["2026-07"], "system");
		const unapplied = B.db.prepare("SELECT entity_id, details FROM audit_trail WHERE action = 'payout_adjustment_unapplied'").all();
		check(unapplied.length === 1 && unapplied[0].entity_id === "5:2026-07" && B.notices.some((n) => /part of a correction was not applied/.test(n.title)),
			"close: an adjustment larger than the month finally pays is reported (audit row and notice), nothing changed",
			`audit ${JSON.stringify(unapplied)}, notices ${JSON.stringify(B.notices.map((n) => n.title))}`);
		check(B.notices.every((n) => !/\$\s?\d/.test(`${n.title} ${n.body}`)) && /\$/.test(unapplied[0].details),
			"close: the notice carries no money figures; the audit row does", JSON.stringify(B.notices.map((n) => n.body)));

		// A payout row that appears while the figures are computed, for an owner the
		// close did not reconcile: nothing closes (it would be locked without its
		// snapshot); the next pass reconciles that owner too and closes the month.
		sheetHook = (bdb) => bdb.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status) VALUES (99, '2026-01', 0, '2026-02-27', 'owed')").run();
		const leftover = await B.api.finalizePeriods(["2026-01"], "system");
		check(leftover.retry === true && !lockB("2026-01"), "close: a row the close did not reconcile makes it close nothing (retry)", JSON.stringify(leftover));
		await B.api.finalizePeriods(["2026-01"], "system");
		const row99 = B.db.prepare("SELECT finalized_at FROM investor_payouts WHERE owner_id = 99 AND period = '2026-01'").get();
		check(lockB("2026-01") && lockB("2026-01").status === "locked" && !!row99.finalized_at, "close: …the next pass reconciles that owner too, stamps the row and closes the month", JSON.stringify(row99));

		// Two closes of one month at once: one closes it, the other closes nothing.
		const raceResults = await Promise.all([B.api.finalizePeriods(["2026-02"], "system"), B.api.finalizePeriods(["2026-02"], "super_admin")]);
		const closedBy = raceResults.filter((r) => r.periods.includes("2026-02")).length;
		const other = raceResults.find((r) => !r.periods.includes("2026-02"));
		check(closedBy === 1 && other && other.retry === true && other.reason === "closed" && lockB("2026-02").status === "locked",
			"close: two closes of one month at once — one closes it, the other closes nothing (another close got there first)", JSON.stringify(raceResults));

		// An unreadable lock table closes nothing, and says so by throwing.
		B.db.exec("ALTER TABLE period_locks RENAME TO period_locks_saved; CREATE TABLE period_locks (period TEXT PRIMARY KEY, finalized_at TEXT)");
		let unreadable = "";
		try { await B.api.finalizePeriods(["2026-09"], "system"); } catch (e) { unreadable = e.message; }
		check(/period_locks could not be read/.test(unreadable) && !B.db.prepare("SELECT 1 FROM period_locks WHERE period = '2026-09'").get(),
			"close: an unreadable lock table closes nothing and throws (the sweep counts it as a failure)", JSON.stringify(unreadable));
		B.db.exec("DROP TABLE period_locks; ALTER TABLE period_locks_saved RENAME TO period_locks");

		// The cancel check.
		const rowArr = (o) => HEADERS.map((h) => o[h]);
		const idx = HEADERS.indexOf("Job Status");
		const may = load("7401", E, "5/11/2026", "5/12/2026 8:00", "5/13/2026 10:00", "$1.00", "T5", "5");
		const aug = load("7402", E, "8/11/2026", "8/12/2026 8:00", "8/13/2026 10:00", "$1.00", "T5", "5");
		const transit = { ...may, "Job Status": "In Transit" };
		const undated = { ...may, "Assigned Date": "", "Pickup Appointment": "", "Drop-off Appointment": "" };
		const refusal = (o) => { const x = B.api.completedLoadCancelRefusal([...HEADERS], rowArr(o), idx); return x ? x.code : null; };
		check(refusal(may) === "PERIOD_FINALIZED", "cancel: a completed load in closed May is refused (PERIOD_FINALIZED)", String(refusal(may)));
		check(refusal(aug) === null, "cancel: a completed load in open August goes ahead", String(refusal(aug)));
		check(refusal(transit) === null, "cancel: a load not yet completed goes ahead in closed May (#211)", String(refusal(transit)));
		check(refusal(undated) === "PERIOD_UNRESOLVED", "cancel: a completed load with no readable date is refused (PERIOD_UNRESOLVED)", String(refusal(undated)));
		check(B.errors.length === 0, "the second database's lifted code logged no error", B.errors.join(" | "));
	}

	check(errors.length === 0, "the lifted code logged no error", errors.join(" | "));

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => die(`crashed: ${e.stack || e.message}`));
