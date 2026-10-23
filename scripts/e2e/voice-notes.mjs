#!/usr/bin/env node
// LogisX — voice notes in Messages, the client (plan 2026-10-22, PR 2), in a real
// browser on made-up data only.
//
//   V1  dashboard (Super Admin, 1280x800): the conversation list's last-message
//       line reads "Voice note (0:42)"; a driver's note plays from
//       /api/messages/<id>/voice, answered 206 (a Range request on the wire)
//   V2  dashboard: mic -> "Recording" -> Stop -> review -> Send. One POST to
//       /api/messages/voice with nothing in the URL, the recording as an
//       audio/mp4 body, the recipient, load and sender in percent-encoded
//       headers and an Idempotency-Key; the sent note shows as a player
//   V3  driver app (390x844, touch), truck moving (a fresh ELD fix at 55 mph):
//       the mic is natively disabled, the note says why; Dispatch's note plays (206)
//   V4  driver app, truck parked 10 minutes: the mic works, the note reads
//       "Record only when parked."; a note goes to Dispatch (no sender header)
//   V5  investor portal (1280x800): the admin's note plays (206); the investor's
//       note goes to the admin desk
//   Vx  page errors, other writes and unanswered endpoints are listed (not part
//       of the verdict)
//
// Like driver-welcome.mjs this boots no server.js, opens no database, reads no
// .env or key and signs nobody in. It serves the checkout's built client/dist
// from its own static server on 127.0.0.1 (E2E_PORT, default 3611) and answers
// every /api request in the browser with made-up fixtures (driver "Pat
// Example", load QA-VOICE-1, investor "qa-voice-investor"). The session answers
// features.voiceNotes = true. GET /api/messages/<id>/voice goes to the static
// server, which serves scripts/fixtures/voice-note-chrome-fake-mic.m4a (a
// synthetic 3.16 s tone, no voice) with Range support. The microphone and
// MediaRecorder are stubbed in the page (Chrome for Testing has no AAC
// encoder): getUserMedia hands back a silent oscillator stream and the recorder
// hands back the same fixture bytes, typed audio/mp4. Every request to another
// host is aborted, the socket included.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm run build:client            (the build under test)
//   SHOT_DIR=/abs/folder/outside/the/checkout node scripts/e2e/voice-notes.mjs
//
// Chrome binds its own sockets, which the Claude Code Bash sandbox refuses:
// run it outside that sandbox. Env: E2E_PORT (default 3611; 3000 and 5173 are
// refused, and so is a port in use), OUT_TAG (default "voice-notes"), HEADED=1,
// CHROME_PATH, E2E_WORK_DIR, SHOT_DIR. Output: the screenshots and
// <work dir>/results-<OUT_TAG>.md. Exit 0 only when every row PASSes.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import paths from './paths.cjs'

const PORT = Number(process.env.E2E_PORT || 3611)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const HEADED = process.env.HEADED === '1'
const OUT_TAG = String(process.env.OUT_TAG || 'voice-notes').replace(/[^\w.-]/g, '')
const DIST = path.join(paths.REPO, 'client', 'dist')
const FIXTURE = path.join(paths.REPO, 'scripts', 'fixtures', 'voice-note-chrome-fake-mic.m4a')

function die(msg) {
  console.error(`voice-notes: ${msg}`)
  process.exit(2)
}

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (PORT === 3000 || PORT === 5173) die(`refusing port ${PORT}: 3000 is production's port on the VPS and 5173 is Vite's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm run build:client\` first`)
if (!fs.existsSync(FIXTURE)) die(`no ${FIXTURE}`)
if (process.env.SHOT_DIR) {
  const dir = process.env.SHOT_DIR
  if (!path.isAbsolute(dir)) die('SHOT_DIR must be an absolute path')
  const rel = path.relative(paths.REPO, path.resolve(dir))
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) die(`SHOT_DIR ${dir} is inside the checkout: pick a folder outside it`)
}
const AUDIO = fs.readFileSync(FIXTURE)

// ---------------------------------------------------------------- made-up fixtures
const DRIVER = 'Pat Example'
const LOAD = 'QA-VOICE-1'
const INVESTOR = 'qa-voice-investor'
const at = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString()
const voiceRow = (id, from, to, ms, minAgo, loadId = LOAD) => ({
  id, timestamp: at(minAgo), from, to, message: `Voice note (0:${String(Math.floor(ms / 1000)).padStart(2, '0')})`,
  loadId, read: 1, attachment_url: '', attachment_type: 'voice', voice_duration_ms: ms,
})
const textRow = (id, from, to, message, minAgo, loadId = LOAD) => ({ id, timestamp: at(minAgo), from, to, message, loadId, read: 1, attachment_url: '', attachment_type: '', voice_duration_ms: 0 })

