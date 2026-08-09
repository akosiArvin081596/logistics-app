#!/usr/bin/env node
/**
 * Tests for statusOverrideBlocker() — the period guard on
 * PUT /api/loads/:loadId/status-override.
 *
 * WHY IT LOADS THE FUNCTION OUT OF server.js SOURCE INSTEAD OF require()-ING IT.
 * Same reason as scripts/test-money-date.js: server.js opens SQLite, reads a
 * service account key and starts listening on import, so it cannot be required
 * from a test. Extracting the text keeps this honest in the way that matters —
 * it exercises THE CODE THAT SHIPS, not a copy that can quietly drift from it.
 * The extraction asserts each function is found exactly once, so a rename or a
 * second definition fails the run loudly rather than silently testing nothing.
 *
 * WHAT IS REAL AND WHAT IS STUBBED. Everything that decides WHICH MONTHS a row
 * feeds is the real shipped code — statusOverrideBlocker, jobTrackingMonthCols,
 * loadRowPeriods, loadAssignedMonthKey, loadWindowDays, moneySheetDate,
 * jtParseSheetDate, jtExpandDateRange, jtFmtDate, findCol, lockedAmong. Only the
 * two DATABASE calls are stubbed: isLocked() (backed by a Set of locked months)
 * and periodLocksReadable() (a boolean). Stubbing the month math would test
 * nothing; stubbing the database is the only way to test it without one.
 *
 * THE PROPERTY UNDER TEST is not "a locked row is refused". It is that the guard
 * takes the union of the BEFORE and AFTER states, because each direction is a
 * different way to restate a closed month and each is invisible to a guard that
 * only looks at the other:
 *
 *   BEFORE  — 26 rows sit at "Cancelled"/"Canceled" and are dropped from every
 *             aggregate by excludeDroppedLoads(). A guard phrased as "does this
 *             row contribute to a locked month today?" answers NO for all of
 *             them, so it permits flipping one to "Delivered" — which injects
 *             the $29,166.25 carried by the 25 of them inside locked months,
 *             including load 554481641 ($4,100, assigned 2026-06, a month whose
 *             payout is already `paid`). Section 2 asserts both halves:
 *             that such a naive predicate really does say "allow", and that the
 *             shipped guard refuses anyway. It refuses because loadRowPeriods()
 *             is deliberately status-blind.
 *   AFTER   — the route stamps Status Update Date and sets/clears Completion
 *             Date. jobTrackingMonthCols().dateCol matches the FIRST header
 *             hitting `status.*update.*date|completion.*date|assigned.*date`, so
 *             on the production layout ("Assigned Date" at [20], ahead of both)
 *             the after-state is inert — that is header luck, not a property of
 *             the route. Section 3 runs the same guard on a layout with no
 *             Assigned Date, where this route's own write moves the row's
 *             revenue month into a locked one, and on one where clearing
 *             Completion Date makes the month unresolvable.
 *
 * Run: node scripts/test-status-override-guard.js
 */
const fs = require("fs");
const path = require("path");

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
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}

// The allowlist, read off the same source line the route uses.
function extractAllowList() {
	const m = SRC.match(/\nconst STATUS_OVERRIDE_ALLOWED = (\[[^\]]*\]);/);
	if (!m) throw new Error("STATUS_OVERRIDE_ALLOWED not found in server.js");
	return JSON.parse(m[1].replace(/'/g, '"'));
}

// A module-scope `const NAME = …;` one-liner, lifted verbatim. loadRowPeriods()
// and loadAssignedMonthKey() reference LOCKABLE_MONTH_KEY (the 1970-2999 bound
// that stops a non-month key like "999-01-" being silently dropped by
// lockedAmong() and read as "nothing locked"), so extracting the functions
// without it throws a ReferenceError the moment the guard evaluates a row.
function extractConst(name) {
	const hits = SRC.match(new RegExp(`\\nconst ${name} = [^\\n]*;`, "g")) || [];
	if (hits.length !== 1) throw new Error(`expected exactly 1 const ${name} in server.js, found ${hits.length}`);
	return hits[0].trim();
}

const REAL_CONSTS = ["LOCKABLE_MONTH_KEY"];
const REAL = [
	"statusOverrideBlocker", "jobTrackingMonthCols", "loadRowPeriods",
	"loadAssignedMonthKey", "loadWindowDays", "moneySheetDate",
	"jtParseSheetDate", "jtFmtDate", "jtExpandDateRange", "findCol", "lockedAmong",
];
const RFC2822_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// The two database calls, and only those two.
let LOCKED = new Set();
let LOCKS_READABLE = true;
const isLocked = (p) => LOCKED.has(p);
const periodLocksReadable = () => LOCKS_READABLE;

const { statusOverrideBlocker } = new Function(
	"RFC2822_MONTHS", "isLocked", "periodLocksReadable",
	`${REAL_CONSTS.map(extractConst).join("\n")}\n${REAL.map(extract).join("\n")}\nreturn { statusOverrideBlocker };`
)(RFC2822_MONTHS, isLocked, periodLocksReadable);

const STATUS_OVERRIDE_ALLOWED = extractAllowList();

// -------------------------------------------------------------------- runner
let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++; failures.push(`  ${label}\n      expected ${e}\n      actual   ${a}`);
}
function section(t) { console.log(`\n${t}`); }

