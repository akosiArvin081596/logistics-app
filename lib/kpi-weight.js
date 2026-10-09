"use strict";
// FREIGHT WEIGHT FROM LOAD TEXT: the KPI bot's reading of a load's stated weight,
// from the Job Tracking "Details" cell (the rate-con extractor's summary) or from
// the text of the load's rate confirmation PDF (lib/broker-invoice.js
// extractPdfText()).
//
//   parseWeight(text)                  -> { status, weightLb, evidence }
//   classifyPdfText(text, byteLength)  -> 'ok' | 'no_text' | 'too_large'
//   isPlausibleLb(lb)                  -> the 100–48,000 lb bounds
//
// WHY A NUMBER NEEDS A UNIT OR A LABEL. A rate confirmation is full of numbers
// that look like weights: ZIP codes (30301), load and PO numbers, rates, miles,
// dates, phone numbers. A number counts only when a pound or kilogram unit
// follows it ("42,000 LBS", "42000#", "19,050 kg") or a weight label sits just
// before it ("Weight:", "Wt", "Est. Weight", "Estimated Weight", "Gross Weight").
// A bare number is never a weight, however plausible its size.
//
// WHY BOUNDS. A loaded 53' trailer carries at most about 45,000 lb of freight on
// an 80,000 lb gross truck; 48,000 lb leaves room for the heaviest legal loads.
// Below 100 lb is a per-piece or per-case weight, not a load. The legal-limit
// boilerplate many rate cons print ("MAX GROSS WEIGHT 80,000 LB") is excluded
// twice: by the bounds, and by the guard on limit words ("max", "legal",
// "limit", "capacity", "exceed", "up to") just before the number or its label.
//
// WHY A CONFLICT IS NOT RESOLVED. When the plausible weights a document states
// differ by more than 1%, which one is the load is a judgement the text cannot
// make (an estimate beside an actual, two stops, a typo). Picking the larger or
// the first would publish a number nobody stated; the load is reported as a
// conflict and left out of the stated tonnage instead. Repeats of one weight
// (the same figure in the header and the commodity table, or "42,000 LBS (19,051
// KG)") agree within 1% and are fine.
//
// WHY THE LENGTH CAP COMES FIRST. This runs on text from email attachments, so
// the input is capped at MAX_TEXT_CHARS before any regex sees it, and every
// regex quantifier is bounded: long runs of whitespace and digits have blocked
// this server's event loop before (path-backend.md).
//
// Pure: no I/O, no requires, no environment reads.

// Characters of text read; anything past this is ignored.
const MAX_TEXT_CHARS = 200000;
// A rate confirmation PDF larger than this is not read at all.
const MAX_PDF_BYTES = 3 * 1024 * 1024;
const LB_PER_KG = 2.20462;
const MIN_PLAUSIBLE_LB = 100;
const MAX_PLAUSIBLE_LB = 48000;
// Two weights within 1% of each other are the same weight written twice.
const CONFLICT_RATIO = 1.01;
// A weight label's number must sit within this many characters of the label.
const LABEL_GAP_MAX = 25;
// Enough to see every weight a real document states; stops a pathological text
// from building an unbounded candidate list.
const MAX_CANDIDATES = 200;
// Text shorter than this (non-space characters) is not a readable rate con.
const MIN_PRINTABLE_CHARS = 80;
// Share of characters that must be printable ASCII for the text to be text.
const MIN_PRINTABLE_SHARE = 0.85;

// A number: "43,764" (thousands separators, at most two groups), "42000",
// "42000.0". Never preceded by a word character, a decimal point, a comma, "$"
// or "#" (so never the tail of a longer number, an id or a money amount), and
// never followed by more digits, a comma or a date/time/range separator and a
// digit ("2026-10-12", "10/12", "08:00").
const NUM = String.raw`(?<![\w.,$#])(\d{1,3}(?:,\d{3}){1,2}|\d{1,6})(?:\.(\d{1,3}))?(?![\d,]|[/:\-]\d)`;
// The unit after a number: pounds, kilograms, or "#" written straight after it.
const UNIT = String.raw`(?:\s{0,3}(?:(lbs?|pounds?)|(kgs?|kilos?|kilograms?))(?![a-z])|(#)(?![\w#]))`;
const UNIT_RE = new RegExp(`${NUM}${UNIT}`, "gi");
// A weight label, then a short gap of punctuation, spaces and unit words
// ("Weight (lbs): ", "Gross Weight: ", "WT "), then the number and an optional unit.
const LABEL_RE = new RegExp(
	String.raw`\b((?:weight|wt)s?\b\.?)((?:\s|[:=()\[\]\-–]|lbs?\b\.?|pounds?\b|kgs?\b|kilos?\b|kilograms?\b|in\b){0,12}?)${NUM}${UNIT}?`,
	"gi");
