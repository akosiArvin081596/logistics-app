#!/usr/bin/env node
/**
 * B23 / R13 (the user, 2026-10-23; product-decisions.md, "Weekly invoice day
 * rows"): the driver's weekly invoice names the right loads on each day, prints
 * each day's date, and labels what its counts hold. No day and no amount moves.
 *
 *   §1 DATES. Each of the 7 grid rows (render_data.days, Saturday-Friday) carries
 *      `date`, the calendar day counted from the week's Saturday by calendar
 *      arithmetic, worked or not, and the PDF's "<weekday> date" slot prints it
 *      as "Oct 17, 2026". Run in child processes under TZ America/New_York,
 *      America/Chicago, UTC and Asia/Manila with APP_TIMEZONE passed, on the
 *      week of Oct 17-23 and on Oct 31-Nov 6, which holds the end of daylight
 *      time: every zone prints the same dates and the same loads.
 *      invoiceDayGrid() (the grid's one builder) lifts on its own and touches no
 *      database, clock or zone.
 *   §2 THE DATE SLOT'S TEXT. A stored snapshot with no date prints none; a value
 *      that is not a day key prints none.
 *   §3 THE LOAD LIST (POST /api/invoices/generate). Each paid row's `listed` is
 *      the loads the PDF names: a billed load on each paid day of its span, from
 *      its window's first day (its Assigned Date when later) to its completion
 *      day (else its window's last day); a trip-rule load on its trip days. A
 *      paid day no load is listed on lists its paying loads, `scheduled`, and the
 *      PDF prints each "<id> (scheduled)". A load with no readable Assigned Date
 *      is listed from its window's first day. An admin-added day lists the loads
 *      whose span covers it. `loadBol` stays the loads that pay the day, exactly
 *      as before: integrity check 8, the daily-rate report and the work-days dry
 *      run take a day's pay month from it, as pricing does. A stored row without
 *      `listed` prints loadBol, as before. The week modeled on the real one
 *      (made-up IDs, ELD travel every day): 7 days, $2,100, Sat [L0, L1] ..
 *      Fri [L5].
 *   §4 NOTHING ELSE MOVES. On seven fixtures, invoiceWeekPaidDays()'s
 *      activeDaySet, dayLoadMap, dayPayMonth, blankPickupLoads and tripErrors,
 *      and the generated grid's loadBol and total on every day and the invoice's
 *      total, are the base's (379aa71) exactly; only dayListed and dayScheduled
 *      are new. The base's values are written below; with
 *      BASE_SERVER_JS=<the base's server.js> the runner also lifts the base and
 *      checks them against it.
 *   §5 LABELS (server). GET /api/invoices adds pay_basis ("daily", "percentage",
 *      "manual") and load_count (load_ids' length, 0 when unreadable) to each
 *      row; invoicePayBasesOf() gives the driver app's list its pay_basis;
 *      invoiceCountRows() is the submit email's rows (Days paid / Daily rate /
 *      Loads, Loads / Pay %, Line items). The client's copy is
 *      scripts/test-invoice-day-rows-client.mjs.
 *
 * Every case fails on the base except the §4 checks of what must not move,
 * which pass on both. Made-up data only. Pure: no server, no app.db, no network,
 * no browser.
 * Run: node scripts/test-invoice-day-rows.js    # exits 1 on failure
 */
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const MODE = (process.argv.find((a) => a.startsWith("--child=")) || "").slice("--child=".length);
if (!MODE) process.env.TZ = "UTC"; // production's clock zone; a child keeps the zone it was started in

const W = require("./lib/work-days-world");
const FIELD_MAPS = require(path.join(W.ROOT, "lib", "policy-field-maps.js"));
const { closure } = require(path.join(W.ROOT, "scripts", "lib", "server-lift.js"));
const { loadRow } = W;

const GRID = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const ZONES = ["America/New_York", "America/Chicago", "UTC", "Asia/Manila"];
const EXPOSE = ["invoiceWeekPaidDays", "jobTrackingRowsOf", "selectInvoiceWeekLoads", "loadKeySet", "getDeletedLoadIds", "tripDayResolver", "invoiceExtraRuleLoads", "getWeekRange"];

// ── fixtures (made up) ───────────────────────────────────────────────────────
const NIA = "Nia Brooks";
const REAL_END = "2026-10-23"; // Sat 10/17 - Fri 10/23
const DST_END = "2026-11-06"; // Sat 10/31 - Fri 11/6: daylight time ends Sun 11/1
const AFTER_REAL = Date.parse("2026-10-24T01:00:00Z");

