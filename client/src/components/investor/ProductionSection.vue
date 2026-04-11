<template>
  <div class="section">
    <div class="section-title">
      <div class="section-icon" style="background: var(--accent-dim); color: var(--accent);">&#9650;</div>
      Production Performance
    </div>

    <!-- Monthly Revenue Chart — always shows 12 months -->
    <div class="chart-bars">
      <div v-for="m in chartMonths" :key="m.key" class="chart-bar-wrap">
        <div class="chart-amount">{{ m.amount > 0 ? fmt(m.amount) : '' }}</div>
        <div class="chart-bar" :class="{ empty: m.amount === 0 }" :style="{ height: m.amount > 0 ? barHeight(m.amount) : '2px' }"></div>
        <div class="chart-label">{{ m.label }}</div>
      </div>
    </div>
    <div class="chart-caption">Monthly Revenue</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  production: { type: Object, required: true },
  config: { type: Object, default: null },
})

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const months = computed(() => props.production.monthlyData || [])

// Build 12-month trailing view — current month + 11 prior, always 12 bars
const chartMonths = computed(() => {
  const now = new Date()
  const dataMap = {}
  months.value.forEach(m => { dataMap[m.month] = m.amount })
  const result = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    result.push({ key, label: MONTH_SHORT[d.getMonth()], amount: dataMap[key] || 0 })
  }
  return result
})

const maxAmount = computed(() =>
  Math.max(...chartMonths.value.map(m => m.amount), 1)
)

function fmt(n) {
  return '$' + Number(n || 0).toLocaleString('en-US')
}

function barHeight(amount) {
  return (amount / maxAmount.value) * 100 + '%'
}
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
}

.chart-bar {
  width: 100%;
  max-width: 56px;
  background: linear-gradient(180deg, var(--accent), #0ea5e9);
  border-radius: 6px 6px 0 0;
  min-height: 4px;
  transition: height 0.3s;
}
.chart-bar:hover { opacity: 0.85; }
.chart-bar.empty { background: var(--bg); }

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
