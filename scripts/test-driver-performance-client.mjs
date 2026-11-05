#!/usr/bin/env node
// The driver's own week: the pure lib client/src/lib/driverPerformance.js, and how
// DriverPerformanceTab.vue, DriverWeekBar.vue, BottomNav.vue and DriverView.vue use it; and the
// Super Admin's board on /driver, DriverPerformanceBoard.vue. The server works out every figure and
// its privacy rules (scripts/test-driver-performance.js); here the app must show only what those
// answers allow.
//   §1  the fixed words, exact, and none of the words a driver's screen must not show
//   §2  parity with lib/driver-performance.js: labels, categories, "Not ranked", the row's keys
//   §3  rowView(), the office board: only rank, unit, figure and "you"
//   §4  the office board's tiles: only Most loads can be live
//   §5  boardView(), the office board: the chosen period, the server's order
//   §6  ownWeekView(): the figures as sent, the label, what's left, each row's two credits; last
//       week's final figure with no label; nothing else an answer carries gets through
//   §7  weekBarView() and weekFromAnswer(): the bar's words; only a Driver's 200 gives it a figure
//   §8  who gets the tab: only a 200 shows it, and only a Driver or Super Admin asks
//   §9  BottomNav.vue: the five tabs as they were, Performance only with its prop, no trophy
//   §10 DriverView.vue: the bar on the Loads list, the panel behind the answer, the read's rules
//   §11 DriverPerformanceTab.vue: his own week; never names the board; reads, never writes or
//       stores; computes nothing; the hours-of-service line outside every condition
//   §12 DriverWeekBar.vue: its words, a 44 px tap, no read, no motion, no red
//   §13 DriverPerformanceBoard.vue: the office board, its reads and rows as they were
//   §14 the real server rules through the real views, on made-up loads
//   §15 no pay, invoice or payout screen reads the count: only these three files import the lib
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
const require = createRequire(import.meta.url)
const server = require(path.join(ROOT, 'lib', 'driver-performance.js'))
const libSrc = read(LIB)
const card = read(CARD)
const bar = read(BAR)
const board = read(BOARD)
const nav = read(NAV)
const view = read(VIEW)

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
eq('§1 the hours-of-service line', v.HOS_LINE,
  'Never drive past your hours of service to reach a target. Your 11-hour driving limit, 14-hour window and 60/70-hour limit come first. Your ELD log is what counts for your hours. If you stop to stay legal, tell dispatch.')
eq('§1 the bar\'s short line', v.HOS_SHORT_LINE, 'Hours of service come first.')
eq('§1 the target line, exact', v.TARGET_LINE, 'Target: 7.5 loads a week (1.5 a day over 5 days)')
eq('§1 the guide line', v.GUIDE_LINE, 'Targets are a guide, not a requirement.')
eq('§1 the privacy line, exact', v.PRIVATE_LINE, 'No other driver can see this.')
eq('§1 drive hours', v.DRIVE_HOURS_LINE, 'Drive hours: coming soon')
eq('§1 counts loads, not pay: the line every driver can read', v.NOT_PAY_LINE, 'Counts loads, not pay.')
eq('§1 and the one for an invoice that pays days', v.NOT_PAY_DAYS_LINE, 'Counts loads, not pay. Your invoice pays days.')
eq('§1 a lowered target, exact', v.LOWER_TARGET_LINE, 'Your target is lower this week for your approved time off.')
eq('§1 what to do about a wrong row', v.TELL_DISPATCH_LINE, 'If something looks wrong, tell dispatch.')
eq('§1 a week that can\'t be reached asks for nothing more', v.NEW_WEEK_LINE, 'A new week starts Saturday.')
eq('§1 the closing line, with ET', v.WEEK_CLOSES, 'Week closes Fri 11:59 PM ET')
eq('§1 the three labels', v.PACE_WORDS, { ahead: 'Ahead of Pace', 'on-track': 'On Track', 'needs-focus': 'Needs Focus' })
eq('§1 the two weeks he can open', (v.OWN_PERIODS || []).map((p) => [p.id, p.label]), [['this-week', 'This week'], ['last-week', 'Last week']])
eq('§1 the old neutral line is gone', v.NO_HOURS_LINE, undefined)
eq('§1 the office board keeps its three periods', v.PERIODS.map((p) => [p.id, p.label, p.kind]), [['this-week', 'This week', 'week'], ['last-week', 'Last week', 'week'], ['this-month', 'This month', 'month']])
eq('§1 the office board keeps its tiles\' words', [v.CATEGORIES.find((c) => c.id === 'safety').line, v.COMING_SOON, v.YOU], ["Safety isn't ranked yet.", 'Coming soon', 'You'])

