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
//
// §7-§9 pin the driver gallons block (DRIVER_FUEL_GALLONS_ENABLED, plan R14):
// planDriverFuel() itself, the flag in server.js, and both fuel routes lifted
// out of server.js and run on an in-memory database with the flag off and on
// (off: the answer is exactly as before). Made-up truck, load and places.
//
// §10 pins the live verdict, whatever the flag: GET /api/fuel/trip-plan never
// says 'clears' when the truck could run short, for the driver or for the
// dispatch card (client/src/components/dashboard/FuelFinderPanel.vue).
//
// §11 pins "picked up" (lib/fuel-pickup-arrival.js): the sheet's status alone
// never drops the run to the shipper; the ELD or the geofence must have put the
// truck there in the load's current run, with no twin in that visit. A truck
// with no ELD device keeps the status's answer. The driver's panel says why the
// run is kept (client/src/lib/fuelReview.js pickupUnconfirmedLine()).

"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
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

// === §7 driver gallons: planDriverFuel() =====================================
// The plan's worked example: Unit 901 at 48% with 40 measured fill legs (p10 5.0
// mi a point), MPG 6.0, load QA-FUEL-1 not yet picked up.
console.log("\n§7 driver gallons: planDriverFuel()");
const R15 = { minMiles: 15, fraction: 0 };
const BURN5 = { usable: true, p10: 5.0, p50: 7.4, p90: 10.2, n: 40, miles: 9000, points: 1216, milesPerPoint: 7.4 };
const NO_BURN = { usable: false, p10: null, p50: null, p90: null, milesPerPoint: null };
const LIVE = (pct) => ({ fuelPct: pct, fuelSource: "live", anchorPct: pct, ageMinutes: 12, milesSinceReading: 0 });
function tripPlanFor({ routeMiles, pct = 48, burn = BURN5, mpg = 6.0, tank = 150, reserve = R15 }) {
	const rangeMiles = fuel.computeRange({ fuelPct: pct, tankGallons: tank, mpg }).rangeMiles;
	return fuel.planTripFuel({ routeMiles, fuelPct: pct, burn, rangeMiles, mpg, reserve });
}
function driverFuel({ pct = 48, burn = BURN5, mpg = 6.0, tank = 150, reserve = R15, ...rest } = {}) {
	return fuel.planDriverFuel({
		reading: LIVE(pct), hasTruck: true, hasDevice: true, tankSource: "truck", tankGallons: tank,
		mpg, burn, reserve, fromLivePosition: true, positionAgeMinutes: 12, ...rest,
	});
}
const legOf = (df, key) => df.legs.find((l) => l.key === key);
const beforePickup = () => driverFuel({ plan: tripPlanFor({ routeMiles: 420 }), leg: "to_pickup", approachMiles: 140 });

check("worked example: 240 mi to empty less the 15-mi reserve is 225 left, not refuel-now", () => {
	const df = beforePickup();
	assert.deepStrictEqual([df.milesLeft, df.refuelNow, df.fuelState, df.v], [225, false, "live", 1]);
});
// Gallons to add or hold go at the planning rate: 150 gal / 100 points / 5.0 mi a
// point = 0.3 gal a mile (3.33 mi a gallon, not the 6.0 on file), then +10%.
check("worked example: to reach pickup, 140 mi uses about 30 gal and there is enough", () => {
	assert.deepStrictEqual(legOf(beforePickup(), "pickup"),
		{ key: "pickup", miles: 140, usesGallons: 30, status: "enough", addGallons: null, needInTankGallons: 55 });
});
check("worked example: to finish, 420 mi uses about 80 gal, add about 65 (195 mi short x 0.3 x 1.1), tank needs 145", () => {
	assert.deepStrictEqual(legOf(beforePickup(), "finish"),
		{ key: "finish", miles: 420, usesGallons: 80, status: "add", addGallons: 65, needInTankGallons: 145 });
});
check("a 1,040 mi run needs more than a full tank: refill_on_way, uses about 195, no add figure", () => {
	const f = legOf(driverFuel({ plan: tripPlanFor({ routeMiles: 1040 }), leg: "to_delivery" }), "finish");
	assert.deepStrictEqual([f.status, f.usesGallons, f.addGallons], ["refill_on_way", 195, null]);
});
check("exactly a full tank (485 + 15 = 500 mi at p10 5.0) is add, not refill_on_way", () => {
	const f = legOf(driverFuel({ plan: tripPlanFor({ routeMiles: 485 }), leg: "to_delivery" }), "finish");
	assert.deepStrictEqual([f.status, f.addGallons], ["add", 90]);
});
check("sweep: finish says 'enough' exactly when the verdict is 'clears' (50-1,500 mi, 5 levels, both bases, both reserves)", () => {
	let runs = 0;
	const bad = [];
	for (const burn of [BURN5, NO_BURN]) for (const reserve of [R15, { minMiles: 15, fraction: 0.1 }]) {
		for (const pct of [3, 20, 48, 75, 100]) for (let tenths = 500; tenths <= 15000; tenths += 37) {
			const routeMiles = tenths / 10;
			const plan = tripPlanFor({ routeMiles, pct, burn, reserve });
			const df = driverFuel({ plan, pct, burn, reserve, leg: "to_delivery" });
			const f = legOf(df, "finish");
			runs++;
			if ((f.status === "enough") !== (plan.verdict === "clears")) bad.push([pct, routeMiles, f.status, plan.verdict]);
			// With the flat reserve the rows cannot contradict the headline either.
			if (reserve === R15 && (f.status === "enough") !== (df.milesLeft >= routeMiles)) bad.push(["headline", pct, routeMiles, df.milesLeft]);
		}
	}
	assert.ok(runs > 7000, `only ${runs} runs`);
	assert.deepStrictEqual(bad.slice(0, 5), []);
});
check("before pickup the finish row is the whole run (approach + lane) and still matches the verdict", () => {
	for (const lane of [100, 200, 300, 400]) {
		const plan = tripPlanFor({ routeMiles: 140 + lane });
		const f = legOf(driverFuel({ plan, leg: "to_pickup", approachMiles: 140 }), "finish");
		assert.strictEqual(f.miles, 140 + lane);
		assert.strictEqual(f.status === "enough", plan.verdict === "clears", `lane ${lane}`);
	}
});
check("the pickup row: only before pickup, from a live fix, and more than 1 mi out", () => {
	const plan = tripPlanFor({ routeMiles: 420 });
	const keys = (o) => driverFuel({ plan, ...o }).legs.map((l) => l.key);
	assert.deepStrictEqual(keys({ leg: "to_pickup", approachMiles: 140 }), ["pickup", "finish"]);
	assert.deepStrictEqual(keys({ leg: "to_pickup", approachMiles: 1.5 }), ["pickup", "finish"]);
	assert.deepStrictEqual(keys({ leg: "to_pickup", approachMiles: 1 }), ["finish"], "1 mi out is not a row");
	assert.deepStrictEqual(keys({ leg: "to_delivery", approachMiles: 0 }), ["finish"], "picked up: no pickup row");
	assert.deepStrictEqual(keys({ leg: "to_pickup", approachMiles: 140, fromLivePosition: false }), ["whole_load"]);
});
check("no fix: a single whole_load row, position 'none', no position age", () => {
	const df = driverFuel({ plan: tripPlanFor({ routeMiles: 280 }), leg: "to_delivery", fromLivePosition: false, positionAgeMinutes: null });
	assert.deepStrictEqual([df.legs.map((l) => l.key), df.legs[0].miles, df.position, df.positionAgeMinutes], [["whole_load"], 280, "none", null]);
});
check("a fix 3 h old is 'old' with its age; 12 min is 'current'", () => {
	const plan = tripPlanFor({ routeMiles: 420 });
	const old = driverFuel({ plan, leg: "to_delivery", positionAgeMinutes: 180 });
	const cur = driverFuel({ plan, leg: "to_delivery", positionAgeMinutes: 12 });
	assert.deepStrictEqual([old.position, old.positionAgeMinutes, cur.position, cur.positionAgeMinutes], ["old", 180, "current", 12]);
});
check("the margin never goes below 10: 0 and 5 give what 10 gives (uses 80, add 65)", () => {
	for (const marginPct of [0, 5, 9.9]) {
		const f = legOf(driverFuel({ plan: tripPlanFor({ routeMiles: 420 }), leg: "to_delivery", marginPct }), "finish");
		assert.deepStrictEqual([f.usesGallons, f.addGallons], [80, 65], `margin ${marginPct}`);
	}
});
check("margin 20 is honoured (420 mi -> 84 -> 85 gal)", () => {
	assert.strictEqual(legOf(driverFuel({ plan: tripPlanFor({ routeMiles: 420 }), leg: "to_delivery", marginPct: 20 }), "finish").usesGallons, 85);
});
check("a negative, NaN, text or missing margin falls back to 10, never shrinking the figure", () => {
	for (const marginPct of [-5, NaN, "abc", undefined, null]) {
		const f = legOf(driverFuel({ plan: tripPlanFor({ routeMiles: 420 }), leg: "to_delivery", marginPct }), "finish");
		assert.strictEqual(f.usesGallons, 80, `margin ${String(marginPct)}`);
	}
	assert.strictEqual(fuel.DRIVER_FUEL_MARGIN_PCT, 10);
	assert.strictEqual(fuel.DRIVER_FUEL_ROUND_GALLONS, 5);
});
check("gallons round UP to the next 5: 125 mi at 5.5 MPG +10% is 25 exactly, 126 mi is 30", () => {
	const uses = (routeMiles) => legOf(driverFuel({ plan: tripPlanFor({ routeMiles, mpg: 5.5 }), mpg: 5.5, leg: "to_delivery" }), "finish").usesGallons;
	assert.deepStrictEqual([uses(125), uses(126)], [25, 30]);
});
check("the smallest add is 5 gal (0.5 mi short)", () => {
	const plan = tripPlanFor({ routeMiles: 225.5 });
	const f = legOf(driverFuel({ plan, leg: "to_delivery" }), "finish");
	assert.deepStrictEqual([plan.verdict === "clears", f.status, f.addGallons], [false, "add", 5]);
});
const TOP_KEYS = ["afterAnotherLoad", "approachUncounted", "extraStops", "fuelReadAgeMinutes", "fuelState", "legs", "loadDone", "milesLeft",
	"pickupUnmapped", "position", "positionAgeMinutes", "refuelNow", "routeEstimated", "v"];
const LEG_KEYS = ["addGallons", "key", "miles", "needInTankGallons", "status", "usesGallons"];
const NO_IDENTITY_RE = /vehicle|latitude|longitude|"lat|"lng|unit|driver|price|cost|\$/i;
check("the block carries only its listed keys: no vehicle id, no coordinates, no names, no money", () => {
	const blocks = [beforePickup(), driverFuel(), driverFuel({ hasTruck: false, reading: null, plan: tripPlanFor({ routeMiles: 280, pct: null }) })];
	for (const df of blocks) {
		assert.deepStrictEqual(Object.keys(df).sort(), TOP_KEYS);
		for (const l of df.legs) assert.deepStrictEqual(Object.keys(l).sort(), LEG_KEYS);
		assert.ok(!NO_IDENTITY_RE.test(JSON.stringify(df)), JSON.stringify(df));
	}
});
check("without a plan (GET /api/fuel/range): the top figures, no legs, no load facts", () => {
	const df = driverFuel({ extraStops: true, afterAnotherLoad: true, loadDone: true, routeSource: "straight_line_estimate" });
	assert.deepStrictEqual([df.milesLeft, df.legs, df.position, df.positionAgeMinutes, df.extraStops, df.afterAnotherLoad, df.loadDone, df.routeEstimated],
		[225, [], null, null, false, false, false, false]);
});
check("a delivered load: the top block, no legs", () => {
	const df = driverFuel({ plan: tripPlanFor({ routeMiles: 420 }), leg: "to_pickup", approachMiles: 140, loadDone: true });
	assert.deepStrictEqual([df.loadDone, df.legs, df.milesLeft], [true, [], 225]);
});
check("load facts pass through as true/false: extra stops, another load first, an estimated distance", () => {
	const df = driverFuel({ plan: tripPlanFor({ routeMiles: 420 }), leg: "to_delivery", extraStops: "yes", afterAnotherLoad: 1, routeSource: "straight_line_estimate" });
	assert.deepStrictEqual([df.extraStops, df.afterAnotherLoad, df.routeEstimated], [true, true, true]);
	const plain = driverFuel({ plan: tripPlanFor({ routeMiles: 420 }), leg: "to_delivery", routeSource: "routes_api" });
	assert.deepStrictEqual([plain.extraStops, plain.afterAnotherLoad, plain.routeEstimated], [false, false, false]);
});
check("a load that is over: Delivered, POD Received, Completed, Cancelled, Invoiced, Paid; not In Transit, Assigned, Unpaid", () => {
	assert.deepStrictEqual(["Delivered", "POD Received", "Completed", "Cancelled", "Invoiced", "Paid"].map(fuel.isLoadFinished), [true, true, true, true, true, true]);
	assert.deepStrictEqual(["In Transit", "Assigned", "Unpaid", "", null].map(fuel.isLoadFinished), [false, false, false, false, false]);
});

// === §7b fix round: pumping the shown gallons clears the trip ================
// A driver must never be told "enough" or a too-small "add N" while the truck
// could run dry by the model's own planning figure.
console.log("\n§7b driver gallons: adding the shown gallons clears the trip");
// Top the tank up by `gallons` (never past full) and ask the verdict again.
function afterAdding({ routeMiles, pct, burn, mpg, tank, gallons }) {
	const topped = Math.min(100, pct + (gallons / tank) * 100);
	return tripPlanFor({ routeMiles, pct: topped, burn, mpg, tank });
}
for (const [label, burn, mpg] of [["measured basis (p10 5.0, tank 150)", BURN5, 6.0], ["estimated basis (tank 150 on file, 6.5 MPG, 1.8 derate)", NO_BURN, 6.5]]) {
	check(`${label}: after adding addGallons the verdict clears, on every 'add' row of a sweep`, () => {
		let adds = 0;
		const bad = [];
		for (const pct of [2, 10, 25, 40, 48, 60, 75, 90]) for (let routeMiles = 50; routeMiles <= 1500; routeMiles += 13) {
			const plan = tripPlanFor({ routeMiles, pct, burn, mpg });
			const f = legOf(driverFuel({ plan, pct, burn, mpg, leg: "to_delivery" }), "finish");
			if (f.status !== "add") continue;
			adds++;
			const after = afterAdding({ routeMiles, pct, burn, mpg, tank: 150, gallons: f.addGallons });
			if (after.verdict !== "clears") bad.push([pct, routeMiles, f.addGallons, after.verdict, after.decidedOn, after.requiredMiles]);
		}
		assert.ok(adds > 100, `only ${adds} add rows`);
		assert.deepStrictEqual(bad.slice(0, 5), []);
	});
}
check("estimated basis, the read's example: 40% of 150 gal at 6.0 MPG, 300 mi: add 40, and 40 clears", () => {
	const plan = tripPlanFor({ routeMiles: 300, pct: 40, burn: NO_BURN, mpg: 6.0 });
	const f = legOf(driverFuel({ plan, pct: 40, burn: NO_BURN, mpg: 6.0, leg: "to_delivery" }), "finish");
	assert.deepStrictEqual([f.status, f.addGallons], ["add", 40]);
	assert.strictEqual(afterAdding({ routeMiles: 300, pct: 40, burn: NO_BURN, mpg: 6.0, tank: 150, gallons: 40 }).verdict, "clears");
});
check("needInTankGallons is at the planning rate too: 420 + 15 mi needs 145 gal (measured), 135 at 6.5 MPG / 1.8 (no tank size)", () => {
	const plan = tripPlanFor({ routeMiles: 420, pct: null });
	const none = { fuelPct: null, fuelSource: "none", ageMinutes: null };
	const measured = legOf(driverFuel({ plan, reading: none, leg: "to_delivery" }), "finish");
	const noTank = legOf(driverFuel({ plan, reading: none, leg: "to_delivery", mpg: 6.5, tankSource: "default", tank: 200 }), "finish");
	assert.deepStrictEqual([measured.status, measured.needInTankGallons, noTank.needInTankGallons], ["check_gauge", 145, 135]);
});
check("miles the plan can't count never earn a plain 'enough': extra stops, a load first, a straight-line distance", () => {
	const plan = tripPlanFor({ routeMiles: 420 });
	const statuses = (o) => driverFuel({ plan, leg: "to_pickup", approachMiles: 140, ...o }).legs.map((l) => [l.key, l.status]);
	assert.deepStrictEqual(statuses({}), [["pickup", "enough"], ["finish", "add"]], "control: no caveat");
	for (const o of [{ extraStops: true }, { afterAnotherLoad: true }, { routeSource: "straight_line_estimate" }]) {
		assert.deepStrictEqual(statuses(o), [["pickup", "check_gauge"], ["finish", "check_gauge"]], JSON.stringify(o));
	}
	const enoughEverywhere = driverFuel({ plan: tripPlanFor({ routeMiles: 100 }), leg: "to_delivery", extraStops: true });
	assert.deepStrictEqual(enoughEverywhere.legs.map((l) => [l.status, l.addGallons]), [["check_gauge", null]]);
});
check("a mistyped MPG is capped at 11 for the driver figures (16 on file reads as 11)", () => {
	const at = (mpg) => driverFuel({ plan: tripPlanFor({ routeMiles: 420, burn: NO_BURN, mpg }), burn: NO_BURN, mpg, leg: "to_delivery" });
	const capped = at(16);
	const eleven = at(11);
	assert.deepStrictEqual([capped.milesLeft, legOf(capped, "finish")], [eleven.milesLeft, legOf(eleven, "finish")]);
	assert.strictEqual(fuel.DRIVER_FUEL_MAX_MPG, 11);
});

