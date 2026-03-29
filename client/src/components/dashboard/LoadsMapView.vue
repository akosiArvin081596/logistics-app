<template>
  <div class="loads-map-wrap">
    <div v-if="mappedLoads.length === 0" class="map-empty">
      No loads with coordinates to display.
    </div>
    <template v-else>
      <div class="map-container">
        <l-map
          ref="mapRef"
          :zoom="5"
          :center="[39.8, -98.5]"
          :use-global-leaflet="false"
          style="height: 100%; width: 100%;"
          @ready="onMapReady"
        >
          <l-tile-layer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />

          <template v-for="item in mappedLoads" :key="'route-' + item.rowIndex">
            <!-- Origin → Destination polyline -->
            <l-polyline
              v-if="item.origin && item.dest"
              :lat-lngs="[item.origin, item.dest]"
              :color="lineColor"
              :weight="2"
              :opacity="0.5"
              dashArray="6, 4"
            />

            <!-- Origin marker (green) -->
            <l-marker v-if="item.origin" :lat-lng="item.origin" :icon="originIcon">
              <l-popup>
                <div class="marker-popup">
                  <strong>Pickup</strong>
                  <div v-if="item.loadId" class="popup-detail">{{ item.loadId }}</div>
                  <div v-if="item.driver" class="popup-detail">Driver: {{ item.driver }}</div>
                  <div v-if="item.status" class="popup-detail">Status: {{ item.status }}</div>
                </div>
              </l-popup>
            </l-marker>

            <!-- Destination marker (red) -->
            <l-marker v-if="item.dest" :lat-lng="item.dest" :icon="destIcon">
              <l-popup>
                <div class="marker-popup">
                  <strong>Drop-off</strong>
                  <div v-if="item.loadId" class="popup-detail">{{ item.loadId }}</div>
                  <div v-if="item.driver" class="popup-detail">Driver: {{ item.driver }}</div>
                  <div v-if="item.status" class="popup-detail">Status: {{ item.status }}</div>
                </div>
              </l-popup>
            </l-marker>

            <!-- Driver position marker (blue, active loads only) -->
            <l-marker v-if="item.driverPos" :lat-lng="item.driverPos" :icon="driverIcon">
              <l-popup>
                <div class="marker-popup">
                  <strong>{{ item.driver || 'Driver' }}</strong>
                  <div v-if="item.loadId" class="popup-detail">{{ item.loadId }}</div>
                  <div v-if="item.status" class="popup-detail">{{ item.status }}</div>
                </div>
              </l-popup>
            </l-marker>
          </template>
        </l-map>

        <!-- Info badge -->
        <div class="map-info-badge">
          {{ mappedLoads.length }} of {{ loads.length }} loads shown
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import 'leaflet/dist/leaflet.css'
import { LMap, LTileLayer, LMarker, LPopup, LPolyline } from '@vue-leaflet/vue-leaflet'
import L from 'leaflet'

const props = defineProps({
  loads: { type: Array, required: true },
  headers: { type: Array, required: true },
  category: { type: String, default: 'active' },
  driverLocations: { type: Array, default: () => [] },
  visible: { type: Boolean, default: true },
})

const mapRef = ref(null)

// Column detection (same regex patterns as DriverRouteMap.vue)
function findCol(regex) {
  return (props.headers || []).find(h => regex.test(h)) || null
}

const originLatCol = computed(() => findCol(/origin.*lat|pickup.*lat|shipper.*lat/i))
const originLngCol = computed(() => findCol(/origin.*l(on|ng)|pickup.*l(on|ng)|shipper.*l(on|ng)/i))
const destLatCol = computed(() => findCol(/dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i))
const destLngCol = computed(() => findCol(/dest.*l(on|ng)|drop.*l(on|ng)|receiver.*l(on|ng)|delivery.*l(on|ng)/i))
const loadIdCol = computed(() => findCol(/load.?id|job.?id/i))
const statusCol = computed(() => findCol(/^status$/i) || findCol(/status/i))
const driverCol = computed(() => findCol(/driver/i))

// Category → polyline color
const colorMap = { active: '#2563eb', unassigned: '#d97706', completed: '#059669' }
const lineColor = computed(() => colorMap[props.category] || '#2563eb')

