#!/usr/bin/env node
// LogisX — the driver app's Fuel section with the driver gallons flag (DRIVER_FUEL_GALLONS_ENABLED,
// plan R14 PR 2), on made-up data only: 390 x 844 first, then 1280 x 800.
//
//   DF1   before pickup: enough to reach the pickup, add to finish; the collapsed badge "Add 65 gal"
//   DF2   in transit, enough            DF3  refuel now             DF4  no ELD fuel reading
//   DF5   ELD silent 18 hrs             DF6  no tank size, and the header chip "Fuel range: not available"
//   DF7   load not mapped (400 NO_ROUTE)
//   DF8a  position 3 hrs old            DF8b no position (one whole-load row)
//   DF9   extra stops                   DF10 a run longer than a full tank
//   DF11  Route Options without Google's gallons
//   DF12  the flag off: today's panel and rows, unchanged, and Route Options with their gallons
//   DF13  pickup not on the map: the row says only "Check your gauge", the reason, the stops lead
//   DF14  sensor dropout, 300 mi since: the block's 185 mi everywhere, never the verdict's 319
//   DF1d, DF6d, DF12d  the same at 1280 x 800 (the block one column, at most about 520 px wide)
//   DFC1-DFC6 the header chip on the Loads list at 390 x 844: its sentence (flag on and off), "not
//         available", "Refuel now", a very long name. The chip is on its own row, whole and on screen;
//         Password and Logout are on screen and take a tap; the page starts below the header
//   DFC7  the first fuel answer held back: the header and the page don't move when it comes
//         (DFC7n at 360 x 800 and DFC7s at 320 x 568, the long name on both)
//   DFC8  a failed read: no chip and nothing invented, the buttons as ever
//   DFC1d, DFC3d  at 1280 x 800: the chip on the same row as the buttons
//   DFT1-DFT6  the chip's tap at 390 x 844, with a load: the load's Fuel section open and in view, below
//         the header. DFT2 a newer load queued behind the one on the road; DFT3 only queued loads; DFT4
//         the flag off: one range figure on the first screen, and "How we know" in its new words; DFT4b
//         a run that clears, with its badge; DFT4c refuel now; DFT5 from another tab; DFT6 on a load's
//         own page, and again after shutting it
//   DFT7-DFT10 with no load to open: the chip's own line as a toast and the screen stays. DFT7 flag on,
//         held for longer than an ordinary toast; DFT8 flag off, the same words; DFT9a/b "not available"
//         with its reason, both flags; DFT10 only an offer not yet accepted
//   DFT11 a dialog over the chip: a tap at the chip's place stays the dialog's, and a press that a
//         keyboard or a screen reader could still send does nothing
//   DFT12 a real button: a 44 px target with no taller row, Password and Logout keep their whole tap
//         area, Tab reaches it with a visible ring, Enter opens the load
//   DFT13a/b the two lock screens (onboarding, a failed first load): a plain chip that does nothing
//   DFT14 a delivered load's page on screen, a load on the road: the load on the road
//   DFT15 a delivered load's page on screen, no other load: the toast, and the page stays
//   DFT16 two loads under way: the one furthest along, not the newest row
//   DFT17 a repeat tap hours later (flag off): the new figure, the stops not asked for again
//   DFT18 a tap that failed, then a tap with signal back: the figures, not the saved failure
//   DFT1r Route Options and a tall instructions card landing after the scroll, with the browser's scroll
//         anchoring off, as on a phone that has none: the title stays in view. DFT1t the same, after
//         the driver has touched the page: it isn't pulled back
//   DFT1d, DFT7d  the same at 1280 x 800
//   DFO1-DFO6  Offline shows and clears at 390, 360 and 320 wide, a two-word and a very long name:
//         the header and the page don't move at all, and the long name's header is the short one's
//   DFO7  the same on a load's own page at 360    DFO8  the same at 768, on one row
//   DFM1-DFM3, DFM1d  Messages opened at 390, 320 and 1280: its input and Send stay above the tab bar
//   DFx   no page errors, no console errors, no writes
// At 390 x 844 every step also checks: no sideways scroll, row text at least 14 px, Refresh at least 44 px.
//
// Like phone-layout.mjs: no server.js, database, settings file, key or sign-in. The checkout's built
// client/dist is served from a static server on 127.0.0.1 (E2E_PORT, default 3186; 3000, 5173 and 3901
// refused), every /api request is answered in the browser with made-up fixtures (a made-up Driver,
// "Driver QA", on load QA-FUEL-1, truck "Unit 901", Riverton to Lakeside), and the fuel answers' blocks
// are built by the server's own planDriverFuel() (lib/fuel-model.js). The Google Maps script is a stub
// that draws nothing; every other host is aborted. The DFO steps answer the build's real socket.io
// client with a stand-in for the server's socket, so it connects and drops as it would in the field.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   SHOTS_DIR=~/LogisX-replica/screens/driver-fuel-gallons fnm exec --using=22.23.2 node scripts/e2e/driver-fuel-screen.mjs
//
// Env: E2E_PORT, OUT_TAG (default "driver-fuel-screen"), SHOTS_DIR (default <work dir>/shots/<OUT_TAG>),
// HEADED=1, CHROME_PATH, E2E_WORK_DIR. Output: the screenshots and results-<OUT_TAG>.md in the work
// dir. Run it outside the Claude Code Bash sandbox (Chrome binds its own sockets). Exit 0 only when
// every row PASSes.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'
import paths from './paths.cjs'

const require = createRequire(import.meta.url)
const PORT = Number(process.env.E2E_PORT || 3186)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'driver-fuel-screen').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const PHONE = { width: 390, height: 844 }
const NARROW = { width: 360, height: 800 }
const SMALL = { width: 320, height: 568 }
const TABLET = { width: 768, height: 1024 }
const DESKTOP = { width: 1280, height: 800 }
const isPhone = (viewport) => viewport.width < 768

function die(msg) {
  console.error(`driver-fuel-screen: ${msg}`)
  process.exit(2)
}
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (PORT === 3000 || PORT === 5173 || PORT === 3901) die(`refusing port ${PORT}: 3000 is production's port on the VPS, 5173 is Vite's and 3901 the replica's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm run build:client\` first`)

const WORK = paths.workDir()
const SHOTS = process.env.SHOTS_DIR ? path.resolve(process.env.SHOTS_DIR) : path.join(WORK, 'shots', OUT_TAG)
fs.mkdirSync(SHOTS, { recursive: true, mode: 0o700 })
const RESULTS = path.join(WORK, `results-${OUT_TAG}.md`)

// ---------------------------------------------------------------- made-up fixtures
const fuel = require(path.join(paths.REPO, 'lib', 'fuel-model.js'))
const DRIVER_NAME = 'Driver QA'
const DRIVER = { id: 90031, username: 'qa-fuel-driver', role: 'Driver', driverName: DRIVER_NAME, email: '', fullName: DRIVER_NAME, companyName: '', mustChangePassword: false }
const LONG_NAME = 'Maximiliano Bartholomew-Featherstone'
const SHORT_NAME = 'Pat Examplesson'
const LOAD_ID = 'QA-FUEL-1'
const HEADERS = ['Load ID', 'Job Status', 'Driver', 'Pickup Address', 'Drop-off Address', 'Pickup Appointment', 'Drop-off Appointment']
const R15 = { minMiles: 15, fraction: 0 }
const BURN5 = { usable: true, p10: 5.0, p50: 7.4, p90: 10.2, n: 40, miles: 9000, points: 1216, milesPerPoint: 7.4 }
const NO_BURN = { usable: false, p10: null, p50: null, p90: null, milesPerPoint: null }
const MIN = 60000

