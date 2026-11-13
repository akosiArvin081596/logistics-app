#!/usr/bin/env node
// The driver's own week: the pure lib client/src/lib/driverPerformance.js, and how
// DriverPerformanceTab.vue, DriverWeekBar.vue, BottomNav.vue and DriverView.vue use it; the
// Super Admin's board on /driver, DriverPerformanceBoard.vue; and the Super Admin's Driver
// Performance tab on the dashboard (client/src/lib/driverPerformanceAdmin.js,
// DriverPerformanceAdminTab.vue, DashboardView.vue). The server works out every figure and
// its privacy rules (scripts/test-driver-performance.js); here the app must show only what those
// answers allow.
//   §1  the fixed words, exact, and none of the words a driver's screen must not show
//   §2  parity with lib/driver-performance.js: labels, categories, "Not ranked", the row's keys
//   §3  rowView(), the office board: only rank, unit, figure and "you"
//   §4  the office board's tiles: only Most loads can be live
//   §5  boardView(), the office board: the chosen period, the server's order
//   §6  ownWeekView(): the figures as sent, the label, what's left, each row's two credits; last
//       week's final figure with no label; nothing else an answer carries gets through
//   §7  weekBarView() and weekFromAnswer(): the bar's words and the server's color; only a Driver's
//       200 gives it a figure
//   §8  who gets the tab: only a 200 shows it, and only a Driver or Super Admin asks
//   §9  BottomNav.vue: the five tabs as they were, Past Performance only with its prop, no trophy
//   §10 DriverView.vue: the bar on the Loads list, the panel behind the answer, the read's rules
//   §11 DriverPerformanceTab.vue: this week on top, then his past weeks, from one read; never names
//       the board; reads, never writes or stores; computes nothing; no hours-of-service line
//   §12 DriverWeekBar.vue: its words, a 44 px tap, no read, no motion; its fill in the server's four
//       colors, and no other red
//   §13 DriverPerformanceBoard.vue: the office board, its reads and rows as they were
//   §14 the real server rules through the real views, on made-up loads, the bar's colors at each edge
//   §15 no pay, invoice or payout screen reads the count: only these three files import the lib
//   §16 pastWeeksView(): each past week's days, figure and hours line, in the server's order; the
//       "weren't counted" line; what's missing named, never 0; nothing else gets through
//   §17 the Super Admin's tab, its lib: the words; only a Super Admin asks; each driver's row is his
//       own tab's views of his own answer, in the server's order; this week's drivers off the
//       board with the reason in words; nothing it can't trust shows; it computes and sorts nothing
//   §18 DriverPerformanceAdminTab.vue: one read, never a write or storage; the row's button opens
//       what counted and his past weeks; "Not on the board" collapsed; the board by unit is the
//       existing component; the hours line is the driver's own
//   §19 DashboardView.vue: the tab after Fleet & Drivers, a Super Admin's only once its read answers,
//       gone again on the server's "gone", back to the Job Board
//   §20 the real server rules through the tab's views: the same figures and words as his own tab
//   §21 the dashboard reaches no Vant: nothing it can import, lazily or not, names a Vant module
//   §22 DriverPerformanceAdminBoard.vue: the driver board's views and words in plain markup, one
//       period read at a time, the hours-of-service line always
//   §23 the weekly performance page on his invoice (lib/invoice-performance-copy.js): the count, the
//       requirement, the rule, the time-off line, the rows and the four hours lines, each the tab's own for
//       the same answer; the page's own heading, as-of line (the business clock's zone) and title; nothing
//       else an answer holds; no page for a week it can't trust; a week closed before it was made
//
// No DOM, no server, no build; scripts/e2e/driver-performance.mjs covers the page.
//   node scripts/test-driver-performance-client.mjs      # exits 1 on any failure
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB = path.join(ROOT, 'client', 'src', 'lib', 'driverPerformance.js')
const CARD = path.join(ROOT, 'client', 'src', 'components', 'driver', 'DriverPerformanceTab.vue')
const BAR = path.join(ROOT, 'client', 'src', 'components', 'driver', 'DriverWeekBar.vue')
const BOARD = path.join(ROOT, 'client', 'src', 'components', 'driver', 'DriverPerformanceBoard.vue')
const NAV = path.join(ROOT, 'client', 'src', 'components', 'driver', 'BottomNav.vue')
const VIEW = path.join(ROOT, 'client', 'src', 'views', 'DriverView.vue')
const ADMIN_LIB = path.join(ROOT, 'client', 'src', 'lib', 'driverPerformanceAdmin.js')
const ADMIN_TAB = path.join(ROOT, 'client', 'src', 'components', 'dashboard', 'DriverPerformanceAdminTab.vue')
const ADMIN_BOARD = path.join(ROOT, 'client', 'src', 'components', 'dashboard', 'DriverPerformanceAdminBoard.vue')
const DASHBOARD = path.join(ROOT, 'client', 'src', 'views', 'DashboardView.vue')

