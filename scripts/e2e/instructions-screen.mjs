#!/usr/bin/env node
// LogisX — the rate-con driver-instructions staff screen (plan PR 3), on made-up data only.
//
//   IS1  Dashboard → Active Loads as a Dispatcher: the row's Needs Review badge reads
//        "Driver instructions need a look"; the load's detail shows the Driver
//        instructions section: status, the driver preview, the review reasons in words,
//        the item drivers don't see, and Edit / Mark reviewed / Re-read.
//   IS2  Edit, add a reference holding the deny value, Save: the server refuses it
//        (400 INSTRUCTIONS_CONTENT_NOT_ALLOWED, rule "number", field "references", the
//        value never echoed) and the section says so by the field kind only; nothing
//        is written.
//   IS3  Mark reviewed: status Reviewed, "What the driver sees", no reasons left.
//   IS4  A pending re-issue: "Drivers see now" beside "New reading"; Keep current
//        clears it; a second one, accepted, becomes what drivers see.
//   IS5  Re-read the rate con with no rate con on file: the section's plain message.
//   IS6  390 x 844: one pane (the pending columns stack), no sideways page scroll, the
//        edit form fits.
//   IS7  The flag off: every instructions route answers 404 and the section is not
//        rendered at all.
//
// The instructions routes are PR 2's own code: lib/driver-instructions-runtime.js
// (create() + mount()) on an express app in this process, over an in-memory SQLite
// database, with the flag on and E2E_DRIVER_INSTRUCTIONS_DENY (an invented value) as
// the only deny-list entry. Its sheet readers answer one made-up load ("QA-DI-1001")
// and its two side sheets; no Gemini, Drive or Sheets call is made. Everything else
// is as in phone-layout.mjs: the checkout's built client/dist from a static server on
// 127.0.0.1 (E2E_PORT, default 3182), a made-up Dispatcher session, and every other
// /api request answered in the browser with made-up fixtures; requests to any other
// host are aborted. Use this where a local server can't read a sheet the routes need
// (scripts/e2e/README.md, "The driver instructions section").
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   E2E_DRIVER_INSTRUCTIONS_DENY=T8273641 node scripts/e2e/instructions-screen.mjs
//
// Env: E2E_DRIVER_INSTRUCTIONS_DENY (required, invented), E2E_PORT, OUT_TAG (default
// "instructions-screen"), SHOTS_DIR (default <work dir>/shots/<OUT_TAG>), HEADED=1,
// CHROME_PATH, E2E_WORK_DIR. Output: the screenshots and results-<OUT_TAG>.md in the
// work dir. Exit 0 only when every row PASSes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'
import paths from './paths.cjs'

const require = createRequire(import.meta.url)
const PORT = Number(process.env.E2E_PORT || 3182)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'instructions-screen').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const DENY = String(process.env.E2E_DRIVER_INSTRUCTIONS_DENY || '')
const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 390, height: 844 }

function die(msg) {
  console.error(`instructions-screen: ${msg}`)
  process.exit(2)
}
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (PORT === 3000 || PORT === 5173 || PORT === 3901) die(`refusing port ${PORT}: 3000 is production's port on the VPS, 5173 is Vite's and 3901 the replica's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm run build:client\` first`)
if (!/^\S{5,40}$/.test(DENY)) die('E2E_DRIVER_INSTRUCTIONS_DENY is required: an invented value (e.g. T8273641), never a real one')

const WORK = paths.workDir()
const SHOTS = process.env.SHOTS_DIR ? path.resolve(process.env.SHOTS_DIR) : path.join(WORK, 'shots', OUT_TAG)
fs.mkdirSync(SHOTS, { recursive: true, mode: 0o700 })
const RESULTS = path.join(WORK, `results-${OUT_TAG}.md`)