// Both fuel answers as the server sends them; the blocks from planDriverFuel(). Defaults: 48%, 40
// measured legs (p10 5.0 mi a point), a 150 gal tank, 6.0 MPG, 140 mi to the pickup and 420 in all.
function world(o = {}) {
  const s = {
    flag: true, pct: 48, fuelSource: 'live', readAge: 12, burn: BURN5, tank: 150, tankSource: 'truck', mpg: 6.0,
    routeMiles: 420, leg: 'to_pickup', approach: 140, hasTruck: true, hasDevice: true, fromLivePosition: true,
    positionAgeMinutes: 12, extraStops: false, afterAnotherLoad: false, routeSource: 'routes_api',
    pickupUnmapped: false, anchor: null, milesSince: 0, pickedUp: false, ...o,
  }
  const sensor = s.hasTruck && s.hasDevice
  const reading = !sensor || s.fuelSource === 'none' ? { fuelPct: null, fuelSource: 'none', anchorPct: null, ageMinutes: null, milesSinceReading: null }
    : s.fuelSource === 'stale' ? { fuelPct: null, fuelSource: 'stale', anchorPct: s.pct, ageMinutes: s.readAge, milesSinceReading: null }
      : { fuelPct: s.pct, fuelSource: s.fuelSource, anchorPct: s.anchor == null ? s.pct : s.anchor, ageMinutes: s.readAge, milesSinceReading: s.milesSince }
  const pct = reading.fuelPct
  const rangeMiles = pct == null ? null : fuel.computeRange({ fuelPct: pct, tankGallons: s.tank, mpg: s.mpg }).rangeMiles
  const trip = fuel.planTripFuel({ routeMiles: s.routeMiles, fuelPct: pct, burn: s.burn, rangeMiles, mpg: s.mpg, reserve: R15 })
  const common = { reading, hasTruck: s.hasTruck, hasDevice: sensor, tankSource: s.tankSource, tankGallons: s.tank, mpg: s.mpg, burn: s.burn, reserve: R15 }
  const approach = s.leg === 'to_pickup' ? s.approach : 0
  const planBlock = fuel.planDriverFuel({
    ...common, plan: trip, leg: s.leg, approachMiles: approach,
    fromLivePosition: s.fromLivePosition, positionAgeMinutes: s.fromLivePosition ? s.positionAgeMinutes : null,
    routeSource: s.routeSource, extraStops: s.extraStops, afterAnotherLoad: s.afterAnotherLoad, pickupUnmapped: s.pickupUnmapped,
    approachUncounted: !s.pickedUp && !s.fromLivePosition,
  })
  const iv = fuel.rangeInterval({ fuelPct: pct, burn: s.burn, rangeMiles })
  const updatedAt = new Date(Date.now() - 12 * MIN).toISOString()
  const range = {
    ok: true, driver: null, unit: '901', hasFuelData: pct != null, fuelPct: pct,
    gallonsRemaining: pct == null ? null : Math.round(pct * s.tank) / 100, tankGallons: s.tank, tankSource: s.tankSource,
    mpg: s.mpg, mpgSource: 'receipts', rangeMiles,
    rangeLowMiles: iv.low, rangeTypicalMiles: iv.typical, rangeHighMiles: iv.high, rangePlanningMiles: iv.planning,
    rangeBasis: iv.basis, milesPerFuelPoint: iv.milesPerPoint, reserveMiles: 15,
    rangeUsableMiles: iv.planning == null ? null : Math.max(0, Math.round(iv.planning - 15)),
    fuelSource: reading.fuelSource, fuelAnchorPct: reading.anchorPct, fuelReadingAgeMinutes: reading.ageMinutes,
    milesSinceFuelReading: reading.milesSinceReading,
    rangeEvidence: s.burn.usable ? { legs: s.burn.n, miles: s.burn.miles, milesPerPointP10: s.burn.p10, milesPerPointP90: s.burn.p90 } : null,
    updatedAt, ...(s.flag ? { driverFuel: fuel.planDriverFuel(common) } : {}),
  }
  const plan = {
    ok: true, unit: '901', leg: s.leg, approachMiles: approach, laneMiles: s.routeMiles - approach, loadStatus: 'Assigned',
    fuelPct: pct, fuelSource: reading.fuelSource, fuelAnchorPct: reading.anchorPct, fuelReadingAgeMinutes: reading.ageMinutes,
    milesSinceFuelReading: reading.milesSinceReading, mpg: s.mpg, mpgSource: 'receipts',
    ...trip, pointEstimateMiles: rangeMiles, fuelStopsRecommended: trip.verdict === 'tight' || trip.verdict === 'insufficient',
    updatedAt, ...(s.flag ? { driverFuel: planBlock } : {}),
  }
  return { range, plan, status: s.leg === 'to_pickup' ? 'Assigned' : 'In Transit' }
}
const STOPS = {
  stops: [
    { placeId: 'qa-stop-1', name: 'QA Truck Plaza Riverton', brand: 'QA Fuel', address: '100 Example Rd, Riverton', lat: 35.05, lng: -89.98,
      aboutMilesFromRoute: 0.4, truckFriendly: true, priceSource: 'station', effectivePrice: 3.899, dieselType: 'TRUCK_DIESEL', leg: 'to_pickup' },
    { placeId: 'qa-stop-2', name: 'QA Travel Center Lakeside', address: '200 Sample Ave, Lakeside', lat: 32.78, lng: -96.8, aboutMilesFromRoute: 1.2, truckFriendly: true },
  ],
  livePriceCount: 1,
}
// Two made-up alternatives with Google's gallons on them, for Route Options.
const ROUTES = {
  routes: [
    { route: [[35.05, -89.98], [33.9, -93.4], [32.78, -96.8]], distanceMiles: 420, etaMinutes: 400, fuelLiters: 190, tollPriceUsd: 12.5, trafficSegments: [], steps: [] },
    { route: [[35.05, -89.98], [34.2, -92.9], [32.78, -96.8]], distanceMiles: 431, etaMinutes: 430, fuelLiters: 196, tollPriceUsd: 0, trafficSegments: [], steps: [] },
  ],
  recommendedIdx: 0,
}

function qaLoad(row, id, status, name, extra = {}) {
  return {
    _rowIndex: row, 'Load ID': id, 'Job Status': status, Driver: name,
    'Pickup Address': '100 Example Rd, Riverton, TN 38118', 'Drop-off Address': '200 Sample Ave, Lakeside, TX 75201',
    'Pickup Appointment': '2026-10-30 08:00', 'Drop-off Appointment': '2026-10-31 14:00', _accepted: true, _expenseWindow: { state: 'active' }, ...extra,
  }
}

// A published card long enough to push the Fuel title off a phone's screen if it lands late.
const QA_INSTRUCTIONS = {
  state: 'published',
  highlights: ['high_value', 'ppe'],
  payload: {
    v: 1,
    loadRequirements: [
      { category: 'equipment', text: 'QA: dry van only, 53 ft, clean and dry floor.' },
      { category: 'high_value', text: 'QA: high value load, never leave the trailer unattended.' },
      { category: 'same_driver', text: 'QA: the same driver from pickup to delivery.' },
    ],
    stops: [
      {
        kind: 'pickup', facility: 'QA Test Shipper', place: 'Riverton, TN',
        references: [{ type: 'pickup_number', label: 'Pickup #', value: 'QA-PU-1001' }, { type: 'appointment_number', label: 'Appointment #', value: 'QA-APPT-2201' }],
        requirements: [{ category: 'ppe', text: 'QA: hard hat and safety vest at the dock.' }, { category: 'seal', text: 'QA: seal the trailer before you leave the yard.' }],
        instructions: [{ kind: 'shipper', text: 'QA: check in at the guard shack with your CDL.' }],
      },
      {
        kind: 'delivery', facility: 'QA Test Receiver', place: 'Lakeside, TX',
        references: [{ type: 'delivery_number', label: 'Delivery #', value: 'QA-DL-2002' }],
        requirements: [{ category: 'work_required', text: 'QA: the driver may need to count the freight.' }],
        instructions: [{ kind: 'receiver', text: 'QA: use the south gate after noon.' }, { kind: 'hours', text: 'QA: receiving 0700-1500 on weekdays.' }],
      },
    ],
    footnote: '',
  },
}

// A scene's `loads` is [row, id, status, extra] rows; with none, the one load the fuel steps use.
function driverPayload(status, name = DRIVER_NAME, scene = {}) {
  const loads = scene.loads ? scene.loads.map(([row, id, st, extra]) => qaLoad(row, id, st, name, extra)) : [qaLoad(2, LOAD_ID, status, name)]
  return {
    loads, driverInfo: null, truck: { unit_number: '901', make: 'QA', model: 'Example', status: 'Active' }, messages: [], notifications: [],
    expenses: [], drivers: [], headers: { jobTracking: HEADERS, carrierDB: [] }, onboarding: scene.onboarding || null, application: null, invoices: [],
    sharedDocuments: [], truckDocuments: [], profilePictureUrl: '', driverDirectoryId: 0,
  }
}

// One scene's answers: { status, body } per path.
function answersFor(scene) {
  const w = world(scene.world || {})
  const plan = scene.planError ? { status: 400, body: { ok: false, error: 'load has no geocoded destination', code: scene.planError } } : { status: 200, body: w.plan }
  return {
    status: w.status,
    '/api/fuel/range': { status: 200, body: scene.rangeRefused ? { ok: false } : w.range },
    '/api/fuel/trip-plan': plan,
    '/api/poi/fuel-stops': { status: 200, body: STOPS },
  }
}

