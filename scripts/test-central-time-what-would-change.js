#!/usr/bin/env node
// scripts/central-time-what-would-change.js: the read-only "what would change"
// report for the switch to US Central, on a made-up copy.
//
//   §1 what it finds: each reader's seam-hour item in an open month (11 PM-midnight
//      CT, which is the next day on the Eastern clock) under a bare flip, nothing
//      in a locked month or before 2026-10-09, and nothing the switch moves; the
//      held truck at noon; the sheet's stamps and zoned cells; the other readers of
//      a stored instant (pings with no longitude, activity weeks, the backfill, the
//      Personal wait, the auto-invoice baseline, device links, invoice and
//      adjustment dates, deleted loads, day-off decisions and drafts, Personal
//      corrections, edit holds); the readers it names unmeasured; the switch itself
//      (Friday Nov 20's cutoff and batch, November's close, the app's settings).
//   §2 what it prints: ids, days and counts, none of the copy's names; the four
//      parts, with each unmeasured reader by name.
//   §3 read-only: the database opens read-only, its SQL is SELECT only, its
//      requires are pinned, and nothing in the folder changes.
//   §4 the command line: the file run gives the in-process report; every refused
//      argument (no --dry-run, database, sheet, zone or moment; a zone that makes no
//      switch; an unknown option; a database that isn't there or isn't a copy)
//      exits 2 and touches nothing.
//   §5 an item the switch itself would move is listed, and the run exits 1.
//   §6 the PDF dates (D5): a payout's stamp and a zoned stamp cell, under a bare
//      flip only.
//
// Made-up data only, in a fresh temp folder. Never reads app.db.
//   node scripts/test-central-time-what-would-change.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "central-time-what-would-change.js");
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const ZONE = "America/Chicago";
const FROM = "2026-11-18T02:00:00Z";

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
const ok = (cond, label) => eq(Boolean(cond), true, label);
function section(title, fn) {
	console.log(`\n${title}`);
	try { fn(); } catch (err) { failures.push(`${title}\n      threw: ${String(err && err.message).split("\n")[0]}`); }
}

let report = null;
try { report = require(SCRIPT); } catch (err) { failures.push(`the script loads: ${String(err && err.message).split("\n")[0]}`); }

