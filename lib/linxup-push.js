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
// ⚠️ LIVE-CAPTURE: a few fields (speed unit, which id the fleet links trucks by)
// are inferred from the doc, not a real payload — verify against the first live
// push and adjust ONLY the marked spots here.

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

// Convert a Linxup speed value → m/s using the configured unit.
function speedToMps(value, unit) {
	const n = num(value);
	if (n == null) return 0;
	switch (String(unit || "mph").toLowerCase()) {
		case "mps": case "m/s": return n;
		case "kmh": case "km/h": case "kph": return n * KMH_TO_MPS;
		case "mph": default: return n * MPH_TO_MPS; // LIVE-CAPTURE: confirm unit
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
		odometer: num(m.odometer) || 0,
		engine_hours: 0,                                 // Position carries none; Usage Hours does
		fuel_pct: num(m.fuelLevel),                      // may be null
		geocoded_location: geocoded,
		location_date_ms: num(m.date) || 0,
		engine_on: m.engineOn === true,
	};
}

module.exports = {
	MPH_TO_MPS,
	speedToMps,
	detectMessageType,
	vehicleIdCandidates,
	normalizePosition,
};
