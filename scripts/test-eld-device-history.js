#!/usr/bin/env node
// Which ELD device was on which truck, and when: eld_device_assignments, its
// writer and boot seed (server.js), the resolver (lib/eld-miles.js
// buildDeviceTruckResolver()), and the miles that read through it.
//
// WHY THIS EXISTS. Every per-truck miles figure mapped a device's WHOLE history
// through trucks.routemate_vehicle_id, the link as it stands today. So
// re-pointing a device (LogisX-#356's, 2026-09-28) moved every mile it had ever
// driven onto the truck it was re-pointed to, and the per-load sweep measured
// old loads off whatever device a truck holds now. Pinned here:
//   1. the resolver: the newest recorded link covering the time; before
//      recording began, the link in force when it began (no backdating); no
//      record at all, the current link;
//   2. the writer: one open row per device and per truck, a re-point closes the
//      old link and opens the new, re-saving changes nothing, the boot seed runs
//      once and the boot reconcile records links changed behind its back;
//   3. after a re-point, the daily miles rollup and GET /api/analytics/mileage
//      keep the device's earlier days on the truck that drove them, with that
//      truck's driver;
//   4. the per-load sweep measures a load off the device its truck held then;
//   5. (§4) under APP_DAY_STAMPS_ENABLED a link's bounds are read on the
//      business day, so an evening re-point day goes to the newer link as a
//      daytime one does: the pure resolver with and without opts.dayOf, the
//      shipped buildEldDeviceResolver() off and on, the daily rollup's row,
//      and the same values under four process zones.
// Driver pay's ELD travel days are NOT moved by any of this (they read the
// current link on purpose, and stay out of scope here).
//
// Server code is lifted verbatim and run against an in-memory SQLite.
// SERVER_JS=<path> runs another copy of server.js.
//
// No network, no sheet, no app.db, no server (§4 forks this file once per zone).
//
//   node scripts/test-eld-device-history.js      # exits 1 on any failure

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3");
const eldMiles = require("../lib/eld-miles");
const appTime = require("../lib/app-time");

// A §4 child reports one line of JSON on stdout and nothing else.
const ZONE_CHILD = process.argv[2] === "--zone-child";
if (ZONE_CHILD) { console.log = () => {}; console.error = () => {}; }

