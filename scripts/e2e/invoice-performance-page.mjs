#!/usr/bin/env node
// LogisX — the weekly performance page on a driver's weekly invoice, on made-up data only.
//
// One made-up weekly invoice is drawn by the app's own renderer (lib/policy-renderer.js, its Chromium)
// from render data in generate's shape, with the page lib/invoice-performance-copy.js words from the real
// rules (lib/driver-performance.js) over made-up loads; a second draw without the page is the control.
//   V1  the driver's View PDF (the Invoices tab, the invoice's sheet, 390x844) asks GET /api/invoices/<id>/pdf
//       and is served that PDF
//   V2  the Super Admin's viewer (/invoices, the invoice's detail, 1280x800) asks the same path and is
//       served the same bytes: one PDF for both
//   V3  its page text (lib/pdf-shown-text.js, page by page) holds every line of the page, on one page after
//       the invoice's own; the invoice's own pages read as the control's, which holds none of the page
//
// Like past-performance.mjs this boots no server.js, opens no database, reads no settings file or key and
// signs nobody real in: it serves the checkout's built client/dist on 127.0.0.1 and answers every /api
// request in the browser. Every request to another host is aborted, the socket included. The renderer's
// own Chromium draws the two PDFs before the browser starts.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/invoice-performance-page.mjs
//
// Env: E2E_PORT (default: a free port; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "invoice-performance-page"), HEADED=1, CHROME_PATH, E2E_WORK_DIR, SHOT_DIR (an absolute
// folder outside the checkout; default ~/LogisX-replica/screens/invoice-performance-page).
// Output: PASS/FAIL lines, a final count, the screenshots, the made-up PDF and <work dir>/results-<OUT_TAG>.md.
// Exit 0 only when every row PASSes.
import { chromium } from 'playwright-core'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import paths from './paths.cjs'
import releaseNote from './release-note.cjs'

const require = createRequire(import.meta.url)
const perf = require('../../lib/driver-performance.js')
const copy = require('../../lib/invoice-performance-copy.js')
const { renderPolicy } = require('../../lib/policy-renderer.js')
const { shutdownBrowser } = require('../../lib/pdf-browser.js')
const { shownText } = require('../../lib/pdf-shown-text.js')
const { PDFDocument } = require(path.join(paths.REPO, 'node_modules', 'pdf-lib'))

const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'invoice-performance-page').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.homedir(), 'LogisX-replica', 'screens', 'invoice-performance-page')
const PHONE = { tag: '390x844', viewport: { width: 390, height: 844 }, mobile: true }
const DESKTOP = { tag: '1280x800', viewport: { width: 1280, height: 800 }, mobile: false }

function die(msg) {
  console.error(`invoice-performance-page: ${msg}`)
  process.exit(2)
}

if (process.env.E2E_PORT && (!Number.isInteger(ASKED_PORT) || ASKED_PORT < 1024 || ASKED_PORT > 65535)) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (ASKED_PORT === 3000 || ASKED_PORT === 5173) die(`refusing port ${ASKED_PORT}: 3000 is production's port on the VPS and 5173 is Vite's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm --prefix client run build\` first`)
if (process.env.SHOT_DIR && !path.isAbsolute(process.env.SHOT_DIR)) die('SHOT_DIR must be an absolute path')
{
  const rel = path.relative(paths.REPO, SHOT_DIR)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) die(`SHOT_DIR ${SHOT_DIR} is inside the checkout: pick a folder outside it`)
}

// ---------------------------------------------------------------- made-up fixtures
const DRIVER = { id: 90611, username: 'qa-invoice-driver', role: 'Driver', driverName: 'Casey Example', email: '', fullName: 'Casey Example', companyName: '', mustChangePassword: false }
const ADMIN = { id: 90612, username: 'qa-invoice-admin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Invoice Admin', companyName: '', mustChangePassword: false }
const INVOICE_ID = 90613
const PDF_PATH = `/api/invoices/${INVOICE_ID}/pdf`
const WEEK = { start: '2026-11-07', end: '2026-11-13' }
// Fri Nov 13, 7:00 PM Eastern: the Friday batch's hour.
const AS_OF_MS = Date.parse('2026-11-14T00:00:00Z')
const GRID = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const LOADS = ['QA-9501', 'QA-9502', 'QA-9503', 'QA-9504', 'QA-9505']

