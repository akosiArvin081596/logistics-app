// Broker contact data, by VALUE, for every response a non-Super-Admin can get.
//
// THE RULE (the owner, 2026-09-26 and 2026-10-15). Dispatchers, Drivers,
// Investors and signed-out callers get no broker emails or phones in any API
// response, whatever column or field holds them. A Super Admin's responses are
// unchanged. server.js decides the role; everything here is for a
// non-Super-Admin caller.
//
// WHY BY VALUE. The reader once blanked broker columns by HEADER only
// (BROKER_WITHHELD_RE in server.js: "Broker Contact Name", "Phone Number",
// "Email"). A value under any other header was served as stored: Job
// Tracking's "Contract ID" holds the broker's email on a block of 2025 rows, and
// "Details", "Pickup Info" and "Drop-off Info" are free text that can hold either.
//
// THE DECISIONS (2026-10-15):
//   - every email and every formatted phone in any field is withheld, facility
//     phones included (a pattern cannot tell a broker's number from a
//     facility's, so it fails closed). A bare digit run is never a phone: load,
//     BOL, PU and PO numbers are bare digits;
//   - contact inside text becomes "[contact withheld]"; a cell that holds only
//     contact data is served blank;
//   - the row's own broker contact (its withheld columns: phone, email, the
//     agent's name) is also hidden wherever it appears in another cell, its
//     phone matched on digits, so a bare-digit copy is caught too;
//   - a cell that holds contact data is read-only for a non-Super-Admin: a save
//     that sends it back as stored or as served keeps the stored value, and one
//     that sends anything else is refused (409 CONTACT_CELL_READ_ONLY), never
//     dropped without a word (restoreContactCells());
//   - an email or phone typed into Contract ID is refused for every role,
//     judged only on a cell whose value changed (400 CONTACT_NOT_ALLOWED,
//     contactNotAllowedRefusal());
//   - the rate-con extract answer is redacted whole for a non-Super-Admin, and
//     the server keeps the original for the create that follows
//     (redactRateConFields(), createRateConStash(), rateConCreateFields()).
//
// Pure: no network, DB or fs (crypto hashing only). Every pattern is bounded
// and linear in the text: the text comes from rate cons, emails and sheet cells.
"use strict";

const crypto = require("crypto");

const WITHHELD_TEXT = "[contact withheld]";

// ------------------------------------------------------------------ patterns
// Horizontal whitespace, and the characters a phone's groups are split with:
// hyphen-minus, the Unicode hyphens and dashes (U+2010-U+2015), minus (U+2212),
// a dot and a slash.
const SP = "[ \\t\\u00a0]";
const DASH = "[\\-\\u2010-\\u2015\\u2212./]";
const SEP = `(?:${SP}{0,2}${DASH}${SP}{0,2}|${SP}{1,3})`;
// "+1" / "1-" / "1 " / "+1(" before the area code.
const PREFIX = `(?:\\+${SP}{0,2}1${SEP}?|1${SEP})?`;
// "(555) ", "(555)", "555-", "555 ", "555." ...
const AREA = `(?:\\(${SP}{0,2}\\d{3}${SP}{0,2}\\)${SP}{0,2}|\\d{3}${SEP})`;
// An extension stays with its number: "ext. 12", "ext 12", "x12", "extension 12".
const EXT = `(?:${SP}{0,3}[,;]?${SP}{0,3}(?:ext\\.?|extension|x)${SP}{0,3}\\d{1,6}(?!\\d))?`;

// A formatted North American number: 3-3-4 digits with a separator (or the area
// code's parentheses) between the groups. Never a bare digit run.
const NANP_RE = new RegExp(`(?<![\\d+])${PREFIX}${AREA}\\d{3}${SEP}\\d{4}(?!\\d)${EXT}`, "gi");
// "+" then 8 to 15 digits, in one run ("+15550100150") or as a country code and
// two or more groups split by spaces or dashes ("+52 55 1234 5678"); the digit
// count is checked on each match. No dot or slash here, so a signed amount
// ("+1500.50") is never read as a phone.
const PLUS_SEP = `(?:${SP}{0,2}[\\-\\u2010-\\u2015\\u2212]${SP}{0,2}|${SP}{1,3})`;
const PLUS_RE = new RegExp(`\\+${SP}{0,2}(?:\\d{8,15}|\\d{1,4}(?:${PLUS_SEP}\\d{1,5}){2,5})(?!\\d)`, "g");
// A formatted number cut by an ellipsis (a value shortened for display):
// "555-010-01…", "(555) 01...".
const CUT_PHONE_RE = new RegExp(`(?<![\\d+])${PREFIX}${AREA}\\d{1,3}(?:${SEP}\\d{0,3})?(?=\\u2026|\\.\\.\\.)`, "g");
// local@domain.tld, with an optional "mailto:" in front. Every quantifier is
// bounded; labels are split by "." so the domain never backtracks across them.
const LOCAL = "[A-Za-z0-9._%+'!#$&*=?^~\\-]{1,64}";
const EMAIL_RE = new RegExp(`(?:mailto:)?${LOCAL}@(?:[A-Za-z0-9\\-]{1,63}\\.){1,8}[A-Za-z]{2,24}`, "gi");
// An email cut by an ellipsis: "agent.one@exam…".
const CUT_EMAIL_RE = new RegExp(`(?:mailto:)?${LOCAL}@[A-Za-z0-9.\\-]{0,253}(?=\\u2026|\\.\\.\\.)`, "gi");

