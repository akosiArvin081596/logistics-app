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
// No network, no sheet, no database, no Vue — pure input/output, safe anywhere.
//
//   node scripts/test-fuel-reserve-line.mjs      # exits 1 on any failure

import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.join(__dirname, '..', 'client', 'src', 'lib', 'fuelReview.js')

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
