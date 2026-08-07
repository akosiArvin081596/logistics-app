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

// --- Refuel-episode detection tuning (measured against prod telemetry) ---
// A real fill is a STAIRCASE, not a step: the 2026-08-04 fill on #2372 climbed
// 0 → 10 → 26 → 44 → 63 → 82 → 92 → 94 across 7 consecutive fixes in 4m38s with
// the odometer frozen at 992938. Counting rises would call that seven refuels;
// it is one, of +94 points. So consecutive rises are COALESCED into one episode.
//
// MIN_STEP is what may *open* an episode. It exists to set `pct_before`
// correctly, not to filter: the same truck logged a 1 → 2 flicker seven minutes
// before that fill, and letting a +1 open the episode would have started it at
// 1 and reported +93. A pump moves the needle several points per fix; a +1 or
// +2 between fixes is sender noise.
//
// Once open, an episode is extended only by a NEW HIGH. That is deliberately not
// "any positive delta": after the tank settled at 94 the sender flickered
// 81 → 82 → 81 → 82 for another twenty minutes, and extending on any rise would
// have ratcheted the episode's end time forward indefinitely on noise that never
// went near the peak. New-high-only makes the end timestamp the moment the tank
// actually stopped filling, and is monotone so it cannot loop.
//
// COALESCE_MS is used for BOTH ends of an episode, and that is deliberate. It
// closes an open episode (no new high for this long = the pump stopped), and it
// also bounds how far apart the two samples that OPEN one may be. Without the
// second use a rise is treated as a fill no matter how much silence precedes it,
// so a sender dropout plus a telemetry outage manufactures a fill out of nothing:
// #2372 read 0% parked on 07/21, went 9,124 minutes with no samples at all, came
// back at 31% — and that was persisted as a 6.3-day "refuel" of 0 -> 32 on a
// truck whose odometer never moved (odo_span 0). Twelve such episodes were longer
// than an hour; a pump takes minutes.
//
// One window for both ends because it is one physical property: the longest
// silence that can sit INSIDE a single continuous fill. Measured on the 73
// receipt-confirmed fills in prod, the gap between the two samples that open an
// episode runs p50 1.0 min, p90 2.0 min, and tops out at exactly 900,000 ms —
// the constant itself. So 15 minutes is the knee, not a round number: at 10 min
// the guard would discard 3 confirmed fills, and every value above 15 only
// re-admits phantoms. The comparison must be STRICTLY greater for the same
// reason — that ceiling sample is a real fill sitting exactly on the boundary.
// (Ordinary poll cadence is p99 2.5 min, so requiring adjacency costs nothing:
// only 598 of 125,219 gaps in the feed exceed the window at all.)
const REFUEL_MIN_STEP_PCT = 3;              // a rise this big may OPEN an episode
const REFUEL_COALESCE_MS = 15 * 60 * 1000;  // max silence inside one episode — see above
const REFUEL_MIN_RISE_PCT = 5;              // total rise below this is slosh, not a fill

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
//    { hasFuelData, fuelPct, tankGallons, tankSource, gallonsRemaining, mpg,
//      mpgSource, rangeMiles }
// The server adds ok/driver/vehicleId/unit/updatedAt around this.
//   - fuelPct: the current/latest live reading (server passes it in).
//   - telemetryRows: recent `routemate_telemetry` rows for MPG derivation +
//     sensor detection (order-agnostic).
//   - tankGallons: the truck's configured trucks.fuel_tank_gallons (0/unset ->
//     DEFAULT_TANK_GALLONS, reported as tankSource 'default').
//   - avgMpg: the truck's configured trucks.avg_mpg (0/unset -> use DEFAULT_MPG);
//     used only when ELD-derived MPG isn't available, so it reports as 'default'.
function estimateRangeForVehicle({ fuelPct, tankGallons, avgMpg, telemetryRows } = {}) {
	// Tank: the truck's configured fuel_tank_gallons, else the fleet constant.
	// tankSource says WHICH, because the number alone cannot tell a measured tank
	// from a guessed one — and that ambiguity has already shipped a wrong answer.
	// Two trucks with fuel_tank_gallons unset silently took the 200-gal default and
	// were shown ~2.5x their true range (#2372: 182 mi displayed vs 91 real on a
	// 100-gal tank; #302: 156 vs 62 on 80 gal), both at 12-14% fuel — i.e. the
	// number was most dangerous exactly when the driver most needed it. Nothing in
	// the payload said "this is an assumption", so nobody could catch it. Mirrors
	// mpgSource, which the UI already badges amber + warns on.
	// NOTE: 'default' means NOTHING WAS CONFIGURED — not "the value happens to be
	// 200". A truck genuinely configured at 200 gal reports 'truck'. That is why
	// the label picks the value below rather than being inferred from it: derive
	// the source by comparing tank === DEFAULT_TANK_GALLONS and you re-create the
	// exact silent-guess bug this field exists to kill.
	const cfgTank = num(tankGallons);
	const tankSource = isPos(cfgTank) ? "truck" : "default";
	const tank = tankSource === "truck" ? cfgTank : DEFAULT_TANK_GALLONS;
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
			tankSource,
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
		tankSource,
		gallonsRemaining,
		mpg,
		mpgSource,
		rangeMiles,
	};
}

