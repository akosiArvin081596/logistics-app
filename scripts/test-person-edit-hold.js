#!/usr/bin/env node
/**
 * PERSON EDIT HOLD (2026-10-22): the pure rule, lib/person-edit-hold.js. A Pickup or Drop-off
 * Appointment a person corrected on an open load is never overwritten by a later rate-con email.
 * Every value here is made up (load numbers, dates, ids); none is copied from production.
 *
 *   §1 personSet(): no rows -> false; stored = the last rate-con row -> false; stored = an older
 *      rate-con row (a failed write, an overlapping run) -> false; stored matching no row -> true
 *      ("sheet"); the newest person row = stored with no newer rate-con row -> true ("person"); a
 *      newer rate-con row after it -> false; a manual row later edited in the sheet -> true (R2 L1);
 *      blank stored -> false; the shadow sources (would_hold, held, format) prove nothing.
 *   §2 sameCell(): Sheets' reformatting of the app's own value reads as the same moment (every
 *      written/sheet shape pair seen, R2 M2); the unreadable forms ("10/06 14:00", "10/06",
 *      "10/6/26 14:00") against a readable cell are unknown; a time window compares as text;
 *      a 200,000-character cell is answered within 50 ms.
 *   §3 decideColumn(): open load + a person's value + a different email -> hold; the same moment
 *      sent -> none; a blank sent or a blank stored -> none; an unknown comparison -> format.
 *   §4 lostEdit() (R2 L7), the reason text, the fold reason, the looser reading of the shadow report.
 *   §5 the v1 columns: Pickup and Drop-off, the same patterns as server.js's REISSUE_HELD_COLUMN_RES;
 *      Payment and Assigned Date never.
 *
 * Pure: no server, no network. Run: node scripts/test-person-edit-hold.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
function eq(name, actual, expected) {
	check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

let peh;
try {
	peh = require(path.join(__dirname, "..", "lib", "person-edit-hold"));
} catch (e) {
	check("lib/person-edit-hold.js loads", false, e.message);
	console.error(`\n${passes} passed, ${failures} failed`);
	process.exit(1);
}
const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const row = (id, source, value, extra = {}) => ({ id, source, value, actor: "", at: `2026-10-0${Math.min(id, 9)}T14:00:00.000Z`, ...extra });

// --- §1 personSet() ---------------------------------------------------------------
eq("§1 no rows: not a person's value", peh.personSet("10/12/2026 8:00:00", []).set, false);
eq("§1 rows missing altogether: not a person's value", peh.personSet("10/12/2026 8:00:00", undefined).set, false);
eq("§1 stored = the last rate-con row: the machine's value", peh.personSet("10/6/2026 8:00:00", [row(1, "ratecon", "10/6/2026 08:00")]).set, false);
eq("§1 stored = an older rate-con row (failed write or overlapping run): the machine's value",
	peh.personSet("10/6/2026 8:00:00", [row(1, "ratecon", "10/6/2026 08:00"), row(2, "ratecon", "10/9/2026 08:00")]).set, false);
{
	const p = peh.personSet("10/12/2026 8:00:00", [row(1, "ratecon", "10/6/2026 08:00"), row(2, "ratecon", "10/9/2026 08:00")]);
	eq("§1 stored matches no recorded value: a person's value, set in the sheet after the newest row", [p.set, p.via, p.row && p.row.id], [true, "sheet", 2]);
}
{
	const p = peh.personSet("10/12/2026 8:00:00", [row(1, "ratecon", "10/6/2026 08:00"), row(2, "person", "10/12/2026 08:00", { actor: "Dispatcher#7" })]);
	eq("§1 the newest person row = stored, no newer rate-con row: a person's value, set in LogisX", [p.set, p.via, p.row && p.row.id], [true, "person", 2]);
}
{
	// A person's date that an email later wrote over with the same text is the machine's again only
	// when the stored value matches a recorded value: here it equals the newer rate-con row.
	const p = peh.personSet("10/12/2026 8:00:00", [row(1, "person", "10/12/2026 08:00", { actor: "Dispatcher#7" }), row(2, "ratecon", "10/12/2026 08:00")]);
	eq("§1 a newer rate-con row after the person row, same value: not a person's value (rule 2 matches it)", p.set, false);
}
{
	const p = peh.personSet("10/14/2026 8:00:00", [row(1, "person", "10/12/2026 08:00", { actor: "Super Admin#1" })]);
	eq("§1 (R2 L1) a manual row later edited in the sheet: a person's value (rule 2 counts person rows)", [p.set, p.via], [true, "sheet"]);
}
eq("§1 (review M1) stored = the baseline (the sheet's date when the record began): the machine's value",
	peh.personSet("10/12/2026 8:00:00", [row(1, "baseline", "10/12/2026 8:00:00"), row(2, "ratecon", "10/6/2026 08:00")]).set, false);
eq("§1 (review M1) a baseline is a machine row: a person row after it still decides",
	peh.personSet("10/14/2026 8:00:00", [row(1, "baseline", "10/12/2026 8:00:00"), row(2, "person", "10/14/2026 08:00", { actor: "Dispatcher#7" })]).via, "person");
eq("§1 a blank stored cell is never a person's value",peh.personSet("  ", [row(1, "ratecon", "10/6/2026 08:00")]).set, false);
eq("§1 the shadow sources prove nothing: only would_hold/held/format rows -> no rows",
	peh.personSet("10/12/2026 8:00:00", [row(1, "would_hold", "10/6/2026 08:00"), row(2, "held", "10/6/2026"), row(3, "format", "10/06")]).set, false);
eq("§1 ids decide the order, not the array's order",
	peh.personSet("10/12/2026 8:00:00", [row(3, "person", "10/12/2026 08:00", { actor: "Dispatcher#7" }), row(1, "ratecon", "10/6/2026 08:00")]).via, "person");

// --- §2 sameCell() (R2 M2: every written/sheet shape pair seen) -------------------
for (const [written, sheet] of [
	["10/06/2026 14:00", "10/6/2026 14:00:00"],
	["10/06/2026 14:00", "10/6/2026 14:00"],
	["09/05/2026 07:30", "9/5/2026 7:30:00"],
	["09/05/2026 07:30", "9/5/2026 7:30"],
	["10/16/2026", "10/16/2026 0:00:00"],
	["10/16/2026", "10/16/2026 0:00"],
	["10/6/2026 08:00", "10/6/2026 8:00:00"],
	["10/6/2026 08:00", "10/6/2026 8:00"],
	["2026-10-06 08:00", "10/6/2026 8:00:00"],
	["10/7/2026 14:00", "10/07/2026 14:00:00"],
	["10/9/2026, 2:00:00 PM", "10/9/2026 14:00:00"],
]) eq(`§2 the app's own value reformatted by Sheets: "${written}" vs "${sheet}" -> same`, peh.sameCell(written, sheet), true);
for (const unreadable of ["10/06 14:00", "10/06", "10/6/26 14:00"]) {
	eq(`§2 unreadable "${unreadable}" vs a readable cell -> unknown`, peh.sameCell(unreadable, "10/6/2026 14:00:00"), null);
	eq(`§2 a readable cell vs unreadable "${unreadable}" -> unknown`, peh.sameCell("10/7/2026 9:00:00", unreadable), null);
	eq(`§2 "${unreadable}" is an unreadable date`, peh.unreadableDate(unreadable), true);
}
eq("§2 two different readable moments -> different", peh.sameCell("10/6/2026 8:00", "10/12/2026 8:00"), false);
eq("§2 a time window kept as text, the same -> same", peh.sameCell("10/7/2026 08:00-14:00 (FCFS)", " 10/7/2026  08:00-14:00 (FCFS) "), true);
eq("§2 a time window kept as text, changed -> different (compared as text)", peh.sameCell("10/7/2026 08:00-14:00 (FCFS)", "10/8/2026 08:00-14:00 (FCFS)"), false);
eq("§2 a time window is not an unreadable date", peh.unreadableDate("10/7/2026 08:00-14:00 (FCFS)"), false);
eq("§2 a time window vs a date -> different", peh.sameCell("10/7/2026 08:00-14:00 (FCFS)", "10/7/2026 8:00"), false);
{
	const big = `10/6/2026 ${" ".repeat(100000)}x${"9".repeat(100000)}`;
	const t0 = process.hrtime.bigint();
	const r = [peh.sameCell(big, "10/6/2026 8:00"), peh.sameCell(big, big + "y"), peh.personSet(big, [row(1, "ratecon", big)]).set, peh.unreadableDate(big), peh.personHoldColumn("Pickup Appointment".repeat(12000))];
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	check("§2 a 200,000-character cell: answered within 50 ms", ms < 50, `${ms.toFixed(1)} ms`);
	eq("§2 a 200,000-character cell: answers", r.slice(0, 4), [false, false, false, false]);
}

// --- §3 decideColumn() --------------------------------------------------------------
const PERSON_ROWS = [row(1, "ratecon", "10/6/2026 08:00")];
{
	const d = peh.decideColumn({ stored: "10/12/2026 8:00:00", sent: "10/6/2026 08:00", rows: PERSON_ROWS });
	eq("§3 open load, a person's value, a different email: hold (set in the sheet)", [d.action, d.via], ["hold", "sheet"]);
}
eq("§3 the same moment sent: nothing", peh.decideColumn({ stored: "10/12/2026 8:00:00", sent: "10/12/2026 08:00", rows: PERSON_ROWS }).action, "none");
eq("§3 a blank sent value: nothing (today's keep rule)", peh.decideColumn({ stored: "10/12/2026 8:00:00", sent: " ", rows: PERSON_ROWS }).action, "none");
eq("§3 a blank stored cell: nothing (the email fills it)", peh.decideColumn({ stored: "", sent: "10/6/2026 08:00", rows: PERSON_ROWS }).action, "none");
eq("§3 no rows (a load last emailed before the deploy): nothing", peh.decideColumn({ stored: "10/12/2026 8:00:00", sent: "10/6/2026 08:00", rows: [] }).action, "none");
eq("§3 the machine's own value, a new email date: nothing (a real reschedule is written)",
	peh.decideColumn({ stored: "10/6/2026 8:00:00", sent: "10/9/2026 08:00", rows: PERSON_ROWS }).action, "none");
eq("§3 the app wrote an unreadable form, Sheets stored it readable: format (never a hold)",
	peh.decideColumn({ stored: "10/6/2026 14:00:00", sent: "10/9/2026 08:00", rows: [row(1, "ratecon", "10/06 14:00")] }).action, "format");
eq("§3 a person's value and an unreadable email date: format (never a hold)",
	peh.decideColumn({ stored: "10/12/2026 8:00:00", sent: "10/06", rows: PERSON_ROWS }).action, "format");
eq("§3 a time window a person changed in the sheet: hold (compared as text)",
	peh.decideColumn({ stored: "10/8/2026 08:00-14:00", sent: "10/7/2026 08:00-14:00 (FCFS)", rows: [row(1, "ratecon", "10/7/2026 08:00-14:00 (FCFS)")] }).action, "hold");

// Review L1 (Arvin's yes, 2026-10-22): in the hold's rule 2 only the app's own writes clear a
// value. A person's earlier date restored in the sheet after an email replaced it is still a
// person's date; one an email wrote is still the machine's.
{
	const restored = [row(1, "person", "10/12/2026 08:00", { actor: "Dispatcher#7" }), row(2, "ratecon", "10/6/2026 08:00")];
	const d = peh.decideColumn({ stored: "10/12/2026 8:00:00", sent: "10/6/2026 08:00", rows: restored });
	eq("§3 (L1) a person's date restored in the sheet after an email replaced it: hold, set in the sheet after the rate con", [d.action, d.via, d.row && d.row.id], ["hold", "sheet", 2]);
	const older = [row(1, "baseline", "10/1/2026 8:00:00"), row(2, "person", "10/12/2026 08:00", { actor: "Dispatcher#7" }), row(3, "person", "10/14/2026 08:00", { actor: "Dispatcher#7" })];
	eq("§3 (L1) an older person date restored in the sheet (no rate-con write since): hold",
		peh.decideColumn({ stored: "10/12/2026 8:00:00", sent: "10/6/2026 08:00", rows: older }).action, "hold");
	eq("§3 (L1) the stored date is one the app wrote: nothing (the machine's value, as before)",
		peh.decideColumn({ stored: "10/6/2026 8:00:00", sent: "10/9/2026 08:00", rows: restored }).action, "none");
	eq("§3 (L1) a baseline the stored date matches still clears it: nothing",
		peh.decideColumn({ stored: "10/1/2026 8:00:00", sent: "10/9/2026 08:00", rows: older }).action, "none");
	eq("§3 (L1) an unknown comparison with an app write: format, never a hold",
		peh.decideColumn({ stored: "10/12/2026 8:00:00", sent: "10/9/2026 08:00", rows: [row(1, "person", "10/12/2026 08:00"), row(2, "ratecon", "10/06 14:00")] }).action, "format");
	// A person typed a short date in LogisX ("10/12 14:00") that Sheets stored readable. Before L1
	// the unreadable person row made rule 2 "unknown" (format); now only app writes are compared,
	// and none matches: hold.
	eq("§3 (L1) a person row in a form the reader can't parse no longer makes rule 2 unknown: hold",
		peh.decideColumn({ stored: "10/12/2026 14:00:00", sent: "10/9/2026 08:00", rows: [row(1, "ratecon", "10/6/2026 08:00"), row(2, "person", "10/12 14:00", { actor: "Dispatcher#7" })] }).action, "hold");
	eq("§3 (L1) personSet() called without the option takes the app-only rule by default: a person's date",
		peh.personSet("10/12/2026 8:00:00", restored).set, true);
	eq("§3 (L1) personSet() with onlyAppClears: false: a person row clears", peh.personSet("10/12/2026 8:00:00", restored, { onlyAppClears: false }).set, false);
}

// --- §4 lostEdit(), reasons, the looser reading ---------------------------------------
{
	const rows = [row(1, "ratecon", "10/6/2026 08:00"), row(2, "person", "10/12/2026 08:00", { actor: "Dispatcher#7" })];
	const lost = peh.lostEdit("10/6/2026 8:00:00", rows);
	eq("§4 (R2 L7) the newest person row is newer than the newest rate-con row, the sheet holds the older rate-con value: the lost edit", lost && lost.id, 2);
	eq("§4 (R2 L7) the sheet holds the person's value: no lost edit", peh.lostEdit("10/12/2026 8:00:00", rows), null);
	eq("§4 (R2 L7) a newer rate-con row: no lost edit", peh.lostEdit("10/6/2026 8:00:00", [...rows, row(3, "ratecon", "10/6/2026 08:00")]), null);
	eq("§4 (R2 L7) the sheet holds a value no row has (a sheet edit): no lost edit", peh.lostEdit("10/14/2026 8:00:00", rows), null);
}
eq("§4 reason: in LogisX by a Dispatcher on the day (APP_TIMEZONE)",
	peh.reasonPart({ via: "person", row: { source: "person", actor: "Dispatcher#7", at: "2026-10-08T15:00:00.000Z" } }, "America/New_York"), "in LogisX by a Dispatcher on Oct 8");
eq("§4 reason: an evening edit is that Eastern day, not the UTC day",
	peh.reasonPart({ via: "person", row: { source: "person", actor: "Super Admin#1", at: "2026-10-09T02:30:00.000Z" } }, "America/New_York"), "in LogisX by a Super Admin on Oct 8");
eq("§4 reason: in the sheet after the rate con",
	peh.reasonPart({ via: "sheet", row: { source: "ratecon", at: "2026-10-07T15:00:00.000Z" } }, "America/New_York"), "in the sheet after the rate con of Oct 7");
eq("§4 reason: in the sheet after a LogisX edit",
	peh.reasonPart({ via: "sheet", row: { source: "person", actor: "Super Admin#1", at: "2026-10-07T15:00:00.000Z" } }, "America/New_York"), "in the sheet after a LogisX edit of Oct 7");
eq("§4 the hold reason, one column", peh.holdReason([{ column: "Pickup Appointment", part: "in the sheet after the rate con of Oct 7" }]),
	"a person corrected this date (in the sheet after the rate con of Oct 7)");
eq("§4 the hold reason, two columns", peh.holdReason([{ column: "Pickup Appointment", part: "in the sheet after the rate con of Oct 7" }, { column: "Drop-off Appointment", part: "in LogisX by a Dispatcher on Oct 8" }]),
	"a person corrected these dates (Pickup Appointment: in the sheet after the rate con of Oct 7; Drop-off Appointment: in LogisX by a Dispatcher on Oct 8)");
eq("§4 the fold reason names the columns", peh.foldReason(["Pickup Appointment", " Pickup Appointment "]), "a person had corrected it (Pickup Appointment)");
eq("§4 looser reading: the same day with and without a year", peh.sameLooseDay("10/06 14:00", "10/6/2026 14:00:00"), true);
eq("§4 looser reading: a two-digit year", peh.sameLooseDay("10/6/26 14:00", "2026-10-06 08:00"), true);
eq("§4 looser reading: another day is not", peh.sameLooseDay("10/12/2026 8:00:00", "10/6/2026 08:00"), false);
eq("§4 looser reading: another year is not", peh.sameLooseDay("10/6/2020 8:00", "10/6/2026 08:00"), false);
eq("§4 looser reading: no date at all is not", peh.sameLooseDay("TBD", "10/6/2026"), false);
eq("§4 (review L2) review: two readable times on the same day are a real change, not marked", peh.reviewMark("10/6/2026 14:00", "10/6/2026 8:00:00"), null);
eq("§4 (review L2) review: two readable dates on different days, not marked", peh.reviewMark("10/12/2026 8:00:00", "10/6/2026 08:00"), null);
eq("§4 (review L2) review: an unreadable email date on the same day is marked, same day", peh.reviewMark("10/06 14:00", "10/6/2026 14:00:00"), { sameDay: true });
eq("§4 (review L2) review: an unreadable stored cell on another day is marked", peh.reviewMark("10/6/2026 08:00", "10/8/2026 08:00-14:00 (FCFS)"), { sameDay: false });
eq("§4 (review L2) review: text that names no date is marked", peh.reviewMark("TBD", "10/6/2026"), { sameDay: false });

// --- §5 the v1 columns -------------------------------------------------------------------
for (const c of ["Pickup Appointment", " Pickup Appointment Time ", "Pickup Date", "Drop-off Appointment", "Drop Off Appointment", "Delivery Date", "Delivery Appointment"]) {
	eq(`§5 "${c}" is held by this rule`, peh.personHoldColumn(c), true);
}
for (const c of ["  Payment  ", "Payment ($)", "Assigned Date", "Pickup Info", "Pickup Address", "Drop-off Address", "Completion Date", "Status Update Date", "Job Status", ""]) {
	eq(`§5 "${c}" is never held by this rule (Payment is not in v1)`, peh.personHoldColumn(c), false);
}
{
	const m = /\nconst REISSUE_HELD_COLUMN_RES = \[(\/.*?\/i), (\/.*?\/i), REISSUE_PAYMENT_RE\];/.exec(SRC);
	check("§5 server.js's REISSUE_HELD_COLUMN_RES has its two date patterns", !!m);
	if (m) eq("§5 the lib's patterns are server.js's date patterns, exactly", peh.PERSON_HOLD_COLUMN_RES.map(String), [m[1], m[2]]);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