function answerGet(pathname, scene, answers) {
  if (answers[pathname]) return answers[pathname]
  const ok = (body) => ({ status: 200, body })
  const name = scene.driverName || DRIVER_NAME
  if (pathname === '/api/auth/session') return ok({ authenticated: true, user: { ...DRIVER, driverName: name, fullName: name }, appTimeZone: 'America/New_York' })
  if (pathname === `/api/driver/${encodeURIComponent(name)}`) {
    // 400, not a 5xx: DFx allows the browser's line for a 400 only, and any failure here is the same lock screen.
    return scene.driverLoadFails ? { status: 400, body: { error: 'made-up failure' } } : ok(driverPayload(answers.status, name, scene))
  }
  if (pathname === '/api/config/maps-key') return ok({ key: 'qa-fuel-no-key' })
  if (pathname === '/api/locations/latest') return ok({ locations: [] })
  if (pathname === '/api/driver/position') return ok({ ok: false, reason: 'no_position' })
  if (pathname === '/api/route') return ok(scene.routes ? ROUTES : { routes: [], recommendedIdx: 0, fallback: true })
  if (/^\/api\/driver\/loads\/[^/]+\/instructions$/.test(pathname)) return ok(QA_INSTRUCTIONS)
  if (pathname.startsWith('/api/documents/')) return ok({ documents: [] })
  if (pathname.startsWith('/api/geocode/load/')) return ok({ originLat: 35.05, originLng: -89.98, destLat: 32.78, destLng: -96.8 })
  return ok({})
}

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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the driver fuel check"}')
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
const pageErrors = []
const consoleLines = []
const writes = []
let exitCode = 0
const harnessLine = (l) => /socket\.io/.test(l.text) || /socket\.io/.test(l.url) || (!!l.url && !l.url.startsWith(BASE))
function record(step, title, expected, observed, ok, shot = '') {
  if (!ok) exitCode = 1
  rows.push({ step, title, expected, observed, verdict: ok ? 'PASS' : 'FAIL', shot })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${observed}`)
}
const flags = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')
const allTrue = (o) => Object.values(o).every(Boolean)

// A stand-in for the server's socket.io over one WebSocket: the open packet, then the answer to
// the client's connect. drop() closes it as a lost signal would, and the client's next try waits,
// unanswered, until comeBack(), so Offline stays up for as long as a step wants to read it.
async function fakeSocket(ctx) {
  let waiting = null
  let down = false
  let current = null
  let markConnected
  const connected = new Promise((resolve) => { markConnected = resolve })
  const open = (ws) => ws.send('0{"sid":"qa-engine","upgrades":[],"pingInterval":600000,"pingTimeout":600000,"maxPayload":1000000}')
  await ctx.routeWebSocket(/\/socket\.io\//, (ws) => {
    current = ws
    ws.onMessage((message) => {
      if (!String(message).startsWith('40')) return
      ws.send('40{"sid":"qa-socket"}')
      markConnected()
    })
    if (down) waiting = ws
    else open(ws)
  })
  return {
    connected,
    drop: async () => { down = true; await current.close() },
    comeBack: () => {
      down = false
      if (waiting) open(waiting)
      waiting = null
    },
  }
}

async function openScene(browser, scene, viewport, { openLoad = true, socket = false } = {}) {
  const answers = answersFor(scene)
  const phone = isPhone(viewport)
  const asked = {}
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  // Lets a step move the page's clock on, so "hours later" doesn't take hours.
  if (scene.clockMoves) await ctx.addInitScript(() => { const real = Date.now; Date.now = () => real() + (window.qaClockAheadMs || 0) })
  const sock = socket ? await fakeSocket(ctx) : null
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
    if (req.method() !== 'GET') {
      writes.push(`${req.method()} ${url.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    asked[url.pathname] = (asked[url.pathname] || 0) + 1
    const a = answerGet(url.pathname, scene, answers)
    if (scene.rangeDelayMs && url.pathname === '/api/fuel/range') await new Promise((r) => setTimeout(r, scene.rangeDelayMs))
    if (scene.lateMs && (url.pathname === '/api/route' || /\/instructions$/.test(url.pathname))) await new Promise((r) => setTimeout(r, scene.lateMs))
    return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 200)))
  page.on('console', (m) => consoleLines.push({ type: m.type(), text: m.text(), url: String((m.location() && m.location().url) || '') }))
  await page.goto(`${BASE}/driver`)
  if (openLoad) {
    await page.locator('.load-card').filter({ hasText: LOAD_ID }).first().click({ timeout: 30000 })
    await page.locator('.load-detail').waitFor({ state: 'visible', timeout: 15000 })
  }
  return { ctx, page, sock, answers, asked }
}

// The collapsed badge first (the prefetch), then the section opened and settled.
async function openFuel(page) {
  await page.waitForTimeout(800)
  const badge = (await page.locator('.fuel-badge').count()) ? (await page.locator('.fuel-badge').first().innerText()).trim() : ''
  await page.locator('.fuel-title').first().click()
  await page.locator('.driver-fuel .dfp-refresh').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForFunction(() => {
    const b = document.querySelector('.driver-fuel .dfp-refresh')
    return !!b && !b.disabled
  }, null, { timeout: 15000 })
  return badge
}

async function measure(page) {
  return page.evaluate(() => {
    const px = (el) => parseFloat(getComputedStyle(el).fontSize) || 0
    const rowText = [...document.querySelectorAll('.dff-row-label, .dff-row-miles, .dff-row-line')].map(px)
    const refresh = document.querySelector('.driver-fuel .dfp-refresh')
    const block = document.querySelector('[data-testid="driver-fuel"]')
    return {
      sideways: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
      rowMinPx: rowText.length ? Math.min(...rowText) : null,
      refreshPx: refresh ? Math.round(refresh.getBoundingClientRect().height) : 0,
      blockWidth: block ? Math.round(block.getBoundingClientRect().width) : 0,
      chip: (document.querySelector('.fuel-chip') || {}).textContent || '',
    }
  })
}

