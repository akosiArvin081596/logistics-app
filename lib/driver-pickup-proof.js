"use strict";

// One load's pickup credit for a driver's own count. It reads as this count always has: the first
// geofence departure, else the ELD's, else a tap on a truck with no reporting ELD, for the sheet's
// driver. Two rules change that, each from the rows on record: a handover with the first driver's own
// word on the load, and a status gone back. With the recorder off a row carries no role, so an accept
// from a staff session reads as the driver's: the rows can't tell them apart.
// Display only: nothing that pays reads this.
//
// Pure: every fact about trucks and names is asked through the functions it is handed, so
// lib/driver-performance-routes.js gathers them and the rule stays here.

const arrivalPickup = require("./arrival-pickup");
const { pickupEvidence } = require("./driver-performance");

const WAITING_RE = /^(unassigned|dispatched|assigned|heading to shipper|at shipper|loading)$/;
const CANCELLED_RE = /^cancel(l?ed)?$/;
// Where a tap can't step a load forward: the dispatch and accept routes write these.
const NOT_A_STEP_RE = /^(unassigned|dispatched|assigned)$/;
// The stages after a load has left its shipper.
const LATER_STAGE_RE = /^(at receiver|unloading|delivered|completed|pod received)$/;
// The status route holds only a Driver session to his own load: from staff it takes any name.
const STAFF_ROLES = new Set(["Super Admin", "Dispatcher"]);
const GEOFENCE = ["geofence"];
const TAPS = ["manual", "override"];
const DEPARTURES = [...GEOFENCE, ...TAPS];

