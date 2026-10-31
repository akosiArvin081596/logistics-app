"use strict";
// The official pickup date: the day the truck arrived at the shipper, read from
// the load's status history as the arrival recorder wrote it
// (lib/arrival-recorder.js), for the three pay paths (the weekly invoice, GET
// /api/investor and the payout ledger; lib/load-pay-days.js payWindow() builds
// the window from it).
//
// Behind ARRIVAL_PICKUP_DATE_ENABLED (on only when exactly "true") and
// ARRIVAL_PICKUP_DATE_FROM (a calendar date, YYYY-MM-DD). A completed load of a
// daily-rate driver whose Assigned Date is FROM or later is in scope; the paths
// check the pay type and the status, forLoad() the Assigned Date. Any other load,
// and an in-scope load with no official pickup, is paid as before.
//
// officialPickup(), pure: the rows after the last Cancelled, oldest first. Once a
// row has reached At Shipper or later, a later row CUTS (undoes the arrival)
// when it is a pre-arrival status the driver did not write himself (dispatch,
// override, or a tap, Accept or Decline from a staff session or written without
// the recorder), or when its own old_status is pre-arrival while the row before
// it had reached At Shipper (a move back no row recorded). The official pickup
// is the first qualifying At Shipper at or after the last cut, the cutting row
// included:
//   geofence  other_load_hauling 0; its moment is the ping's time (fix_ms),
//             never before the row's predecessor or the latest dispatch and
//             never after the row itself, else changed_at;
//   driver    a manual tap from a Driver session, "inside" the pickup zone, or
//             with no known position and no At Receiver or Delivered within 15
//             minutes after it (a batch tap at the receiver); its moment is
//             changed_at.
// Its day is the moment's calendar day in the row's stored local_tz (the
// shipper's zone). No answer gives one of REASONS.
//
// The window's end (the arrival's delivery) is the first completed row of the
// load's current delivered run (lib/expense-window.js deliveredAtFromHistory()),
// read in the same zone, never the Status Update Date cell, which any later
// status write re-stamps. A load completed outside the status routes (a row
// editor or the sheet) has none: it is paid its scheduled window, and named.
//
// createArrivalResolver() is the rule for one request: the history read once,
// each load decided once. forLoad({ loadId, assigned, completed }), `assigned`
// the path's reading of the Assigned Date (a local-midnight Date or a day key):
//   null                    out of scope: not completed, no readable Assigned
//                           Date, or one before FROM
//   { none }                in scope, no official pickup (REASONS)
//   { fallback, arrival }   an official pickup but no delivery in the history
//   { error }               the history could not be read
//   { start, delivered, arrival, deliveredMs }   the window's first day and the
//                           delivery's day (day keys)
// Each path pays its scheduled window for every answer but the last.
//
// Nothing here reads a clock, a radius, a setting (apart from ruleFromEnv()) or a
// month lock, so the same rows always give the same answer.

const eldMiles = require("./eld-miles");
const expenseWindow = require("./expense-window");

// Reviewed constants, never settings: a batch tap's window, and the extension
// the weekly invoice names.
const BATCH_TAP_MS = 15 * 60 * 1000;
const EXTENDED_DAYS = 2;
const REASONS = Object.freeze(["no_at_shipper", "staff_only", "far_tap", "batch_tap", "hauling_other_load", "undone", "unrecorded"]);

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRE_ARRIVAL_RE = /^(unassigned|dispatched|assigned|heading to shipper)$/;
const REACHED_RE = /^(at shipper|loading|in transit|at receiver|unloading|delivered|completed|pod received)$/;
const FOLLOW_UP_RE = /^(at receiver|delivered)$/;
const CANCELLED_RE = /^cancell?ed$/;
// The sources a driver writes from his own app; geofence rows are judged apart.
const DRIVER_OWN_SOURCES = new Set(["manual", "accept", "decline"]);
// The columns the decision reads. An older copy of the database without the
// recorder's columns fails this read, and every path then answers as before.
const HISTORY_SQL = `SELECT id, load_id, old_status, new_status, source, actor_role, fix_ms, pickup_zone, local_tz, other_load_hauling, changed_at
	FROM load_status_history ORDER BY changed_at, id`;