// The week modeled on the real one: L0 delivered Saturday 04:42 off a Thursday
// appointment, three loads with rate-con pickups well before their Assigned Date.
function realRows() {
	const rows = [
		loadRow({ id: "L0", driver: NIA, pickup: "2026-10-15 9:00", dropoff: "2026-10-15 15:00", assigned: "2026-10-15", done: "2026-10-17", truck: "T7" }),
		loadRow({ id: "L1", driver: NIA, pickup: "2026-09-29 7:00", dropoff: "2026-10-19 8:00", assigned: "2026-10-16", done: "2026-10-19", truck: "T7" }),
		loadRow({ id: "L2", driver: NIA, pickup: "2026-10-19 8:00", dropoff: "2026-10-20 10:00", assigned: "2026-10-16", done: "2026-10-20", truck: "T7" }),
		loadRow({ id: "L3", driver: NIA, pickup: "2026-10-20 16:00", dropoff: "2026-10-21 6:30", assigned: "2026-10-20", done: "2026-10-21", truck: "T7" }),
		loadRow({ id: "L4", driver: NIA, pickup: "2026-10-05 0:00", dropoff: "", assigned: "2026-10-21", done: "2026-10-22", truck: "T7" }),
		loadRow({ id: "L5", driver: NIA, pickup: "2026-10-18 0:00", dropoff: "2026-10-23 0:00", assigned: "2026-10-22", done: "2026-10-23", truck: "T7" }),
	];
	rows[0]["Status Update Date"] = "10/17/2026 4:42";
	return rows;
}
// ELD travel on every day around the week, for one truck.
function travelEveryDay(from, to) {
	const f = W.feed(5000);
	for (const d of W.daysFrom(from, to)) f.drive(d, { miles: 300 });
	return f.pings;
}
function world(driver, rows, { env = {}, now = AFTER_REAL, ...extra } = {}) {
	return W.startWorld({
		env, now, rows, expose: EXPOSE,
		drivers: [{ name: driver, payDaily: 300 }],
		trucks: [{ unit: "T7", driver, vid: "V7" }],
		pings: { V7: travelEveryDay("2026-10-12", "2026-10-25") },
		...extra,
	});
}

// Days only loads assigned later in the week pay (Sat), a day a listed load pays
// beside two not yet assigned (Sun), and a load listed from its Assigned Date.
const IVO = "Ivo Lane";
const scheduledRows = () => [
	loadRow({ id: "S1", driver: IVO, pickup: "2026-10-15 8:00", dropoff: "2026-10-21 18:00", assigned: "2026-10-19", done: "2026-10-21", truck: "T7" }),
	loadRow({ id: "S2", driver: IVO, pickup: "2026-10-18 6:00", dropoff: "2026-10-18 20:00", assigned: "2026-10-17", done: "2026-10-18", truck: "T7" }),
	loadRow({ id: "S3", driver: IVO, pickup: "2026-10-17 8:00", dropoff: "2026-10-22 18:00", assigned: "2026-10-22", done: "2026-10-22", truck: "T7" }),
];
// No Assigned Date, and one that can't be read.
const ADA = "Ada Moro";
function unassignedRows() {
	const rows = [
		loadRow({ id: "N1", driver: ADA, pickup: "2026-10-17 8:00", dropoff: "2026-10-19 18:00", assigned: "", done: "2026-10-19", truck: "T7" }),
		loadRow({ id: "N2", driver: ADA, pickup: "2026-10-20 8:00", dropoff: "2026-10-21 18:00", assigned: "", done: "2026-10-21", truck: "T7" }),
	];
	rows[1]["Assigned Date"] = "TBD";
	return rows;
}
// The blank-pickup fallback on: B1 paid from its Assigned Date.
const BEA = "Bea Cole";
const blankPickupRows = () => [
	loadRow({ id: "B1", driver: BEA, pickup: "", dropoff: "2026-10-21 18:00", assigned: "2026-10-19", done: "2026-10-21", truck: "T7" }),
	loadRow({ id: "B2", driver: BEA, pickup: "2026-10-17 8:00", dropoff: "2026-10-19 18:00", assigned: "2026-10-18", done: "2026-10-19", truck: "T7" }),
];
// The trip work-day rule on: T1 assigned after its trip began.
const TOM = "Tom Reyes";
const tripRows = () => [
	loadRow({ id: "T1", driver: TOM, pickup: "2026-10-17 8:00", dropoff: "2026-10-19 18:00", assigned: "2026-10-19", done: "2026-10-19", truck: "T7" }),
];
const tripStatus = [
	["T1", "At Shipper", "manual", W.et("2026-10-17 09:00"), ""],
	["T1", "Delivered", "manual", W.et("2026-10-19 15:00"), ""],
];
// Super Admin overrides: 10/21 removed, 10/18 (inside L6's span) and 10/23
// (inside no span) added.
const overrideRows = () => [
	loadRow({ id: "L2", driver: NIA, pickup: "2026-10-19 8:00", dropoff: "2026-10-20 10:00", assigned: "2026-10-16", done: "2026-10-20", truck: "T7" }),
	loadRow({ id: "L3", driver: NIA, pickup: "2026-10-20 16:00", dropoff: "2026-10-21 6:30", assigned: "2026-10-20", done: "2026-10-21", truck: "T7" }),
	loadRow({ id: "L6", driver: NIA, pickup: "2026-10-17 8:00", dropoff: "2026-10-17 18:00", assigned: "2026-10-17", done: "2026-10-18", truck: "T7" }),
];
const OVERRIDES = [{ driver: NIA, day: "2026-10-21", action: "remove" }, { driver: NIA, day: "2026-10-18", action: "add" }, { driver: NIA, day: "2026-10-23", action: "add" }];

