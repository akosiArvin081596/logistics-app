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
        :min-zoom="3"
        :max-bounds="[[-85, -180], [85, 180]]"
        :max-bounds-viscosity="1.0"
        world-copy-jump
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
              <div v-if="inTransitLoad(loc)">Load: {{ inTransitLoad(loc) }}</div>
              <div class="popup-coords">{{ loc.latitude.toFixed(5) }}, {{ loc.longitude.toFixed(5) }}</div>
              <div v-if="loc.speed">Speed: {{ Math.round(loc.speed * 2.237) }} mph</div>
              <div v-if="selectedDriver === loc.driver && originLatLng && expandedLoadId" class="popup-eta">
                {{ driverToPickupKm(loc) }} km to Pickup
              </div>
              <div class="popup-time">{{ formatTime(loc.timestamp) }}</div>
            </div>
          </l-popup>
        </l-marker>

        <!-- Single load route (when a specific load is expanded) -->
        <l-polyline
          v-if="selectedDriver !== '__all__' && expandedLoadId && routePoints.length >= 2"
          :lat-lngs="routePoints"
          color="#000000"
          :weight="6"
          :opacity="0.7"
          dashArray="12, 8"
          className="route-animate"
        />
        <l-marker
          v-if="selectedDriver !== '__all__' && expandedLoadId && routePoints.length >= 2 && routeDistance != null"
          :lat-lng="routeMidpoint"
          :icon="distanceIcon"
        />
        <l-marker v-if="selectedDriver !== '__all__' && expandedLoadId && originLatLng" :lat-lng="originLatLng" :icon="originIcon">
          <l-popup><div class="marker-popup"><strong>Pickup</strong><div v-if="originAddress" class="popup-address">{{ originAddress }}</div></div></l-popup>
        </l-marker>
        <l-marker v-if="selectedDriver !== '__all__' && expandedLoadId && destLatLng" :lat-lng="destLatLng" :icon="destIcon">
          <l-popup><div class="marker-popup"><strong>Drop-off</strong><div v-if="destAddress" class="popup-address">{{ destAddress }}</div></div></l-popup>
        </l-marker>

        <!-- All active load routes for selected driver (when no specific load expanded) -->
        <template v-if="selectedDriver !== '__all__' && !expandedLoadId && driverRoutes.length > 0">
          <template v-for="r in driverRoutes" :key="r.loadId">
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
              <l-popup><div class="marker-popup"><strong>{{ r.loadId }} — Pickup</strong><div v-if="r.originAddress" class="popup-address">{{ r.originAddress }}</div></div></l-popup>
            </l-marker>
            <l-marker v-if="r.dest" :lat-lng="r.dest" :icon="destIcon">
              <l-popup><div class="marker-popup"><strong>{{ r.loadId }} — Drop-off</strong><div v-if="r.destAddress" class="popup-address">{{ r.destAddress }}</div></div></l-popup>
            </l-marker>
          </template>
        </template>

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

      <!-- Route loading overlay -->
      <div v-if="fetchingRoute" class="route-overlay">
        <div class="route-overlay-content">Getting route...</div>
      </div>

      <!-- Driver list panel -->
      <div class="driver-panel" :class="{ collapsed: panelCollapsed }">
        <button class="panel-toggle" @click="panelCollapsed = !panelCollapsed">
          Active Loads <span class="panel-count">{{ activeLocations.length }}</span>
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
            v-for="loc in activeLocations"
            :key="loc.driver"
            class="driver-item-wrap"
          >
            <div
              :class="['driver-item', { active: selectedDriver === loc.driver, 'no-gps': loc.noGps }]"
              @click="!loc.noGps && (selectedDriver === loc.driver ? collapseDriver() : focusDriver(loc))"
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
                <span v-if="inTransitLoad(loc)" class="driver-load">{{ inTransitLoad(loc) }}</span>
                <span v-if="driverOutOfRange(loc)" class="driver-warning">{{ driverOutOfRange(loc) }}</span>
              </div>
              <span v-if="loc.speed && isOnline(loc)" class="driver-speed">{{ Math.round(loc.speed * 2.237) }} mph</span>
            </div>
            <!-- Level 1: Active loads list (expands when driver is selected) -->
            <div v-if="selectedDriver === loc.driver && loc.activeLoads && loc.activeLoads.length > 0" class="loads-accordion">
              <div
                v-for="al in loc.activeLoads"
                :key="al.loadId"
                class="load-entry"
              >
                <div
                  :class="['load-entry-header', { active: expandedLoadId === al.loadId }]"
                  @click.stop="toggleLoad(al, loc)"
                >
                  <span class="load-entry-id">{{ al.loadId }}</span>
                  <span class="load-entry-status">{{ al.status }}</span>
                  <span class="load-entry-chevron" :class="{ open: expandedLoadId === al.loadId }">&#9662;</span>
                </div>
                <div v-if="al.details" class="load-entry-details">{{ al.details }}</div>
                <!-- Level 2: Point A/B details (expands when load is clicked) -->
                <div v-if="expandedLoadId === al.loadId" class="route-accordion">
                  <div v-if="al.originLat" class="route-point clickable" @click.stop="focusPoint(al.originLat, al.originLng)">
                    <div class="route-point-header">
                      <span class="route-point-dot pickup"></span>
                      <span class="route-point-label">Pickup (A)</span>
                    </div>
                    <div v-if="al.pickupAddress" class="route-point-address">{{ al.pickupAddress }}</div>
                    <div class="route-point-coords">{{ al.originLat.toFixed(5) }}, {{ al.originLng.toFixed(5) }}</div>
                  </div>
                  <div v-if="al.destLat" class="route-point clickable" @click.stop="focusPoint(al.destLat, al.destLng)">
                    <div class="route-point-header">
                      <span class="route-point-dot dropoff"></span>
                      <span class="route-point-label">Drop-off (B)</span>
                    </div>
                    <div v-if="al.dropoffAddress" class="route-point-address">{{ al.dropoffAddress }}</div>
                    <div class="route-point-coords">{{ al.destLat.toFixed(5) }}, {{ al.destLng.toFixed(5) }}</div>
                  </div>
                  <div v-if="routeDistance != null || routeEta != null || selectedDriverSpeed != null" class="route-summary">
                    <span v-if="routeDistance != null" class="route-stat">{{ routeDistance }} km</span>
                    <span v-if="routeEta != null" class="route-stat">{{ routeEta }} min ETA</span>
                    <span v-if="selectedDriverSpeed != null" class="route-stat speed">{{ selectedDriverSpeed }} mph</span>
                  </div>
                  <div v-if="weatherData" class="route-weather">
                    <span class="weather-temp">{{ weatherData.tempF != null ? Math.round(weatherData.tempF) + '°F' : '' }}</span>
                    <span class="weather-cond">{{ weatherData.condition }}</span>
                    <span v-if="weatherData.windMph != null" class="weather-wind">💨 {{ Math.round(weatherData.windMph) }} mph</span>
                    <span v-if="weatherData.humidity != null" class="weather-humidity">💧 {{ weatherData.humidity }}%</span>
                  </div>
                </div>
              </div>
            </div>
            <div v-else-if="selectedDriver === loc.driver && (!loc.activeLoads || loc.activeLoads.length === 0)" class="loads-accordion">
              <div class="no-active-loads">No active loads</div>
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
const expandedLoadId = ref('')
let focusGeneration = 0  // incremented on each focus action to cancel stale async fits
const fetchingRoute = ref(false)
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
const weatherData = ref(null)

