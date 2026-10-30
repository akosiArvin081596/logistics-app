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
//   5. The receipt's week (PERSONAL_RECEIPT_WEEK_ENABLED on, W11): a carried line
//      is live and its pill quotes the server's wait_text; a line on an approved
//      invoice reads "(approved, final)"; the driver sees the week of the invoice
//      that carries his line (invoice_week_label) or "coming off your next weekly
//      invoice"; Reverse follows the server's can_reverse when it sends one.
//      The Mark dialog's text follows the list's personalReceiptWeek (W18); a
//      reversed line still on its way to an invoice says so, and the Reverse
//      dialog says when a reversal follows its line (W27).
//   6. The Expenses table fits its panel (no sideways scroll): its row shows the
//      short tag (amount and one state word, from server fields only) with the
//      full sentence on hover; the phone card and the detail window keep the full
//      sentence; the pill wraps; the table has fixed columns and gives way to the
//      cards when its panel is narrower than TABLE_MIN_WIDTH.
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
// Read through the namespace, so a helper the module lacks fails its check
// instead of the whole runner.
import * as personalReceiptLib from '../client/src/lib/personalReceipt.js'

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

section('§6 W11 the receipt\'s week: carried, final and the invoice\'s week')
{
  const carried = (extra = {}) => line('carried', { amount_text: '$45.50', can_undo: true, can_reverse: false, ...extra })
  const r = receipt('Approved', carried())
  check('a carried line is live: Undo, no Personal button, the status buttons step aside',
    [personalLive(r), canMarkPersonal(r, SA), canUndoPersonal(r, { isSuperAdmin: true }), canReversePersonal(r, { isSuperAdmin: true }), personalBlocksStatus(r)],
    [true, false, true, false, true])
  check('pill: carried off an approved week, in the server\'s words',
    personalPillText(carried({ wait_text: 'the Oct 17-23, 2026 invoice is approved; it goes on the next weekly invoice' })),
    'Personal -$45.50 · waiting: the Oct 17-23, 2026 invoice is approved; it goes on the next weekly invoice')
  check('pill: carried, more than the invoice can take',
    personalPillText(carried({ amount_text: '$500.00', wait_text: 'more than the Oct 17-23, 2026 invoice can take; it goes on the next weekly invoice with room' })),
    'Personal -$500.00 · waiting: more than the Oct 17-23, 2026 invoice can take; it goes on the next weekly invoice with room')
  check('pill: carried off a week touching a closed month',
    personalPillText(carried({ amount_text: '$80.00', wait_text: 'the week of Sep 26 - Oct 2, 2026 touches closed September; it goes on the next weekly invoice' })),
    'Personal -$80.00 · waiting: the week of Sep 26 - Oct 2, 2026 touches closed September; it goes on the next weekly invoice')
  const final = line('invoiced', { amount_text: '$45.50', invoice_number: 'INV-XX-2026W44-01', final: true, can_undo: false, can_reverse: false })
  check('pill: on an approved invoice, final', personalPillText(final), 'Personal -$45.50 · on INV-XX-2026W44-01 (approved, final)')
  check('Reverse from can_reverse: an approved, final line offers neither Undo nor Reverse',
    [canUndoPersonal(receipt('Approved', final), { isSuperAdmin: true }), canReversePersonal(receipt('Approved', final), { isSuperAdmin: true })], [false, false])
  check('…and can_reverse true offers Reverse (a line whose month closed while it waited)',
    canReversePersonal(receipt('Approved', line('pending', { can_undo: false, can_reverse: true })), { isSuperAdmin: true }), true)
  check('driver: on a later week\'s invoice, that invoice\'s week',
    personalDriverText(line('invoiced', { amount_text: '$45.50', week_label: 'Oct 17-23, 2026', invoice_week_label: 'Oct 24-30, 2026' })),
    'Personal: -$45.50 on your Oct 24-30, 2026 invoice')
  check('driver: carried', personalDriverText(carried()), 'Personal: -$45.50, coming off your next weekly invoice')
}

