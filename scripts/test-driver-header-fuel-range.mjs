#!/usr/bin/env node
// The driver app's header asks for its own fuel range only in a Driver session
// (2026-10-10).
//
// WHY THIS EXISTS. DriverHeader polls GET /api/fuel/range with no params: the
// route resolves a Driver's truck from the session and ignores any params a
// Driver sends. Anyone else must name ?driver= or ?vehicleId=, and the route
// answers 400 "driver or vehicleId required" without one. /driver admits a
// Super Admin too, so every Super Admin page load there logged a failed request
// (seen in the replica check, 2026-10-10). The route stays as it is: the Driver
// scoping on fuel routes is a security control.
//
//   §1 a Super Admin on /driver asks for no fuel range and starts no poll
//   §2 neither does any other role that is not Driver
//   §3 a Driver still asks for its own range, with no params, and polls it
//      every 2 minutes until the header unmounts
//   §4 the driver gallons flag (DRIVER_FUEL_GALLONS_ENABLED): with a `driverFuel`
//      block the chip quotes the block ("225 mi", "Refuel now", "Fuel ?") with no
//      working in its tooltip; with none, the chip is exactly as before
//
// The component's own <script setup>, compiled with the client's compiler and
// run with its I/O stubbed. No DOM, no server. §4's blocks come from the server's
// own planDriverFuel() (lib/fuel-model.js), on made-up figures.
//   node scripts/test-driver-header-fuel-range.mjs
//   DRIVER_HEADER_VUE=/tmp/base/DriverHeader.vue node scripts/test-driver-header-fuel-range.mjs   # a base copy: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, '..')
const CLIENT_DIR = path.join(ROOT, 'client')
const DRIVER_DIR = path.join(CLIENT_DIR, 'src', 'components', 'driver')
const HEADER_VUE = process.env.DRIVER_HEADER_VUE || path.join(DRIVER_DIR, 'DriverHeader.vue')

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}

