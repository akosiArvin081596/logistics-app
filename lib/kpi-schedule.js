"use strict";
// WHEN THE KPI BOT RUNS: the nightly snapshot and the weekly digest.
//
// The snapshot is due at 04:00 on the business clock (APP_TIMEZONE, US Eastern
// unless set), which is 03:00 US Central all year: both zones change their
// clocks on the same night, so the hour between them never moves. The digest is
// due on Monday at 09:00 business time (08:00 Central).
//
// Every slot is a WALL CLOCK in the business zone turned into an instant by
// lib/app-time.js wallClockToMs(), never a server-local Date: production runs in
// UTC, where 04:00 local would be midnight Eastern in summer and 11 PM the
// evening before in winter. The weekday is the business day's own weekday, read
// off its calendar date, never the server's getDay(): at 10 PM on a Sunday in
// New York the server in UTC is already on Monday.
//
// Days are stepped as calendar dates anchored at 12:00 UTC (addDays()), never
// as "minus 24 hours" of an instant: the Sunday a DST change happens is 23 or
// 25 hours long, and an instant stepped by whole days from late that evening
// lands on the wrong date.
//
// Catch-up rules:
//   - snapshot: a missed 04:00 slot is caught up later the SAME business day
//     (a restart at 3 PM still takes that day's snapshot). A day that passed
//     entirely with the server down is not run afterwards: a snapshot is the
//     state of the system on the day it is taken.
//   - digest: a missed Monday slot is caught up within 6 hours of 09:00;
//     after that it is "missed" and the caller records it as such, so a
//     restart on Tuesday never mails a late "Monday" digest.
//
// Pure: no I/O. The zone is always an argument; lib/app-time.js is the only
// require.

const { dayInZone, wallClockToMs } = require("./app-time");

const SNAPSHOT_HOUR = 4;
const DIGEST_HOUR = 9;
const DIGEST_CATCH_UP_MS = 6 * 60 * 60 * 1000;

function dayParts(day) {
	const [y, m, d] = String(day).split("-").map(Number);
	return { y, m, d };
}

// The calendar date `n` days from `day` ("YYYY-MM-DD"), anchored at 12:00 UTC so
// no zone and no DST change can move it.
function addDays(day, n) {
	const { y, m, d } = dayParts(day);
	return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

// 0 = Sunday … 6 = Saturday, of a calendar date.
function weekdayOf(day) {
	const { y, m, d } = dayParts(day);
	return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

// The instant of `hour`:00 on business day `day` in `tz`.
function slotOn(day, hour, tz) {
	const { y, m, d } = dayParts(day);
	return wallClockToMs(tz, y, m, d, hour, 0, 0);
}

// Today's snapshot slot: the business day `nowMs` falls on, its 04:00, and
// whether that moment has come.
function snapshotSlot(nowMs, tz) {
	const day = dayInZone(new Date(nowMs), tz);
	const slotMs = slotOn(day, SNAPSHOT_HOUR, tz);
	return { day, slotMs, due: nowMs >= slotMs };
}

// Is a scheduled snapshot owed now? `lastSnapshotDay` is the business day of the
// last scheduled snapshot that succeeded (null when there is none).
function snapshotDue({ nowMs, tz, lastSnapshotDay }) {
	const slot = snapshotSlot(nowMs, tz);
	const done = typeof lastSnapshotDay === "string" && lastSnapshotDay >= slot.day;
	return { due: slot.due && !done, day: slot.day };
}

// This week's digest slot: Monday 09:00 of the business week (Monday to Sunday)
// that `nowMs` falls in. The key names that Monday.
function digestSlot(nowMs, tz) {
	const today = dayInZone(new Date(nowMs), tz);
	const sinceMonday = (weekdayOf(today) + 6) % 7;
	const monday = addDays(today, -sinceMonday);
	return { slotKey: `digest:${monday}`, slotMs: slotOn(monday, DIGEST_HOUR, tz) };
}

// Is this week's digest owed now? `lastSlotKey` is the newest digest slot
// already recorded in any state (sent, failed, missed, seeded …); a slot is
// decided once.
function digestDue({ nowMs, tz, lastSlotKey }) {
	const slot = digestSlot(nowMs, tz);
	const decided = typeof lastSlotKey === "string" && lastSlotKey >= slot.slotKey;
	if (decided || nowMs < slot.slotMs) return { due: false, slotKey: slot.slotKey, missed: false };
	if (nowMs - slot.slotMs > DIGEST_CATCH_UP_MS) return { due: false, slotKey: slot.slotKey, missed: true };
	return { due: true, slotKey: slot.slotKey, missed: false };
}

// The next snapshot slot at or after `nowMs`, as ISO.
function nextSnapshotAt(nowMs, tz) {
	const slot = snapshotSlot(nowMs, tz);
	if (!slot.due) return new Date(slot.slotMs).toISOString();
	const next = addDays(slot.day, 1);
	return new Date(slotOn(next, SNAPSHOT_HOUR, tz)).toISOString();
}

// The next digest slot at or after `nowMs`, as ISO.
function nextDigestAt(nowMs, tz) {
	const slot = digestSlot(nowMs, tz);
	if (nowMs < slot.slotMs) return new Date(slot.slotMs).toISOString();
	const nextMonday = addDays(slot.slotKey.slice("digest:".length), 7);
	return new Date(slotOn(nextMonday, DIGEST_HOUR, tz)).toISOString();
}

module.exports = {
	SNAPSHOT_HOUR,
	DIGEST_HOUR,
	DIGEST_CATCH_UP_MS,
	addDays,
	weekdayOf,
	snapshotSlot,
	snapshotDue,
	digestSlot,
	digestDue,
	nextSnapshotAt,
	nextDigestAt,
};
