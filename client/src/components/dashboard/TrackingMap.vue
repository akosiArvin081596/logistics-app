<template>
  <div class="tracking-container">
    <div v-if="loading" class="tracking-loading">Loading map data...</div>
    <div v-else-if="locations.length === 0" class="tracking-empty">
      No active driver locations in the last hour.
    </div>
    <div v-else class="map-wrap">
      <div ref="mapContainer" style="height:100%;width:100%;"></div>

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
                    <span v-if="routeDistance != null" class="route-stat">{{ routeDistance }} mi</span>
                    <span v-if="routeEta != null" class="route-stat">{{ routeEta }} min ETA</span>
                    <span v-if="selectedDriverSpeed != null" class="route-stat speed">{{ selectedDriverSpeed }} mph</span>
                  </div>
                  <div v-if="weatherData" class="route-weather">
                    <span class="weather-temp">{{ weatherData.tempF != null ? Math.round(weatherData.tempF) + '°F' : '' }}</span>
                    <span class="weather-cond">{{ weatherData.condition }}</span>
                    <span v-if="weatherData.windMph != null" class="weather-wind">{{ Math.round(weatherData.windMph) }} mph</span>
                    <span v-if="weatherData.humidity != null" class="weather-humidity">{{ weatherData.humidity }}%</span>
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
import { useGoogleMaps } from '../../composables/useGoogleMaps'

const props = defineProps({
  visible: { type: Boolean, default: false },
})

const api = useApi()
const socket = useSocket()
const { createMap } = useGoogleMaps()

const mapContainer = ref(null)
let map = null
const locations = ref([])
const loading = ref(true)
const selectedDriver = ref('')
const expandedLoadId = ref('')
let focusGeneration = 0  // incremented on each focus action to cancel stale async fits
const fetchingRoute = ref(false)
const panelCollapsed = ref(false)

// Google Maps overlay objects (managed programmatically)
const driverMarkers = new Map()   // driver name -> google.maps.Marker
let originMarker = null
let destMarker = null
let distanceLabelMarker = null
let routePolyline = null
let driverRouteOverlays = []      // { polyline, originMarker, destMarker, infoO, infoD }
let allRouteOverlays = []         // same shape, for "All Drivers" view
let driverInfoWindows = new Map() // driver name -> google.maps.InfoWindow

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

// Client-side route cache for static (origin->destination) routes
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

// ---- Haversine distance in meters (replaces L.latLng().distanceTo()) ----
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000 // Earth radius in meters
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ---- Smooth marker animation via requestAnimationFrame ----
function animateMarker(driver, fromLat, fromLng, toLat, toLng, duration = 800) {
  if (activeAnimations[driver]) cancelAnimationFrame(activeAnimations[driver])
  const markerObj = driverMarkers.get(driver)
  const start = performance.now()

  function frame(now) {
    const t = Math.min((now - start) / duration, 1)
    const eased = t * (2 - t) // ease-out quadratic
    const lat = fromLat + (toLat - fromLat) * eased
    const lng = fromLng + (toLng - fromLng) * eased
    // Update the Google Maps marker position directly
    if (markerObj) {
      markerObj.setPosition({ lat, lng })
    }
    // Also update reactive data for panel display
    const loc = locations.value.find((l) => l.driver === driver)
    if (loc) {
      loc.latitude = lat
      loc.longitude = lng
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
  // ~0.002 degrees ~ 200m -- only snap if reasonably close to route
  return minDist < 0.002 * 0.002 ? closest : null
}

// ---- Google Maps helpers ----
function dotIcon(color, scale = 7) {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: '#fff',
    strokeWeight: 2,
  }
}

function endpointIcon(color) {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 9,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: '#fff',
    strokeWeight: 3,
  }
}

