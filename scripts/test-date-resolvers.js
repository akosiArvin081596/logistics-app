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
 *   3. THE PICKUP END, which #237 reported and deliberately left. Its primary read
 *      was the strict parser too, and its `null` is indistinguishable from a blank
 *      cell — so a present-but-unreadable pickup fell through to the ASSIGNED date,
 *      contradicting that fallback's own comment ("when blank").
 *
 *      Unlike the drop-off it is NOT strictly widening, which is why it is fixed
 *      DIFFERENTLY on the two sides and why sections 7-9 exist:
 *        • the three MONEY sites take the true pickup (a SHIFT — the window can
 *          lose a day), because that is the day the driver worked and it is what
 *          POST /api/invoices/generate already reads;
 *        • loadWindowDays(), which backs every period-lock guard, takes the UNION
 *          of the old and new readings, so the guard's window can only ever GROW
 *          and its `resolved:false` refusal condition is byte-identical.
 *      Substituting at the guard instead of unioning would flip resolved:false ->
 *      resolved:true — a change to a REFUSAL DEFAULT. Section 9 builds exactly that
 *      naive variant and asserts it flips, so the choice is enforced, not described.
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
// The body opens at the first `{` AFTER the parameter list, not the first `{`
// after the name. server.js has functions that DESTRUCTURE their parameter
// (excludedDayPeriods({ driver, date, ... })), and a scan from the name closes on
// the parameter object and silently returns the signature as if it were the whole
// function — which compiles to nothing useful and tests nothing.
function bodyStart(afterName) {
	let depth = 0;
	for (let j = afterName; j < SRC.length; j++) {
		if (SRC[j] === "(") depth++;
		else if (SRC[j] === ")") { depth--; if (depth === 0) return SRC.indexOf("{", j); }
	}
	throw new Error("unbalanced parens from offset " + afterName);
}
function braceMatch(start, from) {
	let depth = 0;
	for (let j = from === undefined ? SRC.indexOf("{", start) : from; j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error("unbalanced braces from offset " + start);
}
function extractFn(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}(), found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	return braceMatch(start, bodyStart(start + `function ${name}`.length));
}
// Pull one statement out of server.js verbatim, asserting how many times it
// occurs. This is how the money sites are tested: they are three inline
// expressions inside 18k lines of handler, not a function, so the only honest way
// to exercise "the code that ships" is to lift the exact statements and run them.
function extractStmt(re, expectedHits, label) {
	const hits = SRC.match(re) || [];
	if (hits.length !== expectedHits) throw new Error(`expected ${expectedHits} × ${label}, found ${hits.length}`);
	const uniq = [...new Set(hits)];
	if (uniq.length !== 1) throw new Error(`${label} is not identical at all sites: ${JSON.stringify(uniq)}`);
	return uniq[0];
}
// The IFTA helper is a const arrow inside the route handler.
function extractIftaSheetToIso() {
	const needle = "const sheetToIso = (val) => {";
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 IFTA sheetToIso, found ${hits}`);
	return braceMatch(SRC.indexOf(needle));
}

// A module-scope `const NAME = …;` one-liner, lifted verbatim. Same
// exactly-one-definition assertion as extractFn, for the same reason.
function extractConst(name) {
	const hits = SRC.match(new RegExp(`\\nconst ${name} = [^\\n]*;`, "g")) || [];
	if (hits.length !== 1) throw new Error(`expected exactly 1 const ${name}, found ${hits.length}`);
	return hits[0].trim();
}

const RFC2822_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DEPS = [
	extractFn("moneySheetDate"),
	extractFn("jtParseSheetDate"),
	extractFn("jtFmtDate"),
	extractFn("jtExpandDateRange"),
].join("\n");

// loadAssignedMonthKey() and loadRowPeriods() now share LOCKABLE_MONTH_KEY (the
// L-2 bound, section 11), so every builder that extracts the pair has to carry
// the constant too — otherwise the extraction throws a ReferenceError at call
// time and the section it feeds silently tests nothing.
const MONTH_KEY_CONST = extractConst("LOCKABLE_MONTH_KEY");
const PERIOD_FNS = `${MONTH_KEY_CONST}\n${extractFn("loadAssignedMonthKey")}\n${extractFn("loadRowPeriods")}`;

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

// ============================================================================
// THE PICKUP END (#237 reported it and left it — this is the other half)
// ============================================================================

// ------------------------------------ 6. structural — the money sites and only them
console.log("\n6. structural — the pickup end reads the shared resolver at the 3 MONEY sites");

const PICKUP_STMT = extractStmt(/let pickup = \w+\(pickupDateCol \? r\[pickupDateCol\] : null\);/g, 3, "money-site pickup read");
const MONEY_DROP_STMT = extractStmt(/const dropoff = \w+\(dropoffDateCol \? r\[dropoffDateCol\] : null\);/g, 3, "money-site drop-off read");
const MONEY_FALLBACK_STMT = extractStmt(/if \(!pickup && jtDateCol && r\[jtDateCol\]\) pickup = \w+\(r\[jtDateCol\]\);/g, 3, "money-site assigned-date fallback");

ok(/let pickup = moneySheetDate\(/.test(PICKUP_STMT), "all 3 money sites read the pickup via moneySheetDate()");
ok(!/let pickup = parseSheetDate\(/.test(SRC), "no money site still reads the pickup with the local strict parser");
ok(!/const parseSheetDate = \(val\) => \{/.test(SRC),
	"computeInvestorMonthlyEarnings' local parseSheetDate copy is DELETED, not merely unused");
// One local copy survives, deliberately and out of scope: GET /api/investor/load-report
// buckets by the ASSIGNED date with it, which is a separate defect of the same class
// (it drops RFC 2822 rows). Pinning the count here is what stops it silently becoming
// two again.
const localParsers = (SRC.match(/\n\t*function parseSheetDate\(val\) \{/g) || []).length;
eq(localParsers, 1, "exactly 1 local parseSheetDate survives (GET /api/investor/load-report, reported not fixed)");
ok(/app\.get\("\/api\/investor\/load-report"[\s\S]{0,4000}?function parseSheetDate\(val\) \{/.test(SRC),
	"…and the survivor is inside /api/investor/load-report, not a money site");

// The guard keeps its narrow read AND gains the wide one — union, not substitution.
ok(/let pickup = jtParseSheetDate\(cols\.pickupDateCol \? row\[cols\.pickupDateCol\] : null\);/.test(WINDOW_SRC),
	"loadWindowDays KEEPS the narrow strict pickup read (the refusal condition depends on it)");
ok(/const pickupShared = moneySheetDate\(cols\.pickupDateCol \? row\[cols\.pickupDateCol\] : null\);/.test(WINDOW_SRC),
	"loadWindowDays ADDS the shared-resolver pickup read beside it");
ok(/if \(!pickup \|\| isNaN\(pickup\)\) return \[\];/.test(WINDOW_SRC),
	"loadWindowDays' `return []` refusal line is untouched");

// ------------------------------ 7. the money sites' pickup semantics (the SHIFT)
console.log("\n7. money sites — the pickup SHIFT (driver pay, i.e. the settlement)");

// Built from the three statements lifted verbatim above, in the shipped order.
function buildMoneyWindow(pickupStmt) {
	return new Function("RFC2822_MONTHS", `
		${extractFn("moneySheetDate")}
		${extractFn("jtParseSheetDate")}
		${extractFn("jtFmtDate")}
		const parseSheetDate = jtParseSheetDate; // the local copy, byte-identical
		return function (r, pickupDateCol, dropoffDateCol, jtDateCol) {
			${pickupStmt}
			${MONEY_DROP_STMT}
			${MONEY_FALLBACK_STMT}
			return { pickup: pickup && !isNaN(pickup) ? jtFmtDate(pickup) : null,
			         dropoff: dropoff && !isNaN(dropoff) ? jtFmtDate(dropoff) : null };
		};`)(RFC2822_MONTHS);
}
const MONEY_NEW = buildMoneyWindow(PICKUP_STMT);
const mrow = (pickup, dropoff, assigned) => ({ P: pickup, D: dropoff, A: assigned });
const moneyRead = (fn, p, d, a) => fn(mrow(p, d, a), "P", "D", "A");

// THE PRODUCTION ROW. Load 529227269: the pickup cell is unreadable by the strict
// parser, so pay used to start the window at the ASSIGNED date (2025-09-22, when the
// rate-con email landed) instead of at the pickup (2025-09-23).
eq(moneyRead(MONEY_NEW, "2025/09/23 23:59", "2025/09/24 23:59", "Date: Mon, 22 Sep 2025 08:45:51 -0500").pickup,
	"2025-09-23", "production row 529227269 now starts its pay window at the PICKUP, not the assigned date");
eq(moneyRead(MONEY_NEW, "Date: 9/23/2025", "", "9/20/2025").pickup, "2025-09-23",
	"a 'Date:'-prefixed pickup resolves instead of falling through to the assigned date");

console.log("\n   controls — the fallback must still fire where it is supposed to");
eq(moneyRead(MONEY_NEW, "", "", "9/20/2025").pickup, "2025-09-20", "BLANK pickup still falls back to the assigned date");
eq(moneyRead(MONEY_NEW, "14:00", "", "6/23/2026, 7:11:25 PM").pickup, "2026-06-23",
	"production row 557861739's time-only pickup ('14:00') STILL falls back — a time is not a date");
eq(moneyRead(MONEY_NEW, "07:00 Appt.", "", "9/20/2025").pickup, "2025-09-20",
	"'07:00 Appt.' (raw sheet, row #522314810) still falls back");
eq(moneyRead(MONEY_NEW, "9/23/2025", "", "9/20/2025").pickup, "2025-09-23", "US-slash pickup unchanged");
eq(moneyRead(MONEY_NEW, "2025-09-23", "", "9/20/2025").pickup, "2025-09-23", "ISO pickup unchanged");
eq(moneyRead(MONEY_NEW, "9/23/25 06:00-18:00 Appt.", "", "9/20/2025").pickup, "2025-09-23",
	"the common 'M/D/YY window Appt.' shape unchanged");
eq(moneyRead(MONEY_NEW, "", "", "").pickup, null, "no pickup and no assigned date still yields nothing");

// ------------------- 8. the guard's window — UNION, and the refusal default holds
console.log("\n8. loadWindowDays — union widens, and NEVER flips the refusal");

const PERIODS = new Function("RFC2822_MONTHS",
	`${DEPS}\n${WINDOW_SRC}\n${PERIOD_FNS}\nreturn { loadRowPeriods, loadWindowDays };`
)(RFC2822_MONTHS);

// The production row, through the GUARD: it keeps 09-22 (the assigned-date reading)
// AND gains 09-23/09-24, so the guard still answers for every month either basis
// could book the load into.
eq(NEW.loadWindowDays(row("2025/09/23 23:59", "2025/09/24 23:59", "Date: Mon, 22 Sep 2025 08:45:51 -0500"), COLS),
	["2025-09-22", "2025-09-23", "2025-09-24"],
	"guard window is the UNION of the assigned-date reading and the true pickup");
// A union that crosses a month boundary must show BOTH months to the guard.
eq([...new Set(NEW.loadWindowDays(row("2025/10/01 08:00", "", "Date: Tue, 30 Sep 2025 08:45:51 -0500"), COLS).map((d) => d.slice(0, 7)))],
	["2025-09", "2025-10"], "a pickup that shifts across a month boundary yields BOTH months to the guard");

console.log("\n   ⚠️ the refusal default — fail-CLOSED must survive the widening");
// The only way to reach loadRowPeriods' window path is an unreadable assigned date.
// With one, an unreadable-by-strict-but-readable-by-shared pickup MUST still refuse.
const UNRESOLVABLE = row("2025/09/23 23:59", "2025/09/24 23:59", "TBD");
eq(NEW.loadWindowDays(UNRESOLVABLE, COLS), [], "unreadable assigned date + widened pickup STILL returns no window");
eq(PERIODS.loadRowPeriods(UNRESOLVABLE, COLS), { periods: [], resolved: false },
	"…so loadRowPeriods still answers resolved:FALSE — the guard refuses, as before");
eq(PERIODS.loadRowPeriods(row("", "", "TBD"), COLS), { periods: [], resolved: false },
	"a row with nothing readable still refuses");
eq(PERIODS.loadRowPeriods(row("9/23/2025", "9/25/2025", "TBD"), COLS),
	{ periods: ["2025-09"], resolved: true }, "a readable strict pickup still resolves via the window path");
eq(PERIODS.loadRowPeriods(row("2025/09/23 23:59", "", "9/20/2025"), COLS),
	{ periods: ["2025-09"], resolved: true }, "a readable assigned date still short-circuits to its own month");

console.log("\n   monotonicity — the guard's window can only ever GROW");
const PICKUP_SHAPES = [
	"", "9/23/2025", "09/23/2025", "9/23/25", "2025-09-23", "2025/09/23 23:59",
	"Date: Tue, 23 Sep 2025 08:00:00 -0500", "23 Sep 2025", "9:00", "14:00", "07:00 Appt.",
	"TBD", "ASAP", "9/23/25 06:00-18:00 Appt.", "2027-01-01", "1400",
];
const OLD_WINDOW_PICKUP_SRC = WINDOW_SRC
	.replace(/\n\tconst pickupShared = moneySheetDate\(cols\.pickupDateCol \? row\[cols\.pickupDateCol\] : null\);/, "")
	.replace(/\tconst days = jtExpandDateRange\(pickup, dropoff \|\| pickup\);\n[\s\S]*?\treturn \[\.\.\.new Set\(days\.concat\(jtExpandDateRange\(pickupShared, dropoff \|\| pickupShared\)\)\)\]\.sort\(\);/,
		"\treturn jtExpandDateRange(pickup, dropoff || pickup);");
ok(!/pickupShared/.test(OLD_WINDOW_PICKUP_SRC), "the pre-union loadWindowDays could be reconstructed");
const PRE_UNION = build(OLD_WINDOW_PICKUP_SRC, IFTA_SRC);

let unionMonotone = true, unionWidened = 0, resolvedStable = true;
const PRE_UNION_PERIODS = new Function("RFC2822_MONTHS",
	`${DEPS}\n${OLD_WINDOW_PICKUP_SRC}\n${PERIOD_FNS}\nreturn { loadRowPeriods };`
)(RFC2822_MONTHS);
for (const shape of PICKUP_SHAPES) {
	for (const assigned of ["9/20/2025", "Date: Mon, 22 Sep 2025 08:45:51 -0500", "TBD", ""]) {
		const r = row(shape, "9/25/2025", assigned);
		const before = PRE_UNION.loadWindowDays(r, COLS), after = NEW.loadWindowDays(r, COLS);
		const lost = before.filter((d) => !after.includes(d));
		if (lost.length) { unionMonotone = false; console.log(`    ${JSON.stringify([shape, assigned])} LOST ${JSON.stringify(lost)}`); }
		if (after.length > before.length) unionWidened++;
		if (PRE_UNION_PERIODS.loadRowPeriods(r, COLS).resolved !== PERIODS.loadRowPeriods(r, COLS).resolved) {
			resolvedStable = false; console.log(`    ${JSON.stringify([shape, assigned])} FLIPPED resolved`);
		}
	}
}
ok(unionMonotone, "no pickup shape ever LOSES a day from the guard's window");
ok(resolvedStable, "⚠️ no pickup shape ever flips loadRowPeriods' `resolved` — the refusal default is unchanged");
ok(unionWidened > 0, `the union does widen where it should (${unionWidened} of ${PICKUP_SHAPES.length * 4} combinations)`);

// -------------------- 9. DISCRIMINATION — pre-fix money, and the NAIVE guard fix
console.log("\n9. discrimination — pre-fix money AND the naive guard fix must both fail");

const OLD_PICKUP_STMT = PICKUP_STMT.replace("moneySheetDate(", "parseSheetDate(");
ok(OLD_PICKUP_STMT !== PICKUP_STMT, "the pre-fix money pickup read could be reconstructed");
const MONEY_OLD = buildMoneyWindow(OLD_PICKUP_STMT);

// The naive fix: substitute at the guard instead of unioning. This is the variant
// #237 declined, and the reason it declined it is asserted here rather than argued.
const NAIVE_WINDOW_SRC = OLD_WINDOW_PICKUP_SRC.replace(
	"let pickup = jtParseSheetDate(", "let pickup = moneySheetDate(");
ok(NAIVE_WINDOW_SRC !== OLD_WINDOW_PICKUP_SRC, "the naive substitute-at-the-guard variant could be built");
const NAIVE = build(NAIVE_WINDOW_SRC, IFTA_SRC);
const NAIVE_PERIODS = new Function("RFC2822_MONTHS",
	`${DEPS}\n${NAIVE_WINDOW_SRC}\n${PERIOD_FNS}\nreturn { loadRowPeriods };`
)(RFC2822_MONTHS);

const PICKUP_DISCRIMINATORS = [
	["money/prod-row-529227269", () => moneyRead(MONEY_OLD, "2025/09/23 23:59", "2025/09/24 23:59", "Date: Mon, 22 Sep 2025 08:45:51 -0500").pickup, "2025-09-23"],
	["money/Date-prefixed", () => moneyRead(MONEY_OLD, "Date: 9/23/2025", "", "9/20/2025").pickup, "2025-09-23"],
	// The guard only DIFFERS where the two readings do not nest. Below, the strict
	// path falls back to a 30 Sep assigned date with a blank drop-off (a 1-day
	// window) while the true pickup is 1 Oct — disjoint, so the union is strictly
	// larger and shows the guard a second month.
	["guard/union-two-months", () => JSON.stringify([...new Set(PRE_UNION.loadWindowDays(row("2025/10/01 08:00", "", "Date: Tue, 30 Sep 2025 08:45:51 -0500"), COLS).map((d) => d.slice(0, 7)))]), '["2025-09","2025-10"]'],
];
let pFlipped = 0;
for (const [label, fn, expected] of PICKUP_DISCRIMINATORS) {
	const got = String(fn());
	if (got !== expected) { pFlipped++; console.log(`    pre-fix FAILS ${label}: got ${got}`); }
	else console.log(`    !! pre-fix PASSES ${label} — this assertion does not discriminate`);
}
eq(pFlipped, PICKUP_DISCRIMINATORS.length, `all ${PICKUP_DISCRIMINATORS.length} pickup discriminators fail against pre-fix code`);

// ⚠️ THE PRODUCTION ROW IS A CONTROL AT THE GUARD, AND THAT IS THE HEADLINE RESULT.
// [09-22..09-24] ∪ [09-23..09-24] = [09-22..09-24]: the true pickup NESTS inside the
// assigned-date window, so the guard's answer is byte-identical before and after.
// This is precisely why replaying all 305 deduplicated production rows measured 0
// window changes, 0 period changes and 0 resolved flips. Stated as an assertion so
// nobody later "strengthens" the guard into the substitution that does move it.
const PICKUP_CONTROLS = [
	["guard/prod-row-nests", () => JSON.stringify(PRE_UNION.loadWindowDays(row("2025/09/23 23:59", "2025/09/24 23:59", "Date: Mon, 22 Sep 2025 08:45:51 -0500"), COLS)), '["2025-09-22","2025-09-23","2025-09-24"]'],
	["guard/blank-pickup", () => JSON.stringify(PRE_UNION.loadWindowDays(row("", "9/25/2025", "9/23/2025"), COLS)), '["2025-09-23","2025-09-24","2025-09-25"]'],
	["guard/time-only-pickup", () => JSON.stringify(PRE_UNION.loadWindowDays(row("14:00", "", "9/23/2025"), COLS)), '["2025-09-23"]'],
	["guard/refuses-unresolvable", () => String(PRE_UNION_PERIODS.loadRowPeriods(UNRESOLVABLE, COLS).resolved), "false"],
	["money/blank-pickup-falls-back", () => moneyRead(MONEY_OLD, "", "", "9/20/2025").pickup, "2025-09-20"],
	["money/time-only-falls-back", () => moneyRead(MONEY_OLD, "14:00", "", "6/23/2026, 7:11:25 PM").pickup, "2026-06-23"],
];
let pControls = 0;
for (const [label, fn, expected] of PICKUP_CONTROLS) {
	if (String(fn()) === expected) pControls++;
	else console.log(`    control MOVED under pre-fix: ${label} -> ${fn()}`);
}
eq(pControls, PICKUP_CONTROLS.length, `all ${PICKUP_CONTROLS.length} pickup controls pass on BOTH old and new`);

console.log("\n   ⚠️ the naive guard fix — it must LOSE a day and FLIP the refusal");
ok(PRE_UNION.loadWindowDays(row("2025/09/23 23:59", "2025/09/24 23:59", "Date: Mon, 22 Sep 2025 08:45:51 -0500"), COLS)
	.includes("2025-09-22")
	&& !NAIVE.loadWindowDays(row("2025/09/23 23:59", "2025/09/24 23:59", "Date: Mon, 22 Sep 2025 08:45:51 -0500"), COLS)
		.includes("2025-09-22"),
	"substituting at the guard LOSES 2025-09-22 on the production row (the union does not)");
eq(NAIVE_PERIODS.loadRowPeriods(UNRESOLVABLE, COLS).resolved, true,
	"substituting at the guard turns the unreadable-assigned-date REFUSAL into a permission");
eq(PERIODS.loadRowPeriods(UNRESOLVABLE, COLS).resolved, false,
	"…while the shipped union keeps refusing it — this pair IS the design decision");

// ============================================================================
//  THE EXCLUDED-DAY GATE — PR #245's M-1 and L-2 (sections 10-11)
// ============================================================================
//
// M-1: excludedDayPeriods()'s tail DISPLACED the day's own month rather than
// adding it — `return months.size ? [...months].sort() : [own];` — so the
// moment any co-covering load existed, `own` dropped out of the answer. A
// covering load in an OPEN month could therefore suppress a LOCKED one and the
// gate would permit a write that restates it. Unlike its sibling guards,
// excludedDayGate() has no `unresolved` rung to catch that.
//
// L-2: loadAssignedMonthKey()/loadRowPeriods() built their month key with
// jtFmtDate(…).slice(0, 7), which is only a month when the year is exactly 4
// digits. lockedAmong()'s /^\d{4}-\d{2}$/ SILENTLY DROPS anything else, so a
// key like "275760-" or "999-01-" left it nothing to match → locked.length 0 →
// PERMIT, while `resolved` still said true so the refusal rung never fired.
//
// Both are fail-OPENs, and both are fixed in the fail-CLOSED direction: M-1 by
// unioning, L-2 by testing every emitted key against lockedAmong()'s OWN regex —
// shared with it, so the two cannot drift — and letting an unmatchable key
// become NO key.
//
// ⚠️ NOT sheetCellMonths' tighter 1970-2999 bound, which #245's L-2 suggested.
// That is itself a fail-open here: period_locks has no CHECK and the finalize
// route admits any /^\d{4}-\d{2}$/, so "1900-05" is lockable, and a stricter
// test would DISCARD it and permit the write. Measured under such a lock: 128
// REFUSE→permit flips versus 0 with the shared predicate. Section 11 pins both
// halves — the implausible-but-lockable months are asserted KEPT.

// The gate's real decision, minus the two DB reads excludedDayGate() makes
// first. isLocked() is the ONLY stub — lockedAmong()'s /^\d{4}-\d{2}$/ filter is
// the shipped one, which is what makes section 11's assertions honest.
const GATE_DEPS = [extractFn("findCol"), extractFn("jobTrackingMonthCols"), extractFn("normalizeDriverName")].join("\n");
const EDP_SRC = extractFn("excludedDayPeriods");
function buildGate(edpSrc, periodFns, lockedList) {
	return new Function("RFC2822_MONTHS", "LOCKED", `
		${DEPS}
		${GATE_DEPS}
		${WINDOW_SRC}
		${periodFns}
		${edpSrc}
		const isLocked = (p) => LOCKED.has(p);
		${extractFn("lockedAmong")}
		return {
			excludedDayPeriods, lockedAmong, loadRowPeriods, loadAssignedMonthKey,
			// excludedDayGate()'s tail, verbatim in behaviour: refuse iff any
			// reported month is locked.
			verdict: (a) => (lockedAmong(excludedDayPeriods(a)).length ? "finalized" : null),
		};
	`)(RFC2822_MONTHS, new Set(lockedList));
}

// Production's lock state on 2026-08-09: 2025-05 … 2026-07 closed, 2026-08 open.
const LOCKED_PERIODS = ["2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11",
	"2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
const GATE = buildGate(EDP_SRC, PERIOD_FNS, LOCKED_PERIODS);

const JT_HEADERS = ["Load ID", "Driver", "Assigned Date", "Pickup Appointment", "Drop-off Appointment"];
const jtRow = (driver, assigned, pickup, dropoff) => ({
	"Load ID": "L1", Driver: driver, "Assigned Date": assigned || "",
	"Pickup Appointment": pickup || "", "Drop-off Appointment": dropoff || "",
});
const jt = (...rows) => ({ headers: JT_HEADERS, data: rows });
const DRV = "howard reddie";

// ------------------------------- 10. excludedDayPeriods — own month is UNIONED
console.log("\n10. excludedDayPeriods — the day's own month is ADDED, never displaced");

// THE BUG, as a decision. 2026-07-15 sits in a LOCKED month; its only covering
// load is assigned in OPEN 2026-08, so the covering load's month displaced the
// locked one and the gate cleared the write.
const CROSS = jt(jtRow(DRV, "2026-08-03", "2026-07-15", "2026-07-16"));
eq(GATE.excludedDayPeriods({ driver: DRV, date: "2026-07-15", action: "remove", jobTracking: CROSS }),
	["2026-07", "2026-08"],
	"a co-covering OPEN-month load no longer displaces the date's own LOCKED month");
eq(GATE.verdict({ driver: DRV, date: "2026-07-15", action: "remove", jobTracking: CROSS }), "finalized",
	"⚠️ …so the gate now REFUSES the write that would restate 2026-07");

// The production shape from PR #211: the date's own month is OPEN and the
// covering load's is LOCKED. That case always worked and must not move.
const OWN_OPEN = jt(jtRow(DRV, "2026-04-02", "2026-08-01", "2026-08-02"));
eq(GATE.excludedDayPeriods({ driver: DRV, date: "2026-08-01", action: "remove", jobTracking: OWN_OPEN }),
	["2026-04", "2026-08"], "the covering load's locked month is still reported beside the day's own");
eq(GATE.verdict({ driver: DRV, date: "2026-08-01", action: "remove", jobTracking: OWN_OPEN }), "finalized",
	"…and still refuses on the covering load's month (PR #211's headline case)");

console.log("\n   controls — every no-covering-load path stays byte-identical");
eq(GATE.excludedDayPeriods({ driver: DRV, date: "2026-08-05", action: "remove", jobTracking: jt() }),
	["2026-08"], "no covering load at all still yields exactly [own]");
eq(GATE.excludedDayPeriods({ driver: DRV, date: "2026-08-05", action: "remove", jobTracking: jt(jtRow("someone else", "2026-08-01", "2026-08-05")) }),
	["2026-08"], "a covering load for ANOTHER driver still yields exactly [own]");
eq(GATE.excludedDayPeriods({ driver: DRV, date: "2026-07-15", action: "add", jobTracking: CROSS }),
	["2026-07"], "action:'add' is untouched — the date's own month, full stop");
eq(GATE.excludedDayPeriods({ driver: DRV, date: "2026-07-15", action: "remove", jobTracking: null }),
	["2026-07"], "a null jobTracking still yields [own]");
eq(GATE.excludedDayPeriods({ driver: DRV, date: "2026-07-15", action: "remove", jobTracking: { headers: ["Load ID", "Assigned Date"], data: [] } }),
	["2026-07"], "no Driver column still yields [own]");
eq(GATE.excludedDayPeriods({ driver: DRV, date: "2026-07-15", action: "remove", jobTracking: jt(jtRow(DRV, "2026-07-03", "2026-07-15", "2026-07-16")) }),
	["2026-07"], "a covering load in the SAME month is unchanged (no duplicate, no growth)");

console.log("\n   ⚠️ fail-CLOSED — a wider set must never permit what the narrower one refused");
// The property that makes this safe regardless of data: the reported set only
// ever GROWS, and its one consumer re-filters it through lockedAmong(), so a
// month added can only ever produce a refusal isLocked() independently justifies.
const EDP_PRE_SRC = EDP_SRC.replace(
	"return [...new Set([...months, own])].sort();",
	"return months.size ? [...months].sort() : [own];");
ok(EDP_PRE_SRC !== EDP_SRC, "the pre-fix DISPLACING excludedDayPeriods could be reconstructed");
const GATE_PRE = buildGate(EDP_PRE_SRC, PERIOD_FNS, LOCKED_PERIODS);

const SWEEP_ASSIGNED = ["2026-08-03", "2026-07-03", "2026-04-02", "2025-09-02", "TBD", ""];
const SWEEP_DATES = ["2026-08-01", "2026-07-15", "2026-04-10", "2025-09-23", "2021-03-12"];
let superset = true, everPermitted = 0, widenedPairs = 0, newRefusals = 0;
for (const date of SWEEP_DATES) {
	for (const a1 of SWEEP_ASSIGNED) {
		for (const a2 of SWEEP_ASSIGNED) {
			// Two co-covering loads, which is exactly the shape that triggers the
			// displacement: one alone could never hide `own` behind another month.
			const tracking = jt(jtRow(DRV, a1, date, date), jtRow(DRV, a2, date, date));
			const arg = { driver: DRV, date, action: "remove", jobTracking: tracking };
			const before = GATE_PRE.excludedDayPeriods(arg), after = GATE.excludedDayPeriods(arg);
			if (before.some((m) => !after.includes(m))) {
				superset = false;
				console.log(`    ${JSON.stringify([date, a1, a2])} LOST ${JSON.stringify(before.filter((m) => !after.includes(m)))}`);
			}
			if (after.length > before.length) widenedPairs++;
			const vBefore = GATE_PRE.verdict(arg), vAfter = GATE.verdict(arg);
			if (vBefore === "finalized" && vAfter === null) {
				everPermitted++;
				console.log(`    ${JSON.stringify([date, a1, a2])} FAIL-OPEN: refused before, permitted after`);
			}
			if (vBefore === null && vAfter === "finalized") newRefusals++;
		}
	}
}
// ⚠️ SCOPED TO THE UNION IN ISOLATION — both sides here run the SAME (post-L-2)
// period functions, so this measures the tail change and nothing else. The
// COMPOSITE against the true pre-branch build is deliberately NOT a superset:
// the L-2 leg drops unmatchable keys like "999-01-", which is the point of it.
// That combination is asserted separately at the end of section 11.
ok(superset, "the union in isolation is always a SUPERSET — no month is ever lost to it");
eq(everPermitted, 0, "⚠️ NO combination is refused before and permitted after (the union cannot fail open)");
ok(widenedPairs > 0, `the union does widen where it should (${widenedPairs} of ${SWEEP_DATES.length * 36} combinations)`);
ok(newRefusals > 0, `…and converts fail-opens into refusals (${newRefusals} combinations newly refused)`);

// ------------------------------------- 11. L-2 — a non-month key must REFUSE
console.log("\n11. loadRowPeriods — a month key that is not a month must REFUSE, not permit");

// ⚠️ NOT `/^const LOCKABLE_MONTH_KEY = /` — extractConst() builds its result from
// exactly that prefix, so such an assertion can never fail and is not a check.
// The property actually worth pinning is that the regex carries NO g/y flag: a
// module-scope regex with `g` makes .test() STATEFUL (lastIndex advances), so it
// would return true/false on alternate calls and silently wave through every
// other row — a fail-open that no functional test on a single row would catch.
ok(!/\/[gy]/.test(MONTH_KEY_CONST.replace(/^const \w+ = /, "")),
	"LOCKABLE_MONTH_KEY carries no g/y flag (a stateful .test() would skip alternate rows)");
ok(/LOCKABLE_MONTH_KEY\.test\(key\)/.test(extractFn("loadAssignedMonthKey")), "the assigned leg applies the shape test");
ok(/filter\(\(m\) => LOCKABLE_MONTH_KEY\.test\(m\)\)/.test(extractFn("loadRowPeriods")), "the window leg applies it too");
// ⚠️ THE PREDICATE MUST BE lockedAmong's OWN, AND SHARED. Anything STRICTER
// discards a key the lock table could legitimately hold — a fail-open. Pinned
// structurally so a later "tidy-up" cannot reintroduce sheetCellMonths' bound.
ok(/LOCKABLE_MONTH_KEY\.test\(p\)/.test(extractFn("lockedAmong")),
	"⚠️ lockedAmong filters on the SAME shared regex — producer and consumer cannot drift");
ok(!/const MONTH = /.test(extractFn("lockedAmong")), "…and keeps no local copy of it");

const lrow = (assigned, pickup, dropoff) => jtRow(DRV, assigned, pickup, dropoff);
const RP = (assigned, pickup, dropoff) => GATE.loadRowPeriods(lrow(assigned, pickup, dropoff), COLS);
// Shapes that drive the year out of the 4-digit range, through moneySheetDate's
// NORMAL branches. `1 Jan 0999` is the realistic one and the reason this is not
// merely theoretical: production's Assigned Date column IS RFC 2822
// ("Date: Tue, 1 Jul 2025 11:33:05 -0500"), and that branch's `(\d{4})` happily
// takes a zero-padded 0999, so a mistyped year is one keystroke away.
//
// ⚠️ EVERY CELL HERE MUST BE TIMEZONE-STABLE, which rules out the largest ones.
// 275760-09-13 is EXACTLY the maximum representable JS Date, so "275760-09-13"
// (parsed as UTC midnight) resolves while "Sat Sep 13 275760" (parsed as LOCAL
// midnight) overflows to Invalid Date in any zone behind UTC — measured: both
// yield "275760-" under UTC/Kolkata/Kiritimati and null under America/Chicago.
// They were in this list on the first draft and the TZ run caught them: they
// still "refuse", but for the wrong reason (unparseable, not bounded), so they
// cannot carry the discriminator below. Boundary case kept as its own assertion.
const BAD_YEAR_CELLS = ["10000-01-01", "Jan 1 10000", "1 Jan 10000",
	"0999-01-01", "1 Jan 0999", "Sat Jan 01 999", "Jan 1 999"];
let badRefused = 0, badKeyBlank = 0;
for (const cell of BAD_YEAR_CELLS) {
	if (RP(cell, "", "").resolved === false) badRefused++;
	if (GATE.loadAssignedMonthKey(lrow(cell, "", ""), COLS) === "") badKeyBlank++;
}
eq(badRefused, BAD_YEAR_CELLS.length, `all ${BAD_YEAR_CELLS.length} out-of-range years answer resolved:FALSE (the guard refuses)`);
eq(badKeyBlank, BAD_YEAR_CELLS.length, "…and loadAssignedMonthKey returns NO key rather than an unmatchable one");
// The window leg has its own path in: jtExpandDateRange builds days with
// jtFmtDate too, so an ISO "0999-01-01" pickup reaches it as "999-01-".
eq(RP("TBD", "0999-01-01", ""), { periods: [], resolved: false },
	"the WINDOW leg also refuses an out-of-range year (not only the assigned leg)");
// The JS-Date boundary case, asserted on the OUTCOME both readings share rather
// than on a key, so it holds in every zone (see the ⚠️ above).
eq(RP("275760-09-13", "", "").resolved, false, "the max-representable-date cell refuses in every timezone");
eq(RP("Sat Sep 13 275760", "", "").resolved, false, "…and so does its local-midnight spelling, which Invalid-Dates west of UTC");

console.log("\n   controls — real months stay, and so does anything LOCKABLE");
eq(RP("2026-07-15", "", ""), { periods: ["2026-07"], resolved: true }, "an ordinary assigned date is unchanged");
eq(RP("Date: Tue, 1 Jul 2025 11:33:05 -0500", "", ""), { periods: ["2025-07"], resolved: true },
	"production's RFC 2822 assigned date is unchanged");
eq(RP("TBD", "9/23/2025", "9/25/2025"), { periods: ["2025-09"], resolved: true }, "the window leg still resolves a real month");

// ⚠️ THESE ARE THE SECURITY REVIEW'S FINDING, AS ASSERTIONS. An implausible but
// well-FORMED month is lockable — POST /api/periods/:period/finalize admits
// anything matching /^\d{4}-\d{2}$/ and period_locks has no CHECK — so it must
// be KEPT and offered to isLocked(). Dropping it (as sheetCellMonths' tighter
// 1970-2999 bound would) turns a refusal into a permit. Measured with such a
// lock present: 128 REFUSE→permit flips over 1,183 gate combinations.
eq(RP("1969-12-05", "", ""), { periods: ["1969-12"], resolved: true },
	"⚠️ a pre-1970 but WELL-FORMED month is KEPT — it is lockable, so it must be judged");
eq(RP("3000-01-05", "", ""), { periods: ["3000-01"], resolved: true },
	"⚠️ …and so is a post-2999 one, for the same reason");
eq(RP("1000-01-05", "", ""), { periods: ["1000-01"], resolved: true }, "the 4-digit floor is kept");
eq(RP("12/31/9999", "", ""), { periods: ["9999-12"], resolved: true }, "the 4-digit ceiling is kept");

console.log("\n   ⚠️ the pre-fix code PERMITTED these — resolved:true with nothing lockedAmong could match");
const PERIOD_FNS_PRE = `${MONTH_KEY_CONST}
${extractFn("loadAssignedMonthKey").replace(
		'\tif (!d || isNaN(d)) return "";\n\tconst key = jtFmtDate(d).slice(0, 7);\n\treturn LOCKABLE_MONTH_KEY.test(key) ? key : "";',
		'\treturn d && !isNaN(d) ? jtFmtDate(d).slice(0, 7) : "";')}
${extractFn("loadRowPeriods").replace(".filter((m) => LOCKABLE_MONTH_KEY.test(m))", "")}`;
ok(!/LOCKABLE_MONTH_KEY\.test\(key\)/.test(PERIOD_FNS_PRE) && !/filter\(\(m\) => LOCKABLE_MONTH_KEY/.test(PERIOD_FNS_PRE),
	"the pre-bound loadAssignedMonthKey/loadRowPeriods could be reconstructed");
const GATE_L2_PRE = buildGate(EDP_SRC, PERIOD_FNS_PRE, LOCKED_PERIODS);
const RP_PRE = (assigned) => GATE_L2_PRE.loadRowPeriods(lrow(assigned, "", ""), COLS);
let preFailOpen = 0;
// TZ-stable cells only — see the ⚠️ on BAD_YEAR_CELLS.
for (const cell of ["10000-01-01", "Jan 1 10000", "0999-01-01", "1 Jan 0999", "Sat Jan 01 999"]) {
	const p = RP_PRE(cell);
	// The fail-open signature: resolved TRUE, periods NON-EMPTY, and yet
	// lockedAmong() can match none of them — so locked.length is 0 → permit.
	if (p.resolved && p.periods.length && GATE_L2_PRE.lockedAmong(p.periods).length === 0) preFailOpen++;
	else console.log(`    !! ${cell} does not discriminate: ${JSON.stringify(p)}`);
}
eq(preFailOpen, 5, "all 5 reproduce the pre-fix fail-open (resolved:true, key unmatchable by lockedAmong)");
eq(RP_PRE("1 Jan 0999").periods, ["999-01-"], "…the unmatchable key is literally '999-01-' — a truncated year, not a month");

console.log("\n   ⚠️ COMPOSITE, under an ADVERSARIAL lock table — the fix must not fail open");
// Section 10's sweep isolates the union (pre-M-1 vs shipped, both post-L-2).
// This one runs BOTH changes together against the TRUE pre-branch behaviour, with
// a lock table holding periods the finalize route permits but a tighter bound
// would have discarded. That combination is the only way the L-2 leg could fail
// open, so it is the case worth pinning rather than describing.
const ADVERSARIAL_LOCKS = LOCKED_PERIODS.concat(["1900-05", "1969-12", "1000-01", "3000-01"]);
const PRE_BRANCH = buildGate(EDP_PRE_SRC, PERIOD_FNS_PRE, ADVERSARIAL_LOCKS);   // neither fix
const SHIPPED_ADV = buildGate(EDP_SRC, PERIOD_FNS, ADVERSARIAL_LOCKS);          // both fixes
let advPermits = 0, advCombos = 0, advRefusals = 0;
for (const date of ["2026-08-01", "2026-07-15", "1969-12-05", "1900-05-05"]) {
	for (const a1 of ["2026-08-03", "2026-07-03", "1900-05-05", "1969-12-05", "3000-01-05", "1 Jan 0999", "TBD"]) {
		for (const a2 of ["2026-08-03", "1900-05-05", "1 Jan 0999", "TBD"]) {
			const jobTracking = jt(jtRow(DRV, a1, date, date), jtRow(DRV, a2, date, date));
			const arg = { driver: DRV, date, action: "remove", jobTracking };
			advCombos++;
			const before = PRE_BRANCH.verdict(arg), after = SHIPPED_ADV.verdict(arg);
			if (before === "finalized" && after === null) {
				advPermits++;
				console.log(`    FAIL-OPEN ${JSON.stringify([date, a1, a2])}: ${JSON.stringify(PRE_BRANCH.excludedDayPeriods(arg))} -> ${JSON.stringify(SHIPPED_ADV.excludedDayPeriods(arg))}`);
			}
			if (before === null && after === "finalized") advRefusals++;
		}
	}
}
eq(advPermits, 0, `⚠️ 0 of ${advCombos} combinations go REFUSE→permit even with out-of-range periods locked`);
ok(advRefusals > 0, `…while the union still converts fail-opens into refusals (${advRefusals} newly refused)`);

// ============================================================================
// 12. THE PRODUCER END — which months may be WRITTEN into period_locks
// ============================================================================
// Section 11 pins the READER: lockedAmong() must stay as wide as the lock table
// can be, because a reader narrower than the table turns a refusal into a permit.
// That left the complementary hole open and named it — the finalize route admitted
// anything matching /^\d{4}-\d{2}$/ and period_locks has no CHECK, so `1900-05`,
// `0999-13` and `9999-99` were all lockable and every guard in server.js then
// consulted the junk row.
//
// The fix bounds the WRITER, which is the only end that can be tightened safely.
// The invariant that makes it safe is a subset relation, and it is asserted here
// rather than described:
//
//        isPlausibleLockPeriod(p)  ⟹  LOCKABLE_MONTH_KEY.test(p)
//
console.log("\n12. isPlausibleLockPeriod — the WRITER's bound, and why it is not the reader's");

const PLAUSIBLE_SRC = extractFn("isPlausibleLockPeriod");
const MIN_YEAR_CONST = extractConst("LOCK_PERIOD_MIN_YEAR");
const MAX_YEAR_CONST = extractConst("LOCK_PERIOD_MAX_YEAR");
const PLAUSIBLE = new Function(`
	${MONTH_KEY_CONST}
	${MIN_YEAR_CONST}
	${MAX_YEAR_CONST}
	${PLAUSIBLE_SRC}
	return { isPlausibleLockPeriod, LOCKABLE_MONTH_KEY, LOCK_PERIOD_MIN_YEAR, LOCK_PERIOD_MAX_YEAR };
`)();

// ⚠️ STRUCTURAL: the predicate must DELEGATE to the shared regex, not restate the
// shape. A hand-rolled copy (/^[0-9]{4}-[0-9]{2}$/, or a substr length test) would
// pass every functional assertion below and still be free to drift away from
// lockedAmong() later — which is the exact failure mode PR #249 reverted.
ok(/LOCKABLE_MONTH_KEY\.test\(p\)/.test(PLAUSIBLE_SRC),
	"⚠️ isPlausibleLockPeriod delegates to the SHARED LOCKABLE_MONTH_KEY — subset by construction, not by coincidence");
ok(!/\^\\d\{4\}|\^\[0-9\]/.test(PLAUSIBLE_SRC), "…and keeps no private copy of the shape regex");

// Production's 15 rows, read off the VPS read-only on 2026-08-09 (better-sqlite3
// {readonly:true}); every one is status='locked'. If a tightening cannot clear
// this list it would orphan a live lock, so this is the gate on the whole change.
const PROD_LOCK_ROWS = ["2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11",
	"2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
eq(PROD_LOCK_ROWS.length, 15, "the production lock table had exactly 15 rows");
eq(PROD_LOCK_ROWS.filter((p) => !PLAUSIBLE.isPlausibleLockPeriod(p)), [],
	"⚠️ all 15 EXISTING production periods still validate — the bound orphans nothing");
eq(LOCKED_PERIODS.filter((p) => !PLAUSIBLE.isPlausibleLockPeriod(p)), [],
	"…and so does every period section 10/11 treat as locked");

console.log("\n   the junk the finalize route used to admit");
for (const bad of ["1900-05", "1969-12", "0999-13", "9999-99", "3000-01", "1000-01", "2026-00", "2026-13"]) {
	ok(PLAUSIBLE.isPlausibleLockPeriod(bad) === false, `"${bad}" is refused as a lock key`);
}
console.log("\n   …and the real months it must never touch");
for (const good of ["2000-01", "2100-12", "2025-05", "2026-07", "2026-08", "2099-12"]) {
	ok(PLAUSIBLE.isPlausibleLockPeriod(good) === true, `"${good}" is accepted`);
}

console.log("\n   ⚠️ SUBSET — the writer's set is strictly inside the reader's");
// A corpus mixing production, the junk above, malformed shapes, the L-2 truncated
// keys from section 11, and non-strings. The subset property must hold over ALL of
// it: anything the writer admits, lockedAmong must be able to match.
const PERIOD_CORPUS = [...PROD_LOCK_ROWS, "1900-05", "1969-12", "0999-13", "9999-99", "3000-01",
	"1000-01", "2000-01", "2100-12", "2101-01", "1999-12", "2026-00", "2026-13", "2026-1", "202-05",
	"20260-05", "10000-01", "999-01-", "275760-", "2026-07 ", " 2026-07", "2026/07", "2026_07", "",
	"abc", "0000-00", null, undefined, 0, 20260, {}, [], "2026-07\n"];
let subsetHolds = true, narrowedBy = 0;
for (const p of PERIOD_CORPUS) {
	const writer = PLAUSIBLE.isPlausibleLockPeriod(p);
	const reader = PLAUSIBLE.LOCKABLE_MONTH_KEY.test(String(p == null ? "" : p));
	if (writer && !reader) { subsetHolds = false; console.log(`    !! ${JSON.stringify(p)} admitted by WRITER but unmatchable by READER`); }
	if (reader && !writer) narrowedBy++;
}
ok(subsetHolds, `⚠️ every key the writer admits is matchable by lockedAmong (${PERIOD_CORPUS.length} candidates) — tightening cannot hide a lock`);
ok(narrowedBy > 0, `…and the bound is genuinely narrower, not a no-op (${narrowedBy} well-formed keys refused)`);

console.log("\n   ⚠️ ANTI-NARROWING — every month the business could plausibly settle must stay lockable");
// Widening this bound is safe; NARROWING it is a one-way door. Reopen skips the
// bound when a lock row exists but finalize does not, so a month narrowed out
// while already locked becomes reopenable and never re-lockable — no API can
// close it again. Raised by security review (L-1). This sweeps the whole span the
// business could ever settle, so a future "tidy" to a business range fails here
// rather than in production years later.
const EARLIEST_PROD_YEAR = Number(PROD_LOCK_ROWS[0].slice(0, 4));   // 2025
const HORIZON_YEAR = new Date().getUTCFullYear() + 10;
let settleableRefused = [];
for (let y = EARLIEST_PROD_YEAR - 5; y <= HORIZON_YEAR; y++) {
	for (let m = 1; m <= 12; m++) {
		const key = `${y}-${String(m).padStart(2, "0")}`;
		if (!PLAUSIBLE.isPlausibleLockPeriod(key)) settleableRefused.push(key);
	}
}
eq(settleableRefused, [], `⚠️ every month from ${EARLIEST_PROD_YEAR - 5}-01 to ${HORIZON_YEAR}-12 is lockable — the bound can never strand a real settlement month`);
// And all 12 month numbers are accepted in a real year — a bound that silently
// refused month 12 would only surface each December.
eq([...Array(12)].map((_, i) => `2026-${String(i + 1).padStart(2, "0")}`).filter((p) => !PLAUSIBLE.isPlausibleLockPeriod(p)),
	[], "all twelve months of a real year are lockable (December is not special-cased away)");

console.log("\n   ⚠️ …and applying this SAME bound at the READER would fail open — measured");
// The counterfactual, as a number. This is the one-line answer to "why not just
// put the range check in lockedAmong too?": with a junk period genuinely locked, a
// reader that discards it reports nothing locked, and the guard permits the write.
// Same adversarial lock table as section 11.
const GATE_READER_BOUNDED = new Function("RFC2822_MONTHS", "LOCKED", `
	${DEPS}
	${GATE_DEPS}
	${WINDOW_SRC}
	${PERIOD_FNS}
	${EDP_SRC}
	${MIN_YEAR_CONST}
	${MAX_YEAR_CONST}
	${PLAUSIBLE_SRC}
	const isLocked = (p) => LOCKED.has(p);
	// lockedAmong with the WRITER's bound wrongly applied to the READER.
	function lockedAmong(periods) {
		return [...new Set((periods || []).filter((p) => isPlausibleLockPeriod(p) && isLocked(p)))].sort();
	}
	return { verdict: (a) => (lockedAmong(excludedDayPeriods(a)).length ? "finalized" : null) };
`)(RFC2822_MONTHS, new Set(ADVERSARIAL_LOCKS));

let readerBoundFlips = 0, shippedFlips = 0, combos = 0;
for (const date of ["2026-08-01", "2026-07-15", "1969-12-05", "1900-05-05"]) {
	for (const a1 of ["2026-08-03", "2026-07-03", "1900-05-05", "1969-12-05", "3000-01-05", "1 Jan 0999", "TBD"]) {
		for (const a2 of ["2026-08-03", "1900-05-05", "1 Jan 0999", "TBD"]) {
			const jobTracking = jt(jtRow(DRV, a1, date, date), jtRow(DRV, a2, date, date));
			const arg = { driver: DRV, date, action: "remove", jobTracking };
			combos++;
			// Baseline is the SHIPPED reader (section 11's SHIPPED_ADV).
			const base = SHIPPED_ADV.verdict(arg);
			if (base === "finalized" && GATE_READER_BOUNDED.verdict(arg) === null) readerBoundFlips++;
			if (base === "finalized" && SHIPPED_ADV.verdict(arg) === null) shippedFlips++;
		}
	}
}
// Printed, not merely asserted — these two numbers ARE the argument for putting
// the bound on the writer, and an assertion label is invisible while it passes.
console.log(`    bound at the READER (the wrong end): ${readerBoundFlips} of ${combos} REFUSE→permit flips`);
console.log(`    bound at the WRITER  (as shipped)  : ${shippedFlips} of ${combos} REFUSE→permit flips`);
ok(readerBoundFlips > 0,
	`⚠️ bounding the READER costs ${readerBoundFlips} of ${combos} REFUSE→permit flips — this is why the bound is on the writer only`);
eq(shippedFlips, 0, `⚠️ the SHIPPED arrangement flips 0 of ${combos} — no refusal becomes a permit`);
// The reader is untouched by this change, so section 11's own 0-flips result must
// still stand. Re-asserted here so a future edit to isPlausibleLockPeriod that
// leaked into lockedAmong is caught by THIS section too, not only by that one.
eq(advPermits, 0, "…and section 11's adversarial comparison is still 0 flips after this change");

// ---------------------------------------------------------- the routes themselves
console.log("\n   the two ROUTES — the real handler bodies, run against stubs");
// Extracted verbatim, same philosophy as the money statements: these are inline
// arrow handlers inside 35k lines, so lifting the body is the only way to exercise
// the code that ships rather than a paraphrase of it.
function extractRouteBody(pathLiteral) {
	const needle = `app.post("${pathLiteral}"`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 route ${pathLiteral}, found ${hits}`);
	const at = SRC.indexOf(needle);
	const arrow = SRC.indexOf("=> {", at);
	if (arrow < 0) throw new Error(`no handler body for ${pathLiteral}`);
	const brace = SRC.indexOf("{", arrow);
	return braceMatch(brace, brace);
}
const FINALIZE_BODY = extractRouteBody("/api/periods/:period/finalize");
const REOPEN_BODY = extractRouteBody("/api/periods/:period/reopen");

