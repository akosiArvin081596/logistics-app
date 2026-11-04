"use strict";
// The note to C.H. Robinson's contact about a driver's approved days off: its text, the checks it must pass, one fixed
// order of states, the truck it names and the Message-ID it is drafted under. A person sends it from the company
// Gmail's Drafts; nothing here or in its wiring sends mail.
//
// The note names the driver, the truck and the days, and nothing else: its builder takes exactly
// { driverName, unit, from, to, todayKey } and throws on any other key, so no other field of a time-off row can reach
// it. No phone, kind, reason, carrier number or load-shaped number survives the checks.
//
// Pure: no network, database, files, environment or clock (the caller passes today and the time).

const crypto = require("crypto");
const chrEvents = require("./chr-events");
const autoInvoiceRules = require("./auto-invoice-rules");
const driverAvailability = require("./driver-availability");
const rateconReconcile = require("./ratecon-reconcile");

const INPUT_KEYS = Object.freeze(["driverName", "unit", "from", "to", "todayKey"]);
const CONTEXT_KEYS = Object.freeze(["draftOn", "recipientOk", "staffRecorded", "denyHits"]);
const STATES = Object.freeze(["past", "no_truck", "refused", "off", "no_recipient", "pending", "made", "failed", "by_hand"]);
// The states whose answer carries the line for staff to copy.
const LINE_STATES = Object.freeze(["off", "no_recipient", "failed", "by_hand"]);
// A failed draft whose row changed or failed a check stays failed: a Retry is refused for it.
const FINAL_STAGES = Object.freeze(["row_changed", "refused"]);
// appendGmailDraft()'s stages (lib/imap-draft.js), stored as given; anything else is "error".
const APPEND_STAGES = Object.freeze(["credentials", "mime", "greeting", "login", "append", "literal"]);
const NAME_MAX = 80;
// Longer text is refused before any cleaning runs on it.
const NAME_RAW_MAX = 400;
// A pending draft whose step never ended (a restart between the approval and Gmail) is offered a Retry after this.
const RETRY_AFTER_MS = 10 * 60 * 1000;
// Its own marker, never the invoice drafts' ".auto-invoice", so their Sent Mail searches can't take it for an invoice.
const MESSAGE_ID_MARK = "time-off-chr";
const PHONE_RUN_MIN = 10;

// CHR's own unit rule (lib/chr-events.js UNIT_RE; a runner pins the two equal).
const UNIT_RE = /^[A-Za-z0-9-]{1,12}$/;
// CHR's person-shaped values (lib/chr-events.js), found anywhere in the name or the unit, and a 7-digit phone split
// by a dot or a space as well as a dash.
const PERSON_SHAPES = Object.freeze([
	/(?<!\d)\d{3}[-. ]\d{4}(?!\d)/,
	/(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/,
	/(?<!\d)(?:\d{1,2}-\d{1,2}-(?:\d{4}|\d{2})|\d{4}-\d{1,2}-\d{1,2})(?!\d)/,
]);
const PLUS_DIGIT_RE = /\+[\s ]{0,3}\p{Nd}/u;
const DIGIT_RE = /\p{Nd}/u;
// What may sit between a phone's digits: spaces, dots, dashes and brackets.
const RUN_SEPARATOR_RE = /[\s.()[\]{}\-‐-―−]/u;
// Format characters (bidi controls, zero-width characters) are dropped; controls and line or paragraph separators
// become a space, so a line break can never start a second header.
const FORMAT_CHARS_RE = /\p{Cf}/gu;
const BREAK_CHARS_RE = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const LEFT_OVER_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const RECIPIENT_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}$/;
const WEEKDAYS = Object.freeze(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
const MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);

