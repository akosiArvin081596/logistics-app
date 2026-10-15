"use strict";
// ON-TIME DELIVERY: reading a load's recorded drop-off appointment and judging
// the truck's arrival at the receiver against it, for the KPI bot's
// on_time_rate.
//
//   parseAppointment(text, { destAddress, destLat, destLng, refDay }) -> what the appointment says
//   judgeArrival({ appointmentText, destAddress, destLat, destLng, eldArriveMs, receiverEvents, deliveredDay })
//       -> { status, kind, strictOnTime, dayOnTime, flipsWithin1h }
//
// WHAT AN APPOINTMENT CAN BE. The Drop-off Appointment cell holds what the
// rate-con extractor read, as "M/D/YYYY HH:MM" (24-hour) by its prompt, but real
// cells also carry "8:00 AM", a window ("08:00-14:00", "8:00 AM - 2:00 PM",
// "0800-1600"), a bare date, "FCFS", an ISO date, a written zone ("08:00 CST")
// or a copied prefix ("Date:", "Appt.", "Delivery:"). Each is one kind:
//   timed      one time: the deadline is that instant
//   window     a time range: the deadline is the window's END (arriving inside
//              the window is on time)
//   date_only  a date with no time: judged by day only
//   fcfs       first come first served, or "open" with no window: judged by
//              day only ("Receiving open 0700-1500" is a window)
//   unparseable  anything else, left out and counted
//
// WHOSE CLOCK. An appointment is a wall-clock time at the receiver's dock
// (lib/stop-zone.js stopZone()): the zone written in the text when there is one,
// else the receiver's state (from its address, else its coordinates; Arizona
// keeps no summer time, and the states with two zones are split by where the stop
// is), else its longitude band (usTzForLongitude() in lib/eld-miles.js), never
// the business zone (APP_TIMEZONE) and never the server's. A receiver nothing
// places is left out ('no_zone'). Two callers pass APP_TIMEZONE as `fallbackZone`: the KPI deadhead
// chain (lib/kpi-deadhead.js), which orders loads rather than judging them, and
// the live ETA verdict (lib/eta-on-time.js), which reads the appointment on the
// receiver's clock like this module and only falls back to the business clock
// when no zone can be told. The on-time rate never passes it. Abbreviations name the region, not a fixed offset: rate cons
// write "CST" all year, and the zone database decides whether that day is CDT.
// Deadlines become instants through wallClockToMs() in lib/app-time.js.
//
// WHY THE YEAR IS CHECKED AGAINST THE ARRIVAL. The extractor invents years
// (lib/ratecon-normalize.js anchorAppointmentYear()), so an appointment more
// than 3 days from the day the truck arrived is a misread date, not a load that
// was 9 months late: it is left out ('implausible') and counted. A 2-digit year
// is 20YY; a missing year takes the year nearest the arrival.
//
// THE ARRIVAL. The ELD arrival (load_eld_miles.dest_arrive_ms) when it is a real
// instant (0 or missing is no arrival), else the earliest geofence "At Receiver"
// event. A status a driver taps by hand is when they tapped it, not when the
// truck arrived, so manual events are never arrivals. Event stamps are SQLite's
// "YYYY-MM-DD HH:MM:SS", which is UTC with no Z: they are read as UTC, never
// through new Date(text) (local time on any server not in UTC).
//
// THE VERDICTS. strictOnTime: arrival at or before the deadline (null for
// date-only and FCFS). dayOnTime: the arrival's day at the receiver is on or
// before the appointment's day. flipsWithin1h: the strict verdict would change if
// the deadline moved by an hour either way, the measure of how much a verdict
// rests on minutes.
//
// Pure: no I/O. Requires lib/eld-miles.js (zone bands, local day) and
// lib/app-time.js (wall clock -> instant), both pure.

const { localDayInTz } = require("./eld-miles");
const { wallClockToMs } = require("./app-time");
const { stopZone } = require("./stop-zone");

