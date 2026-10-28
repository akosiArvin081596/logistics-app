"use strict";
// Which pages of a PDF receipt may reach the receipt's driver (driver privacy,
// plan Revision 3 section 3; decisions DP2, DP5, DP10). Pure: no fs, DB or
// network. Every answer is a code, never a name, a number or an excerpt.
//
// pageVerdict(page, roster, receipt) reads one page's text (lib/receipt-pdf-child.js
// "text" job) and answers, most severe first:
//   OTHER_PERSON  another person on the roster: full name, reversed ("LAST,
//                 FIRST"), run together, initial + surname, or first and last
//                 name anywhere on the page. The driver's own name, in any of
//                 those spellings, never counts.
//   OTHER_TRUCK   another fleet truck: its unit number next to a unit / truck /
//                 vehicle label, or its plate or VIN anywhere.
//   OTHER_CARD    a card last-4 next to a card label, seen on exactly one other
//                 driver's receipts (a card seen on two drivers' receipts, or
//                 on his, decides nothing).
//   UNREADABLE    the text holds neither the expense's amount AND date nor its
//                 vendor, or any of it is drawn in a font the reader cannot map
//                 (mis-decoded text must never read as "names no one").
//   STATEMENT     a page of a file of more than one page, or one with more than
//                 3 lines carrying a date and an amount, or 2 such lines on
//                 different dates.
//   AUTO_RELEASED none of the above: the only automatic release.
// Every code that applies is kept in `reasons`; `code` is the most severe.
//
// releasedPages() is the rule the invoice render and the pages-only re-render
// both read: a page reaches the driver only with a verdict for the file as it
// is now (same sha256) under the roster as it is now (same hash), and then only
// when a Super Admin released it (and no OTHER_* code appeared after that mark)
// or its verdict is AUTO_RELEASED with no mark. An "office" mark always withholds.
//
// Every pattern here is bounded: page text is attacker-influenced (a driver's
// PDF), and an unbounded quantifier on a whitespace run has blocked the event
// loop before (path-backend notes).

const crypto = require("crypto");

const CODES = Object.freeze({
	OTHER_PERSON: "OTHER_PERSON",
	OTHER_TRUCK: "OTHER_TRUCK",
	OTHER_CARD: "OTHER_CARD",
	UNREADABLE: "UNREADABLE",
	STATEMENT: "STATEMENT",
	AUTO_RELEASED: "AUTO_RELEASED",
});
const OTHER_CODES = Object.freeze([CODES.OTHER_PERSON, CODES.OTHER_TRUCK, CODES.OTHER_CARD]);
const SEVERITY = Object.freeze([...OTHER_CODES, CODES.UNREADABLE, CODES.STATEMENT]);
const VERDICT_CODES = new Set(Object.values(CODES));

// A Super Admin's reason for a mark (DP2): a code; the free text stays in the
// table, staff only.
const MARK_REASONS = Object.freeze(["only_his_lines", "checked_receipt", "other_driver", "other_truck", "other_card", "not_readable", "other"]);
const MARKS = Object.freeze(["released", "office"]);

// How much of a page is read: past these the rest is not looked at, and the
// page is UNREADABLE (the reader could not see all of it).
const PAGE_TEXT_MAX = 200_000;
const PAGE_LINES_MAX = 4000;
const LINE_MAX = 2000;
const ROSTER_PEOPLE_MAX = 20_000;

// ---------------------------------------------------------------------------
// Text folding: letters and digits only, upper case, accents dropped.

function fold(s) {
	return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}
function tokensOf(s) {
	const f = fold(s);
	return f ? f.split(" ") : [];
}

// A person's key: his tokens sorted, so "Ellis, Morgan" and "Morgan  Ellis" are
// one person; compact: the tokens run together in order.
function personOf(name) {
	const tokens = tokensOf(name);
	if (!tokens.length) return null;
	return { tokens, key: [...tokens].sort().join(" "), compact: tokens.join("") };
}
function samePerson(a, b) {
	if (!a || !b) return false;
	if (a.key === b.key) return true;
	return a.compact === b.compact || a.compact === b.tokens.slice(1).concat(b.tokens[0]).join("") || b.compact === a.tokens.slice(1).concat(a.tokens[0]).join("");
}

