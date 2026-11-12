#!/usr/bin/env node
// LogisX — Completed Loads' Needs Review and Needs attention toggles, on made-up data only, at 1280 x 800 and 390 x 844.
// As a made-up Super Admin on the dashboard's Completed tab, with automatic drafts on:
//   CF0 the list with no toggle on: each count is the rows its toggle shows
//   CF1 Needs Review on: its rows, aria-pressed "true", Needs attention "false"
//   CF2 then Needs attention: Needs Review goes off, one toggle on at a time, its rows listed
//   CF3 a driver, then dates: both counts follow the driver and dates, and a pressed toggle's count is the rows listed
//   CF4 an empty list: Needs Review on for a driver with none stays on at (0) and the line names it; Needs attention
//       on for dates with none, the same
//   CF5 both toggles show "on" the same way: the same colours on, the same off, aria-pressed on both
//   CFx no page errors, and at 390 no sideways scroll
// Like chr-send-badge.mjs: no server.js, database, settings file, key or sign-in. A built client is served from
// 127.0.0.1 (--port, default 3194; 3000, 3003, 5173 and 3901 refused, and so is a port in use), every /api request is
// answered in the browser with made-up fixtures, every other host is aborted, and nothing but GETs is answered.
//   npm --prefix scripts/e2e ci          (once; playwright-core)
//   npm run build:client                 (the build under test)
//   node scripts/e2e/completed-loads-filters.mjs
//   node scripts/e2e/completed-loads-filters.mjs --phase before --dist /abs/path/to/a/main/build/client/dist
// --phase before marks a "before" run, on a build of main: a row that can't pass there records BEFORE with what it
// saw, not FAIL, and the run exits 0. --dist is an absolute path to a built client/dist (default: this checkout's).
// --shots is an absolute folder outside the checkout (default ~/LogisX-replica/reports/cc/work/completed-filters/screens);
// the screenshots are named <phase>-<size>-<step>-<what it shows>.png and the results go to results-<phase>.md there.
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
const TAG = 'completed-loads-filters'
const PORT = Number(arg('--port') || 3194)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const HEADED = process.env.HEADED === '1'
const PHASE = arg('--phase') || 'after'
const DIST = path.resolve(arg('--dist') || path.join(paths.REPO, 'client', 'dist'))
const SHOTS = path.resolve(arg('--shots') || path.join(os.homedir(), 'LogisX-replica', 'reports', 'cc', 'work', 'completed-filters', 'screens'))
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
const SUPER_ADMIN = { id: 91301, username: 'qa-filters-superadmin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Filters Super Admin', companyName: '', mustChangePassword: false }
const D1 = 'Driver QA One'
const D2 = 'Driver QA Two'
const D3 = 'Driver QA Three'
// [Load ID, driver, Completion Date as recorded, needs review (a blank Payment), needs attention (the automatic draft)].
// No load is both, as in the reported case, so both toggles on together showed nothing.
const FIXTURE = [
  ['QA-1001', D1, '10/05/2026 14:00:00', true, false],
  ['QA-1002', D1, '11/03/2026 09:30:00', true, false],
  ['QA-1003', D1, '11/04/2026 16:10:00', false, true],
  ['QA-1004', D2, '10/06/2026 11:00:00', true, false],
  ['QA-1005', D2, '11/05/2026 08:45:00', true, false],
  ['QA-1006', D2, '10/07/2026 13:20:00', false, true],
  ['QA-1007', D2, '11/06/2026 17:05:00', false, true],
  ['QA-1008', D1, '10/08/2026 10:00:00', false, false],
  ['QA-1009', D2, '11/07/2026 12:00:00', false, false],
  ['QA-1010', D3, '11/09/2026 15:00:00', false, false],
  ['QA-1011', D1, '12/01/2026 09:00:00', true, false],
]
const HEADERS = ['Load ID', 'Driver', 'Job Status', 'Pickup Address', 'Drop-off Address', 'Payment', 'Completion Date']
const COMPLETED = FIXTURE.map(([id, driver, day, review, attention], i) => ({
  'Load ID': id, Driver: driver, 'Job Status': 'Delivered',
  'Pickup Address': 'Springfield, IL 62701', 'Drop-off Address': 'Riverton, WY 82501',
  Payment: review ? '' : '$1,250.00', 'Completion Date': day, _rowIndex: i + 2, _id: i + 2,
  ...(attention ? { _autoInvoice: { state: 'needs_attention', code: 'NO_BROKER_EMAIL' } } : {}),
}))
const ORACLE = FIXTURE.map(([id, driver, day, review, attention]) => ({ id, driver, review, attention, day: `${day.slice(6, 10)}-${day.slice(0, 2)}-${day.slice(3, 5)}` }))
const NOV = ['2026-11-01', '2026-11-30']
const DEC = ['2026-12-01', '2026-12-31']
const poolOf = ({ driver = '', dates = null } = {}) => ORACLE.filter((r) => (!driver || r.driver === driver) && (!dates || (r.day >= dates[0] && r.day <= dates[1])))
const idsOf = (rows) => rows.map((r) => r.id).sort()
const DASHBOARD = {
  timestamp: '2026-11-12T15:00:00.000Z',
  hiddenLoads: [],
  kpis: { activeLoads: 0, unassignedLoads: 0, completedThisWeek: 0, completedThisMonth: COMPLETED.length, fleetUtilization: { assigned: 0, total: 0 }, revenue: { total: 0, paid: 0, pending: 0 } },
  unassignedJobs: [], jobTrackingHeaders: HEADERS, completedHeaders: HEADERS, activeJobs: [], completedJobs: COMPLETED,
  fleet: [], drivers: [D1, D2, D3], driverQueues: {},
  autoInvoice: { mode: 'on' },
}

