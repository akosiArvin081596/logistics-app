#!/usr/bin/env node
/**
 * Tests for the Job Tracking damage audit — specifically for the two ways it
 * can fail OPEN, which are the only failures that matter. Everything here runs
 * offline: no sheet, no network, no database.
 *
 * 1. THE STALE LOCK TABLE. A period_locks snapshot that is missing the most
 *    recently closed month reads as "that month is not locked", i.e. as
 *    permission to write into a settled period. This is not hypothetical: the
 *    repo-local app.db carried 14 locks ending 2026-06 while production carried
 *    15 ending 2026-07, and auditing against the local copy offered five extra
 *    rows in the settled 2026-07 period ($6,050 of loads) as repairable.
 *
 * 2. THE ROW SHAPE. loadRowPeriods() indexes rows by HEADER NAME. Handing it a
 *    positional array makes every lookup `undefined`, which does NOT throw — it
 *    answers resolved:false for every row. That reads as "locked", so the audit
 *    looks conservative while being blind, and reports zero open rows in every
 *    class. Section 2 asserts the trap is real, which is what justifies the
 *    audit reusing server.js's own parseSheet() rather than zipping rows itself.
 *
 * Run: node scripts/test-job-tracking-audit.js
 */
"use strict";

const audit = require("./audit-job-tracking-damage.js");
const { assertLockTableFresh, previousMonthKeyCT, columnLetter, S } = audit;

let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++; failures.push(`  ${label}\n      expected ${e}\n      actual   ${a}`);
}
function section(t) { console.log(`\n${t}`); }

// ── 1. lock-table freshness ─────────────────────────────────────────────────
section("1. lock-table freshness (the fail-open this audit exists to prevent)");

const lock = (p) => ({ period: p, status: "locked" });
const MONTHS_2025_2026 = [
	"2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11",
	"2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07",
];
const PRODUCTION_LOCKS = MONTHS_2025_2026.map(lock);              // 15, newest 2026-07
const STALE_LOCAL_LOCKS = MONTHS_2025_2026.slice(0, 14).map(lock); // 14, newest 2026-06

// A fixed clock inside August 2026, the month the repair actually ran in.
const AUG_2026 = new Date("2026-08-11T12:00:00Z");

eq(previousMonthKeyCT(AUG_2026), "2026-07", "previous month in CT from mid-August 2026");
eq(assertLockTableFresh(PRODUCTION_LOCKS, AUG_2026).fresh, true, "production's 15 locks are FRESH");
eq(assertLockTableFresh(PRODUCTION_LOCKS, AUG_2026).newest, "2026-07", "production's newest lock");
eq(assertLockTableFresh(STALE_LOCAL_LOCKS, AUG_2026).fresh, false, "the repo-local 14-lock snapshot is STALE");
eq(assertLockTableFresh(STALE_LOCAL_LOCKS, AUG_2026).newest, "2026-06", "stale snapshot's newest lock");
eq(assertLockTableFresh([], AUG_2026).fresh, false, "an EMPTY lock table is stale, never 'nothing is locked'");
eq(assertLockTableFresh([], AUG_2026).newest, "(none)", "empty lock table reports no newest period");

// A 'reopened' row is deliberately not a lock — the sweep keeps the row so it
// cannot re-lock what an admin just reopened. It must not count as freshness.
eq(assertLockTableFresh(
	STALE_LOCAL_LOCKS.concat([{ period: "2026-07", status: "reopened" }]), AUG_2026).fresh,
	false, "a REOPENED 2026-07 row does not make the table fresh");
eq(assertLockTableFresh(
	STALE_LOCAL_LOCKS.concat([{ period: "2026-07", status: "reopened" }]), AUG_2026).locked.includes("2026-07"),
	false, "a REOPENED period is not reported as locked");

// On the 1st of a month the CT/UTC answers differ; the CT one is the business
// month-end basis, and using UTC here would be the permissive direction.
eq(previousMonthKeyCT(new Date("2026-09-01T02:00:00Z")), "2026-07",
	"01 Sep 02:00Z is still 31 Aug in CT, so the previous CT month is July");
eq(previousMonthKeyCT(new Date("2026-01-05T12:00:00Z")), "2025-12", "January rolls back across the year boundary");

// ── 2. the row-shape trap ───────────────────────────────────────────────────
section("2. header-keyed rows vs positional arrays");

const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info",
	"Pickup Appointment", "Pickup Address", "Drop-off Info", "Drop-off Appointment",
	"Drop-off Address", "Job Status", "Phase of Progress", "Carrier Stage", "  Payment  ",
	"Broker Contact Name", "Phone Number", "Email", "Location Link", "Documents",
	"Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output",
];
const cols = S.jobTrackingMonthCols(HEADERS);
eq(cols.dateCol, "Assigned Date", "the assigned-date column resolves ahead of the bare /date/ fallback");