// What a driver's screen may say: no ranking, no other driver, no hours figure, no pay figure.
const DRIVER_WORDS = [v.HOS_SHORT_LINE, v.TARGET_LINE, v.LOWER_TARGET_LINE, v.GUIDE_LINE, v.PRIVATE_LINE, v.DRIVE_HOURS_LINE, v.TELL_DISPATCH_LINE, v.NEW_WEEK_LINE, v.WEEK_CLOSES, v.NO_LOADS_LINE, v.NO_LOADS_LAST_WEEK, v.FAILED_LINE, ...Object.values(v.PACE_WORDS || {}), ...(v.OWN_PERIODS || []).map((p) => p.label)]
const DRIVER_TEMPLATE_TEXT = templateOf(card).replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ')
const BAR_TEMPLATE_TEXT = templateOf(bar).replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ')
const BANNED = /\bREI\b|efficiency|out of reach|streak|\btier\b|bonus|prize|gained|\$|mph|\brank|leaderboard|most loads|\bunit\b|\btop\b|fuel|idle|safety|competit|behind|falling|late\b|quota/i
eq('§1 every word a driver sees is free of ranking, score, tier and dollars',
  [...DRIVER_WORDS, DRIVER_TEMPLATE_TEXT, BAR_TEMPLATE_TEXT].filter((w) => w === undefined || BANNED.test(w)), [])
