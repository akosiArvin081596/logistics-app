#!/usr/bin/env node
// Records the driver app walkthrough video on the e2e server, made-up data only.
//
//   node scripts/e2e/driver-walkthrough.mjs --base=http://127.0.0.1:3192 --out=<abs dir> [--only=5,6] [--no-encode]
//   node scripts/e2e/driver-walkthrough.mjs --dry                        timing and caption lint, no browser
//   node scripts/e2e/driver-walkthrough.mjs --out=<abs dir> --captions-only   rebuild the VTT from timeline.json
//   node scripts/e2e/driver-walkthrough.mjs --out=<abs dir> --encode-only     re-encode the recorded frames
//
// The server must be one boot-server.sh started on a database setup-db.cjs made up and
// walkthrough/plant.cjs planted (walkthrough-login.json in the work dir names the driver; the
// password is read from the Keychain, in memory only, never printed).
// - Films each storyboard chapter as one take through a CDP screencast (JPEG frames with their
//   timestamps), at 390 x 844, 2x, touch, an iPhone user agent. Chapter frames go to
//   <out>/frames/NN-<id>/, beat times to <out>/timeline.json.
// - The browser may reach the base host only: every other host is aborted and listed.
// - Then encodes with the system ffmpeg: H.264 MP4 (no audio, faststart, <= 12 MB), the WebVTT
//   captions, the poster (from the title card) and contact sheets for the frame review.
// Refuses: a base other than 127.0.0.1/localhost, ports 3000 and 5173, an --out inside a checkout.
// Exit 0 done; 1 a chapter failed (nothing encoded); 2 could not start; 3 a refusal or block.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)
const paths = req('./paths.cjs')
const keychain = req('./keychain.cjs')
const { DEMO, CARDS, CHAPTERS, chapterBy } = req('./walkthrough/storyboard.cjs')
const cap = req('./walkthrough/captions.cjs')
const { FX_SOURCE } = req('../docs/lib/video-fx.js')

const VIEWPORT = { width: 390, height: 844 }
const FRAME = { width: 780, height: 1688 }
// A current iPhone Safari. Only the user agent: the engine is still Chromium.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const NAMES = {
  mp4: 'logisx-driver-app-walkthrough.mp4',
  vtt: 'logisx-driver-app-walkthrough.en.vtt',
  poster: 'logisx-driver-app-walkthrough-poster.jpg',
}
const MP4_MAX_BYTES = 12_000_000
const POSTER_MAX_BYTES = 150_000
const CRF_STEPS = [26, 27, 28]
const SETTLE_MS = 800
// Keeps every tap and pointer clear of the sticky header and the bottom tab bar.
const INSET = { top: 72, bottom: 84 }
const LOGIN_FILE = 'walkthrough-login.json'
const BLOCK_RE = /ERR_BLOCKED_BY_(CLIENT|ADMINISTRATOR|RESPONSE)|ERR_ACCESS_DENIED|ERR_NETWORK_ACCESS_DENIED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE|EPERM|EACCES|Operation not permitted/i

class Refusal extends Error {}
class Precondition extends Error {}

let secret = null
const scrub = (s) => (secret ? String(s).split(secret).join('[redacted]') : String(s))
const firstLine = (e) => scrub(e && e.message ? e.message : e).split('\n')[0].slice(0, 400)
const say = (msg) => console.log(`walkthrough: ${scrub(msg)}`)
function die(code, msg) {
  console.error(`walkthrough: ${scrub(msg)}`)
  process.exit(code)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))
const pad2 = (n) => String(n).padStart(2, '0')
const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep)

// ------------------------------------------------------------------------------- arguments
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a)
  if (!m) die(2, `unknown argument ${a}`)
  return [m[1], m[2] === undefined ? true : m[2]]
}))
for (const k of Object.keys(args)) {
  if (!['base', 'out', 'only', 'dry', 'captions-only', 'encode-only', 'no-encode'].includes(k)) die(2, `unknown option --${k}`)
}

function checkBase(raw) {
  let u
  try { u = new URL(String(raw)) } catch { die(2, `--base must be a URL, got ${raw}`) }
  if (u.protocol !== 'http:') die(2, `refusing --base ${raw}: http on this Mac only`)
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) die(2, `refusing --base ${raw}: only 127.0.0.1 or localhost (the e2e server)`)
  if (!u.port) die(2, `refusing --base ${raw}: name the e2e server's port`)
  if (['3000', '5173'].includes(u.port)) die(2, `refusing port ${u.port}: 3000 is production on the VPS, 5173 is Vite`)
  return { origin: u.origin, host: u.host }
}

function checkOut(raw) {
  if (!raw || raw === true || !path.isAbsolute(String(raw))) die(2, '--out must be an absolute folder outside every checkout')
  const abs = path.resolve(String(raw))
  let head = abs
  const rest = []
  while (!fs.existsSync(head)) { rest.unshift(path.basename(head)); head = path.dirname(head) }
  const planned = path.join(fs.realpathSync(head), ...rest)
  for (const checkout of new Set([paths.REPO, paths.mainCheckout()].map((p) => { try { return fs.realpathSync(p) } catch { return p } }))) {
    if (isInside(planned, checkout)) die(2, `refusing --out ${abs}: it is inside the checkout ${checkout}. The frames and takes live outside the repo until the frame review passes`)
  }
  fs.mkdirSync(planned, { recursive: true, mode: 0o700 })
  return planned
}

function selectedChapters() {
  if (!args.only) return CHAPTERS
  const out = []
  for (const ref of String(args.only).split(',').map((s) => s.trim()).filter(Boolean)) {
    const ch = chapterBy(ref)
    if (!ch) die(2, `--only: no chapter "${ref}" (numbers 0-${CHAPTERS.length - 1} or ids ${CHAPTERS.map((c) => c.id).join(', ')})`)
    if (!out.includes(ch)) out.push(ch)
  }
  return out.sort((a, b) => a.n - b.n)
}

function lintOrDie() {
  const problems = cap.lintStoryboard({ DEMO, CARDS, CHAPTERS })
  if (problems.length) {
    for (const p of problems) console.error(`walkthrough: storyboard: ${p}`)
    die(2, `the storyboard has ${problems.length} problem(s); fix them in walkthrough/storyboard.cjs`)
  }
}

