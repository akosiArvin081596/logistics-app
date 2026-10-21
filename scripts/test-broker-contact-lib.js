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
for (const [label, s] of [
	["spaces around the @", "agent.one @ example.com"],
	["\"at\" and \"dot\" spelled out", "agent.one at example dot com"],
	["(at) and (dot)", "agent.one (at) example (dot) com"],
	["[at] and [dot], no spaces", "agent.one[at]example[dot]com"],
	["{at} and a real dot", "agent.one {at} mail.example.com"],
	["\"at\" and a real dot", "agent.one at example.com"],
]) check(`email found whole: ${label}`, found(`write ${s}, thanks`), [s]);

// A label, then a bare 10-digit number: a phone (only the number goes).
for (const [label, s, n] of [
	["Tel:", "Tel: 5550100142", "5550100142"],
	["Phone, with a 1", "Phone 15550100142", "15550100142"],
	["cell#", "cell#5550100142", "5550100142"],
	["Ph.", "Ph. 5550100142", "5550100142"],
	["Fax no.", "Fax no. 5550100142", "5550100142"],
	["call", "call 5550100142 at the gate", "5550100142"],
]) check(`phone found: ${label} before a bare 10-digit number`, found(`${s}`), [n]);

// ------------------------------------------------- not contact (kept as is)
for (const s of [
	"80000011", "BOL 5550100199", "REF/PU#: 41000017", "DEL#: 2700011", "1/10/2030 08:00", "2030-01-10",
	"08:00-14:00", "0800-1400", "08:00 - 14:00", "Dallas, TX 75201", "75201-1234", "42,000 lb", "$1,800.00",
	"Dock 4", "Reefer 34F", "+1500.50", "+7", "Dry van 53', 38,500 lb", "PO Box 12", "Appt@0800", "Dock 100…",
	"Seal 1234 5678 9012", "Load 30080873 / 209875716", "2030-01-10T08:00:00.000Z", "user@localhost",
	"Meet at gate. Com check", "arrive at 0800", "Dock 4 at Acme dot", "load at Dallas, TX", "BOL 5550100142",
	"Contract 5550100142", "PO 5550100142", "Appt @ 0800", "Unload at door 5. Dot inspection",
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
timed("repeated \"x at y dot\" words", "agent at example dot ".repeat(10000));
timed("repeated bracketed at", "a (at) ".repeat(20000));
timed("a label then long whitespace before digits", `Tel:${" ".repeat(100000)}5550100142`);
timed("repeated spaced @", "a @ ".repeat(30000));

// ------------------------------------------------------- redactLoadValues
const HEADERS = ["Contract ID", "Load ID", "Details", "Pickup Info", "Pickup Address", "Broker Contact Name", "Phone Number", "Email", ""];
const ROW = {
	"Contract ID": "agent.one@example.invalid", "Load ID": "80000011",
	Details: "call 555-010-0142; own 5550100156; ask Sam Agent. 42,000 lb", "Pickup Info": "REF/PU#: 41000017",
	"Pickup Address": "300 Pine Rd, Austin, TX 78701 Tel 555-010-0157", "Broker Contact Name": "Sam Agent",
	"Phone Number": "555-010-0156", Email: "agent.three+loads@mail.example.invalid", "": "<agent.five@sub.example.invalid>",
	_rowIndex: 2, _pickupStreet: "300 Pine Rd Tel 555-010-0157", _refs: [{ label: "PU", value: "41000017" }, { label: "x", value: "555-010-0150" }],
};
const ORIGINAL = JSON.stringify(ROW);
// A row as server.js sanitizeBrokerColumns() serves it: redactLoadValues(), then
// every withheld column that holds anything blank.
const servedRows = (headers, rows) => bc.redactLoadValues(headers, rows, { withheldRe: WITHHELD_RE }).map((r) => {
	for (const h of headers) if (WITHHELD_RE.test(h) && r[h]) r[h] = "";
	return r;
});
const [out] = servedRows(HEADERS, [ROW]);
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
const [valuesOnly] = bc.redactLoadValues(HEADERS, [ROW], { withheldRe: WITHHELD_RE });
check("values only: the withheld columns are left as stored for the caller to blank",
	[valuesOnly["Phone Number"], valuesOnly.Email], [ROW["Phone Number"], ROW.Email]);
check("values only: the row given is not changed", JSON.stringify(ROW), ORIGINAL);
const [clean] = bc.redactLoadValues(HEADERS, [{ "Load ID": "1", Details: "Dock 4", _withheldCells: ["Details"] }], { withheldRe: WITHHELD_RE });
check("rows: a row with nothing to redact carries no _withheldCells (a stale one is dropped)", "_withheldCells" in clean, false);
check("rows: the withheld rule is required", (() => { try { bc.redactLoadValues(HEADERS, [ROW]); return "no throw"; } catch (e) { return e.name; } })(), "TypeError");
check("rows: the one row entry point is redactLoadValues() (no unused whole-row variant)", typeof bc.redactLoadRows, "undefined");
// The agent's NAME is looked for in free-text cells only (Details, the Info
// columns, notes, Contract ID): a one-word name must never touch the Driver, an
// address, a facility or any other structural cell.
{
	const H2 = ["Load ID", "Driver", "Details", "Pickup Info", "Pickup Address", "Trailer Number", "Broker Contact Name"];
	const [r] = servedRows(H2, [{
		"Load ID": "80000020", Driver: "Kevin", Details: "Kevin from the broker will call", "Pickup Info": "Ask for Kevin at gate",
		"Pickup Address": "12 Kevin Ave, Dallas, TX 75201", "Trailer Number": "KEVIN", "Broker Contact Name": "Kevin",
		_pickupStreet: "12 Kevin Ave",
	}]);
	check("rows: a one-word agent name is withheld in free text only, never in Driver, an address, a trailer or a derived field",
		[r.Driver, r.Details, r["Pickup Info"], r["Pickup Address"], r["Trailer Number"], r._pickupStreet],
		["Kevin", `${W} from the broker will call`, `Ask for ${W} at gate`, "12 Kevin Ave, Dallas, TX 75201", "KEVIN", "12 Kevin Ave"]);
}

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
	// Stored since the fix: the full body (a Super Admin's), and in its metadata
	// the copy redacted before the 100-character cut, which every other role gets.
	const full = { ...legacy, body: "Details: call 555-010-0142 → Reefer 34F, 555.010.0177",
		metadata: JSON.stringify({ loadId: "80000011", redactedBody: `Details: call ${W} → Reefer 34F, ${W}`, note: "x@example.invalid" }) };
	const fresh = bc.redactDispatchNotice(full);
	check("notice stored since the fix, a non-Super-Admin: the redacted copy, and no copy left in the metadata",
		[fresh.body, JSON.parse(fresh.metadata).note, "redactedBody" in JSON.parse(fresh.metadata)], [`Details: call ${W} → Reefer 34F, ${W}`, "", false]);
	const forAdmin = bc.fullDispatchNotice(full);
	check("notice stored since the fix, a Super Admin: the full body as stored, the copy dropped from the metadata",
		[forAdmin.body, JSON.parse(forAdmin.metadata).note, "redactedBody" in JSON.parse(forAdmin.metadata)],
		[full.body, "x@example.invalid", false]);
	check("a Super Admin's notice without a copy is served exactly as stored", bc.fullDispatchNotice(legacy), legacy);
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
	check("create: the fields taken from the extract are listed (every broker field, and each field put back)",
		[...r.fromHeld].sort(), ["BOL Number", "Broker Email", "Broker Name", "Broker Phone", "Delivery Notes/Instructions", "Details",
			"Documents Email", "Pickup Notes/Instructions"]);
	check("create: an edited field is not listed", edited.fromHeld.includes("Details"), false);
}
// The kill switch governs free-text redaction only: off, the broker fields are
// still null in the extract and still taken from the extract on the create.
{
	const offRed = bc.redactRateConFields(EXTRACTED, { withheldRe: WITHHELD_RE, values: false });
	check("extract, value redaction off: the broker fields are still null; the rest as read",
		[offRed["Broker Name"], offRed["Documents Email"], offRed["Pickup Notes/Instructions"], offRed.Details],
		[null, null, EXTRACTED["Pickup Notes/Instructions"], EXTRACTED.Details]);
	const asShownOff = Object.fromEntries(Object.entries(offRed).map(([k, v]) => [k, v == null ? "" : v]));
	const r = bc.rateConCreateFields({ ...asShownOff, "Broker Email": "typed@example.invalid" }, EXTRACTED, { withheldRe: WITHHELD_RE, values: false });
	check("create, value redaction off: the broker fields still come from the extract, the rest as sent",
		[r.fields["Broker Email"], r.fields.Details, [...r.fromHeld].sort()],
		[EXTRACTED["Broker Email"], EXTRACTED.Details, ["Broker Email", "Broker Name", "Broker Phone", "Documents Email"]]);
}
// The agent's name in the extract: free-text fields only.
{
	const named = bc.redactRateConFields({ "Broker Name": "Kevin", "Driver Name": "Kevin", Details: "ask Kevin", "Pickup Company Information": "Kevin's Dock" },
		{ withheldRe: WITHHELD_RE });
	check("extract: the agent's name is withheld in free text, never in Driver Name",
		[named["Driver Name"], named.Details, named["Pickup Company Information"]], ["Kevin", `ask ${W}`, `${W}'s Dock`]);
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

// ------------------------------------------------- Load IDs (2026-10-21)
// A Load ID as a non-Super-Admin may see it: what sanitizeBrokerColumns() does
// to the Load ID cell (the row's own contact, no name matching), except that an
// ID that was only contact reads "[contact withheld]" (R11b's rule), not blank.
{
	const own = bc.ownContact([["Phone Number", "555-010-0163"], ["Broker Contact Name", "Pat Agent"]]);
	const fn = typeof bc.loadIdAsShown === "function" ? bc.loadIdAsShown : () => "(no loadIdAsShown)";
	check("Load ID shown: an email-shaped ID reads as withheld", fn("agent.h4@example.invalid", own), W);
	check("Load ID shown: a dash-phone inside the ID is withheld, the rest kept", fn("QA-555-010-0161", own), `QA-${W}`);
	check("Load ID shown: a phone inside text is withheld", fn("Load 555.010.0162 A", null), `Load ${W} A`);
	check("Load ID shown: the row's own broker phone as bare digits is withheld", fn("5550100163", own), W);
	check("Load ID shown: a bare 10-digit run that is not the row's phone is kept", fn("5550100199", own), "5550100199");
	check("Load ID shown: a normal ID is kept exactly, a name is never matched in it", [fn("80000011", own), fn("PAT AGENT 1", own)], ["80000011", "PAT AGENT 1"]);
	check("Load ID shown: not a string, or blank, comes back as it is", [fn("", own), fn(null, own), fn(undefined, own)], ["", null, undefined]);
}
{
	const H = ["Load ID", "Driver", "Phone Number", "Email", "Details"];
	const row = (id, phone = "", email = "", details = "") => ({ "Load ID": id, Driver: "D", "Phone Number": phone, Email: email, Details: details });
	const rows = [
		row("QA-555-010-0161", "555-010-0170"),
		row("5550100163", "555-010-0163"),
		row("QA-555-010-0162"),
		row("agent.h4@example.invalid"),
		row("80000031", "555-010-0171"),
		// The same ID twice: withheld when any row withholds it.
		row("#5550100164"),
		row("5550100164", "(555) 010-0164"),
	];
	const build = typeof bc.buildShownLoadIdIndex === "function" ? bc.buildShownLoadIdIndex : null;
	const idx = build ? build(H, rows, { withheldRe: WITHHELD_RE }) : null;
	const shownOf = (raw, opts = {}) => (typeof bc.shownLoadIdOf === "function" ? bc.shownLoadIdOf(raw, { index: idx, ...opts }) : "(no shownLoadIdOf)");
	check("Load ID index: built over every row", !!idx, true);
	check("Load ID index: each hidden ID reads as shown, any letter case or a leading #",
		[shownOf("QA-555-010-0161"), shownOf("qa-555-010-0161"), shownOf("5550100163"), shownOf("agent.h4@example.invalid"), shownOf("80000031")],
		[`QA-${W}`, `QA-${W}`, W, W, "80000031"]);
	check("Load ID index: an ID on two rows is withheld when any row withholds it", [shownOf("5550100164"), shownOf("#5550100164")], [W, W]);
	check("Load ID index: an ID on no row falls back to the patterns only", [shownOf("Z 555-010-0188"), shownOf("5550100188")], [`Z ${W}`, "5550100188"]);
	check("Load ID index: a given row counts too (a load not on the sheet yet)",
		shownOf("5550100177", { row: row("5550100177", "555-010-0177"), withheldRe: WITHHELD_RE }), W);
	check("Load ID index: the hidden IDs, longest first",
		idx ? idx.hidden.map((h) => h.raw) : null,
		["agent.h4@example.invalid", "QA-555-010-0161", "QA-555-010-0162", "#5550100164", "5550100163", "5550100164"]);
	// Swapped inside values, any letter case, longest first; keys unchanged; never
	// in serialized JSON (an ID with a quote or a backslash is still found).
	const swap = (v, list = idx) => (typeof bc.swapHiddenLoadIds === "function" ? bc.swapHiddenLoadIds(v, list) : "(no swapHiddenLoadIds)");
	check("swap: an ID named in text, any letter case", swap("Load qa-555-010-0161 and load 5550100163 arrived"), `Load QA-${W} and load ${W} arrived`);
	check("swap: values at any depth, keys unchanged, other values kept",
		swap({ loadId: "5550100163", "5550100163": ["QA-555-010-0162", 7, null], n: "80000031" }),
		{ loadId: W, "5550100163": [`QA-${W}`, 7, null], n: "80000031" });
	check("swap: no hidden IDs, the value comes back as it is", swap("Load 5550100163", []), "Load 5550100163");
	const odd = bc.buildShownLoadIdIndex ? bc.buildShownLoadIdIndex(H, [row('Q"555-010-0165\\'), row("555-010-0166")], { withheldRe: WITHHELD_RE }) : null;
	check("swap: an ID holding a quote and a backslash, inside a JSON string's value",
		odd ? swap({ loadId: 'Q"555-010-0165\\', note: "QQ555-010-0166" }, odd) : null, { loadId: `Q"${W}\\`, note: `QQ${W}` });
	// A notice as served to a non-Super-Admin: the hidden IDs swapped in title,
	// body and metadata (an ID named only in the body too), then redacted.
	const notice = { id: 9, type: "status-updated", title: "Driver: In Transit", body: "Load 5550100163",
		metadata: JSON.stringify({ loadId: "5550100163", driverName: "D" }) };
	const n = bc.redactDispatchNotice(notice, { hidden: idx ? idx.hidden : [] });
	check("notice with hidden IDs: body and metadata.loadId swapped, metadata still a JSON string",
		[n.body, typeof n.metadata, JSON.parse(n.metadata).loadId], [`Load ${W}`, "string", W]);
	const live = bc.redactDispatchNotice({ type: "new-load", title: "New Load 5550100163", body: "Dallas → Tulsa", metadata: { loadId: "5550100163", rowIndex: 4 } }, { hidden: idx ? idx.hidden : [] });
	check("notice with hidden IDs, live (metadata an object): the title swapped, metadata stays an object",
		[live.title, live.metadata], [`New Load ${W}`, { loadId: W, rowIndex: 4 }]);
	check("notice for a Super Admin: an object metadata stays an object, the copy dropped",
		bc.fullDispatchNotice({ type: "x", title: "t", body: "b", metadata: { loadId: "5550100163", redactedBody: "c" } }).metadata, { loadId: "5550100163" });
}
{
	const LI = ["Load ID", "Contract ID", "Details"];
	const refuse = (before, values) => bc.contactNotAllowedRefusal(LI, before, values);
	const r1 = refuse(["80000011", "", ""], ["agent.h4@example.invalid", "", ""]);
	check("Load ID: an email typed in is refused, 400 CONTACT_NOT_ALLOWED naming Load ID",
		[(r1 || {}).code, (r1 || {}).field, /"Load ID"/.test((r1 || {}).error || "")], ["CONTACT_NOT_ALLOWED", "Load ID", true]);
	check("Load ID: a formatted phone typed in is refused", (refuse(["80000011", "", ""], ["QA-555-010-0161", "", ""]) || {}).code, "CONTACT_NOT_ALLOWED");
	check("Load ID: a stored ID resent unchanged is not refused", refuse(["QA-555-010-0161", "", ""], ["QA-555-010-0161", "", "x"]), null);
	check("Load ID: a load number, or bare digits, is fine", [refuse(["", "", ""], ["80000011", "", ""]), refuse([], ["5550100163", "", ""])], [null, null]);
	check("Load ID: the Payments Table's Job ID too", (bc.contactNotAllowedRefusal([" Job ID"], [""], ["555-010-0161"]) || {}).field, " Job ID");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log("\nFailures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
