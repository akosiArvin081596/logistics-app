#!/usr/bin/env node
// LogisX — Past Performance and the release that brings it, on made-up data only, at 390x844.
//
// As a made-up Driver ("Casey Example"), signing in through the login form (the note opens only then):
//   N1  What's new: the list's own words, newest entry first; "Show me" the big blue button (Vant's
//       primary) and "I acknowledge" the smaller one under it; the line above both; 44 px or more
//   N2  Show me walks the release's steps on the real tabs with no Skip, and Escape does nothing; Next
//       until the last step, whose button says I acknowledge; the Past Performance step on its tab in
//       its own words; the tap saves the confirmation for every entry shown, then the tour's mark, and
//       the tour and the note close, back on Loads
//   N3  the bar opens the tab named Past Performance: this week on top, then "Past weeks", newest
//       first, each with its dates, its turns of its target and "Driving hours: coming soon", then
//       "Weeks before <the first counted week> weren't counted."; no sideways scroll
//   N4  the Loads bar in each of its colors, the server's choice for the week's credits: 3.5 red, 5.5
//       orange, 6 green, 8 blue; its words and its pace label stay, and the label is never red
//   N5  a moving truck: Show me says when inside the note and starts nothing; the note's own, smaller
//       I acknowledge answers it, and no tour mark is written
//
// Screens for the LIVE ring (made-up data) go to SHOT_DIR, numbered as above. Every answer comes from
// the real rules (lib/driver-releases.js, lib/driver-performance.js) over made-up figures, in the shapes
// the routes send, with the hours switch off. Like driver-release-notices.mjs this boots no server.js,
// opens no database, reads no settings file or key and signs nobody real in: it serves the checkout's
// built client/dist on 127.0.0.1 and answers every /api request in the browser. Every request to
// another host is aborted, the socket included.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/past-performance.mjs
//
// Env: E2E_PORT (default: a free port; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "past-performance"), HEADED=1, CHROME_PATH, E2E_WORK_DIR, SHOT_DIR (an absolute
// folder outside the checkout; default ~/LogisX-replica/reports/cc/work/past-performance/screens).
// Output: PASS/FAIL lines, a final count, the screenshots and <work dir>/results-<OUT_TAG>.md.
// Exit 0 only when every row PASSes.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import paths from './paths.cjs'
import { WORDS, TOUR_STEPS } from '../../client/src/lib/driverReleaseNotices.js'
import { DRIVE_HOURS_LINE, PAST_WEEKS_TITLE, THIS_WEEK_TITLE, countedFromLine } from '../../client/src/lib/driverPerformance.js'

const require = createRequire(import.meta.url)
const { RELEASES, unseenReleases } = require('../../lib/driver-releases.js')
const perf = require('../../lib/driver-performance.js')

const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'past-performance').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.homedir(), 'LogisX-replica', 'reports', 'cc', 'work', 'past-performance', 'screens')
const PHONE = { tag: '390x844', viewport: { width: 390, height: 844 } }

