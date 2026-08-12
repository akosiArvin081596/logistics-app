/**
 * payoutPeriod — per-period decomposition of the investor payout ledger.
 *
 * WHY THIS EXISTS. The investor portal's green "Still owed to you" card read the
 * LIFETIME totals (payoutTotals.totalOwed / totalPaid / totalAdjustments and
 * production.investorNetToDate) while sitting in a section with a month picker.
 * Every figure on it was therefore identical for every month, which is exactly
 * what the client reported: "it's static, it doesn't change month to month… it
 * needs to show the months of what was paid when it was paid". There was no
 * reactivity bug to fix — `selectedIdx` was read by the load table and by NONE of
 * the card's computeds, and the card was rendered outside the block holding the
 * picker. The join it was missing is `payouts.find(p => p.period === sel.key)`.
 *
 * Everything here is PURE — no Vue, no store, no network — so the arithmetic can
 * be locked by scripts/test-payout-card-period.mjs. Same shape and reasoning as
 * lib/address.js. The single import is the shared month formatter, itself pure
 * and importable by bare Node; the specifier carries its '.js' for exactly that
 * reason, or the lock cannot load this file at all.
 *
 * ---------------------------------------------------------------------------
 * THE THREE CASES, AND WHY EACH ONE IS A SEPARATE BASIS
 * ---------------------------------------------------------------------------
 *   'settled' — a row exists in `payouts` for that month. Owed/processing/paid
 *               come from `status` + `effectiveAmount`, matching the server's own
 *               totals reducer exactly, so per-period figures sum back to the
 *               lifetime totals.
 *
 *   'open'    — ⚠️ THE OPEN MONTH HAS NO ROW IN `payouts`. The server's reconcile
 *               deliberately skips it (only completed past months settle), so a
 *               naive `.find()` returns undefined and a card that renders that as
 *               zeros publishes "$0 still owed" for the month the investor is
 *               actually living in. Falls back to `currentMonth`, whose figures
 *               are an ACCRUAL and a PROJECTION, never a payable.
 *
 *   'none'    — a month the picker offers (it has loads) with no settled row and
 *               which is not the open month. Also NOT $0: `payout` is null so the
 *               UI renders an em-dash and says there is no settlement record,
 *               rather than asserting nothing is owed.
 *
 * Weekly mode has no month to join on at all — `sel.key` is a 'YYYY-MM-DD' week
 * start — so selectPeriodSettlement() returns null and the caller shows the
 * lifetime view. A weekly key must never be matched against a monthly period.
 *
 * ---------------------------------------------------------------------------
 * THE IDENTITY THIS MODULE EXISTS TO KEEP ON SCREEN
 * ---------------------------------------------------------------------------
 * The card's whole job is that its terms add up; the previous version hid every
 * term that happened to be zero-or-absent, so a reader subtracting the visible
 * figures landed on a number that matched nothing (the client's screenshot:
 * 12,034 + 7,554 − 2,450 = 17,138 against 14,781 − 661 = 14,120).
 *
 *   settled:  owed + processing + paid  ==  earned + carriedLoss + drift + adjustments
 *   open:     accruing                  ==  earned
 *   none:     every term is 0 and `payout` is null
 *
 * `carriedLoss` is the movement `lossDeferred − lossCarriedIn`, and it is
 * deliberately 0 on the OPEN month: the server's `carriedLossOutstanding` only
 * sums periods strictly before the current one, because a month still running can
 * still erase its own deficit. Counting the open month's movement here would put
 * the lifetime reconciliation out by exactly that deficit.
 *
 * `drift` is the gap between the FROZEN settled `amount` and what today's records
 * say the month earned (`earned + carriedLoss`). It is not an error — a receipt
 * logged after a month closed moves the live recompute and never the settled
 * figure, which PayoutsSection's waterfall already discloses in prose. Surfacing
 * it as its own term is what makes the sum close for a month that has drifted,
 * instead of leaving an unexplained gap of exactly that size.
 */

// The month-name arithmetic itself is NOT re-implemented here — see
// periodKeyLabel() below for what this module adds on top of it, and why that
// one rule cannot be folded into the shared formatter.
import { monthLabel as formatMonth } from './monthLabel.js'

