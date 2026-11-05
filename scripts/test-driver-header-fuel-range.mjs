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
//      block the chip quotes the block ("Fuel range: 225 miles left until empty",
//      "Refuel now", "Fuel range: not available") with no working in its tooltip;
//      with none, its colour and tooltip are exactly as before
//   §5 the chip's sentence: the server's own figure in it, formatted as before, on
//      both paths
//   §6 the header's real height reaches the page below it (the header is fixed),
//      and a Driver's fuel row is there from the first paint
//   §7 the first row keeps one height whatever the name and Offline do, and the
//      Messages box follows the header's height, so its input stays above the tab bar
//   §8 the chip's tap: a real button in the normal header, plain on the two lock
//      screens; a tap hands up the chip's own line, one figure and no working on
//      either flag path; nothing happens with a dialog over the chip
//   §9 where the tap goes: which load (the driver store's own getters, with the load
//      list that runs newest first): a page on screen only while its load has road
//      left, then the furthest along of the loads under way, then the queue;
//      DriverView's handler run on stand-ins; and the button's box, which must stay
//      the plain chip's so nothing moves, with Password and Logout above its target
//
// The component's own <script setup>, compiled with the client's compiler and
// run with its I/O stubbed. No DOM, no server. §4's blocks come from the server's
// own planDriverFuel() (lib/fuel-model.js), on made-up figures. §8 walks what the
// compiled template renders. §6, §7 and §9 read the styles and DriverView as text for
// what the script can't show; the geometry itself and the real tap are
// scripts/e2e/driver-fuel-screen.mjs (DFC, DFO, DFM and DFT steps).
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
const DRIVER_VIEW_VUE = path.join(CLIENT_DIR, 'src', 'views', 'DriverView.vue')
const CHAT_VIEW_VUE = path.join(DRIVER_DIR, 'ChatView.vue')

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}

