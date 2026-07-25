// US regional diesel price provider.
//
// The client picked "regional average" pricing (free), so this ships IMMEDIATELY
// with a sensible national baseline even with no API key, and upgrades to live
// data when a key is present — the same "ships dormant behind an env flag" pattern
// as Routemate / Linxup / ScanKit / Gemini elsewhere in this app.
//
// Live source: EIA (US Energy Information Administration) Open Data API v2 —
// weekly No. 2 Diesel (On-Highway) retail price, "Retail Sales by All Sellers",
// broken out by PADD region. Gated behind env EIA_API_KEY (free key from
// https://www.eia.gov/opendata/). When the key is unset OR the call fails/times
// out, we return a clearly-marked FALLBACK national average with source:'fallback'.
//
// EIA v2 endpoint + series (confirmed via the EIA API browser — the diesel series
// family is `EMD_EPD2D_PTE_<AREA>_DPG` on the petroleum/pri/gnd route):
//   GET https://api.eia.gov/v2/petroleum/pri/gnd/data/
//       ?api_key=<KEY>&frequency=weekly&data[0]=value
//       &facets[series][]=EMD_EPD2D_PTE_R20_DPG      (R20 = PADD 2 Midwest, etc.)
//       &sort[0][column]=period&sort[0][direction]=desc&offset=0&length=1
//   -> response.data[0].value  ($/gal, string or number)
//   -> response.data[0].period (YYYY-MM-DD, the week the price is "as of")
//   EMD = No.2 Diesel retail series prefix · EPD2D = product · PTE = retail sales
//   by all sellers · <AREA> = duoarea (NUS national, R10..R50 = PADD 1..5) · DPG = $/gal.
//
// Everything is dependency-injected ({ db, fetchImpl, apiKey }) so this module
// self-tests fully offline. NEVER log or hardcode a real key — EIA_API_KEY comes
// from env (or an injected apiKey for tests) and only ever travels in the query
// string; it is never included in any thrown message or log line.
"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// EDITABLE BASELINE. National average No.2 diesel ($/gal) returned when EIA is
// unconfigured or unreachable. Bump this by hand whenever the real national
// average drifts materially — it is the floor the feature ships on, not a guess
// that gets silently stale behind a broken API. ~US average, mid-2026.
const FALLBACK_NATIONAL_AVG_USD_PER_GAL = 3.70;

const EIA_BASE_URL = "https://api.eia.gov/v2/petroleum/pri/gnd/data/";
const DEFAULT_TIMEOUT_MS = 15000; // mirrors lib/routemate-client.js
const DEFAULT_RETRIES = 2;        // mirrors routemate / runRateConGemini
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // ~24h — EIA diesel updates weekly

// Sanity bounds — anything outside this band is treated as a bad read and we
// fall back rather than surface a nonsense price ($1.50–$10 covers all history).
const MIN_SANE_PRICE = 1.0;
const MAX_SANE_PRICE = 12.0;

// PADD region descriptors. `series` is the EIA v2 series facet for that region's
// weekly diesel retail price; `label` is what we surface to the UI + cache key.
const NATIONAL_REGION = {
	padd: 0, code: "NUS", series: "EMD_EPD2D_PTE_NUS_DPG", label: "U.S. National Average",
};
const PADD_REGIONS = {
	1: { padd: 1, code: "R10", series: "EMD_EPD2D_PTE_R10_DPG", label: "PADD 1 (East Coast)" },
	2: { padd: 2, code: "R20", series: "EMD_EPD2D_PTE_R20_DPG", label: "PADD 2 (Midwest)" },
	3: { padd: 3, code: "R30", series: "EMD_EPD2D_PTE_R30_DPG", label: "PADD 3 (Gulf Coast)" },
	4: { padd: 4, code: "R40", series: "EMD_EPD2D_PTE_R40_DPG", label: "PADD 4 (Rocky Mountain)" },
	5: { padd: 5, code: "R50", series: "EMD_EPD2D_PTE_R50_DPG", label: "PADD 5 (West Coast)" },
};