let pass = 0
let fail = 0
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok    ${name}`); return }
  fail++
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`)
}
function done() {
  console.log(`\ntest-driver-performance-client: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')

const v = await import(pathToFileURL(LIB).href)
// The Super Admin's tab: absent on an older tree, so its sections fail by name.
const adm = fs.existsSync(ADMIN_LIB) ? await import(pathToFileURL(ADMIN_LIB).href) : {}
const require = createRequire(import.meta.url)
const server = require(path.join(ROOT, 'lib', 'driver-performance.js'))
const libSrc = read(LIB)
const card = read(CARD)
const bar = read(BAR)
const board = read(BOARD)
const nav = read(NAV)
const view = read(VIEW)
const adminLibSrc = read(ADMIN_LIB)
const adminTab = read(ADMIN_TAB)
const adminBoard = read(ADMIN_BOARD)
const dashboard = read(DASHBOARD)

const scriptOf = (src) => (src.match(/<script setup>([\s\S]*?)<\/script>/) || [])[1] || ''
const styleOf = (src) => (src.match(/<style scoped>([\s\S]*?)<\/style>/) || [])[1] || ''
// Repeats until stable: removing one comment can join the text around it into another.
const stripHtmlComments = (text) => {
  let out = text
  let before
  do {
    before = out
    out = out.replace(/<!--[\s\S]*?-->/g, '')
  } while (out !== before)
  return out
}
const templateOf = (src) => stripHtmlComments(src.slice(0, Math.max(0, src.indexOf('<script'))))
// Code with comments and quoted strings removed. Template literals stay, so arithmetic in a
// ${...} still shows.
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, ' ')
const has = (json, needle) => JSON.stringify(json).includes(needle)
const fn = (name) => (typeof v[name] === 'function' ? v[name] : () => null)

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link'])
// The opening tags around the first tag holding `marker`, that tag last; null when absent.
function chainTo(template, marker) {
  const stack = []
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g
  let m
  while ((m = re.exec(template))) {
    const [, closing, name, attrs, self] = m
    if (closing) { stack.pop(); continue }
    if (attrs.includes(marker)) return [...stack, attrs]
    if (!self && !VOID_TAGS.has(name)) stack.push(attrs)
  }
  return null
}

const WEEK_ID = 'this-week'
const START = '2026-10-31'
const END = '2026-11-06'
// Every field a row, tile or week must never pass on: a made-up name and made-up figures.
const DECOY_NAME = 'Casey Example'
const DECOYS = Object.freeze({
  driverName: DECOY_NAME, name: DECOY_NAME, initials: 'CE', driverId: 7701, directoryId: 7702, reason: 'decoy-reason',
  payDaily: 987, tier: 'decoy-tier', streak: 41, rei: 83.7, hours: 31.25, lane: 'decoy-lane', broker: 'decoy-broker',
  rate: 6543, rank: 77, unitLabel: 'decoy-unit', peers: [{ driver: 'decoy-peer', value: 91 }],
})
const DECOY_MARKS = [DECOY_NAME, 'CE', '7701', '7702', 'decoy-', '987', '41', '83.7', '31.25', '6543', '77', '91']
const showsDecoy = (json) => DECOY_MARKS.filter((mark) => has(json, mark))

// ── §1 the words ─────────────────────────────────────────────────────────────
console.log('§1 the fixed words')
eq('§1 the office board\'s hours-of-service line', v.HOS_LINE,
  'Never drive past your hours of service to reach a target. Your 11-hour driving limit, 14-hour window and 60/70-hour limit come first. Your ELD log is what counts for your hours. If you stop to stay legal, tell dispatch.')
eq('§1 the bar\'s short line is gone', v.HOS_SHORT_LINE, undefined)
eq('§1 no hours-of-service line or word on a driver\'s screen', [card, bar].filter((src) => /hours of service|hours-of-service|never drive past|\bHOS_|perf-hos|perf-bar-hos/i.test(src)).length, 0)
eq('§1 the target line, exact', v.TARGET_LINE, 'Target: 7.5 loads a week (1.5 a day over 5 days)')
eq('§1 the line on what\'s required, with the week\'s own figures', [fn('requirementLine')(7.5, 6), fn('requirementLine')(6, 4.5)], ['7.5 is the target. 6 is required.', '6 is the target. 4.5 is required.'])
eq('§1 the target alone, when the server sends no required figure', fn('targetOnlyLine')(4.5), '4.5 is the target.')
eq('§1 the old guide line and any fixed requirement line are gone', [v.GUIDE_LINE, v.REQUIREMENT_LINE, /Target is a requirement|a guide, not/.test(libSrc + card)], [undefined, undefined, false])
eq('§1 the privacy line, exact', v.PRIVATE_LINE, 'No other driver can see this.')
eq('§1 driving hours, this week\'s and a past week\'s while none are sent', v.DRIVE_HOURS_LINE, 'Driving hours: coming soon')
eq('§1 the headings over this week and the past weeks', [v.THIS_WEEK_TITLE, v.PAST_WEEKS_TITLE], ['This week', 'Past weeks'])
eq('§1 the line under the past weeks, with the server\'s date', fn('countedFromLine')('Nov 7'), "Weeks before Nov 7 weren't counted.")
eq('§1 a past week\'s hours, in the server\'s figure', fn('drivingHoursLine')(38.5), 'Driving: 38.5 h (estimate)')
eq('§1 a truck with no hours data, named', v.NO_DRIVING_HOURS_LINE, 'No driving hours for this truck')
eq('§1 hours that start after a week, on the server\'s day', fn('drivingHoursFromLine')('Nov 16'), 'Driving hours start Nov 16')
eq('§1 the bar\'s four colors', v.BAR_COLORS, ['red', 'orange', 'green', 'blue'])
eq('§1 neither line about pay is left', [v.NOT_PAY_LINE, v.NOT_PAY_DAYS_LINE], [undefined, undefined])
eq('§1 a lowered target, exact', v.LOWER_TARGET_LINE, 'Your target is lower this week for your approved time off.')
eq('§1 what to do about a wrong row', v.TELL_DISPATCH_LINE, 'If something looks wrong, tell dispatch.')
eq('§1 a week that can\'t be reached asks for nothing more, and says when the next one starts', fn('newWeekLine')('Nov 7'), 'A new week starts Saturday, Nov 7.')
eq('§1 the undated line is gone', v.NEW_WEEK_LINE, undefined)
eq('§1 the closing line, with ET', fn('weekClosesLine')(), 'Week closes Fri 11:59 PM ET')
{
  // The zone word follows the business clock (utils/datetime.js appZoneLabel()).
  const dt = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'utils', 'datetime.js')).href)
  dt.setAppTimeZone('America/Chicago')
  const central = fn('weekClosesLine')()
  dt.setAppTimeZone('America/New_York')
  eq('§1 the closing line names the business clock: CT on the Central clock', central, 'Week closes Fri 11:59 PM CT')
}
eq('§1 the three labels', v.PACE_WORDS, { ahead: 'Ahead of Pace', 'on-track': 'On Track', 'needs-focus': 'Needs Focus' })
eq('§1 no This week and Last week toggle: this week on top, then his past weeks', v.OWN_PERIODS, undefined)
eq('§1 the old neutral line is gone', v.NO_HOURS_LINE, undefined)
eq('§1 the office board keeps its three periods', v.PERIODS.map((p) => [p.id, p.label, p.kind]), [['this-week', 'This week', 'week'], ['last-week', 'Last week', 'week'], ['this-month', 'This month', 'month']])
eq('§1 the office board keeps its tiles\' words', [v.CATEGORIES.find((c) => c.id === 'safety').line, v.COMING_SOON, v.YOU], ["Safety isn't ranked yet.", 'Coming soon', 'You'])

// What a driver's screen may say: no ranking, no other driver, no hours figure, no pay figure.
const DRIVER_WORDS = [v.TARGET_LINE, v.LOWER_TARGET_LINE, fn('requirementLine')(7.5, 6), fn('targetOnlyLine')(7.5), v.PRIVATE_LINE, v.DRIVE_HOURS_LINE, v.TELL_DISPATCH_LINE, fn('newWeekLine')('Nov 7'), fn('weekClosesLine')(), v.NO_LOADS_LINE, v.NO_LOADS_LAST_WEEK, v.FAILED_LINE, ...Object.values(v.PACE_WORDS || {}),
  v.THIS_WEEK_TITLE, v.PAST_WEEKS_TITLE, fn('countedFromLine')('Nov 7'), fn('drivingHoursLine')(38.5), v.NO_DRIVING_HOURS_LINE, fn('drivingHoursFromLine')('Nov 16')]
const DRIVER_TEMPLATE_TEXT = templateOf(card).replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ')
const BAR_TEMPLATE_TEXT = templateOf(bar).replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ')
const BANNED = /\bREI\b|efficiency|out of reach|streak|\btier\b|bonus|prize|gained|\$|mph|\brank|leaderboard|most loads|\bunit\b|\btop\b|fuel|idle|safety|competit|behind|falling|late\b|quota/i
eq('§1 every word a driver sees is free of ranking, score, tier and dollars',
  [...DRIVER_WORDS, DRIVER_TEMPLATE_TEXT, BAR_TEMPLATE_TEXT].filter((w) => w === undefined || BANNED.test(w)), [])
eq('§1 "pay" appears on no line a driver sees',
  [...DRIVER_WORDS, DRIVER_TEMPLATE_TEXT, BAR_TEMPLATE_TEXT].filter((w) => /\bpay\b/i.test(w || '')), [])
eq('§1 no hours figure or 8.5 target in the drive-hours line', /\d/.test(v.DRIVE_HOURS_LINE || '1'), false)
// The mockup showed the shape only: none of its own words carry over to a driver's screen.
const MOCKUP_ONLY = /only you can see|your week|to go\b|see my week|my week:|eastern time|loads that counted|before shutdown|after approval|pay tiers/i
eq('§1 nothing else of the mockup\'s copy', [libSrc, DRIVER_TEMPLATE_TEXT, BAR_TEMPLATE_TEXT].filter((w) => MOCKUP_ONLY.test(w)).length, 0)

// ── §2 parity with the server's rules ────────────────────────────────────────
console.log('§2 parity with lib/driver-performance.js')
eq('§2 the same label ids', Object.keys(v.PACE_WORDS || {}).sort(), [...(server.LOADS_PACE_WORDS || [])].sort())
eq('§2 the target line says what the server\'s rules say', v.TARGET_LINE, `Target: ${server.CREDIT_TARGET} loads a week (${server.DAILY_CREDITS_GUIDE} a day over ${server.TARGET_DAYS} days)`)
eq('§2 the same categories, in the same order', v.CATEGORIES.map((c) => c.id), server.CATEGORIES.map((c) => c.id))
eq('§2 only the categories the server calls live are live', v.CATEGORIES.filter((c) => c.live).map((c) => c.id), server.CATEGORIES.filter((c) => c.live).map((c) => c.id))
eq('§2 the same "Not ranked"', v.NOT_RANKED, server.NOT_RANKED)
eq('§2 the bar\'s colors are the ones the server chooses', v.BAR_COLORS, typeof server.barColorFor === 'function' ? [0, 4, 6, 8].map((credits) => server.barColorFor(credits)) : [])
const fieldsRead = new Set()
v.rowView(new Proxy({ rank: 1, unitLabel: '#701', value: 6, display: '6 loads', isYou: true, ...DECOYS, rank: 1, unitLabel: '#701' }, {
  get(target, key) { fieldsRead.add(String(key)); return target[key] },
}))
eq('§2 a row is read for the server\'s row keys only, and never for its raw value', [...fieldsRead].sort(), server.ROW_KEYS.filter((k) => k !== 'value').sort())

// ── §3 one row of the office board ───────────────────────────────────────────
console.log('§3 rowView()')
const ROW_VIEW_KEYS = ['rank', 'unit', 'figure', 'you']
const row = (over) => ({ rank: 1, unitLabel: '#701', value: 6, display: '6 loads', isYou: false, ...over })
eq('§3 exactly four fields', Object.keys(v.rowView(row())), ROW_VIEW_KEYS)
eq('§3 rank, unit and figure as sent', v.rowView(row()), { rank: '1', unit: '#701', figure: '6 loads', you: false })
const { rank: _rank, unitLabel: _unit, ...rowDecoys } = DECOYS
eq('§3 another driver\'s name and everything else on the row stay out', showsDecoy(v.rowView(row(rowDecoys))), [])
eq('§3 the figure is the server\'s words, not the raw value', v.rowView(row({ value: 99, display: '6 loads' })).figure, '6 loads')
eq('§3 the rank is the server\'s', v.rowView(row({ rank: 5 })).rank, '5')
eq('§3 only a true isYou marks the row', [true, 'true', 1, undefined].map((isYou) => v.rowView(row({ isYou })).you), [true, false, false, false])
const NOT_RANKED_VIEW = { rank: v.NO_RANK, unit: '#706', figure: 'Not ranked', you: false }
eq('§3 a row without a rank reads "Not ranked"', v.rowView({ rank: null, unitLabel: '#706', value: null, display: 'Not ranked', isYou: false }), NOT_RANKED_VIEW)
eq('§3 a reason sent by mistake never shows', v.rowView({ rank: null, unitLabel: '#706', value: null, display: 'Accident on file', reason: 'decoy-reason', isYou: false }), NOT_RANKED_VIEW)
eq('§3 no rank, whatever the shape, reads the same', [0, -1, 1.5, '1', undefined].map((rank) => v.rowView(row({ rank, unitLabel: '#706' }))), new Array(5).fill(NOT_RANKED_VIEW))
eq('§3 rank only is allowed: an empty figure stays empty', v.rowView(row({ value: null, display: '' })).figure, '')
eq('§3 nothing at all still gives the four fields', v.rowView(null), { rank: v.NO_RANK, unit: '', figure: 'Not ranked', you: false })

// ── §4 the office board's tiles ──────────────────────────────────────────────
console.log('§4 the tiles')
const liveCat = (id, rows) => ({ id, status: 'live', listed: rows.length, rows })
const soonCat = (id, rows = []) => ({ id, status: 'coming-soon', listed: null, rows })
const FIGURES = [
  { rank: 1, unitLabel: '#701', value: 0.61, display: '$0.61/mi', isYou: false },
  { rank: 2, unitLabel: '#702', value: 8, display: '8% idle', isYou: true },
]
const boardAnswer = (categories) => ({ period: 'week', view: 'full', boards: [{ id: WEEK_ID, start: START, end: END, categories }] })
const tilesOf = (categories) => v.boardView(boardAnswer(categories), WEEK_ID).tiles
const SOON_IDS = ['least-fuel-cost', 'safety', 'lowest-idle']
const standard = tilesOf([liveCat('most-loads', [row()]), ...SOON_IDS.map((id) => soonCat(id))])
eq('§4 four tiles in order, each with its title', standard.map((t) => [t.id, t.title]), [['most-loads', 'Most loads'], ['least-fuel-cost', 'Least fuel cost'], ['safety', 'Safety'], ['lowest-idle', 'Lowest idle']])
eq('§4 exactly five fields on a tile', Object.keys(standard[0]), ['id', 'title', 'line', 'comingSoon', 'rows'])
eq('§4 Most loads is live, with its row', [standard[0].comingSoon, standard[0].rows.length], [false, 1])
eq('§4 the other three are "Coming soon" with one line each and no rows',
  standard.slice(1).map((t) => [t.comingSoon, t.line.length > 0, t.rows.length]), new Array(3).fill([true, true, 0]))
const stuffed = tilesOf([liveCat('most-loads', [row()]), ...SOON_IDS.map((id) => soonCat(id, FIGURES))])
eq('§4 a "Coming soon" tile drops any rows an answer holds', stuffed.slice(1).map((t) => t.rows.length), [0, 0, 0])
const forcedLive = tilesOf([liveCat('most-loads', [row()]), ...SOON_IDS.map((id) => liveCat(id, FIGURES))])
eq('§4 the other three stay "Coming soon" even if an answer calls them live', forcedLive.slice(1).map((t) => [t.comingSoon, t.rows.length]), new Array(3).fill([true, 0]))
eq('§4 Most loads not live in the answer shows no rows', tilesOf([soonCat('most-loads', [row()])])[0].rows.length, 0)
eq('§4 a missing category is "Coming soon"', tilesOf([]).map((t) => t.comingSoon), [true, true, true, true])
eq('§4 an unknown category never shows', tilesOf([liveCat('top-earner', FIGURES)]).map((t) => t.id).includes('top-earner'), false)

// ── §5 the office board ──────────────────────────────────────────────────────
console.log('§5 boardView()')
const twoWeeks = {
  boards: [
    { id: 'this-week', start: '2026-10-31', end: '2026-11-06', categories: [liveCat('most-loads', [row({ unitLabel: '#701' })])] },
    { id: 'last-week', start: '2026-10-24', end: '2026-10-30', categories: [liveCat('most-loads', [row({ unitLabel: '#702' })])] },
  ],
}
const monthAnswer = { boards: [{ id: 'this-month', start: '2026-11-01', end: '2026-11-30', categories: [liveCat('most-loads', [row({ unitLabel: '#703' })])] }] }
eq('§5 This week: its unit, range and closing line', [v.boardView(twoWeeks, 'this-week').tiles[0].rows[0].unit, v.boardView(twoWeeks, 'this-week').range, v.boardView(twoWeeks, 'this-week').closes], ['#701', 'Oct 31 – Nov 6', 'Week closes Fri 11:59 PM ET'])
eq('§5 Last week: its own unit and range, no closing line', [v.boardView(twoWeeks, 'last-week').tiles[0].rows[0].unit, v.boardView(twoWeeks, 'last-week').range, v.boardView(twoWeeks, 'last-week').closes], ['#702', 'Oct 24 – Oct 30', ''])
eq('§5 This month: its own unit and range, no closing line', [v.boardView(monthAnswer, 'this-month').tiles[0].rows[0].unit, v.boardView(monthAnswer, 'this-month').range, v.boardView(monthAnswer, 'this-month').closes], ['#703', 'Nov 1 – Nov 30', ''])
const outOfOrder = { boards: [{ id: WEEK_ID, start: START, end: END, categories: [liveCat('most-loads', [row({ rank: 3, unitLabel: '#703' }), row({ rank: 1, unitLabel: '#701' }), row({ rank: 1, unitLabel: '#702' })])] }] }
eq('§5 the server\'s order and ranks stand: the app neither sorts nor numbers', v.boardView(outOfOrder, WEEK_ID).tiles[0].rows.map((r) => [r.rank, r.unit]), [['3', '#703'], ['1', '#701'], ['1', '#702']])
eq('§5 a period the answer doesn\'t hold is null', [v.boardView(twoWeeks, 'this-month'), v.boardView(null, 'this-week'), v.boardView({}, 'this-week')], [null, null, null])
eq('§5 the URLs', [v.boardUrl('week'), v.boardUrl('month'), v.OWN_URL], ['/api/driver/performance/leaderboard?period=week', '/api/driver/performance/leaderboard?period=month', '/api/driver/me/performance'])
eq('§5 each period\'s answer', v.PERIODS.map((p) => v.periodKind(p.id)), ['week', 'week', 'month'])

// ── §6 his own week ──────────────────────────────────────────────────────────
console.log('§6 ownWeekView()')
const ownWeekView = fn('ownWeekView')
const week = (id, over) => ({
  id, start: START, end: END, credits: { value: 4.5, target: 7.5, required: 6, deliveries: 5, pickups: 4 }, left: 3, percent: 60, pace: 'on-track', newWeekNote: false, nextWeekStarts: 'Nov 7',
  loads: [
    { loadId: 'DP-1', pickup: { day: 'Mon', credits: 0.5 }, delivery: { day: 'Tue', credits: 0.5 } },
    { loadId: 'DP-2', pickup: { day: 'Thu', credits: 0.5 }, delivery: null },
    { loadId: 'DP-3', pickup: { note: 'last-week' }, delivery: { day: 'Sat', credits: 0.5 } },
    { loadId: 'DP-4', pickup: { note: 'not-counted' }, delivery: { day: 'Thu', credits: 0.5 } },
    { loadId: 'DP-5', pickup: { note: 'another-week' }, delivery: { day: 'Fri', credits: 0.5 } },
    { loadId: '', pickup: { day: 'Fri', credits: 0.5 }, delivery: null },
  ],
  targetLowered: false,
  ...over,
})
const COUNT_RULE = 'Each pickup counts 0.5 and each delivery 0.5.'
const answerOf = (...weeks) => ({ view: 'no-hours-data', creditWeights: { delivery: 0.5, pickup: 0.5 }, weeks })
const both = answerOf(week('this-week'), week('last-week', { start: '2026-10-24', end: '2026-10-30', credits: { value: 7.5, target: 7.5, required: 6, deliveries: 8, pickups: 7 }, left: null, percent: 100, pace: null, loads: [] }))
const thisWeek = ownWeekView(both, 'this-week') || {}
eq('§6 this week, in words', { ...thisWeek, loads: undefined }, {
  range: 'Oct 31 – Nov 6', count: '4.5 of 7.5 loads', pace: 'On Track', paceId: 'on-track', width: '60%',
  left: '3 loads left this week.', closes: 'Week closes Fri 11:59 PM ET', newWeek: '', rule: COUNT_RULE,
  lowered: '', requirement: '7.5 is the target. 6 is required.', title: 'What counted this week', empty: v.NO_LOADS_LINE,
})
eq('§6 each row shows both credits, or what became of the pickup', thisWeek.loads, [
  { title: 'Load DP-1', line: 'Picked up Mon 0.5 · Delivered Tue 0.5' },
  { title: 'Load DP-2', line: 'Picked up Thu 0.5' },
  { title: 'Load DP-3', line: 'Delivered Sat 0.5 · Pickup counted last week' },
  { title: 'Load DP-4', line: 'Delivered Thu 0.5 · Pickup not counted this week' },
  { title: 'Load DP-5', line: 'Delivered Fri 0.5 · Pickup counted in another week' },
  { title: 'Load', line: 'Picked up Fri 0.5' },
])
eq('§6 on last week\'s list the same note says last week', ownWeekView(answerOf(week('last-week', { left: null, pace: null, loads: [{ loadId: 'DP-4', pickup: { note: 'not-counted' }, delivery: { day: 'Thu', credits: 0.5 } }] })), 'last-week')?.loads, [
  { title: 'Load DP-4', line: 'Delivered Thu 0.5 · Pickup not counted last week' },
])
eq('§6 no screen says a pickup wasn\'t recorded', [/not recorded/i.test(libSrc), /not recorded/i.test(card)], [false, false])
eq('§6 no screen keeps the old count\'s words', [libSrc, card, bar].filter((src) => /delivered load counts|delivery counts 1|its pickup|about 5 loads/i.test(src)).length, 0)
const lastWeek = ownWeekView(both, 'last-week') || {}
eq('§6 last week: the final figure and its list, with no label and nothing left', { ...lastWeek, loads: undefined }, {
  range: 'Oct 24 – Oct 30', count: '7.5 of 7.5 loads', pace: '', paceId: '', width: '100%',
  left: '', closes: '', newWeek: '', rule: COUNT_RULE,
  lowered: '', requirement: '7.5 is the target. 6 is required.', title: 'What counted last week', empty: v.NO_LOADS_LAST_WEEK,
})
// The two figures are the server's: the app copies them, and whether time off rules it out is the server's to say.
const requiredFor = (target, required, id = 'this-week') => ownWeekView(answerOf(week(id, { left: id === 'this-week' ? 3 : null, pace: null, credits: { value: 3, target, required, deliveries: 3, pickups: 3 } })), id)?.requirement
eq('§6 the line reads the week\'s own figures', requiredFor(6, 4.5), '6 is the target. 4.5 is required.')
eq('§6 at the target\'s floor too', requiredFor(4.5, 3), '4.5 is the target. 3 is required.')
eq('§6 and on last week, that week\'s own', requiredFor(6, 4.5, 'last-week'), '6 is the target. 4.5 is required.')
eq('§6 the app never works required out from the target', requiredFor(7.5, 2), '7.5 is the target. 2 is required.')
eq('§6 no required figure from the server: the target alone, never a wrong one', [null, '6', undefined, {}].map((required) => requiredFor(7.5, required)), new Array(4).fill('7.5 is the target.'))
eq('§6 the target alone reads the week\'s own target', requiredFor(4.5, null), '4.5 is the target.')
eq('§6 the app never decides whether he can earn it: a figure at nothing still prints', ownWeekView(answerOf(week('this-week', { left: 7.5, credits: { value: 0, target: 7.5, required: 6, deliveries: 0, pickups: 0 } })), 'this-week')?.requirement, '7.5 is the target. 6 is required.')
// An answer read just before a deploy may still say what his invoice pays; no screen says anything about pay.
eq('§6 no view carries a line about pay, whatever the answer says of his invoice', [true, false, 'true', undefined].map((invoicePaysDays) => has(ownWeekView({ ...answerOf(week('this-week')), invoicePaysDays }, 'this-week'), 'not pay')), [false, false, false, false])
eq('§6 the app doesn\'t read what his invoice pays', /invoicePaysDays/.test(libSrc), false)
// The line only when the server flags it, and only where its words are true.
const loweredFor = (targetLowered) => ownWeekView(answerOf(week('this-week', { targetLowered })), 'this-week')?.lowered
eq('§6 a target the server flags as lowered says why', loweredFor(true), 'Your target is lower this week for your approved time off.')
eq('§6 no flag, no line', [false, 'true', 1, null, undefined].map(loweredFor), ['', '', '', '', ''])
eq('§6 the app never works it out from the figures', ownWeekView(answerOf(week('this-week', { credits: { value: 3, target: 6, deliveries: 3, pickups: 3 }, targetLowered: false })), 'this-week')?.lowered, '')
eq('§6 its words say this week, so last week never shows it', ownWeekView(answerOf(week('last-week', { left: null, pace: null, targetLowered: true })), 'last-week')?.lowered, '')
eq('§6 last week carries no label, even if an answer holds one', ownWeekView(answerOf(week('last-week', { pace: 'ahead', left: null })), 'last-week')?.pace, '')
const wordsFor = (over) => ownWeekView(answerOf(week('this-week', over)), 'this-week')
eq('§6 the three labels, as the server chose', ['ahead', 'on-track', 'needs-focus'].map((pace) => wordsFor({ pace })?.pace), ['Ahead of Pace', 'On Track', 'Needs Focus'])
eq('§6 no label from the server, none here', [wordsFor({ pace: null })?.pace, wordsFor({ pace: null })?.paceId], ['', ''])
eq('§6 a label it doesn\'t know never shows', ['out-of-reach', 'decoy-pace', 7, {}, undefined].map((pace) => wordsFor({ pace })?.pace), ['', '', '', '', ''])
eq('§6 the app never works the label out', [wordsFor({ pace: 'needs-focus', credits: { value: 7.5, target: 7.5, deliveries: 8, pickups: 7 }, left: 0, percent: 100 })?.pace], ['Needs Focus'])
eq('§6 what\'s left: plural', wordsFor({ left: 2 })?.left, '2 loads left this week.')
eq('§6 what\'s left: one load', wordsFor({ left: 1 })?.left, '1 load left this week.')
eq('§6 what\'s left: half a load', wordsFor({ left: 0.5 })?.left, '0.5 loads left this week.')
eq('§6 what\'s left: a figure ending in a half', wordsFor({ left: 2.5 })?.left, '2.5 loads left this week.')
eq('§6 at the target: says so, and no closing line', [wordsFor({ left: 0 })?.left, wordsFor({ left: 0 })?.closes], ['7.5 reached this week.', ''])
eq('§6 a lower target reads as its own figure', wordsFor({ credits: { value: 6, target: 6, deliveries: 6, pickups: 6 }, left: 0 })?.left, '6 reached this week.')
const lowWeek = wordsFor({ left: 6, newWeekNote: true, pace: 'needs-focus' })
eq('§6 more left than the days hold: a new week starts, and no closing line asking for more', [lowWeek?.left, lowWeek?.newWeek, lowWeek?.closes], ['6 loads left this week.', 'A new week starts Saturday, Nov 7.', ''])
eq('§6 only a true note shows it', [true, 'true', 1, undefined].map((newWeekNote) => wordsFor({ newWeekNote })?.newWeek), ['A new week starts Saturday, Nov 7.', '', '', ''])
eq('§6 the date is the server\'s: the app never works it out', wordsFor({ newWeekNote: true, nextWeekStarts: 'Dec 25' })?.newWeek, 'A new week starts Saturday, Dec 25.')
eq('§6 no date it can trust, no line, never a wrong one', [undefined, null, '', 7, 'decoy-date', 'Nov 7<b>', 'Nov 123'].map((nextWeekStarts) => wordsFor({ newWeekNote: true, nextWeekStarts })?.newWeek), new Array(7).fill(''))
eq('§6 and then the closing line reads instead', wordsFor({ newWeekNote: true, nextWeekStarts: null })?.closes, fn('weekClosesLine')())
eq('§6 no note, no date on the screen', wordsFor({ newWeekNote: false, nextWeekStarts: 'Dec 25' })?.newWeek, '')
eq('§6 the lib holds no calendar of its own', /\bDate\b|getDay|getUTCDay|toLocale|Intl\./.test(codeOf(libSrc)), false)
eq('§6 the count is the server\'s figure: the app never adds it up', wordsFor({ credits: { value: 9, target: 7.5, deliveries: 1, pickups: 1 } })?.count, '9 of 7.5 loads')
eq('§6 the width is the server\'s percent: the app never works it out', wordsFor({ credits: { value: 1, target: 7.5, deliveries: 1, pickups: 1 }, percent: 44 })?.width, '44%')
const decoyAnswer = {
  ...DECOYS, creditWeights: { delivery: 0.5, pickup: 0.5 },
  weeks: [{ ...week('this-week', {
    credits: { value: 4.5, target: 7.5, deliveries: 5, pickups: 4, ...DECOYS },
    loads: [{ ...DECOYS, loadId: 'DP-1', pickup: { ...DECOYS, day: 'Mon', credits: 0.5 }, delivery: { ...DECOYS, day: 'Tue', credits: 0.5 } }],
  }), ...DECOYS, gap: 'decoy-gap', expected: 41 }],
}
eq('§6 exactly these fields', Object.keys(ownWeekView(decoyAnswer, 'this-week') || {}), ['range', 'count', 'pace', 'paceId', 'width', 'left', 'closes', 'newWeek', 'rule', 'lowered', 'requirement', 'title', 'empty', 'loads'])
eq('§6 exactly two fields on a row', Object.keys(ownWeekView(decoyAnswer, 'this-week')?.loads?.[0] || {}), ['title', 'line'])
eq('§6 no name, hours, score, tier, pay, broker, rate, rank or other driver\'s figure gets through, whatever the answer holds', showsDecoy(ownWeekView(decoyAnswer, 'this-week')), [])
eq('§6 no answer, no card', [ownWeekView(null, 'this-week'), ownWeekView({}, 'this-week'), ownWeekView({ weeks: [] }, 'this-week'), ownWeekView(both, 'this-month')], [null, null, null, null])
const broken = {
  'a value that isn\'t a number': { credits: { value: '4.5', target: 7.5, deliveries: 3, pickups: 3 } },
  'a target that isn\'t a number': { credits: { value: 4.5, target: null, deliveries: 3, pickups: 3 } },
  'no percent': { percent: undefined },
  'a percent past 100': { percent: 140 },
  'a negative percent': { percent: -1 },
  'what\'s left that isn\'t a number': { left: '3' },
  'no list': { loads: undefined },
  'a list that isn\'t one': { loads: 'DP-1' },
  'a row with no credit on its delivery': { loads: [{ loadId: 'DP-1', pickup: { note: 'not-recorded' }, delivery: { day: 'Mon' } }] },
  'a row with a bad pickup credit': { loads: [{ loadId: 'DP-1', pickup: { day: 'Mon', credits: '0.5' }, delivery: null }] },
  'a row whose pickup note it doesn\'t know': { loads: [{ loadId: 'DP-1', pickup: { note: 'decoy-note' }, delivery: { day: 'Mon', credits: 0.5 } }] },
  'the old note, which could be false': { loads: [{ loadId: 'DP-1', pickup: { note: 'not-recorded' }, delivery: { day: 'Mon', credits: 0.5 } }] },
  'a row with neither': { loads: [{ loadId: 'DP-1', pickup: null, delivery: null }] },
}
for (const [says, over] of Object.entries(broken)) eq(`§6 ${says}: no card, never a wrong number`, wordsFor(over), null)
eq('§6 no weights, no card', ownWeekView({ weeks: both.weeks }, 'this-week'), null)

// ── §7 the bar ───────────────────────────────────────────────────────────────
console.log('§7 weekBarView() and weekFromAnswer()')
const weekBarView = fn('weekBarView')
eq('§7 the bar\'s words', weekBarView(both), { text: 'This week: 4.5 of 7.5 loads', pace: 'On Track', paceId: 'on-track', width: '60%', color: '' })
eq('§7 its color is the server\'s, one of the four', ['red', 'orange', 'green', 'blue'].map((barColor) => weekBarView(answerOf(week('this-week', { barColor })))?.color), ['red', 'orange', 'green', 'blue'])
eq('§7 a color it doesn\'t know, or none, keeps the plain fill', ['purple', 'RED', '#dc2626', null, undefined, 3].map((barColor) => weekBarView(answerOf(week('this-week', { barColor })))?.color), ['', '', '', '', '', ''])
eq('§7 the app never works the color out from the figure', weekBarView(answerOf(week('this-week', { barColor: 'blue', credits: { value: 1, target: 7.5, deliveries: 1, pickups: 1 } })))?.color, 'blue')
eq('§7 the bar keeps its words whatever its color, so the color is never all it says', weekBarView(answerOf(week('this-week', { barColor: 'red' })))?.text, 'This week: 4.5 of 7.5 loads')
eq('§7 no label, none on the bar', weekBarView(answerOf(week('this-week', { pace: null })))?.pace, '')
eq('§7 always this week, whichever order they come in', weekBarView(answerOf(week('last-week', { credits: { value: 1, target: 7.5, deliveries: 1, pickups: 1 } }), week('this-week')))?.text, 'This week: 4.5 of 7.5 loads')
eq('§7 a lower target reads as its own figure', weekBarView(answerOf(week('this-week', { credits: { value: 3, target: 6, deliveries: 3, pickups: 3 }, percent: 50 })))?.text, 'This week: 3 of 6 loads')
eq('§7 no decoy reaches the bar', showsDecoy(weekBarView(decoyAnswer)), [])
eq('§7 exactly five fields', Object.keys(weekBarView(both) || {}), ['text', 'pace', 'paceId', 'width', 'color'])
eq('§7 what\'s required is words on the tab only: no mark on the bar', has(weekBarView(both), 'required'), false)
eq('§7 no read of it in the bar', /required|requirement/i.test(bar), false)
eq('§7 neither view of his week carries an hours-of-service line', [ownWeekView(both, 'this-week'), ownWeekView(both, 'last-week'), weekBarView(both)].filter((view) => /hours of service|never drive past/i.test(JSON.stringify(view))).length, 0)
for (const [says, over] of Object.entries(broken)) eq(`§7 ${says}: no bar, never a wrong number`, weekBarView(answerOf(week('this-week', over))), null)
eq('§7 no answer, no bar', [weekBarView(null), weekBarView({}), weekBarView({ weeks: [] }), weekBarView(answerOf(week('last-week')))], [null, null, null, null])
const weekFromAnswer = fn('weekFromAnswer')
eq('§7 only a Driver\'s 200 gives the bar its answer', weekFromAnswer('Driver', 200, both) === both, true)
eq('§7 a failed read clears it, so the bar hides', [404, 401, 403, 429, 500, 503, 0].map((status) => weekFromAnswer('Driver', status, both)), new Array(7).fill(null))
eq('§7 a Super Admin\'s board is never a week', weekFromAnswer('Super Admin', 200, both), null)

// ── §8 who gets the tab ──────────────────────────────────────────────────────
console.log('§8 who gets the tab')
eq('§8 a Driver asks with his own route, never the board', v.tabProbeUrl('Driver'), '/api/driver/me/performance')
eq('§8 a Super Admin on /driver asks with the board', v.tabProbeUrl('Super Admin'), '/api/driver/performance/leaderboard?period=week')
eq('§8 no other role asks', ['Dispatcher', 'Investor', 'KPI Viewer', '', undefined, null].map((role) => v.tabProbeUrl(role)), ['', '', '', '', '', ''])
eq('§8 only a Driver has a week of his own', ['Driver', 'Super Admin', 'Dispatcher', undefined].map((role) => v.showsMyWeek(role)), [true, false, false, false])
eq('§8 a 200 shows the tab', [v.tabAfterAnswer(200, false), v.tabAfterAnswer(200, true)], [true, true])
eq('§8 404 (the switch off, or not eligible), 401 and 403 hide it', [404, 401, 403].flatMap((s) => [v.tabAfterAnswer(s, true), v.tabAfterAnswer(s, false)]), [false, false, false, false, false, false])
eq('§8 a failure says nothing: a hidden tab stays hidden', [503, 500, 429, 0].map((s) => v.tabAfterAnswer(s, false)), [false, false, false, false])
eq('§8 a failure says nothing: a shown tab stays', [503, 500, 429, 0].map((s) => v.tabAfterAnswer(s, true)), [true, true, true, true])
eq('§8 what counts as gone', [404, 401, 403, 503, 200, 0].map(v.isGoneAnswer), [true, true, true, false, false, false])

// ── §9 BottomNav.vue ─────────────────────────────────────────────────────────
console.log('§9 BottomNav.vue')
const navScript = scriptOf(nav)
const baseTabsSrc = (navScript.match(/const baseTabs = \[([\s\S]*?)\n\]/) || [])[1] || ''
eq('§9 the five tabs, in their order', [...baseTabsSrc.matchAll(/key: '(\w+)', label: '(\w+)'/g)].map((m) => [m[1], m[2]]),
  [['loads', 'Loads'], ['notifications', 'Alerts'], ['kit', 'Kit'], ['messages', 'Messages'], ['invoices', 'Invoices']])
eq('§9 showPerformance defaults off', /showPerformance: \{ type: Boolean, default: false \}/.test(navScript), true)
eq('§9 Performance joins only with the prop, last', navScript.includes('computed(() => (props.showPerformance ? [...baseTabs, performanceTab] : baseTabs))'), true)
eq('§9 the tab is named Past Performance', /const performanceTab = \{ key: 'performance', label: 'Past Performance'/.test(navScript), true)
eq('§9 a label too long for its sixth of the bar breaks at its space, centred', /:deep\(\.van-tabbar-item__text\) \{\s*text-align: center;\s*\}/.test(styleOf(nav)), true)
eq('§9 no trophy: this isn\'t a competition', /&#127942;|🏆/.test(nav), false)

// ── §10 DriverView.vue ───────────────────────────────────────────────────────
console.log('§10 DriverView.vue')
const viewScript = scriptOf(view)
const viewTemplate = templateOf(view)
eq('§10 the tab starts hidden', viewScript.includes('const performanceTab = ref(false)'), true)
eq('§10 the nav shows it only on the answer', viewTemplate.includes(':show-performance="performanceTab"'), true)
eq('§10 the panel needs both the tab chosen and the answer', viewTemplate.includes('v-if="currentTab === \'performance\' && performanceTab"'), true)
const panel = (viewTemplate.match(/data-testid="perf-panel">([\s\S]*?)<\/section>/) || [])[1] || ''
eq('§10 the panel\'s header is the tab\'s name', panel.includes('<div class="section-header">Past Performance</div>'), true)
eq('§10 a Driver gets his own week and nothing else in the panel', panel.includes('<DriverPerformanceTab v-if="showsMyWeek(auth.user?.role)" @gone="performanceTab = false" />'), true)
eq('§10 the office board is for anyone else who reaches it, a Super Admin', panel.includes('<DriverPerformanceBoard v-else @gone="performanceTab = false" />'), true)
const barTag = (viewTemplate.match(/<DriverWeekBar[^>]*>/) || [''])[0]
eq('§10 the bar\'s place: a Driver\'s, held from the first paint, given its view and nothing else, and it opens the tab', barTag, '<DriverWeekBar v-if="weekSlotHeld && showsMyWeek(auth.user?.role)" :bar="weekBar" @open="handleTabSwitch(\'performance\')" />')
const barAt = viewTemplate.indexOf('<DriverWeekBar')
const barChain = chainTo(viewTemplate, 'v-if="weekSlotHeld') || []
eq('§10 one bar, so the list and a load\'s page show the same component with the same answer', (viewTemplate.match(/<DriverWeekBar\b/g) || []).length, 1)
const loadsAt = barChain.findIndex((attrs) => attrs.includes('v-if="currentTab === \'loads\'"'))
eq('§10 it sits on the Loads tab, directly in its section, outside both the load page and the list, so it shows on each',
  [loadsAt >= 0, barChain.length - loadsAt], [true, 2])
eq('§10 at the top of a load\'s own page, with its status and POD buttons below it, inside LoadDetail as they were',
  [barAt > 0 && barAt < viewTemplate.indexOf('<LoadDetail'), /StatusStepper/.test(read(path.join(ROOT, 'client', 'src', 'components', 'driver', 'LoadDetail.vue'))), viewTemplate.indexOf('<LoadDetail') < viewTemplate.indexOf('<StatusStepper') || !viewTemplate.includes('<StatusStepper')], [true, true, true])
eq('§10 and above the load list', barAt > 0 && barAt < viewTemplate.indexOf('class="load-sub-tabs"'), true)
eq('§10 LoadDetail itself doesn\'t carry a second one', /DriverWeekBar/.test(read(path.join(ROOT, 'client', 'src', 'components', 'driver', 'LoadDetail.vue'))), false)
eq('§10 the bar\'s view is only there while the tab is', viewScript.includes('const weekBar = computed(() => (performanceTab.value ? weekBarView(performanceWeek.value) : null))'), true)
const check = (viewScript.match(/async function checkPerformanceTab\(\) \{([\s\S]*?)\n\}/) || [])[1] || ''
eq('§10 the check asks by role and never on the onboarding screen', check.includes('tabProbeUrl(role)') && check.includes('if (!url || isOnboarding.value) return'), true)
eq('§10 the answer decides the tab', check.includes('performanceTab.value = tabAfterAnswer(status, performanceTab.value)'), true)
eq('§10 and the bar, on every answer: a failed read clears it', /^\s*performanceWeek\.value = weekFromAnswer\(role, status, answer\)$/m.test(check), true)
eq('§10 the bar\'s answer starts empty, in a ref of the view\'s own', viewScript.includes('const performanceWeek = ref(null)'), true)
// Nothing under his thumb moves: the place is held from the first paint, a read only notes what
// it should be, and it changes only when the page itself changes.
eq('§10 the bar\'s place is held from the first paint', viewScript.includes('const weekSlotHeld = ref(true)'), true)
eq('§10 a read only notes what the place should be, failures leaving it as it was', check.includes('weekSlotWanted = tabAfterAnswer(status, weekSlotWanted)'), true)
eq('§10 and no read ever moves it', check.includes('weekSlotHeld'), false)
const placeWatch = (viewScript.match(/watch\(\(\) => \(currentTab\.value === 'loads' \? \(detailLoad\.value \? 'load' : 'list'\) : ''\), \(place\) => \{([\s\S]*?)\n\}\)/) || [])[1] || ''
eq('§10 it changes only with the page', [placeWatch.includes('weekSlotHeld.value = weekSlotWanted'), (viewScript.match(/weekSlotHeld\.value =/g) || []).length], [true, 1])
eq('§10 an older read never overwrites a newer one', check.includes('const mine = ++performanceReads') && check.includes('if (!isMounted || mine !== performanceReads) return'), true)
const initial = (viewScript.match(/async function attemptInitialLoad\(\) \{([\s\S]*?)\n\}/) || [])[1] || ''
const afterLoad = initial.indexOf('checkPerformanceTab()')
eq('§10 the check runs after the driver\'s data has loaded, and only then', afterLoad > initial.indexOf('await driverStore.loadData()') && afterLoad < initial.indexOf('} catch {'), true)
const refetch = (viewScript.match(/function scheduleDriverRefetch\(\) \{([\s\S]*?)\n\}/) || [''])[0]
eq('§10 a refetch of his loads reads his week again', refetch.includes('driverStore.loadData()') && refetch.includes('checkPerformanceTab()'), true)
eq('§10 a phone coming back to the app refetches, so it asks again', (viewScript.match(/function onVisibilityChange\(\) \{([\s\S]*?)\n\}/) || [''])[0].includes('scheduleDriverRefetch()'), true)
eq('§10 moving between the list and a load\'s page reads his week again', /watch\(\(\) => \(currentTab\.value === 'loads' \? \(detailLoad\.value \? 'load' : 'list'\) : ''\), \(place\) => \{[^}]*if \(place\) checkPerformanceTab\(\)/.test(viewScript), true)
const statusFn = (viewScript.match(/async function handleStatusUpdate\(\{ newStatus, load \}\) \{([\s\S]*?)\n\}/) || [])[1] || ''
eq('§10 a status he sets on a load\'s page moves the bar above it, only once it has saved', statusFn.indexOf('await driverStore.updateStatus') >= 0 && statusFn.indexOf('checkPerformanceTab()') > statusFn.indexOf('await driverStore.updateStatus') && statusFn.indexOf('checkPerformanceTab()') < statusFn.indexOf('} catch (err)'), true)
eq('§10 and so does a refresh', ((viewScript.match(/async function handleRefresh\(\) \{([\s\S]*?)\n\}/) || [])[1] || '').includes('checkPerformanceTab()'), true)
eq('§10 a tab taken away goes back to Loads', /watch\(performanceTab, \(shown\) => \{\s*if \(!shown && currentTab\.value === 'performance'\) handleTabSwitch\('loads'\)/.test(viewScript), true)
eq('§10 the store never holds it', read(path.join(ROOT, 'client', 'src', 'stores', 'driver.js')).includes('performance'), false)
eq('§10 the view keeps it in a ref alone: no storage of any kind', /(localStorage|sessionStorage)[^\n]*[pP]erformance|[pP]erformance[^\n]*(localStorage|sessionStorage)/.test(viewScript), false)

// ── §11 DriverPerformanceTab.vue ─────────────────────────────────────────────
console.log('§11 DriverPerformanceTab.vue')
const cardTemplate = templateOf(card)
const cardScript = scriptOf(card)
const printed = [...cardTemplate.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]).sort()
eq('§11 it prints only these, so a name or a figure can\'t be added by accident', [...new Set(printed)], [
  'DRIVE_HOURS_LINE', 'FAILED_LINE', 'PRIVATE_LINE', 'TARGET_LINE', 'TELL_DISPATCH_LINE', 'THIS_WEEK_TITLE',
  'item.line', 'item.title', 'past.countedFrom', 'past.title', 'row.count', 'row.hours', 'row.range',
  'week.closes', 'week.count', 'week.empty', 'week.left', 'week.lowered', 'week.newWeek', 'week.pace', 'week.range', 'week.requirement', 'week.rule', 'week.title',
].sort())
eq('§11 no line about pay on the tab', /NOT_PAY_LINE|NOT_PAY_DAYS_LINE|notPay|perf-not-pay|invoice pays/.test(card), false)
eq('§11 the lowered-target line only when the view has one, right after the target line', /\{\{ TARGET_LINE \}\}<\/p>\s*<p v-if="week\.lowered"[^>]*>\{\{ week\.lowered \}\}<\/p>/.test(cardTemplate), true)
eq('§11 no v-html', cardTemplate.includes('v-html'), false)
eq('§11 it never names the board: no ranking can reach a driver\'s screen', /boardUrl|boardView|BOARD_URL|rowView|tileView|leaderboard|\.tiles|\brank\b|unitLabel|isYou|\bYOU\b|COMING_SOON|CATEGORIES|\bPERIODS\b/.test(card), false)
eq('§11 its one read is his own week', [...cardScript.matchAll(/api\.\w+\(([^)]*)\)/g)].map((m) => m[1]), ['OWN_URL'])
eq('§11 it holds no name to show: no store, session or driver name', /useDriverStore|useAuthStore|driverStore|driverName|auth\./.test(card), false)
eq('§11 rows go through the view: no raw answer in the template', /\.answer|\.weeks|\.credits|\.percent|\.pickup|\.delivery/.test(cardTemplate), false)
eq('§11 the views come from the lib: this week\'s and the past weeks\', from the one answer', [cardScript.includes("ownWeekView(answer.value, 'this-week')"), cardScript.includes('pastWeeksView(answer.value)')], [true, true])
eq('§11 read only: no write of any kind', /api\.(post|put|patch|del|request)\b|method:/.test(cardScript), false)
eq('§11 kept on the phone nowhere: no storage of any kind', /localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(card + libSrc), false)
eq('§11 no nudges: no timer, poll, countdown, socket or notification', /setTimeout|setInterval|requestAnimationFrame|useSocket|socket\.|Notification\b|countdown/i.test(card + libSrc), false)
const ARITHMETIC = /\s[*/%+-]\s|\+\+|--|\bMath\.|\.reduce\(|\.sort\(|\.toSorted\(|\.reverse\(|\.toFixed\(|parseFloat|parseInt|\bNumber\(|\.length\s*[*/%+-]/
eq('§11 the lib computes nothing', ARITHMETIC.test(codeOf(libSrc)), false)
eq('§11 the card computes nothing', ARITHMETIC.test(codeOf(cardScript)), false)
eq('§11 the template computes nothing', [...cardTemplate.matchAll(/\{\{([^}]*)\}\}/g)].filter((m) => /[*/%+-]/.test(m[1])).length, 0)
eq('§11 the fill is the server\'s percent', /:style="\{ width: week\.width \}"/.test(cardTemplate), true)
eq('§11 no hours-of-service line on the tab', chainTo(cardTemplate, 'data-testid="perf-hos"'), null)
eq('§11 the target, the requirement line, drive hours and the privacy line sit together', [cardTemplate.includes('{{ TARGET_LINE }}'), cardTemplate.includes('{{ week.requirement }}'), cardTemplate.includes('{{ DRIVE_HOURS_LINE }}'), cardTemplate.includes('{{ PRIVATE_LINE }}')], [true, true, true, true])
eq('§11 the requirement line has its own place, right after the lowered-target line', /\{\{ week\.lowered \}\}<\/p>\s*<p class="perf-note" data-testid="perf-requirement">\{\{ week\.requirement \}\}<\/p>/.test(cardTemplate), true)
eq('§11 the label only when the view has one', /v-if="week\.pace"/.test(cardTemplate), true)
const placeOf = (id) => cardTemplate.indexOf(`data-testid="${id}"`)
const order = ['perf-this-week-title', 'perf-week', 'perf-counted', 'perf-past', 'perf-past-title', 'perf-past-week', 'perf-counted-from', 'perf-private'].map(placeOf)
eq('§11 this week on top, then the past weeks under their heading, the line naming what wasn\'t counted, and the privacy line last',
  [order.every((at) => at > 0), order.every((at, i) => i === 0 || at > order[i - 1])], [true, true])
eq('§11 no toggle between weeks any more', /van-tabs|van-tab\b|OWN_PERIODS|periodId/.test(card), false)
eq('§11 the past weeks only when the view has them, a row each, keyed by the week', [/<section v-if="past" class="perf-past"/.test(cardTemplate), /<li v-for="row in past\.rows" :key="row\.key"/.test(cardTemplate)], [true, true])
eq('§11 each past week\'s days, figure and hours line, as the view words them', /\{\{ row\.range \}\}[\s\S]*\{\{ row\.count \}\}[\s\S]*\{\{ row\.hours \}\}/.test(cardTemplate), true)
eq('§11 no figure on a past week but its own: no fill, no label, no color', /past[\s\S]*(perf-fill|perf-pace|data-color)/.test(cardTemplate.slice(cardTemplate.indexOf('data-testid="perf-past"'))), false)
eq('§11 Try again is 44 px', /\.perf-retry \{[^}]*min-height: 44px/.test(styleOf(card)), true)
eq('§11 no red, on any word', /\bred\b|danger|#ef4444|#dc2626|#b91c1c|#f87171|#ee0a24/i.test(card), false)
eq('§11 the server\'s "gone" hides the tab', cardScript.includes("if (isGoneAnswer(err.status)) emit('gone')"), true)

// ── §12 DriverWeekBar.vue ────────────────────────────────────────────────────
console.log('§12 DriverWeekBar.vue')
const barTemplate = templateOf(bar)
const barScript = scriptOf(bar)
eq('§12 it prints only the view\'s words', [...new Set([...barTemplate.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]))].sort(), ['bar.pace', 'bar.text'])
eq('§12 it is given its view, or none, and reads nothing', [/bar: \{ type: Object, default: null \}/.test(barScript), /useApi|fetch\(|axios|XMLHttpRequest/.test(bar)], [true, false])
// The slot holds a fixed height whatever is in it, so the bar appearing or going moves nothing.
const slotRule = (styleOf(bar).match(/\.week-bar-slot \{([^}]*)\}/) || [])[1] || ''
eq('§12 its place is a fixed height, with or without the bar', [/(^|\n)\s*height: 4\.75rem;/.test(slotRule), /min-height/.test(slotRule)], [true, false])
eq('§12 the place is always there; only the button comes and goes', [/^\s*<div class="week-bar-slot" data-testid="perf-bar-slot">/m.test(barTemplate), /<button v-if="bar" type="button"/.test(barTemplate)], [true, true])
const barRule = (styleOf(bar).match(/\.week-bar \{([^}]*)\}/) || [])[1] || ''
eq('§12 the button fills that height and can\'t push past it', [/(^|\n)\s*height: 100%;/.test(barRule), /box-sizing: border-box;/.test(barRule), /overflow: hidden;/.test(barRule), /margin/.test(barRule)], [true, true, true, false])
eq('§12 its top row never wraps, so a label coming or going can\'t change its height', /\.week-bar-top \{[^}]*flex-wrap: nowrap;/.test(styleOf(bar)), true)
eq('§12 tapping it asks to open the tab', /@click="emit\('open'\)"/.test(barTemplate) && /defineEmits\(\['open'\]\)/.test(barScript), true)
eq('§12 a real button, 44 px or more', [/<button v-if="bar" type="button"/.test(barTemplate), /\.week-bar \{[^}]*min-height: 44px/.test(styleOf(bar))], [true, true])
eq('§12 the fill is the server\'s percent', /:style="\{ width: bar\.width \}"/.test(barTemplate), true)
eq('§12 no hours-of-service line on it', /bar\.hos|week-bar-hos/.test(bar), false)
eq('§12 the label only when the view has one', /v-if="bar\.pace"/.test(barTemplate), true)
eq('§12 no motion, nudge or countdown', /transition|animation|@keyframes|setTimeout|setInterval|requestAnimationFrame|countdown|\bpulse\b/i.test(bar), false)
eq('§12 no store, name or storage', /useDriverStore|useAuthStore|driverName|localStorage|sessionStorage/.test(bar), false)
const FILL_COLORS = [...styleOf(bar).matchAll(/\.week-bar-fill\[data-color='(\w+)'\] \{ background: (#[0-9a-f]{6}); \}/g)].map((m) => [m[1], m[2]])
eq('§12 the fill takes the server\'s four colors, and only those', FILL_COLORS, [['red', '#dc2626'], ['orange', '#ea580c'], ['green', '#16a34a'], ['blue', '#2563eb']])
eq('§12 the fill reads the view\'s color, or none, which keeps the plain fill', [/<span class="week-bar-fill" data-testid="perf-bar-fill" :data-color="bar\.color \|\| null" :style="\{ width: bar\.width \}"><\/span>/.test(barTemplate), /\.week-bar-fill \{[^}]*background: #0369a1;/.test(styleOf(bar))], [true, true])
const barWithoutFill = bar.replace(/\.week-bar-fill\[data-color='\w+'\] \{ background: #[0-9a-f]{6}; \}/g, '').replace(/data-color|bar\.color/g, '')
eq('§12 nothing else on the bar is red: its label stays a pale chip that never scolds', /\bred\b|danger|#ef4444|#dc2626|#b91c1c|#f87171|#ee0a24/i.test(barWithoutFill), false)
eq('§12 it computes nothing', [ARITHMETIC.test(codeOf(barScript)), [...barTemplate.matchAll(/\{\{([^}]*)\}\}/g)].filter((m) => /[*/%+-]/.test(m[1])).length], [false, 0])

// ── §13 DriverPerformanceBoard.vue ───────────────────────────────────────────
console.log('§13 DriverPerformanceBoard.vue')
const boardTemplate = templateOf(board)
const boardScript = scriptOf(board)
eq('§13 it prints only these',[...new Set([...boardTemplate.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]))].sort(), [
  'COMING_SOON', 'EMPTY_LINE', 'FAILED_LINE', 'HOS_LINE', 'YOU',
  'board.closes', 'board.range', 'row.figure', 'row.rank', 'row.unit', 'tile.line', 'tile.title',
].sort())
eq('§13 no own week on it', /ownWeekView|OWN_URL|showMyWeek|week\./.test(board), false)
eq('§13 a period is read once, when first chosen', boardScript.includes("if (boards[which].state === 'idle') loadBoard(which)"), true)
eq('§13 the views come from the lib', boardScript.includes('boardView(boards[kind.value].answer, periodId.value)'), true)
eq('§13 read only, nothing stored', [/api\.(post|put|patch|del|request)\b|method:/.test(boardScript), /localStorage|sessionStorage/.test(board)], [false, false])
eq('§13 it computes nothing', ARITHMETIC.test(codeOf(boardScript)), false)
const boardHos = chainTo(boardTemplate, 'data-testid="perf-hos"')
eq('§13 the hours-of-service line stays, outside every condition', [!!boardHos, (boardHos || []).filter((attrs) => /\bv-(if|else|else-if|show)\b/.test(attrs)).length], [true, 0])
eq('§13 it prints the fixed words', /data-testid="perf-hos">\{\{ HOS_LINE \}\}<\/p>/.test(boardTemplate), true)
eq('§13 the three choices and a row are 44 px', [/--van-tabs-line-height: 44px/.test(styleOf(board)), /\.perf-row \{[^}]*min-height: 44px/.test(styleOf(board))], [true, true])
eq('§13 the server\'s "gone" hides the tab', boardScript.includes("if (isGoneAnswer(err.status)) emit('gone')"), true)

// ── §14 the real server rules through the real views ─────────────────────────
console.log('§14 lib/driver-performance.js through the views')
const mostLoads = server.categoryById('most-loads')
const { rank: _r, unitLabel: _u, ...entryDecoys } = DECOYS
const entries = [
  { ...entryDecoys, driverId: 11, label: '#701', ownLabel: '#701', value: 6 },
  { ...entryDecoys, driverId: 12, label: '#702', ownLabel: '#702', value: 3 },
  { ...entryDecoys, driverId: 13, label: '#703 (1)', ownLabel: '#703 (1, to Nov 2)', value: 3 },
  { ...entryDecoys, driverId: 14, label: '#704', ownLabel: '#704', value: null },
  { ...entryDecoys, driverId: 15, label: '#705', ownLabel: '#705', value: 0 },
]
const ranked = server.rankEntries(mostLoads, entries)
const projected = (viewer) => ({
  boards: [{ id: WEEK_ID, start: START, end: END, categories: server.CATEGORIES.map((c) => server.projectCategory(c, c.live ? ranked : [], viewer)) }],
})
const tilesFor = (viewer) => v.boardView(projected(viewer), WEEK_ID).tiles
eq('§14 a Super Admin has no row of his own', tilesFor(null)[0].rows.filter((r) => r.you).length, 0)
eq('§14 the other three are "Coming soon"', tilesFor(null).slice(1).map((t) => [t.id, t.comingSoon, t.rows.length]), SOON_IDS.map((id) => [id, true, 0]))
eq('§14 nothing else on an entry reaches the board', showsDecoy(tilesFor(null)), [])
if (typeof server.personalWeek === 'function') {
  const serverWeek = server.personalWeek({
    id: 'this-week', start: START, end: END, today: '2026-11-04', deliveries: 2, pickups: 3, offDays: [], openLoad: true,
    loads: [
      server.countedLoad({ loadId: 'DP-1', pickupDay: '2026-11-02', deliveryDay: '2026-11-03' }),
      server.countedLoad({ loadId: 'DP-2', pickupDay: '', deliveryDay: '2026-11-04', pickupNote: 'last-week' }),
      server.countedLoad({ loadId: 'DP-3', pickupDay: '2026-11-04', deliveryDay: '' }),
      server.countedLoad({ loadId: 'DP-4', pickupDay: '2026-11-04', deliveryDay: '' }),
    ],
  })
  const realAnswer = { view: 'no-hours-data', creditWeights: { ...server.CREDIT_WEIGHTS }, weeks: [serverWeek] }
  const offWeek = server.personalWeek({ id: 'this-week', start: START, end: END, today: '2026-11-04', deliveries: 3, pickups: 0, offDays: ['2026-11-05'], openLoad: true, loads: [] })
  const offAnswer = { view: 'no-hours-data', creditWeights: { ...server.CREDIT_WEIGHTS }, weeks: [offWeek] }
  eq('§14 a real day off: his lower figure, and the line that says why', [ownWeekView(offAnswer, 'this-week')?.count, ownWeekView(offAnswer, 'this-week')?.lowered], ['1.5 of 6 loads', 'Your target is lower this week for your approved time off.'])
  eq('§14 a real uncounted pickup, in true words', ownWeekView({ ...realAnswer, weeks: [{ ...serverWeek, loads: [server.countedLoad({ loadId: 'DP-5', pickupDay: '', deliveryDay: '2026-11-04' })] }] }, 'this-week')?.loads, [{ title: 'Load DP-5', line: 'Delivered Wed 0.5 · Pickup not counted this week' }])
  eq('§14 the server\'s own week, in words', [ownWeekView(realAnswer, 'this-week')?.count, ownWeekView(realAnswer, 'this-week')?.left, ownWeekView(realAnswer, 'this-week')?.pace, ownWeekView(realAnswer, 'this-week')?.width], ['2.5 of 7.5 loads', '5 loads left this week.', 'Needs Focus', '33%'])
  eq('§14 and its rows', ownWeekView(realAnswer, 'this-week')?.loads, [
    { title: 'Load DP-1', line: 'Picked up Mon 0.5 · Delivered Tue 0.5' },
    { title: 'Load DP-2', line: 'Delivered Wed 0.5 · Pickup counted last week' },
    { title: 'Load DP-3', line: 'Picked up Wed 0.5' },
    { title: 'Load DP-4', line: 'Picked up Wed 0.5' },
  ])
  eq('§14 the bar', weekBarView(realAnswer), { text: 'This week: 2.5 of 7.5 loads', pace: 'Needs Focus', paceId: 'needs-focus', width: '33%', color: 'red' })
  // D's bands through the real rules, at each edge: credits move in halves, so each figure has one color.
  const realBar = (deliveries, pickups) => weekBarView({ ...realAnswer, weeks: [server.personalWeek({ id: 'this-week', start: START, end: END, today: '2026-11-04', deliveries, pickups, offDays: [], openLoad: true, loads: [] })] })
  eq('§14 the bar\'s color from the real rules: 3.5 red, 4 orange, 5.5 orange, 6 green, 7.5 green, 8 blue',
    [[4, 3], [4, 4], [6, 5], [6, 6], [8, 7], [8, 8]].map(([deliveries, pickups]) => [realBar(deliveries, pickups)?.text, realBar(deliveries, pickups)?.color]), [
      ['This week: 3.5 of 7.5 loads', 'red'], ['This week: 4 of 7.5 loads', 'orange'], ['This week: 5.5 of 7.5 loads', 'orange'],
      ['This week: 6 of 7.5 loads', 'green'], ['This week: 7.5 of 7.5 loads', 'green'], ['This week: 8 of 7.5 loads', 'blue'],
    ])
  eq('§14 a closed week has no color, so only the open week\'s bar is colored', server.personalWeek({ id: 'last-week', start: START, end: END, today: '2026-11-20', deliveries: 8, pickups: 8, offDays: [], openLoad: false, loads: [] }).barColor, null)
  eq('§14 the line on how it counts, from the server\'s weights', ownWeekView(realAnswer, 'this-week')?.rule, COUNT_RULE)
  eq('§14 the line on what\'s required, from the server\'s own figures', [ownWeekView(realAnswer, 'this-week')?.requirement, ownWeekView(offAnswer, 'this-week')?.requirement], ['7.5 is the target. 6 is required.', '6 is the target. 4.5 is required.'])
  // Whether time off makes it impossible comes from the real rules, through the view's own words.
  const offFrom = (from, n) => Array.from({ length: n }, (_x, i) => server.addDays(from, i))
  const realRequirement = (today, deliveries, offDays = []) => ownWeekView({ ...realAnswer, weeks: [server.personalWeek({ id: 'this-week', start: START, end: END, today, deliveries, pickups: 0, offDays, openLoad: true, loads: [] })] }, 'this-week')?.requirement
  eq('§14 five days off, with two open days that hold it, whatever day he reads it', [realRequirement('2026-10-31', 0, offFrom('2026-11-02', 5)), realRequirement('2026-11-06', 0, offFrom('2026-11-02', 5))], new Array(2).fill('4.5 is the target. 3 is required.'))
  eq('§14 six days off: the target alone', realRequirement('2026-11-03', 0, offFrom('2026-10-31', 6)), '4.5 is the target.')
  eq('§14 seven days off: the target alone', realRequirement('2026-11-03', 0, offFrom('2026-10-31', 7)), '4.5 is the target.')
  eq('§14 behind midweek he still reads it: Thursday at 2.5, Friday at 4', [realRequirement('2026-11-05', 5), realRequirement('2026-11-06', 8)], new Array(2).fill('7.5 is the target. 6 is required.'))
  eq('§14 the new-week line, with the server\'s own date', [ownWeekView(realAnswer, 'this-week')?.newWeek, ownWeekView(realAnswer, 'this-week')?.closes], ['A new week starts Saturday, Nov 7.', ''])
  // "N loads left" reads true at every half the server can send, through the view's own words.
  const realLeft = (deliveries, pickups) => ownWeekView({ ...realAnswer, weeks: [server.personalWeek({ id: 'this-week', start: START, end: END, today: '2026-11-04', deliveries, pickups, offDays: [], openLoad: true, loads: [] })] }, 'this-week')?.left
  eq('§14 what\'s left, half credits included', [realLeft(7, 7), realLeft(7, 6), realLeft(5, 5), realLeft(1, 0), realLeft(8, 7)],
    ['0.5 loads left this week.', '1 load left this week.', '2.5 loads left this week.', '7 loads left this week.', '7.5 reached this week.'])
} else {
  eq('§14 lib/driver-performance.js has personalWeek()', false, true)
}

// ── §15 what reads the count ─────────────────────────────────────────────────
console.log('§15 no pay, invoice or payout screen reads the count')
const CLIENT_SRC = path.join(ROOT, 'client', 'src')
const clientFiles = fs.readdirSync(CLIENT_SRC, { recursive: true }).map(String).filter((f) => /\.(js|mjs|ts|vue)$/.test(f))
const inClient = (re) => clientFiles.filter((f) => re.test(read(path.join(CLIENT_SRC, f)))).sort()
eq('§15 only the driver\'s own screens import the lib, and the office\'s tab reads it through its own', inClient(/['"][^'"\n]*\/driverPerformance(\.js)?['"]/), [
  'components/driver/DriverPerformanceBoard.vue', 'components/driver/DriverPerformanceTab.vue', 'lib/driverPerformanceAdmin.js', 'views/DriverView.vue',
])
eq('§15 and only the dashboard, its tab and its board import the tab\'s own lib', inClient(/['"][^'"\n]*\/driverPerformanceAdmin(\.js)?['"]/),
  ['components/dashboard/DriverPerformanceAdminBoard.vue', 'components/dashboard/DriverPerformanceAdminTab.vue', 'views/DashboardView.vue'])
eq('§15 only the lib reads the server\'s weights', inClient(/\bcreditWeights\b/), ['lib/driverPerformance.js'])
eq('§15 only the lib names his week\'s route', inClient(/api\/driver\/me\/performance/), ['lib/driverPerformance.js'])
eq('§15 only the tab\'s lib names the drivers\' weeks route', inClient(/api\/admin\/driver-performance/), ['lib/driverPerformanceAdmin.js'])

// ── §16 his past weeks ───────────────────────────────────────────────────────
console.log('§16 pastWeeksView()')
const pastWeeksView = fn('pastWeeksView')
const pastAnswer = (pastWeeks, over = {}) => ({ ...answerOf(week('this-week')), pastWeeks, countedFrom: 'Nov 7', ...over })
const PAST = [
  { start: '2026-11-21', end: '2026-11-27', credits: { value: 6.5, target: 7.5 } },
  { start: '2026-11-14', end: '2026-11-20', credits: { value: 3, target: 6 } },
  { start: '2026-11-07', end: '2026-11-13', credits: { value: 0, target: 7.5 } },
]
const SOON = 'Driving hours: coming soon'
eq('§16 each past week: its days, his figure of its own target, and with no hours sent, coming soon', pastWeeksView(pastAnswer(PAST)), {
  title: 'Past weeks',
  rows: [
    { key: '2026-11-21', range: 'Nov 21 – Nov 27', count: '6.5 of 7.5 loads', hours: SOON },
    { key: '2026-11-14', range: 'Nov 14 – Nov 20', count: '3 of 6 loads', hours: SOON },
    { key: '2026-11-07', range: 'Nov 7 – Nov 13', count: '0 of 7.5 loads', hours: SOON },
  ],
  countedFrom: "Weeks before Nov 7 weren't counted.",
})
eq('§16 the server\'s order stands: the app never sorts', pastWeeksView(pastAnswer([...PAST].reverse()))?.rows.map((r) => r.key), ['2026-11-07', '2026-11-14', '2026-11-21'])
eq('§16 no past week yet: an empty list, and the line still says what wasn\'t counted', pastWeeksView(pastAnswer([])), { title: 'Past weeks', rows: [], countedFrom: "Weeks before Nov 7 weren't counted." })
eq('§16 the line\'s date is the server\'s', pastWeeksView(pastAnswer(PAST, { countedFrom: 'Dec 5' }))?.countedFrom, "Weeks before Dec 5 weren't counted.")
const hoursFor = (hours) => pastWeeksView(pastAnswer([{ ...PAST[0], hours }]))?.rows[0].hours
eq('§16 the hours, in the server\'s figure', hoursFor({ state: 'estimate', value: 38.5 }), 'Driving: 38.5 h (estimate)')
eq('§16 a truck with no hours data: named, never 0', hoursFor({ state: 'none' }), 'No driving hours for this truck')
eq('§16 hours that start after the week began: the server\'s day', hoursFor({ state: 'starts', day: 'Nov 16' }), 'Driving hours start Nov 16')
eq('§16 coming soon, as sent or for anything it can\'t trust: never a wrong figure',
  [{ state: 'coming-soon' }, { state: 'estimate', value: '38.5' }, { state: 'estimate', value: -1 }, { state: 'estimate' }, { state: 'starts', day: '2026-11-16' }, { state: 'starts' }, { state: 'decoy' }, 31.25, 'none', null, undefined].map(hoursFor),
  new Array(11).fill(SOON))
eq('§16 the app never works an hours figure out: it prints the server\'s', [hoursFor({ state: 'estimate', value: 0.25 }), hoursFor({ state: 'estimate', value: 0, minutes: 2310 })], ['Driving: 0.25 h (estimate)', 'Driving: 0 h (estimate)'])
eq('§16 the count is the server\'s figure: the app never adds it up', pastWeeksView(pastAnswer([{ ...PAST[0], credits: { value: 9, target: 7.5, deliveries: 1, pickups: 1 } }]))?.rows[0].count, '9 of 7.5 loads')
eq('§16 exactly these fields', [Object.keys(pastWeeksView(pastAnswer(PAST)) || {}), Object.keys(pastWeeksView(pastAnswer(PAST))?.rows[0] || {})], [['title', 'rows', 'countedFrom'], ['key', 'range', 'count', 'hours']])
eq('§16 nothing else a week or its figure holds gets through', showsDecoy(pastWeeksView(pastAnswer(PAST.map((w) => ({ ...DECOYS, ...w, credits: { ...DECOYS, ...w.credits } }))))), [])
for (const [says, row] of Object.entries({
  'a value that isn\'t a number': { ...PAST[0], credits: { value: '6.5', target: 7.5 } },
  'no target': { ...PAST[0], credits: { value: 6.5 } },
  'no figure at all': { start: PAST[0].start, end: PAST[0].end },
  'a start that isn\'t a day': { ...PAST[0], start: 'Nov 21' },
  'an end that isn\'t a calendar day': { ...PAST[0], end: '2026-02-30' },
  'a row that isn\'t one': 'week',
})) eq(`§16 ${says}: no list, never a wrong week`, pastWeeksView(pastAnswer([PAST[1], row])), null)
eq('§16 no list, or no date for the line: none shows', [pastWeeksView(null), pastWeeksView(answerOf(week('this-week'))), pastWeeksView(pastAnswer(PAST, { countedFrom: '2026-11-07' })), pastWeeksView(pastAnswer('x'))], [null, null, null, null])
if (typeof server.pastWeek === 'function' && typeof server.weekDrivingHours === 'function') {
  const read = { firstDay: '2026-11-09', weeks: [{ week_start: '2026-11-21', minutes: 2310 }] }
  const real = [['2026-11-21', '2026-11-27', 7, 6, []], ['2026-11-14', '2026-11-20', 2, 2, ['2026-11-16']], ['2026-11-07', '2026-11-13', 0, 0, []]].map(([start, end, deliveries, pickups, offDays]) => ({ ...server.pastWeek({ start, end, deliveries, pickups, offDays }), hours: server.weekDrivingHours(read, start) }))
  eq('§16 the real rules through the view: a figure each, a day off lowering that week\'s target, the hours named', pastWeeksView({ pastWeeks: real, countedFrom: server.countedFrom() })?.rows.map((r) => [r.range, r.count, r.hours]), [
    ['Nov 21 – Nov 27', '6.5 of 7.5 loads', 'Driving: 38.5 h (estimate)'],
    ['Nov 14 – Nov 20', '2 of 6 loads', 'No driving hours for this truck'],
    ['Nov 7 – Nov 13', '0 of 7.5 loads', 'Driving hours start Nov 9'],
  ])
} else {
  eq('§16 lib/driver-performance.js has pastWeek() and weekDrivingHours()', false, true)
}

// ── §17 the Super Admin's tab: its lib ───────────────────────────────────────
console.log('§17 driverPerformanceAdmin.js')
const afn = (name) => (typeof adm[name] === 'function' ? adm[name] : () => null)
const driversView = afn('driversView')
const AW = adm.WORDS || {}
eq('§17 the route', adm.ADMIN_WEEKS_URL, '/api/admin/driver-performance/weeks')
eq('§17 every fixed word the tab shows, in one place', Object.keys(AW), ['tab', 'weeksTitle', 'boardTitle', 'notOnBoardTitle', 'thisWeek', 'lastWeek', 'target', 'driveHours', 'noDrivers', 'lowered', 'loading', 'failed', 'retry', 'comingSoon', 'boardEmpty', 'hos'])
eq('§17 the new words: the tab, the two headings and "Not on the board"', [AW.tab, AW.weeksTitle, AW.boardTitle, AW.notOnBoardTitle], ['Driver Performance', "Drivers' weeks", 'Board by unit', 'Not on the board'])
eq('§17 the words it shares with the driver\'s own tab and board are theirs, so one change words both',
  [AW.thisWeek, AW.target, AW.driveHours, AW.failed, AW.comingSoon, AW.boardEmpty, AW.hos], [v.THIS_WEEK_TITLE, v.TARGET_LINE, v.DRIVE_HOURS_LINE, v.FAILED_LINE, v.COMING_SOON, v.EMPTY_LINE, v.HOS_LINE])
eq('§17 the board\'s periods, views and the tab\'s rules are the driver lib\'s own, handed on',
  [adm.BOARD_PERIODS === v.PERIODS, adm.boardView === v.boardView, adm.boardUrl === v.boardUrl, adm.periodKind === v.periodKind, adm.isGoneAnswer === v.isGoneAnswer, adm.tabAfterAnswer === v.tabAfterAnswer], [true, true, true, true, true, true])
eq('§17 "Last week" is the board\'s own word for it', AW.lastWeek, (v.PERIODS.find((p) => p.id === 'last-week') || {}).label)
eq('§17 the line with no driver to show, a lowered target in the office\'s words, loading and Try again', [AW.noDrivers, AW.lowered, AW.loading, AW.retry],
  ['No driver has a week to show yet.', 'Target lowered this week for approved time off.', 'Loading…', 'Try again'])
eq('§17 the words are frozen', Object.isFrozen(adm.WORDS) && Object.isFrozen(adm.REASONS), true)
eq('§17 each reason the server names, in words', adm.REASONS, {
  inactive: 'Not active', 'percentage-driver': 'Percentage driver', 'owner-operator': 'Owner-operator', 'no-truck-in-period': 'No truck this week', 'not-in-directory': 'Not in the Driver Database',
})
{
  const routesSrc = read(path.join(ROOT, 'lib', 'driver-performance-routes.js'))
  const codes = [server.boardExclusion({ status: 'pending' }), server.boardExclusion({ status: 'active', payType: 'percentage' }), server.boardExclusion({ status: 'active', ownerOperator: true }),
    ...['no-truck-in-period', 'not-in-directory'].filter((c) => routesSrc.includes(`"${c}"`))]
  eq('§17 words for every reason the server can send', Object.keys(adm.REASONS || {}).sort(), [...new Set(codes)].sort())
}
eq('§17 only a Super Admin asks', ['Super Admin', 'Dispatcher', 'Driver', 'Investor', 'KPI Viewer', '', undefined, null].map((role) => afn('adminTabProbeUrl')(role)),
  ['/api/admin/driver-performance/weeks', '', '', '', '', '', '', ''])
// Made-up drivers and their own answers, in the shape his own route sends.
const ownAnswerOf = (thisOver = {}, lastOver = {}, pastWeeks = PAST) => ({
  ...answerOf(week('this-week', thisOver), week('last-week', { start: '2026-10-24', end: '2026-10-30', credits: { value: 6, target: 7.5, required: 6, deliveries: 6, pickups: 6 }, left: null, percent: 80, pace: null, ...lastOver })),
  pastWeeks, countedFrom: 'Nov 7',
})
const ADMIN_DECOYS = Object.freeze({ phone: '555-0199', email: 'decoy@example.test', payDaily: 987, rate: 6543, broker: 'decoy-broker', unitNumber: 'LogisX-DECOY', pickupsBySource: { geofence: 41 } })
const ADMIN_DECOY_MARKS = ['555-0199', 'decoy@', '987', '6543', 'decoy-broker', 'LogisX-DECOY', 'geofence']
// In the server's order, by this week's credits: not by name, so a sort here would show.
const ADMIN_ANSWER = {
  drivers: [
    { directoryId: 2, name: 'Riley Placeholder', unit: '', performance: ownAnswerOf({ credits: { value: 8, target: 7.5, required: 6, deliveries: 8, pickups: 8 }, left: 0, percent: 100, pace: 'ahead', barColor: 'blue' }) },
    { directoryId: 3, name: 'Avery Mock', unit: '#701', performance: ownAnswerOf() },
    { directoryId: 1, name: 'Jordan Sample', unit: '#702 (2, from Nov 3)', performance: ownAnswerOf({ credits: { value: 1.5, target: 6, required: 4.5, deliveries: 2, pickups: 1 }, left: 4.5, percent: 25, pace: 'needs-focus', barColor: 'red', targetLowered: true, loads: [] }, { loads: [], credits: { value: 0, target: 7.5, required: 6, deliveries: 0, pickups: 0 }, percent: 0 }, []) },
  ],
  notOnBoard: [{ name: 'Morgan Test', reason: 'percentage-driver' }, { name: 'Sky Demo', reason: 'not-in-directory' }, { name: 'Quinn Mock', reason: 'decoy-reason' }, { name: '  ', reason: 'inactive' }],
}
const adminView = driversView(ADMIN_ANSWER) || { rows: [], notOnBoard: [] }
const ROW_FIELDS = ['key', 'name', 'unit', 'range', 'count', 'pace', 'paceId', 'width', 'color', 'left', 'lastCount', 'thisWeek', 'lastWeek', 'past']
eq('§17 exactly these fields on the view and on a row', [Object.keys(driversView(ADMIN_ANSWER) || {}), Object.keys(adminView.rows[0] || {})], [['weekLine', 'rows', 'notOnBoard'], ROW_FIELDS])
eq('§17 the server\'s order stands: the app never sorts the drivers', adminView.rows.map((r) => [r.key, r.name]), [[2, 'Riley Placeholder'], [3, 'Avery Mock'], [1, 'Jordan Sample']])
eq('§17 each row: his name and unit as sent', adminView.rows.map((r) => [r.name, r.unit]), [['Riley Placeholder', ''], ['Avery Mock', '#701'], ['Jordan Sample', '#702 (2, from Nov 3)']])
{
  // The parity: every figure on a row is his own tab's view of his own answer.
  const same = ADMIN_ANSWER.drivers.map((d, i) => {
    const row = adminView.rows[i] || {}
    const mine = ownWeekView(d.performance, 'this-week') || {}
    const last = ownWeekView(d.performance, 'last-week') || {}
    return JSON.stringify([row.count, row.left, row.pace, row.paceId, row.width, row.range, row.lastCount, row.thisWeek && row.thisWeek.loads, row.thisWeek && row.thisWeek.requirement, row.thisWeek && row.thisWeek.rule, row.thisWeek && row.thisWeek.newWeek, row.lastWeek && row.lastWeek.loads, row.past, row.color])
      === JSON.stringify([mine.count, mine.left, mine.pace, mine.paceId, mine.width, mine.range, last.count, mine.loads, mine.requirement, mine.rule, mine.newWeek, last.loads, pastWeeksView(d.performance), (weekBarView(d.performance) || {}).color])
  })
  eq('§17 every figure and line on a row is what his own tab shows from the same answer: this week, last week\'s final figure, what counted, his past weeks, the bar\'s color', same, [true, true, true])
}
eq('§17 the words, as his own tab says them', adminView.rows.map((r) => [r.count, r.pace, r.left, r.lastCount, r.color]), [
  ['8 of 7.5 loads', 'Ahead of Pace', '7.5 reached this week.', '6 of 7.5 loads', 'blue'],
  ['4.5 of 7.5 loads', 'On Track', '3 loads left this week.', '6 of 7.5 loads', ''],
  ['1.5 of 6 loads', 'Needs Focus', '4.5 loads left this week.', '0 of 7.5 loads', 'red'],
])
eq('§17 the loads that counted, both weeks', [adminView.rows[1]?.thisWeek.loads.length, adminView.rows[1]?.thisWeek.title, adminView.rows[1]?.lastWeek.title, adminView.rows[2]?.thisWeek.loads, adminView.rows[2]?.thisWeek.empty, adminView.rows[2]?.lastWeek.empty],
  [6, 'What counted this week', 'What counted last week', [], v.NO_LOADS_LINE, v.NO_LOADS_LAST_WEEK])
eq('§17 his past weeks, with the hours line his own tab prints: coming soon with none sent', [adminView.rows[1]?.past.rows.map((r) => r.hours), adminView.rows[1]?.past.countedFrom, adminView.rows[2]?.past.rows],
  [[v.DRIVE_HOURS_LINE, v.DRIVE_HOURS_LINE, v.DRIVE_HOURS_LINE], "Weeks before Nov 7 weren't counted.", []])
eq('§17 a lowered target: the office\'s own line, only when the server flags it', adminView.rows.map((r) => r.thisWeek.lowered), ['', '', 'Target lowered this week for approved time off.'])
eq('§17 the week\'s days and its closing line, once for the tab', adminView.weekLine, 'Oct 31 – Nov 6 · Week closes Fri 11:59 PM ET')
eq('§17 drivers off the board: each name with its reason in words; a reason it doesn\'t know shows none, a blank name no row', adminView.notOnBoard, [
  { name: 'Morgan Test', reason: 'Percentage driver' }, { name: 'Sky Demo', reason: 'Not in the Driver Database' }, { name: 'Quinn Mock', reason: '' },
])
eq('§17 none sent, none shown', [driversView({ drivers: [] }), driversView({ drivers: [], notOnBoard: 'x' })].map((x) => x && [x.rows.length, x.notOnBoard.length, x.weekLine]), [[0, 0, ''], [0, 0, '']])
{
  const stuffed = { ...ADMIN_DECOYS, drivers: ADMIN_ANSWER.drivers.map((d) => ({ ...ADMIN_DECOYS, ...d, performance: { ...ADMIN_DECOYS, ...d.performance } })), notOnBoard: ADMIN_ANSWER.notOnBoard.map((x) => ({ ...ADMIN_DECOYS, ...x })) }
  eq('§17 no phone, email, pay, rate, broker, stored unit or pickup source gets through, whatever the answer holds', ADMIN_DECOY_MARKS.filter((m) => has(driversView(stuffed), m)), [])
}
for (const [says, broken] of Object.entries({
  'no list': {},
  'a list that isn\'t one': { drivers: 'x' },
  'a driver with no answer of his own': { drivers: [{ directoryId: 1, name: 'Avery Mock', unit: '#701' }] },
  'a driver whose week doesn\'t hold whole': { drivers: [{ directoryId: 1, name: 'Avery Mock', unit: '#701', performance: ownAnswerOf({ percent: 140 }) }] },
  'a driver whose past weeks don\'t hold whole': { drivers: [{ directoryId: 1, name: 'Avery Mock', unit: '#701', performance: ownAnswerOf({}, {}, 'x') }] },
  'a driver with no name': { drivers: [{ directoryId: 1, name: ' ', unit: '#701', performance: ownAnswerOf() }] },
  'a driver with no row id': { drivers: [{ directoryId: '1', name: 'Avery Mock', unit: '#701', performance: ownAnswerOf() }] },
  'one good driver beside a broken one': { drivers: [ADMIN_ANSWER.drivers[0], { directoryId: 9, name: 'Sky Demo', unit: '', performance: null }] },
})) eq(`§17 ${says}: no list, never a wrong or partial one`, driversView(broken), null)
eq('§17 the lib computes and sorts nothing', ARITHMETIC.test(codeOf(adminLibSrc)), false)
eq('§17 it reads the driver\'s own views, and no figure of its own', [/import \{\s*COMING_SOON, DRIVE_HOURS_LINE, EMPTY_LINE, FAILED_LINE, HOS_LINE, TARGET_LINE, THIS_WEEK_TITLE, ownWeekView, pastWeeksView, weekBarView, weekClosesLine,\s*\} from '\.\/driverPerformance\.js'/.test(adminLibSrc), /\.credits\b|\.percent\b|\.barColor\b|\.hours\b/.test(codeOf(adminLibSrc))], [true, false])
eq('§17 no storage, timer or socket', /localStorage|sessionStorage|indexedDB|document\.cookie|setTimeout|setInterval|useSocket/.test(adminLibSrc), false)

// ── §18 DriverPerformanceAdminTab.vue ────────────────────────────────────────
console.log('§18 DriverPerformanceAdminTab.vue')
const tabTemplate = templateOf(adminTab)
const tabScript = scriptOf(adminTab)
eq('§18 it prints only these, so no other field can reach the screen by accident', [...new Set([...tabTemplate.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]))].sort(), [
  'WORDS.boardTitle', 'WORDS.driveHours', 'WORDS.failed', 'WORDS.lastWeek', 'WORDS.loading', 'WORDS.noDrivers', 'WORDS.notOnBoardTitle', 'WORDS.retry', 'WORDS.target', 'WORDS.thisWeek', 'WORDS.weeksTitle',
  'item.line', 'item.name', 'item.reason', 'item.title',
  'row.count', 'row.lastCount', 'row.lastWeek.empty', 'row.lastWeek.title', 'row.left', 'row.name', 'row.pace', 'row.past.countedFrom', 'row.past.title',
  'row.thisWeek.empty', 'row.thisWeek.lowered', 'row.thisWeek.newWeek', 'row.thisWeek.requirement', 'row.thisWeek.rule', 'row.thisWeek.title', 'row.unit',
  'view.weekLine', 'week.count', 'week.hours', 'week.range',
].sort())
eq('§18 every word it prints comes from the lib: no text of its own between its tags', templateOf(adminTab).replace(/\{\{[^}]*\}\}/g, ' ').replace(/<[^>]*>/g, ' ').replace(/&#9662;/g, ' ').trim(), '')
eq('§18 every fixed word it names is one the lib holds', [...new Set([...tabTemplate.matchAll(/WORDS\.(\w+)/g)].map((m) => m[1]))].filter((k) => !Object.prototype.hasOwnProperty.call(AW, k)), [])
eq('§18 its one read is the drivers\' weeks', [...tabScript.matchAll(/api\.\w+\(([^)]*)\)/g)].map((m) => m[1]), ['ADMIN_WEEKS_URL'])
eq('§18 read only: no write, and kept nowhere but the page', [/api\.(post|put|patch|del|request)\b|method:/.test(tabScript), /localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(adminTab)], [false, false])
eq('§18 it computes nothing', [ARITHMETIC.test(codeOf(tabScript)), [...tabTemplate.matchAll(/\{\{([^}]*)\}\}/g)].filter((m) => /[*/%+-]/.test(m[1])).length], [false, 0])
eq('§18 no v-html, and no store or session', [tabTemplate.includes('v-html'), /useAuthStore|useDashboardStore|useDriverStore|driverName/.test(adminTab)], [false, false])
eq('§18 the rows come from the lib\'s view of the one answer', tabScript.includes('const view = computed(() => driversView(answer.value))'), true)
eq('§18 it reads each time it is shown, and only the newest read lands', [tabScript.includes("watch(() => props.active, (shown) => { if (shown) load() }, { immediate: true })"), /if \(!alive \|\| latest !== mine\) return/.test(tabScript)], [true, true])
eq('§18 the server\'s "gone" hides the tab', tabScript.includes("if (isGoneAnswer(err.status)) emit('gone')"), true)
eq('§18 a row is a button that says whether it is open', /<button type="button" class="adp-head" :aria-expanded="open\[row\.key\] \? 'true' : 'false'" data-testid="adp-toggle" @click="toggle\(row\.key\)">/.test(tabTemplate), true)
eq('§18 what counted and his past weeks only once his row is open', /<div v-if="open\[row\.key\]" class="adp-detail" data-testid="adp-detail">/.test(tabTemplate), true)
{
  const head = (tabTemplate.match(/<button type="button" class="adp-head"[\s\S]*?<\/button>/) || [''])[0]
  eq('§18 the row itself: name, unit, this week\'s figure, label, bar and what\'s left, and last week\'s final figure; no load or past week in it',
    [/row\.name[\s\S]*row\.unit[\s\S]*row\.count[\s\S]*row\.pace[\s\S]*row\.width[\s\S]*row\.left[\s\S]*row\.lastCount/.test(head), /item\.|week\.|row\.past|row\.thisWeek|row\.lastWeek/.test(head), /<(div|p|h\d|ul|li|section)\b/.test(head)], [true, false, false])
}
const detail = (tabTemplate.match(/<div v-if="open\[row\.key\]" class="adp-detail"[\s\S]*?\n {12}<\/div>/) || [''])[0]
eq('§18 open: what counted this week and last, then his past weeks with their hours lines and the "weren\'t counted" line',
  ['row.thisWeek.title', 'row.thisWeek.loads', 'WORDS.driveHours', 'row.lastWeek.title', 'row.lastWeek.loads', 'row.past.title', 'row.past.rows', 'week.hours', 'row.past.countedFrom'].map((s) => detail.indexOf(s)).every((at, i, all) => at > 0 && (i === 0 || at > all[i - 1])), true)
eq('§18 no hours words of its own: the lines are the driver\'s own', /\bhours?\b/i.test(tabTemplate.replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ')), false)
eq('§18 "Not on the board" starts collapsed, under the drivers, each name with its reason', [/<details v-if="view\.notOnBoard\.length" class="adp-off" data-testid="adp-not-on-board">/.test(tabTemplate), /<details[^>]*\sopen\b/.test(tabTemplate),
  tabTemplate.indexOf('data-testid="adp-drivers"') < tabTemplate.indexOf('data-testid="adp-not-on-board"') && tabTemplate.indexOf('data-testid="adp-not-on-board"') < tabTemplate.indexOf('data-testid="adp-board-title"'),
  /\{\{ item\.name \}\}[\s\S]*\{\{ item\.reason \}\}/.test(tabTemplate)], [true, false, true, true])
eq('§18 the board by unit is the office\'s plain board, under its own heading, after the drivers', [/import DriverPerformanceAdminBoard from '\.\/DriverPerformanceAdminBoard\.vue'/.test(tabScript),
  /<h3 id="adp-board-title" class="adp-heading" data-testid="adp-board-title">\{\{ WORDS\.boardTitle \}\}<\/h3>\s*<DriverPerformanceAdminBoard @gone="emit\('gone'\)" \/>/.test(tabTemplate),
  tabTemplate.indexOf('adp-weeks-title') < tabTemplate.indexOf('adp-board-title')], [true, true, true])
eq('§18 not the driver app\'s Vant board', /DriverPerformanceBoard\b|components\/driver\//.test(adminTab), false)
eq('§18 no Vant of its own: the office\'s screens are plain', /<van-|from 'vant'/.test(adminTab), false)
eq('§18 each row\'s button, the reasons\' summary and Try again are 44 px or more', ['adp-head', 'adp-off-title', 'adp-retry'].map((c) => new RegExp(`\\.${c} \\{[^}]*min-height: 44px`).test(styleOf(adminTab))), [true, true, true])
eq('§18 a card when the tab is narrow, one row when it is wide: by the tab\'s own width, never the window\'s, so the sidebar can\'t squeeze a row',
  [/\.adp \{[^}]*container-type: inline-size;/.test(styleOf(adminTab)), /@container \(min-width: 40rem\) \{\s*\.adp-head \{[^}]*grid-template-areas: 'who this last chevron';/.test(styleOf(adminTab)), /@media/.test(styleOf(adminTab))], [true, true, false])
eq('§18 the bar takes the Loads bar\'s four colors, and only those', [...styleOf(adminTab).matchAll(/\.adp-fill\[data-color='(\w+)'\] \{ background: (#[0-9a-f]{6}); \}/g)].map((m) => [m[1], m[2]]), FILL_COLORS)
eq('§18 no pay, rate, invoice, broker, phone or email word on the tab', /\$|\bpay\b|\brate\b|invoice|broker|phone|e-?mail/i.test(tabTemplate.replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ')), false)

// ── §19 DashboardView.vue ────────────────────────────────────────────────────
console.log('§19 DashboardView.vue')
const dashScript = scriptOf(dashboard)
const dashTemplate = templateOf(dashboard)
eq('§19 the tab starts hidden', dashScript.includes('const performanceTab = ref(false)'), true)
eq('§19 it joins the tabs last, after Fleet & Drivers, only while shown, with no count',
  dashScript.includes("{ key: 'fleet', label: 'Fleet & Drivers', count: store.fleet.length },\n  ...(performanceTab.value ? [{ key: 'performance', label: PERFORMANCE_WORDS.tab, count: null }] : []),\n])"), true)
eq('§19 its name is the tab\'s own word, and its rules come through the tab\'s lib', [/import \{ WORDS as PERFORMANCE_WORDS, adminTabProbeUrl, tabAfterAnswer \} from '\.\.\/lib\/driverPerformanceAdmin'/.test(dashScript), /lib\/driverPerformance['"]/.test(dashScript)], [true, false])
eq('§19 a tab with no count shows no badge', dashTemplate.includes('<Badge v-if="tab.count !== null" variant="secondary"'), true)
const probe = (dashScript.match(/async function checkPerformanceTab\(\) \{([\s\S]*?)\n\}/) || [])[1] || ''
eq('§19 only a Super Admin asks, and the answer decides', [probe.includes('const url = adminTabProbeUrl(auth.user?.role)'), probe.includes('if (!url) return'), probe.includes('performanceTab.value = tabAfterAnswer(status, performanceTab.value)')], [true, true, true])
eq('§19 it asks once the dashboard is up', /onMounted\(\(\) => \{[^\n]*checkPerformanceTab\(\)/.test(dashScript), true)
eq('§19 the panel only with the tab, told when it is shown, and the server\'s "gone" takes the tab away',
  dashTemplate.includes('<TabsContent v-if="performanceTab" value="performance" style="margin-top:0;">\n            <DriverPerformanceAdminTab :active="activeTab === \'performance\'" @gone="performanceTab = false" />'), true)
eq('§19 a tab taken away goes back to the Job Board', dashScript.includes("watch(performanceTab, (shown) => { if (!shown && activeTab.value === 'performance') activeTab.value = 'jobBoard' })"), true)
eq('§19 the dashboard reads nothing of the answer: the tab does', /api\.get\(url\)/.test(probe) && !/\bdrivers\b|notOnBoard/.test(probe), true)

// ── §20 the real server rules through the tab's views ────────────────────────
console.log('§20 lib/driver-performance.js through the tab')
if (typeof server.personalWeek === 'function' && typeof server.pastWeek === 'function') {
  const TODAY = '2026-11-04'
  const realOwn = ({ deliveries, pickups, offDays = [], openLoad = true, loads = [], last = [6, 6], past = [], read = null }) => ({
    view: 'no-hours-data',
    creditWeights: { ...server.CREDIT_WEIGHTS },
    weeks: [
      server.personalWeek({ id: 'this-week', start: START, end: END, today: TODAY, deliveries, pickups, offDays, openLoad, loads }),
      server.personalWeek({ id: 'last-week', start: '2026-10-24', end: '2026-10-30', today: TODAY, deliveries: last[0], pickups: last[1], offDays: [], openLoad: false, loads: [] }),
    ],
    pastWeeks: past.map(([start, end, d, p]) => ({ ...server.pastWeek({ start, end, deliveries: d, pickups: p, offDays: [] }), ...(read ? { hours: server.weekDrivingHours(read, start) } : {}) })),
    countedFrom: server.countedFrom('2026-10-24'),
  })
  const PAST_REAL = [['2026-10-24', '2026-10-30', 6, 6]]
  const real = {
    drivers: [
      { directoryId: 7, name: 'Avery Mock', unit: '#701', performance: realOwn({ deliveries: 4, pickups: 4, loads: [server.countedLoad({ loadId: 'QA-1', pickupDay: '2026-11-02', deliveryDay: '2026-11-03' })], past: PAST_REAL }) },
      { directoryId: 8, name: 'Jordan Sample', unit: '#702', performance: realOwn({ deliveries: 3, pickups: 0, offDays: ['2026-11-05'], past: PAST_REAL, read: { firstDay: '2026-10-01', weeks: [{ week_start: '2026-10-24', minutes: 2310 }] } }) },
      { directoryId: 9, name: 'Riley Placeholder', unit: '', performance: realOwn({ deliveries: 0, pickups: 0, openLoad: false, past: [] }) },
    ],
    notOnBoard: [{ name: 'Morgan Test', reason: server.boardExclusion({ status: 'active', payType: 'percentage' }) }],
  }
  const rv = driversView(real) || { rows: [], notOnBoard: [] }
  eq('§20 the real rules\' weeks, in the tab\'s words', rv.rows.map((r) => [r.name, r.count, r.pace, r.left, r.color, r.lastCount]), [
    ['Avery Mock', '4 of 7.5 loads', 'On Track', '3.5 loads left this week.', 'orange', '6 of 7.5 loads'],
    ['Jordan Sample', '1.5 of 6 loads', 'Needs Focus', '4.5 loads left this week.', 'red', '6 of 7.5 loads'],
    ['Riley Placeholder', '0 of 7.5 loads', '', '7.5 loads left this week.', 'red', '6 of 7.5 loads'],
  ])
  eq('§20 ...the same words his own tab and bar print from the same answer', real.drivers.map((d, i) => [rv.rows[i]?.count, rv.rows[i]?.pace, rv.rows[i]?.left, rv.rows[i]?.color]),
    real.drivers.map((d) => [ownWeekView(d.performance, 'this-week')?.count, ownWeekView(d.performance, 'this-week')?.pace, ownWeekView(d.performance, 'this-week')?.left, weekBarView(d.performance)?.color]))
  eq('§20 a day off: the lower target, and the office\'s line saying why', [rv.rows[1]?.thisWeek.lowered, rv.rows[1]?.thisWeek.requirement], ['Target lowered this week for approved time off.', '6 is the target. 4.5 is required.'])
  eq('§20 past weeks through the real rules: coming soon with no hours sent, the estimate once the server sends one', rv.rows.map((r) => r.past.rows.map((w) => [w.range, w.count, w.hours])), [
    [['Oct 24 – Oct 30', '6 of 7.5 loads', 'Driving hours: coming soon']],
    [['Oct 24 – Oct 30', '6 of 7.5 loads', 'Driving: 38.5 h (estimate)']],
    [],
  ])
  eq('§20 what counted, in his own tab\'s words', rv.rows[0]?.thisWeek.loads, [{ title: 'Load QA-1', line: 'Picked up Mon 0.5 · Delivered Tue 0.5' }])
  eq('§20 the server\'s reason code, in words', rv.notOnBoard, [{ name: 'Morgan Test', reason: 'Percentage driver' }])
} else {
  eq('§20 lib/driver-performance.js has personalWeek() and pastWeek()', false, true)
}

// ── §21 the dashboard reaches no Vant ────────────────────────────────────────
// Vant's styles carry unlayered element rules (body, buttons, links, lists), so any of them on the
// dashboard's chunk graph restyles every office page. Walked from source: every import, re-export,
// lazy import and CSS @import the dashboard can reach inside client/src, and the packages they name.
console.log('§21 the dashboard reaches no Vant')
const SRC_ROOT = path.join(ROOT, 'client', 'src')
const IMPORT_RE = /\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?['"]([^'"\n]+)['"]|\bexport\s*[\w$*{}\s,]+?\s*from\s*['"]([^'"\n]+)['"]|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)|@import\s+(?:url\()?['"]([^'"\n]+)['"]/g
function resolveLocal(fromFile, spec) {
  const base = spec.startsWith('@/') ? path.join(SRC_ROOT, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(fromFile), spec) : null
  if (!base) return null
  return [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.vue`, path.join(base, 'index.js'), path.join(base, 'index.ts')]
    .find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) || ''
}
function reachFrom(entry) {
  const files = new Set()
  const packages = new Map()
  const unresolved = []
  const todo = [entry]
  while (todo.length) {
    const file = todo.pop()
    if (files.has(file)) continue
    files.add(file)
    // A template's own text can't import anything; its script and style blocks can.
    const src = file.endsWith('.vue') ? read(file).replace(/^<template>[\s\S]*^<\/template>/m, '') : read(file)
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2] || m[3] || m[4]
      const local = resolveLocal(file, spec)
      if (local) todo.push(local)
      else if (local === '') unresolved.push(`${path.relative(ROOT, file)} -> ${spec}`)
      else if (!packages.has(spec)) packages.set(spec, path.relative(ROOT, file))
    }
  }
  return { files, packages, unresolved }
}
{
  const dash = reachFrom(DASHBOARD)
  const reachedRel = [...dash.files].map((f) => path.relative(SRC_ROOT, f).split(path.sep).join('/'))
  eq('§21 (the walk) it reaches the dashboard\'s tabs, the Driver Performance tab and the shared ui kit, and resolves every local import',
    [['views/DashboardView.vue', 'components/dashboard/FleetTab.vue', 'components/dashboard/DriverPerformanceAdminTab.vue', 'lib/driverPerformanceAdmin.js', 'components/ui/tabs/TabsTrigger.vue'].every((f) => reachedRel.includes(f)), dash.unresolved], [true, []])
  eq('§21 nothing the dashboard can reach imports Vant, its components or its styles', [...dash.packages].filter(([spec]) => /^vant(\/|$)/.test(spec)).map(([spec, from]) => `${from} -> ${spec}`), [])
  eq('§21 nor any of the driver app\'s own screens', reachedRel.filter((f) => /^components\/driver\/(DriverPerformance(Board|Tab)|DriverWeekBar|BottomNav)\.vue$/.test(f) || f === 'views/DriverView.vue'), [])
}

