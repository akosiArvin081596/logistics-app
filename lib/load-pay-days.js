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
//    off). A drop-trailer rate con can carry a pickup date that is the window
//    for dropping an empty trailer (Drop Date/Time) or an unconfirmed
//    "Scheduled Pick-up Date, Needs Confirmation" note. Ingestion copies it into
//    Pickup Appointment, so the load's window opens on a day before the load was
//    dispatched, and any ELD movement that day (a short local move) pays it.
//    With the flag on, a covered day stops counting FOR THAT LOAD when all of
//    these hold:
//      - the load has a recorded dispatch (its first load_status_history row,
//        the same dispatch fact the haul replay uses) and the day is before the
//        dispatch day, read in the truck's own zone that day;
//      - the truck's ELD distance that day (accepted odometer deltas,
//        lib/eld-miles.js) is known and under 50 km;
//      - the truck had not yet loaded: no fix within the geofence radius of the
//        load's pickup (load_coordinates) on any day of the load's window up to
//        and including that day. Once the truck has been at the pickup, every
//        later day is the haul, so a rest day mid-haul keeps paying even on a
//        load entered after the fact;
//      - the day's month and the month the day settles in (the load's Assigned
//        month) are both open. A finalized month never moves.
//    Anything unknown keeps the day: no dispatch row, no pickup coordinates,
//    fewer than two odometer readings, an unreadable lock table. A day another
//    load also covers still counts through that load.

const geolib = require("geolib");
const eldMiles = require("./eld-miles");

const PRE_DISPATCH_MAX_KM = 50;
const KM_PER_MILE = 1.609344;
const HOUR_MS = 3600 * 1000;

// { covered, days }: the window days the ELD counts (step 1 above).
function eldCountedDays(windowDays, eld) {
	const covered = !!eld && windowDays.some((d) => eld.coverage.has(d));
	return { covered, days: covered ? windowDays.filter((d) => eld.travel.has(d)) : windowDays };
}

// The days a load pays: the ELD-counted days, then the pre-dispatch rule when
// a filter is given (createPreDispatchFilter() returns null with the flag off).
// Only an ELD-covered window is filtered: without a feed there is no distance.
// `load` is { loadId, vid, settleMonth, windowStart }; windowStart, the load's
// first window day, defaults to windowDays[0] and must be given by a caller
// whose windowDays are clipped (the weekly invoice).
function payDaysForLoad(windowDays, eld, load, preDispatch) {
	const { covered, days } = eldCountedDays(windowDays, eld);
	if (!covered || !preDispatch || !days.length) return { covered, days };
	return { covered, days: preDispatch({ ...load, windowStart: (load && load.windowStart) || windowDays[0] }, days) };
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

// What one truck did on one of its local days. `pings` are that truck's clean
// fixes ({ ms, lat, lng, odo }) around the day, in any order; each is bucketed
// into the truck's local day exactly as the ELD travel days are.
//   km        accepted odometer distance, or null with fewer than two readings
//   zone      the truck's zone at its last fix that day, or null with no fix
//   atPickup  a fix within radiusM of the pickup; null without coordinates
function dayActivity(pings, day, { pickup, radiusM }) {
	const mine = (pings || []).filter((p) => {
		const lng = num(p && p.lng);
		return lng !== null && num(p.ms) !== null && eldMiles.localDayInTz(p.ms, eldMiles.usTzForLongitude(lng)) === day;
	});
	const odo = eldMiles.sumOdoDeltas(mine);
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
		km: odo.samples >= 2 ? odo.miles * KM_PER_MILE : null,
		zone: last ? eldMiles.usTzForLongitude(num(last.lng)) : null,
		atPickup,
	};
}

// True when `day` stops counting for the load. `activity` is dayActivity()'s
// answer for the day, its atPickup meaning "had reached the pickup by then".
// Every unknown answers false.
function isPreDispatchIdleDay({ day, dispatchMs, activity, maxKm = PRE_DISPATCH_MAX_KM }) {
	if (!Number.isFinite(dispatchMs) || !activity || !activity.zone) return false;
	if (!(eldMiles.localDayInTz(dispatchMs, activity.zone) > day)) return false;
	if (activity.km === null || !(activity.km < maxKm)) return false;
	return activity.atPickup === false;
}