// State bounding boxes tagged with their PADD. Box data mirrors lib/ifta-states.js
// (kept local so this module stays standalone + offline-testable); boxes overlap
// at borders on purpose — first match wins, ordered by likely freight usage.
// PADD assignment follows the EIA definitions: 1 East, 2 Midwest, 3 Gulf,
// 4 Rockies, 5 West. Approximate by design — a border misclassification costs a
// few cents on a *regional average*, which is all this feeds.
const STATE_PADD_BOUNDS = [
	{ name: "TX", padd: 3, minLat: 25.84, maxLat: 36.5, minLng: -106.65, maxLng: -93.51 },
	{ name: "OK", padd: 2, minLat: 33.62, maxLat: 37.0, minLng: -103.0, maxLng: -94.43 },
	{ name: "LA", padd: 3, minLat: 28.93, maxLat: 33.02, minLng: -94.04, maxLng: -88.82 },
	{ name: "AR", padd: 3, minLat: 33.0, maxLat: 36.5, minLng: -94.62, maxLng: -89.64 },
	{ name: "NM", padd: 3, minLat: 31.33, maxLat: 37.0, minLng: -109.05, maxLng: -103.0 },
	{ name: "MS", padd: 3, minLat: 30.17, maxLat: 35.0, minLng: -91.66, maxLng: -88.1 },
	{ name: "AL", padd: 3, minLat: 30.22, maxLat: 35.01, minLng: -88.47, maxLng: -84.89 },
	{ name: "TN", padd: 2, minLat: 34.98, maxLat: 36.68, minLng: -90.31, maxLng: -81.65 },
	{ name: "GA", padd: 1, minLat: 30.36, maxLat: 35.0, minLng: -85.61, maxLng: -80.84 },
	{ name: "FL", padd: 1, minLat: 24.52, maxLat: 31.0, minLng: -87.63, maxLng: -80.03 },
	{ name: "MO", padd: 2, minLat: 35.99, maxLat: 40.61, minLng: -95.77, maxLng: -89.1 },
	{ name: "KS", padd: 2, minLat: 36.99, maxLat: 40.0, minLng: -102.05, maxLng: -94.59 },
	{ name: "CO", padd: 4, minLat: 36.99, maxLat: 41.0, minLng: -109.05, maxLng: -102.04 },
	{ name: "AZ", padd: 5, minLat: 31.33, maxLat: 37.0, minLng: -114.82, maxLng: -109.04 },
	{ name: "CA", padd: 5, minLat: 32.53, maxLat: 42.01, minLng: -124.41, maxLng: -114.13 },
	{ name: "NV", padd: 5, minLat: 35.0, maxLat: 42.0, minLng: -120.01, maxLng: -114.04 },
	{ name: "IL", padd: 2, minLat: 36.97, maxLat: 42.51, minLng: -91.51, maxLng: -87.02 },
	{ name: "IN", padd: 2, minLat: 37.77, maxLat: 41.76, minLng: -88.1, maxLng: -84.78 },
	{ name: "OH", padd: 2, minLat: 38.4, maxLat: 42.33, minLng: -84.82, maxLng: -80.52 },
	{ name: "PA", padd: 1, minLat: 39.72, maxLat: 42.27, minLng: -80.52, maxLng: -74.69 },
	{ name: "NY", padd: 1, minLat: 40.5, maxLat: 45.01, minLng: -79.76, maxLng: -71.86 },
	{ name: "NC", padd: 1, minLat: 33.84, maxLat: 36.59, minLng: -84.32, maxLng: -75.46 },
	{ name: "SC", padd: 1, minLat: 32.03, maxLat: 35.22, minLng: -83.35, maxLng: -78.54 },
	{ name: "VA", padd: 1, minLat: 36.54, maxLat: 39.47, minLng: -83.68, maxLng: -75.24 },
	{ name: "WA", padd: 5, minLat: 45.54, maxLat: 49.0, minLng: -124.85, maxLng: -116.92 },
	{ name: "OR", padd: 5, minLat: 41.99, maxLat: 46.29, minLng: -124.57, maxLng: -116.46 },
	{ name: "ID", padd: 4, minLat: 41.99, maxLat: 49.0, minLng: -117.24, maxLng: -111.04 },
	{ name: "MT", padd: 4, minLat: 44.36, maxLat: 49.0, minLng: -116.05, maxLng: -104.04 },
	{ name: "WY", padd: 4, minLat: 40.99, maxLat: 45.01, minLng: -111.06, maxLng: -104.05 },
	{ name: "UT", padd: 4, minLat: 36.99, maxLat: 42.0, minLng: -114.05, maxLng: -109.04 },
	{ name: "ND", padd: 2, minLat: 45.94, maxLat: 49.0, minLng: -104.05, maxLng: -96.55 },
	{ name: "SD", padd: 2, minLat: 42.48, maxLat: 45.95, minLng: -104.06, maxLng: -96.44 },
	{ name: "NE", padd: 2, minLat: 39.99, maxLat: 43.0, minLng: -104.05, maxLng: -95.31 },
	{ name: "IA", padd: 2, minLat: 40.37, maxLat: 43.5, minLng: -96.64, maxLng: -90.14 },
	{ name: "MN", padd: 2, minLat: 43.5, maxLat: 49.38, minLng: -97.24, maxLng: -89.49 },
	{ name: "WI", padd: 2, minLat: 42.49, maxLat: 47.08, minLng: -92.89, maxLng: -86.25 },
	{ name: "MI", padd: 2, minLat: 41.7, maxLat: 48.31, minLng: -90.42, maxLng: -82.12 },
	{ name: "KY", padd: 2, minLat: 36.5, maxLat: 39.15, minLng: -89.57, maxLng: -81.96 },
	{ name: "WV", padd: 1, minLat: 37.2, maxLat: 40.64, minLng: -82.64, maxLng: -77.72 },
	{ name: "MD", padd: 1, minLat: 37.91, maxLat: 39.72, minLng: -79.49, maxLng: -75.05 },
	{ name: "DE", padd: 1, minLat: 38.45, maxLat: 39.84, minLng: -75.79, maxLng: -75.05 },
	{ name: "NJ", padd: 1, minLat: 38.93, maxLat: 41.36, minLng: -75.56, maxLng: -73.89 },
	{ name: "CT", padd: 1, minLat: 40.98, maxLat: 42.05, minLng: -73.73, maxLng: -71.79 },
	{ name: "RI", padd: 1, minLat: 41.15, maxLat: 42.02, minLng: -71.86, maxLng: -71.12 },
	{ name: "MA", padd: 1, minLat: 41.24, maxLat: 42.89, minLng: -73.51, maxLng: -69.93 },
	{ name: "VT", padd: 1, minLat: 42.73, maxLat: 45.02, minLng: -73.44, maxLng: -71.47 },
	{ name: "NH", padd: 1, minLat: 42.7, maxLat: 45.31, minLng: -72.56, maxLng: -70.7 },
	{ name: "ME", padd: 1, minLat: 43.06, maxLat: 47.46, minLng: -71.08, maxLng: -66.95 },
	{ name: "HI", padd: 5, minLat: 18.91, maxLat: 22.24, minLng: -160.25, maxLng: -154.81 },
	{ name: "AK", padd: 5, minLat: 51.21, maxLat: 71.39, minLng: -179.15, maxLng: -129.98 },
	{ name: "DC", padd: 1, minLat: 38.79, maxLat: 38.99, minLng: -77.12, maxLng: -76.91 },
];

