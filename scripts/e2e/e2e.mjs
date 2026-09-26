#!/usr/bin/env node
// LogisX — truck-fixes end-to-end QA run, driven through the REAL UI with Playwright.
//
// Covers three fixes:
//   1. Truck photos (and drivers' CDL / medical-card files) are stored and served
//      only as what their bytes prove they are.
//   2. Truck cost fields refuse non-finite amounts ("Infinity", 1e999, negatives,
//      > 1,000,000) with 400 INVALID_AMOUNT.
//   3. Cost edits write an `update_truck_costs` audit line.
// Round 2 (steps R1-R9, the #393 follow-ups; every step above stays as a regression check):
//   R1 Edit Truck survives a list refresh  · R2 a refused save keeps the input
//   R3 CDL/medical PDFs are served as attachment; images stay inline (planted)
//   R4 stored photos are normalized to what their bytes are · R5 photo limits 16 MP / 2 MiB
//   R6 admin fee 0-100 (blank = 50) · R7 fuel tank <= 500 gal, avg MPG <= 20 (API + Edit form)
//   R8 an Investor's add ignores the fuel pair · R9 the create_truck audit names tank + MPG
// Sign-out / sign-in section (S1-S3; runnable alone with ONLY=signout):
//   S1 sign-out (the sidebar's, the driver app's) ends with a full page load of /login
//   S2 a DIFFERENT person signing in after an expired session gets a full page load
//      of their home; the SAME person again keeps in-app navigation (the control)
//   S3 the visible residue: the Dispatcher's dashboard while its own fetch is in flight
//
// Env:
//   BASE_URL    required — e.g. http://127.0.0.1:3181 (never production)
//   PHASE       before | after            (default: before) — names the output
//   HEADED=1    visible browser, slowMo 350 ms, ~1400x900 window, captions pause
//   DB_PATH     the server's database copy (inside the work dir), ONLY used to plant
//               stored values for the serve-side cases (steps 10, 11b-f, R3).
//               Unset -> those cases are SKIPPED.
//   CREDS_FILE  logins JSON (default: <work dir>/creds.json, written by setup-db.cjs)
//   E2E_WORK_DIR  where every output goes (default: $TMPDIR/logisx-e2e; see paths.cjs)
//   APP_DIR     checkout whose node_modules provides better-sqlite3 and puppeteer
//               (default: this checkout once it has installs, else the main checkout)
//   CHROME_PATH Chrome binary (default: the Chrome for Testing the app's puppeteer downloaded)
//   EXTRA=1     also run X1 (pre-existing Edit-modal bug, outside the three fixes)
//   MASK_PII=0  do not mask identity documents in SAVED screenshots (default: masked)
//   SLOWMO, CAPTION_PAUSE_MS   pacing overrides (headed defaults 350 / 1600)
//   OUT_TAG     output name instead of PHASE (rehearsals must not overwrite a baseline)
//   DRIVER_VIEWPORT            driver window size, default 430x900
//   ONLY        signout = only the sign-out section (S1-S3) · trucks = only the truck
//               steps (1-12, R1-R11) · unset = both
//   S3_LATENCY_MS, S3_KBPS     S3's CDP throttle (default +2500 ms per request, 24 KB/s)
//
// Output, in the work dir (outside every checkout — the screenshots show real data):
// shots/<OUT_TAG|PHASE>/NN-name.png and results-<OUT_TAG|PHASE>.md.
// See README.md beside this script for setup, boot and teardown.
// Every "Expected" column states the behaviour AFTER the fixes; a BEFORE run is
// expected to FAIL the fix rows — that is the baseline.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import paths from './paths.cjs'

const BASE_URL = String(process.env.BASE_URL || '').replace(/\/+$/, '')
const PHASE = String(process.env.PHASE || 'before').toLowerCase()
const HEADED = process.env.HEADED === '1'
// OUT_TAG renames the output (shots/<tag>/, results-<tag>.md) without changing
// the phase semantics — e.g. a timing rehearsal that must not overwrite a baseline.
const OUT_TAG = String(process.env.OUT_TAG || PHASE).replace(/[^\w.-]/g, '')
const PAUSE = Number(process.env.CAPTION_PAUSE_MS ?? (HEADED ? 1600 : 0))
const SLOWMO = Number(process.env.SLOWMO ?? (HEADED ? 350 : 0))
const [DVW, DVH] = String(process.env.DRIVER_VIEWPORT || '430x900').split('x').map(Number)
// ONLY=signout runs just the sign-out section; ONLY=trucks just the truck steps.
const ONLY = String(process.env.ONLY || '').toLowerCase()

function die(msg) { console.error(`e2e: ${msg}`); process.exit(2) }
if (!BASE_URL) die('BASE_URL is required')
if (!['before', 'after'].includes(PHASE)) die('PHASE must be before or after')
if (!['', 'signout', 'trucks'].includes(ONLY)) die('ONLY must be signout, trucks or unset')
let baseHost = ''
try { baseHost = new URL(BASE_URL).hostname.replace(/\.+$/, '') } catch { die(`BASE_URL is not a URL: ${BASE_URL}`) }
if (/(^|\.)app\.logisx\.com$/i.test(baseHost)) die('refusing to run against production')

let WORK, DB_PATH, CHROME
try {
  WORK = paths.workDir()
  DB_PATH = process.env.DB_PATH ? paths.workFile(process.env.DB_PATH) : ''
  CHROME = await paths.chromePath()
} catch (e) { die(e.message) }
if (DB_PATH) paths.warnNodeVersion('e2e')
const CREDS_FILE = process.env.CREDS_FILE || path.join(WORK, 'creds.json')
const SHOTS = path.join(WORK, 'shots', OUT_TAG)
const RESULTS = path.join(WORK, `results-${OUT_TAG}.md`)
const JOURNAL = path.join(WORK, 'plant-journal.json')
if (fs.existsSync(JOURNAL)) {
  die(`${JOURNAL} exists: a previous run died while a planted value was in the DB. ` +
    'Recreate the scratch DB (node scripts/e2e/setup-db.cjs <db> --force), then delete the journal.')
}
if (!fs.existsSync(CREDS_FILE)) die(`no creds file at ${CREDS_FILE} (make one with scripts/e2e/setup-db.cjs, or set CREDS_FILE)`)
const CREDS = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'))
fs.mkdirSync(SHOTS, { recursive: true })
for (const f of fs.readdirSync(SHOTS)) if (f.endsWith('.png')) fs.unlinkSync(path.join(SHOTS, f))

// ---------------------------------------------------------------- results
const rows = []
const meta = { startedAt: new Date().toISOString(), baseUrl: BASE_URL, phase: PHASE, headed: HEADED, ids: {} }
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
function writeResults(final = false) {
  const counts = rows.reduce((a, r) => { const k = r.verdict.split(' ')[0]; a[k] = (a[k] || 0) + 1; return a }, {})
  const title = ONLY === 'signout'
    ? 'Sign-out / sign-in E2E (S1-S3)'
    : `Truck fixes E2E (round 2: steps 1-12 regression + R1-R9)${ONLY === 'trucks' ? '' : ' + sign-out section (S1-S3)'}`
  const lines = [
    `# ${title} — ${PHASE.toUpperCase()}`,
    '',
    `- Base URL: \`${BASE_URL}\``,
    `- Started: ${meta.startedAt}${final ? ` · finished ${new Date().toISOString()}` : ' · (in progress)'}`,
    `- Browser: Chrome for Testing via playwright-core, ${HEADED ? 'headed' : 'headless'}, slowMo ${SLOWMO} ms, caption pause ${PAUSE} ms`,
    `- Discovered ids: ${Object.entries(meta.ids).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`,
    `- Verdicts are judged against the AFTER-the-fix expectation. Totals: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
    '',
    '| Step | What | Expected (after the fix) | Observed | Verdict | Screenshot |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${cell(r.step)} | ${cell(r.title)} | ${cell(r.expected)} | ${cell(r.observed)} | ${cell(r.verdict)} | ${r.shot ? `[${cell(path.basename(r.shot))}](${cell(r.shot)})` : ''} |`),
    '',
  ]
  fs.writeFileSync(RESULTS, lines.join('\n'))
}
function record(r) {
  rows.push(r)
  console.log(`[${r.verdict.padEnd(4)}] ${r.step} ${r.title} — ${String(r.observed).replace(/\n/g, ' ')}`)
  writeResults()
}
const verdict = (ok) => (ok ? 'PASS' : 'FAIL')

// ---------------------------------------------------------------- fixtures
const b64 = (s) => Buffer.from(s).toString('base64')
const HTML_DOC = '<h1>not an image</h1>'
const SVG_DOC = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><text x="10" y="38" font-size="24">not a photo</text></svg>'

function makePdf() {
  // Minimal, valid one-page PDF (correct xref offsets), inert text only.
  const content = 'BT /F1 18 Tf 20 45 Td (QA PDF) Tj ET'
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
const PDF_BYTES = makePdf()

// PNG chunk CRC (IEEE), so the fixtures below are well-formed PNGs.
function crc32(buf) {
  let crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
// R5b: a minimal PNG (signature + IHDR + IEND, no pixel data) whose IHDR
// declares w×h. Its header is all a size check reads.
function makePngHeader(w, h) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit truecolour; compression/filter/interlace 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IEND', Buffer.alloc(0))])
}
// R5a: a JPEG with a valid header walk (SOI, APP0 JFIF, SOF0 w×h) padded with
// COM segments to at least `targetBytes`, then EOI. Small in pixels, large in bytes.
function makePaddedJpeg(targetBytes, w = 640, h = 480) {
  const parts = [
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  ]
  let size = parts.reduce((a, b) => a + b.length, 0)
  while (size < targetBytes) {
    const n = Math.min(65533, Math.max(1, targetBytes - size))
    const seg = Buffer.alloc(4 + n, 0x20)
    seg[0] = 0xff; seg[1] = 0xfe; seg.writeUInt16BE(n + 2, 2)
    parts.push(seg); size += seg.length
  }
  parts.push(Buffer.from([0xff, 0xd9]))
  return Buffer.concat(parts)
}

async function makeImages(ctx) {
  // Genuine JPEG / PNG bytes, encoded by the browser's own canvas.
  const p = await ctx.newPage()
  const out = await p.evaluate(() => {
    const draw = (label, a, b) => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 200
      const g = c.getContext('2d')
      const grd = g.createLinearGradient(0, 0, 320, 200); grd.addColorStop(0, a); grd.addColorStop(1, b)
      g.fillStyle = grd; g.fillRect(0, 0, 320, 200)
      g.fillStyle = '#fff'; g.font = 'bold 34px sans-serif'; g.fillText(label, 34, 112)
      return c
    }
    return {
      jpeg: draw('QA TRUCK JPG', '#7c3aed', '#06b6d4').toDataURL('image/jpeg', 0.9),
      png: draw('QA TRUCK PNG', '#0f766e', '#a21caf').toDataURL('image/png'),
    }
  })
  await p.close()
  return { jpeg: Buffer.from(out.jpeg.split(',')[1], 'base64'), png: Buffer.from(out.png.split(',')[1], 'base64') }
}

// ---------------------------------------------------------------- page helpers
// `pause` false: for a timing-critical moment (S3), where the headed pause would
// let the evidence finish before the screenshot.
async function caption(page, text, pause = true) {
  try {
    await page.evaluate((t) => {
      const id = '__qa_caption__'
      let el = document.getElementById(id)
      if (!el) {
        el = document.createElement('div')
        el.id = id
        // CSSOM, not a style attribute, so a strict style-src CSP cannot strip it.
        Object.assign(el.style, {
          position: 'fixed', left: '0', right: '0', top: '0', zIndex: '2147483647',
          background: 'rgba(12,12,20,0.93)', color: '#fff', padding: '8px 14px',
          font: '600 15px/1.4 -apple-system, system-ui, sans-serif',
          borderBottom: '3px solid #8b5cf6', pointerEvents: 'none', boxShadow: '0 2px 10px rgba(0,0,0,.35)',
        })
        ;(document.body || document.documentElement).appendChild(el)
      }
      el.textContent = t
      // A raw document (JSON viewer, an image, served HTML) has no SPA shell:
      // push its content below the bar so the evidence is not hidden under it.
      if (!document.getElementById('app') && document.body) document.body.style.paddingTop = `${el.offsetHeight + 6}px`
    }, `[${PHASE.toUpperCase()}] ${text}`)
  } catch { /* mid-navigation — best effort */ }
  if (PAUSE && pause) await page.waitForTimeout(PAUSE)
}

// MASK_PII (default on): identity documents are masked in the SAVED screenshot
// only — the live (headed) page still shows them, and the verdict comes from
// the network response + an in-page decode, not from pixels.
const MASK_PII = process.env.MASK_PII !== '0'
async function shot(page, name, opts = {}) {
  const file = path.join(SHOTS, `${name}.png`)
  const mask = MASK_PII && opts.mask ? opts.mask : undefined
  try { await page.screenshot({ path: file, fullPage: !!opts.fullPage, mask, maskColor: '#6b21a8' }) } catch (e) { console.log(`  (screenshot ${name} failed: ${e.message})`) }
  return path.relative(WORK, file)
}
async function centerOn(scope, selectors) {
  await scope.evaluate((root, sels) => {
    for (const s of sels) { const el = root.querySelector(s); if (el) { el.scrollIntoView({ block: 'center' }); return } }
  }, selectors).catch(() => {})
}

// fetch() from INSIDE the signed-in page (its cookies, its origin), with the
// header the CSRF rule requires on writes.
async function api(page, method, url, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, contentType: res.headers.get('content-type') || '', json, text: json ? '' : text.slice(0, 200) }
  }, { method, url, body })
}

// Navigate the tab itself to a URL and report what the browser received.
async function navigate(page, url) {
  let resp
  try {
    resp = await page.goto(`${BASE_URL}${url}`, { waitUntil: 'load' })
  } catch (e) {
    // Headless Chrome hands a PDF (or any attachment) to the download manager,
    // and goto() throws. Read what the server said with an in-page fetch instead.
    if (!/download is starting|ERR_ABORTED/i.test(e.message)) throw e
    const r = await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'same-origin' })
      return { status: res.status, ct: res.headers.get('content-type') || '' }
    }, url)
    return { status: r.status, contentType: r.ct, isJson: /json/i.test(r.ct), bodyHead: '', download: true }
  }
  let bodyHead = ''
  try { bodyHead = (await resp.text()).slice(0, 120) } catch { /* binary / unavailable */ }
  const ct = resp.headers()['content-type'] || ''
  return { status: resp.status(), contentType: ct, isJson: /json/i.test(ct), bodyHead }
}

// Click something that should start a download and return the Download (or
// null). A target=_blank link may start it from a new tab, so downloads from
// any page this context opens meanwhile count too; such tabs are closed again.
async function clickForDownload(ctx, page, locator, timeoutMs = 15000) {
  let resolveDl
  const got = new Promise((r) => { resolveDl = r })
  const popups = []
  const onDl = (d) => resolveDl(d)
  const onPage = (p) => { popups.push(p); p.on('download', onDl) }
  page.on('download', onDl)
  ctx.on('page', onPage)
  try {
    await locator.click()
    return await Promise.race([got, new Promise((r) => setTimeout(() => r(null), timeoutMs))])
  } finally {
    page.off('download', onDl)
    ctx.off('page', onPage)
    for (const p of popups) await p.close().catch(() => {})
  }
}

async function toastText(page, ms = 2500) {
  try {
    const t = page.locator('.toast-container .toast.show')
    await t.waitFor({ state: 'visible', timeout: ms })
    return (await t.innerText()).trim()
  } catch { return '' }
}

// Label → its input, in both the Add form (.form-group) and the Edit modal (.edit-field).
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const exactText = (s) => new RegExp(`^\\s*${escRe(s)}\\s*$`)
function field(scope, labelText) {
  return scope.locator('.form-group, .edit-field').filter({ has: scope.page().locator('label', { hasText: exactText(labelText) }) }).locator('input, select, textarea').first()
}
// A Trucks-table row by its EXACT unit number. `hasText` alone is a substring
// match, and the round-2 trucks (<UNIT>-B, <UNIT>-R9) contain the test unit.
function rowOf(page, unit) {
  return page.locator('table.truck-table tbody tr', { has: page.locator('td.unit-number', { hasText: exactText(unit) }) })
}

async function login(page, who, username, password, homePath) {
  await page.goto(`${BASE_URL}/login`)
  const form = page.locator('form.login-form')
  await form.waitFor({ state: 'visible', timeout: 30000 })
  await caption(page, `${who} signs in`)
  await form.locator('input[autocomplete="username"]').fill(username)
  await form.locator('input[autocomplete="current-password"]').fill(password)
  const [resp] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/login' && r.request().method() === 'POST', { timeout: 30000 }),
    form.locator('button[type="submit"]').click(),
  ])
  if (resp.status() !== 200) throw new Error(`${who} login answered ${resp.status()}`)
  await page.waitForURL((u) => u.pathname.startsWith(homePath), { timeout: 45000 })
}

