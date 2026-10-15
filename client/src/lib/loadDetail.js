// One cell of the loadboard's load detail (Job Board, Active Loads, Completed).
//
// A cell shaped like a date or a time goes through fmtSheetMoment(), so the
// detail shows it the way the rest of the page does: a bare sheet stamp as its
// wall clock in 12 h, never converted ("10/12/2026 0:17:10" -> "10/12/2026,
// 12:17 AM"); a value carrying its zone in US Eastern with EDT/EST; a date-only
// value as the same calendar day. The shape test is strict on purpose:
// isZoned() alone would treat free text ending in "-1200" or naming "UTC" as a
// moment. Everything else prints as stored.
// Runner: scripts/test-load-detail-times.mjs.

import { fmtSheetMoment } from '../utils/datetime.js'

// M/D/YYYY, optionally with H:MM[:SS] and AM/PM: fmtSheetMoment's bare shape.
const SHEET_STAMP_RE = /^(\d{1,2})\/(\d{1,2})\/\d{4}(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:AM|PM)?)?$/i
// YYYY-MM-DD, or an ISO time that names its zone (Z or an offset).
const ISO_RE = /^\d{4}-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/

function inRange(month, day) {
  const m = Number(month)
  const d = Number(day)
  return m >= 1 && m <= 12 && d >= 1 && d <= 31
}

// Hour 0-23, minute and second 0-59; a stamp with no time passes.
function clockInRange(hour, minute, second) {
  if (hour == null) return true
  return Number(hour) <= 23 && Number(minute) <= 59 && (second == null || Number(second) <= 59)
}

export function isMomentCell(v) {
  if (typeof v !== 'string') return false
  const s = v.trim()
  const stamp = s.match(SHEET_STAMP_RE)
  if (stamp) return inRange(stamp[1], stamp[2]) && clockInRange(stamp[3], stamp[4], stamp[5])
  const iso = s.match(ISO_RE)
  return !!iso && inRange(iso[1], iso[2])
}

function shown(v) {
  return isMomentCell(v) ? fmtSheetMoment(v) : v
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
