#!/usr/bin/env node
// Receipts in a finalized month, and receipt dates far from today — the
// CLIENT's half.
//
// WHY THIS EXISTS. On 2026-09-28 an admin pressed Approve seven times on two
// August receipts and read "Failed to update status" each time. August was
// finalized: the server refused with 409 PERIOD_FINALIZED and a sentence that
// said so, and the receipts were already counted in August's figures. The list
// called them "Pending" and kept offering Approve and Reject. Separately, a
// driver filed two scale tickets dated 2023-09-28 and 2025-09-28 the day after
// buying them (2026-09-28), and a fuel receipt dated 2017-07-15 was filed on
// 2026-08-01; the forms' warning was on screen and the receipts saved anyway.
//
// What this pins:
//   1. lib/expenseStatus.js — a Pending receipt the server marks finalized reads
//      "Included: <Month> finalized"; Approved and Rejected keep their own
//      label; no status change is offered on a finalized receipt; a failed
//      status change shows the server's own reason, and the old fixed text only
//      when there is none.
//   2. lib/receiptDate.js — the one rule every entry form asks before saving: a
//      date in the future, over 4 months old, or in another year and far off.
//   3. The screens use them: ExpensesTab's list, mobile cards and detail modal,
//      and a question before saving in the driver form, the admin Log Expense
//      form and the bulk scan.
//
// No network, no DOM, no database.
//   node scripts/test-expense-finalized-status-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import {
  expenseStatusLabel, expenseStatusClass, expenseStatusChangeable, statusChangeFailureMessage,
} from '../client/src/lib/expenseStatus.js'
import { receiptDateVerdict, receiptDateQuestion, RECEIPT_DATE_STALE_DAYS } from '../client/src/lib/receiptDate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`)
  }
}

// ---- 1. status label, class, actions ---------------------------------------
const aug = { id: 211, status: 'Pending', finalized_period: '2026-08' }
check('finalized Pending reads as included', expenseStatusLabel(aug), 'Included: August 2026 finalized')
check('finalized Pending has its own pill class', expenseStatusClass(aug), 'st-finalized')
check('no status change on a finalized receipt', expenseStatusChangeable(aug), false)
check('a missing status counts as Pending', expenseStatusLabel({ finalized_period: '2026-08' }), 'Included: August 2026 finalized')
check('finalized Approved keeps its label', expenseStatusLabel({ status: 'Approved', finalized_period: '2026-08' }), 'Approved')
check('finalized Approved: no Undo either', expenseStatusChangeable({ status: 'Approved', finalized_period: '2026-08' }), false)
check('finalized Rejected keeps its label (it is not included)', expenseStatusLabel({ status: 'Rejected', finalized_period: '2026-08' }), 'Rejected')
check('finalized Rejected keeps its class', expenseStatusClass({ status: 'Rejected', finalized_period: '2026-08' }), 'st-rejected')
check('open Pending stays Pending', expenseStatusLabel({ status: 'Pending', finalized_period: '' }), 'Pending')
check('open Pending class', expenseStatusClass({ status: 'Pending', finalized_period: '' }), 'st-pending')
check('open Pending is changeable', expenseStatusChangeable({ status: 'Pending', finalized_period: '' }), true)
check('a server without the field changes nothing', [expenseStatusLabel({ status: 'Pending' }), expenseStatusChangeable({ status: 'Pending' })], ['Pending', true])
check('an unreadable month is not printed', expenseStatusLabel({ status: 'Pending', finalized_period: '2026-13' }), 'Pending')

const refusal = Object.assign(new Error('This expense is booked to August 2026, which is finalized. Reopen the period, or record the correction as a payout adjustment.'), { status: 409, code: 'PERIOD_FINALIZED' })
check('a refusal shows the server reason', statusChangeFailureMessage(refusal), refusal.message)
check('a timeout shows its own sentence', statusChangeFailureMessage(Object.assign(new Error('The request timed out. Please check your connection and try again.'), { code: 'TIMEOUT' })), 'The request timed out. Please check your connection and try again.')
check('no reason at all falls back', statusChangeFailureMessage(new Error('')), 'Failed to update status')
check('a non-error falls back', statusChangeFailureMessage(null), 'Failed to update status')

