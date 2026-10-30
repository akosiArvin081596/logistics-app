// ============================================================
// A driver's emergency contacts: the rules (EMERGENCY_CONTACTS_ENABLED)
// ============================================================
// Two to five people per Driver account, each a name, how they are related to
// the driver and a phone number. server.js stores them in
// driver_emergency_contacts and calls these checks before every write; the
// client's copy (client/src/lib/emergencyContacts.js) is pinned equal by a
// runner once it exists.
//
// Pure: no require, no process, no clock. Every checker is total (it never
// throws). Length caps run before any per-character walk, and every pattern
// tests one character, so no input can make a check slow.

"use strict";

const MIN_CONTACTS = 2;
const MAX_CONTACTS = 5;
const CONTACT_NAME_MAX = 80;
const RELATIONSHIP_MAX = 40;
const PHONE_RAW_MAX = 32;
// More entries than this and the body is not read at all.
const BODY_MAX_ENTRIES = 20;
const RELATIONSHIP_SUGGESTIONS = Object.freeze(["Spouse", "Partner", "Parent", "Child", "Sibling", "Relative", "Friend", "Other"]);

// What each refusal says. The client maps the code to its own text; these are
// for any other caller.
const REFUSAL_TEXT = Object.freeze({
	INVALID_BODY: "The contact list could not be read.",
	EMERGENCY_CONTACTS_MIN: "Add at least two contacts.",
	EMERGENCY_CONTACTS_MAX: "You can add up to five contacts.",
	CONTACT_NAME_INVALID: "Enter the contact's name.",
	CONTACT_RELATIONSHIP_INVALID: "Enter how this person is related to the driver.",
	CONTACT_PHONE_INVALID: "Enter a 10-digit US or Canadian number, or an international number starting with +.",
	CONTACT_PHONE_DUPLICATE: "Each contact needs a different phone number.",
});

// One character each.
const WHITESPACE_RE = /^[\t\n\v\f\r\p{Zs}]$/u;
const FORBIDDEN_RE = /^[\p{C}\p{Zl}\p{Zp}]$/u;
const LETTER_RE = /^\p{L}$/u;

// A name or relationship as stored: trimmed, each run of whitespace one space,
// no control, format or private-use character, at least one letter, and at
// most `max` characters as sent.
function cleanContactText(raw, max) {
	if (typeof raw !== "string" || raw.length > max) return { ok: false };
	let value = "";
	let space = false;
	let letter = false;
	for (const ch of raw) {
		if (WHITESPACE_RE.test(ch)) { space = value.length > 0; continue; }
		if (FORBIDDEN_RE.test(ch)) return { ok: false };
		if (space) { value += " "; space = false; }
		value += ch;
		if (!letter && LETTER_RE.test(ch)) letter = true;
	}
	return value && letter ? { ok: true, value } : { ok: false };
}

// NXX: first digit 2-9, and not N11 (211, 311, ... 911 are service codes).
function nanpCodeOk(three) {
	return three[0] >= "2" && three[0] <= "9" && !(three[1] === "1" && three[2] === "1");
}

function nanpDisplay(ten) {
	return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// A phone number as stored (E.164) and as shown. Digits, spaces, - . ( ) and
// one leading +. Ten digits, or 1 and ten, is a US or Canadian number: +1 and
// the ten digits, shown (XXX) XXX-XXXX. A + and another country code is 8 to
// 15 digits, the first not 0, stored and shown as + and the digits. No
// extensions.
function normalizePhone(raw) {
	if (typeof raw !== "string" || raw.length > PHONE_RAW_MAX) return { ok: false };
	const text = raw.trim();
	const plus = text.startsWith("+");
	let digits = "";
	for (const ch of plus ? text.slice(1) : text) {
		if (ch >= "0" && ch <= "9") digits += ch;
		else if (ch !== " " && ch !== "-" && ch !== "." && ch !== "(" && ch !== ")") return { ok: false };
	}
	let ten = null;
	if (plus) {
		if (digits.startsWith("1")) {
			if (digits.length !== 11) return { ok: false };
			ten = digits.slice(1);
		} else {
			if (digits.length < 8 || digits.length > 15 || digits[0] === "0") return { ok: false };
			return { ok: true, e164: `+${digits}`, display: `+${digits}` };
		}
	} else if (digits.length === 10) {
		ten = digits;
	} else if (digits.length === 11 && digits[0] === "1") {
		ten = digits.slice(1);
	} else {
		return { ok: false };
	}
	if (!nanpCodeOk(ten.slice(0, 3)) || !nanpCodeOk(ten.slice(3, 6))) return { ok: false };
	return { ok: true, e164: `+1${ten}`, display: nanpDisplay(ten) };
}

// How a stored number is shown: a US or Canadian one as (XXX) XXX-XXXX, any
// other value as stored (an international number, or a refreshed copy's
// placeholder).
function phoneDisplay(stored) {
	const s = typeof stored === "string" ? stored : "";
	return s.length === 12 && s.startsWith("+1") && /^\d{10}$/.test(s.slice(2)) ? nanpDisplay(s.slice(2)) : s;
}

// The last 4 digits of a stored number: all the audit trail ever keeps of it.
function phoneLast4(stored) {
	let digits = "";
	for (const ch of typeof stored === "string" ? stored : "") if (ch >= "0" && ch <= "9") digits += ch;
	return digits.slice(-4);
}

function refusal(status, code, index) {
	return { ok: false, status, code, ...(index === undefined ? {} : { index }), error: REFUSAL_TEXT[code] };
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A PUT body { contacts: [{ id?, name, relationship, phone }, ...] } as the
// list to store, in order (position 1 first): { ok: true, list: [{ id|null,
// position, name, relationship, phone (E.164) }] }, or the first refusal:
// 400 INVALID_BODY (the shape), 422 EMERGENCY_CONTACTS_MIN / _MAX, or a field's
// 422 with its index, entries checked in list order.
function validateContactList(body) {
	if (!isPlainObject(body) || !Array.isArray(body.contacts) || body.contacts.length > BODY_MAX_ENTRIES) {
		return refusal(400, "INVALID_BODY");
	}
	const entries = body.contacts;
	const ids = new Set();
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (!isPlainObject(e)) return refusal(400, "INVALID_BODY", i);
		if (e.id === undefined || e.id === null) continue;
		if (!Number.isSafeInteger(e.id) || e.id <= 0 || ids.has(e.id)) return refusal(400, "INVALID_BODY", i);
		ids.add(e.id);
	}
	if (entries.length < MIN_CONTACTS) return refusal(422, "EMERGENCY_CONTACTS_MIN");
	if (entries.length > MAX_CONTACTS) return refusal(422, "EMERGENCY_CONTACTS_MAX");
	const list = [];
	const phones = new Set();
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		const name = cleanContactText(e.name, CONTACT_NAME_MAX);
		if (!name.ok) return refusal(422, "CONTACT_NAME_INVALID", i);
		const relationship = cleanContactText(e.relationship, RELATIONSHIP_MAX);
		if (!relationship.ok) return refusal(422, "CONTACT_RELATIONSHIP_INVALID", i);
		const phone = normalizePhone(e.phone);
		if (!phone.ok) return refusal(422, "CONTACT_PHONE_INVALID", i);
		if (phones.has(phone.e164)) return refusal(422, "CONTACT_PHONE_DUPLICATE", i);
		phones.add(phone.e164);
		list.push({ id: e.id === undefined || e.id === null ? null : e.id, position: i + 1, name: name.value, relationship: relationship.value, phone: phone.e164 });
	}
	return { ok: true, list };
}

