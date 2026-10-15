"use strict";
// Which days a daily-rate driver worked on a load, read from the driver app's
// trip timestamps (load_status_history): the owner's rule (B12, 2026-10-14).
//
// Behind TRIP_WORK_DAYS_ENABLED (default off; true/1/yes/on turns it on) and
// TRIP_WORK_DAYS_FROM (the first month it applies to; without one the rule
// stays off). A completed load whose settle month (its Assigned month, or the
// month its trip starts in when it has none) is FROM or later pays its trip days
// on all three pay paths (the weekly invoice, GET /api/investor and the payout
// ledger), with no ELD intersection and no pre-dispatch filter. A load settling
// before FROM, or one without a full trip, pays exactly as before
// (lib/load-pay-days.js payDaysForLoad()). Nothing here reads a month lock.
//
// THE RULE (tripDaysForLoad(), pure):
//   - only the events after the last Cancelled count;
//   - the trip starts at the first At Shipper, else the first Loading, else the
//     first In Transit (flag noAtShipper). Without At Shipper, an ELD fix inside
//     the pickup geofence after the load's dispatch and before that start moves
//     the start back to the fix (pickupFixesMs);
//   - it ends at the last Delivered, or on the At Receiver day when Delivered was
//     tapped 2 or more calendar days after it (flag lateTap; the last At Receiver
//     before the Delivered tap, so a multi-stop load ends at its last stop). One
//     day later is an overnight unload and counts both days;
//   - every day from start to end in the business zone (APP_TIMEZONE, US
//     Eastern), capped at 31 days (flag capped), as the ledger caps a window;
//   - a Delivered tap only (deliveredOnly), a start with no Delivered
//     (noDelivered), or a Delivered before the start (endBeforeStart) is
//     basis "partial": today's rule applies. No rows is basis "none".
//   - flags for a person (the dry run lists them): cancelledAfterStart, a start
//     before the last Cancelled; multiActor, taps by two driver accounts (the
//     whole trip still goes to the sheet's Driver).
// changed_at is stored as UTC "YYYY-MM-DD HH:MM:SS" with no Z.
//
// The owner's rule is an exception to lib/load-haul.js's "replayed from pings,
// never read off load_status_history": there the haul window is measured; here
// the owner asked for pay to follow the driver's own trip taps.

const geolib = require("geolib");
const appTime = require("./app-time");
const ledgerDayOnce = require("./ledger-day-once");

const FROM_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TRIP_DAYS = 31;
const ENABLED_RE = /^(true|1|yes|on)$/i;
// Sources whose actor is the driver (recordStatusChange() callers): the driver
// app's taps, accept / decline, and the geofence acting for the driver.
const DRIVER_SOURCES = new Set(["manual", "accept", "decline", "geofence"]);

// The rule's first month from the process environment, or null (the rule is
// off). With the flag on and no month, `warn` (given at start only) is told; the
// warning names the setting, never its value.
function ruleFromEnv(env, warn = null) {
	if (!env || !ENABLED_RE.test(String(env.TRIP_WORK_DAYS_ENABLED ?? "").trim())) return null;
	const value = String(env.TRIP_WORK_DAYS_FROM ?? "").trim();
	if (FROM_MONTH_RE.test(value)) return value;
	if (typeof warn === "function") warn("TRIP_WORK_DAYS_FROM is not set to a month (YYYY-MM); the trip work-day rule stays off.");
	return null;
}

// The start-up notice when FROM is at or before the latest closed month, or
// null. Built like lib/load-pay-days.js fromMonthClosedWarning(): expected on
// every start once FROM's own month has closed with the rule on.
function fromMonthClosedWarning(fromMonth, latestClosed) {
	if (!FROM_MONTH_RE.test(String(fromMonth || "")) || !MONTH_KEY_RE.test(String(latestClosed || ""))) return null;
	if (fromMonth > latestClosed) return null;
	return `TRIP_WORK_DAYS_FROM is at or before ${latestClosed}, the latest closed month: expected once `
		+ "TRIP_WORK_DAYS_FROM's month has closed with the rule on. Never change TRIP_WORK_DAYS_FROM once the rule has run.";
}

