<template>
  <Teleport to="body">
    <div v-if="open" ref="overlayEl" class="drive-overlay">
      <!-- Top banner: current maneuver + street name + "Then" sub-pill -->
      <div class="drive-banner" v-if="currentStep">
        <div class="drive-banner-main">
          <span class="drive-banner-icon" v-html="iconFor(currentStep.maneuver)"></span>
          <div class="drive-banner-text">
            <div v-if="distanceToManeuver" class="drive-banner-distance">
              In {{ formatDistance(distanceToManeuver) }}
            </div>
            <div class="drive-banner-street">{{ currentStreetName }}</div>
          </div>
        </div>
        <div v-if="nextStep" class="drive-banner-then">
          <span class="drive-then-label">Then</span>
          <span class="drive-then-icon" v-html="iconFor(nextStep.maneuver)"></span>
        </div>
      </div>

      <!-- Map -->
      <div ref="mapEl" class="drive-map"></div>

      <!-- Top-right compass: tap to north-up briefly -->
      <button class="drive-compass" @click="recenterNorth" title="Recenter">
        <span class="drive-compass-needle" :style="{ transform: `rotate(${-mapHeading}deg)` }">▲</span>
      </button>

      <!-- Bottom-left speed pill -->
      <div class="drive-speed">
        <div class="drive-speed-val">{{ speedKmh != null ? speedKmh : '--' }}</div>
        <div class="drive-speed-unit">km/h</div>
      </div>

      <!-- Bottom footer: X + remaining time/distance/arrival -->
      <div class="drive-footer">
        <button class="drive-close" @click="$emit('close')" title="Exit Navigation Mode">✕</button>
        <div class="drive-progress">
          <div class="drive-progress-time">{{ formatRemainingTime(remainingSec) }}</div>
          <div class="drive-progress-meta">
            <span>{{ formatDistance(remainingMeters) }}</span>
            <span v-if="arrivalClock"> · {{ arrivalClock }}</span>
          </div>
        </div>
        <!-- Spacer matches the close button width to keep the time perfectly centered -->
        <div class="drive-footer-spacer"></div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { useGoogleMaps, createTruckArrow } from '../../composables/useGoogleMaps'

const props = defineProps({
  open: { type: Boolean, default: false },
  activeRoute: { type: Object, default: null },  // { route, distanceMiles, etaMinutes, steps, trafficSegments }
  driverPosition: { type: Object, default: null },
  destination: { type: Object, default: null },  // { lat, lng, address }
})

const emit = defineEmits(['close'])

const { load: loadGoogleMaps, createMap } = useGoogleMaps()

const overlayEl = ref(null)
const mapEl = ref(null)
const currentStepIdx = ref(0)
const mapHeading = ref(0)
const followMode = ref(true)  // false briefly when user taps compass; auto-resumes on next fix

let map = null
let routeLine = null
let driverMarker = null
let trafficOverlays = []
let lastHeading = 0  // remember last good heading so we can keep rotating when GPS heading goes null at a stop

