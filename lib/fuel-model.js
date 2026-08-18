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

// legBurnedGallons(leg, opts?) -> gallons actually burned over the leg, or null when the
// leg cannot be resolved honestly.
//
// A leg runs from the end of fill A to the end of fill B. The naive reading —
// "the leg burned whatever fill B put in" — holds only if fill B restored the
// tank to exactly where fill A left it. It usually does not, and the error is
// enormous rather than marginal: on #2372 the raw ratio produces legs reading
// 0.09 mpg (9 miles charged against a 98.55-gal fill) and 79.8 mpg (810 miles
// charged against a 10.15-gal top-up). Neither is a truck. Both are the same
// arithmetic mistake with opposite sign.
//
// The mass balance, with levels in GALLONS:
//     burned         = level_after(A) - level_before(B)
//     level_after(B) = level_before(B) + G_B
//   => burned        = G_B - (level_after(B) - level_after(A))
// i.e. the receipt, minus however much of it went into RAISING the tank rather
// than replacing what was burned. That second term is the correction the old
// formula omitted; it is zero exactly when the fill is a full restore, which is
// why the naive answer looked right for so long.
//
// Converting those levels needs gallons-per-point, and the useful trick is that
// fill B MEASURES ITS OWN: it moved the needle `rise` points for G_B gallons.
// Substituting k = G_B / rise collapses the expression to a dimensionless ratio
// with no tank size left in it:
//
//     burned = G_B * (pctStart - pctBefore) / (pctAfter - pctBefore)
//                    \__ points burned driving __/ \__ points the fill added __/
//
// That self-calibration is the whole reason this formulation was chosen over
// multiplying by a per-truck constant. summarizeCalibration() reports that
// constant as BIMODAL on both instrumented trucks (twin saddle tanks, sender on
// one of them: #2372 ~0.95 and ~1.31 gal/point), so any single global k is wrong
// by up to 2x for half the fills — and it would multiply a term that reaches 94
// points, i.e. it could be wrong by a whole tank. The ratio cancels k entirely:
// whichever tank the diesel went into, the same fill both bought it and moved
// the needle. Measured, using a per-truck median k instead lands 7-9% low where
// this lands within 2%.
//
// Ground truth on #2372 = 6.83 mpg (3,499 gal purchased / 23,893 odometer miles
// over the 90-day span where telemetry and receipts overlap):
//     window   old (G_B only)   this
//       21d        5.13          6.78
//       30d        6.21          7.06
//       45d        5.56          6.95
//       60d        5.76          6.54
//       90d        6.18          6.75
// Note what the left column does: the old estimator's error swings with the
// REPORTING WINDOW on one truck's unchanged history (5.13-6.21, i.e. ±10% around
// a number that is itself 15% low). That is because its per-leg errors only
// cancel if EVERY leg is kept — the terms telescope — and the caller's
// unmatched-fill filter punches holes in the sum. So its bias has no fixed sign
// or size, which is worse than a known offset: it cannot be corrected for
// downstream. This version is correct leg by leg and does not rely on that
// cancellation, which is why its spread is a third as wide.
//
// Returns null (caller drops the leg) rather than guessing when:
//   - the fill's rise is below REFUEL_MIN_RISE_PCT — see the divisor note below;
//   - the tank did not fall over the leg (pctBefore >= pctStart) — either a fill
//     we never detected happened mid-leg, or the sender is lying. Both mean the
//     miles were partly paid for by fuel we cannot see, which is the one error
//     that biases OPTIMISTIC, the direction that strands a truck.
//
// ⚠️ THE FLOOR ON `rise` IS ENFORCED HERE, NOT ONLY IN THE CALLER. `rise` is a
// DIVISOR, so as it approaches zero the leg's burned gallons approach infinity:
// at rise=0.1 a 90-point drawdown scales the receipt by 900x, and because the
// aggregate MPG is a ratio of SUMS one such leg alone can drag a whole truck's
// economy to a fraction of a mile per gallon. `gallons`, the term it multiplies,
// is set by a DRIVER through POST /api/expenses and is bounded by nothing in
// this function.
//
// Until now the only thing standing between that and the fleet MPG was
// detectRefuelEvents() declining to emit an episode below REFUEL_MIN_RISE_PCT —
// a guard living entirely in one caller, protecting a function this module
// EXPORTS. A bounded function must not depend on its callers to stay bounded, so
// the same threshold is applied at the point of division.
//
// `minRisePct` may be TIGHTENED the way detectRefuelEvents takes it, and can
// never be loosened: the override goes through Math.max against the constant.
// That asymmetry is deliberate and is the difference between a floor and a
// default. Replacement semantics (`override ?? constant`) would still refuse 0
// and negatives — but `{minRisePct: 0.01}` would reinstate the 900x blowup
// verbatim, moving the dependency from one parameter to another rather than
// removing it. detectRefuelEvents keeps replacement semantics because it is a
// DETECTOR, where a looser threshold means "find more episodes"; here the value
// is a divisor, where looser means "unbounded".
//
// This is a no-op on production data and that is the intended result, not an
// argument against it — the minimum rise across all 215 detected fuel events on
// all three instrumented trucks is exactly 5.0, with zero below it, so every leg
// that exists today survives unchanged. It closes the hole for the next caller.
// Deliberately NO plausibility band on the resulting per-leg mpg. Discarding the
// implausible-looking legs discards the low ones too, which is precisely the
// optimistic bias this function exists to remove. Short legs police themselves:
// they carry few miles AND few gallons, so they barely move an aggregate that is
// a ratio of sums.
function legBurnedGallons(leg, opts = {}) {
	const gallons = num(leg && leg.gallons);
	const pctStart = clampPct(num(leg && leg.pctStart));   // level when the leg began (fill A's pct_after)
	const pctBefore = clampPct(num(leg && leg.pctBefore)); // level when it ended, before fill B
	const pctAfter = clampPct(num(leg && leg.pctAfter));   // level after fill B
	if (!isPos(gallons)) return null;
	if (pctStart == null || pctBefore == null || pctAfter == null) return null;
	const rise = pctAfter - pctBefore;
	const drop = pctStart - pctBefore;
	// Math.max, not a fallback: the override may only TIGHTEN. See the block above.
	const minRise = Math.max(REFUEL_MIN_RISE_PCT, isPos(num(opts.minRisePct)) ? num(opts.minRisePct) : 0);
	if (!(rise >= minRise) || !(drop > 0)) return null;
	return gallons * (drop / rise);
}

