// Per-load miles: one figure per load, from the best source on file. Pure: no
// network, no database, no fs. The only dependencies are geolib (pure geometry)
// and ./ratecon-load (pure parsing).
//
// WHY THIS EXISTS. GET /api/investor and GET /api/financials each built their
// own `milesByLoadId` from load_coordinates alone, keyed by the stored load_id
// lowercased, and looked it up by the sheet's Load ID cell lowercased. Every
// writer of load_coordinates stores the NORMALISED key ("#123" -> "123"), so a
// load whose Load ID cell reads "#123" missed its row and contributed 0 miles.
// One key rule (loadMilesKey) and one index (buildLoadMilesIndex) now serve
// both handlers.
//
// SOURCES, BEST FIRST (LOAD_MILES_SOURCES):
//   eld           load_eld_miles: the loaded leg the truck actually drove,
//                 replayed from its own pings (lib/load-haul.js). Final rows
//                 only, and only a leg observed without dropped deltas.
//   ratecon       the road miles rate-con ingestion stored for the load (the
//                 Job Details tab's Distance cell, "486 Miles"), read back,
//                 never recomputed.
//   road          load_coordinates.distance_miles > 0 (the cached road
//                 distance).
//   straight_line haversine between load_coordinates' two ends: the fallback
//                 both handlers used before.
//
// `miles` is always the LOADED lane (shipper -> receiver), the one quantity
// every source measures, so a total mixing sources still adds like to like.
// The ELD deadhead leg is carried beside it in `deadheadMiles` and is never
// folded into `miles`.

const geolib = require("geolib");
const { normalizeLoadId, cityStateZip } = require("./ratecon-load");

const LOAD_MILES_SOURCES = ["eld", "ratecon", "road", "straight_line"];
const SOURCE_RANK = new Map(LOAD_MILES_SOURCES.map((s, i) => [s, i]));
const METERS_PER_MILE = 1609.344;

// THE key for every per-load miles lookup. Identical to normalizeLoadId() and
// to server.js's normLoadKey(), the rule load_eld_miles and load_coordinates
// are written with, so a key built here always finds a stored row.
function loadMilesKey(id) {
	return normalizeLoadId(id);
}

// ⚠️ Number(null) is 0. A missing coordinate must not become the equator.
function num(v) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

// "1,234 Miles", "486 Miles", "486Miles", "486 mi", 486 -> the number.
// "0 Miles" is calculateRatePerMile()'s "the Distance Matrix could not answer"
// sentinel, not a distance, so it reads as null like any other non-figure.
// Every quantifier is bounded: the cell is sheet text.
const MILES_CELL_RE = /^(\d{1,3}(?:,\d{3}){1,2}|\d{1,7})(?:\.(\d{1,3}))?\s{0,4}(?:miles?|mi)?\.?$/i;
function parseMilesCell(value) {
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
	const s = String(value == null ? "" : value).trim();
	if (!s || s.length > 32) return null;
	const m = MILES_CELL_RE.exec(s);
	if (!m) return null;
	const n = Number(`${m[1].replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`);
	return Number.isFinite(n) && n > 0 ? n : null;
}

// "$1,500.00", " $ 2,000.00 ", "1500", 1500 -> 150000 (cents). Unreadable -> null.
function paymentCents(value) {
	if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) : null;
	const s = String(value == null ? "" : value).replace(/[$,\s]/g, "");
	if (!s || s.length > 16 || !/^-?\d{1,10}(?:\.\d{1,4})?$/.test(s)) return null;
	return Math.round(Number(s) * 100);
}

function normLane(s) {
	return String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
}

// The lane exactly as ingestion wrote it into Job Details' Details cell
// (calculateRatePerMile(): `${cityStateZip(pickup)} - ${cityStateZip(dropoff)}`),
// rebuilt from the Job Tracking row's two address cells. "" when either is blank.
function laneKey(pickupAddress, dropoffAddress) {
	const p = String(pickupAddress == null ? "" : pickupAddress).trim();
	const d = String(dropoffAddress == null ? "" : dropoffAddress).trim();
	if (!p || !d) return "";
	return normLane(`${cityStateZip(p)} - ${cityStateZip(d)}`);
}

/**
 * Which stored rate-con road miles belong to which load.
 *
 * ⚠️ THE JOB DETAILS TAB HAS NO LOAD ID COLUMN. Its column A header is blank and
 * both ingestion paths' "Load ID" key is dropped on write, so a row there is
 * identified only by what ingestion wrote beside the distance: the lane
 * (Details) and the rate (Payment). Those are matched against the same two
 * values on the load's Job Tracking row.
 *
 * Two tiers, and a figure only when every candidate row agrees:
 *   1. lane + payment: the row this load's own ingestion wrote.
 *   2. lane alone, when no row carries this payment (the rate was edited after
 *      ingestion): the stored road miles of that exact lane.
 * Rows that disagree are ambiguous and give no figure: a load with no figure
 * falls through to the next source rather than taking a guess.
 *
 * jobDetails: { headers: [...], rows: [[...], ...] } as the Sheets API returns
 *             the tab (header row excluded from rows).
 * loads:      [{ key, pickupAddress, dropoffAddress, payment }]
 * Returns { matches: Map(key -> { miles, match }), counts }.
 */
