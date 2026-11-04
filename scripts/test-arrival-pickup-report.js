#!/usr/bin/env node
/**
 * The arrival pickup date's read-only "what would change" report,
 * scripts/arrival-pickup-report.js (--db --values-json --env-file --from --ids
 * --json), in the shape of scripts/test-blank-pickup-dry-run.js: a made-up
 * database and a saved values.get, the script run in a child process.
 *
 * Fixture, made up (FROM 2026-10-05; September closed; Central shippers on CDT;
 * W41 is Sat Oct 3 - Fri Oct 9, W42 Oct 10-16):
 *   Amy Birch  $300/day, investor 5 (split 50%), truck T1, no ELD
 *     L-3101  sched 10/5-10/7, geofence 10/6, delivered 10/7: -10/5
 *     L-3103  sched 10/12-10/13, geofence 23:20 CDT 10/13 (00:20 Eastern 10/14),
 *             delivered 10/15: -10/12 +10/14 +10/15, 2 days past the drop-off
 *     L-3104  a Super Admin's At Shipper (staff_only)
 *     L-3107  a geofence arrival while L-3101 is In Transit (hauling_other_load)
 *     L-3109  Assigned 10/2, before FROM; L-3110 no Assigned Date; L-3114 still In
 *             Transit; L-3001 closed September
 *     her W41 invoice (10/5-10/8, $1,200) is Approved
 *   Bo Wyn     $260/day, company truck T2 (owner 0), no ELD
 *     L-3102  sched 10/9, his own tap inside on 10/7, delivered 00:10 CDT 10/10
 *             (23:10 Mountain 10/9 at the receiver): +10/7 +10/8 +10/10, 2 days early
 *     L-3105  a far tap (Delivered 10 minutes later); L-3106 a batch tap; L-3108
 *             completed in a row editor (no Delivered row); L-3112 a first-row
 *             geofence arrival written for Dee Lane
 *     L-3115  a blank Drop-off: geofence 10/16, delivered 10/17: +10/17 in the
 *             ledger; his W43 invoice already pays 10/17 from the completion date
 *   Dee Lane   $250/day, investor 5, truck T4 with an ELD that drives 10/12-10/15
 *     L-3113  sched 10/12, geofence 10/13 (a fix from before its dispatch),
 *             delivered 10/15: -10/12 +10/13 +10/14 +10/15
 *   Cy Pratt   30% of revenue (out of scope)
 *
 *   R1  read-only: the database file is unchanged; the text report runs
 *   R2  refused (exit 2): no FROM, not a date, the future, a closed month, the
 *       rule already on, no --db
 *   R3  recorder health
 *   R4  the in-scope loads: outcomes, days, the S3 lists, D11b, the carried counts
 *       (invoices and kept arrival lines saved after their week's batch ran)
 *   R5  the payout ledger, investor 5 and the company, the add-up, the investor view
 *   R6  the weekly invoices, the Approved one never regenerated; invoice and ledger
 *       side by side
 *   R7  closed and pre-FROM months unchanged; the trip rule's line; the S3 lines
 *   R8  the cross-check against load_eld_miles' replayed arrival
 *   R9  no name anywhere; Load IDs and invoice numbers only with --ids
 *   R10 an older copy without the recorder's columns: every in-scope load listed as
 *       not read, every one paid as today, exit 0
 *   R11 exit 1 when the money doesn't add up (a $0 load's month turns active, so a
 *       truck's fixed cost charges beside the new driver pay)
 *   U   addUpProblems(), s3Checks(), monthGuard() and viewMovedApart(), the checks
 *       behind exit 1 and S3
 *
 * Pure: no server, no app.db, no network.
 * Run: node scripts/test-arrival-pickup-report.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC";
const W = require("./lib/work-days-world");
const { loadRow } = W;

const SCRIPT = "scripts/arrival-pickup-report.js";
const AMY = "Amy Birch";
const BO = "Bo Wyn";
const DEE = "Dee Lane";
const CY = "Cy Pratt";
const FROM = "2026-10-05";
const NOW = Date.parse("2026-10-20T16:00:00Z");
const CHI = "America/Chicago";
const U = (s) => Date.parse(`${s.replace(" ", "T")}Z`);

// History rows as the arrival recorder writes them (times are stored UTC text).
const ev = (load, at, status, o = {}) => ({
	load, at, status, source: o.source || "manual", role: o.role === undefined ? "Driver" : o.role, old: o.old || "", actor: o.actor || "",
	fixMs: o.fix ? U(o.fix) : null, zone: o.zone || "", tz: o.tz || "", hauling: o.hauling === undefined ? null : o.hauling,
});
const dispatch = (load, at) => ev(load, at, "Dispatched", { source: "dispatch", role: "Dispatcher", actor: "dispatcher_test" });
const geo = (load, at, fix, actor, hauling = 0) => ev(load, at, "At Shipper", { source: "geofence", role: "system", actor, fix, zone: "inside", tz: CHI, hauling });
const tap = (load, at, actor, zone, fix = null, role = "Driver") => ev(load, at, "At Shipper", { actor, zone, fix, tz: CHI, role });
const step = (load, at, status, actor) => ev(load, at, status, { actor });
function trip(load, actor, { dispatchAt = null, headingAt = null, arrival, after }) {
	return [
		...(dispatchAt ? [dispatch(load, dispatchAt)] : []),
		...(headingAt ? [step(load, headingAt, "Heading to Shipper", actor)] : []),
		arrival,
		...after.map(([at, status]) => step(load, at, status, actor)),
	];
}
const run4 = (day, recv, deliv) => [[`${day} 13:00:00`, "Loading"], [`${day} 13:30:00`, "In Transit"], [recv, "At Receiver"], [deliv, "Delivered"]];
// Counts compare whatever order their keys were added in.
const S = (v) => (Array.isArray(v) ? v.map(S) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, S(v[k])])) : v);

const HISTORY = [
	...trip("L-3101", AMY, { dispatchAt: "2026-10-05 13:00:00", headingAt: "2026-10-06 12:00:00", arrival: geo("L-3101", "2026-10-06 13:41:10", "2026-10-06 13:40:00", AMY),
		after: [["2026-10-06 15:00:00", "Loading"], ["2026-10-06 15:30:00", "In Transit"], ["2026-10-07 18:00:00", "At Receiver"], ["2026-10-07 20:00:00", "Delivered"]] }),
	...trip("L-3102", BO, { dispatchAt: "2026-10-05 14:00:00", headingAt: "2026-10-07 20:00:00", arrival: tap("L-3102", "2026-10-08 02:30:00", BO, "inside", "2026-10-08 02:29:00"),
		after: run4("2026-10-08", "2026-10-10 04:00:00", "2026-10-10 05:10:00") }),
	...trip("L-3103", AMY, { dispatchAt: "2026-10-09 15:00:00", headingAt: "2026-10-13 20:00:00", arrival: geo("L-3103", "2026-10-14 04:21:00", "2026-10-14 04:20:00", AMY),
		after: run4("2026-10-14", "2026-10-15 19:00:00", "2026-10-15 21:00:00") }),
	...trip("L-3104", AMY, { dispatchAt: "2026-10-09 15:05:00", arrival: tap("L-3104", "2026-10-16 14:00:00", AMY, "", null, "Super Admin"),
		after: [["2026-10-16 20:00:00", "Delivered"]] }),
	...trip("L-3105", BO, { dispatchAt: "2026-10-09 15:10:00", arrival: tap("L-3105", "2026-10-13 14:00:00", BO, "outside", "2026-10-13 13:59:00"),
		after: [["2026-10-13 14:10:00", "Delivered"]] }),
	...trip("L-3106", BO, { dispatchAt: "2026-10-09 15:15:00", arrival: tap("L-3106", "2026-10-14 19:02:00", BO, ""),
		after: [["2026-10-14 19:03:00", "Loading"], ["2026-10-14 19:04:00", "In Transit"], ["2026-10-14 19:06:00", "At Receiver"], ["2026-10-14 19:10:00", "Delivered"]] }),
	...trip("L-3107", AMY, { dispatchAt: "2026-10-06 15:00:00", arrival: geo("L-3107", "2026-10-07 16:00:00", "2026-10-07 15:59:00", AMY, 1),
		after: run4("2026-10-08", "2026-10-08 18:00:00", "2026-10-08 20:00:00") }),
	...trip("L-3108", BO, { dispatchAt: "2026-10-09 15:20:00", arrival: geo("L-3108", "2026-10-14 19:08:00", "2026-10-14 19:07:30", BO),
		after: [["2026-10-15 14:00:00", "Loading"], ["2026-10-15 14:30:00", "In Transit"]] }),
	...trip("L-3109", AMY, { dispatchAt: "2026-10-01 13:00:00", arrival: geo("L-3109", "2026-10-01 15:00:00", "2026-10-01 14:59:00", AMY),
		after: [["2026-10-02 20:00:00", "Delivered"]] }),
	ev("L-3110", "2026-10-16 20:00:00", "Delivered", { actor: AMY, role: null }),
	...trip("L-3111", CY, { dispatchAt: "2026-10-05 15:00:00", arrival: geo("L-3111", "2026-10-06 14:01:00", "2026-10-06 14:00:00", CY),
		after: [["2026-10-07 20:00:00", "Delivered"]] }),
	...trip("L-3112", BO, { arrival: geo("L-3112", "2026-10-12 15:00:00", "2026-10-12 12:00:00", DEE),
		after: [["2026-10-12 16:00:00", "Loading"], ["2026-10-12 16:30:00", "In Transit"], ["2026-10-12 20:00:00", "At Receiver"], ["2026-10-12 22:00:00", "Delivered"]] }),
	...trip("L-3115", BO, { dispatchAt: "2026-10-09 15:25:00", arrival: geo("L-3115", "2026-10-16 14:01:00", "2026-10-16 14:00:00", BO),
		after: [["2026-10-16 15:00:00", "Loading"], ["2026-10-16 15:30:00", "In Transit"], ["2026-10-17 18:00:00", "At Receiver"], ["2026-10-17 20:00:00", "Delivered"]] }),
	...trip("L-3113", DEE, { dispatchAt: "2026-10-09 16:00:00", headingAt: "2026-10-13 12:00:00", arrival: geo("L-3113", "2026-10-13 14:01:00", "2026-10-09 15:00:00", DEE),
		after: [["2026-10-13 15:00:00", "Loading"], ["2026-10-13 15:30:00", "In Transit"], ["2026-10-15 18:00:00", "At Receiver"], ["2026-10-15 20:00:00", "Delivered"]] }),
];

const ROWS = [
	loadRow({ id: "L-3101", driver: AMY, pickup: "2026-10-05 8:00", dropoff: "2026-10-07 17:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T1" }),
	loadRow({ id: "L-3102", driver: BO, pickup: "2026-10-09 8:00", dropoff: "2026-10-09 17:00", assigned: "2026-10-05", done: "2026-10-10", truck: "T2", owner: "" }),
	loadRow({ id: "L-3103", driver: AMY, pickup: "2026-10-12 8:00", dropoff: "2026-10-13 17:00", assigned: "2026-10-09", done: "2026-10-15", truck: "T1" }),
	loadRow({ id: "L-3104", driver: AMY, pickup: "2026-10-16 8:00", dropoff: "2026-10-16 17:00", assigned: "2026-10-09", done: "2026-10-16", truck: "T1" }),
	loadRow({ id: "L-3105", driver: BO, pickup: "2026-10-13 8:00", dropoff: "2026-10-13 17:00", assigned: "2026-10-09", done: "2026-10-13", truck: "T2", owner: "" }),
	loadRow({ id: "L-3106", driver: BO, pickup: "2026-10-14 8:00", dropoff: "2026-10-14 17:00", assigned: "2026-10-09", done: "2026-10-14", truck: "T2", owner: "" }),
	loadRow({ id: "L-3107", driver: AMY, pickup: "2026-10-08 8:00", dropoff: "2026-10-08 17:00", assigned: "2026-10-06", done: "2026-10-08", truck: "T1" }),
	loadRow({ id: "L-3108", driver: BO, pickup: "2026-10-15 8:00", dropoff: "2026-10-15 17:00", assigned: "2026-10-09", done: "2026-10-15", truck: "T2", owner: "" }),
	loadRow({ id: "L-3109", driver: AMY, pickup: "2026-10-02 8:00", dropoff: "2026-10-02 17:00", assigned: "2026-10-02", done: "2026-10-02", truck: "T1" }),
	loadRow({ id: "L-3110", driver: AMY, pickup: "2026-10-16 8:00", dropoff: "2026-10-16 17:00", assigned: "", done: "2026-10-16", truck: "T1" }),
	loadRow({ id: "L-3111", driver: CY, pickup: "2026-10-06 8:00", dropoff: "2026-10-07 17:00", assigned: "2026-10-05", done: "2026-10-07", truck: "T3" }),
	loadRow({ id: "L-3112", driver: BO, pickup: "2026-10-12 8:00", dropoff: "2026-10-12 17:00", assigned: "2026-10-09", done: "2026-10-12", truck: "T2", owner: "" }),
	loadRow({ id: "L-3113", driver: DEE, pickup: "2026-10-12 8:00", dropoff: "2026-10-12 17:00", assigned: "2026-10-09", done: "2026-10-15", truck: "T4" }),
	loadRow({ id: "L-3115", driver: BO, pickup: "2026-10-16 8:00", dropoff: "", assigned: "2026-10-09", done: "2026-10-17", truck: "T2", owner: "" }),
	loadRow({ id: "L-3114", driver: AMY, pickup: "2026-10-19 8:00", dropoff: "2026-10-20 17:00", assigned: "2026-10-16", done: "", status: "In Transit", truck: "T1" }),
	loadRow({ id: "L-3001", driver: AMY, pickup: "2026-09-21 8:00", dropoff: "2026-09-23 17:00", assigned: "2026-09-21", done: "2026-09-23", truck: "T1" }),
];

function addHistory(w, rows) {
	const st = w.db.prepare(`INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, reason, actor_role, fix_ms, pickup_zone, local_tz, other_load_hauling, changed_at)
		VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`);
	for (const r of rows) st.run(String(r.load).toLowerCase().replace(/^#/, ""), r.old, r.status, r.source, r.actor, r.role, r.fixMs, r.zone, r.tz, r.hauling, r.at);
}

function fixture({ after = null } = {}) {
	const coords = Object.fromEntries(ROWS.map((r) => r["Load ID"]).filter((id) => id !== "L-3106").map((id) => [id, W.PICKUP]));
	const w = W.startWorld({
		env: {},
		drivers: [{ name: AMY, payDaily: 300 }, { name: BO, payDaily: 260, carrier: "Home Fleet" }, { name: CY, payType: "percentage", payPct: 30 }, { name: DEE, payDaily: 250 }],
		trucks: [{ unit: "T1", driver: AMY }, { unit: "T2", driver: BO, owner: 0 }, { unit: "T3", driver: CY }, { unit: "T4", driver: DEE, vid: "V4" }],
		pings: { V4: W.feed(1000).drive("2026-10-12", { miles: 120 }).drive("2026-10-13", { miles: 140 }).drive("2026-10-14", { miles: 160 }).drive("2026-10-15", { miles: 90 }).pings },
		coords,
		rows: ROWS,
		locks: ["2026-09"],
		now: NOW,
	});
	addHistory(w, HISTORY);
	// L-3102's receiver is in the Mountain band.
	w.db.prepare("UPDATE load_coordinates SET dest_lat = 39.74, dest_lng = -104.99 WHERE load_id = 'L-3102'").run();
	const replay = w.db.prepare("INSERT INTO load_eld_miles (load_id, pickup_arrive_ms) VALUES (?, ?)");
	// 23:30 CDT 10/6, already 10/7 in the app's zone.
	replay.run("l-3101", U("2026-10-07 04:30:00"));
	replay.run("l-3103", U("2026-10-12 15:00:00"));
	replay.run("l-3113", U("2026-10-08 15:00:00"));
	replay.run("l-3105", U("2026-10-13 13:00:00"));
	if (after) after(w);
	return w;
}
const argsFor = (copy, extra) => [`--db=${copy.db}`, `--values-json=${copy.values}`, `--env-file=${copy.envFile}`, ...extra];

async function outputs() {
	const w = fixture();
	// Amy's W41 invoice, made with the rule off, then approved.
	const g = await W.generate(w, AMY, "2026-10-09");
	if (g.status !== 200) throw new Error(`generate: ${g.status} ${JSON.stringify(g.body).slice(0, 160)}`);
	w.db.prepare("UPDATE invoices SET status = 'Approved' WHERE id = ?").run(g.invoice.id);
	// The W41 batch ran before Amy's invoice and her kept arrival lines were saved;
	// W42's row is the first-enable baseline, not a run, so Bo's W42 lines don't count.
	const ran = w.db.prepare("INSERT INTO invoice_autogen_runs (week_end, ran_at, attempts, summary) VALUES (?, ?, 1, ?)");
	ran.run("2026-10-09", "2026-10-10T00:05:00.000Z", "0 generated & submitted");
	ran.run("2026-10-16", "2026-10-17T00:05:00.000Z", "baseline (feature enabled, no retroactive run)");
	const kept = w.db.prepare("INSERT INTO server_state (key, value, updated_at) VALUES (?, ?, ?)");
	kept.run("arrival_pickup_lines:2026-10-03:amy birch", JSON.stringify({ driver: AMY, invoiceId: 0, lines: ["made-up line"] }), "2026-10-20 12:00:00");
	kept.run("arrival_pickup_lines:2026-10-10:bo wyn", JSON.stringify({ driver: BO, invoiceId: 0, lines: ["made-up line"] }), "2026-10-20 12:00:00");
	const copy = W.saveCopy(w, {});
	const before = W.fileHash(copy.db);
	const run = W.runScript(SCRIPT, argsFor(copy, [`--from=${FROM}`, "--json"]));
	const text = W.runScript(SCRIPT, argsFor(copy, [`--from=${FROM}`]));
	const withIds = W.runScript(SCRIPT, argsFor(copy, [`--from=${FROM}`, "--ids", "--json"]));
	return { w, g, copy, run, text, withIds, fileBefore: before, fileAfter: W.fileHash(copy.db) };
}
function json(ok, r) {
	ok("the script exits 0 with JSON", r.code === 0 && !!r.json, (r.stderr || r.stdout).slice(0, 400));
	return r.json || {};
}

const R = W.createRunner("The arrival pickup date's read-only report (scripts/arrival-pickup-report.js)");

(async () => {
	let shared = null;
	const get = async () => (shared || (shared = await outputs()));

	await R.test("R1 Read-only: the database file is byte for byte as before, and the text report runs and says nothing was written", async ({ eq, ok }) => {
		const o = await get();
		json(ok, o.run);
		eq("the database file", o.fileAfter, o.fileBefore);
		ok("the text report exits 0", o.text.code === 0 && /Nothing was written/.test(o.text.stdout), (o.text.stderr || o.text.stdout).slice(0, 400));
		ok("its five sections", ["1. RECORDER HEALTH", "2. IN-SCOPE LOADS", "3. MONEY", "4. CHECKS", "5. CROSS-CHECK"].every((s) => o.text.stdout.includes(s)), o.text.stdout.slice(0, 400));
	});

	await R.test("R2 Refused (exit 2): no FROM, a date that doesn't exist, the future, a closed month, the rule already on in the settings, no --db", async ({ eq }) => {
		const o = await get();
		const code = (copy, extra) => W.runScript(SCRIPT, argsFor(copy, [...extra, "--json"])).code;
		const on = W.saveCopy(o.w, { ARRIVAL_PICKUP_DATE_ENABLED: "true", ARRIVAL_PICKUP_DATE_FROM: FROM });
		const noDb = W.runScript(SCRIPT, [`--values-json=${o.copy.values}`, `--from=${FROM}`]).code;
		eq("[none, 2026-02-30, 2099-01-01, 2026-09-15, on, no --db]",
			[code(o.copy, []), code(o.copy, ["--from=2026-02-30"]), code(o.copy, ["--from=2099-01-01"]), code(o.copy, ["--from=2026-09-15"]), code(on, [`--from=${FROM}`]), noDb],
			[2, 2, 2, 2, 2, 2]);
	});

	await R.test("R3 Recorder health since FROM: At Shipper rows by source and role, tap verdicts and fix ages, the batch tap, geofence rows by other_load_hauling and the other load, the lag, the zones", async ({ eq, ok }) => {
		const o = await get();
		const h = json(ok, o.run).recorder || {};
		eq("[rows, recorder rows, no role]", [h.rows, h.recorderRows, h.rowsWithoutRole], [65, 64, 1]);
		eq("At Shipper by source / role", S(h.atShipper), S({ "geofence / system": 8, "manual / Driver": 3, "manual / Super Admin": 1 }));
		eq("tap verdicts", S(h.taps), S({ driver: { inside: 1, outside: 1, unknown: 1 }, staff: { inside: 0, outside: 0, unknown: 1 } }));
		eq("[driver taps, no fix within 5 min, fix ages]", [h.driverTaps, h.driverTapsNoFix, S(h.tapFixAge)], [3, 1, { "0-2 min": 2 }]);
		eq("[batch taps, manual followed within 15 min (the far tap too)]", [h.batchTaps, h.manualFollowedWithin15], [1, 2]);
		const g = h.geofence || {};
		// L-3115's arrival reads L-3108 as In Transit: it was completed with no status row.
		eq("geofence by hauling and the other load", S(g.byHauling), S({ 0: { none: 5, "at receiver": 1, "in transit": 1 }, 1: { "in transit": 1 } }));
		eq("[lag, no fix, fix after row, fix before dispatch]", [S(g.lag), g.noFix, g.fixAfterRow, g.beforeDispatch], [S({ "0-2 min": 6, "1-6 h": 1, "over 6 h": 1 }), 0, 0, 1]);
		eq("first-row geofence arrivals", S(g.firstRow), S({ rows: 1, lag: { "1-6 h": 1 } }));
		eq("[zones, app-zone fallback, shipper's day not the app's]", [S(h.zones), h.zoneFromAppFallback, h.shipperDayNotAppDay], [{ [CHI]: 12 }, 1, 1]);
	});

	await R.test("R4 In-scope loads: 11, by outcome; official minus scheduled; the S3 list; D11b by ELD; the counts carried from PR 2's notes", async ({ eq, ok }) => {
		const o = await get();
		const j = json(ok, o.run);
		const L = j.loads || {};
		eq("[in scope, excluded]", [L.inScope, j.excluded], [11, { noAssignedDate: 1, percentage: 1 }]);
		eq("official", S(L.official), S({ geofence: 5, driver: 1 }));
		eq("none", S(L.none), S({ no_at_shipper: 0, staff_only: 1, far_tap: 1, batch_tap: 1, hauling_other_load: 1, undone: 0, unrecorded: 0 }));
		eq("[no delivery, not read]", [S(L.noDelivery), L.notRead], [{ "no completed row in the history": 1 }, 0]);
		eq("[official minus scheduled, no scheduled pickup]", [S(L.officialMinusScheduled), L.noScheduledPickup], [S({ "+1": 3, "-2": 1, 0: 2 }), 0]);
		eq("[2+ days early, arrival after the drop-off]", [L.earlyBy2 && L.earlyBy2.count, L.arrivalAfterDropoff && L.arrivalAfterDropoff.count], [1, 1]);
		eq("delivered after the drop-off, by ELD", S(L.completedAfterDropoff), S({
			eld: { loads: 1, a: { window: 3, paid: 3 }, b: { window: 3, paid: 3 } },
			noEld: { loads: 2, a: { window: 7, paid: 7 }, b: { window: 4, paid: 4 } },
		}));
		eq("[no-ELD extended 2+, blank drop-off, from another driver]", [L.noEldExtended2 && L.noEldExtended2.count, L.blankDropoff, L.fromAnotherDriver && L.fromAnotherDriver.count], [1, { loads: 1, days: { 2: 1 } }, 1]);
		eq("[first-row geofence, its day moved]", [L.firstRowGeofence && L.firstRowGeofence.count, L.firstRowGeofence && L.firstRowGeofence.dayMoved], [1, 0]);
		eq("[receiver's day differs, no drop-off point]", [L.receiverDayDiffers, L.noReceiverPoint], [1, 0]);
		eq("saved after their week's batch: Amy's W41 invoice and her kept lines (W42 has only a baseline)", L.afterBatch, { invoices: 1, weeks: 1, noBatchRun: 0, keptLines: 1 });
	});

	await R.test("R5 Money: the ledger per scope, driver and month; investor 5's October moves by half the driver pay; the company keeps the rest; it adds up; the investor view moves as the ledger", async ({ eq, ok }) => {
		const o = await get();
		const j = json(ok, o.withIds);
		const m = j.money || {};
		const days = (m.ledger ? m.ledger.perDay : []).map((d) => `${d.ownerId} ${d.driver} ${d.day} ${d.change} ${d.loadId} ${d.amount}`);
		eq("changed ledger days", days, [
			"0 driver 2 2026-10-07 added L-3102 260", "0 driver 2 2026-10-08 added L-3102 260", "0 driver 2 2026-10-10 added L-3102 260", "0 driver 2 2026-10-17 added L-3115 260",
			"5 driver 1 2026-10-05 removed L-3101 -300", "5 driver 1 2026-10-12 removed L-3103 -300", "5 driver 1 2026-10-14 added L-3103 300", "5 driver 1 2026-10-15 added L-3103 300",
			"5 driver 3 2026-10-12 removed L-3113 -250", "5 driver 3 2026-10-13 added L-3113 250", "5 driver 3 2026-10-14 added L-3113 250", "5 driver 3 2026-10-15 added L-3113 250",
		]);
		eq("by scope, driver and month", (m.ledger ? m.ledger.driverMonths : []).map((d) => `${d.ownerId} ${d.driver} ${d.month} +${d.daysAdded}/-${d.daysRemoved} ${d.driverPayChange}`),
			["0 driver 2 2026-10 +4/-0 1040", "5 driver 1 2026-10 +2/-2 0", "5 driver 3 2026-10 +3/-1 500"]);
		const oct = (m.investors || []).find((i) => i.ownerId === 5 && i.period === "2026-10");
		ok("investor 5's October", !!oct, JSON.stringify(m.investors));
		if (oct) {
			eq("[basis, driver pay, investor, company, payable change]", [oct.basis, oct.driverPayChange, oct.investorChange, oct.companyChange, oct.payableChange], ["split", 500, -250, -250, -250]);
			eq("raw earnings now -> on", oct.rawOn - oct.rawNow, -250);
		}
		eq("investor months changed", (m.investors || []).map((i) => `${i.ownerId} ${i.period}`), ["5 2026-10"]);
		eq("the company scope", m.company, [{ ownerId: 0, period: "2026-10", driverPayChange: 1040, companyChange: -1040 }]);
		eq("the investor view against the ledger", m.investorView, [{ ownerId: 5, period: "2026-10", ledgerChange: -250, viewChange: -250 }]);
		eq("[adds up, view matches]", [j.checks && j.checks.addsUp, j.checks && j.checks.viewMatchesLedger], [true, true]);
	});

	await R.test("R6 The weekly invoices per driver-week (Amy's Approved W41 named, never regenerated), and the invoice beside the ledger: Bo's W42 pays only 10/10 of his three added days", async ({ eq, ok }) => {
		const o = await get();
		const j = json(ok, o.withIds);
		const weeks = (j.money && j.money.invoiceWeeks) || [];
		eq("the weeks", weeks.map((w) => `${w.driver} ${w.weekStart} [${w.loadIds.join(" ")}] ${w.daysNow.length}->${w.daysOn.length} +[${w.addedDays.join(" ")}] -[${w.removedDays.join(" ")}] ${w.amountNow}->${w.amountOn} ${w.lines.notRead}/${w.lines.notApplied}/${w.lines.extended}`), [
			"driver 1 2026-10-03 [L-3101 L-3107] 4->3 +[] -[2026-10-05] 1200->900 0/0/0",
			"driver 1 2026-10-10 [L-3103 L-3104] 3->4 +[2026-10-14 2026-10-15] -[2026-10-12] 900->1200 0/0/1",
			"driver 2 2026-10-10 [L-3102 L-3105 L-3106 L-3108 L-3112] 4->5 +[2026-10-10] -[] 1040->1300 0/1/0",
			"driver 2 2026-10-17 [L-3115] 1->1 +[] -[] 260->260 0/0/0",
			"driver 3 2026-10-10 [L-3113] 1->3 +[2026-10-13 2026-10-14 2026-10-15] -[2026-10-12] 250->750 0/0/1",
		]);
		const w41 = weeks[0] || {};
		ok("Amy's W41: Approved, $1,200, never regenerated", !!w41.invoice && w41.invoice.status === "Approved" && w41.invoice.totalEarnings === 1200 && /^issued \(Approved\): never regenerated/.test(w41.afterSwitchOn), JSON.stringify(w41));
		ok("with --ids, its invoice number", !!w41.invoice && w41.invoice.invoiceNumber === o.g.invoice.invoice_number, JSON.stringify(w41.invoice));
		eq("side by side", j.money && j.money.sideBySide, {
			drivers: [
				{ driver: "driver 1", invoiceDays: 0, invoiceChange: 0, ledgerDays: 0, ledgerChange: 0 },
				{ driver: "driver 2", invoiceDays: 1, invoiceChange: 260, ledgerDays: 4, ledgerChange: 1040 },
				{ driver: "driver 3", invoiceDays: 2, invoiceChange: 500, ledgerDays: 2, ledgerChange: 500 },
			],
			total: { invoiceDays: 3, invoiceChange: 760, ledgerDays: 6, ledgerChange: 1540 },
		});
	});

	await R.test("R7 Checks: closed September and the months before FROM unchanged, no problem; the trip rule is off; the S3 lines with their shares", async ({ eq, ok }) => {
		const o = await get();
		const j = json(ok, o.run);
		eq("[closed months, closed unchanged, before FROM unchanged, problems]", [j.closedMonths, j.checks && j.checks.closedMonthsUnchanged, j.checks && j.checks.monthsBeforeFromUnchanged, j.problems], [["2026-09"], true, true, []]);
		ok("the trip rule's line", /^off in the app's \.env/.test(j.checks && j.checks.tripRule), j.checks && j.checks.tripRule);
		eq("S3 [count, of, stop]", (j.s3 || []).map((s) => [s.count, s.of, s.stop]), [[1, 6, true], [2, 3, true], [3, 11, true], [1, 3, true], [1, null, null]]);
		const all = JSON.stringify([j.loads, j.money]);
		ok("no September load or day anywhere", !/L-3001|2026-09-2/.test(all), all.slice(0, 300));
	});

	await R.test("R8 The cross-check against the replayed arrival: 3 compared (1 same day), 2 within the dispatch bound (1 same), 1 before the dispatch; a far tap with a replay", async ({ eq, ok }) => {
		const o = await get();
		const x = json(ok, o.run).crossCheck || {};
		eq("cross-check", S(x), S({ compared: 3, agree: 1, differ: 2, bounded: { compared: 2, agree: 1, differ: 1 }, outsideBound: 1, noDispatch: 0, noArrivalWithReplay: { far_tap: { replays: 1, withinDispatch: 1 } } }));
	});

	await R.test("R9 No name anywhere; Load IDs and invoice numbers only with --ids", async ({ eq, ok }) => {
		const o = await get();
		const plain = JSON.stringify(json(ok, o.run));
		// Any spelling: the report reads names normalized to lower case.
		const named = /\b(amy|birch|bo wyn|dee|lane|cy|pratt|ivy|dispatcher_test)\b/i;
		ok("no name in the JSON, with or without --ids", !named.test(plain) && !named.test(o.withIds.stdout), (plain.match(named) || [""])[0]);
		ok("no name in the text report", !named.test(o.text.stdout), (o.text.stdout.match(named) || [""])[0]);
		ok("no Load ID or invoice number without --ids", !/L-3\d{3}|"invoiceNumber"/.test(plain) && !/L-3\d{3}/.test(o.text.stdout), (plain.match(/L-3\d{3}|"invoiceNumber"/) || [""])[0]);
		const L = (o.withIds.json || {}).loads || {};
		eq("with --ids: [2+ early, no-ELD extended, another driver, first row, no delivery]",
			[L.earlyBy2 && L.earlyBy2.loadIds, L.noEldExtended2 && L.noEldExtended2.loadIds, L.fromAnotherDriver && L.fromAnotherDriver.loadIds, L.firstRowGeofence && L.firstRowGeofence.loadIds, L.noDeliveryLoads],
			[["L-3102"], ["L-3103"], ["L-3112"], ["L-3112"], ["L-3108"]]);
	});

	await R.test("R10 An older copy without the recorder's columns: exit 0, recorder health says so, all 11 in-scope loads are not read, and nothing is paid differently", async ({ eq, ok }) => {
		const w = fixture({ after: (x) => x.db.exec("ALTER TABLE load_status_history DROP COLUMN actor_role") });
		const copy = W.saveCopy(w, {});
		const r = W.runScript(SCRIPT, argsFor(copy, [`--from=${FROM}`, "--ids", "--json"]));
		const j = json(ok, r);
		eq("[recorder readable, not read, official]", [j.recorder && j.recorder.readable, j.loads && j.loads.notRead, j.loads && j.loads.official], [false, 11, { geofence: 0, driver: 0 }]);
		ok("each not-read load names the history", ((j.loads && j.loads.notReadLoads) || []).every((e) => /status history could not be read/.test(e.error)) && ((j.loads && j.loads.notReadLoads) || []).length === 11, JSON.stringify(j.loads && j.loads.notReadLoads).slice(0, 300));
		eq("[ledger days changed, investor months, invoice weeks changed]",
			[j.money && j.money.ledger.perDay.length, j.money && j.money.investors.length, ((j.money && j.money.invoiceWeeks) || []).filter((x) => x.addedDays.length || x.removedDays.length).length], [0, 0, 0]);
		const text = W.runScript(SCRIPT, argsFor(copy, [`--from=${FROM}`]));
		ok("the text report says the columns could not be read", text.code === 0 && /recorder columns could not be read/.test(text.stdout), (text.stderr || text.stdout).slice(0, 300));
	});

	await R.test("R11 Exit 1 when the money doesn't add up: Eve Moss's $0 load on a company truck makes October active under the rule, so the truck's $900 fixed cost charges beside her $400 of pay", async ({ eq, ok }) => {
		const EVE = "Eve Moss";
		const w = W.startWorld({
			env: {},
			drivers: [{ name: EVE, payDaily: 200, carrier: "Home Fleet" }],
			trucks: [{ unit: "T6", driver: EVE, owner: 0, vid: "V6" }],
			// Parked on the scheduled day, driving from the arrival on.
			pings: { V6: W.feed(5000).park("2026-10-12").drive("2026-10-13", { miles: 150 }).drive("2026-10-14", { miles: 150 }).pings },
			coords: { "L-3201": W.PICKUP },
			rows: [loadRow({ id: "L-3201", driver: EVE, pickup: "2026-10-12 8:00", dropoff: "2026-10-12 17:00", assigned: "2026-10-09", done: "2026-10-14", truck: "T6", owner: "", payment: "$0.00" })],
			locks: ["2026-09"],
			now: NOW,
		});
		w.db.prepare("UPDATE trucks SET truck_payment_monthly = 900 WHERE unit_number = 'T6'").run();
		addHistory(w, trip("L-3201", EVE, { dispatchAt: "2026-10-09 16:00:00", headingAt: "2026-10-13 12:00:00", arrival: geo("L-3201", "2026-10-13 14:01:00", "2026-10-13 14:00:00", EVE),
			after: [["2026-10-13 15:00:00", "Loading"], ["2026-10-13 15:30:00", "In Transit"], ["2026-10-14 18:00:00", "At Receiver"], ["2026-10-14 20:00:00", "Delivered"]] }));
		const copy = W.saveCopy(w, {});
		const r = W.runScript(SCRIPT, argsFor(copy, [`--from=${FROM}`, "--json"]));
		const j = r.json || {};
		eq("[exit code, adds up, closed months unchanged]", [r.code, j.checks && j.checks.addsUp, j.checks && j.checks.closedMonthsUnchanged], [1, false, true]);
		eq("the company's October", j.money && j.money.company, [{ ownerId: 0, period: "2026-10", driverPayChange: 400, companyChange: -1300 }]);
		ok("one add-up problem, for owner 0's October", (j.problems || []).length === 1 && j.problems[0].addUp === true && j.problems[0].ownerId === 0 && /^2026-10: /.test(j.problems[0].issue), JSON.stringify(j.problems || r.stderr.slice(0, 300)));
		const text = W.runScript(SCRIPT, argsFor(copy, [`--from=${FROM}`]));
		ok("the text report names it and exits 1", text.code === 1 && /PROBLEM \(money, owner 0\): 2026-10: /.test(text.stdout) && /add up to zero in every scope and month: NO/.test(text.stdout), (text.stderr || text.stdout).slice(-400));
	});

	let lib = null;
	try { lib = require("./arrival-pickup-report"); } catch (err) { lib = { error: err.message }; }
	await R.test("U3 monthGuard(): a closed month is closed (even before FROM), a month before FROM's is before FROM, FROM's month and later pass", async ({ eq, ok }) => {
		ok("the script exports monthGuard()", typeof lib.monthGuard === "function", lib.error || "");
		if (typeof lib.monthGuard !== "function") return;
		const locked = (m) => m === "2026-09";
		eq("[2026-09, 2026-08, 2026-10, 2026-11]", ["2026-09", "2026-08", "2026-10", "2026-11"].map((m) => lib.monthGuard(m, locked, "2026-10")),
			[{ closed: true }, { beforeFrom: true }, null, null]);
	});

	await R.test("U4 viewMovedApart(): the investor view and the ledger moving a dollar apart is rounding; more is a problem", async ({ eq, ok }) => {
		ok("the script exports viewMovedApart()", typeof lib.viewMovedApart === "function", lib.error || "");
		if (typeof lib.viewMovedApart !== "function") return;
		eq("[same, $1 apart, $1.50 apart, view still]", [lib.viewMovedApart(-250, -250), lib.viewMovedApart(-250, -249), lib.viewMovedApart(-250, -248.5), lib.viewMovedApart(-250, 0)], [false, false, true, true]);
	});
	await R.test("U1 addUpProblems(): a split month adds up at 50%; a missing dollar, an investor change that isn't the split share, and a lease month that moves the investor are problems; a dollar of rounding is not", async ({ eq, ok }) => {
		ok("the script exports addUpProblems()", typeof lib.addUpProblems === "function", lib.error || "");
		if (typeof lib.addUpProblems !== "function") return;
		const n = (o) => lib.addUpProblems({ ownerId: 5, month: "2026-10", splitPct: 50, ...o }).length;
		eq("[balanced, $2 missing, not the split share, lease still, lease moved, rounding, company scope]", [
			n({ driverPayChange: 500, investorChange: -250, companyChange: -250, netChange: -500 }),
			n({ driverPayChange: 500, investorChange: -250, companyChange: -248, netChange: -498 }),
			n({ driverPayChange: 500, investorChange: -300, companyChange: -200, netChange: -500 }),
			n({ driverPayChange: 500, investorChange: 0, companyChange: -500, netChange: -500, basis: "lease" }),
			n({ driverPayChange: 500, investorChange: -250, companyChange: -250, netChange: -500, basis: "lease" }),
			n({ driverPayChange: 500, investorChange: -250.5, companyChange: -249.5, netChange: -500 }),
			lib.addUpProblems({ ownerId: 0, month: "2026-10", driverPayChange: 780, investorChange: 0, companyChange: -780, netChange: -780 }).length,
		], [0, 1, 1, 0, 1, 0, 0]);
		eq("a problem is marked for the add-up check", lib.addUpProblems({ ownerId: 5, month: "2026-10", driverPayChange: 500, investorChange: -250, companyChange: -248, netChange: -498, splitPct: 50 })[0].addUp, true);
	});

	await R.test("U2 s3Checks(): a share over its limit stops, a share at its limit does not", async ({ eq, ok }) => {
		ok("the script exports s3Checks()", typeof lib.s3Checks === "function", lib.error || "");
		if (typeof lib.s3Checks !== "function") return;
		const summary = (early, official) => ({
			official: { geofence: official, driver: 0 }, none: { far_tap: 0, batch_tap: 0, staff_only: 0, hauling_other_load: 0 }, inScope: official,
			earlyBy2: new Array(early).fill({}), noEldExtended2: [],
		});
		const health = { driverTaps: 10, driverTapsNoFix: 2 };
		eq("[1 of 20, 2 of 20; taps 2 of 10, 3 of 10]", [
			lib.s3Checks(summary(1, 20), health)[0].stop, lib.s3Checks(summary(2, 20), health)[0].stop,
			lib.s3Checks(summary(1, 20), health)[3].stop, lib.s3Checks(summary(1, 20), { driverTaps: 10, driverTapsNoFix: 3 })[3].stop,
		], [false, true, false, true]);
	});

	R.finish();
})();
