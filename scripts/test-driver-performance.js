#!/usr/bin/env node
/**
 * Driver Performance: lib/driver-performance.js (the rules),
 * lib/driver-performance-routes.js (four read-only routes) and the one
 * server.js declaration that mounts them, DRIVER_PERFORMANCE_ENABLED a kill
 * switch, on unless set to false. A driver sees his own week only; the board
 * stays for the Super Admin, and answers a Driver as absent unless
 * DRIVER_PERFORMANCE_BOARD_ENABLED is exactly "true"; the Super Admin's page
 * shows each driver his own answer, by name. The sections on the
 * board for drivers run in a world with that flag on, to keep the dormant
 * code honest; every other section runs in the state a deploy gets.
 *
 * WHAT IS REAL. The rules module as shipped. For the routes, server.js's own
 * `driverPerformance` declaration is lifted with everything it uses
 * (scripts/lib/server-lift.js closure(): requireRole, getWeekRange, the weekly
 * invoice's column and verdict rules, the cancelled/deleted filter, the
 * driver-at-a-truck resolver) and mounted on a real Express app on 127.0.0.1
 * port 0, over an in-memory SQLite whose tables come from server.js's own DDL.
 * Job Tracking is a stub serving made-up rows through server.js's own
 * parseSheet() and deduplicateLoads(). The session is a header the test sets.
 * "Today" is Wed 2026-11-11 (noon Eastern). Every name, unit and load is made up.
 *
 * §1  D's open answers are one-line constants in one place (Q-A1 weights,
 *     Q-A2 who's in, Q-A3 view), at the plan's defaults; the rules are pure
 * §2  periods: "week" is this week and last week (Sat-Fri, getWeekRange),
 *     "month" the calendar month; no future day counts
 * §3  load credits: a pickup 0.5 and a delivery 0.5, so a load is 1; an ELD
 *     truck's pickup needs a geofence or ELD departure, a tap counts only
 *     without a reporting ELD (14-day lookback)
 * §4  the REI: each half capped, unrounded qualifying, rounded down, never
 *     100.0 unless met, null without hours
 * §5  credited hours: 11 h a day at most; no data is null, never 0
 * §6  pacing: today's share, feasibility, the words, the 8.5 h guide, null
 *     without hours
 * §7  Eastern bucketing: a Central and a Pacific driver's Friday night
 * §8  ranking: ties share the place, null is "not ranked" (never 0), order
 * §9  labels: one plain form ("LogisX-#101" reads "#101"), only a unit shape
 *     passes; most days, ties to the later unit; handovers "#703 (1)"/"(2)",
 *     dates only on the driver's own row
 * §10 the driver projection: exact keys, byte-identical not-ranked rows
 *     whatever the reason, no figure on the safety board, top 3 plus "you"
 * §11 who's in: active company drivers on a day rate; test units
 * §12 the flag: on when unset, empty or "true"; off ("false", "FALSE", "0", "no",
 *     " Off "), every route is 404 FEATURE_OFF for every caller, signed out
 *     included. Every later section runs with it unset, the state a deploy gets
 * §13 roles: own week Driver only; board Driver (flag on) and Super Admin;
 *     report Super Admin only. With the flag on: a driver off the board by rule,
 *     or on none of its three boards (this week, last week, this month), is the
 *     same 404 NOT_ELIGIBLE; a driver on at least one keeps the board, with no
 *     "you" on a board without him
 * §14 the board over HTTP (flag on): "Most loads" equals the weekly invoice's own
 *     count per driver, this week, last week and the month; keys, labels, no
 *     names, "you" per request, coming-soon categories
 * §15 the driver's own week over HTTP: credits by source; what's left, the bar's
 *     percent, the label and the counted loads; no hours, REI, gap or "out of
 *     reach" anywhere in the answer
 * §16 the Super Admin report: names, reasons, sources, hours "estimate, not
 *     checked"; bad period 400; Job Tracking down 503
 * §17 wiring: one declaration above app.get("*"), the flags' exact shapes, the
 *     replica's rules
 * §18 a stored unit that isn't a unit: a name, phone or load number in
 *     trucks.unit_number never reaches a driver; the row keeps its rank and
 *     count under the neutral label; the Super Admin report names the truck
 * §19 pacing on loads alone: one constant; each day of a Sat-Fri week; a rest
 *     weekend never reads Needs Focus; the target met always reads Ahead of Pace
 * §20 his target and his week: 1.5 less per approved day off, not below 4.5; what's
 *     required, 1.5 below that, unless time off makes it impossible for the week; the
 *     bar's percent rounded down and capped; what's left; no label on a week he
 *     can't act on; "a new week starts" when more is left than the days hold
 * §21 the board is absent to drivers: the kill switch's own 404, whoever asks and
 *     however; no read; the Super Admin's board and report don't change
 * §22 who gets his own week: active, held a countable truck or has a counted load
 *     this week or last; a percentage driver yes; pending, owner-operator, not in
 *     the directory and nothing to show no, with no word why
 * §23 privacy: only his rows, from the session, never another driver's load,
 *     name, unit, rank or figure; exactly three keys on a row; no broker, rate,
 *     lane or pay; two drivers asking at once never see each other's rows
 * §24 approved days off over HTTP: approved only, the flag off reads nothing;
 *     the server flags a lowered target, on the open week only
 * §25 what became of a pickup, true whichever way it was made, an older tap on a
 *     truck with no ELD included; his answer says nothing of how he is paid
 * §26 the count's weights: which of the office's figures they move, and that no
 *     pay, invoice, ledger or payout path reads them
 * §27 a load on two sheet rows: its deliveries count as the weekly invoice counts
 *     them, against the invoice's own selector over every row; its pickup credit
 *     stays as the live count reads it; the shared read stays what it was
 * §28 a handover: a credit moves only with the first driver's own word on the load
 *     since its last cancel: an accept from no staff session, or a tap forward with
 *     a Driver role on record. A tap with no role, a tap back, a geofence row alone, a
 *     stored ELD departure or a dispatcher's tap never moves one, and a later stored
 *     departure on a truck the first driver didn't hold, or a later In Transit row
 *     naming someone else and not off a later stage, keeps it as live; a moved
 *     credit's row names no one and no contact, however many numbers its ID holds
 * §29 a status moved back: gone only where the record says so; a blank status isn't
 *     back; a tap back is the departing driver's own only with a Driver role on record;
 *     neither that nor a tap with no role moves a credit across a week
 * §30 what doesn't change: each as-live shape, and made-up sheets checked against
 *     the invoice's own selector; each driver's answer is his own; nothing that
 *     pays reads the kept rows; the proof on its own
 * §31 Past Performance over HTTP: his past weeks from the first counted week
 *     only, newest first, and only the weeks that were his; the date of the
 *     "weren't counted" line; this week and last as before; the Loads bar's color
 *     from the server, a case per band (3.5 red, 5.5 orange, 6 green, 8 blue);
 *     with the hours switch off, no hours anywhere and nothing reads the daily
 *     ELD activity rollup's table
 * §32 driving hours with DRIVER_PERFORMANCE_HOURS_ENABLED exactly "true" (made-up
 *     rollup rows): each past week's minutes summed into hours; a truck with no
 *     hours data, and a week with none, named, never 0; a week from before the
 *     rollup's first day says when it starts; another driver's rows never in his;
 *     a failed read leaves the rest; off unless exactly "true", and with the
 *     rollup off too
 * §33 the Super Admin's drivers' weeks (GET /api/admin/driver-performance/weeks):
 *     the switch, then the role, then the limit; each driver's answer is
 *     byte for byte the one his own route gives him (off days, an open load, a
 *     week at 0, his past weeks, and his hours with their switch on); exactly
 *     the drivers his own route's test lets in, an owner-operator known only by
 *     his account left out; this week's credits, highest first, then the name;
 *     the unit as this week's board labels it; this week's drivers off the board
 *     with the reason, as the admin report has them; names and figures only;
 *     with the hours switch off no hours and no read of the rollup's table
 *
 * Hermetic: :memory: SQLite, port 0, no network beyond 127.0.0.1.
 * Run: node scripts/test-driver-performance.js    # exits 1 on failure
 */
"use strict";

process.env.APP_TIMEZONE = "America/New_York";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");

let pass = 0;
const failures = [];
function ok(cond, name, detail) {
	if (cond) { pass++; console.log(`ok   ${name}`); return; }
	failures.push(name);
	console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
}
function eq(actual, expected, name) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	ok(a === e, name, `got ${a}, want ${e}`);
}
// A section that throws (a module missing on the base) fails by name, and the
// sections after it still run.
async function section(title, fn) {
	console.log(`\n§ ${title}`);
	try {
		await fn();
	} catch (err) {
		ok(false, `${title}: ran to the end`, (err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : String(err)));
	}
}

let perf = null;
try { perf = require(path.join(ROOT, "lib", "driver-performance.js")); } catch (e) { perf = null; }
const need = () => { if (!perf) throw new Error("lib/driver-performance.js did not load"); return perf; };

const DAY = 86400000;
const NOW_MS = Date.parse("2026-11-11T17:00:00Z");

// ── made-up fleet ──────────────────────────────────────────────────────────
const DRIVERS = [
	{ id: 1, name: "Ada Quill", status: "active", pay_type: "fixed", user_id: 11 },
	{ id: 2, name: "Ben Marsh", status: "active", pay_type: "fixed", user_id: 12 },
	{ id: 3, name: "Cal Reyes", status: "active", pay_type: "fixed", user_id: 13 },
	{ id: 4, name: "Dee Stone", status: "active", pay_type: "fixed", user_id: 14 },
	{ id: 5, name: "Eli North", status: "active", pay_type: "percentage", user_id: 15 },
	{ id: 6, name: "Fay Owens", status: "active", pay_type: "fixed", user_id: 16 },
	{ id: 7, name: "Gus Pike", status: "pending", pay_type: "fixed", user_id: 17 },
	{ id: 8, name: "Hal Briar", status: "active", pay_type: "fixed", user_id: 18 },
	{ id: 9, name: "Jo Tester", status: "active", pay_type: "fixed", user_id: 19 },
	{ id: 10, name: "Kim Vale", status: "active", pay_type: "fixed", user_id: 20 },
	{ id: 11, name: "Ivy Lane", status: "active", pay_type: "fixed", user_id: 22 },
];
const ALL_NAMES = [...DRIVERS.map((d) => d.name), "Lou Grant"];
const TRUCKS = [
	// The fleet's real spelling with made-up numbers, so a stored prefix can't hide behind bare ones.
	{ id: 1, unit: "LogisX-#501", retired_at: "" },
	{ id: 2, unit: "Logisx-#502", retired_at: "" },
	{ id: 3, unit: "LogisX-#503", retired_at: "" },
	{ id: 4, unit: "LogisX-#504", retired_at: "" },
	{ id: 5, unit: "Logisx-#505", retired_at: "" },
	{ id: 6, unit: "LogisX-#506", retired_at: "" },
	{ id: 7, unit: "LogisX-TEST", retired_at: "" },
	{ id: 9, unit: "LogisX-#509", retired_at: "2026-10" },
];
const ASSIGNMENTS = [
	{ truck: 1, driver: "Ada Quill", start: "2026-10-01T12:00:00.000Z", end: "" },
	{ truck: 2, driver: "Ben Marsh", start: "2026-10-01T12:00:00.000Z", end: "" },
	{ truck: 3, driver: "Cal Reyes", start: "2026-10-01T12:00:00.000Z", end: "" },
	{ truck: 4, driver: "Dee Stone", start: "2026-10-01T12:00:00.000Z", end: "2026-11-10T15:00:00.000Z" },
	{ truck: 4, driver: "Hal Briar", start: "2026-11-10T15:00:00.000Z", end: "" },
	{ truck: 5, driver: "Eli North", start: "2026-10-01T12:00:00.000Z", end: "" },
	{ truck: 6, driver: "Fay Owens", start: "2026-10-01T12:00:00.000Z", end: "" },
	{ truck: 7, driver: "Jo Tester", start: "2026-10-01T12:00:00.000Z", end: "" },
	{ truck: 9, driver: "Kim Vale", start: "2026-10-01T12:00:00.000Z", end: "" },
];
const HEADERS = ["Load ID", "Driver", "Job Status", "Pickup Appointment", "Drop-off Appointment", "Assigned Date", "Status Update Date", "Completion Date", "Truck", "Broker", "Rate", "Driver Pay", "Pickup Location", "Phone Number"];
// Every row holds these, so an answer that copied a cell it shouldn't would show one.
const DECOY_CELLS = Object.freeze({ Broker: "Decoy Freight LLC", Rate: "4321.09", "Driver Pay": "987.65", "Pickup Location": "Decoyville, TX 75001" });
const DECOY_CELL_MARKS = ["Decoy", "4321", "987.65", "75001"];
// [load, driver, status, status update date]
const LOADS = [
	["DP-1001", "Ada Quill", "Delivered", "2026-11-09 14:20"],
	["DP-1002", "Ada Quill", "Delivered", "11/10/2026 9:15 AM"],
	["DP-1003", "Ada Quill", "In Transit", ""],
	["#DP-1004", "Ada Quill", "Delivered", "2026-11-09 18:00"],
	["DP-1004", "Ada Quill", "Delivered", "2026-11-09 18:00"],
	["DP-1005", "Ada Quill", "Cancelled", "2026-11-09 10:00"],
	["DP-1006", "Ada Quill", "Delivered", "2026-11-10 10:00"],
	["DP-1007", "Ada Quill", "Delivered", ""],
	["DP-1008", "Ada Quill", "Delivered", "2026-11-05 20:15"],
	["DP-1009", "Ada  Quill", "Delivered", "Fri, 06 Nov 2026 22:30:00 -0600"],
	["DP-1010", "Ada Quill", "In Transit", ""],
	["DP-1011", "Ada Quill", "At Receiver", ""],
	["DP-1012", "Ada Quill", "Delivered", "2026-10-30 11:00"],
	["DP-2001", "Ben Marsh", "Delivered", "2026-11-09 16:00"],
	["DP-2002", "Ben Marsh", "In Transit", ""],
	["DP-2003", "Ben Marsh", "POD Received", "2026-11-10 12:00"],
	["DP-3001", "Cal Reyes", "In Transit", ""],
	["DP-3002", "Cal Reyes", "Delivered", "2026-11-10 08:00"],
	["DP-4001", "Dee Stone", "Delivered", "2026-11-08 13:00"],
	["DP-4002", "Hal Briar", "Delivered", "2026-11-10 19:00"],
	["DP-4003", "Hal Briar", "Delivered", "2026-11-11 09:00"],
	["DP-4004", "Dee Stone", "Delivered", "2026-11-03 09:00"],
	["DP-5001", "Eli North", "Delivered", "2026-11-09 09:00"],
	["DP-5002", "Eli North", "Delivered", "2026-11-09 11:00"],
	["DP-5003", "Eli North", "Delivered", "2026-11-10 11:00"],
	["DP-5004", "Eli North", "Delivered", "2026-11-10 15:00"],
	["DP-6001", "Fay Owens", "Delivered", "2026-11-09 09:00"],
	["DP-7001", "Jo Tester", "Delivered", "2026-11-09 09:00"],
	["DP-7002", "Kim Vale", "Delivered", "2026-11-09 09:00"],
	["DP-9001", "Lou Grant", "Delivered", "2026-11-09 09:00"],
];
const DELETED = ["#DP-1006"];
// [load, source, new status, changed_at (UTC, SQLite text)]
const HISTORY = [
	["dp-1001", "geofence", "In Transit", "2026-11-08 15:00:00"],
	["dp-1001", "manual", "In Transit", "2026-11-06 15:00:00"],
	["dp-1003", "manual", "In Transit", "2026-11-10 14:00:00"],
	["dp-1010", "geofence", "In Transit", "2026-11-07 05:30:00"],
	["dp-1011", "geofence", "In Transit", "2026-11-07 04:30:00"],
	["dp-2001", "manual", "In Transit", "2026-11-08 13:00:00"],
	["dp-2002", "override", "In Transit", "2026-11-10 16:00:00"],
	["dp-3001", "manual", "In Transit", "2026-11-09 17:00:00"],
	["dp-1005", "geofence", "In Transit", "2026-11-08 12:00:00"],
];
const ELD_DEPARTS = [["dp-1002", Date.parse("2026-11-09T13:00:00Z")]];
// truck id -> days its ELD reported (eld_miles_daily rows with samples)
const ELD_DAYS = { 1: ["2026-11-01", "2026-11-05", "2026-11-09", "2026-11-10"], 3: ["2026-10-20"] };

const USERS = {
	ada: { id: 11, role: "Driver", username: "ada", driverName: "Ada Quill" },
	ben: { id: 12, role: "Driver", username: "ben", driverName: "Ben Marsh" },
	cal: { id: 13, role: "Driver", username: "cal", driverName: "Cal Reyes" },
	dee: { id: 14, role: "Driver", username: "dee", driverName: "Dee  Stone" },
	eli: { id: 15, role: "Driver", username: "eli", driverName: "Eli North" },
	fay: { id: 16, role: "Driver", username: "fay", driverName: "Fay Owens" },
	gus: { id: 17, role: "Driver", username: "gus", driverName: "Gus Pike" },
	hal: { id: 18, role: "Driver", username: "hal", driverName: "Hal Briar" },
	jo: { id: 19, role: "Driver", username: "jo", driverName: "Jo Tester" },
	kim: { id: 20, role: "Driver", username: "kim", driverName: "Kim Vale" },
	nobody: { id: 21, role: "Driver", username: "nobody", driverName: "Ned Nobody" },
	ivy: { id: 22, role: "Driver", username: "ivy", driverName: "Ivy Lane" },
	nia: { id: 61, role: "Driver", username: "nia", driverName: "Nia Frost" },
	omar: { id: 62, role: "Driver", username: "omar", driverName: "Omar Hale" },
	admin: { id: 31, role: "Super Admin", username: "admin" },
	admin2: { id: 32, role: "Super Admin", username: "admin2" },
	dispatcher: { id: 41, role: "Dispatcher", username: "disp" },
	investor: { id: 51, role: "Investor", username: "inv" },
};

// ── the server.js world ────────────────────────────────────────────────────
let SRC = null;
let LIFT = null;
function lifted() {
	if (LIFT) return LIFT;
	SRC = require("./lib/server-source").serverSource();
	const { closure } = require("./lib/server-lift");
	LIFT = closure(SRC, {
		roots: ["driverPerformance", "parseSheet", "deduplicateLoads", "selectInvoiceWeekLoads"],
		provided: ["app", "db", "getJobTrackingCached"],
		denied: ["server", "transporter", "getDrive", "getSheets", "sendEmail"],
	});
	return LIFT;
}

// server.js's own getWeekRange() (Sat-Fri on the business calendar), alone.
function liftedGetWeekRange() {
	if (!SRC) SRC = require("./lib/server-source").serverSource();
	const { closure } = require("./lib/server-lift");
	const l = closure(SRC, { roots: ["getWeekRange"] });
	return new Function("require", `"use strict";\n${l.text}\nreturn getWeekRange;`)(createRequire(path.join(ROOT, "server.js")));
}

function tableDdl(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) throw new Error(`could not locate CREATE TABLE ${name}`);
	return `CREATE TABLE ${name} (${m[1]}\n)`;
}

function sheetValues(extraLoads = []) {
	const head = HEADERS;
	return [head, ...[...LOADS, ...extraLoads].map(([id, driver, status, done, phone]) => head.map((h) => (
		h === "Load ID" ? id : h === "Driver" ? driver : h === "Job Status" ? status : h === "Status Update Date" ? done : h === "Phone Number" ? phone || "" : DECOY_CELLS[h] || ""
	)))];
}

function makeDb() {
	const Database = require("better-sqlite3");
	const db = new Database(":memory:");
	for (const t of ["drivers_directory", "trucks", "truck_assignments", "load_status_history", "load_eld_miles", "eld_miles_daily", "deleted_loads", "driver_availability", "users"]) db.exec(tableDdl(t));
	db.exec("ALTER TABLE drivers_directory ADD COLUMN status TEXT DEFAULT 'active'");
	db.exec("ALTER TABLE drivers_directory ADD COLUMN pay_type TEXT DEFAULT 'fixed'");
	db.exec("ALTER TABLE trucks ADD COLUMN retired_at TEXT DEFAULT ''");
	db.exec("ALTER TABLE load_status_history ADD COLUMN actor_role TEXT DEFAULT ''");
	db.exec(require(path.join(ROOT, "lib", "owner-operator.js")).OO_SCHEMA_SQL);
	const dir = db.prepare("INSERT INTO drivers_directory (id, driver_name, status, pay_type, user_id) VALUES (?, ?, ?, ?, ?)");
	for (const d of DRIVERS) dir.run(d.id, d.name, d.status, d.pay_type, d.user_id);
	const tr = db.prepare("INSERT INTO trucks (id, unit_number, retired_at) VALUES (?, ?, ?)");
	for (const t of TRUCKS) tr.run(t.id, t.unit, t.retired_at);
	const ta = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, ?, ?)");
	for (const a of ASSIGNMENTS) ta.run(a.truck, a.driver, a.start, a.end);
	const lsh = db.prepare("INSERT INTO load_status_history (load_id, source, new_status, changed_at) VALUES (?, ?, ?, ?)");
	for (const h of HISTORY) lsh.run(...h);
	const lem = db.prepare("INSERT INTO load_eld_miles (load_id, pickup_depart_ms) VALUES (?, ?)");
	for (const e of ELD_DEPARTS) lem.run(...e);
	const emd = db.prepare("INSERT INTO eld_miles_daily (routemate_vehicle_id, local_day, truck_id, miles, samples) VALUES (?, ?, ?, 100, 40)");
	for (const [truckId, days] of Object.entries(ELD_DAYS)) for (const day of days) emd.run(`rm-${truckId}`, day, Number(truckId));
	const del = db.prepare("INSERT INTO deleted_loads (load_id) VALUES (?)");
	for (const id of DELETED) del.run(id.toLowerCase());
	db.prepare("INSERT INTO owner_operators (user_id, status, created_at) VALUES (16, 'active', '2026-10-01T12:00:00Z')").run();
	// Each made-up account, as its session names its driver.
	const acct = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name, email) VALUES (?, ?, 'made-up', ?, ?, ?)");
	for (const u of Object.values(USERS)) acct.run(u.id, u.username, u.role, u.driverName || "", `${u.username}@example.test`);
	return db;
}

function fixedDateAt(ms) {
	return class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [ms])); }
		static now() { return ms; }
	};
}

// One world: a real Express app with the lifted declaration mounted on it.
async function makeWorld(env, { nowMs = NOW_MS, extraLoads = [] } = {}) {
	const express = require("express");
	const lift = lifted();
	const app = express();
	app.use((req, res, next) => {
		const raw = req.headers["x-test-user"];
		req.session = raw ? { user: JSON.parse(raw) } : {};
		next();
	});
	const db = makeDb();
	const world = { db, sheetDown: false, sheetReads: 0, logs: [] };
	const quiet = { log: (...a) => world.logs.push(a.join(" ")), info() {}, warn() {}, error() {} };
	const deps = {
		app, db, require: createRequire(path.join(ROOT, "server.js")), console: quiet,
		process: { env: { ...env }, argv: [], cwd: () => ROOT }, __dirname: ROOT, Date: fixedDateAt(nowMs),
		getJobTrackingCached: async () => {
			world.sheetReads += 1;
			if (world.sheetDown) throw new Error("made-up outage");
			if (!world.jt) {
				world.jt = world.fns.parseSheet({ values: sheetValues(world.extraLoads) });
				if (world.fns.keepEveryRow) world.fns.keepEveryRow(world.jt, world.jt.data);
				world.jt.data = world.fns.deduplicateLoads(world.jt.data, world.jt.headers);
			}
			return world.jt;
		},
	};
	world.extraLoads = extraLoads;
	const body = ['"use strict";', lift.text,
		"return { driverPerformance, parseSheet, deduplicateLoads, selectInvoiceWeekLoads, loadKeySet, getDeletedLoadIds, getWeekRange,",
		"\tkeepEveryRow: typeof keepEveryRow === \"function\" ? keepEveryRow : null, everyJobTrackingRow: typeof everyJobTrackingRow === \"function\" ? everyJobTrackingRow : null };"].join("\n");
	// The routes module logs its start-up line on the real console: keep it.
	const realLog = console.log;
	console.log = (...a) => world.logs.push(a.join(" "));
	try {
		world.fns = new Function(...Object.keys(deps), body)(...Object.values(deps));
	} finally {
		console.log = realLog;
	}
	world.handle = world.fns.driverPerformance;
	await new Promise((resolve) => { world.server = app.listen(0, "127.0.0.1", resolve); });
	world.port = world.server.address().port;
	world.get = (p, user, extra) => new Promise((resolve, reject) => {
		const headers = { ...(user ? { "x-test-user": JSON.stringify(user) } : {}), ...(extra || {}) };
		http.get({ host: "127.0.0.1", port: world.port, path: p, headers }, (res) => {
			let buf = "";
			res.setEncoding("utf8");
			res.on("data", (c) => { buf += c; });
			res.on("end", () => {
				let json = null;
				try { json = JSON.parse(buf); } catch { json = null; }
				resolve({ status: res.statusCode, json, text: buf, headers: res.headers });
			});
		}).on("error", reject);
	});
	world.close = () => new Promise((resolve) => world.server.close(resolve));
	return world;
}

function allKeys(v, out = []) {
	if (Array.isArray(v)) { for (const x of v) allKeys(x, out); return out; }
	if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); allKeys(x, out); }
	return out;
}
const sortedKeys = (o) => Object.keys(o || {}).sort();

