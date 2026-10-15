// Driver availability (R11): a driver's recorded time off, separate from any
// truck status. It answers two questions and nothing else: may this driver be
// dispatched without a second look, and is a quiet truck expected. It never
// reaches pay, investor math, a truck's costs or a closed month: no pay day is
// created or removed by it (scripts/test-driver-availability-guards.js pins
// that no money path names anything here).
//
// THE RULES (the owner's decisions of 2026-10-15):
//   - a row is a calendar range "YYYY-MM-DD".."YYYY-MM-DD", both days included,
//     at most AVAILABILITY_MAX_DAYS (60) long; kind vacation | off_duty | other;
//     an optional reason of at most 200 characters (the type of leave only);
//   - a Super Admin may date a row anywhere; anyone else (a Dispatcher) may
//     start or change a row at most AVAILABILITY_BACKDATE_DAYS (30) back, and
//     may END a row early (moving only its end date earlier) whatever its start,
//     but never to before yesterday;
//   - one live row per driver per day (the overlap check runs in the server's
//     write transaction); rows are cancelled, never deleted;
//   - the dispatch warning asks about a new driver on a load and about an
//     assigned load whose dates move (offDutyCheckDriver()); a load assigned
//     with "Assign anyway" that covers today lets his truck's ELD alert fire
//     as normal (truckAvailabilityFields()).
//
// ⚠️ DATES ARE CALENDAR DAYS, NEVER INSTANTS. A bare day is validated by regex
// and range and compared as text; day arithmetic runs on whole UTC days
// (Date.UTC), which no zone can shift. "Today" is the business day the server
// passes in (appTodayKey(), APP_TIMEZONE). The one instant here is the start of
// the day after a driver's last day off, 00:00 on the business clock, from
// lib/app-time.js's wallClockToMs().
//
// Pure: no database, network or file. Names are matched through the
// normalizer the caller passes in (server.js's normalizeDriverName()), so the
// rule is the one the rest of the app matches drivers by.

"use strict";

const appTime = require("./app-time");

const AVAILABILITY_KINDS = Object.freeze(["vacation", "off_duty", "other"]);
const AVAILABILITY_MAX_DAYS = 60;
const AVAILABILITY_BACKDATE_DAYS = 30;
const AVAILABILITY_REASON_MAX = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A real calendar day "YYYY-MM-DD" (2000-2099): "2026-13-01", "2026-02-30" and
// "2026-10-1" are not.
function isAvailabilityDay(v) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof v === "string" ? v : "");
	if (!m) return false;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	if (y < 2000 || y > 2099 || mo < 1 || mo > 12 || d < 1) return false;
	const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
	return d <= days;
}

const dayIndex = (key) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / DAY_MS;
const dayFromIndex = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

// `key` moved by n whole days ("" for a key that is not a day).
function shiftAvailabilityDay(key, n) {
	return isAvailabilityDay(key) ? dayFromIndex(dayIndex(key) + n) : "";
}

const refuse = (status, code, error) => ({ ok: false, status, code, error });

