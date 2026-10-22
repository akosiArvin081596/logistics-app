#!/usr/bin/env node
// The Super Admin "Deleted loads" page (list only) and its "Deleted loads (N)"
// link on Active Loads: display only. GET /api/admin/deleted-loads sends every
// figure; its role gate is the real control (scripts/test-deleted-loads-route.js).
//
//   §1 client/src/lib/deletedLoadsView.js: who may see the link and page, the
//      link text (N, or no number while unknown), the route line, the month lines
//      with closed Yes/No, the "from the delete record" note, the error line.
//   §2 the link by role, rendered: a Super Admin gets "Deleted loads" pointing at
//      the page and asks the route for N; a Dispatcher, Driver or Investor gets
//      nothing and asks nothing.
//   §3 wiring, from source: the page's route is Super Admin only, Active Loads
//      shows the link only to a Super Admin, the page reads the route, and
//      neither the page nor the link sends anything but a GET (no restore here).
//
// Made-up values only. No DOM, no server. Vue comes from this checkout's
// client/node_modules; the files under test come from LOGISX_ROOT (default: this
// checkout).
//   node scripts/test-deleted-loads-view.mjs
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HERE = path.join(__dirname, '..')
const ROOT = process.env.LOGISX_ROOT || HERE
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p))
const read = (...p) => (exists(...p) ? fs.readFileSync(path.join(ROOT, ...p), 'utf8') : '')
const CLIENT_DIR = path.join(HERE, 'client')

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}
function eq(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  ok(`${name}${g === w ? '' : `  (got ${g}, want ${w})`}`, g === w)
}

const clientRequire = createRequire(path.join(CLIENT_DIR, 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const { renderToString } = clientRequire('vue/server-renderer')

// Rendered HTML to its visible text: comments dropped, tags as spaces, the two
// entities the renderer emits here decoded, whitespace collapsed. A scan, not a
// regex replace (the same walk as scripts/test-fix-age-tracking.mjs).
function text(html) {
  const s = String(html)
  let out = ''
  let i = 0
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt === -1) { out += s.slice(i); break }
    out += s.slice(i, lt)
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4)
      i = end === -1 ? s.length : end + 3
    } else {
      const end = s.indexOf('>', lt + 1)
      out += ' '
      i = end === -1 ? s.length : end + 1
    }
  }
  return out.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

