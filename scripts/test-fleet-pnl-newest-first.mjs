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
// Compile a committed SFC's <script setup> + <template>. A .vue import becomes an
// empty stub; a relative .js import is loaded from ROOT.
async function compileComponent(rel) {
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
    if (spec.endsWith('.vue')) deps[spec] = { default: Vue.defineComponent({ name: path.basename(spec, '.vue'), render: () => null }) }
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

// ══ the component reads the order from the helper, and adds nothing up ═══════
const SFC = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'financials', 'FleetPnlTable.vue'), 'utf8')
ok('FleetPnlTable orders its columns with periodsNewestFirst()', /periodsNewestFirst\(props\.report\.periods\)/.test(SFC))
const script = (/<script setup>([\s\S]*)<\/script>/.exec(SFC) || [])[1] || ''
ok('FleetPnlTable does no money arithmetic (no reduce, no += on figures)', !/\.reduce\(|\+=/.test(script))

console.log(`\nfleet-pnl-newest-first: ${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
