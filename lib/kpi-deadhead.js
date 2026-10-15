"use strict";
// THE KPI DEADHEAD CHAIN (R10): for each load, the empty miles from the truck's
// previous delivery to this pickup, for the KPI bot's deadhead_miles.
//
//   computeDeadhead(loads, { timeZone, truckAt, truckIdByUnit, routes })
//       -> { byKey: Map(key -> result), pending: [{ pairKey, from, to }], counts }
//   pickupInstant(load, timeZone) / deliveryInstant(load, timeZone) -> { ms, source, zoneSource }
//   pairKey(from, to) / samePoint(from, to)
//
// SOURCE OF A LOAD'S DEADHEAD (rule 5). The rate con's stated Empty Movement when
// it states one, whatever the chain says; else the Google route distance of a
// chained pair (kpi_deadhead_routes, filled by lib/kpi-deadhead-routes.js); else
// unknown: null, never 0. Two points equal after rounding to 4 decimals are 0 mi
// with no route call.
//
// THE TRUCK OF A LOAD (rule 1): load_eld_miles.truck_id, else the driver's dated
// assignment at the pickup instant (lib/load-haul.js buildTruckAtResolver(),
// passed in as `truckAt`), else the Job Tracking Truck column mapped to a truck
// id (`truckIdByUnit`). No truck: unknown.
//
// THE CHAIN (rules 2-4). Every live load of the truck (the gatherer passes
// liveJobTrackingView() rows, so soft-deleted loads are gone; cancelled ones are
// dropped here again; any other status, in-progress included, stays), sorted by
// (pickup instant, lowercased load key), so the chain is the same whatever order
// the sheet lists them in. The previous load is the one just before; each load is
// a previous once at most.
//   - previous delivery strictly AFTER this pickup: an overlap, no deadhead, and
//     no search further back (equal instants chain with a gap of 0);
//   - a gap over 72 h (strictly) is a restart (home, the shop): not counted;
//   - a previous with no delivery instant leaves this load unknown.
//
// MARKERS (3a). A load with no usable pickup instant (no text, unreadable, more
// than 3 days from its day, or after its own delivery) stays in the chain as a
// marker at its delivery instant (else its day's last instant in APP_TIMEZONE).
// Dropping it would pair the next load with the one before it, across the
// marker: the miles counted across an overlap that the first draft got wrong.
// Its own deadhead is unknown unless its rate con states Empty Movement, and the
// next load's deadhead is unknown.
//
// LOADS PICKED UP BEFORE A MARKER (3b, as the final review tightened it). The
// marker's real pickup came before its delivery, so any load picked up within
// 72 h before (or at) a marker's delivery instant is unknown: it may overlap the
// marker. Only a stated Empty Movement still counts. (The earlier text, "after
// the last chained delivery", let a load picked up AND delivered before the
// marker's delivery pair with the load before it.)
//
// TEXT TO INSTANT (rule 2a). Pickup = the ELD pickup arrival, else the Pickup
// Appointment. Delivery = the ELD arrival, else the Drop-off Appointment, else
// the Completion Date. Appointments go through lib/kpi-appointments.js
// parseAppointment(), with the load's day as refDay (its 3-day plausibility
// stands: an appointment further from the load's day falls to the next source)
// and APP_TIMEZONE as fallbackZone. The clock is the zone written in the text,
// else the dock's longitude band (the pickup end reads origin_lng, the drop-off
// end dest_lng), else APP_TIMEZONE, counted. One time: that instant. A window: a
// pickup takes its START, a drop-off its END. Date-only and FCFS: a pickup is
// 00:00 of the day, a drop-off the day's last instant, on the dock's clock. A
// pickup cannot begin before its window opens and a delivery is due by its
// window's end, so this reading never misses an overlap; an overlap leaves the
// load unknown, so a wide window costs coverage, never miles. The Completion
// Date is the app's own stamp, read in APP_TIMEZONE (a date-only one is that
// day's last instant there).
//
// Results carry the internal load keys and truck ids for lib/kpi-metrics.js to
// aggregate; neither ever leaves the server.
//
// Pure: no I/O, no environment reads. Requires lib/kpi-appointments.js and
// lib/app-time.js (wallClockToMs), both pure. The zone is always an argument.

