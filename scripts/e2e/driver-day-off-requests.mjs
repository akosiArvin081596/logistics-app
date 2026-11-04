#!/usr/bin/env node
// LogisX — a driver's day-off requests and the office's answer, on made-up data only
// (DRIVER_TIME_OFF_REQUESTS_ENABLED, on top of the time-off screen).
//
// As a made-up Driver ("Casey Example") at 375x667 (a phone, touch), and made-up staff
// ("qa-timeoff-dispatcher", a Dispatcher) at 390x844 and 1280x800:
//   D1  the Kit tab's "My time off" card offers "Request days off"; the form starts at
//       the server's first allowed day, its date limits are the server's, nothing
//       scrolls sideways, every button is 44 px tall or more
//   D2  a first day before the server's limit leaves Send disabled and sends nothing; a
//       real request sends exactly { kind, from, to } (no reason), the card says
//       "Request sent. Dispatch will answer in the app." and lists it "Waiting for
//       approval" with "Cancel request"
//   D3  a Dispatcher's Notifications page shows the notice with Approve and Decline;
//       Approve sends one POST with an empty body and the notice reads "Approved by
//       qa-timeoff-dispatcher" with no buttons left (390x844, 44 px buttons)
//   D4  the driver's next load shows it under "My time off" as Upcoming and no longer
//       as a request
//   D5  a request over loads the driver already has: Approve asks "This driver has
//       loads on these days"; "Keep waiting" sends nothing more; "Approve anyway"
//       re-sends with the server's loads echoed back as confirmLoads (1280x800)
//   D6  Decline: the notice reads "Declined by ..."; the driver's card shows "Not
//       approved. Message dispatch." with no Cancel; a request still waiting can be
//       withdrawn with "Cancel request" (one POST to the cancel route, a note, the row gone)
//   D7  the office panel (the dashboard's Fleet & Drivers dialog; 1280x800 and 390x844):
//       waiting requests come first with "Asked by the driver", Approve moves one into
//       the live list as "Asked by the driver, approved by ...", Decline moves one to
//       "Past, declined and cancelled" as "Declined"
//   D8  the flag off: with the time-off screen off the payload has no `timeOff` and
//       there is no card; with only the requests off the card has no "Request days
//       off", no form, no "Your requests" and the recorded-by-dispatch hint; the
//       office panel has no waiting list and no Approve; the page sent no request
// Step names carry the size where a step runs at more than one.
//
// Like driver-emergency-contacts-profile.mjs this boots no server.js, opens no database,
// reads no settings file or key and signs nobody in. It serves the checkout's built
// client/dist from its own static server on 127.0.0.1 (E2E_PORT, default 3184) and
// answers every /api request in the browser with made-up fixtures that hold one small
// "server" state (rows, notices, calls) shared by the driver's and the staff's pages of
// one flow, in the shapes server.js sends. Every request to another host is aborted,
// the socket included, so no live event arrives: each page reloads to see the other's change.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/driver-day-off-requests.mjs
//
// Env: E2E_PORT (default 3184; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "driver-day-off-requests"), HEADED=1, CHROME_PATH, E2E_WORK_DIR,
// SHOT_DIR (an absolute folder outside the checkout; default <work dir>/shots/<OUT_TAG>).
// Output: the screenshots and <work dir>/results-<OUT_TAG>.md. Exit 0 only when every row PASSes.
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
const OUT_TAG = String(process.env.OUT_TAG || 'driver-day-off-requests').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const PHONE = { tag: '375x667', viewport: { width: 375, height: 667 } }
const STAFF_PHONE = { tag: '390x844', viewport: { width: 390, height: 844 } }
const STAFF_DESKTOP = { tag: '1280x800', viewport: { width: 1280, height: 800 } }

function die(msg) {
  console.error(`driver-day-off-requests: ${msg}`)
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
const DRIVER = { id: 90302, username: 'qa-timeoff-driver', role: 'Driver', driverName: 'Casey Example', email: '', fullName: 'Casey Example', companyName: '', mustChangePassword: false }
const DISPATCHER = { id: 90301, username: 'qa-timeoff-dispatcher', role: 'Dispatcher', driverName: '', email: '', fullName: 'QA Timeoff Dispatcher', companyName: '', mustChangePassword: false }
const DIRECTORY_ID = 501
const DAY = 24 * 60 * 60 * 1000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const KIND_LABEL = { vacation: 'Vacation', off_duty: 'Off duty', other: 'Other' }
const REQUEST_HINT = 'Ask at least 5 days ahead. Dispatch approves each request. For sooner days or changes, message dispatch.'
const RECORDED_HINT = 'Dispatch records your time off. To change it, message dispatch.'
const SENT_NOTE = 'Request sent. Dispatch will answer in the app.'
const LEAD_DAYS = 5
const HORIZON_DAYS = 90
const MAX_DAYS = 60

// The business day, in the app's zone, as the server would send it.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const dayIndex = (k) => Math.round(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10))) / DAY)
const shift = (k, n) => new Date((dayIndex(k) + n) * DAY).toISOString().slice(0, 10)
const md = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8, 10))}`
function rangeText(from, to) {
  if (from === to) return md(from)
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${md(from)}, ${from.slice(0, 4)} – ${md(to)}, ${to.slice(0, 4)}`
  return `${md(from)} – ${md(to)}`
}
const FROM_MIN = shift(TODAY, LEAD_DAYS)
const FROM_MAX = shift(TODAY, HORIZON_DAYS)

// What the "server" holds. `requestsOn` is DRIVER_TIME_OFF_REQUESTS_ENABLED, `screenOn`
// is DRIVER_TIME_OFF_SCREEN_ENABLED, `loads` the loads an approval would cover.
function freshState({ requestsOn = true, screenOn = true, loads = [] } = {}) {
  return {
    requestsOn, screenOn, loads, rows: [], notices: [], nextId: 8001, nextNotice: 9001,
    calls: { request: [], cancel: [], approve: [], decline: [] }, flagOffHits: 0,
  }
}

