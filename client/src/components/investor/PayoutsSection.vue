<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#128176;</div>
      Payouts
      <span class="section-sub">monthly investor settlements</span>
    </div>

    <div v-if="loading" class="skeleton skeleton-card"></div>

    <template v-else-if="loadFailed">
      <div v-if="notFound" class="empty-msg">Payout settlements aren't available yet.</div>
      <div v-else class="empty-msg">Couldn't load payouts &mdash; try again.</div>
    </template>

    <template v-else>
      <!-- Current month (in progress, not yet payable) -->
      <div v-if="currentMonth" class="current-card">
        <div class="current-main">
          <span class="current-label">{{ currentMonth.periodLabel }}</span>
          <span class="current-amount mono">{{ fmt(currentMonth.amountInProgress) }}</span>
        </div>
        <div class="current-meta">
          <span class="status-pill st-progress">in progress</span>
          <span class="current-note">Accruing this month &mdash; not yet payable until the period closes.</span>
        </div>

        <!-- Same earnings waterfall as the past-months rows, so the in-progress
             figure is explained too: expenses come out before the split. -->
        <div v-if="currentMonth.breakdown" class="current-breakdown">
          <button
            type="button"
            class="bd-toggle"
            :aria-expanded="currentOpen"
            aria-controls="breakdown-current"
            @click="currentOpen = !currentOpen"
          >
            <svg class="chevron" :class="{ open: currentOpen }" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {{ currentOpen ? 'Hide breakdown' : 'Show breakdown' }}
          </button>
          <div v-if="currentOpen" id="breakdown-current" class="breakdown-panel" role="group" aria-label="Earnings breakdown">
            <div class="bd-caption">How this month&rsquo;s share is calculated</div>
            <dl class="bd-list">
              <div
                v-for="(row, i) in waterfall(currentMonth.breakdown)"
                :key="i"
                class="bd-row"
                :class="[`bd-${row.kind}`, { 'bd-highlight': row.highlight, 'bd-clickable': !!row.detailKey }]"
                :role="row.detailKey ? 'button' : undefined"
                :tabindex="row.detailKey ? 0 : undefined"
                :aria-label="row.detailKey ? `View ${LINE_LABEL[row.detailKey]} details for ${currentMonth.periodLabel}` : undefined"
                @click="row.detailKey && openLineDetail(currentMonth.period, row.detailKey, currentMonth.periodLabel)"
                @keydown.enter.prevent="row.detailKey && openLineDetail(currentMonth.period, row.detailKey, currentMonth.periodLabel)"
                @keydown.space.prevent="row.detailKey && openLineDetail(currentMonth.period, row.detailKey, currentMonth.periodLabel)"
              >
                <dt class="bd-label">
                  {{ row.label }}
                  <span v-if="row.highlight" class="bd-tag">your expenses</span>
                  <template v-if="row.detailKey">
                    <svg class="bd-chev" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
                    <span class="bd-view">view details</span>
                  </template>
                </dt>
                <dd class="bd-value mono-sm">{{ row.display }}</dd>
              </div>
            </dl>
            <p class="bd-help">Your expenses are already subtracted here before the split.</p>
          </div>
        </div>
      </div>

      <!-- Totals summary -->
      <div class="totals-grid">
        <div class="total-card">
          <span class="total-label">Total Owed</span>
          <span class="total-value mono amber">{{ fmt(totals.totalOwed) }}</span>
        </div>
        <div class="total-card">
          <span class="total-label">Total Processing</span>
          <span class="total-value mono blue">{{ fmt(totals.totalProcessing) }}</span>
        </div>
        <div class="total-card">
          <span class="total-label">Total Paid</span>
          <span class="total-value mono green">{{ fmt(totals.totalPaid) }}</span>
        </div>
      </div>

      <!-- The three totals above are net of manual adjustments and of any loss
           still carried. Name them here too, so this card and the Load Reports
           banner explain the same difference rather than one of them alone. -->
      <div v-if="totals.totalAdjustments || totals.carriedLossOutstanding" class="totals-note">
        <span v-if="totals.totalAdjustments">
          Includes manual adjustments of
          <strong>{{ totals.totalAdjustments < 0 ? '−' : '+' }}{{ fmt(Math.abs(totals.totalAdjustments)) }}</strong>
        </span>
        <span v-if="totals.carriedLossOutstanding">
          {{ fmt(totals.carriedLossOutstanding) }} of earlier losses is still carried against future months
        </span>
      </div>

      <!-- Past months -->
      <div class="table-label">Past Months</div>
      <div v-if="visiblePayouts.length === 0" class="empty-msg">No past payouts yet.</div>
      <!-- Amount / Adjustment / Adjusted total are broken out as their own
           columns rather than collapsed into one figure with a badge, so a
           corrected month shows its full arithmetic on the statement. -->
      <div v-else class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Period</th>
            <th class="num">Amount</th>
            <th class="num">Adjustment</th>
            <th class="num">Adjusted total</th>
            <th>Due date</th>
            <th>Status</th>
            <th v-if="isSuperAdmin"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="p in visiblePayouts" :key="p.id">
          <tr>
            <td>
              <!-- Expand control lives in the Period cell so no column is added.
                   Only rows that carry a breakdown get it; otherwise plain label. -->
              <button
                v-if="p.breakdown"
                type="button"
                class="expand-btn"
                :aria-expanded="expandedId === p.id"
                :aria-controls="`breakdown-${p.id}`"
                :title="expandedId === p.id ? 'Hide earnings breakdown' : 'Show earnings breakdown'"
                @click="toggle(p.id)"
              >
                <svg class="chevron" :class="{ open: expandedId === p.id }" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span>{{ p.periodLabel }}</span>
              </button>
              <span v-else>{{ p.periodLabel }}</span>
            </td>
            <td class="mono-sm num">
              <div>{{ fmt(p.amount) }}</div>
              <!-- Explain a month that pays out less than it earned, so a reduced
                   figure never looks like money went missing. -->
              <div v-if="p.lossDeferred" class="inv-carry">
                {{ fmt(p.lossDeferred) }} loss carried to later months
              </div>
              <div v-else-if="p.lossCarriedIn" class="inv-carry">
                earned {{ fmt(p.monthEarnings) }} · {{ fmt(p.lossCarriedIn) }} applied to an earlier loss
              </div>
            </td>
            <!-- Show the delta that ACTUALLY landed, so Amount + Adjustment always
                 equals Adjusted total on the row. They differ only for a legacy
                 over-deduction the server clamps at $0. -->
            <td class="mono-sm num">
              <template v-if="applied(p)">
                <div class="inv-adj-amt">{{ applied(p) > 0 ? '+' : '−' }}{{ fmt(Math.abs(applied(p))) }}</div>
                <div v-if="p.adjustmentNote" class="inv-adj-note">{{ p.adjustmentNote }}</div>
              </template>
              <span v-else class="dim">&mdash;</span>
            </td>
            <!-- A negative adjusted total shouldn't read as a normal figure. The
                 adjust API accepts any period (server.js: no status guard), so a
                 large enough deduction can still invert a row even though loss
                 months no longer can. Flag it rather than let it blend in. -->
            <td class="mono-sm num">
              <strong :class="{ 'amt-negative': effective(p) < 0 }">{{ fmt(effective(p)) }}</strong>
            </td>
            <td class="mono-sm">{{ settleable(p) ? fmtDate(p.dueDate) : '—' }}</td>
            <td>
              <span v-if="settleable(p)" :class="['status-pill', statusClass(p.status)]">{{ p.status }}</span>
              <span v-else class="status-pill st-none">nothing due</span>
            </td>
            <td v-if="isSuperAdmin" class="action-cell">
              <!-- Only rows with a positive payable can be settled; the server
                   rejects the rest (409) and the buttons would be dead ends. -->
              <template v-if="settleable(p)">
                <button
                  v-if="p.status === 'owed'"
                  type="button"
                  class="action-btn act-processing"
                  :disabled="busyId === p.id"
                  title="Move this payout from owed to processing"
                  @click="advance(p, 'processing')"
                >Mark Processing</button>
                <button
                  v-if="p.status !== 'paid'"
                  type="button"
                  class="action-btn act-paid"
                  :disabled="busyId === p.id"
                  title="Mark this payout as paid"
                  @click="advance(p, 'paid')"
                >Mark Paid</button>
              </template>
              <span v-if="p.status === 'paid' || !settleable(p)" class="dim">&mdash;</span>
            </td>
          </tr>
          <!-- Expandable earnings waterfall — proves trip expenses (and every other
               cost) are subtracted before the split. Rendered only for the open row
               that actually carries a breakdown; spans the full table width. -->
          <tr v-if="p.breakdown && expandedId === p.id" class="breakdown-tr">
            <td :colspan="colCount" class="breakdown-cell">
              <div :id="`breakdown-${p.id}`" class="breakdown-panel" role="group" aria-label="Earnings breakdown">
                <div class="bd-caption">How your share is calculated</div>
                <dl class="bd-list">
                  <div
                    v-for="(row, i) in waterfall(p.breakdown)"
                    :key="i"
                    class="bd-row"
                    :class="[`bd-${row.kind}`, { 'bd-highlight': row.highlight, 'bd-clickable': !!row.detailKey }]"
                    :role="row.detailKey ? 'button' : undefined"
                    :tabindex="row.detailKey ? 0 : undefined"
                    :aria-label="row.detailKey ? `View ${LINE_LABEL[row.detailKey]} details for ${p.periodLabel}` : undefined"
                    @click="row.detailKey && openLineDetail(p.period, row.detailKey, p.periodLabel)"
                    @keydown.enter.prevent="row.detailKey && openLineDetail(p.period, row.detailKey, p.periodLabel)"
                    @keydown.space.prevent="row.detailKey && openLineDetail(p.period, row.detailKey, p.periodLabel)"
                  >
                    <dt class="bd-label">
                      {{ row.label }}
                      <span v-if="row.highlight" class="bd-tag">your expenses</span>
                      <template v-if="row.detailKey">
                        <svg class="bd-chev" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
                        <span class="bd-view">view details</span>
                      </template>
                    </dt>
                    <dd class="bd-value mono-sm">{{ row.display }}</dd>
                  </div>
                </dl>
                <p class="bd-help">Your expenses are already subtracted here before the split.</p>
              </div>
            </td>
          </tr>
          </template>
        </tbody>
      </table>
      </div>
    </template>

    <!-- Line-item drill-down for a clicked waterfall figure (Revenue / Driver Pay
         / Fixed Costs / Trip Expenses). Lazy-fetched + cached per period; the
         footer echoes the headline total so the itemized sum is reconciled. -->
    <MetricInfoDialog
      :open="lineModalOpen"
      :title="lineModalTitle"
      :subtitle="lineModalSubtitle"
      @update:open="(v) => { if (!v) lineModalOpen = false }"
    >
      <div v-if="lineLoading" class="ld-state">Loading details&hellip;</div>
      <div v-else-if="lineError" class="ld-state ld-error">{{ lineError }}</div>
      <template v-else-if="lineDetail">
        <!-- Revenue → completed loads -->
        <template v-if="lineDetailKey === 'revenue'">
          <div v-if="!lineDetail.revenueLoads || !lineDetail.revenueLoads.length" class="ld-empty">
            No loads recorded for this month.
          </div>
          <div v-else class="ld-scroll">
            <table class="ld-table">
              <thead>
                <tr><th>Load #</th><th>Date</th><th>Driver / Truck</th><th>Route</th><th class="num">Amount</th></tr>
              </thead>
              <tbody>
                <tr v-for="(l, i) in lineDetail.revenueLoads" :key="i">
                  <td class="mono-xs">{{ l.loadId || '—' }}</td>
                  <td class="mono-xs">{{ fmtShortDate(l.date) }}</td>
                  <td>
                    <div>{{ l.driver || '—' }}</div>
                    <div v-if="l.truck" class="ld-sub">#{{ l.truck }}</div>
                  </td>
                  <td class="ld-route">{{ routeText(l) }}</td>
                  <td class="mono-xs num">{{ fmt(l.amount) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="ld-total"><span>Total Revenue</span><span class="mono num">{{ fmt(lineDetail.revenue) }}</span></div>
        </template>

        <!-- Driver Pay → per-driver rows -->
        <template v-else-if="lineDetailKey === 'driverPay'">
          <div v-if="!lineDetail.driverPayRows || !lineDetail.driverPayRows.length" class="ld-empty">
            No driver activity recorded for this month.
          </div>
          <div v-else class="ld-scroll">
            <table class="ld-table">
              <thead>
                <tr><th>Driver</th><th>Basis</th><th class="num">Pay</th></tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in lineDetail.driverPayRows" :key="i">
                  <td>{{ r.driver || '—' }}</td>
                  <td class="ld-basis">
                    <template v-if="r.payType === 'percentage'">{{ r.payPercentage }}% of revenue</template>
                    <template v-else>{{ r.activeDays }} day{{ Number(r.activeDays) === 1 ? '' : 's' }} × {{ fmt(r.dailyRate) }}/day</template>
                  </td>
                  <td class="mono-xs num">{{ fmt(r.pay) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="ld-total"><span>Total Driver Pay</span><span class="mono num">{{ fmt(lineDetail.driverPay) }}</span></div>
        </template>

        <!-- Fixed Costs → per-truck breakdown -->
        <template v-else-if="lineDetailKey === 'fixedCosts'">
          <div v-if="!lineDetail.fixedCostItems || !lineDetail.fixedCostItems.length" class="ld-empty">
            No fixed costs charged for this month.
          </div>
          <div v-else class="ld-scroll">
            <div v-for="(t, i) in lineDetail.fixedCostItems" :key="i" class="ld-truck">
              <div class="ld-truck-head">
                <span>Truck {{ t.truck ? '#' + t.truck : '—' }}</span>
                <span class="mono">{{ fmt(t.total) }}</span>
              </div>
              <div class="ld-kv"><span>Insurance</span><span class="mono">{{ fmt(t.insurance) }}</span></div>
              <div class="ld-kv"><span>ELD</span><span class="mono">{{ fmt(t.eld) }}</span></div>
              <div class="ld-kv"><span>Truck Payment</span><span class="mono">{{ fmt(t.truckPayment) }}</span></div>
              <div class="ld-kv"><span>IRP Registration</span><span class="mono">{{ fmt(t.irp) }}</span></div>
              <div class="ld-kv"><span>HVUT Road Tax</span><span class="mono">{{ fmt(t.hvut) }}</span></div>
            </div>
          </div>
          <div class="ld-total"><span>Total Fixed Costs</span><span class="mono num">{{ fmt(lineDetail.fixedCosts) }}</span></div>
        </template>

        <!-- Trip Expenses → expense rows -->
        <template v-else-if="lineDetailKey === 'tripExpenses'">
          <div v-if="!lineDetail.tripExpenseItems || !lineDetail.tripExpenseItems.length" class="ld-empty">
            No trip expenses recorded for this month.
          </div>
          <div v-else class="ld-scroll">
            <table class="ld-table">
              <thead>
                <tr><th>Date</th><th>Type</th><th>Description</th><th class="num">Amount</th></tr>
              </thead>
              <tbody>
                <tr v-for="(e, i) in lineDetail.tripExpenseItems" :key="i">
                  <td class="mono-xs">{{ fmtShortDate(e.date) }}</td>
                  <td><span :class="['ld-type', 'type-' + (e.type || 'other').toLowerCase()]">{{ e.type || 'Other' }}</span></td>
                  <td>
                    <div class="ld-desc">{{ e.description || '—' }}</div>
                    <div v-if="expMeta(e)" class="ld-sub">{{ expMeta(e) }}</div>
                  </td>
                  <td class="mono-xs num">{{ fmt(e.amount) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="ld-total"><span>Total Trip Expenses</span><span class="mono num">{{ fmt(lineDetail.tripExpenses) }}</span></div>
        </template>
      </template>
    </MetricInfoDialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { formatCurrency as fmt } from '../../utils/format'
import { useApi } from '../../composables/useApi'
import { useAuthStore } from '../../stores/auth'
import { useInvestorStore } from '../../stores/investor'
import { useToast } from '../../composables/useToast'
import MetricInfoDialog from './MetricInfoDialog.vue'

const props = defineProps({
  // Super Admin previewing an investor's portal — appended to the payouts
  // fetch and status calls so the backend scopes to that investor.
  previewUserId: { type: Number, default: null },
})

const api = useApi()
const auth = useAuthStore()
const investorStore = useInvestorStore()
const { show: toast } = useToast()

// The ledger lives in the investor store so this section and the Load Reports
// banner render the SAME owed/paid/accruing numbers off one fetch. They used to
// disagree, because the banner computed its own "still owed" independently.
// A failure shouldn't crash the dashboard — loadFailed renders a graceful
// fallback; notFound distinguishes a 404 (empty-state copy) from any other
// error (generic, retryable message).
const loading = computed(() => investorStore.payoutsLoading)
const loadFailed = computed(() => investorStore.payoutsFailed)
const notFound = computed(() => investorStore.payoutsNotFound)
const payouts = computed(() => investorStore.payouts)
const currentMonth = computed(() => investorStore.currentMonth)
const totals = computed(() => investorStore.payoutTotals)

const busyId = ref(null)

// Which past-month row has its earnings breakdown open (single-open accordion).
// The breakdown proves expenses ARE deducted before the split — see waterfall().
// null = every row collapsed.
const expandedId = ref(null)
function toggle(id) {
  expandedId.value = expandedId.value === id ? null : id
}
// The current-month card's breakdown collapses independently of the table.
const currentOpen = ref(false)

const isSuperAdmin = auth.isSuperAdmin
// Column count for the past-months table, so an expanded breakdown row can
// colspan the full width. Mirrors the trailing admin action column's v-if.
const colCount = isSuperAdmin ? 7 : 6

const STATUS_CLASS = { owed: 'st-owed', processing: 'st-processing', paid: 'st-paid' }
function statusClass(s) {
  return STATUS_CLASS[s] || 'st-owed'
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// A deduction renders as an explicit negative ("−$1,234") so the investor can
// SEE money coming out; a $0 line stays plain. Uses the same unicode minus as the
// rest of this statement (the Adjustment column above).
function fmtNeg(n) {
  const v = Math.abs(Number(n || 0))
  return v === 0 ? fmt(0) : '−' + fmt(v)
}

// Turn a payout breakdown into the display waterfall the row/card expands to show:
// revenue, each cost as a negative, then Net Profit and the investor's split share
// (= monthShare). The maintenance-fund and compliance lines only appear when they
// are actually charged (> 0). Returns [] when breakdown is null/absent, so callers
// that still render the panel simply get nothing — but they also v-if on breakdown.
// This is the ONE place the earnings math is described; both surfaces read it.
function waterfall(b) {
  if (!b) return []
  const rows = []
  const add = (label, value, kind, opts = {}) =>
    rows.push({ label, kind, display: kind === 'deduct' ? fmtNeg(value) : fmt(value), ...opts })
  // The four figures the client wants drillable carry a `detailKey`; the rest
  // (maintenance/compliance, Net Profit, × %, Your Share) stay plain. The key is
  // both the click target and the GET /api/investor/payouts/:period/detail slice.
  add('Revenue', b.revenue, 'add', { detailKey: 'revenue' })
  add('− Driver Pay', b.driverPay, 'deduct', { detailKey: 'driverPay' })
  add('− Fixed Costs', b.fixedCosts, 'deduct', { detailKey: 'fixedCosts' })
  add('− Trip Expenses', b.tripExpenses, 'deduct', { highlight: true, detailKey: 'tripExpenses' })
  if (Number(b.maintFundCost || 0) > 0) add('− Maintenance Fund', b.maintFundCost, 'deduct')
  if (Number(b.complianceCost || 0) > 0) add('− Compliance / IFTA', b.complianceCost, 'deduct')
  add('Net Profit', b.netProfit, 'subtotal')
  if (b.splitPct != null) rows.push({ label: `× ${b.splitPct}%`, kind: 'split', display: '' })
  add('Your Share', b.monthShare, 'share')
  return rows
}

// ---- Line-item drill-down modal --------------------------------------------
// Clicking a Revenue / Driver Pay / Fixed Costs / Trip Expenses row in EITHER
// waterfall (past-month table row or current-month card) opens a modal itemizing
// exactly what composes that figure. The list is fetched lazily and cached per
// period in the store, and each modal's footer echoes the headline total so the
// sum is visibly reconciled.
const LINE_LABEL = {
  revenue: 'Revenue',
  driverPay: 'Driver Pay',
  fixedCosts: 'Fixed Costs',
  tripExpenses: 'Trip Expenses',
}
const LINE_SUB = {
  revenue: 'Completed loads that make up this month’s revenue',
  driverPay: 'Active days × daily rate — percentage drivers earn a share of revenue',
  fixedCosts: 'Recurring monthly costs, per truck',
  tripExpenses: 'Fuel, tolls, repairs and other on-the-road costs',
}

const lineModalOpen = ref(false)
const lineDetailKey = ref('')    // '' | 'revenue' | 'driverPay' | 'fixedCosts' | 'tripExpenses'
const linePeriodLabel = ref('')  // e.g. "October 2026" — for the modal header
const lineDetail = ref(null)     // fetched payload for the open period
const lineLoading = ref(false)
const lineError = ref('')

const lineModalTitle = computed(() =>
  lineDetailKey.value ? `${LINE_LABEL[lineDetailKey.value]} — ${linePeriodLabel.value}` : ''
)
const lineModalSubtitle = computed(() => LINE_SUB[lineDetailKey.value] || '')

// Fetch that period's detail through the store (cached), then reveal the modal.
// Scope explicitly from the prop, mirroring loadPayouts(props.previewUserId):
// this section also renders standalone on /my-payouts, where the store carries
// no previewUserId.
async function openLineDetail(period, key, periodLabel) {
  if (!period || !key) return
  lineDetailKey.value = key
  linePeriodLabel.value = periodLabel || period
  lineDetail.value = null
  lineError.value = ''
  lineModalOpen.value = true
  lineLoading.value = true
  try {
    lineDetail.value = await investorStore.fetchPayoutDetail(period, props.previewUserId)
  } catch (err) {
    lineError.value = (err && err.message) || 'Failed to load details. Please try again.'
  } finally {
    lineLoading.value = false
  }
}

// Short date for the drill-down tables. Parse YYYY-MM-DD as LOCAL (not UTC) so a
// day never slips a calendar box; fall back to the raw string otherwise.
function fmtShortDate(d) {
  if (!d) return '—'
  const s = String(d).trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  const dt = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s)
  return isNaN(dt.getTime()) ? s : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// "pickup → dropoff" for a revenue load; em-dash when neither side is known.
function routeText(l) {
  const p = (l.pickup || '').trim()
  const d = (l.dropoff || '').trim()
  if (!p && !d) return '—'
  return `${p || '—'} → ${d || '—'}`
}

// "Driver · City, ST" meta line under an expense description (all parts optional).
function expMeta(e) {
  const bits = []
  if (e.driver) bits.push(e.driver)
  const city = (e.city || '').trim()
  const st = (e.state || '').trim()
  const loc = city && st ? `${city}, ${st}` : (city || st)
  if (loc) bits.push(loc)
  return bits.join(' · ')
}

// effectiveAmount = amount + adjustment (server-computed). Fall back to amount
// for any legacy/absent field so the statement never renders blank.
function effective(p) {
  return p.effectiveAmount != null ? p.effectiveAmount : (p.amount || 0)
}

// The adjustment that actually landed. A payout can be reduced to $0 but never
// inverted, so an over-deduction is clamped; showing the clamped delta keeps
// Amount + Adjustment = Adjusted total true on every row. Falls back to the raw
// adjustment for payloads that predate the field.
function applied(p) {
  return p.adjustmentApplied != null ? p.adjustmentApplied : (p.adjustment || 0)
}

// A row is settleable only when there is actually money to pay. Loss months no
// longer go negative (the server carries them forward), but a month can still
// land on $0 — no activity, fully absorbed by an earlier loss, or adjusted out.
function settleable(p) {
  return effective(p) > 0
}

// Hide months with nothing to say: no earnings, no loss movement, nothing due.
// Rows that ARE $0 because a loss was carried stay visible — otherwise a later
// month paying less than it earned has no visible explanation. Nothing is
// deleted; the admin console still lists every row.
const visiblePayouts = computed(() =>
  payouts.value.filter(
    (p) => effective(p) !== 0 || p.lossDeferred || p.lossCarriedIn || p.adjustment
  )
)

// Refetch through the store so both surfaces update together after a mutation.
// Scope explicitly from the prop: this section also renders standalone on
// /my-payouts, where the store holds no previewUserId.
const loadPayouts = () => investorStore.loadPayouts(props.previewUserId)

async function advance(payout, status) {
  if (busyId.value) return
  busyId.value = payout.id
  try {
    const params = new URLSearchParams()
    if (props.previewUserId) params.set('as_user_id', String(props.previewUserId))
    const qs = params.toString() ? `?${params.toString()}` : ''
    await api.post(`/api/investor/payouts/${payout.id}/status${qs}`, { status })
    toast(status === 'paid' ? 'Payout marked paid' : 'Payout marked processing')
    await loadPayouts()
  } catch (err) {
    toast(err.message || 'Failed to update payout', 'error')
  } finally {
    busyId.value = null
  }
}

onMounted(loadPayouts)
</script>

<style scoped>
.section {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 1.25rem 1.5rem;
  margin-bottom: 1.25rem;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 1rem;
  font-weight: 700;
  color: #0f172a;
  margin-bottom: 1rem;
}
.section-icon {
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 7px; font-size: 0.95rem; font-weight: 700;
}
.section-sub {
  font-size: 0.75rem;
  font-weight: 500;
  color: #64748b;
  margin-left: auto;
}

/* Current month card */
.current-card {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
}
.current-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.current-label {
  font-size: 0.9rem;
  font-weight: 700;
  color: #0f172a;
}
.current-amount {
  font-size: 1.35rem;
  font-weight: 800;
  color: #0f172a;
}
.current-meta {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.6rem;
  flex-wrap: wrap;
}
.current-note {
  font-size: 0.74rem;
  color: #64748b;
  font-style: italic;
}

/* Totals */
.totals-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}
.total-card {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.total-label {
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #64748b;
}
.total-value {
  font-size: 1.15rem;
  font-weight: 800;
}
.total-value.amber { color: #b45309; }
.total-value.blue { color: #0369a1; }
.total-value.green { color: #166534; }

.table-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #64748b;
  margin-bottom: 0.5rem;
}

.empty-msg {
  padding: 1.5rem;
  text-align: center;
  color: #94a3b8;
  font-size: 0.85rem;
  background: #f8fafc;
  border-radius: 8px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}
.data-table thead {
  background: #f8fafc;
}
.data-table th {
  text-align: left;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid #e2e8f0;
}
.data-table td {
  padding: 0.65rem 0.75rem;
  border-bottom: 1px solid #f1f5f9;
  color: #0f172a;
  vertical-align: middle;
}
.mono, .mono-sm { font-family: 'JetBrains Mono', monospace; }
.mono-sm { font-size: 0.78rem; }
.dim { color: #cbd5e1; }

/* Adjustment line shown to the investor under the effective amount */
.inv-adj { font-size: 0.7rem; color: #b45309; margin-top: 0.1rem; font-family: inherit; }
.inv-adj-amt { color: #b45309; }
.amt-negative { color: #b91c1c; }
/* Seven columns don't fit a phone — scroll the table, never the page. Dates and
   period labels get nowrap so they don't shred into three lines under pressure. */
.table-wrap { overflow-x: auto; }
.data-table .num { text-align: right; white-space: nowrap; }
.data-table th, .data-table td { white-space: nowrap; }
.data-table .inv-carry, .data-table .inv-adj-note { white-space: normal; }
.inv-carry { font-size: 0.7rem; color: #64748b; margin-top: 0.1rem; font-family: inherit; font-style: italic; }
.totals-note { display: flex; flex-direction: column; gap: 0.15rem; margin: 0.5rem 0 0.9rem; font-size: 0.74rem; color: var(--text-dim); }
.inv-adj-note { color: #64748b; }

/* --- Expandable earnings breakdown (proof that expenses are deducted) --- */
.expand-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0;
  margin: 0;
  background: none;
  border: none;
  font: inherit;
  font-weight: 600;
  color: #0f172a;
  cursor: pointer;
  text-align: left;
}
.expand-btn:hover { color: #0369a1; }
.expand-btn:hover .chevron { color: #0369a1; }
.expand-btn:focus-visible,
.bd-toggle:focus-visible {
  outline: 2px solid #0369a1;
  outline-offset: 2px;
  border-radius: 4px;
}
.chevron {
  flex: none;
  color: #94a3b8;
  transition: transform 0.15s ease;
}
.chevron.open { transform: rotate(90deg); }

/* Current-month card: "Show breakdown" disclosure toggle */
.current-breakdown { margin-top: 0.25rem; }
.bd-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.5rem;
  padding: 0.15rem 0;
  background: none;
  border: none;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  color: #0369a1;
  cursor: pointer;
}
.bd-toggle:hover { text-decoration: underline; }
.current-breakdown .breakdown-panel {
  max-width: 460px;
  padding: 0.5rem 0 0;
}

/* Breakdown row inside the past-months table spans every column. Two-class
   selectors beat the generic `.data-table td` padding/nowrap without !important. */
.data-table .breakdown-cell {
  padding: 0;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  white-space: normal;
}

/* The panel — shared by the table row and the current-month card. Sticky-left
   keeps it readable when the seven-column table scrolls sideways on a phone;
   the vw cap stops it overflowing a narrow viewport. */
.breakdown-panel {
  position: sticky;
  left: 0;
  box-sizing: border-box;
  width: 100%;
  max-width: min(460px, 90vw);
  padding: 0.8rem 1rem 0.7rem;
  white-space: normal;
}
.bd-caption {
  font-size: 0.64rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  margin-bottom: 0.5rem;
}
.bd-list { margin: 0; }
.bd-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.26rem 0.5rem;
  border: 1px solid transparent;
  border-radius: 6px;
}
.bd-label {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.4rem;
  color: #334155;
  font-size: 0.8rem;
}
.bd-value {
  flex: none;
  color: #0f172a;
  text-align: right;
}
.bd-deduct .bd-value { color: #b45309; }

/* Trip Expenses — the line the client came to see. Tinted band + bold + a
   plain-language tag so it unmistakably reads as "your money, taken out." */
.bd-highlight {
  background: #fffbeb;
  border-color: #fde68a;
}
.bd-highlight .bd-label { color: #0f172a; font-weight: 700; }
.bd-highlight .bd-value { color: #b91c1c; font-weight: 800; }
.bd-tag {
  font-size: 0.58rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #92400e;
  background: #fef3c7;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  white-space: nowrap;
}

/* Divider before the net line, then the emphasized net + share figures. */
.bd-subtotal {
  margin-top: 0.35rem;
  border-top: 1px solid #e2e8f0;
  padding-top: 0.5rem;
}
.bd-subtotal .bd-label,
.bd-subtotal .bd-value { font-weight: 700; }
.bd-split .bd-label { color: #64748b; font-size: 0.74rem; }
.bd-share {
  background: #f1f5f9;
  border-color: #e2e8f0;
}
.bd-share .bd-label,
.bd-share .bd-value { font-weight: 800; color: #0f172a; }
.bd-help {
  margin: 0.55rem 0 0;
  font-size: 0.7rem;
  color: #64748b;
  font-style: italic;
}

.status-pill {
  display: inline-block;
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.2rem 0.55rem;
  border-radius: 10px;
  white-space: nowrap;
}
.status-pill.st-owed { background: #fef3c7; color: #92400e; }
.status-pill.st-processing { background: #dbeafe; color: #1e40af; }
.status-pill.st-paid { background: #dcfce7; color: #166534; }
.status-pill.st-none { background: #f1f5f9; color: #64748b; }
.status-pill.st-progress { background: #dbeafe; color: #1e40af; }

.action-cell {
  text-align: right;
  white-space: nowrap;
}
.action-btn {
  font: inherit;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.3rem 0.65rem;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  margin-left: 0.4rem;
  transition: all 0.15s;
}
.action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.act-processing { background: #dbeafe; color: #1e40af; }
.act-processing:hover:not(:disabled) { background: #bfdbfe; }
.act-paid { background: #dcfce7; color: #166534; }
.act-paid:hover:not(:disabled) { background: #bbf7d0; }

.skeleton {
  background: linear-gradient(90deg, #f1f5f9, #e2e8f0, #f1f5f9);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: 8px;
}
.skeleton-card { height: 160px; }
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* --- Clickable waterfall rows (drill into the line items behind a figure) --- */
.bd-clickable {
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}
.bd-clickable:hover { background: #f1f5f9; border-color: #cbd5e1; }
/* Keep the Trip Expenses row's amber identity when it's the one being hovered. */
.bd-highlight.bd-clickable:hover { background: #fef3c7; border-color: #fcd34d; }
.bd-clickable:focus-visible { outline: 2px solid #0369a1; outline-offset: 1px; }
.bd-chev {
  flex: none; align-self: center; color: #94a3b8;
  transition: color 0.15s ease, transform 0.15s ease;
}
.bd-clickable:hover .bd-chev,
.bd-clickable:focus-visible .bd-chev { color: #0369a1; transform: translateX(1px); }
.bd-view {
  font-size: 0.56rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  color: #0369a1; opacity: 0; transition: opacity 0.15s ease; white-space: nowrap;
}
.bd-clickable:hover .bd-view,
.bd-clickable:focus-visible .bd-view { opacity: 0.7; }

/* --- Line-item drill-down modal (rendered inside MetricInfoDialog) --- */
.ld-state { padding: 1.75rem 0.75rem; text-align: center; color: #64748b; font-size: 0.85rem; }
.ld-error { color: #b91c1c; }
.ld-empty { padding: 1.5rem 0.75rem; text-align: center; color: #94a3b8; font-size: 0.82rem; font-style: italic; }
.ld-scroll { max-height: 340px; overflow-y: auto; margin: 0.15rem 0 0; }
.ld-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
.ld-table thead th {
  position: sticky; top: 0; z-index: 1; background: #f8fafc;
  text-align: left; font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.04em; color: #64748b; padding: 0.4rem 0.5rem; border-bottom: 1px solid #e2e8f0;
}
.ld-table td { padding: 0.45rem 0.5rem; border-bottom: 1px solid #f1f5f9; color: #0f172a; vertical-align: top; }
.ld-table .num, .ld-table th.num { text-align: right; white-space: nowrap; }
.mono-xs { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; }
.ld-sub { font-size: 0.66rem; color: #94a3b8; margin-top: 0.1rem; }
.ld-basis { font-size: 0.74rem; color: #475569; }
.ld-route { font-size: 0.72rem; color: #475569; min-width: 8rem; }
.ld-desc { max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-total {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-top: 0.6rem; padding: 0.6rem 0.65rem;
  background: #f1f5f9; border-radius: 8px;
  font-weight: 800; color: #0f172a; font-size: 0.84rem;
}
.ld-total .mono, .ld-total .num { font-family: 'JetBrains Mono', monospace; }
.ld-truck { border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.5rem 0.65rem; margin-bottom: 0.5rem; }
.ld-truck-head {
  display: flex; justify-content: space-between; align-items: baseline;
  font-weight: 700; color: #0f172a; font-size: 0.82rem;
  margin-bottom: 0.35rem; padding-bottom: 0.3rem; border-bottom: 1px solid #f1f5f9;
}
.ld-kv { display: flex; justify-content: space-between; align-items: baseline; font-size: 0.76rem; color: #475569; padding: 0.15rem 0; }
.ld-kv .mono, .ld-truck-head .mono { font-family: 'JetBrains Mono', monospace; }
.ld-type {
  display: inline-block; font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.04em; padding: 0.12rem 0.4rem; border-radius: 8px; white-space: nowrap;
  background: #e2e8f0; color: #475569;
}
.ld-type.type-fuel { background: #dbeafe; color: #1e40af; }
.ld-type.type-repair, .ld-type.type-maintenance, .ld-type.type-wear { background: #fed7aa; color: #9a3412; }
.ld-type.type-toll { background: #ddd6fe; color: #5b21b6; }
.ld-type.type-food { background: #dcfce7; color: #166534; }

@media (max-width: 768px) {
  .totals-grid { grid-template-columns: 1fr; }
  .data-table { font-size: 0.78rem; }
  .data-table th, .data-table td { padding: 0.45rem 0.5rem; }
  .action-cell { white-space: normal; }
  .breakdown-panel { padding: 0.7rem 0.75rem; }
  .ld-desc, .ld-route { max-width: none; white-space: normal; }
}
</style>
