<template>
  <Teleport to="body">
    <div v-if="open" ref="overlayEl" class="drive-overlay">
      <!-- Top banner: current maneuver + street name + "Then" sub-pill -->
      <div class="drive-banner" v-if="currentStep">
        <div class="drive-banner-main" :class="{ 'drive-banner-unsure': !matchReliable }">
          <span class="drive-banner-icon" v-html="iconFor(currentStep.maneuver)"></span>
          <div class="drive-banner-text">
            <div v-if="!matchReliable" class="drive-banner-distance">Off the route — instruction may not apply</div>
            <div v-else-if="maneuverMeters != null" class="drive-banner-distance">
              In {{ formatDistance(maneuverMeters) }}
            </div>
            <div class="drive-banner-street">{{ currentStreetName }}</div>
          </div>
        </div>
        <div v-if="nextStep" class="drive-banner-then">
          <span class="drive-then-label">Then</span>
          <span class="drive-then-icon" v-html="iconFor(nextStep.maneuver)"></span>
        </div>
      </div>
      <div v-else-if="destinationLabel" class="drive-banner">
        <div class="drive-banner-main">
          <span class="drive-banner-icon">📍</span>
          <div class="drive-banner-text">
            <div class="drive-banner-distance">Navigating to</div>
            <div class="drive-banner-street">{{ destinationLabel }}</div>
          </div>
        </div>
      </div>

      <!-- Status strip: rerouting / off-route / voice-paused. Stacked under the
           banner so none of them ever covers the maneuver instruction. -->
      <div class="drive-status-strip">
        <div v-if="rerouting" class="drive-chip drive-chip-active">Rerouting…</div>
        <div v-else-if="offRoute" class="drive-chip drive-chip-warn">Off route</div>
        <div v-if="voiceNotice" class="drive-chip drive-chip-muted">🔇 {{ voiceNotice }}</div>
      </div>

      <!-- Map -->
      <div ref="mapEl" class="drive-map"></div>

      <!-- Top-right controls -->
      <div class="drive-controls">
        <button
          class="drive-ctl"
          :class="{ 'drive-ctl-off': followMode }"
          @click="toggleFollow"
          :title="followMode ? 'Overview (north up)' : 'Re-center on the truck'"
          :aria-label="followMode ? 'Switch to north-up overview' : 'Re-center on the truck'"
        >
          <span v-if="followMode" class="drive-compass-needle" :style="{ transform: `rotate(${-mapHeading}deg)` }">▲</span>
          <span v-else>◎</span>
        </button>
        <button
          class="drive-ctl"
          @click="toggleVoice"
          :title="voice.muted.value ? 'Unmute voice guidance' : 'Mute voice guidance'"
          :aria-label="voice.muted.value ? 'Unmute voice guidance' : 'Mute voice guidance'"
          :aria-pressed="voice.muted.value ? 'true' : 'false'"
        >
          <span>{{ voice.muted.value ? '🔇' : '🔊' }}</span>
        </button>
        <button
          v-if="!isFullscreen"
          class="drive-ctl"
          @click="requestPanelFullscreen"
          title="Full screen"
          aria-label="Full screen"
        >
          <span>⛶</span>
        </button>
      </div>

      <!-- Bottom-left speed pill -->
      <div class="drive-speed">
        <div class="drive-speed-val">{{ speedKmh != null ? speedKmh : '--' }}</div>
        <div class="drive-speed-unit">km/h</div>
      </div>

      <!-- Bottom footer: X + remaining time/distance/arrival -->
      <div class="drive-footer">
        <button class="drive-close" @click="$emit('close')" title="Exit Navigation Mode">✕</button>
        <div class="drive-progress">
          <div v-if="arrived" class="drive-progress-time">Arrived</div>
          <div v-else class="drive-progress-time">{{ formatRemainingTime(remainingSec) }}</div>
          <div class="drive-progress-meta">
            <span>{{ formatDistance(remainingMeters) }}</span>
            <span v-if="arrivalClock && !arrived"> · {{ arrivalClock }}</span>
          </div>
          <div v-if="destinationLabel" class="drive-progress-dest">{{ destinationLabel }}</div>
        </div>
        <!-- Spacer matches the close button width to keep the time perfectly centered -->
        <div class="drive-footer-spacer"></div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { useDocumentVisibility } from '@vueuse/core'