async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`)
  try {
    const section = page.locator('.van-collapse-item').filter({ has: page.locator('.fuel-title') }).first()
    await section.scrollIntoViewIfNeeded()
    await page.screenshot({ path: file, fullPage: true })
  } catch (e) { console.log(`  (screenshot ${name} failed: ${e.message})`) }
  return file
}

const blockText = async (page) => ((await page.locator('[data-testid="driver-fuel"]').count())
  ? (await page.locator('[data-testid="driver-fuel"]').innerText()).replace(/\s+/g, ' ').trim() : '')
const WORKING_RE = /minus|reserve|mpg|miles per gallon|%|until the tank is empty|how we know/i

// ---------------------------------------------------------------- the steps
const SCENES = [
  { step: 'DF1', title: 'Before pickup', world: {}, expect: ['225', 'miles until you run out', 'To reach pickup', '140 mi', 'Uses about 30 gal. You have enough.', 'To finish this load', '420 mi', 'Add about 65 gal.'], absent: ['Uses about 80 gal'], badge: 'Add 65 gal' },
  { step: 'DF2', title: 'In transit, enough', world: { leg: 'to_delivery', routeMiles: 180 }, expect: ['225', 'Uses about 35 gal. You have enough.'] },
  { step: 'DF3', title: 'Refuel now', world: { pct: 3, leg: 'to_delivery', routeMiles: 180 }, expect: ['Refuel now', 'Stop for fuel as soon as you can.', 'Add about 60 gal.'], absent: ['Uses about 35 gal'] },
  { step: 'DF4', title: 'No ELD fuel reading', world: { hasDevice: false, fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, expect: ['Fuel level unknown', "Your truck isn't sending a fuel level. Check your gauge.", 'Whole load, pickup to delivery Check your gauge.', "The truck's location isn't known, so the run to the pickup can't be counted."], absent: ['gal', '280 mi'] },
  { step: 'DF5', title: 'ELD silent 18 hrs', world: { fuelSource: 'stale', readAge: 18 * 60, leg: 'to_delivery' }, expect: ['Fuel level unknown', 'No fuel reading for 18 hrs. Check your gauge.', 'To finish this load Check your gauge.'], absent: ['gal', '420 mi'], badge: 'Fuel unknown' },
  { step: 'DF6', title: 'No tank size, and the header chip', world: { burn: NO_BURN, tankSource: 'default', tank: 200 }, expect: ['Miles left unknown', "This truck's tank size isn't on file. Check your gauge and ask dispatch to add it."], chip: 'Fuel range: not available' },
  { step: 'DF7', title: 'Load not mapped', world: {}, planError: 'NO_ROUTE', expect: ['225', "This load isn't on the map yet, so we can't work out the fuel for it."] },
  { step: 'DF8a', title: 'Position 3 hrs old', world: { positionAgeMinutes: 180, leg: 'to_delivery' }, expect: ['Worked out from where your truck was 3 hrs ago.'] },
  { step: 'DF8b', title: 'No position before pickup', world: { fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, expect: ['Whole load, pickup to delivery Check your gauge.', "The truck's location isn't known, so the run to the pickup can't be counted."], absent: ['gal', '280 mi', 'You have enough'] },
  { step: 'DF9', title: 'Extra stops', world: { extraStops: true }, expect: ['To reach first pickup Check your gauge.', 'To finish this load Check your gauge.', "This load has extra stops that aren't counted. You may need more fuel."], absent: ['You have enough', 'gal', '140 mi', '420 mi'], badge: 'Check gauge' },
  { step: 'DF10', title: 'Longer than a full tank', world: { leg: 'to_delivery', routeMiles: 1040 }, expect: ['1,040 mi', 'Uses about 195 gal. Fill up full, and plan another fuel stop on the way.'] },
  // One source: rows the block can't count have no number, and the stops lead is the block's miles left.
  { step: 'DF13', title: 'Pickup not on the map', world: { pickupUnmapped: true, leg: 'to_delivery', routeMiles: 300, pct: 70 }, expect: ['335', 'To finish this load Check your gauge.', "The pickup isn't on the map, so the run to it isn't counted."], absent: ['gal', '300 mi'], badge: 'Check gauge', panelExpect: ['Where to fuel up', 'Fuel up within 335 mi.'] },
  { step: 'DF14', title: 'Sensor dropout, 300 mi since', world: { fuelSource: 'carried', pct: 66.7, anchor: 100, milesSince: 300, leg: 'to_delivery', routeMiles: 450 }, expect: ['185', "Your fuel sensor isn't reporting. This is an estimate.", 'To finish this load Check your gauge.'], absent: ['gal', '450 mi'], badge: 'Check gauge', panelExpect: ['Fuel up within 185 mi.'], panelAbsent: ['319'] },
]

async function phoneScene(browser, sc) {
  const { ctx, page } = await openScene(browser, sc, PHONE)
  try {
    const badge = await openFuel(page)
    const text = await blockText(page)
    const panel = (await page.locator('.driver-fuel').innerText()).replace(/\s+/g, ' ')
    const m = await measure(page)
    const s = await shot(page, `${sc.step.toLowerCase()}-${sc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-390x844`)
    const checks = {
      sentences: sc.expect.every((e) => text.includes(e)),
      ...(sc.absent ? { absent: sc.absent.every((e) => !text.includes(e)) } : {}),
      ...(sc.panelExpect ? { panelSentences: sc.panelExpect.every((e) => panel.includes(e)) } : {}),
      ...(sc.panelAbsent ? { panelAbsent: sc.panelAbsent.every((e) => !panel.includes(e)) } : {}),
      noWorking: !WORKING_RE.test(panel),
      stopsAndRefresh: panel.includes('QA Truck Plaza Riverton') && /Refresh fuel, stops and check/.test(panel),
      ...(sc.badge ? { badge: badge === sc.badge } : {}),
      ...(sc.chip ? { chip: m.chip.includes(sc.chip) } : {}),
      noSideways: m.sideways <= 0,
      rowText14: m.rowMinPx === null || m.rowMinPx >= 14,
      refresh44: m.refreshPx >= 44,
    }
    record(sc.step, `${sc.title} at 390 x 844`, `${sc.expect.join(' / ')}${sc.badge ? `; badge "${sc.badge}"` : ''}${sc.chip ? `; chip "${sc.chip}"` : ''}; no working; no sideways scroll; rows >= 14 px; Refresh >= 44 px`,
      `${flags(checks)}; block "${text}"; badge "${badge}"; rows ${m.rowMinPx}px; Refresh ${m.refreshPx}px`, allTrue(checks), s)
  } finally {
    await ctx.close()
  }
}

async function routeOptions(browser) {
  for (const [step, flag] of [['DF11', true], ['DF12', false]]) {
    const sc = { step, world: { flag }, routes: true }
    const { ctx, page } = await openScene(browser, sc, PHONE)
    try {
      const badge = await openFuel(page)
      const panel = (await page.locator('.driver-fuel').innerText()).replace(/\s+/g, ' ')
      const options = page.locator('.van-collapse-item').filter({ hasText: 'Route Options' }).first()
      const hasOptions = (await options.count()) > 0
      if (hasOptions) await options.locator('.van-collapse-item__title, .van-cell').first().click()
      await page.waitForTimeout(400)
      const altText = hasOptions ? (await page.locator('.route-alts').first().innerText().catch(() => '')).replace(/\s+/g, ' ') : ''
      const m = await measure(page)
      const s = await shot(page, `${step.toLowerCase()}-${flag ? 'route-options-no-gallons' : 'flag-off'}-390x844`)
      const checks = flag
        ? { routeOptions: hasOptions, noGallons: !altText.includes('⛽') && !/\bgal\b/.test(altText), tollStays: altText.includes('$12.50') }
        : {
            todayPanel: panel.includes('How we know') && !panel.includes('kept back as a reserve') && !panel.includes('until the tank is empty'),
            // Today's rows, unchanged: the verdict card, the hero and the stops lead on the verdict's figure.
            todayRows: panel.includes('Not enough fuel — you need to stop') && panel.includes('225 miles before you need to refuel')
              && panel.includes('Fuel up within 225 mi.') && !panel.includes('miles until you run out') && !panel.includes('Check gauge'),
            noBlock: (await page.locator('[data-testid="driver-fuel"]').count()) === 0,
            todayBadge: badge === 'Fuel stop needed',
            routeOptionsGallons: hasOptions && altText.includes('⛽'),
            noSideways: m.sideways <= 0,
          }
      record(step, flag ? 'Route Options with the flag on' : 'The flag off: today\'s panel', flag
        ? 'Route Options show, without Google\'s gallons; the toll stays'
        : 'the panel as today ("How we know"), with no sum under the hero, no block, the badge "Fuel stop needed", Route Options with their gallons',
      `${flags(checks)}; options "${altText.slice(0, 120)}"`, allTrue(checks), s)
    } finally {
      await ctx.close()
    }
  }
}

async function desktop(browser) {
  for (const [step, sc] of [['DF1d', { world: {} }], ['DF6d', { world: { burn: NO_BURN, tankSource: 'default', tank: 200 } }], ['DF12d', { world: { flag: false } }]]) {
    const { ctx, page } = await openScene(browser, sc, DESKTOP)
    try {
      await openFuel(page)
      const m = await measure(page)
      const s = await shot(page, `${step.toLowerCase()}-1280x800`)
      const flagOn = sc.world.flag !== false
      const checks = flagOn ? { block: m.blockWidth > 0, oneColumnCapped: m.blockWidth <= 520, noSideways: m.sideways <= 0 } : { noBlock: m.blockWidth === 0, noSideways: m.sideways <= 0 }
      record(step, `At 1280 x 800${flagOn ? '' : ' (flag off)'}`, flagOn ? 'the block one column, at most 520 px wide; no sideways scroll' : 'today\'s panel; no sideways scroll',
        `${flags(checks)}; block ${m.blockWidth}px`, allTrue(checks), s)
    } finally {
      await ctx.close()
    }
  }
}

// ---------------------------------------------------------------- the header chip
const CHIP_MILES = 'Fuel range: 225 miles left until empty'
const CHIP_NONE = 'Fuel range: not available'
const NO_TANK = { burn: NO_BURN, tankSource: 'default', tank: 200 }
const CHIP_PHONE = [
  { step: 'DFC1', title: 'Miles, flag on', world: {}, chip: CHIP_MILES },
  { step: 'DFC2', title: 'Miles, flag off: the same figure', world: { flag: false }, chip: CHIP_MILES },
  { step: 'DFC3', title: 'No tank size, flag on', world: NO_TANK, chip: CHIP_NONE },
  { step: 'DFC4', title: 'No ELD, flag off', world: { flag: false, hasDevice: false, fromLivePosition: false }, chip: CHIP_NONE },
  { step: 'DFC5', title: 'Refuel now stays the instruction', world: { pct: 3 }, chip: 'Refuel now' },
  { step: 'DFC6', title: 'A very long name', world: {}, chip: CHIP_MILES, driverName: LONG_NAME },
  { step: 'DFC8', title: 'A failed read', world: {}, rangeRefused: true, chip: '' },
]
const CHIP_DESKTOP = [
  { step: 'DFC1d', title: 'Miles', world: {}, chip: CHIP_MILES },
  { step: 'DFC3d', title: 'No tank size', world: NO_TANK, chip: CHIP_NONE },
]

function measureHeader(page) {
  return page.evaluate(() => {
    const header = document.querySelector('.app-header')
    const chip = document.querySelector('.fuel-chip')
    const buttons = [...document.querySelectorAll('.app-header .header-btn')]
    const content = document.querySelector('.app-content')
    const h = header.getBoundingClientRect()
    const c = chip ? chip.getBoundingClientRect() : null
    const onScreen = (r) => r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= h.bottom + 0.5
    const takesTap = (el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)
      return !!hit && (hit === el || el.contains(hit))
    }
    const buttonRow = buttons.length ? buttons[0].getBoundingClientRect() : null
    const offline = document.querySelector('.app-header-left .status-chip.warn')
    const o = offline ? offline.getBoundingClientRect() : null
    // The text's own box: the button's taller tap target is overflow to scrollWidth and scrollHeight.
    const textInChip = () => {
      const range = document.createRange()
      range.selectNodeContents(chip)
      const t = range.getBoundingClientRect()
      return t.left >= c.left - 1 && t.right <= c.right + 1 && t.top >= c.top - 1 && t.bottom <= c.bottom + 1
    }
    return {
      offlineOnScreen: !!o && onScreen(o),
      offlineClearOfButtons: !!o && !!buttonRow && o.right <= buttonRow.left,
      text: chip ? chip.textContent.replace(/\s+/g, ' ').trim() : '',
      name: (document.querySelector('.driver-name-label') || {}).textContent || '',
      headerPx: Math.round(h.height),
      chipPx: c ? [Math.round(c.width), Math.round(c.height)] : null,
      sideways: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
      chipOnScreen: !!c && onScreen(c),
      chipWhole: !!chip && textInChip(),
      chipTakesPoint: !!chip && takesTap(chip),
      chipBelowButtons: !!c && !!buttonRow && c.top >= buttonRow.bottom - 0.5,
      chipBesideButtons: !!c && !!buttonRow && (c.top + c.bottom) / 2 >= buttonRow.top && (c.top + c.bottom) / 2 <= buttonRow.bottom,
      buttonsOnScreen: buttons.length === 2 && buttons.every((b) => onScreen(b.getBoundingClientRect())),
      buttonsTakeTap: buttons.length === 2 && buttons.every(takesTap),
      pageBelowHeader: !!content && content.getBoundingClientRect().top >= h.bottom - 1,
      reported: getComputedStyle(document.documentElement).getPropertyValue('--driver-header-height').trim(),
      offsetPx: header.offsetHeight,
    }
  })
}

async function chipScene(browser, sc, viewport) {
  const phone = isPhone(viewport)
  const size = `${viewport.width} x ${viewport.height}`
  const { ctx, page } = await openScene(browser, sc, viewport, { openLoad: false })
  try {
    await page.locator('.load-card').first().waitFor({ state: 'visible', timeout: 30000 })
    if (sc.chip) await page.locator('.fuel-chip').waitFor({ state: 'visible', timeout: 15000 })
    else await page.waitForTimeout(1000)
    const m = await measureHeader(page)
    const file = path.join(SHOTS, `${sc.step.toLowerCase()}-${viewport.width}x${viewport.height}.png`)
    await page.screenshot({ path: file }).catch((e) => console.log(`  (screenshot ${sc.step} failed: ${e.message})`))
    const checks = {
      sentence: sc.chip ? m.text === `⛽ ${sc.chip}` : m.text === '',
      ...(sc.chip ? {
        chipOnScreen: m.chipOnScreen, chipWhole: m.chipWhole, chipTakesPoint: m.chipTakesPoint,
        ...(phone ? { ownRow: m.chipBelowButtons } : { sameRow: m.chipBesideButtons }),
      } : {}),
      ...(sc.driverName ? { name: m.name === sc.driverName } : {}),
      buttonsOnScreen: m.buttonsOnScreen,
      buttonsTakeTap: m.buttonsTakeTap,
      pageBelowHeader: m.pageBelowHeader,
      heightReported: m.reported === `${m.offsetPx}px`,
      noSideways: m.sideways <= 0,
    }
    record(sc.step, `Header chip: ${sc.title} at ${size}`,
      `${sc.chip ? `"${sc.chip}"` : 'no chip'}; whole and on screen; ${phone ? 'its own row' : 'the buttons\' row'}; Password and Logout take a tap; the page starts below the header; no sideways scroll`,
      `${flags(checks)}; "${m.text}"; header ${m.headerPx}px; chip ${m.chipPx ? m.chipPx.join(' x ') : 'none'}`, allTrue(checks), file)
  } finally {
    await ctx.close()
  }
}

// The answer is held back long enough to read the header without it, then with it.
async function chipRowHeld(browser, step, viewport, driverName) {
  const { ctx, page } = await openScene(browser, { world: {}, rangeDelayMs: 4000, driverName }, viewport, { openLoad: false })
  try {
    await page.locator('.app-header').waitFor({ state: 'visible', timeout: 15000 })
    const read = () => page.evaluate(() => ({
      chip: !!document.querySelector('.fuel-chip'),
      header: document.querySelector('.app-header').getBoundingClientRect().height,
      top: document.querySelector('.app-content').getBoundingClientRect().top,
    }))
    const before = await read()
    await page.locator('.fuel-chip').waitFor({ state: 'visible', timeout: 15000 })
    const after = await read()
    const checks = {
      noChipYet: !before.chip,
      headerStill: Math.abs(before.header - after.header) < 1,
      pageStill: Math.abs(before.top - after.top) < 1,
    }
    record(step, `Header chip: the first answer arrives at ${viewport.width} x ${viewport.height}${driverName ? ', long name' : ''}`, 'the header and the page stay where they were',
      `${flags(checks)}; header ${before.header} to ${after.header}; page top ${before.top} to ${after.top}`, allTrue(checks))
  } finally {
    await ctx.close()
  }
}

async function chipSteps(browser) {
  for (const sc of CHIP_PHONE) {
    try { await chipScene(browser, sc, PHONE) } catch (e) { record(sc.step, `${sc.title}: aborted`, '', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
  }
  for (const [step, viewport, name] of [['DFC7', PHONE, undefined], ['DFC7n', NARROW, LONG_NAME], ['DFC7s', SMALL, LONG_NAME]]) {
    try { await chipRowHeld(browser, step, viewport, name) } catch (e) { record(step, 'The first answer arrives: aborted', '', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
  }
  for (const sc of CHIP_DESKTOP) {
    try { await chipScene(browser, sc, DESKTOP) } catch (e) { record(sc.step, `${sc.title}: aborted`, '', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
  }
}

// ---------------------------------------------------------------- the chip's tap
const LINE_MILES = 'About 225 miles before you run out.'
const OTHER_LOAD = 'QA-FUEL-9'
const ON_THE_ROAD = [2, LOAD_ID, 'In Transit']

function tapChip(page, viewport) {
  const chip = page.locator('.fuel-chip')
  return isPhone(viewport) ? chip.tap() : chip.click()
}

// Where the tap landed, as the driver sees it: the viewport, not the whole page.
function readLanding(page) {
  return page.evaluate(() => {
    const header = document.querySelector('.app-header').getBoundingClientRect()
    const tabs = document.querySelector('.van-tabbar')
    const floor = tabs ? tabs.getBoundingClientRect().top : window.innerHeight
    const title = document.querySelector('.fuel-title')
    const t = title ? title.getBoundingClientRect() : null
    const topbar = document.querySelector('.detail-topbar .topbar-title')
    const refresh = document.querySelector('.driver-fuel .dfp-refresh')
    const panel = document.querySelector('.driver-fuel')
    const toast = document.querySelector('.toast.show')
    const hit = t ? document.elementFromPoint(t.left + 2, (t.top + t.bottom) / 2) : null
    const badge = document.querySelector('.fuel-badge')
    return {
      badge: badge ? badge.textContent.trim() : '',
      titleTop: t ? t.top : null,
      loadId: topbar ? topbar.textContent.trim() : '',
      titleInView: !!t && t.top >= header.bottom - 1 && t.bottom <= floor,
      titleNotCovered: !!t && !!hit && (hit === title || title.contains(hit) || hit.contains(title)),
      fuelOpen: !!refresh && refresh.getClientRects().length > 0,
      panel: panel && panel.getClientRects().length > 0 ? panel.innerText.replace(/\s+/g, ' ') : '',
      toast: toast ? toast.textContent.trim() : '',
      sideways: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
    }
  })
}

// The section open and its numbers in, then the collapse's animation over.
async function waitForFuelOpen(page) {
  await page.locator('.driver-fuel .dfp-refresh').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForFunction(() => {
    const b = document.querySelector('.driver-fuel .dfp-refresh')
    return !!b && !b.disabled
  }, null, { timeout: 15000 })
  await page.waitForTimeout(500)
}

async function chipUp(page) {
  await page.locator('.fuel-chip').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(300)
}

async function landingScene(browser, sc, viewport = PHONE) {
  const size = `${viewport.width} x ${viewport.height}`
  const { ctx, page } = await openScene(browser, sc, viewport, { openLoad: false })
  try {
    await page.locator('.load-card').first().waitFor({ state: 'visible', timeout: 30000 })
    await chipUp(page)
    if (sc.before) await sc.before(page)
    await tapChip(page, viewport)
    await waitForFuelOpen(page)
    const m = await readLanding(page)
    const file = path.join(SHOTS, `${sc.step.toLowerCase()}-${viewport.width}x${viewport.height}.png`)
    await page.screenshot({ path: file }).catch((e) => console.log(`  (screenshot ${sc.step} failed: ${e.message})`))
    const checks = {
      rightLoad: m.loadId === (sc.opens || LOAD_ID),
      fuelOpen: m.fuelOpen,
      titleInView: m.titleInView,
      titleNotCovered: m.titleNotCovered,
      noToast: m.toast === '',
      noSideways: m.sideways <= 0,
      ...(sc.panelHas ? { panelHas: sc.panelHas.every((e) => m.panel.includes(e)) } : {}),
      ...(sc.panelLacks ? { panelLacks: sc.panelLacks.every((e) => !m.panel.includes(e)) } : {}),
      ...(sc.badge ? { badge: m.badge === sc.badge } : {}),
    }
    // "How we know", one tap away: the screenshot above is the first screen, with it shut.
    if (sc.howHas) {
      await page.locator('.dfp-how').click()
      await page.waitForTimeout(150)
      const how = (await page.locator('.dfp-how-body').innerText()).replace(/\s+/g, ' ')
      checks.howHas = sc.howHas.every((e) => how.includes(e))
      checks.howLacks = sc.howLacks.every((e) => !how.includes(e))
    }
    record(sc.step, `Tap the chip: ${sc.title} at ${size}`,
      `${sc.opens || LOAD_ID}'s page, its Fuel section open and in view below the header; no toast; no sideways scroll${sc.panelLacks ? `; on the first screen, none of: ${sc.panelLacks.join(', ')}` : ''}`,
      `${flags(checks)}; load "${m.loadId}"${sc.badge ? `; badge "${m.badge}"` : ''}; panel "${m.panel.slice(0, 160)}"`, allTrue(checks), file)
  } finally {
    await ctx.close()
  }
}

