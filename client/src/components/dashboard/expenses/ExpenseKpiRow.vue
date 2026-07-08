<template>
  <div class="kpi-row" role="group" aria-label="Expense summary">
    <div v-for="tile in tiles" :key="tile.label" class="metric-card">
      <div class="metric-label">{{ tile.label }}</div>
      <div class="metric-value">{{ tile.value }}</div>
    </div>
  </div>
</template>

<script setup>
// Stat tiles, not charts — the number IS the chart (dataviz: a handful of
// headline numbers = a KPI row of stat tiles, never a grouped bar).
// Card style mirrors ExpensesTab's .metric-card / .metric-label / .metric-value.
import { computed } from 'vue'
import { formatCurrency } from '../../../utils/format'

const props = defineProps({
  summary: { type: Object, default: () => ({}) },
})

// Counts may arrive as numbers or arrays (e.g. a list of vendor names).
function asCount(v) {
  if (Array.isArray(v)) return v.length
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

const totalSpend = computed(() => asCount(props.summary?.totalSpend ?? props.summary?.spend))
const expenseCount = computed(() => asCount(props.summary?.expenseCount ?? props.summary?.count ?? props.summary?.expenses))
const gallons = computed(() => asCount(props.summary?.totalGallons ?? props.summary?.gallons))
const avgPerGallon = computed(() => asCount(props.summary?.avgPerGallon ?? props.summary?.avgCostPerGallon))
// Frozen /api/expenses/analytics contract ships `vendorsCount` / `statesCount`
// (see fixtures.js); older drafts used the singular keys, kept as fallbacks.
const vendorCount = computed(() => asCount(props.summary?.vendorsCount ?? props.summary?.vendorCount ?? props.summary?.vendors))
const stateCount = computed(() => asCount(props.summary?.statesCount ?? props.summary?.stateCount ?? props.summary?.states))

const tiles = computed(() => [
  { label: 'Total Spend', value: formatCurrency(totalSpend.value) },
  { label: 'Expenses', value: expenseCount.value.toLocaleString('en-US') },
  {
    label: 'Gallons',
    value: gallons.value > 0
      ? gallons.value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : '—',
  },
  { label: 'Avg $/gal', value: avgPerGallon.value > 0 ? '$' + avgPerGallon.value.toFixed(2) : '—' },
  { label: 'Vendors', value: vendorCount.value.toLocaleString('en-US') },
  { label: 'States', value: stateCount.value.toLocaleString('en-US') },
])
</script>

<style scoped>
.kpi-row {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 0.75rem;
}
@media (max-width: 1100px) {
  .kpi-row { grid-template-columns: repeat(3, 1fr); }
}
@media (max-width: 640px) {
  .kpi-row { grid-template-columns: repeat(2, 1fr); }
}

.metric-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.85rem 1rem;
  min-width: 0;
}
.metric-label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  margin-bottom: 0.25rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.metric-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--text);
  overflow-wrap: break-word;
}
</style>