// ------------------------------------------------------------------------------ timeline
const timelineFile = (out) => path.join(out, 'timeline.json')
function readTimeline(out) {
  try { return JSON.parse(fs.readFileSync(timelineFile(out), 'utf8')) } catch { return { version: 1, chapters: [] } }
}
function saveChapter(out, rec, meta) {
  const t = readTimeline(out)
  t.version = 1
  t.updatedAt = new Date().toISOString()
  t.viewport = { ...VIEWPORT, deviceScaleFactor: 2, frame: FRAME }
  t.meta = { ...(t.meta || {}), ...meta }
  t.chapters = [...(t.chapters || []).filter((c) => c.id !== rec.id), rec].sort((a, b) => a.n - b.n)
  fs.writeFileSync(timelineFile(out), JSON.stringify(t, null, 2) + '\n')
}

// ------------------------------------------------------------------------- captions only
function writeCaptions(out) {
  const timeline = readTimeline(out)
  const { cues, durationMs } = cap.buildCues(timeline, CHAPTERS)
  fs.writeFileSync(path.join(out, NAMES.vtt), cap.formatVtt(cues))
  fs.writeFileSync(path.join(out, 'transcript.txt'), cap.formatTranscript(CHAPTERS) + '\n')
  say(`captions: ${cues.length} cues over ${(durationMs / 1000).toFixed(1)} s -> ${path.join(out, NAMES.vtt)}`)
  return { cues, durationMs }
}

// ------------------------------------------------------------------------------- encoding
function findFfmpeg() {
  for (const dir of String(process.env.PATH || '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin'])) {
    const p = path.join(dir, 'ffmpeg')
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ }
  }
  return null
}

function ffmpegRun(ffmpeg, argv, what) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`ffmpeg (${what}) exit ${r.status}: ${String(r.stderr || r.error || '').trim().split('\n').slice(-4).join(' | ')}`)
}

// One ffconcat over every chapter in order: each frame lasts until the next one, the last
// frame of a chapter until the chapter ended, so a still screen needs no repeated frames.
function writeConcat(out) {
  const lines = ['ffconcat version 1.0']
  let last = null
  let totalMs = 0
  for (const ch of CHAPTERS) {
    const dir = path.join(out, 'frames', `${pad2(ch.n)}-${ch.id}`)
    let list
    try { list = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8')) } catch {
      throw new Error(`chapter ${ch.n} (${ch.id}) has no recorded frames in ${dir}: record it first`)
    }
    if (!list.frames.length) throw new Error(`chapter ${ch.id} recorded no frames`)
    list.frames.forEach((f, i) => {
      const next = i + 1 < list.frames.length ? list.frames[i + 1].ms : list.endMs
      const dur = Math.max(1, next - f.ms)
      const file = path.join(dir, f.file).replace(/'/g, "'\\''")
      lines.push(`file '${file}'`, `duration ${(dur / 1000).toFixed(3)}`)
      last = file
      totalMs += dur
    })
  }
  lines.push(`file '${last}'`)
  const file = path.join(out, 'frames.ffconcat')
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return { file, totalMs }
}

function encode(out) {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) die(2, 'ffmpeg is not installed (it is not on PATH, /opt/homebrew/bin or /usr/local/bin). Installing it (brew install ffmpeg) needs Arvin; nothing was encoded')
  const { file: concat, totalMs } = writeConcat(out)
  const mp4 = path.join(out, NAMES.mp4)
  const tmp = path.join(out, `.encoding-${process.pid}.mp4`)
  let size = 0
  let crf = null
  for (const c of CRF_STEPS) {
    say(`encoding ${(totalMs / 1000).toFixed(1)} s at CRF ${c} (preset slow; a few minutes)`)
    ffmpegRun(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', concat,
      '-vf', `scale=${FRAME.width}:${FRAME.height}:force_original_aspect_ratio=decrease,pad=${FRAME.width}:${FRAME.height}:(ow-iw)/2:(oh-ih)/2:color=white,fps=25,format=yuv420p`,
      '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.0', '-preset', 'slow', '-crf', String(c),
      // -t: the fps filter holds the repeated last frame for one more gap at EOF; cut at the
      // recorded total so the captions, timed from the same total, stay in step.
      '-x264-params', 'keyint=50:min-keyint=25', '-movflags', '+faststart', '-an', '-t', (totalMs / 1000).toFixed(3), tmp], `mp4 crf ${c}`)
    size = fs.statSync(tmp).size
    if (size <= MP4_MAX_BYTES) { crf = c; break }
    say(`CRF ${c} gave ${(size / 1e6).toFixed(2)} MB, over ${MP4_MAX_BYTES / 1e6} MB`)
  }
  if (crf === null) {
    fs.rmSync(tmp, { force: true })
    throw new Error(`no CRF in ${CRF_STEPS.join('/')} brings the MP4 under ${MP4_MAX_BYTES / 1e6} MB: shorten the storyboard`)
  }
  fs.renameSync(tmp, mp4)
  const poster = path.join(out, NAMES.poster)
  for (const q of [4, 6, 8]) {
    ffmpegRun(ffmpeg, ['-ss', '1.5', '-i', mp4, '-frames:v', '1', '-vf', 'scale=390:-2', '-q:v', String(q), poster], 'poster')
    if (fs.statSync(poster).size <= POSTER_MAX_BYTES) break
  }
  writeCaptions(out)
  const review = path.join(out, 'review')
  fs.rmSync(review, { recursive: true, force: true })
  fs.mkdirSync(review, { recursive: true })
  ffmpegRun(ffmpeg, ['-i', mp4, '-vf', 'fps=1/2,scale=195:-2,tile=8x6', path.join(review, 'sheet-%02d.jpg')], 'contact sheets')
  ffmpegRun(ffmpeg, ['-i', mp4, '-vf', 'fps=1/2,scale=390:-2,tile=4x3', path.join(review, 'large-%02d.jpg')], 'large contact sheets')
  say(`mp4: ${mp4} (${(size / 1e6).toFixed(2)} MB, CRF ${crf}, ${(totalMs / 1000).toFixed(1)} s)`)
  say(`poster: ${poster} (${fs.statSync(poster).size} bytes)`)
  say(`vtt: ${path.join(out, NAMES.vtt)}; transcript: ${path.join(out, 'transcript.txt')}`)
  say(`review: ${review} (sheet-NN.jpg: one frame every 2 s, 8 x 6; large-NN.jpg: the same frames at 390 px, 4 x 3)`)
}

