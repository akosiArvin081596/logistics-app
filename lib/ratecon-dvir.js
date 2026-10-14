// What a rate con's own text says about DVIR deductions, and the line the re-issue
// hold alert (server.js alertRateConReissueHold()) adds for the person deciding.
//
// C.H. Robinson's post-delivery "Booked Load #" rate con can carry one charge line per
// missed inspection, "Missing Pre-Trip DVIR Inspection  1.00  -$35.00  -$35.00"
// (description, quantity, rate, amount). CHR deducts it when a load is checked in
// before the driver's pre-trip inspection, and keeps it or not depending on whether
// LogisX disputes it (decisions-log, 2026-10-13). Payment never changes from these
// emails (the re-issue hold keeps it as stored); this only words the alert.
//
//   pdfText(buffer, opts)             -> the text a PDF's pages show
//   readRateConDvir(text, byteLength) -> { readable, cents, count }
//   dvirAlertLine(reading, held)      -> the alert line, or ""
//   MAX_PDF_BYTES                     -> a larger PDF is not read (kpi-weight's limit)
//
// Pure: no network, DB or fs. The PDF is one anyone can email in, so every step is
// bounded: pdfText() reads at most MAX_STREAMS streams, each once, inflates at most
// maxInflatedBytes in all and reads each stream's strings in one pass; the text is
// cut to kpi-weight's MAX_TEXT_CHARS; at most MAX_MENTIONS mentions of DVIR are read,
// and every pattern runs on a slice of at most TAIL_CHARS characters with bounded
// quantifiers.
"use strict";

const zlib = require("zlib");
const cellCompare = require("./cell-compare");
const kpiWeight = require("./kpi-weight");

// One DVIR deduction as C.H. Robinson prints it.
const DVIR_UNIT_CENTS = 3500;
const MAX_MENTIONS = 20;
const TAIL_CHARS = 160;
const MAX_DESCRIPTION_WORDS = 8;
const MAX_STREAMS = 1000;
const MAX_INFLATED_BYTES = 4 * 1024 * 1024;
const NOT_READABLE = Object.freeze({ readable: false, cents: 0, count: 0 });

// The text a PDF's pages show: the literal strings "( ... )" in its streams, joined
// with spaces, cut to MAX_TEXT_CHARS. Each stream (between "stream" and "endstream", at
// most MAX_STREAMS) is inflated (zlib, then raw deflate) within what is left of
// opts.maxInflatedBytes; one that is not compressed, or would inflate past that, is
// read as its raw bytes, cut to what is left. The strings are the ones the built-in
// reader (lib/broker-invoice.js extractPdfText()) finds in a page's streams; each
// stream is read once, and its strings in one pass.
function pdfText(buffer, opts = {}) {
	if (!Buffer.isBuffer(buffer)) return "";
	const budget = Number.isFinite(opts.maxInflatedBytes) && opts.maxInflatedBytes > 0 ? opts.maxInflatedBytes : MAX_INFLATED_BYTES;
	const parts = [];
	let chars = 0;
	let used = 0;
	let idx = 0;
	let streams = 0;
	const keep = (s) => {
		parts.push(s);
		chars += s.length + 1;
		return chars < kpiWeight.MAX_TEXT_CHARS;
	};
	while (streams < MAX_STREAMS && used < budget && chars < kpiWeight.MAX_TEXT_CHARS) {
		const sIdx = buffer.indexOf("stream", idx);
		if (sIdx === -1) break;
		let start = sIdx + 6;
		if (buffer[start] === 0x0d) start++;
		if (buffer[start] === 0x0a) start++;
		const eIdx = buffer.indexOf("endstream", start);
		if (eIdx === -1) break;
		let end = eIdx;
		if (end > start && buffer[end - 1] === 0x0a) end--;
		if (end > start && buffer[end - 1] === 0x0d) end--;
		idx = eIdx + 9;
		streams++;
		if (end <= start) continue;
		const slice = buffer.subarray(start, end);
		const left = budget - used;
		let data = null;
		for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
			try {
				data = inflate(slice, { maxOutputLength: left });
				break;
			} catch {
				// not this format, or past the budget: try the next, then the raw bytes
			}
		}
		if (data === null) data = slice.length > left ? slice.subarray(0, left) : slice;
		used += data.length;
		if (!literalStrings(data.toString("latin1"), keep)) break;
	}
	const text = parts.join(" ");
	return text.length > kpiWeight.MAX_TEXT_CHARS ? text.slice(0, kpiWeight.MAX_TEXT_CHARS) : text;
}

// Hands each literal string in `s` to `keep` (decoded), in order; stops when keep
// answers false, and answers whether to go on. A string runs from "(" to the first
// ")" not escaped by a backslash; an unescaped "(" inside it, or a backslash before a
// line break or at the end, means no string starts there, and the next one is looked
// for past that point. One pass over `s`.
function literalStrings(s, keep) {
	let i = s.indexOf("(");
	while (i !== -1) {
		let j = i + 1;
		let close = -1;
		let next = -1;
		while (j < s.length) {
			const c = s.charCodeAt(j);
			if (c === 0x5c) {
				const d = j + 1 < s.length ? s.charCodeAt(j + 1) : -1;
				if (d === -1 || d === 0x0a || d === 0x0d || d === 0x2028 || d === 0x2029) {
					next = j + 1;
					break;
				}
				j += 2;
				continue;
			}
			if (c === 0x29) { close = j; break; }
			if (c === 0x28) { next = j; break; }
			j++;
		}
		if (close !== -1) {
			if (!keep(decodeLiteral(s.slice(i + 1, close)))) return false;
			next = close + 1;
		} else if (next === -1) {
			return true;
		}
		i = s.indexOf("(", next);
	}
	return true;
}

