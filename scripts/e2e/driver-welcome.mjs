#!/usr/bin/env node
// LogisX — the driver app's "Welcome to the Team!" card on short phones and large
// text, on made-up data only (2026-10-22).
//
// A newly onboarded driver sees the card once, until "Let's Get Started" saves
// logisx_welcome_seen_<user id>. With a 125% root font on a 390x664 window the card
// was taller than the window, centered with its top and bottom cut off, nothing
// scrolled, and the button was out of reach: the driver could not get in.
//
// At 375x667, 390x664 and 390x664 with a 125% root font (a phone, touch), as a
// made-up fully onboarded Driver whose seen flag is cleared:
//   G1  the card shows
//   G2  with everything scrolled to the top, the card's top and its icon are inside
//       the window, and the close (x) is inside it and is what a tap at its centre hits
//   G3  "Let's Get Started", scrolled into view, is inside the window and is what a
//       tap at its centre hits
//   G4  a real tap on it closes the card and saves the seen flag
//   X1  (a fresh page) a real tap on the close (x) closes the card and saves the flag
// Step names carry the size: G2-390x664-125 is G2 at 390x664 with the 125% font.
//
// Like phone-layout.mjs this boots no server.js, opens no database, reads no .env or
// key and signs nobody in. It serves the checkout's built client/dist from its own
// static server on 127.0.0.1 (E2E_PORT, default 3181) and answers every /api request
// in the browser with made-up fixtures (the driver "Casey Example", user id 90101,
// onboarded a minute ago, no loads). Every request to another host is aborted, the
// socket included. Writes the page sends are answered 200 and listed in the results
// (not part of the verdict).
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   node scripts/e2e/driver-welcome.mjs
//
// Before and after the fix: build origin/main's client and run with OUT_TAG=main
// (main has no close button, so G2 and X1 fail at every size, and its card does not
// scroll, so G3 and G4 fail at 390x664-125), then build the branch and run with
// OUT_TAG=branch (every row PASSes).
//
// Env: E2E_PORT (default 3181; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "driver-welcome"), HEADED=1, CHROME_PATH, E2E_WORK_DIR, SHOT_DIR
// (an absolute folder outside the checkout for the screenshots; default
// <work dir>/shots/<OUT_TAG>). Output: the screenshots and
// <work dir>/results-<OUT_TAG>.md. Exit 0 only when every row PASSes.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import paths from './paths.cjs'

const PORT = Number(process.env.E2E_PORT || 3181)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'driver-welcome').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const SIZES = [
  { tag: '375x667', viewport: { width: 375, height: 667 }, rootFont: '' },
  { tag: '390x664', viewport: { width: 390, height: 664 }, rootFont: '' },
  { tag: '390x664-125', viewport: { width: 390, height: 664 }, rootFont: '125%' },
]