async function getTruck(page, id) {
  const r = await api(page, 'GET', '/api/trucks')
  return (r.json?.trucks || []).find((t) => String(t.id) === String(id)) || null
}

const costsOf = (t) => t ? `ins=${t.InsuranceMonthly} eld=${t.EldMonthly} pay=${t.TruckPaymentMonthly} hvut=${t.HvutAnnual} irp=${t.IrpAnnual}` : '(truck missing)'
const photoHead = (t) => (t && typeof t.Photo === 'string' ? (t.Photo.slice(0, 30) + (t.Photo.length > 30 ? '…' : '')) : String(t?.Photo))

// ---------------------------------------------------------------- DB planting (scratch only)
let db = null
const skipWhy = () => (DB_PATH
  ? 'SKIPPED — DB_PATH is not the server\'s database (see 10*); nothing was planted'
  : 'SKIPPED — no DB_PATH (stored values cannot be planted against this server)')
const PLANT_COLUMNS ={ trucks: ['photo'], job_applications: ['cdl_front'] }
function openDb() {
  if (!DB_PATH) return null
  const Database = paths.appRequire('better-sqlite3')
  const d = new Database(DB_PATH, { fileMustExist: true })
  d.pragma('busy_timeout = 5000')
  return d
}
function readCol(table, col, id) {
  if (!PLANT_COLUMNS[table]?.includes(col)) throw new Error('column not allowed')
  return db.prepare(`SELECT ${col} AS v FROM ${table} WHERE id = ?`).get(id)?.v
}
function writeCol(table, col, id, value) {
  if (!PLANT_COLUMNS[table]?.includes(col)) throw new Error('column not allowed')
  const r = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(value, id)
  if (r.changes !== 1) throw new Error(`plant ${table}.${col}#${id}: ${r.changes} rows`)
}
// Originals live in memory only (no PII on disk); the journal holds ids, not values.
const originals = new Map()
function plant(table, col, id, value) {
  const key = `${table}.${col}#${id}`
  if (!originals.has(key)) {
    originals.set(key, { table, col, id, value: readCol(table, col, id) })
    fs.writeFileSync(JOURNAL, JSON.stringify([...originals.values()].map(({ table, col, id }) => ({ table, col, id })), null, 2))
  }
  writeCol(table, col, id, value)
}
function restoreAll() {
  const out = []
  for (const [key, o] of originals) {
    writeCol(o.table, o.col, o.id, o.value)
    out.push(`${key} ${readCol(o.table, o.col, o.id) === o.value ? 'restored' : 'RESTORE MISMATCH'}`)
    originals.delete(key)
  }
  if (!originals.size && fs.existsSync(JOURNAL)) fs.unlinkSync(JOURNAL)
  return out
}
process.on('SIGINT', () => { try { if (db) restoreAll() } catch { /* ignore */ } process.exit(130) })

// ---------------------------------------------------------------- the run
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
const UNIT = `QA-TEST-${stamp}`
const INV_UNIT = `QA-TEST-INV-${stamp}` // R8: the truck the Investor adds
const created = new Set() // every truck id this run created
let browser, adminCtx, driverCtx, investorCtx, admin, driver
let truckId = null
let settleTrucks = async () => {}

