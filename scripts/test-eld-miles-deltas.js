#!/usr/bin/env node
// Deterministic check on lib/eld-miles.js — the odometer→miles primitive behind
// the mileage analytics and behind the corrected routemate_fuel_daily rollup.
//
// WHY THIS EXISTS. rollupOneDay() computed miles as MAX(odometer) - MIN(odometer)
// on the stated assumption that "odometer is monotonically increasing per
// vehicle". It is not. On 2026-08-11 LogisX-#2372's ELD reset and its odometer
// fell 219,818 miles in 0.17 h; the span billed that reset as DISTANCE and wrote
// a 219,818-mile DAY, which is still in production and which alone inflates that
// truck's all-time total from ~24,744 to 244,562 miles — a figure both the
// investor MyTrucks panel and Fleet Health display.
//
// Every case below is paired with the shape that must NOT change, because the
// danger runs in both directions:
//
//   • A fix that only rejected outliers would ALSO clip the real 1,247-mile day
//     in this data, quietly under-reporting a driver's biggest week.
//   • A fix that treated every non-positive delta as an anomaly would flag every
//     PARKED day 'partial' — a stationary truck emits hundreds of zero deltas an
//     hour — draining the coverage label of all meaning.
//
// So the suite pins both the correction AND the no-op: on the three vehicles
// whose sensor behaved, delta-sum must equal the old span EXACTLY. If it does
// not, this is not a safer measurement, it is a different one.
//
// Figures are the real production shapes, measured 2026-08-26 over a 30-day
// window: #33 5,873 · #91 2,803 · #2372 3,369 (span -216,449) · unlinked 167.
//
// No network, no sheet, no database, no server — pure input/output.
//
//   node scripts/test-eld-miles-deltas.js      # exits 1 on any failure

const m = require("../lib/eld-miles");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

const T0 = 1756000000000; // fixed epoch — no Date.now(), so runs are reproducible
const MIN = 60000;
const HOUR = 3600000;

// A steady run: `n` one-minute pings advancing `step` miles each.
function run(startMs, startOdo, n, step, lng = -95) {
	const out = [];
	for (let i = 0; i < n; i++) out.push({ ms: startMs + i * MIN, odo: startOdo + i * step, lng });
	return out;
}

// ---------------------------------------------------------------------------
// 1. THE NO-OP. Where the sensor behaved, delta-sum must equal the span.
// ---------------------------------------------------------------------------
const clean = run(T0, 862357, 400, 1.2);
const cleanSum = m.sumOdoDeltas(clean);
const cleanSpan = clean[clean.length - 1].odo - clean[0].odo;
check("clean run: delta-sum equals the naive span exactly",
	cleanSum.miles, Math.round(cleanSpan * 10) / 10);
check("clean run: nothing rejected", cleanSum.rejected, 0);
check("clean run: nothing dropped", cleanSum.droppedMiles, 0);
check("clean run: basis is eld", m.dayBasis(cleanSum), "eld");

// ---------------------------------------------------------------------------
// 2. THE #2372 RESET — the bug this exists for.
// ---------------------------------------------------------------------------
const before = run(T0, 900000, 50, 1.0);
const afterStart = 900000 + 49 - 219818;
const after = run(T0 + 50 * MIN + 10 * MIN, afterStart, 50, 1.0);
const reset = [...before, ...after];
const resetSum = m.sumOdoDeltas(reset);
check("reset: the drop is rejected exactly once", resetSum.rejected, 1);
check("reset: it is tagged a reset, not a rate or gap", resetSum.reasons, { reset: 1 });
check("reset: the dropped magnitude is recorded, not lost",
	Math.round(resetSum.droppedMiles), 219818);
check("reset: real miles either side are still counted", resetSum.miles, 98);
check("reset: the day is partial, not eld", m.dayBasis(resetSum), "partial");
// The control: prove the test discriminates rather than passing on anything.
check("reset: the naive span it replaces is NEGATIVE (the control)",
	reset[reset.length - 1].odo - reset[0].odo < 0, true);

// ---------------------------------------------------------------------------
// 3. THE REAL 1,247-MILE DAY must survive untouched.
// ---------------------------------------------------------------------------
const bigDay = run(T0, 500000, 701, 1.78);
const bigSum = m.sumOdoDeltas(bigDay);
check("1,247-mile day: kept in full", Math.round(bigSum.miles), 1246);
check("1,247-mile day: nothing rejected — there is no per-day cap", bigSum.rejected, 0);
check("1,247-mile day: still counts as eld", m.dayBasis(bigSum), "eld");

// ---------------------------------------------------------------------------
// 4. A PARKED TRUCK is not an anomaly.
// ---------------------------------------------------------------------------
const parked = run(T0, 900000, 500, 0);
const parkedSum = m.sumOdoDeltas(parked);
check("parked: zero miles", parkedSum.miles, 0);
check("parked: ZERO deltas are accepted, not rejected", parkedSum.rejected, 0);
check("parked: basis stays eld — a parked day is fully observed",
	m.dayBasis(parkedSum), "eld");

