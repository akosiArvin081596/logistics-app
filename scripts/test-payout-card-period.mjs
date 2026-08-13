#!/usr/bin/env node
// Deterministic check on client/src/lib/payoutPeriod.js — the per-period
// decomposition behind the investor portal's settlement card.
//
// WHY THIS EXISTS. The card ("Still owed to you $7,554 · Earned $14,781 ·
// Adjustments −$661 · Paid out $12,034") sat in a section with a month picker and
// read the LIFETIME totals, so every figure was identical for every month. The
// client: "it's static it doesn't change by month to month… it needs to show the
// months of what was paid when it was paid." The fix is a join —
// payouts.find(p => p.period === sel.key) — and a join on money has three ways to
// be silently, expensively wrong. Each is a paired case below:
//
//   1. THE OPEN MONTH HAS NO ROW IN `payouts`. The server's reconcile settles only
//      COMPLETED past months, so `.find()` returns undefined for the month the
//      investor is actually living in. Rendering that as zeros publishes "$0 still
//      owed" for the current month. It must fall back to `currentMonth`.
//
//   2. A MONTH WITH NO ROW AT ALL is not $0 either. `payout` must be null so the
//      UI renders an em-dash and says there is no settlement record — asserting
//      "nothing is owed" is a claim we cannot stand behind.
//
//   3. WEEKLY MODE HAS NO MONTH TO JOIN ON. `sel.key` is a week start
//      ('YYYY-MM-DD'). It must yield null, never a coincidental match.
//
// A test that only proved "a settled month decomposes" would pass on an
// implementation that returned zeros for everything else — which is exactly the
// bug. So every case is paired with the shape that must NOT produce a figure, and
// the whole set is summed back against the server's own lifetime totals: if the
// per-month split lost or invented a dollar anywhere, that sum stops matching.
//
// Fixture figures are the server's real shapes (GET /api/investor/payouts):
// `monthEarnings` = the month's own signed share, `lossCarriedIn` / `lossDeferred`
// = the carry-forward movement, `amount` = the FROZEN settled figure,
// `effectiveAmount` = amount + adjustmentApplied, clamped at $0.
//
// No network, no sheet, no database, no Vue — pure input/output, safe anywhere.
//
//   node scripts/test-payout-card-period.mjs      # exits 1 on any failure

import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.join(__dirname, '..', 'client', 'src', 'lib', 'payoutPeriod.js')

let pass = 0
let fail = 0

