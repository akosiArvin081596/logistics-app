#!/usr/bin/env node
/**
 * Driver Performance: lib/driver-performance.js (the rules),
 * lib/driver-performance-routes.js (three read-only routes) and the one
 * server.js declaration that mounts them, DRIVER_PERFORMANCE_ENABLED a kill
 * switch, on unless set to false. A driver sees his own week only; the board
 * stays for the Super Admin, and answers a Driver as absent unless
 * DRIVER_PERFORMANCE_BOARD_ENABLED is exactly "true". The sections on the
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
 * parseJobTrackingRead(). The session is a header the test sets.
 * "Today" is Wed 2026-11-11 (noon Eastern). Every name, unit and load is made up.
 *
 * §1  D's open answers are one-line constants in one place (Q-A1 weights,
 *     Q-A2 who's in, Q-A3 view), at the plan's defaults; the rules are pure
 * §2  periods: "week" is this week and last week (Sat-Fri, getWeekRange),
 *     "month" the calendar month; no future day counts
 * §3  load credits: a delivery 1.0, its pickup 0.5; an ELD truck's pickup
 *     needs a geofence or ELD departure, a tap counts only without a reporting
 *     ELD (14-day lookback)
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
 * §20 his target and his week: 1.5 less per approved day off, not below 4.5; the
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
 * §25 the words the server decides: whether his invoice pays days, read as the
 *     money math reads his pay type; what became of a pickup, true whichever way
 *     it was made, an older tap on a truck with no ELD included
 * §26 a credit is removed or moved only where the load's own record is certain,
 *     and otherwise reads as it always has: a status moved back, and a handover by
 *     that record; no driver is shown a credit, load number or ID the sheet never
 *     gave him. What's left as today is pinned here as today
 * §27 a load on two sheet rows counts as the weekly invoice counts it, over every
 *     row, never short of it and never over it
 * §28 what doesn't change: the count is still its rows, on made-up sheets checked
 *     against the invoice's own selector; each driver's answer is his own; the
 *     Super Admin's credits read the same; no pay path reads it
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
	// parseJobTrackingRead() is named only where it exists, so the old code still runs here and fails by case.
	const readRoot = /^function parseJobTrackingRead\(/m.test(SRC) ? ["parseJobTrackingRead"] : [];
	LIFT = closure(SRC, {
		roots: ["driverPerformance", "parseSheet", "deduplicateLoads", "selectInvoiceWeekLoads", "liveJobTrackingView", ...readRoot],
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
	for (const t of ["drivers_directory", "trucks", "truck_assignments", "load_status_history", "load_eld_miles", "eld_miles_daily", "deleted_loads", "driver_availability"]) db.exec(tableDdl(t));
	db.exec("ALTER TABLE drivers_directory ADD COLUMN status TEXT DEFAULT 'active'");
	db.exec("ALTER TABLE drivers_directory ADD COLUMN pay_type TEXT DEFAULT 'fixed'");
	db.exec("ALTER TABLE trucks ADD COLUMN retired_at TEXT DEFAULT ''");
	db.exec("ALTER TABLE load_status_history ADD COLUMN actor_role TEXT DEFAULT ''");
	db.exec("ALTER TABLE load_status_history ADD COLUMN fix_ms INTEGER");
	db.exec("ALTER TABLE load_status_history ADD COLUMN pickup_zone TEXT DEFAULT ''");
	db.exec("ALTER TABLE load_status_history ADD COLUMN local_tz TEXT DEFAULT ''");
	db.exec("ALTER TABLE load_status_history ADD COLUMN other_load_hauling INTEGER");
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
				const read = { values: sheetValues(world.extraLoads) };
				if (world.fns.parseJobTrackingRead) world.jt = world.fns.parseJobTrackingRead(read);
				else {
					world.jt = world.fns.parseSheet(read);
					world.jt.data = world.fns.deduplicateLoads(world.jt.data, world.jt.headers);
				}
			}
			return world.jt;
		},
	};
	world.extraLoads = extraLoads;
	const body = ['"use strict";', lift.text,
		"return { driverPerformance, parseSheet, deduplicateLoads, selectInvoiceWeekLoads, loadKeySet, getDeletedLoadIds, getWeekRange, directoryPayStruct, liveJobTrackingView,",
		"\tparseJobTrackingRead: typeof parseJobTrackingRead === \"function\" ? parseJobTrackingRead : null };"].join("\n");
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
		eq(p.CREDIT_WEIGHTS, { delivery: 1, pickup: 0.5 }, "Q-A1: a delivery earns 1.0, its pickup 0.5");
		eq(p.WHO_IS_IN, "company-day-rate", "Q-A2: company drivers on a day rate");
		eq(p.BOARD_VIEW, "full", "Q-A3: the full list by unit");
		ok(one(/^const CREDIT_WEIGHTS = Object\.freeze\(\{ delivery: 1\.0, pickup: 0\.5 \}\);$/gm) === 1, "Q-A1 is one line, declared once");
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
		eq(p.loadCredits(5, 5), 7.5, "5 delivered and 5 picked up is the 7.5 target");
		eq(p.loadCredits(3, 1), 3.5, "3 deliveries and 1 pickup earn 3.5");
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
			for (const route of ["/api/driver/me/performance", "/api/driver/performance/leaderboard?period=week", "/api/admin/driver-performance"]) {
				for (const who of [null, USERS.ada, USERS.admin, USERS.dispatcher]) {
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
		eq(sortedKeys(a), ["creditWeights", "invoicePaysDays", "view", "weeks"], "the answer's keys");
		eq(a.view, "no-hours-data", "every truck gets the \"no hours data\" view");
		eq(a.creditWeights, { delivery: 1, pickup: 0.5 }, "the weights the credits use");
		const WEEK_KEYS = ["credits", "end", "id", "left", "loads", "newWeekNote", "pace", "percent", "start", "targetLowered"];
		eq(a.weeks.map((w) => sortedKeys(w)), [WEEK_KEYS, WEEK_KEYS], "each week's keys");
		eq(a.weeks.map((w) => sortedKeys(w.credits)), [["deliveries", "pickups", "target", "value"], ["deliveries", "pickups", "target", "value"]], "each week's credit keys");
		const banned = /hour|rei|gap|reach|expected|rank|unit|streak|tier|bonus|earn/i;
		for (const [who, body] of Object.entries(weeks)) {
			ok(!allKeys(body).some((k) => banned.test(k)), `${who}: no hours, REI, gap, "out of reach", rank, unit, streak or earnings key`);
			ok(!/out of reach/i.test(JSON.stringify(body)), `${who}: no "out of reach" text`);
		}
		eq(a.weeks.map((w) => [w.id, w.credits.deliveries, w.credits.pickups, w.credits.value, w.credits.target]),
			[["this-week", 3, 3, 4.5, 7.5], ["last-week", 2, 1, 2.5, 7.5]],
			"Ada (ELD truck): geofence and ELD departures count, her early tap and her ELD truck's tap don't; Friday 11:30 PM ET is last week");
		eq(weeks.ben.weeks[0].credits, { value: 3, target: 7.5, deliveries: 2, pickups: 2 }, "Ben (no ELD): his tap and dispatch's tap count");
		eq(weeks.cal.weeks[0].credits, { value: 1.5, target: 7.5, deliveries: 1, pickups: 1 }, "Cal (ELD silent 20 days): his tap counts");
		eq(weeks.dee.weeks.map((w) => w.credits.deliveries), [1, 1], "Dee's deliveries, this week and last");
		eq(weeks.hal.weeks.map((w) => w.credits.deliveries), [2, 0], "Hal's own week shows even with no truck last week");

		// Wednesday: 3 days left, so 3 by this morning is on pace, and 1.5 more is ahead.
		const shown = (who) => {
			const w = weeks[who].weeks[0];
			return [w.credits.value, w.left, w.percent, w.pace, w.newWeekNote];
		};
		eq(shown("ada"), [4.5, 3, 60, "ahead", false], "Ada: 4.5 of 7.5, 3 left, 60%, Ahead of Pace");
		eq(shown("ben"), [3, 4.5, 40, "on-track", false], "Ben: 3 of 7.5, 4.5 left, 40%, On Track");
		eq(shown("cal"), [1.5, 6, 20, "needs-focus", true], "Cal: 1.5 of 7.5, 6 left (more than 3 days hold), 20%, Needs Focus");
		eq(shown("dee"), [1, 6.5, 13, "needs-focus", true], "Dee: 13.33% rounds down to 13");
		for (const [who, body] of Object.entries(weeks)) {
			const last = body.weeks[1];
			eq([last.left, last.pace, last.newWeekNote], [null, null, false], `${who}: last week is its final figure, with nothing left and no label`);
		}

		// What counted, in the order it counted: he can add it up himself.
		eq(a.weeks[0].loads, [
			{ loadId: "DP-1010", pickup: { day: "Sat", credits: 0.5 }, delivery: null },
			{ loadId: "DP-1001", pickup: { day: "Sun", credits: 0.5 }, delivery: { day: "Mon", credits: 1 } },
			{ loadId: "DP-1002", pickup: { day: "Mon", credits: 0.5 }, delivery: { day: "Tue", credits: 1 } },
			{ loadId: "DP-1004", pickup: { note: "not-counted" }, delivery: { day: "Mon", credits: 1 } },
		], "Ada's this week: each row shows both credits, or what became of the pickup");
		eq(a.weeks[1].loads, [
			{ loadId: "DP-1008", pickup: { note: "not-counted" }, delivery: { day: "Thu", credits: 1 } },
			{ loadId: "DP-1009", pickup: { note: "not-counted" }, delivery: { day: "Fri", credits: 1 } },
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
			eq(rowOf(ben.weeks[0], "DP-8010"), { loadId: "DP-8010", pickup: { note: "last-week" }, delivery: { day: "Tue", credits: 1 } }, "its pickup counted last week");
			eq(rowOf(ben.weeks[0], "DP-8011"), { loadId: "DP-8011", pickup: { note: "another-week" }, delivery: { day: "Tue", credits: 1 } }, "its pickup counted before last week");
			eq(rowOf(ben.weeks[1], "DP-8010"), { loadId: "DP-8010", pickup: { day: "Thu", credits: 0.5 }, delivery: null }, "and last week shows that pickup as its own row");
			eq(rowOf(ben.weeks[1], "DP-8012"), { loadId: "DP-8012", pickup: { note: "another-week" }, delivery: { day: "Tue", credits: 1 } }, "last week's own delivery says the same of an older pickup");
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

		// The count stays A1's: the weekly invoice's own, over the raw sheet.
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
		const routesSrc = fs.readFileSync(path.join(ROOT, "lib", "driver-performance-routes.js"), "utf8");
		ok(!/\b(INSERT|UPDATE|DELETE|REPLACE)\s/.test(routesSrc.replace(/\/\/.*$/gm, "")) && !/\.run\(|\.exec\(/.test(routesSrc), "the routes module writes nothing to the database");
		ok(!/app\.(post|put|patch|delete)\(/.test(routesSrc), "and registers no write route");
		const rules = require(path.join(ROOT, "lib", "replica-rules.js"));
		ok(!(rules.ENABLE_ALLOWED || []).includes("DRIVER_PERFORMANCE_ENABLED"), "replica:start --enable doesn't take it: it is already on");
		ok(/kill switch/.test(String((rules.ENABLE_REFUSED || {}).DRIVER_PERFORMANCE_ENABLED)), "the replica refuses it as a kill switch");
		ok((rules.ENABLE_ALLOWED || []).includes("DRIVER_PERFORMANCE_BOARD_ENABLED"), "replica:start --enable takes the board flag: read only, on the task's own copy");
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
		eq(p.LOADS_PACE, { creditsPerDay: 1.5, aheadBy: 1.5, targetFloor: 4.5, hideLabelAtDaysOff: 3 }, "the reading, in one constant");
		// Today through Friday, at 1.5 a day: what he'd have by this morning to finish on 7.5.
		const WEEK = { start: "2026-11-07", end: "2026-11-13" };
		const paceOn = (today, credits, offDays = [], openLoad = true) => p.personalWeek({ id: "this-week", ...WEEK, today, deliveries: credits, pickups: 0, loads: [], offDays, openLoad }).pace;
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
		eq(p.pace({ credits: 3, hours: null, completedWorkedDays: 2, todayHours: 0, calendarDaysLeft: 3, approvedDaysOff: 0 }), null, "the combined score's pace still waits on hours, left as it was");
	});

	await section("20 his target and his week", () => {
		const p = need();
		eq([0, 1, 2, 3, 4, 7].map((off) => p.personalTarget(off)), [7.5, 6, 4.5, 4.5, 4.5, 4.5], "7.5, less 1.5 per approved day off, not below 4.5");
		const WEEK = { id: "this-week", start: "2026-11-07", end: "2026-11-13" };
		const week = (over) => p.personalWeek({ ...WEEK, today: "2026-11-11", deliveries: 0, pickups: 0, loads: [], offDays: [], openLoad: true, ...over });
		eq(p.offDaysInWeek([{ from_date: "2026-11-05", to_date: "2026-11-08" }, { from_date: "2026-11-08", to_date: "2026-11-08" }, { from_date: "2026-11-13", to_date: "2026-11-20" }], "2026-11-07", "2026-11-13"),
			["2026-11-07", "2026-11-08", "2026-11-13"], "the week's own days off, each counted once, whatever the rows' overlaps");
		eq(p.offDaysInWeek([{ from_date: "2026-11-14", to_date: "2026-11-20" }], "2026-11-07", "2026-11-13"), [], "days outside the week don't count");
		eq(p.offDaysInWeek(null, "2026-11-07", "2026-11-13"), [], "none at all");

		// The bar's percent and what's left.
		eq([3, 7, 9, 12].map((n) => week({ deliveries: n }).percent), [40, 93, 100, 100], "percent rounded down, capped at 100");
		eq(week({ deliveries: 4, pickups: 7 }).percent, 100, "4 + 3.5 is the whole target");
		eq(week({ deliveries: 1 }).percent, 13, "13.33 rounds down");
		eq(week({ deliveries: 2, pickups: 3 }).percent, 46, "46.67 rounds down too, never up");
		eq([3, 7, 7.5, 9].map((n) => week({ deliveries: n }).left), [4.5, 0.5, 0, 0], "what's left never goes below 0");
		eq(week({ deliveries: 2, pickups: 3 }).credits, { value: 3.5, target: 7.5, deliveries: 2, pickups: 3 }, "A1's own count: a delivery 1, a pickup 0.5");

		// Approved days off: a lower target, and pacing over the days he can work.
		const oneOff = week({ offDays: ["2026-11-12"], deliveries: 3 });
		eq([oneOff.credits.target, oneOff.left, oneOff.percent, oneOff.pace], [6, 3, 50, "on-track"], "Thu off, today Wed: 6, and 2 working days left, so 3 is on pace");
		eq(week({ offDays: ["2026-11-07"], deliveries: 2 }).pace, "on-track", "Sat off, today Wed: 3 working days left of 6, so 1.5 by now, and 2 is on pace");
		eq(week({ offDays: ["2026-11-07"], deliveries: 1 }).pace, "needs-focus", "and 1 is below it");
		eq(week({ offDays: ["2026-11-07", "2026-11-08"], deliveries: 0 }).pace, "on-track", "two days off: 4.5, and 3 days hold it from nothing");
		eq(week({ offDays: ["2026-11-07"], deliveries: 6 }).pace, "ahead", "the lower target met is Ahead of Pace");
		const threeOff = week({ offDays: ["2026-11-07", "2026-11-08", "2026-11-09"], deliveries: 1 });
		eq([threeOff.credits.target, threeOff.pace], [4.5, null], "three or more days off: not below 4.5, and no label");

		// No label on a week he can't act on.
		eq(week({ openLoad: false }).pace, null, "0 credits and no open load: no label, since loads depend on dispatch");
		eq(week({ openLoad: true }).pace, "needs-focus", "0 credits on Wednesday with a load in his name reads Needs Focus");
		eq(week({ openLoad: false, pickups: 1 }).pace, "needs-focus", "any credit, and the label shows");
		const offThrough = week({ today: "2026-11-12", offDays: ["2026-11-12", "2026-11-13"], deliveries: 3 });
		eq([offThrough.credits.target, offThrough.pace], [4.5, null], "off through Friday, below his target: no day left to ask for, so no label");
		eq(week({ today: "2026-11-12", offDays: ["2026-11-12", "2026-11-13"], deliveries: 5 }).pace, "ahead", "off through Friday with the target met keeps the good news");

		// "A new week starts Saturday", once more is left than the days hold.
		eq(week({ deliveries: 3 }).newWeekNote, false, "4.5 left on Wednesday fits 3 days at 1.5");
		eq(week({ deliveries: 2.5 }).newWeekNote, true, "5 left doesn't");
		eq(week({ today: "2026-11-13", deliveries: 6 }).newWeekNote, false, "1.5 left on Friday fits");
		eq(week({ today: "2026-11-13", deliveries: 5.5 }).newWeekNote, true, "2 left on Friday doesn't");
		eq(week({ deliveries: 9 }).newWeekNote, false, "nothing left, no note");

		// Last week is its final figure.
		const closed = week({ id: "last-week", start: "2026-10-31", end: "2026-11-06", deliveries: 4 });
		eq([closed.credits.value, closed.percent, closed.left, closed.pace, closed.newWeekNote], [4, 53, null, null, false], "a closed week: the figure and percent, nothing left, no label");

		// One counted load.
		eq(p.countedLoad({ loadId: " DP-1 ", pickupDay: "2026-11-09", deliveryDay: "2026-11-10" }), { loadId: "DP-1", pickup: { day: "Mon", credits: 0.5 }, delivery: { day: "Tue", credits: 1 } }, "both credits, each with its day");
		eq(p.countedLoad({ loadId: "DP-2", pickupDay: "2026-11-07", deliveryDay: "" }), { loadId: "DP-2", pickup: { day: "Sat", credits: 0.5 }, delivery: null }, "a pickup alone");
		eq(p.countedLoad({ loadId: "DP-3", pickupDay: "", deliveryDay: "2026-11-13", pickupNote: "last-week" }), { loadId: "DP-3", pickup: { note: "last-week" }, delivery: { day: "Fri", credits: 1 } }, "a delivery whose pickup counted last week");
		eq(p.countedLoad({ loadId: null, pickupDay: "", deliveryDay: "2026-11-08" }), { loadId: "", pickup: { note: "not-counted" }, delivery: { day: "Sun", credits: 1 } }, "no Load ID in the cell, and no pickup that counted");

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
		ok(!/\.ranked\b|\.report\b|rank\b/.test(fs.readFileSync(path.join(ROOT, "lib", "driver-performance.js"), "utf8").match(/function personalWeek[\s\S]*?\n}\n/)?.[0] || "rank"), "nor does the week it answers with");
	});

	await section("22 who gets his own week", async () => {
		if (!on) throw new Error("no world");
		// A percentage driver gets the personal view: it counts loads and touches no pay.
		const eli = await on.get("/api/driver/me/performance", USERS.eli);
		eq(eli.status, 200, "a percentage driver on a truck: his own week");
		eq(eli.json.weeks[0].credits, { value: 4, target: 7.5, deliveries: 4, pickups: 0 }, "and his count");
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
			eq([ben[0].credits.target, ben[0].left, ben[0].percent, ben[0].pace], [6, 3, 50, "on-track"], "Ben's approved Thursday off: 3 of 6, and 2 working days left, so On Track");
			eq(ben[1].credits.target, 7.5, "last week's target is its own");
			eq([ben[0].targetLowered, ben[1].targetLowered], [true, false], "the server flags his lowered target, this week only");
			eq((await week(w, "cal"))[0].credits.target, 7.5, "a request still waiting changes nothing");
			eq((await week(w, "cal"))[0].targetLowered, false, "and flags nothing");
			const ada = await week(w, "ada");
			eq([ada[0].credits.target, ada[1].credits.target], [7.5, 4.5], "days off last week lower last week only");
			eq([ada[0].targetLowered, ada[1].targetLowered], [false, false], "and a closed week flags nothing");
			const hal = await week(w, "hal");
			eq([hal[0].credits.target, hal[0].pace, hal[0].targetLowered], [4.5, null, true], "three days off: 4.5, no label, and flagged");
			eq((await week(offFlag, "ben"))[0].credits.target, 7.5, "with availability off, its rows stay inert");
			eq((await week(offFlag, "ben"))[0].targetLowered, false, "and flag nothing");
		} finally {
			await w.close();
			await offFlag.close();
		}
	});

	await section("25 the words the server decides", async () => {
		// Whether his invoice pays days: the money math's own reading of his pay type.
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
			eq(eli.invoicePaysDays, false, "a percentage driver's invoice doesn't pay days");
			eq([ada.invoicePaysDays, ben.invoicePaysDays], [true, true], "a day-rate driver's does");
			for (const [stored, want, says] of [
				["percentage", false, "percentage"], ["Percentage", false, "in another case"], ["fixed", true, "fixed"], ["", true, "blank is the day rate"],
				[" percentage", true, "a stray space: the money math reads it as fixed, and he is paid days"],
			]) {
				w.db.prepare("UPDATE drivers_directory SET pay_type = ? WHERE id = 5").run(stored);
				eq((await answerOf("eli")).invoicePaysDays, want, `pay type ${JSON.stringify(stored)}: ${says}`);
			}
			eq(w.fns.directoryPayStruct({ pay_type: " percentage" }).payType, "fixed", "which is the money math's own reading");
			const routesSrc = fs.readFileSync(path.join(ROOT, "lib", "driver-performance-routes.js"), "utf8");
			ok(/invoicePaysDays: d\.directoryPayStruct\(viewer\.row\)\.payType !== "percentage"/.test(routesSrc), "the route asks the money math's own function, and keeps no copy of the rule");

			// What became of a pickup: true whichever way it was made.
			const rowOf = (body, i, id) => body.weeks[i].loads.find((l) => l.loadId === id);
			eq(rowOf(ben, 0, "DP-8013"), { loadId: "DP-8013", pickup: { note: "not-counted" }, delivery: { day: "Tue", credits: 1 } }, "an older tap on a truck with no ELD: not counted this week");
			eq(rowOf(ada, 0, "DP-8014"), { loadId: "DP-8014", pickup: { note: "not-counted" }, delivery: { day: "Tue", credits: 1 } }, "an older tap on a truck with an ELD: the same");
			eq(rowOf(ben, 1, "DP-8015"), { loadId: "DP-8015", pickup: { note: "not-counted" }, delivery: { day: "Tue", credits: 1 } }, "and on last week's list");
			eq(rowOf(ben, 0, "DP-8016"), { loadId: "DP-8016", pickup: { note: "not-counted" }, delivery: { day: "Tue", credits: 1 } }, "a dispatcher's older tap: the same");
			const all = JSON.stringify([eli, ada, ben]);
			ok(!/not-recorded/.test(all), "no answer says a pickup wasn't recorded: the server can't know that of an older tap");
			eq(ben.weeks[0].credits.pickups, ben.weeks[0].loads.filter((l) => l.pickup.credits).length, "and the older taps add no credit: the count stays A1's");
		} finally {
			await w.close();
		}
	});

	// ── a small world for one case: two made-up drivers, each with his own truck and no ELD days,
	// and nothing on record for them but what the case writes ────────────────
	const OWN_WEEK = "/api/driver/me/performance";
	const SUN = "2026-11-08"; const MON = "2026-11-09"; const TUE = "2026-11-10";
	const LAST_THU = "2026-11-05"; const LAST_FRI = "2026-11-06";
	const PICKED = (day) => ({ day, credits: 0.5 });
	const DONE = (day) => ({ day, credits: 1 });
	const NOT_COUNTED = { note: "not-counted" };
	const NIA = "Nia Frost"; const OMAR = "Omar Hale";
	async function proofWorld(setup, { nowMs } = {}) {
		const w = await makeWorld({}, { nowMs, extraLoads: [] });
		const dir = w.db.prepare("INSERT INTO drivers_directory (id, driver_name, status, pay_type, user_id) VALUES (?, ?, 'active', 'fixed', ?)");
		dir.run(21, NIA, 61);
		dir.run(22, OMAR, 62);
		const tr = w.db.prepare("INSERT INTO trucks (id, unit_number, retired_at) VALUES (?, ?, '')");
		tr.run(21, "LogisX-#521");
		tr.run(22, "LogisX-#522");
		const ta = w.db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, '2026-10-01T12:00:00.000Z', ?)");
		w.assign = (truck, driver, end = "") => ta.run(truck, driver, end);
		w.assign(21, NIA);
		w.assign(22, OMAR);
		const hist = w.db.prepare(`INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, actor_role, other_load_hauling, changed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
		w.hist = (load, source, status, at, actor, { old = "", role = "", hauling = null } = {}) => {
			hist.run(String(load).toLowerCase().replace(/^#/, ""), old, status, source, actor, role, hauling, at);
		};
		w.row = (id, driver, status, done = "", phone = "") => w.extraLoads.push([id, driver, status, done, phone]);
		// A load's arrival and departure by the truck's geofence, its arrival at the receiver and the tap.
		w.picked = (id, driver, day, actor = driver) => {
			w.hist(id, "geofence", "At Shipper", `${day} 13:00:00`, actor);
			w.hist(id, "geofence", "In Transit", `${day} 14:00:00`, actor);
		};
		w.clean = (id, driver, day, actor = driver) => {
			w.picked(id, driver, day, actor);
			w.hist(id, "geofence", "At Receiver", `${day} 19:00:00`, actor);
			w.hist(id, "manual", "Delivered", `${day} 20:00:00`, actor);
			w.row(id, driver, "Delivered", `${day} 15:00`);
		};
		w.depart = (load, ms, truck = 0) => w.db.prepare("INSERT INTO load_eld_miles (load_id, truck_id, pickup_depart_ms) VALUES (?, ?, ?)").run(String(load).toLowerCase().replace(/^#/, ""), truck, ms);
		w.weeks = async (who) => {
			const r = await w.get(OWN_WEEK, USERS[who]);
			return r.status === 200 ? r.json.weeks : [{ credits: { value: 0, deliveries: 0, pickups: 0 }, loads: [] }, { credits: { value: 0, deliveries: 0, pickups: 0 }, loads: [] }];
		};
		// What the weekly invoice bills him, by its own selector over every row of the sheet.
		w.invoiceBills = (name, start, end) => {
			const raw = w.fns.parseSheet({ values: sheetValues(w.extraLoads) });
			return w.fns.selectInvoiceWeekLoads(raw.data, raw.headers, name, start, end, w.fns.loadKeySet(w.fns.getDeletedLoadIds())).loads.length;
		};
		setup(w);
		return w;
	}
	const inWorld = async (setup, check, opts) => {
		const w = await proofWorld(setup, opts);
		try { await check(w); } finally { await w.close(); }
	};
	const proofModule = () => require(path.join(ROOT, "lib", "driver-pickup-proof.js"));

	await section("26 a credit moves or goes only where the load's own record is certain", async () => {
		// The control: a clean load earns what it always did.
		await inWorld((w) => w.clean("PF-1", NIA, MON), async (w) => {
			const nia = await w.weeks("nia");
			eq(nia[0].credits, { value: 1.5, target: 7.5, deliveries: 1, pickups: 1 }, "a clean load: 1 for the delivery, 0.5 for its pickup");
			eq(nia[0].loads, [{ loadId: "PF-1", pickup: PICKED("Mon"), delivery: DONE("Mon") }], "and its row shows both");
		});

		// Left as it is today, until a ruling with data: no plain pass-by test, no errand test, no other-load
		// test and no ELD-record-date test. Each shape reads as the live count reads it.
		await inWorld((w) => {
			w.picked("PF-2", NIA, MON);
			w.row("PF-2", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-2", pickup: PICKED("Mon"), delivery: null }], "as today: a plain pass-by reads like a pickup, and earns 0.5");
		});
		await inWorld((w) => {
			w.hist("PF-3", "geofence", "In Transit", `${MON} 10:00:00`, NIA);
			w.row("PF-3", NIA, "In Transit");
			w.picked("PF-4", NIA, MON);
			w.row("PF-4", NIA, "Delivered", `${TUE} 15:00`);
		}, async (w) => {
			const nia = (await w.weeks("nia"))[0];
			eq(nia.credits.pickups, 2, "as today: a load picked up while another reads under way earns: no errand test");
			eq(nia.loads.find((l) => l.loadId === "PF-4"), { loadId: "PF-4", pickup: PICKED("Mon"), delivery: DONE("Tue") }, "and its row isn't newly \"not counted\"");
		});
		await inWorld((w) => {
			w.hist("PF-5", "geofence", "At Shipper", `${MON} 13:00:00`, NIA, { hauling: 1 });
			w.hist("PF-5", "geofence", "In Transit", `${MON} 14:00:00`, NIA);
			w.row("PF-5", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "as today: the recorder's own mark that another load was under way changes nothing");
		});
		await inWorld((w) => {
			w.hist("PF-6", "dispatch", "Dispatched", `${MON} 09:00:00`, "disp");
			w.depart("PF-6", Date.parse(`${SUN}T14:00:00Z`), 21);
			w.hist("PF-6", "geofence", "At Shipper", `${MON} 13:00:00`, NIA);
			w.hist("PF-6", "manual", "In Transit", `${MON} 14:00:00`, NIA);
			w.row("PF-6", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-6", pickup: PICKED("Sun"), delivery: null }], "as today: an ELD record dated before the dispatch row stands, on its own day: no ELD-record-date test");
		});
		await inWorld((w) => {
			w.depart("PF-6b", Date.parse(`${MON}T14:00:00Z`), 21);
			w.row("PF-6b", NIA, "Assigned");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "as today: an ELD record on a load with no departure status on record stands, whatever the sheet still reads");
		});

		// Also left as today: no twin test. A stale ELD time on one load would otherwise cancel another's true one.
		await inWorld((w) => {
			w.clean("PF-7", NIA, MON);
			w.clean("PF-8", NIA, MON);
		}, async (w) => {
			const nia = (await w.weeks("nia"))[0];
			eq(nia.credits, { value: 3, target: 7.5, deliveries: 2, pickups: 2 }, "as today: two loads at one shipper in one visit each earn: no twin test");
			eq(nia.loads, [{ loadId: "PF-7", pickup: PICKED("Mon"), delivery: DONE("Mon") }, { loadId: "PF-8", pickup: PICKED("Mon"), delivery: DONE("Mon") }], "and neither row is newly \"not counted\"");
		});
		await inWorld((w) => {
			const oneDeparture = Date.parse(`${MON}T14:00:00Z`);
			w.depart("PF-9", oneDeparture, 21);
			w.depart("PF-10", oneDeparture, 21);
			w.row("PF-9", NIA, "Delivered", `${TUE} 15:00`);
			w.row("PF-10", NIA, "Delivered", `${TUE} 16:00`);
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits, { value: 3, target: 7.5, deliveries: 2, pickups: 2 }, "as today: one truck's one recorded departure on two of her loads: each earns");
		});

		// A status later moved back: gone only with the status still back, on the sheet too, and not by his own tap alone.
		const staffBack = { role: "Dispatcher" };
		await inWorld((w) => {
			w.picked("PF-15", NIA, MON);
			w.hist("PF-15", "override", "Dispatched", `${MON} 15:00:00`, "disp", staffBack);
			w.row("PF-15", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "staff moved it back to Dispatched and it's still there: the departure no longer stands");
		});
		await inWorld((w) => {
			w.picked("PF-16", NIA, MON);
			w.hist("PF-16", "override", "At Shipper", `${MON} 15:00:00`, "disp", staffBack);
			w.row("PF-16", NIA, "At Shipper");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "moved back only as far as At Shipper: it hasn't left either");
		});
		await inWorld((w) => {
			w.picked("PF-5b", NIA, MON);
			w.row("PF-5b", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "a departure on record and the sheet back at Dispatched, with no row: a move back outside the status routes");
		});
		for (const [how, sheetRows] of [
			["the sheet says it left again", [["PF-15b", NIA, "In Transit"]]],
			["the sheet says delivered", [["PF-15b", NIA, "Delivered", `${TUE} 15:00`]]],
			["a copy on the sheet has left", [["PF-15b", NIA, "In Transit"], ["PF-15b", NIA, "Dispatched"]]],
		]) {
			await inWorld((w) => {
				w.picked("PF-15b", NIA, MON);
				w.hist("PF-15b", "override", "Dispatched", `${MON} 15:00:00`, "disp", staffBack);
				for (const r of sheetRows) w.row(...r);
			}, async (w) => {
				eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Mon")], `moved back, but ${how}: not certain, so it stands as today`);
			});
		}
		await inWorld((w) => {
			w.picked("PF-81", NIA, MON);
			w.hist("PF-81", "geofence", "At Receiver", `${MON} 19:00:00`, NIA);
			w.hist("PF-81", "manual", "Dispatched", `${MON} 19:30:00`, NIA, { role: "Driver" });
			w.hist("PF-81", "manual", "Delivered", `${MON} 19:35:00`, NIA, { role: "Driver" });
			w.row("PF-81", NIA, "Delivered", `${MON} 15:00`);
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-81", pickup: PICKED("Mon"), delivery: DONE("Mon") }], "his own stray tap back, the whole trip on record: the pickup stands");
		});
		for (const [how, role] of [["by a Driver session", "Driver"], ["with no role on record", ""]]) {
			await inWorld((w) => {
				w.picked("PF-82", NIA, MON);
				w.hist("PF-82", "manual", "Dispatched", `${MON} 15:00:00`, NIA, { role });
				w.row("PF-82", NIA, "Dispatched");
			}, async (w) => {
				eq((await w.weeks("nia"))[0].credits.pickups, 1, `his own tap back ${how}, still there on the sheet: not certain, so it stands as today`);
			});
		}
		await inWorld((w) => {
			w.picked("PF-83", NIA, MON);
			w.hist("PF-83", "manual", "At Shipper", `${MON} 15:00:00`, NIA, { role: "Driver" });
			w.hist("PF-83", "override", "Dispatched", `${MON} 16:00:00`, "disp", staffBack);
			w.row("PF-83", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 0, "his tap back and then staff's: staff's word is certain");
		});
		await inWorld((w) => {
			w.picked("PF-84", NIA, MON);
			w.hist("PF-84", "manual", "At Shipper", `${MON} 15:00:00`, NIA, { role: "Driver" });
			w.hist("PF-84", "geofence", "In Transit", `${TUE} 14:00:00`, NIA);
			w.row("PF-84", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Tue")], "his own tap back with a new departure after it: the credit moves to that departure");
		});
		await inWorld((w) => {
			w.picked("PF-88", NIA, MON);
			w.hist("PF-88", "manual", "Dispatched", `${MON} 15:00:00`, NIA, { role: "Driver" });
			w.hist("PF-88", "geofence", "At Shipper", `${TUE} 13:00:00`, NIA);
			w.row("PF-88", NIA, "At Shipper");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "his tap back, then the truck reaching the shipper again: still no one's word but his, so it stands as today");
		});
		await inWorld((w) => {
			w.picked("PF-89", NIA, MON);
			w.hist("PF-89", "override", "Dispatched", `${MON} 15:00:00`, "disp", staffBack);
			w.hist("PF-89", "accept", "Assigned", `${MON} 16:00:00`, NIA, { old: "Dispatched", role: "Driver" });
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
			w.hist("PF-91", "manual", "In Transit", `${MON} 14:00:00`, NIA);
			w.hist("PF-91", "override", "Dispatched", `${MON} 15:00:00`, "disp", staffBack);
			w.depart("PF-91", Date.parse(`${SUN}T14:00:00Z`), 21);
			w.hist("PF-91", "manual", "In Transit", `${TUE} 14:00:00`, NIA);
			w.row("PF-91", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Tue")], "an ELD record from before the move back doesn't outrank the new departure");
		});
		await inWorld((w) => {
			w.picked("PF-85", NIA, MON);
			w.hist("PF-85", "override", "Dispatched", `${MON} 15:00:00`, "disp", staffBack);
			w.hist("PF-85", "geofence", "At Shipper", `${TUE} 13:00:00`, NIA);
			w.hist("PF-85", "manual", "In Transit", `${TUE} 14:00:00`, NIA);
			w.row("PF-85", NIA, "In Transit");
			w.db.prepare("INSERT INTO eld_miles_daily (routemate_vehicle_id, local_day, truck_id, miles, samples) VALUES ('rm-21', ?, 21, 100, 40)").run(MON);
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Mon")], "moved back, and the new departure is only his tap on a truck with an ELD: no proof of the new day, so it stands as today");
		});
		await inWorld((w) => {
			w.hist("PF-86", "manual", "In Transit", `${MON} 14:00:00`, NIA);
			w.hist("PF-86", "override", "Dispatched", `${MON} 15:00:00`, "disp", staffBack);
			w.hist("PF-86", "manual", "In Transit", `${TUE} 14:00:00`, NIA);
			w.row("PF-86", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Tue")], "on a truck with no ELD his tap is the proof, so the credit moves to the new one");
		});
		await inWorld((w) => {
			w.picked("PF-87", NIA, MON);
			w.hist("PF-87", "override", "Dispatched", `${MON} 15:00:00`, "disp", staffBack);
			w.depart("PF-87", Date.parse(`${TUE}T14:00:00Z`), 21);
			w.row("PF-87", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.pickup), [PICKED("Tue")], "moved back, then the truck's own record of leaving after that: the credit moves to it");
		});
		await inWorld((w) => {
			w.picked("PF-17", NIA, MON);
			w.hist("PF-17", "override", "At Shipper", `${MON} 15:00:00`, "disp", { role: "Dispatcher" });
			w.hist("PF-17", "geofence", "In Transit", `${TUE} 14:00:00`, NIA, { old: "At Shipper" });
			w.row("PF-17", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-17", pickup: PICKED("Tue"), delivery: null }], "and the real departure after that counts, on its own day");
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
			w.hist("PF-19", "override", "Dispatched", `${LAST_FRI} 15:00:00`, "disp", { role: "Dispatcher" });
			w.clean("PF-19", NIA, MON);
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
			w.hist("PF-21", "override", "Dispatched", `${MON} 20:00:00`, "disp", { role: "Dispatcher" });
			w.row("PF-21", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "as today: a status row dated after an ELD record takes nothing from it, with no departure status gone back");
		});
		await inWorld((w) => {
			w.hist("PF-22", "dispatch", "Dispatched", `${MON} 09:00:00`, "disp");
			w.depart("PF-22", Date.parse(`${MON}T14:00:00Z`), 21);
			w.row("PF-22", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-22", pickup: PICKED("Mon"), delivery: null }], "an ELD departure after its dispatch does");
		});
		await inWorld((w) => {
			w.hist("PF-41", "dispatch", "Dispatched", `${MON} 09:00:00`, "disp");
			w.depart("PF-41", Date.parse(`${MON}T14:00:00Z`), 21);
			w.hist("PF-41", "manual", "At Shipper", `${MON} 18:00:00`, NIA);
			w.hist("PF-41", "manual", "In Transit", `${MON} 18:05:00`, NIA);
			w.row("PF-41", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-41", pickup: PICKED("Mon"), delivery: null }], "and so does one with his taps coming late behind it: nothing went back, so it stands, on the truck's own time");
			eq((await w.get("/api/admin/driver-performance?period=week", USERS.admin2)).json.boards[0].drivers.find((x) => x.name === NIA).pickups.eld, 1, "as the ELD's, not the tap's");
		});
		await inWorld((w) => {
			w.depart("PF-16c", Date.parse(`${MON}T14:00:00Z`), 21);
			w.hist("PF-16c", "manual", "At Shipper", `${MON} 18:00:00`, NIA);
			w.hist("PF-16c", "manual", "In Transit", `${MON} 18:05:00`, NIA);
			w.row("PF-16c", NIA, "In Transit");
		}, async (w) => {
			eq((await w.get("/api/admin/driver-performance?period=week", USERS.admin2)).json.boards[0].drivers.find((x) => x.name === NIA).pickups.eld, 1, "with no dispatch row on record too: a late first tap isn't the run's start");
		});
		await inWorld((w) => {
			w.hist("PF-23", "geofence", "In Transit", `${MON} 14:00:00`, NIA);
			w.hist("PF-23", "cancel", "Cancelled", `${MON} 15:00:00`, "disp");
			w.row("PF-23", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "cancelled on record, but the sheet reads In Transit again: not certain, so it stands as today");
		});

		const friday = Date.parse("2026-11-14T04:30:00Z"); // Fri Nov 13, 11:30 PM Eastern
		await inWorld((w) => {
			w.hist("PF-56", "geofence", "In Transit", "2026-11-14 02:00:00", NIA); // Fri 9 PM Eastern, already Saturday in UTC
			w.row("PF-56", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-56", pickup: PICKED("Fri"), delivery: null }], "a pickup late on the week's last evening is judged and counted");
		}, { nowMs: friday });
		await inWorld((w) => {
			w.hist("PF-57", "geofence", "In Transit", "2026-10-31 14:00:00", NIA); // the first day of last week
			w.row("PF-57", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[1].loads, [{ loadId: "PF-57", pickup: PICKED("Sat"), delivery: null }], "and so is one on last week's first morning");
		});

		// A handover or reassignment: the credit goes to whoever made the pickup.
		await inWorld((w) => w.clean("PF-31", OMAR, MON, NIA), async (w) => {
			const nia = await w.get(OWN_WEEK, USERS.nia);
			const omar = await w.get(OWN_WEEK, USERS.omar);
			eq(nia.json.weeks[0].credits, { value: 0.5, target: 7.5, deliveries: 0, pickups: 1 }, "reassigned after her truck picked it up: the 0.5 is hers, though the sheet names him");
			eq(nia.json.weeks[0].loads, [{ loadId: "PF-31", pickup: PICKED("Mon"), delivery: null }], "and her list shows the row, so it still adds up");
			eq(omar.json.weeks[0].credits, { value: 1, target: 7.5, deliveries: 1, pickups: 0 }, "the new driver gets his delivery and not her pickup");
			eq(omar.json.weeks[0].loads, [{ loadId: "PF-31", pickup: NOT_COUNTED, delivery: DONE("Mon") }], "and his row says the pickup didn't count for him");
			ok(!/nia|frost/i.test(omar.text), "his answer doesn't name her");
			ok(!/omar|hale/i.test(nia.text), "her answer doesn't name him");
		});
		// Her own tap is her load's own record: the route only lets a Driver session tap a load in his name.
		await inWorld((w) => {
			w.hist("PF-34", "manual", "In Transit", `${MON} 14:00:00`, NIA, { role: "Driver" });
			w.row("PF-34", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [1, 0], "her tap on a truck with no ELD, the load since moved: the pickup is hers");
		});
		await inWorld((w) => {
			w.hist("PF-35", "manual", "In Transit", `${MON} 14:00:00`, NIA, { role: "Dispatcher" });
			w.row("PF-35", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [0, 1], "the same row from a staff session isn't her record: the route takes any name from staff, so it follows the Driver cell, as today");
		});
		const eldOn = (w, truck) => w.db.prepare("INSERT INTO eld_miles_daily (routemate_vehicle_id, local_day, truck_id, miles, samples) VALUES (?, ?, ?, 100, 40)").run(`rm-${truck}`, MON, truck);
		await inWorld((w) => {
			eldOn(w, 21);
			w.hist("PF-36", "manual", "In Transit", `${MON} 14:00:00`, NIA, { role: "Driver" });
			w.row("PF-36", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [0, 1], "her tap on a truck with a reporting ELD proves no pickup of hers, so nothing moves: it follows the Driver cell, as today");
		});
		await inWorld((w) => {
			eldOn(w, 21);
			eldOn(w, 22);
			w.hist("PF-37", "manual", "In Transit", `${MON} 14:00:00`, NIA, { role: "Driver" });
			w.row("PF-37", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [0, 0], "and if his truck reports too, a tap earns nothing, as today");
		});

		// The ELD path: a truck's holder takes a credit only if the load's own record or the sheet links him to the load.
		const truckHandedOver = (w) => {
			w.db.prepare("DELETE FROM truck_assignments WHERE truck_id IN (21, 22)").run();
			w.assign(21, NIA, "2026-11-10T15:00:00.000Z");
			w.db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (21, ?, '2026-11-10T15:00:00.000Z', '')").run(OMAR);
			w.depart("PF-32", Date.parse(`${MON}T14:00:00Z`), 21);
		};
		await inWorld((w) => {
			truckHandedOver(w);
			w.row("PF-32", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			const nia = await w.get(OWN_WEEK, USERS.nia);
			eq(nia.json.weeks[0].credits.pickups, 0, "a truck handed over, and nothing links her to the load: no credit for her");
			ok(!nia.text.includes("PF-32"), "and no load number she was never given", nia.text.slice(0, 200));
			eq((await w.weeks("omar"))[0].credits, { value: 1.5, target: 7.5, deliveries: 1, pickups: 1 }, "it follows the Driver cell, as today");
		});
		await inWorld((w) => {
			truckHandedOver(w);
			w.hist("PF-32", "accept", "Assigned", `${MON} 09:00:00`, NIA, { old: "Dispatched", role: "Driver" });
			w.row("PF-32", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [1, 0], "with her own row on the load and her truck's own record: the pickup is hers");
		});
		await inWorld((w) => {
			truckHandedOver(w);
			w.row("PF-32", NIA, "Dispatched");
			w.row("PF-32", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [1, 0], "and with the sheet naming her on a copy of it too");
		});
		await inWorld((w) => {
			truckHandedOver(w);
			w.hist("PF-32", "accept", "Assigned", `${MON} 09:00:00`, NIA, { old: "Dispatched", role: "Dispatcher" });
			w.row("PF-32", OMAR, "Delivered", `${TUE} 18:00`);
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [0, 1], "a staff session's row naming her doesn't link her");
		});
		await inWorld((w) => {
			w.depart("PF-33", Date.parse(`${MON}T14:00:00Z`), 22);
			w.row("PF-33", NIA, "In Transit");
		}, async (w) => {
			const omar = await w.get(OWN_WEEK, USERS.omar);
			eq(omar.json.weeks[0].credits.pickups, 0, "a truck's holder the sheet never gave the load to gets no credit");
			ok(!omar.text.includes("PF-33"), "and no load number", omar.text.slice(0, 200));
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "it follows the Driver cell, as today");
		});
		await inWorld((w) => {
			w.db.prepare("DELETE FROM truck_assignments WHERE truck_id = 22").run();
			w.depart("PF-33b", Date.parse(`${MON}T14:00:00Z`), 22);
			w.row("PF-33b", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "a truck with no holder on record then moves nothing either");
		});

		// A dispatcher's tap names the dispatcher, and a reassign writes no row, so only her own rows on both sides of it say she held the load.
		const tapper = { role: "Dispatcher" };
		await inWorld((w) => {
			w.hist("PF-38", "accept", "Assigned", `${MON} 09:00:00`, NIA, { old: "Dispatched", role: "Driver" });
			w.hist("PF-38", "override", "In Transit", `${MON} 14:00:00`, "disp", tapper);
			w.row("PF-38", OMAR, "In Transit");
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [0, 1], "her row before the tap only: the load may have moved before it, so it follows the Driver cell, as today");
		});
		await inWorld((w) => {
			w.hist("PF-39", "override", "In Transit", `${MON} 14:00:00`, "disp", tapper);
			w.hist("PF-39", "manual", "At Receiver", `${MON} 20:00:00`, NIA, { role: "Driver" });
			w.row("PF-39", OMAR, "At Receiver");
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [0, 1], "her row after the tap only: the same");
		});
		await inWorld((w) => {
			w.hist("PF-39b", "accept", "Assigned", `${MON} 09:00:00`, NIA, { old: "Dispatched", role: "Driver" });
			w.hist("PF-39b", "override", "In Transit", `${MON} 14:00:00`, "disp", tapper);
			w.hist("PF-39b", "manual", "At Receiver", `${MON} 20:00:00`, NIA, { role: "Driver" });
			w.row("PF-39b", OMAR, "At Receiver");
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [1, 0], "her rows on both sides of the tap: she held it, so the pickup is hers");
		});
		await inWorld((w) => {
			eldOn(w, 21);
			w.hist("PF-39c", "accept", "Assigned", `${MON} 09:00:00`, NIA, { old: "Dispatched", role: "Driver" });
			w.hist("PF-39c", "override", "In Transit", `${MON} 14:00:00`, "disp", tapper);
			w.hist("PF-39c", "manual", "At Receiver", `${MON} 20:00:00`, NIA, { role: "Driver" });
			w.row("PF-39c", OMAR, "At Receiver");
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [0, 1], "but a tap on her truck with a reporting ELD proves nothing of hers, so it moves nothing");
		});
		await inWorld((w) => {
			w.hist("PF-39f", "accept", "Assigned", `${MON} 09:00:00`, NIA, { old: "Dispatched", role: "Driver" });
			w.hist("PF-39f", "override", "In Transit", `${MON} 14:00:00`, "disp", tapper);
			w.hist("PF-39f", "manual", "At Receiver", `${MON} 20:00:00`, NIA, { role: "Driver" });
			w.hist("PF-39f", "manual", "Delivered", `${MON} 21:00:00`, OMAR, { role: "Driver" });
			w.row("PF-39f", OMAR, "Delivered", `${MON} 21:00`);
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [1, 0], "the rows nearest the tap decide, whoever delivered it later");
		});
		await inWorld((w) => {
			w.hist("PF-39d", "accept", "Assigned", `${MON} 09:00:00`, NIA, { old: "Dispatched", role: "Driver" });
			w.hist("PF-39d", "override", "In Transit", `${MON} 14:00:00`, "disp", tapper);
			w.hist("PF-39d", "manual", "At Receiver", `${MON} 20:00:00`, OMAR, { role: "Driver" });
			w.row("PF-39d", OMAR, "At Receiver");
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [0, 1], "two drivers either side of the tap: not certain, so it follows the Driver cell, as today");
		});
		await inWorld((w) => {
			w.hist("PF-39e", "accept", "Assigned", `${MON} 09:00:00`, NIA, { old: "Dispatched", role: "Driver" });
			w.hist("PF-39e", "override", "In Transit", `${MON} 14:00:00`, "disp", tapper);
			w.hist("PF-39e", "manual", "At Receiver", `${MON} 20:00:00`, NIA, tapper);
			w.row("PF-39e", OMAR, "At Receiver");
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [0, 1], "a staff session's row naming her on the far side doesn't count as hers");
		});
		await inWorld((w) => {
			w.hist("PF-40", "override", "In Transit", `${MON} 14:00:00`, "disp", tapper);
			w.row("PF-40", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "no driver's row at all: the sheet's own driver, as today");
		});
		await inWorld((w) => {
			w.hist("PF-58", "accept", "Assigned", `${MON} 09:00:00`, NIA, { old: "Dispatched", role: "Driver" });
			w.hist("PF-58", "manual", "Heading to Shipper", `${MON} 11:00:00`, OMAR, { role: "Driver" });
			w.hist("PF-58", "override", "In Transit", `${MON} 14:00:00`, "disp", tapper);
			w.hist("PF-58", "manual", "At Receiver", `${MON} 20:00:00`, NIA, { role: "Driver" });
			w.row("PF-58", OMAR, "At Receiver");
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [0, 1], "her rows on both sides aren't enough with his between them before the tap: the nearest rows decide, and they differ");
		});
		// A name in use today is that person's, wherever it's in use, and never the sheet's driver's old spelling.
		for (const [where, actor, setup] of [
			["the directory alone", "Ivy Lane", () => {}],
			["a sheet row alone", "Lou Grant", () => {}],
			["a truck assignment alone", "Zed Ames", (w) => {
				w.db.prepare("INSERT INTO trucks (id, unit_number, retired_at) VALUES (30, 'LogisX-#530', '')").run();
				w.db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (30, 'Zed Ames', '2026-10-01T12:00:00.000Z', '')").run();
			}],
		]) {
			await inWorld((w) => {
				setup(w);
				w.picked("PF-59", NIA, MON, actor);
				w.row("PF-59", NIA, "In Transit");
			}, async (w) => {
				eq((await w.weeks("nia"))[0].credits.pickups, 0, `a pickup by a name found in ${where} isn't the new driver's`);
			});
		}
		// With a delivered row and a copy below naming someone else, an old spelling is the delivered row's driver's.
		await inWorld((w) => {
			w.picked("PF-69", NIA, MON, "Nia Frosst");
			w.row("PF-69", NIA, "Delivered", `${TUE} 15:00`);
			w.row("PF-69", OMAR, "Dispatched");
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [1, 0], "an old spelling goes to the invoice's own row, not the copy below it");
		});
		// A Load ID holding contact text stays his own driver's to read: her row shows what any other driver is served.
		await inWorld((w) => w.clean("12345 555-867-5309", OMAR, MON, NIA), async (w) => {
			const nia = await w.get(OWN_WEEK, USERS.nia);
			const omar = await w.get(OWN_WEEK, USERS.omar);
			eq(nia.json.weeks[0].credits.pickups, 1, "her pickup of a load whose ID holds contact text still counts");
			ok(!nia.text.includes("555-867-5309"), "but the ID's contact isn't hers now that the load isn't", nia.text.slice(0, 200));
			ok(omar.text.includes("555-867-5309"), "its own driver reads the ID as stored, as his load card does");
		});
		await inWorld((w) => {
			w.picked("12345 555-867-5309", NIA, MON);
			w.row("12345 555-867-5309", NIA, "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.loadId), ["12345 555-867-5309"], "and so does a driver with only the pickup of a load still his");
		});
		// A stale copy naming her doesn't make the ID hers: only her own list or her own invoice serves it as stored.
		await inWorld((w) => {
			w.picked("12345 555-867-5309", NIA, MON);
			w.row("12345 555-867-5309", NIA, "Dispatched");
			w.row("12345 555-867-5309", OMAR, "In Transit");
		}, async (w) => {
			const nia = await w.get(OWN_WEEK, USERS.nia);
			eq(nia.json.weeks[0].credits.pickups, 1, "a stale copy naming her, the load now his: her pickup counts");
			ok(!nia.text.includes("555-867-5309"), "and the ID's contact stays with its driver", nia.text.slice(0, 200));
		});
		await inWorld((w) => {
			w.picked("12345 555-867-5309", NIA, MON);
			w.row("12345 555-867-5309", NIA, "In Transit");
			w.row("12345 555-867-5309", OMAR, "Cancelled");
		}, async (w) => {
			const nia = await w.get(OWN_WEEK, USERS.nia);
			eq(nia.json.weeks[0].loads, [], "a load whose bottom row is cancelled reads cancelled, as her load list has it: no row for her at all");
			ok(!nia.text.includes("555-867-5309"), "and nothing of its ID");
		});
		await inWorld((w) => {
			w.picked("12345 555-867-5309", NIA, MON);
			w.row("12345 555-867-5309", NIA, "Delivered", `${TUE} 15:00`);
			w.row("12345 555-867-5309", OMAR, "Dispatched");
		}, async (w) => {
			const nia = await w.get(OWN_WEEK, USERS.nia);
			ok(nia.text.includes("555-867-5309"), "the row her invoice bills serves it as stored, as her invoice does");
		});
		await inWorld((w) => {
			w.picked("12345 555-867-5309", NIA, MON);
			w.row("12345 555-867-5309", NIA, "Delivered", "2026-10-02 15:00");
			w.row("12345 555-867-5309", OMAR, "Dispatched");
		}, async (w) => {
			const nia = await w.get(OWN_WEEK, USERS.nia);
			eq(nia.json.weeks[0].loads.map((l) => l.loadId), ["12345 555-867-5309"], "and so does one it billed in another week");
		});
		await inWorld((w) => {
			w.picked("5550001234", NIA, MON);
			w.row("5550001234", NIA, "Dispatched", "", "555-000-1234");
			w.row("5550001234", OMAR, "In Transit");
		}, async (w) => {
			const nia = await w.get(OWN_WEEK, USERS.nia);
			eq(nia.json.weeks[0].credits.pickups, 1, "an ID that is the phone number on a stale copy only: her pickup counts");
			ok(!nia.text.includes("5550001234"), "and the number is read off every copy, not just the bottom row", nia.text.slice(0, 200));
		});

		// A rename leaves the log as it was: every row still reads his old spelling.
		await inWorld((w) => {
			for (const [i, day] of [SUN, MON, TUE].entries()) w.clean(`PF-5${i}`, NIA, day, "Nia Frosst");
		}, async (w) => {
			const nia = (await w.weeks("nia"))[0];
			eq(nia.credits, { value: 4.5, target: 7.5, deliveries: 3, pickups: 3 }, "a rename loses none of his pickups: the old spelling is nobody's now, so it follows the Driver cell, as today");
		});
		await inWorld((w) => {
			w.clean("PF-53", OMAR, MON, "Nia Frosst");
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [0, 1], "a rename and a handover together: nothing on record says whose old spelling it was, so it follows the Driver cell, as today");
		});
		await inWorld((w) => {
			w.clean("PF-55", "Ivy Lane", MON, "Nia Frosst");
		}, async (w) => {
			eq((await w.weeks("ivy"))[0].loads, [{ loadId: "PF-55", pickup: PICKED("Mon"), delivery: DONE("Mon") }], "and on a driver with no truck on record too: the old rule, unchanged");
		});
		await inWorld((w) => {
			w.clean("PF-54", NIA, MON, "");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.pickups, 1, "a row with no name on it: the Driver cell, as today");
		});
		await inWorld((w) => {
			w.picked("PF-54b", NIA, MON);
			w.row("PF-54b", "", "In Transit");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads, [{ loadId: "PF-54b", pickup: PICKED("Mon"), delivery: null }], "her truck's own geofence row with no driver on the sheet now: it's hers");
		});
		await inWorld((w) => {
			w.picked("PF-54c", NIA, MON, "Nia Frosst");
			w.row("PF-54c", "", "In Transit");
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [0, 0], "an old spelling with no driver on the sheet is nobody's, as today");
		});

		// The proof on its own, with every fact handed to it.
		const proof = proofModule();
		const norm = (s) => String(s || "").trim().toLowerCase();
		const facts = {
			normalizeName: norm,
			isDriverName: (k) => k === "ann" || k === "bob",
			onSheet: () => false,
			holderOf: () => "ann",
			truckHasEldAt: () => false,
		};
		const row = (status, source, at, actor = "ann", more = {}) => ({ new_status: status, source, changed_at: `2026-11-09 ${at}:00`, actor, ...more });
		const at = (t) => Date.parse(`2026-11-09T${t}:00Z`);
		const go = [row("In Transit", "geofence", "14:00")];
		const stated = (answer) => answer && [answer.driverKey, answer.ms, answer.source || answer.withheld];
		eq(stated(proof.qualifiedPickup({ ...facts, events: go, driverNow: "bob" })), ["ann", at("14:00"), "geofence"], "proof: a geofence departure, its writer's");
		eq(stated(proof.qualifiedPickup({ ...facts, events: go, driverNow: "ann", waitingOnSheet: true })), ["ann", at("14:00"), "undone"], "proof: the sheet says it hasn't left");
		eq(proof.qualifiedPickup({ ...facts, events: [...go, row("Dispatched", "override", "15:00", "disp", { actor_role: "Dispatcher" })], driverNow: "ann", waitingOnSheet: true }).withheld, "undone", "proof: moved back and still there");
		eq(proof.qualifiedPickup({ ...facts, events: [row("In Transit", "manual", "14:00")], driverNow: "ann", truckHasEldAt: () => true }).withheld, "no-truck-record", "proof: a tap on a truck with a reporting ELD");
		eq(proof.qualifiedPickup({ ...facts, events: [row("In Transit", "manual", "14:00")], driverNow: "ann" }).source, "driver", "proof: a tap on one without");
		eq(proof.qualifiedPickup({ ...facts, events: [row("In Transit", "override", "14:00", "disp")], driverNow: "bob" }).source, "dispatch", "proof: a dispatcher's tap");
		eq(proof.qualifiedPickup({ ...facts, events: [row("In Transit", "geofence", "14:00", "gone")], driverNow: "" }).withheld, "no-driver", "proof: a spelling nobody holds, with no driver on the load");
		eq(stated(proof.qualifiedPickup({ ...facts, events: [], driverNow: "ann", eldDepart: { ms: at("14:00"), truckId: 7 } })), ["ann", at("14:00"), "eld"], "proof: an ELD departure, for the load's driver");
		eq(stated(proof.qualifiedPickup({ ...facts, events: [], driverNow: "bob", eldDepart: { ms: at("14:00"), truckId: 7 } })), ["bob", at("14:00"), "eld"], "proof: the truck's holder takes nothing with no link to the load");
		eq(stated(proof.qualifiedPickup({ ...facts, events: [], driverNow: "bob", onSheet: () => true, eldDepart: { ms: at("14:00"), truckId: 7 } })), ["ann", at("14:00"), "eld"], "proof: and takes it with one");
		eq(proof.qualifiedPickup({ ...facts, events: [], driverNow: "ann" }), null, "proof: nothing on record, nothing to judge");
		const routesCode = fs.readFileSync(path.join(ROOT, "lib", "driver-performance-routes.js"), "utf8");
		ok(!/routemate_telemetry|load_coordinates|fuel-pickup-arrival|twinAtShipper|buildEldDeviceResolver/.test(routesCode), "no twin test: the route reads no track and no mapped pickup");
		eq(Object.keys(proof.qualifiedPickup({ ...facts, events: go, driverNow: "ann" })), ["driverKey", "ms", "source"], "and a credit carries nothing for one");
		eq(proof.statusesStillWaiting(["Dispatched", "At Shipper", "Loading", "", "Cancelled"]), true, "the sheet: nothing past its shipper");
		eq(proof.statusesStillWaiting(["Dispatched", "In Transit"]), false, "the sheet: one row has left");
		eq(proof.statusesStillWaiting(["Cancelled"]), false, "the sheet: a cancelled load isn't a waiting one");
		const src = fs.readFileSync(path.join(ROOT, "lib", "driver-pickup-proof.js"), "utf8");
		eq([...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]), ["./arrival-pickup", "./driver-performance"], "the proof requires only the pure rules");
		ok(!/\bdb\b|process\.env|Date\.now|new Date/.test(src.replace(/\/\/.*$/gm, "")), "and reads no database, setting or clock");
	});

	await section("27 a load on two sheet rows counts as the invoice counts it", async () => {
		for (const [says, rows] of [
			["one row, delivered (the control)", [["PF-60", NIA, "Delivered", `${TUE} 15:00`]]],
			["an open row above a delivered copy", [["PF-60", NIA, "In Transit", ""], ["PF-60", NIA, "Delivered", `${TUE} 15:00`]]],
			["delivered, with a cancelled copy below", [["PF-60", NIA, "Delivered", `${TUE} 15:00`], ["#PF-60", NIA, "Cancelled", ""]]],
			["delivered, with an open copy below", [["PF-60", NIA, "Delivered", `${TUE} 15:00`], ["PF-60", NIA, "Dispatched", ""]]],
			["delivered, with a copy below naming no driver yet", [["PF-60", NIA, "Delivered", `${TUE} 15:00`], ["PF-60", "", "Unassigned", ""]]],
			["delivered by her, with a copy below naming another driver", [["PF-60", NIA, "Delivered", `${TUE} 15:00`], ["PF-60", OMAR, "Dispatched", ""]]],
			["delivered and dated, with a delivered copy below with no date", [["PF-60", NIA, "Delivered", `${TUE} 15:00`], ["PF-60", NIA, "Delivered", ""]]],
			["delivered with no date, with a delivered and dated copy below", [["PF-60", NIA, "Delivered", ""], ["PF-60", NIA, "Delivered", `${TUE} 15:00`]]],
			["spelled two ways, both delivered", [["#PF-60", NIA, "Delivered", `${TUE} 15:00`], ["PF-60", NIA, "Delivered", `${TUE} 15:00`]]],
		]) {
			await inWorld((w) => {
				w.picked("PF-60", NIA, MON);
				for (const r of rows) w.row(...r);
			}, async (w) => {
				const nia = (await w.weeks("nia"))[0];
				eq(nia.credits, { value: 1.5, target: 7.5, deliveries: 1, pickups: 1 }, `${says}: 1.5 of 7.5`);
				eq([nia.loads.length, nia.loads[0] && nia.loads[0].pickup, nia.loads[0] && nia.loads[0].delivery], [1, PICKED("Mon"), DONE("Tue")], `${says}: one row, both credits`);
				eq(nia.credits.deliveries, w.invoiceBills(NIA, "2026-11-07", "2026-11-13"), `${says}: what her invoice bills`);
			});
		}
		await inWorld((w) => {
			w.picked("PF-61", NIA, MON);
			w.row("PF-61", NIA, "Delivered", `${TUE} 15:00`);
			w.row("PF-61", OMAR, "Dispatched");
		}, async (w) => {
			const omar = (await w.weeks("omar"))[0];
			eq([omar.credits.deliveries, omar.credits.pickups, omar.loads], [0, 0, []], "the driver the copy below names reads nothing for it, and his invoice bills nothing");
			eq(w.invoiceBills(OMAR, "2026-11-07", "2026-11-13"), 0, "as his invoice says");
		});
		await inWorld((w) => {
			w.picked("PF-62", NIA, LAST_THU);
			w.row("PF-62", NIA, "Delivered", `${LAST_FRI} 15:00`);
			w.row("PF-62", NIA, "Delivered", `${TUE} 15:00`);
		}, async (w) => {
			const nia = await w.weeks("nia");
			eq(nia.map((x) => x.credits.deliveries), [w.invoiceBills(NIA, "2026-11-07", "2026-11-13"), w.invoiceBills(NIA, "2026-10-31", "2026-11-06")], "two delivered rows in two weeks: each week as that week's invoice bills it");
			eq(nia.map((x) => x.credits.pickups), [0, 1], "and one pickup, in the week it was made");
		});
		await inWorld((w) => {
			w.picked("PF-63", NIA, MON);
			w.row("PF-63", NIA, "Delivered", `${TUE} 15:00`);
			w.row("PF-63", OMAR, "Delivered", `${TUE} 16:00`);
		}, async (w) => {
			eq([(await w.weeks("nia"))[0].credits.deliveries, (await w.weeks("omar"))[0].credits.deliveries], [1, 1], "two delivered rows naming two drivers: each as his own invoice bills it");
			eq([w.invoiceBills(NIA, "2026-11-07", "2026-11-13"), w.invoiceBills(OMAR, "2026-11-07", "2026-11-13")], [1, 1], "which is what those invoices do");
			eq([(await w.weeks("nia"))[0].credits.pickups, (await w.weeks("omar"))[0].credits.pickups], [1, 0], "and the pickup is still one driver's");
		});
		await inWorld((w) => {
			w.picked("PF-64", NIA, MON);
			w.row("PF-64", NIA, "In Transit");
			w.row("#PF-64", NIA, "Cancelled");
		}, async (w) => {
			const nia = (await w.weeks("nia"))[0];
			eq([nia.credits.value, nia.loads], [0, []], "an open row above a cancelled copy: the load reads cancelled, as his load list has it, and earns nothing");
			eq(w.invoiceBills(NIA, "2026-11-07", "2026-11-13"), 0, "and his invoice bills nothing");
		});
		await inWorld((w) => {
			w.picked("PF-65", NIA, MON);
			w.row("PF-65", NIA, "Delivered", `${TUE} 15:00`);
			w.row("#PF-65", NIA, "Delivered", `${TUE} 15:00`);
			w.db.prepare("INSERT INTO deleted_loads (load_id) VALUES ('pf-65')").run();
		}, async (w) => {
			eq((await w.weeks("nia"))[0].credits.value, 0, "soft-deleted on both rows: nothing");
			eq(w.invoiceBills(NIA, "2026-11-07", "2026-11-13"), 0, "and nothing on the invoice");
		});
		// A delivered row keeps the load live, whichever week its date reads, and a copy below doesn't undo it.
		for (const [how, done] of [["with no date", ""], ["dated in a week long past", "2026-10-02 15:00"]]) {
			await inWorld((w) => {
				w.picked("PF-66", NIA, MON);
				w.row("PF-66", NIA, "Delivered", done);
				w.row("#PF-66", NIA, "Cancelled");
			}, async (w) => {
				const nia = (await w.weeks("nia"))[0];
				eq([nia.credits.deliveries, nia.credits.pickups], [0, 1], `delivered ${how}, a cancelled copy below: no delivery this week, as his invoice has it, and the pickup stands`);
				eq(w.invoiceBills(NIA, "2026-11-07", "2026-11-13"), 0, `delivered ${how}: nothing on this week's invoice`);
			});
		}
		await inWorld((w) => {
			w.picked("PF-67", NIA, MON);
			w.row("#PF-67", NIA, "Delivered", `${TUE} 15:00`);
			w.row("PF-67", NIA, "Dispatched");
		}, async (w) => {
			eq((await w.weeks("nia"))[0].loads.map((l) => l.loadId), ["#PF-67"], "a row of both credits shows the ID as the invoice's row spells it");
		});
		await inWorld((w) => {
			w.picked("PF-72", NIA, MON);
			w.row("PF-72", NIA, "Delivered", `${MON} 15:00`);
			w.row("PF-72", NIA, "Delivered", `${TUE} 15:00`);
		}, async (w) => {
			const nia = (await w.weeks("nia"))[0];
			eq([nia.credits.deliveries, nia.loads[0].delivery], [1, DONE("Tue")], "two delivered rows in one week: one delivery, on the day of the last billable row, the row the invoice bills");
			const raw = w.fns.parseSheet({ values: sheetValues(w.extraLoads) });
			const billed = w.fns.selectInvoiceWeekLoads(raw.data, raw.headers, NIA, "2026-11-07", "2026-11-13", w.fns.loadKeySet(w.fns.getDeletedLoadIds())).loads;
			eq(billed.map((r) => r["Status Update Date"]), [`${TUE} 15:00`], "which is the invoice's own choice");
		});

		// The one read every caller shares keeps what it was: only this route looks at the rest.
		await inWorld(() => {}, async (w) => {
			const read = w.fns.parseJobTrackingRead({ values: [["Load ID", "Driver"], ["PF-70", NIA], ["#PF-70", NIA], ["PF-71", OMAR]] });
			eq(read.data.map((r) => r["Load ID"]), ["#PF-70", "PF-71"], "the shared read still keeps each load's bottom row");
			eq(Object.keys(read).sort(), Object.keys(w.fns.parseSheet({ values: [["Load ID", "Driver"]] })).sort(), "and no new key shows on it");
			ok(!JSON.stringify(read).includes("\"PF-70\""), "nor in its JSON");
			const liveView = w.fns.liveJobTrackingView(read);
			eq(liveView.data.map((r) => r["Load ID"]), ["#PF-70", "PF-71"], "and every view of it reads the same rows");
		});
		lifted();
		ok(/const parsed = parseJobTrackingRead\(response\.data\);/.test(SRC), "getJobTrackingCached() reads through the same parse this runner does");
		eq((SRC.match(/\beveryJobTrackingRow\b/g) || []).length, 2, "server.js names the kept rows' reader twice: its declaration and this route's mount");
	});

	await section("28 what doesn't change", async () => {
		// Made-up sheets, each with some of every shape above, and the rules every answer must keep.
		let seed = 20261105;
		const rand = (n) => {
			seed = (seed * 1664525 + 1013904223) % 4294967296;
			return Math.floor((seed / 4294967296) * n);
		};
		const pick = (list) => list[rand(list.length)];
		const days = [`${LAST_THU}`, LAST_FRI, "2026-11-07", SUN, MON, TUE];
		const w = await proofWorld(() => {});
		const drivers = [[NIA, "nia"], [OMAR, "omar"]];
		const weeksOf = [["2026-11-07", "2026-11-13"], ["2026-10-31", "2026-11-06"]];
		const totals = { sheets: 0, weeks: 0, sumOff: 0, invoiceOff: 0, doubled: 0, wrongDriver: 0, leaked: 0, unlinked: 0, keys: 0 };
		try {
			for (let s = 0; s < 40; s++) {
				w.jt = null;
				w.handle.clearCache();
				w.extraLoads.length = 0;
				for (const t of ["load_status_history", "load_eld_miles", "deleted_loads"]) w.db.prepare(`DELETE FROM ${t}`).run();
				const actorsOf = new Map();
				for (let i = 0; i < 10; i++) {
					const id = `FZ-${s}-${i}`;
					const [holder] = pick(drivers);
					const [cell] = rand(4) === 0 ? pick(drivers) : [holder];
					const day = pick(days);
					const done = pick(days);
					const shape = pick(["clean", "clean", "picked", "moved", "none", "tap", "dispatch", "eld", "stale"]);
					if (shape === "clean") { w.picked(id, holder, day); w.hist(id, "manual", "Delivered", `${day} 20:00:00`, holder); }
					if (shape === "picked") w.picked(id, holder, day);
					if (shape === "moved") { w.picked(id, holder, day); w.hist(id, "override", pick(["Dispatched", "At Shipper"]), `${day} 15:00:00`, "disp", { role: "Dispatcher" }); }
					if (shape === "tap") w.hist(id, "manual", "In Transit", `${day} 14:00:00`, holder);
					if (shape === "dispatch") w.hist(id, "override", "In Transit", `${day} 14:00:00`, "disp", { role: "Dispatcher" });
					if (shape === "eld") w.depart(id, Date.parse(`${day}T14:00:00Z`), holder === NIA ? 21 : 22);
					if (shape === "stale") w.hist(id, "geofence", "In Transit", `${day} 14:00:00`, "Old Spelling");
					// A dispatcher's tap, an old spelling and a bare ELD record name nobody, so they follow the sheet's driver.
					if (!["none", "dispatch", "stale", "eld"].includes(shape)) actorsOf.set(id.toLowerCase(), holder);
					const status = pick(["Delivered", "Delivered", "In Transit", "Dispatched", "At Receiver"]);
					w.row(id, cell, status, status === "Delivered" && rand(5) ? `${done} 15:00` : "");
					if (rand(3) === 0) w.row(pick([id, `#${id}`]), pick([cell, cell, "", OMAR]), pick(["Delivered", "Cancelled", "Dispatched", "In Transit"]), rand(2) ? `${pick(days)} 16:00` : "");
					if (rand(15) === 0) w.db.prepare("INSERT OR IGNORE INTO deleted_loads (load_id) VALUES (?)").run(id.toLowerCase());
				}
				totals.sheets += 1;
				const credited = new Map();
				for (const [name, who] of drivers) {
					const r = await w.get(OWN_WEEK, USERS[who]);
					if (!allKeys(r.json).every((k) => /^(creditWeights|delivery|pickup|pickups|invoicePaysDays|view|weeks|credits|end|id|left|loads|newWeekNote|pace|percent|start|targetLowered|deliveries|target|value|loadId|day|note)$/.test(k))) totals.keys += 1;
					const other = name === NIA ? OMAR : NIA;
					if (new RegExp(other.split(" ")[0], "i").test(r.text)) totals.leaked += 1;
					r.json.weeks.forEach((week, i) => {
						totals.weeks += 1;
						const sum = week.loads.reduce((t, l) => t + (l.pickup.credits || 0) + (l.delivery ? l.delivery.credits : 0), 0);
						if (sum !== week.credits.value) totals.sumOff += 1;
						if (week.credits.deliveries !== w.invoiceBills(name, ...weeksOf[i])) totals.invoiceOff += 1;
						for (const l of week.loads) {
							if (!l.pickup.credits) continue;
							const key = l.loadId.toLowerCase().replace(/^#/, "");
							if (credited.has(key)) totals.doubled += 1;
							credited.set(key, name);
							if (actorsOf.has(key) && actorsOf.get(key) !== name) totals.wrongDriver += 1;
							const named = w.extraLoads.filter((row) => row[0].toLowerCase().replace(/^#/, "") === key).some((row) => row[1] === name);
							if (!named && actorsOf.get(key) !== name) totals.unlinked += 1;
						}
					});
				}
			}
		} finally {
			await w.close();
		}
		eq([totals.sheets, totals.weeks], [40, 160], "40 made-up sheets, 2 drivers, 2 weeks each");
		eq(totals.sumOff, 0, "the count equals the sum of its rows, every week");
		eq(totals.invoiceOff, 0, "deliveries equal the invoice's own selector over every row, never short and never over");
		eq(totals.doubled, 0, "no load earns its pickup twice, for two drivers or in two weeks");
		eq(totals.wrongDriver, 0, "where a driver's own row says who made the pickup, the credit is his");
		eq(totals.unlinked, 0, "and no driver gets a credit or a load number on a load neither the sheet nor his own row links him to");
		eq([totals.leaked, totals.keys], [0, 0], "each driver's answer holds his own figures and no other driver's name, in the same keys");

		// The Super Admin's report shares build() with the driver's own week, so its credits use the same proof.
		await inWorld((w) => {
			w.hist("PF-80", "geofence", "In Transit", `${MON} 10:00:00`, NIA);
			w.hist("PF-80", "geofence", "At Receiver", `${MON} 20:00:00`, NIA);
			w.row("PF-80", NIA, "At Receiver");
			w.picked("PF-81", NIA, MON);
			w.hist("PF-81", "override", "Dispatched", `${MON} 15:00:00`, "disp", { role: "Dispatcher" });
			w.row("PF-81", NIA, "Dispatched");
			w.clean("PF-82", OMAR, TUE, NIA);
		}, async (w) => {
			const report = (await w.get("/api/admin/driver-performance?period=week", USERS.admin2)).json.boards[0].drivers;
			const of = (name) => report.find((x) => x.name === name);
			eq(of(NIA).pickups, { total: 2, geofence: 2, eld: 0, driver: 0, dispatch: 0 }, "the office reads the same credits: not the status moved back, and the pickup she made of a load now his");
			eq([of(NIA).credits, of(OMAR).pickups.total, of(OMAR).credits], [1, 0, 1], "and the same sums");
		});

		// The office's unit labels check names on live rows, as they did: a name only on a cancelled row refuses none.
		await inWorld((w) => {
			w.db.prepare("UPDATE trucks SET unit_number = 'Wal-7' WHERE id = 21").run();
			w.row("PF-83", "Walt Ames", "Cancelled");
		}, async (w) => {
			const report = (await w.get("/api/admin/driver-performance?period=week", USERS.admin2)).json.boards[0].drivers;
			eq(report.find((x) => x.name === NIA).unitLabel, "#WAL-7", "the office's unit label doesn't change for a name on a dropped row");
		});

		// Nothing that pays reads the proof or the kept rows.
		const libFiles = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js"));
		const readers = libFiles.filter((f) => /driver-pickup-proof/.test(fs.readFileSync(path.join(ROOT, "lib", f), "utf8")));
		eq(readers, ["driver-performance-routes.js"], "only this feature's routes require the proof");
		lifted();
		ok(!/driver-pickup-proof/.test(SRC), "and server.js doesn't name it");
		eq((SRC.match(/process\.env\.DRIVER_PERFORMANCE[A-Z_]*/g) || []).sort(), ["process.env.DRIVER_PERFORMANCE_BOARD_ENABLED", "process.env.DRIVER_PERFORMANCE_ENABLED"], "no new flag: it goes live on deploy under the kill switch that's there");
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
