<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--blue-dim); color: var(--blue);">&#128200;</div>
      Revenue Trends
    </div>

    <div class="kpi-grid">
      <div class="kpi-card" :class="momGrowth >= 0 ? 'accent' : 'danger'">
        <div class="kpi-label">Month-over-Month</div>
        <div class="kpi-value">{{ momGrowth >= 0 ? '+' : '' }}{{ momGrowth.toFixed(1) }}%</div>
        <div class="kpi-sub">{{ momGrowth >= 0 ? 'Growth' : 'Decline' }} vs prior month</div>
        <div class="kpi-formula">= (curMonth - prevMonth) / prevMonth * 100</div>
      </div>
      <div class="kpi-card blue">
        <div class="kpi-label">Best Month</div>
        <div class="kpi-value">{{ fmt(bestMonth.amount) }}</div>
        <div class="kpi-sub">{{ bestMonth.label }}</div>
        <div class="kpi-formula">= MAX(monthlyData[].amount)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Truck Gross / Day</div>
        <div class="kpi-value">{{ fmt(avgDailyGross) }}</div>
        <div class="kpi-sub">what the truck earns per day</div>
        <div class="kpi-formula">= last30DaysRevenue / 30</div>
      </div>
      <div class="kpi-card accent">
        <div class="kpi-label">Your Take-Home / Day</div>
        <div class="kpi-value">{{ fmt(avgDailyTakeHome) }}</div>
        <div class="kpi-sub">your 50% share per day</div>
        <div class="kpi-formula">= trailing 3mo take-home / days</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Avg Monthly Revenue</div>
        <div class="kpi-value">{{ fmt(avgMonthly) }}</div>
        <div class="kpi-sub">gross across {{ months.length }} months</div>
        <div class="kpi-formula">= SUM(monthlyData) / months.length</div>
      </div>
      <div class="kpi-card accent">
        <div class="kpi-label">Projected Annual Take-Home</div>
        <div class="kpi-value">{{ fmt(projectedAnnualTakeHome) }}</div>
        <div class="kpi-sub">trailing 3mo take-home x 12</div>
        <div class="kpi-formula">= trailing3MonthInvestor * 12</div>
      </div>
    </div>

    <!-- Trend line chart -->
    <div class="trend-chart">
      <div class="trend-line">
        <svg v-if="months.length >= 2" :viewBox="`0 0 ${months.length * 60} 100`" preserveAspectRatio="none" class="trend-svg">
          <polyline :points="trendPoints" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
          <polyline :points="trendPoints" fill="url(#trendGrad)" stroke="none" />
          <defs>
            <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--blue)" stop-opacity="0.15" />
              <stop offset="100%" stop-color="var(--blue)" stop-opacity="0" />
            </linearGradient>
          </defs>
        </svg>
      </div>
      <div class="trend-labels">
        <span v-for="m in months" :key="m.month" class="trend-label">{{ shortMonth(m.month) }}</span>
      </div>
    </div>
    <div class="chart-caption">Revenue Trend</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  production: { type: Object, required: true },
})

const months = computed(() => props.production?.monthlyData || [])

const momGrowth = computed(() => {
  if (months.value.length < 2) return 0
  const curr = months.value[months.value.length - 1].amount
  const prev = months.value[months.value.length - 2].amount
  if (!prev) return 0
  return ((curr - prev) / prev) * 100
})

const bestMonth = computed(() => {
  if (months.value.length === 0) return { amount: 0, label: 'N/A' }
  const best = months.value.reduce((a, b) => a.amount > b.amount ? a : b)
  return { amount: best.amount, label: shortMonth(best.month) }
})

const avgMonthly = computed(() => {
  if (months.value.length === 0) return 0
  return months.value.reduce((s, m) => s + m.amount, 0) / months.value.length
})

// Daily averages — two distinct numbers per the 2026-04-12 meeting:
// gross (what the truck earns) vs take-home (what the investor pockets).
const avgDailyGross = computed(() => props.production?.avgDailyRevenue || 0)
const avgDailyTakeHome = computed(() => props.production?.avgDailyInvestorEarnings || 0)
// Projected annual take-home uses the trailing 3-month investor average × 12
// instead of gross × 20 days × 12, so the projection reflects what the
// investor actually pockets, not topline revenue.
const projectedAnnualTakeHome = computed(() => {
  const trailing = props.production?.trailing3MonthInvestor || 0
  return trailing * 12
})

const trendPoints = computed(() => {
  if (months.value.length < 2) return ''
  const max = Math.max(...months.value.map(m => m.amount), 1)
  const w = months.value.length * 60
  return months.value.map((m, i) => {
    const x = (i / (months.value.length - 1)) * w
    const y = 95 - (m.amount / max) * 85
    return `${x},${y}`
  }).join(' ') + ` ${w},100 0,100`
})

function fmt(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function shortMonth(month) {
  const parts = (month || '').split('-')
  const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return names[parseInt(parts[1])] || parts[1] || month
}
</script>

<style scoped>
.section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  margin-bottom: 1.25rem;
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
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 1rem; margin-bottom: 1rem;
}
@media (max-width: 600px) { .kpi-grid { grid-template-columns: 1fr; } }
.kpi-card {
  padding: 1rem; border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; text-align: center;
  overflow: hidden; min-width: 0; gap: 0.3rem;
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
.kpi-value { font-family: 'JetBrains Mono', monospace; font-size: clamp(1rem, 2.5vw, 1.5rem); font-weight: 700; overflow-wrap: break-word; }
.kpi-sub { font-size: 0.72rem; color: var(--text-dim); margin-top: 0.2rem; overflow-wrap: break-word; }
.kpi-formula { font-size: 0.58rem; font-family: 'JetBrains Mono', monospace; color: var(--text-dim); opacity: 0.5; font-style: italic; margin-top: 0.15rem; }

.trend-chart { margin-top: 0.5rem; }
.trend-line { height: 100px; border-bottom: 1px solid var(--border); }
.trend-svg { width: 100%; height: 100%; }
.trend-labels {
  display: flex; justify-content: space-between; padding-top: 0.3rem;
}
.trend-label {
  font-size: 0.55rem; color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}
.chart-caption {
  text-align: center; margin-top: 0.3rem;
  font-size: 0.65rem; color: var(--text-dim);
}
</style>