function compactId(s) {
	return fold(s).replace(/ /g, "");
}

// ---------------------------------------------------------------------------
// Card last-4s from a receipt's stored OCR fields (expenses.receipt_details:
// [{ label, value }]): a 4-digit group next to a card label.

const CARD_LABELS = new Set(["CARD", "VISA", "MASTERCARD", "MC", "AMEX", "AMERICAN", "DISCOVER", "DEBIT", "CREDIT", "ACCOUNT", "ACCT", "FLEET", "COMDATA", "EFS", "WEX", "TCH", "FLEETONE", "CHECKCARD", "CC"]);
const CARD_LOOKAHEAD = 6;

// A token that ends a masked card number: "1234", "XXXXXXXX1234".
function last4Of(token) {
	const t = String(token || "");
	if (t.length < 4 || t.length > 24) return "";
	for (let i = t.length - 4; i < t.length; i++) if (t[i] < "0" || t[i] > "9") return "";
	for (let i = 0; i < t.length - 4; i++) if (t[i] !== "X") return "";
	return t.slice(-4);
}

function cardsInTokens(tokens) {
	const out = new Set();
	for (let i = 0; i < tokens.length; i++) {
		if (!CARD_LABELS.has(tokens[i])) continue;
		for (let k = i + 1; k <= i + CARD_LOOKAHEAD && k < tokens.length; k++) {
			const l4 = last4Of(tokens[k]);
			if (l4) { out.add(l4); break; }
		}
	}
	return out;
}

function cardLast4sFromDetails(details) {
	let list = details;
	if (typeof list === "string") {
		try { list = JSON.parse(list); } catch { return []; }
	}
	if (!Array.isArray(list)) return [];
	const out = new Set();
	for (const d of list.slice(0, 40)) {
		if (!d || typeof d !== "object") continue;
		const text = `${String(d.label || "").slice(0, 60)} ${String(d.value || "").slice(0, 200)}`;
		for (const l4 of cardsInTokens(tokensOf(text))) out.add(l4);
	}
	return [...out];
}

// ---------------------------------------------------------------------------
// The roster: every driver name the app holds, every truck's unit, plate and
// VIN, and the card last-4s seen on receipts with their drivers. Its hash is
// what a verdict is valid for: a changed roster re-runs every verdict.

