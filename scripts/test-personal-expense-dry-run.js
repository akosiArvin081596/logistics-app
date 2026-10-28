#!/usr/bin/env node
/**
 * scripts/personal-expenses-dry-run.js on the made-up world of
 * scripts/lib/personal-world.js (clock Thu 2026-10-15 12:00 ET).
 *
 *   §1 Part A, no mark: every ledger, Financials, percentage-base, fuel, KPI and
 *      cost-per-gallon figure is the same to the cent through the new sources;
 *      every unpaid invoice's total due is unchanged
 *   §2 it writes nothing: expense_personal stays empty, the receipts and the
 *      invoices are byte-identical, the TEMP table is gone afterwards
 *   §3 Part B, a company driver's full mark: where it lands, the month it costs,
 *      October's trip expenses -$200 and the investor's payout +$100, fuel
 *      spend -$200
 *   §4 Part B, an owner-operator marked after his Submitted invoice: the line
 *      lands on it, $800 -> $725 with the $25 share returned
 *   §5 a mark the route would refuse is reported as refused
 *   §6 Part A is skipped once the ledger holds a row
 *   §7 W12 Part B with PERSONAL_RECEIPT_WEEK_ENABLED on: an Oct 7 receipt marked
 *      Thu Oct 15 is planned in the week of Oct 3, on W40's Submitted invoice
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-personal-expense-dry-run.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const crypto = require("crypto");
const { buildPersonalWorld, makeChecker, NOW_MS, DRIVER_A, OWNER_OP } = require("./lib/personal-world");
const { buildDryRunWorld, personalDryRun } = require("./personal-expenses-dry-run");
const { check, section, finish } = makeChecker();

class FixedDate extends Date {
	constructor(...args) { super(...(args.length ? args : [NOW_MS])); }
	static now() { return NOW_MS; }
}
const hash = (db, sql) => crypto.createHash("sha256").update(JSON.stringify(db.prepare(sql).all())).digest("hex");
const dryWorld = (w) => buildDryRunWorld({ db: w.db, sheetData: { values: w.sheet.rows.map((r) => [...r]) }, DateImpl: FixedDate });
const find = (changes, figure) => changes.find((c) => c.figure === figure) || null;

(async () => {
	section("§1 Part A, no mark");
	{
		const w = buildPersonalWorld({ env: { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" } });
		const r = await personalDryRun(dryWorld(w));
		check("every figure the same to the cent", [r.partA.allEqual, r.partA.differences, r.partA.totalDueDifferences], [true, [], []]);
		check("…over the ledger months (fleet and investor 7), percentage base, fuel, KPI and cost-per-gallon figures (24 here)", r.partA.figuresCompared >= 20, true);
		check("no Part B without a mark", r.partB, null);
		w.cleanup();
	}

	section("§2 it writes nothing");
	{
		const w = buildPersonalWorld({ env: { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" } });
		const before = [hash(w.db, "SELECT * FROM expenses ORDER BY id"), hash(w.db, "SELECT * FROM invoices ORDER BY id")];
		await personalDryRun(dryWorld(w), { marks: [{ id: 1 }, { id: 5, amount: "50" }] });
		check("expense_personal still empty", w.db.prepare("SELECT COUNT(*) AS n FROM main.expense_personal").get().n, 0);
		check("receipts and invoices unchanged", [hash(w.db, "SELECT * FROM expenses ORDER BY id"), hash(w.db, "SELECT * FROM invoices ORDER BY id")], before);
		check("the TEMP table is dropped", !!w.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name = 'expense_personal'").get(), false);
		w.cleanup();
	}

	section("§3 Part B, a company driver's full mark");
	{
		const w = buildPersonalWorld({ env: { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" } });
		const r = await personalDryRun(dryWorld(w), { marks: [{ id: 1 }] });
		const [m] = r.partB.marks;
		check("the receipt and the line", [m.receipt.merchant, m.receipt.amount, m.personal.amount, m.personal.week, m.personal.books, m.landing.where],
			["Pilot #123", 200, 200, "2026-10-10", "in place", "the week's invoice when it is generated"]);
		check("no driver name without --names", "driver" in m.receipt, false);
		const trip = find(r.partB.changes, "owner 7 2026-10 trip expenses");
		check("investor 7's October trip expenses -$200", trip && Math.round((trip.after - trip.before) * 100) / 100, -200);
		const payout = find(r.partB.changes, "owner 7 2026-10 investor payout");
		check("…and the investor's October payout +$100", payout && payout.after - payout.before, 100);
		const fuel = find(r.partB.changes, "fuel 2026-10 spend");
		check("October fuel spend -$200", fuel && Math.round((fuel.after - fuel.before) * 100) / 100, -200);
		check("closed months do not move", r.partB.changes.filter((c) => /2026-0[89]/.test(c.figure)), []);
		w.cleanup();
	}

	section("§4 Part B, an owner-operator after his Submitted invoice");
	{
		const w = buildPersonalWorld({ env: { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" } });
		const g = await w.generate(OWNER_OP);
		w.db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(g.body.invoice.id);
		const r = await personalDryRun(dryWorld(w), { marks: [{ id: 8 }] });
		const [m] = r.partB.marks;
		check("lands on the Submitted W41: $800 -> $725, $25 share returned",
			[/INV-TOO-2026W41-01 \(Submitted\)/.test(m.landing.where), m.landing.totalDueBefore, m.landing.totalDueAfter, m.personal.shareReturned], [true, 800, 725, 25]);
		const pay = find(r.partB.changes, "owner 7 2026-10 driver pay");
		check("October percentage pay +$25 in the books", pay && Math.round((pay.after - pay.before) * 100) / 100, 25);
		w.cleanup();
	}

	section("§5 refused marks");
	{
		const w = buildPersonalWorld({ env: { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" } });
		const r = await personalDryRun(dryWorld(w), { marks: [{ id: 4 }, { id: 1, amount: "250.00" }, { id: 999 }] });
		check("Rejected, too large, missing", r.partB.marks.map((m) => (m.refused || "").split(":")[0]),
			["the receipt is Rejected (EXPENSE_REJECTED)", "PERSONAL_AMOUNT_TOO_LARGE", "no such receipt"]);
		check("…and nothing changes", r.partB.changes, []);
		w.cleanup();
	}

	section("§6 Part A skipped once a line exists");
	{
		const w = buildPersonalWorld({ env: { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" } });
		await w.call("POST", "/api/expenses/5/personal", { body: { amount: 10 } });
		const r = await personalDryRun(dryWorld(w));
		check("Part A says why it did not run", /already holds 1 row/.test(r.partA.skipped || ""), true);
		w.cleanup();
	}

	section("§7 W12 Part B with the receipt's week on");
	{
		const env = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true", PERSONAL_RECEIPT_WEEK_ENABLED: "true" };
		const w = buildPersonalWorld({ env });
		w.db.prepare(`INSERT INTO expenses (id, timestamp, driver, type, amount, date, status, vendor, truck_unit, owner_id, created_at, description)
			VALUES (20, '2026-10-07T15:00:00.000Z', ?, 'Food', 45.5, '2026-10-07', 'Approved', 'EXAMPLE DINER #3', 'T-1', 7, '2026-10-07 15:00:00', '')`).run(DRIVER_A);
		const g40 = await w.generate(DRIVER_A, "2026-10-09");
		w.db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(g40.body.invoice.id);
		// The dry run reads the flag from the settings it is given, as on the server.
		const dw = buildDryRunWorld({ db: w.db, sheetData: { values: w.sheet.rows.map((r) => [...r]) }, env, DateImpl: FixedDate });
		const r = await personalDryRun(dw, { marks: [{ id: 20 }] });
		const m = (r.partB && r.partB.marks[0]) || { personal: {}, landing: {} };
		check("an Oct 7 receipt marked Thu Oct 15: the week of 2026-10-03, on the Submitted W40 now, $600 -> $554.50",
			[m.personal.week, new RegExp(g40.body.invoice.invoice_number).test(m.landing.where || ""), m.landing.totalDueBefore, m.landing.totalDueAfter],
			["2026-10-03", true, 600, 554.5]);
		w.cleanup();
	}

	finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
