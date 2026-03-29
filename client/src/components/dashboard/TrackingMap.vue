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
          v-for="loc in locationsWithGps"
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
              <div v-if="selectedDriver === loc.driver && routeDistance != null" class="popup-eta">
                Distance: {{ routeDistance }} km
              </div>
              <div v-if="selectedDriver === loc.driver && routeEta != null" class="popup-eta">
                ETA: {{ routeEta }} min
              </div>
              <div class="popup-time">{{ formatTime(loc.timestamp) }}</div>
            </div>
          </l-popup>
        </l-marker>

        <!-- Single driver route (when one driver selected) -->
        <l-polyline
          v-if="selectedDriver !== '__all__' && routePoints.length >= 2"
          :lat-lngs="routePoints"
          color="#000000"
          :weight="6"
          :opacity="0.7"
          dashArray="12, 8"
          className="route-animate"
        />
        <l-marker v-if="selectedDriver !== '__all__' && originLatLng" :lat-lng="originLatLng" :icon="originIcon">
          <l-popup><div class="marker-popup"><strong>Pickup</strong><div v-if="originAddress" class="popup-address">{{ originAddress }}</div></div></l-popup>
        </l-marker>
        <l-marker v-if="selectedDriver !== '__all__' && destLatLng" :lat-lng="destLatLng" :icon="destIcon">
          <l-popup><div class="marker-popup"><strong>Drop-off</strong><div v-if="destAddress" class="popup-address">{{ destAddress }}</div></div></l-popup>
        </l-marker>

        <!-- All drivers routes (when "All Drivers" selected) -->
        <template v-if="selectedDriver === '__all__'">
          <template v-for="r in allRoutes" :key="r.driver">
            <l-polyline
              v-if="r.route.length >= 2"
              :lat-lngs="r.route"
              :color="r.color"
              :weight="4"
              :opacity="0.7"
              dashArray="10, 6"
              className="route-animate"
            />
            <l-marker v-if="r.origin" :lat-lng="r.origin" :icon="originIcon">
              <l-popup><div class="marker-popup"><strong>{{ r.driver }} — Pickup</strong></div></l-popup>
            </l-marker>
            <l-marker v-if="r.dest" :lat-lng="r.dest" :icon="destIcon">
              <l-popup><div class="marker-popup"><strong>{{ r.driver }} — Destination</strong></div></l-popup>
            </l-marker>
          </template>
        </template>
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
              <span class="driver-coords">{{ onlineCount }} online — show all routes</span>
            </div>
          </div>
          <div
            v-for="loc in locations"
            :key="loc.driver"
            class="driver-item-wrap"
          >
            <div
              :class="['driver-item', { active: selectedDriver === loc.driver, 'no-gps': loc.noGps }]"
              @click="!loc.noGps && focusDriver(loc)"
            >
              <span :class="['driver-dot', loc.noGps ? 'no-gps' : isOnline(loc) ? 'online' : 'offline']"></span>
              <div class="driver-info">
                <span class="driver-name">{{ loc.driver }}</span>
                <span v-if="loc.noGps" class="driver-meta">
                  <span class="status-text no-gps">No location data</span>
                </span>
                <span v-else class="driver-meta">
                  <span :class="['status-text', isOnline(loc) ? 'online' : 'offline']">{{ isOnline(loc) ? 'Online' : 'Offline' }}</span>
                  <span class="driver-ago">{{ timeAgo(loc.timestamp) }}</span>
                </span>
                <span v-if="loc.loadId" class="driver-load">{{ loc.loadId }}</span>
              </div>
              <span v-if="loc.speed && isOnline(loc)" class="driver-speed">{{ Math.round(loc.speed * 2.237) }} mph</span>
            </div>
            <!-- Route accordion: expands when driver is selected -->
            <div v-if="selectedDriver === loc.driver && (originLatLng || destLatLng)" class="route-accordion">
              <div v-if="originLatLng" class="route-point">
                <div class="route-point-header">
                  <span class="route-point-dot pickup"></span>
                  <span class="route-point-label">Pickup (A)</span>
                </div>
                <div v-if="originAddress" class="route-point-address">{{ originAddress }}</div>
                <div class="route-point-coords">{{ originLatLng[0].toFixed(5) }}, {{ originLatLng[1].toFixed(5) }}</div>
              </div>
              <div v-if="destLatLng" class="route-point">
                <div class="route-point-header">
                  <span class="route-point-dot dropoff"></span>
                  <span class="route-point-label">Drop-off (B)</span>
                </div>
                <div v-if="destAddress" class="route-point-address">{{ destAddress }}</div>
                <div class="route-point-coords">{{ destLatLng[0].toFixed(5) }}, {{ destLatLng[1].toFixed(5) }}</div>
              </div>
              <div v-if="routeDistance != null || routeEta != null" class="route-summary">
                <span v-if="routeDistance != null" class="route-stat">{{ routeDistance }} km</span>
                <span v-if="routeEta != null" class="route-stat">{{ routeEta }} min ETA</span>
              </div>
            </div>
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
import { LMap, LTileLayer, LMarker, LPopup, LPolyline } from '@vue-leaflet/vue-leaflet'
import L from 'leaflet'

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

