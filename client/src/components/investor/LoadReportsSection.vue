<!--
  LoadReportsSection — the investor's PAYMENT SUMMARY for a chosen month, plus
  the loads behind it. Fetches GET /api/investor/load-report (per-period load
  lists + gross revenue). Broker identity is never shown. "Your Net Result" is the
  authoritative NET investor earnings from the dashboard's monthlyEarnings (passed
  in via :production): the monthly total, and per completed load its rate-weighted
  slice of that month's net — so every figure reconciles with EarningsSection /
  the rest of the portal. Weekly has no monthly-net mapping, so it shows loads +
  gross only. Exports pass the same net back as ?net=YYYY-MM:amount so the
  PDF/CSV reconcile too, and are scoped to the selected period via ?start=/?end=.

  EVERY FIGURE IN THIS SECTION IS P&L, NOT A PAYABLE, except the settlement card
  at the top. The Net Result tile was named "Your Share (net)" and printed in
  green: on a month running at -$2,450 that read as money owed, which is
  indistinguishable from the complaint the payout carry-forward work exists to
  answer. The rule this section now follows, and which any figure added here must
  follow: an investor should be able to tell WITHOUT knowing our vocabulary which
  numbers are money they will receive and which are how the business performed.
  Money received lives in PayoutsSection and in the settlement card; everything
  else here is performance, is named as such, and never borrows the green.

  ---------------------------------------------------------------------------
  THE CARD FOLLOWS THE MONTH PICKER (client, 2026-08-12)
  ---------------------------------------------------------------------------
  Client, verbatim: "this is also confusing as well because it's static it
  doesn't change by month to month… this is more so a payment report not a load
  report… it needs to show the months of what was paid when it was paid."

  It was static BY CONSTRUCTION, not by a reactivity bug. `selectedIdx` was read
  by the load table and by NONE of the card's computeds — every one of them read
  a lifetime source (payoutTotals.*, production.investorNetToDate) — and the card
  was rendered structurally OUTSIDE the block that holds the picker, so there was
  not even a visual suggestion that one governed the other. `accruing` was pinned
  to the server's current month, so the italic line said "August 2026" while the
  investor was looking at 2025-06.

  The join was one line: payouts.find(p => p.period === sel.key). It lives in
  lib/payoutPeriod.js (pure, so scripts/test-payout-card-period.mjs can lock it),
  along with the two traps that make a naive join publish wrong money:

    • THE OPEN MONTH HAS NO ROW IN `payouts` — the server's reconcile settles only
      completed past months. A missing row must fall back to `currentMonth` and
      must never render as "$0 still owed".
    • WEEKLY MODE HAS NO MONTH TO JOIN ON — `sel.key` is a week start
      ('YYYY-MM-DD'). The selector returns null and this card shows the LIFETIME
      view, which is also what it shows before a period is selected.

  Every term of the sum is rendered, not just the non-zero-and-remembered ones.
  The old context line hid Processing and carried-loss behind v-if and had no
  concept of settlement drift at all, so a reader adding up what was on screen
  landed on a number matching nothing (the client's screenshot: 12,034 + 7,554 −
  2,450 = 17,138 against 14,781 − 661 = 14,120). See the identity note in
  lib/payoutPeriod.js.

  The lifetime totals are still on screen, explicitly labelled "All months", so
  scoping the card to one period lost nothing.

  The ledger source is unchanged: investorStore's payouts slice, from GET
  /api/investor/payouts — the exact same source the Payouts section renders, so
  the two can never disagree. Honors Super-Admin "view as investor" through the
  :preview-user-id prop (threaded as ?as_user_id=).
