#!/usr/bin/env node
/**
 * What the admin screens say about a driver invoice in a closed month once it
 * can be marked Paid (MARK_PAID_CLOSED_MONTH_ENABLED: the payment is recorded
 * and no closed month's figure changes).
 *
 * WHAT IT REPRODUCES: with the flag on the server sends neverPayable:false for
 * an unpaid Approved invoice in a closed month, and the Data Issues page said
 * "Can't be adjusted. It is already Approved, so nothing is waiting on it." —
 * false: the driver still has to be paid. And marking such an invoice Paid
 * toasted a bare "Invoice marked as paid", saying nothing about the closed month
 * the server named (closedMonths in the answer).
 *
 * WHAT IS ASSERTED:
 *   - frozenInvoiceImpact() (client/src/lib/dataIssues.js): an unpaid Approved or
 *     Processing invoice the server no longer calls never payable "can be marked
 *     Paid"; a Draft or Submitted one can be "once it is approved"; both say the
 *     closed month's figures don't change, name the month, and never say nothing
 *     is waiting on it. Settled, never-payable, unreadable-date and unknown-status
 *     rows keep their sentences.
 *   - invoiceActionToast() (client/src/lib/invoiceActionToast.js): a payment the
 *     server says touches closed months names them and says their figures don't
 *     change; any other payment or approval toasts as before.
 *   - InvoicesView.vue's two status actions take their toast from it, with the
 *     server's answer that updateStatus() in the invoices store now returns.
 *
 * Made-up data only. Pure: no server, no network.
 * Run: node scripts/test-closed-month-mark-paid-copy.mjs    # exits 1 on failure
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const lib = (rel) => pathToFileURL(path.join(ROOT, 'client/src/lib', rel)).href
const { frozenInvoiceImpact, normalizeFrozenInvoice } = await import(lib('dataIssues.js'))

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}

const row = (o) => normalizeFrozenInvoice({
  id: 7, invoiceNumber: 'INV-AB-2026W39-01', driver: 'Amy Birch', weekStart: '2026-09-26', weekEnd: '2026-10-02',
  status: 'Approved', amount: 1200, cause: 'PERIOD_FINALIZED', periods: ['2026-09'], adjustable: false,
  neverPayable: false, settled: false, ...o,
})

// ---- the Data Issues sentence ----------------------------------------------
for (const status of ['Approved', 'Processing']) {
  const t = frozenInvoiceImpact(row({ status }))
  check(`${status}, payable with the flag on: "can be marked Paid"`, /can be marked Paid/.test(t) && !/once it is approved/.test(t), t)
  check(`${status}: the closed month's figures don't change, and the month is named`, /figures don't change/.test(t) && /September 2026/.test(t) && !/2026-09/.test(t), t)
  check(`${status}: never "nothing is waiting on it"`, !/nothing is waiting/.test(t), t)
}
for (const status of ['Draft', 'Submitted']) {
  const t = frozenInvoiceImpact(row({ status }))
  check(`${status}, payable with the flag on: "can be marked Paid once it is approved"`, /can be marked Paid once it is approved/.test(t) && /figures don't change/.test(t), t)
  check(`${status}: never "nothing is waiting on it"`, !/nothing is waiting/.test(t), t)
}
{
  const t = frozenInvoiceImpact(row({ periods: ['2026-08', '2026-09'] }))
  check('two closed months: both named, "their figures"', /August 2026/.test(t) && /September 2026/.test(t) && /their figures don't change/.test(t), t)
}
check('flag off (never payable): the sentence as before',
  frozenInvoiceImpact(row({ neverPayable: true })) === "Can't be adjusted, and can't be marked Paid in the app yet — it is Approved, and September 2026 is closed.",
  frozenInvoiceImpact(row({ neverPayable: true })))
check('settled Paid: nothing is waiting on it, as before',
  frozenInvoiceImpact(row({ status: 'Paid', settled: true })) === "Can't be adjusted. It is already Paid, so nothing is waiting on it.",
  frozenInvoiceImpact(row({ status: 'Paid', settled: true })))
check('an unreadable billing date keeps its dead-end sentence',
  /has to be regenerated/.test(frozenInvoiceImpact(row({ cause: 'PERIOD_UNRESOLVED', periods: [] }))))
check('an unknown status is never told it can be marked Paid',
  !/can be marked Paid/.test(frozenInvoiceImpact(row({ status: 'Weird' }))), frozenInvoiceImpact(row({ status: 'Weird' })))

// ---- the toast -------------------------------------------------------------
let invoiceActionToast = null
try {
  ({ invoiceActionToast } = await import(lib('invoiceActionToast.js')))
} catch (err) {
  check('client/src/lib/invoiceActionToast.js loads', false, err.message.split('\n')[0])
}
if (invoiceActionToast) {
  check('a payment touching one closed month',
    invoiceActionToast('paid', { success: true, status: 'Paid', closedMonths: ['2026-09'] }) === "Invoice marked as paid. September 2026 is closed; its figures don't change.",
    invoiceActionToast('paid', { closedMonths: ['2026-09'] }))
  check('a payment touching two closed months',
    invoiceActionToast('paid', { closedMonths: ['2026-08', '2026-09'] }) === "Invoice marked as paid. August 2026 and September 2026 are closed; their figures don't change.",
    invoiceActionToast('paid', { closedMonths: ['2026-08', '2026-09'] }))
  check('an open-month payment, as before', invoiceActionToast('paid', { success: true, status: 'Paid' }) === 'Invoice marked as paid')
  check('no answer, as before', invoiceActionToast('paid', undefined) === 'Invoice marked as paid')
  check('an unreadable month key is not printed', invoiceActionToast('paid', { closedMonths: ['2026-13'] }) === 'Invoice marked as paid')
  check('an approval, as before', invoiceActionToast('approve', { success: true, status: 'Approved' }) === 'Invoice approved')
}

// ---- the view and the store --------------------------------------------------
const VIEW = fs.readFileSync(path.join(ROOT, 'client/src/views/InvoicesView.vue'), 'utf8')
const STORE = fs.readFileSync(path.join(ROOT, 'client/src/stores/invoices.js'), 'utf8')
check('InvoicesView: both status actions toast through invoiceActionToast() with the server answer',
  (VIEW.match(/toast\(invoiceActionToast\(action, result\), 'success'\)/g) || []).length === 2
  && (VIEW.match(/const result = await store\.updateStatus\(/g) || []).length === 2
  && !/marked as paid' : 'approved'/.test(VIEW))
check('the invoices store returns the server answer from updateStatus()',
  /async updateStatus\([^)]*\) \{[\s\S]{0,400}?const res = await api\.put\(`\/api\/invoices\/\$\{id\}\/approve`, body\)[\s\S]{0,120}?return res/.test(STORE))

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
