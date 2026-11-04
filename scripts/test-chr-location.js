#!/usr/bin/env node
// lib/chr-location.js and the sweep's location tick (R5 PR 4-shell: addendum
// R3.5, 10-28 PR 4): location along the route for a C.H. Robinson load, from the
// truck's clean RouteMate fixes, never from a driver's phone. In-memory SQLite,
// a made-up Job Tracking reader, made-up truck and device histories, a made-up
// clock; nothing reaches the network.
//
//   §1  the pure rules: the buckets, the window (it fails closed), the fix for a
//       bucket (newest, clean, at most 20 minutes old, from the device on the
//       truck at the fix's own time), the four-key payload; another driver's
//       truck or a re-dispatch closes the window
//   §2  the plan's failing case: with both switches on and Location in Dry run,
//       a made-up CHR load in transit gets one dry_run row per 15-minute bucket,
//       each holding exactly the four keys
//   §3  the window: nothing before the confirmed departure, nothing for a held
//       departure, nothing once a final event or a status past transit is
//       recorded, nothing after the load turns multi-stop, nothing past 72 hours
//   §4  the fixes: Linxup, untagged and dropped rows never used; a 21-minute-old
//       fix gives no row; a fix from before the device's link never used; a truck
//       change mid-load reads the new truck's device; one row per bucket
//   §5  the switches: CHR_LOCATION_ENABLED off, or the page's Location Off, gives
//       none; recording starts from the switch-on, never earlier
//   §6  Live (a made-up transport): sent after the milestones; a newer bucket
//       supersedes an older one still waiting; a stale one is given up
//   §7  canaries: a driver's name and phone in the sheet, the history, a fix's
//       geocoded address and the phone-GPS table reach no row, state, audit or
//       log; the phone-GPS table is never read
//   §8  the source: chr-location.js is pure, reads named columns with the
//       clean-RouteMate filter, never the geocoded address
//   §9  mutants of the pure rules
//   §10 the tick across a trip's events: a load handed to another driver
//       mid-route, a re-dispatch, a final event, a status past transit, a hold,
//       a reverted departure; and mutants of the tick that reopen the window
//
// Made-up data only (loads 123456789 and 223456789, trucks T-101 and T-102).
//   node scripts/test-chr-location.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { createRequire } = require("module");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const LOC_FILE = path.join(ROOT, "lib", "chr-location.js");
const LOC_SRC = fs.existsSync(LOC_FILE) ? fs.readFileSync(LOC_FILE, "utf8") : "";
const libRequire = createRequire(LOC_FILE);
const E = require(path.join(ROOT, "lib", "chr-events.js"));
const S = require(path.join(ROOT, "lib", "chr-store.js"));
const W = require(path.join(ROOT, "lib", "chr-sweep.js"));
const I = require(path.join(ROOT, "lib", "chr-integration.js"));

const failures = [];
let pass = 0;
let C = null;
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	const t = C || { failures, pass: 0 };
	if (a === e) { if (C) C.pass++; else pass++; return; }
	t.failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function section(t) { console.log(`\n${t}`); }

let networkCalls = 0;
const refuse = () => { networkCalls++; throw new Error("network refused in test-chr-location"); };
globalThis.fetch = refuse;
http.request = refuse; http.get = refuse; https.request = refuse; https.get = refuse;

const MIN = 60 * 1000;
const T0 = Date.parse("2026-11-02T15:00:00Z");
const CANARY = Object.freeze({ name: "Canary Testdriver", phone: "(555) 555-0147", street: "742 Evergreen Terrace", phoneGps: "canary-phone-gps-0001" });
const PICKUP = { latitude: 42.0347, longitude: -93.62 };
const DROP = { latitude: 41.525, longitude: -88.0817 };
const AT_PICKUP = { lat: 42.035, lng: -93.6195 };
const HEADERS = ["Load ID", "Status", "Driver", "Email", "Trailer Number", "Pickup Address", "Drop-off Address", "Payment"];
const sheetRow = (loadId, over = {}) => ({
	"Load ID": loadId, Status: "In Transit", Driver: CANARY.name, Email: "made-up.agent@chrobinson.com", "Trailer Number": "53001",
	"Pickup Address": "100 Test Rd, Ames, IA 50010", "Drop-off Address": "200 Sample Ave, Joliet, IL 60431", Payment: "$1,234.56", ...over,
});
// Along the road east of the pickup, about 1.6 km a minute.
const road = (min) => ({ lat: 42.0347, lng: -93.62 + 0.02 * min });
const iso = (ms) => new Date(ms).toISOString();

function loadModule(text) {
	const mod = { exports: {} };
	new Function("require", "module", "exports", text)(libRequire, mod, mod.exports);
	return mod.exports;
}

