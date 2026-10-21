"use strict";
// Which days a daily-rate driver worked on a load, read from the driver app's
// trip timestamps (load_status_history) and the truck's ELD: the owner's rule
// (B12, 2026-10-14) as decision d words it (Arvin, 2026-10-21; pay plan
// ~/LogisX-replica/reports/2026-10-21-pay-plan.md, section 1, answers P1-P18).
//
// Behind TRIP_WORK_DAYS_ENABLED (default off; true/1/yes/on turns it on) and
// TRIP_WORK_DAYS_FROM (the first month it applies to; without one the rule
// stays off). A completed load whose settle month (its Assigned month, or the
// month its trip starts in when it has none) is FROM or later pays the days this
// rule gives it on all three pay paths (the weekly invoice, GET /api/investor
// and the payout ledger), with no window intersection and no pre-dispatch
// filter. A load settling before FROM, or one the rule cannot place, pays exactly
// as before (lib/load-pay-days.js payDaysForLoad()). Nothing here reads a month
// lock.
//
// DECISION d: a day is paid when the driver is driving or loading/unloading on a
// dispatched trip, from the day he heads to the pickup through the day he
// unloads; days he only waits are not paid. The drive to a dispatched pickup is
// paid even empty; arriving the day before loading is paid only if he drove that
// day; waiting days at a shipper or receiver are not paid; the unloading day
// after waiting is paid. With no status updates: the appointment dates plus the
// days the ELD shows driving. Every day is a day in the business zone
// (APP_TIMEZONE, US Eastern), the ELD's included: for trip-rule loads this
// replaces "a driver's worked day is still the truck's local day".
//
// THE RULE (tripDaysForLoad(), pure). Only the events after the last Cancelled
// count. `window` is the path's own pay window as day keys (payWindow(): the
// Plan D blank-appointment flags differ by path), `eld` the truck's Eastern days
// (covered: any clean fix at or after the device's link time; driving: one
// faster than 2.235 m/s, the travel-day test).
//   A  arrival: the first At Shipper, else the first Loading, else the first In
//      Transit (flag noAtShipper), moved earlier by an ELD fix inside the pickup
//      geofence after the dispatch (flag pickupFix). No arrival tap (flag
//      arrivalFromWindow): the latest of the window's first day, D's day and the
//      Assigned Date (money review M2); when that is after the window's first
//      day the appointment is stale (flag staleAppointment): it is no loading
//      day, and nothing before A is paid; a window wholly before A pays nothing.
//      No window either: no answer.
//   D  the latest Dispatched or Assigned row at or before A; one after it is
//      ignored. With no arrival tap: the latest up to the Delivered tap.
//   H  the first Heading to Shipper at or after D (any, with no D) and at or
//      before A.
//   loading days: every Loading-tap day in the span (multi-stop). With none, the
//      Pickup Appointment day when it falls between A's day and the first In
//      Transit day, else that In Transit day; with no In Transit, the Pickup
//      Appointment day on or after A's day, else A's day ("loading-fallback").
//      With A from the window, the window's first day ("appointment").
//   U  unloading: the last Delivered day, or the receiver exit (the first ELD fix
//      leaving the drop-off geofence after the last At Receiver) when earlier
//      (flag receiverExit). With no exit to read (no ELD fix after the arrival,
//      or no drop-off coordinates) and Delivered tapped 2+ days after the last At
//      Receiver (flag lateTap, P8 (b)): the At Receiver day and the Delivered day
//      are paid, never the days between ("lateTapGap"). The At Receiver days of
//      earlier stops are unloading days. No Delivered: the window's last day.
//   S  span start: H's day; else a walk back from A's day over consecutive
//      driving days, not before D's day (flag walkBack); no D and no H: A's day.
//      With A from the window: not before D's day nor the Assigned Date (P6), and
//      no walk back without either. Capped at 31 days (flag capped).
//   paid = the driving days in S..U, the loading days, the unloading days and,
//      with A from the window, its appointment days. No fix on any span day:
//      every span day (flag noEld). Dropped: "waiting", "restDay" (between
//      loading and the last stop), "dark" (no fix that day), "lateTapGap".
// basis "trip" (the taps place it), "appointments" (no status rows: the window
// and the ELD), "partial" (rows that place nothing; the path's window rule
// applies), "none" (nothing at all).
// changed_at is stored as UTC "YYYY-MM-DD HH:MM:SS" with no Z.
//
// The owner's rule is an exception to lib/load-haul.js's "replayed from pings,
// never read off load_status_history": there the haul window is measured; here
// the owner asked for pay to follow the driver's own trip taps.

