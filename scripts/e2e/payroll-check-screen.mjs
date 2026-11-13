#!/usr/bin/env node
// LogisX — the before-payroll check's page (a Super Admin's, read only, linked from Invoices), on
// made-up data only, with PAYROLL_CHECK_ENABLED on in one made-up world and off in another:
//   PC1 1280 x 800, Super Admin: Invoices shows "Before-payroll check", after one ask of the route
//       with no week (the switch is on)
//   PC2 the link opens the page: one request for the last finished week (Oct 16, the business clock's
//       Saturday Oct 17), eight Fridays offered, the server's totals, every item under its driver and
//       week with its tag and the server's sentence, the roll-up; tables, no sideways scroll
//   PC3 another week picked: its request, and that week's answer on screen
//   PC4 a week wholly in closed September: the server's 400 words, no lists
//   PC5 the month locks unreadable: the server's 503 words and Try again; readable again, Try again
//       brings the lists back
//   PC6a 390 x 844, Super Admin: on Invoices the link sits wholly on screen, at least 40 px tall, nothing
//       on top of it, the header with no sideways scroll; a tap on it opens the page
//   PC6 390 x 844, Super Admin: the same page as cards, no table, no sideways scroll
//   PC6b 360 x 780, Super Admin: PC6a's checks on a narrower phone
//   PC7 the switch off: no link on Invoices after the route's 404; the page itself says it is not
//       switched on, with no week picker and no list
//   PC8 a Dispatcher, at both sizes: Invoices and the page send him away, no link, the route never asked
//   PCx per Super Admin page: no console error or warning, no page error; PCy: no write from any page
// Every answer for /api/admin/payroll-check comes from server.js's own route and payrollCheck(),
// lifted into this process by scripts/lib/work-days-world.js over an in-memory database of made-up
// drivers, loads, invoices and receipts (its clock: Sat 2026-10-17 12:00 ET; September closed). What
// the page should show comes from client/src/lib/payrollCheck.js, the functions the page uses.
//
// Like personal-tab-screen.mjs: no server.js process, app database, settings file, key or real
// sign-in. The checkout's built client/dist is served from 127.0.0.1, every other /api request is
// answered in the browser with made-up fixtures, and every other host is aborted.
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   node scripts/e2e/payroll-check-screen.mjs
// Env: E2E_PORT (default: a free port; 3000, 5173 and 3901 are refused), HEADED=1, CHROME_PATH,
// E2E_WORK_DIR, SHOT_DIR (an absolute folder outside the checkout; default
// ~/LogisX-replica/reports/cc/work/payroll-check-page/screens). Run it outside the Claude Code Bash
// sandbox (Chrome binds its own sockets). Output: PASS/FAIL lines, the screenshots and
// <work dir>/results-payroll-check-screen.md. Exit 0 only when every row PASSes.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'
import paths from './paths.cjs'
import { WORDS, checkView, weekOptions } from '../../client/src/lib/payrollCheck.js'

const require = createRequire(import.meta.url)

const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.homedir(), 'LogisX-replica', 'reports', 'cc', 'work', 'payroll-check-page', 'screens')
const DESKTOP = { tag: '1280x800', viewport: { width: 1280, height: 800 } }
const PHONE = { tag: '390x844', viewport: { width: 390, height: 844 } }
const SMALL_PHONE = { tag: '360x780', viewport: { width: 360, height: 780 } }

