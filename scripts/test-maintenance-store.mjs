#!/usr/bin/env node
// Deterministic check on client/src/stores/maintenance.js: the investor maintenance
// popup's dismissal, kept per browser tab AND per person (owner decision, 2026-09-26).
//
// WHY THIS EXISTS. The dismissal lived under one sessionStorage key per notice
// version. A sign-out, and a sign-in as someone else, load a fresh page in the same
// tab (stores/auth.js), and sessionStorage survives that load, so two investors
// sharing a tab shared one dismissal: the second one signed in and never saw the
// popup. The key now carries the signed-in user's id. And because App.vue fetches
// the config while the router's first session check is still running, the
// dismissal is read again whenever the signed-in user changes; without that, a
// person who had dismissed the popup got it back on every reload whose config
// arrived before the session did.
//
// Loads the committed store with the real Pinia and Vue, the real useApi (fetch
// scripted), and two stand-in stores for auth and investor: the store reads only
// `user`, `isAuthenticated`, the role getters and `isPreview` from them.
// sessionStorage and localStorage are in memory, and localStorage must never be
// touched. Then MUTANTS of the store, each a plausible regression, must each fail
// a scenario. No DOM, no server; Vue and Pinia come from client/node_modules.
//
//   node scripts/test-maintenance-store.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.join(__dirname, '..', 'client')
const CLIENT_SRC = path.join(CLIENT_DIR, 'src')
const STORE_PATH = path.join(CLIENT_SRC, 'stores', 'maintenance.js')
const STORE_SRC = fs.readFileSync(STORE_PATH, 'utf8')
const USE_API_URL = pathToFileURL(path.join(CLIENT_SRC, 'composables', 'useApi.js')).href
// The files Node resolves the bare `vue` and `pinia` imports to (node + import
// conditions), so this runner, the store and Pinia share one instance of each.
const VUE_URL = pathToFileURL(path.join(CLIENT_DIR, 'node_modules', 'vue', 'index.mjs')).href
const PINIA_URL = pathToFileURL(path.join(CLIENT_DIR, 'node_modules', 'pinia', 'dist', 'pinia.mjs')).href

let pass = 0
let fail = 0
function report(ok, message) {
  if (ok) pass++
  else {
    fail++
    console.error(message)
  }
}

let pinia
let vue
try {
  pinia = await import(PINIA_URL)
  vue = await import(VUE_URL)
} catch (err) {
  report(false, `FAIL  cannot load Vue/Pinia from client/node_modules (${err.code || err.message}); \`npm ci\` at the repo root installs them`)
  console.log(`\nmaintenance-store: ${pass} passed, ${fail} failed`)
  process.exit(1)
}

// ── Browser storage, in memory ────────────────────────────────────────────────
class MemStorage {
  constructor() {
    this.m = new Map()
    this.broken = false // private mode / storage disabled: every call throws
    this.reads = 0
    this.writes = []
  }
  guard() {
    if (this.broken) throw Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' })
  }
  getItem(k) {
    this.guard()
    this.reads++
    return this.m.has(k) ? this.m.get(k) : null
  }
  setItem(k, v) {
    this.guard()
    this.writes.push(k)
    this.m.set(k, String(v))
  }
  removeItem(k) {
    this.guard()
    this.m.delete(k)
  }
}
const world = { session: new MemStorage(), local: new MemStorage(), config: null, requests: [] }
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => world.session })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => world.local })

// GET /api/config/maintenance answers world.config; null is "no network".
globalThis.fetch = (url) => {
  world.requests.push(String(url))
  if (world.config === null) return Promise.reject(new TypeError('Failed to fetch'))
  const body = world.config
  return Promise.resolve({ ok: true, status: 200, json: async () => body })
}

const CONFIG = Object.freeze({
  enabled: true,
  title: 'SYSTEM UPDATE IN PROGRESS',
  modalTitle: 'Application is currently under maintenance',
  message: 'The portal is being updated.',
  disclaimer: 'The final settlements are still being calculated.',
  audience: 'investor',
  version: '1',
})
const INV5 = { id: 5, username: 'ines', role: 'Investor' }
const INV9 = { id: 9, username: 'ivan', role: 'Investor' }
const keyFor = (version, id) => `logisx.maintenanceNotice.dismissed.v${version}.u${id}`