-->
<template>
  <div class="lr-section">
    <div class="lr-head">
      <div class="lr-headings">
        <!-- The client called this "a payment report, not a load report". It is
             both, and the title now says so — the settlement card leads, the
             loads that produced it follow. -->
        <h2 class="lr-title">Payment Summary &amp; Load Reports</h2>
        <p class="lr-subtitle">What you earned, what was adjusted and what was paid — for the period you pick.</p>
      </div>
      <div class="lr-toggle">
        <button :class="['lr-tab', { active: period === 'monthly' }]" @click="setPeriod('monthly')">Monthly</button>
        <button :class="['lr-tab', { active: period === 'weekly' }]" @click="setPeriod('weekly')">Weekly</button>
      </div>
    </div>

    <!-- THE PICKER LEADS. Everything below it — the settlement card, the tiles
         and the load table — is scoped to this selection, so it must be the first
         control on the section rather than sitting under the figures it governs. -->
    <div class="lr-nav" v-if="!loading && !error && periods.length">
      <button class="lr-navbtn" :disabled="selectedIdx >= periods.length - 1" @click="selectedIdx++">‹ Older</button>
      <select v-model.number="selectedIdx" class="lr-select" aria-label="Select a period">
        <option v-for="(p, i) in periods" :key="p.key" :value="i">{{ optionLabel(p) }}</option>
      </select>
      <button class="lr-navbtn" :disabled="selectedIdx <= 0" @click="selectedIdx--">Newer ›</button>
      <div class="lr-export">
        <!-- Scoped to the selected period (?start=/?end=), which is what sitting
             in this row has always implied and never did. -->
        <button class="lr-exp" :title="exportTitle('CSV')" @click="exportReport('csv')">Export CSV</button>
        <button class="lr-exp" :title="exportTitle('PDF')" @click="exportReport('pdf')">Export PDF</button>
      </div>
    </div>

    <!-- Ledger unavailable (e.g. Super Admin on /investor previewing nobody —
         payouts are per-owner and 400 there). Show earnings only; never render
         a $0 "owed" we can't stand behind. -->
    <div class="lr-owed" v-if="ledgerFailed">
      <div class="lr-owed-row">
        <span class="lr-owed-label">Earned to date</span>
        <span class="lr-owed-value">{{ fmtMoney(earnedToDate) }}</span>
      </div>
      <span class="lr-owed-context">Net investor share across every month</span>
    </div>
    <!-- While the ledger is still loading, hold the label and dash the amount
         rather than flashing a $0 owed or a different heading. -->
    <div class="lr-owed" :class="cardTone" v-else>
      <div class="lr-owed-row">
        <span class="lr-owed-label">
          {{ headline }}
          <span class="lr-owed-scope">{{ scopeLabel }}</span>
        </span>
        <span class="lr-owed-value">{{ ledgerLoading ? '—' : headlineValue }}</span>
      </div>

      <template v-if="!ledgerLoading">
        <!-- The status and, for a settled month, WHEN — the client's literal ask
             ("show the months of what was paid when it was paid"). -->
        <span class="lr-owed-context" v-if="stateNote">{{ stateNote }}</span>

        <!-- Every term of the sum, so the arithmetic closes on screen. A term
             that is genuinely zero is omitted because zero does not participate;
             nothing non-zero is ever hidden. -->
        <dl class="lr-terms" v-if="terms.length">
          <div v-for="t in terms" :key="t.key" class="lr-term" :class="`lr-term-${t.kind}`">
            <dt class="lr-term-label">{{ t.label }}</dt>
            <dd class="lr-term-value">{{ termMoney(t) }}</dd>
          </div>
        </dl>

        <!-- Sign-aware prose. Never green for a loss: this portal's green means
             money received, and a shortfall is not an amount the investor owes. -->
        <span
          class="lr-owed-accruing"
          :class="{ 'lr-accruing-loss': noteIsLoss }"
          v-if="noteText"
        >{{ noteText }}</span>

        <!-- Lifetime totals stay visible and are labelled as such, so narrowing
             the card to one month took nothing away. -->
        <span class="lr-lifetime">{{ lifetimeLine }}</span>
      </template>
    </div>

    <div v-if="loading" class="lr-msg">Loading load reports…</div>
    <div v-else-if="error" class="lr-msg">Couldn’t load load reports.</div>
    <div v-else-if="!periods.length" class="lr-msg">No loads found for this {{ period }} view yet.</div>
    <template v-else>
      <div class="lr-cards" v-if="sel">
        <!-- Delivered count, not total: Gross Revenue only sums delivered loads,
             so pairing it with the full count read as "12 loads made $20,623"
             when 3 of them were still rolling. -->
        <div class="lr-card">
          <div class="lr-card-label">Loads</div>
          <div class="lr-card-value">{{ deliveredCount }}</div>
          <div class="lr-card-note" v-if="inTransitCount">{{ inTransitCount }} in transit</div>
        </div>
        <div class="lr-card">
          <div class="lr-card-label">Gross Revenue</div>
          <div class="lr-card-value">{{ fmtMoney(sel.grossRevenue) }}</div>
          <div class="lr-card-note" v-if="inTransitCount">delivered loads only</div>
        </div>
        <!-- P&L, NOT a payable. "Your Share (net)" was a payout phrase on a
             performance figure: at -$2,450 it read as money owed one way or the
             other, which is the confusion the Payouts card was just fixed to
             stop causing. The number is right and stays; the label was the lie.
             Sits third behind Loads and Gross Revenue, so a performance name
             also makes the row read as one consistent set of metrics.

             The colour was the louder half of the bug — `.accent` is green, so
             a loss rendered in the same tone this portal uses for money
             received. Green now requires a positive result. -->
        <div class="lr-card" v-if="monthlyNet != null">
          <div class="lr-card-label">Your Net Result</div>
          <div class="lr-card-value" :class="monthlyNet < 0 ? 'loss' : 'accent'">{{ fmtMoney(monthlyNet) }}</div>
          <div class="lr-card-note">month&rsquo;s performance &mdash; not a payout</div>
        </div>
      </div>

      <p v-if="period === 'weekly'" class="lr-note">
        Net investor share is reconciled monthly — switch to Monthly to see your share.
      </p>

      <div class="lr-table-wrap" v-if="sel">
        <table class="lr-table">
          <thead>
            <tr>
              <!-- "Your Net", matching the tile: this column is that same
                   figure allocated per load, so two names for one quantity
                   would undo the relabel above. Values stay as they are — a
                   per-load net is legitimately informative, and unlike the tile
                   these cells were never coloured as money received. -->
              <th>Load</th><th>Status</th><th>Route</th>
              <th class="num">Rate</th><th class="num">Your Net</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in sel.loads" :key="l.loadId">
              <td class="mono">{{ l.loadId }}</td>
              <td><span class="lr-badge">{{ l.status || '—' }}</span></td>
              <td class="lr-route">{{ l.pickup || '—' }} → {{ l.dropoff || '—' }}</td>
              <td class="num">{{ l.rate ? fmtMoney(l.rate) : '—' }}</td>
              <td class="num">{{ shareOf(l) == null ? '—' : fmtMoney(shareOf(l)) }}</td>
            </tr>
            <tr v-if="!sel.loads.length"><td colspan="5" class="lr-empty">No loads in this period.</td></tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { useInvestorStore } from '../../stores/investor'