// receiptDerivedMpg(legs, opts?) -> { mpg, miles, gallons, legs, skipped }
// legs = [{ miles, gallons, pctStart, pctBefore, pctAfter }], one per tank-to-tank
// interval between two matched fills: ELD odometer for the miles, the PUMP
// receipt for the gallons, the sensor only ever as a RATIO (see above).
//
// This is the honest MPG. deriveMpg() above and the routemate_fuel_daily rollup
// both convert fuel_pct deltas into gallons, so they inherit every sender
// artifact AND the tank-size guess; the rollup's version sums a bouncing
// sender's negative deltas and books 414-856 gallons burned in a single day,
// which is where the 1.05-2.45 mpg on the dashboard comes from. Tank size still
// appears nowhere here — it cancels out of the ratio, which is also what keeps
// this immune to the twin-tank ambiguity in summarizeCalibration.
//
// `gallons` in the return is BURNED gallons, no longer "gallons purchased at the
// closing fill". The two coincide only for full restores.
//
// Aggregated (total miles / total burned), not an average of per-leg ratios: the
// legs are wildly unequal in length, and a ratio of sums weights each by the
// evidence it actually carries.
//
// `skipped` counts legs dropped as unresolvable, reported rather than silently
// absorbed — an MPG built from three of eleven legs deserves to look thinner
// than one built from all eleven, and a caller gating on leg count needs to know
// which of the two it got.
function receiptDerivedMpg(legs, opts = {}) {
	const all = Array.isArray(legs) ? legs : [];
	const clean = [];
	let skipped = 0;
	for (const l of all) {
		const miles = num(l && l.miles);
		// opts passes straight through so a caller that tunes the refuel detector's
		// minimum rise tunes the leg's divisor floor with it, rather than the two
		// silently disagreeing about what counts as a fill.
		const burned = legBurnedGallons(l, opts);
		if (!isPos(miles) || !isPos(burned)) { skipped++; continue; }
		clean.push({ miles, gallons: burned });
	}
	if (!clean.length) return { mpg: null, miles: 0, gallons: 0, legs: 0, skipped };
	const miles = clean.reduce((s, l) => s + l.miles, 0);
	const gallons = clean.reduce((s, l) => s + l.gallons, 0);
	if (!(gallons > 0)) return { mpg: null, miles: round1(miles), gallons: 0, legs: clean.length, skipped };
	return { mpg: round2(miles / gallons), miles: round1(miles), gallons: round1(gallons), legs: clean.length, skipped };
}

// =============================================================================
// Range verification + trip fuel planning
// =============================================================================
//
// ⚠️ THE FIGURES IN THIS BLOCK ARE HISTORY, AS MEASURED BEFORE THE 2026-08-07
// TANK CORRECTION, and are kept because they are why the section exists — not as
// a description of production today. `trucks.fuel_tank_gallons` has since been
// fixed on all three instrumented trucks (#33 300 -> 198, #2372 200 -> 100, #302
// 200 -> 80), which removed the larger of the two error terms below. Re-measured
// on the same fill histories the aggregate overstatement is now #33 1.30x,
// #2372 0.99x, #302 0.83x. See ESTIMATED_BASIS_DERATE for the current numbers
// and for what a data fix did to a constant calibrated against the old ones.
//
// WHY THIS EXISTS. The panel showed LogisX-#33 "23% · 69/300 gal · 6.5 mpg ->
// 449 mi" against a 346.9-mile route, i.e. "you arrive with 100 miles spare".
// Backtested against that truck's own fill history — 56 tank-to-tank legs,
// 26,311 measured miles — the formula overstated on 56 of 56 legs by 1.95x
// aggregate. Real range at 23% was ~210 mi (median leg). The truck needed
// 15.08 mi per sensor point to finish; it had managed that on 5 of 56 legs.
//
// THE PRIMITIVE IS MILES PER SENSOR POINT, not tank size and not MPG.
// `tank x mpg` multiplied two separately-wrong numbers (#33: tank 300 vs ~198
// measured = 1.51x, mpg 6.5 vs 5.04 receipt-derived = 1.29x, and 1.51 x 1.29 =
// the observed 1.95x). That the tank half has since been corrected in the DATA
// is exactly the point of preferring a primitive that needs neither input:
// miles-per-point never had to be re-derived when the tank changed.
// Miles-per-point is measured end-to-end from the ELD
// odometer and the gauge, so it needs NEITHER input and cannot inherit either
// error. It is also the only form in which the question is answerable at all on
// this fleet — see the twin-tank note below.
//
// TWIN TANKS: SENSED VOLUME IS NOT CAPACITY. summarizeCalibration comes out
// bimodal at ~1.8-2x on both instrumented trucks because the sender reads ONE
// saddle tank: a fill that tops up only that tank implies ~117 gal/100pt on #33,
// one that tops up both implies ~230. It is tempting to read the lower mode as
// "the real tank" and substitute it for the configured 300 — that is WRONG and
// it fails dangerous in the opposite direction. #33 has taken two separate
// 202.7-gallon fills (TA Express Fairview KS, Shell Cameron NC), a hard physical
// floor of >=203 gal, so 117 is not the truck's capacity; it is what one tank
// holds. Burn-side agrees: 9.98 mi/pt / 5.04 mpg = 1.98 gal per point, ~198 gal
// per 100 points. Anything reported to a human must therefore say SENSED or
// CAPACITY explicitly. "Your 300 is wrong, it's 117" is worse than silence.
//
// THE SPREAD IS THE FINDING. At the same 23%, #33's measured legs run p10 100 mi
// / p50 210 / p90 340 — a 3.4x range. No single number is honest however good
// the tank and MPG get, because load weight, terrain, weather and idle hours
// move real consumption by that much. So this section returns an INTERVAL with
// its basis, in the pattern the cost-per-mile work already set ("at least
// $0.32", basis shown) and that mpgSource/tankSource established.
//
// AND IT PLANS AGAINST THE LOW END. Overestimating strands a truck on a
// shoulder; underestimating costs one unnecessary fuel stop. Those are not
// symmetric, so the planner does not use the median.

