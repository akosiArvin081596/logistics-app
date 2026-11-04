#!/usr/bin/env node
// LogisX — the note to CHR's contact after staff approve a driver's day-off request, on made-up
// data only (DRIVER_TIME_OFF_CHR_DRAFT_ENABLED, on top of the day-off requests).
//
// The "server" has no CHR contact address (TIME_OFF_CHR_DRAFT_TO unset) and no mailbox login. The
// note's state and line come from lib/time-off-chr-draft.js itself, run in this process with the
// same inputs server.js gives it (made-up driver "Casey Example", truck "LogisX-#33", no deny
// values), so the page shows what the server would answer:
//   N   Notifications (made-up Dispatcher "qa-chrnote-dispatcher"), at 375x812 and 1280x800, with
//       the switch on (state no_recipient) and off (state off): Approve sends one POST {}; the
//       notice says who approved, then the state's words, the line and a Copy button (44 px at
//       375); Copy puts exactly the line on the clipboard and reads "Copied"; after a reload the
//       notice still shows the words and the line
//   P   the Drivers time-off panel after an approval in it: the Drivers page's Edit dialog as a
//       made-up Super Admin ("qa-chrnote-admin") at 1280x800, switch on and off, and the
//       dashboard's Fleet & Drivers dialog as the Dispatcher at 375x812, switch on: the answer's
//       words, line and Copy under the title; the row moves to the live list as "Asked by the
//       driver, approved by ..."; the row itself carries no note block and no Retry (no draft row
//       exists for no_recipient or off)
//   G   nothing reaches Gmail: every approval's state is no_recipient or off, never pending (the
//       only state server.js queues a Gmail step for); no POST to the Retry route
//       (/api/driver-availability/:id/chr-draft) and no Retry button shown; this process opened
//       no TLS connection and no socket to any host but 127.0.0.1; the browser asked no mail host
// Step names carry the switch and the size.
//
// Like driver-day-off-requests.mjs this boots no server.js, opens no database, reads no settings
// file or key and signs nobody in. It serves the checkout's built client/dist from its own static
// server on 127.0.0.1 (E2E_PORT, or a free port the system picks) and answers every /api request
// in the browser with made-up fixtures. Every request to another host is aborted, the socket
// included, so no live event arrives.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/time-off-chr-draft.mjs
//
// Env: E2E_PORT (default: a free port; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "time-off-chr-draft"), HEADED=1, CHROME_PATH, E2E_WORK_DIR, SHOT_DIR (an
// absolute folder outside the checkout; default ~/LogisX-replica/screens/time-off-chr-draft).
// Output: PASS/FAIL lines, a final count, the screenshots and <work dir>/results-<OUT_TAG>.md.
// Exit 0 only when every row PASSes.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { createRequire } from 'node:module'
import paths from './paths.cjs'

const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'time-off-chr-draft').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.homedir(), 'LogisX-replica', 'screens', 'time-off-chr-draft')
const PHONE = { tag: '375x812', viewport: { width: 375, height: 812 } }
const DESKTOP = { tag: '1280x800', viewport: { width: 1280, height: 800 } }

