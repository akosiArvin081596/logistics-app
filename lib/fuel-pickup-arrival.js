"use strict";
// Has the truck reached this load's shipper? The fuel trip plan's "picked up"
// (GET /api/fuel/trip-plan). A load can be marked In Transit before the truck gets
// there, and a plan that then drops the run to the shipper understates the miles
// ahead, so the sheet's status alone never counts. A load the status calls picked
// up is picked up for the plan only once, in its current run, the ELD or the
// geofence has put the load's truck at the shipper on this load's errand:
//   - the geofence wrote "At Shipper" for it;
//   - or a status set to "At Shipper" carries the recorder's ELD fix inside the
//     pickup zone (pickup_zone "inside"). A tap with no such fix does not count;
//   - or the truck's own fixes pass the live geofence's arrival test: a fix inside
//     the radius at arrival speed whose previous fix was inside too.
// The current run starts at plan A's undo rule (lib/arrival-pickup.js liveRun():
// after the last Cancelled, from the last move back after an arrival) or at a
// later Dispatched row. A reassign writes no row, so a history row counts only
// when its actor is the load's driver now. An arrival made while another of that
// driver's loads was under way (the recorder's mark, or the same test rebuilt from
// the history) is that load's errand: it doesn't count, and neither do the fixes
// of that visit until the truck has left the zone. So is an arrival with a twin:
// another of his loads with an "At Shipper" row in the same visit, however far its
// point is, whichever row came first. The geofence advances every load of his near
// the truck, so the track can't tell which of the two is aboard.
// With no run, no driver, no mapped pickup or a read that fails, the answer is
// "not yet": the plan keeps the run to the shipper, which overstates the miles
// ahead rather than understating them. A truck with no ELD device is the one
// exception (tripPlanPickup()): the status stands, as no verdict can pass there.

const geolib = require("geolib");
const arrivalPickup = require("./arrival-pickup");
const arrivalRecorder = require("./arrival-recorder");

// One load's rows, with the columns plan A's orderedRows() reads and the actor;
// load_id is stored lower-case with a leading "#" removed (idx_lsh_load).
const HISTORY_SQL = `SELECT id, load_id, old_status, new_status, source, actor, actor_role, fix_ms, pickup_zone, local_tz, other_load_hauling, changed_at
	FROM load_status_history WHERE load_id = ? ORDER BY changed_at, id`;
// Every load's statuses, for the other loads a driver had under way at a moment.
const ALL_HISTORY_SQL = `SELECT id, load_id, new_status, actor, changed_at FROM load_status_history ORDER BY changed_at, id`;
// The truck's clean fixes in a window, oldest first (idx_rm_tel_vid_date).
const FIXES_SQL = `SELECT location_date_ms AS ms, latitude, longitude, speed FROM routemate_telemetry
	WHERE routemate_vehicle_id = ? AND location_date_ms >= ? AND location_date_ms <= ?
	  AND dropped_reason = '' AND latitude IS NOT NULL AND longitude IS NOT NULL
	ORDER BY location_date_ms ASC, id ASC`;

const MILE_M = 1609.344;
// A visit is the stretch around an arrival in which the truck stays within this
// radius of the mapped pickup: 25 mi, or half the lane (pickup to receiver, a
// straight line) when that is less, so the receiver stays outside it.
const VISIT_RADIUS_M = 25 * MILE_M;
// With no fix to bound it, a visit runs this far either side of the arrival.
const VISIT_SIDE_MS = 2 * 60 * 60 * 1000;
// The visit's fixes are read from this far before the run's start, so a twin
// loaded before this load was dispatched still shares its visit.
const VISIT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// The truck's fixes are read at most this far back: an episode longer than two
// weeks is a status never closed, and "not yet" errs safe for it.
const FIX_READ_CAP_MS = 14 * 24 * 60 * 60 * 1000;