import { fmtYmd } from '../../utils/datetime'
import {
  selectPeriodSettlement,
  settlementTerms,
  payoutHeadline,
  isSettleable,
  exportRange,
  exportFileName,
  monthLabel,
  isMonthKey,
} from '../../lib/payoutPeriod'

const props = defineProps({
  production: { type: Object, default: () => ({}) },
  config: { type: Object, default: () => ({}) },
  previewUserId: { default: null },
})

const api = useApi()
const investorStore = useInvestorStore()

const period = ref('monthly')
const periods = ref([])
const selectedIdx = ref(0)
const loading = ref(false)
const error = ref(false)

// Lifetime net earned across every month — the only banner figure that comes
// from /api/investor. Everything else is the payout ledger, so "owed" here means
// exactly what the Payouts section means by it.
const earnedToDate = computed(() => props.production?.investorNetToDate || 0)
const ledgerLoading = computed(() => investorStore.payoutsLoading)
const ledgerFailed = computed(() => investorStore.payoutsFailed)
const owedNow = computed(() => investorStore.payoutTotals.totalOwed || 0)
const processingNow = computed(() => investorStore.payoutTotals.totalProcessing || 0)
const paidToDate = computed(() => investorStore.payoutTotals.totalPaid || 0)
// Manual settlement adjustments and any still-unabsorbed carried loss sit
// BETWEEN earnings and what gets paid, so the card names them explicitly.
// Without them the components silently stop summing to Earned — the exact
// "these numbers don't add up" complaint this card exists to answer:
//   paid + processing + owed + accruing == earned + adjustments + carriedLoss
const adjustments = computed(() => investorStore.payoutTotals.totalAdjustments || 0)
const carriedLoss = computed(() => investorStore.payoutTotals.carriedLossOutstanding || 0)
const accruing = computed(() => investorStore.accruingThisMonth)
const accruingLabel = computed(() => investorStore.currentMonth?.periodLabel || 'This month')

