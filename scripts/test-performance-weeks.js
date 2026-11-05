#!/usr/bin/env node
/**
 * Driver Performance, Phase B4: locked week rows, streaks, freezes, excuses and the
 * quarterly flag, REPORT ONLY. lib/driver-performance-weeks.js (the rules),
 * lib/driver-performance-weeks-routes.js (the lock, the report, the decisions) and the
 * server.js declaration that mounts them, DRIVER_PERFORMANCE_WEEKS_ENABLED on only when
 * exactly "true".
 *
 * WHAT IS REAL. The rules and routes as shipped. For the routes, server.js's own
 * declaration is lifted with everything it uses (scripts/lib/server-lift.js closure():
 * requireRole, logAudit, getWeekRange, the weekly invoice's column and verdict rules, the
 * cancelled/deleted filter, the driver and device resolvers, driverAvailabilityByName())
 * and mounted on a real Express app on 127.0.0.1 port 0, over an in-memory SQLite built
 * from server.js's own DDL. Job Tracking is a stub serving made-up rows through
 * server.js's own parseSheet() and deduplicateLoads(). The session is a header the test
 * sets, and the clock is one the test moves. Every name, unit and load is made up.
 *
 * §1  the rules, pure: the tier reading in one constant, targets, verdict order, the
 *     effective verdict, the streak, tiers and uplift, the calendar, the settings
 * §2  the flag: on only for exactly "true"; off there is no table, no timer, and each
 *     route answers what an unknown path answers; wiring, settings template, replica
 * §3  the start: no go means no streak, whatever happens; no backfill, a row locked
 *     before the go never counts, even if the go is back-dated
 * §4  the lock: Sat 06:00 ET, after a rollup covering Friday night; once, whole, and it
 *     stays as it was; a later correction is a note; off and on again writes no gap
 * §5  verdicts from gathered facts: met, missed, frozen, pending; unplugging an ELD
 *     can't protect a streak; days off, requests and who is in
 * §6  a pickup credit needs its current run, no errand and no twin; taps; bucketing
 * §7  decisions: excuses, repair freezes, pending decided, proposals, the automatic
 *     hours-of-service excuse and its 7 days, the office's pickup credit
 * §8  the streak through the report: tiers, holds, resets, the quarterly flag
 * §9  who sees what: Super Admin only for the report; no hours on any driver route
 * §10 it can't reach pay: nothing in an invoice, ledger, payout or investor path reads
 *     these rows, by source and by behaviour; it writes only its own tables
 *
 * Hermetic: :memory: SQLite, port 0, no network beyond 127.0.0.1.
 * SERVER_ROOT=<a base checkout> runs it against that base, to see it fail.
 * Run: node scripts/test-performance-weeks.js    # exits 1 on failure
 */
"use strict";

process.env.APP_TIMEZONE = "America/New_York";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { createRequire } = require("module");

const ROOT = process.env.SERVER_ROOT ? path.resolve(process.env.SERVER_ROOT) : path.join(__dirname, "..");

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
// A section that throws (a module missing on the base) fails by name, and the rest still run.
async function section(title, fn) {
	console.log(`\n§ ${title}`);
	try {
		await fn();
	} catch (err) {
		ok(false, `${title}: ran to the end`, err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : String(err));
	}
}

let rules = null;
let routes = null;
let perf = null;
let eldActivity = null;
function need() {
	rules = rules || require(path.join(ROOT, "lib", "driver-performance-weeks.js"));
	routes = routes || require(path.join(ROOT, "lib", "driver-performance-weeks-routes.js"));
	perf = perf || require(path.join(ROOT, "lib", "driver-performance.js"));
	eldActivity = eldActivity || require(path.join(ROOT, "lib", "eld-activity-daily.js"));
	return rules;
}

const SWITCH_ON_MS = Date.parse("2026-11-04T17:00:00Z"); // Wed, noon Eastern
const WEEK0 = "2026-11-07";
const addDays = (day, n) => {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const weekN = (n) => addDays(WEEK0, 7 * n);

// ── made-up fleet ──────────────────────────────────────────────────────────
const DRIVERS = [
	{ id: 1, name: "Ada Quill", status: "active", pay_type: "fixed", pay_daily: 300, user_id: 11 },
	{ id: 2, name: "Ben Marsh", status: "active", pay_type: "fixed", pay_daily: 250, user_id: 12 },
	{ id: 3, name: "Cal Reyes", status: "active", pay_type: "fixed", pay_daily: 350, user_id: 13 },
	{ id: 4, name: "Dee Stone", status: "active", pay_type: "fixed", pay_daily: 300, user_id: 14 },
	{ id: 5, name: "Eli North", status: "active", pay_type: "percentage", pay_daily: 0, user_id: 15 },
	{ id: 6, name: "Fay Owens", status: "active", pay_type: "fixed", pay_daily: 300, user_id: 16 },
	{ id: 7, name: "Gus Pike", status: "pending", pay_type: "fixed", pay_daily: 300, user_id: 17 },
	{ id: 8, name: "Hal Briar", status: "active", pay_type: "fixed", pay_daily: 300, user_id: 18 },
	{ id: 9, name: "Ivy Lane", status: "active", pay_type: "fixed", pay_daily: 300, user_id: 19 },
];
// Dee's truck has no device at all; every other truck has one linked.
const TRUCKS = [
	{ id: 1, unit: "LogisX-#501", driver: "Ada Quill", vid: "rm-1" },
	{ id: 2, unit: "LogisX-#502", driver: "Ben Marsh", vid: "rm-2" },
	{ id: 3, unit: "LogisX-#503", driver: "Cal Reyes", vid: "rm-3" },
	{ id: 4, unit: "LogisX-#504", driver: "Dee Stone", vid: null },
	{ id: 5, unit: "LogisX-#505", driver: "Eli North", vid: "rm-5" },
	{ id: 6, unit: "LogisX-#506", driver: "Fay Owens", vid: "rm-6" },
	{ id: 8, unit: "LogisX-#508", driver: "Hal Briar", vid: "rm-8" },
];
const USERS = {
	ada: { id: 11, role: "Driver", username: "ada", driverName: "Ada Quill" },
	eli: { id: 15, role: "Driver", username: "eli", driverName: "Eli North" },
	nobody: { id: 21, role: "Driver", username: "nobody", driverName: "Ned Nobody" },
	admin: { id: 31, role: "Super Admin", username: "admin" },
	dispatcher: { id: 41, role: "Dispatcher", username: "disp" },
	investor: { id: 51, role: "Investor", username: "inv" },
};
const HEADERS = ["Load ID", "Driver", "Job Status", "Pickup Appointment", "Drop-off Appointment", "Assigned Date", "Status Update Date", "Completion Date", "Truck"];

// ── the server.js world ────────────────────────────────────────────────────
let SRC = null;
let LIFT = null;
let WD = null;
function lifted() {
	if (LIFT) return LIFT;
	SRC = require("./lib/server-source").serverSource();
	const { closure } = require("./lib/server-lift");
	LIFT = closure(SRC, {
		roots: ["driverPerformanceWeeks", "driverPerformance", "parseSheet", "deduplicateLoads", "getWeekRange"],
		provided: ["app", "db", "getJobTrackingCached"],
		denied: ["server", "transporter", "getDrive", "getSheets", "sendEmail"],
	});
	return LIFT;
}

function makeDb() {
	WD = WD || require("./lib/work-days-world");
	const db = WD.schemaDb();
	db.exec(require(path.join(ROOT, "lib", "owner-operator.js")).OO_SCHEMA_SQL);
	eldActivity.ensureEldActivitySchema(db);
	const dir = db.prepare("INSERT INTO drivers_directory (id, driver_name, status, pay_type, pay_daily, user_id) VALUES (?, ?, ?, ?, ?, ?)");
	for (const x of DRIVERS) dir.run(x.id, x.name, x.status, x.pay_type, x.pay_daily, x.user_id);
	const tr = db.prepare(`INSERT INTO trucks (id, unit_number, status, in_service_date, created_at, assigned_driver, routemate_vehicle_id, retired_at)
		VALUES (?, ?, 'Active', '2026-08-01', '2026-08-01 00:00:00', ?, ?, '')`);
	const ta = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, '2026-10-01T12:00:00.000Z', '')");
	for (const t of TRUCKS) { tr.run(t.id, t.unit, t.driver, t.vid); ta.run(t.id, t.driver); }
	db.prepare("INSERT INTO owner_operators (user_id, status, created_at) VALUES (16, 'active', '2026-10-01T12:00:00Z')").run();
	return db;
}

function fixedDate(clock) {
	return class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [clock.ms])); }
		static now() { return clock.ms; }
	};
}

