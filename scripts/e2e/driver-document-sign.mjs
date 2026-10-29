#!/usr/bin/env node
// LogisX — the driver's document-signing screen on a phone whose browser
// toolbars are showing, on made-up data only (2026-10-22).
//
// A driver still onboarding signs each document on a full-screen page. It was
// sized 100vh and centred in a fixed overlay that does not scroll. On a phone,
// 100vh is the height with the toolbars hidden; while they show, the visible area
// is shorter, so the page stuck out at the top and the bottom: the close (x) sat
// above the screen and the Sign button stayed below it.
//
// THE TOOLBAR CASE. A desktop browser has no toolbars to hide, so vh and dvh are
// both the window's height. After the screen opens, this check rewrites every
// style rule whose winning value is a bare vh length (not dvh, svh or lvh) so that
// 1vh counts as (window height + 100 px) / 100: the window is the visible area and
// vh is 100 px taller, as on a phone with its toolbars showing. A rule written as
// `100vh; 100dvh` keeps only its dvh value in the page's style sheets, so it is
// left alone, as a phone that knows dvh would read it.
//
// At 375x667, 390x664 and 390x664 with a 125% root font (a phone, touch), as a
// made-up Driver ("Casey Example", user id 90102) with documents still to sign:
//   D1  opening "Independent Contractor Agreement" (the longest form, with the
//       consent ticked and Direct Deposit picked) shows the signing screen
//   D2  the screen's top and bottom are inside the window
//   D3  with everything scrolled to the top, the close (x) is inside the window and
//       is what a tap at its centre hits
//   D4  with the form scrolled to its end, the Sign button is inside the window
//       and is what a tap at its centre hits (it is disabled: nothing is signed)
//   D5  a real tap on the close (x) closes the screen
//   D6  (a signed document) "Back to Documents", scrolled into view, is inside the
//       window and on top, and a real tap on it closes the screen
// Step names carry the size: D2-390x664-125 is D2 at 390x664 with the 125% font.
//
// Like driver-welcome.mjs this boots no server.js, opens no database, reads no
// .env or key and signs nobody in. It serves the checkout's built client/dist from
// its own static server on 127.0.0.1 (E2E_PORT, default 3181) and answers every
// /api request in the browser with made-up fixtures. Every request to another host
// is aborted, the socket included. Nothing is signed: a write the page sends is
// answered 200 and listed in the results (not part of the verdict).
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   node scripts/e2e/driver-document-sign.mjs
//
// Before and after the fix: build origin/main's client and run with OUT_TAG=main
// (D2, D3 and D5 fail at every size, and D4 at least at 390x664-125), then build
// the branch and run with OUT_TAG=branch (every row PASSes).
//
// Env: E2E_PORT (default 3181; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "driver-document-sign"), TOOLBAR_PX (default 100: how much
// taller vh is than the window), HEADED=1, CHROME_PATH, E2E_WORK_DIR, SHOT_DIR (an
// absolute folder outside the checkout for the screenshots; default
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
const OUT_TAG = String(process.env.OUT_TAG || 'driver-document-sign').replace(/[^\w.-]/g, '')
const TOOLBAR_PX = Number(process.env.TOOLBAR_PX || 100)
const DIST = path.join(paths.REPO, 'client', 'dist')
const SIZES = [
  { tag: '375x667', viewport: { width: 375, height: 667 }, rootFont: '' },
  { tag: '390x664', viewport: { width: 390, height: 664 }, rootFont: '' },
  { tag: '390x664-125', viewport: { width: 390, height: 664 }, rootFont: '125%' },
]

function die(msg) {
  console.error(`driver-document-sign: ${msg}`)
  process.exit(2)
}

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (PORT === 3000 || PORT === 5173) die(`refusing port ${PORT}: 3000 is production's port on the VPS and 5173 is Vite's`)
if (!Number.isFinite(TOOLBAR_PX) || TOOLBAR_PX < 0 || TOOLBAR_PX > 400) die(`TOOLBAR_PX must be 0 to 400; got "${process.env.TOOLBAR_PX}"`)
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
const UNSIGNED = { doc_key: 'contractor_agreement', doc_name: 'Independent Contractor Agreement', signed: false }
const SIGNED = {
  doc_key: 'master_agreement', doc_name: 'Master Agreement', signed: true,
  signature_text: DRIVER, signed_at: '2026-10-20T15:00:00.000Z', signed_pdf_url: '/api/qa-made-up/signed.pdf',
}