function die(msg) {
  console.error(`past-performance: ${msg}`)
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

// ---------------------------------------------------------------- made-up fixtures
const DRIVER = { id: 90521, username: 'qa-past-driver', role: 'Driver', driverName: 'Casey Example', email: '', fullName: 'Casey Example', companyName: '', mustChangePassword: false }
const DAY = 24 * 60 * 60 * 1000
const ACK_PATH = '/api/driver/me/release/acknowledge'
const TOUR_DONE_PATH = '/api/driver/me/release/tour-done'

// What a driver who has answered neither notice is due, newest first, as the route sends it.
const ENTRIES = unseenReleases([], RELEASES)
const ENTRY_IDS = ENTRIES.map((e) => e.id).sort()
const ALL_LINES = ENTRIES.flatMap((e) => e.notes.map((n) => n.text))
const STEP_TITLES = [...new Set(ENTRIES.flatMap((e) => e.tour))].map((id) => TOUR_STEPS.find((s) => s.id === id).title)
const PERFORMANCE_STEP = TOUR_STEPS.find((s) => s.id === 'performance')
const TAB_NAME = PERFORMANCE_STEP.title

// The business day in the app's zone, its Sat-Fri week (calendar arithmetic, as getWeekRange() reads a
// bare day), and the made-up past weeks under it.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const weekRangeOf = (day) => {
  const d = new Date(`${day}T12:00:00Z`)
  const sat = new Date(d.getTime() - ((d.getUTCDay() + 1) % 7) * DAY)
  return { weekStart: sat.toISOString().slice(0, 10), weekEnd: new Date(sat.getTime() + 6 * DAY).toISOString().slice(0, 10) }
}
const THIS = weekRangeOf(TODAY)
const PAST = [1, 2, 3].map((n) => ({ start: perf.addDays(THIS.weekStart, -7 * n), end: perf.addDays(THIS.weekEnd, -7 * n) }))
const COUNTED_FROM = perf.countedFrom(PAST[PAST.length - 1].start)
// [deliveries, pickups, approved days off] for each past week, newest first.
const PAST_COUNTS = [[8, 7, 0], [5, 5, 1], [1, 0, 0]]
const PAST_WEEKS = PAST.map((w, i) => perf.pastWeek({ start: w.start, end: w.end, deliveries: PAST_COUNTS[i][0], pickups: PAST_COUNTS[i][1], offDays: Array.from({ length: PAST_COUNTS[i][2] }, (_x, k) => perf.addDays(w.start, 2 + k)) }))

// This week through the real rules, with made-up loads that add up to the figure.
function thisWeek(deliveries, pickups) {
  const n = Math.max(deliveries, pickups)
  const loads = Array.from({ length: n }, (_x, i) => perf.countedLoad({
    loadId: `QA-95${String(i).padStart(2, '0')}`,
    pickupDay: i < pickups ? THIS.weekStart : '',
    deliveryDay: i < deliveries ? THIS.weekStart : '',
    pickupNote: i < pickups ? '' : 'last-week',
  }))
  return perf.personalWeek({ id: 'this-week', start: THIS.weekStart, end: THIS.weekEnd, today: TODAY, deliveries, pickups, loads, offDays: [], openLoad: true })
}
const lastWeek = perf.personalWeek({ id: 'last-week', start: PAST[0].start, end: PAST[0].end, today: TODAY, deliveries: 8, pickups: 7, loads: [], offDays: [], openLoad: false })
// The four colors at D's edges, and the fill each one paints.
const BANDS = [
  { credits: 3.5, deliveries: 4, pickups: 3, color: 'red', rgb: 'rgb(220, 38, 38)' },
  { credits: 5.5, deliveries: 6, pickups: 5, color: 'orange', rgb: 'rgb(234, 88, 12)' },
  { credits: 6, deliveries: 6, pickups: 6, color: 'green', rgb: 'rgb(22, 163, 74)' },
  { credits: 8, deliveries: 8, pickups: 8, color: 'blue', rgb: 'rgb(37, 99, 235)' },
]

// One browser's view of the server. `week` is [deliveries, pickups] for this week; `moving` the truck.
function freshState({ week = [4, 3], moving = false, hasNote = true } = {}) {
  return { week, moving, hasNote, session: false, acknowledged: new Set(), tourDone: new Set(), calls: { release: 0, logout: 0, login: 0, position: 0, ack: 0 } }
}

function positionAnswer(state) {
  state.calls.position++
  const stamp = new Date(Date.now() - 5000).toISOString()
  const fix = { latitude: 29.7, longitude: -95.3, heading: 90, source: 'routemate', lastPingAge: 5000, timestamp: stamp }
  if (state.moving) return { ok: true, position: { ...fix, speed: 25 } }
  return { ok: true, position: { ...fix, speed: 0, stoppedSinceMs: Date.now() - 10 * 60 * 1000 } }
}

