#!/usr/bin/env node
/**
 * The driver stepper's GPS phases, the server's half (load phases PR 3;
 * DRIVER_STEPPER_GPS_PHASES_ENABLED, lib/gps-phases.js). With the flag on, each
 * active load in GET /api/driver/:driverName carries `_gpsPhases` { pickup, drop }:
 * can the geofence mark that stop's phases on its own right now? The app then
 * shows "GPS marks this" with a "Mark it myself" link on those steps
 * (scripts/test-stepper-gps-phases.mjs); who receives the key is pinned with the
 * route in scripts/test-driver-page-role-gate.js §9.
 *
 *   §0 the flag is on only when exactly "true"; the lib reaches no network module
 *   §1 server.js's own driverGpsPhases and gpsPhasesReaders(), lifted whole, on an
 *      in-memory SQLite with the shipped DDL: pickup true only with a mapped
 *      pickup point and a clean fix at most 30 minutes old taken since the
 *      device's link; false with a fix 31 minutes old, a truck with no device, no
 *      truck, no point, a fix from before the link, a (0, 0) fix or a dropped one;
 *      a fix stamped after the read is not the newest; an unknown link time keeps
 *      the fix; drop the same on the drop-off point; the Truck cell's truck before
 *      the driver's; the 30-minute edge is inclusive
 *   §2 which loads: active statuses only; the rows handed in are never written;
 *      the stored rows' cells decide (a view with the Truck cell stripped still
 *      gets its truck's answer); one telemetry read per truck
 *   §3 off: the same array back, no key, no statement run, no reader asked
 *   §4 failures: a reader, the points or the telemetry read failing reads false
 *      (or no key), never an error, and the lifted code never geocodes
 *   §5 mutants, each caught
 *
 * Every case but the §5 controls fails on the base (no flag, no module, no
 * readers). Made-up drivers, trucks, loads and places; no network.
 *   node scripts/test-stepper-gps-phases-server.js       # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const source = require("./lib/server-source");
const { indexDeclarations } = require("./lib/server-lift");

const SERVER_JS = source.resolveServerFile();
const SRC = source.serverSource();
const appRequire = createRequire(SERVER_JS);
const realRequire = (p) => (/^\.\.?\//.test(p) ? appRequire(p) : require(p));
const LIB_FILE = path.join(path.dirname(SERVER_JS), "lib", "gps-phases.js");

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
let lib = null;
try { lib = appRequire("./lib/gps-phases"); } catch { lib = null; }

for (const k of ["GEOFENCE_RADIUS_M", "DRIVER_STEPPER_GPS_PHASES_ENABLED"]) delete process.env[k];

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`  ok    ${name}`); return true; }
	failures.push(name);
	console.log(`  FAIL  ${name}${detail === undefined ? "" : `\n        ${JSON.stringify(detail)}`}`.slice(0, 2000));
	return false;
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
const section = (title) => console.log(`\n${title}`);

// ── the made-up world ──────────────────────────────────────────────────────────
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const DRIVER_A = "Driver Able";
const DRIVER_B = "Driver Baker"; // his truck has no device
const DRIVER_C = "Driver Cole"; // no truck
const PICKUP = { latitude: 32.5, longitude: -97.25 };
const DROP = { latitude: 33.2, longitude: -96.6 };
const HEADERS = ["Load ID", "Driver", "Pickup Address", "Drop-off Address", "Job Status", "Status Update Date", "Truck", "Rate"];
const load = (id, status, more = {}) => ({
	"Load ID": id, Driver: DRIVER_A, "Pickup Address": "100 Made Up Rd, Townville, TX 76000",
	"Drop-off Address": "200 Sample Ave, Cityburg, TX 75000", "Job Status": status, "Status Update Date": "", Truck: "", Rate: "1000", ...more,
});

function shipped(src, re, label) {
	const m = src.match(re);
	if (!m || m.length !== 1) throw new Error(`expected exactly 1 ${label} in server.js, found ${m ? m.length : 0}`);
	return m[0];
}
function ddl(src) {
	return [
		shipped(src, /CREATE TABLE IF NOT EXISTS routemate_telemetry \([\s\S]*?\n\t\)/g, "routemate_telemetry table"),
		...(src.match(/ALTER TABLE routemate_telemetry ADD COLUMN [^"`\n]*/g) || []),
		shipped(src, /CREATE INDEX IF NOT EXISTS idx_rm_tel_vid_date ON routemate_telemetry\([^)]*\)/g, "telemetry index"),
		shipped(src, /CREATE TABLE IF NOT EXISTS eld_device_assignments \([\s\S]*?\n\t\)/g, "eld_device_assignments table"),
		shipped(src, /CREATE TABLE IF NOT EXISTS load_coordinates \([\s\S]*?\n\t\)/g, "load_coordinates table"),
		...(src.match(/ALTER TABLE load_coordinates ADD COLUMN [^"`\n]*/g) || []),
		"CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, role TEXT, driver_name TEXT)",
		"CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT)",
		"CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, routemate_vehicle_id TEXT DEFAULT '', assigned_driver TEXT DEFAULT '', owner_id INTEGER DEFAULT 0)",
		"CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT DEFAULT '', end_date TEXT DEFAULT '')",
	];
}
function runDdl(db, statements) {
	for (const sql of statements) {
		if (/^ALTER TABLE/.test(sql)) { try { db.exec(sql); } catch { /* column already exists */ } } else db.exec(sql);
	}
}

// ── lifting: server.js's declarations, every name resolved to the shipped one
// unless stubbed ────────────────────────────────────────────────────────────────
const DENIED = new Set(["app", "server", "io", "publicTrack", "getSheets", "transporter", "sendEmail", "fetch",
	"geocodeAddress", "ensureLoadCoordinates", "getJobTrackingCached"]);
function makeScope(stubs, index) {
	const cache = Object.create(null);
	let proxy = null;
	const resolveTop = (key) => {
		if (Object.prototype.hasOwnProperty.call(cache, key)) return { found: true, value: cache[key] };
		const d = index.decls.get(key);
		if (!d) return { found: false };
		if (index.dupes.has(key)) throw new Error(`${key} is declared more than once at the top level of server.js`);
		if (DENIED.has(key)) throw new Error(`the lifted code reached ${key}, which it must never call`);
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

// Every statement run, by its SQL.
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

const MAIN_INDEX = indexDeclarations(SRC);
// A world: the database, server.js's scope over it, and the flag as given.
function world({ flag = true, src = SRC, index = MAIN_INDEX, stubs = {} } = {}) {
	const raw = new Database(":memory:");
	runDdl(raw, ddl(src));
	const log = [];
	const db = loggingDb(raw, log);
	const w = { raw, log, now0: Date.now() };
	w.stubs = { db, require: realRequire, console: { log() {}, warn() {}, info() {}, error() {} }, DRIVER_STEPPER_GPS_PHASES_ENABLED: flag, ...stubs };
	w.scope = makeScope(w.stubs, index);
	const run = (sql, ...args) => raw.prepare(sql).run(...args);
	for (const name of [DRIVER_A, DRIVER_B, DRIVER_C]) run("INSERT INTO users (username, role, driver_name) VALUES (?, 'Driver', ?)", name.toLowerCase(), name);
	run("INSERT INTO trucks (id, unit_number, routemate_vehicle_id, assigned_driver) VALUES (7, 'LX-701', 'DEV-701', ?)", DRIVER_A);
	run("INSERT INTO trucks (id, unit_number, routemate_vehicle_id, assigned_driver) VALUES (8, 'LX-802', '', ?)", DRIVER_B);
	run("INSERT INTO trucks (id, unit_number, routemate_vehicle_id, assigned_driver) VALUES (9, 'LX-903', 'DEV-903', '')");
	run("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (7, ?, ?)", DRIVER_A, new Date(w.now0 - 3 * DAY).toISOString());
	run("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (8, ?, ?)", DRIVER_B, new Date(w.now0 - 3 * DAY).toISOString());
	run("INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from, assigned_by) VALUES (7, 'DEV-701', ?, 'admin_test')", new Date(w.now0 - 2 * DAY).toISOString());
	run("INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from, assigned_by) VALUES (9, 'DEV-903', ?, 'admin_test')", new Date(w.now0 - 2 * DAY).toISOString());
	return w;
}
const fixAt = (w, vid, ago, at = PICKUP, dropped = "") => w.raw.prepare(
	"INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, location_date_ms, dropped_reason) VALUES (?, ?, ?, ?, ?)")
	.run(vid, at.latitude, at.longitude, w.now0 - ago, dropped);
const coordsFor = (w, loadId, pickup, drop) => w.raw.prepare(
	"INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng) VALUES (?, ?, ?, ?, ?)")
	.run(loadId, pickup ? pickup.latitude : null, pickup ? pickup.longitude : null, drop ? drop.latitude : null, drop ? drop.longitude : null);
const relink = (w, vid, from, by = "admin_test") => w.raw.prepare("UPDATE eld_device_assignments SET assigned_from = ?, assigned_by = ? WHERE routemate_vehicle_id = ?").run(from, by, vid);

// server.js's own driverGpsPhases, or null where the base has none.
function shippedPhases(w) {
	try { return MAIN_INDEX.decls.has("driverGpsPhases") || w.stubs.driverGpsPhases ? w.scope.driverGpsPhases : null; } catch { return null; }
}
// The lib over server.js's own readers, with the clock given (the edges).
function libPhases(w, nowMs, l = lib) {
	if (!l || !MAIN_INDEX.decls.has("gpsPhasesReaders")) return null;
	return l.create({ enabled: true, readers: () => w.scope.gpsPhasesReaders(), now: () => nowMs, log: w.stubs.console });
}
const annotateWith = (phases, rows, src = rows) => (phases ? phases.annotate(rows, src, HEADERS) : rows);
const answers = (rows) => rows.map((r) => [r["Load ID"], "_gpsPhases" in r ? r._gpsPhases : "(no key)"]);
const one = (phases, row) => { const out = annotateWith(phases, [row]); return "_gpsPhases" in out[0] ? out[0]._gpsPhases : "(no key)"; };
const BOTH = { pickup: true, drop: true };
const NONE = { pickup: false, drop: false };

// A mutated copy of the lib, compiled beside the real one.
function libFrom(text) {
	const m = { exports: {} };
	new Function("require", "module", "exports", text)(createRequire(LIB_FILE), m, m.exports);
	return m.exports;
}
function mutate(text, from, to) {
	const n = text.split(from).length - 1;
	if (n !== 1) throw new Error(`mutant target found ${n}x (expected 1): ${from.slice(0, 70)}`);
	return text.replace(from, to);
}

function main() {
	// ══ §0 ════════════════════════════════════════════════════════════════════
	section("§0 the flag and the module");
	{
		const line = (SRC.match(/^const DRIVER_STEPPER_GPS_PHASES_ENABLED = ([^\n]+);$/m) || [])[1];
		ok("§0 server.js reads DRIVER_STEPPER_GPS_PHASES_ENABLED once, at the top level", !!line);
		const read = (value) => (line ? new Function("process", `return (${line});`)({ env: { DRIVER_STEPPER_GPS_PHASES_ENABLED: value } }) : null);
		eq("§0 on only when exactly \"true\"", ["true", "TRUE", "True", "1", "yes", "on", " true", "true ", "", undefined].map(read),
			[true, false, false, false, false, false, false, false, false, false]);
		ok("§0 lib/gps-phases.js loads", !!lib);
		const text = fs.existsSync(LIB_FILE) ? fs.readFileSync(LIB_FILE, "utf8") : "";
		const requires = [...text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]).sort();
		eq("§0 it requires only ./arrival-recorder and ./eld-position (no network, no geocoder)", requires, ["./arrival-recorder", "./eld-position"]);
		eq("§0 the 30-minute bound is a constant", lib ? lib.FIX_MAX_AGE_MS : null, 30 * MIN);
	}

	// ══ §1 ════════════════════════════════════════════════════════════════════
	section("§1 the rule, through server.js's own driverGpsPhases and readers");
	{
		const w = world();
		const phases = shippedPhases(w);
		ok("§1 server.js builds driverGpsPhases from lib/gps-phases.js with its flag", !!phases && phases.enabled === true);
		coordsFor(w, "L-2001", PICKUP, DROP);
		fixAt(w, "DEV-701", 10 * MIN);
		eq("§1.1 both points mapped and a fix 10 minutes old since the link: pickup and drop true",
			one(phases, load("L-2001", "Heading to Shipper")), BOTH);
		coordsFor(w, "L-2002", PICKUP, null);
		eq("§1.2 only the pickup point mapped: pickup true, drop false", one(phases, load("L-2002", "Loading")), { pickup: true, drop: false });
		coordsFor(w, "L-2003", null, DROP);
		eq("§1.3 only the drop-off point mapped: pickup false, drop true", one(phases, load("L-2003", "In Transit")), { pickup: false, drop: true });
		eq("§1.4 no point at all (no load_coordinates row): both false", one(phases, load("L-2004", "Heading to Shipper")), NONE);
		coordsFor(w, "L-2005", { latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 });
		eq("§1.5 a (0, 0) point is a failed geocode, not a mapped stop: both false", one(phases, load("L-2005", "Heading to Shipper")), NONE);
		coordsFor(w, "L-2006", PICKUP, DROP);
		eq("§1.6 the driver's truck has no device: both false", one(phases, load("L-2006", "Heading to Shipper", { Driver: DRIVER_B })), NONE);
		eq("§1.7 the driver has no truck: both false", one(phases, load("L-2006", "Heading to Shipper", { Driver: DRIVER_C })), NONE);
		eq("§1.8 the load's Truck cell names a truck before the driver's own: that truck (its device has no fix yet), both false",
			one(phases, load("L-2006", "Heading to Shipper", { Truck: "LX-903" })), NONE);
		fixAt(w, "DEV-903", 5 * MIN);
		eq("§1.9 ...and once that truck reports: true, though the driver's own truck reports too",
			one(shippedPhases(w), load("L-2006", "Heading to Shipper", { Truck: "LX-903", Driver: DRIVER_C })), BOTH);
		ok("§1.10 the rows' answer is read from the database, never the network (no geocode reached)",
			!w.log.some((sql) => /geocode_cache/i.test(sql)));
	}
	{
		const w = world();
		coordsFor(w, "L-2101", PICKUP, DROP);
		const row = load("L-2101", "Heading to Shipper");
		fixAt(w, "DEV-701", 31 * MIN);
		eq("§1.11 the newest fix is 31 minutes old: both false", one(shippedPhases(w), row), NONE);
		const w2 = world();
		coordsFor(w2, "L-2101", PICKUP, DROP);
		fixAt(w2, "DEV-701", 30 * MIN);
		eq("§1.12 the 30-minute edge is inclusive: a fix exactly 30 minutes old counts", one(libPhases(w2, w2.now0), row), BOTH);
		eq("§1.13 ...and 1 ms later it doesn't", one(libPhases(w2, w2.now0 + 1), row), NONE);
	}
	{
		const w = world();
		coordsFor(w, "L-2201", PICKUP, DROP);
		const row = load("L-2201", "In Transit");
		fixAt(w, "DEV-701", 3 * MIN, PICKUP, "speed_outlier");
		eq("§1.14 a dropped fix is no report: both false", one(shippedPhases(w), row), NONE);
		fixAt(w, "DEV-701", 2 * MIN, { latitude: 0, longitude: 0 });
		eq("§1.15 the newest clean fix is (0, 0), a lost satellite fix: both false", one(shippedPhases(w), row), NONE);
	}
	{
		const w = world();
		coordsFor(w, "L-2301", PICKUP, DROP);
		const row = load("L-2301", "In Transit");
		fixAt(w, "DEV-701", 12 * MIN);
		fixAt(w, "DEV-701", -10 * MIN); // stamped 10 minutes ahead of the clock
		eq("§1.16 a fix stamped after the read is not the newest: the 12-minute fix counts, both true", one(shippedPhases(w), row), BOTH);
		const w2 = world();
		coordsFor(w2, "L-2301", PICKUP, DROP);
		fixAt(w2, "DEV-701", 40 * MIN);
		fixAt(w2, "DEV-701", -10 * MIN);
		eq("§1.16b ...and with only a 40-minute fix before the read, the one stamped ahead doesn't make it fresh: both false",
			one(libPhases(w2, w2.now0), row), NONE);
		relink(w, "DEV-701", new Date(w.now0 - 5 * MIN).toISOString());
		eq("§1.17 the device was linked 5 minutes ago and the fix is 12 minutes old (taken on another truck): both false",
			one(shippedPhases(w), row), NONE);
		relink(w, "DEV-701", new Date(w.now0 - 5 * MIN).toISOString(), "system:boot");
		eq("§1.18 the same with an unknown link time (opened by the boot reconcile): the fix is kept, both true",
			one(shippedPhases(w), row), BOTH);
	}

	// ══ §2 ════════════════════════════════════════════════════════════════════
	section("§2 which loads, and what is read");
	{
		const w = world();
		for (const id of ["L-2401", "L-2402", "L-2403", "L-2404", "L-2405", "L-2406"]) coordsFor(w, id, PICKUP, DROP);
		fixAt(w, "DEV-701", 4 * MIN);
		const rows = [
			load("L-2401", "Assigned"), load("L-2402", "Dispatched"), load("L-2403", "At Receiver"),
			load("L-2404", "Delivered"), load("L-2405", "Cancelled"), load("L-2406", "Pending"),
		];
		const before = JSON.stringify(rows);
		w.log.length = 0;
		const out = annotateWith(shippedPhases(w), rows);
		eq("§2.1 active statuses get the key; Delivered, Cancelled and any other status don't", answers(out), [
			["L-2401", BOTH], ["L-2402", BOTH], ["L-2403", BOTH], ["L-2404", "(no key)"], ["L-2405", "(no key)"], ["L-2406", "(no key)"],
		]);
		ok("§2.2 the rows handed in are never written (new objects come back)", JSON.stringify(rows) === before && out[0] !== rows[0]);
		eq("§2.3 one telemetry read for the driver's one truck, however many loads", w.log.filter((sql) => /FROM routemate_telemetry/.test(sql)).length, 1);
		// The route hands in the role's view and the rows as stored, index for index.
		const view = [{ "Load ID": "L-2401", "Job Status": "Assigned" }];
		const stored = [load("L-2401", "Assigned", { Truck: "LX-903", Driver: DRIVER_C })];
		eq("§2.4 the stored rows decide: a view without the Truck and Driver cells still gets the stored truck's answer (no fix: false)",
			answers(annotateWith(shippedPhases(w), view, stored)), [["L-2401", NONE]]);
		fixAt(w, "DEV-903", 1 * MIN);
		eq("§2.5 ...true once that truck reports", answers(annotateWith(shippedPhases(w), view, stored)), [["L-2401", BOTH]]);
		const keys = annotateWith(shippedPhases(w), view, stored)[0];
		eq("§2.6 the view's own cells stay as they were (nothing copied in from the stored row)", Object.keys(keys).sort(), ["Job Status", "Load ID", "_gpsPhases"]);
	}

	// ══ §3 ════════════════════════════════════════════════════════════════════
	section("§3 off");
	{
		let asked = 0;
		const w = world({ flag: false, stubs: { gpsPhasesReaders: () => { asked++; throw new Error("asked with the flag off"); } } });
		coordsFor(w, "L-2501", PICKUP, DROP);
		fixAt(w, "DEV-701", 4 * MIN);
		const rows = [load("L-2501", "In Transit")];
		w.log.length = 0;
		const phases = shippedPhases(w);
		const out = phases ? phases.annotate(rows, rows, HEADERS) : null;
		ok("§3.1 off: the same array back, no key, no statement, no reader asked",
			!!phases && phases.enabled === false && out === rows && !("_gpsPhases" in rows[0]) && w.log.length === 0 && asked === 0,
			{ enabled: phases && phases.enabled, same: out === rows, log: w.log, asked });
	}

	// ══ §4 ════════════════════════════════════════════════════════════════════
	section("§4 failures read as false");
	// The lib logs each failed lookup on console.error; kept, and counted.
	const quietly = (fn) => {
		const original = console.error;
		const lines = [];
		console.error = (...a) => lines.push(a.map(String).join(" "));
		try { return { value: fn(), lines }; } finally { console.error = original; }
	};
	{
		const w = world({ stubs: { gpsPhasesReaders: () => { throw new Error("made-up readers failure"); } } });
		const rows = [load("L-2601", "In Transit")];
		let threw = false;
		let run = { value: null, lines: [] };
		try { run = quietly(() => { const p = shippedPhases(w); return p ? p.annotate(rows, rows, HEADERS) : null; }); } catch { threw = true; }
		ok("§4.1 the readers failing: no throw, rows back without the key (today's button), one logged line",
			!threw && run.value === rows && !("_gpsPhases" in rows[0]) && run.lines.length === 1 && /\[gps-phases\] the readers lookup failed/.test(run.lines[0]),
			{ threw, lines: run.lines });
	}
	const shippedReaders = (w) => (MAIN_INDEX.decls.has("gpsPhasesReaders") ? w.scope.gpsPhasesReaders : null);
	{
		const w = world();
		const real = shippedReaders(w);
		if (real) w.stubs.gpsPhasesReaders = () => ({ ...real(), points: () => { throw new Error("made-up points failure"); } });
		const run = real ? quietly(() => one(shippedPhases(w), load("L-2701", "In Transit"))) : { value: "no readers in server.js" };
		eq("§4.2 the points lookup failing: both false", run.value, NONE);
	}
	{
		const w = world();
		coordsFor(w, "L-2801", PICKUP, DROP);
		fixAt(w, "DEV-701", 4 * MIN);
		const real = shippedReaders(w);
		if (real) w.stubs.gpsPhasesReaders = () => ({ ...real(), db: { prepare: () => ({ get: () => { throw new Error("made-up telemetry failure"); } }) } });
		const run = real ? quietly(() => one(shippedPhases(w), load("L-2801", "In Transit"))) : { value: "no readers in server.js" };
		eq("§4.3 the telemetry read failing: both false", run.value, NONE);
	}
	{
		const fn = MAIN_INDEX.decls.get("gpsPhasesReaders");
		ok("§4.4 gpsPhasesReaders() takes both points from resolveGeofencePoints() and never names the geocoder",
			!!fn && /resolveGeofencePoints\(/.test(fn.text) && !/geocodeAddress|ensureLoadCoordinates|fetch\(/.test(fn.text));
	}

	// ══ §5 ════════════════════════════════════════════════════════════════════
	section("§5 mutants");
	const text = fs.existsSync(LIB_FILE) ? fs.readFileSync(LIB_FILE, "utf8") : "";
	const caseWorld = () => {
		const w = world();
		coordsFor(w, "L-2901", PICKUP, DROP);
		coordsFor(w, "L-2902", PICKUP, null);
		return w;
	};
	const runMutant = (label, from, to, check) => {
		if (!text) { ok(`${label}: the module exists to mutate`, false); return; }
		let m;
		try { m = libFrom(mutate(text, from, to)); } catch (e) { ok(`${label}: the mutant applies (${e.message})`, false); return; }
		ok(label, check(m));
	};
	runMutant("M1 the age bound dropped: a 31-minute fix counts (§1.11 caught)", "return age <= FIX_MAX_AGE_MS;", "return true;", (m) => {
		const w = caseWorld(); fixAt(w, "DEV-701", 31 * MIN);
		return JSON.stringify(one(libPhases(w, w.now0, m), load("L-2901", "In Transit"))) === JSON.stringify(BOTH);
	});
	runMutant("M2 the link check dropped: a fix from before the link counts (§1.17 caught)",
		"if (eldPosition.fixPredatesLink(ms, r.linkedSinceMs(truck.id, truck.vid))) return false;", "", (m) => {
			const w = caseWorld(); fixAt(w, "DEV-701", 12 * MIN); relink(w, "DEV-701", new Date(w.now0 - 5 * MIN).toISOString());
			return JSON.stringify(one(libPhases(w, w.now0, m), load("L-2901", "In Transit"))) === JSON.stringify(BOTH);
		});
	runMutant("M3 no upper bound on the fix's time: a fix stamped ahead counts as fresh (§1.16b caught)",
		"AND location_date_ms <= ?", "AND location_date_ms <= ? + 86400000", (m) => {
			const w = caseWorld(); fixAt(w, "DEV-701", 40 * MIN); fixAt(w, "DEV-701", -10 * MIN);
			return JSON.stringify(one(libPhases(w, w.now0, m), load("L-2901", "In Transit"))) === JSON.stringify(BOTH);
		});
	runMutant("M4 a (0, 0) fix counted (§1.15 caught)", "if (!row || !arrivalRecorder.place(row)) return false;", "if (!row) return false;", (m) => {
		const w = caseWorld(); fixAt(w, "DEV-701", 2 * MIN, { latitude: 0, longitude: 0 });
		return JSON.stringify(one(libPhases(w, w.now0, m), load("L-2901", "In Transit"))) === JSON.stringify(BOTH);
	});
	runMutant("M5 every status annotated: a Delivered load gets the key (§2.1 caught)",
		"if (!src || !ACTIVE_RE.test(text(src[statusCol]).trim())) return row;", "if (!src) return row;", (m) => {
			const w = caseWorld(); fixAt(w, "DEV-701", 2 * MIN);
			return one(libPhases(w, w.now0, m), load("L-2901", "Delivered")) !== "(no key)";
		});
	runMutant("M6 drop read off the pickup point: a load with no drop-off point says drop true (§1.2 caught)",
		"const dropMapped = !!arrivalRecorder.place(points.dest);", "const dropMapped = !!arrivalRecorder.place(points.origin);", (m) => {
			const w = caseWorld(); fixAt(w, "DEV-701", 2 * MIN);
			return JSON.stringify(one(libPhases(w, w.now0, m), load("L-2902", "Loading"))) === JSON.stringify(BOTH);
		});
	runMutant("M7 pickup without a mapped pickup point (§1.3 caught)",
		"const pickupMapped = !!arrivalRecorder.place(points.origin);", "const pickupMapped = true;", (m) => {
			const w = caseWorld(); coordsFor(w, "L-2903", null, DROP); fixAt(w, "DEV-701", 2 * MIN);
			return JSON.stringify(one(libPhases(w, w.now0, m), load("L-2903", "In Transit"))) === JSON.stringify(BOTH);
		});
	runMutant("M8 the flag ignored: off still annotates (§3.1 caught)", "const on = enabled === true;", "const on = true;", (m) => {
		const w = caseWorld(); fixAt(w, "DEV-701", 2 * MIN);
		const p = m.create({ enabled: false, readers: () => w.scope.gpsPhasesReaders(), now: () => w.now0 });
		const rows = [load("L-2901", "In Transit")];
		return p.annotate(rows, rows, HEADERS)[0]._gpsPhases !== undefined;
	});
	runMutant("M9 the view's cells read instead of the stored row's (§2.4 caught)",
		"const src = Array.isArray(sourceRows) && sourceRows[i] && typeof sourceRows[i] === \"object\" ? sourceRows[i] : row;", "const src = row;", (m) => {
			const w = caseWorld(); fixAt(w, "DEV-903", 1 * MIN);
			const view = [{ "Load ID": "L-2901", "Job Status": "Assigned" }];
			const stored = [load("L-2901", "Assigned", { Truck: "LX-903", Driver: DRIVER_C })];
			const p = m.create({ enabled: true, readers: () => w.scope.gpsPhasesReaders(), now: () => w.now0 });
			return JSON.stringify(p.annotate(view, stored, HEADERS)[0]._gpsPhases) === JSON.stringify(NONE);
		});
	runMutant("M10 no per-truck answer kept: three loads, three telemetry reads (§2.3 caught)",
		"if (!answered.has(key)) answered.set(key,", "if (true) answered.set(key,", (m) => {
			const w = caseWorld(); fixAt(w, "DEV-701", 2 * MIN);
			const p = m.create({ enabled: true, readers: () => w.scope.gpsPhasesReaders(), now: () => w.now0 });
			w.log.length = 0;
			p.annotate([load("L-2901", "Assigned"), load("L-2901", "Loading"), load("L-2902", "In Transit")], undefined, HEADERS);
			return w.log.filter((sql) => /FROM routemate_telemetry/.test(sql)).length === 3;
		});
	{
		// The server.js mutant: the flag read in the looser shape other flags use.
		const line = (SRC.match(/^const DRIVER_STEPPER_GPS_PHASES_ENABLED = ([^\n]+);$/m) || [])[1] || "";
		const loose = line.split('=== "true"').length === 2
			? `/^(true|1|yes|on)$/i.test(String(${line.replace(' === "true"', "")} ?? "").trim())` : "";
		const read = (expr, value) => new Function("process", `return (${expr});`)({ env: { DRIVER_STEPPER_GPS_PHASES_ENABLED: value } });
		ok("M11 the flag read as any \"on\" word: \"1\" and \" true\" turn it on (§0 caught)",
			!!loose && read(loose, "1") === true && read(loose, " true") === true && read(line, "1") === false);
	}
	{
		// Controls: the mutants' worlds answer as §1-§3 say on the unmutated module.
		const w = caseWorld(); fixAt(w, "DEV-701", 2 * MIN);
		eq("§5 control: the unmutated module on the mutants' world", [one(libPhases(w, w.now0), load("L-2901", "In Transit")), one(libPhases(w, w.now0), load("L-2902", "Loading"))],
			[BOTH, { pickup: true, drop: false }]);
	}
}

try {
	main();
} catch (err) {
	failures.push(`crashed: ${err && err.message}`);
	console.log(`  FAIL  the runner crashed: ${err && err.stack ? err.stack : err}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