function answerGet(pathname) {
  if (pathname === '/api/auth/session') {
    return {
      authenticated: true,
      user: { id: USER_ID, username: 'qa-docsign-driver', role: 'Driver', driverName: DRIVER, email: '', fullName: DRIVER, companyName: '', mustChangePassword: false },
      appTimeZone: 'America/New_York',
    }
  }
  if (pathname === `/api/driver/${encodeURIComponent(DRIVER)}`) {
    return {
      loads: [],
      headers: { jobTracking: [], carrierDB: [] },
      onboarding: { user_id: USER_ID, status: 'documents_pending', onboarded_at: null, documents: [SIGNED, UNSIGNED], totalDocs: 6 },
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

// The document itself: a made-up page, never a real agreement.
const isDocument = (pathname) => pathname.startsWith('/api/onboarding/documents/') || pathname === SIGNED.signed_pdf_url
const DOCUMENT_HTML = '<!doctype html><title>Made-up document</title><body style="font:16px sans-serif;padding:1rem">Made-up document for the signing-screen check.</body>'

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the document-signing check"}')
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
    if (isDocument(url.pathname)) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: DOCUMENT_HTML })
    const body = answerGet(url.pathname)
    if (body === null) unanswered.add(url.pathname)
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body || {}) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}/driver`, { waitUntil: 'domcontentloaded' })
  if (size.rootFont) await page.addStyleTag({ content: `html { font-size: ${size.rootFont} !important; }` })
  return { ctx, page }
}

// Every bare vh length in the page's style sheets made TOOLBAR_PX taller in
// total (see THE TOOLBAR CASE above). Returns how many values it rewrote.
async function showToolbars(page) {
  return page.evaluate((extra) => {
    const unit = (window.innerHeight + extra) / 100
    const bare = /(^|[^a-z\d.])(\d*\.?\d+)vh\b/g
    let n = 0
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.cssRules) walk(rule.cssRules)
        if (!rule.style) continue
        for (let i = 0; i < rule.style.length; i++) {
          const prop = rule.style[i]
          const value = rule.style.getPropertyValue(prop)
          if (!bare.test(value)) continue
          bare.lastIndex = 0
          const next = value.replace(bare, (m, lead, num) => `${lead}calc(${num} * ${unit}px)`)
          rule.style.setProperty(prop, next, rule.style.getPropertyPriority(prop))
          n++
        }
      }
    }
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules) } catch { /* another origin's sheet: none here */ }
    }
    return n
  }, TOOLBAR_PX)
}

async function settle(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('.modal-overlay')
    return !!el && el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || (a.effect && a.effect.getTiming().iterations === Infinity))
  }, null, { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(150)
}

// Opens a document from the onboarding list; true once the signing screen shows.
async function openDocument(page, docName) {
  try {
    await page.waitForSelector('.ob-doc-item', { state: 'visible', timeout: 15000 })
    await page.locator('.ob-doc-item', { hasText: docName }).first().click()
    await page.waitForSelector('.modal-fullscreen', { state: 'visible', timeout: 5000 })
    await settle(page)
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

// Scrolls every box from `selector` up to the page to the top (to = 'top') or to
// its end (to = 'end'), then brings `selector` into view the way a finger would.
async function scrollTo(page, selector, to) {
  await page.evaluate(([sel, end]) => {
    const el = document.querySelector(sel)
    for (let p = el; p; p = p.parentElement) p.scrollTop = end ? p.scrollHeight : 0
    window.scrollTo(0, end ? document.documentElement.scrollHeight : 0)
    if (el && end) el.scrollIntoView({ block: 'nearest' })
  }, [selector, to === 'end'])
  await page.waitForTimeout(150)
}

async function tapCenter(page, m) {
  await page.touchscreen.tap(m.box.left + m.box.width / 2, m.box.top + m.box.height / 2)
}
// A tap at a point off the screen reaches nothing, as on a phone.
const tappable = (m, size) => !!m && m.box.top + m.box.height / 2 >= 0 && m.box.top + m.box.height / 2 < size.viewport.height &&
  m.box.left + m.box.width / 2 >= 0 && m.box.left + m.box.width / 2 < size.viewport.width
const closed = (page) => page.waitForSelector('.modal-overlay', { state: 'detached', timeout: 3000 }).then(() => true, () => false)

// ---------------------------------------------------------------- the steps
async function unsignedDocument(browser, size) {
  const { ctx, page } = await openDriver(browser, size)
  try {
    const shown = await openDocument(page, UNSIGNED.doc_name)
    if (shown) {
      // The longest form: consent ticked, Direct Deposit picked.
      await page.locator('.sign-checkbox input[type="checkbox"]').check().catch(() => {})
      await page.locator('.payment-radio input[value="ach"]').check().catch(() => {})
      await page.waitForTimeout(150)
    }
    const rewritten = shown ? await showToolbars(page) : 0
    if (shown) await page.waitForTimeout(150)
    record(`D1-${size.tag}`, 'The signing screen shows (toolbars simulated)', `the screen is visible; vh ${TOOLBAR_PX} px taller than the window`,
      shown ? `visible; ${rewritten} bare vh value(s) rewritten` : 'not shown within 20 s', shown, await shot(page, `D1-${size.tag}`))
    if (!shown) return

    await scrollTo(page, '.modal-close', 'top')
    const screen = await measure(page, '.modal-fullscreen')
    const fits = !!screen && screen.box.top >= 0 && screen.box.bottom <= size.viewport.height
    record(`D2-${size.tag}`, 'The screen\'s top and bottom are inside the window', `top >= 0 and bottom <= ${size.viewport.height}`, fmt(screen), fits, await shot(page, `D2-${size.tag}`))

    const close = await measure(page, '.modal-close')
    record(`D3-${size.tag}`, 'The close (x) is on screen', 'inside the window and on top', fmt(close), !!close && close.inViewport && close.onTop, await shot(page, `D3-${size.tag}`))

    await scrollTo(page, '.sign-btn', 'end')
    const sign = await measure(page, '.sign-btn')
    record(`D4-${size.tag}`, 'The Sign button can be reached', 'inside the window and on top after scrolling the form to its end',
      fmt(sign), !!sign && sign.inViewport && sign.onTop, await shot(page, `D4-${size.tag}`))

    await scrollTo(page, '.modal-close', 'top')
    const closeAgain = await measure(page, '.modal-close')
    const reach = tappable(closeAgain, size)
    if (reach) await tapCenter(page, closeAgain)
    const gone = reach ? await closed(page) : false
    record(`D5-${size.tag}`, 'A tap on the close (x) closes the screen', 'the screen is gone',
      reach ? `screen gone ${gone}` : `the close's centre is off the screen: no tap reaches it (${fmt(closeAgain)})`, gone, await shot(page, `D5-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