const MONTH_KEY_RE = /^\d{4}-\d{2}$/
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/** Finite number or 0 — never NaN, which would poison every downstream sum. */
function num(v) {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

/**
 * Whole dollars. Every quantity in the ledger is already integral server-side
 * (monthEarnings is Math.round(investorEarnings), the carry terms are derived
 * from it, effectiveAmount is Math.round(...)), so rounding here is a no-op on a
 * real payload and a guard against a legacy/partial one. Rounding is what lets
 * the identity be asserted with `===` rather than an epsilon.
 */
function whole(v) {
  return Math.round(num(v))
}

export function isMonthKey(v) {
  return MONTH_KEY_RE.test(String(v || '').trim())
}

/**
 * A PERIOD KEY → its label. '2026-08' → 'August 2026'.
 *
 * ⚠️ NOT A PLAIN RE-EXPORT OF lib/monthLabel.js, AND THAT IS DELIBERATE. The
 * shared formatter is tolerant on input: it labels 'YYYY-MM-DD' by the month
 * that day falls in, which is right for a receipt date and WRONG for a period
 * key. In this module a key that is not 'YYYY-MM' is a WEEKLY period — a week
 * START — so labelling '2026-08-01' as "August 2026" would tell an investor a
 * 7-day settlement window is a whole month, on the very card whose bug was that
 * every month showed the same figures. A non-month key is therefore echoed as
 * the day it actually is, and the caller decides (LoadReportsSection guards with
 * isMonthKey() before it ever gets here). Locked by
 * scripts/test-payout-card-period.mjs: "passes non-month through untouched".
 *
 * The FAILURE half now matches the shared contract exactly — a well-formed month
 * key naming a month that does not exist ('2026-13') yields '', not the raw
 * string. That divergence was the real hazard: two functions called `monthLabel`
 * in one directory, one rendering nothing on bad input and the other printing
 * `2026-13` into the UI as though it were a month we had understood.
 *
 * Exported under both names on purpose. `periodKeyLabel` is what new callers
 * should import — it cannot be mistaken for the shared formatter at the import
 * site — while `monthLabel` stays for the lock and for LoadReportsSection.vue.
 */
export function periodKeyLabel(key) {
  const s = String(key ?? '').trim()
  if (!isMonthKey(s)) return s
  return formatMonth(s)
}

/** @deprecated Prefer `periodKeyLabel` here, or `monthLabel` from lib/monthLabel.js. */
export const monthLabel = periodKeyLabel

/**
 * '2026-08' → { start: '2026-08-01', end: '2026-08-31' }, inclusive both ends.
 *
 * The last day is computed from NUMBERS (Date.UTC with day 0 of the next month),
 * never by parsing a date string, so it cannot slip a day in any timezone. Only
 * the day-of-month is read back, so UTC vs local is irrelevant to the result.
 */
export function monthBounds(key) {
  const s = String(key || '').trim()
  if (!isMonthKey(s)) return null
  const y = parseInt(s.slice(0, 4), 10)
  const m = parseInt(s.slice(5, 7), 10)
  if (!y || m < 1 || m > 12) return null
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start: `${s}-01`, end: `${s}-${String(lastDay).padStart(2, '0')}` }
}

/**
 * The date bounds for exporting ONE selected period.
 *
 * Both export buttons sit in the row with the month picker and exported all 12
 * periods regardless of it. The server already parses ?start=/?end= and applies
 * them per row, so no endpoint change is needed — only the two params the client
 * never sent.
 *
 * Monthly: the server publishes `start` but leaves `end` empty, so the closing
 * bound has to be derived here. Weekly: the server already publishes both, and
 * they are exactly right — use them verbatim rather than re-deriving a week.
 */
export function exportRange(periodType, sel) {
  if (!sel) return null
  if (periodType === 'monthly') return monthBounds(sel.key)
  const start = String(sel.start || sel.key || '').trim()
  const end = String(sel.end || '').trim()
  if (!YMD_RE.test(start) || !YMD_RE.test(end)) return null
  return { start, end }
}

/** A download name that names the period, so a scoped export isn't filed as if it were the lot. */
export function exportFileName(periodType, sel, format) {
  const type = periodType === 'weekly' ? 'weekly' : 'monthly'
  const ext = String(format || '').replace(/[^a-z]/gi, '') || 'csv'
  const key = String((sel && sel.key) || '').replace(/[^A-Za-z0-9-]/g, '')
  return key ? `load-report-${type}-${key}.${ext}` : `load-report-${type}.${ext}`
}

/**
 * Is there actually money to settle? A month can land on $0 with a perfectly
 * ordinary `status: 'owed'` — no activity, adjusted out, or (the common one) a
 * loss month whose whole share deferred. PayoutsSection already refuses to show
 * a due date or a settle button on those rows; the card has to agree, or the two
 * surfaces describe the same row differently.
 */
export function isSettleable(s) {
  return !!s && s.basis === 'settled' && typeof s.payout === 'number' && s.payout > 0
}

/**
 * Headline wording for the figure — the answer to "what IS this number?".
 *
 * ⚠️ "Still owed to you $0" is the wording this must never produce. A loss month
 * settles at $0 while still carrying `status: 'owed'`, and captioning that as
 * money awaited — with a due date beside it — promises a payment that is not
 * coming, which is the same class of error as the "-$2,450 owed" row the
 * carry-forward model exists to prevent.
 */
