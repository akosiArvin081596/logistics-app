#!/usr/bin/env node
// LogisX — the emergency contacts item on the driver's onboarding lock screen, on
// made-up data only (plan PR 2, EMERGENCY_CONTACTS_ENABLED).
//
// With the flag on, a driver who has signed every onboarding document stays at the
// signing step until two emergency contacts are on file. The lock screen lists the
// contacts as one more item of step 1, and the form behind its button saves them;
// the second contact moves the driver on.
//
// At 375x667 and 390x664 (a phone, touch), as a made-up Driver ("Casey Example",
// user id 90102) with all five documents signed and no contacts yet:
//   E1  the item shows "0 of 2 added" with an Add button; the progress counts it
//       (5 of 6, 83%); "Documents Received!" is not shown yet
//   E2  Add opens the form (the list read from the driver's own route); one contact
//       and a blank row: "Add at least two contacts." shows above Save, nothing is
//       sent, and Save is inside the window and on top
//   E3  a second contact and Save: one PUT with both, answered by the server's own
//       rules; the form closes, the item reads "2 added", the progress 100%, and the
//       step has moved: "Documents Received!" shows
//   E4  Edit reads the list again (it is never kept on the phone) and shows the two
//       saved contacts, the US number as the server shows it
//   E5  a refusal only the server can give (409 CONTACT_NOT_FOUND, the list changed
//       somewhere else) is shown in words and the form stays open
// Step names carry the size: E3-390x664 is E3 at 390x664.
//
// Like driver-document-sign.mjs this boots no server.js, opens no database, reads no
// settings file or key and signs nobody in. It serves the checkout's built
// client/dist from its own static server on 127.0.0.1 (E2E_PORT, default 3181) and
// answers every /api request in the browser with made-up fixtures; the contacts PUT
// is judged by lib/emergency-contacts.js in this process, the rules the server runs.
// Every request to another host is aborted, the socket included.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   node scripts/e2e/driver-emergency-contacts.mjs
//
// Before and after: build origin/main's client and run with OUT_TAG=main (E1 fails
// at every size: there is no item, so nothing after it can run), then build the
// branch and run with OUT_TAG=branch (every row PASSes).
//
// Env: E2E_PORT (default 3181; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "driver-emergency-contacts"), HEADED=1, CHROME_PATH, E2E_WORK_DIR,
// SHOT_DIR (an absolute folder outside the checkout for the screenshots; default
// <work dir>/shots/<OUT_TAG>). Output: the screenshots and
// <work dir>/results-<OUT_TAG>.md. Exit 0 only when every row PASSes.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import paths from './paths.cjs'

const require = createRequire(import.meta.url)
const rules = require(path.join(paths.REPO, 'lib', 'emergency-contacts.js'))

const PORT = Number(process.env.E2E_PORT || 3181)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'driver-emergency-contacts').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const SIZES = [
  { tag: '375x667', viewport: { width: 375, height: 667 } },
  { tag: '390x664', viewport: { width: 390, height: 664 } },
]

