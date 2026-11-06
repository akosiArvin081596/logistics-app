#!/usr/bin/env node
// LogisX — new-feature notices for drivers: "What's new" and the tour at the next sign-in, on made-up
// data only. There is no forced sign-out: every step counts the logout calls, and only a driver's own
// tap on Logout makes one.
//
// As a made-up Driver ("Casey Example"), at 390x844 and 1280x800:
//   S   a session from before a release: nobody signed out at app open, on coming back, on a tap or on
//       a reload, and no note. They log out themselves: the login page says nothing about an update.
//       They sign in as usual; the note shows the list's own words; Show me walks the release's steps
//       on the real tabs; Done; it doesn't come back. Only the two marks are written. 44 px or more,
//       no sideways scroll
//   T   a load In Transit, with the session behind: no sign-out anywhere; the load stays on screen
// And at 390x844:
//   E   a page left open past its session: this feature does nothing to it. The next load finds the
//       login page, and the note comes after that sign-in
//   V   a moving truck holds the note, and parking lets it through by itself; a tour under way closes
//       by itself when the truck starts moving and marks nothing done; the same for a truck moving on a
//       feed that sends no speed; no reading, a stale reading and a failed read don't hold the note
//   F   a failed read of the release state (503, no answer, an unreadable body): no note, no Kit button,
//       and they stay in the app; a good answer later works
//   P   the note waits for the Performance answer: a failed probe holds it, a good one lets it through
//       whole; a driver with no week reads only their line
//   L   a load's page holds the note, and a working load doesn't: back on the list, it shows
//   K   the kill switch off (404 FEATURE_OFF): nothing new anywhere
//   H   a shared phone: the next driver signs in and reads their own answer; nothing of this is kept in
//       the browser
//   O   a first-time driver: the offer, Skip for now, no nagging; Take the tour walks every tab; the
//       tour marks no message or alert read and writes only its own marks; the Kit's button runs it
// And:
//   A   a made-up Super Admin on /driver at 1280x800: the route is never read, no note, no button
//   B   a driver on the onboarding lock screen: the route is never read, nothing shown
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
const NOTHING = { notes: [], tourOffered: false }

const thisWeek = { id: 'this-week', start: '2026-10-31', end: '2026-11-06', credits: { value: 1, target: 7.5, required: 6, deliveries: 1, pickups: 1 }, left: 6.5, percent: 13, pace: 'on-track', newWeekNote: false, nextWeekStarts: 'Nov 7', targetLowered: false, loads: [] }
const lastWeek = { id: 'last-week', start: '2026-10-24', end: '2026-10-30', credits: { value: 7.5, target: 7.5, required: 6, deliveries: 8, pickups: 7 }, left: null, percent: 100, pace: null, newWeekNote: false, nextWeekStarts: null, targetLowered: false, loads: [] }

// One browser's view of the server. `behind`: this session is from before the latest entry, so the
// route has nothing for it until a sign-in. `release` says how the route answers: 'ok', 'off', 'fail'
// or 'empty'. `reading` how the truck's does: 'fix', 'none', 'stale', 'fail', or 'moving-no-speed' for
// what the route sends a truck whose feed sends no speed and whose fixes moved apart. `perf` their
// week's: a status. `calls.logout` counts every logout: a step that doesn't tap Logout must see none.
function freshState({ who = DRIVER, session = true, behind = false, status = '', offer = false, hasNote = false, release = 'ok', moving = false, onboarding = 'fully_onboarded', unread = false, reading = 'fix', perf = 200 } = {}) {
  return {
    who, session, behind, status, offer, hasNote, release, moving, onboarding, unread, reading, perf,
    seen: new Set(), tourDone: new Set(),
    calls: { release: 0, logout: 0, login: 0, position: 0 },
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
  if (state.behind) return { status: 200, body: NOTHING }
  return {
    status: 200,
    body: {
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
  if (pathname === '/api/auth/session') return { status: 200, body: state.session ? { authenticated: true, user: state.who, appTimeZone: 'America/New_York' } : { authenticated: false } }
  if (pathname === '/api/auth/setup-check') return { status: 200, body: { needsSetup: false } }
  if (!state.session) return { status: 401, body: { error: 'Not signed in' } }
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
      return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out ? out.body : {}) })
    }
    writes.push(`${req.method()} ${u.pathname}`)
    let body = {}
    try { body = req.postDataJSON() || {} } catch { body = {} }
    if (u.pathname === '/api/auth/logout') {
      state.calls.logout++
      state.session = false
    } else if (u.pathname === '/api/auth/login') {
      state.calls.login++
      state.who = ACCOUNTS[body.username] || state.who
      state.session = true
      // A sign-in starts the session on the latest entry.
      state.behind = false
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, user: state.who, appTimeZone: 'America/New_York' }) })
    } else if (u.pathname === '/api/driver/me/release/seen') {
      for (const id of body.ids || []) state.seen.add(id)
    } else if (u.pathname === '/api/driver/me/release/tour-done') {
      for (const id of body.ids || []) state.tourDone.add(id)
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })
  return ctx
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
const openAgain = (page) => page.reload({ waitUntil: 'domcontentloaded' })
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

