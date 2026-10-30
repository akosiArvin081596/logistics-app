"use strict";
// Receipts on a weekly invoice's Personal lines (v1). Pure: no fs, DB or network.
//
// receiptLayout() decides what each Personal line says about its receipt and
// which receipt sheets follow the invoice, from the lines lib/personal-expense.js
// lineEntries() prints, the expense_personal rows behind them, and what
// lib/receipt-images.js and lib/receipt-pdf.js prepared for each expense:
//   an image   "Receipt 1 of 2, attached after this invoice", linked to its sheet
//              (the image is on the sheet)
//   a PDF      the same, when its pages were prepared (R3 v2, status
//              "pdf_pages"): its sheet says how many of its pages follow, and
//              the server inserts them after the sheet (lib/receipt-pdf.js merge());
//              otherwise "PDF receipt on file" (the app links Super Admin to it)
//   nothing    "Receipt image not available" (missing, unreadable, not ready)
// At most RECEIPT_SHEETS_MAX sheets, images and PDFs together, in print order;
// a later line says "More receipts on file: open this receipt in the app". One
// receipt on two lines (a mark and its reversal) gets one sheet. Share lines
// carry no receipt note.
//
// safeReceiptImage() is the one gate for a sheet's image: only a JPEG data URI
// within the byte cap (the re-encode's output) ever reaches a page.

const { formatMoney } = require("./personal-expense");

const RECEIPT_SHEETS_MAX = 10;
// The sheet cap's older name (v1 had image sheets only).
const RECEIPT_PAGES_MAX = RECEIPT_SHEETS_MAX;
// A PDF receipt's pages after its sheet: at most lib/receipt-pdf.js
// RECEIPT_PDF_MAX_PAGES (kept equal by scripts/test-receipt-pdf-invoice.js).
const RECEIPT_PDF_SHEET_PAGES_MAX = 6;
// "receipt-N" for N from 1 to RECEIPT_SHEETS_MAX: a sheet's anchor, and the
// target of its line's link.
function isReceiptAnchor(value) {
	const m = /^receipt-([1-9][0-9]{0,2})$/.exec(String(value || ""));
	return !!m && Number(m[1]) <= RECEIPT_SHEETS_MAX;
}
// Pages of a PDF receipt not released to the driver (driver privacy) are left
// out; the sheet says how many: "N pages of this statement are kept by the office."
const officeLine = (n) => `${n} ${n === 1 ? "page" : "pages"} of this statement ${n === 1 ? "is" : "are"} kept by the office.`;
function pdfPagesNote(n, withheld = 0) {
	const follows = n === 1 ? "The receipt's page follows this page" : `The receipt's ${n} pages follow this page`;
	return Number.isInteger(withheld) && withheld > 0 ? `${follows}. ${officeLine(withheld)}` : follows;
}
const RECEIPT_IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
const RECEIPT_JPEG_PREFIX = "data:image/jpeg;base64,";
// The longest base64 data URI that can decode to RECEIPT_IMAGE_MAX_BYTES, with
// its prefix and room to spare. Anything longer is refused before it is read.
const RECEIPT_IMAGE_DATA_URI_MAX_LENGTH = Math.ceil(RECEIPT_IMAGE_MAX_BYTES / 3) * 4 + 64;
const BASE64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const NOTE_PDF = "PDF receipt on file";
const NOTE_UNAVAILABLE = "Receipt image not available";
const NOTE_OVER_CAP = "More receipts on file: open this receipt in the app";
const RECEIPT_KINDS = new Set(["personal", "personal_reversed"]);

function safeReceiptImage(value) {
	if (typeof value !== "string") return null;
	if (value.length > RECEIPT_IMAGE_DATA_URI_MAX_LENGTH) return null;
	if (!value.startsWith(RECEIPT_JPEG_PREFIX)) return null;
	return BASE64_BODY_RE.test(value.slice(RECEIPT_JPEG_PREFIX.length)) ? value : null;
}