function safeFitBounds(points, options = {}) {
  if (!map) return
  try {
    const valid = points.filter(p =>
      Array.isArray(p) && p.length >= 2 &&
      typeof p[0] === 'number' && typeof p[1] === 'number' &&
      isFinite(p[0]) && isFinite(p[1]) &&
      Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180
    )
    if (valid.length === 0) return
    if (valid.length === 1) {
      map.setCenter({ lat: valid[0][0], lng: valid[0][1] })
      map.setZoom(options.maxZoom || 12)
      return
    }
    const bounds = new google.maps.LatLngBounds()
    valid.forEach(p => bounds.extend({ lat: p[0], lng: p[1] }))
    map.fitBounds(bounds, options.padding ? options.padding[0] : 50)
  } catch { /* silent -- prevent Google Maps errors from breaking the UI */ }
}

// ---- Clear overlay helpers ----
function clearSingleLoadOverlays() {
  if (routePolyline) { routePolyline.setMap(null); routePolyline = null }
  if (originMarker) { originMarker.setMap(null); originMarker = null }
  if (destMarker) { destMarker.setMap(null); destMarker = null }
  if (distanceLabelMarker) { distanceLabelMarker.setMap(null); distanceLabelMarker = null }
}

function clearDriverRouteOverlays() {
  for (const o of driverRouteOverlays) {
    if (o.polyline) o.polyline.setMap(null)
    if (o.originMarker) o.originMarker.setMap(null)
    if (o.destMarker) o.destMarker.setMap(null)
  }
  driverRouteOverlays = []
}

function clearAllRouteOverlays() {
  for (const o of allRouteOverlays) {
    if (o.polyline) o.polyline.setMap(null)
    if (o.originMarker) o.originMarker.setMap(null)
    if (o.destMarker) o.destMarker.setMap(null)
  }
  allRouteOverlays = []
}

// ---- Build/rebuild Google Maps overlays from reactive state ----
function renderSingleLoadRoute() {
  clearSingleLoadOverlays()
  if (!map) return
  if (selectedDriver.value === '__all__' || !expandedLoadId.value) return

  // Route polyline
  if (routePoints.value.length >= 2) {
    routePolyline = new google.maps.Polyline({
      path: routePoints.value.map(p => ({ lat: p[0], lng: p[1] })),
      strokeColor: '#000000',
      strokeOpacity: 0.7,
      strokeWeight: 6,
      map,
    })

    // Distance label at midpoint
    if (routeDistance.value != null) {
      const mid = Math.floor(routePoints.value.length / 2)
      const midPt = routePoints.value[mid]
      distanceLabelMarker = new google.maps.Marker({
        position: { lat: midPt[0], lng: midPt[1] },
        map,
        icon: {
          path: 'M 0,0',
          scale: 0,
        },
        label: {
          text: routeDistance.value + ' mi',
          color: '#333',
          fontSize: '11px',
          fontWeight: '700',
          fontFamily: 'JetBrains Mono, monospace',
          className: 'distance-label',
        },
        clickable: false,
        zIndex: 900,
      })
    }
  }

  // Origin marker (green)
  if (originLatLng.value) {
    originMarker = new google.maps.Marker({
      position: { lat: originLatLng.value[0], lng: originLatLng.value[1] },
      map,
      icon: endpointIcon('#16a34a'),
      title: 'Pickup',
      zIndex: 800,
    })
    const infoContent = `<div style="font-family:DM Sans,sans-serif;font-size:0.85rem"><strong>Pickup</strong>${originAddress.value ? '<div style="color:#444;font-size:0.8rem;margin-top:2px">' + originAddress.value + '</div>' : ''}</div>`
    const info = new google.maps.InfoWindow({ content: infoContent })
    originMarker.addListener('click', () => info.open(map, originMarker))
  }

  // Destination marker (red)
  if (destLatLng.value) {
    destMarker = new google.maps.Marker({
      position: { lat: destLatLng.value[0], lng: destLatLng.value[1] },
      map,
      icon: endpointIcon('#dc2626'),
      title: 'Drop-off',
      zIndex: 800,
    })
    const infoContent = `<div style="font-family:DM Sans,sans-serif;font-size:0.85rem"><strong>Drop-off</strong>${destAddress.value ? '<div style="color:#444;font-size:0.8rem;margin-top:2px">' + destAddress.value + '</div>' : ''}</div>`
    const info = new google.maps.InfoWindow({ content: infoContent })
    destMarker.addListener('click', () => info.open(map, destMarker))
  }
}

