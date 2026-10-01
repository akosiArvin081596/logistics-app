#!/usr/bin/env node
/**
 * Tests for the ELD LINK PICKER helpers in lib/eld-feed-health.js:
 * deviceProvider(), isDeviceSilent(), comparePickerDevices() and
 * describeEldDevice().
 *
 * WHY THEY EXIST. LogisX-#356 was linked to Linxup device 18000507597 (blank
 * vehicle id, VIN and make in routemate_vehicles; last fix 2026-09-15) instead
 * of its live Routemate ELD, vehicle "356" (2022 INTERNATIONAL LT625). The
 * picker named neither the provider nor the last fix, and listed the dead
 * device first.
 *
 *   §1 deviceProvider    `source` wins; pre-column rows ('' source) fall back
 *                        to the Linxup fingerprint, both ways.
 *   §2 isDeviceSilent    the boundary (exactly staleHours is silent), the
 *                        defaults, and AGREEMENT with judgeTruckFeed's stale
 *                        rule over a grid, so the picker and the sweep can
 *                        never disagree about one device.
 *   §3 comparePicker...  the incident list sorts live-first from every input
 *                        order, and the comparator is a total order.
 *   §4 describeEld...    missing parts, one line, bounded, never throws.
 *
 * Pure: no server, no database, no clock (every instant is passed in).
 *
 * Run: node scripts/test-eld-device-status.js
 */
"use strict";

const path = require("path");

const lib = require(path.join(__dirname, "..", "lib", "eld-feed-health.js"));
const {
	HOUR_MS,
	DEFAULT_STALE_HOURS,
	deviceProvider,
	isDeviceSilent,
	comparePickerDevices,
	describeEldDevice,
	judgeTruckFeed,
} = lib;

// ------------------------------------------------------------------ harness
let passed = 0;
const failures = [];
function ok(name, cond, detail) {
	if (cond) { passed++; return; }
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name, actual, expected) {
	ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log(`\n── ${t}`); }

const NOW = Date.parse("2026-10-01T15:00:00Z");
const MIN_MS = 60 * 1000;

// ---------------------------------------------------------------- §0 exports
section("§0 exports");
for (const [name, arity] of [["deviceProvider", 1], ["isDeviceSilent", 3], ["comparePickerDevices", 2], ["describeEldDevice", 1]]) {
	eq(`§0 ${name} is exported`, typeof lib[name], "function");
	eq(`§0 ${name} takes ${arity} argument(s)`, lib[name].length, arity);
}

