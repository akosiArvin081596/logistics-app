<template>
  <Teleport to="body">
    <div v-if="open" class="picker-overlay" @click.self="$emit('close')">
      <div class="picker-modal">
        <div class="picker-header">
          <h3>Pick {{ label }} Location</h3>
          <button class="picker-close" @click="$emit('close')">&times;</button>
        </div>
        <div class="picker-body">
          <!-- Search box -->
          <div class="search-wrap">
            <input
              v-model="searchQuery"
              class="search-input"
              placeholder="Search address..."
              @input="onSearchInput"
            />
            <div v-if="suggestions.length" class="suggestions-dropdown">
              <div
                v-for="(s, i) in suggestions"
                :key="i"
                class="suggestion-item"
                @click="selectSuggestion(s)"
              >
                {{ s.displayName }}
              </div>
            </div>
          </div>

          <!-- Map -->
          <div class="map-container">
            <l-map
              ref="mapRef"
              :zoom="mapZoom"
              :center="mapCenter"
              :use-global-leaflet="false"
              :options="{ attributionControl: false }"
              :min-zoom="3"
              :max-bounds="[[-85, -180], [85, 180]]"
              :max-bounds-viscosity="1.0"
              world-copy-jump
              @click="onMapClick"
            >
              <l-tile-layer
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                attribution="&copy; Esri"
              />
              <l-marker v-if="markerPos" :lat-lng="markerPos" :icon="pinIcon" />
            </l-map>
          </div>

          <!-- Selected info -->
          <div v-if="markerPos" class="selected-info">
            <span class="coords">{{ markerPos[0].toFixed(5) }}, {{ markerPos[1].toFixed(5) }}</span>
            <span v-if="selectedAddress" class="address">{{ selectedAddress }}</span>
            <span v-else class="address loading">Looking up address...</span>
          </div>
        </div>
        <div class="picker-footer">
          <button class="btn btn-secondary" @click="$emit('close')">Cancel</button>
          <button class="btn btn-primary" :disabled="!markerPos" @click="handleConfirm">Confirm</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue'
import 'leaflet/dist/leaflet.css'
import { LMap, LTileLayer, LMarker } from '@vue-leaflet/vue-leaflet'
import L from 'leaflet'
import { useGeocode } from '../../composables/useGeocode'

const props = defineProps({
  open: { type: Boolean, default: false },
  label: { type: String, default: 'Location' },
  initialLat: { type: Number, default: NaN },
  initialLng: { type: Number, default: NaN },
})

const emit = defineEmits(['confirm', 'close'])

const geocode = useGeocode()
const mapRef = ref(null)
const markerPos = ref(null)
const selectedAddress = ref('')
const searchQuery = ref('')
const suggestions = ref([])
let searchTimer = null

const mapCenter = ref([8.9475, 125.5406])
const mapZoom = ref(6)

const pinIcon = L.divIcon({
  className: 'picker-pin',
  html: '<div style="width:14px;height:14px;background:#6366f1;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
})

// Reset state and position map when opened
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    searchQuery.value = ''
    suggestions.value = []
    selectedAddress.value = ''

    const hasInitial = !isNaN(props.initialLat) && !isNaN(props.initialLng)
    if (hasInitial) {
      markerPos.value = [props.initialLat, props.initialLng]
      mapCenter.value = [props.initialLat, props.initialLng]
      mapZoom.value = 12
    } else {
      markerPos.value = null
      mapCenter.value = [8.9475, 125.5406]
      mapZoom.value = 6
    }

    // Fix Leaflet tile rendering in modal
    nextTick(() => {
      setTimeout(() => {
        const map = mapRef.value?.leafletObject
        if (map) map.invalidateSize()
      }, 200)
    })
  }
})

async function onMapClick(e) {
  const { lat, lng } = e.latlng
  markerPos.value = [lat, lng]
  selectedAddress.value = ''
  suggestions.value = []
  const result = await geocode.reverseGeocode(lat, lng)
  if (result) selectedAddress.value = result.displayName
}

function onSearchInput() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    suggestions.value = await geocode.searchAddress(searchQuery.value)
  }, 500)
}

function selectSuggestion(s) {
  markerPos.value = [s.lat, s.lng]
  selectedAddress.value = s.displayName
  searchQuery.value = ''
  suggestions.value = []
  const map = mapRef.value?.leafletObject
  if (map) map.setView([s.lat, s.lng], 14)
}

function handleConfirm() {
  if (!markerPos.value) return
  emit('confirm', {
    lat: markerPos.value[0],
    lng: markerPos.value[1],
    displayName: selectedAddress.value,
  })
}
</script>

<style scoped>
.picker-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
}
.picker-modal {
  background: var(--surface);
  border-radius: 14px;
  width: 92%;
  max-width: 600px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
  animation: pickerIn 0.2s ease-out;
}
@keyframes pickerIn {
  from { transform: translateY(12px) scale(0.97); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}
.picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
}
.picker-header h3 {
  font-size: 1rem;
  font-weight: 700;
}
.picker-close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font-size: 1.2rem;
  cursor: pointer;
}
.picker-close:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.picker-body {
  padding: 1rem 1.25rem;
}
.search-wrap {
  position: relative;
  margin-bottom: 0.75rem;
}
.search-input {
  width: 100%;
  padding: 0.55rem 0.75rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-family: 'DM Sans', sans-serif;
  font-size: 0.88rem;
  outline: none;
}
.search-input:focus {
  border-color: var(--accent);
}
.suggestions-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-top: 2px;
  max-height: 180px;
  overflow-y: auto;
  z-index: 1000;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}
.suggestion-item {
  padding: 0.5rem 0.75rem;
  font-size: 0.82rem;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  color: var(--text);
}
.suggestion-item:last-child {
  border-bottom: none;
}
.suggestion-item:hover {
  background: var(--surface-hover);
}
.map-container {
  height: 320px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.map-container .leaflet-container {
  height: 100%;
  width: 100%;
}
.selected-info {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  margin-top: 0.65rem;
  padding: 0.55rem 0.75rem;
  background: var(--bg);
  border-radius: 6px;
}
.coords {
  font-size: 0.75rem;
  color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}
.address {
  font-size: 0.82rem;
  color: var(--text);
}
.address.loading {
  color: var(--text-dim);
  font-style: italic;
}
.picker-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  padding: 1rem 1.25rem;
  border-top: 1px solid var(--border);
}
</style>

<style>
.picker-pin {
  background: transparent !important;
  border: none !important;
}
</style>
