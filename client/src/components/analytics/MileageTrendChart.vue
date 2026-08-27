<template>
  <div class="mtc">
    <div class="mtc-head">
      <div class="mtc-title">
        <slot name="title">Weekly trend</slot>
      </div>
      <div class="seg" role="group" aria-label="Choose metric">
        <button
          v-for="m in METRICS" :key="m.key"
          class="seg-btn" :class="{ on: metric === m.key }"
          :aria-pressed="metric === m.key"
          @click="metric = m.key"
        >{{ m.label }}</button>
      </div>
    </div>

    <div ref="wrapRef" class="mtc-wrap">
      <svg v-if="width > 0 && pts.length" :width="width" :height="H" role="img" :aria-label="ariaSummary">
        <!-- Recessive gridlines: they orient the eye without competing with the
             bars. Labelled on the left so a value can be read without a tooltip. -->
        <g v-for="t in ticks" :key="t.v">
          <line class="gridline" :x1="PAD.l" :x2="width - PAD.r" :y1="t.y" :y2="t.y" />
          <text class="tick-label" :x="PAD.l - 8" :y="t.y + 3" text-anchor="end">{{ t.label }}</text>
        </g>

        <!-- One bar per week. Each is a real button target: clicking drills into
             that week, which is the whole point of showing it. -->
        <g v-for="(p, i) in pts" :key="p.weekStart">
          <rect
            class="bar-hit" :x="barX(i) - barGap / 2" :y="PAD.t"
            :width="barW + barGap" :height="plotH"
            @pointerenter="hoverIdx = i" @pointerleave="hoverIdx = -1"
            @click="$emit('select', p)"
          />
          <rect
            class="bar" :class="{ dim: p.miles === null, hot: hoverIdx === i }"
            :x="barX(i)" :y="barY(p)" :width="barW" :height="barH(p)"
            rx="2"
            @pointerenter="hoverIdx = i" @pointerleave="hoverIdx = -1"
            @click="$emit('select', p)"
          />
          <!-- A week we could not measure is drawn as an empty slot, not a zero
               bar. A flat bar at the baseline reads as "did not move"; this
               reads as "not known", which is the truth. -->
          <text v-if="valueOf(p) === null" class="no-data-mark" :x="barX(i) + barW / 2" :y="PAD.t + plotH - 4" text-anchor="middle">—</text>
          <text
            v-if="showLabel(i)" class="x-label"
            :x="barX(i) + barW / 2" :y="H - 8" text-anchor="middle"
          >{{ shortLabel(p) }}</text>
        </g>
      </svg>
      <div v-else-if="!pts.length" class="mtc-empty">No weeks in this range.</div>

      <div
        v-if="hoverIdx >= 0 && pts[hoverIdx]"
        class="mtc-tip"
        :style="{ left: tipLeft + 'px' }"
      >
        <div class="tip-head">{{ pts[hoverIdx].label }}</div>
        <div class="tip-row"><span>Miles</span><span class="tip-val">{{ fmtNum(pts[hoverIdx].miles) }}</span></div>
        <div class="tip-row"><span>Diesel</span><span class="tip-val">{{ fmtMoney(pts[hoverIdx].fuelSpend) }}</span></div>
        <div class="tip-row"><span>Fuel $/mi</span><span class="tip-val">{{ fmtCpm(pts[hoverIdx].fuelCostPerMile) }}</span></div>
        <div class="tip-hint">Click to open this week</div>
      </div>
    </div>
  </div>
</template>

<script setup>
// Weekly bars, drawn in PIXEL SPACE with a ResizeObserver — the MonthlyTrendCard
// approach. The older investor TrendSection stretches its SVG with
// preserveAspectRatio="none", which distorts markers, text and hover maths; this
// avoids all three by drawing at the measured width.
//
// BARS, NOT A LINE. A week is a discrete bucket, and a line implies a continuous
// value between two Saturdays that does not exist. Bars are also a real click
// target, which is what makes the chart a way into the detail rather than
// decoration.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { SEQUENTIAL_HUE } from '../dashboard/expenses/typeColors'

const props = defineProps({
  // Ascending: { weekStart, weekEnd, label, miles, fuelSpend, fuelCostPerMile }
  weeks: { type: Array, default: () => [] },
})
defineEmits(['select'])

const METRICS = [
  { key: 'miles', label: 'Miles' },
  { key: 'fuelSpend', label: 'Diesel $' },
  { key: 'fuelCostPerMile', label: 'Fuel $/mi' },
]
const metric = ref('miles')
const hoverIdx = ref(-1)

const H = 200
const PAD = { l: 52, r: 14, t: 16, b: 26 }
const plotH = H - PAD.t - PAD.b
const barGap = 6

const wrapRef = ref(null)
const width = ref(0)
let ro = null
onMounted(() => {
  ro = new ResizeObserver((e) => {
    const w = e[0]?.contentRect?.width || 0
    if (w > 0) width.value = w
  })
  if (wrapRef.value) ro.observe(wrapRef.value)
})
onBeforeUnmount(() => { if (ro) ro.disconnect() })

const pts = computed(() => (props.weeks || []).filter((w) => w && w.weekStart))