// His week through the real rules: five made-up loads, four pickups counted, one counted the week before.
const ANSWER = {
  week: perf.personalWeek({
    id: 'this-week', start: WEEK.start, end: WEEK.end, today: WEEK.end, deliveries: 5, pickups: 4, offDays: [], openLoad: true,
    loads: LOADS.map((loadId, i) => perf.countedLoad({
      loadId,
      pickupDay: i === 0 ? '' : perf.addDays(WEEK.start, i + 1),
      deliveryDay: perf.addDays(WEEK.start, i + 2),
      pickupNote: i === 0 ? 'last-week' : '',
    })),
  }),
  weights: { ...perf.CREDIT_WEIGHTS },
  hours: null,
}
const PAGE = copy.pageOf(ANSWER, { asOfMs: AS_OF_MS, zone: 'America/New_York' })
if (!PAGE) die('the made-up week could not be worded (lib/invoice-performance-copy.js pageOf() answered null)')
const PAGE_LINES = [PAGE.heading, PAGE.week, PAGE.asOf, PAGE.count, PAGE.requirement, PAGE.rule, PAGE.title, ...PAGE.rows, PAGE.hours].filter(Boolean)

// Render data in generate's shape for a day-rate week, Monday to Friday at a made-up $300.
const days = Object.fromEntries(GRID.map((name, i) => {
  const worked = i >= 2
  return [name, worked
    ? { date: perf.addDays(WEEK.start, i), loadBol: LOADS[i - 2], total: 300, rate: 300, completed: true, listed: [LOADS[i - 2]], scheduled: [] }
    : { date: perf.addDays(WEEK.start, i), loadBol: '', total: 0, completed: false, listed: [], scheduled: [] }]
}))
const RENDER_DATA = {
  driverName: DRIVER.driverName, businessName: DRIVER.driverName, providerAddress: '100 Example Rd, Memphis, TN 38118', providerPhone: '555-0100',
  invoiceNumberSuffix: 'CE-2026W46-01', submissionDate: 'Nov 13, 2026', signatureDate: 'Nov 13, 2026',
  billingPeriodStart: 'November 7, 2026', billingPeriodEnd: 'November 13, 2026', totalDue: 1500, bankOnFile: '', accountType: '',
  days, hasEldData: true, hasBol: true, hasDvir: true, hasFuelReceipts: true, adjustment: 0, adjustmentNote: '',
}
const ROW = {
  id: INVOICE_ID, invoice_number: 'INV-CE-2026W46-01', driver: 'casey example', week_start: WEEK.start, week_end: WEEK.end, status: 'Submitted',
  submitted_at: '2026-11-14T00:05:00Z', created_at: '2026-11-14T00:00:00Z', total_earnings: 1500, total_due: 1500, adjustment: 0, adjustment_note: '',
  loads_count: 5, rate_per_load: 300, expenses_total: 0, personal_total: 0, personal_share_total: 0, correction_lines_total: 0, is_manual: 0,
  deleted_at: '', pay_basis: 'daily', load_count: 5, personal_lines: [], pdf_file_name: 'INV-CE-2026W46-01.pdf',
}

// ---------------------------------------------------------------- the PDFs, page by page
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const squash = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '')
async function pageTexts(pdf) {
  const src = await PDFDocument.load(pdf, { updateMetadata: false })
  const out = []
  for (let i = 0; i < src.getPageCount(); i++) {
    const one = await PDFDocument.create({ updateMetadata: false })
    const [p] = await one.copyPages(src, [i])
    one.addPage(p)
    out.push(shownText(Buffer.from(await one.save({ useObjectStreams: false }))))
  }
  return out
}

// ---------------------------------------------------------------- the browser's view of the server
function driverPayload() {
  return {
    loads: [], headers: { jobTracking: [], carrierDB: [] },
    onboarding: { user_id: DRIVER.id, status: 'fully_onboarded', onboarded_at: '2026-10-01T12:00:00Z', documents: [], totalDocs: 5 },
    driverInfo: null, truck: null, expenses: [], drivers: [], invoices: [ROW], sharedDocuments: [], truckDocuments: [], messages: [], notifications: [],
  }
}

