#!/usr/bin/env node
/**
 * The KPI deadhead chain (lib/kpi-deadhead.js), R10 rule H1 with revisions 3a
 * and 3b and the final review's Low:
 *
 *  - the truck of a load: load_eld_miles, else the dated assignment at the
 *    pickup instant, else the Job Tracking Truck column;
 *  - cancelled loads are not in the chain; an in-progress load is;
 *  - previous = the load just before by (pickup instant, load key), each used
 *    once; ties ordered by key whatever the input order;
 *  - a previous delivery strictly after this pickup is an overlap (no search
 *    back); equal instants chain with a gap of 0;
 *  - a gap of exactly 72 h chains, 72 h + 1 minute is a restart;
 *  - a stated Empty Movement counts whatever the chain says; unknown is null,
 *    never 0; equal points after rounding are 0 mi with no route call;
 *  - text to instant (rule 2a): the dock's clock (written zone, else the
 *    longitude band, else APP_TIMEZONE, counted); a pickup window's start, a
 *    drop-off window's end, past midnight; date-only and FCFS as the whole day;
 *    the Completion Date in APP_TIMEZONE; the 3-day plausibility;
 *  - markers (3a): a load with no usable pickup sits at its delivery (else its
 *    day's last instant); its own deadhead and the next load's are unknown, and
 *    the loads on either side are never paired;
 *  - before a marker (3b + the Low): every load picked up within 72 h before a
 *    marker's delivery is unknown, including one picked up AND delivered
 *    between the previous load and the marker's delivery;
 *  - the route pair key: 4 decimals, a change in the 4th is a new key, in the
 *    5th the same key.
 *
 * Fixtures are made up (sentinel keys, round coordinates). Pure: no database,
 * no network.
 *
 * Run: node scripts/test-kpi-deadhead.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

const LIB_FILE = path.join(__dirname, "..", "lib", "kpi-deadhead.js");
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
if (!fs.existsSync(LIB_FILE)) die("lib/kpi-deadhead.js does not exist");
const SRC = fs.readFileSync(LIB_FILE, "utf8");
function compileLib(src) {
	const req = Module.createRequire(LIB_FILE);
	const m = { exports: {} };
	new Function("module", "exports", "require", "__filename", "__dirname", src)(m, m.exports, req, LIB_FILE, path.dirname(LIB_FILE));
	return m.exports;
}
function swap(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) die(`mutant anchor not found exactly once (${n}): ${from}`);
	return src.replace(from, () => to);
}

// The module under test; battery() swaps in a mutant.
let D = null;
let results = [];
function t(cond, name, detail) {
	results.push({ ok: !!cond, name: detail === undefined ? name : `${name} (${detail})` });
}
const TZ = "America/New_York";
const Z = (iso) => Date.parse(iso);
const HOUR = 3600 * 1000;
const LNG = { dallas: -96.8, atlanta: -84.4 };

// A live load on truck 7 with ELD times; every field can be overridden. Each
// load's pickup sits at (30 + n/10, -95) and its drop-off at (31 + n/10, -96),
// so every pair has its own key.
let seq = 0;
function L(key, o) {
	const n = ++seq;
	return {
		key, status: "Delivered", day: "2026-09-10", driverKey: "zed sentinel driver", truckKey: "",
		pickupText: "", dropoffText: "", completionText: "",
		eldTruckId: "7", pickupArriveMs: null, destArriveMs: null,
		originLat: 30 + n / 10, originLng: -95, destLat: 31 + n / 10, destLng: -96,
		statedEmptyMiles: null,
		...o,
	};
}
// The route table: every pair a chain can form, at a recognisable distance.
function routesFor(loads) {
	const m = new Map();
	let miles = 100;
	for (const a of loads) for (const b of loads) {
		if (a === b) continue;
		const k = D.pairKey({ lat: a.destLat, lng: a.destLng }, { lat: b.originLat, lng: b.originLng });
		if (k) m.set(k, { status: "ok", distanceMiles: miles++ });
	}
	return m;
}
const routeMiles = (routes, a, b) => routes.get(D.pairKey({ lat: a.destLat, lng: a.destLng }, { lat: b.originLat, lng: b.originLng })).distanceMiles;
function run(loads, opts) {
	const o = opts || {};
	const routes = o.routes || routesFor(loads);
	const out = D.computeDeadhead(loads, { timeZone: TZ, routes, truckAt: o.truckAt || null, truckIdByUnit: o.truckIdByUnit || new Map() });
	return { out, routes, get: (k) => out.byKey.get(k) };
}

function battery(mod) {
	D = mod;
	results = [];
	seq = 0;
	// ── chain basics ──────────────────────────────────────────────────────────────
	{
		seq = 0;
		const a = L("a", { pickupArriveMs: Z("2026-09-01T12:00:00Z"), destArriveMs: Z("2026-09-01T20:00:00Z") });
		const b = L("b", { pickupArriveMs: Z("2026-09-02T12:00:00Z"), destArriveMs: Z("2026-09-02T20:00:00Z") });
		const c = L("c", { status: "In Transit", pickupArriveMs: Z("2026-09-03T12:00:00Z"), destArriveMs: null });
		const d = L("d", { pickupArriveMs: Z("2026-09-04T12:00:00Z"), destArriveMs: Z("2026-09-04T20:00:00Z") });
		const x = L("x", { status: "Cancelled", pickupArriveMs: Z("2026-09-02T14:00:00Z"), destArriveMs: Z("2026-09-02T16:00:00Z") });
		const { get, routes } = run([d, x, c, b, a]);
		t(get("a").state === "first" && get("a").deadheadMiles === null, "the first load on a truck has no previous: unknown, null", JSON.stringify(get("a")));
		t(get("b").state === "chained" && get("b").prevKey === "a" && get("b").deadheadMiles === routeMiles(routes, a, b) && get("b").source === "route",
			"previous = the load just before by pickup; the pair's route distance", JSON.stringify(get("b")));
		t(!get("x"), "a cancelled load is not in the chain");
		t(get("c") && get("c").prevKey === "b" && get("c").state === "chained", "an in-progress load is in the chain");
		t(get("d").state === "prev_no_delivery" && get("d").deadheadMiles === null, "a previous with no delivery instant leaves the next load unknown", JSON.stringify(get("d")));
		const prevs = ["a", "b", "c", "d"].map((k) => get(k).prevKey).filter(Boolean);
		t(new Set(prevs).size === prevs.length, "each load is a previous once at most");
	}

	// ── truck source order ────────────────────────────────────────────────────────
	{
		seq = 0;
		const truckAt = { forDriverAt: (name, ms) => (name === "zed sentinel driver" && ms >= Z("2026-09-01T00:00:00Z") ? { truck_id: 8 } : null) };
		const byUnit = new Map([["unit-9", "9"]]);
		const eld = L("eld", { eldTruckId: "7", truckKey: "unit-9", pickupArriveMs: Z("2026-09-05T12:00:00Z"), destArriveMs: Z("2026-09-05T18:00:00Z") });
		const res = L("res", { eldTruckId: "", truckKey: "unit-9", pickupText: "9/6/2026 08:00", dropoffText: "9/6/2026 17:00", day: "2026-09-06", originLng: LNG.dallas, destLng: LNG.dallas });
		const col = L("col", { eldTruckId: "0", driverKey: "zed nobody", truckKey: "unit-9", pickupText: "9/7/2026 08:00", dropoffText: "9/7/2026 17:00", day: "2026-09-07", originLng: LNG.dallas, destLng: LNG.dallas });
		const none = L("none", { eldTruckId: "", driverKey: "zed nobody", truckKey: "unit-x", pickupText: "9/8/2026 08:00", day: "2026-09-08" });
		const { get, out } = run([eld, res, col, none], { truckAt, truckIdByUnit: byUnit });
		t(get("eld").truckId === "7" && get("eld").truckSource === "eld", "load_eld_miles' truck first, even when the Truck column names another", JSON.stringify(get("eld")));
		t(get("res").truckId === "8" && get("res").truckSource === "resolver", "no ELD truck: the driver's dated assignment at the pickup instant", JSON.stringify(get("res")));
		t(get("col").truckId === "9" && get("col").truckSource === "column", "no assignment either: the Truck column mapped to a truck id", JSON.stringify(get("col")));
		t(get("none").truckId === null && get("none").state === "no_truck" && get("none").deadheadMiles === null, "no truck at all: unknown", JSON.stringify(get("none")));
		t(out.counts.truckSource.eld === 1 && out.counts.truckSource.resolver === 1 && out.counts.truckSource.column === 1 && out.counts.truckSource.none === 1, "truck sources counted", JSON.stringify(out.counts.truckSource));
		// A load placed by the resolver or the Truck column, with no load_eld_miles
		// row, chains on its appointment times alone.
		seq = 0;
		const p1 = L("p1", { eldTruckId: "", truckKey: "unit-9", driverKey: "zed nobody", day: "2026-09-06", pickupText: "9/6/2026 08:00", dropoffText: "9/6/2026 17:00", originLng: LNG.dallas, destLng: LNG.dallas });
		const p2 = L("p2", { eldTruckId: "", truckKey: "unit-9", driverKey: "zed nobody", day: "2026-09-07", pickupText: "9/7/2026 07:00", dropoffText: "9/7/2026 15:00", originLng: LNG.dallas, destLng: LNG.dallas });
		const r2 = run([p2, p1], { truckIdByUnit: byUnit });
		t(r2.get("p2").state === "chained" && r2.get("p2").prevKey === "p1" && r2.get("p2").deadheadMiles === routeMiles(r2.routes, p1, p2),
			"loads placed by the Truck column chain on appointment times alone", JSON.stringify(r2.get("p2")));
	}

	// ── ties, overlap, restart ────────────────────────────────────────────────────
	{
		seq = 0;
		const a = L("a", { pickupArriveMs: Z("2026-09-01T10:00:00Z"), destArriveMs: Z("2026-09-01T15:00:00Z") });
		const k2 = L("k2", { pickupArriveMs: Z("2026-09-02T10:00:00Z"), destArriveMs: Z("2026-09-02T15:00:00Z") });
		const k1 = L("k1", { pickupArriveMs: Z("2026-09-02T10:00:00Z"), destArriveMs: Z("2026-09-02T14:00:00Z") });
		const one = run([a, k2, k1]);
		const two = run([k1, a, k2], { routes: one.routes });
		t(one.get("k1").prevKey === "a" && one.get("k2").prevKey === "k1", "two loads with the same pickup instant are ordered by load key", `${one.get("k1").prevKey}/${one.get("k2").prevKey}`);
		const same = ["a", "k1", "k2"].every((k) => JSON.stringify(one.get(k)) === JSON.stringify(two.get(k)));
		t(same, "the same chain whatever order the sheet lists them in");
		t(one.get("k2").state === "overlap" && one.get("k2").deadheadMiles === null, "k1 delivers after k2's pickup: an overlap, unknown");

		seq = 0;
		const p = L("p", { pickupArriveMs: Z("2026-09-01T08:00:00Z"), destArriveMs: Z("2026-09-01T20:00:00Z") });
		const q = L("q", { pickupArriveMs: Z("2026-09-01T18:00:00Z"), destArriveMs: Z("2026-09-02T02:00:00Z") });
		const r = L("r", { pickupArriveMs: Z("2026-09-01T19:00:00Z"), destArriveMs: Z("2026-09-01T23:00:00Z") });
		const ov = run([p, q, r]);
		t(ov.get("q").state === "overlap" && ov.get("r").state === "overlap" && ov.get("r").prevKey === "q",
			"a previous delivery strictly after this pickup is an overlap, and the chain never searches further back", `${ov.get("r").state} prev ${ov.get("r").prevKey}`);

		seq = 0;
		const e1 = L("e1", { pickupArriveMs: Z("2026-09-01T08:00:00Z"), destArriveMs: Z("2026-09-01T12:00:00Z") });
		const e2 = L("e2", { pickupArriveMs: Z("2026-09-01T12:00:00Z"), destArriveMs: Z("2026-09-01T16:00:00Z") });
		const e3 = L("e3", { pickupArriveMs: Z("2026-09-04T16:00:00Z"), destArriveMs: Z("2026-09-04T20:00:00Z") });
		const e4 = L("e4", { pickupArriveMs: Z("2026-09-07T20:01:00Z"), destArriveMs: Z("2026-09-07T23:00:00Z") });
		const eq = run([e1, e2, e3, e4]);
		t(eq.get("e2").state === "chained" && eq.get("e2").gapMs === 0, "equal instants chain with a gap of 0", JSON.stringify(eq.get("e2")));
		t(eq.get("e3").state === "chained" && eq.get("e3").gapMs === 72 * HOUR, "a gap of exactly 72 h chains", JSON.stringify(eq.get("e3")));
		t(eq.get("e4").state === "restart" && eq.get("e4").deadheadMiles === null, "72 h and 1 minute is a restart: not counted", JSON.stringify(eq.get("e4")));
	}

	// ── sources: stated, route, zero, unknown ─────────────────────────────────────
	{
		seq = 0;
		const a = L("a", { pickupArriveMs: Z("2026-09-01T10:00:00Z"), destArriveMs: Z("2026-09-01T15:00:00Z") });
		const b = L("b", { pickupArriveMs: Z("2026-09-01T12:00:00Z"), destArriveMs: Z("2026-09-01T18:00:00Z"), statedEmptyMiles: 45 });
		const c = L("c", { pickupArriveMs: Z("2026-09-02T10:00:00Z"), destArriveMs: Z("2026-09-02T15:00:00Z") });
		const d = L("d", { pickupArriveMs: Z("2026-09-03T10:00:00Z"), destArriveMs: Z("2026-09-03T15:00:00Z"), originLat: c.destLat + 0.00001, originLng: c.destLng });
		const e = L("e", { pickupArriveMs: Z("2026-09-04T10:00:00Z"), destArriveMs: Z("2026-09-04T15:00:00Z"), originLat: null });
		const f = L("f", { pickupArriveMs: Z("2026-09-05T10:00:00Z"), destArriveMs: Z("2026-09-05T15:00:00Z") });
		const loads = [a, b, c, d, e, f];
		const routes = routesFor(loads);
		routes.delete(D.pairKey({ lat: e.destLat, lng: e.destLng }, { lat: f.originLat, lng: f.originLng }));
		const { get, out } = run(loads, { routes });
		t(get("b").state === "overlap" && get("b").deadheadMiles === 45 && get("b").source === "stated", "a stated Empty Movement counts whatever the chain says (here an overlap)", JSON.stringify(get("b")));
		t(get("d").deadheadMiles === 0 && get("d").source === "route" && !out.pending.some((p) => p.pairKey === get("d").pairKey), "two points equal after rounding: 0 mi, no route call", JSON.stringify(get("d")));
		t(get("e").deadheadMiles === null && get("e").state === "chained", "a chained pair with a missing coordinate: unknown (null), never 0", JSON.stringify(get("e")));
		t(get("f").deadheadMiles === null && out.pending.length === 1 && out.pending[0].pairKey === get("f").pairKey, "a chained pair with no cached route: unknown, and the one pending route call", JSON.stringify(out.pending));
		const failedRoutes = new Map(routes);
		failedRoutes.set(get("c").pairKey, { status: "failed", distanceMiles: null });
		const withFailed = run(loads, { routes: failedRoutes });
		t(withFailed.get("c").deadheadMiles === null && withFailed.out.pending.some((p) => p.pairKey === get("c").pairKey),
			"a failed route is unknown and stays pending (the job's 30-day wait decides when it is asked again)");
		const stated = run([L("s1", { pickupArriveMs: Z("2026-09-01T10:00:00Z"), destArriveMs: Z("2026-09-01T15:00:00Z") }), L("s2", { pickupArriveMs: Z("2026-09-01T20:00:00Z"), destArriveMs: Z("2026-09-02T15:00:00Z"), statedEmptyMiles: 30 })], { routes: new Map() });
		t(stated.out.pending.length === 0 && stated.get("s2").deadheadMiles === 30, "no route call for a load whose rate con states its Empty Movement");
	}

	// ── pair keys ─────────────────────────────────────────────────────────────────
	{
		const k = D.pairKey({ lat: 29.76043, lng: -95.36980 }, { lat: 32.77666, lng: -96.79699 });
		t(k === "29.7604,-95.3698>32.7767,-96.797", "the pair key: each coordinate to 4 decimals, from > to", k);
		t(D.pairKey({ lat: 29.76044, lng: -95.36980 }, { lat: 32.77666, lng: -96.79699 }) === k, "a change in the 5th decimal is the same key");
		t(D.pairKey({ lat: 29.7605, lng: -95.36980 }, { lat: 32.77666, lng: -96.79699 }) !== k, "a change in the 4th decimal is a new key");
		t(D.pairKey({ lat: null, lng: -95 }, { lat: 1, lng: 2 }) === null && D.pairKey({ lat: 91, lng: -95 }, { lat: 1, lng: 2 }) === null, "a missing or impossible coordinate has no key");
		// Exactly 0,0 is a blank stored as zeros, never a dock: missing, so two of
		// them never read as "same place, 0 mi".
		t(D.pairKey({ lat: 0, lng: 0 }, { lat: 31, lng: -96 }) === null && D.pairKey({ lat: 31, lng: -96 }, { lat: 0, lng: 0 }) === null, "a 0,0 coordinate is missing: no pair key");
		t(!D.samePoint({ lat: 0, lng: 0 }, { lat: 0, lng: 0 }) && D.roundPoint(0, 0) === null, "two 0,0 points are not the same place");
		t(D.pairKey({ lat: 0, lng: -95 }, { lat: 31, lng: 0 }) !== null, "a single zero coordinate (the equator or the prime meridian) is still a point");
		const zz = run([
			L("z1", { pickupArriveMs: Z("2026-09-01T10:00:00Z"), destArriveMs: Z("2026-09-01T15:00:00Z"), destLat: 0, destLng: 0 }),
			L("z2", { pickupArriveMs: Z("2026-09-02T10:00:00Z"), destArriveMs: Z("2026-09-02T15:00:00Z"), originLat: 0, originLng: 0 }),
		], { routes: new Map() });
		t(zz.get("z2").state === "chained" && zz.get("z2").deadheadMiles === null && zz.out.pending.length === 0, "a pair whose ends are both 0,0 is unknown (null), never 0 mi, and asks no route", JSON.stringify(zz.get("z2")));
		t(D.samePoint({ lat: 29.76043, lng: -95.3698 }, { lat: 29.76044, lng: -95.36981 }) && !D.samePoint({ lat: 29.7604, lng: -95.3698 }, { lat: 29.7605, lng: -95.3698 }), "equal after rounding is the same point");
	}

	// ── timing (rule 2a) ──────────────────────────────────────────────────────────
	{
		const P = (text, lng, day) => D.pickupInstant(L("t", { eldTruckId: "", pickupText: text, originLng: lng, day: day || "2026-10-02" }), TZ);
		const Dl = (text, lng, day, completion) => D.deliveryInstant(L("t", { eldTruckId: "", dropoffText: text, destLng: lng, day: day || "2026-10-02", completionText: completion || "" }), TZ);
		const iso = (r) => (r && r.ms != null ? new Date(r.ms).toISOString() : null);
		t(iso(P("10/2/2026 14:00", LNG.dallas)) === "2026-10-02T19:00:00.000Z", "a pickup in the Central band reads 14:00 Chicago time", iso(P("10/2/2026 14:00", LNG.dallas)));
		t(iso(P("10/2/2026 14:00 EST", LNG.dallas)) === "2026-10-02T18:00:00.000Z", "a written EST beats the band", iso(P("10/2/2026 14:00 EST", LNG.dallas)));
		const noZone = P("10/2/2026 14:00", null);
		t(iso(noZone) === "2026-10-02T18:00:00.000Z" && noZone.zoneSource === "fallback", "no zone and no longitude reads APP_TIMEZONE, and says so", JSON.stringify(noZone));
		t(iso(P("10/2/2026 08:00-14:00", LNG.dallas)) === "2026-10-02T13:00:00.000Z", "a pickup window uses its start (08:00)");
		t(iso(Dl("10/2/2026 08:00-14:00", LNG.dallas)) === "2026-10-02T19:00:00.000Z", "a drop-off window uses its end (14:00)");
		t(iso(Dl("10/2/2026 22:00-02:00", LNG.dallas)) === "2026-10-03T07:00:00.000Z", "a drop-off window 22:00-02:00 ends the next day");
		t(iso(P("10/2/2026", LNG.dallas)) === "2026-10-02T05:00:00.000Z" && iso(P("10/2/2026 FCFS", LNG.dallas)) === "2026-10-02T05:00:00.000Z", "a date-only or FCFS pickup is 00:00 on the dock clock");
		t(iso(Dl("10/2/2026", LNG.dallas)) === "2026-10-03T04:59:59.999Z" && iso(Dl("10/2/2026 FCFS 07:00-15:00", LNG.dallas)) === "2026-10-03T04:59:59.999Z", "a date-only or FCFS drop-off is the day's last instant on the dock clock");
		const comp = Dl("", LNG.dallas, "2026-10-02", "10/2/2026 21:30");
		t(iso(comp) === "2026-10-03T01:30:00.000Z" && comp.source === "completion", "a Completion Date stamp reads in APP_TIMEZONE, not the receiver's band", JSON.stringify(comp));
		t(iso(Dl("", LNG.dallas, "2026-10-02", "2026-10-02")) === "2026-10-03T03:59:59.999Z", "a date-only Completion Date is that day's last instant in APP_TIMEZONE");
		const eld = D.deliveryInstant(L("t", { destArriveMs: Z("2026-10-02T15:00:00Z"), dropoffText: "10/2/2026 22:00" }), TZ);
		t(eld.ms === Z("2026-10-02T15:00:00Z") && eld.source === "eld", "the ELD arrival wins over the drop-off appointment");
		t(D.pickupInstant(L("t", { day: "2026-10-02", pickupArriveMs: 0, pickupText: "10/2/2026 08:00", originLng: LNG.dallas }), TZ).source === "appointment", "an ELD pickup of 0 is no pickup");
		// 3-day plausibility against the load's day; a missing year takes the nearest.
		t(P("9/28/2026 08:00", LNG.dallas, "2026-10-02").ms === null, "an appointment 4 days from the load's day is unusable");
		t(P("9/29/2026 08:00", LNG.dallas, "2026-10-02").ms !== null, "3 days from the load's day is kept");
		t(iso(P("12/31 08:00", LNG.dallas, "2027-01-01")) === "2026-12-31T14:00:00.000Z", "a missing year takes the year nearest the load's day");
		const fallsThrough = Dl("9/20/2026 08:00", LNG.dallas, "2026-10-02", "10/2/2026 10:00");
		t(fallsThrough.source === "completion", "an implausible drop-off appointment falls to the next source (the Completion Date)", JSON.stringify(fallsThrough));
	}

	// ── markers (3a) ──────────────────────────────────────────────────────────────
	{
		// A pickup appointment 10 days before its Completion Date, no other pickup
		// source: a marker, never a previous.
		seq = 0;
		const a = L("a", { pickupArriveMs: Z("2026-09-01T10:00:00Z"), destArriveMs: Z("2026-09-01T15:00:00Z") });
		const m = L("m", { day: "2026-09-12", pickupArriveMs: null, pickupText: "9/2/2026 08:00", originLng: LNG.dallas, completionText: "9/12/2026 10:00", destArriveMs: null });
		const b = L("b", { pickupArriveMs: Z("2026-09-12T20:00:00Z"), destArriveMs: Z("2026-09-13T02:00:00Z") });
		const r = run([a, m, b]);
		t(r.get("m").marker === true && r.get("m").state === "marker" && r.get("m").deadheadMiles === null, "a pickup appointment 10 days before its Completion Date: a marker, unknown", JSON.stringify(r.get("m")));
		t(r.get("b").state === "after_marker" && r.get("b").deadheadMiles === null && r.get("b").prevKey === "m", "the load after a marker is unknown, and never paired with the load before it", JSON.stringify(r.get("b")));

		// A pickup instant after the same load's delivery instant makes it a marker.
		seq = 0;
		const p = L("p", { pickupArriveMs: Z("2026-09-01T10:00:00Z"), destArriveMs: Z("2026-09-01T15:00:00Z") });
		const inverted = L("inv", { pickupArriveMs: Z("2026-09-03T10:00:00Z"), destArriveMs: Z("2026-09-02T09:00:00Z"), statedEmptyMiles: 25 });
		const n = L("n", { pickupArriveMs: Z("2026-09-02T12:00:00Z"), destArriveMs: Z("2026-09-02T18:00:00Z") });
		const r2 = run([p, inverted, n]);
		t(r2.get("inv").marker && r2.get("inv").deadheadMiles === 25 && r2.get("inv").source === "stated", "a pickup after its own delivery: a marker; its stated Empty Movement still counts", JSON.stringify(r2.get("inv")));
		t(r2.get("n").state === "after_marker" && r2.get("n").deadheadMiles === null, "...the next load's deadhead is unknown, never p-to-n miles", JSON.stringify(r2.get("n")));

		// A marker with no delivery instant sits at its day's last instant in APP_TIMEZONE.
		seq = 0;
		const q = L("q", { pickupArriveMs: Z("2026-09-01T10:00:00Z"), destArriveMs: Z("2026-09-01T15:00:00Z") });
		const blind = L("blind", { day: "2026-09-02", pickupArriveMs: null, destArriveMs: null, pickupText: "", dropoffText: "", completionText: "" });
		const early = L("early", { pickupArriveMs: Z("2026-09-03T03:30:00Z"), destArriveMs: Z("2026-09-03T08:00:00Z") });
		const late = L("late", { pickupArriveMs: Z("2026-09-03T04:30:00Z"), destArriveMs: Z("2026-09-03T09:00:00Z") });
		const r3 = run([q, blind, early]);
		t(r3.get("blind").marker && r3.get("blind").sortMs === Z("2026-09-03T03:59:59.999Z"), "a marker with no delivery instant sits at its day's last instant in APP_TIMEZONE", JSON.stringify(r3.get("blind")));
		t(r3.get("early").state === "before_marker", "a pickup at 23:30 that day sorts before the marker and is unknown (3b)", JSON.stringify(r3.get("early")));
		const r4 = run([q, blind, late]);
		t(r4.get("late").state === "after_marker" && r4.get("late").prevKey === "blind", "a pickup after that instant sorts after the marker", JSON.stringify(r4.get("late")));
	}

	// ── loads picked up before a marker's delivery (3b and the Low) ───────────────
	{
		// A (pickup day 1, delivery day 2), M (no usable pickup, delivery day 5), B
		// (pickup day 3, delivery day 6, no stated Empty Movement): B is unknown.
		seq = 0;
		const a = L("a", { pickupArriveMs: Z("2026-09-01T12:00:00Z"), destArriveMs: Z("2026-09-02T12:00:00Z") });
		const m = L("m", { day: "2026-09-05", pickupArriveMs: null, pickupText: "", destArriveMs: Z("2026-09-05T12:00:00Z") });
		const b = L("b", { pickupArriveMs: Z("2026-09-03T12:00:00Z"), destArriveMs: Z("2026-09-06T12:00:00Z") });
		const r = run([a, m, b]);
		t(r.get("b").state === "before_marker" && r.get("b").deadheadMiles === null, "3b: B picked up before the marker's delivery is unknown, never A-to-B miles", JSON.stringify(r.get("b")));

		// The Low: B picked up AND delivered between A and the marker's delivery.
		// "The last chained delivery" would include B's own delivery and pair B with
		// A; every load picked up within 72 h before the marker's delivery is unknown.
		seq = 0;
		const a2 = L("a2", { pickupArriveMs: Z("2026-09-01T06:00:00Z"), destArriveMs: Z("2026-09-01T12:00:00Z") });
		const b2 = L("b2", { pickupArriveMs: Z("2026-09-02T08:00:00Z"), destArriveMs: Z("2026-09-02T16:00:00Z") });
		const m2 = L("m2", { day: "2026-09-03", pickupArriveMs: null, pickupText: "", completionText: "", destArriveMs: Z("2026-09-03T10:00:00Z") });
		const r2 = run([a2, b2, m2]);
		t(r2.get("m2").marker, "a load with no pickup source is a marker at its delivery", JSON.stringify(r2.get("m2")));
		t(r2.get("b2").state === "before_marker" && r2.get("b2").deadheadMiles === null,
			"the Low: a load picked up and delivered between A and the marker's delivery is unknown, not paired with A", JSON.stringify(r2.get("b2")));
		const withStated = run([a2, { ...b2, statedEmptyMiles: 12 }, m2]);
		t(withStated.get("b2").deadheadMiles === 12 && withStated.get("b2").source === "stated", "...unless its rate con states its Empty Movement");

		// A load picked up more than 72 h before the marker's delivery still chains.
		seq = 0;
		const a3 = L("a3", { pickupArriveMs: Z("2026-09-01T06:00:00Z"), destArriveMs: Z("2026-09-01T12:00:00Z") });
		const b3 = L("b3", { pickupArriveMs: Z("2026-09-01T20:00:00Z"), destArriveMs: Z("2026-09-02T04:00:00Z") });
		const m3 = L("m3", { day: "2026-09-04", pickupArriveMs: null, destArriveMs: Z("2026-09-04T20:00:01Z") });
		const r3 = run([a3, b3, m3]);
		t(r3.get("b3").state === "chained" && r3.get("b3").prevKey === "a3", "a pickup more than 72 h before the marker's delivery still chains", JSON.stringify(r3.get("b3")));
		const m4 = { ...m3, destArriveMs: Z("2026-09-04T20:00:00Z") };
		t(run([a3, b3, m4]).get("b3").state === "before_marker", "exactly 72 h before the marker's delivery is within the window");
	}

	// ── counts and aggregates ─────────────────────────────────────────────────────
	{
		seq = 0;
		const { out } = run([
			L("a", { eldTruckId: "", truckKey: "", driverKey: "", day: "2026-10-02", pickupText: "10/2/2026 08:00", originLng: null }),
			L("b", { eldTruckId: "7", day: null, pickupArriveMs: null, destArriveMs: null }),
		]);
		t(out.counts.zoneFallback === 1, "a reading on APP_TIMEZONE for want of a location is counted", JSON.stringify(out.counts));
		t(out.counts.unplaced === 1, "a load with no instant and no day cannot be placed and is counted", JSON.stringify(out.counts));
	}
	return results;
}

// ── run: the shipped module, then each mutant ────────────────────────────────
let pass = 0;
const failures = [];
for (const r of battery(compileLib(SRC))) {
	if (r.ok) pass++;
	else failures.push(r.name);
}

// Each plausible regression must fail the check named beside it.
const MUTANTS = [
	["3b as first written: only loads picked up after the last chained delivery", "the Low:",
		"if (markerTimes.some((m) => r.pickupMs <= m && r.pickupMs >= m - MARKER_LOOKBACK_MS)) {",
		"if (markerTimes.some((m) => { const last = Math.max(-Infinity, ...list.filter((x) => !x.result.marker && x.result.deliveryMs != null && x.result.deliveryMs < m).map((x) => x.result.deliveryMs)); return r.pickupMs > last && r.pickupMs < m; })) {"],
	["markers dropped from the chain (the first draft)", "the load after a marker is unknown",
		"entries.push({ key, load: raw, result });", "if (!marker) entries.push({ key, load: raw, result });"],
	["a gap of exactly 72 h made a restart", "a gap of exactly 72 h chains",
		"r.state = r.gapMs > RESTART_MS ? \"restart\" : \"chained\";", "r.state = r.gapMs >= RESTART_MS ? \"restart\" : \"chained\";"],
	["equal instants read as an overlap", "equal instants chain",
		"else if (prev.result.deliveryMs > r.pickupMs) r.state = \"overlap\";", "else if (prev.result.deliveryMs >= r.pickupMs) r.state = \"overlap\";"],
	["ties left in the sheet's order", "ordered by load key",
		"|| (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)", "|| 0"],
	["a pickup window read at its end", "a pickup window uses its start",
		"else if (p.kind === \"window\") ms = end ? p.deadlineMs : p.startMs;", "else if (p.kind === \"window\") ms = p.deadlineMs;"],
	["an unknown leg counted as 0", "unknown, null",
		"pairKey: null, deadheadMiles: null, source: null,", "pairKey: null, deadheadMiles: 0, source: null,"],
	["a stated Empty Movement ignored", "a stated Empty Movement counts",
		"if (stated != null) {", "if (stated != null && false) {"],
	["a failed route dropped from pending (never retried)", "a failed route is unknown and stays pending",
		"} else if (!cached || cached.status !== \"ok\") {", "} else if (!cached) {"],
	["0,0 read as a place", "a pair whose ends are both 0,0 is unknown",
		"\tif (lat === 0 && lng === 0) return null;\n", ""],
	["the 3b window widened past 72 h", "more than 72 h before the marker's delivery still chains",
		"const MARKER_LOOKBACK_MS = 72 * HOUR_MS;", "const MARKER_LOOKBACK_MS = 96 * HOUR_MS;"],
];
for (const [name, expect, from, to] of MUTANTS) {
	let res;
	try {
		res = battery(compileLib(swap(SRC, from, to)));
	} catch (e) {
		res = [{ ok: false, name: `${expect} (the mutant threw: ${e && e.message})` }];
	}
	const caught = res.some((r) => !r.ok && r.name.includes(expect));
	if (caught) pass++;
	else failures.push(`MUTANT ${name}: not caught by "${expect}"`);
}

if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed (${MUTANTS.length} mutants caught)`);
