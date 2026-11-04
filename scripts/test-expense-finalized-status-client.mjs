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
//   4. lib/receiptAutoReview.js (receipts auto-approve): the line under a status.
//      "Checking automatically" and "Needs a person: <reasons>" only on a Pending
//      receipt a person can still change, and only in on mode; "Approved
//      automatically" with its evidence; "Approved by <account>" from the record;
//      an empty record names nobody; flag off, nothing; a person's own change
//      drops the old record and verdict until the reload.
//   5. Its codes and names are the server's (lib/receipt-auto-approve.js, the
//      pass and its list module).
//   6. ExpensesTab and the report panel use it: the filter only in on mode, the
//      panel only for a Super Admin while the flag is on, the server's counts as sent.
//
// No network, no DOM, no database.
//   node scripts/test-expense-finalized-status-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
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

const refusal = Object.assign(new Error("August 2026 is closed, so this receipt's status can't be changed. It already counts in August 2026's figures as it stands. A Super Admin can correct an investor's payout with an adjustment on an open month in Payouts. A company truck's closed month stays as recorded."), { status: 409, code: 'PERIOD_FINALIZED' })
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

// ---- 4. receipts auto-approve: the line under a status -----------------------
// Loaded here, not imported above, so code without it fails each case by name.
let R = null
try {
  R = await import('../client/src/lib/receiptAutoReview.js')
} catch (err) {
  check('lib/receiptAutoReview.js loads', String(err && err.message), 'loaded')
}
const lineOf = (e, mode) => (R ? R.autoReviewLine(e, mode) : 'no module')
const labelOf = (e, mode) => { const l = lineOf(e, mode); return l && typeof l === 'object' ? l.label : l }
const kindOf = (e, mode) => { const l = lineOf(e, mode); return l && typeof l === 'object' ? l.kind : l }
const call = (name, ...args) => (R && typeof R[name] === 'function' ? R[name](...args) : 'no module')

const READ = { amount: 412, date: '2026-09-20', gallons: 98.5, state: 'TX' }
const fuel = (over) => ({ id: 902, type: 'Fuel', status: 'Pending', amount: 421, location_source: '', finalized_period: '', ...over })
const held = (reasons, extra = {}) => fuel({ auto_review: { state: 'held', reasons, fill: 32, km: 63, read: READ, ...extra } })
const checking = fuel({ auto_review: { state: 'checking' } })
const auto = fuel({ status: 'Approved', status_by: { role: 'system', name: 'receipt-auto-approve', at: '2026-09-21T15:00:00.000Z' }, auto_review: { state: 'auto', fill: 31, km: 4.2, read: READ } })
const byPerson = fuel({ status: 'Approved', status_by: { role: 'Dispatcher', name: 'dispatch_a', at: '2026-09-21T15:00:00.000Z' }, auto_review: null })

check('on: a Pending receipt the pass waits on reads "Checking automatically"', [kindOf(checking, 'on'), labelOf(checking, 'on')], ['checking', 'Checking automatically'])
check('on: a held receipt reads "Needs a person:" with its reasons and the values sent',
  labelOf(held(['PLACE_FAR', 'OCR_TOTAL']), 'on'), 'Needs a person: the fill was 63 km away; the receipt reads $412.00, the entry says $421.00')
check('on: a held receipt keeps each reason for the detail modal', (lineOf(held(['NO_ELD_FILL', 'PRICE']), 'on') || {}).reasons,
  ['no ELD fill matched', "the price per gallon is outside the fleet's range"])
check('on: a place from the truck\'s own GPS is named as such', labelOf(fuel({ location_source: 'eld', auto_review: { state: 'held', reasons: ['PLACE_FAR'], km: 3 } }), 'on'),
  "Needs a person: the receipt's place came from the truck's GPS")
check('on: the re-read\'s date, gallons and state are named', labelOf(held(['OCR_DATE', 'OCR_GALLONS', 'OCR_PLACE']), 'on'),
  'Needs a person: the receipt is dated Sep 20, 2026; the receipt reads 98.5 gal; the receipt reads TX')
check('on: values the reader could not read say so', labelOf(held(['OCR_TOTAL', 'OCR_DATE'], { read: { amount: null, date: null, gallons: null, state: null } }), 'on'),
  "Needs a person: the receipt's total couldn't be read; the receipt's date couldn't be read")
