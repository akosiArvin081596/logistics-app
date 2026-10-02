#!/usr/bin/env node
// lib/us-states.js: (lat, lng) → state by the real borders.
//
// WHY THIS EXISTS. eld_state_miles_daily STORES which state each mile was driven
// in, and the pings behind it are purged at 90 days, so a wrong answer is
// permanent. lib/ifta-states.js (bounding boxes, first match wins, Texas first)
// answers "TX" for Oklahoma City, Shreveport, Texarkana AR and Roswell NM; it
// also puts Louisville in IN and Huntington in OH. Every one of those is pinned
// below against the real borders, together with the lanes this fleet runs
// (TX, OK, MO, IA, KS) and the edges: a city split by a state line (Kansas
// City, Texarkana), the Gulf, Mexico.
//
// No network, no database, no server.
//
//   node scripts/test-us-states.js      # exits 1 on any failure

const { stateAt, OTHER } = require("../lib/us-states");
const { getStateFromCoords } = require("../lib/ifta-states");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

// ---------------------------------------------------------------------------
// 1. The cities the bounding boxes get wrong.
// ---------------------------------------------------------------------------
const boxErrors = [
	["Oklahoma City", 35.4676, -97.5164, "OK"],
	["Shreveport", 32.5252, -93.7502, "LA"],
	["Texarkana, AR side", 33.4418, -94.0377, "AR"],
	["Roswell", 33.3943, -104.523, "NM"],
	["Louisville", 38.2527, -85.7585, "KY"],
	["Huntington", 38.4192, -82.4452, "WV"],
];
for (const [name, lat, lng, want] of boxErrors) {
	check(`${name} is ${want}`, stateAt(lat, lng), want);
}
// Proof the old module really does miss these, so this suite is pinning a
// real difference rather than agreeing with it by accident.
check("ifta-states puts Oklahoma City in TX (the reason this module exists)",
	getStateFromCoords(35.4676, -97.5164), "TX");

// ---------------------------------------------------------------------------
// 2. The lanes this fleet actually runs.
// ---------------------------------------------------------------------------
const lanes = [
	["Houston", 29.7604, -95.3698, "TX"],
	["Dallas", 32.7767, -96.797, "TX"],
	["Amarillo", 35.222, -101.8313, "TX"],
	["El Paso", 31.7619, -106.485, "TX"],
	["Tulsa", 36.154, -95.9928, "OK"],
	["St. Louis", 38.627, -90.1994, "MO"],
	["Des Moines", 41.5868, -93.625, "IA"],
	["Wichita", 37.6872, -97.3301, "KS"],
	["Omaha", 41.2565, -95.9345, "NE"],
	["Little Rock", 34.7465, -92.2896, "AR"],
	["Memphis", 35.1495, -90.049, "TN"],
	["Charlotte", 35.2271, -80.8431, "NC"],
	["Minneapolis", 44.9778, -93.265, "MN"],
];
for (const [name, lat, lng, want] of lanes) {
	check(`${name} is ${want}`, stateAt(lat, lng), want);
}

// ---------------------------------------------------------------------------
// 3. Cities a state line runs through.
// ---------------------------------------------------------------------------
check("Kansas City, MO side", stateAt(39.0997, -94.5786), "MO");
check("Kansas City, KS side", stateAt(39.1141, -94.6275), "KS");
check("Texarkana, TX side", stateAt(33.4251, -94.0477), "TX");
check("Washington DC is DC, not VA", stateAt(38.8977, -77.0365), "DC");
check("Baltimore is MD, not VA", stateAt(39.2904, -76.6122), "MD");

// ---------------------------------------------------------------------------
// 4. Outside every state.
// ---------------------------------------------------------------------------
check("mid-Gulf of Mexico is OTHER", stateAt(26.5, -91.0), OTHER);
check("Monterrey, Mexico is OTHER", stateAt(25.6866, -100.3161), OTHER);
check("Galveston (a coastal causeway town) is TX", stateAt(29.3013, -94.7977), "TX");

// ---------------------------------------------------------------------------
// 5. Bad input never throws and never guesses.
// ---------------------------------------------------------------------------
check("NaN is OTHER", stateAt(NaN, -95), OTHER);
check("missing longitude is OTHER", stateAt(30, undefined), OTHER);
check("string coordinates are read as numbers", stateAt("35.4676", "-97.5164"), "OK");
check("a cached answer is the same answer", stateAt(35.4676, -97.5164), "OK");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
