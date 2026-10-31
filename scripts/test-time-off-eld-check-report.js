#!/usr/bin/env node
// scripts/time-off-eld-check-report.js, run as a child on a made-up database
// file (every table from server.js's own DDL) as of 2026-10-15 12:00 EDT:
// drivers Hollis Renner (T1, device vid-t1, his own Driver account), Soren King
// (T2, no device) and Tamsin Vale (no truck); T3 (device vid-t3) with two
// engine-hours breaks, one in a closed September.
//   §1 refusals: no --db, a missing file, --days outside 1-90, a bad --now
//   §2 counts only: the live rows, what the first run would write and its
//      notices, the device scan (breaks, closed-month ones, engine-hours
//      advances), the unlinked drivers, the fingerprint; no initials
//   §3 --shadow: per-verdict counts, "Confirmed (no ELD data)" on its own line,
//      the S2 measures (0 mi odometer stretches, return days, the 1 h engine
//      rule's share), S4 and S4b with the loads read from a saved values.get,
//      and "not checked" without it
//   §4 --names: initials and units only, never a full name
//   §5 read-only: the database file's bytes and its folder unchanged
//   §6 the lift reaches no writer: the run's write, the purge, the audit and
//      the notices are denied
// Run: node scripts/test-time-off-eld-check-report.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const appTime = require("../lib/app-time");