const SHIPPED = require("./lib/server-source").serverSource();

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}
function lift(re, label, { optional = false } = {}) {
	const all = [...SHIPPED.matchAll(re)];
	if (all.length === 1) return all[0][0];
	if (!optional || all.length > 1) {
		fail++;
		console.error(`FAIL  ${label}: expected exactly one definition in server.js, found ${all.length}`);
	}
	return "";
}
const fn = (name, opts) => lift(new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`, "g"), name, opts);
const decl = (kind, name, opts) => lift(new RegExp(`\\n${kind} ${name} = [^\\n]*\\n`, "g"), name, opts);

const DAY = 86400000;
const NOW = Date.parse("2026-10-02T17:00:00Z");
class FakeDate extends Date {
	constructor(...args) { super(...(args.length ? args : [NOW])); }
	static now() { return NOW; }
}
const T0 = Date.parse("2026-09-20T00:00:00Z");   // recording began (the boot seed)
const T1 = Date.parse("2026-09-29T00:00:00Z");   // the device is re-pointed (2026-09-28 19:00 in Houston)
const A = 13, B = 2;                              // LogisX-#356, LogisX-#33
const X = "VID-X", OLD = "VID-OLD";

// ===========================================================================
// §1 buildDeviceTruckResolver(), pure
// ===========================================================================
console.log("§1 buildDeviceTruckResolver()");
{
	const rows = [
		{ truck_id: A, routemate_vehicle_id: X, assigned_from: new Date(T0).toISOString(), assigned_until: new Date(T1).toISOString() },
		{ truck_id: B, routemate_vehicle_id: OLD, assigned_from: new Date(T0).toISOString(), assigned_until: new Date(T1).toISOString() },
		{ truck_id: B, routemate_vehicle_id: X, assigned_from: new Date(T1).toISOString(), assigned_until: "" },
	];
	const current = [{ id: B, routemate_vehicle_id: X }, { id: 5, routemate_vehicle_id: "VID-LATE" }];
	const r = eldMiles.buildDeviceTruckResolver(rows, { startMs: T0, currentLinks: current });
	const at = (iso) => Date.parse(iso);
	check("§1.1 a day on the old truck stays on the old truck", r.truckForVehicleOnDay(X, "2026-09-25"), A);
	check("§1.2 ...up to the re-point instant", [r.truckForVehicleAt(X, T1 - 1), r.truckForVehicleAt(X, T1 + 1)], [A, B]);
	check("§1.3 the re-point day goes to the link put in force last", r.truckForVehicleOnDay(X, "2026-09-29"), B);
	check("§1.4 BEFORE recording began: the link in force when it began, not today's", r.truckForVehicleOnDay(X, "2026-08-01"), A);
	check("§1.5 ...instant grain the same", r.truckForVehicleAt(X, at("2026-08-01T12:00:00Z")), A);
	check("§1.6 a device with no record at all: its current link", [r.truckForVehicleOnDay("VID-LATE", "2026-09-25"), r.truckForVehicleOnDay("VID-LATE", "2026-08-01")], [5, 5]);
	check("§1.7 a device on no truck that day: null", r.truckForVehicleOnDay(OLD, "2026-09-30"), null);
	check("§1.8 a device nobody ever linked: null", r.truckForVehicleOnDay("VID-NEVER", "2026-09-25"), null);
	check("§1.9 inverse: the device a truck held then",
		[r.vehicleForTruckAt(A, at("2026-09-27T12:00:00Z")), r.vehicleForTruckAt(B, at("2026-09-27T12:00:00Z")),
			r.vehicleForTruckAt(B, at("2026-09-30T12:00:00Z")), r.vehicleForTruckAt(A, at("2026-09-30T12:00:00Z"))],
		[X, OLD, X, ""]);
	check("§1.10 inverse before recording began", r.vehicleForTruckOnDay(A, "2026-08-01"), X);
	check("§1.11 devices to walk for a window", [...r.vehiclesBetween(at("2026-09-21T00:00:00Z"), at("2026-09-22T00:00:00Z"))].sort(), [OLD, X, "VID-LATE"].sort());
	check("§1.12 ...a window after OLD came off every truck leaves it out", [...r.vehiclesBetween(at("2026-09-30T00:00:00Z"), NOW)].sort(), [X, "VID-LATE"].sort());
	const none = eldMiles.buildDeviceTruckResolver([], { startMs: null, currentLinks: current });
	check("§1.13 recording never began: today's links, as before", [none.truckForVehicleOnDay(X, "2026-09-25"), none.vehicleForTruckAt(A, T0)], [B, ""]);
	const bad = eldMiles.buildDeviceTruckResolver([{ truck_id: A, routemate_vehicle_id: X, assigned_from: "garbage", assigned_until: "" }], { startMs: T0, currentLinks: [] });
	check("§1.14 an unreadable row is ignored, never read as the epoch", bad.truckForVehicleOnDay(X, "2026-09-25"), null);
}

// ===========================================================================
// §2 the writer, the seed and the boot reconcile, as shipped
// ===========================================================================
console.log("§2 recordEldDeviceAssignment() / seed / reconcile");
const HISTORY_DDL = lift(/CREATE TABLE IF NOT EXISTS eld_device_assignments \([\s\S]*?\n\t\)/g, "eld_device_assignments DDL");
const HISTORY_IDX = [...SHIPPED.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_eld_dev_asg_[a-z_]+ ON eld_device_assignments\([^)]*\)(?: WHERE assigned_until = '')?/g)].map((m) => m[0]);
const STATE_DDL = lift(/CREATE TABLE IF NOT EXISTS server_state \([\s\S]*?\n\t\)/g, "server_state DDL");
const MILES_DDL = lift(/CREATE TABLE IF NOT EXISTS eld_miles_daily \([\s\S]*?\n\t\)/g, "eld_miles_daily DDL");
const HISTORY_SRC = [
	decl("const", "ELD_DEVICE_HISTORY_START_KEY", { optional: true }),
	fn("eldDeviceHistoryStartMs", { optional: true }),
	fn("recordEldDeviceAssignment", { optional: true }),
	fn("ensureEldDeviceHistorySeeded", { optional: true }),
	fn("reconcileEldDeviceAssignments", { optional: true }),
	fn("buildEldDeviceResolver", { optional: true }),
].join("");
check("§2.0 the history table, its indexes and its writer ship", [Boolean(HISTORY_DDL), HISTORY_IDX.length, /function recordEldDeviceAssignment/.test(HISTORY_SRC)], [true, 4, true]);

function freshDb() {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, routemate_vehicle_id TEXT DEFAULT '', status TEXT DEFAULT 'Active', retired_at TEXT DEFAULT '')`);
	db.exec(`CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '')`);
	db.exec(`CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT NOT NULL,
		latitude REAL, longitude REAL, odometer REAL, location_date_ms INTEGER, dropped_reason TEXT DEFAULT '')`);
	db.exec(`CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, amount REAL, gallons REAL, date TEXT, status TEXT DEFAULT '', truck_unit TEXT DEFAULT '')`);
	for (const sql of [STATE_DDL, MILES_DDL, HISTORY_DDL, ...HISTORY_IDX]) if (sql) db.exec(sql);
	return db;
}
// APP_DAY_STAMPS_ENABLED is off and APP_TIMEZONE US Eastern unless `extra` says otherwise.
function build(db, src, expose, extra = {}) {
	const deps = {
		db, eldMiles, Date: FakeDate,
		localDayInTz: eldMiles.localDayInTz, usTzForLongitude: eldMiles.usTzForLongitude,
		console: { log: () => {}, error: (...a) => { throw new Error(a.join(" ")); } },
		APP_DAY_STAMPS_ENABLED: false, APP_TIMEZONE: "America/New_York",
		...extra,
	};
	const names = Object.keys(deps);
	return new Function(...names, `${src}\nreturn { ${expose.join(", ")} };`)(...names.map((n) => deps[n]));
}
const hist = (db) => db.prepare(
	"SELECT truck_id, routemate_vehicle_id AS vid, assigned_from AS f, assigned_until AS u, assigned_by AS by FROM eld_device_assignments ORDER BY id"
).all().map((r) => [r.truck_id, r.vid, r.f === new Date(NOW).toISOString() ? "now" : r.f, r.u === "" ? "open" : r.u === new Date(NOW).toISOString() ? "now" : r.u, r.by]);