// Trail state (single driver)
const trailPoints = ref([])
const routePoints = ref([])
const originLatLng = ref(null)
const destLatLng = ref(null)
const originAddress = ref('')
const destAddress = ref('')
const trailLoadId = ref('')
const routeDistance = ref(null)
const routeEta = ref(null)

// All-drivers route state
const allRoutes = ref([])
const ROUTE_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#be185d', '#65a30d']

// Animation state
const activeAnimations = {}

// ---- Smooth marker animation via requestAnimationFrame ----
function animateMarker(driver, fromLat, fromLng, toLat, toLng, duration = 800) {
  if (activeAnimations[driver]) cancelAnimationFrame(activeAnimations[driver])
  const start = performance.now()

  function frame(now) {
    const t = Math.min((now - start) / duration, 1)
    const eased = t * (2 - t) // ease-out quadratic
    const loc = locations.value.find((l) => l.driver === driver)
    if (loc) {
      loc.latitude = fromLat + (toLat - fromLat) * eased
      loc.longitude = fromLng + (toLng - fromLng) * eased
    }
    if (t < 1) activeAnimations[driver] = requestAnimationFrame(frame)
    else delete activeAnimations[driver]
  }

  activeAnimations[driver] = requestAnimationFrame(frame)
}

// ---- Client-side road snapping (project GPS onto route polyline) ----
function closestPointOnSegment(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (dx === 0 && dy === 0) return a
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
  return [a[0] + t * dx, a[1] + t * dy]
}

function distSq(a, b) {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

function snapToRoute(point, route) {
  if (route.length < 2) return null
  let minDist = Infinity
  let closest = null
  for (let i = 0; i < route.length - 1; i++) {
    const snapped = closestPointOnSegment(point, route[i], route[i + 1])
    const d = distSq(point, snapped)
    if (d < minDist) {
      minDist = d
      closest = snapped
    }
  }
  // ~0.002 degrees ≈ 200m — only snap if reasonably close to route
  return minDist < 0.002 * 0.002 ? closest : null
}

// Custom icons for origin (green) and destination (red)
const originIcon = L.divIcon({
  className: 'endpoint-icon origin-icon',
  html: '<div class="endpoint-dot" style="background:#16a34a;"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
})
const destIcon = L.divIcon({
  className: 'endpoint-icon dest-icon',
  html: '<div class="endpoint-dot" style="background:#dc2626;"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
})

function setMarkerRef(driver, el) {
  if (el) markerRefs[driver] = el
}

async function fetchTrail(driverName, loadId) {
  trailPoints.value = []
  routePoints.value = []
  originLatLng.value = null
  destLatLng.value = null
  originAddress.value = ''
  destAddress.value = ''
  trailLoadId.value = ''
  routeDistance.value = null
  routeEta.value = null
  if (!driverName || !loadId) return
  try {
    const data = await api.get(`/api/locations/trail?driver=${encodeURIComponent(driverName)}&loadId=${encodeURIComponent(loadId)}`)
    trailPoints.value = (data.trail || []).map(p => [p.latitude, p.longitude])
    routePoints.value = (data.route || []).map(p => [p.latitude, p.longitude])
    if (data.origin) {
      originLatLng.value = [data.origin.latitude, data.origin.longitude]
      originAddress.value = data.origin.address || ''
    }
    if (data.destination) {
      destLatLng.value = [data.destination.latitude, data.destination.longitude]
      destAddress.value = data.destination.address || ''
    }
    routeDistance.value = data.distanceKm
    routeEta.value = data.etaMinutes
    trailLoadId.value = loadId
  } catch {
    // silent — trail is supplementary
  }
}

async function focusDriver(loc) {
  selectedDriver.value = loc.driver
  allRoutes.value = []
  const map = mapRef.value?.leafletObject

  // Zoom to driver immediately so the map responds on click
  if (map) {
    map.setView([loc.latitude, loc.longitude], 14, { animate: true })
  }

  nextTick(() => {
    const marker = markerRefs[loc.driver]
    if (marker?.leafletObject) {
      marker.leafletObject.openPopup()
    }
  })

  // Then fetch route and widen bounds if available
  await fetchTrail(loc.driver, loc.loadId)

  if (map && routePoints.value.length >= 2) {
    await nextTick()
    const allPts = [...routePoints.value, [loc.latitude, loc.longitude]]
    const bounds = L.latLngBounds(allPts.map(p => L.latLng(p[0], p[1])))
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14, animate: true })
  }
}

