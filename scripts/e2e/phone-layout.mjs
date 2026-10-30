#!/usr/bin/env node
// LogisX — phone-width layout check, on made-up data only.
//
//   W1  Load detail (Dashboard → Active Loads → a load): every header action of the
//       dialog (Copy tracking link, Override, Edit, Delete for a Super Admin, and the
//       dialog's Close) lies inside the viewport, and the point at its centre is that
//       control, so a tap lands on it. A real tap on Edit opens the edit form.
//   W2  Tracking (a driver focused, so the Fuel & Route card shows): the card's
//       header, its title and its collapse arrow are not covered by the Active Loads
//       panel, and a real tap on the header collapses the card.
//   Both at 390x844 (a phone, touch) as a Super Admin and as a Dispatcher, each with
//   no horizontal page scroll (scrollWidth <= innerWidth). The same steps at
//   768x1024 (W1m, W2m; the first width the header is one row again) and 1280x800
//   (W1d, W2d) check the wider layout: the same controls reachable, the header on
//   one row with its actions on the right, the Fuel & Route card 270 px wide and the
//   Active Loads panel uncapped. The geometry of both wider views is written to the
//   work dir; DESKTOP_BASELINE=<that file from a run on main> fails the run on any
//   difference, so "768 px and up unchanged" is measured, not assumed.
//   W3  Expenses → All Expenses, 25 made-up receipts (five with a Personal line, one
//       in a finalized month) at eleven sizes from 375 to 1440 px, the sidebar open
//       and once folded: the list shows the cards on a phone or when its panel is
//       narrower than 900 px, else the 9-column table; nothing scrolls sideways (the
//       panel or the page); every Personal pill lies inside its card or cell (the
//       table's short tag carries the full sentence as its hover text); no table
//       cell cuts its content; a Super Admin's Personal buttons take a tap, a
//       Dispatcher has none; on a phone every sub-tab is inside the viewport.
//
// Unlike e2e.mjs this boots no server.js, opens no database, reads no .env or key
// and signs nobody in. It serves the checkout's built client/dist from its own
// static server on 127.0.0.1 (E2E_PORT, default 3181) and answers every /api
// request in the browser with the made-up fixtures below (a "QA-PHONE" load, the
// drivers "Pat Example" and friends, made-up coordinates and truck stops). The
// session it answers is a made-up Super Admin or Dispatcher: the client shows what
// that role sees, and the server's own role gates are not under test here.
// Nothing leaves the machine: the Google Maps script is answered with a stub that
// draws nothing, and every other request to a host that is not this server is
// aborted (Google Fonts included, so the page uses its fallback font). Every /api
// write the page sends is answered 200 and listed in the results (none expected).
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   node scripts/e2e/phone-layout.mjs
//
// Env: E2E_PORT (default 3181; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "phone-layout"), HEADED=1, CHROME_PATH, E2E_WORK_DIR,
// DESKTOP_BASELINE (a desktop geometry file from an earlier run).
// Output, in the work dir: shots/<OUT_TAG>/*.png, results-<OUT_TAG>.md and
// desktop-geometry-<OUT_TAG>.json. Exit 0 only when every row PASSes.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import paths from './paths.cjs'

const PORT = Number(process.env.E2E_PORT || 3181)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'phone-layout').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const PHONE = { width: 390, height: 844 }
const TABLET = { width: 768, height: 1024 } // the first width the load detail's header is one row again
const DESKTOP = { width: 1280, height: 800 }
// Step names: W1/W2 on the phone, W1m/W2m at 768 px, W1d/W2d at 1280 px.
const stepName = (n, size, role) => `W${n}${size.width < 640 ? '' : size.width < 1024 ? 'm' : 'd'}-${role === 'Dispatcher' ? 'DSP' : 'SA'}`

function die(msg) {
  console.error(`phone-layout: ${msg}`)
  process.exit(2)
}

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (PORT === 3000 || PORT === 5173) die(`refusing port ${PORT}: 3000 is production's port on the VPS and 5173 is Vite's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm run build:client\` first`)

// ---------------------------------------------------------------- made-up fixtures
const LOAD_ID = 'QA-PHONE-1001'
const DRIVER = 'Pat Example'
const HEADERS = ['Load ID', 'Status', 'Driver', 'Truck', 'Pickup Address', 'Drop-off Address', 'Payment', 'Assigned Date', 'Pickup Appointment', 'Drop-off Appointment']
const ACTIVE_JOB = {
  _rowIndex: 2,
  'Load ID': LOAD_ID,
  Status: 'In Transit',
  Driver: DRIVER,
  Truck: 'QA-T1',
  'Pickup Address': '100 Example Rd, Memphis, TN 38118',
  'Drop-off Address': '200 Sample Ave, Dallas, TX 75201',
  Payment: '$1,234.00',
  'Assigned Date': '2026-10-20',
  'Pickup Appointment': '2026-10-20 08:00',
  'Drop-off Appointment': '2026-10-21 14:00',
  _pickupStreet: '100 Example Rd',
  _pickupLocation: 'Memphis, TN 38118',
  _dropStreet: '200 Sample Ave',
  _dropLocation: 'Dallas, TX 75201',
}
const OTHER_DRIVERS = ['Sam Sample', 'Alex Placeholder', 'Jo Testcase', 'Lee Madeup']
const STOP_COUNT = 8 // enough truck stops to grow the Fuel & Route card to its full height

