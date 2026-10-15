"use strict";
// THE MILES A RATE CONFIRMATION STATES, for the KPI bot's loaded, paid and
// deadhead miles (R10): the loaded miles the broker paid ("Line Haul - PER MILE
// 268", "Load Miles: 744") and the empty miles it paid ("Empty Movement - PER
// MILE 45"), read off the text of the load's rate-con PDF (lib/broker-invoice.js
// extractPdfText()).
//
//   parseStatedMiles(text)               -> { status, loadedMiles, emptyMiles }
//   milesFromPdfText(text, byteLength)   -> the same, or 'no_text' / 'too_large'
//
// STATUSES.
//   ok           an Empty Movement line states the empty miles (the loaded miles
//                too, when a per-mile Line Haul or a "Load Miles:" states them;
//                else loadedMiles is null)
//   none_stated  the loaded miles are stated and the charge table has no Empty
//                Movement line: no empty leg was paid, emptyMiles 0
//   no_miles     readable, but no miles are stated (a flat rate)
//   conflict     the text states two different figures for one leg, or a table
//                that does not add up: neither figure is used
//   no_text / too_large  (milesFromPdfText only) nothing readable / not read
//
// THE THREE CHARGE-TABLE LAYOUTS, as the readers give them back:
//   row     "Line Haul - PER MILE 268 $1.80 $482.40 Fuel Surcharge - PER MILE
//            268 $0.75 $201.00 Empty Movement - PER MILE 45 $2.55 $114.75"
//   column  "Amount Rate Extended 624 624 379 $1.80 $0.89 $2.69 $1,123.20
//            $555.36 $1,019.51 Line Haul - PER MILE Fuel Surcharge - PER MILE
//            Empty Movement - PER MILE Total:" (main's built-in reader: every
//            quantity, then every rate, then every amount, then every label)
//   booked  "Rate Detail Amount Rate Extended Line Haul 168.00 $1.80 $302.40
//            ... Empty Movement 40.00 $2.55 $102.00" (each line labelled, no
//            "- PER MILE"; a quantity of 1.00 is a flat charge)
//
// WHY A TABLE MUST ADD UP. A quantity is miles only on a per-mile line, and a
// line counts only when its quantity x rate equals its amount to the cent. In
// the column layout the labels sit apart from their numbers, so a label is
// assigned by POSITION only when the number of labels equals the number of
// quantity/rate/amount triples and every triple adds up; anything else is a
// conflict, never a guess. A booked line with no "- PER MILE" is per mile when
// its quantity is over 1.5 at a rate under $10 a unit.
//
// WHY THE FUEL SURCHARGE IS NOT MILES. It is charged per loaded mile, so its
// quantity repeats the line haul's; adding it would count every mile twice.
// Only the Line Haul quantity is the loaded miles.
//
// WHY THE LENGTH CAP COMES FIRST. This runs on text from email attachments: the
// input is cut to MAX_TEXT_CHARS before any regex sees it, whitespace runs are
// collapsed with a bounded quantifier, and every pattern below is bounded
// (path-backend.md: internal whitespace runs have blocked the event loop).
//
// Pure: no I/O, no environment reads. Requires lib/kpi-weight.js
// (classifyPdfText(), the text cap and the size cap), itself pure.

const { MAX_TEXT_CHARS, MAX_PDF_BYTES, classifyPdfText } = require("./kpi-weight");

// A per-mile quantity is a trip's miles: more than 1.5 (1.00 is a flat charge)
// and at most this many.
const MIN_PER_MILE_QTY = 1.5;
const MAX_MILES = 6000;
// A booked line with no "- PER MILE" is per mile only at a rate under this.
const MAX_PER_MILE_RATE = 10;
// How far after a table header its numbers and labels are looked for.
const TABLE_WINDOW = 2400;
// Tables read per document (a rate con prints one, sometimes twice).
const MAX_TABLES = 8;
// Lines read per table.
const MAX_LINES = 20;