const isDay = driverAvailability.isAvailabilityDay;
const monthDay = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8, 10))}`;
// "Monday, Nov 9" (", 2026" with the year): the weekday from the UTC calendar, which no zone can shift.
function dayWords(key, withYear) {
	const ms = Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
	return `${WEEKDAYS[new Date(ms).getUTCDay()]}, ${monthDay(key)}${withYear ? `, ${key.slice(0, 4)}` : ""}`;
}

// The driver's name as the note writes it: trimmed, each run of spaces made one, format and control characters
// gone, at most NAME_MAX characters. "" when nothing usable is left or it is longer: never cut, so a number in it
// is never half-hidden from the checks.
function cleanDriverName(raw) {
	if (typeof raw !== "string" || raw.length > NAME_RAW_MAX) return "";
	const name = raw.replace(FORMAT_CHARS_RE, "").replace(BREAK_CHARS_RE, " ").replace(/\s+/g, " ").trim();
	if (!name || LEFT_OVER_RE.test(name) || [...name].length > NAME_MAX) return "";
	return name;
}

const personShaped = (v) => PERSON_SHAPES.some((re) => re.test(v));

// The truck's unit as the note writes it, held to CHR's unit rule and never person-shaped; "" otherwise.
function cleanUnit(raw) {
	const unit = String(raw == null ? "" : raw).trim();
	return UNIT_RE.test(unit) && !personShaped(unit) ? unit : "";
}

// The truck the note names, from the candidates in order (the driver's active assignment's truck, then the truck
// that names them): the first truck found decides, so a bad unit on it is no truck rather than another truck.
function chooseTruckUnit(candidates) {
	const truck = (Array.isArray(candidates) ? candidates : []).find((t) => t && typeof t === "object");
	return truck && truck.unit_number != null ? String(truck.unit_number) : "";
}

// The longest run of digits, counting the spaces, dots, dashes and brackets between them as part of it.
function longestDigitRun(text) {
	let best = 0;
	let run = 0;
	for (const ch of String(text)) {
		if (DIGIT_RE.test(ch)) {
			run++;
			if (run > best) best = run;
		} else if (!RUN_SEPARATOR_RE.test(ch)) {
			run = 0;
		}
	}
	return best;
}

// Whether the composed note fails a check: a phone (PHONE_RUN_MIN digits in a run, a "+" before digits, or a
// person-shaped name or unit), a carrier deny-list value, or any number the rate-con reconcile sweep would read as a
// load in the subject or the body (it reads the same mailbox, so a reply quoting the note must give it nothing).
function noteRefused({ subject, text }, name, unit, denyHits) {
	for (const t of [subject, text]) {
		if (longestDigitRun(t) >= PHONE_RUN_MIN || PLUS_DIGIT_RE.test(t) || denyHits(t)) return true;
	}
	if (personShaped(name) || personShaped(unit)) return true;
	return rateconReconcile.extractLoadNumbers(subject).length > 0
		|| rateconReconcile.extractLoadNumbers(text).length > 0
		|| rateconReconcile.extractLoadNumbersFromBody(text).length > 0;
}

function composeNote(name, unit, from, to) {
	const again = driverAvailability.shiftAvailabilityDay(to, 1);
	// Years are written when the days cross into another year, so no day reads as the wrong one.
	const years = from.slice(0, 4) !== again.slice(0, 4);
	const who = `Driver ${name}, LogisX truck ${unit}`;
	const days = from === to ? `on ${dayWords(from, years)}` : `from ${dayWords(from, years)} through ${dayWords(to, years)}`;
	return {
		subject: `${who}, unavailable ${driverAvailability.availabilityRangeText(from, to)}`,
		text: ["Hello,", "", `${who}, will be unavailable ${days} (planned time off). Available again from ${dayWords(again, years)}.`, "", "Thank you,", "LogisX Dispatch"].join("\n"),
	};
}

function strictKeys(value, keys, what) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${what} must be an object of ${keys.join(", ")}`);
	const given = Object.keys(value);
	const extra = given.filter((k) => !keys.includes(k));
	if (extra.length) throw new TypeError(`${what} takes only ${keys.join(", ")}; refused: ${extra.join(", ")}`);
	return given;
}

// The one decision, first step that applies wins: past, no_truck, refused (a failed check or an unusable name), then
// by_hand for a staff-recorded row, else off, no_recipient, pending. The line exists only once the checks pass.
// `input` is exactly INPUT_KEYS; `context` is { draftOn, recipientOk, staffRecorded, denyHits(text) }.
function chrDraftDecision(input, context) {
	const given = strictKeys(input, INPUT_KEYS, "chrDraftDecision() input");
	const missing = INPUT_KEYS.filter((k) => !given.includes(k));
	if (missing.length) throw new TypeError(`chrDraftDecision() input needs ${missing.join(", ")}`);
	strictKeys(context, CONTEXT_KEYS, "chrDraftDecision() context");
	const { driverName, unit, from, to, todayKey } = input;
	const { draftOn = false, recipientOk = false, staffRecorded = false, denyHits } = context;
	if (typeof denyHits !== "function") throw new TypeError("chrDraftDecision() context needs denyHits(text)");
	if (!isDay(from) || !isDay(to) || !isDay(todayKey) || to < from) return { state: "refused" };
	if (to < todayKey) return { state: "past" };
	const truck = cleanUnit(unit);
	if (!truck) return { state: "no_truck" };
	const name = cleanDriverName(driverName);
	if (!name) return { state: "refused" };
	const note = composeNote(name, truck, from, to);
	if (noteRefused(note, name, truck, denyHits)) return { state: "refused" };
	const line = note.subject;
	if (staffRecorded === true) return { state: "by_hand", line };
	if (draftOn !== true) return { state: "off", line };
	if (recipientOk !== true) return { state: "no_recipient", line };
	return { state: "pending", line, subject: note.subject, text: note.text, unit: truck };
}

