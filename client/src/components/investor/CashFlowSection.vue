<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#128176;</div>
      Cash Flow &amp; Projections
    </div>

    <div class="kpi-grid">
      <div
        class="kpi-card accent clickable"
        role="button" tabindex="0"
        aria-label="Open Net Cash Flow breakdown"
        title="Click for breakdown"
        @click="openDetail('netCashFlow')"
        @keyup.enter="openDetail('netCashFlow')"
        @keyup.space.prevent="openDetail('netCashFlow')"
      >
        <div class="kpi-label">Net Cash Flow</div>
        <div class="kpi-value">{{ fmt(netCashFlow) }}</div>
        <div class="kpi-sub">revenue minus expenses</div>
        <div class="kpi-formula">= totalRevenue - totalExpenses</div>
      </div>
      <div
        class="kpi-card blue clickable"
        role="button" tabindex="0"
        aria-label="Open Your Earnings to date breakdown"
        title="Click for breakdown"
        @click="openDetail('investorNetToDate')"
        @keyup.enter="openDetail('investorNetToDate')"
        @keyup.space.prevent="openDetail('investorNetToDate')"
      >
        <div class="kpi-label">Your Earnings (to date)</div>
        <div class="kpi-value">{{ fmt(investorNetToDate) }}</div>
        <div class="kpi-sub">cumulative take-home</div>
        <div class="kpi-formula">= sum(monthly investor earnings)</div>
      </div>
      <div
        class="kpi-card clickable"
        role="button" tabindex="0"
        aria-label="Open Break-Even breakdown"
        title="Click for breakdown"
        @click="openDetail('breakEven')"
        @keyup.enter="openDetail('breakEven')"
        @keyup.space.prevent="openDetail('breakEven')"
      >
        <div class="kpi-label">Break-Even</div>
        <div class="kpi-value">{{ typeof breakEvenMonths === 'number' ? `${breakEvenMonths} mo` : 'N/A' }}</div>
        <div v-if="breakEvenDate" class="kpi-sub">est. {{ breakEvenDate }}</div>
        <div v-else class="kpi-sub">need more data</div>
        <div class="kpi-formula">= purchasePrice / avg monthly take-home</div>
      </div>
      <div
        class="kpi-card clickable"
        :class="roiPct >= 0 ? 'accent' : 'danger'"
        role="button" tabindex="0"
        aria-label="Open Your ROI breakdown"
        title="Click for breakdown"
        @click="openDetail('roi')"
        @keyup.enter="openDetail('roi')"
        @keyup.space.prevent="openDetail('roi')"
      >
        <div class="kpi-label">Your ROI</div>
        <div class="kpi-value">{{ roiPct.toFixed(1) }}%</div>
        <div class="kpi-sub">take-home vs investment</div>
        <div class="kpi-formula">= (est annual take-home / purchasePrice) × 100</div>
      </div>
    </div>

    <!-- Cash flow timeline -->
    <div
      class="timeline clickable"
      role="button" tabindex="0"
      aria-label="Open Truck Payoff Timeline explanation"
      title="Click for explanation"
      @click="openDetail('payoff')"
      @keyup.enter="openDetail('payoff')"
      @keyup.space.prevent="openDetail('payoff')"
    >
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
      <div class="timeline-note">
        Shows how much of your {{ truckWord }} total purchase price ({{ fmt(totalPurchasePrice) }}) has been recovered through your cumulative take-home earnings ({{ fmt(investorNetToDate) }}).
        At {{ recoveryPct.toFixed(0) }}%, you've earned back {{ fmt(investorNetToDate) }} of {{ fmt(totalPurchasePrice) }}.
        {{ recoveryPct >= 100 ? 'Your fleet has paid for itself!' : 'When the bar reaches 100%, your fleet has paid for itself.' }}
      </div>
    </div>

    <!-- Detail modal -->
    <MetricInfoDialog
      :open="!!detailType"
      :title="modalTitle"
      :subtitle="modalSubtitle"
      @update:open="v => { if (!v) detailType = '' }"
    >
      <!-- Net Cash Flow -->
      <template v-if="detailType === 'netCashFlow'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            Net Cash Flow is the bottom-line number at the fleet level &mdash; total revenue minus every dollar spent on operating the fleet. This is calculated <strong>before</strong> the 50/50 investor/LogisX split.
          </div>
          <div class="step-label">The Calculation</div>
          <div class="modal-row highlight">
            <span>Total Revenue</span>
            <span class="val accent">{{ fmt(totalRevenue) }}</span>
          </div>
          <div class="modal-row deduct">
            <span>- Total Expenses</span>
            <span class="val danger">-{{ fmt(totalExpenses) }}</span>
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Net Cash Flow</span>
            <span class="val" :class="netCashFlow >= 0 ? 'accent' : 'danger'">{{ fmt(netCashFlow) }}</span>
          </div>
          <div class="modal-math">{{ fmt(totalRevenue) }} - {{ fmt(totalExpenses) }} = {{ fmt(netCashFlow) }}</div>
          <div class="modal-callout info">
            Your share is roughly half of this number after each month is split. See "Your Earnings (to date)" for the cumulative investor figure.
          </div>
        </div>
      </template>

      <!-- Investor Net To Date -->
      <template v-if="detailType === 'investorNetToDate'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            This is the cumulative take-home you have earned across every month since the truck started operating. It is the sum of each month's investor share (after driver pay, fixed costs, and trip expenses, divided by 2).
          </div>
          <template v-if="monthlyEarnings.length">
            <div class="step-label">Month-by-Month History</div>
            <div class="modal-monthly-list">
              <div v-for="m in monthlyEarnings" :key="m.month" class="modal-row">
                <span>{{ monthLabel(m.month) }}{{ m.isCurrentMonth ? ' *' : '' }}</span>
                <span class="val" :class="(m.investorEarnings || 0) >= 0 ? 'accent' : 'danger'">{{ fmt(m.investorEarnings) }}</span>
              </div>
            </div>
          </template>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Your Earnings (to date)</span>
            <span class="val" :class="investorNetToDate >= 0 ? 'accent' : 'danger'">{{ fmt(investorNetToDate) }}</span>
          </div>
        </div>
      </template>

      <!-- Break-Even -->
      <template v-if="detailType === 'breakEven'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            Break-Even is how many months of take-home it will take to fully recover the original purchase price of your {{ truckWord }}. After that point, every additional dollar is pure profit on your investment.
          </div>
          <div class="step-label">The Calculation</div>
          <div class="modal-row">
            <span>Purchase Price</span>
            <span class="val">{{ fmt(totalPurchasePrice) }}</span>
          </div>
          <div class="modal-row deduct">
            <span>&divide; Avg Monthly Take-Home (trailing 3 mo)</span>
            <span class="val accent">{{ fmt(trailing3MonthInvestor) }}</span>
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Break-Even</span>
            <span class="val accent">{{ typeof breakEvenMonths === 'number' ? `${breakEvenMonths} months` : 'N/A' }}</span>
          </div>
          <div v-if="breakEvenDate" class="modal-math">Est. paid off by {{ breakEvenDate }}</div>
          <div class="modal-callout info">
            We use the trailing 3-month average to smooth out one-off slow months. As that average changes, this estimate updates with it.
          </div>
        </div>
      </template>

      <!-- ROI -->
      <template v-if="detailType === 'roi'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            Return on Investment shows how much of your original outlay you would earn back in a year, expressed as a percentage. A 20% ROI means in twelve months you would recover 20% of the purchase price as take-home.
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
          <div class="modal-row">
            <span>Est. Annual Take-Home</span>
            <span class="val accent">{{ fmt(trailing3MonthInvestor * 12) }}</span>
          </div>
          <div class="modal-row deduct">
            <span>&divide; Purchase Price</span>
            <span class="val">{{ fmt(totalPurchasePrice) }}</span>
          </div>
          <div class="modal-row split-row">
            <span>&times; 100 (percent)</span>
            <span></span>
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>Your ROI</span>
            <span class="val" :class="roiPct >= 0 ? 'accent' : 'danger'">{{ roiPct.toFixed(1) }}%</span>
          </div>
          <div class="modal-callout info">
            ROI is a forward-looking estimate. Actual results depend on freight rates, fuel costs, and maintenance over the next 12 months.
          </div>
        </div>
      </template>

      <!-- Truck Payoff Timeline -->
      <template v-if="detailType === 'payoff'">
        <div class="modal-breakdown">
          <div class="modal-explain">
            The Truck Payoff bar shows how much of your original investment you've recovered through your cumulative take-home so far. It is a real-money progress meter, not a projection.
          </div>
          <div class="step-label">Where You Are Today</div>
          <div class="modal-row highlight">
            <span>Cumulative Take-Home</span>
            <span class="val accent">{{ fmt(investorNetToDate) }}</span>
          </div>
          <div class="modal-row deduct">
            <span>&divide; Purchase Price</span>
            <span class="val">{{ fmt(totalPurchasePrice) }}</span>
          </div>
          <div class="modal-divider"></div>
          <div class="modal-row bold result">
            <span>% Recovered</span>
            <span class="val" :class="recoveryPct >= 100 ? 'accent' : ''">{{ recoveryPct.toFixed(0) }}%</span>
          </div>
          <div class="modal-math">{{ fmt(investorNetToDate) }} / {{ fmt(totalPurchasePrice) }} &times; 100 = {{ recoveryPct.toFixed(0) }}%</div>
          <div class="modal-callout" :class="recoveryPct >= 100 ? 'info' : 'warning'">
            {{ recoveryPct >= 100
              ? 'Your fleet has fully paid for itself. Every dollar of take-home from here is pure return on investment.'
              : `Once your cumulative take-home reaches ${fmt(totalPurchasePrice)}, the truck has fully paid for itself.` }}
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
  production: { type: Object, default: () => ({}) },
  asset: { type: Object, default: () => ({}) },
  config: { type: Object, default: null },
})

