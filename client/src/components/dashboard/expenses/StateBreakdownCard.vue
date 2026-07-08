<template>
  <div class="exp-card">
    <div class="exp-card-head">
      <div class="exp-card-titles">
        <h3 class="exp-card-title">Spend by State</h3>
        <div class="exp-card-sub">Ranked by spend</div>
      </div>
    </div>

    <div v-if="!sorted.length" class="exp-empty">
      No state data yet &mdash; states appear as receipts are scanned or the backfill runs.
    </div>

    <template v-else>
      <div class="sbar-list">
        <div v-for="s in shown" :key="s.state" class="sbar-row" :title="rowTitle(s)">
          <div class="sbar-label">
            <span class="sbar-name">
              <span class="sbar-code">{{ s.state }}</span>
              <span class="sbar-count" :title="`${fmtCount(s.count)} expense${num(s.count) === 1 ? '' : 's'}`">{{ fmtCount(s.count) }}</span>
            </span>
            <span class="sbar-val">{{ formatCurrency(s.spend) }}</span>
          </div>
          <div class="sbar-track">
            <div class="sbar-fill" :style="{ width: barPct(s) + '%' }"></div>
          </div>
        </div>
      </div>

      <button
        v-if="hiddenCount > 0 || showAll"
        type="button"
        class="sbar-more"
        :aria-expanded="showAll ? 'true' : 'false'"
        @click="showAll = !showAll"
      >
        {{ showAll ? 'Show less' : `＋${hiddenCount} more` }}
      </button>

      <div v-if="num(noStateCount) > 0" class="sbar-footer" role="note">
        {{ fmtCount(noStateCount) }} expense{{ num(noStateCount) === 1 ? '' : 's' }}
        ({{ formatCurrency(noStateSpend) }}) {{ num(noStateCount) === 1 ? 'has' : 'have' }} no state yet
      </div>
    </template>
  </div>
</template>

<script setup>
// Ranked single-series bar list — states are nominal categories (identity =
// the row's state code), so every bar wears the one SEQUENTIAL_HUE. Bars are
// scaled against the global max so expanding "＋N more" never rescales the
// bars already on screen.
import { ref, computed } from 'vue'
import { formatCurrency } from '../../../utils/format'
import { SEQUENTIAL_HUE } from './typeColors'

const props = defineProps({
  // Rows: { state, count, spend, gallons }
  states: { type: Array, default: () => [] },
  noStateCount: { type: Number, default: 0 },
  noStateSpend: { type: Number, default: 0 },
})

const VISIBLE = 12
const showAll = ref(false)

function num(v) {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

const sorted = computed(() =>
  [...(props.states || [])]
    .filter((s) => s && s.state)
    .sort((a, b) => num(b.spend) - num(a.spend))
)

const shown = computed(() => (showAll.value ? sorted.value : sorted.value.slice(0, VISIBLE)))
const hiddenCount = computed(() => Math.max(sorted.value.length - VISIBLE, 0))

const maxSpend = computed(() => Math.max(...sorted.value.map((s) => num(s.spend)), 1))

function barPct(s) {
  return (num(s.spend) / maxSpend.value) * 100
}

function fmtCount(c) {
  return num(c).toLocaleString('en-US')
}

function rowTitle(s) {
  const parts = [
    `${fmtCount(s.count)} expense${num(s.count) === 1 ? '' : 's'}`,
    formatCurrency(s.spend),
  ]
  if (num(s.gallons) > 0) {
    parts.push(`${num(s.gallons).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} gal`)
  }
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

.sbar-list {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.sbar-row { min-width: 0; }
.sbar-label {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.75rem;
  font-size: 0.76rem;
  margin-bottom: 0.25rem;
}
.sbar-name {
  display: inline-flex;
  align-items: baseline;
  gap: 0.4rem;
  min-width: 0;
}
.sbar-code {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  color: var(--text);
}
.sbar-count {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--border);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.62rem;
  font-weight: 600;
  color: var(--text-dim);
  line-height: 1.5;
}
/* Values stay in text ink (mono), never the series color. */
.sbar-val {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  color: var(--text);
  flex-shrink: 0;
}
.sbar-track {
  height: 10px;
  background: var(--bg);
  border-radius: 4px;
  overflow: hidden;
}
.sbar-fill {
  height: 100%;
  background: v-bind(SEQUENTIAL_HUE);
  /* Rounded data-end, square at the baseline (left edge). */
  border-radius: 0 4px 4px 0;
  transition: width 0.4s ease;
}
.sbar-row:hover .sbar-fill { filter: brightness(1.12); }

.sbar-more {
  margin-top: 0.65rem;
  padding: 0.28rem 0.65rem;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
}
.sbar-more:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.sbar-footer {
  margin-top: 0.75rem;
  padding-top: 0.6rem;
  border-top: 1px dashed var(--border);
  font-size: 0.72rem;
  color: var(--text-dim);
}
</style>