// One world: a real Express app with the lifted declarations mounted on it. Pass `db` to
// bring a database back up under other settings, as a restart would.
async function makeWorld(env = { DRIVER_PERFORMANCE_WEEKS_ENABLED: "true" }, { nowMs = SWITCH_ON_MS, db = null } = {}) {
	need();
	const express = require("express");
	const lift = lifted();
	const app = express();
	app.use(express.json());
	app.use((req, res, next) => {
		const raw = req.headers["x-test-user"];
		req.session = raw ? { user: JSON.parse(raw) } : {};
		next();
	});
	const world = { db: db || makeDb(), sheetDown: false, rows: [], clock: { ms: nowMs }, logs: [] };
	const quiet = { log: (...a) => world.logs.push(a.join(" ")), info() {}, warn() {}, error: (...a) => world.logs.push(a.join(" ")) };
	const deps = {
		app, db: world.db, require: createRequire(path.join(ROOT, "server.js")), console: quiet,
		process: { env: { ...env }, argv: [], cwd: () => ROOT }, __dirname: ROOT, Date: fixedDate(world.clock),
		getJobTrackingCached: async () => {
			if (world.sheetDown) throw new Error("made-up outage");
			const values = [HEADERS, ...world.rows.map((r) => HEADERS.map((h) => r[h] || ""))];
			const jt = world.fns.parseSheet({ values });
			jt.data = world.fns.deduplicateLoads(jt.data, jt.headers);
			return jt;
		},
	};
	const body = ['"use strict";', lift.text, "return { driverPerformanceWeeks, driverPerformance, parseSheet, deduplicateLoads, getWeekRange };"].join("\n");
	const realLog = console.log;
	const realError = console.error;
	console.log = (...a) => world.logs.push(a.join(" "));
	console.error = (...a) => world.logs.push(a.join(" "));
	try {
		world.fns = new Function(...Object.keys(deps), body)(...Object.values(deps));
	} finally {
		console.log = realLog;
		console.error = realError;
	}
	world.handle = world.fns.driverPerformanceWeeks;
	await new Promise((resolve) => { world.server = app.listen(0, "127.0.0.1", resolve); });
	world.port = world.server.address().port;
	world.call = (method, p, user, payload, extra = {}) => new Promise((resolve, reject) => {
		const text = payload === undefined ? "" : JSON.stringify(payload);
		const headers = {
			...(user ? { "x-test-user": JSON.stringify(user) } : {}),
			...(method === "GET" ? {} : { "x-requested-with": "test" }),
			...(text ? { "content-type": "application/json", "content-length": Buffer.byteLength(text) } : {}),
			...extra,
		};
		const req = http.request({ host: "127.0.0.1", port: world.port, path: p, method, headers }, (res) => {
			let buf = "";
			res.setEncoding("utf8");
			res.on("data", (c) => { buf += c; });
			res.on("end", () => {
				let json = null;
				try { json = JSON.parse(buf); } catch { json = null; }
				resolve({ status: res.statusCode, json, text: buf });
			});
		});
		req.on("error", reject);
		if (text) req.write(text);
		req.end();
	});
	world.close = () => new Promise((resolve) => world.server.close(resolve));

	// ── facts ────────────────────────────────────────────────────────────────
	world.row = (id, driver, status, done) => { world.rows.push({ "Load ID": id, Driver: driver, "Job Status": status, "Status Update Date": done || "" }); };
	const hist = world.db.prepare(`INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, actor_role, changed_at, other_load_hauling)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
	world.hist = (load, source, status, atIso, actor, { role = "", old = "", hauling = null } = {}) => {
		hist.run(load.toLowerCase().replace(/^#/, ""), old, status, source, actor, role, atIso.replace("T", " ").replace(/\.\d+Z$|Z$/, ""), hauling);
	};
	const eldRow = world.db.prepare(`INSERT OR REPLACE INTO eld_activity_daily
		(routemate_vehicle_id, truck_id, local_day, week_start, driver_id, samples, observed_min, coverage, driving_min, engine_on_min, idle_min, speeding_episodes, basis, first_ms, last_ms)
		VALUES (?, ?, ?, ?, ?, ?, 0, 0.5, ?, NULL, NULL, 0, ?, 1, 2)`);
	world.eld = (driverId, truckId, day, hours, { week = null, samples = 500, basis = "gps-estimate" } = {}) => {
		const weekStart = week || world.fns.getWeekRange(day).weekStart;
		eldRow.run(`rm-${truckId}`, truckId, day, weekStart, driverId, samples, hours === null ? null : hours * 60, basis);
	};
	world.rollupThrough = (ms) => {
		world.db.prepare("INSERT OR REPLACE INTO server_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
			.run(eldActivity.ELD_ACTIVITY_LAST_RUN_KEY, JSON.stringify({ atMs: ms }));
	};
	// One clean load: arrival and departure by geofence, delivery later the same day.
	world.load = (id, driver, day, { pickupActor = driver, delivered = true } = {}) => {
		world.hist(id, "geofence", "At Shipper", `${day}T13:00:00Z`, pickupActor);
		world.hist(id, "geofence", "In Transit", `${day}T14:00:00Z`, pickupActor);
		if (delivered) {
			world.hist(id, "manual", "Delivered", `${day}T20:00:00Z`, driver);
			world.row(id, driver, "Delivered", `${day} 15:00`);
		} else world.row(id, driver, "In Transit", "");
	};
	// A week of `loads` clean loads, and `hours` a day, on the week's Monday to Friday. The
	// truck reports on Saturday and Sunday too, parked, so the week is not "silent".
	world.work = (who, week, { loads = 5, hours = 8.5, days = 5 } = {}) => {
		const driver = DRIVERS.find((x) => x.name === who);
		const truck = TRUCKS.find((t) => t.driver === who);
		for (let i = 0; i < 7; i++) {
			const day = addDays(week, i);
			const on = i >= 2 && i < 2 + days;
			if (truck) world.eld(driver.id, truck.id, day, on ? hours : 0);
		}
		for (let i = 0; i < loads; i++) world.load(`L${driver.id}-${week}-${i}`, who, addDays(week, 2 + (i % 5)));
	};
	// A lock at the week's own moment, with the rollup having covered its Friday night.
	world.lock = async (week) => {
		const at = rules.lockMomentMs(week);
		world.clock.ms = at;
		world.rollupThrough(at);
		return world.handle.lockDue(at);
	};
	world.report = async (week) => (await world.call("GET", `/api/admin/driver-performance/weeks${week ? `?week=${week}` : ""}`, USERS.admin)).json;
	world.rowOf = (who, week) => world.db.prepare("SELECT * FROM performance_weeks WHERE directory_id = ? AND week_start = ?").get(DRIVERS.find((x) => x.name === who).id, week);
	world.driverIn = (report, who) => (report.drivers || []).find((x) => x.name === who) || null;
	world.decide = (who, week, verdict, reason = "a made-up reason", user = USERS.admin) => world.call("POST",
		`/api/admin/driver-performance/weeks/${DRIVERS.find((x) => x.name === who).id}/${week}/decision`, user, { verdict, reason });
	// A row put straight into the table, for the streak's own arithmetic.
	world.seed = (who, week, verdict, { eligible = 1, credits = 7.5, hours = 42.5 } = {}) => {
		const id = DRIVERS.find((x) => x.name === who).id;
		world.db.prepare(`INSERT INTO performance_weeks (directory_id, week_start, week_end, unit_number, verdict, reason, credits, deliveries, pickups, hours, rei,
			target_credits, target_hours, worked_days, days_off, silent_days, source_mix, detail, streak_eligible, locked_at)
			VALUES (?, ?, ?, '', ?, 'seed', ?, 5, 5, ?, 100, 7.5, 42.5, 5, 0, 0, '{}', '{}', ?, '2026-11-14T11:00:00.000Z')`).run(id, week, addDays(week, 6), verdict, credits, hours, eligible);
		world.db.prepare("INSERT OR IGNORE INTO performance_week_runs (week_start, locked_at, rows_written) VALUES (?, '2026-11-14T11:00:00.000Z', 1)").run(week);
	};
	return world;
}
const GO = { DRIVER_PERFORMANCE_WEEKS_ENABLED: "true", DRIVER_PERFORMANCE_GO_DAY: "2026-11-05" };
const tableNames = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'performance_week%'").all().map((r) => r.name).sort();
const allKeys = (v, out = []) => {
	if (Array.isArray(v)) { for (const x of v) allKeys(x, out); return out; }
	if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); allKeys(x, out); }
	return out;
};
const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;

(async () => {
	// ── §1 ──────────────────────────────────────────────────────────────────
	await section("1 the rules, pure", () => {
		const R = need();
		eq(R.TIER_READING, { id: "a-absolute", tiers: [{ level: 1, weeks: 3, rateCents: 32500 }, { level: 2, weeks: 6, rateCents: 35000 }] }, "the tier reading is at the plan's default");
		ok(Object.isFrozen(R.TIER_READING) && Object.isFrozen(R.TIER_READING.tiers), "...frozen");
		const rulesText = fs.readFileSync(path.join(ROOT, "lib", "driver-performance-weeks.js"), "utf8");
		const routesText = fs.readFileSync(path.join(ROOT, "lib", "driver-performance-weeks-routes.js"), "utf8");
		eq((rulesText.match(/\b(325|350)(00)?\b/g) || []).length, 2, "the tier dollars stand in one place: the constant's two lines");
		ok(!/\b(325|350)(00)?\b/.test(routesText), "...and the routes name no tier dollars");

		eq(R.weekTargets(0), { days: 5, credits: 7.5, hours: 42.5 }, "no days off: 7.5 credits and 42.5 hours");
		eq(R.weekTargets(1), { days: 4, credits: 6, hours: 34 }, "one day off: pro rata");
		eq(R.weekTargets(2), { days: 3, credits: 4.5, hours: 25.5 }, "two days off: the plan's 4.5 credits and 25.5 hours");
		eq(R.weekTargets(4), { days: 3, credits: 4.5, hours: 25.5 }, "more days off never go below 3 days' worth");

		const v = (f) => R.baseVerdict({ daysOff: 0, silentDays: 0, hours: 50, workedDays: 5, credits: 8, ...f });
		eq([v({}).verdict, v({}).reason], ["met", "targets-reached"], "both targets reached: met");
		eq(v({ credits: 7.49 }).verdict, "missed", "credits short: missed");
		eq(v({ hours: 42.49 }).verdict, "missed", "hours short: missed, on the unrounded value");
		eq([v({ daysOff: 7 }).verdict, v({ daysOff: 7 }).reason], ["frozen", "all-days-off"], "a week fully off: frozen");
		eq([v({ hours: null }).verdict, v({ hours: null }).reason], ["frozen", "no-hours-data"], "no hours data: frozen");
		eq([v({ workedDays: 2 }).verdict, v({ workedDays: 2 }).reason], ["frozen", "under-3-worked-days"], "under 3 worked days: frozen, even with the targets reached");
		eq(v({ workedDays: 3 }).verdict, "met", "exactly 3 worked days can be met");
		eq([v({ silentDays: 3 }).verdict, v({ silentDays: 3 }).reason], ["pending", "eld-silent"], "silent more than a third of the week: pending");
		eq(v({ silentDays: 2 }).verdict, "met", "silent 2 days of 7 is not more than a third");
		eq(v({ silentDays: 3, hours: null }).verdict, "pending", "silence beats 'no hours data'");
		eq(v({ silentDays: 3, workedDays: 0 }).verdict, "pending", "silence beats 'under 3 worked days'");
		eq(v({ daysOff: 7, silentDays: 7 }).verdict, "frozen", "a week fully on approved days off is frozen, silent or not");

		const row = (verdict, more = {}) => ({ verdict, credits: 7, hours: 45, target_credits: 7.5, target_hours: 42.5, ...more });
		const kind = (k, more = {}) => ({ kind: k, ...more });
		eq(R.effectiveVerdict(row("missed"), []).verdict, "missed", "no decisions: the locked verdict");
		eq(R.effectiveVerdict(row("missed"), [kind("hos_stop")]).verdict, "excused", "an hours-of-service stop excuses a missed week");
		eq(R.effectiveVerdict(row("missed"), [kind("hos_stop"), kind("hos_decline")]).verdict, "missed", "...unless declined");
		eq(R.effectiveVerdict(row("met"), [kind("hos_stop")]).verdict, "met", "...and a met week stays met");
		eq(R.effectiveVerdict(row("pending"), [kind("hos_stop")]).verdict, "pending", "...and a pending week waits for a Super Admin");
		eq(R.effectiveVerdict(row("frozen"), [kind("hos_stop")]).verdict, "frozen", "...and a frozen week stays frozen");
		eq(R.effectiveVerdict(row("missed"), [kind("proposal", { verdict: "excused" })]).verdict, "missed", "a proposal changes nothing");
		eq(R.effectiveVerdict(row("pending"), [kind("office_verdict", { verdict: "missed" })]).verdict, "missed", "a Super Admin decides a pending week");
		eq(R.effectiveVerdict(row("missed"), [kind("office_verdict", { verdict: "excused" }), kind("office_verdict", { verdict: "missed" })]).verdict, "missed", "the latest office decision wins");
		eq(R.effectiveVerdict(row("missed"), [kind("pickup_credit")]).verdict, "met", "an office pickup credit can complete a week it was all that was short of");
		eq(R.effectiveVerdict(row("missed", { hours: 40 }), [kind("pickup_credit")]).verdict, "missed", "...never one short of hours");
		eq(R.effectiveVerdict(row("frozen"), [kind("pickup_credit")]).verdict, "frozen", "...and never a frozen one");
		eq(R.effectiveVerdict(row("pending"), [kind("pickup_credit")]).verdict, "pending", "...or a pending one");
		ok(!R.OFFICE_VERDICTS.includes("met") && !R.PROPOSAL_VERDICTS.includes("met"), "the office can never declare a week met");

		const walk = (...verdicts) => R.walkStreak(verdicts.map((verdict, i) => ({ weekStart: `w${i}`, eligible: true, verdict })));
		eq(walk("met", "met").streak, 2, "met weeks add up");
		eq(walk("met", "met", "missed", "met").streak, 1, "a missed week resets");
		eq(walk("met", "frozen", "met").streak, 2, "a frozen week neither gains nor resets");
		eq(walk("met", "excused", "met").streak, 2, "an excused week neither gains nor resets");
		eq(walk("met", "pending", "met").streak, 2, "a pending week neither gains nor resets");
		eq(walk("met", "pending").unresolved, ["w1"], "...and is listed until decided");
		eq(R.walkStreak([{ weekStart: "a", eligible: false, verdict: "met" }, { weekStart: "b", eligible: true, verdict: "met" }]).streak, 1, "a row that isn't eligible counts for nothing");
		eq(walk(...Array(12).fill("met")).quarterly, [], "12 met weeks flag nothing");
		eq(walk(...Array(13).fill("met")).quarterly, ["w12"], "13 flag the quarterly bonus");
		eq(walk(...Array(26).fill("met")).quarterly, ["w12", "w25"], "...and every 13 after");
		const broken = walk(...Array(12).fill("met"), "missed", "met");
		eq(broken.quarterly, [], "a missed week breaks the 13");
		eq(walk(...Array(6).fill("met"), "frozen", "excused", ...Array(7).fill("met")).quarterly.length, 1, "frozen and excused weeks don't break it, and don't count toward it");

		const tier = (streak, unresolved = []) => R.tierEarned({ streak, unresolved });
		eq([2, 3, 5, 6, 40].map((s) => tier(s).level), [0, 1, 1, 2, 2], "3 weeks is tier 1, 6 tier 2, and that is the cap");
		eq(tier(6, ["w"]), { level: null, held: "pending-week" }, "an undecided pending week holds the tier: silence can't protect it");
		eq([R.upliftPerPaidDayCents(1, 30000), R.upliftPerPaidDayCents(2, 30000)], [2500, 5000], "a $300 driver gains $25, then $50");
		eq([R.upliftPerPaidDayCents(1, 25000), R.upliftPerPaidDayCents(2, 25000)], [7500, 10000], "a $250 driver gains $75, then $100");
		eq([R.upliftPerPaidDayCents(1, 35000), R.upliftPerPaidDayCents(2, 35000), R.upliftPerPaidDayCents(2, 40000)], [0, 0, 0], "a driver at or above the tier gains nothing, and is never lowered");
		eq([R.upliftPerPaidDayCents(0, 30000), R.upliftPerPaidDayCents(null, 30000), R.upliftPerPaidDayCents(1, null)], [0, null, null], "no tier is 0; a held tier or no rate on file is unknown");
		eq(["frozen", "pending", "excused", "met", "missed"].map(R.needsOfficeApproval), [true, true, true, false, false], "frozen, pending and excused weeks pay no uplift without the office");

		const week = (day) => {
			const [y, m, d] = day.split("-").map(Number);
			const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
			const start = addDays(day, -((dow + 1) % 7));
			return { weekStart: start, weekEnd: addDays(start, 6) };
		};
		eq(["2026-11-11", "2026-11-13", "2026-11-14", "2026-11-15"].map((x) => R.firstFullWeekAfter(x, week)), ["2026-11-14", "2026-11-14", "2026-11-21", "2026-11-21"], "the first full week after a day starts strictly after it");
		eq(R.streakStartWeek({ goDay: "", switchOnDay: "2026-11-04" }, week), "", "no go, no start");
		eq(R.streakStartWeek({ goDay: "2026-10-01", switchOnDay: "2026-11-04" }, week), "2026-11-07", "a go before the switch-on starts after the switch-on");
		eq(R.streakStartWeek({ goDay: "2026-11-18", switchOnDay: "2026-11-04" }, week), "2026-11-21", "a later go starts after the go");
		eq(R.lockMomentMs("2026-11-07"), Date.parse("2026-11-14T11:00:00Z"), "the lock is Sat 06:00 ET in winter");
		eq(R.lockMomentMs("2026-10-17"), Date.parse("2026-10-24T10:00:00Z"), "...and in summer");
		eq(R.lockableWeek(Date.parse("2026-11-14T10:59:59Z"), week), "2026-10-31", "a minute before: the week before");
		eq(R.lockableWeek(Date.parse("2026-11-14T11:00:00Z"), week), "2026-11-07", "at the moment: this week");
		eq(R.lockableWeek(Date.parse("2026-11-20T15:00:00Z"), week), "2026-11-07", "still that week mid-way through the next");

		eq(["", null, undefined, "true", "yes", "2026-13-01", "2026-02-30", "11/05/2026"].map(R.parseGoDay), Array(8).fill(""), "anything but a real calendar day is no go");
		eq(R.parseGoDay(" 2026-11-05 "), "2026-11-05", "a real day is one");
		eq(["", null, "abc", "0", "-5", "1,500", "15.5"].map(R.parseBonusCents), Array(7).fill(null), "anything but an amount is no bonus");
		eq([R.parseBonusCents("1500"), R.parseBonusCents("1500.50")], [150000, 150050], "an amount reads in cents");
		eq([R.bonusText(null), R.bonusText(150000)], ["Quarterly bonus due: amount not set", "Quarterly bonus due: $1500.00"], "the report's words");
	});

	// ── §2 ──────────────────────────────────────────────────────────────────
	await section("2 the flag: off, nothing exists", async () => {
		need();
		for (const raw of [undefined, "", "false", "TRUE", "True", "1", "yes", "on", " true", "true "]) {
			const w = await makeWorld(raw === undefined ? {} : { DRIVER_PERFORMANCE_WEEKS_ENABLED: raw });
			eq(w.handle.enabled, false, `${JSON.stringify(raw)} leaves it off`);
			eq(tableNames(w.db), [], "...with no table");
			eq(count(w.db, "SELECT COUNT(*) AS n FROM server_state WHERE key = ?", routes.SWITCH_ON_KEY), 0, "...and no switch-on recorded");
			eq(await w.handle.lockDue(rules.lockMomentMs(weekN(1))), { skipped: "off" }, "...and the lock does nothing");
			await w.close();
		}
		const off = await makeWorld({});
		const ROUTES = [
			["GET", "/api/admin/driver-performance/weeks"],
			["POST", `/api/admin/driver-performance/weeks/1/${WEEK0}/decision`],
			["POST", `/api/admin/driver-performance/weeks/1/${WEEK0}/hos-decline`],
			["POST", `/api/admin/driver-performance/weeks/1/${WEEK0}/pickup-credit`],
			["POST", `/api/driver-performance/weeks/1/${WEEK0}/proposal`],
			["POST", "/api/driver/me/performance/hos-stop"],
		];
		const unknown = (method) => off.call(method, "/api/made-up/unknown/path", USERS.admin);
		for (const [method, p] of ROUTES) {
			const want = await unknown(method);
			for (const user of [USERS.admin, USERS.ada, null]) {
				const got = await off.call(method, p, user, method === "POST" ? { verdict: "excused", reason: "made up" } : undefined);
				eq(got.status, want.status, `off, ${method} ${p} (${user ? user.role : "signed out"}) answers like an unknown path`);
				eq(got.text.replace(p, "P"), want.text.replace("/api/made-up/unknown/path", "P"), "...byte for byte");
			}
		}
		eq(tableNames(off.db), [], "and the requests made no table");
		await off.close();

		// No timer: a rate limiter's store starts one, so off must not even build one.
		const timers = [];
		const realInterval = global.setInterval;
		const realTimeout = global.setTimeout;
		global.setInterval = (...a) => { timers.push("interval"); return realInterval(...a); };
		global.setTimeout = (...a) => { timers.push("timeout"); return realTimeout(...a); };
		const registered = [];
		const fakeApp = { get: (p) => registered.push(p), post: (p) => registered.push(p) };
		const stubs = Object.fromEntries(["requireRole", "logAudit", "getJobTrackingCached", "liveJobTrackingView", "invoiceWeekColumns", "invoiceWeekVerdict",
			"invoiceCompletionDay", "loadKeySet", "getDeletedLoadIds", "normalizeDriverName", "getWeekRange", "appTodayKey", "buildDriverAtResolver",
			"buildEldDeviceResolver", "driverAvailabilityByName", "agreedRateOn", "now"].map((n) => [n, () => () => {}]));
		const Database = require("better-sqlite3");
		const empty = new Database(":memory:");
		let mounted = null;
		const silent = { log() {}, error() {} };
		try {
			mounted = routes.mount(fakeApp, { ...stubs, db: empty, enabled: false, logger: silent });
		} finally {
			global.setInterval = realInterval;
			global.setTimeout = realTimeout;
		}
		eq(timers, [], "off, mounting starts no timer of any kind");
		eq(empty.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n, 0, "...and touches an empty database not at all");
		eq(mounted.enabled, false, "...and says it is off");
		eq(registered.length, 6, "the routes stay registered, so the route snapshot shows what a request can reach");
		empty.close();

		lifted();
		const decl = SRC.split("\n");
		const at = decl.findIndex((l) => l.startsWith("const driverPerformanceWeeks = "));
		ok(at > 0, "server.js declares it once");
		eq(decl.filter((l) => l.startsWith("const driverPerformanceWeeks = ")).length, 1, "...exactly once");
		ok(decl.slice(at, at + 12).some((l) => l.trim() === 'enabled: process.env.DRIVER_PERFORMANCE_WEEKS_ENABLED === "true",'), "the flag's shape is exactly \"true\"");
		ok(at < decl.findIndex((l) => l.startsWith('app.get("*"')), "...and it mounts above the catch-all");
		const job = decl.findIndex((l) => l === 'if (driverPerformanceWeeks.enabled && startsJob("driver performance week lock")) {');
		ok(job > at, "the timer starts only when on, and asks startsJob (no import or replica runs it)");
		eq(decl.slice(job, job + 4).map((l) => l.trim()), [
			'if (driverPerformanceWeeks.enabled && startsJob("driver performance week lock")) {',
			"setTimeout(() => { driverPerformanceWeeks.lockDue(); }, 13 * 60 * 1000);",
			"setInterval(() => { driverPerformanceWeeks.lockDue(); }, 15 * 60 * 1000);",
			"}",
		], "...and does nothing else");

		const template = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
		ok(/^# DRIVER_PERFORMANCE_WEEKS_ENABLED=false$/m.test(template), "the settings template lists the flag, off");
		ok(/^# DRIVER_PERFORMANCE_GO_DAY=$/m.test(template), "...the go, empty");
		ok(/^# DRIVER_PERFORMANCE_QUARTERLY_BONUS=$/m.test(template), "...and the bonus amount, empty");
		const replica = require(path.join(ROOT, "lib", "replica-rules.js"));
		eq(replica.enableRefusal("DRIVER_PERFORMANCE_WEEKS_ENABLED"), null, "a replica task may switch it on: its own database only");
		const snapshot = fs.readFileSync(path.join(__dirname, "fixtures", "route-snapshot.txt"), "utf8");
		for (const [method, p] of [
			["GET", "/api/admin/driver-performance/weeks"],
			["POST", "/api/admin/driver-performance/weeks/:directoryId/:weekStart/decision"],
			["POST", "/api/admin/driver-performance/weeks/:directoryId/:weekStart/hos-decline"],
			["POST", "/api/admin/driver-performance/weeks/:directoryId/:weekStart/pickup-credit"],
			["POST", "/api/driver-performance/weeks/:directoryId/:weekStart/proposal"],
			["POST", "/api/driver/me/performance/hos-stop"],
		]) ok(snapshot.includes(`${method} ${p} · performanceWeeksFlagGate`), `the route snapshot shows ${method} ${p}, behind the flag gate first`);
	});

	// ── §3 ──────────────────────────────────────────────────────────────────
	await section("3 the start: no go, no streak; no backfill", async () => {
		need();
		{
			const w = await makeWorld();
			for (const n of [0, 1, 2, 3]) { w.work("Ada Quill", weekN(n)); await w.lock(weekN(n)); }
			eq(w.rowOf("Ada Quill", weekN(3)).verdict, "met", "with the go empty the rows still lock, for the office to read");
			eq(count(w.db, "SELECT COUNT(*) AS n FROM performance_weeks WHERE streak_eligible = 1"), 0, "...and not one counts toward a streak");
			const rep = await w.report(weekN(3));
			const ada = w.driverIn(rep, "Ada Quill");
			eq([ada.streak, ada.tierForNewWeek.level, ada.countsTowardStreak], [0, 0, false], "four met weeks with no go: streak 0, no tier");
			eq([rep.go.set, rep.go.day, rep.go.firstStreakWeek], [false, null, null], "the report says the go isn't set");
			ok(/have not started/.test(rep.go.text), "...in words");
			eq(rep.tierReading.isOwnersAnswer, false, "and that the tier reading isn't the owner's answer");
			await w.close();
		}
		for (const bad of ["true", "yes", "2026-13-01"]) {
			const w = await makeWorld({ ...GO, DRIVER_PERFORMANCE_GO_DAY: bad });
			w.work("Ada Quill", WEEK0);
			await w.lock(WEEK0);
			eq(w.rowOf("Ada Quill", WEEK0).streak_eligible, 0, `a go of ${JSON.stringify(bad)} is no go`);
			await w.close();
		}
		{
			// Facts from before the switch-on, and weeks closed before it: never written.
			const w = await makeWorld(GO);
			w.work("Ada Quill", "2026-10-24");
			w.work("Ada Quill", "2026-10-31");
			w.rollupThrough(Date.parse("2026-12-30T00:00:00Z"));
			eq((await w.handle.lockDue(SWITCH_ON_MS)).skipped, "before-first-full-week", "at the switch-on, a closed week isn't written");
			eq((await w.handle.lockDue(rules.lockMomentMs("2026-10-31"))).skipped, "before-first-full-week", "nor the week the switch-on fell in, once it closes");
			eq(count(w.db, "SELECT COUNT(*) AS n FROM performance_weeks"), 0, "...so no row exists");
			w.work("Ada Quill", WEEK0);
			eq((await w.lock(WEEK0)).locked, WEEK0, "the first full week after the switch-on is the first written");
			eq(w.db.prepare("SELECT DISTINCT week_start AS w FROM performance_weeks").all().map((r) => r.w), [WEEK0], "...and the only one");
			await w.close();
		}
		{
			// A go given later, back-dated: rows locked before it stay out.
			const w = await makeWorld();
			for (const n of [0, 1]) { w.work("Ada Quill", weekN(n)); await w.lock(weekN(n)); }
			await w.close();
			const later = await makeWorld({ ...GO, DRIVER_PERFORMANCE_GO_DAY: "2026-11-01" }, { nowMs: rules.lockMomentMs(weekN(1)) + 1000, db: w.db });
			eq(JSON.parse(later.db.prepare("SELECT value FROM server_state WHERE key = ?").get(routes.SWITCH_ON_KEY).value).day, "2026-11-04", "a restart keeps the first switch-on day");
			for (const n of [2, 3]) { later.work("Ada Quill", weekN(n)); await later.lock(weekN(n)); }
			eq(later.db.prepare("SELECT streak_eligible AS e FROM performance_weeks WHERE directory_id = 1 ORDER BY week_start").all().map((r) => r.e), [0, 0, 1, 1], "rows locked before the go stay out, even with the go back-dated");
			eq(later.driverIn(await later.report(weekN(3)), "Ada Quill").streak, 2, "...so the streak is 2, not 4");
			await later.close();
		}
		for (const [go, label] of [["2026-11-18", "a Wednesday"], ["2026-11-14", "a Saturday"]]) {
			const w = await makeWorld({ ...GO, DRIVER_PERFORMANCE_GO_DAY: go });
			for (const n of [0, 1, 2]) { w.work("Ada Quill", weekN(n)); await w.lock(weekN(n)); }
			eq(w.db.prepare("SELECT streak_eligible AS e FROM performance_weeks WHERE directory_id = 1 ORDER BY week_start").all().map((r) => r.e), [0, 0, 1], `a go on ${label}: the week it fell in doesn't count; the next full week does`);
			await w.close();
		}
	});

	// ── §4 ──────────────────────────────────────────────────────────────────
	await section("4 the lock: Sat 06:00 ET, once, and it stays", async () => {
		need();
		const moment = rules.lockMomentMs(WEEK0);
		{
			const w = await makeWorld(GO);
			w.work("Ada Quill", WEEK0);
			w.rollupThrough(moment);
			w.clock.ms = moment - 1000;
			await w.handle.lockDue(w.clock.ms);
			eq(count(w.db, "SELECT COUNT(*) AS n FROM performance_weeks"), 0, "a second before Sat 06:00 ET nothing locks");
			eq((await w.report(WEEK0)).week.state, "not-closed", "...and the report says so");
			w.clock.ms = moment;
			eq((await w.handle.lockDue(moment)).locked, WEEK0, "at Sat 06:00 ET the week locks");
			ok(count(w.db, "SELECT COUNT(*) AS n FROM performance_weeks") > 0, "...with rows");
			const first = w.rowOf("Ada Quill", WEEK0);
			eq([first.verdict, first.credits, first.hours, first.rei], ["met", 7.5, 42.5, 100], "...and the figures");
			eq((await w.handle.lockDue(moment + 900000)).skipped, "locked", "a later tick does nothing");

			// Everything a correction could be, after the lock.
			w.rows.find((r) => r["Load ID"] === `L1-${WEEK0}-0`)["Job Status"] = "Cancelled";
			w.eld(1, 1, addDays(WEEK0, 2), 3);
			w.rollupThrough(moment + 2000000);
			await w.handle.lockDue(moment + 2000000);
			eq(w.rowOf("Ada Quill", WEEK0), first, "a cancelled load and an ELD backfill after the lock change nothing in the row");
			const rep = await w.report(WEEK0);
			const ada = w.driverIn(rep, "Ada Quill");
			eq([ada.lockedVerdict, ada.verdict, ada.credits], ["met", "met", 7.5], "the report still reads the week as it locked");
			ok(rep.correctionsChecked, "...and checks it against today's facts");
			ok(ada.notes.some((n) => n.kind === "credits" && n.locked === 7.5 && n.now === 6), "...showing the cancelled load as a note");
			ok(ada.notes.some((n) => n.kind === "hours" && n.locked === 42.5), "...and the backfill as a note");
			ok(ada.notes.some((n) => n.kind === "verdict" && n.now === "missed"), "...and what the verdict would be now");

			for (const [sql, label] of [
				["UPDATE performance_weeks SET verdict = 'met'", "a locked row can't be updated"],
				["DELETE FROM performance_weeks", "...or deleted"],
				["DELETE FROM performance_week_runs", "a week's run can't be deleted, which would re-open the week"],
				["UPDATE performance_week_runs SET rows_written = 0", "...or changed"],
			]) {
				let refused = false;
				try { w.db.exec(sql); } catch (err) { refused = /never/.test(err.message); }
				ok(refused, label);
			}
			await w.decide("Ada Quill", WEEK0, "excused", "Weather closure on the route");
			for (const [sql, label] of [
				["UPDATE performance_week_decisions SET verdict = 'missed'", "a recorded decision can't be rewritten"],
				["DELETE FROM performance_week_decisions", "...or deleted"],
			]) {
				let refused = false;
				try { w.db.exec(sql); } catch (err) { refused = /never/.test(err.message); }
				ok(refused, label);
			}
			w.db.prepare("INSERT INTO drivers_directory (id, driver_name, status, pay_type, pay_daily, user_id) VALUES (50, 'Lou Grant', 'active', 'fixed', 300, 60)").run();
			await w.handle.lockDue(moment + 3000000);
			eq(count(w.db, "SELECT COUNT(*) AS n FROM performance_weeks WHERE directory_id = 50"), 0, "a driver added later joins no locked week");
			await w.close();
		}
		{
			const w = await makeWorld(GO);
			w.work("Ada Quill", WEEK0);
			w.rollupThrough(rules.weekCloseMs(WEEK0) - 60000);
			w.clock.ms = moment;
			eq((await w.handle.lockDue(moment)).skipped, "rollup-not-covered", "a rollup that hasn't covered Friday night holds the lock");
			eq((await w.report(WEEK0)).week.state, "held-for-rollup", "...and the report says so");
			const asked = await w.report();
			eq(asked.latestClosedWeek, { start: WEEK0, state: "held-for-rollup" }, "...even when that isn't the week asked for, so a held lock can't go unseen");
			w.rollupThrough(rules.weekCloseMs(WEEK0));
			eq((await w.handle.lockDue(moment + 60000)).locked, WEEK0, "a rollup that has covered it lets it lock on the next tick");
			await w.close();
		}
		{
			const w = await makeWorld(GO);
			w.work("Ada Quill", WEEK0);
			w.rollupThrough(moment);
			w.clock.ms = moment;
			w.sheetDown = true;
			eq((await w.handle.lockDue(moment)).skipped, "sheet-unreadable", "Job Tracking down holds the lock, rather than locking short");
			eq(count(w.db, "SELECT COUNT(*) AS n FROM performance_weeks"), 0, "...with nothing written");
			w.sheetDown = false;
			eq((await w.handle.lockDue(moment + 60000)).locked, WEEK0, "...and it locks once the sheet reads");
			await w.close();
		}
		{
			// Off and on again, or a long outage: the gap stays unwritten, and neutral.
			const w = await makeWorld(GO);
			w.work("Ada Quill", WEEK0);
			await w.lock(WEEK0);
			w.work("Ada Quill", weekN(1));
			w.work("Ada Quill", weekN(2));
			w.work("Ada Quill", weekN(3));
			await w.lock(weekN(3));
			eq(w.db.prepare("SELECT week_start AS w FROM performance_week_runs ORDER BY w").all().map((r) => r.w), [WEEK0, weekN(3)], "only the latest closed week locks: weeks missed in between are never backfilled");
			eq(w.driverIn(await w.report(weekN(3)), "Ada Quill").streak, 2, "...and the gap neither gains nor resets");
			await w.close();
		}
	});

	// ── §5 ──────────────────────────────────────────────────────────────────
	await section("5 verdicts from gathered facts; unplugging an ELD can't protect a streak", async () => {
		need();
		const one = async (setup, who = "Ada Quill") => {
			const w = await makeWorld(GO);
			setup(w);
			await w.lock(WEEK0);
			const row = w.rowOf(who, WEEK0);
			await w.close();
			return row;
		};
		const d = (i) => addDays(WEEK0, i);
		let r = await one((w) => w.work("Ada Quill", WEEK0));
		eq([r.verdict, r.reason, r.credits, r.hours, r.worked_days, r.silent_days, r.days_off], ["met", "targets-reached", 7.5, 42.5, 5, 0, 0], "5 loads and 42.5 hours over 5 days: met");
		eq(JSON.parse(r.source_mix).geofence, 5, "each pickup's source is kept");
		r = await one((w) => w.work("Ada Quill", WEEK0, { loads: 4 }));
		eq([r.verdict, r.credits], ["missed", 6], "4 loads: 6 credits, missed");
		r = await one((w) => w.work("Ada Quill", WEEK0, { hours: 8.494 }));
		eq(r.verdict, "missed", "42.47 hours is missed: the unrounded value qualifies");
		eq(perf.reiDisplay(r.rei, false), 99.9, "...and its score reads 99.9, never 100");

		r = await one((w) => { w.row("D-1", "Dee Stone", "Delivered", `${d(3)} 10:00`); }, "Dee Stone");
		eq([r.verdict, r.reason, r.hours], ["frozen", "no-hours-data", null], "a truck with no device: frozen, hours null, never 0");
		r = await one((w) => { for (let i = 0; i < 7; i++) w.eld(8, 8, d(i), null, { basis: "no-hours-data", samples: 300 }); }, "Hal Briar");
		eq([r.verdict, r.reason, r.hours], ["frozen", "no-hours-data", null], "a device whose source sends no hours (Linxup's shape): frozen, never missed");

		// The silent shapes.
		const reporting = (w, days, hours = 8.5) => { for (const i of days) w.eld(1, 1, d(i), hours); };
		r = await one((w) => { reporting(w, [0, 1, 2, 3, 4]); for (let i = 0; i < 5; i++) w.load(`Q-${i}`, "Ada Quill", d(i)); });
		eq([r.silent_days, r.verdict], [2, "met"], "silent on 2 days of 7, targets reached: met");
		r = await one((w) => { reporting(w, [0, 1, 2, 3, 4], 2); });
		eq([r.silent_days, r.verdict], [2, "missed"], "silent on 2 days of 7, hours short: missed, with no protection");
		r = await one((w) => { reporting(w, [2, 3, 4, 5]); for (let i = 0; i < 5; i++) w.load(`S-${i}`, "Ada Quill", d(2 + (i % 4))); });
		eq([r.silent_days, r.verdict, r.reason], [3, "pending", "eld-silent"], "silent on 3 days: pending, even with the targets in reach");
		r = await one(() => {});
		eq([r.silent_days, r.verdict, r.reason, r.hours], [7, "pending", "eld-silent", null], "a linked device silent all week: pending, not frozen, though hours are null");
		r = await one((w) => { w.hist("U-1", "manual", "In Transit", `${d(2)}T14:00:00Z`, "Ada Quill"); w.row("U-1", "Ada Quill", "Delivered", `${d(2)} 18:00`); });
		eq([r.verdict, r.worked_days], ["pending", 1], "unplugged with one load: pending, not frozen for under 3 worked days");
		{
			// A device dead so long a pickup tap counts again (the 14-day lookback) is still linked.
			const w = await makeWorld(GO);
			for (const n of [0, 1, 2, 3]) await w.lock(weekN(n));
			eq(w.db.prepare("SELECT verdict AS v FROM performance_weeks WHERE directory_id = 1 ORDER BY week_start").all().map((x) => x.v), Array(4).fill("pending"), "unplugged for weeks: every week reads pending, never 'no ELD' and frozen");
			await w.close();
		}
		r = await one((w) => { for (let i = 0; i < 7; i++) w.eld(1, 1, d(i), 0); });
		eq([r.verdict, r.reason, r.worked_days, r.hours], ["frozen", "under-3-worked-days", 0, 0], "a parked truck that reports: frozen for under 3 worked days, hours a true 0");
		r = await one((w) => { for (let i = 0; i < 7; i++) w.eld(1, 1, d(i), i < 2 ? 11 : 0); for (let i = 0; i < 5; i++) w.load(`F-${i}`, "Ada Quill", d(0)); });
		eq([r.verdict, r.worked_days], ["frozen", 2], "...and a lot of work on 2 worked days is frozen, not met");

		// Days off.
		const off = (w, from, to, status = "approved", cancelled = null) => w.db.prepare(`INSERT INTO driver_availability
			(directory_id, driver_name, kind, from_date, to_date, created_by, created_at, request_status, cancelled_at, source)
			VALUES (1, 'Ada Quill', 'off_duty', ?, ?, 'x', '2026-11-01T00:00:00Z', ?, ?, 'staff')`).run(from, to, status, cancelled);
		const threeDays = (w) => {
			for (const i of [0, 1, 5, 6]) w.eld(1, 1, d(i), 0);
			for (const i of [2, 3, 4]) w.eld(1, 1, d(i), 8.5);
			for (let i = 0; i < 3; i++) w.load(`T-${i}`, "Ada Quill", d(2 + i));
		};
		r = await one((w) => { threeDays(w); off(w, d(0), d(1)); });
		eq([r.days_off, r.target_credits, r.target_hours, r.verdict], [2, 4.5, 25.5, "met"], "2 approved days off: the target is 4.5 and 25.5, and 3 days' work meets it");
		for (const [label, args] of [["waiting", ["requested"]], ["declined", ["declined"]], ["cancelled", ["approved", "2026-11-02T00:00:00Z"]]]) {
			r = await one((w) => { threeDays(w); off(w, d(0), d(1), ...args); });
			eq([r.days_off, r.target_credits, r.target_hours, r.verdict], [0, 7.5, 42.5, "missed"], `a ${label} request lowers nothing`);
		}
		r = await one((w) => off(w, WEEK0, d(6)));
		eq([r.days_off, r.verdict, r.reason], [7, "frozen", "all-days-off"], "a week fully on approved days off: frozen");
		r = await one((w) => { for (const i of [2, 3, 4]) w.eld(1, 1, d(i), 8.5); off(w, d(0), d(1)); off(w, d(5), d(6)); });
		eq([r.silent_days, r.days_off], [0, 4], "an approved day off is never a silent day");
		r = await one((w) => { w.work("Ada Quill", WEEK0, { hours: 8 }); w.eld(1, 1, d(0), 9); off(w, d(0), d(0)); });
		eq(r.hours, 40, "driving on an approved day off isn't credited to him: a cover driver's or the shop's");
		r = await one((w) => { w.eld(1, 1, d(2), 15); w.eld(1, 1, d(3), 15); w.eld(1, 1, d(4), 15); for (const i of [0, 1, 5, 6]) w.eld(1, 1, d(i), 0); });
		eq(r.hours, 33, "a truck-local day credits at most 11 hours");
		r = await one((w) => { w.eld(1, 1, d(2), 8); w.eld(1, 7, d(2), 2); for (const i of [0, 1, 3, 4, 5, 6]) w.eld(1, 1, d(i), 0); });
		eq(r.hours, 8, "hours on a truck that isn't countable (a test or retired unit) aren't credited");

		// Who is in.
		const w = await makeWorld(GO);
		await w.lock(WEEK0);
		const ids = w.db.prepare("SELECT directory_id AS id FROM performance_weeks ORDER BY id").all().map((x) => x.id);
		eq(ids, [1, 2, 3, 4, 8, 9], "day-rate active company drivers only: no percentage driver, owner-operator or pending driver");
		eq([w.rowOf("Ivy Lane", WEEK0).verdict, w.rowOf("Ivy Lane", WEEK0).reason], ["frozen", "no-hours-data"], "an active driver with no truck: frozen");
		await w.close();
	});

	// ── §6 ──────────────────────────────────────────────────────────────────
	await section("6 a pickup credit needs its current run, no errand and no twin", async () => {
		need();
		const d = (i) => addDays(WEEK0, i);
		const week = async (setup, driver = "Ada Quill") => {
			const w = await makeWorld(GO);
			for (let i = 0; i < 7; i++) w.eld(1, 1, d(i), 1);
			setup(w);
			await w.lock(WEEK0);
			const row = w.rowOf(driver, WEEK0);
			await w.close();
			return { row, mix: JSON.parse(row.source_mix), detail: JSON.parse(row.detail) };
		};
		const withheldOf = (x) => x.detail.withheld.map((y) => [y.load, y.reason]);

		let x = await week((w) => w.load("C-1", "Ada Quill", d(2)));
		eq([x.row.deliveries, x.row.pickups, x.row.credits, x.mix.geofence], [1, 1, 1.5, 1], "a clean load: 1.0 delivered, 0.5 picked up, by the geofence");

		x = await week((w) => {
			w.load("C-1", "Ada Quill", d(2));
			w.hist("C-1", "override", "Dispatched", `${d(2)}T15:00:00Z`, "dispatcher", { role: "Dispatcher" });
		});
		eq([x.row.pickups, withheldOf(x)], [0, [["c-1", "undone"]]], "a status staff moved back: the geofence row is outside the current run, so no credit");
		x = await week((w) => {
			w.hist("C-2", "geofence", "In Transit", `${d(2)}T14:00:00Z`, "Ada Quill");
			w.hist("C-2", "override", "Cancelled", `${d(2)}T15:00:00Z`, "dispatcher", { role: "Dispatcher" });
			w.hist("C-2", "override", "Dispatched", `${d(3)}T09:00:00Z`, "dispatcher", { role: "Dispatcher" });
			w.row("C-2", "Ada Quill", "Dispatched", "");
		});
		eq([x.row.pickups, withheldOf(x)], [0, [["c-2", "undone"]]], "cancelled and dispatched again: the old row doesn't count");
		x = await week((w) => {
			w.hist("C-3", "geofence", "In Transit", `${d(2)}T14:00:00Z`, "Ada Quill");
			w.hist("C-3", "override", "Dispatched", `${d(3)}T09:00:00Z`, "dispatcher", { role: "Dispatcher" });
			w.hist("C-3", "geofence", "In Transit", `${d(4)}T14:00:00Z`, "Ada Quill");
			w.row("C-3", "Ada Quill", "In Transit", "");
		});
		eq([x.row.pickups, x.detail.pickups.map((p) => p.day)], [1, [d(4)]], "a new departure in the current run counts, on its own day");

		x = await week((w) => {
			w.hist("E-1", "geofence", "In Transit", `${d(2)}T10:00:00Z`, "Ada Quill");
			w.row("E-1", "Ada Quill", "In Transit", "");
			w.hist("E-2", "geofence", "At Shipper", `${d(2)}T13:00:00Z`, "Ada Quill");
			w.hist("E-2", "geofence", "In Transit", `${d(2)}T14:00:00Z`, "Ada Quill");
			w.row("E-2", "Ada Quill", "Dispatched", "");
		});
		eq(withheldOf(x), [["e-2", "errand"]], "a queued load the truck passed while hauling another: an errand, no credit");
		eq(x.row.pickups, 1, "...and the load actually under way keeps its credit");
		x = await week((w) => {
			w.hist("E-3", "geofence", "At Shipper", `${d(2)}T13:00:00Z`, "Ada Quill", { hauling: 1 });
			w.hist("E-3", "geofence", "In Transit", `${d(2)}T14:00:00Z`, "Ada Quill");
			w.row("E-3", "Ada Quill", "Dispatched", "");
		});
		eq(withheldOf(x), [["e-3", "errand"]], "the recorder's own errand mark holds it too");

		x = await week((w) => {
			for (const id of ["T-1", "T-2"]) {
				w.hist(id, "geofence", "At Shipper", `${d(2)}T13:00:00Z`, "Ada Quill");
				w.hist(id, "geofence", "In Transit", `${d(2)}T14:00:00Z`, "Ada Quill");
				w.hist(id, "manual", "Delivered", `${d(2)}T20:00:00Z`, "Ada Quill");
				w.row(id, "Ada Quill", "Delivered", `${d(2)} 15:00`);
			}
		});
		eq([x.row.deliveries, x.row.pickups], [2, 0], "twins at one shipper in one visit: neither pickup is proof, both deliveries stand");
		// The first of two is clear of any errand at its own moments: only the twin test holds it.
		x = await week((w) => {
			w.hist("T-5", "geofence", "At Shipper", `${d(2)}T13:00:00Z`, "Ada Quill");
			w.hist("T-5", "geofence", "In Transit", `${d(2)}T13:05:00Z`, "Ada Quill");
			w.hist("T-5", "manual", "Delivered", `${d(2)}T13:08:00Z`, "Ada Quill");
			w.row("T-5", "Ada Quill", "Delivered", `${d(2)} 15:00`);
			w.hist("T-6", "geofence", "At Shipper", `${d(2)}T13:10:00Z`, "Ada Quill");
			w.hist("T-6", "geofence", "In Transit", `${d(2)}T13:15:00Z`, "Ada Quill");
			w.row("T-6", "Ada Quill", "In Transit", "");
		});
		eq(withheldOf(x), [["t-5", "twin"], ["t-6", "twin"]], "...each held by the twin test, whichever row came first");
		x = await week((w) => {
			w.load("T-3", "Ada Quill", d(2));
			w.load("T-4", "Ada Quill", d(3));
		});
		eq([x.row.pickups, withheldOf(x)], [2, []], "two loads at the same hour on different days are no twins");

		x = await week((w) => { w.load("R-1", "Ben Marsh", d(2)); w.rows.pop(); w.row("R-1", "Ada Quill", "Delivered", `${d(2)} 15:00`); });
		eq([x.row.pickups, withheldOf(x)], [0, [["r-1", "reassigned"]]], "a geofence row from before a reassign isn't the new driver's");

		x = await week((w) => { w.hist("P-1", "manual", "In Transit", `${d(2)}T14:00:00Z`, "Ada Quill"); w.row("P-1", "Ada Quill", "In Transit", ""); w.db.prepare("INSERT INTO eld_miles_daily (routemate_vehicle_id, local_day, truck_id, miles, samples) VALUES ('rm-1', ?, 1, 100, 40)").run(d(1)); });
		eq([x.row.pickups, withheldOf(x)], [0, [["p-1", "no-truck-record"]]], "a tap on a truck whose ELD reports earns nothing, and shows why");
		x = await week((w) => { w.hist("P-2", "manual", "In Transit", `${d(2)}T14:00:00Z`, "Dee Stone"); w.row("P-2", "Dee Stone", "Delivered", `${d(2)} 18:00`); }, "Dee Stone");
		eq([x.row.pickups, x.mix.driver], [1, 1], "a tap on a truck with no ELD counts, as the driver's");
		x = await week((w) => { w.hist("P-3", "override", "In Transit", `${d(2)}T14:00:00Z`, "dispatcher", { role: "Dispatcher" }); w.row("P-3", "Dee Stone", "Delivered", `${d(2)} 18:00`); }, "Dee Stone");
		eq([x.row.pickups, x.mix.dispatch], [1, 1], "...and a dispatcher's as dispatch's");

		const depart = (w, load, ms, truck = 1) => w.db.prepare("INSERT INTO load_eld_miles (load_id, truck_id, pickup_depart_ms) VALUES (?, ?, ?)").run(load, truck, ms);
		x = await week((w) => { depart(w, "z-1", Date.parse(`${d(2)}T14:00:00Z`)); w.row("Z-1", "Ada Quill", "Delivered", `${d(2)} 18:00`); });
		eq([x.row.pickups, x.mix.eld], [1, 1], "the ELD's own departure credits a pickup");
		x = await week((w) => { depart(w, "z-2", Date.parse(`${d(2)}T14:00:00Z`), 2); w.row("Z-2", "Ada Quill", "Delivered", `${d(2)} 18:00`); });
		eq(withheldOf(x), [["z-2", "reassigned"]], "...but not one from another driver's truck");
		x = await week((w) => {
			depart(w, "z-3", Date.parse(`${d(2)}T14:00:00Z`));
			w.hist("Z-3", "override", "Dispatched", `${d(3)}T09:00:00Z`, "dispatcher", { role: "Dispatcher" });
			w.row("Z-3", "Ada Quill", "Dispatched", "");
		});
		eq(withheldOf(x), [["z-3", "undone"]], "...or one from before the current run");
		x = await week((w) => {
			depart(w, "z-4", Date.parse(`${d(2)}T14:00:00Z`));
			w.row("Z-4", "Ada Quill", "Dispatched", "");
			w.hist("Z-5", "geofence", "In Transit", `${d(2)}T10:00:00Z`, "Ada Quill");
			w.row("Z-5", "Ada Quill", "In Transit", "");
		});
		eq(withheldOf(x), [["z-4", "errand"]], "...or one made while another of his loads was under way");
		x = await week((w) => {
			depart(w, "z-6", Date.parse(`${d(2)}T14:00:00Z`));
			w.row("Z-6", "Ada Quill", "Dispatched", "");
			w.hist("Z-7", "geofence", "At Shipper", `${d(2)}T14:30:00Z`, "Ada Quill");
			w.row("Z-7", "Ada Quill", "Dispatched", "");
		});
		eq(withheldOf(x), [["z-6", "twin"]], "...or one with a twin at the same visit");

		x = await week((w) => { w.load("X-1", "Ada Quill", d(2)); w.rows[w.rows.length - 1]["Job Status"] = "Cancelled"; });
		eq([x.row.deliveries, x.row.pickups], [0, 0], "a cancelled load earns nothing");
		x = await week((w) => { w.load("X-2", "Ada Quill", d(2)); w.db.prepare("INSERT INTO deleted_loads (load_id) VALUES ('x-2')").run(); });
		eq([x.row.deliveries, x.row.pickups], [0, 0], "a soft-deleted load earns nothing");
		x = await week((w) => { w.load("X-3", "Ada Quill", d(2)); w.row("#X-3", "Ada Quill", "Delivered", `${d(2)} 15:00`); });
		eq([x.row.deliveries, x.row.pickups], [1, 1], "a load spelled two ways counts once");

		// A Pacific driver's Friday night, by its Eastern instant.
		x = await week((w) => {
			w.hist("N-1", "geofence", "In Transit", "2026-11-14T04:30:00Z", "Ada Quill"); // Fri 23:30 ET, 20:30 PT
			w.row("N-1", "Ada Quill", "In Transit", "");
			w.hist("N-2", "geofence", "In Transit", "2026-11-14T05:30:00Z", "Ada Quill"); // Sat 00:30 ET, Fri 21:30 PT
			w.row("N-2", "Ada Quill", "Dispatched", "");
		});
		eq(x.detail.pickups.map((p) => p.load), ["n-1"], "Fri 23:30 ET counts in the week; Sat 00:30 ET doesn't, though both are Friday night in Pacific");
	});

	// ── §7 ──────────────────────────────────────────────────────────────────
	await section("7 decisions: excuses, freezes, proposals, the automatic excuse, the office's credit", async () => {
		need();
		const missedWeek = async (who = "Ada Quill", env = GO) => {
			const w = await makeWorld(env);
			w.work(who, WEEK0, { loads: 4 });
			await w.lock(WEEK0);
			w.clock.ms = rules.lockMomentMs(WEEK0) + 3600000;
			return w;
		};
		const audits = (w, action) => w.db.prepare("SELECT username, role, action, entity_id, details FROM audit_trail WHERE action = ?").all(action);
		const decisionPath = (id, week, tail) => `/api/admin/driver-performance/weeks/${id}/${week}/${tail}`;

		{
			const w = await missedWeek();
			const before = w.rowOf("Ada Quill", WEEK0);
			const r = await w.decide("Ada Quill", WEEK0, "excused", "Weather closure on the route");
			eq([r.status, r.json], [200, { saved: true, verdict: "excused" }], "a Super Admin excuses a missed week");
			const rep = await w.report(WEEK0);
			const ada = w.driverIn(rep, "Ada Quill");
			eq([ada.lockedVerdict, ada.verdict, ada.verdictWhy, ada.excuses], ["missed", "excused", "office", 1], "the report shows both, and each driver's excuse count");
			eq(ada.upliftThisWeek.needsOfficeApproval, true, "an excused week's uplift waits for the office");
			eq(w.rowOf("Ada Quill", WEEK0), before, "...and the locked row is untouched");
			eq(audits(w, "performance_week_decision").map((a) => [a.username, a.role, a.entity_id, a.details]), [["admin", "Super Admin", `1:${WEEK0}`, "excused: Weather closure on the route"]], "it is audited, with its reason");
			eq(ada.decisions.map((x) => [x.kind, x.verdict, x.reason, x.actor]), [["office_verdict", "excused", "Weather closure on the route", "admin"]], "and listed on the report");
			for (const [body, code] of [
				[{ verdict: "excused" }, "REASON_REQUIRED"],
				[{ verdict: "excused", reason: "  " }, "REASON_REQUIRED"],
				[{ verdict: "excused", reason: 12345 }, "REASON_REQUIRED"],
				[{ verdict: "excused", reason: "x".repeat(501) }, "REASON_REQUIRED"],
				[{ verdict: "met", reason: "made up" }, "BAD_VERDICT"],
				[{ verdict: "pending", reason: "made up" }, "BAD_VERDICT"],
				[{ reason: "made up" }, "BAD_VERDICT"],
			]) {
				const refused = await w.call("POST", decisionPath(1, WEEK0, "decision"), USERS.admin, body);
				eq([refused.status, refused.json && refused.json.code], [400, code], `${JSON.stringify(body).slice(0, 50)} is refused`);
			}
			for (const [week, code, status] of [["2026-11-08", "BAD_WEEK", 400], ["not-a-day", "BAD_WEEK", 400], [weekN(5), "WEEK_IN_FUTURE", 400], ["2026-10-03", "WEEK_NOT_ON_RECORD", 404]]) {
				const refused = await w.call("POST", decisionPath(1, week, "decision"), USERS.admin, { verdict: "excused", reason: "made up" });
				eq([refused.status, refused.json && refused.json.code], [status, code], `a decision on ${week} is refused`);
			}
			eq((await w.call("POST", decisionPath(999, WEEK0, "decision"), USERS.admin, { verdict: "excused", reason: "made up" })).json.code, "DRIVER_NOT_FOUND", "an unknown driver is refused");
			eq((await w.call("POST", decisionPath(5, WEEK0, "decision"), USERS.admin, { verdict: "excused", reason: "made up" })).json.code, "WEEK_NOT_ON_RECORD", "a driver with no row that week is refused");
			eq((await w.decide("Ada Quill", WEEK0, "frozen", "Fleet-approved repair, made-up work order")).status, 200, "a Super Admin can record a repair freeze");
			eq(w.driverIn(await w.report(WEEK0), "Ada Quill").verdict, "frozen", "...and the latest decision wins");
			await w.close();
		}
		{
			// An excuse recorded during the week applies when it locks.
			const w = await makeWorld(GO);
			w.work("Ada Quill", WEEK0, { loads: 4 });
			w.clock.ms = Date.parse("2026-11-10T17:00:00Z");
			eq((await w.decide("Ada Quill", WEEK0, "frozen", "In the shop, made-up work order")).status, 200, "a freeze can be recorded while the week is open");
			eq((await w.decide("Ada Quill", WEEK0, "missed")).json.code, "WEEK_NOT_LOCKED", "...but 'missed' only once it has locked");
			await w.lock(WEEK0);
			const ada = w.driverIn(await w.report(WEEK0), "Ada Quill");
			eq([ada.lockedVerdict, ada.verdict], ["missed", "frozen"], "...and applies at the lock, without changing what locked");
			await w.close();
		}
		{
			const w = await makeWorld(GO);
			await w.lock(WEEK0);
			w.clock.ms = rules.lockMomentMs(WEEK0) + 3600000;
			eq(w.rowOf("Ada Quill", WEEK0).verdict, "pending", "a silent week locks pending");
			await w.decide("Ada Quill", WEEK0, "frozen", "Device fault confirmed");
			eq(w.driverIn(await w.report(WEEK0), "Ada Quill").verdict, "frozen", "a Super Admin decides it frozen for a device fault");
			await w.decide("Ada Quill", WEEK0, "missed", "Device was unplugged");
			eq(w.driverIn(await w.report(WEEK0), "Ada Quill").verdict, "missed", "...or missed");
			await w.close();
		}
		{
			const w = await missedWeek();
			const propose = (user) => w.call("POST", `/api/driver-performance/weeks/1/${WEEK0}/proposal`, user, { verdict: "excused", reason: "No freight offered" });
			const r = await propose(USERS.dispatcher);
			eq([r.status, r.json], [200, { proposed: true }], "a Dispatcher may propose, and learns nothing of the week");
			const ada = w.driverIn(await w.report(WEEK0), "Ada Quill");
			eq([ada.verdict, ada.decisions.map((x) => [x.kind, x.verdict, x.actor])], ["missed", [["proposal", "excused", "disp"]]], "a proposal changes nothing, and shows on the report");
			eq(audits(w, "performance_week_proposal").length, 1, "...audited");
			eq((await w.decide("Ada Quill", WEEK0, "excused", "made up", USERS.dispatcher)).status, 403, "a Dispatcher can't decide");
			eq((await w.call("POST", `/api/driver-performance/weeks/1/${WEEK0}/proposal`, USERS.dispatcher, { verdict: "missed", reason: "made up" })).json.code, "BAD_VERDICT", "...or propose 'missed'");
			eq((await propose(USERS.ada)).status, 403, "a Driver can't propose");
			eq((await propose(USERS.investor)).status, 403, "...nor an Investor");
			await w.close();
		}
		{
			// The automatic excuse.
			const w = await makeWorld(GO);
			w.clock.ms = Date.parse("2026-11-10T17:00:00Z");
			w.work("Ada Quill", WEEK0, { loads: 4 });
			const tap = await w.call("POST", "/api/driver/me/performance/hos-stop", USERS.ada);
			eq([tap.status, tap.json], [200, { marked: true, weekStart: WEEK0 }], "a driver marks a stop; the answer carries no figure");
			eq((await w.call("POST", "/api/driver/me/performance/hos-stop", USERS.ada)).json, { marked: true, weekStart: WEEK0 }, "a second tap answers the same");
			eq(count(w.db, "SELECT COUNT(*) AS n FROM performance_week_decisions WHERE kind = 'hos_stop'"), 1, "...and stores nothing more");
			eq(audits(w, "performance_hos_stop").length, 1, "...and is audited once");
			// A mark can close its 7 days before its week locks, so the office sees it from the start.
			const seen = (await w.report()).decisionsWithoutRow;
			eq(seen.map((x) => [x.name, x.weekStart, x.kind, x.declineOpenUntil]), [["Ada Quill", WEEK0, "hos_stop", "2026-11-17T17:00:00.000Z"]], "the report shows the mark before the week locks, with its deadline");
			eq((await w.call("POST", "/api/driver/me/performance/hos-stop", USERS.eli)).json.code, "NOT_ELIGIBLE", "a percentage driver isn't in");
			eq((await w.call("POST", "/api/driver/me/performance/hos-stop", USERS.nobody)).json.code, "NOT_ELIGIBLE", "...nor an account on no directory row");
			eq((await w.call("POST", "/api/driver/me/performance/hos-stop", USERS.admin)).status, 403, "a Super Admin can't mark one");
			await w.lock(WEEK0);
			let ada = w.driverIn(await w.report(WEEK0), "Ada Quill");
			eq([ada.lockedVerdict, ada.verdict, ada.verdictWhy, ada.excuses], ["missed", "excused", "hos-stop", 1], "the missed week reads excused, by itself");
			const decline = (reason = "Logs show no stop") => w.call("POST", decisionPath(1, WEEK0, "hos-decline"), USERS.admin, reason === null ? {} : { reason });
			w.clock.ms = Date.parse("2026-11-17T17:00:01Z");
			eq((await decline()).json.code, "HOS_DECLINE_CLOSED", "a decline after 7 days is refused");
			eq(w.driverIn(await w.report(WEEK0), "Ada Quill").verdict, "excused", "...and the excuse stands");
			w.clock.ms = Date.parse("2026-11-17T16:59:59Z");
			eq((await decline(null)).json.code, "REASON_REQUIRED", "a decline needs a reason");
			eq((await w.call("POST", decisionPath(1, WEEK0, "hos-decline"), USERS.dispatcher, { reason: "made up" })).status, 403, "...and a Super Admin");
			eq((await decline()).json, { saved: true }, "within 7 days a Super Admin can decline it");
			ada = w.driverIn(await w.report(WEEK0), "Ada Quill");
			eq([ada.verdict, ada.excuses], ["missed", 0], "...and the week reads missed");
			eq(audits(w, "performance_hos_decline").map((a) => a.details), ["Logs show no stop"], "...audited, with the reason");
			eq((await decline()).json.code, "HOS_ALREADY_DECLINED", "it can't be declined twice");
			eq((await w.call("POST", decisionPath(2, WEEK0, "hos-decline"), USERS.admin, { reason: "made up" })).json.code, "HOS_STOP_NOT_FOUND", "a week with no stop has nothing to decline");
			await w.close();
		}
		{
			// The tap can't cover a silent ELD.
			const w = await makeWorld(GO);
			w.clock.ms = Date.parse("2026-11-10T17:00:00Z");
			await w.call("POST", "/api/driver/me/performance/hos-stop", USERS.ada);
			await w.lock(WEEK0);
			const ada = w.driverIn(await w.report(WEEK0), "Ada Quill");
			eq([ada.lockedVerdict, ada.verdict], ["pending", "pending"], "unplugged and tapped: still pending, for a Super Admin");
			await w.close();
		}
		{
			const w = await makeWorld(GO);
			w.clock.ms = Date.parse("2026-11-10T17:00:00Z");
			w.work("Ada Quill", WEEK0);
			await w.call("POST", "/api/driver/me/performance/hos-stop", USERS.ada);
			await w.lock(WEEK0);
			eq(w.driverIn(await w.report(WEEK0), "Ada Quill").verdict, "met", "a met week stays met: staying legal never costs a gain");
			await w.close();
		}
		{
			// The office's pickup credit.
			const w = await makeWorld(GO);
			w.work("Ada Quill", WEEK0, { loads: 4 });
			w.row("O-1", "Ada Quill", "Delivered", `${addDays(WEEK0, 3)} 12:00`); // 7.0 credits: one pickup short
			w.row("O-2", "Ben Marsh", "Delivered", `${addDays(WEEK0, 3)} 12:00`);
			await w.lock(WEEK0);
			w.clock.ms = rules.lockMomentMs(WEEK0) + 3600000;
			const before = w.rowOf("Ada Quill", WEEK0);
			eq([before.credits, before.verdict], [7, "missed"], "a delivery with no pickup record: 7.0 credits, missed");
			const credit = (load, reason = "Bill of lading shows the pickup") => w.call("POST", decisionPath(1, WEEK0, "pickup-credit"), USERS.admin, { loadId: load, reason });
			eq((await credit("O-2")).json.code, "LOAD_NOT_HIS", "another driver's load can't be credited");
			eq((await credit(`L1-${WEEK0}-0`)).json.code, "PICKUP_ALREADY_CREDITED", "nor a pickup already credited");
			eq((await w.call("POST", decisionPath(1, WEEK0, "pickup-credit"), USERS.admin, { reason: "made up" })).json.code, "LOAD_REQUIRED", "a load is required");
			eq((await w.call("POST", decisionPath(1, WEEK0, "pickup-credit"), USERS.admin, { loadId: "O-1" })).json.code, "REASON_REQUIRED", "and a reason");
			eq((await w.call("POST", decisionPath(1, WEEK0, "pickup-credit"), USERS.dispatcher, { loadId: "O-1", reason: "made up" })).status, 403, "and a Super Admin");
			eq((await credit("#O-1")).json, { saved: true }, "the office credits it");
			const ada = w.driverIn(await w.report(WEEK0), "Ada Quill");
			eq([ada.verdict, ada.verdictWhy, ada.officeCredits, ada.credits], ["met", "office-pickup-credit", 1, 7], "the week reads met, and the report says how");
			eq(w.rowOf("Ada Quill", WEEK0), before, "...with the locked row untouched");
			eq(audits(w, "performance_pickup_credit").map((a) => a.details), ["o-1: Bill of lading shows the pickup"], "...audited, with the load and reason");
			eq((await credit("O-1")).json.code, "PICKUP_ALREADY_CREDITED", "it can't be credited twice");
			w.sheetDown = true;
			eq((await credit("O-1")).status, 503, "Job Tracking down answers 503, and saves nothing");
			await w.close();
		}
		{
			const w = await makeWorld(GO);
			const cols = w.db.prepare("PRAGMA table_info(performance_weeks)").all().map((c) => c.name);
			ok(!cols.some((c) => /name/.test(c)) && cols.includes("directory_id"), "rows key by directory id and hold no driver name, so a rename can't strand them");
			await w.close();
		}
	});

	// ── §8 ──────────────────────────────────────────────────────────────────
	await section("8 the streak through the report: tiers, holds, resets, the quarterly flag", async () => {
		need();
		const run = async (verdicts, who = "Ada Quill", env = GO) => {
			const w = await makeWorld(env);
			verdicts.forEach((v, i) => w.seed(who, weekN(i), v));
			const last = weekN(verdicts.length - 1);
			w.clock.ms = rules.lockMomentMs(last) + 1000;
			const x = w.driverIn(await w.report(last), who);
			await w.close();
			return x;
		};
		let x = await run(["met", "met"]);
		eq([x.streak, x.tierForNewWeek.level, x.upliftNewWeekPerPaidDayCents], [2, 0, 0], "2 weeks: no tier");
		x = await run(["met", "met", "met"]);
		eq([x.streak, x.tierDuringWeek.level, x.tierForNewWeek.level, x.upliftNewWeekPerPaidDayCents], [3, 0, 1, 2500], "the 3rd met week earns tier 1 for the new week: $25 over $300");
		x = await run(["met", "met", "met"], "Ben Marsh");
		eq(x.upliftNewWeekPerPaidDayCents, 7500, "$75 over a $250 rate, by the default reading");
		x = await run(["met", "met", "met"], "Cal Reyes");
		eq(x.upliftNewWeekPerPaidDayCents, 0, "and nothing over $350");
		x = await run(Array(6).fill("met"));
		eq([x.tierDuringWeek.level, x.tierForNewWeek.level, x.upliftNewWeekPerPaidDayCents], [1, 2, 5000], "the 6th earns tier 2");
		x = await run(Array(9).fill("met"));
		eq([x.streak, x.tierForNewWeek.level], [9, 2], "tier 2 is the cap");
		x = await run(["met", "met", "met", "missed"]);
		eq([x.streak, x.tierDuringWeek.level, x.tierForNewWeek.level, x.upliftNewWeekPerPaidDayCents], [0, 1, 0, 0], "a missed week: streak 0, base rate from the next Saturday");
		eq(x.upliftThisWeek, { perPaidDayCents: 2500, needsOfficeApproval: false }, "...the tier having stood for the missed week itself");
		x = await run(["met", "met", "met", "frozen"]);
		eq([x.streak, x.tierForNewWeek.level, x.upliftThisWeek.needsOfficeApproval, x.frozenWeeks], [3, 1, true, 1], "a frozen week: no gain, no reset, no uplift for its days without the office");
		x = await run(["met", "met", "frozen", "met"]);
		eq([x.streak, x.tierForNewWeek.level], [3, 1], "frozen weeks don't break a run");
		x = await run(["met", "met", "met", "pending"]);
		eq([x.streak, x.tierForNewWeek, x.upliftNewWeekPerPaidDayCents, x.undecidedPendingWeeks, x.upliftThisWeek.needsOfficeApproval], [3, { level: null, held: "pending-week" }, null, [weekN(3)], true], "a pending week holds the tier: nothing is earned until it is decided");
		{
			const w = await makeWorld(GO);
			["met", "met", "met", "pending", "met"].forEach((v, i) => w.seed("Ada Quill", weekN(i), v));
			w.clock.ms = rules.lockMomentMs(weekN(4)) + 1000;
			let ada = w.driverIn(await w.report(weekN(4)), "Ada Quill");
			eq([ada.streak, ada.tierForNewWeek.level], [4, null], "met weeks after an undecided pending week still hold the tier");
			await w.decide("Ada Quill", weekN(3), "missed", "Device was unplugged");
			ada = w.driverIn(await w.report(weekN(4)), "Ada Quill");
			eq([ada.streak, ada.tierForNewWeek.level], [1, 0], "decided missed, the streak resets from there");
			await w.close();
		}
		x = await run(Array(12).fill("met"));
		eq(x.quarterlyBonus, { flaggedWeeks: [], text: null }, "12 weeks flag nothing");
		x = await run(Array(13).fill("met"));
		eq(x.quarterlyBonus, { flaggedWeeks: [weekN(12)], text: "Quarterly bonus due: amount not set" }, "13 flag it, and the amount is not set");
		x = await run(Array(13).fill("met"), "Ada Quill", { ...GO, DRIVER_PERFORMANCE_QUARTERLY_BONUS: "1500" });
		eq(x.quarterlyBonus.text, "Quarterly bonus due: $1500.00", "the setting fills in the words, and nothing else");
		x = await run([...Array(6).fill("met"), "frozen", ...Array(7).fill("met")]);
		eq(x.quarterlyBonus.flaggedWeeks, [weekN(13)], "a frozen week doesn't break the 13 and doesn't count toward it");
		x = await run([...Array(6).fill("met"), "missed", ...Array(7).fill("met")]);
		eq(x.quarterlyBonus.flaggedWeeks, [], "a missed week does break it");
		{
			const w = await makeWorld(GO);
			w.seed("Ada Quill", WEEK0, "met", { credits: 7.5, hours: 42.5 });
			w.clock.ms = rules.lockMomentMs(WEEK0) + 1000;
			const rep = await w.report(WEEK0);
			eq([rep.reportOnly, rep.paysNothing, rep.hoursLabel], [true, true, "estimate, not checked"], "the report calls itself what it is");
			eq([rep.week.start, rep.week.end, rep.week.state], [WEEK0, addDays(WEEK0, 6), "locked"], "...and names its week");
			eq((await w.call("GET", "/api/admin/driver-performance/weeks?week=2026-11-08", USERS.admin)).json.code, "BAD_WEEK", "a week that isn't a Saturday is refused");
			eq((await w.report()).week.start, WEEK0, "with no week asked, the latest locked one");
			await w.close();
		}
	});

	// ── §9 ──────────────────────────────────────────────────────────────────
	await section("9 who sees what: Super Admin only, and no hours on any driver route", async () => {
		need();
		const w = await makeWorld(GO);
		w.clock.ms = Date.parse("2026-11-10T17:00:00Z");
		w.work("Ada Quill", WEEK0);
		await w.lock(WEEK0);
		w.clock.ms = rules.lockMomentMs(WEEK0) + 1000;
		const report = "/api/admin/driver-performance/weeks";
		eq((await w.call("GET", report, USERS.admin)).status, 200, "a Super Admin reads the report");
		for (const [who, user, status] of [["a Dispatcher", USERS.dispatcher, 403], ["a Driver", USERS.ada, 403], ["an Investor", USERS.investor, 403], ["nobody signed in", null, 401]]) {
			eq((await w.call("GET", report, user)).status, status, `${who} can't`);
			eq((await w.decide("Ada Quill", WEEK0, "excused", "made up", user)).status, status, `${who} can't decide`);
		}
		eq((await w.call("POST", `/api/admin/driver-performance/weeks/1/${WEEK0}/decision`, USERS.admin, { verdict: "excused", reason: "made up" }, { "x-requested-with": "" })).status, 403, "a write without the CSRF header is refused");

		const NOT_FOR_DRIVERS = /hour|rei\b|streak|tier|verdict|pace|uplift|excuse|frozen|pending/i;
		for (const [method, p] of [
			["POST", "/api/driver/me/performance/hos-stop"],
			["GET", "/api/driver/me/performance"],
			["GET", "/api/driver/performance/leaderboard?period=week"],
			["GET", "/api/driver/performance/leaderboard?period=month"],
		]) {
			const r = await w.call(method, p, USERS.ada);
			eq(r.status, 200, `${method} ${p} answers the driver`);
			const stray = allKeys(r.json).filter((k) => NOT_FOR_DRIVERS.test(k));
			eq(stray, [], "...with no hours, score, streak, tier or verdict among its keys");
			ok(!/42\.5/.test(r.text), "...and no hours target in its text");
		}
		const clientFiles = [];
		const walk = (dir) => {
			if (!fs.existsSync(dir)) return;
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name);
				if (e.isDirectory()) walk(p);
				else if (/\.(js|mjs|ts|vue)$/.test(e.name)) clientFiles.push(p);
			}
		};
		walk(path.join(ROOT, "client", "src"));
		ok(clientFiles.length > 50, "(fixture) the scan reached client/src");
		eq(clientFiles.filter((f) => /driver-performance\/weeks|hos-stop|performance-weeks/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f)), [], "no screen calls these routes: the driver's screen is a later phase");
		await w.close();
	});

	// ── §10 ─────────────────────────────────────────────────────────────────
	await section("10 it can't reach pay", async () => {
		need();
		lifted();
		const TRACKED_RE = /(?<![\w$-])(performance_weeks|performance_week_decisions|performance_week_runs|driver-performance-weeks(-routes)?|driverPerformanceWeeks)(?![\w$])/;
		const OWN = new Set(["driver-performance-weeks.js", "driver-performance-weeks-routes.js"]);
		const libFiles = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => /\.(js|mjs|cjs)$/.test(f));
		ok(libFiles.length > 50, "(fixture) the scan reached lib/");
		eq(libFiles.filter((f) => !OWN.has(f) && TRACKED_RE.test(fs.readFileSync(path.join(ROOT, "lib", f), "utf8"))), [], "no other lib/ module names these rows or this module");
		const routesDir = path.join(ROOT, "routes");
		const routeFiles = fs.existsSync(routesDir) ? fs.readdirSync(routesDir).filter((f) => f.endsWith(".js")) : [];
		eq(routeFiles.filter((f) => TRACKED_RE.test(fs.readFileSync(path.join(routesDir, f), "utf8"))), [], "...and no routes/ module");

		// server.js names them in exactly the mount, its timer and their comments.
		const ALLOWED_LINES = new Set([
			'const driverPerformanceWeeks = require("./lib/driver-performance-weeks-routes").mount(app, {',
			'if (driverPerformanceWeeks.enabled && startsJob("driver performance week lock")) {',
			"setTimeout(() => { driverPerformanceWeeks.lockDue(); }, 13 * 60 * 1000);",
			"setInterval(() => { driverPerformanceWeeks.lockDue(); }, 15 * 60 * 1000);",
		]);
		const mentions = SRC.split("\n").map((l, i) => [l.trim(), i + 1]).filter(([l]) => TRACKED_RE.test(l) && !l.startsWith("//"));
		eq(mentions.filter(([l]) => !ALLOWED_LINES.has(l)).map(([l, n]) => `line ${n}: ${l.slice(0, 90)}`), [], "in server.js only the mount and its timer name them");
		eq(mentions.length, 4, "...all four of them");

		const decls = require("./lib/server-lift").indexDeclarations(SRC).decls;
		for (const fn of ["computeInvestorMonthlyEarnings", "buildFinancialsLedger", "buildFinancialsReport", "generateInvoiceHandler", "truckMonthlyFixed", "financialsExtraItems", "computeFleetLedger", "computeLossCarryForward", "invoiceTotalDue", "financialsInvoiceShares"]) {
			const decl = decls.get(fn);
			ok(!!decl, `${fn}() is in server.js`);
			if (decl) ok(!TRACKED_RE.test(decl.text), `...and names none of them`);
		}
		for (const f of ["load-pay-days.js", "financials-calc.js", "investor-payout-basis.js", "financials-report.js"]) {
			ok(!TRACKED_RE.test(fs.readFileSync(path.join(ROOT, "lib", f), "utf8")), `lib/${f} names none of them`);
		}

		// What this module writes, and what it never touches.
		const ownText = [...OWN].map((f) => fs.readFileSync(path.join(ROOT, "lib", f), "utf8")).join("\n");
		const writes = new Set();
		for (const m of ownText.matchAll(/\b(?:INSERT(?: OR \w+)? INTO|REPLACE INTO|DELETE FROM)\s+(\w+)|(?<!BEFORE )\bUPDATE\s+(\w+)/g)) writes.add(m[1] || m[2]);
		eq([...writes].sort(), ["performance_week_decisions", "performance_week_runs", "performance_weeks", "server_state"], "it writes only its own tables, and its one switch-on marker");
		eq((ownText.match(/server_state \(key/g) || []).length, 1, "...one write to server_state");
		for (const table of ["invoices", "invoice_correction_lines", "invoice_paid_days", "investor_payouts", "investor_payout_history", "payout_ledger", "pay_rate_history", "period_locks", "expenses"]) {
			ok(!new RegExp(`\\b${table}\\b`).test(ownText), `it never names ${table}`);
		}
		ok(!/\bfetch\(|sendEmail|sheets\.|nodemailer/.test(ownText), "it calls no outside service and sends nothing");
		const w = await makeWorld(GO);
		eq(Object.keys(w.handle).sort(), ["PATHS", "enabled", "lockDue"], "what it hands server.js is its flag, its paths and its lock: no reader");
		await w.close();

		// By behaviour: the same month, with and without rows that would earn every tier.
		const AMY = "Amy Stone";
		const moneyViews = async (withRows) => {
			const m = WD.startWorld({
				now: Date.parse("2026-10-12T16:00:00Z"),
				drivers: [{ name: AMY, payDaily: 300 }],
				rows: [
					WD.loadRow({ id: "G101", driver: AMY, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 18:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" }),
					WD.loadRow({ id: "G102", driver: AMY, pickup: "2026-10-08 8:00", dropoff: "2026-10-08 18:00", assigned: "2026-10-08", done: "2026-10-08", truck: "T1" }),
				],
			});
			if (withRows) {
				for (const sql of routes.SCHEMA_SQL) m.db.exec(sql);
				const dir = m.db.prepare("SELECT id FROM drivers_directory WHERE driver_name = ?").get(AMY).id;
				for (let i = 0; i < 13; i++) {
					const week = addDays("2026-07-11", 7 * i);
					m.db.prepare(`INSERT INTO performance_weeks (directory_id, week_start, week_end, verdict, reason, credits, deliveries, pickups, hours, rei, target_credits, target_hours,
						worked_days, days_off, silent_days, source_mix, detail, streak_eligible, locked_at)
						VALUES (?, ?, ?, 'met', 'targets-reached', 7.5, 5, 5, 42.5, 100, 7.5, 42.5, 5, 0, 0, '{}', '{}', 1, '2026-10-12T16:00:00Z')`).run(dir, week, addDays(week, 6));
				}
				m.db.prepare(`INSERT INTO performance_week_decisions (directory_id, week_start, kind, verdict, reason, actor, actor_role, created_ms)
					VALUES (?, '2026-10-03', 'office_verdict', 'excused', 'made up', 'admin', 'Super Admin', 1)`).run(dir);
			}
			const gen = await WD.generate(m, AMY, "2026-10-09");
			const led = await WD.ledger(m);
			const inv = await WD.investorDays(m);
			return {
				invoiceStatus: gen.status,
				invoiceDays: WD.gridDays(gen.data, "2026-10-09"),
				invoiceTotal: gen.invoice ? gen.invoice.total : null,
				ledgerItems: led.items.map((i) => ({ kind: i.kind, month: i.month, amount: i.amount, label: i.label })),
				ledgerMonths: led.monthlyEarnings,
				investorMonths: inv.months,
				corrections: m.db.prepare("SELECT COUNT(*) AS n FROM invoice_correction_lines").get().n,
			};
		};
		const base = await moneyViews(false);
		const withRows = await moneyViews(true);
		ok(base.invoiceStatus === 200 && JSON.stringify(base.invoiceDays).length > 2, "(fixture) the month has a weekly invoice");
		ok(base.ledgerItems.length > 0, "(fixture) and a payout ledger");
		eq(withRows.invoiceDays, base.invoiceDays, "13 met weeks change no invoice day");
		eq(withRows.invoiceTotal, base.invoiceTotal, "...no invoice total");
		eq(withRows.ledgerItems, base.ledgerItems, "...no payout ledger item");
		eq(withRows.ledgerMonths, base.ledgerMonths, "...no payout ledger month");
		eq(withRows.investorMonths, base.investorMonths, "...no investor figure");
		eq(withRows.corrections, 0, "...and add no correction line");
		WD.cleanup();
	});

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) {
		console.log("FAILED:");
		for (const f of failures.slice(0, 40)) console.log(`  ${f}`);
	}
	process.exit(failures.length ? 1 : 0);
})();
