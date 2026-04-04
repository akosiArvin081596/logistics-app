<template>
  <div class="route-map-wrap">
    <template v-if="!driverLatLng && !hasCoords">
      <div class="map-empty">No route coordinates available</div>
    </template>
    <template v-else-if="!driverLatLng && hasCoords && !dispatchMode">
      <div class="map-container gps-waiting">
        <div class="gps-overlay">
          <div class="gps-spinner"></div>
          <span>Locating your position...</span>
        </div>
      </div>
    </template>
    <template v-else>
      <div class="map-info" v-if="hasCoords && (distanceMiles != null || etaMinutes != null || driverDistanceInfo)">
        <span v-if="distanceMiles != null" class="info-item">{{ distanceMiles }} mi</span>
        <span v-if="etaMinutes != null" class="info-item">{{ etaFormatted }} ETA</span>
        <span v-if="driverDistanceInfo" :class="['info-item', driverDistanceInfo.mi > 500 ? 'info-danger' : 'info-warn']">{{ driverDistanceInfo.mi }} mi {{ driverDistanceInfo.label }}</span>
        <button class="expand-btn" @click="expanded = true" title="Expand map">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div v-if="!hasCoords" class="map-label">Your Current Location</div>
      <div ref="mapContainer" class="map-container"></div>

      <!-- Expanded fullscreen overlay -->
      <Teleport to="body">
        <div v-if="expanded" class="map-fullscreen-overlay" @click.self="expanded = false" @pointerdown.stop>
          <div class="map-fullscreen-panel" @click.stop>
            <div class="map-fullscreen-header">
              <div class="map-fullscreen-info">
                <span v-if="distanceMiles != null" class="info-item">{{ distanceMiles }} mi</span>
                <span v-if="etaMinutes != null" class="info-item">{{ etaFormatted }} ETA</span>
                <span v-if="driverDistanceInfo" :class="['info-item', driverDistanceInfo.mi > 500 ? 'info-danger' : 'info-warn']">{{ driverDistanceInfo.mi }} mi {{ driverDistanceInfo.label }}</span>
              </div>
              <button class="collapse-btn" @click="expanded = false" title="Close">✕</button>
            </div>
            <div ref="expandedMapContainer" class="map-fullscreen-body"></div>
          </div>
        </div>
      </Teleport>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useApi } from '../../composables/useApi'
import { useGoogleMaps, createDotPin } from '../../composables/useGoogleMaps'

const props = defineProps({
  load: { type: Object, required: true },
  headers: { type: Array, default: () => [] },
  driverPosition: { type: Object, default: null },
  dispatchMode: { type: Boolean, default: false },
})

const api = useApi()
const { createMap } = useGoogleMaps()
const mapContainer = ref(null)
const expandedMapContainer = ref(null)
const expanded = ref(false)
const routePoints = ref([])
const distanceMiles = ref(null)
const etaMinutes = ref(null)
const etaFormatted = computed(() => {
  if (etaMinutes.value == null) return null
  const m = Math.round(etaMinutes.value)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
})

let map = null
let expandedMap = null
let originMarker = null
let destMarker = null
let driverMarker = null
let routeLine = null
let routeAnim = null
let exOriginMarker = null
let exDestMarker = null
let exDriverMarker = null
let exRouteLine = null
let exRouteAnim = null

function animatePolyline(line) {
  let offset = 0
  return setInterval(() => {
    offset = (offset + 1) % 200
    const icons = line.get('icons')
    icons[0].offset = (offset / 2) + '%'
    line.set('icons', icons)
  }, 80)
}