function die(msg) {
  console.error(`payroll-check-screen: ${msg}`)
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

// ---------------------------------------------------------------- the made-up world (server.js's own route)
// The server's clock and the browser's are one instant: Saturday Oct 17, 12:00 ET, so the last finished
// week ends Friday Oct 16 on both.
process.env.TZ = 'UTC'
const W = require('../lib/work-days-world.js')
const personalLib = require(path.join(paths.REPO, 'lib', 'personal-expense.js'))
const ROUTE = '/api/admin/payroll-check'
const ROUTE_KEY = `GET ${ROUTE}`
const NOW_MS = W.etMs('2026-10-17 12:00')
const TODAY = '2026-10-17'
const ENV_ON = { PAYROLL_CHECK_ENABLED: 'true', PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: 'true', PERSONAL_RECEIPT_WEEK_ENABLED: 'true' }

const AVERY = 'Avery Lund'
const BLAIR = 'Blair Moss'
const CASEY = 'Casey Rowe'
const DREW = 'Drew Pike'
const EMERY = 'Emery Tull' // paid by percentage
const FINLEY = 'Finley Hart'
const HARPER = 'Harper Quinn'
const GRAY = 'Gray Unlisted' // a receipt's driver no Drivers Database row names
const DRIVERS = [AVERY, BLAIR, CASEY, DREW, FINLEY, HARPER].map((name) => ({ name })).concat([{ name: EMERY, payType: 'percentage', payPct: 30 }])
const TRUCKS = DRIVERS.map((d, i) => ({ unit: `QA-T${i + 1}`, driver: d.name, owner: 5, vid: null }))
const unitOf = (driver) => TRUCKS.find((t) => t.driver === driver).unit
const L = (o) => W.loadRow({ truck: unitOf(o.driver), ...o })
const transit = { done: '', status: 'In Transit' }
const delivered = (day) => ({ 'Job Status': 'Delivered', 'Status Update Date': W.md(day), 'Completion Date': W.md(day) })

function rows() {
  return [
    // Avery: PE101 delivered 10/12, after the 10/3-10/9 invoice: 10/8 and 10/9 cross weeks.
    L({ id: 'PE100', driver: AVERY, pickup: '2026-10-05 8:00', dropoff: '2026-10-05 18:00', assigned: '2026-10-05', done: '2026-10-05' }),
    L({ id: 'PE101', driver: AVERY, pickup: '2026-10-08 8:00', dropoff: '2026-10-12 12:00', assigned: '2026-10-08', ...transit }),
    // Blair: 10/7 added on Driver Pay Overrides after the invoice.
    L({ id: 'PE201', driver: BLAIR, pickup: '2026-10-05 8:00', dropoff: '2026-10-06 12:00', assigned: '2026-10-05', done: '2026-10-06' }),
    // Casey: no weekly invoice for the week.
    L({ id: 'PE301', driver: CASEY, pickup: '2026-10-06 8:00', dropoff: '2026-10-07 12:00', assigned: '2026-10-06', done: '2026-10-07' }),
    // Drew: 10/13 removed on Driver Pay Overrides after the invoice paid it.
    L({ id: 'PE401', driver: DREW, pickup: '2026-10-12 8:00', dropoff: '2026-10-13 12:00', assigned: '2026-10-12', done: '2026-10-13' }),
    // Emery (percentage): PE502 delivered 10/9, after that week's invoice.
    L({ id: 'PE501', driver: EMERY, pickup: '2026-10-05 8:00', dropoff: '2026-10-06 12:00', assigned: '2026-10-05', done: '2026-10-06' }),
    L({ id: 'PE502', driver: EMERY, pickup: '2026-10-08 8:00', dropoff: '2026-10-09 12:00', assigned: '2026-10-08', ...transit }),
    // Finley: cross-week, its two early days on a correction Draft.
    L({ id: 'PE600', driver: FINLEY, pickup: '2026-10-05 8:00', dropoff: '2026-10-05 18:00', assigned: '2026-10-05', done: '2026-10-05' }),
    L({ id: 'PE601', driver: FINLEY, pickup: '2026-10-08 8:00', dropoff: '2026-10-12 12:00', assigned: '2026-10-08', ...transit }),
    // Harper: PE701 has a blank Pickup Appointment.
    L({ id: 'PE701', driver: HARPER, pickup: '', dropoff: '2026-10-07 12:00', assigned: '2026-10-06', done: '2026-10-07' }),
    L({ id: 'PE702', driver: HARPER, pickup: '2026-10-08 8:00', dropoff: '2026-10-08 18:00', assigned: '2026-10-08', done: '2026-10-08' }),
  ]
}

function addReceipt(db, { driver, date, amount, type = 'Fuel', status = 'Approved' }) {
  return Number(db.prepare("INSERT INTO expenses (timestamp, driver, load_id, type, amount, description, date, status) VALUES (?, ?, '', ?, ?, 'made-up', ?, ?)")
    .run(`${date}T15:00:00.000Z`, driver, type, amount, date, status).lastInsertRowid)
}
function addPersonalLine(db, { expenseId, cents, receiptDate, weekStart, carriedSince = '' }) {
  return Number(db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start,
    needs_correction_since, created_at, created_by, created_by_id, created_role) VALUES (?, 'deduct', ?, ?, 'Made-up Fuel Stop', ?, ?, 1, ?, ?, ?, '2026-10-10T14:00:00.000Z', 'made-up-admin', 1, 'Super Admin')`)
    .run(expenseId, cents, cents, receiptDate, receiptDate.slice(0, 7), receiptDate, weekStart, carriedSince).lastInsertRowid)
}
// A correction Draft for a weekly invoice's missed days, as the late-day settle leaves one.
function addCorrectionDraft(db, { number, driver, correctionOf, days }) {
  const lineItems = days.map((d) => ({ date: d, description: `Correction for its weekly invoice: ${d}, $260.00`, amount: 260 }))
  const render = { __templateName: 'service_invoice_manual', workDayCorrection: true, paidDays: days, lineItems, totalDue: 260 * days.length }
  db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, pdf_file_name,
    load_ids, expense_ids, render_data, is_manual, created_by, correction_of) VALUES (?, ?, '2026-10-03', '2026-10-09', ?, 0, ?, 0, 'Draft', ?, '[]', '[]', ?, 1, 'made-up-admin', ?)`)
    .run(number, driver.toLowerCase(), days.length, 260 * days.length, `${number}.pdf`, JSON.stringify(render), correctionOf)
}

