#!/usr/bin/env node
/**
 * Driver Performance, Phase A core: lib/driver-performance.js (the rules),
 * lib/driver-performance-routes.js (three read-only routes) and the one
 * server.js declaration that mounts them, DRIVER_PERFORMANCE_ENABLED a kill
 * switch, on unless set to false.
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
 * §13 roles: own week Driver only; board Driver and Super Admin; report Super
 *     Admin only; a driver not on the board is 404 NOT_ELIGIBLE
 * §14 the board over HTTP: "Most loads" equals the weekly invoice's own count
 *     per driver, this week, last week and the month; keys, labels, no names,
 *     "you" per request, coming-soon categories
 * §15 the driver's own week over HTTP: credits by source; no hours, REI, pace,
 *     gap or "out of reach" anywhere in the answer
 * §16 the Super Admin report: names, reasons, sources, hours "estimate, not
 *     checked"; bad period 400; Job Tracking down 503
 * §17 wiring: one declaration above app.get("*"), the flag's exact shape, the
 *     replica's refusal (a kill switch never goes on its --enable allowlist)
 * §18 a stored unit that isn't a unit: a name, phone or load number in
 *     trucks.unit_number never reaches a driver; the row keeps its rank and
 *     count under the neutral label; the Super Admin report names the truck
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
const HEADERS = ["Load ID", "Driver", "Job Status", "Pickup Appointment", "Drop-off Appointment", "Assigned Date", "Status Update Date", "Completion Date", "Truck"];
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
	nobody: { id: 21, role: "Driver", username: "nobody", driverName: "Ned Nobody" },
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

function sheetValues() {
	const head = HEADERS;
	return [head, ...LOADS.map(([id, driver, status, done]) => head.map((h) => (
		h === "Load ID" ? id : h === "Driver" ? driver : h === "Job Status" ? status : h === "Status Update Date" ? done : ""
	)))];
}

function makeDb() {
	const Database = require("better-sqlite3");
	const db = new Database(":memory:");
	for (const t of ["drivers_directory", "trucks", "truck_assignments", "load_status_history", "load_eld_miles", "eld_miles_daily", "deleted_loads"]) db.exec(tableDdl(t));
	db.exec("ALTER TABLE drivers_directory ADD COLUMN status TEXT DEFAULT 'active'");
	db.exec("ALTER TABLE drivers_directory ADD COLUMN pay_type TEXT DEFAULT 'fixed'");
	db.exec("ALTER TABLE trucks ADD COLUMN retired_at TEXT DEFAULT ''");
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

class FixedDate extends Date {
	constructor(...args) { super(...(args.length ? args : [NOW_MS])); }
	static now() { return NOW_MS; }
}

// One world: a real Express app with the lifted declaration mounted on it.
async function makeWorld(env) {
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
		process: { env: { ...env }, argv: [], cwd: () => ROOT }, __dirname: ROOT, Date: FixedDate,
		getJobTrackingCached: async () => {
			world.sheetReads += 1;
			if (world.sheetDown) throw new Error("made-up outage");
			if (!world.jt) {
				world.jt = world.fns.parseSheet({ values: sheetValues() });
				world.jt.data = world.fns.deduplicateLoads(world.jt.data, world.jt.headers);
			}
			return world.jt;
		},
	};
	const body = ['"use strict";', lift.text,
		"return { driverPerformance, parseSheet, deduplicateLoads, selectInvoiceWeekLoads, loadKeySet, getDeletedLoadIds, getWeekRange };"].join("\n");
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
		ok(!/delivery:\s*\d|pickup:\s*\d|"company-day-rate"|"top3-you"|"full"/.test(routes), "the routes restate none of D's answers");
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
		eq(p.ownWeekCard({ id: "this-week", start: "a", end: "b", deliveries: 3, pickups: 2 }),
			{ id: "this-week", start: "a", end: "b", credits: { value: 4, target: 7.5, deliveries: 3, pickups: 2 } }, "a driver's own week: credits toward 7.5 only");
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
	});

	await section("13 roles", async () => {
		if (!on) throw new Error("no world");
		const cases = [
			["/api/driver/me/performance", USERS.ada, 200], ["/api/driver/me/performance", USERS.admin, 403],
			["/api/driver/me/performance", USERS.dispatcher, 403], ["/api/driver/me/performance", USERS.investor, 403],
			["/api/driver/me/performance", null, 401],
			["/api/driver/performance/leaderboard", USERS.ada, 200], ["/api/driver/performance/leaderboard", USERS.admin, 200],
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
		for (const who of ["eli", "fay", "gus", "nobody"]) {
			for (const route of ["/api/driver/me/performance", "/api/driver/performance/leaderboard"]) {
				const r = await on.get(route, USERS[who]);
				ok(r.status === 404 && r.json.code === "NOT_ELIGIBLE", `${route} for ${who} (not on the board) is 404 NOT_ELIGIBLE`, `got ${r.status} ${r.text.slice(0, 80)}`);
			}
		}
		const own = await on.get("/api/driver/me/performance", USERS.ada);
		eq(own.headers["cache-control"], "private, no-store", "answers are never cached by a browser or proxy");
	});

	await section("14 the board over HTTP", async () => {
		if (!on) throw new Error("no world");
		const f = on.fns;
		const week = await on.get("/api/driver/performance/leaderboard?period=week", USERS.ada);
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
		const month = await on.get("/api/driver/performance/leaderboard?period=month", USERS.ada);
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
		const asDee = await on.get("/api/driver/performance/leaderboard?period=week", USERS.dee);
		eq(rowsOf(asDee.json.boards[0]).filter((r) => r.isYou).map((r) => r.unitLabel), ["#504 (1, to Nov 9)"], "Dee sees her own row, with her dates");
		const asHal = await on.get("/api/driver/performance/leaderboard?period=week", USERS.hal);
		eq(rowsOf(asHal.json.boards[0]).filter((r) => r.isYou).map((r) => r.unitLabel), ["#504 (2, from Nov 10)"], "Hal sees his, with his");
		eq(rowsOf(asHal.json.boards[1]).filter((r) => r.isYou).length, 0, "last week Hal is not on the board");
		const again = await on.get("/api/driver/performance/leaderboard?period=week", USERS.ada);
		eq(rowsOf(again.json.boards[0]).map((r) => [r.unitLabel, r.isYou]), rowsOf(b.boards[0]).map((r) => [r.unitLabel, r.isYou]),
			"Ada's board after Dee's and Hal's reads is unchanged: no viewer's row is kept for the next");
		const asAdmin = await on.get("/api/driver/performance/leaderboard?period=week", USERS.admin);
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
		eq(sortedKeys(a), ["creditWeights", "view", "weeks"], "the answer's keys");
		eq(a.view, "no-hours-data", "every truck gets the \"no hours data\" view");
		eq(a.creditWeights, { delivery: 1, pickup: 0.5 }, "the weights the credits use");
		eq(a.weeks.map((w) => sortedKeys(w)), [["credits", "end", "id", "start"], ["credits", "end", "id", "start"]], "each week's keys");
		eq(a.weeks.map((w) => sortedKeys(w.credits)), [["deliveries", "pickups", "target", "value"], ["deliveries", "pickups", "target", "value"]], "each week's credit keys");
		const banned = /hour|rei|pace|gap|reach|ahead|track|focus|expected/i;
		for (const [who, body] of Object.entries(weeks)) {
			ok(!allKeys(body).some((k) => banned.test(k)), `${who}: no hours, REI, pace, gap or "out of reach" key`);
			ok(!/out of reach|ahead of pace|on track|needs focus/i.test(JSON.stringify(body)), `${who}: no pace word or "out of reach" text`);
		}
		eq(a.weeks.map((w) => [w.id, w.credits.deliveries, w.credits.pickups, w.credits.value, w.credits.target]),
			[["this-week", 3, 3, 4.5, 7.5], ["last-week", 2, 1, 2.5, 7.5]],
			"Ada (ELD truck): geofence and ELD departures count, her early tap and her ELD truck's tap don't; Friday 11:30 PM ET is last week");
		eq(weeks.ben.weeks[0].credits, { value: 3, target: 7.5, deliveries: 2, pickups: 2 }, "Ben (no ELD): his tap and dispatch's tap count");
		eq(weeks.cal.weeks[0].credits, { value: 1.5, target: 7.5, deliveries: 1, pickups: 1 }, "Cal (ELD silent 20 days): his tap counts");
		eq(weeks.dee.weeks.map((w) => w.credits.deliveries), [1, 1], "Dee's deliveries, this week and last");
		eq(weeks.hal.weeks.map((w) => w.credits.deliveries), [2, 0], "Hal's own week shows even with no truck last week");
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
		const bad = await on.get("/api/driver/performance/leaderboard?period=year", USERS.ada);
		ok(bad.status === 400 && bad.json.code === "BAD_PERIOD", "an unknown period is 400 BAD_PERIOD");
		const badAdmin = await on.get("/api/admin/driver-performance?period=", USERS.admin2);
		ok(badAdmin.status === 400 && badAdmin.json.code === "BAD_PERIOD", "an empty period is 400 too");
		on.handle.clearCache();
		on.sheetDown = true;
		for (const [route, who] of [["/api/driver/me/performance", USERS.ada], ["/api/driver/performance/leaderboard", USERS.ada], ["/api/admin/driver-performance", USERS.admin2]]) {
			const down = await on.get(route, who);
			ok(down.status === 503 && down.json.code === "PERFORMANCE_UNAVAILABLE", `${route}: Job Tracking down is 503, not an empty board`, `got ${down.status}`);
		}
		on.sheetDown = false;
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
		const routesSrc = fs.readFileSync(path.join(ROOT, "lib", "driver-performance-routes.js"), "utf8");
		ok(!/\b(INSERT|UPDATE|DELETE|REPLACE)\s/.test(routesSrc.replace(/\/\/.*$/gm, "")) && !/\.run\(|\.exec\(/.test(routesSrc), "the routes module writes nothing to the database");
		ok(!/app\.(post|put|patch|delete)\(/.test(routesSrc), "and registers no write route");
		const rules = require(path.join(ROOT, "lib", "replica-rules.js"));
		ok(!(rules.ENABLE_ALLOWED || []).includes("DRIVER_PERFORMANCE_ENABLED"), "replica:start --enable doesn't take it: it is already on");
		ok(/kill switch/.test(String((rules.ENABLE_REFUSED || {}).DRIVER_PERFORMANCE_ENABLED)), "the replica refuses it as a kill switch");
	});

	await section("18 a stored unit that isn't a unit", async () => {
		if (!on) throw new Error("no world");
		const setUnit = (id, unit) => {
			on.db.prepare("UPDATE trucks SET unit_number = ? WHERE id = ?").run(unit, id);
			on.handle.clearCache();
		};
		const boardAs = async (who) => {
			const r = await on.get("/api/driver/performance/leaderboard?period=week", who);
			return { json: r.json, text: r.text, rows: r.json.boards[0].categories[0].rows };
		};
		const notShown = need().UNIT_NOT_SHOWN;
		// A name only an assignment holds: not in the directory, and on no load.
		on.db.prepare("INSERT INTO trucks (id, unit_number, retired_at) VALUES (10, 'LogisX-#510', '')").run();
		on.db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (10, 'Zed Ames', '2026-10-01T12:00:00.000Z', '')").run();
		on.handle.clearCache();
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
			const report = await on.get("/api/admin/driver-performance?period=week", USERS.admin2);
			const ben = report.json.boards[0].drivers.find((x) => x.name === "Ben Marsh");
			eq([ben.unitLabel, ben.units.map((u) => [u.unitLabel, u.unitNumber, u.labelRefused])], [notShown, [[notShown, stored, why]]],
				`${stored}: the Super Admin report names the truck as stored, and why`);
		}
		setUnit(2, "Logisx-#502");
		eq((await boardAs(USERS.ada)).rows.map((r) => r.unitLabel), plain.map((r) => r.unitLabel), "corrected, the unit reads as itself again");
		const own = await on.get("/api/driver/me/performance", USERS.ben);
		ok(!/"unit/i.test(own.text), "a driver's own week carries no unit at all");
	});

	if (on) await on.close();
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
