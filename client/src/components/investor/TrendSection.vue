<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--blue-dim); color: var(--blue);">&#128200;</div>
      Revenue Trends
    </div>

    <div class="kpi-grid">
      <div
        class="kpi-card clickable"
        :class="momGrowth >= 0 ? 'accent' : 'danger'"
        role="button" tabindex="0"
        aria-label="Open Month-over-Month breakdown"
        title="Click for breakdown"
        @click="openDetail('momGrowth')"
        @keyup.enter="openDetail('momGrowth')"
        @keyup.space.prevent="openDetail('momGrowth')"
      >
        <div class="kpi-label">Month-over-Month</div>
        <div class="kpi-value">{{ momGrowth >= 0 ? '+' : '' }}{{ momGrowth.toFixed(1) }}%</div>
        <div class="kpi-sub">{{ momGrowth >= 0 ? 'Growth' : 'Decline' }} vs prior month</div>
        <div class="kpi-formula">= (curMonth - prevMonth) / prevMonth * 100</div>
      </div>
      <div
        class="kpi-card blue clickable"
        role="button" tabindex="0"
        aria-label="Open Best Month breakdown"
        title="Click for breakdown"
        @click="openDetail('bestMonth')"
        @keyup.enter="openDetail('bestMonth')"
        @keyup.space.prevent="openDetail('bestMonth')"
      >
        <div class="kpi-label">Best Month</div>
        <div class="kpi-value">{{ fmt(bestMonth.amount) }}</div>
        <div class="kpi-sub">{{ bestMonth.label }}</div>
        <div class="kpi-formula">= MAX(monthlyData[].amount)</div>
      </div>
      <div
        class="kpi-card clickable"
        role="button" tabindex="0"
        aria-label="Open Truck Gross per Day breakdown"
        title="Click for breakdown"
        @click="openDetail('avgDailyGross')"
        @keyup.enter="openDetail('avgDailyGross')"
        @keyup.space.prevent="openDetail('avgDailyGross')"
      >
        <div class="kpi-label">Truck Gross / Day</div>
        <div class="kpi-value">{{ fmt(avgDailyGross) }}</div>
        <div class="kpi-sub">what the truck earns per day</div>
        <div class="kpi-formula">= last30DaysRevenue / 30</div>
      </div>
      <div
        class="kpi-card accent clickable"
        role="button" tabindex="0"
        aria-label="Open Your Take-Home per Day breakdown"
        title="Click for breakdown"
        @click="openDetail('avgDailyTakeHome')"
        @keyup.enter="openDetail('avgDailyTakeHome')"
        @keyup.space.prevent="openDetail('avgDailyTakeHome')"
      >
        <div class="kpi-label">Your Take-Home / Day</div>
        <div class="kpi-value">{{ fmt(avgDailyTakeHome) }}</div>
        <div class="kpi-sub">your 50% share per day</div>
        <div class="kpi-formula">= trailing 3mo take-home / days</div>
      </div>
      <div
        class="kpi-card clickable"
        role="button" tabindex="0"
        aria-label="Open Average Monthly Revenue breakdown"
        title="Click for breakdown"
        @click="openDetail('avgMonthly')"
        @keyup.enter="openDetail('avgMonthly')"
        @keyup.space.prevent="openDetail('avgMonthly')"
      >
        <div class="kpi-label">Avg Monthly Revenue</div>
        <div class="kpi-value">{{ fmt(avgMonthly) }}</div>
        <div class="kpi-sub">gross across {{ months.length }} months</div>
        <div class="kpi-formula">= SUM(monthlyData) / months.length</div>
      </div>
      <div
        class="kpi-card accent clickable"
        role="button" tabindex="0"
        aria-label="Open Projected Annual Take-Home breakdown"
        title="Click for breakdown"
        @click="openDetail('projectedAnnualTakeHome')"
        @keyup.enter="openDetail('projectedAnnualTakeHome')"
        @keyup.space.prevent="openDetail('projectedAnnualTakeHome')"
      >
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

    <!-- Detail modal -->
    <MetricInfoDialog
      :open="!!detailType"
      :title="modalTitle"
      :subtitle="modalSubtitle"
      @update:open="v => { if (!v) detailType = '' }"
    >
      <!-- Month-over-Month Growth -->
      <template v-if="detailType === 'momGrowth'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            Month-over-Month (MoM) shows how this month's revenue compares to last month's. A positive number means revenue grew; negative means it fell.
          </div>
          <template v-if="months.length >= 2">
            <div class="step-label">The Two Months</div>
            <div class="modal-row">
              <span>{{ shortMonth(months[months.length - 2].month) }} (prior)</span>
              <span class="val">{{ fmt(months[months.length - 2].amount) }}</span>
            </div>
            <div class="modal-row highlight">
              <span>{{ shortMonth(months[months.length - 1].month) }} (current)</span>
              <span class="val accent">{{ fmt(months[months.length - 1].amount) }}</span>
            </div>
            <div class="step-label">The Calculation</div>
            <div class="modal-math">
              ({{ fmt(months[months.length - 1].amount) }} - {{ fmt(months[months.length - 2].amount) }}) / {{ fmt(months[months.length - 2].amount) }} &times; 100
            </div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Month-over-Month</span>
              <span class="val" :class="momGrowth >= 0 ? 'accent' : 'danger'">{{ momGrowth >= 0 ? '+' : '' }}{{ momGrowth.toFixed(1) }}%</span>
            </div>
          </template>
          <div v-else class="modal-callout warning">
            Need at least 2 months of data to compute month-over-month growth. Currently have {{ months.length }} month{{ months.length === 1 ? '' : 's' }}.
          </div>
        </div>
      </template>

      <!-- Best Month -->
      <template v-if="detailType === 'bestMonth'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            Your strongest revenue month to date. This is the single month where your truck(s) earned the most across all completed loads.
          </div>
          <template v-if="topMonths.length">
            <div class="step-label">Top {{ topMonths.length }} Months</div>
            <div v-for="(m, i) in topMonths" :key="m.month" class="modal-row" :class="{ highlight: i === 0 }">
              <span>{{ i + 1 }}. {{ shortMonth(m.month) }}</span>
              <span class="val" :class="i === 0 ? 'accent' : ''">{{ fmt(m.amount) }}</span>
            </div>
            <div class="modal-divider"></div>
            <div class="modal-row bold result">
              <span>Best Month</span>
              <span class="val accent">{{ fmt(bestMonth.amount) }} &middot; {{ bestMonth.label }}</span>
            </div>
          </template>
          <div v-else class="modal-explain-sm" style="font-style:italic;">No revenue data yet.</div>
        </div>
      </template>

      <!-- Truck Gross per Day -->
      <template v-if="detailType === 'avgDailyGross'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            This is the truck's gross revenue averaged across the last 30 days. It tells you how much money the truck is generating per calendar day, regardless of whether it's actively driving.
          </div>
          <div class="step-label">The Calculation</div>
          <div class="modal-explain-sm">
            Sum of revenue from loads completed in the last 30 days, divided by 30.
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Truck Gross / Day</span>
            <span class="val accent">{{ fmt(avgDailyGross) }}</span>
          </div>
          <div class="modal-callout info">
            This is the truck's gross figure &mdash; before driver pay, fixed costs, or trip expenses. Your take-home is roughly half of net, not half of this number.
          </div>
        </div>
      </template>

      <!-- Your Take-Home per Day -->
      <template v-if="detailType === 'avgDailyTakeHome'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            This is your investor share (50% of net profit) averaged into a per-day figure. It uses the trailing 3 months of actual take-home and divides it across the number of days.
          </div>
          <div class="step-label">The Calculation</div>
          <div class="modal-explain-sm">
            Take the last 3 months of your share (after driver pay, fixed costs, and trip expenses are deducted, then divided by 2 for the 50/50 split), and spread that across the days in those months.
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Your Take-Home / Day</span>
            <span class="val accent">{{ fmt(avgDailyTakeHome) }}</span>
          </div>
          <div class="modal-callout info">
            This is a smoothed average. Slow weeks pull it down; back-to-back high-rate loads pull it up. Use it as a stable benchmark, not a daily target.
          </div>
        </div>
      </template>

      <!-- Average Monthly Revenue -->
      <template v-if="detailType === 'avgMonthly'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            Average gross revenue per month, across every month with data. This includes the current (in-progress) month, so the average will rise as the month finishes.
          </div>
          <template v-if="months.length">
            <div class="step-label">Monthly Revenue History</div>
            <div class="modal-monthly-list">
              <div v-for="m in months" :key="m.month" class="modal-row">
                <span>{{ shortMonth(m.month) }}</span>
                <span class="val">{{ fmt(m.amount) }}</span>
              </div>
            </div>
            <div class="modal-math">
              SUM({{ fmt(totalAcrossMonths) }}) / {{ months.length }} months
            </div>
          </template>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Average Monthly Revenue</span>
            <span class="val accent">{{ fmt(avgMonthly) }}</span>
          </div>
        </div>
      </template>

      <!-- Projected Annual Take-Home -->
      <template v-if="detailType === 'projectedAnnualTakeHome'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            A forward-looking estimate of what you would earn over the next 12 months if recent activity continues. Uses the trailing 3-month investor take-home as the basis.
          </div>
          <div class="step-label">The Calculation</div>
          <div class="modal-row">
            <span>Trailing 3-month take-home</span>
            <span class="val accent">{{ fmt(trailing3MonthInvestor) }}</span>
          </div>
          <div class="modal-row split-row">
            <span>&times; 12 (annualize)</span>
            <span></span>
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Projected Annual Take-Home</span>
            <span class="val accent">{{ fmt(projectedAnnualTakeHome) }}</span>
          </div>
          <div class="modal-math">{{ fmt(trailing3MonthInvestor) }} &times; 12 = {{ fmt(projectedAnnualTakeHome) }}</div>
          <div class="modal-callout warning">
            This is a projection, not a guarantee. Freight market swings, maintenance, or a driver change can move this up or down quickly.
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