// ── Loading the store (committed, or a mutant) ────────────────────────────────
const asDataUrl = (text) => 'data:text/javascript;base64,' + Buffer.from(text, 'utf8').toString('base64')
// Stand-ins for the two stores the maintenance store reads. One URL each, so the
// store and this runner share one module instance of each.
const AUTH_STUB_URL = asDataUrl(`import { defineStore } from '${PINIA_URL}'
export const useAuthStore = defineStore('auth', {
  state: () => ({ user: null, isAuthenticated: false }),
  getters: {
    isInvestor: (s) => s.user?.role === 'Investor',
    isSuperAdmin: (s) => s.user?.role === 'Super Admin',
  },
})
`)
const INVESTOR_STUB_URL = asDataUrl(`import { defineStore } from '${PINIA_URL}'
export const useInvestorStore = defineStore('investor', { state: () => ({ isPreview: false }) })
`)
const { useAuthStore } = await import(AUTH_STUB_URL)

let loadSeq = 0
function storeUrl(src) {
  let missing = null
  const map = { pinia: PINIA_URL, vue: VUE_URL, '../composables/useApi': USE_API_URL, './auth': AUTH_STUB_URL, './investor': INVESTOR_STUB_URL }
  const out = src.replace(/(\bfrom\s+)(['"])([^'"]+)\2/g, (m, pre, q, spec) => {
    if (!(spec in map)) {
      missing = spec
      return m
    }
    return pre + q + map[spec] + q
  })
  if (missing) return null
  return (n) => asDataUrl(`${out}\n// load ${n}\n`)
}

// Waits out useApi's fetch and the store's own awaits.
const drain = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

// ── Scenarios: each gets a fresh Pinia, and the tab's sessionStorage as it left it
const SCENARIOS = [
  ['the config lands before the session: the popup waits for the person, then shows', async (c) => {
    const { m, auth } = await c.fresh()
    await m.fetchConfig()
    c.expect('nobody signed in yet: nothing shows', m.loaded && !m.showModal)
    c.signIn(auth, INV5)
    c.expect('the investor signs in, never having dismissed it: it shows', m.showModal)
    m.dismissModal()
    c.expect('dismissed: it closes', !m.showModal)
    c.expect("…and the dismissal is kept for THIS person, in sessionStorage", world.session.getItem(keyFor('1', 5)) === '1')
  }],
  ['a reload whose config beats the session: whoever dismissed it does not get it back', async (c) => {
    world.session.setItem(keyFor('1', 5), '1') // dismissed earlier in this tab
    const { m, auth } = await c.fresh()
    let everShown = false
    vue.watch(() => m.showModal, (v) => { if (v) everShown = true }, { flush: 'sync' })
    await m.fetchConfig() // App.vue's onMounted: before the router's session check has answered
    c.signIn(auth, INV5) // …which answers now
    c.expect('the popup never shows, not even for a moment', !everShown && !m.showModal && m.modalDismissed)
  }],
  ['the session lands before the config: the dismissal is read with the config', async (c) => {
    world.session.setItem(keyFor('1', 5), '1')
    const { m, auth } = await c.fresh()
    c.signIn(auth, INV5)
    await m.fetchConfig()
    c.expect('dismissed earlier: it stays closed', !m.showModal)
  }],
  ['two investors in one tab: each sees the popup once', async (c) => {
    const { m, auth } = await c.fresh()
    await m.fetchConfig()
    c.signIn(auth, INV5)
    m.dismissModal()
    c.expect('(before) the first investor dismissed it', !m.showModal)
    c.signOut(auth)
    c.signIn(auth, INV9)
    c.expect("the second investor sees it: the first one's dismissal is not theirs", m.showModal)
    m.dismissModal()
    c.signOut(auth)
    c.signIn(auth, INV5)
    c.expect('the first investor back in this tab: still dismissed for them', !m.showModal)
    c.expect('one key per person', world.session.getItem(keyFor('1', 5)) === '1' && world.session.getItem(keyFor('1', 9)) === '1')
  }],
  ['the fresh page after a sign-out: the next investor is not covered by the last one', async (c) => {
    world.session.setItem(keyFor('1', 5), '1') // left in the tab by the investor who signed out
    const { m, auth } = await c.fresh()
    await m.fetchConfig()
    c.signIn(auth, INV9)
    c.expect('it shows for the new person', m.showModal)
  }],
  ['a user with no id: nothing is read or saved for them', async (c) => {
    world.config = { ...CONFIG, audience: 'all' }
    world.session.setItem('logisx.maintenanceNotice.dismissed.v1.uundefined', '1')
    world.session.setItem('logisx.maintenanceNotice.dismissed.v1', '1') // the old tab-wide key
    world.session.writes = []
    const { m, auth } = await c.fresh()
    await m.fetchConfig()
    c.signIn(auth, { username: 'admin', role: 'Super Admin' }) // setup()'s own, id-less, user
    c.expect('not dismissed: it shows', m.showModal)
    m.dismissModal()
    c.expect('dismissing closes it for this page', !m.showModal)
    c.expect('…and saves nothing, since there is nobody to remember it for', world.session.writes.length === 0)
  }],
  ['a new notice version shows again to someone who dismissed the last one', async (c) => {
    world.session.setItem(keyFor('1', 5), '1')
    world.config = { ...CONFIG, version: '2' }
    const { m, auth } = await c.fresh()
    c.signIn(auth, INV5)
    await m.fetchConfig()
    c.expect('version 2: it shows', m.showModal)
  }],
  ['storage unavailable: the popup shows, and dismissing it does not throw', async (c) => {
    world.session.broken = true
    const { m, auth } = await c.fresh()
    await m.fetchConfig()
    c.signIn(auth, INV5)
    c.expect('shown rather than hidden', m.showModal)
    let threw = false
    try {
      m.dismissModal()
    } catch {
      threw = true
    }
    c.expect('dismissing works in memory', !threw && !m.showModal)
  }],
  ['a failed config fetch invents no notice', async (c) => {
    world.config = null
    const { m, auth } = await c.fresh()
    c.signIn(auth, INV5)
    await m.fetchConfig()
    c.expect('nothing shows', m.loaded && !m.enabled && !m.showModal)
  }],
]

async function runScenarios(source) {
  const results = []
  for (const [name, run] of SCENARIOS) {
    world.session = new MemStorage()
    world.local = new MemStorage()
    world.config = { ...CONFIG }
    world.requests = []
    const expect = (label, cond) => results.push({ ok: !!cond, label: `${name}: ${label}` })
    const c = {
      expect,
      fresh: async () => {
        const p = pinia.createPinia()
        pinia.setActivePinia(p)
        const mod = await import(source(++loadSeq))
        return { m: mod.useMaintenanceStore(p), auth: useAuthStore(p) }
      },
      signIn: (auth, user) => {
        auth.user = user
        auth.isAuthenticated = true
      },
      signOut: (auth) => {
        auth.user = null
        auth.isAuthenticated = false
      },
    }
    try {
      await run(c)
      await drain()
    } catch (err) {
      results.push({ ok: false, label: `${name}: threw ${err && err.stack}` })
    }
    // The house rule for convenience state: tab-scoped. localStorage is never touched.
    results.push({ ok: world.local.reads === 0 && world.local.writes.length === 0, label: `${name}: localStorage is never read or written` })
  }
  return results
}

// ── 1. The committed store ────────────────────────────────────────────────────
const committed = storeUrl(STORE_SRC)
if (!committed) {
  report(false, 'FAIL  stores/maintenance.js imports something this runner does not provide')
} else {
  for (const r of await runScenarios(committed)) report(r.ok, `FAIL  ${r.label}`)
}

// ── 2. Mutants: each must fail at least one scenario ──────────────────────────
function replaceOnce(src, from, to) {
  return src.split(from).length === 2 ? src.replace(from, () => to) : null
}
const MUTANTS = [
  ['the pre-2026-09-26 key: one dismissal per tab, whoever is signed in',
    (s) => replaceOnce(s, 'dismissed.v${version}.u${userId}', 'dismissed.v${version}')],
  ['the dismissal read only when the config lands, never when the person changes',
    (s) => replaceOnce(s, '      this._followUser()\n', '')],
  ['a user with no id counts as having dismissed it',
    (s) => replaceOnce(s, '  if (!hasUserId(userId)) return false\n', '  if (!hasUserId(userId)) return true\n')],
  ['kept in localStorage instead of sessionStorage',
    (s) => (s.includes('sessionStorage.') ? s.split('sessionStorage.').join('localStorage.') : null)],
]
if (committed) {
  for (const [name, mutate] of MUTANTS) {
    const mutated = mutate(STORE_SRC)
    const source = mutated && mutated !== STORE_SRC ? storeUrl(mutated) : null
    if (!source) {
      report(false, `FAIL  mutant could not be built: ${name}\n        its target text is gone from stores/maintenance.js; update the mutant with the store`)
      continue
    }
    const results = await runScenarios(source)
    report(results.some((r) => !r.ok), `FAIL  mutant survived: ${name}\n        no scenario noticed it`)
  }
}

console.log(`\nmaintenance-store: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
