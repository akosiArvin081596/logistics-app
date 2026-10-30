#!/usr/bin/env node
/**
 * lib/emergency-contacts.js: the rules for a driver's emergency contacts
 * (EMERGENCY_CONTACTS_ENABLED), pure.
 *
 *   §1 the phone table: NANP numbers in any usual spelling store as +1 and ten
 *      digits and show as (XXX) XXX-XXXX; a + number with another country code
 *      stores and shows as +digits; refused: 7 digits, an area or exchange
 *      starting 0 or 1, an N11 code, an extension, letters, 33 characters,
 *      +0..., a second +, no digits
 *   §2 the text rules: trimmed, inner whitespace collapsed, 1 to the cap, no
 *      control or format characters, at least one letter; the cap runs on the
 *      raw value
 *   §3 the list rules: the body's shape (400 INVALID_BODY), 2 to 5 contacts,
 *      each field's refusal with its index, a duplicate number (in any
 *      spelling), a duplicate id, 21 entries
 *   §4 the diff: add, change (which fields), delete, reorder, nothing, an id
 *      not on the list
 *   §5 the audit detail: never the contact's name or relationship, and no more
 *      of the number than its last 4 digits
 *   §6 the view of a stored row
 *   §7 purity: no require at all, no process, fs, network or database
 *
 * Made-up people and 555-01xx numbers only.
 * Run: node scripts/test-emergency-contacts-lib.js   # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const LIB_FILE = path.join(__dirname, "..", "lib", "emergency-contacts.js");

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`  ok    ${name}`); return; }
	failures.push(name);
	console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
}
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected),
	`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
function finish() {
	console.log(`\ntest-emergency-contacts-lib: ${passed} passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
}

let L = null;
try { L = require(LIB_FILE); } catch (err) { L = null; ok("lib/emergency-contacts.js loads", false, err.code || err.message); }
if (!L) finish();

// ── §0 the limits ─────────────────────────────────────────────────────────────
console.log("\n§0 the limits");
eq("§0 two to five contacts, name 80, relationship 40, raw phone 32, 20 entries read",
	[L.MIN_CONTACTS, L.MAX_CONTACTS, L.CONTACT_NAME_MAX, L.RELATIONSHIP_MAX, L.PHONE_RAW_MAX, L.BODY_MAX_ENTRIES],
	[2, 5, 80, 40, 32, 20]);
eq("§0 the relationship suggestions", L.RELATIONSHIP_SUGGESTIONS,
	["Spouse", "Partner", "Parent", "Child", "Sibling", "Relative", "Friend", "Other"]);
ok("§0 the exports are frozen where they are lists", Object.isFrozen(L.RELATIONSHIP_SUGGESTIONS));

// ── §1 the phone table ────────────────────────────────────────────────────────
console.log("\n§1 the phone table");
const PHONES_OK = [
	["(202) 555-0143", "+12025550143", "(202) 555-0143"],
	["202-555-0143", "+12025550143", "(202) 555-0143"],
	["202.555.0143", "+12025550143", "(202) 555-0143"],
	["2025550143", "+12025550143", "(202) 555-0143"],
	["  (202) 555 0143  ", "+12025550143", "(202) 555-0143"],
	["1-312-555-0178", "+13125550178", "(312) 555-0178"],
	["1 (312) 555-0178", "+13125550178", "(312) 555-0178"],
	["+1 (312) 555-0178", "+13125550178", "(312) 555-0178"],
	["+13125550178", "+13125550178", "(312) 555-0178"],
	// Ranges kept for fiction: UK 020 7946 0xxx and 0113 496 0xxx, Australia 0491 570 156.
	["+44 20 7946 0958", "+442079460958", "+442079460958"],
	["+44 113 496 0123", "+441134960123", "+441134960123"],
	["+61 491 570 156", "+61491570156", "+61491570156"],
];
for (const [raw, e164, display] of PHONES_OK) {
	eq(`§1 ${JSON.stringify(raw)} stores ${e164}, shows ${display}`, L.normalizePhone(raw), { ok: true, e164, display });
}
const PHONES_BAD = [
	["555-0143", "7 digits"],
	["(012) 555-0143", "area code starts with 0"],
	["(112) 555-0143", "area code starts with 1"],
	["(202) 055-0143", "exchange starts with 0"],
	["(202) 155-0143", "exchange starts with 1"],
	["(211) 555-0143", "an N11 area code"],
	["(202) 411-0143", "an N11 exchange"],
	["(202) 555-0143 x12", "an extension"],
	["(202) 555-0143 ext 12", "an extension, spelled out"],
	["(202) 555-O143", "a letter O for a zero"],
	["(202) 555-0143".padEnd(33, " "), "33 characters (the cap runs first)"],
	["+0 20 7946 0958", "+0"],
	["++12025550143", "a second +"],
	["202+555-0143", "a + not in front"],
	["22025550143", "11 digits not starting with 1"],
	["+1 202 555 014", "+1 with nine digits"],
	["+1 012 555 0143", "+1 with an area code starting 0"],
	["+4420794", "+ with 7 digits"],
	["+4420794609581234", "+ with 16 digits"],
	["", "empty"],
	["   ", "spaces only"],
	["()-.", "no digits"],
	["202/555/0143", "a slash"],
	["202–555–0143", "en dashes"],
];
for (const [raw, why] of PHONES_BAD) eq(`§1 refused: ${why}`, L.normalizePhone(raw), { ok: false });
for (const v of [2025550143, null, undefined, {}, ["2025550143"]]) eq(`§1 refused: a ${Array.isArray(v) ? "array" : typeof v} (${String(v)})`, L.normalizePhone(v), { ok: false });
eq("§1 the last 4 digits of a stored number", [L.phoneLast4("+12025550143"), L.phoneLast4("+442079460958"), L.phoneLast4("555-0100")], ["0143", "0958", "0100"]);

// ── §2 the text rules ─────────────────────────────────────────────────────────
console.log("\n§2 the text rules");
const clean = (raw, max = 80) => L.cleanContactText(raw, max);
eq("§2 trimmed and inner whitespace collapsed", clean("  Casey    Example  "), { ok: true, value: "Casey Example" });
eq("§2 a tab or a non-breaking space is whitespace", clean("Casey\tExample Jr."), { ok: true, value: "Casey Example Jr." });
eq("§2 apostrophes, hyphens and periods", clean("Jo O'Neil-Sample Jr."), { ok: true, value: "Jo O'Neil-Sample Jr." });
eq("§2 accented and non-Latin letters", [clean("José Núñez").ok, clean("李小龍").ok, clean("Zöe").ok], [true, true, true]);
for (const [raw, why] of [
	["Casey\u0000Example", "a NUL"],
	["Casey\u0007Example", "a bell"],
	["Casey‮Example", "a right-to-left override"],
	["Casey​Example", "a zero-width space"],
	["Casey﻿Example", "a byte-order mark"],
	["Casey Example", "a line separator"],
	["Casey\ud800Example", "a lone surrogate"],
	["12345", "no letter"],
	["- . -", "no letter, punctuation only"],
	["", "empty"],
	["    ", "spaces only"],
]) eq(`§2 refused: ${why}`, clean(raw), { ok: false });
for (const v of [42, null, undefined, {}, ["Casey"]]) eq(`§2 refused: a ${Array.isArray(v) ? "array" : typeof v}`, clean(v), { ok: false });
eq("§2 a name of exactly 80 characters passes, 81 is refused", [clean("A".repeat(80)).ok, clean("A".repeat(81)).ok], [true, false]);
eq("§2 the cap is on the raw value: 79 letters inside 2 spaces is 81, refused", clean(` ${"A".repeat(79)} `).ok, false);
eq("§2 a relationship of exactly 40 passes, 41 is refused", [clean("B".repeat(40), 40).ok, clean("B".repeat(41), 40).ok], [true, false]);
{
	const t0 = Date.now();
	clean(" ".repeat(1e6) + "x");
	clean(`${"a ".repeat(5e5)}`);
	ok("§2 a megabyte of input is refused at the cap, in well under a second", Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
}

// ── §3 the list rules ─────────────────────────────────────────────────────────
console.log("\n§3 the list rules");
const C1 = { name: "Casey Example", relationship: "Spouse", phone: "(202) 555-0143" };
const C2 = { name: "Robin Sample", relationship: "Sibling", phone: "1-312-555-0178" };
const C3 = { name: "Jordan Placeholder", relationship: "Friend", phone: "+44 20 7946 0958" };
const C4 = { name: "Morgan Testcase", relationship: "Parent", phone: "512-555-0147" };
const C5 = { name: "Avery Madeup", relationship: "Relative", phone: "512-555-0148" };
const C6 = { name: "Riley Fixture", relationship: "Other", phone: "512-555-0149" };
const V = (body) => L.validateContactList(body);
const code = (r) => (r.ok ? "ok" : `${r.status} ${r.code}${r.index !== undefined ? ` @${r.index}` : ""}`);
eq("§3 two valid contacts", V({ contacts: [C1, C2] }), {
	ok: true,
	list: [
		{ id: null, position: 1, name: "Casey Example", relationship: "Spouse", phone: "+12025550143" },
		{ id: null, position: 2, name: "Robin Sample", relationship: "Sibling", phone: "+13125550178" },
	],
});
eq("§3 ids are kept, positions follow the list order", V({ contacts: [{ ...C2, id: 12 }, { ...C1, id: 11 }, C3] }).list.map((c) => [c.id, c.position]),
	[[12, 1], [11, 2], [null, 3]]);
eq("§3 five pass", code(V({ contacts: [C1, C2, C3, C4, C5] })), "ok");
for (const [body, why] of [
	[null, "a null body"],
	[[C1, C2], "an array body"],
	["contacts", "a string body"],
	[{}, "no contacts"],
	[{ contacts: "C1,C2" }, "contacts not an array"],
	[{ contacts: { 0: C1, 1: C2 } }, "contacts an object"],
]) eq(`§3 400 INVALID_BODY: ${why}`, code(V(body)), "400 INVALID_BODY");
eq("§3 400 INVALID_BODY: 21 entries, before anything else is read", code(V({ contacts: Array.from({ length: 21 }, () => C1) })), "400 INVALID_BODY");
eq("§3 400 INVALID_BODY: an entry that is not an object", code(V({ contacts: [C1, null, C2] })), "400 INVALID_BODY @1");
eq("§3 400 INVALID_BODY: an entry that is an array", code(V({ contacts: [C1, ["Robin"]] })), "400 INVALID_BODY @1");
for (const [id, why] of [[0, "0"], [-3, "negative"], [1.5, "a fraction"], ["12", "a string"], [true, "true"], [2 ** 60, "over the safe range"]]) {
	eq(`§3 400 INVALID_BODY: an id that is ${why}`, code(V({ contacts: [C1, { ...C2, id }] })), "400 INVALID_BODY @1");
}
eq("§3 400 INVALID_BODY: the same id twice", code(V({ contacts: [{ ...C1, id: 7 }, { ...C2, id: 7 }] })), "400 INVALID_BODY @1");
eq("§3 an id given as null is a new contact", V({ contacts: [{ ...C1, id: null }, C2] }).list[0].id, null);
eq("§3 422 EMERGENCY_CONTACTS_MIN: none", code(V({ contacts: [] })), "422 EMERGENCY_CONTACTS_MIN");
eq("§3 422 EMERGENCY_CONTACTS_MIN: one", code(V({ contacts: [C1] })), "422 EMERGENCY_CONTACTS_MIN");
eq("§3 422 EMERGENCY_CONTACTS_MAX: six", code(V({ contacts: [C1, C2, C3, C4, C5, C6] })), "422 EMERGENCY_CONTACTS_MAX");
eq("§3 422 CONTACT_NAME_INVALID with its index", code(V({ contacts: [C1, { ...C2, name: "  " }] })), "422 CONTACT_NAME_INVALID @1");
eq("§3 422 CONTACT_NAME_INVALID: a name over 80", code(V({ contacts: [{ ...C1, name: "N".repeat(81) }, C2] })), "422 CONTACT_NAME_INVALID @0");
eq("§3 422 CONTACT_NAME_INVALID: a missing name", code(V({ contacts: [C1, { relationship: "Friend", phone: C2.phone }] })), "422 CONTACT_NAME_INVALID @1");
eq("§3 422 CONTACT_RELATIONSHIP_INVALID with its index", code(V({ contacts: [C1, C2, { ...C3, relationship: "R".repeat(41) }] })), "422 CONTACT_RELATIONSHIP_INVALID @2");
eq("§3 422 CONTACT_PHONE_INVALID with its index", code(V({ contacts: [C1, { ...C2, phone: "555-0143" }] })), "422 CONTACT_PHONE_INVALID @1");
eq("§3 422 CONTACT_PHONE_DUPLICATE: the same number in another spelling", code(V({ contacts: [C1, C2, { ...C3, phone: "+1 202 555 0143" }] })), "422 CONTACT_PHONE_DUPLICATE @2");
eq("§3 the earliest problem wins, in list order", code(V({ contacts: [C1, { ...C2, phone: C1.phone }, { ...C3, name: "" }] })), "422 CONTACT_PHONE_DUPLICATE @1");
eq("§3 unknown keys in an entry are ignored", code(V({ contacts: [{ ...C1, note: "x", position: 9 }, C2], extra: true })), "ok");
eq("§3 every refusal carries a message", [V(null), V({ contacts: [C1] }), V({ contacts: [C1, { ...C2, phone: "x" }] })].every((r) => typeof r.error === "string" && r.error.length > 10), true);

// ── §4 the diff ───────────────────────────────────────────────────────────────
console.log("\n§4 the diff");
const ROWS = [
	{ id: 11, position: 1, contact_name: "Casey Example", relationship: "Spouse", contact_phone: "+12025550143" },
	{ id: 12, position: 2, contact_name: "Robin Sample", relationship: "Sibling", contact_phone: "+13125550178" },
];
const list = (...cs) => V({ contacts: cs }).list;
const D = (cs) => L.diffContacts(ROWS, list(...cs));
const shape = (d) => ({ adds: d.adds.length, changes: d.changes.map((c) => [c.id, c.fields]), deletes: d.deletes.map((x) => x.id), unknown: d.unknown });
eq("§4 the same list: nothing", shape(D([{ ...C1, id: 11 }, { ...C2, id: 12 }])), { adds: 0, changes: [], deletes: [], unknown: [] });
eq("§4 the same list in another spelling of the number: nothing", shape(D([{ ...C1, id: 11, phone: "202.555.0143" }, { ...C2, id: 12 }])), { adds: 0, changes: [], deletes: [], unknown: [] });
eq("§4 a new number on one contact", shape(D([{ ...C1, id: 11, phone: "512-555-0147" }, { ...C2, id: 12 }])), { adds: 0, changes: [[11, ["phone"]]], deletes: [], unknown: [] });
eq("§4 a name and a relationship", shape(D([{ ...C1, id: 11, name: "Casey Q Example", relationship: "Partner" }, { ...C2, id: 12 }])), { adds: 0, changes: [[11, ["name", "relationship"]]], deletes: [], unknown: [] });
eq("§4 a reorder moves both positions", shape(D([{ ...C2, id: 12 }, { ...C1, id: 11 }])), { adds: 0, changes: [[12, ["position"]], [11, ["position"]]], deletes: [], unknown: [] });
eq("§4 one replaced: a delete and an add", shape(D([{ ...C1, id: 11 }, C3])), { adds: 1, changes: [], deletes: [12], unknown: [] });
eq("§4 an id that is not on the list is reported, never written", shape(D([{ ...C1, id: 11 }, { ...C2, id: 99 }])), { adds: 0, changes: [], deletes: [12], unknown: [99] });
{
	const d = D([{ ...C1, id: 11, phone: "512-555-0147" }, { ...C2, id: 12 }, C3]);
	eq("§4 a change carries before and after", [d.changes[0].before.phone, d.changes[0].after.phone, d.changes[0].after.position], ["+12025550143", "+15125550147", 1]);
	eq("§4 an add carries its position and number", [d.adds[0].position, d.adds[0].phone], [3, "+442079460958"]);
}
{
	const d = D([{ ...C2, id: 12 }, C4]);
	eq("§4 a delete carries the old position and number", [d.deletes[0].id, d.deletes[0].position, d.deletes[0].phone], [11, 1, "+12025550143"]);
}

// ── §5 the audit detail ───────────────────────────────────────────────────────
console.log("\n§5 the audit detail");
const FACT_BASE = { driver: "Casey Example", userId: 90102, contactId: 431 };
// Facts as a careless caller might pass them: the contact's own name and
// relationship among them. None of it may reach the line.
const LEAKY = { name: "Robin Sample", relationship: "Sibling", contact_name: "Robin Sample" };
const add = L.auditDetail("add", { ...FACT_BASE, ...LEAKY, position: 2, phone: "+12025550143" });
const chg = L.auditDetail("change", { ...FACT_BASE, ...LEAKY, fields: ["name", "phone"], before: { position: 2, phone: "+12025550143", name: "Robin Sample" }, after: { position: 2, phone: "+13125550178", name: "Robin Q Sample" } });
const mov = L.auditDetail("change", { ...FACT_BASE, fields: ["position", "relationship"], before: { position: 2, phone: "+12025550143" }, after: { position: 1, phone: "+12025550143" } });
const del = L.auditDetail("delete", { ...FACT_BASE, ...LEAKY, position: 2, phone: "+13125550178" });
eq("§5 an add", add, "Driver Casey Example (user 90102): contact 431 added at position 2, phone ending 0143");
eq("§5 a change of name and phone", chg, "Driver Casey Example (user 90102): contact 431 changed: name, phone (ending 0143 -> ending 0178)");
eq("§5 a move and a relationship", mov, "Driver Casey Example (user 90102): contact 431 changed: position (2 -> 1), relationship");
eq("§5 a delete", del, "Driver Casey Example (user 90102): contact 431 deleted from position 2, phone ending 0178");
for (const [label, line] of [["add", add], ["change", chg], ["move", mov], ["delete", del]]) {
	ok(`§5 ${label}: no contact name or relationship`, !/Robin|Sibling/.test(line), line);
	ok(`§5 ${label}: no more than 4 digits of a number in a row`, !/\d{5,}/.test(line.replace(/\(user \d+\)|contact \d+/g, "")), line);
	ok(`§5 ${label}: no national number`, !/2025550143|3125550178|202555|312555/.test(line), line);
}
eq("§5 an unknown kind or field adds nothing it was not asked for",
	L.auditDetail("change", { ...FACT_BASE, fields: ["name", "contact_name", "notes"], before: {}, after: {} }),
	"Driver Casey Example (user 90102): contact 431 changed: name");

// ── §6 the view of a stored row ───────────────────────────────────────────────
console.log("\n§6 the view of a stored row");
eq("§6 a US number", L.contactView(ROWS[0]), { id: 11, position: 1, name: "Casey Example", relationship: "Spouse", phone: "+12025550143", phoneDisplay: "(202) 555-0143" });
eq("§6 an international number shows as stored", L.contactView({ ...ROWS[1], contact_phone: "+442079460958" }).phoneDisplay, "+442079460958");
eq("§6 a placeholder from a refreshed copy shows as stored", L.contactView({ ...ROWS[1], contact_phone: "555-0100" }).phoneDisplay, "555-0100");
eq("§6 only these six keys", Object.keys(L.contactView({ ...ROWS[0], user_id: 90102, created_by: 1 })).sort(), ["id", "name", "phone", "phoneDisplay", "position", "relationship"]);

// ── §7 purity ─────────────────────────────────────────────────────────────────
console.log("\n§7 purity");
{
	const src = fs.readFileSync(LIB_FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
	ok("§7 no require at all", !/\brequire\s*\(/.test(src));
	ok("§7 no import", !/\bimport\b/.test(src));
	for (const word of ["process", "fetch", "XMLHttpRequest", "setTimeout", "setInterval", "Date.now", "Math.random"]) {
		ok(`§7 no ${word}`, !new RegExp(`\\b${word.replace(".", "\\.")}\\b`).test(src));
	}
}

finish();
