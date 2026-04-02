let mapsLib = null
let loadPromise = null

async function fetchApiKey() {
  const res = await fetch('/api/config/maps-key')
  if (!res.ok) throw new Error('Failed to fetch maps key')
  const data = await res.json()
  return data.key
}

export function useGoogleMaps() {
  async function load() {
    if (mapsLib) return mapsLib
    if (loadPromise) return loadPromise

    loadPromise = (async () => {
      const apiKey = await fetchApiKey()

      // Load Google Maps via dynamic script tag (Loader class is deprecated)
      if (!window.google?.maps) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script')
          script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=marker&v=weekly`
          script.async = true
          script.onload = resolve
          script.onerror = reject
          document.head.appendChild(script)
        })
      }

      mapsLib = google.maps
      return mapsLib
    })()

    return loadPromise
  }

  async function createMap(container, options = {}) {
    const maps = await load()
    return new maps.Map(container, {
      zoom: options.zoom || 5,
      center: options.center || { lat: 32.7767, lng: -96.7970 },
      mapTypeId: options.mapTypeId || 'roadmap',
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: 'greedy',
      ...options,
    })
  }

  return { load, createMap }
}
