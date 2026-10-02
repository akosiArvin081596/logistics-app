#!/usr/bin/env node
// The daily ELD miles rollup (eld_miles_daily) catches up after downtime:
// runEldMilesDailyRollup() + rollupEldMilesDailyRange() in server.js.
//
// WHY THIS EXISTS. rollupEldMilesDaily(daysBack = 3) re-derived a fixed three
// days every six hours. A server down for longer than that left the days in
// between with no row, and once their pings aged past the 90-day purge nothing
// could ever write them. Pinned here:
//   1. after more than three days of downtime the next run writes every day
//      since the last successful run, each from its whole day of pings;
//   2. with no marker yet, the run starts from the newest row it ever wrote,
//      and with no rows at all from the whole retained window;
//   3. the same fail-closed upsert: a re-run over a partly purged day never
//      lowers a stored row;
//   4. the purge-boundary day (already partly deleted) is never written;
//   5. two overlapping runs cannot interleave, and a successful run leaves its
//      marker.
//
// Lifted verbatim and run against an in-memory SQLite with a controllable
// clock. SERVER_JS=<path> runs another copy of server.js (one that predates the
// catch-up runs its fixed 3-day rollup in the same places).
//
// No network, no sheet, no app.db, no server.
//
//   node scripts/test-eld-miles-catchup.js      # exits 1 on any failure

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