// All-drivers route state
const allRoutes = ref([])
// Single-driver multi-load route state (when driver selected but no load expanded)
const driverRoutes = ref([])
const ROUTE_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#be185d', '#65a30d']
const PAST_PICKUP_RE = /^(at shipper|loading|in transit|at receiver)$/i

// Client-side route cache for static (origin→destination) routes
const staticRouteCache = new Map()
const CLIENT_CACHE_TTL = 10 * 60 * 1000 // 10 minutes

function clientCacheKey(fromLat, fromLng, toLat, toLng) {
  return `${Number(fromLat).toFixed(3)},${Number(fromLng).toFixed(3)}>${Number(toLat).toFixed(3)},${Number(toLng).toFixed(3)}`
}

async function fetchRouteCached(fromLat, fromLng, toLat, toLng) {
  const key = clientCacheKey(fromLat, fromLng, toLat, toLng)
  const cached = staticRouteCache.get(key)
  if (cached && Date.now() - cached.time < CLIENT_CACHE_TTL) {
    return cached.data
  }
  const data = await api.get(`/api/route?fromLat=${fromLat}&fromLng=${fromLng}&toLat=${toLat}&toLng=${toLng}`)
  staticRouteCache.set(key, { data, time: Date.now() })
  return data
}

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

// Safe fitBounds — validates coordinates to avoid "Bounds are not valid" errors
function safeFitBounds(map, points, options = {}) {
  try {
    const valid = points.filter(p =>
      Array.isArray(p) && p.length >= 2 &&
      typeof p[0] === 'number' && typeof p[1] === 'number' &&
      isFinite(p[0]) && isFinite(p[1]) &&
      Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180
    )
    if (valid.length === 0) return
    if (valid.length === 1) {
      map.setView(valid[0], options.maxZoom || 12, { animate: false })
      return
    }
    const bounds = L.latLngBounds(valid.map(p => L.latLng(p[0], p[1])))
    if (!bounds.isValid()) return
    map.fitBounds(bounds, options)
  } catch { /* silent — prevent Leaflet errors from breaking the UI */ }
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

const routeMidpoint = computed(() => {
  const pts = routePoints.value
  if (pts.length < 2) return [0, 0]
  const mid = Math.floor(pts.length / 2)
  return pts[mid]
})

const distanceIcon = computed(() => L.divIcon({
  className: 'distance-label-icon',
  html: `<div class="distance-label">${routeDistance.value != null ? routeDistance.value + ' km' : ''}</div>`,
  iconSize: [80, 24],
  iconAnchor: [40, 12],
}))

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

function focusPoint(lat, lng) {
  const map = mapRef.value?.leafletObject
  if (map) {
    map.setView([lat, lng], 15, { animate: true })
  }
}

async function fetchDriverRoutes(loc) {
  driverRoutes.value = []
  const loads = loc.activeLoads || []
  if (loads.length === 0) return

  const hasDriverGps = loc.latitude != null && loc.longitude != null

  // Show points immediately from known coords with straight-line routes
  const routes = []
  for (let i = 0; i < loads.length; i++) {
    const al = loads[i]
    const oLat = Number(al.originLat), oLng = Number(al.originLng)
    const dLat = Number(al.destLat), dLng = Number(al.destLng)
    const origin = isFinite(oLat) && isFinite(oLng) ? [oLat, oLng] : null
    const dest = isFinite(dLat) && isFinite(dLng) ? [dLat, dLng] : null
    if (!origin && !dest) continue
    const isPastPickup = PAST_PICKUP_RE.test(al.status)
    const routeFrom = (isPastPickup && hasDriverGps) ? [loc.latitude, loc.longitude] : origin
    routes.push({
      loadId: al.loadId,
      route: routeFrom && dest ? [routeFrom, dest] : [],
      origin,
      dest,
      originAddress: al.pickupAddress || '',
      destAddress: al.dropoffAddress || '',
      color: ROUTE_COLORS[i % ROUTE_COLORS.length],
    })
  }
  driverRoutes.value = routes

  // Fetch actual driving routes and replace straight lines
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i]
    if (!r.dest) continue
    const al = loads[i]
    const isPastPickup = PAST_PICKUP_RE.test(al?.status)
    const fromPt = (isPastPickup && hasDriverGps) ? [loc.latitude, loc.longitude] : r.origin
    if (!fromPt) continue
    try {
      const data = await api.get(`/api/route?fromLat=${fromPt[0]}&fromLng=${fromPt[1]}&toLat=${r.dest[0]}&toLng=${r.dest[1]}`)
      if (data.route && data.route.length >= 2) {
        routes[i] = { ...r, route: data.route.map(p => [p.latitude, p.longitude]) }
        driverRoutes.value = [...routes]
      }
    } catch { /* keep straight line */ }
  }
}