// ── the made-up copy ──────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "central-time-report-"));
const DB_FILE = path.join(TMP, "app.db");
const SETTINGS = path.join(TMP, "settings.txt");
const VALUES = path.join(TMP, "values.json");
fs.writeFileSync(SETTINGS, "");
const NAMES = ["Made-up Driver A", "Made-up Driver B", "Made-up Carrier", "Made-up Operator LLC"];
function makeDb(file, extra = () => {}) {
	const db = new Database(file);
	db.exec(`
		CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '');
		CREATE TABLE carrier_driver_history (id INTEGER PRIMARY KEY, carrier_name TEXT, driver_name TEXT, started_at DATETIME, ended_at DATETIME);
		CREATE TABLE pay_rate_history (id INTEGER PRIMARY KEY, subject TEXT, subject_key TEXT, rate REAL, effective_from TEXT, source TEXT);
		CREATE TABLE expenses (id INTEGER PRIMARY KEY, date TEXT, timestamp TEXT DEFAULT '', created_at DATETIME, type TEXT, amount REAL, receipt_details TEXT DEFAULT '');
		CREATE TABLE fuel_events (id INTEGER PRIMARY KEY, routemate_vehicle_id TEXT, start_ms INTEGER, end_ms INTEGER, local_day TEXT);
		CREATE TABLE invoices (id INTEGER PRIMARY KEY, driver_name TEXT, paid_at TEXT, created_at DATETIME, adjusted_at TEXT DEFAULT '', deleted_at TEXT DEFAULT '', week_start TEXT DEFAULT '');
		CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY, routemate_vehicle_id TEXT, longitude REAL, location_date_ms INTEGER, dropped_reason TEXT DEFAULT '');
		CREATE TABLE auto_invoice_meta (key TEXT PRIMARY KEY, value TEXT);
		CREATE TABLE eld_device_assignments (id INTEGER PRIMARY KEY, truck_id INTEGER, routemate_vehicle_id TEXT, assigned_from TEXT, assigned_until TEXT DEFAULT '');
		CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY, load_id TEXT, deleted_at DATETIME, deleted_by TEXT DEFAULT '');
		CREATE TABLE driver_availability (id INTEGER PRIMARY KEY, directory_id INTEGER, decided_at TEXT);
		CREATE TABLE time_off_chr_drafts (id INTEGER PRIMARY KEY, availability_id INTEGER, drafted_at TEXT);
		CREATE TABLE expense_personal (id INTEGER PRIMARY KEY, expense_id INTEGER, needs_correction_since TEXT DEFAULT '');
		CREATE TABLE load_cell_writes (id INTEGER PRIMARY KEY, load_key TEXT, column_name TEXT, at TEXT);
		CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, created_at DATETIME, in_service_date TEXT DEFAULT '');
		CREATE TABLE load_status_history (id INTEGER PRIMARY KEY, load_id TEXT, new_status TEXT, changed_at DATETIME, source TEXT DEFAULT '');
		CREATE TABLE owner_operators (id INTEGER PRIMARY KEY, user_id INTEGER, business_name TEXT, created_at TEXT);
		CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT, finalized_at TEXT);
		CREATE TABLE investor_config (owner_id INTEGER, key TEXT, value TEXT);
		CREATE TABLE audit_trail (id INTEGER PRIMARY KEY, timestamp TEXT, action TEXT);
		CREATE TABLE invoice_autogen_runs (id INTEGER PRIMARY KEY, ran_at TEXT, summary TEXT);
	`);
	const run = (sql, ...rows) => { const s = db.prepare(sql); for (const r of rows) s.run(...r); };
	// 11 PM-midnight CT is 04:00-05:00 UTC before Nov 1 and 05:00-06:00 UTC after.
	run("INSERT INTO truck_assignments VALUES (?, ?, ?, ?, ?)",
		[1, 900, NAMES[0], "2026-11-01T04:30:00.000Z", "2026-11-16T17:30:00.000Z"], // Oct 31 11:30 PM CDT; 12:30 PM EST Nov 16
		[2, 900, NAMES[1], "2026-11-16T17:30:00.000Z", ""],
		[3, 901, NAMES[1], "2026-10-05T03:30:00.000Z", "2026-11-05"], // the same day on both clocks; a bare day
		[4, 902, NAMES[1], "2026-11-02 05:30:00", ""]); // SQLite's text: the backfill keeps its first 10 characters
	run("INSERT INTO carrier_driver_history VALUES (?, ?, ?, ?, ?)", [1, NAMES[2], NAMES[0], "2026-11-01 04:30:00", null]);
	run("INSERT INTO pay_rate_history VALUES (?, ?, ?, ?, ?, ?)", [1, "driver", "made-up driver a", 300, "2026-11-10T05:30:00.000Z", "change"]);
	run("INSERT INTO expenses VALUES (?, ?, ?, ?, ?, ?, ?)",
		[1, "2026-11-10", "2026-11-10T05:30:00.000Z", "2026-11-10 05:30:05", "Fuel", 123.45, "made-up receipt text"],
		[2, "2026-11-05", "", "2026-11-05 15:00:00", "Tolls", 12, ""],
		[3, "2026-10-12", "2026-10-13T04:30:00.000Z", "2026-10-13 04:30:00", "Fuel", 50, ""]); // October: locked
	run("INSERT INTO fuel_events VALUES (?, ?, ?, ?, ?)", [1, "MADE-UP-VID-1", Date.parse("2026-11-12T05:30:00Z"), Date.parse("2026-11-12T05:40:00Z"), "2026-11-12"]);
	run("INSERT INTO invoices (id, driver_name, paid_at, created_at, adjusted_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)",
		[1, NAMES[0], "2026-11-13T05:30:00.000Z", "2026-11-13 05:30:00", "2026-11-13T05:30:00.000Z", ""],
		[2, NAMES[1], "", "2026-11-05 15:00:00", "", "2026-11-14T05:30:00.000Z"], // Saturday Nov 14 on Eastern, Friday Nov 13 on Central
		[3, NAMES[1], "", "2026-11-05 15:00:00", "", "2026-11-10T05:30:00.000Z"]); // a day earlier, the same week
	run("INSERT INTO routemate_telemetry (routemate_vehicle_id, longitude, location_date_ms, dropped_reason) VALUES (?, ?, ?, ?)",
		...["2026-11-14T05:10:00Z", "2026-11-14T05:20:00Z", "2026-11-14T15:00:00Z"].map((t) => ["MADE-UP-VID-1", -90.5, Date.parse(t), ""]),
		["MADE-UP-VID-1", null, Date.parse("2026-11-14T05:40:00Z"), ""], // no longitude: the business clock's day
		["MADE-UP-VID-1", null, Date.parse("2026-11-14T15:10:00Z"), ""],
		["MADE-UP-VID-1", -90.5, Date.parse("2026-11-14T05:50:00Z"), "jump"],
		["MADE-UP-VID-1", -90.5, Date.parse("2026-11-10T05:15:00Z"), ""]); // Tuesday to Monday: the same week
	run("INSERT INTO auto_invoice_meta VALUES (?, ?)", ["baseline_at", "2026-09-20T04:30:00.000Z"], ["shadow_baseline_at", "2026-11-02T15:00:00.000Z"], ["settings_notice", "made-up"]);
	run("INSERT INTO eld_device_assignments VALUES (?, ?, ?, ?, ?)", [1, 900, "MADE-UP-VID-1", "2026-11-03T05:30:00.000Z", ""], [2, 901, "MADE-UP-VID-2", "2026-11-04T15:00:00.000Z", "2026-11-11T05:30:00.000Z"]);
	run("INSERT INTO deleted_loads VALUES (?, ?, ?, ?)", [1, "LD-MADEUP-5", "2026-11-08 05:30:00", "made-up"]);
	run("INSERT INTO driver_availability VALUES (?, ?, ?)", [1, 31, "2026-11-09T05:30:00.000Z"], [2, 32, null]);
	run("INSERT INTO time_off_chr_drafts VALUES (?, ?, ?)", [1, 1, "2026-11-09T05:45:00.000Z"], [2, 2, null]);
	run("INSERT INTO expense_personal VALUES (?, ?, ?)", [1, 1, "2026-11-10T05:30:00.000Z"], [2, 2, ""]);
	run("INSERT INTO load_cell_writes VALUES (?, ?, ?, ?)", [1, "ld-madeup-1", "Rate", "2026-11-11T05:30:00.000Z"]);
	run("INSERT INTO trucks VALUES (?, ?, ?, ?)", [1, "MADE-UP-T1", "2026-11-03 05:30:00", ""], [2, "MADE-UP-T2", "2026-11-03 05:30:00", "2026-11-04"]);
	run("INSERT INTO load_status_history VALUES (?, ?, ?, ?, ?)", [1, "LD-MADEUP-1", "At Shipper", "2026-11-06 05:30:00", "driver"], [2, "LD-MADEUP-1", "At Receiver", "2026-11-06 05:45:00", "geofence"]);
	run("INSERT INTO owner_operators VALUES (?, ?, ?, ?)", [1, 7, NAMES[3], "2026-11-07T05:30:00.000Z"]);
	run("INSERT INTO period_locks VALUES (?, ?, ?)", ["2026-10", "locked", "2026-11-15T05:00:00.000Z"]);
	run("INSERT INTO investor_config VALUES (?, ?, ?)", [0, "settlement_grace_days", "14"]);
	run("INSERT INTO audit_trail VALUES (?, ?, ?)", [1, "2026-11-08T05:30:00.000Z", "expense_ai_insights"]);
	run("INSERT INTO invoice_autogen_runs VALUES (?, ?, ?)", [1, "2026-11-14T01:00:00.000Z", "made-up run"]);
	extra(db, run);
	db.close();
}
makeDb(DB_FILE);
const SHEET = { values: [
	["Load ID", "Job Status", "Driver", "Assigned Date", "Status Update Date", "Completion Date"],
	["LD-MADEUP-1", "Delivered", NAMES[0], "11/2/2026, 9:21:43 AM", "11/02/2026 18:05:00", "11/02/2026 18:05:00"],
	["LD-MADEUP-2", "Delivered", NAMES[1], "", "10/20/2026 9:00:00", "10/20/2026 9:00:00"], // October: locked
	["LD-MADEUP-3", "Delivered", NAMES[0], "2026-11-09T05:30:00Z", "", ""],
	["LD-MADEUP-4", "In Transit", NAMES[1], "", "09/30/2026 23:30:00", ""], // before 2026-10-09
] };
fs.writeFileSync(VALUES, JSON.stringify(SHEET));
const DB_BYTES = fs.readFileSync(DB_FILE);
const listing = (dir) => fs.readdirSync(dir).sort().map((n) => `${n}:${fs.statSync(path.join(dir, n)).size}:${fs.statSync(path.join(dir, n)).mtimeMs}`);
const BEFORE = listing(TMP);
const NOW = Date.parse("2026-11-16T15:00:00Z");

