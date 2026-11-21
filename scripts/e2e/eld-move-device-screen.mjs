#!/usr/bin/env node
// LogisX — Move device (ELD_MOVE_DEVICE_ENABLED) on the Trucks page, on made-up data only, at a true 1280 x 800 and a
// true 390 x 844 (isMobile, deviceScaleFactor 2):
//   EM0 the switch off: T-200's Link dialog is today's (no groups, only the free device, Link Selected)
//   EM1 the switch on: T-200's Link dialog shows Free devices (D-4) and On another truck (D-7 on T-100, D-9 on T-150);
//       picking D-7 makes the button Move here
//   EM2 Move here: the confirm, "Move D-7 from T-100 to T-200?" and its line
//   EM3 Move device: the toast says from when T-200 reads D-7 and T-100 has none; T-200 reads Linked, T-100 offers Link
//   EM4 T-300 moving D-9 off T-150, whose October load has "TBD" under Pickup Appointment: the refusal in the
//       dialog, its lead in bold, then the data-fix line, and only Close
//   EM5 the same row with "14:00" there, a time alone, which the stop reads as blank: D-9 moves off T-150 onto T-300
//   EMw per step: the page is exactly the viewport wide (clientWidth) and never wider (scrollWidth)
//   EMx no page error; the only writes are the move route's, none with the switch off
// Every answer for GET /api/trucks, GET /api/routemate/vehicles/unlinked, GET /api/routemate/vehicles and POST
// /api/trucks/:truckId/move-eld comes from server.js's own routes, lifted into this process by
// scripts/lib/work-days-world.js over an in-memory database: trucks T-100 (D-7), T-200 (none), T-150 (D-9) and T-300
// (none), the free device D-4, October finalized, the forward-only rule in force from Nov 2, the clock at Fri Nov 20,
// 09:41 Eastern.
//
// Like eld-link-forward-screen.mjs: no server.js process, app database, settings file, key or real sign-in. The
// checkout's built client/dist is served from 127.0.0.1, every other /api request is answered in the browser with
// made-up fixtures, and every other host is aborted.
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   node scripts/e2e/eld-move-device-screen.mjs
// Env: E2E_PORT (default: a free port; 3000, 5173 and 3901 are refused), HEADED=1, E2E_WORK_DIR, SHOT_DIR (an absolute
// folder outside the checkout; default ~/LogisX-replica/reports/cc/work/move-device/screens). Run it outside the
// Claude Code Bash sandbox (Chrome binds its own sockets). Output: PASS/FAIL lines, the screenshots and
// <work dir>/results-eld-move-device-screen.md. Exit 0 only when every row PASSes.
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
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.homedir(), 'LogisX-replica', 'reports', 'cc', 'work', 'move-device', 'screens')
const SIZES = [
  { tag: '1280x800', viewport: { width: 1280, height: 800 }, phone: false },
  { tag: '390x844', viewport: { width: 390, height: 844 }, phone: true },
]

