#!/usr/bin/env node
// LogisX — the C.H. Robinson badge in a load's detail (ChrSendBadge), on made-up data only.
//
// As a made-up Super Admin on the dashboard's Active Loads tab, at 1280x800 and 390x844:
//   C1  the feature off (GET /api/integrations/chr/status answers {enabled:false}): open a load,
//       close it, open it again: 0 requests under /api/integrations/chr/loads/, no badge, and
//       the status read once for the whole page load
//   C2  the feature on, a load with made-up recorded dry-run rows: the badge shows
//       "CHR: dry run (2)" and links to the CHR page for that load; exactly one status read
//       and one summary read of that load's own URL
//   C3  the feature on, a load with no CHR rows (the summary answers 404 NOT_A_CHR_LOAD): no
//       badge. The client does not know a load's broker, so it asks once and takes the 404;
//       the step pins that one ask and that it is for this load only
// No step sends anything but GETs to /api/integrations/chr.
//
// Like driver-emergency-contacts-profile.mjs this boots no server.js, opens no database, reads
// no settings file or key and signs nobody in. It serves the checkout's built client/dist from
// its own static server on 127.0.0.1 (E2E_PORT, default 3184) and answers every /api request in
// the browser with made-up fixtures. Every request to another host is aborted.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/chr-send-badge.mjs
//
// Env: E2E_PORT (default 3184; 3000 and 5173 are refused, and so is a port in use), HEADED=1,
// CHROME_PATH, E2E_WORK_DIR, SHOT_DIR (an absolute folder outside the checkout; screenshots are
// taken only when it is set). Exit 0 only when every step PASSes.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import paths from './paths.cjs'

const PORT = Number(process.env.E2E_PORT || 3184)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const HEADED = process.env.HEADED === '1'
const DIST = path.join(paths.REPO, 'client', 'dist')
const SIZES = [
  { tag: '1280x800', viewport: { width: 1280, height: 800 } },
  { tag: '390x844', viewport: { width: 390, height: 844 } },
]
const CHR_API = '/api/integrations/chr'

function die(msg) {
  console.error(`chr-send-badge: ${msg}`)
  process.exit(2)
}

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (PORT === 3000 || PORT === 5173) die(`refusing port ${PORT}: 3000 is production's port on the VPS and 5173 is Vite's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm --prefix client run build\` first`)
if (process.env.SHOT_DIR) {
  const dir = process.env.SHOT_DIR
  if (!path.isAbsolute(dir)) die('SHOT_DIR must be an absolute path')
  const rel = path.relative(paths.REPO, path.resolve(dir))
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) die(`SHOT_DIR ${dir} is inside the checkout: pick a folder outside it`)
}

// ---------------------------------------------------------------- made-up fixtures
const SUPER_ADMIN = { id: 91101, username: 'qa-chr-superadmin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA CHR Super Admin', companyName: '', mustChangePassword: false }
const CHR_LOAD = 'QA-CHR-10001'
const OTHER_LOAD = 'QA-OTH-20002'
const DRIVER = 'Casey Example'
const HEADERS = ['Load ID', 'Driver', 'Status', 'Pickup', 'Drop-off', 'Rate']
const job = (id, rowIndex, pickup, dropoff) => ({
  'Load ID': id, Driver: DRIVER, Status: 'In Transit', Pickup: pickup, 'Drop-off': dropoff, Rate: '$1,000.00', _rowIndex: rowIndex, _id: rowIndex,
})
const DASHBOARD = {
  timestamp: new Date().toISOString(),
  kpis: { activeLoads: 2, unassignedLoads: 0, completedThisWeek: 0, completedThisMonth: 0, fleetUtilization: { assigned: 1, total: 1 }, revenue: { total: 0, paid: 0, pending: 0 } },
  unassignedJobs: [], jobTrackingHeaders: HEADERS, completedHeaders: HEADERS, completedJobs: [],
  activeJobs: [job(CHR_LOAD, 2, 'Austin, TX 78701', 'Dallas, TX 75201'), job(OTHER_LOAD, 3, 'Tulsa, OK 74103', 'Wichita, KS 67202')],
  fleet: [{ Driver: DRIVER, Truck: 'QA-1', Status: 'On Load', CompletedLoads: 3, CurrentLoad: CHR_LOAD, Phone: '(512) 555-0100', QueueCount: 0, QueuedLoadIds: [] }],
  drivers: [DRIVER], driverQueues: {},
}

