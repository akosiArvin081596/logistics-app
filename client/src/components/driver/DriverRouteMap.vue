<template>
  <div class="route-map-wrap">
    <template v-if="!hasCoords && !driverLatLng">
      <div class="map-empty">No route coordinates available</div>
    </template>
    <template v-else>
      <div class="map-info" v-if="hasCoords && (remainingDistanceMiles != null || remainingEtaMinutes != null || driverDistanceInfo)">
        <span v-if="remainingDistanceMiles != null" class="info-item">{{ remainingDistanceMiles }} mi</span>
        <span v-if="remainingEtaMinutes != null" class="info-item">{{ etaFormatted }} ETA</span>
        <span v-if="driverDistanceInfo" :class="['info-item', driverDistanceInfo.mi > 500 ? 'info-danger' : 'info-warn']">{{ driverDistanceInfo.mi }} mi {{ driverDistanceInfo.label }}</span>
        <!-- Drive Mode is a DRIVER affordance (turn-by-turn for the truck) and
             it needs `steps`, which the public payload deliberately omits — so
             on the customer tracker the button would open an empty fullscreen
             overlay. Hidden there rather than shipped broken. -->
        <button v-if="!publicMode" class="navmode-btn" @click="openNavMode" title="Navigation Mode">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polygon points="3 11 22 2 13 21 11 13 3 11" />
          </svg>
          <span>Navigate</span>
        </button>
      </div>
      <div v-if="!hasCoords" class="map-label">Your Current Location</div>
      <div v-else-if="!driverLatLng && !dispatchMode" class="map-eld-hint">
        Showing route only — truck position unavailable (ELD offline)
      </div>
      <div ref="mapContainer" class="map-container"></div>

      <!-- Drive Mode — live turn-by-turn navigation view. Replaces the static
           fullscreen overview previously rendered here. Alternatives + the
           full directions list still live in the inline LoadDetail collapses
           below the Route Map (drivers pick before tapping Navigate). -->
      <DriveModeOverlay
        :open="expanded"
        :active-route="activeRoute"
        :driver-position="props.driverPosition"
        :destination="navigationDestination"
        :route-version="routeVersion"
        :rerouting="rerouting"
        :off-route="offRoute"
        @close="closeNavMode"
      />
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useApi } from '../../composables/useApi'
import { useGoogleMaps, createDotPin } from '../../composables/useGoogleMaps'
import { useDriverPosition } from '../../composables/useDriverPosition'
import { useVoiceGuidance } from '../../composables/useVoiceGuidance'
import {
  buildRouteIndex,
  buildStepOffsets,
  nearestPointOnPath,
  matchToRoute,
  stepIndexForOffset,
  remainingMeters as routeRemainingMeters,
  remainingSeconds as routeRemainingSeconds,
  createDeviationDetector,
} from '../../utils/routeProgress'
import DriveModeOverlay from './DriveModeOverlay.vue'

const props = defineProps({
  load: { type: Object, required: true },
  headers: { type: Array, default: () => [] },
  driverPosition: { type: Object, default: null },
  dispatchMode: { type: Boolean, default: false },
  // When true, strip any driver-identifying info off the map. Used by the
  // public /track/:loadId customer page — customers see the pin but not the
  // driver's name. Also switches the route source: see presetRoute below.
  publicMode: { type: Boolean, default: false },
  // Pre-computed route geometry, for a surface that cannot call GET /api/route.
  // Shape matches that endpoint's LEAN response so nothing downstream changes:
  //   { route: [{latitude, longitude}, ...], distanceMiles, etaMinutes }
  // Deliberately carries no alternatives, no turn-by-turn steps and no fuel /
  // toll figures — the public payload does not expose them, so the
  // alternatives overlay, traffic overlay and Drive Mode stay empty here
  // rather than rendering half a route.
  presetRoute: { type: Object, default: null },
  // Which alternative is active. Parent (LoadDetail) owns this so the
  // RouteAlternatives card list it renders inline stays in sync with the
  // map. v-model-friendly: emit('update:selectedAltIdx', i).
  selectedAltIdx: { type: Number, default: 0 },
})

const emit = defineEmits(['route-data', 'update:selectedAltIdx'])

const api = useApi()
const { load: loadGoogleMaps, createMap } = useGoogleMaps()
const driverPos = useDriverPosition()
const voice = useVoiceGuidance()
const mapContainer = ref(null)
const expanded = ref(false)
const routePoints = ref([])
// Bumped whenever new geometry is installed. Drive Mode keys its voice ladder on
// this, so a reroute re-arms every callout on the new route (and only then).
const routeVersion = ref(0)
const rerouting = ref(false)
const offRoute = ref(false)

// Deviation-triggered rerouting.
//
// Client ask (Deshorn): "It should reroute depending on the current location
// that the driver is similar to if you [take] another turn on your regular GPS."
//
// WHAT THIS REPLACES, AND WHY THE OLD RULE WAS BACKWARDS. The previous gate was
// `moved > 0.06 mi AND >= 60 s since the last fetch` — purely a clock and an
// odometer, with no reference to the route at all. So it re-fetched a route for
// a driver who was following it perfectly (every 60 s, for the whole load) and
// it did NOT re-fetch for a driver who had missed an exit and was heading the
// wrong way at 60 mph, because that driver satisfied exactly the same two
// conditions and got exactly the same treatment. It was also the cost driver: at
// a 60 s cadence that authorised ~600 billed Google Routes calls per driver per
// day. Deviation-triggered is ~20, and it fires when it means something.
//
// The three guards are not optional (see utils/routeProgress.js):
//   - N consecutive confirmations, so GPS noise cannot trigger a reroute
//   - a movement requirement, so a truck PARKED off-route cannot spam one
//   - a cooldown and a hard per-trip cap, so a genuinely bad route cannot bill
//     unboundedly while the driver works out what to do
//
// Declared here, above onRouteGeometryChanged(), which reads it — a `const` in
// a temporal dead zone would throw rather than misbehave, but only on whichever
// future call path happens to run first.
const deviation = createDeviationDetector()
// Where along the route we matched last time, so the match stays forward-biased
// across fixes instead of snapping to whichever leg of a cloverleaf is nearer.
//
// A ref rather than a plain `let` because the header's distance + ETA are now
// DERIVED from it (see the live-figures block below routeIndex) and must
// re-render on every fix.
const matchOffset = ref(null)
let lastMatchAt = 0
// Whole-route figures exactly as the server sent them, for the geometry
// currently installed in routePoints. These are the 100% baseline the live
// header counts down FROM — see remainingDistanceMiles / remainingEtaMinutes.
const routeDistanceMiles = ref(null)
const routeEtaMinutes = ref(null)
// Turn-by-turn steps for that same geometry. Held beside routePoints and
// assigned at the same three sites, deliberately NOT read off `activeRoute`:
// that computed keys on the parent-owned selectedAltIdx, which lags by a tick
// whenever a refetch re-points the selection at the recommended alternative, and
// step offsets measured against the wrong polyline are worse than none.
const routeSteps = ref([])
// Full rich-route payload from the server. Populated on every fetchRoute()
// call. Stays empty when the lean (single-route) path is in use.
const allRoutes = ref([])      // array of { route, distanceMiles, etaMinutes, fuelLiters, tollPriceUsd, trafficSegments, steps }
const recommendedIdx = ref(0)
const alternatives = computed(() => allRoutes.value || [])
const activeRoute = computed(() => allRoutes.value[props.selectedAltIdx] || null)

