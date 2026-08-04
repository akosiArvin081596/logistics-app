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

// ---------------------------------------------------------------------------
// DATE-ONLY values ('YYYY-MM-DD') — a different problem from the timestamps above.
//
// `new Date('2026-07-15')` is parsed by JS as UTC MIDNIGHT. Rendering that with
// toLocaleDateString in any timezone BEHIND UTC shows the PREVIOUS day:
//
//   America/Chicago  -> "Jul 14, 2026"   <- what the client reported
//   Asia/Manila      -> "Jul 15, 2026"   <- what we see while developing
//
// So the bug is invisible from this side of the world and wrong for every US
// user. A receipt stored as 2026-07-15 displayed as Jul 14 is what prompted
// "there is something fundamentally wrong with our expense system".
//
// The fix is to never build a Date from a date-only string. These are the
// canonical helpers; the pattern is lifted from VendorLeaderboardTable.vue.
// ---------------------------------------------------------------------------

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** True for a bare 'YYYY-MM-DD' (no time component). */
export function isYmd(v) {
  return YMD_RE.test(String(v || '').trim())
}

/**
 * 'YYYY-MM-DD' → a Date at LOCAL midnight, for the rare caller that needs a
 * Date object (sorting, range comparison). Never round-trips through UTC.
 * Returns null if the input isn't a bare date.
 */
export function parseYmdLocal(v) {
  const s = String(v || '').trim()
  if (!YMD_RE.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return isNaN(dt.getTime()) ? null : dt
}

/**
 * 'YYYY-MM-DD' → "Jul 15, 2026", by string arithmetic only.
 *
 * Mixed-input safe: several callers pass a date-only value on one row and a
 * full ISO timestamp (paid_at, reopened_at) on another. A real timestamp is an
 * instant and SHOULD be converted to the viewer's zone, so it falls through to
 * Date parsing, which is already correct for those.
 */
export function fmtYmd(v, { fallback = '—' } = {}) {
  const s = String(v || '').trim()
  if (!s) return fallback
  if (YMD_RE.test(s)) {
    const [y, m, d] = s.split('-')
    const name = MONTHS[(parseInt(m, 10) || 0) - 1]
    if (!name) return fallback
    return `${name} ${parseInt(d, 10)}, ${y}`
  }
  // Timestamp (or anything else) — an instant, so local conversion is correct.
  const dt = new Date(s)
  return isNaN(dt.getTime())
    ? fallback
    : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * A real instant → "Aug 1, 2026, 8:34 AM" in the viewer's timezone.
 *
 * For upload/created/paid times, NOT for date-only values — pass one of those
 * and you get the previous-day bug this module exists to remove.
 *
 * Use `expenses.timestamp` (ISO with 'Z'), never `expenses.created_at`: SQLite's
 * CURRENT_TIMESTAMP is UTC but serialises with no zone marker, so `new Date()`
 * reads it as local and it lands ~8h out (and rolls the day for anything stamped
 * 00:00-05:59 UTC).
 */
export function fmtTimestamp(v, { fallback = '—' } = {}) {
  const s = String(v || '').trim()
  if (!s) return fallback
  const dt = new Date(s)
  if (isNaN(dt.getTime())) return fallback
  return dt.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}
