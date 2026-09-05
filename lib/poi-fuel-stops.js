"use strict";

// Diesel truck-stop / fuel-station finder along a route.
//
// Powers `GET /api/poi/fuel-stops`. Samples a handful of waypoints along the
// route — the ACTUAL driving polyline when the caller passes `routePath` (so the
// search circles sit on the highway), else a straight-line origin→dest
// approximation — and queries Google Places API (New) `places:searchNearby`
// around each, then dedupes by placeId and ranks truck-friendly diesel brands
// first.
//
// Request shape/headers MIRROR the existing, proven Places (New) call in
// server.js (`GET /api/geocode/search` → POST places:searchText): same
// `X-Goog-Api-Key` + `X-Goog-FieldMask` headers, same `places.*` response
// parsing. Network resilience (AbortController timeout + light
// exponential-backoff retry, fail-fast on 4xx) mirrors lib/routemate-client.js.
//
// Pure aside from the injected `fetchImpl`: pass a mock fetch + fake apiKey to
// self-test offline. The API key is passed in by the caller and is NEVER
// logged, echoed, or persisted here.

const PLACES_SEARCH_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
// `places.fuelOptions` returns per-station pump prices (DIESEL / TRUCK_DIESEL)
// where Google has coverage — this is the "true cheapest" data source. It bumps
// the request to the Places Enterprise+Atmosphere SKU, so it rides on the calls
// we already make (no extra requests) and stays capped by poiLimiter upstream.
const FIELD_MASK = "places.displayName,places.formattedAddress,places.location,places.id,places.primaryType,places.fuelOptions";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const SEARCH_RADIUS_M = 20000;          // ~12.4 mi search circle per waypoint (contract: ~15–25 km)
const MIN_WAYPOINTS = 4;
const MAX_WAYPOINTS = 8;
const MILES_PER_WAYPOINT = 75;          // ~1 sampled waypoint per 75 route-miles, clamped to [4,8]
const MAX_RESULTS_PER_WAYPOINT = 20;    // Google's hard cap on searchNearby maxResultCount
const METERS_PER_MILE = 1609.344;

// geolib is an app dependency (used elsewhere for getDistance/isPointWithinRadius);
// fall back to an inline haversine so this module still works in an isolated
// self-test if it is ever unavailable.
let geolib = null;
try { geolib = require("geolib"); } catch { geolib = null; }

// ⚠️ TWO LISTS, AND THE SPLIT IS THE WHOLE POINT.
//
// A driver sent to a station a Class 8 cannot enter has been sent nowhere. The
// owner reported exactly that on 2026-09-05: the panel was offering "Prenger
// Foods" (a grocery store with a pump) and a column of Casey's, with no Pilot,
// Love's or TA anywhere in the list.
//
// TRUCK_STOP_BRANDS are travel centers: high-flow diesel lanes, room to turn a
// 53' trailer, truck parking. CAR_ORIENTED_BRANDS are recognised ONLY so the
// name renders nicely — they are convenience stores and MUST NOT be treated as
// truck-capable. Casey's in particular is a corner store; it was previously in
// the truck list, which is half of why the owner saw what he saw.
//
// Order matters: more specific first (e.g. "Pilot Flying J" before bare "Pilot").
// Matched case-insensitively as a substring of the display name. TA/Petro
// patterns are deliberately multi-word — a bare "ta"/"petro" would false-match.
const TRUCK_STOP_BRANDS = [
	{ brand: "Pilot Flying J", patterns: ["pilot flying j"] },
	{ brand: "Flying J", patterns: ["flying j"] },
	{ brand: "Pilot", patterns: ["pilot travel", "pilot #", "pilot store"] },
	{ brand: "Love's", patterns: ["love's travel", "loves travel", "love's country", "love's #"] },
	{ brand: "TA", patterns: ["travelcenters of america", "ta travel", "ta petro", "ta express"] },
	{ brand: "Petro", patterns: ["petro stopping", "petro travel", "petro:"] },
	{ brand: "Sapp Bros", patterns: ["sapp bros", "sapp brothers"] },
	{ brand: "Roady's", patterns: ["roady's", "roadys truck"] },
	{ brand: "AMBEST", patterns: ["ambest", "am best travel"] },
	{ brand: "Bosselman", patterns: ["bosselman"] },
	{ brand: "Road Ranger", patterns: ["road ranger"] },
	{ brand: "QuikTrip", patterns: ["quiktrip travel", "qt travel center"] },
];