// ---------------------------------------------------------------- made-up fixtures
const LOAD_ID = 'QA-DI-1001'
const HEADERS = ['Load ID', 'Status', 'Driver', 'Truck', 'Pickup Address', 'Drop-off Address', 'Payment', 'Assigned Date', 'Pickup Info']
const ACTIVE_JOB = {
  _rowIndex: 2,
  'Load ID': LOAD_ID,
  Status: 'Dispatched',
  Driver: 'Pat Example',
  Truck: 'QA-T1',
  'Pickup Address': '100 Example Rd, Memphis, TN 38118',
  'Drop-off Address': '200 Sample Ave, Dallas, TX 75201',
  Payment: '$1,234.00',
  'Assigned Date': '2026-10-21',
  'Pickup Info': 'QA Test Shipper - REF/PU#: QA-PU-1001',
  _pickupStreet: '100 Example Rd',
  _pickupLocation: 'Memphis, TN 38118',
  _dropStreet: '200 Sample Ave',
  _dropLocation: 'Dallas, TX 75201',
}
// An unassigned load with no instructions on file: the runtime gives it no_rate_con.
const UNASSIGNED_JOB = { ...ACTIVE_JOB, _rowIndex: 3, 'Load ID': 'QA-DI-2002', Status: 'Unassigned', Driver: '', Truck: '' }
const SIDE = {
  payments: [['Job ID', 'Payment Amount'], [LOAD_ID, '$1,234.00']],
  jobDetails: [['Load ID', 'Payment'], [LOAD_ID, '$1,234.00']],
}
const DISPATCHER = { id: 90012, username: 'qa-di-dispatcher', role: 'Dispatcher', driverName: '', email: '', fullName: 'QA Instructions Dispatcher', companyName: '', mustChangePassword: false }
const FOOTNOTE = 'From the rate con. Questions: contact dispatch.'
const SEED = {
  v: 1,
  loadRequirements: [
    { category: 'ppe', text: 'QA: hard hat and safety vest on site.', critical: true },
    { category: 'other', text: 'QA: an item with no category, for staff only.', critical: false },
  ],
  stops: [
    { seq: 1, kind: 'pickup', facility: 'QA Test Shipper', place: 'Memphis, TN', references: [{ type: 'pickup_number', label: 'Pickup #', value: 'QA-PU-1001' }], requirements: [{ category: 'seal', text: 'QA: seal the trailer before leaving.', critical: true }], instructions: [{ kind: 'shipper', text: 'QA: check in at the guard shack.' }] },
    { seq: 2, kind: 'delivery', facility: 'QA Test Receiver', place: 'Dallas, TX', references: [{ type: 'delivery_number', label: 'Delivery #', value: 'QA-DL-2002' }], requirements: [], instructions: [{ kind: 'receiver', text: 'QA: unload at door four.' }] },
  ],
  footnote: FOOTNOTE,
}
const PENDING = {
  ...SEED,
  stops: [SEED.stops[0], { ...SEED.stops[1], facility: 'QA Test Receiver North', instructions: [{ kind: 'receiver', text: 'QA: unload at door seven.' }, { kind: 'hours', text: 'QA: receiving closes at three.' }] }],
}

// ---------------------------------------------------------------- PR 2's routes, in-process
const express = paths.appRequire('express')
const Database = paths.appRequire('better-sqlite3')
const runtime = require(path.join(paths.REPO, 'lib', 'driver-instructions-runtime.js'))
const quiet = { warn() {}, error() {}, info() {}, log() {} }

