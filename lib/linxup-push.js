// Linxup Push API v3 — pure message mapping (no network, no DB).
//
// Linxup is the fleet-GPS/telematics provider (replacing the Routemate poller).
// Unlike a pull API, Linxup PUSHES event messages to our webhook; this module
// turns one pushed message into the neutral telemetry shape server.js writes
// into the live telemetry table (feeding tracking + driver-pay). server.js owns
// the HTTP endpoint, token check, DB insert, socket emit, and geofence — this
// file is only the shape-mapping so it can be unit-reasoned/tested in isolation.
//
// Reference: Push API V3 doc (25-page message catalog). The messages we care
// about for live tracking are Position (real-time GPS), with Trip/Stop/Usage
// as context. Every other message type is recognized so the receiver can ACK.
//
// ✅ SPEED UNIT IS CONFIRMED **MPH** — this is no longer an open question.
// Settled 2026-07-25 by commit ef85a3b from a live pull ("67mph -> 29.95 m/s"),
// and re-verified against production telemetry on 2026-09-19 two independent
// ways over 2,343 real Linxup rows on two devices:
//   - stored-speed integral vs odometer delta: ratio 0.960 and 0.969
//     (km/h would give ~0.62, already-m/s would give ~2.24)
//   - raw wire values (stored / MPH_TO_MPS) are whole integers clustering 63-69,
//     i.e. highway truck mph. km/h cruise would cluster 95-115.
// Do not re-open it from the PDF; the PDF is what was wrong.
//
// ⚠️ STILL LIVE-CAPTURE: which id the fleet links trucks by (see vehicleIdCandidates).
//
// What remains guarded is a FUTURE unit change — a provider-side switch or a bad
// LINXUP_SPEED_UNIT override. `judgeSpeedUnit()` below is that guard; note the
// existing `speed_outlier` filter CANNOT catch it, because it derives speed from
// GPS distance/time and never reads the reported `speed` field at all.

"use strict";

// Linxup speed is assumed MPH (US provider) unless overridden; downstream expects
// m/s (browser-geolocation native), same convention the Routemate client used.
const MPH_TO_MPS = 0.44704;
const KMH_TO_MPS = 0.277778;

function num(v) {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string") {
		const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
		return Number.isFinite(n) ? n : null;
	}
	return null;
}
function str(v) { return v == null ? "" : String(v).trim(); }
// First of several possibly-differently-named fields that parses to a number.
function firstNum(...vals) {
	for (const v of vals) { const n = num(v); if (n != null) return n; }
	return null;
}

// Convert a Linxup speed value → m/s using the configured unit.
function speedToMps(value, unit) {
	const n = num(value);
	if (n == null) return 0;
	switch (String(unit || "mph").toLowerCase()) {
		case "mps": case "m/s": return n;
		case "kmh": case "km/h": case "kph": return n * KMH_TO_MPS;
		case "mph": default: return n * MPH_TO_MPS; // confirmed mph — see header
	}
}

// Classify a pushed message by its distinctive fields. The Push API doc gives no
// explicit "type" field on the messages, so we detect structurally.
function detectMessageType(m) {
	if (!m || typeof m !== "object") return "unknown";
	if (m.latitude != null && m.longitude != null && ("speed" in m) && ("heading" in m || "direction" in m)) return "position";
	if ("startDateTime" in m && "endDateTime" in m && ("distanceMiles" in m || "authorizedMiles" in m)) return "trip";
	if ("stopType" in m) return "stop";
	if ("engineOn" in m && "startDate" in m && "endDate" in m) return "usage";
	if ("eventType" in m && /FENCE_(ENTER|EXIT)/.test(str(m.eventType))) return "geofence_event";
	if ("action" in m && "geofenceId" in m) return "geofence_change";
	if ("alertId" in m) return "alert";
	if ("statusChangeType" in m) return "device_status";
	if ("mediaId" in m) return "media";
	if ("leftBehindTimestamp" in m) return "item_left_behind";
	if ("trackedItem" in m && "toolTracker" in m) return "item_location";
	if ("tracker" in m && !("latitude" in m)) return "device_update";
	return "unknown";
}

