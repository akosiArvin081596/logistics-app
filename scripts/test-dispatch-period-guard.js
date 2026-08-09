#!/usr/bin/env node
/**
 * Tests for dispatchWriteBlocker() — the period guard shared by
 *   POST /api/dispatch, POST /api/dispatch/reassign,
 *   POST /api/driver/respond and PUT /api/driver/status.
 *
 * WHY IT LOADS THE FUNCTION OUT OF server.js SOURCE INSTEAD OF require()-ING IT.
 * Same reason as scripts/test-status-override-guard.js and test-money-date.js:
 * server.js opens SQLite, reads a service account key and starts listening on
 * import, so it cannot be required from a test. Extracting the text keeps this
 * honest in the way that matters — it exercises THE CODE THAT SHIPS, not a copy
 * that can quietly drift from it. The extraction asserts each function is found
 * exactly once, so a rename or a second definition fails the run loudly rather
 * than silently testing nothing.
 *
 * WHAT IS REAL AND WHAT IS STUBBED. Everything deciding whether a write is
 * material and which months it touches is the real shipped code —
 * dispatchWriteBlocker, jobStatusColumnName, sheetRowToObject,
 * jobTrackingMonthCols, loadRowPeriods, loadAssignedMonthKey, loadWindowDays,
 * moneySheetDate, jtParseSheetDate, jtExpandDateRange, jtFmtDate, findCol,
 * lockedAmong — plus the two regexes (CANCELED_STATUS_RE, DISPATCH_COMPLETED_RE)
 * read off their own source lines. Only the two DATABASE calls are stubbed:
 * isLocked() (a Set of locked months) and periodLocksReadable() (a boolean).
 *
 * THE PROPERTY UNDER TEST is that the guard refuses exactly the writes that
 * change what a settled month is made of, and refuses NOTHING else:
 *
 *   ALLOWED  — a load that is not completed contributes $0 to its month
 *              (revenue and driver pay are both gated on completedStatuses), so
 *              dispatching, reassigning, accepting and every mid-trip status
 *              stay open in a closed month. Measured on production 2026-08-09:
 *              zero of the 407 locked-month rows are in that state today, but
 *              the rule is what keeps the guard from being switched off the
 *              first time one is.
 *   REFUSED  — either side completed. 382 production rows, $313,923.93.
 *
 * AND that it is NOT the "does this row contribute TODAY?" predicate that
 * statusOverrideBlocker() warns about. Section 3 asserts both halves: that the
 * naive predicate really does answer "allow" for a Cancelled row being flipped
 * to Delivered, and that the shipped guard refuses it anyway — so the test pins
 * the TRAP, not just the fix.
 *
 * Run: node scripts/test-dispatch-period-guard.js
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

// Constants read off their own source lines, so a change to either regex breaks
// this run instead of quietly changing what "completed" means.
function extractConst(name) {
	const re = new RegExp(`\\nconst ${name} = [^\\n]+;`);
	const m = SRC.match(re);
	if (!m) throw new Error(`${name} not found in server.js`);
	const hits = SRC.split(`\nconst ${name} = `).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}, found ${hits}`);
	return m[0];
}

const REAL = [
	"dispatchWriteBlocker", "jobStatusColumnName", "sheetRowToObject",
	"jobTrackingMonthCols", "loadRowPeriods", "loadAssignedMonthKey",
	"loadWindowDays", "moneySheetDate", "jtParseSheetDate", "jtExpandDateRange",
	"jtFmtDate", "findCol", "lockedAmong",
];
const CONSTS = ["DISPATCH_COMPLETED_RE", "CANCELED_STATUS_RE", "RFC2822_MONTHS"];

let locked = new Set();
let locksReadable = true;

const body = [
	...CONSTS.map(extractConst),
	...REAL.map(extract),
	`return { ${REAL.join(", ")}, DISPATCH_COMPLETED_RE, CANCELED_STATUS_RE };`,
].join("\n\n");
const G = new Function("isLocked", "periodLocksReadable", body)(
	(p) => locked.has(p),
	() => locksReadable
);

// ------------------------------------------------------------------ harness
let pass = 0, fail = 0;
const failures = [];
function check(name, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return; }
	fail++; failures.push(`  ${name}\n     got:  ${g}\n     want: ${w}`);
}
function section(t) { console.log(`\n${t}`); }

// Production's real Job Tracking header row, verified against the live sheet
// 2026-08-09. Assigned Date [20] sits AHEAD of Status Update Date [21] and
// Completion Date [22] — the header luck section 5 removes.
const PROD_HEADERS = ["Contract ID", "Load ID", "Details", "Trailer Number", "Driver",
	"Pickup Info", "Pickup Appointment", "Pickup Address", "Drop-off Info",
	"Drop-off Appointment", "Drop-off Address", "Job Status", "Phase of Progress",
	"Carrier Stage", "  Payment  ", "Broker Contact Name", "Phone Number", "Email",
	"Location Link", "Documents", "Assigned Date", "Status Update Date",
	"Completion Date", "Truck", "Owner ID", "output"];

// A row in the header-keyed shape the guard reads.
function row(over) {
	return Object.assign({
		"Load ID": "553198052",
		"Driver": "Howard Reddie",
		"Job Status": "Delivered",
		"  Payment  ": "$4,800.00",
		"Pickup Appointment": "2026-05-12",
		"Drop-off Appointment": "2026-05-14",
		"Assigned Date": "2026-05-11",
		"Truck": "LogisX-#33",
		"Owner ID": "5",
	}, over || {});
}
const code = (r) => (r === null ? null : r.code);

// The four routes' real edit shapes, so the test cannot drift from the wiring.
const dispatchEdits = (driver) => ({ "Driver": driver, "Job Status": "Dispatched" });
const reassignEdits = (driver) => ({ "Driver": driver });
const statusEdits = (s, stamp) => {
	const e = { "Job Status": s, "Status Update Date": stamp || "2026-08-09 10:00:00" };
	if (/^(delivered|completed|pod received)$/i.test(s)) e["Completion Date"] = stamp || "2026-08-09 10:00:00";
	return e;
};

locked = new Set(["2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10",
	"2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05",
	"2026-06", "2026-07"]); // production's 15, as of 2026-08-09
locksReadable = true;

// =====================================================================
section("1. The permissive half — a load that is not completed moves $0");
// This is the half that keeps the guard switched on. If any of these refuse,
// routine dispatch into an older load is blocked and the guard gets disabled.
// =====================================================================
for (const st of ["Unassigned", "", "Dispatched", "Assigned", "Heading to Shipper",
	"At Shipper", "Loading", "In Transit", "At Receiver"]) {
	check(`dispatch onto "${st || "(blank)"}" in LOCKED 2026-05 → allow`,
		code(G.dispatchWriteBlocker(PROD_HEADERS, row({ "Job Status": st, "Driver": "" }), dispatchEdits("Shorn King"))), null);
}
check("reassign a mid-trip load in LOCKED 2026-05 → allow",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({ "Job Status": "In Transit" }), reassignEdits("Shorn King"))), null);
check("mid-trip status change At Shipper → In Transit in LOCKED 2026-05 → allow",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({ "Job Status": "At Shipper" }), statusEdits("In Transit"))), null);
check("driver ACCEPTS (→ Assigned) a dispatched load in LOCKED 2026-05 → allow",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({ "Job Status": "Dispatched" }), { "Job Status": "Assigned" })), null);
check("driver DECLINES a dispatched load in LOCKED 2026-05 → allow",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({ "Job Status": "Dispatched" }), { "Job Status": "Unassigned", "Driver": "" })), null);
// Reviving a load cancelled by mistake — the 2026-08-05 incident. $0 either way,
// because a Dispatched load contributes nothing. Its COMPLETION is what refuses.
// This assertion is why the guard has no "the cancelled flag changed" test: an
// earlier draft had one, and this is the case it broke. See the ⚠️ on
// dispatchWriteBlocker() before adding it back.
check("re-dispatch a CANCELLED load in LOCKED 2026-06 → allow (revive moves $0)",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({ "Job Status": "Cancelled", "Assigned Date": "2026-06-03" }), dispatchEdits("Shorn King"))), null);

// =====================================================================
section("2. The strict half — either side completed, in a closed month");
// =====================================================================
for (const st of ["Delivered", "Completed", "POD Received", "delivered", "pod received"]) {
	check(`dispatch onto "${st}" in LOCKED 2026-05 → PERIOD_FINALIZED`,
		code(G.dispatchWriteBlocker(PROD_HEADERS, row({ "Job Status": st }), dispatchEdits("Shorn King"))), "PERIOD_FINALIZED");
	check(`reassign "${st}" in LOCKED 2026-05 → PERIOD_FINALIZED`,
		code(G.dispatchWriteBlocker(PROD_HEADERS, row({ "Job Status": st }), reassignEdits("Shorn King"))), "PERIOD_FINALIZED");
}
check("un-completing Delivered → In Transit in LOCKED 2026-05 → PERIOD_FINALIZED",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({}), statusEdits("In Transit"))), "PERIOD_FINALIZED");
check("driver DECLINES a DELIVERED load in LOCKED 2026-05 → PERIOD_FINALIZED",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({}), { "Job Status": "Unassigned", "Driver": "" })), "PERIOD_FINALIZED");
check("the refusal names the month it would restate",
	G.dispatchWriteBlocker(PROD_HEADERS, row({}), reassignEdits("X")).periods, ["2026-05"]);
// The same writes in the one OPEN month must all succeed.
check("dispatch onto Delivered in OPEN 2026-08 → allow",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({ "Assigned Date": "2026-08-03", "Pickup Appointment": "2026-08-03", "Drop-off Appointment": "2026-08-04" }), dispatchEdits("Shorn King"))), null);
check("reassign a Delivered load in OPEN 2026-08 → allow",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({ "Assigned Date": "2026-08-03", "Pickup Appointment": "2026-08-03", "Drop-off Appointment": "2026-08-04" }), reassignEdits("Shorn King"))), null);

// =====================================================================
section("3. The trap — 'does this row contribute TODAY?' is NOT the predicate");
// =====================================================================
// 25 production rows sit at Cancelled/Canceled inside locked months carrying
// $29,166.25. excludeDroppedLoads() drops every one of them, so a before-only,
// contribution-based predicate answers "allow" for the flip that injects them.
const cancelledRow = row({ "Job Status": "Cancelled", "Assigned Date": "2026-06-03", "Pickup Appointment": "2026-06-03", "Drop-off Appointment": "2026-06-04" });
const naiveContributesToday = (r) => G.DISPATCH_COMPLETED_RE.test(String(r["Job Status"] || "").trim());
check("the NAIVE predicate says the cancelled row contributes nothing (the trap)",
	naiveContributesToday(cancelledRow), false);
check("...but the shipped guard REFUSES Cancelled → Delivered into LOCKED 2026-06",
	code(G.dispatchWriteBlocker(PROD_HEADERS, cancelledRow, statusEdits("Delivered"))), "PERIOD_FINALIZED");
check("...and refuses Cancelled → Completed the same way",
	code(G.dispatchWriteBlocker(PROD_HEADERS, cancelledRow, statusEdits("Completed"))), "PERIOD_FINALIZED");
// The mirror image: erasure is caught by the BEFORE state, since reassign
// writes no status at all and so has no after-state signal whatsoever.
check("erasure is caught by BEFORE — reassign is status-blind",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({}), reassignEdits("Shorn King"))), "PERIOD_FINALIZED");
// Cancelling a completed load through a dispatch route is an erasure too.
check("Delivered → Cancelled in LOCKED 2026-05 → PERIOD_FINALIZED",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({}), { "Job Status": "Cancelled" })), "PERIOD_FINALIZED");

// =====================================================================
section("4. Fail-closed rungs");
// =====================================================================
locksReadable = false;
check("unreadable period_locks → PERIOD_LOCK_UNREADABLE (even for a $0 write)",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({ "Job Status": "In Transit" }), reassignEdits("X"))), "PERIOD_LOCK_UNREADABLE");
check("unreadable period_locks outranks everything",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({}), dispatchEdits("X"))), "PERIOD_LOCK_UNREADABLE");
locksReadable = true;

// A material write whose months cannot be read could be booked anywhere.
const undated = row({ "Assigned Date": "", "Pickup Appointment": "", "Drop-off Appointment": "" });
check("material write on an undated row → PERIOD_UNRESOLVED",
	code(G.dispatchWriteBlocker(PROD_HEADERS, undated, reassignEdits("X"))), "PERIOD_UNRESOLVED");
check("PERIOD_FINALIZED outranks PERIOD_UNRESOLVED when both could fire",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({ "Assigned Date": "", "Pickup Appointment": "2026-05-12", "Drop-off Appointment": "" }), reassignEdits("X"))), "PERIOD_FINALIZED");
// A NON-material write is allowed without resolving months. Not a fail-open: if
// no settled figure moves, which month the row sits in cannot matter.
check("non-material write on an undated row → allow",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({ "Job Status": "Dispatched", "Assigned Date": "", "Pickup Appointment": "", "Drop-off Appointment": "" }), dispatchEdits("X"))), null);
// A blank row (dispatch into a row past the data) must stay writable.
check("wholly blank row + dispatch → allow",
	code(G.dispatchWriteBlocker(PROD_HEADERS, {}, dispatchEdits("X"))), null);

// =====================================================================
section("5. Header luck — the union of BEFORE and AFTER (PR #218's lesson)");
// =====================================================================
// jobTrackingMonthCols().dateCol takes the FIRST header matching
// status-update / completion / assigned date. Drop "Assigned Date" and the
// production layout resolves to "Status Update Date" — which PUT
// /api/driver/status stamps on every single transition. The write then MOVES
// the load's revenue month, and a before-only guard cannot see it.
const NO_ASSIGNED = PROD_HEADERS.filter((h) => h !== "Assigned Date");
check("sanity: dateCol falls through to Status Update Date without Assigned Date",
	G.jobTrackingMonthCols(NO_ASSIGNED).dateCol, "Status Update Date");
const openRow = { "Load ID": "1", "Job Status": "At Shipper", "Status Update Date": "2026-08-03 09:00:00", "Pickup Appointment": "2026-08-03", "Drop-off Appointment": "2026-08-04" };
check("BEFORE open, AFTER open → allow",
	code(G.dispatchWriteBlocker(NO_ASSIGNED, openRow, { "Job Status": "In Transit", "Status Update Date": "2026-08-09 10:00:00" })), null);
// Moving a row INTO a closed month: only the after-state is locked.
check("a stamp that moves the month INTO a locked one → PERIOD_FINALIZED",
	code(G.dispatchWriteBlocker(NO_ASSIGNED, openRow, { "Job Status": "In Transit", "Status Update Date": "2026-07-30 10:00:00" })), "PERIOD_FINALIZED");
// ...and out of one: only the before-state is locked.
const lockedRow = { "Load ID": "1", "Job Status": "At Shipper", "Status Update Date": "2026-07-30 10:00:00", "Pickup Appointment": "2026-07-30", "Drop-off Appointment": "2026-07-31" };
check("a stamp that moves the month OUT of a locked one → PERIOD_FINALIZED",
	code(G.dispatchWriteBlocker(NO_ASSIGNED, lockedRow, { "Job Status": "In Transit", "Status Update Date": "2026-08-09 10:00:00" })), "PERIOD_FINALIZED");
check("the union names BOTH months",
	G.dispatchWriteBlocker(NO_ASSIGNED, lockedRow, { "Job Status": "In Transit", "Status Update Date": "2026-06-09 10:00:00" }).periods, ["2026-06", "2026-07"]);

// =====================================================================
section("6. The status column must be identifiable, or the write is material");
// =====================================================================
// /status/i also matches "Status Update Date". On a sheet with no plain status
// column that would resolve a DATE, nothing would ever look completed, and the
// guard would fail OPEN on every row — so it refuses instead.
check("production headers resolve the plain status column",
	G.jobStatusColumnName(PROD_HEADERS), "Job Status");
const NO_STATUS = PROD_HEADERS.filter((h) => h !== "Job Status");
check("no plain status column → jobStatusColumnName is null",
	G.jobStatusColumnName(NO_STATUS), null);
check("no plain status column → every locked-month write is material",
	code(G.dispatchWriteBlocker(NO_STATUS, row({}), reassignEdits("X"))), "PERIOD_FINALIZED");
check("no plain status column → an OPEN month still allows the write",
	code(G.dispatchWriteBlocker(NO_STATUS, { "Assigned Date": "2026-08-03" }, reassignEdits("X"))), null);
check("headers with no status-ish column at all → null",
	G.jobStatusColumnName(["Load ID", "Driver"]), null);

// =====================================================================
section("7. sheetRowToObject — the array → header-keyed conversion");
// =====================================================================
check("maps by header name",
	G.sheetRowToObject(["A", "B", "C"], ["1", "2", "3"]), { A: "1", B: "2", C: "3" });
check("skips blank header cells (Job Details' column A is blank-named)",
	G.sheetRowToObject(["", "B"], ["1", "2"]), { B: "2" });
check("a short row leaves later columns undefined, never shifted",
	G.sheetRowToObject(["A", "B", "C"], ["1"]), { A: "1" });
check("an absent row is an empty object, not a throw",
	G.sheetRowToObject(["A"], undefined), {});

// =====================================================================
section("8. Guard flag independence + the wiring cannot drift");
// =====================================================================
// Ungated on PERIOD_FINALIZE_ENABLED: flag off means period_locks is empty.
const noLocks = locked; locked = new Set();
check("no locked periods (flag off) → every write allowed",
	code(G.dispatchWriteBlocker(PROD_HEADERS, row({}), reassignEdits("X"))), null);
locked = noLocks;

// Each route must actually call the guard, and refuse through the shared helper.
for (const marker of [
	'"dispatch_blocked"', '"reassign_blocked"',
	'"status_update_blocked"', '"driver_respond_blocked"',
]) {
	check(`server.js wires an audited refusal for ${marker}`, SRC.includes(marker), true);
}
check("dispatchWriteBlocker is called from exactly the 4 routes",
	SRC.split("const blocked = dispatchWriteBlocker(").length - 1, 4);
check("PUT /api/driver/status validates rowIndex through the shared helper",
	/rowIndex: rawRowIndex, loadId, newStatus, rowData[\s\S]{0,1400}resolveSheetDataRow\(res, rawRowIndex\)/.test(SRC), true);
// The guard judges a WHOLE row, never a single cell (PR #218's `A{n}` bug, where
// `Job Tracking!A5` reads one cell rather than row 5). The two-range batchGet that
// used to carry this property was replaced by a full-tab read, because the load
// binding has to count how many rows carry a load id and the id's column is only
// known after the headers are read — so the property is now pinned on the read
// and the slice instead of on the A1 shape.
// Sliced out by hand rather than via extract(), whose needle is `\nfunction ` —
// this one is an `async function`. Same "found exactly once" discipline.
const SNAPSHOT = (() => {
	const needle = "\nasync function readJobTrackingSnapshot(";
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 readJobTrackingSnapshot(), found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error("unbalanced braces extracting readJobTrackingSnapshot()");
})();
check("the snapshot reads the whole tab, not a cell or a column",
	/range: "Job Tracking",/.test(SNAPSHOT), true);
check("no single-cell A{n} range survives in the snapshot read",
	/Job Tracking!\$\{?[A-Za-z]/.test(SNAPSHOT), false);
check("the target row is the header-offset slice of the data rows",
	/row: rows\[rowIndex - 2\] \|\| \[\]/.test(SNAPSHOT), true);
check("every data row is returned, so the binding can count duplicates",
	/const rows = all\.slice\(1\);/.test(SNAPSHOT), true);
// ⚠️ NOT getJobTrackingCached(): it is up to 60s stale (a row that moved inside
// that window is exactly what the binding catches) and it returns
// deduplicateLoads() output, which hides the duplicates AMBIGUOUS_LOAD looks for.
check("the snapshot does not read through the 60s deduplicated cache",
	/getJobTrackingCached/.test(SNAPSHOT), false);

// ------------------------------------------------------------------ report
console.log(`\n${"=".repeat(60)}`);
if (fail) {
	console.log(`FAILURES (${fail}):`);
	failures.forEach((f) => console.log(f));
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
