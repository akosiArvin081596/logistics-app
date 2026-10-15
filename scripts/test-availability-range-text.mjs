#!/usr/bin/env node
// A driver's time off reads the same for every viewer (R11). The dates are
// calendar days ("YYYY-MM-DD"), never instants, so "Oct 14 – Oct 20" must not
// shift a day for a dispatcher in Honolulu or Manila. client/src/lib/availabilityText.js
// formats them from the text alone; this runs it under viewer zones from -12 h
// to +14 h and pins it to the server's own wording (lib/driver-availability.js),
// which the 409 DRIVER_OFF_DUTY message uses.
//
//   §1 the range, a single day, a range across a year end, unreadable input
//   §2 "Off until Oct 20" (the Fleet & Drivers pill, the Trucks chip) and the
//      dropdown suffix "— Off until Oct 20"; the pill keeps the status when
//      the driver is not off
//   §3 the same text in every viewer zone
//   §4 the client and the server say the same thing
//
// No DOM, no server. Files under test come from LOGISX_ROOT (default: this
// checkout).
//   node scripts/test-availability-range-text.mjs
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = process.env.LOGISX_ROOT || HERE

let pass = 0
const failures = []
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  failures.push(`${name} — expected ${e}, got ${a}`)
  console.log(`  FAIL  ${name} — expected ${e}, got ${a}`)
}

let text = null
try {
  text = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'availabilityText.js')).href)
} catch {
  text = null
}
eq('§0 client/src/lib/availabilityText.js loads', !!text, true)
const T = text || {}
const call = (name, ...args) => (typeof T[name] === 'function' ? T[name](...args) : undefined)

const ZONES = ['America/New_York', 'Pacific/Honolulu', 'America/Los_Angeles', 'UTC', 'Asia/Manila', 'Pacific/Kiritimati', 'Etc/GMT+12']
const CASES = [
  [['2026-10-14', '2026-10-20'], 'Oct 14 – Oct 20'],
  [['2026-10-14', '2026-10-14'], 'Oct 14'],
  [['2026-10-31', '2026-11-01'], 'Oct 31 – Nov 1'],
  [['2026-12-28', '2027-01-03'], 'Dec 28, 2026 – Jan 3, 2027'],
  [['2026-03-08', '2026-03-09'], 'Mar 8 – Mar 9'],
  [['', '2026-10-20'], ''],
  [['2026-13-01', '2026-10-20'], ''],
]

function runAll(zone) {
  process.env.TZ = zone
  const out = []
  for (const [args, want] of CASES) {
    const got = call('availabilityRangeText', ...args)
    eq(`§1/§3 [${zone}] availabilityRangeText(${args.join(', ')})`, got, want)
    out.push(got)
  }
  const until = call('offUntilText', '2026-10-20')
  eq(`§2/§3 [${zone}] offUntilText`, until, 'Off until Oct 20')
  eq(`§2/§3 [${zone}] dropdown suffix`, call('offDutySuffix', '2026-10-20'), ' — Off until Oct 20')
  eq(`§2 [${zone}] no date, no suffix`, call('offDutySuffix', null), '')
  eq(`§2 [${zone}] the fleet pill of a driver off`, call('fleetPillText', { Status: 'Queued', offUntil: '2026-10-20' }), 'Off until Oct 20')
  eq(`§2 [${zone}] the fleet pill of a driver not off`, call('fleetPillText', { Status: 'Available', offUntil: null }), 'Available')
  eq(`§2 [${zone}] the fleet pill when the server sent no availability`, call('fleetPillText', { Status: 'On Load' }), 'On Load')
  out.push(until)
  return out.join('|')
}

const seen = new Set(ZONES.map(runAll))
eq('§3 every zone gives the same text', seen.size, 1)

// §2b the assign dropdowns: drivers off today move last, never hidden, each
// group in the server's order; with no availability sent, the order is unchanged.
eq('§2b off drivers last, order kept', call('sortDriversForAssign', ['Cy', 'Amy', 'Bo', 'Dee'], { Amy: '2026-10-20', Dee: '2026-10-18' }), ['Cy', 'Bo', 'Amy', 'Dee'])
eq('§2b no availability: unchanged', call('sortDriversForAssign', ['Cy', 'Amy', 'Bo'], null), ['Cy', 'Amy', 'Bo'])
eq('§2b the off-duty answer is recognised', [
  call('isOffDutyWarning', { status: 409, code: 'DRIVER_OFF_DUTY' }),
  call('isOffDutyWarning', { status: 409, code: 'PERIOD_FINALIZED' }),
  call('isOffDutyWarning', { status: 400, code: 'DRIVER_OFF_DUTY' }),
  call('isOffDutyWarning', null),
], [true, false, false, false])

// §4 the server's wording, the same function by name in lib/driver-availability.js.
let server = null
try { server = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'driver-availability.js')) } catch { server = null }
eq('§4 lib/driver-availability.js loads', !!server, true)
for (const [args] of CASES) {
  eq(`§4 client and server agree on ${args.join('..') || '(blank)'}`, call('availabilityRangeText', ...args), server && server.availabilityRangeText ? server.availabilityRangeText(...args) : null)
}

console.log(`\ntest-availability-range-text: ${pass} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
