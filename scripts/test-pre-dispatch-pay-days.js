#!/usr/bin/env node
// The pre-dispatch pay-day rule (lib/load-pay-days.js, PRE_DISPATCH_PAY_DAY_RULE_ENABLED).
//
// A drop-trailer rate con can open a load's window on a day before the load was
// dispatched (the empty-trailer Drop Date/Time, or an unconfirmed "Scheduled
// Pick-up Date, Needs Confirmation"). With the flag on, such a day stops paying
// for that load when the truck moved under 50 km and never reached the pickup;
// real driving, a stop at the pickup, and every finalized month keep the day.
//
//   §1 the pure pieces: eldCountedDays / payDaysForLoad, dayActivity, isPreDispatchIdleDay
//   §2 the filter against an in-memory SQLite built from server.js's own DDL
//   §3 the payout ledger (computeLedgerScope) with the flag off and on
//   §4 server.js: the flag is default off, and the three pay paths share one copy
//
// No network, no sheet, no server.  node scripts/test-pre-dispatch-pay-days.js

"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const lpd = require("../lib/load-pay-days");
const financialsCalc = require("../lib/financials-calc");

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

// ── fixtures ────────────────────────────────────────────────────────────────
// Valliant, OK (the pickup) and Dallas, TX (where the truck sits), both in the
// Central band of usTzForLongitude().
const PICKUP = { lat: 34.0004549, lng: -95.109078 };
const DALLAS = { lat: 32.7767, lng: -96.797 };
const HOUR = 3600 * 1000;
// Central daylight time is UTC-5: local hour h on `day` is h+5 UTC.
const cdt = (day, h, m = 0) => Date.parse(`${day}T00:00:00Z`) + (h + 5) * HOUR + m * 60000;

// Pings every 15 minutes from 08:00 to 18:00 local, drifting east, the odometer
// climbing `miles` in total. `visit` adds one fix at that point at noon.
function dayPings(day, { miles, startOdo = 100000, at = DALLAS, visit = null, oneReading = false }) {
	const out = [];
	const steps = 40;
	for (let i = 0; i <= steps; i++) {
		out.push({ ms: cdt(day, 8) + i * 15 * 60000, lat: at.lat, lng: at.lng + i * 0.0005, odo: startOdo + (miles * i) / steps });
		if (oneReading) break;
	}
	if (visit) out.push({ ms: cdt(day, 12, 7), lat: visit.lat, lng: visit.lng, odo: startOdo + miles / 2 });
	return out;
}

// ── §1 pure pieces ──────────────────────────────────────────────────────────
section("§1 the pure pieces");
{
	const win = ["2026-10-04", "2026-10-05", "2026-10-06"];
	const eld = { travel: new Set(["2026-10-04", "2026-10-06"]), coverage: new Set(win) };
	check("covered window: only travel days count", lpd.eldCountedDays(win, eld), { covered: true, days: ["2026-10-04", "2026-10-06"] });
	check("uncovered window counts in full", lpd.eldCountedDays(win, { travel: new Set(), coverage: new Set(["2026-01-01"]) }), { covered: false, days: win });
	check("no ELD counts in full", lpd.eldCountedDays(win, null), { covered: false, days: win });
	const off = lpd.payDaysForLoad(win, eld, { loadId: "L", vid: "V" }, null);
	check("no filter (flag off): payDaysForLoad is eldCountedDays", off, lpd.eldCountedDays(win, eld));
	const uncovered = lpd.payDaysForLoad(win, null, { loadId: "L", vid: "V" }, () => { throw new Error("filtered an uncovered window"); });
	check("an uncovered window is never filtered (no distance to read)", uncovered.days, win);
	check("payDaysForLoad hands the filter the ELD-counted days", lpd.payDaysForLoad(win, eld, { loadId: "L" }, (l, d) => d.slice(1)).days, ["2026-10-06"]);

	const idle = lpd.dayActivity(dayPings("2026-10-04", { miles: 10 }), "2026-10-04", { pickup: PICKUP, radiusM: 3218.69 });
	check("dayActivity: 10 miles is 16.1 km", Math.round(idle.km * 10) / 10, 16.1);
	check("dayActivity: not at the pickup", idle.atPickup, false);
	check("dayActivity: the truck's zone that day", idle.zone, "America/Chicago");
	const visited = lpd.dayActivity(dayPings("2026-10-04", { miles: 10, visit: PICKUP }), "2026-10-04", { pickup: PICKUP, radiusM: 3218.69 });
	check("dayActivity: a fix at the pickup", visited.atPickup, true);
	check("dayActivity: no coordinates is unknown, not false",
		lpd.dayActivity(dayPings("2026-10-04", { miles: 10 }), "2026-10-04", { pickup: null, radiusM: 3218.69 }).atPickup, null);
	check("dayActivity: one odometer reading is no distance",
		lpd.dayActivity(dayPings("2026-10-04", { miles: 10, oneReading: true }), "2026-10-04", { pickup: PICKUP, radiusM: 3218.69 }).km, null);
	check("dayActivity: fixes of the next local day are not counted",
		lpd.dayActivity(dayPings("2026-10-05", { miles: 300 }), "2026-10-04", { pickup: PICKUP, radiusM: 3218.69 }).pings, 0);

	const dispatchMon = Date.parse("2026-10-05T19:59:42Z");
	check("idle day before dispatch drops", lpd.isPreDispatchIdleDay({ day: "2026-10-04", dispatchMs: dispatchMon, activity: idle }), true);
	check("the dispatch day itself stays", lpd.isPreDispatchIdleDay({ day: "2026-10-05", dispatchMs: dispatchMon, activity: idle }), false);
	check("50 km exactly stays", lpd.isPreDispatchIdleDay({ day: "2026-10-04", dispatchMs: dispatchMon, activity: { ...idle, km: 50 } }), false);
	check("a stop at the pickup stays", lpd.isPreDispatchIdleDay({ day: "2026-10-04", dispatchMs: dispatchMon, activity: visited }), false);
	check("no dispatch stays", lpd.isPreDispatchIdleDay({ day: "2026-10-04", dispatchMs: NaN, activity: idle }), false);
}