// detectRefuelEvents(samples, opts) -> [{ startMs, endMs, pctBefore, pctAfter,
//   rise, odometer, latitude, longitude, odoSpan }]
//
// Finds the episodes where a truck's tank FILLED. Powers the fuel_events table.
//
// `samples` MUST already be deduplicated by timestamp and sorted oldest-first.
// That is the caller's job because it is a SQL concern, and it is not optional:
// routemateSyncTelemetry re-INSERTs the same fix on every poll with no dedupe,
// which runs at 13.1x duplication on #33 and 4.9x on #2372 — worst while the
// truck is stopped, i.e. exactly while it is refuelling. Feeding raw rows in
// makes every fill look like dozens of repeated readings.
// Each sample: { ms, pct, odo, lat, lng }.
//
// odoSpan (max-min odometer across the episode) is reported, not enforced: a
// genuine fill has the truck parked, so a large span is a signal the caller can
// use to distrust the episode — but a couple of miles of drift shows up in real
// fills (pulling forward off the pump) and hard-filtering on it loses them.
function detectRefuelEvents(samples, opts = {}) {
	const minStep = isPos(num(opts.minStepPct)) ? num(opts.minStepPct) : REFUEL_MIN_STEP_PCT;
	const coalesceMs = isPos(num(opts.coalesceMs)) ? num(opts.coalesceMs) : REFUEL_COALESCE_MS;
	const minRise = isPos(num(opts.minRisePct)) ? num(opts.minRisePct) : REFUEL_MIN_RISE_PCT;
	if (!Array.isArray(samples) || samples.length < 2) return [];

	const out = [];
	let open = null;
	const close = () => { if (open) { out.push(open); open = null; } };

	for (let i = 1; i < samples.length; i++) {
		const prev = samples[i - 1];
		const cur = samples[i];
		const pPct = clampPct(num(prev && prev.pct));
		const cPct = clampPct(num(cur && cur.pct));
		if (pPct == null || cPct == null) continue;
		const cMs = num(cur.ms);
		if (cMs == null) continue;

		// Episode ends once nothing has beaten the peak for the coalesce window.
		// Checked before the extend/seed branches so the same sample can close one
		// episode and open the next (two pumps in a row is a real pattern).
		if (open && cMs > open.peakMs + coalesceMs) close();

		if (!open) {
			// ADJACENCY. The coalesce window above can only END an episode, so
			// without this an episode could be OPENED across an arbitrary gap and a
			// dropout-then-outage would be read as a fill (see the REFUEL_* block).
			// A real fill is 6+ samples over ~4 minutes, so the two samples that open
			// one are necessarily close together — requiring that costs nothing.
			//
			// A fill that happens ENTIRELY inside a telemetry gap is now missed. That
			// is the correct direction to fail: the receipt still has no episode, so
			// it surfaces in the "receipt with no fill" queue, where a human sees a
			// real purchase we cannot place. The alternative fails the other way —
			// inventing a fill that never happened, which alerts on nothing AND
			// silently voids the tank-to-tank MPG legs that span it. A visible miss
			// beats an invented event.
			//
			// pMs is also required to be present: startMs is the upsert key
			// (routemate_vehicle_id, start_ms), and SQLite treats NULLs as distinct,
			// so a timestamp-less seed would insert a fresh duplicate on every sweep
			// instead of updating one row.
			const pMs = num(prev.ms);
			if (pMs == null || cMs - pMs > coalesceMs) continue;
			if (cPct - pPct >= minStep) {
				const pOdo = num(prev.odo) || 0;
				const cOdo = num(cur.odo) || 0;
				open = {
					// startMs is the last fix BEFORE the rise, so pctBefore is the
					// level the tank actually sat at — not the first rising reading.
					startMs: pMs, endMs: cMs, peakMs: cMs,
					pctBefore: pPct, pctAfter: cPct,
					odometer: cOdo, latitude: num(cur.lat), longitude: num(cur.lng),
					odoMin: Math.min(pOdo, cOdo), odoMax: Math.max(pOdo, cOdo),
				};
			}
			continue;
		}

		const cOdo = num(cur.odo) || 0;
		if (cOdo > 0) {
			open.odoMin = Math.min(open.odoMin, cOdo);
			open.odoMax = Math.max(open.odoMax, cOdo);
		}
		// NEW HIGH only — see the REFUEL_* comment block for why "any rise" ratchets.
		if (cPct > open.pctAfter) {
			open.pctAfter = cPct;
			open.peakMs = cMs;
			open.endMs = cMs;
			open.odometer = cOdo || open.odometer;
			open.latitude = num(cur.lat);
			open.longitude = num(cur.lng);
		}
	}
	close();

	return out
		.map((e) => ({
			startMs: e.startMs, endMs: e.endMs,
			pctBefore: e.pctBefore, pctAfter: e.pctAfter,
			rise: e.pctAfter - e.pctBefore,
			odometer: e.odometer, latitude: e.latitude, longitude: e.longitude,
			odoSpan: Math.max(0, e.odoMax - e.odoMin),
		}))
		.filter((e) => e.rise >= minRise);
}

