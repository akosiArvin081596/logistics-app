#!/usr/bin/env node
// LogisX — new-feature notices for drivers: "What's new" right after a sign-in, confirmed with
// "I acknowledge", the tour, and the Drivers page's record of who confirmed, on made-up data only. Nothing
// opens on a page already open, and there is no forced sign-out: every row counts the logout calls, and
// only a driver's own tap on Logout makes one. The fixture's server answers what's unconfirmed on every
// read, as the real one does, so what stays off screen here stays off by the app's own doing.
//
// As a made-up Driver ("Casey Example"), at 390x844 and 1280x800:
//   S   a page already open: nothing new at app open, on coming back, on a tap or on a reload, and no
//       logout. They log out themselves: the login page says nothing about an update. They sign in as
//       usual: the note shows the list's own words, the line above both buttons, Show me the big blue
//       one and I acknowledge the smaller one under it; Show me walks the release's steps on the real
//       tabs with no Skip; the last step's I acknowledge shows it's working, takes one tap and closes
//       the tour and the note; a reload shows nothing; only the confirmation and the tour mark are
//       written. 44 px or more, no sideways scroll
//   T   a load In Transit on a page already open: nothing new; the load stays on screen
//   N   the note stays until I acknowledge: a tap outside it and Escape do nothing. A confirmation that
//       can't be saved: the note closes with the line, they're in their loads, and the next sign-in asks
//       again
// And at 390x844:
//   U   a note left unanswered: a reload shows nothing, and the next sign-in brings it back; confirmed,
//       it doesn't come again. The release tour has no Skip, and Escape does nothing; left mid-tour, the
//       note is unanswered and comes back at the next sign-in
//   E   a page left open past its session: this feature does nothing to it, and it isn't sent to the
//       login page. The next load finds the login page, and the note comes after that sign-in
//   V   a moving truck's open page never changes: nothing opens as a truck stops, and a note or a tour
//       that's up stays up as a truck moves. A sign-in on a moving truck still shows the note. On a truck
//       read as moving, Show me says when in the note's own line, in sight without a scroll and on top of
//       everything, and the Kit's button in the app's short message; neither starts anything, the note
//       stays, and its own smaller I acknowledge answers it. V2 runs at 375x667 and 320x568 too, where
//       the note fills its box
//   F   a failed read at sign-in (503, no answer, an unreadable body): no note, no Kit button, and they
//       stay in the app; a later load has the Kit button and nothing new; the next sign-in has the note
//   P   a failed Performance answer at sign-in: no note and no mark; a good one later opens nothing; the
//       next sign-in has the note whole. A driver with no week reads only their line
//   L   a load's page open as the answer lands: no note there or on the way back; the next sign-in has it
//   K   the kill switch off (404 FEATURE_OFF): nothing new anywhere
//   H   a shared phone: the next driver signs in and reads their own answer; nothing of this is kept in
//       the browser
//   O   a first-time driver: the offer, Skip for now, no nagging; Take the tour walks every tab; the
//       tour marks no message or alert read and writes only its own marks; the Kit's button runs it;
//       a forced password change at sign-in, and the offer after it
//   B   a sign-in that lands on the lock screen: nothing shown; the lock lifting on that page opens
//       nothing; the next sign-in has the note
// And:
//   A   a made-up Super Admin on /driver at 1280x800: the route is never read, no note, no button
//   R   a made-up Super Admin on the Drivers page, at 1280x800 and 390x844: "Driver notices" with the
//       count and the three states, times on the app's clock; nothing with the switch off; a line when
//       the record can't be read; a Driver sent away from the page, the record never read
//
// Screens for the LIVE note (made-up data) go to SHOT_DIR, named for what each shows: 1 the note, 2 I
// acknowledge at work, 3 the line when it can't be saved, 4 the Drivers page's record, each at both
// sizes; the other rows' screens follow them.
//
// Like driver-performance.mjs this boots no server.js, opens no database, reads no settings file or
// key and signs nobody real in. It serves the checkout's built client/dist from its own static server
// on 127.0.0.1 and answers every /api request in the browser with made-up fixtures in the shapes
// lib/driver-release-routes.js sends. Every request to another host is aborted, the socket included.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/driver-release-notices.mjs
//
// Env: E2E_PORT (default: a free port; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "driver-release-notices"), HEADED=1, CHROME_PATH, E2E_WORK_DIR, SHOT_DIR (an
// absolute folder outside the checkout; default ~/LogisX-replica/reports/cc/work/driver-release-notices/screens).
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
import { RECORD_WORDS } from '../../client/src/lib/driverNoticeRecord.js'

const require = createRequire(import.meta.url)
const { RELEASES, APP_TOUR_ROW, latestReleaseId, unseenReleases } = require('../../lib/driver-releases.js')

const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'driver-release-notices').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.homedir(), 'LogisX-replica', 'reports', 'cc', 'work', 'driver-release-notices', 'screens')
const PHONE = { tag: '390x844', viewport: { width: 390, height: 844 } }
// Short phones, where the note fills its box: V2 runs there too.
const SHORT = { tag: '375x667', viewport: { width: 375, height: 667 } }
const SMALLEST = { tag: '320x568', viewport: { width: 320, height: 568 } }
const DESKTOP = { tag: '1280x800', viewport: { width: 1280, height: 800 } }

