// The driver's Performance tab (Phase A): its fixed words, and what each server answer may put on
// the screen. Display only, and the server works out every figure: this file picks and words what
// it is sent, and never counts, adds or ranks, so rows keep the server's order and rank. Each view
// names the fields it copies, so nothing else an answer carries can reach a screen.
// Pinned by scripts/test-driver-performance-client.mjs.

import { availabilityRangeText } from './availabilityText.js'

export const OWN_URL = '/api/driver/me/performance'
export const BOARD_URL = '/api/driver/performance/leaderboard'

export const HOS_LINE = 'Never drive past your hours of service to reach a target. Your 11-hour driving limit, 14-hour window and 60/70-hour limit come first. Your ELD log is what counts for your hours. If you stop to stay legal, tell dispatch.'
export const GUIDE_LINE = 'Targets are a guide, not a requirement.'
export const NO_HOURS_LINE = "Drive hours aren't shown yet."
export const WEEK_CLOSES = 'Week closes Fri 11:59 PM ET'
export const NOT_RANKED = 'Not ranked'
export const NO_RANK = '–'
export const COMING_SOON = 'Coming soon'
export const YOU = 'You'
export const EMPTY_LINE = 'No trucks to show for this period.'
export const FAILED_LINE = "Performance can't be shown right now. Try again in a minute."

// The three choices over the board. "week" answers carry both weeks; "month" carries the month.
export const PERIODS = Object.freeze([
  Object.freeze({ id: 'this-week', label: 'This week', kind: 'week' }),
  Object.freeze({ id: 'last-week', label: 'Last week', kind: 'week' }),
  Object.freeze({ id: 'this-month', label: 'This month', kind: 'month' }),
])

export function periodKind(id) {
  const period = PERIODS.find((p) => p.id === id)
  return period ? period.kind : ''
}

export const boardUrl = (kind) => `${BOARD_URL}?period=${kind}`

// The board's four tiles, in order. Only `live` ones may ever show rows: a tile that is coming
// soon has no figure to show, whatever an answer holds.
export const CATEGORIES = Object.freeze([
  Object.freeze({ id: 'most-loads', title: 'Most loads', live: true, line: 'Loads delivered in this period.' }),
  Object.freeze({ id: 'least-fuel-cost', title: 'Least fuel cost', live: false, line: "Fuel receipts and ELD miles aren't complete enough to compare fairly yet." }),
  Object.freeze({ id: 'safety', title: 'Safety', live: false, line: "Safety isn't ranked yet." }),
  Object.freeze({ id: 'lowest-idle', title: 'Lowest idle', live: false, line: "Idle time is only an estimate today, so it isn't ranked yet." }),
])

// ── Who gets the tab ───────────────────────────────────────────────────────

// The route that says whether this viewer gets the tab, or "" for a role that never does. A
// Driver asks for his own week; a Super Admin on /driver has no week of his own, only the board.
export function tabProbeUrl(role) {
  if (role === 'Driver') return OWN_URL
  if (role === 'Super Admin') return boardUrl('week')
  return ''
}

export const showsMyWeek = (role) => role === 'Driver'

// 404 is the switch off (FEATURE_OFF), or a driver who isn't on the board (NOT_ELIGIBLE); 401 and
// 403 aren't his to see. The codes give no reason, and the screen never says which.
export const isGoneAnswer = (status) => status === 404 || status === 401 || status === 403

// Only a 200 shows the tab. A server or network failure says nothing either way, so it leaves
// the tab as it was.
export function tabAfterAnswer(status, shown) {
  if (status === 200) return true
  if (isGoneAnswer(status)) return false
  return !!shown
}

// ── The board ──────────────────────────────────────────────────────────────

// One row: its rank, unit and figure as the server sent them. A row without a rank always reads
// the same two words, so no reason can ever show on it.
export function rowView(row) {
  const r = row && typeof row === 'object' ? row : {}
  const ranked = Number.isInteger(r.rank) && r.rank > 0
  return {
    rank: ranked ? String(r.rank) : NO_RANK,
    unit: typeof r.unitLabel === 'string' ? r.unitLabel : '',
    figure: ranked && typeof r.display === 'string' ? r.display : NOT_RANKED,
    you: r.isYou === true,
  }
}

function tileView(category, answered) {
  const found = answered.find((c) => c && c.id === category.id)
  const live = category.live && !!found && found.status === 'live' && Array.isArray(found.rows)
  return {
    id: category.id,
    title: category.title,
    line: category.line,
    comingSoon: !live,
    rows: live ? found.rows.map(rowView) : [],
  }
}

// The chosen period's tiles, or null when the answer doesn't hold it.
export function boardView(answer, periodId) {
  const boards = answer && Array.isArray(answer.boards) ? answer.boards : []
  const board = boards.find((b) => b && b.id === periodId)
  if (!board) return null
  const answered = Array.isArray(board.categories) ? board.categories : []
  return {
    range: availabilityRangeText(board.start, board.end),
    closes: periodId === 'this-week' ? WEEK_CLOSES : '',
    tiles: CATEGORIES.map((c) => tileView(c, answered)),
  }
}

// ── His own week ───────────────────────────────────────────────────────────

// The week the card shows: the chosen one, and this week under "This month", which has no
// credits. Load credits only, or null when the answer doesn't hold them. The closing time goes
// here only under "This month": under "This week" the board already says it.
export function ownWeekView(answer, periodId) {
  const weeks = answer && Array.isArray(answer.weeks) ? answer.weeks : []
  const weekId = periodKind(periodId) === 'week' ? periodId : 'this-week'
  const week = weeks.find((w) => w && w.id === weekId)
  const credits = week && week.credits
  const weights = answer && answer.creditWeights
  if (!credits || !weights) return null
  const figures = [credits.value, credits.target, credits.deliveries, credits.pickups, weights.delivery, weights.pickup]
  if (!figures.every(Number.isFinite)) return null
  return {
    label: weekId === 'this-week' ? 'This week' : 'Last week',
    range: availabilityRangeText(week.start, week.end),
    closes: periodId === 'this-month' ? WEEK_CLOSES : '',
    credits: `${credits.value} of ${credits.target} load credits`,
    breakdown: `${credits.deliveries} delivered (${weights.delivery} each), ${credits.pickups} picked up (${weights.pickup} each)`,
  }
}