function buildRoster({ people = [], trucks = [], cards = [] } = {}) {
	const persons = new Map();
	for (const name of people.slice(0, ROSTER_PEOPLE_MAX)) {
		const p = personOf(name);
		if (!p) continue;
		// A one-word name counts only as a whole word of 4 letters or more.
		if (p.tokens.length === 1 && p.tokens[0].length < 4) continue;
		if (!persons.has(p.key)) persons.set(p.key, p);
	}
	const truckList = [];
	const seenUnits = new Set();
	for (const t of trucks) {
		const unit = compactId(t && t.unit);
		if (!unit || seenUnits.has(unit)) continue;
		seenUnits.add(unit);
		truckList.push({ unit, plate: compactId(t.plate), vin: compactId(t.vin) });
	}
	truckList.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
	const cardMap = new Map();
	for (const c of cards) {
		const l4 = /^\d{4}$/.test(String(c && c.last4 || "")) ? String(c.last4) : "";
		const who = personOf(c && c.driver);
		if (!l4 || !who) continue;
		if (!cardMap.has(l4)) cardMap.set(l4, new Map());
		cardMap.get(l4).set(who.key, who);
	}
	const canon = JSON.stringify({
		people: [...persons.keys()].sort(),
		trucks: truckList.map((t) => [t.unit, t.plate, t.vin]),
		cards: [...cardMap.entries()].map(([l4, who]) => [l4, [...who.keys()].sort()]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
	});
	return {
		people: [...persons.values()],
		trucks: truckList,
		cards: cardMap,
		hash: crypto.createHash("sha256").update(canon).digest("hex"),
	};
}

// ---------------------------------------------------------------------------
// Page text into lines.

function pageLines(text) {
	let s = typeof text === "string" ? text : "";
	const truncated = s.length > PAGE_TEXT_MAX;
	if (truncated) s = s.slice(0, PAGE_TEXT_MAX);
	const raw = s.split(/\r\n|\r|\n/, PAGE_LINES_MAX + 1);
	const lines = [];
	for (const r of raw.slice(0, PAGE_LINES_MAX)) {
		// One space for every whitespace run: one quantifier, linear.
		const line = r.replace(/\s+/g, " ").trim().slice(0, LINE_MAX);
		if (line) lines.push(line);
	}
	return { lines, truncated: truncated || raw.length > PAGE_LINES_MAX };
}

// ---------------------------------------------------------------------------
// Money and dates (bounded patterns on one whitespace-collapsed line).

const MONEY_RE = /(?<![\d.,])\$? ?(\d{1,3}(?:,\d{3}){1,4}|\d{1,9})\.(\d{2})(?![\d])/g;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTH_ALT = "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC";
const DATE_NUM_RE = /(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d/.-])/g;
const DATE_ISO_RE = /(?<![\d-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d-])/g;
const DATE_MONTH_RE = new RegExp(`(?<![A-Z])(${MONTH_ALT})[A-Z]{0,6}\\.? ?(\\d{1,2})(?:ST|ND|RD|TH)?(?![\\d])(?:,? ?(\\d{4}))?`, "g");
const DATE_DAY_MONTH_RE = new RegExp(`(?<![\\d])(\\d{1,2})[ -](${MONTH_ALT})[A-Z]{0,6}(?:[ ,-]{1,2}(\\d{4}|\\d{2}))?(?![\\dA-Z])`, "g");
const DATE_SHORT_RE = /(?<![\d/.-])(\d{1,2})\/(\d{1,2})(?![\d/])/g;

function moneyCents(line) {
	const out = [];
	MONEY_RE.lastIndex = 0;
	let m;
	while ((m = MONEY_RE.exec(line)) !== null) {
		const whole = Number(m[1].replace(/,/g, ""));
		if (Number.isFinite(whole)) out.push(whole * 100 + Number(m[2]));
		if (out.length > 200) break;
	}
	return out;
}

function validDay(y, mo, d) {
	return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && (y === null || (y >= 1990 && y <= 2099));
}
function fullYear(y) {
	if (y === undefined || y === null || y === "") return null;
	const n = Number(y);
	return y.length === 2 ? 2000 + n : n;
}

// Every date on a line: { y (or null), m, d }.
function datesIn(line) {
	const out = [];
	const up = line.toUpperCase();
	const push = (y, mo, d) => { if (validDay(y, mo, d) && out.length < 100) out.push({ y, m: mo, d }); };
	let m;
	DATE_NUM_RE.lastIndex = 0;
	while ((m = DATE_NUM_RE.exec(up)) !== null) push(fullYear(m[3]), Number(m[1]), Number(m[2]));
	DATE_ISO_RE.lastIndex = 0;
	while ((m = DATE_ISO_RE.exec(up)) !== null) push(Number(m[1]), Number(m[2]), Number(m[3]));
	DATE_MONTH_RE.lastIndex = 0;
	while ((m = DATE_MONTH_RE.exec(up)) !== null) push(fullYear(m[3]), MONTHS.indexOf(m[1]) + 1, Number(m[2]));
	DATE_DAY_MONTH_RE.lastIndex = 0;
	while ((m = DATE_DAY_MONTH_RE.exec(up)) !== null) push(fullYear(m[3]), MONTHS.indexOf(m[2]) + 1, Number(m[1]));
	if (!out.length) {
		DATE_SHORT_RE.lastIndex = 0;
		while ((m = DATE_SHORT_RE.exec(up)) !== null) push(null, Number(m[1]), Number(m[2]));
	}
	return out;
}

const dayKey = (x) => `${x.m}-${x.d}`;