const STATUS_ON = { enabled: true, milestones: 'dry_run', location: 'off', locationEnabled: false, today: {}, live: { allowed: false, reason: 'not_listed' } }
const STATUS_OFF = { enabled: false }
const SUMMARY_CHR = {
  load: { loadId: CHR_LOAD, multiStop: false, multiStopWhy: '', hold: false, holdReason: '', holdBy: '', holdAt: '', lastEvent: 'arrived_pickup', lastEventAt: '2026-01-05T15:00:00Z', updatedAt: '2026-01-05T15:00:00Z' },
  counts: { dry_run: 2 },
  events: [], pod: { count: 0 }, draft: null,
}

// What the "server" holds for one page load: the flag, and every request the page made.
function freshState({ flag }) {
  return { flag, reqs: [] }
}

function answerGet(state, pathname) {
  if (pathname === '/api/auth/session') return { status: 200, body: { authenticated: true, user: SUPER_ADMIN, appTimeZone: 'America/New_York' } }
  if (pathname === `${CHR_API}/status`) return { status: 200, body: state.flag ? STATUS_ON : STATUS_OFF }
  if (pathname.startsWith(`${CHR_API}/loads/`)) {
    if (!state.flag) return { status: 404, body: { error: 'Not found', code: 'FEATURE_OFF' } }
    const id = decodeURIComponent(pathname.slice(`${CHR_API}/loads/`.length))
    if (id === CHR_LOAD) return { status: 200, body: SUMMARY_CHR }
    return { status: 404, body: { error: 'LogisX has no C.H. Robinson updates for that load.', code: 'NOT_A_CHR_LOAD' } }
  }
  if (pathname === '/api/dashboard') return { status: 200, body: DASHBOARD }
  if (pathname === '/api/load-ratings/averages') return { status: 200, body: { averages: {} } }
  if (pathname === '/api/truck-assignments') return { status: 200, body: { assignments: [] } }
  if (pathname === '/api/config/maps-key') return { status: 200, body: { key: 'qa-chr-no-key' } }
  if (pathname === '/api/locations/latest') return { status: 200, body: { locations: [] } }
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the CHR badge check"}')
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
const unanswered = new Set()
const pageErrors = []
function record(step, title, expected, observed, ok) {
  if (!ok) exitCode = 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}  ${title}: expected ${expected}; observed ${observed}`)
}

async function shot(page, name) {
  if (!process.env.SHOT_DIR) return
  const dir = path.resolve(process.env.SHOT_DIR)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  await page.screenshot({ path: path.join(dir, `chr-send-badge-${name}.png`) })
}

// ---------------------------------------------------------------- page helpers
async function openPage(browser, size, state) {
  const phone = size.viewport.width < 640
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) return route.abort()
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    state.reqs.push({ method: req.method(), path: u.pathname })
    if (req.method() !== 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    const out = answerGet(state, u.pathname)
    if (out === null) unanswered.add(u.pathname)
    return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', body: JSON.stringify(out ? out.body : {}) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  return { ctx, page }
}

const DIALOG = '[role="dialog"]'
const BADGE = '.chr-badge'
async function appears(page, selector, ms) {
  try { await page.waitForSelector(selector, { state: 'visible', timeout: ms }); return true } catch { return false }
}
async function gone(page, selector, ms) {
  try { await page.waitForSelector(selector, { state: 'hidden', timeout: ms }); return true } catch { return false }
}

async function openActiveTab(page) {
  await page.locator('[role="tab"]', { hasText: 'Active Loads' }).first().click({ timeout: 15000 })
}
async function openLoad(page, size, loadId) {
  const phone = size.viewport.width < 640
  const row = phone
    ? page.locator('.mobile-load-card', { hasText: loadId }).first()
    : page.locator('tbody tr', { hasText: loadId }).first().locator('td').first()
  await row.click({ timeout: 15000 })
  return appears(page, DIALOG, 8000)
}
async function closeLoad(page) {
  await page.keyboard.press('Escape')
  return gone(page, DIALOG, 5000)
}

const chrReqs = (state) => state.reqs.filter((r) => r.path.startsWith(CHR_API))
const statusReads = (state) => chrReqs(state).filter((r) => r.method === 'GET' && r.path === `${CHR_API}/status`)
const summaryReads = (state) => chrReqs(state).filter((r) => r.path.startsWith(`${CHR_API}/loads/`))
const nonGets = (state) => chrReqs(state).filter((r) => r.method !== 'GET')
const list = (rs) => JSON.stringify(rs.map((r) => `${r.method} ${r.path}`))

// ---------------------------------------------------------------- the steps
async function flagOffRun(browser, size) {
  const state = freshState({ flag: false })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await openActiveTab(page)
    const opened = await openLoad(page, size, CHR_LOAD)
    await page.waitForTimeout(2500)
    const badge = await page.locator(BADGE).count()
    const closed = opened && await closeLoad(page)
    const reopened = closed && await openLoad(page, size, CHR_LOAD)
    await page.waitForTimeout(2000)
    const badgeAgain = await page.locator(BADGE).count()
    await shot(page, `C1-${size.tag}`)
    record(`C1-${size.tag}`, 'The feature off: opening a load asks for no CHR summary', 'dialog opened twice; 0 requests under /loads/; 1 status read; no badge; no non-GET',
      `opened ${opened}/${reopened}, summary reads ${list(summaryReads(state))}, status reads ${statusReads(state).length}, badge ${badge}/${badgeAgain}, non-GET ${list(nonGets(state))}`,
      opened && reopened && summaryReads(state).length === 0 && statusReads(state).length === 1 && badge === 0 && badgeAgain === 0 && nonGets(state).length === 0)
  } finally {
    await ctx.close()
  }
}

async function chrLoadRun(browser, size) {
  const state = freshState({ flag: true })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await openActiveTab(page)
    const opened = await openLoad(page, size, CHR_LOAD)
    const shown = opened && await appears(page, BADGE, 8000)
    await page.waitForTimeout(800)
    const text = shown ? (await page.locator(BADGE).first().textContent() || '').replace(/\s+/g, ' ').trim() : ''
    const href = shown ? await page.locator(BADGE).first().getAttribute('href') : ''
    const sums = summaryReads(state)
    const wantUrl = `${CHR_API}/loads/${encodeURIComponent(CHR_LOAD)}`
    await shot(page, `C2-${size.tag}`)
    record(`C2-${size.tag}`, 'The feature on, a recorded CHR load: the badge shows', 'badge "CHR: dry run (2)" linking to the CHR page for the load; 1 status read; 1 summary read of the load\'s own URL; no non-GET',
      `opened ${opened}, badge ${shown ? `"${text}" -> ${href}` : 'none'}, status reads ${statusReads(state).length}, summary reads ${list(sums)}, non-GET ${list(nonGets(state))}`,
      opened && shown && text === 'CHR: dry run (2)' && href === `/admin/integrations/chr?load=${encodeURIComponent(CHR_LOAD)}`
        && statusReads(state).length === 1 && sums.length === 1 && sums[0].method === 'GET' && sums[0].path === wantUrl && nonGets(state).length === 0)
  } finally {
    await ctx.close()
  }
}

async function otherLoadRun(browser, size) {
  const state = freshState({ flag: true })
  const { ctx, page } = await openPage(browser, size, state)
  try {
    await openActiveTab(page)
    const opened = await openLoad(page, size, OTHER_LOAD)
    await page.waitForTimeout(3000)
    const badge = await page.locator(BADGE).count()
    const sums = summaryReads(state)
    const wantUrl = `${CHR_API}/loads/${encodeURIComponent(OTHER_LOAD)}`
    await shot(page, `C3-${size.tag}`)
    record(`C3-${size.tag}`, 'The feature on, a load with no CHR rows: no badge', 'no badge; 1 status read; 1 summary read, of this load only (answered 404); none for the CHR load; no non-GET',
      `opened ${opened}, badge ${badge}, status reads ${statusReads(state).length}, summary reads ${list(sums)}, non-GET ${list(nonGets(state))}`,
      opened && badge === 0 && statusReads(state).length === 1 && sums.length === 1 && sums[0].path === wantUrl && nonGets(state).length === 0)
  } finally {
    await ctx.close()
  }
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve) })
  console.log(`chr-send-badge: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const size of SIZES) {
      await flagOffRun(browser, size)
      await chrLoadRun(browser, size)
      await otherLoadRun(browser, size)
    }
  } finally {
    await browser.close()
    server.close()
  }
  console.log(`chr-send-badge: endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`)
  if (pageErrors.length) console.log(`chr-send-badge: page errors (not part of the verdict): ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`chr-send-badge: aborted: ${e.stack || e}`)
  process.exit(1)
})