// ---------------------------------------------------------------------------
// Region resolution
// ---------------------------------------------------------------------------

// Resolve a lat/lng to its PADD region descriptor. Non-finite / non-US points
// fall back to the national descriptor so we always have a price to serve.
function resolvePaddRegion(lat, lng) {
	const la = Number(lat);
	const ln = Number(lng);
	if (!Number.isFinite(la) || !Number.isFinite(ln)) return NATIONAL_REGION;
	for (const s of STATE_PADD_BOUNDS) {
		if (la >= s.minLat && la <= s.maxLat && ln >= s.minLng && ln <= s.maxLng) {
			return PADD_REGIONS[s.padd] || NATIONAL_REGION;
		}
	}
	return NATIONAL_REGION;
}

// Public: PADD region label for a coordinate (e.g. "PADD 2 (Midwest)").
function paddRegionForLatLng(lat, lng) {
	return resolvePaddRegion(lat, lng).label;
}

// ---------------------------------------------------------------------------
// Cache (fuel_price_cache) — only touched when a db handle is injected
// ---------------------------------------------------------------------------

function ensureCacheTable(db) {
	db.exec(`CREATE TABLE IF NOT EXISTS fuel_price_cache (
		region TEXT PRIMARY KEY,
		price REAL,
		source TEXT,
		as_of TEXT,
		fetched_at TEXT
	)`);
}

// Return a fresh (< TTL) cached EIA row for the region, or null. Best-effort:
// any DB error degrades to "no cache" rather than throwing.
function readCache(db, region) {
	try {
		ensureCacheTable(db);
		const row = db
			.prepare("SELECT region, price, source, as_of, fetched_at FROM fuel_price_cache WHERE region = ?")
			.get(region);
		if (!row || row.source !== "eia") return null;
		const fetchedMs = Date.parse(row.fetched_at);
		if (!Number.isFinite(fetchedMs) || Date.now() - fetchedMs > CACHE_TTL_MS) return null;
		if (!Number.isFinite(row.price)) return null;
		return row;
	} catch {
		return null;
	}
}

// Upsert a fresh EIA price for the region. We deliberately only cache live EIA
// results — never the fallback — so a transient outage or a just-added key is
// retried on the next call instead of being pinned for 24h.
function writeCache(db, { region, price, source, asOf }) {
	try {
		ensureCacheTable(db);
		db.prepare(
			`INSERT INTO fuel_price_cache (region, price, source, as_of, fetched_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(region) DO UPDATE SET
			   price = excluded.price,
			   source = excluded.source,
			   as_of = excluded.as_of,
			   fetched_at = excluded.fetched_at`
		).run(region, price, source, asOf, new Date().toISOString());
	} catch {
		/* cache is best-effort — a write failure must never break the price path */
	}
}