const totalRevenue = computed(() => props.production?.totalRevenue || 0)
const totalExpenses = computed(() => props.production?.totalExpenses || 0)
const totalPurchasePrice = computed(() => props.production?.totalPurchasePrice || 0)
const investorNetToDate = computed(() => props.production?.investorNetToDate || 0)
const trailing3MonthInvestor = computed(() => props.production?.trailing3MonthInvestor || 0)
const monthlyEarnings = computed(() => props.production?.monthlyEarnings || [])

const netCashFlow = computed(() => totalRevenue.value - totalExpenses.value)

const recoveryPct = computed(() => {
  if (totalPurchasePrice.value <= 0) return 0
  return (investorNetToDate.value / totalPurchasePrice.value) * 100
})

const roiPct = computed(() => {
  if (totalPurchasePrice.value <= 0) return 0
  const estAnnual = trailing3MonthInvestor.value * 12
  return (estAnnual / totalPurchasePrice.value) * 100
})

const truckWord = computed(() => {
  const count = props.production?.totalJobs !== undefined ? (props.asset?.totalTrucks || 1) : 1
  return count === 1 ? "truck's" : `fleet's (${count} trucks)`
})

const breakEvenMonths = computed(() => {
  if (trailing3MonthInvestor.value <= 0) return 'N/A'
  return Math.ceil(totalPurchasePrice.value / trailing3MonthInvestor.value)
})

