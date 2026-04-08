<template>
  <Teleport to="body">
    <div v-if="open" class="picker-overlay" @click.self="$emit('close')">
      <div class="picker-modal">
        <div class="picker-header">
          <h3>Pick {{ label }} Location</h3>
          <button class="picker-close" @click="$emit('close')">&times;</button>
        </div>
        <div class="picker-body">
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
          <div ref="mapContainer" class="map-container"></div>
          <div v-if="markerPos" class="selected-info">
            <span class="coords">{{ markerPos.lat.toFixed(5) }}, {{ markerPos.lng.toFixed(5) }}</span>
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
import { useGoogleMaps, createDotPin } from '../../composables/useGoogleMaps'
import { useGeocode } from '../../composables/useGeocode'

const props = defineProps({
  open: { type: Boolean, default: false },
  label: { type: String, default: 'Location' },
  initialLat: { type: Number, default: NaN },
  initialLng: { type: Number, default: NaN },
})

const emit = defineEmits(['confirm', 'close'])

const { createMap } = useGoogleMaps()
const geocode = useGeocode()
const mapContainer = ref(null)
const markerPos = ref(null)
const selectedAddress = ref('')
const searchQuery = ref('')
const suggestions = ref([])
let searchTimer = null
let map = null
let marker = null

function clearMarker() {
  if (marker) { marker.map = null; marker = null }
}

function placeMarker(pos) {
  if (marker) {
    marker.position = pos
  } else {
    marker = new google.maps.marker.AdvancedMarkerElement({
      position: pos,
      map,
      content: createDotPin('#6366f1', 16),
    })
  }
}

function onMapClick(e) {
  const pos = { lat: e.latLng.lat(), lng: e.latLng.lng() }
  placeMarker(pos)
  markerPos.value = pos
  selectedAddress.value = ''
  suggestions.value = []
  geocode.reverseGeocode(pos.lat, pos.lng).then(r => {
    if (r) selectedAddress.value = r.displayName
  })
}

watch(() => props.open, async (isOpen) => {
  if (!isOpen) return
  searchQuery.value = ''
  suggestions.value = []
  selectedAddress.value = ''

  const hasInitial = !isNaN(props.initialLat) && !isNaN(props.initialLng)
  if (hasInitial) {
    markerPos.value = { lat: props.initialLat, lng: props.initialLng }
  } else {
    markerPos.value = null
  }

  await nextTick()

  const center = hasInitial
    ? { lat: props.initialLat, lng: props.initialLng }
    : { lat: 32.7767, lng: -96.7970 }

  // Always create fresh map (container is destroyed between modal opens)
  map = await createMap(mapContainer.value, {
    zoom: hasInitial ? 14 : 5,
    center,
    mapTypeId: 'hybrid',
    mapTypeControl: true,
  })
  map.setOptions({
    mapTypeControlOptions: {
      style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
      position: google.maps.ControlPosition.TOP_LEFT,
    },
  })
  map.addListener('click', onMapClick)

  // Reset marker
  clearMarker()
  if (hasInitial) placeMarker(center)

  // Geolocate if no initial coords
  if (!hasInitial && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        if (map) { map.panTo(loc); map.setZoom(15) }
        placeMarker(loc)
        markerPos.value = loc
        geocode.reverseGeocode(loc.lat, loc.lng).then(r => {
          if (r) selectedAddress.value = r.displayName
        })
      },
      () => {},
      { timeout: 8000, enableHighAccuracy: false }
    )
  }
})

function onSearchInput() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    suggestions.value = await geocode.searchAddress(searchQuery.value)
  }, 500)
}

function selectSuggestion(s) {
  const pos = { lat: s.lat, lng: s.lng }
  placeMarker(pos)
  markerPos.value = pos
  selectedAddress.value = s.displayName
  searchQuery.value = ''
  suggestions.value = []
  if (map) { map.panTo(pos); map.setZoom(15) }
}

function handleConfirm() {
  if (!markerPos.value) return
  emit('confirm', {
    lat: markerPos.value.lat,
    lng: markerPos.value.lng,
    displayName: selectedAddress.value,
  })
}
</script>

<style scoped>
.picker-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.4); z-index: 300;
  display: flex; align-items: center; justify-content: center;
}
.picker-modal {
  background: var(--surface); border-radius: 14px;
  width: 92%; max-width: 900px; max-height: 90vh; overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
  animation: pickerIn 0.2s ease-out;
}
@keyframes pickerIn {
  from { transform: translateY(12px) scale(0.97); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}
.picker-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1rem 1.25rem; border-bottom: 1px solid var(--border);
}
.picker-header h3 { font-size: 1rem; font-weight: 700; }
.picker-close {
  width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 8px; background: transparent;
  color: var(--text-dim); font-size: 1.2rem; cursor: pointer;
}
.picker-close:hover { background: var(--surface-hover); color: var(--text); }
.picker-body { padding: 1rem 1.25rem; }
.search-wrap { position: relative; margin-bottom: 0.75rem; }
.search-input {
  width: 100%; padding: 0.55rem 0.75rem; background: var(--bg);
  border: 1px solid var(--border); border-radius: 6px;
  color: var(--text); font-family: 'DM Sans', sans-serif;
  font-size: 0.88rem; outline: none;
}
.search-input:focus { border-color: var(--accent); }
.suggestions-dropdown {
  position: absolute; top: 100%; left: 0; right: 0;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 6px; margin-top: 2px; max-height: 180px; overflow-y: auto;
  z-index: 1000; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}
.suggestion-item {
  padding: 0.5rem 0.75rem; font-size: 0.82rem; cursor: pointer;
  border-bottom: 1px solid var(--border); color: var(--text);
}
.suggestion-item:last-child { border-bottom: none; }
.suggestion-item:hover { background: var(--surface-hover); }
.map-container {
  height: 480px; border-radius: 8px; overflow: hidden;
  border: 1px solid var(--border);
}
.selected-info {
  display: flex; flex-direction: column; gap: 0.15rem;
  margin-top: 0.65rem; padding: 0.55rem 0.75rem;
  background: var(--bg); border-radius: 6px;
}
.coords {
  font-size: 0.75rem; color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}
.address { font-size: 0.82rem; color: var(--text); }
.address.loading { color: var(--text-dim); font-style: italic; }
.picker-footer {
  display: flex; justify-content: flex-end; gap: 0.6rem;
  padding: 1rem 1.25rem; border-top: 1px solid var(--border);
}
</style>
