#!/usr/bin/env node
/**
 * Tests for the WEEKLY INVOICE date basis — parseInvoiceDate() and getWeekRange().
 *
 * WHY IT LOADS THE FUNCTIONS OUT OF server.js SOURCE INSTEAD OF require()-ing.
 * Same reason as scripts/test-money-date.js: server.js opens SQLite, reads a
 * service account key and starts listening on import, so it cannot be required
 * from a test. Extracting the text keeps this honest in the way that matters —
 * it exercises THE CODE THAT SHIPS. Each extraction asserts exactly one
 * definition, so a rename or a duplicate fails loudly instead of testing nothing.
 *
 * THE PROPERTY UNDER TEST is not "this date parses". It is that the calendar day
 * a load is BILLED ON, and the Sat–Fri window it is billed IN, do not depend on
 * the server's timezone.
 *
 *   - parseInvoiceDate had no ISO branch, so ISO and RFC 2822 fell through to
 *     `new Date()` and were read back through server-local getters. On the UTC
 *     VPS a Friday-evening Houston stamp resolved to SATURDAY — the next billing
 *     week. Section 2 is that exact boundary case.
 *   - getWeekRange serialized server-LOCAL midnights through toISOString(), i.e.
 *     UTC, so east of UTC the whole window came back Fri–Thu instead of Sat–Fri.
 *
 * Section 5 re-runs the whole corpus in three child processes (TZ=UTC,
 * America/Chicago, Asia/Tokyo) and requires byte-identical output.
 *
 * Section 6 is the discrimination proof: it runs the PRE-FIX implementations
 * against the same assertions and requires them to FAIL. A test that passes on
 * both the broken and the fixed code has not tested anything.
 *
 * Run: node scripts/test-invoice-week-date.js
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");

// ---------------------------------------------------------------- extraction
function extractAt(needle, label) {
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${label} in server.js, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${label}`);
}
const extract = (name) => extractAt(`\nfunction ${name}(`, `${name}()`);
// parseInvoiceDate is nested inside generateInvoiceHandler, so it is indented.
const extractNested = (name) => extractAt(`\n\t\tfunction ${name}(`, `${name}()`);

const RFC2822_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const S = new Function("RFC2822_MONTHS", [
	extract("houstonDay"),
	extract("sheetDayKey"),
	extract("getWeekRange"),
	extractNested("parseInvoiceDate"),
	"return { houstonDay, sheetDayKey, getWeekRange, parseInvoiceDate };",
].join("\n"))(RFC2822_MONTHS);
const { sheetDayKey, getWeekRange, parseInvoiceDate } = S;

// The formatter the invoice reads the result back through (server.js fmtLocalDate).
const fmtLocalDate = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const day = (v) => { const d = parseInvoiceDate(v); return d && !isNaN(d) ? fmtLocalDate(d) : null; };

// ------------------------------------------------- the PRE-FIX implementations
// Verbatim copies of what shipped before this change, used ONLY by section 6 to
// prove these assertions discriminate.
function oldParseInvoiceDate(val) {
	if (!val) return null;
	const cleaned = String(val).replace(/^date:\s*/i, "").trim();
	const m = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
	if (m) {
		let yr = parseInt(m[3]); if (yr < 100) yr += 2000;
		const d = new Date(yr, parseInt(m[1]) - 1, parseInt(m[2]));
		return isNaN(d) ? null : d;
	}
	const d = new Date(cleaned);
	return isNaN(d) ? null : d;
}
const oldDay = (v) => { const d = oldParseInvoiceDate(v); return d && !isNaN(d) ? fmtLocalDate(d) : null; };
function oldGetWeekRange(referenceDate) {
	const d = referenceDate ? new Date(referenceDate) : new Date();
	const cstStr = d.toLocaleString("en-US", { timeZone: "America/Chicago" });
	const cst = new Date(cstStr);
	const dayN = cst.getDay();
	const satOffset = dayN === 6 ? 0 : dayN + 1;
	const weekStart = new Date(cst);
	weekStart.setDate(cst.getDate() - satOffset);
	weekStart.setHours(0, 0, 0, 0);
	const weekEnd = new Date(weekStart);
	weekEnd.setDate(weekStart.getDate() + 6);
	weekEnd.setHours(23, 59, 59, 999);
	const fmt = (dt) => dt.toISOString().split("T")[0];
	return { weekStart: fmt(weekStart), weekEnd: fmt(weekEnd) };
}

// -------------------------------------------------------------------- runner
let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return true; }
	fail++; failures.push(`  ${label}\n      expected ${e}\n      actual   ${a}`);
	return false;
}
const CHILD = process.env.INVOICE_DATE_CHILD === "1";
function section(t) { if (!CHILD) console.log(`\n${t}`); }

// The billing week that contains Friday 2025-08-08 is Sat 2025-08-02 .. Fri 2025-08-08.
const WEEK = { start: "2025-08-02", end: "2025-08-08" };
const inWeek = (ymd) => !!ymd && ymd >= WEEK.start && ymd <= WEEK.end;