function animateMarker(marker, from, to, duration = 1000) {
  if (!marker || !from || !to) return
  const start = performance.now()
  function step(now) {
    const t = Math.min((now - start) / duration, 1)
    const ease = t * (2 - t) // ease-out quad
    const lat = from.lat + (to.lat - from.lat) * ease
    const lng = from.lng + (to.lng - from.lng) * ease
    marker.position = { lat, lng }
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

function findCol(regex) {
  return (props.headers || []).find(h => regex.test(h)) || null
}

const originLatCol = computed(() => findCol(/origin.*lat|pickup.*lat|shipper.*lat/i))
const originLngCol = computed(() => findCol(/origin.*l(on|ng)|pickup.*l(on|ng)|shipper.*l(on|ng)/i))
const destLatCol = computed(() => findCol(/dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i))
const destLngCol = computed(() => findCol(/dest.*l(on|ng)|drop.*l(on|ng)|receiver.*l(on|ng)|delivery.*l(on|ng)/i))

const originLatLng = computed(() => {
  if (!props.load || !originLatCol.value || !originLngCol.value) return null
  const lat = parseFloat(props.load[originLatCol.value])
  const lng = parseFloat(props.load[originLngCol.value])
  return !isNaN(lat) && !isNaN(lng) ? { lat, lng } : null
})
const destLatLng = computed(() => {
  if (!props.load || !destLatCol.value || !destLngCol.value) return null
  const lat = parseFloat(props.load[destLatCol.value])
  const lng = parseFloat(props.load[destLngCol.value])
  return !isNaN(lat) && !isNaN(lng) ? { lat, lng } : null
})
const driverLatLng = computed(() => {
  if (!props.driverPosition) return null
  return { lat: props.driverPosition.latitude, lng: props.driverPosition.longitude }
})

const statusCol = computed(() => (props.headers || []).find(h => /^status$/i.test(h)) || null)
const loadStatus = computed(() => !props.load || !statusCol.value ? '' : (props.load[statusCol.value] || '').trim().toLowerCase())
const isDelivered = computed(() => /^(delivered|completed|pod received)$/i.test(loadStatus.value))
const hasCoords = computed(() => destLatLng.value != null && (!isDelivered.value || props.dispatchMode))
const isPrePickup = computed(() => /^(dispatched|assigned|new|pending)$/i.test(loadStatus.value))

function haversineMi(a, b) {
  const R = 3959
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return (R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))).toFixed(1)
}

const driverDistanceInfo = computed(() => {
  if (!driverLatLng.value) return null
  if (isPrePickup.value && originLatLng.value) return { mi: haversineMi(driverLatLng.value, originLatLng.value), label: 'to Pickup' }
  if (!isPrePickup.value && !isDelivered.value && destLatLng.value) return { mi: haversineMi(driverLatLng.value, destLatLng.value), label: 'to Drop-off' }
  return null
})

const originAddrCol = computed(() => (props.headers || []).find(h => /origin|pickup|shipper/i.test(h) && !/lat|lng|lon/i.test(h)) || null)
const destAddrCol = computed(() => (props.headers || []).find(h => /dest|drop|receiver|delivery/i.test(h) && !/lat|lng|lon|date|time|appt|eta/i.test(h)) || null)
const loadIdCol = computed(() => findCol(/load.?id|job.?id/i))
const driverColName = computed(() => findCol(/driver/i))

const originAddr = computed(() => props.load && originAddrCol.value ? props.load[originAddrCol.value] || '' : '')
const destAddr = computed(() => props.load && destAddrCol.value ? props.load[destAddrCol.value] || '' : '')
const loadIdValue = computed(() => props.load && loadIdCol.value ? props.load[loadIdCol.value] || '' : '')
const driverName = computed(() => props.load && driverColName.value ? props.load[driverColName.value] || '' : '')

function clearMapObjects() {
  if (routeAnim) { clearInterval(routeAnim); routeAnim = null }
  if (originMarker) { originMarker.map = null; originMarker = null }
  if (destMarker) { destMarker.map = null; destMarker = null }
  if (driverMarker) { driverMarker.map = null; driverMarker = null }
  if (routeLine) { routeLine.setMap(null); routeLine = null }
}