// ── §2 the filter against SQLite ────────────────────────────────────────────
function tableDdl(table) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${table} in server.js`);
	return `CREATE TABLE ${table} (${m[1]}\n)`;
}
const alters = (table) => (SRC.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN [^"\`]*`, "g")) || []);

function buildDb() {
	const db = new Database(":memory:");
	for (const t of ["load_status_history", "load_coordinates", "routemate_telemetry"]) {
		db.exec(tableDdl(t));
		for (const a of alters(t)) db.exec(a);
	}
	return db;
}
const sqlStamp = (iso) => iso.replace("T", " ").replace(/\.\d+Z$|Z$/, "");
function seed(db, { loads, pings }) {
	const st = db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, changed_at) VALUES (?, '', ?, 'dispatch', ?)");
	const co = db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng) VALUES (?, ?, ?, 29.4, -98.4)");
	for (const l of loads) {
		if (l.dispatchIso) st.run(String(l.id).toLowerCase().replace(/^#/, ""), "Dispatched", sqlStamp(l.dispatchIso));
		if (l.pickup) co.run(l.id, l.pickup.lat, l.pickup.lng);
	}
	const tl = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, odometer, location_date_ms, dropped_reason) VALUES (?, ?, ?, 10, ?, ?, ?)");
	for (const [vid, list] of Object.entries(pings)) for (const p of list) tl.run(vid, p.lat, p.lng, p.odo, p.ms, p.dropped || "");
}

const LOCKED = new Set(["2026-09"]);
const LOADS = [
	{ id: "LA", pickup: PICKUP, dispatchIso: "2026-10-05T19:59:42Z" },  // the Sunday case
	{ id: "LB", pickup: PICKUP, dispatchIso: "2026-10-12T14:00:00Z" },  // 64 km the day before
	{ id: "LC", pickup: PICKUP, dispatchIso: "2026-10-19T15:00:00Z" },  // at the pickup the day before
	{ id: "LD", pickup: PICKUP, dispatchIso: "2026-09-28T19:59:42Z" },  // a finalized month
	{ id: "LE", pickup: PICKUP, dispatchIso: "2026-10-02T15:00:00Z" },  // open day, settles in a finalized month
	{ id: "LG", pickup: PICKUP },                                       // never dispatched
	{ id: "LH", dispatchIso: "2026-10-22T15:00:00Z" },                  // no pickup coordinates
	{ id: "LI", pickup: PICKUP, dispatchIso: "2026-10-28T04:30:00Z" },  // 00:30 EDT = 23:30 CDT the day before
	{ id: "LJ", pickup: PICKUP, dispatchIso: "2026-10-28T06:30:00Z" },  // 01:30 CDT the next day
	{ id: "#LK", pickup: PICKUP, dispatchIso: "2026-10-26T15:00:00Z" }, // "#" spelling
	{ id: "LM", pickup: PICKUP, dispatchIso: "2026-10-30T15:00:00Z" },  // one odometer reading
	{ id: "LN", pickup: PICKUP, dispatchIso: "2026-10-20T15:00:00Z" },  // entered after the haul
];
const PINGS = {
	V1: [
		...dayPings("2026-10-04", { miles: 10 }),
		...dayPings("2026-10-05", { miles: 380, startOdo: 100010, visit: PICKUP }),
		...dayPings("2026-10-11", { miles: 40, startOdo: 101000 }),
		...dayPings("2026-10-18", { miles: 5, startOdo: 102000, visit: PICKUP }),
		...dayPings("2026-09-27", { miles: 10, startOdo: 99000 }),
		...dayPings("2026-10-01", { miles: 8, startOdo: 99900 }),
		...dayPings("2026-10-21", { miles: 6, startOdo: 103000 }),
		...dayPings("2026-10-27", { miles: 5, startOdo: 104000 }),
		...dayPings("2026-10-25", { miles: 4, startOdo: 103900 }),
		...dayPings("2026-10-29", { miles: 4, startOdo: 105000, oneReading: true }),
		...dayPings("2026-10-14", { miles: 120, startOdo: 101500, visit: PICKUP }),
		...dayPings("2026-10-15", { miles: 5, startOdo: 101620 }),
		// A fix the quality gate tagged: never read.
		{ ms: cdt("2026-10-04", 13), lat: PICKUP.lat, lng: PICKUP.lng, odo: 100005, dropped: "speed_outlier" },
	],
};