const open = (file) => new Database(file, { readonly: true, fileMustExist: true });
const build = (file, nowMs = NOW) => {
	const db = open(file);
	try { return report.buildReport({ db, values: SHEET, env: {}, zone: ZONE, from: FROM, nowMs }); } finally { db.close(); }
};
const by = (r, id) => r.readers.find((x) => x.id === id) || {};
const refs = (r, id, kind = "flip") => (Array.isArray(by(r, id)[kind]) ? by(r, id)[kind].map((x) => `${x.ref} ${x.today}->${x[kind]}`) : by(r, id)[kind]);

// ── §1 ────────────────────────────────────────────────────────────────────────
let built = null;
section("§1  what it finds", () => {
	built = build(DB_FILE);
	eq([built.openMonths, built.lockedMonths], [["2026-11"], ["2026-10"]], "§1 open months: from 2026-10 to this month, less October, which is locked");
	eq(refs(built, "P8"), ["truck_assignments #1 start_date 2026-11->2026-10", "carrier_driver_history #1 started_at 2026-11->2026-10"], "§1 P8 an assignment at 11:30 PM CT on Oct 31 would move to October under a bare flip (SQLite's UTC text too); the bare day and the same-day one do not");
	eq(refs(built, "P9"), ["truck_assignments #1 end_date 2026-11-16->holder at 2026-11-16T18:00:00.000Z", "truck_assignments #2 start_date 2026-11-16->holder at 2026-11-16T18:00:00.000Z"], "§1 P9 the handover at 12:30 PM EST on Nov 16 falls between the two noons: that day's holder would change");
	eq(refs(built, "P5"), ["pay_rate_history #1 2026-11-10->2026-11-09"], "§1 P5 a rate saved at 11:30 PM CST on Nov 9 would start a day early");
	eq(refs(built, "C6/C9"), ["expenses #1 2026-11-10->2026-11-09"], "§1 C6/C9 a receipt submitted then would move to Nov 9; the other day and the locked month's do not");
	eq(by(built, "C6/C9").flip && by(built, "C6/C9").flip[0].futureCheckFlips, true, "§1 ...and auto-approval's future check would flip (dated Nov 10, submitted Nov 9)");
	eq(refs(built, "F5/F6"), ["fuel_events #1 2026-11-12->2026-11-11"], "§1 F5/F6 a fill then would move a day on a re-scan");
	eq(refs(built, "D10"), ["invoices #1 2026-11-13->2026-11-12"], "§1 D10 a payment then would print a day early; an unpaid invoice is not read");
	eq(by(built, "F9").flip, { "MADE-UP-VID-1 2026-11-14": 3, "MADE-UP-VID-1 2026-11-10": 1 }, "§1 F9 three pings in Saturday's seam hour and one in Tuesday's would move a day; a dropped ping and the midday ones do not");
	eq(by(built, "P3").flip, { "MADE-UP-VID-1 2026-11-14": 1 }, "§1 P3 of those, the one with no longitude: its pay and mileage day falls back to the business clock (a midday one does not move)");
	eq(by(built, "W6").flip, { "MADE-UP-VID-1 week of 2026-11-14": 3 }, "§1 W6 Saturday's three would move from Nov 14's activity week to the week before; Tuesday's stays in its week");
	eq(refs(built, "P14"), ["trucks #1 2026-11-03->2026-11-02"], "§1 P14 a truck with no in-service date created then would start charging a day early; one with a date is not read");
	eq(refs(built, "P4"), ["load_status_history #1 2026-11-06->2026-11-05", "load_status_history #2 2026-11-06->2026-11-05"], "§1 P4 status taps then would move their trip day");
	eq(refs(built, "P13"), ["owner_operators #1 2026-11-07->2026-11-06"], "§1 P13 an owner-operator accepted then would move a day");
	eq(by(built, "S20").flip, { "expenses.created_at": 1, "audit_trail.timestamp": 1, "load_status_history.changed_at": 1, "trucks.created_at": 2 },
		"§1 S20 the KPI series' instants, as its gatherer reads them: AI-read receipts, AI insights, geofence and At Receiver taps, every truck");
	eq(refs(built, "M4"), ["sheet row 2 Status Update Date 2026-11-02->2026-11-03T00:05:00.000Z", "sheet row 2 Completion Date 2026-11-02->2026-11-03T00:05:00.000Z"], "§1 M4 a November stamp would be re-read an hour late (its date kept); October's and September's are left out");
	eq(refs(built, "M4z"), ["sheet row 4 Assigned Date 2026-11-09->2026-11-08"], "§1 M4z a zoned cell in the seam hour would move a day");
	eq(refs(built, "R1"), ["truck_assignments #1 start_date 2026-11-01->2026-10-31"], "§1 R1 the backfill's day of an assignment stamped then would move; SQLite's text and a bare day keep their first 10 characters");
	eq(refs(built, "P7"), ["invoices #2 deleted_at 2026-11-14->2026-11-07"], "§1 P7 a Personal line's wait on an invoice deleted then would end a week early; a day earlier in the same week is not listed");
	eq(refs(built, "I2"), ["auto_invoice_meta baseline_at 2026-09-20->2026-09-19"], "§1 I2 a baseline taken then would move a day, though September is not open (the open months' loads are compared with it)");
	eq(refs(built, "F12"), ["eld_device_assignments #1 assigned_from 2026-11-03->2026-11-02", "eld_device_assignments #2 assigned_until 2026-11-11->2026-11-10"], "§1 F12 a device link's bounds stamped then would move a day; an open end is not read");
	eq(refs(built, "D7"), ["invoices #1 created_at 2026-11-13->2026-11-12"], "§1 D7 a regenerated invoice created then would print a day early");
	eq(refs(built, "D9"), ["invoices #1 adjusted_at 2026-11-13->2026-11-12"], "§1 D9 an adjustment made then would print a day early; no adjustment is not read");
	eq(refs(built, "D16"), ["deleted_loads #1 deleted_at 2026-11-08->2026-11-07"], "§1 D16 a load deleted then would list a day early");
	eq(refs(built, "R2"), ["driver_availability #1 decided_at 2026-11-09->2026-11-08"], "§1 R2 a day-off request decided then would move a day; an undecided one is not read");
	eq(refs(built, "S26"), ["time_off_chr_drafts #1 drafted_at 2026-11-09->2026-11-08"], "§1 S26 a CHR draft made then would move a day; one not yet made is not read");
	eq(refs(built, "R3"), ["expense_personal #1 needs_correction_since 2026-11-10->2026-11-09"], "§1 R3 a Personal correction waiting since then would move a day; one not waiting is not read");
	eq(refs(built, "A14"), ["load_cell_writes #1 at 2026-11-11->2026-11-10"], "§1 A14 an edit held then would give another day");
	eq([built.notMeasured.length, built.notMeasured.every((s) => typeof s === "string" && s.length > 20)], [11, true], "§1 the readers it does not measure are named, not counted as none");
	eq([built.switchedTotal, built.readers.filter((r) => r.switchedCount).map((r) => r.id)], [0, []], "§1 the switch itself moves nothing: every instant here is before it");
	const t = built.theSwitch;
	eq([t.friday, t.cutoff, t.batch], ["2026-11-20", { before: "2026-11-20T23:30:00.000Z", after: "2026-11-21T00:30:00.000Z" }, { before: "2026-11-21T00:00:00.000Z", after: "2026-11-21T01:00:00.000Z" }],
		"§1 the next Friday after the switch: cutoff 6:30 PM and batch 7:00 PM, an hour later on the Central clock");
	eq(t.close, { month: "2026-11", graceDays: 14, lastOpenDay: "2026-12-14", before: "2026-12-15T05:00:00.000Z", after: "2026-12-15T06:00:00.000Z" }, "§1 November closes at 00:00 Dec 15: 06:00 UTC on the Central clock");
	eq(t.appSettings, { APP_TIMEZONE: "(unset)", APP_TIMEZONE_FROM: "(unset)", zoneInForce: "America/New_York" }, "§1 the app's own settings, values only");
});

