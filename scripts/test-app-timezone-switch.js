#!/usr/bin/env node
/**
 * The business clock is APP_TIMEZONE (US Eastern), in every server zone.
 *
 * THE RULE UNDER TEST. The client decided on 2026-10-08 that all dates and times
 * are US Eastern (America/New_York, EST and EDT automatically), replacing the
 * 2026-08-04 rule "all time and date are Houston time". Every business rule that
 * pinned America/Chicago reads the one setting, APP_TIMEZONE (lib/app-time.js,
 * default America/New_York):
 *   - "today" and the current month: appDay(), appTodayKey(), appMonthKey();
 *   - the invoice week of an instant ("now"): getWeekRange();
 *   - the Friday 6:30 PM submission cutoff: isAfterDeadline();
 *   - the Friday 7:00 PM batch: mostRecentInvoiceFriday();
 *   - the Assigned / Status Update stamps written into the sheet: appStamp();
 *   - the month of a truck assignment instant: assignmentMonthKey();
 *   - the broker invoice number's day: invoiceSeqDayKey();
 *   - a zoned sheet cell's business day: sheetDayKey();
 *   - the instant that stands for a day: appNoonMs().
 * The invoice generator's ELD ping window names no zone at all: it holds every
 * US truck-local day of the billing week.
 *
 * What this pins, each under TZ=America/New_York, America/Chicago, Asia/Manila
 * and UTC, with byte-identical output:
 *   1. 11:30 PM Central is already the next day in Eastern (a weekday, a Friday
 *      night at the billing-week seam, the cutoff and the batch);
 *   2. the switch from daylight time on Sunday 2026-11-01;
 *   3. a month end (Oct 31 11:30 PM Central is November);
 *   4. APP_TIMEZONE is a setting: set to America/Chicago, the same functions give
 *      the Houston answers, which is also the proof the assertions discriminate
 *      (the Houston rule fails them).
 *   5. No business code names a zone: server.js and lib/ hold no America/Chicago
 *      outside comments but the truck-location bands (lib/eld-miles.js) and the
 *      reading of stamps written before the switch (lib/load-haul.js); the client
 *      reads the same switch date.
 *
 * Functions are lifted out of server.js source (server.js opens SQLite and listens
 * on require); each lift asserts exactly one definition.
 *
 * Run: node scripts/test-app-timezone-switch.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const ZONES = ["America/New_York", "America/Chicago", "Asia/Manila", "UTC"];
const CHILD = process.env.APP_ZONE_SWITCH_CHILD === "1";

// ---------------------------------------------------------------- extraction
function lift(name) {
	const needle = `\nfunction ${name}(`;
	const at = SRC.indexOf(needle);
	if (at < 0) throw new Error(`server.js has no function ${name}(`);
	if (SRC.indexOf(needle, at + 1) >= 0) throw new Error(`server.js defines ${name} more than once`);
	let i = SRC.indexOf("{", SRC.indexOf(")", at));
	let depth = 0;
	for (; i < SRC.length; i++) {
		if (SRC[i] === "{") depth++;
		else if (SRC[i] === "}" && --depth === 0) break;
	}
	return SRC.slice(at + 1, i + 1);
}
const NAMES = ["appDay", "appStamp", "appNoonMs", "appTodayKey", "appMonthKey", "getWeekRange", "isAfterDeadline",
	"mostRecentInvoiceFriday", "assignmentMonthKey", "invoiceSeqDayKey", "sheetDayKey"];
const LIFTED = NAMES.map(lift).join("\n");
const RFC2822_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const appTime = require(path.join(ROOT, "lib", "app-time.js"));

// The lifted functions on a business zone and a clock: `new Date()` and
// Date.now() read `nowIso`; every other form of Date is the real one.
function build(zone, nowIso) {
	const RealDate = Date;
	const nowMs = nowIso ? RealDate.parse(nowIso) : RealDate.now();
	const Clock = class extends RealDate {
		constructor(...a) { if (a.length) super(...a); else super(nowMs); }
		static now() { return nowMs; }
	};
	return new Function("Date", "APP_TIMEZONE", "appTime", "RFC2822_MONTHS",
		`${LIFTED}\nreturn { ${NAMES.join(", ")} };`)(Clock, zone, appTime, RFC2822_MONTHS);
}
const ET = appTime.appTimeZone();
const at = (nowIso) => build(ET, nowIso);
const S = at(null);

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

eq(ET, "America/New_York", "APP_TIMEZONE unset is US Eastern");

// 1. 11:30 PM Central is already the next day in Eastern.
// Tue 2026-10-13 23:30 CDT === 2026-10-14T04:30:00Z === Wed 00:30 EDT.
const lateCentral = new Date("2026-10-14T04:30:00Z");
eq(S.appDay(lateCentral), "2026-10-14", "Tue 11:30 PM CDT is Wednesday on the business clock");
eq(S.appStamp(lateCentral), "10/14/2026 0:30:00", "...and is stamped 10/14/2026 0:30:00");
eq(S.sheetDayKey("2026-10-14T04:30:00Z"), "2026-10-14", "a zoned sheet cell at that instant counts on Wednesday");
eq(S.sheetDayKey("10/13/2026 23:30:00"), "2026-10-13", "a bare stamp keeps the day written on it (stored stamps are never re-dated)");
eq(S.invoiceSeqDayKey(lateCentral), "10142026", "a broker invoice raised then is numbered for the 14th");
eq(at("2026-10-14T04:30:00Z").appTodayKey(), "2026-10-14", "appTodayKey() at that moment");
eq(S.appNoonMs("2026-10-14"), Date.parse("2026-10-14T16:00:00Z"), "noon EDT stands for the day");
eq(S.appNoonMs("2026-04-17"), Date.parse("2026-04-17T17:00:00Z"), "a day before the switch keeps 17:00 UTC (a closed month's truck holder is unchanged)");
eq(S.appNoonMs("2026-04-31"), NaN, "a non-day stands for nothing");
// Fri 2026-10-16 23:30 CDT === 2026-10-17T04:30:00Z === Sat 00:30 EDT: the next billing week.
eq(S.getWeekRange("2026-10-17T04:30:00Z"), week("2026-10-17", "2026-10-23"), "Fri 11:30 PM CDT is Saturday: the next billing week");
eq(S.getWeekRange("2026-10-17T03:30:00Z"), week("2026-10-10", "2026-10-16"), "Fri 11:30 PM EDT is still Friday: this week");
eq(at("2026-10-17T04:30:00Z").getWeekRange(), week("2026-10-17", "2026-10-23"), "getWeekRange() of 'now' at that moment");
eq(S.getWeekRange("2026-10-17"), week("2026-10-17", "2026-10-23"), "a bare Saturday is its own week (calendar arithmetic, no zone)");
eq(S.getWeekRange("not a date"), week("NaN-NaN-NaN", "NaN-NaN-NaN"), "an unparseable value keeps its old answer");
// The Friday 6:30 PM cutoff is Eastern: Fri 2026-10-16 18:30 EDT === 22:30Z.
eq(at("2026-10-16T22:29:59Z").isAfterDeadline("2026-10-16"), false, "6:29:59 PM EDT Friday is on time");
eq(at("2026-10-16T22:30:01Z").isAfterDeadline("2026-10-16"), true, "6:30:01 PM EDT Friday is late");
eq(at("2026-10-16T23:00:00Z").isAfterDeadline("2026-10-16"), true, "6:00 PM CDT (7:00 PM EDT) is late");
// The Friday batch at 7:00 PM Eastern === 23:00Z.
eq(at("2026-10-16T22:59:59Z").mostRecentInvoiceFriday(), "2026-10-09", "6:59 PM EDT Friday: the batch still points at last week");
eq(at("2026-10-16T23:00:00Z").mostRecentInvoiceFriday(), "2026-10-16", "7:00 PM EDT Friday: this week's batch");
eq(at("2026-10-17T04:30:00Z").mostRecentInvoiceFriday(), "2026-10-16", "Saturday 12:30 AM EDT: still this Friday");
eq(at("2026-10-16T04:30:00Z").mostRecentInvoiceFriday(), "2026-10-09", "Friday 12:30 AM EDT: last Friday");

// 2. Daylight time ends on Sunday 2026-11-01 (01:00-02:00 EDT happens twice).
eq(S.appStamp(new Date("2026-11-01T05:30:00Z")), "11/01/2026 1:30:00", "1:30 AM EDT stamps as 1:30");
eq(S.appStamp(new Date("2026-11-01T06:30:00Z")), "11/01/2026 1:30:00", "1:30 AM EST (the repeated hour) stamps as 1:30");
eq(S.appStamp(new Date("2026-11-01T07:30:00Z")), "11/01/2026 2:30:00", "2:30 AM EST");
eq(S.appDay(new Date("2026-11-02T04:30:00Z")), "2026-11-01", "Sun 11:30 PM EST is still Sunday");
eq(S.appDay(new Date("2026-11-02T05:30:00Z")), "2026-11-02", "Mon 12:30 AM EST (11:30 PM CST Sunday) is Monday");
eq(S.getWeekRange("2026-11-01T06:30:00Z"), week("2026-10-31", "2026-11-06"), "the repeated hour stays in the week of Oct 31");
eq(at("2026-11-06T23:29:59Z").isAfterDeadline("2026-11-06"), false, "6:29:59 PM EST on the first standard-time Friday is on time");
eq(at("2026-11-06T23:30:01Z").isAfterDeadline("2026-11-06"), true, "6:30:01 PM EST is late");
eq(at("2026-11-06T23:59:59Z").mostRecentInvoiceFriday(), "2026-10-30", "6:59 PM EST: last week's batch");
eq(at("2026-11-07T00:00:00Z").mostRecentInvoiceFriday(), "2026-11-06", "7:00 PM EST: this week's batch");
eq(S.appNoonMs("2026-11-02"), Date.parse("2026-11-02T17:00:00Z"), "noon EST stands for a standard-time day");

// 3. Month end.
// Sat 2026-10-31 23:30 CDT === 2026-11-01T04:30:00Z === Sun 00:30 EDT.
const oct31Central = "2026-11-01T04:30:00Z";
eq(S.appDay(new Date(oct31Central)), "2026-11-01", "Oct 31 11:30 PM CDT is November 1st on the business clock");
eq(at(oct31Central).appMonthKey(), "2026-11", "...so the current month is November");
eq(S.assignmentMonthKey(oct31Central), "2026-11", "...and a truck assignment made then starts in November");
eq(S.assignmentMonthKey("2026-11-01T03:30:00Z"), "2026-10", "Oct 31 11:30 PM EDT is still October");
eq(S.assignmentMonthKey("2026-10-31"), "2026-10", "a bare day is its own month (no zone)");
eq(at("2026-12-01T04:30:00Z").appMonthKey(), "2026-11", "Nov 30 11:30 PM EST is still November");
eq(at("2026-12-01T05:30:00Z").appMonthKey(), "2026-12", "Dec 1 12:30 AM EST is December");
eq(S.getWeekRange("2026-10-31"), week("2026-10-31", "2026-11-06"), "Sat Oct 31 starts the week of Oct 31");

// 4. The ELD ping window of the invoice generator holds every truck-local day of
// the week, wherever the truck was: each US zone's Saturday 00:00 and Friday
// 23:59:59 fall inside [weekStartMs, weekEndMs).
const windowLines = /const weekStartMs = Date\.parse\(weekStart \+ "T00:00:00Z"\);\n\t\tconst weekEndMs = [^\n]+/.exec(SRC);
eq(!!windowLines, true, "the generator's ping window is two lines of calendar arithmetic");
const pingWindow = (weekStart, computedWeekEnd) => new Function("weekStart", "computedWeekEnd",
	`${windowLines[0]}\nreturn [weekStartMs, weekEndMs];`)(weekStart, computedWeekEnd);
const [wStart, wEnd] = pingWindow("2026-10-31", "2026-11-06");
for (const zone of ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"]) {
	const satStart = appTime.wallClockToMs(zone, 2026, 10, 31, 0, 0, 0);
	const friEnd = appTime.wallClockToMs(zone, 2026, 11, 6, 23, 59, 59);
	eq(satStart >= wStart && friEnd < wEnd, true, `the week of Oct 31 holds every ${zone} truck-local day`);
}
// The window it replaced ended at Central midnight: a Pacific truck's Friday
// evening fell outside it.
const centralEnd = appTime.wallClockToMs("America/Chicago", 2026, 11, 7, 0, 0, 0);
eq(appTime.wallClockToMs("America/Los_Angeles", 2026, 11, 6, 23, 0, 0) < centralEnd, false,
	"MUTANT: a Central-midnight window drops Friday 11 PM Pacific");

// 5. APP_TIMEZONE is a setting, not a pin: on America/Chicago the same code
// gives the Houston answers, so the Houston rule fails the assertions above.
const CT = build("America/Chicago", null);
eq(CT.appDay(lateCentral), "2026-10-13", "APP_TIMEZONE=America/Chicago: Tue 11:30 PM CDT is Tuesday");
eq(CT.getWeekRange("2026-10-17T04:30:00Z"), week("2026-10-10", "2026-10-16"), "...and Friday 11:30 PM CDT is still this week");
eq(build("America/Chicago", "2026-10-16T23:00:00Z").isAfterDeadline("2026-10-16"), false, "...and 6:00 PM CDT is on time");
eq(build("America/Chicago", "2026-10-16T23:00:00Z").mostRecentInvoiceFriday(), "2026-10-09", "...and the batch waits for 7 PM CDT");
eq(CT.assignmentMonthKey(oct31Central), "2026-10", "...and Oct 31 11:30 PM CDT is October");
eq(build("UTC", null).appStamp(lateCentral), "10/14/2026 4:30:00", "APP_TIMEZONE=UTC stamps the UTC wall clock");

// 6. No business code names a zone.
const code = (text) => text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const zoneNames = (text) => (code(text).match(/"America\/[A-Za-z_]+"|'America\/[A-Za-z_]+'/g) || []);
eq(zoneNames(SRC), [], "server.js code names no America/* zone");
const libZones = {};
for (const f of fs.readdirSync(path.join(ROOT, "lib")).filter((n) => n.endsWith(".js"))) {
	const z = zoneNames(fs.readFileSync(path.join(ROOT, "lib", f), "utf8"));
	if (z.length) libZones[f] = z;
}
eq(libZones, {
	"app-time.js": ['"America/New_York"'],
	"eld-miles.js": ['"America/New_York"', '"America/Chicago"', '"America/Denver"', '"America/Los_Angeles"'],
	"load-haul.js": ['"America/Chicago"'],
}, "lib/ names a zone only for the default, the truck-location bands and pre-switch stamps");
eq(/const PRE_SWITCH_STAMP_TZ = "America\/Chicago";/.test(fs.readFileSync(path.join(ROOT, "lib", "load-haul.js"), "utf8")), true,
	"load-haul's Houston is the reading of stamps written before the switch");
const clientSrc = fs.readFileSync(path.join(ROOT, "client", "src", "utils", "datetime.js"), "utf8");
const clientSwitch = /const SHEET_STAMP_APP_ZONE_FROM = '(\d{4}-\d{2}-\d{2})'/.exec(clientSrc);
eq(clientSwitch && clientSwitch[1], appTime.SHEET_STAMP_APP_ZONE_FROM, "the client reads stamps with the same switch date");

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
		text = execFileSync(process.execPath, [__filename], { env: { ...process.env, TZ: zone, APP_ZONE_SWITCH_CHILD: "1" }, encoding: "utf8" });
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

console.log(`\n${"-".repeat(60)}`);
console.log(fail ? `FAILED: ${pass} passed, ${fail} failed` : `PASS: ${pass} checks`);
process.exit(fail ? 1 : 0);
