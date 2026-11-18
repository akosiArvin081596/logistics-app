#!/usr/bin/env node
// LogisX — an ELD device link or swap counts from its instant forward (ELD_LINK_FORWARD_ONLY_ENABLED), on the Trucks
// page, on made-up data only, at a true 1280 x 800 and a true 390 x 844 (isMobile, deviceScaleFactor 2):
//   EF1 T-101's finalized-month load ended before the change: the × unlinks it, and the toast says from when
//   EF2 T-202's finalized-month load is still running: the × is refused, in the narrowed stop's words, under its row
//   EF3 T-101 links to D-11: the toast says from when its readings come from D-11
//   EFw per step: the page is exactly the viewport wide (clientWidth) and never wider (scrollWidth)
//   EFx no page error; the only writes are the link routes' own
// Every answer for GET /api/trucks, GET /api/routemate/vehicles/unlinked and POST / DELETE
// /api/trucks/:truckId/link-routemate comes from server.js's own routes, lifted into this process by
// scripts/lib/work-days-world.js over an in-memory database: trucks T-101 (D-7) and T-202 (D-9), the free device D-11,
// October finalized, the rule in force from Nov 2, the clock at Wed Nov 18, 11:12 Eastern.
//
// Like payroll-check-screen.mjs: no server.js process, app database, settings file, key or real sign-in. The
// checkout's built client/dist is served from 127.0.0.1, every other /api request is answered in the browser with
// made-up fixtures, and every other host is aborted.
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   node scripts/e2e/eld-link-forward-screen.mjs
// Env: E2E_PORT (default: a free port; 3000, 5173 and 3901 are refused), HEADED=1, E2E_WORK_DIR, SHOT_DIR (an absolute
// folder outside the checkout; default ~/LogisX-replica/reports/cc/work/eld-swap-forward/pr-b/screens). Run it outside
// the Claude Code Bash sandbox (Chrome binds its own sockets). Output: PASS/FAIL lines, the screenshots and
// <work dir>/results-eld-link-forward-screen.md. Exit 0 only when every row PASSes.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'
import paths from './paths.cjs'

const require = createRequire(import.meta.url)

const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.homedir(), 'LogisX-replica', 'reports', 'cc', 'work', 'eld-swap-forward', 'pr-b', 'screens')
const SIZES = [
  { tag: '1280x800', viewport: { width: 1280, height: 800 }, phone: false },
  { tag: '390x844', viewport: { width: 390, height: 844 }, phone: true },
]

function die(msg) {
  console.error(`eld-link-forward-screen: ${msg}`)
  process.exit(2)
}
if (process.env.E2E_PORT && (!Number.isInteger(ASKED_PORT) || ASKED_PORT < 1024 || ASKED_PORT > 65535)) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if ([3000, 5173, 3901].includes(ASKED_PORT)) die(`refusing port ${ASKED_PORT}: 3000 is production's port on the VPS, 5173 is Vite's and 3901 the replica's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm run build:client\` first`)
if (process.env.SHOT_DIR && !path.isAbsolute(process.env.SHOT_DIR)) die('SHOT_DIR must be an absolute path')
{
  const rel = path.relative(paths.REPO, SHOT_DIR)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) die(`SHOT_DIR ${SHOT_DIR} is inside the checkout: pick a folder outside it`)
}

// ---------------------------------------------------------------- the made-up world (server.js's own routes)
process.env.TZ = 'UTC'
const W = require('../lib/work-days-world.js')
const NOW_MS = Date.parse('2026-11-18T16:12:00Z') // Wed Nov 18, 11:12 Eastern
const HISTORY_START = '2026-10-03T03:00:00.000Z'
const FROM = '2026-11-02T15:00:00.000Z'
const ROUTES = [
  ['get', '/api/trucks'],
  ['get', '/api/routemate/vehicles/unlinked'],
  ['post', '/api/trucks/:truckId/link-routemate'],
  ['delete', '/api/trucks/:truckId/link-routemate'],
]
const PAT = 'Pat Example'
const SAM = 'Sam Sample'
const WORDS = {
  unlink: 'Unlinked. From Wed Nov 18 11:12 (Eastern), T-101 has no ELD device. Before that keeps what it had.',
  refusal: 'Cannot unlink the ELD device on T-202: its load assigned in October 2026 runs on or after Wed Nov 18, so this would change pay in a finalized month. October 2026 is finalized. Nothing was changed.',
  link: "Linked. From Wed Nov 18 11:12 (Eastern), T-101's ELD readings come from D-11. Before that keeps what it had.",
}

