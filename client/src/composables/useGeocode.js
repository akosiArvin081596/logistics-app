const cache = new Map()

export function useGeocode() {
  async function reverseGeocode(lat, lng) {
    const key = `r:${lat.toFixed(5)},${lng.toFixed(5)}`
    if (cache.has(key)) return cache.get(key)
    try {
      const res = await fetch(`/api/geocode?lat=${lat}&lng=${lng}`)
      if (!res.ok) return null
      const data = await res.json()
      if (data.status !== 'OK' || !data.results?.length) return null
      const comp = data.results[0].address_components || []
      const result = {
        displayName: data.results[0].formatted_address || '',
        city: comp.find(c => c.types.includes('locality'))?.long_name || '',
        state: comp.find(c => c.types.includes('administrative_area_level_1'))?.short_name || '',
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
      const res = await fetch(`/api/geocode/search?q=${encodeURIComponent(query.trim())}`)
      if (!res.ok) return []
      const data = await res.json()
      const results = data.results || []
      cache.set(key, results)
      return results
    } catch {
      return []
    }
  }

  return { reverseGeocode, searchAddress }
}