// ── §22 DriverPerformanceAdminBoard.vue ──────────────────────────────────────
console.log('§22 DriverPerformanceAdminBoard.vue')
const adbTemplate = templateOf(adminBoard)
const adbScript = scriptOf(adminBoard)
eq('§22 it prints only the board\'s view and the tab\'s words', [...new Set([...adbTemplate.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]))].sort(), [
  'WORDS.boardEmpty', 'WORDS.comingSoon', 'WORDS.failed', 'WORDS.hos', 'WORDS.loading', 'WORDS.retry',
  'board.closes', 'board.range', 'period.label', 'row.figure', 'row.rank', 'row.unit', 'tile.line', 'tile.title',
].sort())
eq('§22 no text of its own between its tags', adbTemplate.replace(/\{\{[^}]*\}\}/g, ' ').replace(/<[^>]*>/g, ' ').trim(), '')
eq('§22 every fixed word it names is one the lib holds', [...new Set([...adbTemplate.matchAll(/WORDS\.(\w+)/g)].map((m) => m[1]))].filter((k) => !Object.prototype.hasOwnProperty.call(AW, k)), [])
eq('§22 its one read is the board, a period at a time', [...adbScript.matchAll(/api\.\w+\(([^)]*)\)/g)].map((m) => m[1]), ['boardUrl(which'])
eq('§22 a period is read once, when first chosen', adbScript.includes("watch(kind, (which) => { if (boards[which].state === 'idle') loadBoard(which) })"), true)
eq('§22 the view is the driver board\'s own', [adbScript.includes('const board = computed(() => boardView(boards[kind.value].answer, periodId.value))'), /import \{ BOARD_PERIODS, WORDS, boardUrl, boardView, isGoneAnswer, periodKind \} from '\.\.\/\.\.\/lib\/driverPerformanceAdmin'/.test(adbScript)], [true, true])
eq('§22 read only, kept nowhere, and it computes nothing', [/api\.(post|put|patch|del|request)\b|method:/.test(adbScript), /localStorage|sessionStorage|indexedDB|document\.cookie/.test(adminBoard), ARITHMETIC.test(codeOf(adbScript))], [false, false, false])
eq('§22 no Vant: plain markup, so the dashboard keeps its own styles', /<van-|from 'vant'|vant\//.test(adminBoard), false)
eq('§22 the three periods are buttons that say which is chosen, 44 px or more', [/<button v-for="period in BOARD_PERIODS" :key="period\.id" type="button" class="adb-period" :aria-pressed="periodId === period\.id \? 'true' : 'false'"/.test(adbTemplate), /\.adb-period \{[^}]*min-height: 44px/.test(styleOf(adminBoard))], [true, true])
eq('§22 a row and Try again are 44 px', ['adb-row', 'adb-retry'].map((c) => new RegExp(`\\.${c} \\{[^}]*min-height: 44px`).test(styleOf(adminBoard))), [true, true])
const adbHos = chainTo(adbTemplate, 'data-testid="adb-hos"')
eq('§22 the hours-of-service line stays, outside every condition, as on the driver board', [!!adbHos, (adbHos || []).filter((attrs) => /\bv-(if|else|else-if|show)\b/.test(attrs)).length], [true, 0])
eq('§22 a Super Admin\'s board has no "you"', /row\.you|\bYOU\b/.test(adminBoard), false)
eq('§22 the server\'s "gone" hides the tab', adbScript.includes("if (isGoneAnswer(err.status)) emit('gone')"), true)

// ── §23 the weekly performance page on his invoice ───────────────────────────
// lib/invoice-performance-copy.js words the page the invoice keeps: the tab's own lines for the week the page
// names ("this week"), and three of its own. A tree without the module fails each case by name.
console.log('§23 the weekly performance page on the invoice: the tab\'s own words')
const COPY_FILE = path.join(ROOT, 'lib', 'invoice-performance-copy.js')
const copy = fs.existsSync(COPY_FILE) ? require(COPY_FILE) : null
// Fri Nov 6, 7:00 PM Eastern (the Friday batch's hour), on the week of Oct 31 to Nov 6.
const AS_OF = Date.parse('2026-11-07T00:00:00Z')
const pageOf = (answer, hours = null, zone = 'America/New_York') => (copy && answer
  ? copy.pageOf({ week: (answer.weeks || [])[0], weights: answer.creditWeights, hours }, { asOfMs: AS_OF, zone }) : null)
const tabRows = (view) => (view && Array.isArray(view.loads) ? view.loads.map((l) => `${l.title}: ${l.line}`) : null)
// The page's lines against the tab's own view of the same answer.
function sameWords(says, answer) {
  const page = pageOf(answer) || {}
  const tab = ownWeekView(answer, 'this-week') || {}
  eq(`§23 ${says}: the count, the requirement, the rule, the time-off line, the rows and the empty line, as the tab says them`,
    [page.count, page.requirement, page.rule, page.lowered, page.rows, page.empty],
    [tab.count, tab.requirement, tab.rule, tab.lowered, tabRows(tab), tab.loads && tab.loads.length ? '' : tab.empty])
}
sameWords('the made-up week', answerOf(week('this-week')))
sameWords('a target lowered for time off', answerOf(week('this-week', { targetLowered: true, credits: { value: 3, target: 6, required: 4.5, deliveries: 3, pickups: 3 } })))
sameWords('the target alone, time off ruling the requirement out', answerOf(week('this-week', { credits: { value: 3, target: 4.5, required: null, deliveries: 3, pickups: 3 } })))
sameWords('nothing counted yet', answerOf(week('this-week', { loads: [], credits: { value: 0, target: 7.5, required: 6, deliveries: 0, pickups: 0 } })))
const page23 = pageOf(answerOf(week('this-week'))) || {}
eq('§23 the page\'s own three: its heading, the as-of line and the title over what counted', [page23.heading, page23.asOf, page23.title], ['WEEKLY PERFORMANCE', 'As of Fri Nov 6, 7:00 PM ET', 'What counted'])
eq('§23 its week, in the invoice\'s own "to"', page23.week, 'Oct 31 to Nov 6')
eq('§23 a week across a year end names both years', pageOf(answerOf(week('this-week', { start: '2026-12-26', end: '2027-01-01' })))?.week, 'Dec 26, 2026 to Jan 1, 2027')
eq('§23 the as-of line names the business clock: CT on the Central clock', pageOf(answerOf(week('this-week')), null, 'America/Chicago')?.asOf, 'As of Fri Nov 6, 6:00 PM CT')
eq('§23 exactly these lines', Object.keys(page23), ['heading', 'week', 'asOf', 'count', 'requirement', 'rule', 'lowered', 'title', 'rows', 'empty', 'hours'])
eq('§23 no label, bar, what\'s left, closing line or new-week line, whatever the week holds',
  [v.PACE_WORDS && Object.values(v.PACE_WORDS).some((w) => has(page23, w)), has(page23, '%'), has(page23, 'left this week'), has(page23, 'reached'), has(page23, 'Week closes'), has(page23, 'A new week')],
  [false, false, false, false, false, false])
// The heading is the page's own word, and "PERFORMANCE" holds one decoy mark ("CE"), so it is left out here.
const decoyPage = pageOf(decoyAnswer)
eq('§23 nothing else an answer holds gets through', [!!decoyPage, decoyPage ? showsDecoy({ ...decoyPage, heading: '' }) : null], [true, []])
eq('§23 every word free of ranking, score, tier and dollars, and no "pay"',
  copy ? [page23.heading, page23.week, page23.asOf, page23.count, page23.requirement, page23.rule, page23.title, ...(page23.rows || []), page23.hours].filter((w) => BANNED.test(w) || /\bpay\b/i.test(w)) : null, [])
// The tab's four hours lines (#763), and coming soon for anything it can't trust: as a past week's row says them.
const pastHours = (hours) => pastWeeksView({ ...answerOf(week('this-week')), pastWeeks: [{ start: '2026-10-24', end: '2026-10-30', credits: { value: 6, target: 7.5 }, hours }], countedFrom: 'Oct 24' })?.rows[0].hours
for (const [says, hours] of [
  ['no hours sent (the switch off)', null], ['coming soon, as sent', { state: 'coming-soon' }], ['an estimate', { state: 'estimate', value: 38.5 }],
  ['no hours for this truck', { state: 'none' }], ['hours that start later', { state: 'starts', day: 'Nov 9' }],
  ['a figure it can\'t trust', { state: 'estimate', value: '38.5' }], ['a negative figure', { state: 'estimate', value: -1 }],
  ['a start day it can\'t trust', { state: 'starts', day: '2026-11-09' }], ['a state it doesn\'t know', { state: 'decoy' }],
]) eq(`§23 hours, ${says}: the past week's own line`, (pageOf(answerOf(week('this-week')), hours) || {}).hours, pastHours(hours))
eq('§23 the four lines, by name', [null, { state: 'estimate', value: 38.5 }, { state: 'none' }, { state: 'starts', day: 'Nov 9' }].map((h) => (pageOf(answerOf(week('this-week')), h) || {}).hours),
  ['Driving hours: coming soon', 'Driving: 38.5 h (estimate)', 'No driving hours for this truck', 'Driving hours start Nov 9'])
for (const [says, over] of Object.entries(broken).filter(([says]) => !/percent|left/.test(says))) {
  eq(`§23 ${says}: no page, never a wrong number`, copy ? pageOf(answerOf(week('this-week', over))) : 'no module', null)
}
eq('§23 no weights, or no week: no page', copy ? [copy.pageOf({ week: week('this-week'), weights: null, hours: null }, { asOfMs: AS_OF, zone: 'America/New_York' }), copy.pageOf({ week: null, weights: { delivery: 0.5, pickup: 0.5 } }, { asOfMs: AS_OF, zone: 'America/New_York' }), copy.pageOf(null, { asOfMs: AS_OF, zone: 'America/New_York' })] : null, [null, null, null])
if (typeof server.personalWeek === 'function') {
  const realLoads = [
    server.countedLoad({ loadId: 'DP-1', pickupDay: '2026-11-02', deliveryDay: '2026-11-03' }),
    server.countedLoad({ loadId: 'DP-2', pickupDay: '', deliveryDay: '2026-11-04', pickupNote: 'last-week' }),
    server.countedLoad({ loadId: 'DP-3', pickupDay: '', deliveryDay: '2026-11-04', pickupNote: 'not-counted' }),
    server.countedLoad({ loadId: 'DP-4', pickupDay: '2026-11-04', deliveryDay: '' }),
  ]
  const realWeek = (today, offDays) => ({ view: 'no-hours-data', creditWeights: { ...server.CREDIT_WEIGHTS }, weeks: [server.personalWeek({ id: 'this-week', start: START, end: END, today, deliveries: 3, pickups: 2, offDays, openLoad: true, loads: realLoads })] })
  sameWords('the real rules, a day off and a pickup counted last week', realWeek('2026-11-06', ['2026-11-05']))
  sameWords('the real rules, no time off', realWeek('2026-11-04', []))
  // Made the Saturday after (a restart's catch-up): the week's final figure, its rows in the page's own "this week".
  const closed = pageOf(realWeek('2026-11-07', ['2026-11-05'])) || {}
  eq('§23 a week already closed when the invoice is made: its final figure and rows, and no time-off line (the tab shows none on a closed week)',
    [closed.count, closed.requirement, closed.lowered, closed.rows],
    ['2.5 of 6 loads', '6 is the target. 4.5 is required.', '', [
      'Load DP-1: Picked up Mon 0.5 · Delivered Tue 0.5', 'Load DP-2: Delivered Wed 0.5 · Pickup counted last week',
      'Load DP-3: Delivered Wed 0.5 · Pickup not counted this week', 'Load DP-4: Picked up Wed 0.5',
    ]])
} else {
  eq('§23 lib/driver-performance.js has personalWeek()', false, true)
}
eq('§23 the copy\'s own module holds no calendar or clock of its own: the moment and the zone are handed in',
  copy ? /\bDate\.now\b|new Date\(\)|process\.env/.test(codeOf(fs.readFileSync(COPY_FILE, 'utf8'))) : null, false)

done()