// Icons (same style as DriverRouteMap.vue)
const originIcon = L.divIcon({
  className: 'endpoint-icon',
  html: '<div class="endpoint-dot" style="background:#16a34a;"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
})
const destIcon = L.divIcon({
  className: 'endpoint-icon',
  html: '<div class="endpoint-dot" style="background:#dc2626;"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
})
const driverIcon = L.divIcon({
  className: 'endpoint-icon',
  html: '<div class="endpoint-dot" style="background:#2563eb;border-color:#bfdbfe;"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
})

// Build mapped load objects with extracted coordinates
const mappedLoads = computed(() => {
  const results = []
  for (const job of props.loads) {
    const oLat = originLatCol.value ? parseFloat(job[originLatCol.value]) : NaN
    const oLng = originLngCol.value ? parseFloat(job[originLngCol.value]) : NaN
    const dLat = destLatCol.value ? parseFloat(job[destLatCol.value]) : NaN
    const dLng = destLngCol.value ? parseFloat(job[destLngCol.value]) : NaN

    const origin = !isNaN(oLat) && !isNaN(oLng) ? [oLat, oLng] : null
    const dest = !isNaN(dLat) && !isNaN(dLng) ? [dLat, dLng] : null

    if (!origin && !dest) continue

    const loadId = loadIdCol.value ? job[loadIdCol.value] || '' : ''
    const status = statusCol.value ? job[statusCol.value] || '' : ''
    const driver = driverCol.value ? job[driverCol.value] || '' : ''

    // Match driver GPS position from driverLocations
    let driverPos = null
    if (driver && props.driverLocations.length) {
      const loc = props.driverLocations.find(
        l => l.driver && l.driver.toLowerCase() === driver.toLowerCase() && l.latitude
      )
      if (loc) driverPos = [loc.latitude, loc.longitude]
    }

    results.push({ rowIndex: job._rowIndex, origin, dest, loadId, status, driver, driverPos })
  }
  return results
})

// Fit map bounds to all markers
function fitBounds() {
  nextTick(() => {
    const map = mapRef.value?.leafletObject
    if (!map) return
    const points = []
    for (const item of mappedLoads.value) {
      if (item.origin) points.push(item.origin)
      if (item.dest) points.push(item.dest)
      if (item.driverPos) points.push(item.driverPos)
    }
    try {
      const valid = points.filter(p => Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180)
      if (valid.length >= 2) {
        const bounds = L.latLngBounds(valid.map(p => L.latLng(p[0], p[1])))
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], animate: false })
      } else if (valid.length === 1) {
        map.setView(valid[0], 10, { animate: false })
      }
    } catch { /* silent */ }
  })
}

function onMapReady() {
  setTimeout(() => {
    if (mapRef.value?.leafletObject) {
      mapRef.value.leafletObject.invalidateSize()
    }
    fitBounds()
  }, 200)
}

// Re-fit when loads change
watch(() => props.loads.length, () => { fitBounds() })

// Handle visibility (Leaflet hidden-tab fix)
watch(() => props.visible, (vis) => {
  if (vis) {
    nextTick(() => {
      const map = mapRef.value?.leafletObject
      if (map) {
        map.invalidateSize()
        fitBounds()
      }
    })
  }
})
</script>

<style scoped>
.loads-map-wrap {
  width: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.map-container {
  flex: 1;
  min-height: 300px;
  position: relative;
  border-radius: 0;
  overflow: hidden;
}
.map-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 3rem 1rem;
}
.map-info-badge {
  position: absolute;
  bottom: 8px;
  left: 8px;
  z-index: 1000;
  background: var(--surface, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  padding: 0.25rem 0.6rem;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-dim);
  box-shadow: 0 1px 4px rgba(0,0,0,0.1);
}
.marker-popup {
  font-family: 'DM Sans', sans-serif;
  font-size: 0.82rem;
  line-height: 1.4;
}
.marker-popup strong {
  display: block;
  margin-bottom: 0.15rem;
}
.popup-detail {
  font-size: 0.75rem;
  color: #666;
}
</style>

<style>
/* Global icon styles (must not be scoped) */
.endpoint-icon {
  background: transparent !important;
  border: none !important;
}
.endpoint-dot {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(0,0,0,0.3);
}
</style>
