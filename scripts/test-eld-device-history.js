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
//   4. the per-load sweep measures a load off the device its truck held then.
// Driver pay's ELD travel days are NOT moved by any of this (they read the
// current link on purpose, and stay out of scope here).
//
// Server code is lifted verbatim and run against an in-memory SQLite.
// SERVER_JS=<path> runs another copy of server.js.
//
// No network, no sheet, no app.db, no server.
//
//   node scripts/test-eld-device-history.js      # exits 1 on any failure

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const eldMiles = require("../lib/eld-miles");

const SHIPPED = fs.readFileSync(process.env.SERVER_JS || path.join(__dirname, "..", "server.js"), "utf8");

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
function build(db, src, expose) {
	const deps = {
		db, eldMiles, Date: FakeDate,
		localDayInTz: eldMiles.localDayInTz, usTzForLongitude: eldMiles.usTzForLongitude,
		console: { log: () => {}, error: (...a) => { throw new Error(a.join(" ")); } },
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
const UTIL_SRC = [fn("getWeekRange"), fn("appDay")].join("");
check("§3.0 the per-load measurement reads the device the truck held then",
	/deviceResolver\.vehicleForTruckAt\(truck\.truck_id, win\.endMs\)/.test(fn("measureLoadEldMiles")), true);

(async () => {
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

	const w = build(db, ROLLUP_SRC, ["runEldMilesDailyRollup", "rollupEldMilesDaily"].filter((n) => new RegExp(`function ${n}\\(`).test(ROLLUP_SRC)));
	if (w.runEldMilesDailyRollup) await w.runEldMilesDailyRollup();
	else w.rollupEldMilesDaily(10);
	const daily = db.prepare("SELECT local_day, truck_id, driver_name, miles FROM eld_miles_daily ORDER BY local_day").all()
		.map((r) => [r.local_day, r.truck_id, r.driver_name, r.miles]);
	check("§3.1 the rollup keeps the device's days before the re-point on the truck that drove them, with its driver", daily, [
		["2026-09-26", A, "Alice Able", 96], ["2026-09-27", A, "Alice Able", 96], ["2026-09-28", A, "Alice Able", 96],
		["2026-09-29", B, "Bob Baker", 96], ["2026-09-30", B, "Bob Baker", 96], ["2026-10-01", B, "Bob Baker", 96],
	]);

	let body = null;
	const app = { get: (p, ...h) => { app.handler = h[h.length - 1]; } };
	const routeDeps = {
		app, db, eldMiles, Date: FakeDate, requireRole: () => null, mileageAnalyticsLimiter: null,
		APP_TIMEZONE: require("../lib/app-time").appTimeZone(),
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

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((err) => {
	console.error("crashed:", err);
	process.exit(1);
});
