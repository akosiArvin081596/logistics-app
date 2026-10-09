#!/usr/bin/env node
/**
 * The KPI bot's formulas (lib/kpi-metrics.js) and catalog (lib/kpi-catalog.js).
 *
 * §1  helpers: the delivered statuses, month series, display strings, compare()
 *     (a missing or zero base is 'missing'), before/after windows, confidence,
 *     the derived AI dispatch start.
 * §2  loads delivered: delivered statuses only, cancelled rows ignored, undated
 *     loads counted and kept out of the months, gap months "No records" (never
 *     0), MoM / YoY / trailing-3-month YoY, a zero base 'missing'.
 * §3  freight: stated tons (lb / 2,000), details before the rate con, coverage,
 *     the estimate (average stated weight) and its 20-load floor.
 * §4  revenue: each delivered load's Payment, per month; gaps, YoY, coverage.
 * §5  ELD miles and truck utilization: distinct truck-days, service dates, the
 *     before/after windows (equal, never overlapping, event day = after).
 * §6  paid-mile share: full-ELD loads only, an unmeasured leg is never 0.
 * §7  on-time: strict and by-day rates, exclusions counted, the review warning.
 * §8  fleet: today's count applies Inactive, history never does, snapshots win.
 * §9  fuel: MPG over months with both, savings vs a baseline (missing without
 *     one), $/gal from receipts with gallons, CO2 at 10.18 kg/gal, Rejected out.
 * §10 tasks: AI and automation counts by kind; dispatch calls not tracked.
 * §11 catalog: keys, order, constants, settingsHashFor(), approvalIsValid().
 * §12 buildKpiResponse(): the GET /api/admin/kpis shape, approvals and stale
 *     approvals, a missing snapshot, a broken payload, payload size.
 * §13 nothing identifying leaves: every load id, driver key and truck id in the
 *     fixtures is a sentinel, and neither output contains one.
 * §14 MUTANTS: each plausible regression, applied to the shipped source, must
 *     fail the section that guards it.
 *
 * Fixtures are fake ("Zed Sentinel" names, sentinel ids). Pure: no server, no
 * database, no files written.
 *
 * Run: node scripts/test-kpi-metrics.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "lib");
const SOURCES = {
	metrics: fs.readFileSync(path.join(LIB, "kpi-metrics.js"), "utf8"),
	catalog: fs.readFileSync(path.join(LIB, "kpi-catalog.js"), "utf8"),
};

let pass = 0;
const failures = [];
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }

// ── loading the shipped source, mutated or not ──────────────────────────────
// A copy of a lib module compiled from source text, its requires resolved from
// lib/ except the ones `overrides` replaces (a mutated catalog under the real
// metrics module).
function compileLib(file, src, overrides) {
	const filename = path.join(LIB, file);
	const req = Module.createRequire(filename);
	const localRequire = (id) => (overrides && Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : req(id));
	const m = { exports: {} };
	new Function("module", "exports", "require", "__filename", "__dirname", src)(m, m.exports, localRequire, filename, LIB);
	return m.exports;
}
function swap(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) die(`mutant anchor not found exactly once (${n}): ${from}`);
	return src.replace(from, () => to);
}
const REAL = { metrics: compileLib("kpi-metrics.js", SOURCES.metrics), catalog: compileLib("kpi-catalog.js", SOURCES.catalog) };

// ── fixtures ─────────────────────────────────────────────────────────────────
const AS_OF = "2026-10-09";
const DAY_MS = 86400000;
const dayAdd = (day, n) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), 12) + n * DAY_MS).toISOString().slice(0, 10);
const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const isWeekend = (day) => weekday(day) === 0 || weekday(day) === 6;
function eachDay(from, to, f) { for (let d = from; d <= to; d = dayAdd(d, 1)) f(d); }

const DRIVER = (x) => `zed sentinel driver ${x}`;
const TRUCK = (n) => `TRUCK-SENTINEL-${n}`;
let seq = 0;
const nextId = () => `LOAD-SENTINEL-${++seq}`;
const W40 = "Commodity: paper rolls. Weight: 40,000 lbs";

function load(day, status, o) {
	const x = o || {};
	return {
		loadId: x.id || nextId(), status, day, contractIdBlank: !!x.ai,
		driverKey: x.driver === undefined ? DRIVER("a") : x.driver, truckKey: "zed-sentinel-truck",
		detailsText: x.details === undefined ? W40 : x.details,
		revenue: x.revenue === undefined ? null : x.revenue,
	};
}

function world(over) {
	seq = 0;
	const o = over || {};
	const loads = [];
	const ratecon = [];
	const add = (day, status, x) => { const l = load(day, status, x); loads.push(l); return l; };
	// 2025
	add("2025-04-15", "Delivered", { id: "LOAD-SENTINEL-77", driver: DRIVER("a") });
	const rc1 = add("2025-04-28", "Delivered", { driver: DRIVER("b"), details: "Commodity: paper rolls" });
	ratecon.push({ loadId: rc1.loadId, status: "ok", weightLb: 38000 });
	add("2025-05-06", "Delivered", { details: "Gross Weight: 43,764 lb" });
	const rc2 = add("2025-05-20", "Delivered", { driver: DRIVER("b"), details: "Commodity: frozen food" });
	ratecon.push({ loadId: rc2.loadId, status: "conflict", weightLb: null });
	add("2025-06-10", "Delivered", { ai: true, details: "42000#" });
	add("2025-07-08", "Delivered", { details: "Weight: 41,000 lbs" });
	add("2025-07-22", "Delivered", { driver: DRIVER("b"), details: "19,050 kg" });
	add("2025-08-05", "Delivered", { details: "Weight: 39,500" });
	add("2025-08-19", "Delivered", { driver: DRIVER("b"), details: "Commodity: produce" });
	add("2025-09-03", "Delivered");
	add("2025-09-10", "POD Received", { driver: DRIVER("b") });
	add("2025-09-17", "Completed", { details: "Weight: 44,000 lbs" });
	add("2025-09-24", " delivered ", { driver: DRIVER("b"), details: "Commodity: produce" });
	add("2025-09-25", "Delivery Scheduled");
	add("2025-10-07", "Delivery Scheduled");
	add("2025-10-14", "In Transit");
	add("2025-11-04", "Delivered");
	add("2025-11-18", "Delivered");
	// December 2025 to March 2026: no rows at all.
	// 2026
	add("2026-04-09", "Delivered", { ai: true, driver: DRIVER("c") });
	add("2026-04-12", "Delivered", { ai: true, driver: DRIVER("c") });
	add("2026-04-20", "Delivered", { ai: true, driver: DRIVER("d") });
	add("2026-04-25", "Delivered", { driver: DRIVER("d") });
	for (const [d, x] of [["2026-05-05", "c"], ["2026-05-14", "d"], ["2026-05-26", "c"], ["2026-06-03", "c"], ["2026-06-17", "d"], ["2026-06-29", "e"],
		["2026-07-07", "c"], ["2026-07-15", "d"], ["2026-07-28", "e"], ["2026-08-04", "c"], ["2026-08-18", "d"], ["2026-08-31", "e"]]) {
		add(d, "Delivered", { driver: DRIVER(x) });
	}
	add("2026-09-02", "Delivered", { driver: DRIVER("c") });
	const dw = add("2026-09-08", "Delivered", { driver: DRIVER("d"), details: "Weight: 42,000 lbs" });
	ratecon.push({ loadId: dw.loadId, status: "ok", weightLb: 40000 });
	add("2026-09-14", "Delivered", { driver: DRIVER("e") });
	const cf = add("2026-09-21", "Delivered", { driver: DRIVER("c"), details: "Est. Weight 40,000 lbs; Actual Weight: 42,500 lbs" });
	ratecon.push({ loadId: cf.loadId, status: "ok", weightLb: 41000 });
	add("2026-09-23", "Delivered", { driver: DRIVER("f") });
	add("2026-09-29", "Delivered", { driver: DRIVER("d") });
	add("2026-09-25", "Delivery Scheduled", { driver: DRIVER("c") });
	add("2026-09-26", "Cancelled", { ai: true, driver: DRIVER("g") });
	add("2026-10-02", "Delivered", { driver: DRIVER("c") });
	add("2026-10-06", "Delivered", { driver: DRIVER("d") });
	// Undated: no day, before April 2025, after the run day.
	add(null, "Delivered", { driver: DRIVER("h") });
	add("2024-12-01", "Delivered", { driver: DRIVER("h") });
	add("2026-12-01", "Delivered", { driver: DRIVER("h") });

	// Revenue: each delivered, dated load's Payment, in load order per month, so
	// the months add up to round figures; undated loads carry one too (it must
	// stay out of the months).
	const REVENUE = {
		"2025-04": [4500, 4500], "2025-05": [5500, 5500], "2025-06": [6000], "2025-07": [7000, 7000], "2025-08": [6250, 6250],
		"2025-09": [4350, 4350, 4350, 4350], "2025-11": [7500, 7500], "2026-04": [7500, 7500, 7500, 7500],
		"2026-05": [12000, 11500, 11500], "2026-06": [14000, 13500, 13500], "2026-07": [15000, 14500, 14500],
		"2026-08": [14250.5, 14000, 14000], "2026-09": [9000, 9000, 9000, 9000, 9000, 8344.12], "2026-10": [4000, 4000],
	};
	for (const l of loads) {
		if (!/^(delivered|completed|pod received)$/i.test(String(l.status).trim())) continue;
		const list = l.day && l.day >= "2025-04-01" && l.day <= (o.asOfDay || AS_OF) ? REVENUE[l.day.slice(0, 7)] : null;
		l.revenue = list && list.length ? list.shift() : 5000;
	}
	if (o.unpaid) for (const l of loads) if (l.day === o.unpaid) l.revenue = 0;

	// ELD: truck 1 every day from 2026-05-28 (weekdays 400 mi, weekends 0.5 mi of
	// yard moves), truck 2 weekdays from 2026-06-15 (300 mi), and a second row
	// for truck 1 on Tuesday 2026-09-15 (a re-run of the rollup: one truck-day).
	const eldDaily = [];
	eachDay("2026-05-28", "2026-10-08", (d) => eldDaily.push({ day: d, truckId: TRUCK(1), miles: isWeekend(d) ? 0.5 : 400 }));
	eachDay("2026-06-15", "2026-10-08", (d) => { if (!isWeekend(d)) eldDaily.push({ day: d, truckId: TRUCK(2), miles: 300 }); });
	eldDaily.push({ day: "2026-09-15", truckId: TRUCK(1), miles: 100 });

	const trucks = [
		{ id: TRUCK(1), status: "Active", createdDay: "2026-04-01", inServiceDay: "2026-04-10", retiredDay: null, hasEld: true },
		{ id: TRUCK(2), status: "Active", createdDay: "2026-06-01", inServiceDay: null, retiredDay: null, hasEld: true },
		{ id: TRUCK(3), status: "Inactive", createdDay: "2026-05-01", inServiceDay: "2026-05-01", retiredDay: null, hasEld: false },
		{ id: TRUCK(4), status: "Active", createdDay: "2026-04-20", inServiceDay: "2026-04-20", retiredDay: "2026-08-15", hasEld: false },
		{ id: TRUCK(5), status: "Maintenance", createdDay: "2026-09-20", inServiceDay: "2026-09-20", retiredDay: null, hasEld: false },
	];

	const fuelReceipts = [
		{ day: "2026-04-15", amount: 2400, gallons: 500, status: "Approved" },
		{ day: "2026-05-10", amount: 2900, gallons: 600, status: "Approved" },
		{ day: "2026-05-30", amount: 2000, gallons: 400, status: null },
		{ day: "2026-06-05", amount: 3000, gallons: 600, status: "Approved" },
		{ day: "2026-06-15", amount: 3500, gallons: 700, status: "Approved" },
		{ day: "2026-06-25", amount: 3500, gallons: 700, status: "Approved" },
		{ day: "2026-07-14", amount: 10500, gallons: 2100, status: "Approved" },
		{ day: "2026-08-12", amount: 10250, gallons: 2050, status: "Approved" },
		{ day: "2026-08-20", amount: 300, gallons: null, status: "Pending" },
		{ day: "2026-09-04", amount: 6000, gallons: 1200, status: "Approved" },
		{ day: "2026-09-18", amount: 4000, gallons: 800, status: "Approved" },
		{ day: "2026-09-19", amount: 4500, gallons: 900, status: "Rejected" },
		{ day: "2026-09-22", amount: 400, gallons: null, status: "Approved" },
		{ day: "2026-10-03", amount: 1500, gallons: 300, status: "Approved" },
	];

	const ev = (at, source) => ({ at, source });
	const arrivals = [
		{ loadId: "LOAD-SENTINEL-77", appointmentText: "9/3/2025 08:00", destLng: -96.8, eldArriveMs: null, receiverEvents: [], deliveredDay: "2025-09-03" },
		{ loadId: nextId(), appointmentText: "6/3/2026 08:00", destLng: -96.8, eldArriveMs: Date.parse("2026-06-03T12:00:00Z"), receiverEvents: [], deliveredDay: "2026-06-03" },
		{ loadId: nextId(), appointmentText: "8/4/2026 08:00", destLng: -96.8, eldArriveMs: Date.parse("2026-08-04T15:00:00Z"), receiverEvents: [], deliveredDay: "2026-08-04" },
		{ loadId: nextId(), appointmentText: "9/2/2026 08:00", destLng: -96.8, eldArriveMs: Date.parse("2026-09-02T12:45:00Z"), receiverEvents: [], deliveredDay: "2026-09-02" },
		{ loadId: nextId(), appointmentText: "Appt: 9/8/2026 08:00-14:00", destLng: -84.4, eldArriveMs: 0, receiverEvents: [ev("2026-09-08 17:30:00", "geofence")], deliveredDay: "2026-09-08" },
		{ loadId: nextId(), appointmentText: "9/14/2026 10:00", destLng: -118.2, eldArriveMs: Date.parse("2026-09-15T15:30:00Z"), receiverEvents: [], deliveredDay: "2026-09-15" },
		{ loadId: nextId(), appointmentText: "9/21/2026", destLng: -96.8, eldArriveMs: Date.parse("2026-09-21T15:00:00Z"), receiverEvents: [], deliveredDay: "2026-09-21" },
		{ loadId: nextId(), appointmentText: "9/23/2026 09:00", destLng: null, eldArriveMs: Date.parse("2026-09-23T14:00:00Z"), receiverEvents: [], deliveredDay: "2026-09-23" },
		{ loadId: nextId(), appointmentText: "9/29/2020 09:00", destLng: -96.8, eldArriveMs: Date.parse("2026-09-29T14:00:00Z"), receiverEvents: [], deliveredDay: "2026-09-29" },
		{ loadId: nextId(), appointmentText: "9/30/2026 09:00", destLng: -96.8, eldArriveMs: 0, receiverEvents: [], deliveredDay: "2026-09-30" },
		{ loadId: nextId(), appointmentText: "9/14/2026 08:00", destLng: -96.8, eldArriveMs: null, receiverEvents: [ev("2026-09-14 12:00:00", "manual")], deliveredDay: "2026-09-14" },
		// The fall-back day: 09:00 Eastern is 14:00 UTC on 2026-11-01.
		{ loadId: nextId(), appointmentText: "11/1/2026 09:00", destLng: -80.2, eldArriveMs: Date.parse("2026-11-01T13:30:00Z"), receiverEvents: [], deliveredDay: "2026-11-01" },
	];

	const lm = (day, loaded, deadhead, x) => ({
		loadId: nextId(), day, loadedMiles: loaded, deadheadMiles: deadhead, basis: "eld",
		loadedBasis: "eld", deadheadBasis: "eld", inProgress: false, overlap: false, ...(x || {}),
	});
	const loadMiles = [
		lm("2026-07-10", 500, 100, { loadedBasis: "none", deadheadBasis: "none", basis: "none" }),
		lm("2026-08-30", 800, 200), lm("2026-09-03", 800, 200), lm("2026-09-10", 800, 200), lm("2026-09-17", 800, 200),
		lm("2026-09-24", 600, 400), lm("2026-10-01", 800, 200),
		lm("2026-09-28", 100, 900, { inProgress: true }),
		lm("2026-09-12", 100, 900, { overlap: true }),
		lm("2026-09-15", 700, 300, { loadedBasis: "partial", basis: "partial" }),
		lm("2026-09-20", null, 1000),
	];

	const activity = {
		aiReceipts: ["2026-05-03", "2026-09-04", "2026-09-18", "not-a-day"],
		aiExpenseInsights: ["2026-09-30"],
		geofenceStatuses: ["2026-06-02", "2026-09-03", "2026-09-04"],
		invoiceAutogenRuns: ["2026-09-05"],
	};

	return {
		asOfDay: o.asOfDay || AS_OF,
		settings: { aiDispatchStart: null, dedicatedStart: "2026-08-30", baselineMpg: 6.5, ...(o.settings || {}) },
		loads, ratecon, eldDaily, trucks,
		fleetHistory: [{ day: "2026-08-31", value: 5 }],
		fuelReceipts, arrivals, loadMiles, activity,
	};
}

// ── reference figures, computed straight from the fixture ────────────────────
function eldMilesIn(from, to) {
	let t = 0;
	for (const r of world().eldDaily) if (r.day >= from && r.day <= to) t += r.miles;
	return t;
}
function weekdaysIn(from, to) {
	let n = 0;
	eachDay(from, to, (d) => { if (!isWeekend(d)) n++; });
	return n;
}
const close = (a, b, eps) => typeof a === "number" && Math.abs(a - b) <= (eps == null ? 1e-9 : eps);

// ── the battery ──────────────────────────────────────────────────────────────
function battery(mods) {
	const r = [];
	const t = (cond, name, detail) => r.push({ ok: !!cond, name: detail === undefined ? name : `${name} (${detail})` });
	const M = mods.metrics;
	const C = mods.catalog;
	let out;
	let out2;
	try {
		out = M.computeKpis(world());
		out2 = M.computeKpis(world({ asOfDay: "2026-11-09" }));
	} catch (e) {
		t(false, "§0 computeKpis runs on the fixtures", e && e.message);
		return r;
	}
	const get = (o, key) => o.metrics.find((m) => m.key === key);
	const ser = (m, period) => m.series.find((s) => s.period === period);
	const cmp = (m, kind) => m.comparisons.find((c) => c.kind === kind);

	// §1 helpers
	{
		t(M.isDeliveredStatus("Delivered") && M.isDeliveredStatus(" pod received ") && M.isDeliveredStatus("COMPLETED"), "§1 Delivered / POD Received / Completed are delivered");
		t(!M.isDeliveredStatus("Delivery Scheduled") && !M.isDeliveredStatus("Undelivered") && !M.isDeliveredStatus("Cancelled") && !M.isDeliveredStatus(""), "§1 Delivery Scheduled, Undelivered, Cancelled, blank are not");
		const ms = M.monthSeries("2025-11", "2026-02");
		t(JSON.stringify(ms) === JSON.stringify(["2025-11", "2025-12", "2026-01", "2026-02"]), "§1 monthSeries crosses a year end", ms.join(","));
		t(M.addDays("2026-03-07", 1) === "2026-03-08" && M.addDays("2026-03-08", 1) === "2026-03-09" && M.addDays("2026-11-01", 1) === "2026-11-02", "§1 addDays steps one calendar day across both DST changes");
		t(M.formatDisplay("usd", 53344.12) === "$53,344" && M.formatDisplay("usd", -1153.85) === "-$1,154", "§1 usd display", M.formatDisplay("usd", 53344.12));
		t(M.formatDisplay("lb_tons", 1953.4) === "1,953 t" && M.formatDisplay("lb_tons", 62) === "62.0 t", "§1 tons display");
		t(M.formatDisplay("pct", 30) === "30.0%" && M.formatDisplay("mpg", 8) === "8.0 mpg" && M.formatDisplay("miles", 22245.4) === "22,245 mi", "§1 pct / mpg / miles display");
		t(M.formatDisplay("t_co2", 122.23) === "122 t CO2" && M.formatDisplay("trucks", 1) === "1 truck" && M.formatDisplay("trucks", 8) === "8 trucks", "§1 CO2 and trucks display");
		t(M.formatDisplay("count", null) === "No data" && M.formatDisplay("count", NaN) === "No data", "§1 null displays No data, never 0");
		const c1 = M.compare({ kind: "yoy", label: "x", basePeriod: "2025-09", value: 6, baseValue: 4, unit: "count" });
		t(c1.status === "ok" && c1.deltaPct === 50 && c1.display === "+50.0%", "§1 compare: 6 vs 4 is +50.0%", JSON.stringify(c1));
		const c0 = M.compare({ kind: "yoy", label: "x", basePeriod: "2025-10", value: 5, baseValue: 0, unit: "count" });
		t(c0.status === "missing" && c0.deltaPct === null, "§1 compare: a zero base is missing, not +Infinity", JSON.stringify(c0));
		const cn = M.compare({ kind: "yoy", label: "x", basePeriod: "2025-10", value: 5, baseValue: null, unit: "count" });
		t(cn.status === "missing" && cn.deltaPct === null, "§1 compare: a missing base is missing");
		const cp = M.compare({ kind: "mom", label: "x", basePeriod: "2026-08", value: 36, baseValue: 30, unit: "pct" });
		t(cp.display === "+6.0 pts" && cp.deltaPct === 20, "§1 compare: a rate's display is in points, deltaPct relative", JSON.stringify(cp));
		t(M.confidenceFor("real", "ok", 0.9, []) === "high" && M.confidenceFor("real", "partial", 0.5, []) === "medium"
			&& M.confidenceFor("proxy", "ok", 1, []) === "medium" && M.confidenceFor("estimate", "ok", 1, []) === "low"
			&& M.confidenceFor("real", "ok", 1, ["w"]) === "low" && M.confidenceFor("real", "missing", null, []) === "none"
			&& M.confidenceFor("not_tracked", "not_tracked", null, []) === "none", "§1 confidence rules");
		const d1 = M.deriveAiDispatchStart(["2025-06-10", "2026-04-20", "2026-04-09", "2026-04-12"]);
		t(d1.value === "2026-04-09" && /3 such loads in the 14 days from 2026-04-09/.test(d1.evidence), "§1 derived AI start skips a lone early load", JSON.stringify(d1));
		t(M.deriveAiDispatchStart(["2026-04-01", "2026-04-15", "2026-04-29"]).value === null, "§1 three loads spread over 29 days are no start");
		// before/after on a synthetic metric: one sample per day, value 10 before 2026-06-01 and 20 from it.
		const measure = (from, to) => {
			let n = 0;
			let s = 0;
			eachDay(from, to, (d) => { n++; s += d < "2026-06-01" ? 10 : 20; });
			return { value: n ? s / n : null, n };
		};
		const ba = M.beforeAfter({ event: "dedicated", date: "2026-06-01", dataStart: "2026-05-01", asOfDay: "2026-07-15", measure, unit: "count", sampleWord: "days", notSetNote: "n" });
		t(ba.status === "ok" && ba.before.n === 31 && ba.after.n === 31 && ba.before.value === 10 && ba.after.value === 20 && ba.deltaPct === 100,
			"§1 before/after: equal 31-day windows, the event day counts as after, no overlap", JSON.stringify(ba));
		const few = M.beforeAfter({ event: "dedicated", date: "2026-06-01", dataStart: "2026-05-25", asOfDay: "2026-07-15", measure, unit: "count", sampleWord: "days", notSetNote: "n" });
		t(few.status === "insufficient" && few.before.n === 7, "§1 before/after: 7 days before is insufficient (needs 14)", JSON.stringify(few));
		const none = M.beforeAfter({ event: "ai_dispatch", date: "2026-04-09", dataStart: "2026-05-28", asOfDay: "2026-07-15", measure, unit: "count", sampleWord: "days", notSetNote: "n" });
		t(none.status === "missing" && none.before.value === null, "§1 before/after: records starting after the date leave no before ('missing')");
		const unset = M.beforeAfter({ event: "dedicated", date: null, dataStart: "2026-05-28", asOfDay: "2026-07-15", measure, unit: "count", sampleWord: "days", notSetNote: "Set it." });
		t(unset.status === "date_not_set" && unset.before === null && unset.note === "Set it.", "§1 before/after: no date is date_not_set");
	}

	// §2 loads delivered
	{
		const m = get(out, "loads_delivered");
		t(m.current.label === "September 2026" && m.current.from === "2026-09-01" && m.current.to === "2026-09-30", "§2 current is the last complete month");
		t(m.value === 6 && m.display === "6", "§2 September 2026: 6 delivered (Delivery Scheduled and Cancelled not counted)", m.value);
		t(ser(m, "2025-09").value === 4, "§2 September 2025: Delivered, POD Received, Completed and ' delivered ' count", ser(m, "2025-09").value);
		t(ser(m, "2025-10").value === 0 && ser(m, "2025-10").display === "0", "§2 October 2025 has rows but no deliveries: a real 0");
		for (const p of ["2025-12", "2026-01", "2026-02", "2026-03"]) {
			t(ser(m, p).value === null && ser(m, p).display === "No records", `§2 ${p} has no rows: No records, not 0`, JSON.stringify(ser(m, p)));
		}
		t(m.series[0].period === "2025-04" && m.series[m.series.length - 1].period === "2026-10" && m.series.length === 19, "§2 series runs April 2025 to the run month");
		const all = m.totals.find((x) => x.label === "All time");
		const mtd = m.totals.find((x) => x.label === "Month to date");
		t(all.value === 39 && all.from === "2025-04-15" && all.to === AS_OF, "§2 all time: 39 dated deliveries, from the first load's day", `${all.value} ${all.from}`);
		t(mtd.value === 2 && mtd.from === "2026-10-01", "§2 month to date: 2", mtd.value);
		t(m.coverage.num === 39 && m.coverage.den === 42, "§2 three undated deliveries are counted in coverage", JSON.stringify(m.coverage));
		t(m.breakdown.some((b) => /Undated/.test(b.label) && b.value === 3), "§2 breakdown reports the 3 undated loads");
		t(cmp(m, "mom").deltaPct === 100 && cmp(m, "mom").basePeriod === "2026-08", "§2 MoM: 6 vs 3 = +100%", JSON.stringify(cmp(m, "mom")));
		t(cmp(m, "yoy").deltaPct === 50 && cmp(m, "yoy").baseValue === 4 && cmp(m, "yoy").label === "vs September 2025", "§2 YoY: 6 vs 4 = +50%", JSON.stringify(cmp(m, "yoy")));
		t(cmp(m, "t3m_yoy").value === 12 && cmp(m, "t3m_yoy").baseValue === 8 && cmp(m, "t3m_yoy").deltaPct === 50
			&& cmp(m, "t3m_yoy").label === "Jul–Sep 2026 vs Jul–Sep 2025", "§2 trailing 3 months YoY: 12 vs 8", JSON.stringify(cmp(m, "t3m_yoy")));
		t(m.status === "ok" && m.confidence === "high", "§2 status ok, confidence high", `${m.status}/${m.confidence}`);
		const m2 = get(out2, "loads_delivered");
		t(m2.value === 2 && cmp(m2, "yoy").status === "missing" && cmp(m2, "yoy").deltaPct === null && cmp(m2, "yoy").baseValue === 0,
			"§2 October 2026 (2) vs October 2025 (0): YoY on a zero base is missing", JSON.stringify(cmp(m2, "yoy")));
		const a = get(out, "active_units");
		t(a.value === 4 && ser(a, "2025-09").value === 2, "§2 active units: 4 drivers in September 2026, 2 a year earlier", a.value);
		t(a.confidence === "medium", "§2 active units is a proxy: medium confidence");
	}

	// §3 freight
	{
		const m = get(out, "freight_tons_stated");
		// September 2026: four loads at 40,000 lb, the details' 42,000 (not the
		// rate con's 40,000), and the rate con's 41,000 (the details conflict).
		t(close(m.value, 243000 / 2000), "§3 September 2026 stated tons = 243,000 lb / 2,000", m.value);
		t(m.display === "122 t", "§3 display", m.display);
		t(close(ser(m, "2025-09").value, 124000 / 2000) && ser(m, "2025-09").coverage === 0.75, "§3 September 2025: 3 of 4 loads weighed, 62 t", JSON.stringify(ser(m, "2025-09")));
		t(ser(m, "2025-10").value === 0, "§3 a month with rows but no deliveries weighs 0 t");
		t(ser(m, "2026-01").display === "No records", "§3 gap months are No records");
		t(m.coverage.num === 36 && m.coverage.den === 39, "§3 coverage: 36 of 39 dated deliveries state a weight", JSON.stringify(m.coverage));
		const fromRc = m.breakdown.find((b) => /rate confirmation/.test(b.label));
		const fromDetails = m.breakdown.find((b) => /load details/.test(b.label));
		t(fromRc && fromRc.value === 2 && fromDetails && fromDetails.value === 34, "§3 breakdown by source: 34 details, 2 rate cons", JSON.stringify(m.breakdown));
		const totalLb = 490262 + 963000;
		const all = m.totals.find((x) => x.label === "All time");
		t(close(all.value, Math.round((totalLb / 2000) * 10) / 10), "§3 all-time stated tons", all.value);
		const e = get(out, "freight_tons_estimated");
		const avg = totalLb / 36;
		const allE = e.totals.find((x) => x.label === "All time");
		t(close(allE.value, Math.round(((totalLb + 3 * avg) / 2000) * 10) / 10), "§3 estimate adds 3 unweighed loads at the average stated weight", allE.value);
		t(e.confidence === "low" && e.status === "ok", "§3 an estimate is low confidence", e.confidence);
		t(e.assumptions.some((s) => /40,368 lb per load, from 36 loads/.test(s)), "§3 the estimate states its average", JSON.stringify(e.assumptions));
		const thin = world();
		thin.loads = thin.loads.slice(0, 18);
		const e2 = get(M.computeKpis(thin), "freight_tons_estimated");
		t(e2.status === "missing" && /Fewer than 20/.test(e2.missingReason) && e2.value === null, "§3 fewer than 20 weighed loads: the estimate is missing", e2.missingReason);
		t(M.statedWeight("Weight: 42,000 lbs", { status: "ok", weightLb: 40000 }).lb === 42000, "§3 statedWeight: the details win");
		t(M.statedWeight("Commodity: produce", { status: "ok", weightLb: 40000 }).source === "ratecon", "§3 statedWeight: the rate con fills a details gap");
		t(M.statedWeight("", { status: "conflict", weightLb: null }) === null && M.statedWeight("", { status: "ok", weightLb: 90000 }) === null, "§3 statedWeight: a rate-con conflict or an implausible figure is no weight");
	}

	// §4 revenue
	{
		const m = get(out, "revenue");
		t(m.value === 53344.12 && m.display === "$53,344", "§4 September 2026 revenue", `${m.value} ${m.display}`);
		t(cmp(m, "yoy").deltaPct === 206.6 && cmp(m, "yoy").baseValue === 17400, "§4 YoY vs September 2025", JSON.stringify(cmp(m, "yoy")));
		t(close(cmp(m, "t3m_yoy").value, 139594.62, 0.01) && cmp(m, "t3m_yoy").baseValue === 43900, "§4 trailing 3 months", JSON.stringify(cmp(m, "t3m_yoy")));
		t(ser(m, "2026-02").display === "No records", "§4 a month with no delivered loads is No records");
		const m2 = get(out2, "revenue");
		t(cmp(m2, "yoy").status === "missing" && cmp(m2, "yoy").baseValue === null, "§4 October 2025 had no delivered load: no base for a YoY");
		t(m.coverage.ratio === 1 && m.coverage.what === "delivered loads with a revenue figure", "§4 every delivered load has a revenue figure");
		const thinBase = get(M.computeKpis(world({ unpaid: "2025-09-10" })), "revenue");
		t(cmp(thinBase, "yoy").status === "missing" && cmp(thinBase, "t3m_yoy").status === "missing" && cmp(thinBase, "mom").status === "ok"
			&& thinBase.assumptions.some((a) => /at least 90%/.test(a)),
			"§4 a base month where under 90% of delivered loads have revenue is no base for a YoY, and the page says why", JSON.stringify(thinBase.comparisons));
		t(!m.assumptions.some((a) => /at least 90%/.test(a)), "§4 ...and the note appears only when a comparison was held back");
		const unpaid = get(M.computeKpis(world({ unpaid: "2026-09-29" })), "revenue");
		t(unpaid.value === 45000 && unpaid.coverage.num === unpaid.coverage.den - 1 && ser(unpaid, "2026-09").coverage === 0.8333,
			"§4 a delivered load with no Payment adds nothing and lowers the coverage", JSON.stringify({ v: unpaid.value, c: unpaid.coverage, s: ser(unpaid, "2026-09") }));
	}

	// §5 miles and utilization
	{
		const m = get(out, "miles_driven");
		t(close(m.value, eldMilesIn("2026-09-01", "2026-09-30"), 0.1), "§5 September 2026 ELD miles", m.value);
		t(ser(m, "2026-04").display === "No data" && ser(m, "2025-09").display === "No data", "§5 months before ELD records read No data");
		t(cmp(m, "yoy").status === "missing", "§5 no YoY before a year of ELD records");
		const u = get(out, "truck_utilization");
		// September 2026: both trucks in the fleet all 30 days, active on the 22 weekdays.
		const wd = weekdaysIn("2026-09-01", "2026-09-30");
		t(close(u.value, Math.round(((2 * wd) / 60) * 1000) / 10), "§5 utilization: distinct truck-days with more than 1 mile", `${u.value} vs ${(2 * wd) / 60 * 100}`);
		const ai = u.beforeAfter.find((b) => b.event === "ai_dispatch");
		t(ai.date === "2026-04-09" && ai.status === "missing", "§5 before AI dispatch: ELD records begin after it, so missing", JSON.stringify(ai));
		const ded = u.beforeAfter.find((b) => b.event === "dedicated");
		// 40-day windows: 2026-07-21..08-29 before, 08-30..10-08 (the last ELD day) after.
		t(ded.status === "ok" && ded.before.n === 80 && ded.after.n === 80, "§5 before/after dedicated: 40 truck-days per truck each side", JSON.stringify(ded));
		const bWd = weekdaysIn("2026-07-21", "2026-08-29");
		const aWd = weekdaysIn("2026-08-30", "2026-10-08");
		t(close(ded.before.value, Math.round(((2 * bWd) / 80) * 1000) / 10) && close(ded.after.value, Math.round(((2 * aWd) / 80) * 1000) / 10),
			"§5 before/after values: weekday share on each side", `${ded.before.value} ${ded.after.value}`);
		const nodate = get(M.computeKpis(world({ settings: { dedicatedStart: null } })), "truck_utilization").beforeAfter.find((b) => b.event === "dedicated");
		t(nodate.status === "date_not_set", "§5 no dedicated start: date_not_set");
		const admin = get(M.computeKpis(world({ settings: { aiDispatchStart: "2026-07-01" } })), "truck_utilization").beforeAfter.find((b) => b.event === "ai_dispatch");
		t(admin.date === "2026-07-01" && admin.status === "ok", "§5 an admin AI start overrides the derived one", JSON.stringify(admin));
		t(out.derived.aiDispatchStart.value === "2026-04-09", "§5 derived.aiDispatchStart", JSON.stringify(out.derived));
		t(u.coverage.num === 2 && u.coverage.den === 5 && u.status === "partial", "§5 coverage: 2 of 5 trucks have ELD mileage", JSON.stringify(u.coverage));
	}

	// §6 paid-mile share
	{
		const m = get(out, "paid_mile_share");
		t(m.value === 75, "§6 September 2026: 3,000 loaded of 4,000 (in-progress, overlap, partial and unmeasured legs left out)", m.value);
		t(ser(m, "2026-07").display === "No data", "§6 before the first fully measured load: No data");
		t(m.coverage.num === 6 && m.coverage.den === 9, "§6 coverage: 6 of 9 finished loads measured", JSON.stringify(m.coverage));
		t(m.beforeAfter.length === 1 && m.beforeAfter[0].event === "dedicated" && m.beforeAfter[0].status === "missing", "§6 nothing measured before the dedicated start");
	}

	// §7 on time
	{
		const m = get(out, "on_time_rate");
		t(m.value === 66.7 && m.display === "66.7%", "§7 September 2026 strict: 2 of 3 timed appointments", m.value);
		t(m.warnings.includes(M.ON_TIME_WARNING) && m.confidence === "low", "§7 the review warning is always there");
		const byDay = m.breakdown.find((b) => /by day/.test(b.label));
		t(byDay && byDay.value === 83.3, "§7 by day: 5 of 6 judged arrivals on or before the appointment day", JSON.stringify(byDay));
		const n = (re) => (m.breakdown.find((b) => re.test(b.label)) || {}).value;
		t(n(/no arrival/) === 2 && n(/receiver location/) === 1 && n(/unreadable/) === 0 && n(/more than 3 days/) === 1, "§7 exclusions are counted",
			JSON.stringify(m.breakdown));
		t(n(/by day only/) === 1 && n(/1 hour/) === 2, "§7 date-only judged by day; 2 verdicts flip within an hour (an arrival exactly 1 h early does not)", JSON.stringify(m.breakdown));
		const all = m.totals.find((x) => x.label === "All time");
		t(all.value === 60 && all.from === "2026-06-03", "§7 all time from the first judged arrival: 3 of 5", JSON.stringify(all));
		t(ser(m, "2025-09").display === "No data", "§7 2025 has no arrivals: No data");
		const mtd = get(out2, "on_time_rate").totals.find((x) => x.label === "Month to date");
		t(mtd.value === 100, "§7 the fall-back day: 08:30 EST arrival for a 09:00 Eastern appointment is on time", JSON.stringify(mtd));
	}

	// §8 fleet
	{
		const m = get(out, "fleet_trucks");
		t(m.value === 3 && m.display === "3 trucks" && m.current.label === "October 9, 2026", "§8 today: 3 trucks (Inactive and retired out)", m.value);
		t(ser(m, "2026-09").value === 4, "§8 end of September: the now-Inactive truck still counts in history", ser(m, "2026-09").value);
		t(ser(m, "2026-08").value === 5, "§8 end of August: the snapshot taken that day wins", ser(m, "2026-08").value);
		t(ser(m, "2026-07").value === 4 && ser(m, "2026-04").value === 2, "§8 July 4, April 2 by service dates");
		t(ser(m, "2026-03").display === "No data" && ser(m, "2025-09").display === "No data", "§8 before the first truck: No data");
		t(cmp(m, "mom").baseValue === 4 && cmp(m, "mom").deltaPct === -25, "§8 vs end of September", JSON.stringify(cmp(m, "mom")));
		t(cmp(m, "yoy").status === "missing", "§8 YoY missing until a year of trucks exists");
	}

	// §9 fuel
	{
		const mpg = get(out, "fuel_mpg");
		const sepMiles = eldMilesIn("2026-09-01", "2026-09-30");
		t(close(mpg.value, Math.round((sepMiles / 2000) * 100) / 100), "§9 September MPG = ELD miles / 2,000 gal (Rejected out)", mpg.value);
		const mpgAll = mpg.totals.find((x) => x.label === "All time");
		const allMiles = eldMilesIn("2026-05-28", "2026-10-08");
		t(close(mpgAll.value, Math.round((allMiles / (400 + 2000 + 2100 + 2050 + 2000 + 300)) * 100) / 100), "§9 all-time MPG leaves out receipts from before the first ELD day", mpgAll.value);
		t(mpg.coverage.num === 9 && mpg.coverage.den === 11, "§9 coverage: 9 of 11 receipts since ELD show gallons", JSON.stringify(mpg.coverage));
		const sv = get(out, "fuel_savings");
		const expected = (sepMiles / 6.5 - 2000) * (10000 / 2000);
		t(close(sv.value, Math.round(expected * 100) / 100, 0.011) && sv.value > 0, "§9 savings = (miles / 6.5 - gallons) x $/gal on receipts with gallons", `${sv.value} vs ${expected}`);
		t(sv.confidence === "low", "§9 savings is an estimate");
		const noBase = get(M.computeKpis(world({ settings: { baselineMpg: null } })), "fuel_savings");
		t(noBase.status === "missing" && noBase.missingReason === "No baseline MPG set" && noBase.value === null && noBase.series.every((s) => s.value === null),
			"§9 no baseline: missing, never a number", JSON.stringify({ s: noBase.status, r: noBase.missingReason, v: noBase.value }));
		const co2 = get(out, "co2_tonnes");
		const allCo2 = co2.totals.find((x) => x.label === "All time");
		t(close(allCo2.value, Math.round(((9950 * 10.18) / 1000) * 10) / 10), "§9 all-time CO2 = 9,950 gal x 10.18 kg / 1,000 (Rejected out)", allCo2.value);
		t(close(co2.value, 20.4), "§9 September CO2", co2.value);
		t(co2.coverage.num === 11 && co2.coverage.den === 13, "§9 CO2 coverage: 11 of 13 receipts show gallons", JSON.stringify(co2.coverage));
	}

	// §10 tasks
	{
		const ai = get(out, "ai_tasks");
		t(ai.value === 3, "§10 September 2026 AI tasks: 2 receipts + 1 insight (the cancelled email load is not one)", ai.value);
		const allAi = ai.totals.find((x) => x.label === "All time");
		t(allAi.value === 8 && ai.coverage.num === 8 && ai.coverage.den === 9, "§10 all time: 4 email loads + 3 receipts + 1 insight", JSON.stringify({ all: allAi.value, cov: ai.coverage }));
		t(ser(ai, "2025-07").display === "No records" && ser(ai, "2025-05").display === "No data", "§10 a gap is No records; before the first task No data");
		t(ai.breakdown.length === 3 && ai.breakdown.find((b) => /email/.test(b.label)).value === 4, "§10 breakdown by kind", JSON.stringify(ai.breakdown));
		const auto = get(out, "automated_tasks");
		t(auto.value === 3 && auto.breakdown.length === 2, "§10 automation: 2 geofence statuses + 1 invoice run in September", auto.value);
		const calls = get(out, "dispatch_calls");
		t(calls.status === "not_tracked" && calls.missingReason === "No call or voice system records dispatch calls." && calls.value === null
			&& calls.confidence === "none" && calls.series.every((s) => s.value === null && s.display === "Not tracked"), "§10 dispatch calls: not tracked");
	}

	// §11 catalog
	{
		const keys = ["freight_tons_stated", "freight_tons_estimated", "loads_delivered", "revenue", "miles_driven", "on_time_rate", "fleet_trucks",
			"active_units", "fuel_mpg", "fuel_savings", "co2_tonnes", "ai_tasks", "automated_tasks", "dispatch_calls", "truck_utilization", "paid_mile_share"];
		t(JSON.stringify(C.METRIC_KEYS) === JSON.stringify(keys), "§11 the sixteen keys, in order");
		t(JSON.stringify(out.metrics.map((m) => m.key)) === JSON.stringify(keys), "§11 computeKpis returns them in that order");
		t(C.CO2_KG_PER_GALLON_DIESEL === 10.18 && C.LB_PER_TON === 2000 && C.KPI_SERIES_START === "2025-04", "§11 constants");
		t(/EPA-420-F-23-014/.test(C.CO2_SOURCE.label) && C.CO2_SOURCE.url === "https://www.epa.gov/greenvehicles/greenhouse-gas-emissions-typical-passenger-vehicle", "§11 the EPA source");
		t(C.metricByKey("co2_tonnes").assumptions[0] === "Tailpipe CO2 only, from receipt gallons; gallons for trailer refrigeration units on the same receipts are included.", "§11 CO2 assumption text");
		t(C.metricByKey("fuel_savings").assumptions[0] === "Compared with a truck at the baseline MPG set on this page driving the same ELD miles, priced at the average $/gal actually paid.", "§11 savings assumption text");
		t(C.metricByKey("freight_tons_estimated").assumptions[0] === "Loads with no stated weight are assumed to weigh the average of loads that state one.", "§11 estimate assumption text");
		const kinds = { freight_tons_estimated: "estimate", fuel_savings: "estimate", active_units: "proxy", dispatch_calls: "not_tracked" };
		t(C.METRICS.every((m) => m.kind === (kinds[m.key] || "real") && m.definitionVersion === 1 && typeof m.definition === "string" && m.definition.length > 20), "§11 kinds and versions");
		t(JSON.stringify(C.metricByKey("truck_utilization").settingsUsed) === JSON.stringify(["aiDispatchStart", "dedicatedStart"])
			&& JSON.stringify(C.metricByKey("paid_mile_share").settingsUsed) === JSON.stringify(["dedicatedStart"])
			&& JSON.stringify(C.metricByKey("fuel_savings").settingsUsed) === JSON.stringify(["baselineMpg"]), "§11 settingsUsed");
		t(C.settingsHashFor("loads_delivered", { baselineMpg: 7 }) === "", "§11 a metric that reads no setting hashes to ''");
		t(C.settingsHashFor("fuel_savings", { baselineMpg: 6.5, recipients: ["x"] }) === C.settingsHashFor("fuel_savings", { recipients: ["y"], baselineMpg: 6.5 })
			&& C.settingsHashFor("fuel_savings", { baselineMpg: 6.5 }) !== C.settingsHashFor("fuel_savings", { baselineMpg: 7 }), "§11 the hash reads only the metric's settings");
		const ok = { approved: 1, definition_version: 1, settings_hash: C.settingsHashFor("fuel_savings", { baselineMpg: 6.5 }) };
		t(C.approvalIsValid(ok, "fuel_savings", { baselineMpg: 6.5 }) === true, "§11 a current approval is valid");
		t(C.approvalIsValid({ ...ok, definition_version: 0 }, "fuel_savings", { baselineMpg: 6.5 }) === false, "§11 an approval of an earlier definition lapses");
		t(C.approvalIsValid(ok, "fuel_savings", { baselineMpg: 7 }) === false, "§11 an approval lapses when a setting it used changes");
		t(C.approvalIsValid({ ...ok, approved: 0 }, "fuel_savings", { baselineMpg: 6.5 }) === false && C.approvalIsValid(null, "fuel_savings", {}) === false
			&& C.approvalIsValid(ok, "zed_unknown", {}) === false, "§11 unapproved, missing or unknown is not valid");
	}

	// §12 buildKpiResponse
	let response;
	{
		const settings = { aiDispatchStart: null, dedicatedStart: "2026-08-30", baselineMpg: 6.5, recipients: ["ops@example.invalid"] };
		const snapshots = out.metrics.filter((m) => m.key !== "dispatch_calls").map((m) => ({
			day: AS_OF, metric_key: m.key, value: m.value, display: m.display, status: m.status, confidence: m.confidence,
			definition_version: 1, computed_at: "2026-10-09 08:00:00",
			payload: JSON.stringify({ current: m.current, totals: m.totals, comparisons: m.comparisons, beforeAfter: m.beforeAfter,
				coverage: m.coverage, warnings: m.warnings, assumptions: m.assumptions, breakdown: m.breakdown, missingReason: m.missingReason,
				loadIds: ["LOAD-SENTINEL-77"] }),
		}));
		snapshots.find((s) => s.metric_key === "automated_tasks").payload = "{";
		snapshots.push({ day: AS_OF, metric_key: "zed_unknown_metric", value: 1, display: "1", status: "ok", confidence: "high", definition_version: 1, payload: "{}" });
		const series = out.metrics.flatMap((m) => m.series.map((s) => ({ metric_key: m.key, period: s.period, value: s.value, display: s.display, coverage: s.coverage }))).reverse();
		const approvals = [
			{ metric_key: "loads_delivered", approved: 1, definition_version: 1, settings_hash: "", approved_by: "super_admin", approved_at: "2026-10-09 12:00:00" },
			{ metric_key: "fuel_savings", approved: 1, definition_version: 1, settings_hash: C.settingsHashFor("fuel_savings", { baselineMpg: 6 }), approved_by: "super_admin", approved_at: "2026-10-08T12:00:00Z" },
			{ metric_key: "revenue", approved: 1, definition_version: 0, settings_hash: "", approved_by: "super_admin", approved_at: "2026-10-01T12:00:00Z" },
			{ metric_key: "co2_tonnes", approved: 0, definition_version: 1, settings_hash: "", approved_by: null, approved_at: null },
		];
		const job = { enabled: { snapshot: true, digest: true }, lastRun: { id: 3, kind: "nightly", status: "ok", startedAt: "2026-10-09T08:00:00Z", finishedAt: "2026-10-09T08:00:04Z", durationMs: 4000, errors: [] } };
		response = M.buildKpiResponse({ asOfDay: AS_OF, timeZone: "America/New_York", job, settings, derived: out.derived, snapshots, series, approvals, generatedAt: "2026-10-09T13:00:00Z", defaultRecipientConfigured: true });
		const rm = (key) => response.metrics.find((m) => m.key === key);
		t(response.asOfDay === AS_OF && response.timeZone === "America/New_York" && response.generatedAt === "2026-10-09T13:00:00Z", "§12 header fields");
		t(response.job.enabled.snapshot === true && response.job.lastRun.id === 3 && response.job.snapshotSchedule === "Daily at 4:00 AM Eastern (3:00 AM Central)"
			&& response.job.preview.status === "pending", "§12 job passes through over the defaults");
		t(response.settings.aiDispatchStart.value === "2026-04-09" && response.settings.aiDispatchStart.source === "derived" && /from 2026-04-09/.test(response.settings.aiDispatchStart.evidence),
			"§12 the derived AI start and its evidence", JSON.stringify(response.settings.aiDispatchStart));
		t(response.settings.dedicatedStart.value === "2026-08-30" && response.settings.dedicatedStart.source === "admin" && response.settings.baselineMpg === 6.5
			&& response.settings.recipients.length === 1 && response.settings.defaultRecipientConfigured === true, "§12 settings block");
		const adminAi = M.buildKpiResponse({ asOfDay: AS_OF, settings: { aiDispatchStart: "2026-05-01" }, derived: out.derived, snapshots: [], series: [], approvals: [] });
		t(adminAi.settings.aiDispatchStart.value === "2026-05-01" && adminAi.settings.aiDispatchStart.source === "admin", "§12 an admin AI start is source admin");
		t(JSON.stringify(response.metrics.map((m) => m.key)) === JSON.stringify(C.METRIC_KEYS), "§12 every catalog metric, in order, and no unknown key");
		const ld = rm("loads_delivered");
		t(ld.approval.approved === true && ld.approval.by === "super_admin" && ld.approval.at === "2026-10-09T12:00:00Z" && ld.approval.stale === false, "§12 a valid approval", JSON.stringify(ld.approval));
		t(rm("fuel_savings").approval.approved === false && rm("fuel_savings").approval.stale === true, "§12 an approval under another baseline is stale, not approved");
		t(rm("revenue").approval.approved === false && rm("revenue").approval.stale === true, "§12 an approval of an earlier definition is stale, not approved");
		t(rm("co2_tonnes").approval.approved === false && rm("co2_tonnes").approval.stale === false && rm("ai_tasks").approval.approved === false, "§12 unapproved and never-approved");
		t(ld.value === 6 && ld.display === "6" && ld.current.label === "September 2026" && ld.computedDay === AS_OF && ld.series.length === 19
			&& ld.series[0].period === "2025-04", "§12 stored values, current and series (sorted) come back");
		t(ld.label === "Loads delivered" && ld.unit === "count" && ld.kind === "real" && ld.group === "volume" && ld.definitionVersion === 1, "§12 catalog fields merged");
		const est = rm("freight_tons_estimated");
		t(est.assumptions[0] === C.metricByKey("freight_tons_estimated").assumptions[0] && est.assumptions.some((s) => /per load, from 36 loads/.test(s)), "§12 catalog and runtime assumptions merged");
		t(rm("on_time_rate").warnings.includes(M.ON_TIME_WARNING), "§12 warnings come back");
		const dc = rm("dispatch_calls");
		t(dc.status === "missing" && dc.missingReason === "No snapshot yet" && dc.value === null && dc.confidence === "none" && dc.computedDay === null, "§12 no snapshot: missing, No snapshot yet");
		const at = rm("automated_tasks");
		t(at.status === "ok" && Array.isArray(at.totals) && at.totals.length === 0 && at.breakdown === null, "§12 a broken payload reads as empty, without throwing");
		const old = M.buildKpiResponse({ asOfDay: AS_OF, settings, derived: out.derived, snapshots: [{ ...snapshots[0], definition_version: 0 }], series: [], approvals: [] });
		t(old.metrics[0].warnings.some((w) => /earlier definition/.test(w)), "§12 a snapshot of an earlier definition says so");
		const big = out.metrics.map((m) => Buffer.byteLength(JSON.stringify({ current: m.current, totals: m.totals, comparisons: m.comparisons, beforeAfter: m.beforeAfter,
			coverage: m.coverage, warnings: m.warnings, assumptions: m.assumptions, breakdown: m.breakdown, missingReason: m.missingReason }), "utf8"));
		t(Math.max(...big) <= 4096, "§12 every payload fits in 4 KB", `largest ${Math.max(...big)} bytes`);
		const empty = M.computeKpis({ asOfDay: AS_OF });
		t(empty.errors.length === 0 && empty.metrics.length === 16 && empty.metrics.every((m) => m.status === (m.key === "dispatch_calls" ? "not_tracked" : "missing")),
			"§12 no inputs at all: every metric missing, nothing thrown", JSON.stringify(empty.metrics.filter((m) => m.status !== "missing").map((m) => m.key)));
		t(out.errors.length === 0 && out2.errors.length === 0, "§12 no metric failed on the fixtures", JSON.stringify(out.errors));
	}

	// §13 nothing identifying leaves
	{
		const leaks = (o) => /sentinel/i.test(JSON.stringify(o));
		t(!leaks(out) && !leaks(out2), "§13 computeKpis output holds no load id, driver key or truck id");
		t(!leaks(response), "§13 the response holds none either (an extra payload key is never read)");
	}
	return r;
}

function record(results) {
	for (const x of results) {
		if (x.ok) pass++;
		else failures.push(x.name);
	}
}

// ── run ──────────────────────────────────────────────────────────────────────
const started = Date.now();
const real = battery(REAL);
const bySection = new Map();
for (const x of real) {
	const s = (x.name.match(/^§\d+/) || ["§?"])[0];
	if (!bySection.has(s)) bySection.set(s, { ok: 0, n: 0 });
	const e = bySection.get(s);
	e.n++;
	if (x.ok) e.ok++;
}
for (const [s, e] of bySection) console.log(`${s}: ${e.ok}/${e.n} checks`);
record(real);

// §14 MUTANTS: each must fail a check in the section that guards it.
console.log("\n§14 mutants");
const MUTANTS = [
	["delivered regex widened (/deliver/ matches Delivery Scheduled)", "§2", { metrics: [["const DELIVERED_STATUS_RE = /^(delivered|completed|pod received)$/i;", "const DELIVERED_STATUS_RE = /deliver|completed|pod received/i;"]] }],
	["cancelled rows kept", "§10", { metrics: [["const live = arr(input.loads).filter((l) => l && !DROPPED_STATUS_RE.test(trimmed(l.status)));", "const live = arr(input.loads).filter((l) => l);"]] }],
	["YoY on a zero base", "§1", { metrics: [["if (v == null || b == null || b === 0) {", "if (v == null || b == null) {"]] }],
	["gap months read as 0", "§2", { metrics: [["if (!m.rows) return { value: null, display: NO_RECORDS, coverage, present: false };", "if (!m.rows) return { value: 0, display: formatDisplay(unit, 0), coverage, present: true };"]] }],
	["2,204.6 lb per ton", "§3", { metrics: [["return lb / catalog.LB_PER_TON;", "return lb / 2204.6;"]] }],
	["a $0 Payment counted as a revenue figure", "§4", { metrics: [["revenue: delivered && isNum(l.revenue) && l.revenue > 0 ? l.revenue : null,", "revenue: delivered && isNum(l.revenue) ? l.revenue : null,"]] }],
	["comparisons ignore month coverage", "§4", { metrics: [["if (isNum(spec.minCompareCoverage) && !cells.every(", "if (false && !cells.every("]] }],
	["CO2 factor 10.21", "§9", { metrics: [["const kgPerGallon = catalog.CO2_KG_PER_GALLON_DIESEL;", "const kgPerGallon = 10.21;"]] }],
	["rejected receipts counted", "§9", { metrics: [["String(r.status == null ? \"\" : r.status) !== \"Rejected\"", "true"]] }],
	["$/gal over all spend", "§9", { metrics: [["const pricePerGallon = fw.spendGal / fw.gal;", "const pricePerGallon = fw.spendAll / fw.gal;"]] }],
	["fuel savings computed without a baseline", "§9", { metrics: [["if (!hasBaseline) return missingResult(", "if (false) return missingResult("]] }],
	["fuel savings sign flipped", "§9", { metrics: [["return (fw.miles / baseline - fw.gal) * pricePerGallon;", "return (fw.gal - fw.miles / baseline) * pricePerGallon;"]] }],
	["truck-days counted per row, not per distinct (truck, day)", "§5", { metrics: [["for (const td of truckDays.values()) {", "for (const td of eldRows) {"]] }],
	["unmeasured (null) loaded miles read as 0", "§6", { metrics: [["if (!measured(loaded) || !measured(empty)) continue;", "if (!measured(empty)) continue;"]] }],
	["today's Inactive applied to history", "§8", { metrics: [["return snapshots.has(day) ? snapshots.get(day) : fleetCount(day, false);", "return snapshots.has(day) ? snapshots.get(day) : fleetCount(day, true);"]] }],
	["before/after windows overlap on the event day", "§1", { metrics: [["const beforeTo = addDays(date, -1);", "const beforeTo = date;"]] }],
	["an approval survives a definition change", "§12", { catalog: [["\t\t&& row.definition_version === def.definitionVersion\n", ""]] }],
	["the rate con's weight before the details'", "§3", { metrics: [["return fromDetails || fromRatecon;", "return fromRatecon || fromDetails;"]] }],
	["a load id leaks into the breakdown", "§13", { metrics: [["display: formatDisplay(\"count\", undatedDelivered.length) }", "display: undatedDelivered.map((l) => l.loadId).join(\", \") }"]] }],
	["a driver key leaks into the breakdown", "§13", { metrics: [["display: formatDisplay(\"units\", drivers.size) }", "display: [...drivers].join(\", \") }"]] }],
];
for (const [name, section, edits] of MUTANTS) {
	let catalogSrc = SOURCES.catalog;
	let metricsSrc = SOURCES.metrics;
	for (const [from, to] of edits.catalog || []) catalogSrc = swap(catalogSrc, from, to);
	for (const [from, to] of edits.metrics || []) metricsSrc = swap(metricsSrc, from, to);
	let results;
	try {
		const cat = compileLib("kpi-catalog.js", catalogSrc);
		const met = compileLib("kpi-metrics.js", metricsSrc, { "./kpi-catalog": cat });
		results = battery({ metrics: met, catalog: cat });
	} catch (e) {
		results = [{ ok: false, name: `${section} the mutant threw: ${e && e.message}` }];
	}
	const caught = results.filter((x) => !x.ok && x.name.startsWith(section));
	const ok = caught.length > 0;
	if (ok) pass++; else failures.push(`MUTANT ${name}: not caught by ${section}`);
	console.log(`  ${ok ? "caught" : "MISSED"}  ${name}${ok ? ` (${section}: ${caught[0].name})` : ""}`);
}

const ms = Date.now() - started;
if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed (${ms} ms)`);
	process.exit(1);
}
console.log(`\n✓ ${pass} assertions passed (${ms} ms)`);
