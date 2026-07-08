<template>
  <div ref="cardRef" class="exp-card">
    <div class="exp-card-head">
      <div class="exp-card-titles">
        <h3 class="exp-card-title">Spend by Type</h3>
        <div class="exp-card-sub">Share of total spend</div>
      </div>
    </div>

    <div v-if="!rows.length || total <= 0" class="exp-empty">No expense data yet.</div>

    <div v-else class="donut-layout">
      <div class="donut-wrap" role="img" :aria-label="donutAria">
        <svg viewBox="0 0 120 120" class="donut-svg">
          <!-- Segments follow the fixed TYPE_COLORS key order (the adjacency
               the palette was validated in), never spend rank. -->
          <g transform="rotate(-90 60 60)">
            <circle
              v-for="seg in segs"
              :key="seg.type"
              class="donut-seg"
              cx="60"
              cy="60"
              :r="R"
              fill="none"
              :stroke="seg.color"
              :stroke-width="hovered === seg.type ? STROKE_HOVER : STROKE"
              :stroke-dasharray="dashArray(seg)"
              :stroke-dashoffset="dashOffset(seg)"
              @pointermove="onSegMove($event, seg)"
              @pointerleave="clearSeg"
            />
          </g>
        </svg>
        <div class="donut-center" aria-hidden="true">
          <div class="donut-total">{{ formatCurrency(total) }}</div>
          <div class="donut-total-label">total spend</div>
        </div>
      </div>

      <!-- Legend: identity dot + name + value + share, all values in text ink -->
      <div class="donut-legend">
        <div
          v-for="r in rows"
          :key="r.type"
          class="legend-row"
          :class="{ hot: hovered === r.type }"
          @pointerenter="hovered = r.type"
          @pointerleave="hovered = ''"
        >
          <span class="legend-dot" :style="{ background: r.color }" aria-hidden="true"></span>
          <span class="legend-name">{{ r.type }}</span>
          <span class="legend-spend">{{ formatCurrency(r.spend) }}</span>
          <span class="legend-pct">{{ pct(r).toFixed(1) }}%</span>
        </div>
      </div>
    </div>

    <!-- Segment hover tooltip (display-only; the legend carries the same values) -->
    <div v-if="tipSeg" class="donut-tip" :style="{ left: tipPos.x + 'px', top: tipPos.y + 'px' }" role="status">
      <div class="tip-title">
        <span class="legend-dot" :style="{ background: tipSeg.color }" aria-hidden="true"></span>
        {{ tipSeg.type }}
      </div>
      <div class="tip-row"><span>Spend</span><span class="tip-val">{{ formatCurrency(tipSeg.spend) }}</span></div>
      <div class="tip-row"><span>Share</span><span class="tip-val">{{ pct(tipSeg).toFixed(1) }}%</span></div>
      <div class="tip-row"><span>Expenses</span><span class="tip-val">{{ tipSeg.count.toLocaleString('en-US') }}</span></div>
    </div>
  </div>
</template>

<script setup>
// Donut via stroke-dasharray circles (TaxShieldSection ring pattern), one
// segment per expense type. Colors come from TYPE_COLORS only — the Fuel
// segment is the same hex as the Fuel map pin and Fuel legend dot everywhere.
import { ref, computed } from 'vue'
import { formatCurrency } from '../../../utils/format'
import { TYPE_COLORS, resolveTypeKey } from './typeColors'

const props = defineProps({
  // Rows: { type, count, spend, gallons }
  types: { type: Array, default: () => [] },
})

const R = 44
const C = 2 * Math.PI * R
const STROKE = 14
const STROKE_HOVER = 17
// 2px surface gap between adjacent segments (the gap does the separating —
// never a stroke drawn around the mark). In viewBox units: the 120-unit
// viewBox renders at 156px, so 1.55 units ≈ 2 rendered px.
const GAP = 1.55

