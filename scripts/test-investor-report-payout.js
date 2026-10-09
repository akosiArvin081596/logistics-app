#!/usr/bin/env node
/**
 * GET /api/investor/report's payout is a READER of the payouts ledger, not a
 * formula of its own.
 *
 * THE BUG (fixed 2026-09-30). The downloadable report printed
 * "Investor Payout (X%)" as (revenue − expenses) × split over the report period:
 * no driver pay, no idle-month rule (a month with no activity is not charged its
 * fixed costs) and no loss carry-forward. So it printed MORE than the portal and
 * the payouts ledger for the same month, and a NEGATIVE payout for an idle month.
 * On a local copy of production the gap was exactly the missing driver pay ×
 * split, plus any carried-in loss, and an idle month printed its fixed costs ×
 * split as a negative payout.
 *
 * Its fixed-cost lines had the same fault: they charged every month from a truck's
 * in-service date, including idle months and months before the investor's first
 * load, which the ledger never charges.
 *
 * WHAT IS PROVED HERE
 *   §1  one definition of each new helper, and the report handler calls them
 *       (source pins, on a comment-stripped copy: the comments quote the old form)
 *   §2  THE REAL reconcileInvestorPayouts(), lifted out of server.js and run
 *       against a real SQLite investor_payouts table, feeds the report; for a
 *       driver-pay month, an idle month, a loss month, a carry-forward month, the
 *       open month and all-time, the report's payout equals the ledger's own
 *       published figure AND an independent hand-computed oracle
 *   §3  frozen rows are read, never restated: a paid row with a correction prints
 *       its settled amount + correction; an owed row in a closed period keeps its
 *       stored amount; the DB rows are unchanged afterwards
 *   §4  the fleet-wide (Super Admin) report: the same monthly array and carry
 *       walk the Super Admin's portal view uses, and no ledger write
 *   §5  report ranges: day strings map to month keys by string slice (no UTC
 *       shift), a mid-month day takes the whole month, junk is unbounded
 *   §6  the fixed-cost block, extracted from the SHIPPED handler and run: it
 *       charges exactly the months the ledger charged, so the P&L's fixed costs
 *       equal the ledger's fixed costs over the range
 *   §7  the note printed under the P&L says only what is true of the range; every
 *       sentence is a template in lib/investor-report-options.js (NOTE), the ones
 *       from before 2026-09-30 unchanged, plus the date-range sentence of each
 *       RANGE_MODE ("whole-months" / "exact-dates")
 *   §8  MUTANTS: the report's old formula (behavioural), the handler reverting
 *       to it (source), the fixed-cost loop ignoring the idle rule, and the note
 *       without its date-range sentence
 *   §9  THE FLEET REPORT AT MONTH END. computeInvestorMonthlyEarnings() builds its
 *       months up to the SERVER's month, which on a UTC clock is already the next
 *       one from 8 PM EDT on the last day of a month. Recreated with the REAL
 *       computeInvestorMonthlyEarnings() under a stubbed clock (TZ=UTC,
 *       2026-09-30 21:30 EDT): its array ends in October while the business clock
 *       (APP_TIMEZONE) is still in September. The fleet reader stops at the
 *       business month; its mutant (no
 *       filter) prints October in the report's months and note.
 *   §10 THE DATE RANGE IS CHECKED FIRST. The handler, lifted whole: a date that is
 *       not a real YYYY-MM-DD day, or a start after the end, answers 400 before the
 *       sheet is read or the payout ledger is reconciled (it used to answer 500
 *       AFTER the reconcile had run). Its mutant (no check) reaches the reconcile.
 *
 * WHY IT LOADS THE CODE OUT OF server.js SOURCE INSTEAD OF require()-ING IT:
 * server.js opens SQLite, reads a service-account key and listens on import.
 * Same approach as test-payout-carry-freeze.js; every extraction asserts exactly
 * one definition, so a rename fails loudly instead of testing nothing.
 *
 * Run: node scripts/test-investor-report-payout.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const investorReportOptions = require("../lib/investor-report-options");
const investorPayoutBasis = require("../lib/investor-payout-basis");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
const failures = [];
function ok(cond, label) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.error(`  ✗ ${label}`);
}
function eq(actual, expected, label) {
	ok(JSON.stringify(actual) === JSON.stringify(expected),
		`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log(`\n${t}`); }

// ---------------------------------------------------------------- extraction
function extractFn(name) {
	const plain = `\nfunction ${name}(`;
	const asyncy = `\nasync function ${name}(`;
	const hits = (SRC.split(plain).length - 1) + (SRC.split(asyncy).length - 1);
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const needle = SRC.includes(asyncy) ? asyncy : plain;
	const start = SRC.indexOf(needle) + 1;
	// Skip the parameter list first: several of these destructure their argument
	// (`({ ownerId, … })`, `{ fleet = false } = {}`), so the first `{` after the
	// name is NOT the body.
	let paren = 0;
	let body = -1;
	for (let j = SRC.indexOf("(", start); j < SRC.length; j++) {
		if (SRC[j] === "(") paren++;
		else if (SRC[j] === ")") { paren--; if (paren === 0) { body = SRC.indexOf("{", j); break; } }
	}
	if (body < 0) throw new Error(`could not find the body of ${name}()`);
	let depth = 0;
	for (let j = body; j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}
// Line comments only (every comment in these bodies is a `//` line), so a string
// holding `//` (a URL) is never mangled.
const stripComments = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/ .*$/, "")).join("\n");

const REPORT_START = SRC.indexOf('app.get("/api/investor/report"');
if (REPORT_START < 0) throw new Error("GET /api/investor/report not found");
const REPORT_END = SRC.indexOf("\napp.", REPORT_START + 10);
const HANDLER = SRC.slice(REPORT_START, REPORT_END > REPORT_START ? REPORT_END : SRC.length);

const NAMES = [
	"resolveInvestorSplitPct", "lastFridayOfFollowingMonth", "periodLabel", "computeLossCarryForward",
	"payoutRowBreakdown", "frozenPayoutBreakdown", "reconcileInvestorPayouts", "reportRangeMonthKeys", "investorReportPayoutEntries",
	"summarizeReportPayout", "reportPayoutNote",
	"truckMonthlyFixed", "truckChargeFromMonth", "truckChargeUntilMonth", "truckChargedInMonth",
];
const SOURCES = Object.fromEntries(NAMES.map((n) => [n, extractFn(n)]));

// The dependencies server.js would supply at module scope. computeInvestorMonthlyEarnings
// is the INPUT (a fixture monthly array); everything that turns it into a payout —
// the ledger reconcile, the carry walk, the report's reader — is the shipped code.
function load(deps) {
	return new Function("deps", "investorPayoutBasis", `
		const { db, computeInvestorMonthlyEarnings, isLocked, periodWriteLocked, appMonthKey,
			recordPayoutChange, getInvestorDriverSet, findCol, settlementGraceDays, periodPhase, graceEndsAt,
			investorReportOptions, payoutRules } = deps;
		${NAMES.map((n) => SOURCES[n]).join("\n")}
		return { ${NAMES.join(", ")} };
	`)(deps, investorPayoutBasis);
}

// ------------------------------------------------------------------ fixtures
// Split 50%. Fixed costs per month are the truck fixture's (§6) so the P&L can be
// checked against the same months: 2026-04/05 trucks A + D = 2,200; 2026-06 is
// IDLE (A would cost 1,900, the ledger charges 0); 2026-07 A = 1,900; 2026-08/09
// A + B = 2,400.
const CURRENT = "2026-09";
const FIXTURE = [
	{ month: "2026-04", revenue: 6000, driverPay: 1000, fixedCosts: 2200, tripExpenses: 0 },     // net 2,800 → 1,400
	{ month: "2026-05", revenue: 10000, driverPay: 3000, fixedCosts: 2200, tripExpenses: 1000 }, // DRIVER PAY: net 3,800 → 1,900
	{ month: "2026-06", revenue: 0, driverPay: 0, fixedCosts: 0, tripExpenses: 0 },              // IDLE → 0
	{ month: "2026-07", revenue: 1000, driverPay: 1500, fixedCosts: 1900, tripExpenses: 0 },     // LOSS: −2,400 → −1,200, pays 0
	{ month: "2026-08", revenue: 8000, driverPay: 2000, fixedCosts: 2400, tripExpenses: 0 },     // CARRY: 1,800 − 1,200 carried in = 600
	{ month: "2026-09", revenue: 5000, driverPay: 1000, fixedCosts: 2400, tripExpenses: 0 },     // OPEN: 800 if it closed today
];
// What the report's old formula charged in fixed costs: the trucks' raw cost in
// every month, the idle one included.
const RAW_FIXED = { "2026-04": 2200, "2026-05": 2200, "2026-06": 1900, "2026-07": 1900, "2026-08": 2400, "2026-09": 2400 };

// The shape computeInvestorMonthlyEarnings() returns (see its monthlyEarnings.push).
function monthlyEarningsFixture() {
	return FIXTURE.map((f) => {
		const netProfit = f.revenue - f.driverPay - f.fixedCosts - f.tripExpenses;
		return {
			month: f.month, revenue: f.revenue, driverPay: f.driverPay, fixedCosts: f.fixedCosts,
			tripExpenses: f.tripExpenses, maintFundCost: 0, complianceCost: 0, netProfit,
			exact: { revenue: f.revenue, driverPay: f.driverPay, fixedCosts: f.fixedCosts, tripExpenses: f.tripExpenses, maintFundCost: 0, complianceCost: 0, netProfit },
			investorEarnings: Math.round(netProfit * 0.5),
			isCurrentMonth: f.month === CURRENT,
		};
	});
}

// ⚠️ THE ORACLE, written by hand from the rules as the portal states them, NOT by
// running any code under test: a month pays its share after earlier losses, never
// below $0; a settled row pays its settled amount plus its correction.
const ORACLE_INVESTOR = { "2026-04": 1200, "2026-05": 1900, "2026-06": 0, "2026-07": 0, "2026-08": 600, "2026-09": 800 };
const ORACLE_FLEET = { "2026-04": 1400, "2026-05": 1900, "2026-06": 0, "2026-07": 0, "2026-08": 600, "2026-09": 800 };

function schema(db) {
	const create = SRC.match(/CREATE TABLE IF NOT EXISTS investor_payouts \([\s\S]*?\n\t\)/);
	if (!create) throw new Error("investor_payouts CREATE TABLE not found in server.js");
	db.exec(create[0]);
	for (const m of SRC.matchAll(/db\.exec\("(ALTER TABLE investor_payouts ADD COLUMN [^"]+)"\)/g)) db.exec(m[1]);
	// The reconcile layers each owner's investor_config rows over the global ones.
	// Its post-migration shape (server.js migrates key-only → (owner_id, key)); no
	// per-owner rows here, so every owner takes the global 50%.
	db.exec("CREATE TABLE investor_config (owner_id INTEGER NOT NULL DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (owner_id, key))");
}

function world({ locked = [] } = {}) {
	const db = new Database(":memory:");
	schema(db);
	const lockedSet = new Set(locked);
	const calls = [];
	const history = [];
	const fns = load({
		db,
		computeInvestorMonthlyEarnings: async (args) => {
			calls.push(args);
			return { monthlyEarnings: monthlyEarningsFixture(), currentMonthKey: CURRENT, detail: null };
		},
		isLocked: (p) => lockedSet.has(p),
		periodWriteLocked: (p) => lockedSet.has(p),
		appMonthKey: () => CURRENT,
		recordPayoutChange: (x) => history.push(x),
		getInvestorDriverSet: () => new Set(),
		findCol: (headers, re) => (headers || []).find((h) => re.test(h)) || null,
		settlementGraceDays: () => 7,
		periodPhase: () => "",
		graceEndsAt: () => "",
		investorReportOptions,
		// The 2026-10 payout rules, as they ship: off.
		payoutRules: () => ({ datedAttribution: false, datedRates: false, futureReceipts: false, frozenCarry: false }),
	});
	return { db, fns, calls, history };
}
const CTX = { sessionUser: { id: 1, role: "Super Admin", username: "sa" }, carrierDB: { headers: ["Driver", "Carrier"], data: [] }, globalConfig: { investor_split_pct: "50" }, config: { investor_split_pct: "50" } };

(async () => {
	// ======================================================= §1 source pins
	section("§1 one definition each, and the report handler reads through them");
	{
		for (const n of ["reportRangeMonthKeys", "investorReportPayoutEntries", "summarizeReportPayout", "reportPayoutNote"]) {
			ok(SOURCES[n].length > 50, `${n}() is defined exactly once in server.js`);
		}
		const h = stripComments(HANDLER);
		eq((h.match(/investorReportPayoutEntries\(/g) || []).length, 1, "the handler calls investorReportPayoutEntries() once");
		ok(/summarizeReportPayout\(\s*await investorReportPayoutEntries\(/.test(h), "the handler sums the ledger's months with summarizeReportPayout()");
		ok(/reportRangeMonthKeys\(dateRange\.from, dateRange\.until\)/.test(h), "the payout months come from reportRangeMonthKeys() over the checked range");
		ok(/ownerId: reportOwnerId,/.test(h), "the reader is scoped by the handler's own reportOwnerId (null = fleet)");

		// The date range: checked first, by the options module, under its RANGE_MODE.
		const CHECK = "const dateRange = investorReportOptions.reportDateRange(req.query.start, req.query.end, investorReportOptions.RANGE_MODE);";
		eq(h.split(CHECK).length - 1, 1, "the handler checks the range once, with reportDateRange() under RANGE_MODE");
		for (const later of ["resolvePreviewUser(", "getSheets(", "investorReportPayoutEntries(", "logAudit("]) {
			ok(h.indexOf(CHECK) >= 0 && h.indexOf(CHECK) < h.indexOf(later), `…before ${later.slice(0, -1)}()`);
		}
		ok(/if \(!dateRange\.ok\) \{\s*return res\.status\(dateRange\.status\)\.json\(/.test(h), "…and answers the refusal's own status");
		ok(/const filterStart = dateRange\.from \? new Date\(dateRange\.from\) : null;/.test(h)
			&& /const filterEnd = dateRange\.until \? new Date\(dateRange\.until \+ 'T23:59:59'\) : null;/.test(h),
			"revenue and trip expenses filter on the checked range, parsed as before");
		ok(!/req\.query\.(start|end)/.test(h.replace(CHECK, "")), "…and nothing else reads the raw start / end");
		ok(/reportPayoutNote\(reportPayout, \{ fleet: reportOwnerId === null, range: dateRange, rangeMode: investorReportOptions\.RANGE_MODE \}\)/.test(h),
			"the note is told the checked range and RANGE_MODE");
		ok(/requireRole\("Super Admin", "Investor"\), investorReportLimiter, async \(req, res\)/.test(HANDLER),
			"the route is rate-limited per user, the limiter mounted after requireRole");

		const reader = stripComments(SOURCES.investorReportPayoutEntries);
		ok(/await reconcileInvestorPayouts\(ownerId, \{ sessionUser, carrierDB, globalConfig \}\)/.test(reader),
			"an investor's months come from the LEDGER (reconcileInvestorPayouts)");
		ok(/payout: p\.effectiveAmount,/.test(reader), "a completed month reads the ledger row's effectiveAmount");
		ok(/payout: currentMonth\.payableIfClosedNow,/.test(reader), "the open month reads currentMonth.payableIfClosedNow");
		ok(/computeInvestorMonthlyEarnings\(\{/.test(reader) && /const months = monthlyEarnings\.filter\(\(m\) => m\.month <= currentMonthKey\);\s*const carryByPeriod = computeLossCarryForward\(months\);/.test(reader),
			"the fleet path runs the shared monthly computation and the shared carry walk, up to the business month (§9)");
		for (const [n, src] of [["investorReportPayoutEntries", reader], ["summarizeReportPayout", stripComments(SOURCES.summarizeReportPayout)]]) {
			ok(!/resolveInvestorSplitPct|investorSplit|splitPct|\/ 100/.test(src), `${n}() applies no split of its own`);
			ok(!/let deficit/.test(src), `${n}() carries no copy of the carry-forward walk`);
		}
		const note = stripComments(SOURCES.reportPayoutNote);
		ok(/investorReportOptions\.NOTE/.test(note) && !/"[A-Z][a-z]+ [a-z]+ [a-z]+/.test(note) && !/`[^`]*\b(payout|month|settled)\b[^`]*`/i.test(note),
			"reportPayoutNote() prints no sentence of its own: every one is a template in investorReportOptions.NOTE");
	}

	// ====================================== §2 the report equals the ledger
	section("§2 the report's payout equals the ledger's own figure, month by month and all-time");
	let ledgerOut, entries, W;
	{
		W = world();
		// A frozen, corrected month: paid at 1,300 before the records changed (live is
		// now 1,400), with a −100 correction recorded afterwards.
		W.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status, paid_at, adjustment, finalized_at) VALUES (5, '2026-04', 1300, '2026-05-29', 'paid', '2026-05-29T00:00:00Z', -100, '2026-05-08T00:00:00Z')").run();
		entries = await W.fns.investorReportPayoutEntries({ ownerId: 5, ...CTX });
		// The ledger's OWN answer, from a second, independent reconcile call — the
		// Payouts page's view of the same rows.
		ledgerOut = await W.fns.reconcileInvestorPayouts(5, CTX);
		const ledgerFor = (mk) => {
			const p = ledgerOut.payouts.find((x) => x.period === mk);
			return p ? p.effectiveAmount : (ledgerOut.currentMonth.period === mk ? ledgerOut.currentMonth.payableIfClosedNow : null);
		};
		const S = W.fns.summarizeReportPayout;
		for (const f of FIXTURE) {
			const got = S(entries, { from: f.month, until: f.month }).payout;
			eq(got, ledgerFor(f.month), `${f.month}: report payout === the ledger's figure`);
			eq(got, ORACLE_INVESTOR[f.month], `${f.month}: report payout === the hand oracle`);
		}
		const all = S(entries, { from: "", until: "" });
		const oracleAll = Object.values(ORACLE_INVESTOR).reduce((s, v) => s + v, 0);
		eq(all.payout, oracleAll, "all-time: report payout === the sum of the monthly payouts (4,500)");
		eq(all.payout, ledgerOut.payouts.reduce((s, p) => s + p.effectiveAmount, 0) + ledgerOut.currentMonth.payableIfClosedNow,
			"all-time: report payout === the ledger's rows + the open month's projection");
		eq(all.driverPay, 8500, "all-time: driver pay is the monthly driver pay summed (8,500)");
		eq(all.chargedFixedMonths, ["2026-04", "2026-05", "2026-07", "2026-08", "2026-09"], "the idle month is not a charged fixed-cost month");
		eq(all.inProgressMonth, CURRENT, "the open month is flagged in progress");
		ok(all.carried, "the loss/carry months are flagged");
		ok(entries.every((e) => e.payout >= 0), "no month's payout is negative (the old formula printed a negative payout for an idle month)");
		ok(W.calls.every((c) => c.investorOwnerId === 5 && c.isSuperAdmin === false), "the ledger computed the investor's own scope");
	}

	// ============================================ §3 frozen rows are read
	section("§3 frozen rows are read, never restated");
	{
		const apr = entries.find((e) => e.month === "2026-04");
		eq(apr.payout, 1200, "a paid row prints its settled amount + correction (1,300 − 100), not the live 1,400");
		ok(apr.settledDiffers && apr.corrected, "the paid row is flagged as differing from current records and corrected");
		const row = W.db.prepare("SELECT amount, status, adjustment FROM investor_payouts WHERE owner_id = 5 AND period = '2026-04'").get();
		eq(row, { amount: 1300, status: "paid", adjustment: -100 }, "the paid row is unchanged in the DB after the report ran");
		eq(W.history.length, 0, "no payout history line was written (nothing moved)");

		// An OWED row in a CLOSED period keeps its stored figure — the lock leg the
		// report inherits by reading through reconcileInvestorPayouts.
		const L = world({ locked: ["2026-08"] });
		L.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status) VALUES (6, '2026-08', 555, '2026-09-25', 'owed')").run();
		const le = await L.fns.investorReportPayoutEntries({ ownerId: 6, ...CTX });
		eq(L.fns.summarizeReportPayout(le, { from: "2026-08", until: "2026-08" }).payout, 555, "an owed row in a closed period prints its stored 555, not the live 600");
		eq(L.db.prepare("SELECT amount FROM investor_payouts WHERE owner_id = 6 AND period = '2026-08'").get().amount, 555, "…and the row is not refreshed");

		// Control: the same row with the period open IS refreshed to the live figure,
		// so the check above is the lock working and not the row being ignored.
		const O = world();
		O.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status) VALUES (6, '2026-08', 555, '2026-09-25', 'owed')").run();
		const oe = await O.fns.investorReportPayoutEntries({ ownerId: 6, ...CTX });
		eq(O.fns.summarizeReportPayout(oe, { from: "2026-08", until: "2026-08" }).payout, 600, "control: the same row in an OPEN period follows the live 600");
	}

	// ======================================================== §4 fleet
	section("§4 the fleet-wide report (a Super Admin, not previewing)");
	{
		const F = world();
		const fe = await F.fns.investorReportPayoutEntries({ ownerId: null, ...CTX });
		ok(F.calls.length === 1 && F.calls[0].isSuperAdmin === true && F.calls[0].investorOwnerId === null && F.calls[0].investorDriverSet === null,
			"the fleet report runs the shared monthly computation at fleet scope");
		for (const f of FIXTURE) {
			eq(F.fns.summarizeReportPayout(fe, { from: f.month, until: f.month }).payout, ORACLE_FLEET[f.month], `fleet ${f.month}: the carry walk's payable`);
		}
		eq(F.db.prepare("SELECT COUNT(*) AS n FROM investor_payouts").get().n, 0, "the fleet report writes no ledger row");
	}

	// ======================================================= §5 ranges
	section("§5 report ranges → month keys");
	{
		const K = W.fns.reportRangeMonthKeys;
		eq(K("2026-05-15", "2026-08-02"), { from: "2026-05", until: "2026-08" }, "mid-month days take their whole months");
		eq(K("2026-08-01", ""), { from: "2026-08", until: "" }, "2026-08-01 is August (no UTC-midnight slide into July)");
		eq(K(undefined, undefined), { from: "", until: "" }, "no range = unbounded");
		eq(K("garbage", "2026-13-01"), { from: "", until: "" }, "unreadable values are unbounded, like the report's own filter");
		eq(K(" 2026-07-31 ", "2026-07-31"), { from: "2026-07", until: "2026-07" }, "whitespace is trimmed");
		const mid = W.fns.summarizeReportPayout(entries, K("2026-05-15", "2026-08-02"));
		eq(mid.months, ["2026-05", "2026-06", "2026-07", "2026-08"], "a May 15 – Aug 2 report covers May–August");
		eq(mid.payout, 1900 + 0 + 0 + 600, "…and pays those four months (2,500)");
		eq(W.fns.summarizeReportPayout(entries, K("2027-01-01", "2027-02-01")).payout, 0, "a range with no months pays 0");
	}

	// ============================================ §6 the shipped fixed-cost block
	section("§6 the fixed-cost lines charge exactly the months the ledger charged");
	const TRUCKS = [
		{ unit_number: "A", status: "Active", created_at: "2026-03-20 10:00:00", in_service_date: "2026-04-01", retired_at: "", insurance_monthly: 1000, eld_monthly: 100, truck_payment_monthly: 500, hvut_annual: 1200, irp_annual: 2400 },
		{ unit_number: "B", status: "Active", created_at: "2026-05-21 10:00:00", in_service_date: "2026-08-04", retired_at: "", insurance_monthly: 500, eld_monthly: 0, truck_payment_monthly: 0, hvut_annual: 0, irp_annual: 0 },
		{ unit_number: "C", status: "Inactive", created_at: "2026-01-01 10:00:00", in_service_date: "2026-01-01", retired_at: "", insurance_monthly: 9999, eld_monthly: 0, truck_payment_monthly: 0, hvut_annual: 0, irp_annual: 0 },
		{ unit_number: "D", status: "Active", created_at: "2026-01-01 10:00:00", in_service_date: "2026-01-01", retired_at: "2026-05-15", insurance_monthly: 0, eld_monthly: 0, truck_payment_monthly: 300, hvut_annual: 0, irp_annual: 0 },
	];
	function fixedBlockOf(h) {
		const anchor = h.indexOf("reportPayout.chargedFixedMonths)");
		if (anchor < 0) throw new Error("§6 the report's fixed-cost loop over reportPayout.chargedFixedMonths was not found");
		const open = h.lastIndexOf("\n\t\t{\n", anchor);
		let depth = 0;
		for (let j = open + 3; j < h.length; j++) {
			if (h[j] === "{") depth++;
			else if (h[j] === "}") { depth--; if (depth === 0) return h.slice(open + 3, j + 1); }
		}
		throw new Error("§6 unbalanced braces around the fixed-cost block");
	}
	function runFixedBlock(block, reportPayout, trucks = TRUCKS) {
		const f = new Function("ownedTrucks2", "reportPayout", "investorDriverSet", "user", "db", "truckChargedInMonth", "truckMonthlyFixed", "investorPayoutBasis", `
			let complianceExpenses = 0, truckPaymentExpenses = 0, insuranceExpenses = 0, totalExpenses = 0;
			${block}
			return { complianceExpenses, truckPaymentExpenses, insuranceExpenses, totalExpenses };
		`);
		const db = { prepare: () => ({ get: () => ({ t: 0 }) }) };
		return f(trucks, reportPayout, new Set(), { id: 5 }, db, W.fns.truckChargedInMonth, W.fns.truckMonthlyFixed, require("../lib/investor-payout-basis"));
	}
	const FIXED_BLOCK = fixedBlockOf(HANDLER);
	{
		const all = W.fns.summarizeReportPayout(entries, { from: "", until: "" });
		const got = runFixedBlock(FIXED_BLOCK, all);
		// Hand oracle: A (1,900/mo: ins 1,000, pay 500, eld+hvut+irp 400) Apr, May,
		// Jul, Aug, Sep; B (500 ins) Aug, Sep; D (300 pay) Apr, May (retired May 15);
		// C inactive; June idle.
		eq(got, { complianceExpenses: 2000, truckPaymentExpenses: 3100, insuranceExpenses: 6000, totalExpenses: 11100 }, "all-time buckets (hand oracle)");
		const ledgerFixed = FIXTURE.reduce((s, f) => s + f.fixedCosts, 0);
		eq(got.totalExpenses, ledgerFixed, "the P&L's fixed costs === the ledger's fixed costs over the range (11,100)");
		const apr = runFixedBlock(FIXED_BLOCK, W.fns.summarizeReportPayout(entries, { from: "2026-06", until: "2026-06" }));
		eq(apr.totalExpenses, 0, "an idle month charges no fixed costs (the old loop charged truck A's 1,900)");
		// Maintenance and OOS are in the fleet (2026-09-30): a truck in the shop still
		// owes its costs. C stays Inactive and stays out.
		for (const status of ["Maintenance", "OOS"]) {
			const shop = TRUCKS.map((t) => (t.unit_number === "A" ? { ...t, status } : t));
			eq(runFixedBlock(FIXED_BLOCK, all, shop), got, `truck A in ${status}: every bucket as with it Active (C, Inactive, still excluded)`);
		}
	}

	// ============================================================ §7 note
	section("§7 the note under the P&L says only what is true of the range");
	{
		const N = W.fns.reportPayoutNote;
		const S = (r) => W.fns.summarizeReportPayout(entries, r);
		const all = N(S({ from: "", until: "" }));
		ok(all.startsWith("Investor Payout is the total of your monthly payouts for April 2026 – September 2026, the same figures as your Payouts page."), "all-time: names the months and the Payouts page");
		ok(all.includes("September 2026 is still in progress, so its figure is the projected payout if the month closed today."), "all-time: names the open month");
		ok(all.includes("A month that ran at a loss pays nothing; the shortfall is carried against later months rather than billed back to you."), "all-time: explains the carry");
		ok(all.includes("Your payout for April 2026 is the amount that month was settled at. The figures above reflect current records, which have changed since it closed."), "all-time: names the settled month that no longer matches current records");
		ok(all.includes("The payout for April 2026 includes a correction shown on your Payouts page."), "all-time: names the corrected month");
		eq(N(S({ from: "2026-05", until: "2026-05" })), "Investor Payout is the total of your monthly payouts for May 2026, the same figures as your Payouts page.", "a clean month carries no conditional sentence");
		eq(N(S({ from: "2027-01", until: "2027-02" })), "No payout month falls in this report period.", "an empty range says so");
		const fleet = N(S({ from: "2026-05", until: "2026-05" }), { fleet: true });
		ok(fleet.includes("fleet-wide monthly investor shares for May 2026") && !fleet.includes("Payouts page"), "the fleet note does not point at an investor's Payouts page");

		// A lease sentence per stretch of lease months. A stretch a split month
		// follows names its months, so it does not read as running on.
		const lease = (amount) => ({ type: "lease", leaseAmount: amount });
		const basisNote = (bases) => {
			const es = bases.map((b, i) => ({ month: `2026-0${i + 5}`, payout: 0, driverPay: 0, fixedCosts: 0, ...(b ? { payoutBasis: b } : {}) }));
			return N(W.fns.summarizeReportPayout(es, { from: "", until: "" })).replace(/^Investor Payout is the total[^.]*\. ?/, "");
		};
		eq(basisNote([null, null]), "", "no lease month: no lease sentence (a split investor's note is unchanged)");
		eq(basisNote([lease(2000), lease(2000)]), "Your payout is a fixed monthly lease of $2,000, not a share of net profit.", "every month one lease: NOTE.LEASE");
		eq(basisNote([null, lease(2000), lease(2000)]), "From June 2026, your payout is a fixed monthly lease of $2,000, not a share of net profit.",
			"split, then a lease to the end of the range: NOTE.LEASE_FROM");
		eq(basisNote([lease(2000), lease(2000), null]), "For May 2026 – June 2026, your payout is a fixed monthly lease of $2,000, not a share of net profit.",
			"a lease, then back to split: NOTE.LEASE_DURING names the lease months");
		eq(basisNote([null, lease(2000), null, lease(2500)]),
			"For June 2026, your payout is a fixed monthly lease of $2,000, not a share of net profit. From August 2026, your payout is a fixed monthly lease of $2,500, not a share of net profit.",
			"one lease month between splits names that month, and a later lease runs from its start");
		eq(basisNote([lease(2000), lease(2500)]),
			"From May 2026, your payout is a fixed monthly lease of $2,000, not a share of net profit. From June 2026, your payout is a fixed monthly lease of $2,500, not a share of net profit.",
			"a lease followed by a new amount keeps NOTE.LEASE_FROM for each");

		// The sentences from before 2026-09-30 moved into NOTE word for word: the
		// text below is what reportPayoutNote() printed at d8a4a64, typed out.
		const T = investorReportOptions.NOTE;
		eq([T.INVESTOR, T.FLEET, T.NO_MONTHS, T.IN_PROGRESS, T.CARRIED, T.SETTLED_DIFFERS_ONE, T.SETTLED_DIFFERS_MANY, T.CORRECTED], [
			"Investor Payout is the total of your monthly payouts for {span}, the same figures as your Payouts page.",
			"Investor Payout is the total of the fleet-wide monthly investor shares for {span}.",
			"No payout month falls in this report period.",
			"{month} is still in progress, so its figure is the projected payout if the month closed today.",
			"A month that ran at a loss pays nothing; the shortfall is carried against later months rather than billed back to you.",
			"Your payout for {months} is the amount that month was settled at. The figures above reflect current records, which have changed since it closed.",
			"Your payouts for {months} are the amounts those months were settled at. The figures above reflect current records, which have changed since they closed.",
			"The payout for {months} includes a correction shown on your Payouts page.",
		], "the note's earlier sentences are unchanged templates");

		// The date-range sentence, by RANGE_MODE. The handler passes the range
		// reportDateRange() returned: whole months in "whole-months" mode.
		const R = (start, end, mode) => investorReportOptions.reportDateRange(start, end, mode);
		const may = S({ from: "2026-05", until: "2026-05" });
		const WHOLE = "Payouts are settled by month, so this report covers the whole of each month in your date range: ";
		eq(N(S({ from: "2026-05", until: "2026-08" }), { range: R("2026-05-15", "2026-08-02", "whole-months"), rangeMode: "whole-months" }).split(". Investor Payout")[0] + ".",
			`${WHOLE}May 2026 – August 2026.`, "whole-months, a mid-month range: the sentence names the whole months, before the payout lead");
		eq(N(may, { range: R("2026-05-15", "2026-05-20", "whole-months"), rangeMode: "whole-months" }),
			`${WHOLE}May 2026. Investor Payout is the total of your monthly payouts for May 2026, the same figures as your Payouts page.`,
			"whole-months, a range inside one month: one month, then the lead");
		ok(N(may, { range: R("2026-05-15", "", "whole-months"), rangeMode: "whole-months" }).startsWith(`${WHOLE}May 2026 onward.`), "whole-months, a start date only: \"May 2026 onward\"");
		ok(N(may, { range: R("", "2026-05-15", "whole-months"), rangeMode: "whole-months" }).startsWith(`${WHOLE}through May 2026.`), "whole-months, an end date only: \"through May 2026\"");
		ok(N(may, { fleet: true, range: R("2026-05-15", "2026-05-20", "whole-months"), rangeMode: "whole-months" })
			.startsWith("Payouts are settled by month, so this report covers the whole of each month in the date range: May 2026. Investor Payout is the total of the fleet-wide"),
			"whole-months, the fleet report: \"the date range\"");
		eq(N(S({ from: "2027-01", until: "2027-02" }), { range: R("2027-01-10", "2027-02-10", "whole-months"), rangeMode: "whole-months" }),
			`${WHOLE}January 2027 – February 2027. No payout month falls in this report period.`, "whole-months, a range with no payout month: both sentences");
		const EXACT = "Driver Pay, the fixed costs and Investor Payout cover whole months; revenue and trip expenses cover the exact dates you chose.";
		eq(N(may, { range: R("2026-05-15", "2026-05-20", "exact-dates"), rangeMode: "exact-dates" }),
			`${EXACT} Investor Payout is the total of your monthly payouts for May 2026, the same figures as your Payouts page.`,
			"exact-dates, a range: the exact-dates sentence, then the lead");
		for (const mode of ["whole-months", "exact-dates"]) {
			eq(N(may, { range: R("", "", mode), rangeMode: mode }), "Investor Payout is the total of your monthly payouts for May 2026, the same figures as your Payouts page.",
				`${mode}, no range: no date-range sentence`);
		}
	}

	// ======================================================== §8 mutants
	section("§8 mutants — each must be caught");
	{
		// (a) BEHAVIOURAL: the report's old formula, (revenue − expenses) × split with
		// the raw fixed costs and no driver pay or carry, fed to the §2 checks.
		const oldFormula = (r) => Math.round(FIXTURE
			.filter((f) => (!r.from || f.month >= r.from) && (!r.until || f.month <= r.until))
			.reduce((s, f) => s + (f.revenue - RAW_FIXED[f.month] - f.tripExpenses) * 0.5, 0));
		const shipped = (r) => W.fns.summarizeReportPayout(entries, r).payout;
		const misses = (payoutFor) => ["2026-05", "2026-06", "2026-08"].filter((mk) => payoutFor({ from: mk, until: mk }) !== ORACLE_INVESTOR[mk]);
		eq(misses(shipped), [], "control: the shipped reader matches the driver-pay, idle and carry months");
		eq(misses(oldFormula), ["2026-05", "2026-06", "2026-08"], "MUTANT the old formula is caught on the driver-pay (3,400), idle (−950) and carry (2,800) months");

		// (b) SOURCE: the handler reverting to its own formula fails the pins.
		const pins = (h) => {
			const c = stripComments(h);
			return [
				/const ownerEarnings = reportPayout\.payout;/.test(c),
				!/netCashFlow \*|\* \(splitPctLabel|splitPctLabel \/ 100/.test(c),
				/const payoutLabel = reportPayoutLabel\(reportPayout, investorReportOptions\.PAYOUT_LABEL, splitPctLabel\);/.test(c),
				/\{ label: payoutLabel, value: fmt\(ownerEarnings\)/.test(c),
				/const ownerEarningsLabel = reportPayoutLabel\(reportPayout, investorReportOptions\.OWNER_EARNINGS_LABEL, splitPctLabel\);/.test(c),
				/kpiRow\("Net Cash Flow", fmt\(netCashFlow\), ownerEarningsLabel, fmt\(ownerEarnings\)\)/.test(c),
				/\{ label: " {2}Driver Pay", value: `\(\$\{fmt\(driverPayExpenses\)\}\)`/.test(c),
				/totalExpenses = driverPayExpenses \+/.test(c),
				/for \(const monthKey of reportPayout\.chargedFixedMonths\)/.test(c),
				!/truckMonthsInPeriod\(/.test(c),
			];
		};
		ok(pins(HANDLER).every(Boolean), "control: the shipped handler passes every pin");
		const reverted = HANDLER.replace("const ownerEarnings = reportPayout.payout;", "const ownerEarnings = netCashFlow * (splitPctLabel / 100);");
		ok(reverted !== HANDLER, "the source mutant applied");
		ok(!pins(reverted).every(Boolean), "MUTANT the handler reverting to (net × split) is caught");
		const noDriverPay = HANDLER.replace("totalExpenses = driverPayExpenses + ", "totalExpenses = ");
		ok(noDriverPay !== HANDLER && !pins(noDriverPay).every(Boolean), "MUTANT dropping driver pay from Total Expenses is caught");

		// (c) The fixed-cost loop ignoring the ledger's idle month.
		const idleIgnored = FIXED_BLOCK.replace("reportPayout.chargedFixedMonths", "reportPayout.months");
		ok(idleIgnored !== FIXED_BLOCK, "the fixed-cost mutant applied");
		const m = runFixedBlock(idleIgnored, W.fns.summarizeReportPayout(entries, { from: "", until: "" }));
		ok(m.totalExpenses !== 11100, `MUTANT the fixed-cost loop charging the idle month is caught (${m.totalExpenses} ≠ 11,100)`);

		// (d) The note without its date-range sentence.
		const noteSrc = SOURCES.reportPayoutNote;
		const RANGE_GUARD = "if (from || until) {";
		ok(noteSrc.split(RANGE_GUARD).length - 1 === 1, "the note's date-range branch is found once");
		const silent = new Function("periodLabel", "investorReportOptions", `${noteSrc.replace(RANGE_GUARD, "if (false) {")}\nreturn reportPayoutNote;`)(W.fns.periodLabel, investorReportOptions);
		const args = { range: investorReportOptions.reportDateRange("2026-05-15", "2026-05-20", "whole-months"), rangeMode: "whole-months" };
		const may = W.fns.summarizeReportPayout(entries, { from: "2026-05", until: "2026-05" });
		ok(W.fns.reportPayoutNote(may, args).startsWith("Payouts are settled by month") && !silent(may, args).startsWith("Payouts are settled by month"),
			"MUTANT the note without its date-range sentence is caught");
	}

	// ============================================= §9 fleet report at month end
	section("§9 the fleet report at month end stops at the business month (the real monthly computation, a stubbed clock)");
	{
		const ME_NAMES = ["computeInvestorMonthlyEarnings", "gatherLedgerScopeFacts", "payoutRules", "ledgerLoadRows", "computeLossCarryForward", "investorReportPayoutEntries",
			"summarizeReportPayout", "reportPayoutNote", "periodLabel", "findCol", "pickAddressColumn", "moneySheetDate",
			"appDay", "normalizeDriverName", "driverNameForTotals", "isBuiltInPropertyName", "resolveInvestorSplitPct"];
		const ME = Object.fromEntries(ME_NAMES.map((n) => [n, extractFn(n)]));
		const JT = {
			headers: ["Load ID", "Driver", "Job Status", "  Payment  ", "Assigned Date", "Owner ID", "Truck"],
			data: [
				{ "Load ID": "9001", Driver: "Driver A", "Job Status": "Delivered", "  Payment  ": "1000", "Assigned Date": "2026-08-12", "Owner ID": "", Truck: "" },
				{ "Load ID": "9002", Driver: "Driver A", "Job Status": "Delivered", "  Payment  ": "2000", "Assigned Date": "2026-09-15", "Owner ID": "", Truck: "" },
			],
		};
		const RealDate = Date;
		// `new Date()` and Date.now() read the stubbed instant; every other form of
		// Date is the real one.
		const clockAt = (iso) => {
			const ms = RealDate.parse(iso);
			return class extends RealDate {
				constructor(...a) { if (a.length) super(...a); else super(ms); }
				static now() { return ms; }
			};
		};
		const FILTER = "monthlyEarnings.filter((m) => m.month <= currentMonthKey)";
		const run = async (iso, readerSrc = ME.investorReportPayoutEntries) => {
			const deps = {
				Date: clockAt(iso),
				APP_TIMEZONE: require("../lib/app-time").appTimeZone(),
				RFC2822_MONTHS: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
				db: { prepare: () => ({ all: () => [], get: () => undefined }) },
				getJobTrackingCached: async () => JT,
				excludeDroppedLoads: (rows) => rows,
				resolveCityState: () => "",
				getEldTravelDaysByVehicleCached: () => ({}),
				getAllExcludedDriverDays: () => ({}),
				getDriverPayStructures: () => ({}),
				getDeductibleExpensesByDriverMonth: () => ({}),
				resolveDailyRate: (perDriver, perTruck) => perDriver || perTruck || 250,
				getInvestorDriverMonthWindows: () => new Map(),
				investorExpenseScopeSql: () => ({ sql: "1=0", params: [] }),
				EXPENSE_PERIOD_EXPR: "date",
				EXPENSE_PNL_FILTER: "1=1",
				truckChargedInMonth: () => false,
				truckMonthlyFixed: () => ({ total: 0 }),
				reconcileInvestorPayouts: async () => { throw new Error("the fleet report reconciles no ledger"); },
				investorReportOptions,
				investorPayoutBasis,
				financialsCalc: require("../lib/financials-calc"),
				PAYOUT_RULES_V2_ENABLED: false,
				PAYOUT_RULE_KEYS: ["datedAttribution", "datedRates", "futureReceipts", "frozenCarry"],
				payoutBasisContext: (ownerId) => { if (ownerId) throw new Error("the fleet report settles no owner"); return null; },
			};
			const names = Object.keys(deps);
			const srcs = ME_NAMES.map((n) => (n === "investorReportPayoutEntries" ? readerSrc : ME[n]));
			const f = new Function(...names, `${srcs.join("\n")}
				return { computeInvestorMonthlyEarnings, investorReportPayoutEntries, summarizeReportPayout, reportPayoutNote };`)(...names.map((n) => deps[n]));
			const config = { investor_split_pct: "50" };
			const earnings = await f.computeInvestorMonthlyEarnings({ user: { id: 1 }, isSuperAdmin: true, investorDriverSet: null, investorOwnerId: null, config });
			const ents = await f.investorReportPayoutEntries({ ownerId: null, sessionUser: { id: 1, role: "Super Admin" }, carrierDB: null, globalConfig: config, config });
			const all = f.summarizeReportPayout(ents, { from: "", until: "" });
			return { earnings, entries: ents, all, note: f.reportPayoutNote(all, { fleet: true }) };
		};
		const tz = process.env.TZ;
		process.env.TZ = "UTC"; // the production server's clock
		try {
			const r = await run("2026-10-01T01:30:00Z"); // 2026-09-30 21:30 EDT
			eq(r.earnings.currentMonthKey, "2026-09", "month end: the business clock is still in September");
			eq(r.earnings.monthlyEarnings.map((m) => m.month), ["2026-08", "2026-09", "2026-10"],
				"…while the shared computation's months already run to October, the server's month (its input, as it ships)");
			eq(r.entries.map((e) => e.month), ["2026-08", "2026-09"], "the fleet reader stops at the business month");
			eq(r.all.inProgressMonth, "2026-09", "…September is the month in progress");
			ok(r.note.startsWith("Investor Payout is the total of the fleet-wide monthly investor shares for August 2026 – September 2026. September 2026 is still in progress"),
				"…and the note names August – September");
			const mid = await run("2026-09-15T17:00:00Z");
			eq([mid.earnings.monthlyEarnings.map((m) => m.month), mid.entries.map((e) => e.month)], [["2026-08", "2026-09"], ["2026-08", "2026-09"]],
				"control, mid-month: the computation has no extra month, and the reader reads the same two");

			const unfiltered = ME.investorReportPayoutEntries.replace(FILTER, "monthlyEarnings");
			ok(unfiltered !== ME.investorReportPayoutEntries, "the no-filter mutant applied");
			const m = await run("2026-10-01T01:30:00Z", unfiltered);
			ok(m.all.months.includes("2026-10") && /September 2026 – October 2026|August 2026 – October 2026/.test(m.note),
				`MUTANT the fleet reader without the filter prints October at month end (caught): ${m.all.months.join(", ")}`);
		} finally {
			if (tz === undefined) delete process.env.TZ;
			else process.env.TZ = tz;
		}
	}

	// ================================== §10 the date range is checked first
	section("§10 a date that is not a real day, or a start after the end, is refused before anything is read or written");
	{
		const ROUTE = 'app.get("/api/investor/report", requireRole("Super Admin", "Investor"), ';
		if (SRC.split(ROUTE).length - 1 !== 1) throw new Error("§10 expected the report route exactly once");
		const open = SRC.indexOf("async (req, res) => {", SRC.indexOf(ROUTE));
		let depth = 0;
		let close = -1;
		for (let j = SRC.indexOf("{", open); j < SRC.length; j++) {
			if (SRC[j] === "{") depth++;
			else if (SRC[j] === "}") { depth--; if (depth === 0) { close = j + 1; break; } }
		}
		const HANDLER_FN = SRC.slice(open, close);
		const runReport = async (fnSrc, query) => {
			const calls = [];
			const deps = {
				investorReportOptions,
				resolvePreviewUser: (req) => ({ sessionUser: req.session.user, effectiveUserId: req.session.user.id, effectiveUsername: req.session.user.username, isPreview: false, targetMissing: false }),
				logAudit: () => calls.push("audit"),
				SPREADSHEET_ID: "fixture-sheet",
				getSheets: async () => { calls.push("sheet read"); return { spreadsheets: { values: { get: async () => ({ data: { values: [["Load ID"]] } }) } } }; },
				parseSheet: () => ({ headers: ["Load ID"], data: [] }),
				deduplicateLoads: (rows) => rows,
				excludeDroppedLoads: (rows) => rows,
				getCarrierDBFromSQLite: () => ({ headers: ["Driver", "Carrier"], data: [] }),
				findCol: (headers, re) => (headers || []).find((h) => re.test(h)) || null,
				getInvestorDriverSet: () => new Set(),
				investorJobRowTest: () => () => true,
				investorTruckPurchase: () => ({ trucks: [], pricedCount: 0, unpricedCount: 0, totalPurchasePrice: 0, purchasePrice: null }),
				db: { prepare: () => ({ all: () => [], get: () => ({ t: 0 }) }) },
				investorReportPayoutEntries: async () => { calls.push("ledger reconcile"); return []; },
				summarizeReportPayout: W.fns.summarizeReportPayout,
				reportRangeMonthKeys: W.fns.reportRangeMonthKeys,
				// The stubs end a run that goes past the reconcile with an error the
				// handler logs; only the calls before it matter here.
				console: { error() {}, warn() {}, log() {} },
			};
			const names = Object.keys(deps);
			const handler = new Function(...names, `return ${fnSrc};`)(...names.map((n) => deps[n]));
			let status = 200;
			let body = null;
			const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; }, setHeader() {}, send(b) { body = b; return this; } };
			await handler({ session: { user: { id: 5, username: "inv5", role: "Investor" } }, query }, res);
			return { status, body, calls };
		};
		const cases = [
			[{ start: "garbage", end: "2026-08-10" }, "INVALID_DATE", "start"],
			[{ start: "2026-05-01", end: "2026-02-30" }, "INVALID_DATE", "end"],
			[{ start: "2026-13-01" }, "INVALID_DATE", "start"],
			[{ start: ["2026-05-01", "2026-06-01"] }, "INVALID_DATE", "start"],
			[{ start: "2026-08-10", end: "2026-05-01" }, "INVALID_RANGE", undefined],
		];
		for (const [query, code, field] of cases) {
			const r = await runReport(HANDLER_FN, query);
			eq([r.status, r.body && r.body.code, r.body && r.body.field], [400, code, field], `${JSON.stringify(query)}: 400 ${code}${field ? ` naming ${field}` : ""}`);
			eq(r.calls, [], "…with no sheet read, no ledger reconcile and no audit row");
		}
		const control = await runReport(HANDLER_FN, { start: "2026-05-15", end: "2026-08-02" });
		ok(control.calls.includes("sheet read") && control.calls.includes("ledger reconcile"), "control: a real range goes on to read the sheet and reconcile the ledger");

		const CHECK_CALL = "investorReportOptions.reportDateRange(req.query.start, req.query.end, investorReportOptions.RANGE_MODE)";
		const unchecked = HANDLER_FN.replace(CHECK_CALL, '({ ok: true, from: req.query.start || "", until: req.query.end || "", widened: false })');
		ok(unchecked !== HANDLER_FN, "the no-check mutant applied");
		const m = await runReport(unchecked, { start: "garbage", end: "2026-08-10" });
		ok(m.status !== 400 && m.calls.includes("ledger reconcile"),
			`MUTANT without the check: a junk date reaches the ledger reconcile and answers ${m.status} (caught)`);
	}

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		for (const f of failures) console.log(`  ✗ ${f}`);
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`PASS — ${pass} assertions passed (7 mutants caught)`);
})().catch((e) => {
	console.error("FAIL  runner crashed:", e);
	process.exit(1);
});
