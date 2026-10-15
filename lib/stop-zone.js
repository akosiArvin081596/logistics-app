"use strict";
// WHICH CLOCK A STOP KEEPS. Rate cons state a shipper's or receiver's appointment
// in the facility's local time (user, 2026-10-15), so a time read off one is a
// wall clock in that facility's zone. One rule, read by the customer tracker's
// On time / Delayed badge, the Tracking tab's status (lib/eta-on-time.js) and the
// on-time KPI (lib/kpi-appointments.js):
//
//   1. the zone the appointment cell writes ("08:00 CST", "Central");
//   2. the stop's STATE: from its address ("San Antonio, TX 78219"), else from
//      its coordinates (lib/us-states.js, the real borders), mapped to the
//      state's zone; Arizona is America/Phoenix (no daylight saving time);
//   3. the stop's longitude band (lib/eld-miles.js usTzForLongitude());
//   4. the caller's fallback (APP_TIMEZONE for the ETA verdict), else none.
//
//   stopZone({ text, address, lat, lng, fallbackZone }) -> { zone, source } | null
//     source: 'text' | 'state' | 'band' | 'fallback'
//
// STATES WITH TWO ZONES, by the stop's longitude (and latitude) inside the
// state, along county lines approximated to the nearest town: Indiana (the
// Chicago and Evansville corners are Central), Kentucky (west of a line from
// Breckinridge to Clinton County is Central), Tennessee (East Tennessee,
// Chattanooga's county included, is Eastern), Florida (the panhandle west of the
// Apalachicola River is Central), Texas (El Paso and Hudspeth are Mountain),
// North Dakota (the southwest is Mountain), South Dakota (west of the Missouri is
// Mountain), Nebraska (the west is Mountain), Kansas (the four western border
// counties are Mountain), Idaho (the panhandle north of the Salmon River is
// Pacific), Oregon (Malheur County is Mountain) and Michigan (the four Upper
// Peninsula counties on the Wisconsin line are Central). Without coordinates a
// split state reads its larger part's zone. Not covered: Nevada's West Wendover
// (Mountain), the Navajo Nation's daylight saving time, Alaska's Aleutians.
//
// Pure: the US borders load with lib/us-states.js at require time; no I/O after.

const { usTzForLongitude } = require("./eld-miles");
const usStates = require("./us-states");

// The four mainland bands come from usTzForLongitude() at a longitude inside each,
// so their zone names stay in lib/eld-miles.js; this file names only the zones no
// band holds (scripts/test-app-timezone-switch.js pins both).
const BAND_LNG = Object.freeze({ eastern: -80, central: -90, mountain: -105, pacific: -120 });
const EASTERN = usTzForLongitude(BAND_LNG.eastern);
const CENTRAL = usTzForLongitude(BAND_LNG.central);
const MOUNTAIN = usTzForLongitude(BAND_LNG.mountain);
const PACIFIC = usTzForLongitude(BAND_LNG.pacific);
const ARIZONA = "America/Phoenix";
const BAND_BY_WORD = Object.freeze({
	EST: "eastern", EDT: "eastern", ET: "eastern", EASTERN: "eastern",
	CST: "central", CDT: "central", CT: "central", CENTRAL: "central",
	MST: "mountain", MDT: "mountain", MT: "mountain", MOUNTAIN: "mountain",
	PST: "pacific", PDT: "pacific", PT: "pacific", PACIFIC: "pacific",
});
const ZONE_ABBR_RE = /\b(E[SD]?T|C[SD]?T|M[SD]?T|P[SD]?T)\b/;
const ZONE_NAME_RE = /\b(eastern|central|mountain|pacific)\b/i;

// One zone per state; split states name their larger part here.
const STATE_ZONE = Object.freeze({
	CT: EASTERN, DE: EASTERN, DC: EASTERN, GA: EASTERN, ME: EASTERN, MD: EASTERN, MA: EASTERN, NH: EASTERN,
	NJ: EASTERN, NY: EASTERN, NC: EASTERN, OH: EASTERN, PA: EASTERN, RI: EASTERN, SC: EASTERN, VT: EASTERN,
	VA: EASTERN, WV: EASTERN, MI: EASTERN, IN: EASTERN, KY: EASTERN, FL: EASTERN,
	AL: CENTRAL, AR: CENTRAL, IL: CENTRAL, IA: CENTRAL, LA: CENTRAL, MN: CENTRAL, MS: CENTRAL, MO: CENTRAL,
	OK: CENTRAL, WI: CENTRAL, TX: CENTRAL, TN: CENTRAL, ND: CENTRAL, SD: CENTRAL, NE: CENTRAL, KS: CENTRAL,
	AZ: ARIZONA, CO: MOUNTAIN, MT: MOUNTAIN, NM: MOUNTAIN, UT: MOUNTAIN, WY: MOUNTAIN, ID: MOUNTAIN,
	CA: PACIFIC, NV: PACIFIC, WA: PACIFIC, OR: PACIFIC,
	AK: "America/Anchorage", HI: "Pacific/Honolulu",
});

