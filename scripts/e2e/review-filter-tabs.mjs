#!/usr/bin/env node
// LogisX — the Needs Review toggle on Job Board and Active Loads, on made-up data only, at 1280 x 800 and 390 x 844.
// As a made-up Super Admin on the dashboard, for each of the two tabs:
//   RF0 the toggle off: every load listed, its count is the loads that need review, aria-pressed "false"
//   RF1 the toggle on: its rows, as many as its count, aria-pressed "true"
//   RF2 on, a search for a load that needs none: no rows, the count still over every load, and the line names the search
//   RF3 on, then the dashboard is read again with every flagged load fixed: the toggle stays on at (0), and the line
//       is the tab's own
//   RF4 then pressed: off, its button gone at (0), every load listed
//   RFx no page errors, nothing but GETs, and at 390 no sideways scroll
// Like completed-loads-filters.mjs: no server.js, database, settings file, key or sign-in. A built client is served
// from 127.0.0.1 (--port, default 3195; 3000, 3003, 5173 and 3901 refused, and so is a port in use), every /api
// request is answered in the browser with made-up fixtures, every other host is aborted, and nothing but GETs is
// answered. RF3's re-read is started through the page's own dashboard store, as a dashboard:changed socket event
// would start it (the socket is aborted here).
//   npm --prefix scripts/e2e ci          (once; playwright-core)
//   npm run build:client                 (the build under test)
//   node scripts/e2e/review-filter-tabs.mjs
//   node scripts/e2e/review-filter-tabs.mjs --phase before --dist /abs/path/to/a/main/build/client/dist
// --phase before marks a "before" run, on a build of main: a row that can't pass there records BEFORE with what it
// saw, not FAIL, and the run exits 0. --dist is an absolute path to a built client/dist (default: this checkout's).
// --shots is an absolute folder outside the checkout (default
// ~/LogisX-replica/reports/cc/work/review-filters-other-tabs/screens); the screenshots are named
// <phase>-<size>-<tab>-<step>-<what it shows>.png and the results go to results-<phase>.md there.
// Run it outside the Claude Code Bash sandbox (Chrome binds its own sockets). After: exit 0 only when every row PASSes.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import paths from './paths.cjs'

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const TAG = 'review-filter-tabs'
const PORT = Number(arg('--port') || 3195)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const HEADED = process.env.HEADED === '1'
const PHASE = arg('--phase') || 'after'
const DIST = path.resolve(arg('--dist') || path.join(paths.REPO, 'client', 'dist'))
const SHOTS = path.resolve(arg('--shots') || path.join(os.homedir(), 'LogisX-replica', 'reports', 'cc', 'work', 'review-filters-other-tabs', 'screens'))
const SIZES = [
  { tag: '1280x800', viewport: { width: 1280, height: 800 } },
  { tag: '390x844', viewport: { width: 390, height: 844 } },
]