// A time-off row the way the table holds it; a driver's request also gets its staff notice.
function addRow(state, { from, to, kind = 'off_duty', request = 'approved', source = 'driver', decidedBy = null }) {
  const row = { id: state.nextId++, kind, from, to, request, source, decidedBy, cancelled: false, createdAt: new Date().toISOString() }
  state.rows.push(row)
  if (source === 'driver') {
    state.notices.push({
      id: state.nextNotice++, rowId: row.id,
      title: `Time off request: ${DRIVER.driverName} (${rangeText(from, to)})`,
      body: `${KIND_LABEL[kind]}. Asked ${md(TODAY)}.`,
      read: 0, createdAt: new Date().toISOString(),
    })
  }
  return row
}

const rowStatus = (r) => (r.cancelled ? 'cancelled' : r.to < TODAY ? 'past' : r.from > TODAY ? 'upcoming' : 'current')

function staffRowView(state, r) {
  return {
    id: r.id, directoryId: DIRECTORY_ID, kind: r.kind, from: r.from, to: r.to, reason: '', createdBy: r.source === 'driver' ? DRIVER.username : DISPATCHER.username,
    createdAt: r.createdAt, updatedAt: null, cancelledAt: r.cancelled ? new Date().toISOString() : null, cancelledBy: r.cancelled ? DRIVER.username : null,
    status: rowStatus(r), editable: 'none', limits: null,
    ...(state.requestsOn ? { request: r.request, source: r.source, decidedBy: r.decidedBy, decidedAt: r.decidedBy ? new Date().toISOString() : null } : {}),
  }
}

function driverRequestView(r) {
  const waiting = r.request === 'waiting'
  return { id: r.id, kind: r.kind, from: r.from, to: r.to, request: waiting ? 'waiting' : 'declined', canCancel: waiting && r.source === 'driver' }
}

function timeOffPayload(state) {
  const rows = state.rows
    .filter((r) => !r.cancelled && r.request === 'approved' && r.to >= TODAY)
    .sort((a, b) => (a.from < b.from ? -1 : 1))
    .map((r) => ({ id: r.id, kind: r.kind, from: r.from, to: r.to, status: r.from > TODAY ? 'upcoming' : 'current' }))
  if (!state.requestsOn) return { today: TODAY, rows }
  const requests = state.rows
    .filter((r) => !r.cancelled && ((r.request === 'waiting' && r.to >= TODAY) || (r.request === 'declined' && r.from >= TODAY)))
    .sort((a, b) => (a.from < b.from ? -1 : 1))
    .map(driverRequestView)
  return { today: TODAY, rows, requests, requestLimits: { fromMin: FROM_MIN, fromMax: FROM_MAX, maxDays: MAX_DAYS, waitingMax: 5 }, canRequest: true }
}

function driverPayload(state) {
  return {
    loads: [],
    headers: { jobTracking: [], carrierDB: [] },
    onboarding: { user_id: DRIVER.id, status: 'fully_onboarded', onboarded_at: new Date(Date.now() - 30 * DAY).toISOString(), documents: [], totalDocs: 5 },
    driverInfo: null, truck: null, messages: [], notifications: [], expenses: [], drivers: [], invoices: [], sharedDocuments: [], truckDocuments: [],
    ...(state.screenOn ? { timeOff: timeOffPayload(state) } : {}),
  }
}

const DIRECTORY_ROW = {
  Driver: DRIVER.driverName, 'Carrier Name': '', State: 'TX', City: 'Austin', ZIP: '78701', Address: '1 Example St', Trucks: 'QA-1', Hazmat: '',
  PhoneNumber: '(512) 555-0100', CellNumber: '', Email: 'casey.example@example.com', DOT: '', MC: '', Rating: '', Status: 'active',
  PayType: 'fixed', PayPercentage: 0, PayDaily: 0, ProfilePictureUrl: '', _rowIndex: DIRECTORY_ID, _id: DIRECTORY_ID,
}
const DIRECTORY = {
  headers: ['Driver', 'Carrier Name', 'State', 'City', 'ZIP', 'Address', 'Trucks', 'Hazmat', 'PhoneNumber', 'CellNumber', 'Email', 'DOT', 'MC', 'Rating', 'Status', 'PayType', 'PayPercentage', 'PayDaily'],
  data: [DIRECTORY_ROW], total: 1, dailyRateRule: null,
}
// `offUntil` is present only while availability is on: it is what opens the panel.
const DASHBOARD = {
  timestamp: new Date().toISOString(),
  kpis: { activeLoads: 0, unassignedLoads: 0, completedThisWeek: 0, completedThisMonth: 0, fleetUtilization: { assigned: 0, total: 1 }, revenue: { total: 0, paid: 0, pending: 0 } },
  unassignedJobs: [], jobTrackingHeaders: [], completedHeaders: [], activeJobs: [], completedJobs: [],
  fleet: [{ Driver: DRIVER.driverName, Truck: 'QA-1', Status: 'Available', CompletedLoads: 3, CurrentLoad: '', Phone: '(512) 555-0100', QueueCount: 0, QueuedLoadIds: [], offUntil: '' }],
  drivers: [DRIVER.driverName], driverQueues: {},
}

function noticeView(state, n) {
  const row = state.rows.find((r) => r.id === n.rowId)
  const meta = { availabilityId: n.rowId, directoryId: DIRECTORY_ID }
  if (row && row.cancelled) Object.assign(meta, { decision: 'cancelled', decidedBy: 'driver' })
  else if (row && row.request !== 'waiting') Object.assign(meta, { decision: row.request, decidedBy: row.decidedBy || '' })
  return { id: n.id, type: 'time-off-request', title: n.title, body: n.body, metadata: JSON.stringify(meta), read: n.read, createdAt: n.createdAt }
}