function renderMarkers() {
  if (!map) return
  clearMapObjects()

  const pickedUp = /^(at shipper|loading|in transit|at receiver|unloading)$/i.test(loadStatus.value)
  // After pickup, hide origin marker — driver is now Point A
  if (originLatLng.value && hasCoords.value && !pickedUp) {
    originMarker = new google.maps.marker.AdvancedMarkerElement({ position: originLatLng.value, map, content: createDotPin('#16a34a', 14), title: 'Pickup' })
  }
  if (destLatLng.value && hasCoords.value) {
    destMarker = new google.maps.marker.AdvancedMarkerElement({ position: destLatLng.value, map, content: createDotPin('#dc2626', 14), title: 'Drop-off' })
  }
  if (driverLatLng.value) {
    driverMarker = new google.maps.marker.AdvancedMarkerElement({ position: driverLatLng.value, map, content: createDotPin('#2563eb', 16), title: driverName.value || 'Driver' })
  }

  if (routePoints.value.length >= 2) {
    const path = routePoints.value.map(p => ({ lat: p.latitude, lng: p.longitude }))
    // After pickup, start polyline from driver; before pickup, from origin
    if (pickedUp && driverLatLng.value) path.unshift(driverLatLng.value)
    else if (originLatLng.value && hasCoords.value) path.unshift(originLatLng.value)
    if (destLatLng.value && hasCoords.value) path.push(destLatLng.value)
    routeLine = new google.maps.Polyline({
      path,
      strokeColor: '#ffffff', strokeOpacity: 0.9, strokeWeight: 5,
      map,
      icons: [{ icon: { path: 'M 0,-1 0,1', strokeColor: '#2563eb', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '20px' }],
    })
    routeAnim = animatePolyline(routeLine)
  }

  fitBounds()
}

function fitBounds() {
  if (!map) return
  const bounds = new google.maps.LatLngBounds()
  let count = 0
  if (originLatLng.value) { bounds.extend(originLatLng.value); count++ }
  if (destLatLng.value) { bounds.extend(destLatLng.value); count++ }
  if (driverLatLng.value) { bounds.extend(driverLatLng.value); count++ }
  if (count >= 2) map.fitBounds(bounds, 50)
  else if (count === 1) { map.setCenter(bounds.getCenter()); map.setZoom(12) }
}

let initialFitDone = false

async function fetchRoute(doFit = false) {
  routePoints.value = []
  distanceMiles.value = null
  etaMinutes.value = null
  if (!destLatLng.value) return

  const pickedUp = /^(at shipper|loading|in transit|at receiver|unloading)$/i.test(loadStatus.value)
  const from = pickedUp && driverLatLng.value ? driverLatLng.value : originLatLng.value
  if (!from) return

  try {
    let data
    try {
      data = await api.get(`/api/route?fromLat=${from.lat}&fromLng=${from.lng}&toLat=${destLatLng.value.lat}&toLng=${destLatLng.value.lng}`)
    } catch { /* silent */ }
    if ((!data || !data.route) && originLatLng.value && from !== originLatLng.value) {
      try {
        data = await api.get(`/api/route?fromLat=${originLatLng.value.lat}&fromLng=${originLatLng.value.lng}&toLat=${destLatLng.value.lat}&toLng=${destLatLng.value.lng}`)
      } catch { /* silent */ }
    }
    if (!data) return
    if (data.route && data.route.length >= 2) routePoints.value = data.route
    distanceMiles.value = data.distanceMiles
    etaMinutes.value = data.etaMinutes
    renderMarkers()
  } catch { /* silent */ }
}

let lastRoutePos = null
let lastRouteTime = 0
let prevDriverPos = null
watch(() => props.driverPosition, (pos) => {
  if (!pos || !destLatLng.value) return
  const to = { lat: pos.latitude, lng: pos.longitude }
  const from = prevDriverPos || to
  if (driverMarker && map) animateMarker(driverMarker, from, to)
  if (exDriverMarker && expandedMap) animateMarker(exDriverMarker, from, to)
  prevDriverPos = to
  if (!lastRoutePos) { lastRoutePos = pos; lastRouteTime = Date.now(); fetchRoute(true); return }
  const dist = haversineMi({ lat: pos.latitude, lng: pos.longitude }, { lat: lastRoutePos.latitude, lng: lastRoutePos.longitude })
  if (dist > 0.06 && Date.now() - lastRouteTime >= 60000) { lastRoutePos = pos; lastRouteTime = Date.now(); fetchRoute() }
}, { deep: true })

// Re-fetch route when load status changes (e.g., geofence triggers "At Shipper" → driver becomes Point A)
watch(loadStatus, (newStatus, oldStatus) => {
  if (newStatus !== oldStatus && map && destLatLng.value) {
    lastRoutePos = null
    lastRouteTime = 0
    fetchRoute(true)
  }
})

function renderExpandedMap() {
  if (!expandedMap) return
  if (exRouteAnim) { clearInterval(exRouteAnim); exRouteAnim = null }
  if (exOriginMarker) { exOriginMarker.map = null; exOriginMarker = null }
  if (exDestMarker) { exDestMarker.map = null; exDestMarker = null }
  if (exDriverMarker) { exDriverMarker.map = null; exDriverMarker = null }
  if (exRouteLine) { exRouteLine.setMap(null); exRouteLine = null }

  const exPickedUp = /^(at shipper|loading|in transit|at receiver|unloading)$/i.test(loadStatus.value)
  if (originLatLng.value && hasCoords.value && !exPickedUp) {
    exOriginMarker = new google.maps.marker.AdvancedMarkerElement({ position: originLatLng.value, map: expandedMap, content: createDotPin('#16a34a', 14), title: 'Pickup' })
  }
  if (destLatLng.value && hasCoords.value) {
    exDestMarker = new google.maps.marker.AdvancedMarkerElement({ position: destLatLng.value, map: expandedMap, content: createDotPin('#dc2626', 14), title: 'Drop-off' })
  }
  if (driverLatLng.value) {
    exDriverMarker = new google.maps.marker.AdvancedMarkerElement({ position: driverLatLng.value, map: expandedMap, content: createDotPin('#2563eb', 16), title: driverName.value || 'Driver' })
  }
  if (routePoints.value.length >= 2) {
    const path = routePoints.value.map(p => ({ lat: p.latitude, lng: p.longitude }))
    if (exPickedUp && driverLatLng.value) path.unshift(driverLatLng.value)
    else if (originLatLng.value && hasCoords.value) path.unshift(originLatLng.value)
    if (destLatLng.value && hasCoords.value) path.push(destLatLng.value)
    exRouteLine = new google.maps.Polyline({
      path,
      strokeColor: '#ffffff', strokeOpacity: 0.9, strokeWeight: 5,
      map: expandedMap,
      icons: [{ icon: { path: 'M 0,-1 0,1', strokeColor: '#2563eb', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '20px' }],
    })
    exRouteAnim = animatePolyline(exRouteLine)
  }
  const bounds = new google.maps.LatLngBounds()
  let count = 0
  if (originLatLng.value) { bounds.extend(originLatLng.value); count++ }
  if (destLatLng.value) { bounds.extend(destLatLng.value); count++ }
  if (driverLatLng.value) { bounds.extend(driverLatLng.value); count++ }
  if (count >= 2) expandedMap.fitBounds(bounds, 50)
  else if (count === 1) { expandedMap.setCenter(bounds.getCenter()); expandedMap.setZoom(12) }
}

watch(expanded, async (val) => {
  if (!val) { if (exRouteAnim) { clearInterval(exRouteAnim); exRouteAnim = null }; expandedMap = null; return }
  await nextTick()
  if (!expandedMapContainer.value) return
  const center = map ? map.getCenter().toJSON() : { lat: 0, lng: 0 }
  expandedMap = await createMap(expandedMapContainer.value, {
    zoom: map ? map.getZoom() : 5, center, mapTypeId: 'hybrid',
    zoomControl: true, gestureHandling: 'greedy',
    mapTypeControl: true,
    mapTypeControlOptions: { style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR, position: google.maps.ControlPosition.TOP_LEFT },
  })
  google.maps.event.addListenerOnce(expandedMap, 'idle', () => renderExpandedMap())
})

function focusOn(lat, lng) { if (map) { map.panTo({ lat, lng }); map.setZoom(15) } }
defineExpose({ focusOn })

async function initMap() {
  if (!mapContainer.value) return
  const center = originLatLng.value && destLatLng.value
    ? { lat: (originLatLng.value.lat + destLatLng.value.lat) / 2, lng: (originLatLng.value.lng + destLatLng.value.lng) / 2 }
    : originLatLng.value || destLatLng.value || driverLatLng.value || { lat: 0, lng: 0 }

  map = await createMap(mapContainer.value, { zoom: 5, center, mapTypeId: 'hybrid' })
  renderMarkers()
  if (props.dispatchMode && hasCoords.value) fetchRoute(true)
  else if (hasCoords.value && driverLatLng.value) fetchRoute(true)
}

watch(() => [hasCoords.value, driverLatLng.value], () => {
  nextTick(() => { if (mapContainer.value && !map) initMap() })
})

onMounted(() => {
  if ((hasCoords.value && (driverLatLng.value || props.dispatchMode)) || driverLatLng.value) {
    nextTick(() => initMap())
  }
})
</script>

<style scoped>
.route-map-wrap { width: 100%; }
.map-container { height: 250px; border-radius: 8px; overflow: hidden; }
.map-info { display: flex; gap: 0.75rem; margin-bottom: 0.5rem; }
.info-item { font-size: 0.82rem; font-weight: 600; color: var(--text); background: var(--bg); padding: 0.25rem 0.6rem; border-radius: 6px; }
.info-warn { color: #b45309; background: #fef3c7; }
.info-danger { color: #dc2626; background: #fee2e2; }
.map-empty { text-align: center; color: var(--text-dim); font-size: 0.8rem; padding: 1rem 0; }
.map-label { font-size: 0.78rem; font-weight: 600; color: var(--text-dim); margin-bottom: 0.4rem; }
.gps-waiting { display: flex; align-items: center; justify-content: center; background: var(--bg, #f5f6fa); border: 1px solid var(--border, #e5e7eb); }
.gps-overlay { display: flex; flex-direction: column; align-items: center; gap: 0.6rem; color: var(--text-dim); font-size: 0.82rem; font-weight: 500; }
.gps-spinner { width: 28px; height: 28px; border: 3px solid var(--border, #e5e7eb); border-top-color: var(--accent, #6366f1); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.expand-btn { margin-left: auto; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 6px; border: none; background: var(--bg, #f5f6fa); color: var(--text-dim, #6b7280); cursor: pointer; transition: background 0.15s, color 0.15s; }
.expand-btn:hover { background: var(--accent, #0ea5e9); color: #fff; }

.map-fullscreen-overlay { position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; pointer-events: auto; }
.map-fullscreen-panel { width: 92vw; height: 85vh; max-width: 1400px; background: #fff; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 25px 50px rgba(0,0,0,0.25); pointer-events: auto; }
.map-fullscreen-header { display: flex; align-items: center; padding: 0.75rem 1rem; border-bottom: 1px solid #e5e7eb; }
.map-fullscreen-info { display: flex; gap: 0.75rem; flex: 1; }
.collapse-btn { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 6px; border: 1px solid #e5e7eb; background: #fff; font-size: 1rem; color: #6b7280; cursor: pointer; transition: background 0.15s, color 0.15s; }
.collapse-btn:hover { background: #f3f4f6; color: #111; }
.map-fullscreen-body { flex: 1; }
</style>
