// An investor's payout basis on the admin screens: a split of net profit at
// the investor's Split %, or a fixed monthly lease. The words and the small
// rules the Payout Basis panel, the Investor Directory, the accept result and
// the Payouts console share, so the four say the same thing.
//
// The server decides everything here: GET/PUT /api/investors/:id/payout-basis,
// the payout rows' payoutBasis and the accept response's payoutBasis. This
// module only describes what it answered, and checks a form before it is sent.
// L1 and L4-L6 are the agreed investor-facing lease wording, word for word.
//
// Pure: no Vue, no network, so scripts/test-investor-invite-client.mjs runs it
// under plain Node.

import { monthLabel } from '../../lib/monthLabel.js'
import { formatCurrency } from '../../utils/format.js'
import { MESSAGES as TERMS_MESSAGES, TYPE_LABELS, formatMoneyCents, parseLeaseAmountToCents } from '../../lib/paymentTerms.js'

export const LEASE_LABEL = 'Fixed monthly lease'

// Lease payouts are applied only while INVESTOR_LEASE_PAYOUTS_ENABLED is on.
export const STATUS_OFF = 'Recorded, not yet applied: lease payouts are switched off. Payouts still use the Split %.'

export const NOTE_MAX = 300
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

const SOURCE_LABELS = Object.freeze({
  signed_terms: 'Signed terms',
  admin: 'Set by an admin',
  default: 'Default: nothing recorded',
})

// A whole-dollar amount as "$2,000"; anything else (a legacy amount with
// cents) to the cent, never rounded into a different figure.
export function formatLeaseAmount(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n) || n < 0) return ''
  return Number.isInteger(n) ? formatCurrency(n) : formatMoneyCents(Math.round(n * 100))
}

// "Lease $2,000/mo", for the Investor Directory beside the Split % cell.
export function leaseBadgeLabel(amount) {
  return `Lease ${formatLeaseAmount(amount)}/mo`
}

// Why a lease month pays other than the lease amount (L4-L6), or ''.
export function leaseReasonText(basis) {
  if (!basis || basis.type !== 'lease') return ''
  if (basis.reason === 'prorated') {
    return `The lease covered ${basis.coveredDays} of ${basis.daysInMonth} days this month, so this month pays ${formatLeaseAmount(basis.paidAmount)}.`
  }
  if (basis.reason === 'downtime') {
    return 'No lease payment is owed for this month: the truck had no activity, and your agreement (section 3.1) owes nothing during downtime.'
  }
  if (basis.reason === 'not_in_service') {
    return 'No lease payment is owed for this month: no truck was in service under your lease.'
  }
  return ''
}

// One basis ({ type, leaseAmount, splitPct, effectiveMonth }) in a phrase:
// "Fixed monthly lease of $2,000 from September 2026", "Split at 50% of net profit".
export function describeBasis(basis) {
  if (!basis) return ''
  const from = monthLabel(basis.effectiveMonth)
  const since = from ? ` from ${from}` : ''
  if (basis.type === 'lease') return `${LEASE_LABEL} of ${formatLeaseAmount(basis.leaseAmount)}${since}`
  const pct = Number(basis.splitPct)
  const split = Number.isFinite(pct) ? `Split at ${pct}% of net profit` : 'Split % of net profit'
  return `${split}${since}`
}

// The panel's headline for the current basis.
export function currentBasisText(current) {
  if (!current) return ''
  const text = describeBasis(current)
  return current.source === 'default' ? `${text} (default)` : text
}

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || String(source || '')
}

// The signed agreement's terms, for comparison with the basis.
export function signedTermsText(signed) {
  if (!signed) return 'None readable: the standard contract, or signed terms that could not be read'
  if (signed.type === 'lease') return `${TYPE_LABELS.lease} of ${formatLeaseAmount(signed.leaseAmount)} per month`
  return TYPE_LABELS.split
}

// True when the signed terms name a lease (or a split) the current basis does not.
export function differsFromSigned(current, signed) {
  if (!current || !signed) return false
  if (signed.type === 'lease') return !(current.type === 'lease' && Number(current.leaseAmount) === Number(signed.leaseAmount))
  return current.type === 'lease'
}

