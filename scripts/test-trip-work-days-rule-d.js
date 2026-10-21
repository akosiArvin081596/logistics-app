#!/usr/bin/env node
/**
 * Rule d runner: the trip work-day rule as decision d (Arvin, 2026-10-21) words it
 * and the pay plan's section 1 builds it (~/LogisX-replica/reports/
 * 2026-10-21-pay-plan.md, Revision 2; P1-P18 approved, P8 as (b)). Written before
 * the fix: every case fails on main except the controls D18, D19 and D20 (D27,
 * a control under P8 (a), changes with P8 (b) and fails on main too). D30 came
 * from the money review (M2), written before its fix, which it failed.
 *
 * Decision d: a day is paid when the driver is driving or loading/unloading on a
 * dispatched trip, from the day he heads to the pickup through the day he
 * unloads; days he only waits are not paid. The drive to a dispatched pickup is
 * paid even empty; arriving the day before loading is paid only if he drove that
 * day; waiting days at a shipper or receiver are not paid; the unloading day after
 * waiting is paid. With no status updates: the appointment dates plus the days the
 * ELD shows driving. Eastern time.
 *
 * The contract (lib/trip-work-days.js):
 *   tripDaysForLoad(events, opts)   pure
 *     opts.window       the path's pay window as day keys { start, end, pickup,
 *                       assigned } (payWindow(); pickup is the Pickup Appointment
 *                       day, assigned the Assigned Date)
 *     opts.eld          { covered: Set, driving: Set } of Eastern days, or null
 *                       (no truck, or no read)
 *     opts.receiverExit { ms } the first fix leaving the receiver geofence after
 *                       the last At Receiver, { ms: null } read and never left,
 *                       or null (unreadable: no ELD or no receiver coordinates)
 *     opts.pickupFixesMs  as before (an ELD fix, so its day is covered)
 *     returns { basis, days, reasons: {day: why paid}, dropped: {day: why not},
 *               flags, stops, start, end, ... }
 *   createTripDayResolver({ db, enabled, fromMonth, zone, radiusM })
 *     .forLoad({ loadId, settleMonth, range, vid, window })  days | null | { error }
 *     .trip(loadId, { vid, window }), .errors()
 *
 * Made-up data only. Pure: no server, no network. Times are US Eastern walls,
 * stored as load_status_history stores them (UTC, no Z). Week of Mon 10/5/2026.
 * Run: node scripts/test-trip-work-days-rule-d.js    # exits 1 on failure
 */
"use strict";

const { spawnSync } = require("child_process");
const W = require("./lib/work-days-world");

const ZONE = "America/New_York";
const lib = () => W.requireLib("trip-work-days");
const T = (status, wall, source = "manual", actor = "Ana Dale") => ({ new_status: status, changed_at: W.et(wall), source, actor });
const DISPATCH = (wall) => T("Dispatched", wall, "dispatch", "super_admin");
const run = (events, opts = {}) => lib().tripDaysForLoad(events, { zone: ZONE, ...opts });
const days = (t) => (t && Array.isArray(t.days) ? [...t.days].sort() : t);
const eld = ({ covered = [], driving = [] } = {}) => ({ covered: new Set([...covered, ...driving]), driving: new Set(driving) });
const why = (t, day) => (t && t.reasons ? t.reasons[day] : undefined);
const dropped = (t, day) => (t && t.dropped ? t.dropped[day] : undefined);
const flag = (t, name) => W.hasFlag(t && t.flags, name);

const SAT = "2026-10-03";
const SUN = "2026-10-04";
const MON = "2026-10-05";
const TUE = "2026-10-06";
const WED = "2026-10-07";
const THU = "2026-10-08";
const FRI = "2026-10-09";

// A history table (and optionally telemetry and link rows) and a resolver on it.
function resolverWith({ status = [], pings = [], links = [], drop = [], fromMonth = "2026-10" } = {}) {
	const db = W.schemaDb();
	const st = db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, changed_at) VALUES (?, '', ?, ?, ?, ?)");
	for (const [lid, e] of status) st.run(lid, e.new_status, e.source, e.actor, e.changed_at);
	const tl = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, odometer, location_date_ms, dropped_reason) VALUES (?, ?, ?, ?, 0, ?, '')");
	for (const p of pings) tl.run(p.vid, p.lat ?? 32.7767, p.lng ?? -96.797, p.speed, p.ms);
	const ln = db.prepare("INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from, assigned_until, assigned_by) VALUES (1, ?, ?, '', ?)");
	for (const l of links) ln.run(l.vid, l.from, l.by || "super_admin");
	for (const t of drop) db.exec(`DROP TABLE ${t}`);
	return lib().createTripDayResolver({ db, enabled: true, fromMonth, zone: ZONE, radiusM: 3218.69 });
}

