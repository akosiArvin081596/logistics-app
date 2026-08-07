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

// Fuel-pump glyph, shared by every fuel-stop marker variant below.
const PUMP_PATH =
  'M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h9v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77zM12 10H6V5h6v5z'

function pumpSvg(px, fill) {
  return `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="${fill}" aria-hidden="true" style="flex:0 0 auto"><path d="${PUMP_PATH}"/></svg>`
}

// Helper: diesel truck-stop marker (fuel pump glyph in a teal badge) for
// AdvancedMarkerElement content. Visually distinct from the green/red route
// dots and the truck arrow so plotted fuel stops read as a separate layer.
// This is now the *compact* form of createFuelPricePin — kept as its own
// export because it is also what a decluttered pin collapses back to.
export function createFuelStopPin(size = 24, bg = '#0f766e') {
  const el = document.createElement('div')
  el.style.cssText = `display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;background:${bg};border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.35);cursor:pointer;`
  el.innerHTML = pumpSvg(Math.round(size * 0.55), '#fff')
  return el
}

// Per-variant palette. Three states, and the visual distance between them is
// deliberate: green solid = the cheapest diesel on this route, teal outline =
// a real pump price, grey ghost = no published price.
//
// The grey is the load-bearing one. About a third of stops have no Google price
// coverage, so "no price" is the common case, not an edge case — and a muted,
// desaturated, *smaller* chip is the only treatment that can't be mistaken for a
// bargain at a glance. It must never borrow the green.
const FUEL_PIN_STYLES = {
  cheapest: { bg: '#16a34a', border: '#15803d', borderW: 2, fg: '#ffffff', font: 13, dot: '#16a34a' },
  priced: { bg: '#ffffff', border: '#0f766e', borderW: 2, fg: '#0f766e', font: 12, dot: '#0f766e' },
  unpriced: { bg: '#f1f5f9', border: '#cbd5e1', borderW: 1.5, fg: '#94a3b8', font: 11, dot: '#94a3b8' },
}

/**
 * Diesel truck-stop marker carrying its own pump price.
 *
 * The client's complaint was that eight identical green pins force a
 * cross-reference against the sidebar to find the cheap one. So the price rides
 * on the pin, and the cheapest is separated on FOUR channels that don't depend
 * on reading the number: it is filled green rather than outlined, it is larger,
 * it wears a CHEAPEST ribbon, and it pulses a halo at its anchor point. Any one
 * of those survives a zoomed-out screenshot on a phone.
 *
 * `kind` is 'cheapest' | 'priced' | 'unpriced'; `label` is the already-formatted
 * text ("$4.95" / "n/a") — this factory never formats or rounds a price, so the
 * map cannot drift from the list (see lib/fuelStops.js).
 *
 * Returns an element with one mutator, mirroring createTruckArrow's pattern so
 * zoom changes don't tear down and rebuild the marker DOM:
 *   el.setCompact(bool) — collapse to / restore from the bare pump dot
 */
export function createFuelPricePin({ kind = 'priced', label = '', title = '' } = {}) {
  const s = FUEL_PIN_STYLES[kind] || FUEL_PIN_STYLES.priced
  const el = document.createElement('div')
  el.style.cssText = 'position:relative;display:flex;flex-direction:column;align-items:center;cursor:pointer;font-family:"DM Sans",system-ui,sans-serif;'
  if (title) el.title = title

  // Pulsing halo, cheapest only. Sits at the anchor point (the tail tip), behind
  // everything, and is the one cue that reads as motion in peripheral vision.
  let halo = null
  if (kind === 'cheapest') {
    halo = document.createElement('div')
    halo.style.cssText = 'position:absolute;left:50%;bottom:-13px;width:26px;height:26px;margin-left:-13px;border-radius:50%;background:#16a34a;opacity:0.35;pointer-events:none;'
    el.appendChild(halo)
  }

  // One wrapper so a single filter traces the whole ribbon+pill+tail silhouette.
  // A box-shadow on the pill alone would print a seam across the tail's join.
  //
  // The stacked zero-offset white shadows are a halo OUTLINE, the same trick
  // Google's own map labels use, and they are what keeps this legible on a
  // basemap we don't control: the roadmap style renders rural Texas solid green
  // (so a green "cheapest" pill on a green county is the exact case that
  // matters) and this map also offers a `hybrid` satellite layer. A white ring
  // that follows the silhouette separates every variant from whatever is behind
  // it without adding a border that would change the pin's geometry.
  const bubble = document.createElement('div')
  bubble.style.cssText = 'position:relative;display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 0 1px #fff) drop-shadow(0 0 1px #fff) drop-shadow(0 0 1px #fff) drop-shadow(0 1px 3px rgba(0,0,0,0.4));'

  if (kind === 'cheapest') {
    const ribbon = document.createElement('div')
    ribbon.style.cssText = 'padding:1px 5px;margin-bottom:2px;background:#15803d;color:#fff;border-radius:4px;font-size:8.5px;font-weight:800;letter-spacing:0.05em;line-height:1.35;white-space:nowrap;'
    ribbon.textContent = 'CHEAPEST'
    bubble.appendChild(ribbon)
  }

  const pill = document.createElement('div')
  pill.style.cssText = `display:flex;align-items:center;gap:3px;padding:2px 6px;background:${s.bg};border:${s.borderW}px solid ${s.border};border-radius:7px;color:${s.fg};font-size:${s.font}px;font-weight:${kind === 'unpriced' ? 600 : 800};line-height:1.35;white-space:nowrap;font-variant-numeric:tabular-nums;${kind === 'unpriced' ? 'font-style:italic;' : ''}`
  pill.innerHTML = pumpSvg(kind === 'unpriced' ? 10 : 11, s.fg)
  const text = document.createElement('span')
  text.textContent = label
  pill.appendChild(text)
  bubble.appendChild(pill)

  // Rotated square tail, borders on the two exposed faces so the outlined
  // variants keep an unbroken stroke around the silhouette.
  const tail = document.createElement('div')
  tail.style.cssText = `width:8px;height:8px;margin-top:-5px;background:${s.bg};border-right:${s.borderW}px solid ${s.border};border-bottom:${s.borderW}px solid ${s.border};border-radius:0 0 2px 0;transform:rotate(45deg);`
  bubble.appendChild(tail)
  el.appendChild(bubble)

  // Compact fallback: literally the pin this layer shipped with, so a
  // decluttered stop degrades to the old appearance rather than disappearing.
  const dot = createFuelStopPin(kind === 'unpriced' ? 18 : 20, s.dot)
  dot.style.display = 'none'
  el.appendChild(dot)

  let compact = false
  el.setCompact = (v) => {
    const next = !!v
    if (next === compact) return
    compact = next
    bubble.style.display = next ? 'none' : 'flex'
    dot.style.display = next ? 'flex' : 'none'
  }

  // Motion is a cue, not decoration — honour the OS setting rather than pulsing
  // a green ring at someone who asked for stillness.
  const still = typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (halo && !still && typeof halo.animate === 'function') {
    halo.animate(
      [
        { transform: 'scale(0.55)', opacity: 0.45 },
        { transform: 'scale(1.7)', opacity: 0 },
      ],
      { duration: 2000, iterations: Infinity, easing: 'ease-out' },
    )
  }

  return el
}