function user(role) {
  return role === 'Dispatcher'
    ? { id: 90002, username: 'qa-phone-dispatcher', role: 'Dispatcher', driverName: '', email: '', fullName: 'QA Phone Dispatcher', companyName: '', mustChangePassword: false }
    : { id: 90001, username: 'qa-phone-admin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Phone Admin', companyName: '', mustChangePassword: false }
}

function dashboard() {
  return {
    timestamp: new Date().toISOString(),
    kpis: { activeLoads: 1, unassignedLoads: 0, completedThisWeek: 0, completedThisMonth: 0, fleetUtilization: { assigned: 1, total: 5 }, revenue: { total: 0, paid: 0, pending: 0 } },
    unassignedJobs: [],
    jobTrackingHeaders: HEADERS,
    completedHeaders: HEADERS,
    activeJobs: [ACTIVE_JOB],
    completedJobs: [],
    fleet: [],
    drivers: [DRIVER, ...OTHER_DRIVERS],
    driverQueues: {},
  }
}

function locations() {
  const now = new Date().toISOString()
  const focused = {
    driver: DRIVER,
    latitude: 34.75,
    longitude: -92.29,
    timestamp: now,
    lastPingAge: 30000,
    speed: 26,
    heading: 240,
    fuelPct: 62,
    loadId: LOAD_ID,
    source: 'eld',
    assignedTruck: { unit: 'QA-T1', hasEld: true },
    activeLoads: [{
      loadId: LOAD_ID,
      status: 'In Transit',
      details: 'Made-up load for the phone layout check',
      originLat: 35.05, originLng: -89.98, destLat: 32.78, destLng: -96.8,
      pickupStreet: '100 Example Rd', pickupAddress: 'Memphis, TN 38118',
      dropoffStreet: '200 Sample Ave', dropoffAddress: 'Dallas, TX 75201',
    }],
  }
  const others = OTHER_DRIVERS.map((driver, i) => ({
    driver,
    latitude: 33 + i * 0.7,
    longitude: -95 + i * 0.9,
    timestamp: now,
    lastPingAge: 60000,
    speed: i % 2 ? 0 : 27,
    heading: 90,
    loadId: `QA-PHONE-20${i}`,
    source: 'eld',
    assignedTruck: { unit: `QA-T${i + 2}`, hasEld: true },
    activeLoads: [{ loadId: `QA-PHONE-20${i}`, status: 'Dispatched', details: 'Made-up load', originLat: 33, originLng: -95, destLat: 30, destLng: -97 }],
  }))
  return { locations: [focused, ...others] }
}

function fuelStops() {
  const stops = Array.from({ length: STOP_COUNT }, (_, i) => ({
    placeId: `qa-stop-${i}`,
    name: `Example Truck Stop ${i + 1}`,
    brand: 'Example Fuel',
    address: `${100 + i} Sample Hwy, Exampletown, AR`,
    lat: 34.6 - i * 0.2,
    lng: -92.5 - i * 0.4,
    aboutMilesFromRoute: 0.4 + i / 10,
    priceSource: 'regional',
  }))
  return { stops, livePriceCount: 0 }
}

// The Expenses list (W3): made-up receipts with long vendor, place and description
// texts, image and PDF receipts, a large amount, a receipt in a finalized month, and
// five Personal lines in the server's summary shape (a Dispatcher's carries no
// invoice number). The Personal states cover the widest pill texts and buttons.
const EXP_DRIVERS = ['Pat Example', 'Sam Sample', 'Alexandra Placeholder-Madeupname', 'Jo Testcase']
const EXP_TYPES = ['Fuel', 'Repair', 'Maintenance', 'Wear & Tear', 'Toll', 'Food', 'Other']
const EXP_COUNT = 25 // one page at the default page size
const PERSONAL_LINES = {
  0: { state: 'pending', amount_text: '$45.00', week_label: 'Oct 24-30, 2026', wait_text: '', invoice_number: '', final: false, can_undo: true, can_reverse: false },
  1: { state: 'carried', amount_text: '$60.00', week_label: 'Oct 10-16, 2026', wait_text: 'the week of Oct 10-16, 2026 has no weekly invoice; it goes on the next weekly invoice', invoice_number: '', final: false, can_undo: true, can_reverse: false },
  2: { state: 'invoiced', amount_text: '$38.20', week_label: 'Oct 17-23, 2026', wait_text: '', invoice_number: 'INV-QA-2026W43-01', final: true, can_undo: false, can_reverse: false },
  3: { state: 'reversed', amount_text: '$1,234.50', week_label: 'Oct 17-23, 2026', wait_text: 'the line still goes on the next weekly invoice, and its credit with it', invoice_number: '', final: false, can_undo: false, can_reverse: false },
  4: { state: 'invoiced', amount_text: '$99.99', week_label: 'Oct 17-23, 2026', wait_text: '', invoice_number: 'INV-QA-2026W43-02', final: false, can_undo: false, can_reverse: true },
}
const PERSONAL_COUNT = Object.keys(PERSONAL_LINES).length
const FINALIZED_ROW = 5
// A 1x1 PNG for every receipt thumbnail.
const THUMB_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