// === §7c last round: two more paths to a false "enough" =====================
console.log("\n§7c driver gallons: an unmapped pickup, and a long sensor dropout");
check("a pre-pickup load whose pickup has no coordinates (planned truck to delivery) never says 'enough'", () => {
	// 70% at p10 5.0 = 350 planning miles; the shortcut past the shipper is 300 mi.
	const plan = tripPlanFor({ routeMiles: 300, pct: 70 });
	const at = (o) => legOf(driverFuel({ plan, pct: 70, leg: "to_delivery", ...o }), "finish");
	assert.strictEqual(plan.verdict, "clears", "the verdict counts only the shortcut");
	assert.deepStrictEqual([at({}).status, at({ pickupUnmapped: true }).status, at({ pickupUnmapped: true }).addGallons],
		["enough", "check_gauge", null]);
});
check("a carried reading is judged at the planning rate: after a long dropout, 'enough' only if the planning-rate level clears (sweep)", () => {
	const bad = [];
	let runs = 0;
	for (const anchor of [60, 70, 80, 90, 100]) for (const milesSince of [50, 100, 150, 200, 250, 300, 350]) {
		for (const routeMiles of [100, 200, 300, 400]) {
			const mpgPct = Math.max(0, anchor - (milesSince / 6.0 / 150) * 100);   // the decay resolveFuelReading() applies
			const reading = { fuelPct: Math.round(mpgPct * 10) / 10, fuelSource: "carried", anchorPct: anchor, ageMinutes: 120, milesSinceReading: milesSince };
			const plan = tripPlanFor({ routeMiles, pct: reading.fuelPct });
			const f = legOf(driverFuel({ plan, reading, leg: "to_delivery" }), "finish");
			const planningPct = Math.max(0, anchor - milesSince / 5.0);              // points burned at p10 5.0 mi a point
			runs++;
			if (f.status === "enough" && planningPct * 5.0 < routeMiles + 15) bad.push([anchor, milesSince, routeMiles, planningPct]);
		}
	}
	assert.ok(runs >= 140);
	assert.deepStrictEqual(bad.slice(0, 5), []);
});

// === §7d one source: no number for a run the block can't count ===============
// Arvin's design choice after the last re-check: a row whose run or fuel level the
// block can't count shows only "check your gauge" and its reason, no gallons, no miles.
console.log("\n§7d driver gallons: no number on a row the block can't count");
const numberless = (l) => l.status === "check_gauge" && l.miles === null && l.usesGallons === null
	&& l.addGallons === null && l.needInTankGallons === null;
const INCOMPLETE = [
	["a pickup with no coordinates", { pickupUnmapped: true }],
	["a sensor dropout (carried reading)", { reading: { fuelPct: 48, fuelSource: "carried", anchorPct: 50, ageMinutes: 60, milesSinceReading: 20 } }],
	["another load first (queued or started)", { afterAnotherLoad: true }],
	["extra stops", { extraStops: true }],
	["a stale reading", { reading: { fuelPct: null, fuelSource: "stale", anchorPct: 48, ageMinutes: 18 * 60, milesSinceReading: null } }],
	["a straight-line (estimated) distance", { routeSource: "straight_line_estimate" }],
];
for (const [label, o] of INCOMPLETE) {
	check(`no gallons and no miles on a row the block can't count: ${label}`, () => {
		const df = driverFuel({ plan: tripPlanFor({ routeMiles: 420 }), leg: "to_pickup", approachMiles: 140, ...o });
		assert.ok(df.legs.length === 2 && df.legs.every(numberless), JSON.stringify(df.legs));
	});
}
check("...the control with none of them: both rows carry their miles and gallons", () => {
	assert.ok(beforePickup().legs.every((l) => Number.isFinite(l.miles) && Number.isFinite(l.usesGallons)), JSON.stringify(beforePickup().legs));
});
check("no gallons and no miles on the whole-load row before pickup with no truck position (approachUncounted): no reading, no truck, or a fresh reading", () => {
	const none = { fuelPct: null, fuelSource: "none", anchorPct: null, ageMinutes: null, milesSinceReading: null };
	const at = (o, pct = null) => driverFuel({ plan: tripPlanFor({ routeMiles: 280, pct }), leg: "to_delivery", fromLivePosition: false,
		positionAgeMinutes: null, approachUncounted: true, ...o });
	for (const df of [at({ reading: none }), at({ reading: none, hasTruck: false }), at({ reading: LIVE(80) }, 80)]) {
		assert.ok(df.approachUncounted === true && df.legs.length === 1 && df.legs[0].key === "whole_load" && numberless(df.legs[0]), JSON.stringify(df));
	}
	const after = driverFuel({ plan: tripPlanFor({ routeMiles: 280, pct: 80 }), reading: LIVE(80), pct: 80, leg: "to_delivery", fromLivePosition: false, positionAgeMinutes: null });
	assert.deepStrictEqual([after.approachUncounted, after.legs.map((l) => [l.key, l.miles, l.status])], [false, [["whole_load", 280, "enough"]]],
		"the control: after pickup the whole load over-counts, so it keeps its figures");
});
check("the block says when the pickup isn't on the map (pickupUnmapped), so the screen can give the reason", () => {
	const plan = tripPlanFor({ routeMiles: 300 });
	assert.deepStrictEqual([
		driverFuel({ plan, leg: "to_delivery", pickupUnmapped: true }).pickupUnmapped,
		driverFuel({ plan, leg: "to_delivery" }).pickupUnmapped,
		driverFuel({ pickupUnmapped: true }).pickupUnmapped,
	], [true, false, false]);
});

// === §7e the reading's 6 h, on the position's exact clock ====================
// The trip plan's fix is fresh only under 6 h to the millisecond; the reading's
// age was rounded minutes, so for 30 s a reading was trusted while its own fix was
// not, and after pickup the whole load (planned from the pickup) said "enough".
console.log("\n§7e driver gallons: the reading's 6 h on the position's exact clock");
const H6 = 6 * 60 * 60 * 1000;
const T7 = Date.parse("2026-10-30T15:00:00Z");
// The reading as resolveFuelReading() hands it over: one 80% row, `agoMs` before `now`.
const readAt = (agoMs, now = T7) => fuel.resolveFuelReading({
	rows: [{ fuel_pct: 80, odometer: 100000, location_date_ms: now - agoMs }], mpg: 6.0, tankGallons: 150, nowMs: now,
});
// After pickup: a fix under 6 h plans from it (finish), else from the pickup (whole
// load), as server.js fixFresh decides; the reading is that fix's row.
const afterPickup = (agoMs, now = T7) => driverFuel({
	plan: tripPlanFor({ routeMiles: 280, pct: 80 }), reading: readAt(agoMs, now), pct: 80, leg: "to_delivery",
	fromLivePosition: agoMs < H6, positionAgeMinutes: agoMs < H6 ? Math.round(agoMs / 60000) : null, nowMs: now,
});
const rowFigures = (df) => [df.fuelState, df.milesLeft, df.legs.map((l) => [l.key, l.status, l.miles, l.usesGallons, l.needInTankGallons])];
const STALE_WHOLE_LOAD = ["stale", null, [["whole_load", "check_gauge", null, null, null]]];
for (const [label, agoMs] of [["exactly 6 h", H6], ["6 h and 1 ms", H6 + 1], ["6 h 15 s", H6 + 15000], ["6 h 29.999 s (still 360 rounded minutes)", H6 + 29999],
	["6 h 30 s (361 rounded minutes)", H6 + 30000]]) {
	check(`after pickup, an 80% reading ${label} old with no fresh fix: 'stale', the whole-load row has no number (no 'enough')`, () => {
		assert.deepStrictEqual(rowFigures(afterPickup(agoMs)), STALE_WHOLE_LOAD);
	});
}
check("...the control, 1 ms under 6 h: the fix is fresh, the reading is live, and the finish row keeps its figures", () => {
	assert.deepStrictEqual(rowFigures(afterPickup(H6 - 1)), ["live", 385, [["finish", "enough", 280, 55, 100]]]);
});
check("the range block (no plan) on the same clock: live 1 ms under 6 h, stale at 6 h and at 6 h 15 s", () => {
	const top = (agoMs) => fuel.planDriverFuel({ reading: readAt(agoMs), hasTruck: true, hasDevice: true, tankSource: "truck", tankGallons: 150,
		mpg: 6.0, burn: BURN5, reserve: R15, nowMs: T7 });
	assert.deepStrictEqual([H6 - 1, H6, H6 + 15000].map((a) => [top(a).fuelState, top(a).milesLeft]), [["live", 385], ["stale", null], ["stale", null]]);
});
for (const [label, now] of [["the November change (2026-11-01, 1 a.m. twice)", Date.parse("2026-11-01T10:30:00Z")],
	["the March change (2026-03-08, no 2 a.m.)", Date.parse("2026-03-08T10:00:00Z")]]) {
	check(`across ${label}: elapsed time decides, not the wall clock (1 ms under 6 h live, 6 h stale)`, () => {
		assert.deepStrictEqual([afterPickup(H6 - 1, now).fuelState, rowFigures(afterPickup(H6, now))], ["live", STALE_WHOLE_LOAD]);
	});
}
check("a reading with no time of its own: its rounded age must be under 6 h (359 min live, 360 min stale)", () => {
	const at = (ageMinutes) => driverFuel({ plan: tripPlanFor({ routeMiles: 280, pct: 80 }), pct: 80, leg: "to_delivery", fromLivePosition: false,
		positionAgeMinutes: null, reading: { fuelPct: 80, fuelSource: "live", anchorPct: 80, ageMinutes, milesSinceReading: 0 } });
	assert.deepStrictEqual([at(359).fuelState, at(359).legs[0].status, rowFigures(at(360))], ["live", "enough", STALE_WHOLE_LOAD]);
});
check("a reading dated after now (a device clock running ahead) is not trusted", () => {
	const df = driverFuel({ plan: tripPlanFor({ routeMiles: 280, pct: 80 }), pct: 80, leg: "to_delivery", fromLivePosition: false, positionAgeMinutes: null,
		reading: { fuelPct: 80, fuelSource: "live", anchorPct: 80, anchorAtMs: T7 + 60000, ageMinutes: 0, milesSinceReading: 0 }, nowMs: T7 });
	assert.deepStrictEqual(rowFigures(df), STALE_WHOLE_LOAD);
});
check("an empty reading is still acted on at any age (0% read 7 h ago: 0 mi, refuel now)", () => {
	const df = driverFuel({ plan: tripPlanFor({ routeMiles: 280, pct: 0 }), pct: 0, leg: "to_delivery", fromLivePosition: false, positionAgeMinutes: null,
		reading: { fuelPct: 0, fuelSource: "carried", anchorPct: 5, anchorAtMs: T7 - 7 * 3600000, ageMinutes: 420, milesSinceReading: 40 }, nowMs: T7 });
	assert.deepStrictEqual([df.milesLeft, df.refuelNow], [0, true]);
});

// === §8 the flag in server.js ================================================
console.log("\n§8 driver gallons: the flag in server.js");
const { serverSource, resolveServerFile } = require("./lib/server-source");
const { closure, liftRoute, indexDeclarations } = require("./lib/server-lift");
const SRC = serverSource();
const DECLS = indexDeclarations(SRC).decls;
const declText = (name) => {
	const d = DECLS.get(name);
	if (!d) throw new Error(`no top-level ${name} in server.js`);
	return d.text;
};
const RANGE_HEAD = 'app.get("/api/fuel/range", requireRole("Super Admin", "Dispatcher", "Driver"), (req, res) => {';
const PLAN_HEAD = 'app.get("/api/fuel/trip-plan", requireRole("Super Admin", "Dispatcher", "Driver"), fuelPlanLimiter, async (req, res) => {';
check("the flag is an enable switch: only true/1/yes/on turn it on", () => {
	const text = declText("DRIVER_FUEL_GALLONS_ENABLED");
	assert.ok(/^const DRIVER_FUEL_GALLONS_ENABLED = \/\^\(true\|1\|yes\|on\)\$\/i\.test\(String\(process\.env\.DRIVER_FUEL_GALLONS_ENABLED \?\? ""\)\.trim\(\)\);$/.test(text), text);
	const on = (v) => new Function("process", `${text}\nreturn DRIVER_FUEL_GALLONS_ENABLED;`)({ env: v === undefined ? {} : { DRIVER_FUEL_GALLONS_ENABLED: v } });
	assert.deepStrictEqual(["true", "1", "yes", "on", "TRUE", " on "].map(on), [true, true, true, true, true, true]);
	assert.deepStrictEqual([undefined, "", "false", "0", "no", "off", "enabled", "truee"].map(on), [false, false, false, false, false, false, false, false]);
});
check("the margin knob: 10 or more is taken; anything below 10 or unreadable is 10", () => {
	const text = declText("DRIVER_FUEL_GALLONS_MARGIN_PCT");
	const at = (v) => new Function("process", "fuelModel", `${text}\nreturn DRIVER_FUEL_GALLONS_MARGIN_PCT;`)(
		{ env: v === undefined ? {} : { DRIVER_FUEL_GALLONS_MARGIN_PCT: v } }, fuel);
	assert.deepStrictEqual(["10", "12.5", "25"].map(at), [10, 12.5, 25]);
	assert.deepStrictEqual([undefined, "", "-5", "abc", "NaN", "0", "0.1", "9.9"].map(at), [10, 10, 10, 10, 10, 10, 10, 10]);
});
check("driverFuel is spread into each fuel answer only under the flag, once per route", () => {
	const guarded = "...(DRIVER_FUEL_GALLONS_ENABLED ? { driverFuel: fuelModel.planDriverFuel({";
	for (const head of [RANGE_HEAD, PLAN_HEAD]) {
		const body = liftRoute(SRC, head);
		assert.strictEqual(body.split("driverFuel:").length - 1, 1, head);
		assert.strictEqual(body.split(guarded).length - 1, 1, head);
		assert.ok(/\}\) \} : \{\}\)/.test(body.slice(body.indexOf(guarded))), "the spread ends in `: {})`");
	}
	assert.strictEqual(SRC.split("driverFuel:").length - 1, 2, "no other answer carries the block");
});
check("the trip-plan 400s carry a code only under the flag", () => {
	const body = liftRoute(SRC, PLAN_HEAD);
	for (const code of ["NO_ROUTE", "NO_POSITION"]) {
		assert.strictEqual(body.split(`code: "${code}"`).length - 1, 1, code);
		assert.ok(body.includes(`...(DRIVER_FUEL_GALLONS_ENABLED ? { code: "${code}" } : {})`), code);
	}
});