// ---------------------------------------------------------- §1 deviceProvider
section("§1 deviceProvider");
eq("§1.1 source 'linxup' → linxup", deviceProvider({ source: "linxup", engine_hours: 0, geocoded_location: "" }), "linxup");
eq("§1.2 source 'routemate' → routemate", deviceProvider({ source: "routemate", engine_hours: 15234.5, geocoded_location: "Laredo, TX" }), "routemate");
eq("§1.3 source is trimmed and case-insensitive (' LINXUP ')", deviceProvider({ source: " LINXUP ", engine_hours: 1, geocoded_location: "x" }), "linxup");
eq("§1.4 source is trimmed and case-insensitive ('Routemate')", deviceProvider({ source: "Routemate" }), "routemate");
eq("§1.5 source wins over a Linxup-looking fingerprint", deviceProvider({ source: "routemate", engine_hours: 0, geocoded_location: "" }), "routemate");
eq("§1.6 source wins over a Routemate-looking fingerprint", deviceProvider({ source: "linxup", engine_hours: 1234, geocoded_location: "Laredo, TX" }), "linxup");
eq("§1.7 pre-column row: 0 engine hours + no place → linxup", deviceProvider({ source: "", engine_hours: 0, geocoded_location: "" }), "linxup");
eq("§1.8 pre-column row: null engine hours + null place → linxup", deviceProvider({ source: "", engine_hours: null, geocoded_location: null }), "linxup");
eq("§1.9 pre-column row: whitespace-only place counts as empty → linxup", deviceProvider({ source: "", engine_hours: 0, geocoded_location: "   " }), "linxup");
eq("§1.10 pre-column row: null source reads as pre-column → linxup", deviceProvider({ source: null, engine_hours: 0, geocoded_location: "" }), "linxup");
eq("§1.11 pre-column row: engine hours + place → routemate", deviceProvider({ source: "", engine_hours: 15234.5, geocoded_location: "Laredo, TX" }), "routemate");
eq("§1.12 pre-column row: 0 engine hours but a place → routemate", deviceProvider({ source: "", engine_hours: 0, geocoded_location: "Laredo, TX" }), "routemate");
eq("§1.13 pre-column row: engine hours but no place → routemate", deviceProvider({ source: "", engine_hours: 12, geocoded_location: "" }), "routemate");
eq("§1.14 no row (null) → ''", deviceProvider(null), "");
eq("§1.15 no row (undefined) → ''", deviceProvider(undefined), "");
eq("§1.16 a source naming another provider is not guessed at → ''", deviceProvider({ source: "apollo", engine_hours: 0, geocoded_location: "" }), "");
{
	const allowed = new Set(["routemate", "linxup", ""]);
	const inputs = [null, undefined, 0, "", "linxup", [], {}, { source: 7 }, { engine_hours: "abc" }, { geocoded_location: {} }];
	ok("§1.17 every input answers one of 'routemate' | 'linxup' | ''", inputs.every((r) => allowed.has(deviceProvider(r))));
}

// ---------------------------------------------------------- §2 isDeviceSilent
section("§2 isDeviceSilent");
for (const [label, v] of [["undefined", undefined], ["null", null], ["0", 0], ["NaN", NaN], ["Infinity", Infinity], ["negative", -5], ["''", ""]]) {
	eq(`§2.1 no usable last fix (${label}) is silent`, isDeviceSilent(v, NOW, 24), true);
}
eq("§2.2 ⚠️ exactly staleHours old IS silent", isDeviceSilent(NOW - 24 * HOUR_MS, NOW, 24), true);
eq("§2.3 one millisecond younger than staleHours is live", isDeviceSilent(NOW - 24 * HOUR_MS + 1, NOW, 24), false);
eq("§2.4 a fresh fix is live", isDeviceSilent(NOW - 5 * MIN_MS, NOW, 24), false);
eq("§2.5 a custom staleHours sets the boundary (6 h → silent)", isDeviceSilent(NOW - 6 * HOUR_MS, NOW, 6), true);
eq("§2.6 a custom staleHours sets the boundary (5 h 59 m → live)", isDeviceSilent(NOW - 6 * HOUR_MS + MIN_MS, NOW, 6), false);
eq("§2.7 a fix ahead of the clock is live, not silent", isDeviceSilent(NOW + HOUR_MS, NOW, 24), false);
eq("§2.8 the dead #356 device (last fix 2026-09-15) is silent", isDeviceSilent(Date.parse("2026-09-15T12:00:00Z"), NOW, undefined), true);
for (const [label, v] of [["omitted", undefined], ["0", 0], ["negative", -1], ["NaN", NaN], ["text", "abc"]]) {
	const edge = NOW - DEFAULT_STALE_HOURS * HOUR_MS;
	ok(`§2.9 staleHours ${label} falls back to DEFAULT_STALE_HOURS`,
		isDeviceSilent(edge, NOW, v) === true && isDeviceSilent(edge + 1, NOW, v) === false);
}
{
	// The picker and the sweep must answer the same question the same way: an
	// Active, linked truck is stale/never-reported in judgeTruckFeed exactly when
	// its device is silent here.
	const offsets = [null, 0, -HOUR_MS, HOUR_MS, 6 * HOUR_MS - 1, 6 * HOUR_MS, 24 * HOUR_MS - 1, 24 * HOUR_MS, 24 * HOUR_MS + 1, 72 * HOUR_MS, 90 * 24 * HOUR_MS];
	const thresholds = [undefined, 6, 24, 72, 0, NaN];
	const mismatches = [];
	for (const off of offsets) {
		for (const staleHours of thresholds) {
			const lastFixMs = off === null ? null : NOW - off;
			const verdict = judgeTruckFeed(
				{ truckId: 1, unitNumber: "LogisX-#356", status: "Active", retiredAt: "", vehicleId: "_PxLRDo4PKkgRsvudsnJTw", lastFixMs, fixes24h: 5000 },
				{ nowMs: NOW, staleHours, todayKey: "2026-10-01" });
			const sweepSilent = verdict.state === "stale" || verdict.state === "never_reported";
			if (sweepSilent !== isDeviceSilent(lastFixMs, NOW, staleHours)) mismatches.push(`offset=${off} staleHours=${staleHours} state=${verdict.state}`);
		}
	}
	eq(`§2.10 ⚠️ agrees with judgeTruckFeed's stale rule on all ${offsets.length * thresholds.length} grid points`, mismatches.join("; "), "");
}

