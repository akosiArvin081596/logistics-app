#!/usr/bin/env node
// lib/chr-verify.js: no milestone goes to C.H. Robinson on a tap's word alone.
// Each one must be confirmed by a clean RouteMate ping of the load's truck at
// its stop (R5 PR 1a: plan 4.5; review-2 NL3).
//
//   §1  the windows, and which stop's point each event is checked against
//   §2  clean pings: RouteMate rows with no dropped reason; never Linxup,
//       untagged or dropped
//   §3  arrivals: a tap at the stop and a geofence row pass; the 285-mile tap
//       is held as away, with no position
//   §4  delivered: a late tap far from the receiver is held
//   §5  departures: inside before and moving outside after; an early In Transit
//       while still parked at the shipper is held
//   §6  no mapped point, no device
//   §7  NL3: a window closes only once a later ping has arrived, or after a grace
//   §8  parity: the stop-points rule equals server.js's resolveGeofencePoints()
//       on fixtures; the radius and the departure speed are the geofence's
//   §9  the module stays pure
//
// Made-up data only. No network, no database, no files written.
//   node scripts/test-chr-verify.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const V = require(path.join(ROOT, "lib", "chr-verify.js"));
const tripWorkDays = require(path.join(ROOT, "lib", "trip-work-days.js"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function section(t) { console.log(`\n${t}`); }

const MIN = 60 * 1000;
const T = Date.parse("2026-11-02T16:00:00Z");
const RADIUS = tripWorkDays.DEFAULT_GEOFENCE_RADIUS_M;
// Made-up stop points and positions.
const PICKUP = { latitude: 42.0347, longitude: -93.62 };
const DROP = { latitude: 41.525, longitude: -88.0817 };
const AT_PICKUP = { lat: 42.035, lng: -93.6195 };
const NEAR_EDGE = { lat: 42.0617, lng: -93.62 }; // about 3.0 km from the pickup point
const OUTSIDE = { lat: 42.08, lng: -93.62 }; // about 5 km from the pickup point
const FAR_285 = { lat: 37.9, lng: -93.62 }; // about 285 miles south
const FAR_100 = { lat: 40.08, lng: -88.0817 }; // about 100 miles from the drop
const AT_DROP = { lat: 41.5252, lng: -88.0815 };
function ping(atMin, at, over = {}) {
	return { ms: T + atMin * MIN, lat: at.lat, lng: at.lng, speed: 0, source: "routemate", dropped_reason: "", ...over };
}
function verify(over) {
	return V.verifyMilestone({ event: "arrived_pickup", eventMs: T, point: PICKUP, radiusM: RADIUS, device: "RM-TEST-1", pings: [], latestPingMs: null, nowMs: T + 2 * 60 * MIN, ...over });
}
const short = (res) => [res.verify, res.ping ? res.ping.ms : null];

// ------------------------------------------------------------------ §1
section("§1  windows and stops");
eq([V.ARRIVE_WINDOW_MS, V.DELIVERED_WINDOW_MS, V.DEPART_BEFORE_MS, V.DEPART_AFTER_MS], [15 * MIN, 15 * MIN, 15 * MIN, 30 * MIN], "§1 15 minutes for arrivals and delivered, 15 before and 30 after a departure");
eq(V.windowFor("arrived_pickup", T), { fromMs: T, toMs: T + 15 * MIN }, "§1 an arrival: at or after the event, within 15 minutes");
eq(V.windowFor("arrived_delivery", T), { fromMs: T, toMs: T + 15 * MIN }, "§1 a drop arrival: the same");
eq(V.windowFor("delivered", T), { fromMs: T - 15 * MIN, toMs: T + 15 * MIN }, "§1 delivered: 15 minutes either side");
eq(V.windowFor("departed_pickup", T), { fromMs: T - 15 * MIN, toMs: T + 30 * MIN }, "§1 a departure: 15 before to 30 after");
eq(V.windowFor("departed_delivery", T), null, "§1 an intermediate departure has no window (never sent in v1)");
const pts = { origin: PICKUP, dest: DROP };
const evOf = (event, kind, index) => ({ event, stop: { kind, index } });
eq([V.stopPointFor(evOf("arrived_pickup", "pickup", 1), pts), V.stopPointFor(evOf("departed_pickup", "pickup", 1), pts)], [PICKUP, PICKUP], "§1 pickup 1 is checked at the mapped pickup point");
eq([V.stopPointFor(evOf("arrived_delivery", "delivery", 1), pts), V.stopPointFor(evOf("delivered", "delivery", 2), pts)], [DROP, DROP], "§1 a drop arrival and delivered are checked at the mapped drop-off point");
eq([V.stopPointFor(evOf("arrived_pickup", "pickup", 2), pts), V.stopPointFor(evOf("departed_delivery", "delivery", 1), pts), V.stopPointFor(evOf("arrived_pickup", "pickup", 1), null)], [null, null, null], "§1 other stops, or no points: none");

// ------------------------------------------------------------------ §2
section("§2  clean pings");
ok(V.isCleanPing(ping(1, AT_PICKUP)), "§2 a RouteMate ping with no dropped reason is clean");
ok(!V.isCleanPing(ping(1, AT_PICKUP, { source: "linxup" })), "§2 Linxup: never");
ok(!V.isCleanPing(ping(1, AT_PICKUP, { source: "" })), "§2 untagged (written before the source column): never");
ok(!V.isCleanPing(ping(1, AT_PICKUP, { dropped_reason: "speed_outlier" })), "§2 dropped: never");
ok(!V.isCleanPing(ping(1, { lat: NaN, lng: -93.62 })), "§2 no position: never");
ok(!V.isCleanPing(ping(1, { lat: 0, lng: 0 })), "§2 0,0: never");
ok(!V.isCleanPing(null), "§2 nothing: never");
for (const bad of [{ source: "linxup" }, { source: "" }, { dropped_reason: "invalid_coords" }]) {
	eq(verify({ pings: [ping(2, AT_PICKUP, bad)], latestPingMs: T + 20 * MIN }).verify, "unverified", `§2 a ping at the stop that is ${JSON.stringify(bad)} confirms nothing`);
}

// ------------------------------------------------------------------ §3
section("§3  arrivals");
eq(short(verify({ pings: [ping(3, AT_PICKUP)], latestPingMs: T + 3 * MIN, nowMs: T + 4 * MIN })), ["confirmed", T + 3 * MIN], "§3 a tap at the stop: confirmed as soon as the ping is in, with that ping");
eq(short(verify({ pings: [ping(-1, AT_PICKUP), ping(1, AT_PICKUP)], latestPingMs: T + MIN, nowMs: T + 2 * MIN })), ["confirmed", T + MIN], "§3 a geofence row: the ping after it confirms it");
eq(short(verify({ pings: [ping(15, NEAR_EDGE)], latestPingMs: T + 15 * MIN })), ["confirmed", T + 15 * MIN], "§3 the window's last minute and a ping 3 km out (inside the two-mile radius) still count");
const far = verify({ pings: [ping(2, FAR_285), ping(7, FAR_285), ping(12, FAR_285)], latestPingMs: T + 20 * MIN });
eq(far, { verify: "away", ping: null }, "§3 the 285-mile tap: held as away from the stop, with no position");
eq(verify({ pings: [ping(5, OUTSIDE)], latestPingMs: T + 20 * MIN }).verify, "away", "§3 5 km out: away");
eq(verify({ pings: [ping(-2, AT_PICKUP)], latestPingMs: T + 20 * MIN }).verify, "unverified", "§3 only a ping before the tap: no ping in the window, unverified");
eq(verify({ pings: [ping(16, AT_PICKUP)], latestPingMs: T + 16 * MIN }).verify, "unverified", "§3 a ping after the window: unverified");
eq(verify({ pings: [], latestPingMs: T + 20 * MIN }).verify, "unverified", "§3 no ping at all: unverified");
eq(verify({ event: "arrived_delivery", point: DROP, pings: [ping(4, AT_DROP)], latestPingMs: T + 4 * MIN }).verify, "confirmed", "§3 a drop arrival at the drop-off: confirmed");
eq(verify({ event: "arrived_delivery", point: DROP, pings: [ping(4, AT_PICKUP)], latestPingMs: T + 20 * MIN }).verify, "away", "§3 a drop arrival tapped at the shipper: away");

// ------------------------------------------------------------------ §4
section("§4  delivered");
const del = (over) => verify({ event: "delivered", point: DROP, ...over });
eq(del({ pings: [ping(-10, FAR_100), ping(0, FAR_100), ping(10, FAR_100)], latestPingMs: T + 20 * MIN }).verify, "away", "§4 a late Delivered tap far from the receiver: held as away");
eq(short(del({ pings: [ping(-12, AT_DROP), ping(-3, AT_DROP), ping(2, FAR_100)], latestPingMs: T + 2 * MIN, nowMs: T + 3 * MIN })), ["confirmed", T - 3 * MIN], "§4 at the receiver within 15 minutes either side: confirmed, with the ping nearest the event");
eq(del({ pings: [ping(-16, AT_DROP)], latestPingMs: T + 20 * MIN }).verify, "unverified", "§4 only before the window: unverified");

// ------------------------------------------------------------------ §5
section("§5  departures");
const dep = (over) => verify({ event: "departed_pickup", ...over });
eq(short(dep({ pings: [ping(-5, AT_PICKUP), ping(10, OUTSIDE, { speed: 20 })], latestPingMs: T + 10 * MIN, nowMs: T + 11 * MIN })), ["confirmed", T - 5 * MIN], "§5 inside before, moving outside after: confirmed, positioned at the pickup (never on the road)");
eq(dep({ pings: [ping(-5, AT_PICKUP), ping(5, AT_PICKUP), ping(10, AT_PICKUP), ping(25, AT_PICKUP)], latestPingMs: T + 40 * MIN }).verify, "unverified", "§5 an early In Transit while still parked at the shipper: held (no moving ping outside)");
eq(dep({ pings: [ping(-5, FAR_285), ping(10, FAR_285, { speed: 25 })], latestPingMs: T + 40 * MIN }).verify, "away", "§5 a departure tapped far from the pickup: away");
eq(dep({ pings: [ping(10, OUTSIDE, { speed: 20 })], latestPingMs: T + 40 * MIN }).verify, "unverified", "§5 no ping before: unverified");
eq(dep({ pings: [ping(-5, AT_PICKUP), ping(10, OUTSIDE, { speed: V.DEPART_SPEED_MPS })], latestPingMs: T + 40 * MIN }).verify, "unverified", "§5 exactly the moving speed is not moving (the geofence's > test)");
eq(dep({ pings: [ping(-5, AT_PICKUP), ping(10, AT_PICKUP, { speed: 20 })], latestPingMs: T + 40 * MIN }).verify, "unverified", "§5 moving but still inside the radius: not a departure");
eq(dep({ pings: [ping(-5, AT_PICKUP), ping(31, OUTSIDE, { speed: 20 })], latestPingMs: T + 31 * MIN }).verify, "unverified", "§5 moving outside only after 30 minutes: unverified");
eq(dep({ pings: [ping(-5, AT_PICKUP), ping(10, OUTSIDE, { speed: 20, source: "linxup" })], latestPingMs: T + 40 * MIN }).verify, "unverified", "§5 a Linxup ping never proves the departure");

// ------------------------------------------------------------------ §6
section("§6  no point, no device");
eq(verify({ point: null, pings: [ping(3, AT_PICKUP)], latestPingMs: T + 3 * MIN }), { verify: "not_mapped", ping: null }, "§6 no mapped point: not_mapped, at once");
eq(verify({ device: "", pings: [ping(3, AT_PICKUP)], latestPingMs: T + 3 * MIN }), { verify: "unverified", ping: null }, "§6 no truck or no device: unverified, at once");
eq(verify({ event: "departed_delivery", pings: [ping(3, AT_PICKUP)] }), { verify: "not_mapped", ping: null }, "§6 an event with no window: not_mapped");
eq(verify({ eventMs: NaN }), { verify: "unverified", ping: null }, "§6 no event time: unverified");
eq(V.HOLD_FOR, { away: "tap_away_from_stop", unverified: "tap_unverified", not_mapped: "stop_not_mapped" }, "§6 the hold reasons");

// ------------------------------------------------------------------ §7
section("§7  NL3: closing a window");
const lagged = { pings: [ping(2, FAR_285)] };
eq(verify({ ...lagged, latestPingMs: T + 2 * MIN, nowMs: T + 10 * MIN }).verify, "waiting", "§7 the window is still open: waiting");
eq(verify({ ...lagged, latestPingMs: T + 2 * MIN, nowMs: T + 15 * MIN + V.GRACE_MS - 1000 }).verify, "waiting", "§7 past its end but inside the grace, with no later ping: still waiting (a lagging feed)");
eq(verify({ ...lagged, latestPingMs: T + 16 * MIN, nowMs: T + 17 * MIN }).verify, "away", "§7 a ping later than the window's end has arrived: decided");
eq(verify({ ...lagged, latestPingMs: T + 2 * MIN, nowMs: T + 15 * MIN + V.GRACE_MS + 1000 }).verify, "away", "§7 the grace is over: decided");
eq(verify({ pings: [], latestPingMs: null, nowMs: T + 5 * MIN }).verify, "waiting", "§7 no ping yet: waiting");
eq(dep({ pings: [ping(-5, AT_PICKUP)], latestPingMs: T + 12 * MIN, nowMs: T + 12 * MIN }).verify, "waiting", "§7 a departure waits for its 30 minutes after");
ok(V.GRACE_MS >= 5 * MIN && V.GRACE_MS <= 15 * MIN, "§7 the grace is a short one (5-15 minutes)");

// ------------------------------------------------------------------ §8
section("§8  parity with server.js");
const SRC = require("./lib/server-source").serverSource();
const { closure } = require("./lib/server-lift");
const lifted = closure(SRC, { roots: ["resolveGeofencePoints"], provided: ["getLoadCoordsRow"] });
eq(lifted.names, ["resolveGeofencePoints"], "§8 resolveGeofencePoints() lifts on its own (getLoadCoordsRow() stubbed)");
let coordsRow = null;
const serverPoints = new Function("getLoadCoordsRow", `${lifted.text}\nreturn resolveGeofencePoints;`)(() => coordsRow);
const FIXTURES = [
	["sheet columns, all four", ["Load ID", "Pickup Lat", "Pickup Lng", "Drop-off Lat", "Drop-off Lng"], { "Pickup Lat": "42.0347", "Pickup Lng": "-93.62", "Drop-off Lat": "41.525", "Drop-off Lng": "-88.0817" }, "123456789", null],
	["origin and destination names", ["Origin Latitude", "Origin Longitude", "Destination Latitude", "Destination Longitude"], { "Origin Latitude": "40.1", "Origin Longitude": "-90.2", "Destination Latitude": "39.5", "Destination Longitude": "-91" }, "123456789", null],
	["shipper and receiver names", ["Shipper Lat", "Shipper Lon", "Receiver Lat", "Receiver Lon"], { "Shipper Lat": "35", "Shipper Lon": "-97", "Receiver Lat": "36", "Receiver Lon": "-98" }, "123456789", { origin_lat: 1, origin_lng: 2, dest_lat: 3, dest_lng: 4 }],
	["no sheet columns: the stored row", ["Load ID"], {}, "123456789", { origin_lat: 42.0347, origin_lng: -93.62, dest_lat: 41.525, dest_lng: -88.0817 }],
	["origin from the sheet, destination from the row", ["Pickup Lat", "Pickup Lng"], { "Pickup Lat": "42", "Pickup Lng": "-93" }, "123456789", { origin_lat: 1, origin_lng: 2, dest_lat: 41.5, dest_lng: -88 }],
	["unreadable cells fall back", ["Pickup Lat", "Pickup Lng", "Drop-off Lat", "Drop-off Lng"], { "Pickup Lat": "n/a", "Pickup Lng": "", "Drop-off Lat": "41.5", "Drop-off Lng": "x" }, "123456789", { origin_lat: 42, origin_lng: -93, dest_lat: null, dest_lng: null }],
	["a number with trailing text", ["Pickup Lat", "Pickup Lng"], { "Pickup Lat": "42.03abc", "Pickup Lng": " -93.6 " }, "123456789", null],
	["no load id: no fallback", ["Load ID"], {}, "", { origin_lat: 42, origin_lng: -93, dest_lat: 41, dest_lng: -88 }],
	["nothing at all", [], {}, "123456789", null],
	["a stored row with text values", ["Load ID"], {}, "123456789", { origin_lat: "42.5", origin_lng: "-93.5", dest_lat: "bad", dest_lng: "-88" }],
];
for (const [label, headers, row, loadId, stored] of FIXTURES) {
	coordsRow = stored;
	eq(V.stopPoints(row, headers, loadId ? stored : null), serverPoints(row, headers, loadId), `§8 stopPoints() = resolveGeofencePoints(): ${label}`);
}
const radiusLine = /\nconst GEOFENCE_RADIUS = Number\(process\.env\.GEOFENCE_RADIUS_M\) > 0\s*\?\s*Number\(process\.env\.GEOFENCE_RADIUS_M\)\s*:\s*([\d.]+);/.exec(SRC);
eq(radiusLine && Number(radiusLine[1]), tripWorkDays.DEFAULT_GEOFENCE_RADIUS_M, "§8 the default radius is GEOFENCE_RADIUS's (lib/trip-work-days.js reads it the same way)");
const departLine = /\nconst GEOFENCE_DEPART_SPEED_MPS = ([\d.]+);/.exec(SRC);
eq([V.DEPART_SPEED_MPS, departLine && Number(departLine[1]), tripWorkDays.DRIVING_MPS], [2.235, 2.235, 2.235], "§8 the moving speed is GEOFENCE_DEPART_SPEED_MPS");
ok(/geolib\.isPointWithinRadius\(here, origin, GEOFENCE_RADIUS\)/.test(SRC), "§8 the geofence tests a point with geolib.isPointWithinRadius()...");
const MOD = fs.readFileSync(path.join(ROOT, "lib", "chr-verify.js"), "utf8");
ok(/geolib\.isPointWithinRadius\(/.test(MOD), "§8 ...and so does chr-verify.js");
eq(V.PING_SQL.replace(/\s+/g, " "), "SELECT location_date_ms AS ms, latitude AS lat, longitude AS lng, speed, source, dropped_reason FROM routemate_telemetry WHERE routemate_vehicle_id = ? AND location_date_ms >= ? AND location_date_ms <= ? AND source = 'routemate' AND dropped_reason = '' ORDER BY location_date_ms ASC", "§8 the ping read: named columns, RouteMate rows with no dropped reason");
eq(V.LATEST_PING_SQL.replace(/\s+/g, " "), "SELECT MAX(location_date_ms) AS ms FROM routemate_telemetry WHERE routemate_vehicle_id = ? AND source = 'routemate' AND dropped_reason = ''", "§8 the newest clean ping, for NL3");
ok(/CREATE INDEX IF NOT EXISTS idx_rm_tel_vid_date ON routemate_telemetry\(routemate_vehicle_id, location_date_ms DESC\)/.test(SRC), "§8 both reads run on server.js's (vehicle, time) index");
for (const col of ["latitude REAL", "longitude REAL", "speed REAL", "location_date_ms INTEGER"]) ok(SRC.includes(`\t\t${col}`), `§8 routemate_telemetry still has ${col}`);
ok(/ALTER TABLE routemate_telemetry ADD COLUMN dropped_reason TEXT DEFAULT ''/.test(SRC) && /ALTER TABLE routemate_telemetry ADD COLUMN source TEXT DEFAULT ''/.test(SRC), "§8 ...and dropped_reason and source, both '' by default");
ok(/speedMps: t\.speed,/.test(SRC), "§8 a RouteMate row's speed is m/s (the sync hands it to the geofence as speedMps)");

// ------------------------------------------------------------------ §9
section("§9  the module stays pure");
const requires = [...MOD.matchAll(/require\(\s*["']([^"']{1,80})["']\s*\)/g)].map((m) => m[1]).sort();
eq(requires, ["./trip-work-days", "geolib"], "§9 it requires only geolib and lib/trip-work-days.js");
ok(!/\bfs\.|\bprocess\b|\bfetch\(|Date\.now\(\)|new Date\(\)|\.prepare\(/.test(MOD), "§9 no files, environment, network, clock or database");

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