function expenses(role) {
  const rows = Array.from({ length: EXP_COUNT }, (_, i) => {
    const day = String(28 - (i % 20)).padStart(2, '0')
    return {
      id: 7000 + i,
      date: `2026-10-${day}`,
      timestamp: `2026-10-${day}T19:41:00Z`,
      driver: EXP_DRIVERS[i % EXP_DRIVERS.length],
      truck_unit: `QA-T${(i % 4) + 1}`,
      location_city: i % 5 === 0 ? 'Exampleville Junction' : 'Memphis',
      location_state: 'TN',
      vendor: i % 3 === 0 ? 'Example Travel Center and Truck Stop #1234' : 'Sample Fuel Stop',
      vendor_normalized: i % 3 === 0 ? 'Example Travel Center' : 'Sample Fuel',
      type: EXP_TYPES[i % EXP_TYPES.length],
      description: i % 2 ? 'Made-up receipt for the layout check, with a description long enough to be cut' : '',
      amount: i === 3 ? 12345.67 : 40 + i * 13.5,
      photo_data: i % 6 === 5 ? '/uploads/expense-receipts/qa-made-up.pdf' : i % 7 === 6 ? '' : `/uploads/expense-receipts/qa-made-up-${i}.jpg`,
      status: i in PERSONAL_LINES ? 'Approved' : i % 4 === 1 ? 'Pending' : i % 9 === 8 ? 'Rejected' : 'Approved',
      finalized_period: '',
      personal: null,
    }
  })
  for (const [i, p] of Object.entries(PERSONAL_LINES)) {
    rows[Number(i)].personal = { line_id: 500 + Number(i), ...p, ...(role === 'Dispatcher' ? { invoice_number: '' } : {}) }
  }
  Object.assign(rows[FINALIZED_ROW], { date: '2026-09-29', timestamp: '2026-09-30T13:05:00Z', status: 'Pending', finalized_period: '2026-09' })
  return { expenses: rows, personalEnabled: true, personalReceiptWeek: true }
}

// GET answers by path. Anything not listed gets {} (logged), which every caller on
// these screens reads as "nothing here". The Expenses answers are given only on
// the Expenses scene, so W1 and W2 see exactly what they saw before.
function answerGet(pathname, role, scene) {
  if (scene === 'expenses') {
    if (pathname === '/api/expenses/all') return expenses(role)
    if (pathname === '/api/trucks') return { data: ['QA-T1', 'QA-T2', 'QA-T3', 'QA-T4'].map((UnitNumber) => ({ UnitNumber })) }
    if (pathname === '/api/drivers-directory') return { data: EXP_DRIVERS.map((Driver) => ({ Driver })) }
    if (pathname === '/api/expenses/personal/waiting-corrections') return { groups: [], carried: [] }
  }
  if (pathname === '/api/auth/session') return { authenticated: true, user: user(role), appTimeZone: 'America/New_York' }
  if (pathname === '/api/dashboard') return dashboard()
  if (pathname === '/api/locations/latest') return locations()
  if (pathname === '/api/config/maps-key') return { key: 'qa-phone-layout-no-key' }
  if (pathname === '/api/poi/fuel-stops') return fuelStops()
  if (pathname === '/api/fuel/range') return { ok: false }
  if (pathname === '/api/locations/trail') return { points: [] }
  if (pathname.startsWith('/api/documents/')) return { documents: [] }
  if (pathname.startsWith('/api/load-ratings/')) return { rating: 0 }
  if (pathname.startsWith('/api/geocode/load/')) return { originLat: 35.05, originLng: -89.98, destLat: 32.78, destLng: -96.8 }
  return null
}

