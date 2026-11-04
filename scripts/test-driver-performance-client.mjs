#!/usr/bin/env node
// The driver's Performance tab (Driver Performance, Phase A): the pure lib
// client/src/lib/driverPerformance.js, and how DriverPerformanceTab.vue, BottomNav.vue and
// DriverView.vue use it. The server works out every figure and its privacy rules
// (scripts/test-driver-performance.js); here the app must show only what those answers allow.
//   §1  the fixed words, exact, and none of the words Phase A must not show
//   §2  parity with lib/driver-performance.js: categories, "Not ranked", the row's keys
//   §3  rowView(): only rank, unit, figure and "you"; nothing else a row carries gets through;
//       rank and figure as sent; a row without a rank always reads "Not ranked"
//   §4  the tiles: only Most loads can be live; a "Coming soon" tile never holds a figure
//   §5  boardView(): the chosen period, the server's order, the closing line on this week only
//   §6  ownWeekView(): load credits as sent; no hours, score, pace, tier or pay
//   §7  who gets the tab: only a 200 shows it, and only a Driver or Super Admin asks
//   §8  BottomNav.vue: the five tabs as they were, Performance only with its prop
//   §9  DriverView.vue: the panel behind the answer, the check after the load, nothing passed in
//   §10 DriverPerformanceTab.vue: prints only the views' fields; reads, never writes or stores;
//       computes nothing; the hours-of-service line outside every condition; no close control
//   §11 the real server rules through the real views, on made-up units
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

if (!fs.existsSync(LIB) || !fs.existsSync(CARD)) {
  eq('client/src/lib/driverPerformance.js exists', fs.existsSync(LIB), true)
  eq('client/src/components/driver/DriverPerformanceTab.vue exists', fs.existsSync(CARD), true)
  eq('BottomNav.vue takes showPerformance', read(NAV).includes('showPerformance'), true)
  eq('DriverView.vue names DriverPerformanceTab', read(VIEW).includes('DriverPerformanceTab'), true)
  done()
}

const v = await import(pathToFileURL(LIB).href)
const require = createRequire(import.meta.url)
const server = require(path.join(ROOT, 'lib', 'driver-performance.js'))
const libSrc = read(LIB)
const card = read(CARD)
const nav = read(NAV)
const view = read(VIEW)

const scriptOf = (src) => (src.match(/<script setup>([\s\S]*?)<\/script>/) || [])[1] || ''
const styleOf = (src) => (src.match(/<style scoped>([\s\S]*?)<\/style>/) || [])[1] || ''
const templateOf = (src) => src.slice(0, Math.max(0, src.indexOf('<script'))).replace(/<!--[\s\S]*?-->/g, '')
// Code with comments and quoted strings removed. Template literals stay, so arithmetic in a
// ${...} still shows.
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, ' ')
const has = (json, needle) => JSON.stringify(json).includes(needle)

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
  payDaily: 987, tier: 'decoy-tier', streak: 41, rei: 83.7, hours: 31.25, pace: 'decoy-pace', loadId: 'DECOY-LOAD', lane: 'decoy-lane', broker: 'decoy-broker',
})
const DECOY_MARKS = [DECOY_NAME, 'CE', '7701', '7702', 'decoy-', '987', '41', '83.7', '31.25', 'DECOY-LOAD']
const showsDecoy = (json) => DECOY_MARKS.filter((mark) => has(json, mark))

// ── §1 the words ─────────────────────────────────────────────────────────────
console.log('§1 the fixed words')
eq('§1 the hours-of-service line: no GPS sentence, "tell dispatch" until the tap exists, and no promise about the week', v.HOS_LINE,
  'Never drive past your hours of service to reach a target. Your 11-hour driving limit, 14-hour window and 60/70-hour limit come first. Your ELD log is what counts for your hours. If you stop to stay legal, tell dispatch.')
