#!/usr/bin/env node
// scripts/test-fuel-approach-leg.js — the run to the shipper burns fuel.
//
// Locks the 2026-09-18 owner report. GET /api/fuel/trip-plan planned
// `from` -> DELIVERY in one hop with the pickup nowhere in it, so for a truck
// that had not collected yet the number was not "pickup to drop-off" — it was a
// SHORTCUT PAST THE SHIPPER. And because d(T,D) <= d(T,P) + d(P,D), the answer
// was always <= the miles actually ahead of the driver: it UNDERSTATED the fuel
// needed, which is the one direction a verdict allowed to say "clears" must
// never err in.
//
// No network, no server: the leg decision and the trip maths are both pure.

"use strict";
const assert = require("assert");
const fuel = require("../lib/fuel-model");

let failed = 0;
const check = (name, fn) => {
	try { fn(); console.log(`ok    ${name}`); }
	catch (e) { failed++; console.error(`FAIL  ${name}\n      ${e.message}`); }
};

// --- which leg is still ahead ---------------------------------------------
check("pre-pickup statuses are NOT picked up", () => {
	for (const s of ["Assigned", "Dispatched", "Heading to Shipper", "New", "Pending"]) {
		assert.strictEqual(fuel.isPickedUp(s), false, `${s} should not count as collected`);
	}
});
check("post-pickup statuses ARE picked up", () => {
	for (const s of ["At Shipper", "Loading", "In Transit", "At Receiver", "Unloading"]) {
		assert.strictEqual(fuel.isPickedUp(s), true, `${s} should count as collected`);
	}
});
check("status match is case-insensitive and trimmed", () => {
	assert.strictEqual(fuel.isPickedUp("  in TRANSIT "), true);
});
check("a blank/unknown status counts as NOT collected", () => {
	// The safe direction: it plans the approach leg IN, overstating rather than
	// understating the fuel needed.
	assert.strictEqual(fuel.isPickedUp(""), false);
	assert.strictEqual(fuel.isPickedUp(null), false);
	assert.strictEqual(fuel.isPickedUp("Backhaul Scheduled"), false);
});

check("approach leg is planned only pre-pickup, with a fix and a pickup", () => {
	const t = (o) => fuel.shouldPlanApproach(o);
	assert.strictEqual(t({ fixFresh: true,  pickedUp: false, hasPickup: true  }), true,  "the whole point");
	assert.strictEqual(t({ fixFresh: true,  pickedUp: true,  hasPickup: true  }), false, "already loaded — approach is zero by definition");
	assert.strictEqual(t({ fixFresh: false, pickedUp: false, hasPickup: true  }), false, "no fix — no truck position to measure from");
	assert.strictEqual(t({ fixFresh: true,  pickedUp: false, hasPickup: false }), false, "no geocoded pickup to route to");
});

// --- the maths, and the case that was silently wrong -----------------------
// A truck with a genuinely measured ~470 mi of usable range.
const BURN = { usable: true, p10: 5.0, p50: 7.4, p90: 10.2, n: 40, miles: 9000,
	// Aggregate miles-per-gauge-point. pointsNeeded is deliberately null without
	// it — see the comment at lib/fuel-model.js:1146.
	points: 1216, milesPerPoint: 7.4 };
const PLAN = (routeMiles) => fuel.planTripFuel({
	routeMiles, fuelPct: 95, burn: BURN, rangeMiles: 700, mpg: 6.5,
	reserve: { minMiles: 15, fraction: 0 },
});

check("a longer route needs more fuel and more gauge", () => {
	const lane = PLAN(400);
	const both = PLAN(400 + 300);
	assert.ok(both.gallonsNeeded > lane.gallonsNeeded, "gallons must rise with the deadhead");
	assert.ok(both.pointsNeeded > lane.pointsNeeded, "gauge points must rise with the deadhead");
	assert.ok(both.requiredMiles > lane.requiredMiles, "required miles must rise with the deadhead");
});

check("THE REGRESSION: clears on the lane alone, fails once the deadhead counts", () => {
	// 95% x p10 5.0 = 475 mi of planning range.
	const lane = PLAN(400);          // 400 + 15 reserve = 415 <= 475 -> fine
	const both = PLAN(400 + 300);    // 700 + 15 reserve = 715  > 475 -> NOT fine
	assert.strictEqual(lane.verdict, "clears",
		`lane-only should clear, got ${lane.verdict}`);
	assert.notStrictEqual(both.verdict, "clears",
		"with the run to the shipper counted this must NOT say it clears — " +
		"this is the exact case that was silently wrong before 2026-09-18");
	assert.ok(both.shortfallMiles > 0, "a real shortfall must be reported");
});

check("refuelWithinMiles is route-independent (tank range, not trip length)", () => {
	// It is planning range minus reserve, so adding the approach leg must not move
	// it — only the verdict and the fuel/gauge figures change.
	assert.strictEqual(PLAN(400).refuelWithinMiles, PLAN(900).refuelWithinMiles);
});

check("summing the legs equals planning the total in one number", () => {
	// The server sums approach + lane and passes ONE routeMiles, so the two must
	// be indistinguishable to planTripFuel.
	const a = PLAN(712.4);
	const b = PLAN(300.1 + 412.3);
	assert.strictEqual(a.requiredMiles, b.requiredMiles);
	assert.strictEqual(a.gallonsNeeded, b.gallonsNeeded);
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
process.exit(failed ? 1 : 0);