const SESSIONS = {
  admin: { id: 90001, username: 'qa-voice-admin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Admin', mustChangePassword: false },
  driver: { id: 90002, username: 'qa-voice-driver', role: 'Driver', driverName: DRIVER, email: '', fullName: DRIVER, companyName: '', mustChangePassword: false },
  investor: { id: 90003, username: INVESTOR, role: 'Investor', driverName: '', email: '', fullName: 'QA Investor', mustChangePassword: false },
}

function answerGet(who, pathname, motion) {
  if (pathname === '/api/auth/session') {
    return { authenticated: true, user: SESSIONS[who], appTimeZone: 'America/New_York', features: { voiceNotes: true } }
  }
  if (who === 'admin') {
    if (pathname === '/api/messages') {
      return { conversations: [
        { driver: DRIVER, loadId: LOAD, lastTimestamp: at(3), unread: 0, lastKind: 'voice', lastText: 'Voice note (0:42)', lastVoiceMs: 42000 },
        { driver: 'Sam Example', loadId: '', lastTimestamp: at(40), unread: 0, lastKind: 'text', lastText: 'At the receiver now' },
      ] }
    }
    if (pathname === `/api/messages/${encodeURIComponent(DRIVER)}`) {
      return { messages: [textRow(9100, DRIVER, 'Dispatch', 'Loaded and rolling', 20), voiceRow(9101, DRIVER, 'Dispatch', 3160, 3)] }
    }
    if (pathname === '/api/users/investors') return { investors: [] }
  }
  if (who === 'driver') {
    if (pathname === `/api/driver/${encodeURIComponent(DRIVER)}`) {
      return {
        loads: [], headers: { jobTracking: [], carrierDB: [] },
        onboarding: { user_id: SESSIONS.driver.id, status: 'fully_onboarded', onboarded_at: at(60 * 24 * 30), documents: [], totalDocs: 6 },
        driverInfo: null, truck: null,
        messages: [textRow(9200, 'Dispatch', DRIVER, 'Call when you are parked', 12), voiceRow(9201, 'Dispatch', DRIVER, 3160, 5)],
        notifications: [], expenses: [], drivers: [], invoices: [], sharedDocuments: [], truckDocuments: [],
      }
    }
    if (pathname === '/api/driver/position') {
      const moving = motion === 'moving'
      return {
        ok: true, unit: 'QA-1',
        position: {
          latitude: 33.75, longitude: -84.39, speed: moving ? 24.6 : 0, speedMph: moving ? 55 : 0, heading: 90,
          timestamp: new Date(Date.now() - 4000).toISOString(), lastPingAge: 4000, source: 'routemate', fuelPct: null,
          movement: moving ? 'moving' : 'stopped', stoppedSinceMs: moving ? null : Date.now() - 10 * 60000,
        },
      }
    }
    if (pathname === '/api/fuel/range') return { ok: false }
  }
  if (who === 'investor') {
    if (pathname === '/api/investor') return { investor: { id: 90301, username: INVESTOR }, myLoads: { pending: [], active: [] } }
    if (pathname === '/api/investor/messages') {
      return { messages: [
        { ...textRow(9300, 'Dispatch', INVESTOR, 'Your truck is back in service', 30, ''), asset_ref: '' },
        { ...voiceRow(9301, 'Dispatch', INVESTOR, 3160, 8, ''), asset_ref: '' },
      ] }
    }
  }
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.mjs': 'text/javascript; charset=utf-8' }
const servedVoice = []

// GET /api/messages/<id>/voice: the fixture, with Range support (iOS refuses
// media from a server that ignores Range; the real route answers 206 too).
function serveVoice(req, res, id) {
  const total = AUDIO.length
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''))
  const headers = { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=0, must-revalidate', 'x-content-type-options': 'nosniff' }
  if (range) {
    const start = range[1] === '' ? Math.max(0, total - Number(range[2])) : Number(range[1])
    const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), total - 1) : total - 1
    servedVoice.push({ id, status: 206, range: req.headers.range })
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': end - start + 1 })
    res.end(AUDIO.subarray(start, end + 1))
    return
  }
  servedVoice.push({ id, status: 200, range: '' })
  res.writeHead(200, { ...headers, 'content-length': total })
  res.end(AUDIO)
}

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  const voice = /^\/api\/messages\/(\d{1,12})\/voice$/.exec(rel)
  if (voice && req.method === 'GET') return serveVoice(req, res, Number(voice[1]))
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by the voice notes check"}')
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
async function shot(page, name, opts = {}) {
  const file = path.join(shotDir(), `${OUT_TAG}-${name}.png`)
  await page.screenshot({ path: file, ...opts })
  return file
}

