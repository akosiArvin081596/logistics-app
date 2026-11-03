"use strict";
// Has the truck reached this load's shipper? The fuel trip plan's "picked up"
// (GET /api/fuel/trip-plan). A load can be marked In Transit before the truck gets
// there, and a plan that then drops the run to the shipper understates the miles
// ahead, so the sheet's status alone never counts. A load the status calls picked
// up is picked up for the plan only once, in its current run, the ELD or the
// geofence has put the truck at the shipper:
//   - the geofence wrote "At Shipper" for it, unless the arrival recorder marked
//     that row as written while another of the driver's loads was under way;
//   - or a status set to "At Shipper" carries the recorder's ELD fix inside the
//     pickup zone (pickup_zone "inside"). A tap with no such fix does not count;
//   - or the truck's own fixes pass the live geofence's arrival test: a fix inside
//     the radius at arrival speed whose previous fix was inside too. The visit of
//     a recorder-marked arrival made while another load was under way is that
//     load's errand, so the test starts once the truck has left the zone after it.
// The run starts at the load's latest Dispatched row after its last Cancelled one,
// else at its first row after it. With no run, no device, no mapped pickup or a
// read that fails, the answer is "not yet": the plan keeps the run to the shipper,
// which overstates the miles ahead rather than understating them.

const geolib = require("geolib");

// The columns the decision reads; load_id is stored lower-case with a leading "#" removed.
const HISTORY_SQL = `SELECT id, new_status, source, pickup_zone, other_load_hauling, fix_ms, changed_at
	FROM load_status_history WHERE load_id = ? ORDER BY changed_at, id`;
// The truck's clean fixes in a window, oldest first (idx_rm_tel_vid_date).
const FIXES_SQL = `SELECT location_date_ms AS ms, latitude, longitude, speed FROM routemate_telemetry
	WHERE routemate_vehicle_id = ? AND location_date_ms >= ? AND location_date_ms <= ?
	  AND dropped_reason = '' AND latitude IS NOT NULL AND longitude IS NOT NULL
	ORDER BY location_date_ms ASC, id ASC`;

const text = (v) => (v === null || v === undefined ? "" : String(v));
const statusOf = (v) => text(v).trim().toLowerCase().replace(/\s+/g, " ");
const historyKey = (loadId) => text(loadId).trim().toLowerCase().replace(/^#/, "");
// changed_at is SQLite's UTC "YYYY-MM-DD HH:MM:SS", with no zone marker.
const stampMs = (v) => Date.parse(text(v).trim().replace(" ", "T") + "Z");
const finite = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

function place(p) {
	if (!p || typeof p !== "object") return null;
	const latitude = finite(p.latitude);
	const longitude = finite(p.longitude);
	// (0, 0) is a failed geocode or a lost satellite fix.
	if (latitude === null || longitude === null || (latitude === 0 && longitude === 0)) return null;
	return { latitude, longitude };
}

// The current run's rows of one load's history (HISTORY_SQL's columns, oldest
// first) and its start in epoch ms, or null when it has none.
function currentRun(rows) {
	const all = (Array.isArray(rows) ? rows : []).filter((r) => r && statusOf(r.new_status) && Number.isFinite(stampMs(r.changed_at)));
	let from = 0;
	all.forEach((r, k) => { if (/^cancell?ed$/.test(statusOf(r.new_status))) from = k + 1; });
	for (let k = all.length - 1; k >= from; k--) {
		if (statusOf(all[k].new_status) === "dispatched") { from = k; break; }
	}
	const run = all.slice(from);
	return run.length ? { rows: run, startMs: stampMs(run[0].changed_at) } : null;
}

// What the run's own rows say: `by` "geofence" or "recorded_fix" when one of them
// puts the truck at the shipper (else null), and `holdMs`, the latest
// recorder-marked arrival made while another load was under way (the later of
// its fix time and its row time), or null.
function historyArrival(runRows) {
	let by = null;
	let holdMs = null;
	for (const r of Array.isArray(runRows) ? runRows : []) {
		if (statusOf(r.new_status) !== "at shipper") continue;
		if (statusOf(r.source) === "geofence") {
			if (Number(r.other_load_hauling) === 1) {
				const fixMs = finite(r.fix_ms);
				const moment = Math.max(stampMs(r.changed_at), fixMs !== null && fixMs > 0 ? fixMs : -Infinity);
				holdMs = holdMs === null ? moment : Math.max(holdMs, moment);
			} else {
				by = "geofence";
			}
		} else if (statusOf(r.pickup_zone) === "inside" && !by) {
			by = "recorded_fix";
		}
	}
	return { by, holdMs };
}

// The first fix (oldest first) that passes the live geofence's arrival test at
// `pickup`: inside `radiusM`, no faster than `maxSpeedMps` (a fix with no speed
// passes, as it does live), and the fix before it inside too. Its time, or null.
// With `holdMs`, the visit that arrival belongs to is another load's errand: fixes
// up to it, and after it until the truck is next outside the zone, never count.
function eldArrivalMs(fixes, { pickup, radiusM, maxSpeedMps, holdMs = null } = {}) {
	const at = place(pickup);
	if (!at || !(radiusM > 0)) return null;
	const hold = finite(holdMs);
	let held = hold !== null;
	let prevInside = false;
	for (const f of Array.isArray(fixes) ? fixes : []) {
		const here = place(f);
		if (!here) continue;
		const inside = geolib.isPointWithinRadius(here, at, radiusM);
		if (held) {
			if (!inside && finite(f.ms) > hold) held = false;
			continue;
		}
		if (inside && prevInside && !(Number(f.speed) > maxSpeedMps)) return finite(f.ms);
		prevInside = inside;
	}
	return null;
}

// The arrival for one load and truck: { by: "geofence" | "recorded_fix" | "eld" }
// (the first that answers), or null. `linkedSinceMs` is when the device was linked
// to this truck (null when unknown); fixes before it belong to another vehicle
// (lib/eld-position.js), so the ELD test starts there at the earliest.
function shipperArrival({ db, loadId, vehicleId, pickup, linkedSinceMs = null, radiusM, maxSpeedMps, nowMs } = {}) {
	try {
		const key = historyKey(loadId);
		if (!db || !key) return null;
		const run = currentRun(db.prepare(HISTORY_SQL).all(key));
		if (!run) return null;
		const seen = historyArrival(run.rows);
		if (seen.by) return { by: seen.by };
		const vid = text(vehicleId).trim();
		if (!vid || !place(pickup)) return null;
		const now = finite(nowMs) !== null ? finite(nowMs) : Date.now();
		const link = finite(linkedSinceMs);
		const since = Math.max(run.startMs, link !== null ? link : -Infinity);
		const fixes = db.prepare(FIXES_SQL).all(vid, since, now);
		return eldArrivalMs(fixes, { pickup, radiusM, maxSpeedMps, holdMs: seen.holdMs }) !== null ? { by: "eld" } : null;
	} catch (err) {
		console.error("[fuel/trip-plan] the shipper arrival could not be read:", err && err.message);
		return null;
	}
}

module.exports = {
	currentRun,
	historyArrival,
	eldArrivalMs,
	shipperArrival,
};