function die(msg) {
  console.error(`driver-release-notices: ${msg}`)
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
const DRIVER = { id: 90421, username: 'qa-release-driver', role: 'Driver', driverName: 'Casey Example', email: '', fullName: 'Casey Example', companyName: '', mustChangePassword: false }
const DRIVER_B = { id: 90422, username: 'qa-release-driver-b', role: 'Driver', driverName: 'Riley Sample', email: '', fullName: 'Riley Sample', companyName: '', mustChangePassword: false }
const ADMIN = { id: 90420, username: 'qa-release-admin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Release Admin', companyName: '', mustChangePassword: false }
const DRIVER_TEMP = { id: 90423, username: 'qa-release-driver-temp', role: 'Driver', driverName: 'Taylor Temp', email: '', fullName: 'Taylor Temp', companyName: '', mustChangePassword: true }
const ACCOUNTS = { [DRIVER.username]: DRIVER, [DRIVER_B.username]: DRIVER_B, [DRIVER_TEMP.username]: DRIVER_TEMP }
const RELEASE = latestReleaseId(RELEASES)
const ENTRIES = unseenReleases([], RELEASES)
const LATEST = ENTRIES[0]
const ENTRY_IDS = ENTRIES.map((e) => e.id).sort()
// A driver with the tab reads every entry's lines, newest first; one without it, only the lines for everyone.
const ALL_LINES = ENTRIES.flatMap((e) => e.notes.map((n) => n.text))
const LINES_WITHOUT_TAB = ENTRIES.flatMap((e) => e.notes.filter((n) => !n.needs).map((n) => n.text))
const DAY = 24 * 60 * 60 * 1000
const LOAD_HEADERS = ['Load ID', 'Driver', 'Job Status', 'Pickup Appointment', 'Drop-off Appointment']
const ALL_STEP_TITLES = TOUR_STEPS.map((s) => s.title)
// Show me walks every entry's steps on screen, each once, in order.
const RELEASE_STEP_TITLES = [...new Set(ENTRIES.flatMap((e) => e.tour))].map((id) => TOUR_STEPS.find((s) => s.id === id).title)
// The tab's name, and its step's title.
const PERFORMANCE_TITLE = TOUR_STEPS.find((s) => s.id === 'performance').title
const ACK_PATH = '/api/driver/me/release/acknowledge'
const RECORD_PATH = '/api/admin/driver-release/acknowledgements'

const thisWeek = { id: 'this-week', start: '2026-10-31', end: '2026-11-06', credits: { value: 1, target: 7.5, required: 6, deliveries: 1, pickups: 1 }, left: 6.5, percent: 13, pace: 'on-track', newWeekNote: false, nextWeekStarts: 'Nov 7', targetLowered: false, loads: [] }
const lastWeek = { id: 'last-week', start: '2026-10-24', end: '2026-10-30', credits: { value: 7.5, target: 7.5, required: 6, deliveries: 8, pickups: 7 }, left: null, percent: 100, pace: null, newWeekNote: false, nextWeekStarts: null, targetLowered: false, loads: [] }

// The Drivers page's record, in the shape acknowledgementRecord() sends. Made-up drivers and times.
const RECORD_ANSWER = {
  notices: [{
    id: RELEASE, title: LATEST.title, date: RELEASE.slice(0, 10), acknowledged: 2, asked: 4,
    drivers: [
      { name: 'Avery Sample', state: 'not-yet', at: null },
      { name: 'Casey Example', state: 'acknowledged', at: '2026-11-12T20:04:00.000Z' },
      { name: 'Jordan Newhire', state: 'started-after', at: null },
      { name: 'Morgan Percent', state: 'acknowledged', at: '2026-11-12T21:30:00.000Z' },
      { name: 'Riley Sample', state: 'not-yet', at: null },
    ],
  }],
}
const RECORD_TEXTS = [
  ['Avery Sample', RECORD_WORDS.notYet],
  ['Casey Example', `${RECORD_WORDS.acknowledged} Nov 12, 2026, 3:04 PM EST`],
  ['Jordan Newhire', RECORD_WORDS.startedAfter],
  ['Morgan Percent', `${RECORD_WORDS.acknowledged} Nov 12, 2026, 4:30 PM EST`],
  ['Riley Sample', RECORD_WORDS.notYet],
]

// One browser's view of the server. `release` says how the route answers: 'ok', 'off', 'fail', 'abort'
// or 'empty'; `releaseDelayMs` holds its answer back. `ack` how the confirmation does: 'ok', 'fail' or
// 'abort', held back `ackDelayMs`. `record` how the Drivers page's record does: 'ok', 'off' or 'fail'.
// `reading` how the truck's does: 'fix', 'none', 'stale' or 'fail'. `perf` their week's: a status.
// `calls.logout` counts every logout: a row that doesn't tap Logout must see none.
function freshState({ who = DRIVER, session = true, status = '', offer = false, hasNote = false, release = 'ok', releaseDelayMs = 0, ack = 'ok', ackDelayMs = 0, record = 'ok', moving = false, onboarding = 'fully_onboarded', unread = false, reading = 'fix', perf = 200 } = {}) {
  return {
    who, session, status, offer, hasNote, release, releaseDelayMs, ack, ackDelayMs, record, moving, onboarding, unread, reading, perf,
    seen: new Set(), tourDone: new Set(), acknowledged: new Set(),
    calls: { release: 0, logout: 0, login: 0, position: 0, ack: 0, record: 0 },
  }
}
const madeUpLoad = (who, status) => ({ _rowIndex: 2, 'Load ID': 'QA-9200', Driver: who.driverName, 'Job Status': status, 'Pickup Appointment': '2026-11-02', 'Drop-off Appointment': '2026-11-04' })

function driverPayload(state) {
  const who = state.who
  return {
    loads: state.status ? [madeUpLoad(who, state.status)] : [],
    headers: { jobTracking: LOAD_HEADERS, carrierDB: [] },
    onboarding: { user_id: who.id, status: state.onboarding, onboarded_at: new Date(Date.now() - 30 * DAY).toISOString(), documents: [], totalDocs: 5 },
    driverInfo: null, truck: null, expenses: [], drivers: [], invoices: [], sharedDocuments: [], truckDocuments: [],
    messages: state.unread ? [{ id: 701, timestamp: new Date().toISOString(), from: 'Dispatch', to: who.driverName, message: 'A made-up message.', loadId: '', read: 0 }] : [],
    notifications: state.unread ? [{ id: 801, type: 'message', title: 'A made-up alert', body: 'Made up.', metadata: '{}', read: 0, createdAt: new Date().toISOString() }] : [],
  }
}

function releaseAnswer(state) {
  state.calls.release++
  if (state.release === 'off') return { status: 404, body: { error: 'Not found', code: 'FEATURE_OFF' } }
  if (state.release === 'fail') return { status: 503, body: { error: "That couldn't be read." } }
  if (state.release === 'empty') return { status: 200, body: {} }
  return {
    status: 200,
    body: {
      notes: state.hasNote && !state.seen.has(RELEASE) ? ENTRIES : [],
      tourOffered: state.offer && !state.seen.has(APP_TOUR_ROW),
    },
  }
}

function recordAnswer(state) {
  state.calls.record++
  if (state.release === 'off' || state.record === 'off') return { status: 404, body: { error: 'Not found', code: 'FEATURE_OFF' } }
  if (state.who.role !== 'Super Admin') return { status: 403, body: { error: 'Forbidden' } }
  if (state.record === 'fail') return { status: 503, body: { error: "That couldn't be read. Try again later.", code: 'RELEASE_UNAVAILABLE' } }
  return { status: 200, body: RECORD_ANSWER }
}

function positionAnswer(state) {
  state.calls.position++
  if (state.reading === 'fail') return { status: 503, body: { error: "That couldn't be read." } }
  if (state.reading === 'none') return { status: 200, body: { ok: true, position: null, reason: 'no_recent_fix' } }
  const age = state.reading === 'stale' ? 10 * 60 * 1000 : 5000
  const stamp = new Date(Date.now() - age).toISOString()
  const fix = { latitude: 29.7, longitude: -95.3, heading: 90, source: 'routemate', lastPingAge: age, timestamp: stamp }
  if (state.moving) return { status: 200, body: { ok: true, position: { ...fix, speed: 25 } } }
  return { status: 200, body: { ok: true, position: { ...fix, speed: 0, stoppedSinceMs: Date.now() - 10 * 60 * 1000 } } }
}

function answerGet(state, u) {
  const pathname = u.pathname
  if (pathname === '/api/auth/session') return { status: 200, body: state.session ? { authenticated: true, user: state.who, appTimeZone: 'America/New_York' } : { authenticated: false } }
  if (pathname === '/api/auth/setup-check') return { status: 200, body: { needsSetup: false } }
  if (!state.session) return { status: 401, body: { error: 'Not signed in' } }
  if (pathname === '/api/driver/me/release') return releaseAnswer(state)
  if (pathname === RECORD_PATH) return recordAnswer(state)
  if (pathname === '/api/driver/position') return positionAnswer(state)
  if (pathname === '/api/driver/me/performance') {
    if (state.who.role !== 'Driver') return { status: 403, body: { error: 'Forbidden' } }
    if (state.perf === 404) return { status: 404, body: { error: 'Not found', code: 'NOT_ELIGIBLE' } }
    if (state.perf !== 200) return { status: state.perf, body: { error: "That couldn't be read." } }
    return { status: 200, body: { view: 'no-hours-data', creditWeights: { delivery: 0.5, pickup: 0.5 }, weeks: [thisWeek, lastWeek] } }
  }
  if (pathname === '/api/driver/performance/leaderboard') return { status: 200, body: { period: 'week', view: 'full', boards: [] } }
  if (pathname === '/api/fuel/range') return { status: 200, body: { ok: false } }
  if (pathname === '/api/drivers-directory') return { status: 200, body: { headers: [], data: [] } }
  if (/^\/api\/driver\/[^/]+$/.test(pathname)) return { status: 200, body: driverPayload(state) }
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the release notices check"}')
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

// `name` says what the screen shows; the LIVE note's four come first by their number.
async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(SHOT_DIR, `${OUT_TAG}-${name}.png`)
  await page.screenshot({ path: file })
  return file
}

// ---------------------------------------------------------------- page helpers
// Every write the page sends is kept in `writes` as "METHOD path".
async function newContext(browser, size, state, writes) {
  const phone = size.viewport.width < 640
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) { offHost.add(u.host); return route.abort() }
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (req.method() === 'GET') {
      if (u.pathname === '/api/driver/me/release' && state.release === 'abort') {
        state.calls.release++
        return route.abort()
      }
      const out = answerGet(state, u)
      if (out === null) unanswered.add(u.pathname)
      if (u.pathname === '/api/driver/me/release' && state.releaseDelayMs) await new Promise((r) => setTimeout(r, state.releaseDelayMs))
      return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out ? out.body : {}) })
    }
    writes.push(`${req.method()} ${u.pathname}`)
    let body = {}
    try { body = req.postDataJSON() || {} } catch { body = {} }
    const ids = Array.isArray(body.ids) ? body.ids : []
    if (u.pathname === '/api/auth/logout') {
      state.calls.logout++
      state.session = false
    } else if (u.pathname === '/api/auth/login') {
      state.calls.login++
      state.who = ACCOUNTS[body.username] || state.who
      state.session = true
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, user: state.who, appTimeZone: 'America/New_York' }) })
    } else if (u.pathname === '/api/auth/change-password') {
      state.who = { ...state.who, mustChangePassword: false }
    } else if (u.pathname === ACK_PATH) {
      state.calls.ack++
      if (state.ackDelayMs) await new Promise((r) => setTimeout(r, state.ackDelayMs))
      if (state.ack === 'abort') return route.abort()
      if (state.ack === 'fail') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: "That couldn't be saved. Try again later.", code: 'RELEASE_UNAVAILABLE' }) })
      for (const id of ids) { state.seen.add(id); state.acknowledged.add(id) }
    } else if (u.pathname === '/api/driver/me/release/seen') {
      // As the server: /seen takes the tour offer's row alone.
      if (!ids.length || ids.some((id) => id !== APP_TOUR_ROW)) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Unknown release.', code: 'INVALID_RELEASE' }) })
      state.seen.add(APP_TOUR_ROW)
    } else if (u.pathname === '/api/driver/me/release/tour-done') {
      for (const id of ids) {
        state.tourDone.add(id)
        if (id === APP_TOUR_ROW) state.seen.add(id)
      }
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })
  return ctx
}