function onSelectAlt(i) {
  emit('update:selectedAltIdx', i)
}

let map = null
let originMarker = null
let destMarker = null
let driverMarker = null
let routeLine = null
let routeAnim = null
let altPolylines = []          // gray dashed polylines for non-selected alts (inline map)
let trafficOverlays = []       // segment polylines colored by congestion (inline map)

function animatePolyline(line) {
  let offset = 0
  return setInterval(() => {
    offset = (offset + 1) % 200
    const icons = line.get('icons')
    icons[0].offset = (offset / 2) + '%'
    line.set('icons', icons)
  }, 80)
}

function animateMarker(marker, from, to, duration = 1000) {
  if (!marker || !from || !to) return
  const start = performance.now()
  function step(now) {
    const t = Math.min((now - start) / duration, 1)
    const ease = t * (2 - t) // ease-out quad
    const lat = from.lat + (to.lat - from.lat) * ease
    const lng = from.lng + (to.lng - from.lng) * ease
    marker.position = { lat, lng }
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

function findCol(regex) {
  return (props.headers || []).find(h => regex.test(h)) || null
}

const originLatCol = computed(() => findCol(/origin.*lat|pickup.*lat|shipper.*lat/i))
const originLngCol = computed(() => findCol(/origin.*l(on|ng)|pickup.*l(on|ng)|shipper.*l(on|ng)/i))
const destLatCol = computed(() => findCol(/dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i))
const destLngCol = computed(() => findCol(/dest.*l(on|ng)|drop.*l(on|ng)|receiver.*l(on|ng)|delivery.*l(on|ng)/i))

const originLatLng = computed(() => {
  if (!props.load || !originLatCol.value || !originLngCol.value) return null
  const lat = parseFloat(props.load[originLatCol.value])
  const lng = parseFloat(props.load[originLngCol.value])
  return !isNaN(lat) && !isNaN(lng) ? { lat, lng } : null
})
const destLatLng = computed(() => {
  if (!props.load || !destLatCol.value || !destLngCol.value) return null
  const lat = parseFloat(props.load[destLatCol.value])
  const lng = parseFloat(props.load[destLngCol.value])
  return !isNaN(lat) && !isNaN(lng) ? { lat, lng } : null
})
const driverLatLng = computed(() => {
  if (!props.driverPosition) return null
  return { lat: props.driverPosition.latitude, lng: props.driverPosition.longitude }
})

// Match "Status" AND "Job Status" (the Job Tracking sheet's column name used on
// the dispatcher dashboard). Anchored so it never grabs "Status Update Date" or
// "Carrier Stage". Without this the dispatcher's status was always empty, so an
// In-Transit load was treated as not-yet-picked-up and the route/ETA was drawn to
// the PICKUP (full haul) instead of from the truck's position to the DROP-OFF.
const statusCol = computed(() => (props.headers || []).find(h => /^(job[\s_-]*)?status$/i.test(h)) || null)
const loadStatus = computed(() => !props.load || !statusCol.value ? '' : (props.load[statusCol.value] || '').trim().toLowerCase())
const isDelivered = computed(() => /^(delivered|completed|pod received)$/i.test(loadStatus.value))
const hasCoords = computed(() => destLatLng.value != null && (!isDelivered.value || props.dispatchMode))
const isPrePickup = computed(() => /^(dispatched|assigned|new|pending)$/i.test(loadStatus.value))

function haversineMi(a, b) {
  const R = 3959
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return (R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))).toFixed(1)
}

const driverDistanceInfo = computed(() => {
  if (!driverLatLng.value) return null
  if (isPrePickup.value && originLatLng.value) return { mi: haversineMi(driverLatLng.value, originLatLng.value), label: 'to Pickup' }
  if (!isPrePickup.value && !isDelivered.value && destLatLng.value) return { mi: haversineMi(driverLatLng.value, destLatLng.value), label: 'to Drop-off' }
  return null
})

const originAddrCol = computed(() => (props.headers || []).find(h => /origin|pickup|shipper/i.test(h) && !/lat|lng|lon/i.test(h)) || null)
const destAddrCol = computed(() => (props.headers || []).find(h => /dest|drop|receiver|delivery/i.test(h) && !/lat|lng|lon|date|time|appt|eta/i.test(h)) || null)
const loadIdCol = computed(() => findCol(/load.?id|job.?id/i))
const driverColName = computed(() => findCol(/driver/i))

const originAddr = computed(() => props.load && originAddrCol.value ? props.load[originAddrCol.value] || '' : '')
const destAddr = computed(() => props.load && destAddrCol.value ? props.load[destAddrCol.value] || '' : '')
const loadIdValue = computed(() => props.load && loadIdCol.value ? props.load[loadIdCol.value] || '' : '')
const driverName = computed(() => props.load && driverColName.value ? props.load[driverColName.value] || '' : '')

// Destination for the "Navigate in Maps" handoff in RouteDirections. Matches
// the route fetch logic: pre-pickup the driver is heading to the shipper, so
// the handoff opens that; post-pickup it's the receiver.
const navigationDestination = computed(() => {
  const pickedUp = /^(at shipper|loading|in transit|at receiver|unloading)$/i.test(loadStatus.value)
  const target = pickedUp ? destLatLng.value : (originLatLng.value || destLatLng.value)
  if (!target) return null
  return {
    lat: target.lat,
    lng: target.lng,
    address: pickedUp ? destAddr.value : originAddr.value,
  }
})

