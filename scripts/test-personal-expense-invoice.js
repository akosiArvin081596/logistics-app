#!/usr/bin/env node
/**
 * "Personal" receipts on the weekly invoice: where a line lands, what the
 * invoice then says and totals, and the Friday sweep. Lifted from server.js on
 * the world in scripts/lib/personal-world.js (made-up data; clock Thu
 * 2026-10-15 12:00 ET; week W41 = Sat 10-10 .. Fri 10-16).
 *
 *   §1  T5   company driver, marked before generation: $900 - $200 = $700; the
 *            render data, the PDF fields and the row agree
 *   §2  T5b  attached to the Submitted W41 after generation: re-rendered, $700
 *   §3  T5c  W41 Approved: a correction Draft (manual, total_earnings 0,
 *            correction_of W41) carries -$200; W41 untouched; a second mark that
 *            week joins it; nothing on W42
 *   §4  T8c  no weekly invoice: the sweep (after Saturday 06:00 ET, autogen off)
 *            flags the line, makes no invoice, tells Super Admins; a weekly
 *            invoice generated later takes it; or a Super Admin creates the
 *            week's correction from it
 *   §5  M2   a mark during the generation render: the invoice commits, then the
 *            line lands on it through the attach path
 *   §6  M-b  the attach after generation fails: the line stays unattached and
 *            the sweep places it (attaches, or flags when that invoice was
 *            approved meanwhile); Draft -> Submitted mid-render is accepted
 *   §7  T8d/T8e a Draft regenerate keeps the line (new row, same number,
 *            adjustment kept); a regenerate of another week never takes it
 *   §8  T18  a week touching a closed month: the line waits for that week's
 *            correction, never another week's; undo on that invoice 409; the
 *            correction for that week is refused until v2
 *   §9  T19  soft-delete and generate again re-links the line; restoring a
 *            correction whose line moved is refused
 *   §10 T9/T10/T11 undo before approval (voided, total back, re-rendered,
 *            audited); undo after approval 409 (audited); reverse: the next
 *            week's invoice credits +$200, or its correction when approved; a
 *            second reverse 409
 *   §11 Q4   never negative: $200 and $150 on $300 of pay; a later -$150
 *            adjustment detaches the $200 line and flags it
 *   §12 T17 family, owner-operator 25%: $4,000 revenue, $800 fuel incl. a $100
 *            personal receipt is $725 whether marked before (base $3,300, pay
 *            $825) or after the invoice exists (+$25 share returned, -$100);
 *            approved: correction +$25 / -$100; a regenerate resets the share;
 *            the share uses the percentage of the invoice that counted the receipt
 *   §13 two drivers marked the same week: neither line reaches the other's invoice
 *   §14 M3   rows present, flag off: a new mark 403; generation attaches the
 *            existing line; the sweep flags; undo and reverse still work
 *   §15 totals: invoiceTotalDue() includes both new columns and throws on a row
 *            read without them; the payment report and the driver app list
 *            select them; Financials "invoiced" adds the share returned only
 *   §16 the money review's Lows: L1 a regenerate moves a reversed line's base
 *            with it (a mark again gets its share); L2 the correction refreshes
 *            the share and re-checks the week's month inside its write; L3 the
 *            sweep never flags a line attached meanwhile; L4 a Dispatcher's list
 *            carries no share or invoice; L5 a detach updates the stored render data
 * The receipt's week (PERSONAL_RECEIPT_WEEK_ENABLED, on only when exactly "true"):
 * a line belongs to the week of its receipt date; when that week's invoice can't
 * take it, it is carried to the driver's next open weekly invoice with room.
 *   §17 W2   W40 Submitted takes an Oct 7 receipt marked Thu Oct 15 at once
 *   §18 W3   W41 Approved: the mark is carried (no correction); W42's
 *            generation takes it
 *   §19 W4   W41 Approved, W42 Submitted: the mark lands on W42 keyed to W41;
 *            the driver sees the invoice's week
 *   §20 W5   a line W41 can't take, at generation or after an adjustment, goes
 *            on W42
 *   §21 W6   a receipt week touching closed September: carried to W40, past the
 *            open Sep 26 - Oct 2 invoice
 *   §22 W7   a receipt several weeks old lands on the oldest open invoice
 *   §23 W8   the sweep carries and attaches, never notifies; a mark and the
 *            sweep redrawing one invoice: one write refuses, no line doubled;
 *            pin: a line a generation took meanwhile is never carried
 *   §24 W9   a line flagged before the switch goes on W42
 *   §25 pin  an owner-operator's carried line keeps its share
 *   §26 W14  Reverse of a waiting line whose month closed: offered (can_reverse),
 *            and neither row ever goes on an invoice
 *   §27 W16  a generation of a week touching a closed month takes no new line;
 *            the lines on the Draft it replaces stay
 *   §28 W19  Reverse of an owner-operator's line whose base is on another
 *            invoice: the line still goes on an invoice and its reversal follows
 *            it there, so the share comes back; with no driver to carry it, 409
 *   §29 W20  a reversed charge whose credit is on an invoice is collected (a
 *            pair left by the flag-off Reverse; a deleted invoice regenerated)
 *   §30 W21  a later invoice never takes a line its own week can take again
 *            (the write's re-check)
 *   §31 W22  delete and regenerate keeps the week's lines on the new invoice;
 *            not regenerated by the next sweep, they are carried
 *   §32 W23  the words: the adjustment's audit row, a carried line's wait
 *   §33 W24  Reverse of a line on no invoice that carries its own unreturned
 *            share, with no base elsewhere: neither row ever goes on an invoice
 *   §34 W25  Reverse of a line whose base is elsewhere, too big for the next
 *            invoice: the credit waits for its line, then follows it onto the
 *            same invoice
 *   §35 W26  a carried line put on a Draft while it is regenerated goes on the
 *            new invoice at once
 *   §36 W28  a later shrink never splits a reversed pair: an adjustment or a
 *            regenerate keeps the line and its credit together, or takes both
 *            off, and they land together later
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-personal-expense-invoice.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const path = require("path");
const { buildPersonalWorld, makeChecker, edt, DRIVER_A, DRIVER_B, OWNER_OP, ROOT, SRC } = require("./lib/personal-world");
const { check, section, finish } = makeChecker();
const POLICY_FIELD_MAPS = require(path.join(ROOT, "lib", "policy-field-maps.js"));

const ON = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" };
const world = (env = ON, opts = {}) => buildPersonalWorld({ env, ...opts });
const mark = (w, id, body = {}, as = "admin") => w.call("POST", `/api/expenses/${id}/personal`, { as, body });
const due = (w, id) => w.api.invoiceTotalDue(w.invoice(id));
const submit = (w, id) => w.db.prepare("UPDATE invoices SET status = 'Submitted', submitted_at = 't' WHERE id = ?").run(id);
const approve = (w, id) => w.db.prepare("UPDATE invoices SET status = 'Approved', approved_at = 't', approved_by = 'super_admin' WHERE id = ?").run(id);
const lastRender = (w) => w.rendered[w.rendered.length - 1] || null;
const SAT_0630 = edt("2026-10-17", 6, 30);

const WEEK_ON = { ...ON, PERSONAL_RECEIPT_WEEK_ENABLED: "true" };
// A receipt of the runner's own, beyond the world's eleven (made up, Approved).
const addReceipt = (w, { id, driver = DRIVER_A, type = "Food", amount = 45.5, date, vendor = "EXAMPLE DINER #3", truck = "T-1", owner = 7 }) =>
	w.db.prepare(`INSERT INTO expenses (id, timestamp, driver, type, amount, date, status, vendor, truck_unit, owner_id, created_at, description)
		VALUES (?, ?, ?, ?, ?, ?, 'Approved', ?, ?, ?, ?, '')`).run(id, `${date}T15:00:00.000Z`, driver, type, amount, date, vendor, truck, owner, `${date} 15:00:00`);
// A load delivered in W42 (Mon 10-19 to Tue 10-20), copied from one of the
// driver's own rows: 1 Driver A ($600), 2 the owner-operator ($2,500), 5 Driver B.
const addW42Load = (w, fromRow, loadId) => w.sheet.rows.push(w.sheet.rows[fromRow].map((v, i) =>
	({ 1: loadId, 6: "10/19/2026 8:00", 9: "10/20/2026 10:00", 20: "10/19/2026", 21: "10/20/2026", 22: "10/20/2026" })[i] ?? v));
const deductOf = (w, expenseId) => w.lines("expense_id = ? AND kind = 'deduct'", expenseId)[0] || {};
const summaryOf = (w, expenseId, role = "Super Admin") => w.api.personalSummaryForRole(w.api.personalSummaryByExpense([expenseId])[expenseId], role) || {};
const notices = (w) => w.db.prepare("SELECT COUNT(*) AS n FROM dispatch_notifications WHERE type = 'personal-expenses'").get().n;
const printed = (w) => ((lastRender(w) || { data: {} }).data.personalLines || []).map((l) => l.text);

(async () => {
	section("§1 T5 company driver, marked before generation");
	{
		const w = world();
		await mark(w, 1);
		const g = await w.generate(DRIVER_A);
		const inv = g.body.invoice;
		check("generated", g.status, 200);
		check("the invoice: pay $900, Personal $200, total due $700", [inv.total_earnings, inv.personal_total, inv.personal_share_total, due(w, inv.id)], [900, 200, 0, 700]);
		check("the line is linked to it", w.lines().map((l) => l.invoice_id), [inv.id]);
		const data = lastRender(w).data;
		check("render data: one Personal line", (data.personalLines || []).map((l) => [l.label, l.cents]), [["Personal expense, Pilot #123, Oct 12, 2026", -20000]]);
		const fields = POLICY_FIELD_MAPS.service_invoice(data);
		check("PDF: Total due 700.00", fields.text["Total due"], "700.00");
		check("PDF: the line prints -$200.00 on its own row", (fields.personalLines || []).map((l) => [l.label, l.amount]), [["Personal expense, Pilot #123, Oct 12, 2026", "-$200.00"]]);
		check("the snapshot keeps the lines it rendered", (JSON.parse(w.invoice(inv.id).render_data).personalLines || []).length, 1);
		w.cleanup();
	}

	section("§2 T5b attached to the Submitted W41");
	{
		const w = world();
		const g = await w.generate(DRIVER_A);
		submit(w, g.body.invoice.id);
		const renders = w.rendered.length;
		const r = await mark(w, 1);
		check("201, placed on W41", [r.status, r.body.personal && r.body.personal.state, r.body.personal && r.body.personal.invoice_number], [201, "invoiced", g.body.invoice.invoice_number]);
		check("re-rendered once with the line", [w.rendered.length - renders, (lastRender(w).data.personalLines || []).length], [1, 1]);
		check("W41 total due $700, still Submitted", [due(w, g.body.invoice.id), w.invoice(g.body.invoice.id).status], [700, "Submitted"]);
		const fs = require("fs");
		const file = path.join(w.dataDir, "uploads", "invoices", w.invoice(g.body.invoice.id).pdf_file_name);
		check("the file on disk is the re-render", fs.readFileSync(file, "utf8"), `%PDF-stub service_invoice ${w.rendered.length}`);
		check("an invoice_personal_lines audit row on the invoice", w.audits("invoice_personal_lines").map((a) => [a.entity, a.entity_id]), [["invoice", String(g.body.invoice.id)]]);
		w.cleanup();
	}

	section("§3 T5c W41 Approved: the week's correction");
	{
		const w = world();
		const g = await w.generate(DRIVER_A);
		const weekly = g.body.invoice.id;
		approve(w, weekly);
		const r = await mark(w, 1);
		const corr = w.db.prepare("SELECT * FROM invoices WHERE is_correction = 1").all();
		check("one correction Draft", corr.map((c) => [c.status, c.is_manual, c.correction_of, c.week_start, c.week_end]), [["Draft", 1, weekly, "2026-10-10", "2026-10-16"]]);
		check("numbered in the manual scheme", /^INV-M-TDA-2026W41-\d\d$/.test(corr[0] && corr[0].invoice_number), true);
		check("total_earnings 0, expenses_total 0, Personal $200, total due -$200",
			corr[0] && [corr[0].total_earnings, corr[0].expenses_total, corr[0].personal_total, due(w, corr[0].id)], [0, 0, 200, -200]);
		check("rendered with the manual template, the line as a deduction",
			[lastRender(w).templateName, (lastRender(w).data.deductions || []).map((d) => [d.description, d.amount])],
			["service_invoice_manual", [["Personal expense, Pilot #123, Oct 12, 2026", 200]]]);
		check("…titled as a correction to W41", /Correction to INV-TDA-2026W41-01, week of Oct 10/.test(lastRender(w).data.notes || ""), true);
		check("the response names it", r.body.personal && [r.body.personal.state, r.body.personal.invoice_number], ["correction", corr[0] && corr[0].invoice_number]);
		check("W41 untouched (Approved, $900)", [w.invoice(weekly).status, w.invoice(weekly).personal_total, due(w, weekly)], ["Approved", 0, 900]);
		check("a create_personal_correction_invoice audit row", w.audits("create_personal_correction_invoice").length, 1);
		await mark(w, 5);
		check("a second mark that week joins the same Draft", [w.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE is_correction = 1").get().n, w.invoice(corr[0].id).personal_total, due(w, corr[0].id)], [1, 500, -500]);
		check("nothing is meant for W42", w.lines("week_start != '2026-10-10'").length, 0);
		w.cleanup();
	}

	section("§4 T8c no weekly invoice: the sweep");
	{
		const w = world();
		await mark(w, 11);
		w.setNow(edt("2026-10-17", 5, 30));
		const early = await w.api.runPersonalSweep();
		check("before Saturday 06:00 ET the week is not swept", [early.weeks.length, w.lines()[0].needs_correction_since], [0, ""]);
		w.setNow(SAT_0630);
		const s = await w.api.runPersonalSweep();
		check("after it: the line is flagged for the week's correction", [s.weeks.map((x) => [x.weekStart, x.flagged, x.attached]), !!w.lines()[0].needs_correction_since, w.lines()[0].invoice_id],
			[[["2026-10-10", 1, 0]], true, null]);
		check("no invoice was created", w.db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n, 0);
		check("Super Admins are told in the app", w.db.prepare("SELECT COUNT(*) AS n FROM dispatch_notifications WHERE type = 'personal-expenses'").get().n, 1);
		check("the sweep keeps a marker", w.db.prepare("SELECT week_start FROM personal_sweep_runs").all().map((r) => r.week_start), ["2026-10-10"]);
		check("a sweep audit row", w.audits("flag_personal_expense").length, 1);
		const again = await w.api.runPersonalSweep();
		check("a second sweep changes nothing", [again.weeks.reduce((n, x) => n + x.flagged + x.attached, 0), w.db.prepare("SELECT COUNT(*) AS n FROM dispatch_notifications WHERE type = 'personal-expenses'").get().n], [0, 1]);
		const g = await w.generate(DRIVER_B, "2026-10-16");
		check("a weekly invoice generated later for that week takes the flagged line and clears the flag",
			[g.status, w.lines()[0].invoice_id === g.body.invoice.id, w.lines()[0].needs_correction_since, due(w, g.body.invoice.id)], [200, true, "", 470]);
		w.cleanup();
	}
	{
		const w = world();
		await mark(w, 11);
		w.setNow(SAT_0630);
		await w.api.runPersonalSweep();
		const r = await w.call("POST", "/api/invoices/personal-corrections", { body: { driver: DRIVER_B, weekStart: "2026-10-10" } });
		const corr = w.db.prepare("SELECT * FROM invoices WHERE is_correction = 1").all();
		check("a Super Admin creates the week's correction: 201", r.status, 201);
		check("…a Draft with no weekly invoice to correct (correction_of NULL), -$30.00",
			corr.map((c) => [c.status, c.correction_of, c.week_start, due(w, c.id)]), [["Draft", null, "2026-10-10", -30]]);
		check("…the line moved onto it and the flag cleared", [w.lines()[0].invoice_id === (corr[0] && corr[0].id), w.lines()[0].needs_correction_since], [true, ""]);
		const none = await w.call("POST", "/api/invoices/personal-corrections", { body: { driver: DRIVER_B, weekStart: "2026-10-10" } });
		check("nothing left waiting: 409 PERSONAL_NOTHING_TO_CORRECT", [none.status, none.body && none.body.code], [409, "PERSONAL_NOTHING_TO_CORRECT"]);
		const g = await w.generate(DRIVER_B, "2026-10-16");
		check("a weekly invoice generated afterwards never takes a line on a live correction", [g.status, w.invoice(g.body.invoice.id).personal_total], [200, 0]);
		w.cleanup();
	}

	section("§5 M2 a mark during the generation render");
	{
		const w = world();
		let once = false;
		w.hooks.render = async (t, d, def) => {
			if (!once) { once = true; await mark(w, 1); }
			return def(t, d);
		};
		const g = await w.generate(DRIVER_A);
		check("the invoice commits", g.status, 200);
		check("…and the late line lands on it through the attach path", [w.lines()[0].invoice_id === g.body.invoice.id, due(w, g.body.invoice.id)], [true, 700]);
		check("two renders: the generation, then the attach", [w.rendered.length, (w.rendered[0].data.personalLines || []).length, (w.rendered[1].data.personalLines || []).length], [2, 0, 1]);
		w.cleanup();
	}

	section("§6 M-b the attach after generation fails");
	{
		const w = world();
		let n = 0;
		w.hooks.render = async (t, d, def) => {
			n++;
			if (n === 1) await mark(w, 1);
			if (n === 2) throw new Error("render failed");
			return def(t, d);
		};
		const g = await w.generate(DRIVER_A);
		check("the invoice still commits (200), the line stays unattached", [g.status, w.lines()[0].invoice_id, w.lines()[0].needs_correction_since], [200, null, ""]);
		submit(w, g.body.invoice.id);
		w.setNow(SAT_0630);
		const s = await w.api.runPersonalSweep();
		check("the sweep attaches it to the week's not-approved invoice", [s.weeks[0] && s.weeks[0].attached, w.lines()[0].invoice_id === g.body.invoice.id, due(w, g.body.invoice.id)], [1, true, 700]);
		w.cleanup();
	}
	{
		const w = world();
		let n = 0;
		w.hooks.render = async (t, d, def) => {
			n++;
			if (n === 1) await mark(w, 1);
			if (n === 2) throw new Error("render failed");
			return def(t, d);
		};
		const g = await w.generate(DRIVER_A);
		approve(w, g.body.invoice.id);
		w.setNow(SAT_0630);
		await w.api.runPersonalSweep();
		check("…or flags it when that invoice was approved meanwhile", [w.lines()[0].invoice_id, !!w.lines()[0].needs_correction_since], [null, true]);
		w.cleanup();
	}
	{
		const w = world();
		const g = await w.generate(DRIVER_A);
		w.hooks.render = async (t, d, def) => { submit(w, g.body.invoice.id); return def(t, d); };
		const r = await mark(w, 1);
		check("Draft -> Submitted during the attach render is accepted", [r.status, w.lines()[0].invoice_id === g.body.invoice.id, w.invoice(g.body.invoice.id).status], [201, true, "Submitted"]);
		w.cleanup();
	}
	{
		const w = world();
		const g = await w.generate(DRIVER_A);
		w.hooks.render = async (t, d, def) => { approve(w, g.body.invoice.id); return def(t, d); };
		const r = await mark(w, 1);
		check("approved during the attach render: 409 PERSONAL_CHANGED, nothing written", [r.status, r.body && r.body.code, w.lines().length], [409, "PERSONAL_CHANGED", 0]);
		w.cleanup();
	}

	section("§7 T8d / T8e regenerate");
	{
		const w = world();
		const g = await w.generate(DRIVER_A);
		await w.call("PUT", `/api/invoices/${g.body.invoice.id}/adjust`, { body: { adjustment: 50, adjustmentNote: "Detention" } });
		await mark(w, 1);
		check("the line is on the Draft", w.lines()[0].invoice_id, g.body.invoice.id);
		const g2 = await w.generate(DRIVER_A);
		check("T8d regenerate: a new row, the same number", [g2.status, g2.body.invoice.id !== g.body.invoice.id, g2.body.invoice.invoice_number], [200, true, g.body.invoice.invoice_number]);
		check("…the line re-linked, the adjustment kept: $900 + $50 - $200", [w.lines()[0].invoice_id === g2.body.invoice.id, due(w, g2.body.invoice.id)], [true, 750]);
		w.cleanup();
	}
	{
		const w = world();
		const w40 = await w.generate(DRIVER_A, "2026-10-09");
		await mark(w, 1);
		const again = await w.generate(DRIVER_A, "2026-10-09");
		check("T8e a W40 regenerate after marking in W41 takes no line", [again.status, w.invoice(again.body.invoice.id).personal_total, w.lines()[0].invoice_id], [200, 0, null]);
		check("…W40 total due unchanged ($600)", [due(w, again.body.invoice.id), w40.body.invoice.total_earnings], [600, 600]);
		w.cleanup();
	}

	section("§8 T18 a week touching a closed month");
	{
		const w = world(ON, { nowMs: edt("2026-10-01", 12) });
		const ins = w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, pdf_file_name, render_data)
			VALUES ('INV-TDA-2026W39-01', 'test driver a', '2026-09-26', '2026-10-02', 2, 300, 600, 'Submitted', 'INV-TDA-2026W39-01.pdf', '{}')`).run();
		const r = await mark(w, 1);
		check("the line waits for that week's correction (flagged), on no invoice", [r.status, w.lines()[0].week_start, w.lines()[0].invoice_id, !!w.lines()[0].needs_correction_since], [201, "2026-09-26", null, true]);
		check("…the week's invoice is untouched", w.invoice(ins.lastInsertRowid).personal_total, 0);
		const corr = await w.call("POST", "/api/invoices/personal-corrections", { body: { driver: DRIVER_A, weekStart: "2026-09-26" } });
		check("the correction for a week touching a closed month is refused (409 PERIOD_FINALIZED)", [corr.status, corr.body && corr.body.code], [409, "PERIOD_FINALIZED"]);
		w.db.prepare("UPDATE expense_personal SET invoice_id = ?, needs_correction_since = '' WHERE id = ?").run(ins.lastInsertRowid, w.lines()[0].id);
		const undo = await w.call("DELETE", "/api/expenses/1/personal", { body: {} });
		check("undo of a line on that invoice: 409 PERIOD_FINALIZED", [undo.status, undo.body && undo.body.code], [409, "PERIOD_FINALIZED"]);
		w.cleanup();
	}

	section("§9 T19 soft-delete and generate again; restore");
	{
		const w = world();
		const g = await w.generate(DRIVER_A);
		await mark(w, 1);
		await w.call("DELETE", `/api/invoices/${g.body.invoice.id}`, { query: { reason: "redo" } });
		const g2 = await w.generate(DRIVER_A);
		check("the line is re-linked to the new invoice", [g2.status, w.lines()[0].invoice_id === g2.body.invoice.id, due(w, g2.body.invoice.id)], [200, true, 700]);
		const restore = await w.call("PUT", `/api/invoices/${g.body.invoice.id}/restore`);
		check("restoring the old one: 409", restore.status, 409);
		w.cleanup();
	}
	{
		const w = world();
		const g = await w.generate(DRIVER_A);
		approve(w, g.body.invoice.id);
		await mark(w, 1);
		const c1 = w.db.prepare("SELECT id FROM invoices WHERE is_correction = 1").get().id;
		await w.call("DELETE", `/api/invoices/${c1}`, { query: { reason: "redo" } });
		await mark(w, 5);
		const c2 = w.db.prepare("SELECT id FROM invoices WHERE is_correction = 1 AND deleted_at = ''").get().id;
		check("a new correction takes the line of the deleted one", [w.lines("expense_id = 1")[0].invoice_id === c2, w.invoice(c2).personal_total], [true, 500]);
		const restore = await w.call("PUT", `/api/invoices/${c1}/restore`);
		check("restoring the deleted correction: 409 PERSONAL_LINES_MOVED", [restore.status, restore.body && restore.body.code], [409, "PERSONAL_LINES_MOVED"]);
		w.cleanup();
	}

	section("§10 T9 / T10 / T11 undo and reverse");
	{
		const w = world();
		const g = await w.generate(DRIVER_A);
		submit(w, g.body.invoice.id);
		await mark(w, 1);
		const renders = w.rendered.length;
		const u = await w.call("DELETE", "/api/expenses/1/personal", { body: { reason: "wrong receipt" } });
		check("T9 undo: 200; the row voided, not deleted", [u.status, w.lines().length, !!w.lines()[0].voided_at, w.lines()[0].invoice_id], [200, 1, true, null]);
		check("…Personal $0, total back to $900, re-rendered without the line",
			[w.invoice(g.body.invoice.id).personal_total, due(w, g.body.invoice.id), w.rendered.length - renders, (lastRender(w).data.personalLines || []).length], [0, 900, 1, 0]);
		check("…audited", w.audits("undo_expense_personal").length, 1);
		w.cleanup();
	}
	{
		const w = world();
		const g = await w.generate(DRIVER_A);
		submit(w, g.body.invoice.id);
		await mark(w, 1);
		approve(w, g.body.invoice.id);
		const u = await w.call("DELETE", "/api/expenses/1/personal", { body: {} });
		check("T10 undo after approval: 409 PERSONAL_INVOICE_APPROVED", [u.status, u.body && u.body.code], [409, "PERSONAL_INVOICE_APPROVED"]);
		check("…nothing written; the refusal audited", [w.lines()[0].voided_at, w.invoice(g.body.invoice.id).personal_total, w.audits("undo_expense_personal_blocked").length], ["", 200, 1]);
		w.setNow(edt("2026-10-22", 12));
		w.sheet.rows.push(w.sheet.rows[1].map((v, i) => ({ 1: "L7", 6: "10/19/2026 8:00", 9: "10/20/2026 10:00", 20: "10/19/2026", 21: "10/20/2026", 22: "10/20/2026" })[i] ?? v));
		const rv = await w.call("POST", "/api/expenses/1/personal/reverse", { body: { reason: "not personal after all" } });
		const rows = w.lines("kind = 'reverse'");
		check("T11 reverse: 201, a reverse row for the week of 2026-10-17", [rv.status, rows.map((r) => [r.cents, r.week_start, r.invoice_id])], [201, [[20000, "2026-10-17", null]]]);
		check("…the original line stays on its approved invoice", [w.lines("kind = 'deduct'")[0].invoice_id, w.lines("kind = 'deduct'")[0].reversed_by_id === rows[0].id], [g.body.invoice.id, true]);
		const g42 = await w.generate(DRIVER_A, "2026-10-23");
		check("…W42 carries +$200.00 Personal expense reversed: $600 + $200", [g42.status, (lastRender(w).data.personalLines || []).map((l) => l.text), due(w, g42.body.invoice.id)],
			[200, ["Personal expense reversed, Pilot #123, Oct 12, 2026: +$200.00"], 800]);
		const again = await w.call("POST", "/api/expenses/1/personal/reverse", { body: {} });
		check("a second reverse: 409 PERSONAL_ALREADY_REVERSED", [again.status, again.body && again.body.code], [409, "PERSONAL_ALREADY_REVERSED"]);
		check("audited", w.audits("reverse_expense_personal").length, 1);
		w.cleanup();
	}
	{
		const w = world();
		const g = await w.generate(DRIVER_A);
		approve(w, g.body.invoice.id);
		await mark(w, 1);
		w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE is_correction = 1").run();
		w.setNow(edt("2026-10-22", 12));
		w.sheet.rows.push(w.sheet.rows[1].map((v, i) => ({ 1: "L7", 6: "10/19/2026 8:00", 9: "10/20/2026 10:00", 20: "10/19/2026", 21: "10/20/2026", 22: "10/20/2026" })[i] ?? v));
		const g42 = await w.generate(DRIVER_A, "2026-10-23");
		approve(w, g42.body.invoice.id);
		await w.call("POST", "/api/expenses/1/personal/reverse", { body: {} });
		const corr = w.db.prepare("SELECT * FROM invoices WHERE is_correction = 1 AND week_start = '2026-10-17'").all();
		check("T11 with W42 approved: a W42 correction Draft with a +$200 line item",
			[corr.length, corr[0] && corr[0].correction_of === g42.body.invoice.id, (lastRender(w).data.lineItems || []).map((i) => [i.description, i.amount]), corr[0] && due(w, corr[0].id)],
			[1, true, [["Personal expense reversed, Pilot #123, Oct 12, 2026", 200]], 200]);
		check("…the company driver's reversal returns no share", corr[0] && corr[0].personal_share_total, 0);
		w.cleanup();
	}

	section("§11 Q4 never negative");
	{
		const w = world();
		w.db.prepare("UPDATE drivers_directory SET pay_daily = 150 WHERE driver_name = ?").run(DRIVER_B);
		const add = w.db.prepare("INSERT INTO expenses (id, timestamp, driver, type, amount, date, status, vendor, truck_unit, owner_id, created_at, description) VALUES (?, 't', ?, 'Food', ?, ?, 'Approved', ?, 'T-3', 0, ?, '')");
		add.run(12, DRIVER_B, 200, "2026-10-13", "Diner #2", "2026-10-13 15:00:00");
		add.run(13, DRIVER_B, 150, "2026-10-14", "Diner #3", "2026-10-14 15:00:00");
		await mark(w, 12);
		await mark(w, 13);
		const g = await w.generate(DRIVER_B);
		check("$300 of pay: the $200 line (older) on W41, total $100", [g.body.invoice.total_earnings, w.lines("expense_id = 12")[0].invoice_id === g.body.invoice.id, due(w, g.body.invoice.id)], [300, true, 100]);
		check("…the $150 line waits for the week's correction", [w.lines("expense_id = 13")[0].invoice_id, !!w.lines("expense_id = 13")[0].needs_correction_since], [null, true]);
		submit(w, g.body.invoice.id);
		const adj = await w.call("PUT", `/api/invoices/${g.body.invoice.id}/adjust`, { body: { adjustment: -150, adjustmentNote: "Advance" } });
		check("a later -$150 adjustment: 200, the $200 line detached and flagged", [adj.status, w.lines("expense_id = 12")[0].invoice_id, !!w.lines("expense_id = 12")[0].needs_correction_since], [200, null, true]);
		check("…the invoice totals $150, never below $0", [w.invoice(g.body.invoice.id).personal_total, due(w, g.body.invoice.id)], [0, 150]);
		check("…the detach is audited", w.audits("detach_personal_expense").length, 1);
		w.cleanup();
	}

	section("§12 T17 owner-operator, 25%");
	{
		const w = world();
		await mark(w, 8);
		const g = await w.generate(OWNER_OP);
		const d = lastRender(w).data;
		check("T17 marked before generation: deductible $700, net $3,300, pay $825", [d.deductible, d.net, d.totalEarnings, g.body.invoice.total_earnings], [700, 3300, 825, 825]);
		check("…line -$100, total due $725", [w.invoice(g.body.invoice.id).personal_total, w.invoice(g.body.invoice.id).personal_share_total, due(w, g.body.invoice.id)], [100, 0, 725]);
		check("…the personal receipt leaves the deductible table", (d.fuelMaintExpenses || []).map((e) => e.amount), [700]);
		check("…PDF Total due 725.00", POLICY_FIELD_MAPS.service_invoice_owner_op(d).text["Total due"], "725.00");
		w.cleanup();
	}
	{
		const w = world();
		const g = await w.generate(OWNER_OP);
		submit(w, g.body.invoice.id);
		await mark(w, 8);
		const inv = w.invoice(g.body.invoice.id);
		check("T17c marked after (Submitted W41 deducted it): $800 + $25 - $100 = $725", [inv.total_earnings, inv.personal_share_total, inv.personal_total, due(w, inv.id)], [800, 25, 100, 725]);
		check("…the invoice prints the share returned and the Personal line", (lastRender(w).data.personalLines || []).map((l) => l.text),
			["Fuel share returned, Shell #9, Oct 13, 2026: +$25.00", "Personal expense, Shell #9, Oct 13, 2026: -$100.00"]);
		check("…PDF Total due 725.00", POLICY_FIELD_MAPS.service_invoice_owner_op(lastRender(w).data).text["Total due"], "725.00");
		w.cleanup();
	}
	{
		const w = world();
		const g40 = await w.generate(OWNER_OP, "2026-10-09");
		approve(w, g40.body.invoice.id);
		await mark(w, 10);
		check("T17b W40 (approved) counted R; marked in W41: the line carries the $25 share", w.lines()[0].share_cents, 2500);
		const g41 = await w.generate(OWNER_OP);
		check("…W41: pay $800, +$25, -$100 = $725 (W41 pay - $75)", [g41.body.invoice.total_earnings, due(w, g41.body.invoice.id)], [800, 725]);
		check("…W40 untouched", [w.invoice(g40.body.invoice.id).personal_total, due(w, g40.body.invoice.id)], [0, 800]);
		w.cleanup();
	}
	{
		const w = world();
		const g = await w.generate(OWNER_OP);
		approve(w, g.body.invoice.id);
		await mark(w, 8);
		const c = w.db.prepare("SELECT * FROM invoices WHERE is_correction = 1").get();
		check("T17d W41 approved: the correction carries +$25 / -$100 = -$75", c && [c.total_earnings, c.personal_share_total, c.personal_total, due(w, c.id)], [0, 25, 100, -75]);
		check("…as a line item and a deduction", [(lastRender(w).data.lineItems || []).map((i) => i.amount), (lastRender(w).data.deductions || []).map((i) => i.amount)], [[25], [100]]);
		w.cleanup();
	}
	{
		const w = world();
		const g = await w.generate(OWNER_OP);
		await mark(w, 8);
		check("T17e marked on the W41 Draft: share $25 attached", [w.lines()[0].share_cents, w.lines()[0].invoice_id === g.body.invoice.id, due(w, g.body.invoice.id)], [2500, true, 725]);
		const g2 = await w.generate(OWNER_OP);
		check("…regenerate: the share resets to $0 in the same commit, $825 - $100 = $725, never $750",
			[g2.status, w.lines()[0].share_cents, g2.body.invoice.total_earnings, due(w, g2.body.invoice.id)], [200, 0, 825, 725]);
		await w.call("DELETE", `/api/invoices/${g2.body.invoice.id}`, { query: { reason: "redo" } });
		const g3 = await w.generate(OWNER_OP);
		check("…the same after soft-delete and generate again", [g3.status, w.lines()[0].share_cents, due(w, g3.body.invoice.id)], [200, 0, 725]);
		w.cleanup();
	}
	{
		const w = world();
		const g40 = await w.generate(OWNER_OP, "2026-10-09");
		approve(w, g40.body.invoice.id);
		w.db.prepare("UPDATE drivers_directory SET pay_percentage = 30 WHERE driver_name = ?").run(OWNER_OP);
		await mark(w, 10);
		const g41 = await w.generate(OWNER_OP);
		check("the share uses W40's 25% (the invoice that counted it), not W41's 30%", [w.lines()[0].share_cents, g41.body.invoice.total_earnings, due(w, g41.body.invoice.id)], [2500, 960, 885]);
		w.cleanup();
	}
	{
		const w = world();
		const g = await w.generate(OWNER_OP);
		submit(w, g.body.invoice.id);
		await mark(w, 8);
		approve(w, g.body.invoice.id);
		w.setNow(edt("2026-10-22", 12));
		await w.call("POST", "/api/expenses/8/personal/reverse", { body: {} });
		check("an owner-operator reversal takes the $25 share back with the $100 credit", w.lines("kind = 'reverse'").map((r) => [r.cents, r.share_cents]), [[10000, 2500]]);
		w.cleanup();
	}
	{
		const w = world();
		await mark(w, 8);
		const g = await w.generate(OWNER_OP);
		submit(w, g.body.invoice.id);
		await w.call("DELETE", "/api/expenses/8/personal", { body: {} });
		check("undo of a line marked before generation restores the base: $800, total $800",
			[w.invoice(g.body.invoice.id).total_earnings, w.invoice(g.body.invoice.id).personal_total, due(w, g.body.invoice.id)], [800, 0, 800]);
		w.cleanup();
	}

	section("§13 two drivers marked the same week");
	{
		const w = world();
		await mark(w, 1);
		await mark(w, 11);
		const ga = await w.generate(DRIVER_A);
		const textA = JSON.stringify(lastRender(w).data.personalLines);
		const gb = await w.generate(DRIVER_B);
		const textB = JSON.stringify(lastRender(w).data.personalLines);
		check("A's invoice carries only A's line, B's only B's",
			[w.lines("invoice_id = ?", ga.body.invoice.id).map((l) => l.expense_id), w.lines("invoice_id = ?", gb.body.invoice.id).map((l) => l.expense_id)], [[1], [11]]);
		check("…and prints only its own", [/Diner/.test(textA), /Pilot/.test(textB)], [false, false]);
		check("…totals $700 and $470", [due(w, ga.body.invoice.id), due(w, gb.body.invoice.id)], [700, 470]);
		w.cleanup();
	}

	section("§14 M3 rows present, flag off");
	{
		const w = world({});
		w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
			VALUES (1, 'deduct', 20000, 20000, 'Pilot #123', '2026-10-12', '2026-10', 1, '2026-10-12', '2026-10-10', 't', 'super_admin', 1, 'Super Admin')`).run();
		const m = await mark(w, 5);
		check("a new mark: 403 PERSONAL_DISABLED", [m.status, m.body && m.body.code], [403, "PERSONAL_DISABLED"]);
		const g = await w.generate(DRIVER_A);
		check("generation attaches the existing line ($700)", [w.lines()[0].invoice_id === g.body.invoice.id, due(w, g.body.invoice.id)], [true, 700]);
		submit(w, g.body.invoice.id);
		const u = await w.call("DELETE", "/api/expenses/1/personal", { body: {} });
		check("Super Admin undo still works", [u.status, due(w, g.body.invoice.id)], [200, 900]);
		w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
			VALUES (11, 'deduct', 3000, 3000, 'Diner #2', '2026-10-13', '2026-10', 1, '2026-10-13', '2026-10-10', 't', 'super_admin', 1, 'Super Admin')`).run();
		w.setNow(SAT_0630);
		await w.api.runPersonalSweep();
		check("the sweep flags a line with no weekly invoice", !!w.lines("expense_id = 11")[0].needs_correction_since, true);
		approve(w, g.body.invoice.id);
		w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, invoice_id, created_at, created_by, created_by_id, created_role)
			VALUES (5, 'deduct', 1000, 30000, 'Pilot #123', '2026-10-11', '2026-10', 1, '2026-10-11', '2026-10-10', ?, 't', 'super_admin', 1, 'Super Admin')`).run(g.body.invoice.id);
		const rv = await w.call("POST", "/api/expenses/5/personal/reverse", { body: {} });
		check("Super Admin reverse still works", rv.status, 201);
		w.cleanup();
	}

	section("§15 totals");
	{
		const w = world();
		let threw = "";
		try { w.api.invoiceTotalDue({ total_earnings: 900, adjustment: 0, personal_share_total: 0 }); } catch (e) { threw = e.message; }
		check("invoiceTotalDue() throws on a row read without personal_total (not $0)", /personal_total/.test(threw), true);
		threw = "";
		try { w.api.invoiceTotalDue({ total_earnings: 900, adjustment: 0, personal_total: 0 }); } catch (e) { threw = e.message; }
		check("…or without personal_share_total", /personal_share_total/.test(threw), true);
		check("total_earnings + adjustment + share returned - repayments", w.api.invoiceTotalDue({ total_earnings: 800, adjustment: -10, personal_total: 100, personal_share_total: 25, correction_lines_total: 0 }), 715);
		await mark(w, 1);
		const g = await w.generate(DRIVER_A);
		submit(w, g.body.invoice.id);
		const report = w.api.buildPaymentReport(DRIVER_A, "2026-10-10", "2026-10-16");
		check("the payment report serves both columns and the total due", report.invoices.map((r) => [r.personal_total, r.personal_share_total, r.total_due]), [[200, 0, 700]]);
		const driverList = SRC.slice(SRC.indexOf("const driverInvoices = db.prepare("), SRC.indexOf("const driverInvoices = db.prepare(") + 900);
		check("the driver app list selects both columns", [/personal_total/.test(driverList), /personal_share_total/.test(driverList)], [true, true]);
		// The invoiced figure's columns are read by financialsInvoiceShares() and
		// added up by lib/invoice-month-split.js.
		const finStart = SRC.indexOf("function financialsInvoiceShares(");
		const fin = SRC.slice(finStart, SRC.indexOf("\n}\n", finStart)) + require("fs").readFileSync(path.join(__dirname, "..", "lib", "invoice-month-split.js"), "utf8");
		check("Financials \"invoiced\" adds the share returned and never subtracts repayments", [finStart !== -1 && /personal_share_total/.test(fin), /personal_total\b(?!_)/.test(fin.replace(/personal_share_total/g, ""))], [true, false]);
		const delAudit = SRC.slice(SRC.indexOf('app.delete("/api/invoices/:id"'), SRC.indexOf('app.put("/api/invoices/:id/restore"'));
		check("the delete audit's total is invoiceTotalDue()", /invoiceTotalDue\(invoice\)/.test(delAudit), true);
		w.cleanup();
	}

	section("§16 the money review's Lows");
	{
		// L1: a regenerate whose base leaves out a reversed line's cents takes that
		// line's base with it, so the receipt marked again gets its share back.
		const w = world();
		await mark(w, 8);
		const g = await w.generate(OWNER_OP);
		approve(w, g.body.invoice.id);
		w.setNow(edt("2026-10-22", 12));
		const rv = await w.call("POST", "/api/expenses/8/personal/reverse", { body: {} });
		await w.call("DELETE", `/api/invoices/${g.body.invoice.id}`, { query: { reason: "redo" } });
		const g2 = await w.generate(OWNER_OP, "2026-10-16");
		const again = await mark(w, 8);
		const reversed = w.lines("kind = 'deduct' AND reversed_by_id IS NOT NULL")[0];
		check("L1 soft-delete and regenerate an approved owner-operator week after a reversal: the base still leaves the $100 out ($825)",
			[rv.status, g2.status, g2.body.invoice && g2.body.invoice.total_earnings], [201, 200, 825]);
		check("…the reversed line's base moves to the new invoice", reversed.base_invoice_id === (g2.body.invoice && g2.body.invoice.id), true);
		check("…and the receipt marked again carries the $25 share (not $0)", [again.status, w.lines("kind = 'deduct' AND voided_at = '' AND reversed_by_id IS NULL").map((r) => r.share_cents)], [201, [2500]]);
		w.cleanup();
	}
	{
		// L2: a line marked during the Friday render whose attach failed, the
		// invoice approved before the sweep: the correction refreshes its share.
		const w = world();
		let n = 0;
		w.hooks.render = async (t, d, def) => {
			n++;
			if (n === 1) await mark(w, 8);
			if (n === 2) throw new Error("render failed");
			return def(t, d);
		};
		const g = await w.generate(OWNER_OP);
		w.hooks.render = null;
		approve(w, g.body.invoice.id);
		w.setNow(SAT_0630);
		await w.api.runPersonalSweep();
		check("L2 setup: the line waits for the correction with a $0 share", [w.lines()[0].invoice_id, !!w.lines()[0].needs_correction_since, w.lines()[0].share_cents], [null, true, 0]);
		const c = await w.call("POST", "/api/invoices/personal-corrections", { body: { driver: OWNER_OP, weekStart: "2026-10-10" } });
		const inv = (c.body && c.body.invoice) || {};
		check("…the correction refreshes it: +$25 / -$100 = -$75", [c.status, inv.personal_share_total, inv.personal_total, inv.total_due, w.lines()[0].share_cents], [201, 25, 100, -75, 2500]);
		check("…and prints the share as a line item", (lastRender(w).data.lineItems || []).map((i) => i.amount), [25]);
		w.cleanup();
	}
	{
		// L2: the week's month finalized while the correction was being drawn.
		const w = world();
		await mark(w, 11);
		w.setNow(SAT_0630);
		await w.api.runPersonalSweep();
		w.hooks.render = async (t, d, def) => {
			w.db.prepare("INSERT OR IGNORE INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-10', 'locked', 't', 'test')").run();
			return def(t, d);
		};
		const c = await w.call("POST", "/api/invoices/personal-corrections", { body: { driver: DRIVER_B, weekStart: "2026-10-10" } });
		check("L2 October finalized during the correction's render: 409 PERIOD_FINALIZED, no invoice, the line still waits",
			[c.status, c.body && c.body.code, w.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE is_correction = 1").get().n, w.lines()[0].invoice_id, !!w.lines()[0].needs_correction_since],
			[409, "PERIOD_FINALIZED", 0, null, true]);
		w.cleanup();
	}
	{
		// L3: a line the sweep read as waiting but that was attached meanwhile is
		// not flagged.
		const w = world();
		const g = await w.generate(DRIVER_A);
		await mark(w, 1);
		w.db.prepare("UPDATE expense_personal SET invoice_id = NULL WHERE expense_id = 1").run();
		w.db.prepare("UPDATE invoices SET personal_total = 0 WHERE id = ?").run(g.body.invoice.id);
		await mark(w, 11);
		const other = w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, pdf_file_name, render_data, is_manual)
			VALUES ('INV-M-TEST-0001', 'test driver b', '2026-10-10', '2026-10-16', 1, 0, 0, 'Draft', 'INV-M-TEST-0001.pdf', '{}', 1)`).run().lastInsertRowid;
		w.hooks.render = async (t, d, def) => {
			w.db.prepare("UPDATE expense_personal SET invoice_id = ? WHERE expense_id = 11").run(other);
			return def(t, d);
		};
		w.setNow(SAT_0630);
		await w.api.runPersonalSweep();
		check("L3 the sweep attaches A's line, and B's line, attached meanwhile, is not flagged",
			[w.lines("expense_id = 1")[0].invoice_id === g.body.invoice.id, w.lines("expense_id = 11")[0].invoice_id === Number(other), w.lines("expense_id = 11")[0].needs_correction_since],
			[true, true, ""]);
		check("…and no flag is audited for it", w.audits("flag_personal_expense").filter((a) => String(a.entity_id) === "11").length, 0);
		w.cleanup();
	}
	{
		// L4: a Dispatcher's expense list carries no share or invoice number.
		const w = world();
		await mark(w, 1);
		const g = await w.generate(DRIVER_A);
		const disp = await w.call("GET", "/api/expenses/all", { as: "dispatcher" });
		const p = ((disp.body.expenses || []).find((e) => e.id === 1) || {}).personal || {};
		check("L4 Dispatcher: the state and the amount, no share, invoice or books",
			[p.state, p.amount_text, ["share_cents", "invoice_number", "invoice_id", "in_place", "cost_period", "can_undo"].filter((k) => k in p)],
			["invoiced", "$200.00", []]);
		const admin = await w.call("GET", "/api/expenses/all", { as: "admin" });
		const a = ((admin.body.expenses || []).find((e) => e.id === 1) || {}).personal || {};
		check("…Super Admin: the share, the invoice, the week and whether Undo still applies",
			[a.share_cents, a.invoice_number === g.body.invoice.invoice_number, a.week_label, a.amount_text, a.can_undo], [0, true, "Oct 10-16, 2026", "$200.00", true]);
		approve(w, g.body.invoice.id);
		const after = await w.call("GET", "/api/expenses/all", { as: "admin" });
		check("…once the invoice is approved, Undo no longer applies (Reverse)", (((after.body.expenses || []).find((e) => e.id === 1) || {}).personal || {}).can_undo, false);
		w.cleanup();
	}
	{
		// L5: an adjustment that takes lines off an invoice takes them off its
		// stored render data too, and puts them back if the PDF fails.
		const w = world();
		w.db.prepare("UPDATE drivers_directory SET pay_daily = 150 WHERE driver_name = ?").run(DRIVER_B);
		const add = w.db.prepare("INSERT INTO expenses (id, timestamp, driver, type, amount, date, status, vendor, truck_unit, owner_id, created_at, description) VALUES (?, 't', ?, 'Food', ?, ?, 'Approved', ?, 'T-3', 0, ?, '')");
		add.run(12, DRIVER_B, 200, "2026-10-13", "Diner #2", "2026-10-13 15:00:00");
		await mark(w, 12);
		const g = await w.generate(DRIVER_B);
		submit(w, g.body.invoice.id);
		const stored = () => JSON.parse(w.invoice(g.body.invoice.id).render_data);
		check("L5 setup: the stored render data lists the $200 line", (stored().personalLines || []).length, 1);
		w.hooks.render = async () => { throw new Error("render failed"); };
		const failed = await w.call("PUT", `/api/invoices/${g.body.invoice.id}/adjust`, { body: { adjustment: -150, adjustmentNote: "Advance" } });
		check("…the PDF fails: 409, the line and the stored render data both put back",
			[failed.status, w.lines("expense_id = 12")[0].invoice_id === g.body.invoice.id, (stored().personalLines || []).length, stored().personalTotal], [409, true, 1, 200]);
		w.hooks.render = null;
		const adj = await w.call("PUT", `/api/invoices/${g.body.invoice.id}/adjust`, { body: { adjustment: -150, adjustmentNote: "Advance" } });
		check("…the adjustment detaches the line: the stored render data no longer lists it",
			[adj.status, w.lines("expense_id = 12")[0].invoice_id, (stored().personalLines || []).length, stored().personalTotal || 0], [200, null, 0, 0]);
		w.cleanup();
	}

	section("§17 W2 the receipt's own week first: W40 Submitted, an Oct 7 receipt marked Thu Oct 15");
	{
		const w = world(WEEK_ON);
		addReceipt(w, { id: 20, date: "2026-10-07" });
		const g40 = await w.generate(DRIVER_A, "2026-10-09");
		const w40 = g40.body.invoice.id;
		submit(w, w40);
		const r = await mark(w, 20);
		check("201, on W40 at once", [r.status, r.body.personal && r.body.personal.state, r.body.personal && r.body.personal.invoice_number],
			[201, "invoiced", g40.body.invoice.invoice_number]);
		check("…keyed to W40", [deductOf(w, 20).week_start, deductOf(w, 20).invoice_id === w40], ["2026-10-03", true]);
		check("…W40: $600 - $45.50 = $554.50, still Submitted", [due(w, w40), w.invoice(w40).status], [554.5, "Submitted"]);
		check("…redrawn, the line printed with its receipt date", printed(w), ["Personal expense, EXAMPLE DINER #3, Oct 7, 2026: -$45.50"]);
		w.cleanup();
	}

	section("§18 W3 W41 Approved: the mark is carried, never a correction");
	{
		const w = world(WEEK_ON);
		const g = await w.generate(DRIVER_A);
		const w41 = g.body.invoice.id;
		approve(w, w41);
		const r = await mark(w, 1);
		check("201, and no invoice row is created", [r.status, w.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE is_correction = 1").get().n], [201, 0]);
		check("…the line on no invoice, carried, keyed to its own week",
			[deductOf(w, 1).invoice_id, !!deductOf(w, 1).needs_correction_since, deductOf(w, 1).week_start], [null, true, "2026-10-10"]);
		check("…the response says carried, and why", [r.body.personal && r.body.personal.state, r.body.personal && r.body.personal.wait_text],
			["carried", "the Oct 10-16, 2026 invoice is approved; it goes on the next weekly invoice"]);
		check("…W41 untouched (Approved, $900)", [w.invoice(w41).status, w.invoice(w41).personal_total, due(w, w41)], ["Approved", 0, 900]);
		w.setNow(edt("2026-10-22", 12));
		addW42Load(w, 1, "L7");
		const g42 = await w.generate(DRIVER_A, "2026-10-23");
		const w42 = g42.body.invoice && g42.body.invoice.id;
		check("W42's generation takes it: $600 - $200 = $400, no longer carried",
			[g42.status, deductOf(w, 1).invoice_id === w42, deductOf(w, 1).needs_correction_since, w42 && due(w, w42)], [200, true, "", 400]);
		check("…printed with its receipt date", printed(w), ["Personal expense, Pilot #123, Oct 12, 2026: -$200.00"]);
		w.cleanup();
	}

	section("§19 W4 W41 Approved, W42 Submitted, clock Thu Oct 22: R1 goes on W42");
	{
		const w = world(WEEK_ON);
		const g = await w.generate(DRIVER_A);
		approve(w, g.body.invoice.id);
		w.setNow(edt("2026-10-22", 12));
		addW42Load(w, 1, "L7");
		const g42 = await w.generate(DRIVER_A, "2026-10-23");
		const w42 = g42.body.invoice.id;
		submit(w, w42);
		const r = await mark(w, 1);
		check("201, on W42 at once: $600 - $200 = $400", [r.status, deductOf(w, 1).invoice_id === w42, due(w, w42)], [201, true, 400]);
		check("…keyed to its own week (2026-10-10), not the mark's (2026-10-17)", deductOf(w, 1).week_start, "2026-10-10");
		check("…printed with its receipt date", printed(w), ["Personal expense, Pilot #123, Oct 12, 2026: -$200.00"]);
		const d = summaryOf(w, 1, "Driver");
		check("the driver's summary: the line's week, and the week of the invoice that carries it",
			[d.state, d.invoice_number, d.week_label, d.invoice_week_label], ["invoiced", g42.body.invoice.invoice_number, "Oct 10-16, 2026", "Oct 17-23, 2026"]);
		check("W41 untouched", [w.invoice(g.body.invoice.id).personal_total, due(w, g.body.invoice.id)], [0, 900]);
		w.cleanup();
	}

	section("§20 W5 a line its week's invoice can't take goes on the next weekly invoice with room");
	{
		const w = world(WEEK_ON);
		w.db.prepare("UPDATE drivers_directory SET pay_daily = 150 WHERE driver_name = ?").run(DRIVER_B);
		addReceipt(w, { id: 12, driver: DRIVER_B, amount: 200, date: "2026-10-13", vendor: "EXAMPLE DINER #2", truck: "T-3", owner: 0 });
		addReceipt(w, { id: 13, driver: DRIVER_B, amount: 150, date: "2026-10-14", vendor: "EXAMPLE DINER #3", truck: "T-3", owner: 0 });
		await mark(w, 12);
		await mark(w, 13);
		const g = await w.generate(DRIVER_B);
		check("$300 of pay: W41 takes the $200 line (older), total $100", [deductOf(w, 12).invoice_id === g.body.invoice.id, due(w, g.body.invoice.id)], [true, 100]);
		const s = summaryOf(w, 13);
		check("…the $150 line is carried, and says why", [deductOf(w, 13).invoice_id, s.state, s.wait_text],
			[null, "carried", "more than the Oct 10-16, 2026 invoice can take; it goes on the next weekly invoice with room"]);
		w.setNow(edt("2026-10-22", 12));
		addW42Load(w, 5, "L8");
		const g42 = await w.generate(DRIVER_B, "2026-10-23");
		const w42 = g42.body.invoice && g42.body.invoice.id;
		check("W42 ($300) takes it: total $150", [deductOf(w, 13).invoice_id === w42, deductOf(w, 13).needs_correction_since, w42 && due(w, w42)], [true, "", 150]);
		check("…printed with its receipt date", printed(w), ["Personal expense, EXAMPLE DINER #3, Oct 14, 2026: -$150.00"]);
		w.cleanup();
	}
	{
		const w = world(WEEK_ON);
		w.db.prepare("UPDATE drivers_directory SET pay_daily = 150 WHERE driver_name = ?").run(DRIVER_B);
		addReceipt(w, { id: 12, driver: DRIVER_B, amount: 200, date: "2026-10-13", vendor: "EXAMPLE DINER #2", truck: "T-3", owner: 0 });
		await mark(w, 12);
		const g = await w.generate(DRIVER_B);
		submit(w, g.body.invoice.id);
		const adj = await w.call("PUT", `/api/invoices/${g.body.invoice.id}/adjust`, { body: { adjustment: -150, adjustmentNote: "Advance" } });
		const s = summaryOf(w, 12);
		check("a -$150 adjustment on W41 takes the $200 line off: carried, and says why", [adj.status, deductOf(w, 12).invoice_id, s.state, s.wait_text],
			[200, null, "carried", "more than the Oct 10-16, 2026 invoice can take; it goes on the next weekly invoice with room"]);
		w.setNow(edt("2026-10-22", 12));
		addW42Load(w, 5, "L8");
		const g42 = await w.generate(DRIVER_B, "2026-10-23");
		const w42 = g42.body.invoice && g42.body.invoice.id;
		check("…W42 ($300) takes it: total $100", [deductOf(w, 12).invoice_id === w42, w42 && due(w, w42)], [true, 100]);
		w.cleanup();
	}

	section("§21 W6 a receipt week touching closed September");
	{
		const w = world(WEEK_ON);
		// The Sep 26 - Oct 2 weekly invoice, open and with its render data: only
		// the closed month keeps a line off it.
		const w39 = Number(w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, pdf_file_name, render_data)
			VALUES ('INV-TDA-2026W39-01', 'test driver a', '2026-09-26', '2026-10-02', 2, 300, 600, 'Submitted', 'INV-TDA-2026W39-01.pdf', ?)`)
			.run(JSON.stringify({ __templateName: "service_invoice", totalEarnings: 600, totalDue: 600 })).lastInsertRowid);
		const r = await mark(w, 6);
		const s = summaryOf(w, 6);
		check("R6 (Sep 28): 201, keyed to its own week, carried, on no invoice", [r.status, deductOf(w, 6).week_start, deductOf(w, 6).invoice_id, s.state],
			[201, "2026-09-26", null, "carried"]);
		check("…and says why", s.wait_text, "the week of Sep 26 - Oct 2, 2026 touches closed September; it goes on the next weekly invoice");
		const g40 = await w.generate(DRIVER_A, "2026-10-09");
		const w40 = g40.body.invoice.id;
		check("W40's generation takes it: $600 - $80 = $520", [g40.status, deductOf(w, 6).invoice_id === w40, due(w, w40)], [200, true, 520]);
		addReceipt(w, { id: 23, type: "Fuel", date: "2026-09-22", vendor: "EXAMPLE FUEL #12" });
		const r23 = await mark(w, 23);
		check("a Sep 22 receipt skips the open Sep 26 - Oct 2 invoice and lands on W40: $520 - $45.50 = $474.50",
			[r23.status, deductOf(w, 23).invoice_id === w40, due(w, w40)], [201, true, 474.5]);
		check("…the Sep 26 - Oct 2 invoice untouched", [w.invoice(w39).personal_total, w.invoice(w39).status], [0, "Submitted"]);
		w.cleanup();
	}

	section("§22 W7 a receipt several weeks old, clock Thu Oct 29: W40 and W41 Approved, W42 Submitted");
	{
		const w = world(WEEK_ON);
		addReceipt(w, { id: 20, date: "2026-10-07" });
		const g40 = await w.generate(DRIVER_A, "2026-10-09");
		approve(w, g40.body.invoice.id);
		const g41 = await w.generate(DRIVER_A);
		approve(w, g41.body.invoice.id);
		addW42Load(w, 1, "L7");
		w.setNow(edt("2026-10-29", 12));
		const g42 = await w.generate(DRIVER_A, "2026-10-23");
		const w42 = g42.body.invoice.id;
		submit(w, w42);
		const r = await mark(w, 20);
		check("the Oct 7 receipt lands on W42 at once, keyed to W40: $600 - $45.50 = $554.50",
			[r.status, deductOf(w, 20).week_start, deductOf(w, 20).invoice_id === w42, due(w, w42)], [201, "2026-10-03", true, 554.5]);
		check("…printed with its receipt date", printed(w), ["Personal expense, EXAMPLE DINER #3, Oct 7, 2026: -$45.50"]);
		check("…W40 and W41 untouched", [due(w, g40.body.invoice.id), due(w, g41.body.invoice.id)], [600, 900]);
		w.cleanup();
	}

	section("§23 W8 the weekly sweep carries and attaches, and never asks for a correction");
	const sweepSummary = (w, weekStart) => (w.db.prepare("SELECT summary FROM personal_sweep_runs WHERE week_start = ?").get(weekStart) || {}).summary || "";
	const audited = (w, expenseId) => w.db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE entity = 'expense' AND entity_id = ?").get(String(expenseId)).n;
	{
		const w = world(WEEK_ON);
		await mark(w, 11);
		w.setNow(SAT_0630);
		await w.api.runPersonalSweep();
		check("W41 over with no invoice and no later one: B's line is carried, on no invoice",
			[deductOf(w, 11).invoice_id, !!deductOf(w, 11).needs_correction_since, summaryOf(w, 11).state], [null, true, "carried"]);
		check("…no notice to Super Admins", notices(w), 0);
		check("…the run's summary counts attached, carried, failed", /^\d+ attached · \d+ carried · \d+ failed$/.test(sweepSummary(w, "2026-10-10")), true);
		const before = audited(w, 11);
		w.setNow(SAT_0630 + 15 * 60 * 1000);
		await w.api.runPersonalSweep();
		check("…the next tick audits the carry no second time", audited(w, 11), before);
		w.cleanup();
	}
	{
		const w = world(WEEK_ON);
		await mark(w, 11);
		addW42Load(w, 5, "L8");
		const g42 = await w.generate(DRIVER_B, "2026-10-23");
		const w42 = g42.body.invoice.id;
		submit(w, w42);
		w.setNow(SAT_0630);
		await w.api.runPersonalSweep();
		check("B's W42 invoice open: the sweep carries the W41 line onto it, $500 - $30 = $470",
			[deductOf(w, 11).invoice_id === w42, deductOf(w, 11).needs_correction_since, due(w, w42)], [true, "", 470]);
		check("…redrawn with the line", printed(w), ["Personal expense, Diner #2, Oct 13, 2026: -$30.00"]);
		check("…no notice", notices(w), 0);
		w.cleanup();
	}
	// A W42 receipt of Driver B's, and his W42 invoice Submitted by the Friday
	// batch; B's W41 line still waits (W41 has no invoice).
	const raceWorld = async () => {
		const w = world(WEEK_ON);
		await mark(w, 11);
		addReceipt(w, { id: 12, driver: DRIVER_B, type: "Fuel", date: "2026-10-20", vendor: "EXAMPLE FUEL #12", truck: "T-3", owner: 0 });
		addW42Load(w, 5, "L8");
		w.setNow(edt("2026-10-23", 20));
		const g42 = await w.generate(DRIVER_B, "2026-10-23");
		submit(w, g42.body.invoice.id);
		w.setNow(edt("2026-10-24", 6, 30));
		const onW42 = () => w.lines("invoice_id = ?", g42.body.invoice.id).map((l) => l.expense_id).sort((a, b) => a - b);
		return { w, w42: g42.body.invoice.id, onW42 };
	};
	{
		const { w, w42, onW42 } = await raceWorld();
		let fired = false;
		let marked = null;
		w.hooks.render = async (t, d, def) => {
			if (!fired) { fired = true; marked = await mark(w, 12); }
			return def(t, d);
		};
		await w.api.runPersonalSweep();
		check("a mark made while the sweep redraws W42: 201, its line on W42 and not carried",
			[marked && marked.status, onW42().includes(12), deductOf(w, 12).needs_correction_since], [201, true, ""]);
		const ids = onW42();
		const linesCents = w.lines("invoice_id = ?", w42).reduce((s, l) => s + l.cents, 0);
		check("…no line doubled: each line once on W42, and its Personal column their sum",
			[ids.length === new Set(ids).size, Math.round((w.invoice(w42).personal_total || 0) * 100) === linesCents], [true, true]);
		w.hooks.render = null;
		w.setNow(edt("2026-10-24", 6, 45));
		await w.api.runPersonalSweep();
		check("…the next tick: both lines on W42 once, $500 - $45.50 - $30 = $424.50", [onW42(), due(w, w42)], [[11, 12], 424.5]);
		w.cleanup();
	}
	{
		const { w, w42, onW42 } = await raceWorld();
		let fired = false;
		let swept = null;
		w.hooks.render = async (t, d, def) => {
			if (!fired) { fired = true; swept = await w.api.runPersonalSweep(); }
			return def(t, d);
		};
		const r = await mark(w, 12);
		check("a sweep run while a mark redraws W42: the sweep's line lands; the mark answers 409 PERSONAL_CHANGED and writes nothing",
			[!!swept, onW42(), r.status, r.body && r.body.code, w.lines("expense_id = 12").length], [true, [11], 409, "PERSONAL_CHANGED", 0]);
		w.hooks.render = null;
		const again = await mark(w, 12);
		check("…marked again: 201, both lines on W42 once, $424.50", [again.status, onW42(), due(w, w42)], [201, [11, 12], 424.5]);
		w.cleanup();
	}
	{
		// Pin: as L3, with a generation: B's W41 invoice, generated while the sweep
		// awaits A's render, takes B's line; the sweep never carries it.
		const w = world(WEEK_ON);
		const g = await w.generate(DRIVER_A);
		await mark(w, 1);
		w.db.prepare("UPDATE expense_personal SET invoice_id = NULL WHERE expense_id = 1").run();
		w.db.prepare("UPDATE invoices SET personal_total = 0 WHERE id = ?").run(g.body.invoice.id);
		await mark(w, 11);
		let fired = false;
		let gb = null;
		w.hooks.render = async (t, d, def) => {
			if (!fired) { fired = true; gb = await w.generate(DRIVER_B); }
			return def(t, d);
		};
		w.setNow(SAT_0630);
		await w.api.runPersonalSweep();
		const wb = gb && gb.body && gb.body.invoice ? gb.body.invoice.id : null;
		check("pin: a line a generation took during the sweep's render is never carried",
			[wb !== null, deductOf(w, 11).invoice_id === wb, deductOf(w, 11).needs_correction_since, notices(w)], [true, true, "", 0]);
		w.cleanup();
	}

	section("§24 W9 a line flagged before the switch (week of Oct 10, no invoice) goes on W42");
	const flaggedBefore = (w) => w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, needs_correction_since, created_at, created_by, created_by_id, created_role)
		VALUES (11, 'deduct', 3000, 3000, 'Diner #2', '2026-10-13', '2026-10', 1, '2026-10-13', '2026-10-10', '2026-10-17T10:30:00.000Z', 't', 'super_admin', 1, 'Super Admin')`).run();
	{
		const w = world(WEEK_ON);
		flaggedBefore(w);
		addW42Load(w, 5, "L8");
		w.setNow(edt("2026-10-23", 20));
		const g42 = await w.generate(DRIVER_B, "2026-10-23");
		const w42 = g42.body.invoice.id;
		check("W42's generation takes it: $500 - $30 = $470, no longer flagged", [deductOf(w, 11).invoice_id === w42, deductOf(w, 11).needs_correction_since, due(w, w42)], [true, "", 470]);
		w.cleanup();
	}
	{
		const w = world(WEEK_ON);
		addW42Load(w, 5, "L8");
		w.setNow(edt("2026-10-23", 20));
		const g42 = await w.generate(DRIVER_B, "2026-10-23");
		const w42 = g42.body.invoice.id;
		submit(w, w42);
		flaggedBefore(w);
		w.setNow(edt("2026-10-26", 10));
		await w.api.runPersonalSweep();
		check("W42 already Submitted: the first sweep tick puts it on W42 ($470), no notice", [deductOf(w, 11).invoice_id === w42, due(w, w42), notices(w)], [true, 470, 0]);
		w.cleanup();
	}

	section("§25 pin: an owner-operator's line carried off his approved week keeps its share");
	{
		const w = world(WEEK_ON);
		const g = await w.generate(OWNER_OP);
		approve(w, g.body.invoice.id);
		await mark(w, 8);
		check("the line carries the $25 share W41 counted", deductOf(w, 8).share_cents, 2500);
		w.setNow(edt("2026-10-22", 12));
		addW42Load(w, 2, "L9");
		await w.generate(OWNER_OP, "2026-10-23");
		const carrier = w.invoice(deductOf(w, 8).invoice_id) || {};
		check("…the invoice that carries it: +$25.00 share returned, -$100.00 Personal", [carrier.personal_share_total, carrier.personal_total], [25, 100]);
		w.cleanup();
	}

	section("§26 W14 Reverse of a waiting line whose month closed: neither row goes on an invoice");
	{
		const w = world(WEEK_ON, { nowMs: edt("2026-10-05", 12) });
		w.db.prepare("DELETE FROM period_locks WHERE period = '2026-09'").run();
		await mark(w, 6);
		w.db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-09', 'locked', '2026-10-08T04:00:00.000Z', 'test')").run();
		w.setNow(edt("2026-10-15", 12));
		const s = summaryOf(w, 6);
		check("R6, in place in September and on no invoice when September closed: no Undo, Reverse offered",
			[deductOf(w, 6).invoice_id, deductOf(w, 6).in_place, s.can_undo, s.can_reverse], [null, 1, false, true]);
		const u = await w.call("DELETE", "/api/expenses/6/personal", { body: {} });
		check("…Undo: 409 PERIOD_FINALIZED, use Reverse", [u.status, u.body && u.body.code, /Use Reverse/.test((u.body && u.body.error) || "")], [409, "PERIOD_FINALIZED", true]);
		const rv = await w.call("POST", "/api/expenses/6/personal/reverse", { body: { reason: "not personal after all" } });
		const rev = w.lines("kind = 'reverse'")[0] || {};
		check("…Reverse: 201, a +$80 credit booked in October (the books net out across the two months), on no invoice",
			[rv.status, rev.cents, rev.in_place, rev.cost_period, rev.invoice_id], [201, 8000, 0, "2026-10", null]);
		const g40 = await w.generate(DRIVER_A, "2026-10-09");
		const g41 = await w.generate(DRIVER_A);
		w.setNow(edt("2026-10-17", 6, 30));
		await w.api.runPersonalSweep();
		check("…neither row ever goes on an invoice: W40 and W41 generated, the sweep run, no notice",
			[w.invoice(g40.body.invoice.id).personal_total, w.invoice(g41.body.invoice.id).personal_total, deductOf(w, 6).invoice_id, (w.lines("kind = 'reverse'")[0] || {}).invoice_id, notices(w)],
			[0, 0, null, null, 0]);
		w.cleanup();
	}

	section("§27 W16 a generation of a week touching a closed month takes no new line");
	{
		const w = world(WEEK_ON, { nowMs: edt("2026-10-01", 12) });
		w.db.prepare("DELETE FROM period_locks WHERE period = '2026-09'").run();
		// Driver A's load in the week of Sep 26 - Oct 2 (2 days, $600).
		w.sheet.rows.push(w.sheet.rows[1].map((v, i) => ({ 1: "L10", 6: "9/28/2026 8:00", 9: "9/29/2026 10:00", 20: "9/28/2026", 21: "9/29/2026", 22: "9/29/2026" })[i] ?? v));
		const first = await w.generate(DRIVER_A, "2026-10-02");
		await mark(w, 6);
		check("setup: R6 (Sep 28) on the W39 Draft while September is open", [first.status, deductOf(w, 6).invoice_id === (first.body.invoice && first.body.invoice.id)], [200, true]);
		// A line of the week its Draft never took (an attach that failed).
		addReceipt(w, { id: 24, type: "Fuel", date: "2026-09-30", vendor: "EXAMPLE FUEL #12" });
		w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
			VALUES (24, 'deduct', 4550, 4550, 'EXAMPLE FUEL #12', '2026-09-30', '2026-09', 1, '2026-09-30', '2026-09-26', 't', 'super_admin', 1, 'Super Admin')`).run();
		w.db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-09', 'locked', '2026-10-08T04:00:00.000Z', 'test')").run();
		w.setNow(edt("2026-10-15", 12));
		const again = await w.generate(DRIVER_A, "2026-10-02");
		const id = again.body.invoice ? again.body.invoice.id : null;
		check("September closed, W39 regenerated: R6 stays on the new Draft ($600 - $80 = $520), the waiting line is not taken",
			[again.status, deductOf(w, 6).invoice_id === id, deductOf(w, 24).invoice_id, id && due(w, id)], [200, true, null, 520]);
		w.cleanup();
	}

	// O2 ($100) marked before W41 exists: W41's base leaves it out (pay $825) and
	// carries it; a -$800 adjustment takes it off again, its base still on W41.
	const baseElsewhere = async () => {
		const w = world(WEEK_ON);
		await mark(w, 8);
		const g = await w.generate(OWNER_OP);
		const w41 = g.body.invoice.id;
		const adj = await w.call("PUT", `/api/invoices/${w41}/adjust`, { body: { adjustment: -800, adjustmentNote: "Advance" } });
		return { w, w41, setup: [w.invoice(w41).total_earnings, adj.status, deductOf(w, 8).invoice_id, deductOf(w, 8).base_invoice_id === w41] };
	};

	section("§28 W19 Reverse of an owner-operator's line whose base is on another invoice: the share comes back");
	{
		const { w, w41, setup } = await baseElsewhere();
		check("setup: W41 paid $825 with the $100 left out of its base; the line taken off it, its base still there", setup, [825, 200, null, true]);
		const s = summaryOf(w, 8);
		const u = await w.call("DELETE", "/api/expenses/8/personal", { body: {} });
		check("…Undo 409 PERSONAL_BASE_ELSEWHERE; Reverse offered", [u.status, u.body && u.body.code, s.can_undo, s.can_reverse], [409, "PERSONAL_BASE_ELSEWHERE", false, true]);
		const rv = await w.call("POST", "/api/expenses/8/personal/reverse", { body: { reason: "not personal after all" } });
		const rev = w.lines("kind = 'reverse'")[0] || {};
		check("Reverse: 201; the reversal (+$100, the $25 share taken back) waits on no invoice for its line; W41 stays $25",
			[rv.status, rev.cents, rev.share_cents, rev.invoice_id, due(w, w41)], [201, 10000, 2500, null, 25]);
		w.setNow(edt("2026-10-22", 12));
		addW42Load(w, 2, "L9");
		const g42 = await w.generate(OWNER_OP, "2026-10-23");
		const w42 = g42.body.invoice.id;
		w.setNow(edt("2026-10-24", 6, 30));
		await w.api.runPersonalSweep();
		check("…the line goes on W42 and its reversal follows it there ($625 - $100 + $75): W41 and W42 come to what no mark gives ($0 + $625)",
			[deductOf(w, 8).invoice_id === w42, (w.lines("kind = 'reverse'")[0] || {}).invoice_id === w42, due(w, w42), due(w, w41) + due(w, w42)], [true, true, 600, 625]);
		w.cleanup();
	}
	{
		const { w } = await baseElsewhere();
		w.db.prepare("UPDATE expenses SET driver = '' WHERE id = 8").run();
		const s = summaryOf(w, 8);
		const rv = await w.call("POST", "/api/expenses/8/personal/reverse", { body: {} });
		check("the same with a receipt that names no driver: no invoice could carry the reversal, so no Reverse (409, nothing written)",
			[s.can_reverse, rv.status, rv.body && rv.body.code, w.lines("kind = 'reverse'").length, deductOf(w, 8).reversed_by_id], [false, 409, "PERSONAL_REVERSE_UNPLACEABLE", 0, null]);
		w.cleanup();
	}

	section("§29 W20 a reversed charge whose credit is on an invoice is collected");
	{
		// What the flag-off Reverse leaves behind for §28's line: the reversal on
		// W41, still open, the charge waiting for the week's correction.
		const { w, w41 } = await baseElsewhere();
		const charge = deductOf(w, 8);
		const rev = Number(w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, reverses_id, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, invoice_id, share_cents, created_at, created_by, created_by_id, created_role)
			VALUES (8, 'reverse', ?, 10000, 10000, 'Shell #9', '2026-10-13', '2026-10', 1, '2026-10-13', '2026-10-10', ?, 2500, 't', 'super_admin', 1, 'Super Admin')`).run(charge.id, w41).lastInsertRowid);
		w.db.prepare("UPDATE expense_personal SET reversed_by_id = ? WHERE id = ?").run(rev, charge.id);
		w.db.prepare("UPDATE invoices SET personal_total = -100, personal_share_total = -25 WHERE id = ?").run(w41);
		w.setNow(edt("2026-10-22", 12));
		addW42Load(w, 2, "L9");
		const g42 = await w.generate(OWNER_OP, "2026-10-23");
		const w42 = g42.body.invoice.id;
		check("after the switch, W42's generation takes the reversed charge ($625 - $100): with W41's credit, what no mark gives ($625)",
			[deductOf(w, 8).invoice_id === w42, due(w, w41) + due(w, w42)], [true, 625]);
		w.cleanup();
	}
	{
		// A reversed line's invoice deleted after its credit landed on another.
		const w = world(WEEK_ON);
		const g = await w.generate(DRIVER_A);
		await mark(w, 1);
		w.setNow(edt("2026-10-22", 12));
		addW42Load(w, 1, "L7");
		const g42 = await w.generate(DRIVER_A, "2026-10-23");
		const w42 = g42.body.invoice.id;
		const charge = deductOf(w, 1);
		const rev = Number(w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, reverses_id, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, invoice_id, share_cents, created_at, created_by, created_by_id, created_role)
			VALUES (1, 'reverse', ?, 20000, 20000, 'Pilot #123', '2026-10-12', '2026-10', 1, '2026-10-12', '2026-10-17', ?, 0, 't', 'super_admin', 1, 'Super Admin')`).run(charge.id, w42).lastInsertRowid);
		w.db.prepare("UPDATE expense_personal SET reversed_by_id = ? WHERE id = ?").run(rev, charge.id);
		w.db.prepare("UPDATE invoices SET personal_total = -200 WHERE id = ?").run(w42);
		await w.call("DELETE", `/api/invoices/${g.body.invoice.id}`, { query: { reason: "redo" } });
		const again = await w.generate(DRIVER_A);
		const id = again.body.invoice ? again.body.invoice.id : null;
		check("W41 deleted and generated again takes the reversed charge back ($900 - $200): with W42's credit, what no mark gives ($1,500)",
			[deductOf(w, 1).invoice_id === id, id && due(w, id), id && due(w, id) + due(w, w42)], [true, 700, 1500]);
		w.cleanup();
	}

	section("§30 W21 a later invoice never takes a line its own week can take again");
	{
		const w = world(WEEK_ON);
		w.db.prepare("UPDATE drivers_directory SET pay_daily = 150 WHERE driver_name = ?").run(DRIVER_B);
		addReceipt(w, { id: 12, driver: DRIVER_B, amount: 200, date: "2026-10-13", vendor: "EXAMPLE DINER #2", truck: "T-3", owner: 0 });
		addReceipt(w, { id: 13, driver: DRIVER_B, amount: 150, date: "2026-10-14", vendor: "EXAMPLE DINER #3", truck: "T-3", owner: 0 });
		const g = await w.generate(DRIVER_B);
		const w41 = g.body.invoice.id;
		await mark(w, 12);
		addW42Load(w, 5, "L8");
		const g42 = await w.generate(DRIVER_B, "2026-10-23");
		const w42 = g42.body.invoice.id;
		submit(w, w42);
		check("setup: W41 ($300) carries the $200 line, $100 left; W42 ($300) open", [deductOf(w, 12).invoice_id === w41, due(w, w41), due(w, w42)], [true, 100, 300]);
		let fired = false;
		let undone = null;
		w.hooks.render = async (t, d, def) => {
			if (!fired) { fired = true; undone = await w.call("DELETE", "/api/expenses/12/personal", { body: {} }); }
			return def(t, d);
		};
		const r = await mark(w, 13);
		check("the $150 line, carried to W42, while W41's line is undone during W42's render: 409 PERSONAL_CHANGED, nothing written",
			[undone && undone.status, r.status, r.body && r.body.code, w.lines("expense_id = 13").length, w.invoice(w42).personal_total], [200, 409, "PERSONAL_CHANGED", 0, 0]);
		w.hooks.render = null;
		const again = await mark(w, 13);
		check("…marked again, it goes on W41, which has room now ($300 - $150)", [again.status, deductOf(w, 13).invoice_id === w41, due(w, w41)], [201, true, 150]);
		w.cleanup();
	}

	section("§31 W22 delete and regenerate keeps the week's lines on the regenerated invoice");
	// B's line on his Submitted W41; his W42 Submitted by the Friday batch; W41
	// deleted on Saturday to be regenerated.
	const deletedWeek = async () => {
		const w = world(WEEK_ON);
		await mark(w, 11);
		const g = await w.generate(DRIVER_B);
		submit(w, g.body.invoice.id);
		addW42Load(w, 5, "L8");
		w.setNow(edt("2026-10-23", 20));
		const g42 = await w.generate(DRIVER_B, "2026-10-23");
		submit(w, g42.body.invoice.id);
		w.setNow(edt("2026-10-24", 10));
		const del = await w.call("DELETE", `/api/invoices/${g.body.invoice.id}`, { query: { reason: "regenerate" } });
		return { w, w41: g.body.invoice.id, w42: g42.body.invoice.id, deleted: del.status };
	};
	{
		const { w, w41, w42, deleted } = await deletedWeek();
		w.setNow(edt("2026-10-24", 10, 15));
		await w.api.runPersonalSweep();
		check("the sweep after the delete leaves W41's line where it was, not carried; W42 untouched ($500)",
			[deleted, deductOf(w, 11).invoice_id === w41, deductOf(w, 11).needs_correction_since, due(w, w42)], [200, true, "", 500]);
		const again = await w.generate(DRIVER_B);
		const id = again.body.invoice ? again.body.invoice.id : null;
		check("…W41 generated again takes it back ($500 - $30)", [again.status, deductOf(w, 11).invoice_id === id, id && due(w, id)], [200, true, 470]);
		w.cleanup();
	}
	{
		const { w, w42 } = await deletedWeek();
		w.setNow(edt("2026-10-31", 6, 30));
		await w.api.runPersonalSweep();
		check("not generated again by the next Saturday's sweep: the line is carried onto W42 ($500 - $30)", [deductOf(w, 11).invoice_id === w42, due(w, w42)], [true, 470]);
		w.cleanup();
	}

	section("§32 W23 the words: the adjustment's audit row, a carried line's wait");
	{
		const w = world(WEEK_ON);
		w.db.prepare("UPDATE drivers_directory SET pay_daily = 150 WHERE driver_name = ?").run(DRIVER_B);
		addReceipt(w, { id: 12, driver: DRIVER_B, amount: 200, date: "2026-10-13", vendor: "EXAMPLE DINER #2", truck: "T-3", owner: 0 });
		await mark(w, 12);
		const g = await w.generate(DRIVER_B);
		const w41 = g.body.invoice.id;
		submit(w, w41);
		await w.call("PUT", `/api/invoices/${w41}/adjust`, { body: { adjustment: -150, adjustmentNote: "Advance" } });
		const audit = (w.audits("detach_personal_expense")[0] || {}).details || "";
		check("the adjustment's detach audit row: the line goes on the next weekly invoice", /leaves too little to cover it; goes on the next weekly invoice$/.test(audit), true);
		await w.call("PUT", `/api/invoices/${w41}/adjust`, { body: { adjustment: 0, adjustmentNote: "" } });
		check("the adjustment undone, the carried line says it goes back on W41 at the next sweep",
			summaryOf(w, 12).wait_text, "the Oct 10-16, 2026 invoice has room for it again; it goes back on it at the next sweep");
		w.cleanup();
	}
	{
		const w = world(WEEK_ON);
		w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, pdf_file_name, render_data)
			VALUES ('INV-TDA-2026W41-01', 'test driver a', '2026-10-10', '2026-10-16', 3, 300, 900, 'Submitted', 'INV-TDA-2026W41-01.pdf', '{}')`).run();
		await mark(w, 1);
		check("a line whose week's invoice has no stored render data, in plain words",
			summaryOf(w, 1).wait_text, "the Oct 10-16, 2026 invoice can't be redrawn; it goes on the next weekly invoice");
		w.cleanup();
	}

	// An owner-operator's load in a week, copied from his own row, with its own pay.
	const addOwnerLoad = (w, loadId, pickup, dropoff, pay) => w.sheet.rows.push(w.sheet.rows[2].map((v, i) =>
		({ 1: loadId, 6: `${pickup} 8:00`, 9: `${dropoff} 10:00`, 14: pay, 20: pickup, 21: dropoff, 22: dropoff })[i] ?? v));

	section("§33 W24 Reverse of a line on no invoice with its own unreturned share and no base: neither row goes on one");
	{
		const w = world(WEEK_ON, { nowMs: edt("2026-09-30", 12) });
		w.db.prepare("DELETE FROM period_locks WHERE period = '2026-09'").run();
		addReceipt(w, { id: 25, driver: OWNER_OP, type: "Fuel", amount: 100, date: "2026-09-28", vendor: "EXAMPLE FUEL #12", truck: "T-2", owner: 7 });
		// His Sep 26 - Oct 2 invoice, approved, counted the receipt in his percentage base.
		w.db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, status, pdf_file_name, render_data, expense_ids)
			VALUES ('INV-TOO-2026W39-01', 'test owner op', '2026-09-26', '2026-10-02', 1, 25, 800, 'Approved', 'INV-TOO-2026W39-01.pdf', ?, '[25]')`)
			.run(JSON.stringify({ __templateName: "service_invoice_owner_op", totalEarnings: 800 }));
		await mark(w, 25);
		w.db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-09', 'locked', '2026-10-08T04:00:00.000Z', 'test')").run();
		w.setNow(edt("2026-10-15", 12));
		const line = deductOf(w, 25);
		check("setup: the $100 line carries its $25 share, never returned (on no invoice), no base elsewhere; September closed",
			[line.share_cents, line.invoice_id, line.base_invoice_id, line.in_place, line.cost_period], [2500, null, null, 1, "2026-09"]);
		const u = await w.call("DELETE", "/api/expenses/25/personal", { body: {} });
		const rv = await w.call("POST", "/api/expenses/25/personal/reverse", { body: { reason: "not personal after all" } });
		check("Undo 409 PERIOD_FINALIZED; Reverse 201, on no invoice", [u.status, u.body && u.body.code, rv.status, (w.lines("kind = 'reverse'")[0] || {}).invoice_id], [409, "PERIOD_FINALIZED", 201, null]);
		const g40 = await w.generate(OWNER_OP, "2026-10-09");
		const g41 = await w.generate(OWNER_OP);
		w.setNow(edt("2026-10-17", 6, 30));
		await w.api.runPersonalSweep();
		check("…neither row ever goes on an invoice (W40, W41 and the sweep take neither): nothing owed either way",
			[w.lines("expense_id = 25").map((l) => l.invoice_id), w.invoice(g40.body.invoice.id).personal_total, w.invoice(g41.body.invoice.id).personal_total, notices(w)],
			[[null, null], 0, 0, 0]);
		w.cleanup();
	}

	section("§34 W25 Reverse of a line whose base is elsewhere, too big for the next invoice: the credit waits for its line");
	{
		const { w, w41 } = await baseElsewhere();
		const rv = await w.call("POST", "/api/expenses/8/personal/reverse", { body: { reason: "not personal after all" } });
		w.setNow(edt("2026-10-22", 12));
		addOwnerLoad(w, "L9", "10/19/2026", "10/20/2026", "$200.00");
		const g42 = await w.generate(OWNER_OP, "2026-10-23");
		const w42 = g42.body.invoice.id;
		w.setNow(edt("2026-10-24", 6, 30));
		await w.api.runPersonalSweep();
		const rev = () => w.lines("kind = 'reverse'")[0] || {};
		check("Reverse 201; W42 ($50) has no room for the $100 line, so it waits, and its credit waits with it: W41 $25, W42 $50",
			[rv.status, deductOf(w, 8).invoice_id, rev().invoice_id, due(w, w41), due(w, w42)], [201, null, null, 25, 50]);
		const s = summaryOf(w, 8);
		check("…its pill says the line still goes on an invoice, its credit with it",
			[s.state, s.wait_text], ["reversed", "the line still goes on the next weekly invoice, and its credit with it"]);
		addOwnerLoad(w, "L11", "10/26/2026", "10/27/2026", "$2,500.00");
		w.setNow(edt("2026-10-30", 20));
		const g43 = await w.generate(OWNER_OP, "2026-10-30");
		const w43 = g43.body.invoice.id;
		check("W43 ($625) takes the line and the credit follows it there ($625 - $100 + $75): the three weeks come to what no mark gives ($0 + $50 + $625)",
			[deductOf(w, 8).invoice_id === w43, rev().invoice_id === w43, due(w, w43), due(w, w41) + due(w, w42) + due(w, w43)], [true, true, 600, 675]);
		w.cleanup();
	}

	section("§35 W26 a carried line put on a Draft while it is regenerated goes on the new invoice at once");
	{
		const w = world(WEEK_ON);
		await mark(w, 11);
		addW42Load(w, 5, "L8");
		w.setNow(edt("2026-10-23", 20));
		await w.generate(DRIVER_B, "2026-10-23");
		w.setNow(edt("2026-10-24", 6, 30));
		// The sweep runs during the regenerate's render: it carries B's W41 line onto
		// the old W42 Draft, which the regenerate then replaces.
		let fired = false;
		w.hooks.render = async (t, d, def) => {
			if (!fired) { fired = true; await w.api.runPersonalSweep(); }
			return def(t, d);
		};
		const again = await w.generate(DRIVER_B, "2026-10-23");
		const id = again.body.invoice ? again.body.invoice.id : null;
		check("the regenerated W42 takes the line right after its write ($500 - $30)", [again.status, deductOf(w, 11).invoice_id === id, id && due(w, id)], [200, true, 470]);
		w.cleanup();
	}

	section("§36 W28 a later shrink never splits a reversed pair");
	// §28's pair, together on W42 ($625 - $100 + $75 = $600).
	const pairOnW42 = async () => {
		const { w, w41 } = await baseElsewhere();
		await w.call("POST", "/api/expenses/8/personal/reverse", { body: { reason: "not personal after all" } });
		w.setNow(edt("2026-10-22", 12));
		addOwnerLoad(w, "L9", "10/19/2026", "10/20/2026", "$2,500.00");
		const g42 = await w.generate(OWNER_OP, "2026-10-23");
		return { w, w41, w42: g42.body.invoice.id };
	};
	const pairOn = (w) => [deductOf(w, 8).invoice_id, (w.lines("kind = 'reverse'")[0] || {}).invoice_id];
	{
		const { w, w42 } = await pairOnW42();
		const adj = await w.call("PUT", `/api/invoices/${w42}/adjust`, { body: { adjustment: -600, adjustmentNote: "Advance" } });
		check("a -$600 adjustment on W42: the line and its credit (net -$25) still fit together, so both stay: due $0",
			[adj.status, pairOn(w), due(w, w42)], [200, [w42, w42], 0]);
		w.cleanup();
	}
	{
		const { w, w41, w42 } = await pairOnW42();
		await w.call("PUT", `/api/invoices/${w42}/adjust`, { body: { adjustment: -620, adjustmentNote: "Advance" } });
		check("a -$620 adjustment: the pair no longer fits, so both come off together: due $5", [pairOn(w), due(w, w42)], [[null, null], 5]);
		addOwnerLoad(w, "L11", "10/26/2026", "10/27/2026", "$2,500.00");
		w.setNow(edt("2026-10-30", 20));
		const g43 = await w.generate(OWNER_OP, "2026-10-30");
		const w43 = g43.body.invoice.id;
		check("…and land together on W43 ($625 - $100 + $75): the three weeks come to what no mark gives ($0 + $5 + $625)",
			[pairOn(w), due(w, w43), due(w, w41) + due(w, w42) + due(w, w43)], [[w43, w43], 600, 630]);
		w.cleanup();
	}
	{
		const { w } = await pairOnW42();
		const row = w.sheet.rows.find((r) => r[1] === "L9");
		row[14] = "$200.00";
		const again = await w.generate(OWNER_OP, "2026-10-23");
		const id = again.body.invoice ? again.body.invoice.id : null;
		check("W42 regenerated at $50 of pay: the pair (net -$25) stays together on it: due $25", [again.status, pairOn(w), id && due(w, id)], [200, [id, id], 25]);
		w.cleanup();
	}

	finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