// A made-up world. trucks(name, ms) -> { truck_id, unit } | null; devices(truckId, ms) -> device id.
function world({ config = { updatesEnabled: true, locationEnabled: true }, settings = { location: "dry_run" }, sheetRows = [sheetRow("123456789")], trucks = null, devices = null, transport = null } = {}) {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
		CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '', new_status TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'manual', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP, reason TEXT DEFAULT '');
		CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT NOT NULL, latitude REAL, longitude REAL,
			speed REAL DEFAULT 0, geocoded_location TEXT DEFAULT '', location_date_ms INTEGER DEFAULT 0, dropped_reason TEXT DEFAULT '', source TEXT DEFAULT '');
		CREATE TABLE driver_locations (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, latitude REAL, longitude REAL, note TEXT);
	`);
	db.prepare("INSERT INTO driver_locations (driver_name, latitude, longitude, note) VALUES (?, 42.1, -93.1, ?)").run(CANARY.name, CANARY.phoneGps);
	S.writeSettings(db, { ...S.DEFAULT_SETTINGS, ...settings }, { by: "admin.one", nowIso: iso(T0 - 60 * MIN) });
	const w = { db, clock: T0, audits: [], logs: [], notices: [], sheetRows };
	const truckAt = trucks || ((name) => (String(name).toLowerCase() === CANARY.name.toLowerCase() ? { truck_id: 1, unit: "T-101" } : null));
	const deviceAt = devices || ((id) => (id === 1 ? "RM-TEST-1" : id === 2 ? "RM-TEST-2" : ""));
	const deps = {
		db,
		config: I.chrConfig(config),
		readSheet: async () => new Map(w.sheetRows.map((r) => { const p = E.projectRow(r, HEADERS); return [p.loadKey, p]; })),
		stopPointsFor: () => ({ origin: PICKUP, dest: DROP }),
		truckResolver: () => ({ forDriverAt: (name, ms) => (Number.isFinite(ms) ? truckAt(name, ms) : null) }),
		deviceResolver: () => ({ vehicleForTruckAt: (id, ms) => deviceAt(id, ms) }),
		instructionStopsFor: () => null,
		logAudit: (actor, action, entity, entityId, details) => w.audits.push({ action, entityId, details }),
		notify: (n) => w.notices.push(n),
		now: () => w.clock,
		log: { info: (...a) => w.logs.push(a.join(" ")), warn: (...a) => w.logs.push(a.join(" ")), error: (...a) => w.logs.push(a.join(" ")) },
	};
	if (transport) {
		const sweep = W.createSweep({ ...deps, transport });
		w.tick = () => sweep.tick();
	} else {
		const inst = I.create(deps);
		w.tick = () => inst.sweep();
	}
	w.runTo = async (ms) => { while (w.clock < ms) { w.clock += MIN; await w.tick(); } };
	w.stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
	w.history = (load, status, ms, source = "manual") => db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, changed_at, reason) VALUES (?, '', ?, ?, ?, ?, ?)")
		.run(load, status, source, `${CANARY.name} ${CANARY.phone}`, w.stamp(ms), `made-up note ${CANARY.phone}`).lastInsertRowid;
	w.fix = (ms, p, { device = "RM-TEST-1", speed = 20, source = "routemate", dropped = "" } = {}) => db.prepare(`INSERT INTO routemate_telemetry
		(routemate_vehicle_id, latitude, longitude, speed, location_date_ms, dropped_reason, source, geocoded_location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(device, p.lat, p.lng, speed, ms, dropped, source, `${CANARY.street}, Ames, IA`);
	w.locs = () => db.prepare("SELECT load_id, event_at, mode, status, payload_json, created_at FROM chr_events WHERE kind = 'location' ORDER BY id").all();
	w.milestones = () => db.prepare("SELECT load_id, event, status, verify FROM chr_events WHERE kind = 'milestone' ORDER BY id").all();
	return w;
}

// A departure at T0+2, confirmed (a fix at the pickup before, a moving one outside after),
// then a fix every 5 minutes along the road.
function departAndDrive(w, { load = "123456789", device = "RM-TEST-1", untilMin = 60 } = {}) {
	w.fix(T0 + 1 * MIN, AT_PICKUP, { device, speed: 0 });
	w.history(load, "In Transit", T0 + 2 * MIN);
	for (let m = 4; m <= untilMin; m += (m === 4 ? 1 : 5)) w.fix(T0 + m * MIN, road(m), { device });
}

