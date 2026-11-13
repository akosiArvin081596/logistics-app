#!/usr/bin/env node
// LogisX — the Personal tab on Expenses (a Super Admin's list of each driver's Personal lines and
// their total, read only), on made-up data only, with the receipt's week switched on
// (PERSONAL_RECEIPT_WEEK_ENABLED, as production has it):
//   PT1 1280 x 800, Super Admin: "Personal" is the sub-tab right after "All Expenses"; opened, the
//       table lists every driver's lines, newest receipt date first, and the total is the server's
//   PT2 the driver box: "Test Driver A" picked, the request names him, only his lines list, each row's
//       tag is the short tag the Expenses table shows with the full sentence as its hover text, and
//       the total and the reversed line beside it are the server's for him
//   PT3 the dates: Oct 12 to Oct 12 sent as from/to, only that day's lines and their total; Clear
//       filters brings every line back
//   PT4 390 x 844, Super Admin: the same tab as cards, the driver picked, each card's full sentence,
//       the total, no sideways scroll
//   PT5 a Dispatcher, at both sizes: no Personal sub-tab, and the list route is never asked
//   PTx per page: no console error or warning, no page error; the tab sends no write
// Every answer for /api/expenses/personal/lines, /api/expenses/all and the waiting list comes from
// server.js's own routes, lifted into this process by scripts/lib/personal-world.js over an
// in-memory database of made-up drivers and receipts (its clock: Thu 2026-10-15), seeded through
// the world's own mark, undo and invoice routes. What a row should show comes from
// client/src/lib/personalReceipt.js, the functions the receipts use.
//
// Like receipts-auto-approve-screens.mjs: no server.js process, app database, settings file, key or
// real sign-in. The checkout's built client/dist is served from 127.0.0.1, every other /api request
// is answered in the browser with made-up fixtures, and every other host is aborted.
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   node scripts/e2e/personal-tab-screen.mjs
// Env: E2E_PORT (default: a free port; 3000, 5173 and 3901 are refused), HEADED=1, CHROME_PATH,
// E2E_WORK_DIR, SHOT_DIR (an absolute folder outside the checkout; default
// ~/LogisX-replica/reports/cc/work/personal-tab/screens). Run it outside the Claude Code Bash
// sandbox (Chrome binds its own sockets). Output: PASS/FAIL lines, the screenshots and
// <work dir>/results-personal-tab-screen.md. Exit 0 only when every row PASSes.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'
import paths from './paths.cjs'
import { personalPillText, personalShortText } from '../../client/src/lib/personalReceipt.js'

const require = createRequire(import.meta.url)
const { buildPersonalWorld } = require('../lib/personal-world.js')

const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.homedir(), 'LogisX-replica', 'reports', 'cc', 'work', 'personal-tab', 'screens')
const DESKTOP = { tag: '1280x800', viewport: { width: 1280, height: 800 } }
const PHONE = { tag: '390x844', viewport: { width: 390, height: 844 } }