async function main() {
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: !HEADED,
    slowMo: SLOWMO,
    args: HEADED ? ['--window-size=1400,900'] : [],
  })
  // Two independent blocks: a failure in one is recorded and the other still runs.
  if (ONLY !== 'signout') {
    try { await truckSteps() } catch (e) {
      exitCode = 1
      record({ step: '!', title: 'Run aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
    }
  }
  if (ONLY !== 'trucks') {
    try { await signoutSection() } catch (e) {
      exitCode = 1
      record({ step: 'S!', title: 'Sign-out section aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
    }
  }
}

// Steps 1-12 and R1-R10, unchanged (they used to be the body of main()).
async function truckSteps() {
  db = openDb()
  adminCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  adminCtx.setDefaultTimeout(20000)
  const IMG = await makeImages(adminCtx)
  const JPEG_DATA = `data:image/jpeg;base64,${IMG.jpeg.toString('base64')}`
  const PNG_DATA = `data:image/png;base64,${IMG.png.toString('base64')}`
  const PLANTS = {
    html: { label: 'data:text/html + <h1>not an image</h1>', value: `data:text/html;base64,${b64(HTML_DOC)}` },
    svg: { label: 'data:image/svg+xml + <svg><text>', value: `data:image/svg+xml;base64,${b64(SVG_DOC)}` },
    htmlAsJpeg: { label: 'HTML bytes under a data:image/jpeg label', value: `data:image/jpeg;base64,${b64(HTML_DOC)}` },
    pngAsJpeg: { label: 'real PNG bytes under a data:image/jpeg label', value: `data:image/jpeg;base64,${IMG.png.toString('base64')}` },
    malformed: { label: 'malformed value, no comma', value: `data:image/jpeg;base64${IMG.png.toString('base64').slice(0, 48)}` },
    pdf: { label: 'real PDF bytes under data:application/pdf', value: `data:application/pdf;base64,${PDF_BYTES.toString('base64')}` },
  }

  admin = await adminCtx.newPage()
  // Track the Trucks page's own GET /api/trucks reloads. TrucksView swaps the
  // whole TruckTable for a skeleton while the store loads, which UNMOUNTS the
  // teleported Edit modal — and a reload fires after every truck write (the
  // store's own, plus the debounced `trucks:changed` socket refresh). So before
  // opening the modal we wait until that traffic has been quiet for a while.
  let trucksInflight = 0
  let trucksLastActivity = 0
  const isTrucksGet = (r) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/trucks'
  admin.on('request', (r) => { if (isTrucksGet(r)) { trucksInflight++; trucksLastActivity = Date.now() } })
  const done = (r) => { if (isTrucksGet(r)) { trucksInflight = Math.max(0, trucksInflight - 1); trucksLastActivity = Date.now() } }
  admin.on('requestfinished', done)
  admin.on('requestfailed', done)
  settleTrucks = async (quietMs = 1500, timeoutMs = 30000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (trucksInflight === 0 && Date.now() - trucksLastActivity >= quietMs) return
      await admin.waitForTimeout(100)
    }
  }

  // ============ Step 1 — Super Admin logs in
  {
    let observed; let ok = false; let s
    try {
      await login(admin, 'Step 1 — Super Admin', CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
      await admin.locator('a[href="/trucks"]').first().waitFor({ state: 'visible', timeout: 30000 })
      await admin.waitForTimeout(2500) // let the dashboard's first data land for the screenshot
      await caption(admin, 'Step 1 — Super Admin signed in → the dashboard loads')
      ok = new URL(admin.url()).pathname.startsWith('/dashboard')
      observed = `landed on ${new URL(admin.url()).pathname}`
    } catch (e) { observed = `error: ${e.message}` }
    s = await shot(admin, '01-superadmin-dashboard')
    record({ step: '1', title: 'Super Admin logs in', expected: 'Dashboard renders', observed, verdict: verdict(ok), shot: s })
    if (!ok) throw new Error('cannot continue without the Super Admin session')
  }

  // Clean leftovers from an earlier aborted run (our own naming only).
  {
    const r = await api(admin, 'GET', '/api/trucks')
    for (const t of (r.json?.trucks || []).filter((t) => /^QA-TEST-/.test(t.UnitNumber || ''))) {
      const d = await api(admin, 'DELETE', `/api/trucks/${t.id}`)
      console.log(`  pre-clean: leftover ${t.UnitNumber} (#${t.id}) -> ${d.status}`)
    }
  }

  async function openTrucks() {
    const link = admin.locator('a[href="/trucks"]').first()
    if (await link.isVisible().catch(() => false)) await link.click()
    else await admin.goto(`${BASE_URL}/trucks`)
    await admin.waitForURL((u) => u.pathname === '/trucks')
    await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
  }
  async function openAddForm() {
    const det = admin.locator('details.form-accordion')
    await det.waitFor({ state: 'visible' })
    if (!(await det.evaluate((d) => d.open))) await det.locator('summary.form-toggle').click()
    await det.locator('input.fdz-file').waitFor({ state: 'attached' })
    return det
  }
  async function waitPhotoSettled(scope) {
    await admin.waitForTimeout(300)
    await admin.waitForFunction((root) => !root.querySelector('.fdz-zone.is-busy'), await scope.elementHandle(), { timeout: 20000 })
    await admin.waitForTimeout(500)
    return scope.evaluate(async (root) => {
      const img = root.querySelector('img[alt*="preview" i]')
      if (img && !img.complete) await new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 3000) })
      const text = root.innerText || ''
      const msgs = [...root.querySelectorAll('.error-msg, .fdz-msg, [role="alert"], .field-hint')]
        .map((e) => (e.innerText || '').trim().replace(/\s*Dismiss$/, ''))
        .filter((t) => t && /(couldn|could not|can.?t|isn.?t|not a|unsupported|use a|refus|invalid)/i.test(t))
      return {
        messages: [...new Set(msgs)],
        expectedMsg: /couldn.?t read that photo/i.test(text) && /jpeg,?\s*png,?\s*or\s*webp/i.test(text),
        preview: img ? { srcHead: (img.getAttribute('src') || '').slice(0, 26), naturalWidth: img.naturalWidth } : null,
      }
    })
  }

  // ============ Step 2 — Add Truck: a non-image as the photo
  await openTrucks()
  const nonImages = [
    { id: '2a', name: 'not-a-photo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG_DOC), what: 'an SVG document (<text> only), type image/svg+xml' },
    { id: '2b', name: 'scan.jpg', mimeType: 'image/jpeg', buffer: PDF_BYTES, what: 'PDF bytes named scan.jpg (browser labels it image/jpeg)' },
    { id: '2c', name: 'document.pdf', mimeType: 'application/pdf', buffer: PDF_BYTES, what: 'a plain PDF, type application/pdf' },
  ]
  for (const f of nonImages) {
    let observed; let ok = false; let s
    try {
      await admin.reload()
      await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
      const det = await openAddForm()
      await caption(admin, `Step ${f.id} — Add Truck: attach ${f.what} as the photo → expect "Couldn't read that photo — use a JPEG, PNG or WebP image." and no preview`)
      await det.locator('input.fdz-file').setInputFiles({ name: f.name, mimeType: f.mimeType, buffer: f.buffer })
      const o = await waitPhotoSettled(det)
      const previewTxt = o.preview ? `preview KEPT (src ${o.preview.srcHead}…, naturalWidth ${o.preview.naturalWidth}${o.preview.naturalWidth === 0 ? ' = broken image' : ''})` : 'no preview'
      observed = `${o.messages.length ? `message: "${o.messages.join('" / "')}"` : 'no message shown'}; ${previewTxt}`
      ok = f.id === '2c'
        ? (!o.preview && o.messages.length > 0) // the drop zone's own type filter may be the one that refuses it
        : (o.expectedMsg && !o.preview)
      if (f.id === '2c') observed += ' (a .pdf never reaches the photo reader: the drop zone type filter answers first)'
      await centerOn(det, ['img[alt*="preview" i]', '.fdz-msg', '.fdz'])
      await caption(admin, `Step ${f.id} — result: ${observed}`)
    } catch (e) { observed = `error: ${e.message}` }
    s = await shot(admin, `${f.id.padStart(3, '0').slice(-3)}-add-truck-${f.name.replace(/\W+/g, '-')}`)
    record({
      step: f.id,
      title: `Add Truck: attach ${f.what}`,
      expected: f.id === '2c' ? 'Refused inline (drop-zone type filter or the photo check); no preview' : 'Inline "Couldn\'t read that photo — use a JPEG, PNG or WebP image."; no broken preview kept',
      observed, verdict: verdict(ok), shot: s,
    })
  }

  // ============ Step 3 — Add the fresh test truck with a real JPEG + costs
  {
    let observed; let ok = false; let s
    const today = await admin.evaluate(() => new Date().toLocaleDateString('en-CA'))
    try {
      await admin.reload()
      await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
      const det = await openAddForm()
      await caption(admin, `Step 3 — Add Truck ${UNIT}: real JPEG photo, Active, in service ${today}, no driver, insurance $1000/mo, ELD $40/mo, HVUT $600/yr, IRP $1200/yr → expect it saves`)
      await field(det, 'Unit Number').fill(UNIT)
      await field(det, 'Status').selectOption('Active')
      await det.locator('#add-truck-in-service-date').fill(today)
      await field(det, 'Insurance ($/mo)').fill('1000')
      await field(det, 'ELD ($/mo)').fill('40')
      await field(det, 'HVUT ($/yr)').fill('600')
      await field(det, 'IRP ($/yr)').fill('1200')
      await det.locator('input.fdz-file').setInputFiles({ name: 'qa-truck.jpg', mimeType: 'image/jpeg', buffer: IMG.jpeg })
      const o = await waitPhotoSettled(det)
      if (!o.preview || !o.preview.naturalWidth) throw new Error(`JPEG preview did not render (${JSON.stringify(o)})`)
      await centerOn(det, ['img[alt*="preview" i]'])
      await shot(admin, '03a-add-truck-filled-photo')
      await field(det, 'Insurance ($/mo)').scrollIntoViewIfNeeded()
      await centerOn(det, ['#add-truck-in-service-date'])
      await shot(admin, '03a-add-truck-filled-costs')
      const [resp] = await Promise.all([
        admin.waitForResponse((r) => new URL(r.url()).pathname === '/api/trucks' && r.request().method() === 'POST', { timeout: 30000 }),
        det.locator('button.btn-add').click(),
      ])
      const body = await resp.json().catch(() => ({}))
      const toast = await toastText(admin)
      if (resp.status() === 200 && body.id) {
        truckId = body.id
        created.add(truckId)
        meta.ids.testTruck = truckId
        await rowOf(admin, UNIT).waitFor({ state: 'visible', timeout: 20000 })
        const t = await getTruck(admin, truckId)
        const photoOk = /^data:image\/jpeg;base64,/.test(t?.Photo || '')
        const costsOk = t && t.InsuranceMonthly === 1000 && t.EldMonthly === 40 && t.HvutAnnual === 600 && t.IrpAnnual === 1200
        ok = photoOk && costsOk
        observed = `POST 200 id=${truckId}; toast "${toast}"; stored photo ${photoHead(t)}; ${costsOf(t)}`
      } else {
        observed = `POST ${resp.status()} ${JSON.stringify(body).slice(0, 200)}; toast "${toast}"`
      }
      await caption(admin, `Step 3 — result: ${observed}`)
    } catch (e) { observed = `error: ${e.message}` }
    s = await shot(admin, '03b-add-truck-saved')
    record({ step: '3', title: 'Add fresh test truck with a real JPEG photo and costs', expected: 'Saves (200); row listed; photo stored as JPEG; costs stored', observed, verdict: verdict(ok), shot: s })
    if (!truckId) {
      // Keep the rest of the run meaningful: create the test truck over the API.
      const r = await api(admin, 'POST', '/api/trucks', {
        unitNumber: UNIT, status: 'Active', in_service_date: today, inServiceDate: today, assignedDriver: '',
        insuranceMonthly: 1000, eldMonthly: 40, hvutAnnual: 600, irpAnnual: 1200, photo: JPEG_DATA,
      })
      if (r.status === 200 && r.json?.id) { truckId = r.json.id; created.add(truckId); meta.ids.testTruck = truckId }
      record({ step: '3*', title: 'Fallback: create the test truck over the API', expected: 'n/a', observed: `POST ${r.status} id=${truckId}`, verdict: 'INFO', shot: '' })
      if (!truckId) throw new Error('no test truck — cannot continue')
      await admin.reload()
    }
  }

  const row = () => rowOf(admin, UNIT)
  async function openEdit() {
    if (new URL(admin.url()).pathname !== '/trucks') await openTrucks()
    await settleTrucks()
    await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
    await row().locator('button.btn-edit').click()
    const dlg = admin.locator('.confirm-overlay .edit-dialog')
    await dlg.waitFor({ state: 'visible' })
    await dlg.locator('h3', { hasText: UNIT }).waitFor()
    return dlg
  }
  const putPath = () => `/api/trucks/${truckId}`
  const ensureInsurance = async (v) => {
    const t = await getTruck(admin, truckId)
    if (t && t.InsuranceMonthly !== v) await api(admin, 'PUT', putPath(), { insuranceMonthly: v })
  }

  // ============ Step 4 — Edit: type 1e999 into Insurance, Save
  {
    let observed; let ok = false; let s
    const puts = []
    const onReq = (req) => { if (req.method() === 'PUT' && new URL(req.url()).pathname === putPath()) puts.push(req.postData() || '') }
    try {
      const before = await getTruck(admin, truckId)
      const dlg = await openEdit()
      await caption(admin, 'Step 4 — Edit the test truck: type 1e999 into Insurance and press Save → expect an inline error naming Insurance, nothing sent')
      const ins = field(dlg, 'Insurance ($/mo)')
      await ins.scrollIntoViewIfNeeded()
      await ins.fill('')
      await ins.pressSequentially('1e999', { delay: HEADED ? 140 : 20 })
      const state = await ins.evaluate((el) => ({ value: el.value, badInput: el.validity.badInput, ariaInvalid: el.getAttribute('aria-invalid') }))
      await shot(admin, '04a-edit-insurance-1e999-typed')
      admin.on('request', onReq)
      const saveBtn = dlg.locator('.confirm-actions button', { hasText: /^\s*Save\s*$/ })
      // A fix may disable Save instead of refusing on click — that also sends nothing.
      const saveDisabled = !(await saveBtn.isEnabled().catch(() => true))
      if (!saveDisabled) await saveBtn.click()
      await admin.waitForTimeout(2500)
      admin.off('request', onReq)
      if (saveDisabled) state.saveDisabled = true
      const toast = await toastText(admin, 1000)
      const stillOpen = await dlg.isVisible().catch(() => false)
      let errInfo = { texts: [], errLines: [] }
      if (stillOpen) {
        errInfo = await dlg.evaluate((root) => {
          const sel = '[role="alert"], [aria-live], .error, .error-msg, .field-error, .input-error, [class*="error" i], [class*="invalid" i], [style*="danger"]'
          const texts = [...root.querySelectorAll(sel)].map((e) => (e.innerText || '').trim()).filter(Boolean)
          const lines = (root.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean)
          const errLines = lines.filter((l) => /insurance/i.test(l) && !/^insurance \(\$\/mo\)$/i.test(l) &&
            /(invalid|must|finite|number|amount|too (large|big|high)|not a|enter|between|at most|less than|up to|can.?t|cannot|exceed|limit|1,000,000)/i.test(l))
          return { texts: [...new Set(texts)], errLines: [...new Set(errLines)] }
        })
      }
      await shot(admin, '04b-edit-insurance-1e999-after-save')
      const after = await getTruck(admin, truckId)
      const sentIns = puts.map((p) => { try { return JSON.stringify(JSON.parse(p).insuranceMonthly) } catch { return '?' } })
      const namedError = errInfo.errLines.length > 0 || errInfo.texts.some((t) => /insurance/i.test(t))
      ok = puts.length === 0 && stillOpen && namedError && after?.InsuranceMonthly === before?.InsuranceMonthly
      observed = `input shows value="${state.value}" (badInput=${state.badInput}${state.ariaInvalid ? `, aria-invalid=${state.ariaInvalid}` : ''}); ` +
        `${state.saveDisabled ? 'Save button disabled; ' : ''}` +
        `${puts.length ? `PUT SENT (insuranceMonthly=${sentIns.join(',')})` : 'no PUT sent'}; ` +
        `modal ${stillOpen ? 'stayed open' : 'closed'}; ` +
        `${namedError ? `inline error: "${[...errInfo.errLines, ...errInfo.texts.filter((t) => /insurance/i.test(t))].join(' / ')}"` : 'no inline error naming Insurance'}; ` +
        `toast "${toast}"; stored insurance ${before?.InsuranceMonthly} → ${after?.InsuranceMonthly}`
      await caption(admin, `Step 4 — result: ${observed}`)
      if (stillOpen) await dlg.locator('.confirm-actions button', { hasText: /^\s*Cancel\s*$/ }).click().catch(() => {})
    } catch (e) { admin.off('request', onReq); observed = `error: ${e.message}` }
    s = await shot(admin, '04c-edit-insurance-1e999-result')
    record({ step: '4', title: 'Edit truck: type 1e999 in Insurance, Save', expected: 'Inline error naming Insurance; no request sent; stored value unchanged', observed, verdict: verdict(ok), shot: s })
    // Whatever state the modal was left in, start the next step from a clean page.
    await admin.reload().catch(() => {})
    await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  }

  // ============ Step 5 — API: bad amounts refused with 400 INVALID_AMOUNT
  {
    await ensureInsurance(1000)
    await caption(admin, 'Step 5 — API: PUT /api/trucks/:id with bad amounts ("Infinity", -5, "abc", "1e999", 1000001, IRP "Infinity") and POST with "Infinity" → expect 400 INVALID_AMOUNT, row unchanged')
    const cases = [
      { id: '5a', body: { insuranceMonthly: 'Infinity' }, field: 'insurance_monthly', col: 'InsuranceMonthly' },
      { id: '5b', body: { insuranceMonthly: -5 }, field: 'insurance_monthly', col: 'InsuranceMonthly' },
      { id: '5c', body: { insuranceMonthly: 'abc' }, field: 'insurance_monthly', col: 'InsuranceMonthly' },
      { id: '5d', body: { insuranceMonthly: '1e999' }, field: 'insurance_monthly', col: 'InsuranceMonthly' },
      { id: '5e', body: { insuranceMonthly: 1000001 }, field: 'insurance_monthly', col: 'InsuranceMonthly' },
      { id: '5f', body: { irpAnnual: 'Infinity' }, field: 'irp_annual', col: 'IrpAnnual' },
    ]
    const logs = []
    for (const c of cases) {
      const before = await getTruck(admin, truckId)
      const r = await api(admin, 'PUT', putPath(), c.body)
      const after = await getTruck(admin, truckId)
      const unchanged = after && after[c.col] === before[c.col]
      const ok = r.status === 400 && r.json?.code === 'INVALID_AMOUNT' && r.json?.field === c.field && unchanged
      const observed = `${r.status} ${r.json ? JSON.stringify({ code: r.json.code, field: r.json.field, error: r.json.error }).slice(0, 160) : r.text}; stored ${c.col} ${before?.[c.col]} → ${JSON.stringify(after?.[c.col])}${unchanged ? ' (unchanged)' : ' (CHANGED)'}`
      logs.push(`${c.id} ${JSON.stringify(c.body)} → ${r.status} ${r.json?.code || ''}`)
      // put the row back so the next case starts from the known state
      if (!unchanged) await api(admin, 'PUT', putPath(), { insuranceMonthly: 1000, irpAnnual: 1200 })
      record({ step: c.id, title: `API PUT ${JSON.stringify(c.body)}`, expected: `400 INVALID_AMOUNT, field "${c.field}"; row unchanged`, observed, verdict: verdict(ok), shot: '' })
    }
    // boundary: exactly 1,000,000 is allowed by the rule (> 1,000,000 is refused)
    {
      const r = await api(admin, 'PUT', putPath(), { insuranceMonthly: 1000000 })
      const t = await getTruck(admin, truckId)
      const ok = r.status === 200 && t?.InsuranceMonthly === 1000000
      logs.push(`5g {"insuranceMonthly":1000000} → ${r.status}`)
      await api(admin, 'PUT', putPath(), { insuranceMonthly: 1000 })
      record({ step: '5g', title: 'API PUT insuranceMonthly 1000000 (boundary)', expected: '200 — accepted (only > 1,000,000 is refused); then reset to 1000', observed: `${r.status}; stored ${t?.InsuranceMonthly}`, verdict: verdict(ok), shot: '' })
    }
    // create verb
    {
      const unit = `${UNIT}-BADAMT`
      const r = await api(admin, 'POST', '/api/trucks', { unitNumber: unit, status: 'Active', insuranceMonthly: 'Infinity' })
      const list = await api(admin, 'GET', '/api/trucks')
      const made = (list.json?.trucks || []).find((t) => t.UnitNumber === unit)
      if (made) { created.add(made.id); await api(admin, 'DELETE', `/api/trucks/${made.id}`); created.delete(made.id) }
      const ok = r.status === 400 && r.json?.code === 'INVALID_AMOUNT' && !made
      logs.push(`5h POST insurance "Infinity" → ${r.status} ${r.json?.code || ''}`)
      record({
        step: '5h', title: 'API POST /api/trucks with insuranceMonthly "Infinity"', expected: '400 INVALID_AMOUNT; no truck created',
        observed: `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 160)}; truck ${made ? `CREATED (#${made.id}, insurance stored as ${JSON.stringify(made.InsuranceMonthly)}) — deleted again` : 'not created'}`,
        verdict: verdict(ok), shot: '',
      })
    }
    // Evidence in the browser: the JSON of the stored row after the bad-amount calls.
    await caption(admin, `Step 5 — ${logs.join(' · ')}`)
    const s = await shot(admin, '05-api-bad-amounts')
    rows.filter((r) => /^5[a-h]$/.test(r.step)).forEach((r) => { r.shot = s })
    writeResults()
  }

  // ============ Step 6 — Edit Insurance + IRP (valid) → one update_truck_costs audit row
  let costRowsStep6 = 0
  let auditBaseline = 0
  {
    let observed; let ok = false; let s
    try {
      await ensureInsurance(1000)
      const pre = await api(admin, 'GET', '/api/admin/audit-trail?entity=truck&limit=1')
      auditBaseline = pre.json?.logs?.[0]?.id || 0
      if (new URL(admin.url()).pathname !== '/trucks') await openTrucks()
      const dlg = await openEdit()
      await caption(admin, 'Step 6 — Edit the test truck: Insurance 1000 → 1150, IRP 1200 → 1800, Save → expect ONE update_truck_costs audit row naming both, with "fixed costs $1,190.00/mo → $1,390.00/mo"')
      await field(dlg, 'Insurance ($/mo)').fill('1150')
      await field(dlg, 'IRP ($/yr)').fill('1800')
      await shot(admin, '06a-edit-costs-valid')
      const [resp] = await Promise.all([
        admin.waitForResponse((r) => new URL(r.url()).pathname === putPath() && r.request().method() === 'PUT', { timeout: 20000 }),
        dlg.locator('.confirm-actions button', { hasText: /^\s*Save\s*$/ }).click(),
      ])
      const toast = await toastText(admin)
      const t = await getTruck(admin, truckId)
      const nav = await navigate(admin, '/api/admin/audit-trail?entity=truck&limit=10')
      await caption(admin, 'Step 6 — the audit trail (entity=truck, newest first) straight after the save')
      s = await shot(admin, '06b-audit-trail-after-cost-edit', { fullPage: true })
      const full = await api(admin, 'GET', '/api/admin/audit-trail?entity=truck&limit=100')
      const mine = (full.json?.logs || []).filter((l) => l.id > auditBaseline && String(l.entity_id) === String(truckId))
      const cost = mine.filter((l) => l.action === 'update_truck_costs')
      costRowsStep6 = cost.length
      const d = cost[0]?.details || ''
      const namesBoth = /insurance/i.test(d) && /irp/i.test(d)
      const hasTotal = /fixed costs:?\s*\$[\d,.]+\/mo\s*(→|->|to)\s*\$[\d,.]+\/mo/i.test(d)
      const exactTotals = /1,190\.00/.test(d) && /1,390\.00/.test(d)
      ok = resp.status() === 200 && cost.length === 1 && namesBoth && hasTotal
      observed = `PUT ${resp.status()}, toast "${toast}", stored ${costsOf(t)}; audit page ${nav.status} ${nav.contentType.split(';')[0]}; ` +
        `new rows for this truck: ${mine.length ? mine.map((l) => l.action).join(', ') : 'none'}; update_truck_costs rows: ${cost.length}` +
        (cost.length ? `; details: "${d}"; names insurance+irp: ${namesBoth}; "fixed costs $X/mo → $Y/mo": ${hasTotal}; totals 1,190.00→1,390.00: ${exactTotals}` : '')
    } catch (e) { observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, '06b-audit-trail-after-cost-edit', { fullPage: true })
    record({ step: '6', title: 'Edit Insurance + IRP (valid values), then view the audit trail', expected: 'Exactly one update_truck_costs row naming insurance and IRP, with "fixed costs $1,190.00/mo → $1,390.00/mo"', observed, verdict: verdict(ok), shot: s })
  }

  // ============ Step 7 — Save again with no changes → no new cost row
  {
    let observed; let ok = false; let s
    try {
      const pre = await api(admin, 'GET', '/api/admin/audit-trail?entity=truck&limit=1')
      const base = pre.json?.logs?.[0]?.id || 0
      await openTrucks()
      const dlg = await openEdit()
      await caption(admin, 'Step 7 — Open Edit and press Save without changing anything → expect NO new update_truck_costs row (a build that sends only changed fields sends nothing and just closes)')
      // A build that sends only changed fields sends NO request for an untouched
      // form and simply closes the dialog; an older build PUTs every field. Both
      // are fine as long as no cost row appears.
      const puts7 = []
      const onReq7 = (req) => { if (req.method() === 'PUT' && new URL(req.url()).pathname === putPath()) puts7.push(req) }
      admin.on('request', onReq7)
      const respP = admin.waitForResponse((r) => new URL(r.url()).pathname === putPath() && r.request().method() === 'PUT', { timeout: 4000 }).catch(() => null)
      await dlg.locator('.confirm-actions button', { hasText: /^\s*Save\s*$/ }).click()
      const resp = await respP
      admin.off('request', onReq7)
      await dlg.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
      const closed = !(await dlg.isVisible().catch(() => false))
      const toast = await toastText(admin, 1500)
      await navigate(admin, '/api/admin/audit-trail?entity=truck&limit=10')
      await caption(admin, 'Step 7 — the audit trail after a no-change save')
      s = await shot(admin, '07-audit-trail-after-no-change-save', { fullPage: true })
      const full = await api(admin, 'GET', '/api/admin/audit-trail?entity=truck&limit=100')
      const mine = (full.json?.logs || []).filter((l) => l.id > base && String(l.entity_id) === String(truckId))
      const cost = mine.filter((l) => l.action === 'update_truck_costs')
      ok = cost.length === 0 && closed && (resp ? resp.status() === 200 : puts7.length === 0)
      observed = `${resp ? `PUT ${resp.status()}` : (puts7.length ? `PUT sent (${puts7.length}) with no response` : 'no PUT sent (nothing changed)')}; dialog ${closed ? 'closed' : 'STILL OPEN'}; toast "${toast}"; new rows for this truck: ${mine.length ? mine.map((l) => l.action).join(', ') : 'none'}; new update_truck_costs rows: ${cost.length}`
      if (ok && costRowsStep6 === 0) observed += ' — vacuous: this build writes no cost audit row at all (see step 6)'
    } catch (e) { observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, '07-audit-trail-after-no-change-save', { fullPage: true })
    record({ step: '7', title: 'Save the same truck again with no changes', expected: 'No new update_truck_costs row', observed, verdict: ok ? (costRowsStep6 === 0 ? 'PASS (vacuous)' : 'PASS') : 'FAIL', shot: s })
  }

  // ============ Extra X1 (opt-in, EXTRA=1) — pre-existing, OUTSIDE the three fixes:
  // an open Edit modal is destroyed by any trucks:changed refresh.
  if (process.env.EXTRA === '1') {
    let observed; let s
    try {
      await openTrucks()
      const dlg = await openEdit()
      await caption(admin, 'Extra X1 (pre-existing, not one of the three fixes) — Edit modal open with an unsaved Notes edit; another truck save lands → does the modal survive?')
      await field(dlg, 'Notes').fill('unsaved QA note')
      await shot(admin, 'x1a-edit-modal-unsaved-note')
      // What another admin's save does: the server emits trucks:changed to every open Trucks page.
      await api(admin, 'PUT', putPath(), { notes: `changed elsewhere ${stamp}` })
      await admin.waitForTimeout(3000)
      const alive = await dlg.isVisible().catch(() => false)
      observed = alive ? 'modal still open; the typed note is kept' : 'modal VANISHED with the unsaved note — TrucksView swaps TruckTable for a skeleton during the socket-driven reload, unmounting the teleported modal'
      await caption(admin, `Extra X1 — result: ${observed}`)
      s = await shot(admin, 'x1b-edit-modal-after-other-save')
      if (alive) await dlg.locator('.confirm-actions button', { hasText: /^\s*Cancel\s*$/ }).click().catch(() => {})
    } catch (e) { observed = `error: ${e.message}` }
    record({ step: 'X1', title: '(pre-existing, out of scope) Edit modal vs. a trucks:changed refresh from another save', expected: 'Modal stays open; unsaved input kept', observed, verdict: 'INFO', shot: s })
  }

  // ============ Step 8 — API: a non-image photo is refused (415), a real one is not
  {
    await openTrucks()
    await caption(admin, 'Step 8 — API: PUT the test truck\'s photo as non-image data URIs → expect 415 UNSUPPORTED_IMAGE_TYPE, stored photo unchanged; real PNG / empty photo still accepted')
    const cases = [
      { id: '8a', p: PLANTS.html, expect: 415 },
      { id: '8b', p: PLANTS.svg, expect: 415 },
      { id: '8c', p: PLANTS.htmlAsJpeg, expect: 415 },
      { id: '8d', p: PLANTS.malformed, expect: '4xx' },
    ]
    const logs = []
    for (const c of cases) {
      const before = await getTruck(admin, truckId)
      const r = await api(admin, 'PUT', putPath(), { photo: c.p.value })
      const after = await getTruck(admin, truckId)
      const unchanged = after?.Photo === before?.Photo
      const ok = (c.expect === 415 ? (r.status === 415 && r.json?.code === 'UNSUPPORTED_IMAGE_TYPE') : (r.status >= 400 && r.status < 500)) && unchanged
      logs.push(`${c.id} → ${r.status} ${r.json?.code || ''}`)
      if (!unchanged) await api(admin, 'PUT', putPath(), { photo: JPEG_DATA })
      record({
        step: c.id, title: `API PUT photo = ${c.p.label}`,
        expected: c.expect === 415 ? '415 UNSUPPORTED_IMAGE_TYPE; stored photo unchanged' : 'Refused with a 4xx (415 expected); stored photo unchanged',
        observed: `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 140)}; stored photo ${unchanged ? 'unchanged' : `CHANGED to ${photoHead(after)} (reset)`}`,
        verdict: verdict(ok), shot: '',
      })
    }
    {
      const unit = `${UNIT}-BADPHOTO`
      const r = await api(admin, 'POST', '/api/trucks', { unitNumber: unit, status: 'Active', photo: PLANTS.html.value })
      const list = await api(admin, 'GET', '/api/trucks')
      const made = (list.json?.trucks || []).find((t) => t.UnitNumber === unit)
      if (made) { created.add(made.id); await api(admin, 'DELETE', `/api/trucks/${made.id}`); created.delete(made.id) }
      logs.push(`8e POST → ${r.status} ${r.json?.code || ''}`)
      record({
        step: '8e', title: 'API POST /api/trucks with photo = data:text/html', expected: '415 UNSUPPORTED_IMAGE_TYPE; no truck created',
        observed: `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 140)}; truck ${made ? `CREATED (#${made.id}, photo ${photoHead(made)}) — deleted again` : 'not created'}`,
        verdict: verdict(r.status === 415 && r.json?.code === 'UNSUPPORTED_IMAGE_TYPE' && !made), shot: '',
      })
    }
    {
      const r = await api(admin, 'PUT', putPath(), { photo: PNG_DATA })
      const t = await getTruck(admin, truckId)
      logs.push(`8f real PNG → ${r.status}`)
      record({ step: '8f', title: 'API PUT photo = a real PNG (regression)', expected: '200 — accepted, stored as an image', observed: `${r.status}; stored ${photoHead(t)}`, verdict: verdict(r.status === 200 && /^data:image\//.test(t?.Photo || '')), shot: '' })
      const r2 = await api(admin, 'PUT', putPath(), { photo: '' })
      const t2 = await getTruck(admin, truckId)
      logs.push(`8g empty photo → ${r2.status}`)
      record({ step: '8g', title: 'API PUT photo = "" — a truck with no photo (regression; the Edit form sends this for photo-less trucks)', expected: '200 — accepted, photo cleared', observed: `${r2.status}; stored ${JSON.stringify(t2?.Photo)}`, verdict: verdict(r2.status === 200 && !t2?.Photo), shot: '' })
      const r3 = await api(admin, 'PUT', putPath(), { photo: JPEG_DATA })
      logs.push(`8h real JPEG → ${r3.status}`)
      record({ step: '8h', title: 'API PUT photo = a real JPEG (regression)', expected: '200', observed: `${r3.status}`, verdict: verdict(r3.status === 200), shot: '' })
    }
    await caption(admin, `Step 8 — ${logs.join(' · ')}`)
    const s = await shot(admin, '08-api-photo-type')
    rows.filter((r) => /^8[a-h]$/.test(r.step)).forEach((r) => { r.shot = s })
    writeResults()
  }

  // =====================================================================
  // ROUND 2 — R1-R9. "Truck A" is this run's test truck (truckId); every
  // "Expected" is the AFTER-the-fix behaviour. Truck A is deleted at the end,
  // so its fields are only put back where a later step reads them.
  // =====================================================================
  const todayR = await admin.evaluate(() => new Date().toLocaleDateString('en-CA'))
  const reloadTrucksPage = async () => {
    await admin.goto(`${BASE_URL}/trucks`)
    await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
  }
  const cancelEdit = async () => {
    const dlg = admin.locator('.confirm-overlay .edit-dialog')
    if (await dlg.isVisible().catch(() => false)) await dlg.locator('.confirm-actions button', { hasText: /^\s*Cancel\s*$/ }).click().catch(() => {})
  }
  // Truck B: a second fresh test truck, the one R1's "other save" lands on.
  const UNIT_B = `${UNIT}-B`
  let truckB = null
  {
    const r = await api(admin, 'POST', '/api/trucks', { unitNumber: UNIT_B, status: 'Active', in_service_date: todayR, inServiceDate: todayR, assignedDriver: '' })
    if (r.status === 200 && r.json?.id) { truckB = r.json.id; created.add(truckB); meta.ids.testTruckB = truckB }
    console.log(`  truck B: POST ${r.status} id=${truckB}`)
  }
  // An existing unit for R2, discovered through the API: the lowest-id truck
  // that is not one of ours. Only its id is ever written to the results.
  const existingTruck = ((await api(admin, 'GET', '/api/trucks')).json?.trucks || [])
    .filter((t) => (t.UnitNumber || '').trim() && !/^QA-TEST-/i.test(t.UnitNumber))
    .sort((a, b) => a.id - b.id)[0] || null
  if (existingTruck) meta.ids.existingUnitTruck = existingTruck.id

  // ============ R1 — an unsaved Edit survives a list reload caused by another save
  {
    let observed; let ok = false; let s
    const note = `QA R1 change on truck B ${stamp}`
    try {
      if (!truckB) throw new Error('truck B could not be created')
      await reloadTrucksPage()
      const dlg = await openEdit()
      const insBefore = (await getTruck(admin, truckId))?.InsuranceMonthly
      await caption(admin, `Step R1 — Edit truck A (${UNIT}): type Insurance 2468 WITHOUT saving; then a save lands on truck B → expect the modal to stay open with 2468 still typed`)
      const ins = field(dlg, 'Insurance ($/mo)')
      await ins.scrollIntoViewIfNeeded()
      await ins.fill('')
      await ins.pressSequentially('2468', { delay: HEADED ? 140 : 20 })
      await shot(admin, 'r1a-edit-a-typed-unsaved')
      // Nothing else on this page issues GET /api/trucks now, so the first one
      // after B's save is the trucks:changed reload.
      const reloadP = admin.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/trucks', { timeout: 15000 }).catch(() => null)
      const put = await api(admin, 'PUT', `/api/trucks/${truckB}`, { notes: note })
      const reloadResp = await reloadP
      let reloadSawB = false
      if (reloadResp) { try { reloadSawB = ((await reloadResp.json()).trucks || []).some((t) => String(t.id) === String(truckB) && t.Notes === note) } catch { /* body unavailable */ } }
      await settleTrucks(1000, 15000)
      await admin.waitForTimeout(400)
      const alive = await dlg.isVisible().catch(() => false)
      const title = alive ? (await dlg.locator('h3').innerText().catch(() => '')).trim() : ''
      const typed = alive ? await ins.inputValue().catch(() => null) : null
      const insAfter = (await getTruck(admin, truckId))?.InsuranceMonthly
      ok = put.status === 200 && !!reloadResp && alive && typed === '2468' && title.includes(UNIT)
      observed = `PUT truck B (#${truckB}) notes → ${put.status}; list reload ${reloadResp ? `GET /api/trucks ${reloadResp.status()}${reloadSawB ? ', carrying B\'s new notes' : ''}` : 'NOT seen within 15 s (inconclusive)'}; ` +
        (alive ? `Edit modal still open ("${title}"), Insurance box shows "${typed}"` : 'Edit modal VANISHED with the typed 2468') +
        `; stored insurance ${insBefore} → ${insAfter} (nothing saved)`
      await caption(admin, `Step R1 — result: ${observed}`)
      s = await shot(admin, 'r1b-after-list-reload')
      await cancelEdit()
    } catch (e) { observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, 'r1b-after-list-reload')
    record({ step: 'R1', title: 'Edit truck A, type Insurance (unsaved); a save on truck B reloads the list', expected: 'Modal stays open; the typed Insurance (2468) is intact', observed, verdict: verdict(ok), shot: s })
  }

  // ============ R11 — two people, one truck: an Edit dialog that stayed open does not
  // revert someone else's save to the same truck (only the fields this person changed are sent).
  {
    let observed; let ok = false; let s
    const otherNote = `QA R11 notes saved elsewhere ${stamp}`
    let insPrev = null
    try {
      await reloadTrucksPage()
      const dlg = await openEdit()
      insPrev = (await getTruck(admin, truckId))?.InsuranceMonthly
      await caption(admin, 'Step R11 — Edit truck A: change Insurance to 1357; meanwhile someone else saves new Notes on the SAME truck → Save → expect BOTH changes to survive')
      const ins = field(dlg, 'Insurance ($/mo)')
      await ins.scrollIntoViewIfNeeded()
      await ins.fill('')
      await ins.pressSequentially('1357', { delay: HEADED ? 140 : 20 })
      // Someone else's save on the same truck (notes only), as another admin would make it.
      const reloadP = admin.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/trucks', { timeout: 15000 }).catch(() => null)
      const other = await api(admin, 'PUT', putPath(), { notes: otherNote })
      await reloadP
      await settleTrucks(1000, 15000)
      await admin.waitForTimeout(400)
      const stillOpen = await dlg.isVisible().catch(() => false)
      await shot(admin, 'r11a-edit-open-after-other-save')
      const [resp] = await Promise.all([
        admin.waitForResponse((r) => new URL(r.url()).pathname === putPath() && r.request().method() === 'PUT', { timeout: 20000 }),
        dlg.locator('.confirm-actions button', { hasText: /^\s*Save\s*$/ }).click(),
      ])
      let sentKeys = []
      try { sentKeys = Object.keys(JSON.parse(resp.request().postData() || '{}')) } catch { /* not JSON */ }
      await dlg.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
      const after = await getTruck(admin, truckId)
      const notesKept = after?.Notes === otherNote
      ok = other.status === 200 && stillOpen && resp.status() === 200 && Number(after?.InsuranceMonthly) === 1357 && notesKept
      observed = `other person's notes save → ${other.status}; my Edit ${stillOpen ? 'still open' : 'CLOSED'}; my Save → PUT ${resp.status()} sending [${sentKeys.join(', ')}]; ` +
        `stored insurance ${insPrev} → ${after?.InsuranceMonthly}; stored notes ${notesKept ? 'KEPT the other person\'s save' : `REVERTED to "${after?.Notes ?? ''}"`}`
      await caption(admin, `Step R11 — result: ${observed}`)
      s = await shot(admin, 'r11b-after-save')
    } catch (e) { observed = `error: ${e.message}` }
    try { if (insPrev !== null) await ensureInsurance(insPrev) } catch { /* best effort */ }
    if (!s) s = await shot(admin, 'r11b-after-save')
    record({ step: 'R11', title: 'Edit truck A (Insurance 1357) while someone else saves new Notes on the same truck, then Save', expected: 'Both survive: insurance 1357 AND the other person\'s notes (the Save sends only the changed fields)', observed, verdict: verdict(ok), shot: s })
  }

  // ============ R2a — Edit: a refused save (duplicate unit) keeps the modal and the input
  {
    let observed; let ok = false; let s
    try {
      if (!existingTruck) throw new Error('no non-QA truck in /api/trucks to borrow a unit number from')
      await reloadTrucksPage()
      const dlg = await openEdit()
      await caption(admin, `Step R2a — Edit truck A: set Unit # to an existing unit (truck #${existingTruck.id}'s) and Save → expect "Unit number already exists" inline, the modal open, the typed unit kept`)
      const unitIn = field(dlg, 'Unit Number')
      await unitIn.fill(existingTruck.UnitNumber)
      await shot(admin, 'r2a-edit-existing-unit-typed')
      const respP = admin.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === putPath(), { timeout: 15000 }).catch(() => null)
      await dlg.locator('.confirm-actions button', { hasText: /^\s*Save\s*$/ }).click()
      const resp = await respP
      const body = resp ? await resp.json().catch(() => null) : null
      await admin.waitForTimeout(1200)
      const toast = await toastText(admin, 1500)
      const stillOpen = await dlg.isVisible().catch(() => false)
      const unitNow = stillOpen ? await unitIn.inputValue().catch(() => null) : null
      const inline = stillOpen && /unit number already exists/i.test(await dlg.innerText().catch(() => ''))
      const t = await getTruck(admin, truckId)
      ok = resp?.status() === 400 && stillOpen && unitNow === existingTruck.UnitNumber && inline && t?.UnitNumber === UNIT
      observed = `PUT ${resp ? `${resp.status()} ${JSON.stringify(body).slice(0, 80)}` : 'not sent'}; modal ${stillOpen ? 'stayed open' : 'CLOSED'}` +
        (stillOpen ? `; Unit # box ${unitNow === existingTruck.UnitNumber ? 'still holds the typed unit' : `reads "${unitNow}"`}; inline error ${inline ? 'shown' : 'NOT shown'}` : ' (the typed unit is gone)') +
        `; toast "${toast}"; stored unit ${t?.UnitNumber === UNIT ? 'unchanged' : 'CHANGED'}`
      await caption(admin, `Step R2a — result: ${observed}`)
      s = await shot(admin, 'r2a-edit-existing-unit-result')
      await cancelEdit()
    } catch (e) { observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, 'r2a-edit-existing-unit-result')
    record({ step: 'R2a', title: 'Edit truck A: Unit # set to an existing unit, Save', expected: '400 "Unit number already exists" shown inline; modal stays open; the typed unit is still there', observed, verdict: verdict(ok), shot: s })
  }

  // ============ R2b — Add Truck: a refused add (duplicate unit) keeps what was typed
  {
    let observed; let ok = false; let s
    const note = `QA R2b keep me ${stamp}`
    try {
      if (!existingTruck) throw new Error('no non-QA truck in /api/trucks to borrow a unit number from')
      await reloadTrucksPage()
      const det = await openAddForm()
      await caption(admin, `Step R2b — Add Truck with an existing unit (truck #${existingTruck.id}'s), a note and Insurance 777 → expect the fields kept and "Unit number already exists" shown`)
      await field(det, 'Unit Number').fill(existingTruck.UnitNumber)
      await field(det, 'Notes (optional)').fill(note)
      await field(det, 'Insurance ($/mo)').fill('777')
      await centerOn(det, ['button.btn-add'])
      await shot(admin, 'r2b-add-existing-unit-filled')
      const respP = admin.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/trucks', { timeout: 15000 }).catch(() => null)
      await det.locator('button.btn-add').click()
      const resp = await respP
      const body = resp ? await resp.json().catch(() => null) : null
      await admin.waitForTimeout(1200)
      const toast = await toastText(admin, 1500)
      const unitNow = await field(det, 'Unit Number').inputValue().catch(() => null)
      const notesNow = await field(det, 'Notes (optional)').inputValue().catch(() => null)
      const insNow = await field(det, 'Insurance ($/mo)').inputValue().catch(() => null)
      const inlineErr = (await det.locator('.error-msg').innerText().catch(() => '')).trim()
      const shownInline = /unit number already exists/i.test(inlineErr)
      const shownToast = /unit number already exists/i.test(toast)
      const kept = unitNow === existingTruck.UnitNumber && notesNow === note && insNow === '777'
      const dupes = ((await api(admin, 'GET', '/api/trucks')).json?.trucks || []).filter((t) => (t.UnitNumber || '').toLowerCase() === existingTruck.UnitNumber.toLowerCase()).length
      ok = resp?.status() === 400 && kept && (shownInline || shownToast) && dupes === 1
      observed = `POST ${resp ? `${resp.status()} ${JSON.stringify(body).slice(0, 80)}` : 'not sent'}; fields ${kept ? 'kept (unit, note, Insurance 777)' : `CLEARED (unit ${unitNow === existingTruck.UnitNumber ? 'kept' : `"${unitNow}"`}, note ${notesNow === note ? 'kept' : `"${notesNow}"`}, Insurance "${insNow}")`}; ` +
        `error ${shownInline ? `inline "${inlineErr}"` : 'not inline'}${shownToast ? `, toast "${toast}"` : toast ? `; toast "${toast}"` : ''}; trucks with that unit: ${dupes}`
      await centerOn(det, ['.error-msg', 'button.btn-add'])
      await caption(admin, `Step R2b — result: ${observed}`)
      s = await shot(admin, 'r2b-add-existing-unit-result')
      // Leave nothing typed behind for the next step.
      for (const l of ['Unit Number', 'Notes (optional)']) await field(det, l).fill('').catch(() => {})
      await field(det, 'Insurance ($/mo)').fill('0').catch(() => {})
    } catch (e) { observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, 'r2b-add-existing-unit-result')
    record({ step: 'R2b', title: 'Add Truck with an existing unit, press Add Truck', expected: '400 "Unit number already exists" shown; every typed field kept; no truck created', observed, verdict: verdict(ok), shot: s })
  }

  // ============ R4 — a stored photo is normalized to what its bytes are
  {
    let observed; let ok = false; let s
    try {
      await reloadTrucksPage()
      await caption(admin, 'Step R4 — API: PUT truck A photo = real PNG bytes under a data:image/jpeg label, then GET /api/trucks → expect Photo returned as data:image/png;base64,…')
      const r = await api(admin, 'PUT', putPath(), { photo: PLANTS.pngAsJpeg.value })
      const t = await getTruck(admin, truckId)
      const stored = t?.Photo || ''
      const sameBytes = stored.slice(stored.indexOf(',') + 1) === IMG.png.toString('base64')
      // The same value through the UI: the Edit dialog's preview is the stored photo.
      let uiHead = '(not read)'
      try {
        await reloadTrucksPage()
        const dlg = await openEdit()
        const img = dlg.locator('img[alt="Truck photo preview"]')
        await img.scrollIntoViewIfNeeded()
        uiHead = ((await img.getAttribute('src')) || '').slice(0, 22)
        await caption(admin, `Step R4 — PUT ${r.status}; GET /api/trucks Photo starts "${stored.slice(0, 22)}…"; the Edit dialog's preview src starts "${uiHead}…"`)
        s = await shot(admin, 'r4-png-bytes-under-jpeg-label')
        await cancelEdit()
      } catch (e) { uiHead = `(UI read failed: ${e.message.split('\n')[0]})` }
      ok = r.status === 200 && /^data:image\/png;base64,/.test(stored)
      observed = `PUT ${r.status}; GET /api/trucks Photo starts "${stored.slice(0, 22)}…"; payload ${sameBytes ? 'identical to the PNG bytes sent' : 'differs from the PNG bytes sent'}; Edit preview src "${uiHead}…"`
    } catch (e) { observed = `error: ${e.message}` }
    await api(admin, 'PUT', putPath(), { photo: JPEG_DATA }).catch(() => {})
    if (!s) s = await shot(admin, 'r4-png-bytes-under-jpeg-label')
    record({ step: 'R4', title: 'API PUT truck A photo = real PNG bytes under a data:image/jpeg label; GET /api/trucks', expected: '200; A\'s Photo is returned as data:image/png;base64,…', observed, verdict: verdict(ok), shot: s })
  }

  // ============ R5 — photo limits: 2 MiB of bytes, 16 MP of pixels
  {
    const bigJpeg = makePaddedJpeg(Math.round(2.5 * 1024 * 1024))
    const hugePng = makePngHeader(5000, 4000)
    const cases = [
      { id: 'R5a', what: `a valid JPEG header (640×480) padded to ${(bigJpeg.length / 1048576).toFixed(2)} MiB`, value: `data:image/jpeg;base64,${bigJpeg.toString('base64')}` },
      { id: 'R5b', what: `a minimal ${hugePng.length}-byte PNG whose IHDR declares 5000×4000 (20 MP)`, value: `data:image/png;base64,${hugePng.toString('base64')}` },
    ]
    await caption(admin, 'Step R5 — API: PUT truck A photo over the new limits (2.5 MiB JPEG; a 20 MP PNG header) → expect 413 IMAGE_TOO_LARGE, stored photo unchanged')
    const logs = []
    for (const c of cases) {
      const before = await getTruck(admin, truckId)
      const r = await api(admin, 'PUT', putPath(), { photo: c.value })
      const after = await getTruck(admin, truckId)
      const unchanged = after?.Photo === before?.Photo
      if (!unchanged) await api(admin, 'PUT', putPath(), { photo: JPEG_DATA })
      logs.push(`${c.id} → ${r.status} ${r.json?.code || ''}`)
      record({
        step: c.id, title: `API PUT truck A photo = ${c.what}`, expected: '413 IMAGE_TOO_LARGE; stored photo unchanged',
        observed: `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 150)}; stored photo ${unchanged ? 'unchanged' : `CHANGED to ${photoHead(after)} (reset)`}`,
        verdict: verdict(r.status === 413 && r.json?.code === 'IMAGE_TOO_LARGE' && unchanged), shot: '',
      })
    }
    await caption(admin, `Step R5 — ${logs.join(' · ')}`)
    const s = await shot(admin, 'r5-api-photo-limits')
    rows.filter((r) => /^R5[ab]$/.test(r.step)).forEach((r) => { r.shot = s })
    writeResults()
  }

  // ============ R6 — admin fee must be 0-100; blank means 50
  {
    await caption(admin, 'Step R6 — API: PUT truck A adminFeePct 150, -5, "abc" → expect 400 INVALID_AMOUNT (field admin_fee_pct); then "" → 200, stored 50')
    const setFee = (v) => api(admin, 'PUT', putPath(), { adminFeePct: v })
    const logs = []
    for (const [id, v] of [['R6a', 150], ['R6b', -5], ['R6c', 'abc']]) {
      if ((await getTruck(admin, truckId))?.AdminFeePct !== 50) await setFee(50)
      const before = await getTruck(admin, truckId)
      const r = await setFee(v)
      const after = await getTruck(admin, truckId)
      const unchanged = after?.AdminFeePct === before?.AdminFeePct
      if (!unchanged) await setFee(50)
      logs.push(`${id} ${JSON.stringify(v)} → ${r.status} ${r.json?.code || ''}`)
      record({
        step: id, title: `API PUT adminFeePct ${JSON.stringify(v)}`, expected: '400 INVALID_AMOUNT, field "admin_fee_pct"; stored fee unchanged',
        observed: `${r.status} ${r.json ? JSON.stringify({ code: r.json.code, field: r.json.field, error: r.json.error }).slice(0, 150) : r.text}; stored AdminFeePct ${before?.AdminFeePct} → ${after?.AdminFeePct}${unchanged ? ' (unchanged)' : ' (CHANGED, reset)'}`,
        verdict: verdict(r.status === 400 && r.json?.code === 'INVALID_AMOUNT' && r.json?.field === 'admin_fee_pct' && unchanged), shot: '',
      })
    }
    {
      // Set a valid 40 first, so a stored 50 afterwards proves "blank = 50" rather than "unchanged".
      const r0 = await setFee(40)
      const mid = await getTruck(admin, truckId)
      const r = await setFee('')
      const t = await getTruck(admin, truckId)
      logs.push(`R6d "" → ${r.status}, stored ${t?.AdminFeePct}`)
      record({
        step: 'R6d', title: 'API PUT adminFeePct "" (after setting 40)', expected: '200; stored 50',
        observed: `set 40 → ${r0.status} (stored ${mid?.AdminFeePct}); "" → ${r.status}; stored AdminFeePct ${t?.AdminFeePct}`,
        verdict: verdict(r0.status === 200 && mid?.AdminFeePct === 40 && r.status === 200 && t?.AdminFeePct === 50), shot: '',
      })
    }
    await caption(admin, `Step R6 — ${logs.join(' · ')}`)
    const s = await shot(admin, 'r6-api-admin-fee')
    rows.filter((r) => /^R6[a-d]$/.test(r.step)).forEach((r) => { r.shot = s })
    writeResults()
  }

  // ============ R7 — fuel tank <= 500 gal, avg MPG <= 20 (API, create verb, Edit form)
  {
    await caption(admin, 'Step R7 — API: PUT truck A fuel tank 600 and avg MPG 25 → expect 400 INVALID_AMOUNT each; 500 and 20 → 200')
    await api(admin, 'PUT', putPath(), { fuel_tank_gallons: 0, avg_mpg: 0 })
    const logs = []
    const cases = [
      { id: 'R7a', body: { fuel_tank_gallons: 600 }, field: 'fuel_tank_gallons', col: 'FuelTankGallons', msg: (m) => /fuel tank/i.test(m) && /\b500\b/.test(m), msgText: '"Fuel tank must be a number between 0 and 500"' },
      { id: 'R7b', body: { avg_mpg: 25 }, field: 'avg_mpg', col: 'AvgMpg', msg: (m) => /average mpg/i.test(m) && /\b20\b/.test(m), msgText: '"Average MPG … 20"' },
    ]
    for (const c of cases) {
      const before = await getTruck(admin, truckId)
      const r = await api(admin, 'PUT', putPath(), c.body)
      const after = await getTruck(admin, truckId)
      const unchanged = after?.[c.col] === before?.[c.col]
      if (!unchanged) await api(admin, 'PUT', putPath(), { [c.field]: before?.[c.col] ?? 0 })
      logs.push(`${c.id} ${JSON.stringify(c.body)} → ${r.status} ${r.json?.code || ''}`)
      record({
        step: c.id, title: `API PUT ${JSON.stringify(c.body)}`, expected: `400 INVALID_AMOUNT, field "${c.field}", message ${c.msgText}; row unchanged`,
        observed: `${r.status} ${r.json ? JSON.stringify({ code: r.json.code, field: r.json.field, error: r.json.error }).slice(0, 160) : r.text}; stored ${c.col} ${before?.[c.col]} → ${after?.[c.col]}${unchanged ? ' (unchanged)' : ' (CHANGED, reset)'}`,
        verdict: verdict(r.status === 400 && r.json?.code === 'INVALID_AMOUNT' && r.json?.field === c.field && c.msg(r.json?.error || '') && unchanged), shot: '',
      })
    }
    for (const [id, body, col, v] of [['R7c', { fuel_tank_gallons: 500 }, 'FuelTankGallons', 500], ['R7d', { avg_mpg: 20 }, 'AvgMpg', 20]]) {
      const r = await api(admin, 'PUT', putPath(), body)
      const t = await getTruck(admin, truckId)
      logs.push(`${id} ${JSON.stringify(body)} → ${r.status}`)
      record({ step: id, title: `API PUT ${JSON.stringify(body)} (boundary)`, expected: `200; stored ${v}`, observed: `${r.status}; stored ${col} ${t?.[col]}`, verdict: verdict(r.status === 200 && t?.[col] === v), shot: '' })
    }
    {
      // The create verb reads the same table.
      const unit = `${UNIT}-BADFUEL`
      const r = await api(admin, 'POST', '/api/trucks', { unitNumber: unit, status: 'Active', fuel_tank_gallons: 600 })
      const made = ((await api(admin, 'GET', '/api/trucks')).json?.trucks || []).find((t) => t.UnitNumber === unit)
      if (made) { created.add(made.id); await api(admin, 'DELETE', `/api/trucks/${made.id}`); created.delete(made.id) }
      logs.push(`R7e POST fuel 600 → ${r.status} ${r.json?.code || ''}`)
      record({
        step: 'R7e', title: 'API POST /api/trucks with fuel_tank_gallons 600 (Super Admin)', expected: '400 INVALID_AMOUNT, field "fuel_tank_gallons"; no truck created',
        observed: `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 150)}; truck ${made ? `CREATED (#${made.id}, tank ${made.FuelTankGallons}) — deleted again` : 'not created'}`,
        verdict: verdict(r.status === 400 && r.json?.code === 'INVALID_AMOUNT' && r.json?.field === 'fuel_tank_gallons' && !made), shot: '',
      })
    }
    await caption(admin, `Step R7 — ${logs.join(' · ')}`)
    const s = await shot(admin, 'r7-api-fuel-limits')
    rows.filter((r) => /^R7[a-e]$/.test(r.step)).forEach((r) => { r.shot = s })
    writeResults()
  }
  // R7f — the Edit form refuses the same inline, before sending anything.
  {
    let observed; let ok = false; let s
    const puts = []
    const onReq = (req) => { if (req.method() === 'PUT' && new URL(req.url()).pathname === putPath()) puts.push(req.postData() || '') }
    try {
      await reloadTrucksPage()
      const before = await getTruck(admin, truckId)
      const dlg = await openEdit()
      await caption(admin, 'Step R7f — Edit truck A: type 600 into Fuel Tank (gallons) and Save → expect an inline error naming the fuel tank, nothing sent, modal open')
      const tank = field(dlg, 'Fuel Tank (gallons)')
      await tank.scrollIntoViewIfNeeded()
      await tank.fill('')
      await tank.pressSequentially('600', { delay: HEADED ? 140 : 20 })
      await shot(admin, 'r7f-edit-fuel-600-typed')
      admin.on('request', onReq)
      await dlg.locator('.confirm-actions button', { hasText: /^\s*Save\s*$/ }).click()
      await admin.waitForTimeout(2500)
      admin.off('request', onReq)
      const toast = await toastText(admin, 1000)
      const stillOpen = await dlg.isVisible().catch(() => false)
      const err = stillOpen ? (await dlg.locator('.edit-error, [role="alert"]').allInnerTexts().catch(() => [])).map((t) => t.trim()).filter(Boolean).join(' / ') : ''
      const namesTank = /fuel tank/i.test(err) && /\b500\b/.test(err)
      const after = await getTruck(admin, truckId)
      const sent = puts.map((p) => { try { return JSON.parse(p).fuel_tank_gallons } catch { return '?' } })
      ok = puts.length === 0 && stillOpen && namesTank && after?.FuelTankGallons === before?.FuelTankGallons
      observed = `${puts.length ? `PUT SENT (fuel_tank_gallons=${sent.join(',')})` : 'no PUT sent'}; modal ${stillOpen ? 'stayed open' : 'closed'}; ` +
        `${err ? `inline error "${err}"` : 'no inline error'}; toast "${toast}"; stored FuelTankGallons ${before?.FuelTankGallons} → ${after?.FuelTankGallons}`
      await caption(admin, `Step R7f — result: ${observed}`)
      s = await shot(admin, 'r7f-edit-fuel-600-result')
      await cancelEdit()
    } catch (e) { admin.off('request', onReq); observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, 'r7f-edit-fuel-600-result')
    record({ step: 'R7f', title: 'Edit truck A: type 600 in Fuel Tank (gallons), Save', expected: 'Inline error naming the fuel tank (0-500); no request sent; stored value unchanged', observed, verdict: verdict(ok), shot: s })
    await api(admin, 'PUT', putPath(), { fuel_tank_gallons: 0, avg_mpg: 0 }).catch(() => {})
  }

  // ============ R9 — the create_truck audit line names the fuel tank and MPG
  {
    let observed; let ok = false; let s
    const unit = `${UNIT}-R9`
    try {
      await reloadTrucksPage()
      const det = await openAddForm()
      await caption(admin, `Step R9 — Add Truck ${unit} with Fuel Tank 180 gal and Avg MPG 6.8 → expect the create_truck audit line to name both`)
      await field(det, 'Unit Number').fill(unit)
      await field(det, 'Status').selectOption('Active')
      await field(det, 'Fuel Tank (gallons)').fill('180')
      await field(det, 'Avg MPG (optional)').fill('6.8')
      await centerOn(det, ['button.btn-add'])
      await shot(admin, 'r9a-add-truck-fuel-mpg')
      const base = (await api(admin, 'GET', '/api/admin/audit-trail?entity=truck&limit=1')).json?.logs?.[0]?.id || 0
      const [resp] = await Promise.all([
        admin.waitForResponse((r) => new URL(r.url()).pathname === '/api/trucks' && r.request().method() === 'POST', { timeout: 30000 }),
        det.locator('button.btn-add').click(),
      ])
      const body = await resp.json().catch(() => ({}))
      if (body?.id) { created.add(body.id); meta.ids.r9Truck = body.id }
      const t = body?.id ? await getTruck(admin, body.id) : null
      const logs = (await api(admin, 'GET', '/api/admin/audit-trail?entity=truck&limit=100')).json?.logs || []
      const line = logs.find((l) => l.id > base && l.action === 'create_truck' && String(l.entity_id) === String(body?.id))
      const d = line?.details || ''
      const namesTank = /fuel tank/i.test(d) && /\b180\b/.test(d)
      const namesMpg = /mpg/i.test(d) && /\b6\.8\b/.test(d)
      await navigate(admin, '/api/admin/audit-trail?entity=truck&limit=5')
      await caption(admin, 'Step R9 — the audit trail (entity=truck, newest first) straight after the add')
      s = await shot(admin, 'r9b-audit-create-truck', { fullPage: true })
      ok = resp.status() === 200 && t?.FuelTankGallons === 180 && t?.AvgMpg === 6.8 && namesTank && namesMpg
      observed = `POST ${resp.status()} id=${body?.id}; stored tank ${t?.FuelTankGallons}, MPG ${t?.AvgMpg}; create_truck line: ${line ? `"${d}"` : 'NOT FOUND'}; names tank 180: ${namesTank}; names MPG 6.8: ${namesMpg}`
    } catch (e) { observed = `error: ${e.message}` }
    if (!s) s = await shot(admin, 'r9b-audit-create-truck', { fullPage: true })
    record({ step: 'R9', title: 'Super Admin adds a truck with Fuel Tank 180 and Avg MPG 6.8 (UI), then the audit trail', expected: 'The create_truck audit line names the fuel tank (180 gal) and the MPG (6.8)', observed, verdict: verdict(ok), shot: s })
  }

  // ============ R8 — an Investor's add ignores the fuel pair (third browser context)
  if (!CREDS.investor) {
    record({ step: 'R8', title: 'Investor POST /api/trucks with fuel_tank_gallons 400', expected: 'Created with FuelTankGallons 0', observed: 'SKIPPED — no investor login in the creds file', verdict: 'SKIP', shot: '' })
  } else {
    let observed; let ok = false; let s
    let inv = null
    try {
      investorCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
      investorCtx.setDefaultTimeout(20000)
      inv = await investorCtx.newPage()
      await login(inv, 'Step R8 — Investor', CREDS.investor.username, CREDS.investor.password, '/investor')
      const sess = (await api(inv, 'GET', '/api/auth/session')).json?.user || null
      meta.ids.investorUser = sess?.id
      await caption(inv, `Step R8 — Investor: POST /api/trucks {unitNumber:"${INV_UNIT}", fuel_tank_gallons:400} from the investor's own page → expect it created with FuelTankGallons 0`)
      const r = await api(inv, 'POST', '/api/trucks', { unitNumber: INV_UNIT, fuel_tank_gallons: 400 })
      if (r.json?.id) { created.add(r.json.id); meta.ids.investorTruck = r.json.id }
      const mine = ((await api(inv, 'GET', '/api/trucks')).json?.trucks || []).find((t) => t.UnitNumber === INV_UNIT)
      // The investor's own Trucks page: the Tank column of the new row.
      await inv.goto(`${BASE_URL}/trucks`)
      await inv.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
      const irow = rowOf(inv, INV_UNIT)
      await irow.waitFor({ state: 'visible', timeout: 20000 })
      await irow.scrollIntoViewIfNeeded()
      const tankIdx = await inv.locator('table.truck-table thead th').evaluateAll((ths) => ths.findIndex((th) => th.textContent.trim() === 'Tank'))
      const tankCell = tankIdx >= 0 ? (await irow.locator('td').nth(tankIdx).innerText()).trim() : '(no Tank column)'
      ok = r.status === 200 && !!mine && mine.FuelTankGallons === 0
      observed = `POST ${r.status} id=${r.json?.id ?? '-'}; stored FuelTankGallons ${mine ? mine.FuelTankGallons : '(truck not listed)'}` +
        `${mine ? `, owner ${mine.OwnerId === CREDS.investor.userId ? 'is the investor' : `#${mine.OwnerId}`}` : ''}; the investor's Trucks page shows Tank "${tankCell}"`
      await caption(inv, `Step R8 — result: ${observed}`)
      s = await shot(inv, 'r8-investor-add-ignores-fuel')
    } catch (e) { observed = `error: ${e.message}` }
    if (!s && inv) s = await shot(inv, 'r8-investor-add-ignores-fuel')
    record({ step: 'R8', title: `Investor (third context) POST /api/trucks {unitNumber:"QA-TEST-INV-…", fuel_tank_gallons:400}`, expected: 'Created (200) with FuelTankGallons 0 — an Investor\'s add ignores the fuel pair; Trucks page shows "200 gal (default)"', observed, verdict: verdict(ok), shot: s })
    await investorCtx?.close().catch(() => {})
    investorCtx = null
  }

  // ============ Step 9 — Driver logs in; truck photo visible
  driverCtx = await browser.newContext({ viewport: { width: DVW, height: DVH }, isMobile: false })
  driverCtx.setDefaultTimeout(20000)
  driver = await driverCtx.newPage()
  const photoResponses = []
  const idResponses = []
  driver.on('response', (r) => {
    const p = new URL(r.url()).pathname
    if (p === '/api/driver/me/truck-photo') photoResponses.push({ status: r.status(), ct: r.headers()['content-type'] || '' })
    if (p.startsWith('/api/driver/me/identity-file/')) idResponses.push({ path: p, status: r.status(), ct: r.headers()['content-type'] || '' })
  })
  let session = null
  let driverTruckIds = []
  let appId = null
  {
    let observed; let ok = false; let s
    try {
      await login(driver, 'Step 9 — Driver', CREDS.driver.username, CREDS.driver.password, '/driver')
      session = (await api(driver, 'GET', '/api/auth/session')).json?.user || null
      meta.ids.driverUser = session?.id
      if (db && session?.driverName) {
        driverTruckIds = db.prepare('SELECT id FROM trucks WHERE LOWER(assigned_driver) = LOWER(?)').all(session.driverName).map((r) => r.id)
        appId = db.prepare('SELECT application_id FROM driver_onboarding WHERE user_id = ?').get(session.id)?.application_id || null
        meta.ids.driverTruck = driverTruckIds.join('+')
        meta.ids.application = appId
      }
      await driver.locator('.driver-app').waitFor({ state: 'visible', timeout: 30000 })
      await driver.locator('.load-sub-tabs').waitFor({ state: 'visible', timeout: 45000 })
      await driver.locator('.loading-skeletons').waitFor({ state: 'detached', timeout: 45000 }).catch(() => {})
      await caption(driver, 'Step 9 — Driver signed in → open a load, expand "Truck Details" → expect the truck photo (image/jpeg)')
      // Find a sub-tab that has loads.
      let opened = false
      for (const tab of await driver.locator('.load-sub-tabs .sub-tab').all()) {
        const n = Number((await tab.locator('.sub-tab-count').innerText().catch(() => '0')).trim()) || 0
        if (n > 0) {
          await tab.click()
          const card = driver.locator('.load-card').first()
          await card.waitFor({ state: 'visible', timeout: 15000 })
          await card.click()
          opened = true
          break
        }
      }
      if (opened) {
        const item = driver.locator('.van-collapse-item').filter({ hasText: 'Truck Details' }).first()
        await item.waitFor({ state: 'visible', timeout: 20000 })
        const title = item.locator('.van-collapse-item__title').first()
        await title.scrollIntoViewIfNeeded()
        if ((await title.getAttribute('aria-expanded')) !== 'true') await title.click()
        const img = item.locator('img.truck-photo')
        await img.waitFor({ state: 'visible', timeout: 20000 })
        await img.scrollIntoViewIfNeeded()
        const nat = await img.evaluate(async (el) => { if (!el.complete) await new Promise((r) => { el.onload = el.onerror = r; setTimeout(r, 8000) }); return { w: el.naturalWidth, h: el.naturalHeight, src: el.getAttribute('src').slice(0, 40) } })
        await driver.waitForTimeout(300)
        const last = photoResponses[photoResponses.length - 1]
        ok = nat.w > 0 && !!last && last.status === 200 && /^image\/jpeg/i.test(last.ct)
        observed = `via the UI (load detail → Truck Details): <img src="${nat.src}"> rendered ${nat.w}×${nat.h}; response ${last ? `${last.status} ${last.ct}` : 'not seen'}`
        await caption(driver, `Step 9 — result: ${observed}`)
      } else {
        const nav = await navigate(driver, `/api/driver/me/truck-photo?qa=9-${stamp}`)
        const nat = await driver.evaluate(() => { const i = document.querySelector('img'); return i ? { w: i.naturalWidth, h: i.naturalHeight } : null })
        ok = nav.status === 200 && /^image\/jpeg/i.test(nav.contentType) && nat?.w > 0
        observed = `no load in any sub-tab, so navigated to /api/driver/me/truck-photo: ${nav.status} ${nav.contentType}, rendered ${nat ? `${nat.w}×${nat.h}` : 'nothing'}`
        await caption(driver, `Step 9 — (no loads) ${observed}`)
      }
    } catch (e) { observed = `error: ${e.message}` }
    s = await shot(driver, '09-driver-truck-photo')
    record({ step: '9', title: 'Driver logs in; the truck photo is visible', expected: 'Image renders; served as image/jpeg (both phases)', observed, verdict: verdict(ok), shot: s })
  }

  // Guard for steps 10-11: DB_PATH must be the database THIS server reads, or
  // every planted case would silently test nothing. Write a sentinel into the
  // test truck's notes (our own row) and read it back through the API.
  if (db && truckId) {
    const sentinel = `qa-sentinel-${stamp}-${Math.random().toString(36).slice(2, 8)}`
    let reason = ''
    try {
      // Only ever touches THIS run's test truck (matched by id AND unit number).
      const mine = db.prepare('SELECT notes FROM trucks WHERE id = ? AND unit_number = ?').get(truckId, UNIT)
      if (!mine) throw new Error(`this run's test truck (#${truckId}) is not in DB_PATH`)
      db.prepare('UPDATE trucks SET notes = ? WHERE id = ? AND unit_number = ?').run(sentinel, truckId, UNIT)
      const seen = (await getTruck(admin, truckId))?.Notes
      db.prepare('UPDATE trucks SET notes = ? WHERE id = ? AND unit_number = ?').run(mine.notes, truckId, UNIT)
      if (seen !== sentinel) reason = `a value written to DB_PATH did not appear through the API (saw ${JSON.stringify(seen)})`
    } catch (e) { reason = e.message }
    if (reason) {
      record({ step: '10*', title: 'DB_PATH sanity check', expected: 'The server reads DB_PATH', observed: `${reason} — DB_PATH is not this server's DATABASE_PATH; planted cases skipped`, verdict: 'FAIL', shot: '' })
      try { db.close() } catch { /* ignore */ }
      db = null
    }
  }

  // ============ Step 10 — Planted non-image truck photos, served to the driver
  {
    const expectFor = (k) => (k === 'pngAsJpeg' ? '200, Content-Type image/png — the image renders' : '404 JSON (application/json)')
    const order = ['html', 'svg', 'htmlAsJpeg', 'pngAsJpeg', 'malformed']
    if (!db || !driverTruckIds.length) {
      for (const [i, k] of order.entries()) {
        record({ step: `10${'abcde'[i]}`, title: `Truck photo planted as ${PLANTS[k].label}`, expected: expectFor(k), observed: db ? 'no truck is assigned to this driver' : skipWhy(), verdict: 'SKIP', shot: '' })
      }
    } else {
      try {
        for (const [i, k] of order.entries()) {
          const id = `10${'abcde'[i]}`
          for (const tid of driverTruckIds) plant('trucks', 'photo', tid, PLANTS[k].value)
          const nav = await navigate(driver, `/api/driver/me/truck-photo?qa=${id}-${stamp}`)
          const rendered = await driver.evaluate(() => { const i = document.querySelector('body > img, img'); return i ? i.naturalWidth : null }).catch(() => null)
          const ok = k === 'pngAsJpeg'
            ? nav.status === 200 && /^image\/png/i.test(nav.contentType) && rendered > 0
            : nav.status === 404 && nav.isJson
          const observed = `${nav.status} ${nav.contentType || '(no content-type)'}${rendered !== null ? `; <img> naturalWidth ${rendered}` : ''}${nav.isJson ? `; body ${nav.bodyHead}` : /html/i.test(nav.contentType) ? '; the planted HTML was rendered as a page' : ''}`
          await caption(driver, `Step ${id} — truck photo planted as ${PLANTS[k].label} → GET /api/driver/me/truck-photo answered ${nav.status} ${nav.contentType}; expected ${expectFor(k)}`)
          const s = await shot(driver, `${id}-truck-photo-${k}`)
          record({ step: id, title: `Truck photo planted as ${PLANTS[k].label}; driver opens /api/driver/me/truck-photo`, expected: expectFor(k), observed, verdict: verdict(ok), shot: s })
        }
      } finally {
        const r = restoreAll()
        console.log(`  restore: ${r.join('; ')}`)
      }
    }
  }

  // ============ Step 11 — Driver Kit: CDL renders; planted non-image CDL is refused
  {
    let observed; let ok = false; let s
    try {
      await driver.goto(`${BASE_URL}/driver`)
      await driver.locator('.driver-app').waitFor({ state: 'visible', timeout: 30000 })
      await driver.locator('.load-sub-tabs').waitFor({ state: 'visible', timeout: 45000 })
      const kit = driver.locator('.van-tabbar-item', { hasText: 'Kit' })
      idResponses.length = 0
      await kit.click()
      await caption(driver, 'Step 11a — Driver Kit tab → expect the CDL (My Identity Documents) to render')
      const card = driver.locator('.kit-files-card', { hasText: 'My Identity Documents' })
      await card.waitFor({ state: 'visible', timeout: 30000 })
      await card.scrollIntoViewIfNeeded()
      const t0 = Date.now()
      while (!idResponses.some((r) => r.path.endsWith('/cdl-front')) && Date.now() - t0 < 10000) await driver.waitForTimeout(200)
      const net = idResponses.find((r) => r.path.endsWith('/cdl-front'))
      const dec = await driver.evaluate(async () => {
        const img = new Image()
        img.src = '/api/driver/me/identity-file/cdl-front'
        try { await img.decode(); return { ok: true, w: img.naturalWidth, h: img.naturalHeight } } catch { return { ok: false } }
      })
      ok = !!net && net.status === 200 && /^image\//i.test(net.ct) && dec.ok && dec.w > 0
      observed = `CDL Front thumbnail request ${net ? `${net.status} ${net.ct}` : 'not seen'}; decodes as an image: ${dec.ok ? `${dec.w}×${dec.h}` : 'no'}`
      await caption(driver, `Step 11a — result: ${observed}`)
    } catch (e) { observed = `error: ${e.message}` }
    s = await shot(driver, '11a-driver-kit-cdl', { mask: [driver.locator('.kit-file-thumb:not(.pdf)'), driver.locator('.kit-avatar-img')] })
    record({ step: '11a', title: 'Driver Kit tab: CDL Front renders', expected: 'Renders; served as image/* (both phases)', observed, verdict: verdict(ok), shot: s })

    const cdlCases = [
      { id: '11b', k: 'html', expect: '404', note: 'required case' },
      { id: '11c', k: 'htmlAsJpeg', expect: '404' },
      { id: '11d', k: 'malformed', expect: '404' },
      { id: '11e', k: 'pngAsJpeg', expect: 'png' },
      { id: '11f', k: 'pdf', expect: 'pdf' },
    ]
    const expText = (e) => (e === '404' ? '404 JSON' : e === 'png' ? '200 image/png (bytes are a PNG)' : '200 application/pdf (regression — a real PDF CDL still serves)')
    if (!db || !appId) {
      for (const c of cdlCases) record({ step: c.id, title: `CDL front planted as ${PLANTS[c.k].label}`, expected: expText(c.expect), observed: db ? 'driver has no application' : skipWhy(), verdict: 'SKIP', shot: '' })
    } else {
      try {
        for (const c of cdlCases) {
          plant('job_applications', 'cdl_front', appId, PLANTS[c.k].value)
          const nav = await navigate(driver, `/api/driver/me/identity-file/cdl-front?qa=${c.id}-${stamp}`)
          const ok = c.expect === '404' ? nav.status === 404 && nav.isJson
            : c.expect === 'png' ? nav.status === 200 && /^image\/png/i.test(nav.contentType)
              : nav.status === 200 && /^application\/pdf/i.test(nav.contentType)
          const observed = `${nav.status} ${nav.contentType || '(no content-type)'}${nav.isJson ? `; body ${nav.bodyHead}` : /html/i.test(nav.contentType) ? '; the planted HTML was rendered as a page' : ''}${nav.download ? ' (the browser handled it as a download; status read with an in-page fetch)' : ''}`
          await caption(driver, `Step ${c.id} — CDL front planted as ${PLANTS[c.k].label} → GET /api/driver/me/identity-file/cdl-front answered ${nav.status} ${nav.contentType}; expected ${expText(c.expect)}`)
          const shotName = `${c.id}-cdl-front-${c.k}`
          const sh = await shot(driver, shotName)
          record({ step: c.id, title: `CDL front planted as ${PLANTS[c.k].label}; driver opens /api/driver/me/identity-file/cdl-front`, expected: expText(c.expect), observed, verdict: verdict(ok), shot: sh })
        }
      } finally {
        const r = restoreAll()
        console.log(`  restore: ${r.join('; ')}`)
      }
    }
  }

  // ============ R3 — identity PDFs are served as attachments; images stay inline (planted, local only)
  {
    const JPEG_DATA_R3 = `data:image/jpeg;base64,${IMG.jpeg.toString('base64')}`
    const cases = [
      { id: 'R3a', k: 'pdf', label: 'a real PDF (data:application/pdf)', value: PLANTS.pdf.value, expected: '200 application/pdf with Content-Disposition: attachment; filename="CDL-Front.pdf" (the Kit\'s own name; tapping the Kit card downloads CDL-Front.pdf)' },
      { id: 'R3b', k: 'jpeg', label: 'a real JPEG (data:image/jpeg)', value: JPEG_DATA_R3, expected: '200 image/jpeg with no attachment header — served inline; the Kit thumbnail renders' },
    ]
    if (!db || !appId) {
      for (const c of cases) record({ step: c.id, title: `CDL front planted as ${c.label}; the driver requests /api/driver/me/identity-file/cdl-front`, expected: c.expected, observed: db ? 'driver has no application' : skipWhy(), verdict: 'SKIP', shot: '' })
    } else {
      // The route answers Cache-Control: private, max-age=3600, and the Kit
      // tab's own URL has no cache-buster: keep every earlier response of it
      // (the real CDL, step 11a) from answering for a planted value.
      const cdp = await driverCtx.newCDPSession(driver)
      await cdp.send('Network.enable').catch(() => {})
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {})
      let pdfAttachment = false
      try {
        for (const c of cases) {
          let observed; let ok = false; let s
          try {
            plant('job_applications', 'cdl_front', appId, c.value)
            await cdp.send('Network.clearBrowserCache').catch(() => {})
            // A fresh driver payload, so the Kit card shows the planted type.
            await driver.goto(`${BASE_URL}/driver`)
            await driver.locator('.driver-app').waitFor({ state: 'visible', timeout: 30000 })
            await driver.locator('.load-sub-tabs').waitFor({ state: 'visible', timeout: 45000 })
            await driver.locator('.van-tabbar-item', { hasText: 'Kit' }).click()
            const card = driver.locator('.kit-files-card', { hasText: 'My Identity Documents' }).locator('.kit-file-card', { hasText: 'CDL Front' })
            await card.waitFor({ state: 'visible', timeout: 30000 })
            await card.scrollIntoViewIfNeeded()
            const cardType = (await card.locator('.kit-file-type').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
            // What the server sends (no cache), read in the signed-in page.
            const h = await driver.evaluate(async () => {
              const r = await fetch('/api/driver/me/identity-file/cdl-front', { cache: 'no-store', credentials: 'same-origin' })
              await r.arrayBuffer()
              return { status: r.status, ct: r.headers.get('content-type') || '', cd: r.headers.get('content-disposition') }
            })
            let ui = ''
            if (c.k === 'pdf') {
              await caption(driver, `Step ${c.id} — CDL Front planted as ${c.label}; the Kit card reads "${cardType}" → tap it`)
              const dl = await clickForDownload(driverCtx, driver, card)
              if (dl) {
                const p = await dl.path().catch(() => null)
                const head = p ? fs.readFileSync(p).subarray(0, 5).toString('latin1') : ''
                ui = `tapping the card downloaded "${dl.suggestedFilename()}"${head ? ` (${head === '%PDF-' ? 'the planted PDF' : `bytes "${head}"`})` : ''}`
                await dl.delete().catch(() => {})
              } else ui = 'tapping the card started no download within 15 s'
              pdfAttachment = /attachment/i.test(h.cd || '')
              ok = h.status === 200 && /^application\/pdf/i.test(h.ct) && /^attachment\s*;\s*filename="cdl-front\.pdf"(\s*;.*)?$/i.test(h.cd || '')
            } else {
              const dec = await driver.evaluate(async () => {
                const img = new Image()
                img.src = '/api/driver/me/identity-file/cdl-front'
                try { await img.decode(); return { ok: true, w: img.naturalWidth, h: img.naturalHeight } } catch { return { ok: false } }
              })
              ui = `the Kit card reads "${cardType}" and its image ${dec.ok ? `decodes ${dec.w}×${dec.h}` : 'does NOT decode'}`
              ok = h.status === 200 && /^image\/jpeg/i.test(h.ct) && !/attachment/i.test(h.cd || '') && dec.ok
            }
            observed = `${h.status} ${h.ct}; Content-Disposition: ${h.cd === null ? '(none)' : `"${h.cd}"`}; ${ui}`
            await caption(driver, `Step ${c.id} — result: ${observed}`)
            // Mask the driver's real documents and avatar; the planted CDL Front card is a test fixture.
            s = await shot(driver, `${c.id.toLowerCase()}-cdl-front-${c.k}`, { mask: [driver.locator('.kit-file-card').filter({ hasNotText: 'CDL Front' }).locator('.kit-file-thumb:not(.pdf)'), driver.locator('.kit-avatar-img')] })
          } catch (e) { observed = `error: ${e.message}` }
          const v = c.k === 'jpeg' && ok && !pdfAttachment ? 'PASS (vacuous)' : verdict(ok)
          if (v === 'PASS (vacuous)') observed += ' — vacuous: this build sends no attachment header even for the PDF (see R3a)'
          record({ step: c.id, title: `CDL front planted as ${c.label}; the driver requests /api/driver/me/identity-file/cdl-front`, expected: c.expected, observed, verdict: v, shot: s })
        }
      } finally {
        const r = restoreAll()
        console.log(`  restore: ${r.join('; ')}`)
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {})
        await cdp.detach().catch(() => {})
      }
    }
  }

  // ============ R10 — driver file routes: the CDL is never kept by the browser;
  // the truck photo is revalidated with the server (and so the session) on every use.
  {
    let observed; let ok = false; let s = ''
    try {
      const h = await driver.evaluate(async () => {
        const out = {}
        const r1 = await fetch('/api/driver/me/identity-file/cdl-front', { cache: 'no-store', credentials: 'same-origin' })
        await r1.arrayBuffer()
        out.id = { status: r1.status, cc: r1.headers.get('cache-control') }
        const r2 = await fetch('/api/driver/me/truck-photo', { cache: 'no-store', credentials: 'same-origin' })
        await r2.arrayBuffer()
        out.photo = { status: r2.status, cc: r2.headers.get('cache-control'), etag: r2.headers.get('etag') }
        if (out.photo.etag) {
          const r3 = await fetch('/api/driver/me/truck-photo', { cache: 'no-store', credentials: 'same-origin', headers: { 'If-None-Match': out.photo.etag } })
          const b = await r3.arrayBuffer()
          out.reval = { status: r3.status, bytes: b.byteLength }
        }
        return out
      })
      // No identity file on this server's data (staging's refresh strips them) → not scored.
      const idOk = h.id.status === 404 ? null : /^private,\s*no-store$/i.test(h.id.cc || '')
      const photoOk = h.photo.status === 200 && /^private,\s*no-cache$/i.test(h.photo.cc || '') && !!h.photo.etag &&
        !!h.reval && h.reval.status === 304 && h.reval.bytes === 0
      ok = photoOk && idOk !== false
      observed = `identity-file ${h.id.status} Cache-Control: ${h.id.cc === null ? '(none)' : `"${h.id.cc}"`}` +
        `${idOk === null ? ' (no identity file on this server — not scored)' : ''}; ` +
        `truck-photo ${h.photo.status} Cache-Control: ${h.photo.cc === null ? '(none)' : `"${h.photo.cc}"`}, ETag ${h.photo.etag ? 'present' : '(none)'}` +
        `${h.reval ? `; revalidation with If-None-Match → ${h.reval.status} (${h.reval.bytes} bytes)` : ''}`
      await caption(driver, `Step R10 — cache headers: ${observed}`)
      s = await shot(driver, 'r10-cache-headers', { mask: [driver.locator('.kit-file-thumb:not(.pdf)'), driver.locator('.kit-avatar-img')] })
    } catch (e) { observed = `error: ${e.message}` }
    record({
      step: 'R10',
      title: 'Driver file routes: the CDL is never kept by the browser; the truck photo is revalidated on every use',
      expected: 'identity-file Cache-Control "private, no-store"; truck-photo "private, no-cache" with an ETag, and a matching If-None-Match answers 304 with no body',
      observed, verdict: verdict(ok), shot: s,
    })
  }
}

// ================================================================ sign-out / sign-in section (S1-S3)
// Run alone with ONLY=signout. The fix under test (the AFTER behaviour):
//   (a) sign-out finishes with a full page load of /login (location.replace);
//   (b) signing in as a DIFFERENT person than the page last showed (e.g. after a
//       session expired without a sign-out) finishes with a full page load of that
//       person's home page;
//   (c) the same person again, or a first sign-in on a fresh page, keeps today's
//       in-app navigation.
// The evidence is a JS global planted on the page, window.__qaMarker: a full page
// load discards it; an in-app route change (router.push) keeps it.
// Each case gets its own browser context, so no case inherits another's cookie.
const MARK = 'page-1'
const NO_MARK = 'undefined'
const THROTTLE = { latencyMs: Number(process.env.S3_LATENCY_MS || 2500), kbps: Number(process.env.S3_KBPS || 24) }
// ⚠️ Mirror of server.js BROKER_WITHHELD_RE: the columns /api/dashboard blanks for
// every role but Super Admin — the one thing in that payload only a Super Admin gets.
const BROKER_WITHHELD_RE = /broker|phone|e-?mail|contact|\bfax\b|mobile|\bcell\b/i

// page.evaluate that survives the moment a navigation replaces the document.
async function evalSafe(page, fn, arg) {
  for (let i = 0; ; i++) {
    try { return await page.evaluate(fn, arg) } catch (e) {
      if (i >= 20 || !/context was destroyed|navigat|Cannot find context|frame was detached/i.test(e.message)) throw e
      await page.waitForTimeout(250)
    }
  }
}
const plantMarker = (page) => evalSafe(page, (m) => { window.__qaMarker = m }, MARK)
const readMarker = (page) => evalSafe(page, () => (window.__qaMarker === undefined ? 'undefined' : String(window.__qaMarker)))
const markerText = (m) => (m === NO_MARK ? 'undefined (a fresh page: it was loaded again)' : `'${m}' (the same page: an in-app route change, no reload)`)

// Main-frame document requests from now on: a full page load makes one, an in-app route change none.
function trackDocuments(page) {
  const docs = []
  const on = (r) => { if (r.resourceType() === 'document' && r.frame() === page.mainFrame()) docs.push(new URL(r.url()).pathname) }
  page.on('request', on)
  return { docs, stop: () => page.off('request', on) }
}
const docsText = (d) => (d.length ? `${d.length} (${d.join(', ')})` : 'none')

// Who the server says this browser is (ids and roles only).
async function whoAmI(page) {
  const r = await api(page, 'GET', '/api/auth/session')
  return r.json?.authenticated
    ? { id: r.json.user?.id ?? null, text: `${r.json.user?.role} #${r.json.user?.id}` }
    : { id: null, text: `signed out (${r.status})` }
}
// The auth store's own view, read through the app's Pinia instance (read-only).
function authState(page) {
  return evalSafe(page, () => {
    const a = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia?.state?.value?.auth
    return a ? { isAuthenticated: a.isAuthenticated, isReconnecting: a.isReconnecting, id: a.user?.id ?? null, role: a.user?.role ?? null } : null
  })
}

// Sign in through the form ALREADY on screen. Never page.goto('/login') here: that
// is itself a fresh page, and would hide exactly what is being measured.
async function signInHere(page, who, username, password) {
  const form = page.locator('form.login-form')
  await form.waitFor({ state: 'visible', timeout: 60000 })
  await caption(page, `${who} signs in through the form on this same page`)
  await form.locator('input[autocomplete="username"]').fill(username)
  await form.locator('input[autocomplete="current-password"]').fill(password)
  const [resp] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/login' && r.request().method() === 'POST', { timeout: 60000 }),
    form.locator('button[type="submit"]').click(),
  ])
  if (resp.status() !== 200) throw new Error(`${who} login answered ${resp.status()}`)
}

// Land on `pathname`, see `ready`, then leave time for a late reload to happen.
async function settleOn(page, pathname, ready, settleMs = 1500) {
  await page.waitForURL((u) => u.pathname === pathname, { timeout: 60000 })
  await ready.waitFor({ state: 'visible', timeout: 60000 })
  await page.waitForLoadState('load')
  await page.waitForTimeout(settleMs)
}

const ADMIN_VP = { width: 1400, height: 900 }
async function freshPage(viewport) {
  const ctx = await browser.newContext({ viewport })
  ctx.setDefaultTimeout(20000)
  return { ctx, page: await ctx.newPage() }
}

// ---- S1: a sign-out button ends on a FRESH /login page
async function signOutCase({ step, who, creds, home, viewport, ready, button, buttonLabel, prefix }) {
  let observed; let ok = false
  const { ctx, page } = await freshPage(viewport)
  try {
    await login(page, `Step ${step} — ${who}`, creds.username, creds.password, home)
    await ready(page).waitFor({ state: 'visible', timeout: 45000 })
    await page.waitForTimeout(2500) // the page's first data lands
    await plantMarker(page)
    const histBefore = await evalSafe(page, () => history.length)
    await caption(page, `Step ${step} — ${who} on ${home}; window.__qaMarker = '${MARK}' planted. Press ${buttonLabel} → expect a FRESH /login page (the marker gone)`)
    await shot(page, `${prefix}-1-signed-in-marker`)
    const t = trackDocuments(page)
    await button(page).click()
    await settleOn(page, '/login', page.locator('form.login-form'))
    t.stop()
    const marker = await readMarker(page)
    const histAfter = await evalSafe(page, () => history.length)
    const me = await whoAmI(page)
    ok = marker === NO_MARK
    observed = `on /login: window.__qaMarker = ${markerText(marker)}; document loads: ${docsText(t.docs)}; ` +
      `history entries ${histBefore} → ${histAfter}${histAfter > histBefore ? ' (one added: Back returns to the signed-in URL)' : ' (replaced in place)'}; server session after: ${me.text}`
    await caption(page, `Step ${step} — result: ${observed}`)
  } catch (e) { observed = `error: ${e.message}` }
  const s = await shot(page, `${prefix}-2-after-signout`)
  await ctx.close().catch(() => {})
  record({ step, title: `${who} signs out with ${buttonLabel}`, expected: 'A full page load of /login (location.replace): window.__qaMarker undefined', observed, verdict: verdict(ok), shot: s })
}

// ---- S2: the session expires with no sign-out, and the app routes ITSELF to /login.
// How: /trucks is loaded while its session check gets no answer (a weak signal), so
// the auth store keeps the tab's saved user and keeps re-checking in the background.
// The cookie is then cleared, and the browser goes offline → online: the store's wake
// listener re-checks at once, the server answers "signed out", and the router's own
// guard sends the page to /login in-app (auth._reconnectNow → onSessionResolved →
// router.replace). This build has no other in-app route to /login without a sign-out:
// API 401s do not redirect, and a pushState+popstate to /login only changes the URL
// bar (the router stays on the page and no login form renders).
async function expiredSessionCase({ step, signer, signerWho, sameUser, prefix }) {
  let observed; let ok = false
  const notes = []
  const { ctx, page } = await freshPage(ADMIN_VP)
  const noAnswer = (route) => route.abort('internetdisconnected')
  try {
    await login(page, `Step ${step} — Super Admin`, CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
    await page.route('**/api/auth/session', noAnswer)
    await page.goto(`${BASE_URL}/trucks`)
    await page.locator('table.truck-table').waitFor({ state: 'visible', timeout: 45000 })
    await page.waitForTimeout(1000)
    const st = await authState(page)
    notes.push(`/trucks loaded with its session check unanswered → ${st ? `the store shows ${st.role} #${st.id}, reconnecting=${st.isReconnecting}` : 'store not readable'}`)
    await plantMarker(page)
    await caption(page, `Step ${step} — Super Admin on /trucks (data loaded; this tab's session check retries in the background). window.__qaMarker = '${MARK}'. Next: the session cookie disappears (it "expires") — nobody signs out`)
    await shot(page, `${prefix}-1-trucks-marker`)
    await ctx.clearCookies()
    await page.unroute('**/api/auth/session', noAnswer)
    const t0 = Date.now()
    await ctx.setOffline(true)
    await page.waitForTimeout(300)
    await ctx.setOffline(false) // the browser's own 'online' event
    await page.waitForURL((u) => u.pathname === '/login', { timeout: 60000 })
    const routedMs = Date.now() - t0
    await settleOn(page, '/login', page.locator('form.login-form'), 1000)
    const atLogin = await readMarker(page)
    notes.push(`offline → online: the app's background check answered "signed out" and the app routed itself to /login ${routedMs} ms later; marker there ${atLogin === MARK ? `'${MARK}' (in-app, no reload)` : `${atLogin} (the page had already been loaded again)`}`)
    await caption(page, `Step ${step} — the app routed itself to /login (marker ${atLogin === MARK ? `still '${MARK}'` : 'gone'}). Now ${signerWho} signs in on this page`)
    await shot(page, `${prefix}-2-login-in-app`)
    const t = trackDocuments(page)
    await signInHere(page, `Step ${step} — ${signerWho}`, signer.username, signer.password)
    await settleOn(page, '/dashboard', page.locator('h2', { hasText: 'Operations Dashboard' }))
    t.stop()
    const marker = await readMarker(page)
    const me = await whoAmI(page)
    const isSigner = String(me.id) === String(signer.userId)
    ok = isSigner && (sameUser ? marker === MARK : marker === NO_MARK)
    observed = `${notes.join('; ')}; after ${signerWho} signed in: on ${new URL(page.url()).pathname}, window.__qaMarker = ${markerText(marker)}; ` +
      `document loads: ${docsText(t.docs)}; server session: ${me.text}${isSigner ? '' : ' (NOT who signed in)'}`
    await caption(page, `Step ${step} — result: ${observed}`)
  } catch (e) { observed = `${notes.length ? `${notes.join('; ')}; ` : ''}error: ${e.message}` }
  const s = await shot(page, `${prefix}-3-after-signin`)
  await ctx.close().catch(() => {})
  record({
    step,
    title: sameUser
      ? 'Control: session expired (no sign-out) on the Super Admin\'s /trucks; the SAME Super Admin signs back in on that page'
      : 'Session expired (no sign-out) on the Super Admin\'s /trucks; the Dispatcher signs in on that page',
    expected: sameUser
      ? `In-app navigation to /dashboard, as today: window.__qaMarker still '${MARK}'; the session is the Super Admin's`
      : 'A full page load of the Dispatcher\'s home (/dashboard): window.__qaMarker undefined; the session is the Dispatcher\'s',
    observed, verdict: verdict(ok), shot: s,
  })
}

// The Super-Admin-only part of an /api/dashboard payload: its broker/contact cells.
// Values stay in memory (they are PII); only counts are ever written out.
function withheldOf(p) {
  const hs = (p?.jobTrackingHeaders || []).filter((h) => BROKER_WITHHELD_RE.test(String(h ?? '')))
  const byCell = new Map() // `${list}|${_rowIndex}|${header}` -> non-empty value
  const values = new Set()
  for (const k of ['unassignedJobs', 'activeJobs', 'completedJobs']) {
    for (const row of p?.[k] || []) for (const h of hs) {
      const v = String(row?.[h] ?? '').trim()
      if (v) { byCell.set(`${k}|${row?._rowIndex}|${h}`, v); if (v.length >= 4) values.add(v) }
    }
  }
  return { headers: hs.length, cells: byCell.size, byCell, values: [...values].slice(0, 500) }
}
// Cells the Super Admin's copy carries and the Dispatcher's does not (blanked, or a
// JSON contact reduced to its name): exactly what "only a Super Admin gets".
function superAdminOnlyCells(sa, disp) {
  let n = 0
  for (const [key, v] of sa.byCell) if (disp.byCell.get(key) !== v) n++
  return n
}
// In-page: what the dashboard shows, and what its store holds. Self-contained (serialized).
function dashboardProbe({ saTs, saValues }) {
  const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia
  const data = pinia?.state?.value?.dashboard?.data ?? null
  const RE = /broker|phone|e-?mail|contact|\bfax\b|mobile|\bcell\b/i
  let withheldCells = 0
  if (data) {
    const hs = (data.jobTrackingHeaders || []).filter((h) => RE.test(String(h ?? '')))
    for (const k of ['unassignedJobs', 'activeJobs', 'completedJobs']) {
      for (const row of data[k] || []) for (const h of hs) if (String(row?.[h] ?? '').trim()) withheldCells++
    }
  }
  const vis = (el) => !!el && el.getClientRects().length > 0
  const text = document.body?.innerText || ''
  return {
    path: location.pathname,
    piniaReadable: !!pinia,
    storeTs: data?.timestamp ?? null,
    storeIsSA: !!data && data.timestamp === saTs,
    withheldCells,
    kpiValues: [...document.querySelectorAll('.kpi-grid:not(.revenue-grid) .kpi-value')].filter(vis).map((e) => e.textContent.trim()),
    skeletons: [...document.querySelectorAll('.kpi-grid .animate-pulse')].filter(vis).length,
    rows: [...document.querySelectorAll('table tbody tr')].filter((tr) => vis(tr) && tr.querySelectorAll('td').length > 1).length,
    revenueShown: [...document.querySelectorAll('.revenue-grid')].some(vis),
    updated: [...document.querySelectorAll('.dash-header span')].map((e) => e.textContent.trim()).find(Boolean) || '',
    saValuesOnScreen: saValues.filter((v) => text.includes(v)).length,
  }
}
const kpiText = (p) => (p.kpiValues.length ? `KPI cards RENDERED [${p.kpiValues.join(' | ')}]` : p.skeletons ? `KPI skeleton (${p.skeletons} placeholders)` : 'no KPI cards')

// ---- S3: what the Dispatcher sees on the dashboard while their own fetch is in flight
async function residueCase() {
  const step = 'S3'
  let observed = ''; let v = 'FAIL'
  const { ctx, page } = await freshPage(ADMIN_VP)
  let cdp = null
  try {
    // 1. The Super Admin's dashboard with full data. Keep its payload's identity
    //    (its timestamp) and its Super-Admin-only values (memory only).
    let saPayload = null
    const onSaResp = async (r) => {
      if (saPayload || new URL(r.url()).pathname !== '/api/dashboard' || r.request().method() !== 'GET' || r.status() !== 200) return
      try { saPayload = await r.json() } catch { /* ignore */ }
    }
    page.on('response', onSaResp)
    await login(page, 'Step S3 — Super Admin', CREDS.superAdmin.username, CREDS.superAdmin.password, '/dashboard')
    await page.locator('.kpi-grid:not(.revenue-grid) .kpi-value').first().waitFor({ state: 'visible', timeout: 45000 })
    for (let i = 0; i < 100 && !saPayload; i++) await page.waitForTimeout(100)
    page.off('response', onSaResp)
    if (!saPayload?.timestamp) throw new Error('did not capture the Super Admin\'s /api/dashboard payload')
    const sa = withheldOf(saPayload)
    await page.waitForTimeout(1000)
    await caption(page, `Step S3 — the Super Admin's dashboard, full data (its payload carries ${sa.cells} broker/contact cells; a Dispatcher's copy blanks them or reduces them to a name). Next: sign out, throttle the network, and the Dispatcher signs in on this tab`)
    await shot(page, 's3-1-superadmin-dashboard')

    // 2. Sign out with the sidebar, whatever this build does (in-app, or a fresh page).
    const tOut = trackDocuments(page)
    await page.locator('a.nav-item', { hasText: 'Logout' }).first().click()
    await settleOn(page, '/login', page.locator('form.login-form'))
    tOut.stop()

    // 3. Throttle from here on (after the sign-out, so a build that reloads /login is not slowed).
    cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: THROTTLE.latencyMs,
      downloadThroughput: THROTTLE.kbps * 1024, uploadThroughput: THROTTLE.kbps * 1024,
    })

    // 4. The Dispatcher signs in on the same tab. Catch the moment their dashboard
    //    requests its own data; screenshot SHOT_DELAY_MS later, inside the throttle's
    //    latency floor (the route transition has settled by then, the fetch cannot
    //    have). `respAt` is the response HEADERS: while they are missing, the body —
    //    and so the store update — certainly is too.
    const SHOT_DELAY_MS = 700
    let reqAt = 0; let respAt = 0; let doneAt = 0; let dashReq = null
    let resolveReq
    const reqSeen = new Promise((r) => { resolveReq = r })
    const onReq = (r) => { if (!reqAt && new URL(r.url()).pathname === '/api/dashboard' && r.method() === 'GET') { reqAt = Date.now(); dashReq = r; resolveReq() } }
    const onResp = (r) => { if (dashReq && !respAt && r.request() === dashReq) respAt = Date.now() }
    const onDone = (r) => { if (dashReq && !doneAt && r === dashReq) doneAt = Date.now() }
    page.on('request', onReq)
    page.on('response', onResp)
    page.on('requestfinished', onDone)
    page.on('requestfailed', onDone)
    const tIn = trackDocuments(page)
    await signInHere(page, 'Step S3 — Dispatcher', CREDS.dispatcher.username, CREDS.dispatcher.password)
    await Promise.race([reqSeen, new Promise((r) => setTimeout(r, 90000))])
    if (!reqAt) throw new Error('the Dispatcher\'s dashboard never requested /api/dashboard within 90 s')
    await page.waitForTimeout(SHOT_DELAY_MS)
    await caption(page, `Step S3 — the Dispatcher's dashboard, ${SHOT_DELAY_MS} ms after it requested /api/dashboard (its own data is still in flight)`, false)
    const s2 = await shot(page, 's3-2-dispatcher-dashboard-fetch-in-flight')
    const shotAt = Date.now()
    const inFlightAtShot = !respAt
    const now = await evalSafe(page, dashboardProbe, { saTs: saPayload.timestamp, saValues: sa.values })
    const inFlightAfterProbe = !respAt

    // 5. Let the Dispatcher's own payload land (body complete, store updated), for comparison.
    for (let i = 0; i < 900 && !doneAt; i++) await page.waitForTimeout(100)
    let later = null
    for (let i = 0; i < 40; i++) {
      later = await evalSafe(page, dashboardProbe, { saTs: saPayload.timestamp, saValues: sa.values })
      if (!later.storeIsSA && later.storeTs) break
      await page.waitForTimeout(250)
    }
    tIn.stop()
    const me = await whoAmI(page)
    // The Dispatcher's own copy, to count what in the Super Admin's copy they never get.
    let saOnly = null; let dispCells = null
    try {
      const disp = withheldOf(await (await dashReq.response())?.json())
      saOnly = superAdminOnlyCells(sa, disp)
      dispCells = disp.cells
    } catch { /* body unavailable: reported as '?' */ }
    page.off('request', onReq)
    page.off('response', onResp)
    page.off('requestfinished', onDone)
    page.off('requestfailed', onDone)

    const dataOnScreen = now.kpiValues.length > 0 || now.rows > 0 || /^Updated/i.test(now.updated)
    const fresh = !dataOnScreen && !now.storeTs
    if (!inFlightAtShot) v = 'INFO'
    else if (dataOnScreen) v = 'FAIL'
    else v = fresh ? 'PASS' : 'FAIL'
    observed =
      `sign-out: document loads ${docsText(tOut.docs)}; sign-in as the Dispatcher: document loads ${docsText(tIn.docs)}. ` +
      `Dispatcher's /api/dashboard: response headers after ${respAt ? respAt - reqAt : '?'} ms, body complete after ${doneAt ? doneAt - reqAt : '?'} ms; screenshot taken ${shotAt - reqAt} ms after it was requested, ` +
      `${inFlightAtShot ? 'BEFORE its response' : 'AFTER its response (window missed — not scored)'}${inFlightAfterProbe ? '' : ' (the response landed during the DOM probe)'}. ` +
      `On screen then: ${kpiText(now)}; ${now.rows} load rows listed; header "${now.updated}"; Revenue grid (Super Admin only, gated by role on the client) ${now.revenueShown ? 'SHOWN' : 'not shown'}. ` +
      `The page's dashboard store held ${now.storeTs ? (now.storeIsSA ? 'the SUPER ADMIN\'S payload (its timestamp)' : 'a payload with another timestamp') : 'nothing'}` +
      `${now.piniaReadable ? '' : ' (store not readable)'}: ${now.withheldCells} non-empty broker/contact cells` +
      `${now.storeIsSA ? `, ${saOnly ?? '?'} of them Super-Admin-only (the Dispatcher's own copy has ${dispCells ?? '?'} non-empty, the rest blanked or reduced to a name)` : ''}; ` +
      `${now.saValuesOnScreen} of the Super Admin's broker/contact values appeared as text (the tabs hide those columns for every role). ` +
      `After the Dispatcher's own response: ${kpiText(later)}; store ${later.storeIsSA ? 'STILL the Super Admin\'s' : 'the Dispatcher\'s own payload'}; server session ${me.text}. ` +
      `Throttle: CDP Network.emulateNetworkConditions +${THROTTLE.latencyMs} ms per request, ${THROTTLE.kbps} KB/s each way, applied after the sign-out.`
    await caption(page, `Step S3 — result: ${v}. ${kpiText(now)} while the Dispatcher's own fetch was in flight; store held ${now.storeIsSA ? 'the Super Admin\'s payload' : (now.storeTs ? 'another payload' : 'nothing')}`)
    await shot(page, 's3-3-dispatcher-dashboard-loaded')
    record({
      step,
      title: 'Visible residue: Super Admin dashboard → sign out → the Dispatcher signs in on the same tab (network throttled); screenshot while the Dispatcher\'s /api/dashboard is in flight',
      expected: 'A fresh page (skeleton / "Loading..."): nothing from the previous account on screen or in the page\'s store',
      observed, verdict: v, shot: s2,
    })
  } catch (e) {
    const s = await shot(page, 's3-error')
    record({ step, title: 'Visible residue after sign-out → Dispatcher sign-in (network throttled)', expected: 'A fresh page (skeleton / empty)', observed: `${observed}error: ${e.message}`, verdict: 'FAIL', shot: s })
  } finally {
    if (cdp) {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {})
      await cdp.detach().catch(() => {})
    }
    await ctx.close().catch(() => {})
  }
}

async function signoutSection() {
  meta.ids.superAdminUser = CREDS.superAdmin.userId
  meta.ids.driverUser = CREDS.driver.userId
  if (CREDS.dispatcher) meta.ids.dispatcherUser = CREDS.dispatcher.userId
  const skip = (step, title) => record({ step, title, expected: '—', observed: 'SKIPPED — creds.json has no dispatcher login (run setup-db.cjs)', verdict: 'SKIP', shot: '' })

  await signOutCase({
    step: 'S1a', who: 'Super Admin', creds: CREDS.superAdmin, home: '/dashboard', viewport: ADMIN_VP,
    ready: (p) => p.locator('.kpi-grid:not(.revenue-grid) .kpi-value').first(),
    button: (p) => p.locator('a.nav-item', { hasText: 'Logout' }).first(),
    buttonLabel: 'the sidebar\'s Logout', prefix: 's1a',
  })
  await signOutCase({
    step: 'S1b', who: 'Driver', creds: CREDS.driver, home: '/driver', viewport: { width: DVW, height: DVH },
    ready: (p) => p.locator('button.header-btn.danger', { hasText: 'Logout' }).first(),
    button: (p) => p.locator('button.header-btn.danger', { hasText: 'Logout' }).first(),
    buttonLabel: 'the driver app\'s Logout button', prefix: 's1b',
  })
  if (CREDS.dispatcher) {
    await expiredSessionCase({ step: 'S2a', signer: CREDS.dispatcher, signerWho: 'the Dispatcher', sameUser: false, prefix: 's2a' })
  } else skip('S2a', 'Session expired; the Dispatcher signs in on that page')
  await expiredSessionCase({ step: 'S2b', signer: CREDS.superAdmin, signerWho: 'the same Super Admin', sameUser: true, prefix: 's2b' })
  if (CREDS.dispatcher) await residueCase()
  else skip('S3', 'Visible residue after sign-out → Dispatcher sign-in')
}

async function cleanup() {
  if (ONLY === 'signout') {
    // Nothing planted, no trucks made: the sign-out section closes its own contexts.
    try { await browser?.close() } catch { /* ignore */ }
    return
  }
  // ============ Step 12 — restore planted values, delete the test truck(s)
  const notes = []
  try { if (db && originals.size) notes.push(...restoreAll()) } catch (e) { notes.push(`restore error: ${e.message}`) }
  if (db) notes.push(fs.existsSync(JOURNAL) ? 'plant journal still present!' : 'all planted values restored')
  let ok = true
  if (admin) {
    try {
      await admin.goto(`${BASE_URL}/trucks`)
      await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
      await caption(admin, `Step 12 — clean-up: restore planted values, delete the test trucks (${UNIT}, -B, -R9, ${INV_UNIT})`)
      const all = await api(admin, 'GET', '/api/trucks')
      for (const t of (all.json?.trucks || []).filter((t) => (t.UnitNumber || '').startsWith(UNIT) || t.UnitNumber === INV_UNIT)) created.add(t.id)
      for (const id of created) {
        const d = await api(admin, 'DELETE', `/api/trucks/${id}`)
        notes.push(`DELETE /api/trucks/${id} → ${d.status}${d.json?.code ? ` ${d.json.code}` : ''}`)
        if (d.status !== 200) ok = false
      }
      const after = await api(admin, 'GET', '/api/trucks')
      const left = (after.json?.trucks || []).filter((t) => (t.UnitNumber || '').startsWith('QA-TEST-'))
      if (left.length) { ok = false; notes.push(`still listed: ${left.map((t) => `#${t.id}`).join(', ')}`) } else notes.push('no QA-TEST truck left')
      await admin.reload()
      await admin.locator('table.truck-table').waitFor({ state: 'visible', timeout: 30000 })
      await caption(admin, `Step 12 — clean-up done: ${notes.join(' · ')}`)
    } catch (e) { ok = false; notes.push(`error: ${e.message}`) }
  }
  const s = admin ? await shot(admin, '12-cleanup') : ''
  record({ step: '12', title: 'Restore planted values; delete every test truck this run made (A, B, R9, the investor\'s)', expected: 'Originals restored; DELETE 200 each; no QA-TEST truck left', observed: notes.join('; '), verdict: verdict(ok), shot: s })
  try { await browser?.close() } catch { /* ignore */ }
  try { db?.close() } catch { /* ignore */ }
}

let exitCode = 0
try {
  await main()
} catch (e) {
  exitCode = 1
  record({ step: '!', title: 'Run aborted', expected: '', observed: e.stack?.split('\n').slice(0, 3).join(' ') || String(e), verdict: 'FAIL', shot: '' })
} finally {
  await cleanup()
  writeResults(true)
  console.log(`\nresults: ${RESULTS}\nscreenshots: ${SHOTS}`)
}
process.exit(exitCode)