const geolib = require("geolib");
const appTime = require("./app-time");
const ledgerDayOnce = require("./ledger-day-once");
const eldPosition = require("./eld-position");

const FROM_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TRIP_DAYS = 31;
// A clean fix faster than this is driving: the travel-day test of
// server.js getEldTravelDaysByVehicle() and GEOFENCE_DEPART_SPEED_MPS, ~5 mph
// (Q1); scripts/test-trip-work-days-flags.js pins the three equal.
const DRIVING_MPS = 2.235;
// Sources whose actor is the driver (recordStatusChange() callers): the driver
// app's taps, accept / decline, and the geofence acting for the driver.
const DRIVER_SOURCES = new Set(["manual", "accept", "decline", "geofence"]);

// The rule's first month from the process environment, or null (the rule is
// off). With the flag on and no month, `warn` (given at start only) is told; the
// warning names the setting, never its value.
function ruleFromEnv(env, warn = null) {
	if (!env || !/^(true|1|yes|on)$/i.test(String(env.TRIP_WORK_DAYS_ENABLED ?? "").trim())) return null;
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

function addDays(day, n) {
	return new Date(Date.parse(`${day}T12:00:00Z`) + n * 24 * 3600 * 1000).toISOString().slice(0, 10);
}
const nextDay = (day) => addDays(day, 1);
const prevDay = (day) => addDays(day, -1);

function daysBetween(a, b) {
	return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / (24 * 3600 * 1000));
}

const statusOf = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const isCancel = (s) => /^cancell?ed$/.test(s);
const dayKeyOr = (v) => (DAY_KEY_RE.test(String(v || "")) ? String(v) : "");

// The path's pay window as day keys: { start, end, pickup, assigned }, each a
// "YYYY-MM-DD" or "" (end defaults to start, never before it).
function normalizeWindow(w) {
	const start = dayKeyOr(w && w.start);
	let end = dayKeyOr(w && w.end) || start;
	if (start && end < start) end = start;
	return { start, end: start ? end : "", pickup: dayKeyOr(w && w.pickup), assigned: dayKeyOr(w && w.assigned) };
}

// Consecutive taps of one status make one stop (a repeated tap at the same
// place); the same status after another one is the next stop.
function stopsOf(rows, status) {
	const groups = [];
	let open = false;
	for (const r of rows) {
		if (r.status === status) {
			if (!open) groups.push([]);
			groups[groups.length - 1].push(r);
			open = true;
		} else {
			open = false;
		}
	}
	return groups;
}