function makeWorld() {
  const w = W.startWorld({
    env: { ELD_LINK_FORWARD_ONLY_ENABLED: 'true', ELD_LINK_FORWARD_ONLY_FROM: FROM },
    drivers: [{ name: PAT }, { name: SAM }],
    trucks: [{ unit: 'T-101', driver: PAT, vid: 'D-7' }, { unit: 'T-202', driver: SAM, vid: 'D-9' }],
    rows: [
      W.loadRow({ id: 'L-OCT1', driver: PAT, pickup: '2026-10-26', dropoff: '2026-10-28', assigned: '2026-10-26', done: '2026-10-28', truck: 'T-101' }),
      W.loadRow({ id: 'L-OCT2', driver: SAM, pickup: '2026-10-30', dropoff: '', assigned: '2026-10-30', done: '', status: 'In Transit', truck: 'T-202' }),
    ],
    // A fix 10 minutes ago on each device, so none reads as silent.
    pings: Object.fromEntries(['D-7', 'D-9', 'D-11'].map((vid) => [vid, [{ ms: NOW_MS - 600000, lat: W.DALLAS.lat, lng: W.DALLAS.lng, odo: 100000, speed: 0 }]])),
    locks: ['2026-10'],
    now: NOW_MS,
    routes: ROUTES,
  })
  w.db.prepare("INSERT INTO server_state (key, value, updated_at) VALUES ('eld_device_history_started', ?, CURRENT_TIMESTAMP)")
    .run(JSON.stringify({ at: HISTORY_START, atMs: Date.parse(HISTORY_START), links: 2 }))
  w.db.prepare("INSERT INTO server_state (key, value, updated_at) VALUES ('eld_link_forward_from', ?, CURRENT_TIMESTAMP)")
    .run(JSON.stringify({ from: FROM, fromMs: Date.parse(FROM), recordedAt: FROM }))
  const row = w.db.prepare("INSERT INTO eld_device_assignments (truck_id, routemate_vehicle_id, assigned_from, assigned_until, assigned_by) VALUES (?, ?, ?, '', 'system:seed')")
  row.run(1, 'D-7', HISTORY_START)
  row.run(2, 'D-9', HISTORY_START)
  const rv = w.db.prepare('INSERT INTO routemate_vehicles (routemate_vehicle_id, vehicle_id) VALUES (?, ?)')
  for (const v of ['D-7', 'D-9', 'D-11']) rv.run(v, v)
  return w
}

// The answer of a lifted route, as JSON on the wire.
async function lifted(w, key, req) {
  const r = await W.route(w, key, req)
  return { status: r.status, body: JSON.parse(JSON.stringify(r.body === undefined ? {} : r.body)) }
}

