"use strict";
// The arrival recorder (ARRIVAL_PICKUP_RECORDER_ENABLED, read in server.js):
// with it on, a load_status_history row records who set the status, and an
// "At Shipper" row also where the truck was and the shipper's zone. The facts
// are decided once, at the write, with the radius, coordinates and zone banding
// in force then; nothing here recomputes or pays from them.
//
//   actor_role          the session's role on a route; "system" for the geofence
//   fix_ms              "At Shipper": the position's time (the ping's own for the
//   pickup_distance_m   geofence), metres to the mapped pickup point, and "inside"
//   pickup_zone         the geofence radius or "outside" it; all three empty when
//                       the position is unknown (no truck, no fresh fix, no point)
//   local_tz            "At Shipper": the shipper's zone (see shipperZone())
//   other_load_hauling  a geofence "At Shipper": was another load under way?
//
// No lookup runs with the recorder off, and a failed one leaves its own facts
// empty: it never fails the write.

const geolib = require("geolib");
const eldPosition = require("./eld-position");
const { usTzForLongitude } = require("./eld-miles");

// A tap's position counts only from a fix at most this old: a reviewed
// constant, never a setting.
const FIX_MAX_AGE_MS = 5 * 60 * 1000;
const ROUTE_ROLES = Object.freeze(["Super Admin", "Dispatcher", "Driver"]);
const SYSTEM_ROLE = "system";
// Another load is under way from the drive to its shipper until its arrival at
// the receiver: an "At Receiver" load usually waits only for its Delivered tap.
const UNDER_WAY_RE = /^(heading to shipper|at shipper|loading|in transit)$/i;
// The zone names APP_TIMEZONE takes (lib/app-time.js), so a stored zone is one
// Intl reads back.
const ZONE_RE = /^(?:UTC|[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)+)$/;
// The newest clean fix at or before the write, by the fix's own time
// (idx_rm_tel_vid_date), so a late push can't stand in for a newer fix.
const NEWEST_FIX_SQL = `SELECT latitude, longitude, location_date_ms FROM routemate_telemetry
	WHERE routemate_vehicle_id = ? AND dropped_reason = '' AND latitude IS NOT NULL AND longitude IS NOT NULL
	  AND location_date_ms <= ?
	ORDER BY location_date_ms DESC, id DESC LIMIT 1`;

const text = (v) => (v === null || v === undefined ? "" : String(v));
const isAtShipper = (status) => /^at shipper$/i.test(text(status).trim());
// normLoadKey()'s rule in server.js: trim, lower-case, one leading "#" dropped.
const loadKey = (id) => text(id).trim().toLowerCase().replace(/^#/, "");
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

// A place, or null. (0, 0) is a failed geocode or a lost satellite fix.
function place(p) {
	if (!p || typeof p !== "object") return null;
	const latitude = num(p.latitude);
	const longitude = num(p.longitude);
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (latitude === 0 && longitude === 0)) return null;
	return { latitude, longitude };
}

// One lookup, best-effort: a failure is logged and read as "not found".
function attempt(what, fn) {
	try {
		return fn();
	} catch (err) {
		console.error(`[arrival-recorder] the ${what} lookup failed: ${err && err.message}`);
		return null;
	}
}

// The six recorder columns of one history row, in DDL order. A value of any
// other shape is stored as the column's default, so no caller can widen them.
function historyColumns(facts) {
	const f = facts && typeof facts === "object" ? facts : {};
	const fixMs = finite(f.fixMs);
	const distance = finite(f.pickupDistanceM);
	return [
		ROUTE_ROLES.includes(f.actorRole) || f.actorRole === SYSTEM_ROLE ? f.actorRole : "",
		fixMs !== null && fixMs > 0 ? Math.round(fixMs) : null,
		distance !== null && distance >= 0 ? distance : null,
		f.pickupZone === "inside" || f.pickupZone === "outside" ? f.pickupZone : "",
		typeof f.localTz === "string" && ZONE_RE.test(f.localTz) ? f.localTz : "",
		f.otherLoadHauling === 0 || f.otherLoadHauling === 1 ? f.otherLoadHauling : null,
	];
}

// The shipper's zone, banded as the ELD's travel days band a truck's
// longitude: the mapped pickup point's, else the known position's, else the
// app zone usTzForLongitude() falls back to.
function shipperZone(pickup, position) {
	const p = place(pickup) || place(position);
	return usTzForLongitude(p ? p.longitude : undefined);
}

