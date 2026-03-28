<template>
  <div class="route-map-wrap">
    <!-- Waiting for GPS -->
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
    <!-- Map: driver location, dispatch mode, OR full route -->
    <template v-else>
      <div class="map-info" v-if="hasCoords && (distanceKm != null || etaMinutes != null)">
        <span v-if="distanceKm != null" class="info-item">{{ distanceKm }} km</span>
        <span v-if="etaMinutes != null" class="info-item">{{ etaMinutes }} min ETA</span>
      </div>
      <div v-if="!hasCoords" class="map-label">Your Current Location</div>
      <div class="map-container">
        <l-map
          ref="mapRef"
          :zoom="14"
          :center="mapCenter"
          :use-global-leaflet="false"
          style="height: 100%; width: 100%;"
          @ready="onMapReady"
        >
          <l-tile-layer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />

          <!-- Planned route (only when active load) -->
          <l-polyline
            v-if="hasCoords && routePoints.length >= 2"
            :lat-lngs="routePoints"
            color="#000000"
            :weight="5"
            :opacity="0.7"
            dashArray="12, 8"
            className="route-animate"
          />

          <!-- Origin marker (green) -->
          <l-marker v-if="hasCoords && originLatLng" :lat-lng="originLatLng" :icon="originIcon">
            <l-popup>
              <div class="marker-popup">
                <strong>Pickup</strong>
                <div v-if="originAddr" class="popup-address">{{ originAddr }}</div>
                <div v-if="dispatchMode && loadIdValue" class="popup-detail">{{ loadIdValue }}</div>
              </div>
            </l-popup>
          </l-marker>

          <!-- Destination marker (red) -->
          <l-marker v-if="hasCoords && destLatLng" :lat-lng="destLatLng" :icon="destIcon">
            <l-popup>
              <div class="marker-popup">
                <strong>Drop-off</strong>
                <div v-if="destAddr" class="popup-address">{{ destAddr }}</div>
                <div v-if="dispatchMode && loadIdValue" class="popup-detail">{{ loadIdValue }}</div>
              </div>
            </l-popup>
          </l-marker>

          <!-- Driver position (blue) -->
          <l-marker v-if="driverLatLng" :lat-lng="driverLatLng" :icon="driverIcon">
            <l-popup>
              <div class="marker-popup">
                <strong>{{ dispatchMode && driverName ? driverName : 'You are here' }}</strong>
                <div v-if="dispatchMode && loadIdValue" class="popup-detail">{{ loadIdValue }}</div>
              </div>
            </l-popup>
          </l-marker>
        </l-map>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useApi } from '../../composables/useApi'
import 'leaflet/dist/leaflet.css'
import { LMap, LTileLayer, LMarker, LPopup, LPolyline } from '@vue-leaflet/vue-leaflet'
import L from 'leaflet'

const props = defineProps({
  load: { type: Object, required: true },
  headers: { type: Array, default: () => [] },
  driverPosition: { type: Object, default: null },
  dispatchMode: { type: Boolean, default: false },
})

const api = useApi()
const mapRef = ref(null)
const routePoints = ref([])
const distanceKm = ref(null)
const etaMinutes = ref(null)

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
  return !isNaN(lat) && !isNaN(lng) ? [lat, lng] : null
})

const destLatLng = computed(() => {
  if (!destLatCol.value || !destLngCol.value) return null
  const lat = parseFloat(props.load[destLatCol.value])
  const lng = parseFloat(props.load[destLngCol.value])
  return !isNaN(lat) && !isNaN(lng) ? [lat, lng] : null
})

const driverLatLng = computed(() => {
  if (!props.driverPosition) return null
  return [props.driverPosition.latitude, props.driverPosition.longitude]
})

const statusCol = computed(() => (props.headers || []).find(h => /^status$/i.test(h)) || null)
const loadStatus = computed(() => statusCol.value ? (props.load[statusCol.value] || '').trim().toLowerCase() : '')
const isDelivered = computed(() => /^(delivered|completed|pod received)$/i.test(loadStatus.value))

const hasCoords = computed(() => destLatLng.value != null && (!isDelivered.value || props.dispatchMode))
const waitingForGps = computed(() => hasCoords.value && !driverLatLng.value)

// Address columns (for popup display)
const originAddrCol = computed(() => (props.headers || []).find(h => /origin|pickup|shipper/i.test(h) && !/lat|lng|lon/i.test(h)) || null)
const destAddrCol = computed(() => (props.headers || []).find(h => /dest|drop|receiver|delivery/i.test(h) && !/lat|lng|lon|date|time|appt|eta/i.test(h)) || null)
const loadIdCol = computed(() => findCol(/load.?id|job.?id/i))
const driverColName = computed(() => findCol(/driver/i))

