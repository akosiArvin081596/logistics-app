#!/usr/bin/env node
"use strict";
// Locks the 2026-08-17 run-dry fix in lib/fuel-model.js.
//
// The defect: a genuinely EMPTY tank (fuel_pct = 0) was folded into the same
// "we have no data" bucket as a missing reading, because rangeInterval() gated
// its point estimate through isPos() — strictly > 0. verdict came back
// 'unknown', the dispatcher panel printed "No verdict" with no number, and the
// driver read a blank card as "nothing to worry about" and ran out of fuel.
//
// §0 runs the RETIRED guard as a control, so these expectations are demonstrably
// a fix and not a preference. §5 replays the real production numbers.
//
// Run: node scripts/test-fuel-zero-range.js   (exits 1 on any failure)

const path = require("path");
const fm = require(path.join(__dirname, "..", "lib", "fuel-model.js"));

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, detail = "") {
	if (cond) { pass++; return; }
	fail++;
	failures.push(`${label}${detail ? "  — " + detail : ""}`);
	console.log(`  ✗ ${label}${detail ? "  — " + detail : ""}`);
}
function section(t) { console.log(`\n${t}`); }

// A truck with no measured burn history — the common case, and the incident's.
const NO_BURN = { usable: false, p10: null, p50: null, p90: null, milesPerPoint: null };
// A truck WITH measured legs, for the branch that already handled 0 correctly.
const BURN = { usable: true, p10: 2.0, p50: 3.0, p90: 4.0, milesPerPoint: 3.0 };

// ---------------------------------------------------------------------------
section("§0 CONTROL — the retired guard still reproduces the bug");
// The pre-fix line was `if (!isPos(point)) return none;`. Re-implemented here so
// the section cannot pass on an inert extraction: if this control ever stops
// showing 'unknown', the control itself is broken, not the fix.
function retiredIsPos(n) { return n != null && n > 0; }
function retiredRangeIntervalWouldReturnNone(pct, rangeMiles) {
	if (pct == null) return true;              // unchanged by the fix
	return !retiredIsPos(rangeMiles);          // the retired guard
}
check("retired guard discards a real 0 (this IS the bug)",
	retiredRangeIntervalWouldReturnNone(0, 0) === true);
check("retired guard kept a positive estimate",
	retiredRangeIntervalWouldReturnNone(40, 260) === false);
// ...and the shipped code must now disagree with it on exactly that input.
const fixed0 = fm.rangeInterval({ fuelPct: 0, burn: NO_BURN, rangeMiles: 0 });
check("shipped code now KEEPS the 0 the retired guard discarded",
	fixed0.planning === 0 && fixed0.basis === "estimated",
	`got planning=${fixed0.planning} basis=${fixed0.basis}`);

// ---------------------------------------------------------------------------
section("§1 zero is a measurement, not missing data");
check("rangeInterval: planning is 0, not null", fixed0.planning === 0);
check("rangeInterval: basis is 'estimated', not 'unknown'", fixed0.basis === "estimated");
check("rangeInterval: low is 0", fixed0.low === 0);
check("rangeInterval: typical stays null on an estimated basis", fixed0.typical === null);

const plan0 = fm.planTripFuel({ routeMiles: 215, fuelPct: 0, burn: NO_BURN, rangeMiles: 0, mpg: 6.5 });
check("planTripFuel: verdict is 'insufficient', NOT 'unknown'", plan0.verdict === "insufficient",
	`got ${plan0.verdict}`);
check("planTripFuel: canMakeIt is false (not null)", plan0.canMakeIt === false);
check("planTripFuel: shortfall equals the whole route", plan0.shortfallMiles === 215,
	`got ${plan0.shortfallMiles}`);
check("planTripFuel: refuelWithinMiles is 0 — stop now", plan0.refuelWithinMiles === 0);
check("planTripFuel: decidedOn is 0, so the card can show its work", plan0.decidedOn === 0);

// The measured branch already handled 0; prove it still does.
const measured0 = fm.rangeInterval({ fuelPct: 0, burn: BURN, rangeMiles: 0 });
check("measured basis at 0% is still 'measured' with planning 0",
	measured0.basis === "measured" && measured0.planning === 0);

