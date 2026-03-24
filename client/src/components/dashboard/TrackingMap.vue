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
          :lat-lng="[loc.latitude, loc.longitude]"
        >
          <l-popup>
            <div class="marker-popup">
              <strong>{{ loc.driver }}</strong>
              <div v-if="loc.loadId">Load: {{ loc.loadId }}</div>
              <div v-if="loc.speed">Speed: {{ Math.round(loc.speed * 2.237) }} mph</div>
              <div class="popup-time">{{ formatTime(loc.timestamp) }}</div>
            </div>
          </l-popup>
        </l-marker>
      </l-map>
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

.popup-time {
  font-size: 0.7rem;
  color: #999;
  margin-top: 0.2rem;
}
</style>
