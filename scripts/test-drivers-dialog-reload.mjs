#!/usr/bin/env node
// A list reload must not close a dialog that is open over the list.
//
// WHY THIS EXISTS. The Drivers page (DriversDbView.vue) and the Users page
// (UsersView.vue) swap their table for a skeleton while the store's isLoading
// is true. The table component owns the Edit dialog (and on the Drivers page
// the detail drawer and the time-off panel), so a reload that set isLoading
// unmounted them: approving a day off in the panel, a new profile picture, or
// any other admin's write announced over the socket closed the open dialog and
// dropped what was typed in it. Those reloads are now quiet: the list is
// replaced under the open dialog and isLoading is left alone. The first load
// still shows the skeleton.
//
//   §1 the driversDb store, driven: a plain load() sets isLoading while it
//      waits; a quiet one never touches it and still replaces the list, even
//      when it answers in the middle of a plain load or fails
//   §2 DriversDbView.vue: the first load is plain; every other reload the
//      view starts (the time-off panel, the profile picture, drivers:changed)
//      is quiet
//   §3 the users store, driven the same way
//   §4 UsersView.vue: the first load is plain; the users:changed reload is quiet
//
// The stores are run from their own source with their two imports (pinia's
// defineStore, useApi) replaced by stubs, on made-up replies. No DOM, no
// server. Files under test come from LOGISX_ROOT (default: this checkout).
//   node scripts/test-drivers-dialog-reload.mjs     # exits 1 on any failure
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = process.env.LOGISX_ROOT || HERE
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8') } catch { return null } }

const DRIVERS_STORE = 'client/src/stores/driversDb.js'
const DRIVERS_VIEW = 'client/src/views/DriversDbView.vue'
const DRIVER_TABLE = 'client/src/components/drivers-db/DriverTable.vue'
const USERS_STORE = 'client/src/stores/users.js'
const USERS_VIEW = 'client/src/views/UsersView.vue'

