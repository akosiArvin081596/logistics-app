<template>
  <div class="tracking-container">
    <div v-if="loading" class="tracking-loading">Loading map data...</div>
    <div v-else-if="locations.length === 0" class="tracking-empty">
      No active driver locations in the last hour.
    </div>
    <div v-else class="map-wrap">
      <l-map
        ref="mapRef"
        :zoom="5"
        :center="mapCenter"
        :use-global-leaflet="false"
        style="height: 100%; width: 100%;"
      >
        <l-tile-layer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
        <l-marker
          v-for="loc in locations"
          :key="loc.driver"
          :ref="el => setMarkerRef(loc.driver, el)"
          :lat-lng="[loc.latitude, loc.longitude]"
        >
          <l-popup>
            <div class="marker-popup">
              <strong>{{ loc.driver }}</strong>
              <div v-if="loc.loadId">Load: {{ loc.loadId }}</div>
              <div class="popup-coords">{{ loc.latitude.toFixed(5) }}, {{ loc.longitude.toFixed(5) }}</div>
              <div v-if="loc.speed">Speed: {{ Math.round(loc.speed * 2.237) }} mph</div>
              <div v-if="loc.etaMinutes != null" class="popup-eta">
                ETA: {{ loc.etaMinutes }} min
              </div>
              <span
                v-if="loc.etaStatus && loc.etaStatus !== 'unknown'"
                :class="['eta-badge', loc.etaStatus]"
              >{{ loc.etaStatus === 'on-time' ? 'On Time' : 'Delayed' }}</span>
              <div class="popup-time">{{ formatTime(loc.timestamp) }}</div>
            </div>
          </l-popup>
        </l-marker>
      </l-map>

      <!-- Driver list panel -->
      <div class="driver-panel" :class="{ collapsed: panelCollapsed }">
        <button class="panel-toggle" @click="panelCollapsed = !panelCollapsed">
          Drivers <span class="panel-count">{{ locations.length }}</span>
          <span class="panel-chevron" :class="{ open: !panelCollapsed }">&#9662;</span>
        </button>
        <div v-show="!panelCollapsed" class="panel-list">
          <div
            :class="['driver-item all-item', { active: selectedDriver === '__all__' }]"
            @click="focusAll"
          >
            <span class="driver-dot all-dot"></span>
            <div class="driver-info">
              <span class="driver-name">All Drivers</span>
              <span class="driver-coords">Show all locations</span>
            </div>
          </div>
          <div
            v-for="loc in locations"
            :key="loc.driver"
            :class="['driver-item', { active: selectedDriver === loc.driver }]"
            @click="focusDriver(loc)"
          >
            <span class="driver-dot"></span>
            <div class="driver-info">
              <span class="driver-name">{{ loc.driver }}</span>
              <span class="driver-coords">{{ loc.latitude.toFixed(5) }}, {{ loc.longitude.toFixed(5) }}</span>
              <span v-if="loc.loadId" class="driver-load">{{ loc.loadId }}</span>
            </div>
            <span v-if="loc.speed" class="driver-speed">{{ Math.round(loc.speed * 2.237) }} mph</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useApi } from '../../composables/useApi'
import { useSocket } from '../../composables/useSocket'
import 'leaflet/dist/leaflet.css'
import { LMap, LTileLayer, LMarker, LPopup } from '@vue-leaflet/vue-leaflet'

const props = defineProps({
  visible: { type: Boolean, default: false },
})

const api = useApi()
const socket = useSocket()

const mapRef = ref(null)
const locations = ref([])
const loading = ref(true)
const selectedDriver = ref('')
const panelCollapsed = ref(false)
const markerRefs = {}

function setMarkerRef(driver, el) {
  if (el) markerRefs[driver] = el
}

function focusDriver(loc) {
  selectedDriver.value = loc.driver
  const map = mapRef.value?.leafletObject
  if (map) {
    map.flyTo([loc.latitude, loc.longitude], 14, { duration: 1 })
  }
  // Open popup after flyTo completes
  setTimeout(() => {
    const marker = markerRefs[loc.driver]
    if (marker?.leafletObject) {
      marker.leafletObject.openPopup()
    }
  }, 1100)
}

function focusAll() {
  selectedDriver.value = '__all__'
  const map = mapRef.value?.leafletObject
  if (map && locations.value.length > 0) {
    const bounds = locations.value.map(l => [l.latitude, l.longitude])
    map.flyToBounds(bounds, { padding: [40, 40], duration: 1, maxZoom: 12 })
  }
}

