/**
 * useDriverPosition — the driver app's single source of "where is this truck".
 *
 * ⚠️⚠️ PHONE GPS HERE IS FOR NAVIGATION DISPLAY ONLY AND IS NEVER SENT TO THE
 * SERVER. This composable makes NO write call of any kind. Phone-based position
 * reporting was retired on 2026-05-13; `POST /api/location` is a 410 Gone stub,
 * and ELD telemetry remains the sole source for load tracking, driver pay
 * (`getEldTravelDaysByVehicle`'s travel-day basis) and geofence auto-status.
 * A phone fix that reached the server would silently restate all three. If you
 * are here to "re-enable driver location reporting", this is not that pipeline —
 * do not add a POST to it.
 *
 * WHY A LADDER RATHER THAN A SWITCH
 * ---------------------------------
 * DriverView used to pick a source with `if (phoneGpsWatcherId !== null) return`
 * — a binary latch on whether a watcher had ever been *installed*. When a driver
 * locks their phone, iOS freezes the page: `watchPosition` stops delivering, but
 * the watcher id stays non-null forever. So the ELD path stayed blocked, the ELD
 * poll and the socket fan-out were both discarded, and the truck pin froze at
 * the last phone fix — silently, with the map looking perfectly healthy. The
 * same happens in a tunnel, on a denied-after-grant permission, and any time the
 * OS suspends the tab.
 *
 * The fix is to select on FRESHNESS, not on installation: the phone owns the
 * position only while its last fix is younger than PHONE_FRESH_MS, after which
 * ELD takes over automatically and hands back the moment the phone recovers. A
 * ticking clock ref drives the computed, so the handover happens on a timer
 * rather than waiting for an event that a frozen page will never emit.
 *
 * Module-level singleton, matching useApi/useSocket/useToast: DriveMode's
 * "Navigate" tap needs to start the phone watcher from inside a user gesture,
 * and the component that owns that button (DriverRouteMap) sits two levels below
 * DriverView behind a component this change does not own.
 */
import { ref, computed } from 'vue'
import { useApi } from './useApi'

// A fix older than this is not good enough to steer by. 15 s at 65 mph is
// ~440 m — already past most city maneuvers, so anything staler must fall back
// to the ELD feed rather than pretend to be live.
export const PHONE_FRESH_MS = 15000
const ELD_POLL_MS = 30000
// Freshness has to be re-evaluated on a clock, not on an event: the whole point
// is to recover from a source that has STOPPED emitting events.
const CLOCK_TICK_MS = 3000

const api = useApi()

const phoneFix = ref(null)
const phoneFixAt = ref(0)
const phoneStatus = ref('') // '' | 'requesting' | 'active' | 'denied' | 'error' | 'unavailable'
// WHICH load the driver tapped Navigate on, stamped at the moment of the tap.
// Phone GPS is a per-tap, per-load request, so the banner that reports how that
// request went belongs to that load and to no other. Empty = nobody has asked.
const phoneGpsLoadId = ref('')
const eldFix = ref(null)
const eldFixAt = ref(0)
const clock = ref(Date.now())

let watcherId = null
let pollTimer = null
let clockTimer = null
let driverNameGetter = () => ''
let activeLoadIdGetter = () => ''
// Set once GET /api/driver/position proves this build is running against a
// server that predates it — either a real 404/405, or (the shape that actually
// occurs in production; see bodyIsUnparsed) a 200 carrying index.html. Falls
// back to the fleet-wide endpoint the driver app has always used, filtered to
// this driver.
let useLegacyEldEndpoint = false

const phoneIsFresh = computed(
  () => !!phoneFix.value && clock.value - phoneFixAt.value < PHONE_FRESH_MS,
)

/** 'phone' | 'eld' | 'none' */
const source = computed(() => {
  if (phoneIsFresh.value) return 'phone'
  if (eldFix.value) return 'eld'
  return 'none'
})

const position = computed(() => {
  if (phoneIsFresh.value) return phoneFix.value
  return eldFix.value
})

/** Age in ms of whatever `position` currently resolves to. */
const positionAgeMs = computed(() => {
  if (phoneIsFresh.value) return clock.value - phoneFixAt.value
  if (eldFix.value) return clock.value - eldFixAt.value
  return null
})

/**
 * What LoadDetail's existing banner is fed. Deliberately narrowed to the five
 * values that component already renders sentences for — a stale phone fix maps
 * to '' (banner hidden) because the ELD has silently taken over and Drive Mode
 * surfaces that state itself, with a far more specific message.
 *
 * ⚠️ THIS IS A MODULE SINGLETON AND IS THEREFORE NOT, BY ITSELF, ENOUGH TO
 * DECIDE WHETHER TO RENDER A BANNER. It used to be a per-load ref that reset
 * when the driver opened another load; as a singleton, one declined permission
 * prompt would otherwise sit on top of EVERY load for the rest of the session.
 * Pair it with `phoneGpsLoadId` — see DriverView's `phoneGpsModeActive`.
 */
