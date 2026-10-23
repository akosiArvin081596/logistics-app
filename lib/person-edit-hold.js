// PERSON EDIT HOLD (2026-10-22): a Pickup or Drop-off Appointment a person
// corrected on an open load is never overwritten by a later rate-con email; the
// email raises an alert instead (server.js, POST /api/n8n/keep-stored-values).
//
// How "a person set this value" is known: the app records every value it tells
// n8n to write for these columns ("ratecon", or "ratecon_create" for a
// drag-and-drop create), the value already on the sheet the first time it sees a
// column ("baseline", the app's own, so an overlapping or failed write never makes
// a date from before the record look like a person's), and every date a person
// saves through LogisX ("person"), in load_cell_writes. A stored cell is a
// person's value when
//   1. the newest "person" row for the column is the same value and no newer
//      rate-con row exists (a LogisX edit), or
//   2. there is at least one recorded row and the stored value matches none of
//      them (a direct edit in the Google Sheet). In the hold's own decision
//      (decideColumn(), review L1, Arvin's yes 2026-10-22) only the app's own
//      writes ("ratecon", "ratecon_create", "baseline") clear a value: a person's
//      date put back in the sheet after an email replaced it is a person's date
//      again. personSet() called on its own keeps the wording above (Needs
//      Confirmation reads it).
// With no rows at all it is not (today's rule applies), and a blank stored cell
// never is (the email fills it, as today).
//
// Sheets reformats what the app writes (USER_ENTERED), so two cells are compared
// as moments (lib/cell-compare.js momentKey()). When two texts differ and either
// is a date momentKey() can't read ("10/06 14:00", "10/06", "10/6/26 14:00"), the
// answer is unknown, never a person's value. Two cells neither of which is a date
// (a time window Sheets keeps as text) compare as text, spaces collapsed.
//
// Pure: no network, DB or fs. Every pattern is bounded, and the date patterns
// only ever see text of at most DATE_TEXT_MAX characters.
"use strict";

const cellCompare = require("./cell-compare");

// The v1 columns: the pickup and drop-off dates, the same patterns as server.js's
// REISSUE_HELD_COLUMN_RES (pinned equal by scripts/test-person-edit-hold.js).
// Payment is not one of them (decision 2).
const PERSON_HOLD_COLUMN_RES = [/pickup.*appo|pickup.*date/i, /drop.?off.*appo|drop.?off.*date|delivery.*date|deliv.*appo/i];
const COLUMN_NAME_MAX = 200;
// The rows that say who set a value; the other sources (would_hold, held,
// format) are the shadow report's and prove nothing.
const MACHINE_SOURCES = new Set(["ratecon", "ratecon_create", "baseline"]);
const EVIDENCE_SOURCES = new Set(["ratecon", "ratecon_create", "baseline", "person"]);
const SOURCES = ["ratecon", "ratecon_create", "baseline", "person", "would_hold", "held", "format"];
const DATE_TEXT_MAX = 40;
// A cell shaped like one date, with an optional time, in any of the forms people
// and the extractor write ("10/06", "10/06 14:00", "10/6/26 14:00", "2026-10-6");
// a range or extra words ("10/7/2026 08:00-14:00 (FCFS)") is not one date.
const DATE_SHAPED_RE = /^\d{1,4}[/.-]\d{1,2}(?:[/.-]\d{1,4})?(?:(?:T|,?\s{1,3})\d{1,2}(?::\d{1,2}){0,2}(?:\s{0,3}[AaPp]\.?[Mm]\.?)?)?$/;

function text(v) {
	return v === undefined || v === null ? "" : String(v);
}
function blank(v) {
	return text(v).trim() === "";
}

// Whether a column (a sheet header or a body key) is one this rule holds.
function personHoldColumn(col) {
	const name = text(col).trim().slice(0, COLUMN_NAME_MAX);
	return name !== "" && PERSON_HOLD_COLUMN_RES.some((re) => re.test(name));
}

