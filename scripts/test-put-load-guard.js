#!/usr/bin/env node
/**
 * Unit assertions for the PUT /api/load/:loadId guard and the A1 column-letter
 * helpers.
 *
 * ⚠️ THE CODE UNDER TEST IS EXTRACTED FROM server.js SOURCE, not copied here.
 * Every extraction asserts the definition is found EXACTLY ONCE, so a rename, a
 * second definition, or a reformat fails loudly rather than silently testing a
 * stale duplicate. Only the two database calls (isLocked / periodLocksReadable)
 * are stubbed.
 *
 * Run: node scripts/test-put-load-guard.js
 */

const fs = require("fs");
const path = require("path");

// SERVER_JS / GEOCODE_JS override the paths so the whole suite can be pointed at
// a BASE-commit copy (`git show <base>:server.js > /tmp/base.js`) to prove the
// assertions actually fail before the fix rather than passing vacuously.
const SERVER = process.env.SERVER_JS || path.join(__dirname, "..", "server.js");
const GEOCODE = process.env.GEOCODE_JS || path.join(__dirname, "geocode-loads.js");
const src = fs.readFileSync(SERVER, "utf8");

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  failures.push(label);
  console.error(`  FAIL: ${label}`);
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${label} (got ${a}, want ${e})`);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

// A top-level `function NAME(...) { ... }` — server.js formats these with the
// closing brace in column 0, which is what bounds the capture.
function extractFunction(name) {
  const re = new RegExp(`^function ${name}\\s*\\(`, "gm");
  const hits = [...src.matchAll(re)];
  if (hits.length !== 1) {
    throw new Error(`expected exactly 1 definition of function ${name}(), found ${hits.length} — the test would otherwise pin the wrong code`);
  }
  const start = hits[0].index;
  const end = src.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`could not find the end of function ${name}()`);
  return src.slice(start, end + 3);
}

// A top-level `const NAME = ...;` up to the line that closes it.
function extractConst(name, terminator) {
  const re = new RegExp(`^const ${name}\\s*=`, "gm");
  const hits = [...src.matchAll(re)];
  if (hits.length !== 1) {
    throw new Error(`expected exactly 1 definition of const ${name}, found ${hits.length}`);
  }
  const start = hits[0].index;
  const end = src.indexOf(terminator, start);
  if (end === -1) throw new Error(`could not find the end of const ${name}`);
  return src.slice(start, end + terminator.length);
}

const FUNCS = [
  "colLetter",
  "a1ColumnLetter",
  // The fail-CLOSED lock predicate the write guards actually ask. Extracted, not
  // stubbed — "cannot read the table" ⇒ "treat as closed" is the behaviour under
  // test, and stubbing it would test the stub.
  "periodWriteLocked",
  "periodLabel",
  "sheetCellMonths",
  "sheetCellDate",
  "jtParseSheetDate",
  "jtFmtDate",
  "jtExpandDateRange",
  "loadRowAccountingMonths",
  "sheetRowIsEmpty",
  "guardedColumnReason",
  "sheetRowAfterUpdate",
  "changedGuardedCells",
  "sheetRowUpdateBlocker",
];

let harness = "";
for (const f of FUNCS) harness += extractFunction(f) + "\n";
harness += extractConst("JT_MONEY_COLUMN_PATTERNS", "\n];") + "\n";

// The only stubs. Both are DB reads; everything else above is the shipped code.
let LOCKED = new Set();
let LOCKS_READABLE = true;
const sandbox = {
  isLocked: (p) => LOCKED.has(p),
  periodLocksReadable: () => LOCKS_READABLE,
};

harness += `
return {
  colLetter, a1ColumnLetter, sheetCellMonths, loadRowAccountingMonths,
  sheetRowIsEmpty, guardedColumnReason, sheetRowAfterUpdate,
  changedGuardedCells, sheetRowUpdateBlocker, JT_MONEY_COLUMN_PATTERNS,
};`;

const G = new Function("isLocked", "periodLocksReadable", harness)(
  sandbox.isLocked,
  sandbox.periodLocksReadable,
);

console.log(`Extracted ${FUNCS.length} functions + 1 const from server.js\n`);

// ---------------------------------------------------------------------------
// PART 2 — the column-letter helpers
// ---------------------------------------------------------------------------
console.log("Part 2 — A1 column letters");

// The bug: String.fromCharCode(65 + i) is correct for 0..25 and punctuation after.
const broken = (i) => String.fromCharCode(65 + i);

// 1. Identical to the old expression for every index it was ever correct for —
//    this is what makes the swap safe on today's 26-column sheet.
let sameBelow26 = true;
for (let i = 0; i < 26; i++) if (G.colLetter(i) !== broken(i)) sameBelow26 = false;
ok(sameBelow26, "colLetter matches String.fromCharCode(65+i) for every i in 0..25");

// 2. And diverges exactly where the old expression broke.
eq(G.colLetter(0), "A", "colLetter(0)");
eq(G.colLetter(25), "Z", "colLetter(25)");
eq(G.colLetter(26), "AA", "colLetter(26) — the index that emitted '['");
eq(G.colLetter(27), "AB", "colLetter(27)");
eq(G.colLetter(51), "AZ", "colLetter(51)");
eq(G.colLetter(52), "BA", "colLetter(52)");
eq(G.colLetter(701), "ZZ", "colLetter(701)");
eq(G.colLetter(702), "AAA", "colLetter(702)");

// 3. The old expression really did produce an INVALID A1 range at 26 — pinning
//    the trap, not just the fix.
eq(broken(26), "[", "String.fromCharCode(65+26) is '[' — an invalid A1 column");
ok(!/^[A-Z]+$/.test(broken(26)), "the old expression leaves the A-Z alphabet at index 26");
ok(/^[A-Z]+$/.test(G.colLetter(26)), "colLetter stays inside the A-Z alphabet at index 26");

// 4. The two helpers in server.js agree. Having two is a smell, but while both
//    exist they must not disagree, or two write paths address different columns.
let helpersAgree = true;
for (let i = 0; i < 1000; i++) if (G.colLetter(i) !== G.a1ColumnLetter(i)) helpersAgree = false;
ok(helpersAgree, "colLetter and a1ColumnLetter agree on indices 0..999");

// 5. Job Tracking is 26 wide today — index 25 is the last valid one, so the very
//    next column added is the one that used to break.
eq(G.colLetter(25), "Z", "26-column sheet: last column is Z");
eq(G.colLetter(26), "AA", "27th column is AA — the first the old code got wrong");

// ---------------------------------------------------------------------------
// PART 1 — the period guard on PUT /api/load/:loadId
// ---------------------------------------------------------------------------
console.log("\nPart 1 — period guard");

// Production's real Job Tracking header row (26 columns).
const HEADERS = [
  "Contract ID", "Load ID", "Details", "Trailer Number", "Driver",
  "Pickup Info", "Pickup Address", "Pickup Appointment", "Drop-off Info",
  "Drop-off Address", "Drop-off Appointment", "Job Status", "Phase of Progress",
  "Carrier Stage", "Broker Contact Name", "Phone Number", "Email",
  "Assigned Date", "Status Update Date", "Completion Date", "Location Link",
  "Documents", "  Payment  ", "Truck", "Owner ID", "output",
];
eq(HEADERS.length, 26, "the fixture header row is 26 columns wide");

const IDX = Object.fromEntries(HEADERS.map((h, i) => [h.trim(), i]));
function row(overrides) {
  const r = new Array(HEADERS.length).fill("");
  r[IDX["Load ID"]] = "550448673";
  r[IDX["Assigned Date"]] = "2026-07-15";
  r[IDX["Job Status"]] = "Delivered";
  r[IDX["Payment"]] = "$1,800.00";
  r[IDX["Driver"]] = "Amir Serrano";
  r[IDX["Truck"]] = "LogisX-#33";
  for (const [k, v] of Object.entries(overrides || {})) r[IDX[k]] = v;
  return r;
}

// The route builds its `after` row from headers + the update map. Mirrors the
// shipped handler exactly.
function applyUpdates(before, updates) {
  return HEADERS.map((h, i) => (Object.prototype.hasOwnProperty.call(updates, h) ? updates[h] : (before[i] || "")));
}
function judge(before, updates) {
  const after = G.sheetRowAfterUpdate(before, applyUpdates(before, updates));
  const changes = G.changedGuardedCells(HEADERS, before, after);
  return G.sheetRowUpdateBlocker(true, HEADERS, before, after, changes);
}

LOCKED = new Set(["2026-07", "2026-06"]);
LOCKS_READABLE = true;

// --- the BEFORE direction: the row already books to a closed month ---
const julyRow = row({ "Assigned Date": "2026-07-15" });
ok(judge(julyRow, { "  Payment  ": "$9,999.00" })?.code === "PERIOD_FINALIZED",
  "payment edit on a July (locked) row is refused");
ok(judge(julyRow, { "Job Status": "Cancelled" })?.code === "PERIOD_FINALIZED",
  "status edit on a locked row is refused");
ok(judge(julyRow, { "Driver": "Someone Else" })?.code === "PERIOD_FINALIZED",
  "driver edit on a locked row is refused");
ok(judge(julyRow, { "Owner ID": "42" })?.code === "PERIOD_FINALIZED",
  "Owner ID edit on a locked row is refused");
ok(judge(julyRow, { "Truck": "LogisX-#2372" })?.code === "PERIOD_FINALIZED",
  "truck edit on a locked row is refused");
ok(judge(julyRow, { "Load ID": "999999999" })?.code === "PERIOD_FINALIZED",
  "Load ID edit on a locked row is refused");

// --- harmless edits stay allowed, even in a locked month ---
// This is the line that keeps the guard from freezing 96% of the sheet.
ok(judge(julyRow, { "Details": "called broker, running late" }) === null,
  "a note edit on the SAME locked row is allowed");
ok(judge(julyRow, { "Pickup Address": "123 New St, Laredo TX" }) === null,
  "an address edit on a locked row is allowed");
ok(judge(julyRow, { "Phone Number": "555-0100" }) === null,
  "a phone edit on a locked row is allowed");
ok(judge(julyRow, { "Trailer Number": "T-9" }) === null,
  "a trailer edit on a locked row is allowed");

// --- an open month is editable in full ---
const augRow = row({ "Assigned Date": "2026-08-03" });
ok(judge(augRow, { "  Payment  ": "$2,000.00" }) === null,
  "payment edit on an August (open) row is allowed");

// --- ⚠️ the AFTER direction — invisible to a before-only guard ---
ok(judge(augRow, { "Assigned Date": "2026-07-28" })?.code === "PERIOD_FINALIZED",
  "moving an OPEN row INTO a locked month is refused (after-state)");
ok(judge(julyRow, { "Assigned Date": "2026-08-03" })?.code === "PERIOD_FINALIZED",
  "moving a LOCKED row out to an open month is refused (before-state)");

// A before-only guard genuinely says "allow" for the after-direction case — pin
// the trap so the test proves the union is load-bearing, not decorative.
const afterOnlyTrap = (() => {
  const before = augRow;
  const months = G.loadRowAccountingMonths(HEADERS, before);
  return months.every((m) => !LOCKED.has(m));
})();
ok(afterOnlyTrap, "the trap is real: a before-only check sees only open months on that row");

// --- fail-closed rungs ---
LOCKS_READABLE = false;
ok(judge(julyRow, { "  Payment  ": "$1.00" })?.code === "PERIOD_LOCK_UNREADABLE",
  "an unreadable period_locks refuses");
ok(judge(julyRow, { "Details": "note" }) === null,
  "an unreadable period_locks still allows a non-money edit");
LOCKS_READABLE = true;

const badDateRow = row({ "Pickup Appointment": "07:00 Appt." });
ok(judge(badDateRow, { "  Payment  ": "$1.00" })?.code === "PERIOD_UNRESOLVED"
  || judge(badDateRow, { "  Payment  ": "$1.00" })?.code === "PERIOD_FINALIZED",
  "a row with an unreadable date cell refuses (UNRESOLVED or FINALIZED, never allow)");
ok(judge(badDateRow, { "  Payment  ": "$1.00" }) !== null,
  "an unreadable date cell is never waved through");

// One unreadable date column is not excused by another that parses — #209's
// partial-resolution regression.
const partialRow = row({ "Assigned Date": "2026-08-03", "Completion Date": "not a date at all" });
ok(judge(partialRow, { "  Payment  ": "$1.00" }) !== null,
  "a parseable Assigned Date does not excuse an unreadable Completion Date");

// --- the guarded/free classification of all 26 production headers ---
const EXPECTED_GUARDED = new Set([
  "Load ID", "Driver", "Pickup Appointment", "Drop-off Appointment", "Job Status",
  "Assigned Date", "Status Update Date", "Completion Date", "  Payment  ",
  "Truck", "Owner ID",
]);
let classOk = true;
const misclassified = [];
for (const h of HEADERS) {
  const isGuarded = G.guardedColumnReason(h) !== null;
  const shouldBe = EXPECTED_GUARDED.has(h);
  if (isGuarded !== shouldBe) { classOk = false; misclassified.push(`${h}: guarded=${isGuarded} expected=${shouldBe}`); }
}
ok(classOk, `all 26 headers classified correctly${misclassified.length ? " — " + misclassified.join("; ") : ""}`);
eq(HEADERS.filter((h) => G.guardedColumnReason(h) !== null).length, 11, "exactly 11 of 26 columns are guarded");

// --- a blank row is judged on its after-state only ---
const blank = new Array(HEADERS.length).fill("");
ok(G.sheetRowIsEmpty(blank), "the blank fixture is recognised as empty");
ok(judge(blank, { "Assigned Date": "2026-08-03", "  Payment  ": "$100.00" }) === null,
  "filling in a blank row into an OPEN month is allowed");
ok(judge(blank, { "Assigned Date": "2026-07-05", "  Payment  ": "$100.00" })?.code === "PERIOD_FINALIZED",
  "filling in a blank row into a LOCKED month is refused");

// --- a short `values` array must not read as blanking the tail ---
const shortAfter = G.sheetRowAfterUpdate(julyRow, ["x", "y"]);
eq(shortAfter.length, julyRow.length, "a short update leaves the row's length intact");
eq(shortAfter[IDX["Payment"]], julyRow[IDX["Payment"]], "a short update leaves the payment cell untouched");

// ---------------------------------------------------------------------------
// Route-level regressions, asserted against server.js SOURCE
// ---------------------------------------------------------------------------
console.log("\nRoute source regressions");

const routeStart = src.indexOf('app.put("/api/load/:loadId"');
ok(routeStart !== -1, "PUT /api/load/:loadId still exists");
const routeEnd = src.indexOf("\n});\n", routeStart);
const routeRaw = src.slice(routeStart, routeEnd);

// ⚠️ Strip comments before asserting on the source. These checks are about what
// the route DOES, and the route now carries a long comment explaining the
// `Job Tracking!A1` header rewrite it used to perform — so a naive substring test
// matches the documentation of the bug and reports the bug as still present.
// Testing the executable text is also the stricter reading: a guard that only
// exists in a comment should fail.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*\/\//.test(l))
  .join("\n");
const route = stripComments(routeRaw);
ok(route.length < routeRaw.length, "the route carries explanatory comments (stripped before source assertions)");

// The header-row door is gone.
ok(!/Job Tracking!A1/.test(route), "the route no longer writes Job Tracking!A1 (the header row)");
ok(!/headers\.push/.test(route), "the route no longer pushes new columns onto the header array");
ok(/UNKNOWN_COLUMN/.test(route), "the route refuses unknown body keys with UNKNOWN_COLUMN");

// The three guards it was missing.
ok(/sheetRowUpdateBlocker\(/.test(route), "the route calls sheetRowUpdateBlocker()");
ok(/validateOwnerIdCell\(/.test(route), "the route calls validateOwnerIdCell()");
ok(/logAudit\(/.test(route), "the route calls logAudit()");
ok((route.match(/logAudit\(/g) || []).length >= 4, "refusals are audited too, not just successes");
ok(/update_sheet_row_blocked/.test(route), "refusals log update_sheet_row_blocked");
ok(/update_sheet_row_failed/.test(route), "a failed write is audited");

// Ambiguity and collisions.
ok(/AMBIGUOUS_LOAD/.test(route), "the route refuses an ambiguous load id");
ok(/DUPLICATE_LOAD/.test(route), "the route refuses a Load ID collision");
ok(/SHEET_CHANGED/.test(route), "the route re-reads before writing (TOCTOU)");
ok(/ROW_READ_FAILED/.test(route), "the route fails closed on an unreadable row");

// The prototype-shadowing fix.
ok(/Object\.prototype\.hasOwnProperty\.call\(updates/.test(route),
  "the route uses Object.prototype.hasOwnProperty.call, not updates.hasOwnProperty");
ok(!/updates\.hasOwnProperty\(/.test(route), "the shadowable updates.hasOwnProperty() call is gone");

// The whole point of Part 2: no bare fromCharCode builds a sheet range anywhere.
const rangeCharCode = [...src.matchAll(/range:[^\n]*String\.fromCharCode\(65/g)];
eq(rangeCharCode.length, 0, "no A1 range in server.js is built with String.fromCharCode(65 + …)");

// And the caller that would have detonated it no longer writes the sheet.
const script = fs.readFileSync(GEOCODE, "utf8");
ok(!/method:\s*"PUT"/.test(script), "scripts/geocode-loads.js no longer PUTs to the sheet");
ok(!/Origin Lat"\]\s*=/.test(script), "scripts/geocode-loads.js no longer invents Origin Lat");
ok(/api\/geocode\/load\//.test(script), "scripts/geocode-loads.js uses the load_coordinates endpoint");

// ---------------------------------------------------------------------------
// The trap, reproduced offline
//
// The live reproduction — pointing the BASE server at a sheet and letting it
// rewrite row 1 — is deliberately NOT run: the only safe sheet copy is shared
// with other test runs, and widening Job Tracking from 26 to 30 columns would
// break every one of them. (That is the blast radius, demonstrated.) So the old
// branch is replayed here against the real header array instead.
// ---------------------------------------------------------------------------
console.log("\nThe trap (offline replay of the old new-column branch)");

// Exactly what scripts/geocode-loads.js used to send.
const GEOCODE_KEYS = ["Origin Lat", "Origin Lng", "Dest Lat", "Dest Lng"];
const unknown = GEOCODE_KEYS.filter((k) => !HEADERS.includes(k));
eq(unknown.length, 4, "all four geocode keys are unknown columns on the real header row");

// The old branch: `headers.push(...newCols)` then write [headers] to A1.
const widened = [...HEADERS, ...unknown];
eq(widened.length, 30, "the old branch would have written a 30-column header row");
ok(widened.length > HEADERS.length, "…i.e. it rewrote row 1, the header row");

// Which is precisely where the old A1 helper stopped producing letters.
const newColIdxs = widened.map((h, i) => (unknown.includes(h) ? i : -1)).filter((i) => i >= 0);
eq(newColIdxs, [26, 27, 28, 29], "the four new columns land at indices 26-29");
eq(newColIdxs.map(broken), ["[", "\\", "]", "^"], "the OLD expression yields punctuation for all four");
eq(newColIdxs.map(G.colLetter), ["AA", "AB", "AC", "AD"], "colLetter yields valid A1 columns for all four");
ok(newColIdxs.every((i) => !/^[A-Z]+$/.test(broken(i))), "every new column produced an INVALID A1 range under the old code");

// And the third consequence: the new headers capture geofencing's own regexes,
// which PREFER sheet columns over the load_coordinates table. Regexes are read
// out of server.js source so this cannot drift from the shipped function.
const geoFn = extractFunction("resolveGeofencePoints");
const geoRes = [...geoFn.matchAll(/col\((\/[^\n]+?\/i)\)/g)].map((m) => m[1]);
ok(geoRes.length === 4, `resolveGeofencePoints resolves 4 coordinate columns (found ${geoRes.length})`);
const captured = unknown.filter((h) => geoRes.some((r) => {
  const body = r.slice(1, r.lastIndexOf("/"));
  return new RegExp(body, "i").test(h);
}));
eq(captured.sort(), ["Dest Lat", "Dest Lng", "Origin Lat", "Origin Lng"],
  "all four new headers are captured by resolveGeofencePoints' own regexes");
ok(/loadData\[oLatCol\]/.test(geoFn) && /getLoadCoordsRow/.test(geoFn),
  "resolveGeofencePoints reads the SHEET columns first and only then falls back to load_coordinates");

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
