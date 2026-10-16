#!/usr/bin/env node
/**
 * "Personal" receipts: the Invoices screen's "Expenses (ref)" counts only the
 * part of each receipt that is NOT Personal. A Personal amount is the driver's,
 * not a company cost (the R3 rules), so a receipt marked Personal in full counts
 * $0 there and a partial mark counts the rest. The 2026-10-15 flag-on check found
 * the figure still counting Personal receipts in full.
 *
 * The figure is the server's (expenses_ref_total on each GET /api/invoices row),
 * read when the list is served: the stored expenses_total (the receipts as filed)
 * is never rewritten, the invoice's pay and total due never move, and a line
 * booked outside a closed month (in_place 0) leaves that month's invoice as
 * recorded, as in the books (expenseFrom()). Lifted from server.js on the world in
 * scripts/lib/personal-world.js (made-up data; clock Thu 2026-10-15 12:00 ET;
 * week W41 = Sat 10-10 .. Fri 10-16; Test Driver A's W41 receipts are R5 $300,
 * R1 $200 and R2 $45.50 = $545.50).
 *
 *   §1 marked in full before generation: $345.50; stored $545.50, pay and total
 *      due as before; the driver's own list says the same; another driver's
 *      invoice is untouched
 *   §2 a partial mark after generation (attached to the Draft): the rest counts
 *   §3 marked after approval (the week's correction): the approved invoice shows
 *      the remainder; the correction (a manual invoice) keeps its own figure
 *   §4 undo and reverse in an open month put the receipt back in full
 *   §5 a receipt in a closed month: its credit books to the open month, and that
 *      week's invoice keeps the figure it was recorded with
 *   §6 owner-operator: the Personal receipt leaves "Expenses (ref)" as it leaves
 *      the base
 *   §7 flag off with no Personal line: every row's figure IS its stored one (a
 *      manual invoice's deductions included); lines already made, flag off: still
 *      left out (switching the flag off never un-counts a deduction)
 *   §8 lib/personal-expense.js expensesRefTotal(): the stored figure untouched
 *      without a part, each part at most its receipt, never below $0, to the cent
 *   §9 the screen prints the server's figure beside "Expenses (ref)" and in the
 *      CSV's Expenses column, a manual invoice's deductions as before, and does
 *      no arithmetic on it
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-personal-expense-expenses-ref.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const fs = require("fs");
const path = require("path");
const { buildPersonalWorld, makeChecker, DRIVER_A, DRIVER_B, OWNER_OP, ROOT } = require("./lib/personal-world");
const { check, section, finish } = makeChecker();
const personalExpense = require(path.join(ROOT, "lib", "personal-expense.js"));

const ON = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" };
const world = (env = ON) => buildPersonalWorld({ env, receipts: true });
const mark = (w, id, body = {}) => w.call("POST", `/api/expenses/${id}/personal`, { as: "admin", body });
const approve = (w, id) => w.db.prepare("UPDATE invoices SET status = 'Approved', approved_at = 't', approved_by = 'super_admin' WHERE id = ?").run(id);
const list = async (w, as = "admin") => (await w.call("GET", "/api/invoices", { as })).body.invoices || [];
const rowFor = (rows, id) => rows.find((r) => r.id === id) || {};
const refOf = async (w, id, as = "admin") => rowFor(await list(w, as), id).expenses_ref_total;
const stored = (w, id) => {
	const r = w.invoice(id);
	return [r.expenses_total, r.total_earnings, r.personal_total, r.expense_ids];
};
// The row field the Invoices screen prints beside "Expenses (ref)", read from
// its template, so §1 checks what the admin actually sees.
const VIEW = fs.readFileSync(path.join(ROOT, "client/src/views/InvoicesView.vue"), "utf8");
const SCREEN_FIELD = (VIEW.match(/Expenses \(ref\)[^\n]*?fmtMoney\(selectedInvoice\.(\w+)\)/) || [])[1] || null;

(async () => {
	section("§1 marked in full before generation");
	{
		const w = world();
		check("R1 marked Personal ($200, the whole receipt)", (await mark(w, 1)).status, 201);
		const g = await w.generate(DRIVER_A);
		const b = await w.generate(DRIVER_B);
		const id = g.body.invoice.id;
		check("stored as generated: receipts $545.50, pay $900, Personal $200, receipts R5, R1, R2", stored(w, id), [545.5, 900, 200, "[5,1,2]"]);
		const rows = await list(w);
		check("what the screen prints beside \"Expenses (ref)\": $345.50, not $545.50", SCREEN_FIELD && rowFor(rows, id)[SCREEN_FIELD], 345.5);
		check("Expenses (ref) $345.50: R1 counts $0", rowFor(rows, id).expenses_ref_total, 345.5);
		check("the row still carries the stored receipts total and its total due", [rowFor(rows, id).expenses_total, rowFor(rows, id).total_due], [545.5, 700]);
		check("the driver's own list says the same", await refOf(w, id, "driverA"), 345.5);
		check("another driver's invoice: its own receipts, untouched", [rowFor(rows, b.body.invoice.id).expenses_ref_total, rowFor(rows, b.body.invoice.id).expenses_total], [30, 30]);
		check("the stored row is never rewritten by the list", stored(w, id), [545.5, 900, 200, "[5,1,2]"]);
		w.cleanup();
	}

	section("§2 a partial mark after generation");
	{
		const w = world();
		const g = await w.generate(DRIVER_A);
		const id = g.body.invoice.id;
		check("before any mark: $545.50", await refOf(w, id), 545.5);
		check("$120 of R5 ($300) marked Personal, attached to the Draft", (await mark(w, 5, { amount: "120" })).body.personal.state, "invoiced");
		check("Expenses (ref) $425.50: R5 counts its other $180", await refOf(w, id), 425.5);
		await mark(w, 1);
		check("R1 in full as well: $225.50", await refOf(w, id), 225.5);
		check("stored receipts total still $545.50", w.invoice(id).expenses_total, 545.5);
		w.cleanup();
	}

	section("§3 marked after approval: the week's correction");
	{
		const w = world();
		const g = await w.generate(DRIVER_A);
		const weekly = g.body.invoice.id;
		approve(w, weekly);
		check("R1 marked: a correction invoice carries the line", (await mark(w, 1)).body.personal.state, "correction");
		const corr = w.db.prepare("SELECT id FROM invoices WHERE is_correction = 1").get();
		const rows = await list(w);
		check("the approved weekly invoice: $345.50", rowFor(rows, weekly).expenses_ref_total, 345.5);
		check("…its stored row unchanged (Approved, $545.50, $900, no Personal)", [w.invoice(weekly).status, ...stored(w, weekly).slice(0, 3)], ["Approved", 545.5, 900, 0]);
		check("the correction (manual) keeps its own figure, $0", [rowFor(rows, corr.id).expenses_ref_total, rowFor(rows, corr.id).expenses_total], [0, 0]);
		w.cleanup();
	}

	section("§4 undo and reverse put the receipt back");
	{
		const w = world();
		const g = await w.generate(DRIVER_A);
		const id = g.body.invoice.id;
		await mark(w, 1);
		check("marked: $345.50", await refOf(w, id), 345.5);
		const u = await w.call("DELETE", "/api/expenses/1/personal", { as: "admin", body: { reason: "test" } });
		check("undone", u.status, 200);
		check("Expenses (ref) back to $545.50", await refOf(w, id), 545.5);

		const w2 = world();
		const g2 = await w2.generate(DRIVER_A);
		const id2 = g2.body.invoice.id;
		await mark(w2, 1);
		approve(w2, id2);
		const r = await w2.call("POST", "/api/expenses/1/personal/reverse", { as: "admin", body: { reason: "test" } });
		check("reversed after approval", r.status, 201);
		check("the reversal books in the same open month: back to $545.50", await refOf(w2, id2), 545.5);
		w.cleanup();
		w2.cleanup();
	}

	section("§5 a receipt in a closed month");
	{
		const w = world();
		// A W39 invoice that billed R6 ($80, 2026-09-28; September is closed).
		const ins = w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, pdf_file_name, load_ids, expense_ids, render_data)
			VALUES ('INV-TDA-2026W39-01', 'test driver a', '2026-09-26', '2026-10-02', 1, 300, 300, 80, 'Paid', 'INV-TDA-2026W39-01.pdf', '[]', '[6]', '{}')`).run();
		const id = Number(ins.lastInsertRowid);
		check("R6 marked Personal", (await mark(w, 6)).status, 201);
		check("…as a credit in the open month (in_place 0)", w.lines().map((l) => [l.expense_id, l.in_place, l.cost_period]), [[6, 0, "2026-10"]]);
		check("the closed month's invoice keeps $80, as recorded", await refOf(w, id), 80);
		w.cleanup();
	}

	section("§6 owner-operator");
	{
		const w = world();
		await mark(w, 8);
		const g = await w.generate(OWNER_OP);
		const id = g.body.invoice.id;
		check("stored: receipts R7 $700 + R8 $100 = $800", w.invoice(id).expenses_total, 800);
		check("Expenses (ref) $700: R8 is Personal in full", await refOf(w, id), 700);
		w.cleanup();
	}

	section("§7 flag off");
	{
		const w = world({});
		const a = await w.generate(DRIVER_A);
		const o = await w.generate(OWNER_OP);
		const m = w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, pdf_file_name, load_ids, expense_ids, render_data, is_manual)
			VALUES ('INV-M-TDA-2026W41-01', 'test driver a', '2026-10-10', '2026-10-16', 1, 0, 500, 62.25, 'Draft', 'INV-M-TDA-2026W41-01.pdf', '[]', '[1]', '{}', 1)`).run();
		const byId = Object.fromEntries((await list(w)).map((r) => [r.id, [r.expenses_ref_total, Object.is(r.expenses_ref_total, r.expenses_total)]]));
		check("no Personal line: every row's figure is its stored one, exactly (weekly, owner-operator, manual)",
			[byId[a.body.invoice.id], byId[o.body.invoice.id], byId[Number(m.lastInsertRowid)]], [[545.5, true], [800, true], [62.25, true]]);
		check("a new mark is refused", (await mark(w, 1)).status, 403);
		w.cleanup();

		const on = world();
		const g = await on.generate(DRIVER_A);
		await mark(on, 1);
		const manual = on.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, pdf_file_name, load_ids, expense_ids, render_data, is_manual)
			VALUES ('INV-M-TDA-2026W41-02', 'test driver a', '2026-10-10', '2026-10-16', 1, 0, 500, 62.25, 'Draft', 'INV-M-TDA-2026W41-02.pdf', '[]', '[1]', '{}', 1)`).run();
		const rowsOn = await list(on);
		check("a manual invoice's figure is its deductions, whatever it lists", rowFor(rowsOn, Number(manual.lastInsertRowid)).expenses_ref_total, 62.25);
		// The same database read by a server started with the flag off (M3).
		const off = buildPersonalWorld({ env: {}, receipts: true });
		off.db.exec("DELETE FROM invoices; DELETE FROM expense_personal;");
		for (const r of on.db.prepare("SELECT * FROM invoices").all()) {
			const cols = Object.keys(r);
			off.db.prepare(`INSERT INTO invoices (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => r[c]));
		}
		for (const r of on.db.prepare("SELECT * FROM expense_personal").all()) {
			const cols = Object.keys(r);
			off.db.prepare(`INSERT INTO expense_personal (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => r[c]));
		}
		check("a line already made, flag off: still left out ($345.50)", await refOf(off, g.body.invoice.id), 345.5);
		on.cleanup();
		off.cleanup();
	}

	section("§8 expensesRefTotal()");
	{
		const fn = personalExpense.expensesRefTotal;
		check("exported by lib/personal-expense.js", typeof fn, "function");
		if (typeof fn === "function") {
			check("no parts: the stored figure itself", [fn(545.5, []), fn(545.5), fn(0.1 + 0.2, [])], [545.5, 545.5, 0.1 + 0.2]);
			check("a part of 0 or less leaves it untouched", [fn(545.5, [{ personalCents: 0, receiptCents: 20000 }]), fn(545.5, [{ personalCents: -500, receiptCents: 20000 }])], [545.5, 545.5]);
			check("a full and a partial part", fn(545.5, [{ personalCents: 20000, receiptCents: 20000 }, { personalCents: 12000, receiptCents: 30000 }]), 225.5);
			check("a part counts at most its receipt", fn(545.5, [{ personalCents: 99999, receiptCents: 20000 }]), 345.5);
			check("never below $0", fn(100, [{ personalCents: 20000, receiptCents: 20000 }]), 0);
			check("to the cent", fn(0.3, [{ personalCents: 10, receiptCents: 10 }]), 0.2);
		}
	}

	section("§9 the screen");
	{
		const view = VIEW;
		check("\"Expenses (ref)\" prints the server's expenses_ref_total for a weekly invoice",
			/<div v-else-if="!selectedInvoice\.is_manual && selectedInvoice\.expenses_ref_total" class="meta-row"><span class="meta-label">Expenses \(ref\)<\/span><span>\$\{\{ fmtMoney\(selectedInvoice\.expenses_ref_total\) \}\}<\/span><\/div>/.test(view), true);
		check("a manual invoice's \"Deductions (in total)\" is its expenses_total, as before",
			/<div v-if="selectedInvoice\.is_manual && selectedInvoice\.expenses_total" class="meta-row"><span class="meta-label">Deductions \(in total\)<\/span><span>\$\{\{ fmtMoney\(selectedInvoice\.expenses_total\) \}\}<\/span><\/div>/.test(view), true);
		check("the CSV's Expenses column is the same server figure", /r\.adjustment \|\| 0, r\.expenses_ref_total,/.test(view), true);
		check("no arithmetic on it in the browser", /expenses_ref_total\s*[-+*/]|[-+*/]\s*\w*\.?expenses_ref_total/.test(view), false);
	}

	finish();
})().catch((err) => {
	console.error(err && err.stack ? err.stack : err);
	process.exit(1);
});