// One load's trip days. `events` are its load_status_history rows in any order:
// { new_status, changed_at, source, actor }. opts:
//   zone           the business zone (APP_TIMEZONE)
//   window         the path's pay window as day keys { start, end, pickup, assigned }
//   eld            { covered, driving }: Sets of the truck's Eastern days, or null
//   receiverExit   { ms }: the first fix leaving the drop-off geofence after the
//                  last At Receiver (ms null: read, and never left), or null when
//                  it cannot be read
//   pickupFixesMs  epoch ms of ELD fixes inside the load's pickup geofence
// Returns { basis, days, reasons, dropped, flags, stops, spanStart, spanEnd,
// start, end, startEvent, dispatchMs, startMs, readRange, receiverArrivalMs,
// deliveredMs }: days "YYYY-MM-DD" in `zone`; reasons day -> why it is paid
// (heading, driving, loading, loading-fallback, unloading, appointment, noEld);
// dropped day -> why a span day is not (waiting, restDay, dark, lateTapGap);
// flags an object of booleans (only the true ones present); readRange the days
// whose ELD the answer can read ({ from, to }); start / end ISO instants (the
// arrival, and the Delivered tap or the receiver exit).
function tripDaysForLoad(events, opts = {}) {
	const zone = opts.zone || appTime.appTimeZone();
	const maxDays = opts.maxDays || MAX_TRIP_DAYS;
	const win = normalizeWindow(opts.window);
	const flags = {};
	const dayOf = (ms) => dayInZone(ms, zone);
	const rows = (events || [])
		.map((e, i) => ({ status: statusOf(e && e.new_status), ms: stampMs(e && e.changed_at), at: String((e && e.changed_at) || "").trim(),
			source: String((e && e.source) || "").trim().toLowerCase(), actor: String((e && e.actor) || "").trim().toLowerCase().replace(/\s+/g, " "), i }))
		.filter((r) => r.status && Number.isFinite(r.ms))
		.sort((a, b) => a.ms - b.ms || a.i - b.i);
	const none = (basis) => ({
		basis, days: [], reasons: {}, dropped: {}, flags, stops: { pickups: 0, drops: 0 }, spanStart: null, spanEnd: null,
		start: null, end: null, startEvent: null, dispatchMs: null, startMs: null, readRange: null, receiverArrivalMs: null, deliveredMs: null,
	});

	let lastCancel = -1;
	rows.forEach((r, idx) => { if (isCancel(r.status)) lastCancel = idx; });
	const live = rows.slice(lastCancel + 1);
	if (lastCancel >= 0 && rows.slice(0, lastCancel).some((r) => ["at shipper", "loading", "in transit", "at receiver"].includes(r.status))) {
		flags.cancelledAfterStart = true;
	}
	const actors = new Set(live.filter((r) => DRIVER_SOURCES.has(r.source) && r.actor).map((r) => r.actor));
	if (actors.size > 1) flags.multiActor = true;
	const first = (status, from = -Infinity) => live.find((r) => r.status === status && r.ms >= from) || null;

	// A: the arrival.
	let arrivalEv = first("at shipper");
	if (!arrivalEv) {
		arrivalEv = first("loading") || first("in transit");
		if (arrivalEv) flags.noAtShipper = true;
	}
	const delivered = [...live].reverse().find((r) => r.status === "delivered") || null;
	if (!live.length && !win.start) return none("none");
	if (!arrivalEv && !win.start) {
		if (delivered) flags.deliveredOnly = true;
		return none("partial");
	}
	const isDispatch = (r) => r.status === "dispatched" || r.status === "assigned";
	let aMs = null;
	let aDay;
	let dispatch;
	if (arrivalEv) {
		dispatch = [...live].reverse().find((r) => isDispatch(r) && r.ms <= arrivalEv.ms) || null;
		aMs = arrivalEv.ms;
		if (flags.noAtShipper && dispatch && Array.isArray(opts.pickupFixesMs)) {
			const fix = opts.pickupFixesMs.filter((ms) => Number.isFinite(ms) && ms > dispatch.ms && ms < arrivalEv.ms).sort((a, b) => a - b)[0];
			if (fix !== undefined) { aMs = fix; flags.pickupFix = true; }
		}
		aDay = dayOf(aMs);
	} else {
		// No arrival tap: the trip starts at the latest of the window's first day,
		// the dispatch the haul began with (the latest Dispatched or Assigned row
		// up to the Delivered tap) and the Assigned Date (money review M2). A Pickup
		// Appointment before the load was dispatched or assigned (a drop-trailer
		// date, a stale one) is no trip day (flag staleAppointment), nor is any
		// day the ELD shows driving before that start.
		flags.arrivalFromWindow = true;
		dispatch = [...live].reverse().find((r) => isDispatch(r) && (!delivered || r.ms <= delivered.ms)) || null;
		aDay = [win.start, dispatch ? dayOf(dispatch.ms) : "", win.assigned].filter(Boolean).sort().pop();
		if (aDay > win.start) flags.staleAppointment = true;
	}
	if (!live.length) flags.noStatusRows = true;
	const dDay = dispatch ? dayOf(dispatch.ms) : "";

	// H: the first Heading to Shipper after the dispatch, at or before the arrival.
	const heading = live.find((r) => r.status === "heading to shipper" && (!dispatch || r.ms >= dispatch.ms)
		&& (aMs !== null ? r.ms <= aMs : dayOf(r.ms) <= aDay)) || null;

	// U: the unloading day. With the arrival or the end from the window, its
	// appointment days are paid (decision d: "the appointment dates").
	const unloading = new Set();
	const appointments = new Set();
	if (flags.arrivalFromWindow && !flags.staleAppointment) appointments.add(win.start);
	const lateGap = new Set();
	let uDay;
	let endMs = null;
	let receiverArrival = null;
	const arrivalFloor = aMs !== null ? aMs : -Infinity;
	if (delivered) {
		const deliveredDay = dayOf(delivered.ms);
		receiverArrival = [...live].reverse().find((r) => r.status === "at receiver" && r.ms >= arrivalFloor && r.ms <= delivered.ms) || null;
		uDay = deliveredDay;
		endMs = delivered.ms;
		if (receiverArrival) {
			const rDay = dayOf(receiverArrival.ms);
			const exit = opts.receiverExit;
			if (exit && Number.isFinite(exit.ms)) {
				const exitDay = dayOf(exit.ms);
				if (exitDay < deliveredDay && exitDay >= rDay) { uDay = exitDay; endMs = exit.ms; flags.receiverExit = true; }
			} else if (!exit && daysBetween(rDay, deliveredDay) >= 2) {
				flags.lateTap = true;
				for (let d = nextDay(rDay); d < deliveredDay; d = nextDay(d)) lateGap.add(d);
				unloading.add(rDay);
			}
		}
		unloading.add(uDay);
	} else {
		if (live.length) flags.noDelivered = true;
		if (!win.start) return { ...none("partial"), startMs: aMs, dispatchMs: dispatch ? dispatch.ms : null };
		uDay = win.end;
		unloading.add(uDay);
		appointments.add(uDay);
	}
	if (uDay < aDay) {
		flags.endBeforeStart = true;
		// With no arrival tap the rule still covers the load: its whole window (or
		// its Delivered tap) falls before the trip's start, so it pays nothing,
		// never the window the path would otherwise pay.
		if (flags.arrivalFromWindow) {
			return { ...none(live.length ? "trip" : "appointments"), spanStart: aDay, spanEnd: uDay, dispatchMs: dispatch ? dispatch.ms : null, deliveredMs: delivered ? delivered.ms : null };
		}
		return { ...none("partial"), startMs: aMs, dispatchMs: dispatch ? dispatch.ms : null };
	}

	// Stops: earlier drops are unloading days; distinct stops are counted.
	const inTrip = (r) => r.ms >= arrivalFloor && (!delivered || r.ms <= delivered.ms);
	const tripRows = live.filter(inTrip);
	const dropStops = stopsOf(tripRows, "at receiver");
	const lastDrop = dropStops[dropStops.length - 1] || null;
	for (const stop of dropStops.slice(0, -1)) for (const r of stop) { const d = dayOf(r.ms); if (d >= aDay && d <= uDay) unloading.add(d); }
	const stops = { pickups: Math.max(stopsOf(tripRows, "loading").length, stopsOf(tripRows, "at shipper").length), drops: dropStops.length };
	if (stops.pickups > 1 || stops.drops > 1) flags.multiStop = true;

	// Loading days. The first In Transit after the arrival also starts the haul:
	// a covered day after it with no driving is a rest day, one before it waiting.
	const transit = arrivalEv ? first("in transit", arrivalEv.ms) : null;
	const loading = new Map();
	const loadingTaps = tripRows.filter((r) => r.status === "loading").map((r) => dayOf(r.ms)).filter((d) => d >= aDay && d <= uDay);
	if (loadingTaps.length) {
		for (const d of loadingTaps) loading.set(d, "loading");
	} else if (flags.arrivalFromWindow) {
		// A stale appointment loads nothing: only driving days and the end count.
		if (!flags.staleAppointment) loading.set(win.start, "appointment");
	} else {
		const appt = win.pickup;
		let day;
		if (transit) {
			const itDay = dayOf(transit.ms);
			day = appt && appt >= aDay && appt <= itDay ? appt : itDay;
		} else {
			day = appt && appt >= aDay && appt <= uDay ? appt : aDay;
		}
		loading.set(day, "loading-fallback");
		flags.loadingFallback = true;
	}

	// The truck's days: an ELD fix inside the pickup geofence covers its day too.
	const covered = new Set(opts.eld && opts.eld.covered ? opts.eld.covered : []);
	const driving = new Set(opts.eld && opts.eld.driving ? opts.eld.driving : []);
	for (const ms of Array.isArray(opts.pickupFixesMs) ? opts.pickupFixesMs : []) if (Number.isFinite(ms)) covered.add(dayOf(ms));

	// S: the span's first day.
	let sDay = aDay;
	if (heading) {
		sDay = dayOf(heading.ms);
		flags.heading = true;
	} else {
		// With no arrival tap, not before the dispatch nor the Assigned Date (P6, M2).
		const bound = flags.arrivalFromWindow ? ([dDay, win.assigned].filter(Boolean).sort().pop() || "") : dDay;
		if (bound && bound < aDay) {
			for (let d = prevDay(aDay), i = 0; d >= bound && driving.has(d) && i < maxDays; d = prevDay(d), i++) sDay = d;
			if (sDay < aDay) flags.walkBack = true;
		}
	}

	// The span, capped, and the days it pays.
	const span = [];
	for (let d = sDay; d <= uDay; d = nextDay(d)) {
		if (span.length >= maxDays) { flags.capped = true; break; }
		span.push(d);
	}
	if (!span.some((d) => covered.has(d))) flags.noEld = true;
	const haulFrom = transit ? dayOf(transit.ms) : ([...loading.keys()].sort().pop() || aDay);
	const lastStopDay = lastDrop ? dayOf(lastDrop[0].ms) : uDay;
	const reasons = {};
	const dropped = {};
	for (const d of span) {
		if (lateGap.has(d)) { dropped[d] = "lateTapGap"; continue; }
		if (loading.has(d)) reasons[d] = loading.get(d);
		else if (unloading.has(d)) reasons[d] = appointments.has(d) ? "appointment" : "unloading";
		else if (appointments.has(d)) reasons[d] = "appointment";
		else if (flags.noEld) reasons[d] = "noEld";
		else if (driving.has(d)) reasons[d] = heading && d === sDay ? "heading" : "driving";
		else if (!covered.has(d)) dropped[d] = "dark";
		else dropped[d] = d > haulFrom && d < lastStopDay ? "restDay" : "waiting";
	}
	const days = span.filter((d) => reasons[d]);

	// The days the ELD answer may need: from the walk back's bound to the day after the end.
	const boundDay = heading ? dayOf(heading.ms) : (dDay || (flags.arrivalFromWindow ? win.assigned : "") || aDay);
	const lo = [boundDay, aDay, win.start].filter(Boolean).sort()[0];
	const from = daysBetween(lo, aDay) > maxDays ? addDays(aDay, -maxDays) : lo;
	const to = [uDay, win.end, delivered ? dayOf(delivered.ms) : ""].filter(Boolean).sort().pop();
	let startEvent;
	if (heading) startEvent = { status: heading.status, at: heading.at };
	else if (flags.walkBack) startEvent = { status: "ELD driving (walk back)", at: sDay };
	else if (flags.pickupFix) startEvent = { status: "pickup geofence fix", at: new Date(aMs).toISOString() };
	else if (arrivalEv) startEvent = { status: arrivalEv.status, at: arrivalEv.at };
	else if (flags.staleAppointment) startEvent = { status: "dispatch or Assigned Date (the Pickup Appointment is before it)", at: aDay };
	else startEvent = { status: "pickup appointment", at: aDay };
	return {
		basis: live.length ? "trip" : "appointments",
		days,
		reasons,
		dropped,
		flags,
		stops,
		spanStart: sDay,
		spanEnd: uDay,
		start: aMs !== null ? new Date(aMs).toISOString() : null,
		end: endMs !== null ? new Date(endMs).toISOString() : null,
		startEvent,
		dispatchMs: dispatch ? dispatch.ms : null,
		startMs: aMs,
		readRange: { from: prevDay(from), to: nextDay(to) },
		receiverArrivalMs: receiverArrival ? receiverArrival.ms : null,
		deliveredMs: delivered ? delivered.ms : null,
	};
}

