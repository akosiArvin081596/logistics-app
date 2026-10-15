#!/usr/bin/env node
// The live ETA's on-time verdict against the load's Drop-off Appointment:
// lib/eta-on-time.js, the customer tracker's On time / Delayed badge
// (GET /api/public/track/:loadId) and the Tracking tab's status
// (GET /api/locations/latest).
//
// WHY THIS EXISTS.
//   • The tracker read the appointment with new Date(cell). Production runs in
//     UTC, so "10/15/2026 14:00" became 10 AM Eastern and a truck due at 1:30 PM
//     was called Delayed. Rate cons state appointments in the facility's local
//     time (user, 2026-10-15): the cell is a wall clock at the receiver, its zone
//     the one the cell writes, else the receiver's longitude band, else Eastern.
//   • The Tracking tab looked for a /delivery.*time|drop.*time|delivery.*date|
//     drop.*date/ column, which no Job Tracking header matches, so its on-time /
//     delayed status never fired. The appointment column is "Drop-off
//     Appointment".
//
// The two server blocks are lifted verbatim from server.js and run with this
// process on UTC, like production. Receivers and appointments are made up; the
// longitudes are an Eastern, a Central and a Pacific city's.
//
// No network, no sheet, no database, no server.
//
//   node scripts/test-eta-on-time.js      # exits 1 on any failure

process.env.TZ = "UTC";
process.env.APP_TIMEZONE = "America/New_York";

const fs = require("fs");
const path = require("path");

const SHIPPED = fs.readFileSync(process.env.SERVER_JS || path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}
function lift(re, label) {
	const all = [...SHIPPED.matchAll(re)];
	if (all.length !== 1) throw new Error(`${label}: expected exactly one match, found ${all.length}`);
	return all[0][0];
}

let lib = null;
try { lib = require("../lib/eta-on-time"); } catch (err) { console.error(`lib/eta-on-time.js: ${err.message}`); }
const missing = () => { throw new Error("lib/eta-on-time.js missing"); };
const deps = {
	etaOnTime: lib ? lib.etaOnTime : missing,
	etaVerdict: lib && lib.etaVerdict ? lib.etaVerdict : missing,
	DROPOFF_APPOINTMENT_COL_RE: lib ? lib.DROPOFF_APPOINTMENT_COL_RE : /$^/,
	findCol: new Function(`return (${lift(/\nfunction findCol\([\s\S]*?\n}\n/g, "findCol").trim()});`)(),
};

const Z = (s) => Date.parse(s);
// Receivers' longitudes: Eastern, Central and Pacific.
const EAST = -77.04;
const CENTRAL = -96.8;
const PACIFIC = -118.24;

// Header names as the live Job Tracking tab has them, in its order.
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info", "Pickup Appointment",
	"Pickup Address", "Drop-off Info", "Drop-off Appointment", "Drop-off Address", "Job Status",
	"Phase of Progress", "Carrier Stage", "  Payment  ", "Assigned Date", "Status Update Date",
	"Completion Date", "Truck", "Owner ID",
];

