<template>
  <!-- Floating fuel + route-tools card, shown when a single driver is focused.
       Holds three things Deshorn asked for:
        #3  a "miles left in tank" range readout (hidden when the truck has no
            fuel sensor / no data),
        #2  a toggle that plots diesel truck stops on the map (parent renders
            the markers; this only owns the on/off state + fetch), and
        #4  a cheapest-diesel list = the along-route stops sorted by distance
            from the route, labeled honestly as a regional average.
       Every endpoint may 404 pre-integration → each section degrades to its own
       loading / empty / error state and never blocks the others. -->
  <div class="fuel-finder" :class="{ collapsed }">
    <button class="ff-toggle" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
      <span class="ff-pump" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
          <path d="M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h9v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77zM12 10H6V5h6v5z" />
        </svg>
      </span>
      <span class="ff-title-text">Fuel &amp; Route</span>
      <span v-if="rangeMilesDisplay != null" class="ff-range-badge">{{ rangeMilesDisplay }} mi left</span>
      <span class="ff-chevron" :class="{ open: !collapsed }" aria-hidden="true">&#9662;</span>
    </button>

    <div v-show="!collapsed" class="ff-body">
      <!-- #3 FUEL RANGE -->
      <div v-if="rangeLoading" class="ff-loading">Reading fuel level…</div>
      <div v-else-if="hasFuelData" class="ff-range">
        <div class="ff-ring" :class="{ low: fuelLow }" role="img" :aria-label="`Fuel ${Math.round(range.fuelPct)} percent`">
          <svg viewBox="0 0 36 36">
            <circle class="ff-ring-bg" cx="18" cy="18" r="15.9155" />
            <circle class="ff-ring-fg" cx="18" cy="18" r="15.9155" :stroke-dasharray="`${ringPct} 100`" />
          </svg>
          <span class="ff-ring-label">{{ Math.round(range.fuelPct) }}%</span>
        </div>
        <div class="ff-range-info">
          <div class="ff-range-miles">
            <span class="ff-range-num">{{ rangeMilesDisplay != null ? rangeMilesDisplay : '—' }}</span>
            <span class="ff-unit">mi to empty</span>
          </div>
          <div class="ff-range-sub">
            <span v-if="range.gallonsRemaining != null">{{ round1(range.gallonsRemaining) }} / {{ round1(range.tankGallons) }} gal</span>
            <span v-if="range.mpg" class="ff-mpg">
              {{ round1(range.mpg) }} mpg
              <span class="ff-src" :class="range.mpgSource === 'eld' ? 'src-eld' : 'src-est'">
                {{ range.mpgSource === 'eld' ? 'ELD' : 'est' }}
              </span>
            </span>
          </div>
        </div>
      </div>

      <!-- #2 map toggle + #4 cheapest-diesel list -->
      <div class="ff-stops">
        <div class="ff-stops-head">
          <span class="ff-stops-title">Diesel truck stops</span>
          <button
            v-if="stops.length"
            class="ff-map-toggle"
            :class="{ on: showStops }"
            role="switch"
            :aria-checked="showStops"
            :title="showStops ? 'Hide truck stops on the map' : 'Show truck stops on the map'"
            @click="toggleStops"
          >
            <span class="ff-switch"><span class="ff-knob"></span></span>
            <span class="ff-map-label">Map</span>
          </button>
        </div>

        <div v-if="stopsLoading" class="ff-loading">Finding truck stops along the route…</div>
        <div v-else-if="stopsError" class="ff-muted">{{ stopsError }}</div>
        <template v-else-if="stops.length">
          <div class="ff-price-note" title="Free regional-average pricing; per-station live prices are planned">
            Regional avg diesel — per-station live pricing coming soon
          </div>
          <ul class="ff-stop-list">
            <li v-for="(s, i) in stops" :key="s.placeId || i">
              <button class="ff-stop" @click="$emit('focus', { lat: s.lat, lng: s.lng, name: s.name })">
                <span class="ff-stop-main">
                  <span class="ff-stop-name">
                    <span v-if="s.brand && brandDiffersFromName(s)" class="ff-stop-brand">{{ s.brand }}</span>
                    {{ s.name || s.brand || 'Truck stop' }}
                  </span>
                  <span v-if="s.address" class="ff-stop-addr">{{ s.address }}</span>
                  <span v-if="s.aboutMilesFromRoute != null" class="ff-stop-dist">~{{ round1(s.aboutMilesFromRoute) }} mi off route</span>
                </span>
                <span class="ff-stop-price">
                  <span v-if="s.regionalDieselPrice != null" class="ff-price">${{ Number(s.regionalDieselPrice).toFixed(2) }}</span>
                  <span v-else class="ff-price muted">—</span>
                  <span class="ff-price-unit">/gal</span>
                </span>
              </button>
            </li>
          </ul>
        </template>
        <div v-else class="ff-muted">No truck stops found along this route.</div>
      </div>

      <div v-if="isEmpty" class="ff-muted ff-empty">No live fuel or route data for this driver yet.</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useApi } from '../../composables/useApi'

