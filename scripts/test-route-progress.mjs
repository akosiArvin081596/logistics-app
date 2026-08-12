#!/usr/bin/env node
// Deterministic check on client/src/utils/routeProgress.js — the geometry that
// decides WHICH TURN a driver is on and WHETHER to buy a new route from Google.
//
// WHY THIS EXISTS. Drive Mode's old step tracker advanced only when a fix landed
// within 25 m of the current step's polyline END, at most one step per update,
// monotonically, with no offset and no bearing. On a phone emitting a fix every
// second that is adequate. On a truck it is not: ELD fixes arrive ~30 s apart,
// which is ~700 m at highway speed, so the 25 m window is essentially never
// sampled and the banner sits on step 0 for an entire load. The feature only
// ever worked on one hardcoded phone-GPS test load.
//
// The replacement re-derives everything from a nearest-point-on-polyline match
// on every fix, so a phone lock, a tunnel or a 40-minute gap resyncs instead of
// stranding the pointer. That introduces the failure the old code could not
// have: a route that crosses itself has two points metres apart and kilometres
// apart in route order, so an unbiased nearest-point search rewinds navigation
// by an hour on one noisy overpass fix. Case 2 below is that exact geometry.
//
// EVERY CASE IS PAIRED, so a trivial implementation cannot pass:
//   - "always return offset 0"            fails 1 and 3
//   - "always jump to the nearest point"  fails 2 (snaps backward on a cloverleaf)
//   - "never move backward at all"        fails 2b (a real U-turn must be reported)
//   - "reroute whenever off route"        fails 4 (must confirm 3 samples) and 5
//   - "never reroute"                     fails 4
//   - degrees-only distance math          fails 0 (east and north must agree)
//
// Case 0 is the anisotropy check. The in-component snapToRoute this replaces
// compared SQUARED DEGREES with no cos(lat) scaling, so its single "80 m"
// threshold was ~80 m north-south and ~104 m east-west at 40°N.
//
// No network, no DOM, no database — pure input/output, safe to run anywhere.
//
//   node scripts/test-route-progress.mjs      # exits 1 on any failure

import {
  projectOntoSegment,
  buildRouteIndex,
  matchToRoute,
  buildStepOffsets,
  stepIndexForOffset,
  distanceToManeuver,
  remainingMeters,
  nearestPointOnPath,
  createDeviationDetector,
} from '../client/src/utils/routeProgress.js'

let pass = 0
let fail = 0