function renderDriverRoutes() {
  clearDriverRouteOverlays()
  if (!map) return
  if (selectedDriver.value === '__all__' || expandedLoadId.value) return

  for (const r of driverRoutes.value) {
    const entry = {}

    if (r.route.length >= 2) {
      entry.polyline = new google.maps.Polyline({
        path: r.route.map(p => ({ lat: p[0], lng: p[1] })),
        strokeColor: r.color,
        strokeOpacity: 0.7,
        strokeWeight: 4,
        map,
      })
    }
    if (r.origin) {
      entry.originMarker = new google.maps.Marker({
        position: { lat: r.origin[0], lng: r.origin[1] },
        map,
        icon: endpointIcon('#16a34a'),
        title: r.loadId + ' - Pickup',
        zIndex: 800,
      })
      const info = new google.maps.InfoWindow({
        content: `<div style="font-family:DM Sans,sans-serif;font-size:0.85rem"><strong>${r.loadId} — Pickup</strong>${r.originAddress ? '<div style="color:#444;font-size:0.8rem;margin-top:2px">' + r.originAddress + '</div>' : ''}</div>`,
      })
      entry.originMarker.addListener('click', () => info.open(map, entry.originMarker))
    }
    if (r.dest) {
      entry.destMarker = new google.maps.Marker({
        position: { lat: r.dest[0], lng: r.dest[1] },
        map,
        icon: endpointIcon('#dc2626'),
        title: r.loadId + ' - Drop-off',
        zIndex: 800,
      })
      const info = new google.maps.InfoWindow({
        content: `<div style="font-family:DM Sans,sans-serif;font-size:0.85rem"><strong>${r.loadId} — Drop-off</strong>${r.destAddress ? '<div style="color:#444;font-size:0.8rem;margin-top:2px">' + r.destAddress + '</div>' : ''}</div>`,
      })
      entry.destMarker.addListener('click', () => info.open(map, entry.destMarker))
    }

    driverRouteOverlays.push(entry)
  }
}

function renderAllRoutes() {
  clearAllRouteOverlays()
  if (!map) return
  if (selectedDriver.value !== '__all__') return

  for (const r of allRoutes.value) {
    const entry = {}

    if (r.route.length >= 2) {
      entry.polyline = new google.maps.Polyline({
        path: r.route.map(p => ({ lat: p[0], lng: p[1] })),
        strokeColor: r.color,
        strokeOpacity: 0.7,
        strokeWeight: 4,
        map,
      })
    }
    if (r.origin) {
      entry.originMarker = new google.maps.Marker({
        position: { lat: r.origin[0], lng: r.origin[1] },
        map,
        icon: endpointIcon('#16a34a'),
        title: r.driver + ' - Pickup',
        zIndex: 800,
      })
      const info = new google.maps.InfoWindow({
        content: `<div style="font-family:DM Sans,sans-serif;font-size:0.85rem"><strong>${r.driver} — Pickup</strong></div>`,
      })
      entry.originMarker.addListener('click', () => info.open(map, entry.originMarker))
    }
    if (r.dest) {
      entry.destMarker = new google.maps.Marker({
        position: { lat: r.dest[0], lng: r.dest[1] },
        map,
        icon: endpointIcon('#dc2626'),
        title: r.driver + ' - Destination',
        zIndex: 800,
      })
      const info = new google.maps.InfoWindow({
        content: `<div style="font-family:DM Sans,sans-serif;font-size:0.85rem"><strong>${r.driver} — Destination</strong></div>`,
      })
      entry.destMarker.addListener('click', () => info.open(map, entry.destMarker))
    }

    allRouteOverlays.push(entry)
  }
}

