#!/usr/bin/env node
// LogisX — new-feature notices for drivers: the sign-out after a release, "What's new" and the tour,
// on made-up data only.
//
// As a made-up Driver ("Casey Example"), at 390x844 and 1280x800:
//   S   due, nothing going on: signed out at app open; the login page says why; he signs in; the note
//       shows the list's own words; Show me walks the release's steps on the real tabs; Done; it
//       doesn't come back. Only the two marks are written. 44 px or more, no sideways scroll. A logout
//       he asks for afterwards shows no line
//   T   THE IN TRANSIT PROOF: due, with a load In Transit: not signed out at app open, on coming back
//       to the app, or on moving between the list, a load's page and another tab; the load is still
//       on screen. Once the same load reads Delivered, the next open signs him out, so the hold was
//       the load and not something else
//   M1  a status tap in flight: the server has written Delivered and hasn't answered; he goes back to
//       the list: not signed out while it's on the wire or for the quiet time after, then he is
//   M2  a POD upload in flight: the same, for a load already delivered
// And at 390x844:
//   E   an empty load list holds: no loads at all, and a reply whose body dropped while he hauls a load
//   V   a moving truck holds the sign-out and the note, and parking lets them through at the next
//       moment; a tour under way closes by itself when the truck starts moving and marks nothing done;
//       no reading, a stale reading and a failed read hold the sign-out too, and not the note; a truck
//       moving on a feed that sends no speed holds it, even after an earlier read of parked
//   F   a failed read of the release state (503, no answer, an unreadable body): no sign-out, no note,
//       no Kit button, and he stays in the app; a good answer later works
//   P   the note waits for the Performance answer: a failed probe holds it, a good one lets it through
//       whole; a driver with no week reads only his line
//   K   the kill switch off (404 FEATURE_OFF): nothing new anywhere, and no sign-out
//   N   no signal: not signed out; signal back and the next moment does it
//   U   a sign-out the server doesn't confirm: the app's own login form with its line; he signs in; a
//       logout he asks for afterwards shows no line
//   L   a server that keeps saying "due" after he signs back in: one sign-out, no loop
//   C   two tabs hold each other: neither signs out; with one left the other does; a logout he asks for
//       in one tab still takes the other along; a browser that can't keep a tab's record holds; so does
//       a tab frozen by the browser, and a tab that died without saying so (its record planted), for
//       up to a day; a record over a day old doesn't, and is tidied away
//   H   a shared phone: the next driver signs in, reads his own answer, and the login line is gone
//   O   a first-time driver: the offer, Skip for now, no nagging; Take the tour walks every tab; the
//       tour marks no message or alert read and writes only its own marks; the Kit's button runs it
// And:
//   A   a made-up Super Admin on /driver at 1280x800: the route is never read, no sign-out, no button
//   B   a driver on the onboarding lock screen: the route is never read, no sign-out
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
// absolute folder outside the checkout; default ~/LogisX-replica/screens/driver-release-notices).
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

const require = createRequire(import.meta.url)
const { RELEASES, APP_TOUR_ROW, latestReleaseId, unseenReleases } = require('../../lib/driver-releases.js')

const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'driver-release-notices').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.homedir(), 'LogisX-replica', 'screens', 'driver-release-notices')
const PHONE = { tag: '390x844', viewport: { width: 390, height: 844 } }
const DESKTOP = { tag: '1280x800', viewport: { width: 1280, height: 800 } }
// Past the app's WRITE_QUIET_MS: how long after a write a sign-out still waits.
const QUIET_WAIT_MS = 5500

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
const ACCOUNTS = { [DRIVER.username]: DRIVER, [DRIVER_B.username]: DRIVER_B }
const RELEASE = latestReleaseId(RELEASES)
const ENTRIES = unseenReleases([], RELEASES)
const LATEST = ENTRIES[0]
const DAY = 24 * 60 * 60 * 1000
const LOAD_HEADERS = ['Load ID', 'Driver', 'Job Status', 'Pickup Appointment', 'Drop-off Appointment']
const ALL_STEP_TITLES = TOUR_STEPS.map((s) => s.title)
const RELEASE_STEP_TITLES = LATEST.tour.map((id) => TOUR_STEPS.find((s) => s.id === id).title)

const thisWeek = { id: 'this-week', start: '2026-10-31', end: '2026-11-06', credits: { value: 1, target: 7.5, required: 6, deliveries: 1, pickups: 1 }, left: 6.5, percent: 13, pace: 'on-track', newWeekNote: false, nextWeekStarts: 'Nov 7', targetLowered: false, loads: [] }
const lastWeek = { id: 'last-week', start: '2026-10-24', end: '2026-10-30', credits: { value: 7.5, target: 7.5, required: 6, deliveries: 8, pickups: 7 }, left: null, percent: 100, pace: null, newWeekNote: false, nextWeekStarts: null, targetLowered: false, loads: [] }

