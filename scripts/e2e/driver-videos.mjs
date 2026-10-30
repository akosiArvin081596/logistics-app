#!/usr/bin/env node
// LogisX — the driver app's "Training videos" card (DRIVER_TRAINING_VIDEOS_ENABLED),
// on made-up data only.
//
// The server names where the card shows (the payload's `trainingVideos`, from the
// onboarding status alone): "onboarding" on the lock screen once the signing step
// is accepted, "kit" on the Kit tab once onboarded, and no key with the flag off.
// The card's RouteMate ELD video is a tap-to-load YouTube no-cookie frame with a
// YouTube link that always shows.
//
// At 375x667, 390x664 and 390x664 with a 125% root font (a phone, touch), as a
// made-up Driver ("Casey Example", user id 90104):
//   V0  no key (the flag off): no card on the lock screen (documents_signed) or on
//       the Kit tab (fully_onboarded)
//   V1  documents_pending (still signing; the key is null): no card
//   V2  documents_signed with "onboarding": the card sits after "Documents
//       Received!" and before "Start Driving"
//   V3  before the tap: no iframe, nothing requested from a YouTube host; the
//       facade is a button named "Play the ELD video (loads YouTube)", at least
//       44 x 44 px
//   V4  a tap on it: exactly one iframe, its src, title, allow, allowfullscreen,
//       referrerpolicy and sandbox exact, focus moved into it, and the only
//       requests the tap adds go to www.youtube-nocookie.com (aborted here)
//   V5  the YouTube link: href, target and rel exact, at least 44 px tall, shown
//       before and after the tap
//   V6  the frame is 16:9 (within 1 px), inside the window, with no sideways
//       scroll, before and after the tap
//   V7  the walkthrough video (active once its files exist; SKIP until then):
//       controls, preload none, no autoplay, a poster, an English captions track on
//       by default, an MP4 source, and no media request before play
//   V8  fully_onboarded with "kit": no lock screen; the card is on the Kit tab
//   V9  (125% font only) nothing in the card overlaps, and its button and link
//       stay inside the window
// Step names carry the size: V4-390x664-125 is V4 at 390x664 with the 125% font.
//
// Like driver-welcome.mjs this boots no server.js, opens no database, reads no
// settings file or key and signs nobody in. It serves the checkout's built
// client/dist from its own static server on 127.0.0.1 (E2E_PORT, default 3188)
// and answers every /api request in the browser with made-up fixtures. Every
// request to another host is aborted (the YouTube frame included) and Chromium
// resolves no host name, so nothing leaves the machine.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   node scripts/e2e/driver-videos.mjs
//
// Before and after: build origin/main's client and run with OUT_TAG=main (V2-V6,
// V8 and V9 fail at every size: there is no card), then build the branch and run
// with OUT_TAG=branch (every row PASSes; V7 SKIPs until the walkthrough's files).
//
// Env: E2E_PORT (default 3188; 3000 and 5173 are refused, and so is a port in use),
// OUT_TAG (default "driver-videos"), HEADED=1, CHROME_PATH, E2E_WORK_DIR, SHOT_DIR
// (an absolute folder outside the checkout for the screenshots; default
// <work dir>/shots/<OUT_TAG>). Output: the screenshots and
// <work dir>/results-<OUT_TAG>.md. Exit 0 only when no row FAILs.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import paths from './paths.cjs'

