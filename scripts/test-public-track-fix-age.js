#!/usr/bin/env node
/**
 * GET /api/public/track/:loadId and the age of the truck's last fix (B11, owner
 * decision 2026-10-15): the customer tracking link shows no distance and no
 * ETA from a fix older than 2 hours, and the page is sent the fix time so it
 * can say "Last seen X ago".
 *
 * The route is lifted whole from server.js (scripts/lib/server-lift.js) and run
 * against an in-memory database, a fake Job Tracking sheet and a fake router.
 *
 *   §1 an ELD fix 10 minutes old: the ETA and the remaining distance, routed
 *      from the fix; lastPing.at is the fix time as an ISO instant
 *   §2 just under 2 hours: still an ETA
 *   §3 2 h 30 min (still inside the 3-hour window that sends a position): the
 *      position and its time are sent, but no `eta`, no distanceMiles and no
 *      etaMinutes beside the line; the router is never asked for the fix's leg
 *   §4 a phone fix stored with an offset ("...-04:00") is sent as the same
 *      instant in ISO (…Z), so every browser reads its age the same way
 *   §5 no fix within 2 hours at all (none on record, or a truck silent past the
 *      3-hour window): no distance, no drive time and no ETA, not even the
 *      planned lane's; the lane is still drawn
 *   §6 unchanged: a delivered load has no ETA
 *
 * Hermetic: in-memory SQLite, made-up loads; no network.
 *   node scripts/test-public-track-fix-age.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const { closure } = require("./lib/server-lift");

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
const geolib = require("geolib");

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
	if (cond) { passed++; return; }
	failures.push(name);
	console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const MIN = 60 * 1000;
const PROVIDED = ["app", "db", "getSheets", "SPREADSHEET_ID", "getRoute", "findTruckForDriverStamp", "computeStatusPhases", "geolib", "trackPublicLimiter"];
const lifted = closure(SRC, {
	routes: ['app.get("/api/public/track/:loadId", trackPublicLimiter, async (req, res) => {'],
	provided: PROVIDED,
	denied: ["server", "io", "transporter", "sendEmail"],
});

const HEADERS = ["Load ID", "Status", "Driver", "Pickup Address", "Drop-off Address", "Origin Lat", "Origin Lng", "Dest Lat", "Dest Lng", "Delivery Date"];
function world({ status = "In Transit", eldAgeMs = null, phoneAt = null }) {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE load_coordinates (load_id TEXT PRIMARY KEY, pickup_address TEXT, dropoff_address TEXT, origin_lat REAL, origin_lng REAL, dest_lat REAL, dest_lng REAL);
		CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY, routemate_vehicle_id TEXT, latitude REAL, longitude REAL, speed REAL, location_date_ms INTEGER, dropped_reason TEXT DEFAULT '');
		CREATE TABLE driver_locations (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
			accuracy REAL DEFAULT 0, speed REAL DEFAULT 0, heading REAL DEFAULT 0, timestamp TEXT NOT NULL, load_id TEXT DEFAULT '');
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY, load_id TEXT, new_status TEXT, changed_at TEXT);
	`);
	const fixMs = eldAgeMs == null ? null : Date.now() - eldAgeMs;
	if (fixMs != null) db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, location_date_ms) VALUES ('V-1', 31.2, -92.1, 25, ?)").run(fixMs);
	if (phoneAt) db.prepare("INSERT INTO driver_locations (driver, latitude, longitude, speed, timestamp) VALUES ('driver a', 31.3, -92.0, 20, ?)").run(phoneAt);
	const routeCalls = [];
	const getRoute = async (from, to) => {
		routeCalls.push([from, to]);
		const fromPickup = from.latitude === 29.7 && from.longitude === -95.3;
		return { points: [{ latitude: from.latitude, longitude: from.longitude }, { latitude: to.latitude, longitude: to.longitude }], distanceMiles: fromPickup ? 812.4 : 210.5, durationMin: fromPickup ? 750 : 205 };
	};
	const row = ["T-100", status, "Driver A", "Town A, TX 77001", "Town B, GA 30301", "29.7", "-95.3", "33.7", "-84.4", ""];
	const getSheets = async () => ({ spreadsheets: { values: { batchGet: async () => ({ data: { valueRanges: [{ values: [HEADERS, row] }] } }) } } });
	const routes = {};
	const app = { get(p, ...h) { routes[p] = h[h.length - 1]; } };
	const deps = {
		app, db, getSheets, SPREADSHEET_ID: "sheet-test", getRoute,
		findTruckForDriverStamp: () => ({ routemate_vehicle_id: "V-1", unit_number: "101" }),
		computeStatusPhases: () => [], geolib, trackPublicLimiter: (req, res, next) => next(),
	};
	new Function(...PROVIDED, "require", lifted.text)(...PROVIDED.map((k) => deps[k]), require);
	const handler = routes["/api/public/track/:loadId"];
	return {
		routeCalls, fixMs,
		async call() {
			const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
			await handler({ params: { loadId: "T-100" } }, res);
			return res;
		},
	};
}

(async () => {
	console.log("§1 a 10-minute ELD fix");
	{
		const w = world({ eldAgeMs: 10 * MIN });
		const r = await w.call();
		const b = r.body || {};
		ok("§1 200 with an ETA routed from the fix", r.statusCode === 200 && b.eta && b.eta.distanceMiles === 210.5 && b.eta.minutesRemaining === 205, b.eta);
		ok("§1 the figures beside the line are the remaining leg", b.distanceMiles === 210.5 && b.etaMinutes === 205, [b.distanceMiles, b.etaMinutes]);
		ok("§1 lastPing.at is the fix time as an ISO instant", b.lastPing && b.lastPing.at === new Date(w.fixMs).toISOString(), b.lastPing);
	}
	console.log("§2 just under 2 hours");
	{
		const r = await world({ eldAgeMs: 2 * 60 * MIN - MIN }).call();
		ok("§2 1 h 59 min: still an ETA", !!(r.body && r.body.eta) && r.body.distanceMiles === 210.5, r.body && r.body.eta);
	}
	console.log("§3 2 h 30 min");
	{
		const w = world({ eldAgeMs: 150 * MIN });
		const r = await w.call();
		const b = r.body || {};
		ok("§3 the position and its time are still sent (inside the 3-hour window)", b.lastPing && b.lastPing.at === new Date(w.fixMs).toISOString(), b.lastPing);
		ok("§3 no ETA", b.eta === null, b.eta);
		ok("§3 no distance and no ETA minutes beside the line", b.distanceMiles === null && b.etaMinutes === null, [b.distanceMiles, b.etaMinutes]);
		ok("§3 the lane is still drawn", Array.isArray(b.route) && b.route.length === 2);
		ok("§3 the router is asked for the lane only, never the old fix's leg",
			w.routeCalls.length >= 1 && w.routeCalls.every(([from]) => from.latitude === 29.7 && from.longitude === -95.3), w.routeCalls);
	}
	console.log("§4 a phone fix stored with an offset");
	{
		const stamp = new Date(Date.now() - 20 * MIN);
		const local = new Date(stamp.getTime() - 4 * 60 * MIN).toISOString().slice(0, 19);
		const r = await world({ phoneAt: `${local}-04:00` }).call();
		const b = r.body || {};
		ok("§4 sent as the same instant in ISO", b.lastPing && b.lastPing.at === new Date(Math.floor(stamp.getTime() / 1000) * 1000).toISOString(), [b.lastPing, `${local}-04:00`]);
		ok("§4 a 20-minute phone fix still gives an ETA", !!b.eta);
	}
	console.log("§5 no fix within 2 hours at all");
	{
		const r = await world({}).call();
		const b = r.body || {};
		ok("§5 no fix: no lastPing, no ETA, and no distance or drive time from the planned lane either",
			b.lastPing === null && b.eta === null && b.distanceMiles === null && b.etaMinutes === null, [b.lastPing, b.eta, b.distanceMiles, b.etaMinutes]);
		ok("§5 ...the lane is still drawn", Array.isArray(b.route) && b.route.length === 2);
		const silent = await world({ eldAgeMs: 4 * 60 * MIN }).call();
		const s = silent.body || {};
		ok("§5 an In Transit truck silent for 4 hours (no position sent): no distance, no drive time, no ETA",
			s.lastPing === null && s.eta === null && s.distanceMiles === null && s.etaMinutes === null, [s.lastPing, s.eta, s.distanceMiles, s.etaMinutes]);
	}
	console.log("§6 unchanged");
	{
		const d = await world({ status: "Delivered", eldAgeMs: 10 * MIN }).call();
		ok("§6 a delivered load: no ETA", d.body && d.body.eta === null);
	}
})().then(() => {
	if (failures.length) {
		console.error(`\n${passed} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\n${passed} passed, 0 failed`);
}).catch((e) => {
	console.error(`FAILED: ${e && e.stack ? e.stack : e}`);
	process.exit(1);
});