section("§2 the filter, against SQLite built from server.js's DDL");
{
	const db = buildDb();
	seed(db, { loads: LOADS, pings: PINGS });
	const drops = [];
	const filter = lpd.createPreDispatchFilter({ db, enabled: true, monthOpen: (mk) => !LOCKED.has(mk), radiusM: 3218.69, onDrop: (d) => drops.push(d) });
	const run = (loadId, days, settleMonth = "2026-10", windowStart) => filter({ loadId, vid: "V1", settleMonth, windowStart }, days);

	check("flag off: no filter at all", lpd.createPreDispatchFilter({ db, enabled: false, monthOpen: () => true, radiusM: 3218.69 }), null);
	check("Sunday case: the idle day before dispatch drops, the dispatch day and after stay",
		run("LA", ["2026-10-04", "2026-10-05", "2026-10-06"]), ["2026-10-05", "2026-10-06"]);
	check("…and is reported with its distance", drops.map((d) => [d.loadId, d.day, Math.round(d.km * 10) / 10]), [["LA", "2026-10-04", 16.1]]);
	check("a pre-dispatch day with 64 km of driving stays", run("LB", ["2026-10-11", "2026-10-12"]), ["2026-10-11", "2026-10-12"]);
	check("a pre-dispatch day with a stop at the pickup stays", run("LC", ["2026-10-18", "2026-10-19"]), ["2026-10-18", "2026-10-19"]);
	check("a finalized month never moves", run("LD", ["2026-09-27", "2026-09-28"], "2026-09"), ["2026-09-27", "2026-09-28"]);
	check("an open day that settles in a finalized month stays", run("LE", ["2026-10-01", "2026-10-02"], "2026-09"), ["2026-10-01", "2026-10-02"]);
	check("a finalized day that settles in an open month stays", run("LD", ["2026-09-27", "2026-09-28"], "2026-10"), ["2026-09-27", "2026-09-28"]);
	check("no dispatch row: the day stays", run("LG", ["2026-10-04"]), ["2026-10-04"]);
	check("no pickup coordinates: the day stays", run("LH", ["2026-10-21", "2026-10-22"]), ["2026-10-21", "2026-10-22"]);
	check("dispatched 23:30 local the same day: that day stays", run("LI", ["2026-10-27", "2026-10-28"]), ["2026-10-27", "2026-10-28"]);
	check("dispatched 01:30 local the next day: the idle day drops", run("LJ", ["2026-10-27", "2026-10-28"]), ["2026-10-28"]);
	check("a \"#\" load id finds its dispatch and coordinates", run("#LK", ["2026-10-25", "2026-10-26"]), ["2026-10-26"]);
	check("one odometer reading: the day stays", run("LM", ["2026-10-29", "2026-10-30"]), ["2026-10-29", "2026-10-30"]);
	check("a rest day after the truck loaded stays, on a load entered after the haul",
		run("LN", ["2026-10-14", "2026-10-15"], "2026-10", "2026-10-14"), ["2026-10-14", "2026-10-15"]);
	check("…read from the window's first day when the days are clipped (the weekly invoice)",
		run("LN", ["2026-10-15"], "2026-10", "2026-10-14"), ["2026-10-15"]);
	check("…and without that first day the same rest day would read as before loading",
		run("LN", ["2026-10-15"], "2026-10", "2026-10-15"), []);
	check("payDaysForLoad passes the window's first day by default",
		lpd.payDaysForLoad(["2026-10-14", "2026-10-15"], { travel: new Set(["2026-10-15"]), coverage: new Set(["2026-10-14", "2026-10-15"]) },
			{ loadId: "LN", vid: "V1", settleMonth: "2026-10" }, filter).days, ["2026-10-15"]);
	const same = ["2026-10-05", "2026-10-06"];
	check("nothing dropped: the same array comes back", run("LA", same) === same, true);
	check("no vehicle: nothing is read", filter({ loadId: "LA", vid: null, settleMonth: "2026-10" }, ["2026-10-04"]), ["2026-10-04"]);
	const unreadable = lpd.createPreDispatchFilter({ db, enabled: true, monthOpen: () => { throw new Error("period_locks unreadable"); }, radiusM: 3218.69 });
	check("an unreadable lock table keeps every day", unreadable({ loadId: "LA", vid: "V1", settleMonth: "2026-10" }, ["2026-10-04", "2026-10-05"]), ["2026-10-04", "2026-10-05"]);
}