// load_status_history keys a load lower-case with any leading "#" removed
// (recordStatusChange()).
function statusKey(loadId) {
	return String(loadId || "").trim().toLowerCase().replace(/^#/, "");
}

// The rule as a filter over one load's ELD-counted days, reading what it needs
// from `db` lazily and once per request. Returns null when the flag is off, so
// payDaysForLoad() returns the ELD-counted days untouched.
//   monthOpen(mk)  true only for a month that is readable and not finalized
//   radiusM        the live geofence radius (GEOFENCE_RADIUS)
//   onDrop(info)   optional; told about each dropped day
function createPreDispatchFilter({ db, enabled, monthOpen, radiusM, onDrop = null }) {
	if (!enabled) return null;
	let firstStatusMs = null;
	let coordsStmt = null;
	let pingStmt = null;
	const openMemo = new Map();
	const coordsMemo = new Map();
	const activityMemo = new Map();

	const isOpen = (mk) => {
		if (!openMemo.has(mk)) {
			let open = false;
			try { open = !!monthOpen(mk); } catch { open = false; }
			openMemo.set(mk, open);
		}
		return openMemo.get(mk);
	};
	const dispatchMsFor = (loadId) => {
		if (!firstStatusMs) {
			firstStatusMs = new Map();
			const rows = db.prepare("SELECT load_id, MIN(changed_at) AS first_at FROM load_status_history GROUP BY load_id").all();
			for (const r of rows) {
				const ms = Date.parse(String(r.first_at || "").trim().replace(" ", "T") + "Z");
				if (Number.isFinite(ms)) firstStatusMs.set(r.load_id, ms);
			}
		}
		return firstStatusMs.get(statusKey(loadId));
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
				pingStmt = db.prepare(
					`SELECT location_date_ms AS ms, latitude AS lat, longitude AS lng, odometer AS odo
					 FROM routemate_telemetry
					 WHERE routemate_vehicle_id = ? AND dropped_reason = ''
					   AND location_date_ms >= ? AND location_date_ms < ?`
				);
			}
			// Every US local day of `day` lies inside [day 00:00Z, day+1 12:00Z);
			// the margin either side costs a few rows and dayActivity() buckets.
			const startMs = Date.parse(day + "T00:00:00Z") - 12 * HOUR_MS;
			const pings = pingStmt.all(String(vid), startMs, startMs + 48 * HOUR_MS);
			activityMemo.set(key, dayActivity(pings, day, { pickup, radiusM }));
		}
		return activityMemo.get(key);
	};
	// Whether the truck reached the pickup on any window day from windowStart
	// through `day`: after that, the load is being hauled. A window is at most a
	// month (expandDateRange()); the bound only stops a malformed start.
	const MAX_SCAN_DAYS = 62;
	const loadedBy = (vid, pickup, windowStart, day) => {
		let d = /^\d{4}-\d{2}-\d{2}$/.test(String(windowStart || "")) && windowStart <= day ? windowStart : day;
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
		if (settleMonth && !isOpen(settleMonth)) return days;
		const dispatchMs = dispatchMsFor(loadId);
		if (!Number.isFinite(dispatchMs)) return days;
		// A local day before dispatch is before its UTC day too (every US zone is
		// behind UTC), so later days need no telemetry read.
		const dispatchUtcDay = new Date(dispatchMs).toISOString().slice(0, 10);
		let pickup;
		const kept = days.filter((day) => {
			if (!(day < dispatchUtcDay) || !isOpen(day.slice(0, 7))) return true;
			if (pickup === undefined) pickup = pickupFor(loadId);
			if (!pickup) return true;
			const own = activityFor(vid, day, pickup);
			const activity = { ...own, atPickup: own.atPickup || loadedBy(vid, pickup, load.windowStart, day) };
			if (!isPreDispatchIdleDay({ day, dispatchMs, activity })) return true;
			if (onDrop) onDrop({ loadId: String(loadId), vid: String(vid), day, settleMonth, km: activity.km, dispatchMs });
			return false;
		});
		return kept.length === days.length ? days : kept;
	};
}

module.exports = {
	PRE_DISPATCH_MAX_KM,
	KM_PER_MILE,
	eldCountedDays,
	payDaysForLoad,
	dayActivity,
	isPreDispatchIdleDay,
	createPreDispatchFilter,
};