// Stubs for everything the handlers touch besides the validation under test.
// db is dispatched on SQL text so the reopen handler's three statements can be
// told apart; `lockRow` is what SELECT … FROM period_locks returns.
function runRoute(bodySrc, { period, lockRow = undefined, enabled = true }) {
	const calls = { finalized: [], audited: [], reopened: [] };
	const res = {
		_status: 200, _json: null,
		status(c) { this._status = c; return this; },
		json(o) { this._json = o; return this; },
	};
	const db = {
		prepare(sql) {
			return {
				get: () => (/FROM period_locks/.test(sql) ? lockRow
					: /COUNT\(\*\)/.test(sql) ? { c: 0, t: 0 } : undefined),
				run: (...a) => { if (/UPDATE period_locks/.test(sql)) calls.reopened.push(a); return { changes: 1 }; },
			};
		},
		transaction: (fn) => (...a) => fn(...a),
	};
	const fn = new Function("ctx", `
		const { req, res, db, calls, PERIOD_FINALIZE_ENABLED,
			LOCKABLE_MONTH_KEY, isPlausibleLockPeriod, LOCK_PERIOD_MIN_YEAR, LOCK_PERIOD_MAX_YEAR,
			currentMonthKeyCT, periodLabel, periodLockStmt, finalizePeriod, logAudit } = ctx;
		return (async () => ${bodySrc})();
	`);
	return fn({
		req: { params: { period }, body: { reason: "late receipt correction" }, session: { user: { username: "qa" } } },
		res, db, calls,
		PERIOD_FINALIZE_ENABLED: enabled,
		LOCKABLE_MONTH_KEY: PLAUSIBLE.LOCKABLE_MONTH_KEY,
		isPlausibleLockPeriod: PLAUSIBLE.isPlausibleLockPeriod,
		LOCK_PERIOD_MIN_YEAR: PLAUSIBLE.LOCK_PERIOD_MIN_YEAR,
		LOCK_PERIOD_MAX_YEAR: PLAUSIBLE.LOCK_PERIOD_MAX_YEAR,
		currentMonthKeyCT: () => "2026-08",
		periodLabel: (p) => `label(${p})`,
		periodLockStmt: () => ({ get: () => undefined }),
		finalizePeriod: async (p, a) => { calls.finalized.push([p, a]); return { stamped: 3, investors: 1, periods: [p] }; },
		logAudit: (...a) => { calls.audited.push(a); },
	}).then(() => ({ status: res._status, body: res._json, calls }));
}

