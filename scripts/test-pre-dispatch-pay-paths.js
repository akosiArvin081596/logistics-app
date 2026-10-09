#!/usr/bin/env node
/**
 * The pre-dispatch pay-day rule on the three pay paths, with the flag on and its
 * start month set (PRE_DISPATCH_PAY_DAY_RULE_ENABLED, PRE_DISPATCH_PAY_DAY_RULE_FROM).
 *
 * The weekly invoice (POST /api/invoices/generate), the investor view (GET
 * /api/investor) and the payout ledger (computeInvestorMonthlyEarnings(), behind
 * payouts and Financials) each turn a load's window into paid days. They run
 * here as the server runs them: lifted from server.js (scripts/lib/server-lift.js)
 * with the environment the server would read, on one in-memory SQLite built from
 * server.js's own DDL and one Job Tracking sheet. Investor 5 owns four trucks;
 * the week is Sat 2026-09-26 to Fri 2026-10-02; FROM is 2026-10:
 *   L1  Ann  assigned 10-01, window 09-30..10-02, dispatched 10-01. On 09-30 the
 *            truck moved 12 km in Dallas and never went near the pickup: that day
 *            stops paying. It settles in October, so the rule applies to it.
 *   L2  Bo   assigned 09-27, window 09-26..09-28, the same idle day before
 *            dispatch on 09-26. It settles in September, before FROM: every day
 *            pays, whether September is open or closed.
 *   L3  Cy   assigned 10-01, window 09-29..10-01, dispatched 09-30. On 09-29 the
 *            ELD went dark for 8 hours while the odometer moved 200 miles (a jump
 *            the odometer walk rejects): the distance is unknown, so it pays.
 *   L4  Di   assigned 10-01, window 09-29..09-30. No Dispatched row, only a
 *            Delivered tap on 10-01: no dispatch is known, so every day pays.
 *
 *   §1 the three paths pay exactly the expected days, load by load, and agree
 *   §2 closing September, or September and October, changes nothing on any
 *      path: whether the rule applies is decided by the settle month against
 *      FROM, never by a month lock
 *   §3 flag on with FROM unset or not a month: the rule is off on every path (the
 *      same days as the flag off) and the start logs one warning naming the
 *      setting, never its value
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-pre-dispatch-pay-paths.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");

function die(msg) { console.error(`SETUP FAILED: ${msg}`); process.exit(1); }
let Database;
try { Database = require("better-sqlite3"); } catch (e) { die(`better-sqlite3 did not load (${e.message}); run npm ci under the .nvmrc Node`); }

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; console.log(`  ok    ${label}`); return; }
	fail++;
	console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}
const section = (t) => console.log(`\n${t}`);

// ── the lifted server ───────────────────────────────────────────────────────
const INVESTOR_ROUTE = 'app.get("/api/investor", requireRole("Super Admin", "Investor"), async (req, res) => {';
const PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "requireRole", "notifyChange", "logAudit",
	"getJobTrackingCached", "getSheets", "SPREADSHEET_ID", "REPLICA", "SHEET_TARGET", "renderPolicy", "fs", "DATA_DIR", "fetch", "io", "sendEmail"];
const LIFTED = closure(SRC, {
	roots: ["generateInvoiceHandler", "computeInvestorMonthlyEarnings", "getCarrierDBFromSQLite", "getInvestorDriverSet", "parseSheet", "deduplicateLoads"],
	routes: [INVESTOR_ROUTE],
	provided: PROVIDED,
	denied: ["server", "transporter", "getDrive", "KEY_FILE"],
});

const NOW_MS = Date.UTC(2026, 9, 9, 17, 0, 0);
class FixedDate extends Date {
	constructor(...args) { super(...(args.length ? args : [NOW_MS])); }
	static now() { return NOW_MS; }
}

// Every table the lifted code reads, from server.js's own DDL.
const TABLES = ["users", "investors", "truck_assignments", "carrier_driver_history", "drivers_directory", "expenses",
	"excluded_driver_days", "maintenance_fund", "compliance_fees", "deleted_loads", "investor_payouts", "investor_payout_history",
	"investor_payout_basis", "period_locks", "financials_ledger_items", "financials_ledger_freezes", "app_settings",
	"load_coordinates", "routemate_telemetry", "pay_rate_history", "dispatch_notifications", "load_status_history", "invoices",
	"driver_payment_info", "load_eld_miles", "load_ratecon_miles"];
function tableDdl(table) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${table} in server.js`);
	return `CREATE TABLE ${table} (${m[1]}\n)`;
}
const alters = (table) => SRC.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN [^"\`]*`, "g")) || [];
function trucksDdl() {
	const m = SRC.match(/CREATE TABLE trucks_new \(([\s\S]*?)\n\t\t\);/);
	if (!m) die("could not locate the trucks rebuild (CREATE TABLE trucks_new)");
	return `CREATE TABLE trucks (${m[1]}\n)`;
}

// ── the fixture ─────────────────────────────────────────────────────────────
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info", "Pickup Appointment",
	"Pickup Address", "Drop-off Info", "Drop-off Appointment", "Drop-off Address", "Job Status",
	"Phase of Progress", "Carrier Stage", "  Payment  ", "Broker Contact Name", "Phone Number", "Email",
	"Location Link", "Documents", "Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output",
];
const load = ({ id, driver, pickup, dropoff, assigned, done, truck }) => {
	const r = Object.fromEntries(HEADERS.map((h) => [h, ""]));
	Object.assign(r, {
		"Load ID": id, Driver: driver, "Pickup Appointment": pickup, "Drop-off Appointment": dropoff, "Job Status": "Delivered",
		"  Payment  ": "$2,000.00", "Assigned Date": assigned, "Status Update Date": done, "Completion Date": done, Truck: truck, "Owner ID": "5",
	});
	return HEADERS.map((h) => r[h]);
};
const DRIVERS = { L1: "Ann Able", L2: "Bo Baker", L3: "Cy Cole", L4: "Di Dunn" };
const SHEET = [
	HEADERS,
	load({ id: "L1", driver: DRIVERS.L1, pickup: "9/30/2026 8:00", dropoff: "10/2/2026 10:00", assigned: "10/1/2026", done: "10/2/2026", truck: "T1" }),
	load({ id: "L2", driver: DRIVERS.L2, pickup: "9/26/2026 8:00", dropoff: "9/28/2026 10:00", assigned: "9/27/2026", done: "9/28/2026", truck: "T2" }),
	load({ id: "L3", driver: DRIVERS.L3, pickup: "9/29/2026 8:00", dropoff: "10/1/2026 18:00", assigned: "10/1/2026", done: "10/1/2026", truck: "T3" }),
	load({ id: "L4", driver: DRIVERS.L4, pickup: "9/29/2026 8:00", dropoff: "9/30/2026 18:00", assigned: "10/1/2026", done: "9/30/2026", truck: "T4" }),
];
const WEEK_END = "2026-10-02";
const WEEK = ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];

// Valliant, OK (every load's pickup), Dallas and Houston: all in the Central band.
const PICKUP = { lat: 34.0004549, lng: -95.109078 };
const DALLAS = { lat: 32.7767, lng: -96.797 };
const HOUSTON = { lat: 29.7604, lng: -95.3698 };
const HOUR = 3600 * 1000;
// Central daylight time is UTC-5: local hour h on `day`.
const cdt = (day, h, m = 0) => Date.parse(`${day}T00:00:00Z`) + (h + 5) * HOUR + m * 60000;

// One truck's feed, its odometer running on from day to day: `drive` adds a
// fix every 15 minutes from `from` to `to` local hours, `miles` in total;
// `visit` puts the noon fix at that point; `dark` jumps the odometer by that many
// miles before the day's first fix without a fix in between.
function feed(startOdo) {
	let odo = startOdo;
	const pings = [];
	const api = {
		pings,
		drive(day, { miles = 0, from = 8, to = 18, at = DALLAS, visit = null, dark = 0 } = {}) {
			odo += dark;
			const steps = (to - from) * 4;
			for (let i = 0; i <= steps; i++) {
				const ms = cdt(day, from) + i * 15 * 60000;
				const here = visit && ms === cdt(day, 12) ? visit : { lat: at.lat, lng: at.lng + i * 0.0005 };
				pings.push({ ms, ...here, odo: odo + (miles * i) / steps, speed: miles ? 10 : 0 });
			}
			odo += miles;
			return api;
		},
		park(day) { return api.drive(day, { from: 12, to: 13 }); },
	};
	return api;
}
const FEEDS = {
	V1: feed(100000).park("2026-09-25").drive("2026-09-30", { miles: 7.5 })
		.drive("2026-10-01", { miles: 200, visit: PICKUP }).drive("2026-10-02", { miles: 300 }).park("2026-10-03").pings,
	V2: feed(200000).park("2026-09-25").drive("2026-09-26", { miles: 10 })
		.drive("2026-09-27", { miles: 150, visit: PICKUP }).drive("2026-09-28", { miles: 250 }).park("2026-10-03").pings,
	V3: feed(300000).park("2026-09-25").drive("2026-09-29", { miles: 5, from: 8, to: 10 })
		.drive("2026-09-29", { miles: 1, from: 18, to: 19, at: HOUSTON, dark: 200 })
		.drive("2026-09-30", { miles: 100, visit: PICKUP }).drive("2026-10-01", { miles: 200 }).park("2026-10-03").pings,
	V4: feed(400000).park("2026-09-25").drive("2026-09-29", { miles: 8 })
		.drive("2026-09-30", { miles: 200, visit: PICKUP }).park("2026-10-03").pings,
};
// [load, new_status, source, changed_at (SQLite UTC text)]
const STATUS_ROWS = [
	["l1", "Dispatched", "dispatch", "2026-10-01 14:00:00"], ["l1", "Delivered", "manual", "2026-10-02 20:00:00"],
	["l2", "Dispatched", "dispatch", "2026-09-27 15:00:00"], ["l2", "Delivered", "manual", "2026-09-28 20:00:00"],
	["l3", "Dispatched", "dispatch", "2026-09-30 15:00:00"], ["l3", "Delivered", "manual", "2026-10-01 23:00:00"],
	["l4", "Delivered", "manual", "2026-10-01 15:00:00"],
];

function buildDb() {
	const db = new Database(":memory:");
	for (const sql of [trucksDdl(), ...alters("trucks"), ...TABLES.flatMap((t) => [tableDdl(t), ...alters(t)]),
		"CREATE TABLE investor_config (owner_id INTEGER DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id, key))"]) {
		try { db.exec(sql); } catch (e) { if (!/duplicate column name/.test(e.message)) die(`DDL failed: ${e.message}\n${sql.slice(0, 120)}`); }
	}
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (?, ?, 'x', ?, ?)");
	user.run(1, "super_admin", "Super Admin", "");
	user.run(5, "inv5", "Investor", "Acme Carrier");
	db.prepare("INSERT INTO investors (user_id, full_name, carrier_name) VALUES (5, 'Ivy Investor', 'Acme Carrier')").run();
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	const truck = db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, assigned_driver, routemate_vehicle_id)
		VALUES (?, ?, 5, 'Active', '2026-09-01', '2026-09-01 00:00:00', ?, ?)`);
	const dir = db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_daily) VALUES (?, 'Acme Carrier', 'fixed', 250)");
	const assign = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (?, ?, '2026-09-01T17:00:00.000Z')");
	["L1", "L2", "L3", "L4"].forEach((l, i) => {
		truck.run(i + 1, `T${i + 1}`, DRIVERS[l], `V${i + 1}`);
		dir.run(DRIVERS[l]);
		assign.run(i + 1, DRIVERS[l]);
	});
	const co = db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng) VALUES (?, ?, ?, 29.4, -98.4)");
	for (const l of ["L1", "L2", "L3", "L4"]) co.run(l, PICKUP.lat, PICKUP.lng);
	const st = db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, changed_at) VALUES (?, '', ?, ?, ?)");
	for (const r of STATUS_ROWS) st.run(...r);
	const tl = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, odometer, location_date_ms, dropped_reason) VALUES (?, ?, ?, ?, ?, ?, '')");
	for (const [vid, pings] of Object.entries(FEEDS)) for (const p of pings) tl.run(vid, p.lat, p.lng, p.speed, p.odo, p.ms);
	return db;
}

// One server start with `env`: the lifted code reads its settings from it once,
// as the server reads its .env at boot.
function start(env, { locks = [] } = {}) {
	const db = buildDb();
	for (const period of locks) {
		db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES (?, 'locked', '2026-10-08T05:00:00.000Z', 'test')").run(period);
	}
	const routes = {};
	const warnings = [];
	const rendered = [];
	const pass = () => (req, res, next) => (next ? next() : undefined);
	const quiet = { log() {}, info() {}, error() {}, warn: (...a) => warnings.push(a.join(" ")) };
	const deps = {
		db,
		require: createRequire(path.join(ROOT, "server.js")),
		console: quiet,
		process: { env: { ...env }, argv: [], cwd: () => ROOT },
		__dirname: ROOT,
		Date: FixedDate,
		app: { get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; } },
		requireRole: pass,
		notifyChange: () => {},
		logAudit: () => {},
		getJobTrackingCached: null,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: SHEET.map((r) => [...r]) } }) } } }),
		SPREADSHEET_ID: "test-sheet",
		REPLICA: null,
		SHEET_TARGET: null,
		renderPolicy: async (templateName, data) => { rendered.push({ templateName, data }); return Buffer.from("%PDF-stub"); },
		fs: { existsSync: () => true, mkdirSync: () => {}, writeFileSync: () => {}, renameSync: () => {}, unlinkSync: () => {}, readFileSync: () => "" },
		DATA_DIR: "/nonexistent",
		fetch: () => { throw new Error("no network in a test"); },
		io: null,
		sendEmail: async () => undefined,
	};
	const body = [
		'"use strict";',
		LIFTED.text,
		"getJobTrackingCached = async () => { const p = parseSheet({ values: __sheet }); p.data = deduplicateLoads(p.data, p.headers); return p; };",
		"return { generateInvoiceHandler, computeInvestorMonthlyEarnings, getCarrierDBFromSQLite, getInvestorDriverSet, findCol };",
	].join("\n");
	const api = new Function(...Object.keys(deps), "__sheet", body)(...Object.values(deps), SHEET);
	return { db, api, routes, warnings, rendered };
}

const call = async (handler, req) => {
	const out = { status: 200, body: null };
	const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
	await handler(req, res);
	return out;
};

// "load day" pairs each path pays, sorted.
async function invoiceDays(world) {
	const out = [];
	for (const driver of Object.values(DRIVERS)) {
		world.rendered.length = 0;
		const r = await call(world.api.generateInvoiceHandler, { session: { user: { role: "Super Admin", username: "t" } }, body: { driver, weekEnd: WEEK_END } });
		if (r.status !== 200 || world.rendered.length !== 1) throw new Error(`invoice for ${driver}: ${r.status} ${JSON.stringify(r.body)}`);
		const days = world.rendered[0].data.days;
		["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].forEach((name, i) => {
			const e = days[name];
			if (e && e.completed) for (const lid of String(e.loadBol).split(", ").filter(Boolean)) out.push(`${lid} ${WEEK[i]}`);
		});
	}
	return out.sort();
}
function findMonthlyEarnings(body) {
	const seen = new Set();
	const walk = (o) => {
		if (!o || typeof o !== "object" || seen.has(o)) return null;
		seen.add(o);
		if (Array.isArray(o.monthlyEarnings)) return o.monthlyEarnings;
		for (const v of Object.values(o)) { const hit = walk(v); if (hit) return hit; }
		return null;
	};
	return walk(body) || [];
}
async function investorViewDays(world) {
	const r = await call(world.routes["GET /api/investor"], { session: { user: { id: 5, role: "Investor", username: "inv5" } }, query: {}, params: {}, headers: {} });
	if (r.status !== 200) throw new Error(`GET /api/investor: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
	const out = [];
	for (const m of findMonthlyEarnings(r.body)) {
		for (const det of Object.values(m.driverDetails || {})) {
			for (const d of det.dayBreakdown || []) for (const lid of d.loadIds) if (WEEK.includes(d.date)) out.push(`${lid} ${d.date}`);
		}
	}
	return out.sort();
}
async function ledgerDays(world) {
	const { api, db } = world;
	const carrierDB = api.getCarrierDBFromSQLite();
	const driverCol = api.findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
	const carrierCol = api.findCol(carrierDB.headers, /carrier/i);
	const config = {};
	db.prepare("SELECT key, value FROM investor_config WHERE owner_id IN (0, 5) ORDER BY owner_id").all().forEach((r) => { config[r.key] = r.value; });
	const { items } = await api.computeInvestorMonthlyEarnings({
		user: { id: 5, role: "Investor", username: "inv5" }, isSuperAdmin: false,
		investorDriverSet: api.getInvestorDriverSet(5, carrierDB.data, driverCol, carrierCol), investorOwnerId: 5, config,
	});
	return items.filter((i) => i.kind === "driver_pay" && WEEK.includes(i.day)).map((i) => `${i.loadId} ${i.day}`).sort();
}
async function payPaths(env, opts) {
	const world = start(env, opts);
	return { invoice: await invoiceDays(world), investor: await investorViewDays(world), ledger: await ledgerDays(world), warnings: world.warnings };
}

const ALL_DAYS = [
	"L1 2026-09-30", "L1 2026-10-01", "L1 2026-10-02",
	"L2 2026-09-26", "L2 2026-09-27", "L2 2026-09-28",
	"L3 2026-09-29", "L3 2026-09-30", "L3 2026-10-01",
	"L4 2026-09-29", "L4 2026-09-30",
];
const RULE_DAYS = ALL_DAYS.filter((x) => x !== "L1 2026-09-30");
const ON = { PRE_DISPATCH_PAY_DAY_RULE_ENABLED: "true", PRE_DISPATCH_PAY_DAY_RULE_FROM: "2026-10" };
const ruleWarnings = (w) => w.filter((x) => /PRE_DISPATCH_PAY_DAY_RULE/.test(x));

(async () => {
	section("§0 the flag off: every window day pays on every path");
	const off = await payPaths({});
	check("invoice", off.invoice, ALL_DAYS);
	check("investor view", off.investor, ALL_DAYS);
	check("payout ledger", off.ledger, ALL_DAYS);

	section("§1 flag on, FROM 2026-10: the three paths pay the same days");
	const on = await payPaths(ON);
	for (const [name, days] of [["invoice", on.invoice], ["investor view", on.investor], ["payout ledger", on.ledger]]) {
		check(`${name}: exactly L1's idle 09-30 before its dispatch stops paying`, days, RULE_DAYS);
	}
	check("…L2 settles in September, before FROM: its idle day before dispatch still pays", on.ledger.filter((x) => x.startsWith("L2 ")), ["L2 2026-09-26", "L2 2026-09-27", "L2 2026-09-28"]);
	check("…L3's day with a rejected odometer jump (ELD dark 8 h, 200 miles) still pays (M1)", on.ledger.includes("L3 2026-09-29"), true);
	check("…L4 has no Dispatched row, only a later Delivered tap: every day still pays (M2)", on.ledger.filter((x) => x.startsWith("L4 ")), ["L4 2026-09-29", "L4 2026-09-30"]);
	check("invoice and investor view agree day for day", on.invoice, on.investor);
	check("investor view and payout ledger agree day for day", on.investor, on.ledger);
	check("no warning with a valid FROM", ruleWarnings(on.warnings), []);

	section("§2 closing a month changes no day on any path (H1)");
	for (const [label, locks] of [["September closed", ["2026-09"]], ["September and October closed", ["2026-09", "2026-10"]]]) {
		const locked = await payPaths(ON, { locks });
		check(`invoice: the same days with ${label}`, locked.invoice, on.invoice);
		check(`investor view: the same days with ${label}`, locked.investor, on.investor);
		check(`payout ledger: the same days with ${label}`, locked.ledger, on.ledger);
	}

	section("§3 flag on, FROM unset or not a month: the rule is off, one warning per start");
	for (const [label, from] of [["unset", undefined], ["empty", ""], ["not a month (2026-13)", "2026-13"], ["a day, not a month", "2026-10-01"], ["a word", "October"]]) {
		const env = { PRE_DISPATCH_PAY_DAY_RULE_ENABLED: "true", ...(from === undefined ? {} : { PRE_DISPATCH_PAY_DAY_RULE_FROM: from }) };
		const r = await payPaths(env);
		check(`FROM ${label}: every path pays as with the flag off`, [r.invoice, r.investor, r.ledger], [ALL_DAYS, ALL_DAYS, ALL_DAYS]);
		const w = ruleWarnings(r.warnings);
		check(`FROM ${label}: one warning for the start, naming PRE_DISPATCH_PAY_DAY_RULE_FROM`, w.length === 1 && /PRE_DISPATCH_PAY_DAY_RULE_FROM/.test(w[0]), true);
		if (from) check(`FROM ${label}: the warning does not print the value`, w.some((x) => x.includes(from)), false);
	}
	const offWithFrom = await payPaths({ PRE_DISPATCH_PAY_DAY_RULE_FROM: "2026-10" });
	check("flag off with a FROM: every day pays, no warning", [offWithFrom.ledger, ruleWarnings(offWithFrom.warnings)], [ALL_DAYS, []]);

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