const topMonths = computed(() => {
  return [...months.value]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3)
})

const avgMonthly = computed(() => {
  if (months.value.length === 0) return 0
  return months.value.reduce((s, m) => s + m.amount, 0) / months.value.length
})

const totalAcrossMonths = computed(() => months.value.reduce((s, m) => s + m.amount, 0))

// Daily averages — two distinct numbers per the 2026-04-12 meeting:
// gross (what the truck earns) vs take-home (what the investor pockets).
const avgDailyGross = computed(() => props.production?.avgDailyRevenue || 0)
const avgDailyTakeHome = computed(() => props.production?.avgDailyInvestorEarnings || 0)
const trailing3MonthInvestor = computed(() => props.production?.trailing3MonthInvestor || 0)
// Projected annual take-home uses the trailing 3-month investor average × 12
// instead of gross × 20 days × 12, so the projection reflects what the
// investor actually pockets, not topline revenue.
const projectedAnnualTakeHome = computed(() => trailing3MonthInvestor.value * 12)

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

function shortMonth(month) {
  const parts = (month || '').split('-')
  const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return names[parseInt(parts[1])] || parts[1] || month
}

// --- Detail modal ---
const detailType = ref('')
function openDetail(type) { detailType.value = type }

const MODAL_CONFIG = {
  momGrowth: { title: 'Month-over-Month Growth', subtitle: 'How current revenue compares to the prior month' },
  bestMonth: { title: 'Best Month', subtitle: 'Your highest revenue month so far' },
  avgDailyGross: { title: 'Truck Gross per Day', subtitle: 'Gross revenue averaged across the last 30 days' },
  avgDailyTakeHome: { title: 'Your Take-Home per Day', subtitle: 'Your 50% share spread across recent days' },
  avgMonthly: { title: 'Average Monthly Revenue', subtitle: 'Gross revenue averaged across every month with data' },
  projectedAnnualTakeHome: { title: 'Projected Annual Take-Home', subtitle: 'Trailing 3-month take-home extrapolated forward' },
}

const modalTitle = computed(() => MODAL_CONFIG[detailType.value]?.title || '')
const modalSubtitle = computed(() => MODAL_CONFIG[detailType.value]?.subtitle || '')
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
.kpi-card.clickable { cursor: pointer; transition: all 0.15s ease; }
.kpi-card.clickable:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.08); transform: translateY(-1px); }
.kpi-card.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
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