const routeChecks = [];
// ⚠️ ASYNC — every route assertion is queued and awaited at the end of the file,
// because the finalize handler is async and a fire-and-forget promise would let a
// failure land AFTER the pass/fail summary had already printed a green total.
async function routeCase(label, run, check) {
	routeChecks.push(run().then((r) => check(r, label)));
}

for (const bad of ["1900-05", "0999-13", "9999-99", "2026-13", "1969-12"]) {
	routeCase(`finalize refuses "${bad}"`,
		() => runRoute(FINALIZE_BODY, { period: bad }),
		(r, label) => {
			ok(r.status === 400, `${label} — 400 (got ${r.status})`);
			ok(r.body && r.body.code === "PERIOD_OUT_OF_RANGE", `${label} — code PERIOD_OUT_OF_RANGE (got ${r.body && r.body.code})`);
			eq(r.calls.finalized, [], `${label} — and finalizePeriod() is never reached`);
		});
}
for (const malformed of ["2026-7", "202605", "abc", "20260-05"]) {
	routeCase(`finalize rejects malformed "${malformed}"`,
		() => runRoute(FINALIZE_BODY, { period: malformed }),
		(r, label) => {
			ok(r.status === 400, `${label} — 400 (got ${r.status})`);
			ok(r.body && r.body.code === "PERIOD_KEY_INVALID", `${label} — code PERIOD_KEY_INVALID (got ${r.body && r.body.code})`);
		});
}
// THE CONTROL THAT MATTERS: a legitimate close still closes. Without this the
// section could be satisfied by a route that refuses everything.
routeCase("finalize STILL SUCCEEDS on a legitimate past month",
	() => runRoute(FINALIZE_BODY, { period: "2026-07" }),
	(r, label) => {
		ok(r.status === 200, `${label} — 200 (got ${r.status})`);
		ok(r.body && r.body.success === true && r.body.period === "2026-07", `${label} — success body`);
		eq(r.calls.finalized, [["2026-07", "qa"]], `${label} — finalizePeriod() actually ran`);
		ok(r.calls.audited.length === 1, `${label} — and the close was audit-logged`);
	});