const api = useApi()

const props = defineProps({
  driver: { type: String, default: '' },
  loadId: { type: String, default: '' },
  // Active load object from /api/locations/latest (carries origin/dest coords)
  // — used as a fallback query when no loadId is available.
  activeLoad: { type: Object, default: null },
})

const emit = defineEmits(['stops', 'show', 'focus'])

const range = ref(null)
const rangeLoading = ref(false)
const stops = ref([])
const stopsLoading = ref(false)
const stopsError = ref('')
const showStops = ref(false)
const collapsed = ref(false)

const hasFuelData = computed(() => !!(range.value && range.value.hasFuelData))
const fuelLow = computed(
  () => hasFuelData.value && range.value.fuelPct != null && range.value.fuelPct <= 25,
)
const ringPct = computed(() =>
  hasFuelData.value ? Math.max(0, Math.min(100, Number(range.value.fuelPct) || 0)) : 0,
)
const rangeMilesDisplay = computed(() =>
  hasFuelData.value && range.value.rangeMiles != null ? Math.round(range.value.rangeMiles) : null,
)
const anyLoading = computed(() => rangeLoading.value || stopsLoading.value)
const isEmpty = computed(
  () => !hasFuelData.value && stops.value.length === 0 && !anyLoading.value && !stopsError.value,
)

function round1(n) {
  const x = Number(n)
  return Number.isFinite(x) ? Math.round(x * 10) / 10 : '—'
}
function brandDiffersFromName(s) {
  if (!s.brand || !s.name) return false
  return !s.name.toLowerCase().includes(s.brand.toLowerCase())
}

async function fetchRange() {
  if (!props.driver) {
    range.value = null
    return
  }
  rangeLoading.value = true
  try {
    const d = await api.get(`/api/fuel/range?driver=${encodeURIComponent(props.driver)}`)
    range.value = d && d.ok !== false ? d : null
  } catch {
    // 404 pre-integration or upstream error — treat as "no fuel data" so the
    // range readout simply hides.
    range.value = null
  } finally {
    rangeLoading.value = false
  }
}

function stopsQuery() {
  if (props.loadId) return `loadId=${encodeURIComponent(props.loadId)}`
  const a = props.activeLoad
  if (a && Number.isFinite(Number(a.originLat)) && Number.isFinite(Number(a.destLat))) {
    return `originLat=${a.originLat}&originLng=${a.originLng}&destLat=${a.destLat}&destLng=${a.destLng}`
  }
  return ''
}

async function fetchStops() {
  const q = stopsQuery()
  if (!q) {
    stops.value = []
    stopsError.value = ''
    emit('stops', [])
    return
  }
  stopsLoading.value = true
  stopsError.value = ''
  try {
    const d = await api.get(`/api/poi/fuel-stops?${q}&limit=12`)
    const list = Array.isArray(d.stops)
      ? [...d.stops].sort(
          (x, y) => (x.aboutMilesFromRoute ?? 1e9) - (y.aboutMilesFromRoute ?? 1e9),
        )
      : []
    stops.value = list
    emit('stops', list)
  } catch (e) {
    stops.value = []
    stopsError.value =
      e?.status === 404 ? 'Truck-stop finder is not available yet.' : 'Could not load truck stops.'
    emit('stops', [])
  } finally {
    stopsLoading.value = false
  }
}

function toggleStops() {
  showStops.value = !showStops.value
  emit('show', showStops.value)
}

// Reset the map toggle whenever the focused driver/load changes so markers from
// the previous driver clear, then refetch both feeds.
function reloadAll() {
  showStops.value = false
  emit('show', false)
  emit('stops', [])
  fetchRange()
  fetchStops()
}

watch(() => [props.driver, props.loadId], reloadAll, { immediate: true })
</script>

<style scoped>
.fuel-finder {
  position: absolute;
  bottom: 10px;
  left: 10px;
  z-index: 1000;
  width: 270px;
  max-width: calc(100% - 20px);
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(8px);
  border-radius: 10px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: 'DM Sans', sans-serif;
}

