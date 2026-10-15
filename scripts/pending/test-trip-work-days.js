#!/usr/bin/env node
/**
 * B12 runner A: the trip-timestamp work-day rule, the pure part (plan section
 * 4.1(1), cases A1-A15). FAILING TESTS WRITTEN BEFORE THE FIX: every case fails
 * on main because lib/trip-work-days.js does not exist yet.
 *
 * The contract these cases hold the fix to (from the plan):
 *   tripDaysForLoad(events, opts)          pure
 *     events  one load's load_status_history rows, any order, as stored:
 *             { new_status, changed_at ("YYYY-MM-DD HH:MM:SS", UTC, no Z), source, actor }
 *     opts    { zone }            the business zone (APP_TIMEZONE, US Eastern)
 *             { pickupFixesMs }   epoch ms of ELD fixes inside the load's pickup
 *                                 geofence (Q2: a fix after dispatch can start the
 *                                 trip before the first In Transit tap)
 *     returns { basis: "trip"|"partial"|"none", days, start, end, flags }
 *             days are "YYYY-MM-DD" in `zone`; flags carry lateTap, noAtShipper,
 *             deliveredOnly, cancelledAfterStart, multiActor (an array, a Set or
 *             an object of booleans all read the same here)
 *   createTripDayResolver({ db, enabled, fromMonth, zone })
 *     .forLoad({ loadId, settleMonth, range: { start, end } })
 *             the trip days within range, or null (load settles before FROM, or
 *             no full trip); history read once, keyed like statusKey()
 * The rule: only events after the last Cancelled; start = the first At Shipper,
 * else Loading, else In Transit; end = the last Delivered, or the At Receiver day
 * when Delivered was tapped 2+ calendar days after it (Q1); every day between, in
 * Eastern; capped at 31 days.
 *
 * [Qn] in a title: the expected days follow the plan's recommended answer to open
 * question n. A different answer changes that case.
 *
 * A11 runs the same inputs in child processes under TZ=UTC, America/New_York,
 * America/Chicago, America/Los_Angeles and Asia/Manila; the answers must match.
 *
 * Made-up data only (drivers, loads, times). Pure: no server, no network.
 * Run: node scripts/pending/test-trip-work-days.js    # exits 1 on failure (scripts/test-trip-work-days.js once enabled)
 */
"use strict";

const { spawnSync } = require("child_process");
const W = require("./lib/work-days-world");

