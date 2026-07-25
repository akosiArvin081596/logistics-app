// Fuel range + MPG math — pure module (no network, no DB, no requires).
//
// Powers GET /api/fuel/range. server.js owns the endpoint, role gate, and the
// SQLite reads (latest telemetry row + trucks.fuel_tank_gallons/avg_mpg); this
// file is only the math so it can be reasoned about / unit-tested in isolation,
// same split as lib/linxup-push.js.
//
// Data shape (from prod `routemate_telemetry`): each row has `odometer` (miles,
// REAL/int), `fuel_pct` (0–100 INTEGER, nullable), `location_date_ms` (epoch ms).
// Real-world facts this encodes:
//   - Class-8 sleeper tanks run ~120–300 gal (default 200).
//   - Heavy trucks average ~5.5–7 MPG (default 6.5).
//   - One older device in the fleet reports fuel_pct = 0 for EVERY row — it has
//     no fuel sensor. That must NOT be read as "empty tank" (see hasFuelSensor).

"use strict";

// --- Defaults (exported; 0/unset on a truck row falls back to these) ---
const DEFAULT_TANK_GALLONS = 200; // typical Class-8 sleeper tank
const DEFAULT_MPG = 6.5;          // typical loaded heavy-truck fuel economy

// --- deriveMpg tuning (commented so the lead can tune against real data) ---
// Coarse integer fuel_pct makes tiny deltas noisy: a single 1% step on a 200-gal
// tank is 2 gal, i.e. ~13 mi of resolution. Require a real sample before trusting
// the ratio, and reject physically-implausible results as bad data.
const MIN_MPG_MILES = 15;      // need at least this many miles of travel
const MIN_MPG_GALLONS = 5;     // ...burning at least this many gallons
const MIN_PLAUSIBLE_MPG = 2.5; // below this = odometer/sensor glitch, not a truck
const MAX_PLAUSIBLE_MPG = 15;  // above this = glitch (empty bobtail tops out ~10)

// --- small numeric helpers (mirrors the num()/str() style in linxup-push.js) ---
function num(v) {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v === "string" && v.trim() !== "") {
		const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
		return Number.isFinite(n) ? n : null;
	}
	return null;
}
function isPos(n) { return n != null && n > 0; }
// Clamp a fuel reading into the valid 0–100 band; null stays null.
function clampPct(n) { return n == null ? null : Math.max(0, Math.min(100, n)); }
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

// computeRange({ fuelPct, tankGallons, mpg }) -> { gallonsRemaining, rangeMiles }
// Null-safe: a missing/invalid fuelPct yields nulls (we can't know the range
// without a live fuel reading). Missing tank/mpg fall back to the DEFAULTs so
// the function is usable standalone and never multiplies by null.
function computeRange({ fuelPct, tankGallons, mpg } = {}) {
	const pct = clampPct(num(fuelPct));
	const tank = isPos(num(tankGallons)) ? num(tankGallons) : DEFAULT_TANK_GALLONS;
	const milesPerGallon = isPos(num(mpg)) ? num(mpg) : DEFAULT_MPG;
	if (pct == null) return { gallonsRemaining: null, rangeMiles: null };
	const gallonsRemaining = round1(tank * (pct / 100));
	const rangeMiles = Math.round(gallonsRemaining * milesPerGallon);
	return { gallonsRemaining, rangeMiles };
}

// deriveMpg(rows, { tankGallons }) -> { mpg, source: 'eld' | 'default' }
// Derives fuel economy from telemetry odometer + fuel_pct deltas. Accepts rows
// newest-first OR oldest-first (we sort). Falls back to DEFAULT_MPG/'default'
// on refuels, zero/negative, tiny/noisy samples, or implausible results.
function deriveMpg(rows, opts = {}) {
	const fallback = { mpg: DEFAULT_MPG, source: "default" };
	if (!Array.isArray(rows) || rows.length < 2) return fallback;
	const tank = isPos(num(opts.tankGallons)) ? num(opts.tankGallons) : DEFAULT_TANK_GALLONS;

	// Clean to usable samples (need both an odometer and a fuel reading).
	const samples = rows
		.map((r) => ({
			odo: num(r && r.odometer),
			pct: clampPct(num(r && r.fuel_pct)),
			t: num(r && r.location_date_ms),
		}))
		.filter((s) => s.odo != null && s.pct != null);
	if (samples.length < 2) return fallback;

	// Order oldest -> newest. Prefer timestamps; otherwise sort by odometer,
	// which only ever increases over a truck's life and so is itself a reliable
	// time proxy. This is what lets us accept either input ordering.
	const haveTimes = samples.every((s) => s.t != null && s.t > 0)
		&& new Set(samples.map((s) => s.t)).size > 1;
	samples.sort((a, b) => (haveTimes ? a.t - b.t : a.odo - b.odo));

	// Accumulate miles + gallons ONLY across segments where fuel dropped and the
	// odometer advanced. A rising fuel% is a refuel, so that segment is skipped
	// and a tank top-up never charges its post-refuel miles against pre-refuel
	// fuel. Idle-only segments (odoDelta == 0) are skipped too.
	let miles = 0;
	let gallons = 0;
	for (let i = 1; i < samples.length; i++) {
		const prev = samples[i - 1];
		const cur = samples[i];
		const odoDelta = cur.odo - prev.odo;
		const pctDrop = prev.pct - cur.pct;
		if (odoDelta > 0 && pctDrop > 0) {
			miles += odoDelta;
			gallons += tank * (pctDrop / 100);
		}
	}

	if (miles < MIN_MPG_MILES || gallons < MIN_MPG_GALLONS) return fallback;
	const mpg = miles / gallons;
	if (mpg < MIN_PLAUSIBLE_MPG || mpg > MAX_PLAUSIBLE_MPG) return fallback;
	return { mpg: round2(mpg), source: "eld" };
}