const SRC = [
	decl("const", "ELD_DEVICE_HISTORY_START_KEY", { optional: true }),
	fn("eldDeviceHistoryStartMs", { optional: true }),
	fn("buildEldDeviceResolver", { optional: true }),
	fn("buildDriverAtResolver"),
	decl("const", "ELD_STATE_MILES_BOUNDARY_MS"),
	decl("const", "ELD_MILES_DAILY_LAST_RUN_KEY", { optional: true }),
	decl("const", "ELD_MILES_DAILY_MAX_DAYS", { optional: true }),
	decl("const", "ELD_MILES_DAILY_MIN_DAYS", { optional: true }),
	decl("let", "eldMilesDailyRunning", { optional: true }),
	fn("rollupEldMilesDailyRange", { optional: true }),
	fn("runEldMilesDailyRollup", { optional: true }),
	fn("rollupEldMilesDaily", { optional: true }),
].join("");
const HAS_CATCHUP = /async function runEldMilesDailyRollup\(/.test(SRC);
check("§0 the catch-up runner ships", HAS_CATCHUP, true);
const STATE_DDL = lift(/CREATE TABLE IF NOT EXISTS server_state \([\s\S]*?\n\t\)/g, "server_state DDL");
const MILES_DDL = lift(/CREATE TABLE IF NOT EXISTS eld_miles_daily \([\s\S]*?\n\t\)/g, "eld_miles_daily DDL");
const HISTORY_DDL = lift(/CREATE TABLE IF NOT EXISTS eld_device_assignments \([\s\S]*?\n\t\)/g, "eld_device_assignments DDL", { optional: true });

const DAY = 86400000;
const MIN = 60000;
const NOW = Date.parse("2026-10-02T17:00:00Z");
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function world() {
	let clock = NOW;
	class FakeDate extends Date {
		constructor(...args) { super(...(args.length ? args : [clock])); }
		static now() { return clock; }
	}
	const db = new Database(":memory:");
	for (const sql of [STATE_DDL, MILES_DDL, HISTORY_DDL]) if (sql) db.exec(sql);
	db.exec(`CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, routemate_vehicle_id TEXT DEFAULT '')`);
	db.exec(`CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '')`);
	db.exec(`CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT NOT NULL,
		latitude REAL, longitude REAL, odometer REAL, location_date_ms INTEGER, dropped_reason TEXT DEFAULT '')`);
	db.prepare("INSERT INTO trucks (id, unit_number, routemate_vehicle_id) VALUES (33, 'LogisX-#33', 'vid-33')").run();
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (33, 'Dee Driver', '2026-01-01T00:00:00.000Z')").run();
	const logs = [];
	const deps = {
		db, eldMiles, Date: FakeDate,
		localDayInTz: eldMiles.localDayInTz, usTzForLongitude: eldMiles.usTzForLongitude,
		console: { log: (s) => logs.push(String(s)), error: (s, e) => logs.push(`ERR ${s} ${e || ""}`) },
	};
	const names = Object.keys(deps);
	const api = new Function(...names, `${SRC}\nreturn { ${["runEldMilesDailyRollup", "rollupEldMilesDaily"].filter((n) => new RegExp(`function ${n}\\(`).test(SRC)).join(", ")} };`)(
		...names.map((n) => deps[n]));
	// The scheduled call, whichever shape this server.js has.
	const run = async () => (api.runEldMilesDailyRollup ? api.runEldMilesDailyRollup() : api.rollupEldMilesDaily(3));
	// One day's driving, 09:00-17:00 Houston, a ping every 10 minutes, 2 mi each;
	// parked overnight. Only pings already in the past are inserted.
	const pending = [];
	let odo = 500000;
	const drive = (day) => {
		const start = Date.parse(`${day}T14:00:00Z`);
		for (let i = 0; i <= 48; i++) { pending.push([start + i * 10 * MIN, odo]); if (i < 48) odo += 2; }
	};
	const ins = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, odometer, location_date_ms) VALUES ('vid-33', 31.5, -95.4, ?, ?)");
	const arrive = () => {
		pending.sort((a, b) => a[0] - b[0]);
		while (pending.length && pending[0][0] <= clock) { const [ms, o] = pending.shift(); ins.run(o, ms); }
	};
	const rows = () => db.prepare("SELECT local_day AS d, miles AS m, samples AS n FROM eld_miles_daily ORDER BY local_day").all();
	return { db, logs, run, drive, arrive, rows, setClock: (ms) => { clock = ms; } };
}

(async () => {
	// -------------------------------------------------------------------------
	// 1. Six days of downtime.
	// -------------------------------------------------------------------------
	{
		const w = world();
		for (let d = NOW - 14 * DAY; d <= NOW; d += DAY) w.drive(isoDay(d));
		w.setClock(NOW - 6 * DAY);          // the last run before the outage
		w.arrive();
		await w.run();
		w.setClock(NOW);                    // back up six days later
		w.arrive();
		const second = await w.run();
		const byDay = new Map(w.rows().map((r) => [r.d, r]));
		const gap = ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"];
		check("§1.1 after six days down, every day of the outage has its row", gap.filter((d) => !byDay.has(d)), []);
		check("§1.2 ...each from its whole day of pings (49 samples, 96 mi)",
			gap.map((d) => byDay.get(d) && [byDay.get(d).n, byDay.get(d).m]), gap.map(() => [49, 96]));
		if (HAS_CATCHUP) check("§1.3 the run re-derived the days since the last run", second.daysBack, 7);
		check("§1.4 nothing went wrong", w.logs.filter((l) => l.startsWith("ERR")), []);
		if (HAS_CATCHUP) {
			const marker = JSON.parse(w.db.prepare("SELECT value FROM server_state WHERE key = 'eld_miles_daily_last_run'").get().value);
			check("§1.5 a successful run leaves its marker", [marker.atMs, marker.daysBack], [NOW, 7]);
			check("§1.6 a long catch-up is logged", w.logs.some((l) => /caught up 7 days/.test(l)), true);
			const quiet = await w.run();
			check("§1.7 the next run on schedule goes back the minimum 3 days", quiet.daysBack, 3);
		}
	}

	// -------------------------------------------------------------------------
	// 2. No marker yet: the newest row it ever wrote; no rows: the whole window.
	// -------------------------------------------------------------------------
	if (HAS_CATCHUP) {
		const w = world();
		for (let d = NOW - 20 * DAY; d <= NOW; d += DAY) w.drive(isoDay(d));
		w.arrive();
		w.db.prepare(`INSERT INTO eld_miles_daily (routemate_vehicle_id, local_day, driver_key, driver_name, truck_id, miles, samples, computed_at)
			VALUES ('vid-33', '2026-09-19', 'dee driver', 'Dee Driver', 33, 96, 49, '2026-09-20 12:00:00')`).run();
		const r = await w.run();
		check("§2.1 first run after deploy: from the newest row it ever wrote", r.daysBack, 14);
		const fresh = world();
		for (let d = NOW - 20 * DAY; d <= NOW; d += DAY) fresh.drive(isoDay(d));
		fresh.arrive();
		const full = await fresh.run();
		check("§2.2 an empty table: the whole retained window", [full.daysBack, fresh.rows().length, fresh.rows()[0].d], [95, 21, "2026-09-12"]);
	}

	// -------------------------------------------------------------------------
	// 3-4. The guard, and the purge-boundary day.
	// -------------------------------------------------------------------------
	if (HAS_CATCHUP) {
		const w = world();
		// Oldest ping 89.9 days old: its day is already partly purged.
		const firstMs = NOW - 90 * DAY;
		for (let d = Date.parse(`${isoDay(firstMs)}T00:00:00Z`); d < NOW - DAY / 2; d += DAY) w.drive(isoDay(d));
		w.arrive();
		const boundaryDay = isoDay(Date.parse(`${isoDay(firstMs)}T00:00:00Z`));
		w.db.prepare("DELETE FROM routemate_telemetry WHERE location_date_ms < ?").run(Date.parse(`${boundaryDay}T17:00:00Z`));
		await w.run();
		const days = w.rows().map((r) => r.d);
		check("§3.1 the purge-boundary day is never written", days.includes(boundaryDay), false);
		check("§3.2 ...the day after it is", days[0], isoDay(Date.parse(`${boundaryDay}T12:00:00Z`) + DAY));
		const before = w.rows();
		// A day inside the window loses an hour of pings (a partial purge, or a
		// replay that sees less); a full re-run must not lower its stored row.
		const thinned = isoDay(NOW - 10 * DAY);
		w.db.prepare("DELETE FROM routemate_telemetry WHERE location_date_ms > ? AND location_date_ms < ?")
			.run(Date.parse(`${thinned}T15:00:00Z`), Date.parse(`${thinned}T16:00:00Z`));
		w.db.prepare("DELETE FROM server_state").run();
		w.db.prepare("UPDATE eld_miles_daily SET computed_at = '2026-01-01 00:00:00'").run();
		const rerun = await w.run();
		const after = w.rows();
		check("§3.3 a re-run over a thinned day never lowers its stored row (49 samples kept)",
			[rerun.daysBack, after.find((r) => r.d === thinned)], [95, before.find((r) => r.d === thinned)]);
		check("§3.4 ...and every other day is unchanged", JSON.stringify(after) === JSON.stringify(before), true);
	}

	// -------------------------------------------------------------------------
	// 5. Two overlapping runs.
	// -------------------------------------------------------------------------
	if (HAS_CATCHUP) {
		const w = world();
		for (let d = NOW - 5 * DAY; d <= NOW; d += DAY) w.drive(isoDay(d));
		w.arrive();
		const a = w.run();
		check("§5.1 an overlapping run skips", await w.run(), { skipped: "busy" });
		await a;
	}

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((err) => {
	console.error("crashed:", err);
	process.exit(1);
});
