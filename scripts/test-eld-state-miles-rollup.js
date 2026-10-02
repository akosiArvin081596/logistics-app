#!/usr/bin/env node
// rollupEldStateMilesRange() + runEldStateMilesRollup() (server.js): the writer
// of eld_state_miles_daily, lifted verbatim and run against an in-memory SQLite.
//
// WHY THIS EXISTS. This table is written once from telemetry that is then
// deleted, so its writer gets one chance per day to be right. Pinned here:
//   1. the FIRST run backfills the whole retained window and sets its marker;
//   2. the purge-boundary day (already partly deleted) is never written, but a
//      newly linked truck's first, partial day is;
//   3. every truck-day's state rows sum to the odometer walk's day miles;
//   4. a second run changes nothing;
//   5. a run over a partly purged day never lowers a stored row;
//   6. after a long outage the next run catches up instead of leaving a hole;
//   7. two overlapping runs cannot interleave.
//
// No network, no sheet, no app.db, no server.
//
//   node scripts/test-eld-state-miles-rollup.js      # exits 1 on any failure

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const eldMiles = require("../lib/eld-miles");
const usStates = require("../lib/us-states");

const SHIPPED = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

// --- Lift the shipped code ----------------------------------------------------
function liftOnce(re, label) {
	const all = [...SHIPPED.matchAll(re)];
	if (all.length !== 1) throw new Error(`${label}: expected exactly one match, found ${all.length}`);
	return all[0][0];
}
const lifted = [
	liftOnce(/\nconst ELD_STATE_MILES_BACKFILL_KEY = [^\n]*\n/g, "backfill key"),
	liftOnce(/\nconst ELD_STATE_MILES_LAST_RUN_KEY = [^\n]*\n/g, "last-run key"),
	liftOnce(/\nconst ELD_STATE_MILES_MAX_DAYS = [^\n]*\n/g, "max days"),
	liftOnce(/\nconst ELD_STATE_MILES_BOUNDARY_MS = [^\n]*\n/g, "boundary"),
	liftOnce(/\nlet eldStateMilesRunning = [^\n]*\n/g, "running flag"),
	liftOnce(/\nasync function rollupEldStateMilesRange\([\s\S]*?\n}\n/g, "rollupEldStateMilesRange"),
	liftOnce(/\nasync function runEldStateMilesRollup\([\s\S]*?\n}\n/g, "runEldStateMilesRollup"),
].join("");
const tableDdl = liftOnce(/CREATE TABLE IF NOT EXISTS eld_state_miles_daily \([\s\S]*?\n\t\)/g, "table DDL");
const stateDdl = liftOnce(/CREATE TABLE IF NOT EXISTS server_state \([\s\S]*?\n\t\)/g, "server_state DDL");

// --- A world with a controllable clock -----------------------------------------
const DAY = 86400000;
const MIN = 60000;
let clock = Date.parse("2026-10-02T12:00:00Z");
class FakeDate extends Date {
	static now() { return clock; }
}
const logs = [];
const quietConsole = { log: (s) => logs.push(String(s)), error: (s, e) => logs.push(`ERR ${s} ${e || ""}`) };

const db = new Database(":memory:");
db.exec(tableDdl);
db.exec(stateDdl);
db.exec(`CREATE TABLE trucks (id INTEGER PRIMARY KEY, routemate_vehicle_id TEXT)`);
db.exec(`CREATE TABLE routemate_telemetry (
	id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT NOT NULL,
	latitude REAL, longitude REAL, odometer REAL, location_date_ms INTEGER,
	dropped_reason TEXT DEFAULT '')`);
db.prepare("INSERT INTO trucks (id, routemate_vehicle_id) VALUES (?, ?)").run(33, "vid-33");
db.prepare("INSERT INTO trucks (id, routemate_vehicle_id) VALUES (?, ?)").run(356, "vid-356");
db.prepare("INSERT INTO trucks (id, routemate_vehicle_id) VALUES (?, ?)").run(2, "");