export function payoutHeadline(s) {
  if (!s) return 'Still owed to you'
  if (s.basis === 'open') return 'Projected if the month closed today'
  if (s.basis === 'none') return 'No settlement for this month'
  if (s.status === 'paid') return 'Paid out to you'
  if (!isSettleable(s)) return 'Nothing due for this month'
  if (s.status === 'processing') return 'Payment processing'
  return 'Still owed to you'
}

/**
 * A settled payout row → the card's decomposition.
 *
 * ⚠️ `adjustments` is derived as `payout − settledAmount`, NOT read straight from
 * `adjustmentApplied`. On a real payload the two are identical by construction
 * (the server builds effectiveAmount = round(amount) + adjustmentApplied), but
 * deriving it means the displayed line ALWAYS closes: there is no payload shape,
 * legacy or partial, in which "Settled + Adjustment" can fail to equal "Payout"
 * on screen. That is the specific failure this card is being fixed for.
 */
export function decomposeSettled(row) {
  const period = String((row && row.period) || '')
  const earned = whole(row.monthEarnings)
  const lossCarriedIn = whole(row.lossCarriedIn)
  const lossDeferred = whole(row.lossDeferred)
  const carriedLoss = lossDeferred - lossCarriedIn
  const settledAmount = whole(row.amount)
  // What today's records say the month is worth, post-carry-forward. Equals
  // settledAmount unless the month drifted after it closed.
  const recomputed = earned + carriedLoss
  const drift = settledAmount - recomputed
  const rawAdj = row.adjustmentApplied != null ? row.adjustmentApplied : row.adjustment
  const payout = row.effectiveAmount != null
    ? whole(row.effectiveAmount)
    : settledAmount + whole(rawAdj)
  const adjustments = payout - settledAmount
  const status = String(row.status || '')
  return {
    basis: 'settled',
    hasRecord: true,
    period,
    periodLabel: row.periodLabel || periodKeyLabel(period),
    earned,
    lossCarriedIn,
    lossDeferred,
    carriedLoss,
    drift,
    settledAmount,
    adjustments,
    payout,
    projectedPayout: null,
    owed: status === 'owed' ? payout : 0,
    processing: status === 'processing' ? payout : 0,
    paid: status === 'paid' ? payout : 0,
    accruing: 0,
    status,
    phase: row.phase || '',
    dueDate: row.dueDate || '',
    paidAt: row.paidAt || '',
    graceEndsAt: row.graceEndsAt || '',
    finalizedAt: row.finalizedAt || '',
  }
}

/**
 * The OPEN month → the card's decomposition. Nothing here is payable.
 *
 * `earned` is the SIGNED accrual (`amountInProgress`), deliberately not clamped:
 * it is the term the lifetime reconciliation needs, and a loss-making month
 * genuinely reads negative. What must never be rendered as a payout is that same
 * signed figure — the headline uses `projectedPayout`, which is clamped at $0 for
 * the same reason a settled row never inverts.
 */
export function decomposeOpenMonth(cm) {
  const period = String((cm && cm.period) || '')
  const earned = whole(cm.amountInProgress)
  const lossCarriedIn = whole(cm.lossCarriedIn)
  const lossDeferred = whole(cm.lossDeferred)
  const projectedPayout = cm.payableIfClosedNow != null
    ? Math.max(0, whole(cm.payableIfClosedNow))
    : Math.max(0, earned + lossDeferred - lossCarriedIn)
  return {
    basis: 'open',
    hasRecord: true,
    period,
    periodLabel: cm.periodLabel || periodKeyLabel(period),
    earned,
    lossCarriedIn,
    lossDeferred,
    // 0 ON PURPOSE — see the header note. The open month's loss movement is not a
    // settlement fact yet, and the server's carriedLossOutstanding excludes it.
    carriedLoss: 0,
    drift: 0,
    settledAmount: null,
    adjustments: 0,
    payout: null,
    projectedPayout,
    owed: 0,
    processing: 0,
    paid: 0,
    accruing: earned,
    status: 'accruing',
    phase: cm.phase || 'accruing',
    dueDate: '',
    paidAt: '',
    graceEndsAt: cm.graceEndsAt || '',
    finalizedAt: '',
  }
}