if (/function recordEldDeviceAssignment/.test(HISTORY_SRC)) {
	const db = freshDb();
	const t = db.prepare("INSERT INTO trucks (id, unit_number, routemate_vehicle_id) VALUES (?, ?, ?)");
	t.run(A, "LogisX-#356", X); t.run(B, "LogisX-#33", OLD); t.run(5, "INV-5", ""); t.run(7, "LogisX-#7", "VID-7");
	const w = build(db, HISTORY_SRC, ["ensureEldDeviceHistorySeeded", "recordEldDeviceAssignment", "reconcileEldDeviceAssignments", "eldDeviceHistoryStartMs"]);
	check("§2.1 the first boot seeds the links in force, dated now", [w.ensureEldDeviceHistorySeeded(), hist(db)],
		[true, [[B, OLD, "now", "open", "system:seed"], [7, "VID-7", "now", "open", "system:seed"], [A, X, "now", "open", "system:seed"]]]);
	check("§2.2 ...once", [w.ensureEldDeviceHistorySeeded(), hist(db).length, w.eldDeviceHistoryStartMs()], [false, 3, NOW]);

	const t1 = new Date(T1).toISOString();
	db.prepare("UPDATE trucks SET routemate_vehicle_id = '' WHERE id = ?").run(A);
	w.recordEldDeviceAssignment(A, "", "super_admin", t1);
	db.prepare("UPDATE trucks SET routemate_vehicle_id = ? WHERE id = ?").run(X, B);
	w.recordEldDeviceAssignment(B, X, "super_admin", t1);
	check("§2.3 unlink, then re-point: the old links close, the new one opens", hist(db), [
		[B, OLD, "now", t1, "system:seed"], [7, "VID-7", "now", "open", "system:seed"], [A, X, "now", t1, "system:seed"], [B, X, t1, "open", "super_admin"],
	]);
	w.recordEldDeviceAssignment(B, X, "super_admin", new Date(T1 + DAY).toISOString());
	check("§2.4 re-saving the device a truck holds changes nothing", hist(db).length, 4);
	db.prepare("UPDATE trucks SET routemate_vehicle_id = CASE id WHEN 5 THEN ? ELSE '' END WHERE id IN (5, ?)").run(X, B);
	w.recordEldDeviceAssignment(5, X, "super_admin", new Date(T1 + DAY).toISOString());
	check("§2.5 a device moves to one truck at a time: linking it elsewhere closes it here",
		hist(db).filter((r) => r[1] === X && r[3] === "open").map((r) => r[0]), [5]);
	let threw = false;
	try { db.prepare("INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from) VALUES (?, ?, ?)").run(9, X, "2026-10-01T00:00:00.000Z"); } catch { threw = true; }
	check("§2.6 the database refuses a second open row for one device", threw, true);

	// Drift: a link changed outside the routes (a restored database), and a
	// truck deleted while it held a device.
	db.prepare("UPDATE trucks SET routemate_vehicle_id = 'VID-NEW' WHERE id = ?").run(A);
	db.prepare("DELETE FROM trucks WHERE id = 7").run();
	const r = w.reconcileEldDeviceAssignments();
	const after = hist(db);
	check("§2.7 the boot reconcile records the drift from now, and closes the deleted truck's link",
		[r, after.find((x) => x[1] === "VID-NEW"), after.find((x) => x[1] === "VID-7")],
		[{ seeded: false, opened: 1 }, [A, "VID-NEW", "now", "open", "system:boot"], [7, "VID-7", "now", "now", "system:seed"]]);
	check("§2.8 ...and is a no-op when nothing drifted", w.reconcileEldDeviceAssignments(), { seeded: false, opened: 0 });
}

