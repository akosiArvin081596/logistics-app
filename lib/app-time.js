"use strict";
// THE APP'S TIME ZONE: one setting, APP_TIMEZONE, for every business date and
// time: "today", the current month, the Sat-Fri invoice week's "now", the Friday
// 6:30 PM submission cutoff, the Friday batch, the Assigned / Status Update
// stamps written into the sheet, and every time shown with a zone label. Unset,
// it is America/New_York (the client's decision of 2026-10-08, replacing the
// Houston rule of 2026-08-04), so EST and EDT follow the zone database on their
// own. It is never the server's clock zone: production runs in UTC, where "today"
// is already tomorrow from 8 PM Eastern (7 PM in winter).
//
// A bare "YYYY-MM-DD" is a different thing, a calendar date: it never comes
// through here, and never through `new Date(...)` and a zone at all.
//
// Pure apart from reading process.env.APP_TIMEZONE once: no other I/O and no
// requires. scripts/test-calendar-day-zones.js and scripts/test-app-timezone-switch.js
// run it under several process zones.

const DEFAULT_APP_TIMEZONE = "America/New_York";
// An IANA region name ("America/New_York") or "UTC". Intl also takes offsets and
// abbreviations ("-0400", "EST"), which never follow daylight time and which a
// browser may not accept; the client (utils/datetime.js) uses the same test.
const APP_TIMEZONE_RE = /^(?:UTC|[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)+)$/;

// An IANA zone name the runtime knows, or the default. A value that names no
// such zone takes the default with one warning instead of stopping the server.
function resolveAppTimeZone(value, warn) {
	const tz = String(value == null ? "" : value).trim();
	if (!tz) return DEFAULT_APP_TIMEZONE;
	const refuse = () => {
		if (typeof warn === "function") warn(`APP_TIMEZONE "${tz}" is not an IANA time zone this server knows; using ${DEFAULT_APP_TIMEZONE}.`);
		return DEFAULT_APP_TIMEZONE;
	};
	if (!APP_TIMEZONE_RE.test(tz)) return refuse();
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return tz;
	} catch (_e) {
		return refuse();
	}
}

// The zone this process runs the business in: APP_TIMEZONE, resolved once, on
// first use (warning once if it names no zone). server.js and every lib/ module
// read it here, so they cannot disagree.
let resolvedZone = null;
function appTimeZone() {
	if (resolvedZone == null) resolvedZone = resolveAppTimeZone(process.env.APP_TIMEZONE, (msg) => console.warn(msg));
	return resolvedZone;
}

// One formatter per zone and shape: building an Intl.DateTimeFormat costs far
// more than using one, and some callers run per row.
const formatters = new Map();
function formatter(timeZone, kind) {
	const key = `${kind}|${timeZone}`;
	let f = formatters.get(key);
	if (!f) {
		f = kind === "day"
			? new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
			: new Intl.DateTimeFormat("en-US", {
				timeZone, weekday: "short",
				year: "numeric", month: "2-digit", day: "2-digit",
				hour: "2-digit", minute: "2-digit", second: "2-digit",
				hourCycle: "h23",
			});
		formatters.set(key, f);
	}
	return f;
}

// The calendar day of an instant in `timeZone`, as "YYYY-MM-DD".
function dayInZone(instant, timeZone) {
	return formatter(timeZone, "day").format(instant);
}

// An instant's wall clock in `timeZone`, as strings, straight from the zone
// database (DST-safe; never a re-parsed locale string):
// { weekday: "Fri", year: "2026", month: "10", day: "09", hour: "18", minute: "30", second: "00" }.
function partsInZone(instant, timeZone) {
	const p = {};
	for (const x of formatter(timeZone, "parts").formatToParts(instant)) p[x.type] = x.value;
	return p;
}

// An instant's date as text in `timeZone` ("Oct 2, 2026" with the default
// options), for documents that print "today".
function dateTextInZone(instant, timeZone, options) {
	return instant.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", ...(options || {}), timeZone });
}

// A wall clock in `timeZone` -> epoch ms. The first offset is looked up at the
// wrong instant, which only matters within the hour of a DST change; the second
// pass settles it. In the repeated hour of a fall-back it returns the first of the
// two instants; a wall clock in the skipped hour of a spring-forward has no
// instant, and comes back an hour earlier (2:30 AM reads as 1:30 AM standard).
function wallClockToMs(timeZone, y, mo, d, h, mi, s) {
	const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0);
	const offsetAt = (ms) => {
		const p = partsInZone(new Date(ms), timeZone);
		return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
	};
	const first = offsetAt(guess);
	const ms = guess - first;
	const second = offsetAt(ms);
	return second === first ? ms : guess - second;
}

// The business day (APP_TIMEZONE) an instant falls on, "YYYY-MM-DD"; today's by
// default. server.js keeps its own self-contained appDay() and appStamp() (test
// runners lift them out of the file); lib/ modules use this one.
function appDay(instant = new Date()) {
	return dayInZone(instant, appTimeZone());
}

// ---------------------------------------------------------------------------
// THE DAY THE BUSINESS CLOCK MOVED TO APP_TIMEZONE.
//
// "Assigned Date", "Status Update Date" and "Completion Date" are bare wall
// clocks with no zone. The server wrote them on its own UTC clock before
// 2026-08-03, on Houston's (America/Chicago) from then, and on APP_TIMEZONE's
// from this date: the day the Eastern release reached production. Stored stamps
// are never rewritten, and the DATE of a stamp is always read as written
// (sheetDayKey, moneySheetDate): the business day a stamp was given is the day it
// counts on. Only code that needs a stamp's true INSTANT (lib/load-haul.js's ping
// window; the client's parseSheetStamp in utils/datetime.js, which keeps the same
// date) reads the era from it. A stamp written that day before the release is
// read an hour early, which no day or month depends on.
const SHEET_STAMP_APP_ZONE_FROM = "2026-10-09";

module.exports = {
	DEFAULT_APP_TIMEZONE,
	SHEET_STAMP_APP_ZONE_FROM,
	resolveAppTimeZone,
	appTimeZone,
	dayInZone,
	dateTextInZone,
	wallClockToMs,
	appDay,
};
