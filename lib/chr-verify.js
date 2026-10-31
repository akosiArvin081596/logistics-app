"use strict";
// No milestone goes to C.H. Robinson on a tap's word alone: a clean RouteMate
// ping from the device on the load's truck must put the truck at the stop.
// A tap far from the stop, or one no ping can place, is held for a person.
//
// Pure: the caller hands in the pings (read with PING_SQL), the stop's point,
// the radius and the clock.

const geolib = require("geolib");
const tripWorkDays = require("./trip-work-days");

const MIN = 60 * 1000;
const ARRIVE_WINDOW_MS = 15 * MIN;
const DELIVERED_WINDOW_MS = 15 * MIN;
const DEPART_BEFORE_MS = 15 * MIN;
const DEPART_AFTER_MS = 30 * MIN;
// NL3: a window closes once a ping later than its end has arrived, or after
// this grace with none, so a feed that lags never holds a good event.
const GRACE_MS = 10 * MIN;
// GEOFENCE_DEPART_SPEED_MPS (lib/trip-work-days.js keeps the pinned copy).
const DEPART_SPEED_MPS = tripWorkDays.DRIVING_MPS;
const HOLD_FOR = Object.freeze({ away: "tap_away_from_stop", unverified: "tap_unverified", not_mapped: "stop_not_mapped" });

// Clean RouteMate rows only: never Linxup, untagged ('') or dropped rows. Both
// reads use server.js's (vehicle, time) index.
const PING_SQL = `SELECT location_date_ms AS ms, latitude AS lat, longitude AS lng, speed, source, dropped_reason
	FROM routemate_telemetry
	WHERE routemate_vehicle_id = ? AND location_date_ms >= ? AND location_date_ms <= ?
	  AND source = 'routemate' AND dropped_reason = ''
	ORDER BY location_date_ms ASC`;
const LATEST_PING_SQL = `SELECT MAX(location_date_ms) AS ms FROM routemate_telemetry
	WHERE routemate_vehicle_id = ? AND source = 'routemate' AND dropped_reason = ''`;

// server.js's resolveGeofencePoints(), with the stored load_coordinates row
// handed in instead of read (null when the load has no id). A runner lifts the
// server's copy and compares the two on fixtures.
function stopPoints(loadData, headers, coordsRow) {
	const data = loadData || {};
	const hs = Array.isArray(headers) ? headers : [];
	const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
	const col = (re) => hs.find((h) => re.test(h));

	const oLatCol = col(/origin.*lat|pickup.*lat|shipper.*lat/i);
	const oLngCol = col(/origin.*l(on|ng)|pickup.*l(on|ng)|shipper.*l(on|ng)/i);
	const dLatCol = col(/dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i);
	const dLngCol = col(/dest.*l(on|ng)|drop.*l(on|ng)|receiver.*l(on|ng)|delivery.*l(on|ng)/i);

	let oLat = oLatCol ? num(data[oLatCol]) : null;
	let oLng = oLngCol ? num(data[oLngCol]) : null;
	let dLat = dLatCol ? num(data[dLatCol]) : null;
	let dLng = dLngCol ? num(data[dLngCol]) : null;

	if ((oLat === null || oLng === null || dLat === null || dLng === null) && coordsRow) {
		if (oLat === null || oLng === null) { oLat = num(coordsRow.origin_lat); oLng = num(coordsRow.origin_lng); }
		if (dLat === null || dLng === null) { dLat = num(coordsRow.dest_lat); dLng = num(coordsRow.dest_lng); }
	}

	return {
		origin: (oLat !== null && oLng !== null) ? { latitude: oLat, longitude: oLng } : null,
		dest: (dLat !== null && dLng !== null) ? { latitude: dLat, longitude: dLng } : null,
	};
}

// Pickup 1 is checked at the mapped pickup point; a drop arrival and delivered
// at the mapped drop-off point (the last stop). No other stop has a point.
function stopPointFor(ev, points) {
	if (!points || !ev || !ev.stop) return null;
	if (ev.event === "arrived_pickup" || ev.event === "departed_pickup") {
		return ev.stop.kind === "pickup" && Number(ev.stop.index) === 1 ? points.origin || null : null;
	}
	if (ev.event === "arrived_delivery" || ev.event === "delivered") return ev.stop.kind === "delivery" ? points.dest || null : null;
	return null;
}

