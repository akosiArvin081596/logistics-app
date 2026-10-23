#!/usr/bin/env node
// lib/withheld-load-key.js: the opaque key a Dispatcher opens a withheld-ID load
// by (the Dispatcher raw Load ID plan, PR 2), and the reply guard.
//
// Written before the module existed: on main every check fails (no module).
//
//   §1 the key: its shape, both Load ID patterns of lib/load-id-rule.js, one key
//      per load whatever the spelling, one per process secret, nothing of the ID
//   §2 the key table of one Job Tracking read: only withheld IDs, with their
//      shown text and drivers
//   §3 the reply guard: the exact ID and the phones and emails its shown text
//      withholds are swapped; coordinates, timestamps, row numbers and reference
//      numbers that share digits are left alone
//
// THE FIXTURE IS MADE UP: QA- load numbers, 555-01xx numbers, example.invalid.
//
//   node scripts/test-withheld-load-key.js     # exits 1 on any failure
"use strict";

const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++; failures.push(name);
	console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
}
function attempt(name, fn) {
	try { fn(); } catch (e) { fail++; failures.push(name); console.log(`  FAIL  ${name}: ${e && e.message}`); }
}

const WITHHELD = "[contact withheld]";
const SECRET = Buffer.from("made-up-secret-for-the-runner-0001");
let lib = null;
try { lib = require(path.join(ROOT, "lib", "withheld-load-key")); } catch (e) { console.log(`  (lib/withheld-load-key.js not loadable: ${e.message})`); }
const bc = require(path.join(ROOT, "lib", "broker-contact"));
const rule = require(path.join(ROOT, "lib", "load-id-rule"));

attempt("§1 the key", () => {
	const keys = lib.createLoadKeys({ secret: SECRET });
	const k = keys.keyFor("QA-555-010-0199");
	check("§1 a key is wk- and 27 base64url characters (30 in all)", [k.length, lib.LOAD_KEY_RE.test(k), lib.isLoadKey(k)], [30, true, true]);
	check("§1 a key passes both Load ID patterns (the load pages open it)", rule.loadIdOpenable(k), true);
	const hmac = "wk-" + crypto.createHmac("sha256", SECRET).update("qa-555-010-0199", "utf8").digest("base64url").slice(0, 27);
	check("§1 it is the HMAC of the ID as loads are compared, nothing else", k, hmac);
	check("§1 the key holds nothing of the ID (no digit run of it, not its text)",
		["555", "010", "0199", "QA-", "qa-"].filter((p) => k.includes(p)), []);
	check("§1 one load, one key: case, edge spaces and a leading # aside",
		[keys.keyFor(" qa-555-010-0199 "), keys.keyFor("#QA-555-010-0199")], [k, k]);
	check("§1 two loads that read alike when withheld get different keys",
		keys.keyFor("QA-555-010-0200") !== k, true);
	check("§1 another process secret, another key (a restart makes every key unknown)",
		lib.createLoadKeys({ secret: Buffer.from("another-made-up-secret") }).keyFor("QA-555-010-0199") !== k, true);
	check("§1 a number ID keys as its text; a blank or non-text ID gets no key",
		[keys.keyFor(5550100142) === keys.keyFor("5550100142"), keys.keyFor(""), keys.keyFor("   "), keys.keyFor(null), keys.keyFor({})],
		[true, "", "", "", ""]);
	check("§1 isLoadKey: a key's shape only",
		[lib.isLoadKey("wk-short"), lib.isLoadKey(`${k} `), lib.isLoadKey("QA-555-010-0199"), lib.isLoadKey(null), lib.isLoadKey(`${k}x`)],
		[false, false, false, false, false]);
	check("§1 a random secret per process when none is given", typeof lib.createLoadKeys().keyFor("QA-1"), "string");
});

// A made-up Job Tracking read: two withheld IDs that read alike, the row's own
// broker phone as a bare-digit ID, an email-shaped ID, and a normal ID.
const WITHHELD_RE = /broker|phone|e-?mail|contact|\bfax\b|mobile|\bcell\b/i;
const HEADERS = ["Load ID", "Driver", "Job Status", "Phone Number", "Email"];
const ROWS = [
	{ "Load ID": "QA-555-010-0199", Driver: "Test Driver", "Job Status": "Dispatched", "Phone Number": "", Email: "" },
	{ "Load ID": "QA-555-010-0200", Driver: "Other Driver", "Job Status": "Assigned", "Phone Number": "", Email: "" },
	{ "Load ID": "5550100142", Driver: "Test  driver", "Job Status": "In Transit", "Phone Number": "555-010-0142", Email: "" },
	{ "Load ID": "dispatch.desk@example.invalid", Driver: "", "Job Status": "Unassigned", "Phone Number": "", Email: "" },
	{ "Load ID": "80000013", Driver: "Test Driver", "Job Status": "Assigned", "Phone Number": "555-010-0143", Email: "" },
	{ "Load ID": "qa-555-010-0199", Driver: "Second Driver", "Job Status": "Cancelled", "Phone Number": "", Email: "" },
];

