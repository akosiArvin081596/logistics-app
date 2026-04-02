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
        <span v-if="etaMinutes != null" class="info-item">{{ etaMinutes }} min ETA</span>
        <span v-if="driverDistanceInfo" :class="['info-item', driverDistanceInfo.mi > 500 ? 'info-danger' : 'info-warn']">{{ driverDistanceInfo.mi }} mi {{ driverDistanceInfo.label }}</span>
      </div>
      <div v-if="!hasCoords" class="map-label">Your Current Location</div>
      <div ref="mapContainer" class="map-container"></div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useApi } from '../../composables/useApi'
import { useGoogleMaps } from '../../composables/useGoogleMaps'

const props = defineProps({
  load: { type: Object, required: true },
  headers: { type: Array, default: () => [] },
  driverPosition: { type: Object, default: null },
  dispatchMode: { type: Boolean, default: false },
})

const api = useApi()
const { createMap } = useGoogleMaps()
const mapContainer = ref(null)
const routePoints = ref([])
const distanceMiles = ref(null)
const etaMinutes = ref(null)

let map = null
let originMarker = null
let destMarker = null
let driverMarker = null
let routeLine = null

function findCol(regex) {
  return (props.headers || []).find(h => regex.test(h)) || null
}

const originLatCol = computed(() => findCol(/origin.*lat|pickup.*lat|shipper.*lat/i))
const originLngCol = computed(() => findCol(/origin.*l(on|ng)|pickup.*l(on|ng)|shipper.*l(on|ng)/i))
const destLatCol = computed(() => findCol(/dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i))
const destLngCol = computed(() => findCol(/dest.*l(on|ng)|drop.*l(on|ng)|receiver.*l(on|ng)|delivery.*l(on|ng)/i))

const originLatLng = computed(() => {
  if (!originLatCol.value || !originLngCol.value) return null
  const lat = parseFloat(props.load[originLatCol.value])
  const lng = parseFloat(props.load[originLngCol.value])
  return !isNaN(lat) && !isNaN(lng) ? { lat, lng } : null
})
const destLatLng = computed(() => {
  if (!destLatCol.value || !destLngCol.value) return null
  const lat = parseFloat(props.load[destLatCol.value])
  const lng = parseFloat(props.load[destLngCol.value])
  return !isNaN(lat) && !isNaN(lng) ? { lat, lng } : null
})
const driverLatLng = computed(() => {
  if (!props.driverPosition) return null
  return { lat: props.driverPosition.latitude, lng: props.driverPosition.longitude }
})

const statusCol = computed(() => (props.headers || []).find(h => /^status$/i.test(h)) || null)
const loadStatus = computed(() => statusCol.value ? (props.load[statusCol.value] || '').trim().toLowerCase() : '')
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

const originAddr = computed(() => originAddrCol.value ? props.load[originAddrCol.value] || '' : '')
const destAddr = computed(() => destAddrCol.value ? props.load[destAddrCol.value] || '' : '')
const loadIdValue = computed(() => loadIdCol.value ? props.load[loadIdCol.value] || '' : '')
const driverName = computed(() => driverColName.value ? props.load[driverColName.value] || '' : '')

function dotIcon(color, size = 14) {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: size / 2,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: '#ffffff',
    strokeWeight: 2,
  }
}

function clearMapObjects() {
  if (originMarker) { originMarker.setMap(null); originMarker = null }
  if (destMarker) { destMarker.setMap(null); destMarker = null }
  if (driverMarker) { driverMarker.setMap(null); driverMarker = null }
  if (routeLine) { routeLine.setMap(null); routeLine = null }
}

function renderMarkers() {
  if (!map) return
  clearMapObjects()

  if (originLatLng.value && hasCoords.value) {
    originMarker = new google.maps.Marker({ position: originLatLng.value, map, icon: dotIcon('#16a34a', 14), title: 'Pickup' })
  }
  if (destLatLng.value && hasCoords.value) {
    destMarker = new google.maps.Marker({ position: destLatLng.value, map, icon: dotIcon('#dc2626', 14), title: 'Drop-off' })
  }
  if (driverLatLng.value) {
    driverMarker = new google.maps.Marker({ position: driverLatLng.value, map, icon: dotIcon('#2563eb', 16), title: driverName.value || 'Driver' })
  }

  if (routePoints.value.length >= 2) {
    routeLine = new google.maps.Polyline({
      path: routePoints.value.map(p => ({ lat: p.latitude, lng: p.longitude })),
      strokeColor: '#000000', strokeOpacity: 0.7, strokeWeight: 5,
      map,
      icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '20px' }],
    })
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
watch(() => props.driverPosition, (pos) => {
  if (!pos || !destLatLng.value) return
  if (driverMarker && map) driverMarker.setPosition({ lat: pos.latitude, lng: pos.longitude })
  if (!lastRoutePos) { lastRoutePos = pos; lastRouteTime = Date.now(); fetchRoute(true); return }
  const dist = haversineMi({ lat: pos.latitude, lng: pos.longitude }, { lat: lastRoutePos.latitude, lng: lastRoutePos.longitude })
  if (dist > 0.06 && Date.now() - lastRouteTime >= 60000) { lastRoutePos = pos; lastRouteTime = Date.now(); fetchRoute() }
}, { deep: true })

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
</style>
