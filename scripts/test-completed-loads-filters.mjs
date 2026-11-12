#!/usr/bin/env node
// Completed Loads' Needs Review and Needs attention toggles: display only.
//
//   §1 client/src/lib/completedLoadsFilters.js: a press turns the other toggle
//      off; every empty-list line, word for word.
//   §2 the tab mounted as a Super Admin, for each toggle (none, Needs Review,
//      Needs attention) and filter mix (none, a driver, dates, both): each
//      button's count is taken over the driver and date filters' rows, and a
//      pressed toggle's count is the rows the list shows.
//   §3 one toggle on at a time, whatever order they are pressed in.
//   §4 both toggles show "on" the same way: the same classes, a filled style,
//      aria-pressed.
//   §5 a toggle stays on screen while it is on, even at (0), and the empty line
//      names what is on; a Dispatcher gets Needs Review over every load.
//   §6 mutants on the changed lines, each caught.
//
// Made-up rows only. No DOM, no server. Vue comes from this checkout's
// client/node_modules; the files under test from LOGISX_ROOT (default: this
// checkout).
//   node scripts/test-completed-loads-filters.mjs
//   LOGISX_ROOT=/path/to/base node scripts/test-completed-loads-filters.mjs   # a base checkout: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HERE = path.join(__dirname, '..')
const ROOT = process.env.LOGISX_ROOT || HERE
const TAB_REL = 'client/src/components/dashboard/CompletedLoadsTab.vue'
const LIB_REL = 'client/src/lib/completedLoadsFilters.js'
const read = (rel) => { const f = path.join(ROOT, rel); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' }

let pass = 0
const failures = []
let quiet = false
function ok(name, cond) {
  if (cond) { pass++; return true }
  failures.push(name)
  if (!quiet) console.log(`  FAIL  ${name}`)
  return false
}
function eq(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  return ok(`${name}${g === w ? '' : `  (got ${g}, want ${w})`}`, g === w)
}

const clientRequire = createRequire(path.join(HERE, 'client', 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const drain = async () => { for (let i = 0; i < 6; i++) { await Vue.nextTick(); await new Promise((r) => setImmediate(r)) } }
const importText = (text) => import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)

// ══ §1 the lib ═══════════════════════════════════════════════════════════════
const PICKED = [
  [{}, ''],
  [{ driver: true }, ' for the driver you picked'],
  [{ dates: true }, ' for the dates you picked'],
  [{ driver: true, dates: true }, ' for the driver and dates you picked'],
]
// Every line the empty list can show: quick filter x search x driver/dates.
const HEADS = [
  [{}, 'No completed loads'],
  [{ search: true }, 'No loads match your search'],
  [{ review: true }, 'No loads need review'],
  [{ review: true, search: true }, 'No loads that need review match your search'],
  [{ attention: true }, 'No automatic invoice draft needs attention'],
  [{ attention: true, search: true }, 'No loads whose automatic invoice draft needs attention match your search'],
]
const EMPTY_LINES =HEADS.flatMap(([h, head]) => PICKED.map(([p, tail]) => [{ ...h, ...p }, `${head}${tail}.`]))

function libSuite(lib) {
  const press = (on, which) => lib.pressQuickFilter(on, which)
  eq('§1 Needs Review pressed with both off: Needs Review on', press({ review: false, attention: false }, 'review'), { review: true, attention: false })
  eq('§1 Needs attention pressed with both off: Needs attention on', press({ review: false, attention: false }, 'attention'), { review: false, attention: true })
  eq('§1 Needs attention pressed while Needs Review is on: Needs Review goes off', press({ review: true, attention: false }, 'attention'), { review: false, attention: true })
  eq('§1 Needs Review pressed while Needs attention is on: Needs attention goes off', press({ review: false, attention: true }, 'review'), { review: true, attention: false })
  eq('§1 the toggle that is on, pressed again: both off', [press({ review: true }, 'review'), press({ attention: true }, 'attention')], [{ review: false, attention: false }, { review: false, attention: false }])
  eq('§1 both somehow on, either pressed: never both on after', [press({ review: true, attention: true }, 'review'), press({ review: true, attention: true }, 'attention')], [{ review: false, attention: false }, { review: false, attention: false }])
  eq('§1 an unknown press changes nothing', [press({ review: true }, 'other'), press(null, 'other')], [{ review: true, attention: false }, { review: false, attention: false }])
  for (const [flags, line] of EMPTY_LINES) eq(`§1 empty line for ${JSON.stringify(flags)}`, lib.completedEmptyText(flags), line)
  eq('§1 no argument: the plain line', lib.completedEmptyText(), 'No completed loads.')
  eq('§1 the brief\'s own example', lib.completedEmptyText({ review: true, driver: true, dates: true }), 'No loads need review for the driver and dates you picked.')
}

let realLib = null
try { realLib = read(LIB_REL) ? await import(pathToFileURL(path.join(ROOT, LIB_REL)).href) : null } catch { realLib = null }
console.log('§1 the lib')
if (ok(`§1 ${LIB_REL} exists and loads`, !!realLib)) libSuite(realLib)

// ══ the harness: the tab compiled from source, mounted in memory ═════════════
function stub(name) {
  return Vue.defineComponent({
    name, inheritAttrs: false,
    setup(_, { attrs, slots }) {
      // The load dialog stays closed in every case here.
      if (name === 'Dialog') return () => null
      return () => Vue.h('div', { 'data-stub': name, 'data-attrs': { ...attrs } }, slots.default ? slots.default() : undefined)
    },
  })
}
const stubs = (names) => Object.fromEntries(names.map((n) => [n, stub(n)]))

// The loadboard pager, 25 rows a page, on this harness's Vue.
function pagingStub(items, { resetOn = [] } = {}) {
  const page = Vue.ref(1)
  const pageSize = Vue.ref(25)
  const totalPages = Vue.computed(() => Math.max(1, Math.ceil(items.value.length / pageSize.value)))
  const paginatedItems = Vue.computed(() => items.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
  const goTo = (n) => { page.value = n }
  if (resetOn.length) Vue.watch(resetOn, () => goTo(1))
  return { page, pageSize, totalPages, paginatedItems, goTo, setSize() {}, sizes: [] }
}

function overrides(role, libText) {
  const o = {
    '../../composables/useLoadboardPaging': { useLoadboardPaging: pagingStub },
    '../../composables/useApi': { useApi: () => ({ get: async () => ({}), post: async () => ({}), put: async () => ({}), del: async () => ({}) }) },
    '../../composables/useToast': { useToast: () => ({ show() {} }) },
    '../../composables/useViewport': { useViewport: () => ({ isMobile: Vue.ref(false) }) },
    '../../stores/auth': { useAuthStore: () => ({ user: { id: 7, role }, isSuperAdmin: role === 'Super Admin' }) },
    '../../stores/dashboard': { useDashboardStore: () => ({ data: { autoInvoice: { mode: 'on' } }, refresh: async () => {} }) },
    '@/components/ui/input': stubs(['Input']),
    '@/components/ui/table': stubs(['Table', 'TableHeader', 'TableBody', 'TableRow', 'TableHead', 'TableCell']),
    '@/components/ui/dialog': stubs(['Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription']),
  }
  if (libText !== undefined) o['../../lib/completedLoadsFilters'] = importText(libText)
  return o
}

async function compileTab(src, { role, libText }) {
  const dir = path.dirname(path.join(ROOT, TAB_REL))
  const { descriptor } = parse(src, { filename: 'CompletedLoadsTab.vue' })
  let body = compileScript(descriptor, { id: 'CompletedLoadsTab.vue', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
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
  if (/^\s*(import|export)\s/m.test(body)) throw new Error('an import/export this harness cannot map')
  const o = overrides(role, libText)
  const deps = { vue: Vue }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec in o) deps[spec] = await o[spec]
    else if (spec.endsWith('.vue')) deps[spec] = { default: stub(path.basename(spec, '.vue')) }
    else if (spec.startsWith('@/')) deps[spec] = await import(pathToFileURL(path.join(ROOT, 'client', 'src', `${spec.slice(2)}.js`)).href)
    else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', body)(deps)
}

// A minimal in-memory renderer (as scripts/test-load-detail-ratecon.mjs), with
// event listeners kept so v-model on the driver select and the date inputs runs.
function mountInMemory(Comp, props) {
  const node = (type, tag) => Vue.markRaw({
    type, tag, children: [], parent: null, props: {}, text: '', value: '', options: [], listeners: {},
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) },
    removeEventListener() {},
  })
  const ops = {
    insert(child, parent, anchor) {
      if (child.parent) ops.remove(child)
      const i = anchor ? parent.children.indexOf(anchor) : -1
      if (i >= 0) parent.children.splice(i, 0, child); else parent.children.push(child)
      child.parent = parent
    },
    remove(child) {
      const p = child.parent
      if (!p) return
      const i = p.children.indexOf(child)
      if (i >= 0) p.children.splice(i, 1)
      child.parent = null
    },
    createElement: (tag) => node('el', tag),
    createText: (t) => Object.assign(node('text'), { text: t }),
    createComment: (t) => Object.assign(node('comment'), { text: t }),
    setText(n, t) { n.text = t },
    setElementText(el, t) { el.children = []; if (t) ops.insert(Object.assign(node('text'), { text: t }), el) },
    parentNode: (n) => n.parent,
    nextSibling(n) { const p = n.parent; if (!p) return null; return p.children[p.children.indexOf(n) + 1] || null },
    querySelector: () => null,
    setScopeId() {},
    patchProp(el, key, prev, next) { el.props[key] = next },
  }
  const { createApp } = Vue.createRenderer(ops)
  const root = node('el', 'root')
  const app = createApp(Comp, props)
  app.config.warnHandler = () => {}
  app.mount(root)
  return { root, unmount: () => app.unmount() }
}
const textOf = (n) => (n.type === 'text' ? n.text : n.type === 'el' ? n.children.map(textOf).join(' ') : '').replace(/\s+/g, ' ').trim()
const all = (n, pred, out = []) => { if (pred(n)) out.push(n); for (const c of n.children || []) all(c, pred, out); return out }
const first = (n, pred) => all(n, pred)[0] || null
const stubEl = (n, name) => first(n, (x) => x.props && x.props['data-stub'] === name)
const fire = (el, type) => { for (const fn of el.listeners[type] || []) fn({ target: el }) }

// ══ made-up rows ═════════════════════════════════════════════════════════════
const D1 = 'Driver QA One'
const D2 = 'Driver QA Two'
const D3 = 'Driver QA Three'
// [Load ID, driver, Completion Date as recorded, needs review, needs attention]
const FIXTURE = [
  ['QA-1001', D1, '10/05/2026 14:00:00', true, false],
  ['QA-1002', D1, '11/03/2026 09:30:00', true, false],
  ['QA-1003', D1, '11/04/2026 16:10:00', false, true],
  ['QA-1004', D2, '10/06/2026 11:00:00', true, true],
  ['QA-1005', D2, '11/05/2026 08:45:00', true, false],
  ['QA-1006', D2, '10/07/2026 13:20:00', false, true],
  ['QA-1007', D2, '11/06/2026 17:05:00', false, true],
  ['QA-1008', D1, '10/08/2026 10:00:00', false, false],
  ['QA-1009', D2, '11/07/2026 12:00:00', false, false],
  ['QA-1010', D3, '11/09/2026 15:00:00', false, false],
  ['QA-1011', D1, '12/01/2026 09:00:00', true, false],
]
const HEADERS = ['Load ID', 'Driver', 'Job Status', 'Pickup Address', 'Drop-off Address', 'Payment', 'Completion Date']
// A blank Payment is a Needs Review reason (lib/loadReview.js); `_autoInvoice`
// in needs_attention is what the Needs attention toggle counts.
const JOBS = FIXTURE.map(([id, driver, day, review, attention], i) => ({
  'Load ID': id, Driver: driver, 'Job Status': 'Delivered',
  'Pickup Address': 'Springfield, IL 62701', 'Drop-off Address': 'Riverton, WY 82501',
  Payment: review ? '' : '$1,250.00', 'Completion Date': day, _rowIndex: i + 2,
  ...(attention ? { _autoInvoice: { state: 'needs_attention', code: 'NO_BROKER_EMAIL' } } : {}),
}))
const ORACLE = FIXTURE.map(([id, driver, day, review, attention]) => ({
  id, driver, review, attention, day: `${day.slice(6, 10)}-${day.slice(0, 2)}-${day.slice(3, 5)}`,
}))
const NOV = ['2026-11-01', '2026-11-30']
const OCT = ['2026-10-01', '2026-10-31']
const DEC = ['2026-12-01', '2026-12-31']
const poolOf = ({ driver = '', dates = null } = {}) => ORACLE.filter((r) => (!driver || r.driver === driver) && (!dates || (r.day >= dates[0] && r.day <= dates[1])))
const ids = (rows) => rows.map((r) => r.id).sort()

// ══ driving the tab ══════════════════════════════════════════════════════════
async function openTab(T, { role = 'Super Admin', jobs = JOBS } = {}) {
  const Comp = await compileTab(T.src, { role, libText: T.libText })
  const m = mountInMemory(Comp, { jobs, headers: HEADERS, active: true })
  await drain()
  return m
}
async function pickDriver(m, name) {
  const sel = first(m.root, (n) => n.tag === 'select' && n.props.id === 'cl-driver')
  if (!sel) throw new Error('no driver select')
  sel.options = [{ value: name.toLowerCase(), selected: true }]
  fire(sel, 'change')
  await drain()
}
async function pickDates(m, [from, to]) {
  const a = first(m.root, (n) => n.tag === 'input' && n.props.id === 'cl-from')
  const b = first(m.root, (n) => n.tag === 'input' && /^Delivered on or before/.test(n.props['aria-label'] || ''))
  if (!a || !b) throw new Error('no date inputs')
  a.value = from; fire(a, 'input')
  b.value = to; fire(b, 'input')
  await drain()
}
async function typeSearch(m, q) {
  const input = stubEl(m.root, 'Input')
  input.props['data-attrs']['onUpdate:modelValue'](q)
  await drain()
}
const toggleOf = (m, label) => first(m.root, (n) => n.tag === 'button' && new RegExp(`^${label} \\(\\d+\\)$`).test(textOf(n)))
async function press(m, which) {
  const b = toggleOf(m, which === 'review' ? 'Needs Review' : 'Needs attention')
  if (!b) throw new Error(`no ${which} toggle to press`)
  b.props.onClick({})
  await drain()
}
function view(m) {
  const review = toggleOf(m, 'Needs Review')
  const attention = toggleOf(m, 'Needs attention')
  const count = (b) => (b ? Number(/\((\d+)\)$/.exec(textOf(b))[1]) : null)
  const body = stubEl(m.root, 'TableBody')
  const rows = body ? all(body, (n) => n.props && n.props['data-stub'] === 'TableRow') : []
  const bar = stubEl(m.root, 'PaginationBar')
  const empty = stubEl(m.root, 'EmptyState')
  return {
    review, attention,
    reviewCount: count(review), attentionCount: count(attention),
    reviewOn: review ? review.props['aria-pressed'] : null,
    attentionOn: attention ? attention.props['aria-pressed'] : null,
    rowIds: rows.map((r) => (/QA-\d+/.exec(textOf(r)) || [''])[0]).sort(),
    total: bar ? bar.props['data-attrs'].total : null,
    empty: empty ? textOf(empty) : '',
  }
}
// A toggle shows while its count is above 0 or while it is on.
const shownCount = (n, on) => (n > 0 || on ? n : null)

// ══ §2–§5 over one copy of the tab (and of the lib) ═════════════════════════
async function tabSuite(T) {
  const FILTERS = [
    { label: 'no driver or dates', driver: '', dates: null },
    { label: `driver ${D2}`, driver: D2, dates: null },
    { label: 'dates 2026-11-01..30', driver: '', dates: NOV },
    { label: `driver ${D2} and dates 2026-11-01..30`, driver: D2, dates: NOV },
  ]
  for (const quick of ['', 'review', 'attention']) {
    for (const f of FILTERS) {
      const name = `§2 ${quick ? (quick === 'review' ? 'Needs Review' : 'Needs attention') : 'no toggle'}, ${f.label}`
      const m = await openTab(T)
      try {
        if (f.driver) await pickDriver(m, f.driver)
        if (f.dates) await pickDates(m, f.dates)
        if (quick) await press(m, quick)
        const v = view(m)
        const pool = poolOf(f)
        const reviewRows = pool.filter((r) => r.review)
        const attentionRows = pool.filter((r) => r.attention)
        const shown = quick === 'review' ? reviewRows : quick === 'attention' ? attentionRows : pool
        eq(`${name}: Needs Review's count is the driver/date rows that need review`, v.reviewCount, shownCount(reviewRows.length, quick === 'review'))
        eq(`${name}: Needs attention's count is the driver/date rows that need attention`, v.attentionCount, shownCount(attentionRows.length, quick === 'attention'))
        eq(`${name}: the list shows exactly these rows`, { total: v.total, rows: v.rowIds }, { total: shown.length, rows: ids(shown) })
        if (quick) eq(`${name}: the pressed toggle's count is the rows the list shows`, quick === 'review' ? v.reviewCount : v.attentionCount, v.rowIds.length)
      } catch (err) {
        ok(`${name}: runs (${err.message})`, false)
      } finally { m.unmount() }
    }
  }

  // §3 one at a time, in every order.
  {
    const m = await openTab(T)
    try {
      const all11 = ids(poolOf())
      const reviewIds = ids(poolOf().filter((r) => r.review))
      const attIds = ids(poolOf().filter((r) => r.attention))
      const state = (v) => ({ review: v.reviewOn, attention: v.attentionOn, rows: v.rowIds })
      await press(m, 'review')
      eq('§3 Needs Review pressed: it is on, Needs attention off, its rows listed', state(view(m)), { review: true, attention: false, rows: reviewIds })
      await press(m, 'attention')
      eq('§3 then Needs attention: Needs Review goes off, never both on, its rows listed', state(view(m)), { review: false, attention: true, rows: attIds })
      await press(m, 'review')
      eq('§3 then Needs Review again: Needs attention goes off', state(view(m)), { review: true, attention: false, rows: reviewIds })
      await press(m, 'review')
      eq('§3 then Needs Review once more: both off, every row listed', state(view(m)), { review: false, attention: false, rows: all11 })
      await press(m, 'attention')
      await press(m, 'attention')
      eq('§3 Needs attention on, then off: both off, every row listed', state(view(m)), { review: false, attention: false, rows: all11 })
    } catch (err) {
      ok(`§3 runs (${err.message})`, false)
    } finally { m.unmount() }
  }

  // §4 the same "on" look for both.
  {
    const style = (/<style scoped>([\s\S]*?)<\/style>/.exec(T.src) || ['', ''])[1]
    const ruleOf = (cls) => (new RegExp(`(?:^|\\n)\\.${cls}\\s*\\{([^}]*)\\}`).exec(style) || ['', null])[1]
    const declOf = (rule, prop) => ((new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(rule || '') || ['', ''])[1]).trim().toLowerCase()
    // auto-toggle is a name the e2e scripts find Needs attention by; it must carry no look.
    const looks = (n) => String(n.props.class || '').split(/\s+/).filter((c) => c && c !== 'auto-toggle').sort()
    const look = (n) => ({ classes: looks(n), style: n.props.style || null, pressed: n.props['aria-pressed'] })
    const m = await openTab(T)
    try {
      ok('§4 the auto-toggle name carries no style of its own', !/\.auto-toggle\b/.test(style))
      const v0 = view(m)
      const offReview = look(v0.review)
      const offAttention = look(v0.attention)
      eq('§4 both off: the same classes and style, aria-pressed false on both', offReview, offAttention)
      eq('§4 both off: aria-pressed is false', [offReview.pressed, offAttention.pressed], [false, false])
      await press(m, 'review')
      const onReview = look(view(m).review)
      await press(m, 'attention')
      const onAttention = look(view(m).attention)
      eq('§4 each on: the same classes and style, aria-pressed true on both', onReview, onAttention)
      eq('§4 each on: aria-pressed is true', [onReview.pressed, onAttention.pressed], [true, true])
      const added = onReview.classes.filter((c) => !offReview.classes.includes(c))
      ok(`§4 "on" adds one class (${added.join(', ') || 'none'})`, added.length === 1)
      const onRule = added.length === 1 ? ruleOf(added[0]) : null
      const bg = declOf(onRule, 'background')
      const fg = declOf(onRule, 'color')
      ok(`§4 the "on" class is filled: a solid, non-white background and its own text colour (background "${bg}", color "${fg}")`,
        !!bg && !/^(#fff|#ffffff|white|transparent|none)$/.test(bg) && /^#[0-9a-f]{3,6}$/.test(bg) && !!fg && fg !== bg)
    } catch (err) {
      ok(`§4 runs (${err.message})`, false)
    } finally { m.unmount() }
  }

  // §5 a toggle on at (0) stays, the empty line names what is on.
  const cases = [
    {
      name: `Needs Review on, then driver ${D3} (no load needs review)`,
      steps: async (m) => { await press(m, 'review'); await pickDriver(m, D3) },
      want: { reviewCount: 0, reviewOn: true, rows: [], empty: 'No loads need review for the driver you picked.' },
    },
    {
      name: 'Needs attention on, then December (no load needs attention)',
      steps: async (m) => { await press(m, 'attention'); await pickDates(m, DEC) },
      want: { attentionCount: 0, attentionOn: true, rows: [], empty: 'No automatic invoice draft needs attention for the dates you picked.' },
    },
    {
      name: `Needs attention on, then driver ${D3} and December`,
      steps: async (m) => { await press(m, 'attention'); await pickDriver(m, D3); await pickDates(m, DEC) },
      want: { attentionCount: 0, attentionOn: true, rows: [], empty: 'No automatic invoice draft needs attention for the driver and dates you picked.' },
    },
    {
      name: `no toggle, driver ${D3} and October (no load at all)`,
      steps: async (m) => { await pickDriver(m, D3); await pickDates(m, OCT) },
      want: { rows: [], empty: 'No completed loads for the driver and dates you picked.' },
    },
    {
      name: 'Needs Review on, a search for a load that needs none',
      steps: async (m) => { await press(m, 'review'); await typeSearch(m, 'QA-1008') },
      want: { reviewOn: true, rows: [], empty: 'No loads that need review match your search.' },
    },
    {
      name: `Needs attention on, driver ${D1}, a search for a load that needs none`,
      steps: async (m) => { await press(m, 'attention'); await pickDriver(m, D1); await typeSearch(m, 'QA-1001') },
      want: { attentionOn: true, rows: [], empty: 'No loads whose automatic invoice draft needs attention match your search for the driver you picked.' },
    },
    {
      name: 'no toggle, a search that finds nothing',
      steps: async (m) => { await typeSearch(m, 'QA-7777') },
      want: { rows: [], empty: 'No loads match your search.' },
    },
  ]
  for (const c of cases) {
    const m = await openTab(T)
    try {
      await c.steps(m)
      const v = view(m)
      const got = Object.fromEntries(Object.keys(c.want).map((k) => [k, k === 'rows' ? v.rowIds : v[k]]))
      eq(`§5 ${c.name}`, got, c.want)
    } catch (err) {
      ok(`§5 ${c.name}: runs (${err.message})`, false)
    } finally { m.unmount() }
  }
  {
    const m = await openTab(T, { jobs: [] })
    try { eq('§5 no completed loads at all', view(m).empty, 'No completed loads.') } catch (err) { ok(`§5 no loads: runs (${err.message})`, false) } finally { m.unmount() }
  }
  {
    const m = await openTab(T, { role: 'Dispatcher' })
    try {
      const v = view(m)
      const reviewIds = ids(poolOf().filter((r) => r.review))
      eq('§5 a Dispatcher: no driver or date filter, no Needs attention, Needs Review over every load',
        { bar: !!first(m.root, (n) => n.tag === 'select' && n.props.id === 'cl-driver'), attention: !!v.attention, review: v.reviewCount }, { bar: false, attention: false, review: reviewIds.length })
      await press(m, 'review')
      const after = view(m)
      eq('§5 a Dispatcher pressing Needs Review: its count is the rows listed', { on: after.reviewOn, rows: after.rowIds }, { on: true, rows: reviewIds })
    } catch (err) {
      ok(`§5 a Dispatcher: runs (${err.message})`, false)
    } finally { m.unmount() }
  }
}

const TAB = read(TAB_REL)
const LIB = read(LIB_REL)
console.log('§2-§5 the tab, mounted')
if (ok(`${TAB_REL} exists`, !!TAB)) {
  let compiles = false
  try { compiles = !!(await compileTab(TAB, { role: 'Super Admin', libText: LIB || undefined })) } catch (err) { console.log(`  (${err.message})`) }
  if (ok('§2 the tab compiles in this harness', compiles)) await tabSuite({ src: TAB, libText: LIB || undefined })
}

// ══ §6 mutants ═══════════════════════════════════════════════════════════════
console.log('§6 mutants')
const MUTANTS = [
  ['toggles not exclusive: Needs attention flips only itself', 'tab', "@click=\"pressQuick('attention')\"", '@click="autoAttentionOnly = !autoAttentionOnly"'],
  ['toggles not exclusive: the lib leaves Needs Review on', 'lib', 'if (pressed === QUICK_ATTENTION) return { review: false, attention: !attention }', 'if (pressed === QUICK_ATTENTION) return { review, attention: !attention }'],
  ['Needs Review counted over every completed load', 'tab', 'countNeedsReview(exportMatches.value)', 'countNeedsReview(props.jobs)'],
  ['Needs attention counted over every completed load', 'tab', 'exportMatches.value.filter(autoInvoiceNeedsAttention).length', 'props.jobs.filter(autoInvoiceNeedsAttention).length'],
  ['the empty line no longer names the driver or dates', 'lib', 'function pickedText(driver, dates) {', "function pickedText(driver, dates) {\n  return ''"],
  ['the empty line no longer names Needs Review', 'tab', 'completedEmptyText({\n  review: needsReviewOnly.value,', 'completedEmptyText({\n  review: false,'],
  ['Needs Review without aria-pressed', 'tab', '\n          :aria-pressed="needsReviewOnly"', ''],
  ['Needs Review "on" in its own colours', 'tab', ":class=\"{ 'quick-toggle--on': needsReviewOnly }\"", ":class=\"{ 'review-toggle--on': needsReviewOnly }\""],
  ['the "on" style not filled', 'tab', '.quick-toggle--on { border-color: #0f2847; background: #0f2847; color: #fff; }', '.quick-toggle--on { border-color: #0f2847; background: #fff; color: #0f2847; }'],
  ['Needs Review hidden while on at (0)', 'tab', 'v-if="needsReviewCount > 0 || needsReviewOnly"', 'v-if="needsReviewCount > 0"'],
]
for (const [name, where, from, to] of MUTANTS) {
  const text = where === 'tab' ? TAB : LIB
  if (!ok(`MUTANT ${name}: anchor found once`, text.split(from).length - 1 === 1)) continue
  const mutated = text.replace(from, to)
  const before = failures.length
  const saved = pass
  quiet = true
  try {
    if (where === 'lib') libSuite(await importText(mutated))
    await tabSuite(where === 'tab' ? { src: mutated, libText: LIB } : { src: TAB, libText: mutated })
  } catch { failures.push('mutant threw') } finally { quiet = false }
  const hits = failures.slice(before)
  failures.length = before
  pass = saved
  if (ok(`MUTANT ${name}: caught`, hits.length > 0)) console.log(`  caught  ${name}: ${hits.length} check(s) failed, first "${hits[0].replace(/\s+\(got[\s\S]*$/, '')}"`)
}

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