.ff-toggle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  padding: 0.55rem 0.7rem;
  background: none;
  border: none;
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 700;
  color: #0f766e;
  cursor: pointer;
}
.fuel-finder:not(.collapsed) .ff-toggle {
  border-bottom: 1px solid #eef2f2;
}
.ff-pump {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: #0f766e;
  color: #fff;
  border-radius: 6px;
  flex-shrink: 0;
}
.ff-title-text { flex: 1 1 auto; min-width: 0; text-align: left; }
.ff-range-badge {
  font-size: 0.62rem;
  font-weight: 600;
  color: #065f46;
  background: #d1fae5;
  border-radius: 10px;
  padding: 0.05rem 0.45rem;
  white-space: nowrap;
  flex-shrink: 0;
}
.ff-chevron {
  font-size: 0.62rem;
  color: #94a3b8;
  transition: transform 0.2s;
  flex-shrink: 0;
}
.ff-chevron.open { transform: rotate(180deg); }

.ff-body {
  padding: 0.55rem 0.7rem 0.65rem;
  max-height: min(52vh, 420px);
  overflow-y: auto;
}

.ff-loading,
.ff-muted {
  font-size: 0.72rem;
  color: #94a3b8;
  padding: 0.35rem 0;
}
.ff-empty { text-align: center; }

/* #3 range readout with a donut ring */
.ff-range {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.15rem 0 0.5rem;
  border-bottom: 1px dashed #e5e7eb;
  margin-bottom: 0.5rem;
}
.ff-ring {
  position: relative;
  width: 52px;
  height: 52px;
  flex-shrink: 0;
}
.ff-ring svg { width: 52px; height: 52px; transform: rotate(-90deg); }
.ff-ring-bg { fill: none; stroke: #e5e7eb; stroke-width: 3.2; }
.ff-ring-fg {
  fill: none;
  stroke: #10b981;
  stroke-width: 3.2;
  stroke-linecap: round;
  transition: stroke-dasharray 0.4s ease;
}
.ff-ring.low .ff-ring-fg { stroke: #ef4444; }
.ff-ring-label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.72rem;
  font-weight: 700;
  color: #334155;
  font-variant-numeric: tabular-nums;
}
.ff-ring.low .ff-ring-label { color: #b91c1c; }
.ff-range-info { min-width: 0; }
.ff-range-miles { display: flex; align-items: baseline; gap: 0.3rem; }
.ff-range-num {
  font-size: 1.15rem;
  font-weight: 800;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
}
.ff-unit { font-size: 0.68rem; color: #94a3b8; font-weight: 600; }
.ff-range-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.15rem;
  font-size: 0.68rem;
  color: #64748b;
}
.ff-mpg { display: inline-flex; align-items: center; gap: 0.25rem; }
.ff-src {
  font-size: 0.55rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 0 0.28rem;
  border-radius: 4px;
}
.ff-src.src-eld { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
.ff-src.src-est { background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; }

/* #2 toggle + #4 list */
.ff-stops-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.35rem;
}
.ff-stops-title {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
}
.ff-map-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  background: none;
  border: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.64rem;
  font-weight: 700;
  color: #94a3b8;
  padding: 0;
}
.ff-map-toggle.on { color: #0f766e; }
.ff-switch {
  position: relative;
  width: 26px;
  height: 15px;
  border-radius: 999px;
  background: #cbd5e1;
  transition: background 0.15s;
}
.ff-map-toggle.on .ff-switch { background: #0f766e; }
.ff-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}
.ff-map-toggle.on .ff-knob { transform: translateX(11px); }

.ff-price-note {
  font-size: 0.62rem;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 6px;
  padding: 0.25rem 0.45rem;
  margin-bottom: 0.4rem;
}

.ff-stop-list { list-style: none; margin: 0; padding: 0; }
.ff-stop {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: 6px;
  padding: 0.35rem 0.4rem;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.12s;
}
.ff-stop:hover { background: #f0fdfa; }
.ff-stop-main { display: flex; flex-direction: column; min-width: 0; gap: 0.05rem; }
.ff-stop-name {
  font-size: 0.74rem;
  font-weight: 600;
  color: #1e293b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ff-stop-brand {
  font-size: 0.58rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #0f766e;
  margin-right: 0.25rem;
}
.ff-stop-addr {
  font-size: 0.64rem;
  color: #94a3b8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ff-stop-dist { font-size: 0.62rem; color: #64748b; font-weight: 600; }
.ff-stop-price {
  display: flex;
  align-items: baseline;
  gap: 0.1rem;
  flex-shrink: 0;
  white-space: nowrap;
}
.ff-price { font-size: 0.82rem; font-weight: 800; color: #0f766e; font-variant-numeric: tabular-nums; }
.ff-price.muted { color: #cbd5e1; }
.ff-price-unit { font-size: 0.58rem; color: #94a3b8; font-weight: 600; }

@media (max-width: 640px) {
  .fuel-finder { width: 220px; }
  .ff-body { max-height: 42vh; }
}
</style>