function answerGet(state, u) {
  const p = u.pathname
  const user = state.user
  if (p === '/api/auth/session') return { status: 200, body: state.session ? { authenticated: true, user, appTimeZone: 'America/New_York' } : { authenticated: false } }
  if (p === '/api/auth/setup-check') return { status: 200, body: { needsSetup: false } }
  if (!state.session) return { status: 401, body: { error: 'Not signed in' } }
  if (p === '/api/driver/me/release') return { status: 200, body: { notes: [], tourOffered: false } }
  if (p === '/api/driver/me/performance' || p.startsWith('/api/driver/performance/') || p.startsWith('/api/admin/driver-performance')) return { status: 404, body: { error: 'Not found', code: 'FEATURE_OFF' } }
  if (p === '/api/driver/position') return { status: 200, body: { ok: false } }
  if (p === '/api/fuel/range') return { status: 200, body: { ok: false } }
  if (p === '/api/invoices') return { status: 200, body: { invoices: user.role === 'Super Admin' ? [ROW] : [], summary: { Submitted: { count: 1, total_due: 1500 } } } }
  if (/^\/api\/driver\/[^/]+$/.test(p) && user.role === 'Driver') return { status: 200, body: driverPayload() }
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the invoice performance page check"}')
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
const unanswered = new Set()
const pageErrors = []
const offHost = new Set()
let exitCode = 0
function record(step, title, expected, observed, ok, shotFile = '') {
  if (!ok) exitCode = 1
  rows.push({ step, title, expected, observed, verdict: ok ? 'PASS' : 'FAIL', shot: shotFile })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${observed}`)
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(SHOT_DIR, `${OUT_TAG}-${name}.png`)
  await page.screenshot({ path: file })
  return file
}

// ---------------------------------------------------------------- page helpers
// Every PDF the pages are served, as { who, path, sha }.
const served = []
async function newContext(browser, size, state, pdf) {
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: size.mobile ? 3 : 1, isMobile: size.mobile, hasTouch: size.mobile, serviceWorkers: 'block', acceptDownloads: true })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) { offHost.add(u.host); return route.abort() }
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (req.method() === 'GET' && u.pathname === PDF_PATH) {
      if (!state.session) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Not signed in"}' })
      served.push({ who: state.user.role, path: u.pathname, sha: sha(pdf) })
      return route.fulfill({ status: 200, contentType: 'application/pdf', headers: { 'cache-control': 'private, no-store' }, body: pdf })
    }
    if (req.method() === 'GET') {
      const out = answerGet(state, u)
      if (out === null) unanswered.add(u.pathname)
      return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out ? out.body : {}) })
    }
    if (u.pathname === '/api/auth/login') {
      state.session = true
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, user: state.user, appTimeZone: 'America/New_York' }) })
    }
    if (u.pathname === '/api/auth/logout') state.session = false
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })
  return ctx
}

async function appears(page, selector, ms) {
  try { await page.waitForSelector(selector, { state: 'visible', timeout: ms }); return true } catch { return false }
}
async function until(check, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}

// Through the login form, as anyone signs in.
async function signedIn(browser, size, user, startPath, pdf) {
  const state = { user, session: false }
  const ctx = await newContext(browser, size, state, pdf)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}${startPath}`, { waitUntil: 'domcontentloaded' })
  await appears(page, 'input[autocomplete="username"]', 8000)
  await page.fill('input[autocomplete="username"]', user.username)
  await page.fill('#login-password', 'made-up-password')
  await page.locator('.submit-btn').first().click()
  await until(() => state.session, 10000)
  return { state, ctx, page }
}

// ---------------------------------------------------------------- V1: the driver's View PDF
async function driverRun(browser, pdf) {
  const { ctx, page } = await signedIn(browser, PHONE, DRIVER, '/driver', pdf)
  try {
    const app = await appears(page, '.van-tabbar', 15000)
    // Nothing is due here (the release route answers no note), but a notice would sit over the app.
    await releaseNote.answerReleaseNote(page, { who: 'the made-up driver', waitMs: 5000 })
    await page.locator('.van-tabbar-item', { hasText: 'Invoices' }).first().click()
    const card = await appears(page, '.invoice-card', 8000)
    await page.locator('.invoice-card').first().click()
    const sheet = await appears(page, 'a.action-btn', 8000)
    const href = await page.locator('a.action-btn', { hasText: 'View PDF' }).first().getAttribute('href').catch(() => null)
    const sheetShot = await shot(page, '1-driver-invoice-sheet')
    const before = served.length
    const [opened] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null),
      page.locator('a.action-btn', { hasText: 'View PDF' }).first().click(),
    ])
    const got = await until(() => served.slice(before).some((s) => s.who === 'Driver'), 10000)
    const mine = served.slice(before).filter((s) => s.who === 'Driver')
    record(`V1-${PHONE.tag}`, "The driver's View PDF asks for the invoice's PDF and is served it",
      `the Invoices tab's sheet links "${PDF_PATH}" in a new tab; that tab asks it and is served the made-up PDF (${sha(pdf).slice(0, 12)})`,
      `app ${app}, card ${card}, sheet ${sheet}, href "${href}", new tab ${!!opened}, served ${JSON.stringify(mine.map((s) => [s.path, s.sha.slice(0, 12)]))}`,
      app && card && sheet && href === PDF_PATH && !!opened && got && mine.every((s) => s.path === PDF_PATH && s.sha === sha(pdf)),
      sheetShot)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- V2: the Super Admin's viewer