const mapCenter = computed(() => {
  if (locations.value.length === 0) return [39.8283, -98.5795] // US center
  const first = locations.value[0]
  return [first.latitude, first.longitude]
})

async function fetchLocations() {
  try {
    const data = await api.get('/api/locations/latest')
    locations.value = data.locations || []
  } catch {
    // silent
  } finally {
    loading.value = false
  }
}

function onLocationUpdate(payload) {
  const idx = locations.value.findIndex(
    (l) => l.driver.toLowerCase() === payload.driver.toLowerCase()
  )
  const entry = {
    driver: payload.driver,
    latitude: payload.latitude,
    longitude: payload.longitude,
    speed: payload.speed || 0,
    loadId: payload.loadId || '',
    timestamp: payload.timestamp,
  }
  if (idx >= 0) {
    locations.value[idx] = entry
  } else {
    locations.value.push(entry)
  }
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return isNaN(d) ? ts : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

// Fix tile rendering when tab becomes visible
watch(() => props.visible, (val) => {
  if (val) {
    nextTick(() => {
      if (mapRef.value?.leafletObject) {
        mapRef.value.leafletObject.invalidateSize()
      }
    })
  }
})

onMounted(() => {
  socket.connect()
  socket.register('dispatch')
  fetchLocations()
  socket.on('location-update', onLocationUpdate)
})

onUnmounted(() => {
  socket.off('location-update', onLocationUpdate)
})
</script>

<style scoped>
.tracking-container {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.map-wrap {
  flex: 1;
  min-height: 400px;
  position: relative;
}

/* Driver panel */
.driver-panel {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 1000;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(8px);
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  min-width: 200px;
  max-width: 260px;
  max-height: calc(100% - 20px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-toggle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  padding: 0.6rem 0.75rem;
  background: none;
  border: none;
  font-family: inherit;
  font-size: 0.82rem;
  font-weight: 700;
  color: #333;
  cursor: pointer;
  border-bottom: 1px solid #eee;
}

.panel-count {
  font-size: 0.68rem;
  font-weight: 600;
  background: #e0e7ff;
  color: #4338ca;
  padding: 0.05rem 0.4rem;
  border-radius: 10px;
}

.panel-chevron {
  margin-left: auto;
  font-size: 0.65rem;
  color: #999;
  transition: transform 0.2s;
  display: inline-block;
}

.panel-chevron.open {
  transform: rotate(180deg);
}

.panel-list {
  overflow-y: auto;
  max-height: 320px;
}

.driver-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 0.75rem;
  cursor: pointer;
  transition: background 0.15s;
  border-bottom: 1px solid #f3f4f6;
}

.driver-item:last-child {
  border-bottom: none;
}

.all-item {
  border-bottom: 1px solid #e5e7eb;
}

.all-dot {
  background: #6366f1 !important;
}

.driver-item:hover {
  background: #f9fafb;
}

.driver-item.active {
  background: #eff6ff;
}

.driver-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
  flex-shrink: 0;
}

.driver-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.driver-name {
  font-size: 0.78rem;
  font-weight: 600;
  color: #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.driver-coords {
  font-size: 0.6rem;
  color: #999;
  font-family: 'JetBrains Mono', monospace;
}

.driver-load {
  font-size: 0.65rem;
  color: #888;
  font-family: 'JetBrains Mono', monospace;
}

.driver-speed {
  font-size: 0.65rem;
  font-weight: 500;
  color: #888;
  flex-shrink: 0;
}

.tracking-loading,
.tracking-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 300px;
  color: var(--text-dim);
  font-size: 0.9rem;
}

.marker-popup strong {
  font-size: 0.9rem;
}

.marker-popup div {
  font-size: 0.8rem;
  color: #555;
}

.popup-coords {
  font-size: 0.72rem;
  color: #888;
  font-family: 'JetBrains Mono', monospace;
}

.popup-eta {
  font-weight: 600;
  font-size: 0.8rem;
}

.eta-badge {
  display: inline-block;
  padding: 0.1rem 0.4rem;
  border-radius: 9999px;
  font-size: 0.7rem;
  font-weight: 600;
}

.eta-badge.on-time {
  background: #dcfce7;
  color: #166534;
}

.eta-badge.delayed {
  background: #fef2f2;
  color: #dc2626;
}

.popup-time {
  font-size: 0.7rem;
  color: #999;
  margin-top: 0.2rem;
}
</style>
