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

"use strict";
const assert = require("assert");
const crypto = require("crypto");
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
const TOP_KEYS = ["afterAnotherLoad", "extraStops", "fuelReadAgeMinutes", "fuelState", "legs", "loadDone", "milesLeft",
	"position", "positionAgeMinutes", "refuelNow", "routeEstimated", "v"];
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
		assert.deepStrictEqual(statuses(o), [["pickup", "check_gauge"], ["finish", "add"]], JSON.stringify(o));
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
const pairKey = (a, b) => `${a.latitude},${a.longitude}>${b.latitude},${b.longitude}`;
const ROAD_MILES = new Map([
	[`${FIX.lat},${FIX.lng}>${PICKUP.lat},${PICKUP.lng}`, 140],
	[`${PICKUP.lat},${PICKUP.lng}>${DROP.lat},${DROP.lng}`, 280],
	[`${FIX.lat},${FIX.lng}>${DROP.lat},${DROP.lng}`, 300],
]);
const PROVIDED = ["app", "db", "requireRole", "fuelPlanLimiter", "getJobTrackingCached", "loadBelongsToDriver",
	"burnRateForVehicle", "receiptMpgForVehicle", "getRoute", "geolib"];
const DRIVER = { id: 7, role: "Driver", driverName: "Driver QA", username: "driver_qa" };
const DISPATCH = { id: 2, role: "Dispatcher", username: "dispatch_qa" };

