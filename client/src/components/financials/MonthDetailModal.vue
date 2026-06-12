<template>
  <Teleport to="body">
    <div v-if="open" class="modal-overlay" @click.self="$emit('close')">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="`Financial detail for ${monthTitle}`">
        <div class="modal-header">
          <div>
            <h3>
              {{ monthTitle }}
              <span v-if="detail?.isCurrentMonth" class="mtd-badge">MTD</span>
            </h3>
            <div class="modal-sub">Month P&amp;L drill-down — reconciles with the Monthly Performance row</div>
          </div>
          <button class="modal-close" aria-label="Close" @click="$emit('close')">&times;</button>
        </div>

        <div class="modal-body">
          <!-- Loading -->
          <div v-if="store.monthLoading" class="loading-state">
            <div v-for="i in 4" :key="i" class="skeleton-block"></div>
          </div>

          <!-- Error -->
          <div v-else-if="store.monthError" class="error-box">
            <div class="error-title">Could not load month detail</div>
            <div class="error-msg">{{ store.monthError }}</div>
            <button class="btn btn-primary" @click="store.loadMonth(month)">Retry</button>
          </div>

          <template v-else-if="detail">
            <!-- Trend banner: the winning / scaling / losing / stagnant signal -->
            <div v-if="trend" class="trend-banner" :class="'trend-' + trend.key">
              <span class="trend-badge">{{ trend.label }}</span>
              <span class="trend-desc">{{ trend.desc }}</span>
            </div>

            <!-- Headline KPIs with month-over-month deltas -->
            <div class="kpi-grid">
              <div class="kpi-card">
                <div class="kpi-label">Revenue</div>
                <div class="kpi-value">{{ fmt(detail.summary.revenue) }}</div>
                <div class="kpi-delta" :class="deltaClass(detail.deltas.revenue, false)">
                  {{ deltaText(detail.deltas.revenue, detail.deltas.revenuePct) }}
                </div>
              </div>
              <div class="kpi-card">
                <div class="kpi-label">Total Expenses</div>
                <div class="kpi-value">{{ fmt(detail.summary.totalExpenses) }}</div>
                <div class="kpi-delta" :class="deltaClass(detail.deltas.totalExpenses, true)">
                  {{ deltaText(detail.deltas.totalExpenses, detail.deltas.totalExpensesPct) }}
                </div>
              </div>
              <div class="kpi-card">
                <div class="kpi-label">Driver Pay</div>
                <div class="kpi-value">{{ fmt(detail.summary.driverPay) }}</div>
                <div class="kpi-delta" :class="deltaClass(detail.deltas.driverPay, true)">
                  {{ deltaText(detail.deltas.driverPay, null) }}
                </div>
              </div>
              <div class="kpi-card" :class="detail.summary.netProfit >= 0 ? 'kpi-pos' : 'kpi-neg'">
                <div class="kpi-label">Net Profit</div>
                <div class="kpi-value">{{ fmt(detail.summary.netProfit) }}</div>
                <div class="kpi-delta" :class="deltaClass(detail.deltas.netProfit, false)">
                  {{ deltaText(detail.deltas.netProfit, null) }}
                </div>
              </div>
            </div>
            <div class="compare-note" v-if="detail.prevMonth.hasData">
              vs {{ prevMonthTitle }}: revenue {{ fmt(detail.prevMonth.revenue) }} ·
              expenses {{ fmt(detail.prevMonth.totalExpenses) }} ·
              net {{ fmt(detail.prevMonth.netProfit) }}
            </div>
            <div class="compare-note" v-else>No activity recorded in {{ prevMonthTitle }} — deltas are vs zero.</div>

            <!-- Expense breakdown -->
            <div class="detail-section">
              <div class="detail-title">Where the money went</div>
              <div v-if="!categoryBars.length" class="empty-msg">No expenses recorded this month.</div>
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
            </div>

            <!-- Fuel / diesel -->
            <div class="detail-section">
              <div class="detail-title">Fuel &amp; Diesel</div>
              <div class="mini-kpi-grid">
                <div class="mini-kpi">
                  <div class="mini-label">Fuel Spend</div>
                  <div class="mini-value">{{ fmt(detail.fuel.spend) }}</div>
                  <div class="mini-sub" :class="deltaClass(detail.deltas.fuelSpend, true)">
                    {{ signedFmt(detail.deltas.fuelSpend) }} vs {{ prevShort }}
                  </div>
                </div>
                <div class="mini-kpi">
                  <div class="mini-label">Gallons</div>
                  <div class="mini-value">{{ (detail.fuel.gallons || 0).toLocaleString() }}</div>
                  <div class="mini-sub">{{ detail.fuel.fills }} fill-up{{ detail.fuel.fills === 1 ? '' : 's' }}</div>
                </div>
                <div class="mini-kpi">
                  <div class="mini-label">Avg Price / Gallon</div>
                  <div class="mini-value">${{ (detail.fuel.avgPricePerGallon || 0).toFixed(2) }}</div>
                  <div class="mini-sub">From logged gallons</div>
                </div>
                <div class="mini-kpi">
                  <div class="mini-label">Avg Weekly Diesel</div>
                  <div class="mini-value">{{ fmt(detail.fuel.avgWeeklySpend) }}</div>
                  <div class="mini-sub">Company-wide / week</div>
                </div>
              </div>
              <table v-if="detail.fuel.byTruck.length" class="data-table compact">
                <thead>
                  <tr>
                    <th>Truck</th>
                    <th class="num">Spend</th>
                    <th class="num">Gallons</th>
                    <th class="num">$/Gal</th>
                    <th class="num">Weekly Avg</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="t in detail.fuel.byTruck" :key="t.unit">
                    <td class="mono">{{ t.unit }}</td>
                    <td class="num">{{ fmt(t.spend) }}</td>
                    <td class="num dim">{{ (t.gallons || 0).toLocaleString() }}</td>
                    <td class="num">${{ (t.avgPricePerGallon || 0).toFixed(2) }}</td>
                    <td class="num dim">{{ fmt(t.avgWeeklySpend) }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-else class="empty-msg">No fuel expenses logged this month.</div>
            </div>

            <!-- Loads -->
            <div class="detail-section">
              <div class="detail-title">Loads</div>
              <div class="mini-kpi-grid">
                <div class="mini-kpi">
                  <div class="mini-label">Completed Loads</div>
                  <div class="mini-value">{{ detail.loads.count }}</div>
                  <div class="mini-sub">{{ detail.loads.avgLoadsPerDay }} / day</div>
                </div>
                <div class="mini-kpi">
                  <div class="mini-label">Avg Revenue / Load</div>
                  <div class="mini-value">{{ fmt(detail.loads.avgRevenuePerLoad) }}</div>
                  <div class="mini-sub">{{ detail.loads.count }} load{{ detail.loads.count === 1 ? '' : 's' }}</div>
                </div>
                <div class="mini-kpi">
                  <div class="mini-label">Avg Revenue / Day</div>
                  <div class="mini-value">{{ fmt(detail.loads.avgRevenuePerDay) }}</div>
                  <div class="mini-sub">Over {{ detail.elapsedDays }} day{{ detail.elapsedDays === 1 ? '' : 's' }}</div>
                </div>
              </div>
              <div v-if="detail.loads.highest" class="load-cards">
                <div class="load-card load-best">
                  <div class="load-tag">Highest paying</div>
                  <div class="load-amt pos">{{ fmt(detail.loads.highest.amount) }}</div>
                  <div class="load-meta mono">{{ detail.loads.highest.loadId }}</div>
                  <div class="load-meta">{{ detail.loads.highest.driver }} · {{ detail.loads.highest.date || '—' }}</div>
                </div>
                <div class="load-card load-worst">
                  <div class="load-tag">Lowest paying</div>
                  <div class="load-amt neg">{{ fmt(detail.loads.lowest?.amount || 0) }}</div>
                  <div class="load-meta mono">{{ detail.loads.lowest?.loadId }}</div>
                  <div class="load-meta">{{ detail.loads.lowest?.driver }} · {{ detail.loads.lowest?.date || '—' }}</div>
                </div>
              </div>
              <div v-else class="empty-msg">No revenue-bearing completed loads this month.</div>
            </div>

            <!-- Driver pay -->
            <div class="detail-section">
              <div class="detail-title">
                Driver Pay
                <span class="detail-sub">Active-day basis (completed loads &cap; ELD travel)</span>
              </div>
              <div v-if="!detail.drivers.length" class="empty-msg">No driver activity this month.</div>
              <table v-else class="data-table compact">
                <thead>
                  <tr>
                    <th>Driver</th>
                    <th class="num">Days</th>
                    <th class="num">Rate</th>
                    <th class="num">Pay</th>
                    <th class="num">Revenue</th>
                    <th class="num">Margin</th>
                    <th class="num">Invoiced</th>
                    <th class="num">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="d in detail.drivers" :key="d.name">
                    <td>
                      {{ d.name }}
                      <span v-if="d.payType === 'percentage'" class="pct-badge">{{ d.payPercentage }}%</span>
                    </td>
                    <td class="num">{{ d.payType === 'percentage' ? '—' : d.activeDays }}</td>
                    <td class="num dim">{{ d.payType === 'percentage' ? '—' : '$' + d.dailyRate + '/day' }}</td>
                    <td class="num">{{ fmt(d.pay) }}</td>
                    <td class="num pos">{{ fmt(d.revenue) }}</td>
                    <td class="num" :class="d.margin >= 0 ? 'pos' : 'neg'">{{ fmt(d.margin) }}</td>
                    <td class="num dim">
                      <template v-if="d.invoiceCount">
                        {{ fmt(d.invoicedTotal) }}
                        <span v-if="d.adjustments" class="adj-note" :class="d.adjustments < 0 ? 'neg' : 'pos'">
                          ({{ signedFmt(d.adjustments) }} adj)
                        </span>
                      </template>
                      <template v-else>—</template>
                    </td>
                    <td class="num">
                      <span v-if="d.variance === null" class="dim">no invoice</span>
                      <span v-else-if="d.variance === 0" class="dim">matched</span>
                      <span v-else-if="d.variance > 0" class="neg">{{ signedFmt(d.variance) }} over</span>
                      <span v-else class="warn">{{ signedFmt(d.variance) }} under</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div class="footnote">
                Invoiced = weekly (Sat&ndash;Fri) invoices overlapping this month, incl. admin adjustments
                (deductions/bonuses); boundary weeks also appear in the adjacent month. Variance compares
                invoiced vs the active-day pay estimate &mdash; <span class="neg">over</span> = invoiced above
                the estimate, <span class="warn">under</span> = below.
              </div>
            </div>

            <!-- Per-truck daily rates -->
            <div class="detail-section">
              <div class="detail-title">
                Truck Daily Rates
                <span class="detail-sub">Avg daily rate / truck: <strong>{{ fmt(detail.avgDailyRatePerTruck) }}</strong></span>
              </div>
              <div v-if="!detail.trucks.length" class="empty-msg">No truck activity attributed this month.</div>
              <table v-else class="data-table compact">
                <thead>
                  <tr>
                    <th>Unit #</th>
                    <th>Driver</th>
                    <th class="num">Active Days</th>
                    <th class="num">Daily Rate</th>
                    <th class="num">Est. Driver Pay</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="t in detail.trucks" :key="t.unitNumber">
                    <td class="mono">{{ t.unitNumber }}</td>
                    <td>{{ t.assignedDriver }}</td>
                    <td class="num">{{ t.activeDays }}</td>
                    <td class="num">
                      <template v-if="t.driverPayType === 'percentage'">% pay</template>
                      <template v-else>
                        ${{ t.dailyRate }}
                        <span v-if="t.dailyRateIsDefault" class="default-badge" title="No daily rate set on this truck — using the $250 default">default</span>
                      </template>
                    </td>
                    <td class="num dim">{{ t.estDriverPay === null ? '—' : fmt(t.estDriverPay) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="footnote bottom-note">
              Same basis as the Monthly Performance table: revenue counts in the month the load was assigned
              (completed loads only, canceled/deleted excluded); maintenance-fund service and compliance fees
              are annual buckets and are not included in monthly totals.
              <template v-if="detail.isCurrentMonth"> Current month is to-date ({{ detail.elapsedDays }} of {{ detail.daysInMonth }} days); weekly/daily averages use elapsed days.</template>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, watch, onBeforeUnmount } from 'vue'
import { useFinancialsStore } from '../../stores/financials'
import { formatCurrency as fmt } from '../../utils/format'

const props = defineProps({
  open: { type: Boolean, default: false },
  month: { type: String, default: '' },
})
const emit = defineEmits(['close'])

const store = useFinancialsStore()
const detail = computed(() => store.monthDetail)

function monthName(mk) {
  if (!mk) return ''
  const [y, m] = String(mk).split('-').map(Number)
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}
const monthTitle = computed(() => monthName(props.month))
const prevMonthTitle = computed(() => monthName(detail.value?.prevMonth?.month))
const prevShort = computed(() => {
  const mk = detail.value?.prevMonth?.month
  if (!mk) return 'prev month'
  const [y, m] = String(mk).split('-').map(Number)
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString('en-US', { month: 'short' })
})

// The "am I winning, scaling, losing, or stagnant?" signal.
// Losing: net < 0. Scaling: profitable + revenue up >= 5% MoM.
// Stagnant: profitable but revenue down >= 5% MoM (or break-even).
// Winning: profitable with steady revenue (within ±5%).
const trend = computed(() => {
  const d = detail.value
  if (!d) return null
  const net = d.summary.netProfit
  const prev = d.prevMonth
  const revPct = d.deltas.revenuePct
  if (net < 0) {
    return {
      key: 'losing', label: 'Losing',
      desc: `Expenses exceeded revenue by ${fmt(Math.abs(net))} this month.`,
    }
  }
  if (!prev.hasData) {
    return net > 0
      ? { key: 'winning', label: 'Winning', desc: `Profitable (${fmt(net)} net) — no prior month to compare yet.` }
      : { key: 'stagnant', label: 'Stagnant', desc: 'Break-even month with no prior month to compare.' }
  }
  if ((revPct !== null && revPct >= 5) || (prev.revenue === 0 && d.summary.revenue > 0)) {
    const growth = revPct !== null ? `${revPct > 0 ? '+' : ''}${revPct}%` : 'up from $0'
    return { key: 'scaling', label: 'Scaling', desc: `Profitable and revenue is ${growth} vs ${prevMonthTitle.value}.` }
  }
  if (revPct !== null && revPct <= -5) {
    return { key: 'stagnant', label: 'Stagnant', desc: `Still profitable, but revenue is ${revPct}% vs ${prevMonthTitle.value}.` }
  }
  if (net === 0) {
    return { key: 'stagnant', label: 'Stagnant', desc: `Break-even month — revenue roughly flat vs ${prevMonthTitle.value}.` }
  }
  return { key: 'winning', label: 'Winning', desc: `Profitable (${fmt(net)} net) with steady revenue vs ${prevMonthTitle.value}.` }
})

function signedFmt(n) {
  const v = Number(n || 0)
  return (v >= 0 ? '+' : '') + fmt(v)
}
function deltaText(abs, pct) {
  const base = `${signedFmt(abs)} vs ${prevShort.value}`
  return pct === null || pct === undefined ? base : `${base} (${pct > 0 ? '+' : ''}${pct}%)`
}
// goodWhenDown: for cost metrics an increase is bad (red) and a drop is good.
function deltaClass(abs, goodWhenDown) {
  if (!abs) return 'dim'
  const up = abs > 0
  return (goodWhenDown ? !up : up) ? 'pos' : 'neg'
}

const CATEGORY_META = {
  driver_pay: { label: 'Driver Pay', color: '#0d9488' },
  fuel: { label: 'Fuel', color: '#f59e0b' },
  fixed_costs: { label: 'Fixed Costs', color: '#64748b' },
  maintenance: { label: 'Maintenance', color: '#3b82f6' },
  repair: { label: 'Repair', color: '#ef4444' },
  toll: { label: 'Tolls', color: '#8b5cf6' },
  food: { label: 'Food', color: '#10b981' },
  other: { label: 'Other', color: '#6b7280' },
}
const categoryBars = computed(() => {
  const entries = Object.entries(detail.value?.expenseCategories || {})
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
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount)
})

// Close on Escape while open.
function onKeydown(e) {
  if (e.key === 'Escape') emit('close')
}
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
  },
  { immediate: true }
)
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}
.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  width: min(960px, 100%);
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(2, 6, 23, 0.35);
}
.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.1rem 1.25rem 0.9rem;
  border-bottom: 1px solid var(--border);
}
.modal-header h3 { margin: 0; font-size: 1.15rem; }
.modal-sub { font-size: 0.74rem; color: var(--text-dim); margin-top: 0.2rem; }
.modal-close {
  background: none;
  border: none;
  font-size: 1.5rem;
  line-height: 1;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0.1rem 0.35rem;
  border-radius: 6px;
}
.modal-close:hover { color: var(--text); background: var(--bg); }
.modal-body {
  overflow-y: auto;
  padding: 1.1rem 1.25rem 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.loading-state { display: flex; flex-direction: column; gap: 0.75rem; }
.skeleton-block {
  height: 90px;
  background: var(--bg);
  border-radius: 10px;
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.7; } }