async function openPage(browser, size, state, writes = [], where = '/driver') {
  const ctx = await newContext(browser, size, state, writes)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}${where}`, { waitUntil: 'domcontentloaded' })
  return { ctx, page, writes }
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
const comeBackToApp = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
const openAgain = (page) => page.reload({ waitUntil: 'domcontentloaded' })
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const activeTab = (page) => text(page, '.van-tabbar-item--active .van-tabbar-item__text')
const onLogin = (page) => new URL(page.url()).pathname === '/login'
const noteUp = (page) => page.locator(testid('release-dialog')).count()
const marksOf = (writes) => writes.filter((w) => !w.includes('/api/auth/'))
const toastText = (page) => text(page, '.toast.show')
// As a thumb does on a note taller than its box: scroll it only until Show me shows at the box's bottom
// edge, so the line that comes under the buttons starts out of sight. Nothing at all where it already
// shows. Returns where the box ended up.
const reachShowMe = (page) => page.evaluate(() => {
  const box = document.querySelector('[data-testid="release-dialog"]')
  const button = box && box.querySelector('[data-testid="release-show-me"]')
  if (!button) return -1
  const below = button.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom
  if (below > 0) box.scrollTop += Math.ceil(below)
  return Math.round(box.scrollTop)
})
// Where the note's own line is, as the driver sees it, with no scroll by the test: all of it inside the
// note's box, the box inside the window, and the line itself at its centre, so nothing is over it.
const lineInView = (page) => page.evaluate(() => {
  const box = document.querySelector('[data-testid="release-dialog"]')
  const line = box && box.querySelector('[data-testid="release-when-parked"]')
  if (!line) return { inSight: false, onTop: false, at: 'no line' }
  const b = box.getBoundingClientRect()
  const r = line.getBoundingClientRect()
  const inBox = r.height > 0 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5 && r.left >= b.left - 0.5 && r.right <= b.right + 0.5
  const inWindow = b.top >= -0.5 && b.bottom <= window.innerHeight + 0.5
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return {
    inSight: inBox && inWindow,
    onTop: !!hit && (hit === line || line.contains(hit)),
    at: `line ${Math.round(r.top)}-${Math.round(r.bottom)}, box ${Math.round(b.top)}-${Math.round(b.bottom)} scrolled ${Math.round(box.scrollTop)}, window ${window.innerHeight}`,
  }
})
// The note's two buttons as the driver sees them: which is Vant's primary (the big blue one), where each
// sits and the size of its words.
const noteButtons = (page) => page.evaluate(() => {
  const box = document.querySelector('[data-testid="release-dialog"]')
  const read = (id) => {
    const el = box && box.querySelector(`[data-testid="${id}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { primary: el.classList.contains('van-button--primary'), top: Math.round(r.top), font: parseFloat(getComputedStyle(el).fontSize), background: getComputedStyle(el).backgroundColor }
  }
  return { showMe: read('release-show-me'), acknowledge: read('release-acknowledge') }
})
const bigAndSmall = (b) => !!b.showMe && !!b.acknowledge && b.showMe.primary && !b.acknowledge.primary && b.showMe.top < b.acknowledge.top && b.acknowledge.font < b.showMe.font
async function heights(page, selector) {
  const out = []
  for (const el of await page.locator(selector).all()) {
    if (await el.isVisible()) out.push(Math.round((await el.boundingBox()).height))
  }
  return out
}
const tall = (list) => list.length > 0 && list.every((h) => h >= 44)

// A read of the route has come and gone, with time for what follows it.
async function momentPassed(state, before, n = 1) {
  await until(() => state.calls.release >= before + n, 8000)
  await new Promise((r) => setTimeout(r, 1500))
}
// The truck's own read comes round: the page has had its chance to react to it.
async function nextTruckRead(state) {
  const seen = state.calls.position
  const came = await until(() => state.calls.position > seen, 35000)
  await new Promise((r) => setTimeout(r, 500))
  return came
}
async function appOpen(page) {
  return appears(page, '.van-tabbar', 15000)
}
async function signInForm(page, size, username) {
  await appears(page, 'input[autocomplete="username"]', 8000)
  await page.fill('input[autocomplete="username"]', username)
  await page.fill('#login-password', 'made-up-password')
  await press(page.locator('.submit-btn').first(), size)
}
// Through the login form, as a driver signs in: the only way the note or the offer ever opens.
async function signedIn(browser, size, options = {}, username = DRIVER.username) {
  const state = freshState({ session: false, ...options })
  const opened = await openPage(browser, size, state)
  await signInForm(opened.page, size, username)
  return { state, ...opened, shows: options.onboarding ? false : await appOpen(opened.page) }
}
// Their own Logout, then the form again, on the same page.
async function signOutAndBackIn(page, size, state, username = DRIVER.username) {
  const logouts = state.calls.logout
  await press(page.locator('.header-btn.danger').first(), size)
  await until(() => state.calls.logout === logouts + 1, 8000)
  await signInForm(page, size, username)
  return appOpen(page)
}
// I acknowledge, and the note gone once the answer is in.
async function acknowledge(page, size) {
  await press(page.locator(testid('release-acknowledge')).first(), size)
  return gone(page, testid('release-dialog'), 8000)
}
async function walkTour(page, size, titles) {
  const seen = []
  for (let i = 0; i < titles.length; i++) {
    await appears(page, testid('tour-card'), 5000)
    await page.waitForTimeout(200)
    seen.push({
      label: await text(page, testid('tour-label')), title: await text(page, testid('tour-title')), tab: await activeTab(page), loadPage: await page.locator('.load-detail').count(),
      skip: await page.locator(testid('tour-skip')).count(), next: await text(page, testid('tour-next')),
    })
    if (i < titles.length - 1) await press(page.locator(testid('tour-next')).first(), size)
  }
  return seen
}

