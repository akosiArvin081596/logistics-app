// Address display helpers — split a full address into two lines for the UI:
//   line 1 (street)       = street + any suite / C-O / leading-name segments
//   line 2 (cityStateZip) = canonical "City, ST 12345"
//
// IMPORTANT: this is a 1:1 mirror of `splitAddressLines` / `parseOriginDestCity`
// in server.js (the dashboard already ships pre-split _pickupStreet/_pickupLocation;
// this client copy is for surfaces that only have the raw address string, e.g.
// the driver LoadDetail fields). Keep the two in sync.

function parseCityStateZip(addr) {
  if (!addr || typeof addr !== 'string') return { city: '', state: '', zip: '' }
  const t = addr.trim().replace(/,?\s*(USA|United States)\.?\s*$/i, '').trim()
  const z = t.match(/([^,\n]+?),\s*([A-Za-z]{2})\.?\s+(\d{5})(?:-?\d{4})?\s*$/)
  if (z) return { city: z[1].trim(), state: z[2].toUpperCase(), zip: z[3] }
  const n = t.match(/([^,\n]+?),\s*([A-Za-z]{2})\.?\s*$/)
  if (n) return { city: n[1].trim(), state: n[2].toUpperCase(), zip: '' }
  return { city: (t.split(/[,\n]/)[0] || '').trim(), state: '', zip: '' }
}

export function splitAddress(raw) {
  const s = (raw == null ? '' : String(raw)).trim()
  if (!s) return { street: '', cityStateZip: '' }
  const cleaned = s.replace(/,?\s*(USA|United States)\.?\s*$/i, '').trim()
  const p = parseCityStateZip(cleaned)
  const csz = p.city
    ? (p.zip ? `${p.city}, ${p.state} ${p.zip}` : (p.state ? `${p.city}, ${p.state}` : p.city))
    : ''
  const nl = cleaned.search(/\r?\n/)
  if (nl !== -1) {
    const street = cleaned.slice(0, nl).trim().replace(/,\s*$/, '')
    const line2 = csz || cleaned.slice(nl).replace(/^\r?\n/, '').trim()
    return street === line2 ? { street: '', cityStateZip: line2 } : { street, cityStateZip: line2 }
  }
  const tail = cleaned.match(/,\s*([^,]+?),\s*([A-Za-z]{2})\.?(?:\s+\d{5}(?:-?\d{4})?)?\s*$/)
  if (tail && csz) {
    const street = cleaned.slice(0, tail.index).trim().replace(/,\s*$/, '')
    return { street: street && street !== csz ? street : '', cityStateZip: csz }
  }
  if (p.state) return { street: cleaned === csz ? '' : cleaned, cityStateZip: csz }
  return { street: cleaned, cityStateZip: '' }
}
