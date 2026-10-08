#!/usr/bin/env node
// The investor's Fleet Breakdown shows each truck the server's own figures
// (2026-10-04).
//
// WHY THIS EXISTS. A truck's expanded breakdown worked money out in the browser
// and pinned pay on the wrong truck:
//   • Fixed Costs was fixedCosts(): the server's monthly expenses, minus the
//     driver's pay divided by the FLEET's months, minus trip expenses, all in the
//     browser. The backend is the source of every money figure.
//   • Driver Pay was the current driver's whole pay, looked up by the truck's
//     assigned driver, so a truck that earned nothing (a new truck, or one whose
//     driver moved) read "Revenue (0 loads) $0" over "Driver Pay −$670", while
//     the truck that hauled those loads showed none.
//   • A driver with no pay entry read "(0 days x $250)".
//
//   §1 GET /api/investor sends, per truck, the pay earned on that truck, its
//      basis, and the fixed costs (read from server.js)
//   §2 FleetBreakdownSection.vue, rendered with Vue's server renderer: the
//      figures are the server's, pay sits on the truck that earned it, and a
//      truck with none reads "No pay this period"
//   §3 the component computes no money
//   §4 (2026-10-08) the expanded row: labels and values in two columns, each
//      truck's own months on its sub-line, Monthly Net, Est. Annual Take-Home
//      (Monthly Net x 12, with a note saying so), ROI and the fleet totals as
//      the server sends them; and with no investor in view (a Super Admin's
//      fleet-wide page) a note instead of $0 rows
//
// No DOM, no server.
//   node scripts/test-fleet-breakdown-truck-pay.mjs
//   LOGISX_ROOT=/tmp/base node scripts/test-fleet-breakdown-truck-pay.mjs   # a base checkout: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}

// ══ §1 — the server sends the per-truck figures ══════════════════════════════
{
  const server = read('server.js')
  const at = server.indexOf('perTruckData[truck.unit_number] = {')
  const block = at < 0 ? '' : server.slice(at, server.indexOf('};', at))
  ok('§1 perTruckData is still built per owned truck', at > 0)
  for (const key of ['unitMonthlyDriverPay', 'unitMonthlyFixedCosts', 'driverPay']) {
    ok(`§1 each truck carries ${key}`, new RegExp(`\\b${key}:`).test(block))
  }
}