const bannerStatus = computed(() => {
  if (phoneStatus.value === 'active' && !phoneIsFresh.value) return ''
  return phoneStatus.value
})

function normalizeFix(raw, fallbackSource) {
  if (!raw) return null
  const lat = Number.isFinite(raw.latitude) ? raw.latitude : raw.lat
  const lng = Number.isFinite(raw.longitude) ? raw.longitude : raw.lng
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return {
    latitude: lat,
    longitude: lng,
    speed: Number.isFinite(raw.speed) ? raw.speed : null,
    heading: Number.isFinite(raw.heading) ? raw.heading : (Number.isFinite(raw.bearing) ? raw.bearing : null),
    source: raw.source || fallbackSource,
    lastPingAge: raw.lastPingAge != null ? raw.lastPingAge : null,
  }
}

// ─── Phone GPS (display only — see the header) ────────────────────────────────
function stopPhoneGps() {
  try {
    if (watcherId !== null && navigator?.geolocation) navigator.geolocation.clearWatch(watcherId)
  } catch { /* nothing useful to do */ }
  watcherId = null
  phoneFix.value = null
  phoneFixAt.value = 0
  phoneStatus.value = ''
  // ⚠️ `phoneGpsLoadId` is deliberately NOT cleared here. The PERMISSION_DENIED
  // path calls this and then re-asserts 'denied', so clearing the scope would
  // leave the one status the driver can act on with no load to render against —
  // i.e. no banner at all. `stop()` (app unmount) clears it instead.
}

/**
 * Must be called from inside a user gesture on iOS/Safari or the permission
 * prompt is suppressed. The Drive Mode "Navigate" tap is that gesture.
 *
 * `loadId` scopes the outcome banner to the load that asked. Callers that have
 * it may pass it; DriverRouteMap's Navigate button does not, so it falls back
 * to the getter DriverView registers in start() — the load whose detail page is
 * open, which is the only place that button can be tapped from.
 */