// One validator for create and edit. `input` is the request body ({ kind,
// from, to, reason }; on an edit any may be left out and keeps the stored
// value); `existing` is the stored row on an edit or a cancel, null on a
// create. Returns { ok: true, value: { kind, from, to, reason } } or
// { ok: false, status, code, error }. The overlap check is the caller's, in
// its write transaction.
function validateAvailability(input, { todayKey, isSuperAdmin, existing = null } = {}) {
	const body = input && typeof input === "object" ? input : {};
	if (existing && existing.cancelled_at) {
		return refuse(409, "AVAILABILITY_CANCELLED", "This time off was cancelled, so it cannot be changed. Record a new one instead.");
	}
	const pick = (key, stored) => (body[key] === undefined ? stored : body[key]);
	const kind = pick("kind", existing ? existing.kind : undefined);
	const from = pick("from", existing ? existing.from_date : undefined);
	const to = pick("to", existing ? existing.to_date : undefined);
	const rawReason = pick("reason", existing ? existing.reason : "");
	if (!AVAILABILITY_KINDS.includes(kind)) {
		return refuse(400, "INVALID_KIND", `Kind must be one of ${AVAILABILITY_KINDS.join(", ")}.`);
	}
	if (rawReason != null && typeof rawReason !== "string") {
		return refuse(400, "INVALID_REASON", "The reason must be text.");
	}
	const reason = String(rawReason == null ? "" : rawReason).trim();
	if (reason.length > AVAILABILITY_REASON_MAX) {
		return refuse(400, "REASON_TOO_LONG", `The reason can be at most ${AVAILABILITY_REASON_MAX} characters (the type of leave only).`);
	}
	if (!isAvailabilityDay(from) || !isAvailabilityDay(to)) {
		return refuse(400, "INVALID_DATE", "From and to must be real calendar dates (YYYY-MM-DD).");
	}
	if (to < from) {
		return refuse(400, "RANGE_REVERSED", "The last day off is before the first.");
	}
	if (dayIndex(to) - dayIndex(from) + 1 > AVAILABILITY_MAX_DAYS) {
		return refuse(400, "RANGE_TOO_LONG", `Time off can be at most ${AVAILABILITY_MAX_DAYS} days. For longer, add another period after this one ends.`);
	}
	if (!isSuperAdmin) {
		if (!isAvailabilityDay(todayKey)) return refuse(400, "BACKDATE_LIMIT", "Today's date could not be read, so past dates cannot be checked.");
		const floor = shiftAvailabilityDay(todayKey, -AVAILABILITY_BACKDATE_DAYS);
		const yesterday = shiftAvailabilityDay(todayKey, -1);
		if (existing) {
			const endsEarlier = to < existing.to_date;
			if (endsEarlier && to < yesterday) {
				return refuse(400, "BACKDATE_LIMIT", `Time off can be ended early no earlier than yesterday (${yesterday}). A Super Admin can set an earlier end date.`);
			}
			const onlyEndMoved = endsEarlier && kind === existing.kind && from === existing.from_date && reason === String(existing.reason || "");
			if (onlyEndMoved) return { ok: true, value: { kind, from, to, reason } };
		}
		if (from < floor || (existing && existing.from_date < floor)) {
			return refuse(400, "BACKDATE_LIMIT", `Time off starting more than ${AVAILABILITY_BACKDATE_DAYS} days back (before ${floor}) can be recorded or changed by a Super Admin only.`);
		}
	}
	return { ok: true, value: { kind, from, to, reason } };
}

const liveRows = (rows) => (Array.isArray(rows) ? rows : [])
	.filter((r) => r && !r.cancelled_at && isAvailabilityDay(r.from_date) && isAvailabilityDay(r.to_date) && r.from_date <= r.to_date);

// The end of the run of live rows that starts with a row ending `end`: a row
// starting on or before the day after `end` and ending later extends it.
function chainedEnd(live, end) {
	let out = end;
	for (let moved = true; moved;) {
		moved = false;
		const next = shiftAvailabilityDay(out, 1);
		for (const r of live) {
			if (r.from_date <= next && r.to_date > out) { out = r.to_date; moved = true; }
		}
	}
	return out;
}

// A driver's rows -> the two facts the ELD silence sweep needs:
//   driverOffUntil   the last day of the time off covering today (back-to-back
//                    rows joined), else null;
//   driverLastOffTo  the latest last day off before today, else null.
// Cancelled and unreadable rows are ignored.
function availabilityFields(rows, todayKey) {
	const live = liveRows(rows);
	if (!isAvailabilityDay(todayKey)) return { driverOffUntil: null, driverLastOffTo: null };
	const covering = live.filter((r) => r.from_date <= todayKey && todayKey <= r.to_date);
	const driverOffUntil = covering.length ? chainedEnd(live, covering.reduce((m, r) => (r.to_date > m ? r.to_date : m), covering[0].to_date)) : null;
	const ended = live.filter((r) => r.to_date < todayKey).map((r) => r.to_date).sort();
	return { driverOffUntil, driverLastOffTo: ended.length ? ended[ended.length - 1] : null };
}