function die(msg) {
  console.error(`time-off-chr-draft: ${msg}`)
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

// ---------------------------------------------------------------- nothing leaves this process
// Gmail is IMAP over TLS: any TLS connection, or a socket to a host other than 127.0.0.1, is
// refused before it opens and counted for G.
const wire = { tls: [], remote: [], offHost: new Set(), retryPosts: 0, retryButtons: 0, states: [] }
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', ''])
function targetOf(args) {
  const a = args[0]
  if (a && typeof a === 'object') return a.path ? '' : String(a.host || a.hostname || '')
  if (typeof a === 'number' || /^\d+$/.test(String(a))) return typeof args[1] === 'string' ? args[1] : ''
  return ''
}
tls.connect = function refusedTls(...args) {
  wire.tls.push(targetOf(args) || '(unnamed)')
  throw new Error('time-off-chr-draft: TLS refused in this check')
}
const realNetConnect = net.connect
function guardedConnect(...args) {
  const host = targetOf(args)
  if (!LOOPBACK.has(host)) {
    wire.remote.push(host)
    throw new Error('time-off-chr-draft: only 127.0.0.1 is reachable in this check')
  }
  return realNetConnect.apply(this, args)
}
net.connect = guardedConnect
net.createConnection = guardedConnect

// ---------------------------------------------------------------- the note, from the server's own module
const require = createRequire(import.meta.url)
const chrNote = require(path.join(paths.REPO, 'lib', 'time-off-chr-draft.js'))
// No deny values and no address: what the harness holds. chrRecipient('') is "" (no draft).
const denyHits = chrNote.createDenyCheck('')
const RECIPIENT_OK = !!chrNote.chrRecipient('')

// ---------------------------------------------------------------- made-up fixtures
const DISPATCHER = { id: 90311, username: 'qa-chrnote-dispatcher', role: 'Dispatcher', driverName: '', email: '', fullName: 'QA Chrnote Dispatcher', companyName: '', mustChangePassword: false }
const ADMIN = { id: 90310, username: 'qa-chrnote-admin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Chrnote Admin', companyName: '', mustChangePassword: false }
const DRIVER_NAME = 'Casey Example'
const DRIVER_USER = 'qa-chrnote-driver'
const UNIT = 'LogisX-#33'
const DIRECTORY_ID = 511
const DAY = 24 * 60 * 60 * 1000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const KIND_LABEL = { vacation: 'Vacation', off_duty: 'Off duty', other: 'Other' }
// The staff words with a line (client/src/lib/availabilityText.js), pinned here as the screen's copy.
const WORDS = {
  no_recipient: 'No CHR contact address is set, so no draft was made. Tell CHR\'s contact by hand:',
  off: 'Tell CHR\'s contact:',
}
const RETRY_TEXT = 'Retry the note to CHR'

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const dayIndex = (k) => Math.round(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10))) / DAY)
const shift = (k, n) => new Date((dayIndex(k) + n) * DAY).toISOString().slice(0, 10)
const md = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8, 10))}`
function rangeText(from, to) {
  if (from === to) return md(from)
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${md(from)}, ${from.slice(0, 4)} – ${md(to)}, ${to.slice(0, 4)}`
  return `${md(from)} – ${md(to)}`
}

// The answer server.js gives an approval (startTimeOffChrDraft()): the module's decision for the
// driver's row on today's business day, as chrDraftAnswer() shapes it.
function chrDecision(state, row) {
  const decided = chrNote.chrDraftDecision(
    { driverName: DRIVER_NAME, unit: UNIT, from: row.from, to: row.to, todayKey: TODAY },
    { draftOn: state.chrOn, recipientOk: RECIPIENT_OK, staffRecorded: false, denyHits },
  )
  return chrNote.chrDraftAnswer(decided)
}

// `chrOn` is DRIVER_TIME_OFF_CHR_DRAFT_ENABLED; the day-off requests are on throughout.
function freshState({ chrOn }) {
  return { chrOn, rows: [], notices: [], nextId: 8101, nextNotice: 9101, calls: { approve: [], decline: [], retry: [] } }
}

function addRequest(state, { from, to, kind = 'vacation' }) {
  const row = { id: state.nextId++, kind, from, to, request: 'waiting', source: 'driver', decidedBy: null, chrDraft: null, createdAt: new Date().toISOString() }
  state.rows.push(row)
  state.notices.push({
    id: state.nextNotice++, rowId: row.id,
    title: `Time off request: ${DRIVER_NAME} (${rangeText(from, to)})`,
    body: `${KIND_LABEL[kind]}. Asked ${md(TODAY)}.`,
    read: 0, createdAt: new Date().toISOString(),
  })
  return row
}

const rowStatus = (r) => (r.to < TODAY ? 'past' : r.from > TODAY ? 'upcoming' : 'current')

// A panel row as the server sends it. No `chrDraft`: server.js adds one only for a row with a
// draft row, and no_recipient and off store none.
function staffRowView(r) {
  return {
    id: r.id, directoryId: DIRECTORY_ID, kind: r.kind, from: r.from, to: r.to, reason: '', createdBy: DRIVER_USER,
    createdAt: r.createdAt, updatedAt: null, cancelledAt: null, cancelledBy: null, status: rowStatus(r), editable: 'none', limits: null,
    request: r.request, source: r.source, decidedBy: r.decidedBy, decidedAt: r.decidedBy ? new Date().toISOString() : null,
  }
}