async function startApi(env) {
  const db = new Database(':memory:')
  const audits = []
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpr3-uploads-'))
  const svc = runtime.create({
    db,
    env,
    fetch: async () => { throw new Error('no network in this check') },
    geminiApiKey: '',
    geminiModel: '',
    getDrive: async () => { throw new Error('no Drive in this check') },
    getJobTracking: async () => ({ headers: [...HEADERS], data: [{ ...ACTIVE_JOB }] }),
    getSideSheets: async () => SIDE,
    // The made-up row has no broker or contact column; any such pattern serves.
    brokerWithheldRe: /broker|contact|e-?mail|phone/i,
    ingestionGeminiUnavailableAt: () => 0,
    logAudit: (req, action, entity, id, details) => audits.push({ action, details: String(details || '') }),
    logAuditRefusal: (req, action, entity, id, details, code) => audits.push({ action, details: String(details || ''), code }),
    notifySuperAdmins: () => {},
    sendAdminEmail: () => null,
    uploadsDir: uploads,
    log: quiet,
  })
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use((req, res, next) => { req.session = { user: DISPATCHER }; next() })
  const requireRole = (...roles) => (req, res, next) => (req.session.user && roles.includes(req.session.user.role) ? next() : res.status(403).json({ error: 'Forbidden' }))
  svc.mount(app, { requireRole })
  const server = await new Promise((resolve) => { const s = app.listen(0, HOST, () => resolve(s)) })
  const base = `http://${HOST}:${server.address().port}`
  const close = async () => {
    await new Promise((r) => server.close(() => r()))
    db.close()
    fs.rmSync(uploads, { recursive: true, force: true })
  }
  return { db, svc, audits, base, close }
}

function dashboard(svc) {
  const rows = [{ ...ACTIVE_JOB }]
  const unassigned = [{ ...UNASSIGNED_JOB }]
  svc.annotateDashboardRows({ headers: HEADERS, rows: unassigned })
  svc.annotateDashboardRows({ headers: HEADERS, rows })
  return {
    timestamp: new Date().toISOString(),
    kpis: { activeLoads: 1, unassignedLoads: 0, completedThisWeek: 0, completedThisMonth: 0, fleetUtilization: { assigned: 1, total: 1 }, revenue: { total: 0, paid: 0, pending: 0 } },
    unassignedJobs: unassigned,
    jobTrackingHeaders: HEADERS,
    completedHeaders: HEADERS,
    activeJobs: rows,
    completedJobs: [],
    fleet: [],
    drivers: ['Pat Example'],
    driverQueues: {},
  }
}

