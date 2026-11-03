#!/usr/bin/env node
// LogisX — emergency contacts after onboarding, on made-up data only: the driver's
// sign-in prompt and Kit card, and the office panel (EMERGENCY_CONTACTS_ENABLED).
//
// As a made-up Driver ("Casey Example", user 90102, fully onboarded, no contacts yet),
// at 375x667 and 390x664 (a phone, touch):
//   P1  the prompt "Add your emergency contacts" shows after the first load, parked
//   P2  "Remind me later" hides it; it writes nothing to the browser's storage and does
//       not come back while the app stays open
//   P3  a reload (a new app start) shows it again
//   P4  "Add now" opens the form (the list read from the driver's own route); two
//       contacts saved; the prompt does not come back
//   P5  the Kit tab's card lists both, each number a tel: link from the stored number
//   P6  a moving truck (a fresh ELD fix at 55 mph): no prompt
//   P7  the flag off (no counts in the payload): no prompt, no Kit card
// As made-up staff, at 1280x800 and 390x844:
//   P8  a Super Admin, the Drivers page detail: the panel lists the contacts with tel:
//       links; Edit, change one, Save: one PUT to the staff route with both ids
//   P9  a Dispatcher, the dashboard's Fleet & Drivers dialog: the panel finds the driver
//       by name and lists the contacts
//   P10 the flag off: the staff route answers 404 FEATURE_OFF, no panel is shown, and a
//       second dialog on the same page load asks nothing
// No office page ever calls the driver's own route. Step names carry the size.
//
// Like driver-emergency-contacts.mjs this boots no server.js, opens no database, reads
// no settings file or key and signs nobody in. It serves the checkout's built
// client/dist from its own static server on 127.0.0.1 (E2E_PORT, default 3183) and
// answers every /api request in the browser with made-up fixtures; the contacts PUTs
// are judged by lib/emergency-contacts.js in this process. Every request to another
// host is aborted, the socket included.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   node scripts/e2e/driver-emergency-contacts-profile.mjs
//
// Before and after: origin/main's build (OUT_TAG=main) fails P1 (no prompt), P5, P8 and
// P9; the branch's build (OUT_TAG=branch) passes every row.
//
// Env: E2E_PORT (default 3183; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "driver-emergency-contacts-profile"), HEADED=1, CHROME_PATH,
// E2E_WORK_DIR, SHOT_DIR (an absolute folder outside the checkout; default
// <work dir>/shots/<OUT_TAG>). Output: the screenshots and <work dir>/results-<OUT_TAG>.md.
// Exit 0 only when every row PASSes.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import paths from './paths.cjs'

const require = createRequire(import.meta.url)
const rules = require(path.join(paths.REPO, 'lib', 'emergency-contacts.js'))

const PORT = Number(process.env.E2E_PORT || 3183)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'driver-emergency-contacts-profile').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const PHONES = [
  { tag: '375x667', viewport: { width: 375, height: 667 } },
  { tag: '390x664', viewport: { width: 390, height: 664 } },
]
const STAFF_SIZES = [
  { tag: '1280x800', viewport: { width: 1280, height: 800 } },
  { tag: '390x844', viewport: { width: 390, height: 844 } },
]

function die(msg) {
  console.error(`driver-emergency-contacts-profile: ${msg}`)
  process.exit(2)
}

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (PORT === 3000 || PORT === 5173) die(`refusing port ${PORT}: 3000 is production's port on the VPS and 5173 is Vite's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm run build:client\` first`)
if (process.env.SHOT_DIR) {
  const dir = process.env.SHOT_DIR
  if (!path.isAbsolute(dir)) die('SHOT_DIR must be an absolute path')
  const rel = path.relative(paths.REPO, path.resolve(dir))
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) die(`SHOT_DIR ${dir} is inside the checkout: pick a folder outside it`)
}

