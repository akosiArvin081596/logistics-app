#!/usr/bin/env node
/**
 * scripts/data-fix-haul-row-remeasure.js on a made-up database and Job Tracking.
 *
 *   §1 the dry run prints the one row, the replay beside it (the load's pings
 *      replayed as the app measures a closed-out load) and its change, and
 *      writes nothing;
 *   §2 the apply sets in_progress 0 -> 1 on that row only, writes one audit row
 *      (a system change carrying the row as it was), and a second run writes
 *      nothing, even once the app has measured the row again (final once more);
 *   §3 refusals, nothing written: a load in a closed month, a load whose months
 *      can't be told, a load on two Job Tracking rows or on none, no
 *      load_eld_miles row, a row already in progress, a row the replay agrees
 *      with (a wrong --load-id never re-opens a correct row), a load with no
 *      ping retained, a load not closed out, a checkout without the
 *      haul-row fix, and the command line's own (no --load-id, no sheet, neither
 *      or both modes, an unknown option, a database outside the app directory
 *      and the temp directory).
 *
 * The closed-month check is the app's own (lifted from this checkout's server.js).
 * Pure: a temp directory, no network. Load ids are made up.
 * Run: node scripts/test-data-fix-haul-row-remeasure.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const geolib = require("geolib");

const ROOT = path.join(__dirname, "..");
const fix = require("./data-fix-haul-row-remeasure");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
function table(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\t\\)`));
	if (!m) throw new Error(`no CREATE TABLE ${name} in server.js`);
	return m[0];
}

const BASE = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "haul-remeasure-"));
const HEADERS = ["Load ID", "Driver", "Pickup Appointment", "Drop-off Appointment", "Job Status", "Assigned Date", "Status Update Date", "Completion Date"];
const sheetRow = (id, month) => [id, "Driver A", `${month}/05/2026 08:00`, `${month}/06/2026 14:00`, "Delivered", `${month}/5/2026, 9:21:43 AM`, `${month}/6/2026 15:00:00`, `${month}/6/2026 15:00:00`];
const VALUES = [
	HEADERS,
	sheetRow("900001", "10"),            // open month: the row to re-open
	sheetRow("900002", "09"),            // closed month
	sheetRow("#900003", "10"),           // on two rows
	sheetRow("900003", "10"),
	sheetRow("900005", "10"),            // no load_eld_miles row
	sheetRow("900006", "10"),            // already in progress
	["900007", "Driver A", "soon", "", "Delivered", "", "", ""], // months can't be told
	sheetRow("900009", "10"),            // its row is right: the replay agrees
	sheetRow("900010", "10"),            // no ping retained for its window
	sheetRow("900011", "10").map((c, i) => (i === 4 ? "In Transit" : c)), // not closed out
];
const NOW = Date.parse("2026-10-15T12:00:00Z");
const VALUES_FILE = path.join(BASE, "job-tracking.json");
fs.writeFileSync(VALUES_FILE, JSON.stringify({ values: VALUES }));

// ── The truck's pings: a self-consistent series (odometer follows the geometry).
// Load 900001's truck ran the same lane for the load before: its shipper visit
// and its arrival at the same receiver are days before 900001 was dispatched.
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const SHIPPER = { lat: 31.0, lng: -94.0 };
const RECEIVER = { lat: 29.5, lng: -98.0 };
const ELSEWHERE = { lat: 31.9, lng: -94.0 };
function trip(startMs) {
	const t = { t: startMs, odo: 400000, rows: [], last: null };
	t.ping = (p, step = MIN) => {
		if (t.last) t.odo += geolib.getDistance({ latitude: t.last.lat, longitude: t.last.lng }, { latitude: p.lat, longitude: p.lng }) / 1609.344;
		t.t += step;
		t.last = { ms: t.t, lat: p.lat, lng: p.lng, odo: Math.round(t.odo * 1000) / 1000 };
		t.rows.push(t.last);
	};
	t.drive = (a, b, steps) => { for (let i = 1; i <= steps; i++) t.ping({ lat: a.lat + (b.lat - a.lat) * (i / steps), lng: a.lng + (b.lng - a.lng) * (i / steps) }); };
	t.dwell = (k, step = MIN) => { for (let i = 0; i < k; i++) t.ping(t.last, step); };
	return t;
}
const run1 = trip(Date.parse("2026-10-01T12:00:00Z"));
run1.ping(SHIPPER);
run1.dwell(60);                                  // the load before: its pickup
const prevDepart = run1.last.ms + MIN;
run1.drive(SHIPPER, RECEIVER, 280);
const prevArrive = run1.rows.find((r) => r.lat === RECEIVER.lat && r.lng === RECEIVER.lng).ms;
run1.dwell(60);
run1.drive(RECEIVER, ELSEWHERE, 300);
run1.dwell(48, HOUR);                            // two days away
const DISPATCH = run1.last.ms + HOUR;
run1.dwell(2, HOUR);
run1.drive(ELSEWHERE, SHIPPER, 60);              // 900001's own haul
run1.dwell(60);
run1.drive(SHIPPER, RECEIVER, 280);
run1.dwell(20);
const DELIVERED = run1.last.ms;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

let n = 0;
function makeDb() {
	const dir = fs.mkdtempSync(path.join(BASE, "db-"));
	const file = path.join(dir, `app-${++n}.db`);
	const db = new Database(file);
	for (const t of ["load_eld_miles", "period_locks", "audit_trail", "load_status_history", "load_coordinates", "routemate_telemetry"]) db.exec(table(t));
	db.exec("ALTER TABLE load_status_history ADD COLUMN reason TEXT DEFAULT ''");
	db.exec("ALTER TABLE load_coordinates ADD COLUMN distance_miles REAL");
	db.exec("ALTER TABLE routemate_telemetry ADD COLUMN dropped_reason TEXT DEFAULT ''");
	db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-09', 'locked', '2026-10-08T00:00:00Z')").run();

	const ping = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, odometer, location_date_ms) VALUES (?, ?, ?, ?, ?)");
	const coords = db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng) VALUES (?, ?, ?, ?, ?)");
	const status = db.prepare("INSERT INTO load_status_history (load_id, new_status, source, changed_at) VALUES (?, ?, 'manual', ?)");
	const closedOut = (id, vid) => {
		coords.run(id, SHIPPER.lat, SHIPPER.lng, RECEIVER.lat, RECEIVER.lng);
		status.run(id, "Dispatched", sqlTime(DISPATCH));
		status.run(id, "Delivered", sqlTime(DELIVERED));
		if (vid) for (const r of run1.rows) ping.run(vid, r.lat, r.lng, r.odo, r.ms);
	};
	closedOut("900001", "V1");   // its row holds the load before's haul
	closedOut("900009", "V9");   // its row is what the replay measures
	closedOut("900010", "");     // no ping retained
	coords.run("900011", SHIPPER.lat, SHIPPER.lng, RECEIVER.lat, RECEIVER.lng);
	status.run("900011", "Dispatched", sqlTime(DISPATCH)); // still running

	const row = db.prepare(`INSERT INTO load_eld_miles (load_id, routemate_vehicle_id, truck_id, loaded_miles, basis, loaded_basis, reason,
		samples, pickup_depart_ms, dest_arrive_ms, in_progress, computed_at)
		VALUES (?, ?, 1, ?, 'partial', 'eld', ?, 255, ?, ?, ?, '2026-10-08 20:52:26')`);
	row.run("900001", "V1", 169, "", prevDepart, prevArrive, 0);
	row.run("900002", "V1", 210, "", 0, 0, 0);
	row.run("900003", "V1", 150, "", 0, 0, 0);
	row.run("900006", "V1", 120, "", 0, 0, 1);
	row.run("900007", "V1", 99, "", 0, 0, 0);
	row.run("900008", "V1", 77, "", 0, 0, 0);   // another final row, never touched
	row.run("900010", "V10", 88, "", 0, 0, 0);
	row.run("900011", "V1", 66, "", 0, 0, 0);
	// 900009's row: exactly what the app's replay measures.
	const checks = fix.liftChecks(ROOT, db, require("../lib/load-haul"), {});
	const hdr = VALUES[0];
	const cells = VALUES.find((r) => r[0] === "900009");
	const good = fix.replay({ checks, key: "900009", rowObj: Object.fromEntries(hdr.map((h, i) => [h, cells[i]])), headers: hdr, vid: "V9", nowMs: NOW }).computed;
	row.run("900009", "V9", good.loadedMiles, good.reason, good.pickupDepartMs || 0, good.destArriveMs || 0, 0);
	db.close();
	return file;
}
const snapshot = (file) => {
	const db = new Database(file, { readonly: true });
	const out = { rows: db.prepare("SELECT * FROM load_eld_miles ORDER BY load_id").all(), audit: db.prepare("SELECT * FROM audit_trail ORDER BY id").all() };
	db.close();
	return out;
};
async function run(argv, opts = {}) {
	const lines = [];
	try {
		const code = await fix.main(argv, { root: ROOT, nowMs: NOW, log: (s) => lines.push(s), ...opts });
		return { code, out: lines.join("\n") };
	} catch (err) {
		return { code: err instanceof fix.Refusal ? 2 : 1, out: lines.join("\n"), err: err.message };
	}
}
const args = (file, load, mode) => [`--db=${file}`, `--values-json=${VALUES_FILE}`, `--load-id=${load}`, mode];

(async () => {
	// §1 dry run
	{
		const file = makeDb();
		const before = snapshot(file);
		const r = await run(args(file, "900001", "--dry-run"));
		check("§1.1 the dry run succeeds", r.code === 0, r.err || r.out);
		check("§1.2 ...names the one row and its change", /One row matches/.test(r.out) && /in_progress 0 -> 1/.test(r.out) && /loaded_miles: 169/.test(r.out), r.out);
		const replayed = /loaded miles:\s+stored 169\s+replay ([\d.]+)/.exec(r.out);
		check("§1.4 ...and the replay beside it: the load's own haul, not the 169 stored", !!replayed && Number(replayed[1]) > 250, r.out);
		check("§1.5 ...with the receiver arrival the replay found after dispatch",
			/receiver arrival:\s+stored \S+\s+replay (\S+)/.test(r.out) && Date.parse(/receiver arrival:\s+stored \S+\s+replay (\S+)/.exec(r.out)[1]) > DISPATCH, r.out);
		check("§1.3 ...and writes nothing", JSON.stringify(snapshot(file)) === JSON.stringify(before));
	}

	// §2 apply, then again
	{
		const file = makeDb();
		const before = snapshot(file);
		const r = await run(args(file, "900001", "--apply"));
		check("§2.1 the apply succeeds", r.code === 0, r.err || r.out);
		const after = snapshot(file);
		const changed = after.rows.filter((row, i) => JSON.stringify(row) !== JSON.stringify(before.rows[i]));
		check("§2.2 exactly one row changed", changed.length === 1 && changed[0].load_id === "900001", JSON.stringify(changed));
		check("§2.3 ...only its in_progress", JSON.stringify({ ...changed[0], in_progress: 0 }) === JSON.stringify(before.rows.find((x) => x.load_id === "900001")) && changed[0].in_progress === 1);
		check("§2.4 one audit row, a system change carrying the row as it was",
			after.audit.length === 1 && after.audit[0].user_id === 0 && after.audit[0].role === "system" && after.audit[0].username === fix.ACTOR
			&& after.audit[0].entity === "load_eld_miles" && after.audit[0].entity_id === "900001"
			&& after.audit[0].details.includes(`[${fix.REF}]`) && after.audit[0].details.includes('"loaded_miles":169'), JSON.stringify(after.audit));

		const again = await run(args(file, "900001", "--apply"));
		check("§2.5 a second apply writes nothing", again.code === 0 && JSON.stringify(snapshot(file)) === JSON.stringify(after), again.err || again.out);

		// The app measures the load again: its row is final once more.
		const db = new Database(file);
		db.prepare("UPDATE load_eld_miles SET loaded_miles = 225, in_progress = 0 WHERE load_id = '900001'").run();
		db.close();
		const measured = snapshot(file);
		const third = await run(args(file, "900001", "--apply"));
		check("§2.6 ...nor once the app has measured it again", third.code === 0 && /already/.test(third.out) && JSON.stringify(snapshot(file)) === JSON.stringify(measured), third.err || third.out);
	}

	// §3 refusals
	const refused = async (label, argv, opts, re) => {
		const file = argv.file || makeDb();
		const before = snapshot(file);
		const r = await run(argv.list(file), opts);
		check(`${label}: refused`, r.code === 2 && (!re || re.test(r.err || "")), `${r.code} ${r.err || r.out}`);
		check(`${label}: nothing written`, JSON.stringify(snapshot(file)) === JSON.stringify(before));
	};
	const on = (load, mode = "--apply") => ({ list: (f) => args(f, load, mode) });
	await refused("§3.1 a load in a closed month", on("900002"), {}, /closed month \(2026-09\)/);
	await refused("§3.2 ...also in a dry run", on("900002", "--dry-run"), {}, /closed month/);
	await refused("§3.3 a load whose months can't be told", on("900007"), {}, /can't be told/);
	await refused("§3.4 a load on two rows", on("900003"), {}, /2 Job Tracking rows/);
	await refused("§3.5 a load on no row", on("900008"), {}, /0 Job Tracking rows/);
	await refused("§3.6 no load_eld_miles row", on("900005"), {}, /no load_eld_miles row/);
	await refused("§3.7 a row already in progress", on("900006"), {}, /not final/);
	await refused("§3.8 a checkout without the haul-row fix", on("900001"), { loadHaul: {} }, /haul-row fix/);
	await refused("§3.15 a row the replay agrees with (a wrong --load-id)", on("900009"), {}, /what the replay measures/);
	await refused("§3.16 ...also in a dry run", on("900009", "--dry-run"), {}, /what the replay measures/);
	await refused("§3.17 a load with no ping retained for its window", on("900010"), {}, /no ping/);
	await refused("§3.18 a load not closed out", on("900011"), {}, /not closed out/);
	await refused("§3.9 no --load-id", { list: (f) => [`--db=${f}`, `--values-json=${VALUES_FILE}`, "--apply"] }, {}, /--load-id/);
	await refused("§3.10 no sheet", { list: (f) => [`--db=${f}`, "--load-id=900001", "--apply"] }, {}, /--sheet-id/);
	await refused("§3.11 neither mode", { list: (f) => [`--db=${f}`, `--values-json=${VALUES_FILE}`, "--load-id=900001"] }, {}, /--dry-run or --apply/);
	await refused("§3.12 both modes", { list: (f) => [...args(f, "900001", "--apply"), "--dry-run"] }, {}, /--dry-run or --apply/);
	await refused("§3.13 an unknown option", { list: (f) => [...args(f, "900001", "--apply"), "--force"] }, {}, /unknown option/);
	const outside = path.join(ROOT, "scripts", "lib");
	const r = await run([`--db=${path.join(outside, "nowhere.db")}`, `--values-json=${VALUES_FILE}`, "--load-id=900001", "--apply"]);
	check("§3.14 a database outside the app directory and the temp directory is refused", r.code === 2 && /refusing/.test(r.err || ""), `${r.code} ${r.err}`);

	fs.rmSync(BASE, { recursive: true, force: true });
	console.log(`\n${passes} passed, ${failures} failed`);
	process.exit(failures ? 1 : 0);
})().catch((err) => {
	console.error("crashed:", err);
	process.exit(1);
});