// The notice as the server stores it: the decision, and at approval the note's chrDraft
// (markTimeOffChrDraftNotice()).
function noticeView(state, n) {
  const row = state.rows.find((r) => r.id === n.rowId)
  const meta = { availabilityId: n.rowId, directoryId: DIRECTORY_ID }
  if (row && row.request !== 'waiting') Object.assign(meta, { decision: row.request, decidedBy: row.decidedBy || '' })
  if (row && row.chrDraft) meta.chrDraft = row.chrDraft
  return { id: n.id, type: 'time-off-request', title: n.title, body: n.body, metadata: JSON.stringify(meta), read: n.read, createdAt: n.createdAt }
}

const DIRECTORY_ROW = {
  Driver: DRIVER_NAME, 'Carrier Name': '', State: 'TX', City: 'Austin', ZIP: '78701', Address: '1 Example St', Trucks: UNIT, Hazmat: '',
  PhoneNumber: '', CellNumber: '', Email: 'casey.example@example.test', DOT: '', MC: '', Rating: '', Status: 'active',
  PayType: 'fixed', PayPercentage: 0, PayDaily: 0, ProfilePictureUrl: '', OffFrom: '', OffTo: '', _rowIndex: DIRECTORY_ID, _id: DIRECTORY_ID,
}
const DIRECTORY = {
  headers: ['Driver', 'Carrier Name', 'State', 'City', 'ZIP', 'Address', 'Trucks', 'Hazmat', 'PhoneNumber', 'CellNumber', 'Email', 'DOT', 'MC', 'Rating', 'Status', 'PayType', 'PayPercentage', 'PayDaily'],
  data: [DIRECTORY_ROW], total: 1, dailyRateRule: null,
}
const DASHBOARD = {
  timestamp: new Date().toISOString(),
  kpis: { activeLoads: 0, unassignedLoads: 0, completedThisWeek: 0, completedThisMonth: 0, fleetUtilization: { assigned: 0, total: 1 }, revenue: { total: 0, paid: 0, pending: 0 } },
  unassignedJobs: [], jobTrackingHeaders: [], completedHeaders: [], activeJobs: [], completedJobs: [],
  fleet: [{ Driver: DRIVER_NAME, Truck: UNIT, Status: 'Available', CompletedLoads: 3, CurrentLoad: '', Phone: '', QueueCount: 0, QueuedLoadIds: [], offUntil: '' }],
  drivers: [DRIVER_NAME], driverQueues: {},
}

const FORBIDDEN = { status: 403, body: { error: 'Forbidden' } }
const parse = (raw) => { try { return JSON.parse(raw || 'null') } catch { return null } }

function answerGet(who, state, pathname) {
  if (pathname === '/api/auth/session') return { status: 200, body: { authenticated: true, user: who, appTimeZone: 'America/New_York' } }
  if (pathname === '/api/dispatch-notifications') {
    const list = state.notices.slice().reverse().map((n) => noticeView(state, n))
    return { status: 200, body: { notifications: list, unreadCount: list.filter((n) => !n.read).length } }
  }
  if (pathname === `/api/drivers-directory/${DIRECTORY_ID}/availability`) {
    const rows = state.rows.slice().sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : b.id - a.id)).map(staffRowView)
    return { status: 200, body: { directoryId: DIRECTORY_ID, driver: DRIVER_NAME, today: TODAY, createLimits: { fromMin: shift(TODAY, -30), toMin: null, maxDays: 60 }, rows } }
  }
  if (pathname === '/api/drivers-directory') return { status: 200, body: DIRECTORY }
  if (pathname === '/api/dashboard') return { status: 200, body: DASHBOARD }
  if (pathname === '/api/load-ratings/averages') return { status: 200, body: { averages: {} } }
  if (pathname === '/api/truck-assignments') return { status: 200, body: { assignments: [] } }
  if (pathname === '/api/config/maps-key') return { status: 200, body: { key: 'qa-chrnote-no-key' } }
  if (pathname === '/api/locations/latest') return { status: 200, body: { locations: [] } }
  return null
}