// === §9 both routes, run with the flag off and on ============================
// Lifted whole out of server.js (scripts/lib/server-lift.js) onto an in-memory
// database, with the clock pinned, a stub router and stub fill history.
console.log("\n§9 driver gallons: GET /api/fuel/trip-plan and /api/fuel/range, flag off and on");
const NOW = Date.parse("2026-10-30T15:00:00Z");
class FixedDate extends Date {
	constructor(...a) { if (a.length) super(...a); else super(NOW); }
	static now() { return NOW; }
}
const PICKUP = { lat: 35.0, lng: -97.0 };   // "Riverton"
const DROP = { lat: 37.0, lng: -99.0 };     // "Lakeside"
const FIX = { lat: 34.0, lng: -96.0 };
// §11: a truck 75 road miles short of the shipper and 160 from the receiver.
const FIX_SHORT = { lat: 35.8, lng: -97.6 };
const pairKey = (a, b) => `${a.latitude},${a.longitude}>${b.latitude},${b.longitude}`;
const ROAD_MILES = new Map([
	[`${FIX.lat},${FIX.lng}>${PICKUP.lat},${PICKUP.lng}`, 140],
	[`${PICKUP.lat},${PICKUP.lng}>${DROP.lat},${DROP.lng}`, 280],
	[`${FIX.lat},${FIX.lng}>${DROP.lat},${DROP.lng}`, 300],
	[`${FIX_SHORT.lat},${FIX_SHORT.lng}>${PICKUP.lat},${PICKUP.lng}`, 75],
	[`${FIX_SHORT.lat},${FIX_SHORT.lng}>${DROP.lat},${DROP.lng}`, 160],
]);
// The shipped status history table, columns and all, so a world's rows read as production's do.
const HISTORY_DDL = [
	...(SRC.match(/CREATE TABLE IF NOT EXISTS load_status_history \([\s\S]*?\n\t\)/g) || []),
	...(SRC.match(/ALTER TABLE load_status_history ADD COLUMN [a-z_]+ [A-Z]+(?: DEFAULT '')?/g) || []),
];
const sqlStamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
// A load the sheet has past the shipper arrived there in the run, by the geofence, unless a world says otherwise.
const DISPATCHED = { status: "Dispatched", source: "dispatch", agoMin: 48 * 60 };
const GEOFENCE_ARRIVAL = { status: "At Shipper", source: "geofence", agoMin: 30 * 60 };
const PROVIDED = ["app", "db", "requireRole", "fuelPlanLimiter", "getJobTrackingCached", "loadBelongsToDriver",
	"burnRateForVehicle", "receiptMpgForVehicle", "getRoute", "geolib"];
const DRIVER = { id: 7, role: "Driver", driverName: "Driver QA", username: "driver_qa" };
const DISPATCH = { id: 2, role: "Dispatcher", username: "dispatch_qa" };

function buildWorld(Database, lifted, appRequire, o = {}, flagOn = false) {
	const opt = { status: "Assigned", fuel: 48, fixAgoMin: 12, coords: true, pickupMapped: true, truck: true, tank: 150, avgMpg: 6.0,
		burn: BURN5, receipt: { mpg: 6.0 }, rollupMpg: null, details: "Dry van, 43,764 lbs", otherLoad: null, stopPayload: null,
		anchor: null, routesDown: false, device: true, linkedAgoMin: null, fixAgoMs: null, odo: 100000,
		fixAt: FIX, history: undefined, track: [], noHistoryTable: false, otherHistory: [], sheetDriver: "Driver QA", otherDriver: "Driver QA",
		otherCoords: null, drop: DROP, ...o };
	if (opt.history === undefined) opt.history = fuel.isPickedUp(opt.status) ? [DISPATCHED, GEOFENCE_ARRIVAL] : [DISPATCHED];
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, routemate_vehicle_id TEXT DEFAULT '', assigned_driver TEXT DEFAULT '',
			fuel_tank_gallons REAL DEFAULT 0, avg_mpg REAL DEFAULT 0);
		CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT DEFAULT '', end_date TEXT DEFAULT '');
		CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT NOT NULL, latitude REAL, longitude REAL,
			speed REAL DEFAULT 0, odometer REAL DEFAULT 0, fuel_pct INTEGER, location_date_ms INTEGER DEFAULT 0, dropped_reason TEXT DEFAULT '');
		CREATE TABLE routemate_fuel_daily (routemate_vehicle_id TEXT, date TEXT, mpg REAL, miles REAL, derivation_notes TEXT DEFAULT '');
		CREATE TABLE load_coordinates (load_id TEXT PRIMARY KEY, origin_lat REAL, origin_lng REAL, dest_lat REAL, dest_lng REAL);
		CREATE TABLE eld_device_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, routemate_vehicle_id TEXT,
			assigned_from TEXT, assigned_until TEXT DEFAULT '', assigned_by TEXT DEFAULT '');
		CREATE TABLE deleted_loads (load_id TEXT PRIMARY KEY);
		CREATE TABLE load_driver_instructions (load_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
		CREATE TABLE load_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT, driver_name TEXT, response TEXT, responded_at TEXT);
		CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, type TEXT, metadata TEXT, created_at TEXT);
	`);
	if (!opt.noHistoryTable) {
		for (const sql of HISTORY_DDL) db.exec(sql);
		const row = db.prepare(`INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, changed_at, actor_role, fix_ms, pickup_zone, other_load_hauling)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		// This load's rows, then the driver's other load's (QA-FUEL-0), each written by "Driver QA" unless a row names another actor.
		for (const [loadKey, rows] of [["qa-fuel-1", opt.history], ["qa-fuel-0", opt.otherHistory]]) for (const h of rows) {
			row.run(loadKey, h.old || "", h.status, h.source, h.actor || "Driver QA", sqlStamp(NOW - h.agoMin * 60000), h.role || "",
				h.fixAgoMin != null ? NOW - h.fixAgoMin * 60000 : null, h.zone || "", h.hauling === undefined ? null : h.hauling);
		}
	}
	// The driver's accept times, which order his queue (computeDriverQueues()).
	for (const [loadId, at] of opt.accepts || []) {
		db.prepare("INSERT INTO load_responses (load_id, driver_name, response, responded_at) VALUES (?, 'Driver QA', 'accepted', ?)").run(loadId, at);
	}
	const VID = "DEV-QA-901";
	if (opt.truck) {
		db.prepare("INSERT INTO trucks (id, unit_number, routemate_vehicle_id, assigned_driver, fuel_tank_gallons, avg_mpg) VALUES (1, 'Unit 901', ?, 'Driver QA', ?, ?)")
			.run(opt.device ? VID : "", opt.tank, opt.avgMpg);
		db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (1, 'Driver QA', '2026-10-01', '')").run();
		const tel = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, odometer, fuel_pct, location_date_ms) VALUES (?, ?, ?, ?, ?, ?)");
		// Earlier fixes on the way (no fuel level, so no fuel read picks them), oldest first, below the newest fix's id.
		if (opt.device) for (const t of opt.track) {
			db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, odometer, fuel_pct, location_date_ms) VALUES (?, ?, ?, ?, 0, NULL, ?)")
				.run(VID, t.at.lat, t.at.lng, t.speed, NOW - t.agoMin * 60000);
		}
		if (opt.device && opt.anchor) tel.run(VID, opt.fixAt.lat, opt.fixAt.lng, opt.anchor.odo, opt.anchor.fuel, NOW - opt.anchor.agoMin * 60000);
		if (opt.device) tel.run(VID, opt.fixAt.lat, opt.fixAt.lng, opt.odo, opt.fuel, NOW - (opt.fixAgoMs != null ? opt.fixAgoMs : opt.fixAgoMin * 60000));
		// A device linked to the truck after its newest fix (B11): that fix belongs to another vehicle.
		if (opt.linkedAgoMin != null) {
			db.prepare("INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from, assigned_until, assigned_by) VALUES (1, ?, ?, '', 'admin_qa')")
				.run(VID, new Date(NOW - opt.linkedAgoMin * 60000).toISOString());
		}
		if (opt.rollupMpg) for (const d of ["2026-10-27", "2026-10-28", "2026-10-29"]) {
			db.prepare("INSERT INTO routemate_fuel_daily VALUES (?, ?, ?, 300, '')").run(VID, d, opt.rollupMpg);
		}
	}
	if (opt.coords) {
		db.prepare("INSERT INTO load_coordinates VALUES ('qa-fuel-1', ?, ?, ?, ?)")
			.run(opt.pickupMapped ? PICKUP.lat : null, opt.pickupMapped ? PICKUP.lng : null, opt.drop.lat, opt.drop.lng);
	}
	// The other load's own mapped points (§11's twins), as [pickup, receiver].
	if (opt.otherCoords) {
		const [p, d] = opt.otherCoords;
		db.prepare("INSERT INTO load_coordinates VALUES ('qa-fuel-0', ?, ?, ?, ?)").run(p.lat, p.lng, d.lat, d.lng);
	}
	if (opt.stopPayload) db.prepare("INSERT INTO load_driver_instructions VALUES ('qa-fuel-1', ?)").run(JSON.stringify(opt.stopPayload));
	const headers = ["Load ID", "Status", "Driver", "Details"];
	const data = [{ "Load ID": "QA-FUEL-1", Status: opt.status, Driver: opt.sheetDriver, Details: opt.details }];
	if (opt.otherLoad) data.push({ "Load ID": "QA-FUEL-0", Status: opt.otherLoad, Driver: opt.otherDriver, Details: "" });
	const handlers = {};
	const deps = {
		app: { get: (p, ...h) => { handlers[p] = h[h.length - 1]; } },
		db, requireRole: () => null, fuelPlanLimiter: null,
		getJobTrackingCached: async () => ({ headers, data }),
		loadBelongsToDriver: async () => true,
		burnRateForVehicle: (vid) => (vid ? opt.burn : null),
		receiptMpgForVehicle: (vid) => (vid ? opt.receipt : null),
		getRoute: async (a, b) => (opt.routesDown ? null : { distanceMiles: ROAD_MILES.get(pairKey(a, b)) }),
		geolib: require("geolib"),
	};
	const prev = process.env.DRIVER_FUEL_GALLONS_ENABLED;
	if (flagOn) process.env.DRIVER_FUEL_GALLONS_ENABLED = "true";
	else delete process.env.DRIVER_FUEL_GALLONS_ENABLED;
	try {
		new Function(...PROVIDED, "Date", "require", lifted.text)(...PROVIDED.map((k) => deps[k]), FixedDate, appRequire);
	} finally {
		if (prev === undefined) delete process.env.DRIVER_FUEL_GALLONS_ENABLED;
		else process.env.DRIVER_FUEL_GALLONS_ENABLED = prev;
	}
	const call = async (route, user, query) => {
		const res = { statusCode: 200, body: null, setHeader() {}, set() { return this; },
			status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
		await handlers[route]({ query: query || {}, params: {}, body: {}, headers: {}, session: { user } }, res);
		return { status: res.statusCode, body: res.body };
	};
	return {
		plan: (user = DRIVER, query = { loadId: "QA-FUEL-1" }) => call("/api/fuel/trip-plan", user, query),
		range: (user = DRIVER, query = {}) => call("/api/fuel/range", user, query),
	};
}

const WORLDS = [
	["before pickup, live fix", {}],
	["in transit", { status: "In Transit" }],
	["fix 3 h old", { fixAgoMin: 180 }],
	["no fix for 13 h (fuel stale too)", { fixAgoMin: 13 * 60 }],
	["sensor dropout (carried)", { fuel: 0, anchor: { fuel: 40, agoMin: 60, odo: 99900 } }],
	["no tank size, no fill history", { tank: 0, burn: null, receipt: null }],
	["no truck linked", { truck: false }],
	["Routes down (straight line)", { routesDown: true }],
	["rollup MPG, no receipts, estimated basis", { receipt: null, burn: null, rollupMpg: 8.0 }],
	["delivered", { status: "Delivered" }],
	["another load in transit, 3 stops", { otherLoad: "In Transit", details: "3 stops: Riverton, Midway, Lakeside" }],
	["stop list with two pickups", { stopPayload: { stops: [{ kind: "pickup" }, { kind: "pickup" }, { kind: "delivery" }] } }],
	["load not mapped", { coords: false }],
	["no truck and no pickup mapped", { truck: false, pickupMapped: false }],
	["80% read 9 h ago, ELD silent since", { fuel: 80, fixAgoMin: 9 * 60 }],
	["sensor dropout, no tank size, measured basis", { fuel: 0, anchor: { fuel: 40, agoMin: 60, odo: 99900 }, tank: 0 }],
	["another load heading to its shipper", { otherLoad: "Heading to Shipper" }],
	["another load accepted first, queued ahead", { otherLoad: "Assigned",
		accepts: [["QA-FUEL-0", "2026-10-29T10:00:00.000Z"], ["QA-FUEL-1", "2026-10-29T12:00:00.000Z"]] }],
	["this load accepted first, the other queued behind", { otherLoad: "Assigned",
		accepts: [["QA-FUEL-1", "2026-10-29T10:00:00.000Z"], ["QA-FUEL-0", "2026-10-29T12:00:00.000Z"]] }],
	["'two stops' in Details", { details: "two stops: Riverton, Midway, then Lakeside" }],
	// Added in the last round; the flag-off digest below still covers the 20 worlds above.
	["pre-pickup, pickup not geocoded, 70%", { pickupMapped: false, fuel: 70 }],
	["in transit after a 4 h dropout from 100% (300 mi since)", { status: "In Transit", fuel: 0, anchor: { fuel: 100, agoMin: 240, odo: 99700 } }],
	// Added for Arvin's option (a): before pickup with no truck position (the digests pin the 20 and 22 worlds above).
	["before pickup, no ELD device on the truck", { device: false }],
	["before pickup, no fuel level, ELD silent 8 h", { fuel: null, fixAgoMin: 8 * 60 }],
	["before pickup, device re-linked 5 min ago (its newest fix is from before)", { linkedAgoMin: 5 }],
	["6 h edge: an 80% reading 6 h 18 s old, before pickup", { fuel: 80, fixAgoMin: 360.3 }],
	["after pickup, no ELD device on the truck", { status: "In Transit", device: false }],
];
const DIGEST_WORLDS = 20;
const DIGEST_WORLDS_2 = 22;
const CALLS = [
	["trip-plan, Driver", (w) => w.plan()],
	["trip-plan, Dispatcher", (w) => w.plan(DISPATCH)],
	["trip-plan, Dispatcher by device", (w) => w.plan(DISPATCH, { loadId: "QA-FUEL-1", vehicleId: "DEV-QA-901" })],
	["range, Driver", (w) => w.range()],
	["range, Dispatcher", (w) => w.range(DISPATCH, { driver: "Driver QA" })],
];
const omitDriverFuel = (b) => {
	if (!b || typeof b !== "object") return b;
	const { driverFuel: _drop, ...rest } = b;
	return rest;
};