// The made-up fleet through two Friday batches, then what happened after them (as scripts/test-payroll-check.js).
async function buildWorld() {
  const w = W.startWorld({ env: ENV_ON, drivers: DRIVERS, trucks: TRUCKS, rows: rows(), now: W.etMs('2026-10-09 20:00'), routes: [['get', ROUTE]], expose: ['payrollCheck'] })
  const steps = []
  const inv = {}
  const gen = async (driver, weekEnd) => {
    const g = await W.generate(w, driver, weekEnd)
    steps.push([`generate ${driver} ${weekEnd}`, g.status])
    if (g.invoice) inv[`${driver} ${weekEnd}`] = g.invoice
  }
  for (const d of [AVERY, BLAIR, EMERY, FINLEY, HARPER]) await gen(d, '2026-10-09')
  for (const id of ['PE101', 'PE601']) w.setRow(id, delivered('2026-10-12'))
  w.setRow('PE502', delivered('2026-10-09'))
  w.addOverrides([{ driver: BLAIR, day: '2026-10-07', action: 'add' }])
  const finley = inv[`${FINLEY} 2026-10-09`]
  if (finley) addCorrectionDraft(w.db, { number: 'INV-M-QA-2026W41-01', driver: FINLEY, correctionOf: finley.id, days: ['2026-10-08', '2026-10-09'] })
  w.clock.ms = W.etMs('2026-10-16 20:00')
  for (const d of [AVERY, DREW, FINLEY]) await gen(d, '2026-10-16')
  w.addOverrides([{ driver: DREW, day: '2026-10-13', action: 'remove' }])
  w.lock(['2026-09'])
  w.db.exec(personalLib.SCHEMA_SQL)
  const gray = addReceipt(w.db, { driver: GRAY, date: '2026-10-07', amount: 45.5 })
  addPersonalLine(w.db, { expenseId: gray, cents: 4550, receiptDate: '2026-10-07', weekStart: '2026-10-03', carriedSince: '2026-10-10T10:00:00.000Z' })
  const casey = addReceipt(w.db, { driver: CASEY, date: '2026-10-06', amount: 30 })
  addPersonalLine(w.db, { expenseId: casey, cents: 3000, receiptDate: '2026-10-06', weekStart: '2026-10-03' })
  addReceipt(w.db, { driver: AVERY, date: '2026-10-14', amount: 61.25, type: 'Maintenance', status: 'Pending' })
  w.clock.ms = NOW_MS
  return { w, steps }
}
// The same route with the switch off (a world with nothing in it: the route refuses before any read).
function offWorld() {
  return W.startWorld({ env: {}, now: NOW_MS, routes: [['get', ROUTE]], expose: ['payrollCheck'] })
}
async function serverAnswer(w, query = {}) {
  const r = await W.route(w, ROUTE_KEY, { query })
  return { status: r.status, body: JSON.parse(JSON.stringify(r.body)) }
}

// ---------------------------------------------------------------- the browser's other answers
const SUPER_ADMIN = { id: 1, username: 'super_admin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Payroll Super Admin', companyName: '', mustChangePassword: false }
const DISPATCHER = { id: 3, username: 'dispatch1', role: 'Dispatcher', driverName: '', email: '', fullName: 'QA Payroll Dispatcher', companyName: '', mustChangePassword: false }

