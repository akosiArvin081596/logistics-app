#!/usr/bin/env node
// LogisX — a driver's own week: the bar on the Loads list and the Performance tab, on made-up data only.
//
// As a made-up Driver ("Casey Example"), at 390x844 and 1280x800:
//   B   the bar on the Loads list, above the load list: "This week: 3.5 of 7.5 loads", On Track, the
//       server's percent as its fill; no hours-of-service line; 44 px or more; no sideways
//       scroll; the board never read
//   E   the same bar at the top of a load's own page, the same answer, with its status and POD
//       sections below it as they were; tapping it there opens the tab too
//   Z   nothing under his thumb moves, by position: a load card across the first read arriving
//       after the list has painted; the Accept button and a load's status buttons across a failed
//       read and the good one after it; the kill switch going off keeps the place until he moves
//   T   tapping it opens the Performance tab; the sixth tab fits the nav and is 44 px or more
//   W   this week: the count, the label, what's left, the closing line, how it counts, each row
//       with both credits, "tell dispatch", drive hours coming soon, the target, "7.5 is the target.
//       6 is required." and "No other driver can see this."; no hours-of-service line; no name, rank, unit, "You",
//       month, tile, hours figure or dollars
//   L   last week: its final figure and list, no label, nothing left; no new read
//   R   read only: the page sent no write while the tab was in use, and never read the board
//   D   decoys: answers that wrongly carry names, another driver's figures, a rank, a unit, pay, a
//       broker, a rate, hours and a tier show none of them
//   F   his week fails (503) on the tab: the line and Try again show;
//       Try again brings it back
//   H   a read that fails after a good one hides the bar, so no old number stays; the tab stays; the
//       next good read brings the bar back
//   G   the kill switch goes off mid-session: the next read goes back to Loads with five tabs, no bar
// And at 390x844:
//   P   a low week and the others: Needs Focus on a pale neutral chip, never red, with "A new week
//       starts Saturday, <the coming Saturday's date>." and no closing line; Ahead of Pace; the target reached; no label at all;
//       a percentage driver's tab says nothing about pay, as nobody's does; an approved day off
//       reads his lower figure, the one line saying why and that week's required figure; time off
//       that makes the required figure impossible reads the target alone
//   O   the kill switch off (404 FEATURE_OFF): five tabs as before, no bar; the held place goes on
//       his first move between screens
//   N   a driver with no week (404 NOT_ELIGIBLE): the same, and no word about why
//   U   the check fails (503): no tab, no bar; a phone coming back to the app asks again, and both show
// And a made-up Super Admin on /driver at 1280x800:
//   A   the tab and the office board as they were, its hours-of-service line included, no bar, no My
//       week, no "You", his own-week route never read
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
const HOS_LINE = 'Never drive past your hours of service to reach a target. Your 11-hour driving limit, 14-hour window and 60/70-hour limit come first. Your ELD log is what counts for your hours. If you stop to stay legal, tell dispatch.'
const TARGET_LINE = 'Target: 7.5 loads a week (1.5 a day over 5 days)'
const REQUIREMENT_LINE = '7.5 is the target. 6 is required.'
const PRIVATE_LINE = 'No other driver can see this.'
const DRIVE_HOURS_LINE = 'Drive hours: coming soon'
const LOWER_TARGET_LINE = 'Your target is lower this week for your approved time off.'
const TELL_DISPATCH_LINE = 'If something looks wrong, tell dispatch.'
const RULE_LINE = 'Each pickup counts 0.5 and each delivery 0.5.'
const WEEK_CLOSES = 'Week closes Fri 11:59 PM ET'
const FAILED_LINE = "Performance can't be shown right now. Try again in a minute."
const BASE_TABS = ['Loads', 'Alerts', 'Kit', 'Messages', 'Invoices']
const ALL_TABS = [...BASE_TABS, 'Performance']
const TILES = ['Most loads', 'Least fuel cost', 'Safety', 'Lowest idle']
// None of these may ever be on a driver's screen.
const NOT_FOR_DRIVERS = ['Most loads', 'Least fuel cost', 'Lowest idle', 'Not ranked', 'This month', 'REI', 'Coming soon', 'Tier', 'Streak', 'streak', '#70', 'out of reach', '42.5', '8.5', '$', 'Counts loads', 'invoice pays days', 'Hours of service', 'hours of service', 'Never drive past', 'a guide', 'Target is a requirement']

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
const NEXT_WEEK_STARTS = md(shift(THIS_END, 1))
const NEW_WEEK_LINE = `A new week starts Saturday, ${NEXT_WEEK_STARTS}.`
const LAST_START = shift(THIS_START, -7)
const LAST_END = shift(THIS_START, -1)
const MONTH_START = `${TODAY.slice(0, 7)}-01`
const MONTH_END = new Date(Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)), 0)).toISOString().slice(0, 10)

// His own week, in the shape the route sends.
const counted = (day, credits) => ({ day, credits })
const THIS_LOADS = [
  { loadId: 'QA-9001', pickup: counted('Sat', 0.5), delivery: counted('Mon', 0.5) },
  { loadId: 'QA-9002', pickup: counted('Mon', 0.5), delivery: counted('Tue', 0.5) },
  { loadId: 'QA-9003', pickup: { note: 'last-week' }, delivery: counted('Sun', 0.5) },
  { loadId: 'QA-9004', pickup: { note: 'not-counted' }, delivery: counted('Tue', 0.5) },
  { loadId: 'QA-9005', pickup: counted('Tue', 0.5), delivery: null },
]
const THIS_LINES = [
  ['Load QA-9001', 'Picked up Sat 0.5 · Delivered Mon 0.5'],
  ['Load QA-9002', 'Picked up Mon 0.5 · Delivered Tue 0.5'],
  ['Load QA-9003', 'Delivered Sun 0.5 · Pickup counted last week'],
  ['Load QA-9004', 'Delivered Tue 0.5 · Pickup not counted this week'],
  ['Load QA-9005', 'Picked up Tue 0.5'],
]
const LAST_LOADS = [{ loadId: 'QA-8001', pickup: counted('Sat', 0.5), delivery: counted('Sun', 0.5) }]
const LAST_LINES = [['Load QA-8001', 'Picked up Sat 0.5 · Delivered Sun 0.5']]
const THIS_WEEK = { id: 'this-week', start: THIS_START, end: THIS_END, credits: { value: 3.5, target: 7.5, required: 6, deliveries: 4, pickups: 3 }, left: 4, percent: 46, pace: 'on-track', newWeekNote: false, nextWeekStarts: NEXT_WEEK_STARTS, targetLowered: false, loads: THIS_LOADS }
const LAST_WEEK = { id: 'last-week', start: LAST_START, end: LAST_END, credits: { value: 7.5, target: 7.5, required: 6, deliveries: 8, pickups: 7 }, left: null, percent: 100, pace: null, newWeekNote: false, nextWeekStarts: null, targetLowered: false, loads: LAST_LOADS }

