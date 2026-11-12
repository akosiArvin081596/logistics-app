#!/usr/bin/env node
// LogisX — the dashboard's Driver Performance tab, on made-up data only, at 1280 x 800 (and its cards at 390 x 844).
// As a made-up Super Admin on the dashboard:
//   AP1 the tab "Driver Performance", last, after Fleet & Drivers, with no count; opened: "Drivers' weeks", the week's
//       line and the target line, then the drivers in the server's order, each row with his name, unit, this week's
//       figure of its target, the pace word, the bar in the server's color, what's left, and last week's final figure
//   AP2 a row opens what counted this week and last, in his own tab's words, and his past weeks with
//       "Driving hours: coming soon" and the "weren't counted" line; its button says it is open
//   AP3 "Not on the board" starts collapsed; opened, each name with its reason in words
//   AP4 "Board by unit": the existing board, its four tiles and Most loads' unit rows, as /driver shows it to a Super Admin
//   AP5 the switch off (the tab's read answers 404 FEATURE_OFF): no tab
//   AP6 a Dispatcher: no tab, and the drivers' weeks never asked for
//   AP7 at 390: one card per driver, each row's button 44 px or more, no sideways scroll
//   APx no page errors, and nothing but GETs
// Every answer comes from the real rules (lib/driver-performance.js) over made-up figures, in the shapes the routes send,
// with the hours switch off, and every expected word from the tab's own lib (client/src/lib/driverPerformanceAdmin.js).
// Like completed-loads-filters.mjs: no server.js, database, settings file, key or sign-in. A built client is served from
// 127.0.0.1, every /api request is answered in the browser, every other host is aborted, and nothing but GETs is answered.
//   npm --prefix scripts/e2e ci          (once; playwright-core)
//   npm --prefix client run build        (the build under test)
//   node scripts/e2e/admin-driver-performance.mjs
// Env: E2E_PORT (default: a free port; 3000, 3003, 5173 and 3901 are refused, and so is a port in use), HEADED=1,
// CHROME_PATH, SHOT_DIR (an absolute folder outside the checkout; default
// ~/LogisX-replica/reports/cc/work/admin-driver-performance/screens). Run it outside the Claude Code Bash sandbox (Chrome
// binds its own sockets). Output: PASS/FAIL lines, the screenshots and <SHOT_DIR>/results.md. Exit 0 only when every row PASSes.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import paths from './paths.cjs'
import { REASONS, WORDS, driversView } from '../../client/src/lib/driverPerformanceAdmin.js'
import { CATEGORIES as BOARD_TILES } from '../../client/src/lib/driverPerformance.js'

const require = createRequire(import.meta.url)
const perf = require('../../lib/driver-performance.js')

const TAG = 'admin-driver-performance'
const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.homedir(), 'LogisX-replica', 'reports', 'cc', 'work', TAG, 'screens')
const DESK = { tag: '1280x800', viewport: { width: 1280, height: 800 } }
const PHONE = { tag: '390x844', viewport: { width: 390, height: 844 } }
const WEEKS_URL = '/api/admin/driver-performance/weeks'
const REFUSED_PORTS = [3000, 3003, 5173, 3901]

function die(msg) {
  console.error(`${TAG}: ${msg}`)
  process.exit(2)
}
if (process.env.E2E_PORT && (!Number.isInteger(ASKED_PORT) || ASKED_PORT < 1024 || ASKED_PORT > 65535)) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (REFUSED_PORTS.includes(ASKED_PORT)) die(`refusing port ${ASKED_PORT}: 3000 and 3003 are production's and staging's on the VPS, 5173 is Vite's and 3901 the replica's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm --prefix client run build\` first`)
if (process.env.SHOT_DIR && !path.isAbsolute(process.env.SHOT_DIR)) die('SHOT_DIR must be an absolute path')
{
  const rel = path.relative(paths.REPO, SHOT_DIR)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) die(`SHOT_DIR ${SHOT_DIR} is inside the checkout: pick a folder outside it`)
}

