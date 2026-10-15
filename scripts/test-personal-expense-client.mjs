#!/usr/bin/env node
// Personal receipts (R3 v1) — the CLIENT's half.
//
// What this pins:
//   1. lib/personalReceipt.js decides every Personal control from server fields:
//      the Personal button only for a Super Admin, with new marks switched on,
//      on a receipt that is not Rejected and has no live line; Undo while the
//      server says can_undo, Reverse once it does not (both with marks switched
//      off); the status buttons step aside while a live line is on the receipt.
//   2. The texts: the Expenses pill, the driver's receipt card, an invoice line's
//      receipt ("Receipt" link to the receipt route, "PDF receipt on file" with a
//      Super Admin link to the Expenses screen and text only for a driver,
//      "Receipt image not available"), and the dialog's default amount (the
//      receipt amount the server sent).
//   3. The screens use them: ExpensesTab (list, phone cards, detail modal, the
//      waiting-corrections panel for Super Admin), the admin Invoices detail, the
//      driver's invoice card and sheet, and the driver's receipt card.
//   4. No money is computed in the browser: every amount the new files print is
//      a server string (amount_text, a line's amount); none of them divides,
//      multiplies or adds a money figure.
//
// No network, no DOM, no database.
//   node scripts/test-personal-expense-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import {
  personalLive, canMarkPersonal, canUndoPersonal, canReversePersonal, personalBlocksStatus,
  personalPillText, personalDriverText, personalLineReceipt, personalDefaultAmount,
  PERSONAL_PDF_TEXT, PERSONAL_NO_IMAGE_TEXT,
} from '../client/src/lib/personalReceipt.js'

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

// A file's code without its comments, in one pass: each <!-- ... -->, /* ... */
// and // comment (a "//" right after ":" is a URL, kept) is skipped to its end.
function code(src) {
  const s = String(src)
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4)
      i = end === -1 ? s.length : end + 3
      continue
    }
    if (s.startsWith('/*', i)) {
      const end = s.indexOf('*/', i + 2)
      i = end === -1 ? s.length : end + 2
      continue
    }
    if (s.startsWith('//', i) && s[i - 1] !== ':') {
      const end = s.indexOf('\n', i + 2)
      i = end === -1 ? s.length : end
      continue
    }
    out += s[i]
    i++
  }
  return out
}

const SA = { isSuperAdmin: true, enabled: true }
const line = (state, extra = {}) => ({ line_id: 7, state, amount_text: '$45.00', week_label: 'Oct 10-16', invoice_number: '', can_undo: true, ...extra })
const receipt = (status, personal = null) => ({ id: 11, status, amount: 45, personal })

section('§1 the Personal button')
{
  check('Super Admin, marks on, an Approved receipt with no line: shown', canMarkPersonal(receipt('Approved'), SA), true)
  check('…and a Pending one (the mark approves it on the server)', canMarkPersonal(receipt('Pending'), SA), true)
  check('a Dispatcher never sees it', canMarkPersonal(receipt('Approved'), { isSuperAdmin: false, enabled: true }), false)
  check('marks switched off: hidden', canMarkPersonal(receipt('Approved'), { isSuperAdmin: true, enabled: false }), false)
  check('a Rejected receipt: hidden', canMarkPersonal(receipt('Rejected'), SA), false)
  for (const state of ['pending', 'needs_correction', 'invoiced', 'correction']) {
    check(`a live line (${state}): hidden`, canMarkPersonal(receipt('Approved', line(state)), SA), false)
  }
  check('a reversed line: shown again (the receipt can be marked again)', canMarkPersonal(receipt('Approved', line('reversed')), SA), true)
  check('no arguments: hidden', canMarkPersonal(receipt('Approved')), false)
}