function collapseDriver() {
  ++focusGeneration
  selectedDriver.value = ''
  expandedLoadId.value = ''
  driverRoutes.value = []
  routePoints.value = []
  originLatLng.value = null
  destLatLng.value = null
  routeDistance.value = null
  fetchingRoute.value = false
}

async function focusDriver(loc) {
  ++focusGeneration
  selectedDriver.value = loc.driver
  expandedLoadId.value = ''
  allRoutes.value = []
  driverRoutes.value = []
  routePoints.value = []
  originLatLng.value = null
  destLatLng.value = null
  routeDistance.value = null
  fetchingRoute.value = false

  const map = mapRef.value?.leafletObject
  if (map && loc.latitude) {
    map.setView([loc.latitude, loc.longitude], 12, { animate: false })
  }
}

async function toggleLoad(al, loc) {
  ++focusGeneration

  if (expandedLoadId.value === al.loadId) {
    // Collapse
    expandedLoadId.value = ''
    routePoints.value = []
    originLatLng.value = null
    destLatLng.value = null
    routeDistance.value = null
    routeEta.value = null
    weatherData.value = null
    fetchingRoute.value = false
    return
  }

  // Expand: show origin/destination markers
  expandedLoadId.value = al.loadId
  driverRoutes.value = []
  routePoints.value = []

  const oLat = Number(al.originLat)
  const oLng = Number(al.originLng)
  const dLat = Number(al.destLat)
  const dLng = Number(al.destLng)
  const hasOrigin = isFinite(oLat) && isFinite(oLng)
  const hasDest = isFinite(dLat) && isFinite(dLng)

  // Set marker refs so the green/red dots appear on the map
  originLatLng.value = hasOrigin ? [oLat, oLng] : null
  originAddress.value = al.pickupAddress || ''
  destLatLng.value = hasDest ? [dLat, dLng] : null
  destAddress.value = al.dropoffAddress || ''

  // Wait for Vue to finish rendering markers before fitting map bounds
  await nextTick()

  const map = mapRef.value?.leafletObject
  if (map) {
    map.stop()
    map.invalidateSize()
    const boundsPoints = []
    if (hasOrigin) boundsPoints.push([oLat, oLng])
    if (hasDest) boundsPoints.push([dLat, dLng])
    if (boundsPoints.length >= 2) {
      safeFitBounds(map, boundsPoints, { padding: [50, 50], maxZoom: 14, animate: false })
    } else if (boundsPoints.length === 1) {
      map.setView(boundsPoints[0], 12, { animate: false })
    }
  }

  // TODO: route fetch
  // TODO: weather fetch (disabled)
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
  // Only update if new route succeeds — never clear the existing route
  if (minDist >= 100 && destLatLng.value) {
    lastRerouteTime = Date.now()
    try {
      const [toLat, toLng] = destLatLng.value
      const data = await api.get(`/api/route?fromLat=${lat}&fromLng=${lng}&toLat=${toLat}&toLng=${toLng}`)
      if (data.route && data.route.length >= 2) {
        routePoints.value = data.route.map(p => [p.latitude, p.longitude])
        routeDistance.value = data.distanceKm
        routeEta.value = data.etaMinutes
      }
    } catch {
      // silent — keep existing route
    }
  }
}

