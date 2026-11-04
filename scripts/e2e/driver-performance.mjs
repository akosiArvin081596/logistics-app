#!/usr/bin/env node
// LogisX — the driver's Performance tab (Driver Performance, Phase A), on made-up data only.
//
// As a made-up Driver ("Casey Example", on made-up unit #705), at 390x844 and 1280x800:
//   W   the sixth tab, "Performance", fits the bar and is 44 px or more; This week: the rows in
//       the server's order with its ranks, ties and "Not ranked", "You" on his row only; "Week
//       closes Fri 11:59 PM ET"; three "Coming soon" tiles with one line each and no figure; My
//       week in load credits with the neutral and guide lines; the hours-of-service line, exact;
//       the three choices 44 px or more; no sideways scroll
//   L   Last week: its own rows, his row with its dates, another handover row without; My week
//       follows; no closing line
//   M   This month: read once, its own rows; My week stays on this week and says when it closes
//   R   read only: the page sent no write while the tab was in use
//   D   decoys: answers that wrongly carry names, reasons, pay, hours, a score and figures on the
//       "Coming soon" tiles show none of them
//   F   the board fails (503): the line, Try again and the hours-of-service line show; Try again
//       brings the rows back
//   G   the kill switch goes off mid-session: the next read answers 404 and the app goes back to
//       Loads with five tabs
// And at 390x844:
//   O   the kill switch off (404 FEATURE_OFF): five tabs as before, the board never read
//   N   a driver not on the board (404 NOT_ELIGIBLE): the same five tabs, no word about why
//   U   the check fails (503): no tab; a phone coming back to the app asks again and the tab shows
// And a made-up Super Admin on /driver at 1280x800:
//   A   the tab and the board, no My week, no "You", his own-week route never read
//
// Like time-off-chr-draft.mjs this boots no server.js, opens no database, reads no settings file
// or key and signs nobody in. It serves the checkout's built client/dist from its own static
// server on 127.0.0.1 (E2E_PORT, or a free port the system picks) and answers every /api request
// in the browser with made-up fixtures in the shapes lib/driver-performance-routes.js sends. Every
// request to another host is aborted, the socket included.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/driver-performance.mjs
//
// Env: E2E_PORT (default: a free port; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "driver-performance"), HEADED=1, CHROME_PATH, E2E_WORK_DIR, SHOT_DIR (an
// absolute folder outside the checkout; default ~/LogisX-replica/screens/driver-performance).
// Output: PASS/FAIL lines, a final count, the screenshots and <work dir>/results-<OUT_TAG>.md.
// Exit 0 only when every row PASSes.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import paths from './paths.cjs'

const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'driver-performance').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.homedir(), 'LogisX-replica', 'screens', 'driver-performance')
const PHONE = { tag: '390x844', viewport: { width: 390, height: 844 } }
const DESKTOP = { tag: '1280x800', viewport: { width: 1280, height: 800 } }

function die(msg) {
  console.error(`driver-performance: ${msg}`)
  process.exit(2)
}

if (process.env.E2E_PORT && (!Number.isInteger(ASKED_PORT) || ASKED_PORT < 1024 || ASKED_PORT > 65535)) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (ASKED_PORT === 3000 || ASKED_PORT === 5173) die(`refusing port ${ASKED_PORT}: 3000 is production's port on the VPS and 5173 is Vite's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm --prefix client run build\` first`)
if (process.env.SHOT_DIR && !path.isAbsolute(process.env.SHOT_DIR)) die('SHOT_DIR must be an absolute path')
{
  const rel = path.relative(paths.REPO, SHOT_DIR)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) die(`SHOT_DIR ${SHOT_DIR} is inside the checkout: pick a folder outside it`)
}

// ---------------------------------------------------------------- the words the screen must say
const HOS_LINE = 'Never drive past your hours of service to reach a target. Your 11-hour driving limit, 14-hour window and 60/70-hour limit come first. Your ELD log is what counts for your hours. If you stop to stay legal, tell dispatch: that week is excused.'
const GUIDE_LINE = 'Targets are a guide, not a requirement.'
const NO_HOURS_LINE = "Drive hours will show here when your truck's ELD reports them."
const WEEK_CLOSES = 'Week closes Fri 11:59 PM ET'
const FAILED_LINE = "Performance can't be shown right now. Try again in a minute."
const BASE_TABS = ['Loads', 'Alerts', 'Kit', 'Messages', 'Invoices']
const ALL_TABS = [...BASE_TABS, 'Performance']
const TILES = ['Most loads', 'Least fuel cost', 'Safety', 'Lowest idle']