let lastRerouteTime = 0

async function checkOffRoute(lat, lng) {
  // Rate-limit: max once every 30 seconds
  if (Date.now() - lastRerouteTime < 30000) return

  // Find minimum distance from driver to any point on the route
  const driverPos = L.latLng(lat, lng)
  let minDist = Infinity
  for (const pt of routePoints.value) {
    const d = driverPos.distanceTo(L.latLng(pt[0], pt[1]))
    if (d < minDist) minDist = d
    if (d < 100) return // still on route, no need to check further
  }

  // Off-route: recalculate from current position to destination
  if (minDist >= 100 && destLatLng.value) {
    lastRerouteTime = Date.now()
    try {
      const [toLat, toLng] = destLatLng.value
      const data = await api.get(`/api/route?fromLat=${lat}&fromLng=${lng}&toLat=${toLat}&toLng=${toLng}`)
      routePoints.value = (data.route || []).map(p => [p.latitude, p.longitude])
      routeDistance.value = data.distanceKm
      routeEta.value = data.etaMinutes
    } catch {
      // silent
    }
  }
}

async function focusAll() {
  selectedDriver.value = '__all__'
  // Clear single-driver state
  trailPoints.value = []
  routePoints.value = []
  originLatLng.value = null
  destLatLng.value = null
  trailLoadId.value = ''
  routeDistance.value = null
  routeEta.value = null

  // Fetch routes for all online drivers with a load
  const onlineWithLoad = locations.value.filter(loc => isOnline(loc) && loc.loadId)
  const routes = await Promise.all(
    onlineWithLoad.map(async (loc, i) => {
      try {
        const data = await api.get(`/api/locations/trail?driver=${encodeURIComponent(loc.driver)}&loadId=${encodeURIComponent(loc.loadId)}`)
        return {
          driver: loc.driver,
          route: (data.route || []).map(p => [p.latitude, p.longitude]),
          origin: data.origin ? [data.origin.latitude, data.origin.longitude] : null,
          dest: data.destination ? [data.destination.latitude, data.destination.longitude] : null,
          color: ROUTE_COLORS[i % ROUTE_COLORS.length],
        }
      } catch {
        return null
      }
    })
  )
  allRoutes.value = routes.filter(r => r && (r.route.length >= 2 || r.origin || r.dest))

  // Fit bounds to all online drivers
  await nextTick()
  const map = mapRef.value?.leafletObject
  if (!map) return
  const withGps = locationsWithGps.value
  if (withGps.length === 0) return
  const allPts = withGps.map(loc => [loc.latitude, loc.longitude])
  // Include origins and destinations from routes
  for (const r of allRoutes.value) {
    if (r.origin) allPts.push(r.origin)
    if (r.dest) allPts.push(r.dest)
  }
  const bounds = L.latLngBounds(allPts.map(p => L.latLng(p[0], p[1])))
  map.fitBounds(bounds, { padding: [50, 50], maxZoom: 12, animate: true })
}

