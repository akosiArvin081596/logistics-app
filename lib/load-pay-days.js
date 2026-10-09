"use strict";
// Which days a completed load pays its driver, before Super Admin overrides.
//
// ONE COPY FOR THE THREE PAY PATHS. POST /api/invoices/generate, GET
// /api/investor and the payout ledger (computeLedgerScope() in
// lib/financials-calc.js, behind payouts and Financials) each turn a load's
// pickup -> drop-off window into paid days, and they must agree day for day.
// Each of them calls payDaysForLoad(); none keeps its own copy of the rule.
//
// 1. ELD intersection, unchanged from the three inline copies it replaces: when
//    the truck's ELD reported anything on a window day (coverage), only the
//    window days it moved on (travel, a fix faster than ~5 mph) count. A window
//    the ELD never covered counts in full, so pay is not zeroed for a truck with
//    no feed.
//
// 2. The pre-dispatch rule, behind PRE_DISPATCH_PAY_DAY_RULE_ENABLED (default
//    off) and PRE_DISPATCH_PAY_DAY_RULE_FROM (the first month it applies to;
//    without one the rule stays off). A drop-trailer rate con can carry a pickup
//    date that is the window for dropping an empty trailer (Drop Date/Time) or an
//    unconfirmed "Scheduled Pick-up Date, Needs Confirmation" note. Ingestion
//    copies it into Pickup Appointment, so the load's window opens on a day
//    before the load was dispatched, and any ELD movement that day (a short
//    local move) pays it. With the flag on, a covered day stops counting FOR
//    THAT LOAD when all of these hold:
//      - the day pays in FROM or a later month. A day pays in the load's settle
//        month (its Assigned month), or in its own month when the load has none,
//        as the three paths bucket it. That is all that decides whether the rule
//        applies: never a month lock, so a day pays the same before and after a
//        month closes or reopens, and a load settling before FROM never changes;
//      - the load has a recorded dispatch (its earliest Dispatched row in
//        load_status_history), on a day after this one and no later than the
//        window's last day, read in the truck's own zone that day;
//      - the truck's ELD distance that day is known and under 50 km: every
//        odometer step touching the day, from the last reading before it to the
//        first one after it, accepted by lib/eld-miles.js (no gap the truck moved
//        across while the ELD was dark, no impossible speed, no reset);
//      - the truck had not yet loaded: no fix within the geofence radius of the
//        load's pickup (load_coordinates) on any day of the load's window up to
//        and including that day. Once the truck has been at the pickup, every
//        later day is the haul, so a rest day mid-haul keeps paying even on a
//        load entered after the fact.
//    Anything unknown keeps the day: no Dispatched row, a dispatch recorded after
//    the window, no pickup coordinates, fewer than two odometer readings that
//    day, a rejected odometer step, no reading before or after the day. A day
//    another load also covers still counts through that load.

const geolib = require("geolib");
const eldMiles = require("./eld-miles");

const PRE_DISPATCH_MAX_KM = 50;
const KM_PER_MILE = 1.609344;
const HOUR_MS = 3600 * 1000;
// A month the rule can start from: "YYYY-MM", month 01-12.
const FROM_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// PRE_DISPATCH_PAY_DAY_RULE_FROM, read once at start: the month, or null. With
// the flag on and no month there the rule stays off, and `warn` is told once.
// The warning names the setting, never its value.
function ruleFromMonth(enabled, raw, warn) {
	const value = String(raw ?? "").trim();
	if (FROM_MONTH_RE.test(value)) return value;
	if (enabled && typeof warn === "function") {
		warn("PRE_DISPATCH_PAY_DAY_RULE_FROM is not a month (YYYY-MM); the pre-dispatch pay-day rule stays off.");
	}
	return null;
}