// ── D16's inputs, run in this process or a child under another TZ ─────────────
// A fix at 00:30 Eastern is the evening before on a Central truck's own clock.
const D16 = {
	status: [
		["d161", DISPATCH("2026-10-02 10:00")], ["d161", T("At Shipper", "2026-10-05 15:00")], ["d161", T("Loading", "2026-10-05 16:00")],
		["d161", T("In Transit", "2026-10-05 18:00")], ["d161", T("At Receiver", "2026-10-06 10:00")], ["d161", T("Delivered", "2026-10-06 11:00")],
		// Across the end of DST (2026-11-01 02:00 EDT).
		["d162", DISPATCH("2026-10-30 10:00")], ["d162", T("At Shipper", "2026-11-02 15:00")], ["d162", T("Loading", "2026-11-02 16:00")],
		["d162", T("In Transit", "2026-11-02 18:00")], ["d162", T("At Receiver", "2026-11-03 10:00")], ["d162", T("Delivered", "2026-11-03 11:00")],
	],
	pings: [
		{ vid: "V16", ms: W.etMs("2026-10-03 13:00"), speed: 0 },
		{ vid: "V16", ms: W.etMs("2026-10-04 00:30"), speed: 12 }, // Sun 00:30 EDT, Sat 23:30 CDT
		{ vid: "V16", ms: W.etMs("2026-10-05 12:00"), speed: 12 },
		{ vid: "V16", ms: W.etMs("2026-10-06 08:00"), speed: 12 },
		{ vid: "V16", ms: W.etMs("2026-10-31 13:00"), speed: 0 },
		{ vid: "V16", ms: Date.parse("2026-11-01T04:30:00Z"), speed: 12 }, // Sun 00:30 EDT, Sat 23:30 CDT
		{ vid: "V16", ms: W.etMs("2026-11-02 12:00"), speed: 12 },
		{ vid: "V16", ms: W.etMs("2026-11-03 08:00"), speed: 12 },
	],
};
function d16Answers() {
	const r = resolverWith({ status: D16.status, pings: D16.pings, fromMonth: "2026-10" });
	return [
		days(r.forLoad({ loadId: "D161", settleMonth: "2026-10", vid: "V16" })),
		days(r.forLoad({ loadId: "D162", settleMonth: "2026-11", vid: "V16" })),
	];
}
if (process.argv.includes("--d16-child")) {
	try { process.stdout.write(JSON.stringify({ tz: process.env.TZ, answers: d16Answers() })); } catch (err) { process.stdout.write(JSON.stringify({ tz: process.env.TZ, error: err.message })); }
	process.exit(0);
}
process.env.TZ = "UTC";

const R = W.createRunner("Rule d: paid trip days (lib/trip-work-days.js tripDaysForLoad() and createTripDayResolver())");

