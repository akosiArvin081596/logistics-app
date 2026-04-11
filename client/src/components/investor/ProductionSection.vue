<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#9650;</div>
      Production Performance
    </div>

    <!-- Monthly Revenue Chart -->
    <template v-if="months.length > 0">
      <div class="chart-bars">
        <div v-for="m in months" :key="m.month" class="chart-bar-wrap">
          <div class="chart-amount">{{ fmt(m.amount) }}</div>
          <div class="chart-bar" :style="{ height: barHeight(m.amount) }"></div>
          <div class="chart-label">{{ monthLabel(m.month) }}</div>
        </div>
      </div>
      <div class="chart-caption">Monthly Revenue</div>
    </template>
    <div v-else class="chart-empty">No monthly revenue data yet</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  production: { type: Object, required: true },
  config: { type: Object, default: null },
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
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  overflow: hidden;
  min-width: 0;
  gap: 0.3rem;
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
.kpi-formula {
  font-size: 0.58rem; font-family: 'JetBrains Mono', monospace;
  color: var(--text-dim); opacity: 0.5; font-style: italic; margin-top: 0.15rem;
}

.chart-bars {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 260px;
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
}

.chart-bar {
  width: 100%;
  max-width: 56px;
  background: linear-gradient(180deg, var(--accent), #0ea5e9);
  border-radius: 6px 6px 0 0;
  min-height: 4px;
  transition: height 0.3s;
}
.chart-bar:hover {
  opacity: 0.85;
}

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

.chart-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.82rem;
  padding: 1.5rem 0;
}

.chart-caption {
  text-align: center;
  margin-top: 0.5rem;
  font-size: 0.78rem;
  color: var(--text-dim);
  font-weight: 500;
}
</style>