function num(v) {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

// Aggregate incoming rows onto the 7 canonical types (stray casings fold into
// their canonical key; unknowns fold into Other), then order by TYPE_COLORS
// key order — the fixed, validated entity order for donut + legend.
const rows = computed(() => {
  const agg = new Map()
  for (const t of props.types || []) {
    if (!t) continue
    const key = resolveTypeKey(t.type)
    const cur = agg.get(key) || { type: key, count: 0, spend: 0, gallons: 0 }
    cur.count += num(t.count)
    cur.spend += num(t.spend)
    cur.gallons += num(t.gallons)
    agg.set(key, cur)
  }
  return Object.keys(TYPE_COLORS)
    .filter((k) => agg.has(k))
    .map((k) => ({ ...agg.get(k), color: TYPE_COLORS[k] }))
})

const total = computed(() => rows.value.reduce((s, r) => s + r.spend, 0))

// Only spend > 0 becomes a segment (a zero-width arc would just eat gap);
// zero rows still get their legend line.
const segs = computed(() => {
  if (total.value <= 0) return []
  let acc = 0
  return rows.value
    .filter((r) => r.spend > 0)
    .map((r) => {
      const frac = r.spend / total.value
      const seg = { ...r, frac, start: acc }
      acc += frac
      return seg
    })
})

// A single segment is a full ring — no gap to draw.
const gapLen = computed(() => (segs.value.length > 1 ? GAP : 0))

function dashArray(seg) {
  const len = Math.max(seg.frac * C - gapLen.value, 0.5)
  return `${len} ${C - len}`
}
function dashOffset(seg) {
  return -(seg.start * C + gapLen.value / 2)
}

function pct(r) {
  return total.value > 0 ? (r.spend / total.value) * 100 : 0
}

const donutAria = computed(
  () =>
    'Spend by type donut. ' +
    rows.value.map((r) => `${r.type} ${formatCurrency(r.spend)} (${pct(r).toFixed(1)}%)`).join(', ')
)

// --- Hover state ---
// `hovered` drives the stroke-enlarge (segment or legend); `tipFor` shows the
// floating tooltip only while the pointer is on the donut itself.
const cardRef = ref(null)
const hovered = ref('')
const tipFor = ref('')
const tipPos = ref({ x: 0, y: 0 })

const tipSeg = computed(() => segs.value.find((s) => s.type === tipFor.value) || null)

function onSegMove(e, seg) {
  hovered.value = seg.type
  tipFor.value = seg.type
  const rect = cardRef.value?.getBoundingClientRect()
  if (!rect) return
  tipPos.value = {
    x: Math.max(4, Math.min(e.clientX - rect.left + 12, rect.width - 172)),
    y: Math.max(4, e.clientY - rect.top - 84),
  }
}
function clearSeg() {
  hovered.value = ''
  tipFor.value = ''
}
</script>

<style scoped>
.exp-card {
  position: relative;
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

.donut-layout {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  flex-wrap: wrap;
}

.donut-wrap {
  position: relative;
  width: 156px;
  height: 156px;
  flex-shrink: 0;
}
.donut-svg {
  width: 100%;
  height: 100%;
}
.donut-seg {
  transition: stroke-width 0.15s ease;
}
.donut-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  text-align: center;
  padding: 0 26px;
}
.donut-total {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--text);
  overflow-wrap: anywhere;
}
.donut-total-label {
  font-size: 0.6rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  margin-top: 2px;
}

.donut-legend {
  flex: 1 1 200px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.legend-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.14rem 0.3rem;
  border-radius: 6px;
  font-size: 0.74rem;
  transition: background 0.12s;
}
.legend-row.hot { background: var(--bg); }
.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.legend-name {
  color: var(--text);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.legend-spend {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  color: var(--text);
}
.legend-pct {
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-dim);
  min-width: 44px;
  text-align: right;
}

.donut-tip {
  position: absolute;
  width: 160px;
  padding: 0.5rem 0.65rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.12);
  font-size: 0.72rem;
  pointer-events: none;
  z-index: 5;
}
.tip-title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 0.3rem;
}
.tip-row {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  color: var(--text-dim);
  padding: 1px 0;
}
.tip-val {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  color: var(--text);
}
</style>