// ---------------------------------------------------- §3 comparePickerDevices
section("§3 comparePickerDevices");
function device(routemate_vehicle_id, vehicle_id, last_fix_ms) {
	return { routemate_vehicle_id, vehicle_id, last_fix_ms, silent: isDeviceSilent(last_fix_ms, NOW, DEFAULT_STALE_HOURS) };
}
const order = (list) => list.slice().sort(comparePickerDevices).map((d) => d.routemate_vehicle_id);
function permutations(list) {
	if (list.length <= 1) return [list];
	return list.flatMap((item, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest]));
}
{
	const LIVE_FIX = NOW - 5 * MIN_MS;
	const incident = [
		device("18000507597", "", Date.parse("2026-09-15T12:00:00Z")), // the dead Linxup device #356 was linked to
		device("_PxLRDo4PKkgRsvudsnJTw", "356", LIVE_FIX), //               #356's live Routemate ELD
		device("rm-33-handle", "33", LIVE_FIX), //                          #33, same fix instant
		device("x78f4qtVukzwiF6ur7D04A", "2372", null), //                  never reported
	];
	const expected = ["rm-33-handle", "_PxLRDo4PKkgRsvudsnJTw", "18000507597", "x78f4qtVukzwiF6ur7D04A"].join(",");
	eq("§3.1 the incident list: live 33, live 356, then the dead device, then the never-reported one", order(incident).join(","), expected);
	const perms = permutations(incident);
	const differing = perms.filter((p) => order(p).join(",") !== expected).length;
	eq(`§3.2 all ${perms.length} input orders sort to that same order`, differing, 0);
	ok("§3.3 the dead device never sorts ahead of a live one", order(incident).indexOf("18000507597") > order(incident).indexOf("_PxLRDo4PKkgRsvudsnJTw"));
}
eq("§3.4 live before silent, whatever the fix times",
	order([{ routemate_vehicle_id: "s", silent: true, last_fix_ms: NOW }, { routemate_vehicle_id: "l", silent: false, last_fix_ms: NOW - HOUR_MS }]).join(","), "l,s");
eq("§3.5 newer fix first; no fix (null, 0, NaN) after any fix",
	order([
		{ routemate_vehicle_id: "a", last_fix_ms: null },
		{ routemate_vehicle_id: "b", last_fix_ms: NOW - 2 * HOUR_MS },
		{ routemate_vehicle_id: "c", last_fix_ms: 0 },
		{ routemate_vehicle_id: "d", last_fix_ms: NOW - HOUR_MS },
		{ routemate_vehicle_id: "e", last_fix_ms: NaN },
	]).join(","), "d,b,a,c,e");
