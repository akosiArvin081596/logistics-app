/**
 * leasePayoutText — the investor-facing wording for a month paid as a FIXED
 * MONTHLY LEASE, one client copy.
 *
 * An investor can sign either a profit split or a fixed monthly lease. A lease
 * month's figures are the server's own (`investorEarnings`, `payable`,
 * `monthShare`, `amount` all equal the lease payment); what changes is the
 * sentence around them, which must never say "share of net profit", "× N%" or
 * "carried forward" about an agreement that has none of those.
 *
 * ⚠️ EVERY SENTENCE HERE IS THE AGREED CANONICAL COPY, VERBATIM — the same words
 * the statement PDF and the downloadable report print (their server copies live
 * in lib/payout-statement.js and lib/investor-report-options.js). A reworded
 * sentence here makes the portal and the documents the investor keeps say two
 * different things about the same payment, so change the copies together or
 * not at all. scripts/test-lease-payout-text.mjs pins each one character for
 * character.
 *
 * ONE COPY ON THE CLIENT: portal and admin screens import from here rather than
 * keeping their own. A placeholder is written `{name}` and filled by
 * fillLeaseText(); the builders below fill the ones the portal prints.
 *
 * Pure: no Vue, no DOM, no imports, so it runs under plain Node.
 */

/** L1 — the basis, as a label. */
export const LEASE_LABEL = 'Fixed monthly lease'
/** L2 — the headline sub-line. {amount}: the monthly lease, e.g. "$2,000". */
export const LEASE_SUB_LINE = 'Fixed monthly lease payment of {amount}'
/** L3 — what a lease pays, and that the truck's P&L does not move it. */
export const LEASE_EXPLAIN = "Under your agreement you are paid a fixed monthly lease of {amount}, not a share of net profit. Your truck's revenue and costs are shown for your information and do not change this payment."
/** L4 — reason `prorated`. {covered}/{days}: day counts; {paid}: this month's payment. */
export const LEASE_REASON_PRORATED = 'The lease covered {covered} of {days} days this month, so this month pays {paid}.'
/** L5 — reason `downtime`. */
export const LEASE_REASON_DOWNTIME = 'No lease payment is owed for this month: the truck had no activity, and your agreement (section 3.1) owes nothing during downtime.'
/** L6 — reason `not_in_service`. */
export const LEASE_REASON_NOT_IN_SERVICE = 'No lease payment is owed for this month: no truck was in service under your lease.'
/** L7 — where a split month would explain its loss carry-forward. */
export const LEASE_LOSS_NOTE = 'A month your truck runs at a loss still pays the full lease. Losses are not carried forward against your lease.'
/** L8 — the report note (server copy: NOTE.LEASE). {amount}: the monthly lease. */
export const LEASE_REPORT_NOTE = 'Your payout is a fixed monthly lease of {amount}, not a share of net profit.'
/** L8b — the report note from a month on (server copy: NOTE.LEASE_FROM). {month}: e.g. "September 2026". */
export const LEASE_REPORT_NOTE_FROM = 'From {month}, your payout is a fixed monthly lease of {amount}, not a share of net profit.'
/** L9 — the report's payout label (server copy: PAYOUT_LABEL.LEASE). */
export const LEASE_REPORT_LABEL = 'Investor Payout (fixed monthly lease)'
/** L10 — in place of a per-load share. */
export const LEASE_NO_LOAD_SHARE = 'Paid as a fixed monthly lease, so there is no per-load share.'

/** The server's `payoutBasis.reason` → its sentence (L4–L6). null means the full lease. */
export const LEASE_REASON_TEXT = Object.freeze({
  prorated: LEASE_REASON_PRORATED,
  downtime: LEASE_REASON_DOWNTIME,
  not_in_service: LEASE_REASON_NOT_IN_SERVICE,
})

/**
 * Whole dollars, formatted like the rest of the portal: 2000 → '$2,000'.
 * Lease amounts and payments are whole dollars on the server; a non-finite
 * value reads as $0 rather than "$NaN".
 */
export function leaseDollars(v) {
  const n = Number(v)
  const x = Math.round(Number.isFinite(n) ? n : 0)
  return (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US')
}

/**
 * Fill `{name}` placeholders from `values`. A placeholder with no value is left
 * as written, so a missing figure is visible in review rather than silently
 * becoming an empty gap in a sentence about money.
 */
export function fillLeaseText(template, values = {}) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    (Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole))
}

/** L2 for a basis: 'Fixed monthly lease payment of $2,000'. */
export function leaseSubLine(basis) {
  return fillLeaseText(LEASE_SUB_LINE, { amount: leaseDollars(basis && basis.leaseAmount) })
}

/** L3 for a basis. */
export function leaseExplain(basis) {
  return fillLeaseText(LEASE_EXPLAIN, { amount: leaseDollars(basis && basis.leaseAmount) })
}

/**
 * Why this month pays something other than the full lease (L4–L6), or '' when
 * it pays the full lease (reason null) or the server sent a reason this client
 * does not know. An unknown reason renders nothing rather than a guess: the
 * figure beside it is still the server's own.
 */
export function leaseReasonLine(basis) {
  if (!basis || !Object.prototype.hasOwnProperty.call(LEASE_REASON_TEXT, basis.reason)) return ''
  return fillLeaseText(LEASE_REASON_TEXT[basis.reason], {
    covered: Math.round(Number(basis.coveredDays) || 0),
    days: Math.round(Number(basis.daysInMonth) || 0),
    paid: leaseDollars(basis.paidAmount),
  })
}
