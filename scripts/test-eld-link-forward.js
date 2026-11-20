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
 *      western truck's business-clock day), each failing on the first build of the rule (636335cc); and decision 55's
 *      bound (only a gap of at most 30 minutes between two device runs gives its days up: the link and unlink cases,
 *      the bound's edges, the history's ends) and the recheck's L2 (a reporting device's fixes after an unlink, under
 *      the window rule and the trip rule)
 *   §2 pins (they pass on such a build too; each names the mutant it catches): M1, N2 (a), N2 (b) trip rule, N3,
 *      N8, no FROM, switch off, N1 at the stop
 *   §3 the link routes under the rule: L3, the narrowed stop and its passing twin, the link line; review 2's H1 (a rename
 *      after an unlink refused while the truck has device history, in check (5)'s words) and its switch-off pin; the
 *      recheck's L1 (a delete after an unlink refused the same way) and its switch-off pin; and, with no month locked,
 *      the open-month ELD hold counting the history (recheck 2's L2) and its switch-off pin
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
	// T-101 is parked all of Nov 18 inside its load's window: 15:00Z D-9 unlinked, `linkAt` (15:02Z) D-7 linked (D-9 again
	// with `sameDevice`), and the devices report it parked. D-9 drove Nov 16-17; the device linked drives Nov 19-20.
	const gapWorld = ({ trip = false, linkAt = "2026-11-18T15:02:00.000Z", sameDevice = false } = {}) => world({
		env: { ...ON(), ...(trip ? TRIP : {}) }, recorded: FROM,
		trucks: [{ unit: "T-101", driver: PAT, vid: sameDevice ? "D-9" : "D-7" }],
		history: [seed(1, "D-9", "2026-11-18T15:00:00.000Z"), linkRow(1, sameDevice ? "D-9" : "D-7", linkAt)],
		rows: [W.loadRow({ id: "L-G", driver: PAT, pickup: "2026-11-16", dropoff: "2026-11-20", assigned: "2026-11-16", done: "2026-11-20", truck: "T-101" })],
		pings: sameDevice ? {
			"D-9": [...driveDay("2026-11-16", { odo: 100000 }), ...driveDay("2026-11-17", { odo: 100200 }), ...track("2026-11-18T13:00:00Z", "2026-11-18T14:45:00Z", { odo: 100400 }),
				...track("2026-11-18T16:00:00Z", "2026-11-18T22:00:00Z", { odo: 100400 }), ...driveDay("2026-11-19", { odo: 100400 }), ...driveDay("2026-11-20", { odo: 100600 })],
		} : {
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

	// ---- Decision 55 (recheck 1): only a three-call swap's gap, at most 30 minutes between two device runs, gives its days
	// up; any other stretch with no device keeps them, as a truck with no feed. T-101 is on a Nov 16-20 load (L-K).
	const d55World = ({ trip = false, history, pings, vid = "", expose = [] }) => world({
		env: { ...ON(), ...(trip ? TRIP : {}) }, recorded: FROM, expose,
		trucks: [{ unit: "T-101", driver: PAT, vid }],
		history,
		rows: [W.loadRow({ id: "L-K", driver: PAT, pickup: "2026-11-16", dropoff: "2026-11-20", assigned: "2026-11-16", done: "2026-11-20", truck: "T-101" })],
		pings,
		status: trip ? [
			["L-K", "At Shipper", "manual", utc("2026-11-16T15:00:00Z")], ["L-K", "Loading", "manual", utc("2026-11-16T15:30:00Z")],
			["L-K", "In Transit", "manual", utc("2026-11-16T17:00:00Z")], ["L-K", "At Receiver", "manual", utc("2026-11-20T16:00:00Z")],
			["L-K", "Delivered", "manual", utc("2026-11-20T19:00:00Z")],
		] : [],
		now: Date.parse("2026-11-23T17:00:00Z"),
	});
	const LOAD_DAYS = days("2026-11-16", "2026-11-20");
	// The recheck's link case: no device since Nov 10, driving Nov 18 with none; D-7, linked at 22:00 CT, shows T-101 parked
	// to midnight and driving Nov 19-20.
	const linkCase = (opts = {}) => d55World({
		vid: "D-7",
		history: [seed(1, "D-9", "2026-11-10T15:00:00.000Z"), linkRow(1, "D-7", "2026-11-19T04:00:00.000Z")],
		pings: { "D-7": [...track("2026-11-19T04:00:00Z", "2026-11-19T06:00:00Z", { odo: 500000 }), ...driveDay("2026-11-19", { odo: 500000 }), ...driveDay("2026-11-20", { odo: 500200 })] },
		...opts,
	});
	const D9_BEFORE = [...driveDay("2026-11-16", { odo: 100000 }), ...driveDay("2026-11-17", { odo: 100200 })];

	await test("decision 55, the recheck's link case: a link at 22:00 CT ends eight days with no device, which keep the link day, so Nov 18 pays on the three paths", async ({ eq }) => {
		samePaths(eq, await threePaths(linkCase(), PAT, "2026-11-20", WEEK_47), LOAD_DAYS);
	});

	await test("decision 55, the link case under TRIP_WORK_DAYS: Nov 18 pays as a no-ELD day", async ({ eq }) => {
		const w = linkCase({ trip: true, expose: ["tripDayResolver", "eldPayLink", "eldPayScope"] });
		samePaths(eq, await threePaths(w, PAT, "2026-11-20", WEEK_47), LOAD_DAYS);
		const t = w.api.tripDayResolver().trip("L-K", { truck: w.api.eldPayScope(w.api.eldPayLink()).truckFor("T-101"), window: { start: "2026-11-16", end: "2026-11-20", pickup: "2026-11-16", assigned: "2026-11-16" } });
		eq("Nov 18's reason", t.reasons && t.reasons["2026-11-18"], "noEld");
	});

	await test("decision 55, the unlink case: D-9 unlinked at 00:30 CT, then a day with no device: Nov 18 pays as a truck with no feed", async ({ eq }) => {
		const w = d55World({
			history: [seed(1, "D-9", "2026-11-18T06:30:00.000Z")],
			pings: { "D-9": [...D9_BEFORE, ...track("2026-11-18T06:00:00Z", "2026-11-18T06:30:00Z", { odo: 100400 })] },
		});
		samePaths(eq, await threePaths(w, PAT, "2026-11-20", WEEK_47), LOAD_DAYS);
	});

	await test("decision 55, the bound: a gap of exactly 30 minutes between two devices gives the parked swap day up, and so does the same device relinked", async ({ eq }) => {
		samePaths(eq, await threePaths(gapWorld({ linkAt: "2026-11-18T15:30:00.000Z" }), PAT, "2026-11-20", WEEK_47), GAP_PAID, "30 minutes: ");
		samePaths(eq, await threePaths(gapWorld({ linkAt: "2026-11-18T15:05:00.000Z", sameDevice: true }), PAT, "2026-11-20", WEEK_47), GAP_PAID, "D-9 relinked: ");
	});

	await test("decision 55, the bound: a gap of 31 minutes keeps its day, so the swap day pays as a truck with no feed", async ({ eq }) => {
		samePaths(eq, await threePaths(gapWorld({ linkAt: "2026-11-18T15:31:00.000Z" }), PAT, "2026-11-20", WEEK_47), LOAD_DAYS);
	});

	await test("decision 55, the edges: a stretch with no device at the start of a truck's history (first linked 15:10Z) or at its end (unlinked 15:00Z, no relink) keeps its day: Nov 18 pays", async ({ eq }) => {
		const start = d55World({
			vid: "D-7", history: [linkRow(1, "D-7", "2026-11-18T15:10:00.000Z")],
			pings: { "D-7": [...track("2026-11-18T16:00:00Z", "2026-11-18T22:00:00Z", { odo: 500000 }), ...driveDay("2026-11-19", { odo: 500000 }), ...driveDay("2026-11-20", { odo: 500200 })] },
		});
		samePaths(eq, await threePaths(start, PAT, "2026-11-20", WEEK_47), LOAD_DAYS, "start: ");
		const end = d55World({
			history: [seed(1, "D-9", "2026-11-18T15:00:00.000Z")],
			pings: { "D-9": [...D9_BEFORE, ...track("2026-11-18T13:00:00Z", "2026-11-18T14:45:00Z", { odo: 100400 })] },
		});
		samePaths(eq, await threePaths(end, PAT, "2026-11-20", WEEK_47), LOAD_DAYS, "end: ");
	});

	// The swap-gap test at the lib, on run lists the resolver itself never makes (a finite stretch at a list's edge): the
	// decision's "a device run directly before and after" is pinned here, as no route-level case can reach it.
	await test("decision 55, the lib's swap-gap test: no device, at most 30 minutes, and a device run directly before and after it (one side only never yields)", async ({ eq }) => {
		const lib = require("../lib/eld-link-forward");
		const MIN = 60000;
		const run = (a, b, vid) => ({ fromMs: a, toMs: b, vid, row: null });
		const gapOf = (runs, i) => lib.createPayLink({ db: null, resolver: { truckRuns: () => runs }, fromMs: 0 }).truck(1).swapGap(runs[i]);
		eq("between two devices, 30 minutes", gapOf([run(-Infinity, 0, "D-9"), run(0, 30 * MIN, ""), run(30 * MIN, Infinity, "D-7")], 1), true);
		eq("between two devices, 31 minutes", gapOf([run(-Infinity, 0, "D-9"), run(0, 31 * MIN, ""), run(31 * MIN, Infinity, "D-7")], 1), false);
		eq("a device after it only", gapOf([run(0, 10 * MIN, ""), run(10 * MIN, Infinity, "D-7")], 0), false);
		eq("a device before it only", gapOf([run(-Infinity, 0, "D-9"), run(0, 10 * MIN, "")], 1), false);
		eq("a neighbour with no device before it", gapOf([run(-Infinity, 0, ""), run(0, 10 * MIN, ""), run(10 * MIN, Infinity, "D-7")], 1), false);
	});

	// D-9 unlinked from T-101 at 15:00Z Nov 18 with no relink, and reporting it parked after: Nov 18 afternoon, Nov 19-20.
	const reportingWorld = (trip = false) => d55World({
		trip,
		history: [seed(1, "D-9", "2026-11-18T15:00:00.000Z")],
		pings: { "D-9": [...D9_BEFORE, ...track("2026-11-18T13:00:00Z", "2026-11-18T14:45:00Z", { odo: 100400 }),
			...track("2026-11-18T16:00:00Z", "2026-11-18T22:00:00Z", { odo: 100400 }), ...parkDay("2026-11-19", { odo: 100400 }), ...parkDay("2026-11-20", { odo: 100400 })] },
	});

	await test("L2 (recheck): a load across an unlink with no relink while the device keeps reporting: its fixes after the unlink never count for the truck (Nov 18-20 pay as no feed)", async ({ eq }) => {
		samePaths(eq, await threePaths(reportingWorld(), PAT, "2026-11-20", WEEK_47), LOAD_DAYS);
	});

	// Only the trip rule can see those fixes: a no-device run pays with no ELD under the window rule, whatever its fixes.
	await test("M1 (recheck 2): the same load under TRIP_WORK_DAYS: D-9's fixes after the unlink never count for T-101, so Nov 18-19 stay no-ELD days and pay", async ({ eq }) => {
		samePaths(eq, await threePaths(reportingWorld(true), PAT, "2026-11-20", WEEK_47), LOAD_DAYS);
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
		eq("in check (5)'s words", r.body && r.body.error,
			"Cannot apply this change to T-101: renaming T-101 → T-101A breaks the ELD link every past load row resolves through, which re-derives driver pay in 1 finalized month. October 2026 is finalized. Nothing was changed. Closed months stay as recorded, so undo the field named above (unit_number) and save the rest of the edit, which is not blocked.");
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

	// L1 (recheck): deleting a truck under the rule takes check (5)'s ELD leg, so an unlink then a delete cannot leave
	// October's T-101 rows on no truck. Neither truck has assignment history, so a delete reaches the closed-month guard.
	const DELETE_ROUTES = [...ROUTES, ["delete", "/api/trucks/:id"]];
	const del = (w, id) => W.route(w, "DELETE /api/trucks/:id", { params: { id: String(id) } });
	const deleteWorld = ({ env = ON(), recorded = FROM, vid = "D-7", history = [seed(1, "D-7")], locks = ["2026-10"] } = {}) => {
		const w = world({
			env, recorded, routes: DELETE_ROUTES, locks, vehicles: ["D-7"],
			trucks: [{ unit: "T-101", driver: "", vid }, { unit: "T-303", driver: "", vid: "" }],
			history,
			rows: [W.loadRow({ id: "L-OCT1", driver: PAT, pickup: "2026-10-26", dropoff: "2026-10-28", assigned: "2026-10-26", done: "2026-10-28", truck: "T-101" })],
			now: Date.parse("2026-11-25T16:00:00Z"),
		});
		w.db.prepare("DELETE FROM truck_assignments").run();
		return w;
	};
	const truckGone = (w, id) => !w.db.prepare("SELECT 1 FROM trucks WHERE id = ?").get(id);

	await test("L1 (recheck): under the rule, an unlink and then a delete of the truck is refused in check (5)'s words and audited as a blocked delete; a never-linked truck deletes as before", async ({ eq, ok }) => {
		const w = deleteWorld();
		eq("the unlink passes", (await unlink(w, 1)).status, 200);
		const r = await del(w, 1);
		eq("409 PERIOD_FINALIZED over October", [r.status, r.body && r.body.code, r.body && r.body.periods], [409, "PERIOD_FINALIZED", ["2026-10"]]);
		eq("in check (5)'s words", r.body && r.body.error,
			"Cannot delete T-101: deleting T-101 breaks the ELD link every past load row resolves through, which re-derives driver pay in 1 finalized month. October 2026 is finalized. Leave the truck in place — a closed month's figures are attributed to it, and marking it Inactive would strip those same months instead. To take it out of service, give it a retirement date in an open month. Nothing was changed.");
		ok("audited as a blocked delete of truck 1", w.audits.some((a) => a.action === "delete_truck_blocked" && a.entityId === "1"), JSON.stringify(w.audits.map((a) => [a.action, a.entityId])));
		ok("T-101 is still there", !truckGone(w, 1));
		const t = await del(w, 2);
		eq("T-303, never linked, deletes", [t.status, truckGone(w, 2)], [200, true]);
	});

	await test("delete pin (mutant: the delete leg reading with the rule off): switch off, a linked truck's delete gets today's open-month ELD hold, and an unlinked one with history deletes", async ({ eq }) => {
		const w = deleteWorld({ env: {}, recorded: null });
		const r = await del(w, 1);
		eq("T-101, linked: today's OPEN_MONTH_TRUCK_FIGURES", [r.status, r.body && r.body.code], [409, "OPEN_MONTH_TRUCK_FIGURES"]);
		const v = deleteWorld({ env: {}, recorded: null, vid: "", history: [seed(1, "D-7", "2026-11-16T15:00:00.000Z")] });
		const s = await del(v, 1);
		eq("T-101, unlinked with history: deletes", [s.status, truckGone(v, 1)], [200, true]);
	});

	// L2 (recheck 2): with no month locked the delete guard's leg (6) never runs, so the open-month ELD hold is what keeps a
	// truck's history; under the rule it counts that history, and its words leave out an unlink, which no longer clears it.
	const UNLINKED = { vid: "", history: [seed(1, "D-7", "2026-11-16T15:00:00.000Z")] };
	await test("L2 (recheck 2): under the rule with no month locked, a truck unlinked now with device history is held by the open-month ELD hold, in its words with no unlink step, audited as today; a never-linked truck deletes", async ({ eq, ok }) => {
		const w = deleteWorld({ locks: [], ...UNLINKED });
		const r = await del(w, 1);
		eq("409 OPEN_MONTH_TRUCK_FIGURES, the ELD link held", [r.status, r.body && r.body.code, r.body && r.body.counts && r.body.counts.eld_link], [409, "OPEN_MONTH_TRUCK_FIGURES", 1]);
		eq("in the hold's words, with no unlink step", r.body && r.body.error,
			"Cannot delete T-101: its ELD device sets the paid days of the loads that name it. Deleting the truck would change an open month's figures, so it stays in place. To take it out of service, give it a retirement date in an open month. Nothing was changed.");
		ok("audited as a blocked delete under OPEN_MONTH_TRUCK_FIGURES, holding the ELD link",
			w.audits.some((a) => a.action === "delete_truck_blocked" && a.entityId === "1" && a.details.includes("OPEN_MONTH_TRUCK_FIGURES") && a.details.includes("holds: ELD link")),
			JSON.stringify(w.audits));
		ok("T-101 is still there", !truckGone(w, 1));
		const t = await del(w, 2);
		eq("T-303, never linked, deletes", [t.status, truckGone(w, 2)], [200, true]);
	});

	await test("open-month hold pin (the rule off reads nothing new): switch off, no month locked, an unlinked truck with history deletes and a linked one gets today's words, unlink step included", async ({ eq }) => {
		const v = deleteWorld({ env: {}, recorded: null, locks: [], ...UNLINKED });
		const s = await del(v, 1);
		eq("T-101, unlinked with history: deletes", [s.status, truckGone(v, 1)], [200, true]);
		const w = deleteWorld({ env: {}, recorded: null, locks: [] });
		const r = await del(w, 1);
		eq("T-101, linked: today's refusal", [r.status, r.body && r.body.code, r.body && r.body.error], [409, "OPEN_MONTH_TRUCK_FIGURES",
			"Cannot delete T-101: its ELD device sets the paid days of the loads that name it. Deleting the truck would change an open month's figures, so it stays in place. To take it out of service, give it a retirement date in an open month. If it was added by mistake, do these first, then delete it: unlink its ELD device. Nothing was changed."]);
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

	// ---- Move device (ELD_MOVE_DEVICE_ENABLED): POST /api/trucks/:truckId/move-eld, on made-up trucks and devices --------
	console.log("\n§5 Move device: each case FAILS ON THE OLD CODE (the route and its words do not exist there) unless it says pin");
	const HAS_MOVE = W.SRC.split("\n").some((l) => l.startsWith('app.post("/api/trucks/:truckId/move-eld",'));
	const needMove = () => { if (!HAS_MOVE) throw new Error("POST /api/trucks/:truckId/move-eld does not exist on this build"); };
	const MOVE_ROUTES = [["post", "/api/trucks/:truckId/move-eld"], ["get", "/api/routemate/vehicles/unlinked"], ...ROUTES];
	const MOVE_ON = (extra = {}) => ON({ ELD_MOVE_DEVICE_ENABLED: "true", ...extra });
	const MOVE_NOW = "2026-11-20T14:41:00Z"; // Fri Nov 20, 09:41 Eastern
	const MOVE_AT = "2026-11-20T14:41:00.000Z";
	// A fix five minutes before `at` on each device, so none reads as silent.
	const live = (at, vids) => Object.fromEntries(vids.map((v) => [v, [{ ms: Date.parse(at) - 300000, lat: W.DALLAS.lat, lng: W.DALLAS.lng, odo: 100000, speed: 0 }]]));
	// October finalized. T-100 (1) holds D-7, T-200 (2) none (or `t200`), T-150 (3) D-9, T-300 (4) none; D-4 (and D-11)
	// free. T-100's October load ended Oct 28.
	const OCT_ENDED = W.loadRow({ id: "L-OCT1", driver: PAT, pickup: "2026-10-26", dropoff: "2026-10-28", assigned: "2026-10-26", done: "2026-10-28", truck: "T-100" });
	const OCT_RUNS_TO = (day) => W.loadRow({ id: "L-1001", driver: PAT, pickup: "2026-10-30", dropoff: day, assigned: "2026-10-30", done: day, truck: "T-100" });
	const OCT_NO_END = W.loadRow({ id: "L-OCT2", driver: PAT, pickup: "2026-10-30", dropoff: "", assigned: "2026-10-30", done: "", status: "In Transit", truck: "T-100" });
	// T-200's October load, delivered (tapped) Fri Nov 20 04:10 Eastern after a Nov 19 drop-off.
	const TAPPED = W.loadRow({ id: "L-2002", driver: SAM, pickup: "2026-10-29", dropoff: "2026-11-19", assigned: "2026-10-29", done: "2026-11-19", truck: "T-200" });
	const TAP = [["L-2002", "Delivered", "manual", "2026-11-20 09:10:00"]];
	const badCell = (truck, driver) => ({ ...W.loadRow({ id: "L-1001", driver, pickup: "2026-10-26", dropoff: "2026-10-28", assigned: "2026-10-26", done: "2026-10-28", truck }), "Pickup Appointment": "14:00" });
	function moveWorld({ env = MOVE_ON(), now = MOVE_NOW, rows = [OCT_ENDED], t200 = "", status = [], recorded = FROM, pings = null, locks = ["2026-10"] } = {}) {
		needMove();
		return world({
			env, recorded, routes: MOVE_ROUTES, locks, status, now: Date.parse(now), vehicles: ["D-4", "D-7", "D-9", "D-11"],
			trucks: [{ unit: "T-100", driver: PAT, vid: "D-7" }, { unit: "T-200", driver: SAM, vid: t200 }, { unit: "T-150", driver: LEE, vid: "D-9" }, { unit: "T-300", driver: "", vid: "" }],
			history: [seed(1, "D-7"), seed(3, "D-9"), ...(t200 ? [seed(2, t200)] : [])],
			rows,
			pings: pings || live(now, ["D-4", "D-7", "D-9", "D-11"]),
		});
	}
	// The truck the dialog shows the device on: its holder at the press, unless the case says otherwise.
	const holderOf = (w, vid) => (w.db.prepare("SELECT id FROM trucks WHERE routemate_vehicle_id = ? ORDER BY id").get(vid) || {}).id;
	const move = (w, truckId, vid, extra = {}) => W.route(w, "POST /api/trucks/:truckId/move-eld", { params: { truckId: String(truckId) }, body: { routemateVehicleId: vid, fromTruckId: holderOf(w, vid), ...extra } });
	const linkOf = (w, id) => w.db.prepare("SELECT routemate_vehicle_id AS v FROM trucks WHERE id = ?").get(id).v || "";
	const historyOf = (w) => w.db.prepare("SELECT truck_id AS t, routemate_vehicle_id AS v, assigned_from AS f, assigned_until AS u FROM eld_device_assignments ORDER BY id").all()
		.map((r) => [r.t, r.v, r.f === HISTORY_START ? "start" : r.f, r.u || "open"]);
	const auditsOf = (w, action) => w.audits.filter((a) => a.action === action);
	// Every truck's link, the device history and the moves audited: what "nothing written" compares.
	const snapshot = (w) => JSON.stringify([w.db.prepare("SELECT id, routemate_vehicle_id AS v FROM trucks ORDER BY id").all(), historyOf(w), auditsOf(w, "routemate_move").length]);
	const DATA_FIX = "This needs a data fix. Send a screenshot of this message to the LogisX team. Nothing was changed.";

	await test("the move: D-7 leaves T-100 and lands on T-200 at one instant, in one history change and one audit row, and the line says from when (FAILS ON THE OLD CODE)", async ({ eq }) => {
		const w = moveWorld();
		const r = await move(w, 2, "D-7");
		eq("200, from T-100", [r.status, r.body && r.body.fromTruckId], [200, 1]);
		eq("the line", r.body && r.body.message, "Moved. From Fri Nov 20 09:41 (Eastern), T-200's ELD readings come from D-7, and T-100 has no ELD device. Earlier days stay as they were.");
		eq("both trucks' links", [linkOf(w, 1), linkOf(w, 2)], ["", "D-7"]);
		eq("the history: T-100's D-7 row closes at the instant T-200's opens", historyOf(w), [[1, "D-7", "start", MOVE_AT], [3, "D-9", "start", "open"], [2, "D-7", MOVE_AT, "open"]]);
		eq("the line's instant is the history's", r.body && r.body.effectiveAt, MOVE_AT);
		eq("one audit row", auditsOf(w, "routemate_move").map((a) => [a.entityId, a.details]), [["2", `Moved Routemate D-7 from truck T-100 to truck T-200 at ${MOVE_AT} (T-200 had none)`]]);
	});

	await test("the target holds a device of its own (D-11): its row and T-100's close at the instant, T-200's D-7 row opens at it, one open row per truck and per device, and D-11 is free (FAILS ON THE OLD CODE)", async ({ eq, ok }) => {
		const w = moveWorld({ t200: "D-11" });
		eq("200", (await move(w, 2, "D-7")).status, 200);
		eq("the history", historyOf(w), [[1, "D-7", "start", MOVE_AT], [3, "D-9", "start", "open"], [2, "D-11", "start", MOVE_AT], [2, "D-7", MOVE_AT, "open"]]);
		eq("open rows: one per truck and per device", w.db.prepare("SELECT truck_id AS t, routemate_vehicle_id AS v FROM eld_device_assignments WHERE assigned_until = '' ORDER BY truck_id").all().map((x) => [x.t, x.v]), [[2, "D-7"], [3, "D-9"]]);
		eq("D-11 is on no truck", w.db.prepare("SELECT COUNT(*) AS n FROM trucks WHERE routemate_vehicle_id = 'D-11'").get().n, 0);
		ok("the audit row names the device T-200 had", /\(T-200 had D-11\)$/.test((auditsOf(w, "routemate_move")[0] || {}).details || ""), JSON.stringify(w.audits));
	});

	await test("N2: one instant for the history, the line and the audit row, though the clock moves on every read (FAILS ON THE OLD CODE)", async ({ eq, ok }) => {
		const w = moveWorld();
		let tick = Date.parse(MOVE_NOW);
		Object.defineProperty(w.clock, "ms", { configurable: true, get: () => (tick += 7) });
		const r = await move(w, 2, "D-7");
		eq("200", r.status, 200);
		const until = w.db.prepare("SELECT assigned_until AS u FROM eld_device_assignments WHERE truck_id = 1").get().u;
		const from = w.db.prepare("SELECT assigned_from AS f FROM eld_device_assignments WHERE truck_id = 2").get().f;
		eq("T-100's row closes when T-200's opens, at the line's instant", [until, from], [r.body.effectiveAt, r.body.effectiveAt]);
		const audit = (auditsOf(w, "routemate_move")[0] || {}).details || "";
		ok("the audit row carries that instant", audit.includes(` at ${r.body.effectiveAt} `), audit);
	});

	await test("N6: T-100's October load runs through Sat Nov 21, so nothing is written, the words say from when a move off it passes, and at that instant it does (FAILS ON THE OLD CODE)", async ({ eq, ok }) => {
		const w = moveWorld({ rows: [OCT_ENDED, OCT_RUNS_TO("2026-11-21")] });
		const before = snapshot(w);
		const r = await move(w, 2, "D-7");
		eq("409 ELD_MOVE_BLOCKED", [r.status, r.body && r.body.code], [409, "ELD_MOVE_BLOCKED"]);
		eq("the words", r.body && r.body.error, "Cannot move D-7. Load L-1001 on T-100 runs through Sat Nov 21. This device can be moved off T-100 from Sun Nov 22 03:00 (Eastern). Nothing was changed.");
		eq("the lead and one paragraph", [r.body && r.body.lead, r.body && r.body.paragraphs], ["Cannot move D-7.", [r.body && r.body.error]]);
		ok("no month on the screen", !/finaliz|October/i.test((r.body && r.body.error) || ""));
		eq("nothing written", snapshot(w), before);
		const blocked = auditsOf(w, "routemate_move_blocked");
		ok("one blocked-move audit row, with October and 'nothing was written'", blocked.length === 1 && blocked[0].details.includes("[PERIOD_FINALIZED] periods=2026-10") && /nothing was written$/.test(blocked[0].details), JSON.stringify(blocked));
		w.clock.ms = Date.parse("2026-11-22T07:59:00Z");
		eq("a minute before Sun Nov 22 03:00 Eastern it still refuses", (await move(w, 2, "D-7", { confirmSilent: true })).body.code, "ELD_MOVE_BLOCKED");
		w.clock.ms = Date.parse("2026-11-22T08:00:00Z");
		eq("at it, the move passes", (await move(w, 2, "D-7", { confirmSilent: true })).status, 200);
	});

	await test("N6: with the trip rule on, T-200's October load was tapped Delivered Fri Nov 20 04:10 Eastern: the words name the tap and the instant 36 hours on, and from then a move onto it passes (FAILS ON THE OLD CODE)", async ({ eq }) => {
		const w = moveWorld({ env: MOVE_ON(TRIP), rows: [OCT_ENDED, TAPPED], status: TAP });
		const r = await move(w, 2, "D-7");
		eq("the words", [r.status, r.body && r.body.error], [409,
			"Cannot move D-7. Load L-2002 on T-200 was delivered Fri Nov 20 04:10 (Eastern). This device can be moved onto T-200 from Sat Nov 21 16:10 (Eastern). Nothing was changed."]);
		w.clock.ms = Date.parse("2026-11-21T21:09:59Z");
		eq("a second before it, still refused", (await move(w, 2, "D-7", { confirmSilent: true })).body.code, "ELD_MOVE_BLOCKED");
		w.clock.ms = Date.parse("2026-11-21T21:10:01Z");
		eq("after it, the move passes", (await move(w, 2, "D-7", { confirmSilent: true })).status, 200);
	});

	await test("N7: both trucks hold it: one sentence each, one time to try again (the later of the two), and 'Nothing was changed.' once; a data fix on either leaves the time out (FAILS ON THE OLD CODE)", async ({ eq }) => {
		const w = moveWorld({ env: MOVE_ON(TRIP), rows: [OCT_ENDED, OCT_RUNS_TO("2026-11-21"), TAPPED], status: TAP });
		const r = await move(w, 2, "D-7");
		eq("the words", r.body && r.body.error,
			"Cannot move D-7. Load L-1001 on T-100 runs through Sat Nov 21. Load L-2002 on T-200 was delivered Fri Nov 20 04:10 (Eastern). This device can be moved off T-100 onto T-200 from Sun Nov 22 03:00 (Eastern). Nothing was changed.");
		eq("'Nothing was changed.' once", ((r.body && r.body.error) || "").match(/Nothing was changed\./g).length, 1);
		const v = moveWorld({ env: MOVE_ON(TRIP), rows: [OCT_ENDED, OCT_NO_END, TAPPED], status: TAP });
		eq("with a data fix", (await move(v, 2, "D-7")).body.paragraphs, [
			"Cannot move D-7. Load L-OCT2 on T-100 has no end date. Load L-2002 on T-200 was delivered Fri Nov 20 04:10 (Eastern).", DATA_FIX]);
	});

	await test("N1, a date cell the server can't read: named as sheetRowUpdateBlocker names one, then the data-fix line; nothing written; the audit row holds every finalized month (FAILS ON THE OLD CODE)", async ({ eq, ok }) => {
		// The reviewer's case: D-9 off T-150, whose October load has "14:00" under Pickup Appointment, onto T-300.
		const w = moveWorld({ rows: [OCT_ENDED, badCell("T-150", LEE)], locks: ["2026-09", "2026-10"] });
		const before = snapshot(w);
		const r = await move(w, 4, "D-9");
		eq("409, the words in two paragraphs", [r.status, r.body && r.body.code, r.body && r.body.paragraphs], [409, "ELD_MOVE_BLOCKED", [
			"Cannot move D-9. Load L-1001 on T-150 has \"14:00\" under Pickup Appointment, where the app needs a date. Until that is fixed, this device can't be moved off T-150.", DATA_FIX]]);
		eq("nothing written", snapshot(w), before);
		const a = auditsOf(w, "routemate_move_blocked")[0] || { details: "" };
		ok("the audit row holds every finalized month and names the cell", a.details.includes("periods=2026-09,2026-10") && a.details.includes("Pickup Appointment = \"14:00\"") && a.details.includes("every finalized month held"), a.details);
		const v = moveWorld({ rows: [OCT_ENDED, badCell("T-200", SAM)] });
		eq("the same cell on the truck the device goes to", (await move(v, 2, "D-7")).body.paragraphs[0],
			"Cannot move D-7. Load L-1001 on T-200 has \"14:00\" under Pickup Appointment, where the app needs a date. Until that is fixed, this device can't be moved onto T-200.");
	});

	await test("N1, the other side of the split: a Job Tracking read that fails, or a Delivered-tap read that fails, keeps the try-again line, with no lead and nothing written (FAILS ON THE OLD CODE)", async ({ eq, ok }) => {
		const w = moveWorld();
		w.rows = null; // the sheet stub's read throws
		const before = snapshot(w);
		const r = await move(w, 2, "D-7");
		eq("the try-again line", [r.status, r.body && r.body.error, r.body && r.body.lead], [409, "Job Tracking couldn't be read just now. Try again in a minute. Nothing was changed.", ""]);
		eq("nothing written", snapshot(w), before);
		ok("audited, October held", (auditsOf(w, "routemate_move_blocked")[0] || { details: "" }).details.includes("periods=2026-10"), JSON.stringify(w.audits));
		// T-100 has a load running through Sat Nov 21, so only the stop's own `unreadable` mark (not an empty row list) can
		// give the try-again line here (review-1 M3).
		const t = moveWorld({ env: MOVE_ON(TRIP), rows: [OCT_ENDED, OCT_RUNS_TO("2026-11-21")] });
		t.db.exec("DROP TABLE load_status_history");
		eq("a tap read that fails: the same line", (await move(t, 2, "D-7")).body.error, "Job Tracking couldn't be read just now. Try again in a minute. Nothing was changed.");
	});

	await test("N5: a truck renamed while Job Tracking is read is refused in its own words, and nothing is written (FAILS ON THE OLD CODE)", async ({ eq }) => {
		const w = moveWorld();
		const rows = w.rows;
		let once = true;
		Object.defineProperty(w, "rows", { configurable: true, get: () => {
			if (once) { once = false; w.db.prepare("UPDATE trucks SET unit_number = 'T-100A' WHERE id = 1").run(); }
			return rows;
		} });
		const r = await move(w, 2, "D-7");
		eq("409 ELD_MOVE_CHANGED", [r.status, r.body && r.body.code, r.body && r.body.error], [409, "ELD_MOVE_CHANGED", "T-100 or T-200 changed while this was checked. Nothing was changed. Try again."]);
		eq("nothing written", [linkOf(w, 1), linkOf(w, 2), historyOf(w).length, auditsOf(w, "routemate_move").length], ["D-7", "", 2, 0]);
	});

	// Review-1 M1: the confirm names the truck the dialog showed the device on, so the move takes it off that truck or
	// is refused. D-7 goes from T-100 to T-300 (4) behind the dialog's back.
	const MOVED_TO_T300 = "UPDATE trucks SET routemate_vehicle_id = CASE id WHEN 1 THEN '' WHEN 4 THEN 'D-7' ELSE routemate_vehicle_id END";
	await test("M1 (review-1): D-7 moved to T-300 after the dialog showed it on T-100, before the press: refused in plain words naming the truck it is on now; nothing written, Job Tracking never read (FAILS ON THE OLD CODE)", async ({ eq }) => {
		const w = moveWorld();
		const shownOn = holderOf(w, "D-7");
		w.db.prepare(MOVED_TO_T300).run();
		const rows = w.rows;
		let reads = 0;
		Object.defineProperty(w, "rows", { configurable: true, get: () => { reads++; return rows; } });
		const before = snapshot(w);
		const r = await move(w, 2, "D-7", { fromTruckId: shownOn });
		eq("409 ELD_MOVE_CHANGED", [r.status, r.body && r.body.code, r.body && r.body.error], [409, "ELD_MOVE_CHANGED", "D-7 is on T-300 now, not on T-100. Nothing was changed."]);
		eq("nothing written, and Job Tracking never read", [snapshot(w) === before, reads], [true, 0]);
	});

	await test("M1 (review-1): D-7 moved to T-300 while Job Tracking was read: refused after the await in the same words; T-300 keeps it and nothing is written by the move (FAILS ON THE OLD CODE)", async ({ eq }) => {
		const w = moveWorld();
		const rows = w.rows;
		let once = true;
		Object.defineProperty(w, "rows", { configurable: true, get: () => {
			if (once) { once = false; w.db.prepare(MOVED_TO_T300).run(); }
			return rows;
		} });
		const r = await move(w, 2, "D-7", { fromTruckId: 1 });
		eq("409 ELD_MOVE_CHANGED", [r.status, r.body && r.body.code, r.body && r.body.error], [409, "ELD_MOVE_CHANGED", "D-7 is on T-300 now, not on T-100. Nothing was changed."]);
		eq("nothing written by the move", [linkOf(w, 4), linkOf(w, 2), historyOf(w).length, auditsOf(w, "routemate_move").length], ["D-7", "", 2, 0]);
	});

	await test("N8: with the trip rule on, a row with no Load ID is named by its sheet row and pickup day, then the data-fix line; with the rule off, so is one with no end date (FAILS ON THE OLD CODE)", async ({ eq }) => {
		const noId = W.loadRow({ id: "", driver: PAT, pickup: "2026-10-26", dropoff: "2026-10-28", assigned: "2026-10-26", done: "2026-10-28", truck: "T-100" });
		const w = moveWorld({ env: MOVE_ON(TRIP), rows: [OCT_ENDED, noId] });
		eq("no Load ID", (await move(w, 2, "D-7")).body.paragraphs, [
			"Cannot move D-7. The load in Job Tracking row 3 (pickup Mon Oct 26) on T-100 has no Load ID. Until that is fixed, this device can't be moved off T-100.", DATA_FIX]);
		const v = moveWorld({ rows: [OCT_ENDED, W.loadRow({ id: "", driver: PAT, pickup: "2026-10-30", dropoff: "", assigned: "2026-10-30", done: "", status: "In Transit", truck: "T-100" })] });
		eq("no Load ID and no end date", (await move(v, 2, "D-7")).body.paragraphs[0],
			"Cannot move D-7. The load in Job Tracking row 3 (pickup Fri Oct 30) on T-100 has no end date. Until that is fixed, this device can't be moved off T-100.");
	});

	await test("a device that has stopped reporting is asked about in the link route's words, and moves once confirmed (FAILS ON THE OLD CODE)", async ({ eq, ok }) => {
		const w = moveWorld({ pings: live(MOVE_NOW, ["D-4", "D-9", "D-11"]) }); // D-7 never reported
		const before = snapshot(w);
		const a = await move(w, 2, "D-7");
		eq("409 ELD_DEVICE_SILENT", [a.status, a.body && a.body.code, a.body && a.body.error], [409, "ELD_DEVICE_SILENT",
			"ELD vehicle D-7 has never reported a GPS fix. Linking it leaves T-200 with no live position. Confirm to link it anyway."]);
		eq("nothing written", snapshot(w), before);
		const text = await move(w, 2, "D-7", { confirmSilent: "true" });
		eq("only the boolean true confirms", [text.status, text.body && text.body.code, snapshot(w) === before], [409, "ELD_DEVICE_SILENT", true]);
		const b = await move(w, 2, "D-7", { confirmSilent: true });
		eq("confirmed: it moves", [b.status, linkOf(w, 2)], [200, "D-7"]);
		ok("the audit row records the confirmation", /\(confirmed silent device: has never reported a GPS fix\)$/.test((auditsOf(w, "routemate_move")[0] || {}).details || ""), JSON.stringify(w.audits));
	});

	await test("refused before Job Tracking is read: a device not in the mirror, a free device, the device this truck already holds, and a device two trucks hold (N4), each in its own words, nothing written (FAILS ON THE OLD CODE)", async ({ eq }) => {
		const w = moveWorld();
		const rows = w.rows;
		let reads = 0;
		Object.defineProperty(w, "rows", { configurable: true, get: () => { reads++; return rows; } });
		const unshown = await move(w, 2, "D-7", { fromTruckId: undefined });
		eq("no truck the dialog showed it on (review-1 M1): 400", [unshown.status, unshown.body && unshown.body.error], [400, "fromTruckId required"]);
		const missing = await move(w, 2, "D-404", { fromTruckId: 1 });
		eq("a device not in the mirror: 404, in the link route's words", [missing.status, missing.body && missing.body.error], [404, "Routemate vehicle not found in mirror — run sync-now first"]);
		const free = await move(w, 2, "D-4", { fromTruckId: 1 });
		eq("a free device", [free.status, free.body && free.body.code, free.body && free.body.error], [409, "ELD_MOVE_FREE_DEVICE", "This device is free: use Link Selected."]);
		const same = await move(w, 1, "D-7");
		eq("the device this truck holds", [same.status, same.body && same.body.code, same.body && same.body.error], [409, "ELD_MOVE_SAME_TRUCK", "D-7 is already on T-100. Nothing was changed."]);
		w.db.prepare("UPDATE trucks SET routemate_vehicle_id = 'D-7' WHERE id = 3").run();
		const before = snapshot(w);
		const shared = await move(w, 2, "D-7");
		eq("N4: two trucks hold it", [shared.status, shared.body && shared.body.code, shared.body && shared.body.paragraphs], [409, "ELD_MOVE_SHARED_DEVICE",
			["Cannot move D-7. It is linked to T-100 and T-150 at once.", DATA_FIX]]);
		eq("nothing written, and Job Tracking never read", [snapshot(w) === before, reads, historyOf(w).length], [true, 0, 2]);
	});

	await test("the lock table can't be read: 409 PERIOD_LOCK_UNREADABLE, nothing written, audited as a blocked move (FAILS ON THE OLD CODE)", async ({ eq, ok }) => {
		const w = moveWorld();
		w.db.exec("DROP TABLE period_locks");
		const before = snapshot(w);
		const r = await move(w, 2, "D-7");
		eq("409 PERIOD_LOCK_UNREADABLE", [r.status, r.body && r.body.code], [409, "PERIOD_LOCK_UNREADABLE"]);
		eq("nothing written", snapshot(w), before);
		ok("audited as a blocked move", auditsOf(w, "routemate_move_blocked").some((a) => a.details.includes("[PERIOD_LOCK_UNREADABLE]")), JSON.stringify(w.audits));
	});

	await test("L1 (review-1): the start-up line, in fixed words: none with the switch off; with it on, whether the forward-only rule lets the move work; logged at boot right after the rule's own decision (FAILS ON THE OLD CODE)", async ({ eq, ok }) => {
		const line = (env, recorded = FROM) => world({ env, recorded, expose: ["eldMoveDeviceStartLine"], trucks: [{ unit: "T-100", driver: PAT, vid: "D-7" }], history: [seed(1, "D-7")], now: Date.parse(MOVE_NOW) })
			.api.eldMoveDeviceStartLine();
		eq("the switch off: no line", line(ON()), null);
		eq("on, with the rule in force", line(MOVE_ON()),
			{ level: "log", text: "ELD_MOVE_DEVICE_ENABLED is on: Move device can take an ELD device off one truck and put it on another at one instant." });
		eq("on, with the rule not in force", line(MOVE_ON({ ELD_LINK_FORWARD_ONLY_FROM: "2026-11-25T15:00:00Z" }), null),
			{ level: "warn", text: "ELD_MOVE_DEVICE_ENABLED is on but does nothing: the forward-only link rule is not in force, so every move is refused and the Link dialog offers none." });
		ok("at boot, logged right after the rule's decision", /\neldLinkForwardRule\(\);\nlogEldMoveDeviceStart\(\);\n/.test(W.SRC));
	});

	await test("switched off, the route answers 404 FEATURE_OFF; on, but with the forward-only rule not in force, 409 MOVE_NEEDS_FORWARD_ONLY; nothing written either way (FAILS ON THE OLD CODE)", async ({ eq }) => {
		const off = moveWorld({ env: ON() });
		const a = await move(off, 2, "D-7");
		eq("404 FEATURE_OFF", [a.status, a.body && a.body.code, linkOf(off, 1), linkOf(off, 2)], [404, "FEATURE_OFF", "D-7", ""]);
		const early = moveWorld({ env: MOVE_ON({ ELD_LINK_FORWARD_ONLY_FROM: "2026-11-25T15:00:00Z" }), recorded: null });
		const b = await move(early, 2, "D-7");
		eq("409 MOVE_NEEDS_FORWARD_ONLY", [b.status, b.body && b.body.code, linkOf(early, 1), linkOf(early, 2)], [409, "MOVE_NEEDS_FORWARD_ONLY", "D-7", ""]);
	});

	await test("N9: the dialog's switch rides on /unlinked only with ?truckId, for a Super Admin, with the switch on and the rule in force (FAILS ON THE OLD CODE)", async ({ eq }) => {
		const get = (w, query, role = "Super Admin") => W.call(w.routes["GET /api/routemate/vehicles/unlinked"], { session: { user: { id: 1, role, username: "qa" } }, headers: {}, params: {}, query, body: {} });
		const w = moveWorld();
		eq("with ?truckId", (await get(w, { truckId: "2" })).body.moveDevice, true);
		eq("without it, the body as before", Object.keys((await get(w, {})).body), ["vehicles"]);
		eq("a Dispatcher's body has no switch", (await get(w, { truckId: "2" }, "Dispatcher")).body.moveDevice, undefined);
		const early = moveWorld({ env: MOVE_ON({ ELD_LINK_FORWARD_ONLY_FROM: "2026-11-25T15:00:00Z" }), recorded: null });
		eq("the rule not in force: no switch", (await get(early, { truckId: "2" })).body.moveDevice, undefined);
	});

	await test("pin, the switch off (mutant: the switch leaking into today's routes): /unlinked's body, the link and the unlink answer exactly as before", async ({ eq }) => {
		const w = world({
			env: ON(), recorded: FROM, routes: [["get", "/api/routemate/vehicles/unlinked"], ...ROUTES], locks: ["2026-10"], vehicles: ["D-4", "D-7"],
			trucks: [{ unit: "T-100", driver: PAT, vid: "D-7" }, { unit: "T-200", driver: SAM, vid: "" }],
			history: [seed(1, "D-7")], rows: [OCT_ENDED], pings: live(MOVE_NOW, ["D-4", "D-7"]), now: Date.parse(MOVE_NOW),
		});
		const unlinkedBody = (await W.route(w, "GET /api/routemate/vehicles/unlinked", { query: { truckId: "2" } })).body;
		eq("/unlinked?truckId: the vehicles only", [Object.keys(unlinkedBody), unlinkedBody.vehicles.map((v) => v.routemate_vehicle_id)], [["vehicles"], ["D-4"]]);
		eq("the unlink's line", (await unlink(w, 1)).body.message, "Unlinked. From Fri Nov 20 09:41 (Eastern), T-100 has no ELD device. Before that keeps what it had.");
		eq("the link's line", (await link(w, 2, "D-7")).body.message, "Linked. From Fri Nov 20 09:41 (Eastern), T-200's ELD readings come from D-7. Before that keeps what it had.");
	});

	await test("pay through the route: T-200 reads D-7 from the move's instant with no gap, T-100 pays as a truck with no feed from it, no day before it changes on either truck, and the move pays as the same history written by hand (FAILS ON THE OLD CODE)", async ({ eq }) => {
		needMove();
		const T = "2026-11-18T15:00:00.000Z";
		const payWorld = (history) => world({
			env: MOVE_ON(), recorded: FROM, routes: MOVE_ROUTES, vehicles: ["D-7"],
			trucks: [{ unit: "T-100", driver: PAT, vid: "D-7" }, { unit: "T-200", driver: SAM, vid: "" }],
			history,
			rows: [
				W.loadRow({ id: "L-SRC", driver: PAT, pickup: "2026-11-16", dropoff: "2026-11-20", assigned: "2026-11-16", done: "2026-11-20", truck: "T-100" }),
				W.loadRow({ id: "L-TGT", driver: SAM, pickup: "2026-11-16", dropoff: "2026-11-20", assigned: "2026-11-16", done: "2026-11-20", truck: "T-200" }),
			],
			// D-7 drives Nov 16, parks Nov 17, drives the morning of Nov 18 on T-100; after the move, parked that afternoon
			// and Nov 19, and drives Nov 20.
			pings: { "D-7": [...driveDay("2026-11-16", { odo: 100000 }), ...parkDay("2026-11-17", { odo: 100200 }),
				...track("2026-11-18T13:00:00Z", "2026-11-18T14:45:00Z", { odo: 100200, miles: 40 }), ...track("2026-11-18T16:00:00Z", "2026-11-18T22:00:00Z", { odo: 100240 }),
				...parkDay("2026-11-19", { odo: 100240 }), ...driveDay("2026-11-20", { odo: 100240 })] },
			now: Date.parse(T),
		});
		const still = payWorld([seed(1, "D-7")]);
		const moved = payWorld([seed(1, "D-7")]);
		eq("the move passes at the instant", [(await move(moved, 2, "D-7")).status, historyOf(moved)], [200, [[1, "D-7", "start", T], [2, "D-7", T, "open"]]]);
		const byHand = payWorld([seed(1, "D-7", T), linkRow(2, "D-7", T)]);
		byHand.db.prepare("UPDATE trucks SET routemate_vehicle_id = CASE id WHEN 1 THEN '' ELSE 'D-7' END").run();
		for (const w of [still, moved, byHand]) w.clock.ms = Date.parse("2026-11-23T17:00:00Z");
		const paid = async (w) => ({ pat: await threePaths(w, PAT, "2026-11-20", WEEK_47), sam: await threePaths(w, SAM, "2026-11-20", WEEK_47) });
		const [a, b, c] = [await paid(still), await paid(moved), await paid(byHand)];
		samePaths(eq, b.pat, ["2026-11-16", "2026-11-18", "2026-11-19", "2026-11-20"], "T-100 (Nov 17 parked; no feed from the move): ");
		samePaths(eq, b.sam, ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-20"], "T-200 (no feed before; D-7's parked Nov 19 after): ");
		eq("the move pays as the same history written by hand at its instant", b, c);
		const early = (x) => ["invoice", "investor", "ledger"].map((k) => [x.pat[k].filter((d) => d < "2026-11-18"), x.sam[k].filter((d) => d < "2026-11-18")]);
		eq("no day before the move changed on either truck", early(b), early(a));
	});

	await test("the words on made-up stops (lib/eld-link-forward.js moveRefusal()): past three loads on a truck the rest are counted, a row with no date at all, and a unit renamed during the read (FAILS ON THE OLD CODE)", async ({ eq }) => {
		const lib = require("../lib/eld-link-forward");
		if (typeof lib.moveRefusal !== "function") throw new Error("moveRefusal() does not exist on this build");
		const stop = (rows) => ({ atMs: Date.parse(MOVE_NOW), at: MOVE_AT, day: "2026-11-20", rows, tripTail: false, unreadable: false });
		const row = (loadId, lastDay) => ({ months: ["2026-10"], lastDay, loadId });
		const four = lib.moveRefusal({ device: "D-7", sides: [{ dir: "off", unit: "T-100", stop: stop([row("L-1", "2026-11-21"), row("L-2", "2026-11-22"), row("L-3", "2026-11-21"), row("L-4", "2026-11-23")]), locked: ["2026-10"], why: null, cell: null }] });
		eq("three named, the fourth counted, the latest time", four.text,
			"Cannot move D-7. Load L-1 on T-100 runs through Sat Nov 21. Load L-2 on T-100 runs through Sun Nov 22. Load L-3 on T-100 runs through Sat Nov 21. 1 more load on T-100 holds it as well. This device can be moved off T-100 from Tue Nov 24 03:00 (Eastern). Nothing was changed.");
		const noDate = lib.moveRefusal({ device: "D-7", sides: [{ dir: "onto", unit: "T-200", stop: stop(null), locked: ["2026-10"], why: "row", cell: { loadId: "L-9", sheetRow: 5, pickupDay: "", header: "", value: "" } }] });
		eq("a row with no date at all", noDate.paragraphs, ["Cannot move D-7. Load L-9 on T-200 has no date in any of its date columns. Until that is fixed, this device can't be moved onto T-200.", DATA_FIX]);
		const renamed = lib.moveRefusal({ device: "D-7", sides: [{ dir: "off", unit: "T-100", stop: stop(null), locked: ["2026-10"], why: "read", cell: null }] });
		eq("a unit renamed during the read: the try-again line", [renamed.text, renamed.lead], ["Job Tracking couldn't be read just now. Try again in a minute. Nothing was changed.", ""]);
		const none = lib.moveRefusal({ device: "D-7", sides: [{ dir: "off", unit: "T-100", stop: stop([]), locked: ["2026-10"], why: null, cell: null }] });
		eq("a side with no blocking row still refuses, with the try-again line", [none.text, none.lead], ["Job Tracking couldn't be read just now. Try again in a minute. Nothing was changed.", ""]);
		eq("reachingRows(): a row only in an open month never holds a move, however late it runs",
			lib.reachingRows(stop([row("L-NOV", ""), { months: ["2026-10", "2026-11"], lastDay: "2026-11-21", loadId: "L-OCT" }].map((r, i) => (i === 0 ? { ...r, months: ["2026-11"] } : r))), ["2026-10"]).map((x) => x.row.loadId), ["L-OCT"]);
		// A tap at 04:10:30 passes 36 hours on, at 16:10:30, so the first whole minute the words can name is 16:11.
		const tapped = { ...stop([{ months: ["2026-10"], lastDay: "2026-11-19", loadId: "L-2", tapMs: Date.parse("2026-11-20T09:10:30Z"), noLoadId: false }]), tripTail: true };
		eq("a tap with seconds: the time named is the first whole minute after it passes",
			lib.moveRefusal({ device: "D-7", sides: [{ dir: "onto", unit: "T-200", stop: tapped, locked: ["2026-10"], why: null, cell: null }] }).text,
			"Cannot move D-7. Load L-2 on T-200 was delivered Fri Nov 20 04:10 (Eastern). This device can be moved onto T-200 from Sat Nov 21 16:11 (Eastern). Nothing was changed.");
	});

	runner.finish();
})();