// A leg is one tank-to-tank interval. Below these the spread is an anecdote.
//
// 10, not 5. This gate governs whether we publish a p10/p90 INTERVAL, and you
// cannot estimate a 90th percentile from 5 samples — #302 qualified on 5 legs
// and produced a p90 of 34.8 mi/point, i.e. a claimed 418-mile range on a truck
// showing 12% fuel. A too-low bar here does not degrade gracefully; it invents
// a confident wrong answer, which is the exact failure this whole section
// exists to remove. Trucks below the bar fall back to the derated estimate,
// which is honest about knowing less.
const BURN_MIN_LEGS = 10;
const BURN_MIN_POINTS = 100;
// Physical plausibility for a single leg, expressed as what the leg implies for
// a FULL gauge sweep: 1.5 mi/point = 150 miles a tank, 20 mi/point = 2,000. No
// Class-8 truck is outside that (the largest tank in this fleet takes ~203 gal,
// and 203 x 8 mpg = 1,624 miles). A leg beyond the top of the band contains a
// refuel the sweep missed; one below it is a stuck sender. Both are data faults
// rather than driving, and both distort the tail far more than the aggregate —
// #302's 34.8 implied 3,480 miles on one gauge.
const BURN_LEG_MIN_MI_PER_POINT = 1.5;
const BURN_LEG_MAX_MI_PER_POINT = 20;
// Guards on an individual leg. A leg longer than a tank's worth of driving means
// a refuel was missed (which inflates mi/point, i.e. flatters the formula).
const BURN_LEG_MIN_MILES = 50;
const BURN_LEG_MAX_MILES = 2000;
// ⚠️ A QUANTIZATION FLOOR ONLY — NOT a quality filter, and it must stay small.
// This started at 20 and that was a live methodology bug: `points` is the
// OUTCOME being measured, so filtering on it selects. A short leg only survives
// a high points floor when its drawdown was anomalously large, so the surviving
// short legs are exactly the worst-looking ones, and the sample acquires a
// manufactured correlation between leg length and mi/point. At >=20 it looked
// like #33's economy varied 10x with trip length (63 mi at 1.57 mi/pt vs 1,471
// mi at 16.91) and a regression "found" a 26.5-point-per-leg offset — an
// artifact of the filter, not a property of the truck. Real fuel economy does
// not vary 10x.
// Measured cost of the bug: unweighted p10 4.35 -> 5.00 mi/pt, i.e. the number
// a driver plans against moved 15% purely from a filter choice.
// At 5 the floor selects nothing (miles>=50 already implies points>=5 on every
// leg in production: 84 legs at both >=1 and >=5) while still refusing a leg
// whose 1-point sensor quantum would be a third of the signal.
const BURN_LEG_MIN_POINTS = 5;