// The instant a returning driver's grace starts: 00:00 on the business clock
// (APP_TIMEZONE unless `timeZone` names another) on the day after `lastOffTo`.
// The sweep stays quiet for its stale window from there. NaN when not a day.
function returningFromMs(lastOffTo, timeZone) {
	const next = shiftAvailabilityDay(lastOffTo, 1);
	if (!next) return NaN;
	const [y, m, d] = next.split("-").map(Number);
	return appTime.wallClockToMs(timeZone || appTime.appTimeZone(), y, m, d, 0, 0, 0);
}

// Rows -> Map(normalized driver name -> rows). Each row's driver is its
// directory row's CURRENT name (`directory_name`), so a renamed driver keeps
// his rows and a deleted one has none.
function groupAvailabilityByDriver(rows, normalize) {
	const out = new Map();
	for (const r of Array.isArray(rows) ? rows : []) {
		const key = normalize(r && r.directory_name);
		if (!key) continue;
		if (!out.has(key)) out.set(key, []);
		out.get(key).push(r);
	}
	return out;
}

// A truck's driver: the newest open assignment (latest start, then latest id),
// else trucks.assigned_driver. "" when it has none.
function currentTruckDriver(openAssignments, assignedDriver) {
	let best = null;
	for (const a of Array.isArray(openAssignments) ? openAssignments : []) {
		if (!a || !String(a.driver_name || "").trim()) continue;
		const start = String(a.start_date || "");
		if (!best || start > best.start || (start === best.start && Number(a.id) > Number(best.id))) best = { start, id: a.id, name: String(a.driver_name).trim() };
	}
	return best ? best.name : String(assignedDriver || "").trim();
}

// Does one of a driver's "Assign anyway" confirmations (rows with the load's
// window as load_from..load_to) cover `todayKey`?
function confirmedLoadCovers(confirmations, todayKey) {
	if (!isAvailabilityDay(todayKey)) return false;
	return (Array.isArray(confirmations) ? confirmations : [])
		.some((c) => c && isAvailabilityDay(c.load_from) && isAvailabilityDay(c.load_to) && c.load_from <= todayKey && todayKey <= c.load_to);
}

// The availability fields of one truck: its driver's (currentTruckDriver()),
// plus the instant his returning grace starts. A relief driver on the truck
// is its driver, so the truck is expected to report again. So is a driver
// working a load someone assigned him with "Assign anyway" while he is off (the
// owner's rule, 2026-10-15): `confirmedByDriver` holds those confirmations by
// driver, and one covering today sets driverConfirmedLoadToday, which wins over
// the time off in judgeTruckFeed() (lib/eld-feed-health.js).
function truckAvailabilityFields({ openAssignments, assignedDriver, byDriver, confirmedByDriver, todayKey, normalize, timeZone }) {
	const driverName = currentTruckDriver(openAssignments, assignedDriver);
	const key = driverName ? normalize(driverName) : "";
	const rows = key && byDriver ? byDriver.get(key) || [] : [];
	const f = availabilityFields(rows, todayKey);
	const fromMs = f.driverLastOffTo ? returningFromMs(f.driverLastOffTo, timeZone) : NaN;
	const confirmed = key && confirmedByDriver ? confirmedByDriver.get(key) || [] : [];
	return {
		driverName: driverName || null,
		...f,
		driverReturningFromMs: Number.isFinite(fromMs) ? fromMs : null,
		driverConfirmedLoadToday: confirmedLoadCovers(confirmed, todayKey),
	};
}

