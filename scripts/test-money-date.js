#!/usr/bin/env node
/**
 * Tests for moneySheetDate() — the single date resolver the revenue / driver-pay
 * math and the period-lock guards share.
 *
 * WHY IT LOADS THE FUNCTION OUT OF server.js SOURCE INSTEAD OF require()-ing IT.
 * server.js is a ~18.5k-line single file that opens SQLite, reads a service
 * account key and starts listening on import, so it cannot be required from a
 * test. Extracting the function text keeps this honest in the way that matters:
 * it exercises THE CODE THAT SHIPS, not a copy that can quietly drift from it.
 * The extraction asserts the function is found exactly once, so a rename or a
 * second definition fails the run loudly rather than silently testing nothing.
 *
 * THE PROPERTY UNDER TEST is not "this date parses". It is that the resolved
 * calendar day does NOT depend on the server's timezone. The old expression
 * `parseSheetDate(v) || new Date(v)` did: on the UTC VPS an offset-bearing cell
 * late in the month booked its revenue into the NEXT month, and on a Houston
 * laptop it did not. Section 3 runs the whole corpus in two child processes,
 * TZ=UTC and TZ=America/Chicago, and requires the outputs to be identical.
 *
 * Run: node scripts/test-money-date.js
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");

// ---------------------------------------------------------------- extraction
function extract(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) {
		throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	}
	const start = SRC.indexOf(needle) + 1;
	// Brace-match to the end of the declaration. Good enough here because these
	// helpers contain no braces inside string or regex literals — asserted by the
	// fact that the extracted text must itself parse (new Function below).
	let depth = 0, i = SRC.indexOf("{", start);
	for (let j = i; j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}

const RFC2822_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const sandbox = new Function(
	"RFC2822_MONTHS",
	`${extract("moneySheetDate")}\n${extract("sheetCellMonths")}\nreturn { moneySheetDate, sheetCellMonths };`
)(RFC2822_MONTHS);
const { moneySheetDate, sheetCellMonths } = sandbox;

// The formatter the money math reads the result back through (server.js fmtDate).
const fmtDate = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const day = (v) => { const d = moneySheetDate(v); return d && !isNaN(d) ? fmtDate(d) : null; };
const month = (v) => { const d = day(v); return d ? d.slice(0, 7) : null; };

// -------------------------------------------------------------------- runner
let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++; failures.push(`  ${label}\n      expected ${e}\n      actual   ${a}`);
}
function section(t) { console.log(`\n${t}`); }

// The corpus is shared by the assertions below and by the cross-timezone run.
const CORPUS = [
	// [cell, expected day]
	// -- shapes that were already zone-independent; these must not move --
	["2025-04-30", "2025-04-30"],
	["2026-07-31", "2026-07-31"],
	["2025-07-15T13:28:33.000Z", "2025-07-15"],   // ISO read literally, as before
	["4/30/2025", "2025-04-30"],
	["7/15/2026 14:31:58", "2026-07-15"],
	["8/3/2026, 2:15:49 PM", "2026-08-03"],
	["5/16/25", "2025-05-16"],                     // 2-digit year -> 2000s
	// -- RFC 2822: the shape n8n stamps from the rate-con email header --
	["Date: Tue, 13 May 2025 11:56:47 -0500", "2025-05-13"],
	["Tue, 13 May 2025 11:56:47 -0500", "2025-05-13"],  // with and without prefix
	// -- THE BUG: evening stamps on the last day of a month --
	["Date: Wed, 30 Apr 2025 19:35:06 -0500", "2025-04-30"],
	["Date: Wed, 30 Apr 2025 18:59:00 -0500", "2025-04-30"],
	["Date: Thu, 31 Jul 2025 23:59:00 -0500", "2025-07-31"],
	["Date: Wed, 31 Dec 2025 20:00:00 -0600", "2025-12-31"],  // year boundary
	["Date: Thu, 01 May 2025 00:30:00 -0500", "2025-05-01"],
	// -- offsets that are NOT Houston's; still read literally --
	["Date: Wed, 30 Apr 2025 22:00:00 -0700", "2025-04-30"],
	["Date: Thu, 1 May 2025 02:00:00 +0000", "2025-05-01"],
	// -- the two production rows this change actually moved --
	["Date: Mon, 14 Jul 2025 19:41:41 -0500", "2025-07-14"],
	["Date: Sun, 3 Aug 2025 20:20:36 -0500", "2025-08-03"],
	// -- nothing to read --
	["", null], [null, null], [undefined, null], ["   ", null],
	["not a date", null], ["Load #558865809", null],
];

if (process.env.MONEY_DATE_CORPUS_ONLY === "1") {
	// Child mode: emit the resolution of every corpus cell so the parent can
	// compare two timezones byte for byte.
	console.log(JSON.stringify(CORPUS.map(([cell]) => day(cell))));
	process.exit(0);
}

console.log("moneySheetDate() — revenue-month resolution");
console.log(`node ${process.version}, TZ=${process.env.TZ || "(unset)"} -> ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

// ------------------------------------------------- 1. values, shape by shape
section("1. resolves each cell shape to the right calendar day");
for (const [cell, expected] of CORPUS) eq(day(cell), expected, `day(${JSON.stringify(cell)})`);

section("2. the reported bug: an offset-bearing month-end cell books to its own month");
// Each of these booked to the NEXT month on the UTC VPS before this fix.
eq(month("Date: Wed, 30 Apr 2025 19:35:06 -0500"), "2025-04", "30 Apr 19:35 CDT -> April, not May");
eq(month("Date: Thu, 31 Jul 2025 23:59:00 -0500"), "2025-07", "31 Jul 23:59 CDT -> July, not August");
eq(month("Date: Wed, 31 Dec 2025 20:00:00 -0600"), "2025-12", "31 Dec 20:00 CST -> Dec 2025, not Jan 2026");
eq(month("Date: Sat, 31 May 2025 21:10:00 -0500"), "2025-05", "31 May 21:10 CDT -> May, not June");
// ...and the hours just below the old flip point must not have moved at all.
eq(month("Date: Wed, 30 Apr 2025 18:59:00 -0500"), "2025-04", "30 Apr 18:59 CDT still April");
eq(month("Date: Thu, 01 May 2025 00:30:00 -0500"), "2025-05", "1 May 00:30 CDT still May");

section("3. the actual property: identical under TZ=UTC and TZ=America/Chicago");
const runIn = (tz) => JSON.parse(execFileSync(process.execPath, [__filename], {
	env: { ...process.env, TZ: tz, MONEY_DATE_CORPUS_ONLY: "1" }, encoding: "utf8",
}));
const utc = runIn("UTC");
const houston = runIn("America/Chicago");
const kolkata = runIn("Asia/Kolkata"); // a half-hour offset, the nastiest case
eq(utc, houston, "UTC and America/Chicago resolve every corpus cell identically");
eq(utc, kolkata, "UTC and Asia/Kolkata resolve every corpus cell identically");
eq(utc, CORPUS.map(([, e]) => e), "the UTC child agrees with the expected table");

section("4. fail-open guard: sheetCellMonths() still covers the money month");
// loadRowPeriods/sheetCellMonths must never resolve a month the money math would
// call LOCKED into one it calls OPEN. sheetCellMonths returns a UNION, so the
// invariant is containment, not equality.
for (const [cell] of CORPUS) {
	const mk = month(cell);
	if (!mk) continue;
	const guard = sheetCellMonths(cell);
	eq(Array.isArray(guard) && guard.includes(mk), true,
		`sheetCellMonths(${JSON.stringify(cell)}) = ${JSON.stringify(guard)} must contain the money month ${mk}`);
}

section("5. degenerate and hostile input");
eq(day("Date: "), null, "prefix with no date");
eq(day({}), null, "non-string object");
// A bare "0" resolves to 2000-01-01 — V8's leniency, NOT something this change
// introduced: `parseSheetDate("0") || new Date("0")` gave the same answer. Locked
// in deliberately so the surviving new Date() branch is known to be unchanged.
// (The NUMBER 0 differed — the old code short-circuited to the epoch — but it is
// unreachable: every call site is guarded by `if (dateCol && row[dateCol])`, and
// Sheets values.get only ever yields strings.)
eq(day("0"), "2000-01-01", "bare '0' keeps its pre-existing V8 reading");
eq(day("Date: Mon, 32 Jul 2025 10:00:00 -0500"), "2025-08-01", "impossible day rolls over, same as parseSheetDate");
eq(day("2/30/2025"), "2025-03-02", "2/30 rolls into March, matching the previous parser");
eq(month("Date: Fri, 1 Jan 2027 00:00:00 -0600"), "2027-01", "far-future date still reads literally");

// -------------------------------------------------------------------- report
console.log("");
if (fail) {
	console.log(`FAILURES (${fail}):`);
	failures.forEach((f) => console.log(f));
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