// ---------------------------------------------------------------- S: the next sign-in, and no force
async function nextSignInRun(browser, size) {
  const t = size.tag
  const state = freshState({ behind: true, hasNote: true, status: 'Delivered' })
  const { ctx, page, writes } = await openPage(browser, size, state)
  try {
    const opened = await appOpen(page)
    await momentPassed(state, 0)
    let before = state.calls.release
    await comeBackToApp(page)
    await momentPassed(state, before)
    await press(page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
    await page.waitForTimeout(500)
    before = state.calls.release
    await press(page.locator('.van-tabbar-item', { hasText: 'Loads' }).first(), size)
    await momentPassed(state, before)
    before = state.calls.release
    await openAgain(page)
    await appOpen(page)
    await momentPassed(state, before)
    const noteWhileBehind = await page.locator(testid('release-dialog')).count()
    record(`S1-${t}`, 'A session from before the release, truck parked, nothing unfinished, one tab: nobody signed out, and no note until the next sign-in',
      'no logout at app open, on coming back, on a tap or on a reload; in the app; no note; no writes',
      `app ${opened}, logouts ${state.calls.logout}, url ${new URL(page.url()).pathname}, note ${noteWhileBehind}, writes ${JSON.stringify(writes)}, route read ${state.calls.release} times`,
      opened && state.calls.logout === 0 && !onLogin(page) && noteWhileBehind === 0 && writes.length === 0 && state.calls.release >= 4,
      await shot(page, `S1-${t}`))

    await press(page.locator('.header-btn.danger').first(), size)
    const left = await until(() => state.calls.logout === 1, 8000)
    await appears(page, '.submit-btn', 8000)
    await page.waitForTimeout(500)
    const pageText = squeeze(await page.locator('body').innerText())
    record(`S2-${t}`, 'A logout they ask for works as ever, and the login page says nothing about an update',
      'one logout; /login; no words about the app being updated',
      `logouts ${state.calls.logout}, url ${new URL(page.url()).pathname}, mentions an update ${/updated|sign in again/i.test(pageText)}`,
      left && onLogin(page) && !/updated|sign in again/i.test(pageText))

    await signInForm(page, size, DRIVER.username)
    const back = await appOpen(page)
    const shows = await appears(page, testid('release-dialog'), 10000)
    const heading = await text(page, testid('release-heading'))
    const title = await text(page, testid('release-entry-title'))
    const lines = await allText(page.locator(testid('release-line')))
    const wantLines = LATEST.notes.map((n) => n.text)
    const buttons = await heights(page, `${testid('release-show-me')}, ${testid('release-got-it')}`)
    const fits = await noSideScroll(page)
    record(`S3-${t}`, "They sign in as usual and read What's new, the list's own words",
      `"${WORDS.notesHeading}"; "${LATEST.title}"; lines ${JSON.stringify(wantLines)}; no digit anywhere; Show me and Got it 44 px or more; no side scroll`,
      `app ${back}, heading "${heading}", title "${title}", lines ${JSON.stringify(lines)}, heights ${JSON.stringify(buttons)}, fits ${fits}`,
      back && shows && heading === WORDS.notesHeading && title === LATEST.title && sameList(lines, wantLines) && !/\d/.test(lines.join(' ')) && tall(buttons) && fits,
      await shot(page, `S3-${t}`))

    const writesBefore = writes.length
    await press(page.locator(testid('release-show-me')).first(), size)
    const walked = await walkTour(page, size, RELEASE_STEP_TITLES)
    const cardHeights = await heights(page, `${testid('tour-next')}, ${testid('tour-skip')}`)
    const cardFits = await noSideScroll(page)
    const cardShot = await shot(page, `S4-${t}`)
    const midWrites = writes.slice(writesBefore)
    await press(page.locator(testid('tour-next')).first(), size)
    const closed = await until(() => writes.includes('POST /api/driver/me/release/tour-done'), 5000)
    const cardGone = await page.locator(testid('tour-card')).count() === 0
    const tabAfter = await activeTab(page)
    record(`S4-${t}`, "Show me walks the release's steps on the real tabs; Done closes it",
      `titles ${JSON.stringify(RELEASE_STEP_TITLES)}, "Step n of ${RELEASE_STEP_TITLES.length}"; the Performance step on the Performance tab; 44 px or more; only the seen mark along the way, then the tour mark; back on Loads`,
      `walked ${JSON.stringify(walked)}, heights ${JSON.stringify(cardHeights)}, fits ${cardFits}, writes along the way ${JSON.stringify(midWrites)}, tour marked ${closed}, card gone ${cardGone}, tab "${tabAfter}"`,
      sameList(walked.map((s) => s.title), RELEASE_STEP_TITLES) && walked.every((s, i) => s.label === `Step ${i + 1} of ${RELEASE_STEP_TITLES.length}`)
        && walked.find((s) => s.title === 'Performance').tab === 'Performance' && tall(cardHeights) && cardFits && sameList(midWrites, ['POST /api/driver/me/release/seen']) && closed && cardGone && tabAfter === 'Loads',
      cardShot)

    before = state.calls.release
    await comeBackToApp(page)
    await momentPassed(state, before)
    const again = await page.locator(testid('release-dialog')).count()
    const allWrites = writes.filter((w) => !w.includes('/api/auth/'))
    record(`S5-${t}`, 'It shows once, and nothing else was written',
      'no note on the next moment; the only writes besides signing out and in are the two marks; still the one logout they asked for',
      `note ${again}, writes ${JSON.stringify(allWrites)}, logouts ${state.calls.logout}`,
      again === 0 && sameList(allWrites, ['POST /api/driver/me/release/seen', 'POST /api/driver/me/release/tour-done']) && state.calls.logout === 1)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- T: a load In Transit
async function inTransitRun(browser, size) {
  const t = size.tag
  const state = freshState({ behind: true, hasNote: true, status: 'In Transit' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    await momentPassed(state, 0)
    const cardShown = await appears(page, '.load-card', 8000)
    const openShot = await shot(page, `T1-${t}`)
    let before = state.calls.release
    await comeBackToApp(page)
    await momentPassed(state, before)
    await press(page.locator('.load-card').first(), size)
    await appears(page, '.load-detail', 8000)
    const stepper = await appears(page, '.status-stepper-wrapper', 8000)
    before = state.calls.release
    await press(page.locator('.detail-topbar .van-button').first(), size)
    await momentPassed(state, before)
    await press(page.locator('.van-tabbar-item', { hasText: 'Kit' }).first(), size)
    await page.waitForTimeout(500)
    before = state.calls.release
    await press(page.locator('.van-tabbar-item', { hasText: 'Loads' }).first(), size)
    await momentPassed(state, before)
    const stillThere = await page.locator('.load-card').count()
    const noNote = await page.locator(testid('release-dialog')).count()
    record(`T1-${t}`, 'A driver with a load In Transit and a session from before the release: nothing happens to them',
      "no logout at app open, on coming back, on leaving a load's page or on coming back to the Loads tab; the load on screen; no note",
      `logouts ${state.calls.logout}, on the app ${!onLogin(page)}, load cards ${stillThere}, card at open ${cardShown}, stepper ${stepper}, note ${noNote}, route read ${state.calls.release} times`,
      state.calls.logout === 0 && !onLogin(page) && cardShown && stepper && stillThere === 1 && noNote === 0 && state.calls.release >= 4,
      openShot)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- E: a page left open past its session
async function pastItsSessionRun(browser, size) {
  const t = size.tag
  const state = freshState({ behind: true, hasNote: true, status: 'Delivered' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    await momentPassed(state, 0)
    // The session's 24 hours end on the server, with this page still open.
    state.session = false
    await comeBackToApp(page)
    await page.waitForTimeout(3000)
    const inOpenPage = state.calls.logout
    const note = await page.locator(testid('release-dialog')).count()
    record(`E1-${t}`, 'A page left open past its session: this feature does nothing to it', 'no logout from this feature; no note',
      `logouts ${inOpenPage}, note ${note}, url ${new URL(page.url()).pathname}`, inOpenPage === 0 && note === 0)
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

// ---------------------------------------------------------------- V: a moving truck, and one not reporting
async function movingRun(browser, size) {
  const t = size.tag
  for (const [name, startMoving, stopMoving] of [
    ['with a speed', (s) => { s.moving = true }, (s) => { s.moving = false }],
    ['on a feed that sends no speed', (s) => { s.reading = 'moving-no-speed' }, (s) => { s.reading = 'fix' }],
  ]) {
    const state = freshState({ hasNote: true })
    startMoving(state)
    const { ctx, page, writes } = await openPage(browser, size, state)
    try {
      await appOpen(page)
      await page.waitForTimeout(4500)
      const held = await page.locator(testid('release-dialog')).count()
      stopMoving(state)
      // The ELD read comes round on its own: the note was waiting, not skipped.
      const shown = await appears(page, testid('release-dialog'), 35000)
      record(`V1-${t} ${name}`, `A moving truck, ${name}, holds What's new; parked, it shows by itself`, 'no note while moving; the note once parked',
        `moving ${held}, parked ${shown}`, held === 0 && shown)
      await press(page.locator(testid('release-show-me')).first(), size)
      const opened = await appears(page, testid('tour-card'), 5000)
      startMoving(state)
      let closed = false
      try { await page.waitForSelector(testid('tour-card'), { state: 'detached', timeout: 35000 }); closed = true } catch { closed = false }
      const tourMarks = writes.filter((w) => w.includes('tour-done'))
      const tab = await activeTab(page)
      record(`V2-${t} ${name}`, `The tour closes by itself when the truck starts moving, ${name}`, 'the card gone within the next ELD read; no tour mark; back on Loads',
        `opened ${opened}, closed ${closed}, tour marks ${tourMarks.length}, tab "${tab}"`, opened && closed && tourMarks.length === 0 && tab === 'Loads')
    } finally {
      await ctx.close()
    }
  }
  for (const reading of ['none', 'stale', 'fail']) {
    const state = freshState({ hasNote: true, reading })
    const { ctx, page } = await openPage(browser, size, state)
    try {
      await appOpen(page)
      const shown = await appears(page, testid('release-dialog'), 10000)
      record(`V3-${reading}-${t}`, `A truck not reporting (${reading}) doesn't hold What's new, as it never did`, 'the note', `shown ${shown}`, shown)
    } finally {
      await ctx.close()
    }
  }
}

// ---------------------------------------------------------------- F, K: a failed read, the switch
async function failedReadRun(browser, size) {
  const t = size.tag
  for (const kind of ['fail', 'abort', 'empty']) {
    const state = freshState({ hasNote: true, release: kind, status: 'Delivered' })
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
      record(`F-${kind}-${t}`, `A failed read of the release state (${kind}): they aren't locked out or sent to sign in`,
        'no logout; in the app; no note; no Kit button; asked again at the next moment',
        `logouts ${state.calls.logout}, url ${new URL(page.url()).pathname}, note ${noted}, Kit button ${kit}, route read ${state.calls.release} times`,
        state.calls.logout === 0 && !onLogin(page) && noted === 0 && kit === 0 && state.calls.release >= 2)
      state.release = 'ok'
      await press(page.locator('.van-tabbar-item', { hasText: 'Loads' }).first(), size)
      const shown = await appears(page, testid('release-dialog'), 12000)
      record(`F2-${kind}-${t}`, 'A good answer later works', 'the note, and no logout', `note ${shown}, logouts ${state.calls.logout}`, shown && state.calls.logout === 0)
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
    record(`P2-${t}`, 'A driver with no week reads only their line', `lines ${JSON.stringify(wantLines)}`, `shown ${shown}, lines ${JSON.stringify(lines)}`, shown && sameList(lines, wantLines))
  } finally {
    await second.ctx.close()
  }
}

async function loadPageRun(browser, size) {
  const t = size.tag
  // The read fails until a load's page is open, so the first answer comes with that page on screen.
  const state = freshState({ hasNote: true, status: 'In Transit', release: 'fail' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await appOpen(page)
    await momentPassed(state, 0)
    await press(page.locator('.load-card').first(), size)
    const opened = await appears(page, '.load-detail', 8000)
    state.release = 'ok'
    const before = state.calls.release
    await comeBackToApp(page)
    await momentPassed(state, before)
    const held = await page.locator(testid('release-dialog')).count()
    await press(page.locator('.detail-topbar .van-button').first(), size)
    const shown = await appears(page, testid('release-dialog'), 10000)
    record(`L-${t}`, "A load's page holds What's new, and a working load doesn't: back on the list, it shows", 'no note on the page; the note on the list; no logout',
      `load's page ${opened}, note there ${held}, note on the list ${shown}, logouts ${state.calls.logout}`, opened && held === 0 && shown && state.calls.logout === 0)
  } finally {
    await ctx.close()
  }
}

async function killSwitchRun(browser, size) {
  const t = size.tag
  const state = freshState({ hasNote: true, release: 'off', status: 'Delivered' })
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
    record(`K-${t}`, 'The kill switch off: nothing new', 'no logout; no note; no Kit card; no mark',
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
    await press(page.locator('.header-btn.danger').first(), size)
    await until(() => state.calls.logout === 1, 8000)
    await signInForm(page, size, DRIVER_B.username)
    const back = await appOpen(page)
    const note = await appears(page, testid('release-dialog'), 10000)
    const body = squeeze(await page.locator('body').innerText())
    const named = body.includes(DRIVER.driverName)
    const kept = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
    record(`H-${t}`, 'A shared phone: the next driver reads their own answer, and this feature keeps nothing in the browser',
      'B in the app with the note; nothing of the first driver on screen; no name kept by this; no record of a release or a tab',
      `app ${back}, note ${note}, first driver named ${named}, kept by this ${/driverRelease|appPage/.test(kept)}, logouts ${state.calls.logout}`,
      back && note && !named && !/driverRelease|appPage/.test(kept) && state.calls.logout === 1)
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
    record(`O1-${t}`, 'A first-time driver is offered the tour; they can skip, and are not asked again',
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
    record(`O3-${t}`, 'Take the tour walks every screen, with a load In Transit, and marks nothing read: its only writes are its own',
      `titles ${JSON.stringify(ALL_STEP_TITLES)} on tabs ${JSON.stringify(expectTabs)}; their load's own page on that step; no message or alert marked read; the badges stay; writes: the seen mark, then the tour mark; no logout`,
      `titles ${JSON.stringify(walked.map((s) => s.title))}, tabs ${JSON.stringify(walked.map((s) => s.tab))}, badges ${unreadBefore} then ${unreadAfter}, read marks ${JSON.stringify(readMarks)}, writes before Done ${JSON.stringify(midWrites)}, all ${JSON.stringify(allWrites)}, logouts ${taker.calls.logout}`,
      sameList(walked.map((s) => s.title), ALL_STEP_TITLES) && sameList(walked.map((s) => s.tab), expectTabs) && walked.find((s) => s.title === ALL_STEP_TITLES[1]).loadPage === 1 && walked.find((s) => s.title === ALL_STEP_TITLES[0]).loadPage === 0 && readMarks.length === 0 && unreadBefore > 0 && unreadAfter === unreadBefore
        && sameList(midWrites, ['POST /api/driver/me/release/seen']) && sameList(allWrites, ['POST /api/driver/me/release/seen', 'POST /api/driver/me/release/tour-done']) && taker.calls.logout === 0,
      await shot(second.page, `O3-${t}`))
  } finally {
    await second.ctx.close()
  }
}

// ---------------------------------------------------------------- A, B: who it doesn't reach
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
    const note = await page.locator(testid('release-dialog')).count()
    record(`A-${t}`, 'A Super Admin on /driver: nothing of this, ever', 'the route never read; no logout; no note; no Kit card',
      `route read ${state.calls.release} times, logouts ${state.calls.logout}, note ${note}, Kit card ${kit}, url ${new URL(page.url()).pathname}`,
      state.calls.release === 0 && state.calls.logout === 0 && note === 0 && kit === 0 && !onLogin(page))
  } finally {
    await ctx.close()
  }
}

async function lockScreenRun(browser, size) {
  const t = size.tag
  const state = freshState({ hasNote: true, status: 'Delivered', onboarding: 'documents_pending' })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    const locked = await appears(page, '.onboarding-locked', 15000)
    await page.waitForTimeout(4500)
    await comeBackToApp(page)
    await page.waitForTimeout(1500)
    const note = await page.locator(testid('release-dialog')).count()
    record(`B-${t}`, 'A driver on the lock screen: nothing shown', 'the lock screen; the route never read; no logout; no note',
      `locked ${locked}, route read ${state.calls.release} times, logouts ${state.calls.logout}, note ${note}`, locked && state.calls.release === 0 && state.calls.logout === 0 && note === 0)
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
    }
    await pastItsSessionRun(browser, PHONE)
    await movingRun(browser, PHONE)
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
