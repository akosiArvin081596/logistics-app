#!/usr/bin/env node
/**
 * The office's safety-event log: lib/safety-event-log.js and the one server.js
 * declaration that mounts it, SAFETY_EVENT_LOG_ENABLED off unless exactly "true".
 *
 * WHAT IS REAL. The module as shipped, and server.js's own `safetyEventLog` and
 * `driverPerformance` declarations lifted with everything they use
 * (scripts/lib/server-lift.js closure(): requireRole, logAudit, the month locks,
 * the board's rules), on a real Express app on 127.0.0.1 port 0 over an in-memory
 * SQLite whose other tables come from server.js's own DDL. The session is a header
 * the test sets. "Today" is Wed 2026-11-11 (noon Eastern). All data is made up.
 *
 * §1  the rules: the kinds in one constant; what a body may hold
 * §2  the flag: exactly "true" only; off, every route is 404 FEATURE_OFF for every
 *     caller, no table, no write of any kind, and a table already there stays put
 * §3  the role matrix: Super Admin writes, Dispatcher reads, everyone else 401/403,
 *     nothing written by a refused caller
 * §4  create: stored fields, a reason, an audit row
 * §5  edit: a partial body, a reason, an audit row holding old and new; a no-op
 *     writes nothing
 * §6  void: a reason, an audit row; the row stays; no way to delete one
 * §7  closed months: create, edit (either side) and void refused, audited, nothing
 *     written; an unreadable lock table counts as closed; reads still answer
 * §8  no driver sees any of it: the board, the driver's own week and the Super Admin
 *     report are byte-identical with and without events; no other code names the log
 * §9  nothing reaches pay: writes touch only this table and audit_trail; the module
 *     names no other table and needs no other module
 * §10 no audit row, no write: each write rolls back when audit_trail refuses it
 * §11 the list: order, filters, cap; a deleted or renamed driver still reads right
 * §12 the rate limit: after the role gate, per account
 * §13 wiring: one declaration above the catch-all, the flag's exact read, the replica
 *     allowlist, the route snapshot's four lines
 *
 * Hermetic: :memory: SQLite, port 0, no network beyond 127.0.0.1.
 * Run: node scripts/test-safety-event-log.js    # exits 1 on failure
 */
"use strict";

process.env.APP_TIMEZONE = "America/New_York";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const FLAG = "SAFETY_EVENT_LOG_ENABLED";
const LIST = "/api/safety-events";

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
// A section that throws (the module missing on the base) fails by name, and the
// sections after it still run.
async function section(title, fn) {
	console.log(`\n§ ${title}`);
	try {
		await fn();
	} catch (err) {
		ok(false, `${title}: ran to the end`, (err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : String(err)));
	}
}

let rules = null;
try { rules = require(path.join(ROOT, "lib", "safety-event-log.js")); } catch (e) { rules = null; }
const need = () => { if (!rules) throw new Error("lib/safety-event-log.js did not load"); return rules; };

const NOW_MS = Date.parse("2026-11-11T17:00:00Z");
const TODAY = "2026-11-11";

// ── made-up fleet ──────────────────────────────────────────────────────────
const DRIVERS = [
	{ id: 1, name: "Ada Quill", user_id: 11 },
	{ id: 2, name: "Ben Marsh", user_id: 12 },
	{ id: 3, name: "Cal Reyes", user_id: 13 },
];
const TRUCKS = [
	{ id: 1, unit: "LogisX-#501" },
	{ id: 2, unit: "Logisx-#502" },
	{ id: 3, unit: "LogisX-#503" },
];
const ASSIGNMENTS = [
	{ truck: 1, driver: "Ada Quill", start: "2026-10-01T12:00:00.000Z", end: "" },
	{ truck: 2, driver: "Ben Marsh", start: "2026-10-01T12:00:00.000Z", end: "" },
	{ truck: 3, driver: "Cal Reyes", start: "2026-10-01T12:00:00.000Z", end: "" },
];
const HEADERS = ["Load ID", "Driver", "Job Status", "Pickup Appointment", "Drop-off Appointment", "Assigned Date", "Status Update Date", "Completion Date", "Truck"];
const LOADS = [
	["SE-1001", "Ada Quill", "Delivered", "2026-11-09 14:20"],
	["SE-1002", "Ada Quill", "Delivered", "2026-11-10 09:15"],
	["SE-2001", "Ben Marsh", "Delivered", "2026-11-09 16:00"],
	["SE-3001", "Cal Reyes", "In Transit", ""],
];
const USERS = {
	admin: { id: 31, role: "Super Admin", username: "admin" },
	dispatcher: { id: 41, role: "Dispatcher", username: "disp" },
	ada: { id: 11, role: "Driver", username: "ada", driverName: "Ada Quill" },
	ben: { id: 12, role: "Driver", username: "ben", driverName: "Ben Marsh" },
	investor: { id: 51, role: "Investor", username: "inv" },
	kpi: { id: 61, role: "KPI Viewer", username: "kpi" },
};
const OFFICE_VIEW_KEYS = ["id", "driverId", "driverName", "eventDate", "kind", "kindLabel", "preventable", "details", "recordReason", "createdBy", "createdAt", "updatedBy", "updatedAt", "updateReason", "voided", "voidedBy", "voidedAt", "voidReason"];
const GOOD = Object.freeze({ driverId: 1, eventDate: "2026-11-05", kind: "accident", details: "Backed into a made-up gate.", reason: "Made-up report received" });
const CLAIM = Object.freeze({ driverId: 2, eventDate: "2026-11-06", kind: "cargo_claim", preventable: true, details: "Made-up pallet damage.", reason: "Made-up claim filed" });

// ── the server.js world ────────────────────────────────────────────────────
let SRC = null;
let LIFT = null;
function lifted() {
	if (LIFT) return LIFT;
	SRC = require("./lib/server-source").serverSource();
	const { closure } = require("./lib/server-lift");
	LIFT = closure(SRC, {
		roots: ["safetyEventLog", "driverPerformance", "parseSheet", "deduplicateLoads"],
		provided: ["app", "db", "getJobTrackingCached"],
		denied: ["server", "transporter", "getDrive", "getSheets", "sendEmail"],
	});
	return LIFT;
}

function tableDdl(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) throw new Error(`could not locate CREATE TABLE ${name}`);
	return `CREATE TABLE ${name} (${m[1]}\n)`;
}

function sheetValues() {
	return [HEADERS, ...LOADS.map(([id, driver, status, done]) => HEADERS.map((h) => (
		h === "Load ID" ? id : h === "Driver" ? driver : h === "Job Status" ? status : h === "Status Update Date" ? done : ""
	)))];
}

function makeDb() {
	const Database = require("better-sqlite3");
	const db = new Database(":memory:");
	for (const t of ["drivers_directory", "trucks", "truck_assignments", "load_status_history", "load_eld_miles", "eld_miles_daily", "deleted_loads", "audit_trail", "period_locks"]) db.exec(tableDdl(t));
	db.exec("ALTER TABLE drivers_directory ADD COLUMN status TEXT DEFAULT 'active'");
	db.exec("ALTER TABLE drivers_directory ADD COLUMN pay_type TEXT DEFAULT 'fixed'");
	db.exec("ALTER TABLE trucks ADD COLUMN retired_at TEXT DEFAULT ''");
	db.exec(require(path.join(ROOT, "lib", "owner-operator.js")).OO_SCHEMA_SQL);
	const dir = db.prepare("INSERT INTO drivers_directory (id, driver_name, user_id) VALUES (?, ?, ?)");
	for (const d of DRIVERS) dir.run(d.id, d.name, d.user_id);
	const tr = db.prepare("INSERT INTO trucks (id, unit_number) VALUES (?, ?)");
	for (const t of TRUCKS) tr.run(t.id, t.unit);
	const ta = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, ?, ?)");
	for (const a of ASSIGNMENTS) ta.run(a.truck, a.driver, a.start, a.end);
	return db;
}