async function toastScene(browser, sc, viewport = PHONE) {
  const size = `${viewport.width} x ${viewport.height}`
  const { ctx, page } = await openScene(browser, sc, viewport, { openLoad: false })
  try {
    await chipUp(page)
    if (sc.before) await sc.before(page)
    await tapChip(page, viewport)
    await page.locator('.toast.show').waitFor({ state: 'visible', timeout: 5000 })
    const m = await readLanding(page)
    const onScreen = await page.evaluate(() => {
      const r = document.querySelector('.toast.show').getBoundingClientRect()
      const tabs = document.querySelector('.van-tabbar')
      return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= (tabs ? tabs.getBoundingClientRect().top : window.innerHeight)
    })
    const file = path.join(SHOTS, `${sc.step.toLowerCase()}-${viewport.width}x${viewport.height}.png`)
    await page.screenshot({ path: file }).catch((e) => console.log(`  (screenshot ${sc.step} failed: ${e.message})`))
    const checks = {
      line: m.toast === sc.line,
      noWorking: !/minus|reserve|low end|floor/i.test(m.toast),
      onScreen,
      stays: m.loadId === (sc.staysOn || '') && !m.fuelOpen,
      noSideways: m.sideways <= 0,
    }
    if (sc.heldLong) {
      await page.waitForTimeout(3600)
      checks.stillUpAfter3s = (await page.locator('.toast.show').count()) === 1
    }
    record(sc.step, `Tap the chip, no load: ${sc.title} at ${size}`, `a toast "${sc.line}"; the screen stays where it is`, `${flags(checks)}; toast "${m.toast}"`, allTrue(checks), file)
  } finally {
    await ctx.close()
  }
}

// A load's own page: the tap stays there, and works again after the driver shuts the section.
async function onItsOwnPage(browser) {
  const sc = { world: {}, loads: [ON_THE_ROAD, [9, OTHER_LOAD, 'Assigned']] }
  const { ctx, page } = await openScene(browser, sc, PHONE, { openLoad: false })
  try {
    await page.locator('.load-card').filter({ hasText: OTHER_LOAD }).first().click({ timeout: 30000 })
    await page.locator('.load-detail').waitFor({ state: 'visible', timeout: 15000 })
    await chipUp(page)
    await tapChip(page, PHONE)
    await waitForFuelOpen(page)
    const first = await readLanding(page)
    await page.locator('.fuel-title').first().click()
    await page.locator('.driver-fuel .dfp-refresh').waitFor({ state: 'hidden', timeout: 5000 })
    await tapChip(page, PHONE)
    await waitForFuelOpen(page)
    const again = await readLanding(page)
    const checks = {
      staysOnItsPage: first.loadId === OTHER_LOAD && again.loadId === OTHER_LOAD,
      opened: first.fuelOpen && first.titleInView,
      opensAgain: again.fuelOpen && again.titleInView,
    }
    record('DFT6', 'Tap the chip on a load\'s own page at 390 x 844', 'that load\'s Fuel section opens, not the load on the road; shut, a second tap opens it again',
      `${flags(checks)}; first "${first.loadId}", again "${again.loadId}"`, allTrue(checks))
  } finally {
    await ctx.close()
  }
}

