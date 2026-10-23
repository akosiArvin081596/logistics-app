// "NEEDS CONFIRMATION" PICKUPS (Arvin, 2026-10-21; plan
// ~/LogisX-replica/reports/2026-10-21-needs-confirmation-pickup-plan.md, Revision 3,
// decisions N1-N12): when a rate con marks the pickup "Needs Confirmation", the load
// gets a Needs Review reason ("confirm the real pickup date") instead of the date being
// treated as firm. Display only: nothing that pays reads it.
//
// - Detection (detectNeedsConfirmation()): C.H. Robinson's line "Scheduled Pick-up Date,
//   Needs Confirmation" in the rate con's built-in text or in Gemini's Pickup
//   Notes/Instructions, plus a bounded generic pattern on the notes only (decision 1). A
//   bare "TBD" never fires. The answer holds booleans only, never a date or any text.
// - The in-memory reading (createPickupReadingStore()): kept by load number for a TTL,
//   at most `max` loads; two PDFs of one load within the TTL are OR-ed.
// - The record decision (recordDecision()): what keep-stored-values or a drag-and-drop
//   create does to the load's ratecon_pickup_readings row. A record is created only from
//   a reading with the phrase; an existing one is updated without one, and never cleared
//   by a later rate con (decision 12 (a)). A held Pickup Appointment leaves it untouched.
// - The review code (reviewCode()): the dashboard's `_review` entry for one load. "A
//   person's date" is lib/person-edit-hold.js personSet() over load_cell_writes: this
//   module keeps no person test of its own (Revision 3, M3).
//
// Pure: no network, DB or fs. Every quantifier that runs on rate-con text is bounded, and
// the inputs are cut first (path-backend.md).
"use strict";

const personEditHold = require("./person-edit-hold");
const cellCompare = require("./cell-compare");
const kpiWeight = require("./kpi-weight");

const NOTES_MAX_CHARS = 2000;
// C.H. Robinson's shipper-instruction line, line breaks and spacing allowed, "Pickup"
// with or without the hyphen.
const CHR_PHRASE_RE = /Scheduled[ \t\r\n]{1,8}Pick[ \t\r\n-]{0,3}up[ \t\r\n]{1,8}Date[ \t\r\n,]{1,8}Needs?[ \t\r\n]{1,8}Confirmation/i;
// The generic pattern (decision 1), on Gemini's notes only: a pickup date, time or
// appointment said to need confirmation, to be confirmed or scheduled, unconfirmed,
// pending or TBD/TBA, within 40 characters on the same sentence.
const GENERIC_RE = /pick[ \t-]{0,3}up[ \t]{0,3}(?:date|time|appointment|appt)[^.\n]{0,40}?(?:needs?[ \t]{1,3}confirmation|to[ \t]{1,3}be[ \t]{1,3}(?:confirmed|scheduled)|unconfirmed|pending|\bTB[DA]\b)/i;

const MODAL_WARNING = "The rate con marks the pickup date 'Needs Confirmation'. Check it before creating the load.";

const CODE_OPEN = "pickup_unconfirmed";
const CODE_CLOSED = "pickup_unconfirmed_closed";
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const CANCELLED_RE = /^(cancel|canceled|cancelled)$/i;

function text(v) {
	return v === undefined || v === null ? "" : String(v);
}
function blank(v) {
	return text(v).trim() === "";
}

// { needsConfirmation, by } from the rate con's built-in text and Gemini's pickup notes:
// by "text", "notes", "text+notes" or "".
function detectNeedsConfirmation({ text: pdfText = "", notes = "" } = {}) {
	const body = typeof pdfText === "string" ? pdfText.slice(0, kpiWeight.MAX_TEXT_CHARS) : "";
	const note = typeof notes === "string" ? notes.slice(0, NOTES_MAX_CHARS) : "";
	const inText = body !== "" && CHR_PHRASE_RE.test(body);
	const inNotes = note !== "" && (CHR_PHRASE_RE.test(note) || GENERIC_RE.test(note));
	return { needsConfirmation: inText || inNotes, by: byText(inText, inNotes) };
}

function byText(inText, inNotes) {
	return [inText ? "text" : "", inNotes ? "notes" : ""].filter(Boolean).join("+");
}
function bySet(by) {
	const s = text(by);
	return { text: /(^|\+)text(\+|$)/.test(s), notes: /(^|\+)notes(\+|$)/.test(s) };
}

// Two readings of one load OR-ed: the phrase in either, and where it was found.
function mergeReadings(a, b) {
	if (!a) return b ? { needsConfirmation: Boolean(b.needsConfirmation), by: text(b.by) } : null;
	if (!b) return { needsConfirmation: Boolean(a.needsConfirmation), by: text(a.by) };
	const x = bySet(a.by);
	const y = bySet(b.by);
	return { needsConfirmation: Boolean(a.needsConfirmation || b.needsConfirmation), by: byText(x.text || y.text, x.notes || y.notes) };
}

// The readings of recent rate cons, by load key: note() OR-s a reading into the one kept
// for that load (while it is younger than ttlMs), get() answers it or null. At most
// `max` loads, the oldest dropped first.
function createPickupReadingStore({ ttlMs = 10 * 60 * 1000, max = 200 } = {}) {
	const entries = new Map();
	const prune = (now) => {
		for (const [k, v] of entries) {
			if (now - v.at < ttlMs) break;
			entries.delete(k);
		}
	};
	return {
		note(key, reading, now = Date.now()) {
			if (!key || !reading) return null;
			prune(now);
			const before = entries.get(key);
			const merged = mergeReadings(before && now - before.at < ttlMs ? before : null, reading);
			entries.delete(key);
			entries.set(key, { ...merged, at: now });
			while (entries.size > max) entries.delete(entries.keys().next().value);
			return merged;
		},
		get(key, now = Date.now()) {
			const hit = key ? entries.get(key) : undefined;
			return hit && now - hit.at < ttlMs ? { needsConfirmation: hit.needsConfirmation, by: hit.by } : null;
		},
		get size() { return entries.size; },
	};
}

