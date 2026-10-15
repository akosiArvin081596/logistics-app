"use strict";
// IS A LIVE ETA ON TIME? The customer tracker's On time / Delayed badge
// (GET /api/public/track/:loadId) and the Tracking tab's on-time / delayed
// status (GET /api/locations/latest) judge the truck's expected arrival against
// the load's Drop-off Appointment. Both read the cell here.
//
//   etaOnTime(expectedArrivalMs, appointmentText) -> true | false | null
//   appointmentDeadlineMs(appointmentText)        -> epoch ms | null
//
// WHOSE CLOCK. The appointment is a wall clock on the business clock,
// APP_TIMEZONE (US Eastern), unless the cell writes its own zone ("08:00 CST").
// Never the server's: new Date("10/15/2026 14:00") on the UTC server is 10 AM
// Eastern, which called a truck delayed four hours early.
//
// THE DEADLINE. One time: that time. A window ("08:00 - 14:00"): its end, as
// arriving inside the window is on time. A date with no time, or FCFS: the end of
// that day. The cell shapes are lib/kpi-appointments.js parseAppointment()'s.
// A cell it cannot read (blank, no year, free text) gives no verdict, never a
// guess.
//
// Pure: no I/O.

const { parseAppointment } = require("./kpi-appointments");
const appTime = require("./app-time");

// The Job Tracking column holding the receiver's appointment ("Drop-off
// Appointment"), the same match the haul close-out reads it with.
const DROPOFF_APPOINTMENT_COL_RE = /(drop.?off|deliver|dest|receiver).*appoint/i;

function appointmentDeadlineMs(appointmentText) {
	const appt = parseAppointment(appointmentText, { fallbackZone: appTime.appTimeZone() });
	if (appt.status !== "ok") return null;
	if (appt.deadlineMs != null) return appt.deadlineMs;
	const [y, mo, d] = appt.day.split("-").map(Number);
	return appTime.wallClockToMs(appt.zone, y, mo, d, 23, 59, 59) + 999;
}

function etaOnTime(expectedArrivalMs, appointmentText) {
	const arrival = Number(expectedArrivalMs);
	if (expectedArrivalMs == null || !Number.isFinite(arrival)) return null;
	const deadline = appointmentDeadlineMs(appointmentText);
	return deadline == null ? null : arrival <= deadline;
}

module.exports = {
	DROPOFF_APPOINTMENT_COL_RE,
	appointmentDeadlineMs,
	etaOnTime,
};
