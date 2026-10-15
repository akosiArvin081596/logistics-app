// One cell of the loadboard's load detail (Job Board, Active Loads, Completed).
//
// A cell shaped like a date or a time goes through fmtSheetMoment(), so the
// detail shows it the way the rest of the page does: a bare sheet stamp as its
// wall clock in 12 h, never converted ("10/12/2026 0:17:10" -> "10/12/2026,
// 12:17 AM"); a value carrying its zone in US Eastern with EDT/EST; a date-only
// value as the same calendar day. Two stored shapes are put into one of those
// first: an email Date header saved in a cell ("Date: Wed, 28 Jan 2026
// 10:52:46 -0500", an instant by its offset) and a stamp with a two-digit year
// and a time ("11/18/25 13:00", read as 2025). The shape tests are strict on
// purpose: isZoned() alone would treat free text ending in "-1200" or naming
// "UTC" as a moment, and trailing words mean free text. Everything else prints
// as stored.
// Runner: scripts/test-load-detail-times.mjs.

import { fmtSheetMoment } from '../utils/datetime.js'

// M/D/YYYY, optionally with H:MM[:SS] and AM/PM: fmtSheetMoment's bare shape.
const SHEET_STAMP_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:AM|PM)?)?$/i
// M/D/YY with a time (required): the same stamp with a two-digit year.
const SHORT_YEAR_STAMP_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2})([ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:AM|PM)?)$/i
// YYYY-MM-DD, or an ISO time that names its zone (Z or an offset).
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/
// An RFC 2822 date as an email's Date header writes it, with an optional
// "Date:" label and an optional zone comment ("(UTC)").
const EMAIL_DATE_RE = /^(?:Date: {0,3})?(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat), {0,3})?(\d{1,2}) {1,3}(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,3}(\d{4}) {1,3}(\d{1,2}):(\d{2})(?::(\d{2}))? {1,3}([+-]\d{4}|GMT|UTC|UT)(?: {1,3}\([A-Za-z]{1,5}\))?$/i

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

// A day the calendar has (no 2/30, no 2/29 outside a leap year). month is 1-12.
function realDay(year, month, day) {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

// Hour 0-23, minute and second 0-59; a stamp with no time passes.
function clockInRange(hour, minute, second) {
  if (hour == null) return true
  return Number(hour) <= 23 && Number(minute) <= 59 && (second == null || Number(second) <= 59)
}

const pad2 = (n) => String(n).padStart(2, '0')

// The email Date header as an ISO time with its offset, or null when any part
// of it can't be trusted (no such day, a weekday that isn't that day's, an
// impossible clock or offset).
function emailDateIso(s) {
  const m = s.match(EMAIL_DATE_RE)
  if (!m) return null
  const [, weekday, day, mon, year, hour, minute, second = '00', zone] = m
  const month = MONTHS.indexOf(mon.toLowerCase())
  const d = Number(day)
  if (!realDay(year, month + 1, d)) return null
  const date = new Date(Date.UTC(Number(year), month, d))
  if (weekday && WEEKDAYS[date.getUTCDay()] !== weekday.toLowerCase()) return null
  if (!clockInRange(hour, minute, second)) return null
  let offset = 'Z'
  if (zone[0] === '+' || zone[0] === '-') {
    if (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(3)) > 59) return null
    offset = `${zone.slice(0, 3)}:${zone.slice(3)}`
  }
  return `${year}-${pad2(month + 1)}-${pad2(d)}T${pad2(hour)}:${minute}:${second}${offset}`
}

// The text fmtSheetMoment should format for this cell, or null to print it as stored.
function momentText(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  const stamp = s.match(SHEET_STAMP_RE)
  if (stamp) return realDay(stamp[3], stamp[1], stamp[2]) && clockInRange(stamp[4], stamp[5], stamp[6]) ? s : null
  const short = s.match(SHORT_YEAR_STAMP_RE)
  if (short) {
    const [, month, day, yy, time, hour, minute, second] = short
    return realDay(`20${yy}`, month, day) && clockInRange(hour, minute, second) ? `${month}/${day}/20${yy}${time}` : null
  }
  const iso = s.match(ISO_RE)
  if (iso) return realDay(iso[1], iso[2], iso[3]) ? s : null
  return emailDateIso(s)
}

export function isMomentCell(v) {
  return momentText(v) != null
}

function shown(v) {
  const t = momentText(v)
  return t == null ? v : fmtSheetMoment(t)
}

export function parseJsonCell(r) {
  if (!r || typeof r !== 'string' || r[0] !== '{') return null
  try { return JSON.parse(r) } catch { return null }
}

export function detailValue(row, col) {
  const v = row[col] || ''
  const p = parseJsonCell(v)
  if (p) return Object.entries(p).filter(([, x]) => x).map(([k, x]) => `${k}: ${shown(x)}`).join(', ')
  return shown(v)
}