// load_status_history keys a load lower-case with any leading "#" removed.
function statusKey(loadId) {
	return String(loadId || "").trim().toLowerCase().replace(/^#/, "");
}

// A stored changed_at as epoch ms (UTC, no Z), or NaN.
function stampMs(s) {
	return Date.parse(String(s ?? "").trim().replace(" ", "T") + "Z");
}

const FORMATTERS = new Map();
// The calendar day of an instant in `zone`, "YYYY-MM-DD".
function dayInZone(ms, zone) {
	if (!FORMATTERS.has(zone)) {
		FORMATTERS.set(zone, new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }));
	}
	return FORMATTERS.get(zone).format(new Date(ms));
}

function nextDay(day) {
	return new Date(Date.parse(`${day}T12:00:00Z`) + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysBetween(a, b) {
	return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / (24 * 3600 * 1000));
}

const statusOf = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const isCancel = (s) => /^cancell?ed$/.test(s);

// One load's trip days. `events` are its load_status_history rows in any order:
// { new_status, changed_at, source, actor }. opts:
//   zone           the business zone (APP_TIMEZONE)
//   pickupFixesMs  epoch ms of ELD fixes inside the load's pickup geofence
// Returns { basis, days, start, end, startEvent, dispatchMs, startMs, flags }:
// days "YYYY-MM-DD" in `zone`, start / end ISO instants, flags an object of
// booleans (only the true ones are present).
function tripDaysForLoad(events, opts = {}) {
	const zone = opts.zone || "America/New_York";
	const maxDays = opts.maxDays || MAX_TRIP_DAYS;
	const flags = {};
	const rows = (events || [])
		.map((e, i) => ({ status: statusOf(e && e.new_status), ms: stampMs(e && e.changed_at), at: String((e && e.changed_at) || "").trim(),
			source: String((e && e.source) || "").trim().toLowerCase(), actor: String((e && e.actor) || "").trim().toLowerCase().replace(/\s+/g, " "), i }))
		.filter((r) => r.status && Number.isFinite(r.ms))
		.sort((a, b) => a.ms - b.ms || a.i - b.i);
	const none = (basis) => ({ basis, days: [], start: null, end: null, startEvent: null, dispatchMs: null, startMs: null, flags });
	if (!rows.length) return none("none");

	let lastCancel = -1;
	rows.forEach((r, idx) => { if (isCancel(r.status)) lastCancel = idx; });
	const live = rows.slice(lastCancel + 1);
	const first = (status) => live.find((r) => r.status === status) || null;
	if (lastCancel >= 0 && rows.slice(0, lastCancel).some((r) => ["at shipper", "loading", "in transit", "at receiver"].includes(r.status))) {
		flags.cancelledAfterStart = true;
	}
	const actors = new Set(live.filter((r) => DRIVER_SOURCES.has(r.source) && r.actor).map((r) => r.actor));
	if (actors.size > 1) flags.multiActor = true;

	let startEv = first("at shipper");
	if (!startEv) {
		startEv = first("loading") || first("in transit");
		if (startEv) flags.noAtShipper = true;
	}
	const delivered = [...live].reverse().find((r) => r.status === "delivered") || null;
	if (!startEv) {
		if (delivered) flags.deliveredOnly = true;
		return none(live.length ? "partial" : "none");
	}
	let startMs = startEv.ms;
	const dispatch = [...live].reverse().find((r) => r.status === "dispatched" && r.ms <= startEv.ms) || null;
	const dispatchMs = dispatch ? dispatch.ms : null;
	if (flags.noAtShipper && dispatch && Array.isArray(opts.pickupFixesMs)) {
		const fix = opts.pickupFixesMs.filter((ms) => Number.isFinite(ms) && ms > dispatch.ms && ms < startEv.ms).sort((a, b) => a - b)[0];
		if (fix !== undefined) { startMs = fix; flags.pickupFix = true; }
	}
	if (!delivered) {
		flags.noDelivered = true;
		return { ...none("partial"), startMs, dispatchMs };
	}
	const startDay = dayInZone(startMs, zone);
	let endMs = delivered.ms;
	let endDay = dayInZone(endMs, zone);
	// The last At Receiver between the start and the Delivered tap: a multi-stop
	// load taps At Receiver at each stop, and the trip ends at the last one.
	const arrival = [...live].reverse().find((r) => r.status === "at receiver" && r.ms >= startEv.ms && r.ms <= delivered.ms) || null;
	if (arrival) {
		const arrivalDay = dayInZone(arrival.ms, zone);
		if (DAY_KEY_RE.test(arrivalDay) && daysBetween(arrivalDay, endDay) >= 2) {
			endMs = arrival.ms;
			endDay = arrivalDay;
			flags.lateTap = true;
		}
	}
	if (endDay < startDay) {
		flags.endBeforeStart = true;
		return { ...none("partial"), startMs, dispatchMs };
	}
	const days = [];
	for (let d = startDay; d <= endDay; d = nextDay(d)) {
		if (days.length >= maxDays) { flags.capped = true; break; }
		days.push(d);
	}
	return {
		basis: "trip",
		days,
		start: new Date(startMs).toISOString(),
		end: new Date(endMs).toISOString(),
		startEvent: flags.pickupFix ? { status: "pickup geofence fix", at: new Date(startMs).toISOString() } : { status: startEv.status, at: startEv.at },
		dispatchMs,
		startMs,
		flags,
	};
}

// The rule for one request: the history read once, each load's trip worked out
// once. Returns null while the rule is off (the flag off, or no FROM month).
//   forLoad({ loadId, settleMonth, range, vid })
//     the load's trip days within range ({ start, end } day keys, either may
//     be absent), sorted; [] when none falls in range; null when the load does
//     not follow the rule (it settles before FROM, or has no full trip). The
//     settle month is the load's Assigned month, or the month its trip starts
//     in when it has none (its days then settle in their own months, none
//     before FROM).
//   trip(loadId, { vid })  tripDaysForLoad()'s whole answer, for the dry run.
// radiusM is the geofence radius; with a vehicle id and the load's pickup
// coordinates, a trip with no At Shipper reads the truck's fixes inside the
// pickup geofence between its dispatch and its first Loading / In Transit tap.
function createTripDayResolver({ db, enabled = true, fromMonth, zone, radiusM = 0 }) {
	if (!enabled || !db || !FROM_MONTH_RE.test(String(fromMonth || ""))) return null;
	let byLoad = null;
	const memo = new Map();
	let coordsStmt = null;
	let fixStmt = null;
	const eventsFor = (key) => {
		if (!byLoad) {
			byLoad = new Map();
			let rows = [];
			try {
				rows = db.prepare("SELECT load_id, new_status, changed_at, source, actor FROM load_status_history ORDER BY changed_at, id").all();
			} catch {
				rows = [];
			}
			for (const r of rows) {
				const k = statusKey(r.load_id);
				if (!k) continue;
				if (!byLoad.has(k)) byLoad.set(k, []);
				byLoad.get(k).push(r);
			}
		}
		return byLoad.get(key) || [];
	};
	const pickupFixes = (loadId, vid, fromMs, toMs) => {
		if (!vid || !(radiusM > 0) || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [];
		try {
			if (!coordsStmt) coordsStmt = db.prepare("SELECT origin_lat AS lat, origin_lng AS lng FROM load_coordinates WHERE load_id IN (?, ?) LIMIT 1");
			const raw = String(loadId || "").trim();
			const c = coordsStmt.get(raw, raw.replace(/^#/, ""));
			const lat = c ? Number(c.lat) : NaN;
			const lng = c ? Number(c.lng) : NaN;
			if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return [];
			if (!fixStmt) {
				fixStmt = db.prepare("SELECT location_date_ms AS ms, latitude AS lat, longitude AS lng FROM routemate_telemetry WHERE routemate_vehicle_id = ? AND dropped_reason = '' AND location_date_ms > ? AND location_date_ms < ?");
			}
			const center = { latitude: lat, longitude: lng };
			return fixStmt.all(String(vid), fromMs, toMs)
				.filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
					&& geolib.isPointWithinRadius({ latitude: Number(p.lat), longitude: Number(p.lng) }, center, radiusM))
				.map((p) => Number(p.ms));
		} catch {
			return [];
		}
	};
	function trip(loadId, { vid = null } = {}) {
		const key = statusKey(loadId);
		const memoKey = `${key}|${vid || ""}`;
		if (memo.has(memoKey)) return memo.get(memoKey);
		const events = key ? eventsFor(key) : [];
		let t = tripDaysForLoad(events, { zone });
		if (t.basis === "trip" && t.flags.noAtShipper && Number.isFinite(t.dispatchMs)) {
			const fixes = pickupFixes(loadId, vid, t.dispatchMs, t.startMs);
			if (fixes.length) t = tripDaysForLoad(events, { zone, pickupFixesMs: fixes });
		}
		memo.set(memoKey, t);
		return t;
	}
	function forLoad({ loadId, settleMonth = "", range = null, vid = null } = {}) {
		const t = trip(loadId, { vid });
		if (t.basis !== "trip" || !t.days.length) return null;
		// A load with no Assigned Date settles each day in its own month, so it
		// follows the rule only when its first day is FROM or later: no month
		// before FROM ever changes.
		const gate = MONTH_KEY_RE.test(String(settleMonth || "")) ? settleMonth : t.days[0].slice(0, 7);
		if (gate < fromMonth) return null;
		const lo = range && range.start ? range.start : "";
		const hi = range && range.end ? range.end : "";
		return t.days.filter((d) => (!lo || d >= lo) && (!hi || d <= hi));
	}
	return { fromMonth, forLoad, trip };
}

// The pickup geofence radius, read as server.js reads GEOFENCE_RADIUS
// (GEOFENCE_RADIUS_M when positive, else 3,218.69 m, two miles);
// scripts/test-trip-work-days-flags.js pins the two equal.
const DEFAULT_GEOFENCE_RADIUS_M = 3218.69;
function geofenceRadiusFromEnv(env) {
	const n = Number(env && env.GEOFENCE_RADIUS_M);
	return n > 0 ? n : DEFAULT_GEOFENCE_RADIUS_M;
}

// The one composition of the two rules: the earlier of LEDGER_DAY_ONCE_FROM
// (its own flag, lib/ledger-day-once.js ruleFromEnv()) and the trip rule's
// FROM `tripFrom`, or null when both are off.
function dayOnceFromFor(env, tripFrom) {
	const froms = [ledgerDayOnce.ruleFromEnv(env), tripFrom || null].filter(Boolean).sort();
	return froms.length ? froms[0] : null;
}

// What one payout-ledger computation runs with: { tripDays, dayOnceFrom }.
//   tripDays     the rule's resolver (null while it is off), from
//                TRIP_WORK_DAYS_FROM, or `rules.tripFrom` when the caller set
//                one (the work-days dry run compares the rule off and on);
//   dayOnceFrom  the month from which a driver-day counts in one month only:
//                the earlier of LEDGER_DAY_ONCE_FROM (its own flag) and the
//                trip rule's FROM, which reuses that rule (lib/ledger-day-once.js),
//                or null when both are off.
// server.js reaches this through financialsCalc.tripWorkDays, as it reaches the
// day-once rule, so every lifted copy of the ledger's fact gathering keeps the
// names it already has. The zone is APP_TIMEZONE's (lib/app-time.js).
function ledgerFacts({ db, env, rules = null }) {
	const tripFrom = rules && Object.prototype.hasOwnProperty.call(rules, "tripFrom") ? (rules.tripFrom || null) : ruleFromEnv(env);
	return {
		dayOnceFrom: dayOnceFromFor(env, tripFrom),
		tripDays: tripFrom
			? createTripDayResolver({ db, enabled: true, fromMonth: tripFrom, zone: appTime.appTimeZone(), radiusM: geofenceRadiusFromEnv(env) })
			: null,
	};
}

module.exports = {
	FROM_MONTH_RE,
	MAX_TRIP_DAYS,
	DEFAULT_GEOFENCE_RADIUS_M,
	geofenceRadiusFromEnv,
	dayOnceFromFor,
	ledgerFacts,
	ruleFromEnv,
	fromMonthClosedWarning,
	statusKey,
	stampMs,
	dayInZone,
	tripDaysForLoad,
	createTripDayResolver,
};