// The start-up notice when FROM is at or before `latestClosed`, the latest
// closed month, or null. A notice, not an instruction: once FROM's own month
// has closed with the rule on, it appears on every start, and that is expected.
// It never asks for FROM to be moved: closed months' live recomputes (the
// investor view, the payout drill-down and statement appendix, the loss carried
// into open months) read the rule from FROM, so changing FROM after the rule
// has run would change them. The rule keeps running either way.
function fromMonthClosedWarning(fromMonth, latestClosed) {
	if (!FROM_MONTH_RE.test(String(fromMonth || "")) || !MONTH_KEY_RE.test(String(latestClosed || ""))) return null;
	if (fromMonth > latestClosed) return null;
	return `PRE_DISPATCH_PAY_DAY_RULE_FROM is at or before ${latestClosed}, the latest closed month: expected once `
		+ "PRE_DISPATCH_PAY_DAY_RULE_FROM's month has closed with the rule on. Never change PRE_DISPATCH_PAY_DAY_RULE_FROM once the rule has run.";
}

// { covered, days }: the window days the ELD counts (step 1 above).
function eldCountedDays(windowDays, eld) {
	const covered = !!eld && windowDays.some((d) => eld.coverage.has(d));
	return { covered, days: covered ? windowDays.filter((d) => eld.travel.has(d)) : windowDays };
}

// The days a load pays: the ELD-counted days, then the pre-dispatch rule when
// a filter is given (createPreDispatchFilter() returns null with the rule off).
// Only an ELD-covered window is filtered: without a feed there is no distance.
// `load` is { loadId, vid, settleMonth, windowStart, windowEnd }; windowStart and
// windowEnd, the load's first and last window days, default to the ends of
// windowDays and must be given by a caller whose windowDays are clipped (the
// weekly invoice).
function payDaysForLoad(windowDays, eld, load, preDispatch) {
	const { covered, days } = eldCountedDays(windowDays, eld);
	if (!covered || !preDispatch || !days.length) return { covered, days };
	return {
		covered,
		days: preDispatch({
			...load,
			windowStart: (load && load.windowStart) || windowDays[0],
			windowEnd: (load && load.windowEnd) || windowDays[windowDays.length - 1],
		}, days),
	};
}

// The calendar day after a "YYYY-MM-DD" day (no zone: a day is a date).
function nextDay(day) {
	return new Date(Date.parse(day + "T12:00:00Z") + 24 * HOUR_MS).toISOString().slice(0, 10);
}

function num(v) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function pointOf(p) {
	const lat = num(p && p.lat);
	const lng = num(p && p.lng);
	if (lat === null || lng === null || (lat === 0 && lng === 0)) return null;
	return { latitude: lat, longitude: lng };
}

// A fix's local day, bucketed exactly as the ELD travel days are.
const localDayOf = (p) => eldMiles.localDayInTz(num(p.ms), eldMiles.usTzForLongitude(num(p.lng)));

// How far the truck can have moved on `day`, in km, or null when that is not
// known. Every odometer step with an end on the day counts, including the step
// in from the last reading before the day and the step out to the first reading
// after it, so a move while the ELD was dark at either edge is seen. Each step
// is judged as lib/eld-miles.js judges it (the same dedupe and acceptOdoDelta());
// a rejected one (the truck moved across a gap, an impossible speed, a reset)
// makes the day unknown, as do fewer than two readings on the day or no reading
// before or after it.
function dayKm(located, day) {
	const rows = eldMiles.dedupeSamples(located);
	const onDay = rows.map((r) => localDayOf(r) === day);
	const first = onDay.indexOf(true);
	const last = onDay.lastIndexOf(true);
	if (onDay.filter(Boolean).length < 2 || first === 0 || last === rows.length - 1) return null;
	let miles = 0;
	for (let i = 1; i < rows.length; i++) {
		if (!onDay[i - 1] && !onDay[i]) continue;
		const step = eldMiles.acceptOdoDelta(rows[i - 1].odo, rows[i].odo, rows[i - 1].ms, rows[i].ms);
		if (!step.ok) return null;
		miles += step.miles;
	}
	return miles * KM_PER_MILE;
}

