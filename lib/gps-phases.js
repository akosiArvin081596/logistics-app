"use strict";
// The driver stepper's GPS phases (DRIVER_STEPPER_GPS_PHASES_ENABLED, read in
// server.js). With it on, each active load in the driver app's payload
// (GET /api/driver/:driverName) carries `_gpsPhases` { pickup, drop }: can the
// geofence mark that stop's phases on its own right now?
//
//   pickup  the load has a mapped pickup point, and its truck's newest clean fix
//           was taken since the device was linked and at most 30 minutes ago;
//   drop    the same, with the mapped drop-off point.
//
// The geofence writes "At Shipper" and the departure "In Transit" at the pickup
// point and "At Receiver" at the drop-off point, so the app shows "GPS marks
// this" and a "Mark it myself" link on those three steps when the matching
// answer is true (client/src/lib/gpsPhases.js), and today's button otherwise.
//
// Nothing here writes, geocodes or calls out: the points are the geofence's
// own stored ones (resolveGeofencePoints(), never ensureLoadCoordinates()),
// the truck is the one the arrival recorder finds, and a lookup that fails
// reads as false, which leaves the driver today's button. Off, rows go back
// as they came, with no key and no lookup.

const eldPosition = require("./eld-position");
const arrivalRecorder = require("./arrival-recorder");

// A reviewed constant, never a setting: a truck silent for longer than this
// may have lost its feed, and then the geofence can't fire.
const FIX_MAX_AGE_MS = 30 * 60 * 1000;
// The statuses the geofence evaluates (server.js geofenceCandidatesAcrossSpacing()'s
// list); only these loads get the key.
const ACTIVE_RE = /^(assigned|dispatched|heading to shipper|at shipper|loading|in transit|at receiver|unloading)$/i;
// The truck's newest clean fix at or before the read, by the fix's own time
// (idx_rm_tel_vid_date), so a fix stamped ahead of the clock never counts.
const NEWEST_FIX_SQL = `SELECT latitude, longitude, location_date_ms FROM routemate_telemetry
	WHERE routemate_vehicle_id = ? AND dropped_reason = '' AND latitude IS NOT NULL AND longitude IS NOT NULL
	  AND location_date_ms <= ?
	ORDER BY location_date_ms DESC, id DESC LIMIT 1`;

const text = (v) => (v === null || v === undefined ? "" : String(v));
const NONE = Object.freeze({ pickup: false, drop: false });

// One lookup: a failure is logged once per call and reads as "not found".
function attempt(log, what, fn) {
	try {
		return fn();
	} catch (err) {
		log.error(`[gps-phases] the ${what} lookup failed: ${err && err.message}`);
		return null;
	}
}

// Did the truck report a placeable fix, since its device's link, in the last
// FIX_MAX_AGE_MS? An unknown link time keeps the fix (lib/eld-position.js).
function reporting(r, truck, nowMs) {
	if (!truck || !truck.vid || !Number.isFinite(nowMs)) return false;
	const row = r.db.prepare(NEWEST_FIX_SQL).get(truck.vid, nowMs);
	if (!row || !arrivalRecorder.place(row)) return false;
	const ms = Number(row.location_date_ms);
	if (!Number.isFinite(ms)) return false;
	if (eldPosition.fixPredatesLink(ms, r.linkedSinceMs(truck.id, truck.vid))) return false;
	// Never negative: the query takes no fix stamped after nowMs.
	const age = nowMs - ms;
	return age <= FIX_MAX_AGE_MS;
}

// `readers` returns server.js's gpsPhasesReaders(): the arrival recorder's
// (db, truckColRe, truckByUnit, truckForDriver, linkedSinceMs) plus
// points(headers, row, loadId) -> { origin, dest }.
function create({ enabled = false, readers, now = () => Date.now(), log = console } = {}) {
	const on = enabled === true;

	// One load's answer. `answered` holds each truck's answer for this call.
	function phasesOf(r, headers, row, cols, nowMs, answered) {
		const cells = headers.map((h) => row[h]);
		const loadId = cols.id ? text(row[cols.id]).trim() : "";
		const points = attempt(log, "points", () => r.points(headers, cells, loadId)) || {};
		const pickupMapped = !!arrivalRecorder.place(points.origin);
		const dropMapped = !!arrivalRecorder.place(points.dest);
		if (!pickupMapped && !dropMapped) return { ...NONE };
		const truck = attempt(log, "truck", () => arrivalRecorder.truckOf(r, headers, cells));
		if (!truck) return { ...NONE };
		const key = `${truck.id}|${truck.vid}`;
		if (!answered.has(key)) answered.set(key, attempt(log, "fix", () => reporting(r, truck, nowMs)) === true);
		const live = answered.get(key);
		return { pickup: pickupMapped && live, drop: dropMapped && live };
	}

	// New row objects for the active loads (the rows handed in are never
	// written); `sourceRows` are the same loads as stored, index for index (the
	// Load ID, Driver and Truck cells before any role's view strips one).
	function annotate(rows, sourceRows, headers) {
		if (!on || !Array.isArray(rows) || !rows.length) return rows;
		const hs = Array.isArray(headers) ? headers.map(text) : [];
		const statusCol = hs.find((h) => /^(job[\s._-]?)?status$/i.test(h.trim())) || hs.find((h) => /status/i.test(h));
		const cols = { id: hs.find((h) => /load.?id|job.?id/i.test(h)) || null };
		if (!statusCol) return rows;
		const r = attempt(log, "readers", () => readers());
		if (!r) return rows;
		const nowMs = Number(now());
		const answered = new Map();
		return rows.map((row, i) => {
			const src = Array.isArray(sourceRows) && sourceRows[i] && typeof sourceRows[i] === "object" ? sourceRows[i] : row;
			if (!src || !ACTIVE_RE.test(text(src[statusCol]).trim())) return row;
			return { ...row, _gpsPhases: phasesOf(r, hs, src, cols, nowMs, answered) };
		});
	}

	return { enabled: on, annotate };
}

module.exports = { FIX_MAX_AGE_MS, ACTIVE_RE, create };
