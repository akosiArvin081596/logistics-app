// Per-load haul measurement: which slice of a truck's telemetry belongs to ONE
// load, and how many miles it drove across that slice. Pure: no network, no
// database, no fs. The only dependencies are geolib (pure geometry) and
// ./eld-miles (pure math).
//
// WHY THE WINDOW IS REPLAYED FROM PINGS AND NOT READ OFF load_status_history.
// `changed_at` records WHEN THE DRIVER TAPPED THE BUTTON, not when the truck
// moved, and the drivers on this fleet batch-tap on arrival. Load 564157463's
// entire lifecycle — Dispatched -> At Receiver -> Delivered — spans 1 minute
// 54 seconds. Summing odometer deltas across that window yields 0.0 miles for a
// load whose truck demonstrably drove 248 miles that day. Across the 42 loads
// carrying both markers the In Transit -> Delivered span has a 2.4-MINUTE
// minimum, and exactly ONE load in the database (563166022) has a window built
// entirely from geofence-sourced rows.
//
// So a status window cannot measure anything. What CAN is the telemetry itself:
// the truck's own fixes say when it reached the shipper, when it left, and when
// it reached the receiver. That is the same question checkGeofence() answers
// live, asked retroactively — which is why this module uses geolib's
// isPointWithinRadius against the same coordinates, rather than a hand-rolled
// distance test that could disagree with the live geofence at the margin.
//
// EVERY UNRESOLVED END RETURNS null, NEVER 0. A load on a truck with no ELD, or
// one older than the 90-day telemetry retention, has no measurement — and "0
// miles" is a claim, not an absence. Same rule GET /api/analytics/mileage
// already enforces for a truck with no rows.

const geolib = require("geolib");
const eldMiles = require("./eld-miles");

// Same default as server.js's GEOFENCE_RADIUS (3218.69 m = 2 miles, raised from
// 1000 m on 2026-08-06 at the client's request). Kept as a SEPARATE knob —
// HAUL_REPLAY_RADIUS_M — so this measurement can be tightened without moving
// the live geofence, which writes real status transitions and notifications.
//
// BIAS THIS INTRODUCES, STATED PLAINLY: departure is detected at the moment the
// truck leaves a 2-mile circle and arrival at the moment it enters one, so
// loaded miles systematically EXCLUDE roughly the first and last 2 miles of the
// haul — about 4 miles against the lane figure. That is a known, bounded,
// one-directional error, and it is the price of agreeing with the geofence.
const DEFAULT_REPLAY_RADIUS_M = 3218.69;

// Floor for the shrink below. Two stops inside 300 m of each other are the same
// facility as far as any GPS fix is concerned, and a radius under this would
// make zone membership a coin toss on ordinary scatter.
const MIN_EFFECTIVE_RADIUS_M = 150;

// ⚠️ Number(null) is 0, and Number("") is 0. Both would be silently accepted as
// real values by a bare Number.isFinite() test — a missing latitude would become
// the equator and a missing dispatchMs would become the epoch, widening the
// deadhead leg to every ping ever recorded. Reject the empties explicitly.
function num(v) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function pointOf(p) {
	if (!p) return null;
	const lat = num(p.lat !== undefined ? p.lat : p.latitude);
	const lng = num(p.lng !== undefined ? p.lng : p.longitude);
	if (lat === null || lng === null) return null;
	if (lat === 0 && lng === 0) return null; // null island — the same reject the ingest gates use
	return { latitude: lat, longitude: lng };
}

/**
 * Effective zone radius for one lane.
 *
 * ⚠️ A LANE SHORTER THAN TWICE THE RADIUS HAS OVERLAPPING ZONES, and that is not
 * hypothetical — it is the same geometry that would strand a short load at "At
 * Shipper" forever, which server.js documents beside tryGeofenceAdvance. With
 * 2-mile circles, any lane under 4 miles has a truck permanently inside both,
 * so departure never fires and the haul is unmeasurable.
 *
 * Shrinking to just under half the origin->destination separation restores two
 * disjoint zones on exactly those lanes and changes nothing on normal ones.
 */
function effectiveRadiusM(origin, dest, radiusM) {
	const base = num(radiusM) !== null && radiusM > 0 ? Number(radiusM) : DEFAULT_REPLAY_RADIUS_M;
	if (!origin || !dest) return base;
	const sep = geolib.getDistance(origin, dest);
	if (!Number.isFinite(sep) || sep <= 0) return base;
	if (sep >= base * 2) return base;
	return Math.max(MIN_EFFECTIVE_RADIUS_M, sep / 2 - 1);
}

/**
 * Normalise + sort raw telemetry rows into the shape this module walks.
 * Rows missing a usable position or odometer are dropped here rather than
 * defended against at every use site.
 */