// What one truck did on one of its local days. `pings` are that truck's clean
// fixes ({ ms, lat, lng, odo }) around the day, in any order, with the last one
// before it and the first one after it; each is bucketed into the truck's local
// day exactly as the ELD travel days are.
//   km        dayKm(): the distance the day can have held, or null if unknown
//   zone      the truck's zone at its last fix that day, or null with no fix
//   atPickup  a fix within radiusM of the pickup; null without coordinates
function dayActivity(pings, day, { pickup, radiusM }) {
	const located = (pings || []).filter((p) => num(p && p.lng) !== null && num(p.ms) !== null);
	const mine = located.filter((p) => localDayOf(p) === day);
	let last = null;
	for (const p of mine) if (!last || p.ms > last.ms) last = p;
	const center = pointOf(pickup);
	const atPickup = center
		? mine.some((p) => {
			const here = pointOf(p);
			return !!here && geolib.isPointWithinRadius(here, center, radiusM);
		})
		: null;
	return {
		pings: mine.length,
		km: dayKm(located, day),
		zone: last ? eldMiles.usTzForLongitude(num(last.lng)) : null,
		atPickup,
	};
}

// True when `day` stops counting for the load. `activity` is dayActivity()'s
// answer for the day, its atPickup meaning "had reached the pickup by then";
// `windowEnd` is the load's last window day. Every unknown answers false.
function isPreDispatchIdleDay({ day, dispatchMs, activity, windowEnd = null, maxKm = PRE_DISPATCH_MAX_KM }) {
	if (!Number.isFinite(dispatchMs) || !activity || !activity.zone) return false;
	const dispatchDay = eldMiles.localDayInTz(dispatchMs, activity.zone);
	if (!(dispatchDay > day)) return false;
	// A dispatch recorded after the window ended is not the one the haul began
	// with (a load typed in after the fact and dispatched later): unknown.
	if (DAY_KEY_RE.test(String(windowEnd || "")) && dispatchDay > windowEnd) return false;
	if (activity.km === null || !(activity.km < maxKm)) return false;
	return activity.atPickup === false;
}

