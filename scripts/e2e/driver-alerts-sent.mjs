#!/usr/bin/env node
// LogisX — the Drivers page's "Alerts sent" (a driver's alerts, read-only, for a Super Admin), on
// made-up data only, at 1280 x 800:
//   AS1 a driver's detail dialog lists his alerts: title, text and time on the app's clock, newest
//       first, his own only, one read for his row, no sideways scroll
//   AS2 a list at the cap: "Showing the newest 100.", 100 rows scrolling inside the section, Close
//       still reachable
//   AS3 no alerts    AS4 a row that names no single Driver account    AS5 an answer that can't be read
//   AS6 a 403: no section at all
//   AS7 the dialog closed and another driver opened: none of the first driver's alerts left
//   AS8 a Driver who opens the Drivers page is sent away, and the route is never asked
//   ASx no page errors on the Super Admin's pages, and no write
// The answers are built by lib/driver-alerts-sent.js's own sentView() from made-up rows, and what
// the page should show by client/src/lib/driverAlertsSent.js, so the screens hold exactly what
// the server and the page's own rules give.
//
// Like restore-deleted-load-screen.mjs: no server.js, database, settings file, key or real
// sign-in. The checkout's built client/dist is served from 127.0.0.1, every /api request is
// answered in the browser with made-up fixtures, and every other host is aborted.
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   node scripts/e2e/driver-alerts-sent.mjs
// Env: E2E_PORT (default: a free port; 3000, 5173 and 3901 are refused), HEADED=1, CHROME_PATH,
// E2E_WORK_DIR, SHOT_DIR (an absolute folder outside the checkout; default
// ~/LogisX-replica/reports/cc/work/admin-alerts-sent/screens). Run it outside the Claude Code Bash
// sandbox (Chrome binds its own sockets). Output: PASS/FAIL lines, the screenshots and
// <work dir>/results-driver-alerts-sent.md. Exit 0 only when every row PASSes.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'
import paths from './paths.cjs'
import { ALERTS_WORDS, alertsSentView } from '../../client/src/lib/driverAlertsSent.js'

const require = createRequire(import.meta.url)
const { ALERTS_LIMIT, sentView } = require('../../lib/driver-alerts-sent.js')

const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(os.homedir(), 'LogisX-replica', 'reports', 'cc', 'work', 'admin-alerts-sent', 'screens')
const DESKTOP = { width: 1280, height: 800 }

