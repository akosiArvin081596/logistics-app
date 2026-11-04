#!/usr/bin/env node
// LogisX — the receipt auto-approve screens on All Expenses, on made-up data only
// (RECEIPT_STATUS_RECORDER_ENABLED and RECEIPT_AUTO_APPROVE_ENABLED / _SHADOW).
//
// The page is /expenses, as a made-up Super Admin ("qa-aa-superadmin") and a made-up
// Dispatcher ("qa-aa-dispatcher"), each at 1280x800 and 390x844. The mock answers
// GET /api/expenses/all as the server does in each mode (lib/receipt-auto-approve-list.js
// does the meta and the review shapes in this process), so a state is one of:
//   A1  both flags off: no line under any status, no "Approved automatically" in the
//       status filter, no report panel, no request for the report
//   A2  recorder only: "Approved by <account>" under an Approved receipt (table or card,
//       and the detail modal with "Set <time>"); an older Approved receipt with an empty
//       record and a Pending one show no line; no panel, no filter option
//   A3  shadow (recorder on): no verdict line anywhere and no filter option. The Super
//       Admin sees the closed panel "Fuel receipts approved by rule" (Shadow, "would
//       approve 3 of 12 judged"); opened, it shows counts and no receipt table; a
//       Dispatcher sees no panel and nothing asks for the report
//   A4  on, with three made-up review rows (and a person's approval, a Rejected one and
//       an older Approved one with no record):
//       a  the lines: "Checking automatically", "Needs a person: the fill was 63 km
//          away; the receipt reads $412.00, the entry says $421.00" (full text on hover,
//          ellipsis in the table), "Approved automatically", "Approved by <account>";
//          the filter has the option
//       b  the modal: the held reasons as a list; the auto evidence; no "Set" on auto
//       c  the filter "Approved automatically": the request carries it, one receipt
//          lists, the scope line names it, Clear filters brings the list back
//       d  Undo on the automatic one: one PUT to its status route, its line goes at once
//       e  the panel: "On", "1 of 3 judged passed; 1 approved", the receipt table
//          (Super Admin only; a Dispatcher sees the lines and the filter, no panel)
//   A5  per page: no console error or warning, no page error (a production build has no
//       Vue warnings; resource errors from the aborted sockets are not counted)
//   A6  INFO, not a verdict: an Approved receipt whose review row was undone but whose
//       record still names the pass (a known Low): the text the screen shows is recorded
// Step names carry the state, role and size.
//
// Like driver-emergency-contacts-profile.mjs this boots no server.js, opens no database,
// reads no settings file or key and signs nobody in. It serves the checkout's built
// client/dist from its own static server on 127.0.0.1 (E2E_PORT, default 3184) and
// answers every /api request in the browser with made-up fixtures. Every request to
// another host is aborted, the socket included.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/receipts-auto-approve-screens.mjs
//
// Env: E2E_PORT (default 3184; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "receipts-auto-approve-screens"), HEADED=1, CHROME_PATH,
// E2E_WORK_DIR, SHOT_DIR (an absolute folder outside the checkout; default
// <work dir>/shots/<OUT_TAG>). Output: the screenshots, <work dir>/results-<OUT_TAG>.txt
// (one line per step, written as it goes) and <work dir>/results-<OUT_TAG>.md.
// Exit 0 only when no row is FAIL (INFO rows are not verdicts).
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import paths from './paths.cjs'

const require = createRequire(import.meta.url)
const lists = require(path.join(paths.REPO, 'lib', 'receipt-auto-approve-list.js'))

const PORT = Number(process.env.E2E_PORT || 3184)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'receipts-auto-approve-screens').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const SIZES = [
  { tag: '1280x800', viewport: { width: 1280, height: 800 } },
  { tag: '390x844', viewport: { width: 390, height: 844 } },
]

