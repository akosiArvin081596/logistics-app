#!/usr/bin/env node
// LogisX — the "factored" mark as a Super Admin uses it (lib/factoring-store.js,
// lib/factoring-routes.js, FactoringControls.vue), at 1280x800, on made-up data only.
//
// What the page shows comes from the server's own modules: they run in this process on an
// in-memory database. `_factoring` is annotateDashboard()'s, the switch posts to the routes' own
// handlers, and a Draft Invoice press runs draftEarly(), the check server.js makes before anything
// is read or minted (scripts/test-invoice-draft-factored.js runs that route as shipped). A driver's
// tap isn't run here; scripts/test-auto-invoice-driver-trigger.js pins what it does to a marked load.
// Steps:
//   F   a listed account, both settings on: the switch with its one line; marks with a reason (the
//       button waits for one); one POST, one row, one audit row; the chip shows with the line, on
//       the server's own answer after a reload too; once the load is delivered, the Draft Invoice
//       button refuses it in words, and a confirmation answers 409 NOA_UNCONFIGURED; nothing reaches
//       the point where prepare() starts, while a load that isn't factored does
//   N   a Super Admin not listed, the same settings: the chip only on a marked load, nothing on any
//       other, no switch, no reason box, no line; the Draft Invoice button refuses; marking answers
//       403 and writes nothing; a confirmation answers 409 NOA_UNCONFIGURED
//   O   as production ships, both settings unset: no switch for anyone, the marking route answers
//       404 FEATURE_OFF; a load the lead's script marked shows the chip and is refused all the same
//   G   the browser asked no mail host and opened no socket off this machine
//
// Like driver-delivered-invoice.mjs this boots no server.js, reads no settings file or key and signs
// nobody in. It serves the checkout's built client/dist on 127.0.0.1 (E2E_PORT, or a free port the
// system picks) and answers every /api request in the browser. Every request to another host is
// aborted, the socket included, so the page reads a change on a reload.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/factoring-mark-usable.mjs
//
// Env: E2E_PORT (3000 and 5173 are refused, and so is a port in use), HEADED=1, CHROME_PATH, E2E_WORK_DIR.
// Output: PASS/FAIL lines, a final count, <work dir>/results-factoring-mark-usable.md and screenshots
// in ~/LogisX-replica/screens/factoring-mark/. Exit 0 only when every row PASSes.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import paths from './paths.cjs'

const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = path.join(os.homedir(), 'LogisX-replica', 'screens', 'factoring-mark')
const VIEWPORT = { width: 1280, height: 800 }

function die(msg) {
  console.error(`factoring-mark-usable: ${msg}`)
  process.exit(2)
}

if (process.env.E2E_PORT && (!Number.isInteger(ASKED_PORT) || ASKED_PORT < 1024 || ASKED_PORT > 65535)) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (ASKED_PORT === 3000 || ASKED_PORT === 5173) die(`refusing port ${ASKED_PORT}: 3000 is production's port on the VPS and 5173 is Vite's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm --prefix client run build\` first`)

// ---------------------------------------------------------------- the server's own modules
const require = createRequire(import.meta.url)
const Database = require(path.join(paths.REPO, 'node_modules', 'better-sqlite3'))
const store = require(path.join(paths.REPO, 'lib', 'factoring-store.js'))
const routesLib = require(path.join(paths.REPO, 'lib', 'factoring-routes.js'))
const rules = require(path.join(paths.REPO, 'lib', 'auto-invoice-rules.js'))

// ---------------------------------------------------------------- made-up fixtures
const account = (id, username, fullName) => Object.freeze({ id, username, role: 'Super Admin', driverName: '', email: '', fullName, companyName: '', mustChangePassword: false })
const LISTED = account(90411, 'qa-factoring-listed', 'QA Factoring Listed')
const NOT_LISTED = account(90412, 'qa-factoring-other', 'QA Factoring Other')
const SETTINGS_ON = Object.freeze({ TRIUMPH_FACTORING_ENABLED: 'true', TRIUMPH_FACTOR_MARK_IDS: String(LISTED.id) })
const SETTINGS_UNSET = Object.freeze({})
const DRIVER_NAME = 'Casey Example'
const HEADERS = ['Load ID', 'Status', 'Driver', 'Truck', 'Pickup Address', 'Drop-off Address', 'Payment', 'Completion Date']
const TO_MARK = 'QA-FACT-9001'
const ACTIVE_PLAIN = 'QA-FACT-9002'
const DONE_PLAIN = 'QA-FACT-9003'
const REASON = 'made-up: factored by hand for this check'

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const [TY, TM, TD] = TODAY.split('-')
const DELIVERED_ON = `${TM}/${TD}/${TY} 09:15:00`