const breakEvenDate = computed(() => {
  if (typeof breakEvenMonths.value !== 'number') return ''
  const monthsOperated = props.production?.monthsOfOperation || 0
  const monthsRemaining = Math.max(0, breakEvenMonths.value - monthsOperated)
  const d = new Date()
  d.setMonth(d.getMonth() + monthsRemaining)
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
})

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function monthLabel(mk) {
  if (!mk) return ''
  const [y, m] = mk.split('-')
  return `${MONTH_NAMES[parseInt(m) - 1] || m} ${y}`
}

// --- Detail modal ---
const detailType = ref('')
function openDetail(type) { detailType.value = type }

const MODAL_CONFIG = {
  netCashFlow: { title: 'Net Cash Flow', subtitle: 'Fleet-level revenue minus expenses (pre-split)' },
  investorNetToDate: { title: 'Your Earnings to Date', subtitle: 'Cumulative take-home, summed across every month' },
  breakEven: { title: 'Break-Even', subtitle: 'When the truck pays for itself' },
  roi: { title: 'Your ROI', subtitle: 'Annual take-home as a percentage of investment' },
  payoff: { title: 'Truck Payoff Timeline', subtitle: 'How much of your investment is already recovered' },
}

const modalTitle = computed(() => MODAL_CONFIG[detailType.value]?.title || '')
const modalSubtitle = computed(() => MODAL_CONFIG[detailType.value]?.subtitle || '')
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
.kpi-value { font-family: 'JetBrains Mono', monospace; font-size: 1.5rem; font-weight: 700; }
.kpi-sub { font-size: 0.72rem; color: var(--text-dim); margin-top: 0.2rem; }
.kpi-formula { font-size: 0.58rem; font-family: 'JetBrains Mono', monospace; color: var(--text-dim); opacity: 0.5; font-style: italic; margin-top: 0.15rem; }

.timeline { margin-top: 0.5rem; border-radius: 8px; padding: 0.4rem; margin-left: -0.4rem; margin-right: -0.4rem; }
.timeline.clickable { cursor: pointer; transition: all 0.15s ease; }
.timeline.clickable:hover { background: var(--accent-dim); }
.timeline.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
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
.timeline-note {
  font-size: 0.72rem; color: var(--text-dim); font-style: italic;
  margin-top: 0.75rem; line-height: 1.5;
}
</style>