function die(msg) {
  console.error(`driver-emergency-contacts: ${msg}`)
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
const USER_ID = 90102
const DRIVER = 'Casey Example'
const DOCS = [
  ['contractor_agreement', 'Contractor Agreement'], ['equipment_policy', 'Contracted Provider Equipment Policy'], ['w9', 'W-9 Tax Form'],
  ['mobile_policy', 'LogisX Inc. Mobile Policy'], ['substance_policy', 'Substance Policy and Procedure'],
].map(([docKey, name]) => ({ doc_key: docKey, doc_name: name, signed: true, signature_text: DRIVER, signed_at: '2026-10-20T15:00:00.000Z', signed_pdf_url: '' }))
const FIRST = { name: 'Quinn Example', relationship: 'Spouse', phone: '(202) 555-0143' }
const SECOND = { name: 'Jordan Placeholder', relationship: 'Friend', phone: '+44 20 7946 0958' }

// One driver per browser context: what the "server" holds for him.
function freshState() {
  return { status: 'documents_pending', stored: [], nextId: 7101, gets: 0, puts: [], conflictNext: false }
}

function payload(state) {
  return {
    loads: [],
    headers: { jobTracking: [], carrierDB: [] },
    onboarding: { user_id: USER_ID, status: state.status, onboarded_at: null, documents: DOCS, totalDocs: DOCS.length },
    driverInfo: null,
    truck: null,
    messages: [],
    notifications: [],
    expenses: [],
    drivers: [],
    invoices: [],
    sharedDocuments: [],
    truckDocuments: [],
    emergencyContacts: { required: rules.MIN_CONTACTS, maximum: rules.MAX_CONTACTS, onFile: state.stored.length },
  }
}

function listBody(state) {
  const contacts = state.stored.map((r) => rules.contactView(r))
  return { contacts, minimum: rules.MIN_CONTACTS, maximum: rules.MAX_CONTACTS, complete: contacts.length >= rules.MIN_CONTACTS }
}

function answerGet(state, pathname) {
  if (pathname === '/api/auth/session') {
    return {
      authenticated: true,
      user: { id: USER_ID, username: 'qa-contacts-driver', role: 'Driver', driverName: DRIVER, email: '', fullName: DRIVER, companyName: '', mustChangePassword: false },
      appTimeZone: 'America/New_York',
    }
  }
  if (pathname === `/api/driver/${encodeURIComponent(DRIVER)}`) return payload(state)
  if (pathname === '/api/driver/me/emergency-contacts') { state.gets++; return listBody(state) }
  if (pathname === '/api/fuel/range') return { ok: false }
  return null
}

// The PUT as the server answers it: its own validation, its ids kept, and the
// signing step moving on once two are on file (every document here is signed).
function answerPut(state, raw) {
  let body = null
  try { body = JSON.parse(raw || 'null') } catch { body = null }
  state.puts.push(body)
  if (state.conflictNext) {
    state.conflictNext = false
    return { status: 409, body: { error: 'This list was changed somewhere else. Open it again, then save your changes.', code: 'CONTACT_NOT_FOUND' } }
  }
  const v = rules.validateContactList(body)
  if (!v.ok) return { status: v.status, body: { error: v.error, code: v.code, ...(v.index === undefined ? {} : { index: v.index }) } }
  const owned = new Set(state.stored.map((r) => r.id))
  if (v.list.some((c) => c.id !== null && !owned.has(c.id))) return { status: 409, body: { error: 'Not on this list', code: 'CONTACT_NOT_FOUND' } }
  state.stored = v.list.map((c) => ({ id: c.id === null ? state.nextId++ : c.id, position: c.position, contact_name: c.name, relationship: c.relationship, contact_phone: c.phone }))
  if (state.status === 'documents_pending' && state.stored.length >= rules.MIN_CONTACTS) state.status = 'documents_signed'
  return { status: 200, body: listBody(state) }
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the emergency contacts check"}')
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
async function openDriver(browser, size, state) {
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.host !== `${HOST}:${PORT}`) return route.abort()
    if (url.pathname.startsWith('/socket.io/')) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (req.method() === 'PUT' && url.pathname === '/api/driver/me/emergency-contacts') {
      const out = answerPut(state, req.postData())
      return route.fulfill({ status: out.status, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out.body) })
    }
    if (req.method() !== 'GET') {
      otherWrites.push(`${size.tag} ${req.method()} ${url.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    const body = answerGet(state, url.pathname)
    if (body === null) unanswered.add(url.pathname)
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body || {}) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}/driver`, { waitUntil: 'domcontentloaded' })
  return { ctx, page }
}

// The element's box, whether it lies inside the window, and whether the topmost
// element at its centre is it (or inside it). `null` when there is no such element.
async function measure(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return {
      box: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) },
      inViewport: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      onTop: !!hit && (hit === el || el.contains(hit)),
      window: `${window.innerWidth}x${window.innerHeight}`,
    }
  }, selector)
}
const fmt = (m) => (m ? `box ${m.box.left},${m.box.top}-${m.box.right},${m.box.bottom} in ${m.window}; inside ${m.inViewport}; on top ${m.onTop}` : 'not found')
const text = (page, selector) => page.locator(selector).first().textContent({ timeout: 2000 }).then((t) => (t || '').replace(/\s+/g, ' ').trim(), () => '')
const visible = (page, selector) => page.locator(selector).first().isVisible().catch(() => false)

