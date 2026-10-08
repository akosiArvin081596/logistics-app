"use strict";
// THE APP'S TIME ZONE: one setting, APP_TIMEZONE, for turning an INSTANT into a
// CALENDAR DATE when no business rule already pins a zone (a document's "today",
// for example). Unset, it is America/New_York, so EST and EDT follow the zone
// database on their own. It is never the server's clock zone: production runs in
// UTC, where "today" is already tomorrow from 8 PM Eastern (7 PM in winter), so a
// Friday-evening invoice printed "Friday, Oct 3" for a Friday that was Oct 2.
//
// A bare "YYYY-MM-DD" is a different thing, a calendar date: it never comes
// through here, and never through `new Date(...)` and a zone at all.
//
// Pure: no I/O and no requires. scripts/test-calendar-day-zones.js runs it under
// several process zones.

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

// The calendar day of an instant in `timeZone`, as "YYYY-MM-DD".
function dayInZone(instant, timeZone) {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

// An instant's date as text in `timeZone` ("Oct 2, 2026" with the default
// options), for documents that print "today".
function dateTextInZone(instant, timeZone, options) {
	return instant.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", ...(options || {}), timeZone });
}

module.exports = { DEFAULT_APP_TIMEZONE, resolveAppTimeZone, dayInZone, dateTextInZone };
