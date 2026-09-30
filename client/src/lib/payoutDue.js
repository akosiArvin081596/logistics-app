/**
 * payoutDue — whether a payout ledger row has money to settle, for the Super
 * Admin Payouts console (views/PayoutsView.vue).
 *
 * The server decides. POST /api/investor/payouts/:id/status refuses to move a
 * row forward to processing or paid while round(amount + adjustment) is $0 or
 * less (409 "Nothing to settle for this period"), and a row's effectiveAmount
 * is that same figure clamped at $0. So a row whose effectiveAmount is $0 has
 * nothing due: an idle month, a loss month whose loss is carried forward, a
 * month whose earnings went to an earlier loss, a lease month the lease does
 * not pay, or a month adjusted to $0. Closing the month freezes such a row as
 * it is; nothing on the server needs it marked paid. Walking a row back
 * (Reopen) is exempt from the refusal and an adjustment is not a settlement, so
 * the console still offers both.
 *
 * The investor's own Payouts page (components/investor/PayoutsSection.vue,
 * settleable()) calls such a row "nothing due" and explains a loss month in the
 * words below. The console says the same, so the two never tell different
 * stories about one row. scripts/test-payout-due-client.mjs pins the server
 * rule, the investor page's words and the console's buttons.
 *
 * Pure: no Vue, no network, so the runner loads it under plain Node.
 */
import { formatCurrency } from '../utils/format.js'

// What the row pays after its adjustment: the server's effectiveAmount, or the
// same arithmetic for a payload without it.
function payable(row) {
  if (!row) return 0
  const n = row.effectiveAmount != null
    ? Number(row.effectiveAmount)
    : Math.max(0, Math.round(Number(row.amount || 0) + Number(row.adjustment || 0)))
  return Number.isFinite(n) ? n : 0
}

// True when the row has money to pay, i.e. the server would let it be marked
// processing or paid.
export function hasAmountDue(row) {
  return payable(row) > 0
}

// True when the row's status pill reads "nothing due" rather than "owed". A $0
// row already moved to processing or paid keeps its recorded status, because
// the console is where that move is walked back (Reopen).
export function showsNothingDue(row) {
  return !!row && row.status === 'owed' && !hasAmountDue(row)
}

// Why a split month has nothing due, in the investor page's words, or ''. A
// lease month's reason is the lease's own (payoutBasis.js, leaseReasonText) and
// is shown beside it already, so it is never repeated here. An idle month has
// no reason to give.
export function nothingDueReason(row) {
  if (!row || hasAmountDue(row) || row.payoutBasis) return ''
  const deferred = Number(row.lossDeferred) || 0
  if (deferred > 0) return `${formatCurrency(deferred)} loss carried to later months`
  const carriedIn = Number(row.lossCarriedIn) || 0
  if (carriedIn > 0) return `earned ${formatCurrency(row.monthEarnings)} · ${formatCurrency(carriedIn)} applied to an earlier loss`
  return ''
}
