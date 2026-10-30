#!/usr/bin/env node
// LogisX — the driver app's Fuel section with the driver gallons flag (DRIVER_FUEL_GALLONS_ENABLED,
// plan R14 PR 2), on made-up data only: 390 x 844 first, then 1280 x 800.
//
//   DF1   before pickup: enough to reach the pickup, add to finish; the collapsed badge "Add 65 gal"
//   DF2   in transit, enough            DF3  refuel now             DF4  no ELD fuel reading
//   DF5   ELD silent 18 hrs             DF6  no tank size, and the header chip "Fuel ?"
//   DF7   load not mapped (400 NO_ROUTE)
//   DF8a  position 3 hrs old            DF8b no position (one whole-load row)
//   DF9   extra stops                   DF10 a run longer than a full tank
//   DF11  Route Options without Google's gallons
//   DF12  the flag off: today's panel, unchanged, and Route Options with their gallons
//   DF1d, DF6d, DF12d  the same at 1280 x 800 (the block one column, at most about 520 px wide)
//   DFx   no page errors, no console errors, no writes
// At 390 x 844 every step also checks: no sideways scroll, row text at least 14 px, Refresh at least 44 px.
//
// Like phone-layout.mjs: no server.js, database, settings file, key or sign-in. The checkout's built
// client/dist is served from a static server on 127.0.0.1 (E2E_PORT, default 3186; 3000, 5173 and 3901
// refused), every /api request is answered in the browser with made-up fixtures (a made-up Driver,
// "Driver QA", on load QA-FUEL-1, truck "Unit 901", Riverton to Lakeside), and the fuel answers' blocks
// are built by the server's own planDriverFuel() (lib/fuel-model.js). The Google Maps script is a stub
// that draws nothing; every other host is aborted.
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
const DESKTOP = { width: 1280, height: 800 }

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
    positionAgeMinutes: 12, extraStops: false, afterAnotherLoad: false, routeSource: 'routes_api', ...o,
  }
  const sensor = s.hasTruck && s.hasDevice
  const reading = !sensor ? { fuelPct: null, fuelSource: 'none', anchorPct: null, ageMinutes: null, milesSinceReading: null }
    : s.fuelSource === 'stale' ? { fuelPct: null, fuelSource: 'stale', anchorPct: s.pct, ageMinutes: s.readAge, milesSinceReading: null }
      : { fuelPct: s.pct, fuelSource: s.fuelSource, anchorPct: s.pct, ageMinutes: s.readAge, milesSinceReading: 0 }
  const pct = reading.fuelPct
  const rangeMiles = pct == null ? null : fuel.computeRange({ fuelPct: pct, tankGallons: s.tank, mpg: s.mpg }).rangeMiles
  const trip = fuel.planTripFuel({ routeMiles: s.routeMiles, fuelPct: pct, burn: s.burn, rangeMiles, mpg: s.mpg, reserve: R15 })
  const common = { reading, hasTruck: s.hasTruck, hasDevice: sensor, tankSource: s.tankSource, tankGallons: s.tank, mpg: s.mpg, burn: s.burn, reserve: R15 }
  const approach = s.leg === 'to_pickup' ? s.approach : 0
  const planBlock = fuel.planDriverFuel({
    ...common, plan: trip, leg: s.leg, approachMiles: approach,
    fromLivePosition: s.fromLivePosition, positionAgeMinutes: s.fromLivePosition ? s.positionAgeMinutes : null,
    routeSource: s.routeSource, extraStops: s.extraStops, afterAnotherLoad: s.afterAnotherLoad,
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

function driverPayload(status) {
  const load = {
    _rowIndex: 2, 'Load ID': LOAD_ID, 'Job Status': status, Driver: DRIVER_NAME,
    'Pickup Address': '100 Example Rd, Riverton, TN 38118', 'Drop-off Address': '200 Sample Ave, Lakeside, TX 75201',
    'Pickup Appointment': '2026-10-30 08:00', 'Drop-off Appointment': '2026-10-31 14:00', _accepted: true, _expenseWindow: { state: 'active' },
  }
  return {
    loads: [load], driverInfo: null, truck: { unit_number: '901', make: 'QA', model: 'Example', status: 'Active' }, messages: [], notifications: [],
    expenses: [], drivers: [], headers: { jobTracking: HEADERS, carrierDB: [] }, onboarding: null, application: null, invoices: [],
    sharedDocuments: [], truckDocuments: [], profilePictureUrl: '', driverDirectoryId: 0,
  }
}

// One scene's answers: { status, body } per path.
function answersFor(scene) {
  const w = world(scene.world || {})
  const plan = scene.planError ? { status: 400, body: { ok: false, error: 'load has no geocoded destination', code: scene.planError } } : { status: 200, body: w.plan }
  return {
    status: w.status,
    '/api/fuel/range': { status: 200, body: w.range },
    '/api/fuel/trip-plan': plan,
    '/api/poi/fuel-stops': { status: 200, body: STOPS },
  }
}

function answerGet(pathname, scene, answers) {
  if (answers[pathname]) return answers[pathname]
  const ok = (body) => ({ status: 200, body })
  if (pathname === '/api/auth/session') return ok({ authenticated: true, user: DRIVER, appTimeZone: 'America/New_York' })
  if (pathname === `/api/driver/${encodeURIComponent(DRIVER_NAME)}`) return ok(driverPayload(answers.status))
  if (pathname === '/api/config/maps-key') return ok({ key: 'qa-fuel-no-key' })
  if (pathname === '/api/locations/latest') return ok({ locations: [] })
  if (pathname === '/api/driver/position') return ok({ ok: false, reason: 'no_position' })
  if (pathname === '/api/route') return ok(scene.routes ? ROUTES : { routes: [], recommendedIdx: 0, fallback: true })
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

async function openScene(browser, scene, viewport) {
  const answers = answersFor(scene)
  const phone = viewport === PHONE
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
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
    const a = answerGet(url.pathname, scene, answers)
    return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 200)))
  page.on('console', (m) => consoleLines.push({ type: m.type(), text: m.text(), url: String((m.location() && m.location().url) || '') }))
  await page.goto(`${BASE}/driver`)
  await page.locator('.load-card').filter({ hasText: LOAD_ID }).first().click({ timeout: 30000 })
  await page.locator('.load-detail').waitFor({ state: 'visible', timeout: 15000 })
  return { ctx, page }
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
  { step: 'DF1', title: 'Before pickup', world: {}, expect: ['225', 'miles until you run out', 'To reach pickup', '140 mi', 'Uses about 30 gal. You have enough.', 'To finish this load', '420 mi', 'Uses about 80 gal. Add about 65 gal.'], badge: 'Add 65 gal' },
  { step: 'DF2', title: 'In transit, enough', world: { leg: 'to_delivery', routeMiles: 180 }, expect: ['225', 'Uses about 35 gal. You have enough.'] },
  { step: 'DF3', title: 'Refuel now', world: { pct: 3, leg: 'to_delivery', routeMiles: 180 }, expect: ['Refuel now', 'Stop for fuel as soon as you can.', 'Add about 60 gal.'] },
  { step: 'DF4', title: 'No ELD fuel reading', world: { hasDevice: false, fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, expect: ['Fuel level unknown', "Your truck isn't sending a fuel level. Check your gauge.", 'Whole load, pickup to delivery', 'You need about 100 gal in the tank for the whole load. Check your gauge.'] },
  { step: 'DF5', title: 'ELD silent 18 hrs', world: { fuelSource: 'stale', readAge: 18 * 60, leg: 'to_delivery' }, expect: ['Fuel level unknown', 'No fuel reading for 18 hrs. Check your gauge.', 'You need about 145 gal in the tank to finish. Check your gauge.'] },
  { step: 'DF6', title: 'No tank size, and the header chip', world: { burn: NO_BURN, tankSource: 'default', tank: 200 }, expect: ['Miles left unknown', "This truck's tank size isn't on file. Check your gauge and ask dispatch to add it."], chip: 'Fuel ?' },
  { step: 'DF7', title: 'Load not mapped', world: {}, planError: 'NO_ROUTE', expect: ['225', "This load isn't on the map yet, so we can't work out the fuel for it."] },
  { step: 'DF8a', title: 'Position 3 hrs old', world: { positionAgeMinutes: 180, leg: 'to_delivery' }, expect: ['Worked out from where your truck was 3 hrs ago.'] },
  { step: 'DF8b', title: 'No position', world: { fromLivePosition: false, leg: 'to_delivery', routeMiles: 280 }, expect: ['Whole load, pickup to delivery', "Your truck hasn't sent its location recently."] },
  { step: 'DF9', title: 'Extra stops', world: { extraStops: true }, expect: ['To reach first pickup', 'You need about 55 gal in the tank to reach pickup. Check your gauge.', "This load has extra stops that aren't counted. You may need more fuel."], absent: ['You have enough'] },
  { step: 'DF10', title: 'Longer than a full tank', world: { leg: 'to_delivery', routeMiles: 1040 }, expect: ['1,040 mi', 'Uses about 195 gal. Fill up full, and plan another fuel stop on the way.'] },
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
            todayPanel: panel.includes('How we know') && panel.includes('kept back as a reserve'),
            noBlock: (await page.locator('[data-testid="driver-fuel"]').count()) === 0,
            todayBadge: badge === 'Fuel stop needed',
            routeOptionsGallons: hasOptions && altText.includes('⛽'),
            noSideways: m.sideways <= 0,
          }
      record(step, flag ? 'Route Options with the flag on' : 'The flag off: today\'s panel', flag
        ? 'Route Options show, without Google\'s gallons; the toll stays'
        : 'the panel as today ("How we know", the reserve line), no block, the badge "Fuel stop needed", Route Options with their gallons',
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
    for (const [name, fn] of [['route options', routeOptions], ['desktop', desktop]]) {
      try { await fn(browser) } catch (e) { record('DF!', `${name}: aborted`, '', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
    }
    // DF7's trip plan answers 400 on purpose; the browser logs that one line.
    const consoleErrors = consoleLines.filter((l) => l.type === 'error' && !harnessLine(l))
    const notNetwork = consoleErrors.filter((l) => !/^Failed to load resource: the server responded with a status of 400/.test(l.text))
    record('DFx', 'Page errors; console errors; writes', 'no page errors; console errors only the browser\'s line for DF7\'s 400; no writes',
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