// ---------------------------------------------------------------- made-up fixtures
const DRIVER = { id: 90321, username: 'qa-performance-driver', role: 'Driver', driverName: 'Casey Example', email: '', fullName: 'Casey Example', companyName: '', mustChangePassword: false }
const ADMIN = { id: 90320, username: 'qa-performance-admin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Performance Admin', companyName: '', mustChangePassword: false }
const DAY = 24 * 60 * 60 * 1000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// The business day, in the app's zone, as the server would send it, and its Sat-Fri week.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const dayIndex = (k) => Math.round(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10))) / DAY)
const shift = (k, n) => new Date((dayIndex(k) + n) * DAY).toISOString().slice(0, 10)
const md = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8, 10))}`
function rangeText(from, to) {
  if (from === to) return md(from)
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${md(from)}, ${from.slice(0, 4)} – ${md(to)}, ${to.slice(0, 4)}`
  return `${md(from)} – ${md(to)}`
}
const THIS_START = shift(TODAY, -((new Date(dayIndex(TODAY) * DAY).getUTCDay() + 1) % 7))
const THIS_END = shift(THIS_START, 6)
const LAST_START = shift(THIS_START, -7)
const LAST_END = shift(THIS_START, -1)
const MONTH_START = `${TODAY.slice(0, 7)}-01`
const MONTH_END = new Date(Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)), 0)).toISOString().slice(0, 10)

const ranked = (rank, unitLabel, loads, isYou = false) => ({ rank, unitLabel, value: loads, display: `${loads} load${loads === 1 ? '' : 's'}`, isYou })
const notRanked = (unitLabel) => ({ rank: null, unitLabel, value: null, display: 'Not ranked', isYou: false })

const THIS_ROWS = [
  ranked(1, '#701', 6), ranked(2, '#702', 5), ranked(2, '#704', 5), ranked(4, '#705', 3, true), ranked(5, 'INV-00-Z', 1),
  ranked(6, '#703 (1)', 0), ranked(6, '#703 (2)', 0), notRanked('#706'), notRanked('#707'),
]
const OWN_HANDOVER = `#705 (1, to ${md(shift(LAST_END, -2))})`
const LAST_ROWS = [ranked(1, '#702', 7), ranked(2, OWN_HANDOVER, 5, true), ranked(2, '#705 (2)', 5), ranked(4, '#701', 4)]
const MONTH_ROWS = [ranked(1, '#701', 19), ranked(2, '#705', 17, true), ranked(3, '#702', 12)]

const SOON_IDS = ['least-fuel-cost', 'safety', 'lowest-idle']
const live = (rows) => ({ id: 'most-loads', status: 'live', listed: rows.length, rows })
const soon = (id, rows = []) => ({ id, status: 'coming-soon', listed: null, rows })
const asViewer = (rows, who) => (who.role === 'Driver' ? rows : rows.map((r) => ({ ...r, isYou: false })))
const categories = (rows, who, soonRows = () => []) => [live(asViewer(rows, who)), ...SOON_IDS.map((id) => soon(id, soonRows(id)))]

// What the server must never send. If it did, none of it may show.
const DECOY_NAME = 'Decoy Peerdriver'
const DECOY_FIELDS = { driverName: DECOY_NAME, name: DECOY_NAME, driverId: 7711, reason: 'Accident on file', payDaily: 987, tier: 'Tier 1 ($325/day)', rei: 83.7, hours: 31.25, pace: 'Ahead of Pace' }
const DECOY_FIGURES = [
  { rank: 1, unitLabel: '#701', value: 0.61, display: '$0.61/mi', isYou: false },
  { rank: 2, unitLabel: '#702', value: 8, display: '8% idle', isYou: false },
]
const DECOY_TEXT = [DECOY_NAME, 'Accident on file', '987', '$', '83.7', '31.25', 'Ahead of Pace', 'Tier 1', '0.61', '8% idle', '42.5', 'out of reach']