function fixtureGet(who, pathname) {
  const ok = (body) => ({ status: 200, body })
  if (pathname === '/api/auth/session') return ok({ authenticated: true, user: who, appTimeZone: 'America/New_York' })
  if (pathname === '/api/auth/setup-check') return ok({ needsSetup: false })
  if (pathname === '/api/invoices') return ok({ invoices: [], summary: null })
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
    res.end('{"error":"not served by the payroll check screen check"}')
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
const rows_ = []
const writes = []
const unanswered = new Set()
const offHost = new Set()
const notJudged = []
let exitCode = 0
const ONE_LINE = (s) => String(s).replace(/\r?\n/g, ' ')
function record(step, title, expected, observed, ok, shot = '') {
  const verdict = ok ? 'PASS' : 'FAIL'
  if (!ok) exitCode = 1
  rows_.push({ step, title, expected, observed, verdict, shot })
  console.log(`${verdict}  ${step}  ${title}: ${ONE_LINE(observed)}`)
}
async function shot(page, name, opts = {}) {
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(SHOT_DIR, `payroll-check-${name}.png`)
  await page.screenshot({ path: file, ...opts })
  return file
}

// ---------------------------------------------------------------- page helpers
const NOISE = /Failed to load resource|net::ERR|socket\.io|WebSocket/i
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim()
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function openPage(browser, size, who, world, state, startPath) {
  const phone = size.viewport.width < 640
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block', timezoneId: 'Asia/Manila' })
  await ctx.clock.setFixedTime(new Date(NOW_MS))
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) { offHost.add(u.host); return route.abort() }
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (req.method() !== 'GET') {
      writes.push(`${size.tag} ${who.role} ${req.method()} ${u.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    let out
    if (u.pathname === ROUTE) {
      state.checks.push(u.search)
      // The real route's gate answers any other role 403 before it reads anything.
      out = who.role === 'Super Admin' ? await serverAnswer(world, Object.fromEntries(u.searchParams)) : { status: 403, body: { error: 'Forbidden' } }
    } else {
      out = fixtureGet(who, u.pathname)
      if (out === null) unanswered.add(u.pathname)
    }
    return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', body: JSON.stringify(out ? out.body : {}) })
  })
  const page = await ctx.newPage()
  const issues = []
  page.on('pageerror', (e) => issues.push(`pageerror ${String(e.message || e).slice(0, 160)}`))
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return
    if (NOISE.test(m.text())) return
    issues.push(`${m.type()} ${m.text().slice(0, 160)}`)
  })
  await page.goto(`${BASE}${startPath}`, { waitUntil: 'domcontentloaded' })
  return { ctx, page, issues }
}

async function appears(page, selector, ms = 10000) {
  try { await page.waitForSelector(selector, { state: 'visible', timeout: ms }); return true } catch { return false }
}
async function waitForChecks(state, n, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (state.checks.length >= n) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
async function waitForText(page, selector, text, ms = 10000) {
  try {
    await page.waitForFunction(([s, t]) => { const el = document.querySelector(s); return !!el && el.textContent.replace(/\s+/g, ' ').includes(t) }, [selector, text], { timeout: ms })
    return true
  } catch { return false }
}

// What the page shows, read the same way for its tables and its cards.
async function shownParts(page) {
  return page.evaluate(() => {
    const t = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
    return [...document.querySelectorAll('[data-part]')].map((p) => ({
      key: p.getAttribute('data-part'),
      groups: [...p.querySelectorAll('[data-testid="pc-group"]')].map(t),
      rows: [...p.querySelectorAll('[data-testid="pc-row"], [data-testid="pc-card"]')].map((r) => ({
        cells: [...r.querySelectorAll('[data-cell]')].map(t),
        tag: t(r.querySelector('[data-testid="pc-tag"]')),
        why: t(r.querySelector('[data-testid="pc-why"]')),
      })),
    }))
  })
}
const expectParts = (view) => view.sections.flatMap((s) => s.parts).map((pt) => ({
  key: pt.key,
  groups: pt.groups.map((g) => clean(g.label)),
  rows: pt.groups.flatMap((g) => g.rows.map((r) => ({ cells: pt.columns.map((c) => clean(r.cells[c.key])), tag: pt.reasons ? clean(r.tag) : '', why: pt.reasons ? clean(r.text) : '' }))),
}))
const shownTotals = (page) => page.$$eval('[data-testid="pc-total"]', (els) => els.map((e) => [e.getAttribute('data-key'),
  e.querySelector('[data-testid="pc-total-count"]').textContent.trim(), e.querySelector('[data-testid="pc-total-amount"]').textContent.trim()]))
const expectTotals = (view) => view.totals.map((t) => [t.key, String(t.count), t.amount])
// A table row's cells, one space between them (their own text has none between cells).
const shownRollup = (page) => page.$$eval('[data-testid="pc-rollup-row"]', (els) => els.map((e) => [...e.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' ')))
const expectRollupTable = (view) => view.drivers.map((r) => clean([r.driver, r.week, ...r.cells.map((c) => c.text)].join(' ')))
const rowCount = (parts) => parts.reduce((n, p) => n + p.rows.length, 0)
const describe = (parts) => parts.map((p) => `${p.key}:${p.rows.length}`).join(' ')
async function noSidewaysScroll(page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement
    const pg = document.querySelector('[data-testid="pc-page"]')
    return { page: doc.scrollWidth <= window.innerWidth + 1, panel: !pg || pg.scrollWidth <= pg.clientWidth + 1, width: doc.scrollWidth, inner: window.innerWidth }
  })
}
async function judgeConsole(step, issues) {
  record(step, 'The console is clean', 'no console error or warning, no page error', issues.length ? issues.join(' | ') : 'clean', issues.length === 0)
}

// ---------------------------------------------------------------- the runs
async function desktopRun(browser, w) {
  const state = { checks: [] }
  const weeks = weekOptions(TODAY)
  const a16 = await serverAnswer(w, { weekEnd: '2026-10-16' })
  const a09 = await serverAnswer(w, { weekEnd: '2026-10-09' })
  const a25 = await serverAnswer(w, { weekEnd: '2026-09-25' })
  const v16 = checkView(a16.body)
  const v09 = checkView(a09.body)
  const { ctx, page, issues } = await openPage(browser, DESKTOP, SUPER_ADMIN, w, state, '/invoices')
  try {
    const linked = await appears(page, '[data-testid="payroll-check-link"]', 15000)
    const linkText = linked ? clean(await page.locator('[data-testid="payroll-check-link"]').textContent()) : ''
    record('PC1', 'Invoices: the link shows for a Super Admin once the route says the switch is on',
      `"${WORDS.link}" in the header; exactly one ask of ${ROUTE} with no week (answered 400, the missing week)`,
      `link ${linked ? `"${linkText}"` : 'absent'}; asks ${JSON.stringify(state.checks)}`,
      linked && linkText === WORDS.link && same(state.checks, ['']),
      await shot(page, '1-invoices-link-1280'))

    if (linked) await page.locator('[data-testid="payroll-check-link"]').click()
    else await page.goto(`${BASE}/invoices/payroll-check`, { waitUntil: 'domcontentloaded' })
    const ready = await appears(page, '[data-testid="pc-scope"]', 15000)
    await page.waitForTimeout(300)
    const url = new URL(page.url()).pathname
    const select = await page.$eval('[data-testid="pc-week"]', (s) => ({ value: s.value, options: [...s.options].map((o) => [o.value, o.textContent.trim()]) })).catch(() => null)
    const parts = ready ? await shownParts(page) : []
    const totals = ready ? await shownTotals(page) : []
    const rollup = ready ? await shownRollup(page) : []
    const tables = await page.locator('table.pc-table').count()
    const cards = await page.locator('[data-testid="pc-card"]').count()
    const scroll = await noSidewaysScroll(page)
    const top = await shot(page, '2-check-week-oct16-1280')
    const full = await shot(page, '3-check-week-oct16-1280-full', { fullPage: true })
    record('PC2', 'The page: the last finished week asked, the server\'s totals, every item with its tag and sentence, the roll-up',
      `/invoices/payroll-check; ask ?weekEnd=2026-10-16; weeks ${JSON.stringify(weeks.map((x) => x.value))} with Oct 16 chosen; totals ${JSON.stringify(v16 && expectTotals(v16))}; lists ${v16 && describe(expectParts(v16))}; ${v16 && v16.drivers.length} roll-up rows; tables, no cards, no sideways scroll`,
      `${url}; asks ${JSON.stringify(state.checks)}; week ${select && select.value} of ${select && select.options.length}; totals ${JSON.stringify(totals)}; lists ${describe(parts)}; roll-up ${rollup.length}; tables ${tables}, cards ${cards}; scroll ${JSON.stringify(scroll)}; screens ${path.basename(top)}, ${path.basename(full)}`,
      ready && !!v16 && url === '/invoices/payroll-check' && same(state.checks, ['', '?weekEnd=2026-10-16']) && !!select && select.value === '2026-10-16'
        && same(select.options, weeks.map((x) => [x.value, x.label])) && same(totals, expectTotals(v16)) && same(parts, expectParts(v16))
        && same(rollup, expectRollupTable(v16)) && tables > 0 && cards === 0 && scroll.page && scroll.panel,
      top)
    record('PC2b', 'The made-up world reaches every list (so PC2 compares something in each)',
      'each of the six lists holds an item for the week of Oct 10-16', v16 ? describe(expectParts(v16)) : `no view (${a16.status})`,
      !!v16 && expectParts(v16).every((p) => p.rows.length > 0))

    const before = state.checks.length
    await page.selectOption('[data-testid="pc-week"]', '2026-10-09')
    await waitForChecks(state, before + 1)
    const shown09 = v09 && await waitForText(page, '[data-testid="pc-scope"]', v09.weekText)
    await page.waitForTimeout(300)
    const parts09 = await shownParts(page)
    const totals09 = await shownTotals(page)
    record('PC3', 'Another week picked: its request, and that week\'s answer on screen',
      `ask ?weekEnd=2026-10-09; "${v09 && v09.weekText}"; totals ${JSON.stringify(v09 && expectTotals(v09))}; lists ${v09 && describe(expectParts(v09))}`,
      `asks ${JSON.stringify(state.checks.slice(before))}; week shown ${shown09}; totals ${JSON.stringify(totals09)}; lists ${describe(parts09)}`,
      !!v09 && same(state.checks.slice(before), ['?weekEnd=2026-10-09']) && shown09 && same(totals09, expectTotals(v09)) && same(parts09, expectParts(v09)),
      await shot(page, '4-check-week-oct9-1280'))

    const b2 = state.checks.length
    await page.selectOption('[data-testid="pc-week"]', '2026-09-25')
    await waitForChecks(state, b2 + 1)
    const refusedShown = await appears(page, '[data-testid="pc-refused"]')
    const refusedText = refusedShown ? clean(await page.locator('[data-testid="pc-refused"]').textContent()) : ''
    const listsLeft = await page.locator('[data-part]').count()
    record('PC4', 'A week wholly in closed September: the server\'s own 400 words, no lists',
      `${a25.status} ${a25.body && a25.body.code}: "${a25.body && a25.body.error}"; no list; the week picker still there`,
      `"${refusedText}"; lists ${listsLeft}; picker ${await page.locator('[data-testid="pc-week"]').count()}`,
      a25.status === 400 && refusedText === clean(a25.body.error) && listsLeft === 0 && await page.locator('[data-testid="pc-week"]').count() === 1,
      await shot(page, '5-closed-week-refused-1280'))

    await page.selectOption('[data-testid="pc-week"]', '2026-10-16')
    await appears(page, '[data-testid="pc-scope"]')
    w.db.exec('ALTER TABLE period_locks RENAME TO period_locks_e2e_hidden')
    let a503 = null
    let retryText = ''
    let retryButton = 0
    let retryShot = ''
    try {
      a503 = await serverAnswer(w, { weekEnd: '2026-10-16' })
      const b3 = state.checks.length
      await page.locator('[data-testid="pc-again"]').click()
      await waitForChecks(state, b3 + 1)
      if (await appears(page, '[data-testid="pc-retry"]')) {
        retryText = clean(await page.locator('[data-testid="pc-retry"]').textContent())
        retryButton = await page.locator('[data-testid="pc-try-again"]').count()
      }
      retryShot = await shot(page, '6-locks-unreadable-retry-1280')
    } finally {
      w.db.exec('ALTER TABLE period_locks_e2e_hidden RENAME TO period_locks')
    }
    const b4 = state.checks.length
    if (retryButton) await page.locator('[data-testid="pc-try-again"]').click()
    await waitForChecks(state, b4 + 1)
    const back = await appears(page, '[data-testid="pc-scope"]')
    await page.waitForTimeout(300)
    const partsBack = back ? await shownParts(page) : []
    record('PC5', 'The month locks unreadable: the server\'s 503 words and Try again; readable again, Try again brings the lists back',
      `${a503 && a503.status} ${a503 && a503.body && a503.body.code}: "${a503 && a503.body && a503.body.error}" with "${WORDS.retry}"; then ${v16 && rowCount(expectParts(v16))} items again`,
      `"${retryText}"; Try again ${retryButton}; after it: ${back ? `${rowCount(partsBack)} items` : 'no lists'}`,
      !!a503 && a503.status === 503 && retryText.startsWith(clean(a503.body.error)) && retryText.endsWith(WORDS.retry) && retryButton === 1 && back && !!v16 && same(partsBack, expectParts(v16)),
      retryShot)
  } finally {
    await judgeConsole('PCx-sa-1280', issues)
    await ctx.close()
  }
}

// The Invoices link on a phone: wholly on screen, tall enough for a finger, nothing over its middle,
// and the header no wider than itself; then a tap on it opens the page. Returns whether it did.
async function phoneLinkRow(page, size, step, shotName) {
  const width = size.viewport.width
  const linked = await appears(page, '[data-testid="payroll-check-link"]', 15000)
  if (linked) await page.locator('[data-testid="payroll-check-link"]').scrollIntoViewIfNeeded().catch(() => {})
  const fit = await page.evaluate(() => {
    const a = document.querySelector('[data-testid="payroll-check-link"]')
    const h = document.querySelector('.inv-header')
    const r = a ? a.getBoundingClientRect() : null
    const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null
    const one = (n) => Math.round(n * 10) / 10
    return {
      link: r ? { left: one(r.left), right: one(r.right), height: one(r.height) } : null,
      onTop: !!(a && hit && (hit === a || a.contains(hit))),
      header: h ? { scrollWidth: h.scrollWidth, clientWidth: h.clientWidth, left: one(h.getBoundingClientRect().left), right: one(h.getBoundingClientRect().right) } : null,
    }
  })
  const file = await shot(page, shotName)
  let opened = false
  if (linked) {
    await page.locator('[data-testid="payroll-check-link"]').tap({ timeout: 5000 }).catch(() => {})
    opened = await page.waitForURL('**/invoices/payroll-check', { timeout: 10000 }).then(() => true, () => false)
  }
  record(step, `${width} x ${size.viewport.height}: on Invoices the link is wholly on screen and tappable, and the header doesn't scroll sideways`,
    `the link inside 0..${width}, at least 40 px tall, nothing over its middle; the header's scroll width within its own width and inside 0..${width}; a tap opens /invoices/payroll-check`,
    `link ${fit.link ? JSON.stringify(fit.link) : 'absent'}; nothing over it ${fit.onTop}; header ${JSON.stringify(fit.header)}; the tap opened the page ${opened}`,
    linked && !!fit.link && fit.link.left >= 0 && fit.link.right <= width && fit.link.height >= 40 && fit.onTop
      && !!fit.header && fit.header.scrollWidth <= fit.header.clientWidth + 1 && fit.header.left >= -1 && fit.header.right <= width + 1 && opened,
    file)
  return opened
}

async function phoneRun(browser, w) {
  const state = { checks: [] }
  const v16 = checkView((await serverAnswer(w, { weekEnd: '2026-10-16' })).body)
  const { ctx, page, issues } = await openPage(browser, PHONE, SUPER_ADMIN, w, state, '/invoices')
  try {
    const opened = await phoneLinkRow(page, PHONE, 'PC6a', '6a-invoices-header-390')
    if (!opened) await page.goto(`${BASE}/invoices/payroll-check`, { waitUntil: 'domcontentloaded' })
    const ready = await appears(page, '[data-testid="pc-scope"]', 15000)
    await page.waitForTimeout(300)
    const parts = ready ? await shownParts(page) : []
    const tables = await page.locator('table').count()
    const rollup = await page.locator('[data-testid="pc-rollup-row"]').count()
    const scroll = await noSidewaysScroll(page)
    const top = await shot(page, '7-check-390')
    await page.locator('[data-testid="pc-card"]').first().scrollIntoViewIfNeeded().catch(() => {})
    const cardsShot = await shot(page, '8-check-390-cards')
    const full = await shot(page, '9-check-390-full', { fullPage: true })
    record('PC6', '390 x 844: the same lists as cards, no table, no sideways scroll',
      `${v16 && rowCount(expectParts(v16))} cards, each the view's cells, tag and sentence; ${v16 && v16.drivers.length} roll-up cards; no table; the page fits`,
      `opened by the link ${opened}; lists ${describe(parts)}; tables ${tables}; roll-up ${rollup}; scroll ${JSON.stringify(scroll)}; screens ${[top, cardsShot, full].map((f) => path.basename(f)).join(', ')}`,
      ready && !!v16 && same(parts, expectParts(v16)) && tables === 0 && rollup === v16.drivers.length && scroll.page && scroll.panel,
      top)
  } finally {
    await judgeConsole('PCx-sa-390', issues)
    await ctx.close()
  }
}

async function smallPhoneRun(browser, w) {
  const state = { checks: [] }
  const { ctx, page, issues } = await openPage(browser, SMALL_PHONE, SUPER_ADMIN, w, state, '/invoices')
  try {
    if (await phoneLinkRow(page, SMALL_PHONE, 'PC6b', '6b-invoices-header-360')) {
      await appears(page, '[data-testid="pc-scope"]', 15000)
      await shot(page, '6c-check-360')
    }
  } finally {
    await judgeConsole('PCx-sa-360', issues)
    await ctx.close()
  }
}

async function offRun(browser) {
  const w = offWorld()
  const state = { checks: [] }
  const { ctx, page, issues } = await openPage(browser, DESKTOP, SUPER_ADMIN, w, state, '/invoices')
  try {
    await appears(page, 'h2', 15000)
    await waitForChecks(state, 1)
    await page.waitForTimeout(800)
    const links = await page.locator('[data-testid="payroll-check-link"]').count()
    const invShot = await shot(page, '10-switch-off-invoices-1280')
    record('PC7', 'Switched off: no link on Invoices after the route\'s 404',
      `one ask of ${ROUTE} with no week, answered 404 FEATURE_OFF; no link`,
      `asks ${JSON.stringify(state.checks)}; links ${links}`,
      same(state.checks, ['']) && links === 0, invShot)
    const b = state.checks.length
    await page.goto(`${BASE}/invoices/payroll-check`, { waitUntil: 'domcontentloaded' })
    const off = await appears(page, '[data-testid="pc-off"]', 15000)
    const offText = off ? clean(await page.locator('[data-testid="pc-off"]').textContent()) : ''
    const pickers = await page.locator('[data-testid="pc-week"]').count()
    const lists = await page.locator('[data-part]').count()
    record('PC7b', 'Switched off, the page itself: it says so, with no week picker and no list',
      `"${WORDS.off}"; no picker; no list; its one ask answered 404`,
      `"${offText}"; pickers ${pickers}; lists ${lists}; asks ${JSON.stringify(state.checks.slice(b))}`,
      offText === WORDS.off && pickers === 0 && lists === 0 && same(state.checks.slice(b), ['?weekEnd=2026-10-16']),
      await shot(page, '11-switch-off-page-1280'))
  } finally {
    await judgeConsole('PCx-off-1280', issues)
    await ctx.close()
    w.db.close()
  }
}

async function dispatcherRun(browser, w, size) {
  const state = { checks: [] }
  const { ctx, page, issues } = await openPage(browser, size, DISPATCHER, w, state, '/invoices')
  try {
    await page.waitForFunction(() => location.pathname !== '/invoices', null, { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(800)
    const fromInvoices = new URL(page.url()).pathname
    const linksThere = await page.locator('[data-testid="payroll-check-link"]').count()
    await page.goto(`${BASE}/invoices/payroll-check`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => location.pathname !== '/invoices/payroll-check', null, { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(800)
    const fromPage = new URL(page.url()).pathname
    const pages = await page.locator('[data-testid="pc-page"]').count()
    record(`PC8-${size.tag}`, 'A Dispatcher: Invoices and the page send him away; no link; the route never asked',
      'sent from /invoices and from /invoices/payroll-check; no link; no page; 0 asks of the route',
      `/invoices -> ${fromInvoices}; /invoices/payroll-check -> ${fromPage}; links ${linksThere}; pages ${pages}; asks ${state.checks.length}`,
      fromInvoices !== '/invoices' && fromPage !== '/invoices/payroll-check' && linksThere === 0 && pages === 0 && state.checks.length === 0,
      await shot(page, `12-dispatcher-${size.tag}`))
  } finally {
    // The Dispatcher lands on the dashboard, whose other answers here are made-up stand-ins: listed, not judged.
    if (issues.length) notJudged.push(`Dispatcher ${size.tag} console: ${issues.join(' | ')}`)
    await ctx.close()
  }
}

async function main() {
  paths.warnNodeVersion('payroll-check-screen')
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use: set E2E_PORT to a free one`)
  const { w, steps } = await buildWorld()
  record('PC0', 'The made-up world: every Friday batch\'s invoice was made',
    'each generate 200', JSON.stringify(steps), steps.length === 8 && steps.every(([, s]) => s === 200))
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ASKED_PORT, HOST, resolve) })
  PORT = server.address().port
  if ([3000, 5173, 3901].includes(PORT)) { server.close(); die(`the system picked port ${PORT}: set E2E_PORT to a free one`) }
  BASE = `http://${HOST}:${PORT}`
  console.log(`payroll-check-screen: serving ${DIST} on ${BASE} (made-up data; no server.js process)`)
  let browser = null
  try {
    browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
    for (const [name, fn] of [['desktop', () => desktopRun(browser, w)], ['phone', () => phoneRun(browser, w)], ['phone-360', () => smallPhoneRun(browser, w)], ['switch-off', () => offRun(browser)],
      ['dispatcher-1280', () => dispatcherRun(browser, w, DESKTOP)], ['dispatcher-390', () => dispatcherRun(browser, w, PHONE)]]) {
      try { await fn() } catch (e) { record(`PC!-${name}`, `${name} run aborted`, 'no abort', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
    }
    record('PCy', 'No page sends a write', 'no POST, PUT, PATCH or DELETE from any page', writes.join(', ') || 'none', writes.length === 0)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await new Promise((r) => server.close(() => r()))
    w.db.close()
    W.cleanup()
  }
  const resultsFile = path.join(paths.workDir(), 'results-payroll-check-screen.md')
  const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    '# Before-payroll check page (made-up data; PAYROLL_CHECK_ENABLED on, and off in PC7)', '',
    `Build: ${DIST}. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows_.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Not part of the verdict: ${notJudged.map(esc).join('; ') || 'nothing'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Requests to another host, aborted (not part of the verdict): ${[...offHost].sort().join(', ') || 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, out, { mode: 0o600 })
  const passed = rows_.filter((r) => r.verdict === 'PASS').length
  console.log(`payroll-check-screen: ${passed}/${rows_.length} PASS; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  for (const n of notJudged) console.log(`  (not judged) ${n}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`payroll-check-screen: aborted: ${e.stack || e}`)
  process.exit(1)
})