// A cell that is shaped like a date but momentKey() can't read.
function unreadableDate(v) {
	const s = text(v).trim();
	return s.length <= DATE_TEXT_MAX && DATE_SHAPED_RE.test(s) && cellCompare.momentKey(s) === null;
}

// Whether two cells of a date column say the same thing: true, false, or null
// (unknown: they differ and either is a date momentKey() can't read).
function sameCell(a, b) {
	const x = text(a).trim();
	const y = text(b).trim();
	if (x === y) return true;
	const kx = cellCompare.momentKey(x);
	const ky = cellCompare.momentKey(y);
	if (kx !== null && ky !== null) return kx === ky;
	if ((kx === null && unreadableDate(x)) || (ky === null && unreadableDate(y))) return null;
	if (kx !== null || ky !== null) return false;
	return x.replace(/\s+/g, " ") === y.replace(/\s+/g, " ");
}

// The recorded rows that count as evidence, oldest first (by id).
function evidenceRows(rows) {
	return (Array.isArray(rows) ? rows : [])
		.filter((r) => r && EVIDENCE_SOURCES.has(r.source) && !blank(r.value))
		.slice()
		.sort((p, q) => Number(p.id) - Number(q.id));
}
function newest(rows, pred) {
	for (let i = rows.length - 1; i >= 0; i--) if (pred(rows[i])) return rows[i];
	return null;
}

// Whether the stored cell is a person's value. rows: the load_cell_writes rows
// for this load and column ({ id, source, value, actor, at }), in any order.
// Answers { set: true | false | null, via, row }: via "person" (rule 1, row the
// person's row) or "sheet" (rule 2, row the newest recorded row, the edit came
// after it); set null when a comparison was unknown. onlyAppClears (the hold's
// rule 2, review L1): only the app's own writes clear the stored value.
function personSet(stored, rows, { onlyAppClears = false } = {}) {
	if (blank(stored)) return { set: false };
	const ev = evidenceRows(rows);
	if (!ev.length) return { set: false };
	const person = newest(ev, (r) => r.source === "person");
	const machine = newest(ev, (r) => MACHINE_SOURCES.has(r.source));
	if (person && (!machine || Number(machine.id) < Number(person.id)) && sameCell(stored, person.value) === true) {
		return { set: true, via: "person", row: person };
	}
	let unknown = false;
	for (const r of onlyAppClears ? ev.filter((x) => MACHINE_SOURCES.has(x.source)) : ev) {
		const s = sameCell(stored, r.value);
		if (s === true) return { set: false };
		if (s === null) unknown = true;
	}
	if (unknown) return { set: null };
	return { set: true, via: "sheet", row: ev[ev.length - 1] };
}

// The decision for one column of a found, open load: "hold" (a person's value and
// an email that really differs from it), "format" (it would turn on a date form
// that can't be read: today's write, logged), or "none" (today's rule). A blank
// sent value or a blank stored cell is always "none". Rule 2 here counts only the
// app's own writes as clearing a value (review L1); the answer still changes only
// with RATECON_PERSON_EDIT_HOLD_ENABLED on (off, a decision is a "would_hold" row).
function decideColumn({ stored, sent, rows }) {
	if (blank(sent) || blank(stored)) return { action: "none" };
	const same = sameCell(stored, sent);
	if (same === true) return { action: "none" };
	const p = personSet(stored, rows, { onlyAppClears: true });
	if (p.set === false) return { action: "none" };
	if (p.set === null || same === null) return { action: "format" };
	return { action: "hold", via: p.via, row: p.row };
}

// The edit a LogisX save made that an email write overwrote (R2, L7): the newest
// "person" row is newer than the newest rate-con row, yet the sheet holds an older
// rate-con value. Answers that person row, or null.
function lostEdit(stored, rows) {
	if (blank(stored)) return null;
	const ev = evidenceRows(rows);
	const person = newest(ev, (r) => r.source === "person");
	const machine = newest(ev, (r) => MACHINE_SOURCES.has(r.source));
	if (!person || !machine || Number(machine.id) > Number(person.id)) return null;
	if (sameCell(stored, person.value) !== false) return null;
	const older = ev.some((r) => MACHINE_SOURCES.has(r.source) && Number(r.id) < Number(person.id) && sameCell(stored, r.value) === true);
	return older ? person : null;
}