// Online/offline detection (5-minute threshold)
const now = ref(Date.now())
let nowInterval = null
const ONLINE_THRESHOLD = 5 * 60 * 1000 // 5 minutes

function isOnline(loc) {
  if (!loc.timestamp) return false
  return now.value - new Date(loc.timestamp).getTime() < ONLINE_THRESHOLD
}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = now.value - new Date(ts).getTime()
  if (diff < 60000) return 'just now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const locationsWithGps = computed(() => locations.value.filter(loc => !loc.noGps && loc.latitude != null))
const onlineCount = computed(() => locationsWithGps.value.filter(loc => isOnline(loc)).length)

const mapCenter = ref([39.8283, -98.5795]) // set once after first fetch

function updateMarkerVisibility() {
  const map = mapRef.value?.leafletObject
  if (!map) return
  const sel = selectedDriver.value
  const showAll = !sel || sel === '__all__'
  for (const [driver, ref] of Object.entries(markerRefs)) {
    const layer = ref?.leafletObject
    if (!layer) continue
    let show = false
    if (showAll) {
      show = true
    } else {
      show = driver === sel
    }
    if (show) {
      if (!map.hasLayer(layer)) map.addLayer(layer)
    } else {
      if (map.hasLayer(layer)) map.removeLayer(layer)
    }
  }
}

watch(selectedDriver, () => {
  nextTick(updateMarkerVisibility)
})

async function fetchLocations() {
  try {
    const data = await api.get('/api/locations/latest')
    locations.value = data.locations || []
    // Fit map to drivers with GPS on initial load
    const withGps = locations.value.filter(l => !l.noGps && l.latitude != null)
    if (withGps.length > 0) {
      const pts = withGps.map(l => [l.latitude, l.longitude])
      mapCenter.value = pts[0]
      await nextTick()
      const map = mapRef.value?.leafletObject
      if (map) {
        if (pts.length === 1) {
          map.setView(pts[0], 10, { animate: false })
        } else {
          map.fitBounds(L.latLngBounds(pts.map(p => L.latLng(p[0], p[1]))), { padding: [50, 50], maxZoom: 12, animate: false })
        }
      }
    }
  } catch {
    // silent
  } finally {
    loading.value = false
  }
}