async function focusAll() {
  selectedDriver.value = '__all__'
  expandedLoadId.value = ''
  driverRoutes.value = []
  // Clear single-driver state
  trailPoints.value = []
  routePoints.value = []
  originLatLng.value = null
  destLatLng.value = null
  trailLoadId.value = ''
  routeDistance.value = null
  routeEta.value = null

  // Fetch routes for all online drivers with a load (concurrency-limited)
  const onlineWithLoad = locations.value.filter(loc => isOnline(loc) && loc.loadId)
  const MAX_CONCURRENT = 3
  const results = new Array(onlineWithLoad.length).fill(null)
  let nextIdx = 0

  async function trailWorker() {
    while (nextIdx < onlineWithLoad.length) {
      const i = nextIdx++
      const loc = onlineWithLoad[i]
      try {
        const data = await api.get(`/api/locations/trail?driver=${encodeURIComponent(loc.driver)}&loadId=${encodeURIComponent(loc.loadId)}`)
        results[i] = {
          driver: loc.driver,
          route: (data.route || []).map(p => [p.latitude, p.longitude]),
          origin: data.origin ? [data.origin.latitude, data.origin.longitude] : null,
          dest: data.destination ? [data.destination.latitude, data.destination.longitude] : null,
          color: ROUTE_COLORS[i % ROUTE_COLORS.length],
        }
      } catch {
        results[i] = null
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, onlineWithLoad.length) }, () => trailWorker()))
  allRoutes.value = results.filter(r => r && (r.route.length >= 2 || r.origin || r.dest))

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
  safeFitBounds(map, allPts, { padding: [50, 50], maxZoom: 12, animate: true })
}