// What the server must never send. If it did, none of it may show.
const DECOY_NAME = 'Decoy Peerdriver'
const DECOY_FIELDS = { driverName: DECOY_NAME, name: DECOY_NAME, driverId: 7711, reason: 'Accident on file', payDaily: 987, tier: 'Tier 1 ($325/day)', rei: 83.7, hours: 31.25, rank: 3, unitLabel: '#7099', broker: 'Decoy Freight LLC', rate: 4321.09, peers: [{ unitLabel: '#7098', value: 19 }] }
const DECOY_TEXT = [DECOY_NAME, 'Accident on file', '987', '$', '83.7', '31.25', 'Tier 1', '#7099', '#7098', 'Decoy Freight', '4321', 'out of reach']

function ownBody(state) {
  const decoy = state.decoys ? DECOY_FIELDS : {}
  const dress = (week) => ({ ...week, credits: { ...week.credits, ...decoy }, loads: week.loads.map((l) => ({ ...l, ...decoy })), ...decoy })
  return {
    view: 'no-hours-data',
    creditWeights: { delivery: 0.5, pickup: 0.5 },
    weeks: [dress({ ...THIS_WEEK, ...state.thisWeek }), dress(LAST_WEEK)],
    ...decoy,
  }
}

// The office board, as the Super Admin reads it.
const ranked = (rank, unitLabel, loads) => ({ rank, unitLabel, value: loads, display: `${loads} load${loads === 1 ? '' : 's'}`, isYou: false })
const notRanked = (unitLabel) => ({ rank: null, unitLabel, value: null, display: 'Not ranked', isYou: false })
const THIS_ROWS = [ranked(1, '#701', 6), ranked(2, '#702', 5), ranked(2, '#704', 5), ranked(4, '#705', 3), ranked(5, 'INV-00-Z', 1), ranked(6, '#703 (1)', 0), ranked(6, '#703 (2)', 0), notRanked('#706'), notRanked('#707')]
const LAST_ROWS = [ranked(1, '#702', 7), ranked(2, '#705', 5), ranked(3, '#701', 4)]
const MONTH_ROWS = [ranked(1, '#701', 19), ranked(2, '#705', 17), ranked(3, '#702', 12)]
const SOON_IDS = ['least-fuel-cost', 'safety', 'lowest-idle']
const live = (rows) => ({ id: 'most-loads', status: 'live', listed: rows.length, rows })
const soon = (id) => ({ id, status: 'coming-soon', listed: null, rows: [] })
const categories = (rows) => [live(rows), ...SOON_IDS.map(soon)]

function boardBody(kind) {
  if (kind === 'month') return { period: 'month', view: 'full', boards: [{ id: 'this-month', start: MONTH_START, end: MONTH_END, categories: categories(MONTH_ROWS) }] }
  return {
    period: 'week',
    view: 'full',
    boards: [
      { id: 'this-week', start: THIS_START, end: THIS_END, categories: categories(THIS_ROWS) },
      { id: 'last-week', start: LAST_START, end: LAST_END, categories: categories(LAST_ROWS) },
    ],
  }
}

// `own` says how his route answers: 200, or a status with its code. `thisWeek` overrides his
// figures; `withLoad` puts one made-up load in his list, and `withOffer` one to accept;
// `ownDelayMs` holds his route's answer back, so the list paints first.
function freshState({ own = 200, decoys = false, thisWeek = {}, withLoad = false, withOffer = false, ownDelayMs = 0 } = {}) {
  return { own, decoys, thisWeek, withLoad, withOffer, ownDelayMs, calls: { own: 0, week: 0, month: 0 } }
}

const REFUSALS = {
  off: { status: 404, body: { error: 'Not found', code: 'FEATURE_OFF' } },
  notEligible: { status: 404, body: { error: 'Not found', code: 'NOT_ELIGIBLE' } },
  unavailable: { status: 503, body: { error: "Performance can't be worked out right now. Try again in a minute.", code: 'PERFORMANCE_UNAVAILABLE' } },
  forbidden: { status: 403, body: { error: 'Forbidden' } },
}

const LOAD_ID = 'QA-9100'
const LOAD_HEADERS = ['Load ID', 'Driver', 'Job Status', 'Pickup Appointment', 'Drop-off Appointment']
const madeUpLoad = (who) => ({ _rowIndex: 2, 'Load ID': LOAD_ID, Driver: who.driverName, 'Job Status': 'In Transit', 'Pickup Appointment': THIS_START, 'Drop-off Appointment': THIS_END })
const madeUpOffer = (who) => ({ _rowIndex: 3, 'Load ID': 'QA-9101', Driver: who.driverName, 'Job Status': 'Dispatched', 'Pickup Appointment': THIS_START, 'Drop-off Appointment': THIS_END })

