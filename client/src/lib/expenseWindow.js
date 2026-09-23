// The driver app's half of "receipts on recently delivered loads".
//
// THE RULE IS NOT HERE. It lives in lib/expense-window.js on the server (owner,
// 2026-09-23: an ACTIVE load, or one DELIVERED WITHIN THE LAST 7 DAYS), which
// judges every load on GET /api/driver/:driverName and ships the verdict as
// `load._expenseWindow` — { eligible, state, deliveredAt, closesAt } — and
// enforces the same verdict on POST /api/expenses. Re-deriving it here from the
// status would be a second copy of a money rule, free to drift.
//
// This file does only what the phone must do itself:
//
//   1. Re-check the closing time against the phone's own clock. The driver app
//      stays open for hours, and a verdict fetched at 6 days 23 hours is stale
//      an hour later. INCLUSIVE, like the server: open while now <= closesAt.
//   2. Put the verdict into words for the load page.
//
// With NO verdict on a load (the server could not read the status history, or a
// load object that did not come from that endpoint) it degrades to exactly the
// old rule — the form on an active load, nowhere else — and says nothing about a
// window it knows nothing of. The server still judges every submit.
//
// Pure: no network, no DOM, no Vue. scripts/test-expense-load-window-client.mjs.

import { isZoned, fmtArrivalClock, fmtTimestamp } from '../utils/datetime.js'

// The statuses the load page has always shown the status stepper and the expense
// form on. LoadDetail's isActiveLoad reads it from here, so the fallback below
// and the stepper cannot disagree; the server's copy is ACTIVE_STATUS_RE in
// lib/expense-window.js, and the test above pins the two to the same answers.
export const ACTIVE_LOAD_STATUS_RE = /^(assigned|dispatched|heading to shipper|at shipper|loading|in transit|at receiver|unloading)$/i

export function isActiveLoadStatus(status) {
  return ACTIVE_LOAD_STATUS_RE.test(String(status ?? '').trim())
}

const STATES = new Set(['active', 'open', 'closed', 'unknown', 'cancelled', 'none'])

// An instant, or NaN. Only a value carrying its own zone is trusted: the server
// sends toISOString() output, and a bare wall clock would be read in the
// phone's zone.
function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (v instanceof Date) return v.getTime()
  const s = String(v ?? '').trim()
  return s && isZoned(s) ? Date.parse(s) : NaN
}

/**
 * The server's verdict for one load, as of `now` on this phone.
 *   win     load._expenseWindow (may be missing)
 *   status  the load's status cell — used ONLY when there is no verdict
 * → { eligible, state, deliveredAt, closesAt } (+ fallback: true without a verdict)
 */
export function liveExpenseWindow(win, { status = '', now = Date.now() } = {}) {
  if (!win || typeof win !== 'object' || !STATES.has(win.state)) {
    const active = isActiveLoadStatus(status)
    return { eligible: active, state: active ? 'active' : 'none', deliveredAt: null, closesAt: null, fallback: true }
  }
  const verdict = { state: win.state, deliveredAt: win.deliveredAt || null, closesAt: win.closesAt || null }
  if (win.state === 'open') {
    const closes = toMs(win.closesAt)
    const nowMs = Number.isFinite(toMs(now)) ? toMs(now) : Date.now()
    // An unreadable closing time is not an open window.
    const open = Number.isFinite(closes) && nowMs <= closes
    return { ...verdict, eligible: open, state: open ? 'open' : 'closed' }
  }
  // Only the server opens a window; the phone can close one, never reopen it.
  return { ...verdict, eligible: win.state === 'active' }
}

// Length of the window, read off the verdict itself so the copy follows the
// server's number instead of repeating it. null when the verdict has no span.
export function expenseWindowDays(win) {
  const delivered = toMs(win && win.deliveredAt)
  const closes = toMs(win && win.closesAt)
  if (!Number.isFinite(delivered) || !Number.isFinite(closes) || closes <= delivered) return null
  return Math.round((closes - delivered) / 86400000)
}

/**
 * What the load page says about receipts, from liveExpenseWindow()'s answer.
 *   note  { title, body } — a delivered load that takes receipts, and until when
 *   hint  string          — a delivered load that no longer does, and what to do
 * Nothing for an active load: the form is where it always was.
 * Instants are Houston time with a zone label (utils/datetime.js — the app rule).
 */
export function expenseWindowCopy(win) {
  const days = expenseWindowDays(win)
  const span = days ? `${days} day${days === 1 ? '' : 's'}` : 'a limited time'
  switch (win && win.state) {
    case 'open':
      return {
        note: {
          title: 'Adding a receipt to a delivered load',
          body: `Allowed for ${span} after delivery. Open until ${fmtArrivalClock(win.closesAt, { weekday: true, fallback: 'the window closes' })}.`,
        },
        hint: null,
      }
    case 'closed':
      return {
        note: null,
        hint: `The ${days ? `${days}-day ` : ''}window for adding receipts to this load closed ${fmtTimestamp(win.closesAt, { fallback: 'already' })}. Ask dispatch to add one.`,
      }
    case 'unknown':
      return {
        note: null,
        hint: 'There’s no record of when this load was delivered, so receipts can’t be added here. Ask dispatch to add one.',
      }
    case 'cancelled':
      return { note: null, hint: 'This load was cancelled, so receipts can’t be added to it.' }
    default:
      return { note: null, hint: null }
  }
}

function findCol(headers, regex) {
  return (headers || []).find((h) => regex.test(h)) || null
}

/**
 * The load ids the expense form may offer — exactly the loads the server will
 * accept a receipt on, as of `now`: active, or delivered within their window.
 */
export function expenseLoadIds(loads, headers, { now = Date.now() } = {}) {
  const loadIdCol = findCol(headers, /load.?id|job.?id/i)
  if (!loadIdCol) return []
  const statusCol = findCol(headers, /status/i)
  return (Array.isArray(loads) ? loads : [])
    .filter((l) => l && liveExpenseWindow(l._expenseWindow, { status: statusCol ? l[statusCol] : '', now }).eligible)
    .map((l) => l[loadIdCol])
    .filter(Boolean)
}
