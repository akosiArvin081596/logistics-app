"use strict";
// IS A LIVE ETA ON TIME? The customer tracker's On time / Delayed badge
// (GET /api/public/track/:loadId) and the Tracking tab's on-time / delayed
// status (GET /api/locations/latest) judge the truck's expected arrival against
// the load's Drop-off Appointment. Both read the cell here.
//
//   etaVerdict(expectedArrivalMs, appointmentText, { destAddress, destLat, destLng })
//       -> null | { onTime, zone, zoneSource, deadlineMs, arrivalLocal }
//   etaOnTime(expectedArrivalMs, appointmentText, { destAddress, destLat, destLng }) -> true | false | null
//
// WHOSE CLOCK. Rate cons state an appointment in the facility's local time, so
// the cell is read on the receiver's clock (user, 2026-10-15), placed by
// lib/stop-zone.js through lib/kpi-appointments.js parseAppointment(), the
// on-time KPI's own reading: the zone the cell writes ("08:00 CST"), else the
// receiver's state (its address, else its coordinates; Arizona, and the states
// with two zones, as that file says), else its longitude band. Only when none of
// them tells is it read on the business clock, APP_TIMEZONE (US Eastern). Never the server's: new Date("10/15/2026 14:00") on
// the UTC server is 10 AM Eastern, which called a truck delayed hours early.
// The truck's ETA is an instant; `arrivalLocal` is it on that same clock, with
// the zone's abbreviation ("Oct 15, 1:30 PM CDT"), so the time shown beside the
// verdict is the one the appointment is compared with.
//
// THE DEADLINE. One time: that time. A window ("08:00 - 14:00"): its end, as
// arriving inside the window is on time. A date with no time, or FCFS: the end of
// that day. A cell it cannot read (blank, no year, free text) gives no verdict,
// never a guess.
//
// Pure: no I/O.

const { parseAppointment } = require("./kpi-appointments");
const appTime = require("./app-time");

// The Job Tracking column holding the receiver's appointment ("Drop-off
// Appointment"), the same match the haul close-out reads it with.
const DROPOFF_APPOINTMENT_COL_RE = /(drop.?off|deliver|dest|receiver).*appoint/i;

const formatters = new Map();
function arrivalText(ms, zone) {
	let f = formatters.get(zone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
		});
		formatters.set(zone, f);
	}
	return f.format(new Date(ms));
}

function finiteOrNull(v) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function etaVerdict(expectedArrivalMs, appointmentText, opts) {
	const arrival = finiteOrNull(expectedArrivalMs);
	if (arrival === null) return null;
	const o = opts || {};
	const appt = parseAppointment(appointmentText, {
		destAddress: o.destAddress,
		destLat: finiteOrNull(o.destLat),
		destLng: finiteOrNull(o.destLng),
		fallbackZone: appTime.appTimeZone(),
	});
	if (appt.status !== "ok") return null;
	let deadlineMs = appt.deadlineMs;
	if (deadlineMs == null) {
		const [y, mo, d] = appt.day.split("-").map(Number);
		deadlineMs = appTime.wallClockToMs(appt.zone, y, mo, d, 23, 59, 59) + 999;
	}
	return {
		onTime: arrival <= deadlineMs,
		zone: appt.zone,
		zoneSource: appt.zoneSource,
		deadlineMs,
		arrivalLocal: arrivalText(arrival, appt.zone),
	};
}

function etaOnTime(expectedArrivalMs, appointmentText, opts) {
	const v = etaVerdict(expectedArrivalMs, appointmentText, opts);
	return v ? v.onTime : null;
}

module.exports = {
	DROPOFF_APPOINTMENT_COL_RE,
	etaVerdict,
	etaOnTime,
};