const { parseAppointment } = require("./kpi-appointments");
const { wallClockToMs } = require("./app-time");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// A gap longer than this between a delivery and the next pickup is a restart.
const RESTART_MS = 72 * HOUR_MS;
// Loads picked up this long before a marker's delivery (or less) may overlap it.
const MARKER_LOOKBACK_MS = 72 * HOUR_MS;
const COORD_DECIMALS = 4;
const DROPPED_STATUS_RE = /^(cancel|canceled|cancelled)$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const trimmed = (v) => String(v == null ? "" : v).trim();

function dayParts(day) {
	return [+day.slice(0, 4), +day.slice(5, 7), +day.slice(8, 10)];
}
function nextDayParts(day) {
	const [y, m, d] = dayParts(day);
	const t = new Date(Date.UTC(y, m - 1, d, 12) + DAY_MS);
	return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}
function dayStartMs(day, zone) {
	const [y, m, d] = dayParts(day);
	return wallClockToMs(zone, y, m, d, 0, 0, 0);
}
function dayEndMs(day, zone) {
	const [y, m, d] = nextDayParts(day);
	return wallClockToMs(zone, y, m, d, 0, 0, 0) - 1;
}

// A coordinate pair rounded to the cache's precision (about 11 m), or null.
// Exactly 0,0 is a blank stored as zeros (no dock sits there): missing, so two
// such ends never read as "the same place, 0 mi".
function point(lat, lng) {
	if (!isNum(lat) || !isNum(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
	if (lat === 0 && lng === 0) return null;
	const f = 10 ** COORD_DECIMALS;
	const r = (v) => (Math.round(v * f) / f) || 0;
	return { lat: r(lat), lng: r(lng) };
}
// The kpi_deadhead_routes key of a leg: "<fromLat>,<fromLng>><toLat>,<toLng>".
function pairKey(from, to) {
	const a = point(from && from.lat, from && from.lng);
	const b = point(to && to.lat, to && to.lng);
	return a && b ? `${a.lat},${a.lng}>${b.lat},${b.lng}` : null;
}
function samePoint(a, b) {
	const p = point(a && a.lat, a && a.lng);
	const q = point(b && b.lat, b && b.lng);
	return !!(p && q && p.lat === q.lat && p.lng === q.lng);
}

function refDayOf(load) {
	return typeof load.day === "string" && DAY_RE.test(load.day) ? load.day : null;
}

// An appointment cell as an instant: a pickup takes a window's start and a
// day's first instant, a drop-off a window's end and a day's last instant.
function appointmentMs(text, lng, refDay, timeZone, end) {
	if (!trimmed(text)) return null;
	const p = parseAppointment(text, { destLng: isNum(lng) ? lng : null, refDay, fallbackZone: timeZone });
	if (p.status !== "ok") return null;
	let ms;
	if (p.kind === "date_only" || p.kind === "fcfs") ms = end ? dayEndMs(p.day, p.zone) : dayStartMs(p.day, p.zone);
	else if (p.kind === "window") ms = end ? p.deadlineMs : p.startMs;
	else ms = p.deadlineMs;
	return isNum(ms) ? { ms, zoneSource: p.zoneSource } : null;
}

// The app's Completion Date stamp: an instant with a zone as itself; anything
// else on the APP_TIMEZONE clock; a date alone is that day's last instant there.
function completionMs(text, refDay, timeZone) {
	const s = trimmed(text).slice(0, 60);
	if (!s) return null;
	if (ISO_INSTANT_RE.test(s)) {
		const ms = Date.parse(s);
		return isNum(ms) ? { ms, zoneSource: "text" } : null;
	}
	return appointmentMs(s, null, refDay, timeZone, true);
}

function pickupInstant(load, timeZone) {
	if (isNum(load.pickupArriveMs) && load.pickupArriveMs > 0) return { ms: load.pickupArriveMs, source: "eld", zoneSource: null };
	const a = appointmentMs(load.pickupText, load.originLng, refDayOf(load), timeZone, false);
	return a ? { ms: a.ms, source: "appointment", zoneSource: a.zoneSource } : { ms: null, source: null, zoneSource: null };
}

function deliveryInstant(load, timeZone) {
	if (isNum(load.destArriveMs) && load.destArriveMs > 0) return { ms: load.destArriveMs, source: "eld", zoneSource: null };
	const refDay = refDayOf(load);
	const a = appointmentMs(load.dropoffText, load.destLng, refDay, timeZone, true);
	if (a) return { ms: a.ms, source: "appointment", zoneSource: a.zoneSource };
	const c = completionMs(load.completionText, refDay, timeZone);
	return c ? { ms: c.ms, source: "completion", zoneSource: c.zoneSource } : { ms: null, source: null, zoneSource: null };
}

function idText(v) {
	const s = trimmed(v);
	return s && s !== "0" ? s : null;
}

function computeDeadhead(loads, opts) {
	const o = opts && typeof opts === "object" ? opts : {};
	const timeZone = o.timeZone;
	if (typeof timeZone !== "string" || !timeZone) throw new TypeError("computeDeadhead: timeZone is required");
	const truckAt = o.truckAt && typeof o.truckAt.forDriverAt === "function" ? o.truckAt : null;
	const byUnit = o.truckIdByUnit instanceof Map ? o.truckIdByUnit : new Map();
	const routes = o.routes instanceof Map ? o.routes : new Map();
	const counts = { truckSource: { eld: 0, resolver: 0, column: 0, none: 0 }, zoneFallback: 0, markers: 0, unplaced: 0 };
	const byKey = new Map();
	const pending = new Map();

	// Each live load once, its instants and its truck.
	const seen = new Set();
	const entries = [];
	for (const raw of Array.isArray(loads) ? loads : []) {
		if (!raw || typeof raw !== "object") continue;
		const key = trimmed(raw.key).toLowerCase();
		if (!key || seen.has(key) || DROPPED_STATUS_RE.test(trimmed(raw.status))) continue;
		seen.add(key);
		const pu = pickupInstant(raw, timeZone);
		const del = deliveryInstant(raw, timeZone);
		if (pu.zoneSource === "fallback") counts.zoneFallback++;
		if (del.zoneSource === "fallback") counts.zoneFallback++;
		const marker = pu.ms == null || (del.ms != null && pu.ms > del.ms);
		const day = refDayOf(raw);
		const sortMs = marker ? (del.ms != null ? del.ms : (day ? dayEndMs(day, timeZone) : null)) : pu.ms;
		const result = {
			truckId: null, truckSource: null, state: null, marker, prevKey: null, gapMs: null,
			pickupMs: marker ? null : pu.ms, deliveryMs: del.ms, sortMs,
			pairKey: null, deadheadMiles: null, source: null,
		};
		byKey.set(key, result);
		const stated = isNum(raw.statedEmptyMiles) && raw.statedEmptyMiles >= 0 ? raw.statedEmptyMiles : null;
		if (stated != null) {
			result.deadheadMiles = stated;
			result.source = "stated";
		}

		let truckId = idText(raw.eldTruckId);
		let truckSource = truckId ? "eld" : null;
		if (!truckId && truckAt && trimmed(raw.driverKey) && sortMs != null) {
			const hit = truckAt.forDriverAt(raw.driverKey, sortMs);
			truckId = hit ? idText(hit.truck_id) : null;
			if (truckId) truckSource = "resolver";
		}
		if (!truckId) {
			const unit = trimmed(raw.truckKey).toLowerCase();
			truckId = unit && byUnit.has(unit) ? idText(byUnit.get(unit)) : null;
			if (truckId) truckSource = "column";
		}
		counts.truckSource[truckSource || "none"]++;
		result.truckId = truckId;
		result.truckSource = truckSource;
		if (marker) counts.markers++;
		if (!truckId) {
			result.state = "no_truck";
			continue;
		}
		if (sortMs == null) {
			result.state = "unplaced";
			counts.unplaced++;
			continue;
		}
		entries.push({ key, load: raw, result });
	}

	const byTruck = new Map();
	for (const e of entries) {
		if (!byTruck.has(e.result.truckId)) byTruck.set(e.result.truckId, []);
		byTruck.get(e.result.truckId).push(e);
	}
	for (const list of byTruck.values()) {
		list.sort((a, b) => (a.result.sortMs - b.result.sortMs) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		for (let i = 0; i < list.length; i++) {
			const cur = list[i];
			const r = cur.result;
			if (r.marker) {
				r.state = "marker";
				continue;
			}
			const prev = i > 0 ? list[i - 1] : null;
			if (!prev) {
				r.state = "first";
				continue;
			}
			r.prevKey = prev.key;
			if (prev.result.marker) r.state = "after_marker";
			else if (prev.result.deliveryMs == null) r.state = "prev_no_delivery";
			else if (prev.result.deliveryMs > r.pickupMs) r.state = "overlap";
			else {
				r.gapMs = r.pickupMs - prev.result.deliveryMs;
				r.state = r.gapMs > RESTART_MS ? "restart" : "chained";
			}
			if (r.state === "chained") {
				r.pairKey = pairKey({ lat: prev.load.destLat, lng: prev.load.destLng }, { lat: cur.load.originLat, lng: cur.load.originLng });
			}
		}
		// 3b: loads picked up within 72 h before (or at) a marker's instant.
		const markerTimes = list.filter((e) => e.result.marker).map((e) => e.result.sortMs);
		for (const e of list) {
			const r = e.result;
			if (r.marker) continue;
			if (markerTimes.some((m) => r.pickupMs <= m && r.pickupMs >= m - MARKER_LOOKBACK_MS)) {
				r.state = "before_marker";
				r.pairKey = null;
			}
		}
		const onTruck = new Map(list.map((e) => [e.key, e]));
		for (const e of list) {
			const r = e.result;
			if (r.source === "stated" || r.state !== "chained" || !r.pairKey) continue;
			const prevLoad = onTruck.get(r.prevKey).load;
			const from = { lat: prevLoad.destLat, lng: prevLoad.destLng };
			const to = { lat: e.load.originLat, lng: e.load.originLng };
			if (samePoint(from, to)) {
				r.deadheadMiles = 0;
				r.source = "route";
				continue;
			}
			const cached = routes.get(r.pairKey);
			if (cached && cached.status === "ok" && isNum(cached.distanceMiles) && cached.distanceMiles >= 0) {
				r.deadheadMiles = cached.distanceMiles;
				r.source = "route";
			} else if (!cached || cached.status !== "ok") {
				// No answer yet, or a failed one: pending. The job
				// (lib/kpi-deadhead-routes.js) waits 30 days before it asks a
				// failed pair again; dropping it here would leave it unknown forever.
				const pf = point(from.lat, from.lng);
				const pt = point(to.lat, to.lng);
				pending.set(r.pairKey, { pairKey: r.pairKey, from: pf, to: pt });
			}
		}
	}
	return { byKey, pending: [...pending.values()], counts };
}

module.exports = {
	RESTART_MS,
	MARKER_LOOKBACK_MS,
	COORD_DECIMALS,
	pairKey,
	roundPoint: point,
	samePoint,
	pickupInstant,
	deliveryInstant,
	computeDeadhead,
};