// Arrive with fuel still in the tank.
//
// ⚠️ CHANGED 2026-08-18 AT THE CLIENT'S EXPLICIT REQUEST, AND IT IS A REDUCTION
// IN SAFETY MARGIN — read this before "tidying" either number.
// This was `MIN 50 / FRACTION 0.10` ("proportional on a long run, floored at 50
// miles on a short one — a fixed 10% would leave 10 miles of margin on a
// 100-mile lane, which is not a margin"). After a truck ran dry on 2026-08-17
// the client asked, verbatim, for "a 15 mile buffer". A flat 15 is what that
// sentence means, so FRACTION is 0: leaving it at 0.10 would have made a 215-mi
// route compute max(15, 21.5) = 22, i.e. quietly not the number that was asked
// for.
//
// The reduction was flagged back and the client kept 15. It is thin on purpose
// and it sits on top of two figures already known to lean optimistic — the
// estimated basis is only derated by ESTIMATED_BASIS_DERATE (which was itself
// revised DOWN from 2.0), and `gallonsNeeded` is a documented LOWER bound
// (~24% optimistic on the one cross-checkable truck). So this buffer is the
// last line of defence, not the first.
//
// Both are DEFAULTS ONLY — every consumer may override per call, and server.js
// reads FUEL_RESERVE_MILES / FUEL_RESERVE_FRACTION from the environment and
// passes them in, so the number can be raised with a `pm2 restart` and no
// redeploy. The override lives in the caller rather than a process.env read in
// here so this module stays pure and unit-testable.
const TRIP_RESERVE_MIN_MI = 15;
const TRIP_RESERVE_FRACTION = 0;
// How stale the last credible fuel reading may be before resolveFuelReading()
// refuses to carry it forward. Must comfortably exceed a real sensor dropout —
// the 2026-08-17 incident ran ~4 hours of continuous zeros — while still
// refusing a dead ELD (LogisX-#33 has been frozen for days). 12 hours.
const CARRY_MAX_MINUTES = 12 * 60;
// What an UNMEASURED (tank x mpg) range must beat before it may be called a pass.
//
// ⚠️ RE-DERIVED 2026-08-07, AND THE ORIGINAL JUSTIFICATION IS NOW FALSE. This was
// 2.0 on the grounds that it was "the overstatement this formula was measured to
// carry on every instrumented truck (#33 1.95x, #2372 1.97x, #302 2.25x)". Those
// figures no longer describe production, because the thing that produced them was
// FIXED IN THE DATA, not in this file: `trucks.fuel_tank_gallons` has since been
// corrected on all three trucks (#33 300 -> 198, #2372 200 -> 100, #302 200 -> 80),
// and the tank error was the larger of the two factors behind the 2x (#33: tank
// 1.51x x mpg 1.29x = 1.95x). Re-measured today against the same fill histories,
// tank x mpg overstates the AGGREGATE by only #33 1.30x, #2372 0.99x, #302 0.83x.
// A constant justified by a measurement, sitting next to data that silently moved
// out from under it, is how an unexamined 2.0 survives; hence the numbers below
// carry the date and the method, so the next person can tell staleness from
// disagreement.
//
// SO WHY IS IT NOT ~1.0 NOW? Because this factor was never doing only one job,
// and only one of the two has been fixed:
//   1. correcting the point estimate's central bias  -> largely gone (above);
//   2. stepping a CENTRAL estimate down to a PLANNING one — the same p50 -> p10
//      move a measured basis gets for free from its own percentiles.
// Job 2 is not a data defect and never improves: at a fixed fuel level #33's real
// legs span p10 7.15 / p50 11.29 mi-per-point and #2372's 4.31 / 7.22, a ~1.6x
// spread that is load weight, terrain, weather and idle hours. Deleting the
// derate on the strength of job 1 alone would publish a truck's TYPICAL range as
// its planning number — precisely the false confidence this whole section
// replaced, arrived at from the opposite direction.
//
// THE CALIBRATION IS THEREFORE END-TO-END: what factor turns the point estimate
// into a number as conservative as the p10 a measured basis would have produced?
// = predictedMilesPerPoint / p10, over the two trucks with a usable measured
// basis (>=10 clean legs), at every MPG source the range endpoint can pick:
//     #33    receipts mpg 6.21 -> 12.30 / 7.15 = 1.72   default 6.5 -> 1.80
//     #2372  receipts mpg 6.48 ->  6.48 / 4.31 = 1.50   default 6.5 -> 1.51
// (#302 says 1.06, and is excluded on purpose: 4 clean legs is not a percentile.)
// 1.8 is the fleet MAXIMUM, at the WORST MPG source — not the mean — because a
// truck on the estimated basis is by definition one we know less about than
// these, and the errors here are not symmetric: overestimating strands a truck
// on a shoulder, underestimating costs one fuel stop.
//
// The live cost of leaving it at 2.0 was not theoretical. #302 is on the
// estimated basis today (4 legs), and its formula already reads 17% LOW (0.83x),
// so 2.0 was derating an understatement — a planning number ~2.4x under the
// truth. That is the crying-wolf failure BURN_LEG_MIN_POINTS is commented
// against three screens up: a panel that is always alarmist gets ignored on the
// day it is right.
const ESTIMATED_BASIS_DERATE = 1.8;

// weightedPercentile(items, p) — items = [{ value, weight }], p in [0,1].
// Internal. Returns the value at which cumulative weight first reaches p.
function weightedPercentile(items, p) {
	if (!items.length) return null;
	const sorted = [...items].sort((a, b) => a.value - b.value);
	const total = sorted.reduce((s, x) => s + x.weight, 0);
	if (!(total > 0)) return sorted[Math.floor((sorted.length - 1) * p)].value;
	let acc = 0;
	for (const x of sorted) {
		acc += x.weight;
		if (acc >= p * total) return x.value;
	}
	return sorted[sorted.length - 1].value;
}

// measureBurnRate(legs) -> { usable, n, miles, points, milesPerPoint, p10..p90, min, max }
// legs = [{ miles, points }], one per tank-to-tank interval: ELD odometer for the
// miles, gauge drawdown for the points.
//
// The headline `milesPerPoint` is AGGREGATE (total miles / total points), not a
// mean of per-leg ratios — same reasoning as receiptDerivedMpg. Each leg starts
// and ends at a different point on the gauge, so one leg can read 1.6 or 16.9
// while the sum over many converges. It is also the ROBUST figure: across every
// filter combination tried on production data it moved only 9.98 -> 12.0 on #33
// and 6.1 -> 7.8 on #2372, while the per-leg spread moved 4.4 -> 16.9.
//
// The percentiles are MILE-WEIGHTED, and that is not a refinement — it is what
// makes the interval honest. Two reasons, one statistical and one physical:
//   • A short leg's ratio is mostly noise: the sensor quantum, and the settling
//     of a fill that has just ended, are roughly FIXED per leg, so they are a
//     large fraction of a 63-mile leg and a small one of a 1,471-mile leg.
//     Weighting by miles is the standard remedy for heteroscedastic samples and
//     needs no arbitrary length cutoff (which would also throw away data AND
//     select).
//   • It answers the right question. A driver with 347 miles ahead wants "over
//     the next 347 miles, what rate applies", not "over a randomly chosen leg,
//     which is probably a short one". Mile-weighting makes each MILE of history
//     an equal vote instead of each leg.
// On #33 this moves the planning number from 115 mi to 164 mi at 23% — i.e. the
// unweighted version was crying wolf by ~30%, and alert fatigue is how a real
// warning gets ignored.
// cleanBurnLegs(legs) — the ONE place a leg is admitted or rejected. Shared by
// measureBurnRate and backtestRangeFormula on purpose: they must grade the same
// sample, or the interval a driver plans against and the backtest an admin uses
// to audit it would silently describe different sets of trips.
function cleanBurnLegs(legs) {
	return (Array.isArray(legs) ? legs : [])
		.map((l) => ({
			label: l && l.label != null ? String(l.label) : "",
			miles: num(l && l.miles),
			points: num(l && l.points),
		}))
		.filter((l) => isPos(l.miles) && isPos(l.points)
			&& l.miles >= BURN_LEG_MIN_MILES && l.miles <= BURN_LEG_MAX_MILES
			&& l.points >= BURN_LEG_MIN_POINTS
			&& l.miles / l.points >= BURN_LEG_MIN_MI_PER_POINT
			&& l.miles / l.points <= BURN_LEG_MAX_MI_PER_POINT);
}