function clearMapObjects() {
  if (routeAnim) { clearInterval(routeAnim); routeAnim = null }
  if (originMarker) { originMarker.map = null; originMarker = null }
  if (destMarker) { destMarker.map = null; destMarker = null }
  if (driverMarker) { driverMarker.map = null; driverMarker = null }
  if (routeLine) { routeLine.setMap(null); routeLine = null }
  for (const p of altPolylines) { p.setMap(null) }
  altPolylines = []
  for (const p of trafficOverlays) { p.setMap(null) }
  trafficOverlays = []
}

// Map Google's congestion codes to overlay colors. NORMAL renders nothing —
// the route's white base + animated blue dashes already show through, so we
// only highlight the segments that actually need driver attention.
const CONGESTION_COLOR = {
  SLOW: '#f59e0b',          // amber
  TRAFFIC_JAM: '#dc2626',   // red
  // NORMAL → no overlay
}

// Render gray dashed polylines for the non-selected alternatives so the
// driver sees what they're choosing between on the map itself, not just on
// the cards. Returns an array of created Polyline objects so the caller can
// stash them for later teardown.
function renderAlternatives(mapObj, selectedIdx) {
  const lines = []
  for (let i = 0; i < allRoutes.value.length; i++) {
    if (i === selectedIdx) continue
    const r = allRoutes.value[i]
    if (!r || !r.route || r.route.length < 2) continue
    const path = r.route.map(p => ({ lat: p.latitude, lng: p.longitude }))
    const line = new google.maps.Polyline({
      path,
      strokeColor: '#94a3b8',
      strokeOpacity: 0,                   // no solid stroke — icons-only dashes
      strokeWeight: 3,
      map: mapObj,
      clickable: false,
      icons: [{
        icon: { path: 'M 0,-1 0,1', strokeColor: '#94a3b8', strokeOpacity: 0.7, scale: 2 },
        offset: '0',
        repeat: '14px',
      }],
    })
    lines.push(line)
  }
  return lines
}

// Render colored overlays per traffic segment (SLOW + TRAFFIC_JAM only).
// Uses the original route geometry so segment indices line up with what
// Google computed — drivers see the road condition baked into the polyline.
function renderTrafficOverlays(mapObj, route) {
  const overlays = []
  if (!route || !route.trafficSegments || !route.route || route.route.length < 2) return overlays
  const points = route.route
  for (const seg of route.trafficSegments) {
    const color = CONGESTION_COLOR[seg.congestion]
    if (!color) continue
    const startIdx = Math.max(0, seg.startIdx | 0)
    const endIdx = Math.min(points.length - 1, seg.endIdx | 0)
    if (endIdx <= startIdx) continue
    const path = []
    for (let i = startIdx; i <= endIdx; i++) {
      path.push({ lat: points[i].latitude, lng: points[i].longitude })
    }
    if (path.length < 2) continue
    const line = new google.maps.Polyline({
      path,
      strokeColor: color,
      strokeOpacity: 0.85,
      strokeWeight: 6,
      map: mapObj,
      clickable: false,
      zIndex: 5,
    })
    overlays.push(line)
  }
  return overlays
}

// Build the polyline path: past pickup, trim the route at the driver's
// projected position so only the forward segment is drawn (Google Maps
// Navigation behavior). Prevents the V-shape that prepending creates when
// the truck moves past the static route start. Pass driverOverride from the
// animation frame to use a live in-flight position.
function buildRoutePath(driverOverride = null) {
  if (routePoints.value.length < 2) return null
  const points = routePoints.value

  // Always anchor the polyline to the truck pin. The route was fetched
  // from CURRENT TRUCK POSITION to PICKUP or DROP-OFF (see fetchRoute), so
  // trimming at the driver keeps the line glued to the pin regardless of
  // load status. Falling back to the raw route (origin→dest) drew the line
  // for the wrong leg of the journey while the truck was en route to
  // pickup, which is exactly what the user reported.
  //
  // publicMode is the one exception, because it fetches nothing: it is handed
  // the fixed pickup→drop-off haul (see applyPresetRoute), so trimming only
  // makes sense once the truck is ON that haul. Pre-pickup the truck is still
  // running to the shipper — projecting it onto the haul and then appending
  // `origin` as the terminal below would draw the entire lane followed by a
  // straight line back to its start. Draw the untrimmed lane instead; the
  // truck pin still shows where it is.
  const onHaul = !props.publicMode
    || /^(at shipper|loading|in transit|at receiver|unloading)$/i.test(loadStatus.value)
  const dp = onHaul ? (driverOverride || driverLatLng.value) : null
  if (!dp) {
    const path = points.map(p => ({ lat: p.latitude, lng: p.longitude }))
    if (destLatLng.value && hasCoords.value) path.push(destLatLng.value)
    return path
  }

  let minDistSq = Infinity
  let bestIdx = 0
  let bestT = 0
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const ax = a.longitude, ay = a.latitude
    const bx = b.longitude, by = b.latitude
    const px = dp.lng, py = dp.lat
    const dx = bx - ax, dy = by - ay
    const lenSq = dx * dx + dy * dy
    if (lenSq === 0) continue
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
    t = Math.max(0, Math.min(1, t))
    const projX = ax + t * dx
    const projY = ay + t * dy
    const distSq = (projX - px) ** 2 + (projY - py) ** 2
    if (distSq < minDistSq) {
      minDistSq = distSq
      bestIdx = i
      bestT = t
    }
  }
  // Skip the projected split-point — including it caused an L-shape whenever
  // the driver pin sat laterally off the route line (GPS drift, road
  // shoulder). Going driver → next-waypoint draws a single smooth diagonal
  // instead of a 90° elbow back to the road.
  const path = [dp]
  for (let i = bestIdx + 1; i < points.length; i++) {
    path.push({ lat: points[i].latitude, lng: points[i].longitude })
  }
  // Append the leg's terminal coord so the polyline ends exactly at the
  // pickup/dropoff marker (Google snaps route waypoints to roads, which can
  // leave a small gap to the marker pin).
  const pickedUp = /^(at shipper|loading|in transit|at receiver|unloading)$/i.test(loadStatus.value)
  const terminal = pickedUp ? destLatLng.value : originLatLng.value
  if (terminal && hasCoords.value) path.push(terminal)
  return path
}