// Online/offline detection (5-minute threshold)
const now = ref(Date.now())
let nowInterval = null
const ONLINE_THRESHOLD = 5 * 60 * 1000 // 5 minutes

function driverToPickupKm(loc) {
  if (!originLatLng.value || !loc.latitude) return '—'
  const R = 6371
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(originLatLng.value[0] - loc.latitude)
  const dLng = toRad(originLatLng.value[1] - loc.longitude)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(loc.latitude)) * Math.cos(toRad(originLatLng.value[0])) * Math.sin(dLng / 2) ** 2
  return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1)
}

function inTransitLoad(loc) {
  const al = (loc.activeLoads || []).find(l => /^in transit$/i.test(l.status))
  return al ? al.loadId : ''
}

function driverOutOfRange(loc) {
  if (!loc.latitude || loc.noGps || !isOnline(loc)) return ''
  const loads = loc.activeLoads || []
  if (loads.length === 0) return ''
  // Check distance to the nearest load point (origin or destination)
  const R = 6371 // km
  const toRad = d => d * Math.PI / 180
  let minDist = Infinity
  for (const al of loads) {
    for (const [lt, lg] of [[al.originLat, al.originLng], [al.destLat, al.destLng]]) {
      if (!lt || !lg) continue
      const dLat = toRad(lt - loc.latitude)
      const dLng = toRad(lg - loc.longitude)
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(loc.latitude)) * Math.cos(toRad(lt)) * Math.sin(dLng / 2) ** 2
      const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
      if (d < minDist) minDist = d
    }
  }
  if (minDist > 2000) return `${Math.round(minDist).toLocaleString()} km away`
  return ''
}

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
const activeLocations = computed(() => locations.value.filter(loc => loc.activeLoads && loc.activeLoads.length > 0))
const selectedDriverSpeed = computed(() => {
  const loc = locations.value.find(l => l.driver === selectedDriver.value)
  return loc?.speed ? Math.round(loc.speed * 2.237) : null
})

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

let initialFetchDone = false