eq('§1 the guide line', v.GUIDE_LINE, 'Targets are a guide, not a requirement.')
eq('§1 the neutral line fits every truck and promises nothing', v.NO_HOURS_LINE, "Drive hours aren't shown yet.")
eq('§1 the Safety line claims nothing about what is recorded', v.CATEGORIES.find((c) => c.id === 'safety').line, "Safety isn't ranked yet.")
eq('§1 the closing line', v.WEEK_CLOSES, 'Week closes Fri 11:59 PM ET')
eq('§1 "Coming soon" and "You"', [v.COMING_SOON, v.YOU], ['Coming soon', 'You'])
eq('§1 the three periods', v.PERIODS.map((p) => [p.id, p.label, p.kind]), [['this-week', 'This week', 'week'], ['last-week', 'Last week', 'week'], ['this-month', 'This month', 'month']])
const WORDS = [
  v.GUIDE_LINE, v.WEEK_CLOSES, v.NOT_RANKED, v.NO_RANK, v.COMING_SOON, v.YOU, v.EMPTY_LINE, v.FAILED_LINE,
  ...v.PERIODS.map((p) => p.label), ...v.CATEGORIES.flatMap((c) => [c.title, c.line]),
]
const BANNED = /\bREI\b|efficiency|ahead of pace|on track|needs focus|out of reach|streak|\btier\b|bonus|prize|gained|\$|\bhours?\b|mph|\bpay\b/i
const TEMPLATE_TEXT = templateOf(card).replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ')
eq('§1 every word but the two lines about hours is free of hours, score, pace, tier and dollars',
  [...WORDS, TEMPLATE_TEXT].filter((w) => BANNED.test(w)), [])
