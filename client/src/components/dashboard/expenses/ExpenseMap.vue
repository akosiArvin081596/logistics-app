<template>
  <div class="exp-card">
    <div class="exp-card-head">
      <div class="exp-card-titles">
        <h3 class="exp-card-title">Expense Map</h3>
        <div class="exp-card-sub">Where receipts were logged</div>
      </div>
      <!-- Legend chips: one per type present, same TYPE_COLORS hex as its pins -->
      <div v-if="typesPresent.length" class="map-legend" role="list" aria-label="Expense types on map">
        <span v-for="t in typesPresent" :key="t" class="legend-chip" role="listitem">
          <span class="legend-dot" :style="{ background: typeColor(t) }" aria-hidden="true"></span>
          {{ t }}
        </span>
      </div>
    </div>

    <div class="map-shell">
      <div ref="mapEl" class="map-canvas"></div>
      <div v-if="mapFailed" class="map-overlay">
        <div class="overlay-title">Map unavailable</div>
        <div class="overlay-sub">Pins will return once the Maps API loads.</div>
      </div>
      <div v-else-if="!validLocations.length" class="map-overlay">
        <div class="overlay-sub">
          Map pins appear once expenses are geocoded &mdash; new receipts geocode automatically;
          run the backfill for history.
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// Google map of geocoded expenses — replicates the LoadsMapView pattern:
// createMap via useGoogleMaps, AdvancedMarkerElement + createDotPin, a shared
// InfoWindow on gmp-click, markers[] + clearOverlays, fitBounds(bounds, 40),
// and a `visible` watcher that triggers resize + re-fit (the map lives behind
// a tab, so it can mount at zero size).
//
// SECURITY: InfoWindow content is built with document.createElement +
// textContent ONLY. `vendor` (and city/driver) are OCR/user-entered strings —
// they must never pass through innerHTML.
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useGoogleMaps, createDotPin } from '../../../composables/useGoogleMaps'
import { TYPE_COLORS, resolveTypeKey, typeColor } from './typeColors'

const props = defineProps({
  // Rows: { id, lat, lng, type, amount, vendor, city, state, date, driver }
  locations: { type: Array, default: () => [] },
  visible: { type: Boolean, default: true },
})

const { createMap } = useGoogleMaps()
const mapEl = ref(null)
const mapFailed = ref(false)
let map = null
let markers = []
let infoWindow = null
let initializing = false

const validLocations = computed(() =>
  (props.locations || []).filter(
    (l) => l && Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng))
  )
)

// Ordered per TYPE_COLORS key order so the legend reads in the same fixed
// entity order as the donut's.
const typesPresent = computed(() => {
  const present = new Set(validLocations.value.map((l) => resolveTypeKey(l.type)))
  return Object.keys(TYPE_COLORS).filter((k) => present.has(k))
})

// Individual receipts keep their cents (aggregate cards use formatCurrency's
// whole dollars; a $28.45 food receipt shouldn't display as $28).
function fmtAmount(v) {
  const n = Number(v || 0)
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDate(iso) {
  const [yy, mm, dd] = String(iso || '').split('-')
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const name = names[(parseInt(mm, 10) || 0) - 1]
  if (!name || !yy || !dd) return String(iso || '')
  return `${name} ${parseInt(dd, 10)}, ${yy}`
}

// textContent-only InfoWindow body — no HTML strings anywhere near user data.
function buildInfoContent(loc) {
  const root = document.createElement('div')
  root.style.cssText = 'font-family:DM Sans,sans-serif;font-size:0.8rem;line-height:1.5;max-width:230px;color:#1a1d27;'

  const addLine = (text, style) => {
    if (!text) return
    const div = document.createElement('div')
    if (style) div.style.cssText = style
    div.textContent = text
    root.appendChild(div)
  }

  addLine(String(loc.vendor || 'Unknown vendor'), 'font-weight:700;')
  addLine(fmtAmount(loc.amount), "font-family:'JetBrains Mono',monospace;font-weight:600;")
  addLine(resolveTypeKey(loc.type), 'color:#6b7085;font-size:0.72rem;')
  const place = [loc.city, loc.state].filter(Boolean).join(', ')
  addLine(place, 'color:#6b7085;font-size:0.72rem;')
  addLine(fmtDate(loc.date), 'color:#6b7085;font-size:0.72rem;')
  addLine(loc.driver ? `Driver: ${loc.driver}` : '', 'color:#6b7085;font-size:0.72rem;')

  return root
}

function clearOverlays() {
  markers.forEach((m) => { m.map = null })
  markers = []
  if (infoWindow) infoWindow.close()
}

function render() {
  if (!map) return
  clearOverlays()
  const bounds = new google.maps.LatLngBounds()
  let count = 0

  for (const loc of validLocations.value) {
    const position = { lat: Number(loc.lat), lng: Number(loc.lng) }
    const marker = new google.maps.marker.AdvancedMarkerElement({
      position,
      map,
      content: createDotPin(typeColor(loc.type)),
      title: `${loc.vendor || 'Expense'} — ${fmtAmount(loc.amount)}`,
    })
    marker.addEventListener('gmp-click', () => {
      if (!infoWindow) infoWindow = new google.maps.InfoWindow()
      infoWindow.setContent(buildInfoContent(loc))
      infoWindow.open({ map, anchor: marker })
    })
    markers.push(marker)
    bounds.extend(position)
    count++
  }

  if (count >= 2) map.fitBounds(bounds, 40)
  else if (count === 1) {
    map.setCenter(bounds.getCenter())
    map.setZoom(8)
  }
}

async function initMap() {
  if (!mapEl.value || map || mapFailed.value || initializing) return
  initializing = true
  try {
    map = await createMap(mapEl.value, { zoom: 5, center: { lat: 39.8, lng: -98.5 } })
    render()
  } catch {
    mapFailed.value = true
  } finally {
    initializing = false
  }
}

// The panel replaces the whole analytics object on every (re)fetch, so the
// array reference changes — no deep watch needed.
watch(
  () => props.locations,
  () => {
    if (map) render()
    else if (validLocations.value.length && props.visible) nextTick(() => initMap())
  }
)

// Behind a tab: when we become visible, the container may have just gained
// real dimensions — resize the map and re-fit the pins (or init lazily).
watch(
  () => props.visible,
  (vis) => {
    if (!vis) return
    nextTick(() => {
      if (map) {
        google.maps.event.trigger(map, 'resize')
        render()
      } else if (validLocations.value.length) {
        initMap()
      }
    })
  }
)

onMounted(() => {
  // Lazy init: don't load the Maps JS API just to sit under an empty overlay.
  if (props.visible && validLocations.value.length) nextTick(() => initMap())
})

onBeforeUnmount(() => {
  clearOverlays()
  map = null
  infoWindow = null
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

.map-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.7rem;
  align-items: center;
}
.legend-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-dim);
  white-space: nowrap;
}
.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--surface);
  box-shadow: 0 0 0 1px var(--border);
  flex-shrink: 0;
}

.map-shell {
  position: relative;
  height: 340px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
}
@media (max-width: 767px) {
  .map-shell { height: 260px; }
}
.map-canvas {
  width: 100%;
  height: 100%;
}
.map-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  background: var(--bg);
  text-align: center;
  padding: 1.5rem;
}
.overlay-title {
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--text);
}
.overlay-sub {
  font-size: 0.78rem;
  color: var(--text-dim);
  line-height: 1.5;
  max-width: 420px;
}
</style>