function measureBurnRate(legs) {
	const clean = cleanBurnLegs(legs);
	const empty = {
		usable: false, n: 0, miles: 0, points: 0, milesPerPoint: null,
		p10: null, p25: null, p50: null, p75: null, p90: null, min: null, max: null,
	};
	if (!clean.length) return empty;
	const miles = clean.reduce((s, l) => s + l.miles, 0);
	const points = clean.reduce((s, l) => s + l.points, 0);
	const weighted = clean.map((l) => ({ value: l.miles / l.points, weight: l.miles }));
	const ratios = clean.map((l) => l.miles / l.points).sort((a, b) => a - b);
	const at = (p) => round2(weightedPercentile(weighted, p));
	return {
		// `usable` is the caller's gate for whether to trust the interval. Below it
		// we still report the numbers (they are the evidence) but the range falls
		// back to the estimated basis rather than pretending 2 legs are a
		// distribution.
		usable: clean.length >= BURN_MIN_LEGS && points >= BURN_MIN_POINTS,
		n: clean.length,
		miles: round1(miles),
		points: round1(points),
		milesPerPoint: round2(miles / points),
		p10: at(0.10), p25: at(0.25), p50: at(0.50), p75: at(0.75), p90: at(0.90),
		min: round2(ratios[0]), max: round2(ratios[ratios.length - 1]),
	};
}

// backtestRangeFormula(legs, { tankGallons, mpg }) -> what the panel's formula
// WOULD have predicted for the fuel each leg actually consumed, vs the miles
// actually driven. This is the client's "write a script that verifies that",
// and it is a far stronger answer than auditing the arithmetic: the formula is
// arithmetically fine, its inputs are wrong, and only the fill history can show
// that.
//
// `ratio` is predicted/actual, so >1 means the panel promised miles the truck
// did not deliver. Reported as BOTH aggregate and median-leg because they answer
// different questions — aggregate is "over a quarter's driving, how far off is
// the number", median leg is "on a typical trip, how far off".
function backtestRangeFormula(legs, opts = {}) {
	const tank = isPos(num(opts.tankGallons)) ? num(opts.tankGallons) : DEFAULT_TANK_GALLONS;
	const mpg = isPos(num(opts.mpg)) ? num(opts.mpg) : DEFAULT_MPG;
	const predictedMilesPerPoint = (tank / 100) * mpg;

	const rows = cleanBurnLegs(legs)
		.map((l) => {
			const predictedMiles = l.points * predictedMilesPerPoint;
			return {
				label: l.label,
				actualMiles: round1(l.miles),
				pointsBurned: round1(l.points),
				milesPerPoint: round2(l.miles / l.points),
				predictedMiles: Math.round(predictedMiles),
				// Miles the truck would have been short had it driven to the promise.
				shortfallMiles: Math.round(predictedMiles - l.miles),
				ratio: round2(predictedMiles / l.miles),
			};
		});

	if (!rows.length) {
		return {
			legs: 0, milesTotal: 0, pointsTotal: 0,
			predictedMilesPerPoint: round2(predictedMilesPerPoint),
			measuredMilesPerPoint: null, overstatementFactor: null,
			medianOverstatement: null, overstatedLegs: 0, legDetail: [],
		};
	}
	const milesTotal = rows.reduce((s, r) => s + r.actualMiles, 0);
	const pointsTotal = rows.reduce((s, r) => s + r.pointsBurned, 0);
	const measured = milesTotal / pointsTotal;
	const ratiosSorted = rows.map((r) => r.ratio).sort((a, b) => a - b);
	return {
		legs: rows.length,
		milesTotal: round1(milesTotal),
		pointsTotal: round1(pointsTotal),
		predictedMilesPerPoint: round2(predictedMilesPerPoint),
		measuredMilesPerPoint: round2(measured),
		overstatementFactor: round2(predictedMilesPerPoint / measured),
		medianOverstatement: round2(percentile(ratiosSorted, 0.5)),
		overstatedLegs: rows.filter((r) => r.ratio > 1).length,
		legDetail: rows,
	};
}