// The screen's copy, pinned here so a changed word is a FAIL rather than a matching read.
const WORDS = {
  line: "Mark before the driver taps Delivered. After the invoice goes out, this can't be undone here.",
  notFactored: 'Not factored.',
  chip: 'Factored (Triumph). The invoice goes through Triumph, not by email. The Draft Invoice button refuses it.',
  marked: 'Marked factored: its invoice goes through Triumph.',
  refused: 'This load is factored: its invoice goes through Triumph, not by email.',
  noa: "This load is factored, and the app can't put Triumph's assignment on an invoice yet, so no draft was made. Its invoice goes through Triumph's own process.",
  notListed: 'Only the accounts listed for factoring may do this.',
}

// One made-up server's worth of state, and the factoring routes on it, with the settings given.
function freshServer(env) {
  const db = new Database(':memory:')
  store.ensureSchema(db)
  const s = { db, rows: [], audits: [], refusals: [], markPosts: [], presses: [], reachedPrepare: [], mounted: {} }
  const addLoad = (id, status) => {
    s.rows.push({
      _rowIndex: s.rows.length + 2,
      _id: s.rows.length + 2,
      'Load ID': id,
      Status: status,
      Driver: DRIVER_NAME,
      Truck: 'QA-T1',
      'Pickup Address': '100 Example Rd, Memphis, TN 38118',
      'Drop-off Address': '200 Sample Ave, Dallas, TX 75201',
      Payment: '$1,234.00',
      'Completion Date': status === 'Delivered' ? DELIVERED_ON : '',
      _pickupStreet: '100 Example Rd',
      _pickupLocation: 'Memphis, TN 38118',
      _dropStreet: '200 Sample Ave',
      _dropLocation: 'Dallas, TX 75201',
    })
  }
  addLoad(TO_MARK, 'In Transit')
  addLoad(ACTIVE_PLAIN, 'In Transit')
  addLoad(DONE_PLAIN, 'Delivered')
  s.routes = routesLib.create({
    db,
    env,
    logAudit: (req, action, entity, id, details) => s.audits.push({ action, id, details: String(details || ''), by: req.session.user.username }),
    logAuditRefusal: (req, action, entity, id, details, code) => s.refusals.push({ action, id, code, by: req.session.user.username }),
  })
  s.routes.mount({ post: (p, ...chain) => { s.mounted[p] = chain } }, {
    requireRole: (role) => (req, res, next) => (req.session.user.role === role ? next() : res.status(403).json({ code: 'FORBIDDEN' })),
    refuseCrossSite: (req, res, next) => next(),
  })
  s.call = async (route, user, params, body) => {
    const out = { status: 200, body: {} }
    const res = { status(c) { out.status = c; return res }, json(b) { out.body = b; return res } }
    const req = { params, body, session: { user } }
    for (const handler of s.mounted[route] || []) {
      let goOn = false
      await handler(req, res, () => { goOn = true })
      if (!goOn) break
    }
    return out
  }
  s.marker = (id) => db.prepare('SELECT factored, source, reason, set_by, set_by_id FROM load_factoring WHERE load_key = ?').get(rules.loadKey(id)) || null
  // What the lead's scripts/factoring-mark.js does, whatever the settings say.
  s.markByScript = (id) => store.mark(db, { key: rules.loadKey(id), loadId: id, reason: 'made-up: from the list', source: 'script', actor: { id: 0, username: 'factoring-mark' }, nowIso: new Date().toISOString(), audit: () => {} })
  // A driver's Delivered, as far as the page can see: the row moves to Completed.
  s.deliver = (id) => {
    const row = s.rows.find((r) => r['Load ID'] === id)
    row.Status = 'Delivered'
    row['Completion Date'] = DELIVERED_ON
  }
  return s
}

const json200 = (body) => ({ status: 200, body })
const parse = (raw) => { try { return JSON.parse(raw || 'null') } catch { return null } }