// percentile(sorted, p) — linear interpolation, p in [0,1]. Internal.
function percentile(sortedAsc, p) {
	if (!sortedAsc.length) return null;
	const i = (sortedAsc.length - 1) * p;
	const lo = Math.floor(i), hi = Math.ceil(i);
	return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (i - lo);
}

// summarizeCalibration(values) -> { n, median, p25, p75, min, max, spreadRatio, bimodal }
// values = receipt gallons / (percentage-point rise / 100), i.e. "gallons per
// 100 points of sensor", one per matched fill.
//
// Reported as a RANGE and never written back to trucks.fuel_tank_gallons,
// because on real data it is not a single number. Both instrumented trucks come
// out bimodal with the upper mode at almost exactly 2x the lower one (#2372
// ~70 and ~135; #33 ~117 and ~230) — the signature of twin saddle tanks where
// the sender reads one of them: a fill that tops up both puts in double the
// gallons for the same needle movement. Neither mode is "wrong", so collapsing
// them to a mean invents a tank that does not exist. `bimodal` is the flag that
// tells a human to look before trusting the number.
function summarizeCalibration(values) {
	const vals = (Array.isArray(values) ? values : []).map((v) => num(v)).filter((v) => isPos(v)).sort((a, b) => a - b);
	if (!vals.length) return { n: 0, median: null, p25: null, p75: null, min: null, max: null, spreadRatio: null, bimodal: false };
	const p25 = percentile(vals, 0.25), p75 = percentile(vals, 0.75);
	const spreadRatio = p25 > 0 ? round2(p75 / p25) : null;
	const median = percentile(vals, 0.5);
	// The lower mode — the samples at or below the median, summarized on their
	// own. When the split is the twin-tank one described above, THIS is the
	// number that converts sensor % into gallons (the tank the sender can
	// actually see), so it is the one a human is most likely to want. Reported
	// beside the full range rather than instead of it: picking a mode silently
	// would be exactly the kind of unlabelled guess tankSource exists to prevent.
	const lower = vals.filter((v) => v <= median);
	return {
		n: vals.length,
		median: round1(median),
		p25: round1(p25), p75: round1(p75),
		min: round1(vals[0]), max: round1(vals[vals.length - 1]),
		spreadRatio,
		// 1.5x between the quartiles is far wider than metering error; it means
		// the samples are two populations, not one noisy one.
		bimodal: vals.length >= 4 && spreadRatio != null && spreadRatio >= 1.5,
		lowerMode: lower.length ? {
			n: lower.length,
			median: round1(percentile(lower, 0.5)),
			min: round1(lower[0]),
			max: round1(lower[lower.length - 1]),
		} : null,
	};
}

// receiptDerivedMpg(legs) -> { mpg, miles, gallons, legs, source }
// legs = [{ miles, gallons }], one per tank-to-tank interval between two matched
// fills: ELD odometer for the miles, the PUMP receipt for the gallons.
//
// This is the honest MPG. deriveMpg() above and the routemate_fuel_daily rollup
// both convert fuel_pct deltas into gallons, so they inherit every sender
// artifact AND the tank-size guess; the rollup's version sums a bouncing
// sender's negative deltas and books 414-856 gallons burned in a single day,
// which is where the 1.05-2.45 mpg on the dashboard comes from. Nothing here
// touches fuel_pct or tank size at all, which is also why it is immune to the
// twin-tank ambiguity in summarizeCalibration: whichever tank the diesel went
// into, it was bought and it was burned.
//
// Aggregated (total miles / total gallons), not an average of per-leg ratios:
// each fill is partial by a different amount, so a single leg can read 3 or 17
// mpg while the sum over many legs converges on the truth.
function receiptDerivedMpg(legs) {
	const clean = (Array.isArray(legs) ? legs : [])
		.map((l) => ({ miles: num(l && l.miles), gallons: num(l && l.gallons) }))
		.filter((l) => isPos(l.miles) && isPos(l.gallons));
	if (!clean.length) return { mpg: null, miles: 0, gallons: 0, legs: 0 };
	const miles = clean.reduce((s, l) => s + l.miles, 0);
	const gallons = clean.reduce((s, l) => s + l.gallons, 0);
	if (!(gallons > 0)) return { mpg: null, miles: round1(miles), gallons: 0, legs: clean.length };
	return { mpg: round2(miles / gallons), miles: round1(miles), gallons: round1(gallons), legs: clean.length };
}

module.exports = {
	DEFAULT_TANK_GALLONS,
	DEFAULT_MPG,
	REFUEL_MIN_STEP_PCT,
	REFUEL_COALESCE_MS,
	REFUEL_MIN_RISE_PCT,
	computeRange,
	deriveMpg,
	hasFuelSensor,
	estimateRangeForVehicle,
	detectRefuelEvents,
	summarizeCalibration,
	receiptDerivedMpg,
};