// ---------------------------------------------------------------------------
section("§2 the distinction survives — a MISSING reading is still unknown");
const missing = fm.rangeInterval({ fuelPct: null, burn: NO_BURN, rangeMiles: null });
check("null fuelPct -> basis 'unknown'", missing.basis === "unknown");
check("null fuelPct -> planning null", missing.planning === null);
const planMissing = fm.planTripFuel({ routeMiles: 215, fuelPct: null, burn: NO_BURN, rangeMiles: null, mpg: 6.5 });
check("null fuelPct -> verdict 'unknown'", planMissing.verdict === "unknown", `got ${planMissing.verdict}`);
check("null fuelPct -> canMakeIt null", planMissing.canMakeIt === null);
// A negative range is nonsense and must NOT be treated as a measurement.
check("negative rangeMiles -> unknown",
	fm.rangeInterval({ fuelPct: 10, burn: NO_BURN, rangeMiles: -5 }).basis === "unknown");

// ---------------------------------------------------------------------------
section("§3 the 15-mile buffer (client request 2026-08-17)");
check("default reserve is 15", fm.tripReserveMiles(215) === 15, `got ${fm.tripReserveMiles(215)}`);
check("default reserve is flat — 1000-mi route is still 15", fm.tripReserveMiles(1000) === 15,
	`got ${fm.tripReserveMiles(1000)}`);
check("exported TRIP_RESERVE_MIN_MI is 15", fm.TRIP_RESERVE_MIN_MI === 15);
check("exported TRIP_RESERVE_FRACTION is 0", fm.TRIP_RESERVE_FRACTION === 0);
check("plan reports the 15 it used", plan0.reserveMiles === 15, `got ${plan0.reserveMiles}`);
check("required = route + 15", plan0.requiredMiles === 230, `got ${plan0.requiredMiles}`);
// Override path (server.js passes env values through here).
check("override minMiles is honoured", fm.tripReserveMiles(215, { minMiles: 50 }) === 50);
check("override fraction is honoured", fm.tripReserveMiles(215, { minMiles: 0, fraction: 0.10 }) === 22,
	`got ${fm.tripReserveMiles(215, { minMiles: 0, fraction: 0.10 })}`);
check("override reaches planTripFuel",
	fm.planTripFuel({ routeMiles: 215, fuelPct: 0, burn: NO_BURN, rangeMiles: 0, mpg: 6.5,
		reserve: { minMiles: 50 } }).reserveMiles === 50);
// A bad override must never shrink the buffer by accident.
check("garbage override falls back to the default", fm.tripReserveMiles(215, { minMiles: "abc" }) === 15);
check("negative override falls back to the default", fm.tripReserveMiles(215, { minMiles: -100 }) === 15);

// ---------------------------------------------------------------------------
section("§4 carry-forward survives a dropping sensor, and only ever LOWERS");
// Timestamps are real epoch ms relative to a fixed NOW, because staleness is now
// judged on the wall clock. NOW is pinned so the suite is deterministic.
const NOW = Date.parse("2026-08-18T12:00:00Z");
const minsAgo = (m) => NOW - m * 60000;
const rows = (arr) => arr.map(([pct, odo, ms]) => ({ fuel_pct: pct, odometer: odo, location_date_ms: ms }));
const RES = (rowsIn, extra = {}) =>
	fm.resolveFuelReading({ rows: rowsIn, mpg: 6.5, tankGallons: 240, nowMs: NOW, ...extra });

const live = RES(rows([[29, 1000, minsAgo(1)]]));
check("a positive live reading is used as-is", live.fuelPct === 29 && live.fuelSource === "live");

// newest-first: latest is a dropout 0, anchor is 40% one hundred miles back.
const carried = RES(rows([[0, 1100, minsAgo(10)], [0, 1050, minsAgo(30)], [40, 1000, minsAgo(60)]]));
check("dropout carries the last credible reading", carried.fuelSource === "carried");
check("carried reports the anchor it used", carried.anchorPct === 40);
check("carried reports miles since that reading", carried.milesSinceReading === 100);
// 100 mi / 6.5 mpg = 15.38 gal; /240 * 100 = 6.4 pts. 40 - 6.4 = 33.6
check("carried subtracts the fuel burned since", Math.abs(carried.fuelPct - 33.6) < 0.2,
	`got ${carried.fuelPct}`);