.error-box {
  background: var(--danger-dim, #fef2f2);
  border: 1px solid var(--danger-dim, #fecaca);
  border-radius: 10px;
  padding: 1rem 1.25rem;
  color: var(--danger, #b91c1c);
}
.error-title { font-weight: 700; font-size: 0.95rem; }
.error-msg { font-size: 0.8rem; margin: 0.35rem 0 0.75rem; }

/* Trend banner */
.trend-banner {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  border-radius: 10px;
  padding: 0.75rem 1rem;
  border: 1px solid transparent;
}
.trend-badge {
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  white-space: nowrap;
}
.trend-desc { font-size: 0.8rem; font-weight: 500; }
.trend-scaling { background: #ecfdf5; border-color: #a7f3d0; color: #065f46; }
.trend-scaling .trend-badge { background: #10b981; color: #fff; }
.trend-winning { background: #f0fdf4; border-color: #bbf7d0; color: #166534; }
.trend-winning .trend-badge { background: #22c55e; color: #fff; }
.trend-stagnant { background: #fffbeb; border-color: #fde68a; color: #92400e; }
.trend-stagnant .trend-badge { background: #f59e0b; color: #fff; }
.trend-losing { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
.trend-losing .trend-badge { background: #ef4444; color: #fff; }

/* KPI grid */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 0.75rem;
}
.kpi-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.kpi-card.kpi-pos { border-left: 3px solid var(--accent); }
.kpi-card.kpi-neg { border-left: 3px solid var(--danger, #dc2626); }
.kpi-label {
  font-size: 0.66rem; font-weight: 600;
  color: var(--text-dim); text-transform: uppercase;
  letter-spacing: 0.05em;
}
.kpi-value {
  font-size: 1.25rem; font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
}
.kpi-card.kpi-pos .kpi-value { color: var(--accent); }
.kpi-card.kpi-neg .kpi-value { color: var(--danger, #dc2626); }
.kpi-delta { font-size: 0.7rem; font-weight: 600; font-family: 'JetBrains Mono', monospace; }
.compare-note { font-size: 0.72rem; color: var(--text-dim); margin-top: -0.35rem; }

/* Sections */
.detail-section {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1rem;
}
.detail-title {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  font-weight: 700;
  font-size: 0.88rem;
  margin-bottom: 0.8rem;
}
.detail-sub {
  margin-left: auto;
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--text-dim);
}

/* Mini KPIs */
.mini-kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.6rem;
  margin-bottom: 0.85rem;
}
.mini-kpi {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.6rem 0.75rem;
}
.mini-label {
  font-size: 0.62rem; font-weight: 600;
  color: var(--text-dim); text-transform: uppercase;
  letter-spacing: 0.05em;
}
.mini-value {
  font-size: 1.05rem; font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  margin-top: 0.15rem;
}
.mini-sub { font-size: 0.66rem; color: var(--text-dim); margin-top: 0.1rem; }
.mini-sub.pos { color: var(--accent); }
.mini-sub.neg { color: var(--danger, #dc2626); }

/* Bars */
.bar-list { display: flex; flex-direction: column; gap: 0.6rem; }
.bar-label {
  display: flex; justify-content: space-between;
  font-size: 0.76rem; font-weight: 600;
  margin-bottom: 0.25rem;
}
.bar-val { font-family: 'JetBrains Mono', monospace; font-weight: 700; }
.bar-pct { font-weight: 500; color: var(--text-dim); }
.bar-track {
  height: 9px; background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px; overflow: hidden;
}
.bar-fill { height: 100%; border-radius: 6px; transition: width 0.5s ease; }

/* Load cards */
.load-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
@media (max-width: 640px) { .load-cards { grid-template-columns: 1fr; } }
.load-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.7rem 0.85rem;
}
.load-card.load-best { border-left: 3px solid var(--accent); }
.load-card.load-worst { border-left: 3px solid var(--danger, #dc2626); }
.load-tag {
  font-size: 0.62rem; font-weight: 700;
  color: var(--text-dim); text-transform: uppercase;
  letter-spacing: 0.05em;
}
.load-amt {
  font-size: 1.1rem; font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  margin: 0.15rem 0;
}
.load-meta { font-size: 0.72rem; color: var(--text-dim); }
.load-meta.mono { font-family: 'JetBrains Mono', monospace; font-weight: 600; color: var(--text); }

/* Tables */
.data-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.78rem;
}
.data-table th {
  text-align: left;
  padding: 0.45rem 0.5rem;
  font-weight: 600;
  color: var(--text-dim);
  border-bottom: 2px solid var(--border);
  font-size: 0.64rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.data-table th.num { text-align: right; }
.data-table td {
  padding: 0.5rem 0.5rem;
  border-bottom: 1px solid var(--surface);
}
.data-table tbody tr:hover { background: var(--surface); }
.data-table td.num { text-align: right; font-family: 'JetBrains Mono', monospace; }
.data-table td.mono { font-family: 'JetBrains Mono', monospace; font-weight: 600; }
.dim { color: var(--text-dim); }
.pos { color: var(--accent); font-weight: 600; }
.neg { color: var(--danger, #dc2626); font-weight: 600; }
.warn { color: #b45309; font-weight: 600; }

.pct-badge, .default-badge {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0.05rem 0.4rem;
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  border-radius: 999px;
  vertical-align: middle;
}
.pct-badge { color: #1d4ed8; background: #dbeafe; }
.default-badge { color: #92400e; background: #fef3c7; cursor: help; }
.adj-note { font-size: 0.68rem; }

.mtd-badge {
  display: inline-block;
  margin-left: 0.45rem;
  padding: 0.05rem 0.45rem;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: #065f46;
  background: #d1fae5;
  border-radius: 999px;
  vertical-align: middle;
}

.footnote {
  font-size: 0.68rem;
  color: var(--text-dim);
  line-height: 1.5;
  margin-top: 0.6rem;
}
.bottom-note { margin-top: 0; }
.empty-msg {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.8rem;
  padding: 1rem 0;
}
</style>