// The split states' other part, by where in the state the stop is. `lng` is
// always known here; `lat` may be null (an address and a longitude, no latitude),
// and then a state whose line needs it reads by longitude alone or its larger part.
const SPLIT = Object.freeze({
	IN: (lat, lng) => (lat !== null && lng < -86.55 && (lat >= 40.7 || lat < 38.42) ? CENTRAL : EASTERN),
	KY: (lat, lng) => (lng < (lat === null ? -86.0 : -86.05 + (38.0 - lat) * 0.78) ? CENTRAL : EASTERN),
	TN: (lat, lng) => (lng > -85.0 || ((lat === null || lat < 35.55) && lng > -85.48) ? EASTERN : CENTRAL),
	FL: (lat, lng) => (lng < -85.0 ? CENTRAL : EASTERN),
	TX: (lat, lng) => (lng < -104.9 ? MOUNTAIN : CENTRAL),
	ND: (lat, lng) => (lat !== null && lng < -101.3 && lat < 47.55 ? MOUNTAIN : CENTRAL),
	SD: (lat, lng) => (lng < -100.55 ? MOUNTAIN : CENTRAL),
	NE: (lat, lng) => (lng < -101.25 ? MOUNTAIN : CENTRAL),
	KS: (lat, lng) => (lng < -101.4 ? MOUNTAIN : CENTRAL),
	ID: (lat) => (lat !== null && lat > 45.6 ? PACIFIC : MOUNTAIN),
	OR: (lat, lng) => (lng > -117.7 && (lat === null || lat < 44.5) ? MOUNTAIN : PACIFIC),
	MI: (lat, lng) => ((lat === null || lat > 45.0) && lng < -87.58 ? CENTRAL : EASTERN),
});

function num(v) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

// "08:00 CST" -> the region's zone, or null.
function zoneInText(text) {
	const s = String(text == null ? "" : text).slice(0, 200);
	const abbr = ZONE_ABBR_RE.exec(s);
	const name = abbr ? null : ZONE_NAME_RE.exec(s);
	const word = abbr ? abbr[1] : (name ? name[1].toUpperCase() : null);
	return word ? usTzForLongitude(BAND_LNG[BAND_BY_WORD[word]]) : null;
}

// The USPS state an address names: "City, ST 12345", "City, ST", "City ST 12345".
// The last such code wins (a street can carry letters too). Bounded quantifiers:
// the address is rate-con text.
const ADDRESS_STATE_RE = /(?:^|[\s,])([A-Za-z]{2})\.?(?=\s{0,3}(?:\d{5}(?:-\d{4})?)?\s{0,3}(?:,\s{0,3}(?:USA?|United States))?\s{0,3}$|\s{1,3}\d{5}\b)/g;
function stateFromAddress(address) {
	const s = String(address == null ? "" : address).replace(/\s{1,200}/g, " ").trim().slice(0, 300);
	let found = null;
	let m;
	ADDRESS_STATE_RE.lastIndex = 0;
	while ((m = ADDRESS_STATE_RE.exec(s)) !== null) {
		const code = m[1].toUpperCase();
		if (STATE_ZONE[code]) found = code;
	}
	return found;
}

function zoneForState(state, lat, lng) {
	const base = STATE_ZONE[state];
	if (!base) return null;
	const split = SPLIT[state];
	if (!split || lng === null) return base;
	return split(lat, lng);
}

function stopZone({ text, address, lat, lng, fallbackZone } = {}) {
	const la = num(lat);
	const ln = num(lng);
	let state = stateFromAddress(address);
	if (!state && la !== null && ln !== null) {
		const at = usStates.stateAt(la, ln);
		if (at && STATE_ZONE[at]) state = at;
	}
	const fromText = zoneInText(text);
	if (fromText) {
		// "MST" at an Arizona stop is Arizona's clock, which keeps no summer time.
		if (state === "AZ" && fromText === MOUNTAIN) return { zone: ARIZONA, source: "text" };
		return { zone: fromText, source: "text" };
	}
	if (state) return { zone: zoneForState(state, la, ln), source: "state" };
	if (ln !== null) return { zone: usTzForLongitude(ln), source: "band" };
	const fb = typeof fallbackZone === "string" && fallbackZone.trim() ? fallbackZone.trim() : null;
	return fb ? { zone: fb, source: "fallback" } : null;
}

module.exports = {
	STATE_ZONE,
	stopZone,
	stateFromAddress,
	zoneForState,
	zoneInText,
};