function die(msg) {
  console.error(`driver-alerts-sent: ${msg}`)
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

// ---------------------------------------------------------------- made-up fixtures
const ADMIN = { id: 90510, username: 'qa-alerts-admin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Alerts Admin', companyName: '', mustChangePassword: false }
const DRIVER = { id: 90511, username: 'qa-alerts-driver', role: 'Driver', driverName: 'Casey Example', email: '', fullName: 'Casey Example', companyName: '', mustChangePassword: false }
const HEADERS = ['Driver', 'Carrier Name', 'State', 'City', 'ZIP', 'Address', 'Trucks', 'Hazmat', 'PhoneNumber', 'CellNumber', 'Email', 'DOT', 'MC', 'Rating', 'Status', 'PayType', 'PayPercentage', 'PayDaily']
const row = (id, name, city, state) => ({
  Driver: name, 'Carrier Name': '', State: state, City: city, ZIP: '00000', Address: '1 QA Way', Trucks: '', Hazmat: 'NO',
  PhoneNumber: '(202) 555-0100', CellNumber: '', Email: `${name.split(' ')[0].toLowerCase()}@example.test`, DOT: '', MC: '', Rating: 'Not Rated',
  Status: 'active', PayType: 'fixed', PayPercentage: 0, PayDaily: 0, ProfilePictureUrl: '', _rowIndex: id, _id: id,
})
const PEOPLE = {
  listed: row(91001, 'Casey Example', 'Lakeview', 'OH'),
  capped: row(91002, 'Riley Sample', 'Hilltop', 'KY'),
  none: row(91003, 'Jordan Newhire', 'Springfield', 'IL'),
  unlinked: row(91004, 'Morgan Unlinked', 'Riverton', 'WY'),
  unreadable: row(91005, 'Taylor Unreadable', 'Fairview', 'TX'),
  refused: row(91006, 'Avery Hidden', 'Greenville', 'SC'),
}
// The rows as the notifications table holds them, newest first; each answer is built by the
// server's own sentView().
const stored = (id, type, title, body, createdAt) => ({ id, type, title, body, metadata: '{"note":"QA-META-ONLY"}', read: 0, createdAt })
const CASEY_ROWS = [
  stored(3, 'resign-requested', 'Please sign again: Equipment Policy', 'Open Documents to sign it.', '2026-11-12T19:30:00Z'),
  stored(2, 'message', 'New message from dispatch', 'Call me when you reach the yard.', '2026-11-11T15:20:00Z'),
  stored(1, 'load-assigned', 'New Load Assigned: QA-7701', 'Lakeview, OH → Hilltop, KY', '2026-11-10T13:05:00Z'),
]
const RILEY_ROWS = Array.from({ length: ALERTS_LIMIT }, (_, i) => stored(500 - i, 'geofence', `At Shipper - Load QA-${8100 + i}`, 'You have arrived at the pickup location', '2026-11-09T17:00:00Z'))
const linked = (rows) => ({ status: 200, body: { linked: true, alerts: rows.map(sentView), limit: ALERTS_LIMIT } })
const ALERTS = {
  [PEOPLE.listed._id]: linked(CASEY_ROWS),
  [PEOPLE.capped._id]: linked(RILEY_ROWS),
  [PEOPLE.none._id]: linked([]),
  [PEOPLE.unlinked._id]: { status: 200, body: { linked: false } },
  [PEOPLE.unreadable._id]: { status: 503, body: { error: 'Service unavailable' } },
  [PEOPLE.refused._id]: { status: 403, body: { error: 'Forbidden' } },
}
const ALERTS_RE = /^\/api\/drivers-directory\/(\d+)\/alerts-sent$/

function answerGet(state, pathname) {
  const ok = (body) => ({ status: 200, body })
  if (pathname === '/api/auth/session') return ok({ authenticated: true, user: state.who, appTimeZone: 'America/New_York' })
  if (pathname === '/api/auth/setup-check') return ok({ needsSetup: false })
  const a = ALERTS_RE.exec(pathname)
  if (a) {
    state.alertReads.push(Number(a[1]))
    if (state.who.role !== 'Super Admin') return { status: 403, body: { error: 'Forbidden' } }
    return ALERTS[a[1]] || { status: 404, body: { error: 'Driver not found', code: 'DRIVER_NOT_FOUND' } }
  }
  if (pathname === '/api/drivers-directory') return ok({ headers: HEADERS, data: Object.values(PEOPLE), total: 6, dailyRateRule: null })
  if (/^\/api\/drivers-directory\/\d+\/documents$/.test(pathname)) return ok({ documents: [], drugTest: null, linked: false, ssn: null })
  if (/^\/api\/drivers-directory\/\d+\/emergency-contacts$/.test(pathname)) return { status: 404, body: { error: 'Not found', code: 'FEATURE_OFF' } }
  if (pathname === '/api/admin/driver-release/acknowledgements') return { status: 404, body: { error: 'Not found', code: 'FEATURE_OFF' } }
  if (pathname === '/api/load-ratings/averages') return ok({ averages: {} })
  if (pathname === '/api/truck-assignments') return ok({ assignments: [] })
  if (pathname === '/api/legal-documents') return ok({ documents: [] })
  if (pathname === '/api/dispatch-notifications') return ok({ notifications: [], unreadCount: 0 })
  if (pathname === '/api/driver/me/release') return ok({ notes: [], tourOffered: false })
  if (/^\/api\/driver\/[^/]+$/.test(pathname)) return ok({ loads: [], notifications: [], messages: [], expenses: [], invoices: [], drivers: [], headers: { jobTracking: [], carrierDB: [] }, onboarding: null })
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the alerts-sent check"}')
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
const offHost = new Set()
const adminErrors = []
const otherErrors = []
const writes = []
let exitCode = 0
function record(step, title, expected, observed, pass, shotFile = '') {
  if (!pass) exitCode = 1
  rows.push({ step, title, expected, observed, verdict: pass ? 'PASS' : 'FAIL', shot: shotFile })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${observed}`)
}
async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(SHOT_DIR, `driver-alerts-sent-${name}.png`)
  try { await page.screenshot({ path: file }) } catch (e) { console.log(`  (screenshot ${name} failed: ${e.message})`) }
  return file
}

// ---------------------------------------------------------------- page helpers
async function openDrivers(browser, who) {
  const state = { who, alertReads: [] }
  const errors = who.role === 'Super Admin' ? adminErrors : otherErrors
  const ctx = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) { offHost.add(u.host); return route.abort() }
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    if (req.method() !== 'GET') {
      writes.push(`${who.role}: ${req.method()} ${u.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    const out = answerGet(state, u.pathname)
    if (out === null) unanswered.add(u.pathname)
    return route.fulfill({ status: out ? out.status : 200, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out ? out.body : {}) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)))
  await page.goto(`${BASE}/drivers`, { waitUntil: 'domcontentloaded' })
  return { ctx, page, state }
}

const squeeze = (t) => (t || '').replace(/\s+/g, ' ').trim()
const testid = (id) => `[data-testid="${id}"]`
const sideways = (page) => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function openDetail(page, person) {
  await page.locator('tr.clickable-row', { hasText: person.Driver }).first().locator('td.name-cell').click()
  await page.locator('.confirm-box').first().waitFor({ state: 'visible', timeout: 10000 })
}
async function closeDetail(page) {
  await page.locator('.confirm-box button', { hasText: 'Close' }).first().click()
  await page.locator('.confirm-box').first().waitFor({ state: 'detached', timeout: 10000 })
}
// What the section shows, once it shows (or after `ms` with nothing).
async function sectionOf(page, ms = 8000) {
  const shown = await page.locator(testid('alerts-sent')).first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false)
  if (!shown) return { shown: false, heading: '', note: '', newest: '', rows: [], text: '' }
  const section = page.locator(testid('alerts-sent')).first()
  await section.scrollIntoViewIfNeeded().catch(() => {})
  const read = async (loc) => (await loc.count()) ? squeeze(await loc.first().textContent()) : ''
  const list = []
  for (const r of await page.locator(testid('alerts-sent-row')).all()) {
    list.push({ title: await read(r.locator('.asp-row-title')), text: await read(r.locator('.asp-row-text')), time: await read(r.locator('.asp-row-time')) })
  }
  return {
    shown: true,
    heading: await read(section.locator('h4')),
    note: await read(page.locator(testid('alerts-sent-note'))),
    newest: await read(page.locator(testid('alerts-sent-newest'))),
    rows: list,
    text: squeeze(await section.textContent()),
  }
}
const expectedRows = (answer) => alertsSentView(answer.body).rows

