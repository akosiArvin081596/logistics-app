<template>
  <div class="financials-page admin-page">
    <div class="page-header">
      <h2>Financials</h2>
      <div class="page-sub">Full-fleet P&amp;L, expense breakdown, and per-truck performance.</div>
    </div>

    <div v-if="store.isLoading && !store.summary" class="loading-state">
      <div class="skeleton skeleton-card" v-for="i in 6" :key="i"></div>
    </div>

    <div v-else-if="store.lastError" class="error-state">
      <div class="error-title">Could not load financials</div>
      <div class="error-msg">{{ store.lastError }}</div>
      <button class="btn btn-primary" @click="store.load()">Retry</button>
    </div>

    <template v-else-if="store.summary">
      <!-- Data-quality warning: loads with no driver attribution -->
      <div v-if="store.summary.unassignedRevenue > 0" class="data-warning">
        <div class="data-warning-title">&#9888; Unassigned Revenue Detected</div>
        <div class="data-warning-msg">
          <strong>{{ fmt(store.summary.unassignedRevenue) }}</strong> across
          <strong>{{ store.summary.unassignedLoadCount }}</strong> completed load{{ store.summary.unassignedLoadCount !== 1 ? 's' : '' }}
          have no driver assigned in the Job Tracking sheet. These loads are
          counted in Total Revenue but cannot be attributed on the leaderboard.
          Review the sheet and fill in the Driver column to fix.
        </div>
      </div>

      <!-- 1. Summary KPI row -->
      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">$</div>
          Fleet Summary
          <span class="section-sub">Based on {{ store.summary.monthsOfOperation }} month{{ store.summary.monthsOfOperation !== 1 ? 's' : '' }} of data</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card">
            <div class="kpi-label">Total Revenue</div>
            <div class="kpi-value">{{ fmt(store.summary.totalRevenue) }}</div>
            <div class="kpi-sub">{{ store.summary.completedLoadCount }} completed loads</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Total Expenses</div>
            <div class="kpi-value">{{ fmt(store.summary.totalExpenses) }}</div>
            <div class="kpi-sub">All categories + driver pay + fixed costs</div>
          </div>
          <div class="kpi-card" :class="store.summary.netProfit >= 0 ? 'kpi-pos' : 'kpi-neg'">
            <div class="kpi-label">Net Profit</div>
            <div class="kpi-value">{{ fmt(store.summary.netProfit) }}</div>
            <div class="kpi-sub">Before investor split</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Biggest Category</div>
            <div class="kpi-value">{{ store.summary.biggestExpenseCategory?.name || '—' }}</div>
            <div class="kpi-sub">{{ fmt(store.summary.biggestExpenseCategory?.amount || 0) }}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Avg Rate/Mile</div>
            <div class="kpi-value">${{ store.summary.avgRatePerMile?.toFixed(2) || '0.00' }}</div>
            <div class="kpi-sub">Revenue per odometer mile</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Total Miles</div>
            <div class="kpi-value">{{ (store.summary.totalMiles || 0).toLocaleString() }}</div>
            <div class="kpi-sub">From driver odometer readings</div>
          </div>
        </div>
      </section>

      <!-- 2. Expense Categories -->
      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--amber-dim); color: var(--amber);">&#128202;</div>
          Expense Categories
        </div>
        <div v-if="!categoryBars.length" class="empty-msg">No expense data yet.</div>
        <div v-else class="bar-list">
          <div v-for="row in categoryBars" :key="row.key" class="bar-row">
            <div class="bar-label">
              <span>{{ row.label }}</span>
              <span class="bar-val">{{ fmt(row.amount) }} <span class="bar-pct">({{ row.pct.toFixed(1) }}%)</span></span>
            </div>
            <div class="bar-track">
              <div class="bar-fill" :style="{ width: row.pct + '%', background: row.color }"></div>
            </div>
          </div>
        </div>
      </section>

      <!-- 3. Per-Truck Performance -->
      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--blue-dim, #dbeafe); color: var(--blue, #2563eb);">&#128665;</div>
          Per-Truck Performance
          <span class="section-sub">Click a column header to sort</span>
        </div>
        <div v-if="!store.perTruck.length" class="empty-msg">No trucks in database yet.</div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th class="sortable" @click="sortBy('unitNumber')">Unit #{{ sortIcon('unitNumber') }}</th>
              <th class="sortable" @click="sortBy('assignedDriver')">Current Driver{{ sortIcon('assignedDriver') }}</th>
              <th class="sortable num" @click="sortBy('loadCount')">Loads{{ sortIcon('loadCount') }}</th>
              <th class="sortable num" @click="sortBy('gross')">Gross{{ sortIcon('gross') }}</th>
              <th class="sortable num" @click="sortBy('expenses')">Expenses{{ sortIcon('expenses') }}</th>
              <th class="sortable num" @click="sortBy('net')">Net{{ sortIcon('net') }}</th>
              <th class="sortable num" @click="sortBy('totalMiles')">Miles{{ sortIcon('totalMiles') }}</th>
              <th class="sortable num" @click="sortBy('ratePerMile')">$/Mile{{ sortIcon('ratePerMile') }}</th>
              <th class="sortable num" @click="sortBy('monthlyCost')">Monthly Cost{{ sortIcon('monthlyCost') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in sortedTrucks" :key="t.unitNumber">
              <td class="mono">{{ t.unitNumber }}</td>
              <td>{{ t.assignedDriver }}</td>
              <td class="num">{{ t.loadCount }}</td>
              <td class="num">{{ fmt(t.gross) }}</td>
              <td class="num dim">{{ fmt(t.expenses) }}</td>
              <td class="num" :class="t.net >= 0 ? 'pos' : 'neg'">{{ fmt(t.net) }}</td>
              <td class="num">{{ (t.totalMiles || 0).toLocaleString() }}</td>
              <td class="num">${{ (t.ratePerMile || 0).toFixed(2) }}</td>
              <td class="num dim">{{ fmt(t.monthlyCost) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 4. Highest & Lowest Loads -->
      <section class="section two-col">
        <div class="col">
          <div class="section-title">
            <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#8599;</div>
            Top 5 Highest Paying Loads
          </div>
          <div v-if="!store.loads.highest.length" class="empty-msg">No completed loads yet.</div>
          <table v-else class="data-table compact">
            <thead>
              <tr>
                <th>Load ID</th>
                <th>Driver</th>
                <th class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in store.loads.highest" :key="'h-' + l.loadId">
                <td class="mono">{{ l.loadId }}</td>
                <td>{{ l.driver }}</td>
                <td class="num pos">{{ fmt(l.amount) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="col">
          <div class="section-title">
            <div class="section-icon" style="background: var(--danger-dim, #fee2e2); color: var(--danger, #dc2626);">&#8600;</div>
            Bottom 5 Lowest Paying Loads
          </div>
          <div v-if="!store.loads.lowest.length" class="empty-msg">No completed loads yet.</div>
          <table v-else class="data-table compact">
            <thead>
              <tr>
                <th>Load ID</th>
                <th>Driver</th>
                <th class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in store.loads.lowest" :key="'l-' + l.loadId">
                <td class="mono">{{ l.loadId }}</td>
                <td>{{ l.driver }}</td>
                <td class="num neg">{{ fmt(l.amount) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 5. Driver Earnings Leaderboard -->
      <section class="section">
        <div class="section-title">
          <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#127942;</div>
          Driver Earnings Leaderboard
          <span class="section-sub">Ranked by revenue generated</span>
        </div>
        <div v-if="!store.drivers.length" class="empty-msg">No driver activity yet.</div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th class="num">Rank</th>
              <th>Driver</th>
              <th class="num">Revenue Generated</th>
              <th class="num">Driver Pay</th>
              <th class="num">Loads</th>
              <th class="num">Miles</th>
              <th class="num">$/Mile</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(d, i) in store.drivers" :key="d.name" :class="{ 'row-unassigned': d.isUnassigned }">
              <td class="num">
                <span v-if="!d.isUnassigned" class="rank-badge" :class="'rank-' + Math.min(i + 1, 4)">{{ i + 1 }}</span>
                <span v-else class="unassigned-mark">&#9888;</span>
              </td>
              <td>{{ d.name }}</td>
              <td class="num pos">{{ fmt(d.grossRevenue) }}</td>
              <td class="num dim">{{ d.isUnassigned ? '—' : fmt(d.totalEarnings) }}</td>
              <td class="num">{{ d.loadCount }}</td>
              <td class="num">{{ d.isUnassigned ? '—' : (d.totalMiles || 0).toLocaleString() }}</td>
              <td class="num">{{ d.isUnassigned ? '—' : '$' + (d.avgRatePerMile || 0).toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useFinancialsStore } from '../stores/financials'
import { useSocketRefresh } from '../composables/useSocketRefresh'
import { formatCurrency as fmt } from '../utils/format'

const store = useFinancialsStore()

const sortKey = ref('net')
const sortDir = ref('desc')

const sortedTrucks = computed(() => {
  const arr = [...store.perTruck]
  const k = sortKey.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  return arr.sort((a, b) => {
    const av = a[k]
    const bv = b[k]
    // Treat null/undefined as zero for numeric cols so they don't fall into
    // the string-compare branch and scatter alphabetically.
    const aNum = typeof av === 'number' ? av : (av == null ? 0 : NaN)
    const bNum = typeof bv === 'number' ? bv : (bv == null ? 0 : NaN)
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum) && (typeof av === 'number' || typeof bv === 'number' || av == null || bv == null)) {
      return (aNum - bNum) * dir
    }
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir
  })
})

function sortBy(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = 'desc'
  }
}

function sortIcon(key) {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'asc' ? ' \u2191' : ' \u2193'
}

// Category bars, sorted descending by amount
const CATEGORY_META = {
  fuel: { label: 'Fuel', color: '#f59e0b' },
  maintenance: { label: 'Maintenance', color: '#3b82f6' },
  repair: { label: 'Repair', color: '#ef4444' },
  toll: { label: 'Tolls', color: '#8b5cf6' },
  food: { label: 'Food', color: '#10b981' },
  other: { label: 'Other', color: '#6b7280' },
}
const categoryBars = computed(() => {
  const entries = Object.entries(store.expensesByCategory || {})
  const total = entries.reduce((s, [, v]) => s + v, 0)
  if (!total) return []
  return entries
    .map(([key, amount]) => ({
      key,
      label: CATEGORY_META[key]?.label || key,
      color: CATEGORY_META[key]?.color || '#6b7280',
      amount,
      pct: (amount / total) * 100,
    }))
    .sort((a, b) => b.amount - a.amount)
})

onMounted(() => store.load())
useSocketRefresh('expenses:changed', () => store.load())
useSocketRefresh('invoices:changed', () => store.load())
</script>

<style scoped>
.financials-page {
  padding: 1rem 1.25rem 2rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.page-header h2 { font-size: 1.4rem; margin: 0; }
.page-sub { font-size: 0.82rem; color: var(--text-dim); margin-top: 0.2rem; }

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

/* KPI Grid */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
}
.kpi-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.9rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.kpi-card.kpi-pos { border-left: 3px solid var(--accent); }
.kpi-card.kpi-neg { border-left: 3px solid var(--danger, #dc2626); }
.kpi-label {
  font-size: 0.68rem; font-weight: 600;
  color: var(--text-dim); text-transform: uppercase;
  letter-spacing: 0.05em;
}
.kpi-value {
  font-size: 1.3rem; font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
}
.kpi-card.kpi-pos .kpi-value { color: var(--accent); }
.kpi-card.kpi-neg .kpi-value { color: var(--danger, #dc2626); }
.kpi-sub { font-size: 0.7rem; color: var(--text-dim); }

/* Bar chart */
.bar-list { display: flex; flex-direction: column; gap: 0.65rem; }
.bar-row {}
.bar-label {
  display: flex; justify-content: space-between;
  font-size: 0.78rem; font-weight: 600;
  margin-bottom: 0.3rem;
}
.bar-val { font-family: 'JetBrains Mono', monospace; font-weight: 700; }
.bar-pct { font-weight: 500; color: var(--text-dim); }
.bar-track {
  height: 10px; background: var(--bg);
  border-radius: 6px; overflow: hidden;
}
.bar-fill {
  height: 100%; border-radius: 6px;
  transition: width 0.5s ease;
}

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
.data-table th.sortable { cursor: pointer; }
.data-table th.sortable:hover { color: var(--text); }
.data-table td {
  padding: 0.6rem 0.5rem;
  border-bottom: 1px solid var(--bg);
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
.data-table td.pos { color: var(--accent); font-weight: 600; }
.data-table td.neg { color: var(--danger, #dc2626); font-weight: 600; }
.data-table.compact td, .data-table.compact th {
  padding: 0.45rem 0.5rem;
  font-size: 0.78rem;
}

.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}
.two-col .col { background: transparent; }
@media (max-width: 900px) {
  .two-col { grid-template-columns: 1fr; }
}

.rank-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px; height: 24px;
  border-radius: 50%;
  font-size: 0.72rem;
  font-weight: 700;
  background: var(--bg);
  color: var(--text-dim);
}
.rank-badge.rank-1 { background: #fde68a; color: #92400e; }
.rank-badge.rank-2 { background: #e5e7eb; color: #374151; }
.rank-badge.rank-3 { background: #fecaca; color: #991b1b; }

.empty-msg {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 1.5rem 0;
}

.data-warning {
  background: #fef3c7;
  border: 1px solid #fcd34d;
  border-left: 4px solid #f59e0b;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  color: #78350f;
}
.data-warning-title {
  font-weight: 700;
  font-size: 0.85rem;
  margin-bottom: 0.35rem;
}
.data-warning-msg {
  font-size: 0.78rem;
  line-height: 1.5;
}
.row-unassigned {
  background: rgba(251, 191, 36, 0.08);
  font-style: italic;
}
.row-unassigned:hover { background: rgba(251, 191, 36, 0.14); }
.unassigned-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px; height: 24px;
  font-size: 0.95rem;
  color: #f59e0b;
}
</style>