section('§2 Undo and Reverse, from the server\'s can_undo')
{
  const undoable = receipt('Approved', line('invoiced', { can_undo: true, invoice_number: 'INV-2026-0101' }))
  const locked = receipt('Approved', line('invoiced', { can_undo: false, invoice_number: 'INV-2026-0101' }))
  check('can_undo true: Undo, not Reverse', [canUndoPersonal(undoable, { isSuperAdmin: true }), canReversePersonal(undoable, { isSuperAdmin: true })], [true, false])
  check('can_undo false: Reverse, not Undo', [canUndoPersonal(locked, { isSuperAdmin: true }), canReversePersonal(locked, { isSuperAdmin: true })], [false, true])
  check('a Dispatcher gets neither', [canUndoPersonal(undoable, {}), canReversePersonal(locked, {})], [false, false])
  check('marks switched off do not hide them (no enabled argument needed)', canUndoPersonal(undoable, { isSuperAdmin: true, enabled: false }), true)
  check('can_undo missing: neither (never guessed)', [canUndoPersonal(receipt('Approved', line('pending', { can_undo: undefined })), { isSuperAdmin: true }), canReversePersonal(receipt('Approved', line('pending', { can_undo: undefined })), { isSuperAdmin: true })], [false, false])
  check('a reversed line: neither', [canUndoPersonal(receipt('Approved', line('reversed')), { isSuperAdmin: true }), canReversePersonal(receipt('Approved', line('reversed', { can_undo: false })), { isSuperAdmin: true })], [false, false])
  check('the status buttons step aside for a live line only', [personalBlocksStatus(undoable), personalBlocksStatus(receipt('Approved', line('reversed'))), personalBlocksStatus(receipt('Approved'))], [true, false, false])
  check('personalLive', [personalLive(undoable), personalLive(receipt('Approved')), personalLive(null)], [true, false, false])
}

section('§3 the texts')
{
  check('pill: waiting', personalPillText(line('pending')), "Personal -$45.00 · waiting for the week of Oct 10-16's invoice")
  check('pill: on the weekly invoice', personalPillText(line('invoiced', { invoice_number: 'INV-2026-0101' })), 'Personal -$45.00 · on INV-2026-0101')
  check('pill: on a correction', personalPillText(line('correction', { invoice_number: 'INV-M-2026-0007' })), 'Personal -$45.00 · on correction INV-M-2026-0007, the week of Oct 10-16')
  check('pill: needs a correction', personalPillText(line('needs_correction')), 'Personal -$45.00 · needs a correction invoice for the week of Oct 10-16')
  check('pill: reversed', personalPillText(line('reversed')), 'Personal -$45.00 · reversed')
  check('pill: nothing, or an unknown state', [personalPillText(null), personalPillText(line('odd'))], ['', ''])
  check('pill for a Dispatcher (no invoice number in the summary)', [personalPillText(line('invoiced')), personalPillText(line('correction'))],
    ["Personal -$45.00 · on the week of Oct 10-16's invoice", 'Personal -$45.00 · on a correction invoice, the week of Oct 10-16'])
  check('driver: on the weekly invoice', personalDriverText(line('invoiced')), 'Personal: -$45.00 on your Oct 10-16 invoice')
  check('driver: waiting reads the same', personalDriverText(line('pending')), 'Personal: -$45.00 on your Oct 10-16 invoice')
  check('driver: on a correction', personalDriverText(line('correction', { invoice_number: 'INV-M-2026-0007' })), 'Personal: -$45.00 on correction INV-M-2026-0007')
  check('driver: needs a correction', personalDriverText(line('needs_correction')), 'Personal: -$45.00 on a correction invoice for the week of Oct 10-16')
  check('driver: no amount text, nothing (never a figure of its own)', personalDriverText(line('invoiced', { amount_text: '' })), '')
  const img = { line_id: 7, label: 'Personal expense, Pilot #123, Oct 12, 2026', amount: '-$45.00', receipt: { kind: 'image', url: '/api/invoices/41/personal-receipts/7', expense_id: 11 } }
  check('an image receipt links to the receipt route', personalLineReceipt(img), { text: 'Receipt', href: '/api/invoices/41/personal-receipts/7', internal: false })
  check('…any other URL is not linked', personalLineReceipt({ receipt: { kind: 'image', url: 'https://example.test/x.jpg' } }), { text: PERSONAL_NO_IMAGE_TEXT, href: '', internal: false })
  const pdf = { receipt: { kind: 'pdf', url: '', expense_id: 11 } }
  check('a PDF receipt: a Super Admin gets the Expenses screen link', personalLineReceipt(pdf, { isSuperAdmin: true }), { text: PERSONAL_PDF_TEXT, href: '/expenses?expense=11', internal: true })
  check('…a driver the text only', personalLineReceipt(pdf), { text: 'PDF receipt on file', href: '', internal: false })
  check('no receipt: "Receipt image not available"', personalLineReceipt({ receipt: { kind: 'none' } }), { text: 'Receipt image not available', href: '', internal: false })
  check('the dialog opens on the receipt amount the server sent', [personalDefaultAmount({ amount: 45 }), personalDefaultAmount({ amount: '120.5' }), personalDefaultAmount({ amount: 0 }), personalDefaultAmount({})], ['45.00', '120.50', '', ''])
}

