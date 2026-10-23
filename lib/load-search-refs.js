// The reference numbers a dashboard row can be found by besides its Load ID
// (B19): the broker's Order #, PO #, Move #, the labelled references in Pickup
// Info / Drop-off Info, and the BOL number in Documents.
//
// WHY. A load is stored under one number (the rate con's load number, which for
// some brokers is a LEG number), but the broker, its paperwork and its AP desk
// ask about it by others. The dashboard's search matched the Load ID only, so
// those loads could not be found. GET /api/dashboard now calls
// annotateLoadSearchRefs() on the rows it serves, and the browser matches them
// (client/src/lib/loadSearch.js; the two normalizeRef() copies are pinned equal
// by scripts/test-load-search-client.mjs).
//
// RULES (scripts/test-load-search-refs.js):
//   - Pickup Info / Drop-off Info: only a value right after a label (REF/PU, PU,
//     DEL, Delivery, Appointment, APPT, PO, XID, REF) followed by ":" or "#", so
//     "PO Box 12" never counts. A list after a label splits on ";" and ",".
//     Unlabelled numbers (dock, store, year, phone, ZIP) are never indexed, nor
//     a time (HHMM, HHMM-HHMM) after APPT / Appointment.
//   - A value is one token of letters, digits, "-" and "." (40 at most), kept
//     only when its normalized form has 4+ characters, a digit and only letters
//     and digits, and it is not a calendar date. Documents never gives a lone
//     year.
//   - Aliases (ratecon_load_aliases): for every dashboard role, label "Order #".
//   - Drafts (load_invoice_drafts): only when includeDraftRefs is exactly true
//     (Super Admin; QB1 open). Only load_id, invoice_id, order_number and the
//     overrides' poNumber / moveNumber are selected: the recipient, the broker
//     name, the totals, the notes and the rest of overrides_json never leave
//     SQLite. Only all-digit tokens are kept ("$" amounts removed first).
//   - One query per table per call, matched to rows by normalizeLoadId().
//   - Each row gets `_refs: [{ label, value }]`, value as written (trimmed),
//     de-duplicated on its normalized form, its own Load ID dropped, 20 at most;
//     a row with none gets no `_refs` key.
//
// ⚠️ CALL IT ONLY ON ROWS AS SERVED. The dashboard calls it after
// sanitizeBrokerColumns(), on request-local copies from liveJobTrackingView():
// it writes `_refs` onto the rows it is given, so a cached row must never reach
// it (strict mode makes that a logged failure, scripts/test-jt-cache-isolation.js).
// It reads no withheld broker column either way. No other route serves `_refs`;
// the restore preview (restorePlanFor() in server.js) annotates its own copies
// to find a deleted load's possible duplicates, and serves none of them.
//
// A failed query logs one console.error and the rows keep their sheet
// references; it never throws, so the dashboard still answers.

"use strict";

const { normalizeLoadId } = require("./ratecon-load");

const MAX_REFS_PER_ROW = 20;
const MAX_VALUE_LENGTH = 40;
// Longer cells are read up to here: a reference sits near its label, and every
// pattern below then runs on bounded text.
const MAX_CELL_LENGTH = 2000;

const ALIAS_SQL = "SELECT alias, load_id FROM ratecon_load_aliases";
const DRAFT_SQL = "SELECT load_id, invoice_id, order_number, " +
	"CASE WHEN json_valid(overrides_json) THEN json_extract(overrides_json, '$.poNumber') END AS po_number, " +
	"CASE WHEN json_valid(overrides_json) THEN json_extract(overrides_json, '$.moveNumber') END AS move_number " +
	"FROM load_invoice_drafts ORDER BY id DESC";