// The stable identifiers a Position carries for its vehicle/device. A truck is
// linked (trucks.<eld/routemate>_vehicle_id) by ONE of these; the receiver tries
// them all so it works regardless of which the fleet chose. Order = preference
// when no truck link matches. LIVE-CAPTURE: confirm the fleet's link id.
function vehicleIdCandidates(m) {
	const t = (m && m.tracker) || {};
	const a = (m && m.asset) || {};
	return [str(t.trackerId), str(t.deviceNumber), str(t.deviceSerialNumber), str(a.vin)]
		.filter(Boolean)
		.filter((v, i, arr) => arr.indexOf(v) === i);
}

// Position → neutral telemetry. `vehicleId` is chosen by the caller (it knows
// which candidate a truck is linked by); default = first candidate.
function normalizePosition(m, opts = {}) {
	const speedUnit = opts.speedUnit || "mph";
	const candidates = vehicleIdCandidates(m);
	const vehicleId = opts.vehicleId || candidates[0] || "";
	const addr = m.address || {};
	const geocoded = [str(addr.city), str(addr.stateCode)].filter(Boolean).join(", ")
		|| [str(addr.street), str(addr.city)].filter(Boolean).join(", ");
	// bearing column is stored as text and later parsed to degrees; Linxup gives
	// `direction` (degrees from north) plus `heading` (N/NE/...). Prefer degrees.
	const bearing = m.direction != null ? String(m.direction) : str(m.heading);
	return {
		vehicle_id: vehicleId,
		candidates,
		latitude: num(m.latitude),
		longitude: num(m.longitude),
		speed: speedToMps(m.speed, speedUnit),          // m/s
		bearing,
		// Live Linxup data uses trueOdo/virtualOdo/estimatedOdo; the PDF called it
		// `odometer` — accept whichever is present (verified against real fleet data).
		odometer: firstNum(m.odometer, m.trueOdo, m.virtualOdo, m.estimatedOdo) || 0,
		engine_hours: 0,                                 // Position carries none; Usage Hours does
		fuel_pct: num(m.fuelLevel),                      // "78.0%" or a number → 78
		geocoded_location: geocoded,
		// Live data uses `positionDate`; the PDF called it `date` — accept both.
		location_date_ms: firstNum(m.date, m.positionDate) || 0,
		engine_on: m.engineOn === true,
	};
}

// ---------------------------------------------------------------------------
// Speed-unit consistency guard
// ---------------------------------------------------------------------------
// ⚠️ WHY THIS EXISTS, AND WHY THE EXISTING OUTLIER FILTER IS NOT IT.
// server.js tags a fix `speed_outlier` when GPS distance/time implies an
// impossible speed. That check never reads the reported `speed` field, so a
// wrong UNIT is completely invisible to it: a 105 km/h wire value read as mph
// stores 46.9 m/s, which is under the 53.6 m/s outlier ceiling and sails through.
//
// The damage is at the low end, not at cruise. Driver pay counts a day worked
// when speed > 2.235 m/s, i.e. whenever the wire value exceeds 5. If the feed
// were km/h that threshold is really 3.1 mph (over-counts paid days); if it were
// already m/s it is 11.2 mph (under-counts them, silently docking drivers).
//
// So we compare the REPORTED speed against an independent ground truth:
// straight-line GPS distance between consecutive fixes. Odometer is deliberately
// NOT the reference — it carries its own unit assumption, which would make the
// test circular.
//
// OBSERVE-ONLY BY DESIGN. A verdict never blocks an insert. A false positive
// that refuses ingestion loses tracking data permanently; one that logs costs
// nothing. Same discipline as the load-distance tripwire, which "observes only,
// never deletes a row."

// Ratio = (distance implied by reported speed) / (distance measured from GPS).
// Production sits at 0.96-0.97, so `consistent` is deliberately wide: real
// tracks lose distance to sampling gaps and curve-cutting, which biases the
// GPS reference LOW, never high.
const UNIT_BANDS = [
	{ verdict: "consistent", lo: 0.80, hi: 1.25 },
	{ verdict: "looks_kmh", lo: 0.50, hi: 0.75 },   // feed is km/h, read as mph
	{ verdict: "looks_mps", lo: 1.90, hi: 2.60 },   // feed is already m/s
];

