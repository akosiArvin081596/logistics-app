#!/usr/bin/env node
// LogisX — the arrival pickup line in the load details, on made-up data only
// (ARRIVAL_PICKUP_DATE_ENABLED on and off; client/src/lib/pickupArrival.js words what
// lib/arrival-pickup-display.js sends as `_pickupArrival`).
//
// Staff pages: /dashboard as a made-up Super Admin ("qa-ap-superadmin") and a made-up
// Dispatcher ("qa-ap-dispatcher"), each at 1280x800 and 390x844. The driver page: /driver
// as made-up drivers ("Casey Example", "Bo Example"), at the same two sizes. Every `_pickupArrival`
// is built here by the server's own fieldFor() (lib/arrival-pickup-display.js), so a field has
// the exact keys and values the server sends. Each load's detail is opened and the line read:
//   F0  the fixtures: fieldFor()'s output for the four arrival kinds is as the words expect
//   B1  flag on, Job Board and Active Loads details (Super Admin, Dispatcher): the one grey
//       line, "Pickup (rate con): Mon Dec 7" for a load with the rate-con date only; a load
//       with nothing to say shows no line. The server sends an arrival only for a completed
//       load, so one Active row carries a full arrival to check that component's wording
//       (a component check, not a shape the server sends there)
//   B2  flag on, Completed details: the plan's line for a GPS arrival, a driver's tap, and an
//       arrival the business clock puts on another day ("... on the shipper's clock; Wed Dec 9,
//       12:20 AM EST (GPS). Pay starts Tue Dec 8; ..."); a load with no Delivered row shows
//       "Pickup (rate con): ..." only; the review's D6 kinds (a percentage driver, assigned
//       before FROM, blank Assigned Date) show the same rate-con line and no "Pay starts"
//       (Dispatcher: also a load whose Load ID is withheld and still has its arrival)
//   B3  each line is one <p role="note">, no button or badge inside, a neutral grey
//   B4  flag off (no `_pickupArrival` key on any row): no line on any of those loads
//   D1  the driver's own load detail (Active: the in-transit load; Historical: the delivered
//       ones): the same lines; the percentage driver's own load shows the rate-con line only
//   D2  flag off: no line on his loads
//   A5  per page: no console error or warning, no page error. Messages that also appear with
//       the flag off are not the feature's (listed in the row); a production build has no Vue
//       warnings; resource errors from the aborted sockets and the blocked map host are not counted
// Step names carry the state, role, size and load.
//
// Like driver-emergency-contacts-profile.mjs this boots no server.js, opens no database, reads
// no settings file or key and signs nobody in. It serves the checkout's built client/dist from
// its own static server on 127.0.0.1 (E2E_PORT, default 3185) and answers every /api request in
// the browser with made-up fixtures. Every request to another host is aborted, the socket included.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/arrival-pickup-line.mjs
//
// Env: E2E_PORT (default 3185; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "arrival-pickup-line"), HEADED=1, CHROME_PATH, E2E_WORK_DIR,
// SHOT_DIR (an absolute folder outside the checkout; default <work dir>/shots/<OUT_TAG>).
// Output: the screenshots, <work dir>/results-<OUT_TAG>.txt (one line per step, written as it
// goes) and <work dir>/results-<OUT_TAG>.md. Exit 0 only when no row is FAIL (INFO rows are
// not verdicts).
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import paths from './paths.cjs'

const require = createRequire(import.meta.url)
const display = require(path.join(paths.REPO, 'lib', 'arrival-pickup-display.js'))

const PORT = Number(process.env.E2E_PORT || 3185)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'arrival-pickup-line').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const SIZES = [
  { tag: '1280x800', viewport: { width: 1280, height: 800 } },
  { tag: '390x844', viewport: { width: 390, height: 844 } },
]