function dashboardBody(s, user) {
  const active = s.rows.filter((r) => !rules.isCompletedStatus(r.Status)).map((r) => ({ ...r }))
  const completed = s.rows.filter((r) => rules.isCompletedStatus(r.Status)).map((r) => ({ ...r }))
  s.routes.annotateDashboard({ session: { user } }, { headers: HEADERS, active, completed })
  return {
    timestamp: new Date().toISOString(),
    kpis: { activeLoads: active.length, unassignedLoads: 0, completedThisWeek: completed.length, completedThisMonth: completed.length, fleetUtilization: { assigned: 1, total: 1 }, revenue: { total: 0, paid: 0, pending: 0 } },
    unassignedJobs: [], jobTrackingHeaders: HEADERS, completedHeaders: HEADERS, activeJobs: active, completedJobs: completed,
    fleet: [{ Driver: DRIVER_NAME, Truck: 'QA-T1', Status: 'On Load', CompletedLoads: 1, CurrentLoad: ACTIVE_PLAIN, Phone: '(512) 555-0100', QueueCount: 0, QueuedLoadIds: [] }],
    drivers: [DRIVER_NAME], driverQueues: {},
  }
}

function answerGet(s, user, pathname) {
  if (pathname === '/api/auth/session') return json200({ authenticated: true, user, appTimeZone: 'America/New_York' })
  if (pathname === '/api/dashboard') return json200(dashboardBody(s, user))
  if (pathname === '/api/dispatch-notifications') return json200({ notifications: [], unreadCount: 0 })
  if (pathname === '/api/load-ratings/averages') return json200({ averages: {} })
  if (pathname === '/api/truck-assignments') return json200({ assignments: [] })
  if (pathname === '/api/config/maps-key') return json200({ key: 'qa-factoring-no-key' })
  if (pathname === '/api/locations/latest') return json200({ locations: [] })
  if (pathname === '/api/integrations/chr/status') return json200({ enabled: false })
  if (pathname.startsWith('/api/load-ratings/')) return json200({ rating: 0 })
  if (pathname.startsWith('/api/geocode/load/')) return json200({})
  if (/^\/api\/documents\/[^/]+$/.test(pathname)) return json200({ documents: [] })
  if (/^\/api\/loads\/[^/]+\/invoice-draft$/.test(pathname)) return json200({ draft: null })
  if (/^\/api\/loads\/[^/]+\/status-history$/.test(pathname)) return json200({ phases: [] })
  if (/^\/api\/loads\/[^/]+\/haul$/.test(pathname)) return json200({ driven: null, lane: null })
  if (/^\/api\/loads\/[^/]+\/ratecon\.pdf$/.test(pathname)) return { status: 404, body: { error: 'No rate con in this check.', code: 'RATECON_NOT_FOUND' } }
  return null
}

// The marking route through its own handlers; a Draft Invoice press through the route's first
// check, stopping where prepare() would start. Anything else the page writes is listed, not answered.
async function answerWrite(s, user, method, url, raw) {
  if (method !== 'POST') return null
  const body = parse(raw) || {}
  let m
  if ((m = url.pathname.match(/^\/api\/factoring\/loads\/([^/]+)$/))) {
    const loadKey = decodeURIComponent(m[1])
    s.markPosts.push({ loadKey, body, by: user.username })
    return s.call('/api/factoring/loads/:loadKey', user, { loadKey }, body)
  }
  if ((m = url.pathname.match(/^\/api\/loads\/([^/]+)\/draft-invoice$/))) {
    const loadId = decodeURIComponent(m[1])
    s.presses.push({ loadId, dryRun: url.searchParams.get('dryRun') === '1', by: user.username })
    const check = s.routes.draftEarly({ body, session: { user } }, loadId)
    if (!check.ok) return { status: check.http, body: check.json }
    s.reachedPrepare.push(loadId)
    return { status: 409, body: { error: 'made-up: this check stops where prepare() would start.', code: 'E2E_STOPS_HERE' } }
  }
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.webmanifest': 'application/manifest+json' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by this check"}')
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
    const c = net.connect({ host: HOST, port }, () => { c.destroy(); resolve(true) })
    c.on('error', () => resolve(false))
  })
}

