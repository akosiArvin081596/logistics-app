import { ref, onUnmounted } from 'vue'

export function useGeolocation(api) {
  const lastPosition = ref(null)
  const error = ref(null)
  const tracking = ref(false)
  const distanceWarning = ref(null)

  let watchId = null
  let activeLoadId = ''
  let lastReported = null
  let lastReportTime = 0
  let heartbeatId = null

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
      distanceWarning.value = resp.distanceWarning || null
    } catch {
      // Silent fail
    }
  }

  function onPosition(pos) {
    const data = {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy || 0,
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

  onUnmounted(stop)

  return { lastPosition, error, tracking, distanceWarning, start, stop, updateLoadId }
}
