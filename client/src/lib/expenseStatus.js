// What the admin Expenses screen says about a receipt's status, and whether it
// offers Approve / Reject / Undo on it.
//
// `finalized_period` comes from GET /api/expenses/all: the month the receipt
// counts in when that month is finalized, else ''. The server decides it with
// the same month PUT /api/expenses/:id/status checks, so a receipt it marks is
// one that route refuses (409 PERIOD_FINALIZED). Never derive it here from the
// date: posted_period can book a receipt dated in a closed month into an open
// one (scripts/test-expense-finalized-period.js).
//
// Such a receipt is already counted in that month's figures: a Pending receipt
// counts (only Rejected is left out), so "Pending" with an Approve button read
// as work still to do, and every press failed.
//
// scripts/test-expense-finalized-status-client.mjs
import { monthLabel } from './monthLabel.js'

const statusOf = (e) => (e && e.status) || 'Pending'

function finalizedLabel(e) {
  const month = monthLabel(e && e.finalized_period)
  return month ? `Included: ${month} finalized` : ''
}

// Approved and Rejected keep their own words: Approved is included already, and
// Rejected is not included at all, so "Included" would be wrong for it.
export function expenseStatusLabel(e) {
  const status = statusOf(e)
  return status === 'Pending' ? finalizedLabel(e) || status : status
}

export function expenseStatusClass(e) {
  const status = statusOf(e)
  return status === 'Pending' && finalizedLabel(e) ? 'st-finalized' : `st-${status.toLowerCase()}`
}

// No Approve, Reject or Undo on a receipt in a finalized month: the server
// refuses every status change there.
export function expenseStatusChangeable(e) {
  return !(e && e.finalized_period)
}

// The server's own reason (useApi puts its `error` on the message), or the
// client's timeout sentence; the fixed text only when there is neither.
export function statusChangeFailureMessage(err) {
  const message = err && typeof err.message === 'string' ? err.message.trim() : ''
  return message || 'Failed to update status'
}
