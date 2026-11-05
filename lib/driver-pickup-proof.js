"use strict";

// One load's pickup for a driver's own count: who made it, when and how we know, or why the
// record doesn't prove one. A first "In Transit" alone can be a load the truck only passed, one of
// two twins at one shipper, a status later moved back, or another driver's pickup of a load handed
// over since. Display only: nothing that pays reads this.
//
// Pure: every fact about trucks, names and other loads is asked through the functions it is
// handed, so lib/driver-performance-routes.js gathers them and the rule stays here.

const arrivalPickup = require("./arrival-pickup");
const fuelPickupArrival = require("./fuel-pickup-arrival");
const { pickupEvidence } = require("./driver-performance");

const WAITING_RE = /^(|unassigned|dispatched|assigned|heading to shipper|at shipper|loading)$/;
const LEFT_RE = /^(in transit|at receiver|unloading|delivered|completed|pod received)$/;
const CANCELLED_RE = /^cancel(l?ed)?$/;
// The rows that name the driver himself: a dispatcher's row names the dispatcher.
const DRIVER_WRITES = new Set(["geofence", "manual", "accept"]);

const statusOf = (s) => String(s === null || s === undefined ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");

// Whether a load's status cells all say it hasn't left its shipper: a row editor or the sheet
// moves a status back and writes no history, so the record alone can't say.
function statusesStillWaiting(statuses) {
	const live = (statuses || []).map(statusOf).filter((s) => !CANCELLED_RE.test(s));
	return live.length > 0 && live.every((s) => WAITING_RE.test(s));
}

// The run's rows from the last time the status went back over the departure, which arrivalPickup's
// run keeps when it goes back only as far as At Shipper. A row written from a waiting status right
// after a departure is a move back no row recorded.
function standingRows(runRows) {
	let from = 0;
	for (let k = 1; k < runRows.length; k++) {
		const r = runRows[k];
		if (!LEFT_RE.test(runRows[k - 1].status)) continue;
		if (WAITING_RE.test(r.status) || (r.status === "in transit" && r.old && WAITING_RE.test(r.old))) from = k;
	}
	return runRows.slice(from);
}

// { driverKey, ms, source }, { driverKey, ms, withheld } with why it isn't proof enough ("no-driver"
// has no driverKey), or null with nothing to judge.
//   events           the load's history rows
//   eldDepart        { ms, truckId }, the truck's own record of leaving the shipper, or null
//   driverNow        the load's driver on the sheet now, by normalizeName
//   waitingOnSheet   statusesStillWaiting() of its rows
//   isDriverName(key)       does a driver hold that name today
//   heldTruckAt(key, ms)    did he hold a truck at that instant
//   holderOf(truckId, ms)   who held that truck at that instant
//   truckHasEldAt(key, ms), errandAt(key, ms), twinAt(key, ms)   each asked of the driver in question
function qualifiedPickup({ events, eldDepart = null, driverNow = "", waitingOnSheet = false, normalizeName, isDriverName, heldTruckAt, holderOf, truckHasEldAt, errandAt, twinAt }) {
	const every = arrivalPickup.orderedRows(events);
	const run = fuelPickupArrival.currentRun(events);
	const runRows = run ? run.rows : [];
	const rows = standingRows(runRows);
	const transit = rows.filter((r) => r.status === "in transit");

	// The log keeps a name as it was spelled, and a rename doesn't touch it. A spelling nobody holds
	// today is the driver's the sheet and the truck assignments were renamed to, if he held a truck then.
	const writerOf = (r) => {
		const actor = normalizeName(r.actor);
		if (actor && isDriverName(actor)) return actor;
		return driverNow && heldTruckAt(driverNow, r.ms) ? driverNow : "";
	};
	// A reassign writes no row, so the driver on the load at a dispatcher's tap is whoever wrote the
	// nearest row of his own, the last before it or else the first after it.
	const driverOnLoadAt = (ms) => {
		const own = runRows.filter((r) => DRIVER_WRITES.has(r.source));
		const near = [...own].reverse().find((r) => r.ms <= ms) || own.find((r) => r.ms > ms);
		return near ? writerOf(near) : driverNow;
	};
	const judge = (who, ms, moments, marked) => {
		if (!who) return { ms, withheld: "no-driver" };
		if (marked || moments.some((m) => errandAt(who, m))) return { driverKey: who, ms, withheld: "errand" };
		if (moments.some((m) => twinAt(who, m))) return { driverKey: who, ms, withheld: "twin" };
		return { driverKey: who, ms };
	};
	const atVisit = (r, who) => {
		const arrival = [...rows].reverse().find((a) => a.status === "at shipper" && a.ms <= r.ms);
		return judge(who, r.ms, arrival ? [arrival.ms, r.ms] : [r.ms], (arrival && arrival.hauling === 1) || r.hauling === 1);
	};

	const geofenceRow = transit.find((r) => r.source === "geofence");
	const geofence = geofenceRow ? atVisit(geofenceRow, writerOf(geofenceRow)) : null;

	// An ELD departure before the load's current run began isn't this run's. With no history at all it
	// stands alone; with a last row of Cancelled it has no run to stand in.
	const departMs = eldDepart ? Number(eldDepart.ms) : 0;
	const startMs = rows.length && (rows.length < every.length || rows[0].status === "dispatched") ? rows[0].ms : -Infinity;
	const departStands = departMs > 0 && (every.length === 0 || (rows.length > 0 && departMs >= startMs));
	let eld = null;
	if (departStands) {
		const truckId = Number(eldDepart.truckId);
		const who = truckId > 0 ? holderOf(truckId, departMs) : (driverNow && heldTruckAt(driverNow, departMs) ? driverNow : "");
		eld = judge(who, departMs, [departMs], false);
	}

	const tapRow = transit.find((r) => r.source === "manual" || r.source === "override");
	const tap = tapRow ? atVisit(tapRow, tapRow.source === "manual" ? writerOf(tapRow) : driverOnLoadAt(tapRow.ms)) : null;
	const clear = (answer) => (answer && !answer.withheld ? answer.ms : 0);

	const evidence = pickupEvidence({
		geofenceMs: clear(geofence),
		eldDepartMs: clear(eld),
		tapMs: clear(tap),
		tapSource: tapRow && tapRow.source === "override" ? "dispatch" : "driver",
		truckHasEld: !!tap && !tap.withheld && truckHasEldAt(tap.driverKey, tap.ms),
	});
	if (evidence) {
		const by = evidence.source === "geofence" ? geofence : evidence.source === "eld" ? eld : tap;
		if (waitingOnSheet) return { driverKey: by.driverKey, ms: evidence.ms, withheld: "undone" };
		return { driverKey: by.driverKey, ms: evidence.ms, source: evidence.source };
	}
	if (geofence) return geofence;
	if (eld) return eld;
	if (tap) return tap.withheld ? tap : { ...tap, withheld: "no-truck-record" };
	const older = every.find((r) => r.status === "in transit");
	if (older) return { ms: older.ms, withheld: "undone" };
	return departMs > 0 ? { ms: departMs, withheld: "undone" } : null;
}

module.exports = { qualifiedPickup, statusesStillWaiting };