async function waitForForm(page) {
  try {
    await page.waitForSelector('[data-testid="ec-form"]', { state: 'visible', timeout: 5000 })
    await page.waitForSelector('[data-testid="ec-row"]', { state: 'visible', timeout: 5000 })
    await page.waitForTimeout(350)
    return true
  } catch {
    return false
  }
}
async function fillRow(page, i, c) {
  await page.locator(`input[name="ec-name-${i}"]`).fill(c.name)
  // The relationship by its suggestion, as a driver would tap it.
  await page.locator('[data-testid="ec-row"]').nth(i).locator('.ec-chip', { hasText: c.relationship }).first().tap()
  await page.locator(`input[name="ec-phone-${i}"]`).fill(c.phone)
}
async function tapSave(page) {
  const m = await measure(page, '[data-testid="ec-save"]')
  if (m && m.inViewport && m.onTop) await page.touchscreen.tap(m.box.left + m.box.width / 2, m.box.top + m.box.height / 2)
  return m
}

// ---------------------------------------------------------------- the steps
async function run(browser, size) {
  const state = freshState()
  const { ctx, page } = await openDriver(browser, size, state)
  try {
    let shown = false
    try { await page.waitForSelector('[data-testid="ob-contacts"]', { state: 'visible', timeout: 15000 }); shown = true } catch { shown = false }
    const count = shown ? await text(page, '[data-testid="ob-contacts-count"]') : ''
    const button = shown ? await text(page, '[data-testid="ob-contacts-btn"]') : ''
    const pct = await text(page, '.ob-progress-pct')
    const received = await visible(page, '.ob-next-steps')
    record(`E1-${size.tag}`, 'The lock screen lists the emergency contacts item', 'item shown, "0 of 2 added", button Add; progress 83%; no "Documents Received!"',
      shown ? `count "${count}", button "${button}", progress "${pct}", Documents Received shown ${received}` : `no item within 15 s (progress "${pct}")`,
      shown && count === '0 of 2 added' && button === 'Add' && pct === '83%' && !received, await shot(page, `E1-${size.tag}`))
    if (!shown) return

    await page.locator('[data-testid="ob-contacts-btn"]').tap()
    const formOpen = await waitForForm(page)
    const rowsShown = formOpen ? await page.locator('[data-testid="ec-row"]').count() : 0
    if (formOpen) await fillRow(page, 0, FIRST)
    const putsBefore = state.puts.length
    const save = formOpen ? await tapSave(page) : null
    await page.waitForTimeout(400)
    const error = await text(page, '[data-testid="ec-error"]')
    record(`E2-${size.tag}`, 'One contact: the minimum is refused before anything is sent', 'form read the list (1 GET), 2 rows; "Add at least two contacts." above Save; no PUT; Save inside the window and on top',
      formOpen ? `GETs ${state.gets}, rows ${rowsShown}, message "${error}", PUTs ${state.puts.length - putsBefore}, Save ${fmt(save)}` : 'the form did not open',
      formOpen && state.gets === 1 && rowsShown === 2 && error === 'Add at least two contacts.' && state.puts.length === putsBefore && !!save && save.inViewport && save.onTop,
      await shot(page, `E2-${size.tag}`))
    if (!formOpen) return

    await fillRow(page, 1, SECOND)
    const save2 = await tapSave(page)
    let closed = false
    try { await page.waitForSelector('[data-testid="ec-form"]', { state: 'hidden', timeout: 8000 }); closed = true } catch { closed = false }
    await page.waitForTimeout(400)
    const sent = state.puts[state.puts.length - 1]
    const sentOk = !!sent && Array.isArray(sent.contacts) && sent.contacts.length === 2 && sent.contacts[0].name === FIRST.name && sent.contacts[1].phone === SECOND.phone
    const count3 = await text(page, '[data-testid="ob-contacts-count"]')
    const pct3 = await text(page, '.ob-progress-pct')
    const received3 = await visible(page, '.ob-next-steps')
    const tick = await page.locator('[data-testid="ob-contacts"] .ob-doc-icon').first().textContent().catch(() => '')
    record(`E3-${size.tag}`, 'Two contacts: saved, and the signing step moves on', 'one PUT with both; form closed; "2 added" with a tick; progress 100%; "Documents Received!" shown',
      `PUTs ${state.puts.length}, sent both ${sentOk}, form closed ${closed}, count "${count3}", tick ${tick.includes('✅')}, progress "${pct3}", Documents Received shown ${received3}, Save ${fmt(save2)}`,
      state.puts.length === 1 && sentOk && closed && count3 === '2 added' && tick.includes('✅') && pct3 === '100%' && received3, await shot(page, `E3-${size.tag}`))

    const getsBefore = state.gets
    await page.locator('[data-testid="ob-contacts-btn"]').tap()
    const reopened = await waitForForm(page)
    const names = reopened ? await page.locator('input[name^="ec-name-"]').evaluateAll((els) => els.map((e) => e.value)) : []
    const phones = reopened ? await page.locator('input[name^="ec-phone-"]').evaluateAll((els) => els.map((e) => e.value)) : []
    record(`E4-${size.tag}`, 'Edit reads the list again and shows what was saved', 'one more GET; the two contacts, the US number as (202) 555-0143',
      reopened ? `GETs +${state.gets - getsBefore}, names ${JSON.stringify(names)}, phones ${JSON.stringify(phones)}` : 'the form did not open',
      reopened && state.gets - getsBefore === 1 && JSON.stringify(names) === JSON.stringify([FIRST.name, SECOND.name]) && JSON.stringify(phones) === JSON.stringify(['(202) 555-0143', '+442079460958']),
      await shot(page, `E4-${size.tag}`))
    if (!reopened) return

    state.conflictNext = true
    await page.locator('input[name="ec-name-1"]').fill('Jordan Placeholder Jr')
    await tapSave(page)
    await page.waitForTimeout(600)
    const error5 = await text(page, '[data-testid="ec-error"]')
    const stillOpen = await visible(page, '[data-testid="ec-form"]')
    record(`E5-${size.tag}`, 'A refusal only the server gives is shown in words', '409 CONTACT_NOT_FOUND: "This list changed somewhere else. Open it again, then save your changes."; the form stays open',
      `message "${error5}", form open ${stillOpen}`,
      error5 === 'This list changed somewhere else. Open it again, then save your changes.' && stillOpen, await shot(page, `E5-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve) })
  console.log(`driver-emergency-contacts: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const size of SIZES) await run(browser, size)
  } finally {
    await browser.close()
    server.close()
  }

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const md = [
    `# Driver emergency contacts check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Other writes sent by the page (not part of the verdict): ${otherWrites.length ? otherWrites.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, md, { mode: 0o600 })
  console.log(`driver-emergency-contacts: ${rows.filter((r) => r.verdict === 'PASS').length}/${rows.length} PASS; results ${resultsFile}; screenshots ${shotDir()}`)
  if (pageErrors.length) console.log(`driver-emergency-contacts: page errors: ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`driver-emergency-contacts: aborted: ${e.stack || e}`)
  process.exit(1)
})