async function adminRun(browser) {
  const { ctx, page, state } = await openDrivers(browser, ADMIN)
  try {
    await page.locator('tr.clickable-row').first().waitFor({ state: 'visible', timeout: 30000 })
    const listedBefore = state.alertReads.length

    await openDetail(page, PEOPLE.listed)
    let s = await sectionOf(page)
    const want = expectedRows(ALERTS[PEOPLE.listed._id])
    const wide = await sideways(page)
    record('AS1', "A driver's detail dialog lists his alerts: title, text and time on the app's clock, newest first, his own only",
      `"${ALERTS_WORDS.heading}"; rows ${JSON.stringify(want)}; one read, for row ${PEOPLE.listed._id}; no metadata; no sideways scroll`,
      `heading "${s.heading}", rows ${JSON.stringify(s.rows)}, reads ${JSON.stringify(state.alertReads.slice(listedBefore))}, sideways ${wide} px`,
      s.shown && s.heading === ALERTS_WORDS.heading && sameList(s.rows, want) && sameList(state.alertReads.slice(listedBefore), [PEOPLE.listed._id])
        && !s.text.includes('QA-META-ONLY') && !s.text.includes('At Shipper') && wide <= 0,
      await shot(page, 'as1-list-1280'))
    await closeDetail(page)

    await openDetail(page, PEOPLE.capped)
    s = await sectionOf(page)
    const scrolls = await page.locator(`${testid('alerts-sent')} .asp-list`).first().evaluate((el) => el.scrollHeight > el.clientHeight + 10).catch(() => false)
    const close = page.locator('.confirm-box button', { hasText: 'Close' }).first()
    await close.scrollIntoViewIfNeeded().catch(() => {})
    const closeVisible = await close.isVisible().catch(() => false)
    record('AS2', 'A list at the cap says it shows the newest 100, and scrolls inside its section',
      `"${ALERTS_WORDS.heading}"; "Showing the newest ${ALERTS_LIMIT}."; ${ALERTS_LIMIT} rows; the list scrolls; Close reachable`,
      `newest "${s.newest}", rows ${s.rows.length}, list scrolls ${scrolls}, Close visible ${closeVisible}`,
      s.shown && s.newest === `Showing the newest ${ALERTS_LIMIT}.` && s.rows.length === ALERTS_LIMIT && sameList(s.rows, expectedRows(ALERTS[PEOPLE.capped._id])) && scrolls && closeVisible,
      await shot(page, 'as2-newest-100-1280'))
    await closeDetail(page)

    for (const [step, key, title, words, name] of [
      ['AS3', 'none', 'No alerts: the heading and its line', ALERTS_WORDS.none, 'as3-none-1280'],
      ['AS4', 'unlinked', 'A row that names no single Driver account: its line, no rows', ALERTS_WORDS.noAccount, 'as4-no-account-1280'],
      ['AS5', 'unreadable', "An answer that can't be read: its line, no rows", ALERTS_WORDS.unreadable, 'as5-unreadable-1280'],
    ]) {
      await openDetail(page, PEOPLE[key])
      s = await sectionOf(page)
      record(step, title, `"${ALERTS_WORDS.heading}"; "${words}"; no rows`, `heading "${s.heading}", note "${s.note}", rows ${s.rows.length}`,
        s.shown && s.heading === ALERTS_WORDS.heading && s.note === words && s.rows.length === 0, await shot(page, name))
      await closeDetail(page)
    }

    const before = state.alertReads.length
    await openDetail(page, PEOPLE.refused)
    s = await sectionOf(page, 3000)
    record('AS6', 'A 403: no section at all', 'the route asked once; no "Alerts sent" section',
      `reads ${JSON.stringify(state.alertReads.slice(before))}, section shown ${s.shown}`,
      sameList(state.alertReads.slice(before), [PEOPLE.refused._id]) && !s.shown, await shot(page, 'as6-refused-1280'))
    await closeDetail(page)

    await openDetail(page, PEOPLE.listed)
    await sectionOf(page)
    await closeDetail(page)
    await openDetail(page, PEOPLE.none)
    s = await sectionOf(page)
    const leftover = CASEY_ROWS.filter((r) => s.text.includes(r.title)).map((r) => r.title)
    record('AS7', "Another driver's dialog after the first: none of the first driver's alerts left", `"${ALERTS_WORDS.none}"; none of ${PEOPLE.listed.Driver}'s titles`,
      `note "${s.note}", ${PEOPLE.listed.Driver}'s titles shown ${JSON.stringify(leftover)}`, s.shown && s.note === ALERTS_WORDS.none && leftover.length === 0)
    await closeDetail(page)
  } finally {
    await ctx.close()
  }
}