section('§4 the screens use them')
{
  const tab = read('client/src/components/dashboard/ExpensesTab.vue')
  check('ExpensesTab: the actions on the phone card, the table row and the detail modal',
    (tab.match(/<PersonalReceiptActions :expense="(e|selectedExpense)" :enabled="personalEnabled"/g) || []).length, 3)
  check('ExpensesTab: the status buttons step aside for a live line, in all three places',
    (tab.match(/expenseStatusChangeable\((e|selectedExpense)\) && !personalBlocksStatus\((e|selectedExpense)\)/g) || []).length, 3)
  check('ExpensesTab: personalEnabled comes from the list response, in both loads',
    (tab.match(/personalEnabled\.value = data\.personalEnabled === true/g) || []).length, 2)
  check('ExpensesTab: the waiting-corrections panel is Super Admin only', /<PersonalCorrectionsPanel v-if="auth\.isSuperAdmin" \/>/.test(tab), true)
  const actions = read('client/src/components/dashboard/expenses/PersonalReceiptActions.vue')
  check('the actions component asks lib/personalReceipt.js for every button',
    ['canMarkPersonal(props.expense', 'canUndoPersonal(props.expense', 'canReversePersonal(props.expense', 'personalPillText(props.expense.personal)'].map((s) => actions.includes(s)), [true, true, true, true])
  check('…and the three routes', ['api.post(`/api/expenses/${id}/personal`', 'api.del(`/api/expenses/${id}/personal`', 'api.post(`/api/expenses/${id}/personal/reverse`'].map((s) => actions.includes(s)), [true, true, true])
  check('…the role comes from the auth store', /isSuperAdmin: !!auth\.isSuperAdmin/.test(actions), true)
  const panel = read('client/src/components/dashboard/expenses/PersonalCorrectionsPanel.vue')
  check('the panel reads the waiting list and creates through the corrections route',
    [panel.includes("api.get('/api/expenses/personal/waiting-corrections')"), panel.includes("api.post('/api/invoices/personal-corrections', { driver: g.driver, weekStart: g.week_start }")], [true, true])
  const invoices = read('client/src/views/InvoicesView.vue')
  check('admin Invoices detail lists personal_lines with the Super Admin flag', /<PersonalInvoiceLines :lines="selectedInvoice\.personal_lines" :is-super-admin="!!auth\.isSuperAdmin" \/>/.test(invoices), true)
  const card = read('client/src/components/driver/InvoiceCard.vue')
  const sheet = read('client/src/components/driver/InvoiceTab.vue')
  check('the driver\'s invoice card and sheet list them, never as Super Admin',
    [/<PersonalInvoiceLines :lines="invoice\.personal_lines" \/>/.test(card), /<PersonalInvoiceLines :lines="selectedInvoice\.personal_lines" \/>/.test(sheet), /is-super-admin/.test(card + sheet)], [true, true, false])
  const expenseCard = read('client/src/components/driver/ExpenseCard.vue')
  check('the driver\'s receipt card shows personalDriverText()', /personalDriverText\(props\.expense\.personal\)/.test(expenseCard), true)
}

section('§5 no money computed in the browser')
{
  const files = [
    'client/src/lib/personalReceipt.js',
    'client/src/components/dashboard/expenses/PersonalReceiptActions.vue',
    'client/src/components/dashboard/expenses/PersonalCorrectionsPanel.vue',
    'client/src/components/shared/PersonalInvoiceLines.vue',
  ]
  for (const f of files) {
    const src = code(read(f))
    const arithmetic = src.match(/\b(?:cents|amount|share|total)\w*\s*[*/+-]\s*\d|\d\s*[*/]\s*\b(?:cents|amount|share|total)|\/\s*100\b|\*\s*100\b|\.reduce\(/g) || []
    check(`${f}: no arithmetic on a money figure`, arithmetic, [])
  }
  const lib = read('client/src/lib/personalReceipt.js')
  check('the one number the client formats is the dialog\'s default (the receipt amount, as sent)', (lib.match(/toFixed\(/g) || []).length, 1)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