// Helper: truck marker for AdvancedMarkerElement content.
// Returns a stable element with mutator methods so heading/color/moving
// changes don't tear down and re-mount the DOM on every ping. CSS
// transitions on the arrow's transform produce smooth rotation between
// pings; the previous version baked the rotation into a fresh SVG string,
// which always snapped instantly.
//
// API on the returned element:
//   el.updateHeading(deg, durationMs)  — rotate the arrow over `durationMs`
//   el.updateColor(hex)                — recolor arrow + parked rect
//   el.updateMoving(bool)              — swap between arrow and parked icons
//
// Heading should be the bearing along the road at the driver's projected
// point (see routeHeadingAt in TrackingMap.vue) so the arrow snaps to the
// road and never looks slightly off-axis the way raw GPS heading does.
export function createTruckArrow({ color = '#16a34a', heading = 0, moving = true, size = 22 } = {}) {
  const el = document.createElement('div')
  el.style.cssText = `position:relative;width:${size}px;height:${size}px;cursor:pointer;`

  // Rotating arrow lives in its own wrapper so heading transitions don't
  // drag the unrotated parked-square sibling when the truck is stopped.
  const arrow = document.createElement('div')
  arrow.style.cssText = `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transition:transform 1000ms linear;will-change:transform;transform-origin:50% 50%;`
  arrow.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.35));"><path d="M12 2 L19 20 L12 16 L5 20 Z" fill="${color}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`

  const parked = document.createElement('div')
  parked.style.cssText = `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;`
  parked.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.35));"><rect x="5" y="5" width="14" height="14" rx="3" fill="${color}" stroke="#fff" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="11" font-weight="700" fill="#fff">P</text></svg>`

  el.appendChild(arrow)
  el.appendChild(parked)

  // Accumulate rotation across the 0°/360° seam so CSS interpolates the
  // shortest arc. Without this, a 350°→10° turn would animate the long way
  // round (-340°) instead of the natural +20°.
  let currentRotation = Number.isFinite(heading) ? heading : 0
  arrow.style.transform = `rotate(${currentRotation}deg)`

  let currentMoving = moving !== false
  let currentColor = color

  function applyVisibility() {
    arrow.style.display = currentMoving ? 'flex' : 'none'
    parked.style.display = currentMoving ? 'none' : 'flex'
  }
  applyVisibility()

  el.updateHeading = (next, durationMs = 1000) => {
    if (!Number.isFinite(next)) return
    const delta = (((next - currentRotation) % 360) + 540) % 360 - 180
    if (Math.abs(delta) < 0.5) return
    currentRotation += delta
    arrow.style.transitionDuration = `${Math.max(150, durationMs)}ms`
    arrow.style.transform = `rotate(${currentRotation}deg)`
  }

  el.updateColor = (next) => {
    if (!next || next === currentColor) return
    currentColor = next
    const path = arrow.querySelector('path')
    const rect = parked.querySelector('rect')
    if (path) path.setAttribute('fill', next)
    if (rect) rect.setAttribute('fill', next)
  }

  el.updateMoving = (next) => {
    const v = !!next
    if (v === currentMoving) return
    currentMoving = v
    applyVisibility()
  }

  return el
}
