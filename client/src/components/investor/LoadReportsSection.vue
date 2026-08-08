<!--
  LoadReportsSection — weekly & monthly load reports + totals owed for the
  investor portal. Fetches GET /api/investor/load-report (per-period load lists +
  gross revenue). Broker identity is never shown. "Your Net Result" is the authoritative
  NET investor earnings from the dashboard's monthlyEarnings (passed in via
  :production): the monthly total, and per completed load its rate-weighted slice
  of that month's net — so every figure reconciles with EarningsSection / the rest
  of the portal. Weekly has no monthly-net mapping, so it shows loads + gross only.
  Exports pass the same net back as ?net=YYYY-MM:amount so the PDF/CSV reconcile too.

  EVERY FIGURE IN THIS SECTION IS P&L, NOT A PAYABLE, except the banner's "Still
  owed to you". The Net Result tile was named "Your Share (net)" and printed in
  green: on a month running at -$2,450 that read as money owed, which is
  indistinguishable from the complaint the payout carry-forward work exists to
  answer. The rule this section now follows, and which any figure added here must
  follow: an investor should be able to tell WITHOUT knowing our vocabulary which
  numbers are money they will receive and which are how the business performed.
  Money received lives in PayoutsSection and in "Still owed to you"; everything
  else here is performance, is named as such, and never borrows the green.

  The banner reads the PAYOUT LEDGER (investorStore's payouts slice, from GET
  /api/investor/payouts) — the exact same source the Payouts section renders, so
  the two can never disagree. It previously derived its own "still owed" as
  netToDate − paidToDate, which swept the STILL-OPEN current month into "owed"
  and told the investor "$6,389 still owed" while the Payouts section directly
  below read "Total Owed $0 · July in progress". Owed means *payable now*: only
  closed months that haven't been settled. The open month is shown on its own
  line as accruing. Every non-zero component is rendered so the four always sum
  back to Earned — otherwise a reader subtracts Earned − Paid and lands right
  back on the wrong number. Honors Super-Admin "view as investor" through the
  :preview-user-id prop (threaded as ?as_user_id=).
-->
<template>
  <div class="lr-section">
    <div class="lr-head">
      <h2 class="lr-title">Load Reports</h2>
      <div class="lr-toggle">
        <button :class="['lr-tab', { active: period === 'monthly' }]" @click="setPeriod('monthly')">Monthly</button>
        <button :class="['lr-tab', { active: period === 'weekly' }]" @click="setPeriod('weekly')">Weekly</button>
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
    <div class="lr-owed" v-else>
      <div class="lr-owed-row">
        <span class="lr-owed-label">Still owed to you</span>
        <span class="lr-owed-value">{{ ledgerLoading ? '—' : fmtMoney(owedNow) }}</span>
      </div>
      <template v-if="!ledgerLoading">
        <span class="lr-owed-context">Earned {{ fmtMoney(earnedToDate) }}<template v-if="adjustments"> · Adjustments {{ signedMoney(adjustments) }}</template> · Paid out {{ fmtMoney(paidToDate) }}<template v-if="processingNow"> · Processing {{ fmtMoney(processingNow) }}</template><template v-if="carriedLoss"> · {{ fmtMoney(carriedLoss) }} loss carried forward</template></span>
        <!-- The NUMBER here is deliberately the signed accrual and must stay
             that way — it is a term in the identity this banner exists to
             demonstrate (see the header comment). Only the wording and colour
             are sign-aware.

             "not payable UNTIL the month closes" is true of a positive accrual
             and quietly false of a negative one: it promises a payment that
             will never arrive, since a loss defers instead of becoming
             payable. And #4d7c5a is a green, so a loss was printed in the tone
             used for money received. -->
        <span
          class="lr-owed-accruing"
          :class="{ 'lr-accruing-loss': accruing < 0 }"
          v-if="accruing"
        >{{ accruingNote }}</span>
      </template>
    </div>

    <div v-if="loading" class="lr-msg">Loading load reports…</div>
    <div v-else-if="error" class="lr-msg">Couldn’t load load reports.</div>
    <div v-else-if="!periods.length" class="lr-msg">No loads found for this {{ period }} view yet.</div>
    <template v-else>
      <div class="lr-nav">
        <button class="lr-navbtn" :disabled="selectedIdx >= periods.length - 1" @click="selectedIdx++">‹ Older</button>
        <select v-model.number="selectedIdx" class="lr-select">
          <option v-for="(p, i) in periods" :key="p.key" :value="i">{{ p.label }}</option>
        </select>
        <button class="lr-navbtn" :disabled="selectedIdx <= 0" @click="selectedIdx--">Newer ›</button>
        <div class="lr-export">
          <button class="lr-exp" @click="exportReport('csv')">Export CSV</button>
          <button class="lr-exp" @click="exportReport('pdf')">Export PDF</button>
        </div>
      </div>

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
// BETWEEN earnings and what gets paid, so the banner names them explicitly.
// Without them the components silently stop summing to Earned — the exact
// "these numbers don't add up" complaint this banner exists to answer:
//   paid + processing + owed + accruing == earned + adjustments + carriedLoss
const adjustments = computed(() => investorStore.payoutTotals.totalAdjustments || 0)
const carriedLoss = computed(() => investorStore.payoutTotals.carriedLossOutstanding || 0)
const accruing = computed(() => investorStore.accruingThisMonth)
const accruingLabel = computed(() => investorStore.currentMonth?.periodLabel || 'This month')
// Wording only — `accruing` itself stays signed so the four components still
// sum back to Earned. A positive accrual genuinely becomes payable at close, so
// that sentence is unchanged. A negative one never does: it defers into a
// future month's payout, so "not payable until the month closes" would promise
// a payment that isn't coming, and "accruing" reads as something accruing TO
// the investor rather than a shortfall. Says "not an amount you owe" out loud
// because that is the specific misreading a leading minus sign invites — the
// one that started this whole thread.
const accruingNote = computed(() => {
  const v = accruing.value
  if (!v) return ''
  return v > 0
    ? `${accruingLabel.value} accruing: ${fmtMoney(v)} — not payable until the month closes`
    : `${accruingLabel.value} so far: ${fmtMoney(v)} — the month is running at a loss, not an amount you owe`
})
const sel = computed(() => periods.value[selectedIdx.value] || null)
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