function die(msg) {
  console.error(`personal-tab-screen: ${msg}`)
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
const LINES_HEAD = 'app.get("/api/expenses/personal/lines", requireRole("Super Admin"), personalLinesLimiter, (req, res) => {'
const WEEK_ON = { PERSONAL_EXPENSE_DEDUCTIONS_ENABLED: 'true', PERSONAL_RECEIPT_WEEK_ENABLED: 'true' }
const DRIVER_A = 'Test Driver A'

function addReceipt(w, { id, driver, type, amount, date, vendor, truck, owner }) {
  w.db.prepare(`INSERT INTO expenses (id, timestamp, driver, type, amount, date, status, vendor, truck_unit, owner_id, created_at, description)
    VALUES (?, ?, ?, ?, ?, ?, 'Approved', ?, ?, ?, ?, '')`).run(id, `${date}T15:00:00.000Z`, driver, type, amount, date, vendor, truck, owner, `${date} 15:00:00`)
}
// A reversal as the reverse route leaves one: a 'reverse' row naming the receipt's live charge, and
// the charge pointing back at it (neither on an invoice).
function reverseByHand(w, expenseId) {
  const d = w.lines("expense_id = ? AND kind = 'deduct' AND voided_at = '' AND reversed_by_id IS NULL", expenseId)[0]
  const id = Number(w.db.prepare(`INSERT INTO expense_personal (expense_id, kind, reverses_id, cents, receipt_cents, merchant, receipt_date, cost_period, in_place, book_date, week_start, created_at, created_by, created_by_id, created_role)
    VALUES (?, 'reverse', ?, ?, ?, ?, ?, ?, ?, ?, ?, 't', 'super_admin', 1, 'Super Admin')`)
    .run(expenseId, d.id, d.cents, d.receipt_cents, d.merchant, d.receipt_date, d.cost_period, d.in_place, d.book_date, d.week_start).lastInsertRowid)
  w.db.prepare('UPDATE expense_personal SET reversed_by_id = ? WHERE id = ?').run(id, d.id)
}

// The lines, one per state the tab can show (clock Thu 2026-10-15; the week Sat Oct 10 - Fri Oct 16):
//   Test Driver A   R1 $200.00 and R5 $50.00 on his Draft weekly invoice ("on <number>");
//                   R50 $25.00 marked, then reversed ("reversed")
//   Test Driver B   R11 $30.00 waiting for its week's invoice ("waiting"); R51 $80.00 dated Sep 28
//                   (closed September), carried to his next weekly invoice ("carried")
//   Test Owner Op   R7 $120.00 of a $700.00 fuel receipt, on his weekly invoice, approved ("final");
//                   R8 marked, then undone (not listed)
async function buildWorld() {
  const w = buildPersonalWorld({ env: WEEK_ON, receipts: true, extra: { routes: { personalLines: LINES_HEAD }, tag: 'personal-lines' } })
  addReceipt(w, { id: 50, driver: DRIVER_A, type: 'Food', amount: 25, date: '2026-10-12', vendor: 'EXAMPLE DINER #3', truck: 'T-1', owner: 7 })
  addReceipt(w, { id: 51, driver: 'Test Driver B', type: 'Fuel', amount: 80, date: '2026-09-28', vendor: 'EXAMPLE FUEL #12', truck: 'T-3', owner: 0 })
  const steps = []
  const mark = async (id, body = {}) => steps.push([`mark R${id}`, (await w.call('POST', `/api/expenses/${id}/personal`, { body })).status])
  await mark(1)
  await mark(5, { amount: 50 })
  await mark(50)
  reverseByHand(w, 50)
  await mark(11)
  await mark(51)
  await mark(7, { amount: 120 })
  await mark(8)
  steps.push(['undo R8', (await w.call('DELETE', '/api/expenses/8/personal', { body: {} })).status])
  const a = await w.generate(DRIVER_A)
  steps.push(['generate A', a.status])
  const op = await w.generate('Test Owner Op')
  steps.push(['generate Op', op.status])
  if (op.body && op.body.invoice) w.db.prepare("UPDATE invoices SET status = 'Approved', approved_at = 't', approved_by = 'super_admin' WHERE id = ?").run(op.body.invoice.id)
  return { w, steps }
}

// What the route answers in-process, for the expected values.
async function serverList(w, query = {}) {
  const r = await w.call('GET', '/api/expenses/personal/lines', { query })
  return JSON.parse(JSON.stringify(r.body))
}

// ---------------------------------------------------------------- the browser's other answers
const SUPER_ADMIN = { id: 1, username: 'super_admin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Personal Super Admin', companyName: '', mustChangePassword: false }
const DISPATCHER = { id: 3, username: 'dispatch1', role: 'Dispatcher', driverName: '', email: '', fullName: 'QA Personal Dispatcher', companyName: '', mustChangePassword: false }
// The world's own users: the session and the route's role check agree.
const WORLD_USER = { 'Super Admin': 'admin', Dispatcher: 'dispatcher' }
const WORLD_ROUTES = new Set(['/api/expenses/personal/lines', '/api/expenses/all', '/api/expenses/personal/waiting-corrections'])

function fixtureGet(who, pathname) {
  const ok = (body) => ({ status: 200, body })
  if (pathname === '/api/auth/session') return ok({ authenticated: true, user: who, appTimeZone: 'America/New_York' })
  if (pathname === '/api/auth/setup-check') return ok({ needsSetup: false })
  if (pathname === '/api/trucks') return ok({ data: [{ UnitNumber: 'T-1' }, { UnitNumber: 'T-2' }, { UnitNumber: 'T-3' }] })
  if (pathname === '/api/drivers-directory') return ok({ data: [{ Driver: DRIVER_A }, { Driver: 'Test Driver B' }, { Driver: 'Test Owner Op' }] })
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
    res.end('{"error":"not served by the Personal tab check"}')
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
const offHost = new Set()
let exitCode = 0
const ONE_LINE = (s) => String(s).replace(/\r?\n/g, ' ')
function record(step, title, expected, observed, ok, shot = '') {
  const verdict = ok ? 'PASS' : 'FAIL'
  if (!ok) exitCode = 1
  rows.push({ step, title, expected, observed, verdict, shot })
  console.log(`${verdict}  ${step}  ${title}: ${ONE_LINE(observed)}`)
}
async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(SHOT_DIR, `personal-tab-${name}.png`)
  await page.screenshot({ path: file })
  return file
}

// ---------------------------------------------------------------- page helpers
const NOISE = /Failed to load resource|net::ERR|socket\.io|WebSocket/i
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim()

async function openPage(browser, size, who, w, state) {
  const phone = size.viewport.width < 640
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
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
    if (WORLD_ROUTES.has(u.pathname)) {
      if (u.pathname === '/api/expenses/personal/lines') state.listUrls.push(u.search)
      const query = {}
      for (const [k, v] of u.searchParams) query[k] = k in query ? [].concat(query[k], v) : v
      const r = await w.call('GET', u.pathname, { as: WORLD_USER[who.role], query })
      out = { status: r.status, body: JSON.parse(JSON.stringify(r.body)) }
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
  await page.goto(`${BASE}/expenses`, { waitUntil: 'domcontentloaded' })
  return { ctx, page, issues }
}

async function appears(page, selector, ms = 10000) {
  try { await page.waitForSelector(selector, { state: 'visible', timeout: ms }); return true } catch { return false }
}
async function waitForCount(page, selector, n, ms = 8000) {
  try { await page.waitForFunction(([s, k]) => document.querySelectorAll(s).length === k, [selector, n], { timeout: ms }); return true } catch { return false }
}
async function waitForRequests(state, n, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (state.listUrls.length >= n) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
const subTabs = (page) => page.locator('.sub-tab').allTextContents().then((l) => l.map(clean), () => [])
const PANEL = '.personal-lines'
const totalOf = async (page) => ({
  scope: clean(await page.locator(`${PANEL} .pl-total-scope`).textContent({ timeout: 3000 }).catch(() => '')),
  amount: clean(await page.locator(`${PANEL} .pl-total-amount`).textContent({ timeout: 3000 }).catch(() => '')),
  count: clean(await page.locator(`${PANEL} .pl-total-count`).textContent({ timeout: 3000 }).catch(() => '')),
  reversed: (await page.locator(`${PANEL} .pl-total-reversed`).count()) ? clean(await page.locator(`${PANEL} .pl-total-reversed`).textContent()) : '',
})
const plural = (n) => `${n} ${n === 1 ? 'line' : 'lines'}`
const expectTotal = (t) => ({ amount: t.text, count: plural(t.lines), reversed: t.reversed_lines ? `Reversed, not counted: ${t.reversed_text} (${plural(t.reversed_lines)})` : '' })
const totalMatches = (seen, t) => seen.amount === expectTotal(t).amount && seen.count === expectTotal(t).count && seen.reversed === expectTotal(t).reversed
// The table's rows as the screen shows them: date, driver, vendor, amount, the tag and its hover text.
async function tableRows(page) {
  return page.locator(`${PANEL} .pl-row`).evaluateAll((trs) => trs.map((tr) => {
    const td = [...tr.querySelectorAll('td')].map((c) => c.textContent.replace(/\s+/g, ' ').trim())
    const pill = tr.querySelector('.pl-pill')
    return { date: td[0], driver: td[1], vendor: td[2], amount: td[3], tag: td[4], title: pill ? pill.getAttribute('title') : '' }
  }))
}
async function cardRows(page) {
  return page.locator(`${PANEL} .pl-card`).evaluateAll((cards) => cards.map((c) => ({
    driver: (c.querySelector('.pl-card-driver') || {}).textContent?.trim() || '',
    amount: (c.querySelector('.pl-card-amount') || {}).textContent?.trim() || '',
    sentence: (c.querySelector('.pl-card-state') || {}).textContent?.replace(/\s+/g, ' ').trim() || '',
  })))
}
const expectRows = (list) => list.lines.map((l) => ({ driver: l.driver, vendor: l.merchant, amount: l.personal.amount_text, tag: personalShortText(l.personal), title: personalPillText(l.personal) }))
const sameRows = (seen, list) => JSON.stringify(seen.map(({ driver, vendor, amount, tag, title }) => ({ driver, vendor, amount, tag, title }))) === JSON.stringify(expectRows(list))
async function noSidewaysScroll(page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement
    const panel = document.querySelector('.personal-lines')
    return { page: doc.scrollWidth <= window.innerWidth + 1, panel: !panel || panel.scrollWidth <= panel.clientWidth + 1, width: doc.scrollWidth, inner: window.innerWidth }
  })
}
async function openPersonal(page) {
  await page.locator('.sub-tab', { hasText: /^\s*Personal\s*$/ }).first().click({ timeout: 8000 })
  return appears(page, PANEL)
}
async function judgeConsole(step, issues) {
  record(step, 'The console is clean', 'no console error or warning, no page error', issues.length ? issues.join(' | ') : 'clean', issues.length === 0)
}

// ---------------------------------------------------------------- the runs
async function desktopRun(browser, w) {
  const state = { listUrls: [] }
  const all = await serverList(w)
  const a = await serverList(w, { driver: DRIVER_A })
  const day = await serverList(w, { driver: DRIVER_A, from: '2026-10-12', to: '2026-10-12' })
  const { ctx, page, issues } = await openPage(browser, DESKTOP, SUPER_ADMIN, w, state)
  try {
    const listed = await appears(page, '.sub-tab', 15000)
    const tabs = await subTabs(page)
    const opened = listed && await openPersonal(page)
    const filled = opened && await waitForCount(page, `${PANEL} .pl-row`, all.lines.length)
    const seen = filled ? await tableRows(page) : []
    const total = await totalOf(page)
    record('PT1', 'Personal is the sub-tab after All Expenses; opened, every line and the server\'s total',
      `tabs start [All Expenses, Personal]; ${all.lines.length} rows as the server lists them, newest first; total ${all.totals.text} over ${plural(all.totals.lines)}; "All drivers · all dates"`,
      `tabs ${JSON.stringify(tabs)}; rows ${seen.length}; total "${total.amount}" "${total.count}" "${total.reversed}"; scope "${total.scope}"; requests ${JSON.stringify(state.listUrls)}`,
      tabs[0] === 'All Expenses' && tabs[1] === 'Personal' && sameRows(seen, all) && totalMatches(total, all.totals) && total.scope === 'All drivers · all dates' && state.listUrls[0] === '',
      await shot(page, '1-all-drivers-1280'))

    const before = state.listUrls.length
    await page.locator(`${PANEL} select[aria-label="Driver"]`).selectOption({ label: DRIVER_A })
    await waitForRequests(state, before + 1)
    await waitForCount(page, `${PANEL} .pl-row`, a.lines.length)
    await page.waitForTimeout(300)
    const aRows = await tableRows(page)
    const aTotal = await totalOf(page)
    const options = (await page.locator(`${PANEL} select[aria-label="Driver"] option`).allTextContents()).map(clean)
    const sent = new URLSearchParams(state.listUrls[state.listUrls.length - 1] || '')
    record('PT2', `The driver box: ${DRIVER_A}'s lines, each with the receipts' tag, and his total`,
      `options [All drivers, ...${JSON.stringify(all.drivers)}]; the request driver=${DRIVER_A}; ${a.lines.length} rows, the tag personalShortText() with personalPillText() on hover; total ${a.totals.text}, reversed ${a.totals.reversed_text}`,
      `options ${JSON.stringify(options)}; request driver=${JSON.stringify(sent.get('driver'))}; rows ${JSON.stringify(aRows.map((r) => [r.date, r.tag]))}; total "${aTotal.amount}" "${aTotal.count}" "${aTotal.reversed}"; scope "${aTotal.scope}"`,
      JSON.stringify(options) === JSON.stringify(['All drivers', ...all.drivers]) && sent.get('driver') === DRIVER_A && sameRows(aRows, a)
        && totalMatches(aTotal, a.totals) && aTotal.scope === `${DRIVER_A} · all dates` && aRows.every((r) => r.driver === DRIVER_A),
      await shot(page, '2-driver-a-1280'))
    const reversedRow = aRows.find((r) => /· reversed/.test(r.tag))
    record('PT2b', 'The reversed line is listed, marked reversed, and left out of the total',
      'one row tagged "· reversed"; the reversed line under the total names its amount',
      reversedRow ? `row "${reversedRow.tag}" (hover "${reversedRow.title}"); "${aTotal.reversed}"` : 'no reversed row',
      !!reversedRow && aTotal.reversed === `Reversed, not counted: ${a.totals.reversed_text} (${plural(a.totals.reversed_lines)})`)

    const n = state.listUrls.length
    await page.locator(`${PANEL} input[aria-label="From date"]`).fill('2026-10-12')
    await waitForRequests(state, n + 1)
    await page.locator(`${PANEL} input[aria-label="To date"]`).fill('2026-10-12')
    await waitForRequests(state, n + 2)
    await waitForCount(page, `${PANEL} .pl-row`, day.lines.length)
    await page.waitForTimeout(300)
    const dayRows = await tableRows(page)
    const dayTotal = await totalOf(page)
    const last = new URLSearchParams(state.listUrls[state.listUrls.length - 1] || '')
    const dateShot = await shot(page, '3-driver-a-one-day-1280')
    await page.locator(`${PANEL} .pl-clear`).click({ timeout: 4000 }).catch(() => {})
    const back = await waitForCount(page, `${PANEL} .pl-row`, all.lines.length)
    const backTotal = await totalOf(page)
    record('PT3', 'The dates: from/to sent, that day\'s lines and total; Clear filters brings every line back',
      `request driver, from and to 2026-10-12; ${day.lines.length} rows, total ${day.totals.text}; "Oct 12, 2026 to Oct 12, 2026"; after Clear: ${all.lines.length} rows, ${all.totals.text}`,
      `request ${JSON.stringify(Object.fromEntries(last))}; rows ${dayRows.length} ${JSON.stringify(dayRows.map((r) => r.date))}; total "${dayTotal.amount}"; scope "${dayTotal.scope}"; after Clear ${back ? all.lines.length : 'not ' + all.lines.length} rows, "${backTotal.amount}"`,
      last.get('driver') === DRIVER_A && last.get('from') === '2026-10-12' && last.get('to') === '2026-10-12' && sameRows(dayRows, day) && dayRows.every((r) => r.date === 'Oct 12, 2026')
        && totalMatches(dayTotal, day.totals) && dayTotal.scope === `${DRIVER_A} · Oct 12, 2026 to Oct 12, 2026` && back && backTotal.amount === all.totals.text,
      dateShot)
    const scroll = await noSidewaysScroll(page)
    record('PT1b', 'No sideways scroll at 1280', 'the page and the panel fit', JSON.stringify(scroll), scroll.page && scroll.panel)
  } finally {
    await judgeConsole('PTx-sa-1280', issues)
    await ctx.close()
  }
}

async function phoneRun(browser, w) {
  const state = { listUrls: [] }
  const a = await serverList(w, { driver: DRIVER_A })
  const { ctx, page, issues } = await openPage(browser, PHONE, SUPER_ADMIN, w, state)
  try {
    const listed = await appears(page, '.sub-tab', 15000)
    const opened = listed && await openPersonal(page)
    await appears(page, `${PANEL} .pl-card`)
    const before = state.listUrls.length
    await page.locator(`${PANEL} select[aria-label="Driver"]`).selectOption({ label: DRIVER_A })
    await waitForRequests(state, before + 1)
    const filled = await waitForCount(page, `${PANEL} .pl-card`, a.lines.length)
    await page.waitForTimeout(300)
    const cards = await cardRows(page)
    const total = await totalOf(page)
    const tableShown = await page.locator(`${PANEL} .pl-table`).count()
    const scroll = await noSidewaysScroll(page)
    const want = a.lines.map((l) => ({ driver: l.driver, amount: l.personal.amount_text, sentence: personalPillText(l.personal) }))
    await page.locator(PANEL).scrollIntoViewIfNeeded().catch(() => {})
    const top = await shot(page, '4-driver-a-390')
    await page.locator(`${PANEL} .pl-card`).last().scrollIntoViewIfNeeded().catch(() => {})
    const bottom = await shot(page, '5-driver-a-390-cards')
    record('PT4', `390 x 844: cards, ${DRIVER_A} picked, each card's full sentence, the total, no sideways scroll`,
      `${a.lines.length} cards (no table), each the full sentence personalPillText(); total ${a.totals.text}; the page and the panel fit`,
      `opened ${opened}; cards ${cards.length} ${JSON.stringify(cards.map((c) => c.sentence))}; table ${tableShown}; total "${total.amount}" "${total.count}" "${total.reversed}"; scroll ${JSON.stringify(scroll)}; screens ${path.basename(top)}, ${path.basename(bottom)}`,
      opened && filled && tableShown === 0 && JSON.stringify(cards) === JSON.stringify(want) && totalMatches(total, a.totals) && scroll.page && scroll.panel,
      top)
  } finally {
    await judgeConsole('PTx-sa-390', issues)
    await ctx.close()
  }
}

async function dispatcherRun(browser, w, size) {
  const state = { listUrls: [] }
  const { ctx, page, issues } = await openPage(browser, size, DISPATCHER, w, state)
  try {
    const listed = await appears(page, '.sub-tab', 15000)
    await page.waitForTimeout(800)
    const tabs = await subTabs(page)
    const panels = await page.locator(PANEL).count()
    record(`PT5-${size.tag}`, 'A Dispatcher: no Personal sub-tab, and the list route is never asked',
      'tabs without "Personal"; no Personal panel; 0 requests to /api/expenses/personal/lines',
      `tabs ${JSON.stringify(tabs)}; panels ${panels}; requests ${state.listUrls.length}`,
      listed && tabs.includes('All Expenses') && !tabs.includes('Personal') && panels === 0 && state.listUrls.length === 0,
      await shot(page, `6-dispatcher-${size.tag}`))
  } finally {
    await judgeConsole(`PTx-disp-${size.tag}`, issues)
    await ctx.close()
  }
}

async function main() {
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use: set E2E_PORT to a free one`)
  const { w, steps } = await buildWorld()
  const seeded = steps.every(([label, status]) => (label === 'undo R8' || label.startsWith('generate') ? status === 200 : status === 201))
  record('PT0', 'The made-up world: the marks, the undo and the two invoices went through (receipt\'s week on)',
    'each mark 201, the undo and both generations 200', JSON.stringify(steps), seeded)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ASKED_PORT, HOST, resolve) })
  PORT = server.address().port
  if ([3000, 5173, 3901].includes(PORT)) { server.close(); die(`the system picked port ${PORT}: set E2E_PORT to a free one`) }
  BASE = `http://${HOST}:${PORT}`
  console.log(`personal-tab-screen: serving ${DIST} on ${BASE} (made-up data; no server.js process)`)
  let browser = null
  try {
    browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
    for (const [name, fn] of [['desktop', () => desktopRun(browser, w)], ['phone', () => phoneRun(browser, w)],
      ['dispatcher-1280', () => dispatcherRun(browser, w, DESKTOP)], ['dispatcher-390', () => dispatcherRun(browser, w, PHONE)]]) {
      try { await fn() } catch (e) { record(`PT!-${name}`, `${name} run aborted`, 'no abort', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
    }
    const moneyWrites = writes.filter((x) => /\s\/api\/(?:expenses|invoices)(?:\/|$)/.test(x))
    record('PTy', 'The tab sends no write', 'no POST, PUT, PATCH or DELETE to an expenses or invoices route from any page',
      `${moneyWrites.join(', ') || 'none'}; other writes (not judged): ${writes.filter((x) => !moneyWrites.includes(x)).join(', ') || 'none'}`, moneyWrites.length === 0)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await new Promise((r) => server.close(() => r()))
    w.cleanup()
  }
  const resultsFile = path.join(paths.workDir(), 'results-personal-tab-screen.md')
  const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    '# Personal tab check (made-up data, receipt\'s week on)', '',
    `Build: ${DIST}. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Requests to another host, aborted (not part of the verdict): ${[...offHost].sort().join(', ') || 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, out, { mode: 0o600 })
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`personal-tab-screen: ${passed}/${rows.length} PASS; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`personal-tab-screen: aborted: ${e.stack || e}`)
  process.exit(1)
})