// ══ §2 — the breakdown, rendered ═════════════════════════════════════════════
const clientRequire = createRequire(path.join(ROOT, 'client', 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const { renderToString } = clientRequire('vue/server-renderer')

// `source` rewrites the file before it is compiled (the open row, below).
async function compileComponent(rel, source = null) {
  const file = path.join(ROOT, rel)
  const dir = path.dirname(file)
  const { descriptor } = parse(source ?? fs.readFileSync(file, 'utf8'), { filename: path.basename(file) })
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
  const deps = { vue: Vue }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec.endsWith('.vue')) deps[spec] = { default: stub(path.basename(spec, '.vue')) }
    else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', body)(deps)
}
const text = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
// The breakdown's rows as { label, value }: the label column and the value
// column of each `.bd-row`, as rendered.
function rowsOf(html) {
  const out = []
  for (const m of html.matchAll(/<div class="bd-row[^"]*"[^>]*>([\s\S]*?)<\/div>/g)) {
    const at = m[1].indexOf('class="bd-val')
    out.push({ label: text(at < 0 ? m[1] : m[1].slice(0, m[1].lastIndexOf('<', at))), value: at < 0 ? '' : text(m[1].slice(m[1].lastIndexOf('<', at))) })
  }
  return out
}
const rowOf = (rows, label) => rows.find((r) => r.label.includes(label)) || { label: '', value: '' }

// One fleet. The server's per-truck figures sit beside the per-driver ones the
// old breakdown read, which disagree with them on purpose.
//   T-OLD hauled Dee's loads: $5,000 a month, $900 of it Dee's pay.
//   T-NEW was just given to Dee and has hauled nothing.
//   T-PCT is Pat's, paid a share.
//   T-IDLE has no driver.
// The trucks list's PurchasePrice (60,000 on T-OLD) is what the browser used to
// divide by; the server's ROI is over the truck's own price in perTruckData.
const TRUCKS = [
  { id: 1, UnitNumber: 'T-OLD', AssignedDriver: '', Status: 'Active', PurchasePrice: 60000 },
  { id: 2, UnitNumber: 'T-NEW', AssignedDriver: 'Dee Dayrate', Status: 'Active' },
  { id: 3, UnitNumber: 'T-PCT', AssignedDriver: 'Pat Percent', Status: 'Active' },
  { id: 4, UnitNumber: 'T-IDLE', AssignedDriver: '', Status: 'Active' },
]
const PRODUCTION = {
  monthsOfOperation: 10,
  perTruckScope: 'investor',
  // The server's Fleet Total and Fleet ROI (the trucks with a projection, over
  // the fleet's recorded prices).
  fleetEstAnnualInvestorRevenue: 21000,
  fleetInvestorROI: 8.8,
  driverPayDetails: {
    'dee dayrate': { activeDays: 36, dailyRate: 250, totalPay: 9000, payType: 'fixed', payPercentage: 0 },
    'pat percent': { activeDays: 20, dailyRate: 0, totalPay: 6700, payType: 'percentage', payPercentage: 20 },
  },
  perTruckData: {
    // T-OLD's figures are averaged on its own 7 months, not the fleet's 10.
    'T-OLD': {
      unitMonthlyGross: 5000, unitMonthlyExpenses: 3100, unitMonthlyTripExpenses: 400,
      unitMonthlyDriverPay: 900, unitMonthlyFixedCosts: 1800, loadCount: 30, estAnnualInvestorRevenue: 12000,
      unitMonthlyNet: 1900, unitEstAnnualTakeHome: 22800, months: 7, purchasePrice: 80000, investorROI: 15,
      driverPay: { months: 10, totalPay: 9000, drivers: [{ name: 'Dee Dayrate', payType: 'fixed', payPercentage: 0, activeDays: 36, dailyRate: 250, totalPay: 9000 }] },
    },
    'T-NEW': {
      unitMonthlyGross: 0, unitMonthlyExpenses: 0, unitMonthlyTripExpenses: 0,
      unitMonthlyDriverPay: 0, unitMonthlyFixedCosts: 0, loadCount: 0, estAnnualInvestorRevenue: null,
      unitMonthlyNet: 0, unitEstAnnualTakeHome: 0, months: 1, purchasePrice: 90000, investorROI: null,
      driverPay: null,
    },
    'T-PCT': {
      unitMonthlyGross: 4000, unitMonthlyExpenses: 2470, unitMonthlyTripExpenses: 300,
      unitMonthlyDriverPay: 670, unitMonthlyFixedCosts: 1500, loadCount: 20, estAnnualInvestorRevenue: 9000,
      unitMonthlyNet: 1530, unitEstAnnualTakeHome: 18360, months: 10, purchasePrice: 70000, investorROI: 12.9,
      driverPay: { months: 10, totalPay: 6700, drivers: [{ name: 'Pat Percent', payType: 'percentage', payPercentage: 20, activeDays: 20, dailyRate: 0, totalPay: 6700 }] },
    },
    'T-IDLE': {
      unitMonthlyGross: 0, unitMonthlyExpenses: 1200, unitMonthlyTripExpenses: 0,
      unitMonthlyDriverPay: 0, unitMonthlyFixedCosts: 1200, loadCount: 0, estAnnualInvestorRevenue: 0,
      unitMonthlyNet: -1200, unitEstAnnualTakeHome: -14400, months: 10, purchasePrice: 0, investorROI: 0,
      driverPay: null,
    },
  },
}

const REL = 'client/src/components/investor/FleetBreakdownSection.vue'
// A truck's breakdown is the row a click opens, and the open row is
// `expandedUnit`. Compiled with that ref starting on the truck asked for, so the
// row renders open; the rest of the file is as committed.
const OPEN_ROW = 'const expandedUnit = ref(null)'
const SOURCE = read(...REL.split('/'))
ok('§2 FleetBreakdownSection.vue still keeps the open row in expandedUnit', SOURCE.includes(OPEN_ROW))
let Comp = null
try {
  Comp = await compileComponent(REL, SOURCE.replace(OPEN_ROW, 'const expandedUnit = ref(globalThis.__openUnit ?? null)'))
} catch (err) { ok(`§2 FleetBreakdownSection.vue compiles in this harness (${err.message})`, false) }
if (Comp) {
  const render = (production = PRODUCTION) => renderToString(Vue.createSSRApp(Comp, { trucks: TRUCKS, production }))
  // The open row's HTML.
  async function expandedHtml(unit) {
    globalThis.__openUnit = unit
    const html = await render()
    const from = html.indexOf('class="truck-detail"')
    return from < 0 ? '' : html.slice(from, html.indexOf('</tr>', from))
  }
  const expanded = async (unit) => text(await expandedHtml(unit))
  const old = await expanded('T-OLD')
  const oldRows = rowsOf(await expandedHtml('T-OLD'))
  ok('§2 the breakdown renders when a truck is expanded', old.includes('T-OLD'))
  ok(`§2 T-OLD: Fixed Costs is the server's $1,800 (got "${rowOf(oldRows, 'Fixed Costs').value}")`, rowOf(oldRows, 'Fixed Costs').value === '-$1,800')
  ok(`§2 T-OLD: Driver Pay is the $900 a month earned on it (got "${rowOf(oldRows, 'Driver Pay').value}")`, rowOf(oldRows, 'Driver Pay').value === '-$900')
  ok('§2 T-OLD: the basis names the days and rate, over the months averaged', rowOf(oldRows, 'Driver Pay').label.includes('(36 days x $250 over 10 months)'))
  const fresh = await expanded('T-NEW')
  ok(`§2 T-NEW (no loads yet): no driver pay, though Dee is its driver now (got "${rowOf(rowsOf(await expandedHtml('T-NEW')), 'Driver Pay').value}")`,
    !/9,000|\$900|\$670/.test(fresh) && fresh.includes('No pay this period'))
  ok('§2 T-NEW: …and not "(0 days x $250)"', !fresh.includes('0 days x $250'))
  const pct = await expanded('T-PCT')
  const pctRows = rowsOf(await expandedHtml('T-PCT'))
  ok('§2 T-PCT: a share-paid driver keeps the share wording', pct.includes('(20% of revenue after deductible trip expenses)') && rowOf(pctRows, 'Driver Pay').value === '-$670')
  ok('§2 T-PCT: Fixed Costs is the server\'s $1,500', rowOf(pctRows, 'Fixed Costs').value === '-$1,500')
  const idle = await expanded('T-IDLE')
  ok('§2 T-IDLE (no driver): "No pay this period", not "(0 days x $250)"', idle.includes('No pay this period') && !idle.includes('0 days x $250'))
  ok('§2 T-IDLE: Fixed Costs is the server\'s $1,200', rowOf(rowsOf(await expandedHtml('T-IDLE')), 'Fixed Costs').value === '-$1,200')

  // ══ §4 — the expanded row's bottom lines, the months, ROI and the totals ═══
  ok(`§4 T-OLD's sub-line counts its own 7 months, not the fleet's 10 (got "${(/Monthly avg based on [^·]*?months?/.exec(old) || [''])[0]}")`,
    old.includes('Monthly avg based on 7 months') && !old.includes('based on 10 months'))
  ok(`§4 T-OLD: Monthly Net is the server's $1,900 (got "${rowOf(oldRows, 'Monthly Net').value}")`, rowOf(oldRows, 'Monthly Net').value === '$1,900')
  const annual = rowOf(oldRows, 'Est. Annual Take-Home')
  ok(`§4 T-OLD: Est. Annual Take-Home is the server's Monthly Net x 12, $22,800 (got "${annual.value}")`, annual.value === '$22,800')
  ok(`§4 …with a note beside it saying how it is reached (got "${annual.label}")`, /Monthly Net × 12/.test(annual.label))
  ok(`§4 T-OLD: ROI is the server's +15.0%, over its own $80,000 (got "${rowOf(oldRows, 'ROI').value}", "${rowOf(oldRows, 'ROI').label}")`,
    rowOf(oldRows, 'ROI').value === '+15.0%' && rowOf(oldRows, 'ROI').label.includes('$12,000') && rowOf(oldRows, 'ROI').label.includes('$80,000'))
  const freshRows = rowsOf(await expandedHtml('T-NEW'))
  ok(`§4 T-NEW (no projection yet): ROI "—", Est. Annual Take-Home still the server's $0 (got "${rowOf(freshRows, 'ROI').value}", "${rowOf(freshRows, 'Est. Annual Take-Home').value}")`,
    rowOf(freshRows, 'ROI').value === '—' && rowOf(freshRows, 'Est. Annual Take-Home').value === '$0' && fresh.includes('No projection yet'))
  ok(`§4 T-NEW's sub-line: 1 month (got "${(/Monthly avg based on [^·]*?months?/.exec(fresh) || [''])[0]}")`, fresh.includes('Monthly avg based on 1 month') && !fresh.includes('1 months'))
  ok(`§4 every row has one label and one value column, notes aside (rows: ${oldRows.map((r) => r.value || '·').join(' | ')})`,
    oldRows.filter((r) => r.value).length === 7 && oldRows.every((r) => !/[a-z]/i.test(r.value.replace(/months|—/g, ''))))
  globalThis.__openUnit = null
  const table = text(await render())
  ok(`§4 the ROI column shows the server's +15.0% for T-OLD, not a ratio over the trucks list's price (+20.0%)`, table.includes('+15.0%') && !table.includes('+20.0%'))
  ok(`§4 the Fleet Total and Fleet ROI are the server's ($21,000, +8.8%)`, /Fleet Total[^$]*\$21,000/.test(table) && table.includes('+8.8%'))
  const fleetWide = text(await render({ ...PRODUCTION, perTruckScope: 'fleet', perTruckData: {} }))
  ok('§4 no investor in view (a Super Admin\'s fleet-wide page): the note, not a table of $0 rows',
    fleetWide.includes('Per-truck figures are per investor. Open an investor\'s portal to see each truck\'s figures.') && !fleetWide.includes('Fleet Total'))
  ok('§4 an investor\'s page never shows that note', !table.includes('Per-truck figures are per investor'))
}

// ══ §3 — no money is worked out in the component ═════════════════════════════
{
  const src = read(...REL.split('/'))
  ok('§3 FleetBreakdownSection.vue has no fixedCosts() subtraction', !/function fixedCosts\([^)]*\)\s*\{[^}]*-/.test(src))
  ok('§3 …and does not divide a driver\'s pay in the browser', !/driverPay\([^)]*\)\s*\/\s*\(/.test(src))
  const script = src.slice(src.indexOf('<script setup>'), src.indexOf('</script>'))
  ok('§3 …nor subtract expenses from revenue for Monthly Net', !/unitMonthlyGross[^\n]*-[^\n]*unitMonthlyExpenses/.test(script))
  ok('§3 …nor work out an ROI from a price', !/\/\s*truckPrice|estRevenue\s*\/|\/\s*totalPrice|\*\s*100\b/.test(script))
  ok('§3 …nor add up the Fleet Total', !/\.reduce\([^\n]*estRevenue/.test(script))
}

// ══ §4 — the expanded row is styled as two columns ═══════════════════════════
{
  const style = SOURCE.slice(SOURCE.indexOf('<style scoped>'))
  const rule = (sel) => (new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(style) || [])[2] || ''
  ok('§4 .bd-row is a two-column grid (label, value)', /display:\s*grid/.test(rule('.bd-row')) && /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/.test(rule('.bd-row')))
  ok('§4 .bd-val is right-aligned in the table\'s monospace', /text-align:\s*right/.test(rule('.bd-val')) && /JetBrains Mono/.test(rule('.bd-val')))
}

console.log(`\nfleet-breakdown-truck-pay: ${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