function buildWorld(Database, lifted, appRequire, o = {}, flagOn = false) {
	const opt = { status: "Assigned", fuel: 48, fixAgoMin: 12, coords: true, pickupMapped: true, truck: true, tank: 150, avgMpg: 6.0,
		burn: BURN5, receipt: { mpg: 6.0 }, rollupMpg: null, details: "Dry van, 43,764 lbs", otherLoad: null, stopPayload: null,
		anchor: null, routesDown: false, ...o };
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, routemate_vehicle_id TEXT DEFAULT '', assigned_driver TEXT DEFAULT '',
			fuel_tank_gallons REAL DEFAULT 0, avg_mpg REAL DEFAULT 0);
		CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT DEFAULT '', end_date TEXT DEFAULT '');
		CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT NOT NULL, latitude REAL, longitude REAL,
			odometer REAL DEFAULT 0, fuel_pct INTEGER, location_date_ms INTEGER DEFAULT 0, dropped_reason TEXT DEFAULT '');
		CREATE TABLE routemate_fuel_daily (routemate_vehicle_id TEXT, date TEXT, mpg REAL, miles REAL, derivation_notes TEXT DEFAULT '');
		CREATE TABLE load_coordinates (load_id TEXT PRIMARY KEY, origin_lat REAL, origin_lng REAL, dest_lat REAL, dest_lng REAL);
		CREATE TABLE eld_device_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, routemate_vehicle_id TEXT,
			assigned_from TEXT, assigned_until TEXT DEFAULT '', assigned_by TEXT DEFAULT '');
		CREATE TABLE deleted_loads (load_id TEXT PRIMARY KEY);
		CREATE TABLE load_driver_instructions (load_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
		CREATE TABLE load_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT, driver_name TEXT, response TEXT, responded_at TEXT);
		CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, type TEXT, metadata TEXT, created_at TEXT);
	`);
	// The driver's accept times, which order his queue (computeDriverQueues()).
	for (const [loadId, at] of opt.accepts || []) {
		db.prepare("INSERT INTO load_responses (load_id, driver_name, response, responded_at) VALUES (?, 'Driver QA', 'accepted', ?)").run(loadId, at);
	}
	const VID = "DEV-QA-901";
	if (opt.truck) {
		db.prepare("INSERT INTO trucks (id, unit_number, routemate_vehicle_id, assigned_driver, fuel_tank_gallons, avg_mpg) VALUES (1, 'Unit 901', ?, 'Driver QA', ?, ?)")
			.run(VID, opt.tank, opt.avgMpg);
		db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (1, 'Driver QA', '2026-10-01', '')").run();
		const tel = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, odometer, fuel_pct, location_date_ms) VALUES (?, ?, ?, ?, ?, ?)");
		if (opt.anchor) tel.run(VID, FIX.lat, FIX.lng, opt.anchor.odo, opt.anchor.fuel, NOW - opt.anchor.agoMin * 60000);
		tel.run(VID, FIX.lat, FIX.lng, 100000, opt.fuel, NOW - opt.fixAgoMin * 60000);
		if (opt.rollupMpg) for (const d of ["2026-10-27", "2026-10-28", "2026-10-29"]) {
			db.prepare("INSERT INTO routemate_fuel_daily VALUES (?, ?, ?, 300, '')").run(VID, d, opt.rollupMpg);
		}
	}
	if (opt.coords) {
		db.prepare("INSERT INTO load_coordinates VALUES ('qa-fuel-1', ?, ?, ?, ?)")
			.run(opt.pickupMapped ? PICKUP.lat : null, opt.pickupMapped ? PICKUP.lng : null, DROP.lat, DROP.lng);
	}
	if (opt.stopPayload) db.prepare("INSERT INTO load_driver_instructions VALUES ('qa-fuel-1', ?)").run(JSON.stringify(opt.stopPayload));
	const headers = ["Load ID", "Status", "Driver", "Details"];
	const data = [{ "Load ID": "QA-FUEL-1", Status: opt.status, Driver: "Driver QA", Details: opt.details }];
	if (opt.otherLoad) data.push({ "Load ID": "QA-FUEL-0", Status: opt.otherLoad, Driver: "Driver QA", Details: "" });
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
];
const DIGEST_WORLDS = 20;
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
	console.log(`      flag-off answers, all ${WORLDS.length} worlds: ${off.length}, sha256 ${digestOf(off)}`);
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
	check("pre-pickup with the pickup not geocoded: the route plans truck to delivery (verdict clears), the block never says 'enough'", () => {
		const b = at(on, "pre-pickup, pickup not geocoded, 70% / trip-plan, Driver").body;
		assert.deepStrictEqual([b.verdict, b.leg, b.laneMiles, b.driverFuel.legs.map((l) => [l.key, l.status])],
			["clears", "to_delivery", 300, [["finish", "check_gauge"]]]);
	});
	check("in transit after a 4 h dropout from 100%: the level is carried at the planning rate (40%, 185 left), finish 300 mi is add 40, not 'enough'", () => {
		const b = at(on, "in transit after a 4 h dropout from 100% (300 mi since) / trip-plan, Driver").body;
		assert.deepStrictEqual([b.verdict, b.fuelSource, b.driverFuel.fuelState, b.driverFuel.milesLeft, b.driverFuel.legs.map((l) => [l.key, l.status, l.addGallons])],
			["clears", "carried", "estimated", 185, [["finish", "add", 40]]]);
	});
	check("a Driver's answers carry no vehicle id, and the block only its listed keys (all 42 Driver answers that succeed)", () => {
		const driverAnswers = on.filter((y) => y.name.endsWith("Driver") && y.r.status === 200);
		assert.strictEqual(driverAnswers.length, 42);
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
			["stale", null, 780, "none", [["whole_load", 280, "check_gauge"]]]);
	});
	check("sensor dropout: the carried reading gives numbers, marked 'estimated'", () => {
		const df = at(on, "sensor dropout (carried) / trip-plan, Driver").body.driverFuel;
		assert.ok(df.fuelState === "estimated" && Number.isFinite(df.milesLeft), JSON.stringify(df));
	});
	check("no tank size and no fill history: no miles, 'no_tank_size', rows say what the tank needs", () => {
		const df = at(on, "no tank size, no fill history / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([df.fuelState, df.milesLeft, df.legs.every((l) => l.status === "check_gauge" && l.needInTankGallons > 0)], ["no_tank_size", null, true]);
	});
	check("no truck linked: 'no_truck', one whole-load row", () => {
		const df = at(on, "no truck linked / trip-plan, Driver").body.driverFuel;
		assert.deepStrictEqual([df.fuelState, df.milesLeft, df.legs.map((l) => [l.key, l.status])], ["no_truck", null, [["whole_load", "check_gauge"]]]);
		assert.strictEqual(at(on, "no truck linked / range, Driver").body.driverFuel.fuelState, "no_truck");
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
}

routeSections().catch((e) => { failed++; console.error(`FAIL  §9 crashed\n      ${e.stack}`); }).then(() => {
	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
});