const originAddr = computed(() => originAddrCol.value ? props.load[originAddrCol.value] || '' : '')
const destAddr = computed(() => destAddrCol.value ? props.load[destAddrCol.value] || '' : '')
const loadIdValue = computed(() => loadIdCol.value ? props.load[loadIdCol.value] || '' : '')
const driverName = computed(() => driverColName.value ? props.load[driverColName.value] || '' : '')

const mapCenter = computed(() => {
  if (driverLatLng.value) return driverLatLng.value
  if (originLatLng.value) return originLatLng.value
  if (destLatLng.value) return destLatLng.value
  return [8.95, 125.53]
})

// Custom icons
const originIcon = L.divIcon({
  className: 'endpoint-icon',
  html: '<div class="endpoint-dot" style="background:#16a34a;"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
})
const destIcon = L.divIcon({
  className: 'endpoint-icon',
  html: '<div class="endpoint-dot" style="background:#dc2626;"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
})
const driverIcon = L.divIcon({
  className: 'endpoint-icon',
  html: '<div class="endpoint-dot" style="background:#2563eb;border-color:#bfdbfe;"></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
})

function onMapReady() {
  setTimeout(() => {
    if (mapRef.value?.leafletObject) {
      mapRef.value.leafletObject.invalidateSize()
    }
  }, 200)
}

let initialFitDone = false

async function fetchRoute(fitBounds = false) {
  routePoints.value = []
  distanceKm.value = null
  etaMinutes.value = null
  if (!destLatLng.value) return

  const from = driverLatLng.value || originLatLng.value
  if (!from) return

  try {
    let data
    try {
      data = await api.get(`/api/route?fromLat=${from[0]}&fromLng=${from[1]}&toLat=${destLatLng.value[0]}&toLng=${destLatLng.value[1]}`)
    } catch {
      // Fallback: route from origin to destination if driver position route fails
      if (originLatLng.value && from !== originLatLng.value) {
        data = await api.get(`/api/route?fromLat=${originLatLng.value[0]}&fromLng=${originLatLng.value[1]}&toLat=${destLatLng.value[0]}&toLng=${destLatLng.value[1]}`)
      }
    }
    if (!data) return
    routePoints.value = (data.route || []).map(p => [p.latitude, p.longitude])
    distanceKm.value = data.distanceKm
    etaMinutes.value = data.etaMinutes

    // Only fit bounds on initial load, not on reroutes
    if (fitBounds && !initialFitDone) {
      initialFitDone = true
      nextTick(() => {
        const map = mapRef.value?.leafletObject
        if (map) {
          const allPoints = [...routePoints.value]
          if (originLatLng.value) allPoints.push(originLatLng.value)
          if (destLatLng.value) allPoints.push(destLatLng.value)
          if (driverLatLng.value) allPoints.push(driverLatLng.value)
          if (allPoints.length >= 2) {
            map.fitBounds(allPoints, { padding: [30, 30], animate: false })
          }
        }
      })
    }
  } catch {
    // silent
  }
}

// Reroute when driver position changes significantly
let lastRoutePos = null
watch(() => props.driverPosition, (pos) => {
  if (!pos || !destLatLng.value) return
  if (!lastRoutePos) {
    lastRoutePos = pos
    fetchRoute(true)
    return
  }
  const dist = L.latLng(pos.latitude, pos.longitude).distanceTo(
    L.latLng(lastRoutePos.latitude, lastRoutePos.longitude)
  )
  if (dist > 100) {
    lastRoutePos = pos
    fetchRoute()
  }
}, { deep: true })

onMounted(() => {
  if (props.dispatchMode && hasCoords.value) {
    fetchRoute(true)
  } else if (hasCoords.value && driverLatLng.value) {
    fetchRoute(true)
  }
})
</script>

<style scoped>
.route-map-wrap {
  width: 100%;
}
.map-container {
  height: 250px;
  border-radius: 8px;
  overflow: hidden;
}
.map-info {
  display: flex;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}
.info-item {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text);
  background: var(--bg);
  padding: 0.25rem 0.6rem;
  border-radius: 6px;
}
.marker-popup {
  font-family: 'DM Sans', sans-serif;
  font-size: 0.82rem;
  line-height: 1.4;
}
.marker-popup strong {
  display: block;
  margin-bottom: 0.1rem;
}
.popup-address {
  font-size: 0.8rem;
  color: #444;
}
.popup-detail {
  font-size: 0.72rem;
  color: #888;
  font-family: 'JetBrains Mono', monospace;
}
.map-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.8rem;
  padding: 1rem 0;
}
.map-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-dim);
  margin-bottom: 0.4rem;
}
.gps-waiting {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg, #f5f6fa);
  border: 1px solid var(--border, #e5e7eb);
}
.gps-overlay {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  color: var(--text-dim);
  font-size: 0.82rem;
  font-weight: 500;
}
.gps-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--border, #e5e7eb);
  border-top-color: var(--accent, #6366f1);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
