<template>
  <div class="route-map-wrap">
    <div v-if="!hasCoords" class="map-empty">No route coordinates available</div>
    <template v-else>
      <div class="map-info" v-if="distanceKm != null || etaMinutes != null">
        <span v-if="distanceKm != null" class="info-item">{{ distanceKm }} km</span>
        <span v-if="etaMinutes != null" class="info-item">{{ etaMinutes }} min ETA</span>
      </div>
      <div class="map-container">
        <l-map
          ref="mapRef"
          :zoom="14"
          :center="mapCenter"
          :use-global-leaflet="false"
          style="height: 100%; width: 100%;"
        >
          <l-tile-layer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />

          <!-- Planned route -->
          <l-polyline
            v-if="routePoints.length >= 2"
            :lat-lngs="routePoints"
            color="#000000"
            :weight="5"
            :opacity="0.7"
            dashArray="12, 8"
            className="route-animate"
          />

          <!-- Origin marker (green) -->
          <l-marker v-if="originLatLng" :lat-lng="originLatLng" :icon="originIcon">
            <l-popup><div><strong>Pickup</strong></div></l-popup>
          </l-marker>

          <!-- Destination marker (red) -->
          <l-marker v-if="destLatLng" :lat-lng="destLatLng" :icon="destIcon">
            <l-popup><div><strong>Drop-off</strong></div></l-popup>
          </l-marker>

          <!-- Driver position (blue) -->
          <l-marker v-if="driverLatLng" :lat-lng="driverLatLng" :icon="driverIcon">
            <l-popup><div><strong>You are here</strong></div></l-popup>
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

const hasCoords = computed(() => destLatLng.value != null)

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

async function fetchRoute() {
  routePoints.value = []
  distanceKm.value = null
  etaMinutes.value = null
  if (!destLatLng.value) return

  const from = driverLatLng.value || originLatLng.value
  if (!from) return

  try {
    const data = await api.get(`/api/route?fromLat=${from[0]}&fromLng=${from[1]}&toLat=${destLatLng.value[0]}&toLng=${destLatLng.value[1]}`)
    routePoints.value = (data.route || []).map(p => [p.latitude, p.longitude])
    distanceKm.value = data.distanceKm
    etaMinutes.value = data.etaMinutes

    nextTick(() => {
      const map = mapRef.value?.leafletObject
      if (map && routePoints.value.length >= 2) {
        const allPoints = [...routePoints.value]
        if (originLatLng.value) allPoints.push(originLatLng.value)
        if (destLatLng.value) allPoints.push(destLatLng.value)
        if (driverLatLng.value) allPoints.push(driverLatLng.value)
        map.fitBounds(allPoints, { padding: [30, 30], animate: false })
      }
    })
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
    fetchRoute()
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
  if (hasCoords.value) fetchRoute()
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
.map-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.8rem;
  padding: 1rem 0;
}
</style>