function driverPayload() {
  return {
    loads: [], headers: { jobTracking: [], carrierDB: [] },
    onboarding: { user_id: DRIVER.id, status: 'fully_onboarded', onboarded_at: new Date(Date.now() - 30 * DAY).toISOString(), documents: [], totalDocs: 5 },
    driverInfo: null, truck: null, expenses: [], drivers: [], invoices: [], sharedDocuments: [], truckDocuments: [], messages: [], notifications: [],
  }
}

function answerGet(state, u) {
  const pathname = u.pathname
  if (pathname === '/api/auth/session') return { status: 200, body: state.session ? { authenticated: true, user: DRIVER, appTimeZone: 'America/New_York' } : { authenticated: false } }
  if (pathname === '/api/auth/setup-check') return { status: 200, body: { needsSetup: false } }
  if (!state.session) return { status: 401, body: { error: 'Not signed in' } }
  if (pathname === '/api/driver/me/release') {
    state.calls.release++
    const answered = ENTRY_IDS.every((id) => state.acknowledged.has(id))
    return { status: 200, body: { notes: state.hasNote && !answered ? ENTRIES : [], tourOffered: false } }
  }
  if (pathname === '/api/driver/position') return { status: 200, body: positionAnswer(state) }
  if (pathname === '/api/driver/me/performance') {
    return { status: 200, body: { view: 'no-hours-data', creditWeights: { ...perf.CREDIT_WEIGHTS }, weeks: [thisWeek(...state.week), lastWeek], pastWeeks: PAST_WEEKS, countedFrom: COUNTED_FROM } }
  }
  if (pathname === '/api/driver/performance/leaderboard') return { status: 404, body: { error: 'Not found', code: 'FEATURE_OFF' } }
  if (pathname === '/api/fuel/range') return { status: 200, body: { ok: false } }
  if (/^\/api\/driver\/[^/]+$/.test(pathname)) return { status: 200, body: driverPayload() }
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the past performance check"}')
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
// Every write the page sends is kept in `writes` as "METHOD path".
async function newContext(browser, size, state, writes) {
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) { offHost.add(u.host); return route.abort() }
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (req.method() === 'GET') {
      const out = answerGet(state, u)
      if (out === null) unanswered.add(u.pathname)
      return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out ? out.body : {}) })
    }
    writes.push(`${req.method()} ${u.pathname}`)
    let body = {}
    try { body = req.postDataJSON() || {} } catch { body = {} }
    const ids = Array.isArray(body.ids) ? body.ids : []
    if (u.pathname === '/api/auth/login') {
      state.calls.login++
      state.session = true
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, user: DRIVER, appTimeZone: 'America/New_York' }) })
    }
    if (u.pathname === '/api/auth/logout') {
      state.calls.logout++
      state.session = false
    } else if (u.pathname === ACK_PATH) {
      state.calls.ack++
      if (state.ackDelayMs) await new Promise((r) => setTimeout(r, state.ackDelayMs))
      for (const id of ids) state.acknowledged.add(id)
    } else if (u.pathname === TOUR_DONE_PATH) {
      for (const id of ids) state.tourDone.add(id)
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })
  return ctx
}