async function signedDocument(browser, size) {
  const { ctx, page } = await openDriver(browser, size)
  try {
    const shown = await openDocument(page, SIGNED.doc_name)
    if (shown) { await showToolbars(page); await page.waitForTimeout(150) }
    if (!shown) {
      record(`D6-${size.tag}`, 'A signed document\'s "Back to Documents" can be reached and closes the screen', 'inside the window, on top; the screen closes', 'the screen did not show', false)
      return
    }
    await scrollTo(page, '.sign-done-back', 'end')
    const back = await measure(page, '.sign-done-back')
    const reach = !!back && back.inViewport && back.onTop
    if (reach) await tapCenter(page, back)
    const gone = reach ? await closed(page) : false
    record(`D6-${size.tag}`, 'A signed document\'s "Back to Documents" can be reached and closes the screen', 'inside the window, on top; the screen closes',
      `${fmt(back)}; screen gone ${gone}`, reach && gone, await shot(page, `D6-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve) })
  console.log(`driver-document-sign: serving ${DIST} on ${BASE} (made-up data; no server.js); vh ${TOOLBAR_PX} px taller than the window`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const size of SIZES) {
      await unsignedDocument(browser, size)
      await signedDocument(browser, size)
    }
  } finally {
    await browser.close()
    server.close()
  }

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const md = [
    `# Driver document-signing screen check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. Toolbars simulated: vh ${TOOLBAR_PX} px taller than the window. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Writes sent by the page (not part of the verdict): ${writes.length ? writes.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, md, { mode: 0o600 })
  console.log(`driver-document-sign: ${rows.filter((r) => r.verdict === 'PASS').length}/${rows.length} PASS; results ${resultsFile}; screenshots ${shotDir()}`)
  if (pageErrors.length) console.log(`driver-document-sign: page errors: ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`driver-document-sign: aborted: ${e.stack || e}`)
  process.exit(1)
})