check("carried NEVER exceeds the anchor", carried.fuelPct <= carried.anchorPct);
check("age is WALL-CLOCK, not the anchor→latest device gap", carried.ageMinutes === 60,
	`got ${carried.ageMinutes}`);

// Burn larger than the anchor floors at 0 rather than going negative.
const drained = RES(rows([[0, 3000, minsAgo(10)], [1, 1000, minsAgo(120)]]));
check("burn beyond the anchor floors at 0, never negative", drained.fuelPct === 0,
	`got ${drained.fuelPct}`);

// All-zero window is the genuine no-sensor signature — must NOT invent a number.
const noSensor = RES(rows([[0, 1100, minsAgo(5)], [0, 1000, minsAgo(60)]]));
check("an all-zero window yields 'none', not a fabricated number",
	noSensor.fuelSource === "none" && noSensor.fuelPct === null);
check("no rows at all yields 'none'", fm.resolveFuelReading({ rows: [] }).fuelSource === "none");
// A non-monotonic odometer must not manufacture fuel.
const backwards = RES(rows([[0, 900, minsAgo(10)], [30, 1000, minsAgo(60)]]));
check("a backwards odometer cannot raise the estimate", backwards.fuelPct <= backwards.anchorPct);

// Universal: across a sweep of anchors and distances, carried <= anchor ALWAYS.
let violations = 0;
for (let anchorPct = 1; anchorPct <= 100; anchorPct += 1) {
	for (let miles = 0; miles <= 600; miles += 25) {
		const r = RES(rows([[0, 1000 + miles, minsAgo(10)], [anchorPct, 1000, minsAgo(60)]]));
		if (!(r.fuelPct <= anchorPct + 1e-9) || r.fuelPct < 0) violations++;
	}
}
check("carry-forward is monotonic across 2,500 combinations", violations === 0,
	`${violations} violation(s)`);

// ---------------------------------------------------------------------------
section("§4b A DEAD ELD MUST NOT PRODUCE A CONFIDENT RANGE");
// Regression for a defect found during verification: LogisX-#33 stopped
// reporting on 2026-08-14 and the poller re-stored the same frozen fix every
// 15s — odometer included. Carrying its last 27% forward subtracted ZERO burn
// (the odometer never moves) and produced "CLEARS, 293 mi" for a truck silent
// for 3.6 days. Optimistic, and strictly worse than the blank panel.
const deadEld = RES(rows([
	[0, 866515, minsAgo(60 * 24 * 3)],   // latest "fix" is itself 3 days old
	[27, 866515, minsAgo(60 * 24 * 3 + 242)],
]));
check("a 3-day-old anchor is refused, not carried", deadEld.fuelSource === "stale",
	`got ${deadEld.fuelSource}`);
check("stale yields NO fuel percentage", deadEld.fuelPct === null);
check("stale still reports what was last known", deadEld.anchorPct === 27);
check("stale reports the real age in wall-clock minutes", deadEld.ageMinutes > 60 * 24 * 3,
	`got ${deadEld.ageMinutes}`);
// ...and a stale reading must not become a range or a verdict.
const deadPlan = fm.planTripFuel({
	routeMiles: 215, fuelPct: deadEld.fuelPct, burn: NO_BURN,
	rangeMiles: fm.computeRange({ fuelPct: deadEld.fuelPct, tankGallons: 300, mpg: 6.5 }).rangeMiles,
	mpg: 6.5,
});
check("a stale reading yields verdict 'unknown', never 'clears'",
	deadPlan.verdict === "unknown", `got ${deadPlan.verdict}`);
// The boundary is honoured in both directions.
check("just inside the window still carries",
	RES(rows([[0, 1000, minsAgo(1)], [40, 1000, minsAgo(11 * 60)]])).fuelSource === "carried");