// What an answer, a notice or the panel carries of a decision: the state, and the line only where staff copy it.
function chrDraftAnswer(decision) {
	const state = decision && STATES.includes(decision.state) ? decision.state : "refused";
	return LINE_STATES.includes(state) && typeof decision.line === "string" && decision.line ? { state, line: decision.line } : { state };
}

// The recipient setting as the draft's To: exactly one bare address on chrobinson.com itself (no display name, no
// list, no subdomain), else "". The value is never logged, answered or audited by any caller.
function chrRecipient(raw) {
	const s = String(raw == null ? "" : raw).trim();
	return RECIPIENT_RE.test(s) && autoInvoiceRules.emailDomain(s) === chrEvents.CHR_DOMAIN ? s : "";
}

// The carrier deny-list check, read as CHR's redactor reads it (lib/chr-events.js createRedactor()): the values stay
// in its closure, and only whether a text holds one comes out.
function createDenyCheck(denyList) {
	const redactor = chrEvents.createRedactor({ denyList: String(denyList == null ? "" : denyList) });
	return (text) => redactor.hits(text);
}

// A fresh Message-ID on the mailbox's own domain, in the shape lib/imap-draft.js accepts.
function newChrDraftMessageId(mailboxUser) {
	const at = String(mailboxUser || "").lastIndexOf("@");
	const domain = at >= 0 ? String(mailboxUser).slice(at + 1).toLowerCase() : "";
	return `<${crypto.randomUUID()}.${MESSAGE_ID_MARK}@${/^[a-z0-9.-]{1,128}$/.test(domain) ? domain : "logisx.invalid"}>`;
}

// The re-read before every append: the time-off row as it is now (with its directory name) must still be an
// approved, live, driver-made row on the draft's own days, not over, and the note on its current name must still
// pass every check. { ok: true, subject, text } or { ok: false, stage: "row_changed" | "refused" }.
function draftStillHolds({ row, draft, todayKey, recipientOk, denyHits }) {
	const live = !!row && !row.cancelled_at && row.request_status === "approved" && row.source === "driver";
	if (!draft || draft.state === "made" || !live || row.from_date !== draft.from_day || row.to_date !== draft.to_day) return { ok: false, stage: "row_changed" };
	const decided = chrDraftDecision({ driverName: row.directory_name, unit: draft.unit, from: draft.from_day, to: draft.to_day, todayKey },
		{ draftOn: true, recipientOk: recipientOk === true, staffRecorded: false, denyHits });
	if (decided.state === "past") return { ok: false, stage: "row_changed" };
	if (decided.state !== "pending") return { ok: false, stage: "refused" };
	return { ok: true, subject: decided.subject, text: decided.text };
}

const appendStage = (err) => (err && APPEND_STAGES.includes(err.stage) ? err.stage : "error");

// One attempt at the Gmail draft: the check right before the append (no await between), and on a Retry the search for
// the stored Message-ID first, whose failure or odd answer is never read as "absent". Resolves { state: "made" |
// "failed", stage, tried, found }; never rejects.
async function attemptChrDraft({ check, append, search = null }) {
	try {
		if (search) {
			const before = check();
			if (!before.ok) return { state: "failed", stage: before.stage, tried: false, found: "" };
			let seen;
			try {
				seen = await search();
			} catch {
				return { state: "failed", stage: "search", tried: false, found: "" };
			}
			if (!seen || typeof seen.found !== "boolean") return { state: "failed", stage: "search", tried: false, found: "" };
			if (seen.found) return { state: "made", stage: "", tried: false, found: typeof seen.mailbox === "string" ? seen.mailbox : "" };
		}
		const held = check();
		if (!held.ok) return { state: "failed", stage: held.stage, tried: false, found: "" };
		try {
			await append({ subject: held.subject, text: held.text });
		} catch (err) {
			return { state: "failed", stage: appendStage(err), tried: true, found: "" };
		}
		return { state: "made", stage: "", tried: true, found: "" };
	} catch {
		return { state: "failed", stage: "error", tried: false, found: "" };
	}
}

