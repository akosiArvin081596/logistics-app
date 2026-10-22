#!/usr/bin/env node
// The investor portal's wide tables scroll sideways inside their own box on a
// phone, so every column can be reached (2026-10-22).
//
// WHY THIS EXISTS. The investor page sits in .admin-page, which has
// overflow-x: hidden so the page itself never scrolls sideways. At 390 px the
// Expenses table (9 columns, about 702 px) sat straight inside its section with
// no scroll box of its own, so everything right of about x=366 was clipped: an
// investor on a phone never saw the Receipt column. My Trucks, Fleet Breakdown
// and Legal Documents put their tables in the same place the same way, and the
// Trucks page an investor reaches from My Trucks (TruckTable) sat in a .card
// that clips. The Production / Revenue Trends row used a 1fr grid track that
// grew to the 12-month chart's min-content and pushed both sections off a phone.
//
//   §1 every <table> in those components (and Payouts, which already scrolled)
//      sits inside an element whose class scrolls sideways (overflow-x
//      auto/scroll), from the component's own styles or the shared
//      .table-wrapper rule
//   §2 the page itself still never scrolls sideways: .admin-page keeps
//      overflow-x: hidden, and .investor-dashboard adds no overflow of its own
//   §3 at <= 900 px .sections-row's one column is minmax(0, 1fr); desktop keeps
//      1fr 1fr
//
// The components' own markup and styles, parsed with the client's compiler and
// postcss. No DOM, no browser.
//   node scripts/test-investor-tables-phone-scroll.mjs
//   EXPENSES_SECTION_VUE=/tmp/base/ExpensesSection.vue node scripts/test-investor-tables-phone-scroll.mjs   # a base copy: fails
//   (also MY_TRUCKS_VUE, FLEET_BREAKDOWN_VUE, LEGAL_DOCUMENT_PORTAL_VUE, TRUCK_TABLE_VUE,
//    PAYOUTS_SECTION_VUE, INVESTOR_VIEW_VUE, SHARED_CSS)
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, '..')
const CLIENT_DIR = path.join(ROOT, 'client')
const SRC = path.join(CLIENT_DIR, 'src')
const INVESTOR = path.join(SRC, 'components', 'investor')

const TABLE_FILES = [
  ['ExpensesSection', process.env.EXPENSES_SECTION_VUE || path.join(INVESTOR, 'ExpensesSection.vue')],
  ['MyTrucks', process.env.MY_TRUCKS_VUE || path.join(INVESTOR, 'MyTrucks.vue')],
  ['FleetBreakdownSection', process.env.FLEET_BREAKDOWN_VUE || path.join(INVESTOR, 'FleetBreakdownSection.vue')],
  ['LegalDocumentPortal', process.env.LEGAL_DOCUMENT_PORTAL_VUE || path.join(INVESTOR, 'LegalDocumentPortal.vue')],
  // Investors reach it from My Trucks -> /trucks; .card clips its overflow.
  ['TruckTable', process.env.TRUCK_TABLE_VUE || path.join(SRC, 'components', 'trucks', 'TruckTable.vue')],
  // Already scrolled on main (.table-wrap, .ld-scroll): kept here so it stays so.
  ['PayoutsSection', process.env.PAYOUTS_SECTION_VUE || path.join(INVESTOR, 'PayoutsSection.vue')],
]
const INVESTOR_VIEW_VUE = process.env.INVESTOR_VIEW_VUE || path.join(SRC, 'views', 'InvestorView.vue')
const SHARED_CSS = process.env.SHARED_CSS || path.join(SRC, 'assets', 'shared.css')

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}
function eq(name, actual, expected) {
  ok(`${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`, actual === expected)
}

const clientRequire = createRequire(path.join(CLIENT_DIR, 'package.json'))
const { parse } = clientRequire('vue/compiler-sfc')
const postcss = clientRequire('postcss')

function load(file) {
  const { descriptor, errors } = parse(fs.readFileSync(file, 'utf8'), { filename: file })
  if (errors.length) throw new Error(`${file}: ${errors[0].message || errors[0]}`)
  const css = descriptor.styles.map((s) => s.content).join('\n')
  return { descriptor, root: postcss.parse(css) }
}

