"use strict";
// THE KPI BOT'S PER-LOAD MILES (R10): what each delivered load contributes to
// loaded_miles, paid_miles, deadhead_miles, unloaded_miles and paid_mile_share,
// and the sums lib/kpi-metrics.js turns into those metrics.
//
//   contractFrom(dedicatedStart)          -> { month, startDay, precision } | null
//   milesFacts({ milesLoads, timeZone, truckAt, truckIdByUnit, routes, eldRows, contract, inWindow })
//       -> { loads: LoadMiles[], deadhead }
//   sumMiles(facts, from, to, milesByDay) -> one period's sums
//
// LOAD SCOPE. Delivered live loads whose truck (lib/kpi-deadhead.js rule 1) has
// ELD records covering the load's day (from the truck's first to its last ELD
// day), so the loads and the total miles cover the same trucks.
//
// DATING. A load's miles go to its day as the gatherer dates it (Completion
// Date, else Drop-off, else Pickup Appointment); ELD miles go to the day driven.
// A load that crosses a month end puts all its paid and loaded miles in the
// month of its Completion Date, and its ELD miles in both months.
//
// LOADED MILES. The rate con's stated loaded miles, else Google's lane miles
// (load_ratecon_miles, the Distance rate-con ingestion stored), else unknown.
//
// PAID MILES (they read the contract start, `dedicatedStart`):
//   fully known   stated loaded + stated empty (0 when the charge table has no
//                 Empty Movement line, 'none_stated'); before the contract, a
//                 load with no stated miles counts its lane miles, whatever its
//                 rate-con status (flat rate, unreadable, conflicting, not found
//                 or not read yet): no empty leg was paid then ("flat-rate lane")
//   loaded leg only  from the contract on, a load whose rate con states no
//                 miles adds its known loaded leg (lane miles, plus a stated
//                 empty leg if one is stated) and is NOT fully known
//   nothing on file  adds nothing, not fully known
// Coverage is fully known loads / loads in scope. Nothing is estimated or
// scaled: an unknown leg is missing, never filled in.
//
// Keys and truck ids stay inside these structures; lib/kpi-metrics.js only ever
// reads the sums.
//
// Pure: no I/O, no environment reads. Requires lib/kpi-deadhead.js and
// lib/kpi-catalog.js, both pure.

const { computeDeadhead } = require("./kpi-deadhead");
const { dedicatedStartPrecision } = require("./kpi-catalog");

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DELIVERED_STATUS_RE = /^(delivered|completed|pod received)$/i;
// The statuses whose stated figures are read (lib/kpi-ratecon-miles.js).
const STATED_STATUSES = new Set(["ok", "none_stated"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const trimmed = (v) => String(v == null ? "" : v).trim();

function isRealDay(v) {
	if (typeof v !== "string" || !DAY_RE.test(v)) return false;
	const t = new Date(Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10), 12));
	return t.toISOString().slice(0, 10) === v;
}

// The contract start as the KPI page stores it: a month ('2026-09', precision
// 'month', the contract month starting on its 1st) or a day ('2026-09-15',
// precision 'day'), by the catalog's one rule. Anything else (unset) is null.
function contractFrom(value) {
	const v = trimmed(value);
	const precision = dedicatedStartPrecision(v);
	if (precision === "month") return { month: v, startDay: `${v}-01`, precision };
	if (precision === "day") return { month: v.slice(0, 7), startDay: v, precision };
	return null;
}

function milesOrNull(v, min) {
	return isNum(v) && v >= (min == null ? 0 : min) ? v : null;
}

// One load's paid miles: { kind, full, partial }. `before` is true for a load
// dated before the contract start.
function paidOf(load, before) {
	const rc = trimmed(load.rateconStatus);
	const stated = STATED_STATUSES.has(rc);
	const loaded = stated ? milesOrNull(load.statedLoadedMiles, 0) : null;
	const empty = rc === "ok" ? milesOrNull(load.statedEmptyMiles, 0) : null;
	const lane = milesOrNull(load.laneMiles, 0);
	if (loaded != null) return { kind: empty ? "stated_empty" : "stated_none", full: loaded + (empty || 0), partial: null };
	if (before && empty == null) return lane != null ? { kind: "flat_lane", full: lane, partial: null } : { kind: "nothing", full: null, partial: null };
	if (lane != null || empty != null) return { kind: "loaded_leg_only", full: null, partial: (lane || 0) + (empty || 0) };
	return { kind: "nothing", full: null, partial: null };
}