let pass = 0
let fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.error(`FAIL  ${label}`) }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else { fail++; console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`) }
}

// The network: every api.get waits until the test answers it.
const pending = []
const fakeApi = {
  get(url) {
    return new Promise((resolve, reject) => pending.push({ url, resolve, reject }))
  },
}
const tick = () => new Promise((r) => setImmediate(r))

// The store's definition, run from its source: defineStore hands back the
// options object, and an instance is its state with its actions bound to it.
async function storeFromSource(rel) {
  const src = read(rel)
  if (src === null) return null
  const PINIA = "import { defineStore } from 'pinia'"
  const API = "import { useApi } from '../composables/useApi'"
  if (!src.includes(PINIA) || !src.includes(API)) return null
  const stubbed = src
    .replace(PINIA, 'const defineStore = (id, def) => def')
    .replace(API, 'const useApi = () => globalThis.__dialogReloadApi')
  globalThis.__dialogReloadApi = fakeApi
  const mod = await import(`data:text/javascript,${encodeURIComponent(stubbed)}`)
  const def = Object.values(mod).find((v) => v && typeof v.state === 'function' && v.actions)
  if (!def) return null
  return () => {
    const s = def.state()
    for (const [name, fn] of Object.entries(def.actions)) s[name] = fn.bind(s)
    return s
  }
}

// The part of a view's script outside its onMounted block.
function withoutOnMounted(src) {
  const at = src.indexOf('onMounted(')
  if (at < 0) return src
  const end = src.indexOf('\n})', at)
  return end < 0 ? src : src.slice(0, at) + src.slice(end + 3)
}
function onMountedBody(src) {
  const at = src.indexOf('onMounted(')
  if (at < 0) return ''
  const end = src.indexOf('\n})', at)
  return end < 0 ? '' : src.slice(at, end)
}

// Runs one store's load action through the scenarios: `load` is the action's
// name, `reply(n)` a made-up answer, `shown(state)` the names on screen and
// `sent(reply)` the names in an answer.
async function drive(label, make, { load, reply, shown, sent }) {
  pending.length = 0

  // A plain load: the skeleton while it waits, the list once answered.
  {
    const s = make()
    const p = s[load]()
    await tick()
    eq(`${label} a plain ${load}() sets isLoading while it waits`, s.isLoading, true)
    pending.shift().resolve(reply(1))
    await p
    eq(`${label} ...and clears it once answered`, s.isLoading, false)
    eq(`${label} ...with the new list`, shown(s), sent(reply(1)))
  }

  // A quiet load: the table stays mounted, the list is still replaced.
  {
    const s = make()
    const p = s[load]({ quiet: true })
    await tick()
    eq(`${label} a quiet ${load}() leaves isLoading false while it waits`, s.isLoading, false)
    pending.shift().resolve(reply(2))
    await p
    eq(`${label} ...and after it is answered`, s.isLoading, false)
    eq(`${label} ...and still replaces the list`, shown(s), sent(reply(2)))
  }

  // A quiet load that answers in the middle of a plain one (the first load
  // and a socket refresh at once) does not end the plain one's skeleton.
  {
    const s = make()
    const first = s[load]()
    const quiet = s[load]({ quiet: true })
    await tick()
    const [a, b] = [pending.shift(), pending.shift()]
    b.resolve(reply(3))
    await quiet
    eq(`${label} a quiet answer during a plain ${load}() leaves its skeleton up`, s.isLoading, true)
    a.resolve(reply(3))
    await first
    eq(`${label} ...until the plain one is answered`, s.isLoading, false)
  }

  // A failed quiet load keeps the list on screen and isLoading untouched.
  {
    const s = make()
    const seed = s[load]({ quiet: true })
    await tick()
    pending.shift().resolve(reply(4))
    await seed
    const p = s[load]({ quiet: true })
    await tick()
    eq(`${label} a quiet ${load}() that fails never set isLoading`, s.isLoading, false)
    pending.shift().reject(Object.assign(new Error('Request timed out'), { status: 0 }))
    let rejected = false
    try { await p } catch { rejected = true }
    eq(`${label} ...rejects as before`, rejected, true)
    eq(`${label} ...leaves isLoading false and the list as it was`,
      [s.isLoading, shown(s)], [false, sent(reply(4))])
  }
}

// ══ §1 the driversDb store ═══════════════════════════════════════════════════
{
  const make = await storeFromSource(DRIVERS_STORE)
  ok(`§1 ${DRIVERS_STORE} loads with its two imports stubbed`, !!make)
  if (make) {
    const reply = (n) => ({
      headers: ['Driver', 'State'],
      data: [
        { _rowIndex: 2, Driver: `Sample Driver ${n}A`, State: 'TX', Status: 'active' },
        { _rowIndex: 3, Driver: `Sample Driver ${n}B`, State: 'OK', Status: 'pending' },
      ],
      dailyRateRule: null,
    })
    await drive('§1 driversDb:', make, {
      load: 'load', reply, shown: (s) => s.drivers.map((d) => d.Driver), sent: (r) => r.data.map((d) => d.Driver),
    })
  }
}

// ══ §2 DriversDbView.vue ═════════════════════════════════════════════════════
{
  const view = read(DRIVERS_VIEW) || ''
  const table = read(DRIVER_TABLE) || ''
  ok('§2 DriverTable owns the Edit dialog and the time-off panel (so unmounting it closes them)',
    /v-if="showEdit"/.test(table) && /<DriverAvailabilityPanel\b/.test(table) && /@changed="emit\('availability-changed'\)"/.test(table))
  ok('§2 the view still shows the skeleton on store.isLoading, in place of DriverTable',
    /<template v-if="store\.isLoading">\s*<SkeletonLoader\b/.test(view) && view.indexOf('<DriverTable') > view.indexOf('<template v-else>'))
  ok('§2 the first load (onMounted) is plain, so it shows the skeleton',
    /store\.load\(\)/.test(onMountedBody(view)))
  ok('§2 the time-off panel\'s change reloads quietly',
    /@availability-changed="store\.load\(\{ quiet: true \}\)"/.test(view))
  ok('§2 a new profile picture reloads quietly',
    /@picture-updated="store\.load\(\{ quiet: true \}\)"/.test(view))
  ok('§2 drivers:changed reloads quietly',
    /useSocketRefresh\('drivers:changed', \(\) => store\.load\(\{ quiet: true \}\)\)/.test(view))
  const others = withoutOnMounted(view).match(/store\.load\([^)]*\)/g) || []
  eq('§2 every reload the view starts outside onMounted is quiet',
    others.filter((c) => c !== 'store.load({ quiet: true })'), [])
}

// ══ §3 the users store ═══════════════════════════════════════════════════════
{
  const make = await storeFromSource(USERS_STORE)
  ok(`§3 ${USERS_STORE} loads with its two imports stubbed`, !!make)
  if (make) {
    const reply = (n) => ({
      users: [
        { id: 10 + n, Username: `sample.user${n}`, Role: 'Dispatcher' },
        { id: 20 + n, Username: `sample.driver${n}`, Role: 'Driver' },
      ],
      newStaffMustChangePassword: false,
    })
    await drive('§3 users:', make, {
      load: 'loadUsers', reply, shown: (s) => s.users.map((u) => u.Username), sent: (r) => r.users.map((u) => u.Username),
    })
  }
}

// ══ §4 UsersView.vue ═════════════════════════════════════════════════════════
{
  const view = read(USERS_VIEW) || ''
  ok('§4 the view still shows the skeleton on store.isLoading, in place of UserTable',
    /<template v-if="store\.isLoading">\s*<SkeletonLoader\b/.test(view) && view.indexOf('<UserTable') > view.indexOf('<template v-else>'))
  ok('§4 the first load (onMounted) is plain, so it shows the skeleton',
    /store\.loadUsers\(\)/.test(onMountedBody(view)))
  ok('§4 users:changed reloads quietly, so another admin\'s write leaves an open Edit User dialog open',
    /useSocketRefresh\('users:changed', \(\) => store\.loadUsers\(\{ quiet: true \}\)\)/.test(view))
}

console.log(`\ntest-drivers-dialog-reload: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