// ===========================================================================
// §3 a re-pointed device's miles: the daily rollup and GET /api/analytics/mileage
// ===========================================================================
console.log("§3 miles after a re-point");
const ROLLUP_SRC = [
	HISTORY_SRC,
	fn("buildDriverAtResolver"),
	decl("const", "ELD_STATE_MILES_BOUNDARY_MS"),
	decl("const", "ELD_MILES_DAILY_LAST_RUN_KEY", { optional: true }),
	decl("const", "ELD_MILES_DAILY_MAX_DAYS", { optional: true }),
	decl("const", "ELD_MILES_DAILY_MIN_DAYS", { optional: true }),
	decl("let", "eldMilesDailyRunning", { optional: true }),
	fn("rollupEldMilesDailyRange", { optional: true }),
	fn("runEldMilesDailyRollup", { optional: true }),
	// The rollup as it was, so SERVER_JS can show the before.
	fn("rollupEldMilesDaily", { optional: true }),
].join("");
const ROUTE_SRC = lift(/\napp\.get\("\/api\/analytics\/mileage",[\s\S]*?\n}\);\n/g, "GET /api/analytics/mileage");
// expenseFrom(): the fuel receipts the route reads (no Personal ledger here).
const UTIL_SRC = [fn("getWeekRange"), fn("appDay"), fn("personalLedgerPresent"), fn("expenseFrom")].join("");
check("§3.0 the per-load measurement reads the device the truck held then",
	/deviceResolver\.vehicleForTruckAt\(truck\.truck_id, win\.endMs\)/.test(fn("measureLoadEldMiles")), true);

