#!/usr/bin/env node
/**
 * PDF receipt pages on the weekly invoice (Personal receipts, R3 v2 PR2): the
 * wiring in server.js (renderInvoiceWithReceipts(), personalReceiptRenderData(),
 * the flag and kill switch, the driver check, the combined sheet counter, the
 * warm-up and the startup self-test), the layout (lib/invoice-receipts.js), the
 * field map and the renderer's sink. server.js's own code runs on the world in
 * scripts/lib/personal-world.js (made-up data; week W41 = Sat 10-10 .. Fri
 * 10-16). The "rendered invoice" is a made-up PDF standing in for Chrome's: one
 * page for the invoice and one per receipt sheet, the sheets' anchors as named
 * destinations. Every receipt PDF is made up and built here. Since driver
 * privacy PR B a page is copied only once released to the driver: these
 * receipts' pages (no text, so UNREADABLE) are released by the Super Admin's
 * mark (releaseAll()); scripts/test-receipt-pdf-page-privacy.js covers the rule.
 *
 *   T1  a 1-page PDF receipt: "Receipt 1 of 1, attached after this invoice", a
 *       sheet saying its page follows, the page copied in after the sheet and
 *       labelled; the adjustment's re-render the same
 *   T14 RECEIPT_PDF_PAGES_ENABLED unset (the default), anything but exactly
 *       "true", or the R3 flag off: exactly v1 ("PDF receipt on file", no
 *       sheet, the rendered file as it came, nothing prepared). PDF pages are
 *       opt-in until the driver-privacy statement-page rule ships.
 *   T15 a receipt whose driver is not the invoice's driver: the note, and the
 *       cache is never read
 *   T17 a failed merge renders once more with every PDF receipt on its note;
 *       over 15 copied pages, the receipt that would cross keeps the note
 *   T36 9 image and 2 PDF receipts: 10 sheets, the 11th "More receipts on file",
 *       never prepared, no receipt-11 anywhere
 *   T37 a blank receipt driver or a blank invoice driver: the note, no cache read
 *   T38 the final re-check fails (an /OpenAction in the rendered invoice, or a
 *       copied page carrying /Annots): one more render, every PDF on its note
 *
 * Pure apart from the receipt children and a temp folder: no server, no app.db,
 * no network.
 * Run: node scripts/test-receipt-pdf-invoice.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { makeChecker, DRIVER_A, ROOT, SRC } = require("./lib/personal-world");
const { buildPrivacyWorld } = require("./lib/receipt-privacy-world");
const { check, section, finish } = makeChecker();
const { PDFDocument, PDFName, PDFArray, PDFRawStream, PDFString, StandardFonts, decodePDFRawStream } = require(path.join(ROOT, "node_modules", "pdf-lib"));
const { Jimp } = require(path.join(ROOT, "node_modules", "jimp"));
const rp = require(path.join(ROOT, "lib", "receipt-pdf.js"));
const layoutLib = require(path.join(ROOT, "lib", "invoice-receipts.js"));
const maps = require(path.join(ROOT, "lib", "policy-field-maps.js"));
const { safeReceiptPages } = require(path.join(ROOT, "lib", "policy-renderer.js"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-pdf-invoice-"));
const PROBES = { env: path.join(TMP, "env-probe.txt"), db: path.join(TMP, "db-probe.txt") };
fs.writeFileSync(PROBES.env, "MADE_UP=1\n");
fs.writeFileSync(PROBES.db, "made up\n");

// PDF receipt pages are opt-in: they attach only with both flags exactly "true".
const R3_ONLY = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" };
const ON = { ...R3_ONLY, RECEIPT_PDF_PAGES_ENABLED: "true" };
const NOTE_PDF = "PDF receipt on file";

// What Chrome would hand back for the render data: an invoice page, then one
// page per receipt sheet, each sheet's anchor a named destination.
async function fakeChrome(templateName, data, { openAction = false } = {}) {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	doc.addPage([612, 792]).drawText(`INVOICE ${templateName}`, { x: 50, y: 700, size: 12, font });
	const sheets = (data.receiptPages || []).map((p) => {
		const page = doc.addPage([612, 792]);
		page.drawText(`SHEET ${p.anchor}`, { x: 50, y: 700, size: 12, font });
		return [p.anchor, doc.context.obj([page.ref, "XYZ", 0, 792, 0])];
	});
	if (sheets.length) doc.catalog.set(PDFName.of("Dests"), doc.context.obj(Object.fromEntries(sheets)));
	if (openAction) doc.catalog.set(PDFName.of("OpenAction"), doc.context.obj({ S: "JavaScript", JS: PDFString.of("void 0") }));
	return Buffer.from(await doc.save({ useObjectStreams: false }));
}

function world(env = ON, { chrome = {} } = {}) {
	const w = buildPrivacyWorld({ env, receiptPdfProbes: PROBES });
	w.chrome = { ...chrome };
	w.outputs = [];
	w.hooks.render = async (templateName, data, record) => {
		await record(templateName, data);
		const pdf = w.chrome.stub ? Buffer.from("%PDF-1.7\nnot a pdf\n%%EOF\n", "latin1") : await fakeChrome(templateName, data, w.chrome);
		w.outputs.push(pdf);
		return pdf;
	};
	return w;
}
const mark = (w, id) => w.call("POST", `/api/expenses/${id}/personal`, { as: "admin", body: {} });
// Every page of a PDF receipt released by the Super Admin, one mark per page.
async function releaseAll(w, id) {
	const d = await w.call("GET", `/api/expenses/${id}/receipt-pages`, { as: "admin" });
	for (const p of (d.body && d.body.pages) || []) {
		await w.call("POST", `/api/expenses/${id}/receipt-pages/${p.page}`, { as: "admin", body: { mark: "released", reason: "checked_receipt" } });
	}
}
const adjust = (w, id, amount) => w.call("PUT", `/api/invoices/${id}/adjust`, { body: { adjustment: amount, adjustmentNote: "Detention" } });
const lastRender = (w) => w.rendered[w.rendered.length - 1] || { data: {} };
const notes = (d) => (d.personalLines || []).map((l) => l.receiptNote);
const receiptPath = (w, id, ext) => path.join(w.dataDir, "uploads", "expense-receipts", `${1760000000000 + id}-abcdefabcdef.${ext}`);
const cacheDir = (w) => path.join(w.dataDir, "storage", "receipt-pdfs");
const cached = (w, id) => (fs.existsSync(cacheDir(w)) ? fs.readdirSync(cacheDir(w)) : []).filter((f) => f.startsWith(`v1-${id}-`) && f.endsWith(".pdf"));
const storedFile = (w, invoiceId) => fs.readFileSync(path.join(w.dataDir, "uploads", "invoices", w.invoice(invoiceId).pdf_file_name));

// A made-up receipt of n pages.
function receiptPdf(n) {
	const kids = Array.from({ length: n }, (_, i) => `${i + 4} 0 R`).join(" ");
	return rp.rawPdf([
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`,
		rp.streamObject("", "0 0 1 rg 10 10 50 50 re f"),
		...Array.from({ length: n }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 3 0 R >>"),
	]);
}
function putPdf(w, id, bytes = receiptPdf(1)) {
	fs.mkdirSync(path.dirname(receiptPath(w, id, "pdf")), { recursive: true });
	fs.writeFileSync(receiptPath(w, id, "pdf"), bytes);
	w.db.prepare("UPDATE expenses SET photo_data = ? WHERE id = ?").run(`/uploads/expense-receipts/${1760000000000 + id}-abcdefabcdef.pdf`, id);
}
let JPEG = null;
async function putImage(w, id) {
	if (!JPEG) JPEG = await new Jimp({ width: 120, height: 160, color: 0x2a5599ff }).getBuffer("image/jpeg", { quality: 80 });
	fs.mkdirSync(path.dirname(receiptPath(w, id, "jpg")), { recursive: true });
	fs.writeFileSync(receiptPath(w, id, "jpg"), JPEG);
	w.db.prepare("UPDATE expenses SET photo_data = ? WHERE id = ?").run(`/uploads/expense-receipts/${1760000000000 + id}-abcdefabcdef.jpg`, id);
}
// Another receipt of Driver A's, copied from receipt 1 (Fuel, Oct 12, Approved).
function cloneReceipt(w, id, amount) {
	const row = { ...w.db.prepare("SELECT * FROM expenses WHERE id = 1").get(), id, amount };
	const cols = Object.keys(row);
	w.db.prepare(`INSERT INTO expenses (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
}

// Each page's drawn text (pdf-lib writes it as hex).
async function pagesOf(pdf) {
	const doc = await PDFDocument.load(pdf, { updateMetadata: false });
	return doc.getPages().map((p) => {
		const c = p.node.Contents();
		const streams = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
		const text = streams.map((s) => (s instanceof PDFRawStream
			? Buffer.from(s.dict.lookup(PDFName.of("Filter")) ? decodePDFRawStream(s).decode() : s.contents).toString("latin1") : "")).join("\n");
		return [...text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1")).join("|");
	});
}

// Every read under a receipt-pdfs cache folder, from here on.
const cacheReads = [];
const realReadFile = fs.promises.readFile;
fs.promises.readFile = function readFile(file, ...rest) {
	if (String(file).includes(`${path.sep}receipt-pdfs${path.sep}`)) cacheReads.push(String(file));
	return realReadFile.call(this, file, ...rest);
};

(async () => {
	section("T1 a PDF receipt's pages go in after its sheet");
	{
		const w = world();
		putPdf(w, 1);
		await mark(w, 1);
		await releaseAll(w, 1);
		const g = await w.generate(DRIVER_A);
		const d = lastRender(w).data;
		const line = (d.personalLines || [])[0] || {};
		const sheet = (d.receiptPages || [])[0] || {};
		check("T1 the line: \"Receipt 1 of 1, attached after this invoice\", linked to its sheet", [line.receiptNote, line.receiptHref], ["Receipt 1 of 1, attached after this invoice", "#receipt-1"]);
		check("T1 the sheet: its anchor, header, page count and note; no image",
			[sheet.anchor, sheet.header, sheet.pdfPages, sheet.note, "image" in sheet],
			["receipt-1", "Receipt 1 of 1 - Personal expense, Pilot #123, Oct 12, 2026 - deducted $200.00", 1, "The receipt's page follows this page", false]);
		const file = g.body && g.body.invoice ? storedFile(w, g.body.invoice.id) : Buffer.alloc(0);
		check("T1 the stored invoice: the invoice page, the sheet, then the receipt's page labelled; one render",
			[file.length ? await pagesOf(file) : null, w.rendered.length], [["INVOICE service_invoice", "SHEET receipt-1", "Receipt 1 of 1 - page 1 of 1"], 1]);
		check("T1 the prepared pages are cached under storage/receipt-pdfs, outside uploads/, and nothing of them is in render_data",
			[cached(w, 1).length, /receipt-pdfs|pdfPages|"pdf"/.test(g.body && g.body.invoice ? w.invoice(g.body.invoice.id).render_data : "")], [1, false]);
		const adj = g.body && g.body.invoice ? await adjust(w, g.body.invoice.id, 25) : { status: 0 };
		check("T1 the adjustment's re-render carries the same sheet and page",
			[adj.status, g.body && g.body.invoice ? await pagesOf(storedFile(w, g.body.invoice.id)) : null],
			[200, ["INVOICE service_invoice", "SHEET receipt-1", "Receipt 1 of 1 - page 1 of 1"]]);
		w.cleanup();
	}

	section("T14 PDF pages off (the default), or the R3 flag off: exactly v1");
	{
		for (const [label, env] of [["unset (the default)", R3_ONLY], ["\"1\" (only exactly \"true\" turns it on)", { ...R3_ONLY, RECEIPT_PDF_PAGES_ENABLED: "1" }]]) {
			const d0 = world(env);
			putPdf(d0, 1);
			await mark(d0, 1);
			const g0 = await d0.generate(DRIVER_A);
			const r0 = lastRender(d0).data;
			check(`T14 the R3 flag on, RECEIPT_PDF_PAGES_ENABLED ${label}: "PDF receipt on file", no sheet, the rendered file as it came, nothing prepared`,
				[notes(r0), (r0.receiptPages || []).length, g0.body && g0.body.invoice ? storedFile(d0, g0.body.invoice.id).equals(d0.outputs[0]) : false, cached(d0, 1).length],
				[[NOTE_PDF], 0, true, 0]);
			d0.cleanup();
		}
		const w = world({ ...ON, RECEIPT_PDF_PAGES_ENABLED: "false" });
		putPdf(w, 1);
		await mark(w, 1);
		await releaseAll(w, 1);
		const g = await w.generate(DRIVER_A);
		const d = lastRender(w).data;
		check("T14 RECEIPT_PDF_PAGES_ENABLED=false: \"PDF receipt on file\", no sheet, the rendered file as it came, nothing prepared",
			[notes(d), (d.receiptPages || []).length, g.body && g.body.invoice ? storedFile(w, g.body.invoice.id).equals(w.outputs[0]) : false, cached(w, 1).length],
			[[NOTE_PDF], 0, true, 0]);
		const ledger = w.db.prepare("SELECT * FROM expense_personal").all();
		w.cleanup();
		const off = world({});
		putPdf(off, 1);
		for (const row of ledger) {
			const cols = Object.keys(row).filter((c) => c !== "invoice_id");
			off.db.prepare(`INSERT INTO expense_personal (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
		}
		const g2 = await off.generate(DRIVER_A);
		const d2 = lastRender(off).data;
		check("T14 PERSONAL_EXPENSE_DEDUCTIONS_ENABLED off (a line marked while it was on): \"PDF receipt on file\", no sheet, the file as rendered",
			[notes(d2), (d2.receiptPages || []).length, g2.body && g2.body.invoice ? storedFile(off, g2.body.invoice.id).equals(off.outputs[0]) : false, cached(off, 1).length],
			[[NOTE_PDF], 0, true, 0]);
		off.cleanup();
	}

	section("T15 and T37 only the invoice's own driver's receipt is read");
	{
		const w = world();
		putPdf(w, 1);
		await mark(w, 1);
		await releaseAll(w, 1);
		const g = await w.generate(DRIVER_A);
		const id = g.body && g.body.invoice ? g.body.invoice.id : 0;
		check("T15 first, with the drivers matching: attached and cached", [notes(lastRender(w).data), cached(w, 1).length], [["Receipt 1 of 1, attached after this invoice"], 1]);
		const cases = [
			["T15 the receipt's driver is another driver", () => w.db.prepare("UPDATE expenses SET driver = 'Test Driver B' WHERE id = 1").run()],
			["T37 the receipt's driver is blank", () => w.db.prepare("UPDATE expenses SET driver = '  ' WHERE id = 1").run()],
			["T37 the invoice's driver is blank (the receipt's is his)", () => {
				w.db.prepare("UPDATE expenses SET driver = ? WHERE id = 1").run(DRIVER_A);
				w.db.prepare("UPDATE invoices SET driver = '' WHERE id = ?").run(id);
			}],
		];
		let amount = 10;
		for (const [label, setUp] of cases) {
			setUp();
			cacheReads.length = 0;
			const adj = id ? await adjust(w, id, amount++) : { status: 0 };
			const d = lastRender(w).data;
			check(`${label}: "PDF receipt on file", no sheet, the cache never read`,
				[adj.status, notes(d), (d.receiptPages || []).length, cacheReads.length, id ? (await pagesOf(storedFile(w, id))).length : 0], [200, [NOTE_PDF], 0, 0, 1]);
		}
		w.cleanup();
	}

	section("T17 a failed merge renders once more with every PDF receipt on its note; the 15-page cap");
	{
		const w = world(ON, { chrome: { stub: true } });
		putPdf(w, 1);
		await mark(w, 1);
		await releaseAll(w, 1);
		const g = await w.generate(DRIVER_A);
		const [first, second] = w.rendered.map((r) => r.data);
		check("T17 a rendered invoice the merge cannot read: two renders, the first with the sheet, the second with the note; the second is stored",
			[w.rendered.length, first && notes(first), second && notes(second), second && (second.receiptPages || []).length,
				g.body && g.body.invoice && w.outputs[1] ? storedFile(w, g.body.invoice.id).equals(w.outputs[1]) : false],
			[2, ["Receipt 1 of 1, attached after this invoice"], [NOTE_PDF], 0, true]);
		w.cleanup();

		const big = world();
		for (const id of [1, 5, 2]) {
			putPdf(big, id, receiptPdf(6));
			await mark(big, id);
			await releaseAll(big, id);
		}
		const g2 = await big.generate(DRIVER_A);
		const d2 = lastRender(big).data;
		const n = notes(d2);
		check("T17 three 6-page receipts: two attached (12 pages), the third would cross 15 and keeps the note",
			[n.filter((x) => /^Receipt [12] of 2, attached after this invoice$/.test(x)).length, n.filter((x) => x === NOTE_PDF).length, (d2.receiptPages || []).length,
				g2.body && g2.body.invoice ? (await pagesOf(storedFile(big, g2.body.invoice.id))).length : 0, big.rendered.length],
			[2, 1, 2, 15, 1]);
		big.cleanup();
	}

	section("T36 images and PDFs share the 10-sheet cap");
	{
		const w = world();
		for (let i = 0; i < 9; i++) {
			cloneReceipt(w, 101 + i, 10);
			await putImage(w, 101 + i);
			await mark(w, 101 + i);
		}
		putPdf(w, 1);
		await mark(w, 1);
		await releaseAll(w, 1);
		putPdf(w, 5);
		await mark(w, 5);
		await releaseAll(w, 5);
		const g = await w.generate(DRIVER_A);
		const d = lastRender(w).data;
		const n = notes(d);
		const anchors = (d.receiptPages || []).map((p) => p.anchor);
		check("T36 9 images then 2 PDFs: 10 sheets (the 10th the first PDF's), the 11th (a PDF, which the app never opens for a driver) \"PDF receipt on file\" and never prepared, no receipt-11",
			[anchors.length, anchors[9], (d.receiptPages || [])[9] && d.receiptPages[9].pdfPages, n[n.length - 1], cached(w, 5).length,
				JSON.stringify(d).includes("receipt-11"), g.body && g.body.invoice ? (await pagesOf(storedFile(w, g.body.invoice.id))).length : 0],
			[10, "receipt-10", 1, NOTE_PDF, 0, false, 12]);
		w.cleanup();

		const entries = Array.from({ length: 11 }, (_, i) => ({ rowId: i + 1, kind: "personal", label: `Personal expense, Store ${i + 1}, Oct 12, 2026`, cents: -100 }));
		const rows = entries.map((e) => ({ id: e.rowId, expense_id: 700 + e.rowId }));
		const prepared = new Map(rows.map((r, i) => [r.expense_id, i < 9 ? { status: "image", dataUri: "data:image/jpeg;base64,AAAA" } : { status: "pdf_pages", pages: 2 }]));
		const out = layoutLib.receiptLayout(entries, rows, prepared);
		check("T36 the layout: 10 sheets, one insert (sheet 10 of 10, 2 pages), the 11th line (a PDF) over the cap keeps \"PDF receipt on file\"",
			[out.pages.length, out.inserts, out.entries[10].receiptNote, out.pages[9] && out.pages[9].note],
			[10, [{ expenseId: 710, anchor: "receipt-10", index: 10, total: 10, pages: 2 }], NOTE_PDF, "The receipt's 2 pages follow this page"]);
		const imageOver = layoutLib.receiptLayout(entries, rows, new Map(rows.map((r) => [r.expense_id, { status: "image", dataUri: "data:image/jpeg;base64,AAAA" }])));
		check("T36 an image over the cap still says \"More receipts on file\" (a driver can open his image receipts in the app)",
			imageOver.entries[10].receiptNote, "More receipts on file: open this receipt in the app");
		const sheets = [...out.pages, { anchor: "receipt-11", header: "x", pdfPages: 1, note: "n" }];
		const f = maps.service_invoice({ personalLines: out.entries, receiptPages: sheets });
		check("T36 the field map and the renderer's sink keep 10 sheets (the PDF sheet with no image) and never a receipt-11",
			[f.receiptPages.length, f.receiptPages[9] && f.receiptPages[9].pdfPages, f.receiptPages[9] && f.receiptPages[9].image, safeReceiptPages(sheets).map((p) => p.anchor).includes("receipt-11"), safeReceiptPages(sheets).length,
				safeReceiptPages([{ anchor: "receipt-1", header: "x", pdfPages: 7 }, { anchor: "receipt-2", header: "x", pdfPages: 2, image: "data:image/png;base64,AAAA" }]).length],
			[10, 2, null, false, 10, 0]);
		check("T36 the sheet caps are the library's", [layoutLib.RECEIPT_SHEETS_MAX, layoutLib.RECEIPT_PDF_SHEET_PAGES_MAX === rp.RECEIPT_PDF_MAX_PAGES], [10, true]);
	}

	section("T38 the final re-check");
	{
		const w = world(ON, { chrome: { openAction: true } });
		putPdf(w, 1);
		await mark(w, 1);
		await releaseAll(w, 1);
		const g = await w.generate(DRIVER_A);
		check("T38 an /OpenAction in the rendered invoice: two renders, the stored one with the note and no copied page",
			[w.rendered.length, notes(lastRender(w).data), g.body && g.body.invoice ? await pagesOf(storedFile(w, g.body.invoice.id)) : null],
			[2, [NOTE_PDF], ["INVOICE service_invoice"]]);
		w.cleanup();

		const t = world();
		putPdf(t, 1);
		await mark(t, 1);
		await releaseAll(t, 1);
		const g2 = await t.generate(DRIVER_A);
		const [name] = cached(t, 1);
		const base = name ? path.join(cacheDir(t), name.replace(/\.pdf$/, "")) : "";
		if (base) {
			const doc = await PDFDocument.load(fs.readFileSync(`${base}.pdf`), { updateMetadata: false });
			doc.getPage(0).node.set(PDFName.of("Annots"), doc.context.obj([doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 10, 10] })]));
			const planted = Buffer.from(await doc.save({ useObjectStreams: false }));
			fs.writeFileSync(`${base}.pdf`, planted);
			fs.writeFileSync(`${base}.json`, JSON.stringify({ pages: 1, sha256: crypto.createHash("sha256").update(planted).digest("hex") }));
		}
		const before = t.rendered.length;
		const adj = g2.body && g2.body.invoice ? await adjust(t, g2.body.invoice.id, 25) : { status: 0 };
		check("T38 a cached page carrying /Annots: the merge refuses it, one more render, the stored invoice with the note",
			[Boolean(base), adj.status, t.rendered.length - before, notes(lastRender(t).data), g2.body && g2.body.invoice ? await pagesOf(storedFile(t, g2.body.invoice.id)) : null],
			[true, 200, 2, [NOTE_PDF], ["INVOICE service_invoice"]]);
		t.cleanup();
	}

	section("the startup self-test and the warm-up");
	{
		const listen = SRC.indexOf("server.listen(PORT, BIND_HOST");
		check("server.js runs the PDF child's self-test once listening, whatever the flags, and a setup failure cannot stop the start",
			listen > 0 && /try \{\s*receiptPdfService\(\)\.selfTest\(\);\s*\} catch \{\s*console\.warn\(/.test(SRC.slice(listen, listen + 4000)), true);
		const w = world();
		putPdf(w, 1);
		await mark(w, 1);
		await releaseAll(w, 1);
		const warmed = await w.api.warmPersonalReceiptsForWeek("2026-10-10");
		check("the Friday warm-up prepares the week's PDF receipts too", [warmed, cached(w, 1).length], [{ receipts: 1, prepared: 1 }, 1]);
		w.cleanup();
	}

	fs.promises.readFile = realReadFile;
	fs.rmSync(TMP, { recursive: true, force: true });
	finish();
})().catch((e) => { console.error(e && e.stack || e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } process.exit(1); });
