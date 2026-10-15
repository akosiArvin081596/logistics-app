"use strict";
// WHAT THE R10 MILE METRICS READ FROM SQLITE, and the per-load records
// lib/kpi-metrics.js takes as inputs.milesLoads.
//
//   gatherMilesData(db)                 -> { eld, coords, lane, stated, routes, truckIdByUnit }
//   assembleMilesLoads(sheetLoads, data) -> milesLoads (one per sheet load with a Load ID)
//
// Sources, by table (named columns only):
//   load_eld_miles          the ELD truck and the pickup / receiver arrival
//                           instants (0 is the column's "not observed")
//   load_coordinates        both ends' coordinates (never the addresses); some
//                           rows carry a leading '#' in load_id, so keys are
//                           normalised the way normLoadKey() does
//   load_ratecon_miles      Google's lane miles rate-con ingestion stored
//   kpi_load_ratecon_miles  the miles the rate con states (lib/kpi-ratecon-pass.js)
//   kpi_deadhead_routes     the cached route distances (lib/kpi-deadhead-routes.js)
//   trucks                  unit number -> truck id, for the Truck column
//
// The sheet loads come from server.js kpiSheetLoads() over liveJobTrackingView()
// (cancelled and soft-deleted loads already gone), each with its Pickup,
// Drop-off and Completion cells. Keys stay on the server: lib/kpi-metrics.js
// only ever outputs sums.
//
// Takes the database handle as an argument; reads only. Requires
// lib/kpi-deadhead-routes.js (readRoutes()).

const { readRoutes } = require("./kpi-deadhead-routes");

const key = (id) => String(id == null ? "" : id).trim().toLowerCase().replace(/^#/, "");
const finite = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const positive = (v) => (finite(v) != null && Number(v) > 0 ? Number(v) : null);

function gatherMilesData(db) {
	const eld = new Map();
	for (const r of db.prepare("SELECT load_id, truck_id, pickup_arrive_ms, dest_arrive_ms FROM load_eld_miles").all()) {
		const k = key(r.load_id);
		if (!k) continue;
		const truck = finite(r.truck_id);
		eld.set(k, {
			truckId: truck != null && truck > 0 ? String(truck) : "",
			pickupArriveMs: positive(r.pickup_arrive_ms),
			destArriveMs: positive(r.dest_arrive_ms),
		});
	}
	const coords = new Map();
	for (const r of db.prepare("SELECT load_id, origin_lat, origin_lng, dest_lat, dest_lng FROM load_coordinates").all()) {
		const k = key(r.load_id);
		if (!k || coords.has(k)) continue;
		coords.set(k, { originLat: finite(r.origin_lat), originLng: finite(r.origin_lng), destLat: finite(r.dest_lat), destLng: finite(r.dest_lng) });
	}
	const lane = new Map();
	for (const r of db.prepare("SELECT load_id, miles FROM load_ratecon_miles").all()) {
		const k = key(r.load_id);
		const miles = finite(r.miles);
		if (k && miles != null && miles > 0) lane.set(k, miles);
	}
	const stated = new Map();
	for (const r of db.prepare("SELECT load_id, status, loaded_miles, empty_miles FROM kpi_load_ratecon_miles").all()) {
		const k = key(r.load_id);
		if (k) stated.set(k, { status: String(r.status || ""), loadedMiles: finite(r.loaded_miles), emptyMiles: finite(r.empty_miles) });
	}
	const truckIdByUnit = new Map();
	for (const r of db.prepare("SELECT id, unit_number FROM trucks").all()) {
		const unit = String(r.unit_number == null ? "" : r.unit_number).trim().toLowerCase();
		if (unit && !truckIdByUnit.has(unit)) truckIdByUnit.set(unit, String(r.id));
	}
	return { eld, coords, lane, stated, routes: readRoutes(db), truckIdByUnit };
}

function assembleMilesLoads(sheetLoads, data) {
	const out = [];
	for (const l of Array.isArray(sheetLoads) ? sheetLoads : []) {
		const k = key(l && l.loadId);
		if (!k) continue;
		const e = data.eld.get(k) || null;
		const c = data.coords.get(k) || {};
		const s = data.stated.get(k) || null;
		out.push({
			key: k,
			status: String(l.status || ""),
			day: l.day || null,
			driverKey: String(l.driverKey || ""),
			truckKey: String(l.truckKey || ""),
			pickupText: String(l.pickupText || ""),
			dropoffText: String(l.dropoffText || ""),
			completionText: String(l.completionText || ""),
			eldTruckId: e ? e.truckId : "",
			pickupArriveMs: e ? e.pickupArriveMs : null,
			destArriveMs: e ? e.destArriveMs : null,
			originLat: c.originLat == null ? null : c.originLat,
			originLng: c.originLng == null ? null : c.originLng,
			destLat: c.destLat == null ? null : c.destLat,
			destLng: c.destLng == null ? null : c.destLng,
			laneMiles: data.lane.has(k) ? data.lane.get(k) : null,
			rateconStatus: s ? s.status : null,
			statedLoadedMiles: s ? s.loadedMiles : null,
			statedEmptyMiles: s ? s.emptyMiles : null,
		});
	}
	return out;
}

module.exports = {
	gatherMilesData,
	assembleMilesLoads,
};