// The fields a change can name, in the order an audit line lists them.
const CHANGE_FIELDS = ["position", "name", "relationship", "phone"];

// What storing `list` (validateContactList()'s) over the driver's stored rows
// changes: { adds, changes: [{ id, fields, before, after }], deletes, unknown }.
// `unknown` holds ids in the list that are not among the rows; the caller
// refuses those before writing anything.
function diffContacts(currentRows, list) {
	const byId = new Map((currentRows || []).map((r) => [r.id, r]));
	const kept = new Set();
	const out = { adds: [], changes: [], deletes: [], unknown: [] };
	for (const c of list || []) {
		if (c.id === null) { out.adds.push({ position: c.position, name: c.name, relationship: c.relationship, phone: c.phone }); continue; }
		const row = byId.get(c.id);
		if (!row) { out.unknown.push(c.id); continue; }
		kept.add(c.id);
		const before = { position: row.position, name: row.contact_name, relationship: row.relationship, phone: row.contact_phone };
		const after = { position: c.position, name: c.name, relationship: c.relationship, phone: c.phone };
		const fields = CHANGE_FIELDS.filter((f) => before[f] !== after[f]);
		if (fields.length) out.changes.push({ id: c.id, fields, before, after });
	}
	for (const r of currentRows || []) {
		if (!kept.has(r.id)) out.deletes.push({ id: r.id, position: r.position, phone: r.contact_phone });
	}
	return out;
}

// One audit line for an add, a change or a delete. It names the driver, his
// account, the contact's id and position, which fields changed and the last 4
// digits of a number; never the contact's name or relationship, whatever
// `facts` holds. `driver` arrives already made safe for one audit line.
//   add / delete: { driver, userId, contactId, position, phone }
//   change: { driver, userId, contactId, fields, before: { position, phone }, after: { position, phone } }
function auditDetail(kind, facts) {
	const f = facts || {};
	const who = `Driver ${f.driver} (user ${f.userId}): contact ${f.contactId}`;
	if (kind === "add") return `${who} added at position ${f.position}, phone ending ${phoneLast4(f.phone)}`;
	if (kind === "delete") return `${who} deleted from position ${f.position}, phone ending ${phoneLast4(f.phone)}`;
	const before = f.before || {};
	const after = f.after || {};
	const parts = CHANGE_FIELDS.filter((x) => Array.isArray(f.fields) && f.fields.includes(x)).map((x) => {
		if (x === "position") return `position (${before.position} -> ${after.position})`;
		if (x === "phone") return `phone (ending ${phoneLast4(before.phone)} -> ending ${phoneLast4(after.phone)})`;
		return x;
	});
	return `${who} changed: ${parts.join(", ")}`;
}

// A stored row as the routes answer it.
function contactView(row) {
	return {
		id: row.id,
		position: row.position,
		name: row.contact_name,
		relationship: row.relationship,
		phone: row.contact_phone,
		phoneDisplay: phoneDisplay(row.contact_phone),
	};
}

module.exports = {
	MIN_CONTACTS,
	MAX_CONTACTS,
	CONTACT_NAME_MAX,
	RELATIONSHIP_MAX,
	PHONE_RAW_MAX,
	BODY_MAX_ENTRIES,
	RELATIONSHIP_SUGGESTIONS,
	REFUSAL_TEXT,
	cleanContactText,
	normalizePhone,
	phoneLast4,
	validateContactList,
	diffContacts,
	auditDetail,
	contactView,
};