// null stays null all the way through — it is the difference between "did not
// move" and "we cannot see this truck".
function valueOf(p) {
  const v = p ? p[metric.value] : null
  return v === null || v === undefined ? null : Number(v)
}
const maxVal = computed(() => {
  const vals = pts.value.map(valueOf).filter((v) => v !== null && Number.isFinite(v))
  return vals.length ? Math.max(...vals, 0) : 0
})

const barW = computed(() => {
  if (!pts.value.length || width.value <= 0) return 0
  const usable = width.value - PAD.l - PAD.r
  return Math.max(3, usable / pts.value.length - barGap)
})
function barX(i) {
  return PAD.l + i * (barW.value + barGap) + barGap / 2
}
function barH(p) {
  const v = valueOf(p)
  if (v === null || maxVal.value <= 0) return 0
  // 2px floor so a small but non-zero week is still visible rather than
  // rounding away to nothing.
  return Math.max(v > 0 ? 2 : 0, (v / maxVal.value) * plotH)
}
function barY(p) { return PAD.t + plotH - barH(p) }

const ticks = computed(() => {
  if (maxVal.value <= 0) return []
  const steps = 3
  return Array.from({ length: steps + 1 }, (_, i) => {
    const v = (maxVal.value / steps) * i
    return { v, y: PAD.t + plotH - (v / maxVal.value) * plotH, label: tickLabel(v) }
  })
})
function tickLabel(v) {
  if (metric.value === 'fuelCostPerMile') return '$' + v.toFixed(2)
  if (metric.value === 'fuelSpend') return v >= 1000 ? '$' + Math.round(v / 1000) + 'k' : '$' + Math.round(v)
  return v >= 1000 ? Math.round(v / 1000) + 'k' : String(Math.round(v))
}

// Thin the x labels rather than overlapping them.
function showLabel(i) {
  const n = pts.value.length
  if (n <= 8) return true
  const every = Math.ceil(n / 8)
  return i % every === 0 || i === n - 1
}
function shortLabel(p) { return String(p.weekStart || '').slice(5).replace('-', '/') }

const tipLeft = computed(() => {
  if (hoverIdx.value < 0) return 0
  const x = barX(hoverIdx.value) + barW.value / 2
  return Math.min(Math.max(x, PAD.l + 60), Math.max(width.value - 80, PAD.l + 60))
})

const ariaSummary = computed(() => {
  const m = METRICS.find((x) => x.key === metric.value)
  return `${m ? m.label : 'Miles'} by week, ${pts.value.length} weeks. Highest ${tickLabel(maxVal.value)}.`
})

function fmtNum(v) { return v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US') }
function fmtMoney(v) { return v === null || v === undefined ? '—' : '$' + Math.round(Number(v)).toLocaleString('en-US') }
function fmtCpm(v) { return v === null || v === undefined ? '—' : '$' + Number(v).toFixed(2) }
</script>

<style scoped>
.mtc { width: 100%; }
.mtc-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
.mtc-title { font-weight: 700; font-size: 0.85rem; }
.seg { margin-left: auto; display: inline-flex; gap: 2px; background: var(--bg, #f1f5f9); padding: 2px; border-radius: 999px; }
.seg-btn {
  border: 0; background: transparent; cursor: pointer;
  padding: 0.2rem 0.6rem; border-radius: 999px;
  font-size: 0.72rem; font-weight: 600; color: var(--text-dim, #6b7085);
}
.seg-btn.on { background: var(--surface, #fff); color: var(--text, #1f2937); box-shadow: 0 1px 2px rgba(0,0,0,.08); }

.mtc-wrap { position: relative; width: 100%; }
.mtc-empty { padding: 1.5rem 0; text-align: center; color: var(--text-dim, #6b7085); font-size: 0.82rem; }

.gridline { stroke: var(--border-soft, #eef0f4); stroke-width: 1; }
.tick-label { font-size: 9.5px; fill: var(--text-dim, #94a3b8); }
.x-label { font-size: 9.5px; fill: var(--text-dim, #94a3b8); }
.no-data-mark { font-size: 11px; fill: #cbd5e1; }

.bar { fill: v-bind(SEQUENTIAL_HUE); cursor: pointer; transition: opacity .12s ease; }
.bar.hot { opacity: 0.78; }
.bar.dim { fill: #e2e8f0; }
/* A wider invisible target so a thin bar is still easy to hit. */
.bar-hit { fill: transparent; cursor: pointer; }

.mtc-tip {
  position: absolute; top: 4px; transform: translateX(-50%);
  background: var(--surface, #fff); border: 1px solid var(--border, #d8dbe3);
  border-radius: 8px; padding: 0.45rem 0.6rem; pointer-events: none;
  box-shadow: 0 4px 14px rgba(0,0,0,.10); min-width: 132px; z-index: 2;
}
.tip-head { font-size: 0.72rem; font-weight: 700; margin-bottom: 0.2rem; }
.tip-row { display: flex; justify-content: space-between; gap: 0.75rem; font-size: 0.7rem; color: var(--text-dim, #6b7085); }
.tip-val { font-variant-numeric: tabular-nums; color: var(--text, #1f2937); font-weight: 600; }
.tip-hint { margin-top: 0.25rem; font-size: 0.64rem; color: var(--text-dim, #94a3b8); font-style: italic; }
</style>