check("just outside the window goes stale",
	RES(rows([[0, 1000, minsAgo(1)], [40, 1000, minsAgo(13 * 60)]])).fuelSource === "stale");
check("the ceiling is overridable",
	RES(rows([[0, 1000, minsAgo(1)], [40, 1000, minsAgo(13 * 60)]]),
		{ maxCarryMinutes: 20 * 60 }).fuelSource === "carried");
// Fail-safe: a caller that forgets nowMs must not fail OPEN.
check("omitting nowMs treats an ancient fixture as stale, not live",
	fm.resolveFuelReading({ rows: rows([[0, 1000, 9000], [40, 1000, 5000]]), mpg: 6.5, tankGallons: 240 })
		.fuelSource === "stale");

// ---------------------------------------------------------------------------
section("§5 REPLAY — the real 2026-08-17 incident (production values)");
// Logisx-#91 / wL8e55NU0KjcB2ynE2wf1g, tank 240 gal, mpg 6.5.
// Last credible reading 1% at 22:45:11 UTC, odometer 775383.
// At the screenshot: odometer 775575 (192 mi later), fuel_pct 0. Route left 215 mi.
const TANK = 240, MPG = 6.5, ROUTE = 215;
// nowMs pinned to the moment of the screenshot: the anchor is 3h05m old, well
// inside the 12h carry window, so this is a live dropout and not a dead device.
const INCIDENT_NOW = Date.parse("2026-08-18T01:49:52Z");
const incident = fm.resolveFuelReading({
	rows: rows([
		[0, 775575, Date.parse("2026-08-18T01:49:52Z")],
		[0, 775500, Date.parse("2026-08-18T01:00:00Z")],
		[1, 775383, Date.parse("2026-08-17T22:45:11Z")],
	]),
	mpg: MPG, tankGallons: TANK, nowMs: INCIDENT_NOW,
});
check("incident: reading is carried, not trusted live", incident.fuelSource === "carried");
check("incident: anchor is the real 1%", incident.anchorPct === 1);
check("incident: 192 miles driven since", incident.milesSinceReading === 192,
	`got ${incident.milesSinceReading}`);
check("incident: carried fuel floors at 0 — she could not finish", incident.fuelPct === 0);
// 22:45:11 -> 01:49:52 is 3h 04m 41s = 184.68 min, which rounds to 185.
check("incident: age is reported (185 min)", incident.ageMinutes === 185, `got ${incident.ageMinutes}`);

const range = fm.computeRange({ fuelPct: incident.fuelPct, tankGallons: TANK, mpg: MPG });
const incidentPlan = fm.planTripFuel({
	routeMiles: ROUTE, fuelPct: incident.fuelPct, burn: NO_BURN, rangeMiles: range.rangeMiles, mpg: MPG,
});
check("incident: verdict is 'insufficient' (was 'unknown' -> \"No verdict\")",
	incidentPlan.verdict === "insufficient", `got ${incidentPlan.verdict}`);
check("incident: a NUMBER reaches the panel", incidentPlan.decidedOn === 0);
check("incident: short by the whole route", incidentPlan.shortfallMiles === 215);
check("incident: refuel within 0 miles — stop now", incidentPlan.refuelWithinMiles === 0);
check("incident: needs 230 mi (215 + the client's 15)", incidentPlan.requiredMiles === 230);
console.log(`  → panel would now read: ${incidentPlan.verdict.toUpperCase()}, short by ` +
	`${incidentPlan.shortfallMiles} mi, refuel within ${incidentPlan.refuelWithinMiles} mi ` +
	`(last credible ${incident.anchorPct}%, ${incident.milesSinceReading} mi ago)`);

// ---------------------------------------------------------------------------
section("§6 a truck that genuinely clears must still clear");
const healthy = fm.planTripFuel({
	routeMiles: 100, fuelPct: 80, burn: BURN, rangeMiles: 900, mpg: 6.5,
});
check("healthy truck clears", healthy.verdict === "clears", `got ${healthy.verdict}`);
check("healthy truck canMakeIt", healthy.canMakeIt === true);
check("healthy truck has zero shortfall", healthy.shortfallMiles === 0);

// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
process.exit(fail === 0 ? 0 : 1);