function matchRateconMiles(jobDetails, loads) {
	const counts = { lane_payment: 0, lane: 0, ambiguous: 0, no_match: 0, no_lane: 0 };
	const matches = new Map();
	const headers = ((jobDetails && jobDetails.headers) || []).map((h) => normLane(h));
	const detailsIdx = headers.indexOf("details");
	const distanceIdx = headers.indexOf("distance");
	const paymentIdx = headers.indexOf("payment");
	if (detailsIdx === -1 || distanceIdx === -1) {
		return { matches, counts: { ...counts, no_columns: 1 } };
	}

	const byLanePay = new Map();
	const byLane = new Map();
	const add = (map, key, miles) => {
		let set = map.get(key);
		if (!set) map.set(key, (set = new Set()));
		set.add(miles);
	};
	for (const row of (jobDetails && jobDetails.rows) || []) {
		if (!Array.isArray(row)) continue;
		const miles = parseMilesCell(row[distanceIdx]);
		if (miles === null) continue;
		const lane = normLane(row[detailsIdx]);
		if (!lane) continue;
		add(byLane, lane, miles);
		const cents = paymentIdx === -1 ? null : paymentCents(row[paymentIdx]);
		if (cents !== null) add(byLanePay, `${lane}|${cents}`, miles);
	}

	const seen = new Set();
	for (const load of loads || []) {
		const key = load && load.key;
		if (!key || seen.has(key)) continue;
		seen.add(key);
		const lane = laneKey(load.pickupAddress, load.dropoffAddress);
		if (!lane) { counts.no_lane += 1; continue; }
		const cents = paymentCents(load.payment);
		const exact = cents === null ? null : byLanePay.get(`${lane}|${cents}`);
		const tier = exact ? "lane_payment" : "lane";
		const candidates = exact || byLane.get(lane);
		if (!candidates) { counts.no_match += 1; continue; }
		if (candidates.size !== 1) { counts.ambiguous += 1; continue; }
		matches.set(key, { miles: [...candidates][0], match: tier });
		counts[tier] += 1;
	}
	return { matches, counts };
}

// A load_eld_miles row's loaded leg, when it is a final, fully observed figure.
// in_progress rows are still being driven; a 'partial' leg dropped deltas and
// under-reads; a NULL leg was never resolved. None of them is a measurement.
function eldEntry(row) {
	if (!row || Number(row.in_progress)) return null;
	if (row.loaded_basis !== "eld") return null;
	const loaded = num(row.loaded_miles);
	if (loaded === null || !(loaded > 0)) return null;
	const deadhead = num(row.deadhead_miles);
	return { miles: loaded, loadedMiles: loaded, deadheadMiles: deadhead, source: "eld" };
}

function rateconEntry(row) {
	const miles = row ? parseMilesCell(row.miles) : null;
	return miles === null ? null : { miles, loadedMiles: miles, deadheadMiles: null, source: "ratecon" };
}

// One load_coordinates row: its cached road distance when there is one, else
// the straight line between its two ends. Same arithmetic both handlers ran.
function coordsEntry(row) {
	if (!row) return null;
	const road = num(row.distance_miles);
	if (road !== null && road > 0) {
		return { miles: road, loadedMiles: road, deadheadMiles: null, source: "road" };
	}
	const oLat = num(row.origin_lat), oLng = num(row.origin_lng);
	const dLat = num(row.dest_lat), dLng = num(row.dest_lng);
	if (oLat === null || oLng === null || dLat === null || dLng === null) return null;
	const miles = geolib.getDistance(
		{ latitude: oLat, longitude: oLng },
		{ latitude: dLat, longitude: dLng },
	) / METERS_PER_MILE;
	return { miles, loadedMiles: miles, deadheadMiles: null, source: "straight_line" };
}

/**
 * Map(loadMilesKey -> { miles, loadedMiles, deadheadMiles, source }).
 *
 * Precedence eld > ratecon > road > straight_line. Two stored rows that
 * normalise to one key ("#123" and "123") compete like any other pair; at equal
 * rank the row already stored under the normalised key wins, so the answer does
 * not depend on row order.
 */
function buildLoadMilesIndex({ eldRows, rateconRows, coordRows } = {}) {
	const index = new Map();
	const exactKey = new Map();
	const offer = (rawId, entry) => {
		if (!entry) return;
		const key = loadMilesKey(rawId);
		if (!key) return;
		const exact = String(rawId == null ? "" : rawId) === key;
		const cur = index.get(key);
		if (cur) {
			const a = SOURCE_RANK.get(entry.source);
			const b = SOURCE_RANK.get(cur.source);
			if (a > b) return;
			if (a === b && (!exact || exactKey.get(key))) return;
		}
		index.set(key, entry);
		exactKey.set(key, exact);
	};
	for (const r of eldRows || []) offer(r && r.load_id, eldEntry(r));
	for (const r of rateconRows || []) offer(r && r.load_id, rateconEntry(r));
	for (const r of coordRows || []) offer(r && r.load_id, coordsEntry(r));
	return index;
}

// Fill a lookup object for code that reads by the sheet's Load ID cell
// lowercased: each load answers under its key AND under "#"+key, so "#123",
// "123" and " 123 " (trimmed by the caller) all find it. `target` is the
// caller's own null-prototype object; a key a load is really stored under is
// never overwritten by another load's "#" alias.
function fillMilesLookup(target, index) {
	for (const [key, e] of index) target[key] = e.miles;
	for (const [key, e] of index) {
		const alias = `#${key}`;
		if (!Object.prototype.hasOwnProperty.call(target, alias)) target[alias] = e.miles;
	}
	return target;
}

function milesSourceCounts(index) {
	const out = Object.fromEntries(LOAD_MILES_SOURCES.map((s) => [s, 0]));
	for (const e of index.values()) out[e.source] += 1;
	return out;
}

module.exports = {
	LOAD_MILES_SOURCES,
	loadMilesKey,
	parseMilesCell,
	paymentCents,
	laneKey,
	matchRateconMiles,
	buildLoadMilesIndex,
	fillMilesLookup,
	milesSourceCounts,
};
