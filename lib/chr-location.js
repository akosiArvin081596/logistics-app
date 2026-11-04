"use strict";
// Location along the route for a C.H. Robinson load (addendum R3.5): which fix
// of the truck's ELD stands for each 15-minute bucket of the load's time in
// transit, and the only shape such an update may take. Never the driver's
// phone: the source is the truck's clean RouteMate fixes, from the device that
// was on the load's truck at the fix's own time.
//
// The window opens at the confirmed departure from pickup 1 and closes, failing
// closed, at the first of: any final event recorded (confirmed or held), a
// status at or past "At Receiver", a hold or a multi-stop signal on the load,
// the load no longer CHR's, or 72 hours after the departure.
//
// Pure: the caller hands in the rows, the fixes, the resolvers and the clock.

const E = require("./chr-events");

const MIN_MS = 60 * 1000;
// A fix older than this when the row is made gives the bucket no row.
const FRESH_MS = 20 * MIN_MS;
// A window that never closed by itself stops here.
const WINDOW_CAP_MS = 72 * 60 * MIN_MS;
const LOCATION_PAYLOAD_KEYS = Object.freeze(["loadNumber", "event", "eventAt", "position"]);
// Statuses at or past the arrival at a delivery: the window is over.
const PAST_TRANSIT_RE = /^(at receiver|delivered|completed|pod received)$/i;
const FINAL_EVENTS = Object.freeze(["arrived_delivery", "delivered"]);
// Named columns only, clean RouteMate rows only; never the geocoded address.
const FIX_SQL = `SELECT location_date_ms AS ms, latitude AS lat, longitude AS lng, source, dropped_reason
	FROM routemate_telemetry
	WHERE routemate_vehicle_id = ? AND location_date_ms >= ? AND location_date_ms < ?
	  AND source = 'routemate' AND dropped_reason = ''
	ORDER BY location_date_ms DESC LIMIT 50`;
// The statuses recorded after the departure's own row, and which route wrote
// each: named columns, never the actor or the reason.
const STATUS_AFTER_SQL = "SELECT new_status, source FROM load_status_history WHERE load_id = ? AND id > ? ORDER BY id ASC";
// Rows these routes write re-dispatch the load: its trip starts over.
const REDISPATCH_SOURCES = Object.freeze(["dispatch", "accept", "decline"]);
const statusText = (s) => String(s == null ? "" : s).slice(0, 64).trim().replace(/\s{1,64}/g, " ");

// The bucket an instant falls in, aligned to the epoch: [start, start + size).
function bucketOf(ms, intervalMin) {
	const size = Math.max(15, Number(intervalMin) || 15) * MIN_MS;
	const start = Math.floor(ms / size) * size;
	return { startMs: start, endMs: start + size };
}

// The last bucket that has ended by nowMs.
function lastClosedBucket(nowMs, intervalMin) {
	const cur = bucketOf(nowMs, intervalMin);
	const size = cur.endMs - cur.startMs;
	return { startMs: cur.startMs - size, endMs: cur.startMs };
}

// { open, startMs, endMs, why } for one load. departure: the confirmed
// departure from pickup 1 ({ atMs }) or null; finals: how many final events the
// load has recorded (any status but voided); statuses: its status-history
// statuses; blocked: a hold, a multi-stop signal, or the load failing the
// CHR-load test. Once the load has reached a delivery by any sign, no row is
// made at all, not even for a fix from before it.
// redispatched: a dispatch, accept or decline row after the departure.
// sameTruck: the load's current driver's truck is the one whose departure was
// confirmed (false after the load is handed to another driver mid-route).
function windowFor({ departure = null, finals = 0, statuses = [], blocked = false, redispatched = false, sameTruck = true }) {
	const closed = (why) => ({ open: false, startMs: null, endMs: null, why });
	if (!departure || !Number.isFinite(departure.atMs)) return closed("no_departure");
	if (blocked) return closed("blocked");
	if (sameTruck !== true) return closed("other_truck");
	if (redispatched) return closed("redispatched");
	if (finals > 0) return closed("final_event");
	if (statuses.some((s) => PAST_TRANSIT_RE.test(statusText(s)))) return closed("past_transit");
	return { open: true, startMs: departure.atMs, endMs: departure.atMs + WINDOW_CAP_MS, why: "" };
}

function isCleanFix(f) {
	return Boolean(f) && f.source === "routemate" && f.dropped_reason === "" && Number.isFinite(f.ms) && Number.isFinite(f.lat) && Number.isFinite(f.lng)
		&& !(f.lat === 0 && f.lng === 0) && Math.abs(f.lat) <= 90 && Math.abs(f.lng) <= 180;
}

// The fix for one bucket: the newest clean fix inside the bucket and the
// window, taken by the device that was on the load's truck at the fix's own
// time (so never a fix from before that device's link, nor from another truck
// after a change), and at most 20 minutes old now. null: the bucket gets no row.
function pickFix(fixes, { bucket, window, nowMs, device, truckAt, deviceAt }) {
	const from = Math.max(bucket.startMs, window.startMs);
	const to = Math.min(bucket.endMs, window.endMs);
	if (!(from < to)) return null;
	const candidates = (Array.isArray(fixes) ? fixes : []).filter((f) => isCleanFix(f) && f.ms >= from && f.ms < to).sort((a, b) => b.ms - a.ms);
	for (const f of candidates) {
		if (nowMs - f.ms > FRESH_MS) return null;
		const truck = truckAt(f.ms);
		if (!truck || String(deviceAt(truck.truck_id, f.ms) || "") !== String(device)) continue;
		return { ms: f.ms, lat: f.lat, lng: f.lng };
	}
	return null;
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;

// The one builder of a location update: the load number, the event, the fix's
// own time and the position to 4 decimals (about 11 m). Nothing else, ever: no
// driver, truck, device, speed, heading or address.
function buildLocationPayload({ loadId, fix, redactor = null }) {
	const loadNumber = E.loadNumberOf(loadId);
	if (!/^\d{9}$/.test(loadNumber) || (redactor && redactor.hits(loadNumber))) return null;
	if (!isCleanFix({ ...fix, source: "routemate", dropped_reason: "" })) return null;
	return { loadNumber, event: "location", eventAt: new Date(fix.ms).toISOString().replace(/\.\d{3}Z$/, "Z"), position: { lat: round4(fix.lat), lng: round4(fix.lng) } };
}

function locationKey(loadKey, bucketStartMs) {
	return `loc|${loadKey}|${new Date(bucketStartMs).toISOString()}`;
}

module.exports = {
	FRESH_MS,
	WINDOW_CAP_MS,
	LOCATION_PAYLOAD_KEYS,
	FINAL_EVENTS,
	FIX_SQL,
	STATUS_AFTER_SQL,
	REDISPATCH_SOURCES,
	bucketOf,
	lastClosedBucket,
	windowFor,
	isCleanFix,
	pickFix,
	buildLocationPayload,
	locationKey,
};