function answerGet(pathname) {
  const ok = (body) => ({ status: 200, body })
  if (pathname === '/api/auth/session') return ok({ authenticated: true, user: SUPER_ADMIN, appTimeZone: 'America/New_York' })
  if (pathname === '/api/dashboard') return ok(DASHBOARD)
  if (pathname === '/api/load-ratings/averages') return ok({ averages: {} })
  if (pathname === '/api/truck-assignments') return ok({ assignments: [] })
  if (pathname === '/api/config/maps-key') return ok({ key: 'qa-filters-no-key' })
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
    res.end('{"error":"not served by the Completed Loads filters check"}')
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
  const verdict = ok ? 'PASS' : PHASE === 'before' ? 'BEFORE' : 'FAIL'
  if (verdict === 'FAIL') exitCode = 1
  rows.push({ step, title, expected, observed, verdict, shotFile })
  console.log(`${verdict}  ${step}  ${title}: expected ${expected}; observed ${observed}`)
}
async function shot(page, size, step, what) {
  fs.mkdirSync(SHOTS, { recursive: true, mode: 0o700 })
  const file = path.join(SHOTS, `${PHASE}-${size.tag}-${step}-${what}.png`)
  await page.screenshot({ path: file, fullPage: true })
  return path.basename(file)
}
async function shotBar(page, size, step, what) {
  fs.mkdirSync(SHOTS, { recursive: true, mode: 0o700 })
  const file = path.join(SHOTS, `${PHASE}-${size.tag}-${step}-${what}.png`)
  await panel(page).locator('.dash-search-bar').first().screenshot({ path: file })
  return path.basename(file)
}