function driverPayload(who, state) {
  return {
    loads: [...(state.withLoad ? [madeUpLoad(who)] : []), ...(state.withOffer ? [madeUpOffer(who)] : [])],
    headers: { jobTracking: state.withLoad || state.withOffer ? LOAD_HEADERS : [], carrierDB: [] },
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
    return who.role === 'Driver' ? REFUSALS.off : { status: 200, body: boardBody(kind) }
  }
  if (pathname === '/api/driver/position') return { status: 200, body: { ok: false } }
  if (pathname === '/api/fuel/range') return { status: 200, body: { ok: false } }
  if (/^\/api\/driver\/[^/]+$/.test(pathname)) return { status: 200, body: driverPayload(who, state) }
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
    if (u.pathname === '/api/driver/me/performance' && state.ownDelayMs) await new Promise((r) => setTimeout(r, state.ownDelayMs))
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
async function gone(page, selector, ms) {
  try { await page.waitForSelector(selector, { state: 'detached', timeout: ms }); return true } catch { return false }
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
const comeBackToApp = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
const barCount = (page) => page.locator(testid('perf-bar')).count()
const slotCount = (page) => page.locator(testid('perf-bar-slot')).count()
// Where an element sits on the page, whatever the scroll, in whole pixels.
const pageTop = (page, selector) => page.locator(selector).first().evaluate((el) => Math.round(el.getBoundingClientRect().top + window.scrollY)).catch(() => null)
const allSame = (list) => list.every((n) => n !== null && n === list[0])

// The nav, once the driver's data has loaded and the tab's check has been answered.
async function barSettled(page, state, wantTab) {
  await appears(page, '.van-tabbar', 15000)
  if (wantTab) return appears(page, '.van-tabbar-item:has-text("Performance")', 12000)
  await until(() => state.calls.own > 0, 12000)
  await page.waitForTimeout(500)
  return true
}

async function openTab(page, size, marker = 'perf-tab') {
  await press(page.locator('.van-tabbar-item', { hasText: 'Performance' }).first(), size)
  return appears(page, testid(marker), 8000)
}

async function choose(page, size, label) {
  await press(page.locator('.perf-periods .van-tab', { hasText: label }).first(), size)
}

// Each counted row as [title, line], read from the screen in one go.
const loadRows = (page) => page.locator(testid('perf-load')).evaluateAll((els) => els.map((el) => {
  const pick = (id) => ((el.querySelector(`[data-testid="${id}"]`) || {}).textContent || '').replace(/\s+/g, ' ').trim()
  return [pick('perf-load-id'), pick('perf-load-line')]
}))

async function waitForLoads(page, want, ms = 8000) {
  const end = Date.now() + ms
  let got = []
  while (Date.now() < end) {
    got = await loadRows(page)
    if (sameList(got, want)) return got
    await page.waitForTimeout(100)
  }
  return got
}

async function heights(page, selector) {
  const out = []
  for (const el of await page.locator(selector).all()) {
    if (await el.isVisible()) out.push(Math.round((await el.boundingBox()).height))
  }
  return out
}
const tall = (list) => list.length > 0 && list.every((h) => h >= 44)
const banned = (body) => NOT_FOR_DRIVERS.filter((w) => body.includes(w))

// Red means a strong red channel over weak green and blue, so a pale neutral chip never counts.
const looksRed = (css) => {
  const m = /rgba?\((\d+), ?(\d+), ?(\d+)/.exec(css || '')
  return !!m && Number(m[1]) > 170 && Number(m[2]) < 110 && Number(m[3]) < 110
}
const colours = (page, selector) => page.locator(selector).first().evaluate((el) => {
  const s = getComputedStyle(el)
  return [s.backgroundColor, s.color]
}).catch(() => [])

// ---------------------------------------------------------------- B, T, W, L, R: the bar and the tab
async function fullRun(browser, size) {
  const t = size.tag
  const state = freshState()
  const { ctx, page } = await openPage(browser, size, DRIVER, state)
  try {
    const hasTab = await barSettled(page, state, true)
    const shown = await appears(page, testid('perf-bar'), 8000)
    const barText = await text(page, testid('perf-bar-text'))
    const barPace = await text(page, testid('perf-bar-pace'))
    const fill =await page.locator(testid('perf-bar-fill')).first().evaluate((el) => el.style.width).catch(() => '')
    const barHeight = await heights(page, testid('perf-bar'))
    const above = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="perf-bar"]')
      const list = document.querySelector('.load-sub-tabs')
      return !!bar && !!list && bar.getBoundingClientRect().bottom <= list.getBoundingClientRect().top
    })
    const barFits = await noSideScroll(page)
    const loadsBody = squeeze(await page.locator('body').innerText())
    record(`B-${t}`, 'The bar on the Loads list',
      `"This week: 3.5 of 7.5 loads"; "On Track"; fill 46%; 44 px or more; above the load list; no side scroll; the board never read; nothing of the ranking on the page`,
      `text "${barText}", pace "${barPace}", fill ${fill}, height ${JSON.stringify(barHeight)}, above ${above}, fits ${barFits}, board reads ${state.calls.week + state.calls.month}, banned ${JSON.stringify(banned(loadsBody))}`,
      shown && barText === 'This week: 3.5 of 7.5 loads' && barPace === 'On Track' && fill === '46%' && tall(barHeight) && above && barFits
        && state.calls.week + state.calls.month === 0 && banned(loadsBody).length === 0,
      await shot(page, `B-${t}`))
    if (!shown) return

    const labels = await tabLabels(page)
    const navHeights = await heights(page, '.van-tabbar-item')
    const clipped = await page.locator('.van-tabbar-item__text').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length).catch(() => -1)
    const navFits = await page.locator('.van-tabbar').evaluate((e) => e.scrollWidth <= e.clientWidth + 1).catch(() => false)
    const writesBefore = writes.length
    await press(page.locator(testid('perf-bar')).first(), size)
    const opened = await appears(page, testid('perf-tab'), 8000)
    const active = squeeze(await page.locator('.van-tabbar-item--active .van-tabbar-item__text').first().textContent({ timeout: 2000 }).catch(() => ''))
    record(`T-${t}`, 'Tapping the bar opens the Performance tab; the sixth tab fits the nav',
      `the tab open and active; labels ${JSON.stringify(ALL_TABS)}; each 44 px or more; no label clipped; the nav doesn't overflow`,
      `opened ${opened}, active "${active}", labels ${JSON.stringify(labels)}, heights ${JSON.stringify(navHeights)}, clipped ${clipped}, fits ${navFits}`,
      hasTab && opened && active === 'Performance' && sameList(labels, ALL_TABS) && tall(navHeights) && clipped === 0 && navFits,
      await shot(page, `T-${t}`))
    if (!opened) return

    const got = await waitForLoads(page, THIS_LINES)
    const count = await text(page, testid('perf-count'))
    const pace = await text(page, testid('perf-pace'))
    const left = await text(page, testid('perf-left'))
    const closes = await text(page, testid('perf-closes'))
    const range = await text(page, testid('perf-range'))
    const rule = await text(page, testid('perf-rule'))
    const tell = await text(page, testid('perf-tell-dispatch'))
    const hours = await text(page, testid('perf-drive-hours'))
    const target = await text(page, testid('perf-target'))
    const requirement = await text(page, testid('perf-requirement'))
    const isPrivate = await text(page, testid('perf-private'))
    const lowered = await page.locator(testid('perf-lowered')).count()
    const choiceHeights = await heights(page, '.perf-periods .van-tab')
    const choiceLabels = await allText(page.locator('.perf-periods .van-tab'))
    const weekWide = await page.locator(testid('perf-fill')).first().evaluate((el) => el.style.width).catch(() => '')
    const hosLines = await page.locator(testid('perf-hos')).count()
    const panel = squeeze(await text(page, testid('perf-panel')))
    const fits = await noSideScroll(page)
    const hidden = banned(panel).concat(['Casey Example', 'You'].filter((w) => new RegExp(`\\b${w}\\b`).test(panel)))
    record(`W-${t}`, 'This week: only his own figures',
      `"3.5 of 7.5 loads"; On Track; fill 46%; "4 loads left this week."; "${WEEK_CLOSES}"; range "${rangeText(THIS_START, THIS_END)}"; "${RULE_LINE}"; rows ${JSON.stringify(THIS_LINES)}; "${TELL_DISPATCH_LINE}"; "${DRIVE_HOURS_LINE}"; "${TARGET_LINE}"; no lowered-target line; "${REQUIREMENT_LINE}"; "${PRIVATE_LINE}"; no hours-of-service line; This week and Last week, 44 px or more; no side scroll; nothing banned`,
      `count "${count}", pace "${pace}", fill ${weekWide}, left "${left}", closes "${closes}", range "${range}", rule "${rule}", rows ${JSON.stringify(got)}, tell "${tell}", hours "${hours}", target "${target}", lowered ${lowered}, requirement "${requirement}", private "${isPrivate}", hours-of-service lines ${hosLines}, choices ${JSON.stringify(choiceLabels)} ${JSON.stringify(choiceHeights)}, fits ${fits}, banned ${JSON.stringify(hidden)}`,
      count === '3.5 of 7.5 loads' && pace === 'On Track' && weekWide === '46%' && left === '4 loads left this week.' && closes === WEEK_CLOSES && range === rangeText(THIS_START, THIS_END)
        && rule === RULE_LINE && sameList(got, THIS_LINES) && tell === TELL_DISPATCH_LINE && hours === DRIVE_HOURS_LINE && target === TARGET_LINE && lowered === 0 && requirement === REQUIREMENT_LINE && isPrivate === PRIVATE_LINE
        && hosLines === 0 && sameList(choiceLabels, ['This week', 'Last week']) && tall(choiceHeights) && fits && hidden.length === 0,
      await shot(page, `W-${t}`))

    const ownReads = state.calls.own
    await choose(page, size, 'Last week')
    const lastGot = await waitForLoads(page, LAST_LINES)
    const lastCount = await text(page, testid('perf-count'))
    const lastRange = await text(page, testid('perf-range'))
    const lastTitle = await text(page, testid('perf-counted-title'))
    const lastPace = await page.locator(testid('perf-pace')).count()
    const lastLeft = await page.locator(testid('perf-left')).count()
    const lastCloses = await page.locator(testid('perf-closes')).count()
    record(`L-${t}`, 'Last week: its final figure and list, no label',
      `"7.5 of 7.5 loads"; range "${rangeText(LAST_START, LAST_END)}"; "What counted last week"; rows ${JSON.stringify(LAST_LINES)}; no label, no left line, no closing line; no new read`,
      `count "${lastCount}", range "${lastRange}", title "${lastTitle}", rows ${JSON.stringify(lastGot)}, label ${lastPace}, left ${lastLeft}, closes ${lastCloses}, reads ${ownReads} then ${state.calls.own}`,
      lastCount === '7.5 of 7.5 loads' && lastRange === rangeText(LAST_START, LAST_END) && lastTitle === 'What counted last week' && sameList(lastGot, LAST_LINES)
        && lastPace === 0 && lastLeft === 0 && lastCloses === 0 && state.calls.own === ownReads,
      await shot(page, `L-${t}`))

    await choose(page, size, 'This week')
    await waitForLoads(page, THIS_LINES)
    const sent = writes.slice(writesBefore)
    record(`R-${t}`, 'Read only, and never the board', 'no write sent while the tab was in use; the board route never read',
      `writes ${JSON.stringify(sent)}, board reads ${state.calls.week + state.calls.month}, side scroll free ${await noSideScroll(page)}`,
      sent.length === 0 && state.calls.week + state.calls.month === 0)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- E: the bar on a load's own page
async function loadPageRun(browser, size) {
  const t = size.tag
  const state = freshState({ withLoad: true })
  const { ctx, page } = await openPage(browser, size, DRIVER, state)
  try {
    await barSettled(page, state, true)
    const onList = await appears(page, testid('perf-bar'), 8000)
    const listBar = await text(page, testid('perf-bar-text'))
    const card = await appears(page, '.load-card', 8000)
    if (card) await press(page.locator('.load-card').first(), size)
    const onLoad = await appears(page, '.load-detail', 8000)
    const barAfter = await appears(page, testid('perf-bar'), 8000)
    const loadBar = await text(page, testid('perf-bar-text'))
    const loadPace = await text(page, testid('perf-bar-pace'))
    const bars = await barCount(page)
    const order = await page.evaluate(() => {
      const top = (selector) => { const el = document.querySelector(selector); return el ? el.getBoundingClientRect().top : null }
      const bar = document.querySelector('[data-testid="perf-bar"]')
      return { barBottom: bar ? bar.getBoundingClientRect().bottom : null, detail: top('.load-detail'), status: top('.status-stepper-wrapper') }
    })
    const sections = await allText(page.locator('.load-detail .van-collapse-item__title'))
    const fits = await noSideScroll(page)
    const loadShot = await shot(page, `E-${t}`)
    const above = order.barBottom !== null && order.detail !== null && order.status !== null && order.barBottom <= order.detail && order.detail <= order.status
    const named = (word) => sections.some((title) => title.includes(word))
    let opens = false
    if (barAfter) {
      await press(page.locator(testid('perf-bar')).first(), size)
      opens = await appears(page, testid('perf-tab'), 8000)
    }
    record(`E-${t}`, 'The same bar at the top of a load\'s own page',
      `the bar on the list, then one bar on the load's page with the same figure and label; above the page, above its status buttons; "Update Status" and "Documents" still on the page; no side scroll; tapping it opens the tab`,
      `list "${listBar}", load page ${onLoad}, bar "${loadBar}" "${loadPace}", bars ${bars}, order ${JSON.stringify(order)}, sections ${JSON.stringify(sections)}, fits ${fits}, opens ${opens}`,
      onList && onLoad && barAfter && loadBar === listBar && loadBar === 'This week: 3.5 of 7.5 loads' && loadPace === 'On Track' && bars === 1
        && above && named('Update Status') && named('Documents') && fits && opens,
      loadShot)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- Z: nothing under his thumb moves
async function stillRun(browser, size) {
  const t = size.tag
  const state = freshState({ withLoad: true, withOffer: true, ownDelayMs: 1500 })
  const { ctx, page } = await openPage(browser, size, DRIVER, state)
  const settle = () => page.waitForTimeout(500)
  const until503 = async () => { state.own = REFUSALS.unavailable; await comeBackToApp(page); return gone(page, testid('perf-bar'), 8000) }
  const until200 = async () => { state.own = 200; await comeBackToApp(page); return appears(page, testid('perf-bar'), 8000) }
  try {
    // The list paints first, and his first read answers after it.
    await appears(page, '.load-card', 15000)
    const barsAtPaint = await barCount(page)
    const slotsAtPaint = await slotCount(page)
    const cardAtPaint = await pageTop(page, '.load-card')
    const barCame = await appears(page, testid('perf-bar'), 8000)
    const cardWithBar = await pageTop(page, '.load-card')
    state.ownDelayMs = 0

    await press(page.locator('.sub-tab', { hasText: 'Pending' }).first(), size)
    await appears(page, '.action-btn.accept', 8000)
    const acceptWith = await pageTop(page, '.action-btn.accept')
    const acceptHidden = await until503()
    await settle()
    await appears(page, '.action-btn.accept', 8000)
    const acceptFailed = await pageTop(page, '.action-btn.accept')
    const acceptBackBar = await until200()
    await settle()
    await appears(page, '.action-btn.accept', 8000)
    const acceptBack = await pageTop(page, '.action-btn.accept')
    const firstShot = await shot(page, `Z-accept-${t}`)
    record(`Z-list-${t}`, 'The list stays still: the first read, a failed read, and the good one after',
      `no bar yet at the list's first paint, its place already held; the load card at the same place once the bar is in it; the Accept button at the same place with the bar, without it and with it again`,
      `bars at paint ${barsAtPaint}, slots ${slotsAtPaint}, card ${cardAtPaint} then ${cardWithBar}, bar came ${barCame}, accept ${acceptWith} then ${acceptFailed} then ${acceptBack}, hidden ${acceptHidden}, back ${acceptBackBar}`,
      barsAtPaint === 0 && slotsAtPaint === 1 && barCame && allSame([cardAtPaint, cardWithBar]) && acceptHidden && acceptBackBar && allSame([acceptWith, acceptFailed, acceptBack]),
      firstShot)

    await press(page.locator('.sub-tab', { hasText: 'Active' }).first(), size)
    await appears(page, '.load-card', 8000)
    await press(page.locator('.load-card').first(), size)
    await appears(page, '.status-stepper-wrapper', 8000)
    await settle()
    const statusWith = await pageTop(page, '.status-stepper-wrapper')
    const backWith = await pageTop(page, '.detail-topbar')
    const statusHidden = await until503()
    await settle()
    const statusFailed = await pageTop(page, '.status-stepper-wrapper')
    const backFailed = await pageTop(page, '.detail-topbar')
    const statusBackBar = await until200()
    await settle()
    const statusBack = await pageTop(page, '.status-stepper-wrapper')
    const pageShot = await shot(page, `Z-load-page-${t}`)
    state.own = REFUSALS.off
    await comeBackToApp(page)
    const offHidden = await gone(page, testid('perf-bar'), 8000)
    await settle()
    const statusOff = await pageTop(page, '.status-stepper-wrapper')
    const slotsOff = await slotCount(page)
    await press(page.locator('.detail-topbar button').first(), size)
    await appears(page, '.load-sub-tabs', 8000)
    await settle()
    const slotsMoved = await slotCount(page)
    record(`Z-load-${t}`, 'A load\'s page stays still: a failed read, the good one after, and the switch going off',
      `the status buttons and the Back row at the same place with the bar, without it and with it again; the switch going off moves nothing, and keeps the place until he moves; after he moves the place is gone`,
      `status ${statusWith} then ${statusFailed} then ${statusBack} then ${statusOff}, back row ${backWith} then ${backFailed}, hidden ${statusHidden}, back ${statusBackBar}, off ${offHidden}, slots while off ${slotsOff} then ${slotsMoved}`,
      statusHidden && statusBackBar && offHidden && allSame([statusWith, statusFailed, statusBack, statusOff]) && allSame([backWith, backFailed]) && slotsOff === 1 && slotsMoved === 0,
      pageShot)
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
    await appears(page, testid('perf-bar'), 8000)
    const barBody = squeeze(await page.locator('body').innerText())
    const barText = await text(page, testid('perf-bar-text'))
    const opened = hasTab && await openTab(page, size)
    const got = opened ? await waitForLoads(page, THIS_LINES) : []
    const firstBody = squeeze(await page.locator('body').innerText())
    await choose(page, size, 'Last week')
    await waitForLoads(page, LAST_LINES)
    const secondBody = squeeze(await page.locator('body').innerText())
    const found = DECOY_TEXT.filter((w) => barBody.includes(w) || firstBody.includes(w) || secondBody.includes(w))
    record(`D-${t}`, 'Answers that wrongly carry more show none of it',
      `the bar and rows as if the extras weren't there; none of ${JSON.stringify(DECOY_TEXT)} anywhere on the page`,
      `bar "${barText}", rows ${JSON.stringify(got)}, found ${JSON.stringify(found)}`,
      opened && barText === 'This week: 3.5 of 7.5 loads' && sameList(got, THIS_LINES) && found.length === 0,
      await shot(page, `D-${t}`))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- F: his week fails on the tab, then comes back
async function failedWeekRun(browser, size) {
  const t = size.tag
  const state = freshState()
  const { ctx, page } = await openPage(browser, size, DRIVER, state)
  try {
    const hasTab = await barSettled(page, state, true)
    state.own = REFUSALS.unavailable
    const opened = hasTab && await openTab(page, size)
    const shown = opened && await appears(page, testid('perf-failed'), 8000)
    const line = shown ? await text(page, `${testid('perf-failed')} .perf-note`) : ''
    const retryHeight = await heights(page, testid('perf-retry'))
    const figure = await page.locator(testid('perf-count')).count()
    const failShot = await shot(page, `F-failed-${t}`)
    state.own = 200
    if (shown) await press(page.locator(testid('perf-retry')).first(), size)
    const got = shown ? await waitForLoads(page, THIS_LINES) : []
    const stillThere = await page.locator(testid('perf-failed')).count()
    record(`F-${t}`, 'His week fails: the line and Try again; Try again brings it back',
      `"${FAILED_LINE}"; Try again 44 px or more; no figure; after Try again the rows and no failure line`,
      `line "${line}", retry ${JSON.stringify(retryHeight)}, figures ${figure}, rows ${JSON.stringify(got)}, failure line left ${stillThere}`,
      shown && line === FAILED_LINE && tall(retryHeight) && figure === 0 && sameList(got, THIS_LINES) && stillThere === 0,
      failShot)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- H: a failed read hides the bar
async function failedBarRun(browser, size) {
  const t = size.tag
  const state = freshState()
  const { ctx, page } = await openPage(browser, size, DRIVER, state)
  try {
    await barSettled(page, state, true)
    const first = await appears(page, testid('perf-bar'), 8000)
    state.own = REFUSALS.unavailable
    await comeBackToApp(page)
    const hidden = await gone(page, testid('perf-bar'), 8000)
    const body = squeeze(await page.locator('body').innerText())
    const labels = await tabLabels(page)
    const hiddenShot = await shot(page, `H-hidden-${t}`)
    state.own = 200
    await comeBackToApp(page)
    const back = await appears(page, testid('perf-bar'), 8000)
    record(`H-${t}`, 'A read that fails hides the bar, and no old number stays',
      `the bar first; after a 503 no bar and no "3.5 of" on the page; the tab stays; the next good read brings the bar back`,
      `first ${first}, hidden ${hidden}, number on the page ${body.includes('3.5 of')}, labels ${JSON.stringify(labels)}, back ${back}`,
      first && hidden && !body.includes('3.5 of') && sameList(labels, ALL_TABS) && back, hiddenShot)
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
    if (opened) await waitForLoads(page, THIS_LINES)
    state.own = REFUSALS.off
    await comeBackToApp(page)
    let labels = []
    const end = Date.now() + 8000
    while (Date.now() < end) {
      labels = await tabLabels(page)
      if (sameList(labels, BASE_TABS)) break
      await page.waitForTimeout(100)
    }
    const panel = await page.locator(testid('perf-panel')).count()
    const active = squeeze(await page.locator('.van-tabbar-item--active .van-tabbar-item__text').first().textContent({ timeout: 2000 }).catch(() => ''))
    const bars = await barCount(page)
    record(`G-${t}`, 'The switch goes off mid-session: back to Loads, five tabs, no bar',
      `labels ${JSON.stringify(BASE_TABS)}; no panel; Loads active; no bar`, `labels ${JSON.stringify(labels)}, panel ${panel}, active "${active}", bars ${bars}`,
      opened && sameList(labels, BASE_TABS) && panel === 0 && active === 'Loads' && bars === 0, await shot(page, `G-${t}`))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- P: the other weeks
async function weekShapesRun(browser, size) {
  const t = size.tag
  const low = freshState({ thisWeek: { credits: { value: 1.5, target: 7.5, required: 6, deliveries: 2, pickups: 1 }, left: 6, percent: 20, pace: 'needs-focus', newWeekNote: true } })
  {
    const { ctx, page } = await openPage(browser, size, DRIVER, low)
    try {
      await barSettled(page, low, true)
      await appears(page, testid('perf-bar'), 8000)
      const barText = await text(page, testid('perf-bar-text'))
      const barPace = await text(page, testid('perf-bar-pace'))
      const [barBg, barInk] = await colours(page, testid('perf-bar-pace'))
      const [fillBg] = await colours(page, testid('perf-bar-fill'))
      await press(page.locator(testid('perf-bar')).first(), size)
      await appears(page, testid('perf-tab'), 8000)
      await appears(page, testid('perf-new-week'), 8000)
      const left = await text(page, testid('perf-left'))
      const note = await text(page, testid('perf-new-week'))
      const required = await text(page, testid('perf-requirement'))
      const closes = await page.locator(testid('perf-closes')).count()
      const [chipBg, chipInk] = await colours(page, testid('perf-pace'))
      const red = [barBg, barInk, fillBg, chipBg, chipInk].filter(looksRed)
      record(`P-low-${t}`, 'A low week: no red, and no asking for more',
        `"This week: 1.5 of 7.5 loads"; Needs Focus; "6 loads left this week."; "${NEW_WEEK_LINE}"; "${REQUIREMENT_LINE}", behind as he is; no closing line; no red on the bar or the chip`,
        `bar "${barText}", pace "${barPace}", left "${left}", note "${note}", required "${required}", closes ${closes}, colours ${JSON.stringify([barBg, barInk, fillBg, chipBg, chipInk])}, red ${JSON.stringify(red)}`,
        barText === 'This week: 1.5 of 7.5 loads' && barPace === 'Needs Focus' && left === '6 loads left this week.' && note === NEW_WEEK_LINE && required === REQUIREMENT_LINE && closes === 0 && red.length === 0,
        await shot(page, `P-low-${t}`))
    } finally {
      await ctx.close()
    }
  }
  const met = freshState({ thisWeek: { credits: { value: 7.5, target: 7.5, required: 6, deliveries: 8, pickups: 7 }, left: 0, percent: 100, pace: 'ahead' } })
  {
    const { ctx, page } = await openPage(browser, size, DRIVER, met)
    try {
      await barSettled(page, met, true)
      await appears(page, testid('perf-bar'), 8000)
      const barPace = await text(page, testid('perf-bar-pace'))
      const fill = await page.locator(testid('perf-bar-fill')).first().evaluate((el) => el.style.width).catch(() => '')
      await press(page.locator(testid('perf-bar')).first(), size)
      await appears(page, testid('perf-left'), 8000)
      const left = await text(page, testid('perf-left'))
      const closes = await page.locator(testid('perf-closes')).count()
      record(`P-met-${t}`, 'The target reached', `Ahead of Pace; fill 100%; "7.5 reached this week."; no closing line`,
        `pace "${barPace}", fill ${fill}, left "${left}", closes ${closes}`,
        barPace === 'Ahead of Pace' && fill === '100%' && left === '7.5 reached this week.' && closes === 0, await shot(page, `P-met-${t}`))
    } finally {
      await ctx.close()
    }
  }
  const none = freshState({ thisWeek: { credits: { value: 0, target: 7.5, required: 6, deliveries: 0, pickups: 0 }, left: 7.5, percent: 0, pace: null, loads: [] } })
  {
    const { ctx, page } = await openPage(browser, size, DRIVER, none)
    try {
      await barSettled(page, none, true)
      await appears(page, testid('perf-bar'), 8000)
      const barText = await text(page, testid('perf-bar-text'))
      const barLabel = await page.locator(testid('perf-bar-pace')).count()
      await press(page.locator(testid('perf-bar')).first(), size)
      await appears(page, testid('perf-no-loads'), 8000)
      const empty = await text(page, testid('perf-no-loads'))
      const tabLabel = await page.locator(testid('perf-pace')).count()
      record(`P-none-${t}`, 'Nothing yet and no load in his name: no label', `"This week: 0 of 7.5 loads"; no label on the bar or the tab; the empty line`,
        `bar "${barText}", labels ${barLabel} and ${tabLabel}, empty "${empty}"`,
        barText === 'This week: 0 of 7.5 loads' && barLabel === 0 && tabLabel === 0 && empty.length > 0, await shot(page, `P-none-${t}`))
    } finally {
      await ctx.close()
    }
  }
  const percentage = freshState()
  {
    const { ctx, page } = await openPage(browser, size, DRIVER, percentage)
    try {
      await barSettled(page, percentage, true)
      await appears(page, testid('perf-bar'), 8000)
      await press(page.locator(testid('perf-bar')).first(), size)
      await appears(page, testid('perf-rule'), 8000)
      const notPay = await page.locator(testid('perf-not-pay')).count()
      const body = squeeze(await page.locator('body').innerText())
      record(`P-percentage-${t}`, 'A percentage driver: nothing about pay', `no not-pay line; "Counts loads" and "invoice pays days" nowhere on the page`,
        `not-pay lines ${notPay}, counts-loads on the page ${body.includes('Counts loads')}, pays-days on the page ${body.includes('invoice pays days')}`,
        notPay === 0 && !body.includes('Counts loads') && !body.includes('invoice pays days'), await shot(page, `P-percentage-${t}`))
    } finally {
      await ctx.close()
    }
  }
  const dayOff = freshState({ thisWeek: { credits: { value: 3, target: 6, required: 4.5, deliveries: 3, pickups: 3 }, left: 3, percent: 50, pace: 'on-track', targetLowered: true } })
  {
    const { ctx, page } = await openPage(browser, size, DRIVER, dayOff)
    try {
      await barSettled(page, dayOff, true)
      await appears(page, testid('perf-bar'), 8000)
      const barText = await text(page, testid('perf-bar-text'))
      await press(page.locator(testid('perf-bar')).first(), size)
      await appears(page, testid('perf-lowered'), 8000)
      const count = await text(page, testid('perf-count'))
      const left = await text(page, testid('perf-left'))
      const target = await text(page, testid('perf-target'))
      const lowered = await text(page, testid('perf-lowered'))
      const required = await text(page, testid('perf-requirement'))
      const follows =await page.locator(testid('perf-target')).first().evaluate((el) => (el.nextElementSibling || {}).dataset?.testid === 'perf-lowered').catch(() => false)
      await choose(page, size, 'Last week')
      await appears(page, testid('perf-counted-title'), 8000)
      await page.waitForTimeout(150)
      const lastWeekLine = await page.locator(testid('perf-lowered')).count()
      const lastRequired = await text(page, testid('perf-requirement'))
      record(`P-day-off-${t}`, 'An approved day off: his lower figure, and the line that says why', `"This week: 3 of 6 loads"; "3 of 6 loads"; "3 loads left this week."; "${TARGET_LINE}" then "${LOWER_TARGET_LINE}"; "6 is the target. 4.5 is required."; not on Last week, as its words say this week; Last week's line is its own`,
        `bar "${barText}", count "${count}", left "${left}", target "${target}", lowered "${lowered}", required "${required}", follows ${follows}, on last week ${lastWeekLine}, last week's line "${lastRequired}"`,
        barText === 'This week: 3 of 6 loads' && count === '3 of 6 loads' && left === '3 loads left this week.' && target === TARGET_LINE && lowered === LOWER_TARGET_LINE && required === '6 is the target. 4.5 is required.' && follows && lastWeekLine === 0 && lastRequired === REQUIREMENT_LINE,
        await shot(page, `P-day-off-${t}`))
    } finally {
      await ctx.close()
    }
  }
  const timeOff = freshState({ thisWeek: { credits: { value: 0, target: 4.5, required: null, deliveries: 0, pickups: 0 }, left: 4.5, percent: 0, pace: null, newWeekNote: true, targetLowered: true, loads: [] } })
  {
    const { ctx, page } = await openPage(browser, size, DRIVER, timeOff)
    try {
      await barSettled(page, timeOff, true)
      await appears(page, testid('perf-bar'), 8000)
      await press(page.locator(testid('perf-bar')).first(), size)
      await appears(page, testid('perf-requirement'), 8000)
      const requirement = await text(page, testid('perf-requirement'))
      const body = squeeze(await page.locator('body').innerText())
      record(`P-time-off-${t}`, 'Time off makes the required figure impossible: the target alone', `"4.5 is the target."; "is required" nowhere on the page`,
        `requirement "${requirement}", on the page ${body.includes('is required')}`,
        requirement === '4.5 is the target.' && !body.includes('is required'), await shot(page, `P-time-off-${t}`))
    } finally {
      await ctx.close()
    }
  }
}

// ---------------------------------------------------------------- O, N: nothing new
async function nothingNewRun(browser, size, step, refusal, title) {
  const t = size.tag
  const state = freshState({ own: refusal })
  const { ctx, page } = await openPage(browser, size, DRIVER, state)
  try {
    await barSettled(page, state, false)
    const labels = await tabLabels(page)
    const body = squeeze(await page.locator('body').innerText())
    const bars = await barCount(page)
    const words = ['Performance', 'This week:', 'Most loads', 'Not eligible', 'NOT_ELIGIBLE', 'FEATURE_OFF', 'Hours of service', 'Never drive past'].filter((w) => body.includes(w))
    const stepShot = await shot(page, `${step}-${t}`)
    await press(page.locator('.van-tabbar-item', { hasText: 'Alerts' }).first(), size)
    await press(page.locator('.van-tabbar-item', { hasText: 'Loads' }).first(), size)
    await appears(page, '.load-sub-tabs', 4000)
    const slotsMoved = await slotCount(page)
    record(`${step}-${t}`, title, `labels ${JSON.stringify(BASE_TABS)}; no bar; the board never read; nothing on the page about it; after his first move, not even its held place`,
      `labels ${JSON.stringify(labels)}, bars ${bars}, own reads ${state.calls.own}, board reads ${state.calls.week + state.calls.month}, words ${JSON.stringify(words)}, places after a move ${slotsMoved}`,
      sameList(labels, BASE_TABS) && bars === 0 && state.calls.own > 0 && state.calls.week + state.calls.month === 0 && words.length === 0 && slotsMoved === 0, stepShot)
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
    const barsBefore = await barCount(page)
    const readsBefore = state.calls.own
    state.own = 200
    await comeBackToApp(page)
    const shown = await appears(page, '.van-tabbar-item:has-text("Performance")', 6000)
    const barShown = await appears(page, testid('perf-bar'), 6000)
    const after = await tabLabels(page)
    record(`U-${t}`, 'The check fails: no tab, no bar; coming back to the app asks again', `first ${JSON.stringify(BASE_TABS)} and no bar; another read on coming back; then ${JSON.stringify(ALL_TABS)} and the bar`,
      `first ${JSON.stringify(before)} bars ${barsBefore}, reads ${readsBefore} then ${state.calls.own}, then ${JSON.stringify(after)} bar ${barShown}`,
      sameList(before, BASE_TABS) && barsBefore === 0 && state.calls.own > readsBefore && shown && barShown && sameList(after, ALL_TABS), await shot(page, `U-${t}`))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- A: a Super Admin on /driver
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

async function adminRun(browser, size) {
  const t = size.tag
  const state = freshState()
  const { ctx, page } = await openPage(browser, size, ADMIN, state)
  try {
    const hasTab = await barSettled(page, state, true)
    const bars = await barCount(page) + await slotCount(page)
    const opened = hasTab && await openTab(page, size, 'perf-board')
    const want = expectedRows(THIS_ROWS)
    const got = opened ? await waitForRows(page, want) : []
    const titles = await allText(page.locator(`${testid('perf-tile')} .perf-title`))
    const closes = await text(page, testid('perf-closes'))
    const myWeek = await page.locator(testid('perf-week')).count()
    const you = await page.locator(testid('perf-you')).count()
    const hos = await text(page, testid('perf-hos'))
    const adminShot =await shot(page, `A-${t}`)
    await choose(page, size, 'This month')
    const monthGot = opened ? await waitForRows(page, expectedRows(MONTH_ROWS)) : []
    record(`A-${t}`, 'A Super Admin on /driver: the office board as it was', `no bar; rows with no "You"; the four tiles; "${WEEK_CLOSES}"; This month its own rows; no My week; his own-week route never read; the hours-of-service line`,
      `bars ${bars}, rows ${JSON.stringify(got)}, tiles ${JSON.stringify(titles)}, closes "${closes}", month ${JSON.stringify(monthGot)}, My week ${myWeek}, you ${you}, own reads ${state.calls.own}, hos ${hos === HOS_LINE}`,
      opened && bars === 0 && sameList(got, want) && sameList(titles, TILES) && closes === WEEK_CLOSES && sameList(monthGot, expectedRows(MONTH_ROWS)) && myWeek === 0 && you === 0 && state.calls.own === 0 && hos === HOS_LINE,
      adminShot)
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
      await loadPageRun(browser, size)
      await stillRun(browser, size)
      await decoyRun(browser, size)
      await failedWeekRun(browser, size)
      await failedBarRun(browser, size)
      await goneRun(browser, size)
    }
    await weekShapesRun(browser, PHONE)
    await nothingNewRun(browser, PHONE, 'O', REFUSALS.off, 'The kill switch off: nothing new')
    await nothingNewRun(browser, PHONE, 'N', REFUSALS.notEligible, 'A driver with no week: nothing new, and no word why')
    await checkFailsRun(browser, PHONE)
    await adminRun(browser, DESKTOP)
  } finally {
    await browser.close()
    server.close()
  }

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    `# Driver Performance check (${OUT_TAG})`, '',
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