// ---- Sync driver markers with locations data ----
function syncDriverMarkers() {
  if (!map) return
  const currentDrivers = new Set()

  for (const loc of locationsWithGps.value) {
    currentDrivers.add(loc.driver)
    let marker = driverMarkers.get(loc.driver)
    if (!marker) {
      // Create new marker for this driver
      const isOn = isOnline(loc)
      marker = new google.maps.Marker({
        position: { lat: loc.latitude, lng: loc.longitude },
        map,
        icon: dotIcon(isOn ? '#16a34a' : '#9ca3af', 7),
        title: loc.driver,
        zIndex: 1000,
      })
      // InfoWindow for the driver marker
      const iw = new google.maps.InfoWindow()
      marker.addListener('click', () => {
        iw.setContent(buildDriverPopupContent(loc))
        iw.open(map, marker)
      })
      driverInfoWindows.set(loc.driver, iw)
      driverMarkers.set(loc.driver, marker)
    } else {
      // Update position
      marker.setPosition({ lat: loc.latitude, lng: loc.longitude })
      // Update icon color based on online status
      const isOn = isOnline(loc)
      marker.setIcon(dotIcon(isOn ? '#16a34a' : '#9ca3af', 7))
    }
  }

  // Remove markers for drivers no longer present
  for (const [driver, marker] of driverMarkers) {
    if (!currentDrivers.has(driver)) {
      marker.setMap(null)
      driverMarkers.delete(driver)
      const iw = driverInfoWindows.get(driver)
      if (iw) { iw.close(); driverInfoWindows.delete(driver) }
    }
  }

  // Update visibility based on selection
  updateMarkerVisibility()
}

function buildDriverPopupContent(loc) {
  let html = `<div style="font-family:DM Sans,sans-serif;font-size:0.85rem"><strong>${loc.driver}</strong>`
  const loadId = inTransitLoad(loc)
  if (loadId) html += `<div style="color:#555;font-size:0.8rem">Load: ${loadId}</div>`
  html += `<div style="color:#888;font-size:0.72rem;font-family:JetBrains Mono,monospace">${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}</div>`
  if (loc.speed) html += `<div style="color:#555;font-size:0.8rem">Speed: ${Math.round(loc.speed * 2.237)} mph</div>`
  if (selectedDriver.value === loc.driver && originLatLng.value && expandedLoadId.value) {
    html += `<div style="font-weight:600;font-size:0.8rem">${driverToPickupMi(loc)} mi to Pickup</div>`
  }
  html += `<div style="color:#999;font-size:0.7rem;margin-top:3px">${formatTime(loc.timestamp)}</div>`
  html += '</div>'
  return html
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
    routeDistance.value = data.distanceMiles
    routeEta.value = data.etaMinutes
    trailLoadId.value = loadId
  } catch {
    // silent -- trail is supplementary
  }
}