// Below these a verdict is meaningless: a parked truck integrates 0/0, and a
// handful of fixes is dominated by GPS jitter. Both must be met.
const UNIT_MIN_SAMPLES = 40;
const UNIT_MIN_GPS_METERS = 8000;   // ~5 miles of actual movement

// Accumulate one consecutive fix pair. `prev`/`cur` are {latitude, longitude,
// speed (m/s, already converted), location_date_ms}. `distanceFn` is injected so
// this module stays dependency-free; server.js passes geolib.getDistance.
// Returns a NEW accumulator — never mutates, so a caller can hold one per vehicle.
function accumulateUnitSample(acc, prev, cur, distanceFn, opts = {}) {
	const minDtMs = opts.minDtMs == null ? 5 * 1000 : opts.minDtMs;
	const maxDtMs = opts.maxDtMs == null ? 10 * 60 * 1000 : opts.maxDtMs;
	const base = acc && typeof acc === "object" ? acc : { samples: 0, reportedM: 0, gpsM: 0 };
	if (!prev || !cur) return base;

	// ⚠️ Resolve BOTH timestamps before subtracting. num() answers null for a
	// non-finite value, and `61000 - null` is 61000, not NaN — so a missing or
	// NaN timestamp would silently masquerade as a perfectly-sized gap and feed
	// the detector a pair that never happened.
	const tPrev = num(prev.location_date_ms), tCur = num(cur.location_date_ms);
	if (tPrev == null || tCur == null) return base;

	const dtMs = tCur - tPrev;
	// A gap outside the window is not evidence either way — a long parked stretch
	// would otherwise add GPS distance with no matching reported speed.
	if (!Number.isFinite(dtMs) || dtMs < minDtMs || dtMs > maxDtMs) return base;

	const sPrev = num(prev.speed), sCur = num(cur.speed);
	if (sPrev == null || sCur == null || sPrev < 0 || sCur < 0) return base;

	const gps = distanceFn(
		{ latitude: prev.latitude, longitude: prev.longitude },
		{ latitude: cur.latitude, longitude: cur.longitude },
	);
	if (!Number.isFinite(gps) || gps < 0) return base;

	// Trapezoid: the integral of speed over the interval.
	const reported = ((sPrev + sCur) / 2) * (dtMs / 1000);
	return {
		samples: base.samples + 1,
		reportedM: base.reportedM + reported,
		gpsM: base.gpsM + gps,
	};
}

// Classify an accumulator. Anything not inside a named band is `inconclusive`,
// never an alarm — the bands deliberately do not tile the number line.
function judgeSpeedUnit(acc, opts = {}) {
	const minSamples = opts.minSamples == null ? UNIT_MIN_SAMPLES : opts.minSamples;
	const minGpsM = opts.minGpsMeters == null ? UNIT_MIN_GPS_METERS : opts.minGpsMeters;
	const a = acc || {};
	const samples = a.samples || 0, gpsM = a.gpsM || 0, reportedM = a.reportedM || 0;

	if (samples < minSamples || gpsM < minGpsM) {
		return { verdict: "insufficient_data", ratio: null, samples, gpsM, reportedM };
	}
	const ratio = reportedM / gpsM;
	const band = UNIT_BANDS.find((b) => ratio >= b.lo && ratio < b.hi);
	return {
		verdict: band ? band.verdict : "inconclusive",
		ratio: Math.round(ratio * 1000) / 1000,
		samples, gpsM: Math.round(gpsM), reportedM: Math.round(reportedM),
	};
}

// A verdict worth waking someone for. `inconclusive` and `insufficient_data`
// are NOT alarms — treating "I do not know" as "something is wrong" is how a
// monitor gets muted, and a muted monitor is worse than none.
function unitVerdictIsAlarming(v) {
	return v === "looks_kmh" || v === "looks_mps";
}

module.exports = {
	MPH_TO_MPS,
	speedToMps,
	detectMessageType,
	vehicleIdCandidates,
	normalizePosition,
	accumulateUnitSample,
	judgeSpeedUnit,
	unitVerdictIsAlarming,
	UNIT_BANDS,
	UNIT_MIN_SAMPLES,
	UNIT_MIN_GPS_METERS,
};
