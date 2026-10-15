#!/usr/bin/env node
// measureLoadEldMiles() (server.js): a closed-out load's figure replaces the
// row its haul modal wrote while the load was still running.
//
// WHY THIS EXISTS. load_eld_miles rows written mid-haul stayed "in progress"
// for weeks after delivery (2026-10-15 haul-rows report), in two ways:
//   • the final figure had fewer samples than the mid-haul row, and the upsert's
//     "never lower the sample count" guard refused it without a word;
//   • the final replay found no measurable leg (0 samples), and the function
//     handed back the stale mid-haul row instead, as if the pings were purged.
// And a row written mid-haul that happened to look final (truck still at the
// shipper) was stored as final, so the delivered load was never measured.
//
// This suite pins, on a real in-memory SQLite table built from server.js's own
// CREATE TABLE and upsert:
//   • a closed-out load's result replaces an in-progress row, whatever its
//     sample count, and an unmeasurable one becomes a final no-data row;
//   • a row written before the load closed out is always in progress;
//   • the close-out instant reaches the replay, so the truck's next visit to the
//     same shipper is not this load's departure;
//   • unchanged: a final row is never recomputed, a live load's row never loses
//     samples, and a load with no row and nothing measured writes nothing.
//
// measureLoadEldMiles(), haulDrivenFromRow(), haulDrivenEmpty(), the table and
// the upsert are lifted verbatim (SERVER_JS=<path> runs another copy of
// server.js). The window, truck and ping reads are stubbed; the replay is the
// real lib/load-haul.js. Fixture data is made up.
//
// No network, no sheet, no server.
//
//   node scripts/test-load-eld-miles-final.js      # exits 1 on any failure