// Recognised for display only. NEVER truck-capable on the strength of the name.
const CAR_ORIENTED_BRANDS = [
	{ brand: "Casey's", patterns: ["casey's", "caseys general", "casey's general"] },
	{ brand: "Kwik Trip", patterns: ["kwik trip", "kwik star"] },
	{ brand: "Buc-ee's", patterns: ["buc-ee", "bucee"] },
];

// Kept for callers/tests that imported the old name. Truck brands first so a
// name matching both resolves to the truck brand.
const DIESEL_BRANDS = [...TRUCK_STOP_BRANDS, ...CAR_ORIENTED_BRANDS];

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function toNum(v) {
	if (typeof v === "number") return v;
	if (typeof v === "string" && v.trim() !== "") return Number(v);
	return NaN;
}

// Great-circle distance in meters. Prefers geolib (house convention) but falls
// back to a self-contained haversine.
function distanceMeters(a, b) {
	if (geolib && typeof geolib.getDistance === "function") {
		return geolib.getDistance(
			{ latitude: a.lat, longitude: a.lng },
			{ latitude: b.lat, longitude: b.lng },
		);
	}
	const R = 6371000; // Earth radius, meters
	const toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const lat1 = toRad(a.lat);
	const lat2 = toRad(b.lat);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Pull the best diesel pump price from a Places `fuelOptions` object. Prefers
// TRUCK_DIESEL (the truck-lane price at a travel center) then plain DIESEL.
// Returns { price, type, updated, currency } or null when the station has no
// diesel price (Google's coverage is partial — many stations return nothing).
function extractDiesel(fuelOptions) {
	const prices = fuelOptions && Array.isArray(fuelOptions.fuelPrices) ? fuelOptions.fuelPrices : [];
	if (!prices.length) return null;
	const pick = prices.find((f) => f && f.type === "TRUCK_DIESEL")
		|| prices.find((f) => f && f.type === "DIESEL");
	if (!pick || !pick.price) return null;
	// price is a google.type.Money: { currencyCode, units (int64 string), nanos }.
	const units = Number(pick.price.units || 0);
	const nanos = Number(pick.price.nanos || 0);
	const price = units + nanos / 1e9;
	if (!Number.isFinite(price) || price <= 0) return null;
	return {
		price: Math.round(price * 1000) / 1000,
		type: pick.type,
		updated: pick.updateTime || "",
		currency: (pick.price.currencyCode) || "USD",
	};
}

// Best-effort brand from a place display name; "" when nothing recognized.
function deriveBrand(name) {
	const lc = String(name || "").toLowerCase();
	if (!lc) return "";
	for (const { brand, patterns } of DIESEL_BRANDS) {
		if (patterns.some((p) => lc.includes(p))) return brand;
	}
	return "";
}

// Is this somewhere a Class 8 can actually pull in and fuel?
//
// Layered on purpose. Google's `truck_stop` typing is real but INCOMPLETE — some
// genuine travel centers come back typed `gas_station` — so type alone
// under-reports. A TRUCK_DIESEL pump is the strongest positive signal available
// (a station plumbed for truck diesel has truck lanes), and a known travel-center
// brand catches the rest.
function isTruckCapable(primaryType, brand, dieselType) {
	if (String(primaryType || "").toLowerCase() === "truck_stop") return true;
	if (String(dieselType || "").toUpperCase() === "TRUCK_DIESEL") return true;
	return TRUCK_STOP_BRANDS.some((b) => b.brand === brand);
}

// ⚠️ TRUCK-CAPABILITY IS A HARD TIER, NOT A NUDGE.
//
// It used to be additive: truck_stop +2, known brand +2, live price +3. So a
// Casey's WITH a price (2+3=5) outranked a Pilot WITHOUT one (2+2=4), and the
// result cap then dropped the real truck stops entirely. The +1000 makes the
// ordering unambiguous — price and distance only ever break ties WITHIN a tier.
function rankScore(primaryType, brand, dieselType) {
	let score = 0;
	if (isTruckCapable(primaryType, brand, dieselType)) score += 1000;
	if (String(primaryType || "").toLowerCase() === "truck_stop") score += 4;
	if (TRUCK_STOP_BRANDS.some((b) => b.brand === brand)) score += 2;
	return score;
}

// Sample 4–8 evenly-spaced points along the straight line origin→dest
// (inclusive of both endpoints). Linear lat/lng interpolation — a cheap
// straight-line approximation of the route, per the contract.
function sampleWaypoints(origin, dest) {
	const spanMiles = distanceMeters(origin, dest) / METERS_PER_MILE;
	const n = Math.min(
		MAX_WAYPOINTS,
		Math.max(MIN_WAYPOINTS, Math.ceil(spanMiles / MILES_PER_WAYPOINT)),
	);
	const pts = [];
	for (let i = 0; i < n; i++) {
		const t = n === 1 ? 0 : i / (n - 1);
		pts.push({
			lat: origin.lat + (dest.lat - origin.lat) * t,
			lng: origin.lng + (dest.lng - origin.lng) * t,
		});
	}
	return pts;
}

// Normalize a polyline vertex to { lat, lng }, accepting either { lat, lng } or
// { latitude, longitude } (server.js's getRoute() returns the latter). Returns
// null for a vertex with non-finite coords so callers can filter it out.
function normalizePathPoint(p) {
	if (!p || typeof p !== "object") return null;
	const lat = toNum(p.lat != null ? p.lat : p.latitude);
	const lng = toNum(p.lng != null ? p.lng : p.longitude);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	return { lat, lng };
}

// Sample 4–8 waypoints spaced evenly BY CUMULATIVE DISTANCE along an actual
// route polyline, so each Places search circle sits on the road instead of on
// the straight line between endpoints (the reason stops used to land off-
// highway). `path` must be an array of already-normalized { lat, lng } vertices,
// length >= 2. Waypoint count matches sampleWaypoints() (~1 per 75 route miles,
// clamped to [4,8]); each point is linearly interpolated along the segment that
// spans its target distance, so spacing stays even even when vertices are not.
function sampleWaypointsAlongPath(path) {
	if (!Array.isArray(path) || path.length < 2) return Array.isArray(path) ? path.slice() : [];

	// Cumulative distance (meters) at each vertex.
	const cum = [0];
	for (let i = 1; i < path.length; i++) {
		cum.push(cum[i - 1] + distanceMeters(path[i - 1], path[i]));
	}
	const totalM = cum[cum.length - 1];
	if (!(totalM > 0)) return [path[0]];

	const spanMiles = totalM / METERS_PER_MILE;
	const n = Math.min(
		MAX_WAYPOINTS,
		Math.max(MIN_WAYPOINTS, Math.ceil(spanMiles / MILES_PER_WAYPOINT)),
	);

	const waypoints = [];
	let j = 0;
	for (let i = 0; i < n; i++) {
		const target = (totalM * i) / (n - 1);          // n >= MIN_WAYPOINTS (4) → never /0
		while (j < cum.length - 2 && cum[j + 1] < target) j++;
		const segLen = cum[j + 1] - cum[j];
		const frac = segLen > 0 ? (target - cum[j]) / segLen : 0;
		const a = path[j], b = path[j + 1];
		waypoints.push({
			lat: a.lat + (b.lat - a.lat) * frac,
			lng: a.lng + (b.lng - a.lng) * frac,
		});
	}
	return waypoints;
}

// One Places (New) searchNearby around a single waypoint. Retries 5xx/429 with
// exponential backoff; fails fast on other 4xx (bad key/quota/validation).
// Resolves to the raw `places` array (possibly empty).
async function searchNearbyAt(doFetch, apiKey, center, maxResultCount) {
	const body = {
		includedTypes: ["truck_stop", "gas_station"],
		maxResultCount,
		locationRestriction: {
			circle: {
				center: { latitude: center.lat, longitude: center.lng },
				radius: SEARCH_RADIUS_M,
			},
		},
	};
	let lastErr = null;
	for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
		try {
			const resp = await doFetch(PLACES_SEARCH_NEARBY_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Goog-Api-Key": apiKey,
					"X-Goog-FieldMask": FIELD_MASK,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!resp.ok) {
				const text = await resp.text().catch(() => "");
				const err = new Error(`Places searchNearby ${resp.status}: ${String(text).slice(0, 200)}`);
				err.status = resp.status;
				if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) throw err;
				lastErr = err;
				await sleep(500 * Math.pow(2, attempt));
				continue;
			}
			const data = await resp.json().catch(() => ({}));
			return Array.isArray(data && data.places) ? data.places : [];
		} catch (err) {
			lastErr = err;
			if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
			await sleep(500 * Math.pow(2, attempt));
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastErr || new Error("Places searchNearby failed");
}

/**
 * Find diesel truck stops / fuel stations along a route.
 *
 * @param {object} opts
 * @param {number|string} opts.originLat
 * @param {number|string} opts.originLng
 * @param {number|string} opts.destLat
 * @param {number|string} opts.destLng
 * @param {string}   opts.apiKey     Google Maps API key (GOOGLE_MAPS_API_KEY). Required.
 * @param {function} [opts.fetchImpl] Injected fetch (defaults to global fetch).
 * @param {number}   [opts.limit=12] Max stops returned.
 * @param {Array<{lat:number,lng:number}|{latitude:number,longitude:number}>} [opts.routePath]
 *        Optional decoded road polyline (e.g. server.js getRoute().points). When
 *        it has >= 2 usable vertices, waypoints are sampled ALONG it and
 *        aboutMilesFromRoute is measured to the nearest vertex (a tight "on
 *        route" figure); otherwise the function falls back to straight-line
 *        sampling between origin and dest.
 * @returns {Promise<Array<{name,brand,lat,lng,address,placeId,aboutMilesFromRoute}>>}
 *
 * Throws typed errors: `POI_BAD_COORDS` (non-finite coords), `POI_NO_KEY`
 * (missing apiKey), `POI_NO_FETCH` (no fetch available). A single waypoint's
 * network failure degrades to [] and never sinks the whole request; if every
 * waypoint fails the result is simply an empty array.
 */
async function findFuelStopsAlongRoute(opts = {}) {
	const { originLat, originLng, destLat, destLng, apiKey, fetchImpl, limit = 12 } = opts;

	const origin = { lat: toNum(originLat), lng: toNum(originLng) };
	const dest = { lat: toNum(destLat), lng: toNum(destLng) };
	if (![origin.lat, origin.lng, dest.lat, dest.lng].every((n) => Number.isFinite(n))) {
		const err = new Error("findFuelStopsAlongRoute requires finite origin/dest coordinates");
		err.code = "POI_BAD_COORDS";
		throw err;
	}
	if (!apiKey) {
		const err = new Error("Google Maps API key not configured");
		err.code = "POI_NO_KEY";
		throw err;
	}
	const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
	if (typeof doFetch !== "function") {
		const err = new Error("No fetch implementation available");
		err.code = "POI_NO_FETCH";
		throw err;
	}

	const cap = Number.isFinite(+limit) && +limit > 0 ? Math.floor(+limit) : 12;

	// Prefer sampling along the real driving polyline when the caller supplies it
	// (route-path mode) so the search circles — and the "on route" distance below
	// — track the highway, not the straight line. Accept both { lat, lng } and
	// { latitude, longitude } vertices; fall back to straight-line sampling when
	// no usable path is given.
	const routePath = Array.isArray(opts.routePath)
		? opts.routePath.map(normalizePathPoint).filter(Boolean)
		: [];
	const useRoutePath = routePath.length >= 2;
	const waypoints = useRoutePath ? sampleWaypointsAlongPath(routePath) : sampleWaypoints(origin, dest);
	const perWaypoint = Math.min(MAX_RESULTS_PER_WAYPOINT, Math.max(5, cap));

	// Independent per-waypoint searches. A single waypoint failure degrades to
	// [] rather than rejecting the whole batch (partial results > none).
	const batches = await Promise.all(
		waypoints.map((wp) => searchNearbyAt(doFetch, apiKey, wp, perWaypoint).catch(() => [])),
	);

	// Dedupe by placeId (a stop can surface from several overlapping circles).
	const byId = new Map();
	for (const places of batches) {
		for (const p of places) {
			const placeId = p && p.id ? String(p.id) : "";
			const lat = p && p.location ? p.location.latitude : undefined;
			const lng = p && p.location ? p.location.longitude : undefined;
			if (!placeId || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
			if (byId.has(placeId)) continue;
			const name = (p.displayName && p.displayName.text) ? p.displayName.text : "";
			byId.set(placeId, {
				name,
				brand: deriveBrand(name),
				lat,
				lng,
				address: p.formattedAddress || "",
				placeId,
				primaryType: p.primaryType || "",
				diesel: extractDiesel(p.fuelOptions),
			});
		}
	}

	// aboutMilesFromRoute = distance to the nearest point of the route. In route-
	// path mode that's the nearest actual polyline vertex (a tight "on route"
	// measure); otherwise it's the nearest straight-line sampled waypoint (the
	// original coarse approximation).
	const measurePoints = useRoutePath ? routePath : waypoints;
	const ranked = [];
	for (const s of byId.values()) {
		let nearestM = Infinity;
		for (const mp of measurePoints) {
			const d = distanceMeters(s, mp);
			if (d < nearestM) nearestM = d;
		}
		ranked.push({
			stop: {
				name: s.name,
				brand: s.brand,
				lat: s.lat,
				lng: s.lng,
				address: s.address,
				placeId: s.placeId,
				aboutMilesFromRoute: Math.round((nearestM / METERS_PER_MILE) * 10) / 10,
				// Live per-station diesel pump price (null when Google has no data
				// for this station). The endpoint uses this for the true-cheapest
				// ranking and falls back to the regional average when it is null.
				dieselPrice: s.diesel ? s.diesel.price : null,
				dieselType: s.diesel ? s.diesel.type : null,
				dieselPriceUpdated: s.diesel ? s.diesel.updated : null,
				// Surfaced so the UI can say so, and so a caller can refuse to route
				// a truck to a forecourt it cannot enter.
				truckFriendly: isTruckCapable(s.primaryType, s.brand, s.diesel && s.diesel.type),
			},
			// A live price is still worth a nudge so a priced stop is not dropped by
			// the cap in favour of an unpriced one — but only WITHIN its tier.
			score: rankScore(s.primaryType, s.brand, s.diesel && s.diesel.type) + (s.diesel ? 3 : 0),
		});
	}

	// Truck-capable first (hard tier), then nearest-to-route, then cap.
	ranked.sort((a, b) => (b.score - a.score) || (a.stop.aboutMilesFromRoute - b.stop.aboutMilesFromRoute));

	// ⚠️ RETURN TRUCK STOPS ONLY — but never return NOTHING.
	//
	// The owner's ask is "truck stops where the truck can fit, not just regular
	// gas stations". Filtering hard is right until the lane genuinely has none:
	// an empty panel on a rural stretch is worse than a flagged car station,
	// because the driver then has no information at all. So fall back to the rest
	// only when no truck-capable stop was found; each carries truckFriendly:false
	// so the UI can warn rather than imply it is fine to pull in.
	const truckOnly = ranked.filter((r) => r.stop.truckFriendly);
	const chosen = truckOnly.length ? truckOnly : ranked;

	return chosen.slice(0, cap).map((r) => r.stop);
}

module.exports = {
	findFuelStopsAlongRoute,
	deriveBrand,
	extractDiesel,
	sampleWaypoints,
	sampleWaypointsAlongPath,
	DIESEL_BRANDS,
	TRUCK_STOP_BRANDS,
	CAR_ORIENTED_BRANDS,
	isTruckCapable,
};
