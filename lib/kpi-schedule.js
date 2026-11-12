"use strict";
// WHEN THE KPI BOT RUNS: the nightly snapshot and the weekly digest.
//
// product-decisions.md writes the times on the Central clock: the snapshot at
// 03:00 and the digest on Mondays at 08:00. On the US Eastern clock, which
// changes to and from daylight time on the same days, those moments are 04:00
// and 09:00, which every other business zone keeps too (hoursIn()). The page
// names those times in the business zone only (scheduleText()).
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

const { dayInZone, wallClockToMs, zoneWords, CENTRAL_ZONE } = require("./app-time");

const SNAPSHOT_HOUR = 4;
const DIGEST_HOUR = 9;
const DIGEST_CATCH_UP_MS = 6 * 60 * 60 * 1000;
const CENTRAL_HOURS = Object.freeze({ snapshot: 3, digest: 8 });
const OTHER_HOURS = Object.freeze({ snapshot: SNAPSHOT_HOUR, digest: DIGEST_HOUR });

// The snapshot's and the digest's hour on business zone `tz`'s clock.
function hoursIn(tz) {
	return tz === CENTRAL_ZONE ? CENTRAL_HOURS : OTHER_HOURS;
}

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

// Today's snapshot slot: the business day `nowMs` falls on, its snapshot hour,
// and whether that moment has come.
function snapshotSlot(nowMs, tz) {
	const day = dayInZone(new Date(nowMs), tz);
	const slotMs = slotOn(day, hoursIn(tz).snapshot, tz);
	return { day, slotMs, due: nowMs >= slotMs };
}

// Is a scheduled snapshot owed now? `lastSnapshotDay` is the business day of the
// last scheduled snapshot that succeeded (null when there is none).
function snapshotDue({ nowMs, tz, lastSnapshotDay }) {
	const slot = snapshotSlot(nowMs, tz);
	const done = typeof lastSnapshotDay === "string" && lastSnapshotDay >= slot.day;
	return { due: slot.due && !done, day: slot.day };
}

// This week's digest slot: Monday's digest hour of the business week (Monday to
// Sunday) that `nowMs` falls in. The key names that Monday.
function digestSlot(nowMs, tz) {
	const today = dayInZone(new Date(nowMs), tz);
	const sinceMonday = (weekdayOf(today) + 6) % 7;
	const monday = addDays(today, -sinceMonday);
	return { slotKey: `digest:${monday}`, slotMs: slotOn(monday, hoursIn(tz).digest, tz) };
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
	return new Date(slotOn(next, hoursIn(tz).snapshot, tz)).toISOString();
}

// The next digest slot at or after `nowMs`, as ISO.
function nextDigestAt(nowMs, tz) {
	const slot = digestSlot(nowMs, tz);
	if (nowMs < slot.slotMs) return new Date(slot.slotMs).toISOString();
	const nextMonday = addDays(slot.slotKey.slice("digest:".length), 7);
	return new Date(slotOn(nextMonday, hoursIn(tz).digest, tz)).toISOString();
}

// "4:00 AM" for hour 4, "9:00 PM" for hour 21.
function clockText(hour) {
	return `${hour % 12 || 12}:00 ${hour < 12 ? "AM" : "PM"}`;
}

// The schedule in words, for the KPI page, on the business zone's clock only:
// "Eastern" or "Central" (lib/app-time.js zoneWords()), the zone it runs on and
// nothing else (KPI schedule text, 2026-10-15). Any other zone is named as itself.
function scheduleText(tz) {
	const words = zoneWords(tz);
	const zone = words ? ` ${words.word}` : ` (${tz})`;
	const hours = hoursIn(tz);
	return {
		snapshot: `Daily at ${clockText(hours.snapshot)}${zone}`,
		digest: `Mondays at ${clockText(hours.digest)}${zone}`,
	};
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
	scheduleText,
};