// ---------------------------------------------------------------- S: an open page, then a sign-in
async function nextSignInRun(browser, size) {
  const t = size.tag
  const state = freshState({ hasNote: true, status: 'Delivered' })
  const { ctx, page, writes } = await openPage(browser, size, state)
  try {
    const opened = await appOpen(page)
    await momentPassed(state, 0)
    await comeBackToApp(page)
    await page.waitForTimeout(1500)
    await press(page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
    await page.waitForTimeout(500)
    await press(page.locator('.van-tabbar-item', { hasText: 'Loads' }).first(), size)
    await page.waitForTimeout(1500)
    const readsOnThePage = state.calls.release
    await openAgain(page)
    await appOpen(page)
    await momentPassed(state, readsOnThePage)
    const note = await noteUp(page)
    record(`S1-${t}`, 'A page already open, with a note the server would give: nobody signed out, and nothing new at app open, on coming back, on a tap or on a reload',
      'no logout; in the app; no note; no writes; one read for each load and none in between',
      `app ${opened}, logouts ${state.calls.logout}, url ${new URL(page.url()).pathname}, note ${note}, writes ${JSON.stringify(writes)}, reads on the page ${readsOnThePage}, after the reload ${state.calls.release}`,
      opened && state.calls.logout === 0 && !onLogin(page) && note === 0 && writes.length === 0 && readsOnThePage === 1 && state.calls.release === 2,
      await shot(page, `row-S1-open-page-nothing-new-${t}`))

    await press(page.locator('.header-btn.danger').first(), size)
    const left = await until(() => state.calls.logout === 1, 8000)
    await appears(page, '.submit-btn', 8000)
    await page.waitForTimeout(500)
    const pageText = squeeze(await page.locator('body').innerText())
    record(`S2-${t}`, 'A logout they ask for works as ever, and the login page says nothing about an update',
      'one logout; /login; no words about the app being updated',
      `logouts ${state.calls.logout}, url ${new URL(page.url()).pathname}, mentions an update ${/updated|sign in again/i.test(pageText)}`,
      left && state.calls.logout === 1 && onLogin(page) && !/updated|sign in again/i.test(pageText))

    await signInForm(page, size, DRIVER.username)
    const back = await appOpen(page)
    const shows = await appears(page, testid('release-dialog'), 10000)
    const heading = await text(page, testid('release-heading'))
    const title = await text(page, testid('release-entry-title'))
    const lines = await allText(page.locator(testid('release-line')))
    const ackLine = await text(page, testid('release-acknowledge-line'))
    const buttonWords = [await text(page, testid('release-show-me')), await text(page, testid('release-acknowledge'))]
    const buttons = await heights(page, `${testid('release-show-me')}, ${testid('release-acknowledge')}`)
    const looks = await noteButtons(page)
    const fits = await noSideScroll(page)
    const noGotIt = await page.locator('[data-testid="release-got-it"]').count() === 0
    record(`S3-${t}`, "They sign in as usual and read What's new, the list's own words: Show me the big blue button, and I acknowledge the smaller one under it",
      `"${WORDS.notesHeading}"; "${LATEST.title}" first; lines ${JSON.stringify(ALL_LINES)}; no digit anywhere; the line "${WORDS.acknowledgeLine}"; "${WORDS.showMe}" primary on top, "${WORDS.acknowledge}" under it, not primary, in smaller words; both 44 px or more; no Got it; no side scroll; still the one logout they asked for`,
      `app ${back}, heading "${heading}", title "${title}", lines ${JSON.stringify(lines)}, line "${ackLine}", buttons ${JSON.stringify(buttonWords)}, looks ${JSON.stringify(looks)}, heights ${JSON.stringify(buttons)}, no Got it ${noGotIt}, fits ${fits}, logouts ${state.calls.logout}`,
      back && shows && heading === WORDS.notesHeading && title === LATEST.title && sameList(lines, ALL_LINES) && !/\d/.test(lines.join(' ')) && ackLine === WORDS.acknowledgeLine
        && sameList(buttonWords, [WORDS.showMe, WORDS.acknowledge]) && bigAndSmall(looks) && tall(buttons) && buttons.length === 2 && noGotIt && fits && state.calls.logout === 1,
      await shot(page, `live-1-whats-new-note-${t}`))

    const writesBefore = writes.length
    await press(page.locator(testid('release-show-me')).first(), size)
    const walked = await walkTour(page, size, RELEASE_STEP_TITLES)
    const cardHeights = await heights(page, testid('tour-next'))
    const cardFits = await noSideScroll(page)
    const cardShot = await shot(page, `row-S4-show-me-tour-last-step-${t}`)
    const midWrites = writes.slice(writesBefore)
    const last = walked[walked.length - 1] || {}
    record(`S4-${t}`, "Show me walks the release's steps on the real tabs, with no Skip, to a last step that ends in I acknowledge",
      `titles ${JSON.stringify(RELEASE_STEP_TITLES)}, "Step n of ${RELEASE_STEP_TITLES.length}"; the ${PERFORMANCE_TITLE} step on its own tab; no Skip on any step; "${WORDS.tourNext}" until the last, then "${WORDS.acknowledge}"; 44 px or more; nothing written along the way; still the one logout`,
      `walked ${JSON.stringify(walked)}, heights ${JSON.stringify(cardHeights)}, fits ${cardFits}, writes along the way ${JSON.stringify(midWrites)}, logouts ${state.calls.logout}`,
      sameList(walked.map((s) => s.title), RELEASE_STEP_TITLES) && walked.every((s, i) => s.label === `Step ${i + 1} of ${RELEASE_STEP_TITLES.length}`) && walked.every((s) => s.skip === 0)
        && walked.slice(0, -1).every((s) => s.next === WORDS.tourNext) && last.next === WORDS.acknowledge
        && (walked.find((s) => s.title === PERFORMANCE_TITLE) || {}).tab === PERFORMANCE_TITLE && tall(cardHeights) && cardFits && midWrites.length === 0 && state.calls.logout === 1,
      cardShot)

    // The answer is held back a moment, so the screen shows the last step's I acknowledge at work.
    state.ackDelayMs = 2500
    await press(page.locator(testid('tour-next')).first(), size)
    await page.waitForTimeout(500)
    const disabled = await page.locator(testid('tour-next')).first().isDisabled().catch(() => false)
    const busy = await page.locator(testid('tour-next')).first().getAttribute('aria-busy').catch(() => null)
    const workingShot = await shot(page, `live-2-acknowledge-saving-${t}`)
    await page.locator(testid('tour-next')).first().click({ force: true, timeout: 1000 }).catch(() => {})
    const cardGone = await gone(page, testid('tour-card'), 8000)
    const closed = await gone(page, testid('release-dialog'), 8000)
    state.ackDelayMs = 0
    const tabAfter = await activeTab(page)
    record(`S5-${t}`, "The tour's I acknowledge shows it is working, takes one tap, and closes the tour and the note once it is saved",
      'the button not tappable and busy while it saves; one confirmation sent, for the entries the note showed; the tour and the note gone after; back on Loads',
      `disabled ${disabled}, busy ${busy}, confirmations ${state.calls.ack}, confirmed ${JSON.stringify([...state.acknowledged].sort())}, card gone ${cardGone}, closed ${closed}, tab "${tabAfter}"`,
      disabled && busy === 'true' && state.calls.ack === 1 && sameList([...state.acknowledged].sort(), ENTRY_IDS) && cardGone && closed && tabAfter === 'Loads',
      workingShot)

    const before = state.calls.release
    await openAgain(page)
    await appOpen(page)
    await momentPassed(state, before)
    const again = await noteUp(page)
    record(`S6-${t}`, 'A reload later in that session shows nothing new, and nothing else was written',
      'no note; the only writes besides signing out and in are the confirmation, then the tour mark; still the one logout they asked for',
      `note ${again}, writes ${JSON.stringify(marksOf(writes))}, logouts ${state.calls.logout}`,
      again === 0 && sameList(marksOf(writes), [`POST ${ACK_PATH}`, 'POST /api/driver/me/release/tour-done']) && state.calls.logout === 1)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- T: a load In Transit
async function inTransitRun(browser, size) {
  const t = size.tag
  const state = freshState({ hasNote: true, status: 'In Transit' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    await momentPassed(state, 0)
    const cardShown = await appears(page, '.load-card', 8000)
    const openShot = await shot(page, `row-T1-in-transit-left-alone-${t}`)
    await comeBackToApp(page)
    await page.waitForTimeout(1500)
    await press(page.locator('.load-card').first(), size)
    await appears(page, '.load-detail', 8000)
    const stepper = await appears(page, '.status-stepper-wrapper', 8000)
    await press(page.locator('.detail-topbar .van-button').first(), size)
    await page.waitForTimeout(1500)
    await press(page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
    await page.waitForTimeout(500)
    await press(page.locator('.van-tabbar-item', { hasText: 'Loads' }).first(), size)
    await page.waitForTimeout(1500)
    const stillThere = await page.locator('.load-card').count()
    const note = await noteUp(page)
    record(`T1-${t}`, 'A driver with a load In Transit on a page already open: nothing happens to them',
      "no logout at app open, on coming back, on leaving a load's page or on coming back to the Loads tab; the load on screen; no note; one read",
      `logouts ${state.calls.logout}, on the app ${!onLogin(page)}, load cards ${stillThere}, card at open ${cardShown}, stepper ${stepper}, note ${note}, reads ${state.calls.release}`,
      state.calls.logout === 0 && !onLogin(page) && cardShown && stepper && stillThere === 1 && note === 0 && state.calls.release === 1,
      openShot)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- N: the note stays, and a save that fails
async function stayAndNotSavedRun(browser, size) {
  const t = size.tag
  const { state, ctx, page, writes } = await signedIn(browser, size, { hasNote: true, status: 'In Transit', ack: 'fail' })
  try {
    const shown = await appears(page, testid('release-dialog'), 10000)
    await page.mouse.click(6, 6)
    await page.waitForTimeout(400)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    const stays = await noteUp(page)
    record(`N1-${t}`, 'The note stays until I acknowledge: a tap outside it and Escape do nothing', 'the note still up; nothing written; no logout',
      `shown ${shown}, still up ${stays}, writes ${JSON.stringify(marksOf(writes))}, logouts ${state.calls.logout}`, shown && stays === 1 && marksOf(writes).length === 0 && state.calls.logout === 0)

    const closed = await acknowledge(page, size)
    const line = await appears(page, '.toast.show.error', 3000) ? await toastText(page) : ''
    const lineShot = await shot(page, `live-3-could-not-save-${t}`)
    const loads = await page.locator('.load-card').count()
    record(`N2-${t}`, "A confirmation that can't be saved: the note closes with the line, and they're in their loads",
      `the note gone; "${WORDS.notSaved}"; the load on screen; one confirmation tried and nothing else written; no logout`,
      `closed ${closed}, line "${line}", load cards ${loads}, writes ${JSON.stringify(marksOf(writes))}, logouts ${state.calls.logout}`,
      closed && line === WORDS.notSaved && loads === 1 && sameList(marksOf(writes), [`POST ${ACK_PATH}`]) && state.calls.logout === 0,
      lineShot)

    state.ack = 'ok'
    const back = await signOutAndBackIn(page, size, state)
    const asked = await appears(page, testid('release-dialog'), 10000)
    record(`N3-${t}`, 'The next sign-in asks again, as the line says', 'the note at the next sign-in; the one logout they asked for',
      `app ${back}, note ${asked}, logouts ${state.calls.logout}`, back && asked && state.calls.logout === 1)
  } finally {
    await ctx.close()
  }
  if (size === PHONE) {
    const noSignal = await signedIn(browser, size, { hasNote: true, status: 'Delivered', ack: 'abort' })
    try {
      await appears(noSignal.page, testid('release-dialog'), 10000)
      const closed = await acknowledge(noSignal.page, size)
      const line = await appears(noSignal.page, '.toast.show.error', 3000) ? await toastText(noSignal.page) : ''
      record(`N4-${t}`, 'No signal at I acknowledge: the same, never kept from their loads', `the note gone; "${WORDS.notSaved}"; no logout`,
        `closed ${closed}, line "${line}", logouts ${noSignal.state.calls.logout}`, closed && line === WORDS.notSaved && noSignal.state.calls.logout === 0)
    } finally {
      await noSignal.ctx.close()
    }
  }
}

// ---------------------------------------------------------------- U: not answered, then skipped
async function unansweredRun(browser, size) {
  const t = size.tag
  const { state, ctx, page, writes } = await signedIn(browser, size, { hasNote: true, status: 'In Transit' })
  try {
    const first = await appears(page, testid('release-dialog'), 10000)
    const before = state.calls.release
    await openAgain(page)
    await appOpen(page)
    await momentPassed(state, before)
    const afterReload = await noteUp(page)
    const marksThen = marksOf(writes).length
    const back = await signOutAndBackIn(page, size, state)
    const second = await appears(page, testid('release-dialog'), 10000)
    record(`U1-${t}`, "A note left unanswered: a reload shows nothing, and the next sign-in brings it back. A working load doesn't stop it",
      'the note at sign-in, with a load In Transit; none after the reload; no mark; the note at the next sign-in; the one logout they asked for',
      `first ${first}, after the reload ${afterReload}, marks ${marksThen}, app ${back}, next sign-in ${second}, logouts ${state.calls.logout}`,
      first && afterReload === 0 && marksThen === 0 && back && second && state.calls.logout === 1)

    await acknowledge(page, size)
    const readsBefore = state.calls.release
    await signOutAndBackIn(page, size, state)
    await momentPassed(state, readsBefore)
    const third = await noteUp(page)
    record(`U2-${t}`, "Confirmed: it doesn't come again", 'no note at the next sign-in', `note ${third}, confirmed ${JSON.stringify([...state.acknowledged].sort())}, logouts ${state.calls.logout}`,
      third === 0 && sameList([...state.acknowledged].sort(), ENTRY_IDS) && state.calls.logout === 2)
  } finally {
    await ctx.close()
  }

  const mid = await signedIn(browser, size, { hasNote: true, status: 'Delivered' })
  try {
    await appears(mid.page, testid('release-show-me'), 10000)
    await press(mid.page.locator(testid('release-show-me')).first(), size)
    const opened = await appears(mid.page, testid('tour-card'), 5000)
    await press(mid.page.locator(testid('tour-next')).first(), size)
    await mid.page.waitForTimeout(300)
    const skips = await mid.page.locator(testid('tour-skip')).count()
    await mid.page.keyboard.press('Escape')
    await mid.page.waitForTimeout(500)
    const stillUp = await mid.page.locator(testid('tour-card')).count()
    const label = await text(mid.page, testid('tour-label'))
    const marksMid = marksOf(mid.writes).length
    // They leave the app mid-tour: the page opens again, and the next sign-in has the note, unanswered.
    const before = mid.state.calls.release
    await openAgain(mid.page)
    await appOpen(mid.page)
    await momentPassed(mid.state, before)
    const onReload = await noteUp(mid.page)
    const back = await signOutAndBackIn(mid.page, size, mid.state)
    const next = await appears(mid.page, testid('release-dialog'), 10000)
    record(`U3-${t}`, 'The release tour has no Skip, and Escape does nothing; left mid-tour, the note is unanswered and comes back at the next sign-in',
      'no Skip on the step; the card still up on step 2 after Escape; nothing written; no note on the page opened again; the note at the next sign-in; the one logout they asked for',
      `opened ${opened}, skips ${skips}, still up ${stillUp} "${label}", writes mid-tour ${marksMid}, on the page opened again ${onReload}, app ${back}, next sign-in ${next}, confirmed ${mid.state.acknowledged.size}, logouts ${mid.state.calls.logout}`,
      opened && skips === 0 && stillUp === 1 && label === `Step 2 of ${RELEASE_STEP_TITLES.length}` && marksMid === 0 && onReload === 0 && back && next && mid.state.acknowledged.size === 0 && mid.state.calls.logout === 1,
      await shot(mid.page, `row-U3-left-mid-tour-note-back-${t}`))
  } finally {
    await mid.ctx.close()
  }
}

// ---------------------------------------------------------------- E: a page left open past its session
async function pastItsSessionRun(browser, size) {
  const t = size.tag
  const state = freshState({ hasNote: true, status: 'Delivered' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    await momentPassed(state, 0)
    // The session's 24 hours end on the server, with this page still open.
    state.session = false
    await comeBackToApp(page)
    await page.waitForTimeout(3000)
    const note = await noteUp(page)
    const stayed = !onLogin(page)
    record(`E1-${t}`, "A page left open past its session: this feature does nothing to it, and it isn't sent to the login page", 'no logout; no note; still on the app',
      `logouts ${state.calls.logout}, note ${note}, url ${new URL(page.url()).pathname}`, state.calls.logout === 0 && note === 0 && stayed)
    await openAgain(page)
    await signInForm(page, size, DRIVER.username)
    const back = await appOpen(page)
    const shows = await appears(page, testid('release-dialog'), 10000)
    record(`E2-${t}`, "The next load finds the login page, and What's new comes after that sign-in", 'signed in; the note; no logout call anywhere',
      `app ${back}, note ${shows}, logouts ${state.calls.logout}, sign-ins ${state.calls.login}`, back && shows && state.calls.logout === 0 && state.calls.login === 1)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- V: a moving truck
// V2's tap and its checks, at any size, on a note that's up as the truck reads moving. The line is the
// note's own, in sight with nothing over it: the app's short message would sit under the note's overlay.
// The test scrolls the note only to reach Show me, never to the line.
async function showMeWhileMoving(up, size, before) {
  const t = size.tag
  const reached = await reachShowMe(up.page)
  await press(up.page.locator(testid('release-show-me')).first(), size)
  const lineSel = `${testid('release-dialog')} ${testid('release-when-parked')}`
  const says = await appears(up.page, lineSel, 3000)
  const lineWords = await text(up.page, lineSel)
  await up.page.waitForTimeout(200)
  const seen = await lineInView(up.page)
  const toastSays = (await toastText(up.page)) === WORDS.whenParked
  const tours = await up.page.locator(testid('tour-card')).count()
  const stillUp = await noteUp(up.page)
  const { shown, read, stays } = before
  record(`V2-${t}`, 'The note up as the truck starts moving stays up; Show me then says when inside the note, in sight without a scroll, on top, starts nothing, and the note stays',
    `the note through the next truck read; "${WORDS.whenParked}" as the note's own line, all of it inside the note's box and the box in the window, the element at its centre; not in the message under the note; no tour; the note still up; nothing written; no logout`,
    `shown ${shown}, read ${read}, stays ${stays}, box at ${reached} to reach Show me, line ${says} "${lineWords}", in sight ${seen.inSight} (${seen.at}), on top ${seen.onTop}, in the message under it ${toastSays}, tours ${tours}, still up ${stillUp}, writes ${JSON.stringify(marksOf(up.writes))}, logouts ${up.state.calls.logout}`,
    shown && read && stays === 1 && reached >= 0 && says && lineWords === WORDS.whenParked && seen.inSight && seen.onTop && !toastSays && tours === 0 && stillUp === 1 && marksOf(up.writes).length === 0 && up.state.calls.logout === 0,
    await shot(up.page, `row-V2-when-parked-${t}`))
}

// V2 alone on a short phone, where the note fills its box and the line comes under the box's fold.
async function shortPhoneRun(browser, size) {
  const up = await signedIn(browser, size, { hasNote: true })
  try {
    const shown = await appears(up.page, testid('release-dialog'), 10000)
    up.state.moving = true
    const read = await nextTruckRead(up.state)
    const stays = await noteUp(up.page)
    await showMeWhileMoving(up, size, { shown, read, stays })
  } finally {
    await up.ctx.close()
  }
}

async function movingRun(browser, size) {
  const t = size.tag
  const open = freshState({ hasNote: true, moving: true })
  const first = await openPage(browser, size, open)
  try {
    await appOpen(first.page)
    await nextTruckRead(open)
    const whileMoving = await noteUp(first.page)
    open.moving = false
    const read = await nextTruckRead(open)
    const parked = await noteUp(first.page)
    record(`V1-${t}`, "A moving truck's open page never changes: nothing opens as it stops", 'no note moving; none parked, after the next truck read; one read of the release; no logout',
      `moving ${whileMoving}, read ${read}, parked ${parked}, reads ${open.calls.release}, logouts ${open.calls.logout}`, whileMoving === 0 && read && parked === 0 && open.calls.release === 1 && open.calls.logout === 0)
  } finally {
    await first.ctx.close()
  }

  const upMoving = await signedIn(browser, size, { hasNote: true })
  try {
    const shown = await appears(upMoving.page, testid('release-dialog'), 10000)
    upMoving.state.moving = true
    const read = await nextTruckRead(upMoving.state)
    const stays = await noteUp(upMoving.page)
    await showMeWhileMoving(upMoving, size, { shown, read, stays })

    const confirmed = await acknowledge(upMoving.page, size)
    upMoving.state.moving = false
    await nextTruckRead(upMoving.state)
    await press(upMoving.page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
    await appears(upMoving.page, testid('tour-kit-start'), 5000)
    await press(upMoving.page.locator(testid('tour-kit-start')).first(), size)
    const started = await appears(upMoving.page, testid('tour-card'), 5000)
    upMoving.state.moving = true
    const read2 = await nextTruckRead(upMoving.state)
    const tourUp = await upMoving.page.locator(testid('tour-card')).count()
    await press(upMoving.page.locator(testid('tour-next')).first(), size)
    await upMoving.page.waitForTimeout(300)
    const label = await text(upMoving.page, testid('tour-label'))
    await press(upMoving.page.locator(testid('tour-skip')).first(), size)
    await upMoving.page.waitForTimeout(500)
    const tab = await activeTab(upMoving.page)
    const tourMarks = upMoving.writes.filter((w) => w.includes('tour-done'))
    record(`V3-${t}`, "The note's own, smaller I acknowledge works on a moving truck, its one way to answer; a tour under way stays up as the truck starts moving, until they end it", `the note confirmed while moving; the Kit's tour starts parked; the card stays through the next truck read; Next works; the app tour's Skip goes back to Kit; no tour mark; no logout`,
      `confirmed ${confirmed}, started ${started}, read ${read2}, tour up ${tourUp}, label "${label}", tab "${tab}", tour marks ${tourMarks.length}, logouts ${upMoving.state.calls.logout}`,
      confirmed && started && read2 && tourUp === 1 && label === `Step 2 of ${ALL_STEP_TITLES.length}` && tab === 'Kit' && tourMarks.length === 0 && upMoving.state.calls.logout === 0)

    await press(upMoving.page.locator(testid('tour-kit-start')).first(), size)
    const kitSays = await appears(upMoving.page, `text=${WORDS.whenParked}`, 3000)
    const kitTours = await upMoving.page.locator(testid('tour-card')).count()
    record(`V4-${t}`, "The Kit's button on a truck read as moving says when and starts nothing", `"${WORDS.whenParked}"; no tour; no logout`,
      `says ${kitSays}, tours ${kitTours}, logouts ${upMoving.state.calls.logout}`, kitSays && kitTours === 0 && upMoving.state.calls.logout === 0)
  } finally {
    await upMoving.ctx.close()
  }

  const signInMoving = await signedIn(browser, size, { hasNote: true, moving: true })
  try {
    const shown = await appears(signInMoving.page, testid('release-dialog'), 10000)
    const moved = await nextTruckRead(signInMoving.state)
    const stays = await noteUp(signInMoving.page)
    record(`V5-${t}`, 'A sign-in on a moving truck still shows the note: it follows a password they have just typed, and it is one tap', 'the note, before and after the truck read shows it moving; no logout',
      `shown ${shown}, read ${moved}, stays ${stays}, logouts ${signInMoving.state.calls.logout}`, shown && moved && stays === 1 && signInMoving.state.calls.logout === 0)
  } finally {
    await signInMoving.ctx.close()
  }

  for (const reading of ['none', 'stale', 'fail']) {
    const quiet = await signedIn(browser, size, { hasNote: true, reading })
    try {
      const shown = await appears(quiet.page, testid('release-dialog'), 10000)
      record(`V6-${reading}-${t}`, `A truck not reporting (${reading}) makes no difference at sign-in`, 'the note; no logout', `shown ${shown}, logouts ${quiet.state.calls.logout}`, shown && quiet.state.calls.logout === 0)
    } finally {
      await quiet.ctx.close()
    }
  }
}

// ---------------------------------------------------------------- F, P, L, K: what stops it
async function failedReadRun(browser, size) {
  const t = size.tag
  for (const kind of ['fail', 'abort', 'empty']) {
    const { state, ctx, page, shows } = await signedIn(browser, size, { hasNote: true, release: kind, status: 'Delivered' })
    try {
      await momentPassed(state, 0)
      const noted = await noteUp(page)
      await press(page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
      await page.waitForTimeout(500)
      const kit = await page.locator(testid('tour-kit-start')).count()
      record(`F-${kind}-${t}`, `A failed read at sign-in (${kind}): they aren't locked out or sent to sign in`,
        'in the app; no logout; no note; no Kit button',
        `app ${shows}, logouts ${state.calls.logout}, url ${new URL(page.url()).pathname}, note ${noted}, Kit button ${kit}`,
        shows && state.calls.logout === 0 && !onLogin(page) && noted === 0 && kit === 0)
      state.release = 'ok'
      const before = state.calls.release
      await openAgain(page)
      await appOpen(page)
      await momentPassed(state, before)
      const later = await noteUp(page)
      await press(page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
      const kitBack = await appears(page, testid('tour-kit-start'), 5000)
      await press(page.locator('.van-tabbar-item', { hasText: 'Loads' }).first(), size)
      const back = await signOutAndBackIn(page, size, state)
      const next = await appears(page, testid('release-dialog'), 10000)
      record(`F2-${kind}-${t}`, 'A later load has the Kit button and nothing new; the next sign-in has the note', 'no note on the reload; the Kit button; the note after the next sign-in; the one logout they asked for',
        `note ${later}, Kit button ${kitBack}, app ${back}, next sign-in ${next}, logouts ${state.calls.logout}`, later === 0 && kitBack && back && next && state.calls.logout === 1)
    } finally {
      await ctx.close()
    }
  }
}

async function performanceAnswerRun(browser, size) {
  const t = size.tag
  const first = await signedIn(browser, size, { hasNote: true, status: 'Delivered', perf: 503 })
  try {
    await momentPassed(first.state, 0)
    const held = await noteUp(first.page)
    const marks = marksOf(first.writes)
    first.state.perf = 200
    await press(first.page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
    await first.page.waitForTimeout(500)
    await press(first.page.locator('.van-tabbar-item', { hasText: 'Loads' }).first(), size)
    await first.page.waitForTimeout(2000)
    const later = await noteUp(first.page)
    const back = await signOutAndBackIn(first.page, size, first.state)
    const shown = await appears(first.page, testid('release-dialog'), 10000)
    const lines = await allText(first.page.locator(testid('release-line')))
    const wantLines = ALL_LINES
    record(`P1-${t}`, "A failed Performance answer at sign-in: no note and no mark; a good one later opens nothing; the next sign-in has the note whole",
      `no note; no mark; none once the tab's answer comes on that page; then every line at the next sign-in: ${JSON.stringify(wantLines)}; the one logout they asked for`,
      `held ${held}, marks ${marks.length}, later ${later}, app ${back}, shown ${shown}, lines ${JSON.stringify(lines)}, logouts ${first.state.calls.logout}`,
      held === 0 && marks.length === 0 && later === 0 && back && shown && sameList(lines, wantLines) && first.state.calls.logout === 1)
  } finally {
    await first.ctx.close()
  }
  const second = await signedIn(browser, size, { hasNote: true, status: 'Delivered', perf: 404 })
  try {
    const shown = await appears(second.page, testid('release-dialog'), 10000)
    const lines = await allText(second.page.locator(testid('release-line')))
    const wantLines = LINES_WITHOUT_TAB
    record(`P2-${t}`, 'A driver with no week reads only their line', `lines ${JSON.stringify(wantLines)}; no logout`, `shown ${shown}, lines ${JSON.stringify(lines)}, logouts ${second.state.calls.logout}`, shown && sameList(lines, wantLines) && second.state.calls.logout === 0)
  } finally {
    await second.ctx.close()
  }
}

async function loadPageRun(browser, size) {
  const t = size.tag
  // The answer is held back long enough for them to open a load's page first.
  const { state, ctx, page } = await signedIn(browser, size, { hasNote: true, status: 'In Transit', releaseDelayMs: 4000 })
  try {
    await appears(page, '.load-card', 8000)
    await press(page.locator('.load-card').first(), size)
    const opened = await appears(page, '.load-detail', 8000)
    await momentPassed(state, 0)
    await page.waitForTimeout(4000)
    const onPage = await noteUp(page)
    await press(page.locator('.detail-topbar .van-button').first(), size)
    await page.waitForTimeout(1500)
    const onList = await noteUp(page)
    state.releaseDelayMs = 0
    const back = await signOutAndBackIn(page, size, state)
    const next = await appears(page, testid('release-dialog'), 10000)
    record(`L-${t}`, "A load's page open as the answer lands: no note there or on the way back; the next sign-in has it", "load's page; no note on it; none back on the list; the note at the next sign-in; the one logout they asked for",
      `load's page ${opened}, note there ${onPage}, on the list ${onList}, app ${back}, next sign-in ${next}, logouts ${state.calls.logout}`, opened && onPage === 0 && onList === 0 && back && next && state.calls.logout === 1)
  } finally {
    await ctx.close()
  }
}

async function killSwitchRun(browser, size) {
  const t = size.tag
  const { state, ctx, page, writes } = await signedIn(browser, size, { hasNote: true, release: 'off', status: 'Delivered' })
  try {
    await momentPassed(state, 0)
    await press(page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
    await page.waitForTimeout(500)
    const kit = await page.locator(testid('tour-kit-card')).count()
    const note = await noteUp(page)
    const marks = marksOf(writes)
    record(`K-${t}`, 'The kill switch off: nothing new, even right after a sign-in', 'no logout; no note; no Kit card; no mark',
      `logouts ${state.calls.logout}, note ${note}, Kit card ${kit}, marks ${marks.length}`, state.calls.logout === 0 && note === 0 && kit === 0 && marks.length === 0 && !onLogin(page))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- H: a shared phone
async function sharedPhoneRun(browser, size) {
  const t = size.tag
  const state = freshState({ hasNote: true, status: 'Delivered' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    const back = await signOutAndBackIn(page, size, state, DRIVER_B.username)
    const note = await appears(page, testid('release-dialog'), 10000)
    const body = squeeze(await page.locator('body').innerText())
    const named = body.includes(DRIVER.driverName)
    const kept = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
    record(`H-${t}`, 'A shared phone: the next driver reads their own answer, and this feature keeps nothing in the browser',
      'B in the app with the note; nothing of the first driver on screen; no name kept by this; no record of a release, a confirmation or a tab; the one logout they asked for',
      `app ${back}, note ${note}, first driver named ${named}, kept by this ${/driverRelease|appPage|signIn|acknowledg/.test(kept)}, logouts ${state.calls.logout}`,
      back && note && !named && !/driverRelease|appPage|signIn|acknowledg/.test(kept) && state.calls.logout === 1)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- O: a first-time driver
async function offerRun(browser, size) {
  const t = size.tag
  const first = await signedIn(browser, size, { offer: true, unread: true })
  try {
    const shows = await appears(first.page, testid('release-take-tour'), 10000)
    const heading = await text(first.page, testid('release-heading'))
    const words = await text(first.page, testid('release-dialog'))
    const sized = await heights(first.page, `${testid('release-take-tour')}, ${testid('release-skip-offer')}`)
    const offerShot = await shot(first.page, `row-O1-first-time-offer-${t}`)
    await press(first.page.locator(testid('release-skip-offer')).first(), size)
    await until(() => first.writes.includes('POST /api/driver/me/release/seen'), 5000)
    const before = first.state.calls.release
    await openAgain(first.page)
    await appOpen(first.page)
    await momentPassed(first.state, before)
    const nagged = await noteUp(first.page)
    record(`O1-${t}`, 'A first-time driver is offered the tour; they can skip, and are not asked again',
      `"${WORDS.offerHeading}"; "${WORDS.offerText}"; "${WORDS.takeTour}" and "${WORDS.skipOffer}", 44 px or more; after a skip, not on a reload; no logout`,
      `shown ${shows}, heading "${heading}", words "${words}", heights ${JSON.stringify(sized)}, nagged ${nagged}, logouts ${first.state.calls.logout}`,
      shows && heading === WORDS.offerHeading && words.includes(WORDS.offerText) && words.includes(WORDS.takeTour) && words.includes(WORDS.skipOffer) && tall(sized) && nagged === 0 && first.state.calls.logout === 0,
      offerShot)
    await press(first.page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
    const kit = await appears(first.page, testid('tour-kit-start'), 5000)
    const kitWords = await text(first.page, testid('tour-kit-start'))
    await press(first.page.locator(testid('tour-kit-start')).first(), size)
    const fromKit = await appears(first.page, testid('tour-card'), 5000)
    const kitLabel = await text(first.page, testid('tour-label'))
    await press(first.page.locator(testid('tour-skip')).first(), size)
    await first.page.waitForTimeout(500)
    const kitTab = await activeTab(first.page)
    const kitMarks = first.writes.filter((w) => w.includes('tour-done'))
    record(`O2-${t}`, "The Kit's button runs the whole tour any time; Skip writes nothing and goes back",
      `"${WORDS.kitButton}"; "Step 1 of ${ALL_STEP_TITLES.length}"; back on Kit; no tour mark; no logout`,
      `button ${kit} "${kitWords}", card ${fromKit} "${kitLabel}", tab "${kitTab}", tour marks ${kitMarks.length}, logouts ${first.state.calls.logout}`,
      kit && kitWords === WORDS.kitButton && fromKit && kitLabel === `Step 1 of ${ALL_STEP_TITLES.length}` && kitTab === 'Kit' && kitMarks.length === 0 && first.state.calls.logout === 0)
  } finally {
    await first.ctx.close()
  }

  const second = await signedIn(browser, size, { offer: true, unread: true, status: 'In Transit' })
  try {
    await appears(second.page, testid('release-take-tour'), 10000)
    const unreadBefore = await second.page.locator('.van-tabbar .van-badge').count()
    await press(second.page.locator(testid('release-take-tour')).first(), size)
    const walked = await walkTour(second.page, size, ALL_STEP_TITLES)
    const midWrites = marksOf(second.writes)
    await press(second.page.locator(testid('tour-next')).first(), size)
    await until(() => second.writes.includes('POST /api/driver/me/release/tour-done'), 5000)
    await second.page.waitForTimeout(500)
    const unreadAfter = await second.page.locator('.van-tabbar .van-badge').count()
    const readMarks = second.writes.filter((w) => /\/read$/.test(w))
    const allWrites = marksOf(second.writes)
    const expectTabs = ['Loads', 'Loads', 'Alerts', 'Kit', 'Messages', 'Invoices', PERFORMANCE_TITLE, 'Loads']
    record(`O3-${t}`, 'Take the tour walks every screen, with a load In Transit, and marks nothing read: its only writes are its own',
      `titles ${JSON.stringify(ALL_STEP_TITLES)} on tabs ${JSON.stringify(expectTabs)}; their load's own page on that step; no message or alert marked read; the badges stay; writes: the seen mark, then the tour mark; no logout`,
      `titles ${JSON.stringify(walked.map((s) => s.title))}, tabs ${JSON.stringify(walked.map((s) => s.tab))}, badges ${unreadBefore} then ${unreadAfter}, read marks ${JSON.stringify(readMarks)}, writes before Done ${JSON.stringify(midWrites)}, all ${JSON.stringify(allWrites)}, logouts ${second.state.calls.logout}`,
      sameList(walked.map((s) => s.title), ALL_STEP_TITLES) && sameList(walked.map((s) => s.tab), expectTabs) && walked.find((s) => s.title === ALL_STEP_TITLES[1]).loadPage === 1 && walked.find((s) => s.title === ALL_STEP_TITLES[0]).loadPage === 0 && readMarks.length === 0 && unreadBefore > 0 && unreadAfter === unreadBefore
        && sameList(midWrites, ['POST /api/driver/me/release/seen']) && sameList(allWrites, ['POST /api/driver/me/release/seen', 'POST /api/driver/me/release/tour-done']) && second.state.calls.logout === 0,
      await shot(second.page, `row-O3-whole-tour-${t}`))
  } finally {
    await second.ctx.close()
  }

  // The forced change is the same page, so the sign-in's one look is still there after it.
  const state = freshState({ session: false, offer: true })
  const third = await openPage(browser, size, state)
  try {
    await signInForm(third.page, size, DRIVER_TEMP.username)
    const forced = await appears(third.page, '.cp-submit', 8000)
    await third.page.fill('input[autocomplete="current-password"]', 'made-up-password')
    await third.page.locator('input[autocomplete="new-password"]').nth(0).fill('Made-Up-Pass-2!')
    await third.page.locator('input[autocomplete="new-password"]').nth(1).fill('Made-Up-Pass-2!')
    await press(third.page.locator('.cp-submit').first(), size)
    const app = await appOpen(third.page)
    const offered = await appears(third.page, testid('release-take-tour'), 10000)
    record(`O4-${t}`, 'A first-time driver made to change a temporary password: the offer follows it, on the same page', 'the change-password page; then the app and the offer; no logout',
      `forced ${forced}, app ${app}, offer ${offered}, logouts ${state.calls.logout}, sign-ins ${state.calls.login}`, forced && app && offered && state.calls.logout === 0 && state.calls.login === 1)
  } finally {
    await third.ctx.close()
  }
}

// ---------------------------------------------------------------- A, R, B: other roles, the record, the lock screen
async function otherRoleRun(browser, size) {
  const t = size.tag
  const state = freshState({ who: ADMIN, hasNote: true, status: 'Delivered' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    await page.waitForTimeout(4500)
    await comeBackToApp(page)
    await page.waitForTimeout(1500)
    await press(page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
    await page.waitForTimeout(500)
    const kit = await page.locator(testid('tour-kit-card')).count()
    const note = await noteUp(page)
    record(`A-${t}`, 'A Super Admin on /driver: nothing of this, ever', 'the route never read; no logout; no note; no Kit card',
      `route read ${state.calls.release} times, logouts ${state.calls.logout}, note ${note}, Kit card ${kit}, url ${new URL(page.url()).pathname}`,
      state.calls.release === 0 && state.calls.logout === 0 && note === 0 && kit === 0 && !onLogin(page))
  } finally {
    await ctx.close()
  }
}

async function recordRun(browser, size) {
  const t = size.tag
  const state = freshState({ who: ADMIN })
  const { ctx, page } = await openPage(browser, size, state, [], '/drivers')
  try {
    const shown = await appears(page, testid('driver-notices'), 15000)
    const section = page.locator(testid('driver-notices')).first()
    await section.scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(300)
    const heading = await text(page, `${testid('driver-notices')} .dn-heading`)
    const title = await text(page, testid('driver-notice-title'))
    const count = await text(page, testid('driver-notice-count'))
    const rowsSeen = []
    for (const row of await page.locator(testid('driver-notice-row')).all()) rowsSeen.push([squeeze(await row.locator('.dn-name').textContent()), squeeze(await row.locator('.dn-state').textContent())])
    const fits = await noSideScroll(page)
    record(`R1-${t}`, "A Super Admin on the Drivers page sees who confirmed which notice, and when", `"${RECORD_WORDS.heading}"; "${LATEST.title}"; "2 of 4 acknowledged"; rows ${JSON.stringify(RECORD_TEXTS)}, times on the app's clock; one read; no side scroll`,
      `shown ${shown}, heading "${heading}", title "${title}", count "${count}", rows ${JSON.stringify(rowsSeen)}, reads ${state.calls.record}, fits ${fits}`,
      shown && heading === RECORD_WORDS.heading && title === LATEST.title && count === '2 of 4 acknowledged' && sameList(rowsSeen, RECORD_TEXTS) && state.calls.record === 1 && fits,
      await shot(page, `live-4-admin-driver-notices-${t}`))
  } finally {
    await ctx.close()
  }
  if (size !== DESKTOP) return
  for (const [kind, want] of [['off', 0], ['fail', 1]]) {
    const other = freshState({ who: ADMIN, record: kind })
    const opened = await openPage(browser, size, other, [], '/drivers')
    try {
      await appears(opened.page, '.page-header', 15000)
      await until(() => other.calls.record > 0, 8000)
      await opened.page.waitForTimeout(1000)
      const sections = await opened.page.locator(testid('driver-notices')).count()
      const line = await text(opened.page, testid('driver-notices-unreadable'))
      record(`R2-${kind}-${t}`, kind === 'off' ? 'The switch off: no "Driver notices" on the Drivers page' : "A record that can't be read says so",
        kind === 'off' ? 'no section' : `the section with "${RECORD_WORDS.unreadable}" and no rows`,
        `sections ${sections}, line "${line}", rows ${await opened.page.locator(testid('driver-notice-row')).count()}`,
        sections === want && (kind === 'off' || (line === RECORD_WORDS.unreadable && await opened.page.locator(testid('driver-notice-row')).count() === 0)))
    } finally {
      await opened.ctx.close()
    }
  }
  const driver = freshState({ hasNote: true, status: 'Delivered' })
  const turned = await openPage(browser, size, driver, [], '/drivers')
  try {
    await appOpen(turned.page)
    await turned.page.waitForTimeout(1500)
    record(`R3-${t}`, 'A Driver who opens the Drivers page is sent to their own app, and the record is never read', 'the driver app; no record read; no section',
      `url ${new URL(turned.page.url()).pathname}, record reads ${driver.calls.record}, sections ${await turned.page.locator(testid('driver-notices')).count()}`,
      new URL(turned.page.url()).pathname === '/driver' && driver.calls.record === 0 && await turned.page.locator(testid('driver-notices')).count() === 0)
  } finally {
    await turned.ctx.close()
  }
}

async function lockScreenRun(browser, size) {
  const t = size.tag
  const { state, ctx, page } = await signedIn(browser, size, { hasNote: true, status: 'Delivered', onboarding: 'documents_pending' })
  try {
    const locked = await appears(page, '.onboarding-locked', 15000)
    await momentPassed(state, 0)
    const note = await noteUp(page)
    record(`B1-${t}`, 'A sign-in that lands on the lock screen: nothing shown', 'the lock screen; no logout; no note',
      `locked ${locked}, logouts ${state.calls.logout}, note ${note}`, locked && state.calls.logout === 0 && note === 0)
    // The office lifts the lock, and the page's own refetch finds it.
    state.onboarding = 'fully_onboarded'
    await comeBackToApp(page)
    const lifted = await appOpen(page)
    await page.waitForTimeout(2500)
    const afterLift = await noteUp(page)
    const back = await signOutAndBackIn(page, size, state)
    const next = await appears(page, testid('release-dialog'), 10000)
    record(`B2-${t}`, 'The lock lifting on that page opens nothing; the next sign-in has the note', 'the app; no note; the note at the next sign-in; the one logout they asked for',
      `lifted ${lifted}, note ${afterLift}, app ${back}, next sign-in ${next}, logouts ${state.calls.logout}`, lifted && afterLift === 0 && back && next && state.calls.logout === 1)
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
  console.log(`driver-release-notices: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const size of [PHONE, DESKTOP]) {
      await nextSignInRun(browser, size)
      await inTransitRun(browser, size)
      await stayAndNotSavedRun(browser, size)
      await recordRun(browser, size)
    }
    await unansweredRun(browser, PHONE)
    await pastItsSessionRun(browser, PHONE)
    await movingRun(browser, PHONE)
    for (const size of [SHORT, SMALLEST]) await shortPhoneRun(browser, size)
    await failedReadRun(browser, PHONE)
    await performanceAnswerRun(browser, PHONE)
    await loadPageRun(browser, PHONE)
    await killSwitchRun(browser, PHONE)
    await sharedPhoneRun(browser, PHONE)
    await offerRun(browser, PHONE)
    await otherRoleRun(browser, DESKTOP)
    await lockScreenRun(browser, PHONE)
  } finally {
    await browser.close()
    server.close()
  }

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    `# Driver release notices check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Browser requests to another host, aborted (not part of the verdict): ${[...offHost].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, out, { mode: 0o600 })
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`driver-release-notices: ${passed}/${rows.length} PASS, ${rows.length - passed} FAIL; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  if (pageErrors.length) console.log(`driver-release-notices: page errors: ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`driver-release-notices: aborted: ${e.stack || e}`)
  process.exit(1)
})