eq('§1 "pay" appears on one line only, the one saying this isn\'t it',
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
  id, start: START, end: END, credits: { value: 4.5, target: 7.5, deliveries: 5, pickups: 4 }, left: 3, percent: 60, pace: 'on-track', newWeekNote: false,
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
const COUNT_RULE = 'A pickup counts 0.5 and a drop-off counts 0.5, so each load is 1.'
const answerOf = (...weeks) => ({ view: 'no-hours-data', creditWeights: { delivery: 0.5, pickup: 0.5 }, invoicePaysDays: true, weeks })
const both = answerOf(week('this-week'), week('last-week', { start: '2026-10-24', end: '2026-10-30', credits: { value: 7.5, target: 7.5, deliveries: 8, pickups: 7 }, left: null, percent: 100, pace: null, loads: [] }))
const thisWeek = ownWeekView(both, 'this-week') || {}
eq('§6 this week, in words', { ...thisWeek, loads: undefined }, {
  range: 'Oct 31 – Nov 6', count: '4.5 of 7.5 loads', pace: 'On Track', paceId: 'on-track', width: '60%',
  left: '3 loads left this week.', closes: 'Week closes Fri 11:59 PM ET', newWeek: '', rule: COUNT_RULE,
  notPay: 'Counts loads, not pay. Your invoice pays days.', lowered: '', title: 'What counted this week', empty: v.NO_LOADS_LINE,
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
  notPay: 'Counts loads, not pay. Your invoice pays days.', lowered: '', title: 'What counted last week', empty: v.NO_LOADS_LAST_WEEK,
})
// The server decides which sentence is true of his invoice. Anything but a plain yes reads the
// shorter line, which is true of every driver.
const notPayFor = (invoicePaysDays) => ownWeekView({ ...answerOf(week('this-week')), invoicePaysDays }, 'this-week')?.notPay
eq('§6 a day-rate driver reads that his invoice pays days', notPayFor(true), 'Counts loads, not pay. Your invoice pays days.')
eq('§6 a percentage driver reads only that it counts loads, not pay', notPayFor(false), 'Counts loads, not pay.')
eq('§6 and so does anything but a plain yes', ['true', 1, null, undefined, {}].map(notPayFor), new Array(5).fill('Counts loads, not pay.'))
eq('§6 on last week too', ownWeekView({ ...answerOf(week('last-week', { left: null, pace: null })), invoicePaysDays: false }, 'last-week')?.notPay, 'Counts loads, not pay.')
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
eq('§6 more left than the days hold: a new week starts, and no closing line asking for more', [lowWeek?.left, lowWeek?.newWeek, lowWeek?.closes], ['6 loads left this week.', 'A new week starts Saturday.', ''])
eq('§6 only a true note shows it', [true, 'true', 1, undefined].map((newWeekNote) => wordsFor({ newWeekNote })?.newWeek), [v.NEW_WEEK_LINE, '', '', ''])
eq('§6 the count is the server\'s figure: the app never adds it up', wordsFor({ credits: { value: 9, target: 7.5, deliveries: 1, pickups: 1 } })?.count, '9 of 7.5 loads')
eq('§6 the width is the server\'s percent: the app never works it out', wordsFor({ credits: { value: 1, target: 7.5, deliveries: 1, pickups: 1 }, percent: 44 })?.width, '44%')
const decoyAnswer = {
  ...DECOYS, creditWeights: { delivery: 0.5, pickup: 0.5 },
  weeks: [{ ...week('this-week', {
    credits: { value: 4.5, target: 7.5, deliveries: 5, pickups: 4, ...DECOYS },
    loads: [{ ...DECOYS, loadId: 'DP-1', pickup: { ...DECOYS, day: 'Mon', credits: 0.5 }, delivery: { ...DECOYS, day: 'Tue', credits: 0.5 } }],
  }), ...DECOYS, gap: 'decoy-gap', expected: 41 }],
}
eq('§6 exactly these fields', Object.keys(ownWeekView(decoyAnswer, 'this-week') || {}), ['range', 'count', 'pace', 'paceId', 'width', 'left', 'closes', 'newWeek', 'rule', 'notPay', 'lowered', 'title', 'empty', 'loads'])
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
eq('§7 the bar\'s words', weekBarView(both), { text: 'This week: 4.5 of 7.5 loads', pace: 'On Track', paceId: 'on-track', width: '60%', hos: 'Hours of service come first.' })
eq('§7 no label, none on the bar', weekBarView(answerOf(week('this-week', { pace: null })))?.pace, '')
eq('§7 always this week, whichever order they come in', weekBarView(answerOf(week('last-week', { credits: { value: 1, target: 7.5, deliveries: 1, pickups: 1 } }), week('this-week')))?.text, 'This week: 4.5 of 7.5 loads')
eq('§7 a lower target reads as its own figure', weekBarView(answerOf(week('this-week', { credits: { value: 3, target: 6, deliveries: 3, pickups: 3 }, percent: 50 })))?.text, 'This week: 3 of 6 loads')
eq('§7 no decoy reaches the bar', showsDecoy(weekBarView(decoyAnswer)), [])
eq('§7 exactly five fields', Object.keys(weekBarView(both) || {}), ['text', 'pace', 'paceId', 'width', 'hos'])
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
eq('§9 the tab is named Performance', /const performanceTab = \{ key: 'performance', label: 'Performance'/.test(navScript), true)
eq('§9 no trophy: this isn\'t a competition', /&#127942;|🏆/.test(nav), false)

// ── §10 DriverView.vue ───────────────────────────────────────────────────────
console.log('§10 DriverView.vue')
const viewScript = scriptOf(view)
const viewTemplate = templateOf(view)
eq('§10 the tab starts hidden', viewScript.includes('const performanceTab = ref(false)'), true)
eq('§10 the nav shows it only on the answer', viewTemplate.includes(':show-performance="performanceTab"'), true)
eq('§10 the panel needs both the tab chosen and the answer', viewTemplate.includes('v-if="currentTab === \'performance\' && performanceTab"'), true)
const panel = (viewTemplate.match(/data-testid="perf-panel">([\s\S]*?)<\/section>/) || [])[1] || ''
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
  'DRIVE_HOURS_LINE', 'FAILED_LINE', 'GUIDE_LINE', 'HOS_LINE', 'PRIVATE_LINE', 'TARGET_LINE', 'TELL_DISPATCH_LINE',
  'item.line', 'item.title', 'week.closes', 'week.count', 'week.empty', 'week.left', 'week.lowered', 'week.newWeek', 'week.notPay', 'week.pace', 'week.range', 'week.rule', 'week.title',
].sort())
eq('§11 the pay line is the view\'s, so the server chooses it: neither constant is in the template', /NOT_PAY_LINE|NOT_PAY_DAYS_LINE|invoice pays/.test(card), false)
eq('§11 the lowered-target line only when the view has one, right after the target line', /\{\{ TARGET_LINE \}\}<\/p>\s*<p v-if="week\.lowered"[^>]*>\{\{ week\.lowered \}\}<\/p>/.test(cardTemplate), true)
eq('§11 no v-html', cardTemplate.includes('v-html'), false)
eq('§11 it never names the board: no ranking can reach a driver\'s screen', /boardUrl|boardView|BOARD_URL|rowView|tileView|leaderboard|\.tiles|\brank\b|unitLabel|isYou|\bYOU\b|COMING_SOON|CATEGORIES|\bPERIODS\b/.test(card), false)
eq('§11 its one read is his own week', [...cardScript.matchAll(/api\.\w+\(([^)]*)\)/g)].map((m) => m[1]), ['OWN_URL'])
eq('§11 it holds no name to show: no store, session or driver name', /useDriverStore|useAuthStore|driverStore|driverName|auth\./.test(card), false)
eq('§11 rows go through the view: no raw answer in the template', /\.answer|\.weeks|\.credits|\.percent|\.pickup|\.delivery/.test(cardTemplate), false)
eq('§11 the view comes from the lib', cardScript.includes('ownWeekView(answer.value, periodId.value)'), true)
eq('§11 read only: no write of any kind', /api\.(post|put|patch|del|request)\b|method:/.test(cardScript), false)
eq('§11 kept on the phone nowhere: no storage of any kind', /localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(card + libSrc), false)
eq('§11 no nudges: no timer, poll, countdown, socket or notification', /setTimeout|setInterval|requestAnimationFrame|useSocket|socket\.|Notification\b|countdown/i.test(card + libSrc), false)
const ARITHMETIC = /\s[*/%+-]\s|\+\+|--|\bMath\.|\.reduce\(|\.sort\(|\.toSorted\(|\.reverse\(|\.toFixed\(|parseFloat|parseInt|\bNumber\(|\.length\s*[*/%+-]/
eq('§11 the lib computes nothing', ARITHMETIC.test(codeOf(libSrc)), false)
eq('§11 the card computes nothing', ARITHMETIC.test(codeOf(cardScript)), false)
eq('§11 the template computes nothing', [...cardTemplate.matchAll(/\{\{([^}]*)\}\}/g)].filter((m) => /[*/%+-]/.test(m[1])).length, 0)
eq('§11 the fill is the server\'s percent', /:style="\{ width: week\.width \}"/.test(cardTemplate), true)
const hosChain = chainTo(cardTemplate, 'data-testid="perf-hos"')
eq('§11 the hours-of-service line is on the screen', !!hosChain, true)
eq('§11 it prints the fixed words', /data-testid="perf-hos">\{\{ HOS_LINE \}\}<\/p>/.test(cardTemplate), true)
eq('§11 outside every condition, its own included, so it shows whatever has loaded', (hosChain || []).filter((attrs) => /\bv-(if|else|else-if|show)\b/.test(attrs)).length, 0)
eq('§11 it can\'t be closed', /closeable|dismiss|\bclose\b/i.test(cardTemplate), false)
eq('§11 the target, the guide line, drive hours and the privacy line sit together', [cardTemplate.includes('{{ TARGET_LINE }}'), cardTemplate.includes('{{ GUIDE_LINE }}'), cardTemplate.includes('{{ DRIVE_HOURS_LINE }}'), cardTemplate.includes('{{ PRIVATE_LINE }}')], [true, true, true, true])
eq('§11 the label only when the view has one', /v-if="week\.pace"/.test(cardTemplate), true)
eq('§11 This week and Last week, both', /<van-tab v-for="period in OWN_PERIODS" /.test(cardTemplate), true)
eq('§11 the toggle is 44 px', /--van-tabs-line-height: 44px/.test(styleOf(card)), true)
eq('§11 Try again is 44 px', /\.perf-retry \{[^}]*min-height: 44px/.test(styleOf(card)), true)
eq('§11 no red, on any word', /\bred\b|danger|#ef4444|#dc2626|#b91c1c|#f87171|#ee0a24/i.test(card), false)
eq('§11 the server\'s "gone" hides the tab', cardScript.includes("if (isGoneAnswer(err.status)) emit('gone')"), true)

// ── §12 DriverWeekBar.vue ────────────────────────────────────────────────────
console.log('§12 DriverWeekBar.vue')
const barTemplate = templateOf(bar)
const barScript = scriptOf(bar)
eq('§12 it prints only the view\'s words', [...new Set([...barTemplate.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]))].sort(), ['bar.hos', 'bar.pace', 'bar.text'])
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
eq('§12 the short hours-of-service line is on it', barTemplate.includes('{{ bar.hos }}'), true)
eq('§12 the label only when the view has one', /v-if="bar\.pace"/.test(barTemplate), true)
eq('§12 no motion, nudge or countdown', /transition|animation|@keyframes|setTimeout|setInterval|requestAnimationFrame|countdown|\bpulse\b/i.test(bar), false)
eq('§12 no store, name or storage', /useDriverStore|useAuthStore|driverName|localStorage|sessionStorage/.test(bar), false)
eq('§12 no red, on any word', /\bred\b|danger|#ef4444|#dc2626|#b91c1c|#f87171|#ee0a24/i.test(bar), false)
eq('§12 it computes nothing', [ARITHMETIC.test(codeOf(barScript)), [...barTemplate.matchAll(/\{\{([^}]*)\}\}/g)].filter((m) => /[*/%+-]/.test(m[1])).length], [false, 0])

// ── §13 DriverPerformanceBoard.vue ───────────────────────────────────────────
console.log('§13 DriverPerformanceBoard.vue')
const boardTemplate = templateOf(board)
const boardScript = scriptOf(board)
eq('§13 it prints only what it always did', [...new Set([...boardTemplate.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]))].sort(), [
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
  const realAnswer = { view: 'no-hours-data', creditWeights: { ...server.CREDIT_WEIGHTS }, invoicePaysDays: true, weeks: [serverWeek] }
  const offWeek = server.personalWeek({ id: 'this-week', start: START, end: END, today: '2026-11-04', deliveries: 3, pickups: 0, offDays: ['2026-11-05'], openLoad: true, loads: [] })
  const offAnswer = { view: 'no-hours-data', creditWeights: { ...server.CREDIT_WEIGHTS }, invoicePaysDays: true, weeks: [offWeek] }
  eq('§14 a real day off: his lower figure, and the line that says why', [ownWeekView(offAnswer, 'this-week')?.count, ownWeekView(offAnswer, 'this-week')?.lowered], ['1.5 of 6 loads', 'Your target is lower this week for your approved time off.'])
  eq('§14 a real uncounted pickup, in true words', ownWeekView({ ...realAnswer, weeks: [{ ...serverWeek, loads: [server.countedLoad({ loadId: 'DP-5', pickupDay: '', deliveryDay: '2026-11-04' })] }] }, 'this-week')?.loads, [{ title: 'Load DP-5', line: 'Delivered Wed 0.5 · Pickup not counted this week' }])
  eq('§14 the server\'s own week, in words', [ownWeekView(realAnswer, 'this-week')?.count, ownWeekView(realAnswer, 'this-week')?.left, ownWeekView(realAnswer, 'this-week')?.pace, ownWeekView(realAnswer, 'this-week')?.width], ['2.5 of 7.5 loads', '5 loads left this week.', 'Needs Focus', '33%'])
  eq('§14 and its rows', ownWeekView(realAnswer, 'this-week')?.loads, [
    { title: 'Load DP-1', line: 'Picked up Mon 0.5 · Delivered Tue 0.5' },
    { title: 'Load DP-2', line: 'Delivered Wed 0.5 · Pickup counted last week' },
    { title: 'Load DP-3', line: 'Picked up Wed 0.5' },
    { title: 'Load DP-4', line: 'Picked up Wed 0.5' },
  ])
  eq('§14 the bar', weekBarView(realAnswer), { text: 'This week: 2.5 of 7.5 loads', pace: 'Needs Focus', paceId: 'needs-focus', width: '33%', hos: 'Hours of service come first.' })
  // The line's "each load is 1" is fixed words, so the server's own sum has to stay what they say.
  eq('§14 the line on how it counts, from the server\'s weights', ownWeekView(realAnswer, 'this-week')?.rule, COUNT_RULE)
  eq('§14 and its "each load is 1" is the server\'s own sum', [server.CREDIT_WEIGHTS.pickup + server.CREDIT_WEIGHTS.delivery, server.loadCredits(1, 1)], [1, 1])
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
eq('§15 only the driver\'s own screens import the lib', inClient(/from ['"][^'"]*lib\/driverPerformance(\.js)?['"]/), ['components/driver/DriverPerformanceBoard.vue', 'components/driver/DriverPerformanceTab.vue', 'views/DriverView.vue'])
eq('§15 only the lib reads the server\'s weights', inClient(/\bcreditWeights\b/), ['lib/driverPerformance.js'])
eq('§15 only the lib names his week\'s route', inClient(/api\/driver\/me\/performance/), ['lib/driverPerformance.js'])

done()