// 1 when another of the loads the geofence asked at this ping was under way,
// else 0; null without that list. Loads compare by their stored key.
function otherLoadHauling(candidates, loadId) {
	if (!Array.isArray(candidates)) return null;
	const self = loadKey(loadId);
	return candidates.some((c) => c && loadKey(c.loadId) !== self && UNDER_WAY_RE.test(text(c.status).trim())) ? 1 : 0;
}

// A geofence row's facts: "system"; on "At Shipper" also the ping's own time,
// the distance the geofence measured, "inside" (it fired there), the zone and
// whether another load was under way. {} with the recorder off.
function geofenceFacts({ enabled, trigger, loadId, fixMs, latitude, longitude, distanceM, pickup, candidates } = {}) {
	if (!enabled) return {};
	if (!isAtShipper(trigger)) return { actorRole: SYSTEM_ROLE };
	return attempt("geofence facts", () => ({
		actorRole: SYSTEM_ROLE,
		fixMs,
		pickupDistanceM: distanceM,
		pickupZone: "inside",
		localTz: shipperZone(pickup, { latitude, longitude }),
		otherLoadHauling: otherLoadHauling(candidates, loadId),
	})) || { actorRole: SYSTEM_ROLE };
}

const truckRef = (t) => (t ? { id: t.id, vid: text(t.vid !== undefined ? t.vid : t.routemate_vehicle_id).trim() } : null);

// The load's truck: its Truck cell's unit, else the truck the money stamps give
// the row's driver (with the active assignment), as the geofence finds one.
function truckOf(r, headers, row) {
	const hs = Array.isArray(headers) ? headers.map((h) => text(h)) : [];
	const cells = Array.isArray(row) ? row : [];
	const cell = (i) => (i === -1 ? "" : text(cells[i]).trim());
	const unit = cell(hs.findIndex((h) => r.truckColRe.test(h)));
	const byUnit = unit ? truckRef(r.truckByUnit(unit)) : null;
	if (byUnit) return byUnit;
	const exact = hs.findIndex((h) => /^driver$/i.test(h.trim()));
	const driver = cell(exact !== -1 ? exact : hs.findIndex((h) => /driver/i.test(h)));
	return driver ? truckRef(r.truckForDriver(driver)) : null;
}

// The truck's newest clean fix at or before the write, taken since its device
// was linked (lib/eld-position.js) and at most FIX_MAX_AGE_MS old; else null.
function freshFix(r, truck, nowMs) {
	if (!truck.vid || !Number.isFinite(nowMs)) return null;
	const row = r.db.prepare(NEWEST_FIX_SQL).get(truck.vid, nowMs);
	const at = place(row);
	const ms = row ? num(row.location_date_ms) : NaN;
	if (!at || !Number.isFinite(ms)) return null;
	if (eldPosition.fixPredatesLink(ms, r.linkedSinceMs(truck.id, truck.vid))) return null;
	const age = nowMs - ms;
	return age >= 0 && age <= FIX_MAX_AGE_MS ? { ms, ...at } : null;
}

// A route's "At Shipper" (a tap or an override): the truck's position at the
// write and the shipper's zone. {} with the recorder off or any other status,
// so nothing is looked up then. `readers` returns server.js's readers.
function positionFacts({ enabled, newStatus, loadId, headers, row, readers } = {}) {
	if (!enabled || !isAtShipper(newStatus)) return {};
	const r = attempt("readers", () => readers()) || {};
	const nowMs = typeof r.now === "function" ? r.now() : Date.now();
	const truck = attempt("truck", () => truckOf(r, headers, row));
	const fix = truck ? attempt("fix", () => freshFix(r, truck, nowMs)) : null;
	const pickup = place(attempt("pickup point", () => r.pickupPoint(headers, row, loadId)));
	const facts = { localTz: shipperZone(pickup, fix) };
	if (!fix || !pickup || !(r.radiusM > 0)) return facts;
	const measured = attempt("distance", () => {
		const here = { latitude: fix.latitude, longitude: fix.longitude };
		return {
			pickupDistanceM: geolib.getDistance(here, pickup),
			pickupZone: geolib.isPointWithinRadius(here, pickup, r.radiusM) ? "inside" : "outside",
		};
	});
	return measured ? { ...facts, fixMs: fix.ms, ...measured } : facts;
}

module.exports = {
	FIX_MAX_AGE_MS,
	ROUTE_ROLES,
	SYSTEM_ROLE,
	isAtShipper,
	historyColumns,
	shipperZone,
	otherLoadHauling,
	geofenceFacts,
	positionFacts,
};
