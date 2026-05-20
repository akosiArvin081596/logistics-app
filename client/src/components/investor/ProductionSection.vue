<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#9650;</div>
      Production Performance
    </div>

    <!-- Monthly Revenue Chart — always shows 12 months -->
    <div class="chart-bars">
      <div
        v-for="m in chartMonths"
        :key="m.key"
        class="chart-bar-wrap"
        :class="{ current: m.isCurrent, clickable: m.amount > 0 || m.isCurrent }"
        :role="(m.amount > 0 || m.isCurrent) ? 'button' : undefined"
        :tabindex="(m.amount > 0 || m.isCurrent) ? 0 : undefined"
        :aria-label="(m.amount > 0 || m.isCurrent) ? `Open breakdown of revenue for ${monthFullLabel(m.key)}` : undefined"
        :title="(m.amount > 0 || m.isCurrent) ? `${monthFullLabel(m.key)}: ${m.amount > 0 ? fmt(m.amount) : 'no revenue yet'} — click for details` : undefined"
        @click="(m.amount > 0 || m.isCurrent) && openMonthDetail(m)"
        @keyup.enter="(m.amount > 0 || m.isCurrent) && openMonthDetail(m)"
        @keyup.space.prevent="(m.amount > 0 || m.isCurrent) && openMonthDetail(m)"
      >
        <div class="chart-amount">{{ m.amount > 0 ? fmt(m.amount) : '' }}</div>
        <div class="chart-bar" :class="{ empty: m.amount === 0, 'bar-current': m.isCurrent }" :style="{ height: m.amount > 0 ? barHeight(m.amount) : '2px' }"></div>
        <div class="chart-label" :class="{ 'label-current': m.isCurrent }">{{ m.label }}</div>
      </div>
    </div>
    <div class="chart-caption">Monthly Revenue &middot; <span class="caption-hint">click any month for details</span></div>

    <!-- Detail modal -->
    <MetricInfoDialog
      :open="!!selectedMonth"
      :title="modalTitle"
      :subtitle="modalSubtitle"
      @update:open="v => { if (!v) selectedMonth = null }"
    >
      <template v-if="selectedMonth">
        <div class="modal-breakdown">
          <div class="modal-explain">
            Revenue for <strong>{{ monthFullLabel(selectedMonth.key) }}</strong> is the sum of every load your truck(s) completed in this calendar month, taken from the Payment column of the Job Tracking sheet.
          </div>
          <div class="step-label">This Month</div>
          <div class="modal-row highlight">
            <span>{{ monthFullLabel(selectedMonth.key) }}{{ selectedMonth.isCurrent ? ' (in progress)' : '' }}</span>
            <span class="val accent">{{ fmt(selectedMonth.amount) }}</span>
          </div>

          <template v-if="selectedMonthEarnings">
            <div class="step-label">Your Share for This Month</div>
            <div class="modal-explain-sm">
              How your portion of this month's revenue breaks down after operating costs and the 50/50 split.
            </div>
            <div class="modal-row deduct">
              <span>- Driver Pay</span>
              <span class="val danger">-{{ fmt(selectedMonthEarnings.driverPay) }}</span>
            </div>
            <div class="modal-row deduct">
              <span>- Fixed Costs</span>
              <span class="val danger">-{{ fmt(selectedMonthEarnings.fixedCosts) }}</span>
            </div>
            <div class="modal-row deduct">
              <span>- Trip Expenses</span>
              <span class="val danger">-{{ fmt(selectedMonthEarnings.tripExpenses) }}</span>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-row">
              <span>Net Profit</span>
              <span class="val" :class="(selectedMonthEarnings.netProfit || 0) >= 0 ? 'accent' : 'danger'">{{ fmt(selectedMonthEarnings.netProfit) }}</span>
            </div>
            <div class="modal-row split-row">
              <span>&divide; 2 (50/50 split)</span>
              <span></span>
            </div>
            <div class="modal-row bold result">
              <span>Your Take-Home</span>
              <span class="val" :class="(selectedMonthEarnings.investorEarnings || 0) >= 0 ? 'accent' : 'danger'">{{ fmt(selectedMonthEarnings.investorEarnings) }}</span>
            </div>
          </template>

          <div v-if="comparisons.length" class="step-label" style="margin-top:1rem;">In Context</div>
          <div v-for="cmp in comparisons" :key="cmp.label" class="modal-row">
            <span>{{ cmp.label }}</span>
            <span class="val">{{ cmp.value }}</span>
          </div>

          <div v-if="selectedMonth.amount === 0 && selectedMonth.isCurrent" class="modal-callout info">
            This month hasn't recorded any completed loads yet. The bar will grow as deliveries come in.
          </div>
        </div>
      </template>
    </MetricInfoDialog>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { formatCurrency as fmt } from '../../utils/format'