// §3's world: X re-pointed from A to B at T1 (8 PM EDT Sep 28), driving
// 09:00-17:00 Houston every day.
function mileageWorld() {
	const db = freshDb();
	const t = db.prepare("INSERT INTO trucks (id, unit_number, routemate_vehicle_id) VALUES (?, ?, ?)");
	t.run(A, "LogisX-#356", ""); t.run(B, "LogisX-#33", X);      // as it stands after the re-point
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, ?, '')").run(A, "Alice Able", "2026-09-01T00:00:00.000Z");
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, ?, '')").run(B, "Bob Baker", "2026-09-01T00:00:00.000Z");
	if (HISTORY_DDL) {
		const h = db.prepare("INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from, assigned_until, assigned_by) VALUES (?, ?, ?, ?, ?)");
		h.run(A, X, new Date(T0).toISOString(), new Date(T1).toISOString(), "system:seed");
		h.run(B, OLD, new Date(T0).toISOString(), new Date(T1).toISOString(), "system:seed");
		h.run(B, X, new Date(T1).toISOString(), "", "super_admin");
		db.prepare("INSERT INTO server_state (key, value) VALUES (?, ?)").run("eld_device_history_started", JSON.stringify({ at: new Date(T0).toISOString(), atMs: T0 }));
	}
	// The device drives 09:00-17:00 Houston every day, 2 mi per 10-minute ping.
	const ping = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, odometer, location_date_ms) VALUES (?, ?, ?, ?, ?)");
	let odo = 400000;
	const DAYS = ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"];
	for (const day of DAYS) {
		const start = Date.parse(`${day}T14:00:00Z`);
		// Parked overnight: the odometer does not move between the day's last
		// ping and the next day's first.
		for (let i = 0; i <= 48; i++) { ping.run(X, 31.5, -95.4, odo, start + i * 10 * 60000); if (i < 48) odo += 2; }
	}
	return db;
}
async function rollupRows(db, extra = {}) {
	const src = `${ROLLUP_SRC}${fn("appDay")}`;
	const w = build(db, src, ["runEldMilesDailyRollup", "rollupEldMilesDaily"].filter((n) => new RegExp(`function ${n}\\(`).test(src)), extra);
	if (w.runEldMilesDailyRollup) await w.runEldMilesDailyRollup();
	else w.rollupEldMilesDaily(10);
	return db.prepare("SELECT local_day, truck_id, driver_name, miles FROM eld_miles_daily ORDER BY local_day").all()
		.map((r) => [r.local_day, r.truck_id, r.driver_name, r.miles]);
}

