#!/usr/bin/env node
// The time-off ELD check's rule (lib/time-off-eld-check.js, rule version 1), run
// pure on made-up data: driver "Hollis Renner" (another, "Soren King"), trucks
// T1 (id 11, device vid-t1) and T2 (id 12, device vid-t2), a yard at 29.70,
// -95.40 (Central time).
//
//   §1  the constants: a dark stretch is a silence over 30 minutes; movement
//       across one is an odometer or position step beyond the 5 mi floor; the
//       engine rule is 1 h; ELD_MAX_GAP_MS stays 6 h for the miles walk
//   §2  his holding and device intervals: a handover, a relief driver, a team
//       truck, a device re-linked
//   §3  the rule's rows: parked; 4.9 against 5.1 mi; the speed-only fallback; the
//       days with no ELD data at all, each Confirmed as "Confirmed (no ELD
//       data)" (no truck held, no device linked, a device that never reported,
//       no reading before or after the silence; the owner's correction of
//       2026-10-31); ELD data that conflicts stays Requested (the truck changed
//       hands); a handover day; a relief driver; a team truck; a Central
//       midnight; a DST day; the rule version
//   §4  dark stretches: a 7 h stretch carrying 200 mi; the lead-in step; a 0 mi
//       odometer step with the ends 200 km apart; 0 mi, 0.3 km and +4 engine
//       hours; a moving dark tail; a 5 h unplugged drive; 40 against 25 minutes;
//       engine hours only when both ends read over 0; both floors
//   §5  continuity: the swap shape, a decrease, an odometer reset and rate, the
//       7-day window, the steps out of d
//   §6  long dark spells: a 21-day vacation waits, then confirms with the first
//       fix after 1.5 km away while moving; one that moved; a 40-day-old fix
//   §7  his own app activity, the account check skipped, a late-evening tap
//   §8  the Not-confirmed explanation
//   §9  the freeze and the 06:00 schedule
//   §10 notices (one, plus at most one follow-up) and what counts as a change
//   §11 the notice and audit text
//   §12 the staff view: closed months, kept-90-days text, load ids, summary
// Run: node scripts/test-time-off-eld-check.js

"use strict";

let T = null;
try {
	T = require("../lib/time-off-eld-check");
} catch (err) {
	console.log(`  FAIL  lib/time-off-eld-check.js loads — ${String(err && err.message).split("\n")[0]}`);
	console.log("\ntest-time-off-eld-check: 0 passed, 1 failed");
	process.exit(1);
}
const appTime = require("../lib/app-time");
const eldMiles = require("../lib/eld-miles");
const { shiftAvailabilityDay } = require("../lib/driver-availability");