// The rule for one request: the history read once, each load's trip worked out
// once per window. Returns null while the rule is off (the flag off, or no FROM
// month).
//   forLoad({ loadId, settleMonth, range, vid, window })
//     the load's paid days within range ({ start, end } day keys, either may be
//     absent), sorted; [] when none falls in range, or when the rule covers the
//     load and pays it no day (a stale window); null when the load does not
//     follow the rule (it settles before FROM, or the rule cannot place it: the
//     path's window rule pays it); { error } when the history, the coordinates
//     or the ELD could not be read (the path pays its window rule and names the
//     load; a month-lock guard refuses). The settle month is the load's Assigned
//     month, or the month its trip starts in when it has none (its days then
//     settle in their own months, none before FROM). `window` is the path's pay
//     window as day keys (normalizeWindow()).
//   trip(loadId, { vid, window })  tripDaysForLoad()'s whole answer, for the dry
//     run, or { basis: "error", error }.
//   lastTrip(loadId)  the answer last worked out for the load (the dry run).
//   errors()          [{ loadId, error }] of every load whose reads failed.
// radiusM is the geofence radius. With a vehicle id the truck's ELD is read in
// the business zone, fixes before the device's link time left out
// (lib/eld-position.js linkedSinceMs(); an unknown link time keeps them); with
// the load's coordinates, a trip with no At Shipper reads the fixes inside the
// pickup geofence after its dispatch, and the receiver exit is the first fix
// outside the drop-off geofence faster than DRIVING_MPS after the last At
// Receiver.
function createTripDayResolver({ db, enabled = true, fromMonth, zone, radiusM = 0 }) {
	if (!enabled || !db || !FROM_MONTH_RE.test(String(fromMonth || ""))) return null;
	let byLoad = null;
	let historyError = null;
	const memo = new Map();
	const latest = new Map();
	const errors = new Map();
	const stmts = {};
	const prep = (name, sql) => stmts[name] || (stmts[name] = db.prepare(sql));
	const eventsFor = (key) => {
		if (!byLoad) {
			byLoad = new Map();
			try {
				for (const r of db.prepare("SELECT load_id, new_status, changed_at, source, actor FROM load_status_history ORDER BY changed_at, id").all()) {
					const k = statusKey(r.load_id);
					if (!k) continue;
					if (!byLoad.has(k)) byLoad.set(k, []);
					byLoad.get(k).push(r);
				}
			} catch (err) {
				historyError = `the trip history could not be read (${err && err.message})`;
			}
		}
		if (historyError) throw new Error(historyError);
		return byLoad.get(key) || [];
	};
	const linkMemo = new Map();
	const linkedSince = (vid) => {
		if (!linkMemo.has(vid)) {
			const row = prep("link", "SELECT assigned_from, assigned_by FROM eld_device_assignments WHERE routemate_vehicle_id = ? AND assigned_until = '' ORDER BY id DESC LIMIT 1").get(vid);
			linkMemo.set(vid, eldPosition.linkedSinceMs(row));
		}
		return linkMemo.get(vid);
	};
	const afterLink = (vid) => { const since = linkedSince(vid); return (ms) => since === null || ms >= since; };
	const coordsMemo = new Map();
	const coordsOf = (loadId) => {
		const raw = String(loadId || "").trim();
		if (!coordsMemo.has(raw)) {
			const c = prep("coords", "SELECT origin_lat, origin_lng, dest_lat, dest_lng FROM load_coordinates WHERE load_id IN (?, ?) LIMIT 1").get(raw, raw.replace(/^#/, ""));
			const point = (lat, lng) => {
				const la = Number(lat);
				const ln = Number(lng);
				return lat === null || lng === null || !Number.isFinite(la) || !Number.isFinite(ln) || (la === 0 && ln === 0) ? null : { latitude: la, longitude: ln };
			};
			coordsMemo.set(raw, { origin: c ? point(c.origin_lat, c.origin_lng) : null, dest: c ? point(c.dest_lat, c.dest_lng) : null });
		}
		return coordsMemo.get(raw);
	};
	const fixesBetween = (vid, fromMs, toMs) => prep("fixes", "SELECT location_date_ms AS ms, latitude AS lat, longitude AS lng, speed FROM routemate_telemetry WHERE routemate_vehicle_id = ? AND dropped_reason = '' AND location_date_ms > ? AND location_date_ms < ? ORDER BY location_date_ms")
		.all(String(vid), fromMs, toMs).filter((p) => Number.isFinite(Number(p.ms)) && afterLink(String(vid))(Number(p.ms)));
	const inside = (p, center) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
		&& geolib.isPointWithinRadius({ latitude: Number(p.lat), longitude: Number(p.lng) }, center, radiusM);
	const pickupFixes = (loadId, vid, fromMs, toMs) => {
		const center = coordsOf(loadId).origin;
		if (!vid || !(radiusM > 0) || !center || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [];
		return fixesBetween(vid, fromMs, toMs).filter((p) => inside(p, center)).map((p) => Number(p.ms));
	};
	// null: no exit can be read (no drop-off coordinates, or no fix after the
	// arrival); { ms } the first fix leaving, or { ms: null } when none left.
	const receiverExit = (loadId, vid, arrivalMs, deliveredMs) => {
		const center = coordsOf(loadId).dest;
		if (!vid || !(radiusM > 0) || !center || !Number.isFinite(arrivalMs) || !Number.isFinite(deliveredMs)) return null;
		const fixes = fixesBetween(vid, arrivalMs, deliveredMs + 36 * 3600 * 1000);
		if (!fixes.length) return null;
		const leave = fixes.find((p) => (Number(p.speed) || 0) > DRIVING_MPS && !inside(p, center));
		return { ms: leave ? Number(leave.ms) : null };
	};
	// The truck's Eastern days from..to: { covered, driving }. Each day is read
	// once per request (the whole day, whatever the zone, from a window a day
	// wider each side).
	const dayCache = new Map();
	const eldDays = (vid, from, to) => {
		const key = String(vid);
		if (!dayCache.has(key)) dayCache.set(key, new Map());
		const cache = dayCache.get(key);
		const wanted = [];
		for (let d = from; d <= to && wanted.length < 400; d = nextDay(d)) wanted.push(d);
		const missing = wanted.filter((d) => !cache.has(d));
		if (missing.length) {
			const lo = missing[0];
			const hi = missing[missing.length - 1];
			const fresh = new Map();
			for (let d = lo; d <= hi; d = nextDay(d)) fresh.set(d, { covered: false, driving: false });
			const keep = afterLink(key);
			const rows = prep("eld", "SELECT location_date_ms AS ms, speed FROM routemate_telemetry WHERE routemate_vehicle_id = ? AND dropped_reason = '' AND location_date_ms >= ? AND location_date_ms < ?")
				.all(key, Date.parse(`${lo}T00:00:00Z`) - 24 * 3600 * 1000, Date.parse(`${hi}T00:00:00Z`) + 48 * 3600 * 1000);
			for (const r of rows) {
				const ms = Number(r.ms);
				if (!Number.isFinite(ms) || !keep(ms)) continue;
				const e = fresh.get(dayInZone(ms, zone));
				if (!e) continue;
				e.covered = true;
				if ((Number(r.speed) || 0) > DRIVING_MPS) e.driving = true;
			}
			for (const [d, e] of fresh) cache.set(d, e);
		}
		return {
			covered: new Set(wanted.filter((d) => cache.get(d).covered)),
			driving: new Set(wanted.filter((d) => cache.get(d).driving)),
		};
	};
	function trip(loadId, { vid = null, window = null } = {}) {
		const key = statusKey(loadId);
		const w = normalizeWindow(window);
		const memoKey = `${key}|${vid || ""}|${w.start}|${w.end}|${w.pickup}|${w.assigned}`;
		if (memo.has(memoKey)) return memo.get(memoKey);
		let t;
		try {
			const events = key ? eventsFor(key) : [];
			t = tripDaysForLoad(events, { zone, window: w });
			// A covered load with no day to pay (a stale window) reads no ELD.
			if ((t.basis === "trip" || t.basis === "appointments") && t.readRange) {
				let fixes = null;
				if (t.flags.noAtShipper && Number.isFinite(t.dispatchMs) && Number.isFinite(t.startMs)) {
					fixes = pickupFixes(loadId, vid, t.dispatchMs, t.startMs);
					if (fixes.length) t = tripDaysForLoad(events, { zone, window: w, pickupFixesMs: fixes });
				}
				const eld = vid ? eldDays(vid, t.readRange.from, t.readRange.to) : null;
				const exit = vid && Number.isFinite(t.receiverArrivalMs) ? receiverExit(loadId, vid, t.receiverArrivalMs, t.deliveredMs) : null;
				t = tripDaysForLoad(events, { zone, window: w, eld, receiverExit: exit, pickupFixesMs: fixes && fixes.length ? fixes : undefined });
			}
		} catch (err) {
			const error = String((err && err.message) || err);
			t = { basis: "error", error, days: [], reasons: {}, dropped: {}, flags: {}, stops: { pickups: 0, drops: 0 }, startEvent: null };
			errors.set(String(loadId || "").trim(), error);
		}
		memo.set(memoKey, t);
		latest.set(key, t);
		return t;
	}
	function forLoad({ loadId, settleMonth = "", range = null, vid = null, window = null } = {}) {
		const t = trip(loadId, { vid, window });
		if (t.basis === "error") return { error: t.error };
		if (t.basis !== "trip" && t.basis !== "appointments") return null;
		// A load with no Assigned Date settles each day in its own month, so it
		// follows the rule only when its first day is FROM or later: no month
		// before FROM ever changes. A load the rule covers with no day to pay (its
		// window wholly before its dispatch or Assigned Date) answers [], so its
		// path pays nothing for it rather than its window.
		const first = t.days[0] || t.spanStart || "";
		const gate = MONTH_KEY_RE.test(String(settleMonth || "")) ? settleMonth : first.slice(0, 7);
		if (!MONTH_KEY_RE.test(gate) || gate < fromMonth) return null;
		const lo = range && range.start ? range.start : "";
		const hi = range && range.end ? range.end : "";
		return t.days.filter((d) => (!lo || d >= lo) && (!hi || d <= hi));
	}
	return {
		fromMonth,
		forLoad,
		trip,
		lastTrip: (loadId) => latest.get(statusKey(loadId)) || null,
		errors: () => [...errors].map(([loadId, error]) => ({ loadId, error })),
	};
}

// forLoad()'s answer as the pay paths read it: the days, or null (the path's
// window rule) for null and for an { error }.
function tripDaysOrNull(answer) {
	return Array.isArray(answer) ? answer : null;
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
	DRIVING_MPS,
	DEFAULT_GEOFENCE_RADIUS_M,
	geofenceRadiusFromEnv,
	dayOnceFromFor,
	ledgerFacts,
	ruleFromEnv,
	fromMonthClosedWarning,
	statusKey,
	stampMs,
	dayInZone,
	normalizeWindow,
	tripDaysForLoad,
	tripDaysOrNull,
	createTripDayResolver,
};
