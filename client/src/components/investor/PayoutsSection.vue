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
                :class="[`bd-${row.kind}`, { 'bd-highlight': row.highlight }]"
              >
                <dt class="bd-label">
                  {{ row.label }}
                  <span v-if="row.highlight" class="bd-tag">your expenses</span>
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
                    :class="[`bd-${row.kind}`, { 'bd-highlight': row.highlight }]"
                  >
                    <dt class="bd-label">
                      {{ row.label }}
                      <span v-if="row.highlight" class="bd-tag">your expenses</span>
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { formatCurrency as fmt } from '../../utils/format'
import { useApi } from '../../composables/useApi'
import { useAuthStore } from '../../stores/auth'
import { useInvestorStore } from '../../stores/investor'
import { useToast } from '../../composables/useToast'

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
  add('Revenue', b.revenue, 'add')
  add('− Driver Pay', b.driverPay, 'deduct')
  add('− Fixed Costs', b.fixedCosts, 'deduct')
  add('− Trip Expenses', b.tripExpenses, 'deduct', { highlight: true })
  if (Number(b.maintFundCost || 0) > 0) add('− Maintenance Fund', b.maintFundCost, 'deduct')
  if (Number(b.complianceCost || 0) > 0) add('− Compliance / IFTA', b.complianceCost, 'deduct')
  add('Net Profit', b.netProfit, 'subtotal')
  if (b.splitPct != null) rows.push({ label: `× ${b.splitPct}%`, kind: 'split', display: '' })
  add('Your Share', b.monthShare, 'share')
  return rows
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

@media (max-width: 768px) {
  .totals-grid { grid-template-columns: 1fr; }
  .data-table { font-size: 0.78rem; }
  .data-table th, .data-table td { padding: 0.45rem 0.5rem; }
  .action-cell { white-space: normal; }
  .breakdown-panel { padding: 0.7rem 0.75rem; }
}
</style>