routeCase("finalize still 409s an accruing month (existing guard intact)",
	() => runRoute(FINALIZE_BODY, { period: "2026-08" }),
	(r, label) => ok(r.status === 409 && r.body.code === "PERIOD_ACCRUING", `${label} — 409 PERIOD_ACCRUING (got ${r.status}/${r.body && r.body.code})`));

routeCase("reopen refuses an implausible period that has NO lock row",
	() => runRoute(REOPEN_BODY, { period: "1900-05", lockRow: undefined }),
	(r, label) => {
		ok(r.status === 400, `${label} — 400 (got ${r.status})`);
		ok(r.body && r.body.code === "PERIOD_OUT_OF_RANGE", `${label} — code PERIOD_OUT_OF_RANGE`);
	});
// ⚠️ THE REMEDY CARVE-OUT. finalize was unbounded until this commit, so a database
// may already hold a `1900-05` row. Reopen is the only API that clears one, and the
// VPS has no sqlite3 binary — so bounding reopen unconditionally would strand the
// junk lock permanently. An EXISTING row must stay reopenable.
routeCase("⚠️ reopen STILL WORKS on an implausible period that IS locked (the remedy is not blocked)",
	() => runRoute(REOPEN_BODY, { period: "1900-05", lockRow: { period: "1900-05", status: "locked" } }),
	(r, label) => {
		ok(r.status === 200, `${label} — 200 (got ${r.status}/${JSON.stringify(r.body)})`);
		ok(r.calls.reopened.length === 1, `${label} — the UPDATE to period_locks actually ran`);
	});