// ---------------------------------------------------------------------------
// 5. DROPPED, NEVER CARRIED. The stretches either side must still be right.
// ---------------------------------------------------------------------------
const jumpA = run(T0, 100000, 30, 1.0);
const jumpB = run(T0 + 30 * MIN, 100029 + 5000, 30, 1.0); // +5000 mi in one minute
const jumped = [...jumpA, ...jumpB];
const jumpSum = m.sumOdoDeltas(jumped);
check("rate outlier: rejected as a rate, not accepted", jumpSum.reasons, { rate: 1 });
check("rate outlier: the 5,000 is NOT carried into the total", jumpSum.miles, 58);
check("rate outlier: its magnitude is recorded", Math.round(jumpSum.droppedMiles), 5000);

// ---------------------------------------------------------------------------
// 6. THE GAP GUARD, and the overnight rest that must not trip it.
// ---------------------------------------------------------------------------
const darkA = run(T0, 700000, 20, 1.0);
const darkB = run(T0 + 15 * 24 * HOUR, 700019 + 3000, 20, 1.0);
const dark = m.sumOdoDeltas([...darkA, ...darkB]);
check("15 dark days then +3,000 mi: rejected as a gap", dark.reasons, { gap: 1 });
check("15 dark days: the return is not dumped onto one day", dark.miles, 38);
check("15 dark days: basis is partial", m.dayBasis(dark), "partial");

// An ignition-only ELD rests 10 h overnight and does not move. The gap is long
// but the delta is ~0, so guard 4 accepts it and the day stays fully observed.
const restA = run(T0, 300000, 20, 1.0);
const restB = run(T0 + 19 * MIN + 10 * HOUR, 300019, 20, 1.0);
const rest = m.sumOdoDeltas([...restA, ...restB]);
check("overnight rest: not rejected", rest.rejected, 0);
check("overnight rest: does not flag the day partial", m.dayBasis(rest), "eld");
check("overnight rest: no gap recorded — the truck did not move",
	rest.maxGapMs, 0);

// A 4.9-mile creep across a 7-hour gap: under the floor, so accepted, because
// the floor guard deliberately precedes the gap guard.
const creep = m.sumOdoDeltas([
	{ ms: T0, odo: 400000, lng: -95 },
	{ ms: T0 + 7 * HOUR, odo: 400004.9, lng: -95 },
]);
check("sub-floor creep across a long gap is accepted", creep.miles, 4.9);
check("sub-floor creep does not flag partial", m.dayBasis(creep), "eld");

// ---------------------------------------------------------------------------
// 7. DUPLICATE TIMESTAMPS — real in this table, and what divides by zero.
// ---------------------------------------------------------------------------
const dupes = m.sumOdoDeltas([
	{ ms: T0, odo: 100000, lng: -95 },
	{ ms: T0, odo: 100000, lng: -95 },
	{ ms: T0 + MIN, odo: 100001, lng: -95 },
	{ ms: T0 + MIN, odo: 100001, lng: -95 },
	{ ms: T0 + 2 * MIN, odo: 100002, lng: -95 },
]);
check("duplicate timestamps: deduped, not double-counted", dupes.miles, 2);
check("duplicate timestamps: no divide-by-zero rejection", dupes.rejected, 0);
check("duplicate timestamps: sample count is the deduped count", dupes.samples, 3);

// ---------------------------------------------------------------------------
// 8. JUNK must not throw or invent miles.
// ---------------------------------------------------------------------------
check("empty input", m.sumOdoDeltas([]).miles, 0);
check("null input", m.sumOdoDeltas(null).miles, 0);
check("empty input has no basis to claim", m.dayBasis(m.sumOdoDeltas([])), "no-data");
const junk = m.sumOdoDeltas([
	{ ms: T0, odo: 0, lng: -95 },          // zero odometer — never a real tractor
	{ ms: T0 + MIN, odo: null, lng: -95 },
	{ ms: T0 + 2 * MIN, odo: 100000, lng: -95 },
	{ ms: T0 + 3 * MIN, odo: 100001, lng: -95 },
]);
check("junk odometers are skipped, real ones still counted", junk.miles, 1);
check("unsorted input is ordered before walking",
	m.sumOdoDeltas([
		{ ms: T0 + 2 * MIN, odo: 100002, lng: -95 },
		{ ms: T0, odo: 100000, lng: -95 },
		{ ms: T0 + MIN, odo: 100001, lng: -95 },
	]).miles, 2);

// ---------------------------------------------------------------------------
// 9. basisLabel — a period is only 'eld' if we saw all of it.
// ---------------------------------------------------------------------------
check("a week of clean days is eld", m.basisLabel(["eld", "eld", "eld"]), "eld");
check("one partial day makes the week partial",
	m.basisLabel(["eld", "partial", "eld"]), "partial");
check("all no-data stays no-data", m.basisLabel(["no-data", "no-data"]), "no-data");
check("some data beats none", m.basisLabel(["no-data", "eld"]), "partial");
check("nothing at all is no-data, never eld", m.basisLabel([]), "no-data");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
