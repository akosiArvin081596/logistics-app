#!/usr/bin/env node
// Deterministic check on the fuel RESERVE pair in client/src/lib/fuelReview.js —
// the "how far before I run out, and how far before I must stop" readout.
//
// WHY THIS EXISTS. The client asked for "a line that clearly states how much gas
// until they run out with a 15 mile buffer" and reported not seeing it. He was
// right: the buffer existed server-side (FUEL_RESERVE_MILES=15, his own decision
// after a truck ran dry on 2026-08-17) but reached the screen in exactly ONE
// string in the whole client — "incl. 15 reserve", inside the trip-verdict block,
// which only renders once a routed load is selected. GET /api/fuel/range carried
// no reserve at all, so the always-on readout could not show one.
//
// This file locks the three ways the new pair can go quietly wrong. Each is
// paired with the shape that must NOT produce a figure, because a test that only
// proved "173 minus 15 is 158" would pass on an implementation that printed
// "0 mi" at every one of the failure modes below.
//
//   1. NULL IS NOT ZERO. When the interval is unknown there is no honest number.
//      A 0 renders as "0 mi to dry", which reads as an EMPTY TANK — the precise
//      confusion the fuel work already had to fix twice (docs/claude/fuel.md).
//      usable must stay null, and hasReserve must stay false.
//
//   2. ZERO IS AN INSTRUCTION, NOT A MEASUREMENT. usable === 0 means "stop now",
//      and the truck still has the reserve underneath it. It must be
//      distinguishable from null, hence mustRefuelNow as its own flag.
//
//   3. THE TWO ENDPOINTS MUST AGREE. /api/fuel/range flattens the pair;
//      /api/fuel/trip-plan splits it between the plan root (reserveMiles,
//      refuelWithinMiles) and a nested `range`. Same truck, same fuel, two
//      layouts — if they normalize differently, /tracking and the driver's phone
//      quote different numbers and the next phone call between them starts with
//      an argument about which is right.
//
// Also pinned: an OLDER SERVER that sends no reserve at all must degrade to the
// original "mi to plan on" readout rather than inventing a buffer of 0.
//
// §7-§9: the driver gallons flag (DRIVER_FUEL_GALLONS_ENABLED). With it on, both
// fuel answers carry a `driverFuel` block and the driver sees only its figures,
// in plain words, with no working: no reserve, no MPG, no fuel %.
//   §7 client/src/lib/driverFuelView.js: each state's exact sentence; numbers only
//      as sent; no working words; the 400 codes; the chip and the badge
//   §8 DriverFuelPanel.vue rendered (Vue's server renderer, made-up answers):
//      flag off is today's panel; flag on shows each status (enough, add, refill
//      on the way, check gauge, no truck, load done, the reasons); a flag-on
//      plan older than 15 minutes is asked for again when the section opens,
//      the stops are not, and a flag-off one never is
//   §9 LoadDetail.vue's Fuel badge and Route Options; RouteAlternatives.vue
// The blocks come from the server's own planDriverFuel() (lib/fuel-model.js).
// FUEL_PANEL_BASE_VUE=<a base copy of DriverFuelPanel.vue> also renders every
// flag-off world with it and requires the same HTML (comments aside).
//
// No network, no sheet, no database, no DOM: §1-§7 are pure input/output, §8-§9
// compile the components with the client's own compiler. Safe anywhere.
//
//   node scripts/test-fuel-reserve-line.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const MODULE_PATH = path.join(ROOT, 'client', 'src', 'lib', 'fuelReview.js')

let pass = 0
let fail = 0