// A tap at the chip's place belongs to the dialog; a press that reaches the chip anyway does nothing.
async function underADialog(browser) {
  const { ctx, page } = await openScene(browser, { world: {} }, PHONE, { openLoad: false })
  try {
    await page.locator('.load-card').first().waitFor({ state: 'visible', timeout: 30000 })
    await chipUp(page)
    const passwordBtn = page.locator('.app-header .header-btn').first()
    const centre = await page.locator('.fuel-chip').evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }
    })

    await passwordBtn.tap()
    await page.locator('.pw-overlay').waitFor({ state: 'visible', timeout: 5000 })
    await page.touchscreen.tap(centre.x, centre.y)
    await page.waitForTimeout(400)
    const afterTap = await readLanding(page)

    if (!(await page.locator('.pw-overlay').count())) {
      await passwordBtn.tap()
      await page.locator('.pw-overlay').waitFor({ state: 'visible', timeout: 5000 })
    }
    await page.evaluate(() => document.querySelector('.fuel-chip').click())
    await page.waitForTimeout(400)
    const afterPress = await readLanding(page)
    const dialogStays = (await page.locator('.pw-overlay').count()) === 1

    await page.locator('.pw-close').tap()
    await page.locator('.pw-overlay').waitFor({ state: 'hidden', timeout: 5000 })
    await tapChip(page, PHONE)
    await waitForFuelOpen(page)
    const closed = await readLanding(page)

    const checks = {
      tapStaysTheDialogs: afterTap.loadId === '' && afterTap.toast === '',
      pressDoesNothing: afterPress.loadId === '' && afterPress.toast === '',
      dialogStays,
      worksOnceClosed: closed.loadId === LOAD_ID && closed.fuelOpen,
    }
    record('DFT11', 'A dialog over the chip at 390 x 844', 'no load opens and no toast while the dialog is up; once closed, the tap works', flags(checks), allTrue(checks))
  } finally {
    await ctx.close()
  }
}

async function aRealButton(browser) {
  const { ctx, page } = await openScene(browser, { world: {} }, PHONE, { openLoad: false })
  try {
    await page.locator('.load-card').first().waitFor({ state: 'visible', timeout: 30000 })
    await chipUp(page)
    const m = await page.evaluate(() => {
      const chip = document.querySelector('.fuel-chip')
      const r = chip.getBoundingClientRect()
      const x = (r.left + r.right) / 2
      const onChip = (y) => {
        const el = document.elementFromPoint(x, y)
        return !!el && (el === chip || chip.contains(el))
      }
      let top = r.top
      while (top > 0 && onChip(top - 1)) top -= 1
      let bottom = r.bottom
      while (bottom < window.innerHeight && onChip(bottom)) bottom += 1
      // Every point of the button's own rounded shape: a browser hit-tests a rounded corner as
      // rounded, so the corner of its box was never the button's. A miss names what took the point.
      const missesInShape = (b) => {
        const br = b.getBoundingClientRect()
        const radius = parseFloat(getComputedStyle(b).borderTopLeftRadius) || 0
        const inShape = (px, py) => {
          const dx = Math.max(br.left + radius - px, px - (br.right - radius), 0)
          const dy = Math.max(br.top + radius - py, py - (br.bottom - radius), 0)
          return dx * dx + dy * dy <= (radius - 0.5) * (radius - 0.5)
        }
        const rows = []
        for (let py = br.top + 0.5; py < br.bottom; py += 2) rows.push(py)
        rows.push(br.bottom - 0.5)
        const misses = []
        for (const py of rows) {
          for (let px = br.left + 0.5; px < br.right; px += 2) {
            if (!inShape(px, py)) continue
            const el = document.elementFromPoint(px, py)
            if (!el || !(el === b || b.contains(el))) misses.push(`${b.textContent.trim()} at ${Math.round(px)},${Math.round(py)} went to ${el ? el.className || el.tagName : 'nothing'}`)
          }
        }
        return misses
      }
      const walkAt = (px) => {
        const on = (py) => {
          const el = document.elementFromPoint(px, py)
          return !!el && (el === chip || chip.contains(el))
        }
        let up = r.top
        while (up > 0 && on(up - 1)) up -= 1
        let down = r.bottom
        while (down < window.innerHeight && on(down)) down += 1
        return down - up
      }
      return {
        targetAcross: [r.left + 2, x, r.right - 2].map(walkAt),
        buttonMisses: [...document.querySelectorAll('.app-header .header-btn')].flatMap(missesInShape),
        tag: chip.tagName,
        type: chip.getAttribute('type'),
        label: chip.getAttribute('aria-label') || '',
        declaredPx: parseFloat(getComputedStyle(chip, '::after').height),
        targetPx: bottom - top,
        chipPx: r.height,
      }
    })
    let reached = false
    for (let i = 0; i < 6 && !reached; i++) {
      await page.keyboard.press('Tab')
      reached = await page.evaluate(() => document.activeElement === document.querySelector('.fuel-chip'))
    }
    const ring = reached && await page.evaluate(() => {
      const chip = document.querySelector('.fuel-chip')
      return chip.matches(':focus-visible') && getComputedStyle(chip).outlineStyle === 'solid'
    })
    await page.keyboard.press('Enter')
    await waitForFuelOpen(page)
    const landed = await readLanding(page)
    const checks = {
      button: m.tag === 'BUTTON' && m.type === 'button',
      label: m.label === `${CHIP_MILES}. Show details`,
      // Probed a pixel at a time from a fractional edge, so the walk can read up to 1 px short.
      target44: m.declaredPx >= 44 && m.targetAcross.every((px) => px >= 43),
      noTallerChip: m.chipPx < 44,
      buttonsKeepWholeArea: m.buttonMisses.length === 0,
      tabReachesIt: reached,
      focusRing: ring,
      enterOpens: landed.loadId === LOAD_ID && landed.fuelOpen,
    }
    record('DFT12', 'A real button at 390 x 844', 'a labelled button; a 44 px target on a shorter chip, across its width; every point of Password and Logout still theirs; Tab shows a ring; Enter opens the load',
      `${flags(checks)}; target ${m.targetAcross.join(', ')}px on a ${m.chipPx}px chip; label "${m.label}"${m.buttonMisses.length ? `; ${m.buttonMisses.slice(0, 6).join('; ')}` : ''}`, allTrue(checks))
  } finally {
    await ctx.close()
  }
}

async function onALockScreen(browser, step, title, scene, ready) {
  const { ctx, page } = await openScene(browser, scene, PHONE, { openLoad: false })
  try {
    await page.locator(ready).waitFor({ state: 'visible', timeout: 30000 })
    await chipUp(page)
    const before = await page.evaluate(() => {
      const chip = document.querySelector('.fuel-chip')
      const r = chip.getBoundingClientRect()
      const c = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)
      return { tag: chip.tagName, reachable: !!c && (c === chip || chip.contains(c)) }
    })
    await page.locator('.fuel-chip').tap()
    await page.waitForTimeout(400)
    const m = await readLanding(page)
    const file = path.join(SHOTS, `${step.toLowerCase()}-390x844.png`)
    await page.screenshot({ path: file }).catch((e) => console.log(`  (screenshot ${step} failed: ${e.message})`))
    const checks = {
      plainChip: before.tag === 'SPAN',
      reachable: before.reachable,
      noLine: !m.toast.includes('before you run out'),
      staysLocked: (await page.locator(ready).count()) === 1 && m.loadId === '',
    }
    record(step, `The chip on ${title} at 390 x 844`, 'a plain chip, not a button; a tap changes nothing', flags(checks), allTrue(checks), file)
  } finally {
    await ctx.close()
  }
}

const openHistorical = (id) => async (page) => {
  await page.locator('.sub-tab').filter({ hasText: 'Historical' }).first().click({ timeout: 15000 })
  await page.locator('.load-card').filter({ hasText: id }).first().click({ timeout: 15000 })
  await page.locator('.load-detail').waitFor({ state: 'visible', timeout: 15000 })
}

// A repeat tap: the panel's answers change, the clock moves on, and the new figure has to show.
async function repeatTapHoursLater(browser) {
  const WORLD = { flag: false, leg: 'to_delivery', routeMiles: 180 }
  const { ctx, page, answers, asked } = await openScene(browser, { world: WORLD, loads: [ON_THE_ROAD], clockMoves: true }, PHONE, { openLoad: false })
  try {
    await page.locator('.load-card').first().waitFor({ state: 'visible', timeout: 30000 })
    await chipUp(page)
    await tapChip(page, PHONE)
    await waitForFuelOpen(page)
    const first = await readLanding(page)
    Object.assign(answers, answersFor({ world: { ...WORLD, pct: 30 } }))
    await page.evaluate(() => { window.qaClockAheadMs = 4 * 60 * 60 * 1000 })
    await tapChip(page, PHONE)
    await page.waitForFunction(() => {
      const p = document.querySelector('.driver-fuel')
      return !!p && p.innerText.replace(/\s+/g, ' ').includes('135 miles before you need to refuel')
    }, null, { timeout: 15000 })
    const again = await readLanding(page)
    const checks = {
      firstFigure: first.panel.includes('225 miles before you need to refuel'),
      newFigure: again.panel.includes('135 miles before you need to refuel') && !again.panel.includes('225 miles before you need to refuel'),
      stopsAskedOnce: asked['/api/poi/fuel-stops'] === 1,
      stopsStay: again.panel.includes('QA Truck Plaza Riverton'),
      titleInView: again.titleInView,
    }
    record('DFT17', 'A repeat tap 4 hours later, flag off, at 390 x 844', 'the new figure, not the first tap\'s; the stops asked for once only',
      `${flags(checks)}; stops asked ${asked['/api/poi/fuel-stops']} time(s)`, allTrue(checks))
  } finally {
    await ctx.close()
  }
}