async function routeSections() {
	let Database = null;
	let lifted = null;
	let liftError = null;
	try {
		Database = require("better-sqlite3");
		lifted = closure(SRC, { routes: [RANGE_HEAD, PLAN_HEAD], provided: PROVIDED, denied: ["server", "io", "transporter", "sendEmail"] });
	} catch (e) { liftError = e.message; }
	if (liftError) {
		check("the two routes lift out of server.js and better-sqlite3 loads (run under the .nvmrc Node)", () => assert.fail(liftError));
		return;
	}
	const appRequire = require("module").createRequire(resolveServerFile());
	const off = [];
	const on = [];
	for (const [wName, o] of WORLDS) {
		const wOff = buildWorld(Database, lifted, appRequire, o, false);
		const wOn = buildWorld(Database, lifted, appRequire, o, true);
		for (const [cName, fn] of CALLS) {
			off.push({ name: `${wName} / ${cName}`, r: await fn(wOff) });
			on.push({ name: `${wName} / ${cName}`, r: await fn(wOn) });
		}
	}
	// Byte-for-byte evidence across versions: run this file on a base checkout and
	// on the branch; equal digests mean every flag-off answer above is unchanged.
	const digestOf = (list) => crypto.createHash("sha256").update(JSON.stringify(list.map((x) => [x.name, x.r.status, x.r.body]))).digest("hex");
	const pinned = off.slice(0, DIGEST_WORLDS * CALLS.length);
	console.log(`      flag-off answers: ${pinned.length}, sha256 ${digestOf(pinned)}`);
	const pinned2 = off.slice(0, DIGEST_WORLDS_2 * CALLS.length);
	console.log(`      flag-off answers, the first ${DIGEST_WORLDS_2} worlds: ${pinned2.length}, sha256 ${digestOf(pinned2)}`);
	console.log(`      flag-off answers, all ${WORLDS.length} worlds: ${off.length}, sha256 ${digestOf(off)}`);
	// The flag-on blocks alone: equal on a base and the branch means a change to the
	// verdict left every driverFuel block as it was.
	const blocks = on.map((x) => ({ name: x.name, r: { status: x.r.status, body: x.r.body && x.r.body.driverFuel } }));
	console.log(`      flag-on driverFuel blocks, all ${WORLDS.length} worlds: ${blocks.length}, sha256 ${digestOf(blocks)}`);
	const at = (list, name) => list.find((x) => x.name === name).r;

	check("flag off: no answer carries driverFuel or a 400 code, and none failed (500)", () => {
		const bad = off.filter((x) => x.r.status === 500 || (x.r.body && ("driverFuel" in x.r.body || "code" in x.r.body)));
		assert.deepStrictEqual(bad.map((x) => x.name), []);
	});
	check("flag on adds only driverFuel, as the last key: every other byte of every answer is the flag-off answer", () => {
		const bad = [];
		on.forEach((x, i) => {
			const b = x.r.body;
			const ok200 = x.r.status === 200 && b && b.ok === true;
			if (ok200 && Object.keys(b).pop() !== "driverFuel") bad.push(`${x.name}: driverFuel missing or not last`);
			const bare = x.r.status === 400 ? (({ code: _c, ...rest }) => rest)(b) : omitDriverFuel(b);
			if (x.r.status !== off[i].r.status || JSON.stringify(bare) !== JSON.stringify(off[i].r.body)) bad.push(`${x.name}: differs`);
		});
		assert.deepStrictEqual(bad, []);
	});
	check("flag on: the 400s say NO_ROUTE (load not mapped) and NO_POSITION (no fix, no pickup); off they are as before", () => {
		const r1 = at(on, "load not mapped / trip-plan, Driver");
		const r0 = at(off, "load not mapped / trip-plan, Driver");
		const p1 = at(on, "no truck and no pickup mapped / trip-plan, Driver");
		const p0 = at(off, "no truck and no pickup mapped / trip-plan, Driver");
		assert.deepStrictEqual([r1.status, r1.body, p1.status, p1.body],
			[400, { ok: false, error: "load has no geocoded destination", code: "NO_ROUTE" }, 400, { ok: false, error: "no position to plan from", code: "NO_POSITION" }]);
		assert.deepStrictEqual([r0.body, p0.body], [{ ok: false, error: "load has no geocoded destination" }, { ok: false, error: "no position to plan from" }]);
	});
	check("the worked example through the route: 225 left; pickup 140 mi uses 30, enough; finish 420 mi uses 80, add 65", () => {
		const df = at(on, "before pickup, live fix / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([df.milesLeft, df.fuelState, df.position, df.positionAgeMinutes, df.fuelReadAgeMinutes], [225, "live", "current", 12, 12]);
		assert.deepStrictEqual(df.legs, [
			{ key: "pickup", miles: 140, usesGallons: 30, status: "enough", addGallons: null, needInTankGallons: 55 },
			{ key: "finish", miles: 420, usesGallons: 80, status: "add", addGallons: 65, needInTankGallons: 145 },
		]);
	});
	check("a reading 9 h old with the ELD silent since is not 'live' and says no 'enough' (80% would have)", () => {
		const df = at(on, "80% read 9 h ago, ELD silent since / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([df.fuelState, df.milesLeft, df.fuelReadAgeMinutes, df.legs.map((l) => [l.key, l.status])],
			["stale", null, 540, [["whole_load", "check_gauge"]]]);
		assert.strictEqual(at(on, "80% read 9 h ago, ELD silent since / range, Driver").body.driverFuel.fuelState, "stale");
	});
	check("a dropout carried against the 200-gal guess (no tank size) gives no miles, only 'check your gauge'", () => {
		const df = at(on, "sensor dropout, no tank size, measured basis / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([df.fuelState, df.milesLeft, df.legs.every((l) => l.status === "check_gauge")], ["no_tank_size", null, true]);
	});
	check("extra stops, a load first, or a straight-line distance: no row says 'enough'", () => {
		for (const w of ["another load in transit, 3 stops", "stop list with two pickups", "Routes down (straight line)"]) {
			const df = at(on, `${w} / trip-plan, Driver`).body.driverFuel;
			assert.ok(df.legs.length > 0 && df.legs.every((l) => l.status !== "enough"), `${w}: ${JSON.stringify(df.legs)}`);
		}
	});
	check("a load queued behind another counts as 'another load first' (one heading to its shipper, or accepted first); no row says 'enough'", () => {
		for (const w of ["another load heading to its shipper", "another load accepted first, queued ahead"]) {
			const df = at(on, `${w} / trip-plan, Driver`).body.driverFuel;
			assert.ok(df.afterAnotherLoad === true && df.legs.every((l) => l.status !== "enough"), `${w}: ${JSON.stringify(df)}`);
		}
	});
	check("...and the load first in the queue does not: its pickup row still says 'enough'", () => {
		const df = at(on, "this load accepted first, the other queued behind / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([df.afterAnotherLoad, df.legs.map((l) => [l.key, l.status])], [false, [["pickup", "enough"], ["finish", "add"]]]);
	});
	check("'two stops' in Details marks extra stops and keeps 'enough' off the rows", () => {
		const df = at(on, "'two stops' in Details / trip-plan, Driver").body.driverFuel;
		assert.ok(df.extraStops === true && df.legs.every((l) => l.status !== "enough"), JSON.stringify(df));
	});
	check("pre-pickup with the pickup not geocoded: the route plans truck to delivery and holds the verdict at 'tight'; the block says so and its row has no number", () => {
		const b = at(on, "pre-pickup, pickup not geocoded, 70% / trip-plan, Driver").body;
		assert.deepStrictEqual([b.verdict, b.leg, b.laneMiles, b.driverFuel.pickupUnmapped, b.driverFuel.legs.map((l) => [l.key, l.status, l.miles, l.needInTankGallons])],
			["tight", "to_delivery", 300, true, [["finish", "check_gauge", null, null]]]);
	});
	check("in transit after a 4 h dropout from 100%: the verdict and the top both carry the level at the planning rate (40%, 185 left, insufficient); the row has no number", () => {
		const b = at(on, "in transit after a 4 h dropout from 100% (300 mi since) / trip-plan, Driver").body;
		assert.deepStrictEqual([b.verdict, b.fuelPct, b.refuelWithinMiles, b.fuelSource, b.driverFuel.fuelState, b.driverFuel.milesLeft,
			b.driverFuel.legs.map((l) => [l.key, l.status, l.miles, l.addGallons])],
		["insufficient", 40, 185, "carried", "estimated", 185, [["finish", "check_gauge", null, null]]]);
	});
	check("a Driver's answers carry no vehicle id, and the block only its listed keys (all 52 Driver answers that succeed)", () => {
		const driverAnswers = on.filter((y) => y.name.endsWith("Driver") && y.r.status === 200);
		assert.strictEqual(driverAnswers.length, 52);
		for (const x of driverAnswers) {
			assert.ok(x.r.body.driverFuel, `${x.name}: no driverFuel`);
			assert.ok(!("vehicleId" in x.r.body), x.name);
			assert.deepStrictEqual(Object.keys(x.r.body.driverFuel).sort(), TOP_KEYS, x.name);
			for (const l of x.r.body.driverFuel.legs) assert.deepStrictEqual(Object.keys(l).sort(), LEG_KEYS, x.name);
			assert.ok(!/DEV-QA-901|Driver QA|Unit 901|QA-FUEL/.test(JSON.stringify(x.r.body.driverFuel)), x.name);
		}
	});
	check("range: the same top figures as the trip plan, no legs", () => {
		const r = at(on, "before pickup, live fix / range, Driver").body.driverFuel;
		const p = at(on, "before pickup, live fix / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([r.milesLeft, r.fuelState, r.legs, r.position], [p.milesLeft, p.fuelState, [], null]);
	});
	check("range uses trip-plan's MPG chain, not the ELD rollup: the chip and the panel agree where the old figure did not", () => {
		const range = at(on, "rollup MPG, no receipts, estimated basis / range, Driver").body;
		const plan = at(on, "rollup MPG, no receipts, estimated basis / trip-plan, Driver").body;
		assert.deepStrictEqual([range.mpgSource, range.rangeUsableMiles, range.driverFuel.milesLeft, plan.driverFuel.milesLeft], ["eld", 305, 225, 225]);
	});
	check("in transit: one finish row from the fix (300 mi), no pickup row", () => {
		const df = at(on, "in transit / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual(df.legs.map((l) => [l.key, l.miles]), [["finish", 300]]);
	});
	check("a fix 3 h old: rows from it, position 'old', age 180", () => {
		const df = at(on, "fix 3 h old / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([df.position, df.positionAgeMinutes, df.legs.map((l) => l.key)], ["old", 180, ["pickup", "finish"]]);
	});
	check("no fix for 13 h: fuel 'stale' with its age, one whole-load row to check the gauge", () => {
		const df = at(on, "no fix for 13 h (fuel stale too) / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([df.fuelState, df.milesLeft, df.fuelReadAgeMinutes, df.position, df.legs.map((l) => [l.key, l.miles, l.status])],
			["stale", null, 780, "none", [["whole_load", null, "check_gauge"]]]);
	});
	check("sensor dropout: the top keeps its figure, marked 'estimated'; the rows have no number", () => {
		const df = at(on, "sensor dropout (carried) / trip-plan, Driver").body.driverFuel;
		assert.ok(df.fuelState === "estimated" && Number.isFinite(df.milesLeft) && df.legs.length > 0 && df.legs.every(numberless), JSON.stringify(df));
	});
	check("no tank size and no fill history: no miles, 'no_tank_size', rows say what the tank needs", () => {
		const df = at(on, "no tank size, no fill history / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([df.fuelState, df.milesLeft, df.legs.every((l) => l.status === "check_gauge" && l.needInTankGallons > 0)], ["no_tank_size", null, true]);
	});
	check("no truck linked: 'no_truck', one whole-load row with no number (the run to the pickup can't be counted)", () => {
		const df = at(on, "no truck linked / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([df.fuelState, df.milesLeft, df.approachUncounted, df.legs.map((l) => [l.key, l.status, l.miles, l.needInTankGallons])],
			["no_truck", null, true, [["whole_load", "check_gauge", null, null]]]);
		assert.strictEqual(at(on, "no truck linked / range, Driver").body.driverFuel.fuelState, "no_truck");
	});
	// Arvin's option (a): before pickup with no truck position the run to the pickup
	// can't be counted, so the whole-load row has no number and the block says why.
	for (const [w, state] of [
		["before pickup, no ELD device on the truck", "none"],
		["before pickup, no fuel level, ELD silent 8 h", "none"],
		["before pickup, device re-linked 5 min ago (its newest fix is from before)", "none"],
		// Past 6 h to the millisecond, so not trusted, like its fix (§7e).
		["6 h edge: an 80% reading 6 h 18 s old, before pickup", "stale"],
	]) {
		check(`${w}: approachUncounted, one whole-load row with no number`, () => {
			const b = at(on, `${w} / trip-plan, Driver`).body;
			assert.deepStrictEqual([b.fromLivePosition, b.driverFuel.fuelState, b.driverFuel.approachUncounted,
				b.driverFuel.legs.map((l) => [l.key, l.status, l.miles, l.usesGallons, l.needInTankGallons])],
			[false, state, true, [["whole_load", "check_gauge", null, null, null]]]);
		});
	}
	check("…the control: after pickup with no position the whole load over-counts, so it keeps its figures (no approachUncounted)", () => {
		const df = at(on, "after pickup, no ELD device on the truck / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([df.approachUncounted, df.legs.map((l) => [l.key, l.miles, l.needInTankGallons > 0])], [false, [["whole_load", 280, true]]]);
	});
	check("Routes down: the distance is marked estimated", () => {
		assert.strictEqual(at(on, "Routes down (straight line) / trip-plan, Driver").body.driverFuel.routeEstimated, true);
		assert.strictEqual(at(on, "before pickup, live fix / trip-plan, Driver").body.driverFuel.routeEstimated, false);
	});
	check("delivered: no legs", () => {
		const df = at(on, "delivered / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([df.loadDone, df.legs], [true, []]);
	});
	check("another load in transit and '3 stops' in Details: both flags; a plain load has neither", () => {
		const df = at(on, "another load in transit, 3 stops / trip-plan, Driver").body.driverFuel;
		const plain = at(on, "before pickup, live fix / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([df.afterAnotherLoad, df.extraStops, plain.afterAnotherLoad, plain.extraStops], [true, true, false, false]);
	});
	check("the rate-con stop list with two pickups marks extra stops", () => {
		assert.strictEqual(at(on, "stop list with two pickups / trip-plan, Driver").body.driverFuel.extraStops, true);
	});

	// The reading's 6 h on the fix's exact clock, through both routes (§7e). Worlds of
	// their own, so the counts and digests above are unchanged.
	const edge = async (o) => {
		const wOn = buildWorld(Database, lifted, appRequire, o, true);
		const wOff = buildWorld(Database, lifted, appRequire, o, false);
		return { plan: await wOn.plan(), range: await wOn.range(), planOff: await wOff.plan(), rangeOff: await wOff.range() };
	};
	const legFigures = (df) => df.legs.map((l) => [l.key, l.status, l.miles, l.usesGallons, l.needInTankGallons]);
	for (const [label, fixAgoMin] of [["exactly 6 h", 360], ["6 h 15 s", 360.25]]) {
		const e = await edge({ status: "In Transit", fuel: 80, fixAgoMin });
		check(`in transit, an 80% reading ${label} old, ELD silent since: 'stale' on both routes, the whole-load row has no number (no 'enough')`, () => {
			const df = e.plan.body.driverFuel;
			assert.deepStrictEqual([e.plan.body.fromLivePosition, df.fuelState, df.milesLeft, legFigures(df), e.range.body.driverFuel.fuelState],
				[false, "stale", null, [["whole_load", "check_gauge", null, null, null]], "stale"]);
		});
		check(`...flag off, the ${label} answers are as before (only driverFuel added)`, () => {
			assert.deepStrictEqual([omitDriverFuel(e.plan.body), omitDriverFuel(e.range.body)], [e.planOff.body, e.rangeOff.body]);
		});
	}
	{
		const e = await edge({ status: "In Transit", fuel: 80, fixAgoMin: 359.99 });
		check("...the control, a fix 0.6 s under 6 h: planned from it, the reading live, the finish row keeps its figures", () => {
			const df = e.plan.body.driverFuel;
			assert.deepStrictEqual([e.plan.body.fromLivePosition, df.fuelState, df.milesLeft, legFigures(df), e.range.body.driverFuel.fuelState],
				[true, "live", 385, [["finish", "enough", 300, 55, 105]], "live"]);
		});
	}

	await liveVerdictSection(Database, lifted, appRequire);
	await arrivalSection(Database, lifted, appRequire);
}

// === §10 the live verdict, flag off ==========================================
// The answer a driver ("You can make this run") and the dispatch card ("Route
// clears") read. A pass must not rest on a route that skips the shipper ahead,
// on a carried level burned at a gentler rate than the verdict plans at, or on a
// reading 6 h old or carried with no miles since.
async function liveVerdictSection(Database, lifted, appRequire) {
	console.log("\n§10 the live trip-plan verdict, flag off: never 'clears' when the truck could run short");
	const args = { routeMiles: 300, fuelPct: 70, burn: BURN5, rangeMiles: 630, mpg: 6.0, reserve: R15 };
	check("planTripFuel: a pass on a route that leaves out the run to the shipper is held at 'tight' (stop, no shortfall, the same refuel distance)", () => {
		const counted = fuel.planTripFuel(args);
		const held = fuel.planTripFuel({ ...args, approachCounted: false });
		assert.deepStrictEqual([counted.verdict, counted.canMakeIt, counted.shortfallMiles], ["clears", true, 0]);
		assert.deepStrictEqual([held.verdict, held.canMakeIt, held.shortfallMiles, held.refuelWithinMiles, held.decidedOn, held.requiredMiles],
			["tight", false, null, counted.refuelWithinMiles, counted.decidedOn, counted.requiredMiles]);
	});
	check("planTripFuel: 'tight' and 'insufficient' already say stop, so they stay as they are", () => {
		for (const fuelPct of [50, 20]) {
			const a = { ...args, fuelPct };
			assert.deepStrictEqual(fuel.planTripFuel({ ...a, approachCounted: false }), fuel.planTripFuel(a), `${fuelPct}%`);
		}
		assert.deepStrictEqual([50, 20].map((fuelPct) => fuel.planTripFuel({ ...args, fuelPct }).verdict), ["tight", "insufficient"]);
	});

	const carried = (o) => ({ fuelSource: "carried", ageMinutes: 240, anchorAtMs: NOW - 240 * 60000, ...o });
	const levelOf = (reading, burn = BURN5, tankGallons = 150, mpg = 6.0) => fuel.planningRateFuelPct({ reading, burn, tankGallons, mpg });
	check("planningRateFuelPct: a carried level is burned at the planning rate (100% less 300 mi at p10 5.0 is 40%, not 66.7%; 58.5% on the estimate, not 76.9%)", () => {
		assert.strictEqual(levelOf(carried({ fuelPct: 66.7, anchorPct: 100, milesSinceReading: 300 })), 40);
		// 300 mi x 1.8 / (200 gal x 6.5 MPG) = 41.5 points; at the MPG on file it was 23.1.
		assert.strictEqual(levelOf(carried({ fuelPct: 76.9, anchorPct: 100, milesSinceReading: 300 }), NO_BURN, 0, 6.5), 58.5);
	});
	check("planningRateFuelPct: the lower level is kept, so a measured rate gentler than the MPG on file leaves the MPG level (and the verdict with it)", () => {
		const gentle = { ...BURN5, p10: 12, p50: 14, p90: 16 };
		// 300 mi at 6.0 MPG from a 150-gal tank is 33.3 points (26.7% left); at p10 12 it would be 25 (35% left).
		const pct = levelOf(carried({ fuelPct: 26.7, anchorPct: 60, milesSinceReading: 300 }), gentle);
		const verdictAt = (fuelPct) => fuel.planTripFuel({ routeMiles: 330, fuelPct, burn: gentle, rangeMiles: 0, mpg: 6.0, reserve: R15 }).verdict;
		assert.deepStrictEqual([pct, verdictAt(pct), verdictAt(35)], [26.7, "tight", "clears"]);
	});
	check("planningRateFuelPct: a live, stale or missing reading, or a carried one with no miles since, is returned as it is", () => {
		assert.deepStrictEqual([
			levelOf({ fuelSource: "live", fuelPct: 48, anchorPct: 48, milesSinceReading: 0, ageMinutes: 12 }),
			levelOf({ fuelSource: "stale", fuelPct: null, anchorPct: 80, milesSinceReading: null, ageMinutes: 540 }),
			levelOf({ fuelSource: "none", fuelPct: null, anchorPct: null, milesSinceReading: null, ageMinutes: null }),
			levelOf(carried({ fuelPct: 90, anchorPct: 90, milesSinceReading: null })),
			levelOf(carried({ fuelPct: 90, anchorPct: 90, milesSinceReading: 0 })),
			levelOf(null),
		], [48, null, null, 90, 90, null]);
	});
	check("planningRateFuelPct sweep: after a dropout the level never rises, and the planning miles are at most the anchor's less the miles driven", () => {
		const bad = [];
		let runs = 0;
		const gentle = { ...BURN5, p10: 12, p50: 14, p90: 16 };
		for (const [burn, tank, mpg] of [[BURN5, 150, 6.0], [NO_BURN, 150, 6.0], [NO_BURN, 0, 6.5], [BURN5, 0, 8.0], [gentle, 150, 6.0]]) {
			const planningAt = (p) => fuel.rangeInterval({ fuelPct: p, burn, rangeMiles: fuel.computeRange({ fuelPct: p, tankGallons: tank, mpg }).rangeMiles }).planning;
			for (const anchorPct of [20, 45, 70, 100]) for (const milesSinceReading of [10, 80, 150, 300, 600]) {
				const mpgPct = Math.max(0, anchorPct - (milesSinceReading / mpg / (tank || 200)) * 100);   // resolveFuelReading()'s decay
				const reading = carried({ fuelPct: Math.round(mpgPct * 10) / 10, anchorPct, milesSinceReading });
				const pct = levelOf(reading, burn, tank, mpg);
				runs++;
				if (!(pct <= reading.fuelPct)) bad.push(["rose", anchorPct, milesSinceReading, pct, reading.fuelPct]);
				if (planningAt(pct) > Math.max(0, planningAt(anchorPct) - milesSinceReading) + 1) bad.push(["planning", anchorPct, milesSinceReading, planningAt(pct)]);
			}
		}
		assert.strictEqual(runs, 100);
		assert.deepStrictEqual(bad.slice(0, 5), []);
	});

	const SIX_H = 6 * 60 * 60 * 1000;
	const liveAt = (agoMs) => ({ fuelSource: "live", fuelPct: 80, anchorPct: 80, milesSinceReading: 0, anchorAtMs: NOW - agoMs, ageMinutes: Math.round(agoMs / 60000) });
	check("tripReadingTrusted: under 6 h to the millisecond (1 ms under is trusted; exactly 6 h, 1 ms over, or a future time is not)", () => {
		const t = (reading) => fuel.tripReadingTrusted({ reading, nowMs: NOW });
		assert.deepStrictEqual([t(liveAt(12 * 60000)), t(liveAt(SIX_H - 1)), t(liveAt(SIX_H)), t(liveAt(SIX_H + 1)), t(liveAt(-1000))],
			[true, true, false, false, false]);
		// No time to judge the reading by is no pass, whatever its rounded age says.
		assert.strictEqual(t({ fuelSource: "live", fuelPct: 80, anchorPct: 80, milesSinceReading: 0, ageMinutes: 12 }), false);
	});
	check("tripReadingTrusted: a carried reading is trusted only on miles since measured between two real odometers (50, or 0 parked), not with none or between zeros", () => {
		const t = (milesSinceReading, milesSinceMeasured) => fuel.tripReadingTrusted({
			reading: carried({ fuelPct: 90, anchorPct: 90, milesSinceReading, milesSinceMeasured, anchorAtMs: NOW - 60 * 60000 }), nowMs: NOW });
		assert.deepStrictEqual([t(null, false), t(0, true), t(50, true), t(0, false), t(0, undefined)], [false, true, true, false, false]);
	});
	check("resolveFuelReading: miles since count as measured only between two real odometers (a 0 is how the feeds store a missing one)", () => {
		const measured = (anchorOdo, latestOdo) => {
			const r = fuel.resolveFuelReading({ rows: [{ fuel_pct: 0, odometer: latestOdo, location_date_ms: NOW - 60000 },
				{ fuel_pct: 90, odometer: anchorOdo, location_date_ms: NOW - 120 * 60000 }], mpg: 6.0, tankGallons: 150, nowMs: NOW });
			return [r.fuelSource, r.milesSinceReading, r.milesSinceMeasured];
		};
		assert.deepStrictEqual([measured(99950, 100000), measured(100000, 100000), measured(0, 0), measured(0, 100000), measured(100500, 0), measured(null, null)],
			[["carried", 50, true], ["carried", 0, true], ["carried", 0, false], ["carried", 100000, false], ["carried", null, false], ["carried", null, false]]);
	});
	check("planTripFuel: a pass on a reading it can't count on is held at 'tight'; 'tight' and 'insufficient' stay; left out, it is trusted", () => {
		const held = fuel.planTripFuel({ ...args, readingTrusted: false });
		assert.deepStrictEqual([held.verdict, held.canMakeIt, held.shortfallMiles, held.refuelWithinMiles], ["tight", false, null, fuel.planTripFuel(args).refuelWithinMiles]);
		for (const fuelPct of [50, 20]) {
			const a = { ...args, fuelPct };
			assert.deepStrictEqual(fuel.planTripFuel({ ...a, readingTrusted: false }), fuel.planTripFuel(a), `${fuelPct}%`);
		}
		assert.strictEqual(fuel.planTripFuel({ ...args, readingTrusted: true, approachCounted: true }).verdict, "clears");
	});

	// Through the route, as the driver (DriverFuelPanel) and as the dispatch card
	// (FuelFinderPanel: the load alone, no vehicle) ask it.
	const pick = (b) => ({ verdict: b.verdict, canMakeIt: b.canMakeIt, shortfallMiles: b.shortfallMiles, fuelStopsRecommended: b.fuelStopsRecommended,
		refuelWithinMiles: b.refuelWithinMiles, fuelPct: b.fuelPct, routeMiles: b.routeMiles, leg: b.leg, fromLivePosition: b.fromLivePosition });
	const answer = (verdict, canMakeIt, shortfallMiles, refuelWithinMiles, fuelPct, routeMiles, leg, fromLivePosition) => ({ verdict, canMakeIt, shortfallMiles,
		fuelStopsRecommended: verdict === "tight" || verdict === "insufficient", refuelWithinMiles, fuelPct, routeMiles, leg, fromLivePosition });
	const LIVE = [
		["T1 before pickup, the pickup not on the map, 70%: routed truck to delivery past the shipper (300 counted, 420 ahead)",
			{ pickupMapped: false, fuel: 70 }, answer("tight", false, null, 335, 70, 300, "to_delivery", true)],
		["T2 in transit, a 4 h dropout from 100%, 300 mi since: 40% at the planning rate (200 mi against 315), not 66.7%",
			{ status: "In Transit", fuel: 0, anchor: { fuel: 100, agoMin: 240, odo: 99700 } }, answer("insufficient", false, 100, 185, 40, 300, "to_delivery", true)],
		["P3 before pickup, the ELD silent 8 h after an 80% reading: planned from the pickup, the run to the shipper not counted",
			{ fuel: 80, fixAgoMin: 480 }, answer("tight", false, null, 385, 80, 280, "to_delivery", false)],
		["P4 in transit, an 80% reading 9 h old, the ELD silent since: the truck may have driven far on it",
			{ status: "In Transit", fuel: 80, fixAgoMin: 540 }, answer("tight", false, null, 385, 80, 280, "to_delivery", false)],
		["P5 in transit, a dropout whose odometer reads behind its anchor: no miles since, so 90% carried unburned",
			{ status: "In Transit", fuel: 0, anchor: { fuel: 90, agoMin: 120, odo: 100500 } }, answer("tight", false, null, 435, 90, 300, "to_delivery", true)],
		["P4-edge in transit, an 80% reading exactly 6 h old: planned from the pickup and held",
			{ status: "In Transit", fuel: 80, fixAgoMs: 6 * 60 * 60 * 1000 }, answer("tight", false, null, 385, 80, 280, "to_delivery", false)],
		["P4-carried in transit, a fresh fix but a reading carried from 7 h ago (50 mi since): held",
			{ status: "In Transit", fuel: 0, anchor: { fuel: 100, agoMin: 420, odo: 99950 } }, answer("tight", false, null, 435, 90, 300, "to_delivery", true)],
		["P5-zero in transit, a dropout whose two odometers are both 0 (how the feeds store a missing one): 0 mi since is unknown, so 90% unburned is held",
			{ status: "In Transit", fuel: 0, odo: 0, anchor: { fuel: 90, agoMin: 120, odo: 0 } }, answer("tight", false, null, 435, 90, 300, "to_delivery", true)],
	];
	const CONTROLS = [
		["control: before pickup, a live fix and 100%: the run to the shipper is routed (140 + 280), so it still clears",
			{ fuel: 100 }, answer("clears", true, 0, 485, 100, 420, "to_pickup", true)],
		["control: in transit, a live fix and 80%: the miles ahead are all routed, so it still clears",
			{ status: "In Transit", fuel: 80 }, answer("clears", true, 0, 385, 80, 300, "to_delivery", true)],
		["control: in transit, an 80% reading 1 ms under 6 h: planned from that fix, so it still clears",
			{ status: "In Transit", fuel: 80, fixAgoMs: 6 * 60 * 60 * 1000 - 1 }, answer("clears", true, 0, 385, 80, 300, "to_delivery", true)],
		["control: in transit, a 2 h dropout from 100% with 50 mi since: 90% at the planning rate, so it still clears",
			{ status: "In Transit", fuel: 0, anchor: { fuel: 100, agoMin: 120, odo: 99950 } }, answer("clears", true, 0, 435, 90, 300, "to_delivery", true)],
		["control: in transit, a 2 h dropout from 90% parked (both odometers 100,000): 0 mi measured, so it still clears",
			{ status: "In Transit", fuel: 0, anchor: { fuel: 90, agoMin: 120, odo: 100000 } }, answer("clears", true, 0, 435, 90, 300, "to_delivery", true)],
	];
	const asked = [];
	for (const [label, o, want] of [...LIVE, ...CONTROLS]) {
		const w = buildWorld(Database, lifted, appRequire, o, false);
		const driver = await w.plan();
		const card = await w.plan(DISPATCH);
		asked.push({ label, want, driver, card });
	}
	for (const { label, want, driver, card } of asked) {
		check(label, () => {
			assert.deepStrictEqual([driver.status, card.status], [200, 200]);
			assert.deepStrictEqual(pick(driver.body), want, "the driver's answer");
			assert.deepStrictEqual(pick(card.body), want, "the dispatch card's answer");
		});
	}

	// The card's own words for those answers, from the module it renders them with.
	let review = null;
	let reviewError = null;
	try {
		review = await import(pathToFileURL(path.join(__dirname, "..", "client", "src", "lib", "fuelReview.js")).href);
	} catch (e) { reviewError = e.message; }
	check("the dispatch card reads this verdict: it asks the route for the load alone and prints tripVerdict(verdict).dispatch, never 'Route clears' in the cases above", () => {
		if (reviewError) assert.fail(reviewError);
		const vue = fs.readFileSync(path.join(__dirname, "..", "client", "src", "components", "dashboard", "FuelFinderPanel.vue"), "utf8");
		for (const pin of ["api.get(`/api/fuel/trip-plan?loadId=${encodeURIComponent(props.loadId)}`)",
			"const verdict = computed(() => (plan.value ? tripVerdict(plan.value.verdict) : null))",
			"{{ verdict.dispatch }}"]) {
			assert.ok(vue.includes(pin), `FuelFinderPanel.vue no longer has: ${pin}`);
		}
		const lines = asked.filter((x) => LIVE.some(([label]) => label === x.label)).map((x) => [x.label.split(" ")[0], review.tripVerdict(x.card.body.verdict).dispatch]);
		const tight = "Tight — plan a stop";
		assert.deepStrictEqual(lines, [["T1", tight], ["T2", "Will not reach — fuel stop required"], ["P3", tight], ["P4", tight], ["P5", tight],
			["P4-edge", tight], ["P4-carried", tight], ["P5-zero", tight]]);
	});
}

// === §11 picked up only on the ELD or a geofence arrival =====================
// A load marked In Transit before the truck reaches the shipper must keep the run
// to the shipper in the plan. Made-up case: the truck is 75 mi short of the
// shipper and 160 mi from the receiver, the lane is 280 mi, and 60% at p10 5.5
// gives 330 mi to plan on. Skipping the shipper planned 160 mi and cleared; the
// miles ahead are 75 + 280 = 355, and 355 + 15 needs more than 330.
async function arrivalSection(Database, lifted, appRequire) {
	console.log("\n§11 picked up only on the ELD or a geofence arrival");
	let arrival = null;
	let arrivalError = null;
	try { arrival = require("../lib/fuel-pickup-arrival"); } catch (e) { arrivalError = e.message; }
	const lib = () => { if (!arrival) assert.fail(`lib/fuel-pickup-arrival.js: ${arrivalError}`); return arrival; };
	// Rows as the history stores them, written by the load's driver unless a row names another actor.
	const H = (new_status, source, agoMin, extra = {}) => ({ new_status, source, actor: "Driver QA", changed_at: sqlStamp(NOW - agoMin * 60000), ...extra });
	const HOUR_MIN = 60;
	const normalizeDriverName = new Function(`${declText("normalizeDriverName")}\nreturn normalizeDriverName;`)();
	const OPTS = { driver: "Driver QA", normalizeName: normalizeDriverName };
	const D50 = H("Dispatched", "dispatch", 50 * HOUR_MIN, { actor: "dispatch_qa" });
	const runOf = (...rows) => lib().currentRun([D50, ...rows]).rows;

	check("currentRun: plan A's undo rule starts the run (a staff or sheet move back after an arrival cuts it, the driver's own stale Accept doesn't), so does a later Dispatched row, and nothing before the last Cancelled counts", () => {
		const at = (rows) => { const r = lib().currentRun(rows); return r && [r.rows.map((x) => x.status), r.startMs]; };
		const AS40 = H("At Shipper", "geofence", 40 * HOUR_MIN);
		assert.deepStrictEqual([
			at([D50, AS40, H("Heading to Shipper", "manual", 30 * HOUR_MIN), H("In Transit", "manual", 20 * HOUR_MIN)]),
			at([D50, AS40, H("Assigned", "accept", 30 * HOUR_MIN), H("In Transit", "manual", 20 * HOUR_MIN)]),
			at([D50, AS40, H("In Transit", "manual", 20 * HOUR_MIN, { old_status: "Assigned" })]),
			at([D50, AS40, H("Assigned", "accept", 30 * HOUR_MIN, { actor_role: "Driver" }), H("In Transit", "manual", 20 * HOUR_MIN, { actor_role: "Driver" })]),
			at([D50, H("Dispatched", "dispatch", 30 * HOUR_MIN), H("In Transit", "manual", 20 * HOUR_MIN)]),
			at([D50, AS40, H("Cancelled", "cancel", 30 * HOUR_MIN), H("Assigned", "accept", 20 * HOUR_MIN), H("In Transit", "manual", 10 * HOUR_MIN)]),
		], [
			[["heading to shipper", "in transit"], NOW - 30 * 3600000],
			[["assigned", "in transit"], NOW - 30 * 3600000],
			[["in transit"], NOW - 20 * 3600000],
			[["dispatched", "at shipper", "assigned", "in transit"], NOW - 50 * 3600000],
			[["dispatched", "in transit"], NOW - 30 * 3600000],
			[["assigned", "in transit"], NOW - 20 * 3600000],
		]);
		assert.deepStrictEqual(lib().currentRun([D50, AS40]).rows.map((x) => x.actor), ["dispatch_qa", "Driver QA"]);
		assert.deepStrictEqual([at([]), at([H("Cancelled", "cancel", 10)]), at(null)], [null, null, null]);
	});
	check("historyArrival: by the load's driver now, a geofence 'At Shipper' or one set with the recorder's ELD fix inside the pickup zone; never a tap with no fix or one outside, a departure, another status, another driver's row or a staff override", () => {
		const by = (row) => lib().historyArrival(runOf(row), OPTS).by;
		assert.deepStrictEqual([
			by(H("At Shipper", "geofence", 60)),
			by(H("At Shipper", "geofence", 60, { actor_role: "system", pickup_zone: "inside", other_load_hauling: 0 })),
			by(H("At Shipper", "manual", 60, { actor_role: "Driver", pickup_zone: "inside" })),
			by(H("At Shipper", "manual", 60, { actor_role: "Super Admin", pickup_zone: "inside" })),
			by(H("At Shipper", "override", 60, { actor: "dispatch_qa", actor_role: "Dispatcher", pickup_zone: "inside" })),
			by(H("At Shipper", "manual", 60, { actor_role: "Driver", pickup_zone: "" })),
			by(H("At Shipper", "manual", 60, { actor_role: "Driver", pickup_zone: "outside" })),
			by(H("At Shipper", "manual", 60)),
			by(H("In Transit", "geofence", 60)),
			by(H("Loading", "manual", 60, { pickup_zone: "inside" })),
			by(H("At Shipper", "geofence", 60, { actor: "Driver Prior" })),
			by(H("At Shipper", "geofence", 60, { actor: " driver  QA" })),
			by(H("At Shipper", "geofence", 60, { actor: "" })),
		], ["geofence", "geofence", "recorded_fix", "recorded_fix", null, null, null, null, null, null, null, "geofence", null]);
		assert.strictEqual(lib().historyArrival(runOf(H("At Shipper", "geofence", 60)), { ...OPTS, driver: "" }).by, null);
	});
	check("historyArrival: an arrival made while another load was under way (the recorder's mark, or the check rebuilt from the history) is no arrival, and holds the ELD test from the later of its fix and row times", () => {
		const hold = (rows, errandAt) => { const r = lib().historyArrival(rows, { ...OPTS, errandAt }); return [r.by, r.holdMs]; };
		assert.deepStrictEqual(hold(runOf(H("At Shipper", "geofence", 120, { other_load_hauling: 1, pickup_zone: "inside", fix_ms: NOW - 125 * 60000 }),
			H("At Shipper", "geofence", 60, { other_load_hauling: 1, pickup_zone: "inside" }))), [null, NOW - 60 * 60000]);
		assert.deepStrictEqual(hold(runOf(H("At Shipper", "geofence", 120, { other_load_hauling: 1, fix_ms: NOW - 125 * 60000 }))), [null, NOW - 120 * 60000]);
		assert.deepStrictEqual(hold(runOf(H("At Shipper", "geofence", 120, { other_load_hauling: 1, fix_ms: NOW - 118 * 60000 }))), [null, NOW - 118 * 60000]);
		assert.deepStrictEqual(hold(runOf(H("At Shipper", "geofence", 120, { other_load_hauling: 0 }))), ["geofence", null]);
		assert.strictEqual(lib().historyArrival(runOf(H("At Shipper", "geofence", 120, { other_load_hauling: 1 }), H("At Shipper", "geofence", 60, { other_load_hauling: 0 })), OPTS).by, "geofence");
		// Rebuilt: an errand up to 90 min ago.
		const errandAt = (ms) => ms <= NOW - 90 * 60000;
		assert.deepStrictEqual([
			hold(runOf(H("At Shipper", "geofence", 120)), errandAt),
			hold(runOf(H("At Shipper", "manual", 120, { actor_role: "Driver", pickup_zone: "inside" })), errandAt),
			hold(runOf(H("At Shipper", "geofence", 120), H("At Shipper", "geofence", 60)), errandAt),
			hold(runOf(H("At Shipper", "geofence", 120)), () => false),
		], [[null, NOW - 120 * 60000], [null, NOW - 120 * 60000], ["geofence", NOW - 120 * 60000], ["geofence", null]]);
	});
	check("otherLoadUnderWayAt: another of the driver's loads (his on the sheet, or with a row by him) whose last status by then was Heading to Shipper, At Shipper, Loading or In Transit", () => {
		const R = (loadId, new_status, agoMin, actor = "Driver QA") => ({ load_id: loadId, new_status, actor, changed_at: sqlStamp(NOW - agoMin * 60000) });
		const at = (history, sheetLoadIds = []) => {
			const f = lib().otherLoadUnderWayAt({ history, loadId: "QA-FUEL-1", driver: "Driver QA", sheetLoadIds, normalizeName: normalizeDriverName });
			return [50, 39, 30, 15, 5].map((h) => f(NOW - h * 3600000));
		};
		const OTHER = [R("qa-fuel-0", "Dispatched", 60 * 60, "dispatch_qa"), R("qa-fuel-0", "In Transit", 40 * 60), R("qa-fuel-0", "At Receiver", 20 * 60),
			R("qa-fuel-0", "Delivered", 10 * 60)];
		const BY_STAFF = [R("qa-fuel-2", "Loading", 40 * 60, "dispatch_qa"), R("qa-fuel-2", "Delivered", 20 * 60, "dispatch_qa")];
		assert.deepStrictEqual([
			at(OTHER),
			at(OTHER.map((r) => ({ ...r, actor: r.actor === "Driver QA" ? "  driver QA" : r.actor }))),
			at(BY_STAFF, ["QA-FUEL-2"]),
			at(BY_STAFF),
			at([R("qa-fuel-3", "In Transit", 40 * 60, "Driver Other")]),
			at([R("qa-fuel-1", "In Transit", 40 * 60)], ["QA-FUEL-1"]),
			at([R("qa-fuel-4", "Heading to Shipper", 45 * 60), R("qa-fuel-4", "Cancelled", 35 * 60)]),
			at([R("qa-fuel-5", "At Shipper", 45 * 60), R("qa-fuel-5", "Delivered", 35 * 60)]),
		], [
			[false, true, true, false, false],
			[false, true, true, false, false],
			[false, true, true, false, false],
			[false, false, false, false, false],
			[false, false, false, false, false],
			[false, false, false, false, false],
			[false, true, false, false, false],
			[false, true, false, false, false],
		]);
	});
	check("eldArrivalMs: the live geofence's arrival test on the truck's own fixes: inside the radius, at arrival speed (none counts, as live), the fix before it inside too", () => {
		const P = { latitude: PICKUP.lat, longitude: PICKUP.lng };
		const near = (dLat) => ({ latitude: PICKUP.lat + dLat, longitude: PICKUP.lng });   // 0.01 deg is about 1.1 km
		const far = { latitude: FIX.lat, longitude: FIX.lng };
		const fx = (ms, p, speed) => ({ ms, latitude: p.latitude, longitude: p.longitude, speed });
		const opts = { pickup: P, radiusM: 3218.69, maxSpeedMps: 4.5 };
		const t = (fixes, o = opts) => lib().eldArrivalMs(fixes, o);
		assert.deepStrictEqual([
			t([fx(1, far, 25), fx(2, near(0.02), 20), fx(3, near(0.01), 2), fx(4, P, 0)]),
			t([fx(1, near(0.01), 25), fx(2, P, 25)]),
			t([fx(1, far, 2), fx(2, P, 1), fx(3, far, 25)]),
			t([fx(1, near(0.01), null), fx(2, P, null)]),
			t([fx(1, P, 4.5), fx(2, P, 4.5)]),
			t([fx(1, P, 4.6), fx(2, P, 4.6)]),
			t([fx(1, near(0.04), 1), fx(2, near(0.04), 1)]),
			t([fx(1, P, 1), fx(2, P, 1)], { ...opts, pickup: null }),
			t([fx(1, P, 1), fx(2, P, 1)], { ...opts, radiusM: 0 }),
			t([]),
		], [3, null, null, 2, 2, null, null, null, null, null]);
	});
	check("eldArrivalMs with a hold: that visit never counts, even as the truck lingers; once it has left the zone, a later arrival does", () => {
		const P = { latitude: PICKUP.lat, longitude: PICKUP.lng };
		const far = { latitude: FIX.lat, longitude: FIX.lng };
		const fx = (ms, p, speed) => ({ ms, latitude: p.latitude, longitude: p.longitude, speed });
		const t = (fixes, holdMs) => lib().eldArrivalMs(fixes, { pickup: P, radiusM: 3218.69, maxSpeedMps: 4.5, holdMs });
		assert.deepStrictEqual([
			t([fx(1, P, 1), fx(2, P, 1), fx(3, P, 0), fx(4, P, 0), fx(5, P, 0), fx(6, P, 0)], 2),
			t([fx(1, P, 1), fx(2, P, 1), fx(3, far, 20), fx(4, P, 2), fx(5, P, 0)], 2),
			t([fx(1, far, 20), fx(2, P, 1), fx(3, P, 0)], 1),
			t([fx(1, P, 1), fx(2, P, 1), fx(3, P, 0)], null),
		], [null, 5, null, 2]);
	});
	check("eldArrivalMs with an errand check: a visit made while another load was under way is held like a hold, until the truck has left the zone", () => {
		const P = { latitude: PICKUP.lat, longitude: PICKUP.lng };
		const far = { latitude: FIX.lat, longitude: FIX.lng };
		const fx = (ms, p, speed) => ({ ms, latitude: p.latitude, longitude: p.longitude, speed });
		const t = (fixes) => lib().eldArrivalMs(fixes, { pickup: P, radiusM: 3218.69, maxSpeedMps: 4.5, errandAt: (ms) => ms <= 3 });
		assert.deepStrictEqual([
			t([fx(1, P, 1), fx(2, P, 1), fx(3, P, 0), fx(4, P, 0), fx(5, P, 0)]),
			t([fx(1, P, 1), fx(2, P, 1), fx(3, far, 20), fx(4, P, 1), fx(5, P, 0)]),
			t([fx(4, P, 1), fx(5, P, 0)]),
		], [null, 5, 5]);
	});

	// The twin hold: an arrival is held when another of his loads has an "At Shipper"
	// row in the same visit, the stretch around it in which the truck stays within
	// 25 mi of the pickup (or half the lane).
	const MIN = 60000;
	const P_AT = { latitude: PICKUP.lat, longitude: PICKUP.lng };
	const north = (miles) => ({ latitude: PICKUP.lat + miles / 69.05, longitude: PICKUP.lng });
	check("visitRadiusM: 25 mi, or half the lane (pickup to receiver, a straight line) when that is less; none with no mapped pickup", () => {
		const r = (p, d) => lib().visitRadiusM(p, d);
		assert.strictEqual(r(P_AT, { latitude: DROP.lat, longitude: DROP.lng }), 25 * 1609.344);
		assert.strictEqual(r(P_AT, null), 25 * 1609.344);
		assert.strictEqual(r(null, { latitude: DROP.lat, longitude: DROP.lng }), null);
		const half = r(P_AT, north(20)) / 1609.344;
		assert.ok(half > 9.9 && half < 10.1, `a 20-mi lane: ${half} mi`);
		assert.strictEqual(r(P_AT, north(52)), 25 * 1609.344, "a 52-mi lane");
		const under = r(P_AT, north(48)) / 1609.344;
		assert.ok(under > 23.9 && under < 24.1, `a 48-mi lane: ${under} mi`);
	});
	check("visitBounds: within the radius on each side, out to the first fix beyond it or 2 h past the last fix within it, whichever comes first; a gap within it stays in; 2 h either side with no fixes or no mapped pickup", () => {
		const A = 1000 * MIN;
		const R25 = 25 * 1609.344;
		const fx = (min, p) => ({ ms: A + min * MIN, latitude: p.latitude, longitude: p.longitude });
		const IN = north(10);
		const OUT = north(30);
		const b = (fixes, o = { pickup: P_AT, radiusM: R25 }) => lib().visitBounds(A, fixes, o).map((ms) => (ms - A) / MIN);
		assert.strictEqual(lib().VISIT_SIDE_MS, 2 * 60 * MIN);
		assert.deepStrictEqual([
			b([]),
			b([fx(-30, OUT), fx(-20, IN), fx(0, P_AT), fx(20, IN), fx(30, OUT)]),
			b([fx(-30, OUT), fx(-20, IN), fx(0, P_AT), fx(20, IN), fx(30, OUT)], { pickup: null, radiusM: R25 }),
			b([fx(-300, OUT), fx(-60, IN), fx(60, IN), fx(360, OUT)]),
			b([fx(-600, IN), fx(0, P_AT), fx(600, IN), fx(660, OUT)]),
			b([fx(-1, OUT), fx(1, OUT)]),
			b([fx(-20, IN), fx(20, IN)]),
			b([fx(-30, north(12)), fx(30, north(12))]),
			b([fx(-30, north(12)), fx(30, north(12))], { pickup: P_AT, radiusM: lib().visitRadiusM(P_AT, north(20)) }),
		], [
			[-120, 120],
			[-30, 30],
			[-120, 120],
			[-180, 180],
			[-720, 660],
			[-1, 1],
			[-140, 140],
			[-150, 150],
			[-30, 30],
		]);
	});
	check("twinAtShipper: another of his loads (his on the sheet, or with a row by him) with an 'At Shipper' row in the visit, by anyone and from any source; never another status, another driver's load, this load's own row or a row after now", () => {
		const A = NOW - 30 * 60 * MIN;
		const R = (loadId, new_status, msAt, actor = "Driver QA", source = "geofence") => ({ load_id: loadId, new_status, actor, source, changed_at: sqlStamp(msAt) });
		const at = (history, o = {}) => lib().twinAtShipper({ history, loadId: "QA-FUEL-1", driver: "Driver QA", normalizeName: normalizeDriverName,
			pickup: P_AT, radiusM: 25 * 1609.344, nowMs: NOW, ...o })(A);
		assert.deepStrictEqual([
			at([R("qa-fuel-0", "At Shipper", A + MIN)]),
			at([R("qa-fuel-0", "At Shipper", A - MIN)]),
			at([R("qa-fuel-0", "At Shipper", A + 100 * MIN, "  driver QA", "manual")]),
			at([R("qa-fuel-2", "At Shipper", A + MIN, "dispatch_qa", "override")], { sheetLoadIds: ["QA-FUEL-2"] }),
			at([R("qa-fuel-2", "At Shipper", A + MIN, "dispatch_qa", "override")]),
			at([R("qa-fuel-3", "At Shipper", A + MIN, "Driver Other")]),
			at([R("qa-fuel-0", "Loading", A + MIN), R("qa-fuel-0", "Heading to Shipper", A - MIN)]),
			at([R("qa-fuel-1", "At Shipper", A + MIN)]),
			at([R("qa-fuel-0", "At Shipper", A + 121 * MIN)]),
			at([R("qa-fuel-0", "At Shipper", A + MIN)], { nowMs: A }),
			at([R("qa-fuel-0", "At Shipper", A + 5 * MIN)], { fixes: [{ ms: A + 3 * MIN, latitude: FIX.lat, longitude: FIX.lng }] }),
			at([R("qa-fuel-0", "At Shipper", A + 5 * MIN)], { fixes: [{ ms: A + 3 * MIN, ...north(3) }, { ms: A + 9 * MIN, latitude: FIX.lat, longitude: FIX.lng }] }),
			at([]),
		], [true, true, true, true, false, false, false, false, false, false, false, true, false]);
	});
	check("tripPlanPickup: a status that isn't picked up never is; with no ELD device the status stands; otherwise the arrival decides, and 'unconfirmed' says the status ran ahead", () => {
		const t = (o) => lib().tripPlanPickup(o);
		assert.deepStrictEqual([
			t({ statusPickedUp: false, vehicleId: "" }),
			t({ statusPickedUp: false, vehicleId: "DEV-QA-901" }),
			t({ statusPickedUp: true, vehicleId: "" }),
			t({ statusPickedUp: true, vehicleId: "  " }),
			t({ statusPickedUp: true, vehicleId: null }),
			t({ statusPickedUp: true, vehicleId: "DEV-QA-901", db: null }),
		], [
			{ pickedUp: false, unconfirmed: false },
			{ pickedUp: false, unconfirmed: false },
			{ pickedUp: true, unconfirmed: false },
			{ pickedUp: true, unconfirmed: false },
			{ pickedUp: true, unconfirmed: false },
			{ pickedUp: false, unconfirmed: true },
		]);
		assert.strictEqual(lib().FIX_READ_CAP_MS, 14 * 24 * 60 * MIN);
	});

	// Through the route, flag off, as the driver and as the dispatch card ask it.
	const BURN55 = { ...BURN5, p10: 5.5 };
	const SHORT = { status: "In Transit", fixAt: FIX_SHORT, fuel: 60, burn: BURN55 };
	const NEAR_PICKUP = { lat: PICKUP.lat + 0.01, lng: PICKUP.lng };
	const visit = (agoMin, speed = 1) => [{ at: NEAR_PICKUP, agoMin: agoMin + 1, speed }, { at: PICKUP, agoMin, speed: 0 }];
	// The geofence's arrival while another load was under way (recorder on), and the truck slow in the zone through and after it.
	const HAULING_ARRIVAL = { status: "At Shipper", source: "geofence", agoMin: 20 * 60, role: "system", zone: "inside", hauling: 1, fixAgoMin: 20 * 60 + 1 };
	const LINGER = [...visit(20 * 60 + 1), ...[5, 10, 15, 20].map((m) => ({ at: PICKUP, agoMin: 20 * 60 - m, speed: 0 }))];
	// The driver's other load, In Transit from 40 h ago until delivered 10 h ago, so under way through the 30 h arrival.
	const OTHER_IN_TRANSIT_THEN_DELIVERED = [{ status: "Dispatched", source: "dispatch", agoMin: 60 * 60, actor: "dispatch_qa" },
		{ status: "In Transit", source: "manual", agoMin: 40 * 60 }, { status: "Delivered", source: "manual", agoMin: 10 * 60 }];
	// Twins: the truck at the shipper around this load's 30 h geofence arrival, 3 mi off at another dock, then gone.
	const TWIN_DOCK = { lat: PICKUP.lat + 3 / 69.05, lng: PICKUP.lng };
	const TWIN_TRACK = [{ at: NEAR_PICKUP, agoMin: 30 * 60 + 5, speed: 1 }, { at: PICKUP, agoMin: 30 * 60, speed: 0 }, { at: PICKUP, agoMin: 30 * 60 - 5, speed: 0 },
		{ at: TWIN_DOCK, agoMin: 30 * 60 - 13, speed: 1 }, { at: TWIN_DOCK, agoMin: 30 * 60 - 17, speed: 0 }, { at: FIX, agoMin: 25 * 60, speed: 20 }];
	// The other load's rows: dispatched, then the geofence's "At Shipper" `agoMin` ago, under his name unless `actor` says otherwise.
	const twinRows = (agoMin, actor = "Driver QA") => [{ status: "Dispatched", source: "dispatch", agoMin: 50 * 60, actor: "dispatch_qa" },
		{ status: "At Shipper", source: "geofence", agoMin, actor, role: "system" }];
	const pick = (b) => [b.verdict, b.canMakeIt, b.shortfallMiles, b.refuelWithinMiles, b.routeMiles, b.leg, b.approachMiles, b.fromLivePosition];
	const KEEPS = ["tight", false, 40, 315, 355, "to_pickup", 75, true];
	const DROPS = ["clears", true, 0, 315, 160, "to_delivery", 0, true];
	const CASES = [
		["A1 In Transit, no arrival in the run: the run to the shipper stays (75 + 280 = 355 + 15 needed against 330): tight, not 'clears'",
			{ ...SHORT, history: [DISPATCHED] }, KEEPS],
		["A2 ...with a geofence 'At Shipper' in the run: dropped, as today", { ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL] }, DROPS],
		["A3 ...with the truck's own fixes at the shipper (inside, slowing, two in a row) in the run: dropped", { ...SHORT, history: [DISPATCHED], track: visit(20 * 60) }, DROPS],
		["A4 ...with a driver's 'At Shipper' carrying the recorder's ELD fix inside the pickup zone: dropped",
			{ ...SHORT, history: [DISPATCHED, { status: "At Shipper", source: "manual", agoMin: 20 * 60, role: "Driver", zone: "inside", fixAgoMin: 20 * 60 + 2 }] }, DROPS],
		["A5 ...with a driver's 'At Shipper' tap and no position: the run stays",
			{ ...SHORT, history: [DISPATCHED, { status: "At Shipper", source: "manual", agoMin: 20 * 60, role: "Driver", zone: "" }] }, KEEPS],
		["A6 ...with a driver's 'At Shipper' tap 40 km out: the run stays",
			{ ...SHORT, history: [DISPATCHED, { status: "At Shipper", source: "manual", agoMin: 20 * 60, role: "Driver", zone: "outside", fixAgoMin: 20 * 60 + 1 }] }, KEEPS],
		["A7 ...with only a geofence arrival made while another load was under way, the truck lingering in the zone after it: the run stays",
			{ ...SHORT, history: [DISPATCHED, HAULING_ARRIVAL], track: LINGER }, KEEPS],
		["A7b ...and, once it had left the zone, the truck's own arrival there: dropped",
			{ ...SHORT, history: [DISPATCHED, HAULING_ARRIVAL], track: [...LINGER, { at: FIX, agoMin: 15 * 60, speed: 20 }, ...visit(10 * 60)] }, DROPS],
		["A8 ...with a geofence arrival before the load was dispatched again: the run stays",
			{ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL, { status: "Dispatched", source: "dispatch", agoMin: 10 * 60 }] }, KEEPS],
		["A9 ...with a geofence arrival before the load was cancelled (then accepted and marked In Transit): the run stays",
			{ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL, { status: "Cancelled", source: "cancel", agoMin: 25 * 60 },
				{ status: "Assigned", source: "accept", agoMin: 24 * 60 }, { status: "In Transit", source: "manual", agoMin: 23 * 60 }] }, KEEPS],
		["A10 ...with fixes through the pickup zone at highway speed: the run stays", { ...SHORT, history: [DISPATCHED], track: visit(20 * 60, 25).map((t) => ({ ...t, speed: 25 })) }, KEEPS],
		["A11 ...with one fix inside the pickup zone between two outside it: the run stays",
			{ ...SHORT, history: [DISPATCHED], track: [{ at: FIX, agoMin: 20 * 60 + 1, speed: 20 }, { at: PICKUP, agoMin: 20 * 60, speed: 1 }, { at: FIX, agoMin: 20 * 60 - 1, speed: 20 }] }, KEEPS],
		["A12 ...with the truck at the shipper only before the load was dispatched: the run stays", { ...SHORT, history: [DISPATCHED], track: visit(50 * 60) }, KEEPS],
		["A13 ...with the fixes at the shipper taken before the ELD device was linked to this truck: the run stays",
			{ ...SHORT, history: [DISPATCHED], track: visit(20 * 60), linkedAgoMin: 10 * 60 }, KEEPS],
		["A14 the status still comes first: Heading to Shipper after a geofence arrival in the run plans the run to the shipper, as today",
			{ ...SHORT, status: "Heading to Shipper", history: [DISPATCHED, GEOFENCE_ARRIVAL] }, KEEPS],
		["A15 the status history can't be read: answered, with the run to the shipper kept", { ...SHORT, noHistoryTable: true }, KEEPS],
		// Fix round 1, High 1: a move back after an arrival undoes it (plan A's undo rule, lib/arrival-pickup.js isCut()).
		["B1 a geofence arrival, then a dispatcher sets Heading to Shipper, then an early In Transit: the run stays",
			{ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL, { status: "Heading to Shipper", source: "manual", agoMin: 25 * 60, actor: "Driver QA" },
				{ status: "In Transit", source: "manual", agoMin: 20 * 60 }] }, KEEPS],
		["B2 ...the move back an Accept from a staff session (recorder off): the run stays",
			{ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL, { status: "Assigned", source: "accept", agoMin: 25 * 60 }, { status: "In Transit", source: "manual", agoMin: 20 * 60 }] }, KEEPS],
		["B3 ...the move back made in the sheet, seen only as the next row's old status: the run stays",
			{ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL, { status: "In Transit", source: "manual", agoMin: 20 * 60, old: "Assigned" }] }, KEEPS],
		["B4 ...the truck's fixes at the shipper before the move back don't count after it either",
			{ ...SHORT, history: [DISPATCHED, { status: "In Transit", source: "manual", agoMin: 40 * 60 }, { status: "Heading to Shipper", source: "manual", agoMin: 25 * 60 },
				{ status: "In Transit", source: "manual", agoMin: 20 * 60 }], track: visit(30 * 60) }, KEEPS],
		["B5 control: the driver's own stale Accept after the arrival (recorder on) doesn't undo it, as plan A's rule says",
			{ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL, { status: "Assigned", source: "accept", agoMin: 25 * 60, role: "Driver" }, { status: "In Transit", source: "manual", agoMin: 20 * 60, role: "Driver" }] }, DROPS],
		["B6 a load dispatched again with no arrival between, the truck at the shipper only before the second dispatch: the run stays",
			{ ...SHORT, history: [DISPATCHED, { status: "Dispatched", source: "dispatch", agoMin: 20 * 60, actor: "dispatch_qa" }], track: visit(30 * 60) }, KEEPS],
		// Fix round 1, High 2 (b): a reassign writes no row, so an arrival counts only when its driver is the load's driver now.
		["C1 a geofence arrival by the driver the load had before a reassign: the run stays",
			{ ...SHORT, history: [DISPATCHED, { ...GEOFENCE_ARRIVAL, actor: "Driver Prior" }] }, KEEPS],
		["C2 ...a recorded fix inside the zone by that earlier driver: the run stays",
			{ ...SHORT, history: [DISPATCHED, { status: "At Shipper", source: "manual", agoMin: 20 * 60, actor: "Driver Prior", role: "Driver", zone: "inside", fixAgoMin: 20 * 60 + 2 }] }, KEEPS],
		["C3 control: the same driver spelled with other case and spacing: dropped", { ...SHORT, history: [DISPATCHED, { ...GEOFENCE_ARRIVAL, actor: "  driver   QA " }] }, DROPS],
		// Fix round 1, High 2 (a): an arrival made while another of the driver's loads was under way, rebuilt from the
		// status history with the recorder off.
		["D1 a geofence arrival while the driver's other load was In Transit (delivered since): the run stays",
			{ ...SHORT, otherLoad: "Delivered", history: [DISPATCHED, GEOFENCE_ARRIVAL], otherHistory: OTHER_IN_TRANSIT_THEN_DELIVERED }, KEEPS],
		["D2 ...the other load no longer his on the sheet, known from his own rows on it: the run stays",
			{ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL], otherHistory: OTHER_IN_TRANSIT_THEN_DELIVERED }, KEEPS],
		["D3 ...the other load his on the sheet, its statuses set by staff: the run stays",
			{ ...SHORT, otherLoad: "Delivered", history: [DISPATCHED, GEOFENCE_ARRIVAL], otherHistory: OTHER_IN_TRANSIT_THEN_DELIVERED.map((h) => ({ ...h, source: "override", actor: "dispatch_qa" })) }, KEEPS],
		["D4 ...found by the truck's own fixes, with no geofence row: the run stays",
			{ ...SHORT, otherLoad: "Delivered", history: [DISPATCHED], track: visit(30 * 60), otherHistory: OTHER_IN_TRANSIT_THEN_DELIVERED }, KEEPS],
		["D5 ...and the truck's own arrival there after the other load was delivered: dropped",
			{ ...SHORT, otherLoad: "Delivered", history: [DISPATCHED], track: [...visit(30 * 60), { at: FIX, agoMin: 20 * 60, speed: 20 }, ...visit(8 * 60)], otherHistory: OTHER_IN_TRANSIT_THEN_DELIVERED }, DROPS],
		["D6 control: the other load was At Receiver at the arrival (as the recorder judges it, not under way): dropped",
			{ ...SHORT, otherLoad: "Delivered", history: [DISPATCHED, GEOFENCE_ARRIVAL], otherHistory: [
				{ status: "Dispatched", source: "dispatch", agoMin: 60 * 60, actor: "dispatch_qa" }, { status: "In Transit", source: "manual", agoMin: 50 * 60 },
				{ status: "At Receiver", source: "geofence", agoMin: 35 * 60 }, { status: "Delivered", source: "manual", agoMin: 28 * 60 }] }, DROPS],
		["D7 ...the other load his on the sheet under another spelling of his name, its statuses set by staff: the run stays",
			{ ...SHORT, otherLoad: "Delivered", otherDriver: "  driver   QA ", history: [DISPATCHED, GEOFENCE_ARRIVAL],
				otherHistory: OTHER_IN_TRANSIT_THEN_DELIVERED.map((h) => ({ ...h, source: "override", actor: "dispatch_qa" })) }, KEEPS],
		// The twin hold (decision 3a): an arrival with another of his loads' "At Shipper" in the same visit is held.
		["F4 a twin advanced at the same visit, its row a minute before this load's: the run stays",
			{ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL], track: TWIN_TRACK, otherHistory: twinRows(30 * 60 + 1) }, KEEPS],
		["F4c ...its row a minute after this load's (the later-trip load written first; the truck hauls the twin and heads back): the run stays",
			{ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL], track: TWIN_TRACK, otherHistory: twinRows(30 * 60 - 1) }, KEEPS],
		["F4c' ...the twin's own point 3 mi from this one's, its row written at that dock: the run stays",
			{ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL], track: TWIN_TRACK, otherHistory: twinRows(30 * 60 - 15),
				otherCoords: [TWIN_DOCK, { lat: DROP.lat, lng: DROP.lng }] }, KEEPS],
		["F4f ...this load's arrival seen only by the truck's own fixes, the twin's row after it: the run stays",
			{ ...SHORT, history: [DISPATCHED], track: TWIN_TRACK, otherHistory: twinRows(30 * 60 - 10) }, KEEPS],
		["F4g ...the twin's row 3 h before this load was dispatched, the truck at the shipper throughout: the run stays",
			{ ...SHORT, history: [{ status: "Dispatched", source: "dispatch", agoMin: 30 * 60 - 10, actor: "dispatch_qa" }, { ...GEOFENCE_ARRIVAL, agoMin: 30 * 60 - 15 }],
				track: [33, 32, 31, 30.5].map((h) => ({ at: PICKUP, agoMin: h * 60, speed: 0 })).concat([{ at: PICKUP, agoMin: 30 * 60 - 16, speed: 0 }, { at: FIX, agoMin: 25 * 60, speed: 20 }]),
				otherHistory: [...twinRows(33 * 60 - 10), { status: "At Receiver", source: "manual", agoMin: 30 * 60 - 12 }] }, KEEPS],
		["F4x control: the other load's 'At Shipper' written after the truck left the shipper's 25 mi: dropped",
			{ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL], track: TWIN_TRACK, otherHistory: twinRows(24 * 60) }, DROPS],
		["F4y control: another driver's load with an 'At Shipper' row in the visit: dropped",
			{ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL], track: TWIN_TRACK, otherHistory: twinRows(30 * 60 - 1, "Driver Other") }, DROPS],
		// The truck's fixes are read at most 14 days back (#713 review-1 Low 1).
		["F12 a run 16 days long, the truck at the shipper 13 days ago: dropped",
			{ ...SHORT, history: [{ ...DISPATCHED, agoMin: 16 * 24 * 60 }], track: visit(13 * 24 * 60) }, DROPS],
		["F12b ...the truck at the shipper only 15 days ago: the run stays",
			{ ...SHORT, history: [{ ...DISPATCHED, agoMin: 16 * 24 * 60 }], track: visit(15 * 24 * 60) }, KEEPS],
	];
	const asked = [];
	for (const [label, o, want] of CASES) {
		const w = buildWorld(Database, lifted, appRequire, o, false);
		asked.push({ label, want, driver: await w.plan(), card: await w.plan(DISPATCH) });
	}
	for (const { label, want, driver, card } of asked) {
		check(label, () => {
			assert.deepStrictEqual([driver.status, card.status], [200, 200]);
			assert.deepStrictEqual(pick(driver.body), want, "the driver's answer");
			assert.deepStrictEqual(pick(card.body), want, "the dispatch card's answer");
		});
	}
	{
		const w = buildWorld(Database, lifted, appRequire, { ...SHORT, sheetDriver: "", history: [DISPATCHED, GEOFENCE_ARRIVAL], track: visit(20 * 60) }, false);
		const driver = await w.plan();
		check("E1 the load's Driver cell is blank: no driver to tie an arrival to, so the driver's own plan keeps the run, even with his truck's fixes at the shipper", () => {
			assert.deepStrictEqual([driver.status, pick(driver.body)], [200, KEEPS]);
		});
	}
	// Form 0: a truck with no ELD device has no fuel reading, so no verdict can pass; its
	// status stands, as before. Asked with the Dispatched row alone and with a geofence
	// arrival too, which every rule counts: the answers are equal, flag off and on.
	for (const [label, o] of [["F0 a device-less truck", { status: "In Transit", device: false }], ["F0b no truck on the driver", { status: "In Transit", truck: false }]]) {
		const answers = [];
		for (const flagOn of [false, true]) {
			for (const history of [[DISPATCHED], [DISPATCHED, GEOFENCE_ARRIVAL]]) {
				const w = buildWorld(Database, lifted, appRequire, { ...o, history }, flagOn);
				answers.push({ flagOn, driver: await w.plan(), card: await w.plan(DISPATCH) });
			}
		}
		check(`${label}, In Transit with no arrival in the run: the status stands, flag off and on (the whole-load row keeps its figures), and no line says the pickup isn't confirmed`, () => {
			for (const k of [0, 2]) {
				for (const who of ["driver", "card"]) {
					assert.strictEqual(answers[k][who].status, 200, who);
					assert.deepStrictEqual(answers[k][who].body, answers[k + 1][who].body, `${who}, flag ${answers[k].flagOn ? "on" : "off"}`);
					assert.ok(!("pickupUnconfirmed" in answers[k][who].body), who);
					assert.strictEqual(answers[k][who].body.leg, "to_delivery", who);
				}
			}
			const df = answers[2].driver.body.driverFuel;
			assert.ok(df, "the flag-on block");
			assert.strictEqual(df.approachUncounted, false);
		});
	}
	{
		// Decision 5 (a): no "past the shipper" form, so a twin's hold lasts to the receiver.
		const w = buildWorld(Database, lifted, appRequire, { ...SHORT, fixAt: DROP, history: [DISPATCHED, GEOFENCE_ARRIVAL], track: TWIN_TRACK,
			otherHistory: twinRows(30 * 60 + 1), otherCoords: [PICKUP, { lat: DROP.lat - 1, lng: DROP.lng + 1 }] }, false);
		const driver = await w.plan();
		const card = await w.plan(DISPATCH);
		check("F4d twins with different receivers, asked for the twin written second, the truck now at its own receiver: the run to the shipper stays", () => {
			for (const b of [driver.body, card.body]) {
				assert.strictEqual(b.leg, "to_pickup");
				assert.ok(b.approachMiles > 0, String(b.approachMiles));
			}
		});
	}
	{
		// Form 0 is the device alone: a truck with a device and no mapped pickup still needs its arrival.
		const w = buildWorld(Database, lifted, appRequire, { ...SHORT, pickupMapped: false, history: [DISPATCHED] }, false);
		const answers = [(await w.plan()).body, (await w.plan(DISPATCH)).body];
		check("A16 In Transit with no arrival, a truck with a device and no mapped pickup: nothing to route to the shipper, so the pass is held at 'tight', never 'clears'", () => {
			for (const b of answers) assert.deepStrictEqual([b.verdict, b.leg, b.approachMiles], ["tight", "to_delivery", 0]);
		});
	}
	{
		// On a 20-mi lane the visit's radius is half the lane, 10 mi: the receiver stays outside it.
		const lane20 = { lat: PICKUP.lat + 20 / 69.05, lng: PICKUP.lng };
		const south12 = { lat: PICKUP.lat - 12 / 69.05, lng: PICKUP.lng };
		const track = [{ at: NEAR_PICKUP, agoMin: 30 * 60 + 5, speed: 1 }, { at: PICKUP, agoMin: 30 * 60, speed: 0 }, { at: PICKUP, agoMin: 30 * 60 - 5, speed: 0 },
			{ at: south12, agoMin: 30 * 60 - 15, speed: 1 }, { at: south12, agoMin: 30 * 60 - 17, speed: 0 }, { at: FIX, agoMin: 25 * 60, speed: 20 }];
		const legs = [];
		for (const twinAgo of [30 * 60 - 16, 30 * 60 - 4]) {
			const w = buildWorld(Database, lifted, appRequire, { ...SHORT, drop: lane20, history: [DISPATCHED, GEOFENCE_ARRIVAL], track, otherHistory: twinRows(twinAgo) }, false);
			legs.push([(await w.plan()).body.leg, (await w.plan(DISPATCH)).body.leg]);
		}
		check("F4h a 20-mi lane: a twin's row written 12 mi out (past half the lane) is another visit, so this arrival counts; one written at the shipper holds it", () => {
			assert.deepStrictEqual(legs, [["to_delivery", "to_delivery"], ["to_pickup", "to_pickup"]]);
		});
	}
	{
		// The driver's panel line: the status says picked up, the arrival isn't seen, and the plan counts the run there.
		const flagOf = async (o) => {
			const w = buildWorld(Database, lifted, appRequire, o, false);
			return [(await w.plan()).body.pickupUnconfirmed, (await w.plan(DISPATCH)).body.pickupUnconfirmed];
		};
		const got = [
			await flagOf({ ...SHORT, history: [DISPATCHED] }),
			await flagOf({ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL] }),
			await flagOf({ ...SHORT, status: "Assigned", history: [DISPATCHED] }),
			await flagOf({ ...SHORT, history: [DISPATCHED], fixAgoMin: 7 * 60 }),
			await flagOf({ ...SHORT, history: [DISPATCHED, GEOFENCE_ARRIVAL], track: TWIN_TRACK, otherHistory: twinRows(30 * 60 - 1) }),
			await flagOf({ ...SHORT, noHistoryTable: true }),
		];
		check("pickupUnconfirmed: only when the status says picked up, the arrival isn't seen (none, a twin, an unreadable history) and the plan includes the run to the shipper; never on a seen arrival, a status before pickup or a plan from the pickup (no fresh fix)", () => {
			assert.deepStrictEqual(got, [[true, true], [undefined, undefined], [undefined, undefined], [undefined, undefined], [true, true], [true, true]]);
		});
	}
	{
		const on = await buildWorld(Database, lifted, appRequire, { ...SHORT, history: [DISPATCHED] }, true).plan();
		check("A1 flag on: the block plans the run to the shipper too (75 mi, then 355 to the receiver), and no row says 'enough' for the whole run", () => {
			const df = on.body && on.body.driverFuel;
			assert.ok(df, JSON.stringify(on.body));
			assert.deepStrictEqual(df.legs.map((l) => [l.key, l.miles, l.status]), [["pickup", 75, "enough"], ["finish", 355, "add"]]);
		});
	}
	let review = null;
	try { review = await import(pathToFileURL(path.join(__dirname, "..", "client", "src", "lib", "fuelReview.js")).href); } catch (e) { review = null; }
	check("A1 the dispatch card reads 'Tight — plan a stop' (it read 'Route clears' when the plan skipped the shipper)", () => {
		assert.ok(review, "client/src/lib/fuelReview.js did not load");
		const a1 = asked[0];
		assert.strictEqual(review.tripVerdict(a1.card.body.verdict).dispatch, "Tight — plan a stop");
	});
	const PICKUP_LINE = "Pickup not confirmed yet, so this plan includes the run to the shipper.";
	check("the driver's panel line has one home (client/src/lib/fuelReview.js), word for word, shown only on the server's flag", () => {
		assert.ok(review, "client/src/lib/fuelReview.js did not load");
		assert.strictEqual(review.PICKUP_UNCONFIRMED_LINE, PICKUP_LINE);
		assert.deepStrictEqual([
			review.pickupUnconfirmedLine(asked[0].driver.body),
			review.pickupUnconfirmedLine(asked[1].driver.body),
			review.pickupUnconfirmedLine({ pickupUnconfirmed: "true" }),
			review.pickupUnconfirmedLine({}),
			review.pickupUnconfirmedLine(null),
		], [PICKUP_LINE, "", "", "", ""]);
	});
	check("the driver's fuel panel shows that line on both screens, from the lib, with no copy of its words", () => {
		const vue = fs.readFileSync(path.join(__dirname, "..", "client", "src", "components", "driver", "DriverFuelPanel.vue"), "utf8");
		assert.ok(vue.includes("const pickupLine = computed(() => pickupUnconfirmedLine(plan.value))"), "the computed line");
		assert.strictEqual(vue.split("{{ pickupLine }}</p>").length - 1, 2, "rendered on the gallons screen and in the verdict card");
		assert.ok(!vue.includes("Pickup not confirmed"), "no copy of the words in the component");
	});
}

routeSections().catch((e) => { failed++; console.error(`FAIL  §9 crashed\n      ${e.stack}`); }).then(() => {
	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
});
