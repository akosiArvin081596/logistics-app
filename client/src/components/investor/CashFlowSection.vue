<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#128176;</div>
      Cash Flow &amp; Projections
    </div>

    <div class="kpi-grid">
      <div class="kpi-card accent">
        <div class="kpi-label">Net Cash Flow</div>
        <div class="kpi-value">{{ fmt(netCashFlow) }}</div>
        <div class="kpi-sub">revenue minus expenses</div>
        <div class="kpi-formula">= totalRevenue - totalExpenses</div>
      </div>
      <div class="kpi-card blue">
        <div class="kpi-label">Owner Earnings (Est.)</div>
        <div class="kpi-value">{{ fmt(investorPayout) }}</div>
        <div class="kpi-sub">at {{ splitPct }}% owner take</div>
        <div class="kpi-formula">= netCashFlow * {{ splitPct }} / 100</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Break-Even</div>
        <div class="kpi-value">{{ breakEvenMonths }} mo</div>
        <div class="kpi-sub">est. {{ breakEvenDate }}</div>
        <div class="kpi-formula">= purchasePrice / monthlyNetCashFlow</div>
      </div>
      <div class="kpi-card" :class="roiPct >= 0 ? 'accent' : 'danger'">
        <div class="kpi-label">Business ROI</div>
        <div class="kpi-value">{{ roiPct.toFixed(1) }}%</div>
        <div class="kpi-sub">total to date</div>
        <div class="kpi-formula">= netRevenueToDate / purchasePrice * 100</div>
      </div>
    </div>

    <!-- Cash flow timeline -->
    <div class="timeline">
      <div class="timeline-title">Truck Payoff Timeline</div>
      <div class="progress-track">
        <div class="progress-fill" :style="{ width: Math.min(recoveryPct, 100) + '%' }"></div>
        <span class="progress-label">{{ recoveryPct.toFixed(0) }}% recovered</span>
      </div>
      <div class="timeline-markers">
        <span>$0</span>
        <span>{{ fmt(totalPurchasePrice / 2) }}</span>
        <span>{{ fmt(totalPurchasePrice) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  production: { type: Object, default: () => ({}) },
  asset: { type: Object, default: () => ({}) },
  config: { type: Object, default: null },
})

const totalRevenue = computed(() => props.production?.totalRevenue || 0)
const totalExpenses = computed(() => props.production?.totalExpenses || 0)
const netRevenueToDate = computed(() => props.production?.netRevenueToDate || 0)
const totalPurchasePrice = computed(() => props.production?.totalPurchasePrice || 0)
const totalStartupExpenses = computed(() => props.production?.totalStartupExpenses || 0)
const avgMonthlyOwnerEarnings = computed(() => props.production?.avgMonthlyOwnerEarnings || 0)

// Total investment = purchase price + startup costs
const totalInvestment = computed(() => totalPurchasePrice.value + totalStartupExpenses.value)

// Net Cash Flow = revenue - actual expenses from server
const netCashFlow = computed(() => totalRevenue.value - totalExpenses.value)

// Owner Earnings = from config split %
const splitPct = computed(() => props.production?.investorSplitPct || 50)
const investorPayout = computed(() => netCashFlow.value * (splitPct.value / 100))

// Payoff progress = net revenue recovered / purchase price
const recoveryPct = computed(() => {
  if (totalPurchasePrice.value <= 0) return 0
  return (netRevenueToDate.value / totalPurchasePrice.value) * 100
})

// Business ROI = net profit / investment cost * 100
const roiPct = computed(() => {
  if (totalPurchasePrice.value <= 0) return 0
  return (netRevenueToDate.value / totalPurchasePrice.value) * 100
})

// Break-even = purchase price / monthly net cash flow
const monthlyNetCashFlow = computed(() => {
  const months = props.production?.monthsOfOperation || 1
  return netCashFlow.value / months
})
const breakEvenMonths = computed(() => {
  if (monthlyNetCashFlow.value <= 0) return 'N/A'
  return Math.ceil(totalPurchasePrice.value / monthlyNetCashFlow.value)
})

const breakEvenDate = computed(() => {
  if (typeof breakEvenMonths.value !== 'number') return ''
  const d = new Date()
  d.setMonth(d.getMonth() + breakEvenMonths.value)
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
})

function fmt(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
}
</script>

<style scoped>
.section {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.25rem; margin-bottom: 1.25rem;
}
.section-title {
  font-size: 0.95rem; font-weight: 700; margin-bottom: 1rem;
  display: flex; align-items: center; gap: 0.5rem;
}
.section-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; font-size: 0.9rem;
}
.kpi-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem; margin-bottom: 1.25rem;
}
.kpi-card {
  padding: 1rem; border: 1px solid var(--border);
  border-radius: var(--radius); text-align: center;
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 0.3rem;
}
.kpi-card.accent { border-color: var(--accent); }
.kpi-card.accent .kpi-value { color: var(--accent); }
.kpi-card.blue { border-color: var(--blue); }
.kpi-card.blue .kpi-value { color: var(--blue); }
.kpi-card.danger { border-color: var(--danger); }
.kpi-card.danger .kpi-value { color: var(--danger); }
.kpi-label {
  font-size: 0.72rem; font-weight: 600; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.4rem;
}
.kpi-value { font-family: 'JetBrains Mono', monospace; font-size: 1.5rem; font-weight: 700; }
.kpi-sub { font-size: 0.72rem; color: var(--text-dim); margin-top: 0.2rem; }
.kpi-formula { font-size: 0.58rem; font-family: 'JetBrains Mono', monospace; color: var(--text-dim); opacity: 0.5; font-style: italic; margin-top: 0.15rem; }

.timeline { margin-top: 0.5rem; }
.timeline-title {
  font-size: 0.72rem; font-weight: 600; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.5rem;
}
.progress-track {
  height: 28px; background: var(--bg); border-radius: 14px;
  position: relative; overflow: hidden;
}
.progress-fill {
  height: 100%; background: var(--accent); border-radius: 14px;
  transition: width 0.5s ease;
}
.progress-label {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.72rem; font-weight: 700; color: var(--text);
  font-family: 'JetBrains Mono', monospace;
}
.timeline-markers {
  display: flex; justify-content: space-between; margin-top: 0.3rem;
  font-size: 0.6rem; color: var(--text-dim); font-family: 'JetBrains Mono', monospace;
}
</style>