(async () => {
	// ── the drive to the pickup ────────────────────────────────────────────────
	await R.test("D01 heading-day-driving-paid: Heading to Shipper Mon 09:30 after a Mon dispatch, the ELD driving Mon: Mon (heading), Tue (loading), Wed (unloading). A Heading tap after the arrival is no start (it is bounded at or before arrival)", ({ eq }) => {
		const t = run([
			DISPATCH(`${MON} 08:00`), T("Heading to Shipper", `${MON} 09:30`), T("At Shipper", `${TUE} 08:00`), T("Loading", `${TUE} 09:00`),
			T("In Transit", `${TUE} 13:00`), T("At Receiver", `${WED} 10:00`), T("Delivered", `${WED} 11:30`),
		], { eld: eld({ driving: [MON, TUE, WED] }) });
		eq("days", days(t), [MON, TUE, WED]);
		eq("reasons", [why(t, MON), why(t, TUE), why(t, WED)], ["heading", "loading", "unloading"]);
		const late = run([
			DISPATCH(`${MON} 08:00`), T("At Shipper", `${MON} 18:00`), T("Heading to Shipper", `${TUE} 07:00`), T("Loading", `${TUE} 09:00`),
			T("In Transit", `${TUE} 13:00`), T("Delivered", `${WED} 11:30`),
		], { eld: eld({ driving: [MON, TUE, WED] }) });
		eq("a Heading tap after the arrival: the arrival day still opens the span", [days(late), why(late, MON)], [[MON, TUE, WED], "driving"]);
	});

	await R.test("D02 heading-tap-night-no-driving-unpaid: Heading Mon 23:10, the ELD covering Mon with no driving: Mon is in the span but a waiting day; Tue and Wed paid", ({ eq }) => {
		const t = run([
			DISPATCH(`${MON} 17:00`), T("Heading to Shipper", `${MON} 23:10`), T("At Shipper", `${TUE} 09:00`), T("Loading", `${TUE} 10:00`),
			T("In Transit", `${TUE} 14:00`), T("At Receiver", `${WED} 10:00`), T("Delivered", `${WED} 11:00`),
		], { eld: eld({ covered: [MON], driving: [TUE, WED] }) });
		eq("days", days(t), [TUE, WED]);
		eq("Mon dropped as waiting", dropped(t, MON), "waiting");
	});

	await R.test("D03 empty-drive-no-heading-walk-back: dispatched Sat, no Heading tap, the ELD driving Sun and Mon to an At Shipper Mon 16:00: the walk back from the arrival over consecutive driving days pays Sun (Sat parked stops it)", ({ eq, ok }) => {
		const t = run([
			DISPATCH(`${SAT} 12:00`), T("At Shipper", `${MON} 16:00`), T("Loading", `${TUE} 08:00`), T("In Transit", `${TUE} 11:00`),
			T("At Receiver", `${WED} 09:00`), T("Delivered", `${WED} 10:00`),
		], { eld: eld({ covered: [SAT], driving: [SUN, MON, TUE, WED] }) });
		eq("days", days(t), [SUN, MON, TUE, WED]);
		eq("Sun is a driving day", why(t, SUN), "driving");
		ok("flagged walkBack", flag(t, "walkBack"), JSON.stringify(t && t.flags));
	});

	await R.test("D04 walk-back-stops-at-dispatch-day: dispatched Sun 14:00, the ELD driving Fri to Tue (another trip before the dispatch): the walk back stops at Sun", ({ eq }) => {
		const t = run([
			DISPATCH(`${SUN} 14:00`), T("At Shipper", `${MON} 15:00`), T("Loading", `${MON} 16:00`), T("In Transit", `${MON} 18:00`),
			T("At Receiver", `${TUE} 12:00`), T("Delivered", `${TUE} 13:00`),
		], { eld: eld({ driving: ["2026-10-02", SAT, SUN, MON, TUE] }) });
		eq("days", days(t), [SUN, MON, TUE]);
	});

	// ── arrival, waiting, unloading ────────────────────────────────────────────
	await R.test("D05 arrive-day-before-loading-drove-paid: At Shipper Mon 20:00, loading Tue, the ELD driving Mon: Mon paid as a driving day", ({ eq }) => {
		const t = run([
			T("At Shipper", `${MON} 20:00`), T("Loading", `${TUE} 07:00`), T("In Transit", `${TUE} 11:00`), T("At Receiver", `${WED} 15:00`), T("Delivered", `${WED} 16:00`),
		], { eld: eld({ driving: [MON, TUE, WED] }) });
		eq("days", days(t), [MON, TUE, WED]);
		eq("reasons", [why(t, MON), why(t, TUE)], ["driving", "loading"]);
	});

	await R.test("D06 arrive-day-before-loading-no-drive-unpaid: At Shipper Mon 00:30, loading Tue, the ELD covering Mon with no driving: Mon unpaid (waiting)", ({ eq }) => {
		const t = run([
			T("At Shipper", `${MON} 00:30`), T("Loading", `${TUE} 07:00`), T("In Transit", `${TUE} 11:00`), T("At Receiver", `${WED} 15:00`), T("Delivered", `${WED} 16:00`),
		], { eld: eld({ covered: [MON], driving: [TUE, WED] }) });
		eq("days", days(t), [TUE, WED]);
		eq("Mon dropped as waiting", dropped(t, MON), "waiting");
	});

	await R.test("D07 waiting-at-shipper-unpaid: At Shipper Mon, parked Tue, Loading Wed: Tue unpaid", ({ eq }) => {
		const t = run([
			T("At Shipper", `${MON} 10:00`), T("Loading", `${WED} 08:00`), T("In Transit", `${WED} 12:00`), T("At Receiver", `${THU} 14:00`), T("Delivered", `${THU} 15:00`),
		], { eld: eld({ covered: [TUE], driving: [MON, WED, THU] }) });
		eq("days", days(t), [MON, WED, THU]);
		eq("Tue dropped as waiting", dropped(t, TUE), "waiting");
	});

	await R.test("D08 waiting-at-receiver-unpaid-unloading-day-paid: At Receiver Tue 16:00, parked Wed, Delivered Thu 10:00 and the truck leaves the receiver Thu 11:00: Wed unpaid, Thu (unloading) paid, no late tap", ({ eq, ok }) => {
		const t = run([
			T("At Shipper", `${MON} 08:00`), T("Loading", `${MON} 09:00`), T("In Transit", `${MON} 12:00`), T("At Receiver", `${TUE} 16:00`), T("Delivered", `${THU} 10:00`),
		], { eld: eld({ covered: [WED, THU], driving: [MON, TUE] }), receiverExit: { ms: W.etMs(`${THU} 11:00`) } });
		eq("days", days(t), [MON, TUE, THU]);
		eq("Wed dropped as waiting; Thu the unloading day", [dropped(t, WED), why(t, THU)], ["waiting", "unloading"]);
		ok("no late tap", !flag(t, "lateTap"), JSON.stringify(t && t.flags));
	});

	await R.test("D09 late-tap-unloading-day-is-receiver-exit: At Receiver Tue, the truck leaves the receiver Wed 10:00, Delivered tapped Fri: the trip ends Wed (the earlier of the tap and the exit)", ({ eq, ok }) => {
		const t = run([
			T("At Shipper", `${MON} 08:00`), T("Loading", `${MON} 09:00`), T("In Transit", `${MON} 12:00`), T("At Receiver", `${TUE} 16:00`), T("Delivered", `${FRI} 09:00`),
		], { eld: eld({ driving: [MON, TUE, WED, THU, FRI] }), receiverExit: { ms: W.etMs(`${WED} 10:00`) } });
		eq("days", days(t), [MON, TUE, WED]);
		eq("Wed is the unloading day", why(t, WED), "unloading");
		ok("flagged receiverExit", flag(t, "receiverExit"), JSON.stringify(t && t.flags));
	});

	await R.test("D10 rest-day-mid-transit-unpaid: loaded Mon, parked all Tue, delivered Wed: Tue unpaid (restDay)", ({ eq }) => {
		const t = run([
			T("At Shipper", `${MON} 08:00`), T("Loading", `${MON} 09:00`), T("In Transit", `${MON} 12:00`), T("At Receiver", `${WED} 15:00`), T("Delivered", `${WED} 16:00`),
		], { eld: eld({ covered: [TUE], driving: [MON, WED] }) });
		eq("days", days(t), [MON, WED]);
		eq("Tue dropped as a rest day", dropped(t, TUE), "restDay");
	});

	await R.test("D27 exit-unreadable-falls-back-to-lateTap [P8 (b)]: At Receiver Fri 9/25 20:33, Delivered tapped Mon 9/28, no receiver exit to read (no ELD; or ELD but no receiver coordinates, with a Sunday local move): Fri and Mon paid, Sat and Sun not", ({ eq, ok }) => {
		const events = [T("At Shipper", "2026-09-25 01:14"), T("At Receiver", "2026-09-25 20:33"), T("Delivered", "2026-09-28 13:27")];
		const noEld = run(events);
		eq("no ELD", days(noEld), ["2026-09-25", "2026-09-28"]);
		ok("flagged lateTap", flag(noEld, "lateTap"), JSON.stringify(noEld && noEld.flags));
		const withEld = run(events, { eld: eld({ covered: ["2026-09-26"], driving: ["2026-09-25", "2026-09-27", "2026-09-28"] }) });
		eq("ELD, no exit: the Sunday move is no trip day", days(withEld), ["2026-09-25", "2026-09-28"]);
		eq("…dropped as the late tap's gap", [dropped(withEld, "2026-09-26"), dropped(withEld, "2026-09-27")], ["lateTapGap", "lateTapGap"]);
	});

	// ── loading and multi-stop ─────────────────────────────────────────────────
	await R.test("D23 no-loading-tap-pickup-appt-before-in-transit-is-loading-day: arrival Mon, no Loading tap, Pickup Appointment Tue, parked Tue and Wed, In Transit Thu: Tue is the loading day, Wed waits. With no In Transit at all, the Pickup Appointment day on or after the arrival is the loading day", ({ eq }) => {
		const window = { start: TUE, end: FRI, pickup: TUE, assigned: MON };
		const t = run([
			T("At Shipper", `${MON} 17:00`), T("In Transit", `${THU} 06:00`), T("At Receiver", `${FRI} 10:00`), T("Delivered", `${FRI} 11:00`),
		], { window, eld: eld({ covered: [TUE, WED], driving: [MON, THU, FRI] }) });
		eq("days", days(t), [MON, TUE, THU, FRI]);
		eq("Tue the loading fallback, Wed waiting", [why(t, TUE), dropped(t, WED)], ["loading-fallback", "waiting"]);
		const noTransit = run([T("At Shipper", `${MON} 17:00`), T("At Receiver", `${THU} 10:00`), T("Delivered", `${THU} 11:00`)],
			{ window: { start: TUE, end: THU, pickup: TUE, assigned: MON }, eld: eld({ covered: [TUE, WED], driving: [MON, THU] }) });
		eq("no In Transit: the Pickup Appointment day (Tue) loads", [days(noTransit), why(noTransit, TUE)], [[MON, TUE, THU], "loading-fallback"]);
	});

	await R.test("D24 no-loading-tap-appt-after-in-transit-uses-in-transit-day: At Shipper Mon 00:30 (parked Mon), In Transit Tue 23:50 (no driving Tue), Pickup Appointment Thu: the In Transit day loads; Mon waits", ({ eq }) => {
		const t = run([T("At Shipper", `${MON} 00:30`), T("In Transit", `${TUE} 23:50`), T("Delivered", `${WED} 16:00`)],
			{ window: { start: THU, end: THU, pickup: THU, assigned: MON }, eld: eld({ covered: [MON, TUE], driving: [WED] }) });
		eq("days", days(t), [TUE, WED]);
		eq("Tue the loading fallback, Mon waiting", [why(t, TUE), dropped(t, MON)], ["loading-fallback", "waiting"]);
	});

	await R.test("D25 no-at-shipper-arrival-chain: no At Shipper, Loading Tue 08:00 is the arrival (flag noAtShipper); the walk back from it to the Sun dispatch pays Mon's empty drive", ({ eq, ok }) => {
		const t = run([DISPATCH(`${SUN} 10:00`), T("Loading", `${TUE} 08:00`), T("In Transit", `${TUE} 12:00`), T("At Receiver", `${WED} 09:00`), T("Delivered", `${WED} 10:00`)],
			{ eld: eld({ covered: [SUN], driving: [MON, TUE, WED] }) });
		eq("days", days(t), [MON, TUE, WED]);
		ok("flagged noAtShipper", flag(t, "noAtShipper"), JSON.stringify(t && t.flags));
	});

	await R.test("D26 dispatched-after-arrival-ignored: dispatched Sat, At Shipper Mon 10:00, dispatched again Mon 14:00: the walk back is bounded by the Sat dispatch (the latest at or before the arrival), not the later one", ({ eq }) => {
		const t = run([DISPATCH(`${SAT} 09:00`), T("At Shipper", `${MON} 10:00`), DISPATCH(`${MON} 14:00`), T("Loading", `${MON} 15:00`),
			T("In Transit", `${MON} 18:00`), T("At Receiver", `${TUE} 10:00`), T("Delivered", `${TUE} 11:00`)],
		{ eld: eld({ driving: [SAT, SUN, MON, TUE] }) });
		eq("days", days(t), [SAT, SUN, MON, TUE]);
	});

	await R.test("D28 multi-stop-every-loading-tap-and-drop-paid: Loading Mon and Wed (two pickups), parked Tue, a first drop Thu (tapped twice, one stop) with no driving, the last drop Fri: Mon, Wed, Thu, Fri paid, Tue a rest day; stops counted distinct (2 pickups, 2 drops)", ({ eq, ok }) => {
		const t = run([
			T("At Shipper", `${MON} 08:00`), T("Loading", `${MON} 09:00`), T("In Transit", `${MON} 12:00`),
			T("At Shipper", `${WED} 08:00`), T("Loading", `${WED} 09:00`), T("In Transit", `${WED} 11:00`),
			T("At Receiver", `${THU} 09:00`), T("At Receiver", `${THU} 09:20`), T("In Transit", `${THU} 11:00`),
			T("At Receiver", `${FRI} 09:00`), T("Delivered", `${FRI} 10:00`),
		], { eld: eld({ covered: [TUE, WED, THU, FRI], driving: [MON] }) });
		eq("days", days(t), [MON, WED, THU, FRI]);
		eq("reasons", [why(t, WED), why(t, THU), why(t, FRI), dropped(t, TUE)], ["loading", "unloading", "unloading", "restDay"]);
		eq("distinct stops", t && t.stops, { pickups: 2, drops: 2 });
		ok("flagged multiStop", flag(t, "multiStop"), JSON.stringify(t && t.flags));
	});

	// ── no status updates ──────────────────────────────────────────────────────
	await R.test("D11 no-taps-appointment-days-plus-driving: no history rows, window Mon to Thu, the ELD driving Tue only: Mon and Thu (the appointments) and Tue; Wed unpaid", ({ eq }) => {
		const t = run([], { window: { start: MON, end: THU, pickup: MON, assigned: MON }, eld: eld({ covered: [MON, WED, THU], driving: [TUE] }) });
		eq("basis", t && t.basis, "appointments");
		eq("days", days(t), [MON, TUE, THU]);
		eq("reasons", [why(t, MON), why(t, TUE), why(t, THU), !!dropped(t, WED)], ["appointment", "driving", "appointment", true]);
	});

	await R.test("D12 no-taps-loading-day-paid-without-driving: no rows, window Mon to Tue, the ELD covering Mon with no driving: Mon (the pickup appointment) is paid", ({ eq }) => {
		const t = run([], { window: { start: MON, end: TUE, pickup: MON, assigned: MON }, eld: eld({ covered: [MON], driving: [TUE] }) });
		eq("days", days(t), [MON, TUE]);
		eq("Mon an appointment day", why(t, MON), "appointment");
	});

	await R.test("D13 partial-taps-per-anchor-fallback [Q3]: a Delivered tap only (Wed) with window Mon to Wed: the pickup appointment loads, the tap unloads; an At Shipper tap only (Mon) with window Mon to Thu: the drop-off appointment ends it", ({ eq }) => {
		const a = run([T("Delivered", `${WED} 14:00`)], { window: { start: MON, end: WED, pickup: MON, assigned: MON }, eld: eld({ covered: [MON, WED], driving: [TUE] }) });
		eq("Delivered only", [days(a), why(a, MON), why(a, WED)], [[MON, TUE, WED], "appointment", "unloading"]);
		const b = run([T("At Shipper", `${MON} 09:00`)], { window: { start: MON, end: THU, pickup: MON, assigned: MON }, eld: eld({ covered: [MON, TUE, THU], driving: [WED] }) });
		eq("At Shipper only", [days(b), why(b, THU), !!dropped(b, TUE)], [[MON, WED, THU], "appointment", true]);
	});

	await R.test("D29 no-status-drive-to-pickup-walk-back-to-assigned-date [Q6]: no rows, window Wed to Thu, Assigned Sun, the ELD driving Sat, Mon, Tue and Thu: the walk back from the pickup appointment pays Mon and Tue (Sun parked stops it); Assigned Tue stops it at Tue; no Assigned Date, no walk back", ({ eq }) => {
		const e = eld({ covered: [SUN, WED], driving: [SAT, MON, TUE, THU] });
		eq("Assigned Sun", days(run([], { window: { start: WED, end: THU, pickup: WED, assigned: SUN }, eld: e })), [MON, TUE, WED, THU]);
		eq("Assigned Tue", days(run([], { window: { start: WED, end: THU, pickup: WED, assigned: TUE }, eld: e })), [TUE, WED, THU]);
		eq("no Assigned Date", days(run([], { window: { start: WED, end: THU, pickup: WED, assigned: "" }, eld: e })), [WED, THU]);
	});

	await R.test("D30 (money review M2) stale-appointment-floor: with no arrival tap the trip starts at the latest of the window's first day, the dispatch day and the Assigned Date. A Pickup Appointment 9/29-9/30 on a load Assigned 10/16, no taps: nothing is paid (not even the ELD's 9/29-9/30 driving) and the resolver answers [] (the rule covers the load), not null; with a Delivered tap 10/17: the driving 10/16 and the unloading 10/17 only; an appointment Wed on a load dispatched and Assigned Thu: Wed unpaid though the truck moved", ({ eq, ok }) => {
		const window = { start: "2026-09-29", end: "2026-09-30", pickup: "2026-09-29", assigned: "2026-10-16" };
		const e = eld({ driving: ["2026-09-29", "2026-09-30", "2026-10-16"] });
		const none = run([], { window, eld: e });
		eq("no taps: nothing", days(none), []);
		ok("flagged staleAppointment", flag(none, "staleAppointment"), JSON.stringify(none && none.flags));
		eq("resolver: [] (the rule covers it, pays nothing), not null", resolverWith().forLoad({ loadId: "D30", settleMonth: "2026-10", window }), []);
		eq("a Delivered tap 10/17: 10/16 and 10/17 only", days(run([T("Delivered", "2026-10-17 14:00")], { window, eld: e })), ["2026-10-16", "2026-10-17"]);
		const thu = run([DISPATCH("2026-10-01 10:00"), T("Delivered", "2026-10-02 16:00")],
			{ window: { start: "2026-09-30", end: "2026-10-02", pickup: "2026-09-30", assigned: "2026-10-01" }, eld: eld({ driving: ["2026-09-30", "2026-10-01", "2026-10-02"] }) });
		eq("appointment Wed, dispatched and Assigned Thu: Thu and Fri", days(thu), ["2026-10-01", "2026-10-02"]);
	});

	// ── the ELD, time, errors ──────────────────────────────────────────────────
	await R.test("D14 no-eld-coverage-pays-span-flagged [Q10a]: a tapped trip Mon to Wed with no ELD fix on any span day: every span day paid, flagged noEld", ({ eq, ok }) => {
		const t = run([T("At Shipper", `${MON} 09:00`), T("Loading", `${MON} 10:00`), T("In Transit", `${MON} 13:00`), T("At Receiver", `${WED} 10:00`), T("Delivered", `${WED} 11:00`)],
			{ eld: eld({ covered: [FRI] }) });
		eq("days", days(t), [MON, TUE, WED]);
		eq("Tue paid for want of a fix", why(t, TUE), "noEld");
		ok("flagged noEld", flag(t, "noEld"), JSON.stringify(t && t.flags));
	});

	await R.test("D15 dark-day-in-covered-span-unpaid-listed [Q10b]: the ELD covering Mon and Wed, dark Tue: Tue unpaid, listed as dark", ({ eq }) => {
		const t = run([T("At Shipper", `${MON} 09:00`), T("Loading", `${MON} 10:00`), T("In Transit", `${MON} 13:00`), T("At Receiver", `${WED} 10:00`), T("Delivered", `${WED} 11:00`)],
			{ eld: eld({ driving: [MON, WED] }) });
		eq("days", days(t), [MON, WED]);
		eq("Tue dropped as dark", dropped(t, TUE), "dark");
	});

	await R.test("D16 eastern-day-across-zones-and-dst: a fix at 00:30 Eastern Sun (Sat 23:30 on a Central truck's clock) makes Sun a driving day, so the walk back pays Sun; across the end of DST the same; the same answers under TZ=UTC, New_York, Chicago, Los_Angeles and Manila", ({ eq, ok }) => {
		const want = [[SUN, MON, TUE], ["2026-11-01", "2026-11-02", "2026-11-03"]];
		for (const tz of ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Manila"]) {
			const r = spawnSync(process.execPath, [__filename, "--d16-child"], { encoding: "utf8", env: { ...process.env, TZ: tz }, timeout: 30000 });
			let parsed = null;
			try { parsed = JSON.parse(r.stdout); } catch { parsed = { tz, error: `no answer (exit ${r.status}): ${(r.stderr || "").split("\n")[0]}` }; }
			if (parsed.error) { ok(`TZ=${tz}`, false, parsed.error); continue; }
			eq(`TZ=${tz}`, parsed.answers, want);
		}
	});

	await R.test("D17 fix-before-device-link-ignored: a load with no rows, window Mon to Wed, its truck's only fix (parked Tue) taken before the device was linked (Thu): no fix counts, so the whole window is paid (noEld); with an unknown link time (the seed's row) the fix counts and Tue is dropped", ({ eq }) => {
		const window = { start: MON, end: WED, pickup: MON, assigned: MON };
		const pings = [{ vid: "V17", ms: W.etMs(`${TUE} 12:00`), speed: 0 }];
		const linked = resolverWith({ pings, links: [{ vid: "V17", from: "2026-10-08T12:00:00.000Z" }] });
		eq("linked Thu: the fix is ignored", days(linked.forLoad({ loadId: "D17", settleMonth: "2026-10", vid: "V17", window })), [MON, TUE, WED]);
		const seeded = resolverWith({ pings, links: [{ vid: "V17", from: "2026-10-08T12:00:00.000Z", by: "system:seed" }] });
		eq("unknown link time: the fix counts", days(seeded.forLoad({ loadId: "D17", settleMonth: "2026-10", vid: "V17", window })), [MON, WED]);
	});

	await R.test("D21 eld-read-error-window-rule-flagged [M3]: the telemetry cannot be read: forLoad answers { error } (the path then pays its window rule and names the load), and errors() lists it", ({ eq, ok }) => {
		const r = resolverWith({ status: [["d21", T("At Shipper", `${MON} 09:00`)], ["d21", T("Delivered", `${WED} 11:00`)]], drop: ["routemate_telemetry"] });
		const out = r.forLoad({ loadId: "D21", settleMonth: "2026-10", vid: "V21", window: { start: MON, end: WED, pickup: MON, assigned: MON } });
		ok("an error, not days", !!out && !Array.isArray(out) && typeof out.error === "string", JSON.stringify(out));
		eq("listed", (typeof r.errors === "function" ? r.errors() : []).map((x) => x.loadId), ["D21"]);
	});

	await R.test("D22 history-read-error-window-rule-flagged [M3]: load_status_history cannot be read: forLoad answers { error }, never null as if there were no rows", ({ ok }) => {
		const r = resolverWith({ drop: ["load_status_history"] });
		const out = r.forLoad({ loadId: "D22", settleMonth: "2026-10", window: { start: MON, end: WED, pickup: MON, assigned: MON } });
		ok("an error", !!out && !Array.isArray(out) && typeof out.error === "string", JSON.stringify(out));
	});

	// ── controls (pass on main) ────────────────────────────────────────────────
	await R.test("D18 events-before-last-cancel-ignored (control): At Shipper Mon, Cancelled Mon, re-dispatched Tue, At Shipper Wed, Delivered Thu: Wed and Thu", ({ eq }) => {
		const t = run([T("At Shipper", `${MON} 09:00`), T("Cancelled", `${MON} 14:00`, "cancel", "super_admin"), DISPATCH(`${TUE} 11:00`),
			T("At Shipper", `${WED} 09:00`), T("At Receiver", `${THU} 10:00`), T("Delivered", `${THU} 12:00`)]);
		eq("days", days(t), [WED, THU]);
	});

	await R.test("D19 settles-before-FROM-window-rule-unchanged (control): FROM=2026-10, a load Assigned in September, or with no Assigned Date and a first trip day in September, does not follow the rule (null: its path's window rule pays it)", ({ eq }) => {
		const r = resolverWith({ status: [["d19", T("At Shipper", "2026-09-29 09:00")], ["d19", T("Delivered", "2026-10-01 11:00")]] });
		eq("Assigned September", r.forLoad({ loadId: "D19", settleMonth: "2026-09" }), null);
		eq("no Assigned Date, first day in September", r.forLoad({ loadId: "D19", settleMonth: "" }), null);
	});

	await R.test("D20 cap-31-days (control): At Shipper 9/1, Delivered 10/15 on its At Receiver day: 9/1 to 10/1, flagged capped", ({ eq, ok }) => {
		const t = run([T("At Shipper", "2026-09-01 09:00"), T("In Transit", "2026-09-02 09:00"), T("At Receiver", "2026-10-15 10:00"), T("Delivered", "2026-10-15 12:00")]);
		eq("days", days(t), W.daysFrom("2026-09-01", "2026-10-01"));
		ok("flagged capped", flag(t, "capped"), JSON.stringify(t && t.flags));
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