check('on: no distance sent says so', labelOf(held(['PLACE_FAR'], { km: null }), 'on'), 'Needs a person: no distance to the fill')
check('on: an unknown code is shown as sent', labelOf(held(['NEW_RULE']), 'on'), 'Needs a person: NEW_RULE')
check('on: the pass\'s approval reads "Approved automatically" with its evidence',
  [kindOf(auto, 'on'), labelOf(auto, 'on'), (lineOf(auto, 'on') || {}).detail],
  ['auto', 'Approved automatically', 'Approved automatically: ELD fill #31 the same day, 4.2 km away; the receipt reads $412.00, Sep 20, 2026, 98.5 gal, TX.'])
check('a person\'s approval reads "Approved by <account>", with the time it was set',
  [kindOf(byPerson, 'on'), labelOf(byPerson, 'on'), (lineOf(byPerson, 'on') || {}).at], ['by', 'Approved by dispatch_a', '2026-09-21T15:00:00.000Z'])
check('"Approved by" says a shared login names an account', /names an account, not a person/.test((lineOf(byPerson, 'off') || {}).detail || ''), true)
check('"Approved by" needs only the record (the recorder flag), not the pass', labelOf(fuel({ status: 'Approved', status_by: { role: 'Super Admin', name: 'admin', at: '' } }), 'off'), 'Approved by admin')
check('the record naming the pass reads "Approved automatically" whatever the mode', [labelOf({ ...auto, auto_review: undefined }, 'off'), labelOf({ ...auto, auto_review: null }, 'shadow')], ['Approved automatically', 'Approved automatically'])
check('only the system account named for the pass is "automatic"', labelOf(fuel({ status: 'Approved', status_by: { role: 'Super Admin', name: 'receipt-auto-approve', at: '' } }), 'on'), 'Approved by receipt-auto-approve')
// PR 1 review L2: approvals before the recorder's switch-on, and a mark on a receipt
// booked out of a closed month, leave an Approved receipt with an empty record.
check('an Approved receipt with an empty record shows no line', [lineOf(fuel({ status: 'Approved', status_by: null }), 'on'), lineOf(fuel({ status: 'Approved', status_by: { role: '', name: '', at: '' } }), 'on')], [null, null])
check('flag off, recorder off: nothing under any status', [checking, held(['PRICE']), auto, fuel({ status: 'Approved' })].map((e) => lineOf({ ...e, status_by: undefined }, 'off')), [null, null, null, null])
check('shadow: no verdict shows, whatever the row carries', [lineOf(checking, 'shadow'), lineOf(held(['PRICE']), 'shadow'), labelOf({ ...auto, status_by: null }, 'shadow')], [null, null, null])
check('a finalized Pending receipt shows no verdict (no status change is offered)', [lineOf({ ...checking, finalized_period: '2026-08' }, 'on'), lineOf({ ...held(['PRICE']), finalized_period: '2026-08' }, 'on')], [null, null])
check('a verdict never shows on a status it doesn\'t describe', [
  lineOf({ ...held(['PRICE']), status: 'Approved', status_by: null }, 'on'),
  lineOf({ ...checking, status: 'Rejected' }, 'on'),
  lineOf({ ...auto, status: 'Pending', status_by: null }, 'on'),
  lineOf({ ...auto, status: 'Rejected' }, 'on'),
], [null, null, null, null])
check('Rejected shows no "who set it" line', lineOf(fuel({ status: 'Rejected', status_by: { role: 'Super Admin', name: 'admin', at: '' } }), 'on'), null)
check('no markup in any line', [held(['PLACE_FAR', 'OCR_TOTAL', 'SAME_PAPER']), checking, auto, byPerson].every((e) => {
  const l = lineOf(e, 'on')
  return !!l && typeof l === 'object' && !/[<>]/.test(`${l.label}${l.detail}`)
}), true)

check('the mode: only "on" and "shadow" are read, anything else is off',
  ['{}', 'on', 'shadow', 'weird'].map((m) => call('autoApproveModeOf', m === '{}' ? {} : { autoApprove: { mode: m } })), ['off', 'on', 'shadow', 'off'])
check('the mode: no answer is off', call('autoApproveModeOf', null), 'off')
check('a person\'s change: only the status, when the server sent no record or verdict', call('localStatusChange', { id: 1, status: 'Pending' }, 'Approved'), { status: 'Approved' })
check('a person\'s change: the old record and verdict go until the reload', call('localStatusChange', auto, 'Pending'), { status: 'Pending', status_by: null, auto_review: null })
check('after a person\'s Undo and Approve here, the pass\'s approval is no longer claimed', lineOf({ ...auto, ...call('localStatusChange', auto, 'Approved') }, 'on'), null)