(async () => {
	// ── §1 ──────────────────────────────────────────────────────────────────
	await section("1 D's open answers, one place, at the defaults; pure rules", () => {
		const p = need();
		const src = fs.readFileSync(path.join(ROOT, "lib", "driver-performance.js"), "utf8");
		const one = (re) => (src.match(re) || []).length;
		eq(p.CREDIT_WEIGHTS, { delivery: 0.5, pickup: 0.5 }, "Q-A1: a pickup earns 0.5 and a delivery 0.5");
		eq(p.WHO_IS_IN, "company-day-rate", "Q-A2: company drivers on a day rate");
		eq(p.BOARD_VIEW, "full", "Q-A3: the full list by unit");
		ok(one(/^const CREDIT_WEIGHTS = Object\.freeze\(\{ delivery: 0\.5, pickup: 0\.5 \}\);$/gm) === 1, "Q-A1 is one line, declared once");
		ok(one(/^const WHO_IS_IN = "company-day-rate";$/gm) === 1 && one(/\bWHO_IS_IN =/g) === 1, "Q-A2 is one line, declared once");
		ok(one(/^const BOARD_VIEW = "full";$/gm) === 1 && one(/\bBOARD_VIEW =/g) === 1, "Q-A3 is one line, declared once");
		const routes = fs.readFileSync(path.join(ROOT, "lib", "driver-performance-routes.js"), "utf8");
		ok(!/delivery:\s*\d|pickup:\s*\d|"company-day-rate"|"top3-you"|"full"|creditsPerDay|aheadBy/.test(routes), "the routes restate none of D's answers");
		ok(one(/^const LOADS_PACE = Object\.freeze\(/gm) === 1 && one(/\bLOADS_PACE =/g) === 1, "the pacing reading is one constant, declared once");
		eq([...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]), ["./app-time"], "the rules module requires nothing but ./app-time");
	});

	// ── §2 ──────────────────────────────────────────────────────────────────
	await section("2 periods", () => {
		const p = need();
		const weekRange = liftedGetWeekRange();
		eq(p.boardPeriods("week", "2026-11-11", weekRange), [
			{ id: "this-week", start: "2026-11-07", end: "2026-11-13", lastDay: "2026-11-11" },
			{ id: "last-week", start: "2026-10-31", end: "2026-11-06", lastDay: "2026-11-06" },
		], "week: this week (to today) and last week, Sat-Fri");
		eq(p.boardPeriods("week", "2026-11-07", weekRange)[1], { id: "last-week", start: "2026-10-31", end: "2026-11-06", lastDay: "2026-11-06" },
			"on a Saturday the board still has last week's full week");
		eq(p.boardPeriods("week", "2026-11-07", weekRange)[0].lastDay, "2026-11-07", "on a Saturday this week runs to today only");
		eq(p.boardPeriods("month", "2026-11-11", weekRange), [{ id: "this-month", start: "2026-11-01", end: "2026-11-30", lastDay: "2026-11-11" }], "month: the calendar month, to today");
		eq(p.boardPeriods("month", "2028-02-10", weekRange)[0].end, "2028-02-29", "a leap February ends on the 29th");
		eq(p.boardPeriods("year", "2026-11-11", weekRange), null, "any other kind has no periods");
		eq(p.daysBetween("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"], "days run across a month end");
	});

	// ── §3 ──────────────────────────────────────────────────────────────────
	await section("3 load credits", () => {
		const p = need();
		eq(p.loadCredits(1, 1), 1, "one load, picked up and delivered, is 1");
		eq([p.loadCredits(1, 0), p.loadCredits(0, 1)], [0.5, 0.5], "a delivery alone is 0.5, and so is a pickup alone");
		eq(p.loadCredits(1, 2), p.DAILY_CREDITS_GUIDE, "a pickup, a drop-off and the next pickup are the day's 1.5");
		eq(p.loadCredits(8, 7), p.CREDIT_TARGET, "8 delivered and 7 picked up is the 7.5 target");
		eq(p.loadCredits(5, 5), 5, "5 loads picked up and delivered are 5, not the target");
		eq(p.loadCredits(3, 1), 2, "3 deliveries and 1 pickup earn 2");
		eq(p.pickupEvidence({ geofenceMs: 1000, eldDepartMs: 2000, tapMs: 500, tapSource: "driver", truckHasEld: true }), { ms: 1000, source: "geofence" },
			"the geofence departure wins over the ELD replay and any tap");
		eq(p.pickupEvidence({ eldDepartMs: 2000, tapMs: 500, tapSource: "driver", truckHasEld: true }), { ms: 2000, source: "eld" }, "without a geofence row, the ELD replay");
		eq(p.pickupEvidence({ tapMs: 500, tapSource: "driver", truckHasEld: true }), null, "a tap on a truck with a reporting ELD earns nothing");
		eq(p.pickupEvidence({ tapMs: 500, tapSource: "driver", truckHasEld: false }), { ms: 500, source: "driver" }, "a driver's tap counts on a truck without an ELD");
		eq(p.pickupEvidence({ tapMs: 500, tapSource: "dispatch", truckHasEld: false }), { ms: 500, source: "dispatch" }, "so does a dispatcher's");
		eq(p.pickupEvidence({}), null, "no evidence, no credit");
		const days = new Set(["2026-10-27"]);
		ok(p.eldReportingOn(days, "2026-11-09"), "an ELD that reported 13 days back is reporting");
		ok(!p.eldReportingOn(days, "2026-11-10"), "one silent for 14 days is not");
		ok(!p.eldReportingOn(new Set(), "2026-11-10") && !p.eldReportingOn(undefined, "2026-11-10"), "a truck with no ELD days has no ELD");
		eq(p.ELD_REPORTING_LOOKBACK_DAYS, 14, "the lookback is 14 days");
	});

	// ── §4 ──────────────────────────────────────────────────────────────────
	await section("4 the Run Efficiency Index", () => {
		const p = need();
		eq(p.rei(7.5, 42.5), 100, "both targets: 100");
		eq(p.rei(15, 0), 50, "double the loads and no hours: 50, not 100 (each half capped)");
		eq(p.rei(0, 80), 50, "double the hours and no loads: 50");
		eq(p.rei(3.75, 21.25), 50, "half of each: 50");
		eq(p.rei(5, null), null, "no hours data: no REI");
		ok(!p.weekMet(7.5, 42.47) && p.weekMet(7.5, 42.5) && !p.weekMet(7, 50), "met only when both unrounded values reach the targets");
		ok(!p.weekMet(7.5, null), "never met without hours data");
		const nearly = p.rei(7.5, 42.47);
		eq(p.reiDisplay(nearly, p.weekMet(7.5, 42.47)), 99.9, "42.47 h reads 99.9%, never 100.0");
		eq(p.reiDisplay(p.rei(7.5, 42.5), true), 100, "a met week reads 100");
		const hair = 42.5 - 1e-9;
		eq(p.reiDisplay(p.rei(7.5, hair), p.weekMet(7.5, hair)), 99.9, "a hair under the hours target is unmet and still reads 99.9, not 100.0");
		eq(p.reiDisplay(100, false), 99.9, "an unmet week never reads 100.0");
		eq(p.reiDisplay(87.39, false), 87.3, "rounded down, not to nearest");
		eq(p.reiDisplay(87.3, false), 87.3, "a value at one decimal stays itself");
		eq(p.reiDisplay(null, false), null, "no REI, no display");
	});

	// ── §5 ──────────────────────────────────────────────────────────────────
	await section("5 credited hours", () => {
		const p = need();
		eq(p.creditedHours([12, 8, 14.5]), 30, "each day caps at 11 (11 + 8 + 11)");
		eq(p.creditedHours([11, 11]), 22, "11 exactly is kept");
		eq(p.creditedHours([null, 6, undefined]), 6, "days without data add nothing");
		eq(p.creditedHours([null, null]), null, "a week with no data is null, never 0");
		eq(p.creditedHours([0, 0]), 0, "a measured zero stays 0");
		eq(p.DAILY_HOURS_CAP, 11, "the cap is the 11-hour driving limit");
	});

	// ── §6 ──────────────────────────────────────────────────────────────────
	await section("6 pacing", () => {
		const p = need();
		const base = { completedWorkedDays: 2, todayHours: 4.25, calendarDaysLeft: 3, approvedDaysOff: 0 };
		const a = p.pace({ ...base, credits: 3, hours: 17 });
		eq(Math.round(a.expected * 100) / 100, 50, "expected = (2 worked + half of today) / 5 = 50");
		eq(a.word, "on-track", "REI 40 against 50 expected is On Track");
		const noToday = p.pace({ ...base, todayHours: 0, credits: 3, hours: 17 });
		eq(noToday.expected, 40, "no driving yet today: 40, so the figure rises through the day");
		eq(p.pace({ ...base, credits: 7.5, hours: 30 }).word, "ahead", "REI 85.3 against 50 is Ahead of Pace");
		eq(p.pace({ ...base, credits: 3.75, hours: 25.5 }).word, "on-track", "REI 55 against 50 is On Track: Ahead needs 10 points more");
		eq(p.pace({ ...base, credits: 4.5, hours: 25.5 }).word, "ahead", "REI 60 against 50 is Ahead of Pace, the band's edge");
		eq(p.pace({ completedWorkedDays: 1, todayHours: 8.5, calendarDaysLeft: 5, approvedDaysOff: 0, credits: 1.5, hours: 8.5 }).word, "needs-focus",
			"REI 20 against 40 expected, still reachable (6 credits, 34 h over 4 days), is Needs Focus");
		const far = p.pace({ completedWorkedDays: 4, todayHours: 0, calendarDaysLeft: 1, approvedDaysOff: 0, credits: 3, hours: 20 });
		eq([far.word, far.reachable, far.gap], ["out-of-reach", false, null], "22.5 h left in one day needs more than 8.5: out of reach, no gap text");
		const sat = p.pace({ completedWorkedDays: 0, todayHours: 0, calendarDaysLeft: 7, approvedDaysOff: 0, credits: 0, hours: 0 });
		ok(sat.reachable, "a fresh week is reachable");
		const satOut = p.pace({ completedWorkedDays: 0, todayHours: 0, calendarDaysLeft: 4, approvedDaysOff: 0, credits: 0, hours: 0 });
		ok(!satOut.reachable, "sitting out early days: 4 calendar days can't hold 42.5 h at 8.5 a day");
		const capped = p.pace({ completedWorkedDays: 3, todayHours: 0, calendarDaysLeft: 4, approvedDaysOff: 0, credits: 4.5, hours: 25.5 });
		eq(capped.word, "on-track", "days left never exceed the target days not yet worked (2 days, 17 h at 8.5)");
		const cappedOut = p.pace({ completedWorkedDays: 3, todayHours: 0, calendarDaysLeft: 4, approvedDaysOff: 0, credits: 4.5, hours: 25 });
		eq(cappedOut.word, "out-of-reach", "17.5 h over 2 days asks for more than 8.5 a day: out of reach");
		eq(capped.gap, { credits: 3, hours: 17 }, "the gap: credits and hours left");
		eq(p.pace({ ...base, credits: 3, hours: null }), null, "no hours data: no pace at all");
		const off = p.pace({ completedWorkedDays: 2, todayHours: 0, calendarDaysLeft: 3, approvedDaysOff: 2, credits: 3, hours: 17 });
		eq(Math.round(off.expected * 1e6) / 1e6, 66.666667, "approved days off lower the target days (2 worked of 5 - 2)");
	});

	// ── §7 ──────────────────────────────────────────────────────────────────
	await section("7 Eastern bucketing of a Friday night", () => {
		const p = need();
		const central = Date.parse("2026-11-14T04:30:00Z"); // Fri Nov 13 22:30 CST = 23:30 EST
		const pacific = Date.parse("2026-11-14T05:30:00Z"); // Fri Nov 13 21:30 PST = Sat 00:30 EST
		eq(p.businessDayOf(central), "2026-11-13", "a Central driver's Friday 10:30 PM is Friday in the business week");
		eq(p.businessDayOf(pacific), "2026-11-14", "a Pacific driver's Friday 9:30 PM is already Saturday Eastern: next week");
		eq(p.businessDayOf(Date.parse("2026-07-11T03:30:00Z")), "2026-07-10", "summer time: 11:30 PM EDT Friday stays Friday");
		eq(p.businessDayOf(0), "", "no instant, no day");
	});

	// ── §8 ──────────────────────────────────────────────────────────────────
	await section("8 ranking", () => {
		const p = need();
		const loads = p.categoryById("most-loads");
		const ranked = p.rankEntries(loads, [
			{ driverId: 1, label: "#703", value: 4 },
			{ driverId: 2, label: "#702", value: 6 },
			{ driverId: 3, label: "#701", value: 4 },
			{ driverId: 4, label: "#705", value: null },
			{ driverId: 5, label: "#706", value: 0 },
			{ driverId: 6, label: "#704", value: undefined },
		]);
		eq(ranked.map((e) => [e.label, e.rank, e.value]), [
			["#702", 1, 6], ["#701", 2, 4], ["#703", 2, 4], ["#706", 4, 0], ["#704", null, null], ["#705", null, null],
		], "ties share the place (1, 2, 2, 4) and sort by unit; 0 is ranked; null is not ranked, never 0, and sorts last by unit");
		const fuel = p.categoryById("least-fuel-cost");
		eq(p.rankEntries(fuel, [{ driverId: 1, label: "#1", value: 0.7 }, { driverId: 2, label: "#2", value: 0.55 }]).map((e) => e.label), ["#2", "#1"],
			"lower is better where the category says so");
	});

	// ── §9 ──────────────────────────────────────────────────────────────────
	await section("9 unit labels", () => {
		const p = need();
		eq(p.chooseUnit([
			{ truckId: 1, unit: "LogisX-#703", days: 3, firstDay: "2026-11-07", lastDay: "2026-11-09" },
			{ truckId: 2, unit: "LogisX-#702", days: 4, firstDay: "2026-11-10", lastDay: "2026-11-13" },
		]).unit, "LogisX-#702", "the unit held on the most days");
		eq(p.chooseUnit([
			{ truckId: 2, unit: "LogisX-#702", days: 3, firstDay: "2026-11-11", lastDay: "2026-11-13" },
			{ truckId: 1, unit: "LogisX-#703", days: 3, firstDay: "2026-11-07", lastDay: "2026-11-09" },
		]).unit, "LogisX-#702", "a tie goes to the unit held later");
		eq(p.chooseUnit([
			{ truckId: 1, unit: "LogisX-#703", days: 3, firstDay: "2026-11-07", lastDay: "2026-11-09" },
			{ truckId: 2, unit: "LogisX-#702", days: 3, firstDay: "2026-11-11", lastDay: "2026-11-13" },
		]).unit, "LogisX-#702", "whatever order the holdings come in");
		const period = { start: "2026-11-07", lastDay: "2026-11-13" };
		const labels = p.boardLabels(new Map([
			[7, { truckId: 4, unit: "LogisX-#703", days: 3, firstDay: "2026-11-10", lastDay: "2026-11-12" }],
			[3, { truckId: 4, unit: "LogisX-#703", days: 3, firstDay: "2026-11-07", lastDay: "2026-11-09" }],
			[5, { truckId: 9, unit: "LogisX-#702", days: 7, firstDay: "2026-11-07", lastDay: "2026-11-13" }],
		]), period);
		eq(labels.get(3), { label: "#703 (1)", ownLabel: "#703 (1, to Nov 9)" }, "the first holder of a handed-over unit is (1); dates only on his own row");
		eq(labels.get(7), { label: "#703 (2)", ownLabel: "#703 (2, Nov 10 to Nov 12)" }, "the next is (2)");
		eq(labels.get(5), { label: "#702", ownLabel: "#702" }, "a unit with one driver has no number and no dates");
		ok(![...labels.values()].some((l) => /\d{1,2}\b.*(Nov|Oct)|(Nov|Oct)/.test(l.label)), "no board label carries a date");
		// One plain form, however the unit is stored.
		for (const [stored, label] of [
			["LogisX-#101", "#101"], ["Logisx-#102", "#102"], ["LOGISX #103", "#103"], ["logisx_104", "#104"], ["LogisX105", "#105"],
			["#106", "#106"], ["107", "#107"], ["  LogisX-#108  ", "#108"],
			["INV-00-Z", "#INV-00-Z"], ["#INV-00-Z", "#INV-00-Z"], ["inv-00-z", "#INV-00-Z"], ["LogisX-INV-00-Z", "#INV-00-Z"],
			["12345", "#12345"],
		]) {
			eq(p.unitLabel(stored), { text: label, refused: null }, `${JSON.stringify(stored)} reads ${label}`);
		}
		// Only a unit's shape passes: anything else reads the neutral label, and says why for the Super Admin.
		const neutral = (refused) => ({ text: p.UNIT_NOT_SHOWN, refused });
		ok(typeof p.UNIT_NOT_SHOWN === "string" && !/\d|#/.test(p.UNIT_NOT_SHOWN), "the neutral label is plain words, not a unit");
		for (const [stored, why, says] of [
			["", "empty", "nothing stored"],
			[null, "empty", "nothing stored"],
			["LogisX", "empty", "only the prefix"],
			["LogisX-#", "empty", "only the prefix and #"],
			["Ben Marsh truck", "characters", "a name with spaces"],
			["Cal's Peterbilt", "characters", "an apostrophe"],
			["Load 12345678", "characters", "a load with a word"],
			["<b>502</b>", "characters", "markup"],
			["##502", "characters", "a doubled #"],
			["5O2_A", "characters", "an underscore"],
			["-502", "characters", "a leading dash"],
			["502-", "characters", "a trailing dash"],
			["50--2", "characters", "a doubled dash"],
			["٥٠٢", "characters", "digits outside 0-9"],
			["A1B2C3D4E5F6G7H8", "length", "too long"],
			["7".repeat(400), "length", "far too long, refused before any other check"],
			["Ada-Quill", "no-digit", "a name with a dash and no digit"],
			["TEST", "no-digit", "letters only"],
			["Walter-1", "letters", "a word with a digit"],
			["Peterbilt5", "letters", "a word glued to a digit"],
			["555-867-5309", "number", "a phone number"],
			["867-5309", "number", "a short phone number"],
			["5558675309", "number", "a phone number unbroken"],
			["12345678", "number", "a load number"],
			["11-05-26", "number", "a date"],
		]) {
			eq(p.unitLabel(stored), neutral(why), `${JSON.stringify(stored).slice(0, 24)} (${says}) reads neutral, "${why}"`);
		}
		// A short unit-shaped value that is really someone: a name's part, its start, or its initials.
		const parts = p.unitNameParts(["Ada Quill", "Ben O'Marsh", "Xi", " ", null]);
		for (const [stored, says] of [["Ada-7", "a first name"], ["ADA7", "a first name in capitals"], ["Qui-7", "the start of a surname"], ["AQ-7", "initials"], ["7-Mar", "a name's part after the number"], ["Xi-7", "a two-letter name"], ["BOM-7", "initials across an apostrophe"], ["BM-7", "first and last initials"]]) {
			eq(p.unitLabel(stored, parts), neutral("name"), `${stored} (${says}) reads neutral, "name"`);
		}
		for (const stored of ["LogisX-#101", "INV-00-Z", "A-7", "TRK-7", "QA-7"]) {
			eq(p.unitLabel(stored, parts).refused, null, `${stored} is no one's name, and passes with the names in hand`);
		}
		const held = { truckId: 4, unit: "Ada-Quill", days: 3, firstDay: "2026-11-07", lastDay: "2026-11-09" };
		const nextHeld = { truckId: 4, unit: "Ada-Quill", days: 3, firstDay: "2026-11-10", lastDay: "2026-11-12" };
		const bad = p.boardLabels(new Map([[3, held], [7, nextHeld], [5, { truckId: 9, unit: "Ben Marsh truck", days: 7, firstDay: "2026-11-07", lastDay: "2026-11-13" }]]), period);
		eq(bad.get(5), { label: p.UNIT_NOT_SHOWN, ownLabel: p.UNIT_NOT_SHOWN }, "a truck that fails reads neutral, to its own driver too");
		eq(bad.get(3), { label: `${p.UNIT_NOT_SHOWN} (1)`, ownLabel: `${p.UNIT_NOT_SHOWN} (1, to Nov 9)` }, "a handover on such a truck keeps its numbers and own-row dates");
		const named = p.boardLabels(new Map([[5, { truckId: 9, unit: "Ada-7", days: 7, firstDay: "2026-11-07", lastDay: "2026-11-13" }]]), period, parts);
		eq(named.get(5).label, p.UNIT_NOT_SHOWN, "boardLabels checks the names it is given");
		const namedHandover = p.boardLabels(new Map([[3, { ...held, unit: "Ada-7" }], [7, { ...nextHeld, unit: "Ada-7" }]]), period, parts);
		eq(namedHandover.get(7).label, `${p.UNIT_NOT_SHOWN} (2)`, "and on a handover too");
	});

	// ── §10 ─────────────────────────────────────────────────────────────────
	await section("10 the driver projection", () => {
		const p = need();
		const loads = p.categoryById("most-loads");
		const ranked = p.rankEntries(loads, [
			{ driverId: 1, label: "#703 (1)", ownLabel: "#703 (1, to Nov 9)", value: 1 },
			{ driverId: 2, label: "#702", ownLabel: "#702", value: 6 },
			{ driverId: 3, label: "#701", ownLabel: "#701", value: 2 },
			{ driverId: 4, label: "#705", ownLabel: "#705", value: 4 },
			{ driverId: 5, label: "#706", ownLabel: "#706", value: null, reason: "safety-event" },
		]);
		const cat = p.projectCategory(loads, ranked, 1, "full");
		ok(cat.rows.every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(p.ROW_KEYS)), "every row has exactly rank, unitLabel, value, display, isYou");
		eq(cat.rows.map((r) => r.display), ["6 loads", "4 loads", "2 loads", "1 load", "Not ranked"], "the display is a fixed shape");
		eq(cat.rows.filter((r) => r.isYou).map((r) => r.unitLabel), ["#703 (1, to Nov 9)"], "only the viewer's row is \"you\", with his own dates");
		eq(p.projectCategory(loads, ranked, 2, "full").rows.find((r) => r.unitLabel.startsWith("#703")).unitLabel, "#703 (1)", "another viewer sees no dates on that row");
		eq(p.projectCategory(loads, ranked, null, "full").rows.filter((r) => r.isYou).length, 0, "a Super Admin is nobody's row");
		const safetyEvent = p.projectRow(loads, { driverId: 5, label: "#706", value: null, rank: null, reason: "safety-event", note: "hit a deer" }, 1);
		const noData = p.projectRow(loads, { driverId: 6, label: "#706", value: null, rank: null, reason: "no-eld" }, 1);
		eq(JSON.stringify(safetyEvent), JSON.stringify(noData), "a unit excluded for a safety event is byte-identical to one with no data");
		const safety = { ...p.categoryById("safety"), live: true };
		const sRows = p.projectCategory(safety, p.rankEntries(safety, [{ driverId: 1, label: "#1", value: 3 }, { driverId: 2, label: "#2", value: 0 }]), 1, "full").rows;
		eq(sRows.map((r) => [r.rank, r.value, r.display]), [[1, null, ""], [2, null, ""]], "the safety board shows the rank only, never a figure");
		const top = p.projectCategory(loads, ranked, 1, "top3-you");
		eq(top.rows.map((r) => r.unitLabel), ["#702", "#705", "#701", "#703 (1, to Nov 9)"], "top 3 plus \"you\"");
		eq(top.listed, 5, "with the count, for \"you: 4th of 5\"");
		eq(p.projectCategory(loads, ranked, 2, "top3-you").rows.length, 3, "a viewer in the top 3 adds no row");
		eq(p.projectCategory(p.categoryById("safety"), [], 1, "full"), { id: "safety", status: "coming-soon", listed: null, rows: [] }, "a category not yet live is \"coming soon\" with no rows");
	});

	// ── §11 ─────────────────────────────────────────────────────────────────
	await section("11 who's in", () => {
		const p = need();
		eq(p.boardExclusion({ status: "active", payType: "fixed", ownerOperator: false }), null, "an active company driver on a day rate is in");
		eq(p.boardExclusion({ status: "Active ", payType: "", ownerOperator: false }), null, "status read case- and space-blind; a blank pay type is the day rate");
		eq(p.boardExclusion({ status: "pending", payType: "fixed" }), "inactive", "an onboarding (pending) driver is out");
		eq(p.boardExclusion({ status: "inactive", payType: "fixed" }), "inactive", "an inactive driver is out");
		eq(p.boardExclusion({ status: "active", payType: "percentage" }), "percentage-driver", "a percentage driver is out");
		eq(p.boardExclusion({ status: "active", payType: "fixed", ownerOperator: true }), "owner-operator", "an owner-operator is out");
		eq(p.boardExclusion({ status: "active", payType: "percentage" }, "all-drivers"), null, "the other answer to Q-A2 lets them in");
		ok(p.isTestUnit("LogisX-TEST") && p.isTestUnit("test") && p.isTestUnit("TEST 2"), "test units are recognised");
		ok(!p.isTestUnit("LogisX-#703") && !p.isTestUnit("Contest-1") && !p.isTestUnit("INV-00-Z"), "other units are not");
	});

	// ── worlds ──────────────────────────────────────────────────────────────
	let on = null;
	let boardOn = null;
	await section("12 the flag", async () => {
		for (const value of ["false", "FALSE", "0", "no", " Off "]) {
			const label = JSON.stringify(value);
			const w = await makeWorld({ DRIVER_PERFORMANCE_ENABLED: value });
			for (const route of ["/api/driver/me/performance", "/api/driver/performance/leaderboard?period=week", "/api/admin/driver-performance", "/api/admin/driver-performance/weeks"]) {
				for (const who of [null, USERS.ada, USERS.admin, USERS.dispatcher, USERS.investor]) {
					const r = await w.get(route, who);
					ok(r.status === 404 && r.json && r.json.code === "FEATURE_OFF",
						`flag ${label}: ${route.split("?")[0]} as ${who ? who.role : "signed out"} is 404 FEATURE_OFF`, `got ${r.status} ${r.text.slice(0, 80)}`);
				}
			}
			eq(w.sheetReads, 0, `flag ${label}: no Job Tracking read`);
			ok(w.logs.some((l) => l.includes("DRIVER_PERFORMANCE_ENABLED off")), `flag ${label}: the start-up line says off`);
			await w.close();
		}
		for (const value of ["", "true", "TRUE", "1"]) {
			const label = JSON.stringify(value);
			const w = await makeWorld({ DRIVER_PERFORMANCE_ENABLED: value });
			const r = await w.get("/api/driver/me/performance", USERS.ada);
			eq(r.status, 200, `flag ${label}: a driver's own week answers`);
			ok(w.logs.some((l) => l.includes("DRIVER_PERFORMANCE_ENABLED on")), `flag ${label}: the start-up line says on`);
			await w.close();
		}
		// Unset is what a deploy gets, so every section below runs in that state.
		on = await makeWorld({});
		ok(on.logs.some((l) => l.includes("DRIVER_PERFORMANCE_ENABLED on")), "unset, it is on: Phase A is live once deployed");
		eq((await on.get("/api/driver/me/performance", USERS.ada)).status, 200, "unset: a driver's own week answers");
		boardOn = await makeWorld({ DRIVER_PERFORMANCE_BOARD_ENABLED: "true" });
	});

	await section("13 roles", async () => {
		if (!on || !boardOn) throw new Error("no world");
		const cases = [
			["/api/driver/me/performance", USERS.ada, 200], ["/api/driver/me/performance", USERS.admin, 403],
			["/api/driver/me/performance", USERS.dispatcher, 403], ["/api/driver/me/performance", USERS.investor, 403],
			["/api/driver/me/performance", null, 401],
			["/api/driver/performance/leaderboard", USERS.ada, 404], ["/api/driver/performance/leaderboard", USERS.admin, 200],
			["/api/driver/performance/leaderboard", USERS.dispatcher, 403], ["/api/driver/performance/leaderboard", USERS.investor, 403],
			["/api/driver/performance/leaderboard", null, 401],
			["/api/admin/driver-performance", USERS.admin, 200], ["/api/admin/driver-performance", USERS.ada, 403],
			["/api/admin/driver-performance", USERS.dispatcher, 403], ["/api/admin/driver-performance", USERS.investor, 403],
			["/api/admin/driver-performance", null, 401],
			["/api/admin/driver-performance/weeks", USERS.admin, 200], ["/api/admin/driver-performance/weeks", USERS.ada, 403],
			["/api/admin/driver-performance/weeks", USERS.dispatcher, 403], ["/api/admin/driver-performance/weeks", USERS.investor, 403],
			["/api/admin/driver-performance/weeks", null, 401],
		];
		for (const [route, who, want] of cases) {
			const r = await on.get(route, who);
			ok(r.status === want, `${route} as ${who ? who.role : "signed out"} is ${want}`, `got ${r.status} ${r.text.slice(0, 80)}`);
		}
		eq((await boardOn.get("/api/driver/performance/leaderboard", USERS.ada)).status, 200, "with the board flag on, a driver on the board reads it");
		for (const who of ["eli", "fay", "gus", "nobody"]) {
			const r = await boardOn.get("/api/driver/performance/leaderboard", USERS[who]);
			ok(r.status === 404 && r.json.code === "NOT_ELIGIBLE", `flag on: the board for ${who} (not on the board) is 404 NOT_ELIGIBLE`, `got ${r.status} ${r.text.slice(0, 80)}`);
		}

		// Active on a day rate, but on none of the three boards: only a test unit (jo), only a
		// retired truck (kim), no truck at all (ivy). The board can't tell them from a driver
		// off it by rule, and jo's delivered load doesn't get him on it.
		const refusal = await boardOn.get("/api/driver/performance/leaderboard", USERS.eli);
		const boardRoutes = [
			"/api/driver/performance/leaderboard",
			"/api/driver/performance/leaderboard?period=week",
			"/api/driver/performance/leaderboard?period=month",
		];
		for (const who of ["jo", "kim", "ivy"]) {
			for (const route of boardRoutes) {
				const r = await boardOn.get(route, USERS[who]);
				ok(r.status === 404 && r.text === refusal.text, `flag on: ${route} for ${who} (on no board) answers exactly as for a driver off the board by rule`, `got ${r.status} ${r.text.slice(0, 80)}`);
			}
		}

		// On at least one board he keeps it; a board without him has no "you" and no word why.
		const yous = (answer) => answer.json.boards.map((b) => [b.id, b.categories[0].rows.filter((r) => r.isYou).length]);
		const whyWords = /reason|no-truck|not-in-directory|not on the board|eligible/i;
		const keepsBoard = async (world, user, weekYous, monthYous, label) => {
			const week = await world.get("/api/driver/performance/leaderboard?period=week", user);
			const month = await world.get("/api/driver/performance/leaderboard?period=month", user);
			eq(yous(week), weekYous, `${label}: "you" on the week boards he is on, none on the other`);
			eq(yous(month), monthYous, `${label}: and on the month's as he is on it`);
			ok(!whyWords.test(week.text + month.text), `${label}: no word why`);
		};
		await keepsBoard(boardOn, USERS.hal, [["this-week", 1], ["last-week", 0]], [["this-month", 1]], "this week and the month, not last week");

		// Two weeks on, Dee's last day on her truck is outside both weeks: only the month holds her.
		const monthOnly = await makeWorld({ DRIVER_PERFORMANCE_BOARD_ENABLED: "true" }, { nowMs: Date.parse("2026-11-25T17:00:00Z") });
		try {
			await keepsBoard(monthOnly, USERS.dee, [["this-week", 0], ["last-week", 0]], [["this-month", 1]], "the month only");
			// Job Tracking down says nothing either way, and shows a driver on no board nothing.
			monthOnly.handle.clearCache();
			monthOnly.sheetDown = true;
			for (const route of ["/api/driver/me/performance", ...boardRoutes]) {
				const r = await monthOnly.get(route, USERS.jo);
				ok(r.status === 503 && r.json.code === "PERFORMANCE_UNAVAILABLE", `${route} for jo with Job Tracking down is 503`, `got ${r.status} ${r.text.slice(0, 80)}`);
			}
		} finally {
			await monthOnly.close();
		}

		// Into December, a truck held until Nov 25 is on last week's board and no other.
		const lastWeekOnly = await makeWorld({ DRIVER_PERFORMANCE_BOARD_ENABLED: "true" }, { nowMs: Date.parse("2026-12-01T17:00:00Z") });
		try {
			lastWeekOnly.db.prepare("DELETE FROM truck_assignments WHERE driver_name = ?").run("Hal Briar");
			lastWeekOnly.db.prepare("UPDATE truck_assignments SET end_date = ? WHERE driver_name = ?").run("2026-11-25T15:00:00.000Z", "Dee Stone");
			await keepsBoard(lastWeekOnly, USERS.dee, [["this-week", 0], ["last-week", 1]], [["this-month", 0]], "last week only");
		} finally {
			await lastWeekOnly.close();
		}

		const own = await on.get("/api/driver/me/performance", USERS.ada);
		eq(own.headers["cache-control"], "private, no-store", "answers are never cached by a browser or proxy");
	});

	await section("14 the board over HTTP", async () => {
		if (!boardOn) throw new Error("no world");
		const f = boardOn.fns;
		const week = await boardOn.get("/api/driver/performance/leaderboard?period=week", USERS.ada);
		eq(week.status, 200, "the weekly board answers");
		const b = week.json;
		eq(sortedKeys(b), ["boards", "period", "view"], "the answer's keys");
		eq(b.boards.map((x) => [x.id, x.start, x.end]), [["this-week", "2026-11-07", "2026-11-13"], ["last-week", "2026-10-31", "2026-11-06"]],
			"this week and last week");
		eq(b.boards[0].categories.map((c) => [c.id, c.status]),
			[["most-loads", "live"], ["least-fuel-cost", "coming-soon"], ["safety", "coming-soon"], ["lowest-idle", "coming-soon"]],
			"Most loads is live; fuel, safety and idle are coming soon");
		ok(b.boards.every((x) => x.categories.slice(1).every((c) => c.rows.length === 0)), "coming-soon categories carry no rows");
		const rowsOf = (board) => board.categories[0].rows;
		eq(rowsOf(b.boards[0]).map((r) => [r.rank, r.unitLabel, r.value, r.display, r.isYou]), [
			[1, "#501", 3, "3 loads", true],
			[2, "#502", 2, "2 loads", false],
			[2, "#504 (2)", 2, "2 loads", false],
			[4, "#503", 1, "1 load", false],
			[4, "#504 (1)", 1, "1 load", false],
		], "this week: ranks, units, counts; the handover reads (1) and (2) without dates; test, retired, percentage and owner-operator units are absent");
		eq(rowsOf(b.boards[1]).map((r) => [r.rank, r.unitLabel, r.value]), [[1, "#501", 2], [2, "#504", 1], [3, "#502", 0], [3, "#503", 0]],
			"last week: Hal had no truck, so #504 is Dee's alone; 0 is a real count");
		// The invoice's own selector over the raw sheet (every row, as the invoice reads it).
		const raw = f.parseSheet({ values: sheetValues() });
		const keys = f.loadKeySet(f.getDeletedLoadIds());
		const invoiceCount = (name, ws, we) => f.selectInvoiceWeekLoads(raw.data, raw.headers, name, ws, we, keys).loads.length;
		const byUnitThis = { "#501": "Ada Quill", "#502": "Ben Marsh", "#504 (2)": "Hal Briar", "#503": "Cal Reyes", "#504 (1)": "Dee Stone" };
		for (const r of rowsOf(b.boards[0])) {
			eq(r.value, invoiceCount(byUnitThis[r.unitLabel], "2026-11-07", "2026-11-13"), `this week ${r.unitLabel}: the board's count is the weekly invoice's`);
		}
		const byUnitLast = { "#501": "Ada Quill", "#502": "Ben Marsh", "#504": "Dee Stone", "#503": "Cal Reyes" };
		for (const r of rowsOf(b.boards[1])) {
			eq(r.value, invoiceCount(byUnitLast[r.unitLabel], "2026-10-31", "2026-11-06"), `last week ${r.unitLabel}: the board's count is the weekly invoice's`);
		}
		const month = await boardOn.get("/api/driver/performance/leaderboard?period=month", USERS.ada);
		eq(month.json.boards.map((x) => [x.id, x.start, x.end]), [["this-month", "2026-11-01", "2026-11-30"]], "the month board is the calendar month");
		eq(rowsOf(month.json.boards[0]).map((r) => [r.unitLabel, r.value]), [["#501", 5], ["#502", 2], ["#504 (1)", 2], ["#504 (2)", 2], ["#503", 1]],
			"the month counts completion days in November only (Oct 30 is out)");
		for (const r of rowsOf(month.json.boards[0])) {
			const name = { "#501": "Ada Quill", "#502": "Ben Marsh", "#504 (1)": "Dee Stone", "#504 (2)": "Hal Briar", "#503": "Cal Reyes" }[r.unitLabel];
			eq(r.value, invoiceCount(name, "2026-11-01", "2026-11-30"), `month ${r.unitLabel}: the same completion-day rule`);
		}
		const all = [...b.boards, ...month.json.boards].flatMap((x) => x.categories);
		ok(all.every((c) => JSON.stringify(sortedKeys(c)) === JSON.stringify(["id", "listed", "rows", "status"])), "each category has exactly id, status, listed, rows");
		ok(all.flatMap((c) => c.rows).every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(need().ROW_KEYS)), "each row has exactly the five keys");
		ok(all.flatMap((c) => c.rows).every((r) => /^#[A-Za-z0-9-]+( \(\d+(, (from |to )?[A-Z][a-z]{2} \d{1,2}( to [A-Z][a-z]{2} \d{1,2})?)?\))?$/.test(r.unitLabel)), "every unit label is a unit, its number and (own row only) dates");
		const text = JSON.stringify([b, month.json]).toLowerCase();
		const leaked = ALL_NAMES.filter((n) => text.includes(n.toLowerCase()) || text.includes(n.split(" ")[0].toLowerCase()));
		eq(leaked, [], "no driver's name, first or full, anywhere in the board");
		ok(!allKeys([b, month.json]).some((k) => /id$|name|driver|reason|pay|tier|streak|rei|hour/i.test(k) && k !== "id"), "no id, name, reason, pay, tier, streak, REI or hours key");
		// "You" is the viewer's own row, worked out per request.
		const asDee = await boardOn.get("/api/driver/performance/leaderboard?period=week", USERS.dee);
		eq(rowsOf(asDee.json.boards[0]).filter((r) => r.isYou).map((r) => r.unitLabel), ["#504 (1, to Nov 9)"], "Dee sees her own row, with her dates");
		const asHal = await boardOn.get("/api/driver/performance/leaderboard?period=week", USERS.hal);
		eq(rowsOf(asHal.json.boards[0]).filter((r) => r.isYou).map((r) => r.unitLabel), ["#504 (2, from Nov 10)"], "Hal sees his, with his");
		eq(rowsOf(asHal.json.boards[1]).filter((r) => r.isYou).length, 0, "last week Hal is not on the board");
		const again = await boardOn.get("/api/driver/performance/leaderboard?period=week", USERS.ada);
		eq(rowsOf(again.json.boards[0]).map((r) => [r.unitLabel, r.isYou]), rowsOf(b.boards[0]).map((r) => [r.unitLabel, r.isYou]),
			"Ada's board after Dee's and Hal's reads is unchanged: no viewer's row is kept for the next");
		const asAdmin = await boardOn.get("/api/driver/performance/leaderboard?period=week", USERS.admin);
		eq(rowsOf(asAdmin.json.boards[0]).filter((r) => r.isYou).length, 0, "a Super Admin's board has no \"you\"");
		eq(rowsOf(asAdmin.json.boards[0]).map((r) => r.unitLabel), rowsOf(b.boards[0]).map((r) => r.unitLabel), "and the same order as every driver's");
	});

	await section("15 the driver's own week over HTTP", async () => {
		if (!on) throw new Error("no world");
		const weeks = {};
		for (const who of ["ada", "ben", "cal", "dee", "hal"]) {
			const r = await on.get("/api/driver/me/performance", USERS[who]);
			eq(r.status, 200, `${who}'s own week answers`);
			weeks[who] = r.json;
		}
		const a = weeks.ada;
		eq(sortedKeys(a), ["countedFrom", "creditWeights", "pastWeeks", "view", "weeks"], "the answer's keys");
		eq(a.view, "no-hours-data", "every truck gets the \"no hours data\" view");
		eq(a.creditWeights, { delivery: 0.5, pickup: 0.5 }, "the weights the credits use");
		const WEEK_KEYS = ["barColor", "credits", "end", "id", "left", "loads", "newWeekNote", "nextWeekStarts", "pace", "percent", "start", "targetLowered"];
		eq(a.weeks.map((w) => sortedKeys(w)), [WEEK_KEYS, WEEK_KEYS], "each week's keys");
		eq(a.weeks.map((w) => sortedKeys(w.credits)), [["deliveries", "pickups", "required", "target", "value"], ["deliveries", "pickups", "required", "target", "value"]], "each week's credit keys");
		const banned = /hour|rei|gap|reach|expected|rank|unit|streak|tier|bonus|earn/i;
		for (const [who, body] of Object.entries(weeks)) {
			ok(!allKeys(body).some((k) => banned.test(k)), `${who}: no hours, REI, gap, "out of reach", rank, unit, streak or earnings key`);
			ok(!/out of reach/i.test(JSON.stringify(body)), `${who}: no "out of reach" text`);
		}
		eq(a.weeks.map((w) => [w.id, w.credits.deliveries, w.credits.pickups, w.credits.value, w.credits.target]),
			[["this-week", 3, 3, 3, 7.5], ["last-week", 2, 1, 1.5, 7.5]],
			"Ada (ELD truck): geofence and ELD departures count, her early tap and her ELD truck's tap don't; Friday 11:30 PM ET is last week");
		eq(weeks.ben.weeks[0].credits, { value: 2, target: 7.5, required: 6, deliveries: 2, pickups: 2 }, "Ben (no ELD): his tap and dispatch's tap count");
		eq(weeks.cal.weeks[0].credits, { value: 1, target: 7.5, required: 6, deliveries: 1, pickups: 1 }, "Cal (ELD silent 20 days): his tap counts, and behind on Wednesday he still reads the required 6");
		eq(weeks.dee.weeks.map((w) => w.credits.deliveries), [1, 1], "Dee's deliveries, this week and last");
		eq(weeks.hal.weeks.map((w) => w.credits.deliveries), [2, 0], "Hal's own week shows even with no truck last week");

		// Wednesday: 3 days left, so 3 by this morning is on pace, and 1.5 more is ahead.
		const shown = (who) => {
			const w = weeks[who].weeks[0];
			return [w.credits.value, w.left, w.percent, w.pace, w.newWeekNote];
		};
		eq(shown("ada"), [3, 4.5, 40, "on-track", false], "Ada: 3 of 7.5, 4.5 left, 40%, On Track");
		eq(shown("ben"), [2, 5.5, 26, "needs-focus", true], "Ben: 2 of 7.5, 5.5 left (more than 3 days hold), 26%, Needs Focus");
		eq(shown("cal"), [1, 6.5, 13, "needs-focus", true], "Cal: 1 of 7.5, 6.5 left, 13%, Needs Focus");
		eq(shown("dee"), [0.5, 7, 6, "needs-focus", true], "Dee: 0.5 of 7.5, and 6.67% rounds down to 6");
		for (const [who, body] of Object.entries(weeks)) {
			const last = body.weeks[1];
			eq([last.left, last.pace, last.newWeekNote, last.nextWeekStarts], [null, null, false, null], `${who}: last week is its final figure, with nothing left, no label and no coming Saturday`);
		}

		// The coming Saturday's date: the day after the bar's own Friday, on the same Eastern week rule.
		eq(a.weeks[0].nextWeekStarts, "Nov 14", "Wed Nov 11: the coming Saturday is Nov 14");
		for (const [nowIso, says, start, next] of [
			["2026-11-14T04:30:00Z", "Friday 11:30 PM Eastern", "2026-11-07", "Nov 14"],
			["2026-11-14T05:30:00Z", "Saturday 12:30 AM Eastern", "2026-11-14", "Nov 21"],
		]) {
			const atNight = await makeWorld({}, { nowMs: Date.parse(nowIso) });
			try {
				const thisWeek = (await atNight.get("/api/driver/me/performance", USERS.ada)).json.weeks[0];
				eq([thisWeek.start, thisWeek.nextWeekStarts], [start, next], `${says}: the bar's week starts ${start}, and the coming Saturday is ${next}`);
			} finally {
				await atNight.close();
			}
		}

		// What counted, in the order it counted: he can add it up himself.
		eq(a.weeks[0].loads, [
			{ loadId: "DP-1010", pickup: { day: "Sat", credits: 0.5 }, delivery: null },
			{ loadId: "DP-1001", pickup: { day: "Sun", credits: 0.5 }, delivery: { day: "Mon", credits: 0.5 } },
			{ loadId: "DP-1002", pickup: { day: "Mon", credits: 0.5 }, delivery: { day: "Tue", credits: 0.5 } },
			{ loadId: "DP-1004", pickup: { note: "not-counted" }, delivery: { day: "Mon", credits: 0.5 } },
		], "Ada's this week: each row shows both credits, or what became of the pickup");
		eq(a.weeks[1].loads, [
			{ loadId: "DP-1008", pickup: { note: "not-counted" }, delivery: { day: "Thu", credits: 0.5 } },
			{ loadId: "DP-1009", pickup: { note: "not-counted" }, delivery: { day: "Fri", credits: 0.5 } },
			{ loadId: "DP-1011", pickup: { day: "Fri", credits: 0.5 }, delivery: null },
		], "Ada's last week: the same list");
		// A delivery whose pickup counted in another week says so, and the list still adds up.
		const notes = await makeWorld({}, { extraLoads: [["DP-8010", "Ben Marsh", "Delivered", "2026-11-10 09:00"], ["DP-8011", "Ben Marsh", "Delivered", "2026-11-10 10:00"], ["DP-8012", "Ben Marsh", "Delivered", "2026-11-03 10:00"]] });
		try {
			const addPickup = notes.db.prepare("INSERT INTO load_status_history (load_id, source, new_status, changed_at) VALUES (?, 'geofence', 'In Transit', ?)");
			addPickup.run("dp-8010", "2026-11-05 15:00:00");
			addPickup.run("dp-8011", "2026-10-20 15:00:00");
			addPickup.run("dp-8012", "2026-10-20 15:00:00");
			const ben = (await notes.get("/api/driver/me/performance", USERS.ben)).json;
			const rowOf = (w, id) => w.loads.find((l) => l.loadId === id);
			eq(rowOf(ben.weeks[0], "DP-8010"), { loadId: "DP-8010", pickup: { note: "last-week" }, delivery: { day: "Tue", credits: 0.5 } }, "its pickup counted last week");
			eq(rowOf(ben.weeks[0], "DP-8011"), { loadId: "DP-8011", pickup: { note: "another-week" }, delivery: { day: "Tue", credits: 0.5 } }, "its pickup counted before last week");
			eq(rowOf(ben.weeks[1], "DP-8010"), { loadId: "DP-8010", pickup: { day: "Thu", credits: 0.5 }, delivery: null }, "and last week shows that pickup as its own row");
			eq(rowOf(ben.weeks[1], "DP-8012"), { loadId: "DP-8012", pickup: { note: "another-week" }, delivery: { day: "Tue", credits: 0.5 } }, "last week's own delivery says the same of an older pickup");
		} finally {
			await notes.close();
		}

		const creditsOf = (load) => (load.pickup && load.pickup.credits ? load.pickup.credits : 0) + (load.delivery ? load.delivery.credits : 0);
		for (const [who, body] of Object.entries(weeks)) {
			for (const w of body.weeks) {
				eq(w.loads.reduce((sum, l) => sum + creditsOf(l), 0), w.credits.value, `${who} ${w.id}: the list adds up to his figure`);
				eq(w.loads.filter((l) => l.delivery).length, w.credits.deliveries, `${who} ${w.id}: one row per delivery`);
			}
		}

		// Only the weight changed: deliveries stay the weekly invoice's own, over the raw sheet.
		const f = on.fns;
		const raw = f.parseSheet({ values: sheetValues() });
		const keys = f.loadKeySet(f.getDeletedLoadIds());
		for (const [who, name] of [["ada", "Ada Quill"], ["ben", "Ben Marsh"], ["cal", "Cal Reyes"], ["dee", "Dee Stone"], ["hal", "Hal Briar"]]) {
			const count = (ws, we) => f.selectInvoiceWeekLoads(raw.data, raw.headers, name, ws, we, keys).loads.length;
			eq(weeks[who].weeks.map((w) => w.credits.deliveries), [count("2026-11-07", "2026-11-13"), count("2026-10-31", "2026-11-06")], `${who}: deliveries are the weekly invoice's`);
		}
	});

	await section("16 the Super Admin report", async () => {
		if (!on) throw new Error("no world");
		const r = await on.get("/api/admin/driver-performance?period=week", USERS.admin2);
		eq(r.status, 200, "the report answers");
		eq(r.json.hoursLabel, "estimate, not checked", "hours are labelled an estimate, not checked");
		const thisWeek = r.json.boards[0].drivers;
		const byName = new Map(thisWeek.map((x) => [x.name, x]));
		ok(thisWeek.every((x) => x.hoursEstimate === null), "no hours estimate is wired yet: null, never 0");
		eq(thisWeek.filter((x) => x.listed).map((x) => [x.name, x.rank, x.loads]),
			[["Ada Quill", 1, 3], ["Ben Marsh", 2, 2], ["Hal Briar", 2, 2], ["Cal Reyes", 4, 1], ["Dee Stone", 4, 1]], "names beside the ranks");
		eq(["Eli North", "Fay Owens", "Jo Tester", "Kim Vale", "Lou Grant"].map((n) => [n, byName.get(n) && byName.get(n).reason]), [
			["Eli North", "percentage-driver"], ["Fay Owens", "owner-operator"], ["Jo Tester", "no-truck-in-period"],
			["Kim Vale", "no-truck-in-period"], ["Lou Grant", "not-in-directory"],
		], "each driver off the board, with the reason (Super Admin only)");
		eq(byName.get("Ada Quill").pickups, { total: 3, geofence: 2, eld: 1, driver: 0, dispatch: 0 }, "Ada's pickups by source");
		eq(byName.get("Ben Marsh").pickups, { total: 2, geofence: 0, eld: 0, driver: 1, dispatch: 1 }, "Ben's pickups by source");
		eq(byName.get("Cal Reyes").pickups, { total: 1, geofence: 0, eld: 0, driver: 1, dispatch: 0 }, "Cal's one tap is his own, not dispatch's");
		eq(byName.get("Dee Stone").ownLabel, "#504 (1, to Nov 9)", "the report shows the handover dates");
		eq(byName.get("Hal Briar").units, [{ unitLabel: "#504", unitNumber: "LogisX-#504", labelRefused: null, days: 2, firstDay: "2026-11-10", lastDay: "2026-11-11" }], "and the days each unit was held, with the unit as stored");
		const last = new Map(r.json.boards[1].drivers.map((x) => [x.name, x]));
		ok(!last.has("Hal Briar"), "last week Hal had no truck, load or pickup, so the report has no row for him");
		eq([last.get("Dee Stone").listed, last.get("Dee Stone").unitLabel, last.get("Dee Stone").ownLabel], [true, "#504", "#504"], "and #504 was Dee's alone, no handover");
		const m = await on.get("/api/admin/driver-performance?period=month", USERS.admin2);
		ok(m.json.boards[0].drivers.every((x) => x.pickups === null && x.credits === null), "the month report counts loads only");
		const bad = await boardOn.get("/api/driver/performance/leaderboard?period=year", USERS.ada);
		ok(bad.status === 400 && bad.json.code === "BAD_PERIOD", "an unknown period is 400 BAD_PERIOD");
		const badAdmin = await on.get("/api/admin/driver-performance?period=", USERS.admin2);
		ok(badAdmin.status === 400 && badAdmin.json.code === "BAD_PERIOD", "an empty period is 400 too");
		on.handle.clearCache();
		on.sheetDown = true;
		boardOn.handle.clearCache();
		boardOn.sheetDown = true;
		for (const [world, route, who] of [[on, "/api/driver/me/performance", USERS.ada], [boardOn, "/api/driver/performance/leaderboard", USERS.ada], [on, "/api/driver/performance/leaderboard", USERS.admin2], [on, "/api/admin/driver-performance", USERS.admin2]]) {
			const down = await world.get(route, who);
			ok(down.status === 503 && down.json.code === "PERFORMANCE_UNAVAILABLE", `${route} as ${who.username}: Job Tracking down is 503, not an empty answer`, `got ${down.status}`);
		}
		on.sheetDown = false;
		boardOn.sheetDown = false;
	});

	await section("17 wiring", () => {
		lifted();
		const lines = SRC.split("\n");
		const mounts = lines.map((l, i) => [l, i]).filter(([l]) => l.includes('require("./lib/driver-performance-routes")'));
		eq(mounts.map(([l]) => l), ['const driverPerformance = require("./lib/driver-performance-routes").mount(app, {'], "server.js mounts the routes in one declaration");
		const catchAll = lines.findIndex((l) => l.startsWith('app.get("*", '));
		ok(mounts.length === 1 && catchAll > mounts[0][1], "above the SPA catch-all");
		const decl = LIFT.text.split("\n").filter((l) => /DRIVER_PERFORMANCE_ENABLED/.test(l));
		eq(decl.map((l) => l.trim()), ['enabled: !/^(false|0|no|off)$/i.test(String(process.env.DRIVER_PERFORMANCE_ENABLED ?? "").trim()),'], "the flag is read once, in the kill-switch shape");
		const boardDecl = LIFT.text.split("\n").filter((l) => /DRIVER_PERFORMANCE_BOARD_ENABLED/.test(l));
		eq(boardDecl.map((l) => l.trim()), ['boardForDrivers: process.env.DRIVER_PERFORMANCE_BOARD_ENABLED === "true",'], "the board flag is read once, on only when exactly \"true\"");
		ok(/driverAvailabilityByName: DRIVER_AVAILABILITY_ENABLED \? driverAvailabilityByName : null,/.test(LIFT.text), "approved days off are read only while their own flag is on");
		const hoursDecl = LIFT.text.split("\n").filter((l) => /DRIVER_PERFORMANCE_HOURS_ENABLED|driverWeekMinutesReader/.test(l));
		eq(hoursDecl.map((l) => l.trim()), ['drivingHours: process.env.DRIVER_PERFORMANCE_HOURS_ENABLED === "true" && ELD_ACTIVITY_DAILY_ENABLED ? require("./lib/eld-activity-daily").driverWeekMinutesReader(db) : null,'],
			"the hours flag is read once, on only when exactly \"true\" and with the rollup on, and only then is the rollup's reader made");
		const routesSrc = fs.readFileSync(path.join(ROOT, "lib", "driver-performance-routes.js"), "utf8");
		ok(!/\b(INSERT|UPDATE|DELETE|REPLACE)\s/.test(routesSrc.replace(/\/\/.*$/gm, "")) && !/\.run\(|\.exec\(/.test(routesSrc), "the routes module writes nothing to the database");
		ok(!/app\.(post|put|patch|delete)\(/.test(routesSrc), "and registers no write route");
		ok(!/eld_activity_daily|eld-activity-daily/.test(routesSrc), "the routes module never names the rollup's table or module: it reads hours only through the reader it is handed");
		eq((routesSrc.match(/^\tapp\.get\(PATHS\.\w+, [^\n]*$/gm) || []).map((l) => l.trim()), [
			'app.get(PATHS.own, driverPerformanceFlagGate, d.requireRole("Driver"), limiter, async (req, res) => {',
			'app.get(PATHS.board, driverPerformanceFlagGate, d.requireRole("Super Admin", "Driver"), boardForDriversGate, limiter, async (req, res) => {',
			'app.get(PATHS.admin, driverPerformanceFlagGate, d.requireRole("Super Admin"), limiter, async (req, res) => {',
			'app.get(PATHS.adminWeeks, driverPerformanceFlagGate, d.requireRole("Super Admin"), limiter, async (req, res) => {',
		], "four reads, each the switch first, then the role, then the limit; the drivers' weeks for the Super Admin alone");
		eq(require(path.join(ROOT, "lib", "driver-performance-routes.js")).PATHS.adminWeeks, "/api/admin/driver-performance/weeks", "the drivers' weeks' path");
		ok(/SELECT id, driver_name FROM users WHERE role = 'Driver'/.test(routesSrc) && !/SELECT[^"`]*\b(email|phone|cell|password_hash)\b/i.test(routesSrc), "of the accounts it reads an id and the driver each names, and no read anywhere takes an email, phone or password");
		const rules = require(path.join(ROOT, "lib", "replica-rules.js"));
		ok(!(rules.ENABLE_ALLOWED || []).includes("DRIVER_PERFORMANCE_ENABLED"), "replica:start --enable doesn't take it: it is already on");
		ok(/kill switch/.test(String((rules.ENABLE_REFUSED || {}).DRIVER_PERFORMANCE_ENABLED)), "the replica refuses it as a kill switch");
		ok((rules.ENABLE_ALLOWED || []).includes("DRIVER_PERFORMANCE_BOARD_ENABLED"), "replica:start --enable takes the board flag: read only, on the task's own copy");
		ok((rules.ENABLE_ALLOWED || []).includes("DRIVER_PERFORMANCE_HOURS_ENABLED") && !Object.prototype.hasOwnProperty.call(rules.ENABLE_REFUSED || {}, "DRIVER_PERFORMANCE_HOURS_ENABLED"),
			"replica:start --enable takes the hours flag: read only, from the task's own rows");
	});

	await section("18 a stored unit that isn't a unit", async () => {
		if (!boardOn) throw new Error("no world");
		const setUnit = (id, unit) => {
			boardOn.db.prepare("UPDATE trucks SET unit_number = ? WHERE id = ?").run(unit, id);
			boardOn.handle.clearCache();
		};
		const boardAs = async (who) => {
			const r = await boardOn.get("/api/driver/performance/leaderboard?period=week", who);
			return { json: r.json, text: r.text, rows: r.json.boards[0].categories[0].rows };
		};
		const notShown = need().UNIT_NOT_SHOWN;
		// A name only an assignment holds: not in the directory, and on no load.
		boardOn.db.prepare("INSERT INTO trucks (id, unit_number, retired_at) VALUES (10, 'LogisX-#510', '')").run();
		boardOn.db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (10, 'Zed Ames', '2026-10-01T12:00:00.000Z', '')").run();
		boardOn.handle.clearCache();
		const plain = (await boardAs(USERS.ada)).rows;
		for (const [stored, why] of [
			["Ada-Quill", "no-digit"], ["Ben Marsh truck", "characters"], ["Cal's Peterbilt", "characters"], ["555-867-5309", "number"],
			["Load 12345678", "characters"], ["12345678", "number"], ["<b>502</b>", "characters"], ["Walter-1", "letters"],
			// A directory-only name, a sheet-only name and an assignment-only name: each list counts.
			["Ben-7", "name"], ["BM-7", "name"], ["Gus-7", "name"], ["Lou-7", "name"], ["Zed-7", "name"],
		]) {
			setUnit(2, stored);
			const asAda = await boardAs(USERS.ada);
			ok(!asAda.text.includes(JSON.stringify(stored).slice(1, -1)), `${stored}: never reaches another driver, whole`);
			// "load" is the board's own word ("3 loads"), and 502 is the unit number itself.
			for (const part of stored.split(/[^A-Za-z0-9]+/).filter((x) => x.length > 2 && !["load", "502"].includes(x.toLowerCase()))) {
				ok(!asAda.text.toLowerCase().includes(part.toLowerCase()), `${stored}: nor its part "${part}"`);
			}
			const rowFacts = (rows, label) => rows.map((r) => JSON.stringify([r.rank, label ? label(r.unitLabel) : r.unitLabel, r.value])).sort();
			eq(rowFacts(asAda.rows), rowFacts(plain, (l) => (l === "#502" ? notShown : l)), `${stored}: the row keeps its rank and count under the neutral label`);
			eq(Object.keys(asAda.rows.find((r) => r.unitLabel === notShown)), need().ROW_KEYS, `${stored}: the row has only the five keys`);
			const asBen = await boardAs(USERS.ben);
			eq(asBen.rows.filter((r) => r.isYou).map((r) => r.unitLabel), [notShown], `${stored}: its own driver reads the neutral label too`);
			ok(!asBen.text.includes(JSON.stringify(stored).slice(1, -1)), `${stored}: and not the stored text`);
			const report = await boardOn.get("/api/admin/driver-performance?period=week", USERS.admin2);
			const ben = report.json.boards[0].drivers.find((x) => x.name === "Ben Marsh");
			eq([ben.unitLabel, ben.units.map((u) => [u.unitLabel, u.unitNumber, u.labelRefused])], [notShown, [[notShown, stored, why]]],
				`${stored}: the Super Admin report names the truck as stored, and why`);
		}
		setUnit(2, "Logisx-#502");
		eq((await boardAs(USERS.ada)).rows.map((r) => r.unitLabel), plain.map((r) => r.unitLabel), "corrected, the unit reads as itself again");
		const own = await boardOn.get("/api/driver/me/performance", USERS.ben);
		ok(!/"unit/i.test(own.text), "a driver's own week carries no unit at all");
	});

	await section("19 pacing on loads alone", () => {
		const p = need();
		eq(p.LOADS_PACE, { creditsPerDay: 1.5, aheadBy: 1.5, targetFloor: 4.5, hideLabelAtDaysOff: 3, requiredBelowTarget: 1.5 }, "the reading, in one constant");
		// Today through Friday, at 1.5 a day: what he'd have by this morning to finish on 7.5.
		const WEEK = { start: "2026-11-07", end: "2026-11-13" };
		// The table is in credits, so the deliveries that earn each figure come from the weight.
		const paceOn = (today, credits, offDays = [], openLoad = true) => p.personalWeek({ id: "this-week", ...WEEK, today, deliveries: credits / p.CREDIT_WEIGHTS.delivery, pickups: 0, loads: [], offDays, openLoad }).pace;
		const SAT = "2026-11-07"; const SUN = "2026-11-08"; const MON = "2026-11-09"; const TUE = "2026-11-10"; const WED = "2026-11-11"; const THU = "2026-11-12"; const FRI = "2026-11-13";
		for (const [today, name, credits, want] of [
			[SAT, "Sat", 0, "on-track"], [SAT, "Sat", 1, "on-track"], [SAT, "Sat", 1.5, "ahead"],
			[SUN, "Sun", 0, "on-track"], [SUN, "Sun", 1.5, "ahead"],
			[MON, "Mon", 0, "on-track"], [MON, "Mon", 1, "on-track"], [MON, "Mon", 1.5, "ahead"],
			[TUE, "Tue", 0, "needs-focus"], [TUE, "Tue", 1, "needs-focus"], [TUE, "Tue", 1.5, "on-track"], [TUE, "Tue", 2.5, "on-track"], [TUE, "Tue", 3, "ahead"],
			[WED, "Wed", 2.5, "needs-focus"], [WED, "Wed", 3, "on-track"], [WED, "Wed", 4, "on-track"], [WED, "Wed", 4.5, "ahead"],
			[THU, "Thu", 3, "needs-focus"], [THU, "Thu", 4, "needs-focus"], [THU, "Thu", 4.5, "on-track"], [THU, "Thu", 5.5, "on-track"], [THU, "Thu", 6, "ahead"],
			[FRI, "Fri", 5.5, "needs-focus"], [FRI, "Fri", 6, "on-track"], [FRI, "Fri", 7, "on-track"], [FRI, "Fri", 7.5, "ahead"],
			[MON, "Mon", 7.5, "ahead"], [FRI, "Fri", 12, "ahead"],
		]) eq(paceOn(today, credits), want, `${name} at ${credits}: ${want}`);
		eq([SAT, SUN, MON].map((today) => paceOn(today, 0)), ["on-track", "on-track", "on-track"], "a rest weekend never reads Needs Focus");
		const stops = (deliveries, pickups) => p.personalWeek({ id: "this-week", ...WEEK, today: WED, deliveries, pickups, loads: [], offDays: [], openLoad: true }).pace;
		eq([stops(3, 2), stops(3, 3), stops(4, 4), stops(5, 4)], ["needs-focus", "on-track", "on-track", "ahead"], "the same table against real stops, Wed: 2.5 is below 3; 3 and 4 are on pace; 4.5 is ahead");
		eq(p.pace({ credits: 3, hours: null, completedWorkedDays: 2, todayHours: 0, calendarDaysLeft: 3, approvedDaysOff: 0 }), null, "the combined score's pace still waits on hours, left as it was");
	});

	await section("20 his target and his week", () => {
		const p = need();
		eq([0, 1, 2, 3, 4, 7].map((off) => p.personalTarget(off)), [7.5, 6, 4.5, 4.5, 4.5, 4.5], "7.5, less 1.5 per approved day off, not below 4.5");
		eq(p.personalTarget(0) - p.personalTarget(1), p.loadCredits(1, 2), "a day off takes off a day's stops, a pickup, a drop-off and a pickup: not one load");
		const WEEK = { id: "this-week", start: "2026-11-07", end: "2026-11-13" };
		const week = (over) => p.personalWeek({ ...WEEK, today: "2026-11-11", deliveries: 0, pickups: 0, loads: [], offDays: [], openLoad: true, ...over });
		eq(p.offDaysInWeek([{ from_date: "2026-11-05", to_date: "2026-11-08" }, { from_date: "2026-11-08", to_date: "2026-11-08" }, { from_date: "2026-11-13", to_date: "2026-11-20" }], "2026-11-07", "2026-11-13"),
			["2026-11-07", "2026-11-08", "2026-11-13"], "the week's own days off, each counted once, whatever the rows' overlaps");
		eq(p.offDaysInWeek([{ from_date: "2026-11-14", to_date: "2026-11-20" }], "2026-11-07", "2026-11-13"), [], "days outside the week don't count");
		eq(p.offDaysInWeek(null, "2026-11-07", "2026-11-13"), [], "none at all");

		// The bar's percent and what's left.
		eq([6, 14, 18, 24].map((n) => week({ deliveries: n }).percent), [40, 93, 100, 100], "percent rounded down, capped at 100");
		eq(week({ deliveries: 8, pickups: 7 }).percent, 100, "4 + 3.5 is the whole target");
		eq(week({ deliveries: 2 }).percent, 13, "13.33 rounds down");
		eq(week({ deliveries: 4, pickups: 3 }).percent, 46, "46.67 rounds down too, never up");
		eq([6, 14, 15, 18].map((n) => week({ deliveries: n }).left), [4.5, 0.5, 0, 0], "what's left never goes below 0");
		eq(week({ deliveries: 2, pickups: 3 }).credits, { value: 2.5, target: 7.5, required: 6, deliveries: 2, pickups: 3 }, "the count: a pickup 0.5, a delivery 0.5");
		eq(week({ deliveries: 1, pickups: 1 }).credits.value, 1, "one load, picked up and delivered, is 1");
		eq(week({ deliveries: 5, pickups: 5 }).percent, 66, "5 loads are 66% of 7.5, not all of it");
		// "N loads left" stays true at a half: the figure and what's left make the target, in whole stops.
		for (const [delivered, picked] of [[0, 0], [1, 0], [0, 1], [1, 1], [3, 2], [5, 5], [7, 7], [8, 6]]) {
			const w = week({ deliveries: delivered, pickups: picked });
			eq(w.credits.value + w.left, 7.5, `${delivered} delivered, ${picked} picked up: the figure and what's left make the target`);
			ok(Number.isInteger(w.left / 0.5), `${delivered} delivered, ${picked} picked up: ${w.left} left is a whole number of stops`);
		}

		// What's required stays 1.5 below the target, whatever lowers it, the floor's weeks included,
		// until approved time off makes it impossible for the whole week: then it is null.
		const SAT = "2026-11-07"; const SUN = "2026-11-08"; const MON = "2026-11-09"; const TUE = "2026-11-10"; const WED = "2026-11-11"; const THU = "2026-11-12"; const FRI = "2026-11-13";
		const offFor = (n) => [SAT, SUN, MON, TUE, WED, THU, FRI].slice(0, n);
		eq([0, 1, 2, 3, 5, 6, 7].map((n) => { const c = week({ today: SAT, offDays: offFor(n) }).credits; return [c.target, c.required]; }),
			[[7.5, 6], [6, 4.5], [4.5, 3], [4.5, 3], [4.5, 3], [4.5, null], [4.5, null]], "Saturday at nothing: 1.5 below the target, until 6 or 7 days off leave too few days to earn it");
		// The week's days not off, at 1.5 each, against what's required. Neither today nor what he has counts.
		const required = (today, credits, offDays = []) => week({ today, deliveries: credits / p.CREDIT_WEIGHTS.delivery, offDays }).credits.required;
		for (const [today, name, credits] of [
			[SAT, "Sat", 0], [TUE, "Tue", 0], [WED, "Wed", 0], [WED, "Wed", 1], [THU, "Thu", 0], [THU, "Thu", 2.5], [FRI, "Fri", 0], [FRI, "Fri", 4], [FRI, "Fri", 9],
		]) eq(required(today, credits), 6, `a full week, ${name} at ${credits}: 6 is required, however far behind`);
		eq([required(WED, 0, [THU]), required(THU, 0, [THU]), required(FRI, 0, [THU]), required(FRI, 6, [THU])], [4.5, 4.5, 4.5, 4.5], "Thu off: 4.5 on every day, at any figure");
		eq([required(SAT, 0, offFor(4)), required(FRI, 0, offFor(4))], [3, 3], "four days off: three open days hold 3");
		const workweekOff = [MON, TUE, WED, THU, FRI];
		eq([required(SAT, 0, workweekOff), required(SUN, 0, workweekOff), required(MON, 0, workweekOff), required(FRI, 0, workweekOff)], [3, 3, 3, 3], "five days off, Sat and Sun open: 2 days hold exactly 3, whatever day he reads it");
		eq([required(SAT, 0, offFor(6)), required(FRI, 0, offFor(6)), required(FRI, 3, offFor(6))], [null, null, null], "six days off: 1 day can't hold 3, on any day, at any figure");
		eq([required(SAT, 0, offFor(7)), required(FRI, 0, offFor(7)), required(FRI, 3, offFor(7))], [null, null, null], "seven days off: no day to hold it, at any figure");
		// A closed week follows the same rule, whatever he reached.
		const closedOff = (n) => ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].slice(0, n);
		const closedRequired = (credits, n = 0) => week({ id: "last-week", start: "2026-10-31", end: "2026-11-06", deliveries: credits / p.CREDIT_WEIGHTS.delivery, offDays: closedOff(n) }).credits.required;
		eq([closedRequired(0), closedRequired(4), closedRequired(8)], [6, 6, 6], "a closed full week: 6 was required, whatever he reached");
		eq([closedRequired(0, 5), closedRequired(0, 6), closedRequired(0, 7), closedRequired(3, 6), closedRequired(3, 7)], [3, null, null, null, null], "a closed week with 6 or 7 days off couldn't hold what's required, whatever he reached");
		// Words only: reaching it, or being behind it, changes no figure, label or line.
		const atRequired = week({ today: FRI, deliveries: 12 });
		eq([atRequired.credits.value, atRequired.left, atRequired.percent, atRequired.pace, atRequired.newWeekNote], [6, 1.5, 80, "on-track", false], "at the required 6 on Friday: still 1.5 left, 80%, the label the pacing gives");
		eq(week({ today: FRI, deliveries: 11 }).pace, "needs-focus", "just below it, the label the pacing gives");
		eq(week({ today: WED, deliveries: 12 }).pace, "ahead", "and Wednesday at 6 is ahead, as the pacing says");
		const behind = week({ today: FRI, deliveries: 8 });
		eq([behind.credits.target, behind.credits.required, behind.left, behind.percent, behind.pace, behind.newWeekNote], [7.5, 6, 3.5, 53, "needs-focus", true], "behind on Friday at 4: the target, the required 6, what's left, the percent and the label all stand");
		const allOff = week({ today: FRI, deliveries: 8, offDays: offFor(7) });
		eq([allOff.credits.target, allOff.credits.required, allOff.left, allOff.percent, allOff.pace], [4.5, null, 0.5, 88, null], "no required figure takes nothing else with it: the target, what's left and the percent stand");

		// Approved days off: a lower target, and pacing over the days he can work.
		const oneOff =week({ offDays: ["2026-11-12"], deliveries: 6 });
		eq([oneOff.credits.target, oneOff.left, oneOff.percent, oneOff.pace], [6, 3, 50, "on-track"], "Thu off, today Wed: 6, and 2 working days left, so 3 is on pace");
		eq(week({ offDays: ["2026-11-07"], deliveries: 4 }).pace, "on-track", "Sat off, today Wed: 3 working days left of 6, so 1.5 by now, and 2 is on pace");
		eq(week({ offDays: ["2026-11-07"], deliveries: 2 }).pace, "needs-focus", "and 1 is below it");
		eq(week({ offDays: ["2026-11-07", "2026-11-08"], deliveries: 0 }).pace, "on-track", "two days off: 4.5, and 3 days hold it from nothing");
		eq(week({ offDays: ["2026-11-07"], deliveries: 12 }).pace, "ahead", "the lower target met is Ahead of Pace");
		const threeOff = week({ offDays: ["2026-11-07", "2026-11-08", "2026-11-09"], deliveries: 2 });
		eq([threeOff.credits.target, threeOff.pace], [4.5, null], "three or more days off: not below 4.5, and no label");

		// No label on a week he can't act on.
		eq(week({ openLoad: false }).pace, null, "0 credits and no open load: no label, since loads depend on dispatch");
		eq(week({ openLoad: true }).pace, "needs-focus", "0 credits on Wednesday with a load in his name reads Needs Focus");
		eq(week({ openLoad: false, pickups: 1 }).pace, "needs-focus", "any credit, and the label shows");
		const offThrough = week({ today: "2026-11-12", offDays: ["2026-11-12", "2026-11-13"], deliveries: 6 });
		eq([offThrough.credits.target, offThrough.pace], [4.5, null], "off through Friday, below his target: no day left to ask for, so no label");
		eq(week({ today: "2026-11-12", offDays: ["2026-11-12", "2026-11-13"], deliveries: 10 }).pace, "ahead", "off through Friday with the target met keeps the good news");

		// "A new week starts Saturday", once more is left than the days hold.
		eq(week({ deliveries: 6 }).newWeekNote, false, "4.5 left on Wednesday fits 3 days at 1.5");
		eq(week({ deliveries: 5 }).newWeekNote, true, "5 left doesn't");
		eq(week({ today: "2026-11-13", deliveries: 12 }).newWeekNote, false, "1.5 left on Friday fits");
		eq(week({ today: "2026-11-13", deliveries: 11 }).newWeekNote, true, "2 left on Friday doesn't");
		eq(week({ deliveries: 18 }).newWeekNote, false, "nothing left, no note");
		for (const today of ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]) {
			eq(week({ today }).nextWeekStarts, "Nov 14", `read on ${today}: the Saturday after this week's Friday`);
		}
		const startsAfter = (start, end, today) => p.personalWeek({ id: "this-week", start, end, today, deliveries: 0, pickups: 0, loads: [], offDays: [], openLoad: true }).nextWeekStarts;
		eq(startsAfter("2026-10-31", "2026-11-06", "2026-11-05"), "Nov 7", "Thu Nov 5: Saturday, Nov 7, over the change of clocks");
		eq(startsAfter("2026-10-24", "2026-10-30", "2026-10-28"), "Oct 31", "a week ending in the same month's last days");
		eq(startsAfter("2026-12-26", "2027-01-01", "2026-12-30"), "Jan 2", "and across the year's end");

		// Last week is its final figure.
		const closed = week({ id: "last-week", start: "2026-10-31", end: "2026-11-06", deliveries: 8 });
		eq([closed.credits.value, closed.percent, closed.left, closed.pace, closed.newWeekNote, closed.nextWeekStarts], [4, 53, null, null, false, null], "a closed week: the figure and percent, nothing left, no label, no coming Saturday");

		// One counted load.
		eq(p.countedLoad({ loadId: " DP-1 ", pickupDay: "2026-11-09", deliveryDay: "2026-11-10" }), { loadId: "DP-1", pickup: { day: "Mon", credits: 0.5 }, delivery: { day: "Tue", credits: 0.5 } }, "both credits, each with its day");
		eq(p.countedLoad({ loadId: "DP-2", pickupDay: "2026-11-07", deliveryDay: "" }), { loadId: "DP-2", pickup: { day: "Sat", credits: 0.5 }, delivery: null }, "a pickup alone");
		eq(p.countedLoad({ loadId: "DP-3", pickupDay: "", deliveryDay: "2026-11-13", pickupNote: "last-week" }), { loadId: "DP-3", pickup: { note: "last-week" }, delivery: { day: "Fri", credits: 0.5 } }, "a delivery whose pickup counted last week");
		eq(p.countedLoad({ loadId: null, pickupDay: "", deliveryDay: "2026-11-08" }), { loadId: "", pickup: { note: "not-counted" }, delivery: { day: "Sun", credits: 0.5 } }, "no Load ID in the cell, and no pickup that counted");

		// A lowered target is flagged, on the open week only: its one line says "this week".
		eq(week({}).targetLowered, false, "no day off: not flagged");
		eq(week({ offDays: ["2026-11-12"] }).targetLowered, true, "an approved day off: flagged");
		eq(week({ offDays: ["2026-11-07", "2026-11-08", "2026-11-09"] }).targetLowered, true, "at the floor too");
		eq(week({ id: "last-week", start: "2026-10-31", end: "2026-11-06", offDays: ["2026-11-02"] }).targetLowered, false, "a closed week is never flagged, whatever it held");
		eq(week({ id: "last-week", start: "2026-10-31", end: "2026-11-06", offDays: ["2026-11-02"] }).credits.target, 6, "though its own target stays its own");
		eq(Object.keys(p.countedLoad({ loadId: "DP-4", driverName: "Casey Example", broker: "Decoy", rate: 123 })), ["loadId", "pickup", "delivery"], "exactly three keys, whatever it is handed");
		eq(p.personalExclusion({ status: "active", ownerOperator: false }), null, "active: in");
		eq(p.personalExclusion({ status: "Active ", ownerOperator: false }), null, "read case- and space-blind");
		eq(p.personalExclusion({ status: "pending", ownerOperator: false }), "inactive", "pending: out");
		eq(p.personalExclusion({ status: "active", ownerOperator: true }), "owner-operator", "an owner-operator: out");
	});

	await section("21 the board is absent to drivers", async () => {
		if (!on || !boardOn) throw new Error("no world");
		const off = await makeWorld({ DRIVER_PERFORMANCE_ENABLED: "false" });
		const killSwitch = await off.get("/api/driver/performance/leaderboard", USERS.ada);
		await off.close();
		on.handle.clearCache();
		const readsBefore = on.sheetReads;
		for (const who of ["ada", "ben", "eli", "fay", "gus", "ivy", "nobody"]) {
			for (const route of ["/api/driver/performance/leaderboard", "/api/driver/performance/leaderboard?period=week", "/api/driver/performance/leaderboard?period=month", "/api/driver/performance/leaderboard?period=year"]) {
				const r = await on.get(route, USERS[who]);
				ok(r.status === 404 && r.text === killSwitch.text, `${route} for ${who} answers exactly as the kill switch does`, `got ${r.status} ${r.text.slice(0, 80)}`);
			}
		}
		eq(on.sheetReads, readsBefore, "and reads nothing");
		for (const value of ["1", "yes", "on", "TRUE", " true", "false", ""]) {
			const w = await makeWorld({ DRIVER_PERFORMANCE_BOARD_ENABLED: value });
			const r = await w.get("/api/driver/performance/leaderboard", USERS.ada);
			eq(r.status, 404, `the board flag ${JSON.stringify(value)} stays off`);
			await w.close();
		}
		// The office view: the same answers, flag or no flag.
		const flagged = await makeWorld({ DRIVER_PERFORMANCE_BOARD_ENABLED: "true" });
		try {
			for (const route of ["/api/driver/performance/leaderboard?period=week", "/api/driver/performance/leaderboard?period=month", "/api/admin/driver-performance?period=week", "/api/admin/driver-performance?period=month"]) {
				const flagOff = await on.get(route, USERS.admin2);
				const flagOn = await flagged.get(route, USERS.admin2);
				eq(flagOff.status, 200, `${route} answers the Super Admin`);
				eq(flagOff.text, flagOn.text, `${route} is the same with the flag off and on`);
			}
		} finally {
			await flagged.close();
		}
		const asAdmin = await on.get("/api/driver/performance/leaderboard?period=week", USERS.admin2);
		eq(asAdmin.json.boards[0].categories[0].rows.map((r) => r.unitLabel), ["#501", "#502", "#504 (2)", "#503", "#504 (1)"], "the Super Admin keeps the ranked board");
		const routesSrc = fs.readFileSync(path.join(ROOT, "lib", "driver-performance-routes.js"), "utf8");
		const ownHandler = routesSrc.slice(routesSrc.indexOf("app.get(PATHS.own"), routesSrc.indexOf("app.get(PATHS.board"));
		ok(ownHandler.length > 0 && !/onAnyBoard|rankEntries|projectCategory|\.ranked\b|\.report\b/.test(ownHandler), "the own route reads no ranking");
		const ownBody = (routesSrc.match(/\tfunction ownAnswer\([\s\S]*?\n\t}\n/) || [""])[0];
		ok(ownBody.length > 0 && !/onAnyBoard|rankEntries|projectCategory|\.ranked\b|\.report\b|\.rank\b/.test(ownBody), "nor does the answer it builds, which the Super Admin's page shows each driver");
		ok(!/\.ranked\b|\.report\b|rank\b/.test(fs.readFileSync(path.join(ROOT, "lib", "driver-performance.js"), "utf8").match(/function personalWeek[\s\S]*?\n}\n/)?.[0] || "rank"), "nor does the week it answers with");
	});

	await section("22 who gets his own week", async () => {
		if (!on) throw new Error("no world");
		// A percentage driver gets the personal view: it counts loads and touches no pay.
		const eli = await on.get("/api/driver/me/performance", USERS.eli);
		eq(eli.status, 200, "a percentage driver on a truck: his own week");
		eq(eli.json.weeks[0].credits, { value: 2, target: 7.5, required: 6, deliveries: 4, pickups: 0 }, "and his count");
		// Held a countable truck, or has a counted load, this week or last.
		for (const who of ["ada", "dee", "hal", "jo", "kim"]) eq((await on.get("/api/driver/me/performance", USERS[who])).status, 200, `${who}: yes`);
		eq((await on.get("/api/driver/me/performance", USERS.jo)).json.weeks[0].credits.deliveries, 1, "a test unit's driver with a counted load: yes");
		const refused = await on.get("/api/driver/me/performance", USERS.fay);
		eq([refused.status, refused.json.code], [404, "NOT_ELIGIBLE"], "an owner-operator: no");
		for (const who of ["gus", "nobody", "ivy"]) {
			const r = await on.get("/api/driver/me/performance", USERS[who]);
			ok(r.status === 404 && r.text === refused.text, `${who}: the same 404, with no word why`, `got ${r.status} ${r.text.slice(0, 80)}`);
		}
		// Two weeks on, nothing held and nothing counted in either week: no tab, no bar.
		const later = await makeWorld({}, { nowMs: Date.parse("2026-11-25T17:00:00Z") });
		try {
			const dee = await later.get("/api/driver/me/performance", USERS.dee);
			ok(dee.status === 404 && dee.text === refused.text, "a driver whose truck and loads are older than both weeks: the same 404", `got ${dee.status}`);
			const hal = await later.get("/api/driver/me/performance", USERS.hal);
			eq([hal.status, hal.json.weeks[0].credits.value, hal.json.weeks[0].loads, hal.json.weeks[0].pace], [200, 0, [], null], "one still on a truck, with no load yet: his week at 0, no label");
		} finally {
			await later.close();
		}
		// Held a truck last week only: his week still answers, this week at 0.
		const lastOnly = await makeWorld({}, { nowMs: Date.parse("2026-12-01T17:00:00Z") });
		try {
			lastOnly.db.prepare("UPDATE truck_assignments SET end_date = ? WHERE driver_name = ?").run("2026-11-25T15:00:00.000Z", "Dee Stone");
			lastOnly.db.prepare("DELETE FROM truck_assignments WHERE driver_name = ?").run("Hal Briar");
			eq((await lastOnly.get("/api/driver/me/performance", USERS.dee)).status, 200, "held a truck last week only: yes");
		} finally {
			await lastOnly.close();
		}
		// A load in his name decides the label, and a truck decides the door.
		const withOpen = await makeWorld({}, { nowMs: Date.parse("2026-11-25T17:00:00Z"), extraLoads: [["DP-8001", "Hal Briar", "Assigned", ""]] });
		try {
			const hal = await withOpen.get("/api/driver/me/performance", USERS.hal);
			eq([hal.json.weeks[0].credits.value, hal.json.weeks[0].pace], [0, "needs-focus"], "0 credits on a Wednesday with a load in his name reads Needs Focus");
		} finally {
			await withOpen.close();
		}
	});

	await section("23 privacy", async () => {
		if (!on) throw new Error("no world");
		on.handle.clearCache();
		const asOf = async (who, query = "") => on.get(`/api/driver/me/performance${query}`, USERS[who]);
		const loadsOf = (driver) => LOADS.filter((l) => l[1].replace(/\s+/g, " ") === driver).map((l) => l[0].replace(/^#/, ""));
		const everyLoad = LOADS.map((l) => l[0].replace(/^#/, ""));
		for (const [who, name] of [["ada", "Ada Quill"], ["ben", "Ben Marsh"], ["cal", "Cal Reyes"], ["dee", "Dee Stone"], ["hal", "Hal Briar"], ["eli", "Eli North"]]) {
			const r = await asOf(who);
			const mine = new Set(loadsOf(name));
			const ids = r.json.weeks.flatMap((w) => w.loads.map((l) => l.loadId.replace(/^#/, "")));
			ok(ids.length > 0 && ids.every((id) => mine.has(id)), `${who}: every row is a load in his own name`, JSON.stringify(ids));
			const foreign = everyLoad.filter((id) => !mine.has(id) && r.text.includes(id));
			eq(foreign, [], `${who}: no other driver's load`);
			const others = ALL_NAMES.flatMap((n) => [n, ...n.split(" ")]).filter((n) => new RegExp(`\\b${n}\\b`, "i").test(r.text));
			eq(others, [], `${who}: no name at all, his own included`);
			eq(DECOY_CELL_MARKS.filter((m) => r.text.includes(m)), [], `${who}: no broker, rate, pay or lane cell`);
			ok(!/#50\d|LogisX|Unit not shown/i.test(r.text), `${who}: no unit`);
			ok(!/"rank"|"isYou"|"listed"|"unitLabel"|"display"/.test(r.text), `${who}: no rank or board field`);
			for (const w of r.json.weeks) for (const l of w.loads) eq(Object.keys(l), ["loadId", "pickup", "delivery"], `${who}: exactly three keys on a row`);
		}
		// From the session only: nothing in the path or query names a driver.
		const plain = await asOf("ben");
		for (const q of ["?driver=Ada%20Quill", "?driverName=Ada%20Quill", "?as_user_id=11", "?user=ada", "?viewer=1"]) {
			eq((await asOf("ben", q)).text, plain.text, `${q} changes nothing`);
		}
		// Two drivers asking at once: one shared snapshot, one slice each.
		on.handle.clearCache();
		const together = await Promise.all(["ada", "ben", "cal", "dee", "hal", "ada", "ben"].map((who) => asOf(who)));
		const alone = {};
		for (const who of ["ada", "ben", "cal", "dee", "hal"]) alone[who] = (await asOf(who)).text;
		["ada", "ben", "cal", "dee", "hal", "ada", "ben"].forEach((who, i) => eq(together[i].text, alone[who], `at once, ${who} (${i + 1} of 7) reads exactly what he reads alone`));
		// A row his Driver cell no longer names isn't his: the sheet decides, per request.
		const moved = await makeWorld({}, { extraLoads: [["DP-8002", "Ben Marsh", "Delivered", "2026-11-11 08:00"]] });
		try {
			const ada = await moved.get("/api/driver/me/performance", USERS.ada);
			const ben = await moved.get("/api/driver/me/performance", USERS.ben);
			ok(!ada.text.includes("DP-8002"), "another driver's newest load stays out of Ada's answer");
			ok(ben.text.includes("DP-8002"), "and shows in his own");
		} finally {
			await moved.close();
		}
	});

	await section("24 approved days off over HTTP", async () => {
		const addOff = (world, directoryId, driver, from, to, status = "approved") => world.db.prepare(
			`INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, created_by, created_at, request_status)
			 VALUES (?, ?, 'vacation', ?, ?, 'made-up', '2026-11-01T12:00:00Z', ?)`,
		).run(directoryId, driver, from, to, status);
		const w = await makeWorld({ DRIVER_AVAILABILITY_ENABLED: "true" });
		const offFlag = await makeWorld({});
		try {
			addOff(w, 2, "Ben Marsh", "2026-11-12", "2026-11-12");
			addOff(w, 3, "Cal Reyes", "2026-11-12", "2026-11-12", "requested");
			addOff(w, 1, "Ada Quill", "2026-11-02", "2026-11-03");
			addOff(w, 8, "Hal Briar", "2026-11-07", "2026-11-09");
			addOff(offFlag, 2, "Ben Marsh", "2026-11-12", "2026-11-12");
			const week = async (world, who) => (await world.get("/api/driver/me/performance", USERS[who])).json.weeks;
			const ben = await week(w, "ben");
			eq([ben[0].credits.target, ben[0].left, ben[0].percent, ben[0].pace], [6, 4, 33, "needs-focus"], "Ben's approved Thursday off: 2 of 6, and 2 working days left, so 3 by now is on pace and 2 is below it");
			eq(ben[0].credits.required, 4.5, "and 4.5 is required that week");
			eq([ben[1].credits.target, ben[1].credits.required], [7.5, 6], "last week's figures are its own");
			eq([ben[0].targetLowered, ben[1].targetLowered], [true, false], "the server flags his lowered target, this week only");
			eq((await week(w, "cal"))[0].credits.target, 7.5, "a request still waiting changes nothing");
			eq((await week(w, "cal"))[0].targetLowered, false, "and flags nothing");
			const ada = await week(w, "ada");
			eq([ada[0].credits.target, ada[1].credits.target], [7.5, 4.5], "days off last week lower last week only");
			eq([ada[0].credits.required, ada[1].credits.required], [6, 3], "and what was required that week, 1.5 below its target");
			eq([ada[0].targetLowered, ada[1].targetLowered], [false, false], "and a closed week flags nothing");
			const hal = await week(w, "hal");
			eq([hal[0].credits.target, hal[0].credits.required, hal[0].pace, hal[0].targetLowered], [4.5, 3, null, true], "three days off: 4.5, 3 required, no label, and flagged");
			eq((await week(offFlag, "ben"))[0].credits.target, 7.5, "with availability off, its rows stay inert");
			eq((await week(offFlag, "ben"))[0].targetLowered, false, "and flag nothing");
		} finally {
			await w.close();
			await offFlag.close();
		}
	});

	await section("25 what became of a pickup; nothing of how he is paid", async () => {
		const w = await makeWorld({}, { extraLoads: [
			["DP-8013", "Ben Marsh", "Delivered", "2026-11-10 09:00"],
			["DP-8014", "Ada Quill", "Delivered", "2026-11-10 09:00"],
			["DP-8015", "Ben Marsh", "Delivered", "2026-11-03 09:00"],
			["DP-8016", "Ben Marsh", "Delivered", "2026-11-10 10:00"],
		] });
		try {
			const addHistory = w.db.prepare("INSERT INTO load_status_history (load_id, source, new_status, changed_at) VALUES (?, ?, 'In Transit', ?)");
			// Older than both weeks, on a truck with no ELD (Ben) and on one with a reporting ELD (Ada).
			addHistory.run("dp-8013", "manual", "2026-10-20 15:00:00");
			addHistory.run("dp-8014", "manual", "2026-10-20 15:00:00");
			addHistory.run("dp-8015", "manual", "2026-10-20 15:00:00");
			// A dispatcher's tap, older still: the same words, whoever tapped.
			addHistory.run("dp-8016", "override", "2026-10-12 15:00:00");
			const answerOf = async (who) => (await w.get("/api/driver/me/performance", USERS[who])).json;
			const eli = await answerOf("eli");
			const ada = await answerOf("ada");
			const ben = await answerOf("ben");
			// No reader on his screen, so no word of it in his answer, whatever he is paid.
			for (const [who, body] of [["a percentage driver", eli], ["a day-rate driver", ada]]) ok(!Object.hasOwn(body, "invoicePaysDays"), `${who}'s answer says nothing of his invoice`);
			const routesSrc = fs.readFileSync(path.join(ROOT, "lib", "driver-performance-routes.js"), "utf8");
			ok(!/invoicePaysDays|directoryPayStruct/.test(routesSrc), "and the route reads nothing of what his invoice pays");

			// What became of a pickup: true whichever way it was made.
			const rowOf = (body, i, id) => body.weeks[i].loads.find((l) => l.loadId === id);
			eq(rowOf(ben, 0, "DP-8013"), { loadId: "DP-8013", pickup: { note: "not-counted" }, delivery: { day: "Tue", credits: 0.5 } }, "an older tap on a truck with no ELD: not counted this week");
			eq(rowOf(ada, 0, "DP-8014"), { loadId: "DP-8014", pickup: { note: "not-counted" }, delivery: { day: "Tue", credits: 0.5 } }, "an older tap on a truck with an ELD: the same");
			eq(rowOf(ben, 1, "DP-8015"), { loadId: "DP-8015", pickup: { note: "not-counted" }, delivery: { day: "Tue", credits: 0.5 } }, "and on last week's list");
			eq(rowOf(ben, 0, "DP-8016"), { loadId: "DP-8016", pickup: { note: "not-counted" }, delivery: { day: "Tue", credits: 0.5 } }, "a dispatcher's older tap: the same");
			const all = JSON.stringify([eli, ada, ben]);
			ok(!/not-recorded/.test(all), "no answer says a pickup wasn't recorded: the server can't know that of an older tap");
			eq(ben.weeks[0].credits.pickups, ben.weeks[0].loads.filter((l) => l.pickup.credits).length, "and the older taps add no credit");
		} finally {
			await w.close();
		}
	});

	await section("26 the count's weights: the office's figures, and no path that pays", async () => {
		if (!on) throw new Error("no world");
		// The office reads the same weights: its credit figure moves, and its counts and ranks don't.
		on.handle.clearCache();
		const report = (await on.get("/api/admin/driver-performance?period=week", USERS.admin2)).json.boards[0].drivers.filter((x) => x.listed);
		eq(report.map((x) => [x.name, x.loads, x.pickups.total, x.credits]), [
			["Ada Quill", 3, 3, 3], ["Ben Marsh", 2, 2, 2], ["Hal Briar", 2, 0, 1], ["Cal Reyes", 1, 1, 1], ["Dee Stone", 1, 0, 0.5],
		], "the report's credits are the new count; its loads and pickups are the counts they were");
		const board = (await on.get("/api/driver/performance/leaderboard?period=week", USERS.admin2)).json.boards[0].categories[0].rows;
		eq(board.map((r) => [r.rank, r.value, r.display]), [[1, 3, "3 loads"], [2, 2, "2 loads"], [2, 2, "2 loads"], [4, 1, "1 load"], [4, 1, "1 load"]], "the board's Most loads is delivered loads: no weight reaches its figure or rank");

		// Display only: whatever pays must not be able to read the weights or a week built from them.
		lifted();
		const NAMES = /\b(CREDIT_WEIGHTS|creditWeights|loadCredits|countedLoad|personalWeek)\b/;
		const libFiles = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => /\.(js|cjs|mjs)$/.test(f));
		const inLib = (re) => libFiles.filter((f) => re.test(fs.readFileSync(path.join(ROOT, "lib", f), "utf8"))).sort();
		eq(inLib(/require\(\s*["'][^"']*driver-performance(\.js)?["']\s*\)/), ["driver-performance-routes.js", "driver-pickup-proof.js"], "only this feature's routes and its pickup proof require the rules module");
		eq(inLib(NAMES), ["driver-performance-routes.js", "driver-performance.js"], "and nothing else in lib/ names the weights or the count");
		eq(SRC.match(/require\(\s*["'][^"']*driver-performance[^"']*["']\s*\)/g), ['require("./lib/driver-performance-routes")'], "server.js requires the routes and nothing else of this feature");
		ok(!NAMES.test(SRC), "and names neither the weights nor the count");
		eq((SRC.match(/\bdriverPerformance\b/g) || []).length, 1, "its mount is declared and never read, so a figure leaves the routes only as their answers");
		const { STATEMENT_TEMPLATE_FILES } = require(path.join(ROOT, "lib", "statement-template-hash.js"));
		eq(STATEMENT_TEMPLATE_FILES.filter((f) => /driver-performance/.test(f)), [], "no stored statement's template holds this feature");
	});

	// ── a small world for one case: two made-up drivers, each with his own truck and no ELD days,
	// and nothing on record for them but what the case writes ────────────────
	const OWN_WEEK = "/api/driver/me/performance";
	const ADMIN_WEEK = "/api/admin/driver-performance?period=week";
	const SUN = "2026-11-08"; const MON = "2026-11-09"; const TUE = "2026-11-10";
	const LAST_THU = "2026-11-05"; const LAST_FRI = "2026-11-06";
	const THIS_WEEK = ["2026-11-07", "2026-11-13"]; const LAST_WEEK = ["2026-10-31", "2026-11-06"];
	const PICKED = (day) => ({ day, credits: 0.5 });
	const DONE = (day) => ({ day, credits: 0.5 });
	const NOT_COUNTED = { note: "not-counted" };
	const NIA = "Nia Frost"; const OMAR = "Omar Hale";
	const AS_DRIVER = { role: "Driver" }; const AS_STAFF = { role: "Dispatcher" };
	const CONTACT_ID = "12345 555-867-5309"; const CONTACT = "555-867-5309";
	async function proofWorld(setup, { nowMs } = {}) {
		const w = await makeWorld({}, { nowMs, extraLoads: [] });
		const dir = w.db.prepare("INSERT INTO drivers_directory (id, driver_name, status, pay_type, user_id) VALUES (?, ?, 'active', 'fixed', ?)");
		dir.run(21, NIA, 61);
		dir.run(22, OMAR, 62);
		const tr = w.db.prepare("INSERT INTO trucks (id, unit_number, retired_at) VALUES (?, ?, '')");
		tr.run(21, "LogisX-#521");
		tr.run(22, "LogisX-#522");
		const ta = w.db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, '2026-10-01T12:00:00.000Z', '')");
		ta.run(21, NIA);
		ta.run(22, OMAR);
		const hist = w.db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, actor_role, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
		w.hist = (load, source, status, at, actor, { old = "", role = "" } = {}) => hist.run(String(load).toLowerCase().replace(/^#/, ""), old, status, source, actor, role, at);
		w.row = (id, driver, status, done = "", phone = "") => w.extraLoads.push([id, driver, status, done, phone]);
		// A load's arrival and departure by the truck's geofence, which writes only for the load's driver then.
		w.picked = (id, day, actor) => {
			w.hist(id, "geofence", "At Shipper", `${day} 13:00:00`, actor);
			w.hist(id, "geofence", "In Transit", `${day} 14:00:00`, actor);
		};
		w.accepted = (id, day, actor, facts = AS_DRIVER) => w.hist(id, "accept", "Assigned", `${day} 09:00:00`, actor, { old: "Dispatched", ...facts });
		w.depart = (load, ms, truck = 0) => w.db.prepare("INSERT INTO load_eld_miles (load_id, truck_id, pickup_depart_ms) VALUES (?, ?, ?)").run(String(load).toLowerCase().replace(/^#/, ""), truck, ms);
		w.eldOn = (truck, day = MON) => w.db.prepare("INSERT INTO eld_miles_daily (routemate_vehicle_id, local_day, truck_id, miles, samples) VALUES (?, ?, ?, 100, 40)").run(`rm-${truck}`, day, truck);
		w.weeks = async (who) => (await w.get(OWN_WEEK, USERS[who])).json.weeks;
		w.pickups = async (i = 0) => [(await w.weeks("nia"))[i].credits.pickups, (await w.weeks("omar"))[i].credits.pickups];
		// What the weekly invoice bills him, by its own selector over every row of the sheet.
		w.invoiceBills = (name, [start, end]) => {
			const raw = w.fns.parseSheet({ values: sheetValues(w.extraLoads) });
			return w.fns.selectInvoiceWeekLoads(raw.data, raw.headers, name, start, end, w.fns.loadKeySet(w.fns.getDeletedLoadIds())).loads;
		};
		setup(w);
		return w;
	}
	const inWorld = async (setup, check, opts) => {
		const w = await proofWorld(setup, opts);
		try { await check(w); } finally { await w.close(); }
	};
	const proofModule = () => require(path.join(ROOT, "lib", "driver-pickup-proof.js"));

	await section("27 a load on two sheet rows counts as the invoice counts it; its pickup stays as live", async () => {
		const delivered = ["PF-60", NIA, "Delivered", `${TUE} 15:00`];
		for (const [says, rows, pickups, pickup] of [
			["one row, delivered (the control)", [delivered], 1, PICKED("Mon")],
			["an open row above a delivered copy", [["PF-60", NIA, "In Transit", ""], delivered], 1, PICKED("Mon")],
			["delivered, with a cancelled copy below: the live count has no such load", [delivered, ["#PF-60", NIA, "Cancelled", ""]], 0, NOT_COUNTED],
			["delivered, with an open copy below", [delivered, ["PF-60", NIA, "Dispatched", ""]], 1, PICKED("Mon")],
			["delivered, with a copy below naming no driver yet: the live count gives that row nobody", [delivered, ["PF-60", "", "Unassigned", ""]], 0, NOT_COUNTED],
			["delivered by her, with a copy below naming another driver: the live count gives it him", [delivered, ["PF-60", OMAR, "Dispatched", ""]], 0, NOT_COUNTED],
			["delivered and dated, with a delivered copy below with no date", [delivered, ["PF-60", NIA, "Delivered", ""]], 1, PICKED("Mon")],
			["delivered with no date, with a delivered and dated copy below", [["PF-60", NIA, "Delivered", ""], delivered], 1, PICKED("Mon")],
			["spelled two ways, both delivered", [["#PF-60", NIA, "Delivered", `${TUE} 15:00`], delivered], 1, PICKED("Mon")],
		]) {
			await inWorld((w) => {
				w.picked("PF-60", MON, NIA);
				for (const r of rows) w.row(...r);
			}, async (w) => {
				const nia = (await w.weeks("nia"))[0];
				eq([nia.credits.deliveries, nia.credits.pickups], [1, pickups], `${says}: 1 delivery and ${pickups} pickup`);
				eq([nia.loads.length, nia.loads[0] && nia.loads[0].pickup, nia.loads[0] && nia.loads[0].delivery], [1, pickup, DONE("Tue")], `${says}: one row`);
				eq(nia.credits.deliveries, w.invoiceBills(NIA, THIS_WEEK).length, `${says}: what her invoice bills`);
			});
		}
		await inWorld((w) => {
			w.picked("PF-61", MON, NIA);
			w.row("PF-61", NIA, "Delivered", `${TUE} 15:00`);
			w.row("PF-61", OMAR, "Dispatched");
		}, async (w) => {
			const omar = (await w.weeks("omar"))[0];
			eq([omar.credits.deliveries, omar.credits.pickups], [0, 1], "the driver the copy below names keeps the live count's pickup, and no delivery");
			eq(w.invoiceBills(OMAR, THIS_WEEK).length, 0, "as his invoice bills it");
		});
		await inWorld((w) => {
			w.picked("PF-62", LAST_THU, NIA);
			w.row("PF-62", NIA, "Delivered", `${LAST_FRI} 15:00`);
			w.row("PF-62", NIA, "Delivered", `${TUE} 15:00`);
		}, async (w) => {
			const nia = await w.weeks("nia");
			eq(nia.map((x) => x.credits.deliveries), [w.invoiceBills(NIA, THIS_WEEK).length, w.invoiceBills(NIA, LAST_WEEK).length], "two delivered rows in two weeks: each week as that week's invoice bills it");
			eq(nia.map((x) => x.credits.pickups), [0, 1], "and one pickup, in the week it was made");
		});
		await inWorld((w) => {
			w.picked("PF-63", MON, NIA);
			w.row("PF-63", NIA, "Delivered", `${TUE} 15:00`);
			w.row("PF-63", OMAR, "Delivered", `${TUE} 16:00`);
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.deliveries, (await w.weeks("omar"))[0].credits.deliveries], [1, 1], "two delivered rows naming two drivers: each as his own invoice bills it");
			eq([w.invoiceBills(NIA, THIS_WEEK).length, w.invoiceBills(OMAR, THIS_WEEK).length], [1, 1], "which is what those invoices do");
			eq(await w.pickups(), [0, 1], "and the pickup is one driver's, the bottom row's, as live");
			eq((await w.weeks("nia"))[0].loads[0]?.pickup, NOT_COUNTED, "her row says the pickup didn't count for her, not that it fell in another week");
		});
		await inWorld((w) => {
			w.picked("PF-64", MON, NIA);
			w.row("PF-64", NIA, "In Transit");
			w.row("#PF-64", NIA, "Cancelled");
		}, async (w) => {
			const nia = (await w.weeks("nia"))[0];
			eq([nia.credits.value, nia.loads], [0, []], "an open row above a cancelled copy: the load reads cancelled, as his load list has it, and earns nothing");
			eq(w.invoiceBills(NIA, THIS_WEEK).length, 0, "and his invoice bills nothing");
		});
		await inWorld((w) => {
			w.picked("PF-65", MON, NIA);
			w.row("PF-65", NIA, "Delivered", `${TUE} 15:00`);
			w.row("#PF-65", NIA, "Delivered", `${TUE} 15:00`);
			w.db.prepare("INSERT INTO deleted_loads (load_id) VALUES ('pf-65')").run();
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.value, 0, "soft-deleted on both rows: nothing");
			eq(w.invoiceBills(NIA, THIS_WEEK).length, 0, "and nothing on the invoice");
		});
		for (const [how, done] of [["dated in a week long past", "2026-10-02 15:00"], ["with no date", ""]]) {
			await inWorld((w) => {
				w.picked("PF-66", MON, NIA);
				w.row("PF-66", NIA, "Delivered", done);
				w.row("#PF-66", NIA, "Cancelled");
			}, async (w) => {
				const nia = (await w.weeks("nia"))[0];
				eq([nia.credits.deliveries, nia.credits.pickups], [0, 0], `delivered ${how}, a cancelled copy below: no delivery this week, as his invoice has it, and no pickup, as live`);
				eq(w.invoiceBills(NIA, THIS_WEEK).length, 0, `delivered ${how}: nothing on this week's invoice`);
			});
		}
		await inWorld((w) => {
			w.picked("PF-67", MON, NIA);
			w.row("#PF-67", NIA, "Delivered", `${TUE} 15:00`);
			w.row("PF-67", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.loadId), ["#PF-67"], "a row of both credits shows the ID as the invoice's row spells it");
		});
		await inWorld((w) => {
			w.picked("PF-72", MON, NIA);
			w.row("PF-72", NIA, "Delivered", `${MON} 15:00`);
			w.row("PF-72", NIA, "Delivered", `${TUE} 15:00`);
		}, async (w) => {
			const nia = (await w.weeks("nia"))[0];
			eq([nia.credits.deliveries, nia.loads[0].delivery], [1, DONE("Tue")], "two delivered rows in one week: one delivery, on the day of the last billable row");
			eq(w.invoiceBills(NIA, THIS_WEEK).map((r) => r["Status Update Date"]), [`${TUE} 15:00`], "which is the invoice's own choice");
		});
		await inWorld((w) => {
			w.row("PF-73", NIA, "Cancelled");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].pace, null, "a cancelled row is no open load, though every row is read now: no label at 0");
		});
		await inWorld((w) => {
			w.db.prepare("UPDATE trucks SET unit_number = 'Wal-7' WHERE id = 21").run();
			w.row("PF-74", "Walt Ames", "Cancelled");
		}, async (w) => {
			const report = (await w.get(ADMIN_WEEK, USERS.admin2)).json.boards[0].drivers;
			eq(report.find((x) => x.name === NIA).unitLabel, "#WAL-7", "the office's unit label doesn't change for a name on a dropped row");
		});
		await inWorld((w) => {
			w.picked("PF-80", MON, NIA);
			w.row("PF-80", NIA, "Delivered", `${TUE} 15:00`);
			w.row("#PF-80", NIA, "Cancelled");
		}, async (w) => {
			for (const period of ["week", "month"]) {
				const nia = (await w.get(`/api/admin/driver-performance?period=${period}`, USERS.admin2)).json.boards[0].drivers.find((x) => x.name === NIA);
				eq(nia.loads, 1, `the office's ${period} reads a load on two rows as the driver does`);
			}
			const nia = (await w.get(ADMIN_WEEK, USERS.admin2)).json.boards[0].drivers.find((x) => x.name === NIA);
			eq([nia.pickups.total, nia.credits], [0, 0.5], "with its pickup as live");
		});

		// The read every caller shares: the route answers the same with it, its rows and the kept rows frozen.
		await inWorld((w) => {
			w.accepted(CONTACT_ID, MON, NIA);
			w.picked(CONTACT_ID, MON, NIA);
			w.row(CONTACT_ID, NIA, "Dispatched");
			w.row(CONTACT_ID, OMAR, "Delivered", `${TUE} 15:00`);
			w.picked("PF-75", MON, OMAR);
			w.row("PF-75", OMAR, "Delivered", `${TUE} 15:00`);
			w.row("#PF-75", OMAR, "Cancelled");
		}, async (w) => {
			const before = (await w.get(OWN_WEEK, USERS.nia)).text + (await w.get(OWN_WEEK, USERS.omar)).text;
			const everyRow = w.fns.everyJobTrackingRow ? w.fns.everyJobTrackingRow(w.jt) : [];
			for (const row of [...w.jt.data, ...everyRow]) Object.freeze(row);
			Object.freeze(everyRow);
			Object.freeze(w.jt.data);
			Object.freeze(w.jt.headers);
			Object.freeze(w.jt);
			w.handle.clearCache();
			const nia = await w.get(OWN_WEEK, USERS.nia);
			const omar = await w.get(OWN_WEEK, USERS.omar);
			eq([nia.status, omar.status], [200, 200], "the route reads the shared read and writes nothing to it: frozen, it still answers");
			eq(nia.text + omar.text, before, "and answers the same");
		});

		// The real read, on a stubbed sheet: only this route looks at what it keeps.
		lifted();
		const { closure } = require("./lib/server-lift");
		const lift = closure(SRC, {
			roots: ["getJobTrackingCached", "jtCacheInvalidate", "everyJobTrackingRow", "liveJobTrackingView", "parseSheet"],
			provided: ["db", "getSheets", "SPREADSHEET_ID"],
			denied: ["server", "transporter", "getDrive", "sendEmail"],
		});
		const values = [["Load ID", "Driver", "Job Status"], ["PF-70", NIA, "Delivered"], ["#PF-70", NIA, "Cancelled"], ["PF-71", OMAR, "In Transit"]];
		let reads = 0;
		const getSheets = async () => ({ spreadsheets: { values: { get: async () => { reads += 1; return { data: { values } }; } } } });
		const real = new Function("db", "getSheets", "SPREADSHEET_ID", "require", "console", "process", "__dirname", ['"use strict";', lift.text,
			"return { getJobTrackingCached, jtCacheInvalidate, everyJobTrackingRow, liveJobTrackingView, parseSheet };"].join("\n"))(
			makeDb(), getSheets, "made-up-sheet", createRequire(path.join(ROOT, "server.js")), { log() {}, info() {}, warn() {}, error() {} }, { env: {}, argv: [], cwd: () => ROOT }, ROOT);
		const read = await real.getJobTrackingCached();
		eq(read.data.map((r) => r["Load ID"]), ["#PF-70", "PF-71"], "the shared read still keeps each load's bottom row");
		eq(real.everyJobTrackingRow(read).map((r) => r["Load ID"]), ["PF-70", "#PF-70", "PF-71"], "and every row is there for the one reader that asks");
		eq(Object.keys(read).sort(), Object.keys(real.parseSheet({ values })).sort(), "no new key shows on the read");
		ok(!JSON.stringify(read).includes("\"PF-70\""), "nor in its JSON");
		eq(Object.getOwnPropertySymbols(read).length, 1, "nor under a symbol beyond the shown IDs' index");
		eq(real.liveJobTrackingView(read).data.map((r) => r["Load ID"]), ["PF-71"], "every view of it reads the rows it always did");
		eq(real.everyJobTrackingRow(real.liveJobTrackingView(read)).map((r) => r["Load ID"]), ["PF-71"], "and a view answers its own rows, so the kept ones reach no one by a copy");
		ok((await real.getJobTrackingCached()) === read, "one read, one object, within the minute");
		real.jtCacheInvalidate();
		const again = await real.getJobTrackingCached();
		eq([reads, real.everyJobTrackingRow(again).length], [2, 3], "and a new read keeps its own");
		eq(real.everyJobTrackingRow({ data: [{ a: 1 }] }), [{ a: 1 }], "a read that kept none answers the rows it has");
		eq(real.everyJobTrackingRow(null), [], "and nothing answers nothing");
		eq((SRC.match(/\beveryJobTrackingRow\b/g) || []).length, 2, "server.js names the kept rows' reader twice: its import and this route's mount");
		eq((SRC.match(/\bkeepEveryRow\b/g) || []).length, 2, "and their keeper twice: its import and the one cached read");
	});

	await section("28 a handover: only the first driver's own accept or tap moves a credit", async () => {
		// Her own word on the load, and her truck's departure, with the sheet naming him now.
		for (const [how, word] of [
			["her accept", (w) => w.accepted("PF-31", MON, NIA)],
			["her accept with no role on record, as every row reads with the recorder off", (w) => w.accepted("PF-31", MON, NIA, {})],
			["her tap", (w) => w.hist("PF-31", "manual", "Loading", `${MON} 13:30:00`, NIA, AS_DRIVER)],
		]) {
			await inWorld((w) => {
				word(w);
				w.picked("PF-31", MON, NIA);
				w.hist("PF-31", "manual", "Delivered", `${TUE} 18:00:00`, OMAR, AS_DRIVER);
				w.row("PF-31", OMAR, "Delivered", `${TUE} 15:00`);
			}, async (w) => {
				const nia = await w.get(OWN_WEEK, USERS.nia);
				const omar = await w.get(OWN_WEEK, USERS.omar);
				eq(nia.json.weeks[0].credits.value, 0.5, `${how} and her truck's departure: the 0.5 is hers, though the sheet names him`);
				eq(nia.json.weeks[0].loads, [{ loadId: "PF-31", pickup: PICKED("Mon"), delivery: null }], `${how}: her list shows the row, so it still adds up`);
				eq(omar.json.weeks[0].credits.value, 0.5, `${how}: the new driver gets his delivery and not her pickup`);
				eq(omar.json.weeks[0].loads, [{ loadId: "PF-31", pickup: NOT_COUNTED, delivery: DONE("Tue") }], `${how}: his row says the pickup didn't count for him`);
				ok(!/nia|frost/i.test(omar.text), `${how}: his answer doesn't name her`);
				ok(!/omar|hale/i.test(nia.text), `${how}: her answer doesn't name him`);
				const report = (await w.get(ADMIN_WEEK, USERS.admin2)).json.boards[0].drivers;
				eq([report.find((x) => x.name === NIA).pickups.geofence, report.find((x) => x.name === OMAR).pickups.total], [1, 0], `${how}: the office reads the same`);
			});
		}
		// The flagged shape: her truck's geofence rows alone, a reassign, and his taps through delivery.
		await inWorld((w) => {
			w.hist("PF-F", "dispatch", "Dispatched", `${MON} 12:00:00`, "disp", AS_STAFF);
			w.picked("PF-F", MON, NIA);
			w.hist("PF-F", "manual", "At Receiver", `${TUE} 17:00:00`, OMAR, AS_DRIVER);
			w.hist("PF-F", "manual", "Delivered", `${TUE} 18:00:00`, OMAR, AS_DRIVER);
			w.row("PF-F", OMAR, "Delivered", `${TUE} 15:00`);
		}, async (w) => {
			const nia = await w.get(OWN_WEEK, USERS.nia);
			eq(nia.json.weeks[0].loads, [], "a geofence row alone moves nothing: the driver the truck passed with has no row");
			ok(!nia.text.includes("PF-F"), "and no load number");
			eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-F", pickup: PICKED("Mon"), delivery: DONE("Tue") }], "the flagged shape stays as live: the driver who delivered it keeps the pickup");
		});
		await inWorld((w) => {
			w.hist("PF-E", "manual", "Loading", `${MON} 13:30:00`, NIA, AS_DRIVER);
			w.hist("PF-E", "manual", "In Transit", `${MON} 14:00:00`, NIA, AS_DRIVER);
			w.row("PF-E", NIA, "In Transit");
			w.picked("PF-F", MON, NIA);
			w.row("PF-F", OMAR, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.loadId), ["PF-E"], "her taps on another load at the same visit aren't on this one");
			eq((await w.weeks("omar"))[0].credits.pickups, 1, "so this one stays as live");
		});
		// A stored ELD departure never moves a credit, whatever else links her.
		for (const [how, link] of [
			["alone", () => {}],
			["with her accept on the load", (w) => w.accepted("PF-32", MON, NIA)],
			["with her tap on the load", (w) => w.hist("PF-32", "manual", "At Shipper", `${MON} 13:00:00`, NIA, AS_DRIVER)],
			["with her own In Transit tap on the load", (w) => w.hist("PF-32", "manual", "In Transit", `${MON} 13:00:00`, NIA, AS_DRIVER)],
			["with a copy on the sheet naming her", (w) => w.row("PF-32", NIA, "Cancelled")],
		]) {
			await inWorld((w) => {
				w.depart("PF-32", Date.parse(`${MON}T14:00:00Z`), 21);
				link(w);
				w.row("PF-32", OMAR, "Delivered", `${TUE} 18:00`);
			}, async (w) => {
				const nia = await w.get(OWN_WEEK, USERS.nia);
				eq(nia.json.weeks[0].credits.pickups, 0, `a stored ELD departure on her truck ${how}: no credit for her`);
				ok(!nia.text.includes("PF-32"), `a stored ELD departure ${how}: and no load number`);
				eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-32", pickup: PICKED("Mon"), delivery: DONE("Tue") }], `a stored ELD departure ${how}: it follows the Driver cell, as live`);
			});
		}
		await inWorld((w) => {
			w.depart("PF-33", Date.parse(`${MON}T14:00:00Z`), 22);
			w.row("PF-33", NIA, "In Transit");
		}, async (w) => {
			const omar = await w.get(OWN_WEEK, USERS.omar);
			eq(omar.json.weeks[0].credits.pickups, 0, "as live: a truck's holder the sheet never gave the load to gets no credit");
			ok(!omar.text.includes("PF-33"), "and no load number");
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "it follows the Driver cell");
		});
		// A later stored departure on a truck she didn't hold is the other story: the new driver's truck
		// left that shipper. It keeps the credit as live, and so moves nothing itself.
		await inWorld((w) => {
			w.accepted("PF-30", MON, NIA);
			w.hist("PF-30", "geofence", "In Transit", `${MON} 14:00:00`, NIA);
			w.depart("PF-30", Date.parse(`${MON}T22:00:00Z`), 22);
			w.row("PF-30", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "her word and her geofence row, then a stored departure on his truck: it stays as live");
			eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-30", pickup: PICKED("Mon"), delivery: null }], "on the live count's own day: the stored departure moved nothing");
			eq((await w.weeks("nia"))[0].loads, [], "with no row for her");
		});
		await inWorld((w) => {
			w.accepted("PF-30d", MON, NIA);
			w.picked("PF-30d", MON, NIA);
			w.depart("PF-30d", Date.parse(`${TUE}T14:00:00Z`), 22);
			w.row("PF-30d", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-30d", pickup: PICKED("Mon"), delivery: DONE("Tue") }], "the same with his delivery on record: his row reads as live");
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "and hers has no pickup");
		});
		await inWorld((w) => {
			w.accepted("PF-30b", MON, NIA);
			w.hist("PF-30b", "geofence", "In Transit", `${MON} 14:00:00`, NIA);
			w.depart("PF-30b", Date.parse(`${MON}T14:05:00Z`), 21);
			w.row("PF-30b", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "her own truck's stored departure minutes after her geofence row: decided by the truck, so it still moves");
		});
		await inWorld((w) => {
			w.accepted("PF-30c", MON, NIA);
			w.hist("PF-30c", "geofence", "In Transit", `${MON} 14:00:00`, NIA);
			w.depart("PF-30c", Date.parse(`${MON}T12:00:00Z`), 22);
			w.row("PF-30c", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "a stored departure on his truck from before her row says nothing against it");
		});
		await inWorld((w) => {
			w.accepted("PF-30e", MON, NIA);
			w.hist("PF-30e", "geofence", "In Transit", `${MON} 14:00:00`, NIA);
			w.depart("PF-30e", Date.parse(`${MON}T22:00:00Z`), 0);
			w.row("PF-30e", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "a later stored departure naming no truck can't be shown to be hers: it stays as live");
		});
		for (const [how, departAt, pickups] of [["after the truck left her hands", `${MON}T20:00:00Z`, [0, 1]], ["while she still held it", `${MON}T16:00:00Z`, [1, 0]]]) {
			await inWorld((w) => {
				w.db.prepare("DELETE FROM truck_assignments WHERE truck_id = 21").run();
				const ta = w.db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (21, ?, ?, ?)");
				ta.run(NIA, "2026-10-01T12:00:00.000Z", `${MON}T18:00:00.000Z`);
				ta.run(OMAR, `${MON}T18:00:00.000Z`, "");
				w.accepted("PF-30f", MON, NIA);
				w.hist("PF-30f", "geofence", "In Transit", `${MON} 14:00:00`, NIA);
				w.depart("PF-30f", Date.parse(departAt), 21);
				w.row("PF-30f", OMAR, "In Transit");
			}, async (w) => {
				eq(await w.pickups(), pickups, `a later stored departure on the truck she once held, dated ${how}: decided by who held it then`);
			});
		}
		// A tap: her own, and on a truck with no reporting ELD.
		await inWorld((w) => {
			w.hist("PF-34", "manual", "In Transit", `${MON} 14:00:00`, NIA, AS_DRIVER);
			w.row("PF-34", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "her tap on a truck with no ELD, the load since moved: the pickup is hers");
		});
		// With no role on record a `manual` row can be the office's status dropdown, so it is nobody's word.
		await inWorld((w) => {
			w.hist("PF-34c", "manual", "In Transit", `${MON} 14:00:00`, NIA, { old: "Dispatched" });
			w.row("PF-34c", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "a tap with no role on record moves nothing: it stays as live");
			eq((await w.weeks("nia"))[0].loads, [], "with no row for her");
			eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-34c", pickup: PICKED("Mon"), delivery: DONE("Tue") }], "and his row reads as live");
		});
		await inWorld((w) => {
			w.hist("PF-34d", "manual", "Heading to Shipper", `${MON} 11:00:00`, NIA, { old: "Dispatched" });
			w.picked("PF-34d", MON, NIA);
			w.row("PF-34d", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "her geofence rows and a tap with no role on record: still no word of hers, so it stays as live");
		});
		await inWorld((w) => {
			w.hist("PF-D1", "manual", "In Transit", `${MON} 14:00:00`, "Ivy Lane");
			w.row("PF-D1", OMAR, "In Transit");
		}, async (w) => {
			const ivy = await w.get(OWN_WEEK, USERS.ivy);
			eq(ivy.status, 404, "a tap with no role naming a driver no sheet row names: that driver gets no row and no answer");
			ok(!ivy.text.includes("PF-D1"), "and no load number");
			eq((await w.weeks("omar"))[0].credits.pickups, 1, "the bottom row's driver keeps it");
		});
		// A limit: with the recorder off a staff accept writes the row a driver's does, so it can't be told apart.
		await inWorld((w) => {
			w.accepted("PF-35a", MON, NIA, {});
			w.picked("PF-35a", MON, NIA);
			w.row("PF-35a", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "an accept with no role on record reads as hers, whoever's hand it was");
		});
		await inWorld((w) => {
			w.hist("PF-35", "manual", "In Transit", `${MON} 14:00:00`, NIA, AS_STAFF);
			w.row("PF-35", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "the same row from a staff session isn't her record: the route takes any name from staff, so it stays as live");
		});
		await inWorld((w) => {
			w.accepted("PF-35b", MON, NIA, AS_STAFF);
			w.picked("PF-35b", MON, NIA);
			w.row("PF-35b", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "nor is an accept from a staff session");
		});
		await inWorld((w) => {
			w.accepted("PF-35c", MON, NIA);
			w.hist("PF-35c", "manual", "In Transit", `${MON} 14:00:00`, NIA, AS_STAFF);
			w.row("PF-35c", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "her accept and a staff session's tap naming her: the departure isn't her record, so it stays as live");
		});
		await inWorld((w) => {
			w.hist("PF-35d", "geofence", "In Transit", `${MON} 14:00:00`, OMAR);
			w.hist("PF-35d", "manual", "In Transit", `${MON} 15:00:00`, NIA, AS_DRIVER);
			w.row("PF-35d", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "his truck's own departure comes first: her later tap moves nothing");
		});
		await inWorld((w) => {
			w.eldOn(21);
			w.hist("PF-36", "manual", "In Transit", `${MON} 14:00:00`, NIA, AS_DRIVER);
			w.row("PF-36", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "her tap on a truck with a reporting ELD proves no pickup of hers: it stays as live");
		});
		await inWorld((w) => {
			w.eldOn(21);
			w.eldOn(22);
			w.hist("PF-37", "manual", "In Transit", `${MON} 14:00:00`, NIA, AS_DRIVER);
			w.row("PF-37", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [0, 0], "and if his truck reports too, a tap earns nothing, as live");
		});
		await inWorld((w) => {
			w.eldOn(22);
			w.hist("PF-37b", "manual", "In Transit", `${MON} 14:00:00`, NIA, AS_DRIVER);
			w.row("PF-37b", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "her tap on her truck with no ELD counts, whatever his truck reports");
		});
		await inWorld((w) => {
			w.hist("PF-37c", "manual", "In Transit", "2026-10-20 15:00:00", NIA, AS_DRIVER);
			w.row("PF-37c", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [0, 0], "a tap older than both weeks: no credit for anyone, as live");
			eq((await w.weeks("omar"))[0].loads[0].pickup, NOT_COUNTED, "and his row says so");
		});
		// A dispatcher's tap names the dispatcher, and a reassign writes no row, so it moves nothing.
		await inWorld((w) => {
			w.accepted("PF-39", MON, NIA);
			w.hist("PF-39", "override", "In Transit", `${MON} 14:00:00`, "disp", AS_STAFF);
			w.hist("PF-39", "manual", "At Receiver", `${MON} 20:00:00`, NIA, AS_DRIVER);
			w.row("PF-39", OMAR, "At Receiver");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "a dispatcher's tap, her own rows on both sides of it: it stays as live");
		});
		await inWorld((w) => {
			w.hist("PF-40", "override", "In Transit", `${MON} 14:00:00`, "disp", AS_STAFF);
			w.row("PF-40", NIA, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "a dispatcher's tap with no driver's row: the sheet's own driver, as live");
		});
		// Her word has to stand: a decline after her accept takes it back.
		await inWorld((w) => {
			w.accepted("PF-41", MON, NIA);
			w.picked("PF-41", MON, NIA);
			w.hist("PF-41", "decline", "Unassigned", `${MON} 15:00:00`, NIA, AS_DRIVER);
			w.row("PF-41", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "she accepted and then declined it: no word of hers stands, so it stays as live");
		});
		await inWorld((w) => {
			w.hist("PF-42", "decline", "Unassigned", `${MON} 09:00:00`, NIA, AS_DRIVER);
			w.picked("PF-42", MON, NIA);
			w.row("PF-42", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "a decline alone is no accept");
		});
		await inWorld((w) => {
			w.hist("PF-43", "decline", "Unassigned", `${MON} 08:00:00`, NIA, AS_DRIVER);
			w.accepted("PF-43", MON, NIA);
			w.picked("PF-43", MON, NIA);
			w.row("PF-43", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "a decline and then her accept: her last word stands");
		});
		await inWorld((w) => {
			w.accepted("PF-43b", MON, NIA);
			w.hist("PF-43b", "decline", "Unassigned", `${MON} 10:00:00`, NIA, AS_DRIVER);
			w.picked("PF-43b", MON, NIA);
			w.row("PF-43b", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "a decline between her accept and the departure: no word stands");
		});
		// A tap back says the load hadn't left, so it's no word for a departure.
		await inWorld((w) => {
			w.picked("PF-S7a", MON, NIA);
			w.hist("PF-S7a", "manual", "Dispatched", `${MON} 15:00:00`, NIA, { old: "In Transit" });
			w.hist("PF-S7a", "accept", "Assigned", `${TUE} 09:00:00`, OMAR, { old: "Dispatched", ...AS_DRIVER });
			w.hist("PF-S7a", "manual", "In Transit", `${TUE} 14:00:00`, OMAR, { old: "Assigned", ...AS_DRIVER });
			w.row("PF-S7a", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [], "a false advance corrected by a tap back with no role on record: nothing for her");
			eq((await w.weeks("omar"))[0].credits, { value: 1, target: 7.5, required: 6, deliveries: 1, pickups: 1 }, "his delivery and his pickup");
		});
		await inWorld((w) => {
			w.picked("PF-S7d", LAST_FRI, NIA);
			w.hist("PF-S7d", "manual", "Dispatched", `${LAST_FRI} 15:00:00`, NIA, { old: "In Transit" });
			w.hist("PF-S7d", "accept", "Assigned", `${MON} 09:00:00`, OMAR, { old: "Dispatched", ...AS_DRIVER });
			w.hist("PF-S7d", "manual", "In Transit", `${MON} 14:00:00`, OMAR, { old: "Assigned", ...AS_DRIVER });
			w.row("PF-S7d", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq((await w.weeks("nia"))[1].credits.pickups, 0, "the same over a week: last week gains nothing for her");
			eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-S7d", pickup: PICKED("Mon"), delivery: DONE("Tue") }], "and his own tap this week is the pickup");
		});
		await inWorld((w) => {
			w.picked("PF-S7", MON, NIA);
			w.hist("PF-S7", "manual", "Dispatched", `${MON} 15:00:00`, NIA, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-S7", "manual", "In Transit", `${TUE} 14:00:00`, OMAR, { old: "Dispatched", ...AS_DRIVER });
			w.row("PF-S7", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "her tap back with a Driver role on record is no word either");
		});
		await inWorld((w) => {
			w.hist("PF-S7e", "manual", "Dispatched", `${MON} 11:00:00`, NIA, AS_DRIVER);
			w.picked("PF-S7e", MON, NIA);
			w.row("PF-S7e", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "nor a Driver-role tap to Dispatched before any departure: it takes the load nowhere");
		});
		// The word has to be for this run: nothing from before the load's last cancel counts.
		await inWorld((w) => {
			w.accepted("PF-S8", SUN, NIA);
			w.hist("PF-S8", "cancel", "Cancelled", `${SUN} 15:00:00`, "disp");
			w.hist("PF-S8", "dispatch", "Dispatched", `${SUN} 18:00:00`, "disp");
			w.picked("PF-S8", MON, NIA);
			w.row("PF-S8", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "her accept before a cancel, then her truck passing: no word for this run, so it stays as live");
		});
		await inWorld((w) => {
			w.hist("PF-S8b", "cancel", "Cancelled", `${SUN} 15:00:00`, "disp");
			w.hist("PF-S8b", "dispatch", "Dispatched", `${SUN} 18:00:00`, "disp");
			w.accepted("PF-S8b", MON, NIA);
			w.picked("PF-S8b", MON, NIA);
			w.row("PF-S8b", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "her accept after the cancel is for this run: it moves");
		});
		await inWorld((w) => {
			w.hist("PF-S8c", "cancel", "Cancelled", `${SUN} 08:00:00`, "disp");
			w.accepted("PF-S8c", SUN, NIA);
			w.hist("PF-S8c", "cancel", "Cancelled", `${SUN} 15:00:00`, "disp");
			w.picked("PF-S8c", MON, NIA);
			w.row("PF-S8c", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "her accept between two cancels isn't for this run: it's the last cancel that counts");
		});
		// Someone else's row is never the first driver's own move back.
		await inWorld((w) => {
			w.accepted("PF-S16", MON, NIA);
			w.picked("PF-S16", MON, NIA);
			w.hist("PF-S16", "accept", "Assigned", `${TUE} 09:00:00`, OMAR, { old: "Dispatched", ...AS_DRIVER });
			w.hist("PF-S16", "manual", "In Transit", `${TUE} 14:00:00`, OMAR, { old: "Assigned", ...AS_DRIVER });
			w.row("PF-S16", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [], "the new driver's accept over her departure isn't her tap back: nothing moves to her");
			eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-S16", pickup: PICKED("Tue"), delivery: DONE("Tue") }], "and his own tap, with no ELD on his truck, is the pickup");
		});
		for (const [how, role] of [["with no role on record", {}], ["from a staff session", AS_STAFF]]) {
			await inWorld((w) => {
				w.accepted("PF-S5", MON, NIA);
				w.picked("PF-S5", MON, NIA);
				w.hist("PF-S5", "manual", "Dispatched", `${MON} 15:00:00`, OMAR, { old: "In Transit", ...role });
				w.hist("PF-S5", "accept", "Assigned", `${TUE} 09:00:00`, OMAR, { old: "Dispatched", ...AS_DRIVER });
				w.hist("PF-S5", "geofence", "At Shipper", `${TUE} 13:00:00`, OMAR);
				w.hist("PF-S5", "manual", "In Transit", `${TUE} 14:00:00`, OMAR, { old: "At Shipper", ...AS_DRIVER });
				w.depart("PF-S5", Date.parse(`${TUE}T14:05:00Z`), 22);
				w.eldOn(22);
				w.row("PF-S5", OMAR, "Delivered", `${TUE} 18:00`);
			}, async (w) => {
				eq((await w.weeks("nia"))[0].loads, [], `a dropdown back ${how} naming him and his truck's whole visit: nothing for her`);
				eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-S5", pickup: PICKED("Mon"), delivery: DONE("Tue") }], `a dropdown back ${how}: his row reads as live`);
			});
		}
		await inWorld((w) => {
			w.accepted("PF-S6", MON, NIA);
			w.picked("PF-S6", MON, NIA);
			w.hist("PF-S6", "manual", "Dispatched", `${MON} 15:00:00`, OMAR, { old: "In Transit" });
			w.hist("PF-S6", "accept", "Assigned", `${TUE} 09:00:00`, OMAR, { old: "Dispatched", ...AS_DRIVER });
			w.hist("PF-S6", "manual", "In Transit", `${TUE} 14:00:00`, OMAR, { old: "Assigned", ...AS_DRIVER });
			w.row("PF-S6", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "the same with no ELD on his truck: nothing moves to her");
		});
		await inWorld((w) => {
			w.hist("PF-S16b", "manual", "In Transit", `${MON} 14:00:00`, NIA, AS_DRIVER);
			w.hist("PF-S16b", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.hist("PF-S16b", "manual", "In Transit", `${TUE} 14:00:00`, NIA, AS_DRIVER);
			w.row("PF-S16b", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "her own tap after staff's move back, on a truck with no ELD, the load since moved: it's hers");
			eq((await w.weeks("nia"))[0].loads[0]?.pickup, PICKED("Tue"), "on the day of that tap");
		});
		// A move back after her departure leaves the handover uncertain.
		await inWorld((w) => {
			w.accepted("PF-44", MON, NIA);
			w.picked("PF-44", MON, NIA);
			w.hist("PF-44", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.row("PF-44", OMAR, "In Transit");
		}, async (w) => {
			eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-44", pickup: PICKED("Mon"), delivery: null }], "staff moved it back after her departure: it stays as live");
			eq((await w.weeks("nia"))[0].loads, [], "with no row for her");
		});
		await inWorld((w) => {
			w.accepted("PF-45", MON, NIA);
			w.picked("PF-45", MON, NIA);
			w.hist("PF-45", "manual", "Dispatched", `${MON} 15:00:00`, NIA, AS_DRIVER);
			w.row("PF-45", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "her own stray tap back: her truck's own record of leaving still stands");
		});
		await inWorld((w) => {
			w.hist("PF-46", "manual", "In Transit", `${MON} 14:00:00`, NIA, AS_DRIVER);
			w.hist("PF-46", "manual", "Dispatched", `${MON} 15:00:00`, NIA, AS_DRIVER);
			w.hist("PF-46", "manual", "In Transit", `${TUE} 14:00:00`, OMAR, AS_DRIVER);
			w.row("PF-46", OMAR, "In Transit");
		}, async (w) => {
			eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-46", pickup: PICKED("Mon"), delivery: null }], "her tap, her tap back, then his tap: her word against her word moves nothing, as live");
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "with no credit for her");
		});
		await inWorld((w) => {
			w.accepted("PF-47", MON, NIA);
			w.hist("PF-47", "geofence", "In Transit", `${SUN} 14:00:00`, OMAR);
			w.hist("PF-47", "override", "Dispatched", `${SUN} 15:00:00`, "disp", AS_STAFF);
			w.hist("PF-47", "geofence", "In Transit", `${MON} 14:00:00`, NIA);
			w.row("PF-47", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "a departure of hers after a move back, with her word on the load: it's hers");
			eq((await w.weeks("nia"))[0].loads[0]?.pickup, PICKED("Mon"), "on the day of that departure");
		});
		// A new driver's own departure on record: nothing of theirs hands the credit to the first driver.
		const newDriversTrip = (w, id) => {
			w.hist(id, "accept", "Assigned", `${TUE} 09:00:00`, OMAR, { old: "Dispatched", ...AS_DRIVER });
			w.hist(id, "manual", "In Transit", `${TUE} 14:00:00`, OMAR, { old: "Assigned", ...AS_DRIVER });
		};
		await inWorld((w) => {
			w.accepted("PF-Z2b", MON, NIA);
			w.picked("PF-Z2b", MON, NIA);
			newDriversTrip(w, "PF-Z2b");
			w.row("PF-Z2b", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-Z2b", pickup: PICKED("Tue"), delivery: DONE("Tue") }], "the control: the new driver's accept and own tap, on a truck with no ELD: the pickup is theirs, on that tap's day");
		});
		await inWorld((w) => {
			w.accepted("PF-Z2", MON, NIA);
			w.picked("PF-Z2", MON, NIA);
			newDriversTrip(w, "PF-Z2");
			w.hist("PF-Z2", "manual", "At Shipper", `${TUE} 14:10:00`, OMAR, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-Z2", "manual", "In Transit", `${TUE} 14:11:00`, OMAR, { old: "At Shipper", ...AS_DRIVER });
			w.row("PF-Z2", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [], "the new driver's own stray tap back and forward: nothing moves to the first driver");
			eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-Z2", pickup: PICKED("Mon"), delivery: DONE("Tue") }], "and the new driver's row reads as live");
		});
		await inWorld((w) => {
			w.accepted("PF-Z2c", LAST_FRI, NIA);
			w.picked("PF-Z2c", LAST_FRI, NIA);
			newDriversTrip(w, "PF-Z2c");
			w.hist("PF-Z2c", "manual", "At Shipper", `${TUE} 14:10:00`, OMAR, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-Z2c", "manual", "In Transit", `${TUE} 14:11:00`, OMAR, { old: "At Shipper", ...AS_DRIVER });
			w.row("PF-Z2c", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(1), [0, 1], "the same over a week: last week's credit stays with the new driver, as live, not the first driver");
		});
		await inWorld((w) => {
			w.accepted("PF-Z1", MON, NIA);
			w.picked("PF-Z1", MON, NIA);
			w.hist("PF-Z1", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.hist("PF-Z1", "geofence", "In Transit", `${TUE} 14:00:00`, OMAR, { old: "At Shipper" });
			w.hist("PF-Z1", "manual", "Dispatched", `${TUE} 15:00:00`, OMAR, { old: "In Transit", ...AS_DRIVER });
			w.row("PF-Z1", OMAR, "Dispatched");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "staff's move back, the new driver's truck departs, then their own tap back: nothing moves to the first driver");
		});
		for (const [how, tail, sheet, delivered] of [
			["through delivery", (w) => w.hist("PF-Z3", "manual", "In Transit", `${TUE} 15:05:00`, OMAR, { old: "Assigned" }), ["Delivered", `${TUE} 18:00`], DONE("Tue")],
			["stopped at the late accept", () => {}, ["Assigned", ""], null],
		]) {
			await inWorld((w) => {
				w.accepted("PF-Z3", MON, NIA, {});
				w.picked("PF-Z3", MON, NIA);
				w.hist("PF-Z3", "manual", "Dispatched", `${MON} 15:00:00`, OMAR, { old: "In Transit" });
				w.hist("PF-Z3", "manual", "In Transit", `${TUE} 14:00:00`, OMAR, { old: "Dispatched" });
				w.hist("PF-Z3", "accept", "Assigned", `${TUE} 15:00:00`, OMAR, { old: "Dispatched" });
				tail(w);
				w.row("PF-Z3", OMAR, ...sheet);
			}, async (w) => {
				eq((await w.weeks("nia"))[0].loads, [], `every row with no role on record, ${how}: nothing moves to the first driver`);
				eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-Z3", pickup: PICKED("Mon"), delivery: delivered }], `every row with no role on record, ${how}: the new driver's row reads as live`);
			});
		}
		await inWorld((w) => {
			w.accepted("PF-Z3b", MON, NIA, {});
			w.picked("PF-Z3b", MON, NIA);
			w.picked("PF-Z3b", TUE, OMAR);
			w.hist("PF-Z3b", "accept", "Assigned", `${TUE} 15:00:00`, OMAR, { old: "Dispatched" });
			w.hist("PF-Z3b", "manual", "In Transit", `${TUE} 15:05:00`, OMAR, { old: "Assigned" });
			w.row("PF-Z3b", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "a row-editor reset, the new driver's truck's whole visit and their late accept: nothing moves to the first driver");
		});
		await inWorld((w) => {
			w.accepted("PF-Z4", MON, NIA);
			w.picked("PF-Z4", MON, NIA);
			w.hist("PF-Z4", "manual", "At Shipper", `${MON} 15:00:00`, NIA, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-Z4", "manual", "In Transit", `${TUE} 14:00:00`, OMAR, { old: "At Shipper", ...AS_DRIVER });
			w.row("PF-Z4", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [], "the first driver's own tap back, then the new driver's own In Transit: nothing moves to the first driver");
			eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-Z4", pickup: PICKED("Mon"), delivery: DONE("Tue") }], "and the new driver's row reads as live");
		});
		await inWorld((w) => {
			w.accepted("PF-Z6", MON, NIA);
			w.picked("PF-Z6", MON, NIA);
			w.hist("PF-Z6", "manual", "At Receiver", `${TUE} 09:00:00`, OMAR, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-Z6", "manual", "In Transit", `${TUE} 09:05:00`, OMAR, { old: "At Receiver", ...AS_DRIVER });
			w.row("PF-Z6", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "the new driver's In Transit off their own At Receiver can't be a departure from the shipper: the handover moves");
		});
		await inWorld((w) => {
			w.accepted("PF-Z7", MON, NIA);
			w.picked("PF-Z7", MON, NIA);
			w.hist("PF-Z7", "manual", "At Receiver", `${TUE} 09:00:00`, "Ivy Lane", { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-Z7", "manual", "In Transit", `${TUE} 09:05:00`, "Ivy Lane", { old: "At Receiver", ...AS_DRIVER });
			w.row("PF-Z7", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "a third driver's In Transit off At Receiver: no departure from the shipper either, so the handover moves");
		});
		await inWorld((w) => {
			w.accepted("PF-Z7b", MON, NIA);
			w.picked("PF-Z7b", MON, NIA);
			w.hist("PF-Z7b", "manual", "In Transit", `${TUE} 09:05:00`, "Ivy Lane", { old: "", ...AS_DRIVER });
			w.row("PF-Z7b", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "a third driver's own In Transit off no later stage: it stays as live");
		});
		// The last In Transit doesn't decide: the first driver's own later row doesn't undo another driver's.
		await inWorld((w) => {
			w.accepted("PF-Z11", MON, NIA);
			w.picked("PF-Z11", MON, NIA);
			w.hist("PF-Z11", "manual", "In Transit", `${TUE} 09:05:00`, OMAR, { old: "", ...AS_DRIVER });
			w.hist("PF-Z11", "manual", "In Transit", `${TUE} 12:05:00`, NIA, { old: "", ...AS_DRIVER });
			w.row("PF-Z11", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "the new driver's own In Transit, then the first driver's own later one: it stays as live");
		});
		await inWorld((w) => {
			w.accepted("PF-Z9b", MON, NIA);
			w.picked("PF-Z9b", MON, NIA);
			w.hist("PF-Z9b", "manual", "At Shipper", `${MON} 18:00:00`, NIA, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-Z9b", "manual", "In Transit", `${MON} 18:05:00`, NIA, { old: "At Shipper", ...AS_DRIVER });
			w.row("PF-Z9b", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "the first driver's own tap back and forward says nothing against their claim: it still moves");
		});
		// The tap path asks the same question as the geofence path.
		await inWorld((w) => {
			w.hist("PF-Z12", "manual", "In Transit", `${MON} 14:00:00`, NIA, { old: "Assigned", ...AS_DRIVER });
			w.hist("PF-Z12", "manual", "In Transit", `${TUE} 09:05:00`, OMAR, { old: "", ...AS_DRIVER });
			w.row("PF-Z12", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "the first driver's own tap, then the new driver's own In Transit: it stays as live");
		});
		// An In Transit off a later stage, by any route, corrects a status: a new driver who really lifted a
		// load under In Transit writes no In Transit at all, so it says nothing about the pickup.
		for (const [how, stage, facts] of [
			["At Receiver, with no role on record", "At Receiver", {}],
			["At Receiver, from a Super Admin session", "At Receiver", { role: "Super Admin" }],
			["Unloading", "Unloading", {}],
			["Delivered", "Delivered", {}],
			["Completed", "Completed", {}],
			["POD Received", "POD Received", {}],
		]) {
			await inWorld((w) => {
				w.accepted("PF-H1", MON, NIA, {});
				w.picked("PF-H1", MON, NIA);
				w.hist("PF-H1", "manual", stage, `${TUE} 12:00:00`, OMAR, { old: "In Transit" });
				w.hist("PF-H1", "manual", "In Transit", `${TUE} 12:30:00`, OMAR, { old: stage, ...facts });
				w.hist("PF-H1", "manual", "At Receiver", `${TUE} 17:00:00`, OMAR, { old: "In Transit" });
				w.hist("PF-H1", "manual", "Delivered", `${TUE} 18:00:00`, OMAR, { old: "At Receiver" });
				w.row("PF-H1", OMAR, "Delivered", `${TUE} 18:00`);
			}, async (w) => {
				eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-H1", pickup: PICKED("Mon"), delivery: null }], `the office puts In Transit back off ${how}: the handover moves`);
				eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-H1", pickup: NOT_COUNTED, delivery: DONE("Tue") }], `off ${how}: the new driver keeps the delivery`);
			});
		}
		await inWorld((w) => {
			w.accepted("PF-H3b", MON, NIA, {});
			w.picked("PF-H3b", MON, NIA);
			w.hist("PF-H3b", "geofence", "At Receiver", `${MON} 18:00:00`, NIA, { old: "In Transit" });
			w.hist("PF-H3b", "override", "In Transit", `${MON} 18:30:00`, "disp", { old: "At Receiver", ...AS_STAFF });
			w.hist("PF-H3b", "manual", "At Receiver", `${TUE} 17:00:00`, OMAR, { old: "In Transit" });
			w.hist("PF-H3b", "manual", "Delivered", `${TUE} 18:00:00`, OMAR, { old: "At Receiver" });
			w.row("PF-H3b", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "the modal's correction while the first driver held the load, then the relay: the handover moves");
		});
		await inWorld((w) => {
			w.accepted("PF-H6", LAST_FRI, NIA, {});
			w.picked("PF-H6", LAST_FRI, NIA);
			w.hist("PF-H6", "manual", "At Receiver", `${TUE} 12:00:00`, OMAR, { old: "In Transit" });
			w.hist("PF-H6", "manual", "In Transit", `${TUE} 12:30:00`, OMAR, { old: "At Receiver" });
			w.row("PF-H6", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(1), [1, 0], "the same correction over a week: last week's credit moves to the first driver");
			eq((await w.weeks("omar"))[0].loads[0]?.pickup, NOT_COUNTED, "and the new driver's row this week says it didn't count for them");
		});
		// The tap path, recorder on: the first driver's Driver-role tap on a truck with no ELD.
		for (const [how, reporting, omarsPickup] of [["no ELD on either truck", false, NOT_COUNTED], ["the new driver's truck reporting", true, NOT_COUNTED]]) {
			await inWorld((w) => {
				if (reporting) w.eldOn(22, MON);
				w.accepted("PF-H7", MON, NIA);
				w.hist("PF-H7", "manual", "In Transit", `${MON} 14:00:00`, NIA, { old: "Assigned", ...AS_DRIVER });
				w.hist("PF-H7", "manual", "At Receiver", `${TUE} 12:00:00`, OMAR, { old: "In Transit", ...AS_DRIVER });
				w.hist("PF-H7", "manual", "In Transit", `${TUE} 12:30:00`, OMAR, { old: "At Receiver", role: "Super Admin" });
				w.hist("PF-H7", "manual", "Delivered", `${TUE} 18:00:00`, OMAR, { old: "In Transit", ...AS_DRIVER });
				w.row("PF-H7", OMAR, "Delivered", `${TUE} 18:00`);
			}, async (w) => {
				eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-H7", pickup: PICKED("Mon"), delivery: null }], `the tap path, ${how}: the office's correction leaves the handover moving`);
				eq((await w.weeks("omar"))[0].loads[0]?.pickup, omarsPickup, `the tap path, ${how}: the new driver's row says so`);
			});
		}
		// A dispatcher's override off an earlier status can be the new driver's trip: the rows can't tell that
		// from a correction, so it reads as the sheet's driver leaving, as live.
		await inWorld((w) => {
			w.accepted("PF-H9", MON, NIA);
			w.picked("PF-H9", MON, NIA);
			w.hist("PF-H9", "manual", "At Shipper", `${MON} 15:00:00`, NIA, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-H9", "override", "In Transit", `${MON} 15:30:00`, "disp", { old: "At Shipper", ...AS_STAFF });
			w.row("PF-H9", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "a dispatcher's override off At Shipper, over the first driver's own tap back: the rows can't tell a correction from the new driver's trip, so it stays as live");
		});
		await inWorld((w) => {
			w.accepted("PF-OC1", MON, NIA);
			w.picked("PF-OC1", MON, NIA);
			w.hist("PF-OC1", "manual", "At Shipper", `${MON} 15:00:00`, NIA, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-OC1", "override", "In Transit", `${MON} 15:30:00`, "disp", { old: "At Shipper", ...AS_STAFF });
			w.hist("PF-OC1", "manual", "At Receiver", `${TUE} 17:00:00`, OMAR, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-OC1", "manual", "Delivered", `${TUE} 18:00:00`, OMAR, { old: "At Receiver", ...AS_DRIVER });
			w.row("PF-OC1", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [], "the limit: a correction in the office's modal over the first driver's own tap back counts as it does today");
			eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-OC1", pickup: PICKED("Mon"), delivery: DONE("Tue") }], "and the new driver's row reads as live");
		});
		await inWorld((w) => {
			w.accepted("PF-OT1", MON, NIA);
			w.picked("PF-OT1", MON, NIA);
			w.hist("PF-OT1", "manual", "Dispatched", `${MON} 15:00:00`, NIA, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-OT1", "override", "In Transit", `${TUE} 14:00:00`, "disp", { old: "Dispatched", ...AS_STAFF });
			w.hist("PF-OT1", "manual", "At Receiver", `${TUE} 17:00:00`, OMAR, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-OT1", "manual", "Delivered", `${TUE} 18:00:00`, OMAR, { old: "At Receiver", ...AS_DRIVER });
			w.row("PF-OT1", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [], "the modal writes the new driver's trip over the first driver's own tap back: nothing moves to the first driver");
			eq((await w.weeks("omar"))[0].loads, [{ loadId: "PF-OT1", pickup: PICKED("Mon"), delivery: DONE("Tue") }], "and the new driver's row reads as live");
		});
		await inWorld((w) => {
			w.accepted("PF-Z1o", MON, NIA);
			w.picked("PF-Z1o", MON, NIA);
			w.hist("PF-Z1o", "override", "Dispatched", `${MON} 15:00:00`, "disp", { old: "In Transit", ...AS_STAFF });
			w.hist("PF-Z1o", "override", "In Transit", `${TUE} 14:00:00`, "disp", { old: "Dispatched", ...AS_STAFF });
			w.hist("PF-Z1o", "manual", "Dispatched", `${TUE} 15:00:00`, OMAR, { old: "In Transit", ...AS_DRIVER });
			w.row("PF-Z1o", OMAR, "Dispatched");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "staff's move back, the modal's In Transit, the new driver's own tap back: nothing moves to the first driver");
		});
		await inWorld((w) => {
			w.accepted("PF-Z3oa", MON, NIA, {});
			w.picked("PF-Z3oa", MON, NIA);
			w.hist("PF-Z3oa", "override", "Dispatched", `${MON} 15:00:00`, "disp", { old: "In Transit" });
			w.hist("PF-Z3oa", "override", "In Transit", `${TUE} 14:00:00`, "disp", { old: "Dispatched" });
			w.hist("PF-Z3oa", "accept", "Assigned", `${TUE} 15:00:00`, OMAR, { old: "Dispatched" });
			w.row("PF-Z3oa", OMAR, "Assigned");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "every row with no role on record, the modal's In Transit, the new driver's late accept: nothing moves to the first driver");
		});
		// The Friday edge: staff's move back, the first driver's truck leaves again, then a correction.
		await inWorld((w) => {
			w.accepted("PF-E21", LAST_FRI, NIA);
			w.hist("PF-E21", "geofence", "In Transit", "2026-11-07 04:50:00", NIA);
			w.hist("PF-E21", "override", "Dispatched", "2026-11-07 04:59:59", "disp", AS_STAFF);
			w.hist("PF-E21", "geofence", "In Transit", "2026-11-07 05:00:00", NIA, { old: "At Shipper" });
			w.hist("PF-E21", "manual", "At Receiver", `${TUE} 12:00:00`, OMAR, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-E21", "manual", "In Transit", `${TUE} 12:30:00`, OMAR, { old: "At Receiver" });
			w.row("PF-E21", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-E21", pickup: PICKED("Sat"), delivery: null }], "over the Friday edge: the first driver's later departure, on its own Saturday");
			eq((await w.weeks("omar"))[0].loads[0]?.pickup, NOT_COUNTED, "and the new driver's row says it didn't count for them");
		});
		for (const [how, later] of [
			["a dispatcher's tap", (w) => w.hist("PF-Z8", "override", "In Transit", `${TUE} 09:05:00`, "disp", { old: "At Receiver", ...AS_STAFF })],
			["a tap with no role naming the new driver", (w) => w.hist("PF-Z8", "manual", "In Transit", `${TUE} 09:05:00`, OMAR, { old: "At Receiver" })],
		]) {
			await inWorld((w) => {
				w.accepted("PF-Z8", MON, NIA);
				w.picked("PF-Z8", MON, NIA);
				w.hist("PF-Z8", "manual", "At Receiver", `${TUE} 09:00:00`, OMAR, { old: "In Transit", ...AS_DRIVER });
				later(w);
				w.row("PF-Z8", OMAR, "In Transit");
			}, async (w) => {
				eq(await w.pickups(), [1, 0], `an In Transit off At Receiver by ${how} corrects a status and says nothing about who left: the handover moves`);
			});
		}
		await inWorld((w) => {
			w.accepted("PF-Z9", MON, NIA);
			w.picked("PF-Z9", MON, NIA);
			w.hist("PF-Z9", "manual", "At Receiver", `${MON} 18:00:00`, NIA, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-Z9", "manual", "In Transit", `${MON} 18:05:00`, NIA, { old: "At Receiver", ...AS_DRIVER });
			w.row("PF-Z9", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "the first driver's own later In Transit says nothing against their claim: it still moves");
		});
		// With no later In Transit row to settle it, each rule still has to stand alone.
		await inWorld((w) => {
			w.picked("PF-S7f", MON, NIA);
			w.hist("PF-S7f", "manual", "Dispatched", `${MON} 15:00:00`, NIA, { old: "In Transit", ...AS_DRIVER });
			w.row("PF-S7f", OMAR, "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "the first driver's geofence rows and their own tap back, and nothing else on the load: a tap back is no word");
		});
		for (const [how, back] of [
			["their own tap back", (w) => w.hist("PF-46b", "manual", "Dispatched", `${MON} 15:00:00`, NIA, { old: "In Transit", ...AS_DRIVER })],
			["staff's move back", (w) => w.hist("PF-46b", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF)],
		]) {
			await inWorld((w) => {
				w.hist("PF-46b", "manual", "In Transit", `${MON} 14:00:00`, NIA, AS_DRIVER);
				back(w);
				w.row("PF-46b", OMAR, "In Transit");
			}, async (w) => {
				eq(await w.pickups(), [0, 1], `the first driver's own tap, then ${how}: the tap can't stand over it, so it stays as live`);
			});
		}
		await inWorld((w) => {
			w.accepted("PF-Z10", MON, NIA);
			w.picked("PF-Z10", MON, NIA);
			w.hist("PF-Z10", "manual", "At Receiver", `${TUE} 17:00:00`, OMAR, { old: "In Transit", ...AS_DRIVER });
			w.hist("PF-Z10", "manual", "Delivered", `${TUE} 18:00:00`, OMAR, { old: "At Receiver", ...AS_DRIVER });
			w.row("PF-Z10", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [1, 0], "a relay: the new driver's At Receiver and Delivered are no departure, so the first driver's still moves");
			eq((await w.weeks("omar"))[0].loads[0]?.pickup, NOT_COUNTED, "and the new driver's row says the pickup didn't count for them");
		});
		// Two weeks: the credit goes with the week she made it, and his delivery says what became of it.
		await inWorld((w) => {
			w.accepted("PF-48", LAST_THU, NIA);
			w.picked("PF-48", LAST_THU, NIA);
			w.row("PF-48", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			const nia = await w.weeks("nia");
			const omar = await w.weeks("omar");
			eq([nia[0].loads, nia[1].loads], [[], [{ loadId: "PF-48", pickup: PICKED("Thu"), delivery: null }]], "her pickup last week stays on last week's list");
			eq([omar[0].loads[0].pickup, omar[1].credits.pickups], [NOT_COUNTED, 0], "his delivery this week reads not counted, not last week");
		});
		// A name the directory doesn't hold says nothing certain: a rename leaves the log as it was.
		await inWorld((w) => {
			w.accepted("PF-53", MON, "Nia Frosst");
			w.picked("PF-53", MON, "Nia Frosst");
			w.row("PF-53", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq(await w.pickups(), [0, 1], "a rename and a handover together: nothing on record says whose old spelling it is, so it stays as live");
		});
		await inWorld((w) => {
			w.accepted("PF-59", MON, "Lou Grant");
			w.picked("PF-59", MON, "Lou Grant");
			w.row("PF-59", "Lou Grant", "Dispatched");
			w.row("PF-59", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "a name on a sheet row alone isn't a driver's today: it stays as live");
		});
		await inWorld((w) => {
			for (const [i, day] of [SUN, MON, TUE].entries()) {
				w.accepted(`PF-5${i}`, day, "Nia Frosst");
				w.picked(`PF-5${i}`, day, "Nia Frosst");
				w.row(`PF-5${i}`, NIA, "Delivered", `${day} 15:00`);
			}
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.value, 3, "a rename loses none of his pickups");
		});
		await inWorld((w) => {
			w.accepted("PF-54", MON, NIA);
			w.picked("PF-54", MON, NIA);
			w.row("PF-54", "", "In Transit");
		}, async (w) => {
			eq(await w.pickups(), [0, 0], "no driver on the sheet now: not a load moved from one driver to another, so it stays as live, nobody's");
		});
		// A Load ID holding contact text stays its own driver's to read.
		await inWorld((w) => {
			w.accepted(CONTACT_ID, MON, NIA);
			w.picked(CONTACT_ID, MON, NIA);
			w.row(CONTACT_ID, OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			const nia = await w.get(OWN_WEEK, USERS.nia);
			const omar = await w.get(OWN_WEEK, USERS.omar);
			eq(nia.json.weeks[0].credits.pickups, 1, "her pickup of a load whose ID holds contact text still counts");
			ok(!nia.text.includes(CONTACT), "but the ID's contact isn't hers now that the load isn't", nia.text.slice(0, 200));
			ok(nia.json.weeks[0].loads[0]?.loadId.startsWith("12345"), "and she still reads its number");
			ok(omar.text.includes(CONTACT), "its own driver reads the ID as stored, as his load card does");
		});
		await inWorld((w) => {
			w.accepted(CONTACT_ID, MON, NIA);
			w.picked(CONTACT_ID, MON, NIA);
			w.row(CONTACT_ID, NIA, "Dispatched");
			w.row(CONTACT_ID, OMAR, "In Transit");
		}, async (w) => {
			const nia = await w.get(OWN_WEEK, USERS.nia);
			eq(nia.json.weeks[0].credits.pickups, 1, "a stale copy naming her, the load now his: her pickup counts");
			ok(!nia.text.includes(CONTACT), "and the ID's contact stays with its driver", nia.text.slice(0, 200));
		});
		await inWorld((w) => {
			w.accepted("5550001234", MON, NIA);
			w.picked("5550001234", MON, NIA);
			w.row("5550001234", NIA, "Dispatched", "", "555-000-1234");
			w.row("5550001234", OMAR, "In Transit");
		}, async (w) => {
			const nia = await w.get(OWN_WEEK, USERS.nia);
			eq(nia.json.weeks[0].credits.pickups, 1, "an ID that is the phone number on a stale copy only: her pickup counts");
			ok(!nia.text.includes("5550001234"), "and the number is read off every copy, not just the bottom row", nia.text.slice(0, 200));
		});
		// One ID can hold more than one number: every copy's contact runs over what the last one left.
		for (const [how, id, rows] of [
			["its number on a stale copy", "5550100142", [[NIA, "Dispatched", "555-010-0142"], [OMAR, "In Transit", ""]]],
			["two numbers, one on a stale copy and one on the bottom row", "5550100142 5550100143", [[NIA, "Dispatched", "555-010-0142"], [OMAR, "In Transit", "555-010-0143"]]],
			["two numbers, one on each of two stale copies", "5550100142 5550100143", [[NIA, "Dispatched", "555-010-0142"], [NIA, "Dispatched", "555-010-0143"], [OMAR, "In Transit", ""]]],
			["two numbers, one on a stale copy in the other order", "5550100142 5550100143", [[NIA, "Dispatched", "555-010-0143"], [NIA, "Dispatched", "555-010-0142"], [OMAR, "In Transit", ""]]],
			["a formatted number and one on a stale copy", "555-010-0142 5550100143", [[NIA, "Dispatched", "555-010-0143"], [OMAR, "In Transit", ""]]],
			["a number the bottom row holds, and a formatted one", "5550100143 555-010-0142", [[NIA, "Dispatched", ""], [OMAR, "In Transit", "555-010-0143"]]],
		]) {
			await inWorld((w) => {
				w.accepted(id, MON, NIA);
				w.picked(id, MON, NIA);
				for (const [driver, status, phone] of rows) w.row(id, driver, status, "", phone);
			}, async (w) => {
				const nia = await w.get(OWN_WEEK, USERS.nia);
				eq(nia.json.weeks[0].credits.pickups, 1, `an ID holding ${how}: her pickup counts`);
				const shown = nia.json.weeks[0].loads[0]?.loadId || "";
				ok(shown.includes("[contact withheld]") && !/555\D?010\D?014/.test(nia.text), `an ID holding ${how}: no number of it reaches her`, shown);
			});
		}
		await inWorld((w) => {
			w.accepted(CONTACT_ID, MON, NIA);
			w.picked(CONTACT_ID, MON, NIA);
			w.row(CONTACT_ID, NIA, "Delivered", `${TUE} 15:00`);
			w.row(CONTACT_ID, OMAR, "Dispatched");
		}, async (w) => {
			const nia = await w.get(OWN_WEEK, USERS.nia);
			eq(nia.json.weeks[0].loads.map((l) => [l.pickup, l.delivery]), [[PICKED("Mon"), DONE("Tue")]], "her word on a load she delivered, a copy below naming him: both credits are hers, on one row");
			ok(nia.text.includes(CONTACT), "and the row her invoice bills serves the ID as stored, as her invoice does");
			eq((await w.weeks("omar"))[0].loads, [], "with nothing for the copy's driver");
		});
		await inWorld((w) => {
			w.picked(CONTACT_ID, MON, NIA);
			w.row(CONTACT_ID, NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.loadId), [CONTACT_ID], "a driver with only the pickup of a load still his reads it as stored, as live");
		});
	});

	await section("29 a status moved back: gone only where the record is certain", async () => {
		await inWorld((w) => {
			w.picked("PF-15", MON, NIA);
			w.hist("PF-15", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.row("PF-15", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "staff moved it back to Dispatched and it's still there: the departure no longer stands");
		});
		await inWorld((w) => {
			w.picked("PF-16", MON, NIA);
			w.hist("PF-16", "override", "At Shipper", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.row("PF-16", NIA, "At Shipper");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "moved back only as far as At Shipper: it hasn't left either");
		});
		await inWorld((w) => {
			w.picked("PF-5b", MON, NIA);
			w.row("PF-5b", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "a departure on record and the sheet back at Dispatched, with no row: a move back outside the status routes");
		});
		// A blank status cell says nothing, so it isn't back.
		for (const [how, rows, staffBack] of [
			["a blank status cell", [["PF-B", NIA, ""]], false],
			["a blank status cell after staff's move back", [["PF-B", NIA, ""]], true],
			["a blank copy above a waiting one", [["PF-B", NIA, ""], ["PF-B", NIA, "Dispatched"]], false],
			["a waiting copy above a blank one", [["PF-B", NIA, "Dispatched"], ["PF-B", NIA, ""]], false],
			["a blank status cell of spaces", [["PF-B", NIA, "   "]], false],
		]) {
			await inWorld((w) => {
				w.picked("PF-B", MON, NIA);
				if (staffBack) w.hist("PF-B", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
				for (const r of rows) w.row(...r);
			}, async (w) => {
				eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Mon")], `${how}: it stands, as live`);
			});
		}
		for (const [how, sheetRows] of [
			["the sheet says it left again", [["PF-15b", NIA, "In Transit"]]],
			["the sheet says delivered", [["PF-15b", NIA, "Delivered", `${TUE} 15:00`]]],
			["a copy on the sheet has left", [["PF-15b", NIA, "In Transit"], ["PF-15b", NIA, "Dispatched"]]],
		]) {
			await inWorld((w) => {
				w.picked("PF-15b", MON, NIA);
				w.hist("PF-15b", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
				for (const r of sheetRows) w.row(...r);
			}, async (w) => {
				eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Mon")], `moved back, but ${how}: not certain, so it stands as live`);
			});
		}
		// A tap back and forward on a truck with no ELD: one person's word moves nothing across a week, and a
		// `manual` row with no role is nobody's word, so its forward tap moves nothing either.
		for (const [how, role] of [["by a Driver session", AS_DRIVER], ["with no role on record", {}]]) {
			await inWorld((w) => {
				w.hist("PF-M4", "manual", "In Transit", `${LAST_FRI} 14:00:00`, NIA, role);
				w.hist("PF-M4", "manual", "At Receiver", `${MON} 08:00:00`, NIA, role);
				w.hist("PF-M4", "manual", "Dispatched", `${MON} 09:00:00`, NIA, role);
				w.hist("PF-M4", "manual", "In Transit", `${MON} 09:01:00`, NIA, role);
				w.row("PF-M4", NIA, "In Transit");
			}, async (w) => {
				const nia = await w.weeks("nia");
				eq([nia[0].credits.pickups, nia[1].credits.pickups], [0, 1], `a tap back and forward ${how}: the credit stays in last week`);
				eq(nia[1].loads, [{ loadId: "PF-M4", pickup: PICKED("Fri"), delivery: null }], `a tap back and forward ${how}: on its first day`);
				eq(nia[0].loads, [], `a tap back and forward ${how}: and adds no row this week`);
			});
		}
		// Fri 11:50 PM Eastern, then back and forward in Saturday's first minutes: the very edge of the week.
		await inWorld((w) => {
			w.hist("PF-M4b", "manual", "In Transit", "2026-11-07 04:50:00", NIA, AS_DRIVER);
			w.hist("PF-M4b", "manual", "At Shipper", "2026-11-07 05:10:00", NIA, AS_DRIVER);
			w.hist("PF-M4b", "manual", "In Transit", "2026-11-07 05:15:00", NIA, AS_DRIVER);
			w.hist("PF-M4b", "manual", "Delivered", `${MON} 09:00:00`, NIA, AS_DRIVER);
			w.row("PF-M4b", NIA, "Delivered", `${MON} 09:00`);
		}, async (w) => {
			const nia = await w.weeks("nia");
			eq([nia[0].credits.pickups, nia[1].credits.pickups], [0, 1], "back and forward over the week's edge: the credit doesn't cross it");
			eq(nia[0].loads[0].pickup, { note: "last-week" }, "and this week's delivery row says it was last week");
		});
		await inWorld((w) => {
			w.hist("PF-M4c", "manual", "In Transit", `${LAST_FRI} 14:00:00`, NIA, AS_DRIVER);
			w.hist("PF-M4c", "accept", "Assigned", `${MON} 09:00:00`, NIA, { old: "Dispatched", ...AS_DRIVER });
			w.hist("PF-M4c", "manual", "In Transit", `${MON} 09:01:00`, NIA, AS_DRIVER);
			w.row("PF-M4c", NIA, "In Transit");
		}, async (w) => {
			eq((await w.pickups(1))[0], 1, "an accept of his over a departure is his own word too: nothing moves");
		});
		await inWorld((w) => {
			w.picked("PF-81", MON, NIA);
			w.hist("PF-81", "geofence", "At Receiver", `${MON} 19:00:00`, NIA);
			w.hist("PF-81", "manual", "Dispatched", `${MON} 19:30:00`, NIA, AS_DRIVER);
			w.hist("PF-81", "manual", "Delivered", `${MON} 19:35:00`, NIA, AS_DRIVER);
			w.row("PF-81", NIA, "Delivered", `${MON} 15:00`);
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-81", pickup: PICKED("Mon"), delivery: DONE("Mon") }], "his own stray tap back, the whole trip on record: the pickup stands");
		});
		await inWorld((w) => {
			w.picked("PF-82", MON, NIA);
			w.hist("PF-82", "manual", "Dispatched", `${MON} 15:00:00`, NIA, AS_DRIVER);
			w.row("PF-82", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "his own tap back by a Driver session, still there on the sheet: his own word alone, so it stands as live");
		});
		// The driver app's stepper only offers the next step, so a tap back with no role reads as the office's.
		await inWorld((w) => {
			w.picked("PF-82b", MON, NIA);
			w.hist("PF-82b", "manual", "Dispatched", `${MON} 15:00:00`, NIA);
			w.row("PF-82b", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "a tap back with no role on record, still there on the sheet: read as staff's, so the departure no longer stands");
		});
		await inWorld((w) => {
			w.picked("PF-82c", MON, NIA);
			w.hist("PF-82c", "manual", "Dispatched", `${MON} 15:00:00`, OMAR, AS_DRIVER);
			w.row("PF-82c", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "another driver's tap back over her departure isn't her own, so it's as certain as staff's");
		});
		await inWorld((w) => {
			w.picked("PF-82e", MON, NIA);
			w.hist("PF-82e", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.hist("PF-82e", "geofence", "In Transit", `${TUE} 14:00:00`, OMAR);
			w.hist("PF-82e", "manual", "Dispatched", `${TUE} 15:00:00`, OMAR, AS_DRIVER);
			w.row("PF-82e", OMAR, "Dispatched");
		}, async (w) => {
			eq((await w.pickups()), [0, 1], "the driver who departed last is the one whose own tap back counts as his: it stands, as live");
		});
		for (const [how, departure] of [
			["a dispatcher's tap", (w, id) => w.hist(id, "override", "In Transit", `${MON} 14:00:00`, "disp", AS_STAFF)],
			["an old spelling's geofence row", (w, id) => w.picked(id, MON, "Nia Frosst")],
		]) {
			await inWorld((w) => {
				departure(w, "PF-82d");
				w.hist("PF-82d", "manual", "Dispatched", `${MON} 15:00:00`, NIA, AS_DRIVER);
				w.row("PF-82d", NIA, "Dispatched");
			}, async (w) => {
				eq((await w.weeks("nia"))[0].credits.pickups, 1, `${how} names no driver, so the departure is the sheet's driver's, and that driver's own tap back alone stands as live`);
			});
		}
		// A tap forward with no role moves nothing to another day, after staff's move back too.
		await inWorld((w) => {
			w.hist("PF-86b", "manual", "In Transit", `${LAST_FRI} 14:00:00`, NIA, AS_DRIVER);
			w.hist("PF-86b", "override", "Dispatched", `${MON} 09:00:00`, "disp", AS_STAFF);
			w.hist("PF-86b", "manual", "In Transit", `${MON} 10:00:00`, NIA);
			w.row("PF-86b", NIA, "In Transit");
		}, async (w) => {
			eq(await w.pickups(1), [1, 0], "staff's move back, then a tap with no role on record: the credit stays in last week");
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "and adds nothing this week");
		});
		await inWorld((w) => {
			w.hist("PF-86c", "override", "In Transit", `${MON} 14:00:00`, "disp", AS_STAFF);
			w.hist("PF-86c", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.hist("PF-86c", "override", "In Transit", `${TUE} 14:00:00`, "disp", AS_STAFF);
			w.row("PF-86c", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Tue")], "staff's move back, then staff's own tap: staff's record of the new day stands");
		});
		// The move back's own time decides, so a later row can't take a stored departure's protection away.
		await inWorld((w) => {
			w.hist("PF-E7", "geofence", "In Transit", `${SUN} 14:00:00`, NIA);
			w.hist("PF-E7", "override", "Dispatched", `${SUN} 15:00:00`, "disp", AS_STAFF);
			w.depart("PF-E7", Date.parse(`${MON}T14:00:00Z`), 21);
			w.hist("PF-E7", "accept", "Assigned", `${TUE} 09:00:00`, NIA, { old: "Dispatched", ...AS_DRIVER });
			w.row("PF-E7", NIA, "Assigned");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Sun")], "moved back, a stored departure after that, then his accept: it stands as live");
		});
		await inWorld((w) => {
			w.hist("PF-E7b", "geofence", "In Transit", `${SUN} 14:00:00`, NIA);
			w.depart("PF-E7b", Date.parse(`${SUN}T14:30:00Z`), 21);
			w.hist("PF-E7b", "override", "Dispatched", `${SUN} 15:00:00`, "disp", AS_STAFF);
			w.hist("PF-E7b", "accept", "Assigned", `${TUE} 09:00:00`, NIA, { old: "Dispatched", ...AS_DRIVER });
			w.row("PF-E7b", NIA, "Assigned");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "a stored departure from before the move back keeps nothing");
		});
		await inWorld((w) => {
			w.picked("PF-83", MON, NIA);
			w.hist("PF-83", "manual", "At Shipper", `${MON} 15:00:00`, NIA, AS_DRIVER);
			w.hist("PF-83", "override", "Dispatched", `${MON} 16:00:00`, "disp", AS_STAFF);
			w.row("PF-83", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "his tap back and then staff's: staff's word is certain");
		});
		await inWorld((w) => {
			w.picked("PF-84", MON, NIA);
			w.hist("PF-84", "manual", "At Shipper", `${MON} 15:00:00`, NIA, AS_DRIVER);
			w.hist("PF-84", "geofence", "In Transit", `${TUE} 14:00:00`, NIA);
			w.row("PF-84", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Tue")], "his own tap back with the truck's own departure after it: the credit moves to that departure");
		});
		await inWorld((w) => {
			w.picked("PF-88", MON, NIA);
			w.hist("PF-88", "manual", "Dispatched", `${MON} 15:00:00`, NIA, AS_DRIVER);
			w.hist("PF-88", "geofence", "At Shipper", `${TUE} 13:00:00`, NIA);
			w.row("PF-88", NIA, "At Shipper");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "his tap back, then the truck reaching the shipper again: still no one's word but his, so it stands as live");
		});
		await inWorld((w) => {
			w.picked("PF-89", MON, NIA);
			w.hist("PF-89", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.hist("PF-89", "accept", "Assigned", `${MON} 16:00:00`, NIA, { old: "Dispatched", ...AS_DRIVER });
			w.row("PF-89", NIA, "Assigned");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "staff's move back, then his acceptance of the load: staff's word still stands");
		});
		await inWorld((w) => {
			w.hist("PF-90", "geofence", "In Transit", `${MON} 14:00:00`, NIA);
			w.hist("PF-90", "cancel", "Cancelled", `${MON} 15:00:00`, "disp");
			w.hist("PF-90", "geofence", "In Transit", `${TUE} 14:00:00`, NIA);
			w.row("PF-90", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Tue")], "cancelled on record, then a new departure: the credit is the new one's");
		});
		await inWorld((w) => {
			w.hist("PF-91", "manual", "In Transit", `${MON} 14:00:00`, NIA, AS_DRIVER);
			w.hist("PF-91", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.depart("PF-91", Date.parse(`${SUN}T14:00:00Z`), 21);
			w.hist("PF-91", "manual", "In Transit", `${TUE} 14:00:00`, NIA, AS_DRIVER);
			w.row("PF-91", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Tue")], "a stored ELD record from before the move back doesn't outrank the new departure");
		});
		await inWorld((w) => {
			w.picked("PF-85", MON, NIA);
			w.hist("PF-85", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.hist("PF-85", "geofence", "At Shipper", `${TUE} 13:00:00`, NIA);
			w.hist("PF-85", "manual", "In Transit", `${TUE} 14:00:00`, NIA, AS_DRIVER);
			w.row("PF-85", NIA, "In Transit");
			w.eldOn(21);
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Mon")], "moved back, and the new departure is only his tap on a truck with an ELD: no proof of the new day, so it stands as live");
		});
		await inWorld((w) => {
			w.hist("PF-86", "manual", "In Transit", `${MON} 14:00:00`, NIA, AS_DRIVER);
			w.hist("PF-86", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.hist("PF-86", "manual", "In Transit", `${TUE} 14:00:00`, NIA, AS_DRIVER);
			w.row("PF-86", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Tue")], "staff's move back, then his tap on a truck with no ELD: more than his own word, so the credit moves to the new one");
		});
		// A stored ELD departure never moves a credit, to another day either.
		await inWorld((w) => {
			w.picked("PF-87", MON, NIA);
			w.hist("PF-87", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.depart("PF-87", Date.parse(`${TUE}T14:00:00Z`), 21);
			w.row("PF-87", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Mon")], "moved back, then a stored ELD departure after that: it keeps the credit where live has it, and moves it nowhere");
		});
		await inWorld((w) => {
			w.hist("PF-87b", "manual", "In Transit", `${MON} 14:00:00`, NIA, AS_DRIVER);
			w.hist("PF-87b", "override", "Dispatched", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.depart("PF-87b", Date.parse(`${TUE}T14:00:00Z`), 21);
			w.hist("PF-87b", "manual", "In Transit", `${TUE} 15:00:00`, NIA, AS_DRIVER);
			w.row("PF-87b", NIA, "In Transit");
			w.hist("PF-87c", "geofence", "In Transit", `${MON} 14:00:00`, NIA);
			w.hist("PF-87c", "manual", "Dispatched", `${MON} 15:00:00`, NIA, AS_DRIVER);
			w.depart("PF-87c", Date.parse(`${TUE}T14:00:00Z`), 21);
			w.row("PF-87c", NIA, "In Transit");
		}, async (w) => {
			const byId = new Map((await w.weeks("nia"))[0].loads.map((l) => [l.loadId, l.pickup]));
			eq(byId.get("PF-87b"), PICKED("Tue"), "with no geofence row the stored departure is live's own evidence, on its own day");
			eq(byId.get("PF-87c"), PICKED("Mon"), "and after his own tap back it moves nothing either");
		});
		await inWorld((w) => {
			w.picked("PF-17", MON, NIA);
			w.hist("PF-17", "override", "At Shipper", `${MON} 15:00:00`, "disp", AS_STAFF);
			w.hist("PF-17", "geofence", "In Transit", `${TUE} 14:00:00`, NIA, { old: "At Shipper" });
			w.row("PF-17", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-17", pickup: PICKED("Tue"), delivery: null }], "and the real departure after staff's move back counts, on its own day");
		});
		await inWorld((w) => {
			w.hist("PF-18", "geofence", "In Transit", `${MON} 14:00:00`, NIA);
			w.hist("PF-18", "geofence", "In Transit", `${TUE} 14:00:00`, NIA, { old: "At Shipper" });
			w.row("PF-18", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-18", pickup: PICKED("Tue"), delivery: null }], "a row written from At Shipper after In Transit is a move back no row recorded: the later departure stands");
		});
		await inWorld((w) => {
			w.hist("PF-19", "geofence", "In Transit", `${LAST_THU} 15:00:00`, NIA);
			w.hist("PF-19", "override", "Dispatched", `${LAST_FRI} 15:00:00`, "disp", AS_STAFF);
			w.picked("PF-19", MON, NIA);
			w.row("PF-19", NIA, "Delivered", `${MON} 15:00`);
		}, async (w) => {
			const nia = await w.weeks("nia");
			eq(nia[0].loads, [{ loadId: "PF-19", pickup: PICKED("Mon"), delivery: DONE("Mon") }], "moved back, then picked up again this week: its credit is this week's");
			eq([nia[1].credits.pickups, nia[1].loads], [0, []], "and none last week, so one load earns one pickup");
		});
		await inWorld((w) => {
			w.hist("PF-20", "geofence", "In Transit", `${MON} 14:00:00`, NIA);
			w.hist("PF-20", "cancel", "Cancelled", `${MON} 15:00:00`, "disp");
			w.hist("PF-20", "dispatch", "Dispatched", `${TUE} 09:00:00`, "disp");
			w.row("PF-20", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "cancelled and dispatched again: the old row doesn't count");
		});
		await inWorld((w) => {
			w.depart("PF-21", Date.parse(`${MON}T14:00:00Z`), 21);
			w.hist("PF-21", "override", "Dispatched", `${MON} 20:00:00`, "disp", AS_STAFF);
			w.row("PF-21", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "as live: a status row dated after an ELD record takes nothing from it, with no departure status gone back");
		});
		await inWorld((w) => {
			w.hist("PF-23", "geofence", "In Transit", `${MON} 14:00:00`, NIA);
			w.hist("PF-23", "cancel", "Cancelled", `${MON} 15:00:00`, "disp");
			w.row("PF-23", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "cancelled on record, but the sheet reads In Transit again: not certain, so it stands as live");
		});
		await inWorld((w) => {
			w.picked("PF-24", MON, NIA);
			w.hist("PF-24", "manual", "Delivered", `${MON} 20:00:00`, NIA, AS_DRIVER);
			w.hist("PF-24", "override", "At Receiver", `${TUE} 10:00:00`, "disp", AS_STAFF);
			w.row("PF-24", NIA, "At Receiver");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "staff reopening a delivered load isn't a move back over its departure");
		});
	});

	await section("30 what doesn't change", async () => {
		// Left as live, each with its own ruling still to come: each shape reads as the live count reads it.
		await inWorld((w) => {
			w.picked("PF-2", MON, NIA);
			w.row("PF-2", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-2", pickup: PICKED("Mon"), delivery: null }], "as live: a plain pass-by reads like a pickup");
		});
		await inWorld((w) => {
			w.hist("PF-3", "geofence", "In Transit", `${MON} 10:00:00`, NIA);
			w.row("PF-3", NIA, "In Transit");
			w.picked("PF-4", MON, NIA);
			w.row("PF-4", NIA, "Delivered", `${TUE} 15:00`);
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 2, "as live: a load picked up while another reads under way earns");
		});
		await inWorld((w) => {
			w.hist("PF-6", "dispatch", "Dispatched", `${MON} 09:00:00`, "disp");
			w.depart("PF-6", Date.parse(`${SUN}T14:00:00Z`), 21);
			w.hist("PF-6", "geofence", "At Shipper", `${MON} 13:00:00`, NIA);
			w.hist("PF-6", "manual", "In Transit", `${MON} 14:00:00`, NIA);
			w.row("PF-6", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-6", pickup: PICKED("Sun"), delivery: null }], "as live: an ELD record dated before the dispatch row stands, on its own day");
		});
		await inWorld((w) => {
			w.depart("PF-6b", Date.parse(`${MON}T14:00:00Z`), 21);
			w.row("PF-6b", NIA, "Assigned");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "as live: an ELD record on a load with no departure status on record stands, whatever the sheet still reads");
		});
		await inWorld((w) => {
			for (const id of ["PF-7", "PF-8"]) {
				w.picked(id, MON, NIA);
				w.row(id, NIA, "Delivered", `${MON} 15:00`);
			}
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.value, 2, "as live: two loads at one shipper in one visit each earn");
		});
		await inWorld((w) => {
			const oneDeparture = Date.parse(`${MON}T14:00:00Z`);
			for (const [id, hour] of [["PF-9", 15], ["PF-10", 16]]) {
				w.depart(id, oneDeparture, 21);
				w.row(id, NIA, "Delivered", `${TUE} ${hour}:00`);
			}
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.value, 2, "as live: one truck's one recorded departure on two of her loads: each earns");
		});
		await inWorld((w) => {
			w.hist("PF-22", "manual", "In Transit", `${MON} 14:00:00`, NIA);
			w.hist("PF-22", "manual", "In Transit", `${TUE} 14:00:00`, NIA);
			w.row("PF-22", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Mon")], "as live: two departures on record, nothing gone back: the first is the one that counts");
		});
		const friday = Date.parse("2026-11-14T04:30:00Z"); // Fri Nov 13, 11:30 PM Eastern
		await inWorld((w) => {
			w.hist("PF-56", "geofence", "In Transit", "2026-11-14 02:00:00", NIA); // Fri 9 PM Eastern, already Saturday in UTC
			w.row("PF-56", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-56", pickup: PICKED("Fri"), delivery: null }], "a pickup late on the week's last evening counts in that week");
		}, { nowMs: friday });
		await inWorld((w) => {
			w.hist("PF-57", "geofence", "In Transit", "2026-10-31 14:00:00", NIA); // the first day of last week
			w.row("PF-57", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[1].loads, [{ loadId: "PF-57", pickup: PICKED("Sat"), delivery: null }], "and so does one on last week's first morning");
		});

		// Made-up sheets, each with some of every shape above, and the rules every answer must keep.
		let seed = 20261105;
		const rand = (n) => {
			seed = (seed * 1664525 + 1013904223) % 4294967296;
			return Math.floor((seed / 4294967296) * n);
		};
		const pick = (list) => list[rand(list.length)];
		const days = [LAST_THU, LAST_FRI, "2026-11-07", SUN, MON, TUE];
		const w = await proofWorld(() => {});
		const drivers = [[NIA, "nia"], [OMAR, "omar"]];
		const totals = { sheets: 0, weeks: 0, sumOff: 0, short: 0, over: 0, idsOff: 0, doubled: 0, leaked: 0, unlinked: 0, keys: 0, moved: 0, multiRow: 0 };
		try {
			for (let s = 0; s < 60; s++) {
				w.jt = null;
				w.handle.clearCache();
				w.extraLoads.length = 0;
				for (const t of ["load_status_history", "load_eld_miles", "deleted_loads"]) w.db.prepare(`DELETE FROM ${t}`).run();
				const hasWord = new Set();
				for (let i = 0; i < 12; i++) {
					const id = `FZ-${s}-${i}`;
					const [holder] = pick(drivers);
					const [cell] = rand(3) === 0 ? pick(drivers) : [holder];
					const day = pick(days);
					const done = pick(days);
					const shape = pick(["clean", "clean", "picked", "word", "word", "tap", "blank-tap", "blank-word", "late-eld", "moved", "own-back", "none", "dispatch", "eld", "eld-word", "stale"]);
					const hasOwn = () => hasWord.add(`${id.toLowerCase()}|${holder}`);
					const word = () => { w.accepted(id, day, holder); hasOwn(); };
					if (shape === "clean") { w.picked(id, day, holder); w.hist(id, "manual", "Delivered", `${day} 20:00:00`, holder, AS_DRIVER); hasOwn(); }
					if (shape === "picked") w.picked(id, day, holder);
					if (shape === "word") { word(); w.picked(id, day, holder); }
					if (shape === "tap") { w.hist(id, "manual", "In Transit", `${day} 14:00:00`, holder, AS_DRIVER); hasOwn(); }
					if (shape === "blank-tap") w.hist(id, "manual", "In Transit", `${day} 14:00:00`, holder);
					if (shape === "blank-word") { w.hist(id, "manual", "Loading", `${day} 13:30:00`, holder); w.picked(id, day, holder); }
					if (shape === "late-eld") { w.accepted(id, day, holder); w.picked(id, day, holder); w.depart(id, Date.parse(`${day}T22:00:00Z`), holder === NIA ? 22 : 21); }
					if (shape === "moved") { word(); w.picked(id, day, holder); w.hist(id, "override", pick(["Dispatched", "At Shipper"]), `${day} 15:00:00`, "disp", AS_STAFF); }
					if (shape === "own-back") { word(); w.picked(id, day, holder); w.hist(id, "manual", "Dispatched", `${day} 15:00:00`, holder, AS_DRIVER); }
					if (shape === "dispatch") w.hist(id, "override", "In Transit", `${day} 14:00:00`, "disp", AS_STAFF);
					if (shape === "eld") w.depart(id, Date.parse(`${day}T14:00:00Z`), holder === NIA ? 21 : 22);
					if (shape === "eld-word") { word(); w.depart(id, Date.parse(`${day}T14:00:00Z`), holder === NIA ? 21 : 22); }
					if (shape === "stale") w.hist(id, "geofence", "In Transit", `${day} 14:00:00`, "Old Spelling");
					const status = pick(["Delivered", "Delivered", "In Transit", "Dispatched", "At Receiver", ""]);
					w.row(id, cell, status, status === "Delivered" && rand(5) ? `${done} 15:00` : "");
					if (rand(3) === 0) {
						totals.multiRow += 1;
						w.row(pick([id, `#${id}`]), pick([cell, cell, "", OMAR]), pick(["Delivered", "Cancelled", "Dispatched", "In Transit"]), rand(2) ? `${pick(days)} 16:00` : "");
					}
					if (rand(15) === 0) w.db.prepare("INSERT OR IGNORE INTO deleted_loads (load_id) VALUES (?)").run(id.toLowerCase());
				}
				totals.sheets += 1;
				const credited = new Map();
				for (const [name, who] of drivers) {
					const r = await w.get(OWN_WEEK, USERS[who]);
					if (!allKeys(r.json).every((k) => /^(creditWeights|delivery|pickup|pickups|view|weeks|credits|end|id|left|loads|newWeekNote|nextWeekStarts|pace|percent|required|start|targetLowered|deliveries|target|value|loadId|day|note|barColor|pastWeeks|countedFrom)$/.test(k))) totals.keys += 1;
					const other = name === NIA ? OMAR : NIA;
					if (new RegExp(other.split(" ")[0], "i").test(r.text)) totals.leaked += 1;
					r.json.weeks.forEach((week, i) => {
						totals.weeks += 1;
						const sum = week.loads.reduce((t, l) => t + (l.pickup.credits || 0) + (l.delivery ? l.delivery.credits : 0), 0);
						if (sum !== week.credits.value) totals.sumOff += 1;
						const billed = w.invoiceBills(name, i === 0 ? THIS_WEEK : LAST_WEEK);
						if (week.credits.deliveries < billed.length) totals.short += 1;
						if (week.credits.deliveries > billed.length) totals.over += 1;
						const rowIds = week.loads.filter((l) => l.delivery).map((l) => l.loadId.toLowerCase().replace(/^#/, "")).sort();
						if (JSON.stringify(rowIds) !== JSON.stringify(billed.map((row) => row["Load ID"].toLowerCase().replace(/^#/, "")).sort())) totals.idsOff += 1;
						for (const l of week.loads) {
							if (!l.pickup.credits) continue;
							const key = l.loadId.toLowerCase().replace(/^#/, "");
							if (credited.has(key)) totals.doubled += 1;
							credited.set(key, name);
							const bottom = [...w.extraLoads].reverse().find((row) => row[0].toLowerCase().replace(/^#/, "") === key);
							if (bottom && bottom[1] === name) continue;
							totals.moved += 1;
							if (!hasWord.has(`${key}|${name}`)) totals.unlinked += 1;
						}
					});
				}
			}
		} finally {
			await w.close();
		}
		eq([totals.sheets, totals.weeks], [60, 240], "60 made-up sheets, 2 drivers, 2 weeks each");
		ok(totals.moved > 0 && totals.multiRow > 0, "with handovers and loads on two rows among them", JSON.stringify(totals));
		eq(totals.sumOff, 0, "the count equals the sum of its rows, every week");
		eq([totals.short, totals.over], [0, 0], "deliveries equal the invoice's own selector over every row: never short, never over");
		eq(totals.idsOff, 0, "and on the same loads");
		eq(totals.doubled, 0, "no load earns its pickup twice, for two drivers or in two weeks");
		eq(totals.unlinked, 0, "no credit reaches a driver the bottom row doesn't name without an accept or a Driver-role tap naming him on the load, and no later stored departure against it");
		eq([totals.leaked, totals.keys], [0, 0], "each driver's answer holds his own figures and no other driver's name, in the same keys");

		// The proof on its own, with every fact handed to it.
		const proof = proofModule();
		const norm = (s) => String(s || "").trim().toLowerCase();
		const facts = { normalizeName: norm, isDriverName: (k) => k === "ann" || k === "bob", truckHasEldAt: () => false, heldTruck: () => false };
		const row = (status, source, at, actor = "ann", more = {}) => ({ new_status: status, source, changed_at: `2026-11-09 ${at}:00`, actor, ...more });
		const at = (t) => Date.parse(`2026-11-09T${t}:00Z`);
		const go = [row("In Transit", "geofence", "14:00")];
		const accept = row("Assigned", "accept", "09:00");
		const stated = (answer) => answer && [answer.driverKey, answer.ms, answer.source];
		eq(stated(proof.qualifiedPickup({ ...facts, events: go, driverNow: "ann" })), ["ann", at("14:00"), "geofence"], "proof: a geofence departure, the sheet's driver's");
		eq(stated(proof.qualifiedPickup({ ...facts, events: go, driverNow: "bob" })), ["bob", at("14:00"), "geofence"], "proof: another's geofence row alone moves nothing");
		eq(stated(proof.qualifiedPickup({ ...facts, events: [accept, ...go], driverNow: "bob" })), ["ann", at("14:00"), "geofence"], "proof: with her accept it moves");
		eq(proof.qualifiedPickup({ ...facts, events: go, driverNow: "ann", waitingOnSheet: true }), null, "proof: the sheet says it hasn't left");
		eq(proof.qualifiedPickup({ ...facts, events: [...go, row("Dispatched", "override", "15:00", "disp", { actor_role: "Dispatcher" })], driverNow: "ann", waitingOnSheet: true }), null, "proof: moved back and still there");
		eq(proof.qualifiedPickup({ ...facts, events: [row("In Transit", "manual", "14:00")], driverNow: "ann", truckHasEldAt: () => true }), null, "proof: a tap on a truck with a reporting ELD");
		eq(proof.qualifiedPickup({ ...facts, events: [row("In Transit", "manual", "14:00")], driverNow: "ann" }).source, "driver", "proof: a tap on one without");
		eq(proof.qualifiedPickup({ ...facts, events: [row("In Transit", "override", "14:00", "disp")], driverNow: "bob" }).source, "dispatch", "proof: a dispatcher's tap");
		eq(stated(proof.qualifiedPickup({ ...facts, events: [accept], driverNow: "bob", eldDepart: { ms: at("14:00"), truckId: 7 } })), ["bob", at("14:00"), "eld"], "proof: a stored departure stays with the sheet's driver, her word or not");
		const later = { ms: at("15:00"), truckId: 7 };
		eq(stated(proof.qualifiedPickup({ ...facts, events: [accept, ...go], driverNow: "bob", eldDepart: later })), ["bob", at("14:00"), "geofence"], "proof: a later stored departure on a truck she didn't hold keeps it as live");
		const asked = [];
		eq(stated(proof.qualifiedPickup({ ...facts, events: [accept, ...go], driverNow: "bob", eldDepart: later, heldTruck: (...a) => { asked.push(a); return true; } })), ["ann", at("14:00"), "geofence"], "proof: on her own truck it moves");
		eq(asked, [["ann", 7, at("15:00")]], "proof: decided by who held that truck when the record says it left");
		eq(stated(proof.qualifiedPickup({ ...facts, events: [row("Assigned", "accept", "09:00", "ann", { actor_role: "Dispatcher" }), ...go], driverNow: "bob" })), ["bob", at("14:00"), "geofence"], "proof: a staff role on an accept is no word");
		eq(stated(proof.qualifiedPickup({ ...facts, events: [row("Loading", "manual", "13:00", "ann", { actor_role: "Driver" }), ...go], driverNow: "bob" })), ["ann", at("14:00"), "geofence"], "proof: a Driver role on a tap forward is one");
		eq(stated(proof.qualifiedPickup({ ...facts, events: [row("Loading", "manual", "13:00"), ...go], driverNow: "bob" })), ["bob", at("14:00"), "geofence"], "proof: no role on a tap is none");
		eq(proof.qualifiedPickup({ ...facts, events: [], driverNow: "ann" }), null, "proof: nothing on record, nothing to judge");
		eq(Object.keys(proof.qualifiedPickup({ ...facts, events: go, driverNow: "ann" })), ["driverKey", "ms", "source"], "and a credit carries nothing more");
		eq(proof.statusesStillWaiting(["Dispatched", "At Shipper", "Loading", "Cancelled"]), true, "the sheet: nothing past its shipper");
		eq(proof.statusesStillWaiting(["Dispatched", "In Transit"]), false, "the sheet: one row has left");
		eq(proof.statusesStillWaiting(["Cancelled"]), false, "the sheet: a cancelled load isn't a waiting one");
		eq([proof.statusesStillWaiting([""]), proof.statusesStillWaiting(["  "]), proof.statusesStillWaiting([null]), proof.statusesStillWaiting(["Dispatched", ""])], [false, false, false, false], "the sheet: a blank cell isn't a waiting one");
		eq(["Unassigned", "Dispatched", "Assigned", "Heading to Shipper", "At Shipper", "Loading"].map((s) => proof.statusesStillWaiting([s])), [true, true, true, true, true, true], "the sheet: each status before a departure is a waiting one");
		eq(["Cancelled", "Canceled", "Cancel"].map((s) => [proof.statusesStillWaiting([s]), proof.statusesStillWaiting(["Dispatched", s])]), [[false, true], [false, true], [false, true]], "the sheet: each spelling of cancelled is set aside");
		const src = fs.readFileSync(path.join(ROOT, "lib", "driver-pickup-proof.js"), "utf8");
		eq([...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]), ["./arrival-pickup", "./driver-performance"], "the proof requires only the pure rules");
		ok(!/\bdb\b|process\.env|Date\.now|new Date/.test(src.replace(/\/\/.*$/gm, "")), "and reads no database, setting or clock");
		const routesCode = fs.readFileSync(path.join(ROOT, "lib", "driver-performance-routes.js"), "utf8");
		ok(!/routemate_telemetry|load_coordinates|fuel-pickup-arrival|twinAtShipper|buildEldDeviceResolver|other_load_hauling|pickup_zone/.test(routesCode), "no twin, errand or other-load test: the route reads no track, mapped pickup or recorder mark");
		ok(/SELECT load_id, truck_id, pickup_depart_ms/.test(routesCode), "it reads which truck a stored departure names, only to keep a credit as live");
		// Nothing that pays reads the kept rows.
		const libFiles = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js"));
		eq(libFiles.filter((f) => /everyJobTrackingRow/.test(fs.readFileSync(path.join(ROOT, "lib", f), "utf8"))).sort(), ["deleted-load-restore.js", "driver-performance-routes.js", "job-tracking-every-row.js"], "only this feature's routes and the deleted-load restore (its month check and row match) read the kept rows");
		eq(libFiles.filter((f) => /driver-pickup-proof/.test(fs.readFileSync(path.join(ROOT, "lib", f), "utf8"))), ["driver-performance-routes.js"], "and only they read the proof");
		const { STATEMENT_TEMPLATE_FILES } = require(path.join(ROOT, "lib", "statement-template-hash.js"));
		eq(STATEMENT_TEMPLATE_FILES.filter((f) => /job-tracking-every-row|driver-pickup-proof/.test(f)), [], "no stored statement's template holds either new file");
		lifted();
		eq((SRC.match(/process\.env\.DRIVER_PERFORMANCE[A-Z_]*/g) || []).sort(), ["process.env.DRIVER_PERFORMANCE_BOARD_ENABLED", "process.env.DRIVER_PERFORMANCE_ENABLED", "process.env.DRIVER_PERFORMANCE_HOURS_ENABLED"],
			"no other new flag: the weeks go live on deploy under the kill switch that's there, and only the hours wait, behind their own");
	});

	// ── §31 ─────────────────────────────────────────────────────────────────
	// Wed Dec 2: this week is Nov 28 - Dec 4, last week Nov 21-27, and the first counted week Nov 7.
	const DEC_2 = Date.parse("2026-12-02T17:00:00Z");
	const pastOf = (body) => (body && Array.isArray(body.pastWeeks) ? body.pastWeeks : null);
	await section("31 Past Performance over HTTP", async () => {
		const p = need();
		eq(p.FIRST_COUNTED_WEEK, "2026-11-07", "the first counted week is the week of Sat Nov 7, one constant");
		eq([p.countedFrom(), p.countedFrom("2026-11-14")], ["Nov 7", "Nov 14"], "its date as the line says it");
		const weekRange = liftedGetWeekRange();
		eq(p.ownPeriods("2026-12-02", weekRange).map((x) => [x.id, x.start, x.end, x.lastDay]), [
			["this-week", "2026-11-28", "2026-12-04", "2026-12-02"],
			["last-week", "2026-11-21", "2026-11-27", "2026-11-27"],
			["week-2026-11-14", "2026-11-14", "2026-11-20", "2026-11-20"],
			["week-2026-11-07", "2026-11-07", "2026-11-13", "2026-11-13"],
		], "his own weeks: this week to today, last week, then each week back to the first counted one, newest first, none before it");
		eq(p.ownPeriods("2026-11-11", weekRange).map((x) => x.id), ["this-week", "last-week"], "in the first counted week itself: this week and last, and nothing older");
		eq(p.ownPeriods("2026-12-02", weekRange, "").map((x) => x.id), ["this-week", "last-week"], "no first week it can read: no older week, and no endless list");
		eq([0, 0.5, 3, 3.5, 4, 5.5, 5.9, 6, 7.5, 7.6, 8, 12].map((v) => p.barColorFor(v)),
			["red", "red", "red", "red", "orange", "orange", "orange", "green", "green", "blue", "blue", "blue"],
			"the bar's colors: red below 4, 3.5 included; orange 4 to 5.5; green 6 to 7.5; blue past 7.5");
		eq(p.BAR_COLOR_FROM, { orange: 4, green: 6, blueAbove: 7.5 }, "the bands are one constant, at D's figures");

		const dec = await makeWorld({}, { nowMs: DEC_2 });
		try {
			const ada = (await dec.get("/api/driver/me/performance", USERS.ada)).json;
			eq(ada.weeks.map((w) => [w.id, w.start]), [["this-week", "2026-11-28"], ["last-week", "2026-11-21"]], "this week and last, as before, for the bar");
			eq(pastOf(ada) && pastOf(ada).map((w) => [w.start, w.end, w.credits.value, w.credits.target]), [
				["2026-11-21", "2026-11-27", 0, 7.5],
				["2026-11-14", "2026-11-20", 0, 7.5],
				["2026-11-07", "2026-11-13", 3, 7.5],
			], "Ada's past weeks, newest first, from the first counted week: the week of Nov 7 has the 3 it had as this week, and Oct 31 isn't listed");
			eq(ada.countedFrom, "Nov 7", "the line's date: weeks before Nov 7 weren't counted");
			eq((pastOf(ada) || []).map((w) => sortedKeys(w)), new Array(3).fill(["credits", "end", "start"]), "a past week is its days and its figure, nothing more");
			eq((pastOf(ada) || []).map((w) => sortedKeys(w.credits)), new Array(3).fill(["target", "value"]), "...its figure of its own target");
			ok(!allKeys(pastOf(ada) || [{ hours: 1 }]).some((k) => /hour|minute|driving|rei|rank|unit|pay/i.test(k)), "with the hours switch off, no past week carries hours, a rank or pay");
			const ben = (await dec.get("/api/driver/me/performance", USERS.ben)).json;
			eq((pastOf(ben) || []).map((w) => [w.start, w.credits.value]), [["2026-11-21", 0], ["2026-11-14", 0], ["2026-11-07", 2]], "Ben's own past weeks: his own figures, never Ada's");
			ok(!/ada|quill/i.test(JSON.stringify(ben)) && !/ben|marsh/i.test(JSON.stringify(ada)), "and neither answer names the other driver");
		} finally {
			await dec.close();
		}

		// A week that wasn't his isn't listed: Ben with no truck from Nov 14 until Nov 22, and no load then.
		const gap = await makeWorld({}, { nowMs: DEC_2 });
		try {
			gap.db.prepare("UPDATE truck_assignments SET end_date = ? WHERE driver_name = ?").run("2026-11-13T15:00:00.000Z", "Ben Marsh");
			gap.db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (2, 'Ben Marsh', ?, '')").run("2026-11-22T15:00:00.000Z");
			const ben = (await gap.get("/api/driver/me/performance", USERS.ben)).json;
			eq((pastOf(ben) || []).map((w) => [w.start, w.credits.value]), [["2026-11-21", 0], ["2026-11-07", 2]],
				"the week he held no truck and had no load is left out, never shown as a week that earned nothing");
		} finally {
			await gap.close();
		}

		// In the first counted week itself (Wed Nov 11), there is no past week yet, and last week is before it.
		const nov = (await on.get("/api/driver/me/performance", USERS.ada)).json;
		eq([pastOf(nov), nov.countedFrom], [[], "Nov 7"], "on Nov 11 the list is empty, and the line names the first counted week");
		eq(nov.weeks.map((w) => w.id), ["this-week", "last-week"], "...while this week and last answer as before");

		// The bar's color, from the server, through the route: a made-up week at each of D's edges.
		eq([nov.weeks[0].credits.value, nov.weeks[0].barColor, nov.weeks[1].barColor], [3, "red", null], "Ada's open week at 3 reads red; a closed week carries no color");
		for (const [extra, value, color] of [[1, 3.5, "red"], [5, 5.5, "orange"], [6, 6, "green"], [10, 8, "blue"]]) {
			const loads = Array.from({ length: extra }, (_x, i) => [`DP-77${String(i).padStart(2, "0")}`, "Ada Quill", "Delivered", "2026-11-10 12:00"]);
			const world = await makeWorld({}, { extraLoads: loads });
			try {
				const w = (await world.get("/api/driver/me/performance", USERS.ada)).json.weeks[0];
				eq([w.credits.value, w.barColor], [value, color], `${value} credits this week: the bar is ${color}`);
			} finally {
				await world.close();
			}
		}

		// The switch off: nothing reads the rollup's table, even with rows in it.
		const quiet = await makeWorld({}, { nowMs: DEC_2 });
		try {
			require(path.join(ROOT, "lib", "eld-activity-daily.js")).ensureEldActivitySchema(quiet.db);
			quiet.db.prepare("INSERT INTO eld_activity_daily (routemate_vehicle_id, truck_id, local_day, week_start, driver_id, samples, driving_min, basis) VALUES ('rm-1', 1, '2026-11-09', '2026-11-07', 1, 50, 600, 'gps-estimate')").run();
			const statements = [];
			const prepare = quiet.db.prepare.bind(quiet.db);
			quiet.db.prepare = (sql) => { statements.push(String(sql)); return prepare(sql); };
			const answers = [];
			for (const who of ["ada", "ben", "cal", "hal"]) answers.push(await quiet.get("/api/driver/me/performance", USERS[who]));
			eq(answers.map((r) => r.status), [200, 200, 200, 200], "(the scene) four drivers' answers, each with past weeks");
			ok(statements.length > 0, "(the scene) the spy sees the route's reads", statements.length);
			eq(statements.filter((s) => /eld_activity_daily/i.test(s)), [], "with the hours switch off, no statement reads the daily ELD activity table");
			ok(answers.every((r) => !/"hours"|minutes|Driving/i.test(r.text)), "...and no answer says anything of hours");
		} finally {
			await quiet.close();
		}
	});

	// ── §32 ─────────────────────────────────────────────────────────────────
	await section("32 driving hours, the hours switch on", async () => {
		const p = need();
		const read = { firstDay: "2026-10-05", weeks: [{ week_start: "2026-11-07", minutes: 2310 }, { week_start: "2026-11-14", minutes: 2313 }, { week_start: "2026-11-21", minutes: null }] };
		eq(p.weekDrivingHours(read, "2026-11-07"), { state: "estimate", value: 38.5 }, "a week's minutes, summed by the rollup, read as hours to one decimal");
		eq(p.weekDrivingHours(read, "2026-11-14"), { state: "estimate", value: 38.6 }, "...rounded to the nearest tenth");
		eq([p.weekDrivingHours(read, "2026-11-21"), p.weekDrivingHours(read, "2026-11-28")], [{ state: "none" }, { state: "none" }], "no measured minutes, or no row at all: named, never 0");
		eq(p.weekDrivingHours({ ...read, firstDay: "2026-11-09" }, "2026-11-07"), { state: "starts", day: "Nov 9" }, "a week that starts before the rollup's first day says when hours start, never a part of the week");
		eq(p.weekDrivingHours({ ...read, firstDay: "2026-11-07" }, "2026-11-07"), { state: "estimate", value: 38.5 }, "a week that starts on the rollup's first day is whole: its hours, not a start date");
		eq([p.weekDrivingHours(null, "2026-11-07"), p.weekDrivingHours({ firstDay: "", weeks: [] }, "2026-11-07")], [{ state: "coming-soon" }, { state: "coming-soon" }], "no read, or a table with no day in it: coming soon");

		const ELD = require(path.join(ROOT, "lib", "eld-activity-daily.js"));
		const plant = (db, rows) => {
			ELD.ensureEldActivitySchema(db);
			const add = db.prepare("INSERT INTO eld_activity_daily (routemate_vehicle_id, truck_id, local_day, week_start, driver_id, samples, driving_min, basis) VALUES (?, ?, ?, ?, ?, 40, ?, ?)");
			for (const r of rows) add.run(...r);
		};
		// Ada (directory row 1): four driving days in the week of Nov 7 and a day with no hours data;
		// only a day with no hours data in the week of Nov 14 (a truck that sends none); nothing after.
		// Ben (row 2): his own day in the week of Nov 7, and the table's first day, Oct 5.
		const ROWS = [
			["rm-1", 1, "2026-11-09", "2026-11-07", 1, 600, "gps-estimate"],
			["rm-1", 1, "2026-11-10", "2026-11-07", 1, 650, "gps-estimate"],
			["rm-1", 1, "2026-11-11", "2026-11-07", 1, 560, "gps-estimate"],
			["rm-1", 1, "2026-11-12", "2026-11-07", 1, 500, "gps-estimate"],
			["rm-1", 1, "2026-11-13", "2026-11-07", 1, null, "no-hours-data"],
			["lx-1", 1, "2026-11-16", "2026-11-14", 1, null, "no-hours-data"],
			["rm-2", 2, "2026-11-09", "2026-11-07", 2, 1200, "gps-estimate"],
			["rm-2", 2, "2026-10-05", "2026-10-03", 2, 300, "gps-estimate"],
		];
		const hoursOf = (body) => (pastOf(body) || []).map((w) => [w.start, w.hours]);
		const w = await makeWorld({ DRIVER_PERFORMANCE_HOURS_ENABLED: "true" }, { nowMs: DEC_2 });
		try {
			ok(w.logs.some((l) => l.includes("driving hours on")), "the start-up line says the hours are on");
			plant(w.db, ROWS);
			const statements = [];
			const prepare = w.db.prepare.bind(w.db);
			w.db.prepare = (sql) => { statements.push(String(sql)); return prepare(sql); };
			const ada = (await w.get("/api/driver/me/performance", USERS.ada)).json;
			w.db.prepare = prepare;
			ok(statements.some((s) => /FROM eld_activity_daily/.test(s)), "(the spy's own check) with the switch on, the same spy sees the table read");
			eq(hoursOf(ada), [
				["2026-11-21", { state: "none" }],
				["2026-11-14", { state: "none" }],
				["2026-11-07", { state: "estimate", value: 38.5 }],
			], "Ada: 2,310 minutes over four days are 38.5 h; the week whose truck sends no hours, and the week with none, are named, never 0");
			const ben = (await w.get("/api/driver/me/performance", USERS.ben)).json;
			eq(hoursOf(ben), [["2026-11-21", { state: "none" }], ["2026-11-14", { state: "none" }], ["2026-11-07", { state: "estimate", value: 20 }]],
				"Ben: his own 1,200 minutes, and none of Ada's; hers never include his");
			eq([ada.weeks.map((x) => x.id), sortedKeys(ada)], [["this-week", "last-week"], ["countedFrom", "creditWeights", "pastWeeks", "view", "weeks"]], "the rest of the answer is as it was");
			ok(!allKeys(ada.weeks).some((k) => /hour/i.test(k)), "this week and last carry no hours: only past weeks do");
			// The table gone: the weeks say coming soon, and he still has his answer.
			w.db.exec("DROP TABLE eld_activity_daily");
			const errors = [];
			const realError = console.error;
			console.error = (...a) => errors.push(a.join(" "));
			let down;
			try {
				down = await w.get("/api/driver/me/performance", USERS.ada);
			} finally {
				console.error = realError;
			}
			eq([down.status, hoursOf(down.json).map(([, h]) => h.state)], [200, ["coming-soon", "coming-soon", "coming-soon"]], "a read that fails: each past week says coming soon, and the answer stands");
			ok(errors.some((e) => /driving hours read failed/.test(e)), "...and the failure is logged");
		} finally {
			await w.close();
		}

		// The rollup's data starting mid-way: the weeks before its first day say when hours start.
		const late = await makeWorld({ DRIVER_PERFORMANCE_HOURS_ENABLED: "true" }, { nowMs: DEC_2 });
		try {
			plant(late.db, [["rm-1", 1, "2026-11-16", "2026-11-14", 1, 400, "gps-estimate"], ["rm-1", 1, "2026-11-23", "2026-11-21", 1, 90, "gps-estimate"]]);
			eq(hoursOf((await late.get("/api/driver/me/performance", USERS.ada)).json), [
				["2026-11-21", { state: "estimate", value: 1.5 }],
				["2026-11-14", { state: "starts", day: "Nov 16" }],
				["2026-11-07", { state: "starts", day: "Nov 16" }],
			], "a week that starts before Nov 16, the table's first day, says hours start Nov 16, even with part of a week on record");
		} finally {
			await late.close();
		}

		// Off unless exactly "true", and off with the rollup itself off.
		for (const [env, says] of [[{ DRIVER_PERFORMANCE_HOURS_ENABLED: "TRUE" }, "\"TRUE\""], [{ DRIVER_PERFORMANCE_HOURS_ENABLED: "1" }, "\"1\""], [{ DRIVER_PERFORMANCE_HOURS_ENABLED: "true", ELD_ACTIVITY_DAILY_ENABLED: "false" }, "\"true\" with the rollup off"]]) {
			const off = await makeWorld(env, { nowMs: DEC_2 });
			try {
				plant(off.db, ROWS);
				const r = await off.get("/api/driver/me/performance", USERS.ada);
				eq([r.status, (pastOf(r.json) || []).length, (pastOf(r.json) || []).filter((x) => "hours" in x).length], [200, 3, 0], `${says}: the hours stay off`);
				ok(off.logs.some((l) => l.includes("driving hours off")), `${says}: the start-up line says so`);
			} finally {
				await off.close();
			}
		}
	});

	// ── §33 ─────────────────────────────────────────────────────────────────
	// The Super Admin's page: each driver's own answer, by name, from one read.
	const ADMIN_WEEKS = "/api/admin/driver-performance/weeks";
	const OWN = "/api/driver/me/performance";
	const ACCOUNTS = ["ada", "ben", "cal", "dee", "eli", "fay", "gus", "hal", "jo", "kim", "nobody", "ivy"];
	const directoryIdOf = (who) => (DRIVERS.find((x) => x.user_id === USERS[who].id) || { id: null }).id;
	const driversOf = (r) => (r && r.json && Array.isArray(r.json.drivers) ? r.json.drivers : []);
	// Every account's own answer beside the Super Admin's list: the same drivers, each byte for byte.
	async function parity(world, label) {
		const admin = await world.get(ADMIN_WEEKS, USERS.admin);
		eq(admin.status, 200, `${label}: the drivers' weeks answer the Super Admin`);
		const byId = new Map(driversOf(admin).map((x) => [x.directoryId, x]));
		const answered = [];
		for (const who of ACCOUNTS) {
			const own = await world.get(OWN, USERS[who]);
			const id = directoryIdOf(who);
			if (own.status !== 200) {
				ok(!byId.has(id), `${label}: ${who}'s own route refuses him (${own.status}), and the page doesn't list him`);
				continue;
			}
			answered.push(id);
			const entry = byId.get(id);
			ok(!!entry && JSON.stringify(entry.performance) === own.text, `${label}: ${who}'s weeks on the page are byte for byte his own answer`,
				`page ${entry ? JSON.stringify(entry.performance).slice(0, 160) : "(none)"} | own ${own.text.slice(0, 160)}`);
		}
		eq([...byId.keys()].sort((a, b) => a - b), answered.sort((a, b) => a - b), `${label}: exactly the drivers whose own route answers them`);
		return { admin, byId };
	}
	const creditsOf = (x) => x.performance.weeks[0].credits.value;
	await section("33 the Super Admin's drivers' weeks", async () => {
		if (!on) throw new Error("no world");
		on.handle.clearCache();
		const before = {};
		for (const who of ["ada", "ben", "hal"]) before[who] = (await on.get(OWN, USERS[who])).text;
		const { admin, byId } = await parity(on, "Wed Nov 11");
		const body = admin.json || {};
		eq(sortedKeys(body), ["drivers", "notOnBoard"], "the answer's keys");
		eq(driversOf(admin).map((x) => Object.keys(x)), new Array(driversOf(admin).length).fill(["directoryId", "name", "unit", "performance"]), "each driver: his row's id, his name, his unit and his own answer, nothing more");
		eq(driversOf(admin).map((x) => [x.name, creditsOf(x)]), [
			["Ada Quill", 3], ["Ben Marsh", 2], ["Eli North", 2], ["Cal Reyes", 1], ["Hal Briar", 1], ["Dee Stone", 0.5], ["Jo Tester", 0.5], ["Kim Vale", 0.5],
		], "every driver with a week of his own, this week's credits highest first, then by name: a percentage driver, a test unit's and a retired truck's included");
		eq(driversOf(admin).map((x) => [x.name, x.unit]), [
			["Ada Quill", "#501"], ["Ben Marsh", "#502"], ["Eli North", "#505"], ["Cal Reyes", "#503"], ["Hal Briar", "#504 (2, from Nov 10)"],
			["Dee Stone", "#504 (1, to Nov 9)"], ["Jo Tester", ""], ["Kim Vale", ""],
		], "each unit as this week's board labels it, with a handover's dates; none for a truck the board doesn't count");
		ok(!["Fay Owens", "Gus Pike", "Ivy Lane", "Lou Grant"].some((n) => driversOf(admin).some((x) => x.name === n)), "no owner-operator, pending driver, driver with nothing this week or last, or name outside the directory");
		const report = (await on.get("/api/admin/driver-performance?period=week", USERS.admin)).json.boards[0].drivers;
		eq(body.notOnBoard, report.filter((x) => !x.listed).map((x) => ({ name: x.name, reason: x.reason })), "this week's drivers off the board, each with the reason, as the admin report has them");
		eq((body.notOnBoard || []).map((x) => [x.name, x.reason]), [
			["Eli North", "percentage-driver"], ["Fay Owens", "owner-operator"], ["Jo Tester", "no-truck-in-period"], ["Kim Vale", "no-truck-in-period"], ["Lou Grant", "not-in-directory"],
		], "...by name");
		ok(byId.has(5) && body.notOnBoard.some((x) => x.name === "Eli North"), "a percentage driver has his week, and is off the board by unit");
		// Names and figures only.
		ok(!/@|example\.test|password|made-up/i.test(admin.text), "no account's email or password");
		eq(DECOY_CELL_MARKS.filter((m) => admin.text.includes(m)), [], "no broker, rate, pay or lane cell");
		ok(!allKeys(body).some((k) => /pay|rate|email|phone|cell|broker|lane|amount|invoice|password|user_?id|unitNumber|labelRefused|geofence|^eld$|dispatch|rank|listed|status/i.test(k)), "no pay, contact, account, stored unit, pickup source or rank key");
		ok(!/\$/.test(admin.text), "no dollar figure");
		// The same snapshot, read: nothing of the page reaches a driver, and two reads agree.
		for (const who of ["ada", "ben", "hal"]) eq((await on.get(OWN, USERS[who])).text, before[who], `${who}'s own answer is the same after the Super Admin's read`);
		const twice = await Promise.all([on.get(ADMIN_WEEKS, USERS.admin), on.get(ADMIN_WEEKS, USERS.admin2)]);
		eq(twice.map((r) => r.text), [admin.text, admin.text], "two Super Admins at once read the same page");
		for (const q of ["?period=month", "?driver=Ada%20Quill", "?as_user_id=11", "?view=full"]) eq((await on.get(`${ADMIN_WEEKS}${q}`, USERS.admin)).text, admin.text, `${q} changes nothing`);
		eq(admin.headers["cache-control"], "private, no-store", "never kept by a browser or proxy");
		const routesSrc = fs.readFileSync(path.join(ROOT, "lib", "driver-performance-routes.js"), "utf8");
		const handler = routesSrc.slice(routesSrc.indexOf("app.get(PATHS.adminWeeks"));
		ok(/ownAnswer\(snap, key, row\.id, offRows\.get\(key\) \|\| \[\]\)/.test(handler) && /ownAnswer\(snap, viewer\.key, viewer\.row\.id, offRowsByKey\(snap\)\.get\(viewer\.key\) \|\| \[\]\)/.test(routesSrc),
			"one function builds the answer for his own route and for the page, from the same snapshot");
	});

	await section("33 the drivers' weeks: off days, a week at 0, an open load", async () => {
		const addOff = (world, directoryId, driver, from, to, status = "approved") => world.db.prepare(
			`INSERT INTO driver_availability (directory_id, driver_name, kind, from_date, to_date, created_by, created_at, request_status)
			 VALUES (?, ?, 'vacation', ?, ?, 'made-up', '2026-11-01T12:00:00Z', ?)`,
		).run(directoryId, driver, from, to, status);
		const off = await makeWorld({ DRIVER_AVAILABILITY_ENABLED: "true" });
		try {
			addOff(off, 2, "Ben Marsh", "2026-11-12", "2026-11-12");
			addOff(off, 3, "Cal Reyes", "2026-11-12", "2026-11-12", "requested");
			addOff(off, 1, "Ada Quill", "2026-11-02", "2026-11-03");
			addOff(off, 8, "Hal Briar", "2026-11-07", "2026-11-09");
			const { byId } = await parity(off, "approved days off");
			const weeksOf = (id) => byId.get(id).performance.weeks;
			eq([weeksOf(2)[0].credits.target, weeksOf(2)[0].targetLowered, weeksOf(1)[1].credits.target, weeksOf(8)[0].credits.target, weeksOf(8)[0].pace],
				[6, true, 4.5, 4.5, null], "Ben's Thursday off, Ada's days off last week and Hal's three days off are on the page as on their own screens");
		} finally {
			await off.close();
		}
		const later = await makeWorld({}, { nowMs: Date.parse("2026-11-25T17:00:00Z"), extraLoads: [["DP-8001", "Ben Marsh", "Assigned", ""]] });
		try {
			const { byId } = await parity(later, "Wed Nov 25");
			eq([byId.get(8).performance.weeks[0].credits.value, byId.get(8).performance.weeks[0].pace], [0, null], "Hal, on a truck with no load yet: his week at 0 and no label, as he sees it");
			eq([byId.get(2).performance.weeks[0].credits.value, byId.get(2).performance.weeks[0].pace], [0, "needs-focus"], "Ben at 0 with a load in his name: Needs Focus, as he sees it");
			ok(!byId.has(4), "Dee, whose truck and loads are older than both weeks, isn't listed, as her own route refuses her");
		} finally {
			await later.close();
		}
		// An owner-operator known only by his account: his own route refuses him, and so does the page.
		const byAccount = await makeWorld({});
		try {
			byAccount.db.prepare("UPDATE drivers_directory SET user_id = 0 WHERE id = 6").run();
			eq((await byAccount.get(OWN, USERS.fay)).status, 404, "(the scene) Fay's own route refuses her: her account is an owner-operator's");
			await parity(byAccount, "an owner-operator by account only");
			ok(!driversOf(await byAccount.get(ADMIN_WEEKS, USERS.admin)).some((x) => x.name === "Fay Owens"), "Fay isn't on the page, though her directory row names no account");
		} finally {
			await byAccount.close();
		}
		// A phone or a broker's cell in a counted load's row stays out.
		const phones = await makeWorld({}, { extraLoads: [["DP-8101", "Ada Quill", "Delivered", "2026-11-10 09:00", "555-0142"], ["DP-8102", "Ben Marsh", "Delivered", "2026-11-10 10:00", "(555) 010-0199"]] });
		try {
			const r = await phones.get(ADMIN_WEEKS, USERS.admin);
			ok(r.text.includes("DP-8101") && !/555-0142|010-0199/.test(r.text), "the loads that counted are on the page, and no phone number with them");
		} finally {
			await phones.close();
		}
	});

	await section("33 the drivers' weeks: past weeks, and their hours behind their own switch", async () => {
		const ELD = require(path.join(ROOT, "lib", "eld-activity-daily.js"));
		const plant = (db, rows) => {
			ELD.ensureEldActivitySchema(db);
			const add = db.prepare("INSERT INTO eld_activity_daily (routemate_vehicle_id, truck_id, local_day, week_start, driver_id, samples, driving_min, basis) VALUES (?, ?, ?, ?, ?, 40, ?, ?)");
			for (const r of rows) add.run(...r);
		};
		const ROWS = [
			["rm-1", 1, "2026-11-09", "2026-11-07", 1, 600, "gps-estimate"],
			["rm-1", 1, "2026-11-10", "2026-11-07", 1, 650, "gps-estimate"],
			["rm-1", 1, "2026-11-11", "2026-11-07", 1, 560, "gps-estimate"],
			["rm-1", 1, "2026-11-12", "2026-11-07", 1, 500, "gps-estimate"],
			["lx-1", 1, "2026-11-16", "2026-11-14", 1, null, "no-hours-data"],
			["rm-2", 2, "2026-11-09", "2026-11-07", 2, 1200, "gps-estimate"],
			["rm-2", 2, "2026-10-05", "2026-10-03", 2, 300, "gps-estimate"],
		];
		// The switch off: no hours on the page, and no statement reads the rollup's table, with rows in it.
		const quiet = await makeWorld({}, { nowMs: DEC_2 });
		try {
			plant(quiet.db, ROWS);
			const statements = [];
			const prepare = quiet.db.prepare.bind(quiet.db);
			quiet.db.prepare = (sql) => { statements.push(String(sql)); return prepare(sql); };
			const page = await quiet.get(ADMIN_WEEKS, USERS.admin);
			quiet.db.prepare = prepare;
			eq(page.status, 200, "(the scene) the page answers on Wed Dec 2");
			ok(statements.length > 0, "(the scene) the spy sees the page's reads", statements.length);
			eq(statements.filter((s) => /eld_activity_daily/i.test(s)), [], "with the hours switch off, serving the page reads nothing of the daily ELD activity table");
			ok(!allKeys(page.json).some((k) => /hour|minute|driving/i.test(k)) && !/"hours"|minutes/i.test(page.text), "...and no driver's past week carries hours");
			eq(driversOf(page).map((x) => [x.name, (pastOf(x.performance) || []).map((w) => [w.start, w.credits.value])]), [
				["Ada Quill", [["2026-11-21", 0], ["2026-11-14", 0], ["2026-11-07", 3]]],
				["Ben Marsh", [["2026-11-21", 0], ["2026-11-14", 0], ["2026-11-07", 2]]],
				["Cal Reyes", [["2026-11-21", 0], ["2026-11-14", 0], ["2026-11-07", 1]]],
				["Eli North", [["2026-11-21", 0], ["2026-11-14", 0], ["2026-11-07", 2]]],
				["Hal Briar", [["2026-11-21", 0], ["2026-11-14", 0], ["2026-11-07", 1]]],
			], "each driver's past weeks from the first counted week, newest first, his own figures");
			await parity(quiet, "Wed Dec 2, hours off");
		} finally {
			await quiet.close();
		}
		// The switch on: each driver's hours are his own, and the page reads them as his route does.
		const w = await makeWorld({ DRIVER_PERFORMANCE_HOURS_ENABLED: "true" }, { nowMs: DEC_2 });
		try {
			plant(w.db, ROWS);
			const { byId } = await parity(w, "Wed Dec 2, hours on");
			const hoursOf = (id) => (pastOf(byId.get(id) && byId.get(id).performance) || []).map((x) => [x.start, x.hours]);
			eq(hoursOf(1), [["2026-11-21", { state: "none" }], ["2026-11-14", { state: "none" }], ["2026-11-07", { state: "estimate", value: 38.5 }]], "Ada's hours, as her own Past Performance shows them");
			eq(hoursOf(2), [["2026-11-21", { state: "none" }], ["2026-11-14", { state: "none" }], ["2026-11-07", { state: "estimate", value: 20 }]], "Ben's are his own, none of Ada's");
			ok(!allKeys(driversOf(await w.get(ADMIN_WEEKS, USERS.admin)).map((x) => x.performance.weeks)).some((k) => /hour/i.test(k)), "this week and last carry no hours on the page either");
		} finally {
			await w.close();
		}
	});

	await section("33 the drivers' weeks: the switch, the role, the limit, a sheet that can't be read", async () => {
		const gate = await makeWorld({});
		try {
			let last = null;
			for (let i = 0; i <= require(path.join(ROOT, "lib", "driver-performance-routes.js")).RATE_LIMIT; i++) last = await gate.get(ADMIN_WEEKS, USERS.dispatcher);
			eq(last && last.status, 403, "a Dispatcher past the limit's count still gets 403, never 429: the role is checked before the limit");
			eq(gate.sheetReads, 0, "...and no refused caller reads Job Tracking");
			gate.sheetDown = true;
			const down = await gate.get(ADMIN_WEEKS, USERS.admin);
			eq([down.status, down.json && down.json.code], [503, "PERFORMANCE_UNAVAILABLE"], "Job Tracking down is 503, not an empty page");
		} finally {
			await gate.close();
		}
	});

	if (on) await on.close();
	if (boardOn) await boardOn.close();
	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) {
		console.log("FAILED:");
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
})().catch((err) => {
	console.error("FAILED:", err && err.stack ? err.stack : err);
	process.exit(1);
});