const FEATURE_OFF = { status: 404, body: { error: 'Not found', code: 'FEATURE_OFF' } }
const FORBIDDEN = { status: 403, body: { error: 'Forbidden' } }
const parse = (raw) => { try { return JSON.parse(raw || 'null') } catch { return null } }

function answerGet(who, state, pathname) {
  if (pathname === '/api/auth/session') return { status: 200, body: { authenticated: true, user: who, appTimeZone: 'America/New_York' } }
  if (who.role === 'Driver') {
    if (pathname === `/api/driver/${encodeURIComponent(DRIVER.driverName)}`) return { status: 200, body: driverPayload(state) }
    if (pathname === '/api/driver/position') return { status: 200, body: { ok: true, unit: 'QA-1', position: { latitude: 33.75, longitude: -84.39, speed: 0, speedMph: 0, heading: 90, timestamp: new Date(Date.now() - 4000).toISOString(), lastPingAge: 4000, source: 'routemate', fuelPct: null, movement: 'stopped', stoppedSinceMs: Date.now() - 10 * 60000 } } }
    if (pathname === '/api/fuel/range') return { status: 200, body: { ok: false } }
    return null
  }
  if (pathname === '/api/dispatch-notifications') {
    const list = state.notices.slice().reverse().map((n) => noticeView(state, n))
    return { status: 200, body: { notifications: list, unreadCount: list.filter((n) => !n.read).length } }
  }
  if (pathname === `/api/drivers-directory/${DIRECTORY_ID}/availability`) {
    const rows = state.rows.slice().sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : b.id - a.id)).map((r) => staffRowView(state, r))
    return { status: 200, body: { directoryId: DIRECTORY_ID, driver: DRIVER.driverName, today: TODAY, createLimits: { fromMin: shift(TODAY, -30), toMin: null, maxDays: MAX_DAYS }, rows } }
  }
  if (pathname === '/api/drivers-directory') return { status: 200, body: DIRECTORY }
  if (pathname === '/api/dashboard') return { status: 200, body: DASHBOARD }
  if (pathname === '/api/load-ratings/averages') return { status: 200, body: { averages: {} } }
  if (pathname === '/api/truck-assignments') return { status: 200, body: { assignments: [] } }
  if (pathname === '/api/config/maps-key') return { status: 200, body: { key: 'qa-timeoff-no-key' } }
  if (pathname === '/api/locations/latest') return { status: 200, body: { locations: [] } }
  return null
}

