// The dashboard's load search: one matcher for the Job Board, Active Loads and
// Completed tabs (B19).
//
// GET /api/dashboard attaches `_refs: [{ label, value }]` to each row it serves:
// the broker's Order #, PO #, Move #, the labelled references in Pickup Info /
// Drop-off Info and the BOL number (lib/load-search-refs.js decides what goes in,
// and what a Dispatcher may see). This file decides what matches:
//   - Load ID: a substring of the normalized Load ID, at any query length, so
//     "#X" and "X" find each other.
//   - References: once the normalized query has 4+ characters, a reference
//     matches when its normalized form, or that form without leading zeros,
//     starts with the query or the query without leading zeros. Never a match in
//     the middle of a value.
// A row found through a reference names it, so the tab can show a chip
// ("Order # 7000002") under the Load ID.
//
// normalizeRef() is the server's rule, character for character; the runner
// scripts/test-load-search-client.mjs compares the two on one case table.

const MIN_REF_QUERY = 4

export const SEARCH_PLACEHOLDER = 'Search load, order, PO, move or ref #'
export const SEARCH_PLACEHOLDER_PHONE = 'Load or ref #'

export function normalizeRef(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[#\s.-]/g, '')
}

function withoutLeadingZeros(s) {
  return s.replace(/^0+/, '')
}

// null (no match), { via: null } (the Load ID matched) or
// { via: { label, value } } (the first reference that matched).
export function matchLoad(row, q, loadIdCol) {
  if (!row || typeof row !== 'object') return null
  const nq = normalizeRef(q)
  if (!nq) return { via: null }
  if (loadIdCol && normalizeRef(row[loadIdCol]).includes(nq)) return { via: null }
  if (nq.length < MIN_REF_QUERY || !Array.isArray(row._refs)) return null
  const nqz = withoutLeadingZeros(nq)
  // The query without its zeros only when it still has 4+ characters, so "0000"
  // or "0001" never matches every value starting with nothing or "1".
  const queries = nqz !== nq && nqz.length >= MIN_REF_QUERY ? [nq, nqz] : [nq]
  for (const ref of row._refs) {
    if (!ref || ref.value == null) continue
    const n = normalizeRef(ref.value)
    if (!n) continue
    const nz = withoutLeadingZeros(n)
    if (queries.some((qq) => n.startsWith(qq) || (nz !== '' && nz.startsWith(qq)))) {
      return { via: { label: String(ref.label == null ? '' : ref.label), value: String(ref.value) } }
    }
  }
  return null
}

// The rows a tab shows for a query, in order, and the reference each row was
// found by (a Map keyed by row; rows found by Load ID have no entry).
export function searchLoads(rows, q, loadIdCol) {
  const list = Array.isArray(rows) ? rows : []
  const via = new Map()
  if (!normalizeRef(q)) return { rows: list, via }
  const out = []
  for (const row of list) {
    const m = matchLoad(row, q, loadIdCol)
    if (!m) continue
    out.push(row)
    if (m.via) via.set(row, m.via)
  }
  return { rows: out, via }
}

export function refChipText(via) {
  return via ? `${via.label} ${via.value}` : ''
}