/** A month the picker offers with no ledger row behind it. Explicitly NOT "$0 owed". */
export function noSettlementRecord(period) {
  const key = String(period || '')
  return {
    basis: 'none',
    hasRecord: false,
    period: key,
    periodLabel: periodKeyLabel(key),
    earned: 0,
    lossCarriedIn: 0,
    lossDeferred: 0,
    carriedLoss: 0,
    drift: 0,
    settledAmount: null,
    adjustments: 0,
    payout: null,
    projectedPayout: null,
    owed: 0,
    processing: 0,
    paid: 0,
    accruing: 0,
    status: '',
    phase: '',
    dueDate: '',
    paidAt: '',
    graceEndsAt: '',
    finalizedAt: '',
  }
}

/**
 * THE JOIN. Returns null when there is no month to join on (weekly view, no
 * selection, or a key that isn't 'YYYY-MM') — callers must render the lifetime
 * view in that case, never a partial or guessed month.
 *
 * A settled row wins over `currentMonth` if both somehow describe the same key:
 * the ledger row is what the lifetime totals are computed from, so preferring it
 * keeps the card and the totals telling the same story.
 */
export function selectPeriodSettlement({ periodType, periodKey, payouts, currentMonth } = {}) {
  if (periodType !== 'monthly') return null
  const key = String(periodKey || '').trim()
  if (!isMonthKey(key)) return null
  const row = (Array.isArray(payouts) ? payouts : []).find((p) => p && String(p.period) === key)
  if (row) return decomposeSettled(row)
  if (currentMonth && String(currentMonth.period) === key) return decomposeOpenMonth(currentMonth)
  return noSettlementRecord(key)
}

/**
 * The display rows for the card, in reading order, each one a term of the sum.
 *
 * EVERY participating term is emitted. A term that is genuinely zero is omitted
 * because zero does not participate — but nothing non-zero is ever hidden, which
 * is the regression this replaces (Processing and carried-loss were rendered
 * `v-if` non-zero on a line that also silently dropped drift, so the visible
 * figures could not be reconciled by hand).
 *
 * kind: 'earn' | 'carry' | 'drift' | 'subtotal' | 'adjust' | 'total'
 */
export function settlementTerms(s) {
  if (!s || s.basis === 'none') return []
  const rows = []
  const push = (key, label, value, kind) => rows.push({ key, label, value, kind })

  if (s.basis === 'open') {
    push('earned', 'Earned so far this month', s.earned, 'earn')
    if (s.lossCarriedIn) push('lossCarriedIn', 'Applied to an earlier month’s loss', -s.lossCarriedIn, 'carry')
    if (s.lossDeferred) push('lossDeferred', 'Shortfall that would carry forward', s.lossDeferred, 'carry')
    // Deliberately shorter than payoutHeadline()'s wording: the card's own
    // heading already says "Projected if the month closed today" a few pixels
    // above, and repeating a caveat verbatim reads as two different claims.
    push('projected', 'Projected payout', s.projectedPayout, 'total')
    return rows
  }

  push('earned', 'This month’s earnings', s.earned, 'earn')
  if (s.lossCarriedIn) push('lossCarriedIn', 'Applied to an earlier month’s loss', -s.lossCarriedIn, 'carry')
  if (s.lossDeferred) push('lossDeferred', 'Loss carried to later months', s.lossDeferred, 'carry')
  if (s.drift) push('drift', 'Records changed after this month closed', s.drift, 'drift')
  if (s.adjustments) {
    push('settled', 'Amount this month settled at', s.settledAmount, 'subtotal')
    push('adjustment', 'Manual adjustment', s.adjustments, 'adjust')
  }
  push('payout', payoutHeadline(s), s.payout, 'total')
  return rows
}

/**
 * Does the card's arithmetic close? Exposed so the lock can assert it on every
 * fixture rather than trusting the renderer.
 */
export function settlementIdentity(s) {
  if (!s) return { left: 0, right: 0, ok: true }
  const left = s.owed + s.processing + s.paid + s.accruing
  const right = s.earned + s.carriedLoss + s.drift + s.adjustments
  return { left, right, ok: left === right }
}

/**
 * Sum a set of per-period decompositions back into lifetime shape, so the split
 * can be checked against the server's own `totals` — the property that proves
 * the per-month view lost nothing.
 *
 * `earned` intentionally includes the open month's signed accrual, because
 * investorNetToDate does too.
 */
export function sumSettlements(list) {
  const out = {
    owed: 0, processing: 0, paid: 0,
    adjustments: 0, carriedLoss: 0, drift: 0,
    accruing: 0, earnedSettled: 0, earned: 0,
  }
  for (const s of list || []) {
    if (!s || !s.hasRecord) continue
    out.owed += s.owed
    out.processing += s.processing
    out.paid += s.paid
    out.adjustments += s.adjustments
    out.carriedLoss += s.carriedLoss
    out.drift += s.drift
    out.accruing += s.accruing
    if (s.basis === 'settled') out.earnedSettled += s.earned
  }
  out.earned = out.earnedSettled + out.accruing
  return out
}
