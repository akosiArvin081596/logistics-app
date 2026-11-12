#!/usr/bin/env node
// Job Board's and Active Loads' Needs Review toggle: display only.
//
// Each tab is compiled from source and mounted in memory, at desktop and phone
// width, on made-up rows:
//   §1 one quick toggle, so nothing stacks; its count is taken over the tab's
//      rows, and with no search typed it is the rows the toggle shows. A search
//      narrows the rows and leaves the count over every row.
//   §2 a toggle stays on screen while it is on, even at (0): the rows are read
//      again underneath it (the flagged loads fixed, or gone); a press turns it
//      off, and at (0) off it goes.
//   §3 aria-pressed says whether it is on.
//   §4 the empty line names what is on: the toggle and a typed search.
//   §5 the toggle has no role gate: a Dispatcher gets it, and a Super Admin who
//      becomes a Dispatcher in place keeps it on screen, on.
//   §6 mutants on the changed lines, each caught.
//
// Made-up rows only. No DOM, no server. Vue comes from this checkout's
// client/node_modules; the files under test from LOGISX_ROOT (default: this
// checkout).
//   node scripts/test-review-filter-tabs.mjs
//   LOGISX_ROOT=/path/to/base node scripts/test-review-filter-tabs.mjs   # a base checkout: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HERE = path.join(__dirname, '..')
const ROOT = process.env.LOGISX_ROOT || HERE
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

// ══ the harness: a tab compiled from source, mounted in memory ═══════════════
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

