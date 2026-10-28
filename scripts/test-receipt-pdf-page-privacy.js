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
 *       office line present. T9b: page 2's image never reaches the bytes through
 *       a resource dictionary the pages share
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
 *   the locked-invoice text check: a rebuild whose invoice pages' text differs
 *       is refused, logged and audited, and the stored file stays as it was
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
const { buildPrivacyWorld, receiptPdf, fakeChrome, streamTexts, pageTexts, glyphHex, CROSS_SITE } = require("./lib/receipt-privacy-world");
const { check, section, finish } = makeChecker();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-page-privacy-"));
const PROBES = { env: path.join(TMP, "env-probe.txt"), db: path.join(TMP, "db-probe.txt") };
fs.writeFileSync(PROBES.env, "MADE_UP=1\n");
fs.writeFileSync(PROBES.db, "made up\n");

const ON = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true", RECEIPT_PDF_PAGES_ENABLED: "true" };
const OFF = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: "true" };
const NOTE_PDF = "PDF receipt on file";

function world(env = ON) {
	return buildPrivacyWorld({
		env,
		receiptPdfProbes: PROBES,
		render: async (templateName, data, record) => { await record(templateName, data); return fakeChrome(templateName, data); },
	});
}

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
// of M - K pages of this statement ..."); every other page, the sheets
// included, is an invoice page.
async function splitPages(pdf) {
	const texts = await pageTexts(pdf);
	const receipt = texts.map((t, i) => (/(^|\|)Receipt \d+ of \d+ - (page \d+ of \d+|\d+ pages? of this statement)/.test(t) ? i : -1)).filter((i) => i >= 0);
	return { texts, receipt, invoice: texts.filter((_, i) => !receipt.includes(i)) };
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
		w.cleanup();

		const s = world();
		const r = await statementInvoice(s, { sharedImages: true });
		const f2 = r.id ? stored(s, r.id) : Buffer.alloc(0);
		check("T9b control: pages 1 and 3 drew their images (IMGMARK-P1, IMGMARK-P3 in the bytes)", [f2.includes("IMGMARK-P1"), f2.includes("IMGMARK-P3")], [true, true]);
		check("T9b page 2's image, listed in the resource dictionary every page shares, is not in the bytes", f2.includes("IMGMARK-P2"), false);
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

	section("the locked-invoice text check");
	{
		const w = world();
		const { id } = await statementInvoice(w);
		w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(id);
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
		check("the check: a rebuild that changes an invoice page's text is refused, the stored file stays as it was, no render record",
			[sweep && sweep.refused, stored(w, id).equals(fileBefore), renderCount(w) === rendersBefore && rendersBefore > 0], [1, true, true]);
		check("the check: the refusal is audited with its code", [refused.length, /TEXT_MISMATCH/.test(refused[0] && refused[0].details)], [1, true]);
		if (real) svc.rebuild = real;
		const retry = await w.mine.runReceiptPagesSweep();
		check("the check: with an honest rebuild the next sweep withdraws the page", [retry && retry.withdrawn, await has(stored(w, id), "MARKER-P1-7c41")], [1, false]);
		w.cleanup();
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