const api = new Function("db", "eldMiles", "usStates", "console", "Date",
	`${lifted}\nreturn { rollupEldStateMilesRange, runEldStateMilesRollup };`
)(db, eldMiles, usStates, quietConsole, FakeDate);

// One day's driving: 14:00Z-22:00Z (09:00-17:00 Central), a ping every 10 min,
// north from Gainesville TX across the Red River to Ardmore OK.
const odo = { "vid-33": 400000, "vid-356": 90000 };
const insertPing = db.prepare(
	"INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, odometer, location_date_ms) VALUES (?, ?, ?, ?, ?)"
);
function driveDay(vid, dayIso, fromHour = 14) {
	const start = Date.parse(`${dayIso}T${String(fromHour).padStart(2, "0")}:00:00Z`);
	const n = (22 - fromHour) * 6 + 1;
	for (let i = 0; i < n; i++) {
		insertPing.run(vid, 33.62 + (0.55 * i) / (n - 1), -97.14, odo[vid], start + i * 10 * MIN);
		odo[vid] += 2;
	}
}
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// #33: every day of the retained window. Its oldest ping is ~89.9 days old (as
// in production, where it is ~90.6), so that first day is the purge-boundary day.
const firstDayMs = clock - 90 * DAY;
for (let d = Date.parse(`${isoDay(firstDayMs)}T00:00:00Z`); d <= clock; d += DAY) {
	if (isoDay(d) === isoDay(clock)) continue; // today's driving starts after "now"
	driveDay("vid-33", isoDay(d));
}
// #356: linked 4 days ago, first ping mid-afternoon. Not at the boundary.
for (let k = 4; k >= 1; k--) driveDay("vid-356", isoDay(clock - k * DAY), k === 4 ? 18 : 14);

function snapshot() {
	return db.prepare(
		"SELECT routemate_vehicle_id AS v, local_day AS d, state AS s, miles AS m, samples AS n FROM eld_state_miles_daily ORDER BY v, d, s"
	).all();
}
function dayMilesFromWalk(vid, day) {
	const pings = db.prepare(
		"SELECT location_date_ms AS ms, odometer AS odo, longitude AS lng FROM routemate_telemetry WHERE routemate_vehicle_id = ? ORDER BY ms"
	).all(vid);
	const dayOf = (ms, lng) => eldMiles.localDayInTz(ms, eldMiles.usTzForLongitude(lng));
	let total = 0;
	for (const b of eldMiles.splitDeltasByDayAndDriver(pings, { dayOf, driverAt: () => "" }).values()) {
		if (b.localDay === day) total += b.miles;
	}
	return Math.round(total * 10) / 10;
}
function stateSum(vid, day) {
	const r = db.prepare(
		"SELECT ROUND(SUM(miles), 1) AS m FROM eld_state_miles_daily WHERE routemate_vehicle_id = ? AND local_day = ?"
	).get(vid, day);
	return r.m;
}

