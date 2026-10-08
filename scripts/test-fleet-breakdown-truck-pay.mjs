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

// One fleet. The server's per-truck figures sit beside the per-driver ones the
// old breakdown read, which disagree with them on purpose.
//   T-OLD hauled Dee's loads: $5,000 a month, $900 of it Dee's pay.
//   T-NEW was just given to Dee and has hauled nothing.
//   T-PCT is Pat's, paid a share.
//   T-IDLE has no driver.
const TRUCKS = [
  { id: 1, UnitNumber: 'T-OLD', AssignedDriver: '', Status: 'Active' },
  { id: 2, UnitNumber: 'T-NEW', AssignedDriver: 'Dee Dayrate', Status: 'Active' },
  { id: 3, UnitNumber: 'T-PCT', AssignedDriver: 'Pat Percent', Status: 'Active' },
  { id: 4, UnitNumber: 'T-IDLE', AssignedDriver: '', Status: 'Active' },
]
const PRODUCTION = {
  monthsOfOperation: 10,
  driverPayDetails: {
    'dee dayrate': { activeDays: 36, dailyRate: 250, totalPay: 9000, payType: 'fixed', payPercentage: 0 },
    'pat percent': { activeDays: 20, dailyRate: 0, totalPay: 6700, payType: 'percentage', payPercentage: 20 },
  },
  perTruckData: {
    'T-OLD': {
      unitMonthlyGross: 5000, unitMonthlyExpenses: 3100, unitMonthlyTripExpenses: 400,
      unitMonthlyDriverPay: 900, unitMonthlyFixedCosts: 1800, loadCount: 30, estAnnualInvestorRevenue: 12000,
      driverPay: { months: 10, totalPay: 9000, drivers: [{ name: 'Dee Dayrate', payType: 'fixed', payPercentage: 0, activeDays: 36, dailyRate: 250, totalPay: 9000 }] },
    },
    'T-NEW': {
      unitMonthlyGross: 0, unitMonthlyExpenses: 0, unitMonthlyTripExpenses: 0,
      unitMonthlyDriverPay: 0, unitMonthlyFixedCosts: 0, loadCount: 0, estAnnualInvestorRevenue: null,
      driverPay: null,
    },
    'T-PCT': {
      unitMonthlyGross: 4000, unitMonthlyExpenses: 2470, unitMonthlyTripExpenses: 300,
      unitMonthlyDriverPay: 670, unitMonthlyFixedCosts: 1500, loadCount: 20, estAnnualInvestorRevenue: 9000,
      driverPay: { months: 10, totalPay: 6700, drivers: [{ name: 'Pat Percent', payType: 'percentage', payPercentage: 20, activeDays: 20, dailyRate: 0, totalPay: 6700 }] },
    },
    'T-IDLE': {
      unitMonthlyGross: 0, unitMonthlyExpenses: 1200, unitMonthlyTripExpenses: 0,
      unitMonthlyDriverPay: 0, unitMonthlyFixedCosts: 1200, loadCount: 0, estAnnualInvestorRevenue: 0,
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
  async function expanded(unit) {
    globalThis.__openUnit = unit
    const html = await renderToString(Vue.createSSRApp(Comp, { trucks: TRUCKS, production: PRODUCTION, asset: {} }))
    const from = html.indexOf('class="truck-detail"')
    return from < 0 ? '' : text(html.slice(from, html.indexOf('</tr>', from)))
  }
  const old = await expanded('T-OLD')
  ok('§2 the breakdown renders when a truck is expanded', old.includes('T-OLD'))
  ok(`§2 T-OLD: Fixed Costs is the server's $1,800 (got "${(/Fixed Costs ([^A-Z]*)/.exec(old) || [])[1] || ''}")`, /Fixed Costs -\$1,800/.test(old))
  ok(`§2 T-OLD: Driver Pay is the $900 a month earned on it (got "${(/Driver Pay ([^A-Z]*)/.exec(old) || [])[1] || ''}")`, /Driver Pay -\$900/.test(old))
  ok('§2 T-OLD: the basis names the days and rate, over the months averaged', old.includes('(36 days x $250 over 10 months)'))
  const fresh = await expanded('T-NEW')
  ok(`§2 T-NEW (no loads yet): no driver pay, though Dee is its driver now (got "${(/Driver Pay ([^A-Z]*)/.exec(fresh) || [])[1] || ''}")`,
    !/9,000|\$900|\$670/.test(fresh) && fresh.includes('No pay this period'))
  ok('§2 T-NEW: …and not "(0 days x $250)"', !fresh.includes('0 days x $250'))
  const pct = await expanded('T-PCT')
  ok('§2 T-PCT: a share-paid driver keeps the share wording', pct.includes('(20% of revenue after deductible trip expenses)') && /Driver Pay -\$670/.test(pct))
  ok('§2 T-PCT: Fixed Costs is the server\'s $1,500', /Fixed Costs -\$1,500/.test(pct))
  const idle = await expanded('T-IDLE')
  ok('§2 T-IDLE (no driver): "No pay this period", not "(0 days x $250)"', idle.includes('No pay this period') && !idle.includes('0 days x $250'))
  ok('§2 T-IDLE: Fixed Costs is the server\'s $1,200', /Fixed Costs -\$1,200/.test(idle))
}

// ══ §3 — no money is worked out in the component ═════════════════════════════
{
  const src = read(...REL.split('/'))
  ok('§3 FleetBreakdownSection.vue has no fixedCosts() subtraction', !/function fixedCosts\([^)]*\)\s*\{[^}]*-/.test(src))
  ok('§3 …and does not divide a driver\'s pay in the browser', !/driverPay\([^)]*\)\s*\/\s*\(/.test(src))
}

console.log(`\nfleet-breakdown-truck-pay: ${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
