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
//      both paths; the chip takes no tap
//   §6 the header's real height reaches the page below it (the header is fixed),
//      and a Driver's fuel row is there from the first paint
//   §7 the first row keeps one height whatever the name and Offline do, and the
//      Messages box follows the header's height, so its input stays above the tab bar
//
// The component's own <script setup>, compiled with the client's compiler and
// run with its I/O stubbed. No DOM, no server. §4's blocks come from the server's
// own planDriverFuel() (lib/fuel-model.js), on made-up figures. §5 and §6 read the
// template and styles as text for what the script can't show, and so does §7; the
// geometry itself is scripts/e2e/driver-fuel-screen.mjs (DFC, DFO and DFM steps).
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

async function mountAs(role, answer = null, beforeMount = null) {
  Object.assign(world, { role, answer, gets: [], mounted: [], unmounted: [], intervals: [] })
  const bindings = Header.setup({ driverName: 'someone', socketConnected: true, hasEverConnected: false }, { expose() {}, emit() {}, attrs: {}, slots: {} })
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
    const TODAY = {
      tone: 'ok', text: SAYS(225),
      title: 'About 225 miles before you need to refuel (48% in the tank). That is 240 miles until empty, minus a 15 mile reserve. This is the low end of the range, not the best case.',
    }
    ok('§4 the flag off (no block): the sentence, with the colour and tooltip exactly as before', JSON.stringify(await chip(answer(MEASURED, null))) === JSON.stringify(TODAY))
    ok('§4 a block of a version this client doesn\'t know is ignored (as before)',
      JSON.stringify(await chip(answer(MEASURED, { ...block(), v: 2, milesLeft: 1 }))) === JSON.stringify(TODAY))

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

    // A chip that takes no tap must stay one: no handler, no button, no focus stop.
    const headerSrc = fs.readFileSync(HEADER_VUE, 'utf8')
    const chipTag = (headerSrc.match(/<([a-z-]+)\b[^>]*\bfuel-chip\b[^>]*>/) || [])
    ok('§5 the chip is a plain span', chipTag[1] === 'span')
    ok('§5 …with no tap handler, role or focus stop', !!chipTag[0] && !/@click|@touch|@pointer|v-on|\brole=|tabindex/.test(chipTag[0]))
    ok('§5 …and its colour and tooltip bindings stay', !!chipTag[0] && /:class="fuelChip\.tone"/.test(chipTag[0]) && /:title="fuelChip\.title"/.test(chipTag[0]))
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
    const heldTag = (descriptor.template.content.match(/<span\b[^>]*\bv-else\b[^>]*>([^<]*)<\/span>/) || [])
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
  }
}

globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval
console.log(`\ndriver-header-fuel-range: ${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