import MetricInfoDialog from './MetricInfoDialog.vue'

const props = defineProps({
  production: { type: Object, required: true },
  config: { type: Object, default: null },
})

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const MONTH_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December']

const months = computed(() => props.production.monthlyData || [])
const monthlyEarnings = computed(() => props.production.monthlyEarnings || [])

// Build 12-month view — current month centered (6 before + current + 5 after)
const chartMonths = computed(() => {
  const now = new Date()
  const dataMap = {}
  months.value.forEach(m => { dataMap[m.month] = m.amount })
  const result = []
  for (let i = -6; i <= 5; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    const isCurrent = i === 0
    result.push({ key, label: MONTH_SHORT[d.getMonth()], amount: dataMap[key] || 0, isCurrent })
  }
  return result
})

const maxAmount = computed(() =>
  Math.max(...chartMonths.value.map(m => m.amount), 1)
)

function barHeight(amount) {
  return (amount / maxAmount.value) * 100 + '%'
}

function monthFullLabel(key) {
  if (!key) return ''
  const [y, m] = key.split('-')
  return `${MONTH_FULL[parseInt(m) - 1] || m} ${y}`
}

// --- Detail modal ---
const selectedMonth = ref(null)
function openMonthDetail(m) {
  selectedMonth.value = m
}

const selectedMonthEarnings = computed(() => {
  if (!selectedMonth.value) return null
  return monthlyEarnings.value.find(me => me.month === selectedMonth.value.key) || null
})

const comparisons = computed(() => {
  if (!selectedMonth.value) return []
  const list = []
  const allAmounts = months.value.map(m => m.amount).filter(v => v > 0)
  if (allAmounts.length === 0) return []
  const avg = allAmounts.reduce((s, v) => s + v, 0) / allAmounts.length
  const best = Math.max(...allAmounts)
  const cur = selectedMonth.value.amount
  if (avg > 0) {
    const diff = cur - avg
    const pct = (diff / avg) * 100
    list.push({
      label: 'vs Monthly Average',
      value: `${fmt(avg)} (${diff >= 0 ? '+' : ''}${pct.toFixed(1)}%)`,
    })
  }
  if (best > 0) {
    list.push({
      label: 'vs Best Month',
      value: cur >= best ? 'This is the best month' : `${fmt(best)} (${(((cur - best) / best) * 100).toFixed(1)}%)`,
    })
  }
  return list
})

const modalTitle = computed(() => {
  if (!selectedMonth.value) return ''
  return `Revenue: ${monthFullLabel(selectedMonth.value.key)}`
})
const modalSubtitle = computed(() => {
  if (!selectedMonth.value) return ''
  if (selectedMonth.value.amount === 0) return 'No completed loads in this month yet'
  return 'Breakdown for this month’s revenue'
})
</script>

<style scoped>
.section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
  display: flex;
  flex-direction: column;
}
.chart-bars { flex: 1; }

.section-title {
  font-size: 0.95rem;
  font-weight: 700;
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.section-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
}

.chart-bars {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 180px;
  padding-top: 1rem;
  border-bottom: 1px solid var(--border);
}

.chart-bar-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  justify-content: flex-end;
  min-width: 40px;
  border-radius: 4px;
  padding: 2px;
  margin: -2px;
  transition: background 0.15s ease;
}
.chart-bar-wrap.clickable { cursor: pointer; }
.chart-bar-wrap.clickable:hover { background: var(--accent-dim); }
.chart-bar-wrap.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.chart-bar {
  width: 100%;
  max-width: 56px;
  background: linear-gradient(180deg, var(--accent), #0ea5e9);
  border-radius: 6px 6px 0 0;
  min-height: 4px;
  transition: height 0.3s, opacity 0.15s;
}
.chart-bar-wrap.clickable:hover .chart-bar { opacity: 0.85; }
.chart-bar.empty { background: var(--bg); }
.chart-bar.bar-current { background: linear-gradient(180deg, #10b981, #059669); }
.chart-bar-wrap.current { position: relative; }
.label-current { font-weight: 700; color: var(--accent); }

.chart-label {
  font-size: 0.7rem;
  color: var(--text-dim);
  margin-top: 0.4rem;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 500;
}

.chart-amount {
  font-size: 0.72rem;
  color: var(--text);
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  margin-bottom: 0.3rem;
}

.chart-caption {
  text-align: center;
  margin-top: 0.5rem;
  font-size: 0.78rem;
  color: var(--text-dim);
  font-weight: 500;
}
.caption-hint {
  font-style: italic;
  font-weight: 400;
  opacity: 0.8;
}
</style>