// ── §3 the payout ledger ────────────────────────────────────────────────────
section("§3 computeLedgerScope (payouts and Financials) with the rule off and on");
{
	const db = buildDb();
	const ledgerLoads = [
		...LOADS,
		{ id: "U1", pickup: PICKUP, dispatchIso: "2026-10-05T19:59:42Z" },
		{ id: "U2", pickup: DALLAS, dispatchIso: "2026-10-02T15:00:00Z" },
	];
	seed(db, { loads: ledgerLoads, pings: { ...PINGS, V2: dayPings("2026-10-04", { miles: 10, startOdo: 200000, at: { lat: 32.5, lng: -96.5 } }) } });
	const d = (y, m, day) => new Date(y, m - 1, day);
	const row = (loadId, driver, truckUnit, assigned, pickup, dropoff) => ({
		loadId, driver, truckUnit, truckLabel: truckUnit, assignedDate: assigned, assignedText: "", pickupDate: pickup, dropoffDate: dropoff,
		completed: true, amount: 1000, ownerCell: "0", rowIndex: 2, source: {},
	});
	const rows = [
		row("LA", "ann", "t1", d(2026, 10, 5), d(2026, 10, 4), d(2026, 10, 6)),
		row("LD", "ann", "t1", d(2026, 9, 28), d(2026, 9, 27), d(2026, 9, 28)),
		row("U1", "uma", "t2", d(2026, 10, 5), d(2026, 10, 4), d(2026, 10, 5)),
		row("U2", "uma", "t2", d(2026, 10, 3), d(2026, 10, 3), d(2026, 10, 4)),
	];
	const allDays = (from, to) => financialsCalc.expandDateRange(d(...from), d(...to));
	const facts = (preDispatch) => ({
		rows,
		unitToVid: { t1: "V1", t2: "V2" },
		eldByVid: {
			V1: { travel: new Set(allDays([2026, 9, 25], [2026, 10, 31])), coverage: new Set(allDays([2026, 9, 25], [2026, 10, 31])) },
			V2: { travel: new Set(allDays([2026, 10, 1], [2026, 10, 31])), coverage: new Set(allDays([2026, 10, 1], [2026, 10, 31])) },
		},
		driverDayOverrides: {},
		addDaysFor: () => true,
		payStructures: {},
		expensesByDriverMonth: {},
		rateFor: () => 250,
		tripByMonth: {}, maintByMonth: {}, complianceByMonth: {},
		receipts: [], maintRows: [], complianceRows: [], fixedTrucks: [],
		truckChargedInMonth: () => false,
		truckMonthlyFixed: () => ({ total: 0 }),
		isZeroActivityMonth: () => false,
		startMonthFor: () => "2026-09",
		currentMonthKey: "2026-10",
		endDate: d(2026, 10, 1),
		ownerId: 0,
		...(preDispatch === undefined ? {} : { preDispatch }),
	});
	const payDays = (out) => out.items.filter((i) => i.kind === "driver_pay").map((i) => `${i.driver} ${i.day}`);
	const offAbsent = financialsCalc.computeLedgerScope(facts(undefined));
	const offNull = financialsCalc.computeLedgerScope(facts(null));
	check("flag off: identical output with or without the fact", JSON.stringify(offNull), JSON.stringify(offAbsent));
	const allLocked = lpd.createPreDispatchFilter({ db, enabled: true, monthOpen: () => false, radiusM: 3218.69 });
	check("flag on with every month finalized: identical to off", JSON.stringify(financialsCalc.computeLedgerScope(facts(allLocked))), JSON.stringify(offAbsent));

	const on = financialsCalc.computeLedgerScope(facts(lpd.createPreDispatchFilter({ db, enabled: true, monthOpen: (mk) => !LOCKED.has(mk), radiusM: 3218.69 })));
	const offDays = payDays(offAbsent);
	const onDays = payDays(on);
	check("flag on: exactly the Sunday day stops paying", offDays.filter((x) => !onDays.includes(x)), ["ann 2026-10-04"]);
	check("flag on: no day is added", onDays.filter((x) => !offDays.includes(x)), []);
	check("flag on: the finalized September day still pays", onDays.includes("ann 2026-09-27"), true);
	check("flag on: a day another load already dispatched covers still pays", onDays.includes("uma 2026-10-04"), true);
	const oct = (out) => out.months.find((m) => m.month === "2026-10").driverPay;
	check("October driver pay moves by one day ($250)", oct(offAbsent) - oct(on), 250);
	const sep = (out) => out.months.find((m) => m.month === "2026-09").driverPay;
	check("September driver pay does not move", sep(on), sep(offAbsent));
}

