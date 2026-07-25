"use strict";

// Diesel truck-stop / fuel-station finder along a route.
//
// Powers `GET /api/poi/fuel-stops`. Samples a handful of waypoints along the
// straight line from origin→dest and queries Google Places API (New)
// `places:searchNearby` around each, then dedupes by placeId and ranks
// truck-friendly diesel brands first.
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
const FIELD_MASK = "places.displayName,places.formattedAddress,places.location,places.id,places.primaryType";

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

// Diesel-friendly / truck-stop brands. Order matters: more specific first
// (e.g. "Pilot Flying J" / "Flying J" before bare "Pilot"). Matched
// case-insensitively as a substring of the place's display name. Patterns for
// TA/Petro are deliberately multi-word — a bare "ta"/"petro" substring would
// false-match unrelated names.
const DIESEL_BRANDS = [
	{ brand: "Pilot Flying J", patterns: ["pilot flying j"] },
	{ brand: "Flying J", patterns: ["flying j"] },
	{ brand: "Pilot", patterns: ["pilot travel", "pilot #", "pilot store"] },
	{ brand: "Love's", patterns: ["love's travel", "loves travel", "love's country", "love's #"] },
	{ brand: "TA", patterns: ["travelcenters of america", "ta travel", "ta petro", "ta express"] },
	{ brand: "Petro", patterns: ["petro stopping", "petro travel", "petro:"] },
	{ brand: "Sapp Bros", patterns: ["sapp bros", "sapp brothers"] },
	{ brand: "Kwik Trip", patterns: ["kwik trip", "kwik star"] },
	{ brand: "Casey's", patterns: ["casey's", "caseys general", "casey's general"] },
];

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

// Best-effort brand from a place display name; "" when nothing recognized.
function deriveBrand(name) {
	const lc = String(name || "").toLowerCase();
	if (!lc) return "";
	for (const { brand, patterns } of DIESEL_BRANDS) {
		if (patterns.some((p) => lc.includes(p))) return brand;
	}
	return "";
}

// Truck stops and known diesel brands rank ahead of generic gas stations.
function rankScore(primaryType, brand) {
	let score = 0;
	if (String(primaryType || "").toLowerCase() === "truck_stop") score += 2;
	if (brand) score += 2;
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
	const waypoints = sampleWaypoints(origin, dest);
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
			});
		}
	}

	// aboutMilesFromRoute = distance to the NEAREST sampled waypoint (cheap
	// approximation of "distance off the route line").
	const ranked = [];
	for (const s of byId.values()) {
		let nearestM = Infinity;
		for (const wp of waypoints) {
			const d = distanceMeters(s, wp);
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
			},
			score: rankScore(s.primaryType, s.brand),
		});
	}

	// Truck stops + known diesel brands first, then nearest-to-route, then cap.
	ranked.sort((a, b) => (b.score - a.score) || (a.stop.aboutMilesFromRoute - b.stop.aboutMilesFromRoute));

	return ranked.slice(0, cap).map((r) => r.stop);
}

module.exports = {
	findFuelStopsAlongRoute,
	deriveBrand,
	sampleWaypoints,
	DIESEL_BRANDS,
};