// Characters of appointment text read; the cell is short, anything longer is noise.
const MAX_APPT_CHARS = 200;
// An appointment further than this from the arrival day is a misread date.
const PLAUSIBLE_DAYS = 3;
const FLIP_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PREFIX_RE = /^(?:\s{0,5}(?:date|appt\.?|appointment|delivery|deliver|del\.|drop[-\s]?off)\s{0,3}[:#-]?\s{0,3}){1,3}/i;
// First come, first served. "Open" alone ("10/15/2026 open") is the same, but
// "Receiving open 0700-1500" names a window, read as one.
const FCFS_RE = /\b(?:fcfs|f\.c\.f\.s\.?|first\s{1,3}come(?:,?\s{1,3}first\s{1,3}serve[ds]?)?)\b/i;
const OPEN_RE = /\bopen\b/i;
const ISO_DATE_RE = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?![\d-])/;
const MDY_DATE_RE = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/;
const MDY_DASH_DATE_RE = /(?<![\d-])(\d{1,2})-(\d{1,2})-(\d{4}|\d{2})(?![\d-])/;
// A time: "08:00", "8:00:00", "0800", "8 AM", each with an optional AM/PM.
const TIME_RE = /(?<![\d:])(?:(\d{1,2}):([0-5]\d)(?::[0-5]\d)?|([01]\d|2[0-3])([0-5]\d)|(\d{1,2})(?=\s{0,2}[ap]\.?\s?m\b))(?:\s{0,2}([ap])\.?\s?m\b\.?)?(?![\d:])/gi;
const WINDOW_SEP_RE = /^\s{0,3}(?:-|–|—|~|to|until|thru|through)\s{0,3}$/i;
const EVENT_STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,6})?Z?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad2 = (n) => String(n).padStart(2, "0");