eq('§1 the hours-of-service line names no dollar, tier or score', /\$|\btier\b|\bREI\b|estimated|GPS|\btap\b/i.test(v.HOS_LINE), false)
eq('§1 no "Coming soon" line names a unit or a figure', v.CATEGORIES.filter((c) => !c.live && /\d|#/.test(c.line)).map((c) => c.id), [])

// ── §2 parity with the server's rules ────────────────────────────────────────
console.log('§2 parity with lib/driver-performance.js')
eq('§2 the same categories, in the same order', v.CATEGORIES.map((c) => c.id), server.CATEGORIES.map((c) => c.id))
eq('§2 only the categories the server calls live are live', v.CATEGORIES.filter((c) => c.live).map((c) => c.id), server.CATEGORIES.filter((c) => c.live).map((c) => c.id))
eq('§2 the same "Not ranked"', v.NOT_RANKED, server.NOT_RANKED)
const fieldsRead = new Set()
v.rowView(new Proxy({ rank: 1, unitLabel: '#701', value: 6, display: '6 loads', isYou: true, ...DECOYS }, {
  get(target, key) { fieldsRead.add(String(key)); return target[key] },
}))
eq('§2 a row is read for the server\'s row keys only, and never for its raw value', [...fieldsRead].sort(), server.ROW_KEYS.filter((k) => k !== 'value').sort())

// ── §3 one row ───────────────────────────────────────────────────────────────
console.log('§3 rowView()')
const ROW_VIEW_KEYS = ['rank', 'unit', 'figure', 'you']
const row = (over) => ({ rank: 1, unitLabel: '#701', value: 6, display: '6 loads', isYou: false, ...over })
eq('§3 exactly four fields', Object.keys(v.rowView(row())), ROW_VIEW_KEYS)
eq('§3 rank, unit and figure as sent', v.rowView(row()), { rank: '1', unit: '#701', figure: '6 loads', you: false })
eq('§3 another driver\'s name and everything else on the row stay out', showsDecoy(v.rowView(row(DECOYS))), [])
eq('§3 the figure is the server\'s words, not the raw value', v.rowView(row({ value: 99, display: '6 loads' })).figure, '6 loads')
eq('§3 the rank is the server\'s', v.rowView(row({ rank: 5 })).rank, '5')
eq('§3 only a true isYou marks the row', [true, 'true', 1, undefined].map((isYou) => v.rowView(row({ isYou })).you), [true, false, false, false])
const NOT_RANKED_VIEW = { rank: v.NO_RANK, unit: '#706', figure: 'Not ranked', you: false }
eq('§3 a row without a rank reads "Not ranked"', v.rowView({ rank: null, unitLabel: '#706', value: null, display: 'Not ranked', isYou: false }), NOT_RANKED_VIEW)
eq('§3 a reason sent by mistake never shows', v.rowView({ rank: null, unitLabel: '#706', value: null, display: 'Accident on file', reason: 'decoy-reason', isYou: false }), NOT_RANKED_VIEW)
eq('§3 no rank, whatever the shape, reads the same', [0, -1, 1.5, '1', undefined].map((rank) => v.rowView(row({ rank, unitLabel: '#706' }))), new Array(5).fill(NOT_RANKED_VIEW))
eq('§3 rank only is allowed: an empty figure stays empty', v.rowView(row({ value: null, display: '' })).figure, '')
eq('§3 nothing at all still gives the four fields', v.rowView(null), { rank: v.NO_RANK, unit: '', figure: 'Not ranked', you: false })

// ── §4 the tiles ─────────────────────────────────────────────────────────────
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
eq('§4 the three lines differ', new Set(standard.slice(1).map((t) => t.line)).size, 3)
const stuffed = tilesOf([liveCat('most-loads', [row()]), ...SOON_IDS.map((id) => soonCat(id, FIGURES))])
eq('§4 a "Coming soon" tile drops any rows an answer holds', stuffed.slice(1).map((t) => t.rows.length), [0, 0, 0])
eq('§4 so no figure of theirs can show', [has(stuffed.slice(1), '0.61'), has(stuffed.slice(1), '8%'), has(stuffed.slice(1), '#701')], [false, false, false])
const forcedLive = tilesOf([liveCat('most-loads', [row()]), ...SOON_IDS.map((id) => liveCat(id, FIGURES))])
eq('§4 in Phase A the other three stay "Coming soon" even if an answer calls them live', forcedLive.slice(1).map((t) => [t.comingSoon, t.rows.length]), new Array(3).fill([true, 0]))
eq('§4 Most loads not live in the answer shows no rows', tilesOf([soonCat('most-loads', [row()])])[0].rows.length, 0)
eq('§4 a missing category is "Coming soon"', tilesOf([]).map((t) => t.comingSoon), [true, true, true, true])
eq('§4 an unknown category never shows', tilesOf([liveCat('top-earner', FIGURES)]).map((t) => t.id).includes('top-earner'), false)
eq('§4 a live tile with an empty list is not "Coming soon"', [tilesOf([liveCat('most-loads', [])])[0].comingSoon, tilesOf([liveCat('most-loads', [])])[0].rows], [false, []])

// ── §5 the board ─────────────────────────────────────────────────────────────
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
eq('§5 exactly three fields on a board', Object.keys(v.boardView(twoWeeks, 'this-week')), ['range', 'closes', 'tiles'])
const outOfOrder = { boards: [{ id: WEEK_ID, start: START, end: END, categories: [liveCat('most-loads', [row({ rank: 3, unitLabel: '#703' }), row({ rank: 1, unitLabel: '#701' }), row({ rank: 1, unitLabel: '#702' })])] }] }
eq('§5 the server\'s order and ranks stand: the app neither sorts nor numbers', v.boardView(outOfOrder, WEEK_ID).tiles[0].rows.map((r) => [r.rank, r.unit]), [['3', '#703'], ['1', '#701'], ['1', '#702']])
eq('§5 a period the answer doesn\'t hold is null', [v.boardView(twoWeeks, 'this-month'), v.boardView(null, 'this-week'), v.boardView({}, 'this-week')], [null, null, null])
eq('§5 the URLs', [v.boardUrl('week'), v.boardUrl('month'), v.OWN_URL], ['/api/driver/performance/leaderboard?period=week', '/api/driver/performance/leaderboard?period=month', '/api/driver/me/performance'])
eq('§5 each period\'s answer', v.PERIODS.map((p) => v.periodKind(p.id)), ['week', 'week', 'month'])

// ── §6 his own week ──────────────────────────────────────────────────────────
console.log('§6 ownWeekView()')
const ownWeek = (id, start, end, credits) => ({ id, start, end, credits })
const ownAnswer = {
  view: 'no-hours-data',
  creditWeights: { delivery: 1, pickup: 0.5 },
  weeks: [
    ownWeek('this-week', '2026-10-31', '2026-11-06', { value: 3.5, target: 7.5, deliveries: 2, pickups: 3 }),
    ownWeek('last-week', '2026-10-24', '2026-10-30', { value: 7.5, target: 7.5, deliveries: 5, pickups: 5 }),
  ],
}
eq('§6 This week, in words', v.ownWeekView(ownAnswer, 'this-week'), { label: 'This week', range: 'Oct 31 – Nov 6', closes: '', credits: '3.5 of 7.5 load credits', breakdown: '2 delivered (1 each), 3 picked up (0.5 each)' })
eq('§6 Last week follows the toggle', v.ownWeekView(ownAnswer, 'last-week'), { label: 'Last week', range: 'Oct 24 – Oct 30', closes: '', credits: '7.5 of 7.5 load credits', breakdown: '5 delivered (1 each), 5 picked up (0.5 each)' })
eq('§6 This month has no credits: the card stays on this week, and says when it closes', v.ownWeekView(ownAnswer, 'this-month'), { label: 'This week', range: 'Oct 31 – Nov 6', closes: 'Week closes Fri 11:59 PM ET', credits: '3.5 of 7.5 load credits', breakdown: '2 delivered (1 each), 3 picked up (0.5 each)' })
const doesntAddUp = { creditWeights: { delivery: 1, pickup: 0.5 }, weeks: [ownWeek('this-week', START, END, { value: 9, target: 7.5, deliveries: 1, pickups: 1 })] }
eq('§6 the credits are the server\'s figure: the app never adds them up', v.ownWeekView(doesntAddUp, 'this-week').credits, '9 of 7.5 load credits')
const decoyWeek = {
  ...DECOYS,
  creditWeights: { delivery: 1, pickup: 0.5 },
  weeks: [{ ...ownWeek('this-week', START, END, { value: 3.5, target: 7.5, deliveries: 2, pickups: 3, ...DECOYS }), ...DECOYS, gap: 'decoy-gap', expected: 41 }],
}
eq('§6 exactly five fields', Object.keys(v.ownWeekView(decoyWeek, 'this-week')), ['label', 'range', 'closes', 'credits', 'breakdown'])
eq('§6 no hours, score, pace, tier, pay or name reaches the card, whatever the answer holds', showsDecoy(v.ownWeekView(decoyWeek, 'this-week')), [])
eq('§6 no answer, no card', [v.ownWeekView(null, 'this-week'), v.ownWeekView({}, 'this-week'), v.ownWeekView({ weeks: [] }, 'this-week')], [null, null, null])
const brokenWeek = { creditWeights: { delivery: 1, pickup: 0.5 }, weeks: [ownWeek('this-week', START, END, { value: '3.5', target: 7.5, deliveries: 2, pickups: 3 })] }
eq('§6 a figure that isn\'t a number, no card', v.ownWeekView(brokenWeek, 'this-week'), null)
eq('§6 no weights, no card', v.ownWeekView({ weeks: ownAnswer.weeks }, 'this-week'), null)

// ── §7 who gets the tab ──────────────────────────────────────────────────────
console.log('§7 who gets the tab')
eq('§7 a Driver asks with his own route', v.tabProbeUrl('Driver'), '/api/driver/me/performance')
eq('§7 a Super Admin on /driver asks with the board', v.tabProbeUrl('Super Admin'), '/api/driver/performance/leaderboard?period=week')
eq('§7 no other role asks', ['Dispatcher', 'Investor', 'KPI Viewer', '', undefined, null].map((role) => v.tabProbeUrl(role)), ['', '', '', '', '', ''])
eq('§7 only a Driver has a week of his own', ['Driver', 'Super Admin', 'Dispatcher', undefined].map((role) => v.showsMyWeek(role)), [true, false, false, false])
eq('§7 a 200 shows the tab', [v.tabAfterAnswer(200, false), v.tabAfterAnswer(200, true)], [true, true])
eq('§7 404 (the switch off, or not on the board), 401 and 403 hide it', [404, 401, 403].flatMap((s) => [v.tabAfterAnswer(s, true), v.tabAfterAnswer(s, false)]), [false, false, false, false, false, false])
eq('§7 a failure says nothing: a hidden tab stays hidden', [503, 500, 429, 0].map((s) => v.tabAfterAnswer(s, false)), [false, false, false, false])
eq('§7 a failure says nothing: a shown tab stays', [503, 500, 429, 0].map((s) => v.tabAfterAnswer(s, true)), [true, true, true, true])
eq('§7 what counts as gone', [404, 401, 403, 503, 200, 0].map(v.isGoneAnswer), [true, true, true, false, false, false])

// ── §8 BottomNav.vue ─────────────────────────────────────────────────────────
console.log('§8 BottomNav.vue')
const navScript = scriptOf(nav)
const baseTabsSrc = (navScript.match(/const baseTabs = \[([\s\S]*?)\n\]/) || [])[1] || ''
eq('§8 the five tabs, in their order', [...baseTabsSrc.matchAll(/key: '(\w+)', label: '(\w+)'/g)].map((m) => [m[1], m[2]]),
  [['loads', 'Loads'], ['notifications', 'Alerts'], ['kit', 'Kit'], ['messages', 'Messages'], ['invoices', 'Invoices']])
eq('§8 showPerformance defaults off', /showPerformance: \{ type: Boolean, default: false \}/.test(navScript), true)
eq('§8 Performance joins only with the prop, last', navScript.includes('computed(() => (props.showPerformance ? [...baseTabs, performanceTab] : baseTabs))'), true)
eq('§8 the tab is named Performance', /const performanceTab = \{ key: 'performance', label: 'Performance'/.test(navScript), true)

// ── §9 DriverView.vue ────────────────────────────────────────────────────────
console.log('§9 DriverView.vue')
const viewScript = scriptOf(view)
const viewTemplate = templateOf(view)
eq('§9 the tab starts hidden', viewScript.includes('const performanceTab = ref(false)'), true)
eq('§9 the nav shows it only on the answer', viewTemplate.includes(':show-performance="performanceTab"'), true)
eq('§9 the panel needs both the tab chosen and the answer', viewTemplate.includes('v-if="currentTab === \'performance\' && performanceTab"'), true)
eq('§9 the panel is given nothing but whether he has a week', (viewTemplate.match(/<DriverPerformanceTab[^>]*>/) || [''])[0], '<DriverPerformanceTab :show-my-week="showsMyWeek(auth.user?.role)" @gone="performanceTab = false" />')
const check = (viewScript.match(/async function checkPerformanceTab\(\) \{([\s\S]*?)\n\}/) || [])[1] || ''
eq('§9 the check asks by role and never on the onboarding screen', check.includes('tabProbeUrl(auth.user?.role)') && check.includes('if (!url || isOnboarding.value) return'), true)
eq('§9 the answer decides', check.includes('performanceTab.value = tabAfterAnswer(status, performanceTab.value)'), true)
const initial = (viewScript.match(/async function attemptInitialLoad\(\) \{([\s\S]*?)\n\}/) || [])[1] || ''
const afterLoad = initial.indexOf('checkPerformanceTab()')
eq('§9 the check runs after the driver\'s data has loaded, and only then', afterLoad > initial.indexOf('await driverStore.loadData()') && afterLoad < initial.indexOf('} catch {'), true)
eq('§9 a phone coming back to the app asks again', (viewScript.match(/function onVisibilityChange\(\) \{([\s\S]*?)\n\}/) || [''])[0].includes('checkPerformanceTab()'), true)
eq('§9 a tab taken away goes back to Loads', /watch\(performanceTab, \(shown\) => \{\s*if \(!shown && currentTab\.value === 'performance'\) handleTabSwitch\('loads'\)/.test(viewScript), true)
eq('§9 the store never holds it', read(path.join(ROOT, 'client', 'src', 'stores', 'driver.js')).includes('performance'), false)

// ── §10 DriverPerformanceTab.vue ─────────────────────────────────────────────
console.log('§10 DriverPerformanceTab.vue')
const cardTemplate = templateOf(card)
const cardScript = scriptOf(card)
const printed = [...cardTemplate.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]).sort()
eq('§10 it prints only these, so a name or a figure can\'t be added by accident', [...new Set(printed)], [
  'COMING_SOON', 'EMPTY_LINE', 'FAILED_LINE', 'GUIDE_LINE', 'HOS_LINE', 'NO_HOURS_LINE', 'YOU',
  'board.closes', 'board.range', 'row.figure', 'row.rank', 'row.unit', 'tile.line', 'tile.title',
  'week.breakdown', 'week.closes', 'week.credits', 'week.label', 'week.range',
].sort())
eq('§10 no v-html', cardTemplate.includes('v-html'), false)
const rowFields = [...new Set([...cardTemplate.matchAll(/\brow\.(\w+)/g)].map((m) => m[1]))].sort()
eq('§10 a row\'s fields, all from rowView()', rowFields, ['figure', 'rank', 'unit', 'you'])
eq('§10 it holds no name to show: no store, session or driver name', /useDriverStore|useAuthStore|driverStore|driverName|auth\./.test(card), false)
eq('§10 rows go through the views: no raw answer in the template', /\.answer|\.boards|\.categories|\.display|\.value\b|unitLabel/.test(cardTemplate), false)
eq('§10 the views come from the lib', [cardScript.includes('boardView(boards[kind.value].answer, periodId.value)'), cardScript.includes('ownWeekView(own.answer, periodId.value)')], [true, true])
eq('§10 read only: no write of any kind', /api\.(post|put|patch|del|request)\b|method:/.test(cardScript), false)
eq('§10 kept on the phone nowhere: no storage of any kind', /localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(card + libSrc), false)
eq('§10 no nudges: no timer, poll, countdown, socket or notification', /setTimeout|setInterval|requestAnimationFrame|useSocket|socket\.|Notification\b|countdown/i.test(card + libSrc), false)
const ARITHMETIC = /\s[*/%+-]\s|\+\+|--|\bMath\.|\.reduce\(|\.sort\(|\.toSorted\(|\.reverse\(|\.toFixed\(|parseFloat|parseInt|\bNumber\(|\.length\s*[*/%+-]/
eq('§10 the lib computes nothing', ARITHMETIC.test(codeOf(libSrc)), false)
eq('§10 the card computes nothing', ARITHMETIC.test(codeOf(cardScript)), false)
eq('§10 the template computes nothing', [...cardTemplate.matchAll(/\{\{([^}]*)\}\}/g)].filter((m) => /[*/%+-]/.test(m[1])).length, 0)
const hosChain = chainTo(cardTemplate, 'data-testid="perf-hos"')
eq('§10 the hours-of-service line is on the screen', !!hosChain, true)
eq('§10 it prints the fixed words', /data-testid="perf-hos">\{\{ HOS_LINE \}\}<\/p>/.test(cardTemplate), true)
eq('§10 outside every condition, its own included, so it shows whatever has loaded', (hosChain || []).filter((attrs) => /\bv-(if|else|else-if|show)\b/.test(attrs)).length, 0)
eq('§10 it can\'t be closed', /closeable|dismiss|\bclose\b/i.test(cardTemplate), false)
const guideChain = chainTo(cardTemplate, 'data-testid="perf-credits"')
eq('§10 the target shows only inside My week, with the guide and neutral lines beside it',
  [(guideChain || []).some((attrs) => attrs.includes('v-if="showMyWeek"')), cardTemplate.includes('{{ NO_HOURS_LINE }}'), cardTemplate.includes('{{ GUIDE_LINE }}')], [true, true, true])
eq('§10 My week only for a viewer with one', [cardScript.includes('if (props.showMyWeek) loadOwn()'), /showMyWeek: \{ type: Boolean, default: false \}/.test(cardScript)], [true, true])
eq('§10 Vant on a driver surface, its styles loaded', ['vant/es/tabs/style', 'vant/es/tab/style', 'vant/es/tag/style', "from 'vant'"].map((s) => cardScript.includes(s)), [true, true, true, true])
eq('§10 the three choices are 44 px', /--van-tabs-line-height: 44px/.test(styleOf(card)), true)
eq('§10 Try again is 44 px', /\.perf-retry \{[^}]*min-height: 44px/.test(styleOf(card)), true)
eq('§10 a row is 44 px', /\.perf-row \{[^}]*min-height: 44px/.test(styleOf(card)), true)
eq('§10 no red', /\bred\b|danger|#ef4444|#dc2626|#b91c1c|#f87171|#ee0a24/i.test(card), false)
eq('§10 the server\'s "gone" hides the tab', cardScript.includes("if (isGoneAnswer(err.status)) emit('gone')"), true)
eq('§10 a period is read once, when first chosen', cardScript.includes("if (boards[which].state === 'idle') loadBoard(which)"), true)

// ── §11 the real server rules through the real views ─────────────────────────
console.log('§11 lib/driver-performance.js through the views')
const mostLoads = server.categoryById('most-loads')
const entries = [
  { ...DECOYS, driverId: 11, label: '#701', ownLabel: '#701', value: 6 },
  { ...DECOYS, driverId: 12, label: '#702', ownLabel: '#702', value: 3 },
  { ...DECOYS, driverId: 13, label: '#703 (1)', ownLabel: '#703 (1, to Nov 2)', value: 3 },
  { ...DECOYS, driverId: 14, label: '#704', ownLabel: '#704', value: null },
  { ...DECOYS, driverId: 15, label: '#705', ownLabel: '#705', value: 0 },
]
const ranked = server.rankEntries(mostLoads, entries)
const projected = (viewer) => ({
  boards: [{ id: WEEK_ID, start: START, end: END, categories: server.CATEGORIES.map((c) => server.projectCategory(c, c.live ? ranked : [], viewer)) }],
})
const tilesFor = (viewer) => v.boardView(projected(viewer), WEEK_ID).tiles
eq('§11 the rows a driver sees', tilesFor(13)[0].rows, [
  { rank: '1', unit: '#701', figure: '6 loads', you: false },
  { rank: '2', unit: '#702', figure: '3 loads', you: false },
  { rank: '2', unit: '#703 (1, to Nov 2)', figure: '3 loads', you: true },
  { rank: '4', unit: '#705', figure: '0 loads', you: false },
  { rank: v.NO_RANK, unit: '#704', figure: 'Not ranked', you: false },
])
eq('§11 another driver sees that row without the dates, and not as his', tilesFor(11)[0].rows[2], { rank: '2', unit: '#703 (1)', figure: '3 loads', you: false })
eq('§11 a Super Admin has no row of his own', tilesFor(null)[0].rows.filter((r) => r.you).length, 0)
eq('§11 the other three are "Coming soon"', tilesFor(13).slice(1).map((t) => [t.id, t.comingSoon, t.rows.length]), SOON_IDS.map((id) => [id, true, 0]))
eq('§11 nothing else on an entry reaches the screen', showsDecoy(tilesFor(13)), [])
const realOwn = {
  view: 'no-hours-data',
  creditWeights: { ...server.CREDIT_WEIGHTS },
  weeks: [server.ownWeekCard({ id: 'this-week', start: START, end: END, deliveries: 2, pickups: 3 })],
}
eq('§11 the server\'s own week, in words', [v.ownWeekView(realOwn, 'this-week').credits, v.ownWeekView(realOwn, 'this-week').breakdown], ['3.5 of 7.5 load credits', '2 delivered (1 each), 3 picked up (0.5 each)'])

done()
