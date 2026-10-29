#!/usr/bin/env node
/**
 * "Personal" receipts in the books and the operational views. The personal
 * part of a receipt is not a company cost: every settlement figure (payout
 * ledger, Financials, investor portal, tax and report totals, percentage pay)
 * reads expenseFrom("book"), every operational one (fuel card, fuel analytics,
 * KPI, cost-per-gallon band, the investor's receipt list) expenseFrom("world").
 * Lifted from server.js on the world in scripts/lib/personal-world.js (made-up
 * data; clock Thu 2026-10-15 12:00 ET; August and September closed).
 *
 *   §1 T24 dormant and inert: with no row both sources are the plain table; with
 *      rows that change nothing (a voided line) every figure is the same to the
 *      cent; the first mark switches the source with no restart
 *   §2 T6 a full mark of R1 ($200 fuel, 50 gal): October's company trip
 *      expenses -$200 for investor 7 and fleet-wide, the investor's October
 *      payout +$100 (50% split), the ledger's trip items drop the receipt; fuel
 *      spend -$200, gallons -50, one fill fewer; KPI and the cost-per-gallon
 *      band leave it out
 *   §3 T7 a partial mark ($50 of R5's $300, 100 gal): $250 in the books and in
 *      fuel spend, gallons kept
 *   §4 T12 a closed-month receipt (R3, August): August as recorded; a -$300
 *      credit in October (+$150 payout), a negative trip item naming the line
 *   §5 T13 marked in place, then the month closes: undo 409 PERIOD_FINALIZED
 *      ("use Reverse"); the reversal posts +$80 as a credit in October
 *   §6 owner-operator P&L: October's deductible -$100, percentage pay +$25,
 *      trip expenses -$100, the investor +$37.50
 *   §7 the futureReceipts rule on: in place and the cost month follow
 *      futureAwarePeriodExpr()
 *   §8 the AI insights cache key, the close fingerprint and the fuel KPIs'
 *      definitionVersion all change with Personal lines
 *   §9 pin, PERSONAL_RECEIPT_WEEK_ENABLED on: carrying a line moves no book
 *      figure (the same mark waiting for its week or carried off its approved
 *      week; re-keying its week, its carry marker or its invoice)
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-personal-expense-books.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const path = require("path");
const { buildPersonalWorld, makeChecker, edt, OWNER_OP, USERS, ROOT } = require("./lib/personal-world");
const { check, section, finish } = makeChecker();

const ON = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" };
const world = (env = ON, opts = {}) => buildPersonalWorld({ env, ...opts });
const mark = (w, id, body = {}) => w.call("POST", `/api/expenses/${id}/personal`, { body });
const round2 = (n) => Math.round(n * 100) / 100;

async function figures(w) {
	const api = w.api;
	const carrierDB = api.getCarrierDBFromSQLite();
	const driverCol = api.findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
	const carrierCol = api.findCol(carrierDB.headers, /carrier/i);
	const config = {};
	w.db.prepare("SELECT key, value FROM investor_config WHERE owner_id IN (0, 7) ORDER BY owner_id").all().forEach((r) => { config[r.key] = r.value; });
	const investorSet = api.getInvestorDriverSet(7, carrierDB.data, driverCol, carrierCol);
	const inv = await api.gatherLedgerScopeFacts({ user: USERS.investor, isSuperAdmin: false, investorDriverSet: investorSet, investorOwnerId: 7 });
	const fleet = await api.gatherLedgerScopeFacts({ user: USERS.admin, isSuperAdmin: true, investorDriverSet: null, investorOwnerId: null });
	const earnings = await api.computeInvestorMonthlyEarnings({ user: USERS.investor, isSuperAdmin: false, investorDriverSet: investorSet, investorOwnerId: 7, config });
	const oct = (earnings.monthlyEarnings || []).find((m) => m.month === "2026-10") || {};
	const kpi = api.kpiGatherDbInputs(w.db, { asOfDay: "2026-10-15", timeZone: "America/New_York" });
	const fuelRoute = (await w.call("GET", "/api/expenses/fuel-analytics")).body;
	const tripItems = (earnings.items || []).filter((i) => i.kind === "trip" && i.month === "2026-10");
	return {
		invTrip: inv.tripByMonth, fleetTrip: fleet.tripByMonth,
		invReceipts: inv.receipts.map((r) => [r.id, r.month, round2(r.amount)]),
		deductible: api.getDeductibleExpensesByDriverMonth(),
		octNet: round2((oct.exact || {}).netProfit || 0), octInvestor: round2(oct.investorEarnings || 0),
		octDriverPay: round2((oct.exact || {}).driverPay || 0), octTrip: round2((oct.exact || {}).tripExpenses || 0),
		tripItems: tripItems.map((i) => [i.expenseId, i.cents, i.sourceId == null ? null : i.sourceId]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
		kpiFuel: kpi.fuelReceipts.map((r) => [r.day, r.amount, r.gallons]).sort(),
		cpgRows: api.fuelCpgBandFromFleet(),
		fuelSpend: fuelRoute.totalFuelSpend,
		fuelGallons: fuelRoute.totalGallons,
	};
}
const fuelCard = (w, month) => {
	const src = w.api.expenseFrom("world");
	return w.db.prepare(`SELECT COALESCE(SUM(amount),0) AS spend, COALESCE(SUM(gallons),0) AS gallons, COUNT(*) AS fills
		FROM ${src} WHERE LOWER(type)='fuel' AND strftime('%Y-%m', date)=? AND COALESCE(status, '') != 'Rejected'`).get(month);
};

(async () => {
	section("§1 T24 dormant and inert");
	{
		const w = world();
		check("no row: the books source is the plain table", w.api.expenseFrom("book"), "expenses");
		check("no row: so is the world source", w.api.expenseFrom("world"), "expenses");
		const before = await figures(w);
		w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role, voided_at, voided_by)
			VALUES (1, 'deduct', 20000, 20000, 'Pilot #123', '2026-10-12', '2026-10', 1, '2026-10-12', '2026-10-10', 't', 'super_admin', 1, 'Super Admin', '2026-10-14T00:00:00Z', 'super_admin')`).run();
		check("a row exists: the source switches with no restart", /^\(SELECT/.test(w.api.expenseFrom("book")), true);
		const after = await figures(w);
		for (const k of Object.keys(before)) check(`a voided line changes nothing: ${k}`, after[k], before[k]);
		w.cleanup();
	}

	section("§2 T6 a full mark of R1");
	{
		const w = world();
		const before = await figures(w);
		const cardBefore = fuelCard(w, "2026-10");
		await mark(w, 1);
		const after = await figures(w);
		const cardAfter = fuelCard(w, "2026-10");
		check("investor 7's October trip expenses -$200", round2(after.invTrip["2026-10"] - before.invTrip["2026-10"]), -200);
		check("fleet-wide October trip expenses -$200", round2(after.fleetTrip["2026-10"] - before.fleetTrip["2026-10"]), -200);
		check("other months unchanged", [after.invTrip["2026-08"], after.invTrip["2026-09"]], [before.invTrip["2026-08"], before.invTrip["2026-09"]]);
		check("the investor's October payout +$100 (50% of $200)", round2(after.octInvestor - before.octInvestor), 100);
		check("the ledger's trip items drop R1", after.tripItems.some((i) => i[0] === 1), false);
		check("Financials' fuel card: spend -$200, gallons -50, one fill fewer",
			[round2(cardAfter.spend - cardBefore.spend), round2(cardAfter.gallons - cardBefore.gallons), cardAfter.fills - cardBefore.fills], [-200, -50, -1]);
		check("fuel analytics: spend -$200, gallons -50", [round2(after.fuelSpend - before.fuelSpend), round2(after.fuelGallons - before.fuelGallons)], [-200, -50]);
		check("the KPI fuel receipts leave it out", after.kpiFuel.length, before.kpiFuel.length - 1);
		check("the receipt row itself is unchanged", w.db.prepare("SELECT amount, gallons FROM expenses WHERE id = 1").get(), { amount: 200, gallons: 50 });
		w.cleanup();
	}

	section("§3 T7 a partial mark ($50 of R5)");
	{
		const w = world();
		const cardBefore = fuelCard(w, "2026-10");
		await mark(w, 5, { amount: 50 });
		const after = await figures(w);
		const cardAfter = fuelCard(w, "2026-10");
		check("the books count R5 at $250", after.invReceipts.filter((r) => r[0] === 5).map((r) => r[2]), [250]);
		check("fuel spend -$50, gallons kept, fills kept", [round2(cardAfter.spend - cardBefore.spend), round2(cardAfter.gallons - cardBefore.gallons), cardAfter.fills - cardBefore.fills], [-50, 0, 0]);
		check("the ledger's trip item for R5 is $250", after.tripItems.filter((i) => i[0] === 5).map((i) => i[1]), [25000]);
		w.cleanup();
	}

	section("§4 T12 a closed-month receipt (R3, August)");
	{
		const w = world();
		const before = await figures(w);
		const r = await mark(w, 3);
		const after = await figures(w);
		const [line] = w.lines();
		check("201; in_place 0, cost month October, booked on the marking day", [r.status, line.in_place, line.cost_period, line.book_date], [201, 0, "2026-10", "2026-10-15"]);
		check("R3 still Pending", w.db.prepare("SELECT status FROM expenses WHERE id = 3").get().status, "Pending");
		check("August as recorded", after.invTrip["2026-08"], before.invTrip["2026-08"]);
		check("October -$300", round2(after.invTrip["2026-10"] - before.invTrip["2026-10"]), -300);
		check("the investor's October payout +$150", round2(after.octInvestor - before.octInvestor), 150);
		check("October's trip items carry R3's credit: -30000 cents naming the line", after.tripItems.filter((i) => i[0] === 3), [[3, -30000, line.id]]);
		check("August's fuel card unchanged (a credit is books-only)", fuelCard(w, "2026-08"), (() => { const x = w.db.prepare("SELECT COALESCE(SUM(amount),0) AS spend, COALESCE(SUM(gallons),0) AS gallons, COUNT(*) AS fills FROM expenses WHERE LOWER(type)='fuel' AND strftime('%Y-%m', date)='2026-08' AND COALESCE(status, '') != 'Rejected'").get(); return x; })());
		w.cleanup();
	}

	section("§5 T13 marked in place, then the month closes");
	{
		const w = world(ON, { nowMs: edt("2026-10-05", 12) });
		w.db.prepare("DELETE FROM period_locks WHERE period = '2026-09'").run();
		await mark(w, 6);
		check("marked while September was open: in place, September", w.lines().map((l) => [l.in_place, l.cost_period]), [[1, "2026-09"]]);
		w.db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-09', 'locked', '2026-10-08T04:00:00.000Z', 'test')").run();
		w.setNow(edt("2026-10-15", 12));
		const u = await w.call("DELETE", "/api/expenses/6/personal", { body: {} });
		check("undo: 409 PERIOD_FINALIZED, telling to use Reverse", [u.status, u.body && u.body.code, /Reverse/.test(u.body && u.body.error || "")], [409, "PERIOD_FINALIZED", true]);
		const rv = await w.call("POST", "/api/expenses/6/personal/reverse", { body: {} });
		check("reverse: 201, +$80 as a credit in October", [rv.status, w.lines("kind = 'reverse'").map((l) => [l.cents, l.in_place, l.cost_period])], [201, [[8000, 0, "2026-10"]]]);
		const book = w.db.prepare(`SELECT amount, posted_period FROM ${w.api.expenseFrom("book")} WHERE id = 6 ORDER BY amount`).all();
		check("the books: September keeps the $0 it closed with (fully personal), October gets +$80", book.map((b) => [b.amount, b.posted_period]), [[80, "2026-10"]]);
		w.cleanup();
	}

	section("§6 owner-operator P&L");
	{
		const w = world();
		const before = await figures(w);
		await mark(w, 8);
		const after = await figures(w);
		const key = OWNER_OP.toLowerCase();
		check("October's deductible -$100", round2(after.deductible[key]["2026-10"] - before.deductible[key]["2026-10"]), -100);
		check("October driver pay +$25 (25% of $100)", round2(after.octDriverPay - before.octDriverPay), 25);
		check("October trip expenses -$100", round2(after.octTrip - before.octTrip), -100);
		check("October net profit +$75 ($100 off trip expenses, $25 more pay)", round2(after.octNet - before.octNet), 75);
		check("the investor's 50% of it (+$37.50), rounded once to the dollar as every payout is",
			[after.octInvestor, Math.abs(after.octInvestor - before.octInvestor - 37.5) <= 0.5], [Math.round(after.octNet * 0.5), true]);
		w.cleanup();
	}

	section("§7 the futureReceipts rule on");
	{
		const w = world({ ...ON, PAYOUT_RULES_V2_ENABLED: "true" });
		w.db.prepare(`INSERT INTO expenses (id, timestamp, driver, type, amount, date, status, vendor, truck_unit, owner_id, created_at, description)
			VALUES (14, '2026-10-15T14:00:00.000Z', 'Test Driver A', 'Other', 40, '2026-11-02', 'Approved', 'Store', 'T-1', 7, '2026-10-15 14:00:00', '')`).run();
		await mark(w, 14);
		check("a receipt dated after the day it was submitted: cost month is the submitted month (October), in place", w.lines().map((l) => [l.in_place, l.cost_period]), [[1, "2026-10"]]);
		w.cleanup();
		const w2 = world();
		w2.db.prepare(`INSERT INTO expenses (id, timestamp, driver, type, amount, date, status, vendor, truck_unit, owner_id, created_at, description)
			VALUES (14, '2026-10-15T14:00:00.000Z', 'Test Driver A', 'Other', 40, '2026-11-02', 'Approved', 'Store', 'T-1', 7, '2026-10-15 14:00:00', '')`).run();
		await mark(w2, 14);
		check("…with the rule off it is the receipt's date month (November)", w2.lines().map((l) => [l.in_place, l.cost_period]), [[1, "2026-11"]]);
		w2.cleanup();
	}

	section("§8 cache key, fingerprint, KPI versions");
	{
		const w = world();
		const key = w.api.computeInsightsCacheKey();
		const fp = w.api.closingFingerprint(["2026-10"]);
		await mark(w, 5, { amount: 10 });
		check("computeInsightsCacheKey() changes after a mark", w.api.computeInsightsCacheKey() !== key, true);
		check("closingFingerprint() for October changes after a mark", w.api.closingFingerprint(["2026-10"]) !== fp, true);
		const key2 = w.api.computeInsightsCacheKey();
		await w.call("DELETE", "/api/expenses/5/personal", { body: {} });
		check("…and after an undo", w.api.computeInsightsCacheKey() !== key2, true);
		const catalog = require(path.join(ROOT, "lib", "kpi-catalog.js"));
		const v = (k) => (catalog.METRICS.find((m) => m.key === k) || {}).definitionVersion;
		check("the fuel KPIs' definitionVersion moved to 2 (their source changed)", [v("fuel_mpg"), v("fuel_savings"), v("co2_tonnes")], [2, 2, 2]);
		// paid_mile_share is at 2 for its own reason (R10's paid miles, #517).
		check("…and no other metric's did", catalog.METRICS.filter((m) => !["fuel_mpg", "fuel_savings", "co2_tonnes", "paid_mile_share"].includes(m.key)).every((m) => m.definitionVersion === 1), true);
		w.cleanup();
	}

	section("§9 pin: carrying a line moves no book figure (PERSONAL_RECEIPT_WEEK_ENABLED on)");
	{
		const WEEK_ON = { ...ON, PERSONAL_RECEIPT_WEEK_ENABLED: "true" };
		const waiting = world(WEEK_ON);
		await mark(waiting, 1);
		const expected = await figures(waiting);
		waiting.cleanup();
		const w = world(WEEK_ON);
		const g = await w.generate("Test Driver A");
		w.db.prepare("UPDATE invoices SET status = 'Approved', approved_at = 't', approved_by = 'super_admin' WHERE id = ?").run(g.body.invoice.id);
		await mark(w, 1);
		const carried = await figures(w);
		for (const k of Object.keys(expected)) check(`R1 carried off its approved W41 counts as R1 waiting for W41: ${k}`, carried[k], expected[k]);
		// Where a line waits or which invoice repays it is no book fact.
		w.db.prepare("UPDATE expense_personal SET week_start = '2026-10-03', needs_correction_since = '2026-10-17T10:30:00.000Z', invoice_id = NULL WHERE expense_id = 1").run();
		const rekeyed = await figures(w);
		w.db.prepare("UPDATE expense_personal SET needs_correction_since = '', invoice_id = ? WHERE expense_id = 1").run(g.body.invoice.id);
		const onInvoice = await figures(w);
		check("…re-keying its week, its carry marker or its invoice moves no figure", [rekeyed, onInvoice], [expected, expected]);
		w.cleanup();
	}

	finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