// ── §2 ────────────────────────────────────────────────────────────────────────
section("§2  what it prints", () => {
	const text = report.printText(built);
	for (const [what, s] of [["the text", text], ["the JSON", JSON.stringify(built)]]) {
		eq(NAMES.filter((n) => s.includes(n)), [], `§2 ${what} holds none of the copy's names`);
		ok(!/123\.45/.test(s), `§2 ${what} holds no amount`);
	}
	ok(/1\. What a bare flip would move/.test(text) && /2\. What the switch moves \(both settings, this code\): none among the readers measured here \(11 more are named in 4\)/.test(text) && /3\. The switch itself/.test(text) && /4\. Not measured here \(11\)/.test(text),
		"§2 the text has the four parts, and says the switch moves nothing among the readers it measures, naming the rest");
	eq(built.notMeasured.filter((n) => !text.includes(`  - ${n}`)), [], "§2 ...each unmeasured reader printed by name");
});

// ── §3 ────────────────────────────────────────────────────────────────────────
section("§3  read-only", () => {
	eq(listing(TMP), BEFORE, "§3 the folder is unchanged after the in-process run");
	ok(fs.readFileSync(DB_FILE).equals(DB_BYTES), "§3 the database bytes are unchanged");
	const src = fs.readFileSync(SCRIPT, "utf8");
	const code = src.replace(/^\s*\/\/.*$/gm, "");
	ok(/openDb\(\{ root: ROOT, dbFile, readonly: true \}\)/.test(src) && !/readonly:\s*false/.test(code), "§3 the database opens through ledger-world's openDb() with readonly: true (refused unless the handle is read-only)");
	ok(!/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/.test(code), "§3 its SQL is SELECT only (no write, ATTACH or PRAGMA)");
	eq([...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]).sort(), ["../lib/app-time", "./lib/ledger-world", "path"], "§3 it requires only path, ledger-world and app-time (no network client of its own)");
	ok(!/\.run\(|\bdb\.exec\(|\.transaction\(|writeFile|appendFile|unlink|rmSync|mkdir/.test(code), "§3 it runs no write statement and writes no file");
});

// ── §4 ────────────────────────────────────────────────────────────────────────
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 60000, env: { ...process.env, APP_TIMEZONE: "", APP_TIMEZONE_FROM: "" } });
section("§4  the command line", () => {
	const good = ["--dry-run", `--db=${DB_FILE}`, `--env-file=${SETTINGS}`, `--values-json=${VALUES}`, `--zone=${ZONE}`, `--from=${FROM}`];
	const r = cli(...good, "--json");
	eq(r.status, 0, `§4 the file run exits 0 (the switch moves nothing)${r.status ? `: ${r.stderr.trim().split("\n")[0]}` : ""}`);
	let parsed = null;
	try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
	const strip = (o) => o && o.readers.map((x) => [x.id, x.flipCount, x.switchedCount]);
	eq(strip(parsed), strip(built), "§4 the command line finds what the module does");
	eq(parsed && parsed.theSwitch, built.theSwitch, "§4 ...and the same switch");
	const text = cli(...good);
	ok(text.status === 0 && /What a bare flip would move/.test(text.stdout) && !NAMES.some((n) => text.stdout.includes(n)), "§4 the text form runs, with no name");
	const missing = path.join(TMP, "missing.db");
	const elsewhere = path.join(ROOT, "scripts", "fixtures", "no-such.db");
	const refusals = [
		[good.filter((a) => a !== "--dry-run"), "--dry-run is required"],
		[good.filter((a) => !a.startsWith("--db=")), "--db=<app.db> is required"],
		[good.filter((a) => !a.startsWith("--values-json=")), "exactly one of --sheet-id"],
		[[...good, "--sheet-id=MADE-UP-SHEET"], "exactly one of --sheet-id"],
		[good.filter((a) => !a.startsWith("--zone=")), "--zone=<IANA zone> is required"],
		[good.filter((a) => !a.startsWith("--from=")), "--from=<ISO instant in UTC> is required"],
		[[...good.filter((a) => !a.startsWith("--zone=")), "--zone=America/New_York"], "makes no switch"],
		[[...good.filter((a) => !a.startsWith("--from=")), "--from=2026-11-18 02:00"], "makes no switch"],
		[[...good.filter((a) => !a.startsWith("--from=")), "--from=2026-10-01T05:00:00Z"], "makes no switch"],
		[[...good, "--write"], "unknown option"],
		[[...good.filter((a) => !a.startsWith("--db=")), `--db=${missing}`], "--db="],
		[[...good.filter((a) => !a.startsWith("--db=")), `--db=${elsewhere}`], "refusing"],
	];
	for (const [args, words] of refusals) {
		const x = cli(...args);
		ok(x.status === 2 && x.stderr.includes(words) && !x.stdout.trim(), `§4 refused with exit 2 (${words}): ${args.filter((a) => !good.includes(a)).join(" ") || `without ${good.find((a) => !args.includes(a))}`} (got ${x.status}: ${x.stderr.trim().split("\n")[0]})`);
	}
	ok(!fs.existsSync(missing) && !fs.existsSync(elsewhere), "§4 a database that isn't there is never created");
	eq(listing(TMP), BEFORE, "§4 the folder is unchanged after every run");
	ok(fs.readFileSync(DB_FILE).equals(DB_BYTES), "§4 the database bytes are unchanged after every run");
});

