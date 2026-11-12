"use strict";
// THE APP'S TIME ZONE: one business clock for every business date and time:
// "today", the current month, the Sat-Fri invoice week's "now", the Friday
// 6:30 PM submission cutoff, the Friday batch, the Assigned / Status Update
// stamps written into the sheet, and every time shown with a zone label. It is
// never the server's clock zone: production runs in UTC, where "today" is
// already tomorrow from the US evening.
//
// The clock has eras, and nothing stored is ever rewritten across one:
//   - before 2026-08-03 the server's own UTC clock;
//   - 2026-08-03 to 2026-10-08 Houston's (America/Chicago);
//   - from 2026-10-09 US Eastern (America/New_York, the client's decision of
//     2026-10-08), which is also the default;
//   - and, only when BOTH settings are set, the zone APP_TIMEZONE names from the
//     instant APP_TIMEZONE_FROM names (resolveAppTimeZoneSwitch()).
// The sheet stamps' readers keep every era (SHEET_STAMP_APP_ZONE_FROM below,
// wallClockToMsAtSwitch()). A stored INSTANT keeps the reading it has had since
// every rule moved onto one setting: US Eastern before APP_TIMEZONE_FROM, the
// new zone from it (businessZoneAt()). "Now" is the zone in force when the
// process starts (appTimeZone()), so a switch takes one restart.
//
// A bare "YYYY-MM-DD" is a different thing, a calendar date: it never comes
// through here, and never through `new Date(...)` and a zone at all.
//
// Pure apart from reading process.env.APP_TIMEZONE and APP_TIMEZONE_FROM once:
// no other I/O and no requires. scripts/test-calendar-day-zones.js,
// scripts/test-app-timezone-switch.js and scripts/test-central-time-switch.js
// run it under several process zones.

// The business zone from 2026-10-09 until a switch: every stored instant has
// been read on it since then.
const EASTERN_ERA_ZONE = "America/New_York";
const DEFAULT_APP_TIMEZONE = EASTERN_ERA_ZONE;
// US Central: the zone the sheet stamps of 2026-08-03 to 2026-10-08 were written
// in (a historical fact about stored data, not a setting), and the zone the KPI
// schedule's written times are on (lib/kpi-schedule.js).
const CENTRAL_ZONE = "America/Chicago";
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

// ---------------------------------------------------------------------------
// THE SWITCH: APP_TIMEZONE names the business zone from APP_TIMEZONE_FROM, the
// moment of the switch as an ISO instant in UTC ("2026-11-18T02:00:00Z"). The
// two are one setting in two lines: a zone alone would re-read every stored
// instant and stamp on the new clock, so it is refused.

// The first instant of the Eastern era, 2026-10-09 00:00 EDT. A switch from
// before it would re-read days the Eastern era already dated.
const EASTERN_ERA_START_MS = wallClockToMs(EASTERN_ERA_ZONE, 2026, 10, 9, 0, 0, 0);
// Seconds and milliseconds optional; always UTC ("Z").
const SWITCH_FROM_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z$/;

// APP_TIMEZONE_FROM as epoch ms, or null unless it is a real instant in that
// shape (2026-02-30 and 24:00 are not) at or after the Eastern era began.
function switchFromMs(text) {
	const m = SWITCH_FROM_RE.exec(text);
	if (!m) return null;
	const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +(m[7] || "0").padEnd(3, "0"));
	if (new Date(ms).toISOString().slice(0, 19) !== `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}`) return null;
	return ms >= EASTERN_ERA_START_MS ? ms : null;
}

// The switch the two settings in `env` make: { zone, before, fromMs, from }, or
// null for none.
//   - APP_TIMEZONE unset, US Eastern, or a zone this server does not know (one
//     warning, as before): no switch. An APP_TIMEZONE_FROM beside it is ignored
//     with one warning.
//   - APP_TIMEZONE naming another zone, with APP_TIMEZONE_FROM: the switch.
//   - APP_TIMEZONE naming another zone without a readable APP_TIMEZONE_FROM:
//     refused with one warning. The clock stays US Eastern, so a half-done
//     switch never re-reads history.
function resolveAppTimeZoneSwitch(env, warn) {
	const e = env || {};
	const say = (msg) => { if (typeof warn === "function") warn(msg); };
	const zone = resolveAppTimeZone(e.APP_TIMEZONE, warn);
	const fromText = String(e.APP_TIMEZONE_FROM == null ? "" : e.APP_TIMEZONE_FROM).trim();
	if (zone === EASTERN_ERA_ZONE) {
		if (fromText) say(`APP_TIMEZONE_FROM is set, but APP_TIMEZONE names no zone other than ${EASTERN_ERA_ZONE}; it is ignored.`);
		return null;
	}
	const fromMs = switchFromMs(fromText);
	if (fromMs === null) {
		say(`APP_TIMEZONE "${zone}" needs APP_TIMEZONE_FROM, the moment of the switch as an ISO instant in UTC on or after ${new Date(EASTERN_ERA_START_MS).toISOString()} ("2026-11-18T02:00:00Z")${fromText ? `, not ${JSON.stringify(fromText.slice(0, 40))}` : ""}; using ${EASTERN_ERA_ZONE}.`);
		return null;
	}
	return Object.freeze({ zone, before: EASTERN_ERA_ZONE, fromMs, from: new Date(fromMs).toISOString() });
}