// Calendar arithmetic on date keys anchored at 12:00 UTC.
function dayKey(y, mo, d) {
	return `${y}-${pad2(mo)}-${pad2(d)}`;
}
function dayNoon(day) {
	return Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), 12);
}
function daysApart(a, b) {
	return Math.round((dayNoon(b) - dayNoon(a)) / DAY_MS);
}
function isCalendarDate(y, mo, d) {
	if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return false;
	const t = new Date(Date.UTC(y, mo - 1, d, 12));
	return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
function nextDay(y, mo, d) {
	const t = new Date(Date.UTC(y, mo - 1, d, 12) + DAY_MS);
	return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

// The appointment text as read: capped, prefix stripped, whitespace collapsed.
function cleanText(text) {
	let s = typeof text === "string" ? text : String(text == null ? "" : text);
	if (s.length > MAX_APPT_CHARS) s = s.slice(0, MAX_APPT_CHARS);
	return s.replace(/\s{1,200}/g, " ").trim().replace(PREFIX_RE, "").trim();
}

// The receiver's clock (lib/stop-zone.js): written in the text, else its state
// (address, else coordinates), else its longitude band; null when none tells.
// `where` is { destAddress, destLat, destLng }.
function receiverZone(s, where) {
	const w = where || {};
	return stopZone({ text: s, address: w.destAddress, lat: w.destLat, lng: w.destLng });
}

// 12-hour clock to 24-hour: 12 AM is midnight, 12 PM is noon.
function to24(h, ap) {
	if (!ap) return h;
	if (h === 12) return ap === "a" ? 0 : 12;
	return ap === "p" ? h + 12 : h;
}

// Up to three times in the text after the date, with where each sits.
function parseTimes(rest) {
	const out = [];
	TIME_RE.lastIndex = 0;
	let m;
	while ((m = TIME_RE.exec(rest)) !== null && out.length < 3) {
		const ap = m[6] ? m[6].toLowerCase() : null;
		let h;
		let mi;
		if (m[1] != null) { h = +m[1]; mi = +m[2]; } else if (m[3] != null) { h = +m[3]; mi = +m[4]; } else { h = +m[5]; mi = 0; }
		if (ap ? !(h >= 1 && h <= 12) : !(h >= 0 && h <= 23)) return null;
		out.push({ h: to24(h, ap), mi, start: m.index, end: m.index + m[0].length });
	}
	return out;
}

// The date in the text: { y, mo, d, rest } with the date cut out of the text, or
// null. A missing year takes the year nearest refDay (none without one).
function parseDate(s, refDay) {
	let m = ISO_DATE_RE.exec(s);
	let y;
	let mo;
	let d;
	if (m) {
		y = +m[1]; mo = +m[2]; d = +m[3];
	} else if ((m = MDY_DATE_RE.exec(s)) || (m = MDY_DASH_DATE_RE.exec(s))) {
		mo = +m[1]; d = +m[2];
		if (m[3] != null) {
			y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
		} else {
			if (!refDay || !DAY_RE.test(refDay)) return null;
			const ry = +refDay.slice(0, 4);
			let best = null;
			for (const cand of [ry - 1, ry, ry + 1]) {
				if (!isCalendarDate(cand, mo, d)) continue;
				const gap = Math.abs(daysApart(refDay, dayKey(cand, mo, d)));
				if (best == null || gap < best.gap) best = { y: cand, gap };
			}
			if (!best) return null;
			y = best.y;
		}
	} else {
		return null;
	}
	if (!isCalendarDate(y, mo, d)) return null;
	return { y, mo, d, rest: `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}` };
}

// What an appointment says.
//   { status: 'ok', kind, zone, zoneSource, day, deadlineMs, startMs }
//        deadlineMs and startMs null for date_only / fcfs; startMs is a window's
//        start, and equals deadlineMs for one time
//   { status: 'unparseable' | 'no_zone' | 'implausible', kind, zone, day, deadlineMs, startMs }
// refDay (the arrival's day at the receiver, 'YYYY-MM-DD') anchors a missing year
// and decides 'implausible'; without it neither applies.
// destAddress, destLat and destLng place the receiver (lib/stop-zone.js).
// fallbackZone (the KPI deadhead chain and the live ETA verdict pass APP_TIMEZONE;
// the on-time rate never passes it) is the clock used when neither the text nor
// the receiver's place tells one, instead of 'no_zone'. zoneSource says which
// clock was used: 'text', 'state', 'band' (the longitude) or 'fallback'.
function parseAppointment(text, opts) {
	const o = opts && typeof opts === "object" ? opts : {};
	const refDay = typeof o.refDay === "string" && DAY_RE.test(o.refDay) ? o.refDay : null;
	const fallbackZone = typeof o.fallbackZone === "string" && o.fallbackZone.trim() ? o.fallbackZone.trim() : null;
	const fail = (status, kind, zone, day) => ({ status, kind, zone: zone || null, day: day || null, deadlineMs: null, startMs: null });
	const s = cleanText(text);
	if (!s) return fail("unparseable", "unparseable");
	const date = parseDate(s, refDay);
	if (!date) return fail("unparseable", "unparseable");
	const day = dayKey(date.y, date.mo, date.d);

	let kind;
	let times = [];
	if (FCFS_RE.test(s)) {
		kind = "fcfs";
	} else {
		const open = OPEN_RE.test(s);
		times = parseTimes(date.rest);
		const isWindow = !!times && times.length === 2 && WINDOW_SEP_RE.test(date.rest.slice(times[0].end, times[1].start));
		if (open && !isWindow) return finish("fcfs");
		if (!times) return fail("unparseable", "unparseable", null, day);
		if (times.length === 0) return finish("date_only");
		if (times.length === 1) {
			kind = "timed";
		} else if (isWindow) {
			kind = "window";
		} else {
			return fail("unparseable", "unparseable", null, day);
		}
	}
	return finish(kind);

	function finish(k) {
		const sensed = receiverZone(s, o);
		const zone = sensed ? sensed.zone : fallbackZone;
		if (!zone) return fail("no_zone", k, null, day);
		const zoneSource = sensed ? sensed.source : "fallback";
		if (refDay && Math.abs(daysApart(refDay, day)) > PLAUSIBLE_DAYS) return fail("implausible", k, zone, day);
		if (k === "date_only" || k === "fcfs") return { status: "ok", kind: k, zone, zoneSource, day, deadlineMs: null, startMs: null };
		const t = k === "window" ? windowEnd(times) : times[0];
		const [y, mo, d] = t.nextDay ? nextDay(date.y, date.mo, date.d) : [date.y, date.mo, date.d];
		const deadlineMs = wallClockToMs(zone, y, mo, d, t.h, t.mi, 0);
		const opening = times[0];
		const startMs = k === "window" ? wallClockToMs(zone, date.y, date.mo, date.d, opening.h, opening.mi, 0) : deadlineMs;
		return { status: "ok", kind: k, zone, zoneSource, day, deadlineMs, startMs };
	}
}

// A window's end; an end at or before its start runs past midnight ("22:00-02:00").
function windowEnd(times) {
	const [start, end] = times;
	const nextDayEnd = end.h * 60 + end.mi <= start.h * 60 + start.mi;
	return { h: end.h, mi: end.mi, nextDay: nextDayEnd };
}

// A SQLite stamp ("YYYY-MM-DD HH:MM:SS", UTC with no Z) as epoch ms, or null.
function utcStampMs(at) {
	const m = EVENT_STAMP_RE.exec(String(at == null ? "" : at).trim());
	if (!m) return null;
	const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
	return Number.isFinite(ms) ? ms : null;
}

// When the truck reached the receiver: the ELD arrival when it is a real instant,
// else the earliest geofence event, else null.
function arrivalMs(eldArriveMs, receiverEvents) {
	if (typeof eldArriveMs === "number" && Number.isFinite(eldArriveMs) && eldArriveMs > 0) return eldArriveMs;
	let first = null;
	for (const e of Array.isArray(receiverEvents) ? receiverEvents : []) {
		if (!e || String(e.source == null ? "" : e.source).trim().toLowerCase() !== "geofence") continue;
		const ms = utcStampMs(e.at);
		if (ms != null && (first == null || ms < first)) first = ms;
	}
	return first;
}

function onTimeBy(arrival, deadline) {
	return arrival <= deadline;
}

// One delivered load's verdict.
//   status 'judged'       verdicts set
//   status 'unparseable'  the appointment cannot be read
//   status 'no_zone'      no zone in the text and no receiver place (address,
//                         coordinates) to tell one
//   status 'no_arrival'   no ELD arrival and no geofence arrival
//   status 'implausible'  the appointment is more than 3 days from the arrival
// Only 'judged' has verdicts; every other status has strictOnTime and dayOnTime
// null and flipsWithin1h false. deliveredDay ('YYYY-MM-DD') anchors a year-less
// appointment when there is no arrival to anchor it. destAddress, destLat and
// destLng place the receiver.
function judgeArrival(input) {
	const a = input && typeof input === "object" ? input : {};
	const out = (status, kind, strictOnTime, dayOnTime, flipsWithin1h) => ({
		status, kind, strictOnTime: strictOnTime == null ? null : strictOnTime,
		dayOnTime: dayOnTime == null ? null : dayOnTime, flipsWithin1h: !!flipsWithin1h,
	});
	const s = cleanText(a.appointmentText);
	const place = receiverZone(s, a);
	const zone = place ? place.zone : null;
	const arrival = arrivalMs(a.eldArriveMs, a.receiverEvents);
	const deliveredDay = typeof a.deliveredDay === "string" && DAY_RE.test(a.deliveredDay) ? a.deliveredDay : null;
	const arrivalDay = arrival != null && zone ? localDayInTz(arrival, zone) : null;

	const appt = parseAppointment(a.appointmentText, {
		destLng: a.destLng, destLat: a.destLat, destAddress: a.destAddress, refDay: arrivalDay || deliveredDay,
	});
	if (appt.status === "unparseable") return out("unparseable", "unparseable");
	if (appt.status === "no_zone") return out("no_zone", appt.kind);
	if (arrival == null) return out("no_arrival", appt.kind);
	if (appt.status === "implausible") return out("implausible", appt.kind);

	const dayOnTime = arrivalDay <= appt.day;
	if (appt.deadlineMs == null) return out("judged", appt.kind, null, dayOnTime, false);
	const strictOnTime = onTimeBy(arrival, appt.deadlineMs);
	const flipsWithin1h = onTimeBy(arrival, appt.deadlineMs - FLIP_MS) !== strictOnTime
		|| onTimeBy(arrival, appt.deadlineMs + FLIP_MS) !== strictOnTime;
	return out("judged", appt.kind, strictOnTime, dayOnTime, flipsWithin1h);
}

module.exports = {
	MAX_APPT_CHARS,
	PLAUSIBLE_DAYS,
	parseAppointment,
	judgeArrival,
	arrivalMs,
	utcStampMs,
};