function boardBody(kind, who, state) {
  const extra = state.decoys ? (rows) => rows.map((r) => ({ ...r, ...DECOY_FIELDS })) : (rows) => rows
  const soonRows = state.decoys ? () => DECOY_FIGURES : () => []
  if (kind === 'month') {
    return { period: 'month', view: 'full', boards: [{ id: 'this-month', start: MONTH_START, end: MONTH_END, categories: categories(extra(MONTH_ROWS), who, soonRows) }] }
  }
  return {
    period: 'week',
    view: 'full',
    boards: [
      { id: 'this-week', start: THIS_START, end: THIS_END, categories: categories(extra(THIS_ROWS), who, soonRows) },
      { id: 'last-week', start: LAST_START, end: LAST_END, categories: categories(extra(LAST_ROWS), who, soonRows) },
    ],
  }
}

function ownBody(state) {
  const decoy = state.decoys ? DECOY_FIELDS : {}
  return {
    view: 'no-hours-data',
    creditWeights: { delivery: 1, pickup: 0.5 },
    weeks: [
      { id: 'this-week', start: THIS_START, end: THIS_END, credits: { value: 3.5, target: 7.5, deliveries: 2, pickups: 3, ...decoy }, ...decoy },
      { id: 'last-week', start: LAST_START, end: LAST_END, credits: { value: 7.5, target: 7.5, deliveries: 5, pickups: 5, ...decoy }, ...decoy },
    ],
    ...decoy,
  }
}

// `own` and `board` say how each route answers: 200, or a status with its code.
function freshState({ own = 200, board = 200, decoys = false } = {}) {
  return { own, board, decoys, calls: { own: 0, week: 0, month: 0 } }
}

const REFUSALS = {
  off: { status: 404, body: { error: 'Not found', code: 'FEATURE_OFF' } },
  notEligible: { status: 404, body: { error: 'Not found', code: 'NOT_ELIGIBLE' } },
  unavailable: { status: 503, body: { error: "Performance can't be worked out right now. Try again in a minute.", code: 'PERFORMANCE_UNAVAILABLE' } },
  forbidden: { status: 403, body: { error: 'Forbidden' } },
}

function driverPayload(who) {
  return {
    loads: [],
    headers: { jobTracking: [], carrierDB: [] },
    onboarding: { user_id: who.id, status: 'fully_onboarded', onboarded_at: new Date(Date.now() - 30 * DAY).toISOString(), documents: [], totalDocs: 5 },
    driverInfo: null, truck: null, messages: [], notifications: [], expenses: [], drivers: [], invoices: [], sharedDocuments: [], truckDocuments: [],
  }
}

function answerGet(who, state, u) {
  const pathname = u.pathname
  if (pathname === '/api/auth/session') return { status: 200, body: { authenticated: true, user: who, appTimeZone: 'America/New_York' } }
  if (pathname === '/api/driver/me/performance') {
    state.calls.own++
    if (who.role !== 'Driver') return REFUSALS.forbidden
    return state.own === 200 ? { status: 200, body: ownBody(state) } : state.own
  }
  if (pathname === '/api/driver/performance/leaderboard') {
    const kind = u.searchParams.get('period') || 'week'
    state.calls[kind === 'month' ? 'month' : 'week']++
    if (kind === 'month' && state.monthAnswer) return state.monthAnswer
    return state.board === 200 ? { status: 200, body: boardBody(kind, who, state) } : state.board
  }
  if (pathname === '/api/driver/position') return { status: 200, body: { ok: false } }
  if (pathname === '/api/fuel/range') return { status: 200, body: { ok: false } }
  if (/^\/api\/driver\/[^/]+$/.test(pathname)) return { status: 200, body: driverPayload(who) }
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the performance check"}')
    return
  }
  const file = path.resolve(DIST, '.' + path.posix.normalize(rel))
  const inside = file === DIST || file.startsWith(DIST + path.sep)
  const target = inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(DIST, 'index.html')
  res.writeHead(200, { 'content-type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(target).pipe(res)
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port }, () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
  })
}

