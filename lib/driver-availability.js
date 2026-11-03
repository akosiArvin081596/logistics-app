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
//   - the staff panel is told per row what the caller may change and between
//     which days (availabilityEditScope(), availabilityEditLimits(),
//     availabilityCreateLimits()); they restate the validator, never widen it;
//   - the dispatch warning asks about a new driver on a load and about an
//     assigned load whose dates move (offDutyCheckDriver()); a load assigned
//     with "Assign anyway" that covers today lets the truck it names (his own
//     when it names none) alert as normal, while the load still has him and is
//     live (standingConfirmations(), truckAvailabilityFields());
//   - the other side (R11b, the user's decisions of 2026-10-16, behind the
//     server's DRIVER_AVAILABILITY_LOADS_WARNING_ENABLED): recording time off,
//     or moving or extending it, over loads he already has asks first
//     (loadsNewlyInTimeOff(), timeOffLoadsDecision(), driverHasLoadsBody());
//     "Save anyway" echoes the listed loads and records a confirmation per load,
//     read by the same standingConfirmations(). Loads with no readable day are
//     skipped. It changes no load and pays nothing.
//   - a driver's own request (D's rules of 2026-10-31, behind the server's
//     DRIVER_TIME_OFF_REQUESTS_ENABLED): a row stored 'requested' until a Super
//     Admin or Dispatcher approves or declines it; its first day at least 5 days
//     ahead (validateDriverRequest()). Only an approved row counts anywhere
//     (liveRows()); every staff row is approved when recorded.
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
	// A driver's request is decided, never edited: changing its days would decide it without a decision.
	if (existing && requestStatusOf(existing) === "requested") {
		return refuse(409, "TIME_OFF_REQUEST_PENDING", "This is a driver's request waiting for a decision. Approve or decline it first.");
	}
	if (existing && requestStatusOf(existing) === "declined") {
		return refuse(409, "TIME_OFF_REQUEST_DECLINED", "This request was declined. Record new time off instead.");
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

// What the staff panel may offer on a stored row (R11 follow-up): "full" (any
// field, inside availabilityEditLimits()), "end_early" (only an earlier last
// day) or "none". It restates validateAvailability(), which stays the authority
// (scripts/test-availability-edit-scope.js pins the two equal over every day of
// a grid):
//   - a cancelled row, one whose stored days can't be read, or a driver's request
//     still waiting or declined: "none";
//   - a Super Admin: "full";
//   - anyone else: "none" when today can't be read (the validator refuses
//     him), "full" on a row starting today - 30 or later, "end_early" on an
//     older row still running today or later, "none" on an older row that
//     ended before today (no day from yesterday on is earlier than its end).
// A cancel is allowed exactly when this is "full".
function availabilityEditScope(row, { todayKey, isSuperAdmin } = {}) {
	if (!row || row.cancelled_at || !isAvailabilityDay(row.from_date) || !isAvailabilityDay(row.to_date) || requestStatusOf(row) !== "approved") return "none";
	if (isSuperAdmin) return "full";
	if (!isAvailabilityDay(todayKey)) return "none";
	if (row.from_date >= shiftAvailabilityDay(todayKey, -AVAILABILITY_BACKDATE_DAYS)) return "full";
	return row.to_date >= todayKey ? "end_early" : "none";
}

// The days an edit of `row` may use, { fromMin, toMin, toMax, maxDays } (null =
// no limit), or null when availabilityEditScope() is "none". On "full", `toMin`
// leaves out the first day: the panel keeps the last day on or after the form's
// first day itself. `maxDays` is the validator's cap on the whole range
// (AVAILABILITY_MAX_DAYS), for every caller.
//   - Super Admin: no day limits.
//   - "full": the first day no earlier than today - 30; the last day no earlier
//     than the stored one or yesterday, whichever is earlier (it may stay, move
//     later, or move earlier down to yesterday).
//   - "end_early": the last day from yesterday (or the stored first day, if
//     later) to the day before the stored last day (keeping it isn't ending early).
function availabilityEditLimits(row, ctx = {}) {
	const scope = availabilityEditScope(row, ctx);
	if (scope === "none") return null;
	const maxDays = AVAILABILITY_MAX_DAYS;
	if (ctx.isSuperAdmin) return { fromMin: null, toMin: null, toMax: null, maxDays };
	const yesterday = shiftAvailabilityDay(ctx.todayKey, -1);
	if (scope === "full") {
		return { fromMin: shiftAvailabilityDay(ctx.todayKey, -AVAILABILITY_BACKDATE_DAYS), toMin: row.to_date < yesterday ? row.to_date : yesterday, toMax: null, maxDays };
	}
	return { fromMin: null, toMin: row.from_date > yesterday ? row.from_date : yesterday, toMax: shiftAvailabilityDay(row.to_date, -1), maxDays };
}

// The add form's days, { fromMin, toMin: null, maxDays, dispatcherBackDays }: a
// Super Admin has no first-day limit, anyone else starts no earlier than
// today - 30; `maxDays` is the validator's cap on the range, and
// `dispatcherBackDays` how far back a Dispatcher may start or change a row
// (AVAILABILITY_BACKDATE_DAYS), which the panel's end-early note names. null for
// anyone else when today can't be read (the validator refuses him every create then).
function availabilityCreateLimits({ todayKey, isSuperAdmin } = {}) {
	const rule = { maxDays: AVAILABILITY_MAX_DAYS, dispatcherBackDays: AVAILABILITY_BACKDATE_DAYS };
	if (isSuperAdmin) return { fromMin: null, toMin: null, ...rule };
	if (!isAvailabilityDay(todayKey)) return null;
	return { fromMin: shiftAvailabilityDay(todayKey, -AVAILABILITY_BACKDATE_DAYS), toMin: null, ...rule };
}

// A row counts while it is not cancelled, its days read, and it is approved: a
// driver's request still waiting or declined never counts, even if a caller
// hands it in unfiltered (a row with no request_status predates requests).
const liveRows = (rows) => (Array.isArray(rows) ? rows : [])
	.filter((r) => r && !r.cancelled_at && isAvailabilityDay(r.from_date) && isAvailabilityDay(r.to_date) && r.from_date <= r.to_date
		&& requestStatusOf(r) === "approved");

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

// A truck's unit number as compared ("Logisx-#91" is "LogisX-#91").
const unitKey = (u) => String(u == null ? "" : u).trim().toLowerCase().replace(/\s+/g, " ");

// The "Assign anyway" confirmations that still stand today, as
// [{ id, driverKey, truck, from, to }]. A confirmation (a stored row with its
// driver's current directory name as `directory_name`, its `load_id` and the
// window it was confirmed for) stands while its load, as Job Tracking has it
// now, still has that driver, is not cancelled and covers today: `loads` maps
// loadKey(load id) to { driver, truck, pickupKey, dropoffKey, cancelled } (days
// from sheetDayKey()), and a load missing from it was removed. Its days are the
// load's days now (the confirmed window when both cells are unreadable), its
// truck the load's Truck cell ("" when it names none). With no `loads` (Job
// Tracking could not be read) each stands as recorded, with no truck: an extra
// alert on the driver's own truck rather than a missed one.
function standingConfirmations({ confirmations, loads, todayKey, normalize, loadKey }) {
	if (!isAvailabilityDay(todayKey)) return [];
	const out = [];
	for (const c of Array.isArray(confirmations) ? confirmations : []) {
		const driverKey = c ? normalize(c.directory_name) : "";
		if (!driverKey) continue;
		let window = { start: c.load_from, end: c.load_to };
		let truck = "";
		if (loads) {
			const load = loads.get(loadKey(c.load_id));
			if (!load || load.cancelled || normalize(load.driver) !== driverKey) continue;
			truck = String(load.truck == null ? "" : load.truck).trim();
			if (isAvailabilityDay(load.pickupKey) || isAvailabilityDay(load.dropoffKey)) window = offDutyLoadWindow(load.pickupKey, load.dropoffKey, todayKey);
		}
		if (!isAvailabilityDay(window.start) || !isAvailabilityDay(window.end) || window.start > todayKey || todayKey > window.end) continue;
		out.push({ id: c.id, driverKey, truck, from: window.start, to: window.end });
	}
	return out;
}

// Does a load's Truck cell name this unit? By the fleet's unit-number rule
// (`unitToken`, server.js unitNumberToken(): "91" names "LogisX-#91") when both
// carry one, else as written (case and spacing aside).
function truckCellNames(cell, unit, unitToken) {
	const tc = typeof unitToken === "function" ? unitToken(cell) : "";
	const tu = typeof unitToken === "function" ? unitToken(unit) : "";
	if (tc && tu) return tc === tu;
	return unitKey(cell) !== "" && unitKey(cell) === unitKey(unit);
}

// The availability fields of one truck: its driver's (currentTruckDriver()),
// plus the instant his returning grace starts. A relief driver on the truck
// is its driver, so the truck is expected to report again. So is a driver
// working a load someone assigned him with "Assign anyway" while he is off (the
// owner's rule, 2026-10-15): one of standingConfirmations() for him that names
// this truck (`unitNumber`, truckCellNames()), names no truck, or names none of
// the fleet's units (`knownUnits`; none given counts as none known) sets
// driverConfirmedLoadToday, which wins over the time off in judgeTruckFeed()
// (lib/eld-feed-health.js). A load he works in another of the fleet's trucks
// leaves this one paused; a Truck cell nobody can place never does.
function truckAvailabilityFields({ openAssignments, assignedDriver, unitNumber, unitToken, knownUnits, byDriver, standing, todayKey, normalize, timeZone }) {
	const driverName = currentTruckDriver(openAssignments, assignedDriver);
	const key = driverName ? normalize(driverName) : "";
	const rows = key && byDriver ? byDriver.get(key) || [] : [];
	const f = availabilityFields(rows, todayKey);
	const fromMs = f.driverLastOffTo ? returningFromMs(f.driverLastOffTo, timeZone) : NaN;
	const fleet = Array.isArray(knownUnits) ? knownUnits : [];
	const countsHere = (cell) => !cell
		|| truckCellNames(cell, unitNumber, unitToken)
		|| !fleet.some((u) => truckCellNames(cell, u, unitToken));
	return {
		driverName: driverName || null,
		...f,
		driverReturningFromMs: Number.isFinite(fromMs) ? fromMs : null,
		driverConfirmedLoadToday: !!key && (Array.isArray(standing) ? standing : [])
			.some((s) => s.driverKey === key && countsHere(s.truck)),
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

// ── R11b: time off recorded over loads he already has ─────────────────────────
// An echo may always hold every load the server listed (timeOffLoadsDecision()
// raises the cap to the list's length); this is the cap otherwise, far above a
// 60-day range's loads. The body parser's size limit bounds the request first.
const CONFIRM_LOADS_MAX = 500;
const CONFIRM_LOAD_ID_MAX = 64;
const LOADS_NAMED_MAX = 5;
const daysOverlap = (aFrom, aTo, bFrom, bTo) => aFrom <= bTo && aTo >= bFrom;
const textCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byFirstDay = (a, b) => textCompare(a.from, b.from) || textCompare(a.shownId, b.shownId) || textCompare(a.loadId, b.loadId);

// A load's ids as loadsNewlyInTimeOff() lists them: the stored Load ID, trimmed,
// and the id as the viewer is shown it (the stored one when absent).
function timeOffLoadIds(l) {
	const loadId = String(l.loadId == null ? "" : l.loadId).trim();
	return { loadId, shownId: l.shownId == null ? loadId : String(l.shownId).trim() };
}

// Why loadsNewlyInTimeOff() never asks about one of his loads, whatever the days:
// "id" (no load id, or one, stored or as shown, over 64 characters: no echo could
// name it), "no_day" (neither day readable), or "" when it may be asked about.
// scripts/time-off-loads-report.js counts the loads it skips by the same answer.
function timeOffLoadSkip(l) {
	const { loadId, shownId } = timeOffLoadIds(l);
	if (!loadId || !shownId || loadId.length > CONFIRM_LOAD_ID_MAX || shownId.length > CONFIRM_LOAD_ID_MAX) return "id";
	if (!isAvailabilityDay(l.pickupKey) && !isAvailabilityDay(l.dropoffKey)) return "no_day";
	return "";
}

// The driver's loads a time-off save of from..to asks about, by first day, as
// [{ loadId, shownId, from, to }]: the stored Load ID, the id as the viewer is
// shown it, and the load's window. `loads` is every live Job Tracking load as
// { loadId, shownId, driver, pickupKey, dropoffKey } (cancelled and
// soft-deleted ones already left out; `shownId` the Load ID with broker contact
// withheld for a viewer who may not see it, the stored id when absent; days read
// with sheetDayKey(), "" when unreadable); his are those whose Driver cell
// matches `driverName` through `normalize`. A load is asked about when its
// window (offDutyLoadWindow()) overlaps from..to and ends today or later, and,
// on an edit (oldFrom..oldTo, the stored row's days), only when it also misses
// the old days: a load already inside them never asks again. A load with
// neither day readable is skipped (the user, 2026-10-16: the dispatch side still
// asks when such a load is dispatched), and so is one with no load id, or whose
// id, stored or as shown, is over 64 characters: every listed load must be one
// the echo can name (parseConfirmLoads()).
function loadsNewlyInTimeOff({ loads, driverName, normalize, from, to, oldFrom, oldTo, todayKey }) {
	if (!isAvailabilityDay(todayKey) || !isAvailabilityDay(from) || !isAvailabilityDay(to) || to < from) return [];
	const driverKey = normalize(driverName);
	if (!driverKey) return [];
	const hasOld = isAvailabilityDay(oldFrom) && isAvailabilityDay(oldTo) && oldFrom <= oldTo;
	const out = [];
	for (const l of Array.isArray(loads) ? loads : []) {
		if (!l || normalize(l.driver) !== driverKey || timeOffLoadSkip(l)) continue;
		const { loadId, shownId } = timeOffLoadIds(l);
		const w = offDutyLoadWindow(l.pickupKey, l.dropoffKey, todayKey);
		if (w.end < todayKey || !daysOverlap(w.start, w.end, from, to)) continue;
		if (hasOld && daysOverlap(w.start, w.end, oldFrom, oldTo)) continue;
		out.push({ loadId, shownId, from: w.start, to: w.end });
	}
	return out.sort(byFirstDay);
}

// The "Save anyway" echo (`confirmLoads`): the 409's loads, as
// [{ loadId, from, to }] with ids trimmed and repeats kept once. Anything else
// is no confirmation and answers null: true, an object, more than `max` entries
// (CONFIRM_LOADS_MAX unless the caller allows more), an entry that is not an
// object, an id that is not text, is blank or is over 64 characters, a day that
// is not a real YYYY-MM-DD, or a reversed window.
function parseConfirmLoads(raw, { max = CONFIRM_LOADS_MAX } = {}) {
	if (!Array.isArray(raw) || raw.length > max) return null;
	const out = [];
	const seen = new Set();
	for (const e of raw) {
		if (!e || typeof e !== "object" || Array.isArray(e)) return null;
		if (typeof e.loadId !== "string" || e.loadId.length > CONFIRM_LOAD_ID_MAX) return null;
		const loadId = e.loadId.trim();
		if (!loadId || !isAvailabilityDay(e.from) || !isAvailabilityDay(e.to) || e.to < e.from) return null;
		const k = JSON.stringify([loadId, e.from, e.to]);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push({ loadId, from: e.from, to: e.to });
	}
	return out;
}

// One time-off save's answer, decided after the route's last await:
//   { ask: [loads] }                    409 DRIVER_HAS_LOADS with that list; nothing is written
//   { ask: null, confirm, unchecked }   save, recording one confirmation per `confirm` entry
// `loads` null means Job Tracking could not be read: the save goes through
// unchecked, and an echo is recorded as given, each entry overlapping the new
// days and its window kept to them (the ELD sweep re-checks every confirmation
// against the live sheet, so one recorded unchecked can't outlive its load).
// Otherwise the listed loads (loadsNewlyInTimeOff()) are asked about by the id
// the viewer is shown, as { loadId: shownId, from, to }; each must be echoed by
// that id with its window, matched through `loadKey` (server.js normLoadKey()),
// and is confirmed by its stored id. A load the echo misses (added or moved
// since the 409) asks again with the whole list; an echo as long as the list is
// always read. Echoed loads no longer listed are ignored, and nothing listed
// means nothing to confirm.
function timeOffLoadsDecision({ loads, confirmLoads, driverName, normalize, loadKey, from, to, oldFrom, oldTo, todayKey }) {
	if (loads === null) {
		const echo = parseConfirmLoads(confirmLoads);
		const confirm = (echo || []).filter((e) => daysOverlap(e.from, e.to, from, to))
			.map((e) => ({ loadId: e.loadId, from: e.from > from ? e.from : from, to: e.to < to ? e.to : to }));
		return { ask: null, confirm, unchecked: true };
	}
	const listed = loadsNewlyInTimeOff({ loads, driverName, normalize, from, to, oldFrom, oldTo, todayKey });
	if (!listed.length) return { ask: null, confirm: [], unchecked: false };
	const echo = parseConfirmLoads(confirmLoads, { max: Math.max(CONFIRM_LOADS_MAX, listed.length) });
	const key = (id, e) => JSON.stringify([loadKey(id), e.from, e.to]);
	const echoed = new Set((echo || []).map((e) => key(e.loadId, e)));
	if (!echo || listed.some((l) => !echoed.has(key(l.shownId, l)))) {
		return { ask: listed.map((l) => ({ loadId: l.shownId, from: l.from, to: l.to })) };
	}
	return { ask: null, confirm: listed.map((l) => ({ loadId: l.loadId, from: l.from, to: l.to })), unchecked: false };
}

// The 409 DRIVER_HAS_LOADS body, { error, code, driver, from, to, loads }:
// `from`..`to` the days asked for, each load as { loadId, from, to } (its id as
// the viewer is shown it, timeOffLoadsDecision()'s `ask`) and nothing else (no
// Truck, broker, customer or address cell reaches it), and the words naming
// each load with its days (the first five, then how many more). `approve` words
// the question for approving a driver's request ("Approve anyway?").
function driverHasLoadsBody({ driverName, from, to, loads, approve = false }) {
	const driver = String(driverName == null ? "" : driverName).trim();
	const name = driver || "This driver";
	const list = (Array.isArray(loads) ? loads : []).map((l) => ({ loadId: l.loadId, from: l.from, to: l.to }));
	const ask = approve ? "Approve anyway?" : "Save anyway?";
	const whose = approve ? "the driver" : "him";
	let error;
	if (list.length === 1) {
		error = `${name} has load ${list[0].loadId} (${availabilityRangeText(list[0].from, list[0].to)}) overlapping these dates. ${ask} The load stays assigned to ${whose}.`;
	} else {
		const named = list.slice(0, LOADS_NAMED_MAX).map((l) => `${l.loadId} (${availabilityRangeText(l.from, l.to)})`).join(", ");
		const more = list.length > LOADS_NAMED_MAX ? ` and ${list.length - LOADS_NAMED_MAX} more` : "";
		error = `${name} has ${list.length} loads overlapping these dates: ${named}${more}. ${ask} The loads stay assigned to ${whose}.`;
	}
	return { error, code: "DRIVER_HAS_LOADS", driver, from, to, loads: list };
}

// "Oct 14 – Oct 20"; "Oct 14" for one day; "Dec 28, 2026 – Jan 3, 2027" across
// a year end; "" when either end is not a day. Read from the text alone, so it
// is the same for every reader. client/src/lib/availabilityText.js says the
// same (scripts/test-availability-range-text.mjs).
function availabilityRangeText(from, to) {
	if (!isAvailabilityDay(from) || !isAvailabilityDay(to)) return "";
	const md = monthDayText;
	if (from === to) return md(from);
	if (from.slice(0, 4) !== to.slice(0, 4)) return `${md(from)}, ${from.slice(0, 4)} – ${md(to)}, ${to.slice(0, 4)}`;
	return `${md(from)} – ${md(to)}`;
}

// "Nov 6" for a day key (the caller checks it is one).
function monthDayText(k) {
	return `${MONTHS[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8, 10))}`;
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

// ── A driver's own request (plan B Revision 2, PR 4) ─────────────────────────
// D's rules of 2026-10-31: "a button in the app that says request days off",
// "someone has to manually approve it", and "it needs to be at least 5 days
// out". A request is a time-off row stored with request_status 'requested'
// (sent as `request: "waiting"`, shown "Waiting for approval") until a Super
// Admin or Dispatcher approves it ('approved') or declines it ('declined').
// "Today" is the business day the server passes in (appTodayKey()), never a
// phone's clock: asked on a Monday, the first day off can be Saturday.
const REQUEST_LEAD_DAYS = 5;
const REQUEST_HORIZON_DAYS = 90;
const REQUEST_WAITING_MAX = 5;
const REQUEST_DEFAULT_KIND = "off_duty";
// The stored value of request_status -> the API's `request` word.
const REQUEST_WORDS = Object.freeze({ requested: "waiting", approved: "approved", declined: "declined" });
const KIND_WORDS = Object.freeze({ vacation: "Vacation", off_duty: "Off duty", other: "Other" });
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// A row's stored request status; a row read without the column (one saved
// before requests existed) is approved, as the column's default makes it.
function requestStatusOf(row) {
	const s = row ? row.request_status : undefined;
	return s == null ? "approved" : String(s);
}

// "Fri, Nov 6": the weekday from the UTC calendar, which no zone can shift.
function dayWithWeekday(key) {
	if (!isAvailabilityDay(key)) return "";
	return `${WEEKDAYS[new Date(dayIndex(key) * DAY_MS).getUTCDay()]}, ${monthDayText(key)}`;
}

// The days a driver's request may use, from the business day `todayKey`:
// { fromMin, fromMax, maxDays, waitingMax }, or null when today can't be read.
// The driver's date picker starts at fromMin, as the server sends it.
function driverRequestLimits({ todayKey } = {}) {
	if (!isAvailabilityDay(todayKey)) return null;
	return {
		fromMin: shiftAvailabilityDay(todayKey, REQUEST_LEAD_DAYS),
		fromMax: shiftAvailabilityDay(todayKey, REQUEST_HORIZON_DAYS),
		maxDays: AVAILABILITY_MAX_DAYS,
		waitingMax: REQUEST_WAITING_MAX,
	};
}

// A driver's request body { from, to, kind? }. A reason is refused, whatever its
// value: the reason stays staff-only (R11). Returns { ok: true, value: { kind,
// from, to } } or a refusal; TIME_OFF_TOO_SOON carries `fromMin` and
// TIME_OFF_TOO_FAR `fromMax`. The waiting cap and the overlap are the
// server's, in its write transaction.
function validateDriverRequest(input, { todayKey } = {}) {
	const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
	if (Object.prototype.hasOwnProperty.call(body, "reason")) {
		return refuse(400, "REASON_NOT_ALLOWED", "A request carries no reason. Choose the kind of time off; anything else, tell dispatch.");
	}
	const kind = body.kind === undefined ? REQUEST_DEFAULT_KIND : body.kind;
	if (!AVAILABILITY_KINDS.includes(kind)) {
		return refuse(400, "INVALID_KIND", `Kind must be one of ${AVAILABILITY_KINDS.join(", ")}.`);
	}
	const { from, to } = body;
	if (!isAvailabilityDay(from) || !isAvailabilityDay(to)) {
		return refuse(400, "INVALID_DATE", "From and to must be real calendar dates (YYYY-MM-DD).");
	}
	if (to < from) return refuse(400, "RANGE_REVERSED", "The last day off is before the first.");
	if (dayIndex(to) - dayIndex(from) + 1 > AVAILABILITY_MAX_DAYS) {
		return refuse(400, "RANGE_TOO_LONG", `Time off can be at most ${AVAILABILITY_MAX_DAYS} days. For longer, ask for another period after this one.`);
	}
	const limits = driverRequestLimits({ todayKey });
	if (!limits) return refuse(400, "TIME_OFF_TOO_SOON", "Today's date could not be read, so the request can't be checked. Message dispatch.");
	if (from < limits.fromMin) {
		return {
			...refuse(400, "TIME_OFF_TOO_SOON", `Days off must be asked for at least ${REQUEST_LEAD_DAYS} days ahead. The earliest day you can ask for now is ${dayWithWeekday(limits.fromMin)}. For sooner days, message dispatch.`),
			fromMin: limits.fromMin,
		};
	}
	if (from > limits.fromMax) {
		return {
			...refuse(400, "TIME_OFF_TOO_FAR", `Days off can be asked for up to ${REQUEST_HORIZON_DAYS} days ahead. The latest first day you can ask for now is ${dayWithWeekday(limits.fromMax)}.`),
			fromMax: limits.fromMax,
		};
	}
	return { ok: true, value: { kind, from, to } };
}

// Which Drivers page row a driver's request is for. `account` is their account,
// read again from the session's id; `directoryRows` every directory row whose
// name normalizes to its driver name; `heldByOther` whether another account
// holds that name too (server.js driverNameHeldByOtherAccount()), in which case
// the row may be that account's. { ok: true, directory } or a refusal.
function driverRequestIdentity({ account, directoryRows, heldByOther } = {}) {
	if (!account || account.role !== "Driver") {
		return refuse(403, "DRIVER_ACCOUNT_REQUIRED", "Only a driver's own account can ask for days off.");
	}
	const rows = Array.isArray(directoryRows) ? directoryRows : [];
	if (!rows.length) {
		return refuse(409, "DRIVER_NOT_ON_DIRECTORY", "Your name isn't on the Drivers list, so the request can't be saved. Message dispatch.");
	}
	if (rows.length > 1 || heldByOther) {
		return refuse(409, "DRIVER_DIRECTORY_AMBIGUOUS", "Your name matches more than one driver, so the request can't be saved. Message dispatch.");
	}
	return { ok: true, directory: rows[0] };
}

// The driver's cancel of their own request: their own driver-made row
// (`accountId` made it, on their directory row), not cancelled, still waiting.
// Another driver's row and an unknown id read alike (404). Never names who
// decided.
function driverRequestCancelCheck(row, { accountId, directoryId } = {}) {
	const mine = !!row && row.source === "driver" && Number(accountId) > 0
		&& Number(row.created_by_user_id) === Number(accountId) && Number(row.directory_id) === Number(directoryId);
	if (!mine) return refuse(404, "AVAILABILITY_NOT_FOUND", "Request not found");
	if (row.cancelled_at) return refuse(409, "AVAILABILITY_CANCELLED", "This request was already cancelled.");
	if (requestStatusOf(row) !== "requested") {
		return refuse(409, "TIME_OFF_REQUEST_DECIDED", "This request was already decided. Message dispatch to change it.");
	}
	return { ok: true };
}

// Whether staff may approve or decline `row` now: it waits and is not
// cancelled. A Dispatcher approving a request whose first day is over 30 days
// back is refused, as recording such a row is (validateAvailability()); a
// decline makes nothing count, so it has no date limit. A row already decided
// says who decided and when (staff only); one staff recorded needs no approval.
function requestDecisionCheck(row, { todayKey, isSuperAdmin, decision } = {}) {
	if (!row) return refuse(404, "AVAILABILITY_NOT_FOUND", "Time off not found");
	if (row.cancelled_at) return refuse(409, "AVAILABILITY_CANCELLED", "This request was cancelled, so it can't be approved or declined.");
	const status = requestStatusOf(row);
	if (status !== "requested") {
		const by = row.decided_by ? String(row.decided_by) : "";
		const day = row.decided_at ? appTime.dayInZone(new Date(row.decided_at), appTime.appTimeZone()) : "";
		const when = isAvailabilityDay(day) ? ` on ${monthDayText(day)}` : "";
		const error = by
			? `Already ${status === "declined" ? "declined" : "approved"} by ${by}${when}.`
			: "This time off was recorded by staff, so there is nothing to approve or decline.";
		return { ...refuse(409, "TIME_OFF_REQUEST_DECIDED", error), decision: REQUEST_WORDS[status] || status, decidedBy: by || null, decidedAt: row.decided_at || null };
	}
	if (decision === "approve" && !isSuperAdmin) {
		if (!isAvailabilityDay(todayKey)) return refuse(400, "BACKDATE_LIMIT", "Today's date could not be read, so past dates cannot be checked.");
		const floor = shiftAvailabilityDay(todayKey, -AVAILABILITY_BACKDATE_DAYS);
		if (row.from_date < floor) {
			return refuse(400, "BACKDATE_LIMIT", `This request starts more than ${AVAILABILITY_BACKDATE_DAYS} days back (before ${floor}), so only a Super Admin can approve it.`);
		}
	}
	return { ok: true };
}

// A driver's own waiting and declined requests, as their card shows them:
// [{ id, kind, from, to, request: "waiting" | "declined", canCancel }], by first
// day. A waiting one shows until its last day has passed, a declined one
// through its first day; cancelled and approved rows are not requests here.
// canCancel only on the driver's own session (`canAct`), for a request their
// account (`accountId`) made that still waits. Never a reason or who decided.
function driverRequestsView(rows, { todayKey, accountId = 0, canAct = false } = {}) {
	if (!isAvailabilityDay(todayKey)) return [];
	return (Array.isArray(rows) ? rows : [])
		.filter((r) => r && !r.cancelled_at && isAvailabilityDay(r.from_date) && isAvailabilityDay(r.to_date))
		.filter((r) => {
			const s = requestStatusOf(r);
			return (s === "requested" && r.to_date >= todayKey) || (s === "declined" && r.from_date >= todayKey);
		})
		.sort((a, b) => textCompare(a.from_date, b.from_date) || Number(a.id) - Number(b.id))
		.map((r) => {
			const waiting = requestStatusOf(r) === "requested";
			return {
				id: r.id, kind: r.kind, from: r.from_date, to: r.to_date, request: waiting ? "waiting" : "declined",
				canCancel: !!canAct && waiting && r.source === "driver" && Number(accountId) > 0 && Number(r.created_by_user_id) === Number(accountId),
			};
		});
}

// What a staff row view adds about a row's request: `request` ("waiting",
// "approved" or "declined"), `source` ("staff" or "driver") and who decided and
// when (null for a row staff recorded).
function requestRowFields(row) {
	return {
		request: REQUEST_WORDS[requestStatusOf(row)] || "approved",
		source: row && row.source === "driver" ? "driver" : "staff",
		decidedBy: row && row.decided_by ? String(row.decided_by) : null,
		decidedAt: row && row.decided_at ? String(row.decided_at) : null,
	};
}

// The staff notice of a new request (type "time-off-request"): title "Time off
// request: Hollis Renner (Nov 9 – Nov 13)", body "Off duty. Asked Nov 2."
function requestNoticeText({ driverName, kind, from, to, askedDay }) {
	const name = String(driverName == null ? "" : driverName).trim() || "A driver";
	const asked = isAvailabilityDay(askedDay) ? ` Asked ${monthDayText(askedDay)}.` : "";
	return { title: `Time off request: ${name} (${availabilityRangeText(from, to)})`, body: `${KIND_WORDS[kind] || "Time off"}.${asked}` };
}

// The driver's in-app notice about their time off, `event` "approved",
// "declined", "changed" (staff moved or shortened time off that started as
// their request; the new days) or "cancelled" (staff cancelled it). It never
// says who decided or why. null for any other event.
function driverTimeOffNotice({ event, from, to }) {
	const range = availabilityRangeText(from, to);
	if (!range) return null;
	if (event === "approved") return { title: `Time off approved: ${range}`, body: "" };
	if (event === "declined") return { title: `Time off not approved: ${range}`, body: "Message dispatch." };
	if (event === "changed") return { title: `Dispatch changed your time off: ${range}`, body: "" };
	if (event === "cancelled") return { title: `Dispatch cancelled your time off: ${range}`, body: "" };
	return null;
}

module.exports = {
	AVAILABILITY_KINDS,
	AVAILABILITY_MAX_DAYS,
	AVAILABILITY_BACKDATE_DAYS,
	AVAILABILITY_REASON_MAX,
	isAvailabilityDay,
	shiftAvailabilityDay,
	validateAvailability,
	availabilityEditScope,
	availabilityEditLimits,
	availabilityCreateLimits,
	availabilityFields,
	returningFromMs,
	groupAvailabilityByDriver,
	currentTruckDriver,
	standingConfirmations,
	truckAvailabilityFields,
	offDutyCheckDriver,
	offDutyLoadWindow,
	offDutyConflict,
	loadsNewlyInTimeOff,
	timeOffLoadSkip,
	parseConfirmLoads,
	timeOffLoadsDecision,
	driverHasLoadsBody,
	availabilityRangeText,
	currentOrNextOff,
	REQUEST_LEAD_DAYS,
	REQUEST_HORIZON_DAYS,
	REQUEST_WAITING_MAX,
	requestStatusOf,
	driverRequestLimits,
	validateDriverRequest,
	driverRequestIdentity,
	driverRequestCancelCheck,
	requestDecisionCheck,
	driverRequestsView,
	requestRowFields,
	requestNoticeText,
	driverTimeOffNotice,
};
