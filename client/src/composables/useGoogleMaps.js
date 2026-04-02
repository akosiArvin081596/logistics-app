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

      if (!window.google?.maps?.Map) {
        await new Promise((resolve, reject) => {
          // Use callback approach — Google calls initMap when fully ready
          const cbName = '_gmReady' + Date.now()
          window[cbName] = () => { delete window[cbName]; resolve() }
          const script = document.createElement('script')
          script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=marker&v=weekly&callback=${cbName}`
          script.async = true
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
      mapId: 'DEMO_MAP_ID',
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: 'greedy',
      ...options,
    })
  }

  return { load, createMap }
}

// Helper: create a colored dot element for AdvancedMarkerElement content
export function createDotPin(color, size = 14) {
  const el = document.createElement('div')
  el.style.cssText = `width:${size}px;height:${size}px;background:${color};border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.3);cursor:pointer;`
  return el
}
