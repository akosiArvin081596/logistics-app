/**
 * Date/time helpers for sheet-sourced timestamps.
 *
 * WHY: the server stamps "Status Update Date" / "Completion Date" as a bare
 * wall-clock string with NO 'Z' and no zone marker (e.g. "6/24/2026 14:31:58").
 * `new Date("6/24/2026 14:31:58")` parses slash-format as LOCAL time, so it
 * echoes the wall clock verbatim and never converts to the viewer's zone. To
 * render it correctly we have to know WHICH zone that wall clock was written in
 * — and the answer changed on 2026-08-04.
 *
 * TWO ERAS, one identical string shape:
 *
 *   BEFORE the cutover — built from new Date() getters on a UTC VPS, so the
 *   string is a UTC wall clock. A load delivered 7 PM Houston on Jun 30 was
 *   stamped "07/01/2026 00:12:00". 23 of 268 production status changes are
 *   mis-dated this way, which is what put $1,100 of June revenue into July.
 *
 *   AFTER the cutover — the server stamps Houston (America/Chicago) time, so
 *   the date part is the real business day. See houstonStamp() in server.js.
 *
 * Historical rows are deliberately NOT rewritten (client decision 2026-08-04:
 * no restatement of closed months), so both eras coexist in the sheet forever
 * and this module is the thing that tells them apart.
 */

const HOUSTON = 'America/Chicago'

/**
 * The date the stamps switched from UTC to Houston. MUST match
 * SHEET_STAMP_TZ_CUTOVER in server.js.
 *
 * Compared against the stamp's own DATE PART, not a parsed instant: the two
 * eras differ by only 5-6 hours, so an instant comparison is ambiguous for
 * values written near the boundary, whereas the date part is a plain compare.
 * Values written ON the cutover day itself may be read as the wrong era — a
 * display-only fuzz limited to a single day. It cannot reach a money figure,
 * but NOT for the comforting reason: it is because the money paths
 * (parseSheetDate / parseInvoiceDate on the server) never consult this constant
 * at all. They read the stamp's date part verbatim, so era misclassification is
 * invisible to them.
 *
 * The flip side, stated plainly because it is easy to misread the above as
 * "therefore the money is right": for PRE-cutover rows the date part is itself
 * the wrong Houston day — that IS the original bug — and the money paths read
 * it verbatim. Those rows are deliberately left wrong (client decision
 * 2026-08-04: no restatement of closed months). So this module can make the
 * Completed-Loads display and CSV show the corrected day for a legacy evening
 * load while the P&L still counts it on the old one. That divergence is
 * intentional, not a bug to "fix" by touching history.
 */
export const SHEET_STAMP_TZ_CUTOVER = '2026-08-03'

/** Milliseconds `timeZone` is ahead of UTC at a given instant (DST-aware). */
function tzOffsetMs(instantMs, timeZone) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(new Date(instantMs))
    .reduce((acc, part) => ((acc[part.type] = part.value), acc), {})
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instantMs
}

/**
 * A Houston wall clock → the true instant. Two correction passes: the first
 * offset is looked up at the wrong instant, which only matters within the
 * one-hour DST seam, and the second pass settles it.
 */
function houstonWallClockToInstant(y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  let ms = guess - tzOffsetMs(guess, HOUSTON)
  ms = guess - tzOffsetMs(ms, HOUSTON)
  return new Date(ms)
}

/**
 * Parse a bare sheet stamp into a true instant, picking the era by its date.
 * "6/24/2026 14:31:58" → 14:31:58 UTC (legacy) or 14:31:58 Houston (current).
 * Anything else (date-only, AM/PM, ISO, blank) falls back to `new Date(v)`.
 * Returns null for an Invalid Date.
 *
 * Named for what it does rather than one of its two eras — it was previously
 * `parseSheetUtc`, which is now only half true and would mislead the next
 * reader into "re-fixing" correctly-stamped rows.
 */
export function parseSheetStamp(v) {
  const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  let d
  if (m) {
    const [, mo, day, year, hour, minute, seconds] = m
    const ymd = `${year}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    d = ymd >= SHEET_STAMP_TZ_CUTOVER
      ? houstonWallClockToInstant(+year, +mo, +day, +hour, +minute, +(seconds || 0))
      : new Date(Date.UTC(+year, +mo - 1, +day, +hour, +minute, +(seconds || 0)))
  } else {
    d = new Date(v)
  }
  return isNaN(d.getTime()) ? null : d
}

/**
 * The Houston calendar day ("YYYY-MM-DD") a sheet stamp falls on — the business
 * day, since the carrier is Houston-based. Post-cutover this is just the date
 * part; pre-cutover the UTC stamp has to be converted first.
 */
export function sheetStampHoustonDay(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) {
    const ymd = `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
    // Already a Houston date — return it verbatim rather than round-tripping
    // through an instant, which is where an off-by-one day comes from.
    if (ymd >= SHEET_STAMP_TZ_CUTOVER) return ymd
  }
  const d = parseSheetStamp(s)
  if (!d) return ''
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: HOUSTON, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

/**
 * Format a sheet "Completion Date" as the viewer-local delivered time, with a
 * short zone label — mirrors StatusTimeline.vue's `fmt` so the two surfaces
 * align by construction. Empty → "—"; unparseable → the raw string.
 */
export function formatDeliveredLocal(v) {
  if (!v || !String(v).trim()) return '—'
  const d = parseSheetStamp(v)
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