function focusPoint(lat, lng) {
  if (map) {
    map.setCenter({ lat, lng })
    map.setZoom(15)
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
  clearSingleLoadOverlays()
  clearDriverRouteOverlays()
  clearAllRouteOverlays()
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
  clearSingleLoadOverlays()
  clearAllRouteOverlays()

  if (map && loc.latitude) {
    map.setCenter({ lat: loc.latitude, lng: loc.longitude })
    map.setZoom(12)
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
    clearSingleLoadOverlays()
    return
  }

  // Expand: show origin/destination markers
  expandedLoadId.value = al.loadId
  driverRoutes.value = []
  routePoints.value = []
  clearDriverRouteOverlays()
  clearSingleLoadOverlays()

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

  // Determine route-from point: driver GPS when past pickup, otherwise origin
  // Fall back to origin if driver is too far (>2000 km) from load area
  const isPastPickup = PAST_PICKUP_RE.test(al.status)
  const hasDriverGps = loc.latitude != null && loc.longitude != null
  let useDriverPos = isPastPickup && hasDriverGps
  if (useDriverPos && (hasOrigin || hasDest)) {
    const refLat = hasOrigin ? oLat : dLat
    const refLng = hasOrigin ? oLng : dLng
    const R = 6371, toRad = d => d * Math.PI / 180
    const dLa = toRad(refLat - loc.latitude), dLo = toRad(refLng - loc.longitude)
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(loc.latitude)) * Math.cos(toRad(refLat)) * Math.sin(dLo / 2) ** 2
    if (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) > 2000) useDriverPos = false
  }
  const fromLat = useDriverPos ? loc.latitude : oLat
  const fromLng = useDriverPos ? loc.longitude : oLng
  const hasFrom = isFinite(fromLat) && isFinite(fromLng)

  await nextTick()

  if (map) {
    const boundsPoints = []
    if (hasOrigin) boundsPoints.push([oLat, oLng])
    if (hasDest) boundsPoints.push([dLat, dLng])
    if (boundsPoints.length >= 2) {
      safeFitBounds(boundsPoints, { padding: [50, 50], maxZoom: 14 })
    } else if (boundsPoints.length === 1) {
      map.setCenter({ lat: boundsPoints[0][0], lng: boundsPoints[0][1] })
      map.setZoom(12)
    }
  }

  // Render origin/dest markers immediately
  renderSingleLoadRoute()

  // Fetch route polyline in background
  if (hasFrom && hasDest) {
    const gen = focusGeneration
    fetchingRoute.value = true
    try {
      const data = useDriverPos
        ? await api.get(`/api/route?fromLat=${fromLat}&fromLng=${fromLng}&toLat=${dLat}&toLng=${dLng}`)
        : await fetchRouteCached(fromLat, fromLng, dLat, dLng)
      if (gen !== focusGeneration) return
      if (data.route && data.route.length >= 2) {
        routePoints.value = data.route.map(p => [p.latitude, p.longitude])
      } else if (hasOrigin) {
        routePoints.value = [[oLat, oLng], [dLat, dLng]]
      }
      routeDistance.value = data.distanceMiles || null
      routeEta.value = data.etaMinutes || null
    } catch {
      if (gen !== focusGeneration) return
      if (hasOrigin) routePoints.value = [[oLat, oLng], [dLat, dLng]]
    } finally {
      fetchingRoute.value = false
    }
    // Re-render with the fetched route
    renderSingleLoadRoute()
  }

  // Weather fetch disabled to reduce Google API costs
}

let lastRerouteTime = 0

async function checkOffRoute(lat, lng) {
  // Rate-limit: max once every 30 seconds
  if (Date.now() - lastRerouteTime < 30000) return

  // Find minimum distance from driver to any point on the route
  let minDist = Infinity
  for (const pt of routePoints.value) {
    const d = haversineMeters(lat, lng, pt[0], pt[1])
    if (d < minDist) minDist = d
    if (d < 100) return // still on route, no need to check further
  }

  // Off-route: recalculate from current position to destination
  // Only update if new route succeeds -- never clear the existing route
  if (minDist >= 100 && destLatLng.value) {
    lastRerouteTime = Date.now()
    try {
      const [toLat, toLng] = destLatLng.value
      const data = await api.get(`/api/route?fromLat=${lat}&fromLng=${lng}&toLat=${toLat}&toLng=${toLng}`)
      if (data.route && data.route.length >= 2) {
        routePoints.value = data.route.map(p => [p.latitude, p.longitude])
        routeDistance.value = data.distanceMiles
        routeEta.value = data.etaMinutes
        renderSingleLoadRoute()
      }
    } catch {
      // silent -- keep existing route
    }
  }
}

async function focusAll() {
  selectedDriver.value = '__all__'
  expandedLoadId.value = ''
  driverRoutes.value = []
  clearSingleLoadOverlays()
  clearDriverRouteOverlays()
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

  // Render all routes on map
  renderAllRoutes()

  // Fit bounds to all online drivers
  await nextTick()
  if (!map) return
  const withGps = locationsWithGps.value
  if (withGps.length === 0) return
  const allPts = withGps.map(loc => [loc.latitude, loc.longitude])
  // Include origins and destinations from routes
  for (const r of allRoutes.value) {
    if (r.origin) allPts.push(r.origin)
    if (r.dest) allPts.push(r.dest)
  }
  safeFitBounds(allPts, { padding: [50, 50], maxZoom: 12 })
}