const arrayRow = new Array(26).fill("");
arrayRow[1] = "7083240";
arrayRow[20] = "8/3/2026, 2:15:49 PM";
const objectRow = Object.fromEntries(HEADERS.map((h, i) => [h, arrayRow[i]]));

eq(S.loadRowPeriods(objectRow, cols), { periods: ["2026-08"], resolved: true },
	"a header-keyed row resolves to its assigned month");
// The trap, asserted rather than described: an array yields no month AND no
// throw, so a caller treating `resolved:false` as "locked" sees every row as
// locked and reports zero open rows.
eq(S.loadRowPeriods(arrayRow, cols), { periods: [], resolved: false },
	"a POSITIONAL ARRAY silently resolves nothing — the audit would go blind, not crash");

// parseSheet is the converter that makes the object shape, and stamps the
// 1-based sheet row the repair anchors its A1 ranges on.
const parsed = S.parseSheet({ values: [HEADERS, arrayRow] });
eq(parsed.data.length, 1, "parseSheet returns one data row");
eq(parsed.data[0]._rowIndex, 2, "the first data row is sheet row 2 (row 1 is headers)");
eq(S.loadRowPeriods(parsed.data[0], cols).resolved, true, "parseSheet output resolves");

// ── 3. fail-closed on unreadable dates ──────────────────────────────────────
section("3. fail-closed");

const noDate = Object.fromEntries(HEADERS.map((h) => [h, ""]));
noDate["Load ID"] = "999";
eq(S.loadRowPeriods(noDate, cols), { periods: [], resolved: false },
	"a row with no readable date resolves nothing, so the audit must treat it as locked");

// RFC-2822 is the production shape of Assigned Date and MUST resolve, or 205
// rows would be mis-declared unreadable.
const rfcRow = Object.fromEntries(HEADERS.map((h) => [h, ""]));
rfcRow["Assigned Date"] = "Date: Tue, 13 May 2025 11:56:47 -0500";
eq(S.loadRowPeriods(rfcRow, cols), { periods: ["2025-05"], resolved: true },
	"an RFC-2822 assigned date resolves through the money resolver");
// ...and the strict parser does NOT read it. That asymmetry is exactly why the
// 205 rows look broken and are not.
eq(S.jtParseSheetDate("Date: Tue, 13 May 2025 11:56:47 -0500"), null,
	"the strict parser rejects RFC-2822 — which is why those cells LOOK unreadable");

// A month key that is not a lockable month must become NO key (fail closed),
// never a key the lock table can't match.
const badYear = Object.fromEntries(HEADERS.map((h) => [h, ""]));
badYear["Assigned Date"] = "1 Jan 0999";
eq(S.loadRowPeriods(badYear, cols).resolved, false,
	"a year outside the lockable shape yields no period, i.e. a refusal");

// ── 4. A1 column letters (the repair anchors on these) ──────────────────────
section("4. columnLetter");

eq(columnLetter(0), "A", "index 0 -> A");
eq(columnLetter(7), "H", "Pickup Address at index 7 -> H");
eq(columnLetter(10), "K", "Drop-off Address at index 10 -> K");
eq(columnLetter(25), "Z", "index 25 -> Z");
eq(columnLetter(26), "AA", "index 26 -> AA");
eq(columnLetter(51), "AZ", "index 51 -> AZ");
eq(columnLetter(52), "BA", "index 52 -> BA");
eq(HEADERS.indexOf("Pickup Address"), 7, "the real header layout puts Pickup Address at H");
eq(HEADERS.indexOf("Drop-off Address"), 10, "the real header layout puts Drop-off Address at K");

// ── 5. address usability, the repair's accept/refuse gate ───────────────────
section("5. addressLooksUsable gate");

const { addressLooksUsable } = require("../lib/ratecon-normalize.js");
eq(addressLooksUsable("3311 EAST LINCOLN WAY, AMES, IA 50010"), true, "a repaired pickup is placeable");
eq(addressLooksUsable("Suite 200 2930 114th Street, GRAND PRAIRIE, TX 75050"), true, "a repaired drop-off is placeable");
eq(addressLooksUsable(""), false, "empty is not placeable");
eq(addressLooksUsable("Awaiting Rate Con"), false, "the sentinel is not placeable");
// Production row 69 (load 520577076) holds exactly this. It is refused despite
// carrying both a state token and a ZIP, because the JSON quoting defeats the
// word boundaries both patterns require — which is the documented calibration
// result (5 flags on 413 rows, all true positives, 0 false positives).
eq(addressLooksUsable('{"Street":"2822 Glenfield Ave.","City":"DALLAS","State":"TX","Zip":"752331402"}'), false,
	"the raw-JSON address blob is refused — no geocoder resolves it");
// The same address written plainly IS placeable, so the refusal is about the
// blob's shape and not about the address being unknown.
eq(addressLooksUsable("2822 Glenfield Ave., DALLAS, TX 75233"), true,
	"the same address in plain form is placeable");

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nfailures:\n" + failures.join("\n")); process.exit(1); }