// hasFuelSensor(recentFuelPcts) -> bool
// Distinguishes "device has no fuel sensor" from "tank is genuinely low/empty".
// A working sensor shows a positive reading somewhere in the recent window (you
// don't teleport to 0%); the no-sensor device reports 0 (or null) for EVERY row.
// So: any recent reading > 0 -> sensor present; all null/0 -> no sensor.
function hasFuelSensor(recentFuelPcts) {
	if (!Array.isArray(recentFuelPcts)) return false;
	// Keep only valid in-band readings; null/undefined/NaN and out-of-range drop.
	const readings = recentFuelPcts
		.map((v) => clampPct(num(v)))
		.filter((n) => n != null);
	if (readings.length === 0) return false; // nothing reported -> treat as no sensor
	// Any positive reading (equivalently: any variation above 0) means the sensor
	// is live. An all-zero window is the no-sensor signature, not an empty tank.
	return readings.some((n) => n > 0);
}

// estimateRangeForVehicle({ fuelPct, tankGallons, avgMpg, telemetryRows })
// -> the GET /api/fuel/range payload MINUS identity fields, i.e.
//    { hasFuelData, fuelPct, tankGallons, gallonsRemaining, mpg, mpgSource, rangeMiles }
// The server adds ok/driver/vehicleId/unit/updatedAt around this.
//   - fuelPct: the current/latest live reading (server passes it in).
//   - telemetryRows: recent `routemate_telemetry` rows for MPG derivation +
//     sensor detection (order-agnostic).
//   - avgMpg: the truck's configured trucks.avg_mpg (0/unset -> use DEFAULT_MPG);
//     used only when ELD-derived MPG isn't available, so it reports as 'default'.
function estimateRangeForVehicle({ fuelPct, tankGallons, avgMpg, telemetryRows } = {}) {
	const tank = isPos(num(tankGallons)) ? num(tankGallons) : DEFAULT_TANK_GALLONS;
	const rows = Array.isArray(telemetryRows) ? telemetryRows : [];

	// Sensor presence from the recent history plus the current reading.
	const recent = rows.map((r) => r && r.fuel_pct);
	recent.push(fuelPct);
	const sensor = hasFuelSensor(recent);
	const curPct = clampPct(num(fuelPct));
	const hasFuelData = sensor && curPct != null;

	// MPG: prefer live ELD-derived; else the truck's configured avg; else the
	// constant. Only ELD data is labeled 'eld' — everything else is 'default'.
	const derived = deriveMpg(rows, { tankGallons: tank });
	let mpg;
	let mpgSource;
	if (derived.source === "eld") {
		mpg = derived.mpg;
		mpgSource = "eld";
	} else if (isPos(num(avgMpg))) {
		mpg = round2(num(avgMpg));
		mpgSource = "default";
	} else {
		mpg = DEFAULT_MPG;
		mpgSource = "default";
	}

	if (!hasFuelData) {
		// No usable live fuel reading -> report mpg (a truck property) but no range.
		return {
			hasFuelData: false,
			fuelPct: null,
			tankGallons: tank,
			gallonsRemaining: null,
			mpg,
			mpgSource,
			rangeMiles: null,
		};
	}

	const { gallonsRemaining, rangeMiles } = computeRange({ fuelPct: curPct, tankGallons: tank, mpg });
	return {
		hasFuelData: true,
		fuelPct: curPct,
		tankGallons: tank,
		gallonsRemaining,
		mpg,
		mpgSource,
		rangeMiles,
	};
}

module.exports = {
	DEFAULT_TANK_GALLONS,
	DEFAULT_MPG,
	computeRange,
	deriveMpg,
	hasFuelSensor,
	estimateRangeForVehicle,
};