const sel = computed(() => periods.value[selectedIdx.value] || null)

// ---- The month join --------------------------------------------------------
// null in weekly mode (a week start is not a month key) and before a period is
// selected; the card then shows the LIFETIME view. Never a partial or guessed
// month — see lib/payoutPeriod.js for why each of the three bases exists.
const settlement = computed(() => selectPeriodSettlement({
  periodType: period.value,
  periodKey: sel.value?.key,
  payouts: investorStore.payouts,
  currentMonth: investorStore.currentMonth,
}))
const terms = computed(() => settlementTerms(settlement.value))

// ⚠️ While the ledger is in flight `payouts` is empty, so the selector correctly
// reports "no record" — but rendering that heading is asserting a FACT about the
// month during a network round trip, and it flashed "No settlement for this
// month" on every page load. The amount is already dashed; the heading has to be
// equally non-committal, which means naming the card rather than its verdict.
const headline = computed(() => {
  if (ledgerLoading.value) return 'Payment summary'
  return settlement.value ? payoutHeadline(settlement.value) : 'Still owed to you'
})
const scopeLabel = computed(() => (settlement.value ? settlement.value.periodLabel : 'all months'))

// '—', never '$0': a month with no ledger row has no settled figure, and a zero
// there would assert that nothing is owed for it.
const headlineValue = computed(() => {
  const s = settlement.value
  if (!s) return fmtMoney(owedNow.value)
  if (s.basis === 'open') return fmtMoney(s.projectedPayout)
  if (s.payout == null) return '—'
  return fmtMoney(s.payout)
})

// Green is this portal's "money received / receivable" tone. A projection and an
// absent record are neither, so they render neutral.
const cardTone = computed(() => {
  const s = settlement.value
  if (!s) return 'tone-money'
  return s.basis === 'settled' ? 'tone-money' : 'tone-neutral'
})