// ---------------------------------------------------------------- the browser's other answers
const SUPER_ADMIN = { id: 1, username: 'super_admin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Super Admin', companyName: '', mustChangePassword: false }
function fixtureGet(pathname) {
  const ok = (body) => ({ status: 200, body })
  if (pathname === '/api/auth/session') return ok({ authenticated: true, user: SUPER_ADMIN, appTimeZone: 'America/New_York' })
  if (pathname === '/api/auth/setup-check') return ok({ needsSetup: false })
  if (pathname === '/api/drivers-directory') return ok({ headers: ['Driver'], data: [] })
  if (pathname === '/api/users/investors') return ok({ investors: [] })
  if (pathname === '/api/dispatch-notifications') return ok({ notifications: [], unreadCount: 0 })
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the ELD link screen check"}')
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
const pageErrors = []
const unanswered = new Set()
let exitCode = 0
function record(step, title, observed, pass, shot = '') {
  if (!pass) exitCode = 1
  rows.push({ step, title, observed, verdict: pass ? 'PASS' : 'FAIL', shot })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${String(observed).replace(/\r?\n/g, ' ')}`)
}
async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(SHOT_DIR, `eld-forward-${name}.png`)
  try { await page.screenshot({ path: file }) } catch (e) { console.log(`  (screenshot ${name} failed: ${e.message})`) }
  return file
}
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim()
const exact = (s) => new RegExp(`^\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
const rowOf = (page, unit) => page.locator('table.truck-table tbody tr', { has: page.locator('td.unit-number', { hasText: exact(unit) }) })
// The page's own width against the viewport: exactly as wide, never wider. The table's sideways scroll inside
// .table-wrapper is reported, not judged: below its column budget (TruckTable.vue) the table scrolls by design.
async function widths(page, size) {
  const m = await page.evaluate(() => {
    const wrap = document.querySelector('.table-wrapper')
    return {
      client: document.documentElement.clientWidth,
      scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      wrapClient: wrap ? wrap.clientWidth : null,
      wrapScroll: wrap ? wrap.scrollWidth : null,
    }
  })
  const text = `clientWidth ${m.client}, scrollWidth ${m.scroll}; the table's wrapper shows ${m.wrapClient} of ${m.wrapScroll} px`
  return { ...m, text, ok: m.client === size.viewport.width && m.scroll <= m.client }
}

async function openTrucks(browser, size, world) {
  const ctx = await browser.newContext({
    viewport: size.viewport, deviceScaleFactor: 2, isMobile: size.phone, hasTouch: size.phone, serviceWorkers: 'block', timezoneId: 'America/New_York',
  })
  await ctx.clock.setFixedTime(new Date(NOW_MS))
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) return route.abort()
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    const method = req.method()
    const link = /^\/api\/trucks\/(\d+)\/link-routemate$/.exec(u.pathname)
    let out = null
    if (method === 'GET' && u.pathname === '/api/trucks') out = await lifted(world, 'GET /api/trucks', {})
    else if (method === 'GET' && u.pathname === '/api/routemate/vehicles/unlinked') out = await lifted(world, 'GET /api/routemate/vehicles/unlinked', { query: Object.fromEntries(u.searchParams) })
    else if (link && (method === 'POST' || method === 'DELETE')) {
      writes.push(`${size.tag} ${method} ${u.pathname}`)
      let body = {}
      try { body = JSON.parse(req.postData() || '{}') } catch { body = {} }
      out = await lifted(world, `${method} /api/trucks/:truckId/link-routemate`, { params: { truckId: link[1] }, body })
    } else if (method === 'GET') {
      out = fixtureGet(u.pathname)
      if (out === null) { unanswered.add(u.pathname); out = { status: 200, body: {} } }
    } else {
      writes.push(`${size.tag} ${method} ${u.pathname} (not answered by a route)`)
      out = { status: 200, body: {} }
    }
    return route.fulfill({ status: out.status, contentType: 'application/json', body: JSON.stringify(out.body) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag} ${String(e.message || e).slice(0, 160)}`))
  await page.goto(`${BASE}/trucks`, { waitUntil: 'domcontentloaded' })
  await rowOf(page, 'T-101').waitFor({ state: 'visible', timeout: 30000 })
  return { ctx, page }
}

async function toastText(page) {
  const t = page.locator('.toast.show')
  await t.waitFor({ state: 'visible', timeout: 15000 })
  return clean(await t.innerText())
}

async function runSize(browser, size) {
  const world = makeWorld()
  const { ctx, page } = await openTrucks(browser, size, world)
  try {
    // EF1: unlink T-101.
    await rowOf(page, 'T-101').locator('button.btn-unlink-rm').click()
    const unlinkLine = await toastText(page)
    const relisted = await rowOf(page, 'T-101').locator('button.btn-link-rm').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
    let w = await widths(page, size)
    record(`EF1 ${size.tag}`, 'T-101 unlinks: the toast says from when it has no ELD device, and its row offers Link',
      `"${unlinkLine}"; Link shown: ${relisted}; ${w.text}`, unlinkLine === WORDS.unlink && relisted && w.ok, await shot(page, `unlink-${size.tag}`))
    await page.locator('.toast.show').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {})

    // EF2: unlink T-202 is refused in the narrowed words.
    await rowOf(page, 'T-202').locator('button.btn-unlink-rm').click()
    const alert = page.locator('tr.rm-error-row .rm-unlink-error')
    await alert.waitFor({ state: 'visible', timeout: 15000 })
    const refusal = clean(await alert.locator('span').first().innerText())
    await alert.scrollIntoViewIfNeeded()
    const box = await alert.boundingBox()
    w = await widths(page, size)
    record(`EF2 ${size.tag}`, "T-202's unlink is refused in the narrowed stop's words, under its row",
      `"${refusal}"; the message box is ${box ? Math.round(box.width) : '?'} px wide; ${w.text}`, refusal === WORDS.refusal && w.ok, await shot(page, `refusal-${size.tag}`))

    // EF3: link T-101 to D-11.
    await rowOf(page, 'T-101').locator('button.btn-link-rm').click()
    const modal = page.locator('.confirm-dialog', { hasText: 'Link Truck T-101' })
    await modal.waitFor({ state: 'visible', timeout: 15000 })
    await modal.locator('.rm-pick-item', { hasText: 'D-11' }).first().click()
    await modal.getByRole('button', { name: 'Link Selected' }).click()
    const linkLine = await toastText(page)
    const linked = await rowOf(page, 'T-101').locator('.rm-linked').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
    w = await widths(page, size)
    record(`EF3 ${size.tag}`, 'T-101 links to D-11: the toast says from when its readings come from D-11, and its row reads Linked',
      `"${linkLine}"; Linked shown: ${linked}; ${w.text}`, linkLine === WORDS.link && linked && w.ok, await shot(page, `link-${size.tag}`))
  } finally {
    await ctx.close()
    world.db.close()
  }
}

async function main() {
  const server = http.createServer(serveDist)
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use`)
  await new Promise((resolve) => server.listen(ASKED_PORT, HOST, resolve))
  PORT = server.address().port
  BASE = `http://${HOST}:${PORT}`
  let browser = null
  try {
    browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
    for (const size of SIZES) {
      try { await runSize(browser, size) } catch (e) { record(`EF! ${size.tag}`, 'aborted', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
    }
    const routeWrites = writes.filter((x) => / (POST|DELETE) \/api\/trucks\/\d+\/link-routemate$/.test(x))
    record('EFx', 'no page error; the only writes are the link routes',
      `${pageErrors.length ? pageErrors.join('; ') : 'no page errors'}; writes: ${writes.join(', ') || 'none'}; unanswered GETs (fixtures {}): ${[...unanswered].join(', ') || 'none'}`,
      pageErrors.length === 0 && routeWrites.length === writes.length && writes.length === 3 * SIZES.length)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await new Promise((r) => server.close(() => r()))
    W.cleanup()
  }
  const cell = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  const lines = [
    `# LogisX — ELD links counted from their instant forward, the Trucks page (made-up data) — ${new Date().toISOString()}`,
    '',
    '| Step | What | Observed | Verdict | Screenshot |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${cell(r.step)} | ${cell(r.title)} | ${cell(r.observed)} | ${r.verdict} | ${r.shot ? cell(path.basename(r.shot)) : ''} |`),
    '',
  ]
  const results = path.join(paths.workDir(), 'results-eld-link-forward-screen.md')
  fs.writeFileSync(results, lines.join('\n'))
  console.log(`\nresults: ${results}\nscreenshots: ${SHOT_DIR}`)
}

await main()
process.exit(exitCode)