// ---------------------------------------------------------------- made-up fixtures
const SUPER_ADMIN = { id: 91401, username: 'qa-perf-superadmin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Performance Super Admin', companyName: '', mustChangePassword: false }
const DISPATCHER = { id: 91402, username: 'qa-perf-dispatcher', role: 'Dispatcher', driverName: '', email: '', fullName: 'QA Performance Dispatcher', companyName: '', mustChangePassword: false }
const DAY = 24 * 60 * 60 * 1000
// The business day in the app's zone and its Sat-Fri week, by calendar arithmetic as getWeekRange() reads a bare day.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const weekRangeOf = (day) => {
  const d = new Date(`${day}T12:00:00Z`)
  const sat = new Date(d.getTime() - ((d.getUTCDay() + 1) % 7) * DAY)
  return { start: sat.toISOString().slice(0, 10), end: new Date(sat.getTime() + 6 * DAY).toISOString().slice(0, 10) }
}
const THIS = weekRangeOf(TODAY)
const LAST = { start: perf.addDays(THIS.start, -7), end: perf.addDays(THIS.end, -7) }
const PAST = [1, 2, 3].map((n) => ({ start: perf.addDays(THIS.start, -7 * n), end: perf.addDays(THIS.end, -7 * n) }))
const COUNTED_FROM = perf.countedFrom(PAST[PAST.length - 1].start)
// "Nov 9", as the board writes a handover's day.
const HANDOVER_DAY = perf.countedFrom(perf.addDays(THIS.start, 2))

// One driver's own answer, as GET /api/driver/me/performance sends it, through the real rules.
function ownAnswer({ id, deliveries, pickups, offDays = [], last = [6, 6], past = [[6, 6], [5, 4], [2, 1]] }) {
  const loads = Array.from({ length: Math.max(deliveries, pickups) }, (_x, i) => perf.countedLoad({
    loadId: `QA-${id}${String(i).padStart(2, '0')}`,
    pickupDay: i < pickups ? THIS.start : '',
    deliveryDay: i < deliveries ? THIS.start : '',
    pickupNote: i < pickups ? '' : 'last-week',
  }))
  const lastLoads = [perf.countedLoad({ loadId: `QA-${id}90`, pickupDay: LAST.start, deliveryDay: perf.addDays(LAST.start, 1) })]
  return {
    view: 'no-hours-data',
    creditWeights: { ...perf.CREDIT_WEIGHTS },
    weeks: [
      perf.personalWeek({ id: 'this-week', start: THIS.start, end: THIS.end, today: TODAY, deliveries, pickups, loads, offDays, openLoad: true }),
      perf.personalWeek({ id: 'last-week', start: LAST.start, end: LAST.end, today: TODAY, deliveries: last[0], pickups: last[1], loads: lastLoads, offDays: [], openLoad: false }),
    ],
    pastWeeks: PAST.map((w, i) => perf.pastWeek({ start: w.start, end: w.end, deliveries: past[i][0], pickups: past[i][1], offDays: [] })),
    countedFrom: COUNTED_FROM,
  }
}
// The server's order: this week's credits, highest first, then by name.
const WEEKS = {
  drivers: [
    { directoryId: 4, name: 'Sky Demo', unit: '#704', performance: ownAnswer({ id: 4, deliveries: 8, pickups: 8 }) },
    { directoryId: 1, name: 'Avery Mock', unit: '#701', performance: ownAnswer({ id: 1, deliveries: 4, pickups: 4 }) },
    { directoryId: 2, name: 'Jordan Sample', unit: `#702 (2, from ${HANDOVER_DAY})`, performance: ownAnswer({ id: 2, deliveries: 3, pickups: 0, offDays: [perf.addDays(THIS.start, 5)], last: [0, 0], past: [[0, 0], [3, 3], [1, 0]] }) },
    { directoryId: 3, name: 'Riley Placeholder', unit: '', performance: ownAnswer({ id: 3, deliveries: 1, pickups: 0 }) },
  ],
  notOnBoard: [
    { name: 'Morgan Test', reason: 'percentage-driver' },
    { name: 'Quinn Mock', reason: 'owner-operator' },
    { name: 'Riley Placeholder', reason: 'no-truck-in-period' },
  ],
}
const WANT = driversView(WEEKS)
if (!WANT || WANT.rows.length !== WEEKS.drivers.length) die('the made-up answer does not hold whole through the tab\'s own view')