const fs = require("fs");
const path = require("path");
const geolib = require("geolib");
const Database = require("better-sqlite3");
const loadHaul = require("../lib/load-haul");

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
function near(label, actual, expected, tol) {
	if (actual !== null && actual !== undefined && Math.abs(actual - expected) <= tol) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n        expected ${expected} +/- ${tol}\n        actual   ${actual}`);
}
function lift(re, label) {
	const all = [...SHIPPED.matchAll(re)];
	if (all.length !== 1) throw new Error(`${label}: expected exactly one match, found ${all.length}`);
	return all[0][0];
}

const createSql = lift(/CREATE TABLE IF NOT EXISTS load_eld_miles \([\s\S]*?\n\t\)/g, "load_eld_miles table");
const lifted = [
	lift(/\nconst normLoadKey = [^\n]*\n/g, "normLoadKey"),
	lift(/\nfunction findCol\([\s\S]*?\n}\n/g, "findCol"),
	lift(/\nconst HAUL_LOOKBACK_MS = [^\n]*\n/g, "lookback"),
	lift(/\nconst HAUL_LOOKAHEAD_MS = [^\n]*\n/g, "lookahead"),
	lift(/\nconst loadEldMilesGetStmt = [^\n]*\n/g, "get statement"),
	lift(/\nconst loadEldMilesUpsertStmt = db\.prepare\(`[\s\S]*?`\);\n/g, "upsert statement"),
	lift(/\nfunction haulDrivenFromRow\([\s\S]*?\n}\n/g, "haulDrivenFromRow"),
	lift(/\nfunction haulDrivenEmpty\([\s\S]*?\n}\n/g, "haulDrivenEmpty"),
	lift(/\nfunction measureLoadEldMiles\([\s\S]*?\n}\n/g, "measureLoadEldMiles"),
].join("");

// ---------------------------------------------------------------------------
// Fixture: a self-consistent ping series (odometer follows the geometry).
// ---------------------------------------------------------------------------
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const M_PER_MI = 1609.344;
const SHIPPER = { lat: 31.0, lng: -94.0 };
const RECEIVER = { lat: 29.5, lng: -98.0 };
const ELSEWHERE = { lat: 31.9, lng: -94.0 };
const LANE_LOADED = geolib.getDistance(
	{ latitude: SHIPPER.lat, longitude: SHIPPER.lng }, { latitude: RECEIVER.lat, longitude: RECEIVER.lng },
) / M_PER_MI - 2 * (3218.69 / M_PER_MI);

function makeTrip(startMs) { return { t: startMs, odo: 400000, rows: [], last: null }; }
function ping(trip, p, stepMs = MIN) {
	if (trip.last) {
		trip.odo += geolib.getDistance({ latitude: trip.last.lat, longitude: trip.last.lng }, { latitude: p.lat, longitude: p.lng }) / M_PER_MI;
	}
	trip.t += stepMs;
	trip.last = { ms: trip.t, lat: p.lat, lng: p.lng, odo: Math.round(trip.odo * 1000) / 1000 };
	trip.rows.push(trip.last);
}
function drive(trip, a, b, steps) {
	for (let i = 1; i <= steps; i++) ping(trip, { lat: a.lat + (b.lat - a.lat) * (i / steps), lng: a.lng + (b.lng - a.lng) * (i / steps) });
}
function dwell(trip, n, stepMs = MIN) { for (let i = 0; i < n; i++) ping(trip, trip.last, stepMs); }

// A clean haul: in from elsewhere, an hour at the shipper, out to the receiver.
const T0 = Date.parse("2026-09-20T12:00:00Z");
function cleanHaul() {
	const trip = makeTrip(T0);
	ping(trip, ELSEWHERE);
	drive(trip, ELSEWHERE, SHIPPER, 60);
	dwell(trip, 60);
	drive(trip, SHIPPER, RECEIVER, 280);
	dwell(trip, 20);
	return trip;
}

// ---------------------------------------------------------------------------
// The world: a real table, the lifted code, stubbed reads.
// ---------------------------------------------------------------------------
function world() {
	const db = new Database(":memory:");
	db.exec(createSql);
	const state = { win: null, samples: [] };
	const logs = [];
	const deps = {
		db,
		loadHaul,
		LOAD_HAUL_ELD_ENABLED: true,
		HAUL_REPLAY_RADIUS_M: 3218.69,
		haulLoadWindow: () => state.win,
		haulResolveTruck: () => ({ truck_id: 7, unit: "T-7", vid: "V7" }),
		haulSamplesStmt: { all: (vid, from, to) => state.samples.filter((s) => s.ms >= from && s.ms <= to) },
		haulSameTruckSpans: () => [],
		console: { log: (s) => logs.push(String(s)), error: (s, e) => logs.push(`ERR ${s} ${e || ""}`) },
	};
	const names = Object.keys(deps);
	const measure = new Function(...names, `${lifted}\nreturn measureLoadEldMiles;`)(...names.map((n) => deps[n]));
	const ctx = {
		coords: { origin_lat: SHIPPER.lat, origin_lng: SHIPPER.lng, dest_lat: RECEIVER.lat, dest_lng: RECEIVER.lng },
		jt: { headers: ["Load ID", "Driver"], data: [{ "Load ID": "L-1", Driver: "Driver A" }] },
		truckResolver: { forDriverAt: () => null },
		deviceResolver: { vehicleForTruckAt: () => "V7" },
	};
	return {
		db,
		logs,
		run(win, samples, nowMs) {
			state.win = win;
			state.samples = samples;
			return measure("L-1", { ...ctx, nowMs: nowMs || win.endMs });
		},
		row: () => db.prepare("SELECT * FROM load_eld_miles WHERE load_id = 'l-1'").get() || null,
		// A row as the modal left it mid-haul: a long false loaded leg.
		seedInProgress(samples = 5000) {
			db.prepare(`INSERT INTO load_eld_miles (load_id, routemate_vehicle_id, truck_id, loaded_miles, deadhead_miles,
				total_miles, basis, loaded_basis, reason, samples, in_progress)
				VALUES ('l-1', 'V7', 7, 1934, NULL, NULL, 'eld', 'eld', '', ?, 1)`).run(samples);
		},
	};
}

const haul = cleanHaul();
const lastMs = haul.last.ms;
const closed = { dispatchMs: T0 - 5 * MIN, terminal: true, endMs: lastMs };

// 1. A final figure with fewer samples than the mid-haul row replaces it.
{
	const w = world();
	w.seedInProgress(5000);
	const { driven } = w.run(closed, haul.rows);
	const r = w.row();
	check("1.1 the final result replaces the in-progress row", r.in_progress, 0);
	near("1.2 ...with the delivered haul's loaded miles", r.loaded_miles, LANE_LOADED, 3);
	check("1.3 ...and its own sample count", r.samples, driven.samples);
	check("1.4 the response is the final figure", driven.inProgress, false);
	check("1.5 nothing went wrong", w.logs.filter((l) => l.startsWith("ERR")), []);
}

// 2. A closed-out replay that measures nothing: a final no-data row, not the
//    stale one.
{
	const w = world();
	w.seedInProgress(5000);
	const nowhere = makeTrip(T0);
	ping(nowhere, ELSEWHERE);
	dwell(nowhere, 50);
	const { driven } = w.run(closed, nowhere.rows);
	const r = w.row();
	check("2.1 the stale row is not handed back", [driven.stored, driven.inProgress, driven.loadedMiles], [false, false, null]);
	check("2.2 ...the response says why", driven.reason, "no_pickup_zone");
	check("2.3 the row becomes a final no-data row",
		[r.in_progress, r.loaded_miles, r.deadhead_miles, r.total_miles, r.basis, r.reason, r.samples],
		[0, null, null, null, "no-data", "no_pickup_zone", 0]);
}

// 3. A row written while the load was running is in progress, even when the
//    truck is still at the shipper; the delivered load is then measured.
{
	const w = world();
	const atDock = haul.rows.filter((s) => s.ms <= T0 + 100 * MIN);
	const running = { dispatchMs: T0 - 5 * MIN, terminal: false, endMs: T0 + 100 * MIN };
	const first = w.run(running, atDock).driven;
	check("3.1 the live replay has not departed yet", first.reason, "no_departure");
	check("3.2 ...and its row is in progress", w.row().in_progress, 1);
	w.run(closed, haul.rows);
	const r = w.row();
	check("3.3 once delivered the load is measured", [r.in_progress, r.reason], [0, ""]);
	near("3.4 ...with the delivered haul's loaded miles", r.loaded_miles, LANE_LOADED, 3);
}

// 4. The close-out instant reaches the replay: the truck back at the same
//    shipper for its next load, inside the 24-hour lookahead.
{
	const w = world();
	const back = cleanHaul();
	const deliveredMs = back.last.ms;
	drive(back, RECEIVER, SHIPPER, 280);
	dwell(back, 30);
	const { driven } = w.run({ dispatchMs: T0 - 5 * MIN, terminal: true, endMs: deliveredMs }, back.rows, back.last.ms);
	check("4.1 the next load's visit is not this load's departure", driven.reason, "");
	near("4.2 ...the delivered haul is measured", driven.loadedMiles, LANE_LOADED, 3);
}

// 5. Unchanged rules.
{
	const w = world();
	w.run(closed, haul.rows);
	const before = w.row();
	const again = w.run(closed, []).driven;
	check("5.1 a final row is never recomputed", [again.stored, again.loadedMiles], [true, before.loaded_miles]);

	const live = world();
	live.seedInProgress(5000);
	const running = { dispatchMs: T0 - 5 * MIN, terminal: false, endMs: T0 + 200 * MIN };
	const fresh = live.run(running, haul.rows.filter((s) => s.ms <= T0 + 200 * MIN)).driven;
	check("5.2 a live load's row never loses samples", [live.row().samples, live.row().loaded_miles], [5000, 1934]);
	check("5.3 ...while the response is the fresh figure", [fresh.inProgress, fresh.stored], [true, false]);

	const none = world();
	none.run(closed, []);
	check("5.4 no row and nothing measured writes nothing", none.row(), null);
}

// 6. A live load whose stored row measures nothing now: the stale row is not
//    shown as the current figure.
{
	const w = world();
	w.seedInProgress(5000);
	const { driven } = w.run({ dispatchMs: T0 - 5 * MIN, terminal: false, endMs: T0 + 50 * MIN }, []);
	check("6.1 a live load is not shown its stale row", [driven.stored, driven.loadedMiles, driven.reason], [false, null, "no_samples"]);
	check("6.2 ...which stays as it was", w.row().samples, 5000);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