// rangeInterval({ fuelPct, burn, rangeMiles }) -> { low, typical, high, basis,
//   milesPerPoint, planning }
//
// `basis` ranks exactly like mpgSource does:
//   'measured'  — this truck's own tank-to-tank legs. low/typical/high are its
//                 p10/p50/p90, so the interval is that truck's real variability.
//   'estimated' — no usable legs; the old tank x mpg point estimate, derated
//                 END-TO-END to the p10 a measured basis would have produced.
//                 (NOT "by the formula's overstatement" — that was the old basis
//                 for the constant and it no longer holds; see
//                 ESTIMATED_BASIS_DERATE.) low is the ONLY number safe
//                 to plan on and `typical`/`high` are deliberately left null
//                 rather than invented: with no legs there is no spread to report,
//                 and fabricating one is how "449" happened in the first place.
//   'unknown'   — no live fuel reading. Everything null.
//
// `planning` is the single number a decision should be made against, and it is
// always the LOW end. Callers that want to render one figure must render this
// one; rendering `typical` re-creates the false confidence this replaced.
function rangeInterval({ fuelPct, burn, rangeMiles } = {}) {
	const pct = clampPct(num(fuelPct));
	const none = { low: null, typical: null, high: null, planning: null, basis: "unknown", milesPerPoint: null };
	if (pct == null) return none;

	// isPos() is correct HERE and must stay: p10 is a RATE (miles per fuel point),
	// floored at BURN_LEG_MIN_MI_PER_POINT by cleanBurnLegs(), so a 0 means the
	// burn object is degenerate rather than "this truck does 0 miles per point".
	// Falling through to the estimated branch is the right answer for that.
	if (burn && burn.usable && isPos(burn.p10)) {
		return {
			low: Math.round(pct * burn.p10),
			typical: Math.round(pct * burn.p50),
			high: Math.round(pct * burn.p90),
			planning: Math.round(pct * burn.p10),
			basis: "measured",
			milesPerPoint: burn.milesPerPoint,
		};
	}
	const point = num(rangeMiles);
	// ⚠️ ZERO IS A MEASUREMENT, NOT MISSING DATA — this guard was `!isPos(point)`
	// and that one comparison caused the 2026-08-17 run-dry. `pct == null` is
	// already handled above, so by this line we HAVE a fuel reading; if it says
	// the tank is empty then `point` is legitimately 0. `isPos(0)` is false, so
	// the empty tank — the most urgent state this function can describe — was
	// being folded into the identical `none` bucket as "no reading at all",
	// surfacing as verdict 'unknown' and a panel that rendered "No verdict" with
	// no number on it. The driver read a blank card as "nothing to worry about".
	// Reject only null and negative (a negative range is nonsense); let 0 through
	// so planTripFuel() can reach 'insufficient' and say "short by N miles".
	if (point == null || point < 0) return none;
	return {
		low: Math.round(point / ESTIMATED_BASIS_DERATE),
		typical: null,
		high: null,
		planning: Math.round(point / ESTIMATED_BASIS_DERATE),
		basis: "estimated",
		milesPerPoint: null,
	};
}

// tripReserveMiles(routeMiles, { minMiles, fraction }) — fuel we plan NOT to use.
// Both knobs default to the module constants; server.js passes the env-configured
// values so the buffer can be retuned without a redeploy. A non-finite or
// negative override falls back to the default rather than producing a nonsense
// (or negative) reserve — this number only ever protects, so a bad input must
// never be able to shrink it below the shipped default by accident.
function tripReserveMiles(routeMiles, opts = {}) {
	const minOverride = num(opts.minMiles);
	const fracOverride = num(opts.fraction);
	const minMiles = minOverride != null && minOverride >= 0 ? minOverride : TRIP_RESERVE_MIN_MI;
	const fraction = fracOverride != null && fracOverride >= 0 ? fracOverride : TRIP_RESERVE_FRACTION;
	const r = num(routeMiles);
	if (!isPos(r)) return Math.round(minMiles);
	return Math.round(Math.max(minMiles, r * fraction));
}