// The four request routes, answered as the server does (its codes and its words); null
// for any other write.
function answerPost(who, state, pathname, raw) {
  const body = parse(raw)
  let m
  if (pathname === '/api/driver/me/availability') {
    if (who.role !== 'Driver') return FORBIDDEN
    if (!state.requestsOn) { state.flagOffHits++; return FEATURE_OFF }
    state.calls.request.push(body)
    const b = body && typeof body === 'object' ? body : {}
    if (Object.prototype.hasOwnProperty.call(b, 'reason')) return { status: 400, body: { error: 'A request carries no reason. Choose the kind of time off; anything else, tell dispatch.', code: 'REASON_NOT_ALLOWED' } }
    if (!KIND_LABEL[b.kind]) return { status: 400, body: { error: 'Kind must be one of vacation, off_duty, other.', code: 'INVALID_KIND' } }
    if (b.from < FROM_MIN) return { status: 400, body: { error: `Days off must be asked for at least ${LEAD_DAYS} days ahead.`, code: 'TIME_OFF_TOO_SOON', fromMin: FROM_MIN } }
    if (b.from > FROM_MAX) return { status: 400, body: { error: `Days off can be asked for up to ${HORIZON_DAYS} days ahead.`, code: 'TIME_OFF_TOO_FAR', fromMax: FROM_MAX } }
    const row = addRow(state, { from: b.from, to: b.to, kind: b.kind, request: 'waiting', source: 'driver' })
    return { status: 201, body: { success: true, request: driverRequestView(row) } }
  }
  if ((m = pathname.match(/^\/api\/driver\/me\/availability\/(\d+)\/cancel$/))) {
    if (who.role !== 'Driver') return FORBIDDEN
    if (!state.requestsOn) { state.flagOffHits++; return FEATURE_OFF }
    const row = state.rows.find((r) => r.id === Number(m[1]))
    state.calls.cancel.push({ id: Number(m[1]) })
    if (!row) return { status: 404, body: { error: 'Request not found', code: 'AVAILABILITY_NOT_FOUND' } }
    if (row.request !== 'waiting') return { status: 409, body: { error: 'This request was already decided. Message dispatch to change it.', code: 'TIME_OFF_REQUEST_DECIDED' } }
    row.cancelled = true
    return { status: 200, body: { success: true } }
  }
  if ((m = pathname.match(/^\/api\/driver-availability\/(\d+)\/(approve|decline)$/))) {
    if (who.role !== 'Super Admin' && who.role !== 'Dispatcher') return FORBIDDEN
    if (!state.requestsOn) { state.flagOffHits++; return FEATURE_OFF }
    const decision = m[2]
    state.calls[decision].push({ id: Number(m[1]), body })
    const row = state.rows.find((r) => r.id === Number(m[1]))
    if (!row) return { status: 404, body: { error: 'Time off not found', code: 'AVAILABILITY_NOT_FOUND' } }
    if (row.cancelled || row.request !== 'waiting') return { status: 409, body: { error: 'This request was just decided.', code: 'TIME_OFF_REQUEST_DECIDED' } }
    if (decision === 'approve' && state.loads.length && !(body && Array.isArray(body.confirmLoads) && body.confirmLoads.length)) {
      const loads = state.loads.map((l) => ({ loadId: l.loadId, from: l.from, to: l.to }))
      return {
        status: 409,
        body: {
          error: `${DRIVER.driverName} has load ${loads[0].loadId} (${rangeText(loads[0].from, loads[0].to)}) overlapping these dates. Approve anyway? The load stays assigned to the driver.`,
          code: 'DRIVER_HAS_LOADS', driver: DRIVER.driverName, from: row.from, to: row.to, loads,
        },
      }
    }
    row.request = decision === 'approve' ? 'approved' : 'declined'
    row.decidedBy = who.username
    return { status: 200, body: { success: true, decision: row.request, decidedBy: who.username, row: staffRowView(state, row) } }
  }
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the day-off requests check"}')
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
let exitCode = 0
function record(step, title, expected, observed, ok, shot = '') {
  if (!ok) exitCode = 1
  rows.push({ step, title, expected, observed, verdict: ok ? 'PASS' : 'FAIL', shot })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${observed}`)
}

const shotDir = () => {
  const dir = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(paths.workDir(), 'shots', OUT_TAG)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
async function shot(page, name) {
  const file = path.join(shotDir(), `${OUT_TAG}-${name}.png`)
  await page.screenshot({ path: file })
  return file
}

// ---------------------------------------------------------------- page helpers
async function openPage(browser, size, who, state, url) {
  const phone = size.viewport.width < 640
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) return route.abort()
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (req.method() === 'GET') {
      const out = answerGet(who, state, u.pathname)
      if (out === null) unanswered.add(u.pathname)
      return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', body: JSON.stringify(out ? out.body : {}) })
    }
    const out = req.method() === 'POST' ? answerPost(who, state, u.pathname, req.postData()) : null
    if (out === null) {
      otherWrites.push(`${size.tag} ${req.method()} ${u.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({ status: out.status, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out.body) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' })
  return { ctx, page }
}

const text = (page, selector) => page.locator(selector).first().textContent({ timeout: 2000 }).then((t) => (t || '').replace(/\s+/g, ' ').trim(), () => '')
const visible = (page, selector) => page.locator(selector).first().isVisible().catch(() => false)
async function appears(page, selector, ms) {
  try { await page.waitForSelector(selector, { state: 'visible', timeout: ms }); return true } catch { return false }
}
async function staysAway(page, selector, ms) {
  try { await page.waitForSelector(selector, { state: 'visible', timeout: ms }); return false } catch { return true }
}
async function disappears(page, selector, ms) {
  try { await page.waitForSelector(selector, { state: 'hidden', timeout: ms }); return true } catch { return false }
}
// Polls a check in this process (the "server" state) for up to ms.
async function until(check, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1)
async function heights(page, selector) {
  const out = []
  for (const el of await page.locator(selector).all()) {
    if (await el.isVisible()) out.push(Math.round((await el.boundingBox()).height))
  }
  return out
}
const tall = (list) => list.length > 0 && list.every((h) => h >= 44)

// The driver: the Kit tab's card.
async function openKit(page) {
  await page.locator('.van-tabbar-item', { hasText: 'Kit' }).first().tap()
  return appears(page, 'section.time-off-card', 12000)
}
const CARD = 'section.time-off-card'
const requestRow = (page, range) => page.locator(`${CARD} .time-off-row`, { hasText: range })

// The staff: a notice by its title.
const notice = (page, range) => page.locator('.notif-item', { hasText: `(${range})` }).first()

// ---------------------------------------------------------------- the driver's request, approved from Notifications
async function requestFlow(browser) {
  const state = freshState()
  const FROM = FROM_MIN
  const TO = shift(FROM_MIN, 2)
  const RANGE = rangeText(FROM, TO)
  const driver = await openPage(browser, PHONE, DRIVER, state, '/driver')
  try {
    const dp = driver.page
    const card = await openKit(dp)
    if (!card) return record('D1', 'The Kit tab shows "My time off"', 'card shown', 'no card within 12 s', false, await shot(dp, 'D1'))
    await dp.waitForTimeout(500)
    const button = dp.locator(`${CARD} .time-off-btn-main`, { hasText: 'Request days off' })
    const hint = await text(dp, `${CARD} .time-off-hint`)
    const hasButton = await button.first().isVisible().catch(() => false)
    if (hasButton) await button.first().tap()
    const form = hasButton && await appears(dp, `${CARD} form.time-off-form`, 4000)
    await dp.waitForTimeout(300)
    const inputs = dp.locator(`${CARD} form.time-off-form input[type="date"]`)
    const first = form ? inputs.nth(0) : null
    const firstValue = first ? await first.inputValue() : ''
    const firstMin = first ? await first.getAttribute('min') : ''
    const firstMax = first ? await first.getAttribute('max') : ''
    const kind = form ? await dp.locator(`${CARD} form.time-off-form select`).inputValue() : ''
    const fits = await noSideScroll(dp)
    const sizes = form ? await heights(dp, `${CARD} .time-off-btn, ${CARD} .time-off-input`) : []
    record('D1', 'The card offers "Request days off"; the form starts at the server\'s first day, with its limits',
      `button shown; hint "${REQUEST_HINT}"; first day ${FROM_MIN} (min ${FROM_MIN}, max ${FROM_MAX}); kind off_duty; no side scroll; controls >= 44 px`,
      `button ${hasButton}, hint "${hint}", form ${form}, first ${firstValue} (min ${firstMin}, max ${firstMax}), kind ${kind}, fits ${fits}, heights ${JSON.stringify(sizes)}`,
      hasButton && hint === REQUEST_HINT && form && firstValue === FROM_MIN && firstMin === FROM_MIN && firstMax === FROM_MAX && kind === 'off_duty' && fits && tall(sizes),
      await shot(dp, 'D1'))
    if (!form) return

    await inputs.nth(0).fill(shift(FROM_MIN, -1))
    await dp.waitForTimeout(250)
    const early = await dp.locator(`${CARD} form.time-off-form button[type="submit"]`).isDisabled()
    const sentEarly = state.calls.request.length
    await inputs.nth(0).fill(FROM)
    await inputs.nth(1).fill(TO)
    await dp.locator(`${CARD} form.time-off-form select`).selectOption('vacation')
    await dp.waitForTimeout(250)
    const ready = await dp.locator(`${CARD} form.time-off-form button[type="submit"]`).isEnabled()
    await dp.locator(`${CARD} form.time-off-form button[type="submit"]`).tap()
    const sent = await until(() => state.calls.request.length === 1, 5000)
    const noted = await appears(dp, `${CARD} .time-off-note`, 6000)
    const note = noted ? await text(dp, `${CARD} .time-off-note`) : ''
    await dp.waitForTimeout(400)
    const waiting = requestRow(dp, RANGE)
    const waitingText = (await waiting.first().textContent({ timeout: 3000 }).catch(() => '') || '').replace(/\s+/g, ' ').trim()
    const cancelBtn = await waiting.first().locator('button', { hasText: 'Cancel request' }).isVisible().catch(() => false)
    const formGone = !(await visible(dp, `${CARD} form.time-off-form`))
    const body = state.calls.request[0]
    const bodyOk = !!body && JSON.stringify(Object.keys(body).sort()) === '["from","kind","to"]' && body.from === FROM && body.to === TO && body.kind === 'vacation'
    record('D2', 'A date before the limit cannot be sent; a real request sends only { kind, from, to }',
      `Send disabled and nothing sent for ${shift(FROM_MIN, -1)}; then one POST {kind: vacation, from ${FROM}, to ${TO}}; note "${SENT_NOTE}"; row "Waiting for approval" with Cancel request; form closed`,
      `disabled early ${early} (requests sent ${sentEarly}), send enabled ${ready}, POSTs ${state.calls.request.length} body ${JSON.stringify(body)}, note "${note}", row "${waitingText}", cancel ${cancelBtn}, form closed ${formGone}`,
      early && sentEarly === 0 && ready && sent && bodyOk && note === SENT_NOTE && waitingText.includes('Waiting for approval') && waitingText.includes('Vacation') && cancelBtn && formGone,
      await shot(dp, 'D2'))
    if (!sent) return

    const staff = await openPage(browser, STAFF_PHONE, DISPATCHER, state, '/notifications')
    try {
      const sp = staff.page
      const shown = await appears(sp, '.notif-item', 15000)
      const item = notice(sp, RANGE)
      const title = shown ? (await item.locator('.notif-title').textContent({ timeout: 3000 }).catch(() => '') || '').trim() : ''
      const approve = item.locator('.notif-act', { hasText: 'Approve' })
      const decline = item.locator('.notif-act', { hasText: 'Decline' })
      const buttons = (await approve.count()) === 1 && (await decline.count()) === 1
      const sizes = buttons ? [Math.round((await approve.boundingBox()).height), Math.round((await decline.boundingBox()).height)] : []
      await shot(sp, 'D3-before')
      if (buttons) await approve.click()
      const done = await appears(sp, '.notif-decision', 6000)
      const decision = done ? (await item.locator('.notif-decision').textContent({ timeout: 3000 }).catch(() => '') || '').trim() : ''
      const gone = (await item.locator('.notif-act').count()) === 0
      const call = state.calls.approve[0]
      record('D3', 'The notice has Approve and Decline; Approve sends an empty body and the notice says who approved',
        `title "Time off request: ${DRIVER.driverName} (${RANGE})"; 2 buttons >= 44 px; one approve POST {} for ${state.rows[0].id}; "Approved by ${DISPATCHER.username}"; no buttons left`,
        `title "${title}", buttons ${buttons}, heights ${JSON.stringify(sizes)}, approve POSTs ${state.calls.approve.length} ${JSON.stringify(call)}, decision "${decision}", buttons gone ${gone}`,
        title === `Time off request: ${DRIVER.driverName} (${RANGE})` && buttons && tall(sizes) && state.calls.approve.length === 1 && call.id === state.rows[0].id
          && JSON.stringify(call.body) === '{}' && decision === `Approved by ${DISPATCHER.username}` && gone,
        await shot(sp, 'D3'))
    } finally {
      await staff.ctx.close()
    }

    await dp.reload({ waitUntil: 'domcontentloaded' })
    const again = await openKit(dp)
    await dp.waitForTimeout(500)
    const upcoming = requestRow(dp, RANGE)
    const upcomingText = again ? (await upcoming.first().textContent({ timeout: 3000 }).catch(() => '') || '').replace(/\s+/g, ' ').trim() : ''
    const stillRequest = again && (await visible(dp, `${CARD} .time-off-subtitle`))
    const cancelLeft = again && (await dp.locator(`${CARD} button`, { hasText: 'Cancel request' }).count()) > 0
    record('D4', 'After the approval the driver sees Upcoming time off, no request row',
      `"${RANGE}" listed as Upcoming; no "Your requests" heading; no Cancel request`,
      `row "${upcomingText}", requests heading ${stillRequest}, cancel ${cancelLeft}`,
      again && upcomingText.includes(RANGE) && upcomingText.includes('Upcoming') && !upcomingText.includes('Waiting') && !stillRequest && !cancelLeft,
      await shot(dp, 'D4'))
  } finally {
    await driver.ctx.close()
  }
}

// ---------------------------------------------------------------- "Approve anyway" over loads the driver already has
async function approveAnywayFlow(browser) {
  const FROM = shift(TODAY, 12)
  const TO = shift(FROM, 1)
  const RANGE = rangeText(FROM, TO)
  const loads = [{ loadId: 'QA-LOAD-1001', from: FROM, to: shift(FROM, 1) }]
  const state = freshState({ loads })
  addRow(state, { from: FROM, to: TO, kind: 'vacation', request: 'waiting', source: 'driver' })
  const staff = await openPage(browser, STAFF_DESKTOP, DISPATCHER, state, '/notifications')
  try {
    const sp = staff.page
    const shown = await appears(sp, '.notif-item', 15000)
    const item = notice(sp, RANGE)
    if (shown) await item.locator('.notif-act', { hasText: 'Approve' }).click()
    const modal = shown && await appears(sp, '.confirm-dialog', 6000)
    const heading = modal ? await text(sp, '.confirm-dialog h3') : ''
    const message = modal ? await text(sp, '.confirm-dialog p') : ''
    await shot(sp, 'D5-ask')
    if (modal) await sp.locator('.confirm-dialog button', { hasText: 'Keep waiting' }).click()
    const closed = modal && await disappears(sp, '.confirm-dialog', 3000)
    await sp.waitForTimeout(400)
    const postsAfterKeep = state.calls.approve.length
    const stillButtons = (await item.locator('.notif-act', { hasText: 'Approve' }).count()) === 1
    if (stillButtons) await item.locator('.notif-act', { hasText: 'Approve' }).click()
    const again = stillButtons && await appears(sp, '.confirm-dialog', 6000)
    if (again) await sp.locator('.confirm-dialog button', { hasText: 'Approve anyway' }).click()
    const done = again && await appears(sp, '.notif-decision', 6000)
    const decision = done ? (await item.locator('.notif-decision').textContent({ timeout: 3000 }).catch(() => '') || '').trim() : ''
    const last = state.calls.approve[state.calls.approve.length - 1]
    const echoed = !!last && !!last.body && JSON.stringify(last.body.confirmLoads) === JSON.stringify(loads)
    record('D5', 'Over the driver\'s loads: Approve asks, Keep waiting sends nothing, Approve anyway echoes the loads',
      `modal "This driver has loads on these days" naming QA-LOAD-1001; Keep waiting: 1 POST so far (the first, refused with 409), buttons still there; Approve again: a 2nd refused POST, then Approve anyway: a 3rd POST with confirmLoads ${JSON.stringify(loads)}; "Approved by ${DISPATCHER.username}"`,
      `modal ${modal} "${heading}" / "${message}", closed ${closed}, POSTs after Keep waiting ${postsAfterKeep}, buttons ${stillButtons}, asked again ${again}, POSTs ${state.calls.approve.length}, confirmLoads echoed ${echoed}, decision "${decision}"`,
      modal && heading === 'This driver has loads on these days' && message.includes('QA-LOAD-1001') && closed && postsAfterKeep === 1 && stillButtons
        && again && state.calls.approve.length === 3 && echoed && decision === `Approved by ${DISPATCHER.username}`,
      await shot(sp, 'D5'))
  } finally {
    await staff.ctx.close()
  }
}

// ---------------------------------------------------------------- Decline, and the card's declined and waiting states
async function declineFlow(browser) {
  const state = freshState()
  const A = { from: shift(TODAY, 10), to: shift(TODAY, 11) }
  const B = { from: shift(TODAY, 20), to: shift(TODAY, 22) }
  const C = { from: shift(TODAY, 30), to: shift(TODAY, 31) }
  addRow(state, { ...A, kind: 'other', request: 'waiting', source: 'driver' })
  addRow(state, { ...B, kind: 'off_duty', request: 'waiting', source: 'driver' })
  addRow(state, { ...C, kind: 'vacation', request: 'approved', source: 'staff', decidedBy: null })
  const RA = rangeText(A.from, A.to)
  const RB = rangeText(B.from, B.to)
  const RC = rangeText(C.from, C.to)

  const staff = await openPage(browser, STAFF_PHONE, DISPATCHER, state, '/notifications')
  try {
    const sp = staff.page
    const shown = await appears(sp, '.notif-item', 15000)
    const item = notice(sp, RA)
    if (shown) await item.locator('.notif-act', { hasText: 'Decline' }).click()
    const done = shown && await appears(sp, '.notif-decision', 6000)
    const decision = done ? (await item.locator('.notif-decision').textContent({ timeout: 3000 }).catch(() => '') || '').trim() : ''
    const other = (await notice(sp, RB).locator('.notif-act').count()) === 2
    record('D6a', 'Decline: one POST, the notice says who declined, the other request is untouched',
      `one decline POST for the first request, no body; "Declined by ${DISPATCHER.username}"; the other notice keeps both buttons`,
      `declines ${state.calls.decline.length} ${JSON.stringify(state.calls.decline[0])}, decision "${decision}", other notice buttons ${other}`,
      state.calls.decline.length === 1 && state.calls.decline[0].id === state.rows[0].id && decision === `Declined by ${DISPATCHER.username}` && other,
      await shot(sp, 'D6a'))
  } finally {
    await staff.ctx.close()
  }

  const driver = await openPage(browser, PHONE, DRIVER, state, '/driver')
  try {
    const dp = driver.page
    const card = await openKit(dp)
    await dp.waitForTimeout(500)
    const rowText = async (range) => card ? (await requestRow(dp, range).first().textContent({ timeout: 3000 }).catch(() => '') || '').replace(/\s+/g, ' ').trim() : ''
    const declined = await rowText(RA)
    const waiting = await rowText(RB)
    const approved = await rowText(RC)
    const declinedCancel = card && (await requestRow(dp, RA).first().locator('button', { hasText: 'Cancel request' }).count()) > 0
    const waitingCancel = card && (await requestRow(dp, RB).first().locator('button', { hasText: 'Cancel request' }).count()) > 0
    const order = card ? (await dp.locator(`${CARD} .time-off-subtitle ~ ul .time-off-range`).allTextContents()).map((t) => t.trim()) : []
    record('D6b', 'The card\'s states: declined, waiting, and approved time off',
      `"${RA}" Not approved. Message dispatch. (no Cancel); "${RB}" Waiting for approval (Cancel request); "${RC}" Upcoming under My time off; requests in order of first day`,
      `declined "${declined}" cancel ${declinedCancel}; waiting "${waiting}" cancel ${waitingCancel}; approved "${approved}"; request order ${JSON.stringify(order)}`,
      card && declined.includes('Not approved. Message dispatch.') && !declined.includes('Waiting') && !declinedCancel && waiting.includes('Waiting for approval') && waitingCancel
        && approved.includes('Upcoming') && JSON.stringify(order) === JSON.stringify([RA, RB]),
      await shot(dp, 'D6b'))
    if (!card || !waitingCancel) return

    await requestRow(dp, RB).first().locator('button', { hasText: 'Cancel request' }).tap()
    const noted = await appears(dp, `${CARD} .time-off-note`, 6000)
    const note = noted ? await text(dp, `${CARD} .time-off-note`) : ''
    await dp.waitForTimeout(500)
    const rowGone = (await requestRow(dp, RB).count()) === 0 || !(await requestRow(dp, RB).first().isVisible().catch(() => false))
    record('D6c', 'Cancel request withdraws a waiting request',
      `one cancel POST for the second request; note "Request for ${RB} withdrawn."; the row gone; the declined row still listed`,
      `cancels ${JSON.stringify(state.calls.cancel)}, note "${note}", row gone ${rowGone}, declined row listed ${(await requestRow(dp, RA).count()) > 0}`,
      state.calls.cancel.length === 1 && state.calls.cancel[0].id === state.rows[1].id && note === `Request for ${RB} withdrawn.` && rowGone && (await requestRow(dp, RA).count()) > 0,
      await shot(dp, 'D6c'))
  } finally {
    await driver.ctx.close()
  }
}

// ---------------------------------------------------------------- the office panel
async function openFleetDialog(page) {
  await page.locator('[role="tab"]', { hasText: 'Fleet & Drivers' }).first().click({ timeout: 15000 })
  await page.locator('.fleet-card', { hasText: DRIVER.driverName }).first().click({ timeout: 8000 })
}
const PANEL = 'section.avail'
const WAITING_LIST = `${PANEL} ul[aria-label="Waiting for approval"]`
const LIVE_LIST = `${PANEL} > ul.avail-list:not([aria-label])`
const panelText = async (loc) => ((await loc.first().textContent({ timeout: 3000 }).catch(() => '')) || '').replace(/\s+/g, ' ').trim()

async function panelRun(browser, size) {
  const state = freshState()
  const A = { from: shift(TODAY, 7), to: shift(TODAY, 8) }
  const B = { from: shift(TODAY, 20), to: shift(TODAY, 20) }
  const C = { from: shift(TODAY, 30), to: shift(TODAY, 32) }
  const D = { from: shift(TODAY, 40), to: shift(TODAY, 41) }
  addRow(state, { ...A, kind: 'vacation', request: 'waiting', source: 'driver' })
  addRow(state, { ...B, kind: 'off_duty', request: 'waiting', source: 'driver' })
  addRow(state, { ...C, kind: 'other', request: 'declined', source: 'driver', decidedBy: 'qa-other-dispatcher' })
  addRow(state, { ...D, kind: 'vacation', request: 'approved', source: 'staff' })
  const RA = rangeText(A.from, A.to)
  const RB = rangeText(B.from, B.to)
  const RC = rangeText(C.from, C.to)
  const RD = rangeText(D.from, D.to)
  const { ctx, page } = await openPage(browser, size, DISPATCHER, state, '/dashboard')
  try {
    let opened = false
    try { await openFleetDialog(page); opened = true } catch { opened = false }
    const panel = opened && await appears(page, WAITING_LIST, 10000)
    await page.waitForTimeout(400)
    const items = page.locator(`${WAITING_LIST} li`)
    const count = panel ? await items.count() : 0
    const firstText = panel ? await panelText(items.nth(0)) : ''
    const secondText = panel ? await panelText(items.nth(1)) : ''
    const liveText = panel ? await panelText(page.locator(`${LIVE_LIST} li`)) : ''
    const summary = panel ? await panelText(page.locator(`${PANEL} details.avail-past summary`)) : ''
    if (panel) await page.locator(WAITING_LIST).first().scrollIntoViewIfNeeded().catch(() => {})
    record(`D7a-${size.tag}`, 'The panel lists waiting requests first, then live time off, then past and declined',
      `two waiting (${RA} first, then ${RB}) "Waiting for approval", "Asked by the driver", Approve and Decline; live: ${RD} Upcoming, no "Asked by"; summary "Past, declined and cancelled (1)"`,
      panel ? `waiting ${count}: "${firstText}" / "${secondText}"; live "${liveText}"; summary "${summary}"` : (opened ? 'no waiting list' : 'the dialog did not open'),
      panel && count === 2 && firstText.includes(RA) && firstText.includes('Waiting for approval') && firstText.includes('Asked by the driver') && firstText.includes('Approve') && firstText.includes('Decline')
        && secondText.includes(RB) && liveText.includes(RD) && liveText.includes('Upcoming') && !liveText.includes('Asked by') && summary === 'Past, declined and cancelled (1)',
      await shot(page, `D7a-${size.tag}`))
    if (!panel) return

    await items.nth(0).locator('button', { hasText: 'Approve' }).click()
    const moved = await until(() => state.calls.approve.length === 1, 5000)
    await page.waitForTimeout(800)
    const waitingAfter = await page.locator(`${WAITING_LIST} li`).count()
    const liveAfter = await panelText(page.locator(`${LIVE_LIST}`))
    const call = state.calls.approve[0]
    record(`D7b-${size.tag}`, 'Approve in the panel: one POST, the row moves to live time off',
      `one approve POST {} for the first request; waiting list 1 row; live list has ${RA} "Asked by the driver, approved by ${DISPATCHER.username}"`,
      `approves ${state.calls.approve.length} ${JSON.stringify(call)}, waiting rows ${waitingAfter}, live "${liveAfter}"`,
      moved && call.id === state.rows[0].id && JSON.stringify(call.body) === '{}' && waitingAfter === 1 && liveAfter.includes(RA)
        && liveAfter.includes(`Asked by the driver, approved by ${DISPATCHER.username}`),
      await shot(page, `D7b-${size.tag}`))

    await page.locator(`${WAITING_LIST} li`).first().locator('button', { hasText: 'Decline' }).click()
    const declined = await until(() => state.calls.decline.length === 1, 5000)
    await page.waitForTimeout(800)
    const listGone = await staysAway(page, WAITING_LIST, 1500)
    const summaryAfter = await panelText(page.locator(`${PANEL} details.avail-past summary`))
    await page.locator(`${PANEL} details.avail-past summary`).first().click()
    await page.waitForTimeout(300)
    const pastText = await panelText(page.locator(`${PANEL} details.avail-past`))
    record(`D7c-${size.tag}`, 'Decline in the panel: one POST, the row moves to the past list as Declined',
      `one decline POST for ${RB}; no waiting list; summary "Past, declined and cancelled (2)"; the past list has ${RB} and ${RC} Declined, "Asked by the driver, declined by ..."`,
      `declines ${state.calls.decline.length} ${JSON.stringify(state.calls.decline[0])}, waiting list gone ${listGone}, summary "${summaryAfter}", past "${pastText}"`,
      declined && state.calls.decline[0].id === state.rows[1].id && listGone && summaryAfter === 'Past, declined and cancelled (2)' && pastText.includes(RB) && pastText.includes(RC)
        && pastText.includes('Declined') && pastText.includes(`Asked by the driver, declined by ${DISPATCHER.username}`),
      await shot(page, `D7c-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- the flag off
async function flagOffRun(browser) {
  // The time-off screen off: the payload has no `timeOff`, so no card at all.
  const none = freshState({ requestsOn: false, screenOn: false })
  const a = await openPage(browser, PHONE, DRIVER, none, '/driver')
  try {
    const kit = await a.page.locator('.van-tabbar-item', { hasText: 'Kit' }).first().tap().then(() => true, () => false)
    await a.page.waitForTimeout(2500)
    const card = await visible(a.page, CARD)
    const button = (await a.page.locator('button', { hasText: 'Request days off' }).count()) > 0
    record('D8a', 'The flag off, screen off: no card and no button',
      'Kit tab opens; no "My time off" card; no "Request days off"; no request sent',
      `kit ${kit}, card ${card}, button ${button}, requests sent ${none.calls.request.length}`,
      kit && !card && !button && none.calls.request.length === 0, await shot(a.page, 'D8a'))
  } finally {
    await a.ctx.close()
  }

  // Only the requests off: the card of recorded time off, as before.
  const recorded = freshState({ requestsOn: false })
  addRow(recorded, { from: shift(TODAY, 15), to: shift(TODAY, 16), kind: 'vacation', request: 'approved', source: 'staff' })
  const b = await openPage(browser, PHONE, DRIVER, recorded, '/driver')
  try {
    const card = await openKit(b.page)
    await b.page.waitForTimeout(800)
    const hint = card ? await text(b.page, `${CARD} .time-off-hint`) : ''
    const button = (await b.page.locator('button', { hasText: 'Request days off' }).count()) > 0
    const form = await visible(b.page, `${CARD} form.time-off-form`)
    const heading = await visible(b.page, `${CARD} .time-off-subtitle`)
    const listed = card ? await text(b.page, `${CARD} .time-off-list`) : ''
    record('D8b', 'Requests off, screen on: the card is read-only',
      `card shown with the recorded time off; hint "${RECORDED_HINT}"; no button, no form, no "Your requests"`,
      `card ${card}, hint "${hint}", button ${button}, form ${form}, heading ${heading}, list "${listed}"`,
      card && hint === RECORDED_HINT && !button && !form && !heading && listed.includes(rangeText(shift(TODAY, 15), shift(TODAY, 16))),
      await shot(b.page, 'D8b'))
  } finally {
    await b.ctx.close()
  }

  // The office panel with the requests off: no request keys, so no waiting list and no Approve.
  const off = freshState({ requestsOn: false })
  addRow(off, { from: shift(TODAY, 15), to: shift(TODAY, 16), kind: 'vacation', request: 'approved', source: 'staff' })
  const c = await openPage(browser, STAFF_DESKTOP, DISPATCHER, off, '/dashboard')
  try {
    let opened = false
    try { await openFleetDialog(c.page); opened = true } catch { opened = false }
    const panel = opened && await appears(c.page, PANEL, 10000)
    await c.page.waitForTimeout(800)
    const live = panel ? await panelText(c.page.locator(`${LIVE_LIST} li`)) : ''
    const waitingList = await visible(c.page, WAITING_LIST)
    const approve = (await c.page.locator(`${PANEL} button`, { hasText: 'Approve' }).count()) > 0
    const asked = live.includes('Asked by')
    record('D8c', 'Requests off: the office panel has no waiting list and no Approve',
      'panel shown with the recorded row; no waiting list; no Approve button; no "Asked by"; no request route called',
      `panel ${panel}, row "${live}", waiting list ${waitingList}, approve ${approve}, asked-by ${asked}, flag-off hits ${off.flagOffHits}`,
      panel && live.includes('Upcoming') && !waitingList && !approve && !asked && off.flagOffHits === 0,
      await shot(c.page, 'D8c'))
  } finally {
    await c.ctx.close()
  }
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve) })
  console.log(`driver-day-off-requests: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    await requestFlow(browser)
    await approveAnywayFlow(browser)
    await declineFlow(browser)
    await panelRun(browser, STAFF_DESKTOP)
    await panelRun(browser, STAFF_PHONE)
    await flagOffRun(browser)
  } finally {
    await browser.close()
    server.close()
  }

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const md2 = [
    `# Day-off requests check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Other writes sent by the page (not part of the verdict): ${otherWrites.length ? otherWrites.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, md2, { mode: 0o600 })
  console.log(`driver-day-off-requests: ${rows.filter((r) => r.verdict === 'PASS').length}/${rows.length} PASS; results ${resultsFile}; screenshots ${shotDir()}`)
  if (pageErrors.length) console.log(`driver-day-off-requests: page errors: ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`driver-day-off-requests: aborted: ${e.stack || e}`)
  process.exit(1)
})