// A tap with no signal, then one with signal back: the figures, not the saved failure.
async function tapAfterAFailure(browser) {
  const WORLD = { flag: false, leg: 'to_delivery', routeMiles: 180 }
  const { ctx, page, answers, asked } = await openScene(browser, { world: WORLD, loads: [ON_THE_ROAD] }, PHONE, { openLoad: false })
  try {
    await page.locator('.load-card').first().waitFor({ state: 'visible', timeout: 30000 })
    await chipUp(page)
    const good = { ...answers }
    // After the chip has its answer, so only the panel's own read fails. 400: DFx allows that line.
    answers['/api/fuel/range'] = { status: 400, body: { ok: false, error: 'made-up failure' } }
    await tapChip(page, PHONE)
    await waitForFuelOpen(page)
    const failed = await readLanding(page)
    Object.assign(answers, good)
    await page.locator('.detail-topbar button').first().click()
    await page.locator('.load-card').first().waitFor({ state: 'visible', timeout: 15000 })
    await tapChip(page, PHONE)
    await page.waitForFunction(() => {
      const p = document.querySelector('.driver-fuel')
      return !!p && p.innerText.replace(/\s+/g, ' ').includes('225 miles before you need to refuel')
    }, null, { timeout: 15000 })
    const healed = await readLanding(page)
    const checks = {
      sawTheFailure: failed.panel.includes("Couldn't read your fuel level"),
      figuresBack: healed.panel.includes('225 miles before you need to refuel'),
      failureGone: !healed.panel.includes("Couldn't read your fuel level"),
      stopsAskedOnce: asked['/api/poi/fuel-stops'] === 1,
    }
    record('DFT18', 'A tap that failed, then one with signal back, at 390 x 844', 'the figures, not the saved failure; the stops asked for once only', flags(checks), allTrue(checks))
  } finally {
    await ctx.close()
  }
}

// Route Options and a tall card land after the scroll. Chromium would hold the page's place by
// itself, so that's turned off here, to read as a phone with no scroll anchoring would.
async function answersLandLate(browser, step, touched) {
  const sc = {
    world: { leg: 'to_delivery', routeMiles: 180 },
    loads: [[2, LOAD_ID, 'In Transit', { _instructions: { state: 'published', highlights: ['high_value', 'ppe'] } }]],
    routes: true,
    lateMs: 2500,
  }
  const { ctx, page } = await openScene(browser, sc, PHONE, { openLoad: false })
  try {
    await page.addStyleTag({ content: '* { overflow-anchor: none !important; }' })
    await page.locator('.load-card').first().waitFor({ state: 'visible', timeout: 30000 })
    await chipUp(page)
    await tapChip(page, PHONE)
    await page.locator('.driver-fuel .dfp-refresh').waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(600)
    const before = await readLanding(page)
    const landedAlready = (await page.locator('.load-instructions .li-title').count()) > 0
    if (touched) await page.mouse.wheel(0, 30)
    await page.locator('.load-instructions .li-title').waitFor({ state: 'visible', timeout: 15000 })
    await page.locator('.van-collapse-item').filter({ hasText: 'Route Options' }).first().waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(700)
    const m = await readLanding(page)
    const file = path.join(SHOTS, `${step.toLowerCase()}-390x844.png`)
    await page.screenshot({ path: file }).catch((e) => console.log(`  (screenshot ${step} failed: ${e.message})`))
    const checks = touched
      ? { firstLanding: before.titleInView, cardLandedLate: !landedAlready, notPulledBack: m.titleTop > before.titleTop + 100 }
      : { firstLanding: before.titleInView, cardLandedLate: !landedAlready, titleInView: m.titleInView, titleNotCovered: m.titleNotCovered, heldItsPlace: Math.abs(m.titleTop - before.titleTop) <= 4, fuelOpen: m.fuelOpen }
    record(step, `Late answers${touched ? ', after the driver touched the page,' : ''} with no scroll anchoring at 390 x 844`,
      touched ? 'the page isn\'t pulled back to the title' : 'the title comes back into view, below the header, where it landed',
      `${flags(checks)}; title top ${before.titleTop} to ${m.titleTop}`, allTrue(checks), file)
  } finally {
    await ctx.close()
  }
}