// ---------------------------------------------------------------- results
const rows = []
const writes = []
const unanswered = new Set()
const pageErrors = []
const offHost = new Set()
let exitCode = 0
function record(step, title, expected, observed, ok, shotFile = '') {
  if (!ok) exitCode = 1
  rows.push({ step, title, expected, observed, verdict: ok ? 'PASS' : 'FAIL', shot: shotFile })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${observed}`)
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(SHOT_DIR, `${OUT_TAG}-${name}.png`)
  await page.screenshot({ path: file })
  return file
}

// ---------------------------------------------------------------- page helpers
async function openPage(browser, size, who, state) {
  const phone = size.viewport.width < 640
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) { offHost.add(u.host); return route.abort() }
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (req.method() !== 'GET') {
      writes.push(`${size.tag} ${req.method()} ${u.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    const out = answerGet(who, state, u)
    if (out === null) unanswered.add(u.pathname)
    return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out ? out.body : {}) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}/driver`, { waitUntil: 'domcontentloaded' })
  return { ctx, page }
}

const squeeze = (t) => (t || '').replace(/\s+/g, ' ').trim()
const text = (page, selector) => page.locator(selector).first().textContent({ timeout: 2000 }).then(squeeze, () => '')
const allText = (loc) => loc.allTextContents().then((list) => list.map(squeeze))
const testid = (id) => `[data-testid="${id}"]`
async function appears(page, selector, ms) {
  try { await page.waitForSelector(selector, { state: 'visible', timeout: ms }); return true } catch { return false }
}
async function until(check, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1)
async function press(loc, size) {
  if (size.viewport.width < 640) await loc.tap()
  else await loc.click()
}
const tabLabels = (page) => allText(page.locator('.van-tabbar-item__text'))
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// The bar, once the driver's data has loaded and the tab's check has been answered.
async function barSettled(page, state, wantTab) {
  await appears(page, '.van-tabbar', 15000)
  if (wantTab) return appears(page, '.van-tabbar-item:has-text("Performance")', 12000)
  await until(() => state.calls.own > 0, 12000)
  await page.waitForTimeout(500)
  return true
}

async function openTab(page, size) {
  await press(page.locator('.van-tabbar-item', { hasText: 'Performance' }).first(), size)
  return appears(page, testid('perf-tab'), 8000)
}

async function choose(page, size, label) {
  await press(page.locator('.perf-periods .van-tab', { hasText: label }).first(), size)
}

// Each row as "rank|unit|figure|You", read from the screen in one go, so a period changing
// mid-read can't stall on a row that has gone.
const boardRows = (page) => page.locator(`${testid('perf-tile')}[data-category="most-loads"] ${testid('perf-row')}`).evaluateAll((els) => els.map((el) => {
  const pick = (selector) => ((el.querySelector(selector) || {}).textContent || '').replace(/\s+/g, ' ').trim()
  return [pick('.perf-rank'), pick('.perf-unit'), pick('.perf-figure'), el.querySelector('[data-testid="perf-you"]') ? 'You' : ''].join('|')
}))
const expectedRows = (list) => list.map((r) => [r.rank === null ? '–' : String(r.rank), r.unitLabel, r.display, r.isYou ? 'You' : ''].join('|'))

async function waitForRows(page, want, ms = 8000) {
  const end = Date.now() + ms
  let got = []
  while (Date.now() < end) {
    got = await boardRows(page)
    if (sameList(got, want)) return got
    await page.waitForTimeout(100)
  }
  return got
}

// The three "Coming soon" tiles: each with the tag, one line and no row or figure.
async function comingSoonTiles(page) {
  const out = []
  for (const id of SOON_IDS) {
    const tile = page.locator(`${testid('perf-tile')}[data-category="${id}"]`)
    out.push({
      id,
      tag: await tile.locator(testid('perf-soon')).count() ? squeeze(await tile.locator(testid('perf-soon')).textContent()) : '',
      line: await tile.locator(testid('perf-line')).count() ? squeeze(await tile.locator(testid('perf-line')).textContent()) : '',
      rows: await tile.locator(testid('perf-row')).count(),
    })
  }
  return out
}
const soonOk = (list) => list.length === 3 && list.every((t) => t.tag === 'Coming soon' && t.line.length > 0 && !/\d|\$/.test(t.line) && t.rows === 0) && new Set(list.map((t) => t.line)).size === 3

async function heights(page, selector) {
  const out = []
  for (const el of await page.locator(selector).all()) {
    if (await el.isVisible()) out.push(Math.round((await el.boundingBox()).height))
  }
  return out
}
const tall = (list) => list.length > 0 && list.every((h) => h >= 44)

// ---------------------------------------------------------------- W, L, M, R: the whole tab
async function fullRun(browser, size) {
  const t = size.tag
  const state = freshState()
  const { ctx, page } = await openPage(browser, size, DRIVER, state)
  try {
    const hasTab = await barSettled(page, state, true)
    const labels = await tabLabels(page)
    const barHeights = await heights(page, '.van-tabbar-item')
    const clipped = await page.locator('.van-tabbar-item__text').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length).catch(() => -1)
    const barFits = await page.locator('.van-tabbar').evaluate((e) => e.scrollWidth <= e.clientWidth + 1).catch(() => false)
    record(`W-bar-${t}`, 'The sixth tab fits the bar', `labels ${JSON.stringify(ALL_TABS)}; each 44 px or more; no label clipped; the bar doesn't overflow`,
      `labels ${JSON.stringify(labels)}, heights ${JSON.stringify(barHeights)}, clipped ${clipped}, fits ${barFits}`,
      hasTab && sameList(labels, ALL_TABS) && tall(barHeights) && clipped === 0 && barFits, await shot(page, `W-bar-${t}`))
    if (!hasTab) return

    const writesBefore = writes.length
    const opened = await openTab(page, size)
    const got = opened ? await waitForRows(page, expectedRows(THIS_ROWS)) : []
    await appears(page, testid('perf-credits'), 8000)
    const youCount = await page.locator(`${testid('perf-panel')} ${testid('perf-you')}`).count()
    const closes = await text(page, testid('perf-closes'))
    const range = await text(page, testid('perf-range'))
    const titles = await allText(page.locator(`${testid('perf-tile')} .perf-title`))
    const tiles = await comingSoonTiles(page)
    const choiceHeights = await heights(page, '.perf-periods .van-tab')
    const choiceLabels = await allText(page.locator('.perf-periods .van-tab'))
    const fits = await noSideScroll(page)
    record(`W-board-${t}`, 'This week: the board',
      `rows ${JSON.stringify(expectedRows(THIS_ROWS))}; one "You"; range "${rangeText(THIS_START, THIS_END)}"; "${WEEK_CLOSES}"; tiles ${JSON.stringify(TILES)}; three "Coming soon" with one line each and no rows; choices 44 px or more; no side scroll`,
      `rows ${JSON.stringify(got)}, you ${youCount}, range "${range}", closes "${closes}", tiles ${JSON.stringify(titles)}, soon ${JSON.stringify(tiles)}, choices ${JSON.stringify(choiceLabels)} ${JSON.stringify(choiceHeights)}, fits ${fits}`,
      opened && sameList(got, expectedRows(THIS_ROWS)) && youCount === 1 && range === rangeText(THIS_START, THIS_END) && closes === WEEK_CLOSES
        && sameList(titles, TILES) && soonOk(tiles) && sameList(choiceLabels, ['This week', 'Last week', 'This month']) && tall(choiceHeights) && fits,
      await shot(page, `W-board-${t}`))

    await page.locator(testid('perf-hos')).scrollIntoViewIfNeeded().catch(() => {})
    const credits = await text(page, testid('perf-credits'))
    const breakdown = await text(page, testid('perf-breakdown'))
    const noHours = await text(page, testid('perf-no-hours'))
    const guide = await text(page, testid('perf-guide'))
    const hos = await text(page, testid('perf-hos'))
    const hosSeen = await page.locator(testid('perf-hos')).isVisible().catch(() => false)
    const weekRange = await text(page, testid('perf-week-range'))
    const panel = await text(page, testid('perf-panel'))
    const hidden = ['Casey Example', 'REI', 'Ahead of Pace', 'On Track', 'Needs Focus', 'out of reach', '42.5', '$'].filter((w) => panel.includes(w))
    record(`W-week-${t}`, 'This week: My week and the hours-of-service line',
      `"3.5 of 7.5 load credits"; "2 delivered (1 each), 3 picked up (0.5 each)"; the neutral and guide lines; the hours-of-service line exact and visible; no name, hours figure, score, pace or dollars in the panel`,
      `range "${weekRange}", credits "${credits}", breakdown "${breakdown}", no-hours "${noHours}", guide "${guide}", hos "${hos}" visible ${hosSeen}, banned words ${JSON.stringify(hidden)}`,
      weekRange === `This week, ${rangeText(THIS_START, THIS_END)}` && credits === '3.5 of 7.5 load credits' && breakdown === '2 delivered (1 each), 3 picked up (0.5 each)'
        && noHours === NO_HOURS_LINE && guide === GUIDE_LINE && hos === HOS_LINE && hosSeen && hidden.length === 0,
      await shot(page, `W-week-${t}`))

    await choose(page, size, 'Last week')
    const lastGot = await waitForRows(page, expectedRows(LAST_ROWS))
    await page.waitForTimeout(150)
    const lastCredits = await text(page, testid('perf-credits'))
    const lastClose = await page.locator(`${testid('perf-closes')}`).count()
    const lastHos = await text(page, testid('perf-hos'))
    record(`L-${t}`, 'Last week: its rows, with dates on his row only',
      `rows ${JSON.stringify(expectedRows(LAST_ROWS))}; "7.5 of 7.5 load credits"; no closing line; no new read; the hours-of-service line stays`,
      `rows ${JSON.stringify(lastGot)}, credits "${lastCredits}", closing lines ${lastClose}, week reads ${state.calls.week}, hos ${lastHos === HOS_LINE}`,
      sameList(lastGot, expectedRows(LAST_ROWS)) && lastCredits === '7.5 of 7.5 load credits' && lastClose === 0 && lastHos === HOS_LINE,
      await shot(page, `L-${t}`))

    await choose(page, size, 'This month')
    const monthGot = await waitForRows(page, expectedRows(MONTH_ROWS))
    await page.waitForTimeout(150)
    const monthCredits = await text(page, testid('perf-credits'))
    const monthRange = await text(page, testid('perf-range'))
    const monthWeek = await text(page, testid('perf-week-range'))
    const monthCloses = await text(page, testid('perf-week-closes'))
    const monthHos = await text(page, testid('perf-hos'))
    record(`M-${t}`, 'This month: its rows; My week stays on this week',
      `rows ${JSON.stringify(expectedRows(MONTH_ROWS))}; range "${rangeText(MONTH_START, MONTH_END)}"; "This week, ${rangeText(THIS_START, THIS_END)}"; "${WEEK_CLOSES}" on the card; "3.5 of 7.5 load credits"; one month read; the hours-of-service line stays`,
      `rows ${JSON.stringify(monthGot)}, range "${monthRange}", week "${monthWeek}", closes "${monthCloses}", credits "${monthCredits}", month reads ${state.calls.month}, hos ${monthHos === HOS_LINE}`,
      sameList(monthGot, expectedRows(MONTH_ROWS)) && monthRange === rangeText(MONTH_START, MONTH_END) && monthWeek === `This week, ${rangeText(THIS_START, THIS_END)}`
        && monthCloses === WEEK_CLOSES && monthCredits === '3.5 of 7.5 load credits' && state.calls.month === 1 && monthHos === HOS_LINE,
      await shot(page, `M-${t}`))

    await choose(page, size, 'This week')
    await waitForRows(page, expectedRows(THIS_ROWS))
    const sent = writes.slice(writesBefore)
    record(`R-${t}`, 'Read only', 'no write sent while the tab was in use; going back to a period reads nothing new',
      `writes ${JSON.stringify(sent)}, month reads ${state.calls.month}, side scroll free ${await noSideScroll(page)}`,
      sent.length === 0 && state.calls.month === 1)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- D: decoys on the answers
