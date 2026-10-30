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

// ⚠️ AGE APPLIES TO A POSITIVE READING TOO. Found on production before this was
// enforced: LogisX-#2372's last fix was 161 h old and LogisX-#302's 528 h old,
// both with a positive fuel_pct — so both resolved to `live`, showed a confident
// range with nothing marking it stale, and would have fired a low-fuel alert
// about trucks silent for a week and three weeks. A reading is stale because of
// its AGE, never because of which branch found it.
const oldButPositive = RES(rows([[12, 1000, minsAgo(60 * 24 * 22)]]));
check("a 22-day-old POSITIVE reading is stale, not live",
	oldButPositive.fuelSource === "stale", `got ${oldButPositive.fuelSource}`);
check("...and publishes no fuel percentage", oldButPositive.fuelPct === null);
check("...but still reports what was last known", oldButPositive.anchorPct === 12);
check("a fresh positive reading is still live",
	RES(rows([[12, 1000, minsAgo(30)]])).fuelSource === "live");
check("live now reports its true age, not a hardcoded 0",
	RES(rows([[12, 1000, minsAgo(30)]])).ageMinutes === 30);
// An undatable reading cannot be aged, so it cannot be trusted as current.
check("a reading with no timestamp is not called live",
	fm.resolveFuelReading({ rows: [{ fuel_pct: 40, odometer: 1000 }], mpg: 6.5, tankGallons: 240, nowMs: NOW })
		.fuelSource !== "live");

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
section("§7 driver gallons: no wrong number (planDriverFuel, DRIVER_FUEL_GALLONS_ENABLED)");
// Every state the driver app cannot work a number out for says so in plain
// words instead. Made-up truck; the replay at the end reuses §5's incident.
// Each call is caught, so a base without planDriverFuel fails case by case.
const attempt = (fn) => { try { return fn(); } catch (e) { return { error: e.message, legs: [] }; } };
const R15 = { minMiles: 15, fraction: 0 };
const BURN5 = { usable: true, p10: 5.0, p50: 7.4, p90: 10.2, milesPerPoint: 7.4 };
const tripFor = (pct, burn, tank) => fm.planTripFuel({
	routeMiles: 420, fuelPct: pct, burn, mpg: 6.0, reserve: R15,
	rangeMiles: fm.computeRange({ fuelPct: pct, tankGallons: tank, mpg: 6.0 }).rangeMiles,
});
const DF = ({ reading, burn = BURN5, tankSource = "truck", tank = 150, hasTruck = true, fromLivePosition = true } = {}) =>
	attempt(() => fm.planDriverFuel({
		plan: tripFor(reading ? reading.fuelPct : null, burn, tank), leg: "to_delivery", fromLivePosition, positionAgeMinutes: 5,
		reading, hasTruck, hasDevice: hasTruck, tankSource, tankGallons: tank, mpg: 6.0, burn, reserve: R15,
	}));
const NO_READING = { fuelPct: null, fuelSource: "none", anchorPct: null, ageMinutes: null };
const STALE = { fuelPct: null, fuelSource: "stale", anchorPct: 27, ageMinutes: 18 * 60 };
const allCheckGauge = (df) => Array.isArray(df.legs) && df.legs.length > 0
	&& df.legs.every((l) => l.status === "check_gauge" && l.needInTankGallons > 0 && l.addGallons === null);

const none = DF({ reading: NO_READING });
check("no ELD fuel reading: fuelState 'none', no miles, not refuel-now", none.fuelState === "none" && none.milesLeft === null && none.refuelNow === false,
	JSON.stringify(none));
check("...its rows say what the tank needs to finish and to check the gauge", allCheckGauge(none), JSON.stringify(none.legs));
check("...420 + 15 mi at the planning rate (150 gal / 100 pts / 5.0 mi a pt = 0.3 gal a mile), +10%: 145 gal in the tank",
	none.legs[0] && none.legs[0].needInTankGallons === 145, JSON.stringify(none.legs));
const stale = DF({ reading: STALE });
check("ELD silent past 12 h: fuelState 'stale', no miles, the reading's own age (18 h)",
	stale.fuelState === "stale" && stale.milesLeft === null && stale.fuelReadAgeMinutes === 1080, JSON.stringify(stale));
