#!/usr/bin/env node
// lib/chr-events.js: which loads are C.H. Robinson's, the per-stop state machine,
// the multi-stop signals, the payload allowlist and the redactor (R5 PR 1a: plan
// 4.3, 4.4, 4.6 and 4.9; review-2 NL1 and NL2). Nothing calls the module yet.
//
//   §1  the projection: exactly its keys; never the agent's address or the Payment
//   §2  the CHR-load test, and what each failure records
//   §3  forward steps, NL2's steps from "before", repeats, keys, the baseline
//   §4  reverts: overrides, manual moves backwards, cancellations; voided keys
//   §5  the plan's cases: two pickups, two drops, a mistaken At Receiver, an
//       In Transit undone and repeated, a revived load, a geofence-only arrival
//   §6  multi-stop signals; what v1 may send
//   §7  the redactor: exact values only; the values live only in its closure (NL1)
//   §8  the payload: the key list, the patterns, the dropped-field count,
//       positions only when allowed
//   §9  the canary: made-up person data in every field a person can reach
//   §10 server.js and lib parity
//   §11 the module stays pure
//
// Made-up data only. No network, no database, no files written.
//   node scripts/test-chr-events.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");
const util = require("util");

const ROOT = path.join(__dirname, "..");
const E = require(path.join(ROOT, "lib", "chr-events.js"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function section(t) { console.log(`\n${t}`); }

// Made-up canaries: a name, a phone, an email, SSN-like and CDL-like strings, a
// date of birth, a street, an amount, and a carrier-number stand-in that is
// deliberately not shaped like a real one (digits only, 14 of them).
const CANARY = Object.freeze({
	name: "Canary Testdriver",
	phone: "(555) 555-0147",
	email: "canary.agent@example.test",
	ssn: "000-12-3456",
	cdl: "CDL D0000001",
	dob: "01/02/1970",
	street: "742 Evergreen Terrace",
	money: "$1,234.56",
	carrier: "77700011122233",
});
const CANARY_VALUES = Object.values(CANARY);
const hasCanary = (text) => CANARY_VALUES.filter((c) => String(text).toLowerCase().includes(c.toLowerCase()));

const LOAD = "123456789";
let clockMin = 0;
let nextId = 1;
function resetRows() { clockMin = 0; nextId = 1; }
// One load_status_history row as the sweep selects it (no actor, no reason).
function H(status, source = "manual") {
	clockMin += 5;
	const at = new Date(Date.UTC(2026, 10, 2, 15, 0, 0) + clockMin * 60000).toISOString().slice(0, 19).replace("T", " ");
	return { id: nextId++, load_id: LOAD, old_status: "", new_status: status, source, changed_at: at };
}
const tag = (e) => `${e.event}:${e.stop.kind === "pickup" ? "p" : "d"}${e.stop.index}@h${e.rowId}${e.jump ? ":jump" : ""}`;
const replay = (rows, opts = {}) => E.replayLoad(rows, { loadKey: LOAD, baselineId: 0, ...opts });
const tags = (rows, opts) => replay(rows, opts).events.map(tag);

// ------------------------------------------------------------------ §1
section("§1  the projection");
const HEADERS = ["Load ID", "Status", "Driver", "Email", "Broker Contact Name", "Trailer Number", "Pickup Address", "Drop-off Address", "Payment", "Pickup Lat", "Pickup Lng"];
const ROW = {
	"Load ID": "#123456789", Status: "In Transit", Driver: CANARY.name, Email: "Canary.Agent@CHRobinson.com",
	"Broker Contact Name": "Agent Canary", "Trailer Number": "53001", "Pickup Address": "100 Test Rd, Ames, IA 50010",
	"Drop-off Address": "200 Sample Ave, Joliet, IL 60431", Payment: CANARY.money, "Pickup Lat": "42.0347", "Pickup Lng": "-93.62",
};
const P = E.projectRow(ROW, HEADERS);
eq(Object.keys(P), [...E.PROJECTION_KEYS], "§1 exactly the projection keys, in order");
eq(E.PROJECTION_KEYS, ["loadKey", "loadId", "brokerDomain", "trailer", "pickupAddress", "dropoffAddress", "driverName"], "§1 the key list");
eq([P.loadKey, P.loadId, P.brokerDomain], ["123456789", "123456789", "chrobinson.com"], "§1 load key, Load ID without '#', the email's domain");
eq([P.trailer, P.pickupAddress, P.dropoffAddress], ["53001", "100 Test Rd, Ames, IA 50010", "200 Sample Ave, Joliet, IL 60431"], "§1 trailer and the two addresses");
eq(P.driverName, CANARY.name, "§1 the Driver cell (memory only, to find the truck)");
ok(!JSON.stringify(P).toLowerCase().includes("canary.agent"), "§1 never the agent's address: only its domain");
ok(!JSON.stringify(P).includes("1,234.56"), "§1 never the Payment");
ok(!JSON.stringify(P).includes("Agent Canary"), "§1 never the broker contact name");
eq(E.projectRow({ "Load ID": "", Email: "" }, ["Load ID", "Email"]).brokerDomain, "", "§1 a blank Email cell: no domain");
eq(E.projectRow({ Email: "made-up.a@chrobinson.com; made-up.b@example.test" }, ["Email"]).brokerDomain, "", "§1 two addresses in the cell: no domain (one readable address only)");
eq(E.projectRow({ Email: "Made Up <made-up.agent@chrobinson.com>" }, ["Email"]).brokerDomain, "", "§1 a name before the address: no domain");
eq(E.projectRow({}, []).loadKey, "", "§1 no columns: empty values, no throw");

// ------------------------------------------------------------------ §2
section("§2  the CHR-load test");
const proj = (over) => ({ ...P, ...over });
eq(E.chrLoadTest(proj({})), { verdict: "chr" }, "§2 chrobinson.com and a 9-digit Load ID: a CHR load");
eq(E.chrLoadTest(proj({ brokerDomain: "loads.chrobinson.com" })), { verdict: "chr" }, "§2 a subdomain counts");
eq(E.chrLoadTest(null), { verdict: "skip", reason: "load_missing" }, "§2 missing from Job Tracking: skipped_not_chr, load_missing");
eq(E.chrLoadTest(proj({ brokerDomain: "" })), { verdict: "skip", reason: "email_blank" }, "§2 Email blank or unreadable: skipped_not_chr, email_blank");
eq(E.chrLoadTest(proj({ brokerDomain: "tql.com" })), { verdict: "other" }, "§2 another broker's domain: nothing recorded");
eq(E.chrLoadTest(proj({ brokerDomain: "notchrobinson.com" })), { verdict: "other" }, "§2 a lookalike domain is another broker");
eq(E.chrLoadTest(proj({ brokerDomain: "chrobinson.com.example.test" })), { verdict: "other" }, "§2 chrobinson.com inside another domain is another broker");
eq(E.chrLoadTest(proj({ loadId: "12345678", loadKey: "12345678" })), { verdict: "skip", reason: "load_id_not_9_digits" }, "§2 chrobinson.com, 8 digits: skipped_not_chr, load_id_not_9_digits");
eq(E.chrLoadTest(proj({ loadId: "LD12345678", loadKey: "ld12345678" })), { verdict: "skip", reason: "load_id_not_9_digits" }, "§2 letters in the Load ID: not 9 digits");
eq(E.chrLoadTest(proj({ loadId: "9876543210", loadKey: "9876543210" })), { verdict: "skip", reason: "load_id_not_9_digits" }, "§2 10 digits: not 9 digits");
const R0 = E.createRedactor({ denyList: "123456789" });
eq(E.chrLoadTest(proj({}), { redactor: R0 }), { verdict: "withheld" }, "§2 a Load ID holding a protected value: withheld (nothing stored)");
eq(E.chrLoadTest(proj({}), { redactor: E.createRedactor({ denyList: "55555" }) }), { verdict: "chr" }, "§2 a protected value elsewhere changes nothing");
eq(E.isChrDomain("CHROBINSON.COM"), false, "§2 the test takes a lower-case domain (domainOf() lower-cases)");
eq(E.domainOf("Made-Up.Ops@CHRobinson.com"), "chrobinson.com", "§2 domainOf lower-cases");

// ------------------------------------------------------------------ §3
section("§3  forward steps, NL2, repeats, keys");
resetRows();
let rows = [H("Dispatched", "dispatch"), H("Assigned", "accept"), H("Heading to Shipper"), H("At Shipper"), H("Loading"), H("In Transit"), H("At Receiver"), H("Delivered")];
eq(tags(rows), ["arrived_pickup:p1@h4", "departed_pickup:p1@h6", "arrived_delivery:d1@h7", "delivered:d1@h8"], "§3 the common trip: four events, keyed by the row that entered each phase");
let r = replay(rows);
eq(r.events.map((e) => e.key), ["ms|123456789|arrived_pickup|p1|h4", "ms|123456789|departed_pickup|p1|h6", "ms|123456789|arrived_delivery|d1|h7", "ms|123456789|delivered|final|h8"], "§3 the key format ms|load|event|stop|h<row>");
eq(r.events.map((e) => e.final), [false, false, true, true], "§3 the drop arrival and delivered are labelled final delivery");
eq(r.multiStop, false, "§3 no multi-stop signal");
eq(r.phase.kind, "delivered", "§3 ends delivered");
eq(r.events.map((e) => [e.source, e.at, e.atMs]), rows.filter((x) => [4, 6, 7, 8].includes(x.id)).map((x) => [x.source, x.changed_at, Date.parse(`${x.changed_at.replace(" ", "T")}Z`)]),
	"§3 each event keeps its row's source and time (changed_at read as UTC)");
resetRows();
eq(tags([H("Dispatched", "dispatch"), H("In Transit")]), ["departed_pickup:p1@h2"], "§3 before -> In Transit: the departure, no arrival invented");
resetRows();
eq(tags([H("Dispatched", "dispatch"), H("Loading"), H("In Transit")]), ["departed_pickup:p1@h3"], "§3 NL2: before -> Loading is at pickup 1 with no arrival invented");
resetRows();
eq(tags([H("Dispatched", "dispatch"), H("At Receiver")]), ["arrived_delivery:d1@h2:jump"], "§3 NL2: before -> At Receiver jumps: the phase is set and the event it lands on is marked a jump (held)");
resetRows();
eq(tags([H("Dispatched", "dispatch"), H("Delivered")]), ["delivered:d1@h2:jump"], "§3 NL2: before -> Delivered jumps too");
resetRows();
eq(tags([H("At Shipper"), H("Delivered")]), ["arrived_pickup:p1@h1", "delivered:d1@h2"], "§3 any trip phase -> Delivered is a forward step");
resetRows();
eq(tags([H("At Shipper"), H("At Shipper", "geofence"), H("Loading"), H("Loading"), H("In Transit"), H("In Transit", "geofence")]), ["arrived_pickup:p1@h1", "departed_pickup:p1@h5"], "§3 repeats of the current phase add nothing");
resetRows();
eq(tags([H("At Shipper"), H("In Transit"), H("At Receiver"), H("Completed")]).slice(-1), ["delivered:d1@h4"], "§3 Completed is delivered");
resetRows();
eq(tags([H("At Shipper"), H("POD Received")]).slice(-1), ["delivered:d1@h2"], "§3 POD Received is delivered");
resetRows();
eq(tags([H("At Shipper"), H("Waiting on dock"), H("In Transit")]), ["arrived_pickup:p1@h1", "departed_pickup:p1@h3"], "§3 a status outside the list is ignored");
resetRows();
eq(tags([H("at shipper"), H(" IN  TRANSIT ")]), ["arrived_pickup:p1@h1", "departed_pickup:p1@h2"], "§3 statuses match regardless of case and spacing");
resetRows();
rows = [H("At Shipper"), H("Loading"), H("In Transit"), H("At Receiver")];
eq(tags(rows, { baselineId: 3 }), ["arrived_delivery:d1@h4"], "§3 the baseline: rows at or below it enter no event, though they still set the phase");
eq(replay(rows, { baselineId: 3 }).liveKeys.length, 3, "§3 ...and their keys stay live (so nothing recorded is voided by the baseline)");
resetRows();
rows = [H("At Shipper"), H("In Transit")];
rows.reverse();
eq(tags(rows), ["arrived_pickup:p1@h1", "departed_pickup:p1@h2"], "§3 rows are replayed oldest first (changed_at, then id), in any input order");

// ------------------------------------------------------------------ §4
section("§4  reverts");
resetRows();
r = replay([H("At Shipper"), H("In Transit"), H("At Shipper", "override")]);
eq(r.events.map(tag), ["arrived_pickup:p1@h1"], "§4 override In Transit -> At Shipper undoes the departure; it is not pickup 2");
eq(r.multiStop, false, "§4 ...and is no multi-stop signal");
ok(!r.liveKeys.includes("ms|123456789|departed_pickup|p1|h2"), "§4 ...the departure's key is no longer live (the sweep voids it)");
resetRows();
eq(tags([H("At Shipper"), H("In Transit"), H("At Shipper")]), ["arrived_pickup:p1@h1", "departed_pickup:p1@h2", "arrived_pickup:p2@h3"], "§4 the same row as a manual tap is the next pickup (a multi-stop signal)");
resetRows();
eq(tags([H("At Shipper"), H("In Transit"), H("At Receiver"), H("At Shipper")]), ["arrived_pickup:p1@h1"], "§4 a manual At Receiver straight back to At Shipper is a revert");
resetRows();
eq(tags([H("At Shipper"), H("In Transit"), H("At Receiver"), H("In Transit", "override")]), ["arrived_pickup:p1@h1", "departed_pickup:p1@h2"], "§4 override At Receiver -> In Transit undoes the drop arrival");
resetRows();
eq(tags([H("At Shipper"), H("In Transit"), H("At Receiver"), H("In Transit")]), ["arrived_pickup:p1@h1", "departed_pickup:p1@h2", "arrived_delivery:d1@h3", "departed_delivery:d1@h4"], "§4 the same row as a manual tap is a departure from drop 1");
resetRows();
eq(tags([H("At Shipper"), H("Heading to Shipper")]), [], "§4 a manual Heading to Shipper after At Shipper reverts to before");
resetRows();
eq(tags([H("At Shipper"), H("In Transit"), H("At Receiver"), H("Delivered"), H("At Receiver", "override")]), ["arrived_pickup:p1@h1", "departed_pickup:p1@h2", "arrived_delivery:d1@h3"], "§4 override Delivered -> At Receiver undoes delivered");
resetRows();
eq(tags([H("At Shipper"), H("In Transit"), H("Loading")]), ["arrived_pickup:p1@h1"], "§4 a manual Loading after the departure reverts to the pickup");
resetRows();
eq(tags([H("In Transit"), H("At Shipper", "override")]), ["arrived_pickup:p1@h2"], "§4 a revert with no earlier matching phase rewinds and applies the row: the arrival is entered by the override");
resetRows();
eq(tags([H("At Shipper"), H("At Receiver"), H("In Transit", "override")]), ["arrived_pickup:p1@h1", "departed_pickup:p1@h3"], "§4 a revert keeps phases before its target: the pickup arrival stays");
resetRows();
eq(tags([H("At Shipper"), H("In Transit"), H("At Receiver", "override")]), ["arrived_pickup:p1@h1", "departed_pickup:p1@h2", "arrived_delivery:d1@h3"], "§4 an override that moves forward is a forward step");
resetRows();
r = replay([H("At Shipper"), H("Dispatched", "dispatch"), H("At Shipper")]);
eq(r.events.map(tag), ["arrived_pickup:p1@h1", "arrived_pickup:p1@h3"], "§4 a dispatch row only sets the phase: nothing is voided, and the next arrival has its own key");
resetRows();
eq(tags([H("At Shipper"), H("Dispatched", "override")]), [], "§4 an override to Dispatched is a revert");
resetRows();
r = replay([H("At Shipper"), H("In Transit"), H("Cancelled", "cancel")]);
eq([r.events.length, r.liveKeys.length, r.phase.kind], [0, 0, "before"], "§4 Cancelled ends the trip: no live event or key");
eq(E.REVERTED_NOTE, "Sent, then reverted: check it in Navisphere.", "§4 NL2: a sent event that a revert voids is shown as \"check it in Navisphere\"");
ok(!/correct/i.test(E.REVERTED_NOTE), "§4 ...never \"correct it\" (the override may have recorded a true next stop)");

// ------------------------------------------------------------------ §5
section("§5  the plan's cases");
resetRows();
r = replay([H("Dispatched", "dispatch"), H("At Shipper"), H("Loading"), H("In Transit"), H("At Shipper"), H("Loading"), H("In Transit"), H("At Receiver"), H("Delivered")]);
eq(r.events.map(tag), ["arrived_pickup:p1@h2", "departed_pickup:p1@h4", "arrived_pickup:p2@h5", "departed_pickup:p2@h7", "arrived_delivery:d1@h8", "delivered:d1@h9"], "§5 two pickups");
eq(r.multiStop, true, "§5 ...a multi-stop signal (history)");
resetRows();
r = replay([H("At Shipper"), H("In Transit"), H("At Receiver"), H("In Transit"), H("At Receiver"), H("Delivered")]);
eq(r.events.map(tag), ["arrived_pickup:p1@h1", "departed_pickup:p1@h2", "arrived_delivery:d1@h3", "departed_delivery:d1@h4", "arrived_delivery:d2@h5", "delivered:d2@h6"], "§5 two drops");
eq(r.multiStop, true, "§5 ...a multi-stop signal (history)");
resetRows();
r = replay([H("Dispatched", "dispatch"), H("At Shipper"), H("At Receiver"), H("At Shipper", "override"), H("In Transit"), H("At Receiver", "geofence"), H("Delivered")]);
eq(r.events.map(tag), ["arrived_pickup:p1@h2", "departed_pickup:p1@h5", "arrived_delivery:d1@h6", "delivered:d1@h7"], "§5 a mistaken At Receiver at the shipper, then an override back: the real arrival is recorded under its own row");
ok(!r.liveKeys.includes("ms|123456789|arrived_delivery|d1|h3") && r.liveKeys.includes("ms|123456789|arrived_delivery|d1|h6"), "§5 ...the mistaken arrival's key is voided, the real one is live");
eq(r.events.find((e) => e.rowId === 6).final, true, "§5 ...and is labelled final delivery");
resetRows();
r = replay([H("At Shipper"), H("In Transit"), H("At Shipper", "override"), H("In Transit")]);
eq(r.events.map(tag), ["arrived_pickup:p1@h1", "departed_pickup:p1@h4"], "§5 an In Transit tap undone by an override, then repeated: the repeat has its own key");
resetRows();
r = replay([H("At Shipper"), H("Cancelled", "cancel"), H("Dispatched", "dispatch"), H("At Shipper")]);
eq([r.events.map(tag), r.liveKeys], [["arrived_pickup:p1@h4"], ["ms|123456789|arrived_pickup|p1|h4"]], "§5 a load revived after Cancelled: new keys only");
resetRows();
r = replay([H("At Shipper"), H("In Transit"), H("At Receiver", "geofence")]);
eq([r.events.map(tag).slice(-1), r.events[2].final, r.multiStop], [["arrived_delivery:d1@h3"], true, false], "§5 a geofence-only final arrival on a two-drop load: labelled final delivery, no history signal");
eq(E.multiStopSignal({ history: r.multiStop, instructionStops: { pickups: 1, deliveries: 2 } }), { multiStop: true, why: "instructions" }, "§5 ...the instructions' two deliveries are the signal that holds it");

// ------------------------------------------------------------------ §6
section("§6  multi-stop signals and what v1 sends");
eq(E.multiStopSignal({ history: false, instructionStops: null, marked: false }), { multiStop: false, why: "" }, "§6 no signal");
eq(E.multiStopSignal({ history: true, instructionStops: { pickups: 2, deliveries: 1 }, marked: true }), { multiStop: true, why: "history" }, "§6 history first");
eq(E.multiStopSignal({ history: false, instructionStops: { pickups: 2, deliveries: 1 } }), { multiStop: true, why: "instructions" }, "§6 two pickups in the instructions");
eq(E.multiStopSignal({ history: false, instructionStops: { pickups: 1, deliveries: 1 }, marked: true }), { multiStop: true, why: "person" }, "§6 a Super Admin's mark");
eq(E.instructionStopCounts({ stops: [{ kind: "pickup" }, { kind: "delivery" }, { kind: "delivery" }, { kind: "other" }] }), { pickups: 1, deliveries: 2 }, "§6 instruction stops counted by kind");
eq(E.instructionStopCounts(null), null, "§6 no payload: no counts");
eq(E.instructionStopCounts({ stops: "x" }), null, "§6 a payload without a stop list: no counts");
const ev = (event, kind, index) => ({ event, stop: { kind, index } });
eq([ev("arrived_pickup", "pickup", 1), ev("departed_pickup", "pickup", 1), ev("arrived_delivery", "delivery", 1), ev("delivered", "delivery", 1), ev("arrived_delivery", "delivery", 2)].map(E.isSendable),
	[true, true, true, true, true], "§6 v1 may send pickup 1 and the final delivery (a drop arrival is checked at the mapped drop-off point)");
eq([ev("arrived_pickup", "pickup", 2), ev("departed_pickup", "pickup", 2), ev("departed_delivery", "delivery", 1)].map(E.isSendable), [false, false, false], "§6 never an intermediate stop");
eq([E.payloadStop(ev("departed_pickup", "pickup", 1)), E.payloadStop(ev("arrived_delivery", "delivery", 2)), E.payloadStop(ev("departed_pickup", "pickup", 2))],
	[{ kind: "pickup", index: 1 }, { kind: "delivery", index: "final" }, null], "§6 the payload's stop: pickup 1 or the final delivery");

// ------------------------------------------------------------------ §7
section("§7  the redactor (NL1)");
const RD = E.createRedactor({ denyList: CANARY.carrier, exact: ["made-up-client-secret-0001"] });
ok(RD.hits(`ref ${CANARY.carrier} here`), "§7 a deny value is found");
ok(RD.hits(CANARY.carrier.replace(/(\d{3})/g, "$1-")), "§7 ...across separators (hyphens)");
ok(RD.hits(CANARY.carrier.replace(/(\d{4})/g, "$1 ")), "§7 ...and spaces");
ok(RD.hits("ＲＥＦ７７７０００１１１２２２３３"), "§7 ...and in full-width digits");
ok(!RD.hits("77700011122234"), "§7 one digit off is no hit: exact values only");
ok(!RD.hits("T7770001"), "§7 never a shape: a T-number-like string that is no deny value is no hit");
ok(RD.hits("token MADE-UP-CLIENT-SECRET-0001 end"), "§7 an exact credential value is found, in any letter case");
eq(RD.redact(`a ${CANARY.carrier} b`), "a [withheld] b", "§7 redact() replaces a hit");
eq(RD.redact("nothing here 12345"), "nothing here 12345", "§7 ...and leaves other text alone");
eq(RD.redact("x made-up-client-secret-0001 y"), "x [withheld] y", "§7 ...an exact value too");
eq(RD.count, 2, "§7 count: how many values, never which");
ok(Object.isFrozen(RD), "§7 frozen");
eq(Object.getOwnPropertyNames(RD).sort(), ["count", "hits", "redact"], "§7 its only fields: hits, redact, count");
ok(!JSON.stringify(RD).includes(CANARY.carrier) && !JSON.stringify(RD).includes("0001"), "§7 JSON shows no value");
ok(!util.inspect(RD, { showHidden: true, depth: 10 }).includes(CANARY.carrier), "§7 inspect (hidden fields too) shows no value");
ok(!RD.hits.toString().includes(CANARY.carrier) && !RD.redact.toString().includes(CANARY.carrier), "§7 neither function's text holds one");
eq(E.createRedactor({ denyList: "1234" }).count, 0, "§7 a deny value under 5 digits is ignored (the driver-instructions rule)");
eq(E.createRedactor({ exact: ["short"] }).count, 0, "§7 an exact value under 8 characters is ignored");
const RN = E.createRedactor({});
ok(!RN.hits(CANARY.carrier) && RN.redact("abc") === "abc" && RN.count === 0, "§7 nothing configured: no hits");
ok(!RD.hits("x".repeat(100000)) && RD.hits(`${"x".repeat(3000)} ${CANARY.carrier}`), "§7 long text is read to its cap, quickly");

// ------------------------------------------------------------------ §8
section("§8  the payload");
const T0 = Date.parse("2026-11-02T16:05:10Z");
const base = {
	loadId: "123456789", event: "departed_pickup", stop: { kind: "pickup", index: 1 }, eventAtMs: T0,
	address: "100 Test Rd, Ames, IA 50010", point: null, ping: null, positionsAllowed: false,
	truckUnit: "T-101", trailer: "53001", personNames: [CANARY.name], redactor: E.createRedactor({}),
};
let b = E.buildPayload(base);
eq(b.payload, {
	loadNumber: "123456789", event: "departed_pickup", stop: { kind: "pickup", index: 1 },
	eventAt: "2026-11-02T16:05:10Z", eventLocal: { time: "2026-11-02T10:05:10", zone: "America/Chicago" },
	place: { city: "Ames", state: "IA" }, truck: "T-101", trailer: "53001",
}, "§8 the plan's example payload, byte for byte");
eq(b.fieldsDropped, 0, "§8 nothing dropped");
eq(E.PAYLOAD_KEYS, ["loadNumber", "event", "stop", "eventAt", "eventLocal", "place", "position", "truck", "trailer"], "§8 the key list");
const PING = { lat: 42.03468123, lng: -93.61994567, ms: T0 - 60000 };
b = E.buildPayload({ ...base, ping: PING, positionsAllowed: true });
eq(b.payload.position, { lat: 42.0347, lng: -93.6199 }, "§8 positions allowed: the confirming ping's position, 4 decimals");
ok(Object.keys(b.payload).every((k) => E.PAYLOAD_KEYS.includes(k)), "§8 no key off the list");
eq(E.buildPayload({ ...base, ping: PING, positionsAllowed: false }).payload.position, undefined, "§8 positions not allowed: no position");
eq(E.buildPayload({ ...base, ping: null, positionsAllowed: true }).payload.position, undefined, "§8 no confirming ping: no position");
b = E.buildPayload({ ...base, trailer: `53001 / call ${CANARY.name} ${CANARY.phone}` });
eq([b.payload.trailer, b.fieldsDropped], [undefined, 1], "§8 a trailer cell with more than a number sends no trailer, and is counted");
b = E.buildPayload({ ...base, trailer: "5300112345678" });
eq([b.payload.trailer, b.fieldsDropped], [undefined, 1], "§8 13 characters: dropped, never cut down to fit");
eq(E.buildPayload({ ...base, trailer: "  53001 " }).payload.trailer, "53001", "§8 surrounding spaces are not part of the value");
b = E.buildPayload({ ...base, truckUnit: "T-101 (spare)" });
eq([b.payload.truck, b.fieldsDropped], [undefined, 1], "§8 a truck unit off the pattern: dropped and counted");
eq(E.buildPayload({ ...base, truckUnit: "", trailer: "" }).fieldsDropped, 0, "§8 empty cells are absent, not dropped");
// The pattern alone would pass these: person-data shapes are dropped too.
for (const [label, field, v] of [
	["an SSN-shaped trailer", "trailer", "000-12-3456"],
	["a formatted phone as the trailer", "trailer", "555-555-0147"],
	["a seven-digit phone as the truck", "truckUnit", "555-0147"],
	["a date as the trailer", "trailer", "01-02-1970"],
	["an ISO date as the truck", "truckUnit", "1970-01-02"],
	["the driver's name in the trailer cell", "trailer", "TESTDRIVER-1"],
]) {
	b = E.buildPayload({ ...base, [field]: v });
	eq([b.payload[field === "truckUnit" ? "truck" : "trailer"], b.fieldsDropped], [undefined, 1], `§8 ${label}: dropped and counted`);
}
eq(E.buildPayload({ ...base, trailer: "5300100147" }).payload.trailer, "5300100147", "§8 a bare digit run is a trailer number, never a phone (the house rule in lib/broker-contact.js)");
b = E.buildPayload({ ...base, address: `${CANARY.name}, IA 50010` });
eq([b.payload.place, b.fieldsDropped], [{ state: "IA" }, 1], "§8 the driver's name in the city slot: dropped");
b = E.buildPayload({ ...base, address: "Suite 5, IA 50010" });
eq([b.payload.place, b.fieldsDropped], [{ state: "IA" }, 1], "§8 a city off the pattern is dropped; the state stays");
b = E.buildPayload({ ...base, address: "Somewhere without a state" });
eq([b.payload.place, b.payload.eventLocal, b.fieldsDropped], [undefined, undefined, 0], "§8 no readable state: no place and no local time");
eq(E.buildPayload({ ...base, address: "Joliet IL 60431" }).payload.place, { state: "IL" }, "§8 no comma before the state: the state only");
b = E.buildPayload({ ...base, event: "arrived_delivery", stop: { kind: "delivery", index: 1 }, address: "200 Sample Ave, Joliet, IL 60431" });
eq([b.payload.stop, b.payload.place], [{ kind: "delivery", index: "final" }, { city: "Joliet", state: "IL" }], "§8 a drop arrival: the final delivery, at the drop-off address");
for (const [label, over, why] of [
	["8 digits", { loadId: "12345678" }, "load_number"],
	["a '#' kept inside", { loadId: "1234#5678" }, "load_number"],
	["an event off the list", { event: "location_ping" }, "event"],
	["an intermediate stop", { stop: { kind: "pickup", index: 2 } }, "stop"],
	["a departure from a drop", { event: "departed_delivery", stop: { kind: "delivery", index: 1 } }, "stop"],
	["no time", { eventAtMs: NaN }, "event_at"],
]) eq(E.buildPayload({ ...base, ...over }), { payload: null, refused: why }, `§8 refused: ${label}`);
eq(E.buildPayload({ ...base, loadId: "#123456789" }).payload.loadNumber, "123456789", "§8 a leading '#' is not part of the Load ID");
b = E.buildPayload({ ...base, redactor: E.createRedactor({ denyList: "53001" }) });
eq([b.payload.trailer, b.fieldsDropped], [undefined, 1], "§8 a value holding a protected number is dropped, never sent");
eq(E.buildPayload({ ...base, redactor: E.createRedactor({ denyList: "123456789" }) }), { payload: null, refused: "load_number" }, "§8 a Load ID holding a protected number refuses the payload");

// ------------------------------------------------------------------ §9
section("§9  the canary");
const R9 = E.createRedactor({ denyList: CANARY.carrier });
const free = [
	`${CANARY.name} ${CANARY.phone}`, CANARY.name, CANARY.phone, CANARY.email, CANARY.ssn, CANARY.cdl, CANARY.dob, CANARY.street, CANARY.money, CANARY.carrier,
	`53001 ${CANARY.carrier}`, "555-555-0147", "555-0147", "01-02-1970",
];
const built = [];
for (const v of free) {
	for (const field of ["trailer", "truckUnit"]) built.push(E.buildPayload({ ...base, [field]: v, redactor: R9 }));
	for (const addr of [`${v}, Ames, IA 50010`, `Attn ${v}, ${CANARY.street}, Ames, IA 50010`, `${CANARY.street}, ${v}, IA 50010`]) {
		built.push(E.buildPayload({ ...base, address: addr, redactor: R9 }));
		built.push(E.buildPayload({ ...base, event: "delivered", stop: { kind: "delivery", index: 1 }, address: addr, redactor: R9, ping: PING, positionsAllowed: true }));
	}
}
built.push(E.buildPayload({ ...base, address: `${CANARY.name}, IA 50010`, redactor: R9 }));
const leaked = built.flatMap((x) => [...hasCanary(JSON.stringify(x.payload)), ...["555-555-0147", "555-0147", "01-02-1970"].filter((c) => JSON.stringify(x.payload).includes(c))]);
eq([...new Set(leaked)], [], "§9 no canary reaches any payload (trailer, truck unit, both addresses, the city slot)");
ok(built.every((x) => x.payload && Object.keys(x.payload).every((k) => E.PAYLOAD_KEYS.includes(k))), "§9 ...and every payload keeps to the key list");
ok(built.some((x) => x.fieldsDropped > 0), "§9 ...the canaries were dropped and counted, not silently trimmed");
// The check has teeth: a builder that copies the whole source record is caught.
const copyAll = { ...ROW, ...base, payload: "whole record" };
ok(hasCanary(JSON.stringify(copyAll)).length > 0, "§9 (check) a payload that copies the record holds canaries, so the check above would catch it");

// ------------------------------------------------------------------ §10
section("§10 server.js and lib parity");
const SRC = require("./lib/server-source").serverSource();
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));
eq(brokerInvoice.BROKER_DOMAIN_NAMES[E.CHR_DOMAIN], "C.H. Robinson", "§10 CHR_DOMAIN is BROKER_DOMAIN_NAMES' C.H. Robinson domain");
const autoRules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
ok(E.domainOf === autoRules.emailDomain, "§10 domainOf is lib/auto-invoice-rules.js emailDomain() (one strict rule)");
ok(E.loadKey === require(path.join(ROOT, "lib", "ratecon-load.js")).normalizeLoadId, "§10 loadKey is lib/ratecon-load.js normalizeLoadId()");
ok(/\nconst normLoadKey = \(id\) => String\(id \|\| ""\)\.trim\(\)\.toLowerCase\(\)\.replace\(\/\^#\/, ""\);/.test(SRC), "§10 ...and normLoadKey() is still trim, lower case, one '#'");
ok(/\tconst lid = String\(loadId \|\| ""\)\.trim\(\)\.toLowerCase\(\)\.replace\(\/\^#\/, ""\);\n/.test(SRC), "§10 ...the rule recordStatusChange() keys history by");
const ctxText = (/\nfunction buildRateConLoadCtx\(row, headers, loadId\) \{\n[\s\S]{1,2000}?\n\}\n/.exec(SRC) || [""])[0];
ok(ctxText.length > 0, "§10 buildRateConLoadCtx() is found");
for (const [name, line] of [
	["loadId", "loadId: String(loadId == null ? cell(/load.?id|job.?id/i) : loadId).replace(/^#/, \"\").trim(),"],
	["email", "brokerEmail: cell(/^email$/i),"],
	["trailer", "trailerNumber: cell(/trailer/i),"],
	["pickupAddress", "pickupAddress: cell(/pickup.*address/i),"],
	["dropoffAddress", "dropoffAddress: cell(/drop.?off.*address|deliv.*address/i),"],
]) {
	ok(ctxText.includes(line), `§10 buildRateConLoadCtx() still reads ${name} as ${line.slice(0, 50)}`);
	ok(line.includes(String(E.COLUMN_RULES[name])), `§10 COLUMN_RULES.${name} is that pattern`);
}
ok(/\nfunction buildHeldTruckIndex\(\)|findCol\(headers, \/\^driver\$\/i\)/.test(SRC) && String(E.COLUMN_RULES.driver) === "/^driver$/i", "§10 the Driver column is /^driver$/i, as server.js reads it");
const statusList = /\nconst STATUS_OVERRIDE_ALLOWED = (\[[^\]\n]{1,300}\]);/.exec(SRC);
eq(statusList ? JSON.parse(statusList[1]) : null, [...E.STATUS_LIST], "§10 STATUS_LIST is STATUS_OVERRIDE_ALLOWED (what manual and override rows hold)");
const cancelRe = /\nconst CANCELED_STATUS_RE = (\/[^\n]{1,80}\/[a-z]*);/.exec(SRC);
eq(cancelRe ? cancelRe[1] : null, String(E.CANCELLED_RE), "§10 CANCELLED_RE is CANCELED_STATUS_RE");
for (const [source, status] of [["dispatch", "'Dispatched'"], ["cancel", "'Cancelled'"], ["accept", "'Assigned'"], ["decline", "'Unassigned'"]]) {
	ok(new RegExp(`newStatus: ${status}, source: '${source}'`).test(SRC), `§10 recordStatusChange() still writes ${status} as ${source}`);
}
ok(/source: 'manual', actor: driverName/.test(SRC) && /source: 'override', actor: overrideUser/.test(SRC) && /source: 'geofence',/.test(SRC), "§10 ...and manual, override and geofence rows");
ok(/strftime\('%Y-%m-%dT%H:%M:%SZ', changed_at\) AS at/.test(SRC), "§10 changed_at is UTC with no zone mark, read as Z (computeStatusPhases)");
const di = require(path.join(ROOT, "lib", "driver-instructions.js"));
eq(E.createRedactor({ denyList: "12-345, 99887766; 4321" }).count, di.parseDenyList("12-345, 99887766; 4321").values.length, "§10 the deny list is parsed by lib/driver-instructions.js parseDenyList()");
eq(E.HISTORY_SQL.above.replace(/\s+/g, " "), "SELECT id, load_id, old_status, new_status, source, changed_at FROM load_status_history WHERE id > ? ORDER BY id ASC LIMIT ?", "§10 the sweep's history read names its columns");
for (const [k, sql] of Object.entries(E.HISTORY_SQL)) {
	ok(!/\bactor\b|\breason\b|SELECT \*/i.test(sql), `§10 HISTORY_SQL.${k} names neither actor nor reason, and no SELECT *`);
}

// ------------------------------------------------------------------ §11
section("§11 the module stays pure");
const MOD = fs.readFileSync(path.join(ROOT, "lib", "chr-events.js"), "utf8");
const requires = [...MOD.matchAll(/require\(\s*["']([^"']{1,80})["']\s*\)/g)].map((m) => m[1]).sort();
eq(requires, ["./auto-invoice-rules", "./broker-contact", "./driver-instructions", "./ratecon-load", "./stop-zone"], "§11 it requires only the five lib modules it reuses");
ok(!/\bfs\.|\bprocess\b|\bfetch\(|Date\.now\(\)|new Date\(\)|\.prepare\(/.test(MOD), "§11 no files, environment, network, clock or database");
ok(Object.isFrozen(E.PAYLOAD_KEYS) && Object.isFrozen(E.PROJECTION_KEYS) && Object.isFrozen(E.MILESTONE_EVENTS), "§11 the lists are frozen");

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
