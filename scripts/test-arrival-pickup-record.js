#!/usr/bin/env node
/**
 * The arrival recorder: who set each load status, and for "At Shipper" where the
 * truck was and the shipper's zone, stored on the load_status_history row as it
 * is written (ARRIVAL_PICKUP_RECORDER_ENABLED, lib/arrival-recorder.js). Nothing
 * reads the facts for pay yet.
 *
 *   §0 the flag is on only when exactly "true" and says so at start; the six
 *      columns are added at boot whatever the flag, to a fresh database and to
 *      one written before them, and a restart adds nothing; the table stays
 *      append-only and no reader selects every column
 *   §1 a Driver's "At Shipper" tap (PUT /api/driver/status): "Driver", the
 *      truck's newest clean fix, its distance, "inside", the shipper's zone; a
 *      fix 40 km out: "outside"; a fix 6 minutes old, no truck, or no pickup
 *      point: no position, and the zone from the next source (the pickup point,
 *      the fix, the app zone); the load's Truck cell names the truck first; a
 *      fix stamped after the write is not the position at it
 *   §2 the same tap from a Dispatcher or a Super Admin session (the dashboard's
 *      dropdown) records that role, never one the body names; the override
 *      (PUT /api/loads/:loadId/status-override) records the session's role and,
 *      on "At Shipper", the position
 *   §3 the geofence through both position paths (the Routemate poller, the
 *      Linxup webhook) and the shipped tryGeofenceAdvance(): a ping 70 s old at
 *      processing stores its own time, "system", the distance it measured,
 *      "inside" and the zone; other_load_hauling is 1 beside another load In
 *      Transit, 0 beside one At Receiver or none
 *   §4 other statuses carry actor_role only: the tap's other steps, dispatch,
 *      accept (a driver's and a dispatcher's), decline, cancel, the geofence's
 *      departure and its At Receiver; a fix from before the device's link is
 *      never used
 *   §5 a failing lookup (the readers, the truck, the fix, the link time, the
 *      pickup point, the facts' own write) still writes the status and the row,
 *      its position empty
 *   §6 pins, recorder off and on: every old column of every row the seven
 *      writers insert is origin/main's, old_status included; the geofence row's
 *      changed_at is the processing time; off, the tap and the override run no
 *      lookup and write through today's statement; the tap path never geocodes;
 *      the same sheet cells are written; GET /api/loads/:loadId/status-history
 *      and the public tracker answer as on origin/main
 *   §7 lib/arrival-recorder.js on its own: the column shapes, the 5-minute
 *      edge, (0, 0) and a zero radius, the Truck cell before the driver, the
 *      zone banding, the statuses that count as under way, its requires
 *   §8 mutants, each caught: the role from the body; "inside" from a stale fix;
 *      the processing time stored as the geofence row's fix; an At Receiver load
 *      counted as under way
 *
 * Every recorder-on case fails on origin/main (no flag, no columns, no module);
 * the §6 pins pass on both. The routes and functions are lifted whole from
 * server.js (scripts/lib/server-source.js) and run on an in-memory SQLite with
 * the shipped DDL; only I/O is stubbed (the sheet, sockets, notices, the ELD
 * feeds' clients). Made-up drivers, trucks, loads and places; no network.
 *   node scripts/test-arrival-pickup-record.js       # exits 1 on failure
 *   SERVER_ROOT=<a copy of the base> node scripts/test-arrival-pickup-record.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createRequire } = require("module");
const source = require("./lib/server-source");
const { indexDeclarations, liftRoute } = require("./lib/server-lift");

const SERVER_JS = source.resolveServerFile();
const SRC = source.serverSource();
const appRequire = createRequire(SERVER_JS);
// "./lib/…" resolves from the server.js under test; packages from this checkout.
const realRequire = (p) => (/^\.\.?\//.test(p) ? appRequire(p) : require(p));

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
const geolib = require("geolib");
const appTime = appRequire("./lib/app-time");
let lib = null;
try { lib = appRequire("./lib/arrival-recorder"); } catch { lib = null; }
const LIB_FILE = path.join(path.dirname(SERVER_JS), "lib", "arrival-recorder.js");

// The geofence's own settings at their defaults; the flag is set by each world.
for (const k of ["GEOFENCE_RADIUS_M", "GEOFENCE_ARRIVE_MAX_SPEED_MPS", "ARRIVAL_PICKUP_RECORDER_ENABLED"]) delete process.env[k];

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
	if (cond) { passed++; return true; }
	failures.push(name);
	console.log(`  FAIL  ${name}${detail === undefined ? "" : `\n        ${JSON.stringify(detail)}`}`.slice(0, 2400));
	return false;
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
const section = (title) => console.log(`\n${title}`);

// ── the made-up world ──────────────────────────────────────────────────────────
const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;
const DRIVER_A = "Driver Able";
const DRIVER_B = "Driver Baker";
const DRIVER_C = "Driver Cole"; // no truck
const PICKUP = { latitude: 32.5, longitude: -97.25 }; // a Central-zone shipper
const DROP = { latitude: 33.2, longitude: -96.6 };
const OTHER_PICKUP = { latitude: 30.1, longitude: -95.4 };
const OTHER_DROP = { latitude: 29.4, longitude: -98.5 };
const MOUNTAIN = { latitude: 39.0, longitude: -105.0 };
const north = (p, metres) => ({ latitude: p.latitude + metres / 111320, longitude: p.longitude });
const NEAR = north(PICKUP, 900);
const FAR = north(PICKUP, 40000);
const NEAR_DISTANCE = geolib.getDistance(NEAR, PICKUP);
const APP_ZONE = appTime.appTimeZone();

const HEADERS = ["Contract ID", "Load ID", "Driver", "Pickup Appointment", "Pickup Address", "Drop-off Appointment",
	"Drop-off Address", "Job Status", "Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID"];
const COL = Object.fromEntries(HEADERS.map((h, i) => [h, i]));
const LOAD = (id, status, more = {}) => ({
	"Load ID": id, Driver: DRIVER_A, "Pickup Appointment": "11/20/2026 08:00", "Pickup Address": "100 Made Up Rd, Townville, TX 76000",
	"Drop-off Appointment": "11/21/2026 09:00", "Drop-off Address": "200 Sample Ave, Cityburg, TX 75000",
	"Job Status": status, "Assigned Date": "11/19/2026", ...more,
});
const rowOf = (o) => HEADERS.map((h) => (o[h] == null ? "" : String(o[h])));

const sess = {
	driver: (name = DRIVER_A) => ({ user: { id: 11, role: "Driver", username: name.toLowerCase().replace(/\s+/g, "_"), driverName: name } }),
	dispatcher: () => ({ user: { id: 12, role: "Dispatcher", username: "dispatcher_test" } }),
	admin: () => ({ user: { id: 1, role: "Super Admin", username: "super_admin_test" } }),
};

// ── the shipped schema ─────────────────────────────────────────────────────────
function shipped(src, re, label) {
	const m = src.match(re);
	if (!m || m.length !== 1) throw new Error(`expected exactly 1 ${label} in server.js, found ${m ? m.length : 0}`);
	return m[0];
}
function historyDdl(src) {
	return [
		shipped(src, /CREATE TABLE IF NOT EXISTS load_status_history \([\s\S]*?\n\t\)/g, "load_status_history table"),
		shipped(src, /CREATE INDEX IF NOT EXISTS idx_lsh_load ON load_status_history\([^)]*\)/g, "load_status_history index"),
		...(src.match(/ALTER TABLE load_status_history ADD COLUMN [^"`\n]*/g) || []),
	];
}
function telemetryDdl(src) {
	return [
		shipped(src, /CREATE TABLE IF NOT EXISTS routemate_telemetry \([\s\S]*?\n\t\)/g, "routemate_telemetry table"),
		...(src.match(/ALTER TABLE routemate_telemetry ADD COLUMN [^"`\n]*/g) || []),
		shipped(src, /CREATE INDEX IF NOT EXISTS idx_rm_tel_vid_date ON routemate_telemetry\([^)]*\)/g, "telemetry index"),
		shipped(src, /CREATE INDEX IF NOT EXISTS idx_rm_tel_clean ON routemate_telemetry\([^)]*\)/g, "telemetry index"),
	];
}
function otherDdl(src) {
	return [
		...telemetryDdl(src),
		shipped(src, /CREATE TABLE IF NOT EXISTS eld_device_assignments \([\s\S]*?\n\t\)/g, "eld_device_assignments table"),
		shipped(src, /CREATE TABLE IF NOT EXISTS load_responses \([\s\S]*?\n\t\)/g, "load_responses table"),
		"CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, role TEXT, driver_name TEXT)",
		"CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT)",
		"CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, routemate_vehicle_id TEXT DEFAULT '', assigned_driver TEXT DEFAULT '', owner_id INTEGER DEFAULT 0)",
		"CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT DEFAULT '', end_date TEXT DEFAULT '')",
		"CREATE TABLE load_coordinates (load_id TEXT PRIMARY KEY, pickup_address TEXT, dropoff_address TEXT, origin_lat REAL, origin_lng REAL, dest_lat REAL, dest_lng REAL, distance_miles REAL)",
		"CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT, type TEXT, deleted_at TEXT)",
		"CREATE TABLE driver_locations (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT NOT NULL, latitude REAL, longitude REAL, speed REAL DEFAULT 0, timestamp TEXT NOT NULL, load_id TEXT DEFAULT '')",
	];
}
// As the boot runs it: each ALTER on its own, a failure (an existing column) skipped.
function runDdl(db, statements) {
	for (const sql of statements) {
		if (/^ALTER TABLE/.test(sql)) { try { db.exec(sql); } catch { /* column already exists */ } } else db.exec(sql);
	}
}
const NEW_COLS = ["actor_role", "fix_ms", "pickup_distance_m", "pickup_zone", "local_tz", "other_load_hauling"];
const EMPTY = { actor_role: "", fix_ms: null, pickup_distance_m: null, pickup_zone: "", local_tz: "", other_load_hauling: null };
const roleOnly = (role) => ({ ...EMPTY, actor_role: role });
const factsOf = (row) => (row ? Object.fromEntries(NEW_COLS.map((c) => [c, c in row ? row[c] : "(no column)"])) : null);
const oldOf = (row) => (row ? [row.load_id, row.old_status, row.new_status, row.source, row.actor, row.reason] : null);

// ── lifting: a route or a function of server.js, every name it reaches resolved
// to the shipped top-level declaration unless stubbed ───────────────────────────
const MAIN_INDEX = indexDeclarations(SRC);
const DENIED = new Set(["app", "server", "io", "publicTrack", "db", "getSheets", "transporter", "sendEmail", "fetch"]);
function makeScope(stubs, index) {
	const cache = Object.create(null);
	let proxy = null;
	const resolveTop = (key) => {
		if (Object.prototype.hasOwnProperty.call(cache, key)) return { found: true, value: cache[key] };
		const d = index.decls.get(key);
		if (!d) return { found: false };
		if (index.dupes.has(key)) throw new Error(`${key} is declared more than once at the top level of server.js`);
		if (DENIED.has(key)) throw new Error(`the lifted code reached ${key}, which this runner must stub`);
		cache[key] = new Function("__scope", `with (__scope) { ${d.text}\nreturn ${key}; }`)(proxy);
		return { found: true, value: cache[key] };
	};
	proxy = new Proxy(Object.create(null), {
		has(_, key) {
			if (typeof key !== "string" || key === "__scope") return false;
			if (Object.prototype.hasOwnProperty.call(stubs, key) || Object.prototype.hasOwnProperty.call(cache, key)) return true;
			if (index.decls.has(key)) return true;
			return !(key in globalThis);
		},
		get(_, key) {
			if (key === Symbol.unscopables) return undefined;
			if (Object.prototype.hasOwnProperty.call(stubs, key)) return stubs[key];
			const top = resolveTop(key);
			if (top.found) return top.value;
			if (key in globalThis) return globalThis[key];
			throw new ReferenceError(`unstubbed in the lifted code: ${String(key)}`);
		},
		set(_, key, value) { cache[key] = value; return true; },
	});
	return proxy;
}

// Every statement the lifted code runs, by its SQL.
function loggingDb(raw, log) {
	const wrap = (sql, stmt) => new Proxy(stmt, {
		get(s, p) {
			const v = s[p];
			if (typeof v !== "function") return v;
			if (p === "get" || p === "all" || p === "run" || p === "iterate") return (...args) => { log.push(sql); return v.apply(s, args); };
			return v.bind(s);
		},
	});
	return new Proxy(raw, {
		get(target, p) {
			if (p === "prepare") return (sql) => wrap(String(sql).replace(/\s+/g, " ").trim(), target.prepare(sql));
			const v = target[p];
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
}

// A Job Tracking sheet in memory: reads by range, writes into the rows.
function fakeSheets(rows) {
	const writes = [];
	const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
	const write = (range, value) => {
		const m = /!([A-Z]+)(\d+)$/.exec(range);
		if (!m) return;
		const r = rows[Number(m[2]) - 1];
		const i = colIndex(m[1]);
		while (r.length <= i) r.push("");
		r[i] = value;
	};
	const values = {
		get: async ({ range }) => ({ data: { values: /!1:1$/.test(range || "") ? [rows[0].slice()] : rows.map((x) => x.slice()) } }),
		batchGet: async ({ ranges }) => ({ data: { valueRanges: (ranges || []).map(() => ({ values: rows.map((x) => x.slice()) })) } }),
		batchUpdate: async ({ requestBody }) => {
			for (const d of requestBody.data || []) { write(d.range, d.values[0][0]); writes.push(d.range); }
			return { data: {} };
		},
		update: async ({ range, requestBody }) => { write(range, requestBody.values[0][0]); writes.push(range); return { data: {} }; },
	};
	return { getSheets: async () => ({ spreadsheets: { values } }), writes };
}
const fakeIo = () => { const room = { emit() {}, except() { return room; } }; return { to: () => room }; };

function world({ recorder = true, loads = [], src = SRC, index = src === SRC ? MAIN_INDEX : indexDeclarations(src), stubs = {} } = {}) {
	const raw = new Database(":memory:");
	runDdl(raw, [...historyDdl(src), ...otherDdl(src)]);
	const log = [];
	const rows = [HEADERS.slice(), ...loads.map(rowOf)];
	const sheet = fakeSheets(rows);
	const w = { raw, db: loggingDb(raw, log), log, rows, sheet, src, index, errors: [], live: [], now0: Date.now(), spies: { ensureLoadCoordinates: 0, geocodeAddress: 0 } };
	const jt = () => ({
		headers: rows[0].slice(),
		data: rows.slice(1).map((r, i) => { const o = { _rowIndex: i + 2 }; rows[0].forEach((h, c) => { o[h] = r[c] == null ? "" : r[c]; }); return o; }),
	});
	w.stubs = {
		app: {}, db: w.db, getSheets: sheet.getSheets, SPREADSHEET_ID: "sheet-under-test", require: realRequire,
		console: { error: (...a) => w.errors.push(a.map(String).join(" ")), warn() {}, log() {}, info() {} },
		requireRole: () => null, requireAuth: null, driverWriteLimiter: null, trackPublicLimiter: null,
		WITHHELD_LOAD_REFS_ENABLED: false, loadBelongsToDriver: async () => true,
		logAudit: () => {}, logAuditRefusal: () => {},
		dispatchWriteBlocker: () => null, tripDayLockCover: () => null, statusOverrideBlocker: () => null,
		completedLoadCancelRefusal: () => null, periodLocksReadable: () => true,
		sendDispatchRefusal: (req, res, blocked) => res.status(409).json({ code: blocked && blocked.code }),
		jtCacheInvalidate: () => {}, notifyChange: () => {}, emitLoadEventToDispatch: () => {}, emitDispatchNotice: () => {},
		insertDispatchNotification: { run: () => ({ lastInsertRowid: 1 }) }, insertNotification: { run: () => ({ lastInsertRowid: 1 }) },
		io: fakeIo(), publicTrack: fakeIo(), DRIVER_AVAILABILITY_ENABLED: false,
		getJobTrackingCached: async () => jt(), getDeletedLoadIds: () => new Set(), findDriverAccountSpelling: (n) => n,
		ensureLoadCoordinates: async () => { w.spies.ensureLoadCoordinates++; return false; },
		geocodeAddress: async () => { w.spies.geocodeAddress++; return null; },
		getRoute: async (from, to) => ({ points: [from, to], distanceMiles: 321.5, durationMin: 300 }),
		ROUTEMATE_ENABLED: true, ROUTEMATE_API_KEY: "made-up-key", routemateCreds: () => ({}),
		routemate: { listLiveLocations: async () => w.live.map((x) => ({ ...x })) },
		routemateHealth: { lastSync: {}, lastError: null, errorsLast24h: 0 }, clearRoutemateLogState: () => {},
		logRoutemateSyncFailure: (kind, err) => w.errors.push(`routemate ${kind}: ${err && err.message}`),
		routemateUpsertVehicleMinimalStmt: { run() {} }, linxupHealth: { unlinked: 0, lastWritten: null },
		linxupTrackSpeedUnit: () => {}, maybeAlertLowFuel: () => {},
		...stubs,
	};
	w.scope = makeScope(w.stubs, index);
	// The shipped flag, read by the world's own lift of its declaration.
	process.env.ARRIVAL_PICKUP_RECORDER_ENABLED = recorder ? "true" : "false";
	try {
		if (index.decls.has("ARRIVAL_PICKUP_RECORDER_ENABLED") && !("ARRIVAL_PICKUP_RECORDER_ENABLED" in stubs)) void w.scope.ARRIVAL_PICKUP_RECORDER_ENABLED;
	} finally {
		delete process.env.ARRIVAL_PICKUP_RECORDER_ENABLED;
	}
	const run = (sql, ...args) => raw.prepare(sql).run(...args);
	for (const [name, role] of [[DRIVER_A, "Driver"], [DRIVER_B, "Driver"], [DRIVER_C, "Driver"]]) run("INSERT INTO users (username, role, driver_name) VALUES (?, ?, ?)", name.toLowerCase(), role, name);
	run("INSERT INTO trucks (id, unit_number, routemate_vehicle_id, assigned_driver, owner_id) VALUES (7, 'LX-701', 'DEV-701', ?, 5)", DRIVER_A);
	run("INSERT INTO trucks (id, unit_number, routemate_vehicle_id, assigned_driver, owner_id) VALUES (8, 'LX-802', 'DEV-802', ?, 6)", DRIVER_B);
	for (const [truck, driver, vid] of [[7, DRIVER_A, "DEV-701"], [8, DRIVER_B, "DEV-802"]]) {
		run("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, ?, '')", truck, driver, new Date(w.now0 - 3 * DAY).toISOString());
		run("INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from, assigned_until, assigned_by) VALUES (?, ?, ?, '', 'admin_test')", truck, vid, new Date(w.now0 - 3 * DAY).toISOString());
	}
	return w;
}
const fixAt = (w, vid, ago, at, more = {}) => w.raw.prepare(
	`INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, location_date_ms, dropped_reason, source)
	 VALUES (?, ?, ?, ?, ?, ?, 'linxup')`).run(vid, at.latitude, at.longitude, more.speed || 0, w.now0 - ago, more.dropped || "");
const coordsFor = (w, loadId, pickup, drop) => w.raw.prepare(
	"INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng) VALUES (?, ?, ?, ?, ?)")
	.run(loadId, pickup ? pickup.latitude : null, pickup ? pickup.longitude : null, drop ? drop.latitude : null, drop ? drop.longitude : null);
const history = (w) => w.raw.prepare("SELECT * FROM load_status_history ORDER BY id").all();
const lastRow = (w) => history(w).slice(-1)[0] || null;
const rowIndexOf = (w, loadId) => w.rows.findIndex((r, i) => i > 0 && r[COL["Load ID"]] === loadId) + 1;
const cell = (w, loadId, header) => (w.rows.find((r, i) => i > 0 && r[COL["Load ID"]] === loadId) || [])[COL[header]];

async function call(handler, req) {
	const out = { code: 200, body: null };
	const res = {
		status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; }, send(b) { out.body = b; return this; },
		setHeader() {}, set() { return this; }, end() { return this; },
	};
	await handler({ method: "GET", query: {}, params: {}, body: {}, headers: {}, ...req }, res);
	return out;
}
function handlerOf(w, method, routePath) {
	let handler = null;
	w.stubs.app = { [method]: (...args) => { handler = args[args.length - 1]; } };
	const head = w.src.split("\n").find((l) => l.startsWith(`app.${method}(${JSON.stringify(routePath)},`));
	if (!head) throw new Error(`no registration of ${method.toUpperCase()} ${routePath}`);
	new Function("__scope", `with (__scope) { ${liftRoute(w.src, head)} }`)(w.scope);
	if (typeof handler !== "function") throw new Error(`${routePath} registered no handler`);
	return handler;
}
const tap = (w, session, loadId, newStatus, body = {}) => call(handlerOf(w, "put", "/api/driver/status"),
	{ method: "PUT", session, body: { loadId, rowIndex: rowIndexOf(w, loadId), newStatus, driverName: session.user.driverName || DRIVER_A, ...body } });
const overrideTo = (w, session, loadId, newStatus, body = {}) => call(handlerOf(w, "put", "/api/loads/:loadId/status-override"),
	{ method: "PUT", session, params: { loadId }, body: { newStatus, reason: "made-up correction", ...body } });
const dispatchTo = (w, session, loadId, driver) => call(handlerOf(w, "post", "/api/dispatch"),
	{ method: "POST", session, body: { loadId, rowIndex: rowIndexOf(w, loadId), driver } });
const cancelLoad = (w, session, loadId) => call(handlerOf(w, "post", "/api/dispatch/cancel"),
	{ method: "POST", session, body: { loadId, rowIndex: rowIndexOf(w, loadId), reason: "made-up cancel" } });
const respond = (w, session, loadId, response) => call(handlerOf(w, "post", "/api/driver/respond"),
	{ method: "POST", session, body: { loadId, rowIndex: rowIndexOf(w, loadId), response, driverName: DRIVER_A } });
const livePing = (vid, at, ago, speed = 0) => ({
	routemate_vehicle_id: vid, vehicle_id: vid.replace(/\D/g, ""), latitude: at.latitude, longitude: at.longitude, speed, bearing: "",
	odometer: 1000, engine_hours: 0, fuel_pct: 50, geocoded_location: "", location_date_ms: Date.now() - ago,
});
const linxupPos = (vid, at, ago, speed = 0) => ({
	vehicle_id: vid, candidates: [vid], latitude: at.latitude, longitude: at.longitude, speed, bearing: "",
	odometer: 1000, engine_hours: 0, fuel_pct: null, geocoded_location: "", location_date_ms: Date.now() - ago,
});
async function poll(w, live) {
	w.live = live;
	await w.scope.routemateSyncTelemetry();
}
const linxup = (w, pos) => w.scope.ingestLinxupPosition(pos);
// changed_at is SQLite's CURRENT_TIMESTAMP: UTC, to the second, no zone marker.
const stampMs = (s) => Date.parse(String(s).replace(" ", "T") + "Z");
async function quietly(fn) {
	const original = console.error;
	const lines = [];
	console.error = (...a) => lines.push(a.map(String).join(" "));
	try { await fn(); } finally { console.error = original; }
	return lines;
}
const geoReason = (metres) => `auto by GPS — ${metres} m from the mapped pickup point (radius 3218.69 m)`;
// A mutated copy of the module, compiled beside the real one.
function libFrom(text) {
	const m = { exports: {} };
	new Function("require", "module", "exports", text)(createRequire(LIB_FILE), m, m.exports);
	return m.exports;
}

// ── the cases ──────────────────────────────────────────────────────────────────
async function main() {
	// ══ §0 ════════════════════════════════════════════════════════════════════
	section("§0 the flag and the columns");
	{
		const line = (SRC.match(/^const ARRIVAL_PICKUP_RECORDER_ENABLED = ([^\n]+);$/m) || [])[1];
		ok("§0 server.js reads ARRIVAL_PICKUP_RECORDER_ENABLED once, at the top level", !!line);
		const read = (value) => (line ? new Function("process", `return (${line});`)({ env: { ARRIVAL_PICKUP_RECORDER_ENABLED: value } }) : null);
		eq("§0 on only when exactly \"true\"", ["true", "TRUE", "True", "1", "yes", "on", " true", "true ", "", undefined].map(read),
			[true, false, false, false, false, false, false, false, false, false]);
		const start = (SRC.match(/^console\.log\(`\[arrival-recorder\] [^\n]*\);$/m) || [])[0];
		const said = (on) => { const out = []; if (start) new Function("console", "ARRIVAL_PICKUP_RECORDER_ENABLED", start)({ log: (s) => out.push(s) }, on); return out; };
		eq("§0 one start-up line gives its state", [said(true), said(false)],
			[["[arrival-recorder] ARRIVAL_PICKUP_RECORDER_ENABLED on"], ["[arrival-recorder] ARRIVAL_PICKUP_RECORDER_ENABLED off"]]);

		const cols = (db) => db.prepare("PRAGMA table_info(load_status_history)").all().map((c) => [c.name, c.type, c.dflt_value]);
		const fresh = new Database(":memory:");
		runDdl(fresh, historyDdl(SRC));
		eq("§0 a fresh database: the six columns, with their types and defaults", cols(fresh).filter(([n]) => NEW_COLS.includes(n)),
			[["actor_role", "TEXT", "''"], ["fix_ms", "INTEGER", null], ["pickup_distance_m", "REAL", null],
				["pickup_zone", "TEXT", "''"], ["local_tz", "TEXT", "''"], ["other_load_hauling", "INTEGER", null]]);
		// A copy written before them: the table as it stood, with a row.
		const older = new Database(":memory:");
		runDdl(older, historyDdl(SRC).filter((s) => !/ADD COLUMN (actor_role|fix_ms|pickup_distance_m|pickup_zone|local_tz|other_load_hauling)\b/.test(s)));
		older.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, reason) VALUES ('l-0900', 'Dispatched', 'At Shipper', 'manual', ?, '')").run(DRIVER_A);
		const before = older.prepare("SELECT id, load_id, old_status, new_status, source, actor, reason, changed_at FROM load_status_history").all();
		runDdl(older, historyDdl(SRC));
		eq("§0 a database from before them gains the six at boot, its rows' facts empty", factsOf(older.prepare("SELECT * FROM load_status_history").get()), EMPTY);
		eq("§0 ...and its rows' old columns as they were", older.prepare("SELECT id, load_id, old_status, new_status, source, actor, reason, changed_at FROM load_status_history").all(), before);
		const once = cols(older);
		let threw = null;
		try { runDdl(older, historyDdl(SRC)); } catch (e) { threw = e.message; }
		eq("§0 a restart adds nothing and throws nothing", [threw, cols(older)], [null, once]);
		const alters = SRC.split("\n").filter((l) => /ALTER TABLE load_status_history ADD COLUMN (actor_role|fix_ms|pickup_distance_m|pickup_zone|local_tz|other_load_hauling)\b/.test(l));
		ok("§0 each column is added by its own top-level statement, whatever the flag (none sits inside a branch)",
			alters.length === 6 && alters.every((l) => /^try \{ db\.exec\("ALTER TABLE load_status_history ADD COLUMN [a-z_]+ [A-Z]+( DEFAULT '')?"\); \} catch \{ \/\* column already exists \*\/ \}$/.test(l)), alters);
	}
	{
		const code = [SRC, ...(lib ? [fs.readFileSync(LIB_FILE, "utf8")] : [])].join("\n");
		ok("§0 (pin) the table stays append-only: no UPDATE or DELETE of load_status_history anywhere in server.js",
			!/\b(UPDATE|DELETE\s+FROM)\s+load_status_history\b/i.test(code));
		ok("§0 (pin) no reader selects every column, so the new ones reach no existing answer",
			!/SELECT\s+(?:[A-Za-z_]+\.)?\*\s+FROM\s+load_status_history/i.test(code));
	}

	// ══ §1 ════════════════════════════════════════════════════════════════════
	section("§1 a Driver's \"At Shipper\" tap");
	{
		const w = world({ loads: [LOAD("L-1001", "Heading to Shipper")] });
		coordsFor(w, "L-1001", PICKUP, DROP);
		fixAt(w, "DEV-701", 2 * MIN, FAR);
		fixAt(w, "DEV-701", 30 * SEC, NEAR);
		fixAt(w, "DEV-701", 10 * SEC, PICKUP, { dropped: "speed_outlier" });
		const r = await tap(w, sess.driver(), "L-1001", "At Shipper");
		const row = lastRow(w);
		eq("§1 the tap answers 200 and the status moves", [r.code, r.body, cell(w, "L-1001", "Job Status")], [200, { success: true }, "At Shipper"]);
		eq("§1 the history row's old columns, as always", oldOf(row), ["l-1001", "Heading to Shipper", "At Shipper", "manual", DRIVER_A, ""]);
		eq("§1 its facts: Driver, the truck's newest clean fix (a dropped one is never read), its distance, inside, the shipper's zone",
			factsOf(row), { actor_role: "Driver", fix_ms: w.now0 - 30 * SEC, pickup_distance_m: NEAR_DISTANCE, pickup_zone: "inside", local_tz: "America/Chicago", other_load_hauling: null });
		ok("§1 ...the distance is the 900 m the truck stood from the pickup point", row && Math.abs(row.pickup_distance_m - 900) <= 2, row && row.pickup_distance_m);
		eq("§1 ...and nothing was logged as failing", w.errors, []);
	}
	{
		const w = world({ loads: [LOAD("L-1002", "Heading to Shipper")] });
		coordsFor(w, "L-1002", PICKUP, DROP);
		fixAt(w, "DEV-701", 30 * SEC, FAR);
		await tap(w, sess.driver(), "L-1002", "At Shipper");
		const f = factsOf(lastRow(w));
		eq("§1 a fresh fix 40 km from the pickup point: outside, with its distance", [f.actor_role, f.fix_ms, f.pickup_zone, Math.round(f.pickup_distance_m / 1000), f.local_tz],
			["Driver", w.now0 - 30 * SEC, "outside", 40, "America/Chicago"]);
	}
	{
		const w = world({ loads: [LOAD("L-1003", "Heading to Shipper")] });
		coordsFor(w, "L-1003", PICKUP, DROP);
		fixAt(w, "DEV-701", 6 * MIN, NEAR);
		await tap(w, sess.driver(), "L-1003", "At Shipper");
		eq("§1 the newest fix 6 minutes old: no position; the zone from the pickup point", factsOf(lastRow(w)), { ...roleOnly("Driver"), local_tz: "America/Chicago" });
	}
	{
		const w = world({ loads: [LOAD("L-1004", "Heading to Shipper", { Driver: DRIVER_C })] });
		coordsFor(w, "L-1004", PICKUP, DROP);
		const r = await tap(w, sess.driver(DRIVER_C), "L-1004", "At Shipper");
		eq("§1 no truck for the load: 200, no position, the zone from the pickup point", [r.code, factsOf(lastRow(w))], [200, { ...roleOnly("Driver"), local_tz: "America/Chicago" }]);
	}
	{
		const w = world({ loads: [LOAD("L-1005", "Heading to Shipper")] });
		fixAt(w, "DEV-701", 30 * SEC, MOUNTAIN);
		await tap(w, sess.driver(), "L-1005", "At Shipper");
		eq("§1 no pickup point: no position; the zone from the fresh fix (Mountain)", factsOf(lastRow(w)), { ...roleOnly("Driver"), local_tz: "America/Denver" });
		eq("§1 ...and the tap never geocoded the load to find one", [w.spies.ensureLoadCoordinates, w.spies.geocodeAddress], [0, 0]);
	}
	{
		const w = world({ loads: [LOAD("L-1006", "Heading to Shipper")] });
		fixAt(w, "DEV-701", 6 * MIN, MOUNTAIN);
		await tap(w, sess.driver(), "L-1006", "At Shipper");
		eq("§1 no pickup point and no fresh fix: the app zone", factsOf(lastRow(w)), { ...roleOnly("Driver"), local_tz: APP_ZONE });
	}
	{
		// The load's Truck cell names the other truck: its fix, not the driver's own truck's.
		const w = world({ loads: [LOAD("L-1007", "Heading to Shipper", { Truck: "LX-802" })] });
		coordsFor(w, "L-1007", PICKUP, DROP);
		fixAt(w, "DEV-701", 20 * SEC, FAR);
		fixAt(w, "DEV-802", 40 * SEC, NEAR);
		await tap(w, sess.driver(), "L-1007", "At Shipper");
		const f = factsOf(lastRow(w));
		eq("§1 the load's Truck cell names the truck first (its fix, inside), before the driver's own truck", [f.fix_ms, f.pickup_zone], [w.now0 - 40 * SEC, "inside"]);
	}
	{
		// A fix stamped after the write (a device clock ahead) is not the position at the write.
		const w = world({ loads: [LOAD("L-1010", "Heading to Shipper")] });
		coordsFor(w, "L-1010", PICKUP, DROP);
		fixAt(w, "DEV-701", 90 * SEC, FAR);
		fixAt(w, "DEV-701", -5 * MIN, NEAR);
		await tap(w, sess.driver(), "L-1010", "At Shipper");
		const f = factsOf(lastRow(w));
		eq("§1 a fix stamped after the write is passed over for the newest at or before it", [f.fix_ms, f.pickup_zone], [w.now0 - 90 * SEC, "outside"]);
	}

	// ══ §2 ════════════════════════════════════════════════════════════════════
	section("§2 staff sessions and the override");
	for (const [session, role] of [[sess.dispatcher(), "Dispatcher"], [sess.admin(), "Super Admin"]]) {
		const w = world({ loads: [LOAD("L-1101", "Heading to Shipper")] });
		coordsFor(w, "L-1101", PICKUP, DROP);
		fixAt(w, "DEV-701", 30 * SEC, NEAR);
		const r = await tap(w, session, "L-1101", "At Shipper", { driverName: DRIVER_A });
		const row = lastRow(w);
		eq(`§2 the dashboard's dropdown from a ${role} session: the same row, actor the driver's name`, [r.code, oldOf(row)],
			[200, ["l-1101", "Heading to Shipper", "At Shipper", "manual", DRIVER_A, ""]]);
		eq(`§2 ...and actor_role ${role}, with the truck's position`, factsOf(row),
			{ actor_role: role, fix_ms: w.now0 - 30 * SEC, pickup_distance_m: NEAR_DISTANCE, pickup_zone: "inside", local_tz: "America/Chicago", other_load_hauling: null });
	}
	{
		const w = world({ loads: [LOAD("L-1102", "Heading to Shipper")] });
		coordsFor(w, "L-1102", PICKUP, DROP);
		fixAt(w, "DEV-701", 30 * SEC, NEAR);
		await tap(w, sess.driver(), "L-1102", "At Shipper", { role: "Super Admin", actorRole: "Dispatcher", actor_role: "Dispatcher" });
		eq("§2 a role the body names is never stored: the session's", factsOf(lastRow(w)).actor_role, "Driver");
	}
	for (const [session, role] of [[sess.dispatcher(), "Dispatcher"], [sess.admin(), "Super Admin"]]) {
		const w = world({ loads: [LOAD("L-1103", "Heading to Shipper")] });
		coordsFor(w, "L-1103", PICKUP, DROP);
		fixAt(w, "DEV-701", 30 * SEC, NEAR);
		const r = await overrideTo(w, session, "L-1103", "At Shipper", { actorRole: "Driver" });
		const row = lastRow(w);
		eq(`§2 the override from a ${role} session: 200, the row as always`, [r.code, oldOf(row)],
			[200, ["l-1103", "Heading to Shipper", "At Shipper", "override", session.user.username, ""]]);
		eq(`§2 ...actor_role ${role} (not the body's), the position and the zone`, factsOf(row),
			{ actor_role: role, fix_ms: w.now0 - 30 * SEC, pickup_distance_m: NEAR_DISTANCE, pickup_zone: "inside", local_tz: "America/Chicago", other_load_hauling: null });
	}

	// ══ §3 ════════════════════════════════════════════════════════════════════
	section("§3 the geofence, through both position paths");
	const geofenceWorld = (otherStatus, recorder = true) => {
		const loads = [LOAD("L-1201", "Dispatched")];
		if (otherStatus) loads.unshift(LOAD("L-1200", otherStatus));
		const w = world({ recorder, loads });
		coordsFor(w, "L-1200", OTHER_PICKUP, OTHER_DROP);
		coordsFor(w, "L-1201", PICKUP, DROP);
		// The geofence's two-fix rule: the previous clean fix was inside the zone too.
		fixAt(w, "DEV-701", 130 * SEC, NEAR);
		return w;
	};
	for (const [label, path_] of [["the Routemate poller", "poll"], ["the Linxup webhook", "linxup"]]) {
		for (const [otherStatus, hauling, why] of [["In Transit", 1, "another load In Transit"], ["At Receiver", 0, "another load At Receiver"], [null, 0, "no other load"]]) {
			const w = geofenceWorld(otherStatus);
			const ping = path_ === "poll" ? livePing("DEV-701", NEAR, 70 * SEC) : linxupPos("DEV-701", NEAR, 70 * SEC);
			const t0 = Math.floor(Date.now() / 1000) * 1000;
			if (path_ === "poll") await poll(w, [ping]); else await linxup(w, ping);
			const t1 = Date.now();
			const row = history(w).find((r) => r.load_id === "l-1201") || null;
			eq(`§3 ${label}, ${why}: the geofence moves the load to At Shipper`, [oldOf(row), cell(w, "L-1201", "Job Status")],
				[["l-1201", "Dispatched", "At Shipper", "geofence", DRIVER_A, geoReason(NEAR_DISTANCE)], "At Shipper"]);
			eq(`§3 ${label}, ${why}: the ping's own time, system, the distance, inside, the zone, other_load_hauling ${hauling}`, factsOf(row),
				{ actor_role: "system", fix_ms: ping.location_date_ms, pickup_distance_m: NEAR_DISTANCE, pickup_zone: "inside", local_tz: "America/Chicago", other_load_hauling: hauling });
			ok(`§3 ${label}, ${why}: changed_at is the processing time, 70 s after the ping`,
				!!row && stampMs(row.changed_at) >= t0 && stampMs(row.changed_at) <= t1 && stampMs(row.changed_at) - ping.location_date_ms >= 60 * SEC,
				row && [row.changed_at, new Date(ping.location_date_ms).toISOString()]);
			eq(`§3 ${label}, ${why}: no error`, w.errors, []);
		}
	}

	// ══ §4 ════════════════════════════════════════════════════════════════════
	section("§4 other statuses carry actor_role only; a fix from before the link is never used");
	{
		const w = world({ loads: [LOAD("L-1301", "Assigned")] });
		coordsFor(w, "L-1301", PICKUP, DROP);
		fixAt(w, "DEV-701", 30 * SEC, NEAR);
		const steps = [];
		for (const status of ["Heading to Shipper", "At Shipper", "Loading", "In Transit", "At Receiver"]) {
			await tap(w, sess.driver(), "L-1301", status);
			steps.push([status, factsOf(lastRow(w))]);
		}
		w.raw.prepare("INSERT INTO documents (load_id, type) VALUES ('L-1301', 'POD')").run();
		await tap(w, sess.driver(), "L-1301", "Delivered");
		steps.push(["Delivered", factsOf(lastRow(w))]);
		const atShipper = { actor_role: "Driver", fix_ms: w.now0 - 30 * SEC, pickup_distance_m: NEAR_DISTANCE, pickup_zone: "inside", local_tz: "America/Chicago", other_load_hauling: null };
		eq("§4 a driver's steps: actor_role on each, the position on \"At Shipper\" only", steps, [
			["Heading to Shipper", roleOnly("Driver")], ["At Shipper", atShipper], ["Loading", roleOnly("Driver")],
			["In Transit", roleOnly("Driver")], ["At Receiver", roleOnly("Driver")], ["Delivered", roleOnly("Driver")]]);
	}
	{
		const w = world({ loads: [LOAD("L-1302", "Unassigned", { Driver: "" }), LOAD("L-1303", "Dispatched"), LOAD("L-1304", "Dispatched"), LOAD("L-1305", "Assigned")] });
		await dispatchTo(w, sess.dispatcher(), "L-1302", DRIVER_A);
		const dispatched = factsOf(lastRow(w));
		await respond(w, sess.driver(), "L-1302", "accepted");
		const accepted = factsOf(lastRow(w));
		await respond(w, sess.dispatcher(), "L-1303", "accepted");
		const staffAccept = factsOf(lastRow(w));
		await respond(w, sess.driver(), "L-1304", "declined");
		const declined = factsOf(lastRow(w));
		await cancelLoad(w, sess.admin(), "L-1305");
		const cancelled = factsOf(lastRow(w));
		eq("§4 dispatch, accept (a driver's and a dispatcher's), decline and cancel: the session's role, nothing else",
			[dispatched, accepted, staffAccept, declined, cancelled],
			[roleOnly("Dispatcher"), roleOnly("Driver"), roleOnly("Dispatcher"), roleOnly("Driver"), roleOnly("Super Admin")]);
		eq("§4 ...each still the row it always was", history(w).map(oldOf), [
			["l-1302", "", "Dispatched", "dispatch", "dispatcher_test", ""], ["l-1302", "Dispatched", "Assigned", "accept", DRIVER_A, ""],
			["l-1303", "Dispatched", "Assigned", "accept", DRIVER_A, ""], ["l-1304", "", "Unassigned", "decline", DRIVER_A, ""],
			["l-1305", "", "Cancelled", "cancel", "super_admin_test", "made-up cancel"]]);
	}
	{
		// The departure: inside the pickup zone a minute ago, just outside it now and moving.
		const w = world({ loads: [LOAD("L-1306", "At Shipper")] });
		coordsFor(w, "L-1306", PICKUP, DROP);
		fixAt(w, "DEV-701", 90 * SEC, north(PICKUP, 3000));
		await poll(w, [livePing("DEV-701", north(PICKUP, 3500), 30 * SEC, 12)]);
		const departed = lastRow(w);
		// The receiver: slowing inside the drop-off zone, the fix before inside too.
		const v = world({ loads: [LOAD("L-1307", "In Transit")] });
		coordsFor(v, "L-1307", PICKUP, DROP);
		fixAt(v, "DEV-701", 90 * SEC, north(DROP, 500));
		await poll(v, [livePing("DEV-701", north(DROP, 400), 30 * SEC)]);
		const arrived = lastRow(v);
		eq("§4 the geofence's departure and its At Receiver: system, nothing else",
			[oldOf(departed) && oldOf(departed).slice(1, 4), factsOf(departed), oldOf(arrived) && oldOf(arrived).slice(1, 4), factsOf(arrived)],
			[["At Shipper", "In Transit", "geofence"], roleOnly("system"), ["In Transit", "At Receiver", "geofence"], roleOnly("system")]);
	}
	for (const [linkAgo, expectInside, label] of [[2 * MIN, false, "linked 2 minutes ago, its newest fix 3 minutes old: never used"],
		[10 * MIN, true, "linked 10 minutes ago, the same fix: used"]]) {
		const w = world({ loads: [LOAD("L-1308", "Heading to Shipper")] });
		coordsFor(w, "L-1308", PICKUP, DROP);
		w.raw.prepare("UPDATE eld_device_assignments SET assigned_from = ? WHERE truck_id = 7").run(new Date(w.now0 - linkAgo).toISOString());
		fixAt(w, "DEV-701", 3 * MIN, NEAR);
		await tap(w, sess.driver(), "L-1308", "At Shipper");
		const f = factsOf(lastRow(w));
		eq(`§4 the device ${label}`, [f.pickup_zone, f.fix_ms === null, f.local_tz], [expectInside ? "inside" : "", !expectInside, "America/Chicago"]);
	}

	// ══ §5 ════════════════════════════════════════════════════════════════════
	section("§5 a failing lookup never fails the write");
	const failing = [
		["the readers themselves", { arrivalRecorderReaders: () => { throw new Error("made-up readers failure"); } }, APP_ZONE],
		["the truck", { findTruckForDriverStamp: () => { throw new Error("made-up truck failure"); } }, "America/Chicago"],
		["the fix", { _dropTelemetry: true }, "America/Chicago"],
		["the link time", { eldDeviceLinkedSinceMs: () => { throw new Error("made-up link failure"); } }, "America/Chicago"],
		["the pickup point", { resolveGeofencePoints: () => { throw new Error("made-up coordinates failure"); } }, "America/Chicago"],
	];
	for (const [what, stubs, zone] of failing) {
		const { _dropTelemetry, ...rest } = stubs;
		const w = world({ loads: [LOAD("L-1401", "Heading to Shipper")], stubs: rest });
		coordsFor(w, "L-1401", PICKUP, DROP);
		fixAt(w, "DEV-701", 30 * SEC, NEAR);
		if (_dropTelemetry) w.raw.exec("DROP TABLE routemate_telemetry");
		let r = null;
		const logged = await quietly(async () => { r = await tap(w, sess.driver(), "L-1401", "At Shipper"); });
		const rows = history(w);
		eq(`§5 ${what} fails: 200, the status written, one history row, Driver, no position, the zone from what answered`,
			[r && r.code, cell(w, "L-1401", "Job Status"), rows.length, oldOf(rows[0]), factsOf(rows[0])],
			[200, "At Shipper", 1, ["l-1401", "Heading to Shipper", "At Shipper", "manual", DRIVER_A, ""], { ...roleOnly("Driver"), local_tz: zone }]);
		ok(`§5 ${what} fails: the failure is logged by the recorder`, logged.some((l) => /\[arrival-recorder\]/.test(l)), logged);
	}
	{
		const w = world({ loads: [LOAD("L-1402", "Heading to Shipper")], stubs: { insertStatusHistoryRecorded: { run() { throw new Error("made-up write failure"); } } } });
		coordsFor(w, "L-1402", PICKUP, DROP);
		fixAt(w, "DEV-701", 30 * SEC, NEAR);
		const r = await tap(w, sess.driver(), "L-1402", "At Shipper");
		const rows = history(w);
		eq("§5 the facts' own write fails: today's row is written instead, and the failure logged",
			[r.code, rows.length, oldOf(rows[0]), factsOf(rows[0]), w.errors.some((e) => /made-up write failure/.test(e))],
			[200, 1, ["l-1402", "Heading to Shipper", "At Shipper", "manual", DRIVER_A, ""], EMPTY, true]);
	}

	// ══ §6 ════════════════════════════════════════════════════════════════════
	section("§6 pins: off and on, the old columns and every answer stay origin/main's");
	// The seven writers on one day of made-up work.
	async function sequence(recorder) {
		const w = world({ recorder, loads: [LOAD("L-2001", "Unassigned", { Driver: "" }), LOAD("L-2002", "Dispatched"), LOAD("L-2003", "Assigned", { Driver: DRIVER_B })] });
		coordsFor(w, "L-2001", PICKUP, DROP);
		coordsFor(w, "L-2002", OTHER_PICKUP, OTHER_DROP);
		fixAt(w, "DEV-701", 40 * SEC, NEAR);
		const answers = [];
		answers.push((await dispatchTo(w, sess.dispatcher(), "L-2001", DRIVER_A)).code);
		answers.push((await respond(w, sess.driver(), "L-2001", "accepted")).code);
		answers.push((await tap(w, sess.driver(), "L-2001", "Heading to Shipper")).code);
		answers.push((await tap(w, sess.driver(), "L-2001", "At Shipper")).code);
		answers.push((await overrideTo(w, sess.dispatcher(), "L-2001", "Heading to Shipper")).code);
		const ping = livePing("DEV-701", NEAR, 70 * SEC);
		const t0 = Math.floor(Date.now() / 1000) * 1000;
		await poll(w, [ping]);
		const t1 = Date.now();
		answers.push((await tap(w, sess.admin(), "L-2001", "Loading", { driverName: DRIVER_A })).code);
		answers.push((await tap(w, sess.driver(), "L-2001", "In Transit")).code);
		answers.push((await respond(w, sess.driver(), "L-2002", "declined")).code);
		answers.push((await cancelLoad(w, sess.admin(), "L-2003")).code);
		const rows = history(w);
		const geo = rows.find((r) => r.source === "geofence") || null;
		return { w, answers, rows, ping, geoAt: geo && stampMs(geo.changed_at), t0, t1 };
	}
	const off = await sequence(false);
	const on = await sequence(true);
	const OLD_ROWS = [
		[1, "l-2001", "", "Dispatched", "dispatch", "dispatcher_test", ""],
		[2, "l-2001", "Dispatched", "Assigned", "accept", DRIVER_A, ""],
		[3, "l-2001", "Assigned", "Heading to Shipper", "manual", DRIVER_A, ""],
		[4, "l-2001", "Heading to Shipper", "At Shipper", "manual", DRIVER_A, ""],
		[5, "l-2001", "At Shipper", "Heading to Shipper", "override", "dispatcher_test", ""],
		[6, "l-2001", "Heading to Shipper", "At Shipper", "geofence", DRIVER_A, geoReason(NEAR_DISTANCE)],
		[7, "l-2001", "At Shipper", "Loading", "manual", DRIVER_A, ""],
		[8, "l-2001", "Loading", "In Transit", "manual", DRIVER_A, ""],
		[9, "l-2002", "", "Unassigned", "decline", DRIVER_A, ""],
		[10, "l-2003", "", "Cancelled", "cancel", "super_admin_test", "made-up cancel"],
	];
	const oldRows = (rows) => rows.map((r) => [r.id, ...oldOf(r)]);
	eq("§6 (pin) every writer answers 200, recorder off", off.answers, Array(9).fill(200));
	eq("§6 (pin) every writer answers 200, recorder on", on.answers, Array(9).fill(200));
	eq("§6 (pin) recorder off: every old column of every row the seven writers insert, as origin/main writes it", oldRows(off.rows), OLD_ROWS);
	eq("§6 (pin) recorder on: the same, byte for byte", oldRows(on.rows), OLD_ROWS);
	eq("§6 recorder off: every row's six new columns empty", off.rows.map(factsOf), OLD_ROWS.map(() => EMPTY));
	const atShipperTap = { actor_role: "Driver", fix_ms: on.w.now0 - 40 * SEC, pickup_distance_m: NEAR_DISTANCE, pickup_zone: "inside", local_tz: "America/Chicago", other_load_hauling: null };
	eq("§6 recorder on: each row's facts", on.rows.map(factsOf), [
		roleOnly("Dispatcher"), roleOnly("Driver"), roleOnly("Driver"), atShipperTap, roleOnly("Dispatcher"),
		{ actor_role: "system", fix_ms: on.ping.location_date_ms, pickup_distance_m: NEAR_DISTANCE, pickup_zone: "inside", local_tz: "America/Chicago", other_load_hauling: 0 },
		roleOnly("Super Admin"), roleOnly("Driver"), roleOnly("Driver"), roleOnly("Super Admin")]);
	for (const [label, s] of [["off", off], ["on", on]]) {
		ok(`§6 (pin) recorder ${label}: the geofence row's changed_at is the processing time, not the ping's`,
			s.geoAt !== null && s.geoAt >= s.t0 && s.geoAt <= s.t1 && s.geoAt - s.ping.location_date_ms >= 60 * SEC, [s.geoAt, s.t0, s.t1, s.ping.location_date_ms]);
	}
	eq("§6 (pin) the same sheet cells are written, off and on", on.w.sheet.writes, off.w.sheet.writes);
	eq("§6 (pin) ...and the sheet holds the same values but the time stamps", [on.w.rows.map((r) => r.filter((_, c) => c !== COL["Status Update Date"] && c !== COL["Completion Date"]))],
		[off.w.rows.map((r) => r.filter((_, c) => c !== COL["Status Update Date"] && c !== COL["Completion Date"]))]);
	{
		// Off, no lookup: the tap and the override run only today's INSERT.
		const TODAY_INSERT = "INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, reason) VALUES (?, ?, ?, ?, ?, ?)";
		const LOOKUP_RE = /\b(routemate_telemetry|trucks|truck_assignments|load_coordinates|eld_device_assignments|users)\b/;
		const run = async (recorder, act) => {
			const w = world({ recorder, loads: [LOAD("L-2101", "Heading to Shipper")] });
			coordsFor(w, "L-2101", PICKUP, DROP);
			fixAt(w, "DEV-701", 30 * SEC, NEAR);
			w.log.length = 0;
			await act(w);
			return w.log.slice();
		};
		const tapOff = await run(false, (w) => tap(w, sess.driver(), "L-2101", "At Shipper"));
		const overrideOff = await run(false, (w) => overrideTo(w, sess.dispatcher(), "L-2101", "At Shipper"));
		eq("§6 (pin) recorder off: the tap runs no lookup and writes through today's statement", tapOff, [TODAY_INSERT]);
		eq("§6 (pin) recorder off: so does the override", overrideOff, [TODAY_INSERT]);
		const tapOn = await run(true, (w) => tap(w, sess.driver(), "L-2101", "At Shipper"));
		ok("§6 recorder on: the tap looks the truck, its fix and its link up (the off pin is not vacuous)",
			tapOn.some((s) => /FROM routemate_telemetry/.test(s)) && tapOn.some((s) => /eld_device_assignments/.test(s)) && tapOn.some((s) => LOOKUP_RE.test(s)), tapOn);
	}
	{
		// The tap path never geocodes; the geofence's own path does, for a load with no coordinates.
		const w = world({ loads: [LOAD("L-2201", "Heading to Shipper")] });
		fixAt(w, "DEV-701", 30 * SEC, NEAR);
		await tap(w, sess.driver(), "L-2201", "At Shipper");
		const afterTap = [w.spies.ensureLoadCoordinates, w.spies.geocodeAddress];
		const g = world({ loads: [LOAD("L-2202", "Dispatched")] });
		fixAt(g, "DEV-701", 130 * SEC, NEAR);
		await poll(g, [livePing("DEV-701", NEAR, 70 * SEC)]);
		eq("§6 (pin) the tap path never calls ensureLoadCoordinates() (the geofence's does, for a load with no coordinates)",
			[afterTap, g.spies.ensureLoadCoordinates], [[0, 0], 1]);
	}
	{
		// The readers' answers for L-2001, its clock stamps fixed so two runs compare.
		const answersOf = async (s) => {
			const w = s.w;
			w.rows.slice(1).forEach((r) => { r[COL["Status Update Date"]] = "11/20/2026 10:00:00"; r[COL["Completion Date"]] = ""; });
			w.raw.prepare("SELECT id FROM load_status_history ORDER BY id").all().forEach(({ id }) => {
				w.raw.prepare("UPDATE load_status_history SET changed_at = ? WHERE id = ?").run(`2026-11-20 14:${String(id).padStart(2, "0")}:00`, id);
			});
			w.raw.exec("DELETE FROM routemate_telemetry");
			const hist = await call(handlerOf(w, "get", "/api/loads/:loadId/status-history"), { params: { loadId: "L-2001" }, session: sess.admin() });
			const track = await call(handlerOf(w, "get", "/api/public/track/:loadId"), { params: { loadId: "L-2001" } });
			return { hist, track };
		};
		const a = await answersOf(off);
		const b = await answersOf(on);
		eq("§6 (pin) GET /api/loads/:loadId/status-history: off and on answer alike", b.hist, a.hist);
		eq("§6 (pin) GET /api/public/track/:loadId: off and on answer alike", b.track, a.track);
		eq("§6 (pin) ...the status history answers as origin/main does", [a.hist.code, sha(a.hist.body)], [200, EXPECTED_HISTORY_SHA]);
		eq("§6 (pin) ...the public tracker answers as origin/main does", [a.track.code, sha(a.track.body)], [200, EXPECTED_TRACKER_SHA]);
		eq("§6 (pin) ...its phases and actual times (the parts read from the table)",
			a.track.body && [a.track.body.phases.map((p) => [p.status, p.source, p.startedAt]), a.track.body.actualPickup, a.track.body.actualDelivery],
			[[["Dispatched", "dispatch", "2026-11-20T14:01:00Z"], ["Assigned", "accept", "2026-11-20T14:02:00Z"], ["Heading to Shipper", "manual", "2026-11-20T14:03:00Z"],
				["At Shipper", "manual", "2026-11-20T14:04:00Z"], ["Heading to Shipper", "override", "2026-11-20T14:05:00Z"], ["At Shipper", "geofence", "2026-11-20T14:06:00Z"],
				["Loading", "manual", "2026-11-20T14:07:00Z"], ["In Transit", "manual", "2026-11-20T14:08:00Z"]], "2026-11-20T14:08:00Z", null]);
		if (process.env.PRINT_ANSWERS === "1") console.log(JSON.stringify({ hist: sha(a.hist.body), track: sha(a.track.body) }));
	}

	// ══ §7 ════════════════════════════════════════════════════════════════════
	section("§7 lib/arrival-recorder.js on its own");
	ok("§7 lib/arrival-recorder.js exists", !!lib);
	if (lib) {
		eq("§7 historyColumns(): nothing given, the columns' defaults", lib.historyColumns({}), ["", null, null, "", "", null]);
		eq("§7 historyColumns(): each fact as given", lib.historyColumns({ actorRole: "Driver", fixMs: 1.8e12, pickupDistanceM: 900, pickupZone: "outside", localTz: "America/Chicago", otherLoadHauling: 1 }),
			["Driver", 1.8e12, 900, "outside", "America/Chicago", 1]);
		eq("§7 historyColumns(): any other shape stored as the default (a role no session has, text times, negatives, other zones, flags)",
			[["Investor", "1800000000000", -1, "INSIDE", "EST", true], ["system", NaN, Infinity, "near", "America/Chicago; x", 2], ["Dispatcher", 1.5, 0, "inside", "UTC", 0]]
				.map(([actorRole, fixMs, pickupDistanceM, pickupZone, localTz, otherLoadHauling]) => lib.historyColumns({ actorRole, fixMs, pickupDistanceM, pickupZone, localTz, otherLoadHauling })),
			[["", null, null, "", "", null], ["system", null, null, "", "", null], ["Dispatcher", 2, 0, "inside", "UTC", 0]]);
		const db = new Database(":memory:");
		runDdl(db, telemetryDdl(SRC));
		const T = Date.UTC(2026, 10, 20, 15, 0, 0);
		const readers = (over = {}) => {
			const calls = [];
			return {
				calls,
				fn: () => ({
					db, radiusM: 3218.69, truckColRe: /^truck$/i, now: () => T,
					truckByUnit: (unit) => { calls.push(["unit", unit]); return unit === "LX-802" ? { id: 8, unit: "LX-802", vid: "DEV-802" } : undefined; },
					truckForDriver: (name) => { calls.push(["driver", name]); return name === DRIVER_A ? { id: 7, unit_number: "LX-701", routemate_vehicle_id: "DEV-701" } : null; },
					linkedSinceMs: () => null,
					pickupPoint: () => PICKUP,
					...over,
				}),
			};
		};
		const fix = (vid, at, ms) => db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, location_date_ms, dropped_reason) VALUES (?, ?, ?, ?, '')").run(vid, at.latitude, at.longitude, ms);
		const H = ["Load ID", "Driver", "Truck"];
		const facts = (over, row = ["L-1", DRIVER_A, ""], status = "At Shipper") => lib.positionFacts({ enabled: true, newStatus: status, loadId: "L-1", headers: H, row, readers: readers(over).fn });
		{
			const r = readers();
			eq("§7 positionFacts(): off, or any status but \"At Shipper\": {} and no reader asked",
				[lib.positionFacts({ enabled: false, newStatus: "At Shipper", headers: H, row: ["L-1", DRIVER_A, ""], readers: r.fn }),
					lib.positionFacts({ enabled: true, newStatus: "Loading", headers: H, row: ["L-1", DRIVER_A, ""], readers: () => { throw new Error("asked"); } }), r.calls], [{}, {}, []]);
		}
		fix("DEV-701", NEAR, T - 5 * MIN);
		eq("§7 a fix exactly 5 minutes old counts", facts().pickupZone, "inside");
		db.exec("DELETE FROM routemate_telemetry");
		fix("DEV-701", NEAR, T - 5 * MIN - 1);
		eq("§7 a millisecond older does not: no position, the zone from the pickup point", facts(), { localTz: "America/Chicago" });
		db.exec("DELETE FROM routemate_telemetry");
		fix("DEV-701", { latitude: 0, longitude: 0 }, T - SEC);
		eq("§7 a (0, 0) fix is no position", facts(), { localTz: "America/Chicago" });
		db.exec("DELETE FROM routemate_telemetry");
		fix("DEV-701", NEAR, T - SEC);
		eq("§7 a zero radius measures nothing (never a silent \"outside\")", facts({ radiusM: 0 }), { localTz: "America/Chicago" });
		eq("§7 a (0, 0) pickup point is none: the zone from the fix", facts({ pickupPoint: () => ({ latitude: 0, longitude: 0 }) }), { localTz: "America/Chicago" });
		eq("§7 a link after the fix: never used", facts({ linkedSinceMs: () => T - 500 }), { localTz: "America/Chicago" });
		eq("§7 a link before it: used", facts({ linkedSinceMs: () => T - 5000 }).pickupZone, "inside");
		{
			const r = readers();
			fix("DEV-802", FAR, T - SEC);
			const out = lib.positionFacts({ enabled: true, newStatus: "At Shipper", loadId: "L-1", headers: H, row: ["L-1", DRIVER_A, "LX-802"], readers: r.fn });
			eq("§7 the Truck cell's unit first; the driver's truck not asked", [out.pickupZone, r.calls], ["outside", [["unit", "LX-802"]]]);
			const r2 = readers();
			lib.positionFacts({ enabled: true, newStatus: "At Shipper", loadId: "L-1", headers: H, row: ["L-1", DRIVER_A, "LX-999"], readers: r2.fn });
			eq("§7 a unit no truck has: the driver's truck", r2.calls, [["unit", "LX-999"], ["driver", DRIVER_A]]);
		}
		eq("§7 the status is read in any letter case and spacing", facts({}, ["L-1", DRIVER_A, ""], " at shipper ").pickupZone, "inside");
		let failed = null;
		const logged = await quietly(() => {
			failed = lib.positionFacts({ enabled: true, newStatus: "At Shipper", headers: H, row: [], readers: () => { throw new Error("made-up readers failure"); } });
		});
		eq("§7 the readers failing: the app zone, nothing else, and one line logged per failed lookup", [failed, logged.length > 0], [{ localTz: APP_ZONE }, true]);
		eq("§7 shipperZone(): the ELD days' banding of the pickup point, else the position, else the app zone",
			[[{ latitude: 34, longitude: -84 }, null], [{ latitude: 34, longitude: -85 }, null], [PICKUP, MOUNTAIN], [{ latitude: 35, longitude: -100 }, null],
				[{ latitude: 39, longitude: -114 }, null], [{ latitude: 34, longitude: -118 }, null], [null, MOUNTAIN], [null, null]].map(([p, f]) => lib.shipperZone(p, f)),
			["America/New_York", "America/New_York", "America/Chicago", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Denver", APP_ZONE]);
		const cand = (status, loadId = "L-9") => [{ loadId: "#L-1", status: "Dispatched" }, { loadId, status }];
		eq("§7 otherLoadHauling(): under way from the drive to the shipper until At Receiver",
			["Heading to Shipper", "At Shipper", " loading ", "IN TRANSIT", "At Receiver", "Unloading", "Dispatched", "Assigned", "Delivered"].map((s) => lib.otherLoadHauling(cand(s), "L-1")),
			[1, 1, 1, 1, 0, 0, 0, 0, 0]);
		eq("§7 otherLoadHauling(): the load itself never counts (its '#' spelling too); no list is unknown",
			[lib.otherLoadHauling(cand("In Transit", "l-1"), "#L-1"), lib.otherLoadHauling([], "L-1"), lib.otherLoadHauling(undefined, "L-1")], [0, 0, null]);
		eq("§7 geofenceFacts(): off, a departure, an arrival",
			[lib.geofenceFacts({ enabled: false, trigger: "At Shipper" }), lib.geofenceFacts({ enabled: true, trigger: "In Transit", fixMs: 5 }),
				lib.geofenceFacts({ enabled: true, trigger: "At Shipper", loadId: "L-1", fixMs: T - 70 * SEC, latitude: NEAR.latitude, longitude: NEAR.longitude, distanceM: 900, pickup: null, candidates: undefined })],
			[{}, { actorRole: "system" }, { actorRole: "system", fixMs: T - 70 * SEC, pickupDistanceM: 900, pickupZone: "inside", localTz: "America/Chicago", otherLoadHauling: null }]);
		const text = fs.readFileSync(LIB_FILE, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
		eq("§7 the module requires only geolib, ./eld-position and ./eld-miles, and reads no setting, file or network",
			[[...text.matchAll(/require\(([^)]{1,60})\)/g)].map((m) => m[1]).sort(), /\bprocess\.|\bfs\.|\bfetch\(|\bhttps?\b|child_process/.test(text)],
			[["\"./eld-miles\"", "\"./eld-position\"", "\"geolib\""], false]);
		eq("§7 the 5-minute window is a constant", lib.FIX_MAX_AGE_MS, 5 * MIN);
	}

	// ══ §8 ════════════════════════════════════════════════════════════════════
	section("§8 mutants, each caught");
	{
		const head = SRC.split("\n").find((l) => l.startsWith('app.put("/api/driver/status",')) || "";
		const route = head ? liftRoute(SRC, head) : "";
		const FROM = "actor: driverName, actorRole: req.session?.user?.role,";
		const mutantRoute = route.replace(FROM, "actor: driverName, actorRole: req.body.actorRole || req.body.role,");
		ok("§8 (anchor) the status route stores the session's role", !!route && mutantRoute !== route);
		if (mutantRoute !== route) {
			const src = SRC.replace(route, mutantRoute);
			const w = world({ loads: [LOAD("L-3001", "Heading to Shipper")], src });
			coordsFor(w, "L-3001", PICKUP, DROP);
			await tap(w, sess.driver(), "L-3001", "At Shipper", { role: "Super Admin", actorRole: "Dispatcher" });
			ok("§8 MUTANT the role from the body: caught (§2's \"never one the body names\" flips)", factsOf(lastRow(w)).actor_role !== "Driver", factsOf(lastRow(w)));
		}
	}
	const libText = lib ? fs.readFileSync(LIB_FILE, "utf8") : "";
	const libMutant = (from, to) => (libText.includes(from) ? libFrom(libText.replace(from, to)) : null);
	{
		const m = libMutant("return age >= 0 && age <= FIX_MAX_AGE_MS ? { ms, ...at } : null;", "return { ms, ...at };");
		ok("§8 (anchor) the module checks the fix's age", !!m);
		if (m) {
			const w = world({ loads: [LOAD("L-3002", "Heading to Shipper")], stubs: { arrivalRecorder: m } });
			coordsFor(w, "L-3002", PICKUP, DROP);
			fixAt(w, "DEV-701", 6 * MIN, NEAR);
			await tap(w, sess.driver(), "L-3002", "At Shipper");
			ok("§8 MUTANT \"inside\" from a stale fix: caught (§1's 6-minute case flips)", factsOf(lastRow(w)).pickup_zone === "inside", factsOf(lastRow(w)));
		}
	}
	{
		const m = libMutant("\t\tfixMs,\n\t\tpickupDistanceM: distanceM,", "\t\tfixMs: Date.now(),\n\t\tpickupDistanceM: distanceM,");
		ok("§8 (anchor) the module stores the geofence's ping time", !!m);
		if (m) {
			const w = geofenceWorld("In Transit");
			w.stubs.arrivalRecorder = m;
			const ping = livePing("DEV-701", NEAR, 70 * SEC);
			await poll(w, [ping]);
			const row = history(w).find((r) => r.load_id === "l-1201");
			ok("§8 MUTANT the processing time stored as the geofence row's fix: caught (§3's ping time flips)", !!row && row.fix_ms !== ping.location_date_ms, row && [row.fix_ms, ping.location_date_ms]);
		}
	}
	{
		const m = libMutant("/^(heading to shipper|at shipper|loading|in transit)$/i", "/^(heading to shipper|at shipper|loading|in transit|at receiver)$/i");
		ok("§8 (anchor) the module's under-way statuses", !!m);
		if (m) {
			const w = geofenceWorld("At Receiver");
			w.stubs.arrivalRecorder = m;
			await poll(w, [livePing("DEV-701", NEAR, 70 * SEC)]);
			const row = history(w).find((r) => r.load_id === "l-1201");
			ok("§8 MUTANT an At Receiver load counted as under way: caught (§3's 0 flips to 1)", !!row && row.other_load_hauling === 1, row && row.other_load_hauling);
		}
	}
}

const sha = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
// origin/main's answers for L-2001 after §6's day of work (its clock stamps fixed),
// recorded from a run on the base (SERVER_ROOT=<base> PRINT_ANSWERS=1).
const EXPECTED_HISTORY_SHA = "aacd85a434fa369d";
const EXPECTED_TRACKER_SHA = "b51bf62bc869208e";

main().then(() => {
	console.log(`\n${passed} passed, ${failures.length} failed`);
	process.exit(failures.length ? 1 : 0);
}, (e) => {
	console.error(`FAILED: ${e && e.stack ? e.stack : e}`);
	console.log(`\n${passed} passed, ${failures.length + 1} failed`);
	process.exit(1);
});