async function fetchLocations() {
  try {
    const data = await api.get('/api/locations/latest')
    locations.value = data.locations || []
    // Only fit map on the very first load, not on refreshes
    if (!initialFetchDone) {
      initialFetchDone = true
      const withGps = locations.value.filter(l => !l.noGps && l.latitude != null)
      if (withGps.length > 0) {
        const pts = withGps.map(l => [l.latitude, l.longitude])
        mapCenter.value = pts[0]
        await nextTick()
        const map = mapRef.value?.leafletObject
        if (map) {
          safeFitBounds(map, pts, { padding: [50, 50], maxZoom: 12, animate: false })
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

.driver-warning {
  font-size: 0.62rem;
  font-weight: 600;
  color: #dc2626;
  background: #fef2f2;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  border: 1px solid #fecaca;
}

.driver-speed {
  font-size: 0.65rem;
  font-weight: 500;
  color: #888;
  flex-shrink: 0;
}

/* Loads & route accordion */
.driver-item-wrap {
  border-bottom: 1px solid #f3f4f6;
}
.driver-item-wrap:last-child {
  border-bottom: none;
}
.driver-item-wrap .driver-item {
  border-bottom: none;
}

.loads-accordion {
  background: #f8fafc;
  border-top: 1px dashed #e5e7eb;
  animation: accordion-open 0.2s ease-out;
}

.load-entry {
  border-bottom: 1px solid #f0f1f3;
}
.load-entry:last-child {
  border-bottom: none;
}

.load-entry-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.75rem 0.4rem 1.4rem;
  cursor: pointer;
  transition: background 0.15s;
}
.load-entry-header:hover {
  background: #eef2ff;
}
.load-entry-header.active {
  background: #e0e7ff;
}

.load-entry-id {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  font-weight: 600;
  color: #333;
}


.load-entry-status {
  font-size: 0.62rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: #4338ca;
  background: #e0e7ff;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
}

.load-entry-chevron {
  margin-left: auto;
  font-size: 0.55rem;
  color: #999;
  transition: transform 0.2s;
}
.load-entry-chevron.open {
  transform: rotate(180deg);
}

.load-entry-details {
  font-size: 0.68rem;
  color: #888;
  padding: 0 0.75rem 0.3rem 1.4rem;
  margin-top: -0.2rem;
}

.no-active-loads {
  font-size: 0.72rem;
  color: #aaa;
  text-align: center;
  padding: 0.5rem 0;
}

.route-accordion {
  padding: 0.4rem 0.75rem 0.6rem 1.8rem;
  animation: accordion-open 0.2s ease-out;
}

@keyframes accordion-open {
  from { opacity: 0; max-height: 0; }
  to { opacity: 1; max-height: 300px; }
}

.route-point {
  margin-bottom: 0.45rem;
}

.route-point.clickable {
  cursor: pointer;
  border-radius: 6px;
  padding: 0.25rem 0.35rem;
  margin-left: -0.35rem;
  transition: background 0.15s;
}

.route-point.clickable:hover {
  background: #e0e7ff;
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

.route-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.5);
  pointer-events: none;
}

.route-overlay-content {
  background: #fff;
  padding: 0.5rem 1.2rem;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  font-size: 0.85rem;
  font-weight: 600;
  color: #4338ca;
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
.route-stat.speed {
  color: #0f766e;
  background: #d1fae5;
}

.route-weather {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.35rem;
  padding-top: 0.35rem;
  border-top: 1px solid #e5e7eb;
}
.weather-temp {
  font-size: 0.75rem;
  font-weight: 700;
  color: #1e293b;
}
.weather-cond {
  font-size: 0.7rem;
  color: #64748b;
  text-transform: capitalize;
}
.weather-wind,
.weather-humidity {
  font-size: 0.68rem;
  color: #64748b;
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
.distance-label-icon {
  background: none !important;
  border: none !important;
}
.distance-label {
  background: #fff;
  color: #333;
  font-size: 0.72rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  white-space: nowrap;
  text-align: center;
}
</style>