// What one rate con does to the load's record. existing: the row or null; reading: the
// rate con's reading or null; pickupSent: the Pickup Appointment the write sends (blank
// for none); held: the Pickup Appointment is held (re-issue or person hold). Answers
// { action: "none" | "insert" | "update", needsConfirmation, by }.
function recordDecision({ existing = null, reading = null, pickupSent = "", held = false } = {}) {
	if (held || blank(pickupSent)) return { action: "none" };
	const phrase = Boolean(reading && reading.needsConfirmation);
	if (!existing) {
		return phrase ? { action: "insert", needsConfirmation: true, by: text(reading.by) } : { action: "none" };
	}
	const was = Boolean(Number(existing.needs_confirmation));
	const by = phrase ? mergeReadings({ needsConfirmation: was, by: existing.detected_by }, reading).by : text(existing.detected_by);
	return { action: "update", needsConfirmation: was || phrase, by };
}

// The calendar day a Pickup Appointment cell names ("YYYY-MM-DD"), read as written (no
// zone), or "" when it can't be read with its year.
function cellDay(v) {
	const k = cellCompare.momentKey(text(v).trim());
	if (k) return k.slice(0, 10);
	const loose = personEditHold.looseDay(v);
	if (!loose || loose.y === null) return "";
	const day = `${String(loose.y).padStart(4, "0")}-${String(loose.m).padStart(2, "0")}-${String(loose.d).padStart(2, "0")}`;
	const ms = Date.parse(`${day}T12:00:00Z`);
	return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? day : "";
}

// A later rate con replaced a person's date: the newest "person" row is older than the
// newest rate-con row, and the two values differ (only possible with the person hold
// off, or on a load it doesn't protect).
function replacedPersonDate(rows) {
	const ev = (Array.isArray(rows) ? rows : []).filter((r) => r && !blank(r.value)).slice().sort((p, q) => Number(p.id) - Number(q.id));
	let person = null;
	let machine = null;
	for (const r of ev) {
		if (r.source === "person") person = r;
		else if (r.source === "ratecon" || r.source === "ratecon_create") machine = r;
	}
	return Boolean(person && machine && Number(machine.id) > Number(person.id) && personEditHold.sameCell(machine.value, person.value) === false);
}

// One load's review entry, or null. record: its ratecon_pickup_readings row; stored: the
// sheet's Pickup Appointment; cellRows: load_cell_writes rows for that column; status: the
// load's status cell; months: loadRowAccountingMonths() (null or [] = can't be placed);
// isClosed(month): the month is closed (periodWriteLocked()); firstTap: firstPickupTap().
// Answers { code, stored?, arrived?, closedMonth?, replaced? } (days "YYYY-MM-DD").
function reviewCode({ record = null, stored = "", cellRows = [], status = "", months = null, isClosed = () => true, firstTap = null } = {}) {
	if (!record || !Number(record.needs_confirmation)) return null;
	if (CANCELLED_RE.test(text(status).trim())) return null;
	if (blank(stored)) return null;
	// A person's date (a LogisX edit, "Mark pickup confirmed", or a sheet edit), or one the
	// record can't place: no code. The hold's rule (#588): only the app's own writes clear a
	// value, so a person's date put back in the sheet after an email replaced it counts again.
	if (personEditHold.personSet(stored, cellRows, { onlyAppClears: true }).set !== false) return null;
	const storedDay = cellDay(stored);
	const tapDay = firstTap && DAY_KEY_RE.test(text(firstTap.day)) ? firstTap.day : "";
	// The driver reached the shipper on the stored day: confirmed.
	if (tapDay && storedDay && tapDay === storedDay) return null;
	if (!Array.isArray(months) || !months.length) return null;
	const list = [...new Set(months.filter((m) => MONTH_KEY_RE.test(text(m))))].sort();
	if (!list.length) return null;
	const closed = list.filter((m) => isClosed(m));
	// Wholly in closed months: never raised (closed months stay as recorded).
	if (closed.length === list.length) return null;
	const out = { code: closed.length ? CODE_CLOSED : CODE_OPEN };
	if (storedDay) out.stored = storedDay;
	if (tapDay) out.arrived = tapDay;
	if (closed.length) out.closedMonth = storedDay && closed.includes(storedDay.slice(0, 7)) ? storedDay.slice(0, 7) : closed[0];
	if (replacedPersonDate(cellRows)) out.replaced = true;
	return out;
}

// Whether the Pickup Appointment a drag-and-drop create sends differs from the one the
// extract read: the same text (spaces collapsed) or the same moment is kept; anything
// else a person changed in the review modal.
function pickupChangedInModal(extracted, sent) {
	const a = text(extracted).trim().replace(/\s+/g, " ");
	const b = text(sent).trim().replace(/\s+/g, " ");
	if (a === b) return false;
	return personEditHold.sameCell(a, b) !== true;
}

module.exports = {
	CHR_PHRASE_RE,
	GENERIC_RE,
	NOTES_MAX_CHARS,
	MODAL_WARNING,
	CODE_OPEN,
	CODE_CLOSED,
	detectNeedsConfirmation,
	mergeReadings,
	createPickupReadingStore,
	recordDecision,
	cellDay,
	replacedPersonDate,
	reviewCode,
	pickupChangedInModal,
};
