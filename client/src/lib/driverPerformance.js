// A driver's own week, and the Super Admin's board on /driver: their fixed words, and what each
// server answer may put on the screen. Display only, and the server works out every figure: this
// file picks and words what it is sent, and never counts, adds or ranks, so rows keep the server's
// order. Each view names the fields it copies, so nothing else an answer carries can reach a screen.
// Pinned by scripts/test-driver-performance-client.mjs.

import { availabilityRangeText } from './availabilityText.js'

export const OWN_URL = '/api/driver/me/performance'
export const BOARD_URL = '/api/driver/performance/leaderboard'

export const HOS_LINE = 'Never drive past your hours of service to reach a target. Your 11-hour driving limit, 14-hour window and 60/70-hour limit come first. Your ELD log is what counts for your hours. If you stop to stay legal, tell dispatch.'
export const HOS_SHORT_LINE = 'Hours of service come first.'
export const TARGET_LINE = 'Target: 7.5 loads a week (1.5 a day over 5 days)'
export const GUIDE_LINE = 'Targets are a guide, not a requirement.'
export const PRIVATE_LINE = 'No other driver can see this.'
export const DRIVE_HOURS_LINE = 'Drive hours: coming soon'
// The first is true of every driver. The second only of one whose invoice pays days, and the
// server says which he is.
export const NOT_PAY_LINE = 'Counts loads, not pay.'
export const NOT_PAY_DAYS_LINE = 'Counts loads, not pay. Your invoice pays days.'
export const LOWER_TARGET_LINE = 'Your target is lower this week for your approved time off.'
export const TELL_DISPATCH_LINE = 'If something looks wrong, tell dispatch.'
export const NEW_WEEK_LINE = 'A new week starts Saturday.'
export const NO_LOADS_LINE = 'Nothing has counted yet this week.'
export const NO_LOADS_LAST_WEEK = 'Nothing counted last week.'
export const WEEK_CLOSES = 'Week closes Fri 11:59 PM ET'
export const FAILED_LINE = "Performance can't be shown right now. Try again in a minute."

// The three labels the server may choose. An answer holding anything else shows no label.
export const PACE_WORDS = Object.freeze({ ahead: 'Ahead of Pace', 'on-track': 'On Track', 'needs-focus': 'Needs Focus' })
// "not-counted" is said of the week on screen, so it stays true however the pickup was made.
const pickupNoteWords = (note, current) => ({
  'last-week': 'Pickup counted last week',
  'another-week': 'Pickup counted in another week',
  'not-counted': current ? 'Pickup not counted this week' : 'Pickup not counted last week',
})
const PICKUP_NOTES = Object.freeze(['last-week', 'another-week', 'not-counted'])

