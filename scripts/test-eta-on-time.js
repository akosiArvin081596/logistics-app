#!/usr/bin/env node
// The live ETA's on-time verdict against the load's Drop-off Appointment:
// lib/eta-on-time.js, the customer tracker's On time / Delayed badge
// (GET /api/public/track/:loadId) and the Tracking tab's status
// (GET /api/locations/latest).
//
// WHY THIS EXISTS.
//   • The tracker read the appointment with new Date(cell). Production runs in
//     UTC, so "10/15/2026 14:00" became 10 AM Eastern and a truck due at 1:30 PM
//     was called Delayed. The appointment is a wall clock on the business clock
//     (APP_TIMEZONE, US Eastern).
//   • The Tracking tab looked for a /delivery.*time|drop.*time|delivery.*date|
//     drop.*date/ column, which no Job Tracking header matches, so its on-time /
//     delayed status never fired. The appointment column is "Drop-off
//     Appointment".
//
// The two server blocks are lifted verbatim from server.js and run with this
// process on UTC, like production. Appointments are made up.
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
const deps = {
	etaOnTime: lib ? lib.etaOnTime : () => { throw new Error("lib/eta-on-time.js missing"); },
	DROPOFF_APPOINTMENT_COL_RE: lib ? lib.DROPOFF_APPOINTMENT_COL_RE : /$^/,
	findCol: new Function(`return (${lift(/\nfunction findCol\([\s\S]*?\n}\n/g, "findCol").trim()});`)(),
};

const Z = (s) => Date.parse(s);

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
if (lib) {
	const d = lib.appointmentDeadlineMs;
	check("§1.1 a time is a wall clock in Eastern (EDT)", d("10/15/2026 14:00"), Z("2026-10-15T18:00:00Z"));
	check("§1.2 ...and in EST after the change", d("12/15/2026 14:00"), Z("2026-12-15T19:00:00Z"));
	check("§1.3 12-hour clock", d("10/15/2026 2:00 PM"), Z("2026-10-15T18:00:00Z"));
	check("§1.4 two-digit year with the extractor's suffix", d("10/15/26 14:00 Appt."), Z("2026-10-15T18:00:00Z"));
	check("§1.5 ISO date", d("2026-10-15 9:00"), Z("2026-10-15T13:00:00Z"));
	check("§1.6 a window's deadline is its end", d("10/15/2026 08:00 - 14:00"), Z("2026-10-15T18:00:00Z"));
	check("§1.7 a zone written in the cell is its own clock", d("10/15/2026 14:00 CST"), Z("2026-10-15T19:00:00Z"));
	check("§1.8 a date alone runs to the end of that Eastern day", d("10/15/2026"), Z("2026-10-16T03:59:59.999Z"));
	check("§1.9 FCFS too", d("10/15/2026 FCFS"), Z("2026-10-16T03:59:59.999Z"));
	check("§1.10 blank, free text and a date with no year give no deadline",
		[d(""), d(null), d("Contact for scheduling information"), d("10/15 14:00")], [null, null, null, null]);

	const t = lib.etaOnTime;
	check("§1.11 due 1:30 PM for a 2 PM appointment is on time", t(Z("2026-10-15T17:30:00Z"), "10/15/2026 14:00"), true);
	check("§1.12 due 2:30 PM is late", t(Z("2026-10-15T18:30:00Z"), "10/15/2026 14:00"), false);
	check("§1.13 exactly on the appointment is on time", t(Z("2026-10-15T18:00:00Z"), "10/15/2026 14:00"), true);
	check("§1.14 no readable appointment, no verdict", t(Z("2026-10-15T17:30:00Z"), "TBD"), null);
	check("§1.15 no arrival, no verdict", [t(null, "10/15/2026 14:00"), t(NaN, "10/15/2026 14:00")], [null, null]);
	check("§1.16 the appointment column is the Drop-off Appointment",
		HEADERS.find((h) => lib.DROPOFF_APPOINTMENT_COL_RE.test(h)), "Drop-off Appointment");
} else {
	fail++;
	console.error("FAIL  §1 lib/eta-on-time.js is missing");
}

// ---------------------------------------------------------------------------
// §2 The customer tracker's badge, lifted from GET /api/public/track/:loadId.
// ---------------------------------------------------------------------------
const trackSrc = lift(/\n(\t+)let onTime = null;\n[\s\S]*?\n\1eta = \{ distanceMiles, minutesRemaining, expectedAt, onTime \};\n/g, "tracker verdict");
function trackerBadge(appointment, expectedAt) {
	const names = ["deliveryDateCol", "load", "expectedAt", "distanceMiles", "minutesRemaining", ...Object.keys(deps)];
	const run = new Function(...names, `let eta = null;\n${trackSrc}\nreturn eta.onTime;`);
	return run("Drop-off Appointment", { "Drop-off Appointment": appointment }, expectedAt, 120, 90, ...Object.values(deps));
}
check("§2.1 a truck due 1:30 PM for a 2 PM appointment is On time",
	trackerBadge("10/15/2026 14:00", "2026-10-15T17:30:00.000Z"), true);
check("§2.2 ...and one due 2:30 PM is Delayed", trackerBadge("10/15/2026 14:00", "2026-10-15T18:30:00.000Z"), false);
check("§2.3 a window is judged by its end", [trackerBadge("10/15/26 08:00-14:00", "2026-10-15T17:30:00.000Z"),
	trackerBadge("10/15/26 08:00-14:00", "2026-10-15T18:30:00.000Z")], [true, false]);
check("§2.4 no appointment, no badge", trackerBadge("", "2026-10-15T17:30:00.000Z"), null);

// ---------------------------------------------------------------------------
// §3 The Tracking tab's status, lifted from GET /api/locations/latest.
// ---------------------------------------------------------------------------
const colSrc = lift(/\n\t+const deliveryTimeCol = [^\n]*\n/g, "Tracking tab appointment column");
const statusSrc = lift(/\n(\t+)if \(deliveryTimeCol && load\[deliveryTimeCol\]\) \{\n[\s\S]*?\n\1\}\n/g, "Tracking tab verdict");
function tabStatus(appointment, nowIso, etaMinutes) {
	const names = ["headers", "load", "loc", "etaSeconds", "Date", ...Object.keys(deps)];
	const NOW = Date.parse(nowIso);
	const FixedDate = class extends Date { static now() { return NOW; } };
	const loc = { etaStatus: "unknown" };
	const load = { "Load ID": "L-1", "Drop-off Appointment": appointment };
	new Function(...names, `${colSrc}\n${statusSrc}`)(HEADERS, load, loc, etaMinutes * 60, FixedDate, ...Object.values(deps));
	return loc.etaStatus;
}
check("§3.1 the Tracking tab reads the Drop-off Appointment: on time",
	tabStatus("10/15/2026 14:00", "2026-10-15T15:30:00Z", 120), "on-time");
check("§3.2 ...and delayed", tabStatus("10/15/2026 14:00", "2026-10-15T17:30:00Z", 60), "delayed");
check("§3.3 an unreadable appointment stays unknown", tabStatus("Contact for scheduling information", "2026-10-15T15:30:00Z", 120), "unknown");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
