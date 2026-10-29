#!/usr/bin/env node
// Driver privacy PR B, the client's half: a PDF receipt's pages on the
// Expenses screen.
//
// What this pins:
//   1. lib/receiptPages.js names the server's codes and counts ("4 of 6 pages
//      kept by the office"), a page's line (released, kept, released anyway, a
//      lapsed release), the "Release anyway" question with the codes, and an
//      invoice's line; the mark reasons are the server's codes; a mark whose
//      withdrawal an invoice PDF refused is an error naming that invoice.
//   2. The panel is wired: ExpensesTab shows it under a PDF receipt; it reads
//      GET /api/expenses/:id/receipt-pages, marks one page per call, answers a
//      409 RECEIPT_PAGE_RELEASE_ANYWAY with a second "Release anyway" step that
//      sends the codes, and offers "Update invoice PDF" per invoice; it is shown
//      to a Super Admin only and hides on FEATURE_OFF; a mark's toast comes from
//      the server's withdrawal outcome, not the page view's invoice list.
//   3. Nothing is computed in the browser: no arithmetic on a server figure.
//
// No network, no DOM, no database.
//   node scripts/test-receipt-pages-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok    ${label}`); return }
  fail++
  console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`)
}
const section = (t) => console.log(`\n${t}`)

let lib = {}
try { lib = await import('../client/src/lib/receiptPages.js') } catch (err) { console.log(`  (client/src/lib/receiptPages.js could not be loaded: ${err.message})`) }
const call = (fn, ...args) => (typeof lib[fn] === 'function' ? lib[fn](...args) : { missing: fn })

section('1. the words for the server\'s codes and counts')
{
  check('counts: some pages kept by the office', call('receiptPagesCountsText', { readable: true, counts: { pages: 6, released: 2, office: 4 } }), '4 of 6 pages kept by the office')
  check('counts: every page reaches the driver', call('receiptPagesCountsText', { readable: true, counts: { pages: 3, released: 3, office: 0 } }), 'All 3 pages reach the driver')
  check('counts: an unreadable file', call('receiptPagesCountsText', { readable: false, counts: { pages: 0 } }), 'The pages could not be read; they stay with the office.')
  check('a page released anyway, a lapsed release, an office mark',
    [call('receiptPageLine', { page: 2, code: 'OTHER_PERSON', released: true, mark: 'released', released_anyway: true }),
      call('receiptPageLine', { page: 1, code: 'OTHER_PERSON', released: false, mark: 'released', lapsed: true }),
      call('receiptPageLine', { page: 3, code: 'STATEMENT', released: false, mark: 'office' })],
    ['Page 2 · names another person · Reaches the driver (released anyway)',
      'Page 1 · names another person · Kept by the office (its release lapsed: mark it again)',
      'Page 3 · statement page · Office only (marked)'])
  check('"Release anyway" names the codes', call('releaseAnywayText', ['OTHER_PERSON', 'OTHER_TRUCK']),
    'The check found that this page names another person, shows another truck. Release it to the driver only after reading the page.')
  check('an invoice holding pages', call('receiptPagesInvoiceLine', { id: 4, invoice_number: 'INV-TEST-1', status: 'Approved', pages_in_pdf: [1, 3] }), 'INV-TEST-1 (Approved): pages 1, 3 in its PDF')
  check('the mark reasons are the server\'s codes', (lib.RECEIPT_PAGE_MARK_REASONS || []).map((r) => r.code),
    ['only_his_lines', 'checked_receipt', 'other_driver', 'other_truck', 'other_card', 'not_readable', 'other'])
  const view = { invoices: [{ id: 4, invoice_number: 'INV-TEST-1', status: 'Approved', pages_in_pdf: [1], can_update: true }] }
  check('an "office only" mark an invoice PDF refused: an error naming the invoice and its code',
    call('receiptPageMarkToast', { ...view, withdrawal: { withdrawn: [], refused: [{ id: 4, invoice_number: 'INV-TEST-1', code: 'TEXT_UNREADABLE' }] } }),
    { text: 'Marked, but the PDF of INV-TEST-1 could not be updated (TEXT_UNREADABLE)', kind: 'error' })
  check('two refused, one with no number: both named, each code once',
    call('receiptPageMarkToast', { invoices: [], withdrawal: { withdrawn: [], refused: [{ id: 4, invoice_number: 'INV-TEST-1', code: 'PAGE_COUNT' }, { id: 7, invoice_number: '', code: 'PAGE_COUNT' }] } }),
    { text: 'Marked, but the PDFs of INV-TEST-1, Invoice #7 could not be updated (PAGE_COUNT)', kind: 'error' })
  check('nothing refused (the page left an invoice, or none held it): "Page marked"',
    [call('receiptPageMarkToast', { ...view, withdrawal: { withdrawn: [4], refused: [] } }), call('receiptPageMarkToast', { invoices: [], withdrawal: { withdrawn: [], refused: [] } })],
    [{ text: 'Page marked', kind: 'success' }, { text: 'Page marked', kind: 'success' }])
}

section('2. the panel is wired')
{
  let tab = ''
  let panel = ''
  try { tab = read('client/src/components/dashboard/ExpensesTab.vue') } catch { tab = '' }
  try { panel = read('client/src/components/dashboard/expenses/ReceiptPagesPanel.vue') } catch { panel = '' }
  check('ExpensesTab imports the panel and shows it under a PDF receipt',
    [/import ReceiptPagesPanel from '\.\/expenses\/ReceiptPagesPanel\.vue'/.test(tab), /isPdfReceipt\(selectedExpense\.photo_data\)[\s\S]{0,600}<ReceiptPagesPanel :expense="selectedExpense" \/>/.test(tab)], [true, true])
  check('the panel reads the page list, marks one page per call and updates one invoice',
    [panel.includes('/api/expenses/${props.expense.id}/receipt-pages`'), panel.includes('/receipt-pages/${target.value.page}`'), panel.includes('/api/invoices/${inv.id}/receipt-pages/update`')],
    [true, true, true])
  check('a 409 RECEIPT_PAGE_RELEASE_ANYWAY opens the second step, which sends the codes',
    [/err\.code === 'RECEIPT_PAGE_RELEASE_ANYWAY'/.test(panel), /submitMark\(anywayCodes\)/.test(panel), /body\.releaseAnyway = releaseAnyway/.test(panel)], [true, true, true])
  check('Super Admin only; hidden when the server has the pages switched off',
    [/auth\.isSuperAdmin/.test(panel), /'FEATURE_OFF'/.test(panel)], [true, true])
  check('a mark\'s toast comes from the server\'s withdrawal outcome, never from the page view\'s invoice list',
    [/receiptPageMarkToast\(res\)/.test(panel), /res\.invoices\.refused/.test(panel)], [true, false])
}

section('3. nothing computed in the browser')
{
  let src = ''
  try { src = read('client/src/lib/receiptPages.js') + read('client/src/components/dashboard/expenses/ReceiptPagesPanel.vue') } catch { src = '' }
  check('no arithmetic on a server figure (counts and pages are printed as sent)',
    [src.length > 0, /counts\.(pages|released|office)\s*[-+*/]/.test(src), /\b(amount|cents)\b/.test(src)], [true, false, false])
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
