/**
 * Date/time helpers.
 *
 * THE RULE, agreed with the client 2026-08-04 — "I will be assuming that all
 * time and date are Houston time":
 *
 *   • A value that CARRIES A ZONE (ISO '…Z', a '±HH:MM' offset) is a real
 *     INSTANT → render it in America/Chicago, WITH a zone label.
 *   • A value that is a BARE WALL CLOCK ("7/1/2026 4:16:50") has no zone and no
 *     instant → print it EXACTLY as written, with no label.
 *   • Never the viewer's timezone.
 *
 * The label is what keeps a pinned time honest for someone outside Houston, so
 * never pin without labelling. And never attach a zone label to a bare wall
 * clock — claiming "CDT" over a legacy UTC stamp is a confident lie.
 *
 * WHY bare wall clocks exist at all: the server writes "Status Update Date" /
 * "Completion Date" into the sheet as plain text with no zone marker, and the
 * meaning of that text changed on 2026-08-03:
 *
 *   BEFORE — built from new Date() getters on a UTC VPS, so the string is a UTC
 *   wall clock. A load delivered 7 PM Houston on Jun 30 was stamped
 *   "07/01/2026 00:12:00".
 *
 *   ON/AFTER — the server stamps Houston time (see houstonStamp() in server.js),
 *   so the text is already the business day.
 *
 * Historical rows are deliberately NOT rewritten (client rule: "if it is already
 * closed and locked by the month then follow that date"), so both eras coexist
 * forever. Crucially the DAY is now taken verbatim everywhere — screen, CSV and
 * the money paths all read the date part as written, so they cannot disagree.
 * See the note above sheetSortKey before adding any day-converting helper.
 *
 * A SECOND RULE, for calendar dates and "today" (the owner, 2026-10-08): a bare
 * 'YYYY-MM-DD' is a calendar date and is never moved through a zone, and where an
 * instant has to become a day, or for "today", the zone is APP_TIMEZONE, the one
 * setting the server sends. See the APP_TIMEZONE section at the bottom. The
 * Houston-pinned helpers in this file keep their pin until the owner decides
 * whether they move to APP_TIMEZONE.
 */

const HOUSTON = 'America/Chicago'

/**
 * The date the stamps switched from UTC to Houston.
 *
 * Deliberately NOT exported: only parseSheetStamp consults it, and only to
 * resolve a bare wall clock to a true INSTANT for ETA math. No day/month
 * bucketing anywhere — client or server — depends on it, because day derivation
 * is literal on both sides. (server.js had a mirrored copy; it was removed once
 * sheetDayKey became literal, so there is nothing left to keep in sync.)
 */
const SHEET_STAMP_TZ_CUTOVER = '2026-08-03'

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// A bare wall clock: "M/D/YYYY H:MM[:SS]" or "M/D/YYYY, h:mm:ss AM". No zone.
const WALL_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i

/**
 * Does this value carry its own timezone? Only these may be converted.
 * ISO '…Z', an explicit '±HH:MM'/'±HHMM' offset, or a GMT/UTC marker.
 */
export function isZoned(v) {
  const s = String(v || '').trim()
  if (!s) return false
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(s) || /\b(GMT|UTC)\b/i.test(s)
}

// One formatter per zone, built on first use and kept: building an
// Intl.DateTimeFormat costs far more than using one, and a list can send every
// row through here (Houston, plus the APP_TIMEZONE section at the bottom).
const PARTS_FORMATTERS = new Map()

/** An instant's wall clock in `timeZone`, as strings: { year: '2026', month: '09', day: '28', hour: '23', … }. */
function zonedParts(instantMs, timeZone) {
  let f = PARTS_FORMATTERS.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    })
    PARTS_FORMATTERS.set(timeZone, f)
  }
  return f.formatToParts(new Date(instantMs)).reduce((acc, part) => ((acc[part.type] = part.value), acc), {})
}