// Compile a committed SFC's <script setup> + <template> into a component.
// Imports resolve from `overrides` first; a relative .js import loads from ROOT.
async function compileComponent(rel, overrides = {}) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) throw new Error(`${rel} does not exist`)
  const dir = path.dirname(file)
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), { filename: path.basename(file) })
  let body = compileScript(descriptor, { id: path.basename(file), inlineTemplate: true }).content
  const specs = []
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, names, q, spec) => {
    specs.push(spec)
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '))
    return `const { ${binds.join(', ')} } = __deps[${JSON.stringify(spec)}];`
  })
  body = body.replace(/^export default\s*/m, 'return ')
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${rel}: an import/export this harness cannot map`)
  const deps = { vue: Vue }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec in overrides) deps[spec] = overrides[spec]
    else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', body)(deps)
}

// ------------------------------------------------------------------ §1 lib
let lib = null
try {
  lib = exists('client', 'src', 'lib', 'deletedLoadsView.js')
    ? await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'deletedLoadsView.js')).href)
    : null
} catch { lib = null }
ok('§1 client/src/lib/deletedLoadsView.js exists and loads', !!lib)

if (lib) {
  eq('§1 only a Super Admin may see the link and page',
    ['Super Admin', 'Dispatcher', 'Driver', 'Investor', '', undefined, 'super admin'].map(lib.canSeeDeletedLoads),
    [true, false, false, false, false, false, false])
  eq('§1 the link names N, including 0', [3, 0].map(lib.deletedLoadsLinkText), ['Deleted loads (3)', 'Deleted loads (0)'])
  eq('§1 no number while N is unknown or not a count', [null, undefined, -1, 2.5, '3'].map(lib.deletedLoadsLinkText),
    ['Deleted loads', 'Deleted loads', 'Deleted loads', 'Deleted loads', 'Deleted loads'])
  eq('§1 the route line, one side missing, none known', [
    { pickup: 'Springfield, IL 62701', dropoff: 'Riverton, WY 82501' },
    { pickup: 'Springfield, IL 62701', dropoff: '' },
    { pickup: '', dropoff: '' },
    null,
  ].map(lib.deletedLoadRoute), ['Springfield, IL 62701 → Riverton, WY 82501', 'Springfield, IL 62701 → —', '—', '—'])
  eq('§1 one line per month, closed as the server says', lib.deletedLoadMonths({ months: [{ month: '2026-05', closed: true }, { month: '2026-06', closed: false }] }), [
    { key: '2026-05', label: 'May 2026', closed: true, closedText: 'Yes' },
    { key: '2026-06', label: 'June 2026', closed: false, closedText: 'No' },
  ])
  eq('§1 a closed flag that is not exactly true reads No', lib.deletedLoadMonths({ months: [{ month: '2026-05', closed: 'true' }] }).map((m) => m.closedText), ['No'])
  eq('§1 no months, no lines', [lib.deletedLoadMonths({ months: [] }), lib.deletedLoadMonths({})], [[], []])
  eq('§1 the note says when months come from the delete record', ['audit', 'sheet', 'none'].map((f) => lib.deletedLoadMonthsNote({ monthsFrom: f })),
    ['From the delete record', '', ''])
  const sheetErr = Object.assign(new Error('Job Tracking could not be read (made-up).'), { status: 503, code: 'SHEET_UNREADABLE' })
  const lockErr = Object.assign(new Error('The month-end lock table could not be read (made-up).'), { status: 503, code: 'PERIOD_LOCK_UNREADABLE' })
  eq('§1 the error line: the server\'s words for an unreadable sheet or lock table, else a fallback', [
    lib.deletedLoadsErrorText(sheetErr),
    lib.deletedLoadsErrorText(lockErr),
    lib.deletedLoadsErrorText(Object.assign(new Error('Forbidden'), { status: 403 })),
    lib.deletedLoadsErrorText(Object.assign(new Error('boom'), { status: 500 })),
  ], [
    'Job Tracking could not be read (made-up).',
    'The month-end lock table could not be read (made-up).',
    'Only a Super Admin can see deleted loads.',
    'The deleted loads could not be loaded. Try again in a moment.',
  ])
}

// ------------------------------------------------------------- §2 the link
const LINK = 'client/src/components/dashboard/DeletedLoadsLink.vue'
const RouterLinkStub = Vue.defineComponent({
  name: 'RouterLink',
  props: { to: { type: [String, Object], default: null } },
  setup(props, { slots }) {
    return () => Vue.h('a', { 'data-to': JSON.stringify(props.to) }, slots.default ? slots.default() : [])
  },
})
async function renderLink(role) {
  const calls = []
  const Comp = await compileComponent(LINK, {
    '../../composables/useApi': { useApi: () => ({ get: async (url) => { calls.push(url); return { loads: [], count: 3 } } }) },
    '../../composables/useSocketRefresh': { useSocketRefresh: () => {} },
    '../../stores/auth': { useAuthStore: () => ({ user: role ? { role } : null, isSuperAdmin: role === 'Super Admin' }) },
  })
  const app = Vue.createSSRApp(Comp)
  app.component('RouterLink', RouterLinkStub)
  const html = await renderToString(app)
  await new Promise((r) => setImmediate(r))
  return { html, txt: text(html), calls }
}
let linkOk = false
try { linkOk = !!(await compileComponent(LINK, {
  '../../composables/useApi': { useApi: () => ({}) },
  '../../composables/useSocketRefresh': { useSocketRefresh: () => {} },
  '../../stores/auth': { useAuthStore: () => ({ user: null }) },
})) } catch { linkOk = false }
ok(`§2 ${LINK} exists and compiles`, linkOk)
if (linkOk) {
  const sa = await renderLink('Super Admin')
  ok('§2 Super Admin: the link renders, reading "Deleted loads" until N arrives', sa.txt === 'Deleted loads')
  ok('§2 Super Admin: the link points at the Deleted loads page', /data-to="[^"]*&quot;admin-deleted-loads&quot;/.test(sa.html))
  eq('§2 Super Admin: N is asked of the route', sa.calls, ['/api/admin/deleted-loads'])
  for (const role of ['Dispatcher', 'Driver', 'Investor', null]) {
    const r = await renderLink(role)
    ok(`§2 ${role || 'no user'}: no link rendered`, r.txt === '' && !/<a\b/.test(r.html))
    eq(`§2 ${role || 'no user'}: the route is never asked`, r.calls, [])
  }
}

// ------------------------------------------------------------ §3 wiring
const ROUTER = read('client', 'src', 'router', 'index.js')
const routeBlock = (ROUTER.match(/\{\s*(?:\/\/[^\n]*\n\s*)*path: '\/admin\/deleted-loads',[\s\S]*?\n {2}\}/) || [''])[0]
ok('§3 the page has a route, /admin/deleted-loads, named admin-deleted-loads', /name: 'admin-deleted-loads'/.test(routeBlock) && /DeletedLoadsView\.vue/.test(routeBlock))
ok('§3 the page\'s route is Super Admin only', /meta: \{ roles: \['Super Admin'\] \}/.test(routeBlock))

const ACTIVE = read('client', 'src', 'components', 'dashboard', 'ActiveLoadsTab.vue')
const linkTags = ACTIVE.match(/<DeletedLoadsLink\b[^>]*>/g) || []
eq('§3 Active Loads shows the link once, only to a Super Admin', linkTags, ['<DeletedLoadsLink v-if="auth.isSuperAdmin" />'])

const LINK_SRC = read(...LINK.split('/'))
ok('§3 the link renders only when canSeeDeletedLoads() says so, and asks nothing otherwise',
  /<router-link v-if="visible"/.test(LINK_SRC) && /const visible = computed\(\(\) => canSeeDeletedLoads\(auth\.user\?\.role\)\)/.test(LINK_SRC) && /if \(!visible\.value\) return/.test(LINK_SRC))

const VIEW = read('client', 'src', 'views', 'DeletedLoadsView.vue')
ok('§3 the page reads GET /api/admin/deleted-loads', /api\.get\('\/api\/admin\/deleted-loads'\)/.test(VIEW))
ok('§3 the page shows every column: Load ID, Route, Driver, Date deleted, Deleted by, Month, Closed',
  ['Load ID', 'Route', 'Driver', 'Date deleted', 'Deleted by', 'Month', 'Closed'].every((h) => VIEW.includes(`<TableHead>${h}</TableHead>`)))
ok('§3 list only: neither the page nor the link sends anything but a GET',
  !/api\.(post|put|patch|del)\(/.test(VIEW) && !/api\.(post|put|patch|del)\(/.test(LINK_SRC) && !/fetch\(/.test(VIEW + LINK_SRC))
ok('§3 the page has a phone layout (cards below md)', /v-else-if="isMobile"/.test(VIEW) && /useViewport\(\)/.test(VIEW))
// Review L1 (#568): two deletes of one load in the same second share load ID,
// time and row index; only the deleted_loads id the route sends tells them apart.
const rowLoops = VIEW.match(/v-for="l in loads" :key="[^"]*"/g) || []
eq('§3 the table rows and the phone cards are keyed on the deleted_loads id', rowLoops,
  ['v-for="l in loads" :key="l.id"', 'v-for="l in loads" :key="l.id"'])

if (failures.length) {
  console.error(`\n${pass} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`\n${pass} passed, 0 failed`)
process.exit(0)