// The status line — and, for a settled month, the DATE. This is the client's
// literal ask; the Past Months table in PayoutsSection now carries a Paid date
// column for the same reason.
const stateNote = computed(() => {
  const s = settlement.value
  if (!s) return 'Across every settled month. Pick a month above to see it on its own.'
  if (s.basis === 'none') return 'No settlement record for this month.'
  if (s.basis === 'open') {
    return s.graceEndsAt
      ? `In progress — not payable until the month closes, with receipts accepted through ${fmtDate(s.graceEndsAt)}.`
      : 'In progress — not payable until the month closes.'
  }
  if (s.status === 'paid') {
    return s.paidAt ? `Paid on ${fmtDate(s.paidAt)}.` : 'Paid.'
  }
  // ⚠️ A $0 month keeps `status: 'owed'`, so without this it printed "Awaiting
  // payment — due Jun 26" over a $0 figure. Nothing is awaited; the shortfall
  // deferred. Matches PayoutsSection, which suppresses the due date and the
  // settle buttons on exactly these rows (`settleable()`).
  if (!isSettleable(s)) {
    return s.lossDeferred
      ? 'Nothing due — this month’s shortfall carried into a later payout.'
      : 'Nothing due for this month.'
  }
  if (s.phase === 'pending') {
    return `In final settlement — the books close ${fmtDate(s.graceEndsAt)}, so this figure can still move.`
  }
  const due = s.dueDate ? ` — due ${fmtDate(s.dueDate)}` : ''
  return s.status === 'processing' ? `Payment in progress${due}.` : `Awaiting payment${due}.`
})

// Extra prose, only where a figure would otherwise be inexplicable.
const noteText = computed(() => {
  const s = settlement.value
  if (!s) {
    // Lifetime view: the open month is a real term of the lifetime sum, so name
    // it and its month rather than letting it vanish.
    const v = accruing.value
    if (!v) return ''
    return v > 0
      ? `${accruingLabel.value} accruing: ${fmtMoney(v)} — not payable until the month closes`
      : `${accruingLabel.value} so far: ${fmtMoney(v)} — the month is running at a loss, not an amount you owe`
  }
  if (s.basis === 'open' && s.earned < 0) {
    return 'The month is running at a loss — a shortfall carries into a later payout, it is not an amount you owe.'
  }
  if (s.basis === 'settled' && s.drift) {
    return 'Your payout is the amount this month was settled at. The earnings line reflects current records, which have changed since it closed.'
  }
  return ''
})
const noteIsLoss = computed(() => {
  const s = settlement.value
  if (!s) return accruing.value < 0
  return s.basis === 'open' && s.earned < 0
})

// One line, always present, always labelled "All months" — so a per-month card
// never reads as if it were the whole relationship.
const lifetimeLine = computed(() => {
  const bits = [`Earned ${fmtMoney(earnedToDate.value)}`]
  if (adjustments.value) bits.push(`Adjustments ${signedMoney(adjustments.value)}`)
  bits.push(`Paid out ${fmtMoney(paidToDate.value)}`)
  if (processingNow.value) bits.push(`Processing ${fmtMoney(processingNow.value)}`)
  bits.push(`Still owed ${fmtMoney(owedNow.value)}`)
  if (carriedLoss.value) bits.push(`${fmtMoney(carriedLoss.value)} loss carried forward`)
  return `All months — ${bits.join(' · ')}`
})

// Gross Revenue counts delivered loads only, so the Loads tile must too.
// completedCount/inTransitCount are newer server fields — fall back to deriving
// them from the load rows so a stale cached payload still renders sensibly.
const deliveredCount = computed(() => {
  const s = sel.value
  if (!s) return 0
  return s.completedCount ?? s.loads.filter((l) => l.completed).length
})
const inTransitCount = computed(() => {
  const s = sel.value
  if (!s) return 0
  return s.inTransitCount ?? s.loads.filter((l) => !l.completed).length
})
// Authoritative monthly net share, reused from the dashboard's monthlyEarnings
// so this section reconciles with EarningsSection / the rest of the portal.
const monthlyNet = computed(() => {
  if (period.value !== 'monthly' || !sel.value) return null
  const m = (props.production?.monthlyEarnings || []).find((x) => x.month === sel.value.key)
  return m ? (m.investorEarnings || 0) : null
})

// The server labels a monthly period with its bare key ("2026-08"). The card
// beside it now says "August 2026", so the picker says the same thing.
function optionLabel(p) {
  if (!p) return ''
  return isMonthKey(p.key) ? monthLabel(p.key) : (p.label || p.key)
}