const statusOf = (s) => String(s === null || s === undefined ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
// A row a driver wrote himself. A `manual` row with no role can be the office's status dropdown, which
// writes the same row while the recorder is off, so it is nobody's until a Driver role says otherwise.
const hisOwnRow = (r) => (r.source === "manual" ? r.role === "Driver" : (r.source === "accept" || r.source === "decline") && !STAFF_ROLES.has(r.role));

// Whether a load's status cells all say it hasn't left its shipper: a row editor or the sheet moves
// a status back and writes no history, so the record alone can't say. A blank cell says nothing.
function statusesStillWaiting(statuses) {
	const live = (statuses || []).map(statusOf).filter((s) => !CANCELLED_RE.test(s));
	return live.length > 0 && live.every((s) => WAITING_RE.test(s));
}

// The last time the status went back over a departure: { k, ms, own }, own when only the departing
// driver's own rows did it, which isn't certain, since a stray tap can sit on a whole trip. A row
// written from a waiting status right after a departure is a move back no row recorded. Each row
// that went back over a departure is marked, so a tap back can't pass for a word.
function lastMoveBack(rows, whoLeft) {
	let back = null;
	let left = false;
	let leftBy = "";
	rows.forEach((r, k) => {
		const wentBack = WAITING_RE.test(r.status) || CANCELLED_RE.test(r.status);
		const hisOwnMove = hisOwnRow(r) && r.actor === leftBy;
		r.overDeparture = wentBack && left;
		if (r.overDeparture) back = { k, ms: r.ms, own: hisOwnMove };
		else if (wentBack && back && !hisOwnMove && r.source !== "geofence") back.own = false;
		else if (left && r.status === "in transit" && WAITING_RE.test(r.old)) back = { k, ms: r.ms, own: false };
		if (r.status === "in transit") {
			left = true;
			leftBy = whoLeft(r);
		} else if (wentBack) left = false;
	});
	return back;
}

// { driverKey, ms, source }, or null when the load earns no pickup credit.
//   events           the load's history rows
//   eldDepart        { ms, truckId }, the stored record of a truck leaving the shipper, or null
//   driverNow        the load's driver on the sheet now, by normalizeName
//   waitingOnSheet   statusesStillWaiting() of its rows
//   isDriverName(key)             is that a driver in the directory today
//   truckHasEldAt(key, ms)        did the truck he held then report
//   heldTruck(key, truckId, ms)   did he hold that truck at that instant
function qualifiedPickup({ events, eldDepart = null, driverNow, waitingOnSheet = false, normalizeName, isDriverName, truckHasEldAt, heldTruck }) {
	const rows = arrivalPickup.orderedRows(events).map((r) => ({ ...r, actor: normalizeName(events[r.i].actor) }));
	const first = (list, sources) => list.find((r) => r.status === "in transit" && sources.includes(r.source));
	const eldMs = eldDepart ? eldDepart.ms : 0;
	// A dispatcher's tap names the dispatcher, and an old spelling names nobody: both are the sheet's driver's.
	const whoLeft = (r) => (isDriverName(r.actor) ? r.actor : driverNow);
	const back = lastMoveBack(rows, whoLeft);

	// Their own word for this run of the load: an accept, or a tap that steps it forward, since its
	// last cancel, with no decline after it. A tap back says the load hadn't left, and a geofence row
	// only says the sheet named them at the ping and their truck left that zone: it can pass by.
	const hasOwnWord = (who) => {
		let word = false;
		for (const r of rows.slice(rows.findLastIndex((x) => CANCELLED_RE.test(x.status)) + 1)) {
			if (r.actor !== who || !hisOwnRow(r)) continue;
			if (r.source === "decline") word = false;
			else if (r.source === "accept" || (!r.overDeparture && !NOT_A_STEP_RE.test(r.status))) word = true;
		}
		return word;
	};
	// A stored departure dated after their row, on a truck they didn't hold when it left, is the other
	// story: a new driver's real pickup can write no status row. It keeps the credit as it is, and moves nothing.
	const anotherTruckLeftLater = (r) => eldMs > r.ms && !heldTruck(r.actor, eldDepart.truckId, eldMs);
	// A later In Transit row naming someone else is the same story on the status record, so a new driver's
	// own row can't hand the credit to the first. One off a later stage, or a dispatcher's override, only
	// corrects a status: a new driver lifting a load under In Transit writes no such row, so it says nothing.
	const anotherDriverLeftLater = (r) => rows.slice(rows.indexOf(r) + 1).some((x) => x.status === "in transit" && x.source !== "override" && !LATER_STAGE_RE.test(x.old) && whoLeft(x) !== r.actor);
	const handedOverBy = (r) => r.actor !== driverNow && isDriverName(r.actor) && hasOwnWord(r.actor) && !anotherTruckLeftLater(r) && !anotherDriverLeftLater(r);

	// Who a departure's credit goes to. A stored ELD departure and a dispatcher's tap never move one.
	const read = (list, departMs, moves) => {
		const geofence = first(list, GEOFENCE);
		const tap = first(list, TAPS);
		const tapDecides = !!tap && !geofence && !(departMs > 0);
		// A tap on their own reporting ELD proves no pickup of theirs.
		const tapper = moves.tap && tapDecides && tap.source === "manual" && hisOwnRow(tap) && handedOverBy(tap) && !truckHasEldAt(tap.actor, tap.ms) ? tap.actor : driverNow;
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

	const since = back ? rows.slice(back.k) : rows;
	const departed = first(since, DEPARTURES) || first(rows, DEPARTURES);
	const hisTapAlone = back && back.own && !first(since, DEPARTURES);
	// It went back and stayed back: a departure on record, the sheet still waiting, no truck record of
	// leaving since the move back, and more than the departing driver's own tap saying so.
	if (departed && waitingOnSheet && !hisTapAlone && eldMs <= (back ? back.ms : rows[rows.length - 1].ms)) return null;
	// The departing driver's own tap back and forward are one person's word, so only the truck's own
	// departure after it moves the credit to a new day.
	if (back && (!back.own || first(since, GEOFENCE))) {
		const moved = read(since, eldMs >= back.ms ? eldMs : 0, { truck: true, tap: true });
		// Nor does a stored ELD departure or a tap with no role on record move one to another day.
		if (moved && moved.source !== "eld" && (moved.source !== "driver" || hisOwnRow(first(since, TAPS)))) return moved;
	}
	// A departure before a move back: staff's word leaves them no certain claim on it, and their own tap
	// back leaves their tap none. Their truck's own record still stands behind a tap back of theirs.
	return read(rows, eldMs, { truck: !back || back.own, tap: !back });
}

module.exports = { qualifiedPickup, statusesStillWaiting };
