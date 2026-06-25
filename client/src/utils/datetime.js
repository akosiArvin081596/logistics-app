/**
 * Date/time helpers for sheet-sourced timestamps.
 *
 * WHY: The server stamps the "Completion Date" sheet column as a UTC wall-clock
 * string with NO 'Z'/zone (e.g. "6/24/2026 14:31:58", built from new Date()
 * getters on the UTC VPS). `new Date("6/24/2026 14:31:58")` parses slash-format
 * as LOCAL time, so it echoes the UTC wall-clock verbatim and never converts to
 * the viewer's zone. We re-interpret that string as UTC so this column matches
 * StatusTimeline.vue, which renders the true UTC instant from
 * load_status_history (served as ISO `...Z`).
 */

/**
 * Parse a sheet timestamp, treating the bare slash-format string as UTC.
 * "6/24/2026 14:31:58" → the instant 2026-06-24T14:31:58Z.
 * Anything else (date-only, AM/PM, ISO, blank) falls back to `new Date(v)`.
 * Returns null for an Invalid Date.
 */
export function parseSheetUtc(v) {
  const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  let d
  if (m) {
    const [, mo, day, year, hour, minute, seconds] = m
    d = new Date(Date.UTC(+year, +mo - 1, +day, +hour, +minute, +(seconds || 0)))
  } else {
    d = new Date(v)
  }
  return isNaN(d.getTime()) ? null : d
}

/**
 * Format a sheet "Completion Date" as the viewer-local delivered time, with a
 * short zone label — mirrors StatusTimeline.vue's `fmt` so the two surfaces
 * align by construction. Empty → "—"; unparseable → the raw string.
 */
export function formatDeliveredLocal(v) {
  if (!v || !String(v).trim()) return '—'
  const d = parseSheetUtc(v)
  if (!d || isNaN(d.getTime())) return String(v)
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).format(d)
}
