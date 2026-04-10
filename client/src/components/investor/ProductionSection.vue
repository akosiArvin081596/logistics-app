<template>
  <div :class="chartOnly ? '' : 'section'">
    <template v-if="!chartOnly">
      <div class="section-title">
        <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#9650;</div>
        Production Performance
      </div>

      <div class="kpi-grid">
        <div class="kpi-card accent">
          <div class="kpi-label">Avg Daily Revenue</div>
          <div class="kpi-value">{{ fmt(production.avgDailyRevenue) }}</div>
          <div class="kpi-sub">avg last 30 days</div>
        </div>
        <div class="kpi-card accent">
          <div class="kpi-label">Monthly Owner Earnings</div>
          <div class="kpi-value">{{ fmt(production.avgMonthlyOwnerEarnings) }}</div>
          <div class="kpi-sub">avg over {{ production.monthsOfOperation || 0 }} months</div>
        </div>
        <div class="kpi-card blue">
          <div class="kpi-label">Total Revenue</div>
          <div class="kpi-value">{{ fmt(production.totalRevenue) }}</div>
          <div class="kpi-sub">{{ fmt(production.paidRevenue) }} collected</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Completed Loads</div>
          <div class="kpi-value">{{ production.completedJobs }}</div>
          <div class="kpi-sub">of {{ production.totalJobs }} total</div>
        </div>
      </div>
    </template>

    <!-- Monthly Revenue Chart -->
    <div class="chart-bars">
      <template v-if="months.length > 0">
        <div v-for="m in months" :key="m.month" class="chart-bar-wrap">
          <div class="chart-amount">{{ fmt(m.amount) }}</div>
          <div class="chart-bar" :style="{ height: barHeight(m.amount) }"></div>
          <div class="chart-label">{{ monthLabel(m.month) }}</div>
        </div>
      </template>
      <div v-else class="chart-empty">No monthly data yet</div>
    </div>
    <div class="chart-caption">Monthly Revenue</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  production: { type: Object, required: true },
  config: { type: Object, default: null },
  chartOnly: { type: Boolean, default: false },
})

const months = computed(() => props.production.monthlyData || [])

const maxAmount = computed(() =>
  Math.max(...months.value.map((m) => m.amount), 1)
)

function fmt(n) {
  return '$' + Number(n || 0).toLocaleString('en-US')
}

function barHeight(amount) {
  return (amount / maxAmount.value) * 100 + '%'
}

function monthLabel(month) {
  return (month || '').split('-')[1] || month
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

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
  margin-bottom: 1rem;
}
@media (max-width: 600px) { .kpi-grid { grid-template-columns: 1fr; } }

.kpi-card {
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  text-align: center;
  overflow: hidden;
  min-width: 0;
}

.kpi-card.accent {
  border-color: var(--accent);
}
.kpi-card.accent .kpi-value {
  color: var(--accent);
}
.kpi-card.blue {
  border-color: var(--blue);
}
.kpi-card.blue .kpi-value {
  color: var(--blue);
}

.kpi-label {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.4rem;
}

.kpi-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: clamp(1rem, 2.5vw, 1.5rem);
  font-weight: 700;
  overflow-wrap: break-word;
}

.kpi-sub {
  font-size: 0.72rem;
  color: var(--text-dim);
  margin-top: 0.2rem;
  overflow-wrap: break-word;
}

.chart-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 120px;
  padding-top: 0.5rem;
  border-bottom: 1px solid var(--border);
}

.chart-bar-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  justify-content: flex-end;
}

.chart-bar {
  width: 100%;
  max-width: 32px;
  background: var(--accent);
  border-radius: 4px 4px 0 0;
  min-height: 2px;
  transition: height 0.3s;
}

.chart-label {
  font-size: 0.55rem;
  color: var(--text-dim);
  margin-top: 0.3rem;
  font-family: 'JetBrains Mono', monospace;
}

.chart-amount {
  font-size: 0.55rem;
  color: var(--text);
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  margin-bottom: 0.2rem;
}

.chart-empty {
  width: 100%;
  text-align: center;
  color: var(--text-dim);
  font-size: 0.82rem;
  align-self: center;
}

.chart-caption {
  text-align: center;
  margin-top: 0.3rem;
  font-size: 0.65rem;
  color: var(--text-dim);
}
</style>
