// The invoice of a factored load: the page lib/broker-invoice.js prints, with the
// factor's assignment lines in the one place its bank block goes.
//
// The swap is made on that page's finished HTML rather than inside it, because
// lib/broker-invoice.js is one of the hashed statement templates
// (lib/statement-template-hash.js): a byte changed there re-issues every stored payout
// statement. An invoice that isn't factored passes through untouched.
//
// Fail closed: a page this can't place the lines on, or one still holding a bank detail
// once they're placed (typed in any case or spacing, or a moved layout), throws and is
// never printed. Free words it can't know ("remit to our account") stay a person's to read.
// Pure: no network, database or files.

"use strict";

const OPEN = '<div class="payment">';
const AFTER = '<div class="thanks">';
// As fold() leaves them.
const BANK_WORDS = Object.freeze(["payment method", "bank name", "bank routing", "bank account"]);
// The block's own values. Not its name or e-mail: the seller block prints those too.
const BANK_SLOT_RE = /<strong>(?:Bank Name|Address|Bank Routing #|Bank Account #):<\/strong> ([^<]*)<\/div>/g;
const BANK_SLOTS = 4;

const NOT_PRINTABLE = "ASSIGNMENT_NOT_PRINTABLE";
const NOT_PRINTABLE_WORDS = "This load is factored, and Triumph's assignment can't be printed on this invoice because its notes or names hold bank details, so nothing was made. Take them out, then try again.";

// lib/broker-invoice.js's own escape, which it doesn't export.
function esc(s) {
	return String(s == null ? "" : s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
// One case and one spacing: a person types a bank detail however they like.
const fold = (s) => unesc(s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Each number as typed ("000-111-222", "333 444 5556"), read as lib/chr-events.js createRedactor() reads one.
const numbersIn = (s) => (unesc(s).normalize("NFKC").match(/\p{N}(?:[^\p{L}\p{N}]{0,8}\p{N}){0,2000}/gu) || []).map((run) => run.replace(/\D/g, ""));
const isNumber = (v) => /\p{N}/u.test(v) && !/\p{L}/u.test(v);

// Does the page, its block gone, still hold a bank detail? Each element's words on their
// own, from the body down, so the stylesheet's words don't count and two fields' digits
// don't read as one number.
function holdsBankDetail(rest, slots) {
	const pieces = rest.slice(Math.max(rest.indexOf("<body"), 0)).split(/<[^>]*>/);
	const numbers = slots.filter(isNumber).map((v) => v.replace(/\D/g, ""));
	const phrases = [...BANK_WORDS, ...slots.filter((v) => !isNumber(v)).map(fold).filter(Boolean)];
	return pieces.some((piece) => {
		const words = fold(piece);
		return phrases.some((p) => words.includes(p)) || numbersIn(piece).some((run) => numbers.some((n) => run.includes(n)));
	});
}

const notPrintable = () => Object.assign(new Error(NOT_PRINTABLE_WORDS), { code: NOT_PRINTABLE, http: 409 });
const once = (html, needle) => {
	const at = html.indexOf(needle);
	return at >= 0 && html.indexOf(needle, at + 1) < 0 ? at : -1;
};

// pre-wrap so a run of spaces inside a line prints as written: the lines are word for
// word, and HTML would otherwise collapse the two before a ZIP.
function blockHtml(lines) {
	const rows = lines.map((line) => `\t\t<div style="white-space: pre-wrap; font-size: 12px; font-weight: 700; color: #1f2937;">${esc(line)}</div>`);
	return `<div class="payment" style="break-inside: avoid;">\n${rows.join("\n")}\n\t</div>\n\n\t`;
}

// `html` as buildInvoiceHtml() made it. `assignment` is null for a load that isn't
// factored, which answers the same string, or { lines }, which answers the page with the
// lines where the bank block was. Throws for anything else, and never answers a factored
// page with its bank block.
function withAssignment(html, assignment) {
	if (assignment === null || assignment === undefined) return html;
	const lines = assignment && assignment.lines;
	if (!Array.isArray(lines) || !lines.length || !lines.every((l) => typeof l === "string" && l.trim())) throw notPrintable();
	const start = once(html, OPEN);
	const end = once(html, AFTER);
	if (start < 0 || end <= start) throw notPrintable();
	const removed = html.slice(start, end);
	const slots = [...removed.matchAll(BANK_SLOT_RE)].map((m) => m[1]);
	if (slots.length !== BANK_SLOTS) throw notPrintable();
	const before = html.slice(0, start);
	const after = html.slice(end);
	if (holdsBankDetail(before + after, slots)) throw notPrintable();
	return before + blockHtml(lines) + after;
}

// withAssignment()'s refusal as an answer, or null: for a caller to find out before it
// spends an invoice number.
function printRefusal(html, assignment) {
	try {
		withAssignment(html, assignment);
		return null;
	} catch (e) {
		return { code: e.code || NOT_PRINTABLE, http: e.http || 409, error: e.message };
	}
}

module.exports = { withAssignment, printRefusal, NOT_PRINTABLE, NOT_PRINTABLE_WORDS };