async function driverRun(browser) {
  const { ctx, page, state } = await openDrivers(browser, DRIVER)
  try {
    await page.waitForURL((u) => new URL(String(u)).pathname !== '/drivers', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(1500)
    const where = new URL(page.url()).pathname
    record('AS8', 'A Driver who opens the Drivers page is sent away, and the route is never asked', 'not on /drivers; no read of the route; no section',
      `url ${where}, reads ${JSON.stringify(state.alertReads)}, sections ${await page.locator(testid('alerts-sent')).count()}`,
      where !== '/drivers' && state.alertReads.length === 0 && await page.locator(testid('alerts-sent')).count() === 0)
  } finally {
    await ctx.close()
  }
}

async function main() {
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use: set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ASKED_PORT, HOST, resolve) })
  PORT = server.address().port
  if ([3000, 5173, 3901].includes(PORT)) { server.close(); die(`the system picked port ${PORT}: set E2E_PORT to a free one`) }
  BASE = `http://${HOST}:${PORT}`
  console.log(`driver-alerts-sent: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  let browser = null
  try {
    browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
    for (const [name, fn] of [['admin', adminRun], ['driver', driverRun]]) {
      try { await fn(browser) } catch (e) { record(`AS!-${name}`, `${name} run aborted`, 'no abort', String(e.stack || e).split('\n').slice(0, 3).join(' '), false) }
    }
    record('ASx', "No page errors on the Super Admin's pages, and no write", 'no page errors; no POST, PUT, PATCH or DELETE',
      `${adminErrors.length ? adminErrors.join('; ') : 'no page errors'}; ${writes.join(', ') || 'no writes'}`, adminErrors.length === 0 && writes.length === 0)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await new Promise((r) => server.close(() => r()))
  }
  const resultsFile = path.join(paths.workDir(), 'results-driver-alerts-sent.md')
  const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    '# Drivers page "Alerts sent" check (made-up data)', '',
    `Build: ${DIST}. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Requests to another host, aborted (not part of the verdict): ${[...offHost].sort().join(', ') || 'none'}`,
    '', `Page errors in the Driver's app (not part of the verdict): ${otherErrors.length ? otherErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, out, { mode: 0o600 })
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`driver-alerts-sent: ${passed}/${rows.length} PASS; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`driver-alerts-sent: aborted: ${e.stack || e}`)
  process.exit(1)
})