check("...its rows check the gauge", allCheckGauge(stale));
const carriedDF = DF({ reading: { fuelPct: 33.6, fuelSource: "carried", anchorPct: 40, ageMinutes: 60, milesSinceReading: 100 } });
check("sensor dropout (carried): numbers, marked 'estimated'",
	carriedDF.fuelState === "estimated" && Number.isFinite(carriedDF.milesLeft) && carriedDF.milesLeft > 0
		&& carriedDF.legs.every((l) => l.status !== "check_gauge"), JSON.stringify(carriedDF));
const LIVE40 = { fuelPct: 40, fuelSource: "live", anchorPct: 40, ageMinutes: 5 };
const noTank = DF({ reading: LIVE40, burn: NO_BURN, tankSource: "default", tank: 200 });
check("estimated basis + no tank size: 'no_tank_size', no miles, rows check the gauge",
	noTank.fuelState === "no_tank_size" && noTank.milesLeft === null && allCheckGauge(noTank), JSON.stringify(noTank));
const estTruckTank = DF({ reading: LIVE40, burn: NO_BURN, tankSource: "truck", tank: 150 });
check("...paired: estimated basis + the truck's own tank size shows a number",
	estTruckTank.fuelState === "live" && Number.isFinite(estTruckTank.milesLeft), JSON.stringify(estTruckTank));
const measuredNoTank = DF({ reading: LIVE40, burn: BURN5, tankSource: "default", tank: 200 });
check("...paired: measured basis + no tank size shows a number (miles per gauge point needs no tank)",
	measuredNoTank.fuelState === "live" && measuredNoTank.milesLeft === 185, JSON.stringify(measuredNoTank));
const EMPTY = { fuelPct: 0, fuelSource: "live", anchorPct: 0, ageMinutes: 5 };
for (const [label, opts] of [["measured", { burn: BURN5 }], ["estimated + truck tank", { burn: NO_BURN }],
	["estimated + no tank size", { burn: NO_BURN, tankSource: "default", tank: 200 }]]) {
	const empty = DF({ reading: EMPTY, ...opts });
	check(`0% is milesLeft 0 and refuel-now, never null (${label})`, empty.milesLeft === 0 && empty.refuelNow === true, JSON.stringify(empty));
}
check("...with no tank size the rows still only check the gauge (how far a full tank goes is unknown)",
	allCheckGauge(DF({ reading: EMPTY, burn: NO_BURN, tankSource: "default", tank: 200 })));
const noTruck = DF({ reading: NO_READING, hasTruck: false, fromLivePosition: false });
check("no truck linked: 'no_truck', no miles, no reading age, one whole-load row to check the gauge",
	noTruck.fuelState === "no_truck" && noTruck.milesLeft === null && noTruck.fuelReadAgeMinutes === null
		&& noTruck.legs.length === 1 && noTruck.legs[0].key === "whole_load" && allCheckGauge(noTruck), JSON.stringify(noTruck));
const rangeNone = attempt(() => fm.planDriverFuel({ reading: NO_READING, hasTruck: true, hasDevice: true, tankSource: "truck", tankGallons: 150, mpg: 6.0 }));
check("the range block (no plan) with no reading: 'none', milesLeft null, no legs",
	rangeNone.fuelState === "none" && rangeNone.milesLeft === null && Array.isArray(rangeNone.legs) && rangeNone.legs.length === 0, JSON.stringify(rangeNone));
// §5's real incident through the driver block: the carried reading floors at 0.
const incidentDF = attempt(() => fm.planDriverFuel({
	reading: incident, hasTruck: true, hasDevice: true, tankSource: "truck", tankGallons: TANK, mpg: MPG, burn: NO_BURN, reserve: R15,
}));
check("incident replay: the driver sees 0 miles and Refuel now, marked estimated — never a blank",
	incidentDF.milesLeft === 0 && incidentDF.refuelNow === true && incidentDF.fuelState === "estimated", JSON.stringify(incidentDF));

// A reading the truck may have driven far past, or one decayed against a guessed
// tank, is never a number to plan on (fix round on the planDriverFuel read).
const LIVE90 = (ageMinutes) => ({ fuelPct: 90, fuelSource: "live", anchorPct: 90, ageMinutes, milesSinceReading: 0 });
const oldLive = DF({ reading: LIVE90(9 * 60) });
check("a live reading 9 h old: 'stale', no miles, no 'enough' (90% at 5.0 mi a point would have cleared 420 mi)",
	oldLive.fuelState === "stale" && oldLive.milesLeft === null && oldLive.fuelReadAgeMinutes === 540 && allCheckGauge(oldLive), JSON.stringify(oldLive));
