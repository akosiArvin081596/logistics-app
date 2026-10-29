#!/usr/bin/env node
/**
 * Driver privacy PR B, route level: a driver's invoice carries only the pages of
 * a PDF receipt that are released to him (plan ~/LogisX-replica/reports/
 * 2026-10-22-driver-privacy-receipts-plan.md Revision 3, sections 3-5; DP1-DP10
 * and 10b). server.js's own code runs on scripts/lib/receipt-privacy-world.js
 * (personal-world's made-up fleet; week W41 = Sat 10-10 .. Fri 10-16; receipt 1
 * is Test Driver A's, Fuel, $200.00, 2026-10-12, "Pilot #123", truck T-1).
 * Every receipt PDF is made up and built here; the "rendered invoice" is a
 * made-up PDF standing in for Chrome's.
 *
 *   T9  a 3-page Personal PDF, pages 1 and 3 marked released, page 2 naming
 *       another driver: every stream of the stored invoice inflated; page 1's
 *       and page 3's markers found first (the control), page 2's absent, the
 *       office line present; the render record holds no driver name. T9b: page
 *       2's image never reaches the bytes through a resource dictionary the
 *       pages share. T9c: nor through a soft mask's group, a tiling pattern or a
 *       Type3 font a released page uses whose /Resources is that dictionary (page
 *       2's image and its form's text absent); an object only page 2 draws,
 *       reached from page 1 any other way, refuses the copy (page_isolation);
 *       a single-page receipt (released with no human step) and a file with
 *       every page released carry no image or form their resources list but no
 *       page draws; a copy cached under version v1 is not read back
 *   T10 the Super Admin mark: one page per call, a reason code, audited; a
 *       Driver, a Dispatcher and an Investor get 403, a cross-site request is
 *       refused; a page with an OTHER_* code answers 409 with the codes until
 *       "Release anyway" names them; the staff detail lists it; the next render
 *       holds it
 *   T11 a new roster name on a released page: the stored invoice PDF is
 *       rebuilt without it (bytes checked), audited; the cached copy is not
 *       reused (allowlist and roster hash in the cache key)
 *   T12 a changed receipt file (new sha256) loses its marks, and the invoices
 *       holding its pages are rebuilt
 *   T14 the invoice PDF: Dispatcher, Investor and another driver 403 (regression)
 *   T15 a font with no ToUnicode map (its glyphs spelling another driver), or one
 *       line drawn in it: UNREADABLE, never AUTO_RELEASED, never copied
 *   T16 an Approved invoice, and one whose week is in a closed month (10b): a
 *       roster change withdraws a page through the pages-only path; the invoice
 *       pages keep their count and text, the invoices row is unchanged, the
 *       receipt pages are rebuilt at the end, one audit row, the original kept
 *       outside uploads/; then "Update invoice PDF" after a release, same
 *       invariants
 *   T17 (rule D) an invoice drawn before any of its receipt's pages was released
 *       still gets a render record; once released, "Update invoice PDF" adds the
 *       pages at the end, the invoice pages read as before; an "office only"
 *       mark then takes one out again, and its answer says which invoice
 *   T18 an "office only" mark whose withdrawal is refused answers the refusal
 *       (invoice and code) under its own key, beside the page view's list, and
 *       again when the same refusal comes back with its audit row and alert not
 *       repeated; once the rebuild works, the page leaves and the notice in its
 *       place names a receipt
 *   races: a page that stops being released while the pages-only path runs (a
 *       roster change during the rebuild) is never written, by "Update invoice
 *       PDF" or by the sweep
 *   an unverifiable receipt (its file gone, an image now, another driver's, a
 *       reader that keeps failing): 4 sweeps rewrite the invoice once, then no
 *       more kept copies, render records or audit rows
 *   the 15-page cap holds for "Update invoice PDF" (409 PAGE_CAP)
 *   the locked-invoice text check: a rebuild whose invoice pages' text differs
 *       is refused, logged and audited, and the stored file stays as it was; its
 *       alert names the invoice, so only Super Admins get it (stored and live)
 *   off: RECEIPT_PDF_PAGES_ENABLED unset, the routes answer 404 FEATURE_OFF and
 *       nothing is computed
 *
 * Pure apart from the receipt children and temp folders: no server, no app.db,
 * no network.
 * Run: node scripts/test-receipt-pdf-page-privacy.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { makeChecker, DRIVER_A } = require("./lib/personal-world");
const { buildPrivacyWorld, receiptPdfPool, receiptPdf, fakeChrome, streamTexts, pageTexts, glyphHex, CROSS_SITE } = require("./lib/receipt-privacy-world");
const rp = require(path.join(__dirname, "..", "lib", "receipt-pdf.js"));
const { check, section, finish } = makeChecker();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-page-privacy-"));
const PROBES = { env: path.join(TMP, "env-probe.txt"), db: path.join(TMP, "db-probe.txt") };
fs.writeFileSync(PROBES.env, "MADE_UP=1\n");
fs.writeFileSync(PROBES.db, "made up\n");

const ON = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true", RECEIPT_PDF_PAGES_ENABLED: "true" };
const OFF = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" };
const NOTE_PDF = "PDF receipt on file";
// Every world in one data folder, one at a time (each is cleaned up before the
// next), so they share one receipt PDF service, self-tested once in the run.
const POOL = receiptPdfPool(path.join(TMP, "world"));

function world(env = ON, extra = {}) {
	return buildPrivacyWorld({
		env,
		receiptPdfProbes: PROBES,
		pool: POOL,
		render: async (templateName, data, record) => { await record(templateName, data); return fakeChrome(templateName, data); },
		...extra,
	});
}

// A socket server stand-in that records each room a live event is sent to.
function recorderIo(log) {
	const room = (name) => ({
		emit: (event) => { log.push({ room: name, event }); return true; },
		except: (other) => room(`${name} except ${other}`),
		to: (other) => room(`${name}+${other}`),
	});
	return { to: room, in: room, emit: (event) => { log.push({ room: "*", event }); return true; } };
}
const addRosterName = (w, name) => w.db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_percentage, pay_daily) VALUES (?, '', 'fixed', 0, 250)").run(name);

const receiptFile = (id) => `${1760000000000 + id}-abcdefabcdef.pdf`;
function putPdf(w, id, bytes) {
	const dir = path.join(w.dataDir, "uploads", "expense-receipts");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, receiptFile(id)), bytes);
	w.db.prepare("UPDATE expenses SET photo_data = ? WHERE id = ?").run(`/uploads/expense-receipts/${receiptFile(id)}`, id);
}
const markPersonal = (w, id) => w.call("POST", `/api/expenses/${id}/personal`, { as: "admin", body: {} });
const detail = (w, id, as = "admin") => w.call("GET", `/api/expenses/${id}/receipt-pages`, { as });
const markPage = (w, id, page, body, opts = {}) => w.call("POST", `/api/expenses/${id}/receipt-pages/${page}`, { as: "admin", body, ...opts });
const updatePdf = (w, invoiceId, opts = {}) => w.call("POST", `/api/invoices/${invoiceId}/receipt-pages/update`, { as: "admin", body: {}, ...opts });
const adjust = (w, id, amount) => w.call("PUT", `/api/invoices/${id}/adjust`, { body: { adjustment: amount, adjustmentNote: "Detention" } });
const storedPath = (w, invoiceId) => path.join(w.dataDir, "uploads", "invoices", w.invoice(invoiceId).pdf_file_name);
const stored = (w, invoiceId) => (w.invoice(invoiceId) ? fs.readFileSync(storedPath(w, invoiceId)) : Buffer.alloc(0));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const audits = (w, action) => w.db.prepare("SELECT * FROM audit_trail WHERE action = ? ORDER BY id").all(action);
// The render records; -1 on a server.js without the table.
const renderCount = (w) => { try { return w.db.prepare("SELECT COUNT(*) AS n FROM invoice_pdf_renders").get().n; } catch { return -1; } };
const lastRender = (w) => w.rendered[w.rendered.length - 1] || { data: {} };
const notes = (d) => (d.personalLines || []).map((l) => l.receiptNote);
const pageCodes = (r) => (r && r.body && Array.isArray(r.body.pages) ? r.body.pages.map((p) => p.code) : null);

async function has(pdf, needle) {
	if (!pdf || !pdf.length) return false;
	return (await streamTexts(pdf)).some((t) => t.includes(needle));
}
// The stored invoice's pages split: copied receipt pages carry the label
// "Receipt N of M - page x of y" in their own content (a notice page "Receipt N
// of M - K pages of this receipt ..."), or, added at the end of an invoice
// drawn before any of them was released, "PDF receipt on file: <its line> -
// page x of y"; every other page, the sheets included, is an invoice page.
async function splitPages(pdf) {
	const texts = await pageTexts(pdf);
	const label = /(^|\|)(Receipt \d+ of \d+ - (page \d+ of \d+|\d+ pages? of this receipt)|PDF receipt on file: [^|]{1,120} - page \d+ of \d+)/;
	const receipt = texts.map((t, i) => (label.test(t) ? i : -1)).filter((i) => i >= 0);
	return { texts, receipt, invoice: texts.filter((_, i) => !receipt.includes(i)) };
}

// A made-up 3-page statement whose pages share one /Resources dictionary (4 0 R)
// listing every page's image and a form that draws page 2's text, which names
// Test Driver B. Pages 1 and 3 also use, by mode: an ExtGState whose soft mask's
// group form has that dictionary as its /Resources ("smask"), a tiling pattern
// with it ("pattern"), a Type3 font with it ("type3"); "junk": page 1's image
// dictionary also names page 2's image, under a key of its own.
// 1 Catalog, 2 Pages, 3 Helvetica, 4 the shared resources, 5 the ExtGState, 6 its
// group form, 7-9 one image per page, 10 the pattern, 11 page 2's form, 12 the
// Type3 font, 13 its glyph, then page and content pairs from 14.
function sharedStatement(mode) {
	const objs = [];
	objs.push("<< /Type /Catalog /Pages 2 0 R >>");
	objs.push("<< /Type /Pages /Kids [14 0 R 16 0 R 18 0 R] /Count 3 >>");
	objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
	objs.push("<< /Font << /F1 3 0 R /T3 12 0 R >> /XObject << /Im1 7 0 R /Im2 8 0 R /Im3 9 0 R /Fm2 11 0 R >> /ExtGState << /GS0 5 0 R >> /Pattern << /P0 10 0 R >> >>");
	objs.push("<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 6 0 R >> >>");
	objs.push(rp.streamObject("/Type /XObject /Subtype /Form /BBox [0 0 300 400] /Group << /S /Transparency /CS /DeviceGray >> /Resources 4 0 R", "1 g 0 0 300 400 re f"));
	for (let i = 1; i <= 3; i++) {
		const junk = mode === "junk" && i === 1 ? " /Junk 8 0 R" : "";
		objs.push(rp.streamObject(`/Type /XObject /Subtype /Image /Width 16 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8${junk}`, Buffer.from(`IMGMARK-P${i}`.padEnd(16, "-"), "latin1")));
	}
	objs.push(rp.streamObject("/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources 4 0 R", "0 g 0 0 5 5 re f"));
	objs.push(rp.streamObject("/Type /XObject /Subtype /Form /BBox [0 0 300 400] /Resources << /Font << /F1 3 0 R >> >>", "BT /F1 10 Tf 20 300 Td (FORMTEXT-P2 TEST DRIVER B) Tj ET"));
	objs.push("<< /Type /Font /Subtype /Type3 /FontBBox [0 0 750 750] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 13 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [1000] /Resources 4 0 R >>");
	objs.push(rp.streamObject("", "1000 0 0 0 750 750 d1 0 0 750 750 re f"));
	for (let i = 1; i <= 3; i++) {
		const uses = i === 2 ? "" : { smask: "q /GS0 gs 0 0 10 10 re f Q ", pattern: "q /Pattern cs /P0 scn 0 0 10 10 re f Q ", type3: "BT /T3 10 Tf 20 200 Td (a) Tj ET " }[mode] || "";
		const content = `${uses}BT /F1 10 Tf 20 380 Td (MARKER-P${i} TOLL STATEMENT) Tj ET q 64 0 0 4 20 10 cm /Im${i} Do Q${i === 2 ? " /Fm2 Do" : ""}`;
		objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents ${15 + (i - 1) * 2} 0 R /Resources 4 0 R >>`);
		objs.push(rp.streamObject("", content));
	}
	return rp.rawPdf(objs);
}

// A made-up PDF whose pages share one /Resources dictionary (4 0 R) that also
// lists an image and a form no page draws, the form's text naming Test Driver B
// (as a page split out of such a statement can carry). One page is receipt 1
// (Pilot, 10/12/2026, $200.00); more are toll statement pages.
// 1 Catalog, 2 Pages, 3 Helvetica, 4 the resources, 5 the undrawn image, 6 the
// undrawn form, 7.. one image per page, then page and content pairs.
function undrawnExtras(pageCount) {
	const image = (mark) => rp.streamObject("/Type /XObject /Subtype /Image /Width 16 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", Buffer.from(mark.padEnd(16, "-"), "latin1"));
	const first = 7 + pageCount;
	const objs = [];
	objs.push("<< /Type /Catalog /Pages 2 0 R >>");
	objs.push(`<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${first + 2 * i} 0 R`).join(" ")}] /Count ${pageCount} >>`);
	objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
	objs.push(`<< /Font << /F1 3 0 R >> /XObject << ${Array.from({ length: pageCount }, (_, i) => `/Im${i + 1} ${7 + i} 0 R`).join(" ")} /ImU 5 0 R /FmU 6 0 R >> >>`);
	objs.push(image("IMGMARK-UNDRAWN"));
	objs.push(rp.streamObject("/Type /XObject /Subtype /Form /BBox [0 0 300 400] /Resources << /Font << /F1 3 0 R >> >>", "BT /F1 10 Tf 20 300 Td (FORMTEXT-UNDRAWN TEST DRIVER B) Tj ET"));
	for (let i = 1; i <= pageCount; i++) objs.push(image(`IMGMARK-OWN${i}`));
	for (let i = 1; i <= pageCount; i++) {
		const text = pageCount === 1 ? "(PILOT TRAVEL CENTER #123) Tj 0 -14 Td (10/12/2026 08:14) Tj 0 -14 Td (TOTAL $200.00) Tj" : `(MARKER-P${i} TOLL STATEMENT) Tj`;
		objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents ${first + 2 * i - 1} 0 R /Resources 4 0 R >>`);
		objs.push(rp.streamObject("", `BT /F1 10 Tf 20 380 Td ${text} ET q 64 0 0 4 20 10 cm /Im${i} Do Q`));
	}
	return rp.rawPdf(objs);
}

// A made-up toll statement of Test Driver A's (3 pages, each with dated money
// lines). Page 1 also prints "CASEY RIVERA" (on no roster until a runner adds
// her); page 2 names Test Driver B (on the roster: an account and the directory);
// page 3 holds neither receipt 1's amount and date nor its vendor (UNREADABLE).
function statement({ page1Extra = [], page2 = null, sharedImages = false } = {}) {
	return receiptPdf([
		["FLEET TOLL STATEMENT", "MARKER-P1-7c41", "ACCOUNT HOLDER TEST DRIVER A", "BILLED TO CASEY RIVERA", "10/12/2026 PILOT #123 $200.00", "10/13/2026 PLAZA 4 $4.50", ...page1Extra],
		page2 || ["MARKER-P2-9e03", "ACCOUNT HOLDER TEST DRIVER B", "10/05/2026 PLAZA 9 $6.25", "10/06/2026 PLAZA 9 $6.25"],
		["MARKER-P3-2b88", "10/14/2026 PLAZA 2 $3.00", "10/15/2026 PLAZA 2 $3.00", "STATEMENT TOTAL $213.50"],
	], { sharedImages });
}
// A clean single-page receipt of receipt 1: amount, date and vendor.
const singlePage = (extra = []) => receiptPdf([["PILOT TRAVEL CENTER #123", "MARKER-S1-55aa", "10/12/2026 08:14", "TOTAL $200.00", ...extra]]);

// Receipt 1 as a 3-page statement, marked Personal, its verdicts read, pages 1
// and 3 released by the Super Admin, the W41 invoice generated.
async function statementInvoice(w, opts = {}) {
	putPdf(w, 1, statement(opts));
	const m = await markPersonal(w, 1);
	const d = await detail(w, 1);
	const r1 = await markPage(w, 1, 1, { mark: "released", reason: "only_his_lines" });
	const r3 = await markPage(w, 1, 3, { mark: "released", reason: "only_his_lines" });
	const g = await w.generate(DRIVER_A);
	const id = g.body && g.body.invoice ? g.body.invoice.id : 0;
	return { m, d, r1, r3, g, id };
}

(async () => {
	section("T9 only released pages reach the stored invoice");
	{
		const w = world();
		const { m, d, r1, r3, id } = await statementInvoice(w);
		check("T9 the Personal mark answers the receipt's page counts (codes only)",
			[m.status, m.body && m.body.receipt_pages && m.body.receipt_pages.pages, m.body && m.body.receipt_pages && m.body.receipt_pages.released], [201, 3, 0]);
		check("T9 the staff detail: page 1 STATEMENT, page 2 OTHER_PERSON, page 3 UNREADABLE (no amount and date, no vendor)",
			[d.status, pageCodes(d)], [200, ["STATEMENT", "OTHER_PERSON", "UNREADABLE"]]);
		check("T9 pages 1 and 3 released by the Super Admin", [r1.status, r3.status], [200, 200]);
		const file = id ? stored(w, id) : Buffer.alloc(0);
		check("T9 control first: the same inflate-and-search finds page 1's and page 3's markers in the stored invoice",
			[await has(file, "MARKER-P1-7c41"), await has(file, "MARKER-P3-2b88")], [true, true]);
		check("T9 page 2's marker and its other driver's name are in no stream of the stored invoice",
			[await has(file, "MARKER-P2-9e03"), await has(file, "TEST DRIVER B")], [false, false]);
		const sheet = (lastRender(w).data.receiptPages || [])[0] || {};
		check("T9 the sheet: 2 pages follow, \"1 page of this statement is kept by the office\"",
			[sheet.pdfPages, sheet.note], [2, "The receipt's 2 pages follow this page. 1 page of this statement is kept by the office."]);
		check("T9 the office line is in the stored bytes", await has(file, "1 page of this statement is kept by the office"), true);
		let renderRow = {};
		try { renderRow = w.db.prepare("SELECT * FROM invoice_pdf_renders ORDER BY id DESC LIMIT 1").get() || {}; } catch { renderRow = {}; }
		check("T9 the render record holds no driver name (file hashes, pages and positions only)",
			[Object.keys(renderRow).length > 0, "driver_key" in renderRow, /test driver a/i.test(JSON.stringify(renderRow))], [true, false, false]);
		w.cleanup();

		const s = world();
		const r = await statementInvoice(s, { sharedImages: true });
		const f2 = r.id ? stored(s, r.id) : Buffer.alloc(0);
		check("T9b control: pages 1 and 3 drew their images (IMGMARK-P1, IMGMARK-P3 in the bytes)", [f2.includes("IMGMARK-P1"), f2.includes("IMGMARK-P3")], [true, true]);
		check("T9b page 2's image, listed in the resource dictionary every page shares, is not in the bytes", f2.includes("IMGMARK-P2"), false);
		s.cleanup();
	}

	section("T9c a withheld page's content never rides along with a released page's soft mask, pattern or Type3 font");
	{
		for (const mode of ["smask", "pattern"]) {
			const w = world();
			putPdf(w, 1, sharedStatement(mode));
			await markPersonal(w, 1);
			const d = await detail(w, 1);
			const r1 = await markPage(w, 1, 1, { mark: "released", reason: "only_his_lines" });
			const r3 = await markPage(w, 1, 3, { mark: "released", reason: "only_his_lines" });
			const g = await w.generate(DRIVER_A);
			const id = g.body && g.body.invoice ? g.body.invoice.id : 0;
			const file = id ? stored(w, id) : Buffer.alloc(0);
			check(`T9c ${mode}: page 2 (naming Test Driver B through its form) withheld, pages 1 and 3 released`,
				[(pageCodes(d) || [])[1], r1.status, r3.status], ["OTHER_PERSON", 200, 200]);
			check(`T9c ${mode}: control first: pages 1 and 3 copied, their text and images in the stored invoice`,
				[await has(file, "MARKER-P1 TOLL"), await has(file, "MARKER-P3 TOLL"), file.includes("IMGMARK-P1"), file.includes("IMGMARK-P3")], [true, true, true, true]);
			check(`T9c ${mode}: page 2's image and its form's text are in neither the stored bytes nor any inflated stream`,
				[file.includes("IMGMARK-P2"), await has(file, "IMGMARK-P2"), await has(file, "FORMTEXT-P2"), await has(file, "TEST DRIVER B")], [false, false, false, false]);
			w.cleanup();
		}
		const w = world();
		const svc = w.mine.receiptPdfService();
		const prep = (mode, n) => svc.prepare({ expenseId: 900 + n, photoData: `data:application/pdf;base64,${sharedStatement(mode).toString("base64")}`, allowPages: [1, 3], rosterHash: "0123456789abcdef" });
		const t3 = await prep("type3", 1);
		const t3pdf = t3 && t3.pdf ? Buffer.from(t3.pdf) : Buffer.alloc(0);
		check("T9c type3: pages 1 and 3 copied with their images, page 2's image and its form's text absent",
			[t3 && t3.status, t3 && t3.pages, t3pdf.includes("IMGMARK-P1"), t3pdf.includes("IMGMARK-P3"), t3pdf.includes("IMGMARK-P2"), await has(t3pdf, "FORMTEXT-P2")],
			["pages", 2, true, true, false, false]);
		const junk = await prep("junk", 2);
		check("T9c an image only page 2 draws, reached from page 1 by another path: the copy is refused (page_isolation), the receipt keeps its note",
			[junk && junk.status, junk && junk.reason, Boolean(junk && junk.pdf)], ["on_file", "page_isolation", false]);

		const dataUri = (bytes) => `data:application/pdf;base64,${bytes.toString("base64")}`;
		const all = await svc.prepare({ expenseId: 903, photoData: dataUri(undrawnExtras(2)), allowPages: [1, 2], rosterHash: "0123456789abcdef" });
		const allPdf = all && all.pdf ? Buffer.from(all.pdf) : Buffer.alloc(0);
		check("T9c every page released: control first: both pages copied with their images",
			[all && all.status, all && all.pages, allPdf.includes("IMGMARK-OWN1"), allPdf.includes("IMGMARK-OWN2")], ["pages", 2, true, true]);
		check("T9c every page released: the image and the form (naming Test Driver B) the shared resources list but no page draws are absent",
			[allPdf.includes("IMGMARK-UNDRAWN"), await has(allPdf, "IMGMARK-UNDRAWN"), await has(allPdf, "FORMTEXT-UNDRAWN"), await has(allPdf, "TEST DRIVER B")], [false, false, false, false]);

		// A copy cached under another copier version (v1) for the same file, pages
		// and roster is never read back: the receipt is prepared again.
		const one = undrawnExtras(1);
		const old = path.join(w.dataDir, "storage", "receipt-pdfs", rp.receiptPdfCacheName(904, sha(one), "v1", [1], "0123456789abcdef"));
		const planted = Buffer.from("%PDF-1.7\n% PLANTED-OLD-COPY\n%%EOF\n", "latin1");
		fs.mkdirSync(path.dirname(old), { recursive: true });
		fs.writeFileSync(`${old}.pdf`, planted);
		fs.writeFileSync(`${old}.json`, JSON.stringify({ pages: 1, sha256: sha(planted) }));
		const again = await svc.prepare({ expenseId: 904, photoData: dataUri(one), allowPages: [1], rosterHash: "0123456789abcdef" });
		const againPdf = again && again.pdf ? Buffer.from(again.pdf) : Buffer.alloc(0);
		check("T9c a copy cached under version v1 (same file, pages and roster) is not read back: the receipt is prepared again, pruned",
			[again && again.status, again && again.cached, againPdf.includes("PLANTED-OLD-COPY"), againPdf.includes("IMGMARK-OWN1"), againPdf.includes("IMGMARK-UNDRAWN")],
			["pages", false, false, true, false]);
		w.cleanup();

		// A single-page receipt is released with no human step: the same pruning holds.
		const s = world();
		putPdf(s, 1, undrawnExtras(1));
		await markPersonal(s, 1);
		const d = await detail(s, 1);
		const g = await s.generate(DRIVER_A);
		const id = g.body && g.body.invoice ? g.body.invoice.id : 0;
		const file = id ? stored(s, id) : Buffer.alloc(0);
		check("T9c single page: AUTO_RELEASED (the reader reads only what the page draws), the invoice generated",
			[pageCodes(d), d.body?.pages?.[0]?.released, g.status], [["AUTO_RELEASED"], true, 200]);
		check("T9c single page: control first: its text and its image are in the stored invoice",
			[await has(file, "PILOT TRAVEL CENTER #123"), file.includes("IMGMARK-OWN1")], [true, true]);
		check("T9c single page: the image and the form (naming Test Driver B) its resources list but it never draws are in neither the stored bytes nor any inflated stream",
			[file.includes("IMGMARK-UNDRAWN"), await has(file, "IMGMARK-UNDRAWN"), await has(file, "FORMTEXT-UNDRAWN"), await has(file, "TEST DRIVER B")], [false, false, false, false]);
		s.cleanup();
	}

	section("T10 the Super Admin mark");
	{
		const w = world();
		const { id } = await statementInvoice(w);
		const before = audits(w, "receipt_page_mark").length;
		for (const as of ["driverA", "dispatcher", "investor"]) {
			const g = await detail(w, 1, as);
			const p = await markPage(w, 1, 2, { mark: "released", reason: "checked_receipt" }, { as });
			check(`T10 ${as}: 403 on the detail and on the mark`, [g.status, p.status], [403, 403]);
		}
		const cross = await markPage(w, 1, 2, { mark: "released", reason: "checked_receipt" }, { headers: CROSS_SITE });
		check("T10 a cross-site request is refused", [cross.status, cross.body && cross.body.code], [403, "CROSS_SITE_REFUSED"]);
		const noReason = await markPage(w, 1, 2, { mark: "released" });
		const all = await markPage(w, 1, "all", { mark: "released", reason: "checked_receipt" });
		const zero = await markPage(w, 1, 0, { mark: "released", reason: "checked_receipt" });
		check("T10 one page per call, with a reason code: no reason 400, \"all\" 400, page 0 400",
			[noReason.status, all.status, zero.status], [400, 400, 400]);
		const first = await markPage(w, 1, 2, { mark: "released", reason: "checked_receipt", pages: [1, 2, 3] });
		check("T10 releasing page 2 (OTHER_PERSON) answers 409 with its codes, nothing saved",
			[first.status, first.body && first.body.code, first.body && first.body.codes], [409, "RECEIPT_PAGE_RELEASE_ANYWAY", ["OTHER_PERSON"]]);
		const wrong = await markPage(w, 1, 2, { mark: "released", reason: "checked_receipt", releaseAnyway: ["OTHER_TRUCK"] });
		check("T10 \"Release anyway\" must name the page's codes", [wrong.status, wrong.body && wrong.body.code], [409, "RECEIPT_PAGE_RELEASE_ANYWAY"]);
		const ok = await markPage(w, 1, 2, { mark: "released", reason: "checked_receipt", note: "a made-up note", releaseAnyway: ["OTHER_PERSON"] });
		check("T10 with the codes named: 200", ok.status, 200);
		const d = await detail(w, 1);
		check("T10 the staff detail lists the page released anyway, and only page 2 changed",
			[d.body?.released_anyway, d.body?.pages?.map((p) => p.released)], [[2], [true, true, true]]);
		const rows = audits(w, "receipt_page_mark").slice(before);
		check("T10 one audit row per saved mark (none for the refusals), naming page, mark and reason code, never the note",
			[rows.length, /page 2/.test(rows[0] && rows[0].details), /released/.test(rows[0] && rows[0].details), /checked_receipt/.test(rows[0] && rows[0].details), /made-up note/.test(rows[0] && rows[0].details)],
			[1, true, true, true, false]);
		const a = id ? await adjust(w, id, 25) : { status: 0 };
		check("T10 the next render holds page 2", [a.status, await has(stored(w, id), "MARKER-P2-9e03")], [200, true]);
		w.cleanup();
	}

	section("T11 a new roster name withdraws a released page from the stored invoice");
	{
		const w = world();
		const cacheDir = path.join(w.dataDir, "storage", "receipt-pdfs");
		const { id } = await statementInvoice(w);
		const before = id ? stored(w, id) : Buffer.alloc(0);
		check("T11 first: page 1 is in the stored invoice", await has(before, "MARKER-P1-7c41"), true);
		const cacheBefore = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((f) => f.endsWith(".pdf")) : [];
		w.db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_percentage, pay_daily) VALUES ('Casey Rivera', '', 'fixed', 0, 250)").run();
		const sweep = await w.mine.runReceiptPagesSweep();
		const after = id ? stored(w, id) : Buffer.alloc(0);
		check("T11 the sweep withdrew one page from one invoice", [sweep && sweep.withdrawn, sweep && sweep.invoices], [1, [id]]);
		check("T11 the stored invoice: page 1 gone, page 3 kept, \"kept by the office\" on the rebuilt receipt pages",
			[await has(after, "MARKER-P1-7c41"), await has(after, "MARKER-P3-2b88"), await has(after, "kept by the office")], [false, true, true]);
		const row = audits(w, "invoice_receipt_pages").filter((r) => Number(r.entity_id) === id);
		check("T11 one audit row for the invoice, codes only (trigger, pages)",
			[row.length, /roster/.test(row[0] && row[0].details), /RIVERA|Casey/i.test(row[0] && row[0].details)], [1, true, false]);
		const cacheAfter = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((f) => f.endsWith(".pdf")) : [];
		const added = cacheAfter.filter((f) => !cacheBefore.includes(f));
		check("T11 the rebuild prepared a new cached copy under a new key (allowlist and roster hash in it), the first one kept",
			[added.length, cacheBefore.every((f) => cacheAfter.includes(f)), added.every((f) => /-p3-r[0-9a-f]{16}\.pdf$/.test(f)), cacheBefore.every((f) => /-p1_3-r[0-9a-f]{16}\.pdf$/.test(f))],
			[1, true, true, true]);
		const d = await detail(w, 1);
		check("T11 page 1 now reads OTHER_PERSON and its mark lapsed", [pageCodes(d), d.body?.pages?.[0]?.released], [["OTHER_PERSON", "OTHER_PERSON", "UNREADABLE"], false]);
		const again = await w.mine.runReceiptPagesSweep();
		check("T11 a second sweep changes nothing", [again && again.withdrawn, stored(w, id).equals(after)], [0, true]);
		w.cleanup();
	}

	section("T12 a changed receipt file loses its marks");
	{
		const w = world();
		const { id } = await statementInvoice(w);
		putPdf(w, 1, statement({ page1Extra: ["REISSUED"] }));
		const sweep = await w.mine.runReceiptPagesSweep();
		const after = id ? stored(w, id) : Buffer.alloc(0);
		check("T12 the invoice holding the old file's pages is rebuilt: none of its pages left, the office notice in their place",
			[sweep && sweep.withdrawn, await has(after, "MARKER-P1-7c41"), await has(after, "MARKER-P3-2b88"), await has(after, "kept by the office")], [1, false, false, true]);
		const d = await detail(w, 1);
		check("T12 the new file's pages carry no mark", d.body?.pages?.map((p) => [p.mark, p.released]), [["", false], ["", false], ["", false]]);
		w.cleanup();
	}

	section("T14 the invoice PDF stays the invoice driver's");
	{
		const w = world();
		const { id } = await statementInvoice(w);
		const r = [];
		for (const as of ["dispatcher", "investor", "driverB"]) r.push((await w.call("GET", `/api/invoices/${id}/pdf`, { as })).status);
		check("T14 Dispatcher, Investor and another driver: 403", r, [403, 403, 403]);
		w.cleanup();
	}

	section("T15 a font the reader cannot map is never read as \"names no one\"");
	{
		const w = world();
		putPdf(w, 1, receiptPdf([[{ unmapped: "PILOT #123" }, { unmapped: "10/12/2026 TOTAL $200.00" }, { unmapped: "CARDHOLDER CASEY RIVERA" }]]));
		await markPersonal(w, 1);
		const d = await detail(w, 1);
		check("T15 every line in a Type0 font with no ToUnicode map: UNREADABLE", pageCodes(d), ["UNREADABLE"]);
		const g = await w.generate(DRIVER_A);
		const file = g.body && g.body.invoice ? stored(w, g.body.invoice.id) : Buffer.alloc(0);
		check("T15 the invoice says \"PDF receipt on file\" and carries none of its glyphs",
			[notes(lastRender(w).data), await has(file, glyphHex("CARDHOLDER").slice(1, 21))], [[NOTE_PDF], false]);
		w.cleanup();

		const x = world();
		putPdf(x, 1, receiptPdf([["PILOT #123", "10/12/2026", "TOTAL $200.00", { unmapped: "CASEY RIVERA" }]]));
		await markPersonal(x, 1);
		const d2 = await detail(x, 1);
		check("T15 the amount and date mapped, one line in the unmappable font: UNREADABLE", pageCodes(d2), ["UNREADABLE"]);
		x.cleanup();

		const y = world();
		putPdf(y, 1, singlePage());
		await markPersonal(y, 1);
		const d3 = await detail(y, 1);
		const g3 = await y.generate(DRIVER_A);
		check("T15 the same receipt all in a mapped font: AUTO_RELEASED, copied with no mark",
			[pageCodes(d3), notes(lastRender(y).data), g3.body && g3.body.invoice ? await has(stored(y, g3.body.invoice.id), "MARKER-S1-55aa") : false],
			[["AUTO_RELEASED"], ["Receipt 1 of 1, attached after this invoice"], true]);
		y.cleanup();
	}

	for (const kind of ["Approved", "closed month"]) {
		section(`T16 the pages-only path on an ${kind === "Approved" ? "Approved invoice" : "invoice whose week is in a closed month"}`);
		const w = world();
		const { id } = await statementInvoice(w);
		w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(id);
		if (kind === "closed month") {
			w.db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-10', 'locked', '2026-10-20T04:00:00.000Z', 'test')").run();
		}
		const rowBefore = JSON.stringify(w.invoice(id));
		const fileBefore = stored(w, id);
		const split0 = await splitPages(fileBefore);
		const renders0 = renderCount(w);
		w.db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_percentage, pay_daily) VALUES ('Casey Rivera', '', 'fixed', 0, 250)").run();
		const sweep = await w.mine.runReceiptPagesSweep();
		const fileAfter = stored(w, id);
		const split1 = await splitPages(fileAfter);
		check(`T16 ${kind}: the pages-only path ran once`, [sweep && sweep.withdrawn, sweep && sweep.invoices], [1, [id]]);
		check(`T16 ${kind}: the invoice pages keep their count and their text exactly`,
			[split1.invoice.length === split0.invoice.length && split0.invoice.length > 0, JSON.stringify(split1.invoice) === JSON.stringify(split0.invoice)], [true, true]);
		check(`T16 ${kind}: page 1's marker gone, page 3's kept, the receipt pages rebuilt at the end`,
			[await has(fileAfter, "MARKER-P1-7c41"), await has(fileAfter, "MARKER-P3-2b88"), split1.receipt.length, split1.receipt.every((i) => i >= split1.texts.length - split1.receipt.length)],
			[false, true, 1, true]);
		check(`T16 ${kind}: the invoices row is unchanged (figures, lines, number, status)`, JSON.stringify(w.invoice(id)) === rowBefore, true);
		const rows = audits(w, "invoice_receipt_pages").filter((r) => Number(r.entity_id) === id);
		check(`T16 ${kind}: one audit row`, rows.length, 1);
		const keptDir = path.join(w.dataDir, "storage", "invoice-pdf-originals");
		const kept = fs.existsSync(keptDir) ? fs.readdirSync(keptDir) : [];
		check(`T16 ${kind}: the original PDF kept, byte for byte, outside uploads/ (a staff-only record)`,
			[kept.length, kept.length ? sha(fs.readFileSync(path.join(keptDir, kept[0]))) === sha(fileBefore) : false], [1, true]);
		check(`T16 ${kind}: a render record for the new file`, renderCount(w), renders0 + 1);

		const rel = await markPage(w, 1, 1, { mark: "released", reason: "checked_receipt", releaseAnyway: ["OTHER_PERSON"] });
		const sweep2 = await w.mine.runReceiptPagesSweep();
		check(`T16 ${kind}: a release changes nothing until "Update invoice PDF"`, [rel.status, sweep2 && sweep2.withdrawn, stored(w, id).equals(fileAfter)], [200, 0, true]);
		const up = await updatePdf(w, id);
		const fileUp = stored(w, id);
		const split2 = await splitPages(fileUp);
		check(`T16 ${kind}: "Update invoice PDF" puts page 1 back through the same path`,
			[up.status, up.body && up.body.added, await has(fileUp, "MARKER-P1-7c41"), await has(fileUp, "MARKER-P3-2b88")], [200, 1, true, true]);
		check(`T16 ${kind}: same invariants after the update (invoice pages, invoices row, one more audit row)`,
			[JSON.stringify(split2.invoice) === JSON.stringify(split0.invoice), JSON.stringify(w.invoice(id)) === rowBefore,
				audits(w, "invoice_receipt_pages").filter((r) => Number(r.entity_id) === id).length], [true, true, 2]);
		const none = await updatePdf(w, id);
		check(`T16 ${kind}: pressed again, nothing to change`, [none.status, none.body && none.body.changed], [200, false]);
		w.cleanup();
	}

	section("T17 (rule D) an invoice drawn before any of its receipt's pages was released");
	{
		const w = world();
		putPdf(w, 1, receiptPdf([
			["FLEET TOLL STATEMENT", "MARKER-D1-3a9c", "ACCOUNT HOLDER TEST DRIVER A", "10/12/2026 PILOT #123 $200.00", "10/13/2026 PLAZA 4 $4.50"],
			["MARKER-D2-6e1b", "10/14/2026 PLAZA 2 $3.00", "10/15/2026 PLAZA 2 $3.00", "STATEMENT TOTAL $207.50"],
		]));
		await markPersonal(w, 1);
		const g = await w.generate(DRIVER_A);
		const id = g.body && g.body.invoice ? g.body.invoice.id : 0;
		check("T17 drawn before any mark: \"PDF receipt on file\", no page copied, and a render record for the file all the same",
			[notes(lastRender(w).data), renderCount(w)], [[NOTE_PDF], 1]);
		if (id) w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(id);
		const rowBefore = id ? JSON.stringify(w.invoice(id)) : "";
		const fileBefore = id ? stored(w, id) : Buffer.alloc(0);
		const split0 = await splitPages(fileBefore);
		for (const p of [1, 2]) await markPage(w, 1, p, { mark: "released", reason: "only_his_lines" });
		const d = await detail(w, 1);
		check("T17 both pages released: the panel lists the invoice, none of the pages in its PDF, ready to update",
			((d.body && d.body.invoices) || []).map((i) => [i.id, i.pages_in_pdf, i.can_update]), [[id, [], true]]);
		const up = id ? await updatePdf(w, id) : { status: 0 };
		const fileUp = id ? stored(w, id) : Buffer.alloc(0);
		const split1 = await splitPages(fileUp);
		check("T17 \"Update invoice PDF\" adds both pages",
			[up.status, up.body && up.body.added, await has(fileUp, "MARKER-D1-3a9c"), await has(fileUp, "MARKER-D2-6e1b")], [200, 2, true, true]);
		check("T17 the invoice pages read exactly as before, and the two pages come after them, at the end",
			[split0.receipt.length, split0.texts.length > 0 && JSON.stringify(split1.invoice) === JSON.stringify(split0.texts), split1.receipt], [0, true, [split0.texts.length, split0.texts.length + 1]]);
		check("T17 the invoices row is unchanged, and one audit row",
			[id ? JSON.stringify(w.invoice(id)) === rowBefore : false, audits(w, "invoice_receipt_pages").filter((r) => Number(r.entity_id) === id).length], [true, 1]);
		const again = id ? await updatePdf(w, id) : { status: 0 };
		const sweep = await w.mine.runReceiptPagesSweep();
		check("T17 pressed again, nothing to change; a sweep changes nothing",
			[again.status, again.body && again.body.changed, sweep && sweep.withdrawn, id ? stored(w, id).equals(fileUp) : false], [200, false, 0, true]);
		const off = await markPage(w, 1, 2, { mark: "office", reason: "other" });
		const fileOff = id ? stored(w, id) : Buffer.alloc(0);
		const split2 = await splitPages(fileOff);
		check("T17 page 2 marked \"office only\": it leaves the end at once, page 1 stays, the invoice pages as before",
			[off.status, await has(fileOff, "MARKER-D2-6e1b"), await has(fileOff, "MARKER-D1-3a9c"), JSON.stringify(split2.invoice) === JSON.stringify(split0.texts)], [200, false, true, true]);
		check("T17 the mark's answer names the invoice the page left, and none refused",
			off.body && off.body.withdrawal, { withdrawn: [id], refused: [] });
		w.cleanup();
	}

	section("T18 an \"office only\" withdrawal that is refused is answered as refused, every time");
	{
		const w = world();
		putPdf(w, 1, singlePage());
		await markPersonal(w, 1);
		const d = await detail(w, 1);
		const g = await w.generate(DRIVER_A);
		const id = g.body && g.body.invoice ? g.body.invoice.id : 0;
		const number = id ? w.invoice(id).invoice_number || "" : "";
		const fileBefore = id ? stored(w, id) : Buffer.alloc(0);
		const split0 = await splitPages(fileBefore);
		check("T18 first: the one-page receipt AUTO_RELEASED, copied into the stored invoice, which has a number",
			[pageCodes(d), await has(fileBefore, "MARKER-S1-55aa"), number !== "", split0.receipt.length], [["AUTO_RELEASED"], true, true, 1]);
		const svc = w.mine.receiptPdfService();
		const real = svc.invoiceTexts;
		// The invoice text read refuses (the form cap), as it can on a real Chrome invoice.
		svc.invoiceTexts = async () => ({ status: "failed", reason: "form_depth" });
		const alerts = () => w.db.prepare("SELECT COUNT(*) AS n FROM dispatch_notifications WHERE type = 'receipt-pages'").get().n;
		const refusedRows = () => audits(w, "invoice_receipt_pages_refused").filter((r) => Number(r.entity_id) === id).length;
		const office = () => markPage(w, 1, 1, { mark: "office", reason: "checked_receipt" });
		const listed = (r) => ((r.body && r.body.invoices) || []).map((i) => [i.id, i.pages_in_pdf]);
		const refusal = { withdrawn: [], refused: [{ id, invoice_number: number, code: "TEXT_UNREADABLE" }] };
		const first = await office();
		check("T18 the mark answers 200 and names the refused invoice and its code under `withdrawal`",
			[first.status, first.body && first.body.withdrawal], [200, refusal]);
		check("T18 `invoices` is still the page view's list: the invoice, page 1 still in its PDF",
			listed(first), [[id, [1]]]);
		check("T18 the stored file as it was; one refusal audit row and one alert",
			[stored(w, id).equals(fileBefore), refusedRows(), alerts()], [true, 1, 1]);
		const second = await office();
		check("T18 the same refusal again (same file, same code): answered as refused all the same, its audit row and alert not repeated",
			[second.status, second.body && second.body.withdrawal, listed(second), refusedRows(), alerts(), stored(w, id).equals(fileBefore)],
			[200, refusal, [[id, [1]]], 1, 1, true]);
		svc.invoiceTexts = real;
		const third = await office();
		const fileAfter = stored(w, id);
		const split1 = await splitPages(fileAfter);
		check("T18 with the read working, the next mark takes the page out and says so",
			[third.status, third.body && third.body.withdrawal, listed(third)], [200, { withdrawn: [id], refused: [] }, [[id, []]]]);
		check("T18 the page left the stored invoice, the invoice pages read as before, and the notice in its place names a receipt",
			[await has(fileAfter, "MARKER-S1-55aa"), JSON.stringify(split1.invoice) === JSON.stringify(split0.invoice), split1.receipt.length,
				await has(fileAfter, "1 page of this receipt is kept by the office"), await has(fileAfter, "of this statement")],
			[false, true, 1, true, false]);
		w.cleanup();
	}

	section("races: a page that stops being released while the pages-only path runs is never written");
	{
		const w = world();
		putPdf(w, 1, statement());
		await markPersonal(w, 1);
		await detail(w, 1);
		await markPage(w, 1, 3, { mark: "released", reason: "only_his_lines" });
		const g = await w.generate(DRIVER_A);
		const id = g.body && g.body.invoice ? g.body.invoice.id : 0;
		const before = id ? stored(w, id) : Buffer.alloc(0);
		check("race (update): first, page 3 alone in the stored invoice", [await has(before, "MARKER-P1-7c41"), await has(before, "MARKER-P3-2b88")], [false, true]);
		await markPage(w, 1, 1, { mark: "released", reason: "only_his_lines" });
		const svc = w.mine.receiptPdfService();
		const real = svc.rebuild;
		let landed = 0;
		// A driver whose name is on page 1 joins the roster while the child rebuilds.
		svc.rebuild = async (pdf, plan) => {
			if (!landed++) addRosterName(w, "Casey Rivera");
			return real.call(svc, pdf, plan);
		};
		const up = id ? await updatePdf(w, id) : { status: 0 };
		svc.rebuild = real;
		const after = id ? stored(w, id) : Buffer.alloc(0);
		check("race (update): \"Update invoice PDF\" writes no page withheld while it ran: page 1 not in the stored invoice, the file as it was",
			[landed > 0, await has(after, "MARKER-P1-7c41"), after.equals(before), up.status === 200 && Boolean(up.body && up.body.added)], [true, false, true, false]);
		const d = await detail(w, 1);
		check("race (update): page 1 reads OTHER_PERSON now, its mark lapsed", [d.body?.pages?.[0]?.code, d.body?.pages?.[0]?.released], ["OTHER_PERSON", false]);
		w.cleanup();
	}
	{
		const w = world();
		const { id } = await statementInvoice(w);
		const before = id ? stored(w, id) : Buffer.alloc(0);
		check("race (sweep): first, pages 1 and 3 in the stored invoice", [await has(before, "MARKER-P1-7c41"), await has(before, "MARKER-P3-2b88")], [true, true]);
		// Page 3 "office only", written straight to its row so that the sweep takes it out.
		w.db.prepare("UPDATE receipt_pdf_pages SET mark = 'office' WHERE expense_id = 1 AND page = 3").run();
		const svc = w.mine.receiptPdfService();
		const real = svc.rebuild;
		let landed = 0;
		svc.rebuild = async (pdf, plan) => {
			if (!landed++) addRosterName(w, "Casey Rivera");
			return real.call(svc, pdf, plan);
		};
		await w.mine.runReceiptPagesSweep();
		svc.rebuild = real;
		const after = id ? stored(w, id) : Buffer.alloc(0);
		check("race (sweep): the rebuild taking page 3 out writes no page withheld while it ran: neither page 1 nor page 3 in the stored invoice",
			[landed > 0, await has(after, "MARKER-P1-7c41"), await has(after, "MARKER-P3-2b88")], [true, false, false]);
		w.cleanup();
	}

	section("an unverifiable receipt is withdrawn once, then left alone (4 sweeps)");
	{
		const twoPages = () => receiptPdf([
			["FLEET TOLL STATEMENT", "MARKER-L1-4d2e", "10/12/2026 PILOT #123 $200.00", "10/13/2026 PLAZA 4 $4.50"],
			["MARKER-L2-8b1f", "10/14/2026 PLAZA 2 $3.00", "10/15/2026 PLAZA 2 $3.00"],
		]);
		const variants = [
			["its file gone from disk", (w) => fs.rmSync(path.join(w.dataDir, "uploads", "expense-receipts", receiptFile(1)), { force: true })],
			["an image now", (w) => w.db.prepare("UPDATE expenses SET photo_data = ? WHERE id = 1").run(`/uploads/expense-receipts/${receiptFile(1).replace(/\.pdf$/, ".jpg")}`)],
			["another driver's expense now", (w) => w.db.prepare("UPDATE expenses SET driver = ? WHERE id = 1").run("Test Driver B")],
			["a reader that keeps failing after a roster change", (w) => {
				w.mine.receiptPdfService().pageTexts = async () => ({ status: "on_file", reason: "timeout" });
				addRosterName(w, "Avery Stone");
			}],
		];
		for (const [label, breakIt] of variants) {
			const w = world();
			putPdf(w, 1, twoPages());
			await markPersonal(w, 1);
			await detail(w, 1);
			await markPage(w, 1, 1, { mark: "released", reason: "only_his_lines" });
			const g = await w.generate(DRIVER_A);
			const id = g.body && g.body.invoice ? g.body.invoice.id : 0;
			if (id) w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(id);
			const keptDir = path.join(w.dataDir, "storage", "invoice-pdf-originals");
			const state = () => ({
				file: id ? sha(stored(w, id)) : "",
				originals: fs.existsSync(keptDir) ? fs.readdirSync(keptDir).length : 0,
				renders: renderCount(w),
				audits: audits(w, "invoice_receipt_pages").length,
			});
			const start = state();
			const held = id ? await has(stored(w, id), "MARKER-L1-4d2e") : false;
			breakIt(w);
			const withdrawn = [];
			const states = [];
			for (let i = 0; i < 4; i++) {
				const s = await w.mine.runReceiptPagesSweep();
				withdrawn.push(s && s.withdrawn);
				states.push(state());
			}
			check(`loop (${label}): first page 1 in the stored invoice; 4 sweeps take it out once`,
				[held, withdrawn, id ? await has(stored(w, id), "MARKER-L1-4d2e") : true], [true, [1, 0, 0, 0], false]);
			check(`loop (${label}): after the first, no more kept copies, render records or audit rows, and the file stays the same`,
				[states[0].originals - start.originals, states[3].originals - states[0].originals, states[3].renders - states[0].renders, states[3].audits - states[0].audits, states[3].file === states[0].file],
				[1, 0, 0, 0, true]);
			w.cleanup();
		}
	}

	section("the 15-page cap holds for \"Update invoice PDF\"");
	{
		const w = world();
		const six = (eid) => receiptPdf(Array.from({ length: 6 }, (_, p) => [`MARKER-R${eid}-P${p + 1}`, "FLEET TOLL STATEMENT"]));
		for (const eid of [1, 5, 2]) {
			putPdf(w, eid, six(eid));
			await markPersonal(w, eid);
			for (const p of [1, 2]) await markPage(w, eid, p, { mark: "released", reason: "only_his_lines" });
		}
		const g = await w.generate(DRIVER_A);
		const id = g.body && g.body.invoice ? g.body.invoice.id : 0;
		const before = id ? stored(w, id) : Buffer.alloc(0);
		check("cap: first, two pages of each of three statements in the stored invoice (6 copied pages)", (await splitPages(before)).receipt.length, 6);
		for (const eid of [1, 5, 2]) for (const p of [3, 4, 5, 6]) await markPage(w, eid, p, { mark: "released", reason: "only_his_lines" });
		const up = id ? await updatePdf(w, id) : { status: 0 };
		check("cap: every page released, 18 would cross the 15-page cap: refused (409 PAGE_CAP), the stored file as it was",
			[up.status, up.body && up.body.code, id ? stored(w, id).equals(before) : false], [409, "PAGE_CAP", true]);
		w.cleanup();
	}

	section("the locked-invoice text check, on its own (lib/receipt-page-privacy.js invoicePagesUnchanged)");
	{
		let lib = null;
		try { lib = require(path.join(__dirname, "..", "lib", "receipt-page-privacy.js")); } catch { lib = null; }
		const same = (before, after) => (lib && typeof lib.invoicePagesUnchanged === "function" ? lib.invoicePagesUnchanged(before, after) : { missing: true });
		const page = (text, extra = {}) => ({ text, unmapped: false, truncated: false, ...extra });
		const before = { texts: [page("INVOICE"), page("SHEET receipt-1"), page("Receipt 1 of 1 - page 1 of 2"), page("Receipt 1 of 1 - page 2 of 2")], receipt: [2, 3] };
		check("the same invoice pages with other receipt pages: unchanged",
			same(before, { texts: [page("INVOICE"), page("SHEET receipt-1"), page("Receipt 1 of 1 - page 1 of 1 - 1 page of this statement is kept by the office")], receipt: [2] }), { ok: true });
		check("an amount changed on an invoice page: TEXT_MISMATCH, naming the page",
			same(before, { texts: [page("INVOICE TOTAL DUE 1.00"), page("SHEET receipt-1"), page("x")], receipt: [2] }), { ok: false, code: "TEXT_MISMATCH", page: 1 });
		check("an invoice page lost, or one read only in part, or a font now unmapped: refused",
			[same(before, { texts: [page("INVOICE"), page("x")], receipt: [1] }).code, same(before, { texts: [page("INVOICE", { truncated: true }), page("SHEET receipt-1")], receipt: [] }).code,
				same(before, { texts: [page("INVOICE", { unmapped: true }), page("SHEET receipt-1")], receipt: [] }).code],
			["PAGE_COUNT", "TEXT_UNREADABLE", "TEXT_MISMATCH"]);
		check("no invoice page at all: refused", same({ texts: [page("x")], receipt: [0] }, { texts: [page("y")], receipt: [0] }).code, "NO_INVOICE_PAGES");
	}

	for (const kind of ["Approved", "closed month"]) {
	section(`the locked-invoice text check on an ${kind === "Approved" ? "Approved invoice" : "invoice whose week is in a closed month"}`);
	{
		const emits = [];
		const w = world(ON, { io: recorderIo(emits) });
		const { id } = await statementInvoice(w);
		w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(id);
		if (kind === "closed month") {
			w.db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-10', 'locked', '2026-10-20T04:00:00.000Z', 'test')").run();
		}
		const svc = w.mine.receiptPdfService();
		const real = svc && svc.rebuild;
		if (typeof real === "function") {
			// A rebuild that also writes on an invoice page: the check must catch it.
			svc.rebuild = async (pdf, plan) => {
				const r = await real.call(svc, pdf, plan);
				if (!r || r.status !== "rebuilt") return r;
				const { PDFDocument, StandardFonts } = require(path.join(__dirname, "..", "node_modules", "pdf-lib"));
				const doc = await PDFDocument.load(r.pdf, { updateMetadata: false });
				doc.getPage(0).drawText("TOTAL DUE 1.00", { x: 40, y: 600, size: 10, font: await doc.embedFont(StandardFonts.Helvetica) });
				return { ...r, pdf: Buffer.from(await doc.save({ useObjectStreams: false })) };
			};
		}
		const fileBefore = stored(w, id);
		const rendersBefore = renderCount(w);
		w.db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_percentage, pay_daily) VALUES ('Casey Rivera', '', 'fixed', 0, 250)").run();
		const sweep = await w.mine.runReceiptPagesSweep();
		const refused = audits(w, "invoice_receipt_pages_refused").filter((r) => Number(r.entity_id) === id);
		check(`the check (${kind}): a rebuild that changes an invoice page's text is refused, the stored file stays as it was, no render record`,
			[sweep && sweep.refused, stored(w, id).equals(fileBefore), renderCount(w) === rendersBefore && rendersBefore > 0], [1, true, true]);
		check(`the check (${kind}): the refusal is audited with its code, and alerted`,
			[refused.length, /TEXT_MISMATCH/.test(refused[0] && refused[0].details), w.db.prepare("SELECT COUNT(*) AS n FROM dispatch_notifications WHERE type = 'receipt-pages'").get().n],
			[1, true, 1]);
		const listed = (role) => {
			const scope = w.mine.noticeTypeScope({ role });
			return w.db.prepare(`SELECT COUNT(*) AS n FROM dispatch_notifications WHERE type = 'receipt-pages' AND ${scope.sql}`).get(...scope.params).n;
		};
		check(`the check (${kind}): the alert names the invoice, so only Super Admins get it: a Dispatcher's notice list leaves it out, and it is sent live to the super-admin room only`,
			[listed("Super Admin"), listed("Dispatcher"), emits.filter((e) => e.event === "dispatch-notification").map((e) => e.room)], [1, 0, ["super-admin"]]);
		if (real) svc.rebuild = real;
		const retry = await w.mine.runReceiptPagesSweep();
		check(`the check (${kind}): with an honest rebuild the next sweep withdraws the page`, [retry && retry.withdrawn, await has(stored(w, id), "MARKER-P1-7c41")], [1, false]);
		w.cleanup();
	}
	}

	section("off: RECEIPT_PDF_PAGES_ENABLED unset");
	{
		const w = world(OFF);
		putPdf(w, 1, statement());
		const m = await markPersonal(w, 1);
		const d = await detail(w, 1);
		const p = await markPage(w, 1, 1, { mark: "released", reason: "only_his_lines" });
		check("off: the detail and the mark answer 404 FEATURE_OFF", [d.status, d.body && d.body.code, p.status, p.body && p.body.code], [404, "FEATURE_OFF", 404, "FEATURE_OFF"]);
		let rows = -1;
		try { rows = w.db.prepare("SELECT COUNT(*) AS n FROM receipt_pdf_pages").get().n; } catch { rows = -1; }
		check("off: marking the receipt Personal computes no verdict and answers no page counts", [m.status, rows, m.body && "receipt_pages" in m.body], [201, 0, false]);
		const g = await w.generate(DRIVER_A);
		check("off: the invoice is v1 (\"PDF receipt on file\")", [g.status, notes(lastRender(w).data)], [200, [NOTE_PDF]]);
		w.cleanup();
	}

	fs.rmSync(TMP, { recursive: true, force: true });
	finish();
})().catch((e) => { console.error(e && e.stack || e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } process.exit(1); });
