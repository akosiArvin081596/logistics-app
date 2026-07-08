<template>
  <div class="exp-card">
    <div class="exp-card-head">
      <div class="exp-card-titles">
        <h3 class="exp-card-title">Top Vendors</h3>
        <div class="exp-card-sub">Top {{ Math.min(10, ranked.length) || 10 }} by {{ activeMetric.label.toLowerCase() }} &mdash; click a vendor to drill in</div>
      </div>
      <!-- Metric toggle swaps the ranking basis; identity stays the row label,
           so every bar keeps the one sequential hue (never per-row colors). -->
      <div class="seg" role="group" aria-label="Rank vendors by">
        <button
          v-for="m in METRICS"
          :key="m.key"
          type="button"
          class="seg-btn"
          :class="{ active: metric === m.key }"
          :aria-pressed="metric === m.key ? 'true' : 'false'"
          @click="metric = m.key"
        >{{ m.label }}</button>
      </div>
    </div>

    <div v-if="!ranked.length" class="exp-empty">
      No vendor data yet &mdash; vendors appear as receipts are scanned or the backfill runs.
    </div>

    <div v-else class="vbar-list">
      <button
        v-for="v in ranked"
        :key="v.vendor"
        type="button"
        class="vbar-row"
        :title="rowTitle(v)"
        :aria-label="`Filter analytics by ${v.vendor}. ${rowTitle(v)}`"
        @click="$emit('select-vendor', v.vendor)"
      >
        <span class="vbar-label">
          <span class="vbar-name">{{ v.vendor }}</span>
          <span class="vbar-val">{{ fmtVal(v) }}</span>
        </span>
        <span class="vbar-track">
          <span class="vbar-fill" :style="{ width: barPct(v) + '%' }"></span>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup>
// Ranked single-series bar list (FinancialsView .bar-track/.bar-fill pattern).
// Vendors are nominal categories, not expense types, so every bar wears the
// single SEQUENTIAL_HUE — bar length does the comparing, labels do the naming.
import { ref, computed } from 'vue'
import { formatCurrency } from '../../../utils/format'
import { SEQUENTIAL_HUE } from './typeColors'

const props = defineProps({
  // Rows: { vendor, visits, spend, gallons, avgPerGallon, states[], lastDate }
  vendors: { type: Array, default: () => [] },
})

defineEmits(['select-vendor'])

// Default Visits: the owner's question is "which gas station do we frequent
// the MOST", so frequency leads and spend/gallons are one tap away.
const METRICS = [
  { key: 'visits', label: 'Visits' },
  { key: 'spend', label: 'Spend' },
  { key: 'gallons', label: 'Gallons' },
]
const metric = ref('visits')
const activeMetric = computed(() => METRICS.find((m) => m.key === metric.value) || METRICS[0])

function num(v) {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

const ranked = computed(() =>
  [...(props.vendors || [])]
    .filter((v) => v && v.vendor)
    .sort((a, b) => num(b[metric.value]) - num(a[metric.value]))
    .slice(0, 10)
)

const maxVal = computed(() => Math.max(...ranked.value.map((v) => num(v[metric.value])), 1))

function barPct(v) {
  return (num(v[metric.value]) / maxVal.value) * 100
}

function fmtGal(g) {
  return num(g).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

function fmtVal(v) {
  if (metric.value === 'spend') return formatCurrency(v.spend)
  if (metric.value === 'gallons') return num(v.gallons) > 0 ? fmtGal(v.gallons) : '—'
  return num(v.visits).toLocaleString('en-US')
}

// Hover / title carries all three metrics regardless of the active toggle.
function rowTitle(v) {
  const parts = [
    `${num(v.visits).toLocaleString('en-US')} visit${num(v.visits) === 1 ? '' : 's'}`,
    formatCurrency(v.spend),
    `${fmtGal(v.gallons)} gal`,
  ]
  if (num(v.avgPerGallon) > 0) parts.push(`$${num(v.avgPerGallon).toFixed(2)}/gal`)
  return parts.join(' · ')
}
</script>

<style scoped>
.exp-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem 1.1rem;
  min-width: 0;
}
.exp-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.85rem;
}
.exp-card-titles { min-width: 0; }
.exp-card-title {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--text);
}
.exp-card-sub {
  font-size: 0.7rem;
  color: var(--text-dim);
  margin-top: 2px;
}
.exp-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.8rem;
  line-height: 1.5;
  padding: 1.75rem 1rem;
}

/* Segmented metric toggle */
.seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.seg-btn {
  padding: 0.25rem 0.6rem;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-family: inherit;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.seg-btn:hover { color: var(--text); }
.seg-btn.active {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

/* Bar list */
.vbar-list {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.vbar-row {
  display: block;
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.vbar-label {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.75rem;
  font-size: 0.76rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 0.25rem;
}
.vbar-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.15s;
}
.vbar-row:hover .vbar-name,
.vbar-row:focus-visible .vbar-name { color: var(--accent); }
.vbar-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
/* Values stay in text ink (mono), never the series color. */
.vbar-val {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  color: var(--text);
  flex-shrink: 0;
}
.vbar-track {
  display: block;
  height: 10px;
  background: var(--bg);
  border-radius: 4px;
  overflow: hidden;
}
.vbar-fill {
  display: block;
  height: 100%;
  background: v-bind(SEQUENTIAL_HUE);
  /* Rounded data-end, square at the baseline (left edge). */
  border-radius: 0 4px 4px 0;
  transition: width 0.4s ease;
}
.vbar-row:hover .vbar-fill { filter: brightness(1.12); }
</style>
