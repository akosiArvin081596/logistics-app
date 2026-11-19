#!/usr/bin/env node
/**
 * An ELD device link or swap counts from its instant forward (ELD_LINK_FORWARD_ONLY_ENABLED with
 * ELD_LINK_FORWARD_ONLY_FROM; lib/eld-link-forward.js): the three pay paths (the weekly invoice, GET /api/investor and
 * the payout ledger), the trip work-day rule, the pre-dispatch filter, the start-up rule and the link routes' stop, run
 * as the server runs them (scripts/lib/work-days-world.js), on made-up trucks T-101, T-202 and T-303 and devices D-7,
 * D-9 and D-11.
 *
 *   §1 new cases (each fails on a build without the rule): H1, N2 (b) window rule, M2, N5 with R2, R4, R1, N4; and
 *      review 2's M1 (a swap's minutes with no device take no day the devices showed: window rule, trip rule, and a
 *      western truck's business-clock day), each failing on the first build of the rule (636335cc)
 *   §2 pins (they pass on such a build too; each names the mutant it catches): M1, N2 (a), N2 (b) trip rule, N3,
 *      N8, no FROM, switch off, N1 at the stop
 *   §3 the link routes under the rule: L3, the narrowed stop and its passing twin, the link line; review 2's H1 (a rename
 *      after an unlink refused while the truck has device history) and its switch-off pin
 *
 * Pure: no server, no app.db, no network. Run: node scripts/test-eld-link-forward.js   # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const W = require("./lib/work-days-world");

const runner = W.createRunner("test-eld-link-forward: an ELD link or swap counts from its instant forward");
const test = runner.test;

const HISTORY_START = "2026-10-03T03:00:00.000Z";
const FROM = "2026-11-02T15:00:00.000Z";
const ON = (extra = {}) => ({ ELD_LINK_FORWARD_ONLY_ENABLED: "true", ELD_LINK_FORWARD_ONLY_FROM: FROM, ...extra });
const TRIP = { TRIP_WORK_DAYS_ENABLED: "true", TRIP_WORK_DAYS_FROM: "2026-11" };
const PRE = { PRE_DISPATCH_PAY_DAY_RULE_ENABLED: "true", PRE_DISPATCH_PAY_DAY_RULE_FROM: "2026-11" };
const PAT = "Pat Example";
const SAM = "Sam Sample";
const LEE = "Lee Other";
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");
const utc = (iso) => new Date(iso).toISOString().slice(0, 19).replace("T", " ");
const days = (a, b) => W.daysFrom(a, b);

// A device's fixes every 15 minutes from `fromIso` to `toIso`, `miles` in all from odometer `odo` (speed 10 m/s while
// it moves), at `at` (Dallas, the Central band, unless given).
function track(fromIso, toIso, { odo = 100000, miles = 0, at = W.DALLAS } = {}) {
	const a = Date.parse(fromIso);
	const b = Date.parse(toIso);
	const steps = Math.max(1, Math.round((b - a) / (15 * 60000)));
	const out = [];
	for (let i = 0; i <= steps; i++) out.push({ ms: a + i * 15 * 60000, lat: at.lat, lng: at.lng + i * 0.0005, odo: odo + (miles * i) / steps, speed: miles ? 10 : 0 });
	return out;
}
const driveDay = (day, opts = {}) => track(`${day}T14:00:00Z`, `${day}T22:00:00Z`, { miles: 200, ...opts });
const parkDay = (day, opts = {}) => track(`${day}T18:00:00Z`, `${day}T19:00:00Z`, opts);

// One server start on the made-up fleet, with the device history (a seed at HISTORY_START, then the changes) and FROM
// recorded at an earlier start when `recorded` is given.
function world({ env = {}, trucks, history = [], recorded = null, historyStart = HISTORY_START, historyLinks = 2, rows = [], pings = {}, status = [], coords = {}, now, locks = [], routes = [], expose = [], vehicles = [] }) {
	const drivers = [{ name: PAT }, { name: SAM }, { name: LEE }];
	const w = W.startWorld({ env, drivers, trucks, rows, pings, status, coords, now, locks, routes, expose });
	w.db.prepare("INSERT INTO server_state (key, value, updated_at) VALUES ('eld_device_history_started', ?, CURRENT_TIMESTAMP)")
		.run(JSON.stringify({ at: historyStart, atMs: Date.parse(historyStart), links: historyLinks }));
	const ins = w.db.prepare("INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from, assigned_until, assigned_by) VALUES (?, ?, ?, ?, ?)");
	for (const h of history) ins.run(h.truck, h.vid, h.from, h.until || "", h.by || "qa-admin");
	if (recorded) {
		w.db.prepare("INSERT INTO server_state (key, value, updated_at) VALUES ('eld_link_forward_from', ?, CURRENT_TIMESTAMP)")
			.run(JSON.stringify({ from: recorded, fromMs: Date.parse(recorded), recordedAt: recorded }));
	}
	const rv = w.db.prepare("INSERT INTO routemate_vehicles (routemate_vehicle_id, vehicle_id) VALUES (?, ?)");
	for (const v of vehicles) rv.run(v, v);
	return w;
}
const seed = (truck, vid, until = "") => ({ truck, vid, from: HISTORY_START, until, by: "system:seed" });
const linkRow = (truck, vid, from, until = "") => ({ truck, vid, from, until, by: "qa-admin" });

// The driver's paid days inside `scope` on the weekly invoice for the week ending `weekEnd`, the investor view and the
// payout ledger (investor 5's scope).
async function threePaths(w, driver, weekEnd, scope) {
	const inScope = (list) => [...new Set(list)].filter((d) => scope.includes(d)).sort();
	const g = await W.generate(w, driver, weekEnd);
	const inv = await W.investorDays(w);
	const led = await W.ledger(w);
	return {
		invoice: inScope(W.gridDays(g.data, weekEnd).map((e) => e.day)),
		investor: inScope(inv.days.filter((x) => norm(x.driver) === norm(driver)).map((x) => x.day)),
		ledger: inScope(led.pay.filter((x) => norm(x.driver) === norm(driver)).map((x) => x.day)),
		status: g.status,
	};
}
function samePaths(eq, got, want, label = "") {
	eq(`${label}the weekly invoice pays`, got.invoice, want);
	eq(`${label}GET /api/investor pays`, got.investor, want);
	eq(`${label}the payout ledger pays`, got.ledger, want);
}

// ---- H1: a device unlinked and left unlinked ------------------------------------------------------------------------
// T-101 carried D-7 from the history start until Nov 16, when it was unlinked; no device since.
function h1World({ env = ON(), recorded = FROM, trip = false, now = "2026-11-20T17:00:00Z", trucksVid = "", history = null, historyStart = HISTORY_START, historyLinks = 2, expose = [] } = {}) {
	return world({
		env: { ...env, ...(trip ? TRIP : {}) }, recorded, historyStart, historyLinks, expose,
		trucks: [{ unit: "T-101", driver: PAT, vid: trucksVid }],
		history: history || [seed(1, "D-7", "2026-11-16T15:00:00.000Z")],
		rows: [W.loadRow({ id: "L-H1", driver: PAT, pickup: "2026-11-09", dropoff: "2026-11-11", assigned: "2026-11-09", done: "2026-11-11", truck: "T-101" })],
		pings: { "D-7": [...driveDay("2026-11-09", { odo: 100000 }), ...parkDay("2026-11-10", { odo: 100200 }), ...driveDay("2026-11-11", { odo: 100200, miles: 150 })] },
		status: trip ? [
			["L-H1", "At Shipper", "manual", utc("2026-11-09T15:00:00Z")], ["L-H1", "Loading", "manual", utc("2026-11-09T15:30:00Z")],
			["L-H1", "In Transit", "manual", utc("2026-11-09T17:00:00Z")], ["L-H1", "At Receiver", "manual", utc("2026-11-11T16:00:00Z")],
			["L-H1", "Delivered", "manual", utc("2026-11-11T19:00:00Z")],
		] : [],
		now: Date.parse(now),
	});
}
const H1_DAYS = days("2026-11-09", "2026-11-11");

// ---- N2 (b): T-101's old device reports only on the swap morning, and goes on to T-202 ---------------------------
// Nov 18: unlink T-101 (D-9) 15:00Z, re-point T-202 from D-7 to D-9 15:01Z, link T-101 to D-7 15:02Z.
function swapWorld({ trip = false } = {}) {
	return world({
		env: { ...ON(), ...(trip ? TRIP : {}) }, recorded: FROM,
		trucks: [{ unit: "T-101", driver: PAT, vid: "D-7" }, { unit: "T-202", driver: SAM, vid: "D-9" }],
		history: [
			seed(1, "D-9", "2026-11-18T15:00:00.000Z"), seed(2, "D-7", "2026-11-18T15:01:00.000Z"),
			linkRow(2, "D-9", "2026-11-18T15:01:00.000Z"), linkRow(1, "D-7", "2026-11-18T15:02:00.000Z"),
		],
		rows: [W.loadRow({ id: "L-B", driver: PAT, pickup: "2026-11-14", dropoff: "2026-11-20", assigned: "2026-11-14", done: "2026-11-20", truck: "T-101" })],
		pings: {
			"D-9": [...track("2026-11-18T13:00:00Z", "2026-11-18T14:45:00Z", { odo: 200000, miles: 40 }),
				...track("2026-11-18T16:00:00Z", "2026-11-18T22:00:00Z", { odo: 300900, miles: 200 }),
				...driveDay("2026-11-19", { odo: 301100 }), ...driveDay("2026-11-20", { odo: 301300 })],
			"D-7": [...days("2026-11-14", "2026-11-17").flatMap((d, i) => driveDay(d, { odo: 300000 + i * 200 })),
				...track("2026-11-18T13:00:00Z", "2026-11-18T14:30:00Z", { odo: 300800, miles: 50 }),
				...track("2026-11-18T16:00:00Z", "2026-11-18T22:00:00Z", { odo: 200040, miles: 200 }),
				...driveDay("2026-11-19", { odo: 200240 }), ...driveDay("2026-11-20", { odo: 200440 })],
		},
		status: trip ? [
			["L-B", "At Shipper", "manual", utc("2026-11-14T15:00:00Z")], ["L-B", "Loading", "manual", utc("2026-11-14T15:30:00Z")],
			["L-B", "In Transit", "manual", utc("2026-11-14T17:00:00Z")], ["L-B", "At Receiver", "manual", utc("2026-11-20T16:00:00Z")],
			["L-B", "Delivered", "manual", utc("2026-11-20T19:00:00Z")],
		] : [],
		now: Date.parse("2026-11-23T17:00:00Z"),
	});
}
const WEEK_47 = days("2026-11-14", "2026-11-20");

(async () => {
	console.log("§1 new cases");

	await test("H1 window rule: a day before an unlink still reads the unlinked device's fixes, on the three paths", async ({ eq }) => {
		samePaths(eq, await threePaths(h1World(), PAT, "2026-11-13", H1_DAYS), ["2026-11-09", "2026-11-11"]);
	});

	await test("H1 trip rule: the same load under TRIP_WORK_DAYS reads D-7's fixes (Nov 10 a rest day)", async ({ eq }) => {
		samePaths(eq, await threePaths(h1World({ trip: true }), PAT, "2026-11-13", H1_DAYS), ["2026-11-09", "2026-11-11"]);
	});

	await test("H1 reader 2: the trip rule's other callers (here its month-lock cover) read the truck through the history, not today's link", async ({ eq }) => {
		const w = h1World({ trip: true, expose: ["tripDayLockCover"] });
		const values = W.sheetValues(w.rows);
		const row = Object.fromEntries(values[0].map((h, i) => [h, values[1][i]]));
		eq("the lock cover's days for L-H1", w.api.tripDayLockCover(values[0]).daysFor(row), { days: ["2026-11-09", "2026-11-11"] });
	});

	await test("H1 reader 5: the travel-day warm-up fetches the history's devices, under the key the readers ask with", async ({ ok }) => {
		const w = h1World({ expose: ["warmEldTravelMemo", "_eldTravelMemo"] });
		w.api.warmEldTravelMemo();
		const keys = [...w.api._eldTravelMemo.keys()];
		ok("the warm-up cached D-7, unlinked now, from 0", keys.includes("D-7|0"), JSON.stringify(keys));
	});

	await test("N2 (b) window rule: T-101's old device reported only on the swap morning, so its run before the swap stays covered and its dark days stay dropped", async ({ eq }) => {
		samePaths(eq, await threePaths(swapWorld(), PAT, "2026-11-20", WEEK_47), ["2026-11-18", "2026-11-19", "2026-11-20"]);
	});

	await test("M2: a silent device replaced by a reporting one mid-load, and the days before keep their pay", async ({ eq }) => {
		const w = world({
			env: ON(), recorded: FROM,
			trucks: [{ unit: "T-101", driver: PAT, vid: "D-9" }, { unit: "T-202", driver: SAM, vid: "" }],
			history: [seed(1, "D-7", "2026-11-18T15:01:00.000Z"), seed(2, "D-9", "2026-11-18T15:00:00.000Z"), linkRow(1, "D-9", "2026-11-18T15:01:00.000Z")],
			rows: [W.loadRow({ id: "L-M2", driver: PAT, pickup: "2026-11-14", dropoff: "2026-11-20", assigned: "2026-11-14", done: "2026-11-20", truck: "T-101" })],
			pings: {
				"D-7": days("2026-11-02", "2026-11-09").flatMap((d, i) => driveDay(d, { odo: 100000 + i * 200 })),
				"D-9": [...days("2026-11-14", "2026-11-17").flatMap((d) => parkDay(d, { odo: 300000 })),
					...track("2026-11-18T16:00:00Z", "2026-11-18T22:00:00Z", { odo: 101600, miles: 200 }),
					...driveDay("2026-11-19", { odo: 101800 }), ...driveDay("2026-11-20", { odo: 102000 })],
			},
			now: Date.parse("2026-11-23T17:00:00Z"),
		});
		samePaths(eq, await threePaths(w, PAT, "2026-11-20", WEEK_47), WEEK_47);
	});

	// N5 and R2: PRE_DISPATCH on. T-101 makes a 10-mile local move each day Nov 14-16 on D-9, which leaves it on Nov 17
	// before sending a reading; D-7, reading T-101's own odometer, joins it at 15:02Z. The load is dispatched Nov 19.
	const preWorld = ({ swap = true } = {}) => world({
		env: { ...ON(), ...PRE }, recorded: FROM,
		trucks: swap ? [{ unit: "T-101", driver: PAT, vid: "D-7" }, { unit: "T-202", driver: SAM, vid: "D-9" }] : [{ unit: "T-101", driver: PAT, vid: "D-9" }, { unit: "T-202", driver: SAM, vid: "D-7" }],
		history: swap
			? [seed(1, "D-9", "2026-11-17T15:00:00.000Z"), seed(2, "D-7", "2026-11-17T15:01:00.000Z"), linkRow(2, "D-9", "2026-11-17T15:01:00.000Z"), linkRow(1, "D-7", "2026-11-17T15:02:00.000Z")]
			: [seed(1, "D-9"), seed(2, "D-7")],
		rows: [W.loadRow({ id: "L-N5", driver: PAT, pickup: "2026-11-14", dropoff: "2026-11-20", assigned: "2026-11-14", done: "2026-11-20", truck: "T-101" })],
		coords: { "L-N5": W.PICKUP },
		status: [["L-N5", "Dispatched", "manual", utc("2026-11-19T14:00:00Z")]],
		pings: {
			"D-9": [...parkDay("2026-11-13", { odo: 100000 }),
				...days("2026-11-14", "2026-11-16").flatMap((d, i) => parkDay(d, { odo: 100000 + i * 10, miles: 10 })),
				...(swap
					? [...track("2026-11-17T18:00:00Z", "2026-11-17T22:00:00Z", { odo: 300800, miles: 150 }), ...driveDay("2026-11-18", { odo: 300950 })]
					: [...track("2026-11-17T18:00:00Z", "2026-11-17T22:00:00Z", { odo: 100030, miles: 150 }), ...driveDay("2026-11-18", { odo: 100180 }),
						...driveDay("2026-11-19", { odo: 100380 }), ...driveDay("2026-11-20", { odo: 100580 })]),
			],
			"D-7": [...days("2026-11-13", "2026-11-16").flatMap((d, i) => driveDay(d, { odo: 300000 + i * 200 })),
				...(swap ? [...track("2026-11-17T18:00:00Z", "2026-11-17T22:00:00Z", { odo: 100030, miles: 150 }), ...driveDay("2026-11-18", { odo: 100180 }),
					...driveDay("2026-11-19", { odo: 100380 }), ...driveDay("2026-11-20", { odo: 100580 })] : [])],
		},
		now: Date.parse("2026-11-23T17:00:00Z"),
	});

	await test("N5 with R2: per-run calls take the whole window, so the idle days before the swap drop; the day before the swap is not added and the swap day is kept", async ({ eq }) => {
		samePaths(eq, await threePaths(preWorld(), PAT, "2026-11-20", WEEK_47), ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
	});

	await test("R2 control (passes on any build): with no swap the same idle days drop (Nov 16 among them)", async ({ eq }) => {
		samePaths(eq, await threePaths(preWorld({ swap: false }), PAT, "2026-11-20", WEEK_47), ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
	});

	await test("R4: under the trip rule, a device moved to another truck after the load keeps the load's fixes (its link time comes from the row covering each fix)", async ({ eq }) => {
		const w = world({
			env: { ...ON(), ...TRIP }, recorded: FROM,
			trucks: [{ unit: "T-101", driver: PAT, vid: "" }, { unit: "T-202", driver: SAM, vid: "D-7" }],
			history: [seed(1, "D-7", "2026-12-20T15:00:00.000Z"), seed(2, "D-9", "2026-12-20T15:01:00.000Z"), linkRow(2, "D-7", "2026-12-20T15:01:00.000Z")],
			rows: [W.loadRow({ id: "L-R4", driver: PAT, pickup: "2026-11-24", dropoff: "2026-11-27", assigned: "2026-11-24", done: "2026-11-27", truck: "T-101" })],
			pings: { "D-7": [...driveDay("2026-11-24", { odo: 100000 }), ...driveDay("2026-11-25", { odo: 100200 }), ...track("2026-11-27T13:00:00Z", "2026-11-27T15:00:00Z", { odo: 100400, miles: 40 })] },
			status: [
				["L-R4", "At Shipper", "manual", utc("2026-11-24T15:00:00Z")], ["L-R4", "Loading", "manual", utc("2026-11-24T15:30:00Z")],
				["L-R4", "In Transit", "manual", utc("2026-11-24T17:00:00Z")], ["L-R4", "At Receiver", "manual", utc("2026-11-27T16:00:00Z")],
				["L-R4", "Delivered", "manual", utc("2026-11-27T19:00:00Z")],
			],
			now: Date.parse("2026-12-22T17:00:00Z"),
		});
		samePaths(eq, await threePaths(w, PAT, "2026-11-27", days("2026-11-24", "2026-11-27")), ["2026-11-24", "2026-11-25", "2026-11-27"]);
	});

	// ---- M1 (review 2): a three-call swap leaves the truck a minute or two with no device ------------------------------
	// T-101 is parked all of Nov 18 inside its load's window: 15:00Z D-9 unlinked, 15:02Z D-7 linked, and both devices
	// report it parked. D-9 drove Nov 16-17; D-7 drives Nov 19-20.
	const gapWorld = ({ trip = false } = {}) => world({
		env: { ...ON(), ...(trip ? TRIP : {}) }, recorded: FROM,
		trucks: [{ unit: "T-101", driver: PAT, vid: "D-7" }],
		history: [seed(1, "D-9", "2026-11-18T15:00:00.000Z"), linkRow(1, "D-7", "2026-11-18T15:02:00.000Z")],
		rows: [W.loadRow({ id: "L-G", driver: PAT, pickup: "2026-11-16", dropoff: "2026-11-20", assigned: "2026-11-16", done: "2026-11-20", truck: "T-101" })],
		pings: {
			"D-9": [...driveDay("2026-11-16", { odo: 100000 }), ...driveDay("2026-11-17", { odo: 100200 }), ...track("2026-11-18T13:00:00Z", "2026-11-18T14:45:00Z", { odo: 100400 })],
			"D-7": [...track("2026-11-18T16:00:00Z", "2026-11-18T22:00:00Z", { odo: 500000 }), ...driveDay("2026-11-19", { odo: 500000 }), ...driveDay("2026-11-20", { odo: 500200 })],
		},
		status: trip ? [
			["L-G", "At Shipper", "manual", utc("2026-11-16T15:00:00Z")], ["L-G", "Loading", "manual", utc("2026-11-16T15:30:00Z")],
			["L-G", "In Transit", "manual", utc("2026-11-16T17:00:00Z")], ["L-G", "At Receiver", "manual", utc("2026-11-20T16:00:00Z")],
			["L-G", "Delivered", "manual", utc("2026-11-20T19:00:00Z")],
		] : [],
		now: Date.parse("2026-11-23T17:00:00Z"),
	});
	const GAP_PAID = ["2026-11-16", "2026-11-17", "2026-11-19", "2026-11-20"];

	await test("M1 (review 2) window rule: the swap's minutes with no device take no day the devices showed, so the parked swap day is not paid", async ({ eq }) => {
		samePaths(eq, await threePaths(gapWorld(), PAT, "2026-11-20", WEEK_47), GAP_PAID);
	});

	await test("M1 (review 2) trip rule: the same swap day is the rest day the devices showed, not a no-ELD day", async ({ eq }) => {
		samePaths(eq, await threePaths(gapWorld({ trip: true }), PAT, "2026-11-20", WEEK_47), GAP_PAID);
	});

	// A western truck (Los Angeles, the Pacific band): 05:00Z Nov 19 D-9 unlinked and 05:02Z D-7 linked, 9 PM on the truck's
	// own Nov 18 but already Nov 19 on the business clock. D-9 drove Nov 17-18; D-7 has it parked Nov 19 and driving Nov 20.
	const LA = { lat: 34.05, lng: -118.24 };
	await test("M1 (review 2) the business-clock touch: the swap's minutes take no western truck's next day either (Nov 19 parked, not paid)", async ({ eq }) => {
		const w = world({
			env: ON(), recorded: FROM,
			trucks: [{ unit: "T-101", driver: PAT, vid: "D-7" }],
			history: [seed(1, "D-9", "2026-11-19T05:00:00.000Z"), linkRow(1, "D-7", "2026-11-19T05:02:00.000Z")],
			rows: [W.loadRow({ id: "L-W", driver: PAT, pickup: "2026-11-17", dropoff: "2026-11-20", assigned: "2026-11-17", done: "2026-11-20", truck: "T-101" })],
			pings: {
				"D-9": [...driveDay("2026-11-17", { odo: 100000, at: LA }), ...driveDay("2026-11-18", { odo: 100200, at: LA })],
				"D-7": [...parkDay("2026-11-19", { odo: 500000, at: LA }), ...driveDay("2026-11-20", { odo: 500000, at: LA })],
			},
			now: Date.parse("2026-11-23T17:00:00Z"),
		});
		samePaths(eq, await threePaths(w, PAT, "2026-11-20", WEEK_47), ["2026-11-17", "2026-11-18", "2026-11-20"]);
	});

	await test("R1: a history row opened between FROM and the start keeps the rule off, names the row, and records nothing", async ({ eq, ok }) => {
		const w = world({
			env: ON(), recorded: null, expose: ["eldLinkForwardRule"],
			trucks: [{ unit: "T-101", driver: PAT, vid: "D-11" }],
			history: [seed(1, "D-7", "2026-11-03T15:00:00.000Z"), linkRow(1, "D-11", "2026-11-03T15:00:00.000Z")],
			now: Date.parse("2026-11-05T17:00:00Z"),
		});
		const rule = w.api.eldLinkForwardRule();
		eq("the rule is not in force", rule.inForce, false);
		ok("the start-up line names the rows between FROM and the start", rule.lines.some((l) => /2 ELD link history rows were opened or closed between ELD_LINK_FORWARD_ONLY_FROM 2026-11-02T15:00:00.000Z and this start \(row 1 .*row 2/.test(l.text)), JSON.stringify(rule.lines));
		eq("nothing is recorded", w.db.prepare("SELECT COUNT(*) AS n FROM server_state WHERE key = 'eld_link_forward_from'").get().n, 0);
	});

	await test("R1 twin: with no row between FROM and the start the rule comes into force and records FROM once", async ({ eq }) => {
		const w = world({ env: ON(), recorded: null, expose: ["eldLinkForwardRule"], trucks: [{ unit: "T-101", driver: PAT, vid: "D-7" }], history: [seed(1, "D-7")], now: Date.parse("2026-11-05T17:00:00Z") });
		const rule = w.api.eldLinkForwardRule();
		eq("in force from FROM", [rule.inForce, rule.fromMs], [true, Date.parse(FROM)]);
		eq("FROM recorded", JSON.parse(w.db.prepare("SELECT value FROM server_state WHERE key = 'eld_link_forward_from'").get().value).fromMs, Date.parse(FROM));
	});

	await test("N4: with the switch off, an unlink-only history after the recorded FROM warns that switching off re-reads the past", async ({ eq, ok }) => {
		const w = world({
			env: {}, recorded: FROM, expose: ["eldLinkForwardRule"], trucks: [{ unit: "T-101", driver: PAT, vid: "" }],
			history: [seed(1, "D-7", "2026-11-16T15:00:00.000Z")], now: Date.parse("2026-11-20T17:00:00Z"),
		});
		const rule = w.api.eldLinkForwardRule();
		eq("the rule is not in force", rule.inForce, false);
		ok("the warning names the row closed after FROM", rule.lines.some((l) => l.level === "warn" && /1 ELD link history row was opened or closed after the recorded FROM/.test(l.text)), JSON.stringify(rule.lines));
	});

	await test("N4: with the switch on and the FROM setting gone, the rule runs on the recorded FROM and logs an error", async ({ eq, ok }) => {
		const w = world({
			env: { ELD_LINK_FORWARD_ONLY_ENABLED: "true" }, recorded: FROM, expose: ["eldLinkForwardRule"], trucks: [{ unit: "T-101", driver: PAT, vid: "D-7" }],
			history: [seed(1, "D-7")], now: Date.parse("2026-11-20T17:00:00Z"),
		});
		const rule = w.api.eldLinkForwardRule();
		eq("in force on the recorded FROM", [rule.inForce, rule.fromMs], [true, Date.parse(FROM)]);
		ok("an error line", rule.lines.some((l) => l.level === "error" && /ELD_LINK_FORWARD_ONLY_FROM is not set; the rule runs on the recorded FROM/.test(l.text)), JSON.stringify(rule.lines));
	});

	console.log("\n§2 pins (they pass on a build without the rule; each names the mutant it catches)");

	await test("M1 pin (mutant: FROM ignored): a swap before FROM, then the switch on, reads every day before FROM as today", async ({ eq }) => {
		const build = (env) => world({
			env: { ...env, ...TRIP }, recorded: env.ELD_LINK_FORWARD_ONLY_ENABLED ? FROM : null,
			trucks: [{ unit: "T-101", driver: PAT, vid: "D-9" }, { unit: "T-202", driver: SAM, vid: "D-7" }],
			history: [seed(1, "D-7", "2026-10-20T15:00:00.000Z"), seed(2, "D-9", "2026-10-20T15:01:00.000Z"), linkRow(2, "D-7", "2026-10-20T15:01:00.000Z"), linkRow(1, "D-9", "2026-10-20T15:02:00.000Z")],
			rows: [
				W.loadRow({ id: "L-M1A", driver: PAT, pickup: "2026-10-12", dropoff: "2026-10-14", assigned: "2026-10-12", done: "2026-10-14", truck: "T-101" }),
				W.loadRow({ id: "L-M1B", driver: PAT, pickup: "2026-10-26", dropoff: "2026-10-28", assigned: "2026-10-26", done: "2026-10-28", truck: "T-101" }),
			],
			pings: {
				"D-7": [...driveDay("2026-10-12", { odo: 100000 }), ...parkDay("2026-10-13", { odo: 100200 }), ...driveDay("2026-10-14", { odo: 100200 }), ...driveDay("2026-10-27", { odo: 300000 })],
				"D-9": [...parkDay("2026-10-12", { odo: 300000 }), ...driveDay("2026-10-13", { odo: 300000 }), ...driveDay("2026-10-26", { odo: 100400 }), ...parkDay("2026-10-27", { odo: 100600 }), ...driveDay("2026-10-28", { odo: 100600 })],
			},
			status: [
				["L-M1B", "At Shipper", "manual", utc("2026-10-26T14:00:00Z")], ["L-M1B", "Loading", "manual", utc("2026-10-26T14:30:00Z")],
				["L-M1B", "In Transit", "manual", utc("2026-10-26T16:00:00Z")], ["L-M1B", "At Receiver", "manual", utc("2026-10-28T15:00:00Z")],
				["L-M1B", "Delivered", "manual", utc("2026-10-28T18:00:00Z")],
			],
			now: Date.parse("2026-11-05T17:00:00Z"),
		});
		const scope = days("2026-10-10", "2026-10-30");
		const off = build({});
		const on = build(ON());
		const a = { w16: await threePaths(off, PAT, "2026-10-16", scope), w30: await threePaths(off, PAT, "2026-10-30", scope) };
		const b = { w16: await threePaths(on, PAT, "2026-10-16", scope), w30: await threePaths(on, PAT, "2026-10-30", scope) };
		eq("the paid days on every path, switch on against off", b, a);
		eq("the investor view's whole answer, switch on against off", (await W.investorDays(on)).body, (await W.investorDays(off)).body);
		eq("the ledger's items, switch on against off", (await W.ledger(on)).items, (await W.ledger(off)).items);
	});

	await test("N2 (a) pin (mutant: the change day read by day): a silent device moved off T-202 at 10:00 leaves T-202's days before the swap all paid", async ({ eq }) => {
		const w = world({
			env: ON(), recorded: FROM,
			trucks: [{ unit: "T-101", driver: PAT, vid: "D-7" }, { unit: "T-202", driver: SAM, vid: "" }],
			history: [seed(2, "D-7", "2026-11-18T16:00:00.000Z"), seed(1, "D-9", "2026-11-18T16:01:00.000Z"), linkRow(1, "D-7", "2026-11-18T16:01:00.000Z")],
			rows: [W.loadRow({ id: "L-N2A", driver: SAM, pickup: "2026-11-16", dropoff: "2026-11-20", assigned: "2026-11-16", done: "2026-11-20", truck: "T-202" })],
			pings: { "D-7": [...track("2026-11-18T16:30:00Z", "2026-11-18T22:00:00Z", { odo: 100000, miles: 150 }), ...driveDay("2026-11-19", { odo: 100150 })] },
			now: Date.parse("2026-11-23T17:00:00Z"),
		});
		samePaths(eq, await threePaths(w, SAM, "2026-11-20", WEEK_47), days("2026-11-16", "2026-11-20"));
	});

	await test("N2 (b) trip rule pin (mutant: the trip rule's link time from the device's open row, R4): T-101's earlier run stays covered, its dark days dropped", async ({ eq }) => {
		samePaths(eq, await threePaths(swapWorld({ trip: true }), PAT, "2026-11-20", WEEK_47), ["2026-11-14", "2026-11-18", "2026-11-19", "2026-11-20"]);
	});

	// The pay paths read only the link at FROM before it (truckRuns()), so the resolver's own FROM-day reads, where a row
	// closed before FROM could count, are pinned in test-eld-device-history.js §1b.3 and §1b.4.
	await test("N3 pin (mutant: FROM ignored): an unlink on FROM's morning does not come back that day", async ({ eq }) => {
		const from = "2026-11-18T20:00:00.000Z";
		const w = world({
			env: ON({ ELD_LINK_FORWARD_ONLY_FROM: from }), recorded: from,
			trucks: [{ unit: "T-202", driver: SAM, vid: "" }],
			history: [seed(1, "D-9", "2026-11-18T14:00:00.000Z")],
			rows: [W.loadRow({ id: "L-N3", driver: SAM, pickup: "2026-11-17", dropoff: "2026-11-19", assigned: "2026-11-17", done: "2026-11-19", truck: "T-202" })],
			pings: { "D-9": [...parkDay("2026-11-17", { odo: 100000 }), ...track("2026-11-18T13:00:00Z", "2026-11-18T13:45:00Z", { odo: 100000 })] },
			now: Date.parse("2026-11-23T17:00:00Z"),
		});
		samePaths(eq, await threePaths(w, SAM, "2026-11-20", WEEK_47), days("2026-11-17", "2026-11-19"));
	});

	await test("N3 pin (mutant: the rule on with FROM before the history start): such a FROM keeps the rule off and today's links read", async ({ eq }) => {
		// The history began Nov 1 with no link on record; T-101's link to D-7 has no row.
		const w = h1World({ env: ON({ ELD_LINK_FORWARD_ONLY_FROM: "2026-10-20T15:00:00Z" }), recorded: null, trucksVid: "D-7", history: [], historyStart: "2026-11-01T03:00:00.000Z", historyLinks: 0 });
		samePaths(eq, await threePaths(w, PAT, "2026-11-13", H1_DAYS), ["2026-11-09", "2026-11-11"]);
	});

	await test("N8 pin (mutant: a fleet-wide truck map in an investor's scope): investor 5's scope reads no ELD for another owner's truck", async ({ eq }) => {
		const w = world({
			env: ON(), recorded: FROM,
			trucks: [{ unit: "T-101", driver: PAT, vid: "D-7" }, { unit: "T-303", driver: LEE, owner: 6, vid: "D-11" }],
			history: [seed(1, "D-7"), seed(2, "D-11")],
			rows: [W.loadRow({ id: "L-N8", driver: PAT, pickup: "2026-11-09", dropoff: "2026-11-11", assigned: "2026-11-09", done: "2026-11-11", truck: "T-303" })],
			pings: { "D-11": [...driveDay("2026-11-09", { odo: 500000 }), ...parkDay("2026-11-10", { odo: 500200 }), ...driveDay("2026-11-11", { odo: 500200 })] },
			now: Date.parse("2026-11-20T17:00:00Z"),
		});
		const inv = await W.investorDays(w);
		const led = await W.ledger(w);
		const pick = (list) => [...new Set(list.filter((x) => norm(x.driver) === norm(PAT)).map((x) => x.day))].filter((d) => H1_DAYS.includes(d)).sort();
		eq("GET /api/investor (investor 5) pays the whole window", pick(inv.days), H1_DAYS);
		eq("the payout ledger (investor 5) pays the whole window", pick(led.pay), H1_DAYS);
	});

	await test("no FROM pin (mutant: the rule running without FROM): the switch on with no FROM reads today's links", async ({ eq }) => {
		const w = h1World({ env: { ELD_LINK_FORWARD_ONLY_ENABLED: "true" }, recorded: null });
		samePaths(eq, await threePaths(w, PAT, "2026-11-13", H1_DAYS), H1_DAYS);
	});

	await test("switch-off pin (mutant: a dated read leaking into the off path): the switch off re-reads the past through today's link, as before", async ({ eq }) => {
		const w = h1World({ env: {}, recorded: FROM });
		samePaths(eq, await threePaths(w, PAT, "2026-11-13", H1_DAYS), H1_DAYS);
	});

	console.log("\n§3 the link routes under the rule");
	const ROUTES = [["post", "/api/trucks/:truckId/link-routemate"], ["delete", "/api/trucks/:truckId/link-routemate"]];
	// October is finalized. T-101's October load ended Oct 28; T-202's October load is still running on Nov 18.
	const stopWorld = ({ env = ON(), now = "2026-11-18T16:00:00Z", recorded = FROM } = {}) => world({
		env, recorded, routes: ROUTES, locks: ["2026-10"], vehicles: ["D-7", "D-9", "D-11"],
		trucks: [{ unit: "T-101", driver: PAT, vid: "D-7" }, { unit: "T-202", driver: SAM, vid: "D-9" }],
		history: [seed(1, "D-7"), seed(2, "D-9")],
		rows: [
			W.loadRow({ id: "L-OCT1", driver: PAT, pickup: "2026-10-26", dropoff: "2026-10-28", assigned: "2026-10-26", done: "2026-10-28", truck: "T-101" }),
			W.loadRow({ id: "L-OCT2", driver: SAM, pickup: "2026-10-30", dropoff: "", assigned: "2026-10-30", done: "", status: "In Transit", truck: "T-202" }),
		],
		now: Date.parse(now),
	});
	const unlink = (w, id) => W.route(w, "DELETE /api/trucks/:truckId/link-routemate", { params: { truckId: String(id) } });
	const link = (w, id, vid) => W.route(w, "POST /api/trucks/:truckId/link-routemate", { params: { truckId: String(id) }, body: { routemateVehicleId: vid, confirmSilent: true } });

	await test("L3: an unlink of a truck whose finalized-month load ended before the change passes, with the line saying from when", async ({ eq, ok }) => {
		const w = stopWorld();
		const r = await unlink(w, 1);
		eq("200", r.status, 200);
		eq("the line", r.body && r.body.message, "Unlinked. From Wed Nov 18 11:00 (Eastern), T-101 has no ELD device. Before that keeps what it had.");
		const row = w.db.prepare("SELECT assigned_until FROM eld_device_assignments WHERE truck_id = 1").get();
		eq("the history row closes at the instant the stop judged", [row.assigned_until, r.body.effectiveAt], ["2026-11-18T16:00:00.000Z", "2026-11-18T16:00:00.000Z"]);
		ok("the truck is unlinked", w.db.prepare("SELECT routemate_vehicle_id AS v FROM trucks WHERE id = 1").get().v === "");
	});

	await test("L3: another unlink, of a truck whose finalized-month load is still running, refuses in the narrowed stop's words", async ({ eq }) => {
		const w = stopWorld();
		const r = await unlink(w, 2);
		eq("409 PERIOD_FINALIZED over October", [r.status, r.body && r.body.code, r.body && r.body.periods], [409, "PERIOD_FINALIZED", ["2026-10"]]);
		eq("the words", r.body && r.body.error,
			"Cannot unlink the ELD device on T-202: its load assigned in October 2026 runs on or after Wed Nov 18, so this would change pay in a finalized month. October 2026 is finalized. Nothing was changed.");
		eq("nothing changed", w.db.prepare("SELECT routemate_vehicle_id AS v FROM trucks WHERE id = 2").get().v, "D-9");
	});

	await test("the narrowed stop: a link on the truck whose finalized-month load ended passes; a re-point on the one still running refuses in its words", async ({ eq }) => {
		const w = stopWorld();
		const a = await link(w, 1, "D-11");
		eq("T-101 re-points to D-11", a.status, 200);
		eq("its line", a.body && a.body.message, "Linked. From Wed Nov 18 11:00 (Eastern), T-101's ELD readings come from D-11. Before that keeps what it had.");
		const b = await link(w, 2, "D-7");
		eq("T-202 is refused", [b.status, b.body && b.body.error], [409,
			"Cannot re-point the ELD device on T-202: its load assigned in October 2026 runs on or after Wed Nov 18, so this would change pay in a finalized month. October 2026 is finalized. Nothing was changed."]);
	});

	await test("N1 pin at the stop (mutant: the rule in force in a process started before FROM): a FROM after the start keeps check (5b) and its words", async ({ eq }) => {
		const w = stopWorld({ env: ON({ ELD_LINK_FORWARD_ONLY_FROM: "2026-11-25T15:00:00Z" }), recorded: null });
		const r = await unlink(w, 1);
		eq("409 with check (5b)'s words", [r.status, r.body && r.body.error], [409,
			"Cannot unlink the ELD device on T-101: unlinking the ELD device changes which days count as travelled for T-101, re-deriving driver pay across 1 finalized month that carry its loads. October 2026 is finalized. Closed months stay as recorded, and this would change which days count as worked in them. Nothing was changed."]);
	});

	// H1 (review 2): under the rule a past load finds its truck by the truck's unit, linked now or not, so a rename after an
	// unlink would leave October's T-101 rows on no truck, read as no ELD.
	const RENAME_ROUTES = [...ROUTES, ["put", "/api/trucks/:id"]];
	const rename = (w, id, unitNumber) => W.route(w, "PUT /api/trucks/:id", { params: { id: String(id) }, body: { unitNumber } });
	const renameWorld = ({ env = ON(), recorded = FROM, vid = "D-7", history = [seed(1, "D-7")] } = {}) => world({
		env, recorded, routes: RENAME_ROUTES, locks: ["2026-10"], vehicles: ["D-7"],
		trucks: [{ unit: "T-101", driver: PAT, vid }, { unit: "T-303", driver: LEE, vid: "" }],
		history,
		rows: [W.loadRow({ id: "L-OCT1", driver: PAT, pickup: "2026-10-26", dropoff: "2026-10-28", assigned: "2026-10-26", done: "2026-10-28", truck: "T-101" })],
		now: Date.parse("2026-11-25T16:00:00Z"),
	});
	const unitOf = (w, id) => w.db.prepare("SELECT unit_number AS u FROM trucks WHERE id = ?").get(id).u;

	await test("H1 (review 2): an unlink passes, then renaming the truck is refused while it has device history; a truck with none renames freely", async ({ eq }) => {
		const w = renameWorld();
		eq("the unlink passes", (await unlink(w, 1)).status, 200);
		const r = await rename(w, 1, "T-101A");
		eq("the rename is refused over October, by check (5)", [r.status, r.body && r.body.code, r.body && r.body.periods, ((r.body && r.body.blockers) || []).map((b) => b.field)],
			[409, "PERIOD_FINALIZED", ["2026-10"], ["unit_number"]]);
		eq("nothing changed", unitOf(w, 1), "T-101");
		const t = await rename(w, 2, "T-303A");
		eq("T-303, never linked, renames freely", [t.status, unitOf(w, 2)], [200, "T-303A"]);
	});

	await test("H1 fail-closed (review 2): with the device history unreadable, a rename is refused, even of a truck never linked", async ({ eq }) => {
		const w = renameWorld();
		// The unlink makes the rule's decision, as the boot call does; the history then becomes unreadable.
		eq("the unlink passes", (await unlink(w, 1)).status, 200);
		w.db.exec("DROP TABLE eld_device_assignments");
		const t = await rename(w, 2, "T-303A");
		eq("T-303's rename is refused over October", [t.status, t.body && t.body.code, unitOf(w, 2)], [409, "PERIOD_FINALIZED", "T-303"]);
	});

	await test("rename pin (mutant: the history check run with the rule off): switch off, an unlinked truck with device history renames as today", async ({ eq }) => {
		const w = renameWorld({ env: {}, recorded: null, vid: "", history: [seed(1, "D-7", "2026-11-16T15:00:00.000Z")] });
		const r = await rename(w, 1, "T-101A");
		eq("200, renamed", [r.status, unitOf(w, 1)], [200, "T-101A"]);
	});

	console.log("\n§4 IFTA and fuel events under the rule");
	const geolib = require("geolib");
	const IFTA_ROUTES = [["get", "/api/compliance/ifta"], ["get", "/api/compliance/ifta/state-detail"]];
	// `n` points 10 minutes apart from `fromIso`, moving east from `at` by `step` degrees each (about 1.2 miles in Texas).
	const pathPts = (fromIso, n, { at = W.DALLAS, step = 0.02 } = {}) => Array.from({ length: n }, (_, i) => ({
		ms: Date.parse(fromIso) + i * 600000, lat: at.lat, lng: at.lng + i * step, odo: 100000 + i, speed: 20,
	}));
	const miles = (pts) => pts.slice(1).reduce((sum, p, i) => sum + geolib.getDistance({ latitude: pts[i].lat, longitude: pts[i].lng }, { latitude: p.lat, longitude: p.lng }) * 0.000621371, 0);
	const ifta = async (w, start, end) => (await W.route(w, "GET /api/compliance/ifta", { query: { start, end } })).body;
	const truckMiles = (body, unit) => ((body.trucks || []).find((t) => t.unitNumber === unit) || { totalMiles: null }).totalMiles;

	await test("L5: IFTA joins points per truck and device, so the hop from the old device's last fix to the new one's first is not counted", async ({ eq }) => {
		const d7 = pathPts("2026-11-18T13:00:00Z", 12);
		const d9 = pathPts("2026-11-18T15:05:00Z", 12, { at: { lat: W.DALLAS.lat, lng: W.DALLAS.lng + 0.52 } });
		const w = world({
			env: ON(), recorded: FROM, routes: IFTA_ROUTES,
			trucks: [{ unit: "T-101", driver: PAT, vid: "D-9" }, { unit: "T-202", driver: SAM, vid: "" }],
			history: [seed(1, "D-7", "2026-11-18T15:00:00.000Z"), seed(2, "D-9", "2026-11-18T15:01:00.000Z"), linkRow(1, "D-9", "2026-11-18T15:02:00.000Z")],
			pings: { "D-7": d7, "D-9": d9 }, now: Date.parse("2026-11-20T17:00:00Z"),
		});
		eq("T-101's miles are both devices' own paths, no hop between them", truckMiles(await ifta(w, "2026-11-18T00:00:00Z", "2026-11-19T00:00:00Z"), "T-101"), Math.round(miles(d7) + miles(d9)));
	});

	// T-202 carried D-11 until Nov 15 and has had no device since.
	const unlinkedWorld = (extra = {}) => world({
		env: ON(), recorded: FROM, routes: IFTA_ROUTES, expose: ["detectAndPersistFuelEvents"],
		trucks: [{ unit: "T-101", driver: PAT, vid: "D-7" }, { unit: "T-202", driver: SAM, vid: "" }],
		history: [seed(1, "D-7"), seed(2, "D-11", "2026-11-15T15:00:00.000Z")],
		pings: { "D-11": pathPts("2026-11-14T15:00:00Z", 12) }, now: Date.parse("2026-11-20T17:00:00Z"), ...extra,
	});
	// A made-up fill: the tank rises 4 points a minute from 30% to 58%.
	const fill = (w, vid, startIso) => {
		const ins = w.db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, odometer, fuel_pct, location_date_ms, dropped_reason) VALUES (?, ?, ?, 0, 100000, ?, ?, '')");
		const a = Date.parse(startIso);
		for (let i = 0; i < 20; i++) ins.run(vid, W.DALLAS.lat, W.DALLAS.lng, i < 2 ? 30 : Math.min(58, 30 + (i - 1) * 4), a + i * 60000);
	};

	await test("N6 / L5: IFTA's main route and state detail serve a truck unlinked now, for a window before the unlink", async ({ eq }) => {
		const w = unlinkedWorld();
		const want = Math.round(miles(pathPts("2026-11-14T15:00:00Z", 12)));
		eq("GET /api/compliance/ifta lists T-202 with D-11's miles", truckMiles(await ifta(w, "2026-11-10T00:00:00Z", "2026-11-16T00:00:00Z"), "T-202"), want);
		const r = await W.route(w, "GET /api/compliance/ifta/state-detail", { query: { truck_id: "2", state: "TX", start: "2026-11-10T00:00:00Z", end: "2026-11-16T00:00:00Z" } });
		eq("state detail answers 200 with those miles", [r.status, r.body && Math.round(r.body.totalMiles)], [200, want]);
	});

	await test("N6: fuel detection scans a device unlinked now over a window before the unlink, on the truck it was on", async ({ eq }) => {
		const w = unlinkedWorld();
		fill(w, "D-11", "2026-11-14T18:00:00Z");
		const found = w.api.detectAndPersistFuelEvents({ persist: false }).detected.map((e) => [e.routemate_vehicle_id, e.unit]);
		eq("one fill, D-11's, on T-202", found, [["D-11", "T-202"]]);
	});

	// D-11 was on T-303 until Oct 25, then on T-202 (still linked): before FROM it reads T-202, the link at FROM.
	const preFromWorld = () => world({
		env: ON({ FUEL_EVENTS_SCAN_DAYS: "40" }), recorded: FROM, routes: IFTA_ROUTES, expose: ["detectAndPersistFuelEvents"],
		trucks: [{ unit: "T-202", driver: SAM, vid: "D-11" }, { unit: "T-303", driver: LEE, vid: "" }],
		history: [seed(2, "D-11", "2026-10-25T15:00:00.000Z"), linkRow(1, "D-11", "2026-10-25T15:01:00.000Z")],
		pings: { "D-11": pathPts("2026-10-20T15:00:00Z", 12) }, now: Date.parse("2026-11-20T17:00:00Z"),
	});
	await test("pin (mutant: IFTA on the plain resolver): before FROM, IFTA reads the link at FROM, as today", async ({ eq }) => {
		const body = await ifta(preFromWorld(), "2026-10-19T00:00:00Z", "2026-10-21T00:00:00Z");
		eq("T-202 has D-11's Oct 20 miles and T-303 none", [truckMiles(body, "T-202"), truckMiles(body, "T-303")], [Math.round(miles(pathPts("2026-10-20T15:00:00Z", 12))), null]);
	});
	await test("pin (mutant: fuel on the plain resolver): before FROM, a fill's truck is the link at FROM, as today", async ({ eq }) => {
		const w = preFromWorld();
		fill(w, "D-11", "2026-10-20T18:00:00Z");
		eq("the fill is T-202's", w.api.detectAndPersistFuelEvents({ persist: false }).detected.map((e) => [e.routemate_vehicle_id, e.unit]), [["D-11", "T-202"]]);
	});

	runner.finish();
})();