// The board by unit, as the leaderboard route sends it to a Super Admin.
const mostLoads = perf.categoryById('most-loads')
const ranked = perf.rankEntries(mostLoads, [
  { driverId: 4, label: '#704', ownLabel: '#704', value: 8 },
  { driverId: 1, label: '#701', ownLabel: '#701', value: 4 },
  { driverId: 2, label: '#702 (2)', ownLabel: `#702 (2, from ${HANDOVER_DAY})`, value: 3 },
])
const boardOf = (id, start, end) => ({ id, start, end, categories: perf.CATEGORIES.map((c) => perf.projectCategory(c, c.live ? ranked : [], null)) })
const BOARD = {
  week: { period: 'week', view: perf.BOARD_VIEW, boards: [boardOf('this-week', THIS.start, THIS.end), boardOf('last-week', LAST.start, LAST.end)] },
  month: { period: 'month', view: perf.BOARD_VIEW, boards: [boardOf('this-month', `${TODAY.slice(0, 7)}-01`, TODAY)] },
}
const BOARD_UNITS = ranked.map((e) => e.label)

const DASHBOARD = {
  timestamp: new Date().toISOString(),
  hiddenLoads: [],
  kpis: { activeLoads: 0, unassignedLoads: 0, completedThisWeek: 0, completedThisMonth: 0, fleetUtilization: { assigned: 0, total: 0 }, revenue: { total: 0, paid: 0, pending: 0 } },
  unassignedJobs: [], jobTrackingHeaders: ['Load ID', 'Driver', 'Job Status'], completedHeaders: ['Load ID', 'Driver', 'Job Status'], activeJobs: [], completedJobs: [],
  fleet: [], drivers: WEEKS.drivers.map((d) => d.name), driverQueues: {},
}