// The pings an event's test reads: { fromMs, toMs }, or null for an event v1
// never sends.
function windowFor(event, ms) {
	if (!Number.isFinite(ms)) return null;
	switch (event) {
		case "arrived_pickup":
		case "arrived_delivery":
			return { fromMs: ms, toMs: ms + ARRIVE_WINDOW_MS };
		case "delivered":
			return { fromMs: ms - DELIVERED_WINDOW_MS, toMs: ms + DELIVERED_WINDOW_MS };
		case "departed_pickup":
			return { fromMs: ms - DEPART_BEFORE_MS, toMs: ms + DEPART_AFTER_MS };
		default:
			return null;
	}
}

function isCleanPing(p) {
	return Boolean(p) && p.source === "routemate" && p.dropped_reason === ""
		&& Number.isFinite(p.ms) && Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0);
}

const positionOf = (p) => ({ ms: p.ms, lat: p.lat, lng: p.lng });

// { verify, ping }: confirmed (with the ping that proved it), away (pings in the
// window, none at the stop), unverified (no truck, device or clean ping in the
// window), not_mapped (no point for the stop), or waiting (NL3: the window is
// still open).
//   arrival:   a ping inside the radius at or after the event, within 15 minutes
//   delivered: a ping inside the radius within 15 minutes either side
//   departure: a ping inside the pickup radius in the 15 minutes before, and a
//              moving ping outside it in the 30 minutes after; the position is
//              the inside ping's, at the facility
function verifyMilestone({ event, eventMs, point, radiusM, device, pings, latestPingMs, nowMs }) {
	const none = (verify) => ({ verify, ping: null });
	if (!Number.isFinite(eventMs)) return none("unverified");
	const win = windowFor(event, eventMs);
	if (!win || !point) return none("not_mapped");
	if (!device) return none("unverified");
	const radius = Number(radiusM) > 0 ? Number(radiusM) : tripWorkDays.DEFAULT_GEOFENCE_RADIUS_M;
	const clean = (Array.isArray(pings) ? pings : []).filter(isCleanPing);
	const inside = (p) => geolib.isPointWithinRadius({ latitude: p.lat, longitude: p.lng }, point, radius);
	const closed = (Number.isFinite(latestPingMs) && latestPingMs > win.toMs) || (Number.isFinite(nowMs) && nowMs > win.toMs + GRACE_MS);

	if (event === "departed_pickup") {
		const before = clean.filter((p) => p.ms >= win.fromMs && p.ms <= eventMs);
		const atStop = before.filter(inside);
		const last = atStop.length ? atStop[atStop.length - 1] : null;
		const moved = clean.some((p) => p.ms > eventMs && p.ms <= win.toMs && Number(p.speed) > DEPART_SPEED_MPS && !inside(p));
		if (last && moved) return { verify: "confirmed", ping: positionOf(last) };
		if (!closed) return none("waiting");
		if (!last) return none(before.length ? "away" : "unverified");
		return none("unverified");
	}

	const inWindow = clean.filter((p) => p.ms >= win.fromMs && p.ms <= win.toMs);
	const atStop = inWindow.filter(inside);
	if (atStop.length) {
		const best = event === "delivered"
			? atStop.reduce((a, b) => (Math.abs(b.ms - eventMs) < Math.abs(a.ms - eventMs) ? b : a))
			: atStop[0];
		return { verify: "confirmed", ping: positionOf(best) };
	}
	if (!closed) return none("waiting");
	return none(inWindow.length ? "away" : "unverified");
}

module.exports = {
	ARRIVE_WINDOW_MS,
	DELIVERED_WINDOW_MS,
	DEPART_BEFORE_MS,
	DEPART_AFTER_MS,
	GRACE_MS,
	DEPART_SPEED_MPS,
	HOLD_FOR,
	PING_SQL,
	LATEST_PING_SQL,
	stopPoints,
	stopPointFor,
	windowFor,
	isCleanPing,
	verifyMilestone,
};