const ZONE = "America/New_York";
const ev = (new_status, changed_at, source = "manual", actor = "Gus Grant") => ({ new_status, changed_at, source, actor });
const trip = (events, opts = {}) => W.requireLib("trip-work-days").tripDaysForLoad(events, { zone: ZONE, ...opts });
const sorted = (days) => [...(days || [])].sort();
const daysOf = (x) => (Array.isArray(x) ? sorted(x) : x && Array.isArray(x.days) ? sorted(x.days) : x);
// The Eastern day a start/end value names: a day key, or an instant.
const markDay = (x) => {
	if (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
	const ms = typeof x === "number" ? x : x instanceof Date ? x.getTime() : typeof x === "string" ? (Date.parse(x) || W.stampMs(x)) : NaN;
	if (!Number.isFinite(ms)) return null;
	return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
};

// A history table holding `rows` [loadId, status, source, changed_at, actor], and a resolver on it.
function resolverOn(rows, { enabled = true, fromMonth = "2026-09" } = {}) {
	const db = new W.Database(":memory:");
	W.buildSchema(db);
	const st = db.prepare("INSERT INTO load_status_history (load_id, old_status, new_status, source, actor, changed_at) VALUES (?, '', ?, ?, ?, ?)");
	for (const [lid, s, source, at, actor] of rows) st.run(lid, s, source || "manual", actor || "", at);
	return W.requireLib("trip-work-days").createTripDayResolver({ db, enabled, fromMonth, zone: ZONE });
}
const rowsOf = (loadId, events) => events.map((e) => [loadId, e.new_status, e.source, e.changed_at, e.actor]);

// ── A11's inputs, run in this process or a child ──────────────────────────────
const A11_LOADS = {
	// 00:41 EDT on 9/30 is 23:41 CDT on 9/29: the business day is 9/30.
	lateNight: [ev("At Shipper", "2026-09-30 04:41:00"), ev("Delivered", "2026-09-30 22:00:00")],
	// DST ends 2026-11-01 02:00: 04:30Z on 11/01 is 00:30 EDT (11/01); 04:30Z on
	// 11/02 is 23:30 EST (11/01).
	dst: [ev("At Shipper", "2026-11-01 04:30:00"), ev("Delivered", "2026-11-02 04:30:00")],
};
function a11Answers() {
	const r = resolverOn([...rowsOf("z101", A11_LOADS.lateNight), ...rowsOf("z102", A11_LOADS.dst)], { fromMonth: "2026-09" });
	return {
		lateNight: sorted(trip(A11_LOADS.lateNight).days),
		dst: sorted(trip(A11_LOADS.dst).days),
		viaDb: [
			daysOf(r.forLoad({ loadId: "Z101", settleMonth: "2026-10", range: { start: "2026-09-26", end: "2026-10-02" } })),
			daysOf(r.forLoad({ loadId: "Z102", settleMonth: "2026-11", range: { start: "2026-10-31", end: "2026-11-06" } })),
		],
	};
}
if (process.argv.includes("--a11-child")) {
	try { process.stdout.write(JSON.stringify({ tz: process.env.TZ, answers: a11Answers() })); } catch (err) { process.stdout.write(JSON.stringify({ tz: process.env.TZ, error: err.message })); }
	process.exit(0);
}
process.env.TZ = "UTC";

const R = W.createRunner("B12 A: tripDaysForLoad() and createTripDayResolver() (lib/trip-work-days.js)");

(async () => {
	await R.test("A1 Heading to Shipper (Wed 20:52 ET) and Dispatched are no work start; At Shipper Thu starts the trip: Thu and Fri, Wed nothing (the resolver reads the same days, keyed like statusKey(), clipped to range; a load settling before FROM is null)", ({ eq }) => {
		const events = [
			ev("Dispatched", "2026-09-30 14:00:00", "dispatch", "super_admin"),
			ev("Heading to Shipper", "2026-10-01 00:52:00"), // Wed 20:52 ET
			ev("At Shipper", "2026-10-01 16:26:00"), // Thu 12:26
			ev("In Transit", "2026-10-02 03:30:00"), // Thu 23:30
			ev("At Receiver", "2026-10-02 16:10:00"), // Fri 12:10
			ev("Delivered", "2026-10-02 16:55:00"), // Fri 12:55
		];
		const t = trip(events);
		eq("basis", t.basis, "trip");
		eq("days", sorted(t.days), ["2026-10-01", "2026-10-02"]);
		const r = resolverOn(rowsOf("a101", events));
		eq("resolver, load id as the sheet spells it (#A101)", daysOf(r.forLoad({ loadId: "#A101", settleMonth: "2026-10", range: { start: "2026-09-26", end: "2026-10-02" } })), ["2026-10-01", "2026-10-02"]);
		eq("resolver clips to the range", daysOf(r.forLoad({ loadId: "A101", settleMonth: "2026-10", range: { start: "2026-10-02", end: "2026-10-08" } })), ["2026-10-02"]);
		eq("resolver: a load settling before FROM (2026-08 < 2026-09) is null", r.forLoad({ loadId: "A101", settleMonth: "2026-08", range: { start: "2026-09-26", end: "2026-10-02" } }), null);
	});

	await R.test("A2 [Q4] Two loads on Tue 9/29 (one Delivered 19:58 ET, the next At Shipper 19:21 ET): the day is paid once", ({ eq }) => {
		const b = trip([ev("At Shipper", "2026-09-29 17:19:00"), ev("Delivered", "2026-09-29 23:58:00")]);
		const c = trip([ev("At Shipper", "2026-09-29 23:21:00"), ev("In Transit", "2026-09-30 12:25:00"), ev("Delivered", "2026-10-01 00:09:00")]);
		eq("first load", sorted(b.days), ["2026-09-29"]);
		eq("second load", sorted(c.days), ["2026-09-29", "2026-09-30"]);
		eq("the driver's days: Tue once, Wed", sorted([...new Set([...b.days, ...c.days])]), ["2026-09-29", "2026-09-30"]);
	});

	await R.test("A3 [Q3] Delivered Tue 23:20 ET, next At Shipper Thu 09:00 ET: the waiting Wed is unpaid", ({ eq }) => {
		const one = trip([ev("At Shipper", "2026-09-29 17:01:00"), ev("Delivered", "2026-09-30 03:20:00")]);
		const two = trip([ev("At Shipper", "2026-10-01 13:00:00"), ev("Delivered", "2026-10-01 22:00:00")]);
		eq("first load", sorted(one.days), ["2026-09-29"]);
		eq("second load", sorted(two.days), ["2026-10-01"]);
		eq("no Wed", [...one.days, ...two.days].includes("2026-09-30"), false);
	});

	await R.test("A4 [Q1, Q6] At Receiver Thu 23:14 ET, Delivered Fri 00:00 ET (one calendar day later, an overnight unload): Thu and Fri both count", ({ eq, ok }) => {
		const t = trip([ev("At Shipper", "2026-10-01 17:58:00"), ev("At Receiver", "2026-10-02 03:14:00"), ev("Delivered", "2026-10-02 04:00:20")]);
		eq("days", sorted(t.days), ["2026-10-01", "2026-10-02"]);
		ok("no late-tap flag for a Delivered one day after At Receiver", !W.hasFlag(t.flags, "lateTap"), JSON.stringify(t.flags));
	});

	await R.test("A5 [Q1] At Receiver Fri 9/25 20:33 ET, Delivered tapped Sun 9/27, and in a second load Mon 9/28: the trip ends Fri in both, flagged lateTap", ({ eq, ok }) => {
		const base = [ev("At Shipper", "2026-09-25 05:14:00"), ev("At Receiver", "2026-09-26 00:33:00")];
		const sun = trip([...base, ev("Delivered", "2026-09-27 15:00:00")]);
		const mon = trip([...base, ev("Delivered", "2026-09-28 17:27:00")]);
		eq("Delivered Sun: Fri only", sorted(sun.days), ["2026-09-25"]);
		eq("Delivered Mon: Fri only", sorted(mon.days), ["2026-09-25"]);
		ok("both flagged lateTap", W.hasFlag(sun.flags, "lateTap") && W.hasFlag(mon.flags, "lateTap"), JSON.stringify([sun.flags, mon.flags]));
	});

	await R.test("A6 [Q2] No At Shipper: the first In Transit (Mon 18:44 ET) starts the trip, Delivered Tue: Mon and Tue, flagged noAtShipper; an ELD fix inside the pickup geofence on Sun after a Sat dispatch starts it Sun; a fix before dispatch is ignored", ({ eq, ok }) => {
		const events = [
			ev("Dispatched", "2026-09-28 19:53:00", "dispatch", "super_admin"), // Mon 15:53
			ev("In Transit", "2026-09-28 22:44:00"), // Mon 18:44
			ev("At Receiver", "2026-09-29 16:58:00"),
			ev("Delivered", "2026-09-29 20:01:00"),
		];
		const t = trip(events);
		eq("days", sorted(t.days), ["2026-09-28", "2026-09-29"]);
		ok("flagged noAtShipper", W.hasFlag(t.flags, "noAtShipper"), JSON.stringify(t.flags));
		const early = [ev("Dispatched", "2026-09-26 18:00:00", "dispatch", "super_admin"), ...events.slice(1)];
		const fixes = [W.etMs("2026-09-25 10:00"), W.etMs("2026-09-27 14:00")];
		eq("Sat dispatch, geofence fix Sun 14:00 ET: Sun to Tue", sorted(trip(early, { pickupFixesMs: fixes }).days), ["2026-09-27", "2026-09-28", "2026-09-29"]);
		eq("Mon dispatch, geofence fix Sun (before dispatch): still Mon and Tue", sorted(trip(events, { pickupFixesMs: [W.etMs("2026-09-27 14:00")] }).days), ["2026-09-28", "2026-09-29"]);
	});

	await R.test("A7 [Q2] A Delivered tap only: basis partial, flagged deliveredOnly, and the resolver returns null (today's rule applies)", ({ eq, ok }) => {
		const events = [ev("Delivered", "2026-09-30 18:00:00")];
		const t = trip(events);
		eq("basis", t.basis, "partial");
		ok("flagged deliveredOnly", W.hasFlag(t.flags, "deliveredOnly"), JSON.stringify(t.flags));
		eq("resolver", resolverOn(rowsOf("a107", events)).forLoad({ loadId: "A107", settleMonth: "2026-10", range: { start: "2026-09-26", end: "2026-10-02" } }), null);
	});

	await R.test("A8 No history rows: basis none, no days, and the resolver returns null", ({ eq }) => {
		const t = trip([]);
		eq("basis", t.basis, "none");
		eq("days", sorted(t.days), []);
		eq("resolver", resolverOn([]).forLoad({ loadId: "A108", settleMonth: "2026-10", range: { start: "2026-09-26", end: "2026-10-02" } }), null);
	});

	await R.test("A9 At Shipper Mon, Cancelled Mon, re-dispatched Tue, At Shipper Wed, Delivered Thu: only the events after the last Cancelled count, Wed and Thu", ({ eq }) => {
		const t = trip([
			ev("At Shipper", "2026-09-28 14:00:00"),
			ev("Cancelled", "2026-09-28 18:00:00", "cancel", "super_admin"),
			ev("Dispatched", "2026-09-29 15:00:00", "dispatch", "super_admin"),
			ev("At Shipper", "2026-09-30 13:00:00"),
			ev("At Receiver", "2026-10-01 14:00:00"),
			ev("Delivered", "2026-10-01 16:00:00"),
		]);
		eq("days", sorted(t.days), ["2026-09-30", "2026-10-01"]);
	});

	await R.test("A10 Repeated rows (At Shipper Mon 10:00 and 14:00 ET, At Receiver Tue twice, Delivered Tue): start Mon 10:00, end Tue", ({ eq, ok }) => {
		const t = trip([
			ev("At Shipper", "2026-09-28 18:00:00"),
			ev("Delivered", "2026-09-29 15:00:00"),
			ev("At Shipper", "2026-09-28 14:00:00"),
			ev("In Transit", "2026-09-28 20:00:00"),
			ev("At Receiver", "2026-09-29 13:00:00"),
			ev("At Receiver", "2026-09-29 13:30:00"),
		]);
		eq("days", sorted(t.days), ["2026-09-28", "2026-09-29"]);
		ok("start is the first At Shipper, Mon 10:00 ET (2026-09-28 14:00:00 UTC)", W.sameInstant(t.start, "2026-09-28 14:00:00"), JSON.stringify(t.start));
		eq("end is on Tue", markDay(t.end), "2026-09-29");
	});

	await R.test("A11 [Q7] changed_at parsed as stored (UTC, no Z): 2026-09-30 04:41:00 is 9/30 in Eastern (9/29 truck-local Central); across the DST end 11/01 04:30Z and 11/02 04:30Z are both 11/01; the same answers through the resolver and under TZ=UTC, New_York, Chicago, Los_Angeles and Manila", ({ eq, ok }) => {
		const want = { lateNight: ["2026-09-30"], dst: ["2026-11-01"], viaDb: [["2026-09-30"], ["2026-11-01"]] };
		const out = [];
		for (const tz of ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Manila"]) {
			const r = spawnSync(process.execPath, [__filename, "--a11-child"], { encoding: "utf8", env: { ...process.env, TZ: tz }, timeout: 30000 });
			let parsed = null;
			try { parsed = JSON.parse(r.stdout); } catch { parsed = { tz, error: `no answer (exit ${r.status}): ${(r.stderr || "").split("\n")[0]}` }; }
			out.push(parsed);
		}
		for (const o of out) {
			if (o.error) { ok(`TZ=${o.tz}`, false, o.error); continue; }
			eq(`TZ=${o.tz}`, o.answers, want);
		}
	});

	await R.test("A12 [Q5] At Shipper Tue 23:30 ET, In Transit Wed 07:00, Delivered Wed 18:00: the late-night arrival day counts, Tue and Wed", ({ eq }) => {
		const t = trip([ev("At Shipper", "2026-09-30 03:30:00"), ev("In Transit", "2026-09-30 11:00:00"), ev("At Receiver", "2026-09-30 21:00:00"), ev("Delivered", "2026-09-30 22:00:00")]);
		eq("days", sorted(t.days), ["2026-09-29", "2026-09-30"]);
	});

	await R.test("A13 [Q14] At Shipper Mon, then Cancelled: no days, flagged cancelledAfterStart", ({ eq, ok }) => {
		const t = trip([ev("Dispatched", "2026-09-28 12:00:00", "dispatch", "super_admin"), ev("At Shipper", "2026-09-28 14:00:00"), ev("Cancelled", "2026-09-28 20:00:00", "cancel", "super_admin")]);
		eq("days", sorted(t.days), []);
		ok("flagged cancelledAfterStart", W.hasFlag(t.flags, "cancelledAfterStart"), JSON.stringify(t.flags));
	});

	await R.test("A14 [Q15] Taps by two driver accounts: the whole trip's days (they go to the sheet's Driver), flagged multiActor; one driver plus a dispatcher and the geofence is not multi-actor", ({ eq, ok }) => {
		const two = trip([
			ev("Dispatched", "2026-09-28 12:00:00", "dispatch", "super_admin"),
			ev("Assigned", "2026-09-28 12:30:00", "accept", "Gil Grove"),
			ev("At Shipper", "2026-09-28 14:00:00", "manual", "Gil Grove"),
			ev("In Transit", "2026-09-29 13:00:00", "manual", "Hal Hart"),
			ev("Delivered", "2026-09-30 18:00:00", "manual", "Hal Hart"),
		]);
		eq("days", sorted(two.days), ["2026-09-28", "2026-09-29", "2026-09-30"]);
		ok("flagged multiActor", W.hasFlag(two.flags, "multiActor"), JSON.stringify(two.flags));
		const one = trip([
			ev("Dispatched", "2026-09-28 12:00:00", "dispatch", "super_admin"),
			ev("At Shipper", "2026-09-28 14:00:00", "geofence", ""),
			ev("In Transit", "2026-09-29 13:00:00", "manual", "Gil Grove"),
			ev("Delivered", "2026-09-30 18:00:00", "manual", "Gil Grove"),
		]);
		ok("one driver, a dispatcher and the geofence: not multiActor", !W.hasFlag(one.flags, "multiActor"), JSON.stringify(one.flags));
	});

	await R.test("A15 At Shipper 9/1, Delivered 10/15 on its At Receiver day (no late tap): capped at 31 days, 9/1 to 10/1, with a flag", ({ eq, ok }) => {
		const t = trip([ev("At Shipper", "2026-09-01 13:00:00"), ev("In Transit", "2026-09-02 13:00:00"), ev("At Receiver", "2026-10-15 14:00:00"), ev("Delivered", "2026-10-15 16:00:00")]);
		eq("31 days, 9/1 to 10/1", sorted(t.days), W.daysFrom("2026-09-01", "2026-10-01"));
		ok("a flag says the trip was capped, and it is not a late tap", W.anyFlag(t.flags) && !W.hasFlag(t.flags, "lateTap"), JSON.stringify(t.flags));
	});

	R.finish();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