const clientRequire = createRequire(path.join(CLIENT_DIR, 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript, compileTemplate } = clientRequire('vue/compiler-sfc')

// ══ the harness ══════════════════════════════════════════════════════════════
// The I/O is stand-ins: child components are stubs, useApi records each GET and
// answers `world.answer`, the auth store reports the role a scenario sets, and
// onMounted / onBeforeUnmount hand their callbacks to the scenario to run. The
// client's own lib modules are the real ones (from this checkout's driver folder).
const world = { role: 'Driver', answer: null, gets: [], mounted: [], unmounted: [], intervals: [], emits: [] }
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
let renderHeader = null
async function compileHeader() {
  const { descriptor } = parse(fs.readFileSync(HEADER_VUE, 'utf8'), { filename: 'DriverHeader.vue' })
  // Not inlined, so setup() hands back its bindings (§4 reads fuelChip).
  const compiled = compileScript(descriptor, { id: 'DriverHeader.vue', inlineTemplate: false })
  let body = compiled.content
  // The template on its own, so §8 can walk what it renders with those bindings.
  const template = compileTemplate({
    source: descriptor.template.content, filename: 'DriverHeader.vue', id: 'DriverHeader.vue',
    compilerOptions: { bindingMetadata: compiled.bindings },
  }).code
    .replace(/^import\s*\{([^}]*)\}\s*from\s*"vue";?[ \t]*$/m, (_, names) => `const { ${names.replace(/\s+as\s+/g, ': ')} } = __vue;`)
    .replace(/^export function render/m, 'return function render')
  renderHeader = new Function('__vue', template)(Vue)
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

async function mountAs(role, answer = null, beforeMount = null, extraProps = {}) {
  Object.assign(world, { role, answer, gets: [], mounted: [], unmounted: [], intervals: [], emits: [] })
  const props = { driverName: 'someone', socketConnected: true, hasEverConnected: false, ...extraProps }
  const emit = (name, ...args) => world.emits.push([name, ...args])
  const bindings = Header.setup(props, { expose() {}, emit, attrs: {}, slots: {} })
  if (beforeMount) beforeMount(bindings)
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
    // The sentence itself says "until empty"; a tooltip saying it is the working.
    const WORKING_TEXT = /minus|reserve|mpg|%/i
    const WORKING_TITLE = /minus|reserve|mpg|%|until empty/i
    const SAYS = (n) => `Fuel range: ${n} miles left until empty`
    const NOT_AVAILABLE = 'Fuel range: not available'

    const live = await chip(answer(MEASURED, block()))
    ok('§4 225 mi left: the chip says so in a sentence, its tooltip the figure in words with no working',
      !!live && live.text === SAYS(225) && live.title === 'About 225 miles before you run out.')
    ok('§4 …and takes its colour from the block\'s miles left (225: grey)', !!live && live.tone === 'ok')
    // One source: a dropout carried at the planning rate leaves 75 mi on the block,
    // while the range answer's own distance-to-dry still reads 240 (green before).
    const dropout = await chip(answer({ ...MEASURED, fuelSource: 'carried' },
      block({ reading: { fuelPct: 48, fuelSource: 'carried', anchorPct: 48, ageMinutes: 60, milesSinceReading: 150 } })))
    ok('§4 the colour is the block\'s: a dropout with 75 mi left is amber, though the range answer says 240',
      !!dropout && dropout.text === SAYS(75) && dropout.tone === 'warn')

    // The estimated basis: the block uses the receipts' 6.0 MPG, the range's own
    // figures the rollup's 7.2, so the two differ and the chip must quote the block.
    const est = await chip(answer({ fuelPct: 48, rangeBasis: 'estimated', rangePlanningMiles: 288, rangeUsableMiles: 273 }, block({ burn: NO_BURN })))
    ok('§4 the chip quotes the block, the same figure as the load\'s Fuel section (225, not the range\'s own 273)', est && est.text === SAYS(225))

    const noTank = await chip(answer({ fuelPct: 48, rangeBasis: 'estimated', tankSource: 'default', rangePlanningMiles: 347, rangeUsableMiles: 332 },
      block({ burn: NO_BURN, tankSource: 'default', tankGallons: 200 })))
    ok('§4 no tank size on file and no measured history: "not available", never an assumed range', noTank && noTank.text === NOT_AVAILABLE && noTank.tone === 'warn')
    ok('§4 …its tooltip says why', noTank && noTank.title === "Miles left unknown. This truck's tank size isn't on file. Check your gauge and ask dispatch to add it.")

    const now = await chip(answer({ fuelPct: 3, rangeBasis: 'measured', rangePlanningMiles: 15, rangeUsableMiles: 0 }, block({ reading: reading(3) })))
    ok('§4 refuel now: "Refuel now", red, and a tooltip with no working',
      !!now && now.text === 'Refuel now' && now.tone === 'bad' && now.title === 'Refuel now. Stop for fuel as soon as you can.')

    const carried = await chip(answer({ ...MEASURED, fuelSource: 'carried' }, block({ reading: reading(48, 'carried') })))
    ok('§4 a sensor dropout: the figure, and the tooltip says it is an estimate',
      !!carried && carried.text === SAYS(225) && carried.title === "About 225 miles before you run out. Your fuel sensor isn't reporting. This is an estimate.")

    const noDevice = await chip(answer({ hasFuelData: false, fuelPct: null, rangeBasis: 'unknown', rangePlanningMiles: null, rangeUsableMiles: null }, block({ hasDevice: false, reading: null })))
    ok('§4 no ELD fuel reading: "not available" with the reason',
      !!noDevice && noDevice.text === NOT_AVAILABLE && noDevice.title === "Fuel level unknown. Your truck isn't sending a fuel level. Check your gauge.")

    ok('§4 no flag-on chip text or tooltip shows any working (minus, reserve, MPG, %)',
      [live, est, noTank, now, carried, noDevice].every((c) => !!c && !WORKING_TEXT.test(c.text) && !WORKING_TITLE.test(c.title)))

    // The flag off: no block, so the colour and the tooltip are exactly as before.
    const FLAG_OFF = { tone: 'ok', text: SAYS(225), title: 'About 225 miles before you run out.' }
    ok('§4 the flag off (no block): the sentence and its colour as before, its tooltip the flag-on line',
      JSON.stringify(await chip(answer(MEASURED, null))) === JSON.stringify(FLAG_OFF))
    ok('§4 a block of a version this client doesn\'t know is ignored (as before)',
      JSON.stringify(await chip(answer(MEASURED, { ...block(), v: 2, milesLeft: 1 }))) === JSON.stringify(FLAG_OFF))

    // ══ §5 — the chip's sentence ═════════════════════════════════════════════
    // N is the figure the chip showed before, and it is the server's: nothing else
    // in the answer can move it.
    const flagOff = async (o) => chip(answer({ fuelPct: 48, ...o }, null))
    const textOf = (c) => (c ? c.text : null)
    ok('§5 flag off: N is the server\'s rangeUsableMiles, not the distance to dry beside it',
      textOf(await flagOff({ rangePlanningMiles: 240, rangeUsableMiles: 225 })) === SAYS(225))
    ok('§5 flag off: nothing else in the answer moves N (tank, percent, MPG are not used for it)',
      textOf(await flagOff({ fuelPct: 1, tankGallons: 9, mpg: 1, rangePlanningMiles: 348, rangeUsableMiles: 333 })) === SAYS(333))
    ok('§5 flag off: a server with no reserve: N is the planning figure, as before',
      textOf(await chip(answer({ fuelPct: 48, reserveMiles: null, rangePlanningMiles: 240, rangeUsableMiles: null }, null))) === SAYS(240))
    ok('§5 flag off: N is rounded and has no thousands comma, as before',
      textOf(await flagOff({ rangePlanningMiles: 240, rangeUsableMiles: 224.6 })) === SAYS(225)
        && textOf(await flagOff({ rangePlanningMiles: 1055, rangeUsableMiles: 1040 })) === SAYS(1040))
    const noneUsable = await flagOff({ rangePlanningMiles: 12, rangeUsableMiles: 0 })
    ok('§5 flag off: 0 usable miles is still the instruction, red, not "0 miles"',
      !!noneUsable && noneUsable.text === 'Refuel now' && noneUsable.tone === 'bad')
    ok('§5 flag off: one mile reads "1 mile"',
      textOf(await flagOff({ rangePlanningMiles: 16, rangeUsableMiles: 1 })) === 'Fuel range: 1 mile left until empty')

    const flagOffUnknown = [
      { hasFuelData: false, fuelPct: null, rangePlanningMiles: null, rangeUsableMiles: null },
      { hasFuelData: true, fuelPct: null, fuelSource: 'stale', fuelAnchorPct: 40, rangePlanningMiles: null, rangeUsableMiles: null },
      { unit: null, hasFuelData: false },
    ]
    for (const o of flagOffUnknown) {
      const c = await chip(answer(o, null))
      ok(`§5 flag off, no figure (${JSON.stringify(o)}): "not available", amber`, !!c && c.text === NOT_AVAILABLE && c.tone === 'warn')
    }
    const staleChip = await chip(answer(flagOffUnknown[1], null))
    ok('§5 …and its tooltip is as before',
      !!staleChip && staleChip.title === "No usable fuel reading from this truck's ELD. Last known 40%. Check the gauge before you set off.")

    ok('§5 flag on: N is the block\'s milesLeft and nothing else in the block or the answer',
      textOf(await chip(answer(MEASURED, { ...block(), milesLeft: 77 }))) === SAYS(77))
    ok('§5 flag on: thousands keep their comma, as the block\'s figure always has',
      textOf(await chip(answer(MEASURED, { ...block(), milesLeft: 1040 }))) === SAYS('1,040'))
    ok('§5 flag on: one mile reads "1 mile"',
      textOf(await chip(answer(MEASURED, { ...block(), milesLeft: 1 }))) === 'Fuel range: 1 mile left until empty')

    const every = [live, dropout, est, noTank, carried, noDevice, staleChip, await flagOff({ rangePlanningMiles: 240, rangeUsableMiles: 225 })]
    ok('§5 no state still reads "Fuel ?" or the bare "N mi"', every.every((c) => !!c && !/\?|\d mi$/.test(c.text)))

    // ══ §8 — the chip's tap ══════════════════════════════════════════════════
    // What the compiled template renders, with the bindings setup() handed back.
    const walk = (node, seen = []) => {
      if (Array.isArray(node)) { node.forEach((n) => walk(n, seen)); return seen }
      if (!node || typeof node !== 'object') return seen
      seen.push(node)
      if (Array.isArray(node.children)) walk(node.children, seen)
      return seen
    }
    const hasClass = (name) => (node) => new RegExp(`(^|\\s)${name}(\\s|$)`).test(String((node.props && node.props.class) || ''))
    const rendered = (bindings, props) => walk(renderHeader({}, [], { driverName: 'someone', socketConnected: true, hasEverConnected: false, ...props }, Vue.proxyRefs(bindings), {}, {}))
    const chipNode = async (a, props = { fuelChipTaps: true }) => {
      const { bindings } = await mountAs('Driver', a, null, props)
      for (const fn of world.unmounted) fn()
      return { node: rendered(bindings, props).find(hasClass('fuel-chip')) || null, bindings, props }
    }
    // A press on the chip: `onTop` is what the page says is at the chip's centre.
    const box = { left: 10, top: 60, width: 200, height: 24 }
    const inside = {}
    const chipEl = { getBoundingClientRect: () => box, contains: (n) => n === chipEl || n === inside }
    const press = async (a, onTop = chipEl, doc = null) => {
      const { node } = await chipNode(a)
      if (!node || !node.props || typeof node.props.onClick !== 'function') return null
      const asked = []
      const realDocument = globalThis.document
      globalThis.document = doc || { elementFromPoint: (x, y) => { asked.push([x, y]); return onTop } }
      try {
        world.emits = []
        node.props.onClick({ currentTarget: chipEl })
      } finally {
        globalThis.document = realDocument
      }
      return { lines: world.emits.filter((e) => e[0] === 'fuel-tap').map((e) => e[1]), asked }
    }
    const lineOf = async (a) => {
      const p = await press(a)
      return p && p.lines.length === 1 ? p.lines[0] : null
    }
    const ON = answer(MEASURED, block())
    const OFF = answer(MEASURED, null)

    const onNode = (await chipNode(ON)).node
    const offNode = (await chipNode(OFF)).node
    for (const [path, node] of [['flag on', onNode], ['flag off', offNode]]) {
      ok(`§8 ${path}: in the normal header the chip is a real button`, !!node && node.type === 'button' && node.props.type === 'button')
      ok(`§8 ${path}: …with a tap handler`, !!node && typeof node.props.onClick === 'function')
      ok(`§8 ${path}: …and a label that starts with the words on it, so a voice command for them finds it`,
        !!node && String(node.props['aria-label'] || '').startsWith(`${SAYS(225)}.`) && /Show details/.test(node.props['aria-label']))
      ok(`§8 ${path}: …its colour, tooltip and sentence as the plain chip's`,
        !!node && /\bok\b/.test(String(node.props.class)) && node.props.title === 'About 225 miles before you run out.' && String(node.children).includes(SAYS(225)))
    }
    for (const [what, props] of [['with no prop', {}], ['with the prop off', { fuelChipTaps: false }]]) {
      const { node } = await chipNode(ON, props)
      ok(`§8 ${what} (a lock screen's header): a plain span, the same sentence and colour`,
        !!node && node.type === 'span' && String(node.children).includes(SAYS(225)) && /\bok\b/.test(String(node.props.class)))
      ok(`§8 ${what}: …with no tap handler, role, focus stop or label`,
        !!node && !Object.keys(node.props).some((k) => /^on[A-Z]|^role$|^tabindex$|^aria-/.test(k)))
    }
    // Before the first answer: the hidden stand-in, in every header, and never a button.
    {
      const { bindings } = await mountAs('Driver', { ok: false }, null, { fuelChipTaps: true })
      await drain()
      for (const fn of world.unmounted) fn()
      const nodes = rendered(bindings, { fuelChipTaps: true })
      const held = nodes.find(hasClass('fuel-held'))
      ok('§8 no answer yet, in the normal header: only the hidden stand-in, a span with no handler',
        !nodes.some(hasClass('fuel-chip')) && !!held && held.type === 'span' && !Object.keys(held.props).some((k) => /^on[A-Z]/.test(k)))
    }

    ok('§8 flag on: a tap hands up the chip\'s own line', (await lineOf(ON)) === 'About 225 miles before you run out.')
    ok('§8 flag off: the same line, word for word', (await lineOf(OFF)) === 'About 225 miles before you run out.')
    const CARRIED_LINE = "About 225 miles before you run out. Your fuel sensor isn't reporting. This is an estimate."
    ok('§8 flag off, a sensor dropout: plain words, the same as the flag on\'s',
      (await lineOf(answer({ ...MEASURED, fuelSource: 'carried' }, null))) === CARRIED_LINE)
    ok('§8 flag on, a sensor dropout', (await lineOf(answer({ ...MEASURED, fuelSource: 'carried' }, block({ reading: reading(48, 'carried') })))) === CARRIED_LINE)
    const NOW_LINE = 'Refuel now. Stop for fuel as soon as you can.'
    ok('§8 flag off, 0 usable miles: the instruction, never "About 0 miles"',
      (await lineOf(answer({ fuelPct: 3, rangePlanningMiles: 12, rangeUsableMiles: 0 }, null))) === NOW_LINE)
    ok('§8 flag on, refuel now', (await lineOf(answer({ fuelPct: 3, rangeBasis: 'measured', rangePlanningMiles: 15, rangeUsableMiles: 0 }, block({ reading: reading(3) })))) === NOW_LINE)
    ok('§8 flag off: one mile reads "1 mile"', (await lineOf(answer({ fuelPct: 1, rangePlanningMiles: 16, rangeUsableMiles: 1 }, null))) === 'About 1 mile before you run out.')
    ok('§8 flag on: one mile reads "1 mile"', (await lineOf(answer(MEASURED, { ...block(), milesLeft: 1 }))) === 'About 1 mile before you run out.')
    ok('§8 flag off, a server with no reserve: the figure the chip quotes, the same words',
      (await lineOf(answer({ fuelPct: 48, reserveMiles: null, rangePlanningMiles: 240, rangeUsableMiles: null }, null))) === 'About 240 miles before you run out.')

    // How it's worked out isn't the driver's to read: one figure, the chip's.
    const FIGURED = {
      'flag off, miles': OFF,
      'flag off, a dropout': answer({ ...MEASURED, fuelSource: 'carried' }, null),
      'flag off, no reserve': answer({ fuelPct: 48, reserveMiles: null, rangePlanningMiles: 240, rangeUsableMiles: null }, null),
      'flag on, miles': ON,
      'flag on, a dropout': answer({ ...MEASURED, fuelSource: 'carried' }, block({ reading: reading(48, 'carried') })),
    }
    for (const [name, a] of Object.entries(FIGURED)) {
      const { node } = await chipNode(a)
      const line = (node && node.props.title) || ''
      const onChip = (String(node && node.children).match(/\d[\d,]*/g) || []).join()
      ok(`§8 ${name}: the line has one figure, the chip's, and no working`,
        !!line && (line.match(/\d[\d,]*/g) || []).join() === onChip && !WORKING_TITLE.test(line) && !/floor|low end|plan on/i.test(line))
    }

    // "not available" stays, and takes a tap too.
    ok('§8 "not available", flag on: a tap hands up the reason',
      (await lineOf(answer({ hasFuelData: false, fuelPct: null, rangeBasis: 'unknown', rangePlanningMiles: null, rangeUsableMiles: null }, block({ hasDevice: false, reading: null }))))
        === "Fuel level unknown. Your truck isn't sending a fuel level. Check your gauge.")
    ok('§8 "not available", flag off: a tap hands up the reason',
      (await lineOf(answer(flagOffUnknown[1], null))) === "No usable fuel reading from this truck's ELD. Last known 40%. Check the gauge before you set off.")
    ok('§8 "not available" is a button in the normal header', (await chipNode(answer(flagOffUnknown[0], null))).node?.type === 'button')

    // A dialog over the chip, reached by a keyboard or a screen reader.
    const covered = await press(ON, { tag: 'dialog-overlay' })
    ok('§8 something else on top of the chip: the press does nothing', !!covered && covered.lines.length === 0)
    ok('§8 …it asks about the chip\'s centre', !!covered && JSON.stringify(covered.asked) === JSON.stringify([[110, 72]]))
    ok('§8 the chip itself on top: a tap', (await press(ON, chipEl))?.lines.length === 1)
    ok('§8 something inside the chip on top: a tap', (await press(ON, inside))?.lines.length === 1)
    ok('§8 nothing at that point (off the visible page): still a tap, since nothing covers it', (await press(ON, null))?.lines.length === 1)
    ok('§8 a browser that can\'t say: still a tap', (await press(ON, null, {}))?.lines.length === 1)
  }

  // ══ §6 — the header's height reaches the page below it ════════════════════
  {
    const props = new Map()
    const observers = []
    const realDocument = globalThis.document
    const realObserver = globalThis.ResizeObserver
    globalThis.document = { documentElement: { style: {
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k),
    } } }
    globalThis.ResizeObserver = class {
      constructor(cb) { this.cb = cb; this.watched = []; this.gone = false; observers.push(this) }
      observe(el) { this.watched.push(el) }
      disconnect() { this.gone = true }
    }
    const el = { offsetHeight: 83 }
    const VAR = '--driver-header-height'
    try {
      await mountAs('Super Admin', null, (b) => { if (b.headerEl) b.headerEl.value = el })
      ok('§6 the header writes its real height for the page below it, in any role (the page sits under a fixed header)', props.get(VAR) === '83px')
      // toRaw: a ref hands a plain test object back as a proxy (a real element stays itself).
      ok('§6 …and watches it, since the height moves with the width and the name', observers.length === 1 && Vue.toRaw(observers[0].watched[0]) === el)
      el.offsetHeight = 104
      if (observers[0]) observers[0].cb()
      ok('§6 …a new height is written', props.get(VAR) === '104px')
      for (const fn of world.unmounted) fn()
      ok('§6 unmounting stops the watch and takes the height back off the page', !!observers[0] && observers[0].gone === true && !props.has(VAR))

      observers.length = 0
      globalThis.ResizeObserver = undefined
      el.offsetHeight = 83
      await mountAs('Driver', null, (b) => { if (b.headerEl) b.headerEl.value = el })
      ok('§6 a browser with no ResizeObserver still gets the height once', props.get(VAR) === '83px')
      for (const fn of world.unmounted) fn()
      ok('§6 …and unmounting still takes it off', !props.has(VAR))
    } finally {
      globalThis.document = realDocument
      globalThis.ResizeObserver = realObserver
    }

    const { descriptor } = parse(fs.readFileSync(HEADER_VUE, 'utf8'), { filename: 'DriverHeader.vue' })
    const headerCss = descriptor.styles.map((s) => s.content).join('\n')
    const view = parse(fs.readFileSync(DRIVER_VIEW_VUE, 'utf8'), { filename: 'DriverView.vue' }).descriptor
    const viewCss = view.styles.map((s) => s.content).join('\n')
    // The rule for exactly this selector: the lookbehind skips one that ends a shared list.
    const rule = (css, sel) => (css.match(new RegExp(`(?<!,\\s*)(?:^|\\n)${sel.replace(/[\\.]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) || [])[1] || ''
    ok('§6 the page starts below the header\'s real height, with today\'s offset only until it is known',
      /padding-top:\s*var\(--driver-header-height,\s*calc\(52px \+ env\(safe-area-inset-top, 0px\)\)\)/.test(rule(viewCss, '.driver-app')))
    ok('§6 the header is tied to the height it reports', /<header\b[^>]*\bref="headerEl"/.test(descriptor.template.content))
    ok('§6 a Driver\'s fuel row is there before the first answer, so nothing moves when it comes',
      /<div\b[^>]*v-if="auth\.isDriver"[^>]*class="fuel-row"|<div\b[^>]*class="fuel-row"[^>]*v-if="auth\.isDriver"/.test(descriptor.template.content))
    // Height comes from the stand-in being the chip's own box. A number on the row
    // was 2.4 px short in a real browser, so no fixed height is allowed back.
    const heldTag = (descriptor.template.content.match(/<span\b[^>]*\bv-else(?=[\s>])[^>]*>([^<]*)<\/span>/) || [])
    ok('§6 …held by a stand-in chip in place of the real one, with the same glyph on its line',
      !!heldTag[0] && /\bstatus-chip\b/.test(heldTag[0]) && /\bfuel-held\b/.test(heldTag[0]) && heldTag[1] === '&#9981;')
    ok('§6 …which is not a .fuel-chip, so nothing that looks for the chip finds it', !!heldTag[0] && !/\bfuel-chip\b/.test(heldTag[0]))
    ok('§6 …with the chip\'s font size, from one shared rule',
      /\.status-chip\.fuel-chip,\s*\.status-chip\.fuel-held\s*\{[^}]*font-size:\s*0\.75rem/.test(headerCss)
        && !/font-size/.test(rule(headerCss, '.status-chip.fuel-chip')) && !/font-size/.test(rule(headerCss, '.status-chip.fuel-held')))
    ok('§6 …the chip\'s border width, unseen', /border:\s*1px solid transparent/.test(rule(headerCss, '.status-chip.fuel-held')))
    ok('§6 …and hidden, so it shows nothing and takes no tap', /visibility:\s*hidden/.test(rule(headerCss, '.status-chip.fuel-held')))
    ok('§6 …every chip colour has that same 1px border',
      ['.status-chip.warn', '.status-chip.fuel-chip.ok', '.status-chip.fuel-chip.bad'].every((sel) => /border:\s*1px solid/.test(rule(headerCss, sel))))
    ok('§6 …and the row has no fixed height of its own, at either width', !/min-height|[^-]height:/.test(
      (headerCss.match(/\.fuel-row\s*\{[^}]*\}/g) || []).join('\n')))
    ok('§6 on a phone the fuel row is a whole row of its own, under the name and the buttons',
      /grid-row:\s*2/.test(rule(headerCss, '.fuel-row')) && /grid-column:\s*1 \/ -1/.test(rule(headerCss, '.fuel-row')))
    ok('§6 from the tablet width up it sits on the buttons\' row',
      /@media \(min-width: 768px\)[\s\S]*\.fuel-row\s*\{[^}]*grid-row:\s*1/.test(headerCss))
    ok('§6 the sentence can wrap inside the chip rather than run off the screen', /white-space:\s*normal/.test(rule(headerCss, '.status-chip.fuel-chip')))
    ok('§6 the left group can give way, so Password and Logout stay on screen', /min-width:\s*0/.test(rule(headerCss, '.app-header-left')))

    // ══ §7 — the first row's height, and the Messages box ═══════════════════
    // Offline comes and goes with the socket and takes its width from the name, so a
    // name that could wrap would regrow the header, and the page follows the header.
    const nameRule = rule(headerCss, '.driver-name-label')
    ok('§7 the driver\'s name stays on one line', /white-space:\s*nowrap/.test(nameRule))
    ok('§7 …cut with an ellipsis when it has no room', /overflow:\s*hidden/.test(nameRule) && /text-overflow:\s*ellipsis/.test(nameRule))
    ok('§7 …and it is the one thing in its group that can shrink', /min-width:\s*0/.test(nameRule))
    ok('§7 …with nothing left that breaks it onto a second line', !/overflow-wrap|word-break/.test(nameRule))
    ok('§7 Offline itself stays on one line', /white-space:\s*nowrap/.test(rule(headerCss, '.status-chip')))
    ok('§7 from the tablet width up, the name gives way before the fuel sentence wraps',
      /@media \(min-width: 768px\)[\s\S]*grid-template-columns:\s*auto minmax\(max-content, 1fr\) auto/.test(headerCss))

    // The box's height is what's left of the screen under the header, above the tab bar.
    const chatCss = parse(fs.readFileSync(CHAT_VIEW_VUE, 'utf8'), { filename: 'ChatView.vue' }).descriptor.styles.map((s) => s.content).join('\n')
    ok('§7 the Messages box takes the header\'s real height off its own, keeping the same room above the tab bar',
      /height:\s*calc\(100vh - 148px - var\(--driver-header-height, 52px\)\)/.test(rule(chatCss, '.chat-container')))

    // ══ §9 — where the tap goes, and the button's box ═══════════════════════
    // Only the third header takes the tap: the first two are the lock screens, with no loads.
    const viewTemplate = view.template.content
    const headerTags = viewTemplate.match(/<DriverHeader\b[^>]*>/g) || []
    ok('§9 DriverView has its three headers', headerTags.length === 3)
    ok('§9 the two lock screens\' headers take no tap', headerTags.slice(0, 2).every((t) => !/fuel-chip-taps|fuel-tap/.test(t)))
    ok('§9 the normal header takes it', !!headerTags[2] && /\bfuel-chip-taps\b/.test(headerTags[2]) && /@fuel-tap="handleFuelTap"/.test(headerTags[2]))
    ok('§9 …and it is the one after the lock screens', viewTemplate.indexOf(headerTags[2]) > viewTemplate.indexOf('NORMAL DRIVER UI'))
    const detailTag = (viewTemplate.match(/<LoadDetail\b[^>]*>/) || [''])[0]
    ok('§9 the load page is asked to open its Fuel section, by its own row only',
      /:open-fuel="fuelTapRow === detailLoad\._rowIndex"/.test(detailTag) && /@fuel-opened="fuelTapRow = null"/.test(detailTag))

    // The load: the store's real getters, and the list that runs newest added first.
    const fuelView = await import(pathToFileURL(path.join(CLIENT_DIR, 'src', 'lib', 'driverFuelView.js')).href)
    const pinned = (name) => (typeof fuelView[name] === 'function' ? fuelView[name] : null)
    const pick = pinned('fuelTapLoad')
    ok('§9 driverFuelView.js says which load a tap opens', !!pick)
    const imported = []
    const storeSrc = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'stores', 'driver.js'), 'utf8')
      .replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])[^'"]+\2;?[ \t]*$/gm, (_, names) => {
        imported.push(...names.split(',').map((n) => n.trim().split(/\s+as\s+/).pop()).filter(Boolean))
        return ''
      })
      .replace(/^export const useDriverStore/m, 'const useDriverStore')
    // defineStore hands back its options, so the getters are the store's own functions.
    const anything = new Proxy(function () {}, { get: () => anything, apply: () => anything })
    const getters = new Function(...imported, `${storeSrc}\nreturn useDriverStore`)(
      ...imported.map((n) => (n === 'defineStore' ? (id, options) => options : anything)),
    ).getters
    const HEADERS = ['Load ID', 'Job Status', 'Driver']
    const qaLoad = (row, id, status, extra = {}) => ({ _rowIndex: row, 'Load ID': id, 'Job Status': status, Driver: 'Driver QA', ...extra })
    const statusOf = (l) => l['Job Status']
    const opened = (loads, onScreen = null) => {
      const state = { headers: { jobTracking: HEADERS }, loads }
      const underWay = getters.inProgressLoads ? getters.inProgressLoads(state) : []
      const load = pick && pick({ onScreen, underWay, queued: getters.queuedLoads(state), statusOf })
      return load ? load['Load ID'] : null
    }
    const ROAD_AND_QUEUE = [qaLoad(2, 'QA-1', 'In Transit'), qaLoad(9, 'QA-9', 'Assigned', { _queuePosition: 1 })]
    ok('§9 (the trap) the working list puts the newest load first, the one still queued',
      getters.workingLoads({ headers: { jobTracking: HEADERS }, loads: ROAD_AND_QUEUE })[0]['Load ID'] === 'QA-9')
    ok('§9 a load on the road and a newer one queued: the load on the road', opened(ROAD_AND_QUEUE) === 'QA-1')
    for (const status of ['Heading to Shipper', 'At Shipper', 'Loading', 'In Transit', 'At Receiver', 'Unloading']) {
      ok(`§9 …${status} counts as past Assigned`, opened([qaLoad(2, 'QA-1', status), qaLoad(9, 'QA-9', 'Assigned')]) === 'QA-1')
    }
    ok('§9 only queued loads: the next in the queue, not the newest',
      opened([qaLoad(2, 'QA-1', 'Assigned', { _queuePosition: 1 }), qaLoad(9, 'QA-9', 'Assigned', { _queuePosition: 2 })]) === 'QA-1')
    ok('§9 …and the queue\'s order, not the sheet\'s',
      opened([qaLoad(2, 'QA-1', 'Assigned', { _queuePosition: 2 }), qaLoad(9, 'QA-9', 'Assigned', { _queuePosition: 1 })]) === 'QA-9')
    ok('§9 no load: none', opened([]) === null)
    ok('§9 only an offer not yet accepted: none, so the toast', opened([qaLoad(2, 'QA-1', 'Dispatched')]) === null)
    ok('§9 only delivered loads: none, so the toast', opened([qaLoad(2, 'QA-1', 'Delivered'), qaLoad(3, 'QA-3', 'Completed')]) === null)
    ok('§9 a load page on screen stays, whatever else is under way', opened(ROAD_AND_QUEUE, qaLoad(9, 'QA-9', 'Assigned')) === 'QA-9')

    // A page stays only while its load has road left. It stays open after Delivered, so
    // this is an everyday state, and its Fuel section would be for a road already driven.
    for (const status of ['Delivered', 'Completed', 'POD Received', ' delivered ']) {
      const done = qaLoad(5, 'QA-5', status)
      ok(`§9 a "${status.trim()}" page on screen, a load on the road: the load on the road`, opened([done, ...ROAD_AND_QUEUE], done) === 'QA-1')
      ok(`§9 …a "${status.trim()}" page, only a queued load: the next in the queue`, opened([done, qaLoad(9, 'QA-9', 'Assigned')], done) === 'QA-9')
      ok(`§9 …a "${status.trim()}" page, no other load: none, so the toast`, opened([done], done) === null)
    }
    for (const status of ['Assigned', 'Dispatched', 'In Transit', 'Unloading']) {
      ok(`§9 a page whose load is ${status} has road left, so it stays`, opened(ROAD_AND_QUEUE, qaLoad(5, 'QA-5', status)) === 'QA-5')
    }
    const detailSrc = fs.readFileSync(path.join(DRIVER_DIR, 'LoadDetail.vue'), 'utf8')
    ok('§9 …the same test as the load page\'s own, one copy', /const loadStillToDrive = computed\(\(\) => hasRoadLeft\(status\.value\)\)/.test(detailSrc))

    // Two loads under way is reachable with ordinary taps: the furthest along, not the newest row.
    const ORDER = ['In Transit', 'At Receiver', 'Unloading', 'At Shipper', 'Loading', 'Heading to Shipper']
    ok('§9 In Transit on an older row beats Heading to Shipper on a newer one',
      opened([qaLoad(2, 'QA-1', 'In Transit'), qaLoad(9, 'QA-9', 'Heading to Shipper')]) === 'QA-1')
    {
      const wrong = []
      for (let i = 0; i < ORDER.length; i++) {
        for (let j = i + 1; j < ORDER.length; j++) {
          if (opened([qaLoad(2, 'QA-1', ORDER[i]), qaLoad(9, 'QA-9', ORDER[j])]) !== 'QA-1') wrong.push(`${ORDER[i]} over ${ORDER[j]}`)
        }
      }
      ok(`§9 …every pair, in the active load's order${wrong.length ? `: ${wrong.join('; ')}` : ''}`, wrong.length === 0)
    }
    {
      // The order itself, Assigned last, since the active load reads it for queued loads too.
      const { statusPriorityScore: score } = await import(pathToFileURL(path.join(CLIENT_DIR, 'src', 'lib', 'loadProgress.js')).href).catch(() => ({}))
      const scores = score ? [...ORDER, 'Assigned', 'Something else'].map((s) => score(s)) : []
      ok('§9 the order in one list: each status ranks after the one before, Assigned and an unknown status last',
        scores.length === 8 && scores.every((n, i) => i === 0 || n > scores[i - 1]) && score(' in transit ') === scores[0] && score(undefined) === scores[7])
    }
    ok('§9 the same status twice: the newer row, only as a tie-break',
      opened([qaLoad(2, 'QA-1', 'In Transit'), qaLoad(9, 'QA-9', 'In Transit')]) === 'QA-9')
    ok('§9 the sort leaves the store\'s own list as it was', (() => {
      const state = { headers: { jobTracking: HEADERS }, loads: [qaLoad(2, 'QA-1', 'Heading to Shipper'), qaLoad(9, 'QA-9', 'In Transit')] }
      const list = getters.inProgressLoads ? getters.inProgressLoads(state) : []
      if (pick) pick({ onScreen: null, underWay: list, queued: [], statusOf })
      return list.map((l) => l['Load ID']).join() === 'QA-1,QA-9'
    })())
    ok('§9 the store\'s inProgressLoad getter is left as it was',
      getters.inProgressLoad({ headers: { jobTracking: HEADERS }, loads: [qaLoad(2, 'QA-1', 'In Transit'), qaLoad(9, 'QA-9', 'Heading to Shipper')] })['Load ID'] === 'QA-9')
    const viewScript = view.scriptSetup.content
    ok('§9 one copy of that order: DriverView imports it for its own active load',
      !/STATUS_PRIORITY/.test(viewScript) && /import \{ statusPriorityScore \} from '\.\.\/lib\/loadProgress'/.test(viewScript) && /statusPriorityScore\(getLoadStatus\(a\)\)/.test(viewScript))

    // DriverView's handler, run on stand-ins.
    const handlerSrc = (viewScript.match(/function handleFuelTap\(title\) \{[\s\S]*?\n\}/) || [''])[0]
    ok('§9 DriverView has the handler', !!handlerSrc)
    const runHandler = (o) => {
      const s = { currentTab: { value: 'loads' }, detailLoad: { value: null }, fuelTapRow: { value: null }, detailRowIndex: { value: null },
        store: { inProgressLoads: [], queuedLoads: [], loadSubTab: 'historical' }, toasts: [], tabs: [], ...o }
      const build = new Function('currentTab', 'detailLoad', 'driverStore', 'toast', 'handleTabSwitch', 'fuelTapRow', 'detailRowIndex', 'fuelTapLoad', 'FUEL_LINE_MS', 'getLoadStatus',
        `${handlerSrc}\nreturn handleFuelTap`)
      build(s.currentTab, s.detailLoad, s.store, { show: (...a) => s.toasts.push(a) }, (t) => { s.tabs.push(t); s.currentTab.value = t }, s.fuelTapRow, s.detailRowIndex, pick, 'THE-LONG-TIME', statusOf)('the chip line')
      return s
    }
    if (handlerSrc && pick) {
      const none = runHandler({})
      ok('§9 no load: the chip\'s own line as a toast, held long enough to read', JSON.stringify(none.toasts) === JSON.stringify([['the chip line', 'success', 'THE-LONG-TIME']]))
      ok('§9 …and the screen stays where it is', none.detailRowIndex.value === null && none.fuelTapRow.value === null && none.tabs.length === 0 && none.store.loadSubTab === 'historical')
      const road = runHandler({ store: { inProgressLoads: [qaLoad(2, 'QA-1', 'In Transit')], queuedLoads: [qaLoad(9, 'QA-9', 'Assigned')], loadSubTab: 'historical' } })
      ok('§9 a load under way, from the list: its page, asked to open Fuel, with no toast', road.detailRowIndex.value === 2 && road.fuelTapRow.value === 2 && road.toasts.length === 0)
      ok('§9 …on the Loads tab\'s Active list, so Back lands where the load is', road.tabs.join() === 'loads' && road.store.loadSubTab === 'active')
      const queued = runHandler({ store: { inProgressLoads: [], queuedLoads: [qaLoad(9, 'QA-9', 'Assigned')], loadSubTab: 'active' } })
      ok('§9 only queued: the next in the queue', queued.detailRowIndex.value === 9 && queued.fuelTapRow.value === 9)
      const page = runHandler({ detailLoad: { value: qaLoad(9, 'QA-9', 'Assigned') }, detailRowIndex: { value: 9 }, store: { inProgressLoads: [qaLoad(2, 'QA-1', 'In Transit')], queuedLoads: [], loadSubTab: 'pending' } })
      ok('§9 a load page on screen: it stays there and opens Fuel', page.detailRowIndex.value === 9 && page.fuelTapRow.value === 9 && page.tabs.length === 0 && page.store.loadSubTab === 'pending')
      const left = runHandler({ currentTab: { value: 'messages' }, detailLoad: { value: qaLoad(5, 'QA-5', 'Delivered') }, detailRowIndex: { value: 5 }, store: { inProgressLoads: [qaLoad(2, 'QA-1', 'In Transit')], queuedLoads: [], loadSubTab: 'historical' } })
      ok('§9 on another tab, with a page left open behind it: the load under way, not that page', left.detailRowIndex.value === 2 && left.fuelTapRow.value === 2 && left.tabs.join() === 'loads')
      const stale = runHandler({ currentTab: { value: 'kit' }, detailLoad: { value: qaLoad(5, 'QA-5', 'Delivered') }, detailRowIndex: { value: 5 } })
      ok('§9 on another tab with no load under way: the toast, even with a page left open behind it', stale.toasts.length === 1 && stale.currentTab.value === 'kit' && stale.fuelTapRow.value === null)
      const done = runHandler({ detailLoad: { value: qaLoad(5, 'QA-5', 'Delivered') }, detailRowIndex: { value: 5 }, store: { inProgressLoads: [qaLoad(2, 'QA-1', 'In Transit')], queuedLoads: [], loadSubTab: 'historical' } })
      ok('§9 a delivered page on screen, a load on the road: on to that load, on the Active list, with Fuel asked for',
        done.detailRowIndex.value === 2 && done.fuelTapRow.value === 2 && done.store.loadSubTab === 'active' && done.toasts.length === 0)
      const doneAlone = runHandler({ detailLoad: { value: qaLoad(5, 'QA-5', 'Delivered') }, detailRowIndex: { value: 5 } })
      ok('§9 a delivered page on screen, no other load: the toast, and the page stays',
        doneAlone.toasts.length === 1 && doneAlone.detailRowIndex.value === 5 && doneAlone.fuelTapRow.value === null && doneAlone.tabs.length === 0)
    }
    const lineMs = Number((view.scriptSetup.content.match(/const FUEL_LINE_MS = (\d+)/) || [])[1])
    ok('§9 the longer toast is at least 5 s: its longest line is about 100 characters', lineMs >= 5000)

    // useToast's third argument: every other caller keeps its 3 s.
    {
      const { useToast } = await import(pathToFileURL(path.join(CLIENT_DIR, 'src', 'composables', 'useToast.js')).href)
      const realTimeout = globalThis.setTimeout
      const asked = []
      globalThis.setTimeout = (fn, ms) => { asked.push(ms); return 0 }
      try {
        useToast().show('made-up')
        useToast().show('made-up', 'error')
        useToast().show('made-up', 'success', 6000)
      } finally {
        globalThis.setTimeout = realTimeout
      }
      ok('§9 the toast: 3 s unless asked otherwise', asked.join() === '3000,3000,6000')
    }

    // The button keeps the plain chip's box: same padding, font size and border, from
    // the same rules, with only a button's browser defaults undone.
    const tapRule = rule(headerCss, '.status-chip.fuel-tap')
    ok('§9 the button adds nothing that changes the chip\'s box', !!tapRule && !/padding|margin|border|[^-]height:|font-size|display/.test(tapRule.replace(/line-height:\s*inherit/, '')))
    ok('§9 …it takes the line height and font of the plain chip around it', /line-height:\s*inherit/.test(tapRule) && /font-family:\s*inherit/.test(tapRule))
    ok('§9 …left-aligned when the sentence wraps, like the plain chip', /text-align:\s*left/.test(tapRule))
    ok('§9 …with the platform\'s button look off', /(^|\s)appearance:\s*none/.test(tapRule) && /-webkit-appearance:\s*none/.test(tapRule))
    const hit = rule(headerCss, '.status-chip.fuel-tap::after')
    ok('§9 the target is 44 px tall, out of the row\'s flow', /content:/.test(hit) && /position:\s*absolute/.test(hit) && /min-height:\s*44px/.test(hit))
    ok('§9 …measured from the chip itself', /position:\s*relative/.test(tapRule))
    const rowGap = (rule(headerCss, '.app-header').match(/gap:\s*([\d.]+)rem/) || [])[1]
    const reach = (hit.match(/top:\s*-([\d.]+)rem/) || [])[1]
    ok('§9 …reaching up no further than the gap between the rows, so Password and Logout keep their taps', !!rowGap && !!reach && Number(reach) <= Number(rowGap))
    const rightRule = rule(headerCss, '.app-header-right')
    ok('§9 Password and Logout sit above the chip\'s target, whatever the row heights do',
      /position:\s*relative/.test(rightRule) && Number((rightRule.match(/z-index:\s*(\d+)/) || [])[1]) >= 1)
    ok('§9 …and that adds nothing that moves them', !/margin|padding|[^-]height:|top:|transform/.test(rightRule))
    ok('§9 …while the target itself sets no z-index, so it can\'t climb back over them', !/z-index/.test(hit) && !/z-index/.test(tapRule))
    ok('§9 keyboard focus shows', /outline:\s*2px solid/.test(rule(headerCss, '.status-chip.fuel-tap:focus-visible')))
    ok('§9 the stand-in is still no button', /<span\b[^>]*\bfuel-held\b/.test(descriptor.template.content) && !/<button\b[^>]*\bfuel-held\b/.test(descriptor.template.content))
  }
}

globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval
console.log(`\ndriver-header-fuel-range: ${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