// ------------------------------------------------------------------ §1 (also run on mutants)
function checkPure(t, L) {
	const prev = C;
	C = t;
	try {
		eq([L.bucketOf(T0 + 7 * MIN, 15), L.lastClosedBucket(T0 + 15 * MIN, 15), L.lastClosedBucket(T0 + 29 * MIN, 15), L.bucketOf(T0 + 61 * MIN, 60)],
			[{ startMs: T0, endMs: T0 + 15 * MIN }, { startMs: T0, endMs: T0 + 15 * MIN }, { startMs: T0, endMs: T0 + 15 * MIN }, { startMs: T0 + 60 * MIN, endMs: T0 + 120 * MIN }],
			"§1 buckets: aligned to the clock, 15 minutes (or the interval); the last closed one");
		eq(L.bucketOf(T0, 5).endMs - L.bucketOf(T0, 5).startMs, 15 * MIN, "§1 ...never shorter than 15 minutes");
		const dep = { atMs: T0 + 2 * MIN };
		eq([L.windowFor({ departure: null }).why, L.windowFor({ departure: dep, blocked: true }).why, L.windowFor({ departure: dep, finals: 1 }).why,
			L.windowFor({ departure: dep, statuses: ["In Transit", "At Receiver"] }).why, L.windowFor({ departure: dep, statuses: ["delivered"] }).why,
			L.windowFor({ departure: dep, statuses: ["At  Receiver"] }).why, L.windowFor({ departure: dep, sameTruck: false }).why, L.windowFor({ departure: dep, redispatched: true }).why],
		["no_departure", "blocked", "final_event", "past_transit", "past_transit", "past_transit", "other_truck", "redispatched"],
		"§1 the window stays shut: no confirmed departure, a hold or multi-stop, any final event, a status past transit (spacing aside), another driver's truck, a re-dispatch");
		eq(L.windowFor({ departure: dep, statuses: ["In Transit"] }), { open: true, startMs: T0 + 2 * MIN, endMs: T0 + 2 * MIN + 72 * 60 * MIN, why: "" }, "§1 ...otherwise open from the departure, for 72 hours at most");
		const truckAt = (ms) => (ms < T0 + 30 * MIN ? { truck_id: 1 } : { truck_id: 2 });
		const deviceAt = (id, ms) => (id === 1 ? (ms >= T0 + 5 * MIN ? "RM-TEST-1" : "") : "RM-TEST-2");
		const win = { startMs: T0 + 2 * MIN, endMs: T0 + 72 * 60 * MIN };
		const bucket = { startMs: T0, endMs: T0 + 15 * MIN };
		const fx = (min, over = {}) => ({ ms: T0 + min * MIN, lat: 42.03, lng: -93.5, source: "routemate", dropped_reason: "", ...over });
		const pick = (fixes, nowMin, device = "RM-TEST-1", b = bucket) => L.pickFix(fixes, { bucket: b, window: win, nowMs: T0 + nowMin * MIN, device, truckAt, deviceAt });
		eq(pick([fx(6), fx(12), fx(9)], 15), { ms: T0 + 12 * MIN, lat: 42.03, lng: -93.5 }, "§1 the newest clean fix in the bucket");
		eq(pick([fx(12)], 32), { ms: T0 + 12 * MIN, lat: 42.03, lng: -93.5 }, "§1 ...20 minutes old: still fresh");
		eq(pick([fx(12)], 33), null, "§1 ...21 minutes old: no row");
		eq(pick([fx(1), fx(16)], 17), null, "§1 a fix before the departure or outside the bucket: none");
		eq(pick([fx(4)], 15), null, "§1 a fix from before the device's link to the truck: never");
		eq([pick([fx(12, { source: "linxup" })], 15), pick([fx(12, { source: "" })], 15), pick([fx(12, { dropped_reason: "jump" })], 15), pick([fx(12, { lat: 0, lng: 0 })], 15)],
			[null, null, null, null], "§1 Linxup, untagged, dropped and (0, 0) fixes: never");
		const later = { startMs: T0 + 30 * MIN, endMs: T0 + 45 * MIN };
		eq([pick([fx(40)], 45, "RM-TEST-1", later), pick([fx(40)], 45, "RM-TEST-2", later)], [null, { ms: T0 + 40 * MIN, lat: 42.03, lng: -93.5 }],
			"§1 after a truck change, only the new truck's device counts");
		const p = L.buildLocationPayload({ loadId: "#123456789", fix: { ms: T0 + 12 * MIN + 345, lat: 42.034712, lng: -93.519851 } });
		eq(p, { loadNumber: "123456789", event: "location", eventAt: "2026-11-02T15:12:00Z", position: { lat: 42.0347, lng: -93.5199 } },
			"§1 the payload: the load number, the event, the fix's own time, the position to 4 decimals; nothing else");
		eq(L.LOCATION_PAYLOAD_KEYS, ["loadNumber", "event", "eventAt", "position"], "§1 ...the four keys");
		const red = E.createRedactor({ denyList: "777000111" });
		eq([L.buildLocationPayload({ loadId: "12345678", fix: fx(1) }), L.buildLocationPayload({ loadId: "777000111", fix: fx(1), redactor: red }),
			L.buildLocationPayload({ loadId: "123456789", fix: { ms: NaN, lat: 1, lng: 1 } })], [null, null, null], "§1 refused: not 9 digits, a protected number, no time");
	} finally {
		C = prev;
	}
}