function fixedDateAt(ms) {
	return class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [ms])); }
		static now() { return ms; }
	};
}

// One world: a real Express app with the lifted declarations mounted on it.
// `prepare` runs on the seeded database before the mount.
async function makeWorld(env, { prepare } = {}) {
	const express = require("express");
	const lift = lifted();
	const app = express();
	app.use(express.json());
	app.use((req, res, next) => {
		const raw = req.headers["x-test-user"];
		req.session = raw ? { user: JSON.parse(raw) } : {};
		next();
	});
	const db = makeDb();
	if (prepare) prepare(db);
	const world = { db, changesBeforeMount: db.prepare("SELECT total_changes() AS n").get().n };
	const quiet = { log() {}, info() {}, warn() {}, error() {} };
	const deps = {
		app, db, require: createRequire(path.join(ROOT, "server.js")), console: quiet,
		process: { env: { ...env }, argv: [], cwd: () => ROOT }, __dirname: ROOT, Date: fixedDateAt(NOW_MS),
		getJobTrackingCached: async () => {
			if (!world.jt) {
				world.jt = world.fns.parseSheet({ values: sheetValues() });
				world.jt.data = world.fns.deduplicateLoads(world.jt.data, world.jt.headers);
			}
			return world.jt;
		},
	};
	const body = ['"use strict";', lift.text, "return { safetyEventLog, driverPerformance, parseSheet, deduplicateLoads };"].join("\n");
	const realLog = console.log;
	console.log = () => {};
	try {
		world.fns = new Function(...Object.keys(deps), body)(...Object.values(deps));
	} finally {
		console.log = realLog;
	}
	await new Promise((resolve) => { world.server = app.listen(0, "127.0.0.1", resolve); });
	world.port = world.server.address().port;
	world.req = (method, p, user, sent, opts) => new Promise((resolve, reject) => {
		const o = opts || {};
		const headers = { ...(user ? { "x-test-user": JSON.stringify(user) } : {}), ...(o.headers || {}) };
		if (method !== "GET" && method !== "HEAD" && !o.noCsrfHeader) headers["x-requested-with"] = "XMLHttpRequest";
		let payload = null;
		if (sent !== undefined) {
			payload = JSON.stringify(sent);
			headers["content-type"] = "application/json";
			headers["content-length"] = Buffer.byteLength(payload);
		}
		const r = http.request({ host: "127.0.0.1", port: world.port, method, path: p, headers }, (res) => {
			let buf = "";
			res.setEncoding("utf8");
			res.on("data", (c) => { buf += c; });
			res.on("end", () => {
				let json = null;
				try { json = JSON.parse(buf); } catch { json = null; }
				resolve({ status: res.statusCode, json, text: buf, headers: res.headers });
			});
		});
		r.on("error", reject);
		if (payload) r.write(payload);
		r.end();
	});
	world.close = () => new Promise((resolve) => world.server.close(resolve));
	world.rows = () => db.prepare("SELECT * FROM safety_events ORDER BY id").all();
	world.audit = () => db.prepare("SELECT * FROM audit_trail ORDER BY id").all();
	return world;
}
const on = () => makeWorld({ [FLAG]: "true" });
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
const lock = (db, period, status = "locked") => db.prepare("INSERT OR REPLACE INTO period_locks (period, status, finalized_at) VALUES (?, ?, '2026-11-01T00:00:00Z')").run(period, status);
const refusedBy = (v, code) => v && v.ok === false && v.code === code;

function routesFor(id) {
	return [
		["GET", LIST, undefined],
		["POST", LIST, GOOD],
		["PUT", `${LIST}/${id}`, { kind: "moving_violation", reason: "Made-up correction" }],
		["POST", `${LIST}/${id}/void`, { reason: "Made-up void" }],
	];
}