routeCase("reopen still 404s a plausible month that was never finalized",
	() => runRoute(REOPEN_BODY, { period: "2026-06", lockRow: undefined }),
	(r, label) => ok(r.status === 404 && r.body.code === "NOT_FINALIZED", `${label} — 404 NOT_FINALIZED (got ${r.status})`));
routeCase("reopen still succeeds normally on a real locked month",
	() => runRoute(REOPEN_BODY, { period: "2026-07", lockRow: { period: "2026-07", status: "locked" } }),
	(r, label) => ok(r.status === 200 && r.body.success === true, `${label} — 200 success (got ${r.status})`));

// ------------------------------------------ the pre-fix routes must FAIL these
// Self-discrimination, same discipline as section 5: reconstruct the route bodies
// as they were before this commit and require them to admit what the shipped ones
// refuse. A test that passes against both proves nothing.
console.log("\n   ⚠️ discrimination — the PRE-FIX routes admitted the junk");
const FINALIZE_PRE = FINALIZE_BODY.replace(/\n\t\tif \(!isPlausibleLockPeriod\(period\)\) \{[\s\S]*?\n\t\t\}/, "");
const REOPEN_PRE = REOPEN_BODY.replace(/\n\t\tif \(!lock && !isPlausibleLockPeriod\(period\)\) \{[\s\S]*?\n\t\t\}/, "");
ok(FINALIZE_PRE !== FINALIZE_BODY && !/isPlausibleLockPeriod/.test(FINALIZE_PRE),
	"the pre-fix finalize handler could be reconstructed");