// Whether the change reaches payouts, in one sentence and a style.
export function basisStatus(view) {
  const rows = Array.isArray(view?.schedule) ? view.schedule : []
  if (view?.enabled !== true) {
    return rows.length
      ? { tone: 'warn', text: STATUS_OFF }
      : { tone: 'muted', text: 'Lease payouts are switched off. Payouts use the Split %.' }
  }
  const first = rows.map((r) => r.effectiveMonth).filter((m) => MONTH_RE.test(m || '')).sort()[0]
  return first
    ? { tone: 'ok', text: `Applied to payouts from ${monthLabel(first)}` }
    : { tone: 'muted', text: 'Lease payouts are switched on. No basis is recorded, so payouts use the Split %.' }
}

// The three lease settings in plain words, in a fixed order.
export function settingsLines(settings) {
  const s = settings || {}
  return [
    s.downtime === 'paid'
      ? 'A month with no activity on the investor\'s trucks still pays the lease.'
      : 'A month with no activity on the investor\'s trucks pays no lease (downtime).',
    s.prorate === 'none'
      ? 'A month the lease covers only in part still pays the full lease.'
      : 'A month the lease covers only in part pays for the days it covers.',
    s.retirement === 'continue'
      ? 'Retiring a truck does not end the lease: the days after it are still covered.'
      : 'The days after the investor\'s trucks are retired are not covered by the lease.',
  ]
}

// 'YYYY-MM' plus n months, by string arithmetic (no Date, no time zone).
export function addMonths(month, n) {
  const m = MONTH_RE.exec(String(month || ''))
  if (!m) return ''
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + n
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

// The months the form accepts: from the month after the last settled one (or
// unbounded), to twelve months after the current Houston month. `today` is
// 'YYYY-MM-DD'. The form starts on this month, or on the first editable one.
export function monthBounds(today, earliestEditableMonth) {
  const current = String(today || '').slice(0, 7)
  const max = addMonths(current, 12)
  const min = MONTH_RE.test(earliestEditableMonth || '') ? earliestEditableMonth : ''
  const start = min && min > current ? min : current
  return { min, max, start }
}

// The form's four fields → the PUT body, or the first problem beside each field.
export function validateBasisForm({ type, amount, month, note }, { min, max }) {
  const errors = {}
  let leaseAmount = null
  if (type !== 'split' && type !== 'lease') errors.type = 'Choose a split of net profit or a fixed monthly lease.'
  if (type === 'lease') {
    const parsed = parseLeaseAmountToCents(typeof amount === 'string' ? amount : String(amount ?? ''))
    if (parsed.ok) leaseAmount = parsed.value / 100
    else errors.amount = TERMS_MESSAGES[parsed.reason]
  }
  const m = String(month || '').trim()
  if (!MONTH_RE.test(m)) errors.month = 'Enter the month as YYYY-MM, for example 2026-10.'
  else if (min && m < min) errors.month = `${monthLabel(min)} is the earliest month that can change. Every earlier month is settled for this investor.`
  else if (max && m > max) errors.month = `Pick a month no later than ${monthLabel(max)}.`
  const text = String(note ?? '').trim()
  if (text.length > NOTE_MAX) errors.note = `The note can be at most ${NOTE_MAX} characters.`
  if (Object.keys(errors).length) return { ok: false, errors }
  const body = { type, effectiveMonth: m, note: text }
  if (type === 'lease') body.leaseAmount = leaseAmount
  return { ok: true, body }
}

// The accept result's payoutBasis → one sentence (no final period), or '' when
// the response carries none.
export function acceptBasisLine(payoutBasis) {
  if (!payoutBasis || typeof payoutBasis !== 'object') return ''
  const where = 'Set it in the Payout Basis panel on the Investors page'
  if (payoutBasis.recorded === true) {
    return `Payout basis recorded: ${describeBasis(payoutBasis).replace(/^./, (c) => c.toLowerCase())}`
  }
  if (payoutBasis.recorded === false) {
    if (payoutBasis.reason === 'LEASE_AMOUNT_WHOLE_DOLLARS') {
      return `No payout basis was recorded: the signed lease amount is not a whole number of dollars. ${where}`
    }
    return `No payout basis was recorded${payoutBasis.reason ? ` (${payoutBasis.reason})` : ''}. ${where}`
  }
  return ''
}

// True until the server says lease payouts are on: pending, failed and off all
// count as off, so the invite form's contract-only warning and the Directory's
// "not yet applied" never hide on a guess. `settings` is the GET
// /api/investor-payout-settings answer, or null while pending or after a failure.
export function leasePayoutsOff(settings) {
  return settings?.enabled !== true
}