// The loadboard pager on this harness's Vue, 50 rows a page (more than any fixture).
function pagingStub(items, { resetOn = [] } = {}) {
  const page = Vue.ref(1)
  const pageSize = Vue.ref(50)
  const totalPages = Vue.computed(() => Math.max(1, Math.ceil(items.value.length / pageSize.value)))
  const paginatedItems = Vue.computed(() => items.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
  const goTo = (n) => { page.value = n }
  if (resetOn.length) Vue.watch(resetOn, () => goTo(1))
  return { page, pageSize, totalPages, paginatedItems, goTo, setSize() {}, sizes: [] }
}

function overrides({ auth, phone }) {
  return {
    '../../composables/useLoadboardPaging': { useLoadboardPaging: pagingStub },
    '../../composables/useApi': { useApi: () => ({ get: async () => ({}), post: async () => ({}), put: async () => ({}), del: async () => ({}) }) },
    '../../composables/useToast': { useToast: () => ({ show() {} }) },
    '../../composables/useViewport': { useViewport: () => ({ isMobile: Vue.ref(!!phone) }) },
    '../../composables/useOffDutyConfirm': { useOffDutyConfirm: () => ({ withOffDutyConfirm: async (fn) => fn(false) }) },
    '../../stores/auth': { useAuthStore: () => auth },
    '../../stores/dashboard': { useDashboardStore: () => ({ data: {}, refresh: async () => {} }) },
    '@/components/ui/input': stubs(['Input']),
    '@/components/ui/button': stubs(['Button']),
    '@/components/ui/table': stubs(['Table', 'TableHeader', 'TableBody', 'TableRow', 'TableHead', 'TableCell']),
    '@/components/ui/dialog': stubs(['Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription']),
  }
}

async function compileTab(src, rel, { auth, phone }) {
  const dir = path.dirname(path.join(ROOT, rel))
  const file = path.basename(rel)
  const { descriptor } = parse(src, { filename: file })
  let body = compileScript(descriptor, { id: file, inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
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
  const o = overrides({ auth, phone })
  const deps = { vue: Vue }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec in o) deps[spec] = o[spec]
    else if (spec.endsWith('.vue')) deps[spec] = { default: stub(path.basename(spec, '.vue')) }
    else if (spec.startsWith('@/')) deps[spec] = await import(pathToFileURL(path.join(ROOT, 'client', 'src', `${spec.slice(2)}.js`)).href)
    else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', body)(deps)
}

// A minimal in-memory renderer (as scripts/test-completed-loads-filters.mjs).
// The tab sits under a wrapper whose `jobs` can be replaced, the way a dashboard
// refresh hands the tab new rows.
function mountInMemory(Comp, props, jobs) {
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
  const state = Vue.shallowReactive({ jobs })
  const Wrapper = Vue.defineComponent({ setup() { return () => Vue.h(Comp, { ...props, jobs: state.jobs }) } })
  const app = createApp(Wrapper)
  app.config.warnHandler = () => {}
  app.mount(root)
  return { root, state, unmount: () => app.unmount() }
}
const textOf = (n) => (n.type === 'text' ? n.text : n.type === 'el' ? n.children.map(textOf).join(' ') : '').replace(/\s+/g, ' ').trim()
const all = (n, pred, out = []) => { if (pred(n)) out.push(n); for (const c of n.children || []) all(c, pred, out); return out }
const first = (n, pred) => all(n, pred)[0] || null
const stubEl = (n, name) => first(n, (x) => x.props && x.props['data-stub'] === name)
const hasClass = (n, cls) => String((n.props && n.props.class) || '').split(/\s+/).includes(cls)

// ══ made-up rows ═════════════════════════════════════════════════════════════
// A blank Payment, an "Awaiting Rate Con" address and a driver-instructions code
// are each a Needs Review reason (lib/loadReview.js).
const AWAIT = 'Awaiting Rate Con'
const OK_PICKUP = 'Springfield, IL 62701'
const OK_DROP = 'Riverton, WY 82501'
// [Load ID, reason or '']
const FIXTURE = [
  ['QA-2001', 'payment'],
  ['QA-2002', ''],
  ['QA-2003', 'pickup'],
  ['QA-2004', ''],
  ['QA-2005', 'instructions'],
  ['QA-2006', ''],
  ['QA-2007', ''],
  ['QA-2008', ''],
]
const FLAGGED = FIXTURE.filter(([, why]) => why).map(([id]) => id)
const EVERY = FIXTURE.map(([id]) => id)
function rowsFor(tab, { fixed = [], gone = [] } = {}) {
  return FIXTURE.filter(([id]) => !gone.includes(id)).map(([id, why], i) => {
    const flag = fixed.includes(id) ? '' : why
    return {
      'Load ID': id,
      ...(tab.driver ? { Driver: 'Driver QA One' } : {}),
      'Job Status': tab.status,
      'Pickup Address': flag === 'pickup' ? AWAIT : OK_PICKUP,
      'Drop-off Address': OK_DROP,
      Payment: flag === 'payment' ? '' : '$1,250.00',
      _rowIndex: i + 2,
      ...(flag === 'instructions' ? { _instructionsReview: ['no_rate_con'] } : {}),
    }
  })
}

// Each tab's own words; the two search lines are lib/completedLoadsFilters.js's.
const TABS = [
  {
    name: 'Job Board',
    rel: 'client/src/components/dashboard/JobBoardTab.vue',
    card: 'mobile-job-card',
    status: '',
    driver: false,
    headers: ['Load ID', 'Job Status', 'Pickup Address', 'Drop-off Address', 'Payment'],
    props: { drivers: [], loading: false, active: true },
    lines: {
      none: 'All loads are assigned.',
      search: 'No loads match your search.',
      review: 'No unassigned loads need review.',
      reviewSearch: 'No loads that need review match your search.',
    },
  },
  {
    name: 'Active Loads',
    rel: 'client/src/components/dashboard/ActiveLoadsTab.vue',
    card: 'mobile-load-card',
    status: 'In Transit',
    driver: true,
    headers: ['Load ID', 'Driver', 'Job Status', 'Pickup Address', 'Drop-off Address', 'Payment'],
    props: { drivers: [], busyDrivers: [], offUntil: null, active: true, focusLoadId: '' },
    lines: {
      none: 'No active loads right now.',
      search: 'No loads match your search.',
      review: 'No loads currently need review — every active load has a complete rate-con.',
      reviewSearch: 'No loads that need review match your search.',
    },
  },
]

// ══ driving a tab ════════════════════════════════════════════════════════════
const authAs = (role) => Vue.reactive({ user: { id: 7, role }, isSuperAdmin: role === 'Super Admin' })
async function openTab(T, src, { role = 'Super Admin', auth, phone = false, jobs } = {}) {
  const a = auth || authAs(role)
  const Comp = await compileTab(src, T.rel, { auth: a, phone })
  const m = mountInMemory(Comp, { ...T.props, headers: T.headers }, jobs || rowsFor(T))
  m.phone = phone
  m.auth = a
  await drain()
  return m
}
async function setJobs(m, jobs) { m.state.jobs = jobs; await drain() }
async function typeSearch(m, q) {
  const input = stubEl(m.root, 'Input')
  input.props['data-attrs']['onUpdate:modelValue'](q)
  await drain()
}
// The quick toggles: buttons labelled "<words> (<n>)".
const toggles = (m) => all(m.root, (n) => n.tag === 'button' && /^[A-Za-z ]+ \(\d+\)$/.test(textOf(n)))
const reviewToggle = (m) => first(m.root, (n) => n.tag === 'button' && /^Needs Review \(\d+\)$/.test(textOf(n)))
async function press(m) {
  const b = reviewToggle(m)
  if (!b) throw new Error('no Needs Review toggle to press')
  b.props.onClick({})
  await drain()
}
function view(m, T) {
  const b = reviewToggle(m)
  let rows
  if (m.phone) rows = all(m.root, (n) => n.tag === 'div' && hasClass(n, T.card))
  else {
    const body = stubEl(m.root, 'TableBody')
    rows = body ? all(body, (n) => n.props && n.props['data-stub'] === 'TableRow') : []
  }
  const bar = stubEl(m.root, 'PaginationBar')
  const empty = stubEl(m.root, 'EmptyState')
  return {
    shown: !!b,
    count: b ? Number(/\((\d+)\)$/.exec(textOf(b))[1]) : null,
    pressed: b ? (b.props['aria-pressed'] === undefined ? null : b.props['aria-pressed']) : null,
    rows: rows.map((r) => (/QA-\d+/.exec(textOf(r)) || [''])[0]).sort(),
    total: bar ? bar.props['data-attrs'].total : null,
    empty: empty ? textOf(empty) : '',
  }
}

// ══ §1–§5 over one copy of a tab ═════════════════════════════════════════════
async function tabSuite(T, src) {
  const N = T.name
  // §1 the count and the rows, at both widths and for both roles.
  for (const phone of [false, true]) {
    for (const role of ['Super Admin', 'Dispatcher']) {
      const at = `${N}, ${role}, ${phone ? 'phone' : 'desktop'}`
      const m = await openTab(T, src, { role, phone })
      try {
        let v = view(m, T)
        eq(`§1 ${at}: one quick toggle, so no two filters stack`, toggles(m).length, 1)
        eq(`§1 ${at}, off: the count is the rows that need review, every row listed`,
          { count: v.count, rows: v.rows, total: v.total }, { count: FLAGGED.length, rows: EVERY, total: EVERY.length })
        await press(m)
        v = view(m, T)
        eq(`§1 ${at}, on: the list is the rows that need review`, { rows: v.rows, total: v.total }, { rows: FLAGGED, total: FLAGGED.length })
        eq(`§1 ${at}, on: the count is the rows the list shows`, v.count, v.rows.length)
        await typeSearch(m, 'QA-2003')
        v = view(m, T)
        eq(`§1 ${at}, on, a search for a flagged load: that row, the count still over every row`,
          { count: v.count, rows: v.rows }, { count: FLAGGED.length, rows: ['QA-2003'] })
        await press(m)
        v = view(m, T)
        eq(`§1 ${at}, off, the same search: that row, the same count`, { count: v.count, rows: v.rows }, { count: FLAGGED.length, rows: ['QA-2003'] })
        await typeSearch(m, '')
        v = view(m, T)
        eq(`§1 ${at}, off, the search cleared: every row`, v.rows, EVERY)
      } catch (err) {
        ok(`§1 ${at}: runs (${err.message})`, false)
      } finally { m.unmount() }
    }
  }

  // §2 on at (0): the rows change underneath the toggle.
  const atZero = [
    { name: 'the flagged loads fixed', jobs: rowsFor(T, { fixed: FLAGGED }), left: EVERY },
    { name: 'the flagged loads gone from the tab', jobs: rowsFor(T, { gone: FLAGGED }), left: EVERY.filter((id) => !FLAGGED.includes(id)) },
  ]
  for (const c of atZero) {
    const m = await openTab(T, src)
    try {
      await press(m)
      await setJobs(m, c.jobs)
      let v = view(m, T)
      eq(`§2 ${N}: on, then ${c.name}: the toggle stays, on, at (0), the list empty, its line`,
        { shown: v.shown, count: v.count, pressed: v.pressed, rows: v.rows, empty: v.empty },
        { shown: true, count: 0, pressed: true, rows: [], empty: T.lines.review })
      if (v.shown) {
        await press(m)
        v = view(m, T)
        eq(`§2 ${N}: ...pressed: off, its button gone at (0), every row listed`, { shown: v.shown, rows: v.rows }, { shown: false, rows: c.left })
      }
    } catch (err) {
      ok(`§2 ${N}: on, then ${c.name}: runs (${err.message})`, false)
    } finally { m.unmount() }
  }
  {
    const m = await openTab(T, src)
    try {
      await press(m)
      await setJobs(m, rowsFor(T, { fixed: ['QA-2001', 'QA-2003'] }))
      const v = view(m, T)
      eq(`§2 ${N}: on, then two of three fixed: (1), that one row`, { count: v.count, pressed: v.pressed, rows: v.rows }, { count: 1, pressed: true, rows: ['QA-2005'] })
      await setJobs(m, rowsFor(T))
      const back = view(m, T)
      eq(`§2 ${N}: ...and flagged again: (3), the three rows`, { count: back.count, rows: back.rows }, { count: 3, rows: FLAGGED })
    } catch (err) {
      ok(`§2 ${N}: rows changing while on: runs (${err.message})`, false)
    } finally { m.unmount() }
  }
  {
    const m = await openTab(T, src, { jobs: rowsFor(T, { fixed: FLAGGED }) })
    try {
      eq(`§2 ${N}: off and no load needs review: no toggle`, view(m, T).shown, false)
    } catch (err) {
      ok(`§2 ${N}: off at (0): runs (${err.message})`, false)
    } finally { m.unmount() }
  }

  // §3 aria-pressed.
  {
    const m = await openTab(T, src)
    try {
      const seen = [view(m, T).pressed]
      await press(m); seen.push(view(m, T).pressed)
      await press(m); seen.push(view(m, T).pressed)
      eq(`§3 ${N}: aria-pressed off, on, off`, seen, [false, true, false])
    } catch (err) {
      ok(`§3 ${N}: runs (${err.message})`, false)
    } finally { m.unmount() }
  }

  // §4 the empty line names what is on.
  const lines = [
    { name: 'no loads at all', jobs: [], steps: async () => {}, want: { shown: false, empty: T.lines.none } },
    { name: 'a search that finds nothing', steps: async (m) => { await typeSearch(m, 'QA-7777') }, want: { count: 3, pressed: false, empty: T.lines.search } },
    { name: 'on, a search for a load that needs none', steps: async (m) => { await press(m); await typeSearch(m, 'QA-2002') }, want: { count: 3, pressed: true, empty: T.lines.reviewSearch } },
    { name: 'on, a search that finds nothing', steps: async (m) => { await press(m); await typeSearch(m, 'QA-7777') }, want: { count: 3, pressed: true, empty: T.lines.reviewSearch } },
    { name: 'on at (0), no search', steps: async (m) => { await press(m); await setJobs(m, rowsFor(T, { fixed: FLAGGED })) }, want: { count: 0, pressed: true, empty: T.lines.review } },
    { name: 'on at (0), a search typed', steps: async (m) => { await press(m); await setJobs(m, rowsFor(T, { fixed: FLAGGED })); await typeSearch(m, 'QA-2002') }, want: { count: 0, pressed: true, empty: T.lines.reviewSearch } },
    { name: 'no loads at all, only spaces in the search box', jobs: [], steps: async (m) => { await typeSearch(m, '   ') }, want: { shown: false, empty: T.lines.none } },
  ]
  for (const c of lines) {
    const m = await openTab(T, src, c.jobs ? { jobs: c.jobs } : {})
    try {
      await c.steps(m)
      const v = view(m, T)
      const got = Object.fromEntries(Object.keys(c.want).map((k) => [k, v[k]]))
      eq(`§4 ${N}: ${c.name}`, { ...got, rows: v.rows }, { ...c.want, rows: [] })
    } catch (err) {
      ok(`§4 ${N}: ${c.name}: runs (${err.message})`, false)
    } finally { m.unmount() }
  }

  // §5 no role gate: a role change in place leaves the toggle in sight.
  {
    const auth = authAs('Super Admin')
    const m = await openTab(T, src, { auth })
    try {
      await press(m)
      auth.user.role = 'Dispatcher'
      auth.isSuperAdmin = false
      await drain()
      const v = view(m, T)
      eq(`§5 ${N}: on, then the same person becomes a Dispatcher: the toggle stays on screen, on, over the same rows`,
        { shown: v.shown, pressed: v.pressed, count: v.count, rows: v.rows }, { shown: true, pressed: true, count: FLAGGED.length, rows: FLAGGED })
    } catch (err) {
      ok(`§5 ${N}: a role change: runs (${err.message})`, false)
    } finally { m.unmount() }
  }
}

const SRC = Object.fromEntries(TABS.map((T) => [T.name, read(T.rel)]))
for (const T of TABS) {
  console.log(`§1-§5 ${T.name}, mounted`)
  if (!ok(`${T.rel} exists`, !!SRC[T.name])) continue
  let compiles = false
  try { compiles = !!(await compileTab(SRC[T.name], T.rel, { auth: authAs('Super Admin'), phone: false })) } catch (err) { console.log(`  (${err.message})`) }
  if (ok(`${T.name} compiles in this harness`, compiles)) await tabSuite(T, SRC[T.name])
}

// ══ §6 mutants ═══════════════════════════════════════════════════════════════
console.log('§6 mutants')
const MUTANTS = [
  ['hidden while on at (0)', 'v-if="needsReviewCount > 0 || needsReviewOnly"', 'v-if="needsReviewCount > 0"'],
  ['no aria-pressed', '\n          :aria-pressed="needsReviewOnly"', ''],
  ['the empty line ignores a typed search', 'if (searchQuery.value.trim()) return completedEmptyText(', 'if (false) return completedEmptyText('],
  ['the empty line takes spaces for a search', 'if (searchQuery.value.trim()) return completedEmptyText(', 'if (searchQuery.value) return completedEmptyText('],
  ['the empty line ignores the toggle under a search', 'completedEmptyText({ review: needsReviewOnly.value, search: true })', 'completedEmptyText({ review: false, search: true })'],
  ['the empty line ignores the toggle with no search', '  return needsReviewOnly.value ? \'', '  return false ? \''],
  ['the toggle switched off at a count of 0', 'const needsReviewOnly = ref(false)', 'const needsReviewOnly = ref(false)\nwatch(() => countNeedsReview(props.jobs), (n) => { if (!n) needsReviewOnly.value = false })'],
]
for (const T of TABS) {
  const text = SRC[T.name]
  for (const [name, from, to] of MUTANTS) {
    const label = `${T.name}: ${name}`
    if (!ok(`MUTANT ${label}: anchor found once`, text.split(from).length - 1 === 1)) continue
    const mutated = text.replace(from, to)
    const before = failures.length
    const saved = pass
    quiet = true
    try { await tabSuite(T, mutated) } catch { failures.push('mutant threw') } finally { quiet = false }
    const hits = failures.slice(before)
    failures.length = before
    pass = saved
    if (ok(`MUTANT ${label}: caught`, hits.length > 0)) console.log(`  caught  ${label}: ${hits.length} check(s) failed, first "${hits[0].replace(/\s+\(got[\s\S]*$/, '')}"`)
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