// One browser's server. weeksStatus: what the tab's read answers (404 is its switch off).
function freshState({ user = SUPER_ADMIN, weeksStatus = 200 } = {}) {
  return { user, weeksStatus, weeksReads: 0 }
}
function answerGet(state, u) {
  const ok = (body) => ({ status: 200, body })
  const p = u.pathname
  if (p === '/api/auth/session') return ok({ authenticated: true, user: state.user, appTimeZone: 'America/New_York' })
  if (p === WEEKS_URL) {
    state.weeksReads++
    if (state.user.role !== 'Super Admin') return { status: 403, body: { error: 'Forbidden' } }
    if (state.weeksStatus !== 200) return { status: state.weeksStatus, body: { error: 'Not found', code: 'FEATURE_OFF' } }
    return ok(WEEKS)
  }
  if (p === '/api/driver/performance/leaderboard') return ok(BOARD[u.searchParams.get('period') === 'month' ? 'month' : 'week'])
  if (p === '/api/dashboard') return ok(DASHBOARD)
  if (p === '/api/load-ratings/averages') return ok({ averages: {} })
  if (p === '/api/truck-assignments') return ok({ assignments: [] })
  if (p === '/api/config/maps-key') return ok({ key: 'qa-perf-no-key' })
  if (p === '/api/locations/latest') return ok({ locations: [] })
  if (p === '/api/dispatch-notifications') return ok({ notifications: [], unreadCount: 0 })
  if (p === '/api/admin/deleted-loads') return ok({ loads: [], count: 0 })
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the Driver Performance check"}')
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
let exitCode = 0
const rows = []
const unanswered = new Set()
const nonGets = []
const pageErrors = []
function record(step, title, expected, observed, ok, shotFile = '') {
  if (!ok) exitCode = 1
  rows.push({ step, title, expected, observed, verdict: ok ? 'PASS' : 'FAIL', shotFile })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${observed}`)
}
async function shot(page, size, step, what) {
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(SHOT_DIR, `${size.tag}-${step}-${what}.png`)
  await page.screenshot({ path: file, fullPage: true })
  return path.basename(file)
}

// ---------------------------------------------------------------- page helpers
const squeeze = (t) => (t || '').replace(/\s+/g, ' ').trim()
const testid = (id) => `[data-testid="${id}"]`
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const panel = (page) => page.locator('[role="tabpanel"][data-state="active"]')
const allText = (loc) => loc.allTextContents().then((list) => list.map(squeeze))
const text = (loc) => loc.first().textContent({ timeout: 3000 }).then(squeeze, () => '')
async function until(check, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}
async function openDashboard(browser, size, options = {}) {
  const state = freshState(options)
  const phone = size.viewport.width < 640
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) return route.abort()
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (req.method() !== 'GET') { nonGets.push(`${req.method()} ${u.pathname}`); return route.fulfill({ status: 405, contentType: 'application/json', body: '{"error":"GET only in this check"}' }) }
    const out = answerGet(state, u)
    if (out === null) unanswered.add(u.pathname)
    return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out ? out.body : {}) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.locator('[role="tab"]', { hasText: 'Fleet & Drivers' }).first().waitFor({ state: 'visible', timeout: 15000 })
  return { ctx, page, state }
}
const tabTexts = (page) => allText(page.locator('[role="tab"]'))
async function openTab(page) {
  const trigger = page.locator('[role="tab"]', { hasText: WORDS.tab }).first()
  await trigger.waitFor({ state: 'attached', timeout: 10000 })
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  await panel(page).locator(testid('adp-drivers')).first().waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(400)
}
const fieldsOf = (loc, ids) => loc.evaluateAll((els, list) => els.map((el) => list.map((id) => ((el.querySelector(`[data-testid="${id}"]`) || {}).textContent || '').replace(/\s+/g, ' ').trim())), ids)
const RGB = { red: 'rgb(220, 38, 38)', orange: 'rgb(234, 88, 12)', green: 'rgb(22, 163, 74)', blue: 'rgb(37, 99, 235)', '': 'rgb(3, 105, 161)' }

// ---------------------------------------------------------------- AP1-AP4, at 1280
async function deskRun(browser) {
  const size = DESK
  const { ctx, page, state } = await openDashboard(browser, size)
  try {
    const shown = await until(async () => (await page.locator('[role="tab"]', { hasText: WORDS.tab }).count()) > 0, 10000)
    const tabs = await tabTexts(page)
    const badge = await page.locator('[role="tab"]', { hasText: WORDS.tab }).first().locator('.font-mono').count()
    await openTab(page)
    const p = panel(page)
    const headings = [await text(p.locator(testid('adp-weeks-title'))), await text(p.locator(testid('adp-board-title')))]
    const weekLine = await text(p.locator(testid('adp-week-line')))
    const target = await text(p.locator(testid('adp-target')))
    const seen = await fieldsOf(p.locator(testid('adp-driver')), ['adp-name', 'adp-unit', 'adp-count', 'adp-pace', 'adp-left', 'adp-last-count'])
    const fills = await p.locator(testid('adp-fill')).evaluateAll((els) => els.map((el) => [el.getAttribute('data-color') || '', getComputedStyle(el).backgroundColor, el.style.width]))
    const want = WANT.rows.map((r) => [r.name, r.unit, r.count, r.pace, r.left, r.lastCount])
    const wantFills = WANT.rows.map((r) => [r.color, RGB[r.color], r.width])
    const labels = await allText(p.locator(`${testid('adp-driver')} .adp-label`))
    record(`AP1-${size.tag}`, 'The tab, last, after Fleet & Drivers; the drivers in the server\'s order, each as his own screen words him',
      `tabs end ["Fleet & Drivers …", "${WORDS.tab}"], no count on it; headings ${JSON.stringify([WORDS.weeksTitle, WORDS.boardTitle])}; "${WANT.weekLine}"; "${WORDS.target}"; rows ${JSON.stringify(want)}; fills ${JSON.stringify(wantFills)}; labels "${WORDS.thisWeek}" and "${WORDS.lastWeek}" on each row`,
      `shown ${shown}, tabs ${JSON.stringify(tabs)}, badge ${badge}, headings ${JSON.stringify(headings)}, week line "${weekLine}", target "${target}", rows ${JSON.stringify(seen)}, fills ${JSON.stringify(fills)}, labels ${JSON.stringify(labels)}`,
      shown && tabs[tabs.length - 1] === WORDS.tab && /^Fleet & Drivers/.test(tabs[tabs.length - 2] || '') && badge === 0
        && same(headings, [WORDS.weeksTitle, WORDS.boardTitle]) && weekLine === WANT.weekLine && target === WORDS.target
        && same(seen, want) && same(fills, wantFills) && same(labels, WANT.rows.flatMap(() => [WORDS.thisWeek, WORDS.lastWeek])),
      await shot(page, size, 'AP1', 'drivers-weeks'))

    // AP2: the first row opens.
    const first = p.locator(testid('adp-driver')).first()
    const closedBefore = [await first.locator(testid('adp-toggle')).getAttribute('aria-expanded'), await first.locator(testid('adp-detail')).count()]
    await first.locator(testid('adp-toggle')).click()
    await first.locator(testid('adp-detail')).waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForTimeout(300)
    const expanded = await first.locator(testid('adp-toggle')).getAttribute('aria-expanded')
    const w = WANT.rows[0]
    const loadsOf = (id) => first.locator(testid(id)).evaluateAll((els) => els.map((el) => [...el.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim())))
    const thisLoads = await loadsOf('adp-this-load')
    const lastLoads = await loadsOf('adp-last-load')
    const past = await fieldsOf(first.locator(testid('adp-past-week')), ['adp-past-range', 'adp-past-count', 'adp-past-hours'])
    const titles = [await text(first.locator(testid('adp-this-title'))), await text(first.locator(testid('adp-last-title'))), await text(first.locator(testid('adp-past-title')))]
    const lines = [await text(first.locator(testid('adp-rule'))), await text(first.locator(testid('adp-requirement'))), await text(first.locator(testid('adp-hours'))), await text(first.locator(testid('adp-counted-from')))]
    const wantThis = w.thisWeek.loads.map((l) => [l.title, l.line])
    const wantLast = w.lastWeek.loads.map((l) => [l.title, l.line])
    const wantPast = w.past.rows.map((r) => [r.range, r.count, r.hours])
    const otherOpen = await p.locator(testid('adp-detail')).count()
    record(`AP2-${size.tag}`, 'A row opens what counted this week and last and his past weeks, in his own tab\'s words, with the hours coming soon',
      `closed first (aria-expanded false, no detail); then "true"; titles ${JSON.stringify([w.thisWeek.title, w.lastWeek.title, w.past.title])}; this week ${JSON.stringify(wantThis)}; last week ${JSON.stringify(wantLast)}; past ${JSON.stringify(wantPast)}; lines ${JSON.stringify([w.thisWeek.rule, w.thisWeek.requirement, WORDS.driveHours, w.past.countedFrom])}; only that row open`,
      `before ${JSON.stringify(closedBefore)}, after "${expanded}", titles ${JSON.stringify(titles)}, this ${JSON.stringify(thisLoads)}, last ${JSON.stringify(lastLoads)}, past ${JSON.stringify(past)}, lines ${JSON.stringify(lines)}, open details ${otherOpen}`,
      same(closedBefore, ['false', 0]) && expanded === 'true' && same(titles, [w.thisWeek.title, w.lastWeek.title, w.past.title])
        && same(thisLoads, wantThis) && same(lastLoads, wantLast) && same(past, wantPast) && past.every((r) => r[2] === WORDS.driveHours)
        && same(lines, [w.thisWeek.rule, w.thisWeek.requirement, WORDS.driveHours, w.past.countedFrom]) && otherOpen === 1,
      await shot(page, size, 'AP2', 'row-open-what-counted-and-past-weeks'))

    // AP2b: a lowered target on the third row says so in the office's words.
    const third = p.locator(testid('adp-driver')).nth(2)
    await third.locator(testid('adp-toggle')).click()
    await third.locator(testid('adp-detail')).waitFor({ state: 'visible', timeout: 5000 })
    const lowered = await text(third.locator(testid('adp-lowered')))
    const thirdCount = await text(third.locator(testid('adp-count')))
    record(`AP2b-${size.tag}`, 'A week with a day off: his lower target, and the line saying why', `"${WANT.rows[2].count}"; "${WORDS.lowered}"`, `"${thirdCount}"; "${lowered}"`,
      thirdCount === WANT.rows[2].count && lowered === WORDS.lowered, await shot(page, size, 'AP2b', 'lowered-target'))

    // AP3: Not on the board.
    const off = p.locator(testid('adp-not-on-board'))
    const openBefore = await off.evaluate((el) => el.open).catch(() => null)
    const summary = await text(off.locator(testid('adp-not-on-board-title')))
    await off.locator(testid('adp-not-on-board-title')).click()
    await page.waitForTimeout(250)
    const openAfter = await off.evaluate((el) => el.open).catch(() => null)
    const offRows = await fieldsOf(off.locator(testid('adp-off-row')), ['adp-off-name', 'adp-off-reason'])
    const wantOff = WEEKS.notOnBoard.map((x) => [x.name, REASONS[x.reason]])
    await off.scrollIntoViewIfNeeded()
    record(`AP3-${size.tag}`, '"Not on the board" starts collapsed; opened, each name with its reason',
      `closed, "${WORDS.notOnBoardTitle}"; then open with ${JSON.stringify(wantOff)}`, `open before ${openBefore}, "${summary}", open after ${openAfter}, rows ${JSON.stringify(offRows)}`,
      openBefore === false && summary === WORDS.notOnBoardTitle && openAfter === true && same(offRows, wantOff),
      await shot(page, size, 'AP3', 'not-on-the-board-open'))

    // AP4: the board by unit.
    const board = p.locator(testid('perf-board'))
    await board.first().scrollIntoViewIfNeeded()
    await board.locator(testid('perf-tile')).first().waitFor({ state: 'visible', timeout: 8000 })
    const tiles = await allText(board.locator(`${testid('perf-tile')} .perf-title`))
    const units = await allText(board.locator(`${testid('perf-tile')}[data-category="most-loads"] .perf-unit`))
    const names = await board.evaluate((el, list) => list.filter((n) => el.textContent.includes(n)), WEEKS.drivers.map((d) => d.name))
    record(`AP4-${size.tag}`, '"Board by unit": the existing board, its four tiles and Most loads\' units, no names',
      `tiles ${JSON.stringify(BOARD_TILES.map((c) => c.title))}; units ${JSON.stringify(BOARD_UNITS)}; no driver's name in it`,
      `tiles ${JSON.stringify(tiles)}, units ${JSON.stringify(units)}, names ${JSON.stringify(names)}, reads of the drivers' weeks ${state.weeksReads}`,
      same(tiles, BOARD_TILES.map((c) => c.title)) && same(units, BOARD_UNITS) && names.length === 0,
      await shot(page, size, 'AP4', 'board-by-unit'))
  } catch (e) {
    record(`AP1-4-${size.tag}`, 'The tab runs', 'the steps run', `stopped: ${String(e.message || e).slice(0, 200)}`, false)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- AP5, AP6: no tab
async function hiddenRun(browser) {
  const size = DESK
  {
    const { ctx, page, state } = await openDashboard(browser, size, { weeksStatus: 404 })
    try {
      const asked = await until(() => state.weeksReads > 0, 10000)
      await page.waitForTimeout(800)
      const tabs = await tabTexts(page)
      record(`AP5-${size.tag}`, 'The switch off: the read answers 404 FEATURE_OFF, and there is no Driver Performance tab',
        `one read; tabs without "${WORDS.tab}"`, `asked ${asked} (${state.weeksReads}), tabs ${JSON.stringify(tabs)}`,
        asked && !tabs.includes(WORDS.tab), await shot(page, size, 'AP5', 'switch-off-no-tab'))
    } catch (e) {
      record(`AP5-${size.tag}`, 'The switch off', 'the step runs', `stopped: ${String(e.message || e).slice(0, 200)}`, false)
    } finally {
      await ctx.close()
    }
  }
  {
    const { ctx, page, state } = await openDashboard(browser, size, { user: DISPATCHER })
    try {
      await page.waitForTimeout(2500)
      const tabs = await tabTexts(page)
      record(`AP6-${size.tag}`, 'A Dispatcher: no Driver Performance tab, and the drivers\' weeks never asked for',
        `tabs without "${WORDS.tab}"; 0 reads`, `tabs ${JSON.stringify(tabs)}, reads ${state.weeksReads}`,
        !tabs.includes(WORDS.tab) && state.weeksReads === 0, await shot(page, size, 'AP6', 'dispatcher-no-tab'))
    } catch (e) {
      record(`AP6-${size.tag}`, 'A Dispatcher', 'the step runs', `stopped: ${String(e.message || e).slice(0, 200)}`, false)
    } finally {
      await ctx.close()
    }
  }
}

// ---------------------------------------------------------------- AP7: the cards at 390
async function phoneRun(browser) {
  const size = PHONE
  const { ctx, page } = await openDashboard(browser, size)
  try {
    await openTab(page)
    const p = panel(page)
    const names = await allText(p.locator(testid('adp-name')))
    const boxes = await p.locator(testid('adp-toggle')).evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }))
    const stacked = await p.locator(testid('adp-driver')).first().evaluate((el) => {
      const top = (id) => Math.round(el.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().top)
      return top('adp-name') < top('adp-count') && top('adp-count') < top('adp-last-count')
    })
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    await p.locator(testid('adp-driver')).first().locator(testid('adp-toggle')).click()
    await page.waitForTimeout(300)
    const sidewaysOpen = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    record(`AP7-${size.tag}`, 'At 390: one card per driver, name, then this week, then last week; 44 px buttons; no sideways scroll, closed or open',
      `names ${JSON.stringify(WANT.rows.map((r) => r.name))}; each button 44 px or taller and no wider than the screen; stacked; scroll <= 1`,
      `names ${JSON.stringify(names)}, buttons ${JSON.stringify(boxes)}, stacked ${stacked}, sideways ${sideways} / open ${sidewaysOpen}`,
      same(names, WANT.rows.map((r) => r.name)) && boxes.length === WANT.rows.length && boxes.every(([wd, h]) => h >= 44 && wd <= size.viewport.width) && stacked && sideways <= 1 && sidewaysOpen <= 1,
      await shot(page, size, 'AP7', 'cards'))
  } catch (e) {
    record(`AP7-${size.tag}`, 'The cards at 390', 'the step runs', `stopped: ${String(e.message || e).slice(0, 200)}`, false)
  } finally {
    await ctx.close()
  }
}

