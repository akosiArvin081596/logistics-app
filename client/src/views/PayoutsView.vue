<template>
  <div class="admin-page payouts-page">
    <div class="page-header">
      <h2>Payouts</h2>
      <p class="page-sub">
        Monthly investor settlements across the whole fleet &mdash; what's owed, what's processing,
        and how much you pay out each month. Advance a payout from owed &rarr; processing &rarr; paid.
      </p>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="skeleton skeleton-card" v-for="i in 4" :key="i"></div>
    </div>

    <template v-else-if="loadFailed">
      <div v-if="notFound" class="empty">
        Payout settlements aren't available yet.
      </div>
      <div v-else class="error-state">
        <div class="error-title">Could not load payouts</div>
        <div class="error-msg">{{ errorMsg || 'Something went wrong — try again.' }}</div>
        <button class="btn btn-primary" @click="loadPayouts">Retry</button>
      </div>
    </template>

    <template v-else>
      <!-- 1. Grand totals -->
      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#128176;</div>
          Settlement Totals
          <span class="section-sub">Across all investors, all periods</span>
        </div>
        <div class="totals-grid">
          <div class="total-card amber">
            <span class="total-label">Total Owed</span>
            <span class="total-value mono">{{ fmt(grandTotals.totalOwed) }}</span>
          </div>
          <div class="total-card blue">
            <span class="total-label">Total Processing</span>
            <span class="total-value mono">{{ fmt(grandTotals.totalProcessing) }}</span>
          </div>
          <div class="total-card green">
            <span class="total-label">Total Paid</span>
            <span class="total-value mono">{{ fmt(grandTotals.totalPaid) }}</span>
          </div>
        </div>
      </section>

      <!-- 2. Monthly payout totals — "how much I pay out each month" -->
      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--amber-dim); color: var(--amber);">&#128197;</div>
          Monthly Payout Totals
          <span class="section-sub">Settled across all investors, newest first</span>
        </div>
        <div v-if="!monthlyTotals.length" class="empty-msg">No monthly payout history yet.</div>
        <table v-else class="data-table monthly-table">
          <thead>
            <tr>
              <th>Period</th>
              <th class="num">Owed</th>
              <th class="num">Processing</th>
              <th class="num">Paid</th>
              <th class="num">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in monthlyTotals" :key="m.period">
              <td class="mono">{{ m.periodLabel }}</td>
              <td class="num amber">{{ fmt(m.owed) }}</td>
              <td class="num blue">{{ fmt(m.processing) }}</td>
              <td class="num green">{{ fmt(m.paid) }}</td>
              <td class="num strong">{{ fmt(m.total) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 3. Per-investor settlement -->
      <div v-if="!investors.length" class="empty">No investors with payouts yet.</div>
      <section
        v-for="inv in investors"
        :key="inv.ownerId"
        class="section investor-section"
      >
        <div class="section-title">
          <div class="section-icon" style="background: var(--blue-dim); color: var(--blue);">&#128188;</div>
          {{ inv.name }}
          <span class="section-sub">
            Owed {{ fmt(inv.totalOwed) }} &middot; Processing {{ fmt(inv.totalProcessing) }} &middot; Paid {{ fmt(inv.totalPaid) }}
          </span>
        </div>

        <!-- Current month: accruing, not yet payable -->
        <div v-if="inv.currentMonth" class="current-card">
          <div class="current-main">
            <span class="current-label">{{ inv.currentMonth.periodLabel }}</span>
            <span class="current-amount mono">{{ fmt(inv.currentMonth.amountInProgress) }}</span>
          </div>
          <div class="current-meta">
            <span class="status-pill st-progress">in progress</span>
            <span class="current-note">Accruing this month &mdash; not yet payable until the period closes.</span>
          </div>
        </div>

        <div v-if="!inv.payouts.length" class="empty-msg">No past payouts yet.</div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>Period</th>
              <th class="num">Amount</th>
              <th>Due date</th>
              <th>Status</th>
              <th class="action-head"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in inv.payouts" :key="p.id">
              <td class="mono">{{ p.periodLabel }}</td>
              <td class="num">{{ fmt(p.amount) }}</td>
              <td class="dim">{{ fmtDate(p.dueDate) }}</td>
              <td><span :class="['status-pill', statusClass(p.status)]">{{ p.status }}</span></td>
              <td class="action-cell">
                <button
                  v-if="p.status === 'owed'"
                  type="button"
                  class="action-btn act-processing"
                  :disabled="busyId === p.id"
                  title="Move this payout from owed to processing"
                  @click="advance(inv, p, 'processing')"
                >Mark Processing</button>
                <button
                  v-if="p.status !== 'paid'"
                  type="button"
                  class="action-btn act-paid"
                  :disabled="busyId === p.id"
                  title="Mark this payout as paid"
                  @click="advance(inv, p, 'paid')"
                >Mark Paid</button>
                <span v-if="p.status === 'paid'" class="dim">&mdash;</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { formatCurrency as fmt } from '../utils/format'
import { useApi } from '../composables/useApi'
import { useAuthStore } from '../stores/auth'
import { useToast } from '../composables/useToast'

const api = useApi()
// Pulled in for parity with the other admin pages; auth gating is enforced by
// the router guard, but having the store here keeps the surface consistent and
// available for future per-row checks.
useAuthStore()
const { show: toast } = useToast()

const loading = ref(true)
// A load failure shouldn't blank the whole admin page. We flip loadFailed and
// render a graceful fallback; notFound distinguishes a 404 (endpoint not built
// yet → empty-state copy) from any other error (generic, retryable message).
const loadFailed = ref(false)
const notFound = ref(false)
const errorMsg = ref('')
const busyId = ref(null)

const investors = ref([])
const monthlyTotals = ref([])
const grandTotals = ref({ totalOwed: 0, totalProcessing: 0, totalPaid: 0 })

const STATUS_CLASS = { owed: 'st-owed', processing: 'st-processing', paid: 'st-paid' }
function statusClass(s) {
  return STATUS_CLASS[s] || 'st-owed'
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

async function loadPayouts() {
  loading.value = true
  try {
    const data = await api.get('/api/payouts')
    investors.value = data.investors || []
    monthlyTotals.value = data.monthlyTotals || []
    grandTotals.value = data.grandTotals || { totalOwed: 0, totalProcessing: 0, totalPaid: 0 }
    loadFailed.value = false
    notFound.value = false
    errorMsg.value = ''
  } catch (err) {
    // Degrade gracefully. A 404 means the endpoint isn't serving yet (it's
    // being built in parallel) → empty state; anything else is a genuine load
    // error with a distinct, retryable message.
    investors.value = []
    monthlyTotals.value = []
    grandTotals.value = { totalOwed: 0, totalProcessing: 0, totalPaid: 0 }
    loadFailed.value = true
    notFound.value = err.status === 404
    errorMsg.value = err.message || ''
  }
  loading.value = false
}

async function advance(investor, payout, status) {
  if (busyId.value) return
  busyId.value = payout.id
  try {
    await api.post(`/api/investor/payouts/${payout.id}/status`, { status })
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
/* .admin-page (shared.css) supplies the flex-column page frame; .main applies
   the shared page padding. Only page-specific spacing lives here. */
.payouts-page {
  gap: 1rem;
  padding-bottom: 2rem;
}
.page-header h2 { font-size: 1.4rem; margin: 0; }
.page-sub {
  font-size: 0.82rem;
  color: var(--text-dim);
  margin-top: 0.2rem;
  max-width: 720px;
  line-height: 1.45;
}

.loading-state { display: flex; flex-direction: column; gap: 0.75rem; }
.skeleton-card {
  height: 100px;
  background: var(--bg);
  border-radius: 10px;
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.7; } }

.error-state {
  background: var(--danger-dim, #fef2f2);
  border: 1px solid var(--danger-dim, #fecaca);
  border-radius: 10px;
  padding: 1rem 1.25rem;
  color: var(--danger, #b91c1c);
}
.error-title { font-weight: 700; font-size: 0.95rem; }
.error-msg { font-size: 0.8rem; margin: 0.35rem 0 0.75rem; }

.empty {
  padding: 3rem 1rem;
  text-align: center;
  background: var(--surface);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-dim);
  font-size: 0.9rem;
}

.section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.25rem;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-weight: 700;
  font-size: 0.95rem;
  margin-bottom: 1rem;
}
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.85rem; font-weight: 700;
}
.section-sub {
  margin-left: auto;
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-dim);
}

/* Grand totals */
.totals-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
}
.total-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.total-card.amber { border-left: 3px solid var(--amber); }
.total-card.blue { border-left: 3px solid var(--blue); }
.total-card.green { border-left: 3px solid #16a34a; }
.total-label {
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
}
.total-value {
  font-size: 1.3rem;
  font-weight: 800;
}
.total-card.amber .total-value { color: #b45309; }
.total-card.blue .total-value { color: #0369a1; }
.total-card.green .total-value { color: #166534; }

/* Tables */
.data-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.82rem;
}
.data-table th {
  text-align: left;
  padding: 0.5rem 0.5rem;
  font-weight: 600;
  color: var(--text-dim);
  border-bottom: 2px solid var(--border);
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  user-select: none;
}
.data-table th.num { text-align: right; }
.data-table th.action-head { text-align: right; }
.data-table td {
  padding: 0.6rem 0.5rem;
  border-bottom: 1px solid var(--bg);
  vertical-align: middle;
}
.data-table tbody tr:hover { background: var(--bg); }
.data-table td.num {
  text-align: right;
  font-family: 'JetBrains Mono', monospace;
}
.data-table td.mono {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
}
.data-table td.dim { color: var(--text-dim); }
.data-table td.amber { color: #b45309; }
.data-table td.blue { color: #0369a1; }
.data-table td.green { color: #166534; }
.data-table td.strong { font-weight: 700; }
.monthly-table td.num { font-weight: 600; }

/* Current-month accrual card */
.current-card {
  background: var(--bg);
  border: 1px solid var(--border);
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
  color: var(--text);
}
.current-amount {
  font-size: 1.35rem;
  font-weight: 800;
  color: var(--text);
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
  color: var(--text-dim);
  font-style: italic;
}
.mono { font-family: 'JetBrains Mono', monospace; }

.empty-msg {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 1.5rem 0;
}

/* Status pills — same palette as PayoutsSection */
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
.status-pill.st-progress { background: #dbeafe; color: #1e40af; }

/* Row actions */
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

@media (max-width: 768px) {
  .totals-grid { grid-template-columns: 1fr; }
  .data-table { font-size: 0.78rem; }
  .data-table th, .data-table td { padding: 0.45rem 0.4rem; }
  .action-cell { white-space: normal; }
}
</style>
