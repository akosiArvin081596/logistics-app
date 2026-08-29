#!/usr/bin/env node
// Deterministic check on lib/load-haul.js — the per-load haul window and the
// miles measured across it.
//
// WHY THIS EXISTS. The obvious implementation of "miles driven for this load"
// is to sum odometer deltas between the load's first and last status change.
// That implementation is wrong on this data, and wrong in the worst possible
// direction: it reports a confident ZERO. load_status_history.changed_at is the
// moment a driver TAPPED A BUTTON, and the drivers on this fleet batch-tap on
// arrival. Load 564157463's whole lifecycle — Dispatched -> At Receiver ->
// Delivered — spans 1 minute 54 seconds; its truck drove 248 miles that day.
// Across the 42 loads carrying both markers, In Transit -> Delivered has a
// 2.4-MINUTE minimum.
//
// So the suite pins BOTH directions, because both failures are live risks:
//
//   • A window read off status timestamps must not be able to creep back in —
//     case 2 hands the module a status window two minutes wide and requires the
//     measurement to come out right anyway, from the pings alone.
//   • A leg we genuinely did not observe must report null, never 0 — but a leg
//     we DID observe and which happened to be stationary must report 0, because
//     that is a measurement. Cases 5-8 pin the difference.
//
// No network, no sheet, no database, no server — pure input/output.
//
//   node scripts/test-load-haul-window.js      # exits 1 on any failure