// ---------------------------------------------------------------------------
// Matching people, trucks and cards.

const UNIT_LABELS = new Set(["UNIT", "TRUCK", "TRK", "TRACTOR", "VEHICLE", "VEH", "TRUCKNO", "UNITNO"]);
const UNIT_FILLERS = new Set(["NO", "NUM", "NUMBER", "NBR", "ID", "N"]);
const WINDOW = 3;

function lineTokens(lines) {
	return lines.map((l) => tokensOf(l));
}

// The driver's own name, every spelling, blanked out of the lines first, except
// where it is part of a longer roster name holding his ("ANN LEE PARK" or
// "PARK, ANN LEE" for Ann Lee: another person), which the other-person check
// must still see.
function maskOwnName(lineToks, own, roster) {
	if (!own) return lineToks;
	const t = own.tokens;
	const n = t.length;
	const forms = [t];
	if (n >= 2) {
		forms.push([t[n - 1], ...t.slice(0, n - 1)]);
		forms.push([t[n - 1], t[0]]);
		forms.push([t[0][0], t[n - 1]]);
		forms.push([t[n - 1], t[0][0]]);
	}
	const keep = longerNameTokens(lineToks, own, roster);
	return lineToks.map((toks, li) => {
		const out = toks.slice();
		for (let i = 0; i < out.length; i++) {
			if (out[i] === own.compact) { if (!keep[li][i]) out[i] = ""; continue; }
			for (const f of forms) {
				if (i + f.length > out.length) continue;
				let hit = true;
				for (let k = 0; k < f.length; k++) if (out[i + k] !== f[k]) { hit = false; break; }
				if (!hit) continue;
				let kept = false;
				for (let k = 0; k < f.length; k++) if (keep[li][i + k]) kept = true;
				if (!kept) for (let k = 0; k < f.length; k++) out[i + k] = "";
				break;
			}
		}
		return out;
	});
}

function seqAt(toks, i, seq) {
	if (i + seq.length > toks.length) return false;
	for (let k = 0; k < seq.length; k++) if (toks[i + k] !== seq[k]) return false;
	return true;
}

// Per line, the tokens that spell (in order, or last name first) a roster name
// longer than the driver's that holds every word of his: another person.
// Bounded like namesAnotherPerson(): each word's places on the page are capped.
function longerNameTokens(lineToks, own, roster) {
	const keep = lineToks.map((toks) => new Uint8Array(toks.length));
	const people = roster && Array.isArray(roster.people) ? roster.people : [];
	const longer = people.filter((p) => p.tokens.length > own.tokens.length && !samePerson(p, own) && own.tokens.every((x) => p.tokens.includes(x)));
	if (!longer.length) return keep;
	const where = new Map();
	lineToks.forEach((toks, li) => toks.forEach((tok, ti) => {
		if (!tok) return;
		if (!where.has(tok)) where.set(tok, []);
		const list = where.get(tok);
		if (list.length < 2000) list.push([li, ti]);
	}));
	for (const p of longer) {
		const tk = p.tokens;
		for (const seq of [tk, [tk[tk.length - 1], ...tk.slice(0, -1)]]) {
			for (const [li, ti] of where.get(seq[0]) || []) {
				if (seqAt(lineToks[li], ti, seq)) for (let k = 0; k < seq.length; k++) keep[li][ti + k] = 1;
			}
		}
	}
	return keep;
}

function namesAnotherPerson(lineToks, roster, own) {
	const where = new Map();
	const all = new Set();
	lineToks.forEach((toks, li) => toks.forEach((tok, ti) => {
		if (!tok) return;
		all.add(tok);
		if (!where.has(tok)) where.set(tok, []);
		const list = where.get(tok);
		if (list.length < 2000) list.push([li, ti]);
	}));
	for (const p of roster.people) {
		if (own && samePerson(p, own)) continue;
		const t = p.tokens;
		const n = t.length;
		if (all.has(p.compact) && (n >= 2 || p.compact.length >= 4)) return true;
		if (n < 2) continue;
		const first = t[0];
		const last = t[n - 1];
		const tries = [t, [last, ...t.slice(0, n - 1)], [last, first]];
		if (last.length >= 3) tries.push([first[0], last], [last, first[0]]);
		for (const seq of tries) {
			for (const [li, ti] of where.get(seq[0]) || []) if (seqAt(lineToks[li], ti, seq)) return true;
		}
		if (first.length >= 2 && last.length >= 2 && all.has(first) && all.has(last)) return true;
	}
	return false;
}