// ---------------------------------------------------------------- made-up fixtures
const DRIVER = { id: 90102, username: 'qa-contacts-driver', role: 'Driver', driverName: 'Casey Example', email: '', fullName: 'Casey Example', companyName: '', mustChangePassword: false }
const SUPER_ADMIN = { id: 90101, username: 'qa-contacts-superadmin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Contacts Super Admin', companyName: '', mustChangePassword: false }
const DISPATCHER = { id: 90201, username: 'qa-contacts-dispatcher', role: 'Dispatcher', driverName: '', email: '', fullName: 'QA Contacts Dispatcher', companyName: '', mustChangePassword: false }
const DIRECTORY_ID = 501
const FIRST = { name: 'Quinn Example', relationship: 'Spouse', phone: '(202) 555-0143' }
const SECOND = { name: 'Jordan Placeholder', relationship: 'Friend', phone: '+44 20 7946 0958' }
const ME_URL = '/api/driver/me/emergency-contacts'
const STAFF_URL = `/api/drivers-directory/${DIRECTORY_ID}/emergency-contacts`
const DAY = 24 * 60 * 60 * 1000

// What the "server" holds: one driver's contacts, the flag, the truck's motion.
function freshState({ flag = true, moving = false, stored = [] } = {}) {
  return { flag, moving, stored: stored.map((r) => ({ ...r })), nextId: 7101, meGets: 0, staffGets: 0, puts: [], staffPuts: [] }
}
const seeded = () => [
  { id: 7001, position: 1, contact_name: FIRST.name, relationship: FIRST.relationship, contact_phone: '+12025550143' },
  { id: 7002, position: 2, contact_name: SECOND.name, relationship: SECOND.relationship, contact_phone: '+442079460958' },
]

function listBody(state) {
  const contacts = state.stored.map((r) => rules.contactView(r))
  return { contacts, minimum: rules.MIN_CONTACTS, maximum: rules.MAX_CONTACTS, complete: contacts.length >= rules.MIN_CONTACTS }
}

function driverPayload(state) {
  return {
    loads: [],
    headers: { jobTracking: [], carrierDB: [] },
    onboarding: { user_id: DRIVER.id, status: 'fully_onboarded', onboarded_at: new Date(Date.now() - 30 * DAY).toISOString(), documents: [], totalDocs: 5 },
    driverInfo: null, truck: null, messages: [], notifications: [], expenses: [], drivers: [], invoices: [], sharedDocuments: [], truckDocuments: [],
    ...(state.flag ? { emergencyContacts: { required: rules.MIN_CONTACTS, maximum: rules.MAX_CONTACTS, onFile: state.stored.length } } : {}),
  }
}

