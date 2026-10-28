#!/usr/bin/env node
/**
 * "Personal" receipts, phase 2: each Personal line's receipt on the invoice, in
 * the app and through its route. Lifted from server.js on the world in
 * scripts/lib/personal-world.js (made-up data; clock Thu 2026-10-15 12:00 ET;
 * week W41 = Sat 10-10 .. Fri 10-16). The receipt images are generated here.
 *
 *   §1 the invoice render: a line whose receipt is an image says "Receipt 1 of
 *      N, attached after this invoice" and links its page; the page carries the
 *      re-encoded JPEG; "PDF receipt on file"; "Receipt image not available";
 *      the correction's lines and an adjustment's re-render the same; none of it
 *      is stored in render_data; the re-encode is cached outside uploads/
 *   §2 GET /api/invoices lists each invoice's personal_lines with their receipt
 *      (image route URL, pdf, none; a share line has none); a driver sees only
 *      his own; the driver app's list carries them too
 *   §3 GET /api/invoices/:id/personal-receipts/:lineId: Super Admin any line, a
 *      driver only his own live invoice's lines, nobody else; the sanitized JPEG
 *      with nosniff and no-store; a PDF receipt, a missing file, a line on
 *      another invoice or an undone one: 404
 *   §4 GET /api/expenses/personal/waiting-corrections: the weeks waiting for a
 *      correction invoice, Super Admin only
 *   §5 the month close lists the Personal lines booked to the month that no
 *      invoice carries yet; the automatic close audits them like the manual one
 *   §6 the payment report PDF prints its "Personal" column only when an invoice
 *      in it carries Personal lines
 *   §7 the Friday batch re-encodes and caches the week's receipt images before
 *      it renders any invoice (a cold cache never leaves "not available")
 *   §8 W12 with PERSONAL_RECEIPT_WEEK_ENABLED on: the week's warm-up also
 *      prepares the receipt of a line carried from an earlier week, which that
 *      week's generation takes
 *
 * Pure apart from the re-encode's child process: no server, no app.db, no network.
 * Run: node scripts/test-personal-expense-receipts.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const fs = require("fs");
const path = require("path");
const { buildPersonalWorld, makeChecker, edt, DRIVER_A, DRIVER_B, OWNER_OP, ROOT, SRC } = require("./lib/personal-world");
const { check, section, finish } = makeChecker();
const { Jimp } = require(path.join(ROOT, "node_modules", "jimp"));
const imageLimits = require(path.join(ROOT, "lib", "image-size.js"));

const ON = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" };
const world = (env = ON, opts = {}) => buildPersonalWorld({ env, receipts: true, ...opts });
const mark = (w, id, body = {}, as = "admin") => w.call("POST", `/api/expenses/${id}/personal`, { as, body });
const approve = (w, id) => w.db.prepare("UPDATE invoices SET status = 'Approved', approved_at = 't', approved_by = 'super_admin' WHERE id = ?").run(id);
const lastRender = (w) => w.rendered[w.rendered.length - 1] || null;
const SAT_0630 = edt("2026-10-17", 6, 30);

const receiptFile = (w, id, ext = "jpg") => path.join(w.dataDir, "uploads", "expense-receipts", `${1760000000000 + id}-abcdefabcdef.${ext}`);
let JPEG = null;
async function putImage(w, id) {
	if (!JPEG) JPEG = await new Jimp({ width: 300, height: 450, color: 0x2a5599ff }).getBuffer("image/jpeg", { quality: 80 });
	fs.mkdirSync(path.dirname(receiptFile(w, id)), { recursive: true });
	fs.writeFileSync(receiptFile(w, id), JPEG);
}
function putPdf(w, id) {
	fs.mkdirSync(path.dirname(receiptFile(w, id, "pdf")), { recursive: true });
	fs.writeFileSync(receiptFile(w, id, "pdf"), "%PDF-1.4\n%%EOF\n");
	w.db.prepare("UPDATE expenses SET photo_data = ? WHERE id = ?").run(`/uploads/expense-receipts/${1760000000000 + id}-abcdefabcdef.pdf`, id);
}
const rowFor = (list, id) => (list || []).find((r) => r.id === id) || {};

(async () => {
	section("§1 the invoice render");
	{
		const w = world();
		await putImage(w, 1);
		await mark(w, 1);
		const g = await w.generate(DRIVER_A);
		const d = lastRender(w).data;
		const line = (d.personalLines || [])[0] || {};
		check("an image receipt: the note and its in-page link", [line.receiptNote, line.receiptHref], ["Receipt 1 of 1, attached after this invoice", "#receipt-1"]);
		const page = (d.receiptPages || [])[0] || {};
		check("…one receipt page: anchor, header, the re-encoded JPEG",
			[(d.receiptPages || []).length, page.anchor, page.header, String(page.image || "").startsWith("data:image/jpeg;base64,")],
			[1, "receipt-1", "Receipt 1 of 1 - Personal expense, Pilot #123, Oct 12, 2026 - deducted $200.00", true]);
		const jpeg = Buffer.from(String(page.image || "").replace(/^data:image\/jpeg;base64,/, ""), "base64");
		check("…which is a JPEG within the limits", imageLimits.checkImage(jpeg, { types: [imageLimits.JPEG], maxPixels: 1600 * 1600, maxBytes: 1.5 * 1024 * 1024 }).ok, true);
		const stored = JSON.parse(w.invoice(g.body.invoice.id).render_data);
		check("none of it is stored in render_data", ["receiptPages" in stored, (stored.personalLines || []).some((l) => "receiptNote" in l || "receiptHref" in l)], [false, false]);
		const cacheDir = path.join(w.dataDir, "storage", "receipt-images");
		check("the re-encode is cached under storage/, outside uploads/", (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []).filter((f) => /^v1-1-[0-9a-f]{16}\.jpg$/.test(f)).length, 1);
		await mark(w, 5);
		const d2 = lastRender(w).data;
		check("a receipt with no file on disk: \"Receipt image not available\", no page for it",
			[(d2.personalLines || []).map((l) => l.receiptNote), (d2.receiptPages || []).length], [["Receipt 1 of 1, attached after this invoice", "Receipt image not available"], 1]);
		putPdf(w, 2);
		await mark(w, 2);
		const d3 = lastRender(w).data;
		check("a PDF receipt: \"PDF receipt on file\", never rendered", [(d3.personalLines || []).map((l) => l.receiptNote)[2], (d3.receiptPages || []).length],
			["PDF receipt on file", 1]);
		const adj = await w.call("PUT", `/api/invoices/${g.body.invoice.id}/adjust`, { body: { adjustment: 25, adjustmentNote: "Detention" } });
		const d4 = lastRender(w).data;
		check("an adjustment's re-render carries the same notes and page", [adj.status, (d4.personalLines || []).map((l) => l.receiptNote), (d4.receiptPages || []).length],
			[200, ["Receipt 1 of 1, attached after this invoice", "Receipt image not available", "PDF receipt on file"], 1]);
		w.cleanup();
	}
	{
		const w = world();
		await putImage(w, 1);
		const g = await w.generate(DRIVER_A);
		approve(w, g.body.invoice.id);
		await mark(w, 1);
		const d = lastRender(w).data;
		check("a correction invoice: the deduction says where its receipt is, and the page follows",
			[lastRender(w).templateName, (d.deductions || []).map((x) => x.receiptNote), (d.receiptPages || []).length],
			["service_invoice_manual", ["Receipt 1 of 1, attached after this invoice"], 1]);
		const c = w.db.prepare("SELECT render_data FROM invoices WHERE is_correction = 1").get();
		check("…and its stored render data keeps none of it", [/receiptNote|receiptPages/.test(c.render_data)], [false]);
		w.cleanup();
	}

	section("§2 personal_lines in the invoice lists");
	{
		const w = world();
		await putImage(w, 1);
		putPdf(w, 2);
		await mark(w, 1);
		await mark(w, 2);
		await mark(w, 5);
		const g = await w.generate(DRIVER_A);
		const id = g.body.invoice.id;
		const ids = w.lines().map((l) => l.id);
		const list = await w.call("GET", "/api/invoices", { as: "admin" });
		const lines = rowFor(list.body.invoices, id).personal_lines || [];
		check("Super Admin: each line with its receipt (image route, pdf, none)", lines.map((l) => [l.line_id, l.kind, l.amount, l.receipt && l.receipt.kind, l.receipt && l.receipt.url, l.receipt && l.receipt.expense_id]), [
			[ids[0], "personal", "-$200.00", "image", `/api/invoices/${id}/personal-receipts/${ids[0]}`, 1],
			[ids[1], "personal", "-$45.50", "pdf", "", 2],
			[ids[2], "personal", "-$300.00", "none", "", 5],
		]);
		check("…labels as printed", lines.map((l) => l.label), ["Personal expense, Pilot #123, Oct 12, 2026", "Personal expense, Love's #77, Oct 13, 2026", "Personal expense, Pilot #123, Oct 11, 2026"]);
		const mine = await w.call("GET", "/api/invoices", { as: "driverA" });
		check("Driver A sees his own invoice's lines", (rowFor(mine.body.invoices, id).personal_lines || []).length, 3);
		const other = await w.call("GET", "/api/invoices", { as: "driverB" });
		check("…Driver B sees none of them", (other.body.invoices || []).map((r) => r.id).includes(id), false);
		const plain = rowFor(list.body.invoices, id);
		check("an invoice without lines lists an empty array", (await (async () => { const g2 = await w.generate(DRIVER_B); const l2 = await w.call("GET", "/api/invoices", { as: "admin" }); return rowFor(l2.body.invoices, g2.body.invoice.id).personal_lines; })()), []);
		check("the total due is unchanged by the listing", plain.total_due, 900 - 200 - 45.5 - 300);
		w.cleanup();
	}
	{
		const w = world();
		const g = await w.generate(OWNER_OP);
		w.db.prepare("UPDATE invoices SET status = 'Submitted' WHERE id = ?").run(g.body.invoice.id);
		await mark(w, 8);
		const lines = w.api.personalLinesForInvoices([g.body.invoice.id]).get(g.body.invoice.id) || [];
		check("an owner-operator's share line carries no receipt; its Personal line does", lines.map((l) => [l.kind, l.amount, l.receipt === null ? null : l.receipt.kind]),
			[["share", "+$25.00", null], ["personal", "-$100.00", "none"]]);
		w.cleanup();
	}
	{
		const at = SRC.indexOf("const driverInvoices = db.prepare(");
		const driverList = at >= 0 ? SRC.slice(at, at + 1200) : "";
		check("the driver app's invoice list carries personal_lines (personalLinesForInvoices())",
			[/personalLinesForInvoices\(driverInvoices\.map/.test(driverList), /inv\.personal_lines = /.test(driverList)], [true, true]);
	}

	section("§3 the receipt route");
	{
		const w = world();
		await putImage(w, 1);
		putPdf(w, 2);
		await mark(w, 1);
		await mark(w, 2);
		await mark(w, 5);
		const g = await w.generate(DRIVER_A);
		const id = g.body.invoice.id;
		const [img, pdf, missing] = w.lines().map((l) => l.id);
		const url = (lineId, invoiceId = id) => `/api/invoices/${invoiceId}/personal-receipts/${lineId}`;
		const a = await w.call("GET", url(img), { as: "admin" });
		check("Super Admin: 200, the JPEG, nosniff, private no-store",
			[a.status, Buffer.isBuffer(a.body) && imageLimits.checkImage(a.body, { types: [imageLimits.JPEG], maxPixels: 1600 * 1600 }).ok, a.headers["content-type"], a.headers["x-content-type-options"], a.headers["cache-control"]],
			[200, true, "image/jpeg", "nosniff", "private, no-store"]);
		const own = await w.call("GET", url(img), { as: "driverA" });
		check("the driver whose invoice it is: 200", [own.status, Buffer.isBuffer(own.body)], [200, true]);
		const statuses = [];
		for (const as of ["driverB", "dispatcher", "investor"]) statuses.push((await w.call("GET", url(img), { as })).status);
		check("another driver, a Dispatcher, an Investor: 403", statuses, [403, 403, 403]);
		check("signed out: 401", (await w.call("GET", url(img), { as: null })).status, 401);
		const pdfRes = await w.call("GET", url(pdf), { as: "admin" });
		check("a PDF receipt: 404 RECEIPT_IS_PDF (listed, never served here)", [pdfRes.status, pdfRes.body && pdfRes.body.code], [404, "RECEIPT_IS_PDF"]);
		const miss = await w.call("GET", url(missing), { as: "driverA" });
		check("a receipt with no file: 404 RECEIPT_IMAGE_UNAVAILABLE", [miss.status, miss.body && miss.body.code], [404, "RECEIPT_IMAGE_UNAVAILABLE"]);
		const g2 = await w.generate(DRIVER_A, "2026-10-09");
		check("a line asked for under another invoice: 404", (await w.call("GET", url(img, g2.body.invoice.id), { as: "admin" })).status, 404);
		check("no such invoice, no such line, a malformed id: 404", [(await w.call("GET", url(img, 9999), { as: "admin" })).status, (await w.call("GET", url(9999), { as: "admin" })).status, (await w.call("GET", url("x"), { as: "admin" })).status], [404, 404, 404]);
		await w.call("DELETE", "/api/expenses/5/personal", { body: {} });
		check("an undone line: 404", (await w.call("GET", url(missing), { as: "admin" })).status, 404);
		await w.call("DELETE", `/api/invoices/${id}`, { query: { reason: "redo" } });
		check("a soft-deleted invoice: the driver 404, Super Admin still 200", [(await w.call("GET", url(img), { as: "driverA" })).status, (await w.call("GET", url(img), { as: "admin" })).status], [404, 200]);
		w.cleanup();
	}

	section("§4 the weeks waiting for a correction invoice");
	{
		const w = world();
		await mark(w, 11);
		w.setNow(SAT_0630);
		await w.api.runPersonalSweep();
		const r = await w.call("GET", "/api/expenses/personal/waiting-corrections", { as: "admin" });
		check("Super Admin: one row per driver and week, as the server totals it",
			[r.status, r.body.groups], [200, [{ driver: DRIVER_B, week_start: "2026-10-10", week_label: "Oct 10-16, 2026", lines: 1, amount_text: "-$30.00" }]]);
		check("a Dispatcher: 403", (await w.call("GET", "/api/expenses/personal/waiting-corrections", { as: "dispatcher" })).status, 403);
		await w.call("POST", "/api/invoices/personal-corrections", { body: { driver: DRIVER_B, weekStart: "2026-10-10" } });
		check("once the correction exists, nothing waits", (await w.call("GET", "/api/expenses/personal/waiting-corrections", { as: "admin" })).body.groups, []);
		w.cleanup();
	}

	section("§5 the month close lists Personal lines no invoice carries yet");
	{
		const w = world();
		await mark(w, 1);
		const waiting = w.api.personalWaitingInPeriod("2026-10");
		check("a line booked to October, waiting for its week's invoice", waiting.map((x) => [x.expense_id, x.driver, x.amount_text, x.state]), [[1, DRIVER_A, "$200.00", "pending"]]);
		check("…another month lists none", w.api.personalWaitingInPeriod("2026-11"), []);
		await w.generate(DRIVER_A);
		check("…once an invoice carries it, it is not listed", w.api.personalWaitingInPeriod("2026-10"), []);
		const finalize = SRC.slice(SRC.indexOf('app.post("/api/periods/:period/finalize"'), SRC.indexOf('app.post("/api/periods/:period/finalize"') + 3600);
		check("the close route answers and audits them", [/personalWaitingInPeriod\(period\)/.test(finalize), /personalWaiting/.test(finalize.slice(finalize.indexOf("res.json({ success: true, period")))], [true, true]);
		const auto = SRC.slice(SRC.indexOf("// Notify only for periods this pass actually closed."), SRC.indexOf("// Notify only for periods this pass actually closed.") + 2400);
		check("the automatic close's notice names them", /personalWaitingInPeriod\(period\)/.test(auto), true);
		const autoAudit = auto.slice(0, auto.indexOf("periodCloseFailStreak = 0;"));
		check("…and it writes the period_finalize audit row the manual close writes, naming them",
			[/logAudit\(PERIOD_CLOSE_SYSTEM_ACTOR, "period_finalize", "period", period,/.test(autoAudit), /Personal line\(s\) on no invoice yet/.test(autoAudit), /still Pending review/.test(autoAudit)],
			[true, true, true]);
		w.cleanup();
	}

	section("§7 the Friday batch prepares the week's receipt images first");
	{
		const w = world();
		await putImage(w, 1);
		// A line marked before receipts were prepared (or whose cache was cleared):
		// written directly, so nothing has started its image.
		w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
			VALUES (1, 'deduct', 20000, 20000, 'Pilot #123', '2026-10-12', '2026-10', 1, '2026-10-12', '2026-10-10', 't', 'super_admin', 1, 'Super Admin')`).run();
		const cacheDir = path.join(w.dataDir, "storage", "receipt-images");
		const cached = () => (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []).filter((f) => /^v1-1-/.test(f)).length;
		check("setup: a cold cache", cached(), 0);
		const out = await w.api.warmPersonalReceiptsForWeek("2026-10-10");
		check("warmPersonalReceiptsForWeek() re-encodes and caches the week's receipt images", [out.receipts, out.prepared, cached()], [1, 1, 1]);
		check("…another week's prepares nothing", (await w.api.warmPersonalReceiptsForWeek("2026-10-03")).receipts, 0);
		const g = await w.generate(DRIVER_A);
		check("…and the batch's render prints the page from the cache", [g.status, (lastRender(w).data.receiptPages || []).length], [200, 1]);
		const batch = SRC.slice(SRC.indexOf("async function runWeeklyInvoiceBatch("), SRC.indexOf("async function runWeeklyInvoiceBatch(") + 6000);
		const warmAt = batch.indexOf("await warmPersonalReceiptsForWeek(range.weekStart)");
		check("runWeeklyInvoiceBatch() awaits it before it generates any invoice", warmAt > 0 && warmAt < batch.indexOf("for (const driver of rosterDrivers)"), true);
		w.cleanup();
	}

	section("§6 the payment report PDF's Personal column");
	{
		const w = world();
		const before = w.api.paymentReportColumns([{ personal_total: 0, personal_share_total: 0 }]);
		check("no invoice with Personal lines: the columns it had before them",
			before.map((c) => [c.label, c.x, c.w]),
			[["Invoice #", 50, 116], ["Period", 166, 94], ["Status", 260, 56], ["Base", 316, 62], ["Adjust", 378, 50], ["Total Due", 428, 64], ["Paid On", 492, 70]]);
		const withLines = w.api.paymentReportColumns([{ personal_total: 0, personal_share_total: 0 }, { personal_total: 200, personal_share_total: 0 }]);
		check("an invoice with Personal lines: the Personal column", withLines.map((c) => c.label), ["Invoice #", "Period", "Status", "Base", "Adjust", "Personal", "Total Due", "Paid On"]);
		check("…a share alone counts too", w.api.paymentReportColumns([{ personal_total: 0, personal_share_total: 25 }]).some((c) => c.key === "personal"), true);
		const pdfRoute = SRC.slice(SRC.indexOf('app.get("/api/invoices/report/pdf"'), SRC.indexOf('app.get("/api/invoices/report/pdf"') + 6000);
		check("the PDF route takes its columns from paymentReportColumns()", /paymentReportColumns\(report\.invoices\)/.test(pdfRoute), true);
		w.cleanup();
	}

	section("§8 W12 the Friday warm-up prepares a carried line's receipt too");
	{
		const w = world({ ...ON, PERSONAL_RECEIPT_WEEK_ENABLED: "true" });
		w.db.prepare(`INSERT INTO expenses (id, timestamp, driver, type, amount, date, status, vendor, truck_unit, owner_id, created_at, description, photo_data)
			VALUES (20, '2026-10-07T15:00:00.000Z', ?, 'Food', 45.5, '2026-10-07', 'Approved', 'EXAMPLE DINER #3', 'T-1', 7, '2026-10-07 15:00:00', '', ?)`)
			.run(DRIVER_A, `/uploads/expense-receipts/${1760000000000 + 20}-abcdefabcdef.jpg`);
		await putImage(w, 20);
		// A W40 line its own week's invoice could not take (carried), written
		// directly so nothing has started its image: W41's invoice may take it.
		w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, needs_correction_since, created_at, created_by, created_by_id, created_role)
			VALUES (20, 'deduct', 4550, 4550, 'EXAMPLE DINER #3', '2026-10-07', '2026-10', 1, '2026-10-07', '2026-10-03', '2026-10-10T10:30:00.000Z', 't', 'super_admin', 1, 'Super Admin')`).run();
		const cacheDir = path.join(w.dataDir, "storage", "receipt-images");
		const cached = () => (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []).filter((f) => /^v1-20-/.test(f)).length;
		const out = await w.api.warmPersonalReceiptsForWeek("2026-10-10");
		check("warmPersonalReceiptsForWeek(W41) re-encodes and caches the carried W40 line's receipt", [out.receipts, out.prepared, cached()], [1, 1, 1]);
		const g = await w.generate(DRIVER_A);
		const line = w.lines("expense_id = 20")[0] || {};
		check("…and W41's render, which takes the line, prints its page",
			[g.status, line.invoice_id === (g.body.invoice && g.body.invoice.id), (lastRender(w).data.receiptPages || []).length], [200, true, 1]);
		w.cleanup();
	}

	finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