// One browser's view of the server. `release` says how the route answers: 'ok', 'off', 'fail' or
// 'empty'. `reading` how the truck's does: 'fix', 'none', 'stale', 'fail', or 'moving-no-speed' for what
// the route sends a truck whose feed sends no speed and whose fixes moved apart. `payload` his loads':
// 'ok', or 'dropped' for headers whose body never arrives whole. `perf` his week's: a status.
function freshState({ who = DRIVER, session = true, due = false, dueAfterLogin = false, status = '', offer = false, hasNote = false, release = 'ok', moving = false, onboarding = 'fully_onboarded', unread = false, reading = 'fix', payload = 'ok', perf = 200, logoutFails = false } = {}) {
  return {
    who, session, due, dueAfterLogin, status, offer, hasNote, release, moving, onboarding, unread, reading, payload, perf, logoutFails,
    seen: new Set(), tourDone: new Set(),
    calls: { release: 0, logout: 0, login: 0, position: 0 },
    holds: {},
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
  if (state.due) return { status: 200, body: { signInDue: true, releaseId: RELEASE, notes: [], tourOffered: false } }
  return {
    status: 200,
    body: {
      signInDue: false,
      releaseId: RELEASE,
      notes: state.hasNote && !state.seen.has(RELEASE) ? ENTRIES : [],
      tourOffered: state.offer && !state.seen.has(APP_TOUR_ROW),
    },
  }
}

function positionAnswer(state) {
  state.calls.position++
  if (state.reading === 'fail') return { status: 503, body: { error: "That couldn't be read." } }
  if (state.reading === 'none') return { status: 200, body: { ok: true, position: null, reason: 'no_recent_fix' } }
  const age = state.reading === 'stale' ? 10 * 60 * 1000 : 5000
  const stamp = new Date(Date.now() - age).toISOString()
  const fix = { latitude: 29.7, longitude: -95.3, heading: 90, source: 'routemate', lastPingAge: age, timestamp: stamp }
  if (state.moving) return { status: 200, body: { ok: true, position: { ...fix, speed: 25 } } }
  if (state.reading === 'moving-no-speed') return { status: 200, body: { ok: true, position: { ...fix, speed: 0, stoppedSinceMs: null } } }
  return { status: 200, body: { ok: true, position: { ...fix, speed: 0, stoppedSinceMs: Date.now() - 10 * 60 * 1000 } } }
}

function answerGet(state, u) {
  const pathname = u.pathname
  if (pathname === '/api/auth/session') return { status: 200, body: state.session ? { authenticated: true, user: state.who, appTimeZone: 'America/New_York' } : { authenticated: false, appTimeZone: 'America/New_York' } }
  if (pathname === '/api/auth/setup-check') return { status: 200, body: { needsSetup: false } }
  if (pathname === '/api/driver/me/release') return releaseAnswer(state)
  if (pathname === '/api/driver/position') return positionAnswer(state)
  if (pathname === '/api/driver/me/performance') {
    if (state.who.role !== 'Driver') return { status: 403, body: { error: 'Forbidden' } }
    if (state.perf === 404) return { status: 404, body: { error: 'Not found', code: 'NOT_ELIGIBLE' } }
    if (state.perf !== 200) return { status: state.perf, body: { error: "That couldn't be read." } }
    return { status: 200, body: { view: 'no-hours-data', creditWeights: { delivery: 0.5, pickup: 0.5 }, invoicePaysDays: true, weeks: [thisWeek, lastWeek] } }
  }
  if (pathname === '/api/driver/performance/leaderboard') return { status: 200, body: { period: 'week', view: 'full', boards: [] } }
  if (pathname === '/api/fuel/range') return { status: 200, body: { ok: false } }
  if (/^\/api\/driver\/[^/]+$/.test(pathname)) {
    if (state.payload === 'dropped') return { status: 200, raw: '{"loads":[{"_rowIndex":2,' }
    return { status: 200, body: driverPayload(state) }
  }
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
      return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: out && out.raw !== undefined ? out.raw : JSON.stringify(out ? out.body : {}) })
    }
    writes.push(`${req.method()} ${u.pathname}`)
    let body = {}
    try { body = req.postDataJSON() || {} } catch { body = {} }
    if (u.pathname === '/api/auth/logout') {
      state.calls.logout++
      if (state.logoutFails) return route.abort()
      state.session = false
    } else if (u.pathname === '/api/auth/login') {
      state.calls.login++
      state.who = ACCOUNTS[body.username] || state.who
      state.session = true
      state.due = state.dueAfterLogin
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, user: state.who, appTimeZone: 'America/New_York' }) })
    } else if (u.pathname === '/api/driver/me/release/seen') {
      for (const id of body.ids || []) state.seen.add(id)
    } else if (u.pathname === '/api/driver/me/release/tour-done') {
      for (const id of body.ids || []) state.tourDone.add(id)
    } else if (u.pathname === '/api/driver/status') {
      // The server has written it; the answer is what's held back. It reads Delivered from here on,
      // so nothing is left to hold the sign-out but the tap still on the wire.
      state.status = 'Delivered'
      if (state.holds.status) await state.holds.status.promise
    } else if (u.pathname === '/api/documents/upload') {
      if (state.holds.upload) await state.holds.upload.promise
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })
  return ctx
}
function holdOpen() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

