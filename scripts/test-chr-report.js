#!/usr/bin/env node
// scripts/chr-dry-run-report.js: the read-only "what would be sent" report that
// gate G1 runs on the replica before recording goes on in production (R5 PR 1a:
// plan 4.10). It replays the recorder's pipeline over a copy and prints counts
// only, never a load ID or a person.
//
//   §1  the source: both inputs opened read-only; no write call; it reuses the
//       lib's pipeline
//   §2  the SELECTs it copies from server.js are still server.js's, verbatim
//   §3  on a made-up copy: every count the plan lists, and no load ID, name or
//       address in its output
//   §4  the inputs are byte-for-byte unchanged afterwards
//   §5  usage: a missing or bad argument, or an input that is not a copy, exits 2
//       before reading anything else
//
// Made-up data only. The copy is written to a fresh mkdtemp folder; no network.
//   node scripts/test-chr-report.js      # exits 1 on any failure
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "chr-dry-run-report.js");
const R = require(SCRIPT);

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function section(t) { console.log(`\n${t}`); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "chr-report-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

// ------------------------------------------------------------------ §1
section("§1  the source");
const SRC_TEXT = fs.readFileSync(SCRIPT, "utf8");
const CODE = SRC_TEXT.replace(/^\s*\/\/.*$/gm, "");
ok(/new Database\([^)]{0,80}\{\s*readonly: true, fileMustExist: true\s*\}\)/.test(CODE), "§1 the database is opened read-only, and must exist");
ok((CODE.match(/new Database\(/g) || []).length === 1, "§1 ...once");
ok(/fs\.readFileSync\(/.test(CODE), "§1 the sheets copy is read with readFileSync");
for (const [label, re] of [
	["no file write", /writeFileSync|appendFileSync|createWriteStream|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync|\.writeFile\(/],
	["no statement run", /\.run\(|\.exec\(|\.pragma\(|\.transaction\(/],
	["no writing SQL", /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|VACUUM)\b/],
	["no replica Sheets fake (it can write)", /replica-sheets/],
	["no network", /\bfetch\(|require\(["'](?:https?|net|tls)["']\)/],
	["no environment read", /process\.env|\benv\./],
]) ok(!re.test(CODE), `§1 ${label}`);
for (const lib of ["chr-events", "chr-verify", "chr-sweep", "load-haul", "eld-miles"]) ok(new RegExp(`require\\(path\\.join\\(ROOT, "lib", "${lib}\\.js"\\)\\)`).test(SRC_TEXT), `§1 it reuses lib/${lib}.js`);

// ------------------------------------------------------------------ §2
section("§2  the SELECTs copied from server.js");
const SERVER = require("./lib/server-source").serverSource();
const flat = (s) => String(s).replace(/\s+/g, " ").trim();
const FLAT_SERVER = flat(SERVER);
for (const [name, sql] of Object.entries(R.SERVER_SQL)) {
	ok(FLAT_SERVER.includes(flat(sql)), `§2 ${name}: ${flat(sql).slice(0, 70)}... is in server.js`);
}
eq(Object.keys(R.SERVER_SQL).sort(), ["coordinates", "deletedLoads", "deviceAssignments", "deviceCurrentLinks", "deviceHistoryStart", "haulAssignments"], "§2 the six copied reads");
ok(/\nconst ELD_DEVICE_HISTORY_START_KEY = "eld_device_history_started";/.test(SERVER) && R.DEVICE_HISTORY_START_KEY === "eld_device_history_started", "§2 the device-history start key");

// ------------------------------------------------------------------ §3
section("§3  a made-up copy");
const DB_FILE = path.join(TMP, "app.db");
const SHEETS_FILE = path.join(TMP, "sheets.json");
const AT = (iso) => iso.replace("T", " ").slice(0, 19);
const MS = (iso) => Date.parse(iso);
{
	const db = new Database(DB_FILE);
	db.exec(`
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '', new_status TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'manual', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP, reason TEXT DEFAULT '');
		CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, routemate_vehicle_id TEXT NOT NULL, latitude REAL, longitude REAL,
			speed REAL DEFAULT 0, location_date_ms INTEGER DEFAULT 0, dropped_reason TEXT DEFAULT '', source TEXT DEFAULT '', geocoded_location TEXT DEFAULT '');
		CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, routemate_vehicle_id TEXT);
		CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT, truck_id INTEGER, start_date TEXT, end_date TEXT DEFAULT '');
		CREATE TABLE eld_device_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, routemate_vehicle_id TEXT, assigned_from TEXT, assigned_until TEXT DEFAULT '', assigned_by TEXT DEFAULT '');
		CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
		CREATE TABLE load_coordinates (load_id TEXT PRIMARY KEY, origin_lat REAL, origin_lng REAL, dest_lat REAL, dest_lng REAL, pickup_address TEXT DEFAULT '', dropoff_address TEXT DEFAULT '');
		CREATE TABLE deleted_loads (load_id TEXT PRIMARY KEY);
		CREATE TABLE load_driver_instructions (load_key TEXT PRIMARY KEY, load_id TEXT, payload TEXT);
	`);
	const H = (load, status, at, source = "manual") => db.prepare("INSERT INTO load_status_history (load_id, new_status, source, actor, changed_at, reason) VALUES (?, ?, ?, 'Canary Testdriver', ?, 'canary note')").run(load, status, source, AT(at));
	const P = (vid, at, lat, lng, over = {}) => db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, location_date_ms, dropped_reason, source, geocoded_location) VALUES (?, ?, ?, ?, ?, ?, ?, '742 Evergreen Terrace')")
		.run(vid, lat, lng, over.speed || 0, MS(at), over.dropped || "", over.source === undefined ? "routemate" : over.source);
	for (const [id, unit, vid, driver] of [[1, "T-101", "RM-1", "Canary Testdriver"], [2, "T-102", "RM-2", "Driver Two"], [3, "T-103", "RM-3", "Driver Three"]]) {
		db.prepare("INSERT INTO trucks (id, unit_number, routemate_vehicle_id) VALUES (?, ?, ?)").run(id, unit, vid);
		db.prepare("INSERT INTO truck_assignments (driver_name, truck_id, start_date, end_date) VALUES (?, ?, '2026-09-01', '')").run(driver, id);
		db.prepare("INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from, assigned_until) VALUES (?, ?, '2026-09-01T00:00:00.000Z', '')").run(id, vid);
	}
	db.prepare("INSERT INTO server_state (key, value) VALUES ('eld_device_history_started', ?)").run(JSON.stringify({ atMs: MS("2026-09-01T00:00:00Z") }));
	db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng) VALUES ('223456789', 42.0347, -93.62, 41.525, -88.0817)").run();
	db.prepare("INSERT INTO deleted_loads (load_id) VALUES ('823456789')").run();
	// A: the common trip, confirmed by pings; before the window, one row that is not counted.
	H("123456789", "Dispatched", "2026-09-30T12:00:00Z", "dispatch");
	H("123456789", "At Shipper", "2026-10-02T14:00:00Z");
	P("RM-1", "2026-10-02T14:03:00Z", 42.035, -93.6195);
	P("RM-1", "2026-10-02T14:25:00Z", 42.035, -93.6195);
	H("123456789", "In Transit", "2026-10-02T14:30:00Z");
	P("RM-1", "2026-10-02T14:40:00Z", 42.08, -93.62, { speed: 20 });
	H("123456789", "At Receiver", "2026-10-02T18:00:00Z", "geofence");
	P("RM-1", "2026-10-02T18:02:00Z", 41.5252, -88.0815);
	P("RM-1", "2026-10-02T18:20:00Z", 41.5252, -88.0815);
	H("123456789", "Delivered", "2026-10-02T18:30:00Z");
	P("RM-1", "2026-10-02T18:21:00Z", 41.5252, -88.0815, { source: "linxup" });
	P("RM-1", "2026-10-02T18:22:00Z", 41.5252, -88.0815, { dropped: "speed_outlier" });
	P("RM-1", "2026-09-29T10:00:00Z", 42.035, -93.6195);
	// B: tapped about 285 miles from its pickup (points from load_coordinates).
	H("223456789", "At Shipper", "2026-10-03T10:00:00Z");
	P("RM-2", "2026-10-03T10:05:00Z", 37.9, -93.62);
	P("RM-2", "2026-10-03T10:10:00Z", 37.9, -93.62);
	P("RM-2", "2026-10-03T10:20:00Z", 37.9, -93.62);
	H("223456789", "In Transit", "2026-10-03T10:30:00Z");
	P("RM-2", "2026-10-03T10:40:00Z", 37.95, -93.62, { speed: 25 });
	// C-G: another broker, eight digits, a blank Email, cancelled, deleted.
	for (const id of ["323456789", "42345678", "523456789", "623456789", "823456789"]) H(id, "At Shipper", "2026-10-04T09:00:00Z");
	// H: two pickups (multi-stop), no pings.
	for (const [s, t] of [["At Shipper", "08:00"], ["In Transit", "09:00"], ["At Shipper", "11:00"], ["In Transit", "12:00"], ["At Receiver", "16:00"], ["Delivered", "17:00"]]) H("723456789", s, `2026-10-05T${t}:00Z`);
	// I: a jump from Dispatched to At Receiver. J: no mapped point anywhere.
	H("923456789", "Dispatched", "2026-10-05T10:00:00Z", "dispatch");
	H("923456789", "At Receiver", "2026-10-05T12:00:00Z");
	H("133456789", "In Transit", "2026-10-05T13:00:00Z");
	db.close();
}
const HEAD = ["Load ID", "Status", "Driver", "Email", "Broker Contact Name", "Trailer Number", "Pickup Address", "Drop-off Address", "Payment", "Pickup Lat", "Pickup Lng", "Drop-off Lat", "Drop-off Lng"];
const row = (id, over = {}) => {
	const r = {
		"Load ID": id, Status: "Delivered", Driver: "Canary Testdriver", Email: "made-up.agent@chrobinson.com", "Broker Contact Name": "Agent Canary",
		"Trailer Number": "53001", "Pickup Address": "100 Test Rd, Ames, IA 50010", "Drop-off Address": "200 Sample Ave, Joliet, IL 60431", Payment: "$1,234.56",
		"Pickup Lat": "42.0347", "Pickup Lng": "-93.62", "Drop-off Lat": "41.525", "Drop-off Lng": "-88.0817", ...over,
	};
	return HEAD.map((h) => r[h]);
};
const SHEETS = {
	format: 1, exportedAt: "2026-10-06T12:00:00.000Z",
	spreadsheets: {
		"made-up-archive": { role: "archive", sheets: [{ properties: { title: "Job Tracking" }, values: [HEAD, row("999999999")] }] },
		"made-up-main": {
			role: "main",
			sheets: [
				{ properties: { title: "Drivers" }, values: [["Name"], ["Canary Testdriver"]] },
				{ properties: { title: "Job Tracking" }, values: [
					HEAD,
					row("#123456789", { "Trailer Number": "53001 / spare" }),
					row("223456789", { Driver: "Driver Two", "Pickup Lat": "", "Pickup Lng": "", "Drop-off Lat": "", "Drop-off Lng": "" }),
					row("323456789", { Email: "made-up.agent@tql.com" }),
					row("42345678"),
					row("523456789", { Email: "" }),
					row("623456789", { Status: "Cancelled" }),
					row("823456789"),
					row("723456789", { Driver: "Driver Three" }),
					row("923456789"),
					row("133456789", { "Pickup Lat": "", "Pickup Lng": "", "Drop-off Lat": "", "Drop-off Lng": "" }),
					[],
				] },
			],
		},
	},
};
fs.writeFileSync(SHEETS_FILE, JSON.stringify(SHEETS));
const hash = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const before = [hash(DB_FILE), hash(SHEETS_FILE)];
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: TMP, timeout: 30000 });
const res = run(["--db", DB_FILE, "--sheets", SHEETS_FILE, "--since", "2026-10-01"]);
const out = `${res.stdout || ""}${res.stderr || ""}`;
eq(res.status, 0, "§3 the report exits 0");
const line = (label) => { const m = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (.*)$`, "m").exec(out); return m ? m[1] : null; };
eq(line("Job Tracking copy pulled at"), "2026-10-06T12:00:00.000Z", "§3 it prints when the copy was pulled");
eq(line("Clean RouteMate pings since 2026-10-01"), "9, from 2026-10-02T14:03:00.000Z to 2026-10-03T10:40:00.000Z", "§3 ...and the telemetry range it found (RouteMate rows with no dropped reason)");
eq(line("CHR loads found"), "5", "§3 CHR loads found");
eq(line("9-digit Load IDs on other brokers' domains"), "1", "§3 9-digit Load IDs on other brokers' domains");
eq(line("chrobinson.com loads without a 9-digit Load ID"), "1", "§3 chrobinson.com loads without a 9-digit Load ID (likely missed CHR loads)");
eq(line("Email blank or unreadable"), "1", "§3 Email blank or unreadable");
eq(line("Missing from Job Tracking (cancelled, deleted or not on it)"), "2", "§3 missing from the live Job Tracking view: one cancelled, one deleted");
eq(line("Multi-stop loads"), "1", "§3 multi-stop loads");
eq(line("Events by type"), "arrived_pickup 4, departed_pickup 5, arrived_delivery 3, departed_delivery 0, delivered 2", "§3 events by type");
eq(line("Events by source"), "geofence 1, manual 13", "§3 events by source");
eq(line("Would have been sent"), "3", "§3 would have been sent");
eq(line("Not sent while \"Arrived at pickup\" is off"), "2 (confirmed at the stop: 1)", "§3 arrivals held back by the switch (O8)");
eq(line("Held, by reason"), "multi_stop 6, stop_not_mapped 1, stop_skipped 1, tap_away_from_stop 1", "§3 held, by reason");
eq(line("Taps away from their stop, by event"), "arrived_pickup 1, departed_pickup 1", "§3 taps away from their stop, by event type");
eq(line("Still inside their window"), "0", "§3 none still waiting on its window");
eq(line("Fields dropped by their pattern"), "3", "§3 fields dropped (a trailer cell that is more than a number, in three payloads)");
eq(line("Forbidden-field scan"), "0", "§3 the forbidden-field scan finds nothing");
const leaks = ["123456789", "223456789", "323456789", "42345678", "523456789", "623456789", "723456789", "823456789", "923456789", "133456789", "999999999",
	"Canary", "Testdriver", "Driver Two", "agent@", "chrobinson.com>", "Evergreen", "1,234.56", "Test Rd", "Sample Ave", "T-101", "53001"];
eq(leaks.filter((s) => out.includes(s)), [], "§3 no load ID, name, email, address, amount, truck or trailer in the output");

// ------------------------------------------------------------------ §4
section("§4  read-only");
eq([hash(DB_FILE), hash(SHEETS_FILE)], before, "§4 both inputs byte-for-byte unchanged");
eq(fs.readdirSync(TMP).sort(), ["app.db", "sheets.json"], "§4 no other file made beside them (no journal, no WAL)");

// ------------------------------------------------------------------ §5
section("§5  usage");
for (const [label, args, re] of [
	["no arguments", [], /usage/i],
	["no --since", ["--db", DB_FILE, "--sheets", SHEETS_FILE], /--since/],
	["a bad --since", ["--db", DB_FILE, "--sheets", SHEETS_FILE, "--since", "2026-13-01"], /--since/],
	["no --db", ["--sheets", SHEETS_FILE, "--since", "2026-10-01"], /--db/],
	["a --db that is not there", ["--db", path.join(TMP, "none.db"), "--sheets", SHEETS_FILE, "--since", "2026-10-01"], /--db/],
	["a --sheets that is not a working copy", ["--db", DB_FILE, "--sheets", DB_FILE, "--since", "2026-10-01"], /--sheets/],
	["an unknown option", ["--db", DB_FILE, "--sheets", SHEETS_FILE, "--since", "2026-10-01", "--write"], /unknown/i],
]) {
	const r = run(args);
	eq(r.status, 2, `§5 ${label}: exit 2`);
	ok(re.test(`${r.stdout}${r.stderr}`), `§5 ${label}: says what is wrong`);
}
eq(fs.readdirSync(TMP).sort(), ["app.db", "sheets.json"], "§5 no file made by a refused run");

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
