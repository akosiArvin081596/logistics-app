"use strict";

// One load's pickup credit for a driver's own count. It reads as this count always has: the first
// geofence departure, else the ELD's, else a tap on a truck with no reporting ELD, for the sheet's
// driver. Only a load's own record can change that, and only where it is certain: a handover the
// first driver's own accept or tap stands behind, or a status gone back. Otherwise it stays as it is.
// Display only: nothing that pays reads this.
//
// Pure: every fact about trucks and names is asked through the functions it is handed, so
// lib/driver-performance-routes.js gathers them and the rule stays here.

const arrivalPickup = require("./arrival-pickup");
const { pickupEvidence } = require("./driver-performance");

const WAITING_RE = /^(unassigned|dispatched|assigned|heading to shipper|at shipper|loading)$/;
const CANCELLED_RE = /^cancel(l?ed)?$/;
// The status route holds only a Driver session to his own load: from staff it takes any name.
const STAFF_ROLES = new Set(["Super Admin", "Dispatcher"]);
const GEOFENCE = ["geofence"];
const TAPS = ["manual", "override"];
const DEPARTURES = [...GEOFENCE, ...TAPS];

const statusOf = (s) => String(s === null || s === undefined ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
const hisOwnRow = (r) => (r.source === "manual" || r.source === "accept" || r.source === "decline") && !STAFF_ROLES.has(r.role);

// Whether a load's status cells all say it hasn't left its shipper: a row editor or the sheet moves
// a status back and writes no history, so the record alone can't say. A blank cell says nothing.
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
		if (wentBack && left) back = { k, ms: r.ms, own: hisOwnRow(r) };
		else if (wentBack && back && !hisOwnRow(r) && r.source !== "geofence") back.own = false;
		else if (left && r.status === "in transit" && WAITING_RE.test(r.old)) back = { k, ms: r.ms, own: false };
		if (r.status === "in transit") left = true;
		else if (wentBack) left = false;
	});
	return back;
}

// { driverKey, ms, source }, or null when the load earns no pickup credit.
//   events           the load's history rows
//   eldDepartMs      the truck's stored record of leaving the shipper, or 0
//   driverNow        the load's driver on the sheet now, by normalizeName
//   waitingOnSheet   statusesStillWaiting() of its rows
//   isDriverName(key)        is that a driver in the directory today
//   truckHasEldAt(key, ms)   did the truck he held then report
function qualifiedPickup({ events, eldDepartMs = 0, driverNow, waitingOnSheet = false, normalizeName, isDriverName, truckHasEldAt }) {
	const rows = arrivalPickup.orderedRows(events).map((r) => ({ ...r, actor: normalizeName(events[r.i].actor) }));
	const first = (list, sources) => list.find((r) => r.status === "in transit" && sources.includes(r.source));

	// Her own word on this load: an accept or a tap of hers, and not a decline after it. A geofence
	// row only says the sheet named her at the ping and her truck left that zone: it can pass by.
	const hasOwnWord = (who) => {
		const said = rows.filter((r) => r.actor === who && hisOwnRow(r));
		return said.length > 0 && said[said.length - 1].source !== "decline";
	};
	// A name the directory holds and her own word on the load. An old spelling a rename left in the
	// log, or a staff session's row, says nothing certain.
	const handedOverBy = (r) => r.actor !== driverNow && isDriverName(r.actor) && !STAFF_ROLES.has(r.role) && hasOwnWord(r.actor);

	// Who a departure's credit goes to. A stored ELD departure and a dispatcher's tap never move one.
	const read = (list, departMs, moves) => {
		const geofence = first(list, GEOFENCE);
		const tap = first(list, TAPS);
		const tapDecides = !!tap && !geofence && !(departMs > 0);
		// A tap on her own reporting ELD proves no pickup of hers.
		const tapper = moves.tap && tapDecides && tap.source === "manual" && handedOverBy(tap) && !truckHasEldAt(tap.actor, tap.ms) ? tap.actor : driverNow;
		const evidence = pickupEvidence({
			geofenceMs: geofence ? geofence.ms : 0,
			eldDepartMs: departMs,
			tapMs: tap ? tap.ms : 0,
			tapSource: tap && tap.source === "override" ? "dispatch" : "driver",
			truckHasEld: tapDecides && truckHasEldAt(tapper, tap.ms),
		});
		if (!evidence) return null;
		if (evidence.source === "geofence") return { driverKey: moves.truck && handedOverBy(geofence) ? geofence.actor : driverNow, ms: evidence.ms, source: evidence.source };
		return { driverKey: evidence.source === "eld" ? driverNow : tapper, ms: evidence.ms, source: evidence.source };
	};

	const back = lastMoveBack(rows);
	const since = back ? rows.slice(back.k) : rows;
	const departed = first(since, DEPARTURES) || first(rows, DEPARTURES);
	const hisTapAlone = back && back.own && !first(since, DEPARTURES);
	// Certain it went back and stayed back: a departure on record, the sheet still waiting, no truck
	// record of leaving since the last row, and more than his own stray tap saying so.
	if (departed && waitingOnSheet && !hisTapAlone && eldDepartMs <= rows[rows.length - 1].ms) return null;
	// His own tap back and his own tap forward are one person's word, so only the truck's own
	// departure after it moves the credit to a new day.
	if (back && (!back.own || first(since, GEOFENCE))) {
		const moved = read(since, eldDepartMs >= back.ms ? eldDepartMs : 0, { truck: true, tap: true });
		if (moved && moved.source !== "eld") return moved;
	}
	// A departure before a move back: staff's word leaves her no certain claim on it, and her own tap
	// back leaves her tap none. Her truck's own record still stands behind a tap back of hers.
	return read(rows, eldDepartMs, { truck: !back || back.own, tap: !back });
}

module.exports = { qualifiedPickup, statusesStillWaiting };