async function openPage(browser, size, state, writes = []) {
  const ctx = await newContext(browser, size, state, writes)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}/driver`, { waitUntil: 'domcontentloaded' })
  return { ctx, page, writes }
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
const comeBackToApp = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const activeTab = (page) => text(page, '.van-tabbar-item--active .van-tabbar-item__text')
const onLogin = (page) => new URL(page.url()).pathname === '/login'
async function heights(page, selector) {
  const out = []
  for (const el of await page.locator(selector).all()) {
    if (await el.isVisible()) out.push(Math.round((await el.boundingBox()).height))
  }
  return out
}
const tall = (list) => list.length > 0 && list.every((h) => h >= 44)

// A moment has come and gone: the route was asked `n` more times, with time for what follows it.
async function momentPassed(state, before, n = 1) {
  await until(() => state.calls.release >= before + n, 8000)
  await new Promise((r) => setTimeout(r, 1500))
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
async function walkTour(page, size, titles) {
  const seen = []
  for (let i = 0; i < titles.length; i++) {
    await appears(page, testid('tour-card'), 5000)
    await page.waitForTimeout(200)
    seen.push({ label: await text(page, testid('tour-label')), title: await text(page, testid('tour-title')), tab: await activeTab(page), loadPage: await page.locator('.load-detail').count() })
    if (i < titles.length - 1) await press(page.locator(testid('tour-next')).first(), size)
  }
  return seen
}

// ---------------------------------------------------------------- S
async function signOutRun(browser, size) {
  const t = size.tag
  const state = freshState({ due: true, hasNote: true, status: 'Delivered' })
  const { ctx, page, writes } = await openPage(browser, size, state)
  try {
    const left = await until(() => state.calls.logout === 1, 15000)
    const note = await appears(page, testid('login-updated-note'), 8000)
    const noteText = await text(page, testid('login-updated-note'))
    const fitsLogin = await noSideScroll(page)
    record(`S1-${t}`, 'Due, nothing going on: signed out, and the login page says why',
      `one sign-out; /login; "${WORDS.signedOut}"; no side scroll`,
      `sign-outs ${state.calls.logout}, url ${new URL(page.url()).pathname}, note "${noteText}", fits ${fitsLogin}`,
      left && onLogin(page) && note && noteText === WORDS.signedOut && fitsLogin,
      await shot(page, `S1-${t}`))

    await signInForm(page, size, DRIVER.username)
    const back = await appOpen(page)
    const shows = await appears(page, testid('release-dialog'), 10000)
    const heading = await text(page, testid('release-heading'))
    const title = await text(page, testid('release-entry-title'))
    const lines = await allText(page.locator(testid('release-line')))
    const wantLines = LATEST.notes.map((n) => n.text)
    const buttons = await heights(page, `${testid('release-show-me')}, ${testid('release-got-it')}`)
    const fits = await noSideScroll(page)
    record(`S2-${t}`, "He signs in as usual and reads What's new, the list's own words",
      `"${WORDS.notesHeading}"; "${LATEST.title}"; lines ${JSON.stringify(wantLines)}; no digit anywhere; Show me and Got it 44 px or more; no side scroll; one sign-out still`,
      `app ${back}, heading "${heading}", title "${title}", lines ${JSON.stringify(lines)}, heights ${JSON.stringify(buttons)}, fits ${fits}, sign-outs ${state.calls.logout}`,
      back && shows && heading === WORDS.notesHeading && title === LATEST.title && sameList(lines, wantLines) && !/\d/.test(lines.join(' ')) && tall(buttons) && fits && state.calls.logout === 1,
      await shot(page, `S2-${t}`))

    const writesBefore = writes.length
    await press(page.locator(testid('release-show-me')).first(), size)
    const walked = await walkTour(page, size, RELEASE_STEP_TITLES)
    const cardHeights = await heights(page, `${testid('tour-next')}, ${testid('tour-skip')}`)
    const cardFits = await noSideScroll(page)
    const cardShot = await shot(page, `S3-${t}`)
    const midWrites = writes.slice(writesBefore)
    await press(page.locator(testid('tour-next')).first(), size)
    const closed = await until(() => writes.includes('POST /api/driver/me/release/tour-done'), 5000)
    const cardGone = await page.locator(testid('tour-card')).count() === 0
    const tabAfter = await activeTab(page)
    record(`S3-${t}`, "Show me walks the release's steps on the real tabs; Done closes it",
      `titles ${JSON.stringify(RELEASE_STEP_TITLES)}, "Step n of ${RELEASE_STEP_TITLES.length}"; the Performance step on the Performance tab; 44 px or more; only the seen mark along the way, then the tour mark; back on Loads`,
      `walked ${JSON.stringify(walked)}, heights ${JSON.stringify(cardHeights)}, fits ${cardFits}, writes along the way ${JSON.stringify(midWrites)}, tour marked ${closed}, card gone ${cardGone}, tab "${tabAfter}"`,
      sameList(walked.map((s) => s.title), RELEASE_STEP_TITLES) && walked.every((s, i) => s.label === `Step ${i + 1} of ${RELEASE_STEP_TITLES.length}`)
        && walked.find((s) => s.title === 'Performance').tab === 'Performance' && tall(cardHeights) && cardFits && sameList(midWrites, ['POST /api/driver/me/release/seen']) && closed && cardGone && tabAfter === 'Loads',
      cardShot)

    const before = state.calls.release
    await comeBackToApp(page)
    await momentPassed(state, before)
    const again = await page.locator(testid('release-dialog')).count()
    const allWrites = writes.filter((w) => !w.includes('/api/auth/'))
    record(`S4-${t}`, 'It shows once, and nothing else was written',
      `no note on the next moment; the only writes besides sign-in are the two marks; signed out once`,
      `note ${again}, writes ${JSON.stringify(allWrites)}, sign-outs ${state.calls.logout}`,
      again === 0 && sameList(allWrites, ['POST /api/driver/me/release/seen', 'POST /api/driver/me/release/tour-done']) && state.calls.logout === 1)

    await press(page.locator('.header-btn.danger').first(), size)
    const left2 = await until(() => state.calls.logout === 2, 8000)
    await appears(page, '.submit-btn', 8000)
    await page.waitForTimeout(500)
    const line = await page.locator(testid('login-updated-note')).count()
    record(`S5-${t}`, 'A logout he asks for afterwards shows no line', 'his Logout works; /login; no line about an update',
      `sign-outs ${state.calls.logout}, url ${new URL(page.url()).pathname}, line ${line}`, left2 && onLogin(page) && line === 0)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- E: an empty list holds
async function emptyListRun(browser, size) {
  const t = size.tag
  const none = freshState({ due: true })
  const first = await openPage(browser, size, none)
  try {
    await appOpen(first.page)
    await momentPassed(none, 0)
    await comeBackToApp(first.page)
    await momentPassed(none, 1)
    record(`E1-${t}`, 'Due, with no loads at all: held, since an empty list proves nothing', 'no sign-out; in the app',
      `sign-outs ${none.calls.logout}, url ${new URL(first.page.url()).pathname}`, none.calls.logout === 0 && !onLogin(first.page))
  } finally {
    await first.ctx.close()
  }
  const dropped = freshState({ status: 'In Transit' })
  const second = await openPage(browser, size, dropped)
  try {
    await appOpen(second.page)
    await appears(second.page, '.load-card', 8000)
    await momentPassed(dropped, 0)
    dropped.due = true
    dropped.payload = 'dropped'
    const before = dropped.calls.release
    await comeBackToApp(second.page)
    await momentPassed(dropped, before)
    const shotFile = await shot(second.page, `E2-${t}`)
    record(`E2-${t}`, "Hauling a load, on a weak signal: the reply about his loads drops after its headers, and he isn't signed out", 'no sign-out; in the app',
      `sign-outs ${dropped.calls.logout}, url ${new URL(second.page.url()).pathname}`, dropped.calls.logout === 0 && !onLogin(second.page), shotFile)
  } finally {
    await second.ctx.close()
  }
}

// ---------------------------------------------------------------- T: the In Transit proof
async function inTransitRun(browser, size) {
  const t = size.tag
  const state = freshState({ due: true, status: 'In Transit' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    await momentPassed(state, 0)
    await page.waitForTimeout(3500)
    const atOpen = state.calls.logout
    const onApp = !onLogin(page)
    const cardShown = await appears(page, '.load-card', 8000)
    const openShot = await shot(page, `T1-${t}`)

    let before = state.calls.release
    await comeBackToApp(page)
    await momentPassed(state, before)
    const afterBack = state.calls.logout

    await press(page.locator('.load-card').first(), size)
    await appears(page, '.load-detail', 8000)
    const stepper = await appears(page, '.status-stepper-wrapper', 8000)
    before = state.calls.release
    await press(page.locator('.detail-topbar .van-button').first(), size)
    await momentPassed(state, before)
    const afterList = state.calls.logout

    await press(page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
    await page.waitForTimeout(500)
    before = state.calls.release
    await press(page.locator('.van-tabbar-item', { hasText: 'Loads' }).first(), size)
    await momentPassed(state, before)
    const afterTab = state.calls.logout
    const stillThere = await page.locator('.load-card').count()
    const noNote = await page.locator(testid('release-dialog')).count()
    record(`T1-${t}`, 'THE IN TRANSIT PROOF: a driver with a load In Transit is not signed out',
      'no sign-out at app open, on coming back to the app, on leaving a load page or on coming back to the Loads tab; still in the app, the load on screen; no note while he is behind',
      `sign-outs ${atOpen}, ${afterBack}, ${afterList}, ${afterTab}; on the app ${onApp} then ${!onLogin(page)}; load cards ${stillThere}; stepper ${stepper}; note ${noNote}; route read ${state.calls.release} times`,
      atOpen === 0 && afterBack === 0 && afterList === 0 && afterTab === 0 && onApp && !onLogin(page) && cardShown && stepper && stillThere === 1 && noNote === 0 && state.calls.release >= 4,
      openShot)

    state.status = 'Delivered'
    await comeBackToApp(page)
    const left = await until(() => state.calls.logout === 1, 12000)
    const note = await appears(page, testid('login-updated-note'), 8000)
    record(`T2-${t}`, 'The same driver, once that load reads Delivered: the next open signs him out, so the hold was the load',
      'one sign-out; /login with its line', `sign-outs ${state.calls.logout}, url ${new URL(page.url()).pathname}, line ${note}`,
      left && onLogin(page) && note)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- M1, M2: mid-action
async function statusInFlightRun(browser, size) {
  const t = size.tag
  // Loading, not At Receiver: its next tap brings up no POD reminder to get in the way of Back.
  const state = freshState({ status: 'Loading' })
  state.holds.status = holdOpen()
  const { ctx, page, writes } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    await momentPassed(state, 0)
    await appears(page, '.load-card', 8000)
    await press(page.locator('.load-card').first(), size)
    await appears(page, '.status-stepper-wrapper', 8000)
    await press(page.locator('.status-stepper-wrapper .action-btn.primary').first(), size)
    await appears(page, '.confirm-dialog', 5000)
    await press(page.locator('.confirm-dialog button', { hasText: 'Confirm' }).first(), size)
    const sent = await until(() => writes.includes('PUT /api/driver/status'), 5000)
    // A release lands now: the list reads Delivered, and only the unanswered tap is left to hold it.
    state.due = true
    const before = state.calls.release
    await press(page.locator('.detail-topbar .van-button').first(), size)
    await momentPassed(state, before)
    await comeBackToApp(page)
    await momentPassed(state, before, 2)
    const inFlight = state.calls.logout
    const onApp = !onLogin(page)
    state.holds.status.release()
    await page.waitForTimeout(1000)
    await comeBackToApp(page)
    await page.waitForTimeout(1500)
    const justAfter = state.calls.logout
    await page.waitForTimeout(QUIET_WAIT_MS)
    await comeBackToApp(page)
    const left = await until(() => state.calls.logout === 1, 12000)
    record(`M1-${t}`, 'A status tap in flight is not interrupted',
      'with the tap on the wire and the list reading Delivered: no sign-out, in the app; just after it answers: still none; after the quiet time, the next moment signs him out',
      `sent ${sent}, sign-outs in flight ${inFlight}, on the app ${onApp}, just after ${justAfter}, later ${state.calls.logout}`,
      sent && inFlight === 0 && onApp && justAfter === 0 && left)
  } finally {
    await ctx.close()
  }
}

async function uploadInFlightRun(browser, size) {
  const t = size.tag
  const state = freshState({ status: 'Delivered' })
  state.holds.upload = holdOpen()
  const { ctx, page, writes } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    await momentPassed(state, 0)
    await press(page.locator('.sub-tab', { hasText: 'Historical' }).first(), size)
    await appears(page, '.load-card', 8000)
    await press(page.locator('.load-card').first(), size)
    await appears(page, '.load-detail', 8000)
    await press(page.locator('.van-collapse-item__title', { hasText: 'Documents' }).first(), size)
    await appears(page, '.doc-upload', 8000)
    await page.locator('.doc-upload label.photo-btn', { hasText: 'Upload File' }).first().locator('input[type="file"]').setInputFiles({ name: 'made-up-pod.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 made up') })
    await page.waitForTimeout(300)
    await press(page.locator('.doc-upload .btn.btn-primary').first(), size)
    const sent = await until(() => writes.includes('POST /api/documents/upload'), 5000)
    state.due = true
    const before = state.calls.release
    await press(page.locator('.detail-topbar .van-button').first(), size)
    await momentPassed(state, before)
    const inFlight = state.calls.logout
    const onApp = !onLogin(page)
    const shotFile = await shot(page, `M2-${t}`)
    state.holds.upload.release()
    await page.waitForTimeout(QUIET_WAIT_MS + 1000)
    await comeBackToApp(page)
    const left = await until(() => state.calls.logout === 1, 12000)
    record(`M2-${t}`, 'A POD upload in flight is not interrupted',
      'with the upload on the wire: no sign-out, in the app; once it has answered and the quiet time has passed, the next moment signs him out',
      `sent ${sent}, sign-outs in flight ${inFlight}, on the app ${onApp}, later ${state.calls.logout}`,
      sent && inFlight === 0 && onApp && left, shotFile)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- V: a moving truck
async function noReadingRun(browser, size) {
  const t = size.tag
  for (const reading of ['none', 'stale', 'fail', 'moving-no-speed']) {
    const state = freshState({ due: true, status: 'Delivered', reading })
    const { ctx, page } = await openPage(browser, size, state)
    try {
      await appOpen(page)
      await momentPassed(state, 0)
      const before = state.calls.release
      await comeBackToApp(page)
      await momentPassed(state, before)
      const held = state.calls.logout
      const onApp = !onLogin(page)
      state.reading = 'fix'
      await comeBackToApp(page)
      const left = await until(() => state.calls.logout === 1, 12000)
      record(`V4-${reading}-${t}`, `A truck that doesn't read as parked (${reading}) holds the sign-out; a parked one lets it through`,
        'no sign-out, in the app; one once it reads parked', `held ${held}, on the app ${onApp}, parked ${state.calls.logout}`, held === 0 && onApp && left)
    } finally {
      await ctx.close()
    }
  }
  // The note keeps its own gate: a truck with no reading doesn't hold it.
  const noteState = freshState({ hasNote: true, reading: 'none' })
  const second = await openPage(browser, size, noteState)
  try {
    await appOpen(second.page)
    const shown = await appears(second.page, testid('release-dialog'), 10000)
    record(`V5-${t}`, "No reading: What's new still shows", 'the note', `shown ${shown}`, shown)
  } finally {
    await second.ctx.close()
  }
  // The trap: a stop already known must not be carried past the route saying the fixes moved.
  const parkedFirst = freshState({ status: 'Delivered' })
  const third = await openPage(browser, size, parkedFirst)
  try {
    await appOpen(third.page)
    await momentPassed(parkedFirst, 0)
    parkedFirst.due = true
    parkedFirst.reading = 'moving-no-speed'
    const before = parkedFirst.calls.release
    await comeBackToApp(third.page)
    await momentPassed(parkedFirst, before)
    const held = parkedFirst.calls.logout
    const onApp = !onLogin(third.page)
    parkedFirst.reading = 'fix'
    await comeBackToApp(third.page)
    const left = await until(() => parkedFirst.calls.logout === 1, 12000)
    record(`V6-${t}`, 'A truck read as parked that then moves on a feed with no speed holds the sign-out; parked again, it goes',
      'no sign-out, in the app; one once it reads parked', `held ${held}, on the app ${onApp}, parked ${parkedFirst.calls.logout}`, held === 0 && onApp && left)
  } finally {
    await third.ctx.close()
  }
}

