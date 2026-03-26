const cache = new Map()
let lastRequestTime = 0

async function rateLimitedFetch(url) {
  const now = Date.now()
  const wait = Math.max(0, 1100 - (now - lastRequestTime))
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestTime = Date.now()
  const res = await fetch(url)
  if (!res.ok) return null
  return res.json()
}

export function useGeocode() {
  async function reverseGeocode(lat, lng) {
    const key = `r:${lat.toFixed(5)},${lng.toFixed(5)}`
    if (cache.has(key)) return cache.get(key)
    try {
      const data = await rateLimitedFetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`
      )
      if (!data || data.error) return null
      const addr = data.address || {}
      const result = {
        displayName: data.display_name || '',
        city: addr.city || addr.town || addr.municipality || addr.village || '',
        state: addr.state || '',
      }
      cache.set(key, result)
      return result
    } catch {
      return null
    }
  }

  async function searchAddress(query) {
    if (!query || query.trim().length < 3) return []
    const key = `s:${query.trim().toLowerCase()}`
    if (cache.has(key)) return cache.get(key)
    try {
      const data = await rateLimitedFetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query.trim())}`
      )
      if (!data || !Array.isArray(data)) return []
      const results = data.map((item) => ({
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon),
        displayName: item.display_name || '',
      }))
      cache.set(key, results)
      return results
    } catch {
      return []
    }
  }

  return { reverseGeocode, searchAddress }
}
