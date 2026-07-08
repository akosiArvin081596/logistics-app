<template>
  <div class="exp-card">
    <div class="exp-card-head">
      <div class="exp-card-titles">
        <h3 class="exp-card-title">Monthly Trend</h3>
        <div class="exp-card-sub">{{ metric === 'spend' ? 'Total spend per month' : 'Fuel gallons per month' }}</div>
      </div>
      <!-- ONE axis: the toggle swaps which series is plotted — never two
           overlaid scales on one plot. -->
      <div class="seg" role="group" aria-label="Trend metric">
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

    <div
      ref="wrapRef"
      class="trend-wrap"
      @pointermove="onMove"
      @pointerleave="hoverIdx = -1"
    >
      <div v-if="pts.length < 2" class="exp-empty">Not enough data for a trend yet.</div>

      <svg
        v-else-if="width > 40"
        :width="w"
        :height="H"
        :viewBox="`0 0 ${w} ${H}`"
        class="trend-svg"
        role="img"
        :aria-label="ariaLabel"
      >
        <defs>
          <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" :stop-color="SEQUENTIAL_HUE" stop-opacity="0.12" />
            <stop offset="100%" :stop-color="SEQUENTIAL_HUE" stop-opacity="0" />
          </linearGradient>
        </defs>

        <!-- Recessive y gridlines + clean ticks (they carry the values the
             endpoint label doesn't) -->
        <g v-for="t in ticks" :key="'tick-' + t">
          <line :x1="PAD.l" :x2="w - PAD.r" :y1="y(t)" :y2="y(t)" class="gridline" />
          <text :x="PAD.l - 8" :y="y(t) + 3" text-anchor="end" class="tick-label">{{ tickLabel(t) }}</text>
        </g>

        <!-- Area wash + 2px line -->
        <polygon :points="areaPoints" :fill="`url(#${gradId})`" />
        <polyline
          :points="linePoints"
          fill="none"
          :stroke="SEQUENTIAL_HUE"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
        />

        <!-- Nearest-point crosshair -->
        <line
          v-if="hoverIdx >= 0"
          :x1="x(hoverIdx)"
          :x2="x(hoverIdx)"
          :y1="PAD.t"
          :y2="baseY"
          class="crosshair"
        />

        <!-- Point markers with a 2px surface ring -->
        <circle
          v-for="(v, i) in vals"
          :key="'pt-' + i"
          :cx="x(i)"
          :cy="y(v)"
          :r="hoverIdx === i ? 5.5 : 4"
          :fill="SEQUENTIAL_HUE"
          class="pt"
        />

        <!-- Selective x labels -->
        <template v-for="(p, i) in pts" :key="'xl-' + i">
          <text v-if="xLabelIdx.has(i)" :x="x(i)" :y="H - 8" text-anchor="middle" class="tick-label">
            {{ shortLabel(p.month) }}
          </text>
        </template>

        <!-- Selective direct label: the endpoint only, in text ink -->
        <text
          :x="x(pts.length - 1)"
          :y="Math.max(y(vals[pts.length - 1]) - 12, 12)"
          text-anchor="end"
          class="end-label"
        >{{ endLabel }}</text>
      </svg>

      <!-- Hover tooltip: month + all three figures (display-only) -->
      <div v-if="hoverIdx >= 0 && pts[hoverIdx]" class="trend-tip" :style="tipStyle" role="status">
        <div class="tip-month">{{ fullLabel(pts[hoverIdx].month) }}</div>
        <div class="tip-row"><span>Spend</span><span class="tip-val">{{ formatCurrency(pts[hoverIdx].spend) }}</span></div>
        <div class="tip-row"><span>Gallons</span><span class="tip-val">{{ pts[hoverIdx].gallons > 0 ? fmtGal(pts[hoverIdx].gallons) : '—' }}</span></div>
        <div class="tip-row"><span>Avg $/gal</span><span class="tip-val">{{ pts[hoverIdx].avgPerGallon > 0 ? '$' + pts[hoverIdx].avgPerGallon.toFixed(2) : '—' }}</span></div>
      </div>
    </div>
  </div>
</template>

<script setup>
// SVG polyline + gradient area (investor TrendSection pattern), rebuilt in
// pixel space: the container is measured with a ResizeObserver and the SVG is
// drawn at that width, so point markers stay round, text stays crisp, and the
// nearest-point hover math is exact (TrendSection's preserveAspectRatio="none"
// stretch would distort all three).
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { formatCurrency } from '../../../utils/format'
import { SEQUENTIAL_HUE } from './typeColors'

const props = defineProps({
  // Rows (ascending): { month: 'YYYY-MM', count, spend, gallons, avgPerGallon }
  months: { type: Array, default: () => [] },
})

const METRICS = [
  { key: 'spend', label: 'Spend' },
  { key: 'gallons', label: 'Gallons' },
]
const metric = ref('spend')

// Chart geometry — H includes the x-axis label band so the card never grows a
// nested scrollbar around clipped labels.
const H = 232
const PAD = { l: 48, r: 16, t: 18, b: 28 }
const plotH = H - PAD.t - PAD.b

// Unique gradient id so two mounted instances can never collide.
const gradId = 'exp-trend-grad-' + Math.random().toString(36).slice(2, 8)

function num(v) {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

const pts = computed(() =>
  (props.months || [])
    .filter((m) => m && m.month)
    .map((m) => ({
      month: String(m.month),
      count: num(m.count),
      spend: num(m.spend),
      gallons: num(m.gallons),
      avgPerGallon: num(m.avgPerGallon),
    }))
)

const vals = computed(() => pts.value.map((p) => p[metric.value]))

// --- Responsive width ---
const wrapRef = ref(null)
const width = ref(0)
let ro = null
onMounted(() => {
  ro = new ResizeObserver((entries) => {
    const cw = entries[0]?.contentRect?.width || 0
    if (cw > 0) width.value = cw
  })
  if (wrapRef.value) ro.observe(wrapRef.value)
})
onBeforeUnmount(() => {
  if (ro) ro.disconnect()
})
const w = computed(() => width.value || 560)

// --- Scales ---
// Round the axis max up to a clean number (1/2/2.5/5 x 10^k).
function niceCeil(v) {
  if (!(v > 0)) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const m = v / p
  const s = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
  return s * p
}
const maxY = computed(() => niceCeil(Math.max(...vals.value, 0)))

const plotW = computed(() => Math.max(w.value - PAD.l - PAD.r, 1))
function x(i) {
  const n = pts.value.length
  if (n < 2) return PAD.l
  return PAD.l + (i / (n - 1)) * plotW.value
}
function y(v) {
  return PAD.t + plotH - (num(v) / maxY.value) * plotH
}
const baseY = PAD.t + plotH

const linePoints = computed(() => vals.value.map((v, i) => `${x(i)},${y(v)}`).join(' '))
const areaPoints = computed(() => {
  const n = pts.value.length
  return `${linePoints.value} ${x(n - 1)},${baseY} ${x(0)},${baseY}`
})

const ticks = computed(() => [0, maxY.value / 2, maxY.value])

function compact(v) {
  const n = num(v)
  if (n >= 1000000) return trimK(n / 1000000) + 'M'
  if (n >= 1000) return trimK(n / 1000) + 'K'
  return String(Math.round(n * 10) / 10)
}
function trimK(k) {
  return String(k >= 100 ? Math.round(k) : Math.round(k * 10) / 10)
}
function tickLabel(v) {
  return metric.value === 'spend' ? '$' + compact(v) : compact(v)
}

// --- Labels ---
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const multiYear = computed(() => new Set(pts.value.map((p) => p.month.slice(0, 4))).size > 1)

function shortLabel(month) {
  const [yy, mm] = String(month).split('-')
  const name = SHORT_MONTHS[(parseInt(mm, 10) || 1) - 1] || month
  return multiYear.value ? `${name} '${String(yy).slice(2)}` : name
}
function fullLabel(month) {
  const [yy, mm] = String(month).split('-')
  const name = FULL_MONTHS[(parseInt(mm, 10) || 1) - 1]
  return name ? `${name} ${yy}` : month
}

// Selective x labels: walk backwards from the last point so the newest month
// is always labeled; cap at ~7 labels.
const xLabelIdx = computed(() => {
  const n = pts.value.length
  const step = Math.max(1, Math.ceil(n / 7))
  const set = new Set()
  for (let i = n - 1; i >= 0; i -= step) set.add(i)
  if (!set.has(0) && step > 1) {
    set.add(0)
    if (set.has(1)) set.delete(1) // avoid a collision right next to the first label
  }
  return set
})

const fmtGal = (g) => num(g).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

const endLabel = computed(() => {
  const last = vals.value[vals.value.length - 1] || 0
  return metric.value === 'spend' ? formatCurrency(last) : fmtGal(last) + ' gal'
})

const ariaLabel = computed(() => {
  if (pts.value.length < 2) return 'Monthly trend'
  const first = pts.value[0].month
  const last = pts.value[pts.value.length - 1].month
  return `Monthly ${metric.value === 'spend' ? 'spend' : 'gallons'} trend, ${fullLabel(first)} to ${fullLabel(last)}`
})

// --- Nearest-point hover ---
const hoverIdx = ref(-1)
function onMove(e) {
  if (pts.value.length < 2 || width.value <= 40) return
  const rect = wrapRef.value?.getBoundingClientRect()
  if (!rect) return
  const mx = e.clientX - rect.left
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < pts.value.length; i++) {
    const d = Math.abs(x(i) - mx)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  hoverIdx.value = best
}

const tipStyle = computed(() => {
  if (hoverIdx.value < 0) return {}
  const px = x(hoverIdx.value)
  const py = y(vals.value[hoverIdx.value] || 0)
  return {
    left: Math.max(4, Math.min(px + 12, w.value - 182)) + 'px',
    top: Math.max(4, Math.min(py - 10, H - 122)) + 'px',
  }
})
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

.trend-wrap {
  position: relative;
  min-height: 232px;
}
.trend-svg { display: block; }

/* Hairline, solid, recessive grid */
.gridline {
  stroke: var(--border);
  stroke-width: 1;
}
.crosshair {
  stroke: var(--text-dim);
  stroke-width: 1;
  opacity: 0.45;
}
.pt {
  stroke: var(--surface);
  stroke-width: 2;
  transition: r 0.1s ease;
}
/* Axis + labels in text tokens, never the series color */
.tick-label {
  font-size: 0.62rem;
  fill: var(--text-dim);
  font-family: 'DM Sans', sans-serif;
}
.end-label {
  font-size: 0.68rem;
  font-weight: 700;
  fill: var(--text);
  font-family: 'JetBrains Mono', monospace;
}

.trend-tip {
  position: absolute;
  width: 170px;
  padding: 0.5rem 0.65rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.12);
  font-size: 0.72rem;
  pointer-events: none;
  z-index: 5;
}
.tip-month {
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