// "Oct 7" in timeZone, or "" for a time that can't be read.
function dayText(iso, timeZone) {
	const d = new Date(text(iso));
	if (Number.isNaN(d.getTime())) return "";
	try {
		return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
	} catch {
		return "";
	}
}

// The role an actor ("Dispatcher#12") names, as "a Dispatcher".
function actorRoleText(actor) {
	const role = text(actor).split("#")[0].replace(/[^A-Za-z ]/g, "").trim().slice(0, 40);
	return role ? `a ${role}` : "a person";
}

// How the person set it, for the hold reason: "in LogisX by a Dispatcher on Oct 8"
// or "in the sheet after the rate con of Oct 7".
function reasonPart(decision, timeZone) {
	const row = (decision && decision.row) || {};
	const day = dayText(row.at, timeZone);
	if (decision && decision.via === "person") return `in LogisX by ${actorRoleText(row.actor)}${day ? ` on ${day}` : ""}`;
	if (row.source === "person") return `in the sheet after a LogisX edit${day ? ` of ${day}` : ""}`;
	return `in the sheet after the rate con${day ? ` of ${day}` : ""}`;
}

// The hold reason for the held columns ([{ column, part }]).
function holdReason(entries) {
	const list = (entries || []).filter(Boolean);
	if (!list.length) return "";
	if (list.length === 1) return `a person corrected this date (${list[0].part})`;
	return `a person corrected these dates (${list.map((e) => `${text(e.column).trim()}: ${e.part}`).join("; ")})`;
}

// The reason added to a re-issue hold of every column that the person hold folded
// into (R2, L3).
function foldReason(columns) {
	const names = [...new Set((columns || []).map((c) => text(c).trim()).filter(Boolean))];
	return names.length ? `a person had corrected it (${names.join(", ")})` : "";
}

// The calendar day a cell names under a looser reading than momentKey() (for the
// shadow report): the first M/D[/Y] or Y-M-D in it, year optional. Or null.
function looseDay(v) {
	const s = text(v).trim().slice(0, DATE_TEXT_MAX * 2);
	let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
	if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
	m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(s);
	if (!m) return null;
	let y = m[3] === undefined ? null : Number(m[3]);
	if (y !== null && y < 100) y += 2000;
	return { y, m: Number(m[1]), d: Number(m[2]) };
}

// Whether two cells are the same calendar day under that looser reading (a year
// left out on either side matches any year).
function sameLooseDay(a, b) {
	const x = looseDay(a);
	const y = looseDay(b);
	if (!x || !y) return false;
	return x.m === y.m && x.d === y.d && (x.y === null || y.y === null || x.y === y.y);
}

// Whether a "would hold" between two cells needs a person's review before the flag
// goes on: either cell is one momentKey() can't read (a date form it doesn't know,
// or text such as a time window), so the rule may have read a format difference as
// a correction. Answers null for two readable moments (a real change, even on the
// same day: a new appointment time), else { sameDay } (sameLooseDay(), shown
// beside the mark).
function reviewMark(a, b) {
	const readable = cellCompare.momentKey(text(a).trim()) !== null && cellCompare.momentKey(text(b).trim()) !== null;
	return readable ? null : { sameDay: sameLooseDay(a, b) };
}

module.exports = {
	PERSON_HOLD_COLUMN_RES,
	SOURCES,
	personHoldColumn,
	unreadableDate,
	sameCell,
	personSet,
	decideColumn,
	lostEdit,
	reasonPart,
	holdReason,
	foldReason,
	looseDay,
	sameLooseDay,
	reviewMark,
	dayText,
};