let passed = 0;
const failures = [];
const ok = (name, cond, detail) => {
	if (cond) { passed++; return true; }
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
	console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	return false;
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const section = (t) => console.log(`\n── ${t}`);

const REPORT = path.join(__dirname, "time-off-eld-check-report.js");
if (!fs.existsSync(REPORT)) {
	console.log("  FAIL  scripts/time-off-eld-check-report.js exists");
	console.log("\ntest-time-off-eld-check-report: 0 passed, 1 failed");
	process.exit(1);
}
const WD = require("./lib/work-days-world");
const { HEADERS, jtRow } = require("./lib/availability-world");

const NOW = "2026-10-15T16:00:00Z";
const MIN = 60 * 1000;
const at = (day, hh = 0, mm = 0, zone = "America/Chicago") => {
	const [y, m, d] = day.split("-").map(Number);
	return appTime.wallClockToMs(zone, y, m, d, hh, mm, 0);
};
const YARD = { lat: 29.7, lng: -95.4 };
const north = (m) => YARD.lat + m / 111195;

function seed(db) {
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (?, ?, 'x', ?, ?)");
	user.run(1, "super_admin", "Super Admin", "");
	user.run(10, "drv_hollis", "Driver", "Hollis Renner");
	const dir = db.prepare("INSERT INTO drivers_directory (id, driver_name, carrier_name, status, pay_daily) VALUES (?, ?, 'Acme Carrier', 'active', 300)");
	dir.run(1, "Hollis Renner");
	dir.run(2, "Soren King");
	dir.run(3, "Tamsin Vale");
	const truck = db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, assigned_driver, routemate_vehicle_id)
		VALUES (?, ?, 5, 'Active', '2026-08-01', '2026-08-01 00:00:00', ?, ?)`);
	truck.run(21, "T1", "Hollis Renner", "vid-t1");
	truck.run(22, "T2", "Soren King", "");
	truck.run(23, "T3", "", "vid-t3");
	const assign = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (?, ?, '2026-08-01T12:00:00.000Z')");
	assign.run(21, "Hollis Renner");
	assign.run(22, "Soren King");
	const tel = db.prepare(`INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, odometer, engine_hours, location_date_ms, dropped_reason, source)
		VALUES (?, ?, ?, ?, ?, ?, ?, '', 'routemate')`);
	const pings = (vid, fromMs, toMs, o) => { for (let ms = fromMs; ms <= toMs; ms += 30 * MIN) tel.run(vid, o.lat ?? YARD.lat, YARD.lng, o.speed ?? 0, 100000, o.eh, ms); };
	// T1: parked to Oct 8 18:00; dark until Oct 11 07:00, back 1.2 km on and moving
	// (0 mi odometer step); parked; dark Oct 12 20:00 - Oct 13 06:00 with the
	// engine 1.5 h on; parked to the run.
	pings("vid-t1", at("2026-10-01"), at("2026-10-08", 18), { eh: 5000 });
	tel.run("vid-t1", north(1200), YARD.lng, 12, 100000, 5000.2, at("2026-10-11", 7));
	pings("vid-t1", at("2026-10-11", 7, 30), at("2026-10-12", 20), { lat: north(1200), eh: 5000.2 });
	pings("vid-t1", at("2026-10-13", 6), at("2026-10-15", 10, 30), { lat: north(1200), eh: 5001.7 });
	// T3: engine hours 1,000 -> 20,000 in a normal step on Sep 20 (a closed month),
	// then down to 900 on Oct 2.
	pings("vid-t3", at("2026-09-20", 6), at("2026-09-20", 8), { eh: 1000 });
	pings("vid-t3", at("2026-09-20", 8, 30), at("2026-09-20", 10), { eh: 20000 });
	pings("vid-t3", at("2026-10-02", 6), at("2026-10-02", 6), { eh: 20000 });
	pings("vid-t3", at("2026-10-02", 6, 30), at("2026-10-02", 9), { eh: 900 });
	db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-09', 'locked', '2026-10-08T05:00:00.000Z')").run();
	const off = db.prepare("INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, reason, created_by, created_at, cancelled_at) VALUES (?, ?, 'vacation', ?, ?, 'Family', 'super_admin', '2026-10-01T12:00:00Z', ?)");
	off.run(1, "Hollis Renner", "2026-10-05", "2026-10-07", null);
	off.run(1, "Hollis Renner", "2026-10-20", "2026-10-21", "2026-10-02T12:00:00Z");
	// His own status update on Oct 6, 3:12 PM Eastern.
	db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 10, 'drv_hollis', 'Driver', 'update_status', 'load', '7001', 'Status changed')")
		.run(new Date(at("2026-10-06", 15, 12, "America/New_York")).toISOString());
	db.prepare("INSERT INTO excluded_driver_days (driver_name, excluded_date) VALUES ('Hollis Renner', '2026-09-03')").run();
	db.prepare("INSERT INTO invoice_paid_days (driver_norm, day, invoice_id) VALUES ('hollis renner', '2026-09-01', 1), ('hollis renner', '2026-09-02', 1)").run();
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "time-off-eld-report-"));
const DB_FILE = path.join(tmp, "app.db");
const VALUES = path.join(tmp, "job-tracking.json");
const schema = WD.schemaDb();
seed(schema);
fs.writeFileSync(DB_FILE, schema.serialize());
schema.close();
fs.writeFileSync(VALUES, JSON.stringify({ range: "'Job Tracking'!A1:Z2", majorDimension: "ROWS", values: [HEADERS,
	jtRow({ id: "7001", driver: "Hollis Renner", pickup: "10/6/2026 08:00", dropoff: "10/6/2026 17:00", status: "Delivered", truck: "T1", owner: "5" })] }));
const sha = () => crypto.createHash("sha256").update(fs.readFileSync(DB_FILE)).digest("hex");
const filesBefore = fs.readdirSync(tmp).sort();
const shaBefore = sha();

const run = (args) => {
	const r = spawnSync(process.execPath, [REPORT, ...args], { encoding: "utf8", timeout: 120000, env: { ...process.env, APP_TIMEZONE: "America/New_York" } });
	let json = null;
	try { json = JSON.parse(r.stdout); } catch { json = null; }
	return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", json };
};

section("§1 refusals");
{
	eq("§1.1 no --db: exit 2", run([]).status, 2);
	eq("§1.2 a missing database file: exit 2", run([`--db=${path.join(tmp, "nope.db")}`]).status, 2);
	eq("§1.3 --days 0 and 91: exit 2", [run([`--db=${DB_FILE}`, "--days=0"]).status, run([`--db=${DB_FILE}`, "--days=91"]).status], [2, 2]);
	eq("§1.4 a --now with no zone: exit 2", run([`--db=${DB_FILE}`, "--now=2026-10-15T16:00"]).status, 2);
}

section("§2 counts only");
{
	const r = run([`--db=${DB_FILE}`, `--now=${NOW}`, "--json"]);
	eq("§2.0 exit 0", [r.status, r.stderr.slice(0, 300)], [0, ""]);
	const j = r.json || {};
	eq("§2.1 the live rows (the cancelled one left out) and their days", j.liveRows, { rows: 1, bySource: { staff: 1 }, daysToCheck: 3, futureDays: 0 });
	eq("§2.2 the first run would write Oct 5 and 7 Confirmed and Oct 6 Not confirmed (his own update), with one notice",
		[j.firstRun && j.firstRun.byVerdict, j.firstRun && j.firstRun.notices, j.firstRun && j.firstRun.noticeLines], [{ "confirmed:parked": 2, "not_confirmed:app_activity": 1 }, 1, 1]);
	eq("§2.3 the device scan: T1 and T3; T3's two breaks, one in closed September; T1's engine run across its dark night",
		j.devices, { devices: 2, devicesWithBreaks: 1, breaks: { engine_hours: 2 }, breaksInClosedMonths: 1, devicesWithEngineRan: 1, engineRanStretches: 1 });
	eq("§2.4 one driver's current truck has no ELD link", j.unlinked, { drivers: 1 });
	eq("§2.5 the fingerprint", j.fingerprint, { invoices: 0, excluded_driver_days: 1, invoice_paid_days: 2 });
	eq("§2.6 no shadow without --shadow, no per-row lines without --names", [j.shadow, j.perRow], [null, []]);
	ok("§2.7 no name and no initials in the output", !/Hollis|Renner|Soren|King|Tamsin|Vale|H\.R\.|S\.K\./.test(r.stdout));
	const text = run([`--db=${DB_FILE}`, `--now=${NOW}`]);
	ok("§2.8 the text report has its seven parts", [1, 2, 3, 4, 5, 6, 7].every((n) => text.stdout.includes(`\n${n}. `) || text.stdout.startsWith(`${n}. `)) && text.status === 0, text.stdout.slice(0, 400));
}

section("§3 the shadow (S2, S4, S4b)");
{
	const r = run([`--db=${DB_FILE}`, `--now=${NOW}`, "--json", "--shadow", "--days=14", `--values-json=${VALUES}`]);
	eq("§3.0 exit 0", [r.status, r.stderr.slice(0, 300)], [0, ""]);
	const s = (r.json && r.json.shadow) || {};
	eq("§3.1 Oct 1-14: Hollis and Soren held a truck, Tamsin none; 28 driver-days", [s.from, s.to, s.drivers, s.driversWithNoTruck, s.driverDays], ["2026-10-01", "2026-10-14", 2, 1, 28]);
	eq("§3.2 by verdict, \"Confirmed (no ELD data)\" counted apart", s.byVerdict, {
		"confirmed:parked": 9, "not_confirmed:app_activity": 1, "confirmed:dark_parked": 2, "no_data:engine_ran_while_dark": 2, "confirmed_no_eld_data:no_device": 14,
	});
	eq("§3.3 S2: dark stretches with a 0 mi odometer step (1.2 km, 0 km), one ending moving, the 1 h engine rule's days and share", s.s2,
		{ zeroOdometerStretches: { count: 2, medianKm: 1.2, p90Km: 1.2, maxKm: 1.2, over1Km: 1, overFloor: 0 }, returnStretches: { count: 1, medianKm: 1.2, p90Km: 1.2, maxKm: 1.2, over1Km: 1, overFloor: 0 }, engineRanDays: 2, engineRanShare: 0.071 });
	eq("§3.4 S4: his 11 no-load days with fixes, none Not confirmed", s.s4, { noLoadDaysWithFixes: 11, notConfirmed: 0 });
	eq("§3.5 S4b: no-load dark-spell days, Confirmed (no ELD data) counted apart", s.s4b,
		{ noLoadDarkDays: 16, closedMonthLeftOut: 0, confirmed: 2, confirmedNoEldData: 14, notConfirmed: 0, requested: 0, checking: 0, notConfirmedShare: 0 });
	eq("§3.6 with the loads read, the first run explains Oct 6 by his load", r.json && r.json.firstRun.byVerdict, { "confirmed:parked": 2, "not_confirmed:app_activity": 1 });
	const none = run([`--db=${DB_FILE}`, `--now=${NOW}`, "--json", "--shadow", "--days=14"]);
	const n = (none.json && none.json.shadow) || {};
	eq("§3.7 without a saved Job Tracking: the loads are not checked, so S4 and S4b count nothing", [n.loadsChecked, n.s4, n.s4b && n.s4b.noLoadDarkDays, Object.keys(n.bySplit || {}).every((k) => k.startsWith("loads_not_checked|"))],
		[false, { noLoadDaysWithFixes: 0, notConfirmed: 0 }, 0, true]);
	const text = run([`--db=${DB_FILE}`, `--now=${NOW}`, "--shadow", "--days=14", `--values-json=${VALUES}`]).stdout;
	ok("§3.8 the text names \"Confirmed (no ELD data)\" on its own line, and S2, S4 and S4b", /^ {3}"Confirmed \(no ELD data\)": 14 driver-day\(s\)\.$/m.test(text) && /S2: /.test(text) && /S4: /.test(text) && /S4b: /.test(text), text.slice(0, 600));
}

section("§4 --names");
{
	const r = run([`--db=${DB_FILE}`, `--now=${NOW}`, "--json", "--shadow", "--days=14", "--names", `--values-json=${VALUES}`]);
	const j = r.json || {};
	eq("§4.1 initials and units", [j.perRow && j.perRow.map((x) => x.driver), j.shadow && j.shadow.perDriver.map((x) => x.driver), j.unlinked && j.unlinked.list, j.devices && [...new Set(j.devices.list.map((e) => e.unit))].sort()],
		[["H.R."], ["H.R.", "S.K."], [{ driver: "S.K.", unit: "T2" }], ["T1", "T3"]]);
	ok("§4.2 never a full name", !/Hollis|Renner|Soren|King|Tamsin|Vale/.test(r.stdout));
	ok("§4.3 never a position", !/29\.7|-95\.4|latitude|longitude/.test(r.stdout));
}

section("§5 read-only");
{
	eq("§5.1 the database file's bytes are unchanged after every run", sha(), shaBefore);
	eq("§5.2 ...and its folder holds no new file", fs.readdirSync(tmp).sort(), filesBefore);
}

section("§6 the lift reaches no writer");
{
	const { LIFT_DENIED, LIFT_ROOTS } = require("./time-off-eld-check-report");
	ok("§6.1 the run's write, the purge, the tick, the audit, the notices and every send are denied",
		["applyTimeOffEldPlan", "runTimeOffEldCheck", "timeOffEldCheckTick", "purgeTimeOffEldResults", "logAudit", "insertDispatchNotification", "emitDispatchNotice", "notifyChange", "sendEmail"].every((n) => LIFT_DENIED.includes(n)));
	ok("§6.2 ...and none of them is a root", !LIFT_ROOTS.some((n) => LIFT_DENIED.includes(n)));
	const src = fs.readFileSync(REPORT, "utf8");
	ok("§6.3 the report's own SQL only reads", !/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)\b\s/.test(src.replace(/\/\/.*$/gm, "")));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ntest-time-off-eld-check-report: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
	for (const f of failures) console.log(`  ✗ ${f}`);
	process.exit(1);
}
