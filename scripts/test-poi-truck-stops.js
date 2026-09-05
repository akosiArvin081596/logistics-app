#!/usr/bin/env node
// scripts/test-poi-truck-stops.js — a driver must never be sent to fuel
// somewhere a Class 8 cannot enter.
//
// Locks the 2026-09-05 owner report: the panel was offering "Prenger Foods" (a
// grocery store with a pump) as CHEAPEST and a column of Casey's, with no Pilot,
// Love's or TA anywhere. Two causes, both here:
//   1. truck-capability was ADDITIVE (+2) and a live price was worth MORE (+3),
//      so a cheap convenience store outranked a real travel center and the
//      result cap then dropped the travel centers entirely;
//   2. Casey's was in the truck-brand list at all.
//
// No network: a fake fetch returns a fixed Places payload.

"use strict";
const assert = require("assert");
const poi = require("../lib/poi-fuel-stops");

let failed = 0;
const check = (name, fn) => {
	try { fn(); console.log(`ok    ${name}`); }
	catch (e) { failed++; console.error(`FAIL  ${name}\n      ${e.message}`); }
};

// --- unit: the capability predicate ---------------------------------------
check("truck_stop type is truck-capable", () => {
	assert.strictEqual(poi.isTruckCapable("truck_stop", "", null), true);
});
check("TRUCK_DIESEL pump is truck-capable even when typed gas_station", () => {
	// Google's truck_stop typing is incomplete; a truck-diesel lane is the
	// strongest positive signal we get.
	assert.strictEqual(poi.isTruckCapable("gas_station", "", "TRUCK_DIESEL"), true);
});
check("a travel-center brand is truck-capable", () => {
	assert.strictEqual(poi.isTruckCapable("gas_station", "Love's", null), true);
});
check("Casey's is NOT truck-capable", () => {
	assert.strictEqual(poi.isTruckCapable("gas_station", "Casey's", "DIESEL"), false);
});
check("Kwik Trip is NOT truck-capable", () => {
	assert.strictEqual(poi.isTruckCapable("gas_station", "Kwik Trip", "DIESEL"), false);
});
check("a plain unbranded gas station is NOT truck-capable", () => {
	assert.strictEqual(poi.isTruckCapable("gas_station", "", "DIESEL"), false);
});
check("Casey's is absent from TRUCK_STOP_BRANDS", () => {
	assert.ok(!poi.TRUCK_STOP_BRANDS.some((b) => b.brand === "Casey's"),
		"Casey's is a convenience store and must not sit in the truck-stop list");
});

// --- integration: the owner's exact scenario ------------------------------
const money = (v) => ({ currencyCode: "USD", units: String(Math.floor(v)), nanos: Math.round((v % 1) * 1e9) });
const place = (id, name, type, price, fuelType) => ({
	id, displayName: { text: name }, primaryType: type,
	formattedAddress: `${name} address`,
	location: { latitude: 35.1, longitude: -94.6 },
	fuelOptions: price == null ? undefined
		: { fuelPrices: [{ type: fuelType || "DIESEL", price: money(price), updateTime: "2026-09-01T00:00:00Z" }] },
});

// Cheap car stations, expensive real truck stops — the ordering that broke.
const PAYLOAD = { places: [
	place("p1", "Prenger Foods", "gas_station", 5.20),                       // grocery w/ pump
	place("p2", "Casey's General Store", "gas_station", 5.30),               // convenience
	place("p3", "Casey's", "gas_station", 5.30),
	place("p4", "Pilot Travel Center #442", "truck_stop", 5.89, "TRUCK_DIESEL"),
	place("p5", "Love's Travel Stop", "gas_station", 5.95, "TRUCK_DIESEL"),
	place("p6", "TA Travel Center", "truck_stop", null),                     // no live price
] };
const fakeFetch = async () => ({ ok: true, status: 200, json: async () => PAYLOAD });

const run = (limit) => poi.findFuelStopsAlongRoute({
	originLat: 35.0, originLng: -94.5, destLat: 35.4, destLng: -94.9,
	apiKey: "test-key", fetchImpl: fakeFetch, limit,
});

(async () => {
	const stops = await run(12);
	const names = stops.map((s) => s.name);

	check("no car-only station survives when truck stops exist", () => {
		const bad = names.filter((n) => /prenger|casey/i.test(n));
		assert.deepStrictEqual(bad, [],
			`car-only stations returned: ${bad.join(", ")} — got ${names.join(" | ")}`);
	});
	check("the real travel centers are returned", () => {
		for (const want of ["Pilot", "Love's", "TA"]) {
			assert.ok(names.some((n) => n.includes(want)), `${want} missing from ${names.join(" | ")}`);
		}
	});
	check("every returned stop is flagged truckFriendly", () => {
		assert.ok(stops.every((s) => s.truckFriendly === true), "a stop came back not truckFriendly");
	});
	check("an EXPENSIVE truck stop still outranks a CHEAP car station", () => {
		// The regression in one line: price must never promote a car station over
		// a travel center. Pilot at $5.89 beats Prenger at $5.20.
		assert.ok(/pilot|love|ta /i.test(names[0]), `first stop was ${names[0]}`);
	});

	// A tight cap is where the old bug actually bit: truck stops fell off the end.
	const capped = await run(2);
	check("under a tight cap the truck stops are what survive", () => {
		assert.strictEqual(capped.length, 2);
		assert.ok(capped.every((s) => s.truckFriendly),
			`cap dropped the truck stops: ${capped.map((s) => s.name).join(" | ")}`);
	});

	// Rural fallback: never hand back an empty panel.
	const ONLY_CARS = { places: [place("c1", "Prenger Foods", "gas_station", 5.2), place("c2", "Casey's", "gas_station", 5.3)] };
	const carStops = await poi.findFuelStopsAlongRoute({
		originLat: 35, originLng: -94.5, destLat: 35.4, destLng: -94.9,
		apiKey: "k", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ONLY_CARS }), limit: 5,
	});
	check("with NO truck stops on the lane it falls back, flagged false", () => {
		assert.ok(carStops.length > 0, "returned nothing — an empty panel is worse than a flagged one");
		assert.ok(carStops.every((s) => s.truckFriendly === false), "fallback stops must be flagged truckFriendly:false");
	});

	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
})();