const QTY_TOKEN_RE = /^\d{1,3}(?:,\d{3}){0,2}(?:\.\d{1,4})?$|^\d{1,9}(?:\.\d{1,4})?$/;
const MONEY_TOKEN_RE = /^-?\$(?:\d{1,3}(?:,\d{3}){0,3}|\d{1,12})(?:\.\d{1,4})?$/;
const KNOWN_LABELS = Object.freeze({ "line haul": "lineHaul", "fuel surcharge": "fuel", "empty movement": "empty" });
// "Line Haul - PER MILE 268 $1.80 $482.40" and "Line Haul 168.00 $1.80 $302.40".
const ROW_RE = /\b(Line Haul|Fuel Surcharge|Empty Movement)(?: - (PER MILE|FLAT RATE|FLAT))? (\d{1,3}(?:,\d{3}){0,2}(?:\.\d{1,4})?|\d{1,9}(?:\.\d{1,4})?) (-?\$(?:\d{1,3}(?:,\d{3}){0,3}|\d{1,12})(?:\.\d{1,4})?) (-?\$(?:\d{1,3}(?:,\d{3}){0,3}|\d{1,12})(?:\.\d{1,4})?)(?![\d,])/gi;
const HEADER_RE = /\bAmount Rate Extended /g;
// One column-layout label: up to 60 characters, then " - PER MILE" (or another
// unit word), read stickily from the start of the label text.
const LABEL_RE = /([A-Za-z][A-Za-z0-9&/().' -]{0,59}?) - (PER [A-Z]{2,12}|FLAT RATE|FLAT)(?= |$) ?/y;
const MILES_LABEL_RE = /\b(?:Load(?:ed)? Miles|Total Miles)[ :]{1,4}(\d{1,3}(?:,\d{3}){0,2}|\d{1,6})(?:\.\d{1,2})?(?![\d,])/gi;

const NONE = Object.freeze({ status: "no_miles", loadedMiles: null, emptyMiles: null });
const CONFLICT = Object.freeze({ status: "conflict", loadedMiles: null, emptyMiles: null });

function num(token) {
	return Number(String(token).replace(/[$,]/g, ""));
}
function cents(v) {
	return Math.round(v * 100);
}
function addsUp(qty, rate, amount) {
	return cents(qty * rate) === cents(amount);
}

// The text this module reads: capped, whitespace collapsed to single spaces.
function cleanText(text) {
	let s = typeof text === "string" ? text : String(text == null ? "" : text);
	if (s.length > MAX_TEXT_CHARS) s = s.slice(0, MAX_TEXT_CHARS);
	return s.replace(/\s{1,1000}/g, " ");
}

// One charge line as read: which leg, whether it is per mile, the quantity.
function lineOf(labelText, unit, qty, rate) {
	const kind = KNOWN_LABELS[String(labelText).trim().toLowerCase()] || "other";
	const u = unit ? String(unit).toUpperCase() : "";
	let perMile;
	if (u === "PER MILE") perMile = true;
	else if (u) perMile = false;
	else perMile = qty > MIN_PER_MILE_QTY && Math.abs(rate) < MAX_PER_MILE_RATE;
	return { kind, perMile, explicitPerMile: u === "PER MILE", qty };
}

// Row and booked layouts: each line carries its own label.
function rowLines(s, out) {
	ROW_RE.lastIndex = 0;
	let m;
	let n = 0;
	while ((m = ROW_RE.exec(s)) !== null && n < MAX_TABLES * MAX_LINES) {
		n++;
		const qty = num(m[3]);
		const rate = num(m[4]);
		const amount = num(m[5]);
		if (!addsUp(qty, rate, amount)) {
			out.conflict = true;
			continue;
		}
		out.lines.push(lineOf(m[1], m[2], qty, rate));
	}
}

// The column layout: "Amount Rate Extended" + n quantities + n rates + n
// amounts + n labels + "Total:". A header followed by a label (the row layout)
// or by anything else is not a column table and adds nothing.
function columnLines(s, out) {
	HEADER_RE.lastIndex = 0;
	let h;
	let tables = 0;
	while ((h = HEADER_RE.exec(s)) !== null && tables < MAX_TABLES) {
		const start = h.index + h[0].length;
		const window = s.slice(start, start + TABLE_WINDOW);
		const end = window.indexOf(" Total:");
		if (end < 0) continue;
		const tokens = window.slice(0, end).split(" ");
		let i = 0;
		const qtys = [];
		while (i < tokens.length && QTY_TOKEN_RE.test(tokens[i])) qtys.push(num(tokens[i++]));
		const money = [];
		while (i < tokens.length && MONEY_TOKEN_RE.test(tokens[i])) money.push(num(tokens[i++]));
		if (qtys.length === 0 && money.length === 0) continue;
		tables++;
		const labelText = tokens.slice(i).join(" ");
		const n = qtys.length;
		if (n === 0 || n > MAX_LINES || money.length !== 2 * n || !labelText) {
			out.conflict = true;
			continue;
		}
		const labels = [];
		LABEL_RE.lastIndex = 0;
		let lm;
		while (labels.length <= MAX_LINES && LABEL_RE.lastIndex < labelText.length && (lm = LABEL_RE.exec(labelText)) !== null) {
			labels.push({ text: lm[1], unit: lm[2] });
		}
		if (LABEL_RE.lastIndex < labelText.length || labels.length !== n) {
			out.conflict = true;
			continue;
		}
		const lines = [];
		let ok = true;
		for (let k = 0; k < n; k++) {
			const qty = qtys[k];
			const rate = money[k];
			const amount = money[n + k];
			if (!addsUp(qty, rate, amount)) {
				ok = false;
				break;
			}
			lines.push(lineOf(labels[k].text, labels[k].unit, qty, rate));
		}
		if (!ok) {
			out.conflict = true;
			continue;
		}
		out.lines.push(...lines);
	}
}

// "Load Miles: 744" / "Total Miles: 744": the loaded miles by label.
function labelledMiles(s) {
	const found = new Set();
	MILES_LABEL_RE.lastIndex = 0;
	let m;
	while ((m = MILES_LABEL_RE.exec(s)) !== null && found.size < MAX_LINES) found.add(num(m[1]));
	return [...found];
}

// The one figure a set of quantities states, null for none, or CONFLICT for two.
function single(values) {
	const distinct = [...new Set(values)];
	if (distinct.length > 1) return CONFLICT;
	return distinct.length ? distinct[0] : null;
}

// What a rate con's text states about its miles.
function parseStatedMiles(text) {
	const s = cleanText(text);
	if (!s.trim()) return { ...NONE };
	const out = { lines: [], conflict: false };
	rowLines(s, out);
	columnLines(s, out);
	if (out.conflict) return { ...CONFLICT };

	const loadedLines = out.lines.filter((l) => l.kind === "lineHaul" && l.perMile);
	const emptyLines = out.lines.filter((l) => l.kind === "empty");
	// A per-mile quantity outside a trip's range, or an Empty Movement charged
	// some other way than per mile, cannot be read as miles.
	const implausible = (l) => !(l.qty > MIN_PER_MILE_QTY && l.qty <= MAX_MILES);
	if (loadedLines.some(implausible) || emptyLines.some((l) => !l.perMile || implausible(l))) return { ...CONFLICT };
	if (out.lines.some((l) => l.explicitPerMile && l.kind === "fuel" && implausible(l))) return { ...CONFLICT };

	const empty = single(emptyLines.map((l) => l.qty));
	if (empty === CONFLICT) return { ...CONFLICT };
	let loaded = single(loadedLines.map((l) => l.qty));
	if (loaded === CONFLICT) return { ...CONFLICT };
	if (loaded === null) {
		const byLabel = single(labelledMiles(s).filter((v) => v > MIN_PER_MILE_QTY && v <= MAX_MILES));
		if (byLabel === CONFLICT) return { ...CONFLICT };
		loaded = byLabel;
	}
	if (empty !== null) return { status: "ok", loadedMiles: loaded, emptyMiles: empty };
	if (loaded !== null) return { status: "none_stated", loadedMiles: loaded, emptyMiles: 0 };
	return { ...NONE };
}

// A rate-con PDF's extracted text -> its stated miles, or why there are none.
function milesFromPdfText(text, byteLength) {
	const cls = classifyPdfText(text, byteLength);
	if (cls !== "ok") return { status: cls, loadedMiles: null, emptyMiles: null };
	return parseStatedMiles(text);
}

module.exports = {
	MAX_TEXT_CHARS,
	MAX_PDF_BYTES,
	MAX_MILES,
	parseStatedMiles,
	milesFromPdfText,
};