// ------------------------------------------------------------------------------ the take
function cardHtml(card) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;height:100%;background:#0f1d33;color:#fff;font-family:-apple-system,"Helvetica Neue",Arial,sans-serif}
  .wrap{box-sizing:border-box;height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 32px}
  .bar{width:56px;height:6px;border-radius:3px;background:#ffc400;margin-bottom:28px}
  h1{font-size:34px;line-height:1.2;margin:0 0 28px;font-weight:800}
  p{font-size:22px;line-height:1.45;margin:0 0 10px;color:#dbe4f3}
  .foot{position:absolute;left:32px;right:32px;bottom:56px;font-size:15px;line-height:1.4;color:#9fb0cc}
</style></head><body><div class="wrap"><div class="bar"></div><h1>${esc(card.heading)}</h1>
${card.lines.map((l) => `<p>${esc(l)}</p>`).join('\n')}</div><div class="foot">${esc(card.footnote)}</div></body></html>`
}

// The POD and receipt pictures, drawn by the browser now; both say they are not real.
async function drawProps(browser, out) {
  const dir = path.join(out, 'props')
  fs.mkdirSync(dir, { recursive: true })
  const active = DEMO.loads.find((l) => l.key === 'active')
  const ctx = await browser.newContext({ viewport: { width: 600, height: 800 }, deviceScaleFactor: 1 })
  await ctx.route('**/*', (route) => route.abort())
  const page = await ctx.newPage()
  const shoot = async (html, name) => {
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#fbfaf6;font-family:Courier,monospace;color:#222">${html}</body></html>`)
    const file = path.join(dir, name)
    await page.screenshot({ path: file, type: 'jpeg', quality: 85 })
    return file
  }
  const stamp = `<div style="margin:18px 0;padding:10px;border:3px solid #b00;color:#b00;font:bold 26px Helvetica,Arial;text-align:center">${DEMO.props.notReal}</div>`
  const pod = await shoot(`<div style="padding:36px">
    <div style="font:bold 26px Helvetica,Arial">${DEMO.props.podTitle}</div>${stamp}
    <p style="font-size:22px">Load: ${active.id}</p><p style="font-size:22px">Shipper: ${active.pickupInfo}</p>
    <p style="font-size:22px">Receiver: ${active.dropInfo}</p><p style="font-size:22px">Pieces: 22 pallets</p>
    <p style="font-size:22px;margin-top:40px">Received in good order</p>
    <p style="font-size:22px;border-top:2px solid #444;padding-top:8px;margin-top:70px">Receiver signature (sample)</p></div>`, 'sample-pod.jpg')
  const receipt = await shoot(`<div style="padding:36px 60px">
    <div style="font:bold 28px Helvetica,Arial;text-align:center">${DEMO.props.receiptTitle}</div>
    <div style="text-align:center;font-size:22px;margin-top:6px">${DEMO.expense.vendor}</div>${stamp}
    <p style="font-size:22px">Diesel ........ ${DEMO.expense.gallons} gal</p>
    <p style="font-size:22px">Total ......... $${DEMO.expense.amount}</p>
    <p style="font-size:22px">Pump 7 · Paid card</p></div>`, 'sample-receipt.jpg')
  await ctx.close()
  return { pod, receipt }
}

async function record(out, selected, base) {
  try {
    const r = await fetch(`${base.origin}/api/auth/session`, { signal: AbortSignal.timeout(10000) })
    if (r.status !== 200) die(2, `${base.origin}/api/auth/session answered ${r.status}`)
  } catch (e) {
    const why = [e.cause && e.cause.code, e.cause && e.cause.message, e.message].filter(Boolean).join(' / ')
    if (BLOCK_RE.test(why) && !/ECONNREFUSED/.test(why)) die(3, `REFUSED (stopped, nothing retried): reaching ${base.origin}: ${why}`)
    die(2, `nothing answers on ${base.origin} (${why}): boot the e2e server first`)
  }
  let login
  try {
    login = JSON.parse(fs.readFileSync(path.join(paths.workDir(), LOGIN_FILE), 'utf8'))
    if (login.username !== DEMO.driver.username) throw new Error(`it names ${login.username}, not ${DEMO.driver.username}`)
    secret = keychain.readPassword(keychain.itemFor('walkthroughDriver', { keychain: login.keychain }))
    if (!secret) throw new Error(`no Keychain password (service ${login.keychain && login.keychain.service}, account ${login.keychain && login.keychain.account})`)
  } catch (e) {
    die(2, `the walkthrough login (${LOGIN_FILE} in the work dir; run walkthrough/plant.cjs): ${firstLine(e)}`)
  }

  let chromium
  try { ({ chromium } = req('playwright-core')) } catch (e) { die(2, `playwright-core is not installed in scripts/e2e: ${firstLine(e)}`) }
  let browser
  try {
    browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: true })
  } catch (e) {
    die(BLOCK_RE.test(String(e && e.message)) ? 3 : 2, `the browser did not start: ${firstLine(e)}`)
  }
  const aborted = new Set()
  const consoleErrors = []
  const pageErrors = []
  const dialogs = []
  let refusal = null
  let exitCode = 0
  try {
    const props = await drawProps(browser, out)
    const ctx = await browser.newContext({
      viewport: VIEWPORT, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA,
      locale: 'en-US', timezoneId: 'America/New_York', serviceWorkers: 'block',
    })
    ctx.setDefaultTimeout(20000)
    await ctx.route('**/*', (route) => {
      let u
      try { u = new URL(route.request().url()) } catch { return route.abort() }
      if (!/^https?:$/.test(u.protocol) || u.host === base.host) return route.continue()
      aborted.add(u.host)
      return route.abort()
    })
    const page = await ctx.newPage()
    page.on('requestfailed', (r) => {
      let u
      try { u = new URL(r.url()) } catch { return }
      const text = (r.failure() && r.failure().errorText) || ''
      if (u.host === base.host && BLOCK_RE.test(text) && !refusal) refusal = `${r.method()} ${u.pathname}: ${text}`
    })
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      const at = String((m.location() && m.location().url) || '').slice(0, 160)
      consoleErrors.push({ text: scrub(m.text()).slice(0, 200), at: scrub(at) })
    })
    page.on('pageerror', (e) => pageErrors.push(firstLine(e)))
    page.on('dialog', (d) => { dialogs.push(d.message().slice(0, 120)); d.dismiss().catch(() => {}) })
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Page.enable')
    const H = helpers(page, base, () => { if (refusal) throw new Refusal(refusal) })

    for (const ch of selected) {
      say(`chapter ${ch.n} ${ch.id}: setting up`)
      await SETUP[ch.id](H, { props })
      say(`chapter ${ch.n} ${ch.id}: filming`)
      const rec = await film(cdp, page, out, ch, (beat) => TAKES[ch.id](H, beat, { props }), H)
      saveChapter(out, rec, { base: base.host, chromium: browser.version() })
      say(`chapter ${ch.n} ${ch.id}: ${(rec.durationMs / 1000).toFixed(1)} s, ${rec.frames} frames`)
    }
  } catch (e) {
    if (e instanceof Refusal || refusal) {
      console.error(`walkthrough: REFUSED (stopped, nothing retried): ${scrub(refusal || e.message)}`)
      exitCode = 3
    } else if (e instanceof Precondition) {
      console.error(`walkthrough: ${firstLine(e)}`)
      exitCode = 1
    } else {
      console.error(`walkthrough: stopped: ${firstLine(e)}`)
      exitCode = 1
    }
  } finally {
    await browser.close().catch(() => {})
    const meta = { abortedHosts: [...aborted].sort(), consoleErrors: consoleErrors.length, consoleErrorTexts: consoleErrors.slice(0, 20), pageErrors, dialogs }
    const t = readTimeline(out)
    t.meta = { ...(t.meta || {}), lastRun: { at: new Date().toISOString(), exitCode, ...meta } }
    fs.writeFileSync(timelineFile(out), JSON.stringify(t, null, 2) + '\n')
    say(`hosts aborted: ${meta.abortedHosts.join(', ') || 'none'}; console errors: ${consoleErrors.length}; page errors: ${pageErrors.length}; dialogs: ${dialogs.length}`)
  }
  return exitCode
}