function die(msg) {
  console.error(`receipts-auto-approve-screens: ${msg}`)
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
const SUPER_ADMIN = { id: 90301, username: 'qa-aa-superadmin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA AA Super Admin', companyName: '', mustChangePassword: false }
const DISPATCHER = { id: 90302, username: 'qa-aa-dispatcher', role: 'Dispatcher', driverName: '', email: '', fullName: 'QA AA Dispatcher', companyName: '', mustChangePassword: false }
const ROLES = { sa: SUPER_ADMIN, disp: DISPATCHER }
const DAY = 24 * 60 * 60 * 1000
const PASS = lists.PASS_NAME
const APPLIED_AT = '2026-10-21T14:05:00Z'
const PERSON_AT = '2026-10-21T16:30:00Z'
const PERSON_RECORD = { role: 'Super Admin', name: SUPER_ADMIN.username, at: PERSON_AT }
const PASS_RECORD = { role: 'system', name: PASS, at: APPLIED_AT }
const STATUS_URL = /^\/api\/expenses\/(\d+)\/status$/

const HELD_LINE = 'Needs a person: the fill was 63 km away; the receipt reads $412.00, the entry says $421.00'
const AUTO_EVIDENCE_START = 'ELD fill #12 the same day, 4.2 km away'
const OPTIONS_PLAIN = ['All Status', 'Pending', 'Approved', 'Rejected']
const OPTIONS_AUTO = ['All Status', 'Pending', 'Approved', 'Approved automatically', 'Rejected']

// A made-up fuel receipt, with the fields GET /api/expenses/all sends.
function expense(id, vendor, over = {}) {
  return {
    id, timestamp: new Date(Date.now() - 14 * DAY).toISOString(), driver: 'Casey Example', load_id: '', type: 'Fuel', amount: 250, description: '',
    date: '2026-10-20', photo_data: '', status: 'Pending', gallons: 90, odometer: null, truck_unit: 'QA-1', owner_id: null,
    location_city: 'Austin', location_state: 'TX', vendor, vendor_normalized: vendor, location_lat: null, location_lng: null, location_source: '',
    receipt_details: [], posted_period: '', created_at: new Date(Date.now() - 14 * DAY).toISOString(), finalized_period: '', personal: null,
    ...over,
  }
}
// A fixture row: the receipt, the recorder's record (`by`) and the pass's review row (`review`).
const fx = (id, vendor, status, { by = null, review = null, amount = 250 } = {}) => ({ base: expense(id, vendor, { status, amount }), by, review })

const V = { checking: 'QA Pilot Alpha', held: 'QA Loves Beta', auto: 'QA TA Gamma', person: 'QA Shell Delta', rejected: 'QA Exxon Epsilon', older: 'QA Sapp Zeta' }

const rowsPlain = () => [
  fx(701, 'QA Plain Pending', 'Pending'),
  fx(702, 'QA Plain Approved', 'Approved'),
  fx(703, 'QA Plain Rejected', 'Rejected'),
]
const rowsRecorder = () => [
  fx(711, V.person, 'Approved', { by: PERSON_RECORD }),
  fx(712, V.older, 'Approved'),
  fx(713, V.checking, 'Pending'),
]
const rowsShadow = () => [
  fx(721, V.checking, 'Pending'),
  fx(722, V.held, 'Pending'),
  fx(723, V.person, 'Approved', { by: PERSON_RECORD }),
  fx(724, V.older, 'Approved'),
  fx(725, V.rejected, 'Rejected'),
]
const rowsOn = () => [
  fx(401, V.checking, 'Pending', { review: { verdict: 'wait', reasons: [], evidence: {}, applied_at: '', undone_at: '' } }),
  fx(402, V.held, 'Pending', {
    amount: 421,
    review: { verdict: 'hold', reasons: ['PLACE_FAR', 'OCR_TOTAL'], evidence: { link: { fill: 11, km: 63 }, read: { amount: 412, date: '2026-10-20', gallons: 88.4, state: 'TX' } }, applied_at: '', undone_at: '' },
  }),
  fx(403, V.auto, 'Approved', {
    amount: 380.5, by: PASS_RECORD,
    review: { verdict: 'approve', reasons: [], evidence: { link: { fill: 12, km: 4.2 }, read: { amount: 380.5, date: '2026-10-20', gallons: 100.1, state: 'TX' } }, applied_at: APPLIED_AT, undone_at: '' },
  }),
  fx(404, V.person, 'Approved', { by: PERSON_RECORD }),
  fx(405, V.rejected, 'Rejected'),
  fx(406, V.older, 'Approved'),
]
// The pass's approval, undone by a person and re-approved: the review row is undone, the record still names the pass.
const rowsStale = () => [
  fx(601, 'QA Stale Zeta', 'Approved', {
    by: PASS_RECORD,
    review: { verdict: 'approve', reasons: [], evidence: { link: { fill: 12, km: 4.2 }, read: { amount: 250, date: '2026-10-20', gallons: 90, state: 'TX' } }, applied_at: APPLIED_AT, undone_at: '2026-10-22T09:00:00Z' },
  }),
  fx(602, V.checking, 'Pending', { review: { verdict: 'wait', reasons: [], evidence: {}, applied_at: '', undone_at: '' } }),
]

const COUNTS_ZERO = () => ({
  judged: 0, approve: 0, hold: 0, wait: 0, applied: 0, undone: 0, reads: 0, decidedBefore: 0, rejectedJudged: 0, s3: 0, notApplied: {}, reasons: {},
  agreement: { approve: { Approved: 0, Rejected: 0, Pending: 0, undone: 0 }, hold: { Approved: 0, Rejected: 0, Pending: 0 } },
})
const REPORT_SHADOW = {
  mode: 'shadow', refused: false, missing: '', lastPassAt: new Date(Date.now() - 20 * 60000).toISOString(), lastSkip: '', lastError: '',
  counts: {
    ...COUNTS_ZERO(), judged: 12, approve: 3, hold: 5, wait: 4, reads: 7, decidedBefore: 2, rejectedJudged: 1, s3: 1, reasons: { PLACE_FAR: 3, OCR_TOTAL: 2 },
    agreement: { approve: { Approved: 2, Rejected: 0, Pending: 1, undone: 0 }, hold: { Approved: 1, Rejected: 1, Pending: 3 } },
  },
}
const receiptLine = (id, verdict, status, extra = {}) => ({ id, date: '2026-10-20', truckUnit: 'QA-1', verdict, reasons: [], status, decidedBefore: false, appliedAt: '', notApplied: '', undoneAt: '', ...extra })
const REPORT_ON = {
  mode: 'on', refused: false, missing: '', lastPassAt: new Date(Date.now() - 20 * 60000).toISOString(), lastSkip: '', lastError: '',
  counts: {
    ...COUNTS_ZERO(), judged: 3, approve: 1, hold: 1, wait: 1, applied: 1, reads: 2, reasons: { PLACE_FAR: 1, OCR_TOTAL: 1 },
    agreement: { approve: { Approved: 1, Rejected: 0, Pending: 0, undone: 0 }, hold: { Approved: 0, Rejected: 0, Pending: 1 } },
  },
  receipts: [
    receiptLine(401, 'wait', 'Pending'),
    receiptLine(402, 'hold', 'Pending', { reasons: ['PLACE_FAR', 'OCR_TOTAL'] }),
    receiptLine(403, 'approve', 'Approved', { appliedAt: APPLIED_AT }),
  ],
}
const REPORT_STALE = {
  ...REPORT_ON,
  counts: { ...COUNTS_ZERO(), judged: 1, approve: 1, applied: 1, undone: 1, s3: 1, reads: 1, agreement: { approve: { Approved: 0, Rejected: 0, Pending: 0, undone: 1 }, hold: { Approved: 0, Rejected: 0, Pending: 0 } } },
  receipts: [receiptLine(601, 'approve', 'Approved', { appliedAt: APPLIED_AT, undoneAt: '2026-10-22T09:00:00Z' })],
}

// What the "server" holds in one state: the mode, the recorder, the rows, the report.
function freshState({ name, mode = 'off', recorder = false, rows, report = null }) {
  return { name, mode, recorder, rows, report, reportGets: 0, listUrls: [], statusPuts: [] }
}

// GET /api/expenses/all as server.js builds it: the status condition, the recorder's status_by
// (recorder on only), auto_review (on mode only), the list's own meta.
function listBody(state, search) {
  const status = new URLSearchParams(search).get('status') || ''
  const auto = lists.statusCondition(state.mode, status)
  const picked = state.rows.filter((r) => {
    if (auto) return r.base.status === 'Approved' && !!r.by && r.by.role === 'system' && r.by.name === PASS
    return !status || r.base.status.toLowerCase() === status.toLowerCase()
  })
  const expenses = picked.slice().sort((a, b) => b.base.id - a.base.id).map((r) => {
    const out = { ...r.base }
    const by = state.recorder ? r.by : null
    if (state.recorder) out.status_by = by
    if (state.mode === 'on') {
      out.auto_review = r.review ? lists.shape({
        verdict: r.review.verdict, reasons: JSON.stringify(r.review.reasons), evidence: JSON.stringify(r.review.evidence),
        applied_at: r.review.applied_at, undone_at: r.review.undone_at, status: r.base.status,
        by_role: by ? by.role : '', by_name: by ? by.name : '', by_at: by ? by.at : '',
      }) : null
    }
    return out
  })
  return { expenses, personalEnabled: false, personalReceiptWeek: false, ...lists.listMeta(state.mode) }
}

function answerGet(who, state, u) {
  const pathname = u.pathname
  if (pathname === '/api/auth/session') return { status: 200, body: { authenticated: true, user: who, appTimeZone: 'America/New_York' } }
  if (pathname === '/api/expenses/all') {
    state.listUrls.push(`${pathname}${u.search}`)
    return { status: 200, body: listBody(state, u.search) }
  }
  if (pathname === '/api/admin/receipt-auto-approve') {
    state.reportGets++
    if (who.role !== 'Super Admin') return { status: 403, body: { error: 'Forbidden' } }
    return state.report ? { status: 200, body: state.report } : { status: 404, body: { error: 'Not found' } }
  }
  if (pathname === '/api/trucks') return { status: 200, body: { data: [{ UnitNumber: 'QA-1' }] } }
  if (pathname === '/api/drivers-directory') return { status: 200, body: { data: [{ Driver: 'Casey Example' }] } }
  if (pathname === '/api/expenses/personal/waiting-corrections') return { status: 200, body: { groups: [], carried: [] } }
  if (pathname === '/api/dispatch-notifications') return { status: 200, body: { notifications: [], unreadCount: 0 } }
  return null
}

// A person's status change as the server answers it; the recorder stamps the account.
function answerStatusPut(who, state, id, raw) {
  let body = null
  try { body = JSON.parse(raw || 'null') } catch { body = null }
  state.statusPuts.push({ id, body })
  const row = state.rows.find((r) => r.base.id === id)
  if (!row || !body || !['Pending', 'Approved', 'Rejected'].includes(body.status)) return { status: 400, body: { error: 'Invalid status' } }
  row.base.status = body.status
  row.by = { role: who.role, name: who.username, at: new Date().toISOString() }
  row.review = null
  return { status: 200, body: { success: true, status: body.status } }
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the receipt auto-approve screens check"}')
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
let resultsTxt = ''
const ONE_LINE = (s) => String(s).replace(/\r?\n/g, ' ')
// ok true: PASS, false: FAIL, 'info': an observation that is not a verdict.
function record(step, title, expected, observed, ok, shot = '') {
  const verdict = ok === 'info' ? 'INFO' : ok ? 'PASS' : 'FAIL'
  if (verdict === 'FAIL') exitCode = 1
  rows.push({ step, title, expected, observed, verdict, shot })
  const line = `${verdict}  ${step}  ${title}: ${ONE_LINE(observed)}`
  console.log(line)
  if (resultsTxt) fs.appendFileSync(resultsTxt, `${line}\n`)
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
const ROW_SEL = '.expense-row, .mobile-exp-card'
// Resource errors from the aborted socket and the blocked hosts are the harness's own doing.
const NOISE = /Failed to load resource|net::ERR|socket\.io|WebSocket/i

async function openPage(browser, size, who, state, url) {
  const phone = size.viewport.width < 640
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) return route.abort()
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    const m = STATUS_URL.exec(u.pathname)
    if (req.method() === 'PUT' && m) {
      const out = answerStatusPut(who, state, Number(m[1]), req.postData())
      return route.fulfill({ status: out.status, contentType: 'application/json', body: JSON.stringify(out.body) })
    }
    if (req.method() !== 'GET') {
      otherWrites.push(`${size.tag} ${req.method()} ${u.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    const out = answerGet(who, state, u)
    if (out === null) unanswered.add(u.pathname)
    return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', body: JSON.stringify(out ? out.body : {}) })
  })
  const page = await ctx.newPage()
  const issues = []
  page.on('pageerror', (e) => {
    const msg = `${size.tag}: ${String(e.message || e).slice(0, 200)}`
    pageErrors.push(msg)
    issues.push(`pageerror ${String(e.message || e).slice(0, 160)}`)
  })
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return
    const t = m.text()
    if (NOISE.test(t)) return
    issues.push(`${m.type()} ${t.slice(0, 160)}`)
  })
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' })
  return { ctx, page, issues }
}

const clean = (t) => (t || '').replace(/\s+/g, ' ').trim()
const text = (page, selector) => page.locator(selector).first().textContent({ timeout: 2000 }).then(clean, () => '')
async function appears(page, selector, ms, state = 'visible') {
  try { await page.waitForSelector(selector, { state, timeout: ms }); return true } catch { return false }
}
async function waitForCount(page, selector, n, ms = 8000) {
  try { await page.waitForFunction(([s, k]) => document.querySelectorAll(s).length === k, [selector, n], { timeout: ms }); return true } catch { return false }
}
const count = (page, selector) => page.locator(selector).count()
const rowFor = (page, vendor) => page.locator(ROW_SEL, { hasText: vendor }).first()
const layoutOf = async (page) => ((await count(page, '.expense-row')) > 0 ? 'table' : 'cards')
const statusSelect = (page) => page.locator('select.filter-select', { has: page.locator('option', { hasText: 'All Status' }) }).first()
const statusOptions = (page) => statusSelect(page).locator('option').allTextContents().then((l) => l.map(clean), () => [])

// The line under a receipt's status: its text, kind and hover text, or null.
async function lineOf(page, vendor) {
  const el = rowFor(page, vendor).locator('.auto-review').first()
  if ((await el.count()) === 0) return null
  const cls = (await el.getAttribute('class')) || ''
  return { text: clean(await el.textContent()), kind: (cls.match(/auto-review--(\w+)/) || [])[1] || '', title: clean(await el.getAttribute('title')) }
}
const lineText = (l) => (l ? `${l.kind}: "${l.text}"` : 'no line')

async function openModal(page, vendor) {
  await rowFor(page, vendor).locator('.cell-strong, .mobile-exp-vendor').first().click({ timeout: 5000 })
  return appears(page, '.exp-overlay', 5000)
}
async function closeModal(page) {
  await page.keyboard.press('Escape')
  await page.waitForSelector('.exp-overlay', { state: 'hidden', timeout: 4000 }).catch(() => {})
}
const modalReview = async (page) => ((await appears(page, '.exp-auto-review', 3000, 'attached')) ? text(page, '.exp-auto-review') : '')

// One page load as one role at one size, in one state. The list and the panel have settled when fn runs;
// a thrown step is a FAIL row, not an abort; the page's console is judged last (A5).
async function withPage(browser, size, roleKey, state, fn) {
  const who = ROLES[roleKey]
  const tag = `${state.name}-${roleKey}-${size.tag}`
  const { ctx, page, issues } = await openPage(browser, size, who, state, '/expenses')
  try {
    const loaded = await appears(page, ROW_SEL, 15000)
    if (!loaded) {
      record(`${tag}-load`, 'All Expenses lists the made-up receipts', 'rows shown within 15 s', 'no row appeared', false, await shot(page, `${tag}-load`))
      return
    }
    await page.waitForTimeout(900)
    await fn(page, tag)
  } catch (e) {
    record(`${tag}-error`, 'the step ran to its end', 'no error', String((e && e.message) || e).slice(0, 220), false)
  } finally {
    record(`A5-${tag}`, 'The console is clean', 'no console error or warning, no page error',
      issues.length ? issues.join(' | ') : 'clean', issues.length === 0)
    await ctx.close()
  }
}

// ---------------------------------------------------------------- the states
async function stateOff(browser, size, roleKey) {
  const state = freshState({ name: 'A1', rows: rowsPlain() })
  await withPage(browser, size, roleKey, state, async (page, tag) => {
    const lines = await count(page, '.auto-review')
    const panel = await count(page, '.aa-panel')
    const options = await statusOptions(page)
    record(tag, 'Flags off: no line, no filter option, no panel, no report request', 'no .auto-review; no panel; filter [All Status, Pending, Approved, Rejected]; 0 report GETs',
      `${await layoutOf(page)}: lines ${lines}, panel ${panel}, filter ${JSON.stringify(options)}, report GETs ${state.reportGets}`,
      lines === 0 && panel === 0 && JSON.stringify(options) === JSON.stringify(OPTIONS_PLAIN) && state.reportGets === 0, await shot(page, tag))
  })
}

async function stateRecorder(browser, size, roleKey) {
  const state = freshState({ name: 'A2', recorder: true, rows: rowsRecorder() })
  await withPage(browser, size, roleKey, state, async (page, tag) => {
    const by = await lineOf(page, V.person)
    const older = await lineOf(page, V.older)
    const pending = await lineOf(page, V.checking)
    const lines = await count(page, '.auto-review')
    const panel = await count(page, '.aa-panel')
    const options = await statusOptions(page)
    record(tag, 'Recorder only: "Approved by <account>" under Approved, nothing else', `one line "Approved by ${SUPER_ADMIN.username}" (by); the empty-record and Pending receipts none; no panel; no filter option`,
      `${await layoutOf(page)}: ${V.person} ${lineText(by)}; ${V.older} ${lineText(older)}; ${V.checking} ${lineText(pending)}; lines ${lines}, panel ${panel}, filter ${JSON.stringify(options)}`,
      !!by && by.kind === 'by' && by.text === `Approved by ${SUPER_ADMIN.username}` && !older && !pending && lines === 1 && panel === 0 && JSON.stringify(options) === JSON.stringify(OPTIONS_PLAIN), await shot(page, tag))

    const opened = await openModal(page, V.person)
    const modal = opened ? await modalReview(page) : ''
    record(`${tag}-modal`, 'The detail modal names the account and when it was set', '"Approved by <account>", the shared-login sentence, "Set <time>"; not "Approved automatically"',
      opened ? `"${modal}"` : 'the modal did not open',
      opened && modal.includes(`Approved by ${SUPER_ADMIN.username}`) && modal.includes('A shared login names an account, not a person.') && /Set \S/.test(modal) && !modal.includes('Approved automatically'),
      await shot(page, `${tag}-modal`))
    if (opened) await closeModal(page)
  })
}

async function stateShadow(browser, size, roleKey) {
  const state = freshState({ name: 'A3', mode: 'shadow', recorder: true, rows: rowsShadow(), report: REPORT_SHADOW })
  await withPage(browser, size, roleKey, state, async (page, tag) => {
    const verdictLines = await count(page, '.auto-review--checking, .auto-review--held, .auto-review--auto')
    const checking = await lineOf(page, V.checking)
    const held = await lineOf(page, V.held)
    const rejected = await lineOf(page, V.rejected)
    const options = await statusOptions(page)
    record(`${tag}-lines`, 'Shadow: no verdict line, no filter option', 'no checking, held or auto line; Pending and Rejected receipts no line; filter has no "Approved automatically"',
      `${await layoutOf(page)}: verdict lines ${verdictLines}; ${V.checking} ${lineText(checking)}; ${V.held} ${lineText(held)}; ${V.rejected} ${lineText(rejected)}; filter ${JSON.stringify(options)}`,
      verdictLines === 0 && !checking && !held && !rejected && JSON.stringify(options) === JSON.stringify(OPTIONS_PLAIN), await shot(page, `${tag}-lines`))
    record(`${tag}-info`, 'Shadow with the recorder on: the Approved-by lines (INFO)', 'recorded, not judged: build.md step 3 says "no line under any status", while step 2 shows the recorder alone gives "Approved by"',
      `${V.person} ${lineText(await lineOf(page, V.person))}; ${V.older} ${lineText(await lineOf(page, V.older))}`, 'info')

    if (roleKey === 'sa') {
      const panel = page.locator('.aa-panel')
      const present = (await panel.count()) === 1
      const isOpen = present ? await panel.evaluate((el) => el.open) : null
      const title = present ? await text(page, '.aa-title') : ''
      const badge = present ? await text(page, '.aa-mode') : ''
      const headline = present ? await text(page, '.aa-headline') : ''
      record(`${tag}-panel`, 'Super Admin: the closed panel in shadow', 'one panel, closed; "Fuel receipts approved by rule", "Shadow", "would approve 3 of 12 judged"; 1 report GET',
        present ? `open ${isOpen}, title "${title}", badge "${badge}", headline "${headline}", report GETs ${state.reportGets}` : 'no panel',
        present && isOpen === false && title === 'Fuel receipts approved by rule' && badge === 'Shadow' && headline === 'would approve 3 of 12 judged' && state.reportGets === 1, await shot(page, `${tag}-panel`))
      if (present) {
        await page.locator('.aa-summary').click()
        await page.waitForTimeout(400)
        const counts = await count(page, '.aa-counts')
        const table = await count(page, '.aa-table')
        const labels = (await page.locator('.aa-counts dt').allTextContents()).map(clean)
        const note = await text(page, '.aa-note')
        await page.locator('.aa-panel').scrollIntoViewIfNeeded().catch(() => {})
        record(`${tag}-panel-open`, 'Opened in shadow: counts only, no receipt table', 'a counts list; no table; "Would approve" labelled; the shadow note',
          `counts ${counts}, table ${table}, labels ${JSON.stringify(labels)}, note "${note.slice(0, 60)}"`,
          counts === 1 && table === 0 && labels.includes('Would approve') && !labels.includes('Approved by the pass') && note.startsWith('Shadow:'), await shot(page, `${tag}-panel-open`))
      }
    } else {
      const panel = await count(page, '.aa-panel')
      record(`${tag}-panel`, 'Dispatcher: no panel, no report request', 'no panel; 0 report GETs', `panel ${panel}, report GETs ${state.reportGets}`, panel === 0 && state.reportGets === 0)
    }
  })
}

async function stateOn(browser, size, roleKey) {
  const state = freshState({ name: 'A4', mode: 'on', recorder: true, rows: rowsOn(), report: REPORT_ON })
  await withPage(browser, size, roleKey, state, async (page, tag) => {
    // a. the lines
    const checking = await lineOf(page, V.checking)
    const held = await lineOf(page, V.held)
    const auto = await lineOf(page, V.auto)
    const person = await lineOf(page, V.person)
    const rejected = await lineOf(page, V.rejected)
    const older = await lineOf(page, V.older)
    const lines = await count(page, '.auto-review')
    const options = await statusOptions(page)
    const layout = await layoutOf(page)
    record(`${tag}-a`, 'On: the four lines and the filter option', `checking "Checking automatically"; held "${HELD_LINE}"; auto "Approved automatically"; by "Approved by ${SUPER_ADMIN.username}"; Rejected and empty-record receipts none; the filter option`,
      `${layout}: ${lineText(checking)} | ${lineText(held)} | ${lineText(auto)} | ${lineText(person)} | rejected ${lineText(rejected)} | older ${lineText(older)} | lines ${lines}, filter ${JSON.stringify(options)}`,
      !!checking && checking.kind === 'checking' && checking.text === 'Checking automatically'
      && !!held && held.kind === 'held' && held.text === HELD_LINE
      && !!auto && auto.kind === 'auto' && auto.text === 'Approved automatically'
      && !!person && person.kind === 'by' && person.text === `Approved by ${SUPER_ADMIN.username}`
      && !rejected && !older && lines === 4 && JSON.stringify(options) === JSON.stringify(OPTIONS_AUTO), await shot(page, `${tag}-a`))

    const heldEl = rowFor(page, V.held).locator('.auto-review').first()
    const style = (await heldEl.count()) ? await heldEl.evaluate((el) => {
      const s = getComputedStyle(el)
      return { color: s.color, overflow: s.textOverflow, nowrap: s.whiteSpace, clipped: el.scrollWidth > el.clientWidth }
    }) : null
    record(`${tag}-a-hover`, 'The held line: the full text on hover; ellipsis in the table', 'title carries "The automatic check left this receipt for a person: ..." and the auto line\'s title the evidence; table: text-overflow ellipsis',
      `held title "${held ? held.title.slice(0, 110) : ''}"; auto title "${auto ? auto.title.slice(0, 110) : ''}"; style ${JSON.stringify(style)}; layout ${layout}`,
      !!held && held.title === `The automatic check left this receipt for a person: ${HELD_LINE.slice('Needs a person: '.length)}.`
      && !!auto && auto.title.includes(AUTO_EVIDENCE_START) && auto.title.includes('$380.50')
      && !!style && (layout !== 'table' || style.overflow === 'ellipsis'))

    // b. the modal
    const openedHeld = await openModal(page, V.held)
    const heldItems = openedHeld ? (await page.locator('.exp-auto-review li').allTextContents()).map(clean) : []
    const heldHead = openedHeld ? await modalReview(page) : ''
    await page.locator('.exp-auto-review').first().scrollIntoViewIfNeeded().catch(() => {})
    await shot(page, `${tag}-b-held`)
    if (openedHeld) await closeModal(page)
    const openedAuto = await openModal(page, V.auto)
    const autoModal = openedAuto ? await modalReview(page) : ''
    await page.locator('.exp-auto-review').first().scrollIntoViewIfNeeded().catch(() => {})
    const autoShot = await shot(page, `${tag}-b-auto`)
    if (openedAuto) await closeModal(page)
    record(`${tag}-b`, 'The modal: held reasons as a list; the automatic evidence', 'held: "Needs a person" and two list items; auto: "Approved automatically", the fill and the re-read, no "Set"',
      `held ${openedHeld ? `${JSON.stringify(heldItems)}, head "${heldHead.slice(0, 40)}"` : 'did not open'}; auto ${openedAuto ? `"${autoModal}"` : 'did not open'}`,
      openedHeld && heldHead.startsWith('Needs a person')
      && JSON.stringify(heldItems) === JSON.stringify(['the fill was 63 km away', 'the receipt reads $412.00, the entry says $421.00'])
      && openedAuto && autoModal.startsWith('Approved automatically') && autoModal.includes(AUTO_EVIDENCE_START) && autoModal.includes('the receipt reads $380.50') && !/Set \S/.test(autoModal),
      autoShot)

    // e. the panel (before the filter: it sits above the list)
    if (roleKey === 'sa') {
      const panel = page.locator('.aa-panel')
      const present = (await panel.count()) === 1
      const isOpen = present ? await panel.evaluate((el) => el.open) : null
      const badge = present ? await text(page, '.aa-mode') : ''
      const headline = present ? await text(page, '.aa-headline') : ''
      let tableRows = 0
      let tableText = ''
      let labels = []
      if (present) {
        await page.locator('.aa-summary').click()
        await page.waitForTimeout(400)
        tableRows = await count(page, '.aa-table tbody tr')
        tableText = await text(page, '.aa-table')
        labels = (await page.locator('.aa-counts dt').allTextContents()).map(clean)
        await page.locator('.aa-panel').scrollIntoViewIfNeeded().catch(() => {})
      }
      record(`${tag}-e`, 'Super Admin: the panel in on mode', 'closed at first; "On", "1 of 3 judged passed; 1 approved"; opened: the receipt table with 3 rows, "Approved by the pass"; 1 report GET',
        present ? `open at first ${isOpen}, badge "${badge}", headline "${headline}", table rows ${tableRows}, labels ${labels.includes('Approved by the pass')}, report GETs ${state.reportGets}` : 'no panel',
        present && isOpen === false && badge === 'On' && headline === '1 of 3 judged passed; 1 approved' && tableRows === 3
        && ['#401', '#402', '#403', 'held', 'waiting', 'approved'].every((w) => tableText.includes(w)) && labels.includes('Approved by the pass') && state.reportGets === 1,
        await shot(page, `${tag}-e`))
      if (present) await page.locator('.aa-summary').click()
    } else {
      const panel = await count(page, '.aa-panel')
      record(`${tag}-e`, 'Dispatcher: the lines and the filter, no panel', 'no panel; 0 report GETs (the lines and the option are in step a)', `panel ${panel}, report GETs ${state.reportGets}`, panel === 0 && state.reportGets === 0)
    }

    // c. the filter
    await statusSelect(page).selectOption({ label: 'Approved automatically' })
    const one = await waitForCount(page, ROW_SEL, 1)
    const sent = state.listUrls[state.listUrls.length - 1] || ''
    const status = new URLSearchParams(sent.split('?')[1] || '').get('status')
    const listed = one ? await lineOf(page, V.auto) : null
    const scope = await text(page, '.filter-scope-text')
    const filterShot = await shot(page, `${tag}-c`)
    await page.locator('.filter-scope-clear').click({ timeout: 4000 }).catch(() => {})
    const back = await waitForCount(page, ROW_SEL, 6)
    const scopeAfter = await text(page, '.filter-scope-text')
    record(`${tag}-c`, 'The filter "Approved automatically"', 'the request carries status=Approved automatically; one receipt lists with its line; the scope line names the status; Clear filters brings back all 6',
      `request status ${JSON.stringify(status)}, rows ${one ? 1 : 'not 1'}, ${lineText(listed)}, scope "${scope}"; after Clear: ${back ? 6 : 'not 6'} rows, scope "${scopeAfter}"`,
      status === 'Approved automatically' && one && !!listed && listed.kind === 'auto' && scope.includes('status Approved automatically') && scope.startsWith('1 expense') && back && scopeAfter.includes('no filters set'),
      filterShot)

    // d. Undo on the automatic one
    const undo = rowFor(page, V.auto).locator('.btn-undo').first()
    const hadUndo = (await undo.count()) === 1
    if (hadUndo) await undo.click()
    await page.waitForTimeout(700)
    const after = await lineOf(page, V.auto)
    const pill = await rowFor(page, V.auto).locator('.status-pill').first().textContent().then(clean, () => '')
    const approveBtn = await rowFor(page, V.auto).locator('.btn-approve').count()
    const others = await count(page, '.auto-review')
    const put = state.statusPuts[0]
    record(`${tag}-d`, 'Undo on the automatic receipt', 'one PUT {status:"Pending"} to /api/expenses/403/status; its line gone at once; the pill reads Pending with Approve offered; the other three lines stay',
      `Undo button ${hadUndo}, PUTs ${state.statusPuts.length} ${put ? JSON.stringify(put) : ''}, ${lineText(after)}, pill "${pill}", Approve buttons ${approveBtn}, lines now ${others}`,
      hadUndo && state.statusPuts.length === 1 && put.id === 403 && !!put.body && put.body.status === 'Pending' && !after && pill === 'Pending' && approveBtn === 1 && others === 3,
      await shot(page, `${tag}-d`))
  })
}

// INFO only: the screen's text for an undone review row whose record still names the pass.
async function stateStale(browser, size) {
  const state = freshState({ name: 'A6', mode: 'on', recorder: true, rows: rowsStale(), report: REPORT_STALE })
  await withPage(browser, size, 'sa', state, async (page, tag) => {
    const line = await lineOf(page, 'QA Stale Zeta')
    const opened = await openModal(page, 'QA Stale Zeta')
    const modal = opened ? await modalReview(page) : ''
    await page.locator('.exp-auto-review').first().scrollIntoViewIfNeeded().catch(() => {})
    const modalShot = await shot(page, `${tag}-modal`)
    if (opened) await closeModal(page)
    await statusSelect(page).selectOption({ label: 'Approved automatically' })
    await page.waitForTimeout(700)
    const filtered = await count(page, ROW_SEL)
    const sentList = state.listUrls[state.listUrls.length - 1] || ''
    const panel = page.locator('.aa-panel')
    let panelText = ''
    if ((await panel.count()) === 1) {
      await page.locator('.aa-summary').click()
      await page.waitForTimeout(300)
      panelText = (await text(page, '.aa-counts')).slice(0, 200)
    }
    record(tag, 'INFO (known Low, review L1): an undone review row with a stale record', 'recorded, not judged: auto_review is null from the server; the record still names the pass',
      `line ${lineText(line)}; hover "${line ? line.title : ''}"; modal ${opened ? `"${modal}"` : 'did not open'}; filter request ${sentList.split('?')[1] || ''} lists ${filtered} row(s); panel counts "${panelText}"`,
      'info', modalShot)
  })
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  resultsTxt = path.join(paths.workDir(), `results-${OUT_TAG}.txt`)
  fs.writeFileSync(resultsTxt, `# ${OUT_TAG} ${new Date().toISOString()} (made-up data)\n`, { mode: 0o600 })
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve) })
  console.log(`receipts-auto-approve-screens: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const size of SIZES) {
      for (const roleKey of ['sa', 'disp']) {
        await stateOff(browser, size, roleKey)
        await stateRecorder(browser, size, roleKey)
        await stateShadow(browser, size, roleKey)
        await stateOn(browser, size, roleKey)
      }
      await stateStale(browser, size)
    }
  } finally {
    await browser.close()
    server.close()
  }

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const md = [
    `# Receipt auto-approve screens check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Other writes sent by the page (not part of the verdict): ${otherWrites.length ? otherWrites.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (judged in the A5 rows): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, md, { mode: 0o600 })
  const tally = (v) => rows.filter((r) => r.verdict === v).length
  const summary = `receipts-auto-approve-screens: ${tally('PASS')} PASS, ${tally('FAIL')} FAIL, ${tally('INFO')} INFO of ${rows.length}; results ${resultsFile} and ${resultsTxt}; screenshots ${shotDir()}`
  console.log(summary)
  fs.appendFileSync(resultsTxt, `${summary}\n`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`receipts-auto-approve-screens: aborted: ${e.stack || e}`)
  process.exit(1)
})