function writeResults() {
  const file = path.join(SHOT_DIR, 'results.md')
  const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const lines = [
    '# Driver Performance tab check', '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${cell(r.step)} | ${cell(r.title)} | ${cell(r.expected)} | ${cell(r.observed)} | ${r.verdict} | ${cell(r.shotFile)} |`),
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`, '',
  ]
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 })
  return file
}

async function main() {
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ASKED_PORT, HOST, resolve) })
  PORT = server.address().port
  if (REFUSED_PORTS.includes(PORT)) { server.close(); die(`the system picked port ${PORT}: set E2E_PORT to a free one`) }
  BASE = `http://${HOST}:${PORT}`
  console.log(`${TAG}: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    await deskRun(browser)
    await hiddenRun(browser)
    await phoneRun(browser)
  } finally {
    await browser.close()
    server.close()
  }
  record('APx', 'No page errors, and nothing but GETs', 'none', `${pageErrors.length} page error(s)${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}; non-GETs ${JSON.stringify(nonGets)}`, pageErrors.length === 0 && nonGets.length === 0)
  const resultsFile = writeResults()
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`${TAG}: ${passed}/${rows.length} PASS, ${rows.length - passed} FAIL; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  process.exit(exitCode)
}

main().catch((err) => {
  console.error(`${TAG}: FAILED:`, err && err.stack ? err.stack : err)
  process.exit(1)
})