function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`)
  }
}

const { rangeReadout, planRangeReadout } = await import(pathToFileURL(MODULE_PATH).href)

// The reserve the client chose. Hardcoded here on purpose: if someone changes
// the default, this file should make them look at the cases below rather than
// silently re-deriving whatever the new number is.
const RESERVE = 15

// ---------------------------------------------------------------------------
// 1. The ordinary case — a measured basis with a spread.
//    Figures are Logisx-#91's real shape at 42% on a measured basis.
// ---------------------------------------------------------------------------
const live = rangeReadout({
  rangeBasis: 'measured',
  rangePlanningMiles: 173, rangeTypicalMiles: 190, rangeHighMiles: 210,
  rangeLowMiles: 173, milesPerFuelPoint: 4.1,
  reserveMiles: RESERVE, rangeUsableMiles: 158,
})
check('measured: usable is the headline figure', live.usable, 158)
check('measured: planning is still distance-to-dry', live.planning, 173)
check('measured: reserve is carried through', live.reserve, RESERVE)
check('measured: hasReserve gates the new line on', live.hasReserve, true)
check('measured: not a refuel-now situation', live.mustRefuelNow, false)
check('measured: the spread is untouched by any of this', live.hasSpread, true)
check('measured: usable is exactly planning minus reserve', live.planning - live.reserve, live.usable)

// ---------------------------------------------------------------------------
// 2. NULL IS NOT ZERO — the unknown basis.
// ---------------------------------------------------------------------------
const unknown = rangeReadout({
  rangeBasis: 'unknown',
  rangePlanningMiles: null, rangeTypicalMiles: null, rangeHighMiles: null,
  reserveMiles: RESERVE, rangeUsableMiles: null,
})
check('unknown basis: planning stays null', unknown.planning, null)
check('unknown basis: usable stays null, NOT 0', unknown.usable, null)
check('unknown basis: known is false', unknown.known, false)
check('unknown basis: hasReserve is false, so no line renders', unknown.hasReserve, false)
check('unknown basis: mustRefuelNow is false — we are not claiming a dry tank',
  unknown.mustRefuelNow, false)

// A server that somehow sends a usable figure with NO planning figure must not
// be believed: without a distance-to-dry there is nothing to subtract from.
const contradictory = rangeReadout({
  rangeBasis: 'unknown', rangePlanningMiles: null,
  reserveMiles: RESERVE, rangeUsableMiles: 158,
})
check('usable without planning is discarded, not rendered', contradictory.usable, null)
check('usable without planning does not switch the line on', contradictory.hasReserve, false)

// ---------------------------------------------------------------------------
// 3. ZERO IS AN INSTRUCTION.
// ---------------------------------------------------------------------------
const dry = rangeReadout({
  rangeBasis: 'measured', rangePlanningMiles: 12, rangeTypicalMiles: 30, rangeHighMiles: 44,
  reserveMiles: RESERVE, rangeUsableMiles: 0,
})
check('into the reserve: usable is 0', dry.usable, 0)
check('into the reserve: mustRefuelNow is set', dry.mustRefuelNow, true)
check('into the reserve: the line still renders', dry.hasReserve, true)
check('into the reserve: 0 is NOT null — the reading is real', dry.usable === null, false)
check('into the reserve: distance-to-dry is still reported', dry.planning, 12)

// The server floors at 0; a negative must never reach a screen even if one did.
const negative = rangeReadout({
  rangeBasis: 'measured', rangePlanningMiles: 5,
  reserveMiles: RESERVE, rangeUsableMiles: -10,
})
check('a negative usable is still flagged as refuel-now, not printed',
  negative.mustRefuelNow || negative.usable < 0, true)

// ---------------------------------------------------------------------------
// 4. THE TWO ENDPOINTS MUST AGREE.
// ---------------------------------------------------------------------------
const fromRange = rangeReadout({
  rangeBasis: 'measured',
  rangePlanningMiles: 173, rangeTypicalMiles: 190, rangeHighMiles: 210,
  reserveMiles: RESERVE, rangeUsableMiles: 158,
})
const fromPlan = planRangeReadout({
  routeMiles: 240, reserveMiles: RESERVE, requiredMiles: 255,
  refuelWithinMiles: 158,
  range: { low: 173, typical: 190, high: 210, planning: 173, basis: 'measured', milesPerPoint: 4.1 },
})
check('parity: same usable figure from both payloads', fromPlan.usable, fromRange.usable)
check('parity: same reserve from both payloads', fromPlan.reserve, fromRange.reserve)
check('parity: same distance-to-dry from both payloads', fromPlan.planning, fromRange.planning)
check('parity: both agree the line should render', fromPlan.hasReserve, fromRange.hasReserve)

// The plan payload nests its interval, so a regression that read `p.planning`
// instead of `p.range.planning` would silently blank the whole readout.
check('trip-plan: the nested interval is actually read', fromPlan.known, true)

// ---------------------------------------------------------------------------
// 5. AN OLDER SERVER degrades to the original readout.
// ---------------------------------------------------------------------------
const legacy = rangeReadout({
  rangeBasis: 'measured',
  rangePlanningMiles: 173, rangeTypicalMiles: 190, rangeHighMiles: 210,
})
check('old server: planning still renders', legacy.planning, 173)
check('old server: no reserve is invented', legacy.reserve, null)
check('old server: usable is null, not 0', legacy.usable, null)
check('old server: the new line stays off', legacy.hasReserve, false)
check('old server: mustRefuelNow is not asserted', legacy.mustRefuelNow, false)

const legacyPlan = planRangeReadout({
  range: { planning: 173, typical: 190, high: 210, basis: 'measured' },
})
check('old server (trip-plan): the new line stays off', legacyPlan.hasReserve, false)

// ---------------------------------------------------------------------------
// 6. Junk in must not throw or produce a confident figure.
// ---------------------------------------------------------------------------
check('null payload does not throw', rangeReadout(null).hasReserve, false)
check('undefined payload does not throw', rangeReadout(undefined).known, false)
check('empty plan does not throw', planRangeReadout({}).hasReserve, false)
const junk = rangeReadout({
  rangeBasis: 'measured', rangePlanningMiles: 173,
  reserveMiles: 'fifteen', rangeUsableMiles: 'lots',
})
check('non-numeric reserve is discarded', junk.reserve, null)
check('non-numeric usable is discarded', junk.usable, null)
check('non-numeric pair leaves the line off', junk.hasReserve, false)

// ===========================================================================
// §7-§9 the driver gallons flag. Made-up truck "Unit 901", load "QA-FUEL-1".
// ===========================================================================
const VIEW_LIB = path.join(ROOT, 'client/src/lib/driverFuelView.js')
const PANEL_VUE = path.join(ROOT, 'client/src/components/driver/DriverFuelPanel.vue')
const DETAIL_VUE = path.join(ROOT, 'client/src/components/driver/LoadDetail.vue')
const ALTS_VUE = path.join(ROOT, 'client/src/components/driver/RouteAlternatives.vue')
const DRIVER_DIR = path.dirname(PANEL_VUE)
const fuel = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'fuel-model.js'))

// One made-up world: both answers as the server sends them, the blocks built by
// the server's own planDriverFuel(). Defaults: the plan's worked example (48%, 40
// measured legs at p10 5.0 mi a point, 6.0 MPG, 140 mi to pickup, 420 mi in all).
const R15 = { minMiles: 15, fraction: 0 }
const BURN5 = { usable: true, p10: 5.0, p50: 7.4, p90: 10.2, n: 40, miles: 9000, points: 1216, milesPerPoint: 7.4 }
const NO_BURN = { usable: false, p10: null, p50: null, p90: null, milesPerPoint: null }
const MIN = 60000
function world(o = {}) {
  const s = {
    flag: true, pct: 48, fuelSource: 'live', readAge: 12, burn: BURN5, tank: 150, tankSource: 'truck', mpg: 6.0,
    routeMiles: 420, leg: 'to_pickup', approach: 140, hasTruck: true, hasDevice: true, fromLivePosition: true,
    positionAgeMinutes: 12, loadDone: false, extraStops: false, afterAnotherLoad: false, routeSource: 'routes_api',
    pickupUnmapped: false, anchor: null, milesSince: 0, pickedUp: false, ...o,
  }
  const sensor = s.hasTruck && s.hasDevice
  // A carried reading: `pct` is the level decayed at the MPG on file, as the server
  // sends it; `anchor` and `milesSince` let the block decay it at the planning rate.
  const reading = !sensor || s.fuelSource === 'none' ? { fuelPct: null, fuelSource: 'none', anchorPct: null, ageMinutes: null, milesSinceReading: null }
    : s.fuelSource === 'stale' ? { fuelPct: null, fuelSource: 'stale', anchorPct: s.pct, ageMinutes: s.readAge, milesSinceReading: null }
      : { fuelPct: s.pct, fuelSource: s.fuelSource, anchorPct: s.anchor == null ? s.pct : s.anchor, ageMinutes: s.readAge, milesSinceReading: s.milesSince }
  const pct = reading.fuelPct
  const rangeMiles = pct == null ? null : fuel.computeRange({ fuelPct: pct, tankGallons: s.tank, mpg: s.mpg }).rangeMiles
  const trip = fuel.planTripFuel({ routeMiles: s.routeMiles, fuelPct: pct, burn: s.burn, rangeMiles, mpg: s.mpg, reserve: R15 })
  const common = { reading, hasTruck: s.hasTruck, hasDevice: sensor, tankSource: s.tankSource, tankGallons: s.tank, mpg: s.mpg, burn: s.burn, reserve: R15 }
  const approach = s.leg === 'to_pickup' ? s.approach : 0
  const planBlock = fuel.planDriverFuel({
    ...common, plan: trip, leg: s.leg, approachMiles: approach,
    fromLivePosition: s.fromLivePosition, positionAgeMinutes: s.fromLivePosition ? s.positionAgeMinutes : null,
    routeSource: s.routeSource, extraStops: s.extraStops, afterAnotherLoad: s.afterAnotherLoad, loadDone: s.loadDone,
    pickupUnmapped: s.pickupUnmapped,
    // As the server sends it: not picked up, and no fresh truck position.
    approachUncounted: !s.pickedUp && !s.fromLivePosition,
  })
  const rangeBlock = fuel.planDriverFuel(common)
  const iv = fuel.rangeInterval({ fuelPct: pct, burn: s.burn, rangeMiles })
  const updatedAt = new Date(Date.now() - 12 * MIN).toISOString()
  const range = {
    ok: true, driver: null, unit: '901', hasFuelData: pct != null, fuelPct: pct,
    gallonsRemaining: pct == null ? null : Math.round(pct * s.tank) / 100, tankGallons: s.tank, tankSource: s.tankSource,
    mpg: s.mpg, mpgSource: 'receipts', rangeMiles,
    rangeLowMiles: iv.low, rangeTypicalMiles: iv.typical, rangeHighMiles: iv.high, rangePlanningMiles: iv.planning,
    rangeBasis: iv.basis, milesPerFuelPoint: iv.milesPerPoint, reserveMiles: 15,
    rangeUsableMiles: iv.planning == null ? null : Math.max(0, Math.round(iv.planning - 15)),
    fuelSource: reading.fuelSource, fuelAnchorPct: reading.anchorPct, fuelReadingAgeMinutes: reading.ageMinutes,
    milesSinceFuelReading: reading.milesSinceReading,
    rangeEvidence: s.burn.usable ? { legs: s.burn.n, miles: s.burn.miles, milesPerPointP10: s.burn.p10, milesPerPointP90: s.burn.p90 } : null,
    updatedAt, ...(s.flag ? { driverFuel: rangeBlock } : {}),
  }
  const plan = {
    ok: true, unit: '901', leg: s.leg, approachMiles: approach, laneMiles: s.routeMiles - approach,
    loadStatus: s.loadDone ? 'Cancelled' : 'Assigned', fuelPct: pct, fuelSource: reading.fuelSource, fuelAnchorPct: reading.anchorPct,
    fuelReadingAgeMinutes: reading.ageMinutes, milesSinceFuelReading: reading.milesSinceReading, mpg: s.mpg, mpgSource: 'receipts',
    ...trip, pointEstimateMiles: rangeMiles, fuelStopsRecommended: trip.verdict === 'tight' || trip.verdict === 'insufficient',
    updatedAt, ...(s.flag ? { driverFuel: planBlock } : {}),
  }
  return { range, plan, planBlock, rangeBlock }
}
const STOPS = {
  stops: [
    { placeId: 'qa-stop-1', name: 'QA Truck Plaza Riverton', brand: 'QA Fuel', address: '100 Example Rd, Riverton', lat: 35.05, lng: -89.98,
      aboutMilesFromRoute: 0.4, truckFriendly: true, priceSource: 'station', effectivePrice: 3.899, dieselType: 'TRUCK_DIESEL', leg: 'to_pickup' },
    { placeId: 'qa-stop-2', name: 'QA Travel Center Lakeside', address: '200 Sample Ave, Lakeside', lat: 32.78, lng: -96.8, aboutMilesFromRoute: 1.2, truckFriendly: true },
  ],
  livePriceCount: 1,
}
// Words that are working, not an answer: none may reach the driver with the flag on.
const WORKING_RE = /minus|reserve|mpg|miles per gallon|%|until the tank is empty|how we know/i

// ---------------------------------------------------------------------------
console.log('§7 client/src/lib/driverFuelView.js')
// ---------------------------------------------------------------------------
const v = fs.existsSync(VIEW_LIB) ? await import(pathToFileURL(VIEW_LIB).href) : null
check('§7 client/src/lib/driverFuelView.js exists', !!v, true)
if (v) {
  const view = (o = {}, planProblem = null) => v.driverFuelView(world(o).planBlock, { planProblem })
  const topOf = (o) => { const t = view(o).top; return [t.kind, t.headline, t.sub, t.notes, t.readAgo] }
  check('§7 live: the miles until the tank runs out, and when the fuel level was read',
    topOf({}), ['miles', '225', 'miles until you run out', [], 'Fuel level read 12 min ago'])
  check('§7 a sensor dropout: the number, said to be an estimate',
    topOf({ fuelSource: 'carried' }), ['miles', '225', 'miles until you run out', ["Your fuel sensor isn't reporting. This is an estimate."], 'Fuel level read 12 min ago'])
  check('§7 0 miles left: "Refuel now", never "0"',
    topOf({ pct: 3, routeMiles: 180, leg: 'to_delivery' }), ['now', 'Refuel now', 'Stop for fuel as soon as you can.', [], 'Fuel level read 12 min ago'])
  check('§7 no ELD fuel reading: no number, the reason',
    topOf({ hasDevice: false, fromLivePosition: false }), ['unknown', 'Fuel level unknown', "Your truck isn't sending a fuel level. Check your gauge.", [], ''])
  check('§7 ELD silent 18 hrs: no number, how long',
    topOf({ fuelSource: 'stale', readAge: 18 * 60 }), ['unknown', 'Fuel level unknown', 'No fuel reading for 18 hrs. Check your gauge.', [], ''])
  check('§7 no tank size and no measured history: no miles',
    topOf({ burn: NO_BURN, tankSource: 'default', tank: 200 }),
    ['unknown', 'Miles left unknown', "This truck's tank size isn't on file. Check your gauge and ask dispatch to add it.", [], ''])
  check('§7 no truck linked: the reason',
    topOf({ hasTruck: false, fromLivePosition: false }), ['unknown', 'Fuel level unknown', 'No truck is linked to your account. Ask dispatch.', [], ''])

  const rowsOf = (o, p) => view(o, p).rows.map((r) => [r.label, r.miles, r.tone, r.line])
  check('§7 before pickup: enough to reach the pickup, add to finish',
    rowsOf({}), [
      ['To reach pickup', '140 mi', 'ok', 'Uses about 30 gal. You have enough.'],
      ['To finish this load', '420 mi', 'bad', 'Add about 65 gal.'],
    ])
  // An add row says only what to pump. "Uses about 80 gal" beside it invited a driver
  // with ~105 gal on his gauge to skip the top-up (the re-check's Low 5).
  {
    const addLines = [{}, { pct: 3, routeMiles: 180, leg: 'to_delivery' }, { pct: 20, leg: 'to_delivery', routeMiles: 300 }, { pct: 30, leg: 'to_delivery', routeMiles: 250 }]
      .flatMap((o) => view(o).rows).filter((r) => r.tone === 'bad' && /^Add about|Uses about .*Add about/.test(r.line)).map((r) => r.line)
    check('§7 an add row says only "Add about N gal.": no "Uses about" beside it',
      [addLines.length >= 4, addLines.filter((l) => /Uses about/.test(l)), addLines.every((l) => /^Add about [\d,]+ gal\.$/.test(l))], [true, [], true])
  }
  check('§7 in transit, enough', rowsOf({ leg: 'to_delivery', routeMiles: 180 }), [['To finish this load', '180 mi', 'ok', 'Uses about 35 gal. You have enough.']])
  check('§7 more than a full tank: refill on the way',
    rowsOf({ leg: 'to_delivery', routeMiles: 1040 }), [['To finish this load', '1,040 mi', 'bad', 'Uses about 195 gal. Fill up full, and plan another fuel stop on the way.']])
  check('§7 check your gauge: what the tank needs, per row',
    rowsOf({ burn: NO_BURN, tankSource: 'default', tank: 200 }), [
      ['To reach pickup', '140 mi', 'unknown', 'You need about 55 gal in the tank to reach pickup. Check your gauge.'],
      ['To finish this load', '420 mi', 'unknown', 'You need about 145 gal in the tank to finish. Check your gauge.'],
    ])
  check('§7 no truck: one whole-load row, no number (the run to the pickup can\'t be counted)',
    rowsOf({ hasTruck: false, fromLivePosition: false, leg: 'to_delivery', routeMiles: 280, tank: 200, tankSource: 'default', mpg: 6.5 }),
    [['Whole load, pickup to delivery', '', 'unknown', 'Check your gauge.']])
  check('§7 …after pickup with no position the whole load over-counts, so the row keeps its need figure',
    rowsOf({ hasDevice: false, fromLivePosition: false, pickedUp: true, leg: 'to_delivery', routeMiles: 280 }),
    [['Whole load, pickup to delivery', '280 mi', 'unknown', 'You need about 100 gal in the tank for the whole load. Check your gauge.']])
  check('§7 a load that is over: the top only', [view({ loadDone: true }).rows, view({ loadDone: true }).footers], [[], []])
  check('§7 extra stops: the pickup row is the first pickup', rowsOf({ extraStops: true })[0][0], 'To reach first pickup')

  const footOf = (o) => view(o).footers
  check('§7 position 3 hrs old', footOf({ positionAgeMinutes: 180 }), ['Worked out from where your truck was 3 hrs ago.'])
  check('§7 no position before pickup: one row, and why (the run to the pickup can\'t be counted)',
    footOf({ fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }), ["The truck's location isn't known, so the run to the pickup can't be counted."])
  check('§7 …a driver with no truck gets the reason too', footOf({ hasTruck: false, fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }),
    ["The truck's location isn't known, so the run to the pickup can't be counted."])
  check('§7 …after pickup with no position: the old line', footOf({ fromLivePosition: false, pickedUp: true, leg: 'to_delivery', routeMiles: 280 }),
    ["Your truck hasn't sent its location recently."])
  check('§7 estimated distance, extra stops, another load first',
    footOf({ routeSource: 'straight_line_estimate', extraStops: true, afterAnotherLoad: true }), [
      'Distance is estimated.',
      "This load has extra stops that aren't counted. You may need more fuel.",
      'You have another load before this one. These numbers start from where your truck is now.',
    ])
  // (b) A row the block can't count shows only "Check your gauge.", no gallons and no
  // miles, and its reason is on the same screen (a footer, or the top's own line).
  const NO_POSITION_LINE = "The truck's location isn't known, so the run to the pickup can't be counted."
  const INCOMPLETE = [
    ['unmapped pickup', { pickupUnmapped: true, leg: 'to_delivery', routeMiles: 300, pct: 70 }, "The pickup isn't on the map, so the run to it isn't counted."],
    ['sensor dropout (carried)', { fuelSource: 'carried', pct: 46, anchor: 50, milesSince: 20 }, "Your fuel sensor isn't reporting. This is an estimate."],
    ['another load first', { afterAnotherLoad: true }, 'You have another load before this one. These numbers start from where your truck is now.'],
    ['extra stops', { extraStops: true }, "This load has extra stops that aren't counted. You may need more fuel."],
    ['stale reading', { fuelSource: 'stale', readAge: 18 * 60 }, 'No fuel reading for 18 hrs. Check your gauge.'],
    ['estimated distance', { routeSource: 'straight_line_estimate' }, 'Distance is estimated.'],
    // Before pickup with no truck position (Arvin's option (a)); the re-linked device
    // reaches the block in the same shape as the silent one (no reading, no fix).
    ['no position before pickup: no ELD device', { hasDevice: false, fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, NO_POSITION_LINE],
    ['no position before pickup: no fuel level, ELD silent', { fuelSource: 'none', fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, NO_POSITION_LINE],
    ['no position before pickup: a re-linked device', { fuelSource: 'none', fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, NO_POSITION_LINE],
    ['no position before pickup: no truck linked', { hasTruck: false, fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, NO_POSITION_LINE],
    ['no position before pickup: the 6 h edge (a fresh 80% reading)', { pct: 80, fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, NO_POSITION_LINE],
  ]
  for (const [label, o, reason] of INCOMPLETE) {
    const vw = view(o)
    const lines = [vw.top.sub, ...vw.top.notes, ...vw.footers]
    check(`§7 (b) ${label}: every row is only "Check your gauge." (no gallons, no miles), and its reason is on screen`,
      [vw.rows.length > 0, vw.rows.every((r) => r.line === 'Check your gauge.' && r.miles === '' && r.tone === 'unknown'),
        vw.rows.some((r) => /\d/.test(`${r.line} ${r.miles}`)), lines.includes(reason)],
      [true, true, false, true])
  }
  check('§7 (b) …the control, with no reason: rows carry their miles and gallons, and there is no footer',
    [view({}).rows.map((r) => [r.miles, r.line]), view({}).footers],
    [[['140 mi', 'Uses about 30 gal. You have enough.'], ['420 mi', 'Add about 65 gal.']], []])

  // (a) One source: every distance and colour the flag-on screen shows is the block's.
  {
    const W1 = { fuelSource: 'carried', pct: 66.7, anchor: 100, milesSince: 300, leg: 'to_delivery', routeMiles: 450 }
    const W8 = { burn: NO_BURN, mpg: 16, pct: 50, leg: 'to_delivery', routeMiles: 700 }
    const stopsOf = (o) => v.driverFuelStops && v.driverFuelStops(world(o).planBlock)
    check('§7 (a) the stops lead quotes the block: W1 dropout "Fuel up within 185 mi." (the verdict alone said 319)',
      [stopsOf(W1), world(W1).plan.refuelWithinMiles], [{ required: true, lead: 'Fuel up within 185 mi.' }, 319])
    check('§7 (a) …W8, an MPG of 16 on file read as 11: "Fuel up within 443 mi." (the verdict alone said 652)',
      [stopsOf(W8), world(W8).plan.refuelWithinMiles], [{ required: true, lead: 'Fuel up within 443 mi.' }, 652])
    check('§7 (a) …add to finish: within the miles left; refuel now: now; enough: no lead',
      [stopsOf({}), stopsOf({ pct: 3, routeMiles: 180, leg: 'to_delivery' }), stopsOf({ leg: 'to_delivery', routeMiles: 180 })],
      [{ required: true, lead: 'Fuel up within 225 mi.' }, { required: true, lead: 'Fuel up now — before you start this run.' }, { required: false, lead: '' }])
    const toneOf = (o) => v.driverFuelTone && v.driverFuelTone(world(o).planBlock)
    check('§7 (a) the top colour is the block\'s: add red, enough green, a row it can\'t count amber, refuel now red, no figure grey',
      [toneOf({}), toneOf({ leg: 'to_delivery', routeMiles: 180 }), toneOf({ pickupUnmapped: true, leg: 'to_delivery', routeMiles: 300, pct: 70 }),
        toneOf({ pct: 3, routeMiles: 180, leg: 'to_delivery' }), toneOf({ fuelSource: 'stale', readAge: 18 * 60 })],
      ['bad', 'ok', 'warn', 'bad', 'unknown'])
    check('§7 (a) …the unmapped pickup is amber though its verdict clears (the verdict alone would paint it green)',
      world({ pickupUnmapped: true, leg: 'to_delivery', routeMiles: 300, pct: 70 }).plan.verdict, 'clears')
    const chipOf = (o) => v.driverFuelChip(world(o).rangeBlock)
    check('§7 (a) the chip\'s colour is the block\'s miles left (under 50 red, under 150 amber), with its figure',
      [chipOf({}), chipOf({ pct: 30 }), chipOf({ pct: 12 })].map((c) => [c.text, c.tone]), [['225 mi', 'ok'], ['135 mi', 'warn'], ['45 mi', 'bad']])
  }

  const noteOf = (problem) => v.driverFuelView(world().rangeBlock, { planProblem: problem }).rowsNote
  check('§7 why there are no rows, per trip-plan failure',
    [{ status: 400, code: 'NO_ROUTE' }, { status: 400, code: 'NO_POSITION' }, { status: 400, code: '' }, { status: 429, code: '' },
      { status: 500, code: '' }, { status: 0, code: 'TIMEOUT' }, { status: 404, code: '' }, null].map(noteOf),
    [
      "This load isn't on the map yet, so we can't work out the fuel for it.",
      "Your truck hasn't sent its location recently, so we can't work out the fuel for this load yet.",
      "We can't work out the fuel for this load yet.",
      'Checked too many times just now. Try again in a few minutes.',
      "Couldn't load your fuel numbers. Tap Refresh.",
      "Couldn't load your fuel numbers. Tap Refresh.",
      '',
      '',
    ])
  check('§7 only the two flag-on 400 codes say the flag is on',
    [{ code: 'NO_ROUTE' }, { code: 'NO_POSITION' }, { code: 'TIMEOUT' }, { code: '' }, null].map(v.flagOnProblem), [true, true, false, false, false])
  check('§7 the block is read only as version 1 of an object',
    [{ driverFuel: world().rangeBlock }, { driverFuel: { ...world().rangeBlock, v: 2 } }, { driverFuel: 'x' }, {}, null].map((a) => !!v.driverFuelOf(a)),
    [true, false, false, false, false])
  check('§7 ages in words', [0, 1, 12, 59, 60, 90, 180, 18 * 60, 47 * 60, 72 * 60, null].map(v.ageWords),
    ['', '1 min', '12 min', '59 min', '1 hr', '2 hrs', '3 hrs', '18 hrs', '47 hrs', '3 days', ''])

  // Every number on screen is one the server sent (an age only re-said in hours).
  const SAMPLES = [{}, { leg: 'to_delivery', routeMiles: 180 }, { leg: 'to_delivery', routeMiles: 1040 }, { fuelSource: 'carried' },
    { pct: 3, routeMiles: 180, leg: 'to_delivery' }, { fuelSource: 'stale', readAge: 18 * 60 }, { burn: NO_BURN, tankSource: 'default', tank: 200 },
    { hasDevice: false, fromLivePosition: false }, { hasTruck: false, fromLivePosition: false }, { positionAgeMinutes: 180, extraStops: true, afterAnotherLoad: true, routeSource: 'straight_line_estimate' }]
  const strings = (vw) => [vw.top.headline, vw.top.sub, ...vw.top.notes, vw.top.readAgo, ...vw.rows.flatMap((r) => [r.label, r.miles, r.line]), vw.rowsNote, ...vw.footers]
  const strayNumbers = []
  const working = []
  for (const o of SAMPLES) {
    const b = world(o).planBlock
    const sent = new Set([b.milesLeft, ...b.legs.flatMap((l) => [l.miles, l.usesGallons, l.addGallons, l.needInTankGallons]),
      ...[b.fuelReadAgeMinutes, b.positionAgeMinutes].map((m) => v.ageWords(m).split(' ')[0])].filter((x) => x != null && x !== '').map(String))
    const text = strings(v.driverFuelView(b)).join(' | ')
    for (const n of text.match(/\d[\d,]*/g) || []) if (!sent.has(n.replace(/,/g, ''))) strayNumbers.push(`${n} in "${text}"`)
    if (WORKING_RE.test(text)) working.push(text)
    const chip = v.driverFuelChip(b)
    if (WORKING_RE.test(`${chip.text} ${chip.title}`)) working.push(chip.title)
  }
  check('§7 every number shown is one the server sent', strayNumbers, [])
  check('§7 no sentence, chip or tooltip says minus, reserve, MPG or %', working, [])

  check('§7 the chip: "225 mi", "Refuel now", "Fuel ?"',
    [{}, { pct: 3, routeMiles: 180, leg: 'to_delivery' }, { burn: NO_BURN, tankSource: 'default', tank: 200 }].map((o) => v.driverFuelChip(world(o).rangeBlock).text),
    ['225 mi', 'Refuel now', 'Fuel ?'])

  const badge = (o) => v.driverFuelBadge(world(o).plan)
  check('§7 the load badge: add to finish -> "Add 65 gal", red', badge({}), { tone: 'bad', text: 'Add 65 gal' })
  check('§7 …enough to finish: the section\'s own figure', badge({ leg: 'to_delivery', routeMiles: 180 }), { tone: 'plain', text: '225 mi range' })
  check('§7 …no figure: "Fuel unknown"', [badge({ fuelSource: 'stale', readAge: 18 * 60 }), badge({ burn: NO_BURN, tankSource: 'default', tank: 200 })],
    [{ tone: 'warn', text: 'Fuel unknown' }, { tone: 'warn', text: 'Fuel unknown' }])
  check('§7 …refill on the way: "Fuel stop needed" from the block\'s refill row (not from the verdict)',
    badge({ leg: 'to_delivery', routeMiles: 1040 }), { tone: 'bad', text: 'Fuel stop needed' })
  check('§7 …a row the block can\'t count: "Check gauge", amber (the unmapped pickup\'s verdict clears; the dropout\'s is tight)',
    [badge({ pickupUnmapped: true, leg: 'to_delivery', routeMiles: 300, pct: 70 }), badge({ fuelSource: 'carried', pct: 66.7, anchor: 100, milesSince: 300, leg: 'to_delivery', routeMiles: 450 })],
    [{ tone: 'warn', text: 'Check gauge' }, { tone: 'warn', text: 'Check gauge' }])
  check('§7 …a load that is over: no badge; no block (flag off): null, so LoadDetail keeps today\'s rule',
    [badge({ loadDone: true }), badge({ flag: false }), v.driverFuelBadge(null)], [null, null, null])
}

// ---------------------------------------------------------------------------
// The SFC harness: a component's own code, compiled with the client's compiler;
// its request layer answers made-up fixtures; Vant and child components are
// stand-ins that render their attributes and slots. Each factory() call is a
// fresh module scope (the panel keeps its caches at module level).
// ---------------------------------------------------------------------------
const clientRequire = createRequire(path.join(ROOT, 'client', 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const { renderToString } = clientRequire('vue/server-renderer')
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)) }
// Repeat until nothing changes: one pass can leave a comment opener behind (`<!<!---->--x-->`).
const clean = (html) => {
  let out = String(html)
  let prev
  do {
    prev = out
    out = out.replace(/<!--[\s\S]*?-->/g, '')
  } while (out !== prev)
  return out
}
check('the test helper strips a comment opener that one pass leaves behind', clean('a<!<!---->--x-->b'), 'ab')
const textOf = (html) => clean(html).replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

function stub(name) {
  return Vue.defineComponent({
    name,
    inheritAttrs: false,
    setup(_, { slots, attrs }) {
      const shown = {}
      for (const k of ['title', 'value', 'description']) if (attrs[k] != null) shown[`data-${k}`] = String(attrs[k])
      return () => Vue.h('div', { 'data-stub': name, ...shown }, Object.values(slots).map((fn) => fn()))
    },
  })
}
const net = { answers: {}, gets: [] }
function apiError(status, code = '') {
  const e = new Error(`Request failed (${status})`)
  e.status = status
  e.code = code
  e.data = code ? { code } : {}
  return e
}
const API_STUB = {
  useApi: () => ({
    get: async (url) => {
      net.gets.push(url.split('?')[0])
      const a = net.answers[url.split('?')[0]]
      if (a instanceof Error) throw a
      if (a === undefined) throw apiError(404)
      return JSON.parse(JSON.stringify(a))
    },
  }),
}
async function sfcFactory(file, { inline = true, vue = Vue } = {}) {
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), { filename: path.basename(file) })
  let body = compileScript(descriptor, { id: 'fuel-gallons', inlineTemplate: inline }).content
  const specs = []
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, names, q, spec) => {
    specs.push(spec)
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '))
    return `const { ${binds.join(', ')} } = __deps[${JSON.stringify(spec)}];`
  })
  body = body.replace(/^import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, name, q, spec) => {
    specs.push(spec)
    return `const ${name} = __deps[${JSON.stringify(spec)}].default;`
  })
  body = body.replace(/^export default\s*/m, 'return ')
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${path.basename(file)}: an import/export this harness cannot map`)
  const deps = { vue, vant: new Proxy({}, { get: (_, k) => stub(String(k)) }) }
  for (const spec of specs) {
    if (spec === 'vue' || spec === 'vant') continue
    if (spec === '../../composables/useApi') deps[spec] = API_STUB
    else if (spec.endsWith('.vue')) deps[spec] = { default: stub(path.basename(spec, '.vue')) }
    else if (spec.startsWith('.')) deps[spec] = await import(pathToFileURL(path.join(DRIVER_DIR, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
    else throw new Error(`${path.basename(file)} imports ${spec}, which this harness does not map`)
  }
  const build = new Function('__deps', body)
  return () => build(deps)
}

// Open the Fuel section: the first render asks (its own HTML is the spinners);
// once the answers are in, a reopen paints the cache synchronously.
async function openSection(Panel, props = {}) {
  const p = { loadId: 'QA-FUEL-1', active: true, runnable: true, ...props }
  await renderToString(Vue.createSSRApp(Panel, p))
  await settle()
  return clean(await renderToString(Vue.createSSRApp(Panel, p)))
}
function serve(w, over = {}) {
  net.answers = { '/api/fuel/range': w.range, '/api/fuel/trip-plan': w.plan, '/api/poi/fuel-stops': STOPS, ...over }
  net.gets = []
}
// The new block's text, from its section to the stops heading.
function blockText(html) {
  const from = html.indexOf('data-testid="driver-fuel"')
  const to = html.lastIndexOf('<', html.indexOf('class="dfp-section-title'))
  return from < 0 || to < from ? '' : textOf(`<x ${html.slice(from, to)}`)
}

// ---------------------------------------------------------------------------
console.log('§8 DriverFuelPanel.vue rendered')
// ---------------------------------------------------------------------------
let panelFactory = null
try { panelFactory = await sfcFactory(PANEL_VUE) } catch (e) { check(`§8 DriverFuelPanel.vue compiles in this harness (${e.message})`, false, true) }
if (panelFactory) {
  // §8a the flag off: no block anywhere, so today's panel, part for part.
  const OFF = {
    'before pickup, a stop needed': [world({ flag: false })],
    'in transit, clears': [world({ flag: false, leg: 'to_delivery', routeMiles: 180 })],
    'sensor dropout': [world({ flag: false, fuelSource: 'carried' })],
    'ELD silent': [world({ flag: false, fuelSource: 'stale', readAge: 18 * 60 })],
    'no ELD reading': [world({ flag: false, hasDevice: false, fromLivePosition: false })],
    'no tank size': [world({ flag: false, burn: NO_BURN, tankSource: 'default', tank: 200 })],
    'trip plan 400 (no code)': [world({ flag: false }), { '/api/fuel/trip-plan': apiError(400) }],
    'trip plan 500': [world({ flag: false }), { '/api/fuel/trip-plan': apiError(500) }],
    'range fails': [world({ flag: false }), { '/api/fuel/range': apiError(500) }],
    'delivered (not runnable)': [world({ flag: false }), {}, { runnable: false }],
  }
  const offHtml = {}
  for (const [name, [w, over, props]] of Object.entries(OFF)) {
    serve(w, over)
    offHtml[name] = await openSection(panelFactory(), props)
  }
  {
    const h = offHtml['before pickup, a stop needed']
    const t = textOf(h)
    check('§8a flag off: the verdict card, the hero and the working line exactly as today',
      [t.includes('Not enough fuel — you need to stop'), t.includes('225 miles before you need to refuel'),
        t.includes('That is 240 mi until the tank is empty, minus 15 mi kept back as a reserve.')], [true, true, true])
    check('§8a flag off: "How we know", the cells and the stamp',
      [t.includes('How we know'), h.includes('data-title="Fuel level"'), h.includes('data-title="Gallons left"'),
        h.includes('data-title="Miles per gallon"'), t.includes('Fuel level read 12 min ago')], [true, true, true, true, true])
    check('§8a flag off: the stops and Refresh', [t.includes('Where to fuel up'), t.includes('QA Truck Plaza Riverton'), t.includes('Refresh fuel, stops and check')], [true, true, true])
  }
  check('§8a flag off: the new block appears in no world',
    Object.entries(offHtml).filter(([, h]) => h.includes('data-testid="driver-fuel"') || textOf(h).includes('miles until you run out')).map(([n]) => n), [])
  check('§8a flag off: a failed trip plan reads as today', textOf(offHtml['trip plan 400 (no code)']).includes("We can't check this run yet — this load hasn't been mapped, or your truck hasn't reported its position."), true)
  serve(world({ flag: false }))
  await openSection(panelFactory())
  check('§8a flag off: opening asks range, stops and the trip plan once each, as today',
    [...net.gets].sort(), ['/api/fuel/range', '/api/fuel/trip-plan', '/api/poi/fuel-stops'])

  if (process.env.FUEL_PANEL_BASE_VUE) {
    const baseFactory = await sfcFactory(path.resolve(process.env.FUEL_PANEL_BASE_VUE))
    const differ = []
    for (const [name, [w, over, props]] of Object.entries(OFF)) {
      serve(w, over)
      if (await openSection(baseFactory(), props) !== offHtml[name]) differ.push(name)
    }
    check(`§8a flag off: the same HTML as the base copy in all ${Object.keys(OFF).length} worlds (comments aside)`, differ, [])
  } else {
    console.log('  (§8a byte-for-byte against a base copy: not run; set FUEL_PANEL_BASE_VUE)')
  }

  // §8b the flag on: only the block's plain figures, then the stops and Refresh.
  const on = async (o, over, props) => { serve(world(o), over); return openSection(panelFactory(), props) }
  const BEFORE = await on({})
  check('§8b before pickup: enough to reach the pickup, add to finish',
    blockText(BEFORE),
    '225 miles until you run out Fuel level read 12 min ago To reach pickup 140 mi Uses about 30 gal. You have enough. To finish this load 420 mi Add about 65 gal.')
  {
    const t = textOf(BEFORE)
    check('§8b …and none of today\'s panel: no verdict card, hero, working line, "How we know", cells or notes',
      [t.includes('Not enough fuel'), t.includes('before you need to refuel'), t.includes('kept back'), t.includes('How we know'),
        BEFORE.includes('data-title="Gallons left"'), BEFORE.includes('data-title="Miles per gallon"'), t.includes('fleet default')],
      [false, false, false, false, false, false, false])
    check('§8b …the stops and Refresh stay', [t.includes('QA Truck Plaza Riverton'), t.includes('Refresh fuel, stops and check')], [true, true])
  }
  check('§8b in transit, enough', blockText(await on({ leg: 'to_delivery', routeMiles: 180 })),
    '225 miles until you run out Fuel level read 12 min ago To finish this load 180 mi Uses about 35 gal. You have enough.')
  check('§8b refill on the way', blockText(await on({ leg: 'to_delivery', routeMiles: 1040 })),
    '225 miles until you run out Fuel level read 12 min ago To finish this load 1,040 mi Uses about 195 gal. Fill up full, and plan another fuel stop on the way.')
  check('§8b check gauge (ELD silent 18 hrs)', blockText(await on({ fuelSource: 'stale', readAge: 18 * 60, leg: 'to_delivery' })),
    'Fuel level unknown No fuel reading for 18 hrs. Check your gauge. To finish this load Check your gauge.')
  check('§8b check gauge (no ELD reading, no position)', blockText(await on({ hasDevice: false, fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 })),
    "Fuel level unknown Your truck isn't sending a fuel level. Check your gauge. Whole load, pickup to delivery Check your gauge. The truck's location isn't known, so the run to the pickup can't be counted.")
  check('§8b no tank size', blockText(await on({ burn: NO_BURN, tankSource: 'default', tank: 200 })),
    "Miles left unknown This truck's tank size isn't on file. Check your gauge and ask dispatch to add it. To reach pickup 140 mi You need about 55 gal in the tank to reach pickup. Check your gauge. To finish this load 420 mi You need about 145 gal in the tank to finish. Check your gauge.")
  check('§8b no truck', blockText(await on({ hasTruck: false, fromLivePosition: false, leg: 'to_delivery', routeMiles: 280, tank: 200, tankSource: 'default', mpg: 6.5 })),
    "Fuel level unknown No truck is linked to your account. Ask dispatch. Whole load, pickup to delivery Check your gauge. The truck's location isn't known, so the run to the pickup can't be counted.")
  {
    const delivered = await on({}, {}, { runnable: false })
    check('§8b load done (delivered, so no trip plan is asked): the top only',
      [blockText(delivered), net.gets.includes('/api/fuel/trip-plan')], ['225 miles until you run out Fuel level read 12 min ago', false])
    check('§8b load done (the plan says so): the top only', blockText(await on({ loadDone: true })), '225 miles until you run out Fuel level read 12 min ago')
  }
  check('§8b sensor dropout', blockText(await on({ fuelSource: 'carried', leg: 'to_delivery', routeMiles: 180 })),
    "225 miles until you run out Your fuel sensor isn't reporting. This is an estimate. Fuel level read 12 min ago To finish this load Check your gauge.")
  check('§8b refuel now', blockText(await on({ pct: 3, leg: 'to_delivery', routeMiles: 180 })),
    'Refuel now Stop for fuel as soon as you can. Fuel level read 12 min ago To finish this load 180 mi Add about 60 gal.')
  // Status and reason on one screen: the rows check the gauge with no number, and
  // the lines under them say why; neither shows without the other.
  check('§8b the reasons under the top, with the rows they explain (no number beside an uncounted-miles footer)',
    blockText(await on({ positionAgeMinutes: 180, extraStops: true, afterAnotherLoad: true, routeSource: 'straight_line_estimate' })),
    "225 miles until you run out Fuel level read 12 min ago To reach first pickup Check your gauge. To finish this load Check your gauge. Worked out from where your truck was 3 hrs ago. Distance is estimated. This load has extra stops that aren't counted. You may need more fuel. You have another load before this one. These numbers start from where your truck is now.")
  // (b) on screen, for each reason: every row is its label and "Check your gauge."
  // only (no miles cell, no gallons), and the reason line is on the same screen.
  const rowTexts = (html) => html.split('data-testid="driver-fuel-row"').slice(1).map((seg) => textOf(`<x ${seg.slice(0, seg.indexOf('</div>'))}`))
  const ROW_ONLY_GAUGE = /^(To reach (first )?pickup|To finish this load|Whole load, pickup to delivery) Check your gauge\.$/
  for (const [label, o, reason] of [
    ['unmapped pickup', { pickupUnmapped: true, leg: 'to_delivery', routeMiles: 300, pct: 70 }, "The pickup isn't on the map, so the run to it isn't counted."],
    ['sensor dropout (carried)', { fuelSource: 'carried', pct: 46, anchor: 50, milesSince: 20 }, "Your fuel sensor isn't reporting. This is an estimate."],
    ['another load first', { afterAnotherLoad: true }, 'You have another load before this one. These numbers start from where your truck is now.'],
    ['extra stops', { extraStops: true }, "This load has extra stops that aren't counted. You may need more fuel."],
    ['stale reading', { fuelSource: 'stale', readAge: 18 * 60 }, 'No fuel reading for 18 hrs. Check your gauge.'],
    ['estimated distance', { routeSource: 'straight_line_estimate' }, 'Distance is estimated.'],
    ['no position before pickup: no ELD device', { hasDevice: false, fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, "The truck's location isn't known, so the run to the pickup can't be counted."],
    ['no position before pickup: no fuel level, ELD silent', { fuelSource: 'none', fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, "The truck's location isn't known, so the run to the pickup can't be counted."],
    ['no position before pickup: a re-linked device', { fuelSource: 'none', fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, "The truck's location isn't known, so the run to the pickup can't be counted."],
    ['no position before pickup: no truck linked', { hasTruck: false, fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, "The truck's location isn't known, so the run to the pickup can't be counted."],
    ['no position before pickup: the 6 h edge (a fresh 80% reading)', { pct: 80, fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, "The truck's location isn't known, so the run to the pickup can't be counted."],
  ]) {
    const html = await on(o)
    const rows = rowTexts(html)
    check(`§8b (b) ${label} on screen: each row is its label and "Check your gauge." only, no miles cell, and the reason line`,
      [rows.length > 0, rows.every((r) => ROW_ONLY_GAUGE.test(r)), html.includes('class="dff-row-miles"'), textOf(html).includes(reason)],
      [true, true, false, true])
  }

  // (a) One source: collect every distance on the flag-on screen (the whole panel,
  // the stops section included; a stop's own "mi off route" is the stops answer's,
  // not a fuel figure) and require each to be one the block sent.
  {
    const W1 = { fuelSource: 'carried', pct: 66.7, anchor: 100, milesSince: 300, leg: 'to_delivery', routeMiles: 450 }
    const W8 = { burn: NO_BURN, mpg: 16, pct: 50, leg: 'to_delivery', routeMiles: 700 }
    const WORLDS = {
      'before pickup (add)': {}, 'in transit, enough': { leg: 'to_delivery', routeMiles: 180 }, 'refill on the way': { leg: 'to_delivery', routeMiles: 1040 },
      'refuel now': { pct: 3, leg: 'to_delivery', routeMiles: 180 }, 'W1 4 h dropout, 450 mi': W1, 'W8 MPG 16 read as 11, 700 mi': W8,
      'unmapped pickup': { pickupUnmapped: true, leg: 'to_delivery', routeMiles: 300, pct: 70 }, 'extra stops': { extraStops: true },
      'fix 3 hrs old': { positionAgeMinutes: 180 },
    }
    const strays = []
    let shownCount = 0
    for (const [name, o] of Object.entries(WORLDS)) {
      const w = world(o)
      serve(w)
      const t = textOf(await openSection(panelFactory())).replace(/~?[\d.]+ mi off route/g, '')
      const b = w.planBlock
      const sent = new Set([b.milesLeft, ...b.legs.map((l) => l.miles)].filter((x) => x != null).map(String))
      const shown = [...t.matchAll(/(\d[\d,]*)\s*(?:mi|miles)\b/g)].map((m) => m[1].replace(/,/g, ''))
      shownCount += shown.length
      const bad = shown.filter((n) => !sent.has(n))
      if (bad.length) strays.push(`${name}: shows ${bad.join(', ')} mi; the block sent ${[...sent].join(', ')}`)
    }
    check('§8b (a) every distance on the flag-on screen is one the block sent (top, rows, footers and the stops lead)', [shownCount > 9, strays], [true, []])
    serve(world(W1))
    const w1Text = textOf(await openSection(panelFactory()))
    check('§8b (a) …the W1 dropout: "185 miles until you run out" and "Fuel up within 185 mi.", never the verdict\'s 319',
      [w1Text.includes('185 miles until you run out'), w1Text.includes('Fuel up within 185 mi.'), w1Text.includes('319')], [true, true, false])
    const topClass = async (o) => { serve(world(o)); const m = /class="dff-top tone-(\w+)"/.exec(await openSection(panelFactory())); return m ? m[1] : null }
    check('§8b (a) the top colour is the block\'s: amber on an unmapped pickup or a dropout whose verdicts clear, red on add, green on enough',
      [await topClass({ pickupUnmapped: true, leg: 'to_delivery', routeMiles: 300, pct: 70 }), await topClass({ fuelSource: 'carried', pct: 70, anchor: 72, milesSince: 10, leg: 'to_delivery', routeMiles: 200 }),
        await topClass({}), await topClass({ leg: 'to_delivery', routeMiles: 180 })],
      ['warn', 'warn', 'bad', 'ok'])
  }
  check('§8b load not mapped (400 NO_ROUTE): the top from the range answer, and why there are no rows',
    blockText(await on({}, { '/api/fuel/trip-plan': apiError(400, 'NO_ROUTE') })),
    "225 miles until you run out Fuel level read 12 min ago This load isn't on the map yet, so we can't work out the fuel for it.")
  check('§8b the trip plan failed (500)', blockText(await on({}, { '/api/fuel/trip-plan': apiError(500) })),
    "225 miles until you run out Fuel level read 12 min ago Couldn't load your fuel numbers. Tap Refresh.")
  {
    const h = await on({}, { '/api/fuel/range': apiError(500), '/api/fuel/trip-plan': apiError(400, 'NO_ROUTE') })
    const t = textOf(h)
    check('§8b both failed (the 400 code says the flag is on): "Couldn\'t load your fuel numbers. Tap Refresh.", nothing of today\'s',
      [t.includes("Couldn't load your fuel numbers. Tap Refresh."), t.includes("We can't check this run yet"), t.includes("Couldn't read your fuel level")], [true, false, false])
  }
  {
    const all = []
    for (const o of [{}, { leg: 'to_delivery', routeMiles: 1040 }, { fuelSource: 'carried' }, { pct: 3, leg: 'to_delivery', routeMiles: 180 },
      { fuelSource: 'stale', readAge: 18 * 60 }, { burn: NO_BURN, tankSource: 'default', tank: 200 }, { hasTruck: false, fromLivePosition: false }]) {
      const t = textOf(await on(o))
      if (WORKING_RE.test(t)) all.push(t.match(WORKING_RE)[0])
    }
    check('§8b flag on: no working anywhere on the panel (minus, reserve, MPG, %, "How we know")', all, [])
  }

  // §8c a phone left open: flag-on numbers over 15 minutes old are asked for again
  // when the section opens; the stops are kept. Flag off: as before, never.
  {
    const realNow = Date.now
    let skew = 0
    Date.now = () => realNow() + skew
    try {
      for (const flag of [true, false]) {
        const Panel = panelFactory()
        serve(world({ flag, leg: 'to_delivery', routeMiles: 180 }))
        await openSection(Panel)
        const first = net.gets.length
        skew = 14 * MIN
        await openSection(Panel)
        const at14 = net.gets.length - first
        skew = 16 * MIN
        const later = world({ flag, pct: 40, leg: 'to_delivery', routeMiles: 180 })
        net.answers['/api/fuel/range'] = later.range
        net.answers['/api/fuel/trip-plan'] = later.plan
        const before = net.gets.length
        const html = await openSection(Panel)
        const asked = net.gets.slice(before).sort()
        if (flag) {
          check('§8c flag on: reopened at 14 min nothing is asked; at 16 min the range and the trip plan are, the stops are not',
            [at14, asked], [0, ['/api/fuel/range', '/api/fuel/trip-plan']])
          check('§8c …and the new figure shows (40%: 185 mi)', blockText(html).startsWith('185 miles until you run out'), true)
        } else {
          check('§8c flag off: reopened at 14 and 16 min, nothing is asked (as before)', [at14, asked], [0, []])
        }
        skew = 0
      }
      // The badge's prefetch cached the plan; the section is first opened 16 min later.
      for (const flag of [true, false]) {
        const Panel = panelFactory()
        serve(world({ flag, leg: 'to_delivery', routeMiles: 180 }))
        await renderToString(Vue.createSSRApp(Panel, { loadId: 'QA-FUEL-1', active: false, runnable: true }))
        await settle()
        skew = 16 * MIN
        const before = net.gets.length
        await openSection(Panel)
        const plans = net.gets.slice(before).filter((u) => u === '/api/fuel/trip-plan').length
        check(`§8c ${flag ? 'flag on' : 'flag off'}: a prefetched plan 16 min old, first opened: ${flag ? 'asked again' : 'reused, as before'}`, plans, flag ? 1 : 0)
        skew = 0
      }
    } finally {
      Date.now = realNow
    }
  }
}

// ---------------------------------------------------------------------------
console.log('§9 LoadDetail.vue: the Fuel badge and Route Options')
// ---------------------------------------------------------------------------
{
  globalThis.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }
  const quietHooks = { ...Vue, onMounted() {}, onBeforeUnmount() {}, onUnmounted() {} }
  const detailFactory = await sfcFactory(DETAIL_VUE, { inline: false, vue: quietHooks })
  const detail = () => {
    const scope = Vue.effectScope()
    const props = Vue.shallowReactive({
      load: { 'Load ID': 'QA-FUEL-1', 'Job Status': 'Assigned', Driver: 'Driver QA' }, headers: ['Load ID', 'Job Status', 'Driver'],
      driverName: 'Driver QA', hasActiveJob: false, driverPosition: null, truck: null, loadExpenses: [], responding: false,
      expenseSubmitHandler: null, phoneGpsModeActive: false, phoneGpsStatus: '',
    })
    const b = scope.run(() => detailFactory().setup(props, { expose() {}, emit() {}, attrs: {}, slots: {} }))
    return { b, stop: () => scope.stop() }
  }
  const badgeFor = (plan) => {
    const { b, stop } = detail()
    b.fuelPlan.value = plan
    const out = { badge: b.fuelBadge.value, showFuel: b.routeOptionsShowFuel ? b.routeOptionsShowFuel.value : undefined }
    stop()
    return out
  }
  check('§9 flag on, add to finish: the badge says "Add 65 gal" in red; Route Options drop their gallons',
    badgeFor(world().plan), { badge: { tone: 'bad', text: 'Add 65 gal' }, showFuel: false })
  check('§9 flag on, enough: the section\'s own figure (225), not the distance-to-dry (240)',
    badgeFor(world({ leg: 'to_delivery', routeMiles: 180 }).plan).badge, { tone: 'plain', text: '225 mi range' })
  check('§9 flag on, no tank size: "Fuel unknown", not a stop verdict on an assumed tank',
    badgeFor(world({ burn: NO_BURN, tankSource: 'default', tank: 200 }).plan).badge, { tone: 'warn', text: 'Fuel unknown' })
  check('§9 flag on, refill on the way: as before ("Fuel stop needed")',
    badgeFor(world({ leg: 'to_delivery', routeMiles: 1040 }).plan).badge, { tone: 'bad', text: 'Fuel stop needed' })
  check('§9 flag on, the badge never falls back to the verdict: a delivered load shows none (its verdict would say "Fuel stop needed"), an unmapped pickup "Check gauge" (not a range on its clearing verdict)',
    [badgeFor(world({ loadDone: true }).plan).badge, badgeFor(world({ pickupUnmapped: true, leg: 'to_delivery', routeMiles: 300, pct: 70 }).plan).badge],
    [null, { tone: 'warn', text: 'Check gauge' }])
  {
    const off = badgeFor(world({ flag: false }).plan)
    const offClears = badgeFor(world({ flag: false, leg: 'to_delivery', routeMiles: 180 }).plan)
    check('§9 flag off: the badge as before ("Fuel stop needed"; "240 mi range" on the distance-to-dry), Route Options keep their gallons',
      [off.badge, offClears.badge, off.showFuel !== false], [{ tone: 'bad', text: 'Fuel stop needed' }, { tone: 'plain', text: '240 mi range' }, true])
  }
  const src = fs.readFileSync(DETAIL_VUE, 'utf8')
  check('§9 LoadDetail hands Route Options the switch', /<RouteAlternatives[^>]*:show-fuel="routeOptionsShowFuel"/.test(src), true)

  const altsFactory = await sfcFactory(ALTS_VUE)
  const ALTS = [{ etaMinutes: 400, distanceMiles: 420, fuelLiters: 190, tollPriceUsd: 12.5 }, { etaMinutes: 430, distanceMiles: 431, fuelLiters: null, tollPriceUsd: 0 }]
  const alts = async (extra = {}) => textOf(await renderToString(Vue.createSSRApp(altsFactory(), { alternatives: ALTS, recommendedIdx: 0, selectedIdx: 0, ...extra })))
  const shown = await alts()
  const hidden = await alts({ showFuel: false })
  check('§9 Route Options by default: Google\'s gallons as before, the toll', [shown.includes('⛽ 50.2 gal'), shown.includes('⛽ —'), shown.includes('$12.50'), shown.includes('Toll-free')], [true, true, true, true])
  check('§9 Route Options with showFuel off: no gallons, the toll stays', [hidden.includes('⛽'), hidden.includes('gal'), hidden.includes('$12.50'), hidden.includes('Toll-free')], [false, false, true, true])
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