ok(REOPEN_PRE !== REOPEN_BODY && !/isPlausibleLockPeriod/.test(REOPEN_PRE),
	"the pre-fix reopen handler could be reconstructed");
routeCase("⚠️ PRE-FIX finalize LOCKED \"1900-05\" — the gap, reproduced",
	() => runRoute(FINALIZE_PRE, { period: "1900-05" }),
	(r, label) => {
		ok(r.status === 200, `${label} — it returned 200 (got ${r.status})`);
		eq(r.calls.finalized, [["1900-05", "qa"]], `${label} — and finalizePeriods() wrote the junk lock`);
	});
routeCase("⚠️ PRE-FIX finalize also locked \"0999-13\" (month 13)",
	() => runRoute(FINALIZE_PRE, { period: "0999-13" }),
	(r, label) => ok(r.status === 200 && r.calls.finalized.length === 1, `${label} — locked a 13th month (got ${r.status})`));
routeCase("PRE-FIX reopen 404'd rather than 400'd an implausible key",
	() => runRoute(REOPEN_PRE, { period: "1900-05", lockRow: undefined }),
	(r, label) => ok(r.status === 404, `${label} — 404, i.e. treated as a real month (got ${r.status})`));
// …while the control still passes on BOTH, so the discriminator is the bound and
// not some incidental breakage in the reconstruction.
routeCase("control — the pre-fix finalize also succeeded on a legitimate month",
	() => runRoute(FINALIZE_PRE, { period: "2026-07" }),
	(r, label) => ok(r.status === 200, `${label} — 200 (got ${r.status})`));