// ---------------------------------------------------------------- page helpers
async function openPage(browser, size) {
  const phone = size.viewport.width < 640
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
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.locator('[role="tab"]', { hasText: 'Completed' }).first().click({ timeout: 15000 })
  await panel(page).locator('tbody tr').first().waitFor({ state: 'visible', timeout: 15000 })
  await settle(page)
  return { ctx, page }
}
const panel = (page) => page.locator('[role="tabpanel"][data-state="active"]')
const settle = async (page) => { await page.mouse.move(1, 1); await page.waitForTimeout(450) }
const toggle = (page, label) => panel(page).locator('button', { hasText: new RegExp(`${label} \\(\\d+\\)`) })
async function press(page, which) {
  await toggle(page, which === 'review' ? 'Needs Review' : 'Needs attention').first().click({ timeout: 8000 })
  await settle(page)
}
async function pickDriver(page, name) {
  await panel(page).locator('#cl-driver').selectOption(name.toLowerCase())
  await settle(page)
}
async function pickDates(page, [from, to]) {
  await panel(page).locator('#cl-from').fill(from)
  await panel(page).locator('input[aria-label^="Delivered on or before"]').fill(to)
  await settle(page)
}
async function toggleState(page, label) {
  const b = toggle(page, label)
  if (!(await b.count())) return { shown: false, count: null, pressed: null, look: null }
  const text = ((await b.first().textContent()) || '').replace(/\s+/g, ' ').trim()
  const pressed = await b.first().getAttribute('aria-pressed')
  const look = await b.first().evaluate((el) => { const s = getComputedStyle(el); return { background: s.backgroundColor, color: s.color, border: s.borderTopColor } })
  return { shown: true, count: Number((/\((\d+)\)/.exec(text) || [])[1]), pressed, look }
}
async function view(page) {
  const review = await toggleState(page, 'Needs Review')
  const attention = await toggleState(page, 'Needs attention')
  const ids = (await panel(page).locator('tbody tr').allTextContents()).map((t) => (/QA-\d+/.exec(t) || [''])[0]).sort()
  const emptyEl = panel(page).locator('.py-16 .text-sm')
  const empty = (await emptyEl.count()) ? ((await emptyEl.first().textContent()) || '').replace(/\s+/g, ' ').trim() : ''
  return { review, attention, ids, empty }
}
const brief = (v) => `Needs Review ${v.review.shown ? `(${v.review.count}) pressed=${v.review.pressed}` : 'hidden'}, Needs attention ${v.attention.shown ? `(${v.attention.count}) pressed=${v.attention.pressed}` : 'hidden'}, rows ${v.ids.length}${v.ids.length ? ` [${v.ids.join(' ')}]` : ''}${v.empty ? `, empty line "${v.empty}"` : ''}`
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------- the steps
async function togglesRun(browser, size) {
  const { ctx, page } = await openPage(browser, size)
  try {
    const all = poolOf()
    const review = all.filter((r) => r.review)
    const attention = all.filter((r) => r.attention)
    const v0 = await view(page)
    const f0 = await shot(page, size, 'CF0', 'no-toggle-counts')
    record(`CF0-${size.tag}`, 'No toggle on: every load listed, each count is the rows its toggle shows',
      `${all.length} rows; Needs Review (${review.length}); Needs attention (${attention.length}); both pressed=false`, brief(v0),
      v0.ids.length === all.length && v0.review.count === review.length && v0.attention.count === attention.length && v0.review.pressed === 'false' && v0.attention.pressed === 'false', f0)
    const offLook = [v0.review.look, v0.attention.look]

    await press(page, 'review')
    const v1 = await view(page)
    const f1 = await shot(page, size, 'CF1', 'needs-review-on')
    const bar1 = await shotBar(page, size, 'CF5', 'toolbar-needs-review-on')
    record(`CF1-${size.tag}`, 'Needs Review on: its rows, and only it pressed',
      `rows [${idsOf(review).join(' ')}] = Needs Review (${review.length}); pressed true / false`, brief(v1),
      same(v1.ids, idsOf(review)) && v1.review.count === v1.ids.length && v1.review.pressed === 'true' && v1.attention.pressed === 'false', f1)
    const reviewOnLook = v1.review.look

    await press(page, 'attention')
    const v2 = await view(page)
    const f2 = await shot(page, size, 'CF2', 'needs-attention-on-review-off')
    const bar2 = await shotBar(page, size, 'CF5', 'toolbar-needs-attention-on')
    record(`CF2-${size.tag}`, 'Then Needs attention: Needs Review goes off, one toggle on at a time',
      `rows [${idsOf(attention).join(' ')}] = Needs attention (${attention.length}); Needs Review pressed=false, Needs attention pressed=true`, brief(v2),
      same(v2.ids, idsOf(attention)) && v2.attention.count === v2.ids.length && v2.review.pressed === 'false' && v2.attention.pressed === 'true', f2)
    const attentionOnLook = v2.attention.look

    record(`CF5-${size.tag}`, 'Both toggles show "on" the same way, and "off" the same way',
      'the same background, text and border colours on, the same off, on unlike off; aria-pressed on both',
      `off ${JSON.stringify(offLook)}; Needs Review on ${JSON.stringify(reviewOnLook)}; Needs attention on ${JSON.stringify(attentionOnLook)}; pressed ${v1.review.pressed}/${v2.attention.pressed}`,
      !!reviewOnLook && same(reviewOnLook, attentionOnLook) && same(offLook[0], offLook[1]) && !same(reviewOnLook, offLook[0]) && v1.review.pressed === 'true' && v2.attention.pressed === 'true', `${bar1}, ${bar2}`)

    const sideways = size.viewport.width < 640 ? await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) : 0
    if (size.viewport.width < 640) record(`CFx-${size.tag}-scroll`, 'At 390 the page has no sideways scroll', 'scrollWidth - innerWidth <= 1', String(sideways), sideways <= 1)
  } catch (e) {
    record(`CF0-2-${size.tag}`, 'The toggles run', 'the steps run', `stopped: ${String(e.message || e).slice(0, 160)}`, false)
  } finally {
    await ctx.close()
  }
}