// ── §4 server.js ────────────────────────────────────────────────────────────
section("§4 server.js: default off, one shared copy");
{
	const flagLine = SRC.match(/\nconst PRE_DISPATCH_PAY_DAY_RULE_ENABLED = ([^\n]*);\n/);
	check("the flag is defined once", (SRC.match(/\nconst PRE_DISPATCH_PAY_DAY_RULE_ENABLED =/g) || []).length, 1);
	check("the flag reads true/1/yes/on only (default off)", flagLine && flagLine[1],
		'/^(true|1|yes|on)$/i.test(String(process.env.PRE_DISPATCH_PAY_DAY_RULE_ENABLED ?? "").trim())');
	const evalFlag = (env) => new Function("process", `return ${flagLine[1]};`)({ env });
	check("unset is off", evalFlag({}), false);
	check("\"false\" is off", evalFlag({ PRE_DISPATCH_PAY_DAY_RULE_ENABLED: "false" }), false);
	check("\"true\" is on", evalFlag({ PRE_DISPATCH_PAY_DAY_RULE_ENABLED: "true" }), true);

	const start = SRC.indexOf("\nfunction preDispatchPayDayFilter(");
	if (start < 0) die("preDispatchPayDayFilter() not found in server.js");
	const fnSrc = SRC.slice(start + 1, SRC.indexOf("\n}\n", start) + 2);
	// Off, it must return before reading anything else: lifted with the flag
	// alone, any other read would throw a ReferenceError.
	check("flag off: preDispatchPayDayFilter() is null and reads nothing else", (() => {
		try { return new Function("PRE_DISPATCH_PAY_DAY_RULE_ENABLED", `${fnSrc}\nreturn preDispatchPayDayFilter();`)(false); } catch (e) { return e.message; }
	})(), null);
	const liftedOn = new Function("PRE_DISPATCH_PAY_DAY_RULE_ENABLED", "loadPayDays", "db", "periodLocksReadable", "isLocked", "GEOFENCE_RADIUS",
		`${fnSrc}\nreturn preDispatchPayDayFilter();`)(true, lpd, buildDb(), () => true, () => false, 3218.69);
	check("flag on: preDispatchPayDayFilter() is a filter", typeof liftedOn, "function");

	const calls = (SRC.match(/loadPayDays\.payDaysForLoad\(/g) || []).length;
	check("server.js: the invoice and the investor view call payDaysForLoad()", calls, 2);
	check("server.js: no inline copy of the ELD intersection is left", /\.travel\.has\(|\.coverage\.has\(/.test(SRC.replace(/\/\/[^\n]*/g, "")), false);
	const calc = fs.readFileSync(path.join(ROOT, "lib", "financials-calc.js"), "utf8");
	check("financials-calc.js: the ledger calls payDaysForLoad() with the request's filter", /loadPayDays\.payDaysForLoad\([\s\S]{0,200}preDispatch,?\s*\)/.test(calc), true);
	check("financials-calc.js: no inline copy of the ELD intersection is left", /\.travel\.has\(|\.coverage\.has\(/.test(calc), false);
	check("each server pay path builds the filter once per request", (SRC.match(/= preDispatchPayDayFilter\(\);/g) || []).length, 2);
	check("the ledger's facts carry the filter", /preDispatch: preDispatchPayDayFilter\(\),/.test(SRC), true);
	const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
	check(".env.example documents the flag, off", /\nPRE_DISPATCH_PAY_DAY_RULE_ENABLED=false\n/.test(example), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