// One chapter as one take: the screencast runs from the first beat to the last.
async function film(cdp, page, out, ch, take, H) {
  const dir = path.join(out, 'frames', `${pad2(ch.n)}-${ch.id}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const frames = []
  const writes = []
  const onFrame = ({ data, metadata, sessionId }) => {
    const file = `f-${String(frames.length + 1).padStart(6, '0')}.jpg`
    frames.push({ file, rx: Date.now(), ts: metadata && metadata.timestamp ? metadata.timestamp * 1000 : null })
    writes.push(fs.promises.writeFile(path.join(dir, file), Buffer.from(data, 'base64')))
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  }
  cdp.on('Page.screencastFrame', onFrame)
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: FRAME.width, maxHeight: FRAME.height, everyNthFrame: 1 })
  for (let i = 0; i < 30 && !frames.length; i++) {
    if (i === 10) await H.nudge()
    await sleep(100)
  }
  if (!frames.length) throw new Error(`chapter ${ch.id}: the screencast sent no frame`)
  const beats = []
  const byId = new Map(ch.beats.map((b) => [b.id, b]))
  const beat = async (id, fn) => {
    const sb = byId.get(id)
    if (!sb) throw new Error(`chapter ${ch.id}: the storyboard has no beat "${id}"`)
    if (beats.some((b) => b.id === id)) throw new Error(`chapter ${ch.id}: beat "${id}" filmed twice`)
    const { minMs } = cap.beatPlan(sb)
    const start = Date.now()
    if (fn) await fn({ minMs, until: (ms) => sleep(start + ms - Date.now()) })
    H.check()
    // At least the captions' time, and a moment to see what an action did.
    await sleep(Math.max(start + minMs, fn ? Date.now() + SETTLE_MS : 0) - Date.now())
    beats.push({ id, start, end: Date.now() })
  }
  await take(beat)
  const missing = ch.beats.filter((b) => !beats.some((x) => x.id === b.id)).map((b) => b.id)
  if (missing.length) throw new Error(`chapter ${ch.id}: beat(s) ${missing.join(', ')} were not filmed`)
  const order = beats.map((b) => b.id).join(',')
  if (order !== ch.beats.map((b) => b.id).join(',')) throw new Error(`chapter ${ch.id}: beats filmed as ${order}, not in storyboard order`)
  await sleep(120)
  await cdp.send('Page.stopScreencast')
  cdp.off('Page.screencastFrame', onFrame)
  const stop = Date.now()
  await Promise.all(writes)
  // Frames carry Chrome's swap time, beats this process's clock. Chrome's spacing is kept,
  // shifted onto this clock by the median gap; if the stamps are missing or on another
  // clock, the arrival times are used instead.
  const gaps = frames.filter((f) => f.ts !== null).map((f) => f.rx - f.ts).sort((a, b) => a - b)
  const median = gaps.length === frames.length ? gaps[Math.floor(gaps.length / 2)] : null
  const useTs = median !== null && Math.abs(median) < 1500
  const at = (f) => (useTs ? f.ts + median : f.rx)
  const t0 = at(frames[0])
  const list = { t0, clock: useTs ? 'chrome' : 'arrival', endMs: stop - t0, frames: frames.map((f) => ({ file: f.file, ms: Math.max(0, Math.round(at(f) - t0)) })) }
  fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(list) + '\n')
  const timed = beats.map((b) => ({ id: b.id, startMs: Math.max(0, b.start - t0), endMs: b.end - t0 }))
  timed[timed.length - 1].endMs = list.endMs
  return { n: ch.n, id: ch.id, title: ch.title, recordedAt: new Date().toISOString(), durationMs: list.endMs, frames: frames.length, clock: list.clock, beats: timed }
}

// --------------------------------------------------------------------------- page helpers
function helpers(page, base, check) {
  const H = { page, check }
  H.fx = async () => {
    await page.evaluate(FX_SOURCE)
    // Captions live in the VTT only, and ffconcat holds a still frame, so the overlay's
    // caption band and compositor heartbeat stay hidden.
    await page.evaluate(() => {
      if (document.getElementById('__wt_style')) return
      const s = document.createElement('style')
      s.id = '__wt_style'
      s.textContent = '#__vfx_hb{display:none !important}#__vfx_cap{display:none !important}'
      document.head.appendChild(s)
    })
  }
  // One invisible repaint, for a page so still that the screencast has not sent its first frame.
  H.nudge = () => page.evaluate(() => {
    const hb = document.getElementById('__vfx_hb')
    if (hb) { hb.style.setProperty('display', 'block', 'important'); requestAnimationFrame(() => requestAnimationFrame(() => hb.style.removeProperty('display'))) }
    else { document.body.style.opacity = '0.999'; requestAnimationFrame(() => { document.body.style.opacity = '' }) }
  }).catch(() => {})
  H.api = async (method, url, body) => {
    const r = await page.evaluate(async ({ method, url, body }) => {
      try {
        const res = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: body === undefined ? undefined : JSON.stringify(body) })
        const text = await res.text()
        let json = null
        try { json = JSON.parse(text) } catch { /* not json */ }
        return { status: res.status, json }
      } catch (e) { return { status: 0, json: null, error: String((e && e.message) || e) } }
    }, { method, url, body })
    check()
    return r
  }
  H.goto = async (p) => {
    try { await page.goto(`${base.origin}${p}`, { waitUntil: 'load', timeout: 45000 }) } catch (e) {
      if (BLOCK_RE.test(e.message)) throw new Refusal(`opening ${p}: ${firstLine(e)}`)
      throw e
    }
    check()
  }
  H.inViewport = (box) => !!box && box.y >= 0 && box.y + box.height <= VIEWPORT.height && box.x >= 0 && box.x + box.width <= VIEWPORT.width
  // Brings the target clear of the header and tab bar with the overlay's eased scroll. A fixed
  // or sticky target (the tab bar, a dialog) is left where it is: scrolling cannot move it.
  H.reveal = async (loc, align) => {
    await loc.waitFor({ state: 'visible', timeout: 20000 })
    await H.fx()
    const handle = await loc.elementHandle()
    await page.evaluate(([el, inset, a]) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (/^(fixed|sticky)$/.test(getComputedStyle(n).position)) return 0
      }
      return window.__vfx.scrollTo(el, { inset, ms: 700, align: a })
    }, [handle, INSET, align || null])
    await sleep(150)
    return loc.boundingBox()
  }
  H.point = async (loc, { spot = true, align } = {}) => {
    const box = await H.reveal(loc, align)
    if (!box) throw new Error('point: the target has no box')
    const cx = box.x + box.width / 2
    const cy = Math.min(Math.max(box.y + box.height / 2, INSET.top), VIEWPORT.height - INSET.bottom)
    await page.evaluate(([x, y]) => window.__vfx.cursorTo(x, y), [cx, cy])
    if (spot) {
      const r = { x: Math.round(box.x - 6), y: Math.round(box.y - 6), w: Math.round(box.width + 12), h: Math.round(box.height + 12) }
      await page.evaluate((rect) => window.__vfx.spotlight([rect]), r)
    }
    await sleep(650)
  }
  H.clear = async () => {
    await page.evaluate(() => { if (window.__vfx) { window.__vfx.spotlight([]); window.__vfx.cursorHide() } }).catch(() => {})
  }
  // Point, ripple, then a real touch at the centre. Re-measured just before the touch and
  // refused when off-screen or covered: a touch outside the viewport is clamped into it and
  // lands on something else (docs/driver-video/README.md, clip 03).
  H.tap = async (loc, what) => {
    await H.clear()
    await H.reveal(loc)
    let box = await loc.boundingBox()
    if (!H.inViewport(box)) throw new Error(`tap ${what}: off the viewport (${box ? `y=${Math.round(box.y)}` : 'no box'})`)
    const x = Math.round(box.x + box.width / 2)
    const y = Math.round(box.y + box.height / 2)
    await page.evaluate(([px, py]) => window.__vfx.cursorTo(px, py), [x, y])
    await sleep(680)
    box = await loc.boundingBox()
    if (!H.inViewport(box) || Math.abs(box.x + box.width / 2 - x) > 3 || Math.abs(box.y + box.height / 2 - y) > 3) throw new Error(`tap ${what}: it moved before the touch`)
    // A toast can sit over the target for a moment; wait it out, never tap through it.
    let hits = false
    for (let i = 0; i < 8 && !hits; i++) {
      if (i) await sleep(500)
      hits = await loc.evaluate((el, [px, py]) => { const h = document.elementFromPoint(px, py); return !!h && (h === el || el.contains(h)) }, [x, y])
    }
    if (!hits) throw new Error(`tap ${what}: something covers its centre`)
    await page.evaluate(() => window.__vfx.cursorTap())
    await page.touchscreen.tap(x, y)
    await sleep(420)
    await page.evaluate(() => { if (window.__vfx) window.__vfx.cursorClear() }).catch(() => {})
    check()
  }
  H.type = async (loc, text, what, delay = 90) => {
    await H.tap(loc, what)
    await loc.pressSequentially(text, { delay })
    check()
  }
  // A wait whose partner step failed must not become an unhandled rejection (Node would exit
  // before the run's notes are written); the caller still sees the rejection when it awaits.
  const quiet = (p) => { p.catch(() => {}); return p }
  H.response = (pathname, method) => quiet(page.waitForResponse((r) => {
    try { return new URL(r.url()).pathname === pathname && r.request().method() === method } catch { return false }
  }, { timeout: 30000 }))
  H.fileChooser = () => quiet(page.waitForEvent('filechooser', { timeout: 10000 }))
  H.appReady = async () => {
    await page.locator('.driver-app').waitFor({ state: 'visible', timeout: 45000 })
    await page.locator('.load-sub-tabs').waitFor({ state: 'visible', timeout: 45000 })
    await page.locator('.loading-skeletons').waitFor({ state: 'detached', timeout: 45000 }).catch(() => {})
    await H.fx()
  }
  // Unfilmed: signed in as the walkthrough driver, on the driver app. Already there, the app is
  // left on whatever the last chapter showed: a load page or another tab has no Loads list.
  H.signedIn = async () => {
    if (!page.url().startsWith(base.origin)) await H.goto('/driver')
    const s = await H.api('GET', '/api/auth/session')
    if (s.json && s.json.authenticated && s.json.user && s.json.user.username === DEMO.driver.username) {
      if (!new URL(page.url()).pathname.startsWith('/driver')) {
        await H.goto('/driver')
        await H.appReady()
        return
      }
      await page.locator('.driver-app').waitFor({ state: 'visible', timeout: 45000 })
      await H.fx()
      return
    }
    await H.goto('/login')
    const form = page.locator('form.login-form')
    await form.waitFor({ state: 'visible', timeout: 30000 })
    await form.locator('input[autocomplete="username"]').fill(DEMO.driver.username)
    await form.locator('input[autocomplete="current-password"]').fill(secret)
    const [resp] = await Promise.all([H.response('/api/auth/login', 'POST'), form.locator('button[type="submit"]').click()])
    if (resp.status() !== 200) throw new Error(`the driver sign-in answered ${resp.status()}`)
    await page.waitForURL((u) => u.pathname.startsWith('/driver'), { timeout: 45000 })
    await H.appReady()
  }
  H.tab = (label) => page.locator('.van-tabbar-item', { hasText: label })
  H.subTab = (label) => page.locator('.load-sub-tabs .sub-tab', { hasText: label })
  H.card = (id) => page.locator('.load-card', { has: page.locator('.load-id', { hasText: id }) })
  H.section = (title) => page.locator('.van-collapse-item', { has: page.locator('.van-collapse-item__title', { hasText: title }) })
  H.sectionTitle = (title) => page.locator('.van-collapse-item__title', { hasText: title })
  H.isOpen = async (title) => (await H.sectionTitle(title).getAttribute('aria-expanded').catch(() => null)) === 'true'
  // Unfilmed: the Loads list (not a load page), on the named sub-tab. The Loads tab reopens the
  // load page that was open when the driver left it, so Back may be needed after the tab.
  H.loadsList = async (sub) => {
    const shown = (sel) => page.locator(sel).isVisible().catch(() => false)
    if (!(await shown('.load-sub-tabs')) && !(await shown('.load-detail'))) {
      await H.tab('Loads').click()
      for (let i = 0; i < 40 && !(await shown('.load-sub-tabs')) && !(await shown('.load-detail')); i++) await sleep(250)
    }
    if (await shown('.load-detail')) await page.locator('.detail-topbar .van-button').click()
    await page.locator('.load-sub-tabs').waitFor({ state: 'visible' })
    if (sub) await H.subTab(sub).click()
    await page.evaluate(() => window.scrollTo(0, 0))
    await H.fx()
  }
  // Unfilmed: the load page of `id` open, the Route Map shut. A load page always opens with the
  // map open, and with no Maps key on the e2e server it is an empty state (never filmed).
  H.loadPage = async (id, sub = 'Active') => {
    const open = await page.locator('.detail-topbar .topbar-title', { hasText: id }).isVisible().catch(() => false)
    if (!open) {
      await H.loadsList(sub)
      await H.card(id).click()
      await page.locator('.detail-topbar .topbar-title', { hasText: id }).waitFor({ state: 'visible' })
    }
    if (await H.isOpen('Route Map')) await H.sectionTitle('Route Map').click()
    // Hidden only once the collapse animation has ended, so no frame catches it half shut.
    await H.section('Route Map').locator('.van-collapse-item__wrapper').first().waitFor({ state: 'hidden', timeout: 5000 })
    await page.evaluate(() => window.scrollTo(0, 0))
    await H.fx()
  }
  H.mapShut = async (where) => {
    const body = await H.section('Route Map').locator('.van-collapse-item__wrapper').first().isVisible()
    if (body || (await H.isOpen('Route Map'))) throw new Error(`${where}: the Route Map is open on camera`)
  }
  H.driverLoad = async (id) => {
    const r = await H.api('GET', `/api/driver/${encodeURIComponent(DEMO.driver.name)}`)
    if (r.status !== 200 || !r.json) throw new Error(`GET /api/driver answered ${r.status}`)
    const col = (r.json.headers.jobTracking || []).find((h) => /load.?id|job.?id/i.test(h))
    const st = (r.json.headers.jobTracking || []).find((h) => /status/i.test(h))
    const load = (r.json.loads || []).find((l) => l[col] === id)
    return load ? { status: String(load[st] || '').trim(), podCount: load._podCount || 0 } : null
  }
  H.needs = async (id, status, why, extra) => {
    const l = await H.driverLoad(id)
    if (!l || l.status !== status || (extra && !extra(l))) {
      throw new Precondition(`${why}: load ${id} is ${l ? `"${l.status}" with ${l.podCount} POD(s)` : 'missing'}. ` +
        'The run script makes a fresh database each time; with --only, list the chapters before it too')
    }
  }
  return H
}

// ---------------------------------------------------------------- setups (unfilmed) and takes
const LOAD = Object.fromEntries(DEMO.loads.map((l) => [l.key, l.id]))
const startOnLoads = async (H) => { await H.signedIn(); await H.loadsList('Active'); await H.clear() }
const stayPut = async (H) => { await H.signedIn(); await H.clear() }

const SETUP = {
  title: async (H) => { await H.page.setContent(cardHtml(CARDS.title)); await sleep(300) },
  signin: async (H) => {
    await H.goto('/login')
    if (new URL(H.page.url()).pathname !== '/login') throw new Precondition('chapter signin needs a signed-out browser, and /login moved on')
    await H.page.locator('form.login-form').waitFor({ state: 'visible', timeout: 30000 })
    await H.fx()
  },
  loads: startOnLoads,
  accept: async (H) => { await H.signedIn(); await H.needs(LOAD.pending, 'Dispatched', 'chapter accept films the Accept tap'); await H.loadsList('Historical'); await H.clear() },
  // The page is opened here, off camera: the tap that opens it would film the empty Route Map.
  loadpage: async (H) => {
    await H.signedIn()
    await H.needs(LOAD.active, 'In Transit', 'chapter loadpage films the In Transit load that chapter status starts from')
    await H.loadPage(LOAD.active)
    await H.page.locator('.status-stepper-wrapper').waitFor({ state: 'visible' })
    // Chapter accept's "Load accepted" would otherwise sit over another load's page.
    await H.page.locator('.toast.show').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})
    await sleep(400)
    await H.mapShut('chapter loadpage, before filming')
    await H.clear()
  },
  status: async (H) => {
    await H.signedIn()
    await H.needs(LOAD.active, 'In Transit', 'chapter status films the Arrived at Receiver tap')
    await H.loadPage(LOAD.active)
    await H.clear()
  },
  pod: async (H) => {
    await H.signedIn()
    await H.needs(LOAD.active, 'At Receiver', 'chapter pod starts where chapter status ends (At Receiver, no POD)', (l) => l.podCount === 0)
    await H.loadPage(LOAD.active)
    await H.clear()
  },
  receipts: async (H) => { await H.signedIn(); await H.loadPage(LOAD.active); await H.clear() },
  // Each opens with a bottom-tab tap, so it starts where the last chapter ended. A re-run of the
  // later chapters (--only) then never films a Loads list that differs from the first take's.
  messages: stayPut,
  kit: stayPut,
  invoice: stayPut,
  wrapup: async (H) => { await H.page.setContent(cardHtml(CARDS.outro)); await sleep(300) },
}

const TAKES = {
  title: async (H, beat) => { await beat('card') },

  signin: async (H, beat) => {
    const { page } = H
    const form = page.locator('form.login-form')
    const user = form.locator('input[autocomplete="username"]')
    const pass = form.locator('input#login-password')
    await beat('open', () => H.point(form))
    await beat('username', () => H.type(user, DEMO.driver.username, 'the username field'))
    await beat('password', async () => {
      if ((await pass.getAttribute('type')) !== 'password') throw new Error('the password field is not masked; nothing typed')
      await H.type(pass, secret, 'the password field', 70)
      if ((await pass.getAttribute('type')) !== 'password') throw new Error('the password field stopped being masked')
    })
    await beat('tap', async () => {
      const [resp] = await Promise.all([H.response('/api/auth/login', 'POST'), H.tap(form.locator('button[type="submit"]'), 'Sign In')])
      if (resp.status() !== 200) throw new Error(`sign-in answered ${resp.status()}`)
      await page.waitForURL((u) => u.pathname.startsWith('/driver'), { timeout: 45000 })
      await H.appReady()
    })
    await beat('help', () => H.clear())
  },

  loads: async (H, beat) => {
    await beat('tabs', () => H.point(H.page.locator('.load-sub-tabs')))
    await beat('active', async () => { await H.tap(H.subTab('Active'), 'Active'); await H.point(H.card(LOAD.active)) })
    await beat('pending', async () => { await H.tap(H.subTab('Pending'), 'Pending'); await H.point(H.card(LOAD.pending)) })
    await beat('historical', async () => { await H.tap(H.subTab('Historical'), 'Historical'); await H.point(H.card(LOAD.delivered)) })
  },

  accept: async (H, beat) => {
    const card = H.card(LOAD.pending)
    await beat('card', async () => { await H.tap(H.subTab('Pending'), 'Pending'); await H.point(card) })
    await beat('buttons', () => H.point(card.locator('.card-actions')))
    await beat('accept', async () => {
      const [resp] = await Promise.all([H.response('/api/driver/respond', 'POST'), H.tap(card.locator('.action-btn.accept'), 'Accept')])
      if (resp.status() !== 200) throw new Error(`accept answered ${resp.status()}`)
      await H.page.locator('.load-sub-tabs .sub-tab.active', { hasText: 'Active' }).waitFor({ state: 'visible' })
      await H.card(LOAD.pending).waitFor({ state: 'visible' })
      await H.point(H.card(LOAD.pending))
    })
  },

  loadpage: async (H, beat) => {
    const { page } = H
    await beat('open', () => H.point(page.locator('.detail-topbar')))
    // Shut, then open again: real content both ways, and the page is left as it started.
    await beat('sections', async () => {
      const title = H.sectionTitle('Update Status')
      const body = H.section('Update Status').locator('.van-collapse-item__wrapper').first()
      await H.tap(title, 'Update Status')
      await body.waitFor({ state: 'hidden', timeout: 5000 })
      await sleep(900)
      await H.tap(title, 'Update Status')
      await page.locator('.status-stepper-wrapper').waitFor({ state: 'visible' })
      if (!(await H.isOpen('Update Status'))) throw new Error('Update Status did not open again')
      await H.mapShut('beat sections')
    })
    await beat('pickup', async () => {
      await H.tap(H.sectionTitle('Pickup Details'), 'Pickup Details')
      await sleep(450)
      await H.point(H.section('Pickup Details').locator('.van-collapse-item__content'), { align: 'top' })
    })
    await beat('times', () => H.point(H.section('Pickup Details').locator('.van-cell', { hasText: 'Appointment' })))
    await beat('dropoff', async () => {
      await H.tap(H.sectionTitle('Drop-off Details'), 'Drop-off Details')
      await sleep(450)
      await H.point(H.section('Drop-off Details').locator('.van-collapse-item__content'), { align: 'top' })
      await H.mapShut('the end of chapter loadpage')
    })
  },

  status: async (H, beat) => {
    const { page } = H
    const stepper = page.locator('.status-stepper-wrapper')
    const next = stepper.locator('.action-btn.primary')
    await beat('stepper', () => H.point(stepper.locator('.stepper')))
    await beat('eld')
    await beat('phone')
    await beat('fallback', async () => {
      if ((await next.innerText()).trim() !== 'Arrived at Receiver') throw new Error(`the next-step button reads "${(await next.innerText()).trim()}"`)
      await H.point(next)
    })
    await beat('confirm', async () => {
      await H.tap(next, 'Arrived at Receiver')
      const dialog = page.locator('.confirm-dialog', { hasText: 'Update Status' })
      await dialog.waitFor({ state: 'visible' })
      await sleep(600)
      const [resp] = await Promise.all([H.response('/api/driver/status', 'PUT'), H.tap(dialog.locator('.btn-primary'), 'Confirm')])
      if (resp.status() !== 200) throw new Error(`the status update answered ${resp.status()}`)
    })
    await beat('pod', async ({ minMs, until }) => {
      const reminder = page.locator('.confirm-dialog', { hasText: 'Upload Proof of Delivery' })
      await reminder.waitFor({ state: 'visible', timeout: 10000 })
      await H.point(reminder, { spot: false })
      await until(minMs - 2400)
      await H.tap(reminder.locator('.btn-primary'), 'Got it')
      await stepper.locator('.upload-hint').waitFor({ state: 'visible' })
      await H.point(stepper.locator('.upload-hint'))
    })
  },

  pod: async (H, beat, { props }) => {
    const { page } = H
    const upload = page.locator('.doc-upload')
    await beat('open', async () => {
      await H.tap(H.sectionTitle('Documents'), 'Documents')
      await sleep(450)
      await H.reveal(upload, 'top')
    })
    await beat('type', async () => {
      if ((await upload.locator('select.type-select').inputValue()) !== 'POD') throw new Error('the document type is not Proof of Delivery')
      await H.point(upload.locator('select.type-select'))
    })
    await beat('photo', async ({ minMs, until }) => {
      await H.point(upload.locator('.upload-buttons'))
      await until(minMs - 2600)
      const [chooser] = await Promise.all([
        H.fileChooser(),
        H.tap(upload.locator('.upload-buttons label.photo-btn', { hasText: 'Upload File' }), 'Upload File'),
      ])
      await chooser.setFiles(props.pod)
      await upload.locator('.photo-grid .photo-thumb img').first().waitFor({ state: 'visible', timeout: 20000 })
    })
    await beat('upload', async () => {
      const btn = upload.locator('button.btn.btn-primary')
      const [resp] = await Promise.all([H.response('/api/documents/upload', 'POST'), H.tap(btn, 'Upload POD')])
      if (resp.status() !== 200) throw new Error(`the POD upload answered ${resp.status()}`)
    })
    await beat('delivered', async () => {
      const done = page.locator('.status-stepper-wrapper .action-btn.primary', { hasText: /^\s*Delivered\s*$/ })
      await done.waitFor({ state: 'visible', timeout: 30000 })
      await H.point(done)
    })
  },

  receipts: async (H, beat, { props }) => {
    const { page } = H
    const form = page.locator('.expense-form')
    const field = (label) => form.locator('.van-field', { has: page.locator('.van-field__label', { hasText: label }) }).locator('input').first()
    await beat('open', async () => {
      await H.tap(H.sectionTitle('Expenses'), 'Expenses')
      await sleep(450)
      await form.waitFor({ state: 'visible' })
      await H.point(form.locator('.form-title'), { align: 'top' })
    })
    await beat('photo', async () => {
      const [chooser] = await Promise.all([
        H.fileChooser(),
        H.tap(form.locator('.receipt-pick-btn', { hasText: 'Choose from gallery' }), 'Choose from gallery'),
      ])
      await chooser.setFiles(props.receipt)
      await form.locator('.receipt-photo .van-uploader__preview').first().waitFor({ state: 'visible', timeout: 20000 })
      await H.point(form.locator('.receipt-photo'))
    })
    await beat('amount', async () => {
      await H.type(field('Amount'), DEMO.expense.amount, 'Amount')
      await H.type(field('Gallons'), DEMO.expense.gallons, 'Gallons')
      await H.type(field('Vendor'), DEMO.expense.vendor, 'Vendor', 70)
    })
    await beat('submit', async () => {
      // Submit is held while the receipt is read (with no OCR key the read answers 503 at once).
      await form.locator('.ocr-status-loading').waitFor({ state: 'detached', timeout: 45000 })
      const [resp] = await Promise.all([H.response('/api/expenses', 'POST'), H.tap(form.locator('button[type="submit"]'), 'Submit Expense')])
      if (resp.status() !== 200) throw new Error(`the expense answered ${resp.status()}`)
      await page.locator('.expense-history').waitFor({ state: 'visible', timeout: 30000 })
    })
    await beat('window', () => H.point(page.locator('.expense-history')))
  },

  messages: async (H, beat) => {
    const { page } = H
    await beat('alerts', async () => {
      await H.tap(H.tab('Alerts'), 'Alerts')
      await page.locator('.notification-list .notif-group').waitFor({ state: 'visible' })
      await H.point(page.locator('.notification-list .notif-group'))
    })
    await beat('messages', async () => {
      await H.tap(H.tab('Messages'), 'Messages')
      await page.locator('.chat-container .msg-bubble').first().waitFor({ state: 'visible' })
      await H.point(page.locator('.chat-container .chat-messages'), { spot: false })
    })
    await beat('send', async () => {
      await H.type(page.locator('.chat-input'), DEMO.typedMessage, 'the message box', 70)
      const [resp] = await Promise.all([H.response('/api/messages', 'POST'), H.tap(page.locator('.send-btn'), 'send')])
      if (resp.status() !== 200) throw new Error(`the message answered ${resp.status()}`)
      await page.locator('.chat-container .msg-bubble.sent', { hasText: DEMO.typedMessage }).waitFor({ state: 'visible' })
    })
  },

  kit: async (H, beat) => {
    const { page } = H
    await beat('open', async () => {
      await H.tap(H.tab('Kit'), 'Kit')
      await page.locator('.kit-header').waitFor({ state: 'visible' })
      await H.point(page.locator('.kit-header'))
    })
    await beat('docs', async ({ minMs, until }) => {
      const stops = [
        page.locator('.kit-truck-docs'),
        page.locator('.kit-files-card', { hasText: 'My Identity Documents' }),
        page.locator('.kit-files-card', { hasText: 'Signed Contracts' }),
      ]
      for (const [i, loc] of stops.entries()) {
        await H.point(loc, { align: 'top' })
        await until(((i + 1) * minMs) / stops.length - 200)
      }
    })
  },

  invoice: async (H, beat) => {
    const { page } = H
    await beat('open', async () => {
      await H.tap(H.tab('Invoices'), 'Invoices')
      await page.locator('.invoice-tab').waitFor({ state: 'visible' })
    })
    await beat('week', () => H.point(page.locator('.invoice-tab .week-picker')))
    await beat('generate', () => H.point(page.locator('.invoice-tab .generate-btn')))
    await beat('history', async ({ minMs, until }) => {
      const card = page.locator('.invoice-card', { hasText: DEMO.invoice.number })
      await H.point(card)
      await until(minMs * 0.4)
      await H.tap(card, `invoice ${DEMO.invoice.number}`)
      const sheet = page.locator('.action-sheet')
      await sheet.waitFor({ state: 'visible' })
      // Pointed at, never tapped: the PDF is not opened.
      await H.point(sheet.locator('a.action-btn', { hasText: 'View PDF' }))
      await until(minMs - 900)
      await H.clear()
      const overlay = page.locator('.van-overlay').last()
      const hit = await overlay.evaluate((el) => { const h = document.elementFromPoint(195, 120); return !!h && (h === el || el.contains(h)) }).catch(() => false)
      if (hit) await H.page.touchscreen.tap(195, 120)
      await sheet.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
    })
  },

  wrapup: async (H, beat) => { await beat('card') },
}

// --------------------------------------------------------------------------------- main
async function main() {
  lintOrDie()
  if (args.dry) {
    const { rows, totalMs } = cap.estimate(CHAPTERS)
    for (const r of rows) console.log(`walkthrough: ${pad2(r.n)} ${r.id.padEnd(9)} ${(r.minMs / 1000).toFixed(1).padStart(5)} s  ${r.title}`)
    console.log(`walkthrough: at least ${(totalMs / 1000).toFixed(1)} s from the captions alone (taps and page loads can only lengthen a beat); cap 300 s`)
    console.log(`walkthrough: storyboard lint: no problems (${CHAPTERS.reduce((s, c) => s + c.beats.filter((b) => b.say).length, 0)} captioned beats)`)
    return 0
  }
  const out = checkOut(args.out)
  if (args['captions-only']) { writeCaptions(out); return 0 }
  if (args['encode-only']) { encode(out); return 0 }
  if (!args.base) die(2, '--base is required to record (the e2e server, e.g. --base=http://127.0.0.1:3192)')
  const base = checkBase(args.base)
  const selected = selectedChapters()
  say(`recording ${selected.length === CHAPTERS.length ? 'every chapter' : `chapter(s) ${selected.map((c) => c.id).join(', ')}`} from ${base.origin} into ${out}`)
  const code = await record(out, selected, base)
  if (code !== 0) return code
  if (args['no-encode']) { say('recorded; --no-encode, so nothing was encoded'); return 0 }
  const have = new Set(readTimeline(out).chapters.map((c) => c.id))
  const lacking = CHAPTERS.filter((c) => !have.has(c.id)).map((c) => c.id)
  if (lacking.length) { say(`recorded; not encoded until every chapter is (still to record: ${lacking.join(', ')})`); return 0 }
  encode(out)
  return 0
}

main().then((code) => process.exit(code), (e) => die(1, `stopped: ${firstLine(e)}`))