// ------------------------------------------------------------------ fixtures
// Header order copied from the LOCAL Dispatch Management sheet (a copy of
// production, verified 2026-08-09): Job Status [11], Assigned Date [20],
// Status Update Date [21], Completion Date [22]. Assigned Date FIRST is what
// makes the after-state inert here — see section 3.
const PROD_HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver",
	"Pickup Info", "Pickup Appointment", "Pickup Address",
	"Drop-off Info", "Drop-off Appointment", "Drop-off Address",
	"Job Status", "Phase of Progress", "Carrier Stage", "  Payment  ",
	"Broker Contact Name", "Phone Number", "Email", "Location Link", "Documents",
	"Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output",
];

// A header layout with NO "Assigned Date" — jobTrackingMonthCols().dateCol then
// resolves to "Status Update Date", the very cell this route rewrites.
const NO_ASSIGNED_HEADERS = ["Load ID", "Job Status", "Status Update Date", "Completion Date"];
// …and one where it resolves to "Completion Date", the cell this route CLEARS.
const COMPLETION_ONLY_HEADERS = ["Load ID", "Job Status", "Completion Date"];

function row(headers, cells) {
	const o = {};
	headers.forEach((h) => { o[h] = ""; });
	Object.assign(o, cells);
	return o;
}

// The delta the route builds: status + Status Update Date + Completion Date.
// `TODAY` stands in for houstonStamp(new Date()) — the route always stamps NOW,
// which is why the after-state can only ever land in the current month.
const TODAY = "2026-08-09 11:04:22";
function edits(headers, status, stamp = TODAY) {
	const isCompletion = /^(delivered|completed|pod received)$/i.test(status);
	const e = { "Job Status": status };
	if (headers.includes("Status Update Date")) e["Status Update Date"] = stamp;
	if (headers.includes("Completion Date")) e["Completion Date"] = isCompletion ? stamp : "";
	return e;
}

const code = (b) => (b === null ? null : b.code);

// ============================================================== 1. the basics
section("1. before-locked / neither / both");
LOCKS_READABLE = true;

LOCKED = new Set(["2025-05"]);
eq(
	statusOverrideBlocker(PROD_HEADERS, [row(PROD_HEADERS, { "Load ID": "514964039", "Job Status": "Completed", "Assigned Date": "Date: Wed, 14 May 2025 10:42:04 -0500" })], edits(PROD_HEADERS, "In Transit")),
	{ code: "PERIOD_FINALIZED", periods: ["2025-05"] },
	"BEFORE locked: a 2025-05 row is refused, naming the month",
);

LOCKED = new Set(["2025-05"]);
eq(
	code(statusOverrideBlocker(PROD_HEADERS, [row(PROD_HEADERS, { "Load ID": "559091882", "Job Status": "Delivered", "Assigned Date": "7/3/2026, 3:45:15 PM" })], edits(PROD_HEADERS, "In Transit"))),
	null,
	"NEITHER locked: an open 2026-07 row passes — the guard is not a blanket freeze",
);

// BOTH sides locked. Needs a layout where the after-state can move at all, so
// the row's own month AND the current month are closed.
LOCKED = new Set(["2026-05", "2026-08"]);
eq(
	statusOverrideBlocker(NO_ASSIGNED_HEADERS, [row(NO_ASSIGNED_HEADERS, { "Load ID": "553271218", "Job Status": "Delivered", "Status Update Date": "2026-05-13" })], edits(NO_ASSIGNED_HEADERS, "In Transit")),
	{ code: "PERIOD_FINALIZED", periods: ["2026-05", "2026-08"] },
	"BOTH locked: the refusal names both months, not just one",
);