const PORT = Number(process.env.E2E_PORT || 3188)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'driver-videos').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const SIZES = [
  { tag: '375x667', viewport: { width: 375, height: 667 }, rootFont: '' },
  { tag: '390x664', viewport: { width: 390, height: 664 }, rootFont: '' },
  { tag: '390x664-125', viewport: { width: 390, height: 664 }, rootFont: '125%' },
]
// What the card must hold, written out here rather than read from the client lib,
// so a change there shows up as a FAIL.
const EMBED_SRC = 'https://www.youtube-nocookie.com/embed/GV9ztmoomgw?rel=0&playsinline=1&cc_load_policy=1&cc_lang_pref=en&hl=en'
const FRAME = {
  title: 'RouteMate ELD: how to log in to your mobile app',
  allow: 'accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen',
  referrerpolicy: 'strict-origin-when-cross-origin',
  sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation',
}
const WATCH = { href: 'https://www.youtube.com/watch?v=GV9ztmoomgw', target: '_blank', rel: 'noopener noreferrer' }
const PLAY_NAME = 'Play the ELD video (loads YouTube)'
const YOUTUBE_HOST_RE = /(^|\.)(youtube(-nocookie)?\.com|ytimg\.com|googlevideo\.com|ggpht\.com|youtu\.be)$/i