const clientRequire = createRequire(path.join(CLIENT_DIR, 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')

// ══ the harness ══════════════════════════════════════════════════════════════
// The I/O is stand-ins: child components are stubs, useApi records each GET and
// answers `world.answer`, the auth store reports the role a scenario sets, and
// onMounted / onBeforeUnmount hand their callbacks to the scenario to run. The
// client's own lib modules are the real ones (from this checkout's driver folder).
const world = { role: 'Driver', answer: null, gets: [], mounted: [], unmounted: [], intervals: [] }
const STUBS = {
  '../../composables/useApi': {
    useApi: () => ({ get: async (url) => { world.gets.push(url); return world.answer || { ok: true, hasFuelData: false } } }),
  },
  '../../stores/auth': {
    useAuthStore: () => ({
      get user() { return { username: 'someone', role: world.role } },
      get isDriver() { return world.role === 'Driver' },
      get isSuperAdmin() { return world.role === 'Super Admin' },
    }),
  },
}
async function compileHeader() {
  const { descriptor } = parse(fs.readFileSync(HEADER_VUE, 'utf8'), { filename: 'DriverHeader.vue' })
  // Not inlined, so setup() hands back its bindings (§4 reads fuelChip).
  let body = compileScript(descriptor, { id: 'DriverHeader.vue', inlineTemplate: false }).content
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
  if (/^\s*(import|export)\s/m.test(body)) throw new Error('DriverHeader.vue: an import/export this harness cannot map')
  const deps = {
    vue: {
      ...Vue,
      onMounted: (fn) => world.mounted.push(fn),
      onBeforeUnmount: (fn) => world.unmounted.push(fn),
    },
  }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec.endsWith('.vue')) deps[spec] = { default: Vue.defineComponent({ name: path.basename(spec, '.vue'), setup: () => () => null }) }
    else if (spec in STUBS) deps[spec] = STUBS[spec]
    else if (/^\.\.\/\.\.\/lib\/[\w.]+$/.test(spec)) deps[spec] = await import(pathToFileURL(path.join(DRIVER_DIR, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
    else throw new Error(`DriverHeader.vue imports ${spec}, which this harness does not stub`)
  }
  return new Function('__deps', body)(deps)
}

// The timers are recorded, never scheduled: the poll is checked by calling the
// recorded callback.
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setInterval = (fn, ms) => { const t = { fn, ms, cleared: false }; world.intervals.push(t); return t }
globalThis.clearInterval = (t) => { if (t && typeof t === 'object') t.cleared = true }

const drain = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }
let Header
try { Header = await compileHeader() } catch (err) { ok(`DriverHeader.vue compiles in this harness (${err.message})`, false) }

async function mountAs(role, answer = null) {
  Object.assign(world, { role, answer, gets: [], mounted: [], unmounted: [], intervals: [] })
  const bindings = Header.setup({ driverName: 'someone', socketConnected: true, hasEverConnected: false }, { expose() {}, emit() {}, attrs: {}, slots: {} })
  for (const fn of world.mounted) fn()
  await drain()
  return { asked: world.gets.filter((u) => u.startsWith('/api/fuel/range')), polls: world.intervals.slice(), bindings }
}

if (Header) {
  // ══ §1 — a Super Admin on /driver ══════════════════════════════════════════
  {
    const { asked, polls } = await mountAs('Super Admin')
    ok('§1 a Super Admin on /driver asks for no fuel range (the route answers 400 without a driver)', asked.length === 0)
    ok('§1 …and starts no poll', polls.length === 0)
  }

  // ══ §2 — any other role that is not Driver ═════════════════════════════════
  for (const role of ['Dispatcher', 'Investor', '']) {
    const { asked, polls } = await mountAs(role)
    ok(`§2 role "${role || '(none)'}" asks for no fuel range and starts no poll`, asked.length === 0 && polls.length === 0)
  }

  // ══ §3 — a Driver ══════════════════════════════════════════════════════════
  {
    const { asked, polls } = await mountAs('Driver')
    ok('§3 a Driver asks for its own fuel range once on mount', asked.length === 1)
    ok('§3 …with no params (the route resolves the truck from the session)', asked[0] === '/api/fuel/range')
    ok('§3 …and polls it every 2 minutes', polls.length === 1 && polls[0].ms === 120000)
    if (polls.length === 1) {
      polls[0].fn()
      await drain()
      ok('§3 …each poll asks the same, with no params', world.gets.filter((u) => u === '/api/fuel/range').length === 2)
    }
    for (const fn of world.unmounted) fn()
    ok('§3 unmounting stops the poll', polls.length === 1 && polls[0].cleared === true)
  }

  // ══ §4 — the driver gallons flag ═══════════════════════════════════════════
  // Made-up truck "Unit 901": 40 measured fill legs (p10 5.0 mi a fuel point), a
  // 150 gal tank, 6.0 MPG from its receipts. The range answer's own figures sit
  // beside the block as GET /api/fuel/range sends them (its MPG is the ELD rollup's).
  {
    const fuel = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'fuel-model.js'))
    const BURN5 = { usable: true, p10: 5.0, p50: 7.4, p90: 10.2, n: 40, miles: 9000, points: 1216, milesPerPoint: 7.4 }
    const NO_BURN = { usable: false, p10: null, p50: null, p90: null, milesPerPoint: null }
    const reading = (pct, fuelSource = 'live') => ({ fuelPct: pct, fuelSource, anchorPct: pct, ageMinutes: 12, milesSinceReading: 0 })
    const block = (o = {}) => fuel.planDriverFuel({
      reading: reading(48), hasTruck: true, hasDevice: true, tankSource: 'truck', tankGallons: 150, mpg: 6.0,
      burn: BURN5, reserve: { minMiles: 15, fraction: 0 }, ...o,
    })
    const answer = (old, driverFuel) => ({ ok: true, unit: '901', hasFuelData: true, fuelSource: 'live', reserveMiles: 15, ...old, ...(driverFuel ? { driverFuel } : {}) })
    const MEASURED = { fuelPct: 48, rangeBasis: 'measured', rangePlanningMiles: 240, rangeUsableMiles: 225 }
    const chip = async (a) => {
      const { bindings } = await mountAs('Driver', a)
      for (const fn of world.unmounted) fn()
      const c = bindings && bindings.fuelChip ? bindings.fuelChip.value : null
      return c ? { tone: c.tone, text: c.text, title: c.title } : null
    }
    const WORKING = /minus|reserve|mpg|%|until empty/i

    const live = await chip(answer(MEASURED, block()))
    ok('§4 225 mi left: the chip says "225 mi", its tooltip the figure in words with no working',
      !!live && live.text === '225 mi' && live.title === 'About 225 miles before you run out.')
    ok('§4 …and takes its colour from the block\'s miles left (225: grey)', !!live && live.tone === 'ok')
    // One source: a dropout carried at the planning rate leaves 75 mi on the block,
    // while the range answer's own distance-to-dry still reads 240 (green before).
    const dropout = await chip(answer({ ...MEASURED, fuelSource: 'carried' },
      block({ reading: { fuelPct: 48, fuelSource: 'carried', anchorPct: 48, ageMinutes: 60, milesSinceReading: 150 } })))
    ok('§4 the colour is the block\'s: a dropout with 75 mi left is amber, though the range answer says 240',
      !!dropout && dropout.text === '75 mi' && dropout.tone === 'warn')

    // The estimated basis: the block uses the receipts' 6.0 MPG, the range's own
    // figures the rollup's 7.2, so the two differ and the chip must quote the block.
    const est = await chip(answer({ fuelPct: 48, rangeBasis: 'estimated', rangePlanningMiles: 288, rangeUsableMiles: 273 }, block({ burn: NO_BURN })))
    ok('§4 the chip quotes the block, the same figure as the load\'s Fuel section (225, not the range\'s own 273)', est && est.text === '225 mi')

    const noTank = await chip(answer({ fuelPct: 48, rangeBasis: 'estimated', tankSource: 'default', rangePlanningMiles: 347, rangeUsableMiles: 332 },
      block({ burn: NO_BURN, tankSource: 'default', tankGallons: 200 })))
    ok('§4 no tank size on file and no measured history: "Fuel ?", never an assumed range', noTank && noTank.text === 'Fuel ?' && noTank.tone === 'warn')
    ok('§4 …its tooltip says why', noTank && noTank.title === "Miles left unknown. This truck's tank size isn't on file. Check your gauge and ask dispatch to add it.")

    const now = await chip(answer({ fuelPct: 3, rangeBasis: 'measured', rangePlanningMiles: 15, rangeUsableMiles: 0 }, block({ reading: reading(3) })))
    ok('§4 refuel now: "Refuel now", red, and a tooltip with no working',
      !!now && now.text === 'Refuel now' && now.tone === 'bad' && now.title === 'Refuel now. Stop for fuel as soon as you can.')

    const carried = await chip(answer({ ...MEASURED, fuelSource: 'carried' }, block({ reading: reading(48, 'carried') })))
    ok('§4 a sensor dropout: the figure, and the tooltip says it is an estimate',
      !!carried && carried.text === '225 mi' && carried.title === "About 225 miles before you run out. Your fuel sensor isn't reporting. This is an estimate.")

    const noDevice = await chip(answer({ hasFuelData: false, fuelPct: null, rangeBasis: 'unknown', rangePlanningMiles: null, rangeUsableMiles: null }, block({ hasDevice: false, reading: null })))
    ok('§4 no ELD fuel reading: "Fuel ?" with the reason',
      !!noDevice && noDevice.text === 'Fuel ?' && noDevice.title === "Fuel level unknown. Your truck isn't sending a fuel level. Check your gauge.")

    ok('§4 no flag-on chip text or tooltip shows any working (minus, reserve, MPG, %)',
      [live, est, noTank, now, carried, noDevice].every((c) => !!c && !WORKING.test(`${c.text} ${c.title}`)))

    // The flag off: no block, so the chip is exactly as before.
    const TODAY = {
      tone: 'ok', text: '225 mi',
      title: 'About 225 miles before you need to refuel (48% in the tank). That is 240 miles until empty, minus a 15 mile reserve. This is the low end of the range, not the best case.',
    }
    ok('§4 the flag off (no block): the chip and its tooltip exactly as before', JSON.stringify(await chip(answer(MEASURED, null))) === JSON.stringify(TODAY))
    ok('§4 a block of a version this client doesn\'t know is ignored (as before)',
      JSON.stringify(await chip(answer(MEASURED, { ...block(), v: 2, milesLeft: 1 }))) === JSON.stringify(TODAY))
  }
}

globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval
console.log(`\ndriver-header-fuel-range: ${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