const geolib = require("geolib");
const m = require("../lib/load-haul");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n      expected ${e}\n      actual   ${a}`);
}
function near(label, actual, expected, tol) {
	if (actual !== null && Math.abs(actual - expected) <= tol) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n      expected ${expected} +/- ${tol}\n      actual   ${actual}`);
}
function ok(label, cond) {
	if (cond) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}`);
}

// ---------------------------------------------------------------------------
// Fixture builder — a self-consistent ping series.
//
// The odometer advances by the REAL geodesic distance between consecutive
// fixes, so miles measured out of the module can be checked against the
// geometry that produced them rather than against a hand-typed number.
// ---------------------------------------------------------------------------
const MIN = 60 * 1000;
const HOUSTON = { lat: 29.7604, lng: -95.3698 };
const LAREDO = { lat: 27.5306, lng: -99.4803 };
const M_PER_MI = 1609.344;

function makeTrip() {
	// Shared mutable cursor so every leg continues the same odometer/clock.
	return { t: Date.UTC(2026, 7, 12, 6, 0, 0), odo: 500000, rows: [], last: null };
}
function ping(trip, lat, lng, stepMs) {
	const prev = trip.last;
	if (prev) {
		const meters = geolib.getDistance({ latitude: prev.lat, longitude: prev.lng }, { latitude: lat, longitude: lng });
		trip.odo += meters / M_PER_MI;
	}
	trip.t += stepMs === undefined ? MIN : stepMs;
	const row = { ms: trip.t, lat, lng, odo: Math.round(trip.odo * 1000) / 1000 };
	trip.rows.push(row);
	trip.last = row;
	return row;
}
// Straight-line leg from a to b in `steps` fixes.
function drive(trip, a, b, steps, stepMs) {
	for (let i = 1; i <= steps; i++) {
		const f = i / steps;
		ping(trip, a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f, stepMs);
	}
}
// Sit still for `n` fixes (odometer does not move — a parked truck).
function dwell(trip, n, stepMs) {
	const p = trip.last;
	for (let i = 0; i < n; i++) ping(trip, p.lat, p.lng, stepMs);
}
function offsetNorth(p, miles) {
	return { lat: p.lat + (miles / 69), lng: p.lng };
}
function straightMi(a, b) {
	return geolib.getDistance({ latitude: a.lat, longitude: a.lng }, { latitude: b.lat, longitude: b.lng }) / M_PER_MI;
}

// ---------------------------------------------------------------------------
// 1. The happy path — deadhead in, dwell at the shipper, haul out, arrive.
// ---------------------------------------------------------------------------
const START = offsetNorth(HOUSTON, 60);
const trip = makeTrip();
const dispatchMs = trip.t - 5 * MIN;      // dispatched shortly before the truck rolled
ping(trip, START.lat, START.lng);
drive(trip, START, HOUSTON, 60);          // 60 mi deadhead, 1 mi/min
dwell(trip, 30);                          // half an hour on the dock
drive(trip, HOUSTON, LAREDO, 280);        // the haul
dwell(trip, 10);                          // parked at the receiver

const r1 = m.computeHaulMiles(trip.rows, {
	origin: HOUSTON, dest: LAREDO, dispatchMs, terminal: true,
});

const laneMi = straightMi(HOUSTON, LAREDO);
const radiusMi = m.DEFAULT_REPLAY_RADIUS_M / M_PER_MI;   // 2.0

check("happy path resolves cleanly", r1.reason, "");
check("happy path is not flagged in-progress", r1.inProgress, false);
check("happy path basis is eld", r1.basis, "eld");
// Loaded miles are measured between the zone boundaries, so they exclude ~one
// radius at each end. That bias is documented in lib/load-haul.js and pinned
// here so nobody "fixes" it into a silent change of meaning.
near("loaded miles ~ lane minus the two zone radii", r1.loadedMiles, laneMi - 2 * radiusMi, 3);
near("deadhead miles ~ 60 mi run to the shipper", r1.deadheadMiles, 60 - radiusMi, 3);
near("total is the sum of both legs", r1.totalMiles, r1.loadedMiles + r1.deadheadMiles, 0.11);
ok("departure is after arrival at the shipper", r1.pickupDepartMs > r1.pickupArriveMs);
ok("arrival at the receiver is after departure", r1.destArriveMs > r1.pickupDepartMs);

// ---------------------------------------------------------------------------
// 2. ⚠️ THE BUTTON-PRESS CASE — the whole reason this module exists.
//
// Same physical trip, but the load's status history is the 564157463 shape:
// every transition tapped at the very end, a window under two minutes wide. A
// status-window implementation reports 0.0 miles here. This one must not.
// ---------------------------------------------------------------------------
const lateTapMs = trip.rows[trip.rows.length - 1].ms - 114 * 1000;  // 1m54s before the last fix
const r2 = m.computeHaulMiles(trip.rows, {
	origin: HOUSTON, dest: LAREDO, dispatchMs: lateTapMs, terminal: true,
});
ok("button-press window does NOT zero the haul", r2.loadedMiles > 200);
check("loaded miles ignore the status timestamps entirely", r2.loadedMiles, r1.loadedMiles);
// The deadhead leg is the one place a dispatch timestamp is still used, so a
// late tap legitimately loses it — and it must go to null, not to 0.
check("a late dispatch tap yields no deadhead figure", r2.deadheadMiles, null);
check("...and therefore no total", r2.totalMiles, null);
ok("null is not zero", r2.deadheadMiles !== 0);

// ---------------------------------------------------------------------------
// 3. Yard shuffling — the truck leaves and re-enters the pickup zone.
//    Departure must anchor on the LAST exit, not the first.
// ---------------------------------------------------------------------------
const shuffle = makeTrip();
const shuffleDispatch = shuffle.t - MIN;
ping(shuffle, HOUSTON.lat, HOUSTON.lng);
dwell(shuffle, 5);
drive(shuffle, HOUSTON, offsetNorth(HOUSTON, 3), 3);   // out past the 2-mile ring
drive(shuffle, offsetNorth(HOUSTON, 3), HOUSTON, 3);   // and back to the dock
dwell(shuffle, 5);
drive(shuffle, HOUSTON, LAREDO, 280);
const r3 = m.computeHaulMiles(shuffle.rows, {
	origin: HOUSTON, dest: LAREDO, dispatchMs: shuffleDispatch, terminal: true,
});
const firstExitMs = shuffle.rows[7].ms;   // somewhere in the first excursion
ok("a yard excursion does not start the haul early", r3.pickupDepartMs > firstExitMs);
near("yard shuffling is not billed as line-haul", r3.loadedMiles, laneMi - 2 * radiusMi, 3);

// ---------------------------------------------------------------------------
// 4. Short lane — the zones would otherwise overlap and departure never fires.
//    Same geometry that would strand a short load at "At Shipper".
// ---------------------------------------------------------------------------
const NEAR_DEST = offsetNorth(HOUSTON, 3);
ok("a 3-mile lane shrinks the zone radius", m.effectiveRadiusM(
	{ latitude: HOUSTON.lat, longitude: HOUSTON.lng },
	{ latitude: NEAR_DEST.lat, longitude: NEAR_DEST.lng },
	m.DEFAULT_REPLAY_RADIUS_M) < m.DEFAULT_REPLAY_RADIUS_M);
ok("a long lane does not", m.effectiveRadiusM(
	{ latitude: HOUSTON.lat, longitude: HOUSTON.lng },
	{ latitude: LAREDO.lat, longitude: LAREDO.lng },
	m.DEFAULT_REPLAY_RADIUS_M) === m.DEFAULT_REPLAY_RADIUS_M);
ok("the shrink never goes below the floor", m.effectiveRadiusM(
	{ latitude: 29.7604, longitude: -95.3698 },
	{ latitude: 29.7605, longitude: -95.3698 },
	m.DEFAULT_REPLAY_RADIUS_M) >= m.MIN_EFFECTIVE_RADIUS_M);

const shortTrip = makeTrip();
const shortDispatch = shortTrip.t - MIN;
ping(shortTrip, HOUSTON.lat, HOUSTON.lng);
dwell(shortTrip, 3);
drive(shortTrip, HOUSTON, NEAR_DEST, 12, 15 * 1000);
dwell(shortTrip, 3);
const r4 = m.computeHaulMiles(shortTrip.rows, {
	origin: HOUSTON, dest: NEAR_DEST, dispatchMs: shortDispatch, terminal: true,
});
check("a 3-mile lane still resolves", r4.reason, "");
ok("a short haul reports real miles", r4.loadedMiles !== null && r4.loadedMiles > 0);

// ---------------------------------------------------------------------------
// 5-8. The null-versus-zero discipline.
// ---------------------------------------------------------------------------
// 5. No telemetry at all.
const rNone = m.computeHaulMiles([], { origin: HOUSTON, dest: LAREDO, dispatchMs, terminal: true });
check("no telemetry reports no_samples", rNone.reason, "no_samples");
check("...loaded is null, not 0", rNone.loadedMiles, null);
check("...total is null, not 0", rNone.totalMiles, null);
check("...basis is no-data", rNone.basis, "no-data");

// 6. No coordinates for the load.
const rNoCoord = m.computeHaulMiles(trip.rows, { origin: null, dest: LAREDO, dispatchMs, terminal: true });
check("a load with no mapped pickup reports no_coordinates", rNoCoord.reason, "no_coordinates");
check("...and measures nothing", rNoCoord.loadedMiles, null);

// 7. Still sitting at the shipper.
const atDock = makeTrip();
ping(atDock, HOUSTON.lat, HOUSTON.lng);
dwell(atDock, 20);
const rDock = m.computeHaulMiles(atDock.rows, {
	origin: HOUSTON, dest: LAREDO, dispatchMs: atDock.rows[0].ms - MIN, terminal: false,
});
check("a truck still on the dock has not departed", rDock.reason, "no_departure");
check("...so there are no loaded miles yet", rDock.loadedMiles, null);
// The deadhead leg here spans dispatch -> the FIRST fix at the shipper, which is
// a single fix. One fix cannot describe a distance, so this is null too — the
// truck was already on the dock when the load was dispatched.
check("a one-fix leg is unmeasurable, not zero", rDock.deadheadMiles, null);

// The other half of that distinction, pinned directly: a leg we DID observe
// across many fixes, and across which the truck did not move, is a measurement.
// 0 is the honest answer and it must not collapse into the same null as "we
// never saw it" — the coverage label is what separates them.
const parked = m.legMiles(atDock.rows, atDock.rows[0].ms, atDock.rows[10].ms);
check("an observed stationary leg reports 0, not null", parked.miles, 0);
check("...with an eld basis, because nothing was thrown away", parked.basis, "eld");
ok("...off real samples, not an empty slice", parked.samples > 2);

// 8. Closed-out load whose arrival was never seen.
const noArrive = makeTrip();
const naDispatch = noArrive.t - MIN;
ping(noArrive, HOUSTON.lat, HOUSTON.lng);
dwell(noArrive, 5);
drive(noArrive, HOUSTON, LAREDO, 100);        // stops well short of the receiver
const rNoArriveClosed = m.computeHaulMiles(noArrive.rows.slice(0, 60), {
	origin: HOUSTON, dest: LAREDO, dispatchMs: naDispatch, terminal: true,
});
check("a delivered load we never saw arrive reports no_arrival", rNoArriveClosed.reason, "no_arrival");
check("...and refuses to guess the loaded miles", rNoArriveClosed.loadedMiles, null);

// ...whereas the identical telemetry on a LIVE load is mid-haul, and is measured
// up to the newest fix.
const rNoArriveLive = m.computeHaulMiles(noArrive.rows.slice(0, 60), {
	origin: HOUSTON, dest: LAREDO, dispatchMs: naDispatch, terminal: false,
});
check("the same shape on a live load is in-progress", rNoArriveLive.inProgress, true);
ok("...and reports miles so far", rNoArriveLive.loadedMiles > 10);

// ---------------------------------------------------------------------------
// 9. The ELD reset must survive the walk — lib/eld-miles.js guard 3, reached
//    through this module rather than directly.
// ---------------------------------------------------------------------------
const reset = makeTrip();
const resetDispatch = reset.t - MIN;
ping(reset, HOUSTON.lat, HOUSTON.lng);
dwell(reset, 3);
drive(reset, HOUSTON, LAREDO, 280);
// Swap the device halfway: every later odometer reading drops by 219,818.
const half = Math.floor(reset.rows.length / 2);
for (let i = half; i < reset.rows.length; i++) reset.rows[i].odo -= 219818;
const r9 = m.computeHaulMiles(reset.rows, {
	origin: HOUSTON, dest: LAREDO, dispatchMs: resetDispatch, terminal: true,
});
ok("an ELD reset is never billed as distance", r9.loadedMiles < laneMi + 5);
ok("...the miles either side of it are still counted", r9.loadedMiles > laneMi * 0.4);
check("...and the loss is disclosed as partial", r9.basis, "partial");
ok("...with the dropped magnitude recorded", r9.droppedMiles > 200000);

// ---------------------------------------------------------------------------
// 9b. The deadhead floor. Dispatch happens days ahead of the truck actually
//     rolling — load 563166022's own status history spans 170 hours — so an
//     unclamped deadhead leg absorbs whatever the truck hauled in between and
//     reports it as this load's repositioning.
// ---------------------------------------------------------------------------
const ARRIVE = 1_000_000_000;
const DISPATCH = ARRIVE - 7 * 24 * 3600 * 1000;
check("with no prior load the dispatch tap stands",
	m.deadheadFloorMs([], ARRIVE, DISPATCH), DISPATCH);
check("a prior load that ended later raises the floor",
	m.deadheadFloorMs([{ endMs: ARRIVE - 3600 * 1000 }], ARRIVE, DISPATCH), ARRIVE - 3600 * 1000);
check("the LATEST prior load wins",
	m.deadheadFloorMs([
		{ endMs: ARRIVE - 5 * 3600 * 1000 },
		{ endMs: ARRIVE - 2 * 3600 * 1000 },
		{ endMs: ARRIVE - 9 * 3600 * 1000 },
	], ARRIVE, DISPATCH), ARRIVE - 2 * 3600 * 1000);
check("a load that ended BEFORE dispatch cannot lower the floor",
	m.deadheadFloorMs([{ endMs: DISPATCH - 3600 * 1000 }], ARRIVE, DISPATCH), DISPATCH);
check("a load still running past the pickup is not a floor",
	m.deadheadFloorMs([{ endMs: ARRIVE + 3600 * 1000 }], ARRIVE, DISPATCH), DISPATCH);
// ⚠️ A prior load must never CREATE a window where dispatch gave us none.
check("no dispatch timestamp means no deadhead leg, prior load or not",
	m.deadheadFloorMs([{ endMs: ARRIVE - 3600 * 1000 }], ARRIVE, null), null);

// End to end: the floor actually shrinks the measured leg.
const wide = m.computeHaulMiles(trip.rows, {
	origin: HOUSTON, dest: LAREDO, dispatchMs: trip.rows[0].ms - 3 * 24 * 3600 * 1000, terminal: true,
});
const clamped = m.computeHaulMiles(trip.rows, {
	origin: HOUSTON, dest: LAREDO,
	dispatchMs: m.deadheadFloorMs([{ endMs: trip.rows[10].ms }], wide.pickupArriveMs, trip.rows[0].ms - 3 * 24 * 3600 * 1000),
	terminal: true,
});
ok("clamping to the previous load shortens the deadhead", clamped.deadheadMiles < wide.deadheadMiles);
ok("...without touching the loaded leg", clamped.loadedMiles === wide.loadedMiles);

// ---------------------------------------------------------------------------
// 9c. Driver -> truck AT THE TIME OF THE LOAD.
//
// Rows below are the real shapes out of truck_assignments (ISO instants, and
// '' for "still open"). The mid-day handover is real too: on 2026-08-12 at
// 23:16:13.964Z Jayden Morrison moved off Logisx-#91 onto LogisX-#2372 and
// Shorn King took #91 ninety-eight seconds later.
// ---------------------------------------------------------------------------
const ASSIGNMENTS = [
	{ driver_name: 'Howard Reddie', truck_id: 2, unit: 'LogisX-#33', vid: 'VID33',
	  start_date: '2026-05-19T14:25:33.210Z', end_date: '' },
	{ driver_name: 'Howard Reddie', truck_id: 2, unit: 'LogisX-#33', vid: 'VID33',
	  start_date: '2026-05-13T10:47:01.338Z', end_date: '2026-05-19T14:25:33.210Z' },
	{ driver_name: 'Jayden Morrison', truck_id: 11, unit: 'Logisx-#91', vid: 'VID91',
	  start_date: '2026-08-11T16:53:15.262Z', end_date: '2026-08-12T23:16:13.964Z' },
	{ driver_name: 'Jayden  Morrison', truck_id: 3, unit: 'LogisX-#2372', vid: 'VID2372',
	  start_date: '2026-08-12T23:16:13.964Z', end_date: '' },
	{ driver_name: 'Shorn King', truck_id: 11, unit: 'Logisx-#91', vid: 'VID91',
	  start_date: '2026-08-12T23:17:51.574Z', end_date: '' },
];
// The server injects normalizeDriverName(), which also collapses INTERNAL
// whitespace — note the deliberate double space in 'Jayden  Morrison' above.
const normName = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
const tr = m.buildTruckAtResolver(ASSIGNMENTS, normName);
const at = (iso) => Date.parse(iso);

check("a load inside an open assignment resolves",
	tr.forDriverAt('Howard Reddie', at('2026-08-07T18:00:00Z'))?.unit, 'LogisX-#33');
check("...and so does one inside the CLOSED earlier assignment",
	tr.forDriverAt('Howard Reddie', at('2026-05-15T00:00:00Z'))?.unit, 'LogisX-#33');
check("before any assignment there is no truck",
	tr.forDriverAt('Howard Reddie', at('2026-01-01T00:00:00Z')), null);
check("an unknown driver has no truck",
	tr.forDriverAt('Nobody At All', at('2026-08-07T18:00:00Z')), null);
// ⚠️ The whole point of asking historically: the same driver, two dates, two trucks.
check("before the handover the driver is on #91",
	tr.forDriverAt('Jayden Morrison', at('2026-08-12T10:00:00Z'))?.unit, 'Logisx-#91');
check("after it they are on #2372",
	tr.forDriverAt('Jayden Morrison', at('2026-08-13T10:00:00Z'))?.unit, 'LogisX-#2372');
// A handover writes one instant into both rows; the truck moved TO must win.
check("at the exact handover instant the NEW truck wins",
	tr.forDriverAt('Jayden Morrison', at('2026-08-12T23:16:13.964Z'))?.unit, 'LogisX-#2372');
// ⚠️ '' end_date is UNBOUNDED, not the epoch. Reading it the other way waves
// through exactly the assignment that is still running.
check("an open assignment covers the distant future",
	tr.forDriverAt('Shorn King', at('2027-01-01T00:00:00Z'))?.unit, 'Logisx-#91');
check("a typo'd double space still matches one driver",
	tr.forDriverAt('Jayden   Morrison', at('2026-08-13T10:00:00Z'))?.truck_id, 3);
check("a non-finite instant resolves nothing",
	tr.forDriverAt('Howard Reddie', NaN), null);
check("no assignments at all is not a crash",
	m.buildTruckAtResolver([], normName).forDriverAt('Howard Reddie', at('2026-08-07T18:00:00Z')), null);
check("a row with an unparseable start_date is ignored",
	m.buildTruckAtResolver([{ driver_name: 'X', truck_id: 1, unit: 'U', vid: 'V',
		start_date: 'not a date', end_date: '' }], normName).forDriverAt('X', at('2026-08-07T18:00:00Z')), null);

// ---------------------------------------------------------------------------
// 10. Window overlap — two loads on one truck cannot both own the same mile.
// ---------------------------------------------------------------------------
check("plainly overlapping windows overlap", m.windowsOverlap(100, 200, 150, 250), true);
check("disjoint windows do not", m.windowsOverlap(100, 200, 300, 400), false);
check("touching endpoints do not count", m.windowsOverlap(100, 200, 200, 300), false);
check("a window contained in another overlaps", m.windowsOverlap(100, 400, 200, 300), true);
check("a null bound is never an overlap", m.windowsOverlap(100, null, 150, 250), false);

// ---------------------------------------------------------------------------
// 11. Input hygiene — the same junk the telemetry table really holds.
// ---------------------------------------------------------------------------
check("a null-island fix is dropped", m.normalizeSamples([{ ms: 1, odo: 10, lat: 0, lng: 0 }]).length, 0);
check("a zero odometer is dropped", m.normalizeSamples([{ ms: 1, odo: 0, lat: 29, lng: -95 }]).length, 0);
// ⚠️ Number(null) is 0. Without an explicit empty check this row survives with
// lat 0 and the truck reads as being on the equator.
check("a missing position is dropped", m.normalizeSamples([{ ms: 1, odo: 10, lat: null, lng: -95 }]).length, 0);
check("a missing dispatchMs does not become the epoch",
	m.computeHaulMiles(trip.rows, { origin: HOUSTON, dest: LAREDO, dispatchMs: null, terminal: true }).deadheadMiles, null);
check("unsorted input is ordered", m.normalizeSamples([
	{ ms: 3, odo: 12, lat: 29, lng: -95 },
	{ ms: 1, odo: 10, lat: 29, lng: -95 },
]).map((r) => r.ms), [1, 3]);
// pointOf rejects null island for the LOAD's coordinates too — a load whose
// pickup geocoded to 0,0 must read as unmapped, not as a point off Africa.
check("a load geocoded to null island reads as unmapped",
	m.computeHaulMiles(trip.rows, { origin: { lat: 0, lng: 0 }, dest: LAREDO, dispatchMs, terminal: true }).reason,
	"no_coordinates");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