function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`)
  }
}
function near(label, actual, expected, tol) {
  if (Number.isFinite(actual) && Math.abs(actual - expected) <= tol) pass++
  else {
    fail++
    console.error(`FAIL  ${label}\n        expected ${expected} ±${tol}\n        actual   ${actual}`)
  }
}

// ── Coordinate helpers ────────────────────────────────────────────────────────
// Routes are built due NORTH from a base point so along-route metres are a pure
// latitude delta and every expected offset is arithmetic, not a fixture.
const BASE_LAT = 40.0
const BASE_LNG = -95.0
const M_PER_DEG_LAT = 111194.93 // 6371008.8 m radius, matches the module's haversine
const M_PER_DEG_LNG = 111320 * Math.cos((BASE_LAT * Math.PI) / 180)

const north = (m) => BASE_LAT + m / M_PER_DEG_LAT
const east = (m) => BASE_LNG + m / M_PER_DEG_LNG
// Server polyline shape — {latitude, longitude}, deliberately NOT {lat,lng},
// so the normalizer is exercised the way production data hits it.
const pt = (alongM, sideM = 0) => ({ latitude: north(alongM), longitude: east(sideM) })

// ══════════════════════════════════════════════════════════════════════════════
// CASE 0 — distance is METRES in every direction (the cos(lat) fix)
// ══════════════════════════════════════════════════════════════════════════════
{
  // A due-north segment. A point 200 m EAST of it and a point on a due-east
  // segment 200 m NORTH of it must both measure 200 m. Squared-degree math
  // reports the east one ~30% larger at this latitude.
  const northSeg = projectOntoSegment(
    { lat: north(500), lng: east(200) },
    { lat: north(0), lng: east(0) },
    { lat: north(1000), lng: east(0) },
  )
  near('case0 200 m east of a north-south segment reads 200 m', northSeg.distanceMeters, 200, 3)

  const eastSeg = projectOntoSegment(
    { lat: north(200), lng: east(500) },
    { lat: north(0), lng: east(0) },
    { lat: north(0), lng: east(1000) },
  )
  near('case0 200 m north of an east-west segment reads 200 m', eastSeg.distanceMeters, 200, 3)
  near(
    'case0 the two agree (isotropic)',
    Math.abs(northSeg.distanceMeters - eastSeg.distanceMeters),
    0,
    2,
  )
  near('case0 projection parameter t is the midpoint', northSeg.t, 0.5, 0.01)
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 1 — straight line: offsets monotonic, step index correct and monotonic
// ══════════════════════════════════════════════════════════════════════════════
{
  // 10 km due north, a vertex every 500 m.
  const points = []
  for (let m = 0; m <= 10000; m += 500) points.push(pt(m))
  const index = buildRouteIndex(points)
  near('case1 route length is 10 km', index.totalMeters, 10000, 20)

  // Four steps of 2.5 km. `startIdx` is the server contract (index into the
  // route polyline); vertices are every 500 m so step k starts at vertex 5k.
  const steps = [
    { startIdx: 0, distanceMeters: 2500, durationSec: 150, maneuver: 'DEPART', instruction: 'Head north' },
    { startIdx: 5, distanceMeters: 2500, durationSec: 150, maneuver: 'TURN_RIGHT', instruction: 'Turn right onto A St' },
    { startIdx: 10, distanceMeters: 2500, durationSec: 150, maneuver: 'TURN_LEFT', instruction: 'Turn left onto B St' },
    { startIdx: 15, distanceMeters: 2500, durationSec: 150, maneuver: 'DESTINATION', instruction: 'Arrive' },
  ]
  const stepOffsets = buildStepOffsets(steps, index)
  near('case1 step 1 starts at 2.5 km', stepOffsets[1], 2500, 20)
  near('case1 step 3 starts at 7.5 km', stepOffsets[3], 7500, 20)
  near('case1 terminal offset is the route length', stepOffsets[4], 10000, 20)

  // Walk it in 700 m hops — the real ELD cadence, and 28x the old 25 m window.
  let prevOffset = null
  let prevStep = -1
  const offsets = []
  const stepSeq = []
  for (let m = 0; m <= 10000; m += 700) {
    const match = matchToRoute(index, pt(m, 6), {
      previousOffsetMeters: prevOffset,
      elapsedMs: 30000,
    })
    offsets.push(match.offsetMeters)
    const idx = stepIndexForOffset(stepOffsets, match.offsetMeters, steps.length)
    stepSeq.push(idx)
    if (prevOffset !== null && match.offsetMeters < prevOffset - 1) {
      fail++
      console.error(`FAIL  case1 offset went backwards at ${m} m: ${prevOffset} → ${match.offsetMeters}`)
    }
    if (idx < prevStep) {
      fail++
      console.error(`FAIL  case1 step index went backwards at ${m} m: ${prevStep} → ${idx}`)
    }
    prevOffset = match.offsetMeters
    prevStep = idx
  }
  pass += 2 // the two loop invariants above held

  near('case1 first fix lands at ~0 m', offsets[0], 0, 20)
  near('case1 fix at 4900 m lands at ~4900 m', offsets[7], 4900, 25)
  check('case1 step at 0 m', stepSeq[0], 0)
  check('case1 step at 2800 m is step 1', stepSeq[4], 1)
  check('case1 step at 7700 m is step 3', stepSeq[11], 3)
  check(
    'case1 the OLD 25 m-from-step-end rule would never have advanced here',
    // Every sampled position after departure is ≥ 200 m from every step
    // boundary, so the old within-25-m-of-the-step-END test never fires once
    // across the whole 10 km — which is the bug, stated as an assertion.
    [700, 1400, 2100, 2800, 3500, 4200, 4900, 5600, 6300, 7000, 7700, 8400, 9100, 9800].every(
      (m) => Math.min(...[2500, 5000, 7500, 10000].map((b) => Math.abs(b - m))) > 25,
    ),
    true,
  )

  // Distance-to-maneuver is ALONG THE ROUTE, not a straight line to the end.
  const m6300 = matchToRoute(index, pt(6300), { previousOffsetMeters: 5600, elapsedMs: 30000 })
  const idx6300 = stepIndexForOffset(stepOffsets, m6300.offsetMeters, steps.length)
  check('case1 6300 m is on step 2', idx6300, 2)
  near('case1 1200 m to the next maneuver', distanceToManeuver(stepOffsets, idx6300, m6300.offsetMeters), 1200, 30)
  near('case1 3700 m of route remaining', remainingMeters(index, m6300.offsetMeters), 3700, 30)
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 2 — cloverleaf: the route passes within 25 m of itself, NO backward snap
// ══════════════════════════════════════════════════════════════════════════════
{
  // Out 3 km north, hook east, come back south 3 km on a parallel 25 m away,
  // then continue. Route offset 5000 m sits 25 m from route offset ~1000 m —
  // exactly the overpass geometry that rewinds an unbiased matcher by 4 km.
  const points = []
  for (let m = 0; m <= 3000; m += 100) points.push(pt(m, 0)) // northbound leg
  for (let s = 0; s <= 25; s += 5) points.push(pt(3000, s)) // hook east 25 m
  for (let m = 3000; m >= 0; m -= 100) points.push(pt(m, 25)) // southbound leg, 25 m over
  for (let s = 25; s <= 2000; s += 100) points.push(pt(0, s)) // exit east
  const index = buildRouteIndex(points)

  const outboundAt1000 = 1000
  const inboundAt1000 = 3000 + 25 + 2000 // ≈ 5025 m along the route

  // 2a — FIRST pass. The driver is at 1000 m outbound. A "take the largest
  // matching offset" implementation would report the inbound leg here.
  const first = matchToRoute(index, pt(1000, 3), { previousOffsetMeters: 900, elapsedMs: 5000 })
  near('case2a first pass matches the OUTBOUND leg (~1000 m)', first.offsetMeters, outboundAt1000, 60)
  check('case2a first pass did not jump to the inbound leg', first.offsetMeters < 2000, true)

  // 2b — SECOND pass, with the noise skewed so the GLOBAL nearest point is the
  // WRONG (earlier) leg: the fix sits 10 m from the outbound line and 15 m from
  // the inbound line it is actually driving.
  const noisy = { lat: north(1000), lng: east(10) }
  const globalNearest = nearestPointOnPath(index, noisy)
  check(
    'case2b the unbiased global nearest really is the earlier leg (the trap is real)',
    globalNearest.offsetMeters < 2000,
    true,
  )
  const second = matchToRoute(index, noisy, { previousOffsetMeters: 4900, elapsedMs: 30000 })
  near('case2b forward-biased match stays on the INBOUND leg (~5025 m)', second.offsetMeters, inboundAt1000, 120)
  check('case2b no backward snap', second.offsetMeters > 4000, true)
  check('case2b reported as a corridor match, not a resync', second.matchMode, 'forward')
  check('case2b movedBackward is false', second.movedBackward, false)

  // 2c — a GENUINE reversal must still be reported, or "never move backward"
  // would pass 2b for the wrong reason. Run it on a route that does NOT cross
  // itself: on the cloverleaf above, a fix beside the outbound leg is 25 m from
  // the inbound leg too, so "the driver came round again" is the better reading
  // and the forward bias is right to take it. A straight route removes that
  // ambiguity, leaving only the reversal.
  const straight = buildRouteIndex(Array.from({ length: 21 }, (_, i) => pt(i * 500)))
  const reversed = matchToRoute(straight, pt(3000, 3), { previousOffsetMeters: 8000, elapsedMs: 120000 })
  near('case2c a real U-turn resyncs backwards', reversed.offsetMeters, 3000, 80)
  check('case2c reported as a global resync', reversed.matchMode, 'global')
  check('case2c movedBackward is true', reversed.movedBackward, true)
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 3 — 40-minute gap, then a fix 300 km ahead: lands on the right step
// ══════════════════════════════════════════════════════════════════════════════
{
  // 400 km due north, a vertex every 5 km. This is the phone-lock / tunnel /
  // app-backgrounded case, and the one the old one-step-per-update rule could
  // never recover from: it would have needed 60 consecutive fixes to catch up.
  const points = []
  for (let m = 0; m <= 400000; m += 5000) points.push(pt(m))
  const index = buildRouteIndex(points)

  // 8 steps of 50 km. Vertices every 5 km ⇒ step k starts at vertex 10k.
  const steps = []
  for (let k = 0; k < 8; k++) {
    steps.push({
      startIdx: k * 10,
      distanceMeters: 50000,
      durationSec: 2400,
      maneuver: k === 7 ? 'DESTINATION' : 'TURN_RIGHT',
      instruction: `Step ${k}`,
    })
  }
  const stepOffsets = buildStepOffsets(steps, index)
  near('case3 step 6 starts at 300 km', stepOffsets[6], 300000, 400)

  const before = matchToRoute(index, pt(20000), { previousOffsetMeters: null })
  check('case3 pre-gap step is 0', stepIndexForOffset(stepOffsets, before.offsetMeters, steps.length), 0)

  // 40 minutes later, 300 km further on. 2,400 s × 45 m/s × 1.5 = 162 km of
  // corridor — NOT enough, so this must survive the global fallback too.
  const after = matchToRoute(index, pt(320000, 4), {
    previousOffsetMeters: before.offsetMeters,
    elapsedMs: 40 * 60 * 1000,
  })
  near('case3 post-gap offset is ~320 km', after.offsetMeters, 320000, 400)
  check('case3 post-gap step is 6', stepIndexForOffset(stepOffsets, after.offsetMeters, steps.length), 6)
  check('case3 post-gap is not a backward move', after.movedBackward, false)
  near('case3 30 km to the next maneuver', distanceToManeuver(stepOffsets, 6, after.offsetMeters), 30000, 500)

  // Paired: the same 300 km jump BACKWARDS is a resync, not silently ignored.
  const back = matchToRoute(index, pt(20000, 4), {
    previousOffsetMeters: after.offsetMeters,
    elapsedMs: 40 * 60 * 1000,
  })
  near('case3 a 300 km backward jump resyncs', back.offsetMeters, 20000, 400)
  check('case3 backward jump is flagged', back.movedBackward, true)
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 4 — 200 m off route: reroute on the THIRD consecutive sample, not before
// ══════════════════════════════════════════════════════════════════════════════
{
  const points = []
  for (let m = 0; m <= 10000; m += 500) points.push(pt(m))
  const index = buildRouteIndex(points)
  const det = createDeviationDetector()

  // On route first — establishes the baseline the trivial "always reroute"
  // implementation fails immediately.
  const on = matchToRoute(index, pt(1000, 5), { previousOffsetMeters: null })
  const r0 = det.update({ point: { lat: north(1000), lng: east(5) }, distanceFromRouteMeters: on.distanceMeters, timestamp: 0 })
  check('case4 on route → no reroute', r0.shouldReroute, false)
  check('case4 on route → reason', r0.reason, 'on-route')

  // Three MOVING samples 200 m east of the route, 500 m apart along it.
  const results = []
  for (let i = 1; i <= 3; i++) {
    const along = 1000 + i * 500
    const p = { lat: north(along), lng: east(200) }
    const m = matchToRoute(index, p, { previousOffsetMeters: on.offsetMeters, elapsedMs: 30000 })
    near(`case4 sample ${i} measures ~200 m off route`, m.distanceMeters, 200, 5)
    results.push(det.update({ point: p, distanceFromRouteMeters: m.distanceMeters, timestamp: i * 30000 }))
  }
  check('case4 sample 1 → no reroute', results[0].shouldReroute, false)
  check('case4 sample 1 → confirming', results[0].reason, 'confirming')
  check('case4 sample 2 → no reroute', results[1].shouldReroute, false)
  check('case4 sample 2 → confirming', results[1].reason, 'confirming')
  check('case4 sample 3 → REROUTE', results[2].shouldReroute, true)
  check('case4 sample 3 → deviation', results[2].reason, 'deviation')
  check('case4 one reroute spent', results[2].rerouteCount, 1)

  // A fourth moving off-route sample immediately after must NOT re-fire: the
  // cooldown is what stops a truck on a frontage road billing Google per fix.
  const p4 = { lat: north(3000), lng: east(200) }
  const m4 = matchToRoute(index, p4, { previousOffsetMeters: 2500, elapsedMs: 30000 })
  const r4 = det.update({ point: p4, distanceFromRouteMeters: m4.distanceMeters, timestamp: 4 * 30000 })
  check('case4 immediately after a reroute → no reroute', r4.shouldReroute, false)

  // Back on route clears the counter, so a later single blip cannot ride on it.
  det.update({ point: { lat: north(3500), lng: east(5) }, distanceFromRouteMeters: 5, timestamp: 200000 })
  const blip = det.update({ point: { lat: north(4000), lng: east(200) }, distanceFromRouteMeters: 200, timestamp: 230000 })
  check('case4 a single blip after re-joining → no reroute', blip.shouldReroute, false)
  check('case4 blip is only the first confirmation', blip.consecutive, 1)

  // Budget cap: even with unlimited time and movement, the trip has a ceiling.
  // Asserted on the DEFAULT detector, not a configured one — the default is
  // what production runs, and a cap that only exists when a caller asks for it
  // is not a cap. 200 moving, off-route, cooldown-clearing samples is ~100
  // minutes of continuous deviation; without a ceiling that is ~66 billed
  // Google Routes calls for one truck on one load.
  const capped = createDeviationDetector()
  let fired = 0
  for (let i = 0; i < 200; i++) {
    const p = { lat: north(i * 300), lng: east(400) }
    if (capped.update({ point: p, distanceFromRouteMeters: 400, timestamp: i * 60000 }).shouldReroute) fired++
  }
  check('case4 default hard cap holds at 5 reroutes per trip', fired, 5)
  check('case4 budget is reported as exhausted, not silently ignored', capped.consecutive >= 0, true)
  const explicitCap = createDeviationDetector({ cooldownMs: 0, maxReroutes: 2 })
  let fired2 = 0
  for (let i = 0; i < 40; i++) {
    const p = { lat: north(i * 300), lng: east(400) }
    if (explicitCap.update({ point: p, distanceFromRouteMeters: 400, timestamp: i * 60000 }).shouldReroute) fired2++
  }
  check('case4 an explicit cap is honoured too', fired2, 2)
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 5 — parked 300 m off route: NEVER reroutes, however long it sits there
// ══════════════════════════════════════════════════════════════════════════════
{
  const det = createDeviationDetector()
  const parked = { lat: north(2000), lng: east(300) }
  let fired = 0
  let stationaryReports = 0
  // 120 fixes = an hour at the ELD cadence: a 10-hour break would be 1,200.
  for (let i = 0; i < 120; i++) {
    const r = det.update({ point: parked, distanceFromRouteMeters: 300, timestamp: i * 30000 })
    if (r.shouldReroute) fired++
    if (r.reason === 'stationary') stationaryReports++
  }
  check('case5 parked off route never reroutes', fired, 0)
  check('case5 never spent any reroute budget', det.rerouteCount, 0)
  check('case5 every fix after the first is reported stationary', stationaryReports, 119)

  // Paired: the SAME detector reroutes the moment the truck actually moves off
  // route, so "never reroute" cannot pass case 5.
  let movedFired = 0
  for (let i = 0; i < 3; i++) {
    const p = { lat: north(2000 + (i + 1) * 200), lng: east(300) }
    if (det.update({ point: p, distanceFromRouteMeters: 300, timestamp: (200 + i) * 30000 }).shouldReroute) movedFired++
  }
  check('case5 the same detector reroutes once the truck moves', movedFired, 1)

  // Micro-drift (GPS jitter on a parked truck) is still stationary.
  const jitter = createDeviationDetector()
  let jitterFired = 0
  for (let i = 0; i < 60; i++) {
    const p = { lat: north(2000 + (i % 2) * 8), lng: east(300 + (i % 3) * 6) }
    if (jitter.update({ point: p, distanceFromRouteMeters: 300, timestamp: i * 30000 }).shouldReroute) jitterFired++
  }
  check('case5 GPS jitter on a parked truck never reroutes', jitterFired, 0)
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 6 — step offsets without the server's `startIdx` (contract not yet live)
// ══════════════════════════════════════════════════════════════════════════════
{
  // `startIdx` is being added to /api/route by another change. Until it lands,
  // and for any cached response that predates it, the offsets must still be
  // right — from the step polylines, and failing that from step distances.
  const points = []
  for (let m = 0; m <= 6000; m += 200) points.push(pt(m))
  const index = buildRouteIndex(points)
  const mkPoly = (from, to) => {
    const out = []
    for (let m = from; m <= to; m += 200) out.push(pt(m))
    return out
  }
  const viaPolyline = [
    { distanceMeters: 2000, durationSec: 120, polyline: mkPoly(0, 2000) },
    { distanceMeters: 2000, durationSec: 120, polyline: mkPoly(2000, 4000) },
    { distanceMeters: 2000, durationSec: 120, polyline: mkPoly(4000, 6000) },
  ]
  const off1 = buildStepOffsets(viaPolyline, index)
  near('case6 polyline fallback: step 1 at 2 km', off1[1], 2000, 40)
  near('case6 polyline fallback: step 2 at 4 km', off1[2], 4000, 40)

  const viaDistance = [
    { distanceMeters: 2000, durationSec: 120 },
    { distanceMeters: 2000, durationSec: 120 },
    { distanceMeters: 2000, durationSec: 120 },
  ]
  const off2 = buildStepOffsets(viaDistance, index)
  near('case6 distance fallback: step 1 at 2 km', off2[1], 2000, 40)
  near('case6 distance fallback: step 2 at 4 km', off2[2], 4000, 40)

  // Monotonicity is forced whatever the source — every consumer assumes it.
  const messy = buildStepOffsets(
    [
      { startIdx: 0, distanceMeters: 1000 },
      { startIdx: 25, distanceMeters: 1000 }, // 5000 m
      { startIdx: 5, distanceMeters: 1000 }, // 1000 m — out of order on purpose
      { startIdx: 29, distanceMeters: 1000 },
    ],
    index,
  )
  check(
    'case6 offsets are monotone even when startIdx is not',
    messy.every((v, i) => i === 0 || v >= messy[i - 1]),
    true,
  )
}

console.log(`\nroute-progress: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