section('§7 W18 the Mark dialog\'s text follows personalReceiptWeek')
{
  const fn = personalReceiptLib.personalMarkDialogText
  const text = (on) => (typeof fn === 'function' ? fn(on) : null)
  const before = "The driver repays this amount on the weekly invoice for the week it is marked in, and it leaves the company's costs. Any rest of the receipt stays a company cost."
  check('personalReceiptWeek on: the week of the receipt date, else the next weekly invoice', text(true),
    "The driver repays this amount on the invoice for the week of the receipt date. If that invoice is approved, in a closed month or too small, it goes on the driver's next weekly invoice. It leaves the company's costs now; any rest of the receipt stays a company cost.")
  check('…off, or not sent: the text it had before', [text(false), text(undefined)], [before, before])
  const actions = read('client/src/components/dashboard/expenses/PersonalReceiptActions.vue')
  check('the dialog takes its text from lib/personalReceipt.js, by its receiptWeek prop',
    [actions.includes('personalMarkDialogText(props.receiptWeek)'), /receiptWeek: \{ type: Boolean, default: false \}/.test(actions)], [true, true])
  const tab = read('client/src/components/dashboard/ExpensesTab.vue')
  check('ExpensesTab passes personalReceiptWeek in all three places and reads it in both loads',
    [(tab.match(/:enabled="personalEnabled" :receipt-week="personalReceiptWeek"/g) || []).length, (tab.match(/personalReceiptWeek\.value = data\.personalReceiptWeek === true/g) || []).length], [3, 2])
}

section('§8 W27 a reversed line still on its way to an invoice, and the Reverse dialog')
{
  check('pill: a reversed line that still goes on an invoice says so, in the server\'s words',
    personalPillText(line('reversed', { amount_text: '$100.00', wait_text: 'the line still goes on the next weekly invoice, and its credit with it' })),
    'Personal -$100.00 · reversed; the line still goes on the next weekly invoice, and its credit with it')
  const fn = personalReceiptLib.personalReverseDialogText
  check('the Reverse dialog with personalReceiptWeek on: a line no invoice took stays off with its credit, unless the pay was raised for it',
    typeof fn === 'function' ? fn(true) : null,
    "This line can no longer be undone. A reversing line credits the amount back in the open month. A line no invoice has taken stays off every invoice with its credit, unless the driver's percentage pay was already raised for it: then the line still goes on his next weekly invoice, and its credit follows it there.")
}