// Allocate the month's authoritative net investor earnings (monthlyNet) across
// its completed loads, rate-weighted, as whole dollars that sum EXACTLY to
// monthlyNet (largest-remainder) so the rows reconcile with the "Your Net
// Result" card above. {} when there's no monthly net (e.g. the weekly view) —
// never a gross-based estimate. Mirrors allocateNet() in server.js — keep in sync.
function allocateNet(loads, net) {
  const out = {}
  if (net == null) return out
  const done = (loads || []).filter((l) => l.completed && (l.rate || 0) > 0)
  const denom = done.reduce((s, l) => s + l.rate, 0)
  if (denom <= 0) return out
  const target = Math.round(net)
  let allocated = 0
  const rema = []
  for (const l of done) {
    const exact = (target * l.rate) / denom
    const base = Math.floor(exact)
    out[l.loadId] = base
    allocated += base
    rema.push({ id: l.loadId, f: exact - base })
  }
  let leftover = target - allocated
  rema.sort((a, b) => b.f - a.f)
  for (let i = 0; i < rema.length && leftover > 0; i++, leftover--) out[rema[i].id] += 1
  return out
}
const shareMap = computed(() => allocateNet(sel.value?.loads, monthlyNet.value))
function shareOf(l) {
  if (!l) return null
  return Object.prototype.hasOwnProperty.call(shareMap.value, l.loadId) ? shareMap.value[l.loadId] : null
}

// Authoritative net per month from the dashboard, handed to the export so the
// PDF/CSV reconcile with the portal. Server matches by YYYY-MM; weekly ignores it.
function netParam() {
  return (props.production?.monthlyEarnings || [])
    .filter((m) => m && m.month)
    .map((m) => `${m.month}:${Math.round(m.investorEarnings || 0)}`)
    .join(',')
}

function previewParams(extra) {
  const params = new URLSearchParams(extra || {})
  if (props.previewUserId != null) params.set('as_user_id', String(props.previewUserId))
  return params
}

async function fetchReport() {
  loading.value = true
  error.value = false
  try {
    const qs = previewParams({ period: period.value }).toString()
    const r = await api.get(`/api/investor/load-report?${qs}`)
    periods.value = Array.isArray(r.periods) ? r.periods : []
    selectedIdx.value = 0
  } catch {
    error.value = true
    periods.value = []
  } finally {
    loading.value = false
  }
}

function setPeriod(p) {
  if (p !== period.value) {
    period.value = p
    fetchReport()
  }
}
watch(() => props.previewUserId, fetchReport)

function exportTitle(kind) {
  const s = sel.value
  const scope = s ? (isMonthKey(s.key) ? monthLabel(s.key) : s.label || s.key) : 'the selected period'
  return `Export ${scope} as ${kind}`
}