function normalizeSamples(rows) {
	const out = [];
	for (const r of rows || []) {
		const ms = num(r && r.ms);
		const odo = num(r && r.odo);
		const lat = num(r && r.lat);
		const lng = num(r && r.lng);
		if (ms === null || odo === null || odo <= 0) continue;
		if (lat === null || lng === null) continue;
		// Null island. The ingest gates already tag these 'invalid_coords' and
		// every read path filters dropped_reason = '', so this is defence in
		// depth — but it costs nothing and it keeps this module honest when
		// called with rows from somewhere else.
		if (lat === 0 && lng === 0) continue;
		out.push({ ms, odo, lat, lng });
	}
	out.sort((a, b) => a.ms - b.ms);
	return out;
}

/**
 * Which zone a fix is in — origin, destination, or neither.
 *
 * The `closer to this end than the other` clause is not belt-and-braces. It is
 * what makes the two zones MUTUALLY EXCLUSIVE once effectiveRadiusM has shrunk
 * them, and it mirrors the live geofence's own departure rule, which accepts
 * "moving and now closer to the delivery than to the pickup" precisely because
 * radius membership alone cannot separate the ends of a short haul.
 */
function zoneOf(sample, origin, dest, radiusM) {
	const here = { latitude: sample.lat, longitude: sample.lng };
	const dOrigin = origin ? geolib.getDistance(here, origin) : Infinity;
	const dDest = dest ? geolib.getDistance(here, dest) : Infinity;
	if (origin && dOrigin <= radiusM && dOrigin <= dDest) return "origin";
	if (dest && dDest <= radiusM && dDest < dOrigin) return "dest";
	return "";
}

/**
 * Resolve the physical haul window for one load.
 *
 * samples: [{ ms, lat, lng, odo }] — already filtered to dropped_reason = ''
 *          and to one vehicle. Order does not matter; this sorts.
 * opts: { origin, dest, radiusM, dispatchMs, terminal }
 *   - origin/dest accept {lat,lng} or {latitude,longitude}
 *   - dispatchMs bounds the DEADHEAD leg only; it is the one place a
 *     button-press timestamp is still used, because "when was this load handed
 *     to the driver" is a dispatch fact, not a physical one, and the leg's far
 *     end (arrival at the shipper) is measured physically anyway.
 *   - terminal: true when the load is delivered/completed/cancelled. Decides
 *     whether a missing destination arrival means "still running" or "we never
 *     saw it get there".
 *
 * Returns { pickupArriveMs, pickupDepartMs, destArriveMs, lastSampleMs,
 *           inProgress, radiusM, reason }.
 * Any field that could not be resolved is null and `reason` names why.
 */
function resolveHaulWindow(samples, opts) {
	const o = opts || {};
	const origin = pointOf(o.origin);
	const dest = pointOf(o.dest);
	const rows = normalizeSamples(samples);
	const out = {
		pickupArriveMs: null,
		pickupDepartMs: null,
		destArriveMs: null,
		lastSampleMs: rows.length ? rows[rows.length - 1].ms : null,
		inProgress: false,
		radiusM: null,
		reason: "",
	};

	if (!origin || !dest) { out.reason = "no_coordinates"; return out; }
	if (!rows.length) { out.reason = "no_samples"; return out; }

	const radiusM = effectiveRadiusM(origin, dest, o.radiusM);
	out.radiusM = radiusM;

	const zones = rows.map((s) => zoneOf(s, origin, dest, radiusM));

	// Arrival at the shipper: the FIRST fix in the origin zone.
	const firstOriginIdx = zones.indexOf("origin");
	if (firstOriginIdx === -1) { out.reason = "no_pickup_zone"; return out; }
	out.pickupArriveMs = rows[firstOriginIdx].ms;

	// Departure: the first fix after the LAST origin-zone fix.
	//
	// Anchoring on the last one rather than the first exit is deliberate. A
	// truck circling a yard, repositioning to a second dock, or parked overnight
	// on the shipper's lot drifts in and out of a 2-mile circle repeatedly; the
	// first exit would start the loaded leg hours early and bill yard shuffling
	// as line-haul. The last exit is the one that actually began the haul.
	let lastOriginIdx = -1;
	for (let i = zones.length - 1; i >= 0; i--) {
		if (zones[i] === "origin") { lastOriginIdx = i; break; }
	}
	if (lastOriginIdx >= rows.length - 1) {
		// Still sitting at the shipper as of the newest fix we hold.
		out.reason = "no_departure";
		return out;
	}
	out.pickupDepartMs = rows[lastOriginIdx + 1].ms;

	// Arrival at the receiver: the first destination-zone fix at or after
	// departure. The ordering constraint matters — a lane that doubles back past
	// the receiver's neighbourhood on the way out would otherwise register an
	// arrival before the truck ever left.
	for (let i = lastOriginIdx + 1; i < rows.length; i++) {
		if (zones[i] === "dest") { out.destArriveMs = rows[i].ms; break; }
	}

	if (out.destArriveMs === null) {
		// No arrival seen. For a live load that is the normal mid-haul state and
		// the leg is measured up to the newest fix ("so far"). For a load already
		// closed out it means the telemetry never covered the arrival — a gap, a
		// dark ELD, or a receiver whose stored coordinates are wrong — and a
		// figure would be a guess.
		if (o.terminal) { out.reason = "no_arrival"; return out; }
		out.inProgress = true;
	}
	return out;
}