// ---------------------------------------------------------------- the page
// The microphone and recorder, stubbed in the page before any app code runs.
function stubRecording(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  class FakeRecorder {
    constructor(stream, opts) { this.stream = stream; this.opts = opts; this.mimeType = 'audio/mp4'; this.state = 'inactive'; this.ondataavailable = null; this.onstop = null }
    static isTypeSupported(t) { return /^audio\/mp4/.test(String(t)) }
    start() { this.state = 'recording' }
    stop() {
      if (this.state === 'inactive') return
      this.state = 'inactive'
      setTimeout(() => {
        if (this.ondataavailable) this.ondataavailable({ data: new Blob([bytes], { type: 'audio/mp4' }) })
        if (this.onstop) this.onstop()
      }, 0)
    }
  }
  window.MediaRecorder = FakeRecorder
  const getUserMedia = async () => {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    gain.gain.value = 0
    const dest = ctx.createMediaStreamDestination()
    osc.connect(gain).connect(dest)
    osc.start()
    return dest.stream
  }
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = getUserMedia
  else Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia } })
  // The driver's welcome card stays closed.
  try { localStorage.setItem('logisx_welcome_seen_90002', '1') } catch { /* no storage */ }
}

async function open(browser, who, { viewport, phone = false, motion = 'parked', voiceAnswer }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  const posts = []
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.host !== `${HOST}:${PORT}`) return route.abort()
    if (url.pathname.startsWith('/socket.io/')) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (/^\/api\/messages\/\d+\/voice$/.test(url.pathname) && req.method() === 'GET') return route.continue()
    if (req.method() !== 'GET') {
      if (url.pathname.startsWith('/api/messages/voice')) {
        const body = req.postDataBuffer() || Buffer.alloc(0)
        posts.push({ url: req.url(), headers: await req.allHeaders(), body })
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(voiceAnswer) })
      }
      writes.push(`${who} ${req.method()} ${url.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    const body = answerGet(who, url.pathname, motion)
    if (body === null) unanswered.add(`${who} ${url.pathname}`)
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body || {}) })
  })
  await ctx.addInitScript(stubRecording, AUDIO.toString('base64'))
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${String(e.message || e).slice(0, 200)}`))
  return { ctx, page, posts }
}

const voiceServedFor = (id, since) => servedVoice.slice(since).filter((r) => r.id === id)
async function playAndCheck(page, label, id) {
  const before = servedVoice.length
  const btn = page.getByRole('button', { name: label })
  await btn.first().click()
  await page.waitForTimeout(1500)
  const got = voiceServedFor(id, before)
  const played = await page.evaluate(() => [...document.querySelectorAll('audio')].some((a) => a.currentTime > 0))
  return { got, played, ok: got.some((r) => r.status === 206) }
}

function checkPost(p, { to, loadId, from }) {
  const u = new URL(p.url)
  const h = p.headers
  const problems = []
  if (u.pathname !== '/api/messages/voice' || u.search) problems.push(`URL ${u.pathname}${u.search}`)
  if (h['content-type'] !== 'audio/mp4') problems.push(`content-type ${h['content-type']}`)
  if (h['x-message-to'] !== encodeURIComponent(to)) problems.push(`to ${h['x-message-to']}`)
  if ((h['x-message-load-id'] || '') !== (loadId ? encodeURIComponent(loadId) : '')) problems.push(`load ${h['x-message-load-id']}`)
  if ((h['x-message-from'] || '') !== (from ? encodeURIComponent(from) : '')) problems.push(`from ${h['x-message-from']}`)
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(h['idempotency-key'] || '')) problems.push(`key ${h['idempotency-key']}`)
  if (h['x-requested-with'] !== 'XMLHttpRequest') problems.push('no X-Requested-With')
  if (!p.body.equals(AUDIO)) problems.push(`body ${p.body.length} bytes, not the recording`)
  return problems
}

// Mic, then a little over a second of "Recording" (the client refuses under 1 s).
async function startRecording(page) {
  await page.getByRole('button', { name: 'Record a voice note' }).first().click()
  await page.getByText('Recording', { exact: true }).first().waitFor({ timeout: 5000 })
  await page.waitForTimeout(1300)
}

