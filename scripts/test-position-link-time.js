#!/usr/bin/env node
/**
 * B11 (2026-10-16): a truck's position is never a fix its ELD device took
 * before it was linked to that truck, and no paid route is asked from a fix
 * older than 2 hours.
 *
 * On 2026-09-28 a truck was linked to a tracker that had sat parked in another
 * state since August. Its newest fix, 13 days old, was then served as the
 * truck's live position (the 14-day window), 1,010 mi from the load. The link
 * time is the assigned_from of the truck's open eld_device_assignments row for
 * that device; a row the history seed or the boot reconcile opened carries the
 * moment recording began or drift was noticed, not a link time, so it counts
 * as unknown, and an unknown link time keeps today's answer (the 14-day and
 * 3-hour windows still bound it).
 *
 *   §1 lib/eld-position.js: linkedSinceMs(), fixPredatesLink(), the 2-hour ETA
 *      rule, equal to the browser's (client/src/lib/fixAge.js)
 *   §2 GET /api/locations/latest: a device linked 10 minutes ago whose newest
 *      fix is 13 days old: no position; a fix after the link: shown; a seed or
 *      boot row, or no row: shown as before; the heading never comes from a fix
 *      before the link
 *   §3 GET /api/driver/position: the same rule, the same cases
 *   §4 GET /api/public/track/:loadId: the same rule inside its 3-hour window
 *   §5 GET /api/locations/latest asks the router nothing from a fix over 2
 *      hours old (neither the drop-off leg nor the pickup leg), and leaves its
 *      distance, ETA and verdict empty; a fresher fix is routed as before
 *   §6 GET /api/locations/trail: no point from before the link; a last point
 *      over 2 hours old is not routed from (the planned lane is)
 *   §7 approachStopsFor() (fuel stops on the run to the shipper, billed Routes
 *      and Places calls): never searched around a fix from before the link
 *
 * The routes are lifted whole from server.js (scripts/lib/server-lift.js), with
 * the shipped eld_device_assignments DDL and telemetry indexes, and run against
 * an in-memory database, a fake Job Tracking sheet and a router stub that
 * counts its calls. Made-up drivers, trucks and places; no network.
 *   node scripts/test-position-link-time.js    # exits 1 on failure
 *   SERVER_JS=/path/to/base/server.js node scripts/test-position-link-time.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const SERVER_JS = process.env.SERVER_JS || path.join(ROOT, "server.js");
const SRC = fs.readFileSync(SERVER_JS, "utf8");
const { closure } = require("./lib/server-lift");
// The lifted code's own require()s ("./lib/…") resolve from the server.js under test.
const appRequire = require("module").createRequire(SERVER_JS);

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
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function shippedSql(re, label) {
	const m = SRC.match(re);
	if (!m || m.length !== 1) throw new Error(`expected exactly 1 ${label} in server.js, found ${m ? m.length : 0}`);
	return m[0];
}
const HISTORY_DDL = shippedSql(/CREATE TABLE IF NOT EXISTS eld_device_assignments \([\s\S]*?\n\t\)/g, "eld_device_assignments DDL");
const TELEMETRY_IDX = [
	/CREATE INDEX IF NOT EXISTS idx_rm_tel_vid_date ON routemate_telemetry\([^)]*\)/g,
	/CREATE INDEX IF NOT EXISTS idx_rm_tel_clean ON routemate_telemetry\([^)]*\)/g,
].map((re, i) => shippedSql(re, `routemate_telemetry index #${i + 1}`));

const ROUTES = {
	latest: 'app.get("/api/locations/latest", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
	driver: 'app.get(["/api/driver/position", "/api/driver/me/position"], requireRole("Driver", "Super Admin"), driverPositionLimiter, (req, res) => {',
	track: 'app.get("/api/public/track/:loadId", trackPublicLimiter, async (req, res) => {',
	trail: 'app.get("/api/locations/trail", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
};
const PROVIDED = [
	"app", "db", "getSheets", "SPREADSHEET_ID", "getRoute", "geolib", "requireRole",
	"driverPositionLimiter", "trackPublicLimiter", "findTruckForDriverStamp", "computeStatusPhases", "geocodeReverse",
	"getJobTrackingCached", "poiFuelStops", "GOOGLE_MAPS_API_KEY",
];
const lifted = closure(SRC, {
	roots: ["approachStopsFor"],
	routes: Object.values(ROUTES),
	provided: PROVIDED,
	denied: ["server", "io", "transporter", "sendEmail"],
});

// The world: one driver, "Driver A", on truck #7 (LogisX-#901), which carries
// device DEV-901. The load runs from a pickup near 29.70,-95.30 to a drop-off
// near 32.75,-96.90. "Away" is a spot ~1,000 mi off, where the device sat
// before the link.
const TRUCK_ID = 7;
const DEVICE = "DEV-901";
const DRIVER = "Driver A";
const PICKUP = { lat: 29.7, lng: -95.3 };
const DROP = { lat: 32.75, lng: -96.9 };
const AWAY = { lat: 26.5, lng: -81.5 };
const NEAR = { lat: 30.4, lng: -95.6 };
const HEADERS = ["Load ID", "Job Status", "Driver", "Pickup Address", "Drop-off Address", "Origin Lat", "Origin Lng", "Dest Lat", "Dest Lng"];

// fixes: [{ ago, at: {lat,lng}, bearing }], oldest first, so the newest is the
// highest id, as the routes read it. link: null (no row), or { ago, by }.
function world({ fixes = [], link = null, status = "In Transit" } = {}) {
	const now = Date.now();
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT);
		CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, routemate_vehicle_id TEXT DEFAULT '', assigned_driver TEXT DEFAULT '',
			fuel_tank_gallons REAL DEFAULT 0, avg_mpg REAL DEFAULT 0, owner_id INTEGER DEFAULT 0);
		CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT DEFAULT '', end_date TEXT DEFAULT '');
		CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT NOT NULL, latitude REAL, longitude REAL,
			speed REAL DEFAULT 0, bearing TEXT DEFAULT '', odometer REAL DEFAULT 0, engine_hours REAL DEFAULT 0, fuel_pct INTEGER,
			geocoded_location TEXT DEFAULT '', location_date_ms INTEGER DEFAULT 0, dropped_reason TEXT DEFAULT '', source TEXT DEFAULT '');
		CREATE TABLE load_coordinates (load_id TEXT PRIMARY KEY, pickup_address TEXT, dropoff_address TEXT, origin_lat REAL, origin_lng REAL, dest_lat REAL, dest_lng REAL);
		CREATE TABLE driver_locations (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
			accuracy REAL DEFAULT 0, speed REAL DEFAULT 0, heading REAL DEFAULT 0, timestamp TEXT NOT NULL, load_id TEXT DEFAULT '');
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY, load_id TEXT, new_status TEXT, changed_at TEXT);
	`);
	for (const sql of [HISTORY_DDL, ...TELEMETRY_IDX]) db.exec(sql);
	db.prepare("INSERT INTO drivers_directory (driver_name) VALUES (?)").run(DRIVER);
	db.prepare("INSERT INTO trucks (id, unit_number, routemate_vehicle_id, assigned_driver) VALUES (?, ?, ?, ?)").run(TRUCK_ID, "LogisX-#901", DEVICE, DRIVER);
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, ?, '')").run(TRUCK_ID, DRIVER, new Date(now - 3 * DAY).toISOString());
	const tel = db.prepare(`INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, bearing, engine_hours, geocoded_location, location_date_ms, source)
		VALUES (?, ?, ?, ?, ?, 0, '', ?, 'linxup')`);
	const fixMs = fixes.map((f) => now - f.ago);
	fixes.forEach((f, i) => tel.run(DEVICE, f.at.lat, f.at.lng, f.speed || 0, f.bearing || "", fixMs[i]));
	if (link) {
		db.prepare(`INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from, assigned_until, assigned_by)
			VALUES (?, ?, ?, '', ?)`).run(TRUCK_ID, DEVICE, new Date(now - link.ago).toISOString(), link.by);
	}

	const row = ["T-200", status, DRIVER, "Town A, TX 77001", "Town B, TX 75201", String(PICKUP.lat), String(PICKUP.lng), String(DROP.lat), String(DROP.lng)];
	const sheet = { values: [HEADERS, row] };
	const getSheets = async () => ({
		spreadsheets: {
			values: {
				get: async ({ range }) => ({ data: { values: /!1:1$/.test(range) ? [HEADERS] : sheet.values } }),
				batchGet: async () => ({ data: { valueRanges: [{ values: sheet.values }] } }),
			},
		},
	});
	const routeCalls = [];
	const getRoute = async (from, to) => {
		routeCalls.push([from, to]);
		return { points: [{ latitude: from.latitude, longitude: from.longitude }, { latitude: to.latitude, longitude: to.longitude }], distanceMiles: 321.5, durationMin: 300 };
	};
	const poiCalls = [];
	const handlers = {};
	const register = (p, ...h) => { for (const one of [].concat(p)) handlers[one] = h[h.length - 1]; };
	const deps = {
		app: { get: register }, db, getSheets, SPREADSHEET_ID: "sheet-test", getRoute, geolib,
		requireRole: () => (req, res, next) => next(), driverPositionLimiter: null, trackPublicLimiter: null,
		findTruckForDriverStamp: () => ({ id: TRUCK_ID, routemate_vehicle_id: DEVICE, unit_number: "LogisX-#901" }),
		computeStatusPhases: () => [], geocodeReverse: async () => "",
		getJobTrackingCached: async () => ({ headers: HEADERS, data: [Object.fromEntries(HEADERS.map((h, i) => [h, row[i]]))] }),
		poiFuelStops: { findFuelStopsAlongRoute: async (o) => { poiCalls.push(o); return [{ name: "Stop 1", dieselPrice: 3.49, aboutMilesFromRoute: 1 }]; } },
		GOOGLE_MAPS_API_KEY: "test-key",
	};
	const fns = new Function(...PROVIDED, "require", `${lifted.text}\nreturn { approachStopsFor };`)(...PROVIDED.map((k) => deps[k]), appRequire);
	const call = async (route, req) => {
		const res = { statusCode: 200, body: null, setHeader() {}, set() { return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
		await handlers[route]({ params: {}, query: {}, body: {}, headers: {}, ...req }, res);
		return res;
	};
	return {
		fixMs, routeCalls, poiCalls,
		approach: () => fns.approachStopsFor("T-200", PICKUP.lat, PICKUP.lng),
		latest: async () => {
			const r = await call("/api/locations/latest", { session: { user: { role: "Super Admin", username: "admin_test" } } });
			return { res: r, loc: ((r.body && r.body.locations) || []).find((l) => l.driver === DRIVER) || null };
		},
		driver: async () => (await call("/api/driver/position", { session: { user: { role: "Driver", driverName: DRIVER } } })),
		track: async () => (await call("/api/public/track/:loadId", { params: { loadId: "T-200" } })),
		trail: async () => (await call("/api/locations/trail", { query: { driver: DRIVER, loadId: "T-200" } })),
	};
}
const iso = (ms) => new Date(ms).toISOString();
const fromFix = (call, at) => call[0].latitude === at.lat && call[0].longitude === at.lng;

(async () => {
	// ══ §1 the rule ══════════════════════════════════════════════════════════
	console.log("§1 lib/eld-position.js");
	let rule = null;
	try { rule = appRequire("./lib/eld-position"); } catch { rule = null; }
	ok("§1 lib/eld-position.js exists", !!rule);
	if (rule) {
		const at = "2026-09-28T17:39:15.000Z";
		const atMs = Date.parse(at);
		ok("§1 a link a person made: its time", rule.linkedSinceMs({ assigned_from: at, assigned_by: "admin_test" }) === atMs);
		ok("§1 ...a link the route recorded with no user name still has its time", rule.linkedSinceMs({ assigned_from: at, assigned_by: "" }) === atMs);
		ok("§1 the history seed's row: unknown (it carries when recording began)", rule.linkedSinceMs({ assigned_from: at, assigned_by: "system:seed" }) === null);
		ok("§1 the boot reconcile's row: unknown (it carries when drift was noticed)", rule.linkedSinceMs({ assigned_from: at, assigned_by: "system:boot" }) === null);
		ok("§1 no row, or a time that can't be read: unknown",
			rule.linkedSinceMs(null) === null && rule.linkedSinceMs(undefined) === null && rule.linkedSinceMs({ assigned_from: "", assigned_by: "x" }) === null
			&& rule.linkedSinceMs({ assigned_from: "not a time", assigned_by: "x" }) === null);
		ok("§1 a fix before the link predates it; one at the link or after does not",
			rule.fixPredatesLink(atMs - 1, atMs) === true && rule.fixPredatesLink(atMs, atMs) === false && rule.fixPredatesLink(atMs + 1, atMs) === false);
		ok("§1 an unknown link time hides nothing", rule.fixPredatesLink(atMs - DAY, null) === false);
		ok("§1 a fix with no readable time, beside a known link, is not shown", rule.fixPredatesLink(NaN, atMs) === true && rule.fixPredatesLink(null, atMs) === true);
		ok("§1 the ETA rule: 2 hours", rule.ETA_MAX_FIX_AGE_MS === 2 * HOUR);
		ok("§1 a fix of 2 hours or less allows an ETA; a millisecond more, or an unknown age, does not",
			rule.fixAllowsEta(0) === true && rule.fixAllowsEta(2 * HOUR) === true && rule.fixAllowsEta(2 * HOUR + 1) === false
			&& rule.fixAllowsEta(null) === false && rule.fixAllowsEta(NaN) === false);
		let client = null;
		try { client = await import(pathToFileURL(path.join(path.dirname(SERVER_JS), "client", "src", "lib", "fixAge.js")).href); } catch { client = null; }
		ok("§1 ...the same 2 hours the browser hides distance and ETA after (client/src/lib/fixAge.js)",
			!!client && client.NO_ETA_AFTER_MS === rule.ETA_MAX_FIX_AGE_MS);
	}

	// ══ §2 GET /api/locations/latest ═════════════════════════════════════════
	console.log("§2 GET /api/locations/latest");
	{
		const w = world({ fixes: [{ ago: 13 * DAY, at: AWAY }], link: { ago: 10 * MIN, by: "admin_test" } });
		const { res, loc } = await w.latest();
		ok("§2 200", res.statusCode === 200, res.body);
		ok("§2 linked 10 minutes ago, newest fix 13 days old: no position (the B11 case)",
			!!loc && loc.latitude === null && loc.longitude === null && loc.source === "none" && loc.noGps === true, loc);
		ok("§2 ...and nothing is routed from it", w.routeCalls.length === 0, w.routeCalls);
	}
	{
		const w = world({ fixes: [{ ago: 13 * DAY, at: AWAY }, { ago: 5 * MIN, at: NEAR }], link: { ago: 10 * MIN, by: "admin_test" } });
		const { loc } = await w.latest();
		ok("§2 the device's first fix after the link is shown",
			!!loc && loc.latitude === NEAR.lat && loc.longitude === NEAR.lng && loc.timestamp === iso(w.fixMs[1]) && loc.noGps === false, loc);
	}
	for (const by of ["system:seed", "system:boot"]) {
		const w = world({ fixes: [{ ago: 13 * DAY, at: AWAY }], link: { ago: 10 * MIN, by } });
		const { loc } = await w.latest();
		ok(`§2 a ${by} row (no real link time): the fix is shown as before`, !!loc && loc.latitude === AWAY.lat && loc.noGps === false, loc);
	}
	{
		const w = world({ fixes: [{ ago: 13 * DAY, at: AWAY }] });
		const { loc } = await w.latest();
		ok("§2 no link row at all: the fix is shown as before", !!loc && loc.latitude === AWAY.lat && loc.noGps === false, loc);
	}
	{
		const w = world({ fixes: [{ ago: 15 * DAY, at: AWAY }] });
		const { loc } = await w.latest();
		ok("§2 unchanged: a fix over 14 days old is not shown", !!loc && loc.latitude === null && loc.noGps === true, loc);
	}
	{
		// The newest fix (after the link) has no bearing; the one before it is the
		// device's last fix before the link, far away. The arrow must not point
		// along the line between the two.
		const w = world({ fixes: [{ ago: 3 * HOUR, at: AWAY }, { ago: 5 * MIN, at: NEAR }], link: { ago: 1 * HOUR, by: "admin_test" } });
		const { loc } = await w.latest();
		ok("§2 the heading is not taken from a fix before the link", !!loc && loc.latitude === NEAR.lat && loc.heading === 0, loc && loc.heading);
		const w2 = world({ fixes: [{ ago: 30 * MIN, at: PICKUP }, { ago: 5 * MIN, at: NEAR }], link: { ago: 1 * HOUR, by: "admin_test" } });
		const { loc: loc2 } = await w2.latest();
		ok("§2 ...a fix after the link still gives one (the rule is not vacuous)", !!loc2 && loc2.heading !== 0, loc2 && loc2.heading);
	}

	// ══ §3 GET /api/driver/position ══════════════════════════════════════════
	console.log("§3 GET /api/driver/position");
	{
		const r = await world({ fixes: [{ ago: 13 * DAY, at: AWAY }], link: { ago: 10 * MIN, by: "admin_test" } }).driver();
		ok("§3 linked 10 minutes ago, newest fix 13 days old: no position", r.statusCode === 200 && r.body && r.body.ok === true && r.body.position === null, r.body);
		ok("§3 ...with the truck's unit and a reason", r.body && r.body.unit === "LogisX-#901" && typeof r.body.reason === "string" && r.body.reason !== "", r.body);
	}
	{
		const w = world({ fixes: [{ ago: 13 * DAY, at: AWAY }, { ago: 5 * MIN, at: NEAR }], link: { ago: 10 * MIN, by: "admin_test" } });
		const r = await w.driver();
		const p = (r.body && r.body.position) || {};
		ok("§3 a fix after the link is shown", p.latitude === NEAR.lat && p.timestamp === iso(w.fixMs[1]), r.body);
		ok("§3 ...and its heading is not taken from the fix before the link", p.heading === null, p.heading);
	}
	{
		const r = await world({ fixes: [{ ago: 13 * DAY, at: AWAY }], link: { ago: 10 * MIN, by: "system:seed" } }).driver();
		ok("§3 a seed row: shown as before", r.body && r.body.position && r.body.position.latitude === AWAY.lat, r.body);
		const r2 = await world({ fixes: [{ ago: 13 * DAY, at: AWAY }] }).driver();
		ok("§3 no link row: shown as before", r2.body && r2.body.position && r2.body.position.latitude === AWAY.lat, r2.body);
	}

	// ══ §4 GET /api/public/track/:loadId ═════════════════════════════════════
	console.log("§4 GET /api/public/track/:loadId");
	{
		const w = world({ fixes: [{ ago: 60 * MIN, at: AWAY }], link: { ago: 30 * MIN, by: "admin_test" } });
		const r = await w.track();
		ok("§4 200", r.statusCode === 200, r.body);
		ok("§4 a fix taken 30 minutes before the link (inside the 3-hour window): no position, no ETA",
			r.body && r.body.lastPing === null && r.body.eta === null, r.body && [r.body.lastPing, r.body.eta]);
		ok("§4 ...and the router is asked for the lane only", w.routeCalls.every((c) => fromFix(c, PICKUP)), w.routeCalls);
	}
	{
		const w = world({ fixes: [{ ago: 60 * MIN, at: AWAY }, { ago: 10 * MIN, at: NEAR }], link: { ago: 30 * MIN, by: "admin_test" } });
		const r = await w.track();
		ok("§4 a fix after the link: shown, with an ETA", r.body && r.body.lastPing && r.body.lastPing.lat === NEAR.lat && !!r.body.eta, r.body && r.body.lastPing);
	}
	{
		const r = await world({ fixes: [{ ago: 60 * MIN, at: AWAY }], link: { ago: 30 * MIN, by: "system:boot" } }).track();
		ok("§4 a boot row: shown as before", r.body && r.body.lastPing && r.body.lastPing.lat === AWAY.lat, r.body && r.body.lastPing);
		const r2 = await world({ fixes: [{ ago: 60 * MIN, at: AWAY }] }).track();
		ok("§4 no link row: shown as before", r2.body && r2.body.lastPing && r2.body.lastPing.lat === AWAY.lat, r2.body && r2.body.lastPing);
	}

	// ══ §5 no paid route from a fix over 2 hours old ═════════════════════════
	console.log("§5 GET /api/locations/latest and the router");
	{
		const w = world({ fixes: [{ ago: 3 * HOUR, at: NEAR }] });
		const { loc } = await w.latest();
		ok("§5 an In Transit truck whose fix is 3 hours old: the position is still served", !!loc && loc.latitude === NEAR.lat, loc);
		ok("§5 ...the router is never asked from that fix", w.routeCalls.length === 0, w.routeCalls);
		ok("§5 ...and no distance, ETA or on-time verdict is sent", !!loc && loc.etaMinutes === null && loc.distanceMiles === null && loc.etaStatus === "unknown",
			loc && [loc.etaMinutes, loc.distanceMiles, loc.etaStatus]);
	}
	{
		const w = world({ fixes: [{ ago: 3 * HOUR, at: NEAR }], status: "Dispatched" });
		const { loc } = await w.latest();
		ok("§5 a Dispatched truck whose fix is 3 hours old: no pickup leg asked either", w.routeCalls.length === 0, w.routeCalls);
		ok("§5 ...and no pickup distance or ETA", !!loc && loc.pickupEtaMinutes == null && loc.pickupDistanceMiles == null, loc && [loc.pickupEtaMinutes, loc.pickupDistanceMiles]);
	}
	{
		const w = world({ fixes: [{ ago: 2 * HOUR - MIN, at: NEAR }] });
		const { loc } = await w.latest();
		ok("§5 1 h 59 min: routed from the fix to the drop-off, as before",
			w.routeCalls.length === 1 && fromFix(w.routeCalls[0], NEAR) && !!loc && loc.etaMinutes === 300 && loc.distanceMiles === 321.5, [w.routeCalls, loc && loc.etaMinutes]);
		const p = world({ fixes: [{ ago: 2 * HOUR - MIN, at: NEAR }], status: "Dispatched" });
		const { loc: pl } = await p.latest();
		ok("§5 ...and a Dispatched truck's pickup leg too", p.routeCalls.length === 2 && p.routeCalls.every((c) => fromFix(c, NEAR)) && !!pl && pl.pickupEtaMinutes === 300,
			p.routeCalls);
	}

	// ══ §6 GET /api/locations/trail ══════════════════════════════════════════
	console.log("§6 GET /api/locations/trail");
	{
		const w = world({
			fixes: [{ ago: 5 * HOUR, at: AWAY }, { ago: 3 * HOUR, at: { lat: 26.9, lng: -81.9 } }, { ago: 30 * MIN, at: PICKUP }, { ago: 10 * MIN, at: NEAR }],
			link: { ago: 1 * HOUR, by: "admin_test" },
		});
		const r = await w.trail();
		const lats = ((r.body && r.body.trail) || []).map((p) => p.latitude);
		ok("§6 200", r.statusCode === 200, r.body);
		ok("§6 the trail holds only the fixes taken since the link", JSON.stringify(lats) === JSON.stringify([PICKUP.lat, NEAR.lat]), lats);
		ok("§6 ...and the route runs from the newest of them", w.routeCalls.length >= 1 && fromFix(w.routeCalls[0], NEAR), w.routeCalls);
	}
	{
		const w = world({ fixes: [{ ago: 5 * HOUR, at: AWAY }, { ago: 3 * HOUR, at: NEAR }] });
		const r = await w.trail();
		const lats = ((r.body && r.body.trail) || []).map((p) => p.latitude);
		ok("§6 no link row: the day's trail as before", JSON.stringify(lats) === JSON.stringify([AWAY.lat, NEAR.lat]), lats);
		ok("§6 a last point 3 hours old is not routed from: the planned pickup-to-drop-off lane is",
			w.routeCalls.length === 1 && fromFix(w.routeCalls[0], PICKUP), w.routeCalls);
	}
	{
		const w = world({ fixes: [{ ago: 5 * HOUR, at: AWAY }, { ago: 10 * MIN, at: NEAR }], link: { ago: 1 * HOUR, by: "system:seed" } });
		const r = await w.trail();
		const lats = ((r.body && r.body.trail) || []).map((p) => p.latitude);
		ok("§6 a seed row: the trail before it is kept", JSON.stringify(lats) === JSON.stringify([AWAY.lat, NEAR.lat]), lats);
	}

	// ══ §7 fuel stops on the run to the shipper ══════════════════════════════
	console.log("§7 approachStopsFor()");
	{
		const w = world({ fixes: [{ ago: 60 * MIN, at: NEAR }], link: { ago: 30 * MIN, by: "admin_test" }, status: "Dispatched" });
		const stops = await w.approach();
		ok("§7 a fix taken before the link (inside the 6-hour window): no stops, and no Routes or Places call",
			Array.isArray(stops) && stops.length === 0 && w.routeCalls.length === 0 && w.poiCalls.length === 0, [stops, w.routeCalls, w.poiCalls.length]);
	}
	{
		const w = world({ fixes: [{ ago: 60 * MIN, at: AWAY }, { ago: 10 * MIN, at: NEAR }], link: { ago: 30 * MIN, by: "admin_test" }, status: "Dispatched" });
		const stops = await w.approach();
		ok("§7 a fix after the link: stops searched from it, as before",
			stops.length === 1 && w.routeCalls.length === 1 && fromFix(w.routeCalls[0], NEAR) && w.poiCalls.length === 1 && w.poiCalls[0].originLat === NEAR.lat,
			[stops.length, w.routeCalls, w.poiCalls.length]);
	}
	{
		const w = world({ fixes: [{ ago: 60 * MIN, at: NEAR }], status: "Dispatched" });
		const stops = await w.approach();
		ok("§7 no link row: stops searched from the fix, as before", stops.length === 1 && w.routeCalls.length === 1 && fromFix(w.routeCalls[0], NEAR), w.routeCalls);
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