// ============================================================ 1. shapes
section("1. Every shape resolves to the day written on the sheet");
eq(day("5/16/2025"), "2025-05-16", "US slash");
eq(day("5/16/25"), "2025-05-16", "US slash, 2-digit year");
eq(day("4/6/2026 14:33:19"), "2026-04-06", "US slash with time (Status Update Date shape)");
eq(day("5/16/25 06:00-18:00 Appt."), "2025-05-16", "US slash with appointment window");
eq(day("2026-04-27"), "2026-04-27", "bare ISO (6 pickup / 5 dropoff rows in production)");
eq(day("2025-05-09 21:00"), "2025-05-09", "naive ISO with time (15 production rows)");
eq(day("2025-05-09T21:00"), "2025-05-09", "naive ISO, T separator");
eq(day("Wed, 30 Apr 2025 19:35:06 -0500"), "2025-04-30", "RFC 2822 evening, literal day");
eq(day("Date: Wed, 30 Apr 2025 19:35:06 -0500"), "2025-04-30", "RFC 2822 with the copied 'Date: ' prefix");
eq(day(""), null, "empty");
eq(day(null), null, "null");
eq(day(undefined), null, "undefined");
eq(day("07:00 Appt."), null, "time-only garbage (3 production rows) stays unparseable");

// ================================================ 2. THE BOUNDARY CASE
section("2. A late-day FRIDAY must not slide into the next billing week");
// Friday 2025-08-08, 19:16 Houston (CDT, -05:00). Both encodings of that instant
// appear in this column's history: the RFC 2822 header n8n copies, and the `Z`
// form toISOString() emits. Under the old reader on the UTC VPS both resolved to
// SATURDAY 2025-08-09 — the first day of the NEXT Sat–Fri week — so the load was
// billed a week late and the driver was short-paid that week.
const fridayCases = [
	["2025-08-09T00:16:37Z", "ISO with Z (what toISOString writes)"],
	["2025-08-09T00:16:37+00:00", "ISO with explicit +00:00 offset"],
	["2025-08-08T19:16:37-05:00", "ISO with the Houston offset"],
	["Fri, 8 Aug 2025 19:35:06 -0500", "RFC 2822 Friday evening"],
	["Date: Fri, 8 Aug 2025 23:59:00 -0500", "RFC 2822 one minute before midnight"],
];
for (const [raw, label] of fridayCases) {
	eq(day(raw), "2025-08-08", `${label} resolves to Friday`);
	eq(inWeek(day(raw)), true, `${label} stays inside ${WEEK.start}..${WEEK.end}`);
}
// The control: the very next day really is the next week, so the assertions above
// are testing a boundary and not merely accepting everything.
eq(day("2025-08-09"), "2025-08-09", "Saturday 08-09 resolves to Saturday");
eq(inWeek(day("2025-08-09")), false, "Saturday 08-09 correctly falls OUTSIDE the week");
eq(day("2025-08-02"), "2025-08-02", "Saturday 08-02 (week start)");
eq(inWeek(day("2025-08-02")), true, "Saturday 08-02 is inside the week");
eq(inWeek(day("2025-08-01")), false, "Friday 08-01 is the PREVIOUS week");

// ==================================== 3. the two readers of the same cell agree
section("3. parseInvoiceDate agrees with sheetDayKey (the week filter) on every shape");
// 'Status Update Date' is read by the week filter via sheetDayKey AND, as
// completionCol, by parseInvoiceDate. If they disagree, a load is admitted to
// week N while its own active day lands in week N±1.
const corpus = [
	"5/16/2025", "5/16/25", "4/6/2026 14:33:19", "5/16/25 06:00-18:00 Appt.",
	"2026-04-27", "2025-05-09 21:00", "2025-05-09T21:00", "2026-05-13",
	"2025-08-09T00:16:37Z", "2025-08-08T19:16:37-05:00", "2025-08-09T00:16:37+0000",
	"Wed, 30 Apr 2025 19:35:06 -0500", "Date: Fri, 8 Aug 2025 23:59:00 -0500",
	"19 Jun 2025 20:16:37 -0500", "Thu, 31 Jul 2025 23:59:00 -0500",
	"Wed, 31 Dec 2025 20:00:00 -0600",
];
for (const v of corpus) {
	const k = sheetDayKey(v);
	if (k) eq(day(v), k, `agreement on ${JSON.stringify(v)}`);
}

// ======================================================= 4. getWeekRange
section("4. getWeekRange returns the Sat–Fri window as wall-clock days");
eq(getWeekRange("2025-08-08T12:00:00-05:00"), { weekStart: "2025-08-02", weekEnd: "2025-08-08" }, "Friday midday");
eq(getWeekRange("2025-08-08T23:59:00-05:00"), { weekStart: "2025-08-02", weekEnd: "2025-08-08" }, "Friday one minute to midnight");
eq(getWeekRange("2025-08-09T00:01:00-05:00"), { weekStart: "2025-08-09", weekEnd: "2025-08-15" }, "Saturday 00:01 starts the NEXT week");
eq(getWeekRange("2025-08-02T00:00:00-05:00"), { weekStart: "2025-08-02", weekEnd: "2025-08-08" }, "Saturday midnight is a week start");
eq(getWeekRange("2026-01-02T18:00:00-06:00"), { weekStart: "2025-12-27", weekEnd: "2026-01-02" }, "week spanning the year boundary");
eq(getWeekRange("2026-03-08T12:00:00-05:00"), { weekStart: "2026-03-07", weekEnd: "2026-03-13" }, "week containing the US DST spring-forward");

