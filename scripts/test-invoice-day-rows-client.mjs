#!/usr/bin/env node
// B23 / R13, the client's side (the user, 2026-10-23; product-decisions.md,
// "Weekly invoice day rows"): what an invoice's counts hold, as the Invoices
// panel, its table and the driver's invoice card say it.
//
// A weekly invoice row's loads_count and rate_per_load hold different things by
// its pay basis (GET /api/invoices and GET /api/driver/:driverName send
// pay_basis; the Invoices list also load_count, load_ids' length):
//   daily       loads_count = days paid, rate_per_load = the daily rate
//   percentage  loads_count = loads, rate_per_load = the pay %
//   manual      loads_count = line items, no rate
// They used to read "Loads" and "Rate / load" whatever the basis, so a week of
// 7 paid days over 6 loads at $300 a day read "Loads 7, Rate / load $300.00".
//
//   §1 invoiceCountRows() (client/src/lib/invoiceCounts.js), the panel's rows:
//      daily "Days paid / Daily rate / Loads", percentage "Loads / Pay %",
//      manual "Line items"; a row without pay_basis reads as daily unless it is
//      manual; a load count not sent shows a dash
//   §2 PARITY — the same labels and values, in the same order, as server.js's
//      invoiceCountRows() (the submit email's rows), lifted from the source, on
//      the same rows; the daily rate formatted the same ("$1,250.00")
//   §3 invoiceCardCount(), the driver's card: "7 days", "3 loads", "2 line items"
//   §4 invoiceLoadsCell(), the table's Loads column: a daily row's load_count
//   §5 the wiring: the panel, the table and the card use them, and no
//      "Rate / load" label is left
//
// Every case fails on the base (no client/src/lib/invoiceCounts.js). Made-up
// data only. No network, no DOM, no Vue runtime.
//
//   node scripts/test-invoice-day-rows-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const require = createRequire(import.meta.url)
const { closure } = require('./lib/server-lift.js')