async function decoyRun(browser, size) {
  const t = size.tag
  const state = freshState({ decoys: true })
  const { ctx, page } = await openPage(browser, size, DRIVER, state)
  try {
    const hasTab = await barSettled(page, state, true)
    const opened = hasTab && await openTab(page, size)
    const want = expectedRows(THIS_ROWS)
    const got = opened ? await waitForRows(page, want) : []
    await appears(page, testid('perf-credits'), 8000)
    const tiles = await comingSoonTiles(page)
    const body = async () => squeeze(await page.locator('body').innerText())
    const firstBody = await body()
    await choose(page, size, 'This month')
    await waitForRows(page, expectedRows(MONTH_ROWS))
    const secondBody = await body()
    const found = DECOY_TEXT.filter((w) => firstBody.includes(w) || secondBody.includes(w))
    record(`D-${t}`, 'Answers that wrongly carry more show none of it',
      `rows as if the extras weren't there; three "Coming soon" with no rows; none of ${JSON.stringify(DECOY_TEXT)} anywhere on the page`,
      `rows ${JSON.stringify(got)}, soon ${JSON.stringify(tiles)}, found ${JSON.stringify(found)}`,
      opened && sameList(got, want) && soonOk(tiles) && found.length === 0,
      await shot(page, `D-${t}`))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- F: the board fails, then comes back
async function failedBoardRun(browser, size) {
  const t = size.tag
  const state = freshState({ board: REFUSALS.unavailable })
  const { ctx, page } = await openPage(browser, size, DRIVER, state)
  try {
    const hasTab = await barSettled(page, state, true)
    const opened = hasTab && await openTab(page, size)
    const shown = opened && await appears(page, testid('perf-board-failed'), 8000)
    const line = shown ? await text(page, `${testid('perf-board-failed')} .perf-note`) : ''
    const retryHeight = await heights(page, testid('perf-board-retry'))
    const hos = await text(page, testid('perf-hos'))
    const credits = await text(page, testid('perf-credits'))
    const failShot = await shot(page, `F-failed-${t}`)
    state.board = 200
    if (shown) await press(page.locator(testid('perf-board-retry')).first(), size)
    const got = shown ? await waitForRows(page, expectedRows(THIS_ROWS)) : []
    const stillThere = await page.locator(testid('perf-board-failed')).count()
    record(`F-${t}`, 'The board fails: the line, Try again, and the hours-of-service line; Try again brings it back',
      `"${FAILED_LINE}"; Try again 44 px or more; the hours-of-service line; My week still shows; after Try again the rows and no failure line`,
      `line "${line}", retry ${JSON.stringify(retryHeight)}, hos ${hos === HOS_LINE}, credits "${credits}", rows ${JSON.stringify(got)}, failure line left ${stillThere}`,
      shown && line === FAILED_LINE && tall(retryHeight) && hos === HOS_LINE && credits === '3.5 of 7.5 load credits' && sameList(got, expectedRows(THIS_ROWS)) && stillThere === 0,
      failShot)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- G: the kill switch off mid-session
async function goneRun(browser, size) {
  const t = size.tag
  const state = freshState()
  const { ctx, page } = await openPage(browser, size, DRIVER, state)
  try {
    const hasTab = await barSettled(page, state, true)
    const opened = hasTab && await openTab(page, size)
    if (opened) await waitForRows(page, expectedRows(THIS_ROWS))
    state.monthAnswer = REFUSALS.off
    state.own = REFUSALS.off
    state.board = REFUSALS.off
    if (opened) await choose(page, size, 'This month')
    await until(() => state.calls.month > 0, 5000)
    let labels = []
    const end = Date.now() + 5000
    while (Date.now() < end) {
      labels = await tabLabels(page)
      if (sameList(labels, BASE_TABS)) break
      await page.waitForTimeout(100)
    }
    const panel = await page.locator(testid('perf-panel')).count()
    const active = squeeze(await page.locator('.van-tabbar-item--active .van-tabbar-item__text').first().textContent({ timeout: 2000 }).catch(() => ''))
    record(`G-${t}`, 'The switch goes off mid-session: back to Loads, five tabs',
      `labels ${JSON.stringify(BASE_TABS)}; no panel; Loads active`, `labels ${JSON.stringify(labels)}, panel ${panel}, active "${active}"`,
      opened && sameList(labels, BASE_TABS) && panel === 0 && active === 'Loads', await shot(page, `G-${t}`))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- O, N: nothing new
async function nothingNewRun(browser, size, step, refusal, title) {
  const t = size.tag
  const state = freshState({ own: refusal, board: refusal })
  const { ctx, page } = await openPage(browser, size, DRIVER, state)
  try {
    await barSettled(page, state, false)
    const labels = await tabLabels(page)
    const body = squeeze(await page.locator('body').innerText())
    const words = ['Performance', 'Most loads', 'Not eligible', 'NOT_ELIGIBLE', 'FEATURE_OFF', HOS_LINE].filter((w) => body.includes(w))
    record(`${step}-${t}`, title, `labels ${JSON.stringify(BASE_TABS)}; the board never read; nothing on the page about it`,
      `labels ${JSON.stringify(labels)}, own reads ${state.calls.own}, board reads ${state.calls.week + state.calls.month}, words ${JSON.stringify(words)}`,
      sameList(labels, BASE_TABS) && state.calls.own > 0 && state.calls.week + state.calls.month === 0 && words.length === 0, await shot(page, `${step}-${t}`))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- U: the check fails, then a later one answers
async function checkFailsRun(browser, size) {
  const t = size.tag
  const state = freshState({ own: REFUSALS.unavailable })
  const { ctx, page } = await openPage(browser, size, DRIVER, state)
  try {
    await barSettled(page, state, false)
    const before = await tabLabels(page)
    const readsBefore = state.calls.own
    state.own = 200
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    const shown = await appears(page, '.van-tabbar-item:has-text("Performance")', 6000)
    const after = await tabLabels(page)
    record(`U-${t}`, 'The check fails: no tab; coming back to the app asks again', `first ${JSON.stringify(BASE_TABS)}; another read on coming back; then ${JSON.stringify(ALL_TABS)}`,
      `first ${JSON.stringify(before)}, reads ${readsBefore} then ${state.calls.own}, then ${JSON.stringify(after)}`,
      sameList(before, BASE_TABS) && state.calls.own > readsBefore && shown && sameList(after, ALL_TABS), await shot(page, `U-${t}`))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- A: a Super Admin on /driver
async function adminRun(browser, size) {
  const t = size.tag
  const state = freshState()
  const { ctx, page } = await openPage(browser, size, ADMIN, state)
  try {
    const hasTab = await barSettled(page, state, true)
    const opened = hasTab && await openTab(page, size)
    const want = expectedRows(THIS_ROWS.map((r) => ({ ...r, isYou: false })))
    const got = opened ? await waitForRows(page, want) : []
    const myWeek = await page.locator(testid('perf-week')).count()
    const you = await page.locator(testid('perf-you')).count()
    const hos = await text(page, testid('perf-hos'))
    record(`A-${t}`, 'A Super Admin on /driver: the board only', `rows with no "You"; no My week; his own-week route never read; the hours-of-service line`,
      `rows ${JSON.stringify(got)}, My week ${myWeek}, you ${you}, own reads ${state.calls.own}, hos ${hos === HOS_LINE}`,
      opened && sameList(got, want) && myWeek === 0 && you === 0 && state.calls.own === 0 && hos === HOS_LINE, await shot(page, `A-${t}`))
  } finally {
    await ctx.close()
  }
}

async function main() {
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ASKED_PORT, HOST, resolve) })
  PORT = server.address().port
  if (PORT === 3000 || PORT === 5173) { server.close(); die(`the system picked port ${PORT}: set E2E_PORT to a free one`) }
  BASE = `http://${HOST}:${PORT}`
  console.log(`driver-performance: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const size of [PHONE, DESKTOP]) {
      await fullRun(browser, size)
      await decoyRun(browser, size)
      await failedBoardRun(browser, size)
      await goneRun(browser, size)
    }
    await nothingNewRun(browser, PHONE, 'O', REFUSALS.off, 'The kill switch off: nothing new')
    await nothingNewRun(browser, PHONE, 'N', REFUSALS.notEligible, 'A driver not on the board: nothing new, and no word why')
    await checkFailsRun(browser, PHONE)
    await adminRun(browser, DESKTOP)
  } finally {
    await browser.close()
    server.close()
  }

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    `# Driver Performance tab check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Browser requests to another host, aborted (not part of the verdict): ${[...offHost].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, out, { mode: 0o600 })
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`driver-performance: ${passed}/${rows.length} PASS, ${rows.length - passed} FAIL; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  if (pageErrors.length) console.log(`driver-performance: page errors: ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`driver-performance: aborted: ${e.stack || e}`)
  process.exit(1)
})
