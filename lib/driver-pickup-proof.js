"use strict";

// One load's pickup credit for a driver's own count. A credit is removed or moved only where the
// load's own record is certain; otherwise it reads as this count always has: the first geofence
// departure, else the ELD's, else a tap on a truck with no reporting ELD, for the sheet's driver.
// Display only: nothing that pays reads this.
//
// Pure: every fact about trucks and names is asked through the functions it is handed, so
// lib/driver-performance-routes.js gathers them and the rule stays here.

const arrivalPickup = require("./arrival-pickup");
const { pickupEvidence } = require("./driver-performance");

const WAITING_RE = /^(|unassigned|dispatched|assigned|heading to shipper|at shipper|loading)$/;
const CANCELLED_RE = /^cancel(l?ed)?$/;
// The status route holds only a Driver session to his own load: from staff it takes any name.
const STAFF_ROLES = new Set(["Super Admin", "Dispatcher"]);
// The rows a driver writes himself; a dispatcher's row names the dispatcher.
const DRIVER_WRITES = new Set(["geofence", "manual", "accept"]);
const GEOFENCE = ["geofence"];
const TAPS = ["manual", "override"];

const statusOf = (s) => String(s === null || s === undefined ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
const hisOwnTap = (r) => (r.source === "manual" || r.source === "accept" || r.source === "decline") && !STAFF_ROLES.has(r.role);

// Whether a load's status cells all say it hasn't left its shipper: a row editor or the sheet
// moves a status back and writes no history, so the record alone can't say.
function statusesStillWaiting(statuses) {
	const live = (statuses || []).map(statusOf).filter((s) => !CANCELLED_RE.test(s));
	return live.length > 0 && live.every((s) => WAITING_RE.test(s));
}

// The last time the status went back over a departure: { k, ms, own }, own when only the driver's
// own taps did it, which isn't certain, since a stray tap can sit on a whole trip. A row written
// from a waiting status right after a departure is a move back no row recorded.
function lastMoveBack(rows) {
	let back = null;
	let left = false;
	rows.forEach((r, k) => {
		const wentBack = WAITING_RE.test(r.status) || CANCELLED_RE.test(r.status);
		if (wentBack && left) back = { k, ms: r.ms, own: hisOwnTap(r) };
		else if (wentBack && back && !hisOwnTap(r) && r.source !== "geofence") back.own = false;
		else if (left && r.status === "in transit" && r.old && WAITING_RE.test(r.old)) back = { k, ms: r.ms, own: false };
		if (r.status === "in transit") left = true;
		else if (wentBack) left = false;
	});
	return back;
}

// { driverKey, ms, source, arrival }, or { driverKey, ms, withheld } with why it stands for no one
// ("no-driver" has no driverKey), or null with nothing to judge. arrival is his truck-recorded
// "At Shipper" row (a geofence row, or the recorder's "inside" one), for the twin test, or null.
//   events           the load's history rows
//   eldDepart        { ms, truckId }, the truck's own record of leaving the shipper, or null
//   driverNow        the load's driver on the sheet now, by normalizeName
//   waitingOnSheet   statusesStillWaiting() of its rows
//   isDriverName(key)        does a driver hold that name today
//   onSheet(key)             does any row of this load name him
//   holderOf(truckId, ms)    who held that truck at that instant
//   truckHasEldAt(key, ms)   did the truck he held then report
function qualifiedPickup({ events, eldDepart = null, driverNow = "", waitingOnSheet = false, normalizeName, isDriverName, onSheet, holderOf, truckHasEldAt }) {
	const rows = arrivalPickup.orderedRows(events).map((r) => ({ ...r, actor: normalizeName(events[r.i].actor) }));
	const first = (list, sources) => list.find((r) => r.status === "in transit" && sources.includes(r.source));
	const ownRows = rows.filter((r) => DRIVER_WRITES.has(r.source) && !STAFF_ROLES.has(r.role));

	// A name in use today is that driver's. Anything else, an old spelling a rename left in the log
	// or a staff session's row, says nothing certain, so it stays with the sheet's driver.
	const writerOf = (r) => (r.actor && isDriverName(r.actor) && !STAFF_ROLES.has(r.role) ? r.actor : driverNow);
	// A reassign writes no row, so only the same driver's own rows on both sides of a dispatcher's
	// tap say he held the load through it.
	const heldThrough = (ms) => {
		const before = [...ownRows].reverse().find((r) => r.ms <= ms);
		const after = ownRows.find((r) => r.ms > ms);
		return before && after && writerOf(before) === writerOf(after) ? writerOf(before) : driverNow;
	};
	// A tap on another driver's reporting ELD proves no pickup of his, so it moves nothing.
	const tapOwner = (r) => {
		const who = r.source === "override" ? heldThrough(r.ms) : writerOf(r);
		return who !== driverNow && truckHasEldAt(who, r.ms) ? driverNow : who;
	};
	// A truck's holder takes the credit only with a link to the load: the Truck cell behind this
	// record isn't re-stamped on a swap, and his truck may have visited that shipper for its own load.
	const eldOwner = (ms) => {
		const holder = Number(eldDepart.truckId) > 0 ? holderOf(Number(eldDepart.truckId), ms) : "";
		return holder && (onSheet(holder) || ownRows.some((r) => r.actor === holder)) ? holder : driverNow;
	};
	const arrivalOf = (list, who, ms) => {
		const his = list.filter((r) => r.status === "at shipper" && (r.source === "geofence" || r.zone === "inside") && writerOf(r) === who);
		const row = [...his].reverse().find((r) => r.ms <= ms) || his[0];
		return row ? events[row.i] : null;
	};
	const read = (list, departMs) => {
		const geofence = first(list, GEOFENCE);
		const tap = first(list, TAPS);
		const tapper = tap ? tapOwner(tap) : "";
		const evidence = pickupEvidence({
			geofenceMs: geofence ? geofence.ms : 0,
			eldDepartMs: departMs,
			tapMs: tap ? tap.ms : 0,
			tapSource: tap && tap.source === "override" ? "dispatch" : "driver",
			truckHasEld: !!tapper && truckHasEldAt(tapper, tap.ms),
		});
		if (!evidence) return tap ? { driverKey: tapper, ms: tap.ms, withheld: "no-truck-record" } : null;
		const who = evidence.source === "geofence" ? writerOf(geofence) : evidence.source === "eld" ? eldOwner(departMs) : tapper;
		if (!who) return { ms: evidence.ms, withheld: "no-driver" };
		return { driverKey: who, ms: evidence.ms, source: evidence.source, arrival: arrivalOf(list, who, evidence.ms) };
	};

	const departMs = eldDepart ? Number(eldDepart.ms) || 0 : 0;
	const back = lastMoveBack(rows);
	const since = back ? rows.slice(back.k) : rows;
	const departed = first(since, [...GEOFENCE, ...TAPS]) || first(rows, [...GEOFENCE, ...TAPS]);
	const hisTapAlone = back && back.own && !first(since, [...GEOFENCE, ...TAPS]);
	// Certain it went back and stayed back: a departure on record, the sheet still waiting, no truck
	// record of leaving since the last row, and more than his own stray tap saying so.
	if (departed && waitingOnSheet && !hisTapAlone && departMs <= rows[rows.length - 1].ms) {
		return { driverKey: writerOf(departed), ms: departed.ms, withheld: "undone" };
	}
	if (back) {
		const moved = read(since, departMs >= back.ms ? departMs : 0);
		if (moved && moved.source) return moved;
	}
	return read(rows, departMs);
}

module.exports = { qualifiedPickup, statusesStillWaiting };