// ---------------------------------------------------------------------------
// §1 lib/eta-on-time.js
// ---------------------------------------------------------------------------
if (lib && lib.etaVerdict) {
	const v = (ms, text, destLng) => lib.etaVerdict(ms, text, { destLng });
	const deadline = (text, destLng) => { const x = v(Z("2026-10-15T00:00:00Z"), text, destLng); return x ? x.deadlineMs : null; };
	check("§1.1 an Eastern receiver's 2 PM is 2 PM EDT", deadline("10/15/2026 14:00", EAST), Z("2026-10-15T18:00:00Z"));
	check("§1.2 a Central receiver's 2 PM is 2 PM CDT", deadline("10/15/2026 14:00", CENTRAL), Z("2026-10-15T19:00:00Z"));
	check("§1.3 a Pacific receiver's 2 PM is 2 PM PDT", deadline("10/15/2026 14:00", PACIFIC), Z("2026-10-15T21:00:00Z"));
	check("§1.4 standard time after the change (Central, CST)", deadline("12/15/2026 14:00", CENTRAL), Z("2026-12-15T20:00:00Z"));
	check("§1.5 a zone written in the cell is its own clock", deadline("10/15/2026 14:00 EST", PACIFIC), Z("2026-10-15T18:00:00Z"));
	check("§1.6 no zone written and no longitude: Eastern", deadline("10/15/2026 14:00", null), Z("2026-10-15T18:00:00Z"));
	check("§1.7 12-hour clock and the extractor's suffix", [deadline("10/15/2026 2:00 PM", CENTRAL), deadline("10/15/26 14:00 Appt.", CENTRAL)],
		[Z("2026-10-15T19:00:00Z"), Z("2026-10-15T19:00:00Z")]);
	check("§1.8 a window's deadline is its end", deadline("10/15/2026 08:00 - 14:00", CENTRAL), Z("2026-10-15T19:00:00Z"));
	check("§1.9 a date alone, or FCFS, runs to the end of the receiver's day",
		[deadline("10/15/2026", PACIFIC), deadline("10/15/2026 FCFS", PACIFIC)], [Z("2026-10-16T06:59:59.999Z"), Z("2026-10-16T06:59:59.999Z")]);
	check("§1.10 blank, free text and a date with no year give no verdict",
		[v(1, "", CENTRAL), v(1, null, CENTRAL), v(1, "Contact for scheduling information", CENTRAL), v(1, "10/15 14:00", CENTRAL)], [null, null, null, null]);

	const central = v(Z("2026-10-15T18:30:00Z"), "10/15/2026 14:00", CENTRAL);
	check("§1.11 due 1:30 PM CDT for a 2 PM CDT appointment is on time", central.onTime, true);
	check("§1.12 ...and the ETA reads on the receiver's clock, zone named", central.arrivalLocal, "Oct 15, 1:30 PM CDT");
	check("§1.13 the same instant is late for an Eastern receiver's 2 PM", v(Z("2026-10-15T18:30:00Z"), "10/15/2026 14:00", EAST).onTime, false);
	check("§1.14 ...and on time for a Pacific receiver's, read as PDT",
		[v(Z("2026-10-15T20:30:00Z"), "10/15/2026 14:00", PACIFIC).onTime, v(Z("2026-10-15T20:30:00Z"), "10/15/2026 14:00", PACIFIC).arrivalLocal],
		[true, "Oct 15, 1:30 PM PDT"]);
	check("§1.15 exactly on the appointment is on time", lib.etaOnTime(Z("2026-10-15T19:00:00Z"), "10/15/2026 14:00", { destLng: CENTRAL }), true);
	check("§1.16 no arrival, no verdict", [lib.etaOnTime(null, "10/15/2026 14:00", { destLng: CENTRAL }), lib.etaOnTime(NaN, "10/15/2026 14:00")], [null, null]);
	check("§1.17 the appointment column is the Drop-off Appointment",
		HEADERS.find((h) => lib.DROPOFF_APPOINTMENT_COL_RE.test(h)), "Drop-off Appointment");
	// The receiver's STATE before its longitude band (lib/stop-zone.js).
	const at = (text, place) => lib.etaVerdict(Z("2026-10-15T00:00:00Z"), text, place);
	check("§1.18 an Indianapolis receiver is Eastern, though its longitude is in the Central band",
		at("10/15/2026 14:00", { destAddress: "Indianapolis, IN 46204", destLat: 39.77, destLng: -86.16 }).deadlineMs, Z("2026-10-15T18:00:00Z"));
	check("§1.19 ...placed by its coordinates alone too",
		at("10/15/2026 14:00", { destLat: 39.77, destLng: -86.16 }).zone, "America/New_York");
	check("§1.20 a Phoenix receiver keeps MST (no daylight time): 2 PM is 21:00 UTC in October",
		at("10/15/2026 14:00", { destAddress: "Phoenix, AZ 85003", destLat: 33.45, destLng: -112.07 }).deadlineMs, Z("2026-10-15T21:00:00Z"));
	check("§1.21 ...and its ETA reads MST",
		lib.etaVerdict(Z("2026-10-15T20:30:00Z"), "10/15/2026 14:00", { destAddress: "Phoenix, AZ 85003", destLng: -112.07 }).arrivalLocal,
		"Oct 15, 1:30 PM MST");
} else {
	fail++;
	console.error("FAIL  §1 lib/eta-on-time.js has no etaVerdict()");
}

// ---------------------------------------------------------------------------
// §2 The customer tracker's badge, lifted from GET /api/public/track/:loadId.
// ---------------------------------------------------------------------------
const trackSrc = lift(/\n(\t+)let onTime = null;\n[\s\S]*?\n\1eta = \{ distanceMiles, minutesRemaining, expectedAt, onTime[^}\n]*\};\n/g, "tracker verdict");
// `deliveryDateCol` is what an older route read the appointment from;
// `appointmentCol`, `destAddr` and `destLat` are the route's own names now.
function trackerBadge(appointment, expectedAt, destLng, place = {}) {
	const names = ["deliveryDateCol", "appointmentCol", "load", "expectedAt", "distanceMiles", "minutesRemaining", "destAddr", "destLat", "destLng", ...Object.keys(deps)];
	const run = new Function(...names, `let eta = null;\n${trackSrc}\nreturn [eta.onTime, eta.arrivalLocal === undefined ? null : eta.arrivalLocal];`);
	return run("Drop-off Appointment", "Drop-off Appointment", { "Drop-off Appointment": appointment }, expectedAt, 120, 90,
		place.address || "", place.lat == null ? null : place.lat, destLng, ...Object.values(deps));
}
check("§2.1 Eastern receiver: due 1:30 PM EDT for 2 PM is On time, the ETA shown in EDT",
	trackerBadge("10/15/2026 14:00", "2026-10-15T17:30:00.000Z", EAST), [true, "Oct 15, 1:30 PM EDT"]);