// ---------------------------------------------- the non-route doors into the table
console.log("\n   the other writers — route validation only helps if the routes are the only door");
// period_locks has exactly three write sites. Pinned structurally, because a fourth
// one added later is precisely how this class of gap comes back.
eq((SRC.match(/INTO period_locks/g) || []).length, 2, "period_locks still has exactly 2 INSERT sites");
eq((SRC.match(/UPDATE period_locks/g) || []).length, 1, "…and exactly 1 UPDATE site (the reopen)");
// extractFn() only knows plain declarations; finalizePeriods is `async function`.
function extractFnAny(name) {
	for (const kw of ["function", "async function"]) {
		const needle = `\n${kw} ${name}(`;
		if (SRC.split(needle).length - 1 === 1) {
			const start = SRC.indexOf(needle) + 1;
			return braceMatch(start, bodyStart(start + `${kw} ${name}`.length));
		}
	}
	throw new Error(`expected exactly 1 definition of ${name}(), found none`);
}
ok(/const list = proposed\.filter\(isPlausibleLockPeriod\);/.test(extractFnAny("finalizePeriods")),
	"⚠️ finalizePeriods() filters — the choke point the finalize ROUTE and the SWEEP both pass through");
ok(/isPlausibleLockPeriod/.test(extractFnAny("periodsDueForClose")),
	"periodsDueForClose() filters, so the sweep's `due` leg never proposes a junk key");
