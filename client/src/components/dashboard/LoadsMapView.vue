<template>
  <div class="loads-map-wrap">
    <div v-if="mappedLoads.length === 0" class="map-empty">No loads with coordinates to display.</div>
    <template v-else>
      <div class="map-container">
        <div ref="mapContainer" style="height:100%;width:100%;"></div>
        <div class="map-info-badge">{{ mappedLoads.length }} of {{ loads.length }} loads shown</div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useGoogleMaps, createDotPin } from '../../composables/useGoogleMaps'

const props = defineProps({
  loads: { type: Array, required: true },
  headers: { type: Array, required: true },
  category: { type: String, default: 'active' },
  driverLocations: { type: Array, default: () => [] },
  visible: { type: Boolean, default: true },
})

const { createMap } = useGoogleMaps()
const mapContainer = ref(null)
let map = null
let markers = []
let polylines = []

function findCol(regex) { return (props.headers || []).find(h => regex.test(h)) || null }

const originLatCol = computed(() => findCol(/origin.*lat|pickup.*lat|shipper.*lat/i))
const originLngCol = computed(() => findCol(/origin.*l(on|ng)|pickup.*l(on|ng)|shipper.*l(on|ng)/i))
const destLatCol = computed(() => findCol(/dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i))
const destLngCol = computed(() => findCol(/dest.*l(on|ng)|drop.*l(on|ng)|receiver.*l(on|ng)|delivery.*l(on|ng)/i))
const loadIdCol = computed(() => findCol(/load.?id|job.?id/i))
const statusCol = computed(() => findCol(/^status$/i) || findCol(/status/i))
const driverCol = computed(() => findCol(/driver/i))

const colorMap = { active: '#2563eb', unassigned: '#d97706', completed: '#059669' }
const lineColor = computed(() => colorMap[props.category] || '#2563eb')

const mappedLoads = computed(() => {
  const results = []
  for (const job of props.loads) {
    const oLat = originLatCol.value ? parseFloat(job[originLatCol.value]) : NaN
    const oLng = originLngCol.value ? parseFloat(job[originLngCol.value]) : NaN
    const dLat = destLatCol.value ? parseFloat(job[destLatCol.value]) : NaN
    const dLng = destLngCol.value ? parseFloat(job[destLngCol.value]) : NaN
    const origin = !isNaN(oLat) && !isNaN(oLng) ? { lat: oLat, lng: oLng } : null
    const dest = !isNaN(dLat) && !isNaN(dLng) ? { lat: dLat, lng: dLng } : null
    if (!origin && !dest) continue
    const loadId = loadIdCol.value ? job[loadIdCol.value] || '' : ''
    const status = statusCol.value ? job[statusCol.value] || '' : ''
    const driver = driverCol.value ? job[driverCol.value] || '' : ''
    let driverPos = null
    if (driver && props.driverLocations.length) {
      const loc = props.driverLocations.find(l => l.driver && l.driver.toLowerCase() === driver.toLowerCase() && l.latitude)
      if (loc) driverPos = { lat: loc.latitude, lng: loc.longitude }
    }
    results.push({ rowIndex: job._rowIndex, origin, dest, loadId, status, driver, driverPos })
  }
  return results
})

function clearOverlays() {
  markers.forEach(m => { m.map = null }); markers = []
  polylines.forEach(p => p.setMap(null)); polylines = []
}

function render() {
  if (!map) return
  clearOverlays()
  const bounds = new google.maps.LatLngBounds()
  let count = 0

  for (const item of mappedLoads.value) {
    if (item.origin && item.dest) {
      polylines.push(new google.maps.Polyline({
        path: [item.origin, item.dest],
        strokeColor: lineColor.value, strokeOpacity: 0.5, strokeWeight: 2, map,
      }))
    }
    if (item.origin) {
      const m = new google.maps.marker.AdvancedMarkerElement({ position: item.origin, map, content: createDotPin('#16a34a'), title: `Pickup: ${item.loadId}` })
      const info = new google.maps.InfoWindow({ content: `<div style="font-family:DM Sans,sans-serif;font-size:0.82rem"><strong>Pickup</strong>${item.loadId ? `<div style="color:#666;font-size:0.75rem">${item.loadId}</div>` : ''}${item.driver ? `<div style="color:#666;font-size:0.75rem">Driver: ${item.driver}</div>` : ''}</div>` })
      m.addEventListener('gmp-click', () => info.open({ map, anchor: m }))
      markers.push(m)
      bounds.extend(item.origin); count++
    }
    if (item.dest) {
      const m = new google.maps.marker.AdvancedMarkerElement({ position: item.dest, map, content: createDotPin('#dc2626'), title: `Drop-off: ${item.loadId}` })
      const info = new google.maps.InfoWindow({ content: `<div style="font-family:DM Sans,sans-serif;font-size:0.82rem"><strong>Drop-off</strong>${item.loadId ? `<div style="color:#666;font-size:0.75rem">${item.loadId}</div>` : ''}${item.driver ? `<div style="color:#666;font-size:0.75rem">Driver: ${item.driver}</div>` : ''}</div>` })
      m.addEventListener('gmp-click', () => info.open({ map, anchor: m }))
      markers.push(m)
      bounds.extend(item.dest); count++
    }
    if (item.driverPos) {
      const m = new google.maps.marker.AdvancedMarkerElement({ position: item.driverPos, map, content: createDotPin('#2563eb', 16), title: item.driver })
      markers.push(m)
      bounds.extend(item.driverPos); count++
    }
  }

  if (count >= 2) map.fitBounds(bounds, 40)
  else if (count === 1) { map.setCenter(bounds.getCenter()); map.setZoom(10) }
}

async function initMap() {
  if (!mapContainer.value || map) return
  map = await createMap(mapContainer.value, { zoom: 5, center: { lat: 39.8, lng: -98.5 }, mapTypeId: 'hybrid' })
  render()
}

watch(() => props.loads.length, () => render())
watch(() => props.visible, (vis) => { if (vis) nextTick(() => { if (map) { google.maps.event.trigger(map, 'resize'); render() } else initMap() }) })

onMounted(() => { if (mappedLoads.value.length > 0) nextTick(() => initMap()) })
</script>

<style scoped>
.loads-map-wrap { width: 100%; flex: 1; display: flex; flex-direction: column; min-height: 0; }
.map-container { flex: 1; min-height: 300px; position: relative; border-radius: 0; overflow: hidden; }
.map-empty { text-align: center; color: var(--text-dim); font-size: 0.85rem; padding: 3rem 1rem; }
.map-info-badge {
  position: absolute; bottom: 8px; left: 8px; z-index: 1000;
  background: var(--surface, #fff); border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px; padding: 0.25rem 0.6rem; font-size: 0.72rem;
  font-weight: 600; color: var(--text-dim); box-shadow: 0 1px 4px rgba(0,0,0,0.1);
}
</style>