const squeeze = (t) => (t || '').replace(/\s+/g, ' ').trim()
const text = (page, selector) => page.locator(selector).first().textContent({ timeout: 2000 }).then(squeeze, () => '')
const allText = (loc) => loc.allTextContents().then((list) => list.map(squeeze))
const testid = (id) => `[data-testid="${id}"]`
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1)
const activeTab = (page) => text(page, '.van-tabbar-item--active .van-tabbar-item__text')
const noteUp = (page) => page.locator(testid('release-dialog')).count()
const marksOf = (writes) => writes.filter((w) => !w.includes('/api/auth/'))
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
async function heights(page, selector) {
  const out = []
  for (const el of await page.locator(selector).all()) {
    if (await el.isVisible()) out.push(Math.round((await el.boundingBox()).height))
  }
  return out
}
const tall = (list) => list.length > 0 && list.every((h) => h >= 44)
// Red means a strong red channel over weak green and blue, so a pale neutral chip never counts.
const looksRed = (css) => {
  const m = /rgba?\((\d+), ?(\d+), ?(\d+)/.exec(css || '')
  return !!m && Number(m[1]) > 170 && Number(m[2]) < 110 && Number(m[3]) < 110
}
const backgroundOf = (page, selector) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => '')
// The note's two buttons as the driver sees them: Vant's primary or not, where each sits, its words' size.
const noteButtons = (page) => page.evaluate(() => {
  const box = document.querySelector('[data-testid="release-dialog"]')
  const read = (id) => {
    const el = box && box.querySelector(`[data-testid="${id}"]`)
    if (!el) return null
    const s = getComputedStyle(el)
    return { primary: el.classList.contains('van-button--primary'), top: Math.round(el.getBoundingClientRect().top), font: parseFloat(s.fontSize), background: s.backgroundColor }
  }
  return { showMe: read('release-show-me'), acknowledge: read('release-acknowledge') }
})
const bigAndSmall = (b) => !!b.showMe && !!b.acknowledge && b.showMe.primary && !b.acknowledge.primary && b.showMe.top < b.acknowledge.top && b.acknowledge.font < b.showMe.font