// What may remain of a cell once its contact data is taken out, for the cell
// to count as holding only contact data (and so be served blank).
const ONLY_PUNCTUATION_RE = /^[\s,;:|/<>()[\]{}"'.*\-‐-―−]*$/;
// Placeholder names that must never be matched as an agent's name elsewhere.
const PLACEHOLDER_NAME_RE = /^(n\/?a|none|null|unknown|tbd|tba|blank|not provided|-+)$/i;
const MAX_NAME = 80;
const MAX_DEPTH = 20;

function digitsOf(s) {
	return String(s).replace(/\D/g, "");
}

// The ten digits of a North American number, or "" ("1" + ten digits counts).
function tenDigits(digits) {
	if (digits.length === 10) return digits;
	if (digits.length === 11 && digits[0] === "1") return digits.slice(1);
	return "";
}

function collect(re, text, kind, out, accept) {
	re.lastIndex = 0;
	let m;
	while ((m = re.exec(text))) {
		if (!m[0]) { re.lastIndex++; continue; }
		if (!accept || accept(m[0])) out.push({ start: m.index, end: m.index + m[0].length, kind });
	}
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Sorted, overlapping or touching ranges merged; an email in <angle brackets>
// takes its brackets with it.
function mergeRanges(text, ranges) {
	for (const r of ranges) {
		if (r.start > 0 && text[r.start - 1] === "<" && text[r.end] === ">") { r.start -= 1; r.end += 1; }
	}
	ranges.sort((a, b) => a.start - b.start || b.end - a.end);
	const out = [];
	for (const r of ranges) {
		const last = out[out.length - 1];
		if (last && r.start <= last.end) {
			if (r.end > last.end) last.end = r.end;
			if (last.kind !== r.kind) last.kind = "contact";
		} else {
			out.push({ ...r });
		}
	}
	return out;
}

// Every email and phone in `text` by the general patterns, as merged
// { start, end, kind } ranges ("email", "phone", or "contact" for a merge of
// both). The digit and "@" checks keep the patterns off text that cannot match.
function countDigits(text, enough) {
	let n = 0;
	for (let i = 0; i < text.length && n < enough; i++) {
		const c = text.charCodeAt(i);
		if (c >= 48 && c <= 57) n++;
	}
	return n;
}

function findContact(text) {
	if (typeof text !== "string" || !text) return [];
	const ranges = [];
	const cut = text.includes("…") || text.includes("...");
	if (text.includes("@")) {
		collect(EMAIL_RE, text, "email", ranges);
		if (cut) collect(CUT_EMAIL_RE, text, "email", ranges);
	}
	const digits = countDigits(text, 10);
	if (digits >= 10) collect(NANP_RE, text, "phone", ranges);
	if (cut && digits >= 4) collect(CUT_PHONE_RE, text, "phone", ranges);
	if (digits >= 8 && text.includes("+")) {
		collect(PLUS_RE, text, "phone", ranges, (m) => {
			const n = digitsOf(m).length;
			return n >= 8 && n <= 15;
		});
	}
	return mergeRanges(text, ranges);
}

function hasContact(text) {
	return findContact(text).length > 0;
}

// ------------------------------------------------------------ the row's own
// The contact a row (or a rate con) carries in its withheld columns: the
// emails, the phones as their ten digits, and the agent's names. Built from
// [label, value] pairs; `label` decides whether a plain value is a name.
// A JSON blob ({"Name": ..., "Phone": ...}) is read key by key.
function ownContact(entries) {
	const own = { emails: new Set(), phones: new Set(), names: new Set() };
	const addText = (label, value, depth = 0) => {
		if (value == null || depth > MAX_DEPTH) return;
		if (typeof value === "number") value = String(value);
		if (typeof value === "object") {
			for (const [k, v] of Object.entries(value)) addText(Array.isArray(value) ? label : k, v, depth + 1);
			return;
		}
		if (typeof value !== "string") return;
		const s = value.trim();
		if (!s) return;
		if (depth === 0 && /^[{[]/.test(s) && s.length <= 10000) {
			try { addText(label, JSON.parse(s), depth + 1); return; } catch { /* not JSON: read as text */ }
		}
		const found = findContact(s);
		for (const r of found) {
			const part = s.slice(r.start, r.end);
			if (part.includes("@")) {
				own.emails.add(part.replace(/^<|>$/g, "").replace(/^mailto:/i, "").toLowerCase());
			} else {
				const ten = tenDigits(digitsOf(part.replace(/(?:ext\.?|extension|x)\s*\d{1,6}\s*$/i, "")));
				if (ten) own.phones.add(ten);
			}
		}
		// A bare number in a phone cell ("5550100142").
		if (!found.length && s.length <= 24 && /^\+?[\d\s().\-‐-―]+$/.test(s)) {
			const ten = tenDigits(digitsOf(s));
			if (ten) own.phones.add(ten);
		}
		// A name: a cell labelled as one, holding no email or phone and no digits.
		if (!found.length && /name/i.test(String(label || "")) && s.length >= 3 && s.length <= MAX_NAME
			&& !/\d/.test(s) && (s.match(/[A-Za-z]/g) || []).length >= 3 && !PLACEHOLDER_NAME_RE.test(s)) {
			own.names.add(s.replace(/\s+/g, " "));
		}
	};
	for (const [label, value] of entries || []) addText(label, value);
	return own;
}

// The patterns for the row's own phones and names, compiled once per `own`.
const OWN_PATTERNS = new WeakMap();
function ownPatterns(own) {
	let p = OWN_PATTERNS.get(own);
	if (p) return p;
	const sep = "[\\s().\\-\\u2010-\\u2015\\u2212/]{0,3}";
	p = {
		phones: [...(own.phones || [])].map((ten) => new RegExp(
			`(?<!\\d)(?:\\+?1${sep})?${ten.slice(0, 3)}${sep}${ten.slice(3, 6)}${sep}${ten.slice(6)}(?!\\d)`, "g")),
		names: [...(own.names || [])].map((name) => new RegExp(
			`(?<![A-Za-z0-9])${escapeRe(name).replace(/ /g, "\\s{1,3}")}(?![A-Za-z0-9])`, "gi")),
	};
	OWN_PATTERNS.set(own, p);
	return p;
}

// The row's own contact found in `text`: each phone by its digits whatever the
// separators (a bare-digit copy too), each email in any letter case, each name
// as a whole word in any letter case.
function ownRanges(text, own) {
	const ranges = [];
	if (!own || typeof own !== "object") return ranges;
	const p = ownPatterns(own);
	if (p.phones.length && countDigits(text, 10) >= 10) {
		for (const re of p.phones) collect(re, text, "phone", ranges);
	}
	if (own.emails && own.emails.size && text.includes("@")) {
		const low = text.toLowerCase();
		for (const e of own.emails) {
			let at = low.indexOf(e);
			while (at >= 0) {
				ranges.push({ start: at, end: at + e.length, kind: "email" });
				at = low.indexOf(e, at + e.length);
			}
		}
	}
	for (const re of p.names) collect(re, text, "name", ranges);
	return ranges;
}

// ---------------------------------------------------------------- redaction
// { text, changed }. Contact inside text becomes "[contact withheld]"; a value
// that holds only contact data becomes "". Anything that is not a non-empty
// string comes back as it is.
function redactContactText(value, own) {
	if (typeof value !== "string" || !value) return { text: value, changed: false };
	const ranges = mergeRanges(value, [...findContact(value), ...ownRanges(value, own)]);
	if (!ranges.length) return { text: value, changed: false };
	let out = "";
	let rest = "";
	let at = 0;
	for (const r of ranges) {
		out += value.slice(at, r.start) + WITHHELD_TEXT;
		rest += value.slice(at, r.start);
		at = r.end;
	}
	out += value.slice(at);
	rest += value.slice(at);
	return { text: ONLY_PUNCTUATION_RE.test(rest) ? "" : out, changed: true };
}

// The same over any JSON value: every string, at any depth, keys unchanged. A
// value nested past MAX_DEPTH is served as null.
function redactContactDeep(value, own, depth = 0) {
	if (depth > MAX_DEPTH) return null;
	if (typeof value === "string") return redactContactText(value, own).text;
	if (Array.isArray(value)) return value.map((v) => redactContactDeep(v, own, depth + 1));
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = redactContactDeep(v, own, depth + 1);
		return out;
	}
	return value;
}

function withheldHeaders(headers, withheldRe) {
	return (headers || []).filter((h) => withheldRe.test(String(h == null ? "" : h)));
}

// The row's own contact, from its withheld columns as stored.
function rowOwnContact(row, withheld) {
	return ownContact(withheld.map((h) => [h, row ? row[h] : ""]));
}

// Copies of `rows` (header-keyed objects) with EVERY value but the withheld
// columns' (`withheldRe` over the header) put through redactContactText() with
// the row's own contact: a blank-header column, a derived `_` field
// (`_pickupStreet`, `_dropLocation`, `_refs` ...), at any depth. The withheld
// columns are left as stored, for the caller to blank (server.js
// sanitizeBrokerColumns() does, and keeps that rule's one home there). Call it
// last, after the route's enrichment. A row with a sheet column redacted this
// way carries `_withheldCells: [header, ...]`, so the editor can show that cell
// read-only. The rows given are never changed (they can be the shared Job
// Tracking cache).
function redactLoadValues(headers, rows, { withheldRe } = {}) {
	if (!(withheldRe instanceof RegExp)) throw new TypeError("redactLoadValues: withheldRe must be a RegExp");
	const withheld = withheldHeaders(headers, withheldRe);
	const withheldSet = new Set(withheld);
	const headerSet = new Set((headers || []).map((h) => String(h == null ? "" : h)));
	return (rows || []).map((row) => {
		const cleaned = { ...row };
		const own = rowOwnContact(row, withheld);
		const cellsWithheld = [];
		for (const key of Object.keys(cleaned)) {
			if (withheldSet.has(key) || key === "_withheldCells") continue;
			const v = cleaned[key];
			if (typeof v === "string") {
				const r = redactContactText(v, own);
				if (!r.changed) continue;
				cleaned[key] = r.text;
				if (headerSet.has(key)) cellsWithheld.push(key);
			} else if (v && typeof v === "object") {
				cleaned[key] = redactContactDeep(v, own);
			}
		}
		if (cellsWithheld.length) cleaned._withheldCells = cellsWithheld;
		else delete cleaned._withheldCells;
		return cleaned;
	});
}

// The whole row as served to a non-Super-Admin: redactLoadValues() (when
// `values` is on: the kill switch BROKER_CONTACT_VALUE_REDACTION_ENABLED in
// server.js), then every withheld column that holds anything is "".
function redactLoadRows(headers, rows, { withheldRe, values = true } = {}) {
	if (!(withheldRe instanceof RegExp)) throw new TypeError("redactLoadRows: withheldRe must be a RegExp");
	const withheld = withheldHeaders(headers, withheldRe);
	const source = values ? redactLoadValues(headers, rows, { withheldRe }) : (rows || []).map((row) => ({ ...row }));
	return source.map((cleaned) => {
		for (const col of withheld) {
			if (cleaned[col]) cleaned[col] = "";
		}
		return cleaned;
	});
}

// ------------------------------------------------------------------ writers
function cellText(v) {
	return v == null ? "" : String(v);
}

function columnName(headers, i) {
	const header = headers && headers[i] != null ? String(headers[i]) : "";
	return { header, name: header.trim() || `Column ${i + 1}`, field: header.trim() ? header : "(unnamed)" };
}

// PUT /api/data/:rowIndex and PUT /api/load/:loadId, for a non-Super-Admin,
// with value redaction on, after restoreWithheldBrokerCells(): a cell whose
// STORED value holds contact data (as redactLoadRows() judges it, with the
// row's own contact) is read-only. Sent back as stored or as it was served
// (trimmed alike), it is written back as stored; sent with anything else, the
// save is refused: returns the 409 body
// { error, code: "CONTACT_CELL_READ_ONLY", field } for the first such cell in
// column order, before anything is written. Otherwise null.
// Mutates `values`, the row as it will be written, in header order; `before`
// is the row as stored. A cell past the end of `values` is not written, so it is
// not judged. Withheld columns are restoreWithheldBrokerCells()'s and are
// skipped here.
function restoreContactCells(headers, before, values, { withheldRe } = {}) {
	if (!(withheldRe instanceof RegExp)) throw new TypeError("restoreContactCells: withheldRe must be a RegExp");
	const withheld = new Set(withheldHeaders(headers, withheldRe));
	const stored = {};
	(headers || []).forEach((h, i) => { stored[h] = before[i]; });
	const own = rowOwnContact(stored, [...withheld]);
	for (let i = 0; i < values.length; i++) {
		const h = headers && headers[i] != null ? String(headers[i]) : "";
		if (withheld.has(h)) continue;
		const from = cellText(before[i]);
		if (!from) continue;
		const served = redactContactText(from, own);
		if (!served.changed) continue;
		const to = cellText(values[i]);
		if (to === from || to.trim() === from.trim() || to.trim() === served.text.trim()) {
			values[i] = before[i];
			continue;
		}
		const { name, field } = columnName(headers, i);
		return {
			error: `"${name}" holds broker contact details, which only a Super Admin can change. Reload the load and save it again without changing "${name}".`,
			code: "CONTACT_CELL_READ_ONLY",
			field,
		};
	}
	return null;
}

// PUT /api/data/:rowIndex, PUT /api/load/:loadId and POST /api/data, for every
// caller: an email or a formatted phone in a column `columnRe` names (Contract
// ID) is refused, 400 { error, code: "CONTACT_NOT_ALLOWED", field }, for the
// first CHANGED such cell. A cell equal to its stored value is never refused,
// so a stored legacy email resent unchanged (or put back by
// restoreContactCells()) does not block an unrelated edit. `before` is the row
// as stored ([] for a new row) and `values` the row as it will be written.
const CONTRACT_ID_RE = /^\s*contract\s*id\s*$/i;
function contactNotAllowedRefusal(headers, before, values, { columnRe = CONTRACT_ID_RE } = {}) {
	for (let i = 0; i < values.length; i++) {
		const { header, name, field } = columnName(headers, i);
		if (!columnRe.test(header)) continue;
		const to = cellText(values[i]);
		if (to === cellText(before[i])) continue;
		if (!hasContact(to)) continue;
		return {
			error: `"${name}" can't hold an email address or a phone number. Enter the contract or reference number instead.`,
			code: "CONTACT_NOT_ALLOWED",
			field,
		};
	}
	return null;
}

// ------------------------------------------------------- dispatch notices
// One value of a notice body as the dispatch room may see it: redacted, and a
// value that was only contact data reads "[contact withheld]" (not blank, which
// would claim the value was empty).
function redactNoticeValue(value) {
	const r = redactContactText(cellText(value));
	return r.changed && !r.text.trim() ? WITHHELD_TEXT : r.text;
}

function parseJsonObject(s) {
	if (s && typeof s === "object") return s;
	try {
		const v = JSON.parse(String(s == null ? "" : s));
		return v && typeof v === "object" ? v : null;
	} catch {
		return null;
	}
}

// A dispatch_notifications row as served to a non-Super-Admin: title, body and
// metadata redacted. A re-issue notice ("ratecon-reissue-held") stored before
// value redaction (its metadata has no `valuesRedacted`) cut each value at 100
// characters, which can split a phone or an email below what the patterns
// catch, so it is served with its column names only, each value
// "[contact withheld]": from metadata.fields when present, else from the body's
// "Column: old → new; ..." parts. Returns a new object; other fields unchanged.
function redactDispatchNotice(notice) {
	const n = { ...(notice || {}) };
	const meta = parseJsonObject(n.metadata);
	if (n.type === "ratecon-reissue-held" && !(meta && meta.valuesRedacted === true)) {
		const columns = meta && Array.isArray(meta.fields) && meta.fields.length
			? meta.fields.map((f) => `${cellText(f && f.column)}${f && f.kind === "held" ? " (held)" : ""}`)
			: cellText(n.body).split("; ").filter((p) => p.includes(": ")).map((p) => p.slice(0, p.indexOf(": ")));
		n.body = columns.map((c) => `${c}: ${WITHHELD_TEXT}`).join("; ");
	}
	if (typeof n.title === "string") n.title = redactNoticeValue(n.title);
	if (typeof n.body === "string") n.body = redactContactText(n.body).text;
	if (n.metadata != null) {
		n.metadata = meta ? JSON.stringify(redactContactDeep(meta)) : redactContactText(cellText(n.metadata)).text;
	}
	return n;
}

// ---------------------------------------------------------------- rate cons
// The extract answer for a non-Super-Admin: every field whose NAME reads as
// broker contact (`withheldRe`: Broker Name, Broker Phone, Broker Email,
// Documents Email) is null, and every other value goes through
// redactContactDeep() with that contact as the rate con's own.
function rateConOwnContact(fields, withheldRe) {
	return ownContact(Object.entries(fields || {}).filter(([k]) => withheldRe.test(k)));
}
function redactRateConFields(fields, { withheldRe } = {}) {
	if (!(withheldRe instanceof RegExp)) throw new TypeError("redactRateConFields: withheldRe must be a RegExp");
	const src = fields || {};
	const own = rateConOwnContact(src, withheldRe);
	const out = {};
	for (const [k, v] of Object.entries(src)) out[k] = withheldRe.test(k) ? null : redactContactDeep(v, own);
	return out;
}

// The fields POST /api/loads/from-ratecon writes for a non-Super-Admin.
// `original` is the extract's own answer for the same PDF (createRateConStash()),
// or null when the server holds none.
//   - Every contact field (`withheldRe`) is the original's, never what the
//     client sent; "" when there is no original.
//   - Any other field sent exactly as it was served (redactRateConFields()) is
//     the original's, so a value served with "[contact withheld]" in it is
//     written as the rate con had it; a field the person changed is written as
//     sent.
// Returns { fields, missed }: `missed` is true when there was no original, so
// every contact field was left blank.
function rateConCreateFields(sent, original, { withheldRe } = {}) {
	if (!(withheldRe instanceof RegExp)) throw new TypeError("rateConCreateFields: withheldRe must be a RegExp");
	const out = { ...(sent || {}) };
	const keys = new Set([...Object.keys(out), ...Object.keys(original || {})]);
	const served = original ? redactRateConFields(original, { withheldRe }) : null;
	const text = (v) => (v != null && typeof v === "object" ? JSON.stringify(v) : cellText(v)).trim();
	for (const k of keys) {
		if (withheldRe.test(k)) {
			out[k] = original && original[k] != null ? original[k] : "";
			continue;
		}
		if (!original || !Object.prototype.hasOwnProperty.call(out, k)) continue;
		const redacted = text(served[k]) !== text(original[k]);
		if (redacted && text(out[k]) === text(served[k])) out[k] = original[k];
	}
	return { fields: out, missed: !original };
}

// The key a rate con's fields are kept under between the extract and the
// create: SHA-256 of the PDF's base64, with the data-URL prefix and edge
// whitespace removed as both routes remove them. "" for no PDF.
function rateConStashKey(pdfBase64) {
	if (typeof pdfBase64 !== "string") return "";
	const base64 = pdfBase64.replace(/^data:application\/pdf;base64,/, "").trim();
	if (!base64) return "";
	return crypto.createHash("sha256").update(base64).digest("hex");
}

// The extract's original fields, in memory, keyed by rateConStashKey(): kept
// `ttlMs` (30 min), at most `max` entries (the oldest goes first). Read with
// get(); an entry stays until it expires, so a create retried after a 409 still
// finds it.
function createRateConStash({ ttlMs = 30 * 60 * 1000, max = 200, now = () => Date.now() } = {}) {
	const entries = new Map();
	const prune = () => {
		const t = now();
		for (const [k, e] of entries) {
			if (e.expires <= t) entries.delete(k);
		}
	};
	return {
		put(key, fields) {
			if (!key) return;
			prune();
			entries.delete(key);
			entries.set(key, { fields: { ...(fields || {}) }, expires: now() + ttlMs });
			while (entries.size > max) entries.delete(entries.keys().next().value);
		},
		get(key) {
			if (!key) return null;
			const e = entries.get(key);
			if (!e) return null;
			if (e.expires <= now()) { entries.delete(key); return null; }
			return { ...e.fields };
		},
		get size() { prune(); return entries.size; },
	};
}

// The server's one stash: POST /api/loads/ratecon/extract puts, POST
// /api/loads/from-ratecon gets.
const rateConStash = createRateConStash();

module.exports = {
	WITHHELD_TEXT,
	CONTRACT_ID_RE,
	findContact,
	hasContact,
	ownContact,
	redactContactText,
	redactContactDeep,
	redactLoadValues,
	redactLoadRows,
	restoreContactCells,
	contactNotAllowedRefusal,
	redactNoticeValue,
	redactDispatchNotice,
	redactRateConFields,
	rateConCreateFields,
	rateConStashKey,
	createRateConStash,
	rateConStash,
};