// ---------------------------------------------------------------- results
const rows = []
const otherWrites = []
const unanswered = new Set()
const pageErrors = []
const offHost = new Set()
const offHostSockets = []
function record(step, title, expected, observed, pass, shotFile = '') {
  rows.push({ step, title, expected, observed, verdict: pass ? 'PASS' : 'FAIL', shot: shotFile })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${observed}`)
  if (!pass) console.log(`      expected: ${expected}`)
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(SHOT_DIR, `${name}.png`)
  await page.screenshot({ path: file })
  return file
}

// ---------------------------------------------------------------- page helpers
const DIALOG = '[role="dialog"]'

async function openPage(browser, s, user) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) { offHost.add(u.host); return route.abort() }
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    const isGet = req.method() === 'GET'
    const out = isGet ? answerGet(s, user, u.pathname) : await answerWrite(s, user, req.method(), u, req.postData())
    if (out === null) {
      if (isGet) unanswered.add(u.pathname)
      else otherWrites.push(`${req.method()} ${u.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({ status: out.status, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out.body) })
  })
  const page = await ctx.newPage()
  const seenDialogs = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 200)))
  page.on('websocket', (ws) => {
    let host = ''
    try { host = new URL(ws.url()).host } catch { host = '(unreadable)' }
    if (host !== `${HOST}:${PORT}`) offHostSockets.push(host)
  })
  // No step here should raise a browser dialog: one is dismissed, and the row that sees it fails.
  page.on('dialog', async (d) => {
    seenDialogs.push(d.message())
    await d.dismiss().catch(() => {})
  })
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  return { ctx, page, seenDialogs }
}