check("§2.2 Central receiver: due 1:30 PM CDT for 2 PM is On time, the ETA shown in CDT",
	trackerBadge("10/15/2026 14:00", "2026-10-15T18:30:00.000Z", CENTRAL), [true, "Oct 15, 1:30 PM CDT"]);
check("§2.3 Pacific receiver: due 1:30 PM PDT for 2 PM is On time, the ETA shown in PDT",
	trackerBadge("10/15/2026 14:00", "2026-10-15T20:30:00.000Z", PACIFIC), [true, "Oct 15, 1:30 PM PDT"]);
check("§2.4 ...and due 2:30 PM PDT is Delayed", trackerBadge("10/15/2026 14:00", "2026-10-15T21:30:00.000Z", PACIFIC), [false, "Oct 15, 2:30 PM PDT"]);
check("§2.5 a window is judged by its end", trackerBadge("10/15/26 08:00-14:00", "2026-10-15T19:30:00.000Z", CENTRAL), [false, "Oct 15, 2:30 PM CDT"]);
check("§2.6 no appointment, no badge", trackerBadge("", "2026-10-15T17:30:00.000Z", CENTRAL), [null, null]);
check("§2.7 an Indianapolis receiver (its address): 2:30 PM EDT for 2 PM is Delayed, shown in EDT, not the Central band's CDT",
	trackerBadge("10/15/2026 14:00", "2026-10-15T18:30:00.000Z", -86.16, { address: "Indianapolis, IN 46204", lat: 39.77 }), [false, "Oct 15, 2:30 PM EDT"]);
check("§2.8 the route reads the Drop-off Appointment column, never a delivered or completion date",
	/const appointmentCol = findCol\(headers, DROPOFF_APPOINTMENT_COL_RE\);/.test(SHIPPED) && /load\[appointmentCol\]/.test(trackSrc), true);

// ---------------------------------------------------------------------------
// §3 The Tracking tab's status, lifted from GET /api/locations/latest.
// ---------------------------------------------------------------------------
const colSrc = lift(/\n\t+const deliveryTimeCol = [^\n]*\n/g, "Tracking tab appointment column");
// The receiver's address column (absent from a route that predates it).
const addrSrc = (SHIPPED.match(/\n\t+const dropoffAddressCol = [^\n]*\n/g) || [""])[0];
const statusSrc = lift(/\n(\t+)if \(deliveryTimeCol && load\[deliveryTimeCol\]\) \{\n[\s\S]*?\n\1\}\n/g, "Tracking tab verdict");
const pickAddressColumn = new Function("findCol", `return (${lift(/\nfunction pickAddressColumn\([\s\S]*?\n}\n/g, "pickAddressColumn").trim()});`)(deps.findCol);
function tabStatus(appointment, nowIso, etaMinutes, dLng, place = {}) {
	const names = ["headers", "load", "loc", "etaSeconds", "dLat", "dLng", "Date", "pickAddressColumn", ...Object.keys(deps)];
	const NOW = Date.parse(nowIso);
	const FixedDate = class extends Date { static now() { return NOW; } };
	const loc = { etaStatus: "unknown" };
	const load = { "Load ID": "L-1", "Drop-off Appointment": appointment, "Drop-off Address": place.address || "" };
	new Function(...names, `${colSrc}\n${addrSrc}\n${statusSrc}`)(HEADERS, load, loc, etaMinutes * 60, place.lat == null ? NaN : place.lat, dLng,
		FixedDate, pickAddressColumn, ...Object.values(deps));
	return loc.etaStatus;
}
check("§3.1 the Tracking tab reads the Drop-off Appointment: an Eastern receiver on time",
	tabStatus("10/15/2026 14:00", "2026-10-15T15:30:00Z", 120, EAST), "on-time");
check("§3.2 a Central receiver, due 1:30 PM CDT: on time", tabStatus("10/15/2026 14:00", "2026-10-15T17:30:00Z", 60, CENTRAL), "on-time");
check("§3.3 a Pacific receiver, due 2:30 PM PDT: delayed", tabStatus("10/15/2026 14:00", "2026-10-15T20:30:00Z", 60, PACIFIC), "delayed");
check("§3.4 an unreadable appointment stays unknown", tabStatus("Contact for scheduling information", "2026-10-15T15:30:00Z", 120, CENTRAL), "unknown");
check("§3.5 an Indianapolis receiver (its address): due 2:30 PM EDT for 2 PM is delayed, not on time by the Central band",
	tabStatus("10/15/2026 14:00", "2026-10-15T17:30:00Z", 60, -86.16, { address: "Indianapolis, IN 46204", lat: 39.77 }), "delayed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
