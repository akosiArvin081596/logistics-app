#!/usr/bin/env node
// lib/broker-contact.js: which emails and phones it finds, what it leaves alone,
// how a value is served to a non-Super-Admin, the writer rules, and the rate-con
// extract's redaction and stash. The routes that call it are run by
// scripts/test-broker-contact-redaction.js.
//
// The fixture is made up: example.invalid addresses and 555-01xx numbers.
//
//   node scripts/test-broker-contact-lib.js     # exits 1 on any failure

"use strict";

const path = require("path");
const bc = require(path.join(__dirname, "..", "lib", "broker-contact"));

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++; failures.push(name);
	console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`.slice(0, 1200));
}

const W = bc.WITHHELD_TEXT;
const found = (s) => bc.findContact(s).map((r) => s.slice(r.start, r.end));
const served = (s, own) => bc.redactContactText(s, own).text;
// The same rule server.js passes in (BROKER_WITHHELD_RE).
const WITHHELD_RE = /broker|phone|e-?mail|contact|\bfax\b|mobile|\bcell\b/i;

// ----------------------------------------------------------------- phones
check("constant: the placeholder text", W, "[contact withheld]");
for (const [label, s] of [
	["+1 prefix, spaces", "+1 555 010 0150"],
	["1- prefix, dashes", "1-555-010-0151"],
	["spaces only", "555 010 0152"],
	["en-dashes", "555–010–0153"],
	["em-dashes", "555—010—0153"],
	["non-breaking hyphens", "555‑010‑0153"],
	["mixed separators", "555.010-0154"],
	["dots", "555.010.0177"],
	["parentheses, no space", "(555)010-0155"],
	["parentheses and a space", "(555) 010-0199"],
	["+1 and parentheses", "+1 (555) 010-0150"],
	["one run after +1", "+15550100150"],
	["an international number in groups", "+52 55 1234 5678"],
]) check(`phone found whole: ${label}`, found(`call ${s} now`), [s]);
check("phone: an extension stays with its number (ext.)", found("main (555)010-0155 ext. 12; fax"), ["(555)010-0155 ext. 12"]);
check("phone: an extension stays with its number (x)", found("555-010-0142 x12."), ["555-010-0142 x12"]);
check("phone: a number cut by an ellipsis", found("Details: 555-010-01…"), ["555-010-01"]);
check("phone: a number cut by three dots", found("call (555) 01..."), ["(555) 01"]);

// ----------------------------------------------------------------- emails
for (const [label, s, expect] of [
	["a +tag, a subdomain and capitals", "Agent.Three+loads@Mail.Example.invalid", "Agent.Three+loads@Mail.Example.invalid"],
	["mailto: goes with it", "mailto:agent.four@example.invalid", "mailto:agent.four@example.invalid"],
	["angle brackets go with it", "<agent.five@sub.example.invalid>", "<agent.five@sub.example.invalid>"],
	["all capitals", "AGENT.ONE@EXAMPLE.INVALID", "AGENT.ONE@EXAMPLE.INVALID"],
	["cut by an ellipsis", "agent.one@exam…", "agent.one@exam"],
]) check(`email found: ${label}`, found(`write ${s}, thanks`), [expect]);
check("email: a sentence's full stop is not part of it", found("Write agent.one@example.invalid."), ["agent.one@example.invalid"]);

// ------------------------------------------------- not contact (kept as is)
for (const s of [
	"80000011", "BOL 5550100199", "REF/PU#: 41000017", "DEL#: 2700011", "1/10/2030 08:00", "2030-01-10",
	"08:00-14:00", "0800-1400", "08:00 - 14:00", "Dallas, TX 75201", "75201-1234", "42,000 lb", "$1,800.00",
	"Dock 4", "Reefer 34F", "+1500.50", "+7", "Dry van 53', 38,500 lb", "PO Box 12", "Appt@0800", "Dock 100…",
	"Seal 1234 5678 9012", "Load 30080873 / 209875716", "2030-01-10T08:00:00.000Z", "user@localhost",
]) check(`not contact: ${JSON.stringify(s)}`, [found(s), served(s)], [[], s]);

// ------------------------------------------------------ redactContactText
check("text: contact inside text becomes the placeholder",
	served("Rate agreed with agent.one@example.invalid; call 555-010-0142 before arrival. 42,000 lb"),
	`Rate agreed with ${W}; call ${W} before arrival. 42,000 lb`);
check("text: a cell that is only an email is blank", served("agent.one@example.invalid"), "");
check("text: a cell that is only an email in brackets is blank", served("<agent.five@sub.example.invalid>"), "");
check("text: a cell that is only contact and separators is blank", served(" agent.one@example.invalid ; (555) 010-0199 / "), "");
check("text: a label stays", served("Email: agent.one@example.invalid"), `Email: ${W}`);
check("text: changed is reported", [bc.redactContactText("call 555-010-0142").changed, bc.redactContactText("Dock 4").changed], [true, false]);
check("text: anything but a non-empty string comes back as it is",
	[served(""), served(null), served(undefined), served(42)], ["", null, undefined, 42]);

// ------------------------------------------------------- the row's own
const OWN = bc.ownContact([["Broker Contact Name", "Sam Agent"], ["Phone Number", "555-010-0156"], ["Email", "agent.three+loads@mail.example.invalid"]]);
check("own: phones by ten digits, emails in lower case, names",
	[[...OWN.phones], [...OWN.emails], [...OWN.names]], [["5550100156"], ["agent.three+loads@mail.example.invalid"], ["Sam Agent"]]);
check("own: the row's phone as bare digits is withheld", served("own 5550100156. Reefer 34F", OWN), `own ${W}. Reefer 34F`);
check("own: ...a bare-digit run that is not the row's phone is kept", served("BOL 5550100157", OWN), "BOL 5550100157");
check("own: ...and without the row's contact a bare run is kept", served("own 5550100156"), "own 5550100156");
check("own: the agent's name in any case and spacing", served("ask sam  AGENT at the gate", OWN), `ask ${W} at the gate`);
check("own: ...only as a whole word", served("Samsam Agentive", OWN), "Samsam Agentive");
const BLOB = bc.ownContact([["Broker Contact Name", '{"Name":"Pat Agent","Phone":"5550100142"}'], ["Phone Number", "1 (555) 010-0143 ext 4"]]);
check("own: a JSON contact blob is read key by key; a 1-prefixed phone with an extension counts",
	[[...BLOB.names], [...BLOB.phones].sort()], [["Pat Agent"], ["5550100142", "5550100143"]]);
const PLACEHOLDER = bc.ownContact([["Broker Contact Name", "N/A"], ["Broker Contact Name", "Al"], ["Broker Contact Name", "Agent 7"]]);
check("own: a placeholder, a too-short value or one with digits is not a name", [...PLACEHOLDER.names], []);

// ---------------------------------------------------------------- bounds
function timed(label, s) {
	const t0 = Date.now();
	bc.redactContactText(s, OWN);
	bc.findContact(s);
	const ms = Date.now() - t0;
	check(`bounded: ${label} (${s.length} chars) runs in under 1.5 s`, ms < 1500, true);
}
timed("a long whitespace run between digit groups", `555${" ".repeat(100000)}010 0150`);
timed("a long whitespace and tab run", `x${" \t".repeat(60000)}@example.invalid`);
timed("repeated local@ parts", "a@".repeat(60000));
timed("a long dotted domain", `a@${"b.".repeat(60000)}`);
timed("repeated digit-dash pairs", "1-".repeat(60000));
timed("repeated parentheses", "(555) ".repeat(30000));
timed("repeated plus groups", "+1 2 ".repeat(30000));
timed("repeated ellipses after digits", "555-0…".repeat(30000));

// -------------------------------------------------------- redactLoadRows
const HEADERS = ["Contract ID", "Load ID", "Details", "Pickup Info", "Pickup Address", "Broker Contact Name", "Phone Number", "Email", ""];
const ROW = {
	"Contract ID": "agent.one@example.invalid", "Load ID": "80000011",
	Details: "call 555-010-0142; own 5550100156; ask Sam Agent. 42,000 lb", "Pickup Info": "REF/PU#: 41000017",
	"Pickup Address": "300 Pine Rd, Austin, TX 78701 Tel 555-010-0157", "Broker Contact Name": "Sam Agent",
	"Phone Number": "555-010-0156", Email: "agent.three+loads@mail.example.invalid", "": "<agent.five@sub.example.invalid>",
	_rowIndex: 2, _pickupStreet: "300 Pine Rd Tel 555-010-0157", _refs: [{ label: "PU", value: "41000017" }, { label: "x", value: "555-010-0150" }],
};
const ORIGINAL = JSON.stringify(ROW);
const [out] = bc.redactLoadRows(HEADERS, [ROW], { withheldRe: WITHHELD_RE });
check("rows: the row given is not changed", JSON.stringify(ROW), ORIGINAL);
check("rows: withheld columns are blank", [out["Broker Contact Name"], out["Phone Number"], out.Email], ["", "", ""]);
check("rows: a Contract ID holding only an email is blank", out["Contract ID"], "");
check("rows: free text keeps its other words, the row's own phone and agent name withheld too",
	out.Details, `call ${W}; own ${W}; ask ${W}. 42,000 lb`);
check("rows: a blank-header column is redacted", out[""], "");
check("rows: derived fields are redacted (a string and an array of objects)",
	[out._pickupStreet, out._refs], [`300 Pine Rd Tel ${W}`, [{ label: "PU", value: "41000017" }, { label: "x", value: "" }]]);
check("rows: the sheet cells redacted by value are listed, in header order", out._withheldCells, ["Contract ID", "Details", "Pickup Address", ""]);
check("rows: non-contact cells and numbers as they were", [out["Load ID"], out["Pickup Info"], out._rowIndex], ["80000011", "REF/PU#: 41000017", 2]);
const [off] = bc.redactLoadRows(HEADERS, [ROW], { withheldRe: WITHHELD_RE, values: false });
check("rows, value redaction off: only the withheld columns are blanked, as before",
	[off["Contract ID"], off.Details, off.Email, "_withheldCells" in off], [ROW["Contract ID"], ROW.Details, "", false]);
const [valuesOnly] = bc.redactLoadValues(HEADERS, [ROW], { withheldRe: WITHHELD_RE });
check("values only: the same redaction, the withheld columns left as stored for the caller to blank",
	[valuesOnly.Details, valuesOnly["Contract ID"], valuesOnly._withheldCells, valuesOnly["Phone Number"], valuesOnly.Email],
	[out.Details, "", out._withheldCells, ROW["Phone Number"], ROW.Email]);
check("values only: the row given is not changed", JSON.stringify(ROW), ORIGINAL);
const [clean] = bc.redactLoadRows(HEADERS, [{ "Load ID": "1", Details: "Dock 4", _withheldCells: ["Details"] }], { withheldRe: WITHHELD_RE });
check("rows: a row with nothing to redact carries no _withheldCells (a stale one is dropped)", "_withheldCells" in clean, false);
check("rows: the withheld rule is required", (() => { try { bc.redactLoadRows(HEADERS, [ROW]); return "no throw"; } catch (e) { return e.name; } })(), "TypeError");

// ---------------------------------------------------- restoreContactCells
const STORED = HEADERS.map((h) => (h in ROW ? ROW[h] : ""));
const SERVED = HEADERS.map((h) => out[h]);
const restore = (values) => {
	const v = values.slice();
	const refusal = bc.restoreContactCells(HEADERS, STORED, v, { withheldRe: WITHHELD_RE });
	return { refusal, v };
};
{
	const r = restore(SERVED);
	check("writer: the row sent back as served is written as stored", [r.refusal, r.v.filter((x, i) => !WITHHELD_RE.test(HEADERS[i]))],
		[null, STORED.filter((x, i) => !WITHHELD_RE.test(HEADERS[i]))]);
	check("writer: withheld columns are left to restoreWithheldBrokerCells()", r.v.slice(5, 8), SERVED.slice(5, 8));
}
check("writer: sent back as stored is fine", restore(STORED).refusal, null);
check("writer: served text with other edge whitespace is fine", restore(SERVED.map((x, i) => (i === 2 ? ` ${x}  ` : x))).refusal, null);
{
	const r = restore(SERVED.map((x, i) => (i === 2 ? "call the broker; 42,000 lb" : x)));
	check("writer: a changed contact cell is refused, 409 CONTACT_CELL_READ_ONLY naming the column",
		[r.refusal && r.refusal.code, r.refusal && r.refusal.field], ["CONTACT_CELL_READ_ONLY", "Details"]);
}
check("writer: clearing a contact cell is refused too", (restore(SERVED.map((x, i) => (i === 0 ? "29284990" : x))).refusal || {}).field, "Contract ID");
check("writer: a cell holding no contact is edited freely",
	restore(SERVED.map((x, i) => (i === 3 ? "REF/PU#: 41000099" : x))).v[3], "REF/PU#: 41000099");
check("writer: a cell past the end of what is written is not judged", restore(SERVED.slice(0, 2)).refusal, null);
check("writer: a blank-header column is named (unnamed)",
	(restore(SERVED.map((x, i) => (i === 8 ? "new text" : x))).refusal || {}).field, "(unnamed)");

// ---------------------------------------------- contactNotAllowedRefusal
const CI = ["Load ID", "Contract ID", "Details"];
const refuse = (before, values) => bc.contactNotAllowedRefusal(CI, before, values);
check("Contract ID: a new email is refused, 400 CONTACT_NOT_ALLOWED naming the column",
	[(refuse(["1", "", ""], ["1", "new.agent@example.invalid", ""]) || {}).code, (refuse(["1", "", ""], ["1", "new.agent@example.invalid", ""]) || {}).field],
	["CONTACT_NOT_ALLOWED", "Contract ID"]);
check("Contract ID: a formatted phone is refused", (refuse(["1", "", ""], ["1", "(555) 010-0199", ""]) || {}).code, "CONTACT_NOT_ALLOWED");
check("Contract ID: a reference number is fine", refuse(["1", "", ""], ["1", "29284990", ""]), null);
check("Contract ID: a stored email sent back unchanged is not refused", refuse(["1", "agent.one@example.invalid", ""], ["1", "agent.one@example.invalid", "x"]), null);
check("Contract ID: a new row is judged cell by cell", (refuse([], ["1", "agent.one@example.invalid", ""]) || {}).code, "CONTACT_NOT_ALLOWED");
check("Contract ID: another column is not judged", refuse(["1", "", ""], ["1", "", "call 555-010-0142"]), null);
check("Contract ID: the header is matched by name, any spacing or case",
	(bc.contactNotAllowedRefusal(["contract  id "], [""], ["agent.one@example.invalid"]) || {}).field, "contract  id ");

// ------------------------------------------------------- dispatch notices
check("notice value: contact inside text is withheld; a value that was only contact reads as withheld, not blank",
	[bc.redactNoticeValue("call 555-010-0142 first"), bc.redactNoticeValue("agent.one@example.invalid"), bc.redactNoticeValue(""), bc.redactNoticeValue("Dock 4")],
	[`call ${W} first`, W, "", "Dock 4"]);
{
	const legacy = { id: 1, type: "ratecon-reissue-held", title: "Load 80000011: re-issued rate con changed fields",
		body: "Details: call 555-010-01… → email agent.one@exam…; Pickup Info (held): REF 41000017 → REF 41000017 (555) 010-0199",
		metadata: JSON.stringify({ loadId: "80000011" }), read: 0 };
	const out = bc.redactDispatchNotice(legacy);
	check("notice stored before the fix: column names only, from the body", out.body, `Details: ${W}; Pickup Info (held): ${W}`);
	check("notice stored before the fix: title, id and the rest kept", [out.title, out.id, out.read, out.metadata], [legacy.title, 1, 0, legacy.metadata]);
	const withFields = bc.redactDispatchNotice({ ...legacy, metadata: JSON.stringify({ loadId: "80000011", fields: [{ column: "Details", kind: "changed" }, { column: "Drop-off Info", kind: "held" }] }) });
	check("notice stored before the fix: column names from metadata.fields when present", withFields.body, `Details: ${W}; Drop-off Info (held): ${W}`);
	const fresh = bc.redactDispatchNotice({ ...legacy, body: `Details: call ${W} → Reefer 34F, 555.010.0177`, metadata: JSON.stringify({ loadId: "80000011", valuesRedacted: true, note: "x@example.invalid" }) });
	check("notice stored after the fix: served as stored, redacted again (metadata too)",
		[fresh.body, JSON.parse(fresh.metadata).note], [`Details: call ${W} → Reefer 34F, ${W}`, ""]);
	const other = bc.redactDispatchNotice({ type: "new-load", title: "New Load 80000016", body: "Dallas, TX → Tulsa, OK Tel 555-010-0157", metadata: "not json 555-010-0142" });
	check("other notices: title, body and metadata redacted", [other.title, other.body, other.metadata],
		["New Load 80000016", `Dallas, TX → Tulsa, OK Tel ${W}`, `not json ${W}`]);
}

// -------------------------------------------------------------- rate cons
const EXTRACTED = {
	"Load Number": "80000014", "Broker Name": "Pat Agent", "Broker Phone": "(555) 010-0142",
	"Broker Email": "agent.one@example.invalid", "Documents Email": "billing.desk@example.invalid", Rate: "$1,800.00",
	"Pickup Address": "100 Main St, Dallas, TX 75201", "Pickup Notes/Instructions": "Call 1-555-010-0151 one hour out",
	"Delivery Notes/Instructions": "Questions: agent.four@example.invalid", Details: "Dry van; ask Pat Agent", "BOL Number": "5550100142",
};
const EXTRACTED_COPY = JSON.stringify(EXTRACTED);
const red = bc.redactRateConFields(EXTRACTED, { withheldRe: WITHHELD_RE });
check("extract: the input is not changed", JSON.stringify(EXTRACTED), EXTRACTED_COPY);
check("extract: every contact field is null (the billing inbox too)",
	[red["Broker Name"], red["Broker Phone"], red["Broker Email"], red["Documents Email"]], [null, null, null, null]);
check("extract: notes and details are redacted, the agent's name and the bare-digit copy of the phone included",
	[red["Pickup Notes/Instructions"], red["Delivery Notes/Instructions"], red.Details, red["BOL Number"]],
	[`Call ${W} one hour out`, `Questions: ${W}`, `Dry van; ask ${W}`, ""]);
check("extract: the load number, rate and address are kept", [red["Load Number"], red.Rate, red["Pickup Address"]],
	["80000014", "$1,800.00", "100 Main St, Dallas, TX 75201"]);

const asServed = Object.fromEntries(Object.entries(red).map(([k, v]) => [k, v == null ? "" : v]));
{
	const typed = { ...asServed, "Broker Email": "typed@example.invalid", "Broker Phone": "555-010-0188", "Broker Name": "Typed Name", Rate: "$1,900.00" };
	const r = bc.rateConCreateFields(typed, EXTRACTED, { withheldRe: WITHHELD_RE });
	check("create: contact fields come from the extract, never from the client",
		[r.fields["Broker Name"], r.fields["Broker Phone"], r.fields["Broker Email"], r.fields["Documents Email"], r.missed],
		["Pat Agent", "(555) 010-0142", "agent.one@example.invalid", "billing.desk@example.invalid", false]);
	check("create: a field sent as served gets its original; an edited one is written as sent",
		[r.fields["Pickup Notes/Instructions"], r.fields.Details, r.fields.Rate],
		[EXTRACTED["Pickup Notes/Instructions"], EXTRACTED.Details, "$1,900.00"]);
	const edited = bc.rateConCreateFields({ ...asServed, Details: "Dry van, dock 5" }, EXTRACTED, { withheldRe: WITHHELD_RE });
	check("create: a redacted field the person changed is written as sent", edited.fields.Details, "Dry van, dock 5");
}
{
	const r = bc.rateConCreateFields({ "Load Number": "80000014", "Broker Email": "typed@example.invalid", "Broker Name": "Typed Name" }, null, { withheldRe: WITHHELD_RE });
	check("create, no extract held: contact fields are blank and the miss is reported",
		[r.fields["Broker Email"], r.fields["Broker Name"], r.fields["Load Number"], r.missed], ["", "", "80000014", true]);
}

// ---------------------------------------------------------------- the stash
{
	let t = 1000;
	const stash = bc.createRateConStash({ ttlMs: 100, max: 2, now: () => t });
	stash.put("a", { x: 1 });
	const got = stash.get("a");
	got.x = 2;
	check("stash: get returns a copy of what was put", [stash.get("a"), stash.get("missing")], [{ x: 1 }, null]);
	t += 100;
	check("stash: an entry expires after ttlMs", stash.get("a"), null);
	stash.put("b", { n: 1 }); stash.put("c", { n: 2 }); stash.put("d", { n: 3 });
	check("stash: at most `max` entries, the oldest goes first", [stash.get("b"), stash.get("c"), stash.get("d"), stash.size], [null, { n: 2 }, { n: 3 }, 2]);
	stash.put("", { n: 4 });
	check("stash: an empty key is never stored", [stash.get(""), stash.size], [null, 2]);
	check("stash: the server's one stash is a stash", [typeof bc.rateConStash.put, typeof bc.rateConStash.get], ["function", "function"]);
}
{
	const k = bc.rateConStashKey("JVBERi0xLjQ=");
	check("stash key: SHA-256 hex; the data-URL prefix and edge whitespace do not change it",
		[k.length, bc.rateConStashKey(" data:application/pdf;base64,JVBERi0xLjQ= \n".trim()) === k, bc.rateConStashKey("JVBERi0xLjQ=\n") === k],
		[64, true, true]);
	check("stash key: another PDF, another key; no PDF, no key",
		[bc.rateConStashKey("JVBERi0xLjU=") !== k, bc.rateConStashKey(""), bc.rateConStashKey(null)], [true, "", ""]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log("\nFailures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