// resolveFuelReading({ rows, mpg, tankGallons }) -> a fuel percentage that
// survives a sensor that drops out, plus the provenance needed to say so.
//
// ⚠️ THE PROBLEM THIS EXISTS FOR. Trusting `rows[0].fuel_pct` is what made the
// 2026-08-17 run-dry invisible. Measured on that truck over the surrounding 18h:
// 2,027 of 4,315 readings (47%) were EXACTLY 0 — and those zero rows carry an
// average speed of 18.99 mph with the odometer advancing 544 miles. A truck
// cannot drive 544 miles with the engine off, so a 0 here is a SENSOR DROPOUT,
// not an empty tank and not ignition-off. The dropouts ran for HOURS (four
// consecutive hours of 240/240 zeros), so smoothing a short window does not help
// either — at the moment of the incident the whole preceding hour was zeros.
//
// So: when the latest sample is unusable, carry the last CREDIBLE reading
// forward and subtract the fuel burned since it was taken, from the odometer
// delta. On the incident's real data that yields "0 mi, last good 1% at 22:45,
// 192 miles ago" — the alarm that should have fired — instead of a blank card.
//
// ⚠️ THIS MAY ONLY EVER LOWER THE ESTIMATE, NEVER RAISE IT. It subtracts
// consumption from a known reading, so it fails toward "less fuel than you
// think", which is the safe direction (over-estimating strands a truck on a
// shoulder; under-estimating costs one fuel stop). The `Math.min` against the
// anchor reading is belt-and-braces for a non-monotonic odometer.
//
// ⚠️ AND IT MUST REFUSE TO CARRY A READING FROM A DEAD DEVICE. Miles-driven
// decay is not enough on its own, because a dead ELD freezes the ODOMETER too:
// LogisX-#33 stopped reporting on 2026-08-14 and the poller has re-stored the
// same fix every 15s ever since (5,752 byte-identical rows in one day). Carrying
// its last 27% forward therefore subtracted ZERO burn and produced a confident
// "CLEARS, 293 mi" for a truck nobody has heard from in three and a half days —
// optimistic, which is the direction that strands trucks, and strictly worse
// than the blank panel it replaced. So staleness is judged on WALL CLOCK
// (`nowMs`) and a too-old anchor returns `fuelSource: "stale"` with fuelPct
// null: no range is computed, but anchorPct/ageMinutes survive so the UI can
// say "ELD offline, last known 27%" instead of either lying or going blank.
//
// `rows` is newest-first, as every caller already queries it.
// `nowMs` defaults to Date.now() so a caller that forgets it fails SAFE (an old
// fixture reads as stale) rather than fail-open.
function resolveFuelReading({ rows, mpg, tankGallons, nowMs, maxCarryMinutes } = {}) {
	const none = {
		fuelPct: null, fuelSource: "none", anchorPct: null,
		anchorAtMs: null, milesSinceReading: null, ageMinutes: null,
	};
	const list = Array.isArray(rows) ? rows : [];
	if (!list.length) return none;
	const now = num(nowMs) != null ? num(nowMs) : Date.now();
	const maxCarry = isPos(num(maxCarryMinutes)) ? num(maxCarryMinutes) : CARRY_MAX_MINUTES;

	const latest = list[0];
	const latestPct = clampPct(num(latest && latest.fuel_pct));
	// A positive live reading is preferred — but it still has to be RECENT.
	//
	// ⚠️ THIS AGE CHECK IS NOT SYMMETRY FOR ITS OWN SAKE. Without it the two
	// paths disagree in the dangerous direction: a 5-hour-old reading behind a
	// dropout is refused as stale, while a 22-DAY-old positive reading is
	// returned as "live" and treated as gospel. Measured on production before
	// this line existed: LogisX-#2372 (last fix 161 h old) and LogisX-#302
	// (528 h old) both resolved to `live` and would have fired a low-fuel alert
	// about trucks nobody had heard from in a week and three weeks respectively,
	// while the panel showed a confident "34 mi" with nothing marking it stale.
	// A reading is stale because of its AGE, never because of which branch
	// happened to find it.
	const latestAge = latest && num(latest.location_date_ms) != null && now >= num(latest.location_date_ms)
		? Math.round((now - num(latest.location_date_ms)) / 60000)
		: null;
	if (isPos(latestPct)) {
		if (latestAge != null && latestAge <= maxCarry) {
			return {
				fuelPct: latestPct, fuelSource: "live", anchorPct: latestPct,
				anchorAtMs: num(latest.location_date_ms),
				milesSinceReading: 0, ageMinutes: latestAge,
			};
		}
		// Too old (or undatable) to call live. Report what was last known and let
		// the caller say "no current reading" rather than publish a range.
		return {
			fuelPct: null, fuelSource: "stale", anchorPct: latestPct,
			anchorAtMs: num(latest.location_date_ms),
			milesSinceReading: null, ageMinutes: latestAge,
		};
	}

	// Latest is 0 or null. Find the most recent CREDIBLE (positive) reading.
	let anchor = null;
	let anchorIdx = -1;
	for (let i = 0; i < list.length; i++) {
		if (isPos(clampPct(num(list[i] && list[i].fuel_pct)))) { anchor = list[i]; anchorIdx = i; break; }
	}
	// Nothing positive anywhere in the window: this is the genuine no-sensor
	// signature (the same one hasFuelSensor() reports), NOT an empty tank, so we
	// must not invent a number for it.
	if (!anchor) return none;

	const anchorPct = clampPct(num(anchor.fuel_pct));
	const anchorAtMs = num(anchor.location_date_ms);
	const latestAtMs = num(latest && latest.location_date_ms);
	const anchorOdo = num(anchor.odometer);

	// Wall-clock age of the anchor — NOT the device-time gap between the anchor
	// and the latest row. Those differ by days on a dead ELD (whose latest row is
	// itself frozen), and using the gap is what let a 3.6-day-old reading look
	// like it was four hours old.
	const wallAgeMinutes = anchorAtMs != null && now >= anchorAtMs
		? Math.round((now - anchorAtMs) / 60000)
		: null;
	if (wallAgeMinutes == null || wallAgeMinutes > maxCarry) {
		return {
			fuelPct: null, fuelSource: "stale", anchorPct,
			anchorAtMs, milesSinceReading: null, ageMinutes: wallAgeMinutes,
		};
	}
	// The odometer on the newest row that actually has one — a dropout can null
	// the fuel reading without nulling the odometer, but not always.
	let latestOdo = null;
	for (let i = 0; i < anchorIdx; i++) {
		const o = num(list[i] && list[i].odometer);
		if (o != null) { latestOdo = o; break; }
	}

	const economy = isPos(num(mpg)) ? num(mpg) : DEFAULT_MPG;
	const tank = isPos(num(tankGallons)) ? num(tankGallons) : DEFAULT_TANK_GALLONS;

	let milesSince = null;
	if (anchorOdo != null && latestOdo != null && latestOdo >= anchorOdo) {
		milesSince = round1(latestOdo - anchorOdo);
	}

	// With no usable odometer delta we cannot say how much was burned. Carry the
	// anchor across UNCHANGED rather than guessing a burn — it is still strictly
	// better than the 0 the sensor is reporting, and the age/miles fields tell
	// the UI (and the reader) exactly how much to trust it.
	let carried = anchorPct;
	if (milesSince != null) {
		const gallonsBurned = milesSince / economy;
		const pctBurned = (gallonsBurned / tank) * 100;
		carried = Math.max(0, anchorPct - pctBurned);
	}
	// Never above the anchor. See the warning above.
	carried = Math.min(carried, anchorPct);

	return {
		fuelPct: Math.round(carried * 10) / 10,
		fuelSource: "carried",
		anchorPct,
		anchorAtMs,
		milesSinceReading: milesSince,
		ageMinutes: wallAgeMinutes,
	};
}

