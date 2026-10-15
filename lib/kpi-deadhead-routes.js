"use strict";
// THE KPI JOB'S DEADHEAD ROUTE CALLS (R10): the Google route distance of each
// chained pair (lib/kpi-deadhead.js) whose rate con states no Empty Movement,
// cached by its two points in kpi_deadhead_routes.
//
//   ensureTables(db)
//   routesEnabled(value)   KPI_DEADHEAD_ROUTES_ENABLED: default OFF
//   readRoutes(db)         -> Map(pairKey -> { status, distanceMiles, checkedAt })
//   runRouteCalls({ db, pending, kind, enabled, replica, apiKey, fetchFn, day, timeZone, now, maxPerDay, timeoutMs })
//       -> { calls, ok, failed, skipped, codes }
//
// THE REQUEST. One small, distance-only Routes API call per pair: field mask
// routes.distanceMeters, no polyline, no alternatives, no traffic (the
// Essentials SKU), 0 retries, a short timeout, through the caller's `fetchFn`
// (server.js's fetch: in a replica it refuses every outbound call). Not
// getRoute(), which retries twice and caches polylines.
//
// WHEN. Nightly runs only (never a boot or manual run), never in replica mode
// (no request leaves and no row is written), never without the API key, and
// only while KPI_DEADHEAD_ROUTES_ENABLED is on (off by default: on in
// production only on the user's approval).
//
// THE CACHE. Keyed by the two points rounded to 4 decimals (about 11 m), never
// by load: a leg a dedicated lane repeats is called once for every load on it,
// and a corrected geocode is a new key. A failure is stored 'failed' and tried
// again after 30 days. Two points equal after rounding never reach here (0 mi,
// lib/kpi-deadhead.js).
//
// THE CAP. MAX_PER_DAY calls per business day (APP_TIMEZONE), counted from the
// rows checked that day, ok and failed alike: each pair's row is written
// 'failed' BEFORE its call, so a run that dies mid-call, or a second run the same
// day, adds none past the cap.
//
// Takes the database handle and fetch as arguments; no I/O of its own beyond
// them. Logs nothing (no key, no body). Requires lib/kpi-deadhead.js and
// lib/app-time.js, both pure.

const { samePoint, roundPoint } = require("./kpi-deadhead");
const { dayInZone } = require("./app-time");

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const FIELD_MASK = "routes.distanceMeters";
const MAX_PER_DAY = 50;
const TIMEOUT_MS = 8000;
const RETRY_MS = 30 * 24 * 60 * 60 * 1000;
const METERS_PER_MILE = 1609.344;

const ROUTES_TABLE_DDL = `
	CREATE TABLE IF NOT EXISTS kpi_deadhead_routes (
		pair_key TEXT PRIMARY KEY,
		distance_miles REAL,
		status TEXT NOT NULL,
		checked_at TEXT NOT NULL
	)
`;

function ensureTables(db) {
	db.exec(ROUTES_TABLE_DDL);
}

// The flag's shape: off unless it says true, 1, yes or on.
function routesEnabled(value) {
	return /^(true|1|yes|on)$/i.test(String(value == null ? "" : value).trim());
}

function readRoutes(db) {
	const out = new Map();
	for (const r of db.prepare("SELECT pair_key, distance_miles, status, checked_at FROM kpi_deadhead_routes").all()) {
		const miles = Number(r.distance_miles);
		out.set(String(r.pair_key), {
			status: String(r.status || ""),
			distanceMiles: r.distance_miles == null || !Number.isFinite(miles) ? null : miles,
			checkedAt: String(r.checked_at || ""),
		});
	}
	return out;
}

// A point as the request carries it: rounded the way the cache key is, so one
// call answers every load whose leg has that key.
function latLng(p) {
	const r = roundPoint(p.lat, p.lng);
	return { latitude: r.lat, longitude: r.lng };
}

// One pair's distance in miles, or null. Never throws.
async function oneDistance(fetchFn, apiKey, pair, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetchFn(ROUTES_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
			body: JSON.stringify({
				origin: { location: { latLng: latLng(pair.from) } },
				destination: { location: { latLng: latLng(pair.to) } },
				travelMode: "DRIVE",
			}),
			signal: controller.signal,
		});
		if (!resp || !resp.ok) return null;
		const data = await resp.json();
		const meters = data && Array.isArray(data.routes) && data.routes[0] ? Number(data.routes[0].distanceMeters) : NaN;
		return Number.isFinite(meters) && meters >= 0 ? Math.round((meters / METERS_PER_MILE) * 10) / 10 : null;
	} catch (_e) {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function runRouteCalls(args) {
	const a = args;
	const result = { calls: 0, ok: 0, failed: 0, skipped: null, codes: new Set() };
	if (a.kind !== "nightly") return { ...result, skipped: "not_nightly" };
	if (!a.enabled) return { ...result, skipped: "disabled" };
	if (a.replica) return { ...result, skipped: "replica" };
	if (!a.apiKey || typeof a.fetchFn !== "function") return { ...result, skipped: "no_key" };
	const db = a.db;
	const now = typeof a.now === "function" ? a.now : () => Date.now();
	const maxPerDay = Number.isFinite(a.maxPerDay) ? a.maxPerDay : MAX_PER_DAY;
	const timeoutMs = Number.isFinite(a.timeoutMs) && a.timeoutMs > 0 ? a.timeoutMs : TIMEOUT_MS;
	const nowMs = now();

	const cached = readRoutes(db);
	let checkedToday = 0;
	for (const r of cached.values()) {
		const ms = Date.parse(r.checkedAt);
		if (Number.isFinite(ms) && dayInZone(new Date(ms), a.timeZone) === a.day) checkedToday++;
	}
	let budget = Math.max(0, maxPerDay - checkedToday);

	const todo = new Map();
	for (const p of Array.isArray(a.pending) ? a.pending : []) {
		if (!p || !p.pairKey || !p.from || !p.to || todo.has(p.pairKey) || samePoint(p.from, p.to)) continue;
		if (!roundPoint(p.from.lat, p.from.lng) || !roundPoint(p.to.lat, p.to.lng)) continue;
		const row = cached.get(p.pairKey);
		if (row && row.status === "ok") continue;
		if (row && nowMs - Date.parse(row.checkedAt) < RETRY_MS) continue;
		todo.set(p.pairKey, p);
	}
	const mark = db.prepare(`
		INSERT INTO kpi_deadhead_routes (pair_key, distance_miles, status, checked_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(pair_key) DO UPDATE SET distance_miles = excluded.distance_miles, status = excluded.status, checked_at = excluded.checked_at
	`);
	for (const p of todo.values()) {
		if (budget <= 0) {
			result.codes.add("ROUTES_DAILY_CAP");
			break;
		}
		budget--;
		const at = new Date(now()).toISOString();
		mark.run(p.pairKey, null, "failed", at);
		result.calls++;
		const miles = await oneDistance(a.fetchFn, a.apiKey, p, timeoutMs);
		if (miles == null) {
			result.failed++;
			result.codes.add("ROUTES_CALL_FAILED");
			continue;
		}
		mark.run(p.pairKey, miles, "ok", at);
		result.ok++;
	}
	return result;
}

module.exports = {
	ROUTES_URL,
	FIELD_MASK,
	MAX_PER_DAY,
	TIMEOUT_MS,
	RETRY_MS,
	ensureTables,
	routesEnabled,
	readRoutes,
	runRouteCalls,
};