function exportReport(format) {
  // Direct same-origin download. The endpoint responds with
  // Content-Disposition: attachment and we set an explicit download filename, so
  // the browser saves it by that name. No fetch/blob is involved, so there's no
  // object-URL that could be saved as a name-less UUID (the earlier bug).
  const extra = { period: period.value, format }
  const net = netParam()
  if (net) extra.net = net
  const qs = previewParams(extra).toString()
  const a = document.createElement('a')
  a.href = `/api/investor/load-report?${qs}`
  a.download = `load-report-${period.value}.${format}`
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
.lr-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
.lr-title { font-size: 1.05rem; font-weight: 700; color: #0f172a; margin: 0; }
.lr-toggle { display: inline-flex; background: #f1f5f9; border-radius: 999px; padding: 3px; }
.lr-tab { border: none; background: transparent; padding: 5px 14px; border-radius: 999px; font-size: 0.82rem; font-weight: 600; color: #64748b; cursor: pointer; }
.lr-tab.active { background: #fff; color: #0f172a; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }

.lr-owed { display: flex; flex-direction: column; gap: 0.15rem; margin: 0.9rem 0 0.4rem; padding: 0.7rem 0.9rem; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; }
.lr-owed-row { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
.lr-owed-label { font-size: 0.82rem; font-weight: 600; color: #166534; }
.lr-sub { font-weight: 400; color: #4d7c5a; }
.lr-owed-value { font-size: 1.35rem; font-weight: 800; color: #15803d; }
.lr-owed-context { font-size: 0.74rem; font-weight: 500; color: #4d7c5a; }
.lr-owed-accruing { font-size: 0.74rem; font-weight: 500; color: #4d7c5a; font-style: italic; }
/* Same rule as the Net Result tile: the green is reserved for money received. */
.lr-owed-accruing.lr-accruing-loss { color: #b91c1c; }

.lr-msg { color: #64748b; font-size: 0.88rem; padding: 0.8rem 0; }

.lr-nav { display: flex; align-items: center; gap: 0.5rem; margin: 0.7rem 0; flex-wrap: wrap; }
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
