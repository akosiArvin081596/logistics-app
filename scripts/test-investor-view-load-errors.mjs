#!/usr/bin/env node
// The investor view says when its data could not be loaded (2026-10-04).
//
// WHY THIS EXISTS. Two things on /investor read as facts they were not:
//   • When GET /api/trucks failed, InvestorView swallowed the error and left the
//     truck list empty, so My Trucks said "No trucks added yet." and the Fleet
//     Breakdown "No trucks in database yet." about a fleet that has trucks.
//   • A Super Admin on /investor with no investor in view always fetched
//     GET /api/investor/payouts, which answers 400 (payouts are per investor), so
//     every such page load logged a failed request and the Payouts section said
//     "Couldn't load payouts — try again." about a request that cannot succeed.
//
//   §1 the investor store: a Super Admin with no investor in view asks for no
//      payouts and is marked payoutsNoOwner; previewing an investor, or signed
//      in as one, still asks, scoped as before
//   §2 InvestorView's loadData(): a failed /api/trucks leaves its reason in
//      trucksError (a sentence), and a later success clears it
//   §3 MyTrucks and FleetBreakdownSection, rendered with Vue's server renderer:
//      the reason replaces the empty state; with no error, the empty state is
//      unchanged
//   §4 PayoutsSection and LoadReportsSection read payoutsNoOwner
//
// No DOM, no server; Vue and Pinia come from client/node_modules.
//   node scripts/test-investor-view-load-errors.mjs
//   LOGISX_ROOT=/tmp/base node scripts/test-investor-view-load-errors.mjs   # a base checkout: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')
const CLIENT_DIR = path.join(ROOT, 'client')
const CLIENT_SRC = path.join(CLIENT_DIR, 'src')

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
const { renderToString } = clientRequire('vue/server-renderer')
const VUE_URL = pathToFileURL(path.join(CLIENT_DIR, 'node_modules', 'vue', 'index.mjs')).href
const PINIA_URL = pathToFileURL(path.join(CLIENT_DIR, 'node_modules', 'pinia', 'dist', 'pinia.mjs')).href
const pinia = await import(PINIA_URL)
const asDataUrl = (text) => 'data:text/javascript;base64,' + Buffer.from(text, 'utf8').toString('base64')