async function main() {
	// Without the module, §2-§7 still run against the sweep this tree has.
	ok(LOC_SRC, "lib/chr-location.js exists: location along the route is built");
	const L = LOC_SRC ? loadModule(LOC_SRC) : null;
	section("§1  the pure rules");
	if (L) {
		const R1 = { pass: 0, failures };
		checkPure(R1, L);
		pass += R1.pass;
	}

	// ---------------------------------------------------------------- §2
	section("§2  one dry-run row per 15-minute bucket (fails on the old code)");
	{
		const w = world();
		await w.tick();
		departAndDrive(w);
		await w.runTo(T0 + 62 * MIN);
		eq(w.milestones().map((m) => `${m.event}:${m.status}:${m.verify}`), ["departed_pickup:dry_run:confirmed"], "§2 the departure, confirmed by the truck's fixes");
		const locs = w.locs();
		eq(locs.map((l) => [l.event_at, l.mode, l.status]), [
			[iso(T0 + 10 * MIN), "dry_run", "dry_run"], [iso(T0 + 25 * MIN), "dry_run", "dry_run"], [iso(T0 + 40 * MIN), "dry_run", "dry_run"], [iso(T0 + 55 * MIN), "dry_run", "dry_run"],
		], "§2 four buckets closed since the departure: four rows, each the newest fix in its bucket");
		eq(locs.map((l) => Object.keys(JSON.parse(l.payload_json))), locs.map(() => ["loadNumber", "event", "eventAt", "position"]), "§2 ...each payload exactly the four keys");
		eq(JSON.parse(locs[0].payload_json), { loadNumber: "123456789", event: "location", eventAt: "2026-11-02T15:10:00Z", position: { lat: 42.0347, lng: -93.42 } }, "§2 ...the first one in full");
		eq(networkCalls, 0, "§2 nothing reached the network");
	}

	// ---------------------------------------------------------------- §3
	section("§3  the window");
	{
		const w = world();
		await w.tick();
		w.fix(T0 + 1 * MIN, { lat: 41.0, lng: -93.62 }, { speed: 0 });
		w.history("123456789", "In Transit", T0 + 2 * MIN);
		for (let m = 4; m <= 45; m += 5) w.fix(T0 + m * MIN, road(m));
		await w.runTo(T0 + 47 * MIN);
		eq([w.milestones().map((m) => `${m.status}`), w.locs().length], [["held"], 0], "§3 a departure tapped away from the pickup is held: no location at all");
	}
	{
		const w = world();
		await w.tick();
		departAndDrive(w, { untilMin: 120 });
		await w.runTo(T0 + 47 * MIN);
		const before = w.locs().length;
		eq(w.locs().every((l) => Date.parse(l.event_at) >= T0 + 2 * MIN), true, "§3 no fix from before the departure");
		w.history("123456789", "Delivered", T0 + 48 * MIN);
		await w.runTo(T0 + 120 * MIN);
		eq([before, w.locs().length], [3, 3], "§3 In Transit, then Delivered: no row after the final event is recorded, fixes or not");
	}
	{
		const w = world();
		await w.tick();
		departAndDrive(w, { untilMin: 120 });
		await w.runTo(T0 + 32 * MIN);
		w.history("123456789", "At Receiver", T0 + 33 * MIN);
		await w.runTo(T0 + 120 * MIN);
		ok(w.milestones().some((m) => m.event === "arrived_delivery") && w.locs().length === 2, "§3 an arrival at the delivery (whatever its check) shuts the window: two rows, then none");
	}
	{
		const w = world();
		await w.tick();
		departAndDrive(w, { untilMin: 120 });
		await w.runTo(T0 + 32 * MIN);
		w.history("123456789", "At Shipper", T0 + 33 * MIN);
		await w.runTo(T0 + 120 * MIN);
		eq(w.locs().length, 2, "§3 a second pickup after the departure (a multi-stop load): no row after it");
	}
	{
		const w = world();
		await w.tick();
		departAndDrive(w, { untilMin: 20 });
		await w.runTo(T0 + 22 * MIN);
		const cap = T0 + 2 * MIN + 72 * 60 * MIN;
		for (let m = -40; m <= 40; m += 5) w.fix(cap + m * MIN, road(10));
		w.clock = cap - 30 * MIN;
		await w.runTo(cap + 45 * MIN);
		ok(w.locs().length >= 2 && w.locs().every((l) => Date.parse(l.event_at) < cap), "§3 72 hours after the departure: the window closes, whatever the fixes");
	}

	// ---------------------------------------------------------------- §4
	section("§4  the fixes");
	{
		const w = world();
		await w.tick();
		w.fix(T0 + 1 * MIN, AT_PICKUP, { speed: 0 });
		w.history("123456789", "In Transit", T0 + 2 * MIN);
		w.fix(T0 + 4 * MIN, road(4));
		w.fix(T0 + 20 * MIN, road(20), { source: "linxup" });
		w.fix(T0 + 22 * MIN, road(22), { source: "" });
		w.fix(T0 + 24 * MIN, road(24), { dropped: "jump" });
		await w.runTo(T0 + 31 * MIN);
		eq(w.locs().map((l) => l.event_at), [iso(T0 + 4 * MIN)], "§4 the second bucket had only Linxup, untagged and dropped fixes: no row for it");
	}
	{
		const w = world();
		await w.tick();
		departAndDrive(w, { untilMin: 10 });
		await w.runTo(T0 + 14 * MIN);
		w.fix(T0 + 16 * MIN, road(16));
		// No tick between T+14 and T+37: the bucket [T+15, T+30) is first seen when its only fix is 21 minutes old.
		w.clock = T0 + 37 * MIN;
		await w.tick();
		eq(w.locs().length, 0, "§4 the bucket's only fix 21 minutes old when the row would be made: no row");
		w.fix(T0 + 44 * MIN, road(44));
		await w.runTo(T0 + 45 * MIN);
		eq(w.locs().map((l) => l.event_at), [iso(T0 + 44 * MIN)], "§4 ...the next bucket, with a fix a minute old: its row");
	}
	{
		// The device was linked to the truck at T0+20: its fixes before are never used.
		const w = world({ devices: (id, ms) => (id === 1 && ms >= T0 + 20 * MIN ? "RM-TEST-1" : "") });
		await w.tick();
		w.fix(T0 + 1 * MIN, AT_PICKUP, { speed: 0 });
		w.history("123456789", "In Transit", T0 + 2 * MIN);
		for (let m = 4; m <= 40; m += 5) w.fix(T0 + m * MIN, road(m));
		await w.runTo(T0 + 46 * MIN);
		ok(w.locs().every((l) => Date.parse(l.event_at) >= T0 + 20 * MIN), "§4 a fix from before the device's link to the truck: never used");
	}
	{
		// The driver moves to truck 2 (RM-TEST-2) at T0+30.
		const w = world({ trucks: (name, ms) => (ms < T0 + 30 * MIN ? { truck_id: 1, unit: "T-101" } : { truck_id: 2, unit: "T-102" }) });
		await w.tick();
		departAndDrive(w, { untilMin: 60 });
		for (let m = 31; m <= 60; m += 5) w.fix(T0 + m * MIN, { lat: 40.5, lng: -90 + m * 0.01 }, { device: "RM-TEST-2" });
		await w.runTo(T0 + 62 * MIN);
		const late = w.locs().filter((l) => Date.parse(l.event_at) >= T0 + 30 * MIN).map((l) => JSON.parse(l.payload_json).position.lat);
		eq([late.length > 0, late.every((lat) => lat === 40.5)], [true, true], "§4 after a truck change, the new truck's device: its fixes only");
	}
	{
		const w = world();
		await w.tick();
		departAndDrive(w);
		await w.runTo(T0 + 62 * MIN);
		const n = w.locs().length;
		w.clock = T0 + 62 * MIN;
		await w.tick();
		await w.tick();
		eq(w.locs().length, n, "§4 several ticks in one bucket: one row");
		eq(new Set(w.db.prepare("SELECT idem_key FROM chr_events WHERE kind = 'location'").all().map((r) => r.idem_key)).size, n, "§4 ...one key per bucket");
	}

	// ---------------------------------------------------------------- §5
	section("§5  the switches");
	for (const [label, config, settings] of [
		["CHR_LOCATION_ENABLED off (the page says Dry run)", { updatesEnabled: true }, { location: "dry_run" }],
		["the page's Location Off", { updatesEnabled: true, locationEnabled: true }, { location: "off" }],
	]) {
		const w = world({ config, settings });
		await w.tick();
		departAndDrive(w);
		await w.runTo(T0 + 62 * MIN);
		eq([w.milestones().length, w.locs().length], [1, 0], `§5 ${label}: the departure recorded, no location row`);
	}
	{
		const w = world({ settings: { location: "off" } });
		await w.tick();
		departAndDrive(w);
		await w.runTo(T0 + 22 * MIN);
		S.writeSettings(w.db, { ...S.readSettings(w.db), location: "dry_run" }, { by: "admin.one", nowIso: iso(w.clock) });
		await w.runTo(T0 + 47 * MIN);
		eq(w.locs().map((l) => l.event_at), [iso(T0 + 25 * MIN), iso(T0 + 40 * MIN)], "§5 Location turned on at T+23: nothing from before then (the T+20 fix is not used), each bucket after");
		ok(w.audits.some((a) => a.action === "chr_baseline" && a.entityId === "location"), "§5 ...its start audited");
	}

	// ---------------------------------------------------------------- §6
	section("§6  Live, through the sender");
	const transport = (answers = []) => {
		const t = { sent: [], queue: answers.slice(), ready: () => true, dropToken: () => {} };
		t.send = async (payload) => { t.sent.push(payload); const a = t.queue.length ? t.queue.shift() : { resultCode: "SENT", httpStatus: 200 }; return { httpStatus: null, chrCode: "", retryAfterS: null, remoteRef: "", ...a }; };
		return t;
	};
	const liveCfg = { updatesEnabled: true, locationEnabled: true, sendEnabled: true, liveAllEnabled: true };
	{
		const tr = transport();
		const w = world({ config: liveCfg, settings: { milestones: "live", location: "live" }, transport: tr });
		await w.tick();
		departAndDrive(w);
		await w.runTo(T0 + 47 * MIN);
		eq(tr.sent.map((p) => p.event), ["departed_pickup", "location", "location", "location"], "§6 Live: the departure first, then a location per bucket");
		eq(w.locs().map((l) => l.status), ["sent", "sent", "sent"], "§6 ...each sent");
	}
	{
		const fails = Array.from({ length: 40 }, () => ({ resultCode: "TIMEOUT" }));
		const tr = transport([{ resultCode: "SENT", httpStatus: 200 }, ...fails]);
		const w = world({ config: liveCfg, settings: { milestones: "live", location: "live" }, transport: tr });
		await w.tick();
		departAndDrive(w);
		await w.runTo(T0 + 47 * MIN);
		const st = w.locs().map((l) => l.status);
		eq([st.slice(0, -1).every((s) => s === "superseded"), st[st.length - 1]], [true, "pending"], "§6 a location still waiting when the next one is made: superseded");
		const iso2 = iso(w.clock - 70 * MIN);
		w.db.prepare(`INSERT INTO chr_events (load_id, kind, event, event_at, idem_key, payload_json, mode, status, next_attempt_at, created_at, updated_at)
			VALUES ('223456789', 'location', 'location', ?, 'loc|223456789|made-up', '{"loadNumber":"223456789"}', 'live', 'pending', ?, ?, ?)`).run(iso2, iso(w.clock + 60 * MIN), iso2, iso2);
		await w.runTo(w.clock + MIN);
		eq(w.db.prepare("SELECT status FROM chr_events WHERE idem_key = 'loc|223456789|made-up'").get().status, "gave_up", "§6 a location not sent within an hour: given up");
	}
	{
		// A position waiting to be sent when its load is put on hold: never sent.
		const tr = transport([{ resultCode: "SENT", httpStatus: 200 }, { resultCode: "TIMEOUT" }]);
		const w = world({ config: liveCfg, settings: { milestones: "live", location: "live" }, transport: tr });
		await w.tick();
		departAndDrive(w);
		await w.runTo(T0 + 16 * MIN);
		eq([tr.sent.map((p) => p.event), w.locs().map((l) => l.status)], [["departed_pickup", "location"], ["pending"]], "§6 (setup) a location that timed out, waiting for its retry");
		S.setHold(w.db, { loadId: "123456789", hold: true, reason: "made-up", by: "admin.one", nowIso: iso(w.clock), redactor: E.createRedactor({}) });
		await w.runTo(T0 + 20 * MIN);
		eq([w.locs().map((l) => l.status), tr.sent.length], [["gave_up"], 2], "§6 the load put on hold: the waiting position is given up, never sent");
	}
	{
		// Location dropped from Live to Dry run: its waiting live rows are never sent later.
		const tr = transport([{ resultCode: "SENT", httpStatus: 200 }, { resultCode: "TIMEOUT" }]);
		const w = world({ config: liveCfg, settings: { milestones: "live", location: "live" }, transport: tr });
		await w.tick();
		departAndDrive(w);
		await w.runTo(T0 + 16 * MIN);
		S.writeSettings(w.db, { ...S.readSettings(w.db), location: "dry_run" }, { by: "admin.one", nowIso: iso(w.clock) });
		// The same minute: its retry isn't due yet, so only the drop can skip it.
		await w.tick();
		const row = w.db.prepare("SELECT status, skip_reason FROM chr_events WHERE kind = 'location' ORDER BY id LIMIT 1").get();
		eq([row.status, row.skip_reason, tr.sent.length], ["skipped_off", "live_dropped", 2], "§6 Location from Live to Dry run: the waiting live position is skipped (live_dropped)");
	}

	// ---------------------------------------------------------------- §7
	section("§7  canaries");
	{
		const w = world();
		const realPrepare = w.db.prepare.bind(w.db);
		let phoneGpsReads = 0;
		w.db.prepare = (sql) => { if (/driver_locations/i.test(sql)) phoneGpsReads++; return realPrepare(sql); };
		await w.tick();
		departAndDrive(w);
		await w.runTo(T0 + 47 * MIN);
		w.db.prepare = realPrepare;
		const dump = [
			...w.db.prepare("SELECT * FROM chr_events").all().map((r) => JSON.stringify(r)), ...w.db.prepare("SELECT * FROM chr_loads").all().map((r) => JSON.stringify(r)),
			...w.db.prepare("SELECT value FROM server_state").all().map((r) => r.value), ...w.db.prepare("SELECT value FROM app_settings").all().map((r) => r.value),
			JSON.stringify(w.audits), JSON.stringify(w.notices), ...w.logs,
		].join("\n").toLowerCase();
		eq(Object.entries(CANARY).filter(([, v]) => dump.includes(v.toLowerCase())).map(([k]) => k), [], "§7 no driver name, phone, street or phone-GPS value in any row, state, setting, audit, notice or log");
		ok(w.locs().length === 3, "§7 ...while three location rows were made");
		eq(phoneGpsReads, 0, "§7 the phone-GPS table (driver_locations) was never read");
	}

	// ---------------------------------------------------------------- §8
	section("§8  the source");
	if (!L) return;
	{
		const code = LOC_SRC.replace(/^\s*\/\/.*$/gm, "");
		ok(!/require\(["'](?:fs|https?|net|tls|better-sqlite3|child_process)["']\)/.test(code) && !/\bprocess\b/.test(code) && !/\bfetch\s*\(/.test(code), "§8 pure: no files, network, database or environment");
		ok(/source = 'routemate'/.test(L.FIX_SQL) && /dropped_reason = ''/.test(L.FIX_SQL), "§8 the fix read keeps the clean-RouteMate filter");
		ok(!/geocoded_location|SELECT \*|driver_locations/i.test(LOC_SRC), "§8 it never names the geocoded address, the phone-GPS table, nor SELECT *");
		ok(!/\bactor\b|(?<![a-z_])reason\b/.test(L.STATUS_AFTER_SQL), "§8 the status read names neither actor nor reason");
	}

	// ---------------------------------------------------------------- §9
	section("§9  mutants of the pure rules");
	const mutate = (from, to) => {
		if (!LOC_SRC.includes(from)) throw new Error(`mutant: lib/chr-location.js has no ${JSON.stringify(from)}`);
		return loadModule(LOC_SRC.replace(from, to));
	};
	const M = [
		["no freshness limit", mutate("if (nowMs - f.ms > FRESH_MS) return null;", "")],
		["no link or truck rule", mutate("if (!truck || String(deviceAt(truck.truck_id, f.ms) || \"\") !== String(device)) continue;", "")],
		["the window open after a final event", mutate("if (finals > 0) return closed(\"final_event\");", "")],
		["the window open past transit", mutate("if (statuses.some((s) => PAST_TRANSIT_RE.test(statusText(s)))) return closed(\"past_transit\");", "")],
		["the window open on another driver's truck", mutate("if (sameTruck !== true) return closed(\"other_truck\");", "")],
		["the window open after a re-dispatch", mutate("if (redispatched) return closed(\"redispatched\");", "")],
		["a payload carrying the truck", mutate("position: { lat: round4(fix.lat), lng: round4(fix.lng) } };", "position: { lat: round4(fix.lat), lng: round4(fix.lng) }, truck: \"T-101\" };")],
		["any source accepted", mutate("return Boolean(f) && f.source === \"routemate\" && f.dropped_reason === \"\" &&", "return Boolean(f) &&")],
		["no 72-hour cap", mutate("endMs: departure.atMs + WINDOW_CAP_MS", "endMs: Infinity")],
	];
	for (const [label, mod] of M) {
		const t = { pass: 0, failures: [] };
		let threw = null;
		try { checkPure(t, mod); } catch (err) { threw = err; }
		const caught = !threw && t.failures.length > 0;
		if (caught) { pass++; console.log(`  ${label}: ${t.failures[0].split("\n")[0]}`); } else failures.push(`§9 caught: ${label}${threw ? ` (threw ${threw.message})` : ""}`);
	}

	// ---------------------------------------------------------------- §10
	section("§10 a load handed to another driver, a re-dispatch, and review-1's window cases (the tick, with its mutants)");
	const R10 = { pass: 0, failures };
	await checkScenarios(R10, W);
	pass += R10.pass;
	const SWEEP_SRC = fs.readFileSync(path.join(ROOT, "lib", "chr-sweep.js"), "utf8");
	const STORE_SRC = fs.readFileSync(path.join(ROOT, "lib", "chr-store.js"), "utf8");
	const tickMutant = (file, from, to) => {
		const src = file === "store" ? STORE_SRC : SWEEP_SRC;
		if (!src.includes(from)) throw new Error(`mutant: lib/chr-${file === "store" ? "store" : "sweep"}.js has no ${JSON.stringify(from)}`);
		return file === "store" ? loadSweep({ storeText: src.replace(from, to) }) : loadSweep({ sweepText: src.replace(from, to) });
	};
	const TM = [
		["the tick never checks the truck (review M1)", tickMutant("sweep", "sameTruck: blocked ? true : sameTruck(key, proj.driverName, depMs),", "sameTruck: true,")],
		["the tick ignores a re-dispatch", tickMutant("sweep", "redispatched: after.some((r) => L.REDISPATCH_SOURCES.includes(String(r.source || \"\").trim().toLowerCase())),", "redispatched: false,")],
		["the tick ignores final events (review L1, l1)", tickMutant("sweep", "finals: S.finalEventCount(db, key),", "finals: 0,")],
		["the tick ignores the statuses after the departure", tickMutant("sweep", "statuses: after.map((r) => r.new_status),", "statuses: [],")],
		["the tick ignores a hold", tickMutant("sweep", "const blocked = verdict.verdict !== \"chr\" || Boolean(info && info.hold) || multi;", "const blocked = verdict.verdict !== \"chr\" || multi;")],
		["the tick ignores the CHR-load test", tickMutant("sweep", "const blocked = verdict.verdict !== \"chr\" || Boolean(info && info.hold) || multi;", "const blocked = Boolean(info && info.hold) || multi;")],
		["a reverted departure still opens the window", tickMutant("store", "AND verify = 'confirmed' AND reverted_at = ''", "AND verify = 'confirmed'")],
	];
	for (const [label, mod] of TM) {
		const t = { pass: 0, failures: [] };
		let threw = null;
		try { await checkScenarios(t, mod); } catch (err) { threw = err; }
		const caught = !threw && t.failures.length > 0;
		if (caught) { pass++; console.log(`  ${label}: ${t.failures[0].split("\n")[0]}`); } else failures.push(`§10 caught: ${label}${threw ? ` (threw ${threw.message})` : ""}`);
	}
}

// ------------------------------------------------------------------ §10's world
// review-1's scenarios (pr4-shell/review-scratch/scenarios.js), as cases: events
// happen at their own minute, and the sweep may be a mutant built from text.
const sweepRequire = createRequire(path.join(ROOT, "lib", "chr-sweep.js"));
function loadWith(text, req) {
	const mod = { exports: {} };
	new Function("require", "module", "exports", text)(req, mod, mod.exports);
	return mod.exports;
}
function loadSweep({ sweepText = null, storeText = null } = {}) {
	const store = storeText ? loadWith(storeText, sweepRequire) : null;
	const req = (p) => (p === "./chr-store" && store ? store : sweepRequire(p));
	return loadWith(sweepText || fs.readFileSync(path.join(ROOT, "lib", "chr-sweep.js"), "utf8"), req);
}
const DRIVER_A = "Alpha Testdriver";
const DRIVER_B = "Bravo Testdriver";
// Driver B's truck, far away on other work.
const elsewhere = (min) => ({ lat: 35.0, lng: -100.0 + 0.02 * min });
function scenarioWorld(sweepMod, { settings = { location: "dry_run" } } = {}) {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
		CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '', new_status TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'manual', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP, reason TEXT DEFAULT '');
		CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT NOT NULL, latitude REAL, longitude REAL,
			speed REAL DEFAULT 0, geocoded_location TEXT DEFAULT '', location_date_ms INTEGER DEFAULT 0, dropped_reason TEXT DEFAULT '', source TEXT DEFAULT '');
	`);
	S.writeSettings(db, { ...S.DEFAULT_SETTINGS, ...settings }, { by: "admin.one", nowIso: iso(T0 - 60 * MIN) });
	const w = { db, clock: T0, sheetRows: [sheetRow("123456789", { Driver: DRIVER_A })], at: [] };
	const truckAt = (name) => (name === DRIVER_A ? { truck_id: 1, unit: "T-101" } : name === DRIVER_B ? { truck_id: 2, unit: "T-102" } : null);
	const deviceAt = (id) => (id === 1 ? "RM-TEST-1" : id === 2 ? "RM-TEST-2" : "");
	const sweep = sweepMod.createSweep({
		db,
		config: I.chrConfig({ updatesEnabled: true, locationEnabled: true }),
		readSheet: async () => new Map(w.sheetRows.map((r) => { const p = E.projectRow(r, HEADERS); return [p.loadKey, p]; })),
		stopPointsFor: () => ({ origin: PICKUP, dest: DROP }),
		truckResolver: () => ({ forDriverAt: (name, ms) => (Number.isFinite(ms) ? truckAt(name, ms) : null) }),
		deviceResolver: () => ({ vehicleForTruckAt: (id) => deviceAt(id) }),
		instructionStopsFor: () => null,
		logAudit: () => {},
		now: () => w.clock,
		log: { info() {}, warn() {}, error() {} },
	});
	const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
	w.history = (min, status, source = "manual") => w.at.push({ ms: T0 + min * MIN, fn: () => db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, changed_at, reason) VALUES (?, '', ?, ?, '', ?, '')").run("123456789", status, source, stamp(T0 + min * MIN)) });
	w.fix = (min, p, { device = "RM-TEST-1", speed = 20 } = {}) => w.at.push({ ms: T0 + min * MIN, fn: () => db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, location_date_ms, dropped_reason, source) VALUES (?, ?, ?, ?, ?, '', 'routemate')").run(device, p.lat, p.lng, speed, T0 + min * MIN) });
	w.do = (min, fn) => w.at.push({ ms: T0 + min * MIN, fn });
	w.runTo = async (min) => {
		while (w.clock < T0 + min * MIN) {
			w.clock += MIN;
			for (const e of w.at) if (!e.done && e.ms <= w.clock) { e.done = true; e.fn(); }
			await sweep.tick();
		}
	};
	w.locs = () => db.prepare("SELECT event_at, payload_json FROM chr_events WHERE kind = 'location' ORDER BY id").all()
		.map((r) => { const p = JSON.parse(r.payload_json); return `${((Date.parse(r.event_at) - T0) / MIN)}m@${p.position.lat},${p.position.lng}`; });
	return w;
}
// The departure at T+2 with the fixes along the road every 5 minutes.
function departScenario(w) {
	w.fix(1, AT_PICKUP, { speed: 0 });
	w.history(2, "In Transit");
	for (let m = 4; m <= 95; m += 5) w.fix(m, road(m));
}

async function checkScenarios(t, sweepMod) {
	const prev = C;
	C = t;
	try {
		const FIRST = "14m@42.0347,-93.34";
		{
			// The load handed to driver B at T+20 (the Driver cell only, no status row); B's truck is elsewhere.
			const w = scenarioWorld(sweepMod);
			departScenario(w);
			for (let m = 0; m <= 95; m += 5) w.fix(m, elsewhere(m), { device: "RM-TEST-2" });
			w.do(20, () => { w.sheetRows = [sheetRow("123456789", { Driver: DRIVER_B })]; });
			await w.runTo(66);
			eq(w.locs(), [FIRST], "§10 review M1 (S3): handed to another driver mid-route, the window shuts: never that driver's truck");
		}
		{
			// The same, through the dispatch route (a 'Dispatched' row).
			const w = scenarioWorld(sweepMod);
			departScenario(w);
			for (let m = 0; m <= 95; m += 5) w.fix(m, elsewhere(m), { device: "RM-TEST-2" });
			w.do(20, () => { w.sheetRows = [sheetRow("123456789", { Driver: DRIVER_B })]; });
			w.history(20, "Dispatched", "dispatch");
			await w.runTo(66);
			eq(w.locs(), [FIRST], "§10 review M1 (S4): re-dispatched to another driver: the same");
		}
		{
			// Re-dispatched to the same driver at T+20 with no new departure: the trip starts over.
			const w = scenarioWorld(sweepMod);
			departScenario(w);
			w.history(20, "Dispatched", "dispatch");
			await w.runTo(66);
			eq(w.locs(), [FIRST], "§10 re-dispatched to the same driver, no new departure yet: the window shuts until one");
		}
		{
			// S1: Delivered (held, away from the drop), re-dispatched, then a second confirmed departure.
			const w = scenarioWorld(sweepMod);
			w.fix(1, AT_PICKUP, { speed: 0 });
			w.history(2, "In Transit");
			for (const m of [4, 9, 14, 19]) w.fix(m, road(m));
			w.history(20, "Delivered");
			w.history(22, "Dispatched", "dispatch");
			w.fix(29, AT_PICKUP, { speed: 0 });
			w.history(30, "In Transit");
			for (let m = 32; m <= 95; m += 2) w.fix(m, road(m));
			await w.runTo(96);
			eq(w.locs(), [FIRST], "§10 review L1 (S1): a final event before a later departure still shuts the window");
		}
		{
			// S2: "At  Receiver" with a doubled space.
			const w = scenarioWorld(sweepMod);
			departScenario(w);
			w.history(33, "At  Receiver");
			await w.runTo(96);
			eq(w.locs(), [FIRST, "29m@42.0347,-93.04"], "§10 review L1 (S2): an arrival at the delivery, oddly spaced: no row after it");
		}
		{
			// S5: Milestones switched Off at T+16 (Location stays in Dry run), then At Receiver.
			const w = scenarioWorld(sweepMod, { settings: { milestones: "dry_run", location: "dry_run" } });
			departScenario(w);
			w.do(16, () => S.writeSettings(w.db, { ...S.readSettings(w.db), milestones: "off" }, { by: "admin.one", nowIso: iso(w.clock) }));
			w.history(40, "At Receiver");
			await w.runTo(96);
			eq(w.locs(), [FIRST, "29m@42.0347,-93.04"], "§10 review L1 (S5): with Milestones Off, the status alone shuts the window at the delivery");
		}
		{
			// S6: the departure reverted by an override back to At Shipper at T+20.
			const w = scenarioWorld(sweepMod);
			departScenario(w);
			w.history(20, "At Shipper", "override");
			await w.runTo(66);
			eq(w.locs(), [FIRST], "§10 review L1 (S6): a departure reverted by an override: no row after it");
		}
		{
			// S7: the load stops being CHR's at T+20.
			const w = scenarioWorld(sweepMod);
			departScenario(w);
			w.do(20, () => { w.sheetRows = [sheetRow("123456789", { Driver: DRIVER_A, Email: "made-up.agent@example-broker.test" })]; });
			await w.runTo(66);
			eq(w.locs(), [FIRST], "§10 review L1 (S7): the load now another broker's: no row after it");
		}
		{
			// S9: a person holds the load at T+20.
			const w = scenarioWorld(sweepMod);
			departScenario(w);
			w.do(20, () => S.setHold(w.db, { loadId: "123456789", hold: true, reason: "made-up", by: "admin.one", nowIso: iso(w.clock), redactor: E.createRedactor({}) }));
			await w.runTo(66);
			eq(w.locs(), [FIRST], "§10 review L1 (S9): a load put on hold: no row after it");
		}
	} finally {
		C = prev;
	}
}

main().then(() => {
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
	process.exit(0);
}).catch((err) => {
	console.error(err);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	process.exit(1);
});
