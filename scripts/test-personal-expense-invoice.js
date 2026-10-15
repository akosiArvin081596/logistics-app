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
		check("total_earnings + adjustment + share returned - repayments", w.api.invoiceTotalDue({ total_earnings: 800, adjustment: -10, personal_total: 100, personal_share_total: 25 }), 715);
		await mark(w, 1);
		const g = await w.generate(DRIVER_A);
		submit(w, g.body.invoice.id);
		const report = w.api.buildPaymentReport(DRIVER_A, "2026-10-10", "2026-10-16");
		check("the payment report serves both columns and the total due", report.invoices.map((r) => [r.personal_total, r.personal_share_total, r.total_due]), [[200, 0, 700]]);
		const driverList = SRC.slice(SRC.indexOf("const driverInvoices = db.prepare("), SRC.indexOf("const driverInvoices = db.prepare(") + 900);
		check("the driver app list selects both columns", [/personal_total/.test(driverList), /personal_share_total/.test(driverList)], [true, true]);
		const fin = SRC.slice(SRC.indexOf("const invByDriver = Object.create(null);"), SRC.indexOf("const invByDriver = Object.create(null);") + 1200);
		check("Financials \"invoiced\" adds the share returned and never subtracts repayments", [/personal_share_total/.test(fin), /personal_total\b(?!_)/.test(fin.replace(/personal_share_total/g, ""))], [true, false]);
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

	finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