// The zone in force at `instant` (a Date or epoch ms) under switch `sw`:
// `sw.before` before its moment, `sw.zone` from it. With no switch, `zone`.
function zoneAtSwitch(sw, instant, zone) {
	if (!sw) return zone;
	return +instant < sw.fromMs ? sw.before : sw.zone;
}

// A wall clock on the business clock under switch `sw`, as epoch ms: read on
// `sw.before` when that instant is before the switch, else on `sw.zone`. The
// hour a move west repeats (20:00-20:59 on the evening of a switch at 20:00
// Central) reads as its first instant, the one before the switch, as the
// repeated hour of a fall-back does in wallClockToMs(). With no switch, on `zone`.
function wallClockToMsAtSwitch(sw, zone, y, mo, d, h, mi, s) {
	if (!sw) return wallClockToMs(zone, y, mo, d, h, mi, s);
	const before = wallClockToMs(sw.before, y, mo, d, h, mi, s);
	return before < sw.fromMs ? before : wallClockToMs(sw.zone, y, mo, d, h, mi, s);
}

// This process's switch, resolved once on first use (warning once).
let resolvedSwitch;
function appTimeZoneSwitch() {
	if (resolvedSwitch === undefined) resolvedSwitch = resolveAppTimeZoneSwitch(process.env, (msg) => console.warn(msg));
	return resolvedSwitch;
}

// The zone this process runs "now" on: the one in force when it first asks,
// which is when it starts (server.js reads it at boot). server.js and every
// lib/ module read it here, so they cannot disagree. A process started before
// APP_TIMEZONE_FROM keeps the zone before it until a restart.
let resolvedZone = null;
function appTimeZone() {
	if (resolvedZone == null) {
		const sw = appTimeZoneSwitch();
		resolvedZone = !sw ? DEFAULT_APP_TIMEZONE : (Date.now() >= sw.fromMs ? sw.zone : sw.before);
		if (sw && resolvedZone === sw.before) console.warn(`APP_TIMEZONE_FROM ${sw.from} is after this process started: "now" stays on ${sw.before} until a restart at or after it.`);
	}
	return resolvedZone;
}

// The zone a STORED instant is read on: the one in force when it happened, so a
// switch moves no past item to another day, week or month. With no switch,
// `zone` (the caller's APP_TIMEZONE).
function businessZoneAt(instant, zone = appTimeZone()) {
	return zoneAtSwitch(appTimeZoneSwitch(), instant, zone);
}

// The business day a stored instant falls on, on the clock in force then.
function businessDayOf(instant, zone = appTimeZone()) {
	return dayInZone(instant, businessZoneAt(instant, zone));
}

// A business wall clock (a day's noon or midnight, a stamp) as epoch ms, on the
// clock in force at it (wallClockToMsAtSwitch()).
function businessWallClockToMs(zone, y, mo, d, h, mi, s) {
	return wallClockToMsAtSwitch(appTimeZoneSwitch(), zone, y, mo, d, h, mi, s);
}

// The business day (APP_TIMEZONE) an instant falls on, "YYYY-MM-DD"; today's by
// default. server.js keeps its own self-contained appDay() and appStamp() (test
// runners lift them out of the file); lib/ modules use this one.
function appDay(instant = new Date()) {
	return dayInZone(instant, appTimeZone());
}

// Words that name the business zone follow it: "Eastern" / "ET" and "Central" /
// "CT" for the two zones the clock has run on. Any other zone has none, and the
// text names it as itself.
const ZONE_WORDS = Object.freeze({
	[EASTERN_ERA_ZONE]: Object.freeze({ word: "Eastern", short: "ET" }),
	[CENTRAL_ZONE]: Object.freeze({ word: "Central", short: "CT" }),
});
function zoneWords(timeZone) {
	return Object.prototype.hasOwnProperty.call(ZONE_WORDS, timeZone) ? ZONE_WORDS[timeZone] : null;
}

// ---------------------------------------------------------------------------
// THE DAY THE BUSINESS CLOCK MOVED TO US EASTERN.
//
// "Assigned Date", "Status Update Date" and "Completion Date" are bare wall
// clocks with no zone. The server wrote them on its own UTC clock before
// 2026-08-03, on Houston's (America/Chicago) from then, on US Eastern's from
// this date (the day the Eastern release reached production), and on
// APP_TIMEZONE's from APP_TIMEZONE_FROM. Stored stamps are never rewritten, and
// the DATE of a stamp is always read as written (sheetDayKey, moneySheetDate):
// the business day a stamp was given is the day it counts on. Only code that
// needs a stamp's true INSTANT (lib/load-haul.js's ping window; the client's
// parseSheetStamp in utils/datetime.js, which keeps the same date) reads the era
// from it. A stamp written that day before the release is read an hour early,
// which no day or month depends on.
const SHEET_STAMP_APP_ZONE_FROM = "2026-10-09";

module.exports = {
	DEFAULT_APP_TIMEZONE,
	EASTERN_ERA_ZONE,
	CENTRAL_ZONE,
	SHEET_STAMP_APP_ZONE_FROM,
	resolveAppTimeZone,
	resolveAppTimeZoneSwitch,
	appTimeZone,
	appTimeZoneSwitch,
	zoneAtSwitch,
	wallClockToMsAtSwitch,
	businessZoneAt,
	businessDayOf,
	businessWallClockToMs,
	zoneWords,
	dayInZone,
	dateTextInZone,
	wallClockToMs,
	appDay,
};