// ===========================================================================
// §4 a link's bounds on the business day (APP_DAY_STAMPS_ENABLED)
// ===========================================================================
// The resolver reads each bound's UTC day unless handed opts.dayOf; server.js
// hands it appDay() under the flag. Expected days are US Eastern, APP_TIMEZONE's
// default. Returns [{ name, ok, a, e }], so a child process can report it whole.
const P = 21, Q = 22;                             // made-up trucks
const Y = "VID-Y", Z = "VID-Z";
const easternDay = (ms) => appTime.dayInZone(new Date(ms), "America/New_York");
const shiftDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
async function appDaySection() {
	const results = [];
	const t = (name, a, e) => results.push({ name, a: JSON.stringify(a), e: JSON.stringify(e), ok: JSON.stringify(a) === JSON.stringify(e) });
	const SINCE = "2026-01-05T12:00:00.000Z";
	const pair = (rows, o) => [eldMiles.buildDeviceTruckResolver(rows, o), eldMiles.buildDeviceTruckResolver(rows, { ...o, dayOf: easternDay })];
	// X moves from P to Q at `at`: [the UTC reading, the business-day reading].
	const repoint = (at) => pair([
		{ truck_id: P, routemate_vehicle_id: X, assigned_from: SINCE, assigned_until: at },
		{ truck_id: Q, routemate_vehicle_id: X, assigned_from: at, assigned_until: "" },
	], { startMs: Date.parse(SINCE), currentLinks: [{ id: Q, routemate_vehicle_id: X }] });

	// [the re-point instant, its business day, that day's truck on the UTC reading, what it is]
	for (const [at, day, utcTruck, why] of [
		["2026-09-29T01:00:00.000Z", "2026-09-28", P, "9 PM EDT Sep 28"],
		["2026-09-29T00:00:00.000Z", "2026-09-28", P, "8 PM EDT Sep 28, the EDT boundary"],
		["2026-09-28T23:59:59.000Z", "2026-09-28", Q, "7:59:59 PM EDT Sep 28 (control)"],
		["2026-09-28T19:00:00.000Z", "2026-09-28", Q, "3 PM EDT Sep 28 (control)"],
		["2026-09-29T03:59:59.999Z", "2026-09-28", P, "11:59:59.999 PM EDT Sep 28"],
		["2026-11-01T03:30:00.000Z", "2026-10-31", P, "11:30 PM EDT Oct 31, the night before daylight time ends"],
		["2026-11-03T00:30:00.000Z", "2026-11-02", P, "7:30 PM EST Nov 2"],
		["2026-03-08T00:30:00.000Z", "2026-03-07", P, "7:30 PM EST Mar 7, before the spring switch"],
		["2026-03-08T23:30:00.000Z", "2026-03-08", Q, "7:30 PM EDT Mar 8, after it (no longer evening)"],
		["2026-03-09T00:30:00.000Z", "2026-03-08", P, "8:30 PM EDT Mar 8"],
	]) {
		const [utc, biz] = repoint(at);
		t(`§4 re-pointed ${why}: ${day} on the UTC reading, no dayOf (unchanged)`, utc.truckForVehicleOnDay(X, day), utcTruck);
		t(`§4 re-pointed ${why}: with dayOf, the newer link takes ${day}`, biz.truckForVehicleOnDay(X, day), Q);
		t(`§4 re-pointed ${why}: the day before stays on the older link and the day after is the newer's, either way`,
			[utc.truckForVehicleOnDay(X, shiftDay(day, -1)), biz.truckForVehicleOnDay(X, shiftDay(day, -1)), utc.truckForVehicleOnDay(X, shiftDay(day, 1)), biz.truckForVehicleOnDay(X, shiftDay(day, 1))],
			[P, P, Q, Q]);
	}
	{
		const [utc, biz] = repoint("2026-09-29T01:00:00.000Z");
		t("§4 the inverse on the 9 PM re-point day: Q held no device on the UTC reading, X with dayOf; P held X either way",
			[utc.vehicleForTruckOnDay(Q, "2026-09-28"), biz.vehicleForTruckOnDay(Q, "2026-09-28"), utc.vehicleForTruckOnDay(P, "2026-09-28"), biz.vehicleForTruckOnDay(P, "2026-09-28")],
			["", X, X, X]);
	}
	{
		// Y unlinked from P at 9:30 PM EDT Sep 28 and never linked again.
		const [utc, biz] = pair([{ truck_id: P, routemate_vehicle_id: Y, assigned_from: SINCE, assigned_until: "2026-09-29T01:30:00.000Z" }],
			{ startMs: Date.parse(SINCE), currentLinks: [] });
		t("§4 an evening unlink: the next day stays on the old truck on the UTC reading, on no truck with dayOf; the unlink day is P's either way",
			[utc.truckForVehicleOnDay(Y, "2026-09-29"), biz.truckForVehicleOnDay(Y, "2026-09-29"), utc.truckForVehicleOnDay(Y, "2026-09-28"), biz.truckForVehicleOnDay(Y, "2026-09-28")],
			[P, null, P, P]);
	}
	{
		// Z, on no truck until it is linked to Q at 10 PM EDT Sep 28.
		const [utc, biz] = pair([{ truck_id: Q, routemate_vehicle_id: Z, assigned_from: "2026-09-29T02:00:00.000Z", assigned_until: "" }],
			{ startMs: Date.parse(SINCE), currentLinks: [{ id: Q, routemate_vehicle_id: Z }] });
		t("§4 an evening link: its day is on no truck on the UTC reading, on Q with dayOf", [utc.truckForVehicleOnDay(Z, "2026-09-28"), biz.truckForVehicleOnDay(Z, "2026-09-28")], [null, Q]);
	}
	{
		// Recording began at 9 PM EDT Sep 19 with X on P: the days around it read the same either way.
		const start = "2026-09-20T01:00:00.000Z";
		const [utc, biz] = pair([{ truck_id: P, routemate_vehicle_id: X, assigned_from: start, assigned_until: "" }],
			{ startMs: Date.parse(start), currentLinks: [{ id: P, routemate_vehicle_id: X }] });
		const days = ["2026-09-18", "2026-09-19", "2026-09-20"];
		t("§4 recording began 9 PM EDT Sep 19: Sep 18-20 on P with or without dayOf", [days.map((d) => utc.truckForVehicleOnDay(X, d)), days.map((d) => biz.truckForVehicleOnDay(X, d))], [[P, P, P], [P, P, P]]);
	}

	// The shipped buildEldDeviceResolver(), off and on.
	if (/function buildEldDeviceResolver/.test(HISTORY_SRC)) {
		const db = freshDb();
		db.prepare("INSERT INTO trucks (id, unit_number, routemate_vehicle_id) VALUES (?, ?, ?)").run(P, "MADE-UP-21", "");
		db.prepare("INSERT INTO trucks (id, unit_number, routemate_vehicle_id) VALUES (?, ?, ?)").run(Q, "MADE-UP-22", X);
		const h = db.prepare("INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from, assigned_until, assigned_by) VALUES (?, ?, ?, ?, ?)");
		h.run(P, X, SINCE, "2026-09-29T01:00:00.000Z", "system:seed");
		h.run(Q, X, "2026-09-29T01:00:00.000Z", "", "super_admin");
		db.prepare("INSERT INTO server_state (key, value) VALUES (?, ?)").run("eld_device_history_started", JSON.stringify({ at: SINCE, atMs: Date.parse(SINCE) }));
		const shipped = (flag) => build(db, `${HISTORY_SRC}${fn("appDay")}`, ["buildEldDeviceResolver"], { APP_DAY_STAMPS_ENABLED: flag }).buildEldDeviceResolver();
		t("§4 the shipped buildEldDeviceResolver(), flag off: the 9 PM EDT re-point day on the older link (unchanged)",
			["2026-09-27", "2026-09-28", "2026-09-29"].map((d) => shipped(false).truckForVehicleOnDay(X, d)), [P, P, Q]);
		t("§4 ...flag on: on the newer link", ["2026-09-27", "2026-09-28", "2026-09-29"].map((d) => shipped(true).truckForVehicleOnDay(X, d)), [P, Q, Q]);
	} else {
		t("§4 the shipped buildEldDeviceResolver() exists", false, true);
	}

	// The daily rollup over §3's world (re-pointed at 8 PM EDT Sep 28).
	const before = [["2026-09-26", A, "Alice Able", 96], ["2026-09-27", A, "Alice Able", 96]];
	const after = [["2026-09-29", B, "Bob Baker", 96], ["2026-09-30", B, "Bob Baker", 96], ["2026-10-01", B, "Bob Baker", 96]];
	t("§4 the daily rollup, flag off: Sep 28 on A, the truck that drove it (unchanged)", await rollupRows(mileageWorld()),
		[...before, ["2026-09-28", A, "Alice Able", 96], ...after]);
	t("§4 ...flag on: Sep 28's row is B's, the link in force at the end of that business day; its driver stays the one at each ping's instant",
		await rollupRows(mileageWorld(), { APP_DAY_STAMPS_ENABLED: true }), [...before, ["2026-09-28", B, "Alice Able", 96], ...after]);
	return results;
}
// §4 in a child of this file under process zone `zone`: { failed: [names], digest of every actual value }.
function inZone(zone) {
	try {
		return JSON.parse(execFileSync(process.execPath, [__filename, "--zone-child"],
			{ env: { ...process.env, TZ: zone }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
	} catch (e) {
		const why = String(e.stderr || "").split("\n").find((l) => /^[A-Za-z]*Error:/.test(l)) || String(e.message).split("\n")[0];
		return { failed: [`the child under TZ=${zone} did not finish: ${why}`], digest: "" };
	}
}

(async () => {
	if (ZONE_CHILD) {
		const results = await appDaySection();
		process.stdout.write(JSON.stringify({
			failed: results.filter((r) => !r.ok).map((r) => r.name),
			digest: crypto.createHash("sha256").update(results.map((r) => `${r.name}=${r.a}`).join("\n")).digest("hex"),
		}));
		process.exit(0);
	}
	const db = mileageWorld();
	const daily = await rollupRows(db);
	check("§3.1 the rollup keeps the device's days before the re-point on the truck that drove them, with its driver", daily, [
		["2026-09-26", A, "Alice Able", 96], ["2026-09-27", A, "Alice Able", 96], ["2026-09-28", A, "Alice Able", 96],
		["2026-09-29", B, "Bob Baker", 96], ["2026-09-30", B, "Bob Baker", 96], ["2026-10-01", B, "Bob Baker", 96],
	]);

	let body = null;
	const app = { get: (p, ...h) => { app.handler = h[h.length - 1]; } };
	const routeDeps = {
		app, db, eldMiles, Date: FakeDate, requireRole: () => null, mileageAnalyticsLimiter: null,
		APP_TIMEZONE: require("../lib/app-time").appTimeZone(), APP_DAY_STAMPS_ENABLED: false,
		localDayInTz: eldMiles.localDayInTz, usTzForLongitude: eldMiles.usTzForLongitude,
		console: { log: () => {}, error: (...a) => { throw new Error(a.join(" ")); } },
	};
	const names = Object.keys(routeDeps);
	new Function(...names, `${HISTORY_SRC}${UTIL_SRC}${ROUTE_SRC}`)(...names.map((n) => routeDeps[n]));
	app.handler({ query: { from: "2026-09-26", to: "2026-10-01" } }, { status() { return this; }, json(b) { body = b; return this; } });
	const truckTotal = (id) => { const e = body && body.trucks.find((x) => x.truckId === id); return e && e.total ? e.total.miles : null; };
	check("§3.2 GET /api/analytics/mileage: each truck keeps the miles it drove", [truckTotal(A), truckTotal(B)], [288, 288]);
	check("§3.3 ...each driver on the truck they drove", (body && body.drivers || []).map((d) => [d.driver, d.truckUnits, d.total.miles]).sort(),
		[["Alice Able", ["LogisX-#356"], 288], ["Bob Baker", ["LogisX-#33"], 288]]);
	check("§3.4 ...and none of it reads as an unlinked device", body && body.coverage.unlinkedVehicles, []);

	console.log("§4 a link's bounds on the business day (APP_DAY_STAMPS_ENABLED)");
	for (const r of await appDaySection()) check(r.name, r.a, r.e);
	const verdicts = ["America/New_York", "America/Chicago", "UTC", "Asia/Manila"].map((zone) => [zone, inZone(zone)]);
	for (const [zone, v] of verdicts) {
		check(`§4 TZ=${zone}: every check passes`, v.failed.length ? `${v.failed.length} failed, first: ${v.failed[0]}` : "all pass", "all pass");
	}
	check("§4 ...and every zone found the same values", new Set(verdicts.map(([, v]) => v.digest)).size, 1);

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((err) => {
	console.error("crashed:", err);
	process.exit(1);
});