const text = (v) => (v === null || v === undefined ? "" : String(v));
const statusOf = (s) => text(s).trim().toLowerCase().replace(/\s+/g, " ");
// load_status_history keys a load lower-case with any leading "#" removed.
const statusKey = (loadId) => text(loadId).trim().toLowerCase().replace(/^#/, "");
// changed_at is SQLite's UTC "YYYY-MM-DD HH:MM:SS", with no zone marker.
const stampMs = (s) => Date.parse(text(s).trim().replace(" ", "T") + "Z");
const positiveMs = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

function isCalendarDay(v) {
	if (typeof v !== "string" || !DAY_KEY_RE.test(v)) return false;
	const d = new Date(`${v}T12:00:00Z`);
	return !isNaN(d) && d.toISOString().slice(0, 10) === v;
}

// A local-midnight Date (the paths' sheet readings) or a "YYYY-MM-DD", as its day key.
function dayKeyOf(v) {
	if (typeof v === "string") return isCalendarDay(v.trim()) ? v.trim() : "";
	if (!(v instanceof Date) || isNaN(v)) return "";
	const key = `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
	return isCalendarDay(key) ? key : "";
}

function daysBetween(a, b) {
	return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / (24 * 3600 * 1000));
}

const ZONES = new Map();
// A zone Intl can read; anything else gives no day, never a guessed one.
function zoneOk(zone) {
	if (typeof zone !== "string" || !zone) return false;
	if (!ZONES.has(zone)) {
		let good = true;
		try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { good = false; }
		ZONES.set(zone, good);
	}
	return ZONES.get(zone);
}

// The rule's FROM date, or null while it is off. On without a calendar date it
// stays off and `warn` (given at start only) is told, naming the setting, never
// its value.
function ruleFromEnv(env, warn = null) {
	if (!env || env.ARRIVAL_PICKUP_DATE_ENABLED !== "true") return null;
	const value = text(env.ARRIVAL_PICKUP_DATE_FROM).trim();
	if (isCalendarDay(value)) return value;
	if (typeof warn === "function") warn("ARRIVAL_PICKUP_DATE_FROM is not a calendar date (YYYY-MM-DD); the arrival pickup date rule stays off.");
	return null;
}

// The start-up line: the rule's state and its FROM.
function stateLine(fromDay) {
	return fromDay ? `ARRIVAL_PICKUP_DATE_ENABLED on, from ${fromDay}` : "ARRIVAL_PICKUP_DATE_ENABLED off";
}

const RECORDER_OFF_WARNING = "ARRIVAL_PICKUP_DATE_ENABLED is on while ARRIVAL_PICKUP_RECORDER_ENABLED is off: no new status row says who set it or where the truck was, "
	+ "so a load assigned from now on finds no official pickup and is paid its scheduled window.";

// The start-up notice when FROM's month is at or before `latestClosed`, or null.
// Expected on every start once FROM's own month has closed with the rule on; it
// never asks for FROM to be moved (closed months' live recomputes read it).
function fromMonthClosedWarning(fromDay, latestClosed) {
	if (!isCalendarDay(fromDay) || !/^\d{4}-\d{2}$/.test(text(latestClosed))) return null;
	if (fromDay.slice(0, 7) > latestClosed) return null;
	return `ARRIVAL_PICKUP_DATE_FROM is in or before ${latestClosed}, the latest closed month: expected once `
		+ "ARRIVAL_PICKUP_DATE_FROM's month has closed with the rule on. Never change ARRIVAL_PICKUP_DATE_FROM once the rule has run.";
}

// One load's history rows as the decision reads them, oldest first (changed_at,
// then id); a row with no status or no readable time is left out.
function orderedRows(events) {
	return (Array.isArray(events) ? events : [])
		.map((e, i) => ({
			i,
			id: e && Number.isFinite(Number(e.id)) && e.id !== null && e.id !== "" ? Number(e.id) : null,
			status: statusOf(e && e.new_status),
			old: statusOf(e && e.old_status),
			source: statusOf(e && e.source),
			role: text(e && e.actor_role).trim(),
			fixMs: positiveMs(e && e.fix_ms),
			zone: text(e && e.pickup_zone).trim().toLowerCase(),
			tz: text(e && e.local_tz).trim(),
			hauling: e && (e.other_load_hauling === 0 || e.other_load_hauling === 1) ? e.other_load_hauling : null,
			ms: stampMs(e && e.changed_at),
		}))
		.filter((r) => r.status && Number.isFinite(r.ms))
		.sort((a, b) => a.ms - b.ms || (a.id !== null && b.id !== null ? a.id - b.id : a.i - b.i));
}

// Whether `r` undoes an arrival reached earlier (`prev` is the row before it).
function isCut(r, prev) {
	if (PRE_ARRIVAL_RE.test(r.status)) return !(DRIVER_OWN_SOURCES.has(r.source) && r.role === "Driver");
	return !!prev && REACHED_RE.test(prev.status) && PRE_ARRIVAL_RE.test(r.old);
}

// One "At Shipper" row's verdict: { ms, source } or { reason }. `all` is every row
// in order and `at` this row's index in it.
function judge(r, at, all) {
	if (!r.role) return { reason: "unrecorded" };
	if (r.source === "geofence") {
		if (r.hauling === 1) return { reason: "hauling_other_load" };
		if (r.hauling !== 0 || !zoneOk(r.tz)) return { reason: "unrecorded" };
		if (r.fixMs === null) return { ms: r.ms, source: "geofence" };
		// A repeated stale fix can predate the dispatch: the moment is never before
		// the row's predecessor or the latest dispatch, nor after the row itself.
		let floor = at > 0 ? all[at - 1].ms : -Infinity;
		for (let k = at - 1; k >= 0; k--) if (all[k].status === "dispatched") { floor = Math.max(floor, all[k].ms); break; }
		return { ms: Math.min(Math.max(r.fixMs, floor), r.ms), source: "geofence" };
	}
	if (r.source !== "manual" || r.role !== "Driver") return { reason: "staff_only" };
	if (r.zone === "outside") return { reason: "far_tap" };
	if (!zoneOk(r.tz)) return { reason: "unrecorded" };
	if (r.zone !== "inside") {
		for (let k = at + 1; k < all.length && all[k].ms - r.ms <= BATCH_TAP_MS; k++) {
			if (FOLLOW_UP_RE.test(all[k].status)) return { reason: "batch_tap" };
		}
	}
	return { ms: r.ms, source: "driver" };
}

// The official pickup from one load's history rows (HISTORY_SQL's columns, any
// order): { day, ms, zone, source: "geofence"|"driver", rowId }, or { none: reason }
// with one of REASONS.
function officialPickup(events) {
	const all = orderedRows(events);
	let lastCancel = -1;
	all.forEach((r, k) => { if (CANCELLED_RE.test(r.status)) lastCancel = k; });
	const first = lastCancel + 1;
	let lastCut = -1;
	let reached = false;
	for (let k = first; k < all.length; k++) {
		if (reached && isCut(all[k], k > first ? all[k - 1] : null)) lastCut = k;
		if (REACHED_RE.test(all[k].status)) reached = true;
	}
	const from = lastCut >= 0 ? lastCut : first;
	const verdicts = [];
	for (let k = first; k < all.length; k++) {
		if (all[k].status !== "at shipper") continue;
		const v = judge(all[k], k, all);
		if (k >= from && v.ms !== undefined) {
			const r = all[k];
			return { day: eldMiles.localDayInTz(v.ms, r.tz), ms: v.ms, zone: r.tz, source: v.source, rowId: r.id };
		}
		verdicts.push({ k, ...v });
	}
	const after = verdicts.filter((v) => v.k >= from);
	if (after.length) return { none: after[0].reason };
	const before = verdicts.filter((v) => v.k < from);
	if (before.some((v) => v.ms !== undefined)) return { none: "undone" };
	if (before.length) return { none: before[0].reason };
	return { none: "no_at_shipper" };
}

// The arrival's delivery: the first completed row of the current delivered run,
// as { ms, day } in `zone`, or null when the history holds none.
function deliveryOf(events, zone) {
	const at = expenseWindow.deliveredAtFromHistory(events);
	const ms = at ? Date.parse(at) : NaN;
	if (!Number.isFinite(ms) || !zoneOk(zone)) return null;
	return { ms, day: eldMiles.localDayInTz(ms, zone) };
}

const NO_DELIVERY = "its delivery is not in the status history (completed outside the status routes, or moved off Delivered since), so the rule has no end for its window";

// The rule for one request (see the header), or null while it is off (no FROM).
// errors() and fallbacks() list the loads seen so far; `log`, when given, is told
// once when the history can't be read.
function createArrivalResolver({ db, fromDay, log = null }) {
	if (!db || !isCalendarDay(fromDay)) return null;
	let byLoad = null;
	let historyError = null;
	const memo = new Map();
	const errors = new Map();
	const fallbacks = new Map();
	const eventsFor = (key) => {
		if (!byLoad && !historyError) {
			try {
				const map = new Map();
				for (const r of db.prepare(HISTORY_SQL).all()) {
					const k = statusKey(r.load_id);
					if (!k) continue;
					if (!map.has(k)) map.set(k, []);
					map.get(k).push(r);
				}
				byLoad = map;
			} catch (err) {
				historyError = `the status history could not be read (${err && err.message})`;
				if (typeof log === "function") log(`${historyError}; each load the arrival pickup date rule covers is paid its scheduled window`);
			}
		}
		if (historyError) throw new Error(historyError);
		return byLoad.get(key) || [];
	};
	function forLoad({ loadId, assigned = null, completed = false } = {}) {
		if (!completed) return null;
		const assignedDay = dayKeyOf(assigned);
		if (!assignedDay || assignedDay < fromDay) return null;
		const key = statusKey(loadId);
		const memoKey = `${key}|${assignedDay}`;
		if (memo.has(memoKey)) return memo.get(memoKey);
		let out;
		if (!key) out = { none: "no_at_shipper" };
		else {
			try {
				const events = eventsFor(key);
				const arrival = officialPickup(events);
				if (arrival.none) out = { none: arrival.none };
				else {
					const delivery = deliveryOf(events, arrival.zone);
					if (delivery) out = { start: arrival.day, delivered: delivery.day, arrival, deliveredMs: delivery.ms };
					else {
						out = { fallback: NO_DELIVERY, arrival };
						fallbacks.set(text(loadId).trim(), NO_DELIVERY);
					}
				}
			} catch (err) {
				out = { error: text(err && err.message) };
				errors.set(text(loadId).trim(), out.error);
			}
		}
		memo.set(memoKey, out);
		return out;
	}
	return {
		fromDay,
		forLoad,
		errors: () => [...errors].map(([loadId, error]) => ({ loadId, error })),
		fallbacks: () => [...fallbacks].map(([loadId, reason]) => ({ loadId, reason })),
	};
}

// The resolver the payout ledger and GET /api/investor read, from the process
// environment, or from `rules.arrivalFrom` when a caller sets one (a report's
// candidate FROM); null while off.
function ledgerResolver({ db, env, rules = null, log = null }) {
	const from = rules && Object.prototype.hasOwnProperty.call(rules, "arrivalFrom") ? (rules.arrivalFrom || null) : ruleFromEnv(env);
	return from ? createArrivalResolver({ db, fromDay: from, log }) : null;
}

// How many days after its Drop-off Appointment (`dropoffDay`) an answer's
// window ends, 0 when it does not.
function extensionDays(answer, dropoffDay) {
	if (!answer || !isCalendarDay(answer.delivered) || !isCalendarDay(dropoffDay)) return 0;
	return Math.max(0, daysBetween(dropoffDay, answer.delivered));
}

// The weekly invoice's warning lines for what the rule could not read or place,
// and for each window it ended EXTENDED_DAYS or more past its drop-off.
function invoiceWarnings(notes) {
	if (!notes) return [];
	return [
		...notes.errors.map((e) => `ARRIVAL NOT READ: load ${e.loadId}: ${e.error}. This invoice pays its scheduled window instead.`),
		...notes.fallbacks.map((f) => `ARRIVAL RULE NOT APPLIED: load ${f.loadId}: ${f.reason}. This invoice pays its scheduled window instead.`),
		...notes.extended.map((x) => `ARRIVAL WINDOW EXTENDED: load ${x.loadId} is paid to ${x.delivered}, ${x.days} days after its Drop-off Appointment (${x.dropoff}), the day the status history shows it delivered.`),
	];
}

module.exports = {
	BATCH_TAP_MS,
	EXTENDED_DAYS,
	REASONS,
	RECORDER_OFF_WARNING,
	isCalendarDay,
	dayKeyOf,
	ruleFromEnv,
	stateLine,
	fromMonthClosedWarning,
	officialPickup,
	deliveryOf,
	createArrivalResolver,
	ledgerResolver,
	extensionDays,
	invoiceWarnings,
};