// Every run of 1 to 3 neighbouring tokens on a line, joined: "XYZ 7788" and
// "XYZ-7788" both give "XYZ7788".
function windowsOf(lineToks) {
	const out = new Set();
	for (const toks of lineToks) {
		for (let i = 0; i < toks.length; i++) {
			let joined = "";
			for (let k = i; k < i + WINDOW && k < toks.length; k++) {
				if (!toks[k]) break;
				joined += toks[k];
				if (joined.length > 24) break;
				out.add(joined);
			}
		}
	}
	return out;
}

// The unit numbers written after a unit label: "UNIT 12", "TRUCK # T-2", "VEH NO 7".
function labelledUnits(lineToks) {
	const out = new Set();
	for (const toks of lineToks) {
		for (let i = 0; i < toks.length; i++) {
			if (!UNIT_LABELS.has(toks[i])) continue;
			let k = i + 1;
			let skipped = 0;
			while (k < toks.length && skipped < 2 && UNIT_FILLERS.has(toks[k])) { k++; skipped++; }
			let joined = "";
			for (let j = k; j < k + 2 && j < toks.length; j++) {
				if (!toks[j]) break;
				joined += toks[j];
				out.add(joined);
			}
		}
	}
	return out;
}

function namesAnotherTruck(lineToks, roster, ownUnit) {
	const own = roster.trucks.find((t) => t.unit === ownUnit) || null;
	const ownIds = new Set(own ? [own.unit, own.plate, own.vin].filter(Boolean) : []);
	const windows = windowsOf(lineToks);
	const units = labelledUnits(lineToks);
	for (const t of roster.trucks) {
		if (t.unit === ownUnit) continue;
		if (t.plate && t.plate.length >= 4 && !ownIds.has(t.plate) && windows.has(t.plate)) return true;
		if (t.vin && t.vin.length >= 11 && !ownIds.has(t.vin) && windows.has(t.vin)) return true;
		if (!ownIds.has(t.unit) && units.has(t.unit)) return true;
	}
	return false;
}