const FIXTURES = {
	F1_real_week: () => [NIA, world(NIA, realRows())],
	F2_real_week_rate_rule: () => [NIA, world(NIA, realRows(), { env: { DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: "2026-10" } })],
	F3_scheduled: () => [IVO, world(IVO, scheduledRows())],
	F4_no_assigned_date: () => [ADA, world(ADA, unassignedRows())],
	F5_blank_pickup: () => [BEA, world(BEA, blankPickupRows(), { env: { INVOICE_BLANK_PICKUP_FALLBACK_ENABLED: "true", INVOICE_BLANK_PICKUP_FALLBACK_FROM: "2026-10" } })],
	F6_trip_rule: () => [TOM, world(TOM, tripRows(), { env: { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-10" }, status: tripStatus })],
	F7_overrides: () => [NIA, world(NIA, overrideRows(), { overrides: OVERRIDES })],
};

const sortedEntries = (o) => (o ? Object.fromEntries(Object.entries(o).sort()) : null);
// invoiceWeekPaidDays() for one driver's week, called as generate calls it.
function paidDays(w, driver, weekEnd) {
	const api = w.api;
	const { headers, data } = api.jobTrackingRowsOf(W.sheetValues(w.rows));
	const { weekStart, weekEnd: end } = api.getWeekRange(weekEnd);
	const deletedKeys = api.loadKeySet(api.getDeletedLoadIds());
	const week = api.selectInvoiceWeekLoads(data, headers, driver, weekStart, end, deletedKeys);
	const weekRule = api.tripDayResolver() || null;
	const extraRuleLoads = weekRule
		? api.invoiceExtraRuleLoads({ data, headers, driverName: driver, billed: week.loads, weekStart, weekEnd: end, resolver: weekRule, deletedKeys })
		: [];
	const r = api.invoiceWeekPaidDays({ headers, cols: week.cols, loads: week.loads, extraRuleLoads, weekRule, weekStart, weekEnd: end, nameNorm: api.normalizeDriverName(driver) });
	return {
		activeDaySet: [...r.activeDaySet].sort(),
		dayLoadMap: sortedEntries(r.dayLoadMap),
		dayPayMonth: sortedEntries(r.dayPayMonth),
		blankPickupLoads: r.blankPickupLoads,
		tripErrors: r.tripErrors,
		dayListed: sortedEntries(r.dayListed),
		dayScheduled: sortedEntries(r.dayScheduled),
	};
}
// A generated invoice's paid grid rows as the base stores them, [day, loadBol,
// total], and its total.
function storedGrid(g, weekEnd) {
	return { rows: W.gridDays(g.data, weekEnd).map((e) => [e.day, e.loads.join(", "), e.total]), total: g.invoice ? g.invoice.total_earnings : null };
}

// One generated invoice as the PDF prints it: [weekday, date, printed date,
// printed loads, total].
function printedOf(g) {
	if (!g.data || !g.data.days) return { status: g.status, error: JSON.stringify(g.body).slice(0, 200) };
	const text = FIELD_MAPS.service_invoice(g.data).text;
	return {
		total: g.invoice && g.invoice.total_earnings,
		rows: GRID.map((n) => {
			const d = g.data.days[n] || {};
			return [n, d.date === undefined ? null : d.date, text[`${n} date`] === undefined ? null : text[`${n} date`], text[`${n} Load/BOL number`], d.completed ? d.total : 0];
		}),
	};
}

// ── child processes ──────────────────────────────────────────────────────────
async function childDates() {
	const out = { tz: process.env.TZ, appZone: process.env.APP_TIMEZONE };
	const env = { APP_TIMEZONE: process.env.APP_TIMEZONE };
	try {
		const lift = closure(W.SRC, { roots: ["invoiceDayGrid"] });
		out.gridNames = lift.names.sort();
		const invoiceDayGrid = new Function(`"use strict";\n${lift.text}\nreturn invoiceDayGrid;`)();
		const g = invoiceDayGrid({
			days: new Set(["2026-11-01", "2026-11-02"]), weekStart: "2026-10-31", rateOf: null, dailyRate: 300,
			dayLoadMap: { "2026-11-01": ["X1"], "2026-11-02": ["X1", "X2"] },
			dayListed: { "2026-11-01": ["X1"], "2026-11-02": ["X2"] },
			dayScheduled: { "2026-11-01": ["X1"], "2026-11-02": [] },
		});
		out.grid = GRID.map((n) => [n, g[n]]);
	} catch (e) {
		out.grid = `threw: ${String(e && e.message).split("\n")[0]}`;
	}
	const real = world(NIA, realRows(), { env });
	out.real = printedOf(await W.generate(real, NIA, REAL_END));
	const OMAR = "Omar Pike";
	const dst = W.startWorld({
		env, now: Date.parse("2026-11-07T02:00:00Z"), drivers: [{ name: OMAR, payDaily: 300 }],
		rows: [loadRow({ id: "D1", driver: OMAR, pickup: "2026-11-01 8:00", dropoff: "2026-11-03 18:00", assigned: "2026-10-30", done: "2026-11-03", truck: "T1" })],
	});
	out.dst = printedOf(await W.generate(dst, OMAR, DST_END));
	return out;
}
async function childPaidDays() {
	const out = {};
	for (const [name, make] of Object.entries(FIXTURES)) {
		try {
			const [driver, w] = make();
			out[name] = paidDays(w, driver, REAL_END);
			out[name].stored = storedGrid(await W.generate(w, driver, REAL_END), REAL_END);
		} catch (e) {
			out[name] = { error: String(e && e.message).split("\n")[0] };
		}
	}
	return out;
}
function spawnChild(mode, env) {
	const r = spawnSync(process.execPath, [__filename, `--child=${mode}`], { cwd: W.ROOT, encoding: "utf8", env: { ...process.env, ...env }, timeout: 120000 });
	try { return JSON.parse(r.stdout); } catch { return { error: `child ${mode} exit ${r.status}: ${(r.stderr || r.stdout || "").slice(0, 300)}` }; }
}

// ── what the base (379aa71) answers on §4's fixtures ─────────────────────────
const REAL_DAYS = ["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];
// dayLoadMap: every load on every day it pays. Unchanged by the fix.
const BASE_LOAD_MAP = {
	F1_real_week: {
		"2026-10-17": ["L1", "L4"], "2026-10-18": ["L1", "L4", "L5"], "2026-10-19": ["L1", "L2", "L4", "L5"], "2026-10-20": ["L2", "L3", "L4", "L5"],
		"2026-10-21": ["L3", "L4", "L5"], "2026-10-22": ["L4", "L5"], "2026-10-23": ["L5"],
	},
	F2_real_week_rate_rule: {
		"2026-10-17": ["L1", "L4"], "2026-10-18": ["L1", "L4", "L5"], "2026-10-19": ["L1", "L2", "L4", "L5"], "2026-10-20": ["L2", "L3", "L4", "L5"],
		"2026-10-21": ["L3", "L4", "L5"], "2026-10-22": ["L4", "L5"], "2026-10-23": ["L5"],
	},
	F3_scheduled: {
		"2026-10-17": ["S1", "S3"], "2026-10-18": ["S1", "S2", "S3"], "2026-10-19": ["S1", "S3"], "2026-10-20": ["S1", "S3"],
		"2026-10-21": ["S1", "S3"], "2026-10-22": ["S3"],
	},
	F4_no_assigned_date: { "2026-10-17": ["N1"], "2026-10-18": ["N1"], "2026-10-19": ["N1"], "2026-10-20": ["N2"], "2026-10-21": ["N2"] },
	F5_blank_pickup: { "2026-10-17": ["B2"], "2026-10-18": ["B2"], "2026-10-19": ["B1", "B2"], "2026-10-20": ["B1"], "2026-10-21": ["B1"] },
	F6_trip_rule: { "2026-10-17": ["T1"], "2026-10-18": ["T1"], "2026-10-19": ["T1"] },
	F7_overrides: { "2026-10-17": ["L6"], "2026-10-18": [], "2026-10-19": ["L2"], "2026-10-20": ["L2", "L3"], "2026-10-23": [] },
};
const none = { dayPayMonth: {}, blankPickupLoads: [], tripErrors: [] };
const daysOf = (name) => Object.keys(BASE_LOAD_MAP[name]);
// activeDaySet, dayLoadMap, dayPayMonth, blankPickupLoads and tripErrors.
const BASE_UNCHANGED = Object.fromEntries(Object.keys(BASE_LOAD_MAP).map((name) => [name, {
	activeDaySet: daysOf(name), dayLoadMap: BASE_LOAD_MAP[name], ...none,
	...(name === "F2_real_week_rate_rule" ? { dayPayMonth: Object.fromEntries(REAL_DAYS.map((d) => [d, "2026-10"])) } : {}),
	...(name === "F5_blank_pickup" ? { blankPickupLoads: ["B1"] } : {}),
}]));
// The generated grid as the base stored it: every paid day's loadBol (its
// paying loads) at $300, and the total.
const BASE_STORED = Object.fromEntries(Object.keys(BASE_LOAD_MAP).map((name) => [name, {
	rows: daysOf(name).map((d) => [d, BASE_LOAD_MAP[name][d].join(", "), 300]), total: 300 * daysOf(name).length,
}]));

// ── after the fix ─────────────────────────────────────────────────────────────
// dayListed: the loads each paid day lists on the PDF.
const NEW_LISTED = {
	F1_real_week: {
		"2026-10-17": ["L0", "L1"], "2026-10-18": ["L1"], "2026-10-19": ["L1", "L2"], "2026-10-20": ["L2", "L3"],
		"2026-10-21": ["L3", "L4"], "2026-10-22": ["L4", "L5"], "2026-10-23": ["L5"],
	},
	F3_scheduled: {
		"2026-10-17": ["S1", "S3"], "2026-10-18": ["S2"], "2026-10-19": ["S1"], "2026-10-20": ["S1"],
		"2026-10-21": ["S1"], "2026-10-22": ["S3"],
	},
	F4_no_assigned_date: BASE_LOAD_MAP.F4_no_assigned_date,
	F5_blank_pickup: { "2026-10-17": ["B2"], "2026-10-18": ["B2"], "2026-10-19": ["B1", "B2"], "2026-10-20": ["B1"], "2026-10-21": ["B1"] },
	F6_trip_rule: BASE_LOAD_MAP.F6_trip_rule, // the trip rule's: its trip days, as it pays them
	F7_overrides: { "2026-10-17": ["L6"], "2026-10-18": ["L6"], "2026-10-19": ["L2"], "2026-10-20": ["L2", "L3"], "2026-10-23": [] },
};
NEW_LISTED.F2_real_week_rate_rule = NEW_LISTED.F1_real_week;
// dayScheduled: the listed loads a paid day names only as "(scheduled)".
const SCHEDULED_DAYS = { F3_scheduled: { "2026-10-17": ["S1", "S3"] }, F5_blank_pickup: { "2026-10-17": ["B2"] } };
const NEW_SCHEDULED = Object.fromEntries(Object.keys(BASE_LOAD_MAP).map((name) => [name,
	Object.fromEntries(daysOf(name).map((d) => [d, (SCHEDULED_DAYS[name] || {})[d] || []]))]));

// ── the parent ───────────────────────────────────────────────────────────────
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o && o[k]]));
const UNCHANGED = ["activeDaySet", "dayLoadMap", "dayPayMonth", "blankPickupLoads", "tripErrors"];

async function main(R) {
	// §1
	const REAL_PRINTED = [
		["Saturday", "2026-10-17", "Oct 17, 2026", "L0, L1", 300], ["Sunday", "2026-10-18", "Oct 18, 2026", "L1", 300],
		["Monday", "2026-10-19", "Oct 19, 2026", "L1, L2", 300], ["Tuesday", "2026-10-20", "Oct 20, 2026", "L2, L3", 300],
		["Wednesday", "2026-10-21", "Oct 21, 2026", "L3, L4", 300], ["Thursday", "2026-10-22", "Oct 22, 2026", "L4, L5", 300],
		["Friday", "2026-10-23", "Oct 23, 2026", "L5", 300],
	];
	const DST_PRINTED = [
		["Saturday", "2026-10-31", "Oct 31, 2026", "", 0], ["Sunday", "2026-11-01", "Nov 1, 2026", "D1", 300],
		["Monday", "2026-11-02", "Nov 2, 2026", "D1", 300], ["Tuesday", "2026-11-03", "Nov 3, 2026", "D1", 300],
		["Wednesday", "2026-11-04", "Nov 4, 2026", "", 0], ["Thursday", "2026-11-05", "Nov 5, 2026", "", 0],
		["Friday", "2026-11-06", "Nov 6, 2026", "", 0],
	];
	const byZone = {};
	for (const zone of ZONES) byZone[zone] = spawnChild("dates", { TZ: zone, APP_TIMEZONE: "America/New_York" });

	await R.test("§1a Oct 17-23: every row carries its date and prints \"Oct 17, 2026\" .. \"Oct 23, 2026\", and the same loads, under TZ America/New_York, America/Chicago, UTC and Asia/Manila (APP_TIMEZONE America/New_York); 7 days, $2,100. Base: no date", async ({ eq }) => {
		for (const zone of ZONES) {
			const c = byZone[zone];
			eq(`${zone}: the child ran in its zone`, [c.tz, c.appZone], [zone, "America/New_York"]);
			eq(`${zone}: [weekday, date, printed date, printed loads, total]`, c.real && c.real.rows, REAL_PRINTED);
			eq(`${zone}: total`, c.real && c.real.total, 2100);
		}
	});

	await R.test("§1b Oct 31-Nov 6 (daylight time ends Sun 11/1): the rows read Oct 31, Nov 1 .. Nov 6 in every zone, the four days not worked included. Base: no date", async ({ eq }) => {
		for (const zone of ZONES) eq(`${zone}: [weekday, date, printed date, printed loads, total]`, byZone[zone].dst && byZone[zone].dst.rows, DST_PRINTED);
	});

	await R.test("§1c invoiceDayGrid() lifts with nothing but its own pure helpers and builds the grid from weekStart by calendar arithmetic, in every zone: Sat 10/31 to Fri 11/6, each paid day's loadBol, listed, scheduled and rate, the days not worked with both lists empty. Base: no invoiceDayGrid()", async ({ eq, ok }) => {
		const idle = (date) => ({ date, loadBol: "", total: 0, completed: false, listed: [], scheduled: [] });
		const want = [
			["Saturday", idle("2026-10-31")],
			["Sunday", { date: "2026-11-01", loadBol: "X1", total: 300, completed: true, listed: ["X1"], scheduled: ["X1"], rate: 300 }],
			["Monday", { date: "2026-11-02", loadBol: "X1, X2", total: 300, completed: true, listed: ["X2"], scheduled: [], rate: 300 }],
			["Tuesday", idle("2026-11-03")], ["Wednesday", idle("2026-11-04")], ["Thursday", idle("2026-11-05")], ["Friday", idle("2026-11-06")],
		];
		for (const zone of ZONES) {
			eq(`${zone}: the grid`, byZone[zone].grid, want);
			const names = byZone[zone].gridNames || [];
			ok(`${zone}: lifts alone (no db, clock, zone or I/O)`, names.length && names.every((n) => ["invoiceDayGrid", "INVOICE_GRID_DAYS", "invoiceGridDayName", "dayKeyPlus"].includes(n)), JSON.stringify(names));
		}
	});

	// §2
	await R.test("§2 The \"<weekday> date\" slot: a snapshot stored with no date prints nothing (and still fills its other slots); a value that is not a day key prints nothing. Base: no slot", async ({ eq }) => {
		const old = FIELD_MAPS.service_invoice({ days: { Monday: { loadBol: "H1", total: 300, completed: true } } }).text;
		eq("no date stored: every slot asked, every one empty", GRID.map((n) => old[`${n} date`]), GRID.map(() => ""));
		eq("…and Monday's other slots fill", [old["Monday Load/BOL number"], old["Monday daily rate"]], ["H1", "$300.00"]);
		const odd = (date) => FIELD_MAPS.service_invoice({ days: { Monday: { date } } }).text["Monday date"];
		eq("not a day key", ["2026-02-30", "10/17/2026", "Oct 17, 2026", "2026-10-1", 20261017, ""].map(odd), ["", "", "", "", "", ""]);
		eq("a day key", [odd("2026-10-17"), odd("2026-01-05"), odd("2026-09-30"), odd("2026-12-31")], ["Oct 17, 2026", "Jan 5, 2026", "Sep 30, 2026", "Dec 31, 2026"]);
	});

	// §3
	const listedOf = (g) => Object.fromEntries(GRID.map((n) => g.data && g.data.days[n]).filter((d) => d && d.completed).map((d) => [d.date, d.listed]));
	await R.test("§3a The real week (made-up IDs): the PDF lists Sat [L0, L1], Sun [L1], Mon [L1, L2], Tue [L2, L3], Wed [L3, L4], Thu [L4, L5], Fri [L5]; L0 (delivered Sat 04:42) pays no day; loadBol is still the paying loads; 7 days, $2,100; loads_count 7 (days), load_ids 6. Base: the PDF lists Sat [L1, L4], Sun [L1, L4, L5], ...", async ({ eq }) => {
		const g = await W.generate(world(NIA, realRows()), NIA, REAL_END);
		eq("status", g.status, 200);
		eq("listed", listedOf(g), NEW_LISTED.F1_real_week);
		eq("printed", printedOf(g).rows && printedOf(g).rows.map((r) => r[3]), REAL_PRINTED.map((r) => r[3]));
		eq("loadBol, as the base stores it", storedGrid(g, REAL_END), BASE_STORED.F1_real_week);
		eq("[loads_count, load_ids]", [g.invoice && g.invoice.loads_count, g.invoice && JSON.parse(g.invoice.load_ids)], [7, ["L0", "L1", "L2", "L3", "L4", "L5"]]);
	});

	await R.test("§3b A paid day no load is listed on lists its paying loads, printed \"(scheduled)\": Sat \"S1 (scheduled), S3 (scheduled)\", Sun [S2] (S1 and S3 not yet assigned), Mon-Wed [S1], Thu [S3]; 6 days, $1,800. loadBol is still the paying loads, so check 8 of the integrity check (lib/integrity-check.js) reads each day's loads as the base stored them. Base: Sat [S1, S3], Sun [S1, S2, S3], no mark", async ({ eq }) => {
		const w = world(IVO, scheduledRows());
		const g = await W.generate(w, IVO, REAL_END);
		eq("listed", listedOf(g), NEW_LISTED.F3_scheduled);
		const sched = Object.fromEntries(GRID.map((n) => g.data && g.data.days[n]).filter((d) => d && d.completed).map((d) => [d.date, d.scheduled]));
		eq("scheduled", sched, NEW_SCHEDULED.F3_scheduled);
		const text = g.data ? FIELD_MAPS.service_invoice(g.data).text : {};
		eq("the PDF's Load/BOL slots", GRID.map((n) => text[`${n} Load/BOL number`]), ["S1 (scheduled), S3 (scheduled)", "S2", "S1", "S1", "S1", "S3", ""]);
		eq("loadBol, as the base stores it", storedGrid(g, REAL_END), BASE_STORED.F3_scheduled);
		const seen = [];
		const spy = { from: "2026-10", appliesTo: () => false, payMonthOf: (day, loads) => { seen.push([day, loads]); return day.slice(0, 7); } };
		require(path.join(W.ROOT, "lib", "integrity-check.js")).invoiceRateMismatches(w.db, { dailyRateRule: spy });
		eq("check 8 reads each day's paying loads, bare IDs", seen, Object.entries(BASE_LOAD_MAP.F3_scheduled));
	});

	await R.test("§3c The PDF prints `listed`, a scheduled load \"<id> (scheduled)\"; a paid row listing nothing prints nothing; a row stored before rows carried `listed` prints loadBol, as before. Base: loadBol on every row", async ({ eq }) => {
		const text = FIELD_MAPS.service_invoice({ days: {
			Saturday: { loadBol: "S1, S3", listed: ["S1", "S3"], scheduled: ["S1", "S3"], total: 300, completed: true },
			Sunday: { loadBol: "S1, S2, S3", listed: ["S2"], scheduled: [], total: 300, completed: true },
			Monday: { loadBol: "S1, S4", listed: ["S1", "S4"], scheduled: ["S4"], total: 300, completed: true },
			Tuesday: { loadBol: "", listed: [], scheduled: [], total: 300, completed: true },
			Wednesday: { loadBol: "H1, H2", total: 300, completed: true },
		} }).text;
		eq("[Sat, Sun, Mon, Tue, Wed]", ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday"].map((n) => text[`${n} Load/BOL number`]),
			["S1 (scheduled), S3 (scheduled)", "S2", "S1, S4 (scheduled)", "", "H1, H2"]);
	});

	await R.test("§3d A load with no Assigned Date, or one that can't be read (\"TBD\"), is listed from its window's first day to its completion day: Sat-Mon [N1], Tue-Wed [N2]. Base: no `listed`", async ({ eq }) => {
		const g = await W.generate(world(ADA, unassignedRows()), ADA, REAL_END);
		eq("listed", listedOf(g), NEW_LISTED.F4_no_assigned_date);
	});

	// §4
	const now = spawnChild("paid-days", {});
	const baseFile = process.env.BASE_SERVER_JS || "";
	const base = baseFile ? spawnChild("paid-days", { SERVER_JS: baseFile }) : null;

	await R.test("§4a invoiceWeekPaidDays() on seven fixtures (real week, the daily-rate rule, scheduled loads, no Assigned Date, the blank-pickup fallback, the trip rule, Super Admin overrides): activeDaySet, dayLoadMap, dayPayMonth, blankPickupLoads and tripErrors are the base's exactly", async ({ eq }) => {
		for (const name of Object.keys(FIXTURES)) eq(`${name}`, pick(now[name], UNCHANGED), BASE_UNCHANGED[name]);
	});

	await R.test("§4b …and the generated grid: every paid day's loadBol and total, and the invoice's total, are the base's exactly", async ({ eq }) => {
		for (const name of Object.keys(FIXTURES)) eq(`${name}`, now[name] && now[name].stored, BASE_STORED[name]);
	});

	await R.test("§4c dayListed is the designed listing (the trip rule's: its trip days); an admin-added day lists the load whose span covers it (Sun [L6]) or nothing (Fri []); dayScheduled names the loads a day lists only as \"(scheduled)\". Base: neither", async ({ eq }) => {
		for (const name of Object.keys(FIXTURES)) {
			eq(`${name}: dayListed`, now[name] && now[name].dayListed, NEW_LISTED[name]);
			eq(`${name}: dayScheduled`, now[name] && now[name].dayScheduled, NEW_SCHEDULED[name]);
		}
	});

	if (base) {
		await R.test(`§4d (BASE_SERVER_JS set) The base, lifted from ${path.basename(baseFile)} on the same fixtures, answers the recorded values`, async ({ eq }) => {
			for (const name of Object.keys(FIXTURES)) {
				eq(`${name}: the five fields`, pick(base[name], UNCHANGED), BASE_UNCHANGED[name]);
				eq(`${name}: the stored grid`, base[name] && base[name].stored, BASE_STORED[name]);
			}
		});
	}

	// §5
	await R.test("§5a GET /api/invoices adds pay_basis and load_count to each row: daily (7 days of 6 loads), percentage (3 loads at 30%), manual (2 line items), a row stored before render data (daily), unreadable load_ids (0). Base: neither field", async ({ eq }) => {
		const w = labelsWorld();
		const r = await W.route(w, "GET /api/invoices");
		eq("status", r.status, 200);
		const got = Object.fromEntries((r.body && r.body.invoices || []).map((x) => [x.invoice_number, [x.pay_basis, x.load_count]]));
		eq("[pay_basis, load_count]", got, {
			"INV-NB-DAILY": ["daily", 6], "INV-NB-PCT": ["percentage", 3], "INV-M-NB-01": ["manual", 0], "INV-NB-OLD": ["daily", 2], "INV-NB-BADIDS": ["daily", 0],
		});
	});

	await R.test("§5b invoicePayBasesOf() (the driver app's list) gives each id its pay_basis; GET /api/driver/:driverName sets each row's pay_basis from it; invoiceCountRows() is the submit email's rows. Base: none", async ({ eq, ok }) => {
		const w = labelsWorld();
		const ids = Object.fromEntries(w.db.prepare("SELECT invoice_number, id FROM invoices").all().map((x) => [x.invoice_number, x.id]));
		const map = w.api.invoicePayBasesOf([ids["INV-NB-DAILY"], ids["INV-NB-PCT"], ids["INV-M-NB-01"]]);
		eq("pay bases", [map.get(ids["INV-NB-DAILY"]), map.get(ids["INV-NB-PCT"]), map.get(ids["INV-M-NB-01"]), w.api.invoicePayBasesOf([]).size], ["daily", "percentage", "manual", 0]);
		const route = W.SRC.split("\napp.get(\"/api/driver/:driverName\",")[1] || "";
		ok("GET /api/driver/:driverName: pay_basis from invoicePayBasesOf()", /invoicePayBasesOf\(driverInvoices\.map\(\(r\) => r\.id\)\)/.test(route.slice(0, route.indexOf("\n});\n"))));
		const rowOf = (no) => w.db.prepare("SELECT * FROM invoices WHERE invoice_number = ?").get(no);
		eq("daily", w.api.invoiceCountRows(rowOf("INV-NB-DAILY")), [["Days paid", "7"], ["Daily rate", "$300.00"], ["Loads", "6"]]);
		eq("percentage", w.api.invoiceCountRows(rowOf("INV-NB-PCT")), [["Loads", "3"], ["Pay %", "30%"]]);
		eq("manual", w.api.invoiceCountRows(rowOf("INV-M-NB-01")), [["Line items", "2"]]);
	});
}

function labelsWorld() {
	const w = W.startWorld({ drivers: [{ name: NIA, payDaily: 300 }], routes: [["get", "/api/invoices"]], expose: ["invoicePayBasis", "invoiceLoadCount", "invoicePayBasesOf", "invoiceCountRows"] });
	const insert = (o) => {
		const row = {
			driver: "nia brooks", week_start: "2026-10-17", week_end: "2026-10-23", loads_count: 7, rate_per_load: 300, total_earnings: 2100,
			expenses_total: 0, status: "Submitted", pdf_file_name: `${o.invoice_number}.pdf`, load_ids: "[]", expense_ids: "[]", render_data: "{}", adjustment: 0, is_manual: 0, ...o,
		};
		const cols = Object.keys(row);
		w.db.prepare(`INSERT INTO invoices (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
	};
	insert({ invoice_number: "INV-NB-DAILY", load_ids: JSON.stringify(["L0", "L1", "L2", "L3", "L4", "L5"]), render_data: JSON.stringify({ __templateName: "service_invoice", days: {} }) });
	insert({ invoice_number: "INV-NB-PCT", loads_count: 3, rate_per_load: 30, load_ids: JSON.stringify(["P1", "P2", "P3"]), render_data: JSON.stringify({ __templateName: "service_invoice_owner_op" }) });
	insert({ invoice_number: "INV-M-NB-01", loads_count: 2, rate_per_load: 0, is_manual: 1, render_data: JSON.stringify({ __templateName: "service_invoice_manual" }) });
	insert({ invoice_number: "INV-NB-OLD", loads_count: 3, load_ids: JSON.stringify(["Q1", "Q2"]), render_data: "" });
	insert({ invoice_number: "INV-NB-BADIDS", load_ids: "not json", render_data: "{not json" });
	return w;
}

if (MODE === "dates") {
	childDates().then((o) => { process.stdout.write(JSON.stringify(o)); W.cleanup(); }, (e) => { process.stdout.write(JSON.stringify({ error: String(e && e.message) })); });
} else if (MODE === "paid-days") {
	childPaidDays().then((o) => { process.stdout.write(JSON.stringify(o)); W.cleanup(); }, (e) => { process.stdout.write(JSON.stringify({ error: String(e && e.message) })); });
} else {
	const R = W.createRunner("B23 / R13: each weekly invoice row prints its date and the loads it lists; the counts say what they hold");
	main(R).then(() => R.finish(), (e) => { console.error(e && e.stack || e); process.exit(1); });
}