async function movingRun(browser, size) {
  const t = size.tag
  const state = freshState({ due: true, moving: true, status: 'Delivered' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    await momentPassed(state, 0)
    const before = state.calls.release
    await comeBackToApp(page)
    await momentPassed(state, before)
    const held = state.calls.logout
    state.moving = false
    await comeBackToApp(page)
    const left = await until(() => state.calls.logout === 1, 12000)
    record(`V1-${t}`, 'A moving truck holds the sign-out; parked, the next moment lets it through',
      'no sign-out while moving; one after parking', `moving ${held}, parked ${state.calls.logout}`, held === 0 && left)
  } finally {
    await ctx.close()
  }
  const noteState = freshState({ hasNote: true, moving: true })
  const second = await openPage(browser, size, noteState)
  try {
    await appOpen(second.page)
    await second.page.waitForTimeout(4500)
    const heldNote = await second.page.locator(testid('release-dialog')).count()
    noteState.moving = false
    // The ELD read comes round on its own: the note was waiting, not skipped.
    const shown = await appears(second.page, testid('release-dialog'), 35000)
    record(`V2-${t}`, "A moving truck holds What's new; parked, it shows by itself", 'no note while moving; the note once parked',
      `moving ${heldNote}, parked ${shown}`, heldNote === 0 && shown)
    await press(second.page.locator(testid('release-show-me')).first(), size)
    const opened = await appears(second.page, testid('tour-card'), 5000)
    noteState.moving = true
    let closed = false
    try { await second.page.waitForSelector(testid('tour-card'), { state: 'detached', timeout: 35000 }); closed = true } catch { closed = false }
    const tourMarks = second.writes.filter((w) => w.includes('tour-done'))
    const tab = await activeTab(second.page)
    record(`V3-${t}`, 'The tour closes by itself when the truck starts moving', 'the card gone within the next ELD read; no tour mark; back on Loads',
      `opened ${opened}, closed ${closed}, tour marks ${tourMarks.length}, tab "${tab}"`, opened && closed && tourMarks.length === 0 && tab === 'Loads')
  } finally {
    await second.ctx.close()
  }
}

// ---------------------------------------------------------------- F, K, N: a failed read, the switch, no signal
async function failedReadRun(browser, size) {
  const t = size.tag
  for (const kind of ['fail', 'abort', 'empty']) {
    const state = freshState({ due: true, hasNote: true, release: kind, status: 'Delivered' })
    const { ctx, page } = await openPage(browser, size, state)
    try {
      await appOpen(page)
      await momentPassed(state, 0)
      await page.waitForTimeout(3500)
      const before = state.calls.release
      await comeBackToApp(page)
      await momentPassed(state, before)
      const noted = await page.locator(testid('release-dialog')).count()
      await press(page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
      await page.waitForTimeout(500)
      const kit = await page.locator(testid('tour-kit-start')).count()
      record(`F-${kind}-${t}`, `A failed read of the release state (${kind}): he isn't locked out or sent to sign in`,
        'no sign-out; in the app; no note; no Kit button; asked again at the next moment',
        `sign-outs ${state.calls.logout}, url ${new URL(page.url()).pathname}, note ${noted}, Kit button ${kit}, route read ${state.calls.release} times`,
        state.calls.logout === 0 && !onLogin(page) && noted === 0 && kit === 0 && state.calls.release >= 2)
      state.release = 'ok'
      await press(page.locator('.van-tabbar-item', { hasText: 'Loads' }).first(), size)
      const left = await until(() => state.calls.logout === 1, 12000)
      record(`F2-${kind}-${t}`, 'A good answer later works', 'one sign-out', `sign-outs ${state.calls.logout}`, left)
    } finally {
      await ctx.close()
    }
  }
}

// ---------------------------------------------------------------- P: the note waits for the tab's answer
async function performanceAnswerRun(browser, size) {
  const t = size.tag
  const state = freshState({ hasNote: true, status: 'Delivered', perf: 503 })
  const first = await openPage(browser, size, state)
  try {
    await appOpen(first.page)
    await first.page.waitForTimeout(4500)
    const held = await first.page.locator(testid('release-dialog')).count()
    const marks = first.writes.filter((w) => w.includes('/release/'))
    state.perf = 200
    await press(first.page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
    await first.page.waitForTimeout(500)
    await press(first.page.locator('.van-tabbar-item', { hasText: 'Loads' }).first(), size)
    const shown = await appears(first.page, testid('release-dialog'), 10000)
    const lines = await allText(first.page.locator(testid('release-line')))
    const wantLines = LATEST.notes.map((n) => n.text)
    record(`P1-${t}`, "A failed probe of the Performance tab holds What's new; a good one lets it through whole",
      `no note and no mark while the probe fails; then every line: ${JSON.stringify(wantLines)}`,
      `held ${held}, marks ${marks.length}, shown ${shown}, lines ${JSON.stringify(lines)}`,
      held === 0 && marks.length === 0 && shown && sameList(lines, wantLines))
  } finally {
    await first.ctx.close()
  }
  const noWeek = freshState({ hasNote: true, status: 'Delivered', perf: 404 })
  const second = await openPage(browser, size, noWeek)
  try {
    await appOpen(second.page)
    const shown = await appears(second.page, testid('release-dialog'), 10000)
    const lines = await allText(second.page.locator(testid('release-line')))
    const wantLines = LATEST.notes.filter((n) => !n.needs).map((n) => n.text)
    record(`P2-${t}`, 'A driver with no week reads only his line', `lines ${JSON.stringify(wantLines)}`, `shown ${shown}, lines ${JSON.stringify(lines)}`, shown && sameList(lines, wantLines))
  } finally {
    await second.ctx.close()
  }
}

async function killSwitchRun(browser, size) {
  const t = size.tag
  const state = freshState({ due: true, hasNote: true, release: 'off', status: 'Delivered' })
  const { ctx, page, writes } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    await momentPassed(state, 0)
    await page.waitForTimeout(3500)
    await press(page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
    await page.waitForTimeout(500)
    const kit = await page.locator(testid('tour-kit-card')).count()
    const note = await page.locator(testid('release-dialog')).count()
    const marks = writes.filter((w) => w.includes('/release/'))
    record(`K-${t}`, 'The kill switch off: nothing new, nobody signed out', 'no sign-out; no note; no Kit card; no mark',
      `sign-outs ${state.calls.logout}, note ${note}, Kit card ${kit}, marks ${marks.length}`, state.calls.logout === 0 && note === 0 && kit === 0 && marks.length === 0 && !onLogin(page))
  } finally {
    await ctx.close()
  }
}

async function offlineRun(browser, size) {
  const t = size.tag
  const state = freshState({ status: 'Delivered' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    await momentPassed(state, 0)
    state.due = true
    await ctx.setOffline(true)
    await comeBackToApp(page)
    await page.waitForTimeout(3000)
    const offline = state.calls.logout
    const onApp = !onLogin(page)
    await ctx.setOffline(false)
    await page.waitForTimeout(500)
    await comeBackToApp(page)
    const left = await until(() => state.calls.logout === 1, 12000)
    record(`N-${t}`, 'No signal: not signed out; signal back, the next moment does it', 'none offline, in the app; one once back',
      `offline ${offline}, on the app ${onApp}, back ${state.calls.logout}`, offline === 0 && onApp && left)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- U: a sign-out the server doesn't confirm
async function unconfirmedRun(browser, size) {
  const t = size.tag
  const state = freshState({ due: true, status: 'Delivered', logoutFails: true })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    const tried = await until(() => state.calls.logout === 1, 15000)
    const lineShown = await appears(page, testid('login-updated-note'), 8000)
    const words = await text(page, testid('login-updated-note'))
    const onForm = await appears(page, '.submit-btn', 8000)
    const shotFile = await shot(page, `U1-${t}`)
    state.logoutFails = false
    await signInForm(page, size, DRIVER.username)
    const back = await appOpen(page)
    const kept = await page.evaluate(() => sessionStorage.getItem('logisx.driverRelease.loginNote.v1'))
    record(`U1-${t}`, "A sign-out the server doesn't confirm: the app's own login form says why, and his sign-in ends the line",
      `/login with "${WORDS.signedOut}"; he signs in; nothing kept for later`,
      `tried ${tried}, line "${words}", form ${onForm}, back ${back}, kept ${kept}`,
      tried && lineShown && words === WORDS.signedOut && onForm && back && kept === null, shotFile)

    const signOuts = state.calls.logout
    await press(page.locator('.header-btn.danger').first(), size)
    const left = await until(() => state.calls.logout === signOuts + 1, 8000)
    await appears(page, '.submit-btn', 8000)
    await page.waitForTimeout(500)
    const line = await page.locator(testid('login-updated-note')).count()
    record(`U2-${t}`, 'A logout he asks for after that shows no line', 'his Logout works; /login; no line about an update',
      `left ${left}, url ${new URL(page.url()).pathname}, line ${line}`, left && onLogin(page) && line === 0)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- L, C, H: no loop, tabs, a shared phone
async function loopRun(browser, size) {
  const t = size.tag
  const state = freshState({ due: true, dueAfterLogin: true, status: 'Delivered' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await until(() => state.calls.logout === 1, 15000)
    const before = state.calls.release
    await signInForm(page, size, DRIVER.username)
    const back = await appOpen(page)
    await momentPassed(state, before)
    await comeBackToApp(page)
    await momentPassed(state, before, 2)
    record(`L-${t}`, 'A server that keeps saying due: one sign-out, no loop', 'he stays in the app after signing back in; one sign-out',
      `app ${back}, url ${new URL(page.url()).pathname}, sign-outs ${state.calls.logout}, sign-ins ${state.calls.login}`, back && !onLogin(page) && state.calls.logout === 1 && state.calls.login === 1)
  } finally {
    await ctx.close()
  }
}

async function openTabs(ctx, size, count) {
  const pages = []
  for (let i = 0; i < count; i++) {
    const page = await ctx.newPage()
    page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
    await page.goto(`${BASE}/driver`, { waitUntil: 'domcontentloaded' })
    await appOpen(page)
    pages.push(page)
  }
  return pages
}

async function twoTabsRun(browser, size) {
  const t = size.tag
  const state = freshState({ status: 'Delivered' })
  const ctx = await newContext(browser, size, state, [])
  try {
    const [a, b] = await openTabs(ctx, size, 2)
    await momentPassed(state, 0, 2)
    state.due = true
    let before = state.calls.release
    await a.bringToFront()
    await comeBackToApp(a)
    await momentPassed(state, before)
    before = state.calls.release
    await b.bringToFront()
    await comeBackToApp(b)
    await momentPassed(state, before)
    const held = state.calls.logout
    const bothOn = !onLogin(a) && !onLogin(b)
    record(`C1-${t}`, 'Two open tabs hold each other: a tab with something half typed is never taken along', 'no sign-out from either; both in the app',
      `sign-outs ${held}, A at ${new URL(a.url()).pathname}, B at ${new URL(b.url()).pathname}`, held === 0 && bothOn)
    // Closing a tab from here needn't run its pagehide, as a person closing one does: leaving does.
    await b.goto('about:blank')
    await b.close()
    await a.bringToFront()
    await comeBackToApp(a)
    const left = await until(() => state.calls.logout === 1, 12000)
    const line = await appears(a, testid('login-updated-note'), 8000)
    record(`C2-${t}`, 'With the other tab closed, the next moment signs him out', 'one sign-out; /login with its line',
      `sign-outs ${state.calls.logout}, A at ${new URL(a.url()).pathname}, line ${line}`, left && onLogin(a) && line)
  } finally {
    await ctx.close()
  }

  const own = freshState({ status: 'Delivered' })
  const ctx2 = await newContext(browser, size, own, [])
  try {
    const [a, b] = await openTabs(ctx2, size, 2)
    await a.bringToFront()
    await press(a.locator('.header-btn.danger').first(), size)
    const aLeft = await until(() => own.calls.logout === 1, 8000)
    const bLeft = await until(() => onLogin(b), 12000)
    record(`C3-${t}`, 'A logout he asks for in one tab still takes the other along', 'tab A signs out; tab B follows to /login',
      `A left ${aLeft}, B left ${bLeft}, B at ${new URL(b.url()).pathname}`, aLeft && bLeft)
  } finally {
    await ctx2.close()
  }

  const noRecord = freshState({ due: true, status: 'Delivered' })
  const ctx3 = await newContext(browser, size, noRecord, [])
  try {
    await ctx3.addInitScript((prefix) => {
      const realSet = Storage.prototype.setItem
      Storage.prototype.setItem = function setItem(key, value) {
        if (String(key).startsWith(prefix)) throw new Error('made up: this browser keeps no record')
        return realSet.call(this, key, value)
      }
    }, APP_PAGE_PREFIX)
    const [page] = await openTabs(ctx3, size, 1)
    await momentPassed(noRecord, 0)
    await comeBackToApp(page)
    await momentPassed(noRecord, 1)
    record(`C4-${t}`, "A browser that can't keep a tab's record holds too", 'no sign-out; in the app',
      `sign-outs ${noRecord.calls.logout}, url ${new URL(page.url()).pathname}`, noRecord.calls.logout === 0 && !onLogin(page))
  } finally {
    await ctx3.close()
  }

  // A page the browser has frozen runs nothing, so nothing it could answer would ever arrive.
  const frozen = freshState({ status: 'Delivered' })
  const ctx4 = await newContext(browser, size, frozen, [])
  try {
    await ctx4.addInitScript(() => { document.addEventListener('freeze', () => { window.__madeUpFroze = true }) })
    const [a, b] = await openTabs(ctx4, size, 2)
    await momentPassed(frozen, 0, 2)
    const lifecycle = await ctx4.newCDPSession(b)
    await lifecycle.send('Page.setWebLifecycleState', { state: 'frozen' })
    frozen.due = true
    const before = frozen.calls.release
    await a.bringToFront()
    await comeBackToApp(a)
    await momentPassed(frozen, before)
    const held = frozen.calls.logout
    const onApp = !onLogin(a)
    await lifecycle.send('Page.setWebLifecycleState', { state: 'active' })
    const froze = await b.evaluate(() => window.__madeUpFroze === true)
    record(`C5-${t}`, 'A tab the browser has frozen holds the sign-out, with no answer from it', 'no sign-out; in the app; the tab did freeze',
      `sign-outs ${held}, A at ${new URL(a.url()).pathname}, froze ${froze}`, held === 0 && onApp && froze)
    await b.goto('about:blank')
    await a.bringToFront()
    await comeBackToApp(a)
    const left = await until(() => frozen.calls.logout === 1, 12000)
    record(`C6-${t}`, 'Once that tab has left, the next moment signs them out, so the hold was its record', 'one sign-out', `sign-outs ${frozen.calls.logout}`, left)
  } finally {
    await ctx4.close()
  }

  const dead = freshState({ due: true, status: 'Delivered' })
  const ctx5 = await newContext(browser, size, dead, [])
  try {
    await plantRecord(ctx5, 60 * 60 * 1000)
    const [page] = await openTabs(ctx5, size, 1)
    await momentPassed(dead, 0)
    const before = dead.calls.release
    await comeBackToApp(page)
    await momentPassed(dead, before)
    record(`C7-${t}`, 'A tab that died without saying so, its record under a day old, holds: they get the update at their next sign-in', 'no sign-out; in the app',
      `sign-outs ${dead.calls.logout}, url ${new URL(page.url()).pathname}`, dead.calls.logout === 0 && !onLogin(page))
  } finally {
    await ctx5.close()
  }

  const expired = freshState({ due: true, status: 'Delivered' })
  const ctx6 = await newContext(browser, size, expired, [])
  try {
    await plantRecord(ctx6, 25 * 60 * 60 * 1000)
    const [page] = await openTabs(ctx6, size, 1)
    const left = await until(() => expired.calls.logout === 1, 12000)
    await appears(page, testid('login-updated-note'), 8000)
    const stale = await page.evaluate((key) => localStorage.getItem(key), PLANTED_RECORD)
    record(`C8-${t}`, 'A record over a day old holds nothing and is tidied away', 'one sign-out; the record gone',
      `sign-outs ${expired.calls.logout}, record ${stale}`, left && stale === null)
  } finally {
    await ctx6.close()
  }
}

// A tab's record as lib/appTabs.js writes it, from a tab that's no longer there, before each page starts.
const APP_PAGE_PREFIX = 'logisx.appPage.v1.'
const PLANTED_RECORD = `${APP_PAGE_PREFIX}madeupdeadtab`
function plantRecord(ctx, ageMs) {
  return ctx.addInitScript(([key, age]) => {
    try { localStorage.setItem(key, String(Date.now() - age)) } catch { /* a page with no storage has no use for it */ }
  }, [PLANTED_RECORD, ageMs])
}

async function sharedPhoneRun(browser, size) {
  const t = size.tag
  const state = freshState({ due: true, hasNote: true, status: 'Delivered' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await until(() => state.calls.logout === 1, 15000)
    await appears(page, testid('login-updated-note'), 8000)
    await signInForm(page, size, DRIVER_B.username)
    const back = await appOpen(page)
    const note = await appears(page, testid('release-dialog'), 10000)
    const body = squeeze(await page.locator('body').innerText())
    const named = body.includes(DRIVER.driverName)
    const kept = await page.evaluate(() => JSON.stringify({ ...localStorage }))
    const lineKept = await page.evaluate(() => sessionStorage.getItem('logisx.driverRelease.loginNote.v1'))
    record(`H-${t}`, 'A shared phone: the next driver reads his own answer',
      "B in the app with the note; nothing of the first driver on screen; what's kept holds an account id and a release id, no name; the login line is gone",
      `app ${back}, note ${note}, first driver named ${named}, name kept ${kept.includes(DRIVER.driverName)}, line kept ${lineKept}, sign-outs ${state.calls.logout}`,
      back && note && !named && !kept.includes(DRIVER.driverName) && lineKept === null && state.calls.logout === 1)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- O: a first-time driver
async function offerRun(browser, size) {
  const t = size.tag
  const skipper = freshState({ offer: true, unread: true })
  const first = await openPage(browser, size, skipper)
  try {
    await appOpen(first.page)
    const shows = await appears(first.page, testid('release-take-tour'), 10000)
    const heading = await text(first.page, testid('release-heading'))
    const words = await text(first.page, testid('release-dialog'))
    const sized = await heights(first.page, `${testid('release-take-tour')}, ${testid('release-skip-offer')}`)
    const offerShot = await shot(first.page, `O1-${t}`)
    await press(first.page.locator(testid('release-skip-offer')).first(), size)
    await until(() => first.writes.includes('POST /api/driver/me/release/seen'), 5000)
    const before = skipper.calls.release
    await comeBackToApp(first.page)
    await momentPassed(skipper, before)
    const nagged = await first.page.locator(testid('release-dialog')).count()
    record(`O1-${t}`, 'A first-time driver is offered the tour; he can skip, and is not asked again',
      `"${WORDS.offerHeading}"; "${WORDS.offerText}"; "${WORDS.takeTour}" and "${WORDS.skipOffer}", 44 px or more; after a skip, not on the next moment`,
      `shown ${shows}, heading "${heading}", words "${words}", heights ${JSON.stringify(sized)}, nagged ${nagged}`,
      shows && heading === WORDS.offerHeading && words.includes(WORDS.offerText) && words.includes(WORDS.takeTour) && words.includes(WORDS.skipOffer) && tall(sized) && nagged === 0,
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
      `"${WORDS.kitButton}"; "Step 1 of ${ALL_STEP_TITLES.length}"; back on Kit; no tour mark`,
      `button ${kit} "${kitWords}", card ${fromKit} "${kitLabel}", tab "${kitTab}", tour marks ${kitMarks.length}`,
      kit && kitWords === WORDS.kitButton && fromKit && kitLabel === `Step 1 of ${ALL_STEP_TITLES.length}` && kitTab === 'Kit' && kitMarks.length === 0)
  } finally {
    await first.ctx.close()
  }

  const taker = freshState({ offer: true, unread: true, status: 'In Transit' })
  const second = await openPage(browser, size, taker)
  try {
    await appOpen(second.page)
    await appears(second.page, testid('release-take-tour'), 10000)
    const unreadBefore = await second.page.locator('.van-tabbar .van-badge').count()
    await press(second.page.locator(testid('release-take-tour')).first(), size)
    const walked = await walkTour(second.page, size, ALL_STEP_TITLES)
    const midWrites = second.writes.slice()
    await press(second.page.locator(testid('tour-next')).first(), size)
    await until(() => second.writes.includes('POST /api/driver/me/release/tour-done'), 5000)
    await second.page.waitForTimeout(500)
    const unreadAfter = await second.page.locator('.van-tabbar .van-badge').count()
    const readMarks = second.writes.filter((w) => /\/read$/.test(w))
    const allWrites = second.writes.filter((w) => !w.includes('/api/auth/'))
    const expectTabs = ['Loads', 'Loads', 'Alerts', 'Kit', 'Messages', 'Invoices', 'Performance', 'Loads']
    record(`O3-${t}`, "Take the tour walks every screen, with a load In Transit, and marks nothing read: its only writes are its own",
      `titles ${JSON.stringify(ALL_STEP_TITLES)} on tabs ${JSON.stringify(expectTabs)}; his load's own page on that step; no message or alert marked read; the badges stay; writes: the seen mark, then the tour mark; no sign-out`,
      `titles ${JSON.stringify(walked.map((s) => s.title))}, tabs ${JSON.stringify(walked.map((s) => s.tab))}, badges ${unreadBefore} then ${unreadAfter}, read marks ${JSON.stringify(readMarks)}, writes before Done ${JSON.stringify(midWrites)}, all ${JSON.stringify(allWrites)}, sign-outs ${taker.calls.logout}`,
      sameList(walked.map((s) => s.title), ALL_STEP_TITLES) && sameList(walked.map((s) => s.tab), expectTabs) && walked.find((s) => s.title === ALL_STEP_TITLES[1]).loadPage === 1 && walked.find((s) => s.title === ALL_STEP_TITLES[0]).loadPage === 0 && readMarks.length === 0 && unreadBefore > 0 && unreadAfter === unreadBefore
        && sameList(midWrites, ['POST /api/driver/me/release/seen']) && sameList(allWrites, ['POST /api/driver/me/release/seen', 'POST /api/driver/me/release/tour-done']) && taker.calls.logout === 0,
      await shot(second.page, `O3-${t}`))
  } finally {
    await second.ctx.close()
  }
}

// ---------------------------------------------------------------- A, B: never another role, never the lock screen
async function otherRoleRun(browser, size) {
  const t = size.tag
  const state = freshState({ who: ADMIN, due: true, hasNote: true, status: 'Delivered' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    await page.waitForTimeout(4500)
    await comeBackToApp(page)
    await page.waitForTimeout(1500)
    await press(page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
    await page.waitForTimeout(500)
    const kit = await page.locator(testid('tour-kit-card')).count()
    const note = await page.locator(testid('release-dialog')).count()
    record(`A-${t}`, 'A Super Admin on /driver: nothing of this, ever', 'the route never read; no sign-out; no note; no Kit card',
      `route read ${state.calls.release} times, sign-outs ${state.calls.logout}, note ${note}, Kit card ${kit}, url ${new URL(page.url()).pathname}`,
      state.calls.release === 0 && state.calls.logout === 0 && note === 0 && kit === 0 && !onLogin(page))
  } finally {
    await ctx.close()
  }
}

async function lockScreenRun(browser, size) {
  const t = size.tag
  const state = freshState({ due: true, hasNote: true, status: 'Delivered', onboarding: 'documents_pending' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    const locked = await appears(page, '.onboarding-locked', 15000)
    await page.waitForTimeout(4500)
    await comeBackToApp(page)
    await page.waitForTimeout(1500)
    const note = await page.locator(testid('release-dialog')).count()
    record(`B-${t}`, 'A driver on the lock screen: not signed out, nothing shown', 'the lock screen; the route never read; no sign-out; no note',
      `locked ${locked}, route read ${state.calls.release} times, sign-outs ${state.calls.logout}, note ${note}`, locked && state.calls.release === 0 && state.calls.logout === 0 && note === 0 && !onLogin(page))
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
      await signOutRun(browser, size)
      await inTransitRun(browser, size)
      await statusInFlightRun(browser, size)
      await uploadInFlightRun(browser, size)
    }
    await emptyListRun(browser, PHONE)
    await movingRun(browser, PHONE)
    await noReadingRun(browser, PHONE)
    await failedReadRun(browser, PHONE)
    await performanceAnswerRun(browser, PHONE)
    await killSwitchRun(browser, PHONE)
    await offlineRun(browser, PHONE)
    await unconfirmedRun(browser, PHONE)
    await loopRun(browser, PHONE)
    await twoTabsRun(browser, PHONE)
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