// ==================================================== 2. THE RESURRECTION CASE
section("2. after-locked I — the cancelled -> delivered resurrection");

// The predicate a naive guard would use: "does this row contribute to a locked
// month TODAY?", i.e. excludeDroppedLoads()'s own rule. Written out so the test
// asserts the trap exists rather than merely asserting the fix works.
const CANCELED_STATUS_RE = /^(cancel|canceled|cancelled)$/i;
function naiveContributesToLockedMonth(r) {
	if (CANCELED_STATUS_RE.test(String(r["Job Status"] || "").trim())) return false; // dropped from every aggregate
	const mk = String(r["Assigned Date"] || "").slice(0, 7);
	return LOCKED.has(mk);
}

LOCKED = new Set(["2026-06"]);
// Production load 554481641: $4,100, 2026-06, a month whose payout is PAID.
const resurrect = row(PROD_HEADERS, {
	"Load ID": "554481641", "Job Status": "Cancelled",
	"Assigned Date": "2026-06-11", "  Payment  ": " $ 4,100.00 ",
});

eq(naiveContributesToLockedMonth(resurrect), false,
	"the trap is real: a status-aware 'contributes today?' check says ALLOW for a cancelled row");
eq(
	statusOverrideBlocker(PROD_HEADERS, [resurrect], edits(PROD_HEADERS, "Delivered")),
	{ code: "PERIOD_FINALIZED", periods: ["2026-06"] },
	"the shipped guard refuses it anyway — loadRowPeriods() is status-blind",
);
// Same row, same locked month, both spellings the sheet actually carries.
eq(
	code(statusOverrideBlocker(PROD_HEADERS, [row(PROD_HEADERS, { "Load ID": "513113951", "Job Status": "Canceled", "Assigned Date": "Date: Fri, 9 May 2025 16:01:08 -0500" })], edits(PROD_HEADERS, "Delivered"))),
	null,
	"'Canceled' in 2025-05 passes while only 2026-06 is locked (sanity: the refusal above is the month, not the word)",
);
LOCKED = new Set(["2025-05", "2026-06"]);
eq(
	code(statusOverrideBlocker(PROD_HEADERS, [row(PROD_HEADERS, { "Load ID": "513113951", "Job Status": "Canceled", "Assigned Date": "Date: Fri, 9 May 2025 16:01:08 -0500" })], edits(PROD_HEADERS, "Delivered"))),
	"PERIOD_FINALIZED",
	"…and is refused once 2025-05 is locked, on an RFC-2822 assigned date",
);

// =========================================== 3. after-locked II — this route's
section("3. after-locked II — the dates this route itself writes");

// PROD LAYOUT: Assigned Date wins the dateCol race, so the write cannot move the
// month. Locking ONLY the current month must therefore permit the write. This is
// the control that shows the after-state is inert by header luck, not by design.
LOCKED = new Set(["2026-08"]);
eq(
	code(statusOverrideBlocker(PROD_HEADERS, [row(PROD_HEADERS, { "Load ID": "559091882", "Job Status": "Delivered", "Assigned Date": "7/3/2026, 3:45:15 PM" })], edits(PROD_HEADERS, "In Transit"))),
	null,
	"prod layout: stamping Status Update Date does NOT move the month (Assigned Date wins dateCol)",
);

// NO "Assigned Date": dateCol resolves to Status Update Date — the cell this
// route overwrites with NOW. Row sits in an OPEN month; the write moves it into
// a LOCKED current month. Before-only guards cannot see this at all.
LOCKED = new Set(["2026-08"]);
eq(
	statusOverrideBlocker(NO_ASSIGNED_HEADERS, [row(NO_ASSIGNED_HEADERS, { "Load ID": "560063215", "Job Status": "Delivered", "Status Update Date": "2026-07-08" })], edits(NO_ASSIGNED_HEADERS, "In Transit")),
	{ code: "PERIOD_FINALIZED", periods: ["2026-08"] },
	"AFTER locked only: an open-month row whose write lands in a closed current month is refused",
);