// entries: lineEntries() output, in print order. rows: the expense_personal rows
// ({ id, expense_id }). prepared: Map expenseId -> { status: "image", dataUri }
// | { status: "pdf_pages", pages, withheld } (a PDF receipt whose released pages
// were prepared; withheld: how many of its pages are kept by the office)
// | { status: "pdf" } | { status: "unavailable" } | { status: "over_cap" } (a
// receipt past the sheet cap, which the caller need not prepare).
// Returns { entries, pages, inserts }: each entry copied with receiptNote,
// receiptHref ("#receipt-N" or "") and receiptExpenseId (receipt lines only);
// one sheet per attached receipt: { anchor: "receipt-N", header, image } for an
// image, { anchor, header, pdfPages, note } for a PDF; and for each PDF sheet
// { expenseId, anchor, index: N, total: M, pages }, where its pages go.
function receiptLayout(entries, rows, prepared) {
	const expenseOfRow = new Map((rows || []).map((r) => [Number(r.id), Number(r.expense_id)]));
	const ready = prepared instanceof Map ? prepared : new Map();
	const pageOfExpense = new Map();
	const pages = [];
	const out = (entries || []).map((e) => {
		const copy = { ...e, receiptNote: "", receiptHref: "" };
		if (!RECEIPT_KINDS.has(e.kind)) return copy;
		const expenseId = expenseOfRow.get(Number(e.rowId));
		if (!(expenseId > 0)) {
			copy.receiptNote = NOTE_UNAVAILABLE;
			return copy;
		}
		copy.receiptExpenseId = expenseId;
		const p = ready.get(expenseId);
		const image = p && p.status === "image" ? safeReceiptImage(p.dataUri) : null;
		const pdfPages = p && p.status === "pdf_pages" && Number.isInteger(p.pages) && p.pages >= 1 && p.pages <= RECEIPT_PDF_SHEET_PAGES_MAX ? p.pages : 0;
		if (pageOfExpense.has(expenseId)) {
			copy.receiptPage = pageOfExpense.get(expenseId);
		} else if (p && (p.status === "pdf" || (p.status === "pdf_pages" && !pdfPages))) {
			copy.receiptNote = NOTE_PDF;
		} else if (p && p.status === "over_cap") {
			copy.receiptNote = NOTE_OVER_CAP;
		} else if (!image && !pdfPages) {
			copy.receiptNote = NOTE_UNAVAILABLE;
		} else if (pages.length < RECEIPT_SHEETS_MAX) {
			const withheld = pdfPages && Number.isInteger(p.withheld) && p.withheld > 0 ? p.withheld : 0;
			pages.push({ expenseId, label: e.label, cents: Number(e.cents) || 0, image, pdfPages, withheld });
			pageOfExpense.set(expenseId, pages.length);
			copy.receiptPage = pages.length;
		} else {
			// Past the cap: an image can be opened in the app; a PDF keeps its own note.
			copy.receiptNote = pdfPages ? NOTE_PDF : NOTE_OVER_CAP;
		}
		return copy;
	});
	const total = pages.length;
	for (const e of out) {
		if (!e.receiptPage) continue;
		e.receiptNote = `Receipt ${e.receiptPage} of ${total}, attached after this invoice`;
		e.receiptHref = `#receipt-${e.receiptPage}`;
		delete e.receiptPage;
	}
	const header = (p, i) => `Receipt ${i + 1} of ${total} - ${p.label} - ${p.cents < 0 ? "deducted" : "credited"} ${formatMoney(p.cents)}`;
	return {
		entries: out,
		pages: pages.map((p, i) => (p.image
			? { anchor: `receipt-${i + 1}`, header: header(p, i), image: p.image }
			: { anchor: `receipt-${i + 1}`, header: header(p, i), pdfPages: p.pdfPages, note: pdfPagesNote(p.pdfPages, p.withheld) })),
		inserts: pages.map((p, i) => (p.image ? null : { expenseId: p.expenseId, anchor: `receipt-${i + 1}`, index: i + 1, total, pages: p.pdfPages }))
			.filter(Boolean),
	};
}

module.exports = {
	RECEIPT_SHEETS_MAX,
	RECEIPT_PDF_SHEET_PAGES_MAX,
	RECEIPT_PAGES_MAX,
	isReceiptAnchor,
	pdfPagesNote,
	RECEIPT_IMAGE_MAX_BYTES,
	RECEIPT_IMAGE_DATA_URI_MAX_LENGTH,
	NOTE_PDF,
	NOTE_UNAVAILABLE,
	NOTE_OVER_CAP,
	safeReceiptImage,
	receiptLayout,
};