async function poolRun(browser, size) {
  const { ctx, page } = await openPage(browser, size)
  try {
    await pickDriver(page, D2)
    const p1 = poolOf({ driver: D2 })
    const v1 = await view(page)
    await press(page, 'review')
    const v2 = await view(page)
    await pickDates(page, NOV)
    const p2 = poolOf({ driver: D2, dates: NOV })
    const v3 = await view(page)
    const f = await shot(page, size, 'CF3', 'driver-and-dates-needs-review-count-matches-rows')
    const want = (p) => ({ review: p.filter((r) => r.review).length, attention: p.filter((r) => r.attention).length })
    record(`CF3-${size.tag}`, 'The counts follow the driver and dates, and a pressed toggle\'s count is the rows listed',
      `driver ${D2}: Needs Review (${want(p1).review}), Needs attention (${want(p1).attention}); pressed: rows [${idsOf(p1.filter((r) => r.review)).join(' ')}]; plus November: Needs Review (${want(p2).review}) = rows [${idsOf(p2.filter((r) => r.review)).join(' ')}], Needs attention (${want(p2).attention})`,
      `driver: ${brief(v1)}; pressed: ${brief(v2)}; plus November: ${brief(v3)}`,
      v1.review.count === want(p1).review && v1.attention.count === want(p1).attention
        && same(v2.ids, idsOf(p1.filter((r) => r.review))) && v2.review.count === v2.ids.length
        && v3.review.count === want(p2).review && v3.attention.count === want(p2).attention && same(v3.ids, idsOf(p2.filter((r) => r.review))) && v3.review.count === v3.ids.length, f)
  } catch (e) {
    record(`CF3-${size.tag}`, 'The counts follow the driver and dates', 'the step runs', `stopped: ${String(e.message || e).slice(0, 160)}`, false)
  } finally {
    await ctx.close()
  }
}

async function emptyRun(browser, size) {
  {
    const { ctx, page } = await openPage(browser, size)
    try {
      await press(page, 'review')
      await pickDriver(page, D3)
      const v = await view(page)
      const f = await shot(page, size, 'CF4', 'empty-needs-review-for-driver')
      const line = 'No loads need review for the driver you picked.'
      record(`CF4-${size.tag}-review`, 'Needs Review on, a driver with none: it stays on at (0) and the line names it',
        `Needs Review (0) pressed=true; 0 rows; "${line}"`, brief(v),
        v.review.shown && v.review.count === 0 && v.review.pressed === 'true' && v.ids.length === 0 && v.empty === line, f)
    } catch (e) {
      record(`CF4-${size.tag}-review`, 'Needs Review on, a driver with none', 'the step runs', `stopped: ${String(e.message || e).slice(0, 160)}`, false)
    } finally {
      await ctx.close()
    }
  }
  {
    const { ctx, page } = await openPage(browser, size)
    try {
      await press(page, 'attention')
      await pickDates(page, DEC)
      const v = await view(page)
      const f = await shot(page, size, 'CF4', 'empty-needs-attention-for-dates')
      const line = 'No automatic invoice draft needs attention for the dates you picked.'
      record(`CF4-${size.tag}-attention`, 'Needs attention on, dates with none: it stays on at (0) and the line names it',
        `Needs attention (0) pressed=true; 0 rows; "${line}"`, brief(v),
        v.attention.shown && v.attention.count === 0 && v.attention.pressed === 'true' && v.ids.length === 0 && v.empty === line, f)
    } catch (e) {
      record(`CF4-${size.tag}-attention`, 'Needs attention on, dates with none', 'the step runs', `stopped: ${String(e.message || e).slice(0, 160)}`, false)
    } finally {
      await ctx.close()
    }
  }
}

function writeResults() {
  const file = path.join(SHOTS, `results-${PHASE}.md`)
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const lines = [
    `# Completed Loads filters, ${PHASE}`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${cell(r.step)} | ${cell(r.title)} | ${cell(r.expected)} | ${cell(r.observed)} | ${r.verdict} | ${cell(r.shotFile)} |`),
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
      await togglesRun(browser, size)
      await poolRun(browser, size)
      await emptyRun(browser, size)
    }
  } finally {
    await browser.close()
    server.close()
  }
  record('CFx-errors', 'No page errors and nothing but GETs', 'none', `${pageErrors.length} page error(s)${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}; non-GETs ${JSON.stringify(nonGets)}`, pageErrors.length === 0 && nonGets.length === 0)
  const resultsFile = writeResults()
  console.log(`${TAG}: endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`)
  const count = (v) => rows.filter((r) => r.verdict === v).length
  console.log(`${TAG}: ${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('BEFORE')} BEFORE; results ${resultsFile}; screenshots ${SHOTS}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`${TAG}: aborted: ${e.stack || e}`)
  process.exit(1)
})