function startPhoneGps(loadId) {
  // ⚠️ Stamped FIRST, above both early returns. A driver who is denied on load
  // A, opens load B and taps Navigate there must see the outcome on B — and the
  // 'unavailable' and already-watching paths both leave without ever reaching
  // the body below, so a stamp placed after them would leave the banner
  // pointing at the previous load.
  const scope = loadId == null || loadId === '' ? activeLoadIdGetter() : loadId
  phoneGpsLoadId.value = String(scope || '')
  if (!navigator?.geolocation) {
    phoneStatus.value = 'unavailable'
    return
  }
  if (watcherId !== null) return // already watching; re-arming would drop the fix
  phoneStatus.value = 'requesting'
  try {
    watcherId = navigator.geolocation.watchPosition(
      (p) => {
        phoneStatus.value = 'active'
        phoneFixAt.value = Date.now()
        clock.value = phoneFixAt.value
        phoneFix.value = {
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          // m/s and degrees-from-north; either may be null when stationary.
          speed: Number.isFinite(p.coords.speed) ? p.coords.speed : null,
          heading: Number.isFinite(p.coords.heading) ? p.coords.heading : null,
          accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null,
          source: 'phone',
          lastPingAge: 0,
        }
      },
      (err) => {
        // code 1 = PERMISSION_DENIED (terminal — stop watching, the driver must
        // re-grant). 2 = POSITION_UNAVAILABLE and 3 = TIMEOUT are BOTH transient
        // (a tunnel, a parking garage) and the watcher recovers on its own, so
        // tearing it down there would turn a 20-second underpass into a
        // permanent loss of precise position for the rest of the load.
        if (err && err.code === 1) {
          phoneStatus.value = 'denied'
          stopPhoneGps()
          phoneStatus.value = 'denied'
          return
        }
        phoneStatus.value = 'error'
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    )
  } catch {
    phoneStatus.value = 'error'
  }
}

// ─── ELD ──────────────────────────────────────────────────────────────────────
/** Socket `location-update` fan-out. Already filtered to this driver by caller. */
function applyEldFix(payload) {
  const fix = normalizeFix(payload, 'routemate')
  if (!fix) return
  eldFix.value = fix
  eldFixAt.value = Date.now()
  clock.value = eldFixAt.value
}

/**
 * "Did that 200 actually come from GET /api/driver/position?"
 *
 * ⚠️ THIS TEST IS THE ONLY REACHABLE DOWNGRADE TRIGGER — THE 404 ONE BELOW
 * CANNOT FIRE ON ITS OWN. A server that PREDATES this endpoint does not answer
 * 404: server.js has no /api 404 middleware, so its SPA catch-all `app.get("*")`
 * matches every unmatched GET including /api/*, and returns 200 + index.html.
 * `useApi.request` then swallows the JSON parse failure and resolves a bare `{}`
 * (useApi.js:31-32) — MEASURED against a stub of that exact response, not
 * assumed. Without this test the sequence was `{}` → normalizeFix → null →
 * eldFix = null → return, on every poll forever: never a downgrade, never a
 * legacy call, the driver's truck pin permanently absent and Drive Mode with no
 * position, and not one error anywhere. The reachable case is a new SPA against
 * an older server process — the deploy window between `npm run build:client`
 * and `pm2 restart`, or a long-lived cached tab.
 *
 * ⚠️ ZERO KEYS IS THE WHOLE TEST, AND IT MUST STAY THAT NARROW. Every 2xx the
 * real handler emits carries BOTH `ok` and `position`, on all five return paths
 * — including the degraded ones (no_driver_name / no_truck_assigned /
 * truck_not_eld_linked / no_recent_fix). So `{ok:true, position:null}` — "no fix
 * right now", the ordinary answer for a parked, unlinked or GPS-less truck — has
 * keys and must NOT downgrade. Conflating the two would demote a perfectly good
 * server the first time a driver's truck went offline.
 */
function bodyIsUnparsed(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return true
  return Object.keys(data).length === 0
}

async function refreshEld() {
  const name = (driverNameGetter() || '').trim()
  if (!useLegacyEldEndpoint) {
    let data = null
    let downgrade = false
    try {
      // Driver-scoped and resolved from the session — no driver name on the
      // wire, and it never returns routemate_vehicle_id.
      data = await api.get('/api/driver/position')
    } catch (err) {
      // 404/405 ⇒ this server predates the endpoint. Anything else (401, 500,
      // a dropped connection) is transient and must NOT permanently downgrade
      // us to the legacy path.
      if (err && (err.status === 404 || err.status === 405)) downgrade = true
      else return
    }
    if (!downgrade) {
      if (!bodyIsUnparsed(data)) {
        const fix = normalizeFix(data.position || data, 'routemate')
        if (fix) {
          eldFix.value = fix
          eldFixAt.value = Date.now()
          clock.value = eldFixAt.value
        } else {
          eldFix.value = null
        }
        return
      }
      // Else: a 200 this endpoint could not have produced. Same conclusion as a
      // 404, reached by the shape of the body instead of the status line.
    }
    useLegacyEldEndpoint = true
    // Fall THROUGH rather than returning: the legacy call happens on this very
    // poll, so the pin appears now instead of 30 s later. `eldFix` is left
    // untouched on the way past — nulling it here would discard a good fix if
    // the legacy call then failed too.
  }
  if (!name) return
  try {
    const data = await api.get('/api/locations/latest')
    const dn = name.toLowerCase()
    const l = (data?.locations || []).find(
      (x) => (x.driver || '').toLowerCase() === dn && x.latitude != null,
    )
    const fix = normalizeFix(l, 'routemate')
    if (fix) {
      eldFix.value = fix
      eldFixAt.value = Date.now()
      clock.value = eldFixAt.value
    } else {
      eldFix.value = null
    }
  } catch {
    // Silent — every consumer renders a no-pin state on its own.
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
function start(opts = {}) {
  if (typeof opts.driverName === 'function') driverNameGetter = opts.driverName
  // Optional: how to name the load a Navigate tap belongs to. The tap itself
  // comes from DriverRouteMap, two levels below the view that knows which load
  // is open, so the scope is resolved at tap time through this getter rather
  // than threaded down as a prop.
  if (typeof opts.activeLoadId === 'function') activeLoadIdGetter = opts.activeLoadId
  if (!clockTimer) clockTimer = setInterval(() => { clock.value = Date.now() }, CLOCK_TICK_MS)
  if (!pollTimer) pollTimer = setInterval(refreshEld, ELD_POLL_MS)
  refreshEld()
}

function stop() {
  stopPhoneGps()
  // Cleared here and only here: the driver app is going away, so no banner has
  // a load left to belong to.
  phoneGpsLoadId.value = ''
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
}

export function useDriverPosition() {
  return {
    position,
    source,
    positionAgeMs,
    phoneStatus,
    bannerStatus,
    phoneGpsLoadId,
    phoneIsFresh,
    startPhoneGps,
    stopPhoneGps,
    applyEldFix,
    refreshEld,
    start,
    stop,
  }
}
