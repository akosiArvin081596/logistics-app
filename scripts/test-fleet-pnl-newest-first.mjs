#!/usr/bin/env node
// Fleet P&L column order (owner request R2): the live (current) period sits on
// the far left, beside the line names, older periods read to the right, and
// Total stays the far-right column.
//
//   §1 periodsNewestFirst() (client/src/lib/financialsView.js): newest key first
//      for every granularity's key shape, a copy (the server's list is never
//      reordered in place), nothing added or dropped
//   §2 FleetPnlTable.vue, rendered: the headings run newest to oldest and end in
//      Total; every cell stays under its own period's heading (each figure is the
//      server's figure for that period, moved with its column); Total shows the
//      server's report.total, never a sum made in the browser
//   §3 StateMilesPanel.vue (shown under the pickup/delivery state groupings),
//      mounted: its period columns run in the same order, newest first, after
//      State / Miles / Share; each state's miles stay under their own period and
//      the Total row is still last, so switching the grouping never flips the
//      column order
//
// Display only: no figure is computed here or in the component. The fixture is
// made up (round numbers, no real loads, trucks or people).
//
// No DOM, no server. Vue comes from this checkout's client/node_modules; the
// files under test come from LOGISX_ROOT (default: this checkout).
//   node scripts/test-fleet-pnl-newest-first.mjs
//   LOGISX_ROOT=/path/to/base node scripts/test-fleet-pnl-newest-first.mjs   # a base checkout: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HERE = path.join(__dirname, '..')
const ROOT = process.env.LOGISX_ROOT || HERE

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const clientRequire = createRequire(path.join(HERE, 'client', 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const { renderToString } = clientRequire('vue/server-renderer')

const view = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'financialsView.js')).href)
const newestFirst = typeof view.periodsNewestFirst === 'function' ? view.periodsNewestFirst : null

// ══ §1 periodsNewestFirst ════════════════════════════════════════════════════
ok('§1 financialsView exports periodsNewestFirst()', !!newestFirst)
if (newestFirst) {
  const keys = (list) => list.map((p) => p.key)
  const months = [{ key: '2025-11' }, { key: '2025-12' }, { key: '2026-01' }, { key: '2026-10' }]
  const before = JSON.stringify(months)
  ok('§1 months: newest first, across the year end', same(keys(newestFirst(months)), ['2026-10', '2026-01', '2025-12', '2025-11']))
  ok('§1 the server\'s list is not reordered in place', JSON.stringify(months) === before)
  ok('§1 a new array, the same period objects', newestFirst(months) !== months && newestFirst(months)[0] === months[3])
  ok('§1 weeks and days (YYYY-MM-DD keys)', same(keys(newestFirst([{ key: '2026-09-26' }, { key: '2026-10-03' }, { key: '2026-10-10' }])), ['2026-10-10', '2026-10-03', '2026-09-26']))
  ok('§1 quarters', same(keys(newestFirst([{ key: '2025-Q4' }, { key: '2026-Q1' }, { key: '2026-Q3' }])), ['2026-Q3', '2026-Q1', '2025-Q4']))
  ok('§1 years', same(keys(newestFirst([{ key: '2024' }, { key: '2025' }, { key: '2026' }])), ['2026', '2025', '2024']))
  ok('§1 an order the server did not send still comes out newest first', same(keys(newestFirst([{ key: '2026-09' }, { key: '2026-10' }, { key: '2026-08' }])), ['2026-10', '2026-09', '2026-08']))
  ok('§1 one period, none, or no list', same([keys(newestFirst([{ key: '2026-10' }])), newestFirst([]), newestFirst(undefined), newestFirst(null)], [['2026-10'], [], [], []]))
}

// ══ §2 FleetPnlTable, rendered ═══════════════════════════════════════════════
// Compile a committed SFC's <script setup> + <template>. Imports are resolved
// from `overrides` first; a .vue import becomes an empty stub; a relative .js
// import is loaded from ROOT.
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
  const deps = { vue: Vue }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec in overrides) deps[spec] = overrides[spec]
    else if (spec.endsWith('.vue')) deps[spec] = { default: Vue.defineComponent({ name: path.basename(spec, '.vue'), render: () => null }) }
    else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', body)(deps)
}

// Rendered HTML to visible text: comments dropped, each tag one space.
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
// The visible text of the first <tr> whose text starts with `first`.
function rowText(html, first) {
  for (const chunk of String(html).split('<tr').slice(1)) {
    const t = text(`<tr${chunk.split('</tr>')[0]}</tr>`)
    if (t.startsWith(first)) return t
  }
  return ''
}

// Made-up figures, each period distinct so a cell under the wrong heading shows.
// The total is deliberately NOT the sum of the periods: the table must print the
// server's total as sent.
const fig = (revenue, loads) => ({ revenue, costs: { fuel: revenue / 10 }, totalCosts: revenue / 2, margin: revenue / 2, marginPct: 50, loads, miles: loads * 100, revenuePerMile: 2, costPerMile: 1 })
const report = {
  granularity: 'month',
  periods: [
    { key: '2026-08', label: 'Aug 2026', basis: 'settled' },
    { key: '2026-09', label: 'Sep 2026', basis: 'settled' },
    { key: '2026-10', label: 'Oct 2026', basis: 'live' },
  ],
  lines: [{ key: 'fuel', label: 'Fuel' }],
  settings: { costs: { fuel: true } },
  totalByPeriod: { '2026-08': fig(1000, 1), '2026-09': fig(2000, 2), '2026-10': fig(4000, 4) },
  total: { ...fig(7000, 7), revenue: 7777, basis: 'mixed' },
}
const periodsBefore = JSON.stringify(report.periods)

