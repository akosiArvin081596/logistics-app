#!/usr/bin/env node
/**
 * Tests for the two date-resolution defects fixed alongside PR #215's shared
 * moneySheetDate():
 *
 *   1. GET /api/compliance/ifta/state-detail carried its OWN sheetToIso() —
 *      US-M/D/Y only, no ISO branch at all — and dropped every row it could not
 *      read under a bare `if (!sIso) continue`. 171 of 267 eligible production
 *      rows (64.0%).
 *
 *   2. The `Drop-off Appointment` end of the active-day window was resolved with
 *      the strict parser and NO fallback, while the pickup end reached the full
 *      shared resolver. An unreadable drop-off silently collapsed the window to a
 *      single day. At loadWindowDays() that backs every period-lock guard, so the
 *      guard could conclude a row touches fewer months than it does — failing
 *      OPEN.
 *
 * WHY IT LOADS THE FUNCTIONS OUT OF server.js SOURCE INSTEAD OF require()-ing IT:
 * same reason as scripts/test-money-date.js — server.js opens SQLite, reads a
 * service-account key and starts listening on import, so it cannot be required.
 * Extracting the text keeps this honest in the way that matters: it exercises THE
 * CODE THAT SHIPS. Each extraction asserts it found exactly one definition, so a
 * rename or a duplicate fails loudly rather than silently testing nothing.
 *
 * THE TESTS DISCRIMINATE. Section 5 rebuilds the PRE-FIX version of each function
 * by substituting the old expression back in, re-runs the identical assertions
 * against it, and REQUIRES a specific set of them to fail. A test that passes
 * against both the old and new code proves nothing; this run fails if the
 * discrimination itself ever stops working.
 *
 * Run: node scripts/test-date-resolvers.js
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");

// The TZ-invariance children require() this file, which re-runs everything. They
// only need `probe`, so keep their stdout clean for the parent's comparison.
if (process.env.TZ_CHILD) console.log = () => {};

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label) {
	if (cond) { pass++; return true; }
	fail++; failures.push(label);
	console.log("  FAIL " + label);
	return false;
}
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	return ok(a === e, `${label} — expected ${e}, got ${a}`);
}

// ---------------------------------------------------------------- extraction
function braceMatch(start) {
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error("unbalanced braces from offset " + start);
}
function extractFn(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}(), found ${hits}`);
	return braceMatch(SRC.indexOf(needle) + 1);
}
// The IFTA helper is a const arrow inside the route handler.
function extractIftaSheetToIso() {
	const needle = "const sheetToIso = (val) => {";
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 IFTA sheetToIso, found ${hits}`);
	return braceMatch(SRC.indexOf(needle));
}

const RFC2822_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DEPS = [
	extractFn("moneySheetDate"),
	extractFn("jtParseSheetDate"),
	extractFn("jtFmtDate"),
	extractFn("jtExpandDateRange"),
].join("\n");

function build(windowSrc, iftaSrc) {
	return new Function("RFC2822_MONTHS",
		`${DEPS}\n${windowSrc}\n${iftaSrc}\nreturn { loadWindowDays, sheetToIso, moneySheetDate, jtParseSheetDate };`
	)(RFC2822_MONTHS);
}

const WINDOW_SRC = extractFn("loadWindowDays");
const IFTA_SRC = extractIftaSheetToIso();
const NEW = build(WINDOW_SRC, IFTA_SRC);

// The column map loadWindowDays is called with (jobTrackingMonthCols' shape).
const COLS = {
	dateCol: "Assigned Date",
	pickupDateCol: "Pickup Appointment",
	dropoffDateCol: "Drop-off Appointment",
};
const row = (pickup, dropoff, assigned) => ({
	"Pickup Appointment": pickup === undefined ? "" : pickup,
	"Drop-off Appointment": dropoff === undefined ? "" : dropoff,
	"Assigned Date": assigned === undefined ? "" : assigned,
});

// ------------------------------------------------------- 1. structural checks
console.log("\n1. structural — the local parsers are gone, the shared one is used");

ok(!/\nfunction sheetToIso\s*\(/.test(SRC),
	"no `function sheetToIso(` local parser survives in server.js");
ok(/const sheetToIso = \(val\) => \{[\s\S]{0,200}?moneySheetDate\(val\)/.test(SRC),
	"the IFTA sheetToIso delegates to moneySheetDate()");
ok(!/sheetToIso[\s\S]{0,300}?\\d\{1,2\}\)\[\/-\]/.test(IFTA_SRC),
	"the IFTA helper carries no date regex of its own");

// All four drop-off reads must go through the shared resolver.
const dropReads = [...SRC.matchAll(/const dropoff = (\w+)\(/g)].map((m) => m[1]);
eq(dropReads.length, 4, "exactly 4 `const dropoff = …(` sites exist");
eq([...new Set(dropReads)], ["moneySheetDate"],
	"every drop-off read resolves via moneySheetDate()");
ok(!/const dropoff = (jtP|p)arseSheetDate\(/.test(SRC),
	"no drop-off read still uses the strict parser");

// The three active-day sites must keep the pickup fallback beside it.
eq((SRC.match(/if \(!pickup && jtDateCol && r\[jtDateCol\]\) pickup = moneySheetDate\(r\[jtDateCol\]\);/g) || []).length, 3,
	"all 3 active-day sites keep the shared pickup fallback");

// -------------------------------------------------- 2. loadWindowDays (guard)
console.log("\n2. loadWindowDays — the window the period-lock guard reasons over");

// THE BUG. NOTE the pre-fix drop-off parser (jtParseSheetDate) DID read ISO and
// US M/D/Y — unlike the IFTA parser in section 4, which had no ISO branch at all.
// The shapes it missed are RFC 2822 and everything else `new Date()` can read, so
// those are the only honest discriminators here.
eq(NEW.loadWindowDays(row("9/23/2025", "Date: Wed, 24 Sep 2025 23:59:00 -0500"), COLS),
	["2025-09-23", "2025-09-24"], "RFC 2822 drop-off widens the window");
eq(NEW.loadWindowDays(row("9/23/2025", "25 Sep 2025"), COLS),
	["2025-09-23", "2025-09-24", "2025-09-25"], "bare RFC 2822 date widens the window");
// The exact production cell (load 529227269).
eq(NEW.loadWindowDays(row("9/22/2025", "2025/09/24 23:59"), COLS),
	["2025-09-22", "2025-09-23", "2025-09-24"], "production cell '2025/09/24 23:59' widens the window");
// THE GUARD PROPERTY: a drop-off the strict parser could not read used to hide a
// whole second month from the period-lock guard.
eq([...new Set(NEW.loadWindowDays(row("9/30/2025", "Date: Thu, 2 Oct 2025 12:00:00 -0500"), COLS).map((d) => d.slice(0, 7)))],
	["2025-09", "2025-10"], "a month-straddling RFC 2822 drop-off yields BOTH months to the guard");

console.log("\n   controls — these must behave identically before and after");
eq(NEW.loadWindowDays(row("9/23/2025", "9/25/2025"), COLS),
	["2025-09-23", "2025-09-24", "2025-09-25"], "US-slash drop-off unchanged");
eq(NEW.loadWindowDays(row("9/23/2025", "2025-09-25"), COLS),
	["2025-09-23", "2025-09-24", "2025-09-25"], "ISO drop-off unchanged (the strict parser already read it)");
eq([...new Set(NEW.loadWindowDays(row("9/30/2025", "2025-10-02"), COLS).map((d) => d.slice(0, 7)))],
	["2025-09", "2025-10"], "an ISO month-straddling drop-off was already two months");
eq(NEW.loadWindowDays(row("9/23/2025", ""), COLS), ["2025-09-23"], "blank drop-off stays 1 day");
eq(NEW.loadWindowDays(row("9/23/2025", "9:00"), COLS), ["2025-09-23"],
	"a TIME-only drop-off ('9:00') is still refused — no invented day");
eq(NEW.loadWindowDays(row("9/23/2025", "9/20/2025"), COLS), ["2025-09-23"],
	"drop-off earlier than pickup still yields 1 day");
eq(NEW.loadWindowDays(row("", "", ""), COLS), [], "no dates at all still yields no window (guard refuses)");
eq(NEW.loadWindowDays(row("", "9/25/2025", "9/23/2025"), COLS),
	["2025-09-23", "2025-09-24", "2025-09-25"], "blank pickup still falls back to the assigned date");
// The 31-day runaway clamp still bounds a garbage far-future drop-off.
ok(NEW.loadWindowDays(row("9/23/2025", "2027-01-01"), COLS).length === 32,
	"a far-future drop-off is still clamped by MAX_SPAN (32 entries)");

// ------------------------------------------------- 3. monotonicity (the property)
console.log("\n3. property — widening the drop-off can only ever ADD days");
const OLD_WINDOW_SRC = WINDOW_SRC.replace(
	"const dropoff = moneySheetDate(",
	"const dropoff = jtParseSheetDate("
);
ok(OLD_WINDOW_SRC !== WINDOW_SRC, "the pre-fix loadWindowDays could be reconstructed");
const OLD = build(OLD_WINDOW_SRC, IFTA_SRC);

const DROP_SHAPES = [
	"", "9/25/2025", "09/25/2025", "9/25/25", "2025-09-25", "2025/09/25 23:59",
	"Date: Thu, 25 Sep 2025 23:59:00 -0500", "25 Sep 2025", "9:00", "23:59", "TBD",
	"9/20/2025", "2025-09-23", "2027-01-01", "1400", "ASAP",
];
let monotone = true, widened = 0;
for (const shape of DROP_SHAPES) {
	const before = OLD.loadWindowDays(row("9/23/2025", shape), COLS);
	const after = NEW.loadWindowDays(row("9/23/2025", shape), COLS);
	const lost = before.filter((d) => !after.includes(d));
	if (lost.length) { monotone = false; console.log(`    ${JSON.stringify(shape)} LOST ${JSON.stringify(lost)}`); }
	if (after.length > before.length) widened++;
}
ok(monotone, "no drop-off shape ever LOSES a day (guard can only get stricter)");
// Exactly 3 of the corpus widen: the two RFC 2822 forms and "2025/09/25 23:59".
// ISO and US M/D/Y were already read by the strict parser; "9:00"/"23:59"/"TBD"/
// "ASAP" stay unresolved; "9/20/2025", "2025-09-23", "1400" resolve BEFORE the
// pickup and so still yield the 1-day window.
eq(widened, 3, "exactly 3 corpus shapes widen");

// ---------------------------------------------------------- 4. IFTA sheetToIso
console.log("\n4. IFTA sheetToIso — 64% of production rows were dropped here");

eq(NEW.sheetToIso("2025-09-24"), "2025-09-24", "ISO now resolves (was dropped)");
eq(NEW.sheetToIso("Date: Tue, 13 May 2025 11:56:47 -0500"), "2025-05-13",
	"RFC 2822 now resolves, read LITERALLY (was dropped)");
eq(NEW.sheetToIso("Date: Wed, 31 Dec 2025 20:00:00 -0600"), "2025-12-31",
	"a late-December RFC 2822 stamp keeps its own YEAR");

console.log("\n   controls — the shapes it already read must not move");
eq(NEW.sheetToIso("9/24/2025"), "2025-09-24", "US M/D/Y unchanged");
eq(NEW.sheetToIso("09/24/2025"), "2025-09-24", "zero-padded US M/D/Y unchanged");
eq(NEW.sheetToIso("9-24-2025"), "2025-09-24", "dash-separated US M/D/Y unchanged");
eq(NEW.sheetToIso("5/16/25"), "2025-05-16", "2-digit year still maps to 20xx");
eq(NEW.sheetToIso(""), null, "empty stays null");
eq(NEW.sheetToIso(null), null, "null stays null");
eq(NEW.sheetToIso("9:00"), null, "a time-only cell is still refused");

// ------------------------------------------------------ 5. DISCRIMINATION GATE
console.log("\n5. discrimination — the pre-fix code MUST fail these");

const OLD_IFTA_SRC = `const sheetToIso = (val) => {
	if (!val) return null;
	const m = String(val).match(/^(\\d{1,2})[/-](\\d{1,2})[/-](\\d{2,4})/);
	if (!m) return null;
	let yr = parseInt(m[3], 10);
	if (yr < 100) yr += 2000;
	return \`\${yr}-\${String(m[1]).padStart(2, "0")}-\${String(m[2]).padStart(2, "0")}\`;
};`;
const OLD_ALL = build(OLD_WINDOW_SRC, OLD_IFTA_SRC);

const DISCRIMINATORS = [
	["window/RFC2822", () => JSON.stringify(OLD_ALL.loadWindowDays(row("9/23/2025", "Date: Wed, 24 Sep 2025 23:59:00 -0500"), COLS)), '["2025-09-23","2025-09-24"]'],
	["window/RFC2822-bare", () => JSON.stringify(OLD_ALL.loadWindowDays(row("9/23/2025", "25 Sep 2025"), COLS)), '["2025-09-23","2025-09-24","2025-09-25"]'],
	["window/prod-cell", () => JSON.stringify(OLD_ALL.loadWindowDays(row("9/22/2025", "2025/09/24 23:59"), COLS)), '["2025-09-22","2025-09-23","2025-09-24"]'],
	["window/two-months-RFC", () => JSON.stringify([...new Set(OLD_ALL.loadWindowDays(row("9/30/2025", "Date: Thu, 2 Oct 2025 12:00:00 -0500"), COLS).map((d) => d.slice(0, 7)))]), '["2025-09","2025-10"]'],
	["ifta/ISO", () => JSON.stringify(OLD_ALL.sheetToIso("2025-09-24")), '"2025-09-24"'],
	["ifta/RFC2822", () => JSON.stringify(OLD_ALL.sheetToIso("Date: Tue, 13 May 2025 11:56:47 -0500")), '"2025-05-13"'],
];
let flipped = 0;
for (const [label, fn, expected] of DISCRIMINATORS) {
	const got = fn();
	if (got !== expected) { flipped++; console.log(`    pre-fix FAILS ${label}: got ${got}`); }
	else console.log(`    !! pre-fix PASSES ${label} — this assertion does not discriminate`);
}
eq(flipped, DISCRIMINATORS.length, `all ${DISCRIMINATORS.length} discriminators fail against pre-fix code`);

const CONTROLS = [
	["window/US-slash", () => JSON.stringify(OLD_ALL.loadWindowDays(row("9/23/2025", "9/25/2025"), COLS)), '["2025-09-23","2025-09-24","2025-09-25"]'],
	// ISO is a CONTROL for the window (the strict parser read it) but a
	// DISCRIMINATOR for IFTA (whose parser had no ISO branch). That asymmetry is
	// the difference between the two bugs, asserted rather than described.
	["window/ISO", () => JSON.stringify(OLD_ALL.loadWindowDays(row("9/23/2025", "2025-09-25"), COLS)), '["2025-09-23","2025-09-24","2025-09-25"]'],
	["window/blank", () => JSON.stringify(OLD_ALL.loadWindowDays(row("9/23/2025", ""), COLS)), '["2025-09-23"]'],
	["window/time-only", () => JSON.stringify(OLD_ALL.loadWindowDays(row("9/23/2025", "9:00"), COLS)), '["2025-09-23"]'],
	["ifta/US-slash", () => JSON.stringify(OLD_ALL.sheetToIso("9/24/2025")), '"2025-09-24"'],
	["ifta/2-digit-year", () => JSON.stringify(OLD_ALL.sheetToIso("5/16/25")), '"2025-05-16"'],
];
let controlsHeld = 0;
for (const [label, fn, expected] of CONTROLS) {
	if (fn() === expected) controlsHeld++;
	else console.log(`    control MOVED under pre-fix: ${label}`);
}
eq(controlsHeld, CONTROLS.length, `all ${CONTROLS.length} controls pass on BOTH old and new (so the suite is not just failing everything)`);

// ------------------------------------------------------- 6. timezone invariance
if (!process.env.TZ_CHILD) {
	console.log("\n6. timezone invariance — same verdicts under UTC / Chicago / Kolkata");
	const probe = [
		"2025-09-24", "Date: Tue, 13 May 2025 11:56:47 -0500",
		"Date: Wed, 31 Dec 2025 20:00:00 -0600", "9/24/2025", "2025/09/24 23:59", "9:00",
	];
	// process.stdout.write, NOT console.log — the child suppresses console.log to
	// keep this file's own output out of the comparison, and a suppressed probe
	// would make all three children emit "" and pass this assertion trivially.
	const script = `
		const t = require(${JSON.stringify(__filename)});
		process.stdout.write(JSON.stringify(${JSON.stringify(probe)}.map(t.probe)));
	`;
	const outs = ["UTC", "America/Chicago", "Asia/Kolkata"].map((tz) =>
		execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz, TZ_CHILD: "1" } }).toString().trim()
	);
	ok(outs[0].length > 50, `the TZ probe actually produced output (${outs[0].length} bytes)`);
	ok(outs[0] === outs[1] && outs[1] === outs[2], "resolution is timezone-independent");
	console.log("   " + outs[0].slice(0, 160) + (outs[0].length > 160 ? " …" : ""));
}
module.exports.probe = (v) => [NEW.sheetToIso(v), NEW.loadWindowDays(row("9/23/2025", v), COLS)];

if (!process.env.TZ_CHILD) {
	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
}
