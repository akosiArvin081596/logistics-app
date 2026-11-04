#!/usr/bin/env node
// lib/eld-activity-daily.js and its wiring in server.js: the daily ELD activity
// rollup (driving, engine-on and idle minutes, speeding episodes), stored only.
//
//   §1 the estimate (activityRows): the 2.235 m/s line, a gap over 5 minutes
//      counts nothing, a stop under 5 minutes inside a drive is driving, idle is
//      the engine rising in a stop of 5 minutes or more, engine-on never exceeds
//      the stretch and skips a broken reading, NULL (never 0) without an
//      engine-hours reading (Linxup) or an observed step, speeding at 75 mph held
//      60 s, a Central and a Pacific Friday night split at the Eastern week line,
//      a handover split by driver, coverage over a daylight-saving day
//   §2 the rollup (createEldActivityRollup): the first run reads 90 days and skips
//      the purge-boundary day, a second run changes nothing, a partly purged day is
//      kept, a re-assigned day is replaced whole, a long outage is caught up, two
//      runs never overlap, a failure never rejects, it writes only its own table
//      and two markers, and what it reads is bounded
//   §3 server.js: a kill switch, on unless false, 0, no or off (off: no table, no
//      job); on: the table, the job every 6 hours, and server.js's own week, driver
//      and boundary, all of which only read
//   §4 stored only: nothing outside the module names the table, and the replica
//      rules refuse the flag
//
// No network, no sheet, no app.db, no server: an in-memory SQLite and made-up data.
//
//   node scripts/test-eld-activity-daily.js      # exits 1 on any failure

"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const eldMiles = require("../lib/eld-miles");
const replicaRules = require("../lib/replica-rules");
const { serverSource } = require("./lib/server-source");

const ROOT = path.join(__dirname, "..");
const SHIPPED = serverSource();

let A;
try {
	A = require("../lib/eld-activity-daily");
} catch (err) {
	const why = `lib/eld-activity-daily.js did not load (${err.message.split("\n")[0]})`;
	A = new Proxy({}, { get() { throw new Error(why); } });
}