section('§9 the Expenses table fits its panel: the short tag, compact actions, cards when narrow')
{
  const fn = personalReceiptLib.personalShortText
  const tag = (p) => (typeof fn === 'function' ? fn(p) : null)
  check('short tag: waiting', tag(line('pending')), 'Personal -$45.00 · waiting')
  check('short tag: carried (the server\'s wait_text stays in the full sentence)',
    tag(line('carried', { wait_text: 'the Oct 17-23, 2026 invoice is approved; it goes on the next weekly invoice' })), 'Personal -$45.00 · carried')
  check('short tag: on the weekly invoice, by its number', tag(line('invoiced', { invoice_number: 'INV-2026-0123' })), 'Personal -$45.00 · on INV-2026-0123')
  check('short tag: on an approved invoice, final', tag(line('invoiced', { invoice_number: 'INV-XX-2026W44-01', final: true, can_undo: false })), 'Personal -$45.00 · final')
  check('short tag: invoiced for a Dispatcher (no invoice number in the summary)', tag(line('invoiced')), 'Personal -$45.00 · invoiced')
  check('short tag: on a correction, by its number; without one', [tag(line('correction', { invoice_number: 'INV-M-2026-0007' })), tag(line('correction'))],
    ['Personal -$45.00 · on INV-M-2026-0007', 'Personal -$45.00 · correction'])
  check('short tag: needs a correction', tag(line('needs_correction')), 'Personal -$45.00 · needs correction')
  check('short tag: reversed; reversed and still on its way to an invoice (not a bare "reversed")',
    [tag(line('reversed')), tag(line('reversed', { wait_text: 'the line still goes on the next weekly invoice, and its credit with it' }))],
    ['Personal -$45.00 · reversed', 'Personal -$45.00 · reversed, waiting'])
  check('short tag: no amount_text, no figure of its own', tag(line('pending', { amount_text: '' })), 'Personal · waiting')
  check('short tag: nothing, or an unknown state', [tag(null), tag(line('odd'))], ['', ''])
  check('short tag: the amount is the server\'s text as sent, never reformatted',
    tag(line('invoiced', { amount_text: '$1,234.50', invoice_number: 'INV-2026-0124' })), 'Personal -$1,234.50 · on INV-2026-0124')

  const actions = read('client/src/components/dashboard/expenses/PersonalReceiptActions.vue')
  check('the actions component: a compact prop, the short tag only when compact, the full sentence always its hover text',
    [/compact: \{ type: Boolean, default: false \}/.test(actions), actions.includes('personalShortText(props.expense.personal)'),
      actions.includes('{{ compact ? shortPill : pill }}'), /class="personal-pill[^"]*"[^>]*:title="pill"|:class="\['personal-pill'[^>]*:title="pill"/.test(actions)],
    [true, true, true, true])
  const actionsCss = (actions.split('<style')[1] || '')
  const pillRule = (actionsCss.match(/\.personal-pill \{[^}]*\}/) || [''])[0]
  check('the pill wraps and is never wider than its card or cell (no nowrap, no fixed width)',
    [/white-space: normal/.test(pillRule), /max-width: 100%/.test(pillRule), /white-space: nowrap|(?:^|[^-])width: \d|max-width: \d+(?:\.\d+)?(?:rem|px)/.test(pillRule)], [true, true, false])

  const tab = read('client/src/components/dashboard/ExpensesTab.vue')
  const places = tab.match(/<PersonalReceiptActions :expense="(e|selectedExpense)" :enabled="personalEnabled"[^>]*>/g) || []
  check('three places, as before: only the table row is compact (the phone card and the detail window keep the full sentence)',
    places.map((p) => /\scompact[\s/>]/.test(p)), [false, true, false])
  check('the cards show on a phone or when the list panel is narrower than the table needs',
    [/v-else-if="showCards" class="mobile-exp-list"/.test(tab), /const showCards = computed\(\(\) => isMobile\.value \|\| \(allPanelWidth\.value > 0 && allPanelWidth\.value < TABLE_MIN_WIDTH\)\)/.test(tab),
      /ref="allPanelEl" class="sub-panel"/.test(tab), /useElementWidth\(allPanelEl\)/.test(tab), /v-else-if="isMobile" class="mobile-exp-list"/.test(tab)],
    [true, true, true, true, false])
  const tableHtml = (tab.match(/<table v-else class="data-table exp-table">[\s\S]*?<\/table>/) || [''])[0]
  check('the table: nine columns in its header and its row', [(tableHtml.match(/<col\b/g) || []).length, (tableHtml.match(/<th\b/g) || []).length], [9, 9])
  const style = tab.split('<style')[1] || ''
  const remOf = (cls) => { const m = style.match(new RegExp(`\\.exp-table col\\.${cls} \\{ width: ([\\d.]+)rem; \\}`)); return m ? Number(m[1]) : NaN }
  const fixedRem = ['col-select', 'col-date', 'col-driver', 'col-type', 'col-amount', 'col-receipt', 'col-status', 'col-actions'].map(remOf)
  const fixedPx = fixedRem.reduce((s, r) => s + r * 16, 0)
  const min = Number((tab.match(/const TABLE_MIN_WIDTH = (\d+)/) || [])[1])
  check('the table has a fixed layout at its panel\'s width, and its cells cut or wrap their own text',
    [/\.exp-table \{ table-layout: fixed; width: 100%; \}/.test(style), /\.exp-table td \{[^}]*overflow: hidden;/.test(style)], [true, true])
  check('eight fixed columns, each set; with room for Vendor they fit under TABLE_MIN_WIDTH (at least 120 px left)',
    [fixedRem.every((r) => Number.isFinite(r) && r > 0), Number.isFinite(min) && fixedPx + 120 <= min], [true, true])
  // Each phone-only block's body, up to its own closing brace.
  const phoneBlocks = []
  for (let at = style.indexOf('@media (max-width: 767px) {'); at !== -1; at = style.indexOf('@media (max-width: 767px) {', at + 1)) {
    let depth = 0
    let i = style.indexOf('{', at)
    const start = i
    for (; i < style.length; i++) {
      if (style[i] === '{') depth++
      else if (style[i] === '}' && --depth === 0) break
    }
    phoneBlocks.push(style.slice(start, i + 1))
  }
  check('the cards\' styles are not phone-only (they show at any width the table gives way)',
    [phoneBlocks.length > 0, phoneBlocks.some((b) => /\.mobile-exp-(list|top|bottom|actions|btn) \{/.test(b)), /(^|\n)\.mobile-exp-list \{/.test(style)],
    [true, false, true])
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
