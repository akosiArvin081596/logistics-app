// How old a truck's last position fix is, and what a tracking view may show
// from it (B11, owner decision 2026-10-15):
//   - a fix older than 30 minutes shows its age: "Last seen 3 h ago";
//   - a fix older than 2 hours shows no distance and no ETA, because both would
//     be measured from where the truck was, not where it is.
// The dispatch tracking map, the load-detail map and the customer tracking page
// read these; GET /api/public/track/:loadId withholds its ETA by the same
// 2-hour rule. An age is relative, so no time zone is involved.
import { formatAgeMs } from './duration.js'

export const LAST_SEEN_AFTER_MS = 30 * 60 * 1000
export const NO_ETA_AFTER_MS = 2 * 60 * 60 * 1000

// The age (ms) at `now` of a fix taken at `at`: an ISO instant, epoch ms or a
// Date. null when `at` is missing or unreadable. A fix stamped a little ahead of
// this clock is 0 old.
export function fixAgeMs(at, now = Date.now()) {
  if (at == null || at === '') return null
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(String(at))
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return null
  return Math.max(0, now - ms)
}

// "Last seen 3 h ago" for a fix older than 30 minutes; '' for a newer one or
// an unknown age.
export function lastSeenText(ageMs) {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs <= LAST_SEEN_AFTER_MS) return ''
  return `Last seen ${formatAgeMs(ageMs)} ago`
}

// May a distance or an ETA measured from this fix be shown? Only when the fix
// is at most 2 hours old; never for an unknown age.
export function fixAllowsEta(ageMs) {
  return ageMs != null && Number.isFinite(ageMs) && ageMs <= NO_ETA_AFTER_MS
}
