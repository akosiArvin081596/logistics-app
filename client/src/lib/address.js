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

// ---------------------------------------------------------------------------
// Job Tracking `Details` — route or commodity?
// ---------------------------------------------------------------------------
// `Details` is supposed to carry the COMMODITY ("12x32 DAIRY PURE WholeMilk,
// 43,764 lbs, 1,575 Case(s)"), which is what the Gemini rate-con prompt defines
// it as and what the drag-and-drop path (POST /api/loads/from-ratecon) writes.
// The n8n email path overwrote it with a ROUTE string ("Tulsa, OK 74134 -
// JOPLIN, MO 64803") on every ingest, so production carries BOTH shapes today:
// 324 of 344 populated rows are route-shaped and the rest are real commodities.
// The overwrite is being stopped, but the ~324 historical rows are unrecoverable
// and stay in the sheet forever — so every reader has to handle the mix.
//
// ⚠️ These helpers exist because the readers used to split `Details` on a bare
// hyphen with NO test of what they were splitting. Feed that a commodity and it
// yields "12x32 DAIRY PURE WholeMilk, 43,764 lbs" as an origin city — which then
// rode into the driver's load-assigned notification via POST /api/dispatch.

// US states + DC + territories, and the Canadian provinces (Bison and other
// cross-border brokers do run into Canada). Matching against the real code set,
// rather than any two letters, is what makes the route test discriminate: it is
// the difference between rejecting "…, 540 Units" and accepting "…, MO 64803".
const REGION_CODES = new Set(
  ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO ' +
   'MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY ' +
   'DC PR VI GU AS MP ' +
   'AB BC MB NB NL NS NT NU ON PE QC SK YT').split(' ')
)

// One side of a route: "…, OK 74134" / "…, OK, 74134" / "…, MO".
//
// Anchored at the END, and the region code must be preceded by a comma or
// whitespace. Both halves of that are load-bearing:
//   - anchoring rejects "Tarps, IN transit" (IN is Indiana, but it is mid-string)
//   - the boundary rejects "43,764 lbs" (the trailing "bs" is preceded by "l")
// The optional ZIP tail accepts BOTH separators because production holds both
// writers' formats: lib/ratecon-load.js emits "City, ST 12345" and the retired
// n8n LLM emitted "City, ST, 12345".
const ROUTE_SIDE_RE = /(?:^|[\s,])([A-Za-z]{2})\.?(?:[\s,]+\d{5}(?:-\d{4})?)?\s*$/

// ⚠️ Requires whitespace on BOTH sides of the separator. A bare /\s*-\s*/ —
// what LoadCard, LoadDetail and the dashboard store all used — also splits
// inside a hyphenated city ("Winston-Salem, NC 27101 - Dallas, TX 75201" gives
// three parts), and inside ordinary commodity prose.
const ROUTE_SEP_RE = /\s+[-–—→]\s+/

function routeSideIsPlace(part) {
  const s = (part || '').trim()
  if (!s) return false
  const m = s.match(ROUTE_SIDE_RE)
  return Boolean(m && REGION_CODES.has(m[1].toUpperCase()))
}

// Split a `Details` value into { origin, destination } — or null when it is not
// a route. Deliberately strict: BOTH sides must resolve to a real place, so a
// commodity can never be mistaken for a lane. Returning null is the safe answer
// because every caller has the address columns to fall back on.
export function splitRoute(raw) {
  const s = (raw == null ? '' : String(raw)).trim()
  if (!s) return null
  const parts = s.split(ROUTE_SEP_RE)
  if (parts.length !== 2) return null
  const [origin, destination] = parts.map((p) => p.trim())
  if (!routeSideIsPlace(origin) || !routeSideIsPlace(destination)) return null
  return { origin, destination }
}

export function looksLikeRoute(raw) {
  return splitRoute(raw) !== null
}

// 1:1 mirror of pickAddressColumn() in server.js. Prefers a real "*Address"
// column, then any non-meta column on that side — never an "*Info" column,
// which on Job Tracking carries broker references like
// "Brothers WMS RDC - MPS REF/PU#: 29284990", not an address.
export function pickAddressColumn(headers, sideRe) {
  const notMeta = (h) => !/lat|lng|lon|date|time|appt|eta/i.test(h)
  return (headers || []).find((h) => sideRe.test(h) && /address/i.test(h) && notMeta(h))
    || (headers || []).find((h) => sideRe.test(h) && notMeta(h) && !/info|reference|appointment/i.test(h))
    || null
}

const ORIGIN_COL_RE = /origin|pickup|shipper/i
const DEST_COL_RE = /dest|drop|receiver|delivery|consignee/i

// Resolve a load's { origin, destination } for display and for the dispatch
// notification. ONE resolver for every surface, in strict order of trust:
//
//   1. `_pickupLocation` / `_dropLocation` — server-computed by
//      resolveAddressParts(), which prefers the geocoded load_coordinates row
//      over the sheet cell. Present on every /api/dashboard job row.
//   2. The real address columns, reduced to their "City, ST ZIP" line. This is
//      what the driver surfaces have; they get no server enrichment.
//   3. A route-shaped `Details`, per side, as a LAST resort — it is the only
//      source for the handful of loads whose address cell was never filled
//      (e.g. 550303758, whose Drop-off Address is empty to this day).
//
// A commodity-shaped `Details` contributes nothing at any step, by design.
export function resolveLoadRoute(load, headers) {
  const l = load || {}
  const hdrs = headers || []

  let origin = String(l._pickupLocation || '').trim()
  let destination = String(l._dropLocation || '').trim()

  if (!origin) {
    const col = pickAddressColumn(hdrs, ORIGIN_COL_RE)
    if (col) {
      const p = splitAddress(l[col])
      origin = p.cityStateZip || p.street || ''
    }
  }
  if (!destination) {
    const col = pickAddressColumn(hdrs, DEST_COL_RE)
    if (col) {
      const p = splitAddress(l[col])
      destination = p.cityStateZip || p.street || ''
    }
  }

  if (!origin || !destination) {
    const detailsCol = hdrs.find((h) => /details/i.test(h))
    const r = detailsCol ? splitRoute(l[detailsCol]) : null
    if (r) {
      if (!origin) origin = r.origin
      if (!destination) destination = r.destination
    }
  }

  return { origin, destination }
}

// Display string for the driver load surfaces. "" when nothing is known, so the
// caller can hide the line rather than render a pair of em-dashes.
export function formatLoadRoute(load, headers) {
  const { origin, destination } = resolveLoadRoute(load, headers)
  if (!origin && !destination) return ''
  return `${origin || '—'} → ${destination || '—'}`
}