// ══ §1 — the investor store ══════════════════════════════════════════════════
// The committed store, with the real useApi (fetch scripted) and a stand-in auth
// store: the investor store reads only `user` from it.
const requests = []
globalThis.fetch = (url) => {
  const u = String(url)
  requests.push(u)
  // The route's own rule: a Super Admin not previewing anyone is a 400.
  const status = /\/api\/investor\/payouts$/.test(u) && world.role === 'Super Admin' ? 400 : 200
  const body = status === 400
    ? { error: 'Pass ?as_user_id=<investorUserId> to view an investor\'s payouts.' }
    : { payouts: [{ id: 1, period: '2026-08' }], currentMonth: null, totals: {} }
  return Promise.resolve({ ok: status < 400, status, json: async () => body, headers: { get: () => 'application/json' } })
}
const world = { role: 'Investor' }
const AUTH_STUB_URL = asDataUrl(`import { defineStore } from '${PINIA_URL}'
export const useAuthStore = defineStore('auth', { state: () => ({ user: null }) })
`)
const { useAuthStore } = await import(AUTH_STUB_URL)
const USE_API_URL = pathToFileURL(path.join(CLIENT_SRC, 'composables', 'useApi.js')).href
let storeSrc = read('client', 'src', 'stores', 'investor.js')
const map = { pinia: PINIA_URL, vue: VUE_URL, '../composables/useApi': USE_API_URL, './auth': AUTH_STUB_URL }
let unmapped = null
storeSrc = storeSrc.replace(/(\bfrom\s+)(['"])([^'"]+)\2/g, (m, pre, q, spec) => {
  if (!(spec in map)) { unmapped = spec; return m }
  return pre + q + map[spec] + q
})
if (unmapped) {
  ok(`§1 the investor store imports only what this runner maps (found ${unmapped})`, false)
} else {
  const { useInvestorStore } = await import(asDataUrl(storeSrc))
  const drain = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }
  async function scenario(role, previewUserId) {
    pinia.setActivePinia(pinia.createPinia())
    world.role = role
    useAuthStore().user = { id: 1, role }
    const s = useInvestorStore()
    if (previewUserId != null) s.previewUserId = previewUserId
    requests.length = 0
    await s.loadPayouts()
    await drain()
    return { s, asked: requests.filter((u) => u.includes('/api/investor/payouts')) }
  }

  {
    const { s, asked } = await scenario('Super Admin', null)
    ok('§1 a Super Admin with no investor in view asks for no payouts (the route answers 400 there)', asked.length === 0)
    ok('§1 …and is marked payoutsNoOwner', s.payoutsNoOwner === true)
    ok('§1 …which is not a failure', s.payoutsFailed === false && s.payoutsNotFound === false)
    ok('§1 …and is not left loading', s.payoutsLoading === false)
    ok('§1 …with the empty ledger in place', Array.isArray(s.payouts) && s.payouts.length === 0 && s.currentMonth === null)
    s.resetPayouts()
    ok('§1 resetPayouts() (a preview switch) clears payoutsNoOwner', s.payoutsNoOwner === false)
  }
  {
    const { s, asked } = await scenario('Super Admin', 7)
    ok('§1 a Super Admin previewing investor 7 still asks, scoped to them', asked.length === 1 && asked[0].endsWith('/api/investor/payouts?as_user_id=7'))
    ok('§1 …and gets the ledger', s.payoutsNoOwner === false && s.payoutsFailed === false && s.payouts.length === 1)
  }
  {
    const { s, asked } = await scenario('Investor', null)
    ok('§1 an investor still asks for their own payouts', asked.length === 1 && asked[0].endsWith('/api/investor/payouts'))
    ok('§1 …and gets the ledger', s.payoutsNoOwner === false && s.payouts.length === 1)
  }
  {
    // /my-payouts renders PayoutsSection with an explicit scope.
    pinia.setActivePinia(pinia.createPinia())
    world.role = 'Super Admin'
    useAuthStore().user = { id: 1, role: 'Super Admin' }
    const s = useInvestorStore()
    requests.length = 0
    await s.loadPayouts(9)
    await drain()
    ok('§1 an explicit scope from the caller is honoured for a Super Admin', requests.some((u) => u.endsWith('/api/investor/payouts?as_user_id=9')) && s.payoutsNoOwner === false)
  }
}

// ══ §2 — InvestorView's loadData() ═══════════════════════════════════════════
// Lifted from the committed <script setup> into a bare function with its I/O
// injected, so the shipped code is what runs.
{
  const src = read('client', 'src', 'views', 'InvestorView.vue')
  const m = /async function loadData\(\) \{[\s\S]*?\n\}\n/.exec(src)
  ok('§2 InvestorView.vue still has loadData()', !!m)
  if (m) {
    const trucks = Vue.ref([{ id: 'old' }])
    const trucksError = Vue.ref('')
    let trucksAnswer
    const api = { get: async (url) => { if (url.startsWith('/api/trucks')) return trucksAnswer(); return {} } }
    const store = { load: async () => {}, loadPayouts() {}, isPreview: false, previewUserId: null }
    const toasts = []
    const loadData = new Function('store', 'api', 'trucks', 'trucksError', 'toast', `${m[0]}\nreturn loadData`)(
      store, api, trucks, trucksError, (msg) => toasts.push(msg))
    trucksAnswer = async () => { throw Object.assign(new Error('Gateway timeout'), { status: 504 }) }
    await loadData()
    ok('§2 a failed /api/trucks leaves its reason in trucksError, as a sentence', trucksError.value === 'Gateway timeout.')
    ok('§2 …and no stale trucks behind it', Array.isArray(trucks.value) && trucks.value.length === 0)
    ok('§2 …and does not raise the whole-page toast', toasts.length === 0)
    trucksAnswer = async () => { throw Object.assign(new Error('Request timed out.'), { code: 'TIMEOUT' }) }
    await loadData()
    ok('§2 a reason that is already a sentence is kept as it is', trucksError.value === 'Request timed out.')
    trucksAnswer = async () => { throw new Error('') }
    await loadData()
    ok('§2 a failure with no message still says something', trucksError.value === 'The server did not answer.')
    trucksAnswer = async () => ({ trucks: [{ id: 1 }] })
    await loadData()
    ok('§2 the next successful load clears the error and fills the list', trucksError.value === '' && trucks.value.length === 1)
    ok('§2 InvestorView hands trucksError to both truck tables',
      /<MyTrucks [^>]*:trucks-error="trucksError"/.test(src) && /<FleetBreakdownSection [^>]*:trucks-error="trucksError"/.test(src))
  }
}