// Same layout, current month open -> allowed. Proves the refusal above is the
// after-state and not the layout.
LOCKED = new Set(["2026-06"]);
eq(
	code(statusOverrideBlocker(NO_ASSIGNED_HEADERS, [row(NO_ASSIGNED_HEADERS, { "Load ID": "560063215", "Job Status": "Delivered", "Status Update Date": "2026-07-08" })], edits(NO_ASSIGNED_HEADERS, "In Transit"))),
	null,
	"…and permitted when the current month is open",
);

// dateCol = Completion Date, and reverting away from a completed status CLEARS
// it. The after-state then has no readable month at all.
LOCKED = new Set();
eq(
	code(statusOverrideBlocker(COMPLETION_ONLY_HEADERS, [row(COMPLETION_ONLY_HEADERS, { "Load ID": "7035474", "Job Status": "Delivered", "Completion Date": "2026-07-02" })], edits(COMPLETION_ONLY_HEADERS, "In Transit"))),
	"PERIOD_UNRESOLVED",
	"clearing the cell that decides the month leaves the AFTER state unresolvable -> refuse",
);
eq(
	code(statusOverrideBlocker(COMPLETION_ONLY_HEADERS, [row(COMPLETION_ONLY_HEADERS, { "Load ID": "7035474", "Job Status": "In Transit", "Completion Date": "2026-07-02" })], edits(COMPLETION_ONLY_HEADERS, "Delivered"))),
	null,
	"…while a write that REPOPULATES it resolves and passes",
);

// ========================================================== 4. unresolved rows
section("4. unresolved");
LOCKED = new Set(["2025-05"]);
eq(
	code(statusOverrideBlocker(PROD_HEADERS, [row(PROD_HEADERS, { "Load ID": "x1", "Job Status": "Delivered", "Assigned Date": "" })], edits(PROD_HEADERS, "In Transit"))),
	"PERIOD_UNRESOLVED",
	"no date anywhere on the row -> refuse, never 'affects nothing'",
);
eq(
	code(statusOverrideBlocker(PROD_HEADERS, [row(PROD_HEADERS, { "Load ID": "x2", "Job Status": "Delivered", "Assigned Date": "07:00 Appt." })], edits(PROD_HEADERS, "In Transit"))),
	"PERIOD_UNRESOLVED",
	"a bare time with no date (2 such rows on production) -> refuse",
);
eq(
	code(statusOverrideBlocker(PROD_HEADERS, [row(PROD_HEADERS, { "Load ID": "x3", "Job Status": "Delivered", "Assigned Date": "", "Pickup Appointment": "2026-07-14", "Drop-off Appointment": "2026-07-16" })], edits(PROD_HEADERS, "In Transit"))),
	null,
	"…but a row with no assigned date and a readable pickup->dropoff window resolves via that window",
);
LOCKED = new Set(["2026-07"]);
eq(
	statusOverrideBlocker(PROD_HEADERS, [row(PROD_HEADERS, { "Load ID": "x4", "Job Status": "Delivered", "Assigned Date": "", "Pickup Appointment": "2026-06-29", "Drop-off Appointment": "2026-07-02" })], edits(PROD_HEADERS, "In Transit")),
	{ code: "PERIOD_FINALIZED", periods: ["2026-07"] },
	"a window spanning two months is refused when EITHER month is locked",
);

// ============================================== 5. unreadable period_locks
section("5. unreadable period_locks — fail closed");
LOCKS_READABLE = false;
LOCKED = new Set(); // isLocked() would answer 'not locked' for everything
eq(
	statusOverrideBlocker(PROD_HEADERS, [row(PROD_HEADERS, { "Load ID": "559091882", "Job Status": "Delivered", "Assigned Date": "7/3/2026, 3:45:15 PM" })], edits(PROD_HEADERS, "In Transit")),
	{ code: "PERIOD_LOCK_UNREADABLE", periods: [] },
	"an unreadable lock table refuses an otherwise-open row",
);
eq(
	statusOverrideBlocker(PROD_HEADERS, [], edits(PROD_HEADERS, "In Transit")),
	{ code: "PERIOD_LOCK_UNREADABLE", periods: [] },
	"…and is checked before anything else, so even an empty candidate set refuses",
);
LOCKS_READABLE = true;