// The approve and decline routes as the server answers them, and the Retry route (an unknown path
// while the switch is off; with it on, no draft row exists to retry). null for any other write.
function answerPost(who, state, pathname, raw) {
  const body = parse(raw)
  let m
  if ((m = pathname.match(/^\/api\/driver-availability\/(\d+)\/chr-draft$/))) {
    state.calls.retry.push({ id: Number(m[1]) })
    wire.retryPosts++
    if (!state.chrOn) return { status: 404, body: { error: 'Not found' } }
    return { status: 404, body: { error: 'This time off has no note to CHR\'s contact.', code: 'CHR_DRAFT_NOT_FOUND' } }
  }
  if ((m = pathname.match(/^\/api\/driver-availability\/(\d+)\/(approve|decline)$/))) {
    if (who.role !== 'Super Admin' && who.role !== 'Dispatcher') return FORBIDDEN
    const decision = m[2]
    state.calls[decision].push({ id: Number(m[1]), body })
    const row = state.rows.find((r) => r.id === Number(m[1]))
    if (!row) return { status: 404, body: { error: 'Time off not found', code: 'AVAILABILITY_NOT_FOUND' } }
    if (row.request !== 'waiting') return { status: 409, body: { error: 'This request was just decided.', code: 'TIME_OFF_REQUEST_DECIDED' } }
    row.request = decision === 'approve' ? 'approved' : 'declined'
    row.decidedBy = who.username
    if (decision === 'decline') return { status: 200, body: { success: true, decision: 'declined', decidedBy: who.username, row: staffRowView(row) } }
    row.chrDraft = chrDecision(state, row)
    wire.states.push(row.chrDraft.state)
    return { status: 200, body: { success: true, decision: 'approved', decidedBy: who.username, row: staffRowView(row), chrDraft: row.chrDraft } }
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
    res.end('{"error":"not served by the CHR note check"}')
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
const dialogs = []
let exitCode = 0
function record(step, title, expected, observed, ok, shot = '') {
  if (!ok) exitCode = 1
  rows.push({ step, title, expected, observed, verdict: ok ? 'PASS' : 'FAIL', shot })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${observed}`)
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(SHOT_DIR, `${OUT_TAG}-${name}.png`)
  await page.screenshot({ path: file })
  return file
}

// ---------------------------------------------------------------- page helpers
async function openPage(browser, size, who, state, url) {
  const phone = size.viewport.width < 640
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) { wire.offHost.add(u.host); return route.abort() }
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
  page.on('dialog', (d) => { dialogs.push(`${size.tag}: ${d.type()}`); d.dismiss().catch(() => {}) })
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' })
  return { ctx, page }
}

const locText = (loc) => loc.first().textContent({ timeout: 2000 }).then((t) => (t || '').replace(/\s+/g, ' ').trim(), () => '')
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
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1)
const boxHeight = async (loc) => { const b = await loc.first().boundingBox().catch(() => null); return b ? Math.round(b.height) : 0 }
const readClipboard = (page) => page.evaluate(() => navigator.clipboard.readText()).catch((e) => `(clipboard unreadable: ${String(e && e.message ? e.message : e).slice(0, 80)})`)
const retryCount = async (page) => { const n = await page.locator('button', { hasText: RETRY_TEXT }).count(); wire.retryButtons += n; return n }

// What the screen should say for the switch: the module's state and line, and the staff words.
function expectedFor(chrOn, from, to) {
  const answer = chrDecision({ chrOn }, { from, to })
  return { state: answer.state, line: answer.line || '', words: WORDS[answer.state] || '(none)' }
}

// Copy puts exactly the line on the clipboard and the button says so.
async function copyStep(page, button, step, line) {
  const dialogsBefore = dialogs.length
  await page.evaluate(() => navigator.clipboard.writeText('')).catch(() => {})
  await button.first().click()
  await page.waitForTimeout(150)
  const said = await locText(button)
  const clip = await readClipboard(page)
  record(step, 'Copy puts the line on the clipboard', `clipboard "${line}"; button "Copied"; no prompt`,
    `clipboard "${clip}", button "${said}", prompts ${dialogs.length - dialogsBefore}`,
    clip === line && said === 'Copied' && dialogs.length === dialogsBefore, await shot(page, step))
}

// ---------------------------------------------------------------- N: approve from Notifications
async function notificationsRun(browser, size, chrOn) {
  const tag = `N-${chrOn ? 'on' : 'off'}-${size.tag}`
  const state = freshState({ chrOn })
  const FROM = shift(TODAY, 9)
  const TO = shift(TODAY, 11)
  const RANGE = rangeText(FROM, TO)
  const want = expectedFor(chrOn, FROM, TO)
  addRequest(state, { from: FROM, to: TO })
  const { ctx, page } = await openPage(browser, size, DISPATCHER, state, '/notifications')
  try {
    const shown = await appears(page, '.notif-item', 15000)
    const item = page.locator('.notif-item', { hasText: `(${RANGE})` }).first()
    const approve = item.locator('.notif-act', { hasText: 'Approve' })
    const ready = shown && (await approve.count()) === 1
    const chrBefore = shown ? await item.locator('.notif-chr').count() : -1
    if (ready) await approve.click()
    const decided = ready && await appears(page, '.notif-decision', 6000)
    const chrShown = decided && await appears(page, '.notif-chr', 4000)
    const decision = decided ? await locText(item.locator('.notif-decision')) : ''
    const words = chrShown ? await locText(item.locator('.notif-chr > span').first()) : ''
    const line = chrShown ? await locText(item.locator('.notif-chr-line')) : ''
    const copy = item.locator('.notif-chr button')
    const copyText = chrShown ? await locText(copy) : ''
    const copyHeight = chrShown ? await boxHeight(copy) : 0
    const leftover = (await item.locator('.notif-act', { hasText: /^(Approve|Decline)$/ }).count())
    const fits = await noSideScroll(page)
    const retry = await retryCount(page)
    const call = state.calls.approve[0]
    const phone = size.viewport.width < 640
    record(tag, `Approve from Notifications (switch ${chrOn ? 'on, no address' : 'off'})`,
      `one approve POST {}; state ${want.state}; "Approved by ${DISPATCHER.username}"; words "${want.words}"; line "${want.line}"; Copy${phone ? ' >= 44 px' : ''}; no note before approval; no Approve/Decline left; no Retry; no side scroll`,
      `POSTs ${state.calls.approve.length} ${JSON.stringify(call && call.body)}, state ${state.rows[0].chrDraft ? state.rows[0].chrDraft.state : '(none)'}, decision "${decision}", words "${words}", line "${line}", copy "${copyText}" ${copyHeight} px, note before ${chrBefore}, buttons left ${leftover}, retry ${retry}, fits ${fits}`,
      ready && state.calls.approve.length === 1 && JSON.stringify(call.body) === '{}' && state.rows[0].chrDraft && state.rows[0].chrDraft.state === want.state
        && decision === `Approved by ${DISPATCHER.username}` && words === want.words && !!want.line && line === want.line && copyText === 'Copy'
        && (!phone || copyHeight >= 44) && chrBefore === 0 && leftover === 0 && retry === 0 && fits,
      await shot(page, tag))
    if (!chrShown) return

    await copyStep(page, copy, `${tag}-copy`, want.line)

    await page.reload({ waitUntil: 'domcontentloaded' })
    const again = await appears(page, '.notif-chr', 15000)
    const item2 = page.locator('.notif-item', { hasText: `(${RANGE})` }).first()
    const words2 = again ? await locText(item2.locator('.notif-chr > span').first()) : ''
    const line2 = again ? await locText(item2.locator('.notif-chr-line')) : ''
    const decision2 = again ? await locText(item2.locator('.notif-decision')) : ''
    const retry2 = await retryCount(page)
    record(`${tag}-reload`, 'After a reload the notice still carries the note\'s words and line',
      `"Approved by ${DISPATCHER.username}"; words "${want.words}"; line "${want.line}"; no Retry; still one approve POST`,
      `decision "${decision2}", words "${words2}", line "${line2}", retry ${retry2}, POSTs ${state.calls.approve.length}`,
      again && decision2 === `Approved by ${DISPATCHER.username}` && words2 === want.words && line2 === want.line && retry2 === 0 && state.calls.approve.length === 1,
      await shot(page, `${tag}-reload`))
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- P: the Drivers time-off panel
const PANEL = 'section.avail'
const WAITING_LIST = `${PANEL} ul[aria-label="Waiting for approval"]`
const LIVE_LIST = `${PANEL} > ul.avail-list:not([aria-label])`
const ANSWER_NOTE = `${PANEL} > .avail-chr`

// The Drivers page's Edit dialog (Super Admin), or the dashboard's Fleet & Drivers dialog.
async function openPanel(page, host) {
  if (host === 'drivers') {
    const row = page.locator('.drv-table tbody tr', { hasText: DRIVER_NAME }).first()
    await row.locator('button.btn-edit').click({ timeout: 15000 })
  } else {
    await page.locator('[role="tab"]', { hasText: 'Fleet & Drivers' }).first().click({ timeout: 15000 })
    await page.locator('.fleet-card', { hasText: DRIVER_NAME }).first().click({ timeout: 8000 })
  }
}

async function panelRun(browser, size, who, host, chrOn) {
  const tag = `P-${host}-${chrOn ? 'on' : 'off'}-${size.tag}`
  const state = freshState({ chrOn })
  const FROM = shift(TODAY, 14)
  const TO = shift(TODAY, 15)
  const RANGE = rangeText(FROM, TO)
  const want = expectedFor(chrOn, FROM, TO)
  addRequest(state, { from: FROM, to: TO, kind: 'off_duty' })
  const { ctx, page } = await openPage(browser, size, who, state, host === 'drivers' ? '/drivers' : '/dashboard')
  try {
    let opened = false
    try { await openPanel(page, host); opened = true } catch { opened = false }
    const listed = opened && await appears(page, WAITING_LIST, 10000)
    if (!listed) {
      record(tag, `Approve in the Drivers time-off panel (${host}, switch ${chrOn ? 'on, no address' : 'off'})`, 'the panel lists the waiting request',
        opened ? 'no waiting list within 10 s' : 'the dialog did not open', false, await shot(page, tag))
      return
    }
    const noteBefore = await page.locator(ANSWER_NOTE).count()
    await page.locator(`${WAITING_LIST} li`).first().locator('button', { hasText: 'Approve' }).click()
    const sent = await until(() => state.calls.approve.length === 1, 5000)
    const noted = sent && await appears(page, ANSWER_NOTE, 6000)
    await page.waitForTimeout(600)
    const words = noted ? await locText(page.locator(`${ANSWER_NOTE} > span`).first()) : ''
    const line = noted ? await locText(page.locator(`${ANSWER_NOTE} .avail-chr-line`)) : ''
    const copy = page.locator(`${ANSWER_NOTE} button`)
    const copyText = noted ? await locText(copy) : ''
    const waitingLeft = await page.locator(`${WAITING_LIST} li`).count()
    const live = await locText(page.locator(LIVE_LIST))
    const rowNotes = await page.locator(`${PANEL} li .avail-chr`).count()
    const retry = await retryCount(page)
    const fits = await noSideScroll(page)
    const call = state.calls.approve[0]
    record(tag, `Approve in the Drivers time-off panel (${host}, switch ${chrOn ? 'on, no address' : 'off'})`,
      `one approve POST {}; state ${want.state}; under the title: words "${want.words}", line "${want.line}", Copy; the row in the live list "${RANGE}" "Asked by the driver, approved by ${who.username}"; no waiting row; no note block on the row; no Retry; no side scroll`,
      `POSTs ${state.calls.approve.length} ${JSON.stringify(call && call.body)}, state ${state.rows[0].chrDraft ? state.rows[0].chrDraft.state : '(none)'}, note before ${noteBefore}, words "${words}", line "${line}", copy "${copyText}", waiting rows ${waitingLeft}, live "${live}", row notes ${rowNotes}, retry ${retry}, fits ${fits}`,
      sent && JSON.stringify(call.body) === '{}' && state.rows[0].chrDraft && state.rows[0].chrDraft.state === want.state && noteBefore === 0
        && words === want.words && !!want.line && line === want.line && copyText === 'Copy' && waitingLeft === 0
        && live.includes(RANGE) && live.includes(`Asked by the driver, approved by ${who.username}`) && rowNotes === 0 && retry === 0 && fits,
      await shot(page, tag))
    if (noted) await copyStep(page, copy, `${tag}-copy`, want.line)
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- G: nothing reaches Gmail
function gmailStep() {
  const states = [...new Set(wire.states)]
  const offHost = [...wire.offHost].sort()
  const mailHosts = offHost.filter((h) => /mail|imap|smtp/i.test(h))
  const imapLoaded = Object.keys(require.cache).some((k) => k.endsWith(`${path.sep}lib${path.sep}imap-draft.js`))
  record('G', 'Nothing reaches Gmail',
    'every approval no_recipient or off (never pending, the only state server.js queues a Gmail step for); 0 Retry POSTs; 0 Retry buttons; 0 TLS connections; 0 sockets to a host but 127.0.0.1; no mail host asked by the browser',
    `approvals ${wire.states.length} states ${JSON.stringify(states)}, Retry POSTs ${wire.retryPosts}, Retry buttons ${wire.retryButtons}, TLS ${JSON.stringify(wire.tls)}, remote sockets ${JSON.stringify(wire.remote)}, browser off-host (aborted) ${JSON.stringify(offHost)}, lib/imap-draft.js loaded here ${imapLoaded} (not part of the verdict)`,
    wire.states.length > 0 && wire.states.every((s) => s === 'no_recipient' || s === 'off') && wire.retryPosts === 0 && wire.retryButtons === 0
      && wire.tls.length === 0 && wire.remote.length === 0 && mailHosts.length === 0)
}

// The module's own answer before any page: the switch on with no address gives no_recipient and
// the line, off gives off and the same line; nothing here is pending.
function moduleStep() {
  const from = shift(TODAY, 9)
  const to = shift(TODAY, 11)
  const on = expectedFor(true, from, to)
  const off = expectedFor(false, from, to)
  const lead = `Driver ${DRIVER_NAME}, LogisX truck #33, unavailable `
  record('M', 'The note\'s module answers no_recipient (on, no address) and off, with the line',
    `recipient set false; on: no_recipient; off: off; both lines start "${lead}" and name ${md(from)} and ${md(to)}`,
    `recipient set ${RECIPIENT_OK}; on: ${on.state} "${on.line}"; off: ${off.state} "${off.line}"`,
    !RECIPIENT_OK && on.state === 'no_recipient' && off.state === 'off' && on.line === off.line && on.line.startsWith(lead) && on.line.includes(md(from)) && on.line.includes(md(to)))
}

async function main() {
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ASKED_PORT, HOST, resolve) })
  PORT = server.address().port
  if (PORT === 3000 || PORT === 5173) { server.close(); die(`the system picked port ${PORT}: set E2E_PORT to a free one`) }
  BASE = `http://${HOST}:${PORT}`
  console.log(`time-off-chr-draft: serving ${DIST} on ${BASE} (made-up data; no server.js, no mailbox, no address)`)
  moduleStep()
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    await notificationsRun(browser, PHONE, true)
    await notificationsRun(browser, DESKTOP, true)
    await notificationsRun(browser, PHONE, false)
    await notificationsRun(browser, DESKTOP, false)
    await panelRun(browser, DESKTOP, ADMIN, 'drivers', true)
    await panelRun(browser, PHONE, DISPATCHER, 'fleet', true)
    await panelRun(browser, DESKTOP, ADMIN, 'drivers', false)
  } finally {
    await browser.close()
    server.close()
  }
  gmailStep()

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    `# CHR day-off note check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Other writes sent by the page (not part of the verdict): ${otherWrites.length ? otherWrites.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, out, { mode: 0o600 })
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`time-off-chr-draft: ${passed}/${rows.length} PASS, ${rows.length - passed} FAIL; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  if (pageErrors.length) console.log(`time-off-chr-draft: page errors: ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`time-off-chr-draft: aborted: ${e.stack || e}`)
  process.exit(1)
})