// The two weeks a driver can open. The answer holds both, so choosing one reads nothing.
export const OWN_PERIODS = Object.freeze([
  Object.freeze({ id: 'this-week', label: 'This week' }),
  Object.freeze({ id: 'last-week', label: 'Last week' }),
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

// 404 is the switch off (FEATURE_OFF), or a driver with no week to show (NOT_ELIGIBLE); 401 and
// 403 aren't his to see. The codes give no reason, and the screen never says which.
export const isGoneAnswer = (status) => status === 404 || status === 401 || status === 403

// Only a 200 shows the tab. A server or network failure says nothing either way, so it leaves
// the tab as it was.
export function tabAfterAnswer(status, shown) {
  if (status === 200) return true
  if (isGoneAnswer(status)) return false
  return !!shown
}

// What the bar may read, after a read: a Driver's own 200 only. Anything else clears it, so a
// failed read hides the bar rather than leave an old number standing.
export function weekFromAnswer(role, status, answer) {
  return showsMyWeek(role) && status === 200 ? answer : null
}

// ── His own week ───────────────────────────────────────────────────────────

const isNumber = (n) => typeof n === 'number' && Number.isFinite(n)
const paceId = (pace) => (Object.prototype.hasOwnProperty.call(PACE_WORDS, pace) ? pace : '')

// The figures every view of one week needs, or null when the answer doesn't hold them whole, so
// a screen shows nothing rather than a wrong number.
function weekFigures(answer, periodId) {
  const weeks = answer && Array.isArray(answer.weeks) ? answer.weeks : []
  const week = weeks.find((w) => w && w.id === periodId)
  const credits = week && week.credits
  if (!credits || !isNumber(credits.value) || !isNumber(credits.target)) return null
  if (!isNumber(week.percent) || week.percent < 0 || week.percent > 100) return null
  return { week, value: credits.value, target: credits.target, width: `${week.percent}%`, paceId: paceId(week.pace) }
}

// One row's words: both credits, or what became of the pickup. null when a figure can't be trusted.
function loadView(load, current) {
  if (!load || typeof load !== 'object') return null
  const counted = (part) => part && typeof part.day === 'string' && isNumber(part.credits)
  const noted = (part) => part && PICKUP_NOTES.includes(part.note)
  const { pickup, delivery } = load
  if (delivery && !counted(delivery)) return null
  const delivered = delivery ? `Delivered ${delivery.day} ${delivery.credits}` : ''
  let parts = delivered ? [delivered] : []
  if (counted(pickup)) parts = [`Picked up ${pickup.day} ${pickup.credits}`, ...parts]
  else if (noted(pickup)) parts = [...parts, pickupNoteWords(pickup.note, current)[pickup.note]]
  else if (pickup) return null
  if (!parts.length) return null
  const id = typeof load.loadId === 'string' ? load.loadId : ''
  return { title: id ? `Load ${id}` : 'Load', line: parts.join(' · ') }
}

// One week as the tab shows it, or null when the answer doesn't hold it whole. A closed week is
// its final figure and list: no label, and nothing left to ask for.
export function ownWeekView(answer, periodId) {
  const figures = weekFigures(answer, periodId)
  const weights = answer && answer.creditWeights
  if (!figures || !weights || !isNumber(weights.delivery) || !isNumber(weights.pickup)) return null
  const { week, value, target, width } = figures
  if (!Array.isArray(week.loads)) return null
  const current = periodId === 'this-week'
  const loads = week.loads.map((load) => loadView(load, current))
  if (loads.includes(null)) return null
  const left = week.left
  if (current && !isNumber(left)) return null
  const reached = current && left === 0
  const newWeek = current && !reached && week.newWeekNote === true
  const shownPace = current ? figures.paceId : ''
  let leftWords = ''
  if (reached) leftWords = `${target} reached this week.`
  else if (current) leftWords = `${left} load${left === 1 ? '' : 's'} left this week.`
  return {
    range: availabilityRangeText(week.start, week.end),
    count: `${value} of ${target} loads`,
    pace: shownPace ? PACE_WORDS[shownPace] : '',
    paceId: shownPace,
    width,
    left: leftWords,
    closes: current && !reached && !newWeek ? WEEK_CLOSES : '',
    newWeek: newWeek ? NEW_WEEK_LINE : '',
    rule: `A pickup counts ${weights.pickup} and a drop-off counts ${weights.delivery}, so each load is 1.`,
    notPay: answer.invoicePaysDays === true ? NOT_PAY_DAYS_LINE : NOT_PAY_LINE,
    lowered: current && week.targetLowered === true ? LOWER_TARGET_LINE : '',
    title: current ? 'What counted this week' : 'What counted last week',
    empty: current ? NO_LOADS_LINE : NO_LOADS_LAST_WEEK,
    loads,
  }
}

// The load page's bar: this week only, or null, and then it doesn't show.
export function weekBarView(answer) {
  const figures = weekFigures(answer, 'this-week')
  if (!figures || ownWeekView(answer, 'this-week') === null) return null
  return {
    text: `This week: ${figures.value} of ${figures.target} loads`,
    pace: figures.paceId ? PACE_WORDS[figures.paceId] : '',
    paceId: figures.paceId,
    width: figures.width,
    hos: HOS_SHORT_LINE,
  }
}

// ── The Super Admin's board ────────────────────────────────────────────────

export const NOT_RANKED = 'Not ranked'
export const NO_RANK = '–'
export const COMING_SOON = 'Coming soon'
export const YOU = 'You'
export const EMPTY_LINE = 'No trucks to show for this period.'

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

export function boardUrl(kind) {
  return `${BOARD_URL}?period=${kind}`
}

// The board's four tiles, in order. Only `live` ones may ever show rows: a tile that is coming
// soon has no figure to show, whatever an answer holds.
export const CATEGORIES = Object.freeze([
  Object.freeze({ id: 'most-loads', title: 'Most loads', live: true, line: 'Loads delivered in this period.' }),
  Object.freeze({ id: 'least-fuel-cost', title: 'Least fuel cost', live: false, line: "Fuel receipts and ELD miles aren't complete enough to compare fairly yet." }),
  Object.freeze({ id: 'safety', title: 'Safety', live: false, line: "Safety isn't ranked yet." }),
  Object.freeze({ id: 'lowest-idle', title: 'Lowest idle', live: false, line: "Idle time is only an estimate today, so it isn't ranked yet." }),
])

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
