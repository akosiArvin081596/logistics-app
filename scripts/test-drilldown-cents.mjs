#!/usr/bin/env node
// The Financials month drill-down shows its driver rows and its headline to
// the cent, so the rows add up to the headline on the page as they do on the
// server (scripts/test-financials-books.js checks the server's rows):
//
//   §1 formatCurrencyCents(): two decimals, the sign before the $, thousands
//      separators, and a value that rounds to zero shows no minus.
//   §2 MonthDetailModal.vue formats the four headline figures and the driver
//      rows' pay, revenue, margin, invoiced and adjustments with it.
//
// Pure: imports client/src/utils/format.js and reads the component's source.
// Run: node scripts/test-drilldown-cents.mjs    # exits 1 on failure
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { formatCurrency, formatCurrencyCents } = await import(pathToFileURL(path.join(ROOT, 'client/src/utils/format.js')).href)

let pass = 0, fail = 0
function check(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`) } else { fail++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('§1 formatCurrencyCents()')
const cases = [[741.8, '$741.80'], [10.45, '$10.45'], [-4200.5, '-$4,200.50'], [1234567.891, '$1,234,567.89'], [0, '$0.00'], [-0.001, '$0.00'], [null, '$0.00'], ['12.5', '$12.50']]
for (const [v, want] of cases) check(formatCurrencyCents(v) === want, `${JSON.stringify(v)} → ${want}`, formatCurrencyCents(v))
check(formatCurrency(741.8) === '$742', 'formatCurrency() still rounds to whole dollars elsewhere', formatCurrency(741.8))

console.log('§2 MonthDetailModal.vue')
const src = fs.readFileSync(path.join(ROOT, 'client/src/components/financials/MonthDetailModal.vue'), 'utf8')
for (const f of ['revenue', 'totalExpenses', 'driverPay', 'netProfit']) {
  check(src.includes(`{{ fmtCents(detail.summary.${f}) }}`), `the headline's ${f} is shown to the cent`)
}
for (const f of ['pay', 'revenue', 'margin', 'invoicedTotal']) {
  check(src.includes(`fmtCents(d.${f})`) && !src.includes(`fmt(d.${f})`), `the driver rows' ${f} is shown to the cent`)
}
check(src.includes('signedCents(d.adjustments)'), "the driver rows' invoice adjustments are shown to the cent")

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