function answerGet(pathname, svc) {
  if (pathname === '/api/auth/session') return { authenticated: true, user: DISPATCHER, appTimeZone: 'America/New_York' }
  if (pathname === '/api/dashboard') return dashboard(svc)
  if (pathname === '/api/config/maps-key') return { key: 'qa-instructions-no-key' }
  if (pathname === '/api/locations/latest') return { locations: [] }
  if (pathname.startsWith('/api/documents/')) return { documents: [] }
  if (pathname.startsWith('/api/load-ratings/')) return { rating: 0 }
  if (pathname.startsWith('/api/geocode/load/')) return { originLat: 35.05, originLng: -89.98, destLat: 32.78, destLng: -96.8 }
  return {}
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
    res.end('{"error":"not served by the instructions screen check"}')
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
// The browser's lines about requests this harness aborts on purpose (the socket, other
// hosts): not the app's.
const harnessLine = (l) => /socket\.io/.test(l.text) || /socket\.io/.test(l.url) || (!!l.url && !l.url.startsWith(BASE))
const appErrors = (lines) => lines.filter((l) => l.type === 'error' && !harnessLine(l))
const otherWrites = []
let exitCode = 0
function record(step, title, expected, observed, ok, shot = '') {
  if (!ok) exitCode = 1
  rows.push({ step, title, expected, observed, verdict: ok ? 'PASS' : 'FAIL', shot })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${observed}`)
}
const flags = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')
const allTrue = (o) => Object.values(o).every(Boolean)

async function openPage(browser, api, size) {
  const phone = size.width < 640
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
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
    // The instructions routes: PR 2's runtime answers them.
    if (/^\/api\/loads\/[^/]+\/driver-instructions(\/(review|accept-pending|re-extract))?$/.test(url.pathname)) {
      const resp = await route.fetch({ url: `${api.base}${url.pathname}${url.search}` })
      return route.fulfill({ response: resp })
    }
    if (req.method() !== 'GET') {
      otherWrites.push(`${req.method()} ${url.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answerGet(url.pathname, api.svc)) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.width}px: ${String(e.message || e).slice(0, 200)}`))
  page.on('console', (m) => consoleLines.push({ type: m.type(), text: m.text(), url: String((m.location() && m.location().url) || '') }))
  return { ctx, page }
}

const SECTION = '[data-testid="driver-instructions"]'
// The section can be taller than the dialog's scroll area: for the picture only, the
// viewport grows taller (same width), so the whole section shows; then it is put back.
async function sectionShot(page, name) {
  const file = path.join(SHOTS, `${name}.png`)
  const size = page.viewportSize()
  try {
    await page.setViewportSize({ width: size.width, height: 3000 })
    await page.waitForTimeout(300)
    const sec = page.locator(SECTION)
    await sec.scrollIntoViewIfNeeded()
    await sec.screenshot({ path: file })
  } catch (e) { console.log(`  (screenshot ${name} failed: ${e.message})`) } finally {
    await page.setViewportSize(size).catch(() => {})
  }
  return file
}
async function pageShot(page, name) {
  const file = path.join(SHOTS, `${name}.png`)
  try { await page.screenshot({ path: file }) } catch (e) { console.log(`  (screenshot ${name} failed: ${e.message})`) }
  return file
}
async function openLoad(page) {
  const answered = page.waitForResponse((r) => r.request().method() === 'GET' && /\/driver-instructions$/.test(new URL(r.url()).pathname), { timeout: 30000 })
  await page.goto(`${BASE}/dashboard?load=${encodeURIComponent(LOAD_ID)}`)
  const resp = await answered
  return resp
}
const row = (api) => api.db.prepare('SELECT * FROM load_driver_instructions WHERE load_key = ?').get(LOAD_ID.toLowerCase())
function plant(api) {
  const t = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  api.db.prepare(`INSERT INTO load_driver_instructions (load_key, load_id, payload, status, review_reasons, review_counts, source, created_at, updated_at)
    VALUES (?, ?, ?, 'needs_review', ?, ?, 'drive_sweep', ?, ?)`).run(LOAD_ID.toLowerCase(), LOAD_ID, JSON.stringify(SEED), JSON.stringify(['unusual_content', 'not_cross_checked']), JSON.stringify({ unusual_content: 1 }), t, t)
}
function plantPending(api, payload = PENDING) {
  api.db.prepare("UPDATE load_driver_instructions SET pending_payload = ?, pending_sha256 = 'qa-pending', pending_reasons = ?, review_reasons = ? WHERE load_key = ?")
    .run(JSON.stringify(payload), JSON.stringify(['rate_con_changed']), JSON.stringify(['rate_con_changed']), LOAD_ID.toLowerCase())
}
// IS6's newer reading differs from the one IS4 accepted.
const PENDING_PHONE = { ...PENDING, stops: [PENDING.stops[0], { ...PENDING.stops[1], instructions: [{ kind: 'receiver', text: 'QA: unload at door nine.' }] }] }

// ---------------------------------------------------------------- the steps
async function flagOn(browser) {
  const api = await startApi({ RATECON_DRIVER_INSTRUCTIONS_ENABLED: 'true', CARRIER_ACCOUNT_NUMBERS_DENY_SECRET: DENY })
  plant(api)
  const { ctx, page } = await openPage(browser, api, DESKTOP)
  try {
    // ---- IS1
    {
      const resp = await openLoad(page)
      const sec = page.locator(SECTION)
      await sec.locator('[data-testid="di-status"]').waitFor({ state: 'visible', timeout: 15000 })
      const text = await sec.innerText()
      const preview = await sec.locator('[data-testid="di-preview"]').innerText()
      const detailBadge = (await page.getByRole('dialog').getByText('⚠ Driver instructions need a look').count()) === 1
      const statusText = await sec.locator('[data-testid="di-status"]').innerText()
      const reasonsText = await sec.locator('[data-testid="di-reasons"]').innerText()
      const hiddenText = await sec.locator('[data-testid="di-hidden"]').innerText()
      const s = await sectionShot(page, 'is1-section')
      await pageShot(page, 'is1-load-detail')
      // The list behind the dialog (the link opened Active Loads): the row's badge.
      await page.keyboard.press('Escape')
      const badge = await page.getByText('⚠ Driver instructions need a look').first().waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
      const listShot = await pageShot(page, 'is1-active-loads-badge')
      const checks = {
        rowBadge: badge,
        detailBadge,
        get200: resp.status() === 200,
        status: /Needs review/i.test(statusText),
        hiddenNote: text.includes("Drivers don't see these until someone marks them reviewed."),
        preview: preview.includes('QA Test Shipper') && preview.includes('QA-PU-1001') && preview.includes('QA: check in at the guard shack.') && preview.includes(FOOTNOTE),
        previewOmitsFlagged: !preview.includes('for staff only'),
        reasons: reasonsText.includes("The rate con's text can't be read, so the instructions can't be checked for completeness."),
        hiddenList: hiddenText.includes('QA: an item with no category, for staff only.'),
        buttons: text.includes('Edit') && text.includes('Mark reviewed') && text.includes('Re-read the rate con'),
      }
      await openLoad(page)
      await sec.locator('[data-testid="di-status"]').waitFor({ state: 'visible', timeout: 15000 })
      record('IS1', 'Dispatcher: the load detail\'s Driver instructions section, and the badges', 'the row and detail badges read "Driver instructions need a look"; GET 200; status Needs review; hidden-from-drivers note; the driver preview (the flagged item left out); the reasons in words; the flagged item under "Not shown to drivers"; Edit / Mark reviewed / Re-read',
        `${flags(checks)}; list shot ${path.basename(listShot)}`, allTrue(checks), s)
    }
    // ---- IS2
    {
      const sec = page.locator(SECTION)
      await sec.getByRole('button', { name: 'Edit', exact: true }).click()
      const form = sec.locator('[data-testid="di-edit"]')
      await form.waitFor({ state: 'visible', timeout: 15000 })
      await form.locator('fieldset').nth(1).getByRole('button', { name: 'Add reference' }).click()
      await form.getByLabel('Stop 1 reference 2 number').fill(DENY)
      const auditsBefore = api.audits.length
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'PUT' && /\/driver-instructions$/.test(new URL(r.url()).pathname), { timeout: 30000 }),
        form.getByRole('button', { name: 'Save', exact: true }).click(),
      ])
      let body = null
      try { body = await resp.json() } catch { /* not json */ }
      const err = sec.locator('[data-testid="di-error"]')
      await err.waitFor({ state: 'visible', timeout: 15000 })
      const shown = (await err.innerText()).trim()
      const want = "This can't be saved: it looks like a number or contact drivers must not see. Field: references."
      const digits = DENY.replace(/\D/g, '')
      const refusalAudit = api.audits.slice(auditsBefore).find((a) => a.action === 'edit_refused')
      const checks = {
        status400: resp.status() === 400,
        code: body?.code === 'INSTRUCTIONS_CONTENT_NOT_ALLOWED',
        rule: body?.rule === 'number',
        fieldKindOnly: body?.field === 'references',
        bodyNoValue: !JSON.stringify(body || {}).includes(digits),
        message: shown === want,
        messageNoItem: !/\[|\]|\d/.test(shown),
        stillEditing: await form.isVisible(),
        nothingWritten: row(api)?.status === 'needs_review',
        auditCodesOnly: !!refusalAudit && !refusalAudit.details.includes(digits),
      }
      const s = await sectionShot(page, 'is2-refused')
      record('IS2', 'Edit: a reference holding the deny value', `400 INSTRUCTIONS_CONTENT_NOT_ALLOWED, rule "number", field "references", value never echoed; the section says "${want}"; nothing written; the refusal audited with codes only`,
        `${flags(checks)}; shown: "${shown}"`, allTrue(checks), s)
      await form.getByRole('button', { name: 'Cancel' }).click()
    }
    // ---- IS3
    {
      const sec = page.locator(SECTION)
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && /\/review$/.test(new URL(r.url()).pathname), { timeout: 30000 }),
        sec.getByRole('button', { name: 'Mark reviewed' }).click(),
      ])
      await sec.locator('[data-testid="di-notice"]').waitFor({ state: 'visible', timeout: 15000 })
      const stored = row(api) || {}
      const checks = {
        status200: resp.status() === 200,
        chip: /Reviewed/i.test(await sec.locator('[data-testid="di-status"]').innerText()),
        notice: (await sec.locator('[data-testid="di-notice"]').innerText()).includes('Marked reviewed. Drivers see this version'),
        heading: (await sec.locator('[data-testid="di-preview"]').innerText()).toLowerCase().includes('what the driver sees'),
        reasonsCleared: (await sec.locator('[data-testid="di-reasons"]').count()) === 0,
        reviewedLine: (await sec.locator('[data-testid="di-reviewed"]').innerText()).includes('Last reviewed by qa-di-dispatcher'),
        storedReviewed: stored.status === 'reviewed' && !!stored.published_at,
        // The tab refreshed the dashboard and re-synced the open load: its badge is gone.
        detailBadgeCleared: await page.getByRole('dialog').getByText('⚠ Driver instructions need a look').waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false),
      }
      const s = await sectionShot(page, 'is3-reviewed')
      record('IS3', 'Mark reviewed', 'POST .../review 200; status Reviewed; the notice; "What the driver sees"; no reasons left; "Last reviewed by"; stored reviewed and published', flags(checks), allTrue(checks), s)
    }
    // ---- IS4
    {
      plantPending(api)
      await openLoad(page)
      const sec = page.locator(SECTION)
      const pend = sec.locator('[data-testid="di-pending"]')
      await pend.waitFor({ state: 'visible', timeout: 15000 })
      const ptext = await pend.innerText()
      const tops = await pend.locator('.grid > div').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
      const before = {
        sideBySide: tops.length === 2 && tops[0] === tops[1],
        current: ptext.toLowerCase().includes('drivers see now') && ptext.includes('QA: unload at door four.'),
        next: ptext.toLowerCase().includes('new reading') && ptext.includes('QA Test Receiver North') && ptext.includes('QA: unload at door seven.'),
        reason: ptext.includes('A newer reading of the rate con is waiting'),
      }
      const s = await sectionShot(page, 'is4-pending-side-by-side')
      const [keep] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && /\/accept-pending$/.test(new URL(r.url()).pathname), { timeout: 30000 }),
        pend.getByRole('button', { name: 'Keep current' }).click(),
      ])
      await sec.locator('[data-testid="di-notice"]').waitFor({ state: 'visible', timeout: 15000 })
      const kept = {
        status200: keep.status() === 200,
        gone: (await sec.locator('[data-testid="di-pending"]').count()) === 0,
        notice: (await sec.locator('[data-testid="di-notice"]').innerText()).includes('Kept the current version.'),
        storedKept: (row(api)?.pending_payload || '') === '' && String(row(api)?.payload || '').includes('door four'),
      }
      plantPending(api)
      await openLoad(page)
      const pend2 = page.locator(`${SECTION} [data-testid="di-pending"]`)
      await pend2.waitFor({ state: 'visible', timeout: 15000 })
      const [acc] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && /\/accept-pending$/.test(new URL(r.url()).pathname), { timeout: 30000 }),
        pend2.getByRole('button', { name: 'Accept the new rate con' }).click(),
      ])
      await page.locator(`${SECTION} [data-testid="di-notice"]`).waitFor({ state: 'visible', timeout: 15000 })
      const accepted = {
        status200: acc.status() === 200,
        notice: (await page.locator(`${SECTION} [data-testid="di-notice"]`).innerText()).includes('The new reading is now what drivers see.'),
        previewNew: (await page.locator(`${SECTION} [data-testid="di-preview"]`).innerText()).includes('QA: unload at door seven.'),
      }
      const s2 = await sectionShot(page, 'is4-accepted')
      record('IS4', 'A pending re-issue side by side; Keep current; Accept the new rate con', 'two columns side by side ("Drivers see now" | "New reading") with the reason; Keep current 200 and the pending reading gone; a second one accepted is what drivers see',
        `${flags(before)}; keep: ${flags(kept)}; accept: ${flags(accepted)}; accepted shot ${path.basename(s2)}`, allTrue(before) && allTrue(kept) && allTrue(accepted), s)
    }
    // ---- IS5
    {
      const sec = page.locator(SECTION)
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && /\/re-extract$/.test(new URL(r.url()).pathname), { timeout: 30000 }),
        sec.getByRole('button', { name: 'Re-read the rate con' }).click(),
      ])
      let body = null
      try { body = await resp.json() } catch { /* not json */ }
      const err = sec.locator('[data-testid="di-error"]')
      await err.waitFor({ state: 'visible', timeout: 15000 })
      const shown = (await err.innerText()).trim()
      const checks = { status404: resp.status() === 404, code: body?.code === 'INSTRUCTIONS_NO_RATE_CON', message: shown === 'No rate con is on file for this load. Type the instructions instead.', sectionStays: await sec.isVisible() }
      const s = await sectionShot(page, 'is5-reread-no-rate-con')
      record('IS5', 'Re-read the rate con, none on file', '404 INSTRUCTIONS_NO_RATE_CON; the plain message; the section stays', `${flags(checks)}; shown: "${shown}"`, allTrue(checks), s)
    }
    // ---- IS6
    {
      plantPending(api, PENDING_PHONE)
      const p = await openPage(browser, api, PHONE)
      try {
        await openLoad(p.page)
        const sec = p.page.locator(SECTION)
        await sec.locator('[data-testid="di-pending"]').waitFor({ state: 'visible', timeout: 15000 })
        const measure = () => p.page.evaluate((sel) => {
          const el = document.querySelector(sel)
          const r = el.getBoundingClientRect()
          const lefts = [...el.querySelectorAll('[data-testid="di-pending"] .grid > div')].map((c) => Math.round(c.getBoundingClientRect().left))
          return {
            right: Math.round(r.right),
            vw: window.innerWidth,
            sectionOverflow: el.scrollWidth - el.clientWidth,
            pageScroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
            stacked: lefts.length === 2 && lefts[0] === lefts[1],
          }
        }, SECTION)
        const view = await measure()
        const s = await sectionShot(p.page, 'is6-phone-390x844')
        await pageShot(p.page, 'is6-phone-390x844-viewport')
        await sec.getByRole('button', { name: 'Edit', exact: true }).click()
        await sec.locator('[data-testid="di-edit"]').waitFor({ state: 'visible', timeout: 15000 })
        const edit = await measure()
        const s2 = await sectionShot(p.page, 'is6-phone-390x844-edit')
        // The phone list cards whose row carries instruction codes: the badge stays
        // inside its card, with no sideways scroll (Active Loads, then the Job Board).
        const cardFit = (cardSel) => p.page.evaluate((sel) => {
          const card = [...document.querySelectorAll(sel)].find((c) => /Driver instructions need a look/i.test(c.textContent))
          if (!card) return null
          card.scrollIntoView({ block: 'center' })
          const badge = [...card.querySelectorAll('span')].find((b) => /Driver instructions need a look/i.test(b.textContent) && b.children.length === 0)
          const c = card.getBoundingClientRect()
          const b = badge ? badge.getBoundingClientRect() : null
          return {
            badgeInside: !!b && b.left >= c.left - 0.5 && b.right <= c.right + 0.5,
            cardOverflow: card.scrollWidth - card.clientWidth,
            pageScroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
          }
        }, cardSel)
        await sec.getByRole('button', { name: 'Cancel' }).click()
        await p.page.keyboard.press('Escape')
        await p.page.locator('.mobile-load-card').first().waitFor({ state: 'visible', timeout: 15000 })
        const activeCard = await cardFit('.mobile-load-card')
        await pageShot(p.page, 'is6-phone-390x844-active-card')
        await p.page.getByRole('tab', { name: /Job Board/ }).click()
        await p.page.locator('.mobile-job-card').first().waitFor({ state: 'visible', timeout: 15000 })
        const boardCard = await cardFit('.mobile-job-card')
        await pageShot(p.page, 'is6-phone-390x844-board-card')
        const cardOk = (m) => !!m && m.badgeInside && m.cardOverflow <= 0 && m.pageScroll <= 0
        const ok = view.right <= view.vw && view.sectionOverflow <= 0 && view.pageScroll <= 0 && view.stacked && edit.right <= edit.vw && edit.sectionOverflow <= 0 && edit.pageScroll <= 0 && cardOk(activeCard) && cardOk(boardCard)
        record('IS6', 'The section at 390 x 844, and the phone list cards with the instructions badge', 'fits the width (no sideways scroll, page or section); the pending columns stack; the edit form fits too; on the Active Loads and Job Board cards the badge stays inside the card',
          `view ${flags(view)}; edit right=${edit.right} sectionOverflow=${edit.sectionOverflow} pageScroll=${edit.pageScroll}; Active Loads card ${activeCard ? flags(activeCard) : 'NOT FOUND'}; Job Board card ${boardCard ? flags(boardCard) : 'NOT FOUND'}; edit shot ${path.basename(s2)}`, ok, s)
      } finally { await p.ctx.close() }
    }
  } finally {
    await ctx.close()
    await api.close()
  }
}

async function flagOff(browser) {
  const api = await startApi({})
  const { ctx, page } = await openPage(browser, api, DESKTOP)
  try {
    const consoleFrom = consoleLines.length
    const resp = await openLoad(page)
    await page.getByRole('dialog').filter({ hasText: LOAD_ID }).waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(500)
    let body = null
    try { body = await resp.json() } catch { /* not json */ }
    // The browser logs the 404 itself, once per opened load: expected while the flag is
    // off. Nothing else may reach the console.
    const errors = appErrors(consoleLines.slice(consoleFrom))
    const checks = {
      status404: resp.status() === 404,
      noCode: !body?.code,
      noSection: (await page.locator(SECTION).count()) === 0,
      noBadge: (await page.getByText('Driver instructions need a look').count()) === 0,
      consoleOnlyThe404: errors.length === 1 && /Failed to load resource.*404/.test(errors[0].text),
    }
    const s = await pageShot(page, 'is7-flag-off')
    record('IS7', 'The flag off', 'GET .../driver-instructions 404 with no code; no section in the load detail; no instructions badge; the console holds only the browser\'s one "Failed to load resource … 404" line for the opened load',
      `${flags(checks)}; console errors: ${errors.map((l) => `"${l.text.slice(0, 120)}"`).join(', ') || 'none'}`, allTrue(checks), s)
  } finally {
    await ctx.close()
    await api.close()
  }
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use`)
  const server = http.createServer(serveDist)
  await new Promise((resolve) => server.listen(PORT, HOST, resolve))
  let browser = null
  try {
    browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
    for (const [name, fn] of [['flag on', flagOn], ['flag off', flagOff]]) {
      try { await fn(browser) } catch (e) { record('IS!', `${name}: aborted`, '', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
    }
    // Console errors over the whole run: only the browser's own lines for the answers the
    // steps asked for (400 refusal, 404s), never a script error.
    const consoleErrors = appErrors(consoleLines)
    const notNetwork = consoleErrors.filter((l) => !/^Failed to load resource: the server responded with a status of (400|404)/.test(l.text))
    record('ISx', 'Page errors; console errors; writes the page sent outside the instructions routes', 'no page errors; console errors only the browser\'s "Failed to load resource" lines for the 400 and 404 answers; no other writes',
      `${pageErrors.length ? pageErrors.join('; ') : 'no page errors'}; ${consoleErrors.length} console error line(s), ${notNetwork.length} other than those${notNetwork.length ? `: ${notNetwork.map((l) => l.text.slice(0, 120)).join('; ')}` : ''}; ${otherWrites.length ? otherWrites.join(', ') : 'no other writes'}`,
      pageErrors.length === 0 && notNetwork.length === 0 && otherWrites.length === 0)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await new Promise((r) => server.close(() => r()))
  }
  // A table cell: backslashes first, then the pipes and line breaks that would end it.
  const cell = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  const lines = [
    `# LogisX — driver instructions staff screen (made-up data) — ${new Date().toISOString()}`,
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