function die(msg) {
  console.error(`driver-videos: ${msg}`)
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
const USER_ID = 90104
const DRIVER = 'Casey Example'
const DAY = 24 * 3600 * 1000
const DOC_NAMES = [
  ['contractor_agreement', 'Contractor Agreement'], ['equipment_policy', 'Contracted Provider Equipment Policy'], ['w9', 'W-9 Tax Form'],
  ['mobile_policy', 'LogisX Inc. Mobile Policy'], ['substance_policy', 'Substance Policy and Procedure'],
]
const docs = (signed) => DOC_NAMES.map(([docKey, name], i) => ({
  doc_key: docKey, doc_name: name, signed: i < signed, signature_text: i < signed ? DRIVER : '', signed_at: i < signed ? '2026-10-20T15:00:00.000Z' : null, signed_pdf_url: '',
}))

// The payload as the server sends it. `placement` undefined: no key (the flag off).
function payload({ status, placement }) {
  const onboarded = status === 'fully_onboarded'
  const body = {
    loads: [],
    headers: { jobTracking: [], carrierDB: [] },
    onboarding: {
      user_id: USER_ID, status, documents: docs(status === 'documents_pending' ? 3 : 5), totalDocs: DOC_NAMES.length,
      // Onboarded long ago, so the one-time welcome card stays shut.
      onboarded_at: onboarded ? new Date(Date.now() - 60 * DAY).toISOString() : null,
    },
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
  if (placement !== undefined) body.trainingVideos = placement
  return body
}

function answerGet(world, pathname) {
  if (pathname === '/api/auth/session') {
    return {
      authenticated: true,
      user: { id: USER_ID, username: 'qa-videos-driver', role: 'Driver', driverName: DRIVER, email: '', fullName: DRIVER, companyName: '', mustChangePassword: false },
      appTimeZone: 'America/New_York',
    }
  }
  if (pathname === `/api/driver/${encodeURIComponent(DRIVER)}`) return payload(world)
  if (pathname === '/api/fuel/range') return { ok: false }
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.vtt': 'text/vtt; charset=utf-8' }

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the driver videos check"}')
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
function record(step, title, expected, observed, verdict, shot = '') {
  const v = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : verdict
  if (v === 'FAIL') exitCode = 1
  rows.push({ step, title, expected, observed, verdict: v, shot })
  console.log(`${v.padEnd(4)}  ${step}  ${title}: ${observed}`)
}

const shotDir = () => {
  const dir = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : path.join(paths.workDir(), 'shots', OUT_TAG)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
async function shot(page, name) {
  const file = path.join(shotDir(), `${OUT_TAG}-${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  return file
}

// ---------------------------------------------------------------- page helpers
// One driver page in its own context. `requests` lists every request the page
// made (frames included), each with its host and the moment it was seen.
async function openDriver(browser, size, world) {
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  const requests = []
  ctx.on('request', (req) => {
    let host = ''
    try { host = new URL(req.url()).host } catch { host = '?' }
    requests.push({ host, url: req.url(), type: req.resourceType() })
  })
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
    const body = answerGet(world, url.pathname)
    if (body === null) unanswered.add(url.pathname)
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body || {}) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  await page.goto(`${BASE}/driver`, { waitUntil: 'domcontentloaded' })
  if (size.rootFont) await page.addStyleTag({ content: `html { font-size: ${size.rootFont} !important; }` })
  return { ctx, page, requests }
}

const CARD = '[data-testid="training-videos"]'
async function shown(page, selector, timeout = 15000) {
  return page.waitForSelector(selector, { state: 'visible', timeout }).then(() => true, () => false)
}
// The lock screen or the normal app, whichever the payload leads to.
async function settled(page) {
  return page.waitForSelector('.onboarding-locked .ob-step, .van-tabbar', { state: 'visible', timeout: 15000 }).then(() => true, () => false)
}
async function openKit(page) {
  const tab = page.locator('.van-tabbar-item', { hasText: 'Kit' })
  await tab.tap()
  return shown(page, '.section-header:has-text("Driver Kit")', 5000)
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
      box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      inViewport: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      inWidth: r.width > 0 && r.left >= 0 && r.right <= window.innerWidth,
      onTop: !!hit && (hit === el || el.contains(hit)),
      window: `${window.innerWidth}x${window.innerHeight}`,
    }
  }, selector)
}
const px = (n) => Math.round(n * 10) / 10
const fmt = (m) => (m ? `box ${px(m.box.left)},${px(m.box.top)}-${px(m.box.right)},${px(m.box.bottom)} (${px(m.box.width)}x${px(m.box.height)}) in ${m.window}; inside ${m.inViewport}; on top ${m.onTop}` : 'not found')
async function scrollTo(page, selector) {
  await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), selector)
  await page.waitForTimeout(150)
}
const noSideScroll = (page) => page.evaluate(() => {
  const el = document.scrollingElement || document.documentElement
  return { ok: el.scrollWidth <= el.clientWidth, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
})

// ---------------------------------------------------------------- the steps
async function noCardAnywhere(browser, size) {
  const lock = await openDriver(browser, size, { status: 'documents_signed' })
  const kit = await openDriver(browser, size, { status: 'fully_onboarded' })
  try {
    const lockUp = (await settled(lock.page)) && (await shown(lock.page, '.ob-next-title'))
    await lock.page.waitForTimeout(300)
    const lockCards = await lock.page.locator(CARD).count()
    const lockText = await lock.page.locator('text=Training videos').count()
    const kitUp = (await settled(kit.page)) && (await openKit(kit.page))
    await kit.page.waitForTimeout(300)
    const kitCards = await kit.page.locator(CARD).count()
    const kitText = await kit.page.locator('text=Training videos').count()
    const shotFile = await shot(lock.page, `V0-${size.tag}-lock`)
    await shot(kit.page, `V0-${size.tag}-kit`)
    record(`V0-${size.tag}`, 'No key (the flag off): no card on the lock screen or the Kit tab', 'lock screen and Kit up; no card, no "Training videos" text',
      `lock screen ${lockUp ? 'up' : 'NOT up'}: ${lockCards} card(s), ${lockText} text; Kit ${kitUp ? 'up' : 'NOT up'}: ${kitCards} card(s), ${kitText} text`,
      lockUp && kitUp && lockCards + lockText + kitCards + kitText === 0, shotFile)
  } finally {
    await lock.ctx.close()
    await kit.ctx.close()
  }
}

async function stillSigning(browser, size) {
  const { ctx, page } = await openDriver(browser, size, { status: 'documents_pending', placement: null })
  try {
    const up = (await settled(page)) && (await shown(page, '.ob-doc-list'))
    await page.waitForTimeout(300)
    const cards = await page.locator(CARD).count()
    record(`V1-${size.tag}`, 'documents_pending (the key null): no card', 'the signing list up; no card',
      `signing list ${up ? 'up' : 'NOT up'}; ${cards} card(s)`, up && cards === 0, await shot(page, `V1-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

async function lockScreenCard(browser, size) {
  const { ctx, page, requests } = await openDriver(browser, size, { status: 'documents_signed', placement: 'onboarding' })
  try {
    const up = (await settled(page)) && (await shown(page, CARD))
    if (!up) {
      record(`V2-${size.tag}`, 'documents_signed with "onboarding": the card between "Documents Received!" and "Start Driving"', 'the card shows', 'no card within 15 s', false, await shot(page, `V2-${size.tag}`))
      for (const s of ['V3', 'V4', 'V5', 'V6', 'V7']) record(`${s}-${size.tag}`, 'needs the card', 'the card shows', 'no card (V2)', false)
      if (size.rootFont) record(`V9-${size.tag}`, 'needs the card', 'the card shows', 'no card (V2)', false)
      return
    }
    // V2: in the lock screen, after the next-steps card and before step 2, in the
    // document's order and on the page.
    const order = await page.evaluate((sel) => {
      const card = document.querySelector(sel)
      const received = [...document.querySelectorAll('.ob-next-title')].find((e) => /Documents Received!/.test(e.textContent))
      const start = [...document.querySelectorAll('.ob-step-title')].find((e) => /Start Driving/.test(e.textContent))
      const lock = document.querySelector('.onboarding-locked')
      if (!card || !received || !start || !lock) return { ok: false, why: `card ${!!card}, received ${!!received}, start ${!!start}, lock ${!!lock}` }
      const receivedCard = received.closest('.card')
      const startCard = start.closest('.card')
      const after = !!(receivedCard.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)
      const before = !!(card.compareDocumentPosition(startCard) & Node.DOCUMENT_POSITION_FOLLOWING)
      const y = (e) => e.getBoundingClientRect()
      const placed = y(receivedCard).bottom <= y(card).top + 0.5 && y(card).bottom <= y(startCard).top + 0.5
      return { ok: lock.contains(card) && after && before && placed, why: `inside lock ${lock.contains(card)}; after "Documents Received!" ${after}; before "Start Driving" ${before}; stacked on the page ${placed}; variant ${card.dataset.variant}` }
    }, CARD)
    record(`V2-${size.tag}`, 'documents_signed with "onboarding": the card between "Documents Received!" and "Start Driving"',
      'inside the lock screen, after the next-steps card and before step 2', order.why, order.ok, await shot(page, `V2-${size.tag}`))

    // V3: before any tap.
    const facadeSel = `${CARD} [data-testid="tv-eld-play"]`
    await scrollTo(page, facadeSel)
    const frames0 = await page.locator(`${CARD} iframe`).count()
    const yt0 = requests.filter((r) => YOUTUBE_HOST_RE.test(r.host.split(':')[0]))
    const facade = await measure(page, facadeSel)
    const named = await page.getByRole('button', { name: PLAY_NAME, exact: true }).count()
    const big = !!facade && facade.box.width >= 44 && facade.box.height >= 44
    record(`V3-${size.tag}`, 'Before the tap: no frame, nothing from YouTube, a named facade button',
      `no iframe; no YouTube-host request; one button named "${PLAY_NAME}", at least 44x44, inside the window and on top`,
      `${frames0} iframe(s); ${yt0.length} YouTube request(s); ${named} named button(s); facade ${fmt(facade)}`,
      frames0 === 0 && yt0.length === 0 && named === 1 && big && !!facade && facade.inWidth && facade.onTop, await shot(page, `V3-${size.tag}`))

    // V5 and V6 before the tap.
    const linkSel = `${CARD} [data-testid="tv-eld-link"]`
    const linkAttrs = () => page.evaluate((sel) => {
      const a = document.querySelector(sel)
      return a ? { href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') } : null
    }, linkSel)
    const link0 = await linkAttrs()
    const linkBox0 = await measure(page, linkSel)
    const frameBox = () => page.evaluate((sel) => {
      const f = document.querySelector(`${sel} .tv-frame`)
      if (!f) return null
      const r = f.getBoundingClientRect()
      return { width: r.width, height: r.height, left: r.left, right: r.right, innerWidth: window.innerWidth }
    }, CARD)
    const ratioOk = (b) => !!b && Math.abs(b.height - (b.width * 9) / 16) <= 1 && b.left >= 0 && b.right <= b.innerWidth
    const frameBefore = await frameBox()
    const scrollBefore = await noSideScroll(page)
    let v9 = null
    if (size.rootFont) v9 = await overlaps(page)

    // The tap.
    const marker = requests.length
    if (facade && facade.onTop) await page.touchscreen.tap(facade.box.left + facade.box.width / 2, facade.box.top + facade.box.height / 2)
    await page.waitForSelector(`${CARD} iframe`, { state: 'attached', timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(1200)

    // V4: the frame.
    const frame = await page.evaluate((sel) => {
      const list = [...document.querySelectorAll(`${sel} iframe`)]
      const f = list[0]
      if (!f) return { count: 0 }
      return {
        count: list.length, src: f.getAttribute('src'), title: f.getAttribute('title'), allow: f.getAttribute('allow'),
        allowfullscreen: f.hasAttribute('allowfullscreen'), referrerpolicy: f.getAttribute('referrerpolicy'), sandbox: f.getAttribute('sandbox'),
        autoplay: /autoplay/i.test(f.getAttribute('src') || '') || /autoplay/i.test(f.getAttribute('allow') || ''),
        focused: document.activeElement === f, facadeGone: !document.querySelector(`${sel} [data-testid="tv-eld-play"]`),
      }
    }, CARD)
    const added = requests.slice(marker).filter((r) => r.host !== `${HOST}:${PORT}`)
    const addedHosts = [...new Set(added.map((r) => r.host))]
    const attrsOk = frame.count === 1 && frame.src === EMBED_SRC && frame.title === FRAME.title && frame.allow === FRAME.allow && frame.allowfullscreen &&
      frame.referrerpolicy === FRAME.referrerpolicy && frame.sandbox === FRAME.sandbox && !frame.autoplay
    const hostsOk = addedHosts.length === 1 && addedHosts[0] === 'www.youtube-nocookie.com'
    record(`V4-${size.tag}`, 'A tap on the facade: one frame, its attributes exact, focus in it, only the no-cookie host contacted',
      `1 iframe; src ${EMBED_SRC}; title, allow, allowfullscreen, referrerpolicy, sandbox as the plan; focus on it; requests added: www.youtube-nocookie.com only`,
      frame.count ? `${frame.count} iframe(s); src ${frame.src === EMBED_SRC ? 'exact' : JSON.stringify(frame.src)}; title ${frame.title === FRAME.title ? 'exact' : JSON.stringify(frame.title)}; ` +
        `allow ${frame.allow === FRAME.allow ? 'exact' : JSON.stringify(frame.allow)}; allowfullscreen ${frame.allowfullscreen}; referrerpolicy ${JSON.stringify(frame.referrerpolicy)}; ` +
        `sandbox ${frame.sandbox === FRAME.sandbox ? 'exact' : JSON.stringify(frame.sandbox)}; facade gone ${frame.facadeGone}; focused ${frame.focused}; requests added: ${addedHosts.join(', ') || 'none'}`
        : `no iframe after the tap; requests added: ${addedHosts.join(', ') || 'none'}`,
      attrsOk && frame.focused && frame.facadeGone && hostsOk, await shot(page, `V4-${size.tag}`))

    const link1 = await linkAttrs()
    const linkBox1 = await measure(page, linkSel)
    const linkOk = (l, b) => !!l && l.href === WATCH.href && l.target === WATCH.target && l.rel === WATCH.rel && !!b && b.box.height >= 44 && b.inWidth
    record(`V5-${size.tag}`, 'The YouTube link, before and after the tap', `href ${WATCH.href}; target ${WATCH.target}; rel "${WATCH.rel}"; at least 44 px tall; inside the window's width`,
      `before: ${JSON.stringify(link0)}, ${fmt(linkBox0)}; after: ${link1 ? 'same attributes ' + (JSON.stringify(link1) === JSON.stringify(link0)) : 'gone'}, height ${linkBox1 ? px(linkBox1.box.height) : '-'}`,
      linkOk(link0, linkBox0) && linkOk(link1, linkBox1))

    const frameAfter = await frameBox()
    const scrollAfter = await noSideScroll(page)
    const iframeBox = await page.evaluate((sel) => {
      const f = document.querySelector(`${sel} iframe`)
      if (!f) return null
      const r = f.getBoundingClientRect()
      return { width: r.width, height: r.height, left: r.left, right: r.right, innerWidth: window.innerWidth }
    }, CARD)
    const dims = (b) => (b ? `${px(b.width)}x${px(b.height)} at ${px(b.left)}-${px(b.right)} of ${b.innerWidth}` : 'none')
    record(`V6-${size.tag}`, 'The frame is 16:9, inside the window, with no sideways scroll', '16:9 within 1 px and inside the window before and after the tap (the iframe fills it); scrollWidth <= clientWidth',
      `before: frame ${dims(frameBefore)}, scroll ${scrollBefore.scrollWidth}/${scrollBefore.clientWidth}; after: frame ${dims(frameAfter)}, iframe ${dims(iframeBox)}, scroll ${scrollAfter.scrollWidth}/${scrollAfter.clientWidth}`,
      ratioOk(frameBefore) && ratioOk(frameAfter) && ratioOk(iframeBox) && scrollBefore.ok && scrollAfter.ok)

    await walkthroughVideo(page, size, requests)
    if (v9) {
      record(`V9-${size.tag}`, 'At 125%: nothing in the card overlaps; the button and link stay inside the window',
        'no two of heading, intro, title, frame, note and link overlap; the facade and link inside the window\'s width and at least 44 px', v9.why, v9.ok, await shot(page, `V9-${size.tag}`))
    }
  } finally {
    await ctx.close()
  }
}

// V9: the card's parts, each pair checked for overlap, measured before the tap.
async function overlaps(page) {
  return page.evaluate((sel) => {
    const card = document.querySelector(sel)
    const parts = [['heading', '.tv-heading'], ['intro', '.tv-intro'], ['title', '[data-testid="tv-eld"] .tv-caption'], ['frame', '[data-testid="tv-eld"] .tv-frame'],
      ['note', '[data-testid="tv-eld"] .tv-note'], ['link', '[data-testid="tv-eld-link"]']]
      .map(([name, s]) => [name, card.querySelector(s)]).filter(([, el]) => el).map(([name, el]) => [name, el.getBoundingClientRect()])
    const hits = []
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const [a, ra] = parts[i]
        const [b, rb] = parts[j]
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
        if (w > 0.5 && h > 0.5) hits.push(`${a}/${b}`)
      }
    }
    const inside = (s) => { const r = card.querySelector(s)?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= window.innerWidth && r.height >= 44 }
    const facade = inside('[data-testid="tv-eld-play"]')
    const link = inside('[data-testid="tv-eld-link"]')
    const html = document.documentElement
    return { ok: parts.length === 6 && !hits.length && facade && link && html.scrollWidth <= html.clientWidth,
      why: `${parts.length}/6 parts found; overlaps: ${hits.join(', ') || 'none'}; facade inside and 44+ ${facade}; link inside and 44+ ${link}; scroll ${html.scrollWidth}/${html.clientWidth}` }
  }, CARD)
}

// V7: active once the build carries the walkthrough's files.
async function walkthroughVideo(page, size, requests) {
  const v = await page.evaluate((sel) => {
    const video = document.querySelector(`${sel} [data-testid="tv-walkthrough"] video`)
    if (!video) return null
    const track = video.querySelector('track')
    const source = video.querySelector('source')
    return {
      controls: video.hasAttribute('controls'), preload: video.getAttribute('preload'), autoplay: video.hasAttribute('autoplay') || video.autoplay,
      poster: !!video.getAttribute('poster'), track: track ? { kind: track.kind, srclang: track.srclang, label: track.label, def: track.default } : null,
      source: source ? { type: source.getAttribute('type'), mp4: /\.mp4($|\?)/.test(source.getAttribute('src') || '') } : null,
    }
  }, CARD)
  if (!v) {
    record(`V7-${size.tag}`, 'The walkthrough video', 'controls; preload none; no autoplay; a poster; captions (en, default); an MP4 source; no media request before play',
      'no walkthrough video in this build (its files come with PR 2)', 'SKIP')
    return
  }
  const media = requests.filter((r) => r.type === 'media' || /\.(mp4|vtt)(\?|$)/.test(r.url))
  const ok = v.controls && v.preload === 'none' && !v.autoplay && v.poster && !!v.track && v.track.kind === 'captions' && v.track.srclang === 'en' && v.track.def &&
    !!v.source && v.source.type === 'video/mp4' && v.source.mp4 && media.length === 0
  record(`V7-${size.tag}`, 'The walkthrough video', 'controls; preload none; no autoplay; a poster; captions (en, default); an MP4 source; no media request before play',
    `${JSON.stringify(v)}; media requests before play: ${media.length}`, ok)
}

async function kitCard(browser, size) {
  const { ctx, page } = await openDriver(browser, size, { status: 'fully_onboarded', placement: 'kit' })
  try {
    const app = (await settled(page)) && (await shown(page, '.van-tabbar'))
    const lock = await page.locator('.onboarding-locked').count()
    const kit = app && (await openKit(page))
    const card = kit && (await shown(page, CARD, 5000))
    const info = card ? await page.evaluate((sel) => {
      const c = document.querySelector(sel)
      return { variant: c.dataset.variant, intro: c.querySelector('.tv-intro')?.textContent.trim(), inKit: !!c.closest('.tab-panel') }
    }, CARD) : null
    if (card) await scrollTo(page, CARD)
    record(`V8-${size.tag}`, 'fully_onboarded with "kit": no lock screen; the card on the Kit tab', 'the normal app; no lock screen; the Kit tab holds the card ("Rewatch any time.")',
      `app ${app ? 'up' : 'NOT up'}; lock screen ${lock}; Kit ${kit ? 'up' : 'NOT up'}; card ${card ? JSON.stringify(info) : 'not shown'}`,
      app && lock === 0 && kit && card && info.variant === 'kit' && info.inKit && info.intro === 'Rewatch any time.', await shot(page, `V8-${size.tag}`))
  } finally {
    await ctx.close()
  }
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve) })
  console.log(`driver-videos: serving ${DIST} on ${BASE} (made-up data; no server.js)`)
  // No host name resolves: a request that ever got past the abort below reaches nothing.
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED, args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost'] })
  try {
    for (const size of SIZES) {
      await noCardAnywhere(browser, size)
      await stillSigning(browser, size)
      await lockScreenCard(browser, size)
      await kitCard(browser, size)
    }
  } finally {
    await browser.close()
    server.close()
  }

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const md = [
    `# Driver training videos check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Writes sent by the page (not part of the verdict): ${writes.length ? writes.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, md, { mode: 0o600 })
  const count = (v) => rows.filter((r) => r.verdict === v).length
  console.log(`driver-videos: ${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('SKIP')} SKIP of ${rows.length}; results ${resultsFile}; screenshots ${shotDir()}`)
  if (pageErrors.length) console.log(`driver-videos: page errors: ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`driver-videos: aborted: ${e.stack || e}`)
  process.exit(1)
})