const at6h = DF({ reading: LIVE90(360) });
const past6h = DF({ reading: LIVE90(361) });
check("...the line is the trip plan's 6 h: 360 min is live and clears, 361 min is stale",
	at6h.fuelState === "live" && at6h.legs[0] && at6h.legs[0].status === "enough" && past6h.fuelState === "stale", `${at6h.fuelState} ${past6h.fuelState}`);
const carriedOld = DF({ reading: { fuelPct: 30, fuelSource: "carried", anchorPct: 30, ageMinutes: 7 * 60, milesSinceReading: 50 } });
check("a carried reading 7 h old: 'stale', no miles", carriedOld.fuelState === "stale" && carriedOld.milesLeft === null, JSON.stringify(carriedOld));
const carriedBlind = DF({ reading: { fuelPct: 90, fuelSource: "carried", anchorPct: 90, ageMinutes: 30, milesSinceReading: null } });
check("a carried reading with no odometer to decay it (carried unchanged): 'stale', no 'enough'",
	carriedBlind.fuelState === "stale" && carriedBlind.milesLeft === null && allCheckGauge(carriedBlind), JSON.stringify(carriedBlind));
const carriedGuess = DF({ reading: { fuelPct: 27, fuelSource: "carried", anchorPct: 50, ageMinutes: 90, milesSinceReading: 300 },
	burn: BURN5, tankSource: "default", tank: 200 });
check("no tank size + a carried reading over a dropout (decayed against the 200-gal guess): 'no_tank_size', check the gauge",
	carriedGuess.fuelState === "no_tank_size" && carriedGuess.milesLeft === null && allCheckGauge(carriedGuess), JSON.stringify(carriedGuess));
const carriedStill = DF({ reading: { fuelPct: 50, fuelSource: "carried", anchorPct: 50, ageMinutes: 20, milesSinceReading: 0 },
	burn: BURN5, tankSource: "default", tank: 200 });
check("...paired: the same truck parked through the dropout (0 mi, nothing decayed) keeps its number",
	carriedStill.fuelState === "estimated" && carriedStill.milesLeft === 235, JSON.stringify(carriedStill));

const mentions = (t) => attempt(() => fm.detailsMentionExtraStops(t));
for (const t of ["3 stops: Riverton, Midway, Lakeside", "Multi-stop load", "multistop", "Stop 2 Midway", "stop #3", "2 pickups", "2nd stop Midway", "extra stop", "stop-offs"]) {
	check(`extra stops caught in Details: ${JSON.stringify(t)}`, mentions(t) === true, JSON.stringify(mentions(t)));
}
for (const t of ["Dairy Pure Whole Milk, 43,764 lbs, 1,575 cases, 21 pallets, reefer 34F", "Riverton, ST - Lakeside, ST", "nonstop", "Non-stop team",
	"truck stop 24/7", "1 stop", "", null, 42]) {
	check(`no extra stops read into ${JSON.stringify(t)}`, mentions(t) === false, JSON.stringify(mentions(t)));
}
const t0 = process.hrtime.bigint();
const ws = mentions(`stop${" ".repeat(10000)}2 stops`);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
check("a 10k-whitespace Details stays under 50 ms (bounded, capped at 300 characters)", ms < 50 && ws === false, `${ms.toFixed(2)} ms, ${JSON.stringify(ws)}`);
const stopList = (p) => attempt(() => fm.stopListShowsExtraStops(p));
check("stop list: two pickups or two deliveries are extra stops",
	stopList(JSON.stringify({ stops: [{ kind: "pickup" }, { kind: "pickup" }, { kind: "delivery" }] })) === true
		&& stopList({ stops: [{ kind: "pickup" }, { kind: "delivery" }, { kind: "delivery" }] }) === true);
check("stop list: one pickup and one delivery, none, or unreadable text are not",
	[stopList({ stops: [{ kind: "pickup" }, { kind: "delivery" }] }), stopList(null), stopList("{not json"), stopList({ stops: "x" })]
		.every((v) => v === false));

// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
process.exit(fail === 0 ? 0 : 1);