// ---- 2. receipt date verdict -----------------------------------------------
const at = (iso) => new Date(iso)
const filed = at('2026-09-29T15:06:12-05:00') // #254 and #255 were filed then
check('stale threshold is 4 months', RECEIPT_DATE_STALE_DAYS, 120)
check('#254 2023-09-28 filed 2026-09-29', receiptDateVerdict('2023-09-28', filed), 'year')
check('#255 2025-09-28 filed 2026-09-29', receiptDateVerdict('2025-09-28', filed), 'year')
check('#172 2017-07-15 filed 2026-08-01', receiptDateVerdict('2017-07-15', at('2026-08-01T08:34:37-05:00')), 'year')
check('the intended 2026-09-28', receiptDateVerdict('2026-09-28', filed), '')
check('today', receiptDateVerdict('2026-09-29', filed), '')
check('tomorrow (a timezone edge) is allowed', receiptDateVerdict('2026-09-30', filed), '')
check('next week is the future', receiptDateVerdict('2026-10-06', filed), 'future')
check('5 months old this year', receiptDateVerdict('2026-04-01', filed), 'old')
check('a late-December receipt filed in early January is fine', receiptDateVerdict('2025-12-28', at('2026-01-02T09:00:00-06:00')), '')
check('blank date: nothing to ask', receiptDateVerdict('', filed), '')
check('malformed date: nothing to ask', receiptDateVerdict('09/28/2023', filed), '')

const q = receiptDateQuestion('2023-09-28', filed)
check('the question names the year', /2023/.test(q) && /2026/.test(q), true)
check('the question shows the date entered', /Sep 28, 2023/.test(q), true)
check('no question for a good date', receiptDateQuestion('2026-09-28', filed), '')
check('a future date is asked about', /after today/.test(receiptDateQuestion('2026-10-06', filed)), true)
check('an old date is asked about', /months old/.test(receiptDateQuestion('2026-04-01', filed)), true)

// ---- 3. wiring --------------------------------------------------------------
const tab = read('client/src/components/dashboard/ExpensesTab.vue')
check('ExpensesTab: setStatus toasts the server reason', /toast\(statusChangeFailureMessage\(err\), 'error'\)/.test(tab), true)
check('ExpensesTab: no fixed "Failed to update status" toast left', /toast\('Failed to update status'/.test(tab), false)
check('ExpensesTab: a PERIOD_FINALIZED refusal marks the row finalized', /err\?\.code === 'PERIOD_FINALIZED' && err\?\.data\?\.period\) exp\.finalized_period = err\.data\.period/.test(tab), true)
// The row buttons call setStatus straight from @click, so a refusal it rethrew
// reached the console as an uncaught error. It answers true or false instead.
const setStatusBody = (tab.match(/\nasync function setStatus\(id, status\) \{\n([\s\S]*?)\n\}\n/) || [])[1] || ''
check('ExpensesTab: setStatus found', setStatusBody !== '', true)
check('ExpensesTab: setStatus never rethrows a refusal', /\bthrow\b/.test(setStatusBody), false)
check('ExpensesTab: setStatus answers whether the change was saved', /return true/.test(setStatusBody) && /return false/.test(setStatusBody), true)
check('ExpensesTab: the modal moves on only after a saved change', /if \(await setStatus\(exp\.id, 'Approved'\)\) advanceToNextPending\(\)/.test(tab) && /if \(await setStatus\(exp\.id, 'Rejected'\)\) advanceToNextPending\(\)/.test(tab), true)
check('ExpensesTab: list, cards and modal label the status through the helper', (tab.match(/expenseStatusLabel\(/g) || []).length >= 3, true)
check('ExpensesTab: list, cards and modal gate the buttons on the server flag', (tab.match(/expenseStatusChangeable\(/g) || []).length >= 3, true)
check('ExpensesTab: Log Expense asks before saving a far-off date', /askAboutDate\(/.test(tab) && /receiptDateQuestion\(/.test(tab), true)
const form = read('client/src/components/driver/ExpenseForm.vue')
check('driver form: asks before saving a far-off date', /receiptDateVerdict\(/.test(form) && /dateQuestion/.test(form), true)
const bulk = read('client/src/components/dashboard/expenses/BulkReceiptScan.vue')
check('bulk scan: asks before saving far-off dates', /receiptDateVerdict\(/.test(bulk) && /ConfirmModal/.test(bulk), true)

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
