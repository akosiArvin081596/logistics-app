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
//
// The component's own <script setup>, compiled with the client's compiler and
// run with its I/O stubbed. No DOM, no server.
//   node scripts/test-driver-header-fuel-range.mjs
//   DRIVER_HEADER_VUE=/tmp/base/DriverHeader.vue node scripts/test-driver-header-fuel-range.mjs   # a base copy: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, '..')
const CLIENT_DIR = path.join(ROOT, 'client')
const HEADER_VUE = process.env.DRIVER_HEADER_VUE || path.join(CLIENT_DIR, 'src', 'components', 'driver', 'DriverHeader.vue')

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
// Every import is a stand-in: child components are stubs, useApi records each
// GET, the auth store reports the role a scenario sets, and onMounted /
// onBeforeUnmount hand their callbacks to the scenario to run.
const world = { role: 'Driver', gets: [], mounted: [], unmounted: [], intervals: [] }
const STUBS = {
  '../../composables/useApi': {
    useApi: () => ({ get: async (url) => { world.gets.push(url); return { ok: true, hasFuelData: false } } }),
  },
  '../../stores/auth': {
    useAuthStore: () => ({
      get user() { return { username: 'someone', role: world.role } },
      get isDriver() { return world.role === 'Driver' },
      get isSuperAdmin() { return world.role === 'Super Admin' },
    }),
  },
}
function compileHeader() {
  const { descriptor } = parse(fs.readFileSync(HEADER_VUE, 'utf8'), { filename: 'DriverHeader.vue' })
  let body = compileScript(descriptor, { id: 'DriverHeader.vue', inlineTemplate: true }).content
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
try { Header = compileHeader() } catch (err) { ok(`DriverHeader.vue compiles in this harness (${err.message})`, false) }

async function mountAs(role) {
  Object.assign(world, { role, gets: [], mounted: [], unmounted: [], intervals: [] })
  Header.setup({ driverName: 'someone', socketConnected: true, hasEverConnected: false }, { expose() {}, emit() {}, attrs: {}, slots: {} })
  for (const fn of world.mounted) fn()
  await drain()
  return { asked: world.gets.filter((u) => u.startsWith('/api/fuel/range')), polls: world.intervals.slice() }
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
}

globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval
console.log(`\ndriver-header-fuel-range: ${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