// A literal string's escapes, in one pass: \n \r \t \( \) \\ and \ddd (octal); any
// other backslash is kept as written.
const ESCAPES = { n: "\n", r: "\r", t: "\t", "(": "(", ")": ")", "\\": "\\" };
function decodeLiteral(s) {
	if (s.indexOf("\\") === -1) return s;
	let out = "";
	for (let k = 0; k < s.length; k++) {
		const c = s[k];
		if (c !== "\\" || k + 1 >= s.length) { out += c; continue; }
		const d = s[k + 1];
		if (ESCAPES[d] !== undefined) { out += ESCAPES[d]; k++; continue; }
		if (d >= "0" && d <= "7") {
			let digits = d;
			while (digits.length < 3 && k + 1 + digits.length < s.length && s[k + 1 + digits.length] >= "0" && s[k + 1 + digits.length] <= "7") digits += s[k + 1 + digits.length];
			out += String.fromCharCode(parseInt(digits, 8));
			k += digits.length;
			continue;
		}
		out += c;
	}
	return out;
}

// The DVIR deductions a rate con's text names: `readable` is kpi-weight's
// classifyPdfText() rule (the KPI weight reader's: enough printable text and rate-con
// words); `cents` the total deducted and `count` the deduction lines. A line counts
// when the amount at its end is negative ("-$35.00", "($35.00)"): the last figure of
// the run of figures after the description, the last one with a "$" when there is one
// (the line's amount, after its quantity and rate). Every such line counts, two
// identical ones too: pdfText() reads each stream once.
function readRateConDvir(text, byteLength) {
	const s = typeof text === "string" ? text : "";
	if (kpiWeight.classifyPdfText(s, byteLength) !== "ok") return { ...NOT_READABLE };
	const body = s.length > kpiWeight.MAX_TEXT_CHARS ? s.slice(0, kpiWeight.MAX_TEXT_CHARS) : s;
	const re = /dvir/gi;
	let m;
	let mentions = 0;
	let cents = 0;
	let count = 0;
	while ((m = re.exec(body)) !== null && mentions < MAX_MENTIONS) {
		mentions++;
		const deducted = dvirDeductionAt(body, m.index);
		if (deducted > 0) {
			cents += deducted;
			count++;
		}
	}
	return { readable: true, cents, count };
}

// The amount deducted on the line after the DVIR mention at `at`, in cents, or 0.
function dvirDeductionAt(text, at) {
	let tail = text.slice(at + 4, at + 4 + TAIL_CHARS);
	const nl = tail.indexOf("\n");
	if (nl !== -1) tail = tail.slice(0, nl);
	tail = tail.replace(/-[ \t]{1,5}\$/g, "-$").replace(/\$[ \t]{1,5}/g, "$");
	const tokens = tail.trim().split(/\s{1,200}/).filter(Boolean);
	const figures = [];
	let words = 0;
	for (const t of tokens) {
		const isFigure = /\d/.test(t) && cellCompare.moneyCents(t) !== null;
		if (!isFigure) {
			if (figures.length) break;
			if (++words > MAX_DESCRIPTION_WORDS) return 0;
			continue;
		}
		figures.push(t);
	}
	if (!figures.length) return 0;
	const withSign = figures.filter((t) => t.includes("$"));
	const amount = cellCompare.moneyCents(withSign.length ? withSign[withSign.length - 1] : figures[figures.length - 1]);
	return amount < 0 ? -amount : 0;
}

// "$35", "$1,050" or "$37.50": the owner's sentence names whole dollars.
function dollars(cents) {
	const whole = cents % 100 === 0;
	return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

// "$70.00": the alert's own money format (lib/broker-invoice.js formatMoney()).
function money(cents) {
	return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The DVIR line for a re-issue alert (the owner's wording, 2026-10-14):
// - a readable rate con naming DVIR deductions: what C.H. Robinson deducted, with the
//   count when there is more than one;
// - no readable text (no reading, or one that was not readable) and a held Payment
//   (the first held column named like Payment, broker-invoice's findPaymentColumn()
//   pattern, whose stored and sent values are both amounts) that dropped by a positive
//   multiple of $35: the drop, and where to look;
// - otherwise "".
// `reading` is readRateConDvir()'s answer or null; `held` the alert's held columns,
// [{ column, stored, sent }].
function dvirAlertLine(reading, held) {
	if (reading && reading.readable) {
		if (!(reading.count > 0 && reading.cents > 0)) return "";
		const many = reading.count > 1 ? ` (${reading.count} deductions)` : "";
		return `C.H. Robinson deducted ${dollars(reading.cents)} for DVIR${many}. If the driver did the pre-trip inspection, dispute it with C.H. Robinson.`;
	}
	for (const h of Array.isArray(held) ? held : []) {
		if (!h || !/payment/i.test(String(h.column == null ? "" : h.column).slice(0, 200))) continue;
		const stored = cellCompare.moneyCents(h.stored);
		const sent = cellCompare.moneyCents(h.sent);
		if (stored === null || sent === null) continue;
		const drop = stored - sent;
		if (!(drop > 0) || drop % DVIR_UNIT_CENTS !== 0) return "";
		return `Payment dropped by ${money(drop)}. This may be a DVIR deduction; check the rate con.`;
	}
	return "";
}

module.exports = { DVIR_UNIT_CENTS, MAX_PDF_BYTES: kpiWeight.MAX_PDF_BYTES, MAX_STREAMS, pdfText, readRateConDvir, dvirAlertLine };