// ---------------------------------------------------------------------------
// EIA fetch — AbortController timeout + 2-retry exp backoff (routemate pattern)
// ---------------------------------------------------------------------------

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function round2(n) {
	return Math.round(n * 100) / 100;
}

// EIA weekly periods are bare dates ("YYYY-MM-DD"); coerce to an ISO instant.
function periodToIso(period) {
	if (!period || typeof period !== "string") return new Date().toISOString();
	const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(period) ? `${period}T00:00:00Z` : period);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

// Hit EIA for the latest weekly diesel price of a single series. Resolves to
// { pricePerGallon, asOf } or throws after retries. The api_key rides only in
// the query string and is never placed into a thrown message.
async function fetchEiaDieselPrice({ series, apiKey, fetchImpl }) {
	const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
	if (!doFetch) throw new Error("no fetch implementation available");

	// URLSearchParams percent-encodes the [] in data[0]/facets[series][]/sort[0];
	// EIA decodes them server-side, so this is the correct v2 query form.
	const params = new URLSearchParams();
	params.set("api_key", apiKey);
	params.set("frequency", "weekly");
	params.append("data[0]", "value");
	params.append("facets[series][]", series);
	params.append("sort[0][column]", "period");
	params.append("sort[0][direction]", "desc");
	params.set("offset", "0");
	params.set("length", "1");
	const url = `${EIA_BASE_URL}?${params.toString()}`;

	let lastErr = null;
	for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
		try {
			const resp = await doFetch(url, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: controller.signal,
			});
			if (!resp.ok) {
				const text = await resp.text().catch(() => "");
				const err = new Error(`EIA ${resp.status}: ${String(text).slice(0, 120)}`);
				err.status = resp.status;
				// Don't retry 4xx (bad/missing key, bad series) — fail fast to fallback.
				if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) throw err;
				lastErr = err;
				await sleep(500 * Math.pow(2, attempt));
				continue;
			}
			const data = await resp.json();
			const row =
				data && data.response && Array.isArray(data.response.data) ? data.response.data[0] : null;
			if (!row) throw new Error("EIA returned no data rows");
			const price = typeof row.value === "number" ? row.value : parseFloat(row.value);
			if (!Number.isFinite(price) || price < MIN_SANE_PRICE || price > MAX_SANE_PRICE) {
				throw new Error(`EIA price out of sane range`);
			}
			return { pricePerGallon: round2(price), asOf: periodToIso(row.period) };
		} catch (err) {
			lastErr = err;
			// Propagate hard 4xx immediately; retry everything else (timeout, 5xx, parse).
			if (err && err.status && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
			if (attempt < DEFAULT_RETRIES) await sleep(500 * Math.pow(2, attempt));
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastErr || new Error("EIA request failed");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// getRegionalDieselPrice(lat, lng, { db, fetchImpl, apiKey })
//   -> { pricePerGallon, region, source: 'eia' | 'fallback', asOf: ISO }
//
// Order of operations: fresh cache (if db) -> live EIA (if key) -> fallback.
// NEVER throws — a price display must not 500 an endpoint. apiKey defaults to
// process.env.EIA_API_KEY (read-only) but can be injected for offline tests.
async function getRegionalDieselPrice(lat, lng, opts = {}) {
	const db = opts.db || null;
	const fetchImpl = opts.fetchImpl || null;
	const apiKey = (opts.apiKey !== undefined ? opts.apiKey : process.env.EIA_API_KEY) || "";

	const region = resolvePaddRegion(lat, lng);
	const fallback = () => ({
		pricePerGallon: FALLBACK_NATIONAL_AVG_USD_PER_GAL,
		region: region.label,
		source: "fallback",
		asOf: new Date().toISOString(),
	});

	// 1) Serve a fresh cached EIA read if we have one.
	if (db) {
		const cached = readCache(db, region.label);
		if (cached) {
			return {
				pricePerGallon: round2(cached.price),
				region: region.label,
				source: "eia",
				asOf: cached.as_of || new Date().toISOString(),
			};
		}
	}

	// 2) No key -> ship dormant on the fallback baseline.
	if (!apiKey) return fallback();

	// 3) Live EIA, with graceful degradation to the fallback on any failure.
	try {
		const { pricePerGallon, asOf } = await fetchEiaDieselPrice({
			series: region.series,
			apiKey,
			fetchImpl,
		});
		if (db) writeCache(db, { region: region.label, price: pricePerGallon, source: "eia", asOf });
		return { pricePerGallon, region: region.label, source: "eia", asOf };
	} catch {
		return fallback();
	}
}

module.exports = {
	paddRegionForLatLng,
	getRegionalDieselPrice,
	// Exposed for the lead / tests / UI labelling:
	resolvePaddRegion,
	FALLBACK_NATIONAL_AVG_USD_PER_GAL,
	PADD_REGIONS,
	NATIONAL_REGION,
};