// Words that make a stated figure a limit rather than the load's weight.
const LIMIT_BEFORE_RE = /\b(?:max(?:imum)?|legal|limit|capacity|exceed(?:s|ing)?|up\s{1,3}to)\b/i;
// "45,000 lbs max" (but not "42,000 LBS MAX GROSS WEIGHT ...", where MAX begins
// the next field).
const LIMIT_AFTER_RE = /^\s{0,3}[([]?\s{0,2}(?:max(?:imum)?|limit|capacity)\b(?!\.?\s{0,3}(?:gross|weight|wt|load)\b)/i;
const KG_IN_GAP_RE = /\bkgs?\b|\bkilos?\b|\bkilograms?\b/i;

const NONE = Object.freeze({ status: "none", weightLb: null, evidence: "none" });
const CONFLICT = Object.freeze({ status: "conflict", weightLb: null, evidence: "conflict" });

// The text this module reads: a string, cut to MAX_TEXT_CHARS before anything
// else touches it.
function capText(text) {
	const s = typeof text === "string" ? text : String(text == null ? "" : text);
	return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) : s;
}

function isPlausibleLb(lb) {
	return typeof lb === "number" && Number.isFinite(lb) && lb >= MIN_PLAUSIBLE_LB && lb <= MAX_PLAUSIBLE_LB;
}

// "43,764" + "5" -> 43764.5.
function numberValue(intPart, fraction) {
	const whole = Number(intPart.replace(/,/g, ""));
	return fraction ? whole + Number(`0.${fraction}`) : whole;
}

// The same clause as position i, at most 24 characters back: cut at the last
// line break, semicolon, bar or sentence end, so a limit word in the previous
// field cannot disqualify this one.
function clauseBefore(s, i) {
	const w = s.slice(Math.max(0, i - 24), i);
	const cut = Math.max(w.lastIndexOf("\n"), w.lastIndexOf(";"), w.lastIndexOf("|"), w.lastIndexOf(". "));
	return cut >= 0 ? w.slice(cut + 1) : w;
}

function isLimit(s, before, afterIndex) {
	return LIMIT_BEFORE_RE.test(clauseBefore(s, before)) || LIMIT_AFTER_RE.test(s.slice(afterIndex, afterIndex + 24));
}

// Every plausible weight in the text, one per number position, in document order.
function collectCandidates(s) {
	const byIndex = new Map();
	const add = (index, lb, labelled, kg) => {
		if (!isPlausibleLb(lb)) return;
		const prev = byIndex.get(index);
		if (prev) {
			prev.labelled = prev.labelled || labelled;
			return;
		}
		if (byIndex.size < MAX_CANDIDATES) byIndex.set(index, { index, lb, labelled, kg });
	};

	LABEL_RE.lastIndex = 0;
	let m;
	while ((m = LABEL_RE.exec(s)) !== null) {
		const gap = m[2] || "";
		const numberAt = m.index + m[1].length + gap.length;
		if (gap.length <= LABEL_GAP_MAX && !isLimit(s, m.index, m.index + m[0].length)) {
			const kg = !!m[6] || (!m[5] && !m[7] && KG_IN_GAP_RE.test(gap));
			const value = numberValue(m[3], m[4]);
			add(numberAt, Math.round(kg ? value * LB_PER_KG : value), true, kg);
		}
		if (byIndex.size >= MAX_CANDIDATES) break;
		// Resume right after the label, so a second label inside this match's
		// gap is still seen.
		LABEL_RE.lastIndex = m.index + m[1].length;
	}

	UNIT_RE.lastIndex = 0;
	while ((m = UNIT_RE.exec(s)) !== null) {
		if (!isLimit(s, m.index, m.index + m[0].length)) {
			const kg = !!m[4];
			const value = numberValue(m[1], m[2]);
			add(m.index, Math.round(kg ? value * LB_PER_KG : value), false, kg);
		}
		if (byIndex.size >= MAX_CANDIDATES) break;
	}

	return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

// The load's stated weight in a text.
//   { status: 'ok', weightLb, evidence: 'labelled' | 'unit' | 'kg' }
//   { status: 'none', weightLb: null, evidence: 'none' }        no weight stated
//   { status: 'conflict', weightLb: null, evidence: 'conflict' } two different weights
// A labelled weight beats an unlabelled one; within the winning group, weights
// more than 1% apart are a conflict. evidence 'kg' is an unlabelled kilogram
// figure, converted.
function parseWeight(text) {
	const s = capText(text);
	if (!s) return { ...NONE };
	const all = collectCandidates(s);
	const labelled = all.filter((c) => c.labelled);
	const pool = labelled.length ? labelled : all;
	if (pool.length === 0) return { ...NONE };
	let lo = Infinity;
	let hi = -Infinity;
	for (const c of pool) {
		if (c.lb < lo) lo = c.lb;
		if (c.lb > hi) hi = c.lb;
	}
	if (hi > lo * CONFLICT_RATIO) return { ...CONFLICT };
	const pick = pool[0];
	return { status: "ok", weightLb: pick.lb, evidence: labelled.length ? "labelled" : (pick.kg ? "kg" : "unit") };
}

// What extractPdfText() gave back for a rate confirmation:
//   'too_large'  the file is over MAX_PDF_BYTES (not read at all)
//   'no_text'    nothing readable: a scanned image, text drawn as glyph codes,
//                or extractPdfText()'s fallback, which hands back the raw file
//                (binary and PDF syntax) when it finds no text strings
//   'ok'         readable text, worth looking for a weight in
function classifyPdfText(text, byteLength) {
	if (Number(byteLength) > MAX_PDF_BYTES) return "too_large";
	const s = capText(text);
	if (!s) return "no_text";
	// The raw-file fallback: the document's own header and object syntax.
	if (/%PDF-\d/.test(s) && /\bendobj\b/.test(s)) return "no_text";
	let printable = 0;
	let visible = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0x21 && c <= 0x7e) {
			printable++;
			visible++;
		} else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
			printable++;
		}
	}
	if (visible < MIN_PRINTABLE_CHARS) return "no_text";
	if (printable / s.length < MIN_PRINTABLE_SHARE) return "no_text";
	return "ok";
}

module.exports = {
	MAX_TEXT_CHARS,
	MAX_PDF_BYTES,
	LB_PER_KG,
	MIN_PLAUSIBLE_LB,
	MAX_PLAUSIBLE_LB,
	isPlausibleLb,
	parseWeight,
	classifyPdfText,
};