// Every declaration of `prop` in the top-level rules whose selector list names
// exactly `selector`, in source order (a later one wins in the browser).
function decls(root, selector, prop) {
  const out = []
  root.each((node) => {
    if (node.type !== 'rule') return
    if (!node.selectors.map((s) => s.trim()).includes(selector)) return
    node.walkDecls(prop, (d) => out.push(d.value.replace(/\s+/g, ' ').trim()))
  })
  return out
}
const last = (list) => list[list.length - 1]
const SCROLLS = new Set(['auto', 'scroll'])
// The sideways overflow a class sets: overflow-x, or the first value of the
// overflow shorthand, whichever comes later. With neither, an overflow-y other
// than visible makes the browser compute overflow-x as auto.
function overflowX(root, cls) {
  const v = last(decls(root, `.${cls}`, /^overflow(-x)?$/))
  if (v) return v.split(' ')[0]
  const y = last(decls(root, `.${cls}`, 'overflow-y'))
  return y && y !== 'visible' ? 'auto' : undefined
}

const sharedRoot = postcss.parse(fs.readFileSync(SHARED_CSS, 'utf8'))

// A component's scoped rule beats the shared one for the same class.
function classScrollsX(componentRoot, cls) {
  const own = overflowX(componentRoot, cls)
  if (own !== undefined) return SCROLLS.has(own)
  return SCROLLS.has(overflowX(sharedRoot, cls))
}

function staticClasses(node) {
  const attr = (node.props || []).find((p) => p.type === 6 && p.name === 'class')
  return attr && attr.value ? attr.value.content.split(/\s+/).filter(Boolean) : []
}

// Each <table> in the template, with the static classes of every element above it.
function tables(descriptor) {
  const found = []
  function walk(node, ancestors) {
    if (node.type === 1 && node.tag === 'table') found.push({ node, ancestors })
    const next = node.type === 1 ? [...ancestors, node] : ancestors
    for (const child of node.children || []) walk(child, next)
  }
  walk(descriptor.template.ast, [])
  return found
}

console.log('§1 each investor table sits in a box that scrolls sideways')
for (const [name, file] of TABLE_FILES) {
  const { descriptor, root } = load(file)
  const list = tables(descriptor)
  ok(`${name}: has at least one <table>`, list.length > 0)
  list.forEach(({ node, ancestors }, i) => {
    const label = `${name}: table ${i + 1} (class "${staticClasses(node).join(' ')}")`
    const scroller = ancestors.find((a) => staticClasses(a).some((c) => classScrollsX(root, c)))
    ok(`${label} is inside an element with overflow-x auto or scroll`, !!scroller)
  })
}

console.log('§2 the page itself never scrolls sideways')
eq('shared.css .admin-page overflow-x', last(decls(sharedRoot, '.admin-page', 'overflow-x')), 'hidden')
const investorView = load(INVESTOR_VIEW_VUE)
eq('InvestorView .investor-dashboard declares no overflow', decls(investorView.root, '.investor-dashboard', /^overflow/).length, 0)

console.log('§3 on a phone the Production / Revenue Trends row fits the page')
{
  // The one-column track at <= 900 px must be allowed below its widest item's
  // min-content (minmax(0, ...)); a bare 1fr grows to the 12-month chart.
  const values = []
  investorView.root.walkAtRules('media', (at) => {
    if (!/max-width:\s*900px/.test(at.params)) return
    at.walkRules((rule) => {
      if (!rule.selectors.map((s) => s.trim()).includes('.sections-row')) return
      rule.walkDecls('grid-template-columns', (d) => values.push(d.value.replace(/\s+/g, ' ').trim()))
    })
  })
  ok('a max-width: 900px rule sets .sections-row grid-template-columns', values.length > 0)
  eq('.sections-row one-column track at <= 900 px', last(values), 'minmax(0, 1fr)')
  eq('.sections-row two columns on desktop unchanged', last(decls(investorView.root, '.sections-row', 'grid-template-columns')), '1fr 1fr')
}

if (failures.length) {
  console.log(`\n${failures.length} failed, ${pass} passed`)
  process.exit(1)
}
console.log(`\nAll ${pass} checks passed`)