async function adminRun(browser, pdf) {
  const { ctx, page } = await signedIn(browser, DESKTOP, ADMIN, '/login', pdf)
  try {
    await page.goto(`${BASE}/invoices`, { waitUntil: 'domcontentloaded' })
    const listed = await appears(page, `tr:has-text("${ROW.invoice_number}")`, 15000)
    const before = served.length
    await page.locator(`tr:has-text("${ROW.invoice_number}")`).first().click()
    const dialog = await appears(page, '.detail-pdf', 8000)
    const got = await until(() => served.slice(before).some((s) => s.who === 'Super Admin'), 15000)
    await page.waitForTimeout(1500)
    const theirs = served.slice(before).filter((s) => s.who === 'Super Admin')
    const viewerShot = await shot(page, '2-admin-invoice-viewer')
    record(`V2-${DESKTOP.tag}`, "The Super Admin's viewer asks for the same PDF and is served the same bytes",
      `the invoice's detail opens its viewer on "${PDF_PATH}", served the bytes the driver got (${sha(pdf).slice(0, 12)})`,
      `listed ${listed}, dialog ${dialog}, served ${JSON.stringify(theirs.map((s) => [s.path, s.sha.slice(0, 12)]))}`,
      listed && dialog && got && theirs.length > 0 && theirs.every((s) => s.path === PDF_PATH && s.sha === sha(pdf)),
      viewerShot)
  } finally {
    await ctx.close()
  }
}

async function main() {
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  // The two PDFs, drawn by the app's own renderer before the browser starts.
  let pdf
  let control
  try {
    pdf = await renderPolicy('service_invoice', { ...RENDER_DATA, performance: PAGE })
    control = await renderPolicy('service_invoice', RENDER_DATA)
  } finally {
    await shutdownBrowser().catch(() => {})
  }
  const pdfFile = path.join(paths.workDir(), `${OUT_TAG}.pdf`)
  fs.writeFileSync(pdfFile, pdf, { mode: 0o600 })
  const pages = await pageTexts(pdf)
  const controlPages = await pageTexts(control)
  const whole = squash(shownText(pdf))
  const last = squash(pages[pages.length - 1])
  const missing = PAGE_LINES.filter((l) => !last.includes(squash(l)))
  const inControl = PAGE_LINES.filter((l) => squash(shownText(control)).includes(squash(l)) && l !== PAGE.rule)
  const sameInvoice = pages.length === controlPages.length + 1 && controlPages.every((t, i) => squash(t) === squash(pages[i]))
  record('V3', 'The PDF holds the page: every line of it on one page after the invoice\'s own, which read as the control\'s',
    `${controlPages.length + 1} pages (the control's ${controlPages.length} and one more); the last holds ${JSON.stringify(PAGE_LINES)}; the invoice's pages read as the control's; the control holds none of the page's own lines`,
    `pages ${pages.length} (control ${controlPages.length}), missing from the last page ${JSON.stringify(missing)}, the whole text holds the heading ${whole.includes(squash(PAGE.heading))}, the invoice's pages as the control's ${sameInvoice}, the control's ${JSON.stringify(inControl)}`,
    missing.length === 0 && sameInvoice && inControl.length === 0 && whole.includes(squash(PAGE.heading)))

  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ASKED_PORT, HOST, resolve) })
  PORT = server.address().port
  if (PORT === 3000 || PORT === 5173) { server.close(); die(`the system picked port ${PORT}: set E2E_PORT to a free one`) }
  BASE = `http://${HOST}:${PORT}`
  console.log(`invoice-performance-page: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    await driverRun(browser, pdf)
    await adminRun(browser, pdf)
  } finally {
    await browser.close()
    server.close()
  }
  const both = served.filter((s) => s.path === PDF_PATH)
  record('V1+V2', 'One PDF for both: every request for the invoice\'s PDF, the driver\'s and the Super Admin\'s, got the same bytes',
    `one sha256 across ${both.length} request(s), from both roles`,
    `roles ${JSON.stringify([...new Set(both.map((s) => s.who))])}, hashes ${JSON.stringify([...new Set(both.map((s) => s.sha.slice(0, 12)))])}`,
    new Set(both.map((s) => s.sha)).size === 1 && new Set(both.map((s) => s.who)).size === 2)

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    `# The weekly performance page on the invoice (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}. The made-up PDF: ${pdfFile}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Browser requests to another host, aborted (not part of the verdict): ${[...offHost].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, out, { mode: 0o600 })
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`invoice-performance-page: ${passed}/${rows.length} PASS, ${rows.length - passed} FAIL; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  if (pageErrors.length) console.log(`invoice-performance-page: page errors: ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((err) => {
  console.error('invoice-performance-page: FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