// ---- 5. the server's codes and names -----------------------------------------
const requireCjs = createRequire(import.meta.url)
const server = {}
for (const [key, file] of [['rules', 'receipt-auto-approve.js'], ['pass', 'receipt-auto-approve-pass.js'], ['list', 'receipt-auto-approve-list.js']]) {
  try { server[key] = requireCjs(path.join(ROOT, 'lib', file)) } catch (err) { check(`lib/${file} loads`, String(err && err.message), 'loaded') }
}
const reasonWords = (R && R.AUTO_REVIEW_REASONS) || {}
const serverCodes = server.rules ? [...server.rules.RULES, server.rules.OCR_UNREAD, server.rules.NOT_FUEL] : ['no rules module']
check('every rule code the server can send has words, and nothing else does', Object.keys(reasonWords).sort(), [...serverCodes].sort())
check('each code\'s words are a plain phrase', Object.keys(reasonWords).length > 0 && Object.values(reasonWords).every((w) => typeof w === 'string' && w.length > 3 && !/[<>]/.test(w) && !/^[A-Z_]+$/.test(w)), true)
check('the pass\'s account is the server\'s', R && R.AUTO_APPROVE_ACCOUNT, server.pass && server.pass.PASS_NAME)
check('the filter\'s value is the one the list route reads', R && R.AUTO_APPROVED_FILTER, server.list && server.list.AUTO_FILTER)
const passSrc = read('lib/receipt-auto-approve-pass.js')
const notApplied = [...new Set([...passSrc.matchAll(/why = "([a-z_]+)"/g)].map((m) => m[1]))].sort()
check('every reason the pass records for an approval it did not write has words', Object.keys((R && R.AUTO_NOT_APPLIED) || {}).sort(), notApplied)
check('…and the pass has such reasons to record', notApplied.length >= 5, true)

// ---- 6. the screens use it -----------------------------------------------------
check('ExpensesTab: the line comes from the helper', /import \{[^}]*\bautoReviewLine\b[^}]*\} from '\.\.\/\.\.\/lib\/receiptAutoReview'/.test(tab), true)
check('ExpensesTab: list, cards and modal show the line', (tab.match(/reviewLines\.get\(e\.id\)/g) || []).length >= 2 && /v-if="selectedReview"/.test(tab), true)
check('ExpensesTab: the mode is read on every load, quiet or not', (tab.match(/autoApproveMode\.value = autoApproveModeOf\(data\)/g) || []).length, 2)
check('ExpensesTab: "Approved automatically" is offered in the filter only in on mode', /<option v-if="autoApproveMode === 'on'" :value="AUTO_APPROVED_FILTER">/.test(tab), true)
check('ExpensesTab: the report panel only for a Super Admin, only while the flag is on', /<ReceiptAutoApprovePanel v-if="auth\.isSuperAdmin && autoApproveMode !== 'off'"/.test(tab), true)
check('ExpensesTab: a person\'s single and bulk changes drop the old record', /if \(exp\) Object\.assign\(exp, localStatusChange\(exp, status\)\)/.test(setStatusBody) && /\{ \.\.\.e, \.\.\.localStatusChange\(e, status\) \}/.test(tab), true)
let panel = ''
try { panel = read('client/src/components/dashboard/expenses/ReceiptAutoApprovePanel.vue') } catch { /* checked below */ }
check('report panel: reads the Super Admin report route', /api\.get\('\/api\/admin\/receipt-auto-approve'\)/.test(panel), true)
check('report panel: shows the server\'s counts as sent (no arithmetic on them)', panel !== '' && !/\bc\.value\.[\w.]+\s*[-+*/]|\bc\.[\w.]+\s*[-+*/%]\s*\w/.test(panel), true)
// Both components compile, template included (the client's own compiler).
const { parse: parseSfc, compileScript } = createRequire(path.join(ROOT, 'client', 'package.json'))('vue/compiler-sfc')
for (const rel of ['client/src/components/dashboard/ExpensesTab.vue', 'client/src/components/dashboard/expenses/ReceiptAutoApprovePanel.vue']) {
  let problem = ''
  try {
    const { descriptor, errors } = parseSfc(read(rel), { filename: path.basename(rel) })
    if (errors.length) problem = String(errors[0] && errors[0].message)
    else compileScript(descriptor, { id: path.basename(rel), inlineTemplate: true })
  } catch (err) {
    problem = String((err && err.message) || err).split('\n')[0]
  }
  check(`${path.basename(rel)} compiles`, problem, '')
}

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