let failures = 0;
let passes = 0;
const ok = (name, cond, detail) => {
	if (cond) { passes++; console.log(`  ok   ${name}`); return; }
	failures++;
	console.log(`  FAIL ${name}${detail !== undefined ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
async function test(name, fn) {
	try { await fn(); } catch (err) { failures++; console.log(`  FAIL ${name}  (threw: ${err.message.split("\n")[0]})`); }
}

function liftOnce(re, label) {
	const all = [...SHIPPED.matchAll(re)];
	if (all.length !== 1) throw new Error(`${label}: expected exactly one match in server.js, found ${all.length}`);
	return all[0][0];
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const S15 = 15 * 1000;

// server.js's own business week (Sat-Fri, US Eastern), lifted, not copied.
const getWeekRange = new Function("APP_TIMEZONE", `${liftOnce(/\nfunction getWeekRange\([\s\S]*?\n}\n/g, "getWeekRange")}\nreturn getWeekRange;`)("America/New_York");
const weekStartOf = (ms) => getWeekRange(ms).weekStart;

// Pings from startMs: each part adds `n` pings `step` ms apart at `speed` m/s.
// The engine-hours meter runs unless engine is false; `tick` rounds the reading
// down like a coarse meter, `jump` shifts it once, `jitter` wobbles alternate pings.
function track(startMs, parts, opts = {}) {
	const { eh0 = 1000, lng = -80, source = "routemate", tick = 0 } = opts;
	const pings = [];
	let ms = startMs;
	let eh = eh0;
	let index = 0;
	const reading = (jitter) => {
		const base = tick ? Math.floor(eh / tick + 1e-9) * tick : eh;
		return base + (jitter && index % 2 ? jitter : 0);
	};
	pings.push({ ms, speed: parts[0].speed, eh: reading(parts[0].jitter), lng, source });
	for (const p of parts) {
		for (let k = 0; k < p.n; k++) {
			ms += p.step;
			index += 1;
			if (p.engine !== false) eh += p.step / HOUR;
			if (k === 0 && p.jump) eh += p.jump;
			pings.push({ ms, speed: p.speed, eh: reading(p.jitter), lng: p.lng === undefined ? lng : p.lng, source });
		}
	}
	return pings;
}
const drive = (n, extra = {}) => ({ n, step: S15, speed: 25, ...extra });
const stop = (n, extra = {}) => ({ n, step: S15, speed: 0, ...extra });
const fixedWeek = () => "2026-10-10";
const one = (pings, opts = {}) => {
	const rows = A.activityRows(pings, { weekOf: fixedWeek, driverAt: () => 7, ...opts });
	if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
	return rows[0];
};
const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row[k]]));
const WED = Date.parse("2026-10-14T14:00:00Z");

(async () => {
	// ---- §1 the estimate --------------------------------------------------------------------
	console.log("§1 the estimate");

	await test("a 30-minute drive at 15 s pings", () => {
		const r = one(track(WED, [drive(120)]));
		eq("a 30-minute drive: 30 driving, 30 engine-on, 0 idle, 0 speeding", pick(r, ["driving_min", "engine_on_min", "idle_min", "speeding_episodes", "observed_min", "samples", "basis"]),
			{ driving_min: 30, engine_on_min: 30, idle_min: 0, speeding_episodes: 0, observed_min: 30, samples: 121, basis: "gps-estimate" });
	});

	await test("exactly 2.235 m/s is not driving", () => {
		const r = one(track(WED, [{ n: 120, step: S15, speed: 2.235 }]));
		eq("speed exactly 2.235 m/s: a stop (30 idle), not driving", pick(r, ["driving_min", "idle_min"]), { driving_min: 0, idle_min: 30 });
	});

	await test("a gap over 5 minutes counts nothing; exactly 5 minutes counts", () => {
		const gap = one(track(WED, [drive(40), { n: 1, step: 5 * MIN + 1000, speed: 25 }, drive(40)]));
		eq("a 5 min 1 s step between two 10-minute drives: 20 driving, 20 observed, 20 engine-on", pick(gap, ["driving_min", "observed_min", "engine_on_min"]), { driving_min: 20, observed_min: 20, engine_on_min: 20 });
		const five = one(track(WED, [drive(40), { n: 1, step: 5 * MIN, speed: 25 }, drive(40)]));
		eq("an exactly 5-minute step counts: 25 driving", pick(five, ["driving_min", "observed_min"]), { driving_min: 25, observed_min: 25 });
	});

	await test("stops under and at 5 minutes", () => {
		const inside = one(track(WED, [drive(40), stop(16), drive(40)]));
		eq("a 4-minute stop between drives is driving: 24 driving, 0 idle", pick(inside, ["driving_min", "idle_min", "engine_on_min"]), { driving_min: 24, idle_min: 0, engine_on_min: 24 });
		const five = one(track(WED, [drive(40), stop(20), drive(40)]));
		eq("a 5-minute stop is a stop: 20 driving, 5 idle", pick(five, ["driving_min", "idle_min", "engine_on_min"]), { driving_min: 20, idle_min: 5, engine_on_min: 25 });
		const edge = one(track(WED, [drive(40), stop(16), { n: 1, step: 30 * MIN, speed: 0 }, drive(40)]));
		eq("a 4-minute stop before a gap is not inside a drive: 20 driving, 0 idle, 24 engine-on", pick(edge, ["driving_min", "idle_min", "engine_on_min", "observed_min"]), { driving_min: 20, idle_min: 0, engine_on_min: 24, observed_min: 24 });
	});

	await test("idle and engine-on", () => {
		const off = one(track(WED, [drive(40), stop(120, { engine: false }), drive(40)]));
		eq("a 30-minute stop, engine off: 0 idle", pick(off, ["driving_min", "idle_min", "engine_on_min"]), { driving_min: 20, idle_min: 0, engine_on_min: 20 });
		const on = one(track(WED, [drive(40), stop(120), drive(40)]));
		eq("a 30-minute stop, engine running: 30 idle, 50 engine-on", pick(on, ["driving_min", "idle_min", "engine_on_min"]), { driving_min: 20, idle_min: 30, engine_on_min: 50 });
		const coarse = one(track(WED, [drive(12)], { eh0: 100.099, tick: 0.1 }));
		eq("a 0.1 h meter tick inside a 3-minute stretch credits 3 minutes, not 6", pick(coarse, ["driving_min", "engine_on_min"]), { driving_min: 3, engine_on_min: 3 });
		const jump = one(track(WED, [drive(60), drive(1, { jump: 5 }), drive(60)]));
		eq("a 5-hour jump in one step is a broken reading: that step's 15 s is left out", pick(jump, ["driving_min", "engine_on_min"]), { driving_min: 30.25, engine_on_min: 30 });
		const reset = one(track(WED, [drive(60), drive(1, { jump: -900 }), drive(60)]));
		eq("a meter reset in one step is left out too", reset.engine_on_min, 30);
		const jitter = one(track(WED, [stop(120, { jitter: 0.05 })]));
		eq("a meter wobbling 0.05 h every other ping credits the true 30 minutes", pick(jitter, ["idle_min", "engine_on_min"]), { idle_min: 30, engine_on_min: 30 });
	});

	await test("NULL, never 0", () => {
		const keys = ["driving_min", "engine_on_min", "idle_min", "speeding_episodes", "basis"];
		const nulls = { driving_min: null, engine_on_min: null, idle_min: null, speeding_episodes: null, basis: "no-hours-data" };
		const linxup = one(track(WED, [drive(120, { engine: false })], { eh0: 0, source: "linxup" }));
		eq("a Linxup day (no engine hours): every measure NULL", pick(linxup, keys), nulls);
		eq("...with its pings and coverage still counted", pick(linxup, ["samples", "observed_min", "coverage"]), { samples: 121, observed_min: 30, coverage: 0.0208 });
		const legacy = one(track(WED, [drive(120, { engine: false })], { eh0: 0, source: "" }));
		eq("a row from before the source column with no engine hours: NULL", pick(legacy, keys), nulls);
		const linxupHours = one(track(WED, [drive(120)], { eh0: 500, source: "linxup" }));
		eq("a Linxup row carrying engine hours is still not an hours source: NULL", pick(linxupHours, keys), nulls);
		const parked = one(track(WED, [{ n: 120, step: MIN, speed: 0, engine: false }]));
		eq("a RouteMate truck parked with the engine off: real zeros", pick(parked, keys), { driving_min: 0, engine_on_min: 0, idle_min: 0, speeding_episodes: 0, basis: "gps-estimate" });
		const sparse = one(track(WED, [{ n: 12, step: 10 * MIN, speed: 25 }]));
		eq("RouteMate pings 10 minutes apart: nothing observed, NULL", pick(sparse, keys), { driving_min: null, engine_on_min: null, idle_min: null, speeding_episodes: null, basis: "gps-estimate" });
	});

	await test("speeding episodes", () => {
		const fast = (n, speed = 34) => ({ n, step: S15, speed });
		const count = (parts) => one(track(WED, parts)).speeding_episodes;
		eq("34 m/s held 60 s: one episode", count([drive(20), fast(5), drive(20)]), 1);
		eq("held 45 s: none", count([drive(20), fast(4), drive(20)]), 0);
		eq("exactly 75 mph held 60 s: one", count([drive(20), fast(5, A.ELD_ACTIVITY_RULE.speedingMps), drive(20)]), 1);
		eq("just under 75 mph: none", count([drive(20), fast(5, 33.5), drive(20)]), 0);
		eq("two separate episodes: two", count([drive(20), fast(6), drive(10), fast(6), drive(20)]), 2);
		eq("a 6-minute gap splits a run: two runs under 60 s, none", count([drive(20), fast(2), { n: 1, step: 6 * MIN, speed: 34 }, fast(2), drive(20)]), 0);
	});

	await test("Friday night at the Eastern week line", () => {
		const start = Date.parse("2026-10-17T03:30:00Z");
		const opts = { weekOf: weekStartOf, driverAt: () => 7 };
		for (const [who, lng] of [["Pacific", -118], ["Central", -95]]) {
			const rows = A.activityRows(track(start, [drive(240)], { lng }), opts);
			eq(`a ${who} truck driving across Sat 00:00 ET: Friday split into two weeks`, rows.map((r) => [r.local_day, r.week_start, r.driving_min]),
				[["2026-10-16", "2026-10-10", 29.75], ["2026-10-16", "2026-10-17", 30.25]]);
		}
		const east = A.activityRows(track(start, [drive(240)], { lng: -80 }), opts);
		eq("an Eastern truck crosses its own midnight there: Friday and Saturday", east.map((r) => [r.local_day, r.week_start]), [["2026-10-16", "2026-10-10"], ["2026-10-17", "2026-10-17"]]);
	});

	await test("a handover splits the day by driver", () => {
		const handover = WED + 20 * MIN;
		const rows = A.activityRows(track(WED, [drive(160)]), { weekOf: fixedWeek, driverAt: (ms) => (ms < handover ? 7 : 8) });
		eq("two rows, one per driver", rows.map((r) => [r.driver_id, r.driving_min, r.samples]), [[7, 19.75, 80], [8, 20.25, 81]]);
		for (const bad of ["", null, 0, -3, 2.5, "Pat"]) {
			const r = one(track(WED, [drive(4)]), { driverAt: () => bad });
			eq(`driverAt answering ${JSON.stringify(bad)} is driver 0`, r.driver_id, 0);
		}
	});

	await test("coverage is the share of the truck-local day", () => {
		eq("2 observed hours on an ordinary day: 120 / 1440", one(track(WED, [drive(480)])).coverage, 0.0833);
		const fallBack = Date.parse("2026-11-01T15:00:00Z");
		eq("2 observed hours on the fall-back day (1500 minutes, Eastern)", one(track(fallBack, [drive(480)]), { weekOf: () => "2026-10-31" }).coverage, 0.08);
		eq("...and Pacific", one(track(fallBack + 3 * HOUR, [drive(480)], { lng: -118 }), { weekOf: () => "2026-10-31" }).coverage, 0.08);
	});

	// ---- §2 the rollup ----------------------------------------------------------------------
	console.log("§2 the rollup");

	const telemetryDdl = liftOnce(/CREATE TABLE IF NOT EXISTS routemate_telemetry \([\s\S]*?\n\t\)/g, "routemate_telemetry DDL");
	const telemetryAlters = [
		liftOnce(/ALTER TABLE routemate_telemetry ADD COLUMN dropped_reason [^`]*/g, "dropped_reason column"),
		liftOnce(/ALTER TABLE routemate_telemetry ADD COLUMN source [^`]*/g, "source column"),
	];
	const stateDdl = liftOnce(/CREATE TABLE IF NOT EXISTS server_state \([\s\S]*?\n\t\)/g, "server_state DDL");
	const BOUNDARY_MS = new Function(`${liftOnce(/\nconst ELD_STATE_MILES_BOUNDARY_MS = [^\n]*\n/g, "boundary")}\nreturn ELD_STATE_MILES_BOUNDARY_MS;`)();

	const quiet = { lines: [], log(s) { this.lines.push(String(s)); }, error(s, e) { this.lines.push(`ERR ${s} ${e || ""}`); } };
	function makeWorld() {
		const db = new Database(":memory:");
		db.exec(telemetryDdl);
		for (const sql of telemetryAlters) db.exec(sql);
		db.exec(stateDdl);
		db.exec("CREATE TABLE trucks (id INTEGER PRIMARY KEY, routemate_vehicle_id TEXT DEFAULT '')");
		db.prepare("INSERT INTO trucks (id, routemate_vehicle_id) VALUES (1, 'V1'), (2, 'V2'), (3, 'V3')").run();
		const assignments = [
			{ truck_id: 1, driver_name: "Pat Example", start_date: "2026-01-01T00:00:00.000Z", end_date: "" },
			{ truck_id: 2, driver_name: "Lee Sample", start_date: "2026-01-01T00:00:00.000Z", end_date: "" },
			{ truck_id: 3, driver_name: "Kim Test", start_date: "2026-01-01T00:00:00.000Z", end_date: "" },
		];
		const ids = { "pat example": 7, "lee sample": 8, "kim test": 9, "ray demo": 10 };
		const history = [{ truck_id: 3, routemate_vehicle_id: "V3", assigned_from: "2026-09-27T00:00:00.000Z", assigned_until: "" }];
		const historyStart = Date.parse("2026-09-02T12:00:00Z");
		const insert = db.prepare(`INSERT INTO routemate_telemetry (routemate_vehicle_id, longitude, latitude, speed, engine_hours, location_date_ms, source)
			VALUES (?, ?, 30, ?, ?, ?, ?)`);
		const add = (vid, pings) => { for (const p of pings) insert.run(vid, p.lng, p.speed, p.eh, p.ms, p.source); };
		const deps = {
			db,
			deviceResolver: () => eldMiles.buildDeviceTruckResolver(history, {
				startMs: historyStart,
				currentLinks: db.prepare("SELECT id, routemate_vehicle_id FROM trucks WHERE COALESCE(routemate_vehicle_id, '') <> '' ORDER BY id").all(),
			}),
			driverResolver: (truckIds) => eldMiles.buildDriverAtResolver(assignments.filter((a) => truckIds.includes(a.truck_id))),
			weekStartOf,
			driverIdFor: (name) => ids[String(name).toLowerCase()] || 0,
			boundaryMs: BOUNDARY_MS,
			log: quiet,
		};
		return { db, assignments, add, deps };
	}
	const snapshot = (db) => db.prepare(`SELECT routemate_vehicle_id, truck_id, local_day, week_start, driver_id, samples, observed_min, coverage,
		driving_min, engine_on_min, idle_min, speeding_episodes, basis, first_ms, last_ms FROM eld_activity_daily
		ORDER BY routemate_vehicle_id, local_day, week_start, driver_id`).all();
	const keys = (db) => db.prepare("SELECT routemate_vehicle_id, local_day, truck_id, driver_id FROM eld_activity_daily ORDER BY 1, 2, 4").all()
		.map((r) => [r.routemate_vehicle_id, r.local_day, r.truck_id, r.driver_id]);
	const stateOf = (db, key) => db.prepare("SELECT value FROM server_state WHERE key = ?").get(key);
	// The db the module sees: records every statement it prepares or runs, and the
	// arguments of each read of a range of pings.
	function spied(db) {
		const statements = [];
		const reads = [];
		const proxy = new Proxy(db, {
			get(target, prop) {
				const v = target[prop];
				if (prop === "exec") return (sql) => { statements.push(String(sql)); return v.call(target, sql); };
				if (prop === "prepare") {
					return (sql) => {
						statements.push(String(sql));
						const stmt = v.call(target, sql);
						return /location_date_ms >= \?/.test(sql) ? { all: (...args) => { reads.push(args); return stmt.all(...args); } } : stmt;
					};
				}
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		return { db: proxy, statements, reads };
	}

	const NOW = Date.parse("2026-10-02T12:00:00Z");
	let w = null;
	let rollup = null;
	await test("the first run reads 90 days", async () => {
		w = makeWorld();
		w.add("V1", track(Date.parse("2026-07-04T15:00:00Z"), [drive(480)]));
		w.add("V1", track(Date.parse("2026-08-03T14:00:00Z"), [drive(480)]));
		w.add("V1", track(Date.parse("2026-09-30T14:00:00Z"), [drive(240), stop(120), drive(60)]));
		w.add("V2", track(Date.parse("2026-09-22T14:00:00Z"), [drive(240)]));
		w.add("V3", track(Date.parse("2026-09-24T14:00:00Z"), [drive(240)]));
		w.add("V3", track(Date.parse("2026-09-29T14:00:00Z"), [drive(240)]));
		rollup = A.createEldActivityRollup(w.deps);
		const r = await rollup.run(NOW);
		eq("the first run goes back 90 days", r.daysBack, 90);
		ok("...and leaves its backfill and last-run markers", !!stateOf(w.db, A.ELD_ACTIVITY_BACKFILL_KEY) && !!stateOf(w.db, A.ELD_ACTIVITY_LAST_RUN_KEY));
		eq("rows: not the purge-boundary day (07-04), not a day the device was on no truck (V3 09-24), a newly linked device's first day kept",
			keys(w.db), [["V1", "2026-08-03", 1, 7], ["V1", "2026-09-30", 1, 7], ["V2", "2026-09-22", 2, 8], ["V3", "2026-09-29", 3, 9]]);
		const dayA = w.db.prepare("SELECT * FROM eld_activity_daily WHERE routemate_vehicle_id = 'V1' AND local_day = '2026-08-03'").get();
		eq("a stored day: its week, measures and coverage", pick(dayA, ["week_start", "driving_min", "engine_on_min", "idle_min", "coverage", "basis"]),
			{ week_start: "2026-08-01", driving_min: 120, engine_on_min: 120, idle_min: 0, coverage: 0.0833, basis: "gps-estimate" });
		const dayB = w.db.prepare("SELECT * FROM eld_activity_daily WHERE routemate_vehicle_id = 'V1' AND local_day = '2026-09-30'").get();
		eq("an hour's drive, a 30-minute idle, 15 more minutes", pick(dayB, ["driving_min", "idle_min", "engine_on_min"]), { driving_min: 75, idle_min: 30, engine_on_min: 105 });
		ok("...and says so once in the log", quiet.lines.some((l) => /^\[eld-activity\] backfill: 4 device-days, 2026-08-03\.\.2026-09-30$/.test(l)), quiet.lines);
	});

	await test("a second run changes nothing", async () => {
		const before = snapshot(w.db);
		const r = await rollup.run(NOW + HOUR);
		eq("the next run goes back the minimum 3 days", r.daysBack, 3);
		eq("...and every stored row is unchanged", snapshot(w.db), before);
	});

	await test("a partly purged day is kept", async () => {
		const before = snapshot(w.db);
		w.db.prepare("DELETE FROM routemate_telemetry WHERE routemate_vehicle_id = 'V1' AND location_date_ms < ? AND location_date_ms >= ?")
			.run(Date.parse("2026-08-03T15:00:00Z"), Date.parse("2026-08-03T00:00:00Z"));
		const r = await rollup.rollupRange(Date.parse("2026-08-02T00:00:00Z"), Date.parse("2026-08-05T00:00:00Z"), NOW);
		eq("the day with fewer pings than stored is kept, not lowered", r.daysKept, 1);
		eq("...its row unchanged (120 minutes, not 60)", snapshot(w.db), before);
	});

	await test("a re-assigned day is replaced whole", async () => {
		const before = w.db.prepare("SELECT SUM(samples) AS n FROM eld_activity_daily WHERE local_day = '2026-09-30'").get().n;
		w.assignments[0].end_date = "2026-09-30T00:00:00.000Z";
		w.assignments.push({ truck_id: 1, driver_name: "Ray Demo", start_date: "2026-09-30T00:00:00.000Z", end_date: "" });
		await rollup.rollupRange(Date.parse("2026-09-29T00:00:00Z"), Date.parse("2026-10-01T00:00:00Z"), NOW);
		const rows = w.db.prepare("SELECT driver_id, samples FROM eld_activity_daily WHERE local_day = '2026-09-30'").all();
		eq("the day now holds only the new driver, with the same pings", rows.map((r) => [r.driver_id, r.samples]), [[10, before]]);
	});

	await test("a long outage is caught up", async () => {
		w.add("V2", track(Date.parse("2026-10-12T14:00:00Z"), [drive(240)]));
		const r = await rollup.run(NOW + 20 * DAY);
		eq("20 days after the last run it goes back 21 days", r.daysBack, 21);
		ok("...and writes the day in between", keys(w.db).some((k) => k[0] === "V2" && k[1] === "2026-10-12"), keys(w.db));
	});

	await test("two runs never overlap", async () => {
		const first = rollup.run(NOW + 21 * DAY);
		eq("a run started while one is going is skipped", await rollup.run(NOW + 21 * DAY), { skipped: "busy" });
		const r = await first;
		ok("...and the first finishes", Number.isInteger(r.daysBack), r);
	});

	await test("a failed run resolves, logs and frees the next", async () => {
		const broken = makeWorld();
		broken.deps.deviceResolver = () => { throw new Error("made-up resolver failure"); };
		const r = A.createEldActivityRollup(broken.deps);
		eq("it resolves with the error", await r.run(NOW), { error: "made-up resolver failure" });
		eq("...and the next run is not refused as busy", await r.run(NOW), { error: "made-up resolver failure" });
		ok("...and logged it", quiet.lines.some((l) => l.startsWith("ERR [eld-activity] daily rollup failed:")));
	});

	await test("it writes only its own table and two markers", async () => {
		const world = makeWorld();
		world.add("V1", track(Date.parse("2026-09-30T14:00:00Z"), [drive(240), stop(120), drive(60)]));
		world.add("V2", track(Date.parse("2026-09-22T14:00:00Z"), [drive(240)]));
		const others = () => JSON.stringify(["routemate_telemetry", "trucks"].map((t) => world.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
		const before = others();
		const spy = spied(world.db);
		await A.createEldActivityRollup({ ...world.deps, db: spy.db }).run(NOW);
		const unique = (list) => [...new Set(list)].sort();
		const isRead = (sql) => /^\s*SELECT\b/i.test(sql);
		const written = (sql) => (/^\s*(?:CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS \w+ ON|INSERT(?: OR \w+)? INTO|DELETE FROM)\s+(\w+)/i.exec(sql) || [])[1] || `unrecognized: ${sql}`;
		eq("every write names its own table or server_state", unique(spy.statements.filter((s) => !isRead(s)).map(written)), ["eld_activity_daily", "server_state"]);
		eq("every read names the stored pings, the trucks, its own table or server_state",
			unique(spy.statements.filter(isRead).map((s) => /\bFROM\s+(\w+)/i.exec(s)[1])), ["eld_activity_daily", "routemate_telemetry", "server_state", "trucks"]);
		eq("server_state gains only its two markers", world.db.prepare("SELECT key FROM server_state ORDER BY key").all().map((r) => r.key),
			[A.ELD_ACTIVITY_BACKFILL_KEY, A.ELD_ACTIVITY_LAST_RUN_KEY].sort());
		ok("the pings and the trucks are unchanged", others() === before);
		const own = fs.readFileSync(path.join(ROOT, "lib", "eld-activity-daily.js"), "utf8");
		eq("the module loads only the time and miles helpers: no network, no sheet, no provider", [...own.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]).sort(), ['"./app-time"', '"./eld-miles"']);
	});

	await test("what a run reads is bounded", async () => {
		const world = makeWorld();
		world.add("V1", track(Date.parse("2026-06-30T15:00:00Z"), [drive(4)]));
		world.add("V1", track(Date.parse("2026-07-02T15:00:00Z"), [drive(480)]));
		world.add("V1", track(Date.parse("2026-07-06T15:00:00Z"), [drive(480)]));
		world.add("V2", track(Date.parse("2026-09-22T14:00:00Z"), [drive(240)]));
		world.add("V3", track(Date.parse("2026-09-29T14:00:00Z"), [drive(240)]));
		const spy = spied(world.db);
		const bounded = A.createEldActivityRollup({ ...world.deps, db: spy.db });
		let turns = 0;
		let done = false;
		const turn = () => { turns += 1; if (!done) setImmediate(turn); };
		setImmediate(turn);
		await bounded.run(NOW);
		done = true;
		eq("the first run reads 14 chunks for each of 3 devices", spy.reads.length, 42);
		ok("...each 9 days long", spy.reads.every(([, from, to]) => to - from === 9 * DAY), spy.reads.map(([, from, to]) => to - from));
		eq("...and none starts before the 90 days and their day of lead-in", new Date(Math.min(...spy.reads.map(([, from]) => from))).toISOString(), "2026-07-03T00:00:00.000Z");
		ok("...giving way to other work between chunks", turns >= 20, turns);
		eq("a day the purge left, older than the 90 days, is not read or written", keys(world.db).filter((k) => k[0] === "V1").map((k) => k[1]), ["2026-07-06"]);
		spy.reads.length = 0;
		const later = await bounded.run(NOW + 6 * HOUR);
		eq("the run 6 hours later goes back 3 days", later.daysBack, 3);
		eq("...and reads one chunk for each device", spy.reads.length, 3);
	});

	// ---- §3 server.js ------------------------------------------------------------------------
	console.log("§3 server.js");
	await test("the flag and the wiring", () => {
		const block = liftOnce(/\n\/\/ Daily ELD activity \(lib\/eld-activity-daily\.js\)[\s\S]*?\n}\n/g, "the wiring block");
		const real = require("../lib/eld-activity-daily");
		const boot = (value, jobsStart = true) => {
			const db = new Database(":memory:");
			db.exec(telemetryDdl);
			const calls = [];
			const timers = [];
			const spy = { createEldActivityRollup: (deps) => { calls.push(deps); return real.createEldActivityRollup(deps); } };
			const env = value === undefined ? {} : { ELD_ACTIVITY_DAILY_ENABLED: value };
			const fn = new Function("process", "require", "db", "buildEldDeviceResolver", "buildDriverAtResolver", "getWeekRange",
				"findDirectoryRowForDriver", "ELD_STATE_MILES_BOUNDARY_MS", "startsJob", "setTimeout", "setInterval",
				`${block}\nreturn { ELD_ACTIVITY_DAILY_ENABLED, eldActivityRollup };`);
			const out = fn(
				{ env },
				(p) => { if (p === "./lib/eld-activity-daily") return spy; throw new Error(`unexpected require ${p}`); },
				db,
				() => "device resolver",
				(ids) => ["driver resolver", ids],
				(ms) => ({ weekStart: `week of ${ms}` }),
				(name) => (name === "Pat Example" ? { id: 7, driver_name: name } : null),
				BOUNDARY_MS,
				(name) => { timers.push(["job", name]); return jobsStart; },
				(f, ms) => timers.push(["timeout", ms]),
				(f, ms) => timers.push(["interval", ms]),
			);
			const table = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'eld_activity_daily'").get();
			return { out, calls, timers, table };
		};
		for (const value of ["false", "FALSE", "False", "0", "no", "NO", "off", "Off", " false", "off "]) {
			const b = boot(value);
			eq(`ELD_ACTIVITY_DAILY_ENABLED=${JSON.stringify(value)}: off, no table, no job`, [b.out.ELD_ACTIVITY_DAILY_ENABLED, b.calls.length, b.table, b.timers], [false, 0, false, []]);
		}
		const started = [["job", "ELD activity daily rollup"], ["timeout", 12 * MIN], ["interval", 6 * HOUR]];
		for (const value of ["", " ", "true", "TRUE", "1", "yes", "on", "enabled"]) {
			const b = boot(value);
			eq(`ELD_ACTIVITY_DAILY_ENABLED=${JSON.stringify(value)}: on`, [b.out.ELD_ACTIVITY_DAILY_ENABLED, b.calls.length, b.table, b.timers], [true, 1, true, started]);
		}
		const on = boot(undefined);
		eq("not set: on, the table, the job after 12 minutes and every 6 hours",
			[on.out.ELD_ACTIVITY_DAILY_ENABLED, on.calls.length, on.table, on.timers],
			[true, 1, true, started]);
		const d = on.calls[0];
		eq("...wired to server.js's device and driver resolvers", [d.deviceResolver(), d.driverResolver([1, 2])], ["device resolver", ["driver resolver", [1, 2]]]);
		eq("...its business week (getWeekRange) and the miles rollups' purge boundary", [d.weekStartOf(1234), d.boundaryMs], ["week of 1234", BOUNDARY_MS]);
		eq("...and the directory row's id for a name, 0 for none", [d.driverIdFor("Pat Example"), d.driverIdFor("Nobody Here")], [7, 0]);
		const replica = boot(undefined, false);
		eq("in a replica (no jobs start): the table, no timer", [replica.table, replica.timers], [true, [["job", "ELD activity daily rollup"]]]);
		for (const name of ["buildEldDeviceResolver", "eldDeviceHistoryStartMs", "buildDriverAtResolver", "findDirectoryRowForDriver", "findDriverNameClashes", "getWeekRange"]) {
			const body = liftOnce(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n}\\n`, "g"), name);
			ok(`what server.js hands it only reads: ${name}`, !/\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\s|\.run\(|\bfetch\(|sheets\./.test(body));
		}
	});

	// ---- §4 stored only ----------------------------------------------------------------------
	console.log("§4 stored only");
	await test("nothing reads the table", () => {
		const own = path.join(ROOT, "lib", "eld-activity-daily.js");
		ok("the module itself creates and writes the table", fs.readFileSync(own, "utf8").includes("eld_activity_daily"));
		const files = [];
		const walk = (dir, re) => {
			if (!fs.existsSync(dir)) return;
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name);
				if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "dist") walk(p, re); } else if (re.test(e.name)) files.push(p);
			}
		};
		walk(path.join(ROOT, "lib"), /\.(js|mjs|cjs)$/);
		walk(path.join(ROOT, "routes"), /\.(js|mjs|cjs)$/);
		walk(path.join(ROOT, "client", "src"), /\.(js|mjs|ts|vue)$/);
		const naming = files.filter((f) => f !== own && fs.readFileSync(f, "utf8").includes("eld_activity_daily")).map((f) => path.relative(ROOT, f));
		ok("(fixture) the scan reached lib/ and client/src/", files.length > 100, files.length);
		eq("no other lib/, routes/ or client/src/ file names eld_activity_daily", naming, []);
		ok("server.js does not name the table", !SHIPPED.includes("eld_activity_daily"));
		const uses = [...SHIPPED.matchAll(/\beldActivityRollup\b[^\n]*/g)].map((m) => m[0]);
		ok("server.js uses the rollup only to start it", uses.length === 4 && uses.every((u) => /^eldActivityRollup( = ELD_ACTIVITY_DAILY_ENABLED$| && startsJob\(|\.run\(\); \}, )/.test(u)), uses);
		eq("the module exports no reader", Object.keys(A).sort(), ["BASIS_ESTIMATE", "BASIS_NO_HOURS", "ELD_ACTIVITY_BACKFILL_KEY", "ELD_ACTIVITY_LAST_RUN_KEY",
			"ELD_ACTIVITY_MAX_DAYS", "ELD_ACTIVITY_MIN_DAYS", "ELD_ACTIVITY_RULE", "ELD_ACTIVITY_SCHEMA_SQL", "activityRows", "classifySteps",
			"createEldActivityRollup", "ensureEldActivitySchema"]);
	});
	await test("the replica rules refuse the flag", () => {
		const r = replicaRules.enableRefusal("ELD_ACTIVITY_DAILY_ENABLED");
		ok("replica:start --enable refuses it as a scheduled job", typeof r === "string" && /scheduled job/.test(r), r);
	});

	console.log(`\n${passes} passed, ${failures} failed`);
	process.exitCode = failures ? 1 : 0;
})();