// ⚠️ THE SWEEP HAS TWO INPUTS AND THE SECOND IS THE DANGEROUS ONE. `unstamped`
// reads period_locks DIRECTLY, so it surfaces a junk row a pre-validation build
// already wrote — the exact state the reopen carve-out exists for. Unfiltered,
// finalizePeriods refuses it, stamps nothing, nothing changes, and the identical
// row returns next tick: a per-minute warn loop forever, burying real failures.
// Found by security review (M-1); the filter is invisible in any single-tick test,
// so it is pinned structurally.
const SWEEP_SRC = extractFnAny("maybeCloseFinishedPeriods");
ok(/\.all\(\)\.map\(\(r\) => r\.period\)\.filter\(isPlausibleLockPeriod\)/.test(SWEEP_SRC),
	"⚠️ the sweep's `unstamped` retry leg is filtered too — not just `due`");
// …and the close log must report what CLOSED, not what was PROPOSED. Logging
// `work` announces a close that finalizePeriods refused.
ok(/finalized \$\{result\.periods\.join/.test(SWEEP_SRC),
	"⚠️ the close log reports result.periods, not the proposed `work` (it cannot announce a refused close)");
ok(!/finalized \$\{work\.join/.test(SWEEP_SRC), "…and no longer logs `work`");
// The baseline seed is the second INSERT and does NOT go through finalizePeriods.
// It locks every distinct investor_payouts.period in one pass on first enable, so
// it is the highest-volume way junk could land.
const SEED_AT = SRC.indexOf("INSERT OR IGNORE INTO period_locks");
ok(SRC.slice(SEED_AT - 900, SEED_AT).includes("isPlausibleLockPeriod"),
	"⚠️ the baseline seed filters too — it INSERTs directly, bypassing finalizePeriods()");

// ⚠️ THE BOUND MUST NEVER REACH A READ PATH. isLocked() reports a FACT about the
// table and periodLocksReadable() is the positive control for the entire lock
// system — and it deliberately probes with "1970-01", a period this writer bound
// REFUSES. Teaching either of them the bound would break the health probe and,
// worse, reproduce #249's fail-open: a reader that discards a key the table holds
// reports "nothing locked" and permits the write. Pinned structurally, because it
// is the single most tempting follow-up edit.
ok(!/isPlausibleLockPeriod/.test(extractFn("isLocked")), "⚠️ isLocked() does NOT consult the writer bound — it reports what the table says");
ok(!/isPlausibleLockPeriod/.test(extractFn("periodLocksReadable")), "⚠️ …nor does periodLocksReadable(), whose probe key '1970-01' the bound refuses");
ok(!/isPlausibleLockPeriod/.test(extractFn("lockedAmong")), "⚠️ …nor lockedAmong(), the reader #249 proved must stay wide");
ok(PLAUSIBLE.isPlausibleLockPeriod("1970-01") === false && /1970-01/.test(extractFn("periodLocksReadable")),
	"…and that probe key really is one the writer would refuse — so the split is load-bearing, not cosmetic");

// ⚠️ WHY THE UPSTREAM NEEDS THIS AT ALL: investor_payouts.period is not validated
// anywhere. It is built from a Date cursor whose start is moneySheetDate() over the
// sheet's Assigned Date column, and the year is interpolated with getFullYear() —
// unpadded, exactly like jtFmtDate(). One mistyped year seeds real-SHAPED but absurd
// months, which the seed would then lock in bulk. Reproduced here from the shipped
// month-key expression rather than asserted from memory.
const mk = (y, m) => `${new Date(y, m - 1, 1).getFullYear()}-${String(new Date(y, m - 1, 1).getMonth() + 1).padStart(2, "0")}`;
eq(mk(1000, 1), "1000-01", "a year-1000 cursor yields a well-SHAPED month key, so the shape test alone would pass it");
ok(PLAUSIBLE.LOCKABLE_MONTH_KEY.test(mk(1000, 1)) && !PLAUSIBLE.isPlausibleLockPeriod(mk(1000, 1)),
	"⚠️ …and only the range bound refuses it — this is the case route validation alone would have missed");

// ------------------------------------------------------- 13. timezone invariance
if (!process.env.TZ_CHILD) {
	console.log("\n13. timezone invariance — same verdicts under UTC / Chicago / Kolkata");
	const probe = [
		"2025-09-24", "Date: Tue, 13 May 2025 11:56:47 -0500",
		"Date: Wed, 31 Dec 2025 20:00:00 -0600", "9/24/2025", "2025/09/24 23:59", "9:00",
		"2025/09/23 23:59", "14:00", "07:00 Appt.", "23 Sep 2025", "Date: 9/23/2025",
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
// Probes the value in EVERY position it can occupy: as an IFTA cell, as a
// drop-off, as a guard-side pickup (union) and as a money-side pickup (shift).
// A probe that only exercised the drop-off would let a timezone-dependent pickup
// read through, which is the half added here.
//
// The last two entries carry the excluded-day gate: the reported months AND the
// refuse/allow verdict. Both are month-keyed strings derived from local-time
// Date fields, so a value that resolved to a different DAY under a far-east zone
// could land in a different MONTH and flip a refusal — precisely the class this
// file exists to catch, and it would be invisible probing loadWindowDays alone.
module.exports.probe = (v) => [
	NEW.sheetToIso(v),
	NEW.loadWindowDays(row("9/23/2025", v), COLS),
	NEW.loadWindowDays(row(v, "9/25/2025", "Date: Mon, 22 Sep 2025 08:45:51 -0500"), COLS),
	PERIODS.loadRowPeriods(row(v, "9/25/2025", "TBD"), COLS),
	moneyRead(MONEY_NEW, v, "9/25/2025", "Date: Mon, 22 Sep 2025 08:45:51 -0500"),
	GATE.excludedDayPeriods({ driver: DRV, date: "2026-07-15", action: "remove", jobTracking: jt(jtRow(DRV, v, "2026-07-15", "2026-07-16")) }),
	GATE.verdict({ driver: DRV, date: "2026-08-01", action: "remove", jobTracking: jt(jtRow(DRV, v, "2026-08-01", "2026-08-02")) }),
	GATE.loadRowPeriods(jtRow(DRV, v, "", ""), COLS),
];

// ⚠️ The section-12 route assertions are ASYNC (the finalize handler is an async
// arrow, so its body can only be exercised through a promise). They must be
// settled before the totals print — otherwise a failing route check resolves
// after "N passed, 0 failed" has already been written and the run exits green.
Promise.all(routeChecks).catch((e) => {
	fail++; failures.push("route harness threw: " + e.message);
}).then(() => {
	if (!process.env.TZ_CHILD) {
		console.log(`\n${pass} passed, ${fail} failed`);
		if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
	}
});