/** Inclusive slice by timestamp. */
function sliceSamples(samples, fromMs, toMs) {
	if (fromMs === null || toMs === null || !(toMs >= fromMs)) return [];
	return normalizeSamples(samples).filter((s) => s.ms >= fromMs && s.ms <= toMs);
}

/**
 * Miles across one leg, plus the basis label for it.
 *
 * Returns { miles: null } — never { miles: 0 } — when the leg has fewer than two
 * samples, because one fix cannot describe a distance and zero fixes cannot
 * describe anything. A genuinely parked leg DOES return 0 with basis 'eld',
 * which is a measurement and is meant to be shown.
 */
function legMiles(samples, fromMs, toMs) {
	const rows = sliceSamples(samples, fromMs, toMs);
	if (rows.length < 2) {
		return { miles: null, basis: "no-data", samples: rows.length, rejected: 0, maxGapMs: 0, droppedMiles: 0, reasons: {} };
	}
	const agg = eldMiles.sumOdoDeltas(rows.map((s) => ({ ms: s.ms, odo: s.odo, lng: s.lng })));
	return {
		miles: agg.miles,
		basis: eldMiles.dayBasis(agg),
		samples: agg.samples,
		rejected: agg.rejected,
		maxGapMs: agg.maxGapMs,
		droppedMiles: agg.droppedMiles,
		reasons: agg.reasons,
	};
}

/**
 * The whole per-load measurement.
 *
 * totalMiles is null unless BOTH legs resolved. Adding a known loaded figure to
 * an unknown deadhead one and calling the result a total would be the same
 * category of error as reporting 0 for "no data" — the honest answer to "how far
 * did this truck run for this load" when half of it was never observed is that
 * we do not know.
 */
function computeHaulMiles(samples, opts) {
	const o = opts || {};
	const rows = normalizeSamples(samples);
	const window = resolveHaulWindow(rows, o);

	const loadedEnd = window.destArriveMs !== null ? window.destArriveMs : (window.inProgress ? window.lastSampleMs : null);
	const loaded = legMiles(rows, window.pickupDepartMs, loadedEnd);

	const dispatchMs = num(o.dispatchMs);
	const deadhead = legMiles(rows, dispatchMs, window.pickupArriveMs);

	const totalMiles = loaded.miles !== null && deadhead.miles !== null
		? Math.round((loaded.miles + deadhead.miles) * 10) / 10
		: null;

	// Rolled up the same way a week or a month is: any partial leg makes the
	// whole figure partial, and it is 'eld' only if every observed leg was clean.
	const basis = eldMiles.basisLabel([loaded.basis, deadhead.basis]);

	const windowStartMs = dispatchMs !== null ? dispatchMs : window.pickupArriveMs;
	const windowEndMs = loadedEnd !== null ? loadedEnd : window.pickupArriveMs;

	return {
		loadedMiles: loaded.miles,
		deadheadMiles: deadhead.miles,
		totalMiles,
		basis,
		loadedBasis: loaded.basis,
		deadheadBasis: deadhead.basis,
		inProgress: window.inProgress,
		reason: window.reason,
		radiusM: window.radiusM,
		pickupArriveMs: window.pickupArriveMs,
		pickupDepartMs: window.pickupDepartMs,
		destArriveMs: window.destArriveMs,
		windowStartMs,
		windowEndMs,
		// Sample count of the measured legs only. This is what the persistence
		// guard compares, so it must count what was actually walked — not every
		// row the outer query happened to return.
		samples: loaded.samples + deadhead.samples,
		rejectedDeltas: loaded.rejected + deadhead.rejected,
		maxGapMs: Math.max(loaded.maxGapMs, deadhead.maxGapMs),
		droppedMiles: Math.round((loaded.droppedMiles + deadhead.droppedMiles) * 10) / 10,
	};
}