eq("§3.6 vehicle id in numeric order (9, 33, 356, 1000), a blank one last",
	order([
		{ routemate_vehicle_id: "v1000", vehicle_id: "1000" },
		{ routemate_vehicle_id: "blank", vehicle_id: "  " },
		{ routemate_vehicle_id: "v356", vehicle_id: "356" },
		{ routemate_vehicle_id: "v9", vehicle_id: "9" },
		{ routemate_vehicle_id: "v33", vehicle_id: "33" },
	]).join(","), "v9,v33,v356,v1000,blank");
eq("§3.7 equal vehicle ids fall to the device id",
	order([{ routemate_vehicle_id: "zz", vehicle_id: "356" }, { routemate_vehicle_id: "aa", vehicle_id: "356" }]).join(","), "aa,zz");
eq("§3.8 vehicle ids that numeric collation calls equal ('01', '1') still order by device id",
	order([{ routemate_vehicle_id: "m2", vehicle_id: "1" }, { routemate_vehicle_id: "m1", vehicle_id: "01" }]).join(","), "m1,m2");
{
	let threw = null;
	try { [null, undefined, {}, { routemate_vehicle_id: "x" }].sort(comparePickerDevices); } catch (e) { threw = e; }
	eq("§3.9 null/undefined/empty entries do not throw", threw, null);
}
{
	// Total order: reflexive, antisymmetric, transitive, never NaN — over a pool
	// that mixes every key's edge cases.
	const pool = [
		{ routemate_vehicle_id: "18000507597", vehicle_id: "", last_fix_ms: Date.parse("2026-09-15T12:00:00Z"), silent: true },
		{ routemate_vehicle_id: "_PxLRDo4PKkgRsvudsnJTw", vehicle_id: "356", last_fix_ms: NOW - 5 * MIN_MS, silent: false },
		{ routemate_vehicle_id: "rm-33-handle", vehicle_id: "33", last_fix_ms: NOW - 5 * MIN_MS, silent: false },
		{ routemate_vehicle_id: "x78f4qtVukzwiF6ur7D04A", vehicle_id: "2372", last_fix_ms: null, silent: true },
		{ routemate_vehicle_id: "m1", vehicle_id: "01", last_fix_ms: 0, silent: true },
		{ routemate_vehicle_id: "m2", vehicle_id: "1", last_fix_ms: 0, silent: true },
		{ routemate_vehicle_id: "m3", vehicle_id: "1", last_fix_ms: NaN, silent: true },
		{ routemate_vehicle_id: "", vehicle_id: "", last_fix_ms: undefined, silent: true },
		{ routemate_vehicle_id: "inf", vehicle_id: "A7", last_fix_ms: Infinity, silent: false },
		{ routemate_vehicle_id: "low", vehicle_id: "a7", last_fix_ms: Infinity, silent: false },
		null,
	];
	const bad = [];
	for (const a of pool) {
		if (comparePickerDevices(a, a) !== 0) bad.push("reflexive");
		for (const b of pool) {
			const ab = comparePickerDevices(a, b);
			const ba = comparePickerDevices(b, a);
			if (typeof ab !== "number" || Number.isNaN(ab)) bad.push("NaN");
			if (Math.sign(ab) !== -Math.sign(ba)) bad.push("antisymmetric");
			for (const c of pool) {
				if (ab <= 0 && comparePickerDevices(b, c) <= 0 && comparePickerDevices(a, c) > 0) bad.push("transitive");
			}
		}
	}
	eq(`§3.10 a total order over ${pool.length} mixed devices (reflexive, antisymmetric, transitive, no NaN)`, [...new Set(bad)].join(","), "");
}