// load_status_history keys a load lower-case with any leading "#" removed
// (recordStatusChange()).
function statusKey(loadId) {
	return String(loadId || "").trim().toLowerCase().replace(/^#/, "");
}

// The rule as a filter over one load's ELD-counted days, reading what it needs
// from `db` lazily and once per request. Returns null when the rule is off (the
// flag off, or no FROM month), so payDaysForLoad() returns the ELD-counted days
// untouched. Nothing here reads a month lock.
//   fromMonth      PRE_DISPATCH_PAY_DAY_RULE_FROM ("YYYY-MM")
//   radiusM        the live geofence radius (GEOFENCE_RADIUS)
//   onDrop(info)   optional; told about each dropped day
function createPreDispatchFilter({ db, enabled, fromMonth, radiusM, onDrop = null }) {
	if (!enabled || !FROM_MONTH_RE.test(String(fromMonth || ""))) return null;
	let dispatchMsByLoad = null;
	let coordsStmt = null;
	let pingStmt = null;
	let beforeStmt = null;
	let afterStmt = null;
	const coordsMemo = new Map();
	const activityMemo = new Map();

	// The month a day pays in (see the header) and whether the rule covers it.
	const inEffect = (settleMonth, day) => {
		const month = settleMonth || day.slice(0, 7);
		return MONTH_KEY_RE.test(month) && month >= fromMonth;
	};
	// The earliest Dispatched row per load. Any other status (a driver's tap, an
	// admin override to another status, the geofence, a decline) is no dispatch.
	const dispatchMsFor = (loadId) => {
		if (!dispatchMsByLoad) {
			dispatchMsByLoad = new Map();
			const rows = db.prepare(
				`SELECT load_id, MIN(changed_at) AS first_at FROM load_status_history
				 WHERE LOWER(TRIM(new_status)) = 'dispatched' GROUP BY load_id`
			).all();
			for (const r of rows) {
				const ms = Date.parse(String(r.first_at || "").trim().replace(" ", "T") + "Z");
				if (Number.isFinite(ms)) dispatchMsByLoad.set(r.load_id, ms);
			}
		}
		return dispatchMsByLoad.get(statusKey(loadId));
	};
	const pickupFor = (loadId) => {
		const raw = String(loadId || "").trim();
		if (!coordsMemo.has(raw)) {
			if (!coordsStmt) coordsStmt = db.prepare("SELECT origin_lat AS lat, origin_lng AS lng FROM load_coordinates WHERE load_id IN (?, ?) LIMIT 1");
			const row = raw ? coordsStmt.get(raw, raw.replace(/^#/, "")) : null;
			coordsMemo.set(raw, row && pointOf(row) ? { lat: row.lat, lng: row.lng } : null);
		}
		return coordsMemo.get(raw);
	};
	const activityFor = (vid, day, pickup) => {
		const key = `${vid}|${day}|${pickup.lat},${pickup.lng}`;
		if (!activityMemo.has(key)) {
			if (!pingStmt) {
				const cols = "location_date_ms AS ms, latitude AS lat, longitude AS lng, odometer AS odo";
				const clean = "routemate_vehicle_id = ? AND dropped_reason = ''";
				// The bounding readings: a fix with an odometer and a position, as
				// dayKm() reads them.
				const reading = "odometer > 0 AND longitude IS NOT NULL";
				pingStmt = db.prepare(`SELECT ${cols} FROM routemate_telemetry WHERE ${clean} AND location_date_ms >= ? AND location_date_ms < ?`);
				beforeStmt = db.prepare(`SELECT ${cols} FROM routemate_telemetry WHERE ${clean} AND ${reading} AND location_date_ms < ? ORDER BY location_date_ms DESC LIMIT 1`);
				afterStmt = db.prepare(`SELECT ${cols} FROM routemate_telemetry WHERE ${clean} AND ${reading} AND location_date_ms >= ? ORDER BY location_date_ms ASC LIMIT 1`);
			}
			// Every US local day of `day` lies inside [day 00:00Z, day+1 12:00Z);
			// the margin either side costs a few rows and dayActivity() buckets.
			const startMs = Date.parse(day + "T00:00:00Z") - 12 * HOUR_MS;
			const endMs = startMs + 48 * HOUR_MS;
			const pings = pingStmt.all(String(vid), startMs, endMs);
			const before = beforeStmt.get(String(vid), startMs);
			const after = afterStmt.get(String(vid), endMs);
			if (before) pings.push(before);
			if (after) pings.push(after);
			activityMemo.set(key, dayActivity(pings, day, { pickup, radiusM }));
		}
		return activityMemo.get(key);
	};
	// Whether the truck reached the pickup on any window day from windowStart
	// through `day`: after that, the load is being hauled. A window is at most a
	// month (expandDateRange()); the bound only stops a malformed start.
	const MAX_SCAN_DAYS = 62;
	const loadedBy = (vid, pickup, windowStart, day) => {
		let d = DAY_KEY_RE.test(String(windowStart || "")) && windowStart <= day ? windowStart : day;
		for (let i = 0; d <= day && i < MAX_SCAN_DAYS; i++, d = nextDay(d)) {
			if (activityFor(vid, d, pickup).atPickup) return true;
		}
		return false;
	};

	return function preDispatch(load, days) {
		const loadId = load && load.loadId;
		const vid = load && load.vid;
		if (!loadId || !vid) return days;
		const settleMonth = String((load && load.settleMonth) || "");
		if (!days.some((day) => inEffect(settleMonth, day))) return days;
		const dispatchMs = dispatchMsFor(loadId);
		if (!Number.isFinite(dispatchMs)) return days;
		// A local day before dispatch is before its UTC day too (every US zone is
		// behind UTC), so later days need no telemetry read.
		const dispatchUtcDay = new Date(dispatchMs).toISOString().slice(0, 10);
		let pickup;
		const kept = days.filter((day) => {
			if (!(day < dispatchUtcDay) || !inEffect(settleMonth, day)) return true;
			if (pickup === undefined) pickup = pickupFor(loadId);
			if (!pickup) return true;
			const own = activityFor(vid, day, pickup);
			const activity = { ...own, atPickup: own.atPickup || loadedBy(vid, pickup, load.windowStart, day) };
			if (!isPreDispatchIdleDay({ day, dispatchMs, activity, windowEnd: load.windowEnd })) return true;
			if (onDrop) onDrop({ loadId: String(loadId), vid: String(vid), day, settleMonth, km: activity.km, dispatchMs });
			return false;
		});
		return kept.length === days.length ? days : kept;
	};
}

module.exports = {
	PRE_DISPATCH_MAX_KM,
	KM_PER_MILE,
	ruleFromMonth,
	fromMonthClosedWarning,
	eldCountedDays,
	payDaysForLoad,
	dayActivity,
	isPreDispatchIdleDay,
	createPreDispatchFilter,
};