function milesFacts(args) {
	const a = args && typeof args === "object" ? args : {};
	const inWindow = typeof a.inWindow === "function" ? a.inWindow : (d) => isRealDay(d);
	const contract = a.contract || null;
	const milesLoads = (Array.isArray(a.milesLoads) ? a.milesLoads : []).filter((l) => l && typeof l === "object");
	const routes = a.routes instanceof Map ? a.routes : new Map();
	const byUnit = a.truckIdByUnit instanceof Map ? a.truckIdByUnit : new Map();

	// Each ELD truck's first and last ELD day.
	const eldRange = new Map();
	for (const r of Array.isArray(a.eldRows) ? a.eldRows : []) {
		const id = trimmed(r && r.truckId);
		if (!id || !isRealDay(r.day)) continue;
		const cur = eldRange.get(id);
		if (!cur) eldRange.set(id, { from: r.day, to: r.day });
		else {
			if (r.day < cur.from) cur.from = r.day;
			if (r.day > cur.to) cur.to = r.day;
		}
	}

	// Only an 'ok' row states an Empty Movement line; a 'none_stated' row's empty
	// 0 means "no empty leg was paid", not a measured deadhead of 0 (rule 5).
	const forChain = milesLoads.map((l) => (trimmed(l.rateconStatus) === "ok" ? l : { ...l, statedEmptyMiles: null }));
	const deadhead = computeDeadhead(forChain, { timeZone: a.timeZone, truckAt: a.truckAt, truckIdByUnit: byUnit, routes });
	const loads = [];
	const seen = new Set();
	for (const l of milesLoads) {
		const key = trimmed(l.key).toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		if (!DELIVERED_STATUS_RE.test(trimmed(l.status)) || !inWindow(l.day)) continue;
		const dh = deadhead.byKey.get(key) || null;
		const truckId = dh ? dh.truckId : null;
		const range = truckId ? eldRange.get(truckId) : null;
		if (!range || l.day < range.from || l.day > range.to) continue;
		const rc = trimmed(l.rateconStatus);
		const statedLoaded = STATED_STATUSES.has(rc) ? milesOrNull(l.statedLoadedMiles, 0) : null;
		const lane = milesOrNull(l.laneMiles, 0);
		const loaded = statedLoaded != null ? statedLoaded : lane;
		const paid = contract ? paidOf(l, l.day < contract.startDay) : null;
		loads.push({
			key,
			day: l.day,
			truckId,
			loaded,
			loadedSource: statedLoaded != null ? "stated" : (lane != null ? "lane" : null),
			paidKind: paid ? paid.kind : null,
			paidFull: paid ? paid.full : null,
			paidPartial: paid ? paid.partial : null,
			statedEmpty: rc === "ok" ? milesOrNull(l.statedEmptyMiles, 0) || 0 : 0,
			deadhead: dh && isNum(dh.deadheadMiles) ? dh.deadheadMiles : null,
			deadheadSource: dh ? dh.source : null,
			deadheadState: dh ? dh.state : null,
		});
	}
	return { loads, deadhead };
}

// The chained pairs still waiting for a route distance (lib/kpi-deadhead.js
// `pending`: no answer yet, or a failed one), for the nightly route phase
// (lib/kpi-deadhead-routes.js, which waits 30 days before asking a failed pair
// again). Only the pairs the mile metrics can use: the later load is delivered
// and its truck has ELD records that day (the load scope above), so the
// 50-a-day calls never go to pre-ELD or 2025 loads. Newest first, by that load's
// day (then pair key), so recent months fill first. `eldRows` (the fleet's ELD
// truck-days, inputs.eldDaily) is required: without it no load is in scope.
function pendingRoutePairs(args) {
	const a = args && typeof args === "object" ? args : {};
	const facts = milesFacts({ ...a, eldRows: Array.isArray(a.eldRows) ? a.eldRows : [], contract: null });
	const newestDay = new Map();
	for (const l of facts.loads) {
		const r = facts.deadhead.byKey.get(l.key);
		if (!r || !r.pairKey || l.deadhead != null) continue;
		if (!newestDay.has(r.pairKey) || l.day > newestDay.get(r.pairKey)) newestDay.set(r.pairKey, l.day);
	}
	return facts.deadhead.pending
		.filter((p) => newestDay.has(p.pairKey))
		.sort((x, y) => {
			const dx = newestDay.get(x.pairKey);
			const dy = newestDay.get(y.pairKey);
			if (dx !== dy) return dx > dy ? -1 : 1;
			return x.pairKey < y.pairKey ? -1 : x.pairKey > y.pairKey ? 1 : 0;
		});
}

// One period's sums over the facts: loads dated in [from, to], ELD miles driven
// in [from, to]. `milesByDay` is the fleet's ELD miles per day.
function sumMiles(facts, from, to, milesByDay) {
	const s = {
		n: 0, loadedN: 0, loadedSum: 0, statedLoadedN: 0, laneN: 0,
		fullyN: 0, fullySum: 0, partialN: 0, partialSum: 0, nothingN: 0, flatLaneN: 0,
		emptyN: 0, emptySum: 0, deadheadN: 0, deadheadSum: 0, deadheadStated: 0, deadheadRoute: 0,
		eldTotal: 0, eldDays: 0,
	};
	for (const l of facts.loads) {
		if (l.day < from || l.day > to) continue;
		s.n++;
		if (l.loaded != null) {
			s.loadedN++;
			s.loadedSum += l.loaded;
			if (l.loadedSource === "stated") s.statedLoadedN++;
			else s.laneN++;
		}
		if (l.paidFull != null) {
			s.fullyN++;
			s.fullySum += l.paidFull;
			if (l.paidKind === "flat_lane") s.flatLaneN++;
		} else if (l.paidPartial != null) {
			s.partialN++;
			s.partialSum += l.paidPartial;
		} else if (l.paidKind === "nothing") {
			s.nothingN++;
		}
		if (l.statedEmpty > 0) {
			s.emptyN++;
			s.emptySum += l.statedEmpty;
		}
		if (l.deadhead != null) {
			s.deadheadN++;
			s.deadheadSum += l.deadhead;
			if (l.deadheadSource === "stated") s.deadheadStated++;
			else s.deadheadRoute++;
		}
	}
	if (milesByDay) {
		for (const [d, miles] of milesByDay) {
			if (d >= from && d <= to) {
				s.eldTotal += miles;
				s.eldDays++;
			}
		}
	}
	return s;
}

module.exports = {
	contractFrom,
	paidOf,
	milesFacts,
	pendingRoutePairs,
	sumMiles,
};
