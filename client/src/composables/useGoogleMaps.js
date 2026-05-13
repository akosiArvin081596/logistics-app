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
          script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=marker,places&v=weekly&loading=async&callback=${cbName}`
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

  // Attach a Google Places Autocomplete to an <input> element.
  // onSelect receives { formatted, place } — formatted is the full address string,
  // place is the raw google.maps.places.PlaceResult (with address_components etc).
  // Used for bank address, personal address, and any other address field that
  // needs to be verified against real places so payments / deliveries don't fail.
  async function attachAutocomplete(inputEl, onSelect, options = {}) {
    if (!inputEl) return null
    const maps = await load()
    const autocomplete = new maps.places.Autocomplete(inputEl, {
      types: options.types || ['address'],
      componentRestrictions: options.componentRestrictions || { country: 'us' },
      fields: options.fields || ['address_components', 'formatted_address', 'geometry'],
    })
    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace()
      if (place && place.formatted_address && typeof onSelect === 'function') {
        onSelect({ formatted: place.formatted_address, place })
      }
    })
    return autocomplete
  }

  return { load, createMap, attachAutocomplete }
}

// Helper: create a colored dot element for AdvancedMarkerElement content
export function createDotPin(color, size = 14) {
  const el = document.createElement('div')
  el.style.cssText = `width:${size}px;height:${size}px;background:${color};border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.3);cursor:pointer;`
  return el
}

// Helper: truck marker for AdvancedMarkerElement content.
// moving=true  → SVG arrow rotated to `heading` (deg, 0 = north / map-up, clockwise)
// moving=false → square "P" parked pin so it's visually distinct on the map
// Heading should be the bearing along the road at the driver's projected point
// (see routeHeadingAt in TrackingMap.vue) so the arrow snaps to the road and
// never looks slightly off-axis the way raw GPS heading does.
export function createTruckArrow({ color = '#16a34a', heading = 0, moving = true, size = 22 } = {}) {
  const el = document.createElement('div')
  el.style.cssText = `width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;cursor:pointer;`
  if (moving) {
    el.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="transform:rotate(${heading}deg);transform-origin:50% 50%;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.35));"><path d="M12 2 L19 20 L12 16 L5 20 Z" fill="${color}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`
  } else {
    el.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.35));"><rect x="5" y="5" width="14" height="14" rx="3" fill="${color}" stroke="#fff" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="11" font-weight="700" fill="#fff">P</text></svg>`
  }
  return el
}