// ── §5 ────────────────────────────────────────────────────────────────────────
section("§5  an item the switch itself would move", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-time-report-after-"));
	const file = path.join(dir, "app.db");
	// A receipt submitted Nov 19 at 11:30 PM CST, after the moment (a copy that already holds one).
	makeDb(file, (db, run) => run("INSERT INTO expenses VALUES (?, ?, ?, ?, ?, ?, ?)", [9, "2026-11-19", "2026-11-20T05:30:00.000Z", "2026-11-20 05:30:00", "Fuel", 1, ""]));
	const after = build(file, Date.parse("2026-11-21T15:00:00Z"));
	eq([after.switchedTotal, refs(after, "C6/C9", "switched")], [1, ["expenses #9 2026-11-20->2026-11-19"]], "§5 it is listed: on the Central clock it was submitted Nov 19");
	const settings = path.join(dir, "settings.txt");
	fs.writeFileSync(settings, "");
	const x = cli("--dry-run", `--db=${file}`, `--env-file=${settings}`, `--values-json=${VALUES}`, `--zone=${ZONE}`, `--from=${FROM}`);
	eq(x.status, 1, "§5 and the run exits 1");

});

// ── §6 ────────────────────────────────────────────────────────────────────────
section("§6  the PDF dates (D5)", () => {
	// A payout paid at 11:30 PM CST on Nov 9 and a zoned Completion Date cell at
	// 11:30 PM CST on Nov 11, both before the moment.
	eq(by(built, "D5").flip, [], "§6 D5 the first copy has no payout and no zoned stamp cell");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-time-report-pdf-"));
	const file = path.join(dir, "app.db");
	makeDb(file, (db, run) => {
		db.exec("CREATE TABLE investor_payouts (id INTEGER PRIMARY KEY, owner_id INTEGER, period TEXT, due_date TEXT, paid_at TEXT, finalized_at TEXT DEFAULT '', adjusted_at TEXT DEFAULT '')");
		run("INSERT INTO investor_payouts VALUES (?, ?, ?, ?, ?, ?, ?)", [1, 5, "2026-10", "2026-11-15", "2026-11-10T05:30:00.000Z", "2026-11-03T15:00:00.000Z", ""]);
	});
	const zonedSheet = { values: [...SHEET.values, ["LD-MADEUP-6", "Delivered", NAMES[0], "", "", "2026-11-12T05:30:00Z"]] };
	const db = open(file);
	let pdf = null;
	try { pdf = report.buildReport({ db, values: zonedSheet, env: {}, zone: ZONE, from: FROM, nowMs: NOW }); } finally { db.close(); }
	eq(refs(pdf, "D5"), ["investor_payouts #1 paid_at 2026-11-10->2026-11-09", "sheet row 6 Completion Date 2026-11-12->2026-11-11"],
		"§6 D5 a bare flip would print both a day early (October is locked, the payment is in November; a midday finalize does not move)");
	eq([pdf.switchedTotal, refs(pdf, "D5", "switched")], [0, []], "§6 ...and the switch prints them as before: each is read on the clock in force at it");
});

if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`\n✓ ${pass} assertions passed`);