function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`)
  }
}

const mod = await import(pathToFileURL(MODULE_PATH).href)
const {
  isMonthKey, monthLabel, monthBounds, exportRange, exportFileName,
  payoutHeadline, isSettleable, decomposeSettled, decomposeOpenMonth, noSettlementRecord,
  selectPeriodSettlement, settlementTerms, settlementIdentity, sumSettlements,
} = mod

// ---------------------------------------------------------------------------
// THE FIXTURE — one investor's ledger, shaped exactly like the live response.
//
// Chosen so that every branch is exercised by a REAL combination, not a
// synthetic one: a plain paid month, a paid month carrying a manual adjustment,
// a LOSS month that defers, the profitable month that absorbs that loss, an owed
// month still inside its grace window, a month whose records drifted after it
// settled, and an open month with no row.
// ---------------------------------------------------------------------------
const PAYOUTS = [
  // Owed, month over but still inside the grace window.
  {
    id: 6, period: '2026-07', periodLabel: 'July 2026',
    monthEarnings: 7554, lossCarriedIn: 0, lossDeferred: 0,
    amount: 7554, adjustment: 0, adjustmentApplied: 0, effectiveAmount: 7554,
    status: 'owed', phase: 'pending', dueDate: '2026-08-28', paidAt: null,
    graceEndsAt: '2026-08-07',
  },
  // Profitable month that absorbed the earlier loss: earned 5,000, 2,450 of it
  // went to May's deficit, so only 2,550 was payable.
  {
    id: 5, period: '2026-06', periodLabel: 'June 2026',
    monthEarnings: 5000, lossCarriedIn: 2450, lossDeferred: 0,
    amount: 2550, adjustment: 0, adjustmentApplied: 0, effectiveAmount: 2550,
    status: 'paid', phase: 'finalized', dueDate: '2026-07-31',
    paidAt: '2026-07-30T15:04:05Z', graceEndsAt: '2026-06-07',
  },
  // Loss month: settles at $0 and pushes 2,450 forward. NOT a negative payout.
  {
    id: 4, period: '2026-05', periodLabel: 'May 2026',
    monthEarnings: -2450, lossCarriedIn: 0, lossDeferred: 2450,
    amount: 0, adjustment: 0, adjustmentApplied: 0, effectiveAmount: 0,
    status: 'owed', phase: 'finalized', dueDate: '2026-06-26', paidAt: null,
    graceEndsAt: '2026-05-07',
  },
  // Paid, with the manual −$661 correction from the client's screenshot.
  {
    id: 3, period: '2026-04', periodLabel: 'April 2026',
    monthEarnings: 4845, lossCarriedIn: 0, lossDeferred: 0,
    amount: 4845, adjustment: -661, adjustmentApplied: -661, effectiveAmount: 4184,
    status: 'paid', phase: 'finalized', dueDate: '2026-05-29',
    paidAt: '2026-05-28T14:00:00Z', graceEndsAt: '2026-04-07',
  },
  // DRIFT: settled at 3,000, but a receipt logged after the month closed moved
  // the live recompute to 2,900. The settled figure never moves; the gap has to
  // appear as its own term or the card stops adding up by exactly $100.
  {
    id: 2, period: '2026-03', periodLabel: 'March 2026',
    monthEarnings: 2900, lossCarriedIn: 0, lossDeferred: 0,
    amount: 3000, adjustment: 0, adjustmentApplied: 0, effectiveAmount: 3000,
    status: 'paid', phase: 'finalized', dueDate: '2026-04-24',
    paidAt: '2026-04-23T18:30:00Z', graceEndsAt: '2026-03-07',
  },
  // Processing — the status the old card rendered only when non-zero, which is
  // how a term of the sum came to be invisible.
  {
    id: 1, period: '2026-02', periodLabel: 'February 2026',
    monthEarnings: 1300, lossCarriedIn: 0, lossDeferred: 0,
    amount: 1300, adjustment: 0, adjustmentApplied: 0, effectiveAmount: 1300,
    status: 'processing', phase: 'finalized', dueDate: '2026-03-27', paidAt: null,
    graceEndsAt: '2026-02-07',
  },
]

// The open month — NO row in PAYOUTS, by design. Running at a loss, exactly like
// the live investor in the client's screenshot.
const CURRENT_MONTH = {
  period: '2026-08', periodLabel: 'August 2026',
  amountInProgress: -2450,
  payableIfClosedNow: 0,
  lossCarriedIn: 0, lossDeferred: 2450,
  phase: 'accruing', graceEndsAt: '2026-09-07',
}

// What the server's own reducer publishes for this ledger. Recomputed here from
// the fixture the way server.js does, so the assertions below are checking the
// CLIENT split against the SERVER rule rather than against themselves.
const SERVER_TOTALS = {
  totalOwed: 7554 + 0,
  totalProcessing: 1300,
  totalPaid: 2550 + 4184 + 3000,
  totalAdjustments: -661,
  // Deficit still unabsorbed after the last COMPLETED month: sum of
  // (deferred − carriedIn) over periods STRICTLY BEFORE the open one.
  carriedLossOutstanding: (2450 - 0) + (0 - 2450),
}

// ===========================================================================
// 1. MONTH KEYS — the join key itself
// ===========================================================================
check('isMonthKey: month', isMonthKey('2026-08'), true)
// PAIRED: a weekly period key is a DAY. It must not read as a month, or the
// weekly view silently joins onto whatever month contains that day.
check('isMonthKey: week start is not a month', isMonthKey('2026-08-01'), false)
check('isMonthKey: empty', isMonthKey(''), false)
check('isMonthKey: junk', isMonthKey('August 2026'), false)

check('monthLabel', monthLabel('2026-08'), 'August 2026')
check('monthLabel: January (off-by-one on the month index)', monthLabel('2026-01'), 'January 2026')
check('monthLabel: December', monthLabel('2025-12'), 'December 2025')
check('monthLabel: passes non-month through untouched', monthLabel('2026-08-01'), '2026-08-01')

// ===========================================================================
// 2. EXPORT SCOPING — both buttons sit in the picker row and exported all 12
//    periods. The server already applies ?start=/?end=; only the params were
//    missing. A wrong end-of-month here silently truncates a month's report.
// ===========================================================================
check('monthBounds: 31-day', monthBounds('2026-08'), { start: '2026-08-01', end: '2026-08-31' })
check('monthBounds: 30-day', monthBounds('2026-04'), { start: '2026-04-01', end: '2026-04-30' })
check('monthBounds: February, non-leap', monthBounds('2026-02'), { start: '2026-02-01', end: '2026-02-28' })
check('monthBounds: February, leap', monthBounds('2024-02'), { start: '2024-02-01', end: '2024-02-29' })
check('monthBounds: December does not roll the year', monthBounds('2025-12'), { start: '2025-12-01', end: '2025-12-31' })
check('monthBounds: rejects a day', monthBounds('2026-08-01'), null)
check('monthBounds: rejects month 13', monthBounds('2026-13'), null)

check('exportRange: monthly derives the closing bound (server sends end:"")',
  exportRange('monthly', { key: '2026-08', start: '2026-08-01', end: '' }),
  { start: '2026-08-01', end: '2026-08-31' })
// PAIRED: weekly bounds come from the server verbatim — re-deriving a week here
// would be a second, disagreeing definition of "the week".
check('exportRange: weekly uses the server bounds verbatim',
  exportRange('weekly', { key: '2026-08-01', start: '2026-08-01', end: '2026-08-07' }),
  { start: '2026-08-01', end: '2026-08-07' })
check('exportRange: no selection', exportRange('monthly', null), null)
check('exportRange: weekly with no end bound is refused, not half-applied',
  exportRange('weekly', { key: '2026-08-01', start: '2026-08-01', end: '' }), null)

check('exportFileName: monthly names the period',
  exportFileName('monthly', { key: '2026-08' }, 'csv'), 'load-report-monthly-2026-08.csv')
check('exportFileName: weekly names the week',
  exportFileName('weekly', { key: '2026-08-01' }, 'pdf'), 'load-report-weekly-2026-08-01.pdf')
check('exportFileName: no selection falls back',
  exportFileName('monthly', null, 'csv'), 'load-report-monthly.csv')
check('exportFileName: strips path characters out of the key',
  exportFileName('monthly', { key: '../../etc/passwd' }, 'csv'), 'load-report-monthly-etcpasswd.csv')

// ===========================================================================
// 3. THE JOIN — the three bases
// ===========================================================================
const ctx = { payouts: PAYOUTS, currentMonth: CURRENT_MONTH }

// --- 3a. A settled month resolves to its own row, not the lifetime totals ---
const jul = selectPeriodSettlement({ periodType: 'monthly', periodKey: '2026-07', ...ctx })
check('settled: basis', jul.basis, 'settled')
check('settled: owed is THIS month, not the lifetime total', jul.owed, 7554)
check('settled: earned is THIS month', jul.earned, 7554)
check('settled: paid is 0 for an owed month', jul.paid, 0)
check('settled: headline', payoutHeadline(jul), 'Still owed to you')

const apr = selectPeriodSettlement({ periodType: 'monthly', periodKey: '2026-04', ...ctx })
check('settled: a DIFFERENT month gives DIFFERENT figures (the whole bug)',
  { earned: apr.earned, paid: apr.paid, owed: apr.owed, adjustments: apr.adjustments },
  { earned: 4845, paid: 4184, owed: 0, adjustments: -661 })
check('settled: paid date is carried through', apr.paidAt, '2026-05-28T14:00:00Z')
check('settled: headline for a paid month', payoutHeadline(apr), 'Paid out to you')

const feb = selectPeriodSettlement({ periodType: 'monthly', periodKey: '2026-02', ...ctx })
check('settled: processing lands in its own bucket',
  { owed: feb.owed, processing: feb.processing, paid: feb.paid }, { owed: 0, processing: 1300, paid: 0 })

// --- 3b. Carry-forward: a loss month settles at $0 and never inverts ---------
const may = selectPeriodSettlement({ periodType: 'monthly', periodKey: '2026-05', ...ctx })
check('loss month: earned is negative but the payout is 0, never negative',
  { earned: may.earned, payout: may.payout, owed: may.owed }, { earned: -2450, payout: 0, owed: 0 })
check('loss month: the deficit is a visible term', may.carriedLoss, 2450)
// ⚠️ CAUGHT BY RENDERING THE REAL COMPONENT, not by this file: the row still
// carries `status: 'owed'`, so the card printed "Still owed to you $0" with
// "Awaiting payment — due Jun 26, 2026" beside it. Nothing is awaited — the
// shortfall deferred. Same rule PayoutsSection applies with settleable().
check('loss month: $0 is NOT captioned as money awaited',
  payoutHeadline(may), 'Nothing due for this month')
check('loss month: not settleable', isSettleable(may), false)
// PAIRED: a real owed month with money on it must still say so.
check('owed month with money: still reads as owed', payoutHeadline(jul), 'Still owed to you')
check('owed month with money: settleable', isSettleable(jul), true)
// PAIRED: nothing that isn't a settled row can be settleable, whatever it holds.
check('the open month is never settleable', isSettleable(decomposeOpenMonth(CURRENT_MONTH)), false)
check('a no-record month is never settleable', isSettleable(noSettlementRecord('2025-06')), false)
const jun = selectPeriodSettlement({ periodType: 'monthly', periodKey: '2026-06', ...ctx })
check('absorbing month: earned 5000, 2450 to the earlier loss, 2550 paid',
  { earned: jun.earned, carriedLoss: jun.carriedLoss, paid: jun.paid },
  { earned: 5000, carriedLoss: -2450, paid: 2550 })

// --- 3c. Drift: the settled figure is frozen, the recompute is not ----------
const mar = selectPeriodSettlement({ periodType: 'monthly', periodKey: '2026-03', ...ctx })
check('drift: settled 3000 vs recomputed 2900 is surfaced, not swallowed',
  { earned: mar.earned, settledAmount: mar.settledAmount, drift: mar.drift, paid: mar.paid },
  { earned: 2900, settledAmount: 3000, drift: 100, paid: 3000 })

// --- 3d. THE OPEN MONTH — no row in `payouts` -------------------------------
check('open month: genuinely absent from the payout rows',
  PAYOUTS.some((p) => p.period === CURRENT_MONTH.period), false)
const aug = selectPeriodSettlement({ periodType: 'monthly', periodKey: '2026-08', ...ctx })
check('open month: falls back to currentMonth instead of "not found"', aug.basis, 'open')
check('open month: NOTHING is owed/processing/paid — it is not payable',
  { owed: aug.owed, processing: aug.processing, paid: aug.paid }, { owed: 0, processing: 0, paid: 0 })
check('open month: the signed accrual survives (a term of the lifetime sum)', aug.accruing, -2450)
check('open month: the headline figure is the CLAMPED projection, never the signed accrual',
  aug.projectedPayout, 0)
check('open month: `payout` is null — there is no settled figure to render', aug.payout, null)
check('open month: its loss movement is NOT counted as settled carry', aug.carriedLoss, 0)
check('open month: headline names it as a projection',
  payoutHeadline(aug), 'Projected if the month closed today')
// PAIRED, and this is the specific wrong render: a missing row must not become
// "$0 still owed" for the month the investor is living in.
check('open month: does NOT read as an owed row', aug.status, 'accruing')

// A PROFITABLE open month must project the payable, not $0 and not the raw share.
const openProfit = decomposeOpenMonth({
  period: '2026-08', periodLabel: 'August 2026',
  amountInProgress: 5000, payableIfClosedNow: 2550, lossCarriedIn: 2450, lossDeferred: 0,
})
check('open month, profitable: projection is net of the earlier loss',
  { accruing: openProfit.accruing, projected: openProfit.projectedPayout }, { accruing: 5000, projected: 2550 })
// An older server without payableIfClosedNow must still not invent a payable.
const openLegacy = decomposeOpenMonth({
  period: '2026-08', amountInProgress: -2450, lossCarriedIn: 0, lossDeferred: 2450,
})
check('open month, legacy payload: derived projection is clamped at 0', openLegacy.projectedPayout, 0)

// --- 3e. A month the picker offers with NO ledger row anywhere --------------
const orphan = selectPeriodSettlement({ periodType: 'monthly', periodKey: '2025-06', ...ctx })
check('no record: basis', orphan.basis, 'none')
check('no record: `payout` is null so the UI renders "—", NOT "$0"', orphan.payout, null)
check('no record: hasRecord is false', orphan.hasRecord, false)
check('no record: nothing is claimed as owed', orphan.owed, 0)
check('no record: renders no terms at all', settlementTerms(orphan), [])
// PAIRED: the shape must be distinguishable from a real $0 month. May 2026
// genuinely settled at $0 and MUST still render its terms and its record.
check('no record vs a real $0 month: the $0 month has a record',
  { orphanHas: orphan.hasRecord, mayHas: may.hasRecord, mayPayout: may.payout },
  { orphanHas: false, mayHas: true, mayPayout: 0 })
check('a real $0 month still explains itself', settlementTerms(may).length > 1, true)

// --- 3f. WEEKLY MODE — no month to join on ----------------------------------
check('weekly: yields null rather than a wrong join',
  selectPeriodSettlement({ periodType: 'weekly', periodKey: '2026-08-01', ...ctx }), null)
check('weekly: null even when the week start LOOKS like it prefixes a real month',
  selectPeriodSettlement({ periodType: 'weekly', periodKey: '2026-07-01', ...ctx }), null)
// THE MODE WINS OVER THE KEY SHAPE. Both guards are load-bearing and neither is
// a duplicate of the other: today a weekly key is always a day, so the key-shape
// guard happens to cover this — but the moment anything hands the weekly view a
// month-shaped key, only the periodType guard stops a month's settlement being
// published under a single week's loads.
check('weekly: null even for a month-shaped key — the MODE decides',
  selectPeriodSettlement({ periodType: 'weekly', periodKey: '2026-07', ...ctx }), null)
check('an unknown period type is refused, not treated as monthly',
  selectPeriodSettlement({ periodType: 'daily', periodKey: '2026-07', ...ctx }), null)
check('no selection: null', selectPeriodSettlement({ periodType: 'monthly', periodKey: '', ...ctx }), null)
check('undefined key: null', selectPeriodSettlement({ periodType: 'monthly', periodKey: undefined, ...ctx }), null)
check('no arguments at all: null', selectPeriodSettlement(), null)
check('monthly but a day key: null, never a prefix match',
  selectPeriodSettlement({ periodType: 'monthly', periodKey: '2026-07-15', ...ctx }), null)

// A settled row wins over currentMonth if both describe the same key — the
// ledger row is what the lifetime totals are built from.
check('collision: the settled row wins over currentMonth',
  selectPeriodSettlement({
    periodType: 'monthly', periodKey: '2026-07',
    payouts: PAYOUTS, currentMonth: { ...CURRENT_MONTH, period: '2026-07' },
  }).basis, 'settled')

// ===========================================================================
// 4. THE ARITHMETIC CLOSES ON SCREEN
//    owed + processing + paid + accruing == earned + carriedLoss + drift + adjustments
// ===========================================================================
for (const p of PAYOUTS) {
  const s = decomposeSettled(p)
  const id = settlementIdentity(s)
  check(`identity holds for ${p.period}`, id, { left: id.left, right: id.left, ok: true })
}
check('identity holds for the open month', settlementIdentity(aug).ok, true)
check('identity holds for a no-record month', settlementIdentity(orphan).ok, true)

// The rendered terms must sum to the figure they sit under — otherwise the card
// is showing an arithmetic it cannot support, which is the original complaint.
function termsFoot(s) {
  const rows = settlementTerms(s)
  // Never null: a harness that throws here reports a Node stack trace instead of
  // the assertion that failed, which is how a caught mutant reads as a broken
  // test run. Absent terms are themselves a failure of this check.
  if (!rows.length) return { sum: null, total: null, ok: false }
  const total = rows[rows.length - 1]
  // Sum everything up to (and excluding) the closing total, skipping the
  // subtotal, which is a running restatement rather than a new term.
  const sum = rows
    .slice(0, -1)
    .filter((r) => r.kind !== 'subtotal')
    .reduce((a, r) => a + r.value, 0)
  return { sum, total: total.value, ok: sum === total.value }
}
for (const p of PAYOUTS) {
  const s = decomposeSettled(p)
  check(`rendered terms foot to the payout for ${p.period}`, termsFoot(s).ok, true)
}
check('rendered terms foot to the projection for the open month', termsFoot(aug).ok, true)
check('rendered terms foot for a profitable open month', termsFoot(openProfit).ok, true)

// PAIRED — the failure this replaces. Hiding a non-zero term breaks the sum by
// exactly that term, which is how "12,034 + 7,554 − 2,450" came to disagree with
// "14,781 − 661" by $3,018 on screen.
const juneTerms = settlementTerms(jun)
check('the carried-loss term is RENDERED, not hidden',
  juneTerms.some((t) => t.key === 'lossCarriedIn' && t.value === -2450), true)
const marTerms = settlementTerms(mar)
check('the drift term is RENDERED, not hidden',
  marTerms.some((t) => t.key === 'drift' && t.value === 100), true)
const aprTerms = settlementTerms(apr)
check('an adjusted month shows Settled, Adjustment AND Payout',
  aprTerms.filter((t) => ['settled', 'adjustment', 'payout'].includes(t.key)).map((t) => t.value),
  [4845, -661, 4184])
// PAIRED: a term that is genuinely zero does not participate and is omitted, so
// an unadjusted month is not padded with meaningless "+$0" lines.
check('an unadjusted month shows no adjustment line',
  settlementTerms(jul).some((t) => t.key === 'adjustment'), false)
check('a month with no drift shows no drift line',
  settlementTerms(jul).some((t) => t.key === 'drift'), false)

// ===========================================================================
// 5. NOTHING IS LOST — the per-month split sums back to the SERVER's totals
// ===========================================================================
const allKeys = [...PAYOUTS.map((p) => p.period), CURRENT_MONTH.period]
const decomposed = allKeys.map((k) => selectPeriodSettlement({ periodType: 'monthly', periodKey: k, ...ctx }))
const summed = sumSettlements(decomposed)

check('sum of per-month owed == server totalOwed', summed.owed, SERVER_TOTALS.totalOwed)
check('sum of per-month processing == server totalProcessing', summed.processing, SERVER_TOTALS.totalProcessing)
check('sum of per-month paid == server totalPaid', summed.paid, SERVER_TOTALS.totalPaid)
check('sum of per-month adjustments == server totalAdjustments', summed.adjustments, SERVER_TOTALS.totalAdjustments)
check('sum of per-month carried loss == server carriedLossOutstanding',
  summed.carriedLoss, SERVER_TOTALS.carriedLossOutstanding)
check('the open month contributes its accrual and nothing else', summed.accruing, -2450)

// The lifetime identity the card's context line has always claimed, now provably
// derived from the per-month rows rather than asserted alongside them.
//   paid + processing + owed + accruing == earned + adjustments + carriedLoss + drift
const left = summed.owed + summed.processing + summed.paid + summed.accruing
const right = summed.earned + summed.adjustments + summed.carriedLoss + summed.drift
check('lifetime identity reconstructed from the monthly split', { left, right }, { left, right: left })
// investorNetToDate is the sum of every month's own share, open month included.
const netToDate = PAYOUTS.reduce((a, p) => a + p.monthEarnings, 0) + CURRENT_MONTH.amountInProgress
check('summed earnings == investorNetToDate', summed.earned, netToDate)

// A ledger with NO open month at all (an investor whose current month has no
// activity) must still reconcile — sumSettlements must not assume one exists.
const noOpen = PAYOUTS.map((p) => decomposeSettled(p))
check('sums without an open month', sumSettlements(noOpen).accruing, 0)
check('sums without an open month: paid unchanged', sumSettlements(noOpen).paid, SERVER_TOTALS.totalPaid)

// ===========================================================================
// 6. DEFENSIVE — a partial/legacy payload must degrade, never emit NaN. A NaN
//    here does not throw; it propagates into a dollar figure on an investor's
//    screen and into every total that touches it.
// ===========================================================================
const bare = decomposeSettled({ period: '2026-01', amount: 900, status: 'owed' })
check('legacy row: no adjustment fields → payout falls back to the amount',
  { payout: bare.payout, adjustments: bare.adjustments, owed: bare.owed }, { payout: 900, adjustments: 0, owed: 900 })
check('legacy row: label derived when periodLabel is absent', bare.periodLabel, 'January 2026')

// ⚠️ THE CLAMPED OVER-DEDUCTION. A payout can be reduced to $0 but never
// inverted, so a −$2,000 adjustment on a $1,000 month only LANDS as −$1,000.
// `adjustments` is therefore derived as payout − settledAmount rather than read
// from the requested `adjustment`: reading the request renders "1,000 − 2,000 =
// 0" on screen, which is the arithmetic failure this whole card is being fixed
// for. Newer servers publish `adjustmentApplied` for exactly this reason; this
// row is the legacy shape that does not.
const clamped = decomposeSettled({
  period: '2026-01', amount: 1000, adjustment: -2000, effectiveAmount: 0, status: 'owed',
})
check('clamped over-deduction: the adjustment shown is the one that LANDED',
  { settled: clamped.settledAmount, adjustments: clamped.adjustments, payout: clamped.payout },
  { settled: 1000, adjustments: -1000, payout: 0 })
check('clamped over-deduction: the rendered terms still foot', termsFoot(clamped).ok, true)

// Whole dollars. Every ledger figure is integral server-side, so this guards a
// legacy/partial payload — a fractional amount must not leave the terms and the
// total disagreeing by cents on screen.
const fractional = decomposeSettled({
  period: '2026-01', amount: 2549.6, monthEarnings: 2549.6, status: 'owed',
})
check('fractional payload renders in whole dollars',
  { settled: fractional.settledAmount, earned: fractional.earned, payout: fractional.payout },
  { settled: 2550, earned: 2550, payout: 2550 })
check('fractional payload: identity still holds exactly', settlementIdentity(fractional).ok, true)
const junky = decomposeSettled({
  period: '2026-01', amount: 'not a number', monthEarnings: null,
  lossCarriedIn: undefined, lossDeferred: NaN, effectiveAmount: 'x', status: 'owed',
})
check('junk row: every figure is a finite number',
  [junky.earned, junky.settledAmount, junky.payout, junky.adjustments, junky.carriedLoss, junky.drift]
    .every((v) => Number.isFinite(v)), true)
check('junk row: identity still holds', settlementIdentity(junky).ok, true)
check('an unknown status is counted nowhere (not silently as owed)',
  (() => {
    const s = decomposeSettled({ period: '2026-01', amount: 500, effectiveAmount: 500, adjustmentApplied: 0, status: 'reopened' })
    return { owed: s.owed, processing: s.processing, paid: s.paid }
  })(), { owed: 0, processing: 0, paid: 0 })
check('a null payouts array does not throw',
  selectPeriodSettlement({ periodType: 'monthly', periodKey: '2026-07', payouts: null, currentMonth: null }).basis, 'none')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