(async () => {
	// -------------------------------------------------------------------------
	// 1-2. First run: the backfill.
	// -------------------------------------------------------------------------
	const first = await api.runEldStateMilesRollup();
	const marker = JSON.parse(db.prepare("SELECT value FROM server_state WHERE key = 'eld_state_miles_backfill_v1'").get().value);
	const days33 = db.prepare("SELECT DISTINCT local_day AS d FROM eld_state_miles_daily WHERE routemate_vehicle_id = 'vid-33' ORDER BY d").all().map((r) => r.d);
	const days356 = db.prepare("SELECT DISTINCT local_day AS d FROM eld_state_miles_daily WHERE routemate_vehicle_id = 'vid-356' ORDER BY d").all().map((r) => r.d);
	const boundaryDay = isoDay(firstDayMs);

	check("the boundary day of #33 is not written", days33.includes(boundaryDay), false);
	check("every later day of #33 is written", days33.length, 89);
	check("#33 starts the day after the boundary", days33[0], isoDay(firstDayMs + DAY));
	check("#356's first, partial day is kept (not at the boundary)", days356, [
		isoDay(clock - 4 * DAY), isoDay(clock - 3 * DAY), isoDay(clock - 2 * DAY), isoDay(clock - DAY),
	]);
	check("a truck with no ELD link writes nothing",
		db.prepare("SELECT COUNT(*) AS n FROM eld_state_miles_daily WHERE truck_id = 2").get().n, 0);
	check("the marker records the truck-days recovered", marker.truckDays, 93);
	check("the run reports the same", first.truckDays, 93);
	check("one backfill log line", logs.filter((l) => l.startsWith("[eld-state-miles] backfill: 93 truck-days")).length, 1);
	check("both states appear", db.prepare("SELECT DISTINCT state AS s FROM eld_state_miles_daily ORDER BY s").all().map((r) => r.s), ["OK", "TX"]);

	// -------------------------------------------------------------------------
	// 3. Each truck-day's state rows sum to the odometer walk's day miles.
	// -------------------------------------------------------------------------
	for (const [vid, day] of [["vid-33", days33[0]], ["vid-33", days33[40]], ["vid-33", days33[88]], ["vid-356", days356[0]]]) {
		check(`${vid} ${day}: state rows sum to the day's miles`, stateSum(vid, day), dayMilesFromWalk(vid, day));
	}

	// -------------------------------------------------------------------------
	// 4. A second run changes nothing.
	// -------------------------------------------------------------------------
	const before = snapshot();
	clock += 6 * 3600000;
	const second = await api.runEldStateMilesRollup();
	check("the second run re-derives only recent days", second.truckDays <= 8, true);
	check("the second run changes nothing", snapshot(), before);
	check("no second backfill log line", logs.filter((l) => l.includes("backfill:")).length, 1);

	// -------------------------------------------------------------------------
	// 5. A partly purged day is never lowered.
	// -------------------------------------------------------------------------
	const victim = isoDay(clock - 2 * DAY);
	const keepRows = snapshot().filter((r) => r.v === "vid-33" && r.d === victim);
	db.prepare("DELETE FROM routemate_telemetry WHERE routemate_vehicle_id = 'vid-33' AND location_date_ms < ? AND location_date_ms >= ?")
		.run(Date.parse(`${victim}T18:00:00Z`), Date.parse(`${victim}T00:00:00Z`));
	clock += 6 * 3600000;
	await api.runEldStateMilesRollup();
	check("a partly purged day keeps its complete figures",
		snapshot().filter((r) => r.v === "vid-33" && r.d === victim), keepRows);

	// -------------------------------------------------------------------------
	// 6. Catch-up after a 10-day outage.
	// -------------------------------------------------------------------------
	const outageStart = clock;
	for (let k = 0; k < 10; k++) driveDay("vid-33", isoDay(outageStart + k * DAY));
	clock = outageStart + 10 * DAY + 3600000;
	const caught = await api.runEldStateMilesRollup();
	const missing = [];
	for (let k = 0; k < 10; k++) {
		const d = isoDay(outageStart + k * DAY);
		if (!db.prepare("SELECT 1 FROM eld_state_miles_daily WHERE routemate_vehicle_id = 'vid-33' AND local_day = ?").get(d)) missing.push(d);
	}
	check("every day of the outage is filled in", missing, []);
	check("the window widened past 3 days",
		JSON.parse(db.prepare("SELECT value FROM server_state WHERE key = 'eld_state_miles_last_run'").get().value).daysBack >= 11, true);
	check("the catch-up run counted the outage days", caught.truckDays >= 10, true);

	// -------------------------------------------------------------------------
	// 7. Overlapping runs cannot interleave.
	// -------------------------------------------------------------------------
	const a = api.runEldStateMilesRollup();
	const b = await api.runEldStateMilesRollup();
	await a;
	check("a run already in progress makes the second one skip", b, { skipped: "busy" });
	check("no errors were logged", logs.filter((l) => l.startsWith("ERR")), []);

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((err) => {
	console.error("crashed:", err);
	process.exit(1);
});