attempt("§2 the key table", () => {
	const keys = lib.createLoadKeys({ secret: SECRET });
	const index = bc.buildShownLoadIdIndex(HEADERS, ROWS, { withheldRe: WITHHELD_RE });
	const table = lib.buildLoadKeyTable(HEADERS, ROWS, { index, keyFor: keys.keyFor, driverKey: (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ") });
	const entries = [...table.values()].map((e) => [e.raw, e.shown, [...e.drivers].sort(), e.key === keys.keyFor(e.raw)]);
	// "QA-555-010-0199" and "qa-555-010-0199" are one load whose two spellings
	// read differently when withheld, so the index names it "[contact withheld]".
	check("§2 one entry per withheld load, its stored ID, its shown text, every driver on its rows, its key",
		entries, [
			["QA-555-010-0199", WITHHELD, ["second driver", "test driver"], true],
			["QA-555-010-0200", `QA-${WITHHELD}`, ["other driver"], true],
			["5550100142", WITHHELD, ["test driver"], true],
			["dispatch.desk@example.invalid", WITHHELD, [], true],
		]);
	check("§2 a normal ID has no key in the table", table.has(keys.keyFor("80000013")), false);
	// A "Driver Pay" column before "Driver": the drivers are still the Driver
	// column's, as every Driver lookup in server.js prefers the exact header.
	const PAY_FIRST = ["Load ID", "Driver Pay", "Driver", "Job Status", "Phone Number", "Email"];
	const payRows = ROWS.map((r) => ({ ...r, "Driver Pay": "$300.00" }));
	const payTable = lib.buildLoadKeyTable(PAY_FIRST, payRows, {
		index: bc.buildShownLoadIdIndex(PAY_FIRST, payRows, { withheldRe: WITHHELD_RE }), keyFor: keys.keyFor,
		driverKey: (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " "),
	});
	check("§2 a \"Driver Pay\" column before \"Driver\": each load's drivers are still the Driver column's",
		[...payTable.values()].map((e) => [e.raw, [...e.drivers].sort()]), entries.map(([raw, , drivers]) => [raw, drivers]));
	check("§2 no index, no key function, or no Load ID column: an empty table",
		[lib.buildLoadKeyTable(HEADERS, ROWS, { keyFor: keys.keyFor }).size, lib.buildLoadKeyTable(HEADERS, ROWS, { index }).size,
			lib.buildLoadKeyTable(["Driver"], [{ Driver: "x" }], { index, keyFor: keys.keyFor }).size], [0, 0, 0]);
});

attempt("§3 the reply guard", () => {
	check("§3 the withheld parts: what stands where the shown text reads withheld",
		[lib.withheldParts("QA-555-010-0199", `QA-${WITHHELD}`), lib.withheldParts("5550100142", WITHHELD),
			lib.withheldParts("A 555-010-0150 B 555-010-0151", `A ${WITHHELD} B ${WITHHELD}`), lib.withheldParts("80000013", "80000013")],
		[["555-010-0199"], ["5550100142"], ["555-010-0150", "555-010-0151"], []]);
	const g = lib.replyGuardFor("QA-555-010-0199", `QA-${WITHHELD}`);
	const run = (v) => lib.guardReply(v, g);
	const swapped = run({
		error: "Load QA-555-010-0199 is not on Job Tracking",
		a: "call (555) 010-0199", b: "5550100199", c: "+1 555.010.0199 ext", d: "qa-555-010-0199",
		nested: [{ deep: ["QA-555-010-0199"] }], "QA-555-010-0199": 1,
	});
	check("§3 the ID, any letter case, and its phone in any spacing are swapped for the shown text, keys and nested values too",
		[swapped.value, swapped.hits], [{
			error: `Load QA-${WITHHELD} is not on Job Tracking`,
			a: `call ${WITHHELD}`, b: WITHHELD, c: `${WITHHELD} ext`, d: `QA-${WITHHELD}`,
			nested: [{ deep: [`QA-${WITHHELD}`] }], [`QA-${WITHHELD}`]: 1,
		}, 7]);
	const alone = {
		lat: 35.5550100199, latText: "35.5550100199", lng: -97.5550100199, at: "2026-10-22T14:30:00.000Z", ms: 1761155501001990,
		msText: "1761155501001990", rowIndex: 555, row: "row 555", po: "41000019", poLong: "PO 155501001990", ratio: "5550100199.5",
	};
	const left = run(alone);
	check("§3 coordinates, timestamps, row numbers and reference numbers sharing the digits are left alone (no hit, same object)",
		[left.hits, left.value === alone], [0, true]);
	const e = lib.replyGuardFor("dispatch.desk@example.invalid", WITHHELD);
	const em = lib.guardReply("Load DISPATCH.DESK@example.invalid not found", e);
	check("§3 an email-shaped ID with no digits is caught by its exact text, any letter case", [em.value, em.hits], [`Load ${WITHHELD} not found`, 1]);
	const own = lib.replyGuardFor("5550100142", WITHHELD);
	const ownHit = lib.guardReply(["Load 5550100142", "555-010-0142", "155501001423", "5550100142.5", 5550100142], own);
	check("§3 a bare-digit ID (the row's own phone): the ID and the phone caught; a longer number, a decimal and a JSON number left alone",
		[ownHit.value, ownHit.hits], [[`Load ${WITHHELD}`, WITHHELD, "155501001423", "5550100142.5", 5550100142], 2]);
	const plain = lib.replyGuardFor("80000013", "80000013");
	check("§3 a reply that names nothing withheld comes back unchanged", lib.guardReply({ ok: true, loadId: "QA-[contact withheld]" }, plain).hits, 0);
	check("§3 a string reply (res.send) is guarded too", lib.guardReply("Load QA-555-010-0199", g).value, `Load QA-${WITHHELD}`);
	check("§3 no guard, nothing changes", lib.guardReply({ a: "QA-555-010-0199" }, null), { value: { a: "QA-555-010-0199" }, hits: 0 });
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log(`Failed:\n  - ${failures.join("\n  - ")}`);
	process.exit(1);
}
