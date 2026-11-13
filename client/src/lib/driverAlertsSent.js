// The Drivers page's "Alerts sent", for a Super Admin: what one driver's Alerts tab lists
// (GET /api/drivers-directory/:id/alerts-sent, lib/driver-alerts-sent.js), read-only.
// Pure. Times are on the app's own clock. Pinned by scripts/test-driver-alerts-sent-client.mjs.
import { fmtAppInstant } from '../utils/datetime.js'

export const ALERTS_WORDS = Object.freeze({
  heading: 'Alerts sent',
  none: 'No alerts sent to this driver yet.',
  noAccount: 'No single driver account matches this directory row, so there are no alerts to show.',
  unreadable: "This driver's alerts couldn't be loaded. Try again.",
})

// The line over a list that reached the server's cap.
export const newestLine = (n) => `Showing the newest ${n}.`

// A Drivers page row's list; null for anything but a positive whole id.
export function alertsSentUrl(directoryId) {
  return Number.isSafeInteger(directoryId) && directoryId > 0 ? `/api/drivers-directory/${directoryId}/alerts-sent` : null
}

// Not this viewer's (403), or a server without the route (404): the section stays away.
export function isHiddenAnswer(err) {
  return !!err && (err.status === 403 || err.status === 404)
}

const isAlert = (a) => !!a && typeof a === 'object' && typeof a.title === 'string'

// The answer as the section shows it: { note, rows, newest }. An answer it can't read
// shows the unreadable line.
export function alertsSentView(answer) {
  const noted = (note) => ({ note, rows: [], newest: '' })
  if (!answer || typeof answer !== 'object') return noted(ALERTS_WORDS.unreadable)
  if (answer.linked === false) return noted(ALERTS_WORDS.noAccount)
  if (answer.linked !== true || !Array.isArray(answer.alerts)) return noted(ALERTS_WORDS.unreadable)
  const rows = answer.alerts.filter(isAlert).map((a) => ({
    title: a.title,
    text: typeof a.text === 'string' ? a.text : '',
    time: fmtAppInstant(a.time, { fallback: '' }),
  }))
  if (!rows.length) return noted(ALERTS_WORDS.none)
  const limit = Number.isSafeInteger(answer.limit) && answer.limit > 0 ? answer.limit : 0
  return { note: '', rows, newest: limit && answer.alerts.length >= limit ? newestLine(limit) : '' }
}
