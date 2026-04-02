import { Loader } from '@googlemaps/js-api-loader'

let loaderPromise = null
let googleObj = null

async function fetchApiKey() {
  const res = await fetch('/api/config/maps-key')
  if (!res.ok) throw new Error('Failed to fetch maps key')
  const data = await res.json()
  return data.key
}

export function useGoogleMaps() {
  async function load() {
    if (googleObj) return googleObj
    if (loaderPromise) return loaderPromise

    loaderPromise = (async () => {
      const apiKey = await fetchApiKey()
      const loader = new Loader({ apiKey, version: 'weekly', libraries: ['marker'] })
      googleObj = await loader.importLibrary('maps')
      return googleObj
    })()

    return loaderPromise
  }

  // Helper: create a standard road map in a container div
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