// Through the login form, as a driver signs in: the only way the note opens.
async function signedIn(browser, size, options = {}) {
  const state = freshState(options)
  const writes = []
  const ctx = await newContext(browser, size, state, writes)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}/driver`, { waitUntil: 'domcontentloaded' })
  await appears(page, 'input[autocomplete="username"]', 8000)
  await page.fill('input[autocomplete="username"]', DRIVER.username)
  await page.fill('#login-password', 'made-up-password')
  await page.locator('.submit-btn').first().tap()
  const app = await appears(page, '.van-tabbar', 15000)
  return { state, writes, ctx, page, app }
}

async function walkTour(page, titles) {
  const seen = []
  for (let i = 0; i < titles.length; i++) {
    await appears(page, testid('tour-card'), 5000)
    await page.waitForTimeout(250)
    seen.push({ label: await text(page, testid('tour-label')), title: await text(page, testid('tour-title')), text: await text(page, testid('tour-text')), tab: await activeTab(page), skip: await page.locator(testid('tour-skip')).count(), next: await text(page, testid('tour-next')) })
    if (i < titles.length - 1) await page.locator(testid('tour-next')).first().tap()
  }
  return seen
}

// ---------------------------------------------------------------- N1, N2: the note and its tour
async function noteAndTourRun(browser, size) {
  const t = size.tag
  const { state, writes, ctx, page, app } = await signedIn(browser, size)
  try {
    const shows = await appears(page, testid('release-dialog'), 10000)
    await page.waitForTimeout(400)
    const titles = await allText(page.locator(testid('release-entry-title')))
    const lines = await allText(page.locator(testid('release-line')))
    const ackLine = await text(page, testid('release-acknowledge-line'))
    const words = [await text(page, testid('release-show-me')), await text(page, testid('release-acknowledge'))]
    const looks = await noteButtons(page)
    const sized = await heights(page, `${testid('release-show-me')}, ${testid('release-acknowledge')}`)
    const fits = await noSideScroll(page)
    record(`N1-${t}`, "What's new: Show me is the big blue button, and I acknowledge the smaller one under it",
      `titles ${JSON.stringify(ENTRIES.map((e) => e.title))}, newest first; lines ${JSON.stringify(ALL_LINES)}; "${WORDS.acknowledgeLine}" above both; "${WORDS.showMe}" primary and on top, "${WORDS.acknowledge}" under it, not primary, in smaller words; both 44 px or more; no side scroll`,
      `app ${app}, shown ${shows}, titles ${JSON.stringify(titles)}, lines ${JSON.stringify(lines)}, line "${ackLine}", words ${JSON.stringify(words)}, looks ${JSON.stringify(looks)}, heights ${JSON.stringify(sized)}, fits ${fits}`,
      app && shows && sameList(titles, ENTRIES.map((e) => e.title)) && sameList(lines, ALL_LINES) && ackLine === WORDS.acknowledgeLine
        && sameList(words, [WORDS.showMe, WORDS.acknowledge]) && bigAndSmall(looks) && tall(sized) && sized.length === 2 && fits,
      await shot(page, '1-note-show-me-primary'))

    await page.locator(testid('release-show-me')).first().tap()
    const walked = await walkTour(page, STEP_TITLES)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    const stillUp = await page.locator(testid('tour-card')).count()
    const lastShot = await shot(page, '2-tour-last-step-i-acknowledge')
    const midWrites = marksOf(writes)
    const perfStep = walked.find((s) => s.title === TAB_NAME) || {}
    const last = walked[walked.length - 1] || {}
    state.ackDelayMs = 1500
    await page.locator(testid('tour-next')).first().tap()
    await page.waitForTimeout(400)
    const busy = await page.locator(testid('tour-next')).first().getAttribute('aria-busy').catch(() => null)
    const cardGone = await gone(page, testid('tour-card'), 8000)
    const noteGone = await gone(page, testid('release-dialog'), 8000)
    await until(() => writes.includes(`POST ${TOUR_DONE_PATH}`), 5000)
    const tab = await activeTab(page)
    record(`N2-${t}`, 'Show me walks the release\'s steps with no Skip, to a last step whose I acknowledge saves and closes the tour and the note',
      `steps ${JSON.stringify(STEP_TITLES)}, "Step n of ${STEP_TITLES.length}"; no Skip on any step, and Escape leaves the card up; "${WORDS.tourNext}" until the last, then "${WORDS.acknowledge}"; the ${TAB_NAME} step on its tab, in its own words; nothing written along the way; the last tap busy while it saves; the confirmation for every entry shown, then the tour's mark; the tour and the note gone; back on Loads`,
      `walked ${JSON.stringify(walked.map((s) => [s.label, s.title, s.tab, s.skip, s.next]))}, step words "${perfStep.text}", still up after Escape ${stillUp}, writes along the way ${JSON.stringify(midWrites)}, busy ${busy}, confirmed ${JSON.stringify([...state.acknowledged].sort())}, writes ${JSON.stringify(marksOf(writes))}, card gone ${cardGone}, note gone ${noteGone}, tab "${tab}", logouts ${state.calls.logout}`,
      sameList(walked.map((s) => s.title), STEP_TITLES) && walked.every((s, i) => s.label === `Step ${i + 1} of ${STEP_TITLES.length}` && s.skip === 0)
        && walked.slice(0, -1).every((s) => s.next === WORDS.tourNext) && last.next === WORDS.acknowledge && stillUp === 1
        && perfStep.tab === TAB_NAME && perfStep.text === PERFORMANCE_STEP.text && midWrites.length === 0 && busy === 'true'
        && sameList([...state.acknowledged].sort(), ENTRY_IDS) && sameList(marksOf(writes), [`POST ${ACK_PATH}`, `POST ${TOUR_DONE_PATH}`])
        && cardGone && noteGone && tab === 'Loads' && state.calls.logout === 0,
      lastShot)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- N3: the tab