/** Milliseconds `timeZone` is ahead of UTC at a given instant (DST-aware). */
function tzOffsetMs(instantMs, timeZone) {
  const p = zonedParts(instantMs, timeZone)
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instantMs
}

/**
 * A wall clock in `timeZone` → the true instant. Two correction passes: the
 * first offset is looked up at the wrong instant, which only matters within the
 * one-hour DST seam, and the second pass settles it.
 */
function wallClockToInstant(timeZone, y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  let ms = guess - tzOffsetMs(guess, timeZone)
  ms = guess - tzOffsetMs(ms, timeZone)
  return new Date(ms)
}

/**
 * Resolve a bare sheet stamp to a true INSTANT, picking the era by its date.
 *
 * NARROW PURPOSE: genuine instant math only — ETA arithmetic, and durations.
 * Do NOT use it to derive a day, a month, or anything a figure is bucketed by:
 * every such derivation is literal now, and converting here would put this
 * surface a day out from the accounting. Use fmtSheetMoment to display and
 * sheetSortKey to order.
 */
export function parseSheetStamp(v) {
  const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  let d
  if (m) {
    const [, mo, day, year, hour, minute, seconds] = m
    const ymd = `${year}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    d = ymd >= SHEET_STAMP_TZ_CUTOVER
      ? wallClockToInstant(HOUSTON, +year, +mo, +day, +hour, +minute, +(seconds || 0))
      : new Date(Date.UTC(+year, +mo - 1, +day, +hour, +minute, +(seconds || 0)))
  } else {
    d = new Date(v)
  }
  return isNaN(d.getTime()) ? null : d
}

// NOTE: sheetStampHoustonDay() and formatDeliveredLocal() both lived here and
// were deleted on purpose. Each converted a legacy stamp to its "true" Houston
// day/time, which made the Completed Loads screen disagree with the P&L for
// pre-cutover evening loads — the money paths read the date part verbatim.
// formatDeliveredLocal was the more dangerous of the two: zero callers, but
// named exactly what the next person would reach for to render a delivery time.
// Do not reintroduce a day-converting helper without changing the accounting to
// match, or the two drift apart again.

/**
 * THE display helper for any moment: a sheet cell, an ISO timestamp, either.
 *
 *   zoned  ("2026-08-04T13:05:07Z")  → "Aug 4, 2026, 8:05 AM CDT"   (Houston + label)
 *   bare   ("08/04/2026 8:05:07")    → "8/4/2026, 8:05 AM"          (verbatim, no label)
 *   date-only ("2026-08-04")         → "Aug 4, 2026"                (verbatim)
 *
 * The split is the whole point. Converting a bare wall clock would shift it by
 * the Houston offset — and for a post-cutover stamp, which is ALREADY Houston,
 * that is a second conversion that rolls an evening delivery back a day.
 */
export function fmtSheetMoment(v, { fallback = '—' } = {}) {
  const s = String(v || '').trim()
  if (!s) return fallback

  if (isZoned(s)) {
    const dt = new Date(s)
    if (isNaN(dt.getTime())) return s
    return new Intl.DateTimeFormat('en-US', {
      timeZone: HOUSTON,
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
    }).format(dt)
  }

  if (YMD_RE.test(s)) {
    const [y, m, d] = s.split('-')
    const name = MONTHS[(parseInt(m, 10) || 0) - 1]
    return name ? `${name} ${parseInt(d, 10)}, ${y}` : s
  }

  const m = s.match(WALL_RE)
  if (!m) return s
  const [, mo, day, yr, hh, mi, , ap] = m
  if (hh == null) return `${+mo}/${+day}/${yr}`
  let h = +hh
  if (ap) { const up = ap.toUpperCase(); if (up === 'PM' && h < 12) h += 12; if (up === 'AM' && h === 12) h = 0 }
  const suffix = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${+mo}/${+day}/${yr}, ${h12}:${mi} ${suffix}`
}

/**
 * A secondary "(PH Time: …)" line, for a viewer who is not in Houston.
 *
 * Keyed on the BROWSER'S timezone, never on the account or role — the owner in
 * Houston and the developer in Manila SHARE one super_admin login, so an
 * account-scoped setting would leak between them. They do not share a device.
 *
 * Returns '' for a Houston viewer, so his UI is untouched.
 *
 * Only meaningful for a ZONED value: a bare wall clock carries no instant, so
 * there is no other zone to express it in. Returning '' there is not a
 * limitation — inventing an equivalent would mean guessing which zone the bare
 * text was written in, which is the bug this module exists to prevent.
 *
 * Presentational only. Keep it OUT of the primary formatter, or it leaks into
 * the CSV export and generated PDFs.
 */
export function viewerZoneNote(v) {
  const s = String(v || '').trim()
  if (!s || !isZoned(s)) return ''
  const dt = new Date(s)
  if (isNaN(dt.getTime())) return ''

  let viewerTz = ''
  try { viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' }
  if (!viewerTz || viewerTz === HOUSTON) return ''

  const label = viewerTz === 'Asia/Manila' ? 'PH Time' : 'Your time'
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: viewerTz,
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(dt)
  return `(${label}: ${when})`
}

/**
 * A comparable key for ordering, derived the SAME way the value is displayed —
 * so a sorted table is always in the order of the column you can actually see.
 *
 * It used to sort by parseSheetStamp's resolved instant while the column showed
 * the literal clock. Those agree within one era but not across the 2026-08-03
 * boundary, so the table could be ordered by something no one could read.
 *
 * Zoned values are keyed on their HOUSTON rendering, matching fmtSheetMoment.
 * Blank/unparseable sort last under a descending sort.
 */
export function sheetSortKey(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  const pad = (n, w = 2) => String(n).padStart(w, '0')

  if (isZoned(s)) {
    const dt = new Date(s)
    if (isNaN(dt.getTime())) return ''
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: HOUSTON,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(dt).reduce((acc, x) => ((acc[x.type] = x.value), acc), {})
    return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`
  }

  if (YMD_RE.test(s)) return s.replace(/-/g, '') + '000000'

  const m = s.match(WALL_RE)
  if (!m) return ''
  const [, mo, day, yr, hh, mi, ss, ap] = m
  let h = hh == null ? 0 : +hh
  if (ap) { const up = ap.toUpperCase(); if (up === 'PM' && h < 12) h += 12; if (up === 'AM' && h === 12) h = 0 }
  return `${yr}${pad(mo)}${pad(day)}${pad(h)}${pad(mi || 0)}${pad(ss || 0)}`
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
// The fix is to never build a Date from a date-only string.
// ---------------------------------------------------------------------------

/**
 * Today's date in HOUSTON as 'YYYY-MM-DD' — the business day.
 *
 * For form defaults and filter bounds, i.e. values that get STORED or that
 * decide which records are counted. Those are exactly where "whose today?" has
 * a real answer: the carrier's, not the person typing.
 *
 * These sites used `new Date().toLocaleDateString('en-CA')`, the VIEWER's day.
 * That was already an improvement on toISOString() (the UTC day, which after
 * 7 PM Houston is tomorrow) — but it is still wrong for anyone not in Houston,
 * and this login is shared across two countries. At 3 PM Houston it is already
 * the NEXT day in Manila, so a form there pre-filled a date the business has
 * not reached yet, onto a stored expense or load.
 */
export function houstonToday(now = Date.now()) {
  // `now` (epoch ms or a Date) pins the moment, as appToday(now) does below.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: HOUSTON, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now))
}

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
 * Mixed-input safe: several callers pass a date-only value on one row and a full
 * ISO timestamp (paid_at, reopened_at) on another. A real timestamp is an
 * instant, so it is rendered in HOUSTON — not the viewer's zone, per the rule at
 * the top of this file.
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
  // Not a bare 'YYYY-MM-DD'. If it carries no zone either, it is a wall clock
  // and must NOT go through new Date() — see the guard note in fmtTimestamp.
  if (!isZoned(s)) return fmtSheetMoment(s, { fallback })
  const dt = new Date(s)
  return isNaN(dt.getTime())
    ? fallback
    : new Intl.DateTimeFormat('en-US', {
        timeZone: HOUSTON, month: 'short', day: 'numeric', year: 'numeric',
      }).format(dt)
}

/**
 * A real instant → "Aug 1, 2026, 8:34 AM CDT" in HOUSTON time.
 *
 * Houston, not the viewer's zone: the owner reads every timestamp in this app as
 * Houston time, and a surface that quietly renders in the reader's own zone makes
 * that assumption false — silently, and only for people outside Houston. The
 * zone label is required, not decoration; it is what stops the pinned value from
 * misleading a reader who is somewhere else.
 *
 * For upload/created/paid times, NOT for date-only values — pass one of those and
 * you get the previous-day bug this module exists to remove.
 *
 * Use `expenses.timestamp` (ISO with 'Z'), never a raw `created_at`: SQLite's
 * CURRENT_TIMESTAMP is UTC but serialises with no zone marker, so `new Date()`
 * reads it as local and it lands hours out. Endpoints wrap those with
 * strftime('%Y-%m-%dT%H:%M:%SZ', …) — if a field renders oddly, check that first.
 */
export function fmtTimestamp(v, { fallback = '—' } = {}) {
  const s = String(v || '').trim()
  if (!s) return fallback

  // GUARD — do not let a bare wall clock reach new Date().
  //
  // Pinning the OUTPUT to Houston is not sufficient on its own, because the
  // INPUT parse is viewer-dependent: JS reads "08/04/2026 8:05:07" as LOCAL
  // time, so the same cell becomes a different instant in Houston than in
  // Manila, and rendering that in Houston then yields two different answers
  // (measured: "Aug 4, 8:05 AM CDT" vs "Aug 3, 7:05 PM CDT" — a day apart).
  //
  // The docstring below has always said "not for sheet cells", but nothing
  // enforced it, and one stray caller would have reintroduced exactly the
  // viewer-dependence this file exists to remove. A bare value now takes the
  // verbatim path instead, which is correct for it by definition.
  if (!isZoned(s)) return fmtSheetMoment(s, { fallback })

  const dt = new Date(s)
  if (isNaN(dt.getTime())) return fallback
  return new Intl.DateTimeFormat('en-US', {
    timeZone: HOUSTON,
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).format(dt)
}

/**
 * fmtArrivalClock — when a truck is projected to reach the receiver.
 *   1755203100000        -> "Aug 14, 3:45 PM CDT"
 *   "2026-08-15T20:45:00Z" -> "Aug 15, 3:45 PM CDT"
 *   with { weekday: true }  -> "Fri, Aug 15, 3:45 PM CDT"
 *
 * Deliberately NOT fmtTimestamp: an ETA is a near-future instant, so the year is
 * noise, and this one also takes an epoch (the arrival clocks derive one from
 * etaMinutes rather than receiving a string).
 *
 * The weekday is opt-in because a multi-day haul's "Aug 16, 6:00 AM" is read off
 * a screen and relayed by phone — the day name is what stops it being heard as
 * today. The default omits it so the two pre-existing arrival clocks
 * (DriverGlanceMetrics, TrackingMap's info window) keep their exact output.
 *
 * Houston rule, and it is load-bearing on this value above all others: the
 * arrival time is the one number a dispatcher says out loud to a broker or a
 * customer. An unlabelled "3:45 PM" rendered in the viewer's zone is how a
 * Manila session quotes a Houston customer a time 13 hours off.
 *
 * ⚠️ Instants only — an epoch, or a string carrying a zone. A bare wall clock
 * returns `fallback` rather than being parsed in the viewer's zone; there is no
 * fmtSheetMoment escape hatch here, because nothing that means "arrival" is
 * sourced from a sheet cell, and inventing an instant from one would put a
 * viewer-dependent time on a customer-facing page.
 */
export function fmtArrivalClock(v, { weekday = false, fallback = null } = {}) {
  if (v == null) return fallback
  let dt
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return fallback
    dt = new Date(v)
  } else {
    const s = String(v).trim()
    if (!s || !isZoned(s)) return fallback
    dt = new Date(s)
  }
  if (isNaN(dt.getTime())) return fallback
  return new Intl.DateTimeFormat('en-US', {
    timeZone: HOUSTON,
    ...(weekday ? { weekday: 'short' } : {}),
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).format(dt)
}

// ---------------------------------------------------------------------------
// APP_TIMEZONE — whose calendar decides "today", and the day an instant is on.
//
// Two rules, decided by the owner on 2026-10-08:
//
//   D1. A date-only value ('YYYY-MM-DD': a load date, a start or end date, an
//       invoice period) is a CALENDAR DATE. It is never converted through UTC
//       and shows the same date for every viewer in every time zone.
//   D2. When an instant has to become a date, or for "today", the zone is ONE
//       setting, APP_TIMEZONE. Its default is America/New_York (EST and EDT
//       follow by themselves). Never the browser's own zone.
//
// WHY. "Today" and "which day is this" were read off the viewer's clock on a
// dozen screens. This app is used from the US and from Manila, half a day
// apart, so for half of every day two people saw different dates for the same
// moment, and some of those dates were sent back to the server: the end of the
// driver's invoice week (POST /api/invoices/generate), the day "+ Add day"
// suggests (POST /api/admin/excluded-days), the range of the IFTA report.
//
// WHERE THE SETTING COMES FROM. The server sends it on GET /api/auth/session
// (`appTimeZone`), and stores/auth.js hands every answer's value to
// setAppTimeZone(). Until an answer arrives, and whenever the value is missing
// or a zone this browser does not know, the default stands.
//
// The Houston-pinned helpers above (houstonToday, fmtTimestamp, fmtSheetMoment,
// fmtYmd's timestamp branch, fmtArrivalClock) are NOT routed through this. They
// are pinned to the carrier's own city on purpose, and whether they move to
// APP_TIMEZONE is a separate decision.
//
// Pinned by scripts/test-app-timezone-client.mjs, which runs every helper below
// on machines set to New York, Manila and UTC and requires the same answers.
// ---------------------------------------------------------------------------

const DEFAULT_APP_TIME_ZONE = 'America/New_York'
// An IANA region name or "UTC"; the same test as lib/app-time.js on the server.
const APP_TIME_ZONE_RE = /^(?:UTC|[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)+)$/
let appZone = DEFAULT_APP_TIME_ZONE
const DAY_MS = 24 * 60 * 60 * 1000
const pad2 = (n) => String(n).padStart(2, '0')

/**
 * Adopt the server's APP_TIMEZONE. Takes an IANA region name ("America/New_York")
 * or "UTC" that this browser accepts, the same shape lib/app-time.js accepts;
 * anything else (missing, misspelled, an offset such as "-0400" or "EST" that
 * never follows daylight time, or a zone this browser's Intl data lacks) leaves
 * the zone in use as it is. Never throws: it runs inside the session check.
 * Returns the zone in use afterwards.
 */
export function setAppTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !APP_TIME_ZONE_RE.test(timeZone)) return appZone
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
  } catch {
    return appZone
  }
  appZone = timeZone
  return appZone
}

/** The zone in use: the server's APP_TIMEZONE, or America/New_York until it arrives. */
export function appTimeZone() {
  return appZone
}

/**
 * Epoch ms for a value that IS an instant: a Date, a number, or a string that
 * carries its own zone. NaN for anything else. A bare wall clock is NaN, not a
 * guess: reading one would take the viewer's zone (see fmtTimestamp's guard).
 */
function instantMs(v) {
  let ms = NaN
  if (v instanceof Date) ms = v.getTime()
  else if (typeof v === 'number') ms = v
  else {
    const s = String(v ?? '').trim()
    if (s && isZoned(s)) ms = Date.parse(s)
  }
  // Through new Date() so that a number past what a Date can hold is NaN too:
  // Intl throws on an invalid Date rather than returning something to check.
  return new Date(ms).getTime()
}

/** The 'YYYY-MM-DD' an instant falls on in `timeZone`. */
function dayIn(ms, timeZone) {
  const p = zonedParts(ms, timeZone)
  return `${p.year}-${p.month}-${p.day}`
}

/**
 * 'YYYY-MM-DD' → epoch ms of its UTC midnight, the anchor for calendar
 * arithmetic. NaN unless it names a real day ('2026-02-30' is NaN, not Mar 2).
 */
function ymdUtcMs(v) {
  const s = String(v ?? '').trim()
  if (!YMD_RE.test(s)) return NaN
  const [y, m, d] = s.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d)
  const dt = new Date(ms)
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? ms : NaN
}

/** Epoch ms → its UTC calendar date as 'YYYY-MM-DD'. */
function utcYmd(ms) {
  const dt = new Date(ms)
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

/**
 * The APP_TIMEZONE day an instant falls on, as 'YYYY-MM-DD'.
 *
 *   appDayOf('2026-09-28T23:30:00-04:00')  -> '2026-09-28'   (already Sep 29 in Manila)
 *   appDayOf(Date.now())                   -> today, as appToday() gives it
 *   appDayOf('2026-09-28')                 -> '2026-09-28'   (a calendar date is its own day, D1)
 *
 * Takes a Date, epoch ms, or a string carrying its zone. '' for anything else,
 * a bare wall clock ("2026-09-28 23:30:00") and a day that does not exist
 * ('2026-02-30') included: neither has an instant to place.
 */
export function appDayOf(v) {
  if (typeof v === 'string' && isYmd(v)) return Number.isNaN(ymdUtcMs(v)) ? '' : v.trim()
  const ms = instantMs(v)
  return Number.isNaN(ms) ? '' : dayIn(ms, appZone)
}

/**
 * Today in APP_TIMEZONE, as 'YYYY-MM-DD': for "today" defaults and highlights,
 * and the current week or month. `now` (epoch ms or a Date) pins the moment.
 */
export function appToday(now = Date.now()) {
  return appDayOf(now)
}

const APP_DATE_FORMAT = Object.freeze({ month: 'short', day: 'numeric', year: 'numeric' })

/**
 * A DATE for display, en-US, on the APP_TIMEZONE calendar.
 *
 *   fmtAppDate('2026-09-29T02:15:00Z')    -> "Sep 28, 2026"   (10:15 PM EDT)
 *   fmtAppDate('2026-09-29T02:15:00Z', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
 *                                         -> "Monday, September 28, 2026"
 *   fmtAppDate('2026-09-28')              -> "Sep 28, 2026"   (shown as itself, D1)
 *
 * Other options are Intl date fields (weekday, month, day, year) and replace the
 * default set; a `timeZone` among them is ignored, because the zone is the
 * setting. Anything unreadable, a bare wall clock included, gives `fallback`.
 */
export function fmtAppDate(v, { fallback = '—', ...format } = {}) {
  const fields = Object.keys(format).length ? format : APP_DATE_FORMAT
  if (typeof v === 'string' && isYmd(v)) {
    // A calendar date already names its day: shown as itself, read and written
    // in UTC so that no zone can move it.
    const ms = ymdUtcMs(v)
    return Number.isNaN(ms) ? fallback : new Intl.DateTimeFormat('en-US', { ...fields, timeZone: 'UTC' }).format(new Date(ms))
  }
  const ms = instantMs(v)
  return Number.isNaN(ms) ? fallback : new Intl.DateTimeFormat('en-US', { ...fields, timeZone: appZone }).format(new Date(ms))
}

/**
 * The first instant of calendar day `ymd` in `timeZone`, as epoch ms (NaN if
 * `ymd` is not a real day). Midnight through wallClockToInstant(), which reads
 * the zone's offset AT that day, so a DST day comes out 23 or 25 hours long.
 *
 * Every US zone changes its clocks at 2 AM, so there midnight is one real
 * instant and that is the whole answer. A few zones change AT midnight. Where a
 * zone west of UTC skips midnight (Cuba: 00:00 jumps to 01:00), the two passes
 * land on the evening before; the day then starts where the clocks jump, which
 * is what the first pass alone gives. Checked, not assumed: the fallback runs
 * only when the two-pass answer is not on `ymd`.
 */
function dayStartMs(ymd, timeZone) {
  const utcMidnight = ymdUtcMs(ymd)
  if (Number.isNaN(utcMidnight)) return NaN
  const day = utcYmd(utcMidnight)
  const [y, m, d] = day.split('-').map(Number)
  const ms = wallClockToInstant(timeZone, y, m, d, 0, 0, 0).getTime()
  return dayIn(ms, timeZone) === day ? ms : utcMidnight - tzOffsetMs(utcMidnight, timeZone)
}

/**
 * The start of calendar day `ymd` in APP_TIMEZONE, as an ISO instant:
 * appDayStartIso('2026-11-01') -> '2026-11-01T04:00:00.000Z'. '' if `ymd` is not
 * a real 'YYYY-MM-DD'. For a date range a server compares instants against, so
 * every viewer asks for the same range.
 */
export function appDayStartIso(ymd) {
  const ms = dayStartMs(ymd, appZone)
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString()
}

/**
 * The last millisecond of calendar day `ymd` in APP_TIMEZONE, as an ISO instant:
 * appDayEndIso('2026-11-01') -> '2026-11-02T04:59:59.999Z' (that day is 25 hours
 * long). The next day's start minus 1 ms, so an inclusive `<=` bound misses
 * nothing. '' if `ymd` is not a real 'YYYY-MM-DD'.
 */
export function appDayEndIso(ymd) {
  const ms = dayStartMs(shiftYmd(ymd, 1), appZone)
  return Number.isNaN(ms) ? '' : new Date(ms - 1).toISOString()
}

// --- Calendar arithmetic on date keys ---------------------------------------
// Pure: Date.UTC and getUTC* only. The UTC calendar has no DST and no viewer, so
// a day is always 24 hours there and the answer is the same on every machine.

/** 'YYYY-MM-DD' moved by `n` calendar days: shiftYmd('2026-09-30', 1) -> '2026-10-01'. '' if unreadable. */
export function shiftYmd(ymd, n) {
  const ms = ymdUtcMs(ymd)
  if (Number.isNaN(ms) || !Number.isInteger(n)) return ''
  const moved = ms + n * DAY_MS
  return Number.isNaN(new Date(moved).getTime()) ? '' : utcYmd(moved)
}

/** 'YYYY-MM' moved by `n` calendar months: shiftYm('2026-12', 1) -> '2027-01'. '' if unreadable. */
export function shiftYm(ym, n) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym ?? '').trim())
  const month = m ? Number(m[2]) : 0
  if (!m || month < 1 || month > 12 || !Number.isInteger(n)) return ''
  const dt = new Date(Date.UTC(Number(m[1]), month - 1 + n, 1))
  return Number.isNaN(dt.getTime()) ? '' : `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}`
}

/**
 * The Saturday-to-Friday week holding calendar day `ymd` (the driver invoice
 * week), as { start, end } 'YYYY-MM-DD':
 * satFriWeekOf('2026-09-28') -> { start: '2026-09-26', end: '2026-10-02' }.
 * A Saturday starts its own week. null if `ymd` is not a real day.
 */
export function satFriWeekOf(ymd) {
  const ms = ymdUtcMs(ymd)
  if (Number.isNaN(ms)) return null
  const sinceSaturday = (new Date(ms).getUTCDay() + 1) % 7 // Sat 0, Sun 1, … Fri 6
  const start = ms - sinceSaturday * DAY_MS
  return { start: utcYmd(start), end: utcYmd(start + 6 * DAY_MS) }
}
