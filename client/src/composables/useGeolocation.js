import { ref, onUnmounted } from 'vue'

export function useGeolocation(api) {
  const lastPosition = ref(null)
  const error = ref(null)
  const tracking = ref(false)

  let intervalId = null
  let activeLoadId = ''
  const INTERVAL_ACTIVE = 15 * 1000       // 15 seconds
  const INTERVAL_BACKGROUND = 60 * 1000   // 1 minute

  function getInterval() {
    return document.hidden ? INTERVAL_BACKGROUND : INTERVAL_ACTIVE
  }

  async function reportPosition() {
    if (!navigator.geolocation) {
      error.value = 'Geolocation not supported'
      return
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const data = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy || 0,
          speed: pos.coords.speed || 0,
          heading: pos.coords.heading || 0,
          loadId: activeLoadId,
        }
        lastPosition.value = data
        try {
          await api.post('/api/location', data)
        } catch (err) {
          // Silent fail — don't disrupt driver experience
        }
      },
      (err) => {
        error.value = err.message
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
  }

  function start(loadId) {
    if (tracking.value) stop()
    activeLoadId = loadId || ''
    tracking.value = true

    // Report immediately
    reportPosition()

    // Then on interval
    intervalId = setInterval(reportPosition, getInterval())

    // Adjust interval when tab visibility changes
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  function stop() {
    tracking.value = false
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }

  function updateLoadId(loadId) {
    activeLoadId = loadId || ''
  }

  function onVisibilityChange() {
    if (!tracking.value) return
    if (intervalId) clearInterval(intervalId)
    intervalId = setInterval(reportPosition, getInterval())
  }

  onUnmounted(stop)

  return { lastPosition, error, tracking, start, stop, updateLoadId }
}