import { useGoogleMaps, createTruckArrow, createDotPin } from '../../composables/useGoogleMaps'
import { useVoiceGuidance } from '../../composables/useVoiceGuidance'
import { useScreenWakeLock } from '../../composables/useScreenWakeLock'
import {
  buildRouteIndex,
  buildStepOffsets,
  matchToRoute,
  stepIndexForOffset,
  distanceToManeuver as routeDistanceToManeuver,
  remainingMeters as routeRemainingMeters,
  remainingSeconds as routeRemainingSeconds,
  haversineMeters,
} from '../../utils/routeProgress'
import { createVoiceLadder, extractStreetName, SUPPRESS_REASONS } from '../../utils/voiceLadder'

const props = defineProps({
  open: { type: Boolean, default: false },
  activeRoute: { type: Object, default: null },  // { route, distanceMiles, etaMinutes, steps, trafficSegments }
  driverPosition: { type: Object, default: null },
  destination: { type: Object, default: null },  // { lat, lng, address }
  // Bumped by the parent every time new route geometry is installed. This is
  // what re-arms the voice ladder after a reroute — keyed on a counter rather
  // than object identity because the parent rebuilds the payload on every poll.
  routeVersion: { type: Number, default: 0 },
  rerouting: { type: Boolean, default: false },
  offRoute: { type: Boolean, default: false },
})

const emit = defineEmits(['close'])

const { load: loadGoogleMaps, createMap } = useGoogleMaps()
const voice = useVoiceGuidance()
const wakeLock = useScreenWakeLock()
const visibility = useDocumentVisibility()
const ladder = createVoiceLadder()

const overlayEl = ref(null)
const mapEl = ref(null)
const mapHeading = ref(0)
const followMode = ref(true)
const isFullscreen = ref(false)

// Where the driver is ALONG the route, in metres. Everything the banner and the
// footer show is derived from this one scalar — see utils/routeProgress.js.
const matchOffset = ref(null)
const matchDistanceFromRoute = ref(null)
let lastMatchAt = 0

let map = null
let routeCasing = null  // wider white outline underneath routeLine for contrast against the map
let routeLine = null
let driverMarker = null
let destMarker = null
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
// haversineMeters + extractStreetName now come from utils/ — the street name the
// driver READS here and the one they HEAR from the voice ladder must be the same
// string, so there is exactly one implementation.
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

// The route polyline, indexed by cumulative distance. Rebuilt only when the
// geometry itself changes — a 4,000-point route is not something to re-walk on
// every GPS fix.
const routeIndex = computed(() => {
  const pts = props.activeRoute?.route
  if (!Array.isArray(pts) || pts.length < 2) return null
  return buildRouteIndex(pts)
})

// Start offset of every step, plus a terminal entry, so stepOffsets[i + 1] is
// exactly where step i's maneuver happens.
const stepOffsets = computed(() => {
  if (!steps.value.length || !routeIndex.value) return []
  return buildStepOffsets(steps.value, routeIndex.value)
})

// ⚠️ DERIVED, NOT INCREMENTED. The old tracker held a currentStepIdx ref and
// bumped it by one whenever the driver came within 25 m of the step's end — a
// window an ELD feed samples roughly never (30 s ≈ 700 m at highway speed), and
// which cannot recover from a missed sample at all. This recomputes the answer
// from the matched along-route offset on every fix, so a phone lock, a tunnel or
// a 40-minute gap resyncs on the next fix instead of stranding the pointer.
const currentStepIdx = computed(() => {
  if (!steps.value.length) return 0
  if (!Number.isFinite(matchOffset.value) || stepOffsets.value.length < 2) return 0
  return stepIndexForOffset(stepOffsets.value, matchOffset.value, steps.value.length)
})
const currentStep = computed(() => steps.value[currentStepIdx.value] || null)
const nextStep = computed(() => steps.value[currentStepIdx.value + 1] || null)
const currentStreetName = computed(() => {
  if (!currentStep.value) return ''
  return extractStreetName(currentStep.value.instruction)
})