const locText = (loc) => loc.first().textContent({ timeout: 2000 }).then((t) => (t || '').replace(/\s+/g, ' ').trim(), () => '')
async function appears(page, selector, ms) {
  try { await page.waitForSelector(selector, { state: 'visible', timeout: ms }); return true } catch { return false }
}
const gone = (page, selector, ms = 5000) => page.waitForSelector(selector, { state: 'hidden', timeout: ms }).then(() => true, () => false)
async function until(check, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

async function openTab(page, name) {
  await page.locator('[role="tab"]', { hasText: name }).first().click({ timeout: 15000 })
  return true
}
// By the load's own row: each load is in one list at a time, whichever tabs stay mounted.
async function openLoad(page, id) {
  const row = page.locator('tbody tr', { hasText: id }).first()
  const listed = await row.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
  if (!listed) return false
  await row.locator('td').first().click({ timeout: 8000 })
  return appears(page, DIALOG, 8000)
}
async function closeLoad(page) {
  await page.keyboard.press('Escape')
  return gone(page, DIALOG)
}
const count = (page, selector) => page.locator(selector).count()
// The controls as the open dialog shows them.
const controlsOf = async (page) => ({
  lines: await count(page, '.fact-line'),
  text: await count(page, '.fact-text') ? await locText(page.locator('.fact-text')) : '',
  note: await count(page, '.fact-note') ? await locText(page.locator('.fact-note')) : '',
  reasonBoxes: await count(page, '.fact-reason'),
  buttons: await count(page, '.fact-btn'),
})
const showsChipOnly = (c) => c.lines === 1 && c.text === WORDS.chip && c.note === '' && c.reasonBoxes === 0 && c.buttons === 0
const showsNothing = (c) => c.lines === 0 && c.text === '' && c.note === '' && c.reasonBoxes === 0 && c.buttons === 0

// A press of the dialog's button, and the words it answers with.
async function pressDraftInvoice(page) {
  await page.locator(`${DIALOG} button`, { hasText: 'Draft Invoice Email' }).first().click({ timeout: 8000 })
  const shown = await appears(page, '.draft-result', 8000)
  return shown ? locText(page.locator('.draft-result')) : ''
}
const postFromPage = (page, url, body) => page.evaluate(async ([target, payload]) => {
  const r = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(payload) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}, [url, body])
const draftUrl = (id, dry = false) => `/api/loads/${encodeURIComponent(id)}/draft-invoice${dry ? '?dryRun=1' : ''}`
const CONFIRM = Object.freeze({ confirmFactored: true, factoredReason: 'made-up: asked for a copy' })

// ---------------------------------------------------------------- F: a listed account
async function listedRun(browser) {
  const s = freshServer(SETTINGS_ON)
  const { ctx, page, seenDialogs } = await openPage(browser, s, LISTED)
  try {
    const listed = await openTab(page, 'Active Loads')
    const opened = listed && await openLoad(page, TO_MARK)
    if (!opened) {
      record('F-open', 'Active Loads opens the load', 'the load dialog', `listed ${listed}, opened ${opened}`, false)
      return
    }
    const button = page.locator('.fact-btn', { hasText: 'Factor with Triumph' })
    const before = await controlsOf(page)
    const disabledEmpty = await button.isDisabled({ timeout: 5000 }).catch(() => false)
    await page.locator('.fact-reason').fill('   ')
    const disabledBlank = await button.isDisabled({ timeout: 5000 }).catch(() => false)
    const openFile = await shot(page, 'F-switch')
    record('F-switch', 'The switch shows with its one line, and waits for a reason', `"${WORDS.notFactored}"; the line "${WORDS.line}"; one reason box; "Factor with Triumph" disabled with no reason, or a blank one; nothing posted`,
      `text "${before.text}", line "${before.note}", reason boxes ${before.reasonBoxes}, disabled empty ${disabledEmpty}, blank ${disabledBlank}, posts ${s.markPosts.length}`,
      before.lines === 1 && before.text === WORDS.notFactored && before.note === WORDS.line && before.reasonBoxes === 1 && disabledEmpty && disabledBlank && s.markPosts.length === 0, openFile)

    await page.locator('.fact-reason').fill(REASON)
    await button.click({ timeout: 5000 })
    const posted = await until(() => s.markPosts.length === 1)
    const answered = await appears(page, '.fact-result--ok', 8000)
    const answer = answered ? await locText(page.locator('.fact-result--ok')) : ''
    const row = s.marker(TO_MARK)
    const audits = s.audits.filter((a) => a.action === 'factoring_marked')
    record('F-mark', 'A listed account marks it with a reason', `one POST with the reason; "${WORDS.marked}"; one row by this account; one factoring_marked audit row with the reason; no browser dialog`,
      `posts ${s.markPosts.length}, reason sent "${posted ? s.markPosts[0].body.reason : ''}", answer "${answer}", row ${JSON.stringify(row)}, audits ${JSON.stringify(audits)}, dialogs ${seenDialogs.length}`,
      posted && s.markPosts.length === 1 && s.markPosts[0].body.factored === true && s.markPosts[0].body.reason === REASON && answer === WORDS.marked
        && !!row && row.factored === 1 && row.source === 'person' && row.reason === REASON && row.set_by === LISTED.username && row.set_by_id === LISTED.id
        && audits.length === 1 && audits[0].by === LISTED.username && audits[0].details.includes(REASON) && seenDialogs.length === 0)

    const after = await controlsOf(page)
    const clearShown = await count(page, '.fact-btn:has-text("Clear factored")')
    const chipFile = await shot(page, 'F-chip')
    record('F-chip', 'The chip shows, with the line', `"${WORDS.chip}" with the line "${WORDS.line}"; the switch now reads "Clear factored"`,
      `text "${after.text}", line "${after.note}", Clear factored ${clearShown}`, after.text === WORDS.chip && after.note === WORDS.line && clearShown === 1, chipFile)

    await closeLoad(page)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const relisted = await openTab(page, 'Active Loads')
    const reopened = relisted && await openLoad(page, TO_MARK)
    const reread = reopened ? await controlsOf(page) : {}
    record('F-reload', 'The same on the server\'s own answer, after a reload', 'the chip and the line', `opened ${reopened}, text "${reread.text}", line "${reread.note}"`, reopened && reread.text === WORDS.chip && reread.note === WORDS.line)
    if (reopened) await closeLoad(page)

    s.deliver(TO_MARK)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const completed = await openTab(page, 'Completed')
    const openedDone = completed && await openLoad(page, TO_MARK)
    if (!openedDone) {
      record('F-completed', 'Completed Loads opens the marked load', 'the load dialog', `listed ${completed}, opened ${openedDone}`, false)
      return
    }
    const done = await controlsOf(page)
    const words = await pressDraftInvoice(page)
    const pressFile = await shot(page, 'F-refused')
    record('F-refused', 'The Draft Invoice button refuses the marked load', `the chip; one dry-run press; the words "${WORDS.refused}"; nothing reaches prepare()`,
      `text "${done.text}", presses ${JSON.stringify(s.presses)}, words "${words}", reached prepare ${JSON.stringify(s.reachedPrepare)}`,
      done.text === WORDS.chip && s.presses.length === 1 && s.presses[0].dryRun === true && words === WORDS.refused && s.reachedPrepare.length === 0, pressFile)

    const confirmed = await postFromPage(page, draftUrl(TO_MARK), CONFIRM)
    record('F-confirm', 'A listed account\'s confirmation is refused', `409 NOA_UNCONFIGURED, "${WORDS.noa}"; nothing reaches prepare()`,
      `${confirmed.status} ${confirmed.body.code}, "${confirmed.body.error}", reached prepare ${JSON.stringify(s.reachedPrepare)}`,
      confirmed.status === 409 && confirmed.body.code === 'NOA_UNCONFIGURED' && confirmed.body.error === WORDS.noa && s.reachedPrepare.length === 0)

    const plain = await postFromPage(page, draftUrl(DONE_PLAIN, true), {})
    record('F-plain', 'A load that isn\'t factored passes the check', `it reaches prepare(): ${DONE_PLAIN}, and only that load`, `${plain.status} ${plain.body.code}, reached prepare ${JSON.stringify(s.reachedPrepare)}`,
      plain.body.code === 'E2E_STOPS_HERE' && s.reachedPrepare.length === 1 && s.reachedPrepare[0] === DONE_PLAIN)
  } finally {
    await ctx.close()
    s.db.close()
  }
}

// ---------------------------------------------------------------- N: a Super Admin not listed
async function notListedRun(browser) {
  const s = freshServer(SETTINGS_ON)
  s.deliver(TO_MARK)
  const premark = s.markByScript(TO_MARK)
  const { ctx, page } = await openPage(browser, s, NOT_LISTED)
  try {
    const completed = await openTab(page, 'Completed')
    const opened = completed && await openLoad(page, TO_MARK)
    if (!opened) {
      record('N-open', 'Completed Loads opens the marked load', 'the load dialog', `mark ${JSON.stringify(premark)}, listed ${completed}, opened ${opened}`, false)
      return
    }
    const marked = await controlsOf(page)
    const words = await pressDraftInvoice(page)
    const chipFile = await shot(page, 'N-chip-only')
    record('N-chip', 'A Super Admin not listed sees the chip only', `"${WORDS.chip}"; no line, no reason box, no button`, JSON.stringify(marked), showsChipOnly(marked), chipFile)
    record('N-refused', 'The Draft Invoice button refuses them too', `"${WORDS.refused}"; nothing reaches prepare()`, `words "${words}", reached prepare ${JSON.stringify(s.reachedPrepare)}`, words === WORDS.refused && s.reachedPrepare.length === 0)

    const confirmed = await postFromPage(page, draftUrl(TO_MARK), CONFIRM)
    record('N-confirm', 'Their confirmation gets the same answer as a listed account\'s', '409 NOA_UNCONFIGURED; nothing reaches prepare()',
      `${confirmed.status} ${confirmed.body.code}, reached prepare ${JSON.stringify(s.reachedPrepare)}`, confirmed.status === 409 && confirmed.body.code === 'NOA_UNCONFIGURED' && s.reachedPrepare.length === 0)
    await closeLoad(page)

    const active = await openTab(page, 'Active Loads')
    const openedPlain = active && await openLoad(page, ACTIVE_PLAIN)
    const plain = openedPlain ? await controlsOf(page) : {}
    const plainFile = await shot(page, 'N-no-switch')
    record('N-no-switch', 'A load with no mark: no switch at all', 'no chip, no line, no reason box, no button', `opened ${openedPlain}, ${JSON.stringify(plain)}`, openedPlain && showsNothing(plain), plainFile)

    const tried = await postFromPage(page, `/api/factoring/loads/${encodeURIComponent(rules.loadKey(ACTIVE_PLAIN))}`, { factored: true, reason: REASON })
    record('N-post', 'Marking by hand is refused', `403 FACTORING_NOT_LISTED, "${WORDS.notListed}"; no row`, `${tried.status} ${tried.body.code}, "${tried.body.error}", row ${JSON.stringify(s.marker(ACTIVE_PLAIN))}`,
      tried.status === 403 && tried.body.code === 'FACTORING_NOT_LISTED' && tried.body.error === WORDS.notListed && s.marker(ACTIVE_PLAIN) === null)
  } finally {
    await ctx.close()
    s.db.close()
  }
}

// ---------------------------------------------------------------- O: as production ships
async function settingsUnsetRun(browser) {
  const s = freshServer(SETTINGS_UNSET)
  s.deliver(TO_MARK)
  const premark = s.markByScript(TO_MARK)
  const { ctx, page } = await openPage(browser, s, LISTED)
  try {
    const active = await openTab(page, 'Active Loads')
    const openedPlain = active && await openLoad(page, ACTIVE_PLAIN)
    const plain = openedPlain ? await controlsOf(page) : {}
    record('O-no-switch', 'Both settings unset: no switch, for the account that would be listed', 'no chip, no line, no reason box, no button', `opened ${openedPlain}, ${JSON.stringify(plain)}`, openedPlain && showsNothing(plain))
    const tried = await postFromPage(page, `/api/factoring/loads/${encodeURIComponent(rules.loadKey(ACTIVE_PLAIN))}`, { factored: true, reason: REASON })
    record('O-post', 'The marking route is off', '404 FEATURE_OFF; no row', `${tried.status} ${tried.body.code}, row ${JSON.stringify(s.marker(ACTIVE_PLAIN))}`, tried.status === 404 && tried.body.code === 'FEATURE_OFF' && s.marker(ACTIVE_PLAIN) === null)
    if (openedPlain) await closeLoad(page)

    const completed = await openTab(page, 'Completed')
    const opened = completed && await openLoad(page, TO_MARK)
    if (!opened) {
      record('O-open', 'Completed Loads opens the load the script marked', 'the load dialog', `mark ${JSON.stringify(premark)}, listed ${completed}, opened ${opened}`, false)
      return
    }
    const marked = await controlsOf(page)
    const words = await pressDraftInvoice(page)
    const file = await shot(page, 'O-script-marked')
    record('O-marked', 'A load the lead\'s script marked: the chip only, and refused all the same', `"${WORDS.chip}"; no line, no reason box, no button; "${WORDS.refused}"; nothing reaches prepare()`,
      `${JSON.stringify(marked)}, words "${words}", reached prepare ${JSON.stringify(s.reachedPrepare)}`, showsChipOnly(marked) && words === WORDS.refused && s.reachedPrepare.length === 0, file)
  } finally {
    await ctx.close()
    s.db.close()
  }
}

// ---------------------------------------------------------------- G: nothing left this machine
function wireStep() {
  const hosts = [...offHost].sort()
  const mailHosts = hosts.filter((h) => /mail|imap|smtp/i.test(h))
  record('G', 'The browser stayed on this machine', 'no socket off this machine and no mail host asked (any other host it asked was aborted, and is only reported)',
    `sockets off this machine ${offHostSockets.length}, hosts aborted ${hosts.join(',') || 'none'}`, offHostSockets.length === 0 && mailHosts.length === 0)
}

async function main() {
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ASKED_PORT, HOST, resolve) })
  PORT = server.address().port
  if (PORT === 3000 || PORT === 5173) { server.close(); die(`the system picked port ${PORT}: set E2E_PORT to a free one`) }
  BASE = `http://${HOST}:${PORT}`
  console.log(`factoring-mark-usable: serving ${DIST} on ${BASE} (made-up data; no server.js, no mailbox)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const [name, run] of [['F', listedRun], ['N', notListedRun], ['O', settingsUnsetRun]]) {
      try {
        await run(browser)
      } catch (e) {
        record(name, 'The part ran to its end', 'no error', String(e && e.message).slice(0, 300), false)
      }
    }
  } finally {
    await browser.close()
    server.close()
  }
  wireStep()

  const resultsFile = path.join(paths.workDir(), 'results-factoring-mark-usable.md')
  const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    '# The factored mark: what a Super Admin sees', '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Other writes sent by the page (not part of the verdict): ${otherWrites.length ? otherWrites.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, out, { mode: 0o600 })
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`factoring-mark-usable: ${passed}/${rows.length} PASS, ${rows.length - passed} FAIL; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  if (pageErrors.length) console.log(`factoring-mark-usable: page errors: ${pageErrors.join(' | ')}`)
  process.exit(passed === rows.length ? 0 : 1)
}

main().catch((e) => {
  console.error(`factoring-mark-usable: aborted: ${e.stack || e}`)
  process.exit(1)
})