(async () => {
	// ── §1 ──────────────────────────────────────────────────────────────────
	await section("1 the rules", () => {
		const r = need();
		eq(Object.keys(r.KINDS), ["accident", "inspection_violation", "out_of_service", "moving_violation", "hos_violation", "cargo_claim"], "the plan's list of kinds, in one constant");
		ok(Object.isFrozen(r.KINDS), "...frozen, so nothing at run time adds to it");
		eq(r.KIND_WITH_PREVENTABLE, "cargo_claim", "only a cargo claim carries the preventable mark");
		const ctx = { todayKey: TODAY };

		const good = r.validateCreate({ ...GOOD }, ctx);
		eq(good, { ok: true, value: { driverId: 1, eventDate: "2026-11-05", kind: "accident", preventable: null, details: "Backed into a made-up gate.", reason: "Made-up report received" } }, "a good body is taken as it is");
		ok(r.validateCreate({ ...GOOD, eventDate: TODAY }, ctx).ok, "today is allowed");
		ok(r.validateCreate({ ...GOOD, details: undefined }, ctx).ok, "details are optional");
		eq(r.validateCreate({ ...CLAIM, preventable: false }, ctx).value.preventable, false, "a claim marked not preventable keeps its mark");

		const cases = [
			["a body that's an array", [], "INVALID_BODY"],
			["no body", null, "INVALID_BODY"],
			["a string body", "x", "INVALID_BODY"],
			["an unknown field", { ...GOOD, voided_at: "x" }, "UNKNOWN_FIELD"],
			["a driver name in the body", { ...GOOD, driverName: "Made Up" }, "UNKNOWN_FIELD"],
			["an own __proto__ key", JSON.parse('{"__proto__":{"x":1},"driverId":1,"eventDate":"2026-11-05","kind":"accident","reason":"Made-up"}'), "UNKNOWN_FIELD"],
			["no reason", { ...GOOD, reason: undefined }, "REASON_REQUIRED"],
			["an empty reason", { ...GOOD, reason: "" }, "REASON_REQUIRED"],
			["a blank reason", { ...GOOD, reason: "  \n\t " }, "REASON_REQUIRED"],
			["a two-letter reason", { ...GOOD, reason: "ok" }, "REASON_REQUIRED"],
			["a number as a reason", { ...GOOD, reason: 12345 }, "REASON_REQUIRED"],
			["a 501-character reason", { ...GOOD, reason: "x".repeat(501) }, "REASON_TOO_LONG"],
			["a reason mostly of spaces, over the raw cap", { ...GOOD, reason: `${" ".repeat(1001)}Made-up` }, "REASON_TOO_LONG"],
			["a number as details", { ...GOOD, details: 5 }, "INVALID_DETAILS"],
			["2001 characters of details", { ...GOOD, details: "x".repeat(2001) }, "DETAILS_TOO_LONG"],
			["a driver id as text", { ...GOOD, driverId: "1" }, "INVALID_DRIVER"],
			["driver id 0", { ...GOOD, driverId: 0 }, "INVALID_DRIVER"],
			["a negative driver id", { ...GOOD, driverId: -1 }, "INVALID_DRIVER"],
			["a fractional driver id", { ...GOOD, driverId: 1.5 }, "INVALID_DRIVER"],
			["an unsafe driver id", { ...GOOD, driverId: 2 ** 53 }, "INVALID_DRIVER"],
			["no driver id", { ...GOOD, driverId: undefined }, "INVALID_DRIVER"],
			["Feb 30", { ...GOOD, eventDate: "2026-02-30" }, "INVALID_DATE"],
			["month 13", { ...GOOD, eventDate: "2026-13-01" }, "INVALID_DATE"],
			["day 0", { ...GOOD, eventDate: "2026-11-00" }, "INVALID_DATE"],
			["a US-style date", { ...GOOD, eventDate: "11/05/2026" }, "INVALID_DATE"],
			["an instant", { ...GOOD, eventDate: "2026-11-05T00:00:00Z" }, "INVALID_DATE"],
			["a number as a date", { ...GOOD, eventDate: 20261105 }, "INVALID_DATE"],
			["a year before 2000", { ...GOOD, eventDate: "1999-12-31" }, "INVALID_DATE"],
			["no date", { ...GOOD, eventDate: undefined }, "INVALID_DATE"],
			["tomorrow", { ...GOOD, eventDate: "2026-11-12" }, "FUTURE_DATE"],
			["an unknown kind", { ...GOOD, kind: "speeding" }, "INVALID_KIND"],
			["a kind that's an object key", { ...GOOD, kind: "constructor" }, "INVALID_KIND"],
			["__proto__ as a kind", { ...GOOD, kind: "__proto__" }, "INVALID_KIND"],
			["a kind in another case", { ...GOOD, kind: "Accident" }, "INVALID_KIND"],
			["no kind", { ...GOOD, kind: undefined }, "INVALID_KIND"],
			["a claim with no mark", { ...CLAIM, preventable: undefined }, "PREVENTABLE_REQUIRED"],
			["a claim with a null mark", { ...CLAIM, preventable: null }, "PREVENTABLE_REQUIRED"],
			["a claim with a mark that isn't true or false", { ...CLAIM, preventable: 1 }, "PREVENTABLE_REQUIRED"],
			["a mark on an accident", { ...GOOD, preventable: true }, "PREVENTABLE_NOT_ALLOWED"],
			["a false mark on an accident", { ...GOOD, preventable: false }, "PREVENTABLE_NOT_ALLOWED"],
		];
		for (const [name, body, code] of cases) {
			const v = r.validateCreate(body, ctx);
			ok(refusedBy(v, code), `${name}: refused ${code}`, JSON.stringify(v));
			ok(v.status === 400, `...with a 400`, String(v.status));
		}
		ok(r.validateCreate({ ...GOOD, preventable: null }, ctx).ok, "a null mark on an accident is the same as none");
		ok(r.validateCreate({ ...GOOD, reason: "x".repeat(500) }, ctx).ok, "a 500-character reason is taken");
		ok(r.validateCreate({ ...GOOD, details: "x".repeat(2000) }, ctx).ok, "2000 characters of details are taken");
		ok(r.validateCreate({ ...GOOD, reason: "abc" }, ctx).ok, "a three-letter reason is taken");

		eq(r.validateCreate({ ...GOOD, reason: "  Made-up\r\n\treason\u0000here  " }, ctx).value.reason, "Made-up reason here", "a reason becomes one line, with its control characters gone");
		eq(r.validateCreate({ ...GOOD, details: "  Line one\r\nLine\u0007two  " }, ctx).value.details, "Line one\nLine two", "details keep their lines, lose other control characters and the edges' space");

		eq(r.validateVoid({ reason: " Made-up " }), { ok: true, value: { reason: "Made-up" } }, "a void takes a reason");
		ok(refusedBy(r.validateVoid({}), "REASON_REQUIRED"), "a void with no reason is refused");
		ok(refusedBy(r.validateVoid({ reason: "Made-up", kind: "accident" }), "UNKNOWN_FIELD"), "a void takes nothing else");
		ok(refusedBy(r.validateVoid(null), "INVALID_BODY"), "a void with no body is refused");

		const stored = { directory_id: 1, event_date: "2026-11-05", kind: "cargo_claim", preventable: 1, details: "Stored" };
		eq(r.validateEdit({ reason: "Made-up" }, stored, ctx).value, { driverId: 1, eventDate: "2026-11-05", kind: "cargo_claim", preventable: true, details: "Stored", reason: "Made-up" }, "an edit starts from the stored row");
		eq(r.validateEdit({ kind: "accident", reason: "Made-up" }, stored, ctx).value.preventable, null, "moving off a claim drops its mark");
		ok(refusedBy(r.validateEdit({ kind: "accident", preventable: true, reason: "Made-up" }, stored, ctx), "PREVENTABLE_NOT_ALLOWED"), "and can't keep one");
		ok(refusedBy(r.validateEdit({ kind: "cargo_claim", reason: "Made-up" }, { ...stored, kind: "accident", preventable: null }, ctx), "PREVENTABLE_REQUIRED"), "moving onto a claim must state one");
		ok(refusedBy(r.validateEdit({ preventable: true, reason: "Made-up" }, { ...stored, kind: "accident", preventable: null }, ctx), "PREVENTABLE_NOT_ALLOWED"), "a mark on a row that isn't a claim is refused");
		ok(refusedBy(r.validateEdit({ kind: "accident" }, stored, ctx), "REASON_REQUIRED"), "an edit with no reason is refused");
		ok(refusedBy(r.validateEdit({ eventDate: "2026-11-12", reason: "Made-up" }, stored, ctx), "FUTURE_DATE"), "an edit can't move an event into the future");
		ok(refusedBy(r.validateEdit({ created_by: "x", reason: "Made-up" }, stored, ctx), "UNKNOWN_FIELD"), "an edit can't set a stored column");

		eq(r.listFilters({}).value, { month: null, driverId: null, includeVoided: false }, "no filters");
		eq(r.listFilters({ month: "2026-11", driverId: "7", includeVoided: "1" }).value, { month: "2026-11", driverId: 7, includeVoided: true }, "every filter");
		for (const [name, q, code] of [
			["a month with no leading zero", { month: "2026-1" }, "INVALID_MONTH"], ["month 13", { month: "2026-13" }, "INVALID_MONTH"], ["a repeated month", { month: ["2026-10", "2026-11"] }, "INVALID_MONTH"],
			["a driver id of 0", { driverId: "0" }, "INVALID_DRIVER"], ["a driver id with text", { driverId: "1 OR 1=1" }, "INVALID_DRIVER"], ["a repeated driver id", { driverId: ["1", "2"] }, "INVALID_DRIVER"],
			["includeVoided=true", { includeVoided: "true" }, "INVALID_FILTER"], ["includeVoided=0", { includeVoided: "0" }, "INVALID_FILTER"],
		]) ok(refusedBy(r.listFilters(q), code), `list: ${name} is refused ${code}`);
		ok(r.isRealDay("2028-02-29") && !r.isRealDay("2026-02-29"), "a leap day is real only in a leap year");
	});

	// ── §2 ──────────────────────────────────────────────────────────────────
	await section("2 the flag", async () => {
		const callers = [["signed out", null], ["a Driver", USERS.ada], ["an Investor", USERS.investor], ["a Dispatcher", USERS.dispatcher], ["a Super Admin", USERS.admin]];
		for (const [label, env] of [
			["unset", {}], ["empty", { [FLAG]: "" }], ['"false"', { [FLAG]: "false" }], ['"TRUE"', { [FLAG]: "TRUE" }], ['"True"', { [FLAG]: "True" }],
			['"1"', { [FLAG]: "1" }], ['"yes"', { [FLAG]: "yes" }], ['"on"', { [FLAG]: "on" }], ['" true"', { [FLAG]: " true" }], ['"true "', { [FLAG]: "true " }],
		]) {
			const w = await makeWorld(env);
			try {
				ok(!hasTable(w.db, "safety_events"), `${label}: no table`);
				ok(!hasTable(w.db, "idx_safety_events_date"), `${label}: no index`);
				const seen = [];
				for (const [who, user] of callers) {
					for (const [method, p, sent] of routesFor(1)) {
						const r = await w.req(method, p, user, sent);
						seen.push(r.status === 404 && r.json && r.json.code === "FEATURE_OFF" ? "off" : `${who} ${method} ${p} ${r.status}`);
					}
				}
				eq([...new Set(seen)], ["off"], `${label}: every route answers 404 FEATURE_OFF to every caller, signed out included`);
				ok(!hasTable(w.db, "safety_events"), `${label}: still no table after those calls`);
				eq(w.audit().length, 0, `${label}: no audit row`);
				eq(w.db.prepare("SELECT total_changes() AS n").get().n, w.changesBeforeMount, `${label}: the mount and those calls wrote nothing at all`);
			} finally {
				await w.close();
			}
		}
		const w = await on();
		try {
			ok(hasTable(w.db, "safety_events"), 'exactly "true": the table is there');
			eq((await w.req("GET", LIST, USERS.admin)).status, 200, 'exactly "true": the routes answer');
		} finally { await w.close(); }

		// Switched off again: the rows stay, and nothing answers.
		const w2 = await makeWorld({}, { prepare: (db) => {
			db.exec(need().SCHEMA_SQL);
			db.prepare("INSERT INTO safety_events (directory_id, name_when_recorded, event_date, kind, record_reason, created_by, created_by_user_id, created_at) VALUES (1, 'Ada Quill', '2026-11-05', 'accident', 'Made-up', 'admin', 31, '2026-11-05T12:00:00.000Z')").run();
		} });
		try {
			eq((await w2.req("GET", LIST, USERS.admin)).json.code, "FEATURE_OFF", "off with rows on file: still absent");
			eq(w2.rows().length, 1, "and the rows are left alone");
		} finally { await w2.close(); }
	});

	// ── §3 ──────────────────────────────────────────────────────────────────
	await section("3 the role matrix", async () => {
		const w = await on();
		try {
			const made = await w.req("POST", LIST, USERS.admin, GOOD);
			eq(made.status, 201, "(setup) a Super Admin records an event");
			const id = made.json.event.id;
			const before = JSON.stringify(w.rows());
			const auditBefore = w.audit().length;
			const refusals = [["signed out", null, 401], ["a Driver", USERS.ada, 403], ["another Driver", USERS.ben, 403], ["an Investor", USERS.investor, 403], ["a KPI Viewer", USERS.kpi, 403], ["an account with no role", { id: 71, username: "x" }, 403]];
			for (const [method, p, sent] of routesFor(id)) {
				for (const [who, user, want] of refusals) {
					const r = await w.req(method, p, user, sent);
					eq(r.status, want, `${method} ${p.replace(String(id), ":id")}: ${who} gets ${want}`);
					ok(!r.text.includes("gate") && !r.text.includes("Ada") && !r.json.event && !r.json.events, "...and no part of the log", r.text);
				}
			}
			eq((await w.req("GET", LIST, USERS.dispatcher)).status, 200, "a Dispatcher reads");
			eq((await w.req("GET", LIST, USERS.dispatcher)).json.events.map((e) => e.id), [id], "...the log itself");
			for (const [method, p, sent] of routesFor(id).slice(1)) {
				eq((await w.req(method, p, USERS.dispatcher, sent)).status, 403, `${method} ${p.replace(String(id), ":id")}: a Dispatcher can't write`);
			}
			eq(JSON.stringify(w.rows()), before, "no refused caller changed a row");
			eq(w.audit().length, auditBefore, "and none left an audit row");
			eq((await w.req("GET", `${LIST}?as_user_id=31`, USERS.ada)).status, 403, "?as_user_id= is no way in for a Driver");
			eq((await w.req("GET", `${LIST}?driverId=1`, USERS.ada)).status, 403, "nor is asking for his own events");

			const csrf = await w.req("POST", LIST, USERS.admin, GOOD, { noCsrfHeader: true });
			eq([csrf.status, csrf.json.code], [403, "CSRF_HEADER_REQUIRED"], "a write with no X-Requested-With is refused");
			const pw = await w.req("POST", LIST, { ...USERS.admin, mustChangePassword: true }, GOOD);
			eq([pw.status, pw.json.code], [403, "PASSWORD_CHANGE_REQUIRED"], "an account that must change its password can't write");
			eq(JSON.stringify(w.rows()), before, "neither wrote");

			const del = await w.req("DELETE", `${LIST}/${id}`, USERS.admin);
			eq(del.status, 404, "DELETE isn't a route, even for a Super Admin");
			eq(JSON.stringify(w.rows()), before, "and the row is still there");
			const patch = await w.req("PATCH", `${LIST}/${id}`, USERS.admin, { kind: "accident" });
			eq(patch.status, 404, "PATCH isn't a route");
		} finally { await w.close(); }
	});

	// ── §4 ──────────────────────────────────────────────────────────────────
	await section("4 create", async () => {
		const w = await on();
		try {
			const r = await w.req("POST", LIST, USERS.admin, GOOD);
			eq(r.status, 201, "201");
			eq(r.json.success, true, "success");
			eq(Object.keys(r.json.event), OFFICE_VIEW_KEYS, "the event's keys");
			const e = r.json.event;
			eq([e.driverId, e.driverName, e.eventDate, e.kind, e.kindLabel, e.preventable, e.details, e.recordReason], [1, "Ada Quill", "2026-11-05", "accident", "Accident", null, "Backed into a made-up gate.", "Made-up report received"], "the event as stored, its name from the directory");
			eq([e.createdBy, e.updatedBy, e.updatedAt, e.updateReason, e.voided, e.voidedBy, e.voidedAt, e.voidReason], ["admin", null, null, null, false, null, null, null], "who recorded it; not edited, not voided");
			ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.createdAt), "the timestamp is ISO-8601 with a Z");
			const row = w.rows()[0];
			eq([row.directory_id, row.name_when_recorded, row.created_by_user_id, row.preventable], [1, "Ada Quill", 31, null], "the row: the driver's id and the name then, the account");

			const audit = w.audit();
			eq(audit.length, 1, "one audit row");
			eq([audit[0].action, audit[0].entity, audit[0].entity_id, audit[0].username, audit[0].role, audit[0].user_id], ["safety_event_create", "safety_event", String(e.id), "admin", "Super Admin", 31], "whose, on what");
			ok(audit[0].details.includes("Made-up report received"), "the audit row holds the reason");
			ok(audit[0].details.includes("driver #1") && audit[0].details.includes("accident") && audit[0].details.includes("2026-11-05"), "and what was recorded");

			const claim = await w.req("POST", LIST, USERS.admin, CLAIM);
			eq([claim.status, claim.json.event.preventable, claim.json.event.kindLabel], [201, true, "Cargo claim"], "a preventable claim");
			ok(w.audit()[1].details.includes(", preventable."), "its audit row says so");
			const notClaim = await w.req("POST", LIST, USERS.admin, { ...CLAIM, preventable: false });
			eq(notClaim.json.event.preventable, false, "a claim marked not preventable stays false, not null");
			ok(w.audit()[2].details.includes("not preventable"), "its audit row says so");
			eq(w.rows().filter((x) => x.kind === "cargo_claim").map((x) => x.preventable), [1, 0], "stored as 1 and 0");

			for (const [name, body, status, code] of [
				["no reason", { ...GOOD, reason: undefined }, 400, "REASON_REQUIRED"], ["an unknown driver", { ...GOOD, driverId: 999 }, 404, "DRIVER_NOT_FOUND"],
				["a future date", { ...GOOD, eventDate: "2026-11-12" }, 400, "FUTURE_DATE"], ["a bad kind", { ...GOOD, kind: "x" }, 400, "INVALID_KIND"], ["an unknown field", { ...GOOD, id: 99 }, 400, "UNKNOWN_FIELD"],
			]) {
				const n = w.rows().length;
				const a = w.audit().length;
				const bad = await w.req("POST", LIST, USERS.admin, body);
				eq([bad.status, bad.json.code], [status, code], `${name}: ${status} ${code}`);
				eq([w.rows().length, w.audit().length], [n, a], "...nothing written");
			}
			const noBody = await w.req("POST", LIST, USERS.admin);
			eq([noBody.status, noBody.json.code], [400, "REASON_REQUIRED"], "no body at all: the JSON parser's empty object, refused for its missing reason");

			// Stored as text and handed back: never part of a statement.
			const sql = "Made-up'); DROP TABLE safety_events;--";
			const inj = await w.req("POST", LIST, USERS.admin, { ...GOOD, details: sql, reason: sql });
			eq([inj.status, inj.json.event.details, inj.json.event.recordReason], [201, sql, sql], "text shaped like SQL is stored as text");
			ok(hasTable(w.db, "safety_events"), "and the table is still there");
		} finally { await w.close(); }
	});

	// ── §5 ──────────────────────────────────────────────────────────────────
	await section("5 edit", async () => {
		const w = await on();
		try {
			const id = (await w.req("POST", LIST, USERS.admin, GOOD)).json.event.id;
			const put = (body, user = USERS.admin) => w.req("PUT", `${LIST}/${id}`, user, body);
			const noReason = await put({ kind: "moving_violation" });
			eq([noReason.status, noReason.json.code], [400, "REASON_REQUIRED"], "no reason: 400");
			eq(w.rows()[0].kind, "accident", "...nothing changed");

			const r = await put({ kind: "moving_violation", reason: "Made-up correction" });
			eq([r.status, r.json.changed, r.json.event.kind, r.json.event.eventDate, r.json.event.details], [200, true, "moving_violation", "2026-11-05", "Backed into a made-up gate."], "a partial body changes only what it names");
			eq([r.json.event.updatedBy, r.json.event.updateReason, r.json.event.recordReason, r.json.event.createdBy], ["admin", "Made-up correction", "Made-up report received", "admin"], "who and why are kept; the original record's are untouched");
			ok(r.json.event.updatedAt, "and when");
			let last = w.audit().at(-1);
			eq([last.action, last.entity, last.entity_id, last.username], ["safety_event_edit", "safety_event", String(id), "admin"], "an audit row");
			ok(last.details.includes("kind accident -> moving_violation"), "it holds old and new");
			ok(last.details.includes("Reason: Made-up correction"), "and the reason");

			const a = w.audit().length;
			const stamped = w.rows()[0].updated_at;
			const same = await put({ kind: "moving_violation", reason: "Made-up again" });
			eq([same.status, same.json.changed], [200, false], "a body that changes nothing answers changed: false");
			eq(w.audit().length, a, "...no audit row");
			eq([w.rows()[0].update_reason, w.rows()[0].updated_at], ["Made-up correction", stamped], "...and the row isn't touched");

			await put({ details: "New made-up text", reason: "Made-up detail fix" });
			last = w.audit().at(-1);
			ok(last.details.includes(JSON.stringify("Backed into a made-up gate.")) && last.details.includes(JSON.stringify("New made-up text")), "a text edit's audit row holds the old text, which the row no longer does");

			await put({ eventDate: "2026-11-03", reason: "Made-up date fix" });
			eq(w.rows()[0].event_date, "2026-11-03", "the date moves");
			ok(w.audit().at(-1).details.includes("date 2026-11-05 -> 2026-11-03"), "and the audit row says so");

			const moved = await put({ driverId: 2, reason: "Made-up driver fix" });
			eq([moved.json.event.driverId, moved.json.event.driverName, w.rows()[0].name_when_recorded], [2, "Ben Marsh", "Ben Marsh"], "the driver moves, and the kept name with him");
			ok(w.audit().at(-1).details.includes("driver #1 -> #2"), "and the audit row says so");
			const gone = await put({ driverId: 999, reason: "Made-up driver fix" });
			eq([gone.status, gone.json.code, w.rows()[0].directory_id], [404, "DRIVER_NOT_FOUND", 2], "an unknown driver: 404, nothing changed");

			const claim = await put({ kind: "cargo_claim", preventable: true, reason: "Made-up reclass" });
			eq([claim.status, w.rows()[0].preventable], [200, 1], "onto a claim, with its mark");
			ok(w.audit().at(-1).details.includes("mark none -> preventable"), "the audit row shows the mark");
			const flip = await put({ preventable: false, reason: "Made-up reclass" });
			eq([flip.status, w.rows()[0].preventable], [200, 0], "the mark can change");
			ok(w.audit().at(-1).details.includes("mark preventable -> not preventable"), "and the audit row shows it");
			const off = await put({ kind: "accident", reason: "Made-up reclass" });
			eq([off.status, w.rows()[0].preventable], [200, null], "off a claim, its mark goes");

			for (const [name, body] of [["voided_at", { voided_at: "2026-01-01", reason: "Made-up" }], ["created_by", { created_by: "x", reason: "Made-up" }], ["id", { id: 9, reason: "Made-up" }], ["directory_id", { directory_id: 9, reason: "Made-up" }]]) {
				const bad = await put(body);
				eq([bad.status, bad.json.code], [400, "UNKNOWN_FIELD"], `${name} can't be set: 400`);
			}
			// Spellings Number() would read as this row's own id are refused too.
			eq(id, 1, "(setup) this event's id is 1");
			for (const raw of ["999", "0", "abc", "1abc", "-1", "1.5", "1e3", "1e0", "0x1", "01", "%201", "1.0"]) {
				const bad = await w.req("PUT", `${LIST}/${raw}`, USERS.admin, { kind: "accident", reason: "Made-up" });
				eq([bad.status, bad.json.code], [404, "SAFETY_EVENT_NOT_FOUND"], `PUT id ${raw}: 404`);
				const bad2 = await w.req("POST", `${LIST}/${raw}/void`, USERS.admin, { reason: "Made-up" });
				eq([bad2.status, bad2.json.code], [404, "SAFETY_EVENT_NOT_FOUND"], `void id ${raw}: 404`);
			}
		} finally { await w.close(); }
	});

	// ── §6 ──────────────────────────────────────────────────────────────────
	await section("6 void", async () => {
		const w = await on();
		try {
			const id = (await w.req("POST", LIST, USERS.admin, GOOD)).json.event.id;
			const kept = await w.req("POST", LIST, USERS.admin, CLAIM);
			const voidIt = (body) => w.req("POST", `${LIST}/${id}/void`, USERS.admin, body);
			for (const [name, body] of [["no body", undefined], ["no reason", {}], ["a blank reason", { reason: "   " }]]) {
				const bad = await voidIt(body);
				eq(bad.status, 400, `${name}: 400`);
				eq(w.rows()[0].voided_at, null, "...not voided");
			}
			const a = w.audit().length;
			const r = await voidIt({ reason: "Entered in error, made up" });
			eq([r.status, r.json.event.voided, r.json.event.voidedBy, r.json.event.voidReason], [200, true, "admin", "Entered in error, made up"], "voided, by whom and why");
			ok(r.json.event.voidedAt, "and when");
			eq(w.rows().length, 2, "the row stays in the table");
			eq([w.rows()[0].kind, w.rows()[0].details, w.rows()[0].voided_by_user_id], ["accident", "Backed into a made-up gate.", 31], "with everything it held");
			eq(w.audit().length, a + 1, "one audit row");
			const last = w.audit().at(-1);
			eq([last.action, last.entity, last.entity_id, last.username], ["safety_event_void", "safety_event", String(id), "admin"], "whose, on what");
			ok(last.details.includes("Entered in error, made up"), "it holds the reason");

			eq((await w.req("GET", LIST, USERS.dispatcher)).json.events.map((e) => e.id), [kept.json.event.id], "a voided event is off the list");
			const all = (await w.req("GET", `${LIST}?includeVoided=1`, USERS.dispatcher)).json.events;
			eq(all.map((e) => [e.id, e.voided]), [[kept.json.event.id, false], [id, true]], "and on it with includeVoided=1");

			const again = await voidIt({ reason: "Made-up second void" });
			eq([again.status, again.json.code], [409, "SAFETY_EVENT_VOIDED"], "voiding twice: 409");
			eq(w.rows()[0].void_reason, "Entered in error, made up", "the first reason stands");
			const edit = await w.req("PUT", `${LIST}/${id}`, USERS.admin, { kind: "moving_violation", reason: "Made-up" });
			eq([edit.status, edit.json.code, w.rows()[0].kind], [409, "SAFETY_EVENT_VOIDED", "accident"], "editing a voided event: 409, nothing changed");
			eq(w.audit().length, a + 1, "neither refusal added an audit row");

			const src = fs.readFileSync(path.join(ROOT, "lib", "safety-event-log.js"), "utf8");
			ok(!/\bDELETE\b/.test(src.replace(/^\s*\/\/.*$/gm, "")), "the module holds no DELETE statement and no DELETE route");
			ok(!/\bTRUNCATE\b|\bDROP\b/.test(src), "and no DROP");
		} finally { await w.close(); }
	});

	// ── §7 ──────────────────────────────────────────────────────────────────
	await section("7 closed months", async () => {
		const w = await on();
		try {
			lock(w.db, "2026-09");
			const ev = (day) => ({ ...GOOD, eventDate: day });
			const a0 = w.audit().length;
			const refused = await w.req("POST", LIST, USERS.admin, ev("2026-09-15"));
			eq([refused.status, refused.json.code, refused.json.month], [409, "PERIOD_FINALIZED", "2026-09"], "recording an event in a closed month: 409");
			eq(w.rows().length, 0, "...no row");
			eq(w.audit().length, a0 + 1, "...one refusal row");
			let last = w.audit().at(-1);
			eq([last.action, last.entity], ["safety_event_write_blocked", "safety_event"], "the refusal is audited");
			ok(last.details.includes("[PERIOD_FINALIZED]"), "under the code the purge exempts");
			await w.req("POST", LIST, USERS.admin, ev("2026-09-16"));
			eq(w.audit().length, a0 + 2, "a second refusal within the minute gets its own row");

			// A month closes after its events were recorded.
			const inOct = (await w.req("POST", LIST, USERS.admin, ev("2026-10-15"))).json.event.id;
			const inNov = (await w.req("POST", LIST, USERS.admin, ev("2026-11-05"))).json.event.id;
			eq(w.rows().length, 2, "(setup) open months take events");
			lock(w.db, "2026-10");
			const before = JSON.stringify(w.rows());
			const n = w.audit().length;
			const edit = await w.req("PUT", `${LIST}/${inOct}`, USERS.admin, { kind: "moving_violation", reason: "Made-up" });
			eq([edit.status, edit.json.code, edit.json.month], [409, "PERIOD_FINALIZED", "2026-10"], "editing an event of a closed month: 409");
			const out = await w.req("PUT", `${LIST}/${inOct}`, USERS.admin, { eventDate: "2026-11-02", reason: "Made-up" });
			eq([out.status, out.json.code], [409, "PERIOD_FINALIZED"], "moving one out of a closed month: 409");
			const into = await w.req("PUT", `${LIST}/${inNov}`, USERS.admin, { eventDate: "2026-10-20", reason: "Made-up" });
			eq([into.status, into.json.code, into.json.month], [409, "PERIOD_FINALIZED", "2026-10"], "moving one into a closed month: 409");
			const voided = await w.req("POST", `${LIST}/${inOct}/void`, USERS.admin, { reason: "Made-up" });
			eq([voided.status, voided.json.code], [409, "PERIOD_FINALIZED"], "voiding one in a closed month: 409");
			eq(JSON.stringify(w.rows()), before, "none of them changed a row");
			eq(w.audit().length, n + 4, "each left a refusal row");
			ok(w.audit().slice(-4).every((x) => x.action === "safety_event_write_blocked" && x.details.includes("[PERIOD_FINALIZED]")), "under the same action and code");

			const read = await w.req("GET", `${LIST}?month=2026-10`, USERS.dispatcher);
			eq([read.status, read.json.events.map((e) => e.id)], [200, [inOct]], "a closed month's events can still be read");

			lock(w.db, "2026-10", "reopened");
			const reopened = await w.req("PUT", `${LIST}/${inOct}`, USERS.admin, { kind: "moving_violation", reason: "Made-up" });
			eq([reopened.status, reopened.json.changed], [200, true], "a reopened month is open");
			const open = await w.req("PUT", `${LIST}/${inNov}`, USERS.admin, { eventDate: "2026-11-04", reason: "Made-up" });
			eq(open.status, 200, "an open month's event moves within open months");
		} finally { await w.close(); }

		// A lock table that can't be read counts as closed.
		const u = await on();
		try {
			const id = (await u.req("POST", LIST, USERS.admin, GOOD)).json.event.id;
			u.db.exec("ALTER TABLE period_locks RENAME TO period_locks_made_up");
			const before = JSON.stringify(u.rows());
			const n = u.audit().length;
			const results = [
				await u.req("POST", LIST, USERS.admin, GOOD),
				await u.req("PUT", `${LIST}/${id}`, USERS.admin, { kind: "moving_violation", reason: "Made-up" }),
				await u.req("POST", `${LIST}/${id}/void`, USERS.admin, { reason: "Made-up" }),
			];
			eq(results.map((r) => [r.status, r.json.code]), Array(3).fill([409, "PERIOD_LOCK_UNREADABLE"]), "locks unreadable: create, edit and void all refused 409");
			eq(JSON.stringify(u.rows()), before, "nothing written");
			ok(u.audit().slice(n).length === 3 && u.audit().slice(n).every((x) => x.details.includes("[PERIOD_LOCK_UNREADABLE]")), "each audited under its code");
			eq((await u.req("GET", LIST, USERS.dispatcher)).status, 200, "reads still answer");
		} finally { await u.close(); }
	});

	// ── §8 ──────────────────────────────────────────────────────────────────
	await section("8 no driver sees any of it", async () => {
		const w = await on();
		try {
			const shots = async () => {
				w.fns.driverPerformance.clearCache();
				const out = {};
				for (const who of ["ada", "ben"]) {
					out[`${who} board week`] = (await w.req("GET", "/api/driver/performance/leaderboard?period=week", USERS[who])).text;
					out[`${who} board month`] = (await w.req("GET", "/api/driver/performance/leaderboard?period=month", USERS[who])).text;
					out[`${who} own week`] = (await w.req("GET", "/api/driver/me/performance", USERS[who])).text;
				}
				out["report week"] = (await w.req("GET", "/api/admin/driver-performance?period=week", USERS.admin)).text;
				out["report month"] = (await w.req("GET", "/api/admin/driver-performance?period=month", USERS.admin)).text;
				return out;
			};
			const clean = await shots();
			ok(JSON.parse(clean["ada board week"]).boards.length > 0, "(setup) the board answers");
			ok(clean["ada board week"].includes('"isYou":true'), "(setup) with Ada on it");
			const events = [
				{ driverId: 1, eventDate: "2026-11-09", kind: "accident", details: "Made-up detail one", reason: "Made-up reason one" },
				{ driverId: 1, eventDate: "2026-11-10", kind: "hos_violation", details: "Made-up detail two", reason: "Made-up reason two" },
				{ driverId: 2, eventDate: "2026-11-10", kind: "cargo_claim", preventable: true, details: "Made-up detail three", reason: "Made-up reason three" },
			];
			const ids = [];
			for (const e of events) ids.push((await w.req("POST", LIST, USERS.admin, e)).json.event.id);
			eq(ids.length, 3, "(setup) three events on file");
			const logged = await shots();
			for (const k of Object.keys(clean)) eq(logged[k], clean[k], `${k}: byte-identical with events on file`);
			await w.req("POST", `${LIST}/${ids[0]}/void`, USERS.admin, { reason: "Made-up void" });
			const after = await shots();
			for (const k of Object.keys(clean)) eq(after[k], clean[k], `${k}: byte-identical after a void`);
			for (const [k, text] of Object.entries(logged)) ok(!/Made-up (detail|reason)|accident|hos_violation|cargo_claim/.test(text), `${k}: no word of the log`);

			const direct = await w.req("GET", LIST, USERS.ada);
			eq([direct.status, direct.text], [403, '{"error":"Forbidden"}'], "asked directly, a Driver gets a bare 403");
		} finally { await w.close(); }

		// By source: nothing else names the table, the routes or the module.
		const server = require("./lib/server-source").serverSource();
		eq((server.match(/require\("\.\/lib\/safety-event-log"\)/g) || []).length, 1, "server.js requires the module once");
		ok(!/safety_events/.test(server), "server.js never names the table");
		ok(!/\/api\/safety-events/.test(server), "server.js never names the routes");
		const stray = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f !== "safety-event-log.js" && /\.(c|m)?js$/.test(f))
			.filter((f) => /safety_events|safety-event|safetyEvent/.test(fs.readFileSync(path.join(ROOT, "lib", f), "utf8")));
		eq(stray.filter((f) => f !== "replica-rules.js"), [], "no other lib/ file names it");
		const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
			const p = path.join(dir, e.name);
			return e.isDirectory() ? walk(p) : [p];
		});
		const clientDir = path.join(ROOT, "client", "src");
		const clientFiles = walk(clientDir);
		ok(clientFiles.length > 50, "(check) client/src was read");
		eq(clientFiles.filter((f) => /safety_events|safety-event|safetyEvent/i.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f)), [], "no screen calls it");
	});

	// ── §9 ──────────────────────────────────────────────────────────────────
	await section("9 nothing reaches pay", async () => {
		const w = await on();
		try {
			const snapshot = () => {
				const out = {};
				for (const { name } of w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('safety_events', 'audit_trail', 'sqlite_sequence')").all()) {
					out[name] = w.db.prepare(`SELECT * FROM "${name}"`).all();
				}
				return JSON.stringify(out);
			};
			const before = snapshot();
			const id = (await w.req("POST", LIST, USERS.admin, GOOD)).json.event.id;
			await w.req("PUT", `${LIST}/${id}`, USERS.admin, { kind: "hos_violation", reason: "Made-up" });
			await w.req("POST", `${LIST}/${id}/void`, USERS.admin, { reason: "Made-up" });
			await w.req("GET", LIST, USERS.dispatcher);
			eq(snapshot(), before, "a create, an edit, a void and a read change no other table");
		} finally { await w.close(); }

		const src = fs.readFileSync(path.join(ROOT, "lib", "safety-event-log.js"), "utf8");
		const named = [...src.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)/g)].map((m) => m[1]);
		eq([...new Set(named)].sort(), ["audit_trail", "drivers_directory", "safety_events"], "the module's statements name only its table, the directory and the audit trail");
		const writes = [...src.matchAll(/\b(?:INTO|UPDATE)\s+([a-z_]+)/g)].map((m) => m[1]);
		eq([...new Set(writes)], ["safety_events"], "and write only its table");
		eq([...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]), ["express-rate-limit"], "it needs no pay, invoice or ledger module");
		const server = require("./lib/server-source").serverSource();
		const decl = (server.match(/const safetyEventLog = [\s\S]*?\n\}\);/) || [""])[0];
		ok(!/invoice|payout|ledger|expense|getJobTracking|sendEmail|notifyChange/i.test(decl), "its mount hands it nothing of pay, the sheet, mail or sockets");
	});

	// ── §10 ─────────────────────────────────────────────────────────────────
	await section("10 no audit row, no write", async () => {
		const w = await on();
		const realError = console.error;
		const errors = [];
		console.error = (...a) => errors.push(a.join(" "));
		try {
			const id = (await w.req("POST", LIST, USERS.admin, GOOD)).json.event.id;
			const before = JSON.stringify(w.rows());
			w.db.exec("CREATE TRIGGER made_up_audit_refuses BEFORE INSERT ON audit_trail BEGIN SELECT RAISE(ABORT, 'made-up'); END");
			const secret = "Made-up words only the reason holds";
			const results = [
				await w.req("POST", LIST, USERS.admin, { ...GOOD, reason: secret }),
				await w.req("PUT", `${LIST}/${id}`, USERS.admin, { kind: "moving_violation", reason: secret }),
				await w.req("POST", `${LIST}/${id}/void`, USERS.admin, { reason: secret }),
			];
			eq(results.map((r) => [r.status, r.json.code]), Array(3).fill([500, "SAFETY_EVENT_FAILED"]), "audit_trail refuses: create, edit and void each answer 500");
			eq(JSON.stringify(w.rows()), before, "and each rolled back");
			ok(errors.length >= 3, "each is logged");
			ok(!errors.join(" ").includes(secret), "with no word of the reason");
			w.db.exec("DROP TRIGGER made_up_audit_refuses");
			eq((await w.req("POST", `${LIST}/${id}/void`, USERS.admin, { reason: "Made-up" })).status, 200, "audit_trail back: the same write goes through");
		} finally {
			console.error = realError;
			await w.close();
		}
	});

	// ── §11 ─────────────────────────────────────────────────────────────────
	await section("11 the list", async () => {
		const w = await on();
		try {
			const add = async (driverId, eventDate, kind = "accident") => (await w.req("POST", LIST, USERS.admin, { driverId, eventDate, kind, reason: "Made-up" })).json.event.id;
			const a = await add(1, "2026-10-20");
			const b = await add(2, "2026-11-05");
			const c = await add(1, "2026-11-05", "hos_violation");
			const d = await add(3, "2026-11-01");
			const list = (q, user = USERS.dispatcher) => w.req("GET", `${LIST}${q}`, user);
			const r = await list("");
			eq(r.json.events.map((e) => e.id), [c, b, d, a], "newest date first, the later entry first on a tie");
			eq(r.json.truncated, false, "not truncated");
			eq(Object.keys(r.json), ["events", "truncated"], "the answer's keys");
			eq(Object.keys(r.json.events[0]), OFFICE_VIEW_KEYS, "the same keys a Super Admin gets");
			eq((await list("", USERS.admin)).text, r.text, "a Dispatcher reads what a Super Admin reads");
			eq(r.headers["cache-control"], "private, no-store", "a read isn't cached");
			eq((await list("?month=2026-11")).json.events.map((e) => e.id), [c, b, d], "by month");
			eq((await list("?month=2026-10")).json.events.map((e) => e.id), [a], "another month");
			eq((await list("?month=2026-01")).json.events, [], "a month with none");
			eq((await list("?driverId=1")).json.events.map((e) => e.id), [c, a], "by driver");
			eq((await list("?month=2026-11&driverId=1")).json.events.map((e) => e.id), [c], "both");
			eq((await list("?driverId=999")).json.events, [], "a driver with none");
			for (const [q, code] of [
				["?month=x", "INVALID_MONTH"], ["?month=2026-11'%20OR%201=1--", "INVALID_MONTH"], ["?month=2026-10&month=2026-11", "INVALID_MONTH"], ["?month[a]=1", "INVALID_MONTH"],
				["?driverId=1%20OR%201=1", "INVALID_DRIVER"], ["?driverId=abc", "INVALID_DRIVER"], ["?includeVoided=true", "INVALID_FILTER"],
			]) {
				const bad = await list(q);
				eq([bad.status, bad.json.code], [400, code], `${q}: 400 ${code}`);
			}
			eq((await w.req("POST", LIST, USERS.admin, GOOD)).headers["cache-control"], "private, no-store", "a write's answer isn't cached");

			// The directory's rename and hard delete, which never touch this table.
			w.db.prepare("UPDATE drivers_directory SET driver_name = 'Ada Quill-Stone' WHERE id = 1").run();
			eq((await list(`?month=2026-10`)).json.events[0].driverName, "Ada Quill-Stone", "a renamed driver reads under the current name");
			w.db.prepare("DELETE FROM drivers_directory WHERE id = 3").run();
			const orphan = (await list("?driverId=3")).json.events;
			eq([orphan.length, orphan[0].driverName, orphan[0].driverId], [1, "Cal Reyes", 3], "a deleted driver's event stays, under the name kept when it was recorded");
			const editOrphan = await w.req("PUT", `${LIST}/${d}`, USERS.admin, { kind: "moving_violation", reason: "Made-up" });
			eq([editOrphan.status, editOrphan.json.event.driverName], [200, "Cal Reyes"], "and can still be corrected");
			const voidOrphan = await w.req("POST", `${LIST}/${d}/void`, USERS.admin, { reason: "Made-up" });
			eq(voidOrphan.status, 200, "or voided");
			ok(w.audit().at(-1).details.includes("Cal Reyes"), "and its audit row keeps the name");
		} finally { await w.close(); }

		const big = await on();
		try {
			const cap = need().LIST_LIMIT;
			const ins = big.db.prepare("INSERT INTO safety_events (directory_id, name_when_recorded, event_date, kind, record_reason, created_by, created_by_user_id, created_at) VALUES (1, 'Ada Quill', '2026-11-05', 'accident', 'Made-up', 'admin', 31, '2026-11-05T12:00:00.000Z')");
			big.db.transaction(() => { for (let i = 0; i < cap; i++) ins.run(); })();
			const full = await big.req("GET", LIST, USERS.dispatcher);
			eq([full.json.events.length, full.json.truncated], [cap, false], "exactly the cap: not truncated");
			ins.run();
			const over = await big.req("GET", LIST, USERS.dispatcher);
			eq([over.json.events.length, over.json.truncated], [cap, true], "one over: capped and it says so");
		} finally { await big.close(); }
	});

	// ── §12 ─────────────────────────────────────────────────────────────────
	await section("12 the rate limit", async () => {
		const w = await on();
		try {
			const limit = need().RATE_LIMIT;
			eq(limit, 120, "120 requests per 15 minutes per account");
			const statuses = [];
			for (let i = 0; i < limit + 1; i++) statuses.push((await w.req("GET", LIST, USERS.dispatcher)).status);
			eq(statuses.slice(0, limit).every((s) => s === 200), true, "the first 120 answer");
			const over = await w.req("GET", LIST, USERS.dispatcher);
			eq([statuses[limit], over.status, over.json.code], [429, 429, "SAFETY_EVENT_RATE_LIMITED"], "the 121st doesn't");
			const id = (await w.req("POST", LIST, USERS.admin, GOOD)).json.event.id;
			eq(id > 0, true, "another account keeps its own count");
			// One account's reads use up its writes too, on every write route.
			const heavy = { id: 32, role: "Super Admin", username: "admin2" };
			for (let i = 0; i < limit; i++) await w.req("GET", LIST, heavy);
			const rows = JSON.stringify(w.rows());
			for (const [method, p, sent] of routesFor(id)) {
				const r = await w.req(method, p, heavy, sent);
				eq([r.status, r.json.code], [429, "SAFETY_EVENT_RATE_LIMITED"], `${method} ${p.replace(String(id), ":id")}: limited`);
			}
			eq(JSON.stringify(w.rows()), rows, "a limited write writes nothing");
			const refused = [];
			for (let i = 0; i < limit + 1; i++) refused.push((await w.req("GET", LIST, USERS.ada)).status);
			eq([...new Set(refused)], [403], "a refused caller reaches no limiter: 403 every time");
		} finally { await w.close(); }
	});

	// ── §13 ─────────────────────────────────────────────────────────────────
	await section("13 wiring", () => {
		const server = require("./lib/server-source").serverSource();
		const at = server.indexOf("const safetyEventLog = ");
		ok(at > 0, "server.js has the declaration");
		ok(at > 0 && at < server.indexOf('app.get("*", '), "above the catch-all");
		eq((server.match(/SAFETY_EVENT_LOG_ENABLED/g) || []).length, 1, "the flag is read in one place");
		ok(server.includes('enabled: process.env.SAFETY_EVENT_LOG_ENABLED === "true",'), 'with the exact "true" shape');
		const rulesFile = require(path.join(ROOT, "lib", "replica-rules.js"));
		ok(rulesFile.ENABLE_ALLOWED.includes(FLAG), "the replica's --enable allowlist takes it");
		eq(rulesFile.enableRefusal(FLAG), null, "and doesn't refuse it");

		const fixture = fs.readFileSync(path.join(ROOT, "scripts", "fixtures", "route-snapshot.txt"), "utf8").split("\n").filter((l) => /\/api\/safety-events/.test(l));
		eq(fixture.map((l) => l.split(" · ")[0].split(" ").slice(0, 2).join(" ")).sort(),
			["GET /api/safety-events", "POST /api/safety-events", "POST /api/safety-events/:id/void", "PUT /api/safety-events/:id"], "the route snapshot holds the four routes, and no DELETE");
		ok(fixture.length === 4 && fixture.every((l) => /· safetyEventFlagGate\b[^·]*· anon\b[^·]*· limiter\b/.test(l)), "each runs the flag gate, then the role gate, then the limiter", fixture.join("\n"));

		const r = need();
		const app = { get() {}, post() {}, put() {} };
		const fullDeps = { db: { prepare() {}, exec() {} }, requireRole() {}, logAudit() {}, logAuditRefusal() {}, periodWriteLocked() {}, periodLocksReadable() {}, appTodayKey() {} };
		for (const missing of Object.keys(fullDeps)) {
			const partial = { ...fullDeps };
			delete partial[missing];
			let threw = null;
			try { r.mount(app, partial); } catch (e) { threw = e.message; }
			ok(threw && threw.includes(missing), `mount refuses to start without ${missing}`);
		}
		let executed = 0;
		r.mount(app, { ...fullDeps, enabled: "true", db: { prepare() { throw new Error("no"); }, exec() { executed += 1; } } });
		eq(executed, 0, 'mount wants the boolean true: the text "true" creates no table');
	});

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) {
		console.log(failures.map((f) => `  - ${f}`).join("\n"));
		process.exit(1);
	}
	process.exit(0);
})();