// ==================================================== 6. duplicate load ids
section("6. ambiguity — refuse, never guess");
LOCKED = new Set();
const dupOpenA = row(PROD_HEADERS, { "Load ID": "7052901", "Job Status": "Delivered", "Assigned Date": "7/12/2026, 9:00:00 AM" });
const dupOpenB = row(PROD_HEADERS, { "Load ID": "7052901", "Job Status": "Cancelled", "Assigned Date": "7/15/2026, 9:00:00 AM" });
eq(
	statusOverrideBlocker(PROD_HEADERS, [dupOpenA, dupOpenB], edits(PROD_HEADERS, "In Transit")),
	{ code: "AMBIGUOUS_LOAD", periods: [] },
	"two rows share the load id and both months are open -> AMBIGUOUS_LOAD",
);
eq(
	code(statusOverrideBlocker(PROD_HEADERS, [dupOpenA], edits(PROD_HEADERS, "In Transit"))),
	null,
	"…one row, same data, passes — ambiguity is the refusal, not the row",
);

LOCKED = new Set(["2025-05"]);
eq(
	statusOverrideBlocker(PROD_HEADERS, [
		row(PROD_HEADERS, { "Load ID": "514964283", "Job Status": "Completed", "Assigned Date": "Date: Wed, 14 May 2025 10:42:04 -0500" }),
		row(PROD_HEADERS, { "Load ID": "514964283", "Job Status": "Completed", "Assigned Date": "7/12/2026, 9:00:00 AM" }),
	], edits(PROD_HEADERS, "In Transit")),
	{ code: "PERIOD_FINALIZED", periods: ["2025-05"] },
	"PERIOD_FINALIZED outranks AMBIGUOUS_LOAD when both could fire",
);
eq(
	statusOverrideBlocker(PROD_HEADERS, [
		row(PROD_HEADERS, { "Load ID": "d1", "Job Status": "Completed", "Assigned Date": "Date: Wed, 14 May 2025 10:42:04 -0500" }),
		row(PROD_HEADERS, { "Load ID": "d1", "Job Status": "Completed", "Assigned Date": "" }),
	], edits(PROD_HEADERS, "In Transit")),
	{ code: "PERIOD_FINALIZED", periods: ["2025-05"] },
	"…and outranks PERIOD_UNRESOLVED too: the actionable month is reported first",
);
LOCKED = new Set();
eq(
	code(statusOverrideBlocker(PROD_HEADERS, [
		row(PROD_HEADERS, { "Load ID": "d2", "Job Status": "Completed", "Assigned Date": "7/12/2026, 9:00:00 AM" }),
		row(PROD_HEADERS, { "Load ID": "d2", "Job Status": "Completed", "Assigned Date": "" }),
	], edits(PROD_HEADERS, "In Transit"))),
	"PERIOD_UNRESOLVED",
	"an unresolvable SECOND row is refused even though the first resolves to an open month",
);

// ====================================== 7. the allowlist (adjacent defect #1)
section("7. STATUS_OVERRIDE_ALLOWED");
eq(STATUS_OVERRIDE_ALLOWED,
	["Dispatched", "Heading to Shipper", "At Shipper", "Loading", "In Transit", "At Receiver", "Delivered"],
	"is exactly the seven ActiveLoadsTab.vue offers");
eq(STATUS_OVERRIDE_ALLOWED.filter((s) => /^(cancel|canceled|cancelled)$/i.test(s)), [],
	"cannot set Cancelled — that is POST /api/dispatch/cancel, Super Admin only");
eq(STATUS_OVERRIDE_ALLOWED.filter((s) => /^(completed|pod received)$/i.test(s)), [],
	"cannot set Completed / POD Received either — never offered, and Delivered already completes a load");
eq(STATUS_OVERRIDE_ALLOWED.some((s) => /^(delivered|completed|pod received)$/i.test(s)), true,
	"…but at least one completedStatuses value remains reachable, so nothing is lost");

// Cross-check against the client so the two lists cannot drift apart silently.
const CLIENT = path.join(__dirname, "..", "client", "src", "components", "dashboard", "ActiveLoadsTab.vue");
const clientSrc = fs.readFileSync(CLIENT, "utf8");
const cm = clientSrc.match(/const statusOptions = (\[[^\]]*\])/);
eq(cm ? JSON.parse(cm[1].replace(/'/g, '"')) : null, STATUS_OVERRIDE_ALLOWED,
	"client statusOptions === server STATUS_OVERRIDE_ALLOWED");

// ------------------------------------------------------------------- results
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join("\n")); process.exit(1); }