/**
 * Which truck a driver held AT A GIVEN INSTANT.
 *
 * ⚠️ THIS IS THE HISTORICAL QUESTION, AND IT IS NOT THE ONE
 * resolveTruckForDriverName() ANSWERS. That helper reads the OPEN assignment
 * row — "which truck is this driver in right now" — which is correct for the
 * fuel panel and wrong for a load that ran last month: it would measure a
 * historical haul off the odometer of a truck the driver moved to afterwards.
 * lib/eld-miles.js documents the same hazard for getInvestorDriverSet().
 *
 * ⚠️ NO PRESENT-TENSE FALLBACK. If no assignment covered the instant we do not
 * know which truck ran the load, and today's truck is a guess wearing the
 * clothes of a measurement. Returns null and the caller reports it.
 *
 * `end_date` of '' (or null) means STILL OPEN, never the epoch — the same
 * convention buildDriverAtResolver() relies on, and the same inversion that has
 * been miscoded twice elsewhere in this codebase.
 *
 * `normalizeName` is INJECTED so there is exactly one driver-name rule in the
 * process. server.js passes normalizeDriverName(), which also collapses INTERNAL
 * whitespace — real rows carry typo'd double spaces, and a second hand-written
 * copy of that rule is the drift hazard DRIVER_RENAME_TARGETS exists because of.
 */
function buildTruckAtResolver(assignmentRows, normalizeName) {
	const norm = typeof normalizeName === "function"
		? normalizeName
		: (v) => String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
	const byDriver = new Map();
	for (const r of assignmentRows || []) {
		const key = norm(r && r.driver_name);
		if (!key) continue;
		const start = Date.parse(r.start_date);
		if (!Number.isFinite(start)) continue;
		const end = r.end_date ? Date.parse(r.end_date) : Infinity;
		if (!byDriver.has(key)) byDriver.set(key, []);
		byDriver.get(key).push({
			start,
			end: Number.isFinite(end) ? end : Infinity,
			truck_id: r.truck_id,
			unit: r.unit,
			vid: r.vid || "",
		});
	}
	// Newest first, so the most recent covering assignment wins a tie. A handover
	// writes the outgoing row's end_date and the incoming row's start_date to the
	// SAME instant, so at exactly that millisecond both cover it — and the truck
	// the driver moved TO is the right answer.
	for (const list of byDriver.values()) list.sort((a, b) => b.start - a.start);

	return {
		forDriverAt(driverName, atMs) {
			const list = byDriver.get(norm(driverName));
			const t = Number(atMs);
			if (!list || !list.length || !Number.isFinite(t)) return null;
			for (const a of list) {
				if (t >= a.start && t <= a.end) {
					return { truck_id: a.truck_id, unit: a.unit, vid: a.vid };
				}
			}
			return null;
		},
	};
}

/**
 * Where the DEADHEAD leg is allowed to start.
 *
 * ⚠️ WHY A FLOOR IS NEEDED AT ALL. The deadhead leg runs from "this load was
 * handed to the driver" to "the truck reached the shipper", and the first half
 * of that is a dispatch timestamp. Dispatch routinely happens days ahead: load
 * 563166022's own status history spans 170 hours, so a leg anchored on its
 * dispatch tap swallowed a WEEK of driving — 449 miles, most of it spent
 * hauling other freight — and presented it as this load's deadhead. That is not
 * an imprecise number, it is a wrong one.
 *
 * The floor is the moment the truck last finished with something else. Miles
 * before that belong to that load; miles after it were genuinely spent getting
 * to this shipper, even if the truck idled for part of them.
 *
 * ⚠️ PRIOR LOADS ONLY EVER RAISE THE FLOOR, NEVER CREATE ONE. With no dispatch
 * timestamp we do not know this load existed yet, and inferring a start from a
 * neighbouring load's end would invent a window rather than narrow one — so the
 * answer stays null and the leg reports "not measured".
 */
function deadheadFloorMs(otherSpans, pickupArriveMs, dispatchMs) {
	const arrive = num(pickupArriveMs);
	const dispatch = num(dispatchMs);
	if (dispatch === null) return null;
	if (arrive === null) return dispatch;
	let floor = dispatch;
	for (const sp of otherSpans || []) {
		const end = num(sp && sp.endMs);
		if (end === null || end >= arrive) continue;
		if (end > floor) floor = end;
	}
	return floor;
}

/**
 * Do two [start, end] windows intersect? Used to flag a haul whose window
 * overlaps another load on the SAME truck, where the odometer cannot say which
 * load a mile belongs to. Touching endpoints do not count as an overlap.
 */
function windowsOverlap(aStart, aEnd, bStart, bEnd) {
	const as = num(aStart), ae = num(aEnd), bs = num(bStart), be = num(bEnd);
	if (as === null || ae === null || bs === null || be === null) return false;
	return as < be && bs < ae;
}

module.exports = {
	DEFAULT_REPLAY_RADIUS_M,
	MIN_EFFECTIVE_RADIUS_M,
	effectiveRadiusM,
	normalizeSamples,
	zoneOf,
	resolveHaulWindow,
	sliceSamples,
	legMiles,
	deadheadFloorMs,
	buildTruckAtResolver,
	computeHaulMiles,
	windowsOverlap,
};