function die(msg) {
  console.error(`arrival-pickup-line: ${msg}`)
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
const SUPER_ADMIN = { id: 90401, username: 'qa-ap-superadmin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA AP Super Admin', companyName: '', mustChangePassword: false }
const DISPATCHER = { id: 90402, username: 'qa-ap-dispatcher', role: 'Dispatcher', driverName: '', email: '', fullName: 'QA AP Dispatcher', companyName: '', mustChangePassword: false }
const CASEY = { id: 90403, username: 'qa-ap-casey', role: 'Driver', driverName: 'Casey Example', email: '', fullName: 'Casey Example', companyName: '', mustChangePassword: false }
const BO = { id: 90404, username: 'qa-ap-bo', role: 'Driver', driverName: 'Bo Example', email: '', fullName: 'Bo Example', companyName: '', mustChangePassword: false }
const STAFF = { sa: SUPER_ADMIN, disp: DISPATCHER }
const DAY = 24 * 60 * 60 * 1000
const ZONE = 'America/New_York'
const NOTE = "editing the Pickup Appointment doesn't change it."

// The arrival kinds, built by the server's own fieldFor() from a resolver-shaped answer:
// { start: shipper-local pay day, arrival: { source, ms } }.
const at = (iso) => Date.parse(iso)
const arrival = (start, source, iso, scheduled = '2026-12-07') => display.fieldFor({ start, arrival: { source, ms: at(iso) } }, scheduled, ZONE)
const GPS_SAME = arrival('2026-12-08', 'geofence', '2026-12-08T14:40:00Z')
const TAP = arrival('2026-12-08', 'driver', '2026-12-09T03:30:00Z')
const CROSS = arrival('2026-12-08', 'geofence', '2026-12-09T05:20:00Z')
const RATE = display.fieldFor(null, '2026-12-07', ZONE)
const NONE = display.fieldFor(null, '', ZONE)

const LINE = {
  gps: `Arrived at shipper Tue Dec 8, 9:40 AM EST (GPS). Pay starts this day; ${NOTE} Scheduled (rate con): Mon Dec 7`,
  tap: `Arrived at shipper Tue Dec 8, 10:30 PM EST (driver's tap). Pay starts this day; ${NOTE} Scheduled (rate con): Mon Dec 7`,
  cross: `Arrived at shipper Tue Dec 8 on the shipper's clock; Wed Dec 9, 12:20 AM EST (GPS). Pay starts Tue Dec 8; ${NOTE} Scheduled (rate con): Mon Dec 7`,
  rate: 'Pickup (rate con): Mon Dec 7',
}

// A load row: its id, the sheet status and driver, the field the server sends with the flag on,
// and the line the screen must show (null: none).
const L = (key, id, what, status, driver, field, expect, extra = {}) => ({ key, id, what, status, driver, field, expect, ...extra })

const STAFF_SPECS = {
  jobBoard: [
    L('jb1', 'LD-QA-1101', 'unassigned, rate-con date only', '', '', RATE, LINE.rate),
    L('jb2', 'LD-QA-1102', 'unassigned, nothing to say', '', '', NONE, null),
  ],
  activeLoads: [
    L('ac1', 'LD-QA-1201', 'in transit, rate-con date only (the shape the server sends)', 'In Transit', 'Casey Example', RATE, LINE.rate),
    L('ac2', 'LD-QA-1202', 'in transit with a full arrival (component check only)', 'In Transit', 'Casey Example', GPS_SAME, LINE.gps),
  ],
  completed: [
    L('cp1', 'LD-QA-1301', 'GPS arrival on the shipper day', 'Delivered', 'Casey Example', GPS_SAME, LINE.gps),
    L('cp2', 'LD-QA-1302', "driver's tap", 'Delivered', 'Casey Example', TAP, LINE.tap),
    L('cp3', 'LD-QA-1303', "the business clock puts the arrival on another day", 'Delivered', 'Casey Example', CROSS, LINE.cross),
    L('cp4', 'LD-QA-1304', 'no Delivered row: rate-con date only', 'Delivered', 'Casey Example', RATE, LINE.rate),
    L('cp5', 'LD-QA-1305', 'D6: percentage driver', 'Delivered', 'Bo Example', RATE, LINE.rate, { rule: 'd6' }),
    L('cp6', 'LD-QA-1306', 'D6: assigned before FROM', 'Delivered', 'Casey Example', RATE, LINE.rate, { rule: 'd6', assigned: '11/19/2026' }),
    L('cp7', 'LD-QA-1307', 'D6: blank Assigned Date', 'Delivered', 'Casey Example', RATE, LINE.rate, { rule: 'd6', assigned: '' }),
    L('cp8', 'LD-QA-1308', 'nothing to say', 'Delivered', 'Casey Example', NONE, null),
    L('cp9', '', 'Load ID withheld from a Dispatcher, arrival kept', 'Delivered', 'Casey Example', GPS_SAME, LINE.gps, { withheld: true, dispatcherOnly: true }),
  ],
}
const TAB_LABEL = { jobBoard: 'Job Board', activeLoads: 'Active Loads', completed: 'Completed' }

const DRIVER_SPECS = {
  casey: [
    L('dr1', 'LD-QA-2101', 'in transit, rate-con date only', 'In Transit', 'Casey Example', RATE, LINE.rate, { sub: 'active' }),
    L('dr2', 'LD-QA-2102', 'GPS arrival on the shipper day', 'Delivered', 'Casey Example', GPS_SAME, LINE.gps, { sub: 'historical' }),
    L('dr3', 'LD-QA-2103', "driver's tap", 'Delivered', 'Casey Example', TAP, LINE.tap, { sub: 'historical' }),
    L('dr4', 'LD-QA-2104', 'the business clock puts the arrival on another day', 'Delivered', 'Casey Example', CROSS, LINE.cross, { sub: 'historical' }),
    L('dr5', 'LD-QA-2105', 'no Delivered row: rate-con date only', 'Delivered', 'Casey Example', RATE, LINE.rate, { sub: 'historical' }),
    L('dr6', 'LD-QA-2106', 'D6: assigned before FROM', 'Delivered', 'Casey Example', RATE, LINE.rate, { sub: 'historical', rule: 'd6', assigned: '11/19/2026' }),
    L('dr7', 'LD-QA-2107', 'D6: blank Assigned Date', 'Delivered', 'Casey Example', RATE, LINE.rate, { sub: 'historical', rule: 'd6', assigned: '' }),
    L('dr8', 'LD-QA-2108', 'nothing to say', 'Delivered', 'Casey Example', NONE, null, { sub: 'historical' }),
  ],
  bo: [
    L('dr9', 'LD-QA-2201', 'D6: percentage driver, his own load', 'Delivered', 'Bo Example', RATE, LINE.rate, { sub: 'historical', rule: 'd6' }),
  ],
}

const STAFF_HEADERS = ['Load ID', 'Status', 'Driver', 'Pickup Address', 'Drop-off Address', 'Pickup Appointment', 'Drop-off Appointment', 'Assigned Date', 'Completion Date', 'Payment']
// A driver is not served the rate columns (the server strips them).
const DRIVER_HEADERS = STAFF_HEADERS.filter((h) => h !== 'Payment')

let rowCounter = 100
function sheetRow(spec, mode, headers) {
  const completed = spec.status === 'Delivered'
  const row = {
    'Load ID': spec.id, Status: spec.status, Driver: spec.driver,
    'Pickup Address': '1 Example Dock Rd\nDallas, TX 75201', 'Drop-off Address': '9 Placeholder Ave\nAtlanta, GA 30301',
    'Pickup Appointment': '12/07/2026 08:00', 'Drop-off Appointment': '12/10/2026 14:00',
    'Assigned Date': spec.assigned === undefined ? '11/24/2026' : spec.assigned,
    'Completion Date': completed ? '12/10/2026 14:20' : '', Payment: '$1,250.00',
    _rowIndex: rowCounter++,
    _pickupLocation: 'Dallas, TX 75201', _pickupStreet: '1 Example Dock Rd', _dropLocation: 'Atlanta, GA 30301', _dropStreet: '9 Placeholder Ave',
  }
  if (!headers.includes('Payment')) delete row.Payment
  if (spec.withheld) { row['Load ID'] = ''; row._withheldCells = ['Load ID']; row._loadKey = 'qa-ap-key-9001' }
  if (mode === 'on') row._pickupArrival = JSON.parse(JSON.stringify(spec.field))
  return row
}

// What the "server" holds in one state: the flag, and what each screen asked for.
const freshState = (name, mode) => ({ name, mode, dashboardGets: 0, driverGets: 0 })

function dashboardBody(state, roleKey) {
  const build = (specs) => specs.filter((s) => !s.dispatcherOnly || roleKey === 'disp').map((s) => sheetRow(s, state.mode, STAFF_HEADERS))
  const unassignedJobs = build(STAFF_SPECS.jobBoard)
  const activeJobs = build(STAFF_SPECS.activeLoads)
  const completedJobs = build(STAFF_SPECS.completed)
  return {
    timestamp: new Date().toISOString(),
    kpis: { activeLoads: activeJobs.length, unassignedLoads: unassignedJobs.length, completedThisWeek: completedJobs.length, completedThisMonth: completedJobs.length, fleetUtilization: { assigned: 1, total: 2 }, revenue: { total: 0, paid: 0, pending: 0 } },
    unassignedJobs, jobTrackingHeaders: STAFF_HEADERS, completedHeaders: STAFF_HEADERS, activeJobs, completedJobs,
    fleet: [{ Driver: 'Casey Example', Truck: 'QA-1', Status: 'On Load', CompletedLoads: 8, CurrentLoad: 'LD-QA-1201', Phone: '', QueueCount: 0, QueuedLoadIds: [] }],
    drivers: ['Casey Example', 'Bo Example'], driverQueues: {},
  }
}

function driverBody(state, who) {
  const specs = who === BO ? DRIVER_SPECS.bo : DRIVER_SPECS.casey
  return {
    loads: specs.map((s) => ({ ...sheetRow(s, state.mode, DRIVER_HEADERS), _accepted: true, _docCount: 0, _podCount: 0, _bolCount: 0, _receiptCount: 0, _otherCount: 0 })),
    headers: { jobTracking: DRIVER_HEADERS, carrierDB: [] },
    onboarding: { user_id: who.id, status: 'fully_onboarded', onboarded_at: new Date(Date.now() - 30 * DAY).toISOString(), documents: [], totalDocs: 5 },
    driverInfo: null, truck: null, messages: [], notifications: [], expenses: [], drivers: [], invoices: [], sharedDocuments: [], truckDocuments: [],
  }
}

function answerGet(who, state, pathname) {
  if (pathname === '/api/auth/session') return { status: 200, body: { authenticated: true, user: who, appTimeZone: ZONE } }
  if (who.role === 'Driver') {
    if (pathname === `/api/driver/${encodeURIComponent(who.driverName)}`) {
      state.driverGets++
      return { status: 200, body: driverBody(state, who) }
    }
    if (pathname === '/api/driver/position') {
      return { status: 200, body: { ok: true, unit: 'QA-1', position: { latitude: 33.75, longitude: -84.39, speed: 0, speedMph: 0, heading: 90, timestamp: new Date(Date.now() - 4000).toISOString(), lastPingAge: 4000, source: 'routemate', fuelPct: null, movement: 'stopped', stoppedSinceMs: Date.now() - 10 * 60000 } } }
    }
    if (pathname === '/api/fuel/range') return { status: 200, body: { ok: false } }
    if (pathname.startsWith('/api/geocode/load/')) return { status: 200, body: {} }
    return null
  }
  if (pathname === '/api/dashboard') {
    state.dashboardGets++
    return { status: 200, body: dashboardBody(state, who === DISPATCHER ? 'disp' : 'sa') }
  }
  if (pathname === '/api/dispatch-notifications') return { status: 200, body: { notifications: [], unreadCount: 0 } }
  if (pathname === '/api/load-ratings/averages') return { status: 200, body: { averages: {} } }
  if (pathname === '/api/truck-assignments') return { status: 200, body: { assignments: [] } }
  if (pathname === '/api/config/maps-key') return { status: 200, body: { key: 'qa-ap-no-key' } }
  if (pathname === '/api/locations/latest') return { status: 200, body: { locations: [] } }
  if (pathname.startsWith('/api/documents/')) return { status: 200, body: { documents: [] } }
  if (pathname.startsWith('/api/load-ratings/')) return { status: 200, body: { rating: 0 } }
  if (pathname.startsWith('/api/geocode/load/')) return { status: 200, body: {} }
  if (/^\/api\/loads\/[^/]+\/invoice-draft$/.test(pathname)) return { status: 200, body: { draft: null } }
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the arrival pickup line check"}')
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
const otherWrites = []
const unanswered = new Set()
const pageErrors = []
const ignored = new Map()
let exitCode = 0
let resultsTxt = ''
const ONE_LINE = (s) => String(s).replace(/\r?\n/g, ' ')
// ok true: PASS, false: FAIL, 'info': an observation that is not a verdict.
function record(step, title, expected, observed, ok, shot = '') {
  const verdict = ok === 'info' ? 'INFO' : ok ? 'PASS' : 'FAIL'
  if (verdict === 'FAIL') exitCode = 1
  rows.push({ step, title, expected, observed, verdict, shot })
  const line = `${verdict}  ${step}  ${title}: ${ONE_LINE(observed)}`
  console.log(line)
  if (resultsTxt) fs.appendFileSync(resultsTxt, `${line}\n`)
}

const shotDir = () => {
  const dir = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(paths.workDir(), 'shots', OUT_TAG)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
async function shot(page, name) {
  const file = path.join(shotDir(), `${OUT_TAG}-${String(name).replace(/[^\w.-]/g, '_')}.png`)
  await page.screenshot({ path: file })
  return file
}

// ---------------------------------------------------------------- page helpers
// Resource errors from the aborted socket and the blocked hosts are the harness's own doing.
const NOISE = /Failed to load resource|net::ERR|socket\.io|WebSocket/i
// The map script's host is blocked on purpose.
const MAP_NOISE = /google|gstatic|maps api|maps\.googleapis/i

async function openPage(browser, size, who, state, url) {
  const phone = size.viewport.width < 640
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) return route.abort()
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (req.method() !== 'GET') {
      otherWrites.push(`${size.tag} ${req.method()} ${u.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    const out = answerGet(who, state, u.pathname)
    if (out === null) unanswered.add(u.pathname.replace(/LD-QA-\d+/g, ':load'))
    return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', body: JSON.stringify(out ? out.body : {}) })
  })
  const page = await ctx.newPage()
  const issues = []
  page.on('pageerror', (e) => {
    const msg = String(e.message || e).slice(0, 160)
    pageErrors.push(`${size.tag}: ${msg}`)
    issues.push(`pageerror ${msg}`)
  })
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return
    const t = m.text()
    if (NOISE.test(t)) return
    if (MAP_NOISE.test(t)) { ignored.set(t.slice(0, 120), (ignored.get(t.slice(0, 120)) || 0) + 1); return }
    issues.push(`${m.type()} ${t.slice(0, 160)}`)
  })
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' })
  return { ctx, page, issues }
}

const clean = (t) => (t || '').replace(/\s+/g, ' ').trim()
async function appears(page, selector, ms, state = 'visible') {
  try { await page.waitForSelector(selector, { state, timeout: ms }); return true } catch { return false }
}
async function textAppears(locator, ms) {
  try { await locator.first().waitFor({ state: 'visible', timeout: ms }); return true } catch { return false }
}

// The console of one page load. The flag-off page of the same screen and size is the
// baseline: a message it also shows is not the feature's.
const baselines = new Map()
function judgeConsole(tag, key, issues, isBaseline) {
  if (isBaseline) {
    baselines.set(key, new Set(issues))
    record(`A5-${tag}`, 'The console, flag off (the baseline)', 'no console error or warning, no page error',
      issues.length ? `${issues.length} message(s) with the flag off: ${issues.join(' | ')}` : 'clean', issues.length === 0 ? true : 'info')
    return
  }
  const base = baselines.get(key) || new Set()
  const fresh = issues.filter((i) => !base.has(i))
  const shared = issues.length - fresh.length
  record(`A5-${tag}`, 'The console is clean', 'no console error or warning, no page error beyond the flag-off baseline',
    fresh.length ? fresh.join(' | ') : `clean${shared ? ` (${shared} message(s) also shown with the flag off)` : ''}`, fresh.length === 0)
}

// What the detail shows about the line, or nothing about it.
async function readLine(scope) {
  const els = scope.locator('.pickup-arrival')
  const count = await els.count()
  if (count === 0) return { count: 0 }
  const info = await els.first().evaluate((el) => {
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(el).color) || []
    const rgb = [Number(m[1]), Number(m[2]), Number(m[3])]
    return {
      text: (el.textContent || '').replace(/\s+/g, ' ').trim(), tag: el.tagName, role: el.getAttribute('role'), children: el.children.length,
      button: !!el.querySelector('button'), color: m[0] ? `rgb(${rgb.join(', ')})` : '', spread: m[0] ? Math.max(...rgb) - Math.min(...rgb) : 999,
    }
  })
  return { count, ...info }
}

function judgeLine(spec, mode, info) {
  const expect = mode === 'on' ? spec.expect : null
  if (expect === null) return { ok: info.count === 0, expected: 'no line' }
  const rateOnly = expect === LINE.rate
  const ok = info.count === 1 && info.text === expect && info.tag === 'P' && info.role === 'note' && info.children === 0 && !info.button
    && info.spread <= 40 && (!rateOnly || !/Pay starts/.test(info.text))
  return { ok, expected: `one <p role="note">, text "${expect}"${rateOnly ? ', no "Pay starts"' : ''}, no button or badge inside, a neutral grey` }
}

const observedOf = (info) => (info.count === 0 ? 'no line' : `${info.count} line(s): "${info.text}" (${info.tag}, role ${info.role}, children ${info.children}, button ${info.button}, color ${info.color})`)

// ---------------------------------------------------------------- the staff pages
async function closeDialog(page) {
  await page.keyboard.press('Escape')
  await page.waitForSelector('[role="dialog"]', { state: 'hidden', timeout: 4000 }).catch(() => {})
}

async function staffPage(browser, size, roleKey, mode) {
  const who = STAFF[roleKey]
  const state = freshState(`${mode}`, mode)
  const tag = `${mode}-${roleKey}-${size.tag}`
  const { ctx, page, issues } = await openPage(browser, size, who, state, '/dashboard')
  const stepId = mode === 'on' ? 'B' : 'B4'
  try {
    if (!(await textAppears(page.locator('[role="tab"]', { hasText: 'Job Board' }), 15000))) {
      record(`${tag}-load`, 'The dashboard loads', 'tabs shown within 15 s', 'no tab appeared', false, await shot(page, `${tag}-load`))
      return
    }
    for (const tabKey of Object.keys(TAB_LABEL)) {
      const specs = STAFF_SPECS[tabKey].filter((s) => !s.dispatcherOnly || roleKey === 'disp')
      await page.locator('[role="tab"]', { hasText: TAB_LABEL[tabKey] }).first().click({ timeout: 5000 })
      const clickText = (s) => (s.withheld ? '[contact withheld]' : s.id)
      const panel = page.locator('[role="tabpanel"][data-state="active"]').first()
      if (!(await textAppears(panel.getByText(clickText(specs[0])), 10000))) {
        record(`${tag}-${tabKey}-tab`, `The ${TAB_LABEL[tabKey]} tab lists the made-up loads`, 'the first load shown within 10 s', 'not shown', false, await shot(page, `${tag}-${tabKey}-tab`))
        continue
      }
      for (const spec of specs) {
        const step = `${mode === 'on' ? (tabKey === 'completed' ? 'B2' : 'B1') : 'B4'}-${tag}-${spec.key}`
        let opened = false
        try {
          await panel.getByText(clickText(spec)).first().click({ timeout: 5000 })
          opened = await appears(page, '[role="dialog"]', 5000)
        } catch { opened = false }
        if (!opened) {
          record(step, `${TAB_LABEL[tabKey]}: ${spec.what}`, 'the load detail opens', 'the detail did not open', false, await shot(page, `${step}-noopen`))
          await closeDialog(page)
          continue
        }
        await page.waitForTimeout(400)
        const info = await readLine(page.locator('[role="dialog"]').first())
        const verdict = judgeLine(spec, mode, info)
        const picture = await shot(page, step)
        record(step, `${TAB_LABEL[tabKey]} detail (${spec.what})`, verdict.expected, observedOf(info), verdict.ok, picture)
        await closeDialog(page)
      }
    }
  } catch (e) {
    record(`${stepId}-${tag}-error`, 'the step ran to its end', 'no error', String((e && e.message) || e).slice(0, 220), false)
  } finally {
    judgeConsole(tag, `staff-${roleKey}-${size.tag}`, issues, mode === 'off')
    await ctx.close()
  }
}

// ---------------------------------------------------------------- the driver page
async function driverPage(browser, size, who, mode) {
  const state = freshState(`${mode}`, mode)
  const specs = who === BO ? DRIVER_SPECS.bo : DRIVER_SPECS.casey
  const tag = `${mode}-${who === BO ? 'bo' : 'casey'}-${size.tag}`
  const { ctx, page, issues } = await openPage(browser, size, who, state, '/driver')
  try {
    if (!(await appears(page, '.sub-tab', 20000))) {
      record(`${tag}-load`, 'The driver app lists the made-up loads', 'the Active / Pending / Historical bar within 20 s', 'no sub-tab bar appeared', false, await shot(page, `${tag}-load`))
      return
    }
    for (const spec of specs) {
      const step = `${mode === 'on' ? 'D1' : 'D2'}-${tag}-${spec.key}`
      let opened = false
      try {
        await page.locator('.sub-tab', { hasText: spec.sub === 'historical' ? 'Historical' : 'Active' }).first().click({ timeout: 5000 })
        await page.locator('.load-card', { hasText: spec.id }).first().click({ timeout: 8000 })
        opened = await appears(page, '.load-detail', 5000)
      } catch { opened = false }
      if (!opened) {
        record(step, `Driver detail (${spec.what})`, 'the load detail opens', 'the detail did not open', false, await shot(page, `${step}-noopen`))
        continue
      }
      await page.waitForTimeout(400)
      const info = await readLine(page.locator('.load-detail').first())
      const verdict = judgeLine(spec, mode, info)
      const picture = await shot(page, step)
      record(step, `Driver's load detail (${spec.what})`, verdict.expected, observedOf(info), verdict.ok, picture)
      await page.locator('.detail-topbar button', { hasText: 'Back' }).first().click({ timeout: 5000 }).catch(() => {})
      await page.waitForSelector('.load-detail', { state: 'hidden', timeout: 4000 }).catch(() => {})
    }
  } catch (e) {
    record(`D-${tag}-error`, 'the step ran to its end', 'no error', String((e && e.message) || e).slice(0, 220), false)
  } finally {
    judgeConsole(tag, `driver-${who === BO ? 'bo' : 'casey'}-${size.tag}`, issues, mode === 'off')
    await ctx.close()
  }
}

// F0: the made-up fields are what the words expect; a fixture that drifts from them would test nothing.
function fixtureCheck() {
  const want = [
    ['GPS on the shipper day', GPS_SAME, { day: '2026-12-08', source: 'gps', atDay: '2026-12-08', atTime: '9:40 AM EST', scheduled: '2026-12-07' }],
    ["driver's tap", TAP, { day: '2026-12-08', source: 'driver', atDay: '2026-12-08', atTime: '10:30 PM EST', scheduled: '2026-12-07' }],
    ['business clock on another day', CROSS, { day: '2026-12-08', source: 'gps', atDay: '2026-12-09', atTime: '12:20 AM EST', scheduled: '2026-12-07' }],
    ['rate-con date only', RATE, { scheduled: '2026-12-07' }],
    ['nothing to say', NONE, { scheduled: '' }],
  ]
  for (const [name, got, expected] of want) {
    const keys = Object.keys(expected)
    const ok = keys.every((k) => got[k] === expected[k]) && (keys.length > 2 || Object.keys(got).length === keys.length)
    record(`F0-${name.replace(/\W+/g, '-')}`, `Fixture: ${name}`, JSON.stringify(expected), JSON.stringify(got), ok)
  }
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  resultsTxt = path.join(paths.workDir(), `results-${OUT_TAG}.txt`)
  fs.writeFileSync(resultsTxt, `# ${OUT_TAG} ${new Date().toISOString()} (made-up data)\n`, { mode: 0o600 })
  fixtureCheck()
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve) })
  console.log(`arrival-pickup-line: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const size of SIZES) {
      // The flag-off page of each screen first: it is the console baseline for the flag-on page.
      for (const roleKey of ['sa', 'disp']) {
        await staffPage(browser, size, roleKey, 'off')
        await staffPage(browser, size, roleKey, 'on')
      }
      await driverPage(browser, size, CASEY, 'off')
      await driverPage(browser, size, CASEY, 'on')
      await driverPage(browser, size, BO, 'off')
      await driverPage(browser, size, BO, 'on')
    }
  } finally {
    await browser.close()
    server.close()
  }

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const md = [
    `# Arrival pickup line check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Other writes sent by the page (not part of the verdict): ${otherWrites.length ? otherWrites.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Map-host console messages not counted: ${[...ignored].map(([m, n]) => `${n} x ${m}`).join('; ') || 'none'}`,
    '', `Page errors (judged in the A5 rows): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, md, { mode: 0o600 })
  const tally = (v) => rows.filter((r) => r.verdict === v).length
  const summary = `arrival-pickup-line: ${tally('PASS')} PASS, ${tally('FAIL')} FAIL, ${tally('INFO')} INFO of ${rows.length}; results ${resultsFile} and ${resultsTxt}; screenshots ${shotDir()}`
  console.log(summary)
  fs.appendFileSync(resultsTxt, `${summary}\n`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`arrival-pickup-line: aborted: ${e.stack || e}`)
  process.exit(1)
})