let pass = 0
let fail = 0
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`ok    ${label}`) }
  else { fail++; console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`) }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(label, a === e, `expected ${e}\n        actual   ${a}`)
}

const LIB = path.join(ROOT, 'client', 'src', 'lib', 'invoiceCounts.js')
let lib = null
try { lib = await import(pathToFileURL(LIB).href) } catch (e) { ok('client/src/lib/invoiceCounts.js loads', false, String(e && e.message).split('\n')[0]) }

const DAILY = { invoice_number: 'INV-NB-DAILY', pay_basis: 'daily', is_manual: 0, loads_count: 7, rate_per_load: 300, load_count: 6, load_ids: JSON.stringify(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']), render_data: JSON.stringify({ __templateName: 'service_invoice' }) }
const PCT = { invoice_number: 'INV-NB-PCT', pay_basis: 'percentage', is_manual: 0, loads_count: 3, rate_per_load: 30, load_count: 3, load_ids: JSON.stringify(['P1', 'P2', 'P3']), render_data: JSON.stringify({ __templateName: 'service_invoice_owner_op' }) }
const PCT_HALF = { ...PCT, rate_per_load: 27.5 }
const MANUAL = { invoice_number: 'INV-M-NB-01', pay_basis: 'manual', is_manual: 1, loads_count: 2, rate_per_load: 0, load_count: 0, load_ids: '[]', render_data: JSON.stringify({ __templateName: 'service_invoice_manual' }) }
const ONE_DAY = { ...DAILY, invoice_number: 'INV-NB-ONEDAY', loads_count: 1, load_count: 1, load_ids: JSON.stringify(['L9']), rate_per_load: 1250 }

// §1
if (lib) {
  const rows = (inv) => lib.invoiceCountRows(inv).map((r) => [r.label, r.value])
  eq('§1 daily: Days paid, Daily rate, Loads', rows(DAILY), [['Days paid', '7'], ['Daily rate', '$300.00'], ['Loads', '6']])
  eq('§1 daily: a rate over $1,000 reads as the panel prints money', rows(ONE_DAY), [['Days paid', '1'], ['Daily rate', '$1,250.00'], ['Loads', '1']])
  eq('§1 percentage: Loads, Pay %', [rows(PCT), rows(PCT_HALF)], [[['Loads', '3'], ['Pay %', '30%']], [['Loads', '3'], ['Pay %', '27.5%']]])
  eq('§1 manual: Line items only', rows(MANUAL), [['Line items', '2']])
  eq('§1 no pay_basis (a row from a create answer): manual by is_manual, else daily; no load count sent shows a dash',
    [rows({ is_manual: 1, loads_count: 4 }), rows({ is_manual: 0, loads_count: 5, rate_per_load: 280 })],
    [[['Line items', '4']], [['Days paid', '5'], ['Daily rate', '$280.00'], ['Loads', '—']]])
  eq('§1 invoicePayBasisOf(): the server\'s basis; an unknown one reads by is_manual',
    [DAILY, PCT, MANUAL, { pay_basis: 'other', is_manual: 1 }, null].map(lib.invoicePayBasisOf), ['daily', 'percentage', 'manual', 'manual', 'daily'])
}

// §2
let server = null
try {
  const SRC = require('./lib/server-source.js').serverSource()
  const lift = closure(SRC, { roots: ['invoiceCountRows'] })
  server = new Function(`"use strict";\n${lift.text}\nreturn invoiceCountRows;`)()
} catch (e) {
  ok('§2 server.js has invoiceCountRows(), liftable on its own', false, String(e && e.message).split('\n')[0])
}
if (lib && server) {
  for (const inv of [DAILY, PCT, MANUAL, ONE_DAY]) {
    eq(`§2 ${inv.invoice_number} (${inv.pay_basis}): the panel's labels are the submit email's`,
      lib.invoiceCountRows(inv).map((r) => r.label), server(inv).map((r) => r[0]))
    eq(`§2 ${inv.invoice_number} (${inv.pay_basis}): the panel's values are the submit email's, formatted the same`,
      server(inv).map((r) => r[1]), lib.invoiceCountRows(inv).map((r) => r.value))
  }
  eq('§2 the submit email prints a daily rate over $1,000 as the panel does (en-US, comma thousands, 2 decimals)',
    server(ONE_DAY)[1], ['Daily rate', '$1,250.00'])
  eq('§2 the server reads a stored percentage invoice as one, a manual one as manual, an old row as daily',
    [server({ ...PCT, pay_basis: undefined }).map((r) => r[0]), server({ ...MANUAL, pay_basis: undefined }).map((r) => r[0]), server({ is_manual: 0, render_data: '' }).map((r) => r[0])],
    [['Loads', 'Pay %'], ['Line items'], ['Days paid', 'Daily rate', 'Loads']])
}

// §3, §4
if (lib) {
  eq('§3 the card: daily "N day(s)", percentage "N load(s)", manual "N line item(s)"',
    [DAILY, ONE_DAY, PCT, { ...PCT, loads_count: 1 }, MANUAL, { ...MANUAL, loads_count: 1 }, { ...DAILY, loads_count: 0 }].map(lib.invoiceCardCount),
    ['7 days', '1 day', '3 loads', '1 load', '2 line items', '1 line item', '0 days'])
  eq('§4 the table\'s Loads column: a daily row\'s load_count (a dash when not sent), a percentage row\'s loads, a manual row\'s line items as before',
    [DAILY, { ...DAILY, load_count: undefined }, PCT, MANUAL].map(lib.invoiceLoadsCell), ['6', '—', '3', '2'])
}

// §5
{
  const view = read('client/src/views/InvoicesView.vue')
  const card = read('client/src/components/driver/InvoiceCard.vue')
  ok('§5 InvoicesView.vue imports invoiceCountRows and invoiceLoadsCell from lib/invoiceCounts', /import \{ invoiceCountRows, invoiceLoadsCell \} from '\.\.\/lib\/invoiceCounts'/.test(view))
  ok('§5 the panel prints invoiceCountRows(selectedInvoice), one meta-row each', /v-for="row in invoiceCountRows\(selectedInvoice\)"/.test(view))
  ok('§5 the table\'s Loads cell prints invoiceLoadsCell(inv)', /\{\{ invoiceLoadsCell\(inv\) \}\}/.test(view))
  ok('§5 no "Rate / load" label, and no Loads / Line items label picked in the template', !/Rate \/ load/.test(view) && !/is_manual \? 'Line items' : 'Loads'/.test(view))
  ok('§5 InvoiceCard.vue prints invoiceCardCount(invoice)', /\{\{ invoiceCardCount\(invoice\) \}\}/.test(card) && /import \{ invoiceCardCount \} from '\.\.\/\.\.\/lib\/invoiceCounts'/.test(card))
  ok('§5 the card no longer says "load(s)" of every invoice', !/loads_count \}\} load\{\{/.test(card))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
