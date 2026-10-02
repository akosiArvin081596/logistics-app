#!/usr/bin/env node
// Every statement that writes load_coordinates must keep distance_miles.
//
// WHY THIS EXISTS. distance_miles (road miles for the lane) was empty on all 385
// production rows. The boot sync rewrote every sheet load's row with
// `INSERT OR REPLACE ... (load_id, origin_lat, ..., dropoff_address)`. REPLACE
// deletes the old row and inserts a new one, so a column the statement does not
// name (distance_miles, created_at) went back to its default on every pm2
// restart. POST /api/data, from-ratecon, the geofence's on-demand geocode and
// GET /api/geocode/load used the same statement, so any of them wiped it too.
//
// The rule pinned here:
//   • same lane (origin and destination unchanged) → distance_miles and
//     created_at survive the write;
//   • lane moved → distance_miles is cleared, because it measured the old lane.
//
// Each write statement is lifted out of server.js text and run against a real
// in-memory table built from server.js's own DDL, so a new writer that bypasses
// the shared statement is caught here.
//
// No network, no sheet, no app.db, no server.
//
//   node scripts/test-load-coordinates-keep-distance.js      # exits 1 on any failure

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

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

// The table exactly as server.js builds it: CREATE TABLE plus the ALTER that
// added distance_miles later.
const ddl = SHIPPED.match(/CREATE TABLE IF NOT EXISTS load_coordinates \([\s\S]*?\n\t\)/);
const alter = SHIPPED.match(/ALTER TABLE load_coordinates ADD COLUMN distance_miles REAL/);
check("server.js still defines load_coordinates", !!ddl, true);
check("server.js still adds distance_miles", !!alter, true);
if (!ddl || !alter) {
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(1);
}

// Every SQL literal that inserts into load_coordinates. Statements here never
// contain a quote or a backtick, so the literal ends at the next one.
const writers = [...SHIPPED.matchAll(/[`"]((?:INSERT|REPLACE)[^`"]*?INTO\s+load_coordinates\b[^`"]*)[`"]/g)]
	.map((m) => m[1]);

check("no INSERT OR REPLACE into load_coordinates remains",
	writers.filter((sql) => /INSERT\s+OR\s+REPLACE/i.test(sql)).length, 0);
check("every writer goes through one shared statement", writers.length, 1);

const LANE = ["513987502", 29.7604, -95.3698, 32.7767, -96.797, "Houston, TX", "Dallas, TX"];
const MOVED = ["513987502", 29.7604, -95.3698, 35.4676, -97.5164, "Houston, TX", "Oklahoma City, OK"];

writers.forEach((sql, i) => {
	const label = `writer ${i + 1}`;
	const db = new Database(":memory:");
	db.exec(ddl[0]);
	db.exec(alter[0]);
	db.prepare(
		`INSERT INTO load_coordinates
		 (load_id, origin_lat, origin_lng, dest_lat, dest_lng, pickup_address, dropoff_address, distance_miles, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 239.4, '2026-06-01 12:00:00')`
	).run(...LANE);
	const read = () => db.prepare(
		"SELECT distance_miles AS d, created_at AS c, dest_lat AS lat, dropoff_address AS addr FROM load_coordinates WHERE load_id = ?"
	).get(LANE[0]);

	// The boot sync's exact situation: same load, same geocoded lane.
	db.prepare(sql).run(...LANE);
	check(`${label}: same lane keeps distance_miles`, read().d, 239.4);
	check(`${label}: same lane keeps created_at`, read().c, "2026-06-01 12:00:00");

	// An address change on the sheet re-geocodes the drop-off.
	db.prepare(sql).run(...MOVED);
	check(`${label}: moved lane clears distance_miles`, read().d, null);
	check(`${label}: moved lane stores the new drop-off`, [read().lat, read().addr], [35.4676, "Oklahoma City, OK"]);

	// A brand-new load still inserts a fresh row.
	db.prepare(sql).run("600000001", 1, 2, 3, 4, "a", "b");
	check(`${label}: new load inserts`,
		db.prepare("SELECT COUNT(*) AS n FROM load_coordinates").get().n, 2);
	db.close();
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