function namesAnotherCard(lineToks, roster, own) {
	for (const toks of lineToks) {
		for (const l4 of cardsInTokens(toks)) {
			const holders = roster.cards.get(l4);
			if (!holders || holders.size !== 1) continue;
			const [only] = holders.values();
			if (!own || !samePerson(only, own)) return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// The expense match (M2) and the statement shape.

const VENDOR_STOP = new Set(["THE", "INC", "LLC", "CORP", "CO", "STORE", "STATION", "TRAVEL", "CENTER", "CENTRE", "PLAZA", "STOP",
	"MART", "SHOP", "GAS", "FUEL", "AND", "OF", "TRUCK", "STOPS", "SERVICE", "SERVICES"]);

function vendorTokens(vendor) {
	return tokensOf(vendor).filter((t) => t.length >= 3 && /^[A-Z]+$/.test(t) && !VENDOR_STOP.has(t));
}

function expenseMatch(lines, lineToks, receipt) {
	const cents = Number.isInteger(receipt.amountCents) ? receipt.amountCents : Math.round(Number(receipt.amount) * 100);
	const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(receipt.date || "").slice(0, 10));
	let amount = false;
	let date = false;
	for (const line of lines) {
		if (!amount && Number.isInteger(cents) && cents > 0 && moneyCents(line).includes(cents)) amount = true;
		if (!date && day) {
			const [y, mo, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
			if (datesIn(line).some((x) => x.m === mo && x.d === d && (x.y === null || x.y === y))) date = true;
		}
		if (amount && date) break;
	}
	const want = vendorTokens(receipt.vendor);
	let vendor = false;
	if (want.length) {
		const have = new Set();
		for (const toks of lineToks) for (const t of toks) have.add(t);
		vendor = want.every((t) => have.has(t));
	}
	return (amount && date) || vendor;
}

function statementShape(lines, pageCount) {
	if (Number(pageCount) > 1) return true;
	let dated = 0;
	const days = new Set();
	for (const line of lines) {
		const ds = datesIn(line);
		if (!ds.length || !moneyCents(line).length) continue;
		dated++;
		days.add(dayKey(ds[0]));
		if (dated > 3 || (dated >= 2 && days.size >= 2)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------

// page: { text, unmapped, truncated }; receipt: { driver, truck, amountCents
// (or amount), date "YYYY-MM-DD", vendor, pageCount }.
function pageVerdict(page, roster, receipt) {
	const r = receipt || {};
	const p = page || {};
	const { lines, truncated } = pageLines(p.text);
	const own = personOf(r.driver);
	const toks = maskOwnName(lineTokens(lines), own, roster);
	const reasons = [];
	if (roster && namesAnotherPerson(toks, roster, own)) reasons.push(CODES.OTHER_PERSON);
	if (roster && namesAnotherTruck(toks, roster, compactId(r.truck))) reasons.push(CODES.OTHER_TRUCK);
	if (roster && namesAnotherCard(toks, roster, own)) reasons.push(CODES.OTHER_CARD);
	const readable = !p.unmapped && !p.truncated && !truncated && expenseMatch(lines, toks, r);
	if (!readable) reasons.push(CODES.UNREADABLE);
	if (statementShape(lines, r.pageCount)) reasons.push(CODES.STATEMENT);
	const code = SEVERITY.find((c) => reasons.includes(c)) || CODES.AUTO_RELEASED;
	return { code, reasons: reasons.length ? reasons : [CODES.AUTO_RELEASED] };
}

function codesOf(value) {
	const list = Array.isArray(value) ? value : String(value || "").split(",");
	return list.map((c) => String(c).trim()).filter((c) => VERDICT_CODES.has(c));
}
function otherCodes(value) {
	return codesOf(value).filter((c) => OTHER_CODES.includes(c));
}

// rows: receipt_pdf_pages rows of one receipt. The sorted page numbers that
// may reach the driver for the file `sha256` under the roster `rosterHash`.
function releasedPages(rows, { sha256, rosterHash } = {}) {
	const out = [];
	for (const row of rows || []) {
		if (!row || row.file_sha256 !== sha256 || !sha256) continue;
		if (row.roster_hash !== rosterHash || !rosterHash) continue;
		const page = Number(row.page);
		if (!Number.isInteger(page) || page < 1) continue;
		if (row.mark === "office") continue;
		const others = otherCodes(row.reason_codes);
		if (row.mark === "released") {
			if (row.mark_lapsed_at) continue;
			const acknowledged = new Set(otherCodes(row.mark_codes));
			if (others.every((c) => acknowledged.has(c))) out.push(page);
			continue;
		}
		if (row.verdict_code === CODES.AUTO_RELEASED && !others.length) out.push(page);
	}
	return [...new Set(out)].sort((a, b) => a - b);
}

// A released mark lapses when a later verdict finds an OTHER_* code the mark
// did not acknowledge: the page stays withheld until it is marked again.
function markLapses(row, reasons) {
	if (!row || row.mark !== "released" || row.mark_lapsed_at) return false;
	const acknowledged = new Set(otherCodes(row.mark_codes));
	return otherCodes(reasons).some((c) => !acknowledged.has(c));
}

module.exports = {
	CODES,
	OTHER_CODES,
	MARK_REASONS,
	MARKS,
	PAGE_TEXT_MAX,
	buildRoster,
	pageVerdict,
	releasedPages,
	markLapses,
	codesOf,
	otherCodes,
	cardLast4sFromDetails,
	// For the runner's checks on single rules.
	datesIn,
	moneyCents,
	statementShape,
	personOf,
	samePerson,
};