// Which driver a row save asks the off-duty check about, or "" for none. The
// check runs when the save puts a new driver on the load (the Driver cell
// changes, through normalizeDriverName(), to a name) and when it moves the
// dates of a load that has a driver (a Pickup or Drop-off day changes; a new
// time on the same day is no move). Days come from sheetDayKey() ("" when
// unreadable); `normalize` is normalizeDriverName().
function offDutyCheckDriver({ driverBefore, driverAfter, pickupBefore, pickupAfter, dropoffBefore, dropoffAfter, normalize }) {
	const after = String(driverAfter == null ? "" : driverAfter).trim();
	if (!normalize(after)) return "";
	if (normalize(after) !== normalize(driverBefore)) return after;
	const moved = String(pickupBefore || "") !== String(pickupAfter || "") || String(dropoffBefore || "") !== String(dropoffAfter || "");
	return moved ? after : "";
}

// A load's window as calendar days, from its pickup and drop-off days (each
// already read off the sheet with sheetDayKey(); "" when unreadable):
// start = pickup || drop-off, end = drop-off || pickup; an end before the start
// reads as the start (a typo); only both unreadable reads as today.
function offDutyLoadWindow(pickupKey, dropoffKey, todayKey) {
	const p = isAvailabilityDay(pickupKey) ? pickupKey : "";
	const d = isAvailabilityDay(dropoffKey) ? dropoffKey : "";
	let start = p || d;
	let end = d || p;
	if (!start) { start = todayKey; end = todayKey; }
	if (end < start) end = start;
	return { start, end };
}

// The driver's live row a load's window overlaps, or null. A window that ended
// before today never warns: editing a past load is not a dispatch.
function offDutyConflict({ rows, pickupKey, dropoffKey, todayKey }) {
	if (!isAvailabilityDay(todayKey)) return null;
	const w = offDutyLoadWindow(pickupKey, dropoffKey, todayKey);
	if (w.end < todayKey) return null;
	const hit = liveRows(rows)
		.filter((r) => r.from_date <= w.end && r.to_date >= w.start)
		.sort((a, b) => (a.from_date < b.from_date ? -1 : a.from_date > b.from_date ? 1 : 0))[0];
	return hit ? { id: hit.id, from: hit.from_date, to: hit.to_date, kind: hit.kind, windowStart: w.start, windowEnd: w.end } : null;
}

// "Oct 14 – Oct 20"; "Oct 14" for one day; "Dec 28, 2026 – Jan 3, 2027" across
// a year end; "" when either end is not a day. Read from the text alone, so it
// is the same for every reader. client/src/lib/availabilityText.js says the
// same (scripts/test-availability-range-text.mjs).
function availabilityRangeText(from, to) {
	if (!isAvailabilityDay(from) || !isAvailabilityDay(to)) return "";
	const md = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8, 10))}`;
	if (from === to) return md(from);
	if (from.slice(0, 4) !== to.slice(0, 4)) return `${md(from)}, ${from.slice(0, 4)} – ${md(to)}, ${to.slice(0, 4)}`;
	return `${md(from)} – ${md(to)}`;
}

// The time off to show beside a driver's name: the one covering today, else
// the next one (back-to-back rows joined), as { from, to }; null when none.
function currentOrNextOff(rows, todayKey) {
	if (!isAvailabilityDay(todayKey)) return null;
	const live = liveRows(rows).filter((r) => r.to_date >= todayKey)
		.sort((a, b) => (a.from_date < b.from_date ? -1 : a.from_date > b.from_date ? 1 : 0));
	if (!live.length) return null;
	return { from: live[0].from_date, to: chainedEnd(live, live[0].to_date) };
}

module.exports = {
	AVAILABILITY_KINDS,
	AVAILABILITY_MAX_DAYS,
	AVAILABILITY_BACKDATE_DAYS,
	AVAILABILITY_REASON_MAX,
	isAvailabilityDay,
	shiftAvailabilityDay,
	validateAvailability,
	availabilityFields,
	returningFromMs,
	groupAvailabilityByDriver,
	currentTruckDriver,
	confirmedLoadCovers,
	truckAvailabilityFields,
	offDutyCheckDriver,
	offDutyLoadWindow,
	offDutyConflict,
	availabilityRangeText,
	currentOrNextOff,
};