// planTripFuel({ routeMiles, fuelPct, burn, rangeMiles, mpg }) — "will this load's
// route fit in the tank, and if not, where do I have to stop?"
//
// Verdicts, and the rule that drives the whole design:
//   'clears'       the LOW end covers the route plus reserve. Only a measured
//                  basis, or an estimate carrying ESTIMATED_BASIS_DERATE worth
//                  of headroom, can earn this.
//   'tight'        might make it, must not be relied on -> plan a stop.
//   'insufficient' the typical leg does not reach -> a stop is required.
//   'unknown'      no live fuel reading; the panel should say so, not guess.
//
// THE CASE THIS IS BUILT AROUND. Once the receipt-derived MPG lands, #33's panel
// reads 348 mi against that same 346.9-mile route — a 1.1-mile margin rendered
// as a confident number, which reads as "you'll just make it" when the honest
// answer is "you will not". A point estimate landing within a few percent of the
// route is the single most dangerous state this panel can produce, and it is
// the state that enabling the feature creates. Two independent things stop it:
// `clears` is judged on `planning` (the low end) and never on the point estimate,
// AND an estimated basis is derated by ESTIMATED_BASIS_DERATE first. 348 vs 346.9
// therefore needs 1.8 x (346.9 + 50) = 714 mi before it may say "clears". It says
// 'insufficient'. (It needed 794 mi at the old 2.0; re-deriving that constant
// downward narrows this margin but does not remove it, which is why the two
// guards are independent — the verdict must not rest on the derate alone.)
function planTripFuel({ routeMiles, fuelPct, burn, rangeMiles, mpg, reserve: reserveOpts } = {}) {
	const route = num(routeMiles);
	const interval = rangeInterval({ fuelPct, burn, rangeMiles });
	const reserve = tripReserveMiles(route, reserveOpts || {});
	const economy = isPos(num(mpg)) ? num(mpg) : null;

	// Fuel the ROUTE needs, in gallons. Independent of tank size — it is miles/mpg
	// and nothing else — so it survives a truck whose configured capacity is
	// wrong, which is every truck in this fleet today.
	//
	// ⚠️ It does NOT survive a wrong MPG, and the caller must publish mpgSource
	// beside it. On the one truck where MPG can be cross-checked (#2372, 71 of 72
	// receipts carry gallons) the leg-derived 'receipts' MPG reads 6.18 while
	// total-gallons-over-total-miles reads ~5.0 — about 24% optimistic, because a
	// leg attributes the gallons of the fill that ENDS it, and a partial fill does
	// not restore the tank to where the leg began. So treat this as a LOWER bound
	// on gallons. It is not corrected here: the fix belongs in receiptDerivedMpg
	// where the leg is built, not smuggled in as a fudge factor at the point of
	// display.
	const gallonsNeeded = isPos(route) && economy ? round1(route / economy) : null;
	// The same demand in GAUGE POINTS — what the driver can actually see on the
	// dash, and the trustworthy half of this pair: it comes from the measured
	// miles-per-point and touches neither tank size nor MPG, so it inherits
	// neither error. Null unless the basis is 'measured', because a made-up
	// points figure would be read as gospel ("it'll cost me 35% of my tank").
	const pointsNeeded = isPos(route) && isPos(interval.milesPerPoint)
		? Math.ceil(route / interval.milesPerPoint) : null;

	const base = {
		routeMiles: isPos(route) ? round1(route) : null,
		reserveMiles: reserve,
		requiredMiles: isPos(route) ? Math.round(route + reserve) : null,
		range: interval,
		gallonsNeeded,
		pointsNeeded,
		// Which number the verdict was taken on, so a caller can show its work.
		decidedOn: interval.planning,
	};

	if (!isPos(route) || interval.planning == null) {
		return { ...base, verdict: "unknown", canMakeIt: null, shortfallMiles: null, refuelWithinMiles: null };
	}

	const required = route + reserve;
	// How far we may drive before a stop becomes mandatory. Floored at 0 rather
	// than allowed negative: "refuel within -40 miles" is not a sentence, and 0
	// carries the same instruction (stop now).
	const refuelWithinMiles = Math.max(0, Math.round(interval.planning - reserve));

	if (interval.planning >= required) {
		return { ...base, verdict: "clears", canMakeIt: true, shortfallMiles: 0, refuelWithinMiles };
	}
	// `typical` is null on an estimated basis, which lands every non-clearing
	// estimate in 'insufficient' rather than the softer 'tight'. That is the
	// intended direction: without measured legs we cannot distinguish "probably
	// fine" from "nowhere near", and the safe reading of an unknown is the
	// pessimistic one.
	const typical = interval.typical;
	if (typical != null && typical >= route) {
		return {
			...base, verdict: "tight", canMakeIt: false,
			shortfallMiles: Math.round(required - interval.planning), refuelWithinMiles,
		};
	}
	return {
		...base, verdict: "insufficient", canMakeIt: false,
		shortfallMiles: Math.round(route - interval.planning), refuelWithinMiles,
	};
}

module.exports = {
	DEFAULT_TANK_GALLONS,
	DEFAULT_MPG,
	REFUEL_MIN_STEP_PCT,
	REFUEL_COALESCE_MS,
	REFUEL_MIN_RISE_PCT,
	BURN_MIN_LEGS,
	BURN_MIN_POINTS,
	BURN_LEG_MIN_MILES,
	BURN_LEG_MAX_MILES,
	BURN_LEG_MIN_POINTS,
	BURN_LEG_MIN_MI_PER_POINT,
	BURN_LEG_MAX_MI_PER_POINT,
	TRIP_RESERVE_MIN_MI,
	TRIP_RESERVE_FRACTION,
	CARRY_MAX_MINUTES,
	ESTIMATED_BASIS_DERATE,
	computeRange,
	deriveMpg,
	hasFuelSensor,
	estimateRangeForVehicle,
	detectRefuelEvents,
	summarizeCalibration,
	legBurnedGallons,
	receiptDerivedMpg,
	measureBurnRate,
	backtestRangeFormula,
	rangeInterval,
	tripReserveMiles,
	resolveFuelReading,
	planTripFuel,
};