async function tapSteps(browser) {
  const FLAG_OFF = { flag: false }
  const CLEARS = { flag: false, leg: 'to_delivery', routeMiles: 180 }
  const steps = [
    () => landingScene(browser, { step: 'DFT1', title: 'a load on the road', world: { leg: 'to_delivery', routeMiles: 180 }, loads: [ON_THE_ROAD], panelHas: ['225', 'miles until you run out'] }),
    () => landingScene(browser, { step: 'DFT2', title: 'a newer load queued behind it', world: { leg: 'to_delivery', routeMiles: 180 }, loads: [ON_THE_ROAD, [9, OTHER_LOAD, 'Assigned', { _queuePosition: 1 }]], opens: LOAD_ID }),
    () => landingScene(browser, { step: 'DFT3', title: 'only queued loads', world: {}, loads: [[2, LOAD_ID, 'Assigned', { _queuePosition: 1 }], [9, OTHER_LOAD, 'Assigned', { _queuePosition: 2 }]], opens: LOAD_ID }),
    () => landingScene(browser, {
      step: 'DFT4', title: 'the flag off', world: FLAG_OFF, loads: [[2, LOAD_ID, 'Assigned']],
      panelHas: ['225 miles before you need to refuel', '420 mi still to drive', 'How we know'],
      panelLacks: ['until the tank is empty', 'minus', 'kept back', '240', 'count on'],
      howHas: ['On this much fuel, a hard run goes about 240 mi and a typical run about', 'The furthest this truck has ever managed is', 'hard run 240'],
      howLacks: ['Plan on', 'until empty', 'count on'],
    }),
    () => landingScene(browser, {
      step: 'DFT4b', title: 'the flag off, a run that clears', world: CLEARS, loads: [ON_THE_ROAD], badge: '225 mi range',
      panelHas: ['225 miles before you need to refuel', '180 mi still to drive'], panelLacks: ['240', 'count on'],
    }),
    () => landingScene(browser, {
      step: 'DFT4c', title: 'the flag off, refuel now', world: { ...CLEARS, pct: 3 }, loads: [ON_THE_ROAD],
      panelHas: ['Refuel now', '180 mi still to drive'], panelLacks: ['count on', '15 mi'],
    }),
    () => landingScene(browser, {
      step: 'DFT5', title: 'from the Messages tab', world: {}, loads: [[2, LOAD_ID, 'Assigned']],
      before: async (page) => {
        await page.locator('.van-tabbar-item').filter({ hasText: 'Messages' }).first().click()
        await page.locator('.chat-input-bar').waitFor({ state: 'visible', timeout: 15000 })
      },
    }),
    () => onItsOwnPage(browser),
    () => toastScene(browser, { step: 'DFT7', title: 'flag on', world: {}, loads: [], line: LINE_MILES, heldLong: true }),
    () => toastScene(browser, { step: 'DFT8', title: 'flag off, the same words', world: FLAG_OFF, loads: [], line: LINE_MILES }),
    () => toastScene(browser, { step: 'DFT9a', title: '"not available", flag on', world: NO_TANK, loads: [], line: "Miles left unknown. This truck's tank size isn't on file. Check your gauge and ask dispatch to add it." }),
    () => toastScene(browser, { step: 'DFT9b', title: '"not available", flag off', world: { flag: false, hasDevice: false, fromLivePosition: false }, loads: [], line: "No usable fuel reading from this truck's ELD. Check the gauge before you set off." }),
    () => toastScene(browser, { step: 'DFT10', title: 'only an offer not yet accepted', world: {}, loads: [[2, LOAD_ID, 'Dispatched', { _accepted: false }]], line: LINE_MILES }),
    () => underADialog(browser),
    () => aRealButton(browser),
    () => onALockScreen(browser, 'DFT13a', 'the onboarding lock screen', { world: {}, onboarding: { user_id: DRIVER.id, status: 'documents_pending', onboarded_at: null, documents: [], totalDocs: 5 } }, '.ob-welcome'),
    () => onALockScreen(browser, 'DFT13b', 'the failed-load lock screen', { world: {}, driverLoadFails: true }, '.loc-card'),
    () => landingScene(browser, {
      step: 'DFT14', title: 'a delivered load\'s page on screen, a load on the road', world: { leg: 'to_delivery', routeMiles: 180 },
      loads: [ON_THE_ROAD, [5, 'QA-FUEL-5', 'Delivered']], opens: LOAD_ID, before: openHistorical('QA-FUEL-5'),
    }),
    () => toastScene(browser, {
      step: 'DFT15', title: 'a delivered load\'s page on screen, and no other', world: {}, loads: [[5, 'QA-FUEL-5', 'Delivered']],
      line: LINE_MILES, staysOn: 'QA-FUEL-5', before: openHistorical('QA-FUEL-5'),
    }),
    () => landingScene(browser, {
      step: 'DFT16', title: 'two loads under way, the newer row behind', world: { leg: 'to_delivery', routeMiles: 180 },
      loads: [ON_THE_ROAD, [9, OTHER_LOAD, 'Heading to Shipper']], opens: LOAD_ID,
    }),
    () => repeatTapHoursLater(browser),
    () => tapAfterAFailure(browser),
    () => answersLandLate(browser, 'DFT1r', false),
    () => answersLandLate(browser, 'DFT1t', true),
    () => landingScene(browser, { step: 'DFT1d', title: 'a load on the road', world: { leg: 'to_delivery', routeMiles: 180 }, loads: [ON_THE_ROAD] }, DESKTOP),
    () => toastScene(browser, { step: 'DFT7d', title: 'flag on', world: {}, loads: [], line: LINE_MILES }, DESKTOP),
  ]
  for (const run of steps) {
    try { await run() } catch (e) { record('DFT!', 'The chip\'s tap: aborted', '', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
  }
}

// ---------------------------------------------------------------- Offline shown and cleared
const OFFLINE_CHIP = '.app-header-left .status-chip.warn'
const OFFLINE_STEPS = [
  { step: 'DFO1', viewport: PHONE, driverName: SHORT_NAME },
  { step: 'DFO2', viewport: PHONE, driverName: LONG_NAME },
  { step: 'DFO3', viewport: NARROW, driverName: SHORT_NAME },
  { step: 'DFO4', viewport: NARROW, driverName: LONG_NAME },
  { step: 'DFO5', viewport: SMALL, driverName: SHORT_NAME },
  { step: 'DFO6', viewport: SMALL, driverName: LONG_NAME },
  { step: 'DFO7', viewport: NARROW, driverName: LONG_NAME, openLoad: true },
  { step: 'DFO8', viewport: TABLET, driverName: LONG_NAME },
]

// Exact, with no tolerance: nothing in the page depends on the socket, so any change is a move.
function readStill(page) {
  return page.evaluate(() => {
    const first = document.querySelector('.load-detail, .load-card')
    return {
      header: document.querySelector('.app-header').getBoundingClientRect().height,
      top: document.querySelector('.app-content').getBoundingClientRect().top,
      first: first ? first.getBoundingClientRect().top : null,
    }
  })
}
const stayed = (a, b) => a.header === b.header && a.top === b.top && a.first === b.first

async function offlineFlip(browser, sc, headerAtWidth) {
  const { viewport } = sc
  const size = `${viewport.width} x ${viewport.height}`
  const { ctx, page, sock } = await openScene(browser, { world: {}, driverName: sc.driverName }, viewport, { openLoad: !!sc.openLoad, socket: true })
  try {
    await page.locator('.load-detail, .load-card').first().waitFor({ state: 'visible', timeout: 30000 })
    await page.locator('.fuel-chip').waitFor({ state: 'visible', timeout: 15000 })
    await Promise.race([sock.connected, new Promise((_, reject) => setTimeout(() => reject(new Error('the socket never connected')), 15000))])
    // Let the page's other first answers settle, so a move below can only be Offline's.
    await page.waitForTimeout(800)
    const before = await readStill(page)
    await sock.drop()
    await page.locator(OFFLINE_CHIP).waitFor({ state: 'visible', timeout: 15000 })
    const during = await readStill(page)
    const m = await measureHeader(page)
    const file = path.join(SHOTS, `${sc.step.toLowerCase()}-${viewport.width}x${viewport.height}-offline.png`)
    await page.screenshot({ path: file }).catch((e) => console.log(`  (screenshot ${sc.step} failed: ${e.message})`))
    sock.comeBack()
    await page.locator(OFFLINE_CHIP).waitFor({ state: 'hidden', timeout: 30000 })
    const after = await readStill(page)
    if (headerAtWidth[viewport.width] === undefined) headerAtWidth[viewport.width] = before.header
    const checks = {
      stillOnOffline: stayed(before, during),
      stillOnClear: stayed(before, after),
      sameHeaderAnyName: before.header === headerAtWidth[viewport.width],
      name: m.name === sc.driverName,
      offlineOnScreen: m.offlineOnScreen,
      offlineClearOfButtons: m.offlineClearOfButtons,
      chipOnScreen: m.chipOnScreen,
      chipWhole: m.chipWhole,
      buttonsOnScreen: m.buttonsOnScreen,
      buttonsTakeTap: m.buttonsTakeTap,
      pageBelowHeader: m.pageBelowHeader,
      noSideways: m.sideways <= 0,
    }
    record(sc.step, `Offline shown and cleared at ${size}, ${sc.driverName === LONG_NAME ? 'long' : 'two-word'} name${sc.openLoad ? ', on a load page' : ''}`,
      'the header and the page don\'t move at all; Offline, the chip and the buttons whole and on screen; the same header for any name',
      `${flags(checks)}; header ${before.header}, ${during.header}, ${after.header}; page top ${before.top}, ${during.top}, ${after.top}; first item ${before.first}, ${during.first}, ${after.first}`, allTrue(checks), file)
  } finally {
    await ctx.close()
  }
}

async function offlineSteps(browser) {
  const headerAtWidth = {}
  for (const sc of OFFLINE_STEPS) {
    try { await offlineFlip(browser, sc, headerAtWidth) } catch (e) { record(sc.step, `Offline at ${sc.viewport.width}: aborted`, '', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
  }
}

// ---------------------------------------------------------------- Messages
const MESSAGES_STEPS = [
  { step: 'DFM1', viewport: PHONE, driverName: SHORT_NAME },
  { step: 'DFM2', viewport: PHONE, driverName: LONG_NAME },
  { step: 'DFM3', viewport: SMALL, driverName: LONG_NAME },
  { step: 'DFM1d', viewport: DESKTOP, driverName: SHORT_NAME },
]

async function messagesScene(browser, sc) {
  const { viewport } = sc
  const size = `${viewport.width} x ${viewport.height}`
  const { ctx, page } = await openScene(browser, { world: {}, driverName: sc.driverName }, viewport, { openLoad: false })
  try {
    await page.locator('.load-card').first().waitFor({ state: 'visible', timeout: 30000 })
    await page.locator('.van-tabbar-item').filter({ hasText: 'Messages' }).first().click()
    await page.locator('.chat-input-bar').waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(300)
    const m = await page.evaluate(() => {
      const takesTap = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)
        return !!hit && (hit === el || el.contains(hit))
      }
      const bar = document.querySelector('.chat-input-bar').getBoundingClientRect()
      const tabs = document.querySelector('.van-tabbar').getBoundingClientRect()
      return {
        clearPx: tabs.top - bar.bottom,
        boxPx: document.querySelector('.chat-messages').getBoundingClientRect().height,
        inputTakesTap: takesTap(document.querySelector('.chat-input')),
        sendTakesTap: takesTap(document.querySelector('.send-btn')),
        sideways: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
      }
    })
    const file = path.join(SHOTS, `${sc.step.toLowerCase()}-${viewport.width}x${viewport.height}-messages.png`)
    await page.screenshot({ path: file }).catch((e) => console.log(`  (screenshot ${sc.step} failed: ${e.message})`))
    const checks = {
      // 86 px is the room the box had above the tab bar under the old 52 px header.
      sameRoomAboveTabs: m.clearPx >= 85,
      messagesHaveRoom: m.boxPx >= 100,
      inputTakesTap: m.inputTakesTap,
      sendTakesTap: m.sendTakesTap,
      noSideways: m.sideways <= 0,
    }
    record(sc.step, `Messages at ${size}, ${sc.driverName === LONG_NAME ? 'long' : 'two-word'} name`, 'at least 85 px between the input bar and the tab bar; input and Send take a tap; the messages have room',
      `${flags(checks)}; ${m.clearPx} px clear; messages ${m.boxPx} px`, allTrue(checks), file)
  } finally {
    await ctx.close()
  }
}

async function messagesSteps(browser) {
  for (const sc of MESSAGES_STEPS) {
    try { await messagesScene(browser, sc) } catch (e) { record(sc.step, `Messages at ${sc.viewport.width}: aborted`, '', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
  }
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use`)
  const server = http.createServer(serveDist)
  await new Promise((resolve) => server.listen(PORT, HOST, resolve))
  let browser = null
  try {
    browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
    for (const sc of SCENES) {
      try { await phoneScene(browser, sc) } catch (e) { record(sc.step, `${sc.title}: aborted`, '', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
    }
    for (const [name, fn] of [['route options', routeOptions], ['desktop', desktop], ['header chip', chipSteps], ['the chip\'s tap', tapSteps], ['offline', offlineSteps], ['messages', messagesSteps]]) {
      try { await fn(browser) } catch (e) { record('DF!', `${name}: aborted`, '', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
    }
    // DF7's trip plan and DFT13b's first load answer 400 on purpose; the browser logs that one line.
    const consoleErrors = consoleLines.filter((l) => l.type === 'error' && !harnessLine(l))
    const notNetwork = consoleErrors.filter((l) => !/^Failed to load resource: the server responded with a status of 400/.test(l.text))
    record('DFx', 'Page errors; console errors; writes', 'no page errors; console errors only the browser\'s line for those 400s; no writes',
      `${pageErrors.length ? pageErrors.join('; ') : 'no page errors'}; ${consoleErrors.length} console error line(s), ${notNetwork.length} other${notNetwork.length ? `: ${notNetwork.map((l) => l.text.slice(0, 120)).join('; ')}` : ''}; ${writes.length ? writes.join(', ') : 'no writes'}`,
      pageErrors.length === 0 && notNetwork.length === 0 && writes.length === 0)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await new Promise((r) => server.close(() => r()))
  }
  const cell = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  const lines = [
    `# LogisX — the driver app's Fuel section, driver gallons flag (made-up data) — ${new Date().toISOString()}`,
    '',
    '| Step | What | Expected | Observed | Verdict | Screenshot |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${cell(r.step)} | ${cell(r.title)} | ${cell(r.expected)} | ${cell(r.observed)} | ${r.verdict} | ${r.shot ? cell(path.basename(r.shot)) : ''} |`),
    '',
  ]
  fs.writeFileSync(RESULTS, lines.join('\n'))
  console.log(`\nresults: ${RESULTS}\nscreenshots: ${SHOTS}`)
}

await main()
process.exit(exitCode)