const text = (v) => (v === null || v === undefined ? "" : String(v));
const historyKey = (loadId) => text(loadId).trim().toLowerCase().replace(/^#/, "");
// changed_at is SQLite's UTC "YYYY-MM-DD HH:MM:SS", with no zone marker.
const stampMs = (v) => Date.parse(text(v).trim().replace(" ", "T") + "Z");
const finite = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
// server.js passes normalizeDriverName(); this is the same rule for a caller that doesn't.
const sameName = (v) => text(v).trim().toLowerCase().replace(/\s+/g, " ");

function place(p) {
	if (!p || typeof p !== "object") return null;
	const latitude = finite(p.latitude);
	const longitude = finite(p.longitude);
	// (0, 0) is a failed geocode or a lost satellite fix.
	if (latitude === null || longitude === null || (latitude === 0 && longitude === 0)) return null;
	return { latitude, longitude };
}

// The current run of one load's history rows (HISTORY_SQL's columns): plan A's
// orderedRows() from liveRun()'s start, or from a later Dispatched row, each with
// its actor, and the run's start in ms; null when it has none.
function currentRun(events) {
	const list = Array.isArray(events) ? events : [];
	const all = arrivalPickup.orderedRows(list);
	let { from } = arrivalPickup.liveRun(all);
	for (let k = all.length - 1; k > from; k--) {
		if (all[k].status === "dispatched") { from = k; break; }
	}
	if (from >= all.length) return null;
	const rows = all.slice(from).map((r) => ({ ...r, actor: text(list[r.i] && list[r.i].actor) }));
	return { rows, startMs: rows[0].ms };
}

// The load's driver on the sheet (its row's Driver cell) and the ids of his rows there.
function sheetDriver(sheet, normalizeName) {
	const headers = sheet && Array.isArray(sheet.headers) ? sheet.headers.map(text) : [];
	const col = (re) => headers.find((h) => re.test(h.trim())) || null;
	const driverCol = col(/^driver$/i) || col(/driver/i);
	const idCol = col(/load.?id|job.?id/i);
	const driver = sheet && sheet.row && driverCol ? text(sheet.row[driverCol]) : "";
	const who = normalizeName(driver);
	const rows = sheet && Array.isArray(sheet.rows) ? sheet.rows : [];
	const loadIds = who && idCol ? rows.filter((r) => r && normalizeName(text(r[driverCol])) === who).map((r) => text(r[idCol])) : [];
	return { driver, loadIds };
}

// `driver`'s other loads, from every load's history rows: those the sheet gives him
// now (`sheetLoadIds`) and those with a row written by him, each with its rows
// ({ ms, id, status }, oldest first). A load assigned to him later, or taken from
// him later, is still his here, which can only hold an arrival.
function driverOtherLoads({ history, loadId, driver, sheetLoadIds = [], normalizeName = sameName } = {}) {
	const self = historyKey(loadId);
	const who = normalizeName(driver);
	const his = new Set((Array.isArray(sheetLoadIds) ? sheetLoadIds : []).map(historyKey).filter(Boolean));
	const byLoad = new Map();
	for (const r of Array.isArray(history) ? history : []) {
		const key = historyKey(r && r.load_id);
		const ms = stampMs(r && r.changed_at);
		if (!key || key === self || !Number.isFinite(ms)) continue;
		if (who && normalizeName(r.actor) === who) his.add(key);
		if (!byLoad.has(key)) byLoad.set(key, []);
		byLoad.get(key).push({ ms, id: finite(r.id) || 0, status: text(r.new_status).trim() });
	}
	return [...his].filter((k) => k !== self && byLoad.has(k))
		.map((k) => ({ key: k, rows: byLoad.get(k).sort((a, b) => a.ms - b.ms || a.id - b.id) }));
}

// A test of "was another of `driver`'s loads under way at ms?" over his other
// loads (driverOtherLoads()): each one's status then is its last row at or before
// it, judged as the recorder judges it (lib/arrival-recorder.js otherLoadHauling()).
function otherLoadUnderWayAt({ history, loadId, driver, sheetLoadIds = [], normalizeName = sameName } = {}) {
	const self = historyKey(loadId);
	const loads = driverOtherLoads({ history, loadId, driver, sheetLoadIds, normalizeName });
	return (ms) => {
		const candidates = loads.map(({ key, rows }) => {
			let status = "";
			for (const r of rows) { if (r.ms > ms) break; status = r.status; }
			return { loadId: key, status };
		});
		return arrivalRecorder.otherLoadHauling(candidates, self) === 1;
	};
}

// The visit's radius for a mapped pickup and receiver (VISIT_RADIUS_M, or half the
// lane when that is less), in metres; null with no mapped pickup.
function visitRadiusM(pickup, dest) {
	const p = place(pickup);
	if (!p) return null;
	const d = place(dest);
	return d ? Math.min(VISIT_RADIUS_M, geolib.getDistance(p, d) / 2) : VISIT_RADIUS_M;
}

// The visit around `ms`, as [from, to] in ms: the truck's fixes (oldest first) on
// each side while they stay within `radiusM` of `pickup`, out to the first fix
// beyond it, or to 2 h past the last fix within it when that comes first or no fix
// bounds that side. A gap between two fixes within the radius stays in the visit.
// With no mapped pickup or no fixes, 2 h either side.
function visitBounds(ms, fixes, { pickup, radiusM } = {}) {
	const at = place(pickup);
	const list = at && radiusM > 0 && Array.isArray(fixes) ? fixes : [];
	const near = (f) => geolib.isPointWithinRadius(f, at, radiusM);
	let first = ms;
	let before = null;
	let k = list.length - 1;
	while (k >= 0 && !(finite(list[k].ms) <= ms)) k--;
	for (; k >= 0; k--) {
		const f = place(list[k]);
		if (!f) continue;
		if (!near(f)) { before = finite(list[k].ms); break; }
		first = finite(list[k].ms);
	}
	let last = ms;
	let after = null;
	for (const raw of list) {
		if (!(finite(raw.ms) > ms)) continue;
		const f = place(raw);
		if (!f) continue;
		if (!near(f)) { after = finite(raw.ms); break; }
		last = finite(raw.ms);
	}
	return [
		before !== null ? Math.max(before, first - VISIT_SIDE_MS) : first - VISIT_SIDE_MS,
		after !== null ? Math.min(after, last + VISIT_SIDE_MS) : last + VISIT_SIDE_MS,
	];
}

// A test of "does an arrival at ms have a twin?": another of `driver`'s loads
// (driverOtherLoads()) with an "At Shipper" row, by anyone and from any source,
// written in the same visit (visitBounds()) and by `nowMs`. The twin's own point is
// never read: the geofence advances each load near its own point.
function twinAtShipper({ history, loadId, driver, sheetLoadIds = [], normalizeName = sameName, fixes = [], pickup = null,
	radiusM = null, nowMs = Infinity } = {}) {
	const stamps = [];
	for (const { rows } of driverOtherLoads({ history, loadId, driver, sheetLoadIds, normalizeName })) {
		for (const r of rows) if (r.status.toLowerCase() === "at shipper" && r.ms <= nowMs) stamps.push(r.ms);
	}
	return (ms) => {
		if (!stamps.length) return false;
		const [from, to] = visitBounds(ms, fixes, { pickup, radiusM });
		return stamps.some((t) => t >= from && t <= to);
	};
}

// What the run's own rows say: `by` "geofence" or "recorded_fix" when one of them
// written by the load's driver now puts the truck at the shipper (else null), and
// `holdMs`, the latest such row that is held (the recorder's other_load_hauling 1
// on a geofence row, or `errandAt` at its time: an errand or a twin): the later of
// its fix time and its row time, or null.
function historyArrival(runRows, { driver, normalizeName = sameName, errandAt = null } = {}) {
	const who = normalizeName(driver);
	let by = null;
	let holdMs = null;
	for (const r of Array.isArray(runRows) ? runRows : []) {
		if (!who || r.status !== "at shipper" || normalizeName(r.actor) !== who) continue;
		const geofence = r.source === "geofence";
		if (!geofence && r.zone !== "inside") continue;
		if ((geofence && r.hauling === 1) || (typeof errandAt === "function" && errandAt(r.ms))) {
			const moment = Math.max(r.ms, r.fixMs !== null ? r.fixMs : -Infinity);
			holdMs = holdMs === null ? moment : Math.max(holdMs, moment);
		} else if (geofence) {
			by = "geofence";
		} else if (!by) {
			by = "recorded_fix";
		}
	}
	return { by, holdMs };
}

// The first fix (oldest first) that passes the live geofence's arrival test at
// `pickup`: inside `radiusM`, no faster than `maxSpeedMps` (a fix with no speed
// passes, as it does live), and the fix before it inside too. Its time, or null.
// A held visit never counts: the one holding `holdMs`, and any whose arrival
// `errandAt` flags (an errand or a twin). Its fixes are skipped from there until
// the truck is next outside the zone.
function eldArrivalMs(fixes, { pickup, radiusM, maxSpeedMps, holdMs = null, errandAt = null } = {}) {
	const at = place(pickup);
	if (!at || !(radiusM > 0)) return null;
	let hold = finite(holdMs);
	let held = hold !== null;
	let prevInside = false;
	for (const f of Array.isArray(fixes) ? fixes : []) {
		const here = place(f);
		if (!here) continue;
		const inside = geolib.isPointWithinRadius(here, at, radiusM);
		if (held) {
			if (!inside && finite(f.ms) > hold) held = false;
		} else if (inside && prevInside && !(Number(f.speed) > maxSpeedMps)) {
			const ms = finite(f.ms);
			if (!(typeof errandAt === "function" && errandAt(ms))) return ms;
			held = true;
			hold = ms;
		}
		prevInside = inside;
	}
	return null;
}

// The arrival for one load and truck: { by: "geofence" | "recorded_fix" | "eld" }
// (the first that answers), or null. `sheet` is { headers, rows, row } from the
// Job Tracking read (row: this load's). `linkedSinceMs` is when the device was
// linked to this truck (null when unknown); fixes before it belong to another
// vehicle (lib/eld-position.js), so no test reads them, and none reads fixes
// older than FIX_READ_CAP_MS. `dest` is the mapped receiver, which narrows the
// visit on a short lane (visitRadiusM()).
function shipperArrival({ db, loadId, vehicleId, pickup, dest = null, linkedSinceMs = null, sheet = null, normalizeName = sameName,
	radiusM, maxSpeedMps, nowMs } = {}) {
	try {
		const key = historyKey(loadId);
		const { driver, loadIds } = sheetDriver(sheet, normalizeName);
		if (!db || !key || !normalizeName(driver)) return null;
		const run = currentRun(db.prepare(HISTORY_SQL).all(key));
		if (!run) return null;
		const vid = text(vehicleId).trim();
		const now = finite(nowMs) !== null ? finite(nowMs) : Date.now();
		const link = finite(linkedSinceMs);
		const floor = Math.max(link !== null ? link : -Infinity, now - FIX_READ_CAP_MS);
		let fixes = null;
		const readFixes = () => {
			if (fixes === null) {
				fixes = vid && place(pickup) ? db.prepare(FIXES_SQL).all(vid, Math.max(run.startMs - VISIT_LOOKBACK_MS, floor), now) : [];
			}
			return fixes;
		};
		const ask = { loadId: key, driver, sheetLoadIds: loadIds, normalizeName };
		let history = null;
		let underWayAt = null;
		let twinAt = null;
		// An arrival made on another load's errand, or with a twin, is held.
		const heldAt = (ms) => {
			if (!history) history = db.prepare(ALL_HISTORY_SQL).all();
			if (!underWayAt) underWayAt = otherLoadUnderWayAt({ history, ...ask });
			if (underWayAt(ms)) return true;
			if (!twinAt) twinAt = twinAtShipper({ history, ...ask, fixes: readFixes(), pickup, radiusM: visitRadiusM(pickup, dest), nowMs: now });
			return twinAt(ms);
		};
		const seen = historyArrival(run.rows, { driver, normalizeName, errandAt: heldAt });
		if (seen.by) return { by: seen.by };
		if (!vid || !place(pickup)) return null;
		const since = Math.max(run.startMs, floor);
		const runFixes = readFixes().filter((f) => finite(f.ms) >= since);
		return eldArrivalMs(runFixes, { pickup, radiusM, maxSpeedMps, holdMs: seen.holdMs, errandAt: heldAt }) !== null ? { by: "eld" } : null;
	} catch (err) {
		console.error("[fuel/trip-plan] the shipper arrival could not be read:", err && err.message);
		return null;
	}
}

// The trip plan's "picked up" (GET /api/fuel/trip-plan): { pickedUp, unconfirmed }.
// A load the status doesn't call picked up is not. A truck with no ELD device (no
// vehicle id) has no fuel reading, so no verdict can pass, and its status stands.
// Otherwise the truck's arrival must be seen (shipperArrival()); `unconfirmed` is
// the status saying picked up while the arrival isn't seen.
function tripPlanPickup({ statusPickedUp, vehicleId, ...rest } = {}) {
	if (!statusPickedUp) return { pickedUp: false, unconfirmed: false };
	if (!text(vehicleId).trim()) return { pickedUp: true, unconfirmed: false };
	return shipperArrival({ vehicleId, ...rest }) ? { pickedUp: true, unconfirmed: false } : { pickedUp: false, unconfirmed: true };
}

module.exports = {
	VISIT_SIDE_MS,
	FIX_READ_CAP_MS,
	currentRun,
	sheetDriver,
	driverOtherLoads,
	otherLoadUnderWayAt,
	visitRadiusM,
	visitBounds,
	twinAtShipper,
	historyArrival,
	eldArrivalMs,
	shipperArrival,
	tripPlanPickup,
};