// A stand-in for the Maps JavaScript API: every property is a callable,
// constructible no-op that returns another one, so the map code runs and draws
// nothing. `then` is absent (awaiting one resolves at once) and each converts to 0.
const MAPS_STUB = `(() => {
  const handler = {
    get(target, prop) {
      if (prop === 'then') return undefined
      if (prop === Symbol.toPrimitive) return () => 0
      if (prop === Symbol.iterator) return function* () {}
      if (prop in target) return target[prop]
      const next = make()
      target[prop] = next
      return next
    },
    apply() { return make() },
    construct() { return make() },
  }
  function make() { return new Proxy(function () {}, handler) }
  window.google = window.google || {}
  window.google.maps = make()
})();`

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the phone layout check"}')
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
const unanswered = new Set()
const pageErrors = []
let exitCode = 0
function record(step, title, expected, observed, ok, shot = '') {
  if (!ok) exitCode = 1
  rows.push({ step, title, expected, observed, verdict: ok ? 'PASS' : 'FAIL', shot })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${observed}`)
}

// ---------------------------------------------------------------- page helpers
async function openPage(browser, role, size, scene = '') {
  const phone = size.width < 640
  const ctx = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: phone ? 3 : 1,
    isMobile: phone,
    hasTouch: phone,
    serviceWorkers: 'block',
  })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.hostname === 'maps.googleapis.com' && url.pathname === '/maps/api/js') {
      const cb = url.searchParams.get('callback') || ''
      const call = /^[A-Za-z_$][\w$]*$/.test(cb) ? `window[${JSON.stringify(cb)}] && window[${JSON.stringify(cb)}]();` : ''
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: MAPS_STUB + call })
    }
    if (url.host !== `${HOST}:${PORT}`) return route.abort()
    if (url.pathname.startsWith('/socket.io/')) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    // The rate-con driver instructions answer as with their flag off (production
    // today): 404 with no code, so the load detail shows no instructions section.
    if (/^\/api\/loads\/[^/]+\/driver-instructions(\/|$)/.test(url.pathname)) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' })
    }
    if (req.method() !== 'GET') {
      writes.push(`${role} ${req.method()} ${url.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    if (scene === 'expenses' && /^\/api\/expenses\/\d+\/receipt-thumbnail$/.test(url.pathname)) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: THUMB_PNG })
    }
    const body = answerGet(url.pathname, role, scene)
    if (body === null) unanswered.add(url.pathname)
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body || {}) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${role} ${size.width}px: ${String(e.message || e).slice(0, 200)}`))
  return { ctx, page }
}

const shotDir = () => {
  const dir = path.join(paths.workDir(), 'shots', OUT_TAG)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
async function shot(page, name) {
  const file = path.join(shotDir(), `${name}.png`)
  await page.screenshot({ path: file })
  return file
}

// For each element: its box, whether the box lies inside the viewport, and whether
// the topmost element at its centre is that element (or inside it).
async function hitTest(page, handles) {
  return page.evaluate((els) => els.map((el) => {
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const hit = document.elementFromPoint(cx, cy)
    const inViewport = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight
    const describe = (n) => (n ? `${n.tagName.toLowerCase()}${n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}` : 'nothing')
    return {
      name: (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim() || describe(el),
      box: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) },
      inViewport,
      onTop: !!hit && (hit === el || el.contains(hit)),
      hit: describe(hit),
    }
  }), handles)
}

// A tap (phone) or click (desktop) on a screen point, whatever lies there. A point
// off the screen reaches nothing.
async function tapAt(page, x, y, touch) {
  const { innerWidth, innerHeight } = await page.evaluate(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }))
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return
  if (touch) await page.touchscreen.tap(x, y)
  else await page.mouse.click(x, y)
}

// Waits until every finite animation or transition on `selector` and inside it has
// finished (the dialog's zoom-in, a chevron's turn); an endless one is not waited on.
async function settled(page, selector, timeout = 5000) {
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel)
    return !!el && el.getAnimations({ subtree: true })
      .every((a) => a.playState !== 'running' || (a.effect && a.effect.getTiming().iterations === Infinity))
  }, selector, { timeout })
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => ({
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    innerWidth: window.innerWidth,
  }))
}

const round = (n) => Math.round(n * 2) / 2
async function rectsOf(page, selectors) {
  return page.evaluate((sels) => Object.fromEntries(Object.entries(sels).map(([k, sel]) => {
    const el = document.querySelector(sel)
    if (!el) return [k, null]
    const r = el.getBoundingClientRect()
    return [k, { left: r.left, top: r.top, width: r.width, height: r.height }]
  })), selectors).then((o) => Object.fromEntries(Object.entries(o).map(([k, r]) => [k, r && Object.fromEntries(Object.entries(r).map(([a, b]) => [a, round(b)]))])))
}

// ---------------------------------------------------------------- W1: load detail header
async function loadDetail(browser, role, size, geometry) {
  const phone = size.width < 640
  const step = stepName(1, size, role)
  const { ctx, page } = await openPage(browser, role, size)
  try {
    await page.goto(`${BASE}/dashboard?load=${encodeURIComponent(LOAD_ID)}`)
    const dialog = page.getByRole('dialog').filter({ hasText: LOAD_ID })
    await dialog.waitFor({ state: 'visible', timeout: 20000 })
    await settled(page, '[role="dialog"]') // the dialog's zoom-in
    const names = ['Copy tracking link', 'Override', 'Edit', ...(role === 'Super Admin' ? ['Delete'] : [])]
    const handles = []
    for (const n of names) handles.push(await dialog.getByRole('button', { name: n, exact: true }).elementHandle({ timeout: 5000 }))
    handles.push(await dialog.getByRole('button', { name: 'Close', exact: true }).elementHandle({ timeout: 5000 }))
    const hits = await hitTest(page, handles)
    const scroll = await noHorizontalScroll(page)
    const file = await shot(page, `${step}-load-detail`)
    const bad = hits.filter((h) => !h.inViewport || !h.onTop)
    record(step, `Load detail header actions at ${size.width}x${size.height} (${role})`,
      'every header action lies inside the viewport and is the element at its own centre',
      hits.map((h) => `${h.name} [${h.box.left},${h.box.top}-${h.box.right},${h.box.bottom}] ${h.inViewport ? 'in view' : 'OUT OF VIEW'}, ${h.onTop ? 'on top' : `covered by ${h.hit}`}`).join('; '),
      bad.length === 0, file)
    const widthOk = scroll.scrollWidth <= scroll.innerWidth && (!phone || scroll.innerWidth === size.width)
    record(`${step}s`, `No horizontal scroll with the load detail open at ${size.width} px (${role})`,
      `scrollWidth <= innerWidth${phone ? ` and innerWidth = ${size.width}` : ''}`,
      `scrollWidth ${scroll.scrollWidth}, innerWidth ${scroll.innerWidth}`, widthOk, file)

    if (!phone) {
      // Desktop as before: the title and every action share one row, the actions on the right.
      const row = await page.evaluate(({ id, labels }) => {
        const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent.includes(id))
        const title = dlg.querySelector('h2')
        const btns = [...dlg.querySelectorAll('button')].filter((b) => labels.includes(b.textContent.replace(/\s+/g, ' ').trim()))
        const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }
        const header = title.closest('div[style*="justify-content"]') || title.parentElement.parentElement
        const hr = header.getBoundingClientRect()
        const last = btns[btns.length - 1].getBoundingClientRect()
        return { titleMid: mid(title), mids: btns.map(mid), headerRight: hr.right, lastRight: last.right }
      }, { id: LOAD_ID, labels: names })
      const oneRow = row.mids.every((m) => Math.abs(m - row.titleMid) <= 2)
      const rightAligned = Math.abs(row.headerRight - row.lastRight) <= 1
      record(`${step}r`, `Load detail header layout at ${size.width} px (${role})`,
        'the title and every action on one row, the last action at the row\'s right edge',
        `title centre y ${Math.round(row.titleMid)}, action centres y ${row.mids.map(Math.round).join('/')}; last action right ${Math.round(row.lastRight)} vs row right ${Math.round(row.headerRight)}`,
        oneRow && rightAligned, file)
      geometry[`loadDetail-${role}-${size.width}`] = await page.evaluate(({ id, labels }) => {
        const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent.includes(id))
        const out = {}
        const put = (k, el) => { if (!el) return; const r = el.getBoundingClientRect(); out[k] = { left: r.left, top: r.top, width: r.width, height: r.height } }
        put('dialog', dlg)
        put('title', dlg.querySelector('h2'))
        for (const b of dlg.querySelectorAll('button')) {
          const t = b.textContent.replace(/\s+/g, ' ').trim()
          if (labels.includes(t)) put(`button:${t}`, b)
        }
        return out
      }, { id: LOAD_ID, labels: names }).then((o) => Object.fromEntries(Object.entries(o).map(([k, r]) => [k, Object.fromEntries(Object.entries(r).map(([a, b]) => [a, Math.round(b * 2) / 2]))])))
    } else {
      // A real tap where Edit shows opens the edit form (client-side only; nothing is
      // saved). A tap on the screen point, not locator.tap(), which would first scroll
      // the clipped dialog sideways, as no finger can.
      const edit = hits[names.indexOf('Edit')].box
      await tapAt(page, (edit.left + edit.right) / 2, (edit.top + edit.bottom) / 2, true)
      const editOpen = await page.getByRole('heading', { name: `Edit Load — ${LOAD_ID}` })
        .waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)
      const tapFile = await shot(page, `${step}-edit-tapped`)
      record(`${step}t`, `Tapping Edit in the load detail at ${size.width} px (${role})`,
        `the edit form ("Edit Load — ${LOAD_ID}") opens`, editOpen ? 'the edit form opened' : 'no edit form opened', editOpen, tapFile)
    }
  } catch (e) {
    record(step, `Load detail at ${size.width}x${size.height} (${role})`, 'the load detail opens', `aborted: ${String(e.message || e).split('\n')[0]}`, false, await shot(page, `${step}-aborted`).catch(() => ''))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- W2: Tracking, Fuel & Route header
async function tracking(browser, role, size, geometry) {
  const phone = size.width < 640
  const step = stepName(2, size, role)
  const { ctx, page } = await openPage(browser, role, size)
  try {
    await page.goto(`${BASE}/tracking`)
    const panel = page.locator('.driver-panel')
    await panel.waitFor({ state: 'visible', timeout: 20000 })
    await panel.locator('.driver-item', { hasText: DRIVER }).click()
    const toggle = page.locator('.fuel-finder .ff-toggle')
    await toggle.waitFor({ state: 'visible', timeout: 10000 })
    // The state the bug showed in: the driver's load expanded in the panel, every
    // made-up truck stop listed in the card, no route fetch pending, nothing moving.
    await panel.locator('.route-accordion').waitFor({ state: 'visible', timeout: 10000 })
    await page.waitForFunction((n) => document.querySelectorAll('.fuel-finder .ff-stop').length === n, STOP_COUNT, { timeout: 10000 })
    await page.locator('.route-overlay').waitFor({ state: 'detached', timeout: 10000 })
    await settled(page, '.map-wrap')
    const parts = [
      await toggle.elementHandle(),
      await page.locator('.fuel-finder .ff-title-text').elementHandle(),
      await page.locator('.fuel-finder .ff-chevron').elementHandle(),
    ]
    const hits = await hitTest(page, parts)
    // Hit-testing a part of the header counts when the topmost element is inside the header button.
    const inHeader = await page.evaluate(() => {
      const t = document.querySelector('.fuel-finder .ff-toggle')
      const test = (el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && t.contains(hit) }
      return [t, t.querySelector('.ff-title-text'), t.querySelector('.ff-chevron')].map(test)
    })
    const overlap = await page.evaluate(() => {
      const a = document.querySelector('.driver-panel').getBoundingClientRect()
      const b = document.querySelector('.fuel-finder .ff-toggle').getBoundingClientRect()
      return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)
    })
    const scroll = await noHorizontalScroll(page)
    const file = await shot(page, `${step}-tracking`)
    const labels = ['header', 'title', 'collapse arrow']
    const ok = hits.every((h, i) => h.inViewport && inHeader[i]) && !overlap
    record(step, `Fuel & Route header at ${size.width}x${size.height} (${role})`,
      'the header, its title and its collapse arrow lie inside the viewport, uncovered; the Active Loads panel does not overlap the header',
      hits.map((h, i) => `${labels[i]} [${h.box.left},${h.box.top}-${h.box.right},${h.box.bottom}] ${h.inViewport ? 'in view' : 'OUT OF VIEW'}, ${inHeader[i] ? 'uncovered' : `covered by ${h.hit}`}`).join('; ') + `; panel ${overlap ? 'OVERLAPS' : 'clear of'} the header`,
      ok, file)
    const widthOk = scroll.scrollWidth <= scroll.innerWidth && (!phone || scroll.innerWidth === size.width)
    record(`${step}s`, `No horizontal scroll on Tracking at ${size.width} px (${role})`,
      `scrollWidth <= innerWidth${phone ? ` and innerWidth = ${size.width}` : ''}`,
      `scrollWidth ${scroll.scrollWidth}, innerWidth ${scroll.innerWidth}`, widthOk, file)

    if (!phone) {
      const desk = await page.evaluate(() => {
        const ff = document.querySelector('.fuel-finder').getBoundingClientRect()
        const panelEl = document.querySelector('.driver-panel')
        return { fuelWidth: ff.width, panelMaxHeight: getComputedStyle(panelEl).maxHeight }
      })
      const okDesk = Math.abs(desk.fuelWidth - 270) < 0.5 && /^calc\(100% - 20px\)$/.test(desk.panelMaxHeight.replace(/\s+/g, ' '))
      record(`${step}r`, `Tracking layout at ${size.width} px (${role})`, 'the Fuel & Route card 270 px wide; the Active Loads panel capped only by the map (calc(100% - 20px))',
        `card ${desk.fuelWidth} px; panel max-height ${desk.panelMaxHeight}`, okDesk, file)
      geometry[`tracking-${role}-${size.width}`] = await rectsOf(page, { map: '.map-wrap', panel: '.driver-panel', fuel: '.fuel-finder', fuelHeader: '.fuel-finder .ff-toggle' })
    }

    // A real tap (or click) on the header's screen point collapses the card.
    const head = hits[0].box
    await tapAt(page, (head.left + head.right) / 2, (head.top + head.bottom) / 2, phone)
    const collapsed = await page.waitForFunction(
      () => document.querySelector('.fuel-finder .ff-toggle')?.getAttribute('aria-expanded') === 'false', null, { timeout: 5000 },
    ).then(() => true, () => false)
    const tapFile = await shot(page, `${step}-fuel-collapsed`)
    record(`${step}t`, `${phone ? 'Tapping' : 'Clicking'} the Fuel & Route header (${role})`, 'the card collapses (aria-expanded false)',
      collapsed ? 'collapsed' : 'did not collapse', collapsed, tapFile)
  } catch (e) {
    record(step, `Tracking at ${size.width}x${size.height} (${role})`, 'the Fuel & Route card shows for a focused driver', `aborted: ${String(e.message || e).split('\n')[0]}`, false, await shot(page, `${step}-aborted`).catch(() => ''))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- W3: the Expenses list
// TABLE_MIN_WIDTH in ExpensesTab.vue: below 900 px of list panel the cards show.
// With the 240 px sidebar open that is a window of about 1246 px, so 1245 and 1246
// sit on either side of it; 1100 with the sidebar folded (64 px) shows the table.
// `expect` pins the layout a size must get; without one, the measured panel width
// decides.
const TABLE_MIN_WIDTH = 900
const EXPENSE_SIZES = [
  { width: 375, height: 812, expect: 'cards' },
  { width: 390, height: 844, expect: 'cards' },
  { width: 768, height: 1024, expect: 'cards' },
  { width: 899, height: 1000, expect: 'cards' },
  { width: 900, height: 1000, expect: 'cards' },
  { width: 1024, height: 768, expect: 'cards' },
  { width: 1100, height: 800, folded: true, expect: 'table' },
  { width: 1245, height: 800 },
  { width: 1246, height: 800 },
  { width: 1280, height: 800, expect: 'table' },
  { width: 1440, height: 900, expect: 'table' },
]
const SHORT_TAG_RE = /^Personal(?: -\$[\d,]+\.\d{2})? · (?:waiting|carried|final|invoiced|correction|needs correction|reversed|reversed, waiting|on \S+)$/
const LIST_ROWS = '.sub-panel .mobile-exp-card, .sub-panel table.exp-table tbody tr'

async function expensesList(browser, role, size) {
  const phone = size.width < 640
  const sizeText = `${size.width}x${size.height}${size.folded ? ', sidebar folded' : ''}`
  const step = `W3${phone ? '' : size.width < 1024 ? 'm' : 'd'}-${size.width}${size.folded ? 'f' : ''}-${role === 'Dispatcher' ? 'DSP' : 'SA'}`
  const { ctx, page } = await openPage(browser, role, size, 'expenses')
  try {
    if (size.folded) await ctx.addInitScript(() => { try { localStorage.setItem('sidebar-collapsed', '1') } catch { /* the sidebar stays open */ } })
    await page.goto(`${BASE}/expenses`)
    await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length === n, [LIST_ROWS, EXP_COUNT], { timeout: 20000 })
    // Two frames for the panel's ResizeObserver, which may still switch the layout.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length === n, [LIST_ROWS, EXP_COUNT], { timeout: 5000 })

    const facts = await page.evaluate(() => {
      const num = (v) => parseFloat(v) || 0
      const contentBox = (el) => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return { left: r.left + num(s.borderLeftWidth) + num(s.paddingLeft), right: r.right - num(s.borderRightWidth) - num(s.paddingRight) }
      }
      const panel = document.querySelector('.sub-panel')
      const ps = getComputedStyle(panel)
      const table = panel.querySelector('table.exp-table')
      const doc = document.scrollingElement || document.documentElement
      const pills = [...panel.querySelectorAll('.personal-pill')].map((p) => {
        const box = contentBox(p.closest('.mobile-exp-card') || p.closest('td'))
        const r = p.getBoundingClientRect()
        return {
          text: p.textContent.replace(/\s+/g, ' ').trim(),
          title: p.getAttribute('title') || '',
          inside: r.width > 0 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5,
          left: Math.round(r.left), right: Math.round(r.right), boxRight: Math.round(box.right),
        }
      })
      const cut = table
        ? [...table.querySelectorAll('th, td')].filter((c) => c.scrollWidth > c.clientWidth + 1)
          .map((c) => `${c.tagName.toLowerCase()} row ${c.parentElement.rowIndex} col ${c.cellIndex + 1} ${c.scrollWidth}/${c.clientWidth}`)
        : []
      const buttonsOut = table
        ? [...table.querySelectorAll('td.action-cell button')].filter((b) => {
          const box = contentBox(b.closest('td'))
          const r = b.getBoundingClientRect()
          return r.left < box.left - 0.5 || r.right > box.right + 0.5
        }).map((b) => `${b.textContent.trim()} (row ${b.closest('tr').rowIndex})`)
        : []
      return {
        layout: table ? 'table' : panel.querySelector('.mobile-exp-list') ? 'cards' : 'none',
        panelWidth: Math.round((panel.clientWidth - num(ps.paddingLeft) - num(ps.paddingRight)) * 10) / 10,
        panelScroll: { sw: panel.scrollWidth, cw: panel.clientWidth },
        pageScroll: { sw: Math.max(doc.scrollWidth, document.body.scrollWidth), iw: window.innerWidth },
        columns: table ? table.querySelectorAll('thead th').length : 0,
        pills,
        cut,
        buttonsOut,
        personalButtons: panel.querySelectorAll('.btn-personal, .btn-personal-undo').length,
        tabs: [...document.querySelectorAll('.sub-tab')].map((t) => {
          const r = t.getBoundingClientRect()
          return { name: t.textContent.trim(), inside: r.width > 0 && r.left >= 0 && r.right <= window.innerWidth }
        }),
      }
    })

    await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'start', behavior: 'instant' }), '.sub-panel .mobile-exp-list, .sub-panel table.exp-table')
    const file = await shot(page, `${step}-expenses`)

    const expected = size.expect || (size.width < 768 || facts.panelWidth < TABLE_MIN_WIDTH ? 'cards' : 'table')
    record(step, `Expenses list layout at ${sizeText} (${role})`,
      `${expected}${size.expect ? '' : ` (by the list panel's width: cards below ${TABLE_MIN_WIDTH} px)`}${expected === 'table' ? ', 9 columns' : ''}`,
      `${facts.layout}; list panel ${facts.panelWidth} px${facts.layout === 'table' ? `, ${facts.columns} columns` : ''}`,
      facts.layout === expected && (expected !== 'table' || facts.columns === 9), file)

    const scrollOk = facts.panelScroll.sw <= facts.panelScroll.cw && facts.pageScroll.sw <= facts.pageScroll.iw && (!phone || facts.pageScroll.iw === size.width)
    record(`${step}s`, `No sideways scroll in the Expenses list at ${sizeText} (${role})`,
      `the list panel's scrollWidth <= clientWidth and the page's scrollWidth <= innerWidth${phone ? ` (${size.width})` : ''}`,
      `list panel ${facts.panelScroll.sw}/${facts.panelScroll.cw}; page ${facts.pageScroll.sw}/${facts.pageScroll.iw}`, scrollOk, file)

    const table = facts.layout === 'table'
    const badPill = (p) => !p.inside || (table ? !SHORT_TAG_RE.test(p.text) || !p.title || p.title === p.text : p.text !== p.title)
    record(`${step}p`, `Personal pills at ${sizeText} (${role})`,
      `${PERSONAL_COUNT} pills, each inside its ${table ? 'cell: the short tag, the full sentence as its hover text' : 'card: the full sentence'}`,
      facts.pills.map((p) => `"${p.text}" ${p.inside ? 'inside' : `OUTSIDE (${p.left}-${p.right}, box right ${p.boxRight})`}`).join('; ') || 'no pills',
      facts.pills.length === PERSONAL_COUNT && !facts.pills.some(badPill), file)

    if (table) {
      record(`${step}c`, `Table cells at ${sizeText} (${role})`,
        'no header or cell cuts its content (scrollWidth <= clientWidth; the one-line texts that end in an ellipsis cut only themselves), and every action button lies inside its cell',
        `${facts.cut.length ? `cut: ${facts.cut.join('; ')}` : 'nothing cut'}; ${facts.buttonsOut.length ? `outside their cell: ${facts.buttonsOut.join('; ')}` : 'every action button inside its cell'}`,
        facts.cut.length === 0 && facts.buttonsOut.length === 0, file)
    }

    if (role === 'Super Admin') {
      const hits = await page.evaluate(() => [...document.querySelector('.sub-panel').querySelectorAll('.btn-personal, .btn-personal-undo')].map((b) => {
        b.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
        const r = b.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return {
          name: b.textContent.trim(),
          ok: !!hit && (hit === b || b.contains(hit)) && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
        }
      }))
      const count = (n) => hits.filter((h) => h.name === n).length
      const missed = hits.filter((h) => !h.ok).map((h) => h.name)
      record(`${step}b`, `Personal buttons take a ${phone ? 'tap' : 'click'} at ${sizeText} (${role})`,
        'each Personal / Undo Personal / Reverse Personal button, scrolled into view, lies inside the viewport and is the element at its centre; Undo Personal twice, Reverse Personal once, Personal at least once',
        `${hits.length} buttons: Personal ${count('Personal')}, Undo Personal ${count('Undo Personal')}, Reverse Personal ${count('Reverse Personal')}; ${missed.length ? `missed: ${missed.join(', ')}` : 'every one hit'}`,
        missed.length === 0 && count('Undo Personal') === 2 && count('Reverse Personal') === 1 && count('Personal') >= 1, file)
    } else {
      record(`${step}b`, `No Personal buttons for a Dispatcher at ${sizeText}`, 'none (the pills only)',
        `${facts.personalButtons} button(s)`, facts.personalButtons === 0, file)
    }

    if (phone) {
      const out = facts.tabs.filter((t) => !t.inside).map((t) => t.name)
      const want = role === 'Super Admin' ? 6 : 4
      record(`${step}t`, `Expenses sub-tabs at ${sizeText} (${role})`, `all ${want} tabs inside the viewport`,
        `${facts.tabs.length} tabs; ${out.length ? `outside: ${out.join(', ')}` : 'all inside'}`, facts.tabs.length === want && out.length === 0, file)
    }
  } catch (e) {
    record(step, `Expenses list at ${sizeText} (${role})`, 'the list shows its made-up receipts', `aborted: ${String(e.message || e).split('\n')[0]}`, false, await shot(page, `${step}-aborted`).catch(() => ''))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- the run
function compareGeometry(base, now) {
  const diffs = []
  for (const key of new Set([...Object.keys(base), ...Object.keys(now)])) {
    const a = base[key] || {}
    const b = now[key] || {}
    for (const el of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[el]) !== JSON.stringify(b[el])) diffs.push(`${key} ${el}: ${JSON.stringify(a[el])} -> ${JSON.stringify(b[el])}`)
    }
  }
  return diffs
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve) })
  console.log(`phone-layout: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  const geometry = {}
  try {
    for (const role of ['Super Admin', 'Dispatcher']) {
      for (const size of [PHONE, TABLET, DESKTOP]) {
        await loadDetail(browser, role, size, geometry)
        await tracking(browser, role, size, geometry)
      }
      for (const size of EXPENSE_SIZES) await expensesList(browser, role, size)
    }
  } finally {
    await browser.close()
    server.close()
  }

  const geoFile = path.join(paths.workDir(), `desktop-geometry-${OUT_TAG}.json`)
  fs.writeFileSync(geoFile, JSON.stringify(geometry, null, 2) + '\n', { mode: 0o600 })
  if (process.env.DESKTOP_BASELINE) {
    const base = JSON.parse(fs.readFileSync(process.env.DESKTOP_BASELINE, 'utf8'))
    const diffs = compareGeometry(base, geometry)
    record('Wg', 'Desktop geometry against the baseline', 'every measured desktop box identical to the baseline run',
      diffs.length ? diffs.join('; ') : `identical (${Object.keys(geometry).length} views)`, diffs.length === 0)
  }
  record('Wx', 'Writes sent by the page', 'none', writes.length ? writes.join('; ') : 'none', writes.length === 0)

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  // A table cell: backslashes first, so an observed "\|" can't end the cell early.
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const md = [
    `# Phone layout check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, md, { mode: 0o600 })
  console.log(`phone-layout: ${rows.filter((r) => r.verdict === 'PASS').length}/${rows.length} PASS; results ${resultsFile}; desktop geometry ${geoFile}`)
  if (unanswered.size) console.log(`phone-layout: answered with {}: ${[...unanswered].sort().join(', ')}`)
  if (pageErrors.length) console.log(`phone-layout: page errors: ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`phone-layout: aborted: ${e.stack || e}`)
  process.exit(1)
})