// ============================================== 5. timezone independence
if (!CHILD) {
	section("5. Identical under TZ=UTC, America/Chicago and Asia/Tokyo");
	const zones = ["UTC", "America/Chicago", "Asia/Tokyo"];
	const outs = zones.map((tz) =>
		execFileSync(process.execPath, [__filename], {
			env: { ...process.env, TZ: tz, INVOICE_DATE_CHILD: "1" },
			encoding: "utf8",
		}).trim(),
	);
	for (let i = 1; i < zones.length; i++) {
		eq(outs[i] === outs[0], true, `TZ=${zones[i]} output matches TZ=${zones[0]}`);
	}
	if (outs[0] !== outs[1] || outs[0] !== outs[2]) {
		zones.forEach((z, i) => console.log(`   TZ=${z}\n     ${outs[i].split("\n").join("\n     ")}`));
	}
}

// ============================================ 6. proof the tests discriminate
if (!CHILD) {
	section("6. The PRE-FIX code must FAIL these assertions (discrimination proof)");
	const brokenHere = [];
	// parseInvoiceDate: on the UTC VPS the Friday-evening cases slid to Saturday.
	for (const [raw, label] of fridayCases) {
		if (oldDay(raw) !== "2025-08-08") brokenHere.push(`parseInvoiceDate ${label}: old=${oldDay(raw)} want 2025-08-08`);
	}
	// bare ISO was UTC midnight, so it read a day early anywhere west of UTC.
	if (oldDay("2026-04-27") !== "2026-04-27") brokenHere.push(`parseInvoiceDate bare ISO: old=${oldDay("2026-04-27")} want 2026-04-27`);
	// getWeekRange: local midnight through toISOString lands a day early east of UTC.
	const owr = oldGetWeekRange("2025-08-08T12:00:00-05:00");
	if (owr.weekStart !== "2025-08-02" || owr.weekEnd !== "2025-08-08") {
		brokenHere.push(`getWeekRange: old=${JSON.stringify(owr)} want {2025-08-02,2025-08-08}`);
	}
	console.log(`   under TZ=${process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone}: ${brokenHere.length} assertion(s) fail against the old code`);
	brokenHere.forEach((b) => console.log(`     - ${b}`));

	// The old code must fail in EVERY zone we claim it was broken in — and the
	// zones are the point, so count them per-zone rather than trusting this one.
	const perZone = {};
	for (const tz of ["UTC", "America/Chicago", "Asia/Tokyo"]) {
		const n = Number(execFileSync(process.execPath, ["-e", `
			process.env.TZ = ${JSON.stringify(tz)};
			${oldParseInvoiceDate.toString()}
			${oldGetWeekRange.toString()}
			const f = (d) => d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
			const od = (v) => { const d = oldParseInvoiceDate(v); return d && !isNaN(d) ? f(d) : null; };
			let n = 0;
			for (const r of ${JSON.stringify(fridayCases.map((c) => c[0]))}) if (od(r) !== "2025-08-08") n++;
			if (od("2026-04-27") !== "2026-04-27") n++;
			const w = oldGetWeekRange("2025-08-08T12:00:00-05:00");
			if (w.weekStart !== "2025-08-02" || w.weekEnd !== "2025-08-08") n++;
			process.stdout.write(String(n));
		`], { env: { ...process.env, TZ: tz }, encoding: "utf8" }));
		perZone[tz] = n;
		eq(n > 0, true, `old code fails at least one assertion under TZ=${tz} (it fails ${n})`);
	}
	console.log(`   per-zone failure counts against the old code: ${JSON.stringify(perZone)}`);
}

// -------------------------------------------------------------------- report
if (CHILD) {
	// Canonical fingerprint the parent diffs across zones.
	const lines = [];
	for (const v of corpus) lines.push(`${JSON.stringify(v)} -> ${day(v)} | sheetDayKey ${JSON.stringify(sheetDayKey(v))}`);
	for (const [raw] of fridayCases) lines.push(`friday ${JSON.stringify(raw)} -> ${day(raw)} inWeek=${inWeek(day(raw))}`);
	for (const ref of ["2025-08-08T12:00:00-05:00", "2025-08-09T00:01:00-05:00", "2026-01-02T18:00:00-06:00", "2026-03-08T12:00:00-05:00"]) {
		lines.push(`week ${ref} -> ${JSON.stringify(getWeekRange(ref))}`);
	}
	process.stdout.write(lines.join("\n"));
	process.exit(fail > 0 ? 1 : 0);
}

console.log(`\n${"-".repeat(60)}`);
if (fail) {
	console.log(`FAILED — ${pass} passed, ${fail} failed\n`);
	failures.forEach((f) => console.log(f));
	process.exit(1);
}
console.log(`OK — ${pass} assertions passed`);