// Distance to the next maneuver, measured ALONG THE ROUTE. The old version took
// a straight line to the step's last polyline point, which under-reads by a long
// way on any curve, switchback or interchange — precisely where a driver most
// needs "in 400 m" to be true. Falls back to the step's own length until the
// first fix lands.
const maneuverMeters = computed(() => {
  if (!currentStep.value) return null
  const d = routeDistanceToManeuver(stepOffsets.value, currentStepIdx.value, matchOffset.value)
  return d != null ? d : currentStep.value.distanceMeters ?? null
})

const remainingMeters = computed(() => {
  if (routeIndex.value && Number.isFinite(matchOffset.value)) {
    return routeRemainingMeters(routeIndex.value, matchOffset.value)
  }
  if (routeIndex.value) return routeIndex.value.totalMeters
  if (!steps.value.length) return null
  return steps.value.reduce((sum, s) => sum + (s.distanceMeters || 0), 0)
})
const remainingSec = computed(() => {
  if (!steps.value.length) return null
  return routeRemainingSeconds(steps.value, stepOffsets.value, currentStepIdx.value, matchOffset.value)
})

// How far the last fix was from the route line. Beyond this the derived step
// index is a guess: the driver is on some other road, so "turn right in 200 m"
// names a turn that is not in front of them. The parent's `offRoute` flag needs
// three confirmations before it fires (correctly — it authorises a billed
// reroute); this is the instantaneous read, and all it does is stop the banner
// asserting an instruction it cannot stand behind.
const MATCH_TRUST_RADIUS_M = 150
const matchReliable = computed(
  () => !Number.isFinite(matchDistanceFromRoute.value) || matchDistanceFromRoute.value <= MATCH_TRUST_RADIUS_M,
)