// ─── Maneuver glyphs (mirrors RouteDirections.vue's ICONS map) ────────────────
const ICONS = {
  TURN_LEFT: '↰',
  TURN_RIGHT: '↱',
  TURN_SLIGHT_LEFT: '↖',
  TURN_SLIGHT_RIGHT: '↗',
  TURN_SHARP_LEFT: '⬅',
  TURN_SHARP_RIGHT: '➡',
  U_TURN_LEFT: '↶',
  U_TURN_RIGHT: '↷',
  STRAIGHT: '↑',
  RAMP_LEFT: '↰',
  RAMP_RIGHT: '↱',
  MERGE: '⇈',
  FORK_LEFT: '↖',
  FORK_RIGHT: '↗',
  FERRY: '⛴',
  ROUNDABOUT_LEFT: '↺',
  ROUNDABOUT_RIGHT: '↻',
  DEPART: '↑',
  NAME_CHANGE: '↑',
  DESTINATION: '📍',
}
function iconFor(maneuver) {
  return ICONS[maneuver] || '↑'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function haversineMeters(a, b) {
  if (!a || !b) return Infinity
  const R = 6371000
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const aa = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa))
}
function stripHtml(s) {
  return (s || '').replace(/<[^>]*>/g, '').trim()
}
function extractStreetName(instruction) {
  const clean = stripHtml(instruction)
  // "Turn right onto Mabini St" → "Mabini St"
  // "Continue on Agusan-Misamis Oriental Rd" → "Agusan-Misamis Oriental Rd"
  const onto = clean.match(/\bonto\s+(.+?)(?:\s+toward\b|\s+for\b|$)/i)
  if (onto) return onto[1].trim()
  const on = clean.match(/\bon\s+(.+?)(?:\s+toward\b|\s+for\b|$)/i)
  if (on) return on[1].trim()
  return clean
}
function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '—'
  if (meters >= 1000) return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} km`
  return `${Math.round(meters / 10) * 10} m`
}
function formatRemainingTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// ─── Driver position & route data computeds ───────────────────────────────────
const driverLatLng = computed(() => {
  if (!props.driverPosition) return null
  const lat = props.driverPosition.latitude
  const lng = props.driverPosition.longitude
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { lat, lng }
})
const steps = computed(() => props.activeRoute?.steps || [])
const currentStep = computed(() => steps.value[currentStepIdx.value] || null)
const nextStep = computed(() => steps.value[currentStepIdx.value + 1] || null)
const currentStreetName = computed(() => {
  if (!currentStep.value) return ''
  return extractStreetName(currentStep.value.instruction)
})

// Distance from driver to the end of the current step (i.e. the next maneuver).
// When the driver is heading toward a turn, this drives the "In 200m turn right"
// label in the banner. Falls back to the step's full distanceMeters if we don't
// have a fresh GPS fix yet.
const distanceToManeuver = computed(() => {
  if (!currentStep.value) return null
  if (!driverLatLng.value || !currentStep.value.polyline?.length) return currentStep.value.distanceMeters
  const last = currentStep.value.polyline[currentStep.value.polyline.length - 1]
  return haversineMeters(driverLatLng.value, { lat: last.latitude, lng: last.longitude })
})

const remainingMeters = computed(() => {
  if (!steps.value.length) return null
  let total = 0
  for (let i = currentStepIdx.value; i < steps.value.length; i++) {
    total += steps.value[i].distanceMeters || 0
  }
  // Subtract the part of the current step that's already behind the driver,
  // so the bar isn't stuck at the full step distance for the whole leg.
  if (driverLatLng.value && currentStep.value?.polyline?.length) {
    const last = currentStep.value.polyline[currentStep.value.polyline.length - 1]
    const remainOfCurrent = haversineMeters(driverLatLng.value, { lat: last.latitude, lng: last.longitude })
    const stepTotal = currentStep.value.distanceMeters || 0
    if (remainOfCurrent < stepTotal) {
      total -= (stepTotal - remainOfCurrent)
    }
  }
  return Math.max(0, total)
})
const remainingSec = computed(() => {
  if (!steps.value.length) return null
  let total = 0
  for (let i = currentStepIdx.value; i < steps.value.length; i++) {
    total += steps.value[i].durationSec || 0
  }
  return total
})
const arrivalClock = computed(() => {
  if (!Number.isFinite(remainingSec.value)) return null
  const d = new Date(Date.now() + remainingSec.value * 1000)
  let h = d.getHours()
  const m = d.getMinutes()
  const ampm = h >= 12 ? 'pm' : 'am'
  h = h % 12 || 12
  return `${h}:${m.toString().padStart(2, '0')} ${ampm}`
})
const speedKmh = computed(() => {
  const s = props.driverPosition?.speed
  if (!Number.isFinite(s) || s < 0.5) return null  // <0.5 m/s ~ stationary, show "--"
  return Math.round(s * 3.6)
})

// ─── Step advancement ─────────────────────────────────────────────────────────
function advanceStepIfNeeded() {
  if (!driverLatLng.value || !steps.value.length) return
  if (currentStepIdx.value >= steps.value.length - 1) return
  const cur = steps.value[currentStepIdx.value]
  if (!cur?.polyline?.length) return
  const endPt = cur.polyline[cur.polyline.length - 1]
  const dist = haversineMeters(driverLatLng.value, { lat: endPt.latitude, lng: endPt.longitude })
  if (dist < 25) currentStepIdx.value++
}

// ─── Map lifecycle ────────────────────────────────────────────────────────────
async function initMap() {
  if (!mapEl.value) return
  await loadGoogleMaps()
  const center = driverLatLng.value
    || (props.activeRoute?.route?.length
      ? { lat: props.activeRoute.route[0].latitude, lng: props.activeRoute.route[0].longitude }
      : { lat: 0, lng: 0 })
  // Vector renderer (enabled by mapId in useGoogleMaps.createMap) gives us
  // tilt + heading. Roadmap mapTypeId keeps labels readable in 3D; hybrid
  // gets visually busy at this tilt.
  map = await createMap(mapEl.value, {
    zoom: 18,
    center,
    mapTypeId: 'roadmap',
    tilt: 60,
    heading: 0,
    disableDefaultUI: true,
    // Override the createMap default — Drive Mode auto-zooms with the camera,
    // so the +/- buttons just clutter the bottom-right of the screen.
    zoomControl: false,
    gestureHandling: 'greedy',
    keyboardShortcuts: false,
    clickableIcons: false,
  })
  drawRoute()
  drawDriverMarker()
  // Initial centering + heading; subsequent updates come from the watcher.
  syncCameraToDriver(true)
}

function drawRoute() {
  if (!map || !props.activeRoute?.route?.length) return
  if (routeLine) { routeLine.setMap(null); routeLine = null }
  for (const o of trafficOverlays) { o.setMap(null) }
  trafficOverlays = []

  const path = props.activeRoute.route.map(p => ({ lat: p.latitude, lng: p.longitude }))
  routeLine = new google.maps.Polyline({
    path,
    strokeColor: '#1d4ed8',
    strokeOpacity: 0.95,
    strokeWeight: 9,
    map,
    clickable: false,
    zIndex: 1,
  })

  // Traffic overlays on top of the base route — same green/amber/red bands
  // the server computed for the inline map.
  if (Array.isArray(props.activeRoute.trafficSegments)) {
    const COLORS = { SLOW: '#f59e0b', TRAFFIC_JAM: '#dc2626' }
    const pts = props.activeRoute.route
    for (const seg of props.activeRoute.trafficSegments) {
      const color = COLORS[seg.congestion]
      if (!color) continue
      const start = Math.max(0, seg.startIdx | 0)
      const end = Math.min(pts.length - 1, seg.endIdx | 0)
      if (end <= start) continue
      const segPath = []
      for (let i = start; i <= end; i++) segPath.push({ lat: pts[i].latitude, lng: pts[i].longitude })
      if (segPath.length < 2) continue
      const overlay = new google.maps.Polyline({
        path: segPath,
        strokeColor: color,
        strokeOpacity: 0.9,
        strokeWeight: 9,
        map,
        clickable: false,
        zIndex: 2,
      })
      trafficOverlays.push(overlay)
    }
  }
}

function drawDriverMarker() {
  if (!map || !driverLatLng.value) return
  if (driverMarker) { driverMarker.map = null; driverMarker = null }
  // The map itself is rotated to heading-up, so the arrow stays at heading=0
  // (pointing toward the top of the screen = direction of travel).
  const content = createTruckArrow({ color: '#2563eb', heading: 0, moving: true, size: 36 })
  driverMarker = new google.maps.marker.AdvancedMarkerElement({
    position: driverLatLng.value,
    map,
    content,
    zIndex: 999,
  })
}

function syncCameraToDriver(forceCenter = false) {
  if (!map || !driverLatLng.value) return
  // Center on driver unless the user briefly paused follow mode.
  if (followMode.value || forceCenter) {
    map.setCenter(driverLatLng.value)
    map.setZoom(18)
    map.setTilt(60)
    const h = props.driverPosition?.heading
    if (Number.isFinite(h)) {
      lastHeading = h
      map.setHeading(h)
      mapHeading.value = h
    } else {
      // Stationary or GPS heading not yet available — keep the last good one
      // so the camera doesn't randomly snap back to north.
      map.setHeading(lastHeading)
      mapHeading.value = lastHeading
    }
  }
  if (driverMarker) driverMarker.position = driverLatLng.value
}

function recenterNorth() {
  if (!map) return
  // Toggle: if we're following, switch to a brief north-up overview. Next
  // GPS fix flips us back into follow (per the watch handler).
  followMode.value = false
  map.setHeading(0)
  map.setTilt(0)
  map.setZoom(15)
  mapHeading.value = 0
}

// ─── Fullscreen API (mirrors DriverRouteMap pattern) ──────────────────────────
async function requestPanelFullscreen() {
  const el = overlayEl.value
  if (!el) return
  const req = el.requestFullscreen
    || el.webkitRequestFullscreen
    || el.mozRequestFullScreen
    || el.msRequestFullscreen
  if (!req) return
  try { await req.call(el) } catch { /* user gesture missing or unsupported — silent */ }
}
function exitDocumentFullscreen() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement
  if (!fsEl) return
  const exit = document.exitFullscreen
    || document.webkitExitFullscreen
    || document.mozCancelFullScreen
    || document.msExitFullscreen
  if (!exit) return
  try { exit.call(document) } catch { /* silent */ }
}
function onFullscreenChange() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement
  if (!fsEl && props.open) emit('close')
}

// ─── Watchers & lifecycle ─────────────────────────────────────────────────────
function tearDown() {
  if (routeLine) { routeLine.setMap(null); routeLine = null }
  if (driverMarker) { driverMarker.map = null; driverMarker = null }
  for (const o of trafficOverlays) { o.setMap(null) }
  trafficOverlays = []
  map = null
}

watch(() => props.open, async (val) => {
  if (val) {
    currentStepIdx.value = 0
    followMode.value = true
    await nextTick()
    await initMap()
    requestPanelFullscreen()
  } else {
    exitDocumentFullscreen()
    tearDown()
  }
})

watch(() => props.driverPosition, () => {
  if (!props.open) return
  followMode.value = true
  syncCameraToDriver()
  advanceStepIfNeeded()
}, { deep: true })

watch(() => props.activeRoute, () => {
  if (!props.open || !map) return
  // Active alternative changed (rare while in Drive Mode, but possible) —
  // rebuild the polyline and reset step pointer.
  currentStepIdx.value = 0
  drawRoute()
})

document.addEventListener('fullscreenchange', onFullscreenChange)
document.addEventListener('webkitfullscreenchange', onFullscreenChange)

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
  exitDocumentFullscreen()
  tearDown()
})
</script>

<style scoped>
.drive-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: #000;
  display: block;
  /* svh keeps the bottom-of-screen visible on mobile when the URL bar shows */
  width: 100vw;
  width: 100svw;
  height: 100vh;
  height: 100svh;
}
.drive-overlay:fullscreen { width: 100vw; height: 100vh; }
.drive-overlay:-webkit-full-screen { width: 100vw; height: 100vh; }

.drive-map {
  position: absolute;
  inset: 0;
  z-index: 1;
}

/* Top banner */
.drive-banner {
  position: absolute;
  top: max(env(safe-area-inset-top, 0), 0.75rem);
  left: 0.75rem;
  right: 0.75rem;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  pointer-events: none;
}
.drive-banner-main {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  background: #065f46;
  color: #fff;
  padding: 0.85rem 1rem;
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.35);
  pointer-events: auto;
}
.drive-banner-icon {
  font-size: 1.9rem;
  line-height: 1;
  font-weight: 700;
  min-width: 36px;
  text-align: center;
}
.drive-banner-text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
  flex: 1;
}
.drive-banner-distance {
  font-size: 0.78rem;
  font-weight: 500;
  opacity: 0.85;
  text-transform: lowercase;
}
.drive-banner-street {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.15;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drive-banner-then {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  align-self: flex-start;
  background: #047857;
  color: #ecfdf5;
  padding: 0.45rem 0.8rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  pointer-events: auto;
  box-shadow: 0 3px 10px rgba(0,0,0,0.25);
}
.drive-then-icon { font-size: 1.05rem; line-height: 1; }

/* Compass */
.drive-compass {
  position: absolute;
  top: calc(max(env(safe-area-inset-top, 0), 0.75rem) + 7rem);
  right: 0.85rem;
  z-index: 10;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #fff;
  border: none;
  box-shadow: 0 3px 10px rgba(0,0,0,0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: #dc2626;
  font-size: 1.3rem;
  line-height: 1;
}
.drive-compass-needle {
  display: inline-block;
  transform-origin: 50% 50%;
  transition: transform 350ms ease;
}

/* Speed pill */
.drive-speed {
  position: absolute;
  left: 0.85rem;
  bottom: calc(max(env(safe-area-inset-bottom, 0), 0.75rem) + 5.5rem);
  z-index: 10;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 3px 10px rgba(0,0,0,0.25);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-family: inherit;
}
.drive-speed-val {
  font-size: 1.4rem;
  font-weight: 700;
  color: #1f2937;
  line-height: 1;
}
.drive-speed-unit {
  font-size: 0.65rem;
  color: #6b7280;
  margin-top: 0.1rem;
}

/* Footer */
.drive-footer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.85rem 1rem calc(max(env(safe-area-inset-bottom, 0), 1rem));
  background: #fff;
  box-shadow: 0 -4px 14px rgba(0,0,0,0.15);
  gap: 0.75rem;
}
.drive-close, .drive-footer-spacer {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.drive-close {
  border-radius: 50%;
  background: #f3f4f6;
  border: none;
  font-size: 1.1rem;
  color: #1f2937;
  cursor: pointer;
}
.drive-close:active { background: #e5e7eb; }
.drive-progress {
  flex: 1 1 auto;
  text-align: center;
  min-width: 0;
}
.drive-progress-time {
  font-size: 1.5rem;
  font-weight: 700;
  color: #15803d;
  line-height: 1.15;
}
.drive-progress-meta {
  font-size: 0.85rem;
  color: #4b5563;
  margin-top: 0.1rem;
}
</style>
