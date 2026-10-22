// The Super Admin "Deleted loads" page and its link on Active Loads: display
// only. GET /api/admin/deleted-loads sends every figure (the months, whether
// each is closed); nothing here works one out. The server's role gate is the
// real control; canSeeDeletedLoads() only keeps the link and page from
// rendering for anyone else.
//
// Pure: no Vue, no network. The '.js' on the import is deliberate, so bare Node
// (scripts/test-deleted-loads-view.mjs) can import this file as well as Vite.

import { monthLabel } from './monthLabel.js'

export const DELETED_LOADS_ROLE = 'Super Admin'

// May this role see the link and the page?
export function canSeeDeletedLoads(role) {
  return role === DELETED_LOADS_ROLE
}

// "Deleted loads (3)"; plain "Deleted loads" while the count is unknown (still
// loading, or the list could not be read).
export function deletedLoadsLinkText(count) {
  return Number.isInteger(count) && count >= 0 ? `Deleted loads (${count})` : 'Deleted loads'
}

// "Springfield, IL 62701 → Riverton, WY 82501"; a missing side reads "—", and
// "—" alone when neither side is known.
export function deletedLoadRoute(load) {
  const pickup = String(load?.pickup || '').trim()
  const dropoff = String(load?.dropoff || '').trim()
  if (!pickup && !dropoff) return '—'
  return `${pickup || '—'} → ${dropoff || '—'}`
}

// One line per settlement month: { key, label: 'May 2026', closed, closedText: 'Yes' | 'No' }.
export function deletedLoadMonths(load) {
  const months = Array.isArray(load?.months) ? load.months : []
  return months.map((m) => ({
    key: String(m?.month || ''),
    label: monthLabel(m?.month) || String(m?.month || '—'),
    closed: m?.closed === true,
    closedText: m?.closed === true ? 'Yes' : 'No',
  }))
}

// Where the months came from, when it isn't the load's Job Tracking row.
export function deletedLoadMonthsNote(load) {
  return load?.monthsFrom === 'audit' ? 'From the delete record' : ''
}

// The page's error line: the server's own words for the two "can't read it"
// answers, otherwise a plain fallback.
export function deletedLoadsErrorText(err) {
  const code = err?.code || ''
  if ((code === 'SHEET_UNREADABLE' || code === 'PERIOD_LOCK_UNREADABLE') && err?.message) return err.message
  if (err?.status === 403) return 'Only a Super Admin can see deleted loads.'
  return 'The deleted loads could not be loaded. Try again in a moment.'
}