function exportReport(format) {
  // Direct same-origin download. The endpoint responds with
  // Content-Disposition: attachment and we set an explicit download filename, so
  // the browser saves it by that name. No fetch/blob is involved, so there's no
  // object-URL that could be saved as a name-less UUID (the earlier bug).
  const extra = { period: period.value, format }
  const net = netParam()
  if (net) extra.net = net
  // Scope the export to the SELECTED period. Both buttons sit in the picker row
  // and exported all 12 periods regardless of it. No server change is needed —
  // ?start=/?end= are already parsed there and applied per row.
  const range = exportRange(period.value, sel.value)
  if (range) {
    extra.start = range.start
    extra.end = range.end
  }
  const qs = previewParams(extra).toString()
  const a = document.createElement('a')
  a.href = `/api/investor/load-report?${qs}`
  a.download = exportFileName(period.value, sel.value, format)
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function fmtMoney(n) {
  const v = Math.round(Number(n) || 0)
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString()
}

// Adjustments cut both ways, so always carry an explicit sign — "-$500" reads
// as a deduction, "+$250" as a credit, neither as an ambiguous balance.
function signedMoney(n) {
  const v = Math.round(Number(n) || 0)
  return (v < 0 ? '−$' : '+$') + Math.abs(v).toLocaleString()
}

// A term row: the running components carry an explicit sign so the column can be
// added up by eye; the opening earnings figure and the closing totals are plain
// amounts, because a leading "+" on them reads as a credit rather than a balance.
//
// One minus sign for the whole column. fmtMoney uses ASCII '-' and signedMoney
// the typographic '−', which is invisible anywhere else in the app but sat one
// line apart here ("-$2,450" above "+$2,450") and read as two different kinds of
// negative. fmtMoney itself is left alone — it also renders the tiles, the load
// table and the headline, and changing it there is not this change's business.
function termMoney(t) {
  if (!t) return ''
  if (t.kind === 'carry' || t.kind === 'drift' || t.kind === 'adjust') return signedMoney(t.value)
  return fmtMoney(t.value).replace(/^-\$/, '−$')
}

// dueDate / graceEndsAt are bare 'YYYY-MM-DD'; paidAt is a real ISO instant.
// fmtYmd branches on the shape, so a bare date is printed verbatim (never through
// new Date(), which renders the previous day in US timezones) while a timestamp
// is rendered in Houston.
function fmtDate(d) {
  return fmtYmd(d)
}

fetchReport()
</script>

<style scoped>
.lr-section {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 1.1rem 1.25rem;
  margin-bottom: 1rem;
}
.lr-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
.lr-headings { min-width: 0; }
.lr-title { font-size: 1.05rem; font-weight: 700; color: #0f172a; margin: 0; }
.lr-subtitle { font-size: 0.74rem; color: #94a3b8; margin: 0.15rem 0 0; }
.lr-toggle { display: inline-flex; background: #f1f5f9; border-radius: 999px; padding: 3px; }
.lr-tab { border: none; background: transparent; padding: 5px 14px; border-radius: 999px; font-size: 0.82rem; font-weight: 600; color: #64748b; cursor: pointer; }
.lr-tab.active { background: #fff; color: #0f172a; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }

.lr-owed { display: flex; flex-direction: column; gap: 0.15rem; margin: 0.5rem 0 0.6rem; padding: 0.7rem 0.9rem; border-radius: 10px; background: #f0fdf4; border: 1px solid #bbf7d0; }
/* Green is reserved for money received or receivable. A projection of an open
   month and a month with no ledger row are neither, so they render neutral —
   the same rule the Net Result tile follows. */
.lr-owed.tone-neutral { background: #f8fafc; border-color: #e2e8f0; }
.lr-owed.tone-neutral .lr-owed-label { color: #334155; }
.lr-owed.tone-neutral .lr-owed-value { color: #0f172a; }
.lr-owed.tone-neutral .lr-owed-context,
.lr-owed.tone-neutral .lr-owed-accruing,
.lr-owed.tone-neutral .lr-lifetime { color: #64748b; }
.lr-owed.tone-neutral .lr-term-label { color: #475569; }
.lr-owed-row { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
.lr-owed-label { font-size: 0.82rem; font-weight: 600; color: #166534; }
/* The period the figure belongs to, beside the label rather than buried in the
   prose — it is the answer to "which month am I looking at?". */
.lr-owed-scope { font-weight: 700; color: inherit; opacity: 0.75; }
.lr-owed-scope::before { content: '· '; opacity: 0.6; }
.lr-owed-value { font-size: 1.35rem; font-weight: 800; color: #15803d; }
.lr-owed-context { font-size: 0.74rem; font-weight: 500; color: #4d7c5a; }
.lr-owed-accruing { font-size: 0.74rem; font-weight: 500; color: #4d7c5a; font-style: italic; }
/* Same rule as the Net Result tile: the green is reserved for money received. */
.lr-owed-accruing.lr-accruing-loss { color: #b91c1c; }
.lr-lifetime { font-size: 0.72rem; font-weight: 500; color: #4d7c5a; margin-top: 0.3rem; }

/* The terms of the sum. Rendered as a list so the figures line up in a column
   and can be added by eye — the whole point of showing them. */
.lr-terms { margin: 0.45rem 0 0.1rem; max-width: 420px; }
.lr-term { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; padding: 0.15rem 0; }
.lr-term-label { font-size: 0.76rem; color: #3f6b4d; }
.lr-term-value { font-size: 0.78rem; font-weight: 600; color: #0f172a; font-family: 'JetBrains Mono', ui-monospace, monospace; }
.lr-term-carry .lr-term-value, .lr-term-adjust .lr-term-value { color: #b45309; }
.lr-term-drift .lr-term-value { color: #64748b; }
.lr-term-drift .lr-term-label { color: #64748b; font-style: italic; }
.lr-term-subtotal, .lr-term-total { border-top: 1px solid rgba(15, 23, 42, 0.1); margin-top: 0.15rem; padding-top: 0.3rem; }
.lr-term-total .lr-term-label { font-weight: 700; color: #0f172a; }
.lr-term-total .lr-term-value { font-weight: 800; }

.lr-msg { color: #64748b; font-size: 0.88rem; padding: 0.8rem 0; }

.lr-nav { display: flex; align-items: center; gap: 0.5rem; margin: 0.8rem 0 0.2rem; flex-wrap: wrap; }
.lr-navbtn { border: 1px solid #e2e8f0; background: #fff; border-radius: 8px; padding: 5px 10px; font-size: 0.8rem; cursor: pointer; color: #334155; }
.lr-navbtn:disabled { opacity: 0.4; cursor: not-allowed; }
.lr-select { border: 1px solid #e2e8f0; border-radius: 8px; padding: 5px 8px; font-size: 0.82rem; color: #0f172a; background: #fff; }
.lr-export { margin-left: auto; display: flex; gap: 0.4rem; }
.lr-exp { border: 1px solid #cbd5e1; background: #f8fafc; border-radius: 8px; padding: 5px 12px; font-size: 0.8rem; font-weight: 600; color: #334155; cursor: pointer; }
.lr-exp:hover { background: #f1f5f9; }

.lr-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.6rem; margin: 0.5rem 0; }
.lr-card { background: #f8fafc; border: 1px solid #eef2f7; border-radius: 10px; padding: 0.6rem 0.8rem; }
.lr-card-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; color: #94a3b8; }
.lr-card-value { font-size: 1.2rem; font-weight: 700; color: #0f172a; margin-top: 2px; }
.lr-card-value.accent { color: #15803d; }
/* A losing month must not render in the green this portal uses for money
   received. Red is the P&L convention for a loss and is the fastest signal that
   this tile reports performance, not a payable. #b91c1c is the negative already
   used elsewhere (PayoutsSection .hist-down / .amt-negative). */
.lr-card-value.loss { color: #b91c1c; }
.lr-card-note { font-size: 0.68rem; font-weight: 500; color: #94a3b8; margin-top: 1px; }
.lr-note { font-size: 0.74rem; color: #94a3b8; margin: 0.1rem 0 0.5rem; }

.lr-table-wrap { overflow-x: auto; margin-top: 0.4rem; }
.lr-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
.lr-table th { text-align: left; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.02em; color: #94a3b8; padding: 0.4rem 0.5rem; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
.lr-table td { padding: 0.45rem 0.5rem; border-bottom: 1px solid #f1f5f9; color: #334155; vertical-align: top; }
.lr-table .num { text-align: right; white-space: nowrap; }
.lr-table .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.78rem; }
.lr-route { color: #475569; }
.lr-badge { display: inline-block; padding: 1px 7px; border-radius: 999px; background: #eef2ff; color: #4338ca; font-size: 0.7rem; font-weight: 600; }
.lr-empty { text-align: center; color: #94a3b8; padding: 0.8rem; }
</style>