let html = ''
try {
  const Table = await compileComponent('client/src/components/financials/FleetPnlTable.vue')
  html = await renderToString(Vue.createSSRApp(Table, { report }))
} catch (err) {
  ok(`§2 FleetPnlTable renders (${err.message})`, false)
}
if (html) {
  const head = text((/<thead[^>]*>([\s\S]*?)<\/thead>/.exec(html) || [])[1] || '')
  ok(`§2 headings: Line, then newest to oldest, then Total ("${head}")`, head === 'Line Oct 2026 Sep 2026 Aug 2026 Total')
  ok('§2 Total is the last column', head.endsWith(' Total'))
  const revenue = rowText(html, 'Revenue')
  ok(`§2 Revenue cells sit under their own month; Total is the server's ("${revenue}")`, revenue === 'Revenue $4,000.00 $2,000.00 $1,000.00 $7,777.00')
  const loads = rowText(html, 'Loads')
  ok(`§2 Loads cells move with their month ("${loads}")`, loads === 'Loads 4 2 1 7')
  const fuel = rowText(html, 'Fuel')
  ok(`§2 cost lines move with their month ("${fuel}")`, fuel === 'Fuel $400.00 $200.00 $100.00 $700.00')
  ok('§2 the month buttons keep their own month', /Open the Oct 2026 breakdown[\s\S]*Open the Sep 2026 breakdown[\s\S]*Open the Aug 2026 breakdown/.test(html))
  ok('§2 the report\'s periods are left as the server sent them', JSON.stringify(report.periods) === periodsBefore)
}

// ══ §3 StateMilesPanel, mounted ══════════════════════════════════════════════
// The panel fetches its own data (GET /api/financials/state-miles) on mount, so
// it is mounted in a minimal in-memory renderer (watchers run, the await
// resolves, the template re-renders) instead of server-rendered.
function mountInMemory(Comp, props) {
  const node = (type, tag) => Vue.markRaw({ type, tag, children: [], parent: null, props: {}, text: '' })
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
  const root = node('el', 'root')
  const app = Vue.createRenderer(ops).createApp(Comp, props)
  app.mount(root)
  const textOf = (n) => (n.type === 'text' ? n.text : n.type === 'el' ? n.children.map(textOf).join(' ') : '')
  const all = (n, tag, out = []) => { if (n.tag === tag) out.push(n); (n.children || []).forEach((c) => all(c, tag, out)); return out }
  const clean = (s) => s.replace(/\s+/g, ' ').trim()
  return { rows: (tag) => all(root, tag).map((n) => clean(textOf(n))), unmount: () => app.unmount() }
}
const drain = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }

// Made-up miles: distinct per period, so a cell under the wrong heading shows.
const stateMiles = {
  periods: [
    { key: '2026-08', label: 'Aug 2026' },
    { key: '2026-09', label: 'Sep 2026' },
    { key: '2026-10', label: 'Oct 2026' },
  ],
  states: [{ state: 'TX', total: 700, share: 100, byPeriod: { '2026-08': 100, '2026-09': 200, '2026-10': 400 }, byTruck: {} }],
  total: 700,
  recordedFrom: '',
}
const stateMilesBefore = JSON.stringify(stateMiles.periods)
try {
  const Panel = await compileComponent('client/src/components/financials/StateMilesPanel.vue', {
    'lucide-vue-next': { MapPinned: Vue.defineComponent({ name: 'MapPinned', render: () => null }) },
    '../../composables/useApi': { useApi: () => ({ get: async () => stateMiles }) },
  })
  const m = mountInMemory(Panel, { from: '2026-08-01', to: '2026-10-15', granularity: 'month' })
  await drain()
  const rows = m.rows('tr')
  const head = rows.find((t) => t.startsWith('State')) || ''
  ok(`§3 state miles headings: State, Miles, Share, then newest to oldest ("${head}")`, head === 'State Miles Share Oct 2026 Sep 2026 Aug 2026')
  const tx = rows.find((t) => t.includes('TX')) || ''
  ok(`§3 each state's miles stay under their own period ("${tx}")`, /TX 700 100\.0% 400 200 100$/.test(tx))
  ok(`§3 the Total row is still last ("${rows[rows.length - 1]}")`, /^Total 700$/.test(rows[rows.length - 1] || ''))
  ok('§3 the server\'s period list is left as sent', JSON.stringify(stateMiles.periods) === stateMilesBefore)
  m.unmount()
} catch (err) {
  ok(`§3 StateMilesPanel mounts (${err.message})`, false)
}
const PANEL = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'financials', 'StateMilesPanel.vue'), 'utf8')
ok('§3 StateMilesPanel orders its columns with periodsNewestFirst()', /periodsNewestFirst\(data\.value\?\.periods\)/.test(PANEL))

// ══ the component reads the order from the helper, and adds nothing up ═══════
const SFC = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'financials', 'FleetPnlTable.vue'), 'utf8')
ok('FleetPnlTable orders its columns with periodsNewestFirst()', /periodsNewestFirst\(props\.report\.periods\)/.test(SFC))
const script = (/<script setup>([\s\S]*)<\/script>/.exec(SFC) || [])[1] || ''
ok('FleetPnlTable does no money arithmetic (no reduce, no += on figures)', !/\.reduce\(|\+=/.test(script))

console.log(`\nfleet-pnl-newest-first: ${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