let passed = 0;
const failures = [];
const ok = (name, cond, detail) => {
	if (cond) { passed++; return true; }
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
	console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	return false;
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const section = (t) => console.log(`\n── ${t}`);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CT = "America/Chicago";
const PT = "America/Los_Angeles";
// A wall clock on `day` in `zone` -> epoch ms.
const at = (day, hh = 0, mm = 0, zone = CT) => {
	const [y, m, d] = day.split("-").map(Number);
	return appTime.wallClockToMs(zone, y, m, d, hh, mm, 0);
};
const YARD = { lat: 29.7, lng: -95.4 };
// Metres north of the yard as a latitude (1 degree is about 111,195 m).
const north = (m) => YARD.lat + m / 111195;
const fix = (ms, o = {}) => ({
	ms, odo: o.odo ?? 100000, eh: o.eh ?? 5000, lat: o.lat ?? YARD.lat, lng: o.lng ?? YARD.lng, speed: o.speed ?? 0, source: o.source ?? "routemate",
});
// A fix every `stepMin` minutes from fromMs through toMs, shaped by shape(ms, i).
const pings = (fromMs, toMs, stepMin, shape = () => ({})) => {
	const out = [];
	for (let ms = fromMs, i = 0; ms <= toMs; ms += stepMin * MIN, i++) out.push(fix(ms, shape(ms, i)));
	return out;
};
// `list` with a parked fix a day before its first and a day after its last, so
// every stretch the case is not about closes with no movement.
const bracketed = (list, { before = 1 * DAY, after = 1 * DAY } = {}) => {
	const f = list[0];
	const l = list[list.length - 1];
	return [fix(f.ms - before, { odo: f.odo, eh: f.eh, lat: f.lat, lng: f.lng }), ...list, fix(l.ms + after, { odo: l.odo, eh: l.eh, lat: l.lat, lng: l.lng })];
};

const normalize = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const HOLLIS = "hollis renner";
const asg = (truckId, name, start, end = "") => ({ truck_id: truckId, driver_name: name, start_date: start, end_date: end });
const HIS_T1 = asg(11, "Hollis Renner", "2026-01-05T15:00:00.000Z");
function evidence(o = {}) {
	return {
		assignments: o.assignments || [HIS_T1],
		deviceRows: o.deviceRows || [],
		deviceStartMs: o.deviceStartMs ?? null,
		currentLinks: o.currentLinks || [{ id: 11, routemate_vehicle_id: "vid-t1" }, { id: 12, routemate_vehicle_id: "vid-t2" }],
		units: o.units || { 11: "T1", 12: "T2" },
		series: o.series || { "vid-t1": { before: null, fixes: o.fixes || [], after: null } },
		taps: o.taps === undefined ? [] : o.taps,
		activityNote: o.activityNote || "",
	};
}
// Verdicts for `days`, judged at nowMs (default: noon on the 20th of the first day's month).
const judge = (days, o = {}) => T.judgeTimeOffDays({
	days, anchorOf: o.anchorOf || (() => days[0]), driverKey: o.driverKey || HOLLIS, normalize,
	evidence: evidence(o), nowMs: o.nowMs ?? at(`${days[0].slice(0, 7)}-20`, 12),
});
const sr = (map, day) => { const x = map.get(day); return x ? [x.state, x.reason] : null; };
const range = (from, to) => { const out = []; for (let d = from; d <= to; d = shiftAvailabilityDay(d, 1)) out.push(d); return out; };

section("§1 the constants (B1)");
{
	const R = T.TIME_OFF_ELD_RULE;
	eq("§1.1 rule version 1", R.version, 1);
	eq("§1.2 a dark stretch is a silence over 30 minutes", R.darkStretchMs, 30 * MIN);
	eq("§1.3 the floor is the miles walk's own 5 mi, for the odometer and for positions (no 1 km test)", [R.moveFloorMi, eldMiles.ELD_DELTA_FLOOR_MI, Math.round(R.moveFloorMeters)], [5, 5, 8047]);
	eq("§1.4 engine hours over 1 h", R.engineRanHours, 1);
	eq("§1.5 ELD_MAX_GAP_MS stays 6 h for the miles walk", eldMiles.ELD_MAX_GAP_MS, 6 * HOUR);
	eq("§1.6 the speed-only fallback: 3 fixes over 2.235 m/s spanning 5 minutes", [R.speedOnlyPings, R.movingSpeedMps, R.speedOnlySpanMs], [3, 2.235, 5 * MIN]);
	eq("§1.7 continuity reaches 7 days back; final at d + 3; results kept 90 days; the run from 06:00", [R.continuityDays, R.finalAfterDays, R.resultKeepDays, R.runHour], [7, 3, 90, 6]);
}

section("§2 his holding and device intervals");
{
	const iv = T.effectiveIntervals((ms) => (ms < 100 ? "a" : ms < 200 ? "b" : "a"), [100, 200, 150], 0, 300);
	eq("§2.1 constant between breakpoints, equal neighbours joined", iv.map((x) => [x.value, x.fromMs, x.toMs]), [["a", 0, 100], ["b", 100, 200], ["a", 200, 300]]);
	const open = T.effectiveIntervals(() => "x", [50], 0, Infinity);
	eq("§2.2 an open end", open.map((x) => [x.value, x.fromMs, x.toMs]), [["x", 0, Infinity]]);
	const ctx = (assignments, o = {}) => T.timeOffDriverContexts({
		driverKey: HOLLIS, normalize, assignments, deviceRows: o.deviceRows || [], deviceStartMs: o.deviceStartMs ?? null,
		currentLinks: o.currentLinks || [{ id: 11, routemate_vehicle_id: "vid-t1" }], fromMs: at("2026-09-01"),
	}).contexts.map((c) => [c.truckId, c.vid, c.fromMs, c.toMs]);
	const noon5 = Date.parse("2026-10-05T17:00:00.000Z");
	eq("§2.3 a handover: his interval ends where Soren's starts", ctx([asg(11, "Hollis Renner", "2026-08-01T12:00:00.000Z", "2026-10-05T17:00:00.000Z"), asg(11, "Soren King", "2026-10-05T17:00:00.000Z")]),
		[[11, "vid-t1", at("2026-09-01"), noon5]]);
	const reliefFrom = Date.parse("2026-10-04T14:00:00.000Z");
	const reliefTo = Date.parse("2026-10-10T14:00:00.000Z");
	eq("§2.4 a relief driver's newer row covers his days off: two intervals around it", ctx([HIS_T1, asg(11, "Soren King", "2026-10-04T14:00:00.000Z", "2026-10-10T14:00:00.000Z")]),
		[[11, "vid-t1", at("2026-09-01"), reliefFrom], [11, "vid-t1", reliefTo, Infinity]]);
	eq("§2.5 a team truck: the newer open row wins (Soren's), so he holds nothing", ctx([HIS_T1, asg(11, "Soren King", "2026-09-01T14:00:00.000Z")]),
		[[11, "vid-t1", at("2026-09-01"), Date.parse("2026-09-01T14:00:00.000Z")]]);
	const relink = Date.parse("2026-10-06T15:00:00.000Z");
	eq("§2.6 a device re-linked mid-row: one interval per device", ctx([HIS_T1], {
		deviceStartMs: Date.parse("2026-08-01T00:00:00.000Z"),
		deviceRows: [
			{ truck_id: 11, routemate_vehicle_id: "vid-t1", assigned_from: "2026-08-01T00:00:00.000Z", assigned_until: "2026-10-06T15:00:00.000Z" },
			{ truck_id: 11, routemate_vehicle_id: "vid-t9", assigned_from: "2026-10-06T15:00:00.000Z", assigned_until: "" },
		],
		currentLinks: [{ id: 11, routemate_vehicle_id: "vid-t9" }],
	}), [[11, "vid-t1", at("2026-09-01"), relink], [11, "vid-t9", relink, Infinity]]);
}

section("§3 the rule's rows");
{
	// Parked: a fix every 15 minutes, no movement.
	const parked = pings(at("2026-10-04", 18), at("2026-10-07", 8), 15);
	const r1 = judge(["2026-10-05", "2026-10-06"], { fixes: parked });
	eq("§3.1 parked with pings: Confirmed (parked) both days", [sr(r1, "2026-10-05"), sr(r1, "2026-10-06")], [["confirmed", "parked"], ["confirmed", "parked"]]);
	eq("§3.1b ...with no miles, its samples counted", [r1.get("2026-10-05").miles, r1.get("2026-10-05").samples], [0, 96]);

	// 4.9 against 5.1 accepted miles on the day.
	const drive = (stepMi, steps) => bracketed(pings(at("2026-10-05", 8), at("2026-10-05", 8) + steps * 10 * MIN, 10, (ms, i) => ({ odo: 100000 + i * stepMi })));
	const r49 = judge(["2026-10-05"], { fixes: drive(0.7, 7) });
	const r51 = judge(["2026-10-05"], { fixes: drive(0.85, 6) });
	eq("§3.2 4.9 mi on the day: Confirmed", [sr(r49, "2026-10-05"), r49.get("2026-10-05").miles], [["confirmed", "parked"], 4.9]);
	eq("§3.3 5.1 mi on the day: Not confirmed (truck_moved)", [sr(r51, "2026-10-05"), r51.get("2026-10-05").miles], [["not_confirmed", "truck_moved"], 5.1]);
	const r504 = judge(["2026-10-05"], { fixes: drive(0.84, 6) });
	eq("§3.3b 5.04 mi, shown as 5.0: Confirmed", [sr(r504, "2026-10-05"), r504.get("2026-10-05").miles], [["confirmed", "parked"], 5]);

	// No odometer: the speed-only fallback.
	const speedy = (moving) => bracketed(pings(at("2026-10-05", 8), at("2026-10-05", 9), 3, (ms, i) => ({ odo: 0, speed: moving(i) ? 12 : 0 })));
	eq("§3.4 no odometer, 3 moving fixes over 6 minutes: Not confirmed (truck_moved)", sr(judge(["2026-10-05"], { fixes: speedy((i) => i >= 2 && i <= 4) }), "2026-10-05"), ["not_confirmed", "truck_moved"]);
	eq("§3.5 ...2 moving fixes: Confirmed", sr(judge(["2026-10-05"], { fixes: speedy((i) => i === 2 || i === 4) }), "2026-10-05"), ["confirmed", "parked"]);
	eq("§3.6 ...3 moving fixes over 4 minutes (2 apart each): Confirmed",
		sr(judge(["2026-10-05"], { fixes: bracketed(pings(at("2026-10-05", 8), at("2026-10-05", 9), 2, (ms, i) => ({ odo: 0, speed: i >= 2 && i <= 4 ? 12 : 0 }))) }), "2026-10-05"), ["confirmed", "parked"]);

	// No ELD data at all: Confirmed, labelled "Confirmed (no ELD data)", each shape its own reason.
	const noData = (map, day) => { const x = map.get(day); return x ? [x.state, x.reason, x.noEldData, T.timeOffDayLabel(x.state, x.reason)] : null; };
	eq("§3.7 no truck held: Confirmed (no ELD data), no_truck", noData(judge(["2026-10-05"], { assignments: [asg(11, "Soren King", "2026-01-05T15:00:00.000Z")], fixes: parked }), "2026-10-05"),
		["confirmed", "no_truck", true, "Confirmed (no ELD data)"]);
	eq("§3.8 no device linked to his truck: Confirmed (no ELD data), no_device", noData(judge(["2026-10-05"], { currentLinks: [], series: {} }), "2026-10-05"),
		["confirmed", "no_device", true, "Confirmed (no ELD data)"]);
	eq("§3.9 a device that never reported: Confirmed (no ELD data), device_never_reported", noData(judge(["2026-10-05"], { series: { "vid-t1": { before: null, fixes: [], after: null } } }), "2026-10-05"),
		["confirmed", "device_never_reported", true, "Confirmed (no ELD data)"]);
	// The device's first fix ever comes on Oct 7: Oct 5 and 6 lie in a silence with no reading before it.
	const firstEver = pings(at("2026-10-07", 9), at("2026-10-07", 18), 15, (ms) => ({ lat: north(300000) }));
	const rf = judge(["2026-10-05", "2026-10-06"], { fixes: firstEver });
	eq("§3.9b no reading before the silence: Confirmed (no ELD data), no_fix_before, even though the first fix is 300 km off",
		[noData(rf, "2026-10-05"), noData(rf, "2026-10-06")], [["confirmed", "no_fix_before", true, "Confirmed (no ELD data)"], ["confirmed", "no_fix_before", true, "Confirmed (no ELD data)"]]);
	// The device is moved to T2 on Oct 6 while T1 is dark: T1's silence has no reading after it on T1.
	const moveAt = Date.parse("2026-10-06T15:00:00.000Z");
	const rmv = judge(["2026-10-05", "2026-10-06", "2026-10-07"], {
		deviceStartMs: Date.parse("2026-01-01T00:00:00.000Z"),
		deviceRows: [
			{ truck_id: 11, routemate_vehicle_id: "vid-t1", assigned_from: "2026-01-01T00:00:00.000Z", assigned_until: "2026-10-06T15:00:00.000Z" },
			{ truck_id: 12, routemate_vehicle_id: "vid-t1", assigned_from: "2026-10-06T15:00:00.000Z", assigned_until: "" },
		],
		currentLinks: [{ id: 12, routemate_vehicle_id: "vid-t1" }],
		fixes: [...pings(at("2026-10-04", 8), at("2026-10-04", 18), 15), ...pings(moveAt + HOUR, moveAt + 10 * HOUR, 15, () => ({ lat: north(300000) }))],
	});
	eq("§3.9c the device moved to another truck before it reported again: Confirmed (no ELD data), no_fix_after; then no device",
		[noData(rmv, "2026-10-05"), noData(rmv, "2026-10-07")], [["confirmed", "no_fix_after", true, "Confirmed (no ELD data)"], ["confirmed", "no_device", true, "Confirmed (no ELD data)"]]);
	// ELD data that conflicts stays Requested: he takes over T1 while it is dark,
	// after Soren had it, so its silence can't be put on him alone.
	const takeover = [asg(11, "Soren King", "2026-01-05T15:00:00.000Z", "2026-10-05T15:00:00.000Z"), asg(11, "Hollis Renner", "2026-10-05T15:00:00.000Z")];
	const rto = judge(["2026-10-05"], { assignments: takeover, fixes: [fix(at("2026-10-04", 18)), fix(at("2026-10-06", 8))] });
	eq("§3.9d the truck changed hands while its ELD was dark: Requested (shared_truck), not the no-data label", noData(rto, "2026-10-05"), ["no_data", "shared_truck", false, "Requested"]);
	// Part of the day judged parked and part with no reading before: Confirmed on what was read.
	const partly = judge(["2026-10-07"], { fixes: [...firstEver, fix(at("2026-10-08", 9), { lat: north(300000) })] });
	eq("§3.9e a day with readings and a part with none before them: Confirmed (parked), the ordinary label", noData(partly, "2026-10-07"), ["confirmed", "parked", false, "Confirmed"]);

	// A handover at noon on Oct 5: his morning parked, Soren drives the afternoon.
	const handover = asg(11, "Hollis Renner", "2026-01-05T15:00:00.000Z", "2026-10-05T17:00:00.000Z");
	const afternoon = pings(at("2026-10-04", 18), at("2026-10-06", 8), 10, (ms) => ({ odo: ms > at("2026-10-05", 12, 30) ? 100000 + (ms - at("2026-10-05", 12, 30)) / (10 * MIN) * 4 : 100000 }));
	const rh = judge(["2026-10-05", "2026-10-06"], { assignments: [handover, asg(11, "Soren King", "2026-10-05T17:00:00.000Z")], fixes: afternoon });
	eq("§3.10 a handover day: judged on his part only (parked), and the next day he holds no truck (no ELD data)", [sr(rh, "2026-10-05"), sr(rh, "2026-10-06")], [["confirmed", "parked"], ["confirmed", "no_truck"]]);
	const relief = judge(range("2026-10-05", "2026-10-09"), { assignments: [HIS_T1, asg(11, "Soren King", "2026-10-04T14:00:00.000Z", "2026-10-10T14:00:00.000Z")], fixes: pings(at("2026-10-04"), at("2026-10-10"), 20, (ms, i) => ({ odo: 100000 + i * 3 })) });
	eq("§3.11 a relief driver holds his truck: every day no truck held (Confirmed, no ELD data), never the relief's movement", range("2026-10-05", "2026-10-09").map((d) => sr(relief, d)), range("2026-10-05", "2026-10-09").map(() => ["confirmed", "no_truck"]));
	eq("§3.12 a team truck where Soren's row is newer: no truck held (Confirmed, no ELD data)", sr(judge(["2026-10-05"], { assignments: [HIS_T1, asg(11, "Soren King", "2026-09-01T14:00:00.000Z")], fixes: parked }), "2026-10-05"), ["confirmed", "no_truck"]);
	eq("§3.13 ...and where his row is newer: judged on the pings (Confirmed)", sr(judge(["2026-10-05"], { assignments: [asg(11, "Soren King", "2026-01-01T14:00:00.000Z"), asg(11, "Hollis Renner", "2026-09-01T14:00:00.000Z")], fixes: parked }), "2026-10-05"), ["confirmed", "parked"]);

	// A Central midnight: he drives until 11:50 PM CDT on Oct 5 (12:50 AM EDT on
	// Oct 6), then parks. Oct 6 is his day off, on the truck's own day.
	const lateDrive = pings(at("2026-10-05", 18), at("2026-10-06", 23), 10, (ms) => ({ odo: 100000 + Math.min(ms, at("2026-10-05", 23, 50)) / (10 * MIN) * 3 - at("2026-10-05", 18) / (10 * MIN) * 3, speed: ms <= at("2026-10-05", 23, 50) ? 20 : 0 }));
	const rm = judge(["2026-10-05", "2026-10-06"], { fixes: bracketed(lateDrive) });
	eq("§3.14 a Central midnight: the late miles stay on Oct 5 (truck_moved); Oct 6 is Confirmed", [sr(rm, "2026-10-05"), sr(rm, "2026-10-06")], [["not_confirmed", "truck_moved"], ["confirmed", "parked"]]);
	eq("§3.14b ...though in Eastern the last hour is already Oct 6", appTime.dayInZone(new Date(at("2026-10-05", 23, 30)), "America/New_York"), "2026-10-06");

	// A DST day: Nov 1, 2026 has 25 hours in Central.
	const dst = pings(at("2026-10-31", 12), at("2026-11-02", 12), 30);
	const rd = judge(["2026-10-31", "2026-11-01", "2026-11-02"], { fixes: dst, nowMs: at("2026-11-20", 12) });
	eq("§3.15 a DST day parked with a fix every 30 minutes: Confirmed, all 50 fixes on it", [sr(rd, "2026-11-01"), rd.get("2026-11-01").samples], [["confirmed", "parked"], 50]);
	const dstDark = [fix(at("2026-10-31", 22)), fix(at("2026-11-02", 6), { lat: north(200000) })];
	const rdd = judge(["2026-10-31", "2026-11-01", "2026-11-02"], { fixes: dstDark, nowMs: at("2026-11-20", 12) });
	eq("§3.16 a dark stretch across the DST day that moved: all three days moved_while_dark", ["2026-10-31", "2026-11-01", "2026-11-02"].map((d) => sr(rdd, d)), [["not_confirmed", "moved_while_dark"], ["not_confirmed", "moved_while_dark"], ["not_confirmed", "moved_while_dark"]]);
	eq("§3.17 the rule version is on every verdict", r1.get("2026-10-05").ruleVersion, 1);
}

section("§4 dark stretches (M2, B1)");
{
	// Pings Oct 5 morning, dark 10:00-17:00 carrying 200 odometer miles, pings after.
	const sevenHours = [
		...pings(at("2026-10-05", 6), at("2026-10-05", 10), 10),
		...pings(at("2026-10-05", 17), at("2026-10-05", 22), 10, () => ({ odo: 100200 })),
	];
	const r1 = judge(["2026-10-05"], { fixes: bracketed(sevenHours) });
	eq("§4.1 a 7 h dark stretch carrying a 200 mi odometer step: moved_while_dark, not parked", sr(r1, "2026-10-05"), ["not_confirmed", "moved_while_dark"]);
	// The lead-in: parked the evening before at the yard, first fix of Oct 5 200 mi on.
	const leadIn = [fix(at("2026-10-04", 18)), ...pings(at("2026-10-05", 9), at("2026-10-05", 20), 15, () => ({ odo: 100200, lat: north(300000) }))];
	eq("§4.2 the lead-in step counts: Oct 5 moved_while_dark", sr(judge(["2026-10-05"], { fixes: bracketed(leadIn) }), "2026-10-05"), ["not_confirmed", "moved_while_dark"]);
	const odoStill = [...pings(at("2026-10-05", 6), at("2026-10-05", 8), 10), ...pings(at("2026-10-05", 18), at("2026-10-05", 22), 10, () => ({ lat: north(200000) }))];
	eq("§4.3 a 0 mi odometer step with the ends 200 km apart (a device-kept odometer): moved_while_dark", sr(judge(["2026-10-05"], { fixes: bracketed(odoStill) }), "2026-10-05"), ["not_confirmed", "moved_while_dark"]);
	const idled = [...pings(at("2026-10-05", 6), at("2026-10-05", 8), 10), ...pings(at("2026-10-05", 18), at("2026-10-05", 22), 10, () => ({ lat: north(300), eh: 5004 }))];
	eq("§4.4 0 mi, 0.3 km and engine hours +4 h: Requested (engine_ran_while_dark)", sr(judge(["2026-10-05"], { fixes: bracketed(idled) }), "2026-10-05"), ["no_data", "engine_ran_while_dark"]);
	// A dark tail: last fix Oct 5 10:00, next fix Oct 9 08:00 300 km away.
	const tail = [...pings(at("2026-10-05", 6), at("2026-10-05", 10), 10), ...pings(at("2026-10-09", 8), at("2026-10-09", 12), 10, () => ({ lat: north(300000), odo: 100190 }))];
	const rt = judge(range("2026-10-05", "2026-10-09"), { fixes: bracketed(tail) });
	eq("§4.5 a dark tail whose stretch moved: that day and every later day it touches moved_while_dark", range("2026-10-05", "2026-10-09").map((d) => sr(rt, d)), range("2026-10-05", "2026-10-09").map(() => ["not_confirmed", "moved_while_dark"]));
	// B1: a 5 h unplugged drive: 0 mi odometer step, ends far apart, engine hours +5 h.
	const unplugged = [...pings(at("2026-10-05", 6), at("2026-10-05", 8), 10), ...pings(at("2026-10-05", 13, 10), at("2026-10-05", 20), 10, () => ({ lat: north(300000), eh: 5005 }))];
	const ru = judge(["2026-10-05"], { fixes: bracketed(unplugged) });
	eq("§4.6 B1: a 5 h unplugged drive (0 mi odometer step, ends far apart, engine hours +5 h): Not confirmed", sr(ru, "2026-10-05"), ["not_confirmed", "moved_while_dark"]);
	ok("§4.6b ...and no continuity break (+5 h over 5 h 10 min is possible)", ru.get("2026-10-05").changeMs === null);
	// B1: 40 minutes is a dark stretch; 25 minutes is a normal step, judged by the odometer.
	const jump = (gapMin) => bracketed([fix(at("2026-10-05", 9)), fix(at("2026-10-05", 9) + gapMin * MIN, { lat: north(20000) }), ...pings(at("2026-10-05", 10), at("2026-10-05", 12), 10, () => ({ lat: north(20000) }))]);
	eq("§4.7 B1: a 40-minute silence is a dark stretch: 20 km apart moved_while_dark", sr(judge(["2026-10-05"], { fixes: jump(40) }), "2026-10-05"), ["not_confirmed", "moved_while_dark"]);
	eq("§4.8 ...a 25-minute step is a normal step: the odometer (0 mi) decides, Confirmed", sr(judge(["2026-10-05"], { fixes: jump(25) }), "2026-10-05"), ["confirmed", "parked"]);
	// N-L4: engine hours read 0 at one end.
	const zeroEnd = [fix(at("2026-10-05", 6), { eh: 0 }), fix(at("2026-10-05", 20), { eh: 900 })];
	eq("§4.9 N-L4: an engine-hours reading of 0 at one end is not an advance", sr(judge(["2026-10-05"], { fixes: bracketed(zeroEnd) }), "2026-10-05"), ["confirmed", "parked"]);
	const dark = (b) => bracketed([fix(at("2026-10-05", 6)), fix(at("2026-10-05", 20), b)]);
	eq("§4.10 positions 7.9 km apart: parked; 8.1 km: moved", [sr(judge(["2026-10-05"], { fixes: dark({ lat: north(7900) }) }), "2026-10-05"), sr(judge(["2026-10-05"], { fixes: dark({ lat: north(8100) }) }), "2026-10-05")], [["confirmed", "parked"], ["not_confirmed", "moved_while_dark"]]);
	eq("§4.11 an odometer step of 5.0 mi: parked; 5.1: moved", [sr(judge(["2026-10-05"], { fixes: dark({ odo: 100005 }) }), "2026-10-05"), sr(judge(["2026-10-05"], { fixes: dark({ odo: 100005.1 }) }), "2026-10-05")], [["confirmed", "parked"], ["not_confirmed", "moved_while_dark"]]);
	eq("§4.12 engine hours +0.9: parked; +1.1: engine_ran_while_dark", [sr(judge(["2026-10-05"], { fixes: dark({ eh: 5000.9 }) }), "2026-10-05"), sr(judge(["2026-10-05"], { fixes: dark({ eh: 5001.1 }) }), "2026-10-05")], [["confirmed", "parked"], ["no_data", "engine_ran_while_dark"]]);
	const st = judge(["2026-10-05"], { fixes: dark({ lat: north(1500), odo: 100000.9, eh: 5000.2, speed: 12 }) }).get("2026-10-05").stretches;
	ok("§4.13 a stretch's measures are kept for the report (odometer step, distance, engine advance, moving at the after-fix)",
		st.some((s) => Math.abs(s.odoStepMi - 0.9) < 1e-6 && Math.abs(s.distanceM - 1500) < 5 && Math.abs(s.engineAdvanceH - 0.2) < 1e-6 && s.afterMoving === true), JSON.stringify(st));
}

section("§5 continuity (3b2)");
{
	// The swap shape on T1: engine hours 1,000 h, a 5 h gap at the yard, then
	// 20,000 h; the odometer continues exactly. Oct 4, inside the 7 days.
	const swap = [
		...pings(at("2026-10-04", 6), at("2026-10-04", 10), 10, () => ({ eh: 1000 })),
		...pings(at("2026-10-04", 15), at("2026-10-06", 8), 10, (ms) => ({ eh: 20000, odo: 100000 + 3 * Math.min(36, Math.max(0, (ms - at("2026-10-06", 0)) / (10 * MIN))) })),
	];
	const rs = judge(range("2026-10-05", "2026-10-06"), { fixes: bracketed(swap), anchorOf: () => "2026-10-05" });
	eq("§5.1 the swap shape: every day Requested (device_changed_vehicle)", [sr(rs, "2026-10-05"), sr(rs, "2026-10-06")], [["no_data", "device_changed_vehicle"], ["no_data", "device_changed_vehicle"]]);
	eq("§5.2 ...its change instant is the first reading after the gap", rs.get("2026-10-05").changeMs, at("2026-10-04", 15));
	ok("§5.3 ...and it beats the 100 mi Oct 6 would read as truck_moved", rs.get("2026-10-06").miles >= 100, String(rs.get("2026-10-06").miles));
	const down = bracketed([...pings(at("2026-10-05", 6), at("2026-10-05", 7), 10), ...pings(at("2026-10-05", 7, 10), at("2026-10-05", 9), 10, () => ({ eh: 4990 }))]);
	eq("§5.4 engine hours down 10 h: device_changed_vehicle", sr(judge(["2026-10-05"], { fixes: down }), "2026-10-05"), ["no_data", "device_changed_vehicle"]);
	const reset = bracketed([...pings(at("2026-10-05", 6), at("2026-10-05", 7), 10), ...pings(at("2026-10-05", 7, 10), at("2026-10-05", 9), 10, () => ({ odo: 50 }))]);
	eq("§5.5 an odometer reset: device_changed_vehicle", sr(judge(["2026-10-05"], { fixes: reset }), "2026-10-05"), ["no_data", "device_changed_vehicle"]);
	const rate = bracketed([...pings(at("2026-10-05", 6), at("2026-10-05", 7), 10), ...pings(at("2026-10-05", 8), at("2026-10-05", 9), 10, () => ({ odo: 100300 }))]);
	eq("§5.6 an odometer rate (300 mi in an hour): device_changed_vehicle", sr(judge(["2026-10-05"], { fixes: rate }), "2026-10-05"), ["no_data", "device_changed_vehicle"]);
	// The window: the row starts Oct 10; a break on Oct 3 (7 days before), Oct 4
	// (6) counts; one on Oct 2 (8) does not.
	const breakOn = (day) => bracketed([
		...pings(at(day, 6), at(day, 7), 10, () => ({ eh: 1000 })),
		...pings(at(day, 8), at("2026-10-12", 8), 30, () => ({ eh: 20000 })),
	]);
	const rowDays = ["2026-10-10", "2026-10-11"];
	const win = (day) => sr(judge(rowDays, { fixes: breakOn(day), anchorOf: () => "2026-10-10" }), "2026-10-10");
	eq("§5.7 a break 6 days before the row counts, 7 days counts, 8 days does not", [win("2026-10-04"), win("2026-10-03"), win("2026-10-02")],
		[["no_data", "device_changed_vehicle"], ["no_data", "device_changed_vehicle"], ["confirmed", "parked"]]);
	// A break after d counts from its day on, never before it.
	const later = bracketed([...pings(at("2026-10-09", 12), at("2026-10-11", 9), 30, () => ({ eh: 1000 })), ...pings(at("2026-10-11", 10), at("2026-10-12", 20), 30, () => ({ eh: 20000 }))]);
	const rl = judge(["2026-10-10", "2026-10-11", "2026-10-12"], { fixes: later, anchorOf: () => "2026-10-10" });
	eq("§5.8 a break on Oct 11: Oct 10 Confirmed, Oct 11 and 12 device_changed_vehicle", ["2026-10-10", "2026-10-11", "2026-10-12"].map((d) => sr(rl, d)),
		[["confirmed", "parked"], ["no_data", "device_changed_vehicle"], ["no_data", "device_changed_vehicle"]]);
	// The step out of d: a dark stretch from the evening of Oct 10 whose after-fix reads another engine.
	const outOf = bracketed([...pings(at("2026-10-10", 6), at("2026-10-10", 19), 30, () => ({ eh: 1000 })), ...pings(at("2026-10-11", 6), at("2026-10-11", 9), 30, () => ({ eh: 20000 }))]);
	eq("§5.9 the step out of d counts (both brackets): Oct 10 device_changed_vehicle", sr(judge(["2026-10-10"], { fixes: outOf }), "2026-10-10"), ["no_data", "device_changed_vehicle"]);
	const linx = bracketed(pings(at("2026-10-05", 6), at("2026-10-05", 9), 10, (ms, i) => ({ eh: 0, source: "linxup", odo: 0 })));
	eq("§5.10 Linxup readings (engine hours 0) never break on engine hours", sr(judge(["2026-10-05"], { fixes: linx }), "2026-10-05"), ["confirmed", "parked"]);
	const brk = T.continuityBreaks([fix(1000, { eh: 1000 }), fix(1000 + 5 * HOUR, { eh: 20000 })]);
	eq("§5.11 continuityBreaks() names the break", brk.map((b) => [b.kind, b.ms]), [["engine_hours", 1000 + 5 * HOUR]]);
}

section("§6 long dark spells (M3, B1)");
{
	const days = range("2026-06-01", "2026-06-21");
	const before = fix(at("2026-05-31", 19));
	const waiting = judge(range("2026-06-01", "2026-06-14"), { fixes: [before], nowMs: at("2026-06-15", 6) });
	eq("§6.1 a 21-day dark vacation reads Checking (dark_waiting) until the ELD reports again", range("2026-06-01", "2026-06-14").every((d) => JSON.stringify(sr(waiting, d)) === JSON.stringify(["pending", "dark_waiting"])), true);
	// B1: the first fix after is 1.5 km away, moving, 0.9 odometer miles and 0.1 engine hours on.
	const back = fix(at("2026-06-22", 7, 30), { lat: north(1500), odo: 100000.9, eh: 5000.1, speed: 12 });
	const done = judge(days, { fixes: [before, back], nowMs: at("2026-06-23", 6) });
	eq("§6.2 B1: the first fix after 1.5 km away while moving: all 21 days Confirmed (dark_parked)", days.map((d) => sr(done, d)), days.map(() => ["confirmed", "dark_parked"]));
	ok("§6.2b ...each a dark-spell day (no fix on it)", days.every((d) => done.get(d).darkSpell === true));
	const moved = judge(days, { fixes: [before, fix(at("2026-06-22", 7, 30), { lat: north(300000), odo: 100190 })], nowMs: at("2026-06-23", 6) });
	eq("§6.3 ...reporting 300 km away instead: all 21 days Not confirmed (moved_while_dark)", days.map((d) => sr(moved, d)), days.map(() => ["not_confirmed", "moved_while_dark"]));
	const old = judge(["2026-06-10", "2026-06-11"], { fixes: [fix(at("2026-05-01", 19)), fix(at("2026-06-12", 7))], nowMs: at("2026-06-13", 6) });
	eq("§6.4 a before-fix 40 days old still anchors: Confirmed", [sr(old, "2026-06-10"), sr(old, "2026-06-11")], [["confirmed", "dark_parked"], ["confirmed", "dark_parked"]]);
}

section("§7 check 1: his own app activity");
{
	const parked = pings(at("2026-10-04", 18), at("2026-10-07", 8), 15);
	const tap = at("2026-10-05", 15, 12, "America/New_York");
	const r = judge(["2026-10-05", "2026-10-06"], { fixes: parked, taps: [tap, tap + 2 * HOUR] });
	eq("§7.1 his own status update on Oct 5: Not confirmed (app_activity), with its first and last times", [sr(r, "2026-10-05"), r.get("2026-10-05").activityFirstMs, r.get("2026-10-05").activityLastMs, sr(r, "2026-10-06")],
		[["not_confirmed", "app_activity"], tap, tap + 2 * HOUR, ["confirmed", "parked"]]);
	const swap = bracketed([...pings(at("2026-10-04", 6), at("2026-10-04", 10), 10, () => ({ eh: 1000 })), ...pings(at("2026-10-04", 15), at("2026-10-06", 8), 10, () => ({ eh: 20000 }))]);
	eq("§7.2 ...it beats a device that changed vehicle", sr(judge(["2026-10-05"], { fixes: swap, taps: [tap] }), "2026-10-05"), ["not_confirmed", "app_activity"]);
	const skipped = judge(["2026-10-05"], { fixes: parked, taps: null, activityNote: "ambiguous" });
	eq("§7.3 no single Driver account: the check is skipped and noted; the ELD decides", [sr(skipped, "2026-10-05"), skipped.get("2026-10-05").activityNote], [["confirmed", "parked"], "ambiguous"]);
	// The truck on the West coast: a tap at 10:30 PM PDT on Oct 5 is 1:30 AM EDT on Oct 6.
	const west = pings(at("2026-10-04", 18, 0, PT), at("2026-10-07", 8, 0, PT), 15, () => ({ lat: 34.05, lng: -118.25 }));
	const late = at("2026-10-05", 22, 30, PT);
	const rw = judge(["2026-10-05", "2026-10-06"], { fixes: west, taps: [late] });
	eq("§7.4 a tap at 10:30 PM on the truck's clock counts on that truck-local day (Oct 5), not Oct 6", [sr(rw, "2026-10-05"), sr(rw, "2026-10-06")], [["not_confirmed", "app_activity"], ["confirmed", "parked"]]);
}

section("§8 the Not-confirmed explanation");
{
	const conf = [{ id: 1, load_id: "7001", load_from: "2026-10-05", load_to: "2026-10-07", directory_name: "Hollis Renner" }];
	const loads = new Map([
		["7001", { loadId: "7001", driver: "Hollis Renner", truck: "T1", pickupKey: "2026-10-05", dropoffKey: "2026-10-07", cancelled: false }],
		["7002", { loadId: "7002", driver: "Hollis Renner", truck: "T1", pickupKey: "2026-10-09", dropoffKey: "2026-10-10", cancelled: false }],
		["7003", { loadId: "7003", driver: "Hollis Renner", truck: "T1", pickupKey: "", dropoffKey: "", cancelled: false }],
		["7004", { loadId: "7004", driver: "Soren King", truck: "T2", pickupKey: "2026-10-12", dropoffKey: "2026-10-12", cancelled: false }],
	]);
	const ex = (day, o = {}) => T.timeOffExplanation({ day, driverKey: HOLLIS, normalize, loadKey: (x) => String(x || "").trim().toLowerCase(), confirmations: o.confirmations ?? conf, loads: o.loads === undefined ? loads : o.loads });
	eq("§8.1 a standing \"Assign anyway\" covering the day: confirmed_load, with its load", ex("2026-10-06"), { explanation: "confirmed_load", loadIds: ["7001"] });
	eq("§8.2 a live load of his covering the day: own_load", ex("2026-10-09"), { explanation: "own_load", loadIds: ["7002"] });
	eq("§8.3 none: no_load (a load with no readable day never covers it; Soren's is not his)", [ex("2026-10-11"), ex("2026-10-12")], [{ explanation: "no_load", loadIds: [] }, { explanation: "no_load", loadIds: [] }]);
	eq("§8.4 Job Tracking unreadable: a confirmation stands as recorded; otherwise unknown", [ex("2026-10-06", { loads: null }), ex("2026-10-09", { loads: null })],
		[{ explanation: "confirmed_load", loadIds: ["7001"] }, { explanation: "", loadIds: [] }]);
	eq("§8.5 a confirmation whose load is now another driver's no longer stands", ex("2026-10-06", { loads: new Map([["7001", { loadId: "7001", driver: "Soren King", truck: "T2", pickupKey: "2026-10-05", dropoffKey: "2026-10-07", cancelled: false }]]) }),
		{ explanation: "no_load", loadIds: [] });
}

section("§9 the freeze and the schedule");
{
	const fin = (day, state, today) => T.isFinalTimeOffDay({ day, state, todayKey: today });
	eq("§9.1 final at the first run on or after d + 3, never while waiting", [fin("2026-10-05", "confirmed", "2026-10-07"), fin("2026-10-05", "confirmed", "2026-10-08"), fin("2026-10-05", "not_confirmed", "2026-10-30"), fin("2026-10-05", "pending", "2026-10-30")],
		[false, true, true, false]);
	const due = (hh, mm, lastDay, day = "2026-10-21") => T.timeOffCheckDue({ nowMs: at(day, hh, mm, "America/New_York"), timeZone: "America/New_York", lastDay });
	eq("§9.2 the run is due at or after 06:00 on the business clock, once a day", [due(5, 59, "2026-10-20").due, due(6, 0, "2026-10-20").due, due(23, 0, "2026-10-21").due, due(6, 0, null).due], [false, true, false, true]);
	eq("§9.3 a server down for days catches up at its next tick after 06:00", [due(9, 0, "2026-10-17").due, due(9, 0, "2026-10-17").day], [true, "2026-10-21"]);
	eq("§9.4 06:00 follows daylight time (EST on Nov 2)", [due(5, 59, "2026-11-01", "2026-11-02").due, due(6, 0, "2026-11-01", "2026-11-02").due], [false, true]);
}

section("§10 notices and changes (L3, L10)");
{
	const nd = (old, next) => T.timeOffNoticeDecision({ old, next });
	const nc = (o) => ({ state: "not_confirmed", reason: "truck_moved", explanation: "own_load", ...o });
	eq("§10.1 newly Not confirmed: one notice; with confirmed_load: none", [nd(null, nc()), nd(null, nc({ explanation: "confirmed_load" }))], [{ first: true, followup: false }, { first: false, followup: false }]);
	eq("§10.2 newly Requested because the device changed vehicle: one notice; any other Requested reason, Checking or a Confirmed day (no ELD data too): none",
		[nd(null, { state: "no_data", reason: "device_changed_vehicle" }), nd(null, { state: "no_data", reason: "shared_truck" }), nd(null, { state: "no_data", reason: "engine_ran_while_dark" }),
			nd(null, { state: "pending", reason: "dark_waiting" }), nd(null, { state: "confirmed", reason: "parked" }), nd(null, { state: "confirmed", reason: "no_truck" })],
		[{ first: true, followup: false }, { first: false, followup: false }, { first: false, followup: false }, { first: false, followup: false }, { first: false, followup: false }, { first: false, followup: false }]);
	const told = { state: "not_confirmed", notified_at: "2026-10-08T10:00:00.000Z", notified_state: "not_confirmed", followup_at: null };
	eq("§10.3 a notified Not-confirmed day that becomes Requested (a late break): one follow-up", nd(told, { state: "no_data", reason: "device_changed_vehicle" }), { first: false, followup: true });
	eq("§10.4 ...or no truck held after a staff fix (Confirmed, no ELD data): one follow-up", nd(told, { state: "confirmed", reason: "no_truck" }), { first: false, followup: true });
	eq("§10.5 never a third", nd({ ...told, state: "no_data", followup_at: "2026-10-09T10:00:00.000Z" }, nc()), { first: false, followup: false });
	eq("§10.6 unchanged after a notice: nothing", nd(told, nc()), { first: false, followup: false });
	const row = { state: "confirmed", reason: "parked", explanation: "", final_at: null, notified_at: null, notified_state: null, followup_at: null, evaluated_at: "a", evaluations: 1 };
	eq("§10.7 L10: evaluated_at and evaluations alone are no change; state, reason, explanation, final_at, notified_at and notified_state are",
		[T.timeOffDayChanged(row, { ...row, evaluated_at: "b", evaluations: 2 }), T.timeOffDayChanged(row, { ...row, state: "pending" }), T.timeOffDayChanged(row, { ...row, reason: "dark_parked" }),
			T.timeOffDayChanged(row, { ...row, explanation: "no_load" }), T.timeOffDayChanged(row, { ...row, final_at: "x" }), T.timeOffDayChanged(row, { ...row, notified_at: "x" }),
			T.timeOffDayChanged(row, { ...row, notified_state: "confirmed" }), T.timeOffDayChanged(null, row)],
		[false, true, true, true, true, true, true, true]);
}

section("§11 the notice and audit text");
{
	const tz = "America/New_York";
	const lineApp = T.timeOffNoticeLine({ verdict: { day: "2026-10-17", state: "not_confirmed", reason: "app_activity", activityFirstMs: at("2026-10-17", 15, 12, tz) }, units: ["T1"], timeZone: tz });
	const lineDev = T.timeOffNoticeLine({ verdict: { day: "2026-10-18", state: "no_data", reason: "device_changed_vehicle", changeMs: at("2026-10-16", 9, 0, tz) }, units: ["T1"], timeZone: tz });
	const lineMoved = T.timeOffNoticeLine({ verdict: { day: "2026-10-19", state: "not_confirmed", reason: "truck_moved", miles: 212.4, firstMoveMs: at("2026-10-19", 7, 5, tz), lastMoveMs: at("2026-10-19", 16, 40, tz) }, units: ["T1"], timeZone: tz });
	const lineUp = T.timeOffNoticeLine({ verdict: { day: "2026-10-18", state: "confirmed", reason: "no_truck" }, followup: true, units: [], timeZone: tz });
	eq("§11.1 the notice lines", [lineApp, lineDev, lineMoved, lineUp], [
		"Oct 17: his account updated a load's status at 3:12 PM EDT.",
		"Oct 18: the ELD on T1 may be in another vehicle since Oct 16 (a reading changed), so its days can't be checked from it.",
		"Oct 19: T1 moved 212.4 mi (first at 7:05 AM, last at 4:40 PM EDT).",
		"Update: Oct 18 now reads Confirmed (no ELD data): no truck on record.",
	]);
	const n = T.timeOffNoticeText({ driverName: "Hollis Renner", from: "2026-10-17", to: "2026-10-21", lines: [{ kind: "first", state: "not_confirmed", text: lineApp }, { kind: "first", state: "no_data", text: lineDev }] });
	eq("§11.2 the notice: title with the driver and his days, the lines as the body", [n.title, n.body], ["Time off not confirmed: Hollis Renner (Oct 17 – Oct 21)", `${lineApp} ${lineDev}`]);
	eq("§11.3 a follow-up only: \"Time off update\"", T.timeOffNoticeText({ driverName: "Hollis Renner", from: "2026-10-17", to: "2026-10-21", lines: [{ kind: "followup", state: "no_data", text: lineUp }] }).title, "Time off update: Hollis Renner (Oct 17 – Oct 21)");
	eq("§11.4 a device change only: \"Time off can't be checked\"", T.timeOffNoticeText({ driverName: "Hollis Renner", from: "2026-10-17", to: "2026-10-21", lines: [{ kind: "first", state: "no_data", text: lineDev }] }).title, "Time off can't be checked: Hollis Renner (Oct 17 – Oct 21)");
	const audit = T.timeOffAuditText({ from: "2026-10-17", to: "2026-10-21", days: [
		{ day: "2026-10-17", state: "not_confirmed", reason: "app_activity", explanation: "own_load", final: false, notified: true },
		{ day: "2026-10-18", state: "no_data", reason: "device_changed_vehicle", explanation: "", final: true, followup: true },
		{ day: "2026-10-19", state: "confirmed", reason: "parked", explanation: "", final: false, activityNote: "no_driver_account" },
		{ day: "2026-10-20", state: "confirmed", reason: "no_device", explanation: "", final: true },
	] });
	eq("§11.5 the audit line: each changed day's verdict, never miles, times or the time off's reason",
		audit, "off 2026-10-17..2026-10-21: 2026-10-17 not confirmed (app activity, own load), notified; 2026-10-18 requested (device changed vehicle), final, follow-up sent; 2026-10-19 confirmed (parked; app activity not checked: no driver account); 2026-10-20 confirmed with no ELD data (no device), final");
	eq("§11.6 labels", ["confirmed", "no_eld_data", "not_confirmed", "no_data", "pending", "upcoming", "not_checked", "purged"].map((s) => T.TIME_OFF_ELD_LABELS[s]),
		["Confirmed", "Confirmed (no ELD data)", "Not confirmed", "Requested", "Checking", "Requested", "Not checked (month closed)", "ELD results are kept 90 days"]);
	eq("§11.7 the label of a stored day: each no-data shape reads \"Confirmed (no ELD data)\"; parked, a conflict and a waiting day their own",
		[...T.TIME_OFF_NO_ELD_DATA.map((r) => T.timeOffDayLabel("confirmed", r)), T.timeOffDayLabel("confirmed", "dark_parked"), T.timeOffDayLabel("no_data", "shared_truck"), T.timeOffDayLabel("pending", "dark_waiting")],
		["Confirmed (no ELD data)", "Confirmed (no ELD data)", "Confirmed (no ELD data)", "Confirmed (no ELD data)", "Confirmed (no ELD data)", "Confirmed", "Requested", "Checking"]);
	eq("§11.8 the no-data shapes are exactly these five", T.TIME_OFF_NO_ELD_DATA, ["no_truck", "no_device", "device_never_reported", "no_fix_before", "no_fix_after"]);
}

section("§12 the staff view");
{
	const stored = new Map([
		["2026-09-28", { day: "2026-09-28", state: "pending", reason: "dark_waiting", explanation: "", final_at: null, purged_at: null, truck_ids: "[11]", load_ids: "[]", miles: 0, samples: 0, moving_pings: 0, activity_note: "", rule_version: 1 }],
		["2026-09-30", { day: "2026-09-30", state: "confirmed", reason: "parked", explanation: "", final_at: "2026-10-03T10:00:00.000Z", purged_at: "2027-01-08T10:00:00.000Z", truck_ids: "[11]", load_ids: "[]", miles: 0, samples: 0, moving_pings: 0, first_move_ms: null, activity_note: "", rule_version: 1 }],
		["2026-10-01", { day: "2026-10-01", state: "not_confirmed", reason: "truck_moved", explanation: "own_load", final_at: null, purged_at: null, truck_ids: "[11]", load_ids: "[\"7001\"]", miles: 212.4, samples: 300, moving_pings: 120, first_move_ms: 1, last_move_ms: 2, activity_note: "", rule_version: 1 }],
		["2026-10-02", { day: "2026-10-02", state: "confirmed", reason: "no_device", explanation: "", final_at: null, purged_at: null, truck_ids: "[11]", load_ids: "[]", miles: 0, samples: 0, moving_pings: 0, activity_note: "", rule_version: 1 }],
	]);
	const view = (o = {}) => T.timeOffEldDaysView({
		from: "2026-09-27", to: "2026-10-04", cancelled: false, todayKey: "2026-10-03", stored, monthClosed: (d) => d < "2026-10-01",
		units: new Map([[11, "T1"]]), showLoadId: (id) => `shown:${id}`, ...o,
	});
	const v = view();
	eq("§12.1 each day as staff see it", v.eldDays.map((d) => [d.day, d.state, d.label]), [
		["2026-09-27", "not_checked", "Not checked (month closed)"],
		["2026-09-28", "not_checked", "Not checked (month closed)"],
		["2026-09-29", "not_checked", "Not checked (month closed)"],
		["2026-09-30", "purged", "ELD results are kept 90 days"],
		["2026-10-01", "not_confirmed", "Not confirmed"],
		["2026-10-02", "confirmed", "Confirmed (no ELD data)"],
		["2026-10-03", "upcoming", "Requested"],
		["2026-10-04", "upcoming", "Requested"],
	]);
	eq("§12.1b a no-data day says so", [v.eldDays[5].noEldData, v.eldDays[5].reason, v.eldDays[5].reasonText], [true, "no_device", "his truck has no ELD linked"]);
	const purged = v.eldDays.find((d) => d.day === "2026-09-30");
	eq("§12.2 D18: a purged day carries the kept text and nothing else", Object.keys(purged).sort(), ["day", "label", "state"]);
	const judged = v.eldDays.find((d) => d.day === "2026-10-01");
	eq("§12.3 a judged day: reason, unit, miles, times, load ids as the viewer is shown them", [judged.reason, judged.explanation, judged.units, judged.miles, judged.firstMoveMs, judged.lastMoveMs, judged.loadIds, judged.final],
		["truck_moved", "own_load", ["T1"], 212.4, 1, 2, ["shown:7001"], false]);
	ok("§12.4 ...and no position", !/lat|lng|latitude|longitude/i.test(JSON.stringify(v)));
	eq("§12.5 a finished open-month day with no result yet: Checking", T.timeOffEldDaysView({ from: "2026-10-01", to: "2026-10-01", cancelled: false, todayKey: "2026-10-03", stored: new Map(), monthClosed: () => false, units: new Map(), showLoadId: (x) => x }).eldDays.map((d) => [d.state, d.label]),
		[["pending", "Checking"]]);
	eq("§12.6 the summary, the no-data days counted apart", [v.eldSummary.days, v.eldSummary.confirmed, v.eldSummary.confirmedNoEldData, v.eldSummary.notConfirmed, v.eldSummary.notChecked, v.eldSummary.kept, v.eldSummary.upcoming, v.eldSummary.text],
		[8, 1, 1, 1, 3, 1, 2, "ELD: 1 of 8 days confirmed (1 with no ELD data) · 1 not confirmed · 3 not checked · 1 kept 90 days"]);
	eq("§12.7 a cancelled row: only its stored days", view({ cancelled: true }).eldDays.map((d) => [d.day, d.state]), [["2026-09-28", "not_checked"], ["2026-09-30", "purged"], ["2026-10-01", "not_confirmed"], ["2026-10-02", "confirmed"]]);
}

console.log(`\ntest-time-off-eld-check: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
	for (const f of failures) console.log(`  ✗ ${f}`);
	process.exit(1);
}
