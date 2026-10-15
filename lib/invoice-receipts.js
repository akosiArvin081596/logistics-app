"use strict";
// Receipts on a weekly invoice's Personal lines (v1). Pure: no fs, DB or network.
//
// receiptLayout() decides what each Personal line says about its receipt and
// which receipt pages follow the invoice, from the lines lib/personal-expense.js
// lineEntries() prints, the expense_personal rows behind them, and what
// lib/receipt-images.js prepared for each expense:
//   an image   "Receipt 1 of 2, attached after this invoice", linked to its page
//   a PDF      "PDF receipt on file" (never rendered; the app links Super Admin to it)
//   nothing    "Receipt image not available" (missing, unreadable, not ready)
// At most RECEIPT_PAGES_MAX pages; a later image line says "More receipts on
// file: open this receipt in the app". One receipt on two lines (a mark and its
// reversal) gets one page. Share lines carry no receipt note.
//
// safeReceiptImage() is the one gate for a page's image: only a JPEG data URI
// within the byte cap (the re-encode's output) ever reaches a page.

const { formatMoney } = require("./personal-expense");

const RECEIPT_PAGES_MAX = 10;
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
// | { status: "pdf" } | { status: "unavailable" }.
// Returns { entries, pages }: each entry copied with receiptNote, receiptHref
// ("#receipt-N" or "") and receiptExpenseId (receipt lines only), and one page
// per image receipt: { anchor: "receipt-N", header, image }.
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
		if (p && p.status === "pdf") {
			copy.receiptNote = NOTE_PDF;
		} else if (!image) {
			copy.receiptNote = NOTE_UNAVAILABLE;
		} else if (pageOfExpense.has(expenseId)) {
			copy.receiptPage = pageOfExpense.get(expenseId);
		} else if (pages.length < RECEIPT_PAGES_MAX) {
			pages.push({ expenseId, label: e.label, cents: Number(e.cents) || 0, image });
			pageOfExpense.set(expenseId, pages.length);
			copy.receiptPage = pages.length;
		} else {
			copy.receiptNote = NOTE_OVER_CAP;
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
	return {
		entries: out,
		pages: pages.map((p, i) => ({
			anchor: `receipt-${i + 1}`,
			header: `Receipt ${i + 1} of ${total} - ${p.label} - ${p.cents < 0 ? "deducted" : "credited"} ${formatMoney(p.cents)}`,
			image: p.image,
		})),
	};
}

module.exports = {
	RECEIPT_PAGES_MAX,
	RECEIPT_IMAGE_MAX_BYTES,
	RECEIPT_IMAGE_DATA_URI_MAX_LENGTH,
	NOTE_PDF,
	NOTE_UNAVAILABLE,
	NOTE_OVER_CAP,
	safeReceiptImage,
	receiptLayout,
};