function die(msg) {
  console.error(`driver-welcome: ${msg}`)
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
const USER_ID = 90101
const DRIVER = 'Casey Example'
const SEEN_KEY = `logisx_welcome_seen_${USER_ID}`

function answerGet(pathname) {
  if (pathname === '/api/auth/session') {
    return {
      authenticated: true,
      user: { id: USER_ID, username: 'qa-welcome-driver', role: 'Driver', driverName: DRIVER, email: '', fullName: DRIVER, companyName: '', mustChangePassword: false },
      appTimeZone: 'America/New_York',
    }
  }
  if (pathname === `/api/driver/${encodeURIComponent(DRIVER)}`) {
    return {
      loads: [],
      headers: { jobTracking: [], carrierDB: [] },
      onboarding: { user_id: USER_ID, status: 'fully_onboarded', onboarded_at: new Date(Date.now() - 60000).toISOString(), documents: [], totalDocs: 6 },
      driverInfo: null,
      truck: null,
      messages: [],
      notifications: [],
      expenses: [],
      drivers: [],
      invoices: [],
      sharedDocuments: [],
      truckDocuments: [],
    }
  }
  if (pathname === '/api/fuel/range') return { ok: false }
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the driver welcome check"}')
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
async function openDriver(browser, size) {
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.host !== `${HOST}:${PORT}`) return route.abort()
    if (url.pathname.startsWith('/socket.io/')) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (req.method() !== 'GET') {
      writes.push(`${size.tag} ${req.method()} ${url.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    const body = answerGet(url.pathname)
    if (body === null) unanswered.add(url.pathname)
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body || {}) })
  })
  // The seen flag starts cleared, as for a driver who has never closed the card.
  await ctx.addInitScript((key) => { try { localStorage.removeItem(key) } catch { /* no storage */ } }, SEEN_KEY)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}/driver`, { waitUntil: 'domcontentloaded' })
  if (size.rootFont) await page.addStyleTag({ content: `html { font-size: ${size.rootFont} !important; }` })
  return { ctx, page }
}

// Waits for the card and every finite animation on the overlay to finish.
async function cardShown(page) {
  try {
    await page.waitForSelector('.welcome-card', { state: 'visible', timeout: 15000 })
    await page.waitForFunction(() => {
      const el = document.querySelector('.welcome-overlay')
      return !!el && el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || (a.effect && a.effect.getTiming().iterations === Infinity))
    }, null, { timeout: 5000 })
    return true
  } catch {
    return false
  }
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
const fmt = (m) => (m ? `box ${m.box.left},${m.box.top}-${m.box.right},${m.box.bottom} (${m.box.width}x${m.box.height}) in ${m.window}; inside ${m.inViewport}; on top ${m.onTop}` : 'not found')

// Every scrollable box from the card up, scrolled to the top.
async function scrollAllToTop(page) {
  await page.evaluate(() => {
    for (let el = document.querySelector('.welcome-card'); el; el = el.parentElement) el.scrollTop = 0
    window.scrollTo(0, 0)
  })
}

async function closesAndSaves(page) {
  const gone = await page.waitForSelector('.welcome-overlay', { state: 'detached', timeout: 3000 }).then(() => true, () => false)
  const seen = await page.evaluate((key) => { try { return localStorage.getItem(key) } catch { return null } }, SEEN_KEY)
  return { gone, seen, ok: gone && !!seen }
}

async function tapCenter(page, m) {
  await page.touchscreen.tap(m.box.left + m.box.width / 2, m.box.top + m.box.height / 2)
}

// ---------------------------------------------------------------- the steps
async function startButton(browser, size) {
  const { ctx, page } = await openDriver(browser, size)
  try {
    const shown = await cardShown(page)
    const card = shown ? await measure(page, '.welcome-card') : null
    record(`G1-${size.tag}`, 'The welcome card shows', 'the card is visible', shown ? `visible; card ${fmt(card)}` : 'not shown within 15 s', shown, await shot(page, `G1-${size.tag}`))
    if (!shown) return

    await scrollAllToTop(page)
    const icon = await measure(page, '.welcome-icon')
    const cardTop = await measure(page, '.welcome-card')
    const close = await measure(page, '.welcome-card button[aria-label="Close"]')
    const topOk = !!icon && !!cardTop && icon.box.top >= 0 && cardTop.box.top >= 0 && !!close && close.inViewport && close.onTop
    record(`G2-${size.tag}`, 'The card\'s top, its icon and the close (x) are on screen',
      'card top and icon top >= 0; the close (x) inside the window and on top',
      `card ${fmt(cardTop)}; icon ${fmt(icon)}; close ${fmt(close)}`, topOk, await shot(page, `G2-${size.tag}`))

    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.welcome-card button')].find((b) => /Let's Get Started/.test(b.textContent))
      if (btn) { btn.classList.add('qa-welcome-start'); btn.scrollIntoView({ block: 'nearest' }) }
    })
    await page.waitForTimeout(150)
    const start = await measure(page, '.qa-welcome-start')
    const startOk = !!start && start.inViewport && start.onTop
    record(`G3-${size.tag}`, '"Let\'s Get Started" can be reached', 'inside the window and on top after scrolling it into view',
      fmt(start), startOk, await shot(page, `G3-${size.tag}`))

    if (!start) {
      record(`G4-${size.tag}`, 'A tap on "Let\'s Get Started" closes the card and saves the seen flag', 'card gone; flag saved', 'no button', false)
      return
    }
    // A tap at a point off the screen reaches nothing, as on a phone.
    const reachable = start.box.top + start.box.height / 2 >= 0 && start.box.top + start.box.height / 2 < size.viewport.height
    if (reachable) await tapCenter(page, start)
    const res = reachable ? await closesAndSaves(page) : { gone: false, seen: null, ok: false }
    record(`G4-${size.tag}`, 'A tap on "Let\'s Get Started" closes the card and saves the seen flag', `card gone; ${SEEN_KEY} set`,
      reachable ? `card gone ${res.gone}; flag ${res.seen ? 'set' : 'not set'}` : 'the button\'s centre is off the screen: no tap reaches it', res.ok, await shot(page, `G4-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

async function closeButton(browser, size) {
  const { ctx, page } = await openDriver(browser, size)
  try {
    if (!(await cardShown(page))) {
      record(`X1-${size.tag}`, 'A tap on the close (x) closes the card and saves the seen flag', 'card gone; flag saved', 'the card did not show', false)
      return
    }
    await scrollAllToTop(page)
    const close = await measure(page, '.welcome-card button[aria-label="Close"]')
    if (!close || !close.inViewport || !close.onTop) {
      record(`X1-${size.tag}`, 'A tap on the close (x) closes the card and saves the seen flag', 'card gone; flag saved', `close ${fmt(close)}`, false, await shot(page, `X1-${size.tag}`))
      return
    }
    const size44 = close.box.width >= 44 && close.box.height >= 44
    await tapCenter(page, close)
    const res = await closesAndSaves(page)
    record(`X1-${size.tag}`, 'A tap on the close (x) closes the card and saves the seen flag', `a 44x44 or larger target; card gone; ${SEEN_KEY} set`,
      `target ${close.box.width}x${close.box.height}; card gone ${res.gone}; flag ${res.seen ? 'set' : 'not set'}`, size44 && res.ok, await shot(page, `X1-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve) })
  console.log(`driver-welcome: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const size of SIZES) {
      await startButton(browser, size)
      await closeButton(browser, size)
    }
  } finally {
    await browser.close()
    server.close()
  }

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const md = [
    `# Driver welcome card check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Writes sent by the page (not part of the verdict): ${writes.length ? writes.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, md, { mode: 0o600 })
  console.log(`driver-welcome: ${rows.filter((r) => r.verdict === 'PASS').length}/${rows.length} PASS; results ${resultsFile}; screenshots ${shotDir()}`)
  if (pageErrors.length) console.log(`driver-welcome: page errors: ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`driver-welcome: aborted: ${e.stack || e}`)
  process.exit(1)
})