// Online/offline detection (5-minute threshold)
const now = ref(Date.now())
let nowInterval = null
const ONLINE_THRESHOLD = 5 * 60 * 1000 // 5 minutes

function driverToPickupMi(loc) {
  if (!originLatLng.value || !loc.latitude) return '\u2014'
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
  const R = 3959 // miles
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
  if (minDist > 1243) return `${Math.round(minDist).toLocaleString()} mi away`
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

function updateMarkerVisibility() {
  if (!map) return
  const sel = selectedDriver.value
  const showAll = !sel || sel === '__all__'
  for (const [driver, marker] of driverMarkers) {
    const show = showAll || driver === sel
    marker.setVisible(show)
  }
}

watch(selectedDriver, () => {
  nextTick(updateMarkerVisibility)
})

// Watch for changes in reactive route data and re-render overlays
watch(routePoints, () => {
  if (expandedLoadId.value) renderSingleLoadRoute()
})

watch(driverRoutes, () => {
  renderDriverRoutes()
}, { deep: true })

watch(allRoutes, () => {
  renderAllRoutes()
}, { deep: true })

// Watch selected driver to load routes for the driver
watch(selectedDriver, async (driverName) => {
  if (driverName && driverName !== '__all__' && !expandedLoadId.value) {
    const loc = locations.value.find(l => l.driver === driverName)
    if (loc) await fetchDriverRoutes(loc)
  }
})

let initialFetchDone = false

async function fetchLocations() {
  try {
    const data = await api.get('/api/locations/latest')
    locations.value = data.locations || []
    // Sync Google Maps markers
    await nextTick()
    syncDriverMarkers()
    // Only fit map on the very first load, not on refreshes
    if (!initialFetchDone) {
      initialFetchDone = true
      const withGps = locations.value.filter(l => !l.noGps && l.latitude != null)
      if (withGps.length > 0) {
        const pts = withGps.map(l => [l.latitude, l.longitude])
        await nextTick()
        safeFitBounds(pts, { padding: [50, 50], maxZoom: 12 })
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
    // Create a marker for the new driver
    nextTick(() => syncDriverMarkers())
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
      if (map) {
        google.maps.event.trigger(map, 'resize')
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
    clearSingleLoadOverlays()
  }
  // Refresh locations to get updated loadId
  fetchLocations()
}

async function initMap() {
  if (!mapContainer.value || map) return
  map = await createMap(mapContainer.value, {
    zoom: 5,
    center: { lat: 39.8283, lng: -98.5795 },
    mapTypeId: 'roadmap',
    mapTypeControl: true,
    mapTypeControlOptions: {
      style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
      position: google.maps.ControlPosition.TOP_LEFT,
      mapTypeIds: ['roadmap', 'hybrid'],
    },
    minZoom: 3,
  })
  // After map is ready, fetch and render locations
  await fetchLocations()
}

onMounted(() => {
  socket.connect()
  socket.register('dispatch')
  socket.on('location-update', onLocationUpdate)
  socket.on('status-updated', onStatusUpdated)
  nowInterval = setInterval(() => { now.value = Date.now() }, 10000)
  // Initialize map once component is mounted
  nextTick(() => initMap())
})

onUnmounted(() => {
  socket.off('location-update', onLocationUpdate)
  socket.off('status-updated', onStatusUpdated)
  Object.values(activeAnimations).forEach(cancelAnimationFrame)
  clearInterval(nowInterval)
  // Clean up Google Maps objects
  for (const [, marker] of driverMarkers) marker.setMap(null)
  driverMarkers.clear()
  for (const [, iw] of driverInfoWindows) iw.close()
  driverInfoWindows.clear()
  clearSingleLoadOverlays()
  clearDriverRouteOverlays()
  clearAllRouteOverlays()
  map = null
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
</style>