function onLocationUpdate(payload) {
  let targetLat = payload.latitude
  let targetLng = payload.longitude

  // Snap to route if we have one for this driver
  if (
    selectedDriver.value === payload.driver &&
    routePoints.value.length >= 2
  ) {
    const snapped = snapToRoute([targetLat, targetLng], routePoints.value)
    if (snapped) {
      targetLat = snapped[0]
      targetLng = snapped[1]
    }
  }

  const idx = locations.value.findIndex(
    (l) => l.driver.toLowerCase() === payload.driver.toLowerCase()
  )
  if (idx >= 0) {
    const old = locations.value[idx]
    // Animate from current display position to new (snapped) position
    animateMarker(payload.driver, old.latitude, old.longitude, targetLat, targetLng)
    // Update non-position fields immediately
    locations.value[idx].speed = payload.speed || 0
    locations.value[idx].loadId = payload.loadId || ''
    locations.value[idx].timestamp = payload.timestamp
  } else {
    locations.value.push({
      driver: payload.driver,
      latitude: targetLat,
      longitude: targetLng,
      speed: payload.speed || 0,
      loadId: payload.loadId || '',
      timestamp: payload.timestamp,
    })
  }

  // Extend trail in real-time if this update is for the selected driver/load
  if (
    selectedDriver.value === payload.driver &&
    trailLoadId.value &&
    payload.loadId === trailLoadId.value &&
    trailPoints.value.length > 0
  ) {
    trailPoints.value = [...trailPoints.value, [payload.latitude, payload.longitude]]
  }

  // Auto-reroute if driver is off the planned route
  if (
    selectedDriver.value === payload.driver &&
    routePoints.value.length >= 2 &&
    destLatLng.value
  ) {
    checkOffRoute(payload.latitude, payload.longitude)
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

function onStatusUpdated(payload) {
  // Clear route if the selected driver's load was delivered/completed
  const deliveredStatuses = /^(delivered|completed|pod received)$/i
  if (
    payload.newStatus &&
    deliveredStatuses.test(payload.newStatus) &&
    selectedDriver.value === payload.driverName
  ) {
    routePoints.value = []
    originLatLng.value = null
    destLatLng.value = null
    originAddress.value = ''
    destAddress.value = ''
    trailPoints.value = []
    trailLoadId.value = ''
    routeDistance.value = null
    routeEta.value = null
  }
  // Refresh locations to get updated loadId
  fetchLocations()
}

onMounted(() => {
  socket.connect()
  socket.register('dispatch')
  fetchLocations()
  socket.on('location-update', onLocationUpdate)
  socket.on('status-updated', onStatusUpdated)
  nowInterval = setInterval(() => { now.value = Date.now() }, 10000)
})

onUnmounted(() => {
  socket.off('location-update', onLocationUpdate)
  socket.off('status-updated', onStatusUpdated)
  Object.values(activeAnimations).forEach(cancelAnimationFrame)
  clearInterval(nowInterval)
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
  background: #9ca3af;
  flex-shrink: 0;
}
.driver-dot.online {
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.2);
}
.driver-dot.offline {
  background: #9ca3af;
}
.driver-dot.no-gps {
  background: #d1d5db;
}
.driver-item.no-gps {
  opacity: 0.6;
  cursor: default;
}
.status-text.no-gps {
  color: #d1d5db;
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

.driver-meta {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.status-text {
  font-size: 0.62rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.status-text.online {
  color: #16a34a;
}
.status-text.offline {
  color: #9ca3af;
}
.driver-ago {
  font-size: 0.6rem;
  color: #aaa;
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

/* Route accordion */
.driver-item-wrap {
  border-bottom: 1px solid #f3f4f6;
}
.driver-item-wrap:last-child {
  border-bottom: none;
}
.driver-item-wrap .driver-item {
  border-bottom: none;
}

.route-accordion {
  padding: 0.4rem 0.75rem 0.6rem 1.6rem;
  background: #f8fafc;
  border-top: 1px dashed #e5e7eb;
  animation: accordion-open 0.2s ease-out;
}

@keyframes accordion-open {
  from { opacity: 0; max-height: 0; }
  to { opacity: 1; max-height: 300px; }
}

.route-point {
  margin-bottom: 0.45rem;
}

.route-point-header {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 0.1rem;
}

.route-point-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.route-point-dot.pickup {
  background: #16a34a;
}

.route-point-dot.dropoff {
  background: #dc2626;
}

.route-point-label {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #555;
}

.route-point-address {
  font-size: 0.72rem;
  color: #333;
  line-height: 1.3;
  margin-left: 1.1rem;
}

.route-point-coords {
  font-size: 0.62rem;
  color: #999;
  font-family: 'JetBrains Mono', monospace;
  margin-left: 1.1rem;
}

.route-summary {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.35rem;
  padding-top: 0.35rem;
  border-top: 1px solid #e5e7eb;
}

.route-stat {
  font-size: 0.7rem;
  font-weight: 600;
  color: #4338ca;
  background: #e0e7ff;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
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

.popup-address {
  font-size: 0.8rem;
  color: #444;
  margin-top: 0.15rem;
}

.popup-time {
  font-size: 0.7rem;
  color: #999;
  margin-top: 0.2rem;
}
</style>

<style>
/* Unscoped — Leaflet injects divIcon outside scoped scope */
.endpoint-icon {
  background: none !important;
  border: none !important;
}
.endpoint-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 3px solid #fff;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
}
.route-animate {
  animation: route-blink 1.5s ease-in-out infinite;
}
@keyframes route-blink {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 0.25; }
}
</style>