async function tabRun(browser, size) {
  const t = size.tag
  const { ctx, page, app } = await signedIn(browser, size, { hasNote: false })
  try {
    const bar = await appears(page, testid('perf-bar'), 10000)
    await page.locator(testid('perf-bar')).first().tap()
    const opened = await appears(page, testid('perf-tab'), 8000)
    await appears(page, testid('perf-past'), 8000)
    const labels = await allText(page.locator('.van-tabbar-item__text'))
    const active = await activeTab(page)
    const header = await text(page, `${testid('perf-panel')} .section-header`)
    const thisTitle = await text(page, testid('perf-this-week-title'))
    const count = await text(page, testid('perf-count'))
    const navHeights = await heights(page, '.van-tabbar-item')
    const fits = await noSideScroll(page)
    const topShot = await shot(page, '3-tab-past-performance-this-week')
    await page.locator(testid('perf-past')).first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    const pastTitle = await text(page, testid('perf-past-title'))
    const past = await page.locator(testid('perf-past-week')).evaluateAll((els) => els.map((el) => ['perf-past-range', 'perf-past-count', 'perf-past-hours'].map((id) => ((el.querySelector(`[data-testid="${id}"]`) || {}).textContent || '').replace(/\s+/g, ' ').trim())))
    const counted = await text(page, testid('perf-counted-from'))
    const pastShot = await shot(page, '3b-tab-past-weeks')
    const want = PAST_WEEKS.map((w) => [rangeText(w.start, w.end), `${w.credits.value} of ${w.credits.target} loads`, DRIVE_HOURS_LINE])
    const order = await page.evaluate(() => ['perf-this-week-title', 'perf-week', 'perf-counted', 'perf-past', 'perf-private'].map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null
    }))
    record(`N3-${t}`, `The bar opens ${TAB_NAME}: this week on top, then each past week with its turns, and the line naming what wasn't counted`,
      `the nav's sixth tab "${TAB_NAME}", active, 44 px or more; header "${TAB_NAME}"; "${THIS_WEEK_TITLE}" and this week's figure on top; "${PAST_WEEKS_TITLE}" rows ${JSON.stringify(want)}, newest first; "${countedFromLine(COUNTED_FROM)}"; top to bottom in that order; no side scroll`,
      `app ${app}, bar ${bar}, opened ${opened}, labels ${JSON.stringify(labels)}, active "${active}", header "${header}", this week "${thisTitle}" "${count}", past "${pastTitle}" ${JSON.stringify(past)}, line "${counted}", tops ${JSON.stringify(order)}, heights ${JSON.stringify(navHeights)}, fits ${fits}`,
      app && bar && opened && labels[labels.length - 1] === TAB_NAME && active === TAB_NAME && header === TAB_NAME && tall(navHeights)
        && thisTitle === THIS_WEEK_TITLE && count === '3.5 of 7.5 loads' && pastTitle === PAST_WEEKS_TITLE && sameList(past, want)
        && counted === countedFromLine(COUNTED_FROM) && order.every((n, i) => n !== null && (i === 0 || n > order[i - 1])) && fits,
      topShot)
    rows[rows.length - 1].shot = `${path.basename(topShot)}, ${path.basename(pastShot)}`
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- N4: the bar in each color
async function barColorsRun(browser, size) {
  const t = size.tag
  for (const band of BANDS) {
    const { ctx, page, app } = await signedIn(browser, size, { hasNote: false, week: [band.deliveries, band.pickups] })
    try {
      const bar = await appears(page, testid('perf-bar'), 10000)
      await page.waitForTimeout(400)
      const barText = await text(page, testid('perf-bar-text'))
      const fill = await backgroundOf(page, testid('perf-bar-fill'))
      const named = await page.locator(testid('perf-bar-fill')).first().getAttribute('data-color').catch(() => null)
      const chip = await backgroundOf(page, testid('perf-bar-pace'))
      const pace = await text(page, testid('perf-bar-pace'))
      const server = thisWeek(band.deliveries, band.pickups).barColor
      record(`N4-${band.color}-${t}`, `${band.credits} credits: the Loads bar is ${band.color}, and keeps its words`,
        `the server's "${band.color}"; the fill ${band.rgb}; "This week: ${band.credits} of 7.5 loads"; the label, if any, not red`,
        `app ${app}, bar ${bar}, server "${server}", attribute "${named}", fill ${fill}, text "${barText}", label "${pace}" ${chip}`,
        app && bar && server === band.color && named === band.color && fill === band.rgb && barText === `This week: ${band.credits} of 7.5 loads` && !looksRed(chip),
        await shot(page, `4-bar-${band.color}-${String(band.credits).replace('.', '_')}`))
    } finally {
      await ctx.close()
    }
  }
}

