#!/usr/bin/env node
/**
 * Calendar days stay calendar days, in every server zone.
 *
 * THE RULE UNDER TEST. A bare "YYYY-MM-DD" (a load date, a week bound, an
 * invoice period) is a calendar DATE, not an instant: its weekday and its
 * Sat–Fri billing week are calendar arithmetic, the same for every server and
 * every viewer. `new Date("2026-09-26")` is UTC MIDNIGHT, which Central reads as
 * Friday 19:00, so any path that turns a bare day into an instant and then reads
 * it through a US zone lands on the day before.
 *
 * What this pins, each under TZ=America/New_York, Asia/Manila and UTC:
 *   1. getWeekRange() on a bare day. A Saturday used to resolve to the PREVIOUS
 *      billing week on every server (UTC included): the payment report's
 *      `week=` and a driver's generate call with a Saturday both hit it.
 *   2. The investor load report's weekly grouping (GET /api/investor/load-report
 *      ?period=weekly), which handed getWeekRange() the row's LOCAL-midnight Date.
 *      On the UTC VPS that is UTC midnight, so a Saturday load was grouped into
 *      the week before. It now hands over the day key it already computed.
 *   3. The four boundaries this run was asked to cover: the 28th of September
 *      2026 is a Monday everywhere (load 569820951), a late-evening Eastern
 *      instant that is already tomorrow in Manila, a month end, and the switch
 *      from daylight time on Sunday 1 November 2026.
 *
 * WHY IT LIFTS FUNCTIONS OUT OF server.js SOURCE: server.js opens SQLite and
 * starts listening on require, so it cannot be loaded by a test (same approach
 * as scripts/test-invoice-week-date.js). Each lift asserts exactly one definition.
 *
 * Section 4 re-runs everything in child processes under the three zones and
 * requires byte-identical output. Section 5 runs the pre-fix getWeekRange()
 * against the same Saturday cases and requires it to FAIL in every zone, so the
 * test is known to discriminate.
 *
 * Run: node scripts/test-calendar-day-zones.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const ZONES = ["America/New_York", "Asia/Manila", "UTC"];
const CHILD = process.env.CALENDAR_ZONES_CHILD === "1";

// ---------------------------------------------------------------- extraction
function lift(name) {
	const needle = `function ${name}(`;
	const at = SRC.indexOf(needle);
	if (at < 0) throw new Error(`server.js has no ${needle}`);
	if (SRC.indexOf(needle, at + 1) >= 0) throw new Error(`server.js defines ${name} more than once`);
	let i = SRC.indexOf("{", at);
	let depth = 0;
	for (; i < SRC.length; i++) {
		if (SRC[i] === "{") depth++;
		else if (SRC[i] === "}" && --depth === 0) break;
	}
	return SRC.slice(at, i + 1);
}
const lifted = ["shiftDayKey", "houstonDay", "moneySheetDate", "getWeekRange"].map(lift).join("\n");
const RFC2822_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const { getWeekRange, moneySheetDate, shiftDayKey, houstonDay } =
	new Function("RFC2822_MONTHS", `${lifted}; return { getWeekRange, moneySheetDate, shiftDayKey, houstonDay };`)(RFC2822_MONTHS);

// The load report's weekly key for one sheet cell, exactly as the route builds it.
const reportRouteAt = SRC.indexOf('app.get("/api/investor/load-report"');
const reportRoute = SRC.slice(reportRouteAt, SRC.indexOf("\napp.", reportRouteAt + 10));
const weeklyCall = /const wr = getWeekRange\(([^)]*)\);/.exec(reportRoute);
function loadReportWeek(cell) {
	const dt = moneySheetDate(cell);
	const dayKey = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
	const arg = weeklyCall[1].trim() === "dayKey" ? dayKey : dt;
	return getWeekRange(arg);
}

// ---------------------------------------------------------------- assertions
let pass = 0;
let fail = 0;
const out = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; out.push(`ok   ${label} -> ${a}`); } else { fail++; out.push(`FAIL ${label}: got ${a}, want ${e}`); }
}
const week = (s, e) => ({ weekStart: s, weekEnd: e });
const weekday = (day) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(`${day}T12:00:00Z`).getUTCDay()];

// 0. The load report hands getWeekRange the day key it computed, not the Date.
eq(weeklyCall && weeklyCall[1].trim(), "dayKey", "load-report weekly grouping passes the day key to getWeekRange()");

// 1. Load 569820951: the 28th of September 2026 stays a Monday, in its own week.
eq(weekday("2026-09-28"), "Monday", "2026-09-28 is a Monday");
eq(getWeekRange("2026-09-28"), week("2026-09-26", "2026-10-02"), "week of Mon 2026-09-28");
eq(getWeekRange("2026-09-27"), week("2026-09-26", "2026-10-02"), "week of Sun 2026-09-27");
eq(getWeekRange("2026-09-26"), week("2026-09-26", "2026-10-02"), "week of Sat 2026-09-26 (its own week, not the one before)");
eq(getWeekRange("2026-10-02"), week("2026-09-26", "2026-10-02"), "week of Fri 2026-10-02 (the batch's week end)");
eq(moneySheetDate("9/28/2026 15:15").getDay(), 1, "the sheet cell 9/28/2026 15:15 reads as a Monday");
// The weekly invoice's day grid: `new Date(ds + "T12:00:00").getDay()` (local noon).
eq(new Date("2026-09-28T12:00:00").getDay(), 1, "invoice grid places 2026-09-28 on Monday");
eq(loadReportWeek("9/26/2026"), week("2026-09-26", "2026-10-02"), "load report: a Saturday 9/26 load is in the week of 9/26");
eq(loadReportWeek("9/28/2026 15:15"), week("2026-09-26", "2026-10-02"), "load report: a Monday 9/28 load is in the week of 9/26");

// 2. Late evening in the East is already tomorrow in Manila. Instants keep taking
// their Houston day (the business-day rule is unchanged by this fix).
eq(getWeekRange("2026-09-28T23:30:00-04:00"), week("2026-09-26", "2026-10-02"), "Mon 11:30 PM EDT (Tue in Manila)");
eq(getWeekRange("2026-10-02T23:30:00-04:00"), week("2026-09-26", "2026-10-02"), "Fri 11:30 PM EDT (Sat in Manila) stays in its week");
eq(houstonDay(new Date("2026-09-28T23:30:00-04:00")), "2026-09-28", "Mon 11:30 PM EDT is still Monday in Houston");

// 3. Month end: September 30 is a Wednesday inside the Sep 26 week; October 31 is
// a Saturday that starts its own week.
eq(weekday("2026-09-30"), "Wednesday", "2026-09-30 is a Wednesday");
eq(getWeekRange("2026-09-30"), week("2026-09-26", "2026-10-02"), "week of Wed 2026-09-30");
eq(getWeekRange("2026-10-01"), week("2026-09-26", "2026-10-02"), "week of Thu 2026-10-01");
eq(getWeekRange("2026-10-31"), week("2026-10-31", "2026-11-06"), "week of Sat 2026-10-31 (month end)");
eq(loadReportWeek("10/31/2026 8:00"), week("2026-10-31", "2026-11-06"), "load report: Sat 10/31 load in the week of 10/31");
eq(houstonDay(new Date("2026-09-30T23:30:00-04:00")), "2026-09-30", "Sep 30 11:30 PM EDT is still September in Houston");

// 4. Daylight time ends on Sunday 2026-11-01 (01:00-02:00 happens twice).
eq(weekday("2026-11-01"), "Sunday", "2026-11-01 is a Sunday");
eq(getWeekRange("2026-11-01"), week("2026-10-31", "2026-11-06"), "week of Sun 2026-11-01");
eq(getWeekRange("2026-11-07"), week("2026-11-07", "2026-11-13"), "week of Sat 2026-11-07 (first full week of standard time)");
eq(shiftDayKey("2026-10-31", 1), "2026-11-01", "Oct 31 + 1 day");
eq(shiftDayKey("2026-11-01", 1), "2026-11-02", "Nov 1 + 1 day");
eq(houstonDay(new Date("2026-11-01T01:30:00-04:00")), "2026-11-01", "1:30 AM EDT on Nov 1");
eq(houstonDay(new Date("2026-11-01T01:30:00-05:00")), "2026-11-01", "1:30 AM EST on Nov 1 (the repeated hour)");
eq(getWeekRange("2026-11-01T23:30:00-05:00"), week("2026-10-31", "2026-11-06"), "Sun 11:30 PM EST, already Monday in UTC");

// 5. Values that are not a real calendar day keep their old meaning.
eq(getWeekRange("2026-02-30").weekStart === getWeekRange(new Date("2026-02-30")).weekStart, true, "an impossible day takes the old path");

// 6. APP_TIMEZONE: an instant's "today" for documents, never the server's clock.
const appTime = require(path.join(__dirname, "..", "lib", "app-time.js"));
const warnings = [];
eq(appTime.resolveAppTimeZone(""), "America/New_York", "APP_TIMEZONE unset -> America/New_York");
eq(appTime.resolveAppTimeZone(" America/Chicago "), "America/Chicago", "APP_TIMEZONE names a zone -> that zone");
eq(appTime.resolveAppTimeZone("Mars/Olympus", (m) => warnings.push(m)), "America/New_York", "APP_TIMEZONE names no zone -> the default");
eq(warnings.length, 1, "...with one warning");
const NY = appTime.resolveAppTimeZone(undefined);
const inNY = (iso) => appTime.dayInZone(new Date(iso), NY);
// The Friday batch that issued INV-SK-2026W39-01 ran at 00:00:48 UTC on Oct 3,
// 8:00 PM on Friday Oct 2 in the East. Its PDF printed "Friday, Oct 3, 2026".
eq(appTime.dateTextInZone(new Date("2026-10-03T00:00:48Z"), NY), "Oct 2, 2026", "the batch's 'today' (8 PM EDT Fri) is Oct 2");
eq(inNY("2026-09-28T23:30:00-04:00"), "2026-09-28", "Mon 11:30 PM EDT (Tue 11:30 AM in Manila) is Monday");
eq(inNY("2026-09-30T23:30:00-04:00"), "2026-09-30", "Sep 30 11:30 PM EDT is still September (Oct 1 in UTC)");
eq(inNY("2026-10-01T00:30:00-04:00"), "2026-10-01", "Oct 1 12:30 AM EDT is October");
eq(inNY("2026-11-01T01:30:00-04:00"), "2026-11-01", "Nov 1 1:30 AM EDT");
eq(inNY("2026-11-01T01:30:00-05:00"), "2026-11-01", "Nov 1 1:30 AM EST (the repeated hour)");
eq(inNY("2026-11-01T23:30:00-05:00"), "2026-11-01", "Nov 1 11:30 PM EST (Nov 2 in UTC)");
eq(inNY("2026-11-02T00:30:00-05:00"), "2026-11-02", "Nov 2 12:30 AM EST");
// Both invoice routes print "today" through the setting, not the process clock.
const nowStrLines = SRC.match(/const nowStr = [^\n]+/g) || [];
eq(nowStrLines.length, 2, "two invoice routes define nowStr");
eq(nowStrLines.every((l) => l.includes("appTime.dateTextInZone(new Date(), APP_TIMEZONE)")), true, "both use APP_TIMEZONE");

// 7. Documents and reports: the only "today" left on the process clock (a
// toLocaleDateString call with no timeZone, outside comments) are two known
// ones: the signed-contract effective date, kept on the server's UTC day on
// purpose so a re-render matches what was signed (effectiveDateFromStamp()),
// and the driver application's fallback signature date.
const processClockDates = SRC.split("\n")
	.filter((l) => !/^\s*\/\//.test(l))
	.flatMap((l) => l.match(/new Date\(\)\.toLocaleDateString\([^)]*\)/g) || [])
	.filter((call) => !/timeZone/.test(call));
eq(processClockDates.length, 2, "two process-clock toLocaleDateString calls left in server.js");
eq(/preservedEffectiveDate \|\| new Date\(\)\.toLocaleDateString\("en-US", \{ month: "long"/.test(SRC), true, "...one is the contract effective date");
eq(/signature_date \|\| new Date\(\)\.toLocaleDateString\('en-US'\)/.test(SRC), true, "...one is the driver application's fallback signature date");
eq((SRC.match(/\$\{new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)\}\.(csv|pdf)/g) || []).length, 0, "report file names carry the APP_TIMEZONE day");
eq(/fmtPaidDay\(inv\.paid_at\)/.test(SRC), true, "payment report prints paid_at as its APP_TIMEZONE day");
eq(appTime.dayInZone(new Date("2026-08-01T01:15:00Z"), NY), "2026-07-31", "paid Jul 31 9:15 PM EDT is Jul 31 (its UTC day is Aug 1)");
// The investor report's period line, built exactly as the route builds it.
const periodLine = /const filterStart = [^\n]+\n\s*const filterEnd = [^\n]+/.exec(SRC);
const periodStrSrc = /const periodStr = filterStart \|\| filterEnd\n[^\n]+\n[^\n]+;/.exec(SRC);
const periodOf = (from, until) => new Function("dateRange", `${periodLine[0]}\n${periodStrSrc[0]}\nreturn periodStr;`)({ from, until });
eq(periodOf("2026-08-01", "2026-09-30"), "Period: 8/1/2026 – 9/30/2026", "investor report period 2026-08-01..2026-09-30");
eq(periodOf("2026-11-01", "2026-11-30"), "Period: 11/1/2026 – 11/30/2026", "investor report period across the DST switch");

const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
if (CHILD) {
	process.stdout.write(out.join("\n"));
	process.exit(fail ? 1 : 0);
}

console.log(`TZ=${tz}: ${pass} passed, ${fail} failed`);
out.filter((l) => l.startsWith("FAIL")).forEach((l) => console.log(`  ${l}`));

// ---------------------------------------------------- every zone, same answers
console.log("\nSame assertions under each zone (child processes):");
const outputs = [];
for (const zone of ZONES) {
	let text;
	let ok = true;
	try {
		text = execFileSync(process.execPath, [__filename], { env: { ...process.env, TZ: zone, CALENDAR_ZONES_CHILD: "1" }, encoding: "utf8" });
	} catch (err) {
		text = String(err.stdout || "");
		ok = false;
	}
	outputs.push(text);
	const failed = text.split("\n").filter((l) => l.startsWith("FAIL"));
	if (!ok || failed.length) {
		fail++;
		console.log(`  FAIL TZ=${zone}: ${failed.length} assertion(s) failed`);
		failed.forEach((l) => console.log(`    ${l}`));
	} else {
		pass++;
		console.log(`  ok   TZ=${zone}: all assertions pass`);
	}
}
if (new Set(outputs).size === 1) { pass++; console.log("  ok   identical output in every zone"); } else { fail++; console.log("  FAIL the zones disagree"); }

// ------------------------------------- the pre-fix code fails, in every zone
// getWeekRange() as it shipped before this fix, kept verbatim.
const OLD_GET_WEEK_RANGE = `function getWeekRange(referenceDate) {
	const d = referenceDate ? new Date(referenceDate) : new Date();
	const cstStr = d.toLocaleString("en-US", { timeZone: "America/Chicago" });
	const cst = new Date(cstStr);
	const day = cst.getDay();
	const satOffset = day === 6 ? 0 : day + 1;
	const weekStart = new Date(cst);
	weekStart.setDate(cst.getDate() - satOffset);
	weekStart.setHours(0, 0, 0, 0);
	const weekEnd = new Date(weekStart);
	weekEnd.setDate(weekStart.getDate() + 6);
	weekEnd.setHours(23, 59, 59, 999);
	const p2 = (n) => String(n).padStart(2, "0");
	const fmt = (dt) => dt.getFullYear() + "-" + p2(dt.getMonth() + 1) + "-" + p2(dt.getDate());
	return { weekStart: fmt(weekStart), weekEnd: fmt(weekEnd) };
}`;
console.log("\nThe pre-fix getWeekRange() must fail the Saturday cases:");
for (const zone of ZONES) {
	const broken = Number(execFileSync(process.execPath, ["-e", `
		${OLD_GET_WEEK_RANGE}
		let n = 0;
		if (getWeekRange("2026-09-26").weekStart !== "2026-09-26") n++;
		if (getWeekRange("2026-10-31").weekStart !== "2026-10-31") n++;
		if (getWeekRange("2026-11-07").weekStart !== "2026-11-07") n++;
		if (getWeekRange(new Date(2026, 8, 26)).weekStart !== "2026-09-26") n++;
		process.stdout.write(String(n));
	`], { env: { ...process.env, TZ: zone }, encoding: "utf8" }));
	if (broken === 4) { pass++; console.log(`  ok   TZ=${zone}: the old code fails all 4`); } else { fail++; console.log(`  FAIL TZ=${zone}: the old code failed ${broken} of 4`); }
}
// The invoices' old "today" read the process clock: on the UTC VPS the batch
// instant printed Oct 3. (Under a US zone it happened to be right.)
const oldToday = execFileSync(process.execPath, ["-e",
	"process.stdout.write(new Date('2026-10-03T00:00:48Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))"],
	{ env: { ...process.env, TZ: "UTC" }, encoding: "utf8" });
if (oldToday === "Oct 3, 2026") { pass++; console.log("  ok   TZ=UTC: the old invoice 'today' prints Oct 3, 2026"); } else { fail++; console.log(`  FAIL TZ=UTC: the old invoice 'today' printed ${oldToday}`); }

console.log(`\n${"-".repeat(60)}`);
console.log(fail ? `FAILED: ${pass} passed, ${fail} failed` : `PASS: ${pass} checks`);
process.exit(fail ? 1 : 0);