// The one comparison rule, on both sides of the search: lowercase, drop "#",
// whitespace, "-" and ".". client/src/lib/loadSearch.js holds the same function.
function normalizeRef(v) {
	return String(v == null ? "" : v).toLowerCase().replace(/[#\s.-]/g, "");
}

const MONTH = "(0?[1-9]|1[0-2])";
const DAY = "(0?[1-9]|[12]\\d|3[01])";
const DATE_RES = [
	new RegExp(`^\\d{4}[/.-]${MONTH}[/.-]${DAY}$`),
	new RegExp(`^${MONTH}[/.-]${DAY}([/.-](\\d{2}|\\d{4}))?$`),
];

function isSearchableValue(v) {
	const text = String(v == null ? "" : v).trim();
	if (!text || text.length > MAX_VALUE_LENGTH) return false;
	const n = normalizeRef(text);
	if (n.length < 4 || !/^[a-z0-9]+$/.test(n) || !/\d/.test(n)) return false;
	return !DATE_RES.some((re) => re.test(text));
}

const TOKEN_CHAR_RE = /[A-Za-z0-9.-]/;
function cellText(v) {
	if (typeof v !== "string") return "";
	if (v.length <= MAX_CELL_LENGTH) return v;
	// Never end on half a token: the rest of it is past the cut.
	let end = MAX_CELL_LENGTH;
	if (TOKEN_CHAR_RE.test(v[end])) while (end > 0 && TOKEN_CHAR_RE.test(v[end - 1])) end--;
	return v.slice(0, end);
}

// Strip what ends a sentence or a range from a token ("2700011." / "7000001-").
function trimToken(t) {
	return t.replace(/[.-]{1,40}$/, "");
}

// Labels, longest first so "REF/PU" wins over "REF" and "PU". The label is a
// whole word followed by ":" or "#" (optionally "#:"), up to 3 spaces apart.
const LABEL_RE = /\b(REF\/PU|DELIVERY|APPOINTMENT|APPT|XID|REF|DEL|PU|PO)[ \t]{0,3}(?:#[ \t]{0,3}:?|:)/gi;
const LABEL_NAMES = {
	"REF/PU": "REF/PU #", DELIVERY: "Delivery #", APPOINTMENT: "Appointment #", APPT: "APPT #",
	XID: "XID", REF: "REF #", DEL: "DEL #", PU: "PU #", PO: "PO #",
};
// An appointment label often holds a time or a time range ("APPT: 0800-1400"),
// never a reference: HHMM and HHMM-HHMM after APPT / Appointment are dropped.
const APPOINTMENT_LABELS = new Set(["APPT #", "Appointment #"]);
const HHMM = "([01]\\d|2[0-3])[0-5]\\d";
const TIME_VALUE_RE = new RegExp(`^${HHMM}(-${HHMM})?$`);
// One token, whole: it must end where the token characters end, so a value
// longer than MAX_VALUE_LENGTH is dropped rather than cut.
const FIRST_TOKEN_RE = /^[ \t]{0,3}([A-Za-z0-9][A-Za-z0-9.-]{0,39})(?![A-Za-z0-9.-])/;
const NEXT_TOKEN_RE = /^[ \t]{0,3}[;,][ \t]{0,3}([A-Za-z0-9][A-Za-z0-9.-]{0,39})(?![A-Za-z0-9.-])/;

// Pickup Info / Drop-off Info: [{ label, value }] for each labelled value.
function labelledRefs(cell) {
	const text = cellText(cell);
	if (!text) return [];
	const labels = [];
	LABEL_RE.lastIndex = 0;
	let m;
	while ((m = LABEL_RE.exec(text))) {
		labels.push({ name: LABEL_NAMES[m[1].toUpperCase()], start: m.index, end: LABEL_RE.lastIndex });
	}
	const out = [];
	labels.forEach((label, i) => {
		let rest = text.slice(label.end, i + 1 < labels.length ? labels[i + 1].start : text.length);
		let t = FIRST_TOKEN_RE.exec(rest);
		while (t) {
			const value = trimToken(t[1]);
			const isTime = APPOINTMENT_LABELS.has(label.name) && TIME_VALUE_RE.test(value);
			if (!isTime && isSearchableValue(value)) out.push({ label: label.name, value });
			rest = rest.slice(t[0].length);
			t = NEXT_TOKEN_RE.exec(rest);
		}
	});
	return out;
}

// Documents: the BOL number n8n writes there (else the load number, dropped
// later as the row's own), a POD word or a date. Each whitespace / ";" / ","
// separated piece is one candidate, whole, so "9/15/2030" never yields "2030",
// and a lone year ("15 Sep 2030") is never one.
function documentRefs(cell) {
	const text = cellText(cell).replace(/\bBOL[ \t]{0,3}(?:#[ \t]{0,3}:?|:)?/gi, " ");
	const out = [];
	for (const piece of text.split(/[\s;,]+/)) {
		if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$/.test(piece)) continue;
		const value = trimToken(piece);
		if (!/^(19|20)\d\d$/.test(value) && isSearchableValue(value)) out.push({ label: "BOL #", value });
	}
	return out;
}

// A draft field (order number, PO, move, invoice id): only its numbers. "$"
// amounts go first, so "7000001-$700 ADV" gives "7000001" and "$1,500 ADV"
// nothing; a token is kept only when it is all digits once normalized, so
// "ADV700" never passes ("09012030-3" does).
function draftValues(v) {
	if (v == null) return [];
	const text = cellText(typeof v === "number" ? String(v) : v).replace(/\$[ \t]{0,3}[\d,]{0,20}(\.\d{0,2})?/g, " ");
	const out = [];
	for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9.-]{0,39}(?![A-Za-z0-9.-])/g)) {
		const value = trimToken(m[0]);
		if (/^\d+$/.test(normalizeRef(value)) && isSearchableValue(value)) out.push(value);
	}
	return out;
}

function findHeader(headers, re) {
	return (Array.isArray(headers) ? headers : []).find((h) => re.test(String(h == null ? "" : h))) || null;
}

function annotateLoadSearchRefs({ db, headers, rows, includeDraftRefs = false, logger = console } = {}) {
	if (!Array.isArray(rows) || rows.length === 0) return rows || [];
	const log = (msg) => { try { logger.error(msg); } catch { /* a broken logger never breaks the dashboard */ } };
	try {
		const loadIdCol = findHeader(headers, /load.?id|job.?id/i);
		const pickupCol = findHeader(headers, /pick.?up.*info/i);
		const dropCol = findHeader(headers, /(drop.?off|delivery).*info/i);
		const docsCol = findHeader(headers, /^\s*documents?\s*$/i);

		const byLoad = new Map();
		for (const row of rows) {
			if (!row || typeof row !== "object") continue;
			const key = loadIdCol ? normalizeLoadId(row[loadIdCol]) : "";
			if (!key) continue;
			if (!byLoad.has(key)) byLoad.set(key, []);
			byLoad.get(key).push(row);
		}
		const fromDb = new Map();
		const attach = (loadId, label, list) => {
			const targets = byLoad.get(normalizeLoadId(loadId));
			if (!targets || !list.length) return;
			for (const row of targets) {
				if (!fromDb.has(row)) fromDb.set(row, []);
				for (const value of list) fromDb.get(row).push({ label, value });
			}
		};
		if (db && byLoad.size) {
			try {
				for (const a of db.prepare(ALIAS_SQL).all()) attach(a.load_id, "Order #", draftValues(a.alias));
			} catch (err) {
				log(`[load-search] alias references unavailable: ${err && err.message}`);
			}
			if (includeDraftRefs === true) {
				try {
					for (const d of db.prepare(DRAFT_SQL).all()) {
						attach(d.load_id, "Order #", draftValues(d.order_number));
						attach(d.load_id, "PO #", draftValues(d.po_number));
						attach(d.load_id, "Move #", draftValues(d.move_number));
						attach(d.load_id, "Invoice #", draftValues(d.invoice_id));
					}
				} catch (err) {
					log(`[load-search] invoice draft references unavailable: ${err && err.message}`);
				}
			}
		}

		for (const row of rows) {
			if (!row || typeof row !== "object") continue;
			const candidates = [
				...(fromDb.get(row) || []),
				...(pickupCol ? labelledRefs(row[pickupCol]) : []),
				...(dropCol ? labelledRefs(row[dropCol]) : []),
				...(docsCol ? documentRefs(row[docsCol]) : []),
			];
			const own = loadIdCol ? normalizeRef(row[loadIdCol]) : "";
			const seen = new Set();
			const out = [];
			for (const c of candidates) {
				const value = String(c.value).trim();
				const key = normalizeRef(value);
				if (!key || key === own || seen.has(key)) continue;
				seen.add(key);
				out.push({ label: c.label, value });
				if (out.length === MAX_REFS_PER_ROW) break;
			}
			if (out.length) row._refs = out;
		}
	} catch (err) {
		log(`[load-search] references not attached: ${err && err.message}`);
	}
	return rows;
}

module.exports = {
	ALIAS_SQL,
	DRAFT_SQL,
	MAX_REFS_PER_ROW,
	annotateLoadSearchRefs,
	documentRefs,
	draftValues,
	isSearchableValue,
	labelledRefs,
	normalizeRef,
};