function die(msg) {
  console.error(`${TAG}: ${msg}`)
  process.exit(2)
}
const insideRepo = (p) => { const rel = path.relative(paths.REPO, p); return !rel.startsWith('..') && !path.isAbsolute(rel) }
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) die(`--port must be a port number from 1024 to 65535; got "${arg('--port')}"`)
if ([3000, 3003, 5173, 3901].includes(PORT)) die(`refusing port ${PORT}: 3000 and 3003 are production's and staging's ports on the VPS, 5173 is Vite's and 3901 the replica's`)
if (!['before', 'after'].includes(PHASE)) die(`--phase is "before" or "after"; got "${PHASE}"`)
if (arg('--dist') && !path.isAbsolute(arg('--dist'))) die('--dist must be an absolute path')
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: build the client first`)
if (arg('--shots') && !path.isAbsolute(arg('--shots'))) die('--shots must be an absolute path')
if (insideRepo(SHOTS)) die(`--shots ${SHOTS} is inside the checkout: pick a folder outside it`)

// ---------------------------------------------------------------- made-up fixtures
const SUPER_ADMIN = { id: 91302, username: 'qa-review-tabs-superadmin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Review Tabs Super Admin', companyName: '', mustChangePassword: false }
const AWAIT = 'Awaiting Rate Con'
// [Load ID, Needs Review reason or '']: a blank Payment, an "Awaiting Rate Con" pickup, a driver-instructions code.
const FIXTURE = [
  ['QA-2001', 'payment'],
  ['QA-2002', ''],
  ['QA-2003', 'pickup'],
  ['QA-2004', ''],
  ['QA-2005', 'instructions'],
  ['QA-2006', ''],
  ['QA-2007', ''],
  ['QA-2008', ''],
]
const EVERY = FIXTURE.map(([id]) => id).sort()
const FLAGGED = FIXTURE.filter(([, why]) => why).map(([id]) => id).sort()
const HEADERS = ['Load ID', 'Driver', 'Job Status', 'Pickup Address', 'Drop-off Address', 'Payment']
// Set by RF3: the next /api/dashboard serves every flagged load fixed.
let fixed = false
function rows(status, driver, offset) {
  return FIXTURE.map(([id, why], i) => {
    const flag = fixed ? '' : why
    return {
      'Load ID': id, Driver: driver, 'Job Status': status,
      'Pickup Address': flag === 'pickup' ? AWAIT : 'Springfield, IL 62701', 'Drop-off Address': 'Riverton, WY 82501',
      Payment: flag === 'payment' ? '' : '$1,250.00', _rowIndex: offset + i, _id: offset + i,
      ...(flag === 'instructions' ? { _instructionsReview: ['no_rate_con'] } : {}),
    }
  })
}
function dashboard() {
  const unassignedJobs = rows('', '', 2)
  const activeJobs = rows('In Transit', 'Driver QA One', 20)
  return {
    timestamp: '2026-11-12T15:00:00.000Z',
    hiddenLoads: [],
    kpis: { activeLoads: activeJobs.length, unassignedLoads: unassignedJobs.length, completedThisWeek: 0, completedThisMonth: 0, fleetUtilization: { assigned: 0, total: 0 }, revenue: { total: 0, paid: 0, pending: 0 } },
    unassignedJobs, jobTrackingHeaders: HEADERS, completedHeaders: HEADERS, activeJobs, completedJobs: [],
    fleet: [], drivers: ['Driver QA One'], driverQueues: {},
  }
}
// Each tab's own words; the two search lines are lib/completedLoadsFilters.js's.
const TABS = [
  { key: 'job-board', label: 'Job Board', card: '.mobile-job-card', review: 'No unassigned loads need review.' },
  { key: 'active-loads', label: 'Active Loads', card: '.mobile-load-card', review: 'No loads currently need review — every active load has a complete rate-con.' },
]
const REVIEW_SEARCH = 'No loads that need review match your search.'

function answerGet(pathname) {
  const ok = (body) => ({ status: 200, body })
  if (pathname === '/api/auth/session') return ok({ authenticated: true, user: SUPER_ADMIN, appTimeZone: 'America/New_York' })
  if (pathname === '/api/dashboard') return ok(dashboard())
  if (pathname === '/api/load-ratings/averages') return ok({ averages: {} })
  if (pathname === '/api/truck-assignments') return ok({ assignments: [] })
  if (pathname === '/api/config/maps-key') return ok({ key: 'qa-review-tabs-no-key' })
  if (pathname === '/api/locations/latest') return ok({ locations: [] })
  if (pathname === '/api/dispatch-notifications') return ok({ notifications: [], unreadCount: 0 })
  if (pathname === '/api/admin/deleted-loads') return ok({ loads: [], count: 0 })
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the review filter tabs check"}')
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
const results = []
const unanswered = new Set()
const nonGets = []
const pageErrors = []
function record(step, title, expected, observed, ok, shotFile = '') {
  const verdict = ok ? 'PASS' : PHASE === 'before' ? 'BEFORE' : 'FAIL'
  if (verdict === 'FAIL') exitCode = 1
  results.push({ step, title, expected, observed, verdict, shotFile })
  console.log(`${verdict}  ${step}  ${title}: expected ${expected}; observed ${observed}`)
}
async function shot(page, size, tab, step, what) {
  fs.mkdirSync(SHOTS, { recursive: true, mode: 0o700 })
  const file = path.join(SHOTS, `${PHASE}-${size.tag}-${tab.key}-${step}-${what}.png`)
  await page.screenshot({ path: file, fullPage: true })
  return path.basename(file)
}

// ---------------------------------------------------------------- page helpers
const panel = (page) => page.locator('[role="tabpanel"][data-state="active"]')
const settle = async (page) => { await page.mouse.move(1, 1); await page.waitForTimeout(450) }
const phoneOf = (size) => size.viewport.width < 640
const rowLocator = (page, size, tab) => panel(page).locator(phoneOf(size) ? tab.card : 'tbody tr')
async function openPage(browser, size, tab) {
  fixed = false
  const phone = phoneOf(size)
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) return route.abort()
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (req.method() !== 'GET') { nonGets.push(`${req.method()} ${u.pathname}`); return route.fulfill({ status: 405, contentType: 'application/json', body: '{"error":"GET only in this check"}' }) }
    const out = answerGet(u.pathname)
    if (out === null) unanswered.add(u.pathname)
    return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', body: JSON.stringify(out ? out.body : {}) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag} ${tab.label}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.locator('[role="tab"]', { hasText: tab.label }).first().click({ timeout: 15000 })
  await rowLocator(page, size, tab).first().waitFor({ state: 'visible', timeout: 15000 })
  await settle(page)
  return { ctx, page }
}
const toggle = (page) => panel(page).locator('button', { hasText: /Needs Review \(\d+\)/ })
async function press(page) {
  await toggle(page).first().click({ timeout: 8000 })
  await settle(page)
}
async function search(page, q) {
  await panel(page).locator('.dash-search-bar input[type="text"]').first().fill(q)
  await settle(page)
}
// A dashboard re-read, as a dashboard:changed socket event starts one.
async function reread(page) {
  await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__
    await app.config.globalProperties.$pinia._s.get('dashboard').refresh()
  })
  await settle(page)
}
async function view(page, size, tab) {
  const b = toggle(page)
  let state = { shown: false, count: null, pressed: null }
  if (await b.count()) {
    const text = ((await b.first().textContent()) || '').replace(/\s+/g, ' ').trim()
    state = { shown: true, count: Number((/\((\d+)\)/.exec(text) || [])[1]), pressed: await b.first().getAttribute('aria-pressed') }
  }
  const ids = (await rowLocator(page, size, tab).allTextContents()).map((t) => (/QA-\d+/.exec(t) || [''])[0]).sort()
  const emptyEl = panel(page).locator('.py-16 .text-sm')
  const empty = (await emptyEl.count()) ? ((await emptyEl.first().textContent()) || '').replace(/\s+/g, ' ').trim() : ''
  return { ...state, ids, empty }
}
const brief = (v) => `Needs Review ${v.shown ? `(${v.count}) pressed=${v.pressed}` : 'hidden'}, rows ${v.ids.length}${v.ids.length ? ` [${v.ids.join(' ')}]` : ''}${v.empty ? `, empty line "${v.empty}"` : ''}`
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------- the steps
async function tabRun(browser, size, tab) {
  const at = `${size.tag}-${tab.key}`
  const { ctx, page } = await openPage(browser, size, tab)
  try {
    const v0 = await view(page, size, tab)
    const f0 = await shot(page, size, tab, 'RF0', 'toggle-off-every-load')
    record(`RF0-${at}`, `${tab.label}, the toggle off: every load listed, its count the loads that need review`,
      `${EVERY.length} rows; Needs Review (${FLAGGED.length}) pressed=false`, brief(v0),
      v0.ids.length === EVERY.length && v0.count === FLAGGED.length && v0.pressed === 'false', f0)

    await press(page)
    const v1 = await view(page, size, tab)
    const f1 = await shot(page, size, tab, 'RF1', 'toggle-on-its-rows')
    record(`RF1-${at}`, `${tab.label}, the toggle on: its rows, as many as its count`,
      `rows [${FLAGGED.join(' ')}] = Needs Review (${FLAGGED.length}) pressed=true`, brief(v1),
      same(v1.ids, FLAGGED) && v1.count === v1.ids.length && v1.pressed === 'true', f1)

    await search(page, 'QA-2002')
    const v2 = await view(page, size, tab)
    const f2 = await shot(page, size, tab, 'RF2', 'on-search-line-names-search')
    record(`RF2-${at}`, `${tab.label}, on, a search for a load that needs none: the line names the search`,
      `0 rows; Needs Review (${FLAGGED.length}) pressed=true; "${REVIEW_SEARCH}"`, brief(v2),
      v2.ids.length === 0 && v2.count === FLAGGED.length && v2.pressed === 'true' && v2.empty === REVIEW_SEARCH, f2)
    await search(page, '')

    fixed = true
    await reread(page)
    const v3 = await view(page, size, tab)
    const f3 = await shot(page, size, tab, 'RF3', 'on-at-zero-stays')
    record(`RF3-${at}`, `${tab.label}, on, then every flagged load fixed: the toggle stays on at (0)`,
      `Needs Review (0) pressed=true; 0 rows; "${tab.review}"`, brief(v3),
      v3.shown && v3.count === 0 && v3.pressed === 'true' && v3.ids.length === 0 && v3.empty === tab.review, f3)

    if (v3.shown) await press(page)
    const v4 = await view(page, size, tab)
    const f4 = await shot(page, size, tab, 'RF4', 'off-at-zero-every-load')
    record(`RF4-${at}`, `${tab.label}, then pressed: off, its button gone, every load listed`,
      `Needs Review hidden; ${EVERY.length} rows`, brief(v4),
      v3.shown && !v4.shown && same(v4.ids, EVERY), f4)

    if (phoneOf(size)) {
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      record(`RFx-${at}-scroll`, `${tab.label} at 390 has no sideways scroll`, 'scrollWidth - innerWidth <= 1', String(sideways), sideways <= 1)
    }
  } catch (e) {
    record(`RF-${at}`, `${tab.label}, the steps run`, 'the steps run', `stopped: ${String(e.message || e).slice(0, 160)}`, false)
  } finally {
    await ctx.close()
  }
}

function writeResults() {
  const file = path.join(SHOTS, `results-${PHASE}.md`)
  const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const lines = [
    `# Needs Review on Job Board and Active Loads, ${PHASE}`, '',
    `Build: ${cell(DIST)}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => `| ${cell(r.step)} | ${cell(r.title)} | ${cell(r.expected)} | ${cell(r.observed)} | ${r.verdict} | ${cell(r.shotFile)} |`),
  ]
  fs.mkdirSync(SHOTS, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use (another e2e server?): pass --port with a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve) })
  console.log(`${TAG}: serving ${DIST} on ${BASE} (phase ${PHASE}; made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const size of SIZES) {
      for (const tab of TABS) await tabRun(browser, size, tab)
    }
  } finally {
    await browser.close()
    server.close()
  }
  record('RFx-errors', 'No page errors and nothing but GETs', 'none', `${pageErrors.length} page error(s)${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}; non-GETs ${JSON.stringify(nonGets)}`, pageErrors.length === 0 && nonGets.length === 0)
  const resultsFile = writeResults()
  console.log(`${TAG}: endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`)
  const count = (v) => results.filter((r) => r.verdict === v).length
  console.log(`${TAG}: ${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('BEFORE')} BEFORE; results ${resultsFile}; screenshots ${SHOTS}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`${TAG}: aborted: ${e.stack || e}`)
  process.exit(1)
})