// ---------------------------------------------------------------- the steps
async function dashboard(browser) {
  const { ctx, page, posts } = await open(browser, 'admin', { viewport: { width: 1280, height: 800 }, voiceAnswer: { success: true, id: 9150, durationMs: 3160 } })
  try {
    await page.goto(`${BASE}/messages`, { waitUntil: 'domcontentloaded' })
    await page.locator('.msg-driver-item', { hasText: DRIVER }).first().waitFor({ timeout: 15000 })
    const preview = await page.locator('.msg-driver-item', { hasText: DRIVER }).first().locator('.msg-preview').textContent().catch(() => '')
    await page.locator('.msg-driver-item', { hasText: DRIVER }).first().click()
    await page.getByRole('button', { name: /^Play voice note/ }).first().waitFor({ timeout: 10000 })
    const play = await playAndCheck(page, /^Play voice note, 3 seconds/, 9101)
    record('V1', 'Dashboard: list line and playback', '"Voice note (0:42)" in the list; the note plays from /api/messages/9101/voice with a 206',
      `list line "${(preview || '').trim()}"; voice requests ${JSON.stringify(play.got)}; audio advanced ${play.played}`,
      (preview || '').trim() === 'Voice note (0:42)' && play.ok, await shot(page, 'V1-dashboard-play'))

    await startRecording(page)
    const recShot = await shot(page, 'V2a-dashboard-recording')
    await page.getByRole('button', { name: 'Stop recording' }).click()
    await page.getByRole('button', { name: /^Send voice note, / }).waitFor({ timeout: 5000 })
    const reviewShot = await shot(page, 'V2b-dashboard-review')
    await page.getByRole('button', { name: /^Send voice note, / }).click()
    await page.getByRole('button', { name: 'Record a voice note' }).first().waitFor({ timeout: 10000 })
    // Counted by the player's group name: its button reads "Pause" while V1's note
    // is still playing.
    const players = await page.getByRole('group', { name: 'Voice note, 3 seconds', exact: true }).count()
    const problems = posts.length === 1 ? checkPost(posts[0], { to: DRIVER, loadId: LOAD, from: 'Dispatch' }) : [`${posts.length} uploads`]
    record('V2', 'Dashboard: record, review, send', 'one POST /api/messages/voice (no query), audio/mp4 body = the recording, To/Load/From headers encoded, an Idempotency-Key; the sent note shows as a player',
      `${problems.length ? problems.join('; ') : 'upload as expected'}; players for 3 s notes: ${players}; screenshots ${path.basename(recShot)}, ${path.basename(reviewShot)}`,
      problems.length === 0 && players === 2, await shot(page, 'V2c-dashboard-sent'))
  } finally {
    await ctx.close()
  }
}

async function driver(browser, motion) {
  const step = motion === 'moving' ? 'V3' : 'V4'
  const { ctx, page, posts } = await open(browser, 'driver', { viewport: { width: 390, height: 844 }, phone: true, motion, voiceAnswer: { success: true, id: 9250, durationMs: 3160 } })
  try {
    await page.goto(`${BASE}/driver`, { waitUntil: 'domcontentloaded' })
    await page.locator('.van-tabbar-item', { hasText: 'Messages' }).first().waitFor({ timeout: 15000 })
    await page.locator('.van-tabbar-item', { hasText: 'Messages' }).first().click()
    const mic = page.locator('.vn-mic').first()
    await mic.waitFor({ timeout: 10000 })
    // The gate reads the first position poll; give it a moment.
    await page.waitForTimeout(1200)
    const disabled = await mic.isDisabled()
    const note = ((await page.locator('#vn-drive-note').textContent().catch(() => '')) || '').trim()
    const described = await mic.getAttribute('aria-describedby')
    if (motion === 'moving') {
      await page.locator('.chat-input-bar').scrollIntoViewIfNeeded()
      const blockedShot = await shot(page, 'V3a-driver-moving')
      const play = await playAndCheck(page, /^Play voice note, 3 seconds/, 9201)
      record('V3', 'Driver app, truck moving: mic natively disabled; Dispatch\'s note plays',
        'mic disabled, described by #vn-drive-note, "Voice notes are off while the truck is moving. Park first, then record."; playback 206',
        `disabled ${disabled}; described-by ${described}; note "${note}"; voice requests ${JSON.stringify(play.got)}; audio advanced ${play.played}; screenshot ${path.basename(blockedShot)}`,
        disabled === true && described === 'vn-drive-note' && note === 'Voice notes are off while the truck is moving. Park first, then record.' && play.ok,
        await shot(page, 'V3b-driver-moving-played'))
      return
    }
    const okGate = disabled === false && note === 'Record only when parked.'
    await startRecording(page)
    const recShot = await shot(page, 'V4a-driver-parked-recording')
    await page.getByRole('button', { name: 'Stop recording' }).click()
    await page.getByRole('button', { name: /^Send voice note, / }).waitFor({ timeout: 5000 })
    const reviewShot = await shot(page, 'V4b-driver-parked-review')
    await page.getByRole('button', { name: /^Send voice note, / }).click()
    await page.locator('.vn-mic').first().waitFor({ timeout: 10000 })
    const problems = posts.length === 1 ? checkPost(posts[0], { to: 'Dispatch', loadId: '', from: '' }) : [`${posts.length} uploads`]
    record('V4', 'Driver app, truck parked 10 minutes: record and send to Dispatch',
      'mic enabled, note "Record only when parked."; one POST, To "Dispatch", no sender header, audio/mp4 body = the recording',
      `disabled ${disabled}; note "${note}"; ${problems.length ? problems.join('; ') : 'upload as expected'}; screenshots ${path.basename(recShot)}, ${path.basename(reviewShot)}`,
      okGate && problems.length === 0, await shot(page, 'V4c-driver-parked-sent'))
  } finally {
    await ctx.close()
  }
}