// ══ §3 — the two truck tables, rendered ══════════════════════════════════════
// Each component's own <script setup> and <template>, compiled with the client's
// compiler and rendered with Vue's server renderer. Child components are stubs;
// the investor store, useApi and useToast are stand-ins (nothing is fetched).
async function compileComponent(rel, overrides = {}) {
  const file = path.join(ROOT, rel)
  const dir = path.dirname(file)
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), { filename: path.basename(file) })
  let body = compileScript(descriptor, { id: path.basename(file), inlineTemplate: true }).content
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
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${rel}: an import/export this harness cannot map`)
  const stub = (name) => Vue.defineComponent({ name, inheritAttrs: false, setup: () => () => Vue.h('div', { 'data-stub': name }) })
  const deps = { vue: { ...Vue, onMounted() {} } }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec in overrides) deps[spec] = overrides[spec]
    else if (spec.endsWith('.vue')) deps[spec] = { default: stub(path.basename(spec, '.vue')) }
    else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', body)(deps)
}
const text = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()
const IO_STUBS = {
  '../../composables/useApi': { useApi: () => ({ get: async () => ({}), post: async () => ({}), put: async () => ({}) }) },
  '../../composables/useToast': { useToast: () => ({ show() {} }) },
  '../../stores/investor': { useInvestorStore: () => ({ isPreview: false, previewUserId: null, previewQuery: '' }) },
}
for (const [rel, empty] of [
  ['client/src/components/investor/MyTrucks.vue', 'No trucks added yet.'],
  ['client/src/components/investor/FleetBreakdownSection.vue', 'No trucks in database yet.'],
]) {
  const name = path.basename(rel)
  let Comp
  try { Comp = await compileComponent(rel, IO_STUBS) } catch (err) { ok(`§3 ${name} compiles in this harness (${err.message})`, false); continue }
  const failed = text(await renderToString(Vue.createSSRApp(Comp, { trucks: [], trucksError: 'Gateway timeout.', production: {}, asset: {} })))
  ok(`§3 ${name}: a failed load shows its reason`, failed.includes("Couldn't load your trucks: Gateway timeout. Refresh the page to try again."))
  ok(`§3 ${name}: …instead of "${empty}"`, !failed.includes(empty))
  const none = text(await renderToString(Vue.createSSRApp(Comp, { trucks: [], production: {}, asset: {} })))
  ok(`§3 ${name}: with no error, an empty list still reads "${empty}"`, none.includes(empty) && !none.includes("Couldn't load"))
}

// ══ §4 — the payout surfaces read payoutsNoOwner ═════════════════════════════
{
  const ps = read('client', 'src', 'components', 'investor', 'PayoutsSection.vue')
  const noOwnerAt = ps.indexOf('v-else-if="noOwner"')
  ok('§4 PayoutsSection says payouts are per investor, ahead of its load-failure copy',
    noOwnerAt > 0 && noOwnerAt < ps.indexOf('v-else-if="loadFailed"') &&
    /const noOwner = computed\(\(\) => investorStore\.payoutsNoOwner\)/.test(ps))
  const lr = read('client', 'src', 'components', 'investor', 'LoadReportsSection.vue')
  ok('§4 Load Reports falls back to "Earned to date" when no ledger was asked for',
    /const ledgerFailed = computed\(\(\) => investorStore\.payoutsFailed \|\| investorStore\.payoutsNoOwner\)/.test(lr))
}

console.log(`\ninvestor-view-load-errors: ${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
