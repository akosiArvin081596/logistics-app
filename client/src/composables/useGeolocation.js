// Unused as of 2026-05-13 — phone GPS retired in favor of Routemate ELD.
// Kept in source for one cycle in case a future map feature wants it.
import { ref, onUnmounted } from 'vue'

export function useGeolocation(api) {
  const lastPosition = ref(null)
  const error = ref(null)
  const tracking = ref(false)
  const distanceWarning = ref(null)
  // 'ok' once the server has accepted at least one report; flips to 'failing'
  // after N consecutive POST /api/location errors so the UI can surface a
  // banner. Drivers used to have zero feedback when location reporting broke.
  const syncStatus = ref('ok')
  const permissionState = ref('unknown') // 'granted' | 'denied' | 'prompt' | 'unknown'

  let watchId = null
  let activeLoadId = ''
  let lastReported = null
  let lastReportTime = 0
  let heartbeatId = null
  let consecutiveFailures = 0
  let permissionStatus = null
  let permissionChangeListener = null
  const FAILURES_BEFORE_WARNING = 3

  const MIN_DISTANCE = 50        // meters — only report if moved this far
  const MIN_INTERVAL = 10 * 1000 // 10s — don't report more often than this
  const HEARTBEAT = 60 * 1000    // 60s — send a ping even when stationary

  function distanceMeters(a, b) {
    const R = 6371000
    const toRad = (d) => (d * Math.PI) / 180
    const dLat = toRad(b.latitude - a.latitude)
    const dLng = toRad(b.longitude - a.longitude)
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))
  }

  function shouldReport(pos) {
    const now = Date.now()
    // Always report first position
    if (!lastReported) return true
    // Respect minimum interval
    if (now - lastReportTime < MIN_INTERVAL) return false
    // Report if heartbeat elapsed (driver stationary but still online)
    if (now - lastReportTime >= HEARTBEAT) return true
    // Report if moved enough
    return distanceMeters(lastReported, pos) >= MIN_DISTANCE
  }

  async function sendReport(data) {
    lastReported = { latitude: data.latitude, longitude: data.longitude }
    lastReportTime = Date.now()
    try {
      const resp = await api.post('/api/location', data)
      consecutiveFailures = 0
      if (syncStatus.value !== 'ok') syncStatus.value = 'ok'
      // Only update warning when server returns one, or when server confirms driver is now close
      if (resp.distanceWarning) {
        distanceWarning.value = resp.distanceWarning
      } else if (distanceWarning.value && data.loadId === activeLoadId) {
        // Driver is now within range for the tracked load — clear warning
        distanceWarning.value = null
      }
    } catch {
      // Don't toast every failure (noisy when going through a tunnel), but
      // after a few in a row flip the status so DriverHeader can warn.
      consecutiveFailures += 1
      if (consecutiveFailures >= FAILURES_BEFORE_WARNING) {
        syncStatus.value = 'failing'
      }
    }
  }

  function onPosition(pos) {
    const accuracy = pos.coords.accuracy || 999
    // Ignore very inaccurate readings (>100m) to prevent map jumping
    if (accuracy > 100 && lastPosition.value) return
    const data = {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy,
      speed: pos.coords.speed || 0,
      heading: pos.coords.heading || 0,
      loadId: activeLoadId,
    }
    lastPosition.value = data

    if (shouldReport(data)) sendReport(data)
  }

  function onError(err) {
    error.value = err.message
  }

  function start(loadId) {
    if (tracking.value) stop()
    activeLoadId = loadId || ''
    tracking.value = true
    lastReported = null
    lastReportTime = 0

    // Use watchPosition — browser calls back only when position changes
    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 5000,
    })

    // Heartbeat fallback for stationary drivers
    heartbeatId = setInterval(() => {
      if (lastPosition.value && Date.now() - lastReportTime >= HEARTBEAT) {
        sendReport({ ...lastPosition.value, loadId: activeLoadId })
      }
    }, HEARTBEAT)
  }

  function stop() {
    tracking.value = false
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId)
      watchId = null
    }
    if (heartbeatId) {
      clearInterval(heartbeatId)
      heartbeatId = null
    }
  }

  function updateLoadId(loadId) {
    activeLoadId = loadId || ''
  }

  // Check / request geolocation permission. Returns a normalized result so
  // callers can render the right guidance without duplicating error-code logic.
  // Shape: { state, reason? }
  //   state: 'granted' | 'denied' | 'unavailable' | 'unsupported' | 'timeout' | 'error'
  async function requestPermission() {
    if (!navigator.geolocation) {
      return { state: 'unsupported', reason: 'Geolocation not available in this browser' }
    }
    // Preflight via Permissions API for an instant answer without triggering
    // the OS prompt when we already know the state. Also subscribe to
    // permission-state changes so a mid-session revoke (driver toggles
    // location off in OS/browser settings) flips `permissionState` and the
    // caller can re-gate the app instead of silently dropping GPS.
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const p = await navigator.permissions.query({ name: 'geolocation' })
        permissionStatus = p
        permissionState.value = p.state
        if (!permissionChangeListener) {
          permissionChangeListener = () => { permissionState.value = p.state }
          p.addEventListener?.('change', permissionChangeListener)
        }
        if (p.state === 'granted') return { state: 'granted' }
        if (p.state === 'denied') {
          return { state: 'denied', reason: 'Permission blocked in browser settings' }
        }
        // 'prompt' → fall through and trigger getCurrentPosition below
      } catch {
        // Older browsers without the Permissions API — fall through
      }
    }
    // Triggers the OS prompt (if not already decided) and also catches the
    // "OS Location Services disabled" case, which the Permissions API cannot
    // distinguish from 'granted'.
    return await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        () => { permissionState.value = 'granted'; resolve({ state: 'granted' }) },
        (err) => {
          if (err.code === 1) { permissionState.value = 'denied'; resolve({ state: 'denied', reason: 'You denied location access' }) }
          else if (err.code === 2) resolve({ state: 'unavailable', reason: 'Device cannot determine location' })
          else if (err.code === 3) resolve({ state: 'timeout', reason: 'Location request timed out' })
          else resolve({ state: 'error', reason: err.message || 'Unknown error' })
        },
        { timeout: 10000, maximumAge: 0, enableHighAccuracy: false },
      )
    })
  }

  function cleanup() {
    stop()
    if (permissionStatus && permissionChangeListener) {
      permissionStatus.removeEventListener?.('change', permissionChangeListener)
      permissionChangeListener = null
      permissionStatus = null
    }
  }

  onUnmounted(cleanup)

  return { lastPosition, error, tracking, distanceWarning, syncStatus, permissionState, start, stop, updateLoadId, requestPermission }
}