// ---------------------------------------------------------------- N5: a moving truck
async function movingRun(browser, size) {
  const t = size.tag
  const { state, writes, ctx, page, app } = await signedIn(browser, size, { moving: true })
  try {
    const shows = await appears(page, testid('release-dialog'), 10000)
    const read = await until(() => state.calls.position > 0, 35000)
    await page.waitForTimeout(800)
    await page.locator(testid('release-show-me')).first().tap()
    const says = await appears(page, `${testid('release-dialog')} ${testid('release-when-parked')}`, 3000)
    const lineWords = await text(page, testid('release-when-parked'))
    const tours = await page.locator(testid('tour-card')).count()
    const looks = await noteButtons(page)
    const movingShot = await shot(page, '5-moving-truck-note')
    await page.locator(testid('release-acknowledge')).first().tap()
    const closed = await gone(page, testid('release-dialog'), 8000)
    record(`N5-${t}`, "A moving truck: Show me says when and starts nothing; the note's own, smaller I acknowledge answers it",
      `the note; "${WORDS.whenParked}" in it after Show me; no tour; I acknowledge still the smaller button; one confirmation for every entry, no tour mark; the note gone; no logout`,
      `app ${app}, shown ${shows}, truck read ${read}, line ${says} "${lineWords}", tours ${tours}, looks ${JSON.stringify(looks)}, confirmed ${JSON.stringify([...state.acknowledged].sort())}, writes ${JSON.stringify(marksOf(writes))}, closed ${closed}, logouts ${state.calls.logout}`,
      app && shows && read && says && lineWords === WORDS.whenParked && tours === 0 && bigAndSmall(looks)
        && sameList([...state.acknowledged].sort(), ENTRY_IDS) && sameList(marksOf(writes), [`POST ${ACK_PATH}`]) && closed && state.calls.logout === 0,
      movingShot)
  } finally {
    await ctx.close()
  }
}

// "Nov 7 – Nov 13", as the tab prints a week's days (client/src/lib/availabilityText.js).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const md = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8, 10))}`
function rangeText(from, to) {
  if (from === to) return md(from)
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${md(from)}, ${from.slice(0, 4)} – ${md(to)}, ${to.slice(0, 4)}`
  return `${md(from)} – ${md(to)}`
}

async function main() {
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ASKED_PORT, HOST, resolve) })
  PORT = server.address().port
  if (PORT === 3000 || PORT === 5173) { server.close(); die(`the system picked port ${PORT}: set E2E_PORT to a free one`) }
  BASE = `http://${HOST}:${PORT}`
  console.log(`past-performance: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    await noteAndTourRun(browser, PHONE)
    await tabRun(browser, PHONE)
    await barColorsRun(browser, PHONE)
    await movingRun(browser, PHONE)
  } finally {
    await browser.close()
    server.close()
  }

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    `# Past Performance check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? (r.shot.includes(',') ? r.shot : path.basename(r.shot)) : ''} |`),
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Browser requests to another host, aborted (not part of the verdict): ${[...offHost].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, out, { mode: 0o600 })
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`past-performance: ${passed}/${rows.length} PASS, ${rows.length - passed} FAIL; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  if (pageErrors.length) console.log(`past-performance: page errors: ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((err) => {
  console.error('past-performance: FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