const destinationLabel = computed(() => {
  const d = props.destination
  if (!d) return ''
  const addr = (d.address || '').toString().trim()
  if (addr) return addr
  if (Number.isFinite(d.lat) && Number.isFinite(d.lng)) return `${d.lat.toFixed(4)}, ${d.lng.toFixed(4)}`
  return ''
})
const arrived = computed(() => {
  const d = props.destination
  if (!d || !driverLatLng.value) return false
  if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) return false
  return haversineMeters(driverLatLng.value, { lat: d.lat, lng: d.lng }) < 80
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

// ─── Route resync ─────────────────────────────────────────────────────────────
// Re-derives the along-route offset from scratch on every fix. Forward-biased,
// so a route that crosses itself (any cloverleaf, any downtown loop) cannot snap
// navigation backwards onto the leg the truck drove an hour ago — see
// utils/routeProgress.js for why that is the hard part.
function resyncToRoute() {
  const idx = routeIndex.value
  const pos = driverLatLng.value
  if (!idx || !pos) return
  const now = Date.now()
  const m = matchToRoute(idx, pos, {
    previousOffsetMeters: matchOffset.value,
    // Sizes the forward search corridor: a long gap between fixes legitimately
    // means a long jump forward, and must not read as "off route".
    elapsedMs: lastMatchAt ? now - lastMatchAt : null,
  })
  lastMatchAt = now
  if (!m) return
  matchOffset.value = m.offsetMeters
  matchDistanceFromRoute.value = m.distanceMeters
}

// ─── Voice guidance ───────────────────────────────────────────────────────────
// Why a callout might not be spoken, in words a driver can act on. Rendered as a
// chip in the HUD: silent navigation that looks broken is worse than a
// deliberate, explained silence. Plain user-mute is excluded — the speaker
// button already says that.
const voiceNotice = computed(() => {
  if (!voice.supported) return SUPPRESS_REASONS.unsupported
  if (voice.muted.value) return null
  if (!voice.ready.value) return SUPPRESS_REASONS.locked
  if (visibility.value === 'hidden') return null
  if (props.driverPosition && props.driverPosition.source !== 'phone') return SUPPRESS_REASONS.eld
  return null
})

function runVoiceLadder() {
  if (!props.open) return
  const step = currentStep.value
  const d = maneuverMeters.value
  if (!step || !Number.isFinite(d)) return
  const res = ladder.evaluate({
    routeVersion: props.routeVersion || 0,
    stepIdx: currentStepIdx.value,
    step,
    stepDistanceMeters: step.distanceMeters,
    distanceMeters: d,
    muted: voice.muted.value,
    hidden: visibility.value === 'hidden',
    // ⚠️ An ELD fix is up to 30 s old — ~870 m at 65 mph. A callout computed
    // from it would place the turn hundreds of metres from where it is, so the
    // ladder suppresses and the chip above explains why.
    positionSource: props.driverPosition?.source === 'phone' ? 'phone' : 'eld',
    voiceReady: voice.ready.value,
    supported: voice.supported,
  })
  if (!res || res.suppressed) return
  voice.speak(res.text)
}

function toggleVoice() {
  // The tap is a user gesture, so it doubles as the iOS unlock for a driver
  // whose Navigate tap somehow missed it (a browser that blocked the first
  // utterance, a session where Drive Mode was opened before this shipped).
  if (!voice.ready.value) voice.unlock()
  voice.toggleMute()
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
  drawDestinationMarker()
  // Initial centering + heading; subsequent updates come from the watcher.
  syncCameraToDriver(true)
}

// The `destination` prop was declared and never referenced. It is the one thing
// on screen that answers "where am I actually going" when a route has no steps
// (an ELD-less truck, a lean payload), so it now drives a pin, the footer line
// and the arrival state.
function drawDestinationMarker() {
  if (!map) return
  if (destMarker) { destMarker.map = null; destMarker = null }
  const d = props.destination
  if (!d || !Number.isFinite(d.lat) || !Number.isFinite(d.lng)) return
  destMarker = new google.maps.marker.AdvancedMarkerElement({
    position: { lat: d.lat, lng: d.lng },
    map,
    content: createDotPin('#dc2626', 14),
    title: d.address || 'Destination',
  })
}

function drawRoute() {
  if (!map || !props.activeRoute?.route?.length) return
  if (routeCasing) { routeCasing.setMap(null); routeCasing = null }
  if (routeLine) { routeLine.setMap(null); routeLine = null }
  for (const o of trafficOverlays) { o.setMap(null) }
  trafficOverlays = []

  const path = props.activeRoute.route.map(p => ({ lat: p.latitude, lng: p.longitude }))

  // White casing underneath the route — gives the polyline a crisp outline
  // against pale roadmap tiles so it reads as "the route" instead of just
  // another street. This is how Google Maps' own nav UI renders it.
  routeCasing = new google.maps.Polyline({
    path,
    strokeColor: '#ffffff',
    strokeOpacity: 1,
    strokeWeight: 18,
    map,
    clickable: false,
    zIndex: 1,
  })

  routeLine = new google.maps.Polyline({
    path,
    strokeColor: '#1d4ed8',
    strokeOpacity: 1,
    strokeWeight: 12,
    map,
    clickable: false,
    zIndex: 2,
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
        strokeOpacity: 0.95,
        strokeWeight: 12,
        map,
        clickable: false,
        zIndex: 3,
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

function syncCameraToDriver(resetView = false) {
  if (!map || !driverLatLng.value) return
  if (followMode.value) {
    map.setCenter(driverLatLng.value)
    // ⚠️ Zoom and tilt are set ONLY on entry and on an explicit re-center.
    // Re-applying them on every fix stomped the driver's own pinch-zoom once a
    // minute — you could not look one junction ahead without the map yanking
    // itself back to 18/60 the moment the next ELD ping landed.
    if (resetView) {
      map.setZoom(18)
      map.setTilt(60)
    }
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

// Explicit toggle rather than a "north-up until the next fix" flash. With ELD
// fixes 30 s apart the old behaviour was neither: the overview lasted an
// arbitrary fraction of a minute and then vanished on its own.
function toggleFollow() {
  if (!map) return
  if (followMode.value) {
    followMode.value = false
    map.setHeading(0)
    map.setTilt(0)
    map.setZoom(14)
    mapHeading.value = 0
  } else {
    followMode.value = true
    syncCameraToDriver(true)
  }
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
// ⚠️ EXITING FULLSCREEN IS NOT A REQUEST TO STOP NAVIGATING. This handler used
// to `emit('close')` on any fullscreen exit, so ESC, the Android Back gesture, a
// system swipe, or the OS dropping fullscreen for an incoming call all killed
// turn-by-turn mid-drive — and the driver's only route back was to find the load
// again and re-tap Navigate. The overlay is `position: fixed; inset: 0`, so it
// still covers the screen without fullscreen; we just track the state and offer
// a button to go back in. The ✕ is the only thing that closes Drive Mode.
function onFullscreenChange() {
  isFullscreen.value = !!(document.fullscreenElement || document.webkitFullscreenElement)
}

// ─── Watchers & lifecycle ─────────────────────────────────────────────────────
function tearDown() {
  if (routeCasing) { routeCasing.setMap(null); routeCasing = null }
  if (routeLine) { routeLine.setMap(null); routeLine = null }
  if (driverMarker) { driverMarker.map = null; driverMarker = null }
  if (destMarker) { destMarker.map = null; destMarker = null }
  for (const o of trafficOverlays) { o.setMap(null) }
  trafficOverlays = []
  map = null
}

function resetProgress() {
  matchOffset.value = null
  matchDistanceFromRoute.value = null
  lastMatchAt = 0
}

watch(() => props.open, async (val) => {
  if (val) {
    resetProgress()
    ladder.reset()
    followMode.value = true
    await nextTick()
    await initMap()
    resyncToRoute()
    requestPanelFullscreen()
    // Keep the screen alive for the whole drive. Nothing in this app used the
    // Wake Lock API before, so the phone slept ~30 s after the driver mounted it.
    wakeLock.request()
  } else {
    exitDocumentFullscreen()
    wakeLock.release()
    voice.cancel()
    tearDown()
  }
})

watch(() => props.driverPosition, () => {
  if (!props.open) return
  resyncToRoute()
  syncCameraToDriver()
  runVoiceLadder()
}, { deep: true })

watch(() => props.activeRoute, () => {
  if (!props.open) return
  // New geometry — either the driver picked a different alternative or a
  // deviation triggered a reroute. The offset is measured against the OLD
  // polyline, so it is meaningless now: drop it and re-match on the new one.
  resetProgress()
  if (map) {
    drawRoute()
    drawDestinationMarker()
  }
  resyncToRoute()
})

document.addEventListener('fullscreenchange', onFullscreenChange)
document.addEventListener('webkitfullscreenchange', onFullscreenChange)

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
  exitDocumentFullscreen()
  wakeLock.release()
  voice.cancel()
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
/* Off-route: the maneuver is still shown (it is the last thing we knew) but the
   banner stops looking authoritative about it. */
.drive-banner-unsure { background: #92400e; }
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

/* Status chips (rerouting / off route / voice paused) */
.drive-status-strip {
  position: absolute;
  top: calc(max(env(safe-area-inset-top, 0), 0.75rem) + 5.4rem);
  left: 0.75rem;
  right: 4.5rem; /* clear of the control column */
  z-index: 11;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  pointer-events: none;
}
.drive-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.65rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.2;
  box-shadow: 0 2px 8px rgba(0,0,0,0.25);
}
.drive-chip-active { background: #1d4ed8; color: #fff; }
.drive-chip-warn { background: #b45309; color: #fff; }
.drive-chip-muted { background: rgba(17,24,39,0.85); color: #e5e7eb; }

/* Control column (re-center / voice / fullscreen) */
.drive-controls {
  position: absolute;
  top: calc(max(env(safe-area-inset-top, 0), 0.75rem) + 8.4rem);
  right: 0.85rem;
  z-index: 12;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.drive-ctl {
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
  color: #1f2937;
  font-size: 1.2rem;
  line-height: 1;
  padding: 0;
}
.drive-ctl:active { background: #e5e7eb; }
.drive-ctl-off { color: #dc2626; font-size: 1.3rem; }
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
.drive-progress-dest {
  font-size: 0.72rem;
  color: #6b7280;
  margin-top: 0.15rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