async function investor(browser) {
  const { ctx, page, posts } = await open(browser, 'investor', { viewport: { width: 1280, height: 800 }, voiceAnswer: { success: true, id: 9350, durationMs: 3160 } })
  try {
    await page.goto(`${BASE}/investor`, { waitUntil: 'domcontentloaded' })
    const chat = page.locator('.chat-section').first()
    await chat.waitFor({ timeout: 15000 })
    await chat.scrollIntoViewIfNeeded()
    await chat.getByRole('button', { name: /^Play voice note/ }).first().waitFor({ timeout: 10000 })
    const play = await playAndCheck(page, /^Play voice note, 3 seconds/, 9301)
    const viewShot = await chat.screenshot({ path: path.join(shotDir(), `${OUT_TAG}-V5a-investor.png`) }).then(() => path.join(shotDir(), `${OUT_TAG}-V5a-investor.png`))
    await startRecording(page)
    const recShot = path.join(shotDir(), `${OUT_TAG}-V5b-investor-recording.png`)
    await chat.screenshot({ path: recShot })
    await page.getByRole('button', { name: 'Stop recording' }).click()
    await page.getByRole('button', { name: /^Send voice note, / }).click()
    await page.getByRole('button', { name: 'Record a voice note' }).first().waitFor({ timeout: 10000 })
    const problems = posts.length === 1 ? checkPost(posts[0], { to: 'admin', loadId: '', from: '' }) : [`${posts.length} uploads`]
    const sentShot = path.join(shotDir(), `${OUT_TAG}-V5c-investor-sent.png`)
    await chat.screenshot({ path: sentShot })
    record('V5', 'Investor portal: the admin\'s note plays; a note goes to the admin desk',
      'playback 206; one POST, To "admin", no sender header, audio/mp4 body = the recording',
      `voice requests ${JSON.stringify(play.got)}; audio advanced ${play.played}; ${problems.length ? problems.join('; ') : 'upload as expected'}; screenshots ${path.basename(viewShot)}, ${path.basename(recShot)}`,
      play.ok && problems.length === 0, sentShot)
  } finally {
    await ctx.close()
  }
}

async function main() {
  if (await portInUse(PORT)) die(`port ${PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve) })
  // The static server lives in this process: it stops when the run ends.
  console.log(`voice-notes: serving ${DIST} on ${BASE} (made-up data; no server.js; pid ${process.pid})`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED, args: ['--autoplay-policy=no-user-gesture-required'] })
  const guard = async (name, fn) => {
    try { await fn() } catch (e) { record(name, 'step ran to the end', 'no exception', String(e.message || e).split('\n')[0].slice(0, 300), false) }
  }
  try {
    await guard('V1-V2', () => dashboard(browser))
    await guard('V3', () => driver(browser, 'moving'))
    await guard('V4', () => driver(browser, 'parked'))
    await guard('V5', () => investor(browser))
  } finally {
    await browser.close()
    server.close()
  }

  const resultsFile = path.join(paths.workDir(), `results-${OUT_TAG}.md`)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const md = [
    `# Voice notes client check (${OUT_TAG})`, '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Other writes sent by the page (not part of the verdict): ${writes.length ? writes.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, md, { mode: 0o600 })
  console.log(`voice-notes: ${rows.filter((r) => r.verdict === 'PASS').length}/${rows.length} PASS; results ${resultsFile}; screenshots ${shotDir()}`)
  if (pageErrors.length) console.log(`voice-notes: page errors: ${pageErrors.join(' | ')}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error(`voice-notes: aborted: ${e.stack || e}`)
  process.exit(1)
})