function position(state) {
  return {
    ok: true, unit: 'QA-1',
    position: {
      latitude: 33.75, longitude: -84.39, speed: state.moving ? 24.6 : 0, speedMph: state.moving ? 55 : 0, heading: 90,
      timestamp: new Date(Date.now() - 4000).toISOString(), lastPingAge: 4000, source: 'routemate', fuelPct: null,
      movement: state.moving ? 'moving' : 'stopped', stoppedSinceMs: state.moving ? null : Date.now() - 10 * 60000,
    },
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
const DASHBOARD = {
  timestamp: new Date().toISOString(),
  kpis: { activeLoads: 0, unassignedLoads: 0, completedThisWeek: 0, completedThisMonth: 0, fleetUtilization: { assigned: 0, total: 1 }, revenue: { total: 0, paid: 0, pending: 0 } },
  unassignedJobs: [], jobTrackingHeaders: [], completedHeaders: [], activeJobs: [], completedJobs: [],
  fleet: [{ Driver: DRIVER.driverName, Truck: 'QA-1', Status: 'Available', CompletedLoads: 3, CurrentLoad: '', Phone: '(512) 555-0100', QueueCount: 0, QueuedLoadIds: [] }],
  drivers: [DRIVER.driverName], driverQueues: {},
}

const FEATURE_OFF = { status: 404, body: { error: 'Not found', code: 'FEATURE_OFF' } }

function answerGet(who, state, pathname) {
  if (pathname === '/api/auth/session') return { status: 200, body: { authenticated: true, user: who, appTimeZone: 'America/New_York' } }
  if (pathname === ME_URL) {
    state.meGets++
    if (!state.flag) return FEATURE_OFF
    return who.role === 'Driver' ? { status: 200, body: listBody(state) } : { status: 403, body: { error: 'Forbidden' } }
  }
  if (pathname === STAFF_URL) {
    state.staffGets++
    if (!state.flag) return FEATURE_OFF
    if (who.role === 'Driver') return { status: 403, body: { error: 'Forbidden' } }
    return { status: 200, body: { linked: true, userId: DRIVER.id, ...listBody(state) } }
  }
  if (who.role === 'Driver') {
    if (pathname === `/api/driver/${encodeURIComponent(DRIVER.driverName)}`) return { status: 200, body: driverPayload(state) }
    if (pathname === '/api/driver/position') return { status: 200, body: position(state) }
    if (pathname === '/api/fuel/range') return { status: 200, body: { ok: false } }
    return null
  }
  if (pathname === '/api/drivers-directory') return { status: 200, body: DIRECTORY }
  if (pathname === `/api/drivers-directory/${DIRECTORY_ID}/documents`) return { status: 200, body: { documents: [], drugTest: null, linked: true, ssn: null, application: null } }
  if (pathname === '/api/dashboard') return { status: 200, body: DASHBOARD }
  if (pathname === '/api/load-ratings/averages') return { status: 200, body: { averages: {} } }
  if (pathname === '/api/truck-assignments') return { status: 200, body: { assignments: [] } }
  if (pathname === '/api/config/maps-key') return { status: 200, body: { key: 'qa-contacts-no-key' } }
  if (pathname === '/api/locations/latest') return { status: 200, body: { locations: [] } }
  return null
}

// A PUT as the server answers it: its own validation, its ids kept.
function answerPut(state, raw, staff) {
  let body = null
  try { body = JSON.parse(raw || 'null') } catch { body = null }
  ;(staff ? state.staffPuts : state.puts).push(body)
  if (!state.flag) return FEATURE_OFF
  const v = rules.validateContactList(body)
  if (!v.ok) return { status: v.status, body: { error: v.error, code: v.code, ...(v.index === undefined ? {} : { index: v.index }) } }
  const owned = new Set(state.stored.map((r) => r.id))
  if (v.list.some((c) => c.id !== null && !owned.has(c.id))) return { status: 409, body: { error: 'Not on this list', code: 'CONTACT_NOT_FOUND' } }
  state.stored = v.list.map((c) => ({ id: c.id === null ? state.nextId++ : c.id, position: c.position, contact_name: c.name, relationship: c.relationship, contact_phone: c.phone }))
  return { status: 200, body: staff ? { linked: true, userId: DRIVER.id, ...listBody(state) } : listBody(state) }
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the emergency contacts profile check"}')
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
    if (req.method() === 'PUT' && (u.pathname === ME_URL || u.pathname === STAFF_URL)) {
      const out = answerPut(state, req.postData(), u.pathname === STAFF_URL)
      return route.fulfill({ status: out.status, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out.body) })
    }
    if (req.method() !== 'GET') {
      otherWrites.push(`${size.tag} ${req.method()} ${u.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    const out = answerGet(who, state, u.pathname)
    if (out === null) unanswered.add(u.pathname)
    return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', body: JSON.stringify(out ? out.body : {}) })
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
// Every key in the page's localStorage and sessionStorage.
const storageKeys = (page) => page.evaluate(() => {
  const keys = (s) => { try { return Object.keys(s).sort() } catch { return [] } }
  return { local: keys(window.localStorage), session: keys(window.sessionStorage) }
})
async function fillRow(page, i, c) {
  await page.locator(`input[name="ec-name-${i}"]`).fill(c.name)
  await page.locator(`input[name="ec-relationship-${i}"]`).fill(c.relationship)
  await page.locator(`input[name="ec-phone-${i}"]`).fill(c.phone)
}
const PROMPT = '[data-testid="ec-prompt"]'
// The prompt waits a few seconds after the first load (the first ELD read), so allow 12.
const PROMPT_WAIT_MS = 12000

// ---------------------------------------------------------------- the driver
async function driverRun(browser, size) {
  const state = freshState()
  const { ctx, page } = await openPage(browser, size, DRIVER, state, '/driver')
  try {
    const shown = await appears(page, PROMPT, PROMPT_WAIT_MS)
    const title = shown ? await text(page, '#ecq-title') : ''
    record(`P1-${size.tag}`, 'The prompt asks a driver with no contacts', 'prompt shown, "Add your emergency contacts"',
      shown ? `shown, title "${title}"` : `no prompt within ${PROMPT_WAIT_MS / 1000} s`, shown && title === 'Add your emergency contacts', await shot(page, `P1-${size.tag}`))
    if (!shown) return

    const before = await storageKeys(page)
    await page.locator('[data-testid="ec-prompt-later"]').tap()
    let hidden = false
    try { await page.waitForSelector(PROMPT, { state: 'hidden', timeout: 3000 }); hidden = true } catch { hidden = false }
    const after = await storageKeys(page)
    const away = await staysAway(page, PROMPT, 6000)
    record(`P2-${size.tag}`, '"Remind me later" hides it, writes no storage, and it stays away', 'hidden; storage keys unchanged; not back within 6 s',
      `hidden ${hidden}, storage before ${JSON.stringify(before)} after ${JSON.stringify(after)}, stayed away ${away}`,
      hidden && JSON.stringify(before) === JSON.stringify(after) && away, await shot(page, `P2-${size.tag}`))

    await page.reload({ waitUntil: 'domcontentloaded' })
    const again = await appears(page, PROMPT, PROMPT_WAIT_MS)
    record(`P3-${size.tag}`, 'A new app start asks again', 'prompt shown after the reload', again ? 'shown' : 'not shown', again, await shot(page, `P3-${size.tag}`))
    if (!again) return

    const getsBefore = state.meGets
    await page.locator('[data-testid="ec-prompt-add"]').tap()
    const formOpen = await appears(page, '[data-testid="ec-form"]', 5000) && await appears(page, '[data-testid="ec-row"]', 5000)
    if (formOpen) {
      await page.waitForTimeout(350)
      await fillRow(page, 0, FIRST)
      await fillRow(page, 1, SECOND)
      await page.locator('[data-testid="ec-save"]').tap()
    }
    let closed = false
    try { await page.waitForSelector('[data-testid="ec-form"]', { state: 'hidden', timeout: 8000 }); closed = true } catch { closed = false }
    const stayed = await staysAway(page, PROMPT, 5000)
    const sent = state.puts[state.puts.length - 1]
    record(`P4-${size.tag}`, '"Add now" opens the form; two saved; no prompt after', 'form read the list (1 GET); one PUT with both; form closed; no prompt for 5 s',
      `form ${formOpen}, GETs +${state.meGets - getsBefore}, PUTs ${state.puts.length} (${sent && Array.isArray(sent.contacts) ? sent.contacts.length : 0} contacts), closed ${closed}, prompt stayed away ${stayed}`,
      formOpen && state.meGets - getsBefore >= 1 && state.puts.length === 1 && !!sent && sent.contacts.length === 2 && closed && stayed, await shot(page, `P4-${size.tag}`))

    await page.locator('.van-tabbar-item', { hasText: 'Kit' }).first().tap()
    const card = await appears(page, '[data-testid="ec-kit-card"]', 5000)
    await page.waitForTimeout(500)
    const names = card ? await page.locator('[data-testid="ec-kit-row"] .eck-name').allTextContents() : []
    const tels = card ? await page.locator('[data-testid="ec-kit-row"] a.eck-phone').evaluateAll((els) => els.map((e) => e.getAttribute('href'))) : []
    record(`P5-${size.tag}`, 'The Kit card lists the contacts, each number a tap to call', 'two rows; tel:+12025550143 and tel:+442079460958',
      card ? `names ${JSON.stringify(names)}, links ${JSON.stringify(tels)}` : 'no card',
      card && JSON.stringify(names) === JSON.stringify([FIRST.name, SECOND.name]) && JSON.stringify(tels) === JSON.stringify(['tel:+12025550143', 'tel:+442079460958']),
      await shot(page, `P5-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

async function movingRun(browser, size) {
  const state = freshState({ moving: true })
  const { ctx, page } = await openPage(browser, size, DRIVER, state, '/driver')
  try {
    const away = await staysAway(page, PROMPT, PROMPT_WAIT_MS)
    record(`P6-${size.tag}`, 'A moving truck: no prompt', `no prompt within ${PROMPT_WAIT_MS / 1000} s`, away ? 'none' : 'the prompt showed', away, await shot(page, `P6-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

async function flagOffDriverRun(browser, size) {
  const state = freshState({ flag: false })
  const { ctx, page } = await openPage(browser, size, DRIVER, state, '/driver')
  try {
    const away = await staysAway(page, PROMPT, PROMPT_WAIT_MS)
    await page.locator('.van-tabbar-item', { hasText: 'Kit' }).first().tap()
    await page.waitForTimeout(1500)
    const card = await visible(page, '[data-testid="ec-kit-card"]')
    record(`P7-${size.tag}`, 'The flag off: no prompt, no Kit card, no contacts request', 'no prompt; no card; 0 GETs of the driver\'s route',
      `prompt stayed away ${away}, card ${card}, GETs ${state.meGets}`, away && !card && state.meGets === 0, await shot(page, `P7-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- the office
async function superAdminRun(browser, size) {
  const state = freshState({ stored: seeded() })
  const { ctx, page } = await openPage(browser, size, SUPER_ADMIN, state, '/drivers')
  try {
    let opened = false
    try {
      await page.locator('tr.clickable-row', { hasText: DRIVER.driverName }).first().click({ timeout: 15000 })
      opened = true
    } catch { opened = false }
    const panel = opened && await appears(page, '[data-testid="ec-panel"]', 8000)
    await page.waitForTimeout(400)
    const tels = panel ? await page.locator('[data-testid="ec-panel-line"] a.ecp-phone').evaluateAll((els) => els.map((e) => e.getAttribute('href'))) : []
    if (panel) await page.locator('[data-testid="ec-panel"]').first().scrollIntoViewIfNeeded().catch(() => {})
    record(`P8a-${size.tag}`, 'Drivers page detail: the panel lists the contacts', 'panel shown; tel:+12025550143, tel:+442079460958; staff route read once',
      panel ? `links ${JSON.stringify(tels)}, staff GETs ${state.staffGets}` : (opened ? 'no panel' : 'the row did not open'),
      panel && JSON.stringify(tels) === JSON.stringify(['tel:+12025550143', 'tel:+442079460958']) && state.staffGets === 1, await shot(page, `P8a-${size.tag}`))
    if (!panel) return

    await page.locator('[data-testid="ec-panel-edit"]').click()
    const form = await appears(page, '[data-testid="ec-panel-form"]', 3000)
    if (form) {
      await page.locator('input[name="ecp-name-1"]').fill('Jordan Placeholder Jr')
      await page.locator('[data-testid="ec-panel-save"]').click()
    }
    let closed = false
    try { await page.waitForSelector('[data-testid="ec-panel-form"]', { state: 'hidden', timeout: 8000 }); closed = true } catch { closed = false }
    const sent = state.staffPuts[state.staffPuts.length - 1]
    const ids = sent && Array.isArray(sent.contacts) ? sent.contacts.map((c) => c.id) : []
    const shownNames = await page.locator('[data-testid="ec-panel-line"] .ecp-name').allTextContents()
    record(`P8b-${size.tag}`, 'Edit, change one, Save: one PUT to the staff route with both ids', 'one staff PUT [7001, 7002]; form closed; the new name listed; no driver-route request',
      `form ${form}, staff PUTs ${state.staffPuts.length} ids ${JSON.stringify(ids)}, closed ${closed}, names ${JSON.stringify(shownNames)}, driver-route GETs ${state.meGets}, driver-route PUTs ${state.puts.length}`,
      form && state.staffPuts.length === 1 && JSON.stringify(ids) === '[7001,7002]' && closed && shownNames.includes('Jordan Placeholder Jr') && state.meGets === 0 && state.puts.length === 0,
      await shot(page, `P8b-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

async function openFleetDialog(page) {
  await page.locator('[role="tab"]', { hasText: 'Fleet & Drivers' }).first().click({ timeout: 15000 })
  await page.locator('.fleet-card', { hasText: DRIVER.driverName }).first().click({ timeout: 8000 })
}

async function dispatcherRun(browser, size) {
  const state = freshState({ stored: seeded() })
  const { ctx, page } = await openPage(browser, size, DISPATCHER, state, '/dashboard')
  try {
    let opened = false
    try { await openFleetDialog(page); opened = true } catch { opened = false }
    const panel = opened && await appears(page, '[data-testid="ec-panel"]', 8000)
    await page.waitForTimeout(400)
    if (panel) await page.locator('[data-testid="ec-panel"]').first().scrollIntoViewIfNeeded().catch(() => {})
    const tels = panel ? await page.locator('[data-testid="ec-panel-line"] a.ecp-phone').evaluateAll((els) => els.map((e) => e.getAttribute('href'))) : []
    record(`P9-${size.tag}`, 'Fleet & Drivers dialog: the panel finds the driver by name and lists the contacts', 'panel shown; two tel: links; no driver-route request',
      panel ? `links ${JSON.stringify(tels)}, staff GETs ${state.staffGets}, driver-route GETs ${state.meGets}` : (opened ? 'no panel' : 'the dialog did not open'),
      panel && tels.length === 2 && state.meGets === 0, await shot(page, `P9-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

async function flagOffStaffRun(browser, size) {
  const state = freshState({ flag: false, stored: seeded() })
  const { ctx, page } = await openPage(browser, size, DISPATCHER, state, '/dashboard')
  try {
    let opened = false
    try { await openFleetDialog(page); opened = true } catch { opened = false }
    await page.waitForTimeout(2500)
    const panel = await visible(page, '[data-testid="ec-panel"]')
    const firstGets = state.staffGets
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    let reopened = false
    try { await page.locator('.fleet-card', { hasText: DRIVER.driverName }).first().click({ timeout: 5000 }); reopened = true } catch { reopened = false }
    await page.waitForTimeout(2000)
    const panel2 = await visible(page, '[data-testid="ec-panel"]')
    record(`P10-${size.tag}`, 'The flag off: no panel, and one request per page load', 'dialog opened twice; no panel either time; 1 staff GET in all',
      `opened ${opened}/${reopened}, panel ${panel}/${panel2}, staff GETs ${firstGets} then ${state.staffGets}`,
      opened && reopened && !panel && !panel2 && firstGets === 1 && state.staffGets === 1, await shot(page, `P10-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve) })
  console.log(`driver-emergency-contacts-profile: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const size of PHONES) {
      await driverRun(browser, size)
      await movingRun(browser, size)
      await flagOffDriverRun(browser, size)
    }
    for (const size of STAFF_SIZES) {
      await superAdminRun(browser, size)
      await dispatcherRun(browser, size)
      await flagOffStaffRun(browser, size)
    }
  } finally {
    await browser.close()
    server.close()
  }

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const md = [
    `# Emergency contacts profile check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Other writes sent by the page (not part of the verdict): ${otherWrites.length ? otherWrites.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, md, { mode: 0o600 })
  console.log(`driver-emergency-contacts-profile: ${rows.filter((r) => r.verdict === 'PASS').length}/${rows.length} PASS; results ${resultsFile}; screenshots ${shotDir()}`)
  if (pageErrors.length) console.log(`driver-emergency-contacts-profile: page errors: ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`driver-emergency-contacts-profile: aborted: ${e.stack || e}`)
  process.exit(1)
})