// ------------------------------------------------------ §4 describeEldDevice
section("§4 describeEldDevice");
const RV356 = { routemate_vehicle_id: "_PxLRDo4PKkgRsvudsnJTw", vehicle_id: "356", year: 2022, make: "INTERNATIONAL", model: "LT625" };
eq("§4.1 vehicle id with year, make and model", describeEldDevice(RV356), "vehicle 356 (2022 INTERNATIONAL LT625)");
eq("§4.2 a 0 year is left out", describeEldDevice({ ...RV356, year: 0 }), "vehicle 356 (INTERNATIONAL LT625)");
eq("§4.3 only a model", describeEldDevice({ vehicle_id: "356", year: 0, make: "", model: "LT625" }), "vehicle 356 (LT625)");
eq("§4.4 only a year (as text)", describeEldDevice({ vehicle_id: "356", year: "2022" }), "vehicle 356 (2022)");
eq("§4.5 no details at all → no parentheses", describeEldDevice({ vehicle_id: "356", year: 0, make: "", model: "" }), "vehicle 356");
eq("§4.6 a vehicle id is trimmed, and a numeric one reads", describeEldDevice({ vehicle_id: 356 }) + "|" + describeEldDevice({ vehicle_id: "  356 " }), "vehicle 356|vehicle 356");
eq("§4.7 an unreadable year is left out", describeEldDevice({ vehicle_id: "356", year: "n/a", make: "INTERNATIONAL" }), "vehicle 356 (INTERNATIONAL)");
eq("§4.8 the dead Linxup row (blank vehicle id, VIN, make) → device <id>",
	describeEldDevice({ routemate_vehicle_id: "18000507597", vehicle_id: "", vin: "", make: "", model: "", year: 0 }), "device 18000507597");
eq("§4.9 a whitespace-only vehicle id → device <id>", describeEldDevice({ routemate_vehicle_id: "18000507597", vehicle_id: "   ", make: "FORD" }), "device 18000507597");
for (const [label, v] of [["null", null], ["undefined", undefined], ["{}", {}], ["a string", "356"]]) {
	let out, threw = null;
	try { out = describeEldDevice(v); } catch (e) { threw = e; }
	ok(`§4.10 ${label} does not throw and answers a non-empty string`, threw === null && typeof out === "string" && out.length > 0, threw ? String(threw) : JSON.stringify(out));
}
{
	const LS = String.fromCodePoint(0x2028);
	const RLO = String.fromCodePoint(0x202e);
	const ZWSP = String.fromCodePoint(0x200b);
	const out = describeEldDevice({ vehicle_id: "356\r\nBcc: x@example.com", make: `INTER${LS}NATIONAL`, model: `LT${RLO}625${ZWSP}` });
	ok("§4.11 one line: no CR, LF, line separator, bidi or zero-width character survives", !/[\r\n\s\p{Cc}\p{Cf}]/u.test(out.replace(/ /g, "")), JSON.stringify(out));
	eq("§4.12 the folded text still reads", out, "vehicle 356 Bcc: x@example.com (INTER NATIONAL LT 625)");
}
{
	const long = describeEldDevice({ vehicle_id: "A".repeat(300), make: "INTERNATIONAL", model: "LT625" });
	ok("§4.13 a long description is capped at 80 characters", Array.from(long).length <= 80 && long.endsWith("..."), `${Array.from(long).length}: ${long}`);
	const huge = describeEldDevice({ routemate_vehicle_id: "9".repeat(100000) });
	ok("§4.14 a huge device id is capped too", Array.from(huge).length <= 80 && huge.startsWith("device 999"), `${Array.from(huge).length}`);
	const astral = describeEldDevice({ vehicle_id: "x" + String.fromCodePoint(0x1f69a).repeat(200) });
	ok("§4.15 the cuts count characters and leave no half of one (the field cut lands mid-pair)", Array.from(astral).length <= 80 && !/\p{Cs}/u.test(astral), `${Array.from(astral).length}`);
	eq("§4.16 a description under the cap is untouched", describeEldDevice(RV356).length < 80, true);
}

// ---------------------------------------------------------------- report
console.log(`\n${"─".repeat(60)}`);
if (failures.length) {
	console.error(`FAIL — ${failures.length} failed, ${passed} passed\n`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	process.exit(1);
}
console.log(`PASS — ${passed} assertions, 0 failures`);