// Whether staff are offered a Retry: a failed draft whose row still holds and whose days aren't over, or a pending
// one older than RETRY_AFTER_MS by the server's clock.
function canRetry(draft, { nowMs, todayKey }) {
	if (!draft || !isDay(draft.to_day) || !isDay(todayKey) || draft.to_day < todayKey) return false;
	if (draft.state === "failed") return !FINAL_STAGES.includes(draft.last_stage);
	if (draft.state !== "pending") return false;
	const created = Date.parse(String(draft.created_at || ""));
	return Number.isFinite(created) && Number.isFinite(nowMs) && nowMs - created > RETRY_AFTER_MS;
}

// A draft as staff see it: { state, line?, canRetry, draftedOn? }. A failed draft's line is composed again from the
// stored unit and days and the driver's current directory name, and only while a Retry can still help; `draftedOn`
// is the business day it was made.
function draftView(draft, { driverName, todayKey, nowMs, draftedOn, denyHits }) {
	const retry = canRetry(draft, { nowMs, todayKey });
	const line = draft.state === "failed" && retry
		? chrDraftDecision({ driverName, unit: draft.unit, from: draft.from_day, to: draft.to_day, todayKey }, { draftOn: true, recipientOk: true, staffRecorded: false, denyHits }).line
		: "";
	return { state: draft.state, ...(line ? { line } : {}), canRetry: retry, ...(draft.state === "made" && isDay(draftedOn) ? { draftedOn } : {}) };
}

// Why a Retry is refused, or null: { status, code, error }.
function retryRefusal(draft, { nowMs, todayKey, inFlight }) {
	if (!draft) return { status: 404, code: "CHR_DRAFT_NOT_FOUND", error: "This time off has no note to CHR's contact." };
	if (draft.state === "made") return { status: 409, code: "CHR_DRAFT_MADE", error: "The note to CHR's contact is already in the company Gmail's Drafts." };
	if (inFlight) return { status: 409, code: "CHR_DRAFT_IN_FLIGHT", error: "The note to CHR's contact is being drafted now. Try again in a few minutes." };
	if (draft.state === "failed" && FINAL_STAGES.includes(draft.last_stage)) {
		return { status: 409, code: "CHR_DRAFT_ROW_CHANGED", error: "These days changed, were cancelled or are over, so no note is drafted. Tell CHR's contact by hand." };
	}
	if (!canRetry(draft, { nowMs, todayKey })) {
		if (draft.state === "pending") return { status: 409, code: "CHR_DRAFT_IN_FLIGHT", error: "The note to CHR's contact is being drafted now. Try again in a few minutes." };
		return { status: 409, code: "CHR_DRAFT_ROW_CHANGED", error: "These days changed, were cancelled or are over, so no note is drafted. Tell CHR's contact by hand." };
	}
	return null;
}

// The line staff get when an approved row with a draft is later cancelled or has its days changed; "" for none.
// `draftedOn` is the business day the draft was made.
function laterChangeNote({ state, draftedOn } = {}) {
	if (state === "made") return `CHR's contact was drafted about these days${isDay(draftedOn) ? ` on ${monthDay(draftedOn)}` : ""}: tell them about this change.`;
	if (state === "pending" || state === "failed") return "A note to CHR's contact about the old days may be in Gmail Drafts: check it before sending anything, and tell them about this change if it went out.";
	return "";
}

module.exports = {
	INPUT_KEYS,
	STATES,
	LINE_STATES,
	FINAL_STAGES,
	APPEND_STAGES,
	NAME_MAX,
	RETRY_AFTER_MS,
	MESSAGE_ID_MARK,
	UNIT_RE,
	cleanDriverName,
	cleanUnit,
	chooseTruckUnit,
	longestDigitRun,
	chrDraftDecision,
	chrDraftAnswer,
	chrRecipient,
	createDenyCheck,
	newChrDraftMessageId,
	draftStillHolds,
	attemptChrDraft,
	canRetry,
	draftView,
	retryRefusal,
	laterChangeNote,
};
