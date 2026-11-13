// The dashboard's Driver Performance tab: its words and views. Each driver's figures go through his own
// tab's views, so the office reads what his screen shows him; nothing here counts or sorts.
// Pinned by scripts/test-driver-performance-client.mjs.

import {
  COMING_SOON, DRIVE_HOURS_LINE, EMPTY_LINE, FAILED_LINE, HOS_LINE, TARGET_LINE, THIS_WEEK_TITLE, ownWeekView, pastWeeksView, weekBarView, weekClosesLine,
} from './driverPerformance.js'

// The driver tab's own rules for the tab and the board, so the office's screens need no other lib.
export { PERIODS as BOARD_PERIODS, boardUrl, boardView, isGoneAnswer, periodKind, tabAfterAnswer } from './driverPerformance.js'

export const ADMIN_WEEKS_URL = '/api/admin/driver-performance/weeks'

// Every fixed word the tab shows, in one place. The ones it shares with the driver's own tab come
// from that tab's lib, so one change there words both.
export const WORDS = Object.freeze({
  tab: 'Driver Performance',
  weeksTitle: "Drivers' weeks",
  boardTitle: 'Board by unit',
  notOnBoardTitle: 'Not on the board',
  thisWeek: THIS_WEEK_TITLE,
  lastWeek: 'Last week',
  target: TARGET_LINE,
  driveHours: DRIVE_HOURS_LINE,
  noDrivers: 'No driver has a week to show yet.',
  // His own screen says "Your target is lower…"; the office reads the same flag in its own words.
  lowered: 'Target lowered this week for approved time off.',
  loading: 'Loading…',
  failed: FAILED_LINE,
  retry: 'Try again',
  // The board by unit's, as /driver shows it to a Super Admin.
  comingSoon: COMING_SOON,
  boardEmpty: EMPTY_LINE,
  hos: HOS_LINE,
})

// Why a driver isn't on this week's board by unit, by the server's code. Any other code shows no reason.
export const REASONS = Object.freeze({
  inactive: 'Not active',
  'percentage-driver': 'Percentage driver',
  'owner-operator': 'Owner-operator',
  'no-truck-in-period': 'No truck this week',
  'not-in-directory': 'Not in the Driver Database',
})

// Only a Super Admin asks, so no other role's dashboard ever shows the tab.
export function adminTabProbeUrl(role) {
  return role === 'Super Admin' ? ADMIN_WEEKS_URL : ''
}

const reasonOf = (code) => (Object.prototype.hasOwnProperty.call(REASONS, code) ? REASONS[code] : '')

// One driver's row, through his own tab's views, or null when his answer doesn't hold it whole.
function driverRow(entry) {
  if (!entry || typeof entry !== 'object' || !Number.isInteger(entry.directoryId)) return null
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  const answer = entry.performance
  const thisWeek = ownWeekView(answer, 'this-week')
  const lastWeek = ownWeekView(answer, 'last-week')
  const bar = weekBarView(answer)
  const past = pastWeeksView(answer)
  if (!name || !thisWeek || !lastWeek || !bar || !past) return null
  return {
    key: entry.directoryId,
    name,
    unit: typeof entry.unit === 'string' ? entry.unit : '',
    range: thisWeek.range,
    count: thisWeek.count,
    pace: thisWeek.pace,
    paceId: thisWeek.paceId,
    width: thisWeek.width,
    color: bar.color,
    left: thisWeek.left,
    lastCount: lastWeek.count,
    thisWeek: {
      title: thisWeek.title,
      loads: thisWeek.loads,
      empty: thisWeek.empty,
      newWeek: thisWeek.newWeek,
      rule: thisWeek.rule,
      requirement: thisWeek.requirement,
      lowered: thisWeek.lowered ? WORDS.lowered : '',
    },
    lastWeek: { title: lastWeek.title, loads: lastWeek.loads, empty: lastWeek.empty },
    past,
  }
}

// One driver off this week's board, with the reason in words.
function offBoardRow(item) {
  const name = item && typeof item.name === 'string' ? item.name.trim() : ''
  return name ? { name, reason: reasonOf(item.reason) } : null
}

// The tab's drivers in the server's order, the week's days with its closing line, and this week's
// drivers off the board by unit, each with the reason; null when the answer doesn't hold its list
// whole, and then no row shows.
export function driversView(answer) {
  const list = answer && Array.isArray(answer.drivers) ? answer.drivers : null
  if (!list) return null
  const rows = list.map(driverRow)
  if (rows.includes(null)) return null
  const off = Array.isArray(answer.notOnBoard) ? answer.notOnBoard.map(offBoardRow) : []
  return {
    weekLine: rows.length ? `${rows[0].range} · ${weekClosesLine()}` : '',
    rows,
    notOnBoard: off.filter(Boolean),
  }
}