function renderMarkers() {
  if (!map) return
  clearMapObjects()

  // Alternatives first so they render BELOW the active route.
  altPolylines = renderAlternatives(map, props.selectedAltIdx)

  const pickedUp = /^(at shipper|loading|in transit|at receiver|unloading)$/i.test(loadStatus.value)
  // After pickup, hide origin marker — driver is now Point A
  if (originLatLng.value && hasCoords.value && !pickedUp) {
    originMarker = new google.maps.marker.AdvancedMarkerElement({ position: originLatLng.value, map, content: createDotPin('#16a34a', 14), title: 'Pickup' })
  }
  if (destLatLng.value && hasCoords.value) {
    destMarker = new google.maps.marker.AdvancedMarkerElement({ position: destLatLng.value, map, content: createDotPin('#dc2626', 14), title: 'Drop-off' })
  }
  if (driverLatLng.value) {
    const content = createDotPin('#2563eb', 16)
    // Snap the initial marker position onto the route polyline (if close)
    // so the pin sits ON the dashed line from first render.
    const snapped = snapToRoute(driverLatLng.value.lat, driverLatLng.value.lng)
    driverMarker = new google.maps.marker.AdvancedMarkerElement({
      position: snapped,
      map,
      content,
      title: props.publicMode ? 'Driver' : (driverName.value || 'Driver'),
      gmpClickable: true,
    })
    // Click the pin → snap to max zoom centered on the truck. Attach to both
    // the marker (gmp-click) and the underlying DOM element (click) — the
    // marker-level event needs gmpClickable, and the DOM-level event fires
    // even when the polyline above intercepts the marker event.
    const zoomToDriver = () => {
      if (!map) return
      const pos = driverMarker.position
      if (!pos) return
      const lat = typeof pos.lat === 'function' ? pos.lat() : pos.lat
      const lng = typeof pos.lng === 'function' ? pos.lng() : pos.lng
      if (!isFinite(lat) || !isFinite(lng)) return
      map.setCenter({ lat, lng })
      map.setZoom(20)
    }
    driverMarker.addEventListener('gmp-click', zoomToDriver)
    content.addEventListener('click', (e) => { e.stopPropagation(); zoomToDriver() })
  }

  const path = buildRoutePath()
  if (path && path.length >= 2) {
    routeLine = new google.maps.Polyline({
      path,
      strokeColor: '#ffffff', strokeOpacity: 0.9, strokeWeight: 5,
      map,
      clickable: false,
      icons: [{ icon: { path: 'M 0,-1 0,1', strokeColor: '#2563eb', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '20px' }],
    })
    routeAnim = animatePolyline(routeLine)
  }

  // Traffic overlays render LAST so SLOW/JAM colors sit on top of the white
  // base + dashes. NORMAL segments are skipped, so the dashed flow still
  // shows where the road is clear.
  trafficOverlays = renderTrafficOverlays(map, activeRoute.value)

  fitBounds()
}

function fitBounds() {
  if (!map) return
  // Once the truck is rolling (post-pickup) and we have a live GPS fix,
  // focus the map on the driver pin at a close zoom so customers and
  // dispatchers immediately see what the truck is doing instead of an
  // origin→destination wide view where the truck is a dot in the middle.
  const pickedUp = /^(at shipper|loading|in transit|at receiver|unloading)$/i.test(loadStatus.value)
  if (pickedUp && driverLatLng.value) {
    map.setCenter(driverLatLng.value)
    map.setZoom(15)
    return
  }
  const bounds = new google.maps.LatLngBounds()
  let count = 0
  if (originLatLng.value) { bounds.extend(originLatLng.value); count++ }
  if (destLatLng.value) { bounds.extend(destLatLng.value); count++ }
  if (driverLatLng.value) { bounds.extend(driverLatLng.value); count++ }
  if (count >= 2) map.fitBounds(bounds, 50)
  else if (count === 1) { map.setCenter(bounds.getCenter()); map.setZoom(12) }
}

let initialFitDone = false

// Monotonic guard against out-of-order responses. Several fetchRoute() calls can
// be in flight at once — on the dispatcher dashboard an initial origin→drop-off
// fetch fires before the ELD position loads, then a driver→drop-off fetch fires
// once it arrives. The full-haul response is larger and can land LAST, clobbering
// the correct current-leg distance/ETA with the whole planned haul. We apply only
// the latest invocation's result so the ETA stays on the live leg.
let fetchSeq = 0

// Cheap identity for a preset route, so a 30s payload poll that returns the
// same geometry does not tear down and rebuild every overlay (which resets the
// dash animation and re-fits the bounds, yanking the map out from under a
// customer who just panned it).
function presetSignature(p) {
  const pts = p && Array.isArray(p.route) ? p.route : []
  const head = pts.length ? `${pts[0].latitude},${pts[0].longitude}` : ''
  const tail = pts.length ? `${pts[pts.length - 1].latitude},${pts[pts.length - 1].longitude}` : ''
  return `${pts.length}|${head}|${tail}|${p?.distanceMiles ?? ''}|${p?.etaMinutes ?? ''}`
}
let lastPresetSig = null

// publicMode route source. The customer tracker is anonymous and
// GET /api/route is requireRole("Super Admin","Dispatcher","Driver"), so every
// fetch from this page answered 401 — swallowed by the catch in fetchRoute(),
// leaving markers with no polyline, no distance and no ETA. The server now
// resolves this load's own pickup→drop-off route and ships it on the
// /api/public/track/:loadId payload; we render that instead.
//
// ⚠️ Never re-add an /api/route call on this path. That endpoint accepts
// arbitrary caller coordinates and is a free Google Routes oracle, which is
// precisely why it is role-gated.
function applyPresetRoute(force = false) {
  const preset = props.presetRoute
  const sig = presetSignature(preset)
  if (!force && sig === lastPresetSig) return
  lastPresetSig = sig
  const pts = preset && Array.isArray(preset.route) ? preset.route : []
  allRoutes.value = []
  recommendedIdx.value = 0
  routePoints.value = pts.length >= 2 ? pts : []
  // The public payload carries no steps, by design. The header therefore falls
  // back to these whole-haul figures — the customer tracker never matches a
  // position to the route (see the driverPosition watcher), so there is nothing
  // to count down against and nothing to invent.
  routeSteps.value = []
  routeDistanceMiles.value = preset?.distanceMiles ?? null
  routeEtaMinutes.value = preset?.etaMinutes ?? null
  if (map) renderMarkers()
}

// Called whenever routePoints is replaced. Keeps three things that must never
// disagree in lockstep: the match offset (measured against the old polyline),
// the deviation counter (the driver is on the new route by definition), and the
// route version Drive Mode's voice ladder keys on.
//
// ⚠️ The reroute BUDGET is deliberately not cleared here. A reroute installs new
// geometry, so clearing the budget on geometry change would make the per-trip
// cap self-resetting — i.e. no cap at all. It resets when the leg does (see the
// loadStatus watcher).
function onRouteGeometryChanged() {
  matchOffset.value = null
  lastMatchAt = 0
  deviation.reset()
  offRoute.value = false
  routeVersion.value++
}

async function fetchRoute(doFit = false) {
  const mySeq = ++fetchSeq
  routePoints.value = []
  routeSteps.value = []
  routeDistanceMiles.value = null
  routeEtaMinutes.value = null
  if (!destLatLng.value) return

  // Force: the three refs above were just cleared, so the signature guard must
  // not short-circuit the re-apply.
  if (props.publicMode) { applyPresetRoute(true); return }

  // Pick the right leg to render:
  //   - Has ELD + picked up:     truck→drop-off (current trajectory)
  //   - Has ELD + not picked up: truck→pickup (current trajectory)
  //   - No ELD pin:              origin→drop-off (planned full haul)
  // The original logic fell back to `origin → origin` when ELD was offline
  // and the load was pre-pickup, which produced no usable route — drivers
  // saw markers but no polyline and the smart guidance UI never populated.
  const pickedUp = /^(at shipper|loading|in transit|at receiver|unloading)$/i.test(loadStatus.value)
  const fromDriver = !!driverLatLng.value
  let from, to
  if (fromDriver) {
    from = driverLatLng.value
    to = pickedUp ? destLatLng.value : (originLatLng.value || destLatLng.value)
  } else {
    from = originLatLng.value
    to = destLatLng.value
  }
  if (!from || !to) return
  // Answers "has this leg been routed from the truck's own position yet?", which
  // is the only question the removed 60 s / 0.06 mi gate's `lastRoutePos` was
  // still being asked — it stored a coordinate purely so that gate had something
  // to measure distance travelled against, and nothing measures that any more.
  // Set here rather than at the watcher's call site so the mount-time fetch
  // counts too (that used to fire a duplicate on the first ELD fix), and set
  // ONLY on the driver-origin branch so a truck whose ELD comes online after
  // mount still upgrades its planned origin→destination haul to a live one.
  if (fromDriver) routedFromDriverPosition = true

  try {
    const url = (f, t) => `/api/route?fromLat=${f.lat}&fromLng=${f.lng}&toLat=${t.lat}&toLng=${t.lng}&alternatives=true`
    let data
    try {
      data = await api.get(url(from, to))
    } catch { /* silent */ }
    if ((!data || !data.routes || data.routes.length === 0) && originLatLng.value && from !== originLatLng.value) {
      try {
        data = await api.get(url(originLatLng.value, destLatLng.value))
      } catch { /* silent */ }
    }
    if (!data || !data.routes || data.routes.length === 0) return
    if (mySeq !== fetchSeq) return // a newer fetchRoute() superseded this — drop the stale (e.g. full-haul) response

    allRoutes.value = data.routes
    recommendedIdx.value = typeof data.recommendedIdx === 'number' ? data.recommendedIdx : 0

    // Clamp the parent-owned selectedAltIdx if the new alternatives list is
    // shorter than the previous one, then default to the recommended choice
    // if the previous selection was the default (0) — drivers expect the
    // best route to surface after every refetch.
    let idx = props.selectedAltIdx
    if (idx >= allRoutes.value.length) idx = 0
    if (idx === 0 && recommendedIdx.value !== 0) {
      idx = recommendedIdx.value
      emit('update:selectedAltIdx', idx)
    }

    const active = allRoutes.value[idx] || allRoutes.value[0]
    if (active && active.route && active.route.length >= 2) routePoints.value = active.route
    routeSteps.value = Array.isArray(active?.steps) ? active.steps : []
    routeDistanceMiles.value = active?.distanceMiles ?? null
    routeEtaMinutes.value = active?.etaMinutes ?? null

    // New geometry installed: the old along-route offset is meaningless against
    // it, the driver is on-route by construction, and Drive Mode's voice ladder
    // must re-arm for the new turns.
    onRouteGeometryChanged()

    emit('route-data', {
      routes: allRoutes.value,
      recommendedIdx: recommendedIdx.value,
      navigationDestination: navigationDestination.value,
    })

    // Full re-render needed: the active route's polyline path changed AND
    // the alternative overlays + traffic segments need to be redrawn. The
    // animation reset is acceptable here because new geometry is rare: once at
    // the start of a leg, once per status change, once per confirmed deviation
    // (capped per trip), or a manual alternative pick. It is emphatically NOT
    // once per GPS fix — the header's distance + ETA count down off the matched
    // offset instead, with no refetch. See remainingDistanceMiles below.
    renderMarkers()
  } catch { /* silent */ }
}

// Set by fetchRoute() when it routes from the driver pin; cleared when the leg
// changes. Replaces `lastRoutePos` (a coordinate nothing measured any more) and
// `lastRouteTime` (write-only since the 60 s gate was removed — assigned in three
// places and read in none).
let routedFromDriverPosition = false

// ── Recovery when we hold NO route at all ────────────────────────────────────
//
// ⚠️ THIS IS NOT A REROUTE AND NOT A POLL. It restores self-healing that this
// batch removed by accident: the old 60 s gate re-fired regardless of whether the
// previous attempt had succeeded, so a request that 500'd, 401'd or came back
// with zero routes healed within a minute. Deviation gating never retries — to
// the detector a truck sitting perfectly on a route it never received looks
// exactly like a truck that is on route — so one failed fetch left the driver
// with markers, no polyline and an empty header for the rest of the leg.
//
// "We never got a route" and "the truck has left the route" are different
// conditions and are answered in different places: this one keys on the ABSENCE
// of geometry, the other on measured deviation, and neither path can trigger the
// other.
//
// Capped hard, and biased low on purpose. A stale map until the next status
// change costs one leg's convenience; an uncapped retry is a billed route call
// per ELD fix for as long as an outage lasts, which is precisely the spend the
// deviation gating was built to eliminate. Worst case per leg is 3 attempts here
// plus the one direct fetch a mount or a status change fires — and note a failed
// attempt costs TWO calls, because fetchRoute falls back to the origin→drop-off
// form when the truck-origin form comes back empty.
const MAX_LEG_ROUTE_ATTEMPTS = 3
// Paced in FIXES, not milliseconds, so no clock re-enters this file. Attempt 1 is
// immediate; the gaps then give a transient failure roughly 30 s and 90 s of ELD
// cadence to clear before we stop asking.
const ROUTE_ATTEMPT_BACKOFF_FIXES = [0, 1, 3]
let legRouteAttempts = 0
let fixesSinceRouteAttempt = 0

function resetLegRouteAttempts() {
  legRouteAttempts = 0
  fixesSinceRouteAttempt = 0
}

let prevDriverPos = null
// Tracks when the previous driverPosition update arrived so the next tween
// can stretch over the actual inter-update gap. Without this, the tween
// finishes in 1 s and the pin sits still for the rest of the polling window
// (typically 15–60 s), producing the "jumpy" motion the user reported.
let lastPosUpdateAt = 0
const POS_TWEEN_MIN_MS = 1000
const POS_TWEEN_MAX_MS = 60000

// Snap a raw GPS coord onto the route polyline if close enough. Returns the
// projected lat/lng when the truck is within SNAP_RADIUS_M of the line;
// otherwise returns the raw coord so genuinely off-route trucks still show
// their real position. Eliminates the visual gap caused by GPS landing on a
// parallel road (tollway vs frontage) when the route uses the other one.
//
// (The paragraph that used to sit here describing animateDriverMarker's tween
// has been moved down to that function, where it belongs — it had drifted above
// this one and read as if it described the snapping.)
//
// ⚠️ THE OLD THRESHOLD WAS ANISOTROPIC AND THAT WAS A REAL BUG. This function
// compared `(projX - px)² + (projY - py)²` in RAW DEGREES against 5.2e-7, then
// described it in the comment as "~80 m". A degree of latitude and a degree of
// longitude are not the same distance anywhere but the equator: at 40°N the
// same constant is ~80 m north-south and ~104 m east-west, and the gap widens
// with latitude. So a truck on a frontage road was snapped onto the tollway in
// one direction of travel and not the other. `nearestPointOnPath` projects into
// local metres with cos(lat) scaling, so one threshold now means one distance.
const SNAP_RADIUS_M = 80

const routeIndex = computed(() => {
  const pts = routePoints.value
  if (!Array.isArray(pts) || pts.length < 2) return null
  return buildRouteIndex(pts)
})

// ── LIVE REMAINING DISTANCE + ETA ────────────────────────────────────────────
//
// Both header figures are REMAINING figures, and they only ever counted down as
// a SIDE EFFECT: fetchRoute() re-ran on the old `moved 0.06 mi AND 60 s elapsed`
// gate with the truck's live position as the origin, so every response was a
// fresh truck→destination route and both numbers shrank with it. Deviation-
// triggered rerouting removed that refetch — correctly; it was ~600 billed Google
// Routes calls per driver per day, and it fired for the driver who was ON the
// route while ignoring the one who was not — but it was also the only thing
// moving these two numbers. A driver who follows the route perfectly fetched once
// at leg start and never again, so the header froze: nine hours into a ten-hour
// leg it read "347 mi · 5h 30m ETA" beside a live "40 mi to Drop-off".
//
// They are now derived from the matched along-route offset — the same scalar
// DriveModeOverlay's footer runs on (utils/routeProgress.js). That is a genuine
// per-fix countdown at ZERO network cost, i.e. strictly better than the 60 s gate
// managed, since that only refreshed twice a minute and billed for each one.
//
// The offset is null until the first fix is matched (and forever on the public
// tracker, which never matches — see the driverPosition watcher), which is why
// every fallback below is the whole-route figure rather than a guess.

// Start offset of each step, so remaining TIME can be pro-rated inside the
// current step instead of stepping down a whole instruction at a time. Rebuilt
// only when the geometry changes, and the server sends `steps[].startIdx`, so
// buildStepOffsets takes its O(1) source and never re-matches per step.
const stepOffsets = computed(() => {
  const idx = routeIndex.value
  if (!idx || !routeSteps.value.length) return []
  return buildStepOffsets(routeSteps.value, idx)
})

const currentStepIdx = computed(() => {
  if (!routeSteps.value.length || stepOffsets.value.length < 2) return 0
  if (!Number.isFinite(matchOffset.value)) return 0
  return stepIndexForOffset(stepOffsets.value, matchOffset.value, routeSteps.value.length)
})

// Fraction of the route still to drive, by distance.
const remainingDistanceFraction = computed(() => {
  const idx = routeIndex.value
  if (!idx || !(idx.totalMeters > 0) || !Number.isFinite(matchOffset.value)) return null
  const rem = routeRemainingMeters(idx, matchOffset.value)
  if (!Number.isFinite(rem)) return null
  return Math.min(1, Math.max(0, rem / idx.totalMeters))
})

// ⚠️ TWO TIME BASES, AND SUMMING THE WRONG ONE SILENTLY DELETES THE TRAFFIC.
// The route-level etaMinutes is Google's `duration` under TRAFFIC_AWARE_OPTIMAL —
// it carries the congestion delay. Per-step `durationSec` is `staticDuration`,
// which does not. So the steps are never summed into an absolute ETA; they are
// used ONLY to decide what fraction of the drive is left, and that fraction
// scales the traffic-aware total. Falls back to the distance fraction for a route
// with no steps (the lean and preset payloads both omit them).
//
// Why not distance alone, which would be simpler: the last 3 miles into a
// receiver can be 12 minutes of surface streets on a 20-mile leg. Scaling by
// distance there shows 2 minutes, at the moment the number matters most.
const remainingTimeFraction = computed(() => {
  const steps = routeSteps.value
  const offsets = stepOffsets.value
  if (!steps.length || offsets.length < 2 || !Number.isFinite(matchOffset.value)) {
    return remainingDistanceFraction.value
  }
  let totalSec = 0
  for (const s of steps) totalSec += s.durationSec || 0
  if (!(totalSec > 0)) return remainingDistanceFraction.value
  const rem = routeRemainingSeconds(steps, offsets, currentStepIdx.value, matchOffset.value)
  if (!Number.isFinite(rem)) return remainingDistanceFraction.value
  return Math.min(1, Math.max(0, rem / totalSec))
})

// Scaled off the server's own mileage rather than rendering the index's
// cumulative metres directly: the polyline is downsampled, so its length runs a
// little short of the real road distance, and showing it raw would step the
// figure sideways (347 → 345.2) the instant the first match landed. Rounded to
// one decimal, which is the precision the server sends.
const remainingDistanceMiles = computed(() => {
  const base = routeDistanceMiles.value
  if (base == null) return null
  const f = remainingDistanceFraction.value
  if (f == null) return base
  return Math.round(base * f * 10) / 10
})

const remainingEtaMinutes = computed(() => {
  const base = routeEtaMinutes.value
  if (base == null) return null
  const f = remainingTimeFraction.value
  if (f == null) return base
  return base * f
})

const etaFormatted = computed(() => {
  if (remainingEtaMinutes.value == null) return null
  const m = Math.round(remainingEtaMinutes.value)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
})

function snapToRoute(lat, lng) {
  const idx = routeIndex.value
  if (!idx) return { lat, lng }
  const hit = nearestPointOnPath(idx, { lat, lng })
  if (!hit || hit.distanceMeters > SNAP_RADIUS_M) return { lat, lng }
  return { lat: hit.lat, lng: hit.lng }
}

// Smooth marker tween via requestAnimationFrame. The pin slides across a
// *static* map; the polyline first-point follows the pin frame-by-frame so the
// route stays glued to it without a visible gap during the tween. We do NOT
// call mapObj.panTo() — running it in parallel with the per-frame setPath
// causes the polyline to visually disappear (Google batches overlay rendering
// during camera animations). mapObj kept in the signature for call-site
// compatibility; pin-click still re-centers.
function animateDriverMarker(marker, mapObj, lineObj, from, to, duration = 1000) {
  if (!marker || !from || !to) return
  // No-op when the polled position matches what we last drew (within ~1 m).
  // Polling every 30 s frequently returns the server's 30 s-cached payload.
  const dLat = (to.lat - from.lat)
  const dLng = (to.lng - from.lng)
  if ((dLat * dLat + dLng * dLng) < 1e-10) return
  // Snap the target onto the route polyline so the pin sits on the line.
  const snapped = snapToRoute(to.lat, to.lng)
  to = { lat: snapped.lat, lng: snapped.lng }
  void mapObj
  // Long tweens (matching the polling cadence) use linear so the pin moves
  // at a steady-state pace instead of decelerating halfway through, which
  // reads as the truck braking when it isn't.
  const useLinear = duration > 3000
  const start = performance.now()
  function step(now) {
    const t = Math.min((now - start) / duration, 1)
    const ease = useLinear ? t : t * (2 - t)
    const lat = from.lat + (to.lat - from.lat) * ease
    const lng = from.lng + (to.lng - from.lng) * ease
    marker.position = { lat, lng }
    if (lineObj) {
      const path = buildRoutePath({ lat, lng })
      if (path && path.length >= 2) lineObj.setPath(path)
    }
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

watch(() => props.driverPosition, (pos) => {
  if (!pos || !destLatLng.value) return
  const to = { lat: pos.latitude, lng: pos.longitude }
  const from = prevDriverPos || to
  // Stretch the tween over the actual inter-update gap so the marker is
  // moving continuously. First update for the session falls back to 1 s.
  const nowMs = Date.now()
  const tweenMs = lastPosUpdateAt
    ? Math.min(Math.max(nowMs - lastPosUpdateAt, POS_TWEEN_MIN_MS), POS_TWEEN_MAX_MS)
    : POS_TWEEN_MIN_MS
  lastPosUpdateAt = nowMs
  if (driverMarker && map) animateDriverMarker(driverMarker, map, routeLine, from, to, tweenMs)
  prevDriverPos = to

  // ⚠️ publicMode fetches NOTHING, ever. GET /api/route accepts arbitrary caller
  // coordinates, which makes it a free Google Routes oracle — that is exactly
  // why it is role-gated, and why the customer tracker is served a pre-computed
  // `presetRoute` instead. Never let a deviation, a status change or a reroute
  // reach fetchRoute() on this path.
  if (props.publicMode) return

  // Two reasons to go and get geometry, and only one of them is a retry:
  //
  //   (a) this leg has never been routed from the truck's own pin. Fires at most
  //       once per leg (fetchRoute sets the flag the moment it commits) and is
  //       what upgrades a no-ELD truck's planned origin→drop-off haul to a live
  //       one the moment its ELD starts reporting;
  //   (b) we hold no geometry at all, i.e. the attempt above failed. See
  //       MAX_LEG_ROUTE_ATTEMPTS for why this exists and why it is capped.
  //
  // Both return early: with no route there is nothing to match a fix against,
  // and in case (a) the geometry is about to be replaced anyway. So the deviation
  // detector is never fed a match taken from a route we are in the middle of
  // discarding, and this path can never stand in for it.
  if (!routedFromDriverPosition || !routeIndex.value) {
    fixesSinceRouteAttempt++
    const waitFixes = ROUTE_ATTEMPT_BACKOFF_FIXES[legRouteAttempts] ?? 0
    if (legRouteAttempts < MAX_LEG_ROUTE_ATTEMPTS && fixesSinceRouteAttempt > waitFixes) {
      legRouteAttempts++
      fixesSinceRouteAttempt = 0
      fetchRoute(true)
    }
    return
  }

  const idx = routeIndex.value
  const match = matchToRoute(idx, to, {
    previousOffsetMeters: matchOffset.value,
    elapsedMs: lastMatchAt ? nowMs - lastMatchAt : null,
  })
  lastMatchAt = nowMs
  if (!match) return
  // Feeds two things: the next match's forward bias, and the header's live
  // remaining distance + ETA. This assignment is what replaced the refetch.
  matchOffset.value = match.offsetMeters

  const verdict = deviation.update({
    point: to,
    distanceFromRouteMeters: match.distanceMeters,
    timestamp: nowMs,
  })
  offRoute.value = verdict.offRoute
  if (!verdict.shouldReroute) return

  rerouting.value = true
  Promise.resolve(fetchRoute()).finally(() => { rerouting.value = false })
}, { deep: true })

// Re-fetch route when load status changes (e.g., geofence triggers "At Shipper" → driver becomes Point A)
watch(loadStatus, (newStatus, oldStatus) => {
  if (newStatus !== oldStatus && map && destLatLng.value) {
    // New leg: whatever is installed was routed for the old one. fetchRoute()
    // below sets this straight back to true when a live position exists, so the
    // next fix does not fire a second call for the same leg — and the recovery
    // budget resets with the leg, so a leg that failed to route cannot borrow
    // the next one's attempts (nor spend them before it has needed any).
    routedFromDriverPosition = false
    resetLegRouteAttempts()
    // A status change means a new LEG (truck→pickup becomes truck→drop-off), so
    // this is the one place the per-trip reroute budget legitimately resets.
    deviation.reset({ clearBudget: true })
    fetchRoute(true)
  }
})

// The public payload is re-fetched every 30s and re-assigned wholesale, so the
// preset arrives as a fresh object each poll — and it can land after the map
// has already mounted. applyPresetRoute() compares geometry, not identity, so
// an unchanged lane is a no-op.
// Non-deep on purpose: the parent rebuilds the object every poll so the
// reference always changes, and a deep traversal of a 1,500-point polyline
// every 30s would buy nothing.
watch(() => props.presetRoute, () => {
  if (props.publicMode) applyPresetRoute()
})

// Driver swapped to a different alternative (or recommended changed). Re-sync
// the active polyline + info strip + traffic overlay against the new pick
// WITHOUT hitting the network — the alternatives payload already has every
// route's geometry. fetchRoute() is only called when something physical
// changes (truck moved, status flipped).
watch(() => props.selectedAltIdx, (idx) => {
  const active = allRoutes.value[idx]
  if (!active || !active.route) return
  routePoints.value = active.route
  routeSteps.value = Array.isArray(active.steps) ? active.steps : []
  routeDistanceMiles.value = active.distanceMiles ?? null
  routeEtaMinutes.value = active.etaMinutes ?? null
  onRouteGeometryChanged()
  if (map) renderMarkers()
})

// ⚠️ THIS TAP IS THE ONLY USER GESTURE DRIVE MODE GETS, AND TWO BROWSER APIS
// REQUIRE ONE. Both calls must happen synchronously inside the click handler:
//
//   1. speechSynthesis. iOS Safari (and therefore every browser on iPhone)
//      accepts `speak()` from a timer but silently never plays it, until one
//      utterance has been started from inside a real gesture. No error, no
//      rejection — just permanent silence. Unlock here or voice guidance does
//      not exist on iPhone, which is most of the fleet.
//   2. geolocation. Phone GPS is the only source fresh enough to steer by (ELD
//      fixes are ~30 s apart), and prompting from a gesture is what makes the
//      permission dialog appear reliably rather than being auto-dismissed.
//
// ⚠️ The phone fix is for the NAVIGATION DISPLAY ONLY. It is never POSTed —
// `POST /api/location` is a 410 Gone stub and ELD stays the sole source for
// tracking, driver pay and geofencing. See useDriverPosition.js.
function openNavMode() {
  voice.unlock()
  // ⚠️ ONLY on the driver's own map. This component is also rendered by
  // JobBoardTab / ActiveLoadsTab / CompletedLoadsTab with `dispatch-mode`, where
  // the Navigate button is visible but the person tapping it is a dispatcher at
  // a desk, not the driver in the truck. Prompting them for location would ask
  // the wrong human for the wrong thing and put a desk in Houston on the map as
  // if it were the truck. Dispatch keeps the ELD feed it already has.
  if (!props.dispatchMode) driverPos.startPhoneGps()
  expanded.value = true
}

// Drive Mode owns its own map instance, route polyline, traffic overlays, and
// fullscreen lifecycle (see DriveModeOverlay.vue). closeNavMode just toggles
// the prop — DriveModeOverlay's watch(open) tears down its map and exits the
// browser fullscreen.
//
// Phone GPS is deliberately LEFT RUNNING: the inline route map, the ETA strip
// and the fuel panel all read the same position, and a driver who steps out of
// Drive Mode for ten seconds to check a document should not drop back to a 30 s
// ELD fix. DriverView stops the watcher when the driver app unmounts.
function closeNavMode() {
  expanded.value = false
}

function focusOn(lat, lng) { if (map) { map.panTo({ lat, lng }); map.setZoom(15) } }
defineExpose({ focusOn })

async function initMap() {
  if (!mapContainer.value) return
  // google.maps.* constants are referenced in the options below, so ensure
  // the API is loaded before constructing them — otherwise we get a
  // ReferenceError("google is not defined") and the map never renders.
  await loadGoogleMaps()
  const center = originLatLng.value && destLatLng.value
    ? { lat: (originLatLng.value.lat + destLatLng.value.lat) / 2, lng: (originLatLng.value.lng + destLatLng.value.lng) / 2 }
    : originLatLng.value || destLatLng.value || driverLatLng.value || { lat: 0, lng: 0 }

  map = await createMap(mapContainer.value, {
    zoom: 5,
    center,
    mapTypeId: 'hybrid',
    mapTypeControl: true,
    mapTypeControlOptions: {
      style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
      position: google.maps.ControlPosition.TOP_LEFT,
      mapTypeIds: ['roadmap', 'hybrid'],
    },
  })
  renderMarkers()
  // Fetch the route as soon as we have a destination — drivers without an
  // ELD link still need to see the planned haul, alternatives, and turn-by-
  // turn directions. The old gate required a driver position, which silently
  // hid the entire smart guidance UI for any truck that wasn't broadcasting.
  if (hasCoords.value) fetchRoute(true)
}

watch(() => [hasCoords.value, driverLatLng.value], () => {
  nextTick(() => { if (mapContainer.value && !map) initMap() })
})

onMounted(() => {
  // Init the map as soon as we have anything worth showing: a route (origin
  // → destination), or a driver pin, or both. Previously the gate required a
  // driver position (or dispatch mode), so trucks without an ELD never
  // rendered the route — the driver was stuck on "Locating your position…"
  // even though the route coordinates were available.
  if (hasCoords.value || driverLatLng.value) {
    nextTick(() => initMap())
  }
})
</script>

<style scoped>
.route-map-wrap { width: 100%; }
.map-container { height: 250px; border-radius: 8px; overflow: hidden; }
.map-info { display: flex; gap: 0.75rem; margin-bottom: 0.5rem; }
.info-item { font-size: 0.82rem; font-weight: 600; color: var(--text); background: var(--bg); padding: 0.25rem 0.6rem; border-radius: 6px; }
.info-warn { color: #b45309; background: #fef3c7; }
.info-danger { color: #dc2626; background: #fee2e2; }
.map-empty { text-align: center; color: var(--text-dim); font-size: 0.8rem; padding: 1rem 0; }
.map-label { font-size: 0.78rem; font-weight: 600; color: var(--text-dim); margin-bottom: 0.4rem; }
.map-eld-hint { font-size: 0.75rem; color: var(--text-dim); margin-bottom: 0.4rem; padding: 0.3rem 0.5rem; background: #fef3c7; color: #92400e; border-radius: 6px; font-weight: 500; }
.gps-waiting { display: flex; align-items: center; justify-content: center; background: var(--bg, #f5f6fa); border: 1px solid var(--border, #e5e7eb); }
.gps-overlay { display: flex; flex-direction: column; align-items: center; gap: 0.6rem; color: var(--text-dim); font-size: 0.82rem; font-weight: 500; }
.gps-spinner { width: 28px; height: 28px; border: 3px solid var(--border, #e5e7eb); border-top-color: var(--accent, #6366f1); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.navmode-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.65rem;
  border-radius: 6px;
  border: none;
  background: #2563eb;
  color: #fff;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.navmode-btn:hover { background: #1d4ed8; }
.navmode-btn:active { background: #1e40af; }

</style>