function die(msg) {
  console.error(`eld-move-device-screen: ${msg}`)
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
const NOW_MS = Date.parse('2026-11-20T14:41:00Z') // Fri Nov 20, 09:41 Eastern
const HISTORY_START = '2026-10-03T03:00:00.000Z'
const FROM = '2026-11-02T15:00:00.000Z'
const ROUTES = [
  ['get', '/api/trucks'],
  ['get', '/api/routemate/vehicles/unlinked'],
  ['get', '/api/routemate/vehicles'],
  ['post', '/api/trucks/:truckId/move-eld'],
  ['post', '/api/trucks/:truckId/link-routemate'],
  ['delete', '/api/trucks/:truckId/link-routemate'],
]
const PAT = 'Pat Example'
const SAM = 'Sam Sample'
const LEE = 'Lee Other'
const KIM = 'Kim Test'
const WORDS = {
  confirmTitle: 'Move D-7 from T-100 to T-200?',
  confirmBody: 'From now on D-7 counts for T-200. T-100 will have no ELD device until you link one. Earlier days stay as they were.',
  moved: "Moved. From Fri Nov 20 09:41 (Eastern), T-200's ELD readings come from D-7, and T-100 has no ELD device. Earlier days stay as they were.",
  refusalLead: 'Cannot move D-9.',
  refusal: 'Cannot move D-9. Load L-1001 on T-150 has "TBD" under Pickup Appointment, where the app needs a date. Until that is fixed, this device can\'t be moved off T-150.',
  dataFix: 'This needs a data fix. Send a screenshot of this message to the LogisX team. Nothing was changed.',
  movedOffT150: "Moved. From Fri Nov 20 09:41 (Eastern), T-300's ELD readings come from D-9, and T-150 has no ELD device. Earlier days stay as they were.",
}

function makeWorld({ move }) {
  // T-150's October load carries text that is no date under Pickup Appointment: the N1 bad cell.
  const badCell = { ...W.loadRow({ id: 'L-1001', driver: LEE, pickup: '2026-10-26', dropoff: '2026-10-28', assigned: '2026-10-26', done: '2026-10-28', truck: 'T-150' }), 'Pickup Appointment': 'TBD' }
  const w = W.startWorld({
    env: { ELD_LINK_FORWARD_ONLY_ENABLED: 'true', ELD_LINK_FORWARD_ONLY_FROM: FROM, ...(move ? { ELD_MOVE_DEVICE_ENABLED: 'true' } : {}) },
    drivers: [{ name: PAT }, { name: SAM }, { name: LEE }, { name: KIM }],
    trucks: [{ unit: 'T-100', driver: PAT, vid: 'D-7' }, { unit: 'T-200', driver: SAM, vid: '' }, { unit: 'T-150', driver: LEE, vid: 'D-9' }, { unit: 'T-300', driver: KIM, vid: '' }],
    rows: [
      W.loadRow({ id: 'L-OCT1', driver: PAT, pickup: '2026-10-26', dropoff: '2026-10-28', assigned: '2026-10-26', done: '2026-10-28', truck: 'T-100' }),
      badCell,
    ],
    // A fix 10 minutes ago on each device, so none reads as silent.
    pings: Object.fromEntries(['D-4', 'D-7', 'D-9'].map((vid) => [vid, [{ ms: NOW_MS - 600000, lat: W.DALLAS.lat, lng: W.DALLAS.lng, odo: 100000, speed: 0 }]])),
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
  row.run(3, 'D-9', HISTORY_START)
  const rv = w.db.prepare('INSERT INTO routemate_vehicles (routemate_vehicle_id, vehicle_id) VALUES (?, ?)')
  for (const v of ['D-4', 'D-7', 'D-9']) rv.run(v, v)
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
    res.end('{"error":"not served by the Move device screen check"}')
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
  const file = path.join(SHOT_DIR, `move-device-${name}.png`)
  try { await page.screenshot({ path: file }) } catch (e) { console.log(`  (screenshot ${name} failed: ${e.message})`) }
  return file
}
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim()
const exact = (s) => new RegExp(`^\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
const rowOf = (page, unit) => page.locator('table.truck-table tbody tr', { has: page.locator('td.unit-number', { hasText: exact(unit) }) })
// Text as written (textContent), not as styled: the group labels are upper-cased by CSS.
const texts = async (loc) => (await loc.allTextContents()).map(clean)
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
    const moveAt = /^\/api\/trucks\/(\d+)\/move-eld$/.exec(u.pathname)
    const linkAt = /^\/api\/trucks\/(\d+)\/link-routemate$/.exec(u.pathname)
    let body = {}
    try { body = JSON.parse(req.postData() || '{}') } catch { body = {} }
    let out = null
    if (method === 'GET' && u.pathname === '/api/trucks') out = await lifted(world, 'GET /api/trucks', {})
    else if (method === 'GET' && u.pathname === '/api/routemate/vehicles/unlinked') out = await lifted(world, 'GET /api/routemate/vehicles/unlinked', { query: Object.fromEntries(u.searchParams) })
    else if (method === 'GET' && u.pathname === '/api/routemate/vehicles') out = await lifted(world, 'GET /api/routemate/vehicles', {})
    else if (moveAt && method === 'POST') {
      writes.push(`${size.tag} POST ${u.pathname}`)
      out = await lifted(world, 'POST /api/trucks/:truckId/move-eld', { params: { truckId: moveAt[1] }, body })
    } else if (linkAt && (method === 'POST' || method === 'DELETE')) {
      writes.push(`${size.tag} ${method} ${u.pathname}`)
      out = await lifted(world, `${method} /api/trucks/:truckId/link-routemate`, { params: { truckId: linkAt[1] }, body })
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
  await rowOf(page, 'T-200').waitFor({ state: 'visible', timeout: 30000 })
  return { ctx, page }
}

async function openLink(page, unit) {
  await rowOf(page, unit).locator('button.btn-link-rm').click()
  const modal = page.locator('.confirm-dialog', { hasText: `Link Truck ${unit}` })
  await modal.waitFor({ state: 'visible', timeout: 15000 })
  await modal.locator('.rm-pick-item').first().waitFor({ state: 'visible', timeout: 15000 })
  return modal
}

async function toastText(page) {
  const t = page.locator('.toast.show')
  await t.waitFor({ state: 'visible', timeout: 15000 })
  return clean(await t.innerText())
}

async function runSize(browser, size) {
  // EM0: the switch off.
  {
    const world = makeWorld({ move: false })
    const { ctx, page } = await openTrucks(browser, size, world)
    try {
      const modal = await openLink(page, 'T-200')
      const groups = await texts(modal.locator('.rm-group-label'))
      const free = await texts(modal.locator('.rm-pick-item .rm-pick-id'))
      const button = clean(await modal.locator('.confirm-actions .btn-primary').textContent())
      const w = await widths(page, size)
      record(`EM0 ${size.tag}`, "switch off: T-200's Link dialog is today's",
        `groups ${JSON.stringify(groups)}; devices ${JSON.stringify(free)}; button "${button}"; ${w.text}`,
        groups.length === 0 && JSON.stringify(free) === '["D-4"]' && button === 'Link Selected' && w.ok, await shot(page, `off-${size.tag}`))
    } finally {
      await ctx.close()
      world.db.close()
    }
  }

  const world = makeWorld({ move: true })
  const { ctx, page } = await openTrucks(browser, size, world)
  try {
    // EM1: the picker, with a device on another truck picked.
    let modal = await openLink(page, 'T-200')
    const groups = await texts(modal.locator('.rm-group-label'))
    const free = await texts(modal.locator('.rm-pick-item:not(.rm-move-item) .rm-pick-id'))
    const others = await modal.locator('.rm-move-item').evaluateAll((els) => els.map((el) => [el.querySelector('.rm-pick-id').textContent.trim(), el.querySelector('.rm-move-on').textContent.trim()]))
    await modal.locator('.rm-move-item', { hasText: 'on T-100' }).click()
    const button = clean(await modal.locator('.confirm-actions .btn-primary').textContent())
    let w = await widths(page, size)
    record(`EM1 ${size.tag}`, 'T-200: Free devices and On another truck; picking D-7 makes the button Move here',
      `groups ${JSON.stringify(groups)}; free ${JSON.stringify(free)}; on other trucks ${JSON.stringify(others)}; button "${button}"; ${w.text}`,
      JSON.stringify(groups) === '["Free devices","On another truck"]' && JSON.stringify(free) === '["D-4"]'
        && JSON.stringify(others) === '[["D-7","on T-100"],["D-9","on T-150"]]' && button === 'Move here' && w.ok,
      await shot(page, `picker-${size.tag}`))

    // EM2: the confirm.
    await modal.getByRole('button', { name: 'Move here' }).click()
    const confirm = modal.locator('.rm-move-confirm')
    await confirm.waitFor({ state: 'visible', timeout: 15000 })
    const title = clean(await confirm.locator('.rm-move-title').textContent())
    const line = clean(await confirm.locator('div').nth(1).textContent())
    const buttons = await texts(modal.locator('.confirm-actions button'))
    const listGone = (await modal.locator('.rm-pick-list').count()) === 0
    w = await widths(page, size)
    record(`EM2 ${size.tag}`, 'Move here: the confirm, alone in the dialog, with Cancel and Move device',
      `"${title}" / "${line}"; buttons ${JSON.stringify(buttons)}; list hidden: ${listGone}; ${w.text}`,
      title === WORDS.confirmTitle && line === WORDS.confirmBody && JSON.stringify(buttons) === '["Cancel","Move device"]' && listGone && w.ok,
      await shot(page, `confirm-${size.tag}`))

    // EM3: the move.
    await modal.getByRole('button', { name: 'Move device' }).click()
    const moved = await toastText(page)
    const linked = await rowOf(page, 'T-200').locator('.rm-linked').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
    const freed = await rowOf(page, 'T-100').locator('button.btn-link-rm').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
    w = await widths(page, size)
    record(`EM3 ${size.tag}`, 'Move device: the toast says from when, T-200 reads Linked and T-100 offers Link',
      `"${moved}"; T-200 Linked: ${linked}; T-100 Link: ${freed}; ${w.text}`, moved === WORDS.moved && linked && freed && w.ok, await shot(page, `moved-${size.tag}`))
    await page.locator('.toast.show').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {})

    // EM4: the refusal (N1's bad cell, N11's panel).
    modal = await openLink(page, 'T-300')
    await modal.locator('.rm-move-item', { hasText: 'on T-150' }).click()
    await modal.getByRole('button', { name: 'Move here' }).click()
    await modal.getByRole('button', { name: 'Move device' }).click()
    const refusal = modal.locator('.rm-move-refusal')
    await refusal.waitFor({ state: 'visible', timeout: 15000 })
    const lead = clean(await refusal.locator('b').textContent())
    const paragraphs = await texts(refusal.locator('p'))
    const closeOnly = await texts(modal.locator('.confirm-actions button'))
    const stillOn = await rowOf(page, 'T-150').locator('.rm-linked').isVisible()
    w = await widths(page, size)
    record(`EM4 ${size.tag}`, "D-9 off T-150 is refused: the cell named, the lead in bold, then the data-fix line, and only Close",
      `lead "${lead}"; ${JSON.stringify(paragraphs)}; buttons ${JSON.stringify(closeOnly)}; T-150 still Linked: ${stillOn}; ${w.text}`,
      lead === WORDS.refusalLead && JSON.stringify(paragraphs) === JSON.stringify([WORDS.refusal, WORDS.dataFix]) && JSON.stringify(closeOnly) === '["Close"]' && stillOn && w.ok,
      await shot(page, `refusal-${size.tag}`))

    // EM5: the same row with a time alone under Pickup Appointment, which the stop reads as blank: the move passes.
    await modal.getByRole('button', { name: 'Close' }).click()
    await modal.waitFor({ state: 'hidden', timeout: 15000 })
    world.setRow('L-1001', { 'Pickup Appointment': '14:00' })
    modal = await openLink(page, 'T-300')
    await modal.locator('.rm-move-item', { hasText: 'on T-150' }).click()
    await modal.getByRole('button', { name: 'Move here' }).click()
    await modal.getByRole('button', { name: 'Move device' }).click()
    const movedOff = await toastText(page)
    const onT300 = await rowOf(page, 'T-300').locator('.rm-linked').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
    const offT150 = await rowOf(page, 'T-150').locator('button.btn-link-rm').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
    w = await widths(page, size)
    record(`EM5 ${size.tag}`, 'the same row with "14:00" under Pickup Appointment: D-9 moves off T-150 onto T-300',
      `"${movedOff}"; T-300 Linked: ${onT300}; T-150 Link: ${offT150}; ${w.text}`, movedOff === WORDS.movedOffT150 && onT300 && offT150 && w.ok,
      await shot(page, `moved-time-only-${size.tag}`))
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
      try { await runSize(browser, size) } catch (e) { record(`EM! ${size.tag}`, 'aborted', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
    }
    const moveWrites = writes.filter((x) => / POST \/api\/trucks\/\d+\/move-eld$/.test(x))
    record('EMx', 'no page error; the only writes are the move route, three per size (the move, the refusal and the move off the time-only row)',
      `${pageErrors.length ? pageErrors.join('; ') : 'no page errors'}; writes: ${writes.join(', ') || 'none'}; unanswered GETs (fixtures {}): ${[...unanswered].join(', ') || 'none'}`,
      pageErrors.length === 0 && moveWrites.length === writes.length && writes.length === 3 * SIZES.length)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await new Promise((r) => server.close(() => r()))
    W.cleanup()
  }
  const cell = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  const lines = [
    `# LogisX — Move device, the Trucks page (made-up data) — ${new Date().toISOString()}`,
    '',
    '| Step | What | Observed | Verdict | Screenshot |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${cell(r.step)} | ${cell(r.title)} | ${cell(r.observed)} | ${r.verdict} | ${r.shot ? cell(path.basename(r.shot)) : ''} |`),
    '',
  ]
  const results = path.join(paths.workDir(), 'results-eld-move-device-screen.md')
  fs.writeFileSync(results, lines.join('\n'))
  console.log(`\nresults: ${results}\nscreenshots: ${SHOT_DIR}`)
}

await main()
process.exit(exitCode)
