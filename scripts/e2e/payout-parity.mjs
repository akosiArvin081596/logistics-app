#!/usr/bin/env node
// Payout parity: every existing investor's payout figures, compared between two
// builds of the app, to the cent and to the word.
//
//   fnm exec --using=22.23.2 node scripts/e2e/payout-parity.mjs
//
// What it does (LOCAL only; nothing leaves the machine but reads of the local sheet,
// and the statement renders' request for their template's Google Font):
//   1. Exports two builds into the work dir: REF_A and REF_B with `git archive`
//      (committed content only), or DIR_A / DIR_B, a checkout's working tree as it
//      stands. PATCH_A / PATCH_B apply a unified diff to that export only (a
//      throwaway mutation: the export is deleted at the end). Each export links the
//      main checkout's node_modules, client/node_modules, .env and Google key.
//   2. Takes ONE read-only `.backup()` of SOURCE_DB (default: the main checkout's
//      app.db), sets a random Super Admin password on that copy (the repo's own
//      reset script; the password lives in this process's memory only), then backs
//      the copy up once more: two private, identical databases, one per server.
//   3. Boots each build on its own copy with scripts/e2e/boot-server.sh (every
//      integration, mail, alert and autogen job off, 127.0.0.1, random ports), after
//      refusing a SPREADSHEET_ID that is unset, empty or production's. FLAG=on boots
//      B with INVESTOR_LEASE_PAYOUTS_ENABLED=true; A always runs with it off.
//   4. Signs the Super Admin in on each, then, for EVERY investor (GET /api/payouts
//      and the users with role Investor), sends the same requests to both servers
//      in the same order and compares the answers (README.md lists them). JSON is
//      compared deeply (values, types, keys and key order), CSV line by line, PDFs
//      by their extracted text, page by page. Status, content type and content
//      disposition are compared too.
//   5. On each server on its own: the portal's month (GET /api/investor,
//      production.monthlyEarnings[].payable) against the ledger (GET
//      /api/investor/payouts: recomputedAmount, and the row's amount while it is
//      open). A disagreement there is a pre-existing inconsistency: it is reported,
//      never fixed.
//   6. Stops both servers (their recorded PIDs only) and deletes the exports and the
//      database copies, whatever happened.
//
// Output: counts, owner ids, month keys and diff PATHS only; never a name, an email
// or an amount (the copies are real, unsanitized data). A summary is also written
// to <work dir>/parity-<tag>.md. Exit 0: no difference; 1: a difference or a
// failed request; 2: refused or could not set up.
//
// The only normalisations (each also listed in README.md):
//   N1  JSON: an ISO-8601 date-time at or after this run's start becomes
//       "<written during this run>" (a ledger row the reconcile creates and stamps).
//   N2  Documents (PDF text, CSV, content disposition): the run's own day(s), in
//       the formats the documents print their generation date, becomes "<run date>".
//
// Env:
//   REF_A / REF_B   git refs (default: main / HEAD)
//   DIR_A / DIR_B   a checkout's working tree instead of a ref (wins over REF_x)
//   PATCH_A / PATCH_B  a unified diff (-p1) applied to that side's export only
//   FLAG            off (default) | on: B boots with INVESTOR_LEASE_PAYOUTS_ENABLED=true
//   SOURCE_DB       the database to copy, opened read-only (default: <main checkout>/app.db)
//   PORT_A / PORT_B the ports (default: random free ports; 3000, 3003 and 5173 refused)
//   E2E_WORK_DIR    the work dir (default: $TMPDIR/logisx-e2e; see paths.cjs)
//   INVESTOR_LEASE_DOWNTIME / _PRORATE / _RETIREMENT  passed to both servers as set
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import paths from './paths.cjs'

const APP_ZONE = createRequire(import.meta.url)('../../lib/app-time.js').appTimeZone()

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROD_SHEET = '1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo'
const RESERVED_PORTS = new Set([3000, 3003, 5173])
const LINKS = ['node_modules', 'client/node_modules', '.env', 'service-account-key.json']
// Per server process, 15-minute windows: statementLimiter is 20 per IP, the report
// and tax-CSV limiters 20 per signed-in user. A server is restarted (same copy, same
// session) before a window would run out, so a run never meets a 429.
const LIMITS = { statement: 20, report: 20, taxCsv: 20 }
const MAX_PATHS = 25 // diff paths listed per compared request

function die(msg, code = 2) { console.error(`payout-parity: ${msg}`); process.exit(code) }
const log = (s) => console.log(s)

// ---------------------------------------------------------------- preflight
const FLAG = String(process.env.FLAG || 'off').toLowerCase()
if (!['off', 'on'].includes(FLAG)) die(`FLAG must be off or on, got "${process.env.FLAG}"`)
if (paths.wantedNode() && process.version !== paths.wantedNode()) {
  die(`running Node ${process.version}, but .nvmrc pins ${paths.wantedNode()} (better-sqlite3's ABI, here and in both servers). ` +
    `Run: fnm exec --using=${paths.wantedNode().slice(1)} node scripts/e2e/payout-parity.mjs`)
}
let WORK, MAIN, SOURCE_DB, Database
try {
  WORK = paths.workDir()
  MAIN = fs.realpathSync(paths.mainCheckout())
  SOURCE_DB = fs.realpathSync(process.env.SOURCE_DB || path.join(MAIN, 'app.db'))
  Database = paths.appRequire('better-sqlite3')
} catch (e) { die(e.message) }

// The sheet both servers will read: the environment's SPREADSHEET_ID when set (it
// beats .env, and boot-server.sh passes it on), else the linked .env's. Never printed.
function refuseProductionSheet() {
  let id = process.env.SPREADSHEET_ID
  let from = 'the environment'
  if (id === undefined) {
    const envFile = path.join(MAIN, '.env')
    if (!fs.existsSync(envFile)) die(`no .env in the main checkout (${MAIN}) to read SPREADSHEET_ID from`)
    id = paths.appRequire('dotenv').parse(fs.readFileSync(envFile)).SPREADSHEET_ID
    from = envFile
  }
  id = String(id ?? '').trim()
  if (!id) die(`refusing: SPREADSHEET_ID is unset or empty in ${from}; server.js would fall back to PRODUCTION's sheet`)
  if (id === PROD_SHEET) die(`refusing: SPREADSHEET_ID in ${from} is PRODUCTION's sheet`)
}
refuseProductionSheet()

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
function resolveSource(side) {
  const dir = process.env[`DIR_${side}`]
  const patch = process.env[`PATCH_${side}`] ? path.resolve(process.env[`PATCH_${side}`]) : ''
  if (patch && !fs.existsSync(patch)) die(`PATCH_${side} does not exist: ${patch}`)
  if (dir) {
    let top
    try { top = git(['-C', path.resolve(dir), 'rev-parse', '--show-toplevel']) } catch { die(`DIR_${side} is not a git checkout: ${dir}`) }
    const sha = git(['-C', top, 'rev-parse', 'HEAD'])
    const dirty = git(['-C', top, 'status', '--porcelain']) !== ''
    return { side, kind: 'dir', dir: top, sha, patch, text: `the working tree of ${top} (HEAD ${sha.slice(0, 7)}${dirty ? ', with uncommitted changes' : ', clean'})` }
  }
  const ref = process.env[`REF_${side}`] || (side === 'A' ? 'main' : 'HEAD')
  let sha
  try { sha = git(['-C', paths.REPO, 'rev-parse', '--verify', `${ref}^{commit}`]) } catch { die(`REF_${side}=${ref} is not a commit`) }
  return { side, kind: 'ref', ref, sha, patch, text: `${ref} = ${sha.slice(0, 7)}` }
}
const SRC = { A: resolveSource('A'), B: resolveSource('B') }

// ---------------------------------------------------------------- run state + cleanup
const RUN_START = new Date()
const stamp = RUN_START.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
const TAG = `${stamp}-flag-${FLAG}`
const RUN_DIR = path.join(WORK, `parity-${TAG}`)
const RESULTS = path.join(WORK, `parity-${TAG}.md`)
const sides = {
  A: { label: 'A', src: SRC.A, dir: path.join(RUN_DIR, 'build-a'), db: path.join(RUN_DIR, 'a.db'), flag: false, port: 0, booted: false, cookies: new Map(), used: {}, logErrors: [] },
  B: { label: 'B', src: SRC.B, dir: path.join(RUN_DIR, 'build-b'), db: path.join(RUN_DIR, 'b.db'), flag: FLAG === 'on', port: 0, booted: false, cookies: new Map(), used: {}, logErrors: [] },
}
const bothSides = [sides.A, sides.B]
const shellEnv = () => ({ ...process.env, NODE_BIN: process.execPath, E2E_WORK_DIR: WORK })

function stopSync(s) {
  if (!s.booted) return
  const r = spawnSync(path.join(HERE, 'stop-server.sh'), [String(s.port)], { env: shellEnv(), encoding: 'utf8' })
  log(`  ${s.label}: ${(r.stdout || r.stderr || '').trim().split('\n').pop()}`)
  s.booted = false
}
let cleaned = false
function cleanupSync() {
  if (cleaned) return
  cleaned = true
  log('cleanup:')
  for (const s of bothSides) stopSync(s)
  for (const s of bothSides) {
    // The links first, so nothing below can reach the main checkout's installs.
    for (const rel of LINKS) { try { fs.unlinkSync(path.join(s.dir, rel)) } catch { /* not linked */ } }
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(s.db + suffix) } catch { /* absent */ } }
    if (s.port) { try { fs.unlinkSync(path.join(WORK, `server-${s.port}.log`)) } catch { /* absent */ } }
  }
  if (fs.existsSync(RUN_DIR)) {
    const stray = []
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isSymbolicLink()) stray.push(p); else if (e.isDirectory()) walk(p) } }
    try { walk(RUN_DIR) } catch { /* partial */ }
    for (const p of stray) { try { fs.unlinkSync(p) } catch { /* gone */ } }
    fs.rmSync(RUN_DIR, { recursive: true, force: true })
  }
  log(`  removed ${RUN_DIR} (both builds, both database copies) and the two server logs`)
}
process.on('SIGINT', () => { try { cleanupSync() } finally { process.exit(130) } })
process.on('SIGTERM', () => { try { cleanupSync() } finally { process.exit(143) } })

// ---------------------------------------------------------------- builds + databases
function exportBuild(s) {
  fs.mkdirSync(s.dir, { recursive: true, mode: 0o700 })
  if (s.src.kind === 'ref') {
    const tar = `${s.dir}.tar`
    git(['-C', paths.REPO, 'archive', '--format=tar', '-o', tar, s.src.sha])
    execFileSync('tar', ['-xf', tar, '-C', s.dir])
    fs.unlinkSync(tar)
  } else {
    // Tracked files plus untracked, non-ignored ones: the working tree as it stands.
    // Symlinks are skipped (a checkout's links are its installs, linked below).
    const list = execFileSync('git', ['-C', s.src.dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean)
    for (const rel of list) {
      const from = path.join(s.src.dir, rel)
      let st
      try { st = fs.lstatSync(from) } catch { continue } // deleted in the working tree
      if (!st.isFile()) continue
      const to = path.join(s.dir, rel)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
    }
  }
  if (s.src.patch) {
    const r = spawnSync('patch', ['-p1', '--forward', '-s', '-d', s.dir, '-i', s.src.patch], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`PATCH_${s.label} did not apply: ${(r.stdout + r.stderr).trim().split('\n').slice(0, 3).join(' | ')}`)
  }
  for (const rel of LINKS) {
    const target = path.join(MAIN, rel)
    if (!fs.existsSync(target)) throw new Error(`the main checkout has no ${rel} to link (set it up first)`)
    fs.symlinkSync(target, path.join(s.dir, rel))
  }
  const differ = ['package.json', 'package-lock.json', 'client/package.json', 'client/package-lock.json']
    .filter((f) => { try { return !fs.readFileSync(path.join(s.dir, f)).equals(fs.readFileSync(path.join(MAIN, f))) } catch { return true } })
  if (differ.length) log(`  WARNING ${s.label}: ${differ.join(', ')} differ from the main checkout's; the linked installs may lack a dependency this build needs`)
}

async function makeDatabases() {
  const pw = crypto.randomBytes(18).toString('base64url')
  const src = new Database(SOURCE_DB, { readonly: true, fileMustExist: true })
  await src.backup(sides.A.db)
  src.close()
  fs.chmodSync(sides.A.db, 0o600)
  execFileSync(process.execPath, [path.join(paths.appDir(), 'scripts', 'reset-super-admin-password.js'), sides.A.db], {
    env: { ...process.env, NEW_PASSWORD: pw }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const a = new Database(sides.A.db, { fileMustExist: true })
  const sa = a.prepare("SELECT id FROM users WHERE username = 'super_admin' AND role = 'Super Admin'").get()
  if (!sa) { a.close(); throw new Error('the copy has no super_admin with role Super Admin') }
  a.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(sa.id)
  a.pragma('wal_checkpoint(TRUNCATE)')
  await a.backup(sides.B.db)
  a.close()
  fs.chmodSync(sides.B.db, 0o600)
  for (const s of bothSides) paths.workFile(s.db) // inside the work dir, a real file
  return pw
}

// ---------------------------------------------------------------- servers
function canListen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}
async function pickPort(want, taken) {
  if (want) {
    const p = Number(want)
    if (!Number.isInteger(p) || p < 1024 || p > 65535 || RESERVED_PORTS.has(p)) throw new Error(`port ${want} refused (1024-65535, not 3000, 3003 or 5173)`)
    return p
  }
  for (let i = 0; i < 100; i++) {
    const p = 20000 + crypto.randomInt(25000)
    if (RESERVED_PORTS.has(p) || p === taken) continue
    if (await canListen(p)) return p
  }
  throw new Error('no free port found')
}
function runScript(file, args, env) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}
async function boot(s) {
  const env = { ...shellEnv(), E2E_NO_CLIENT: '1', INVESTOR_LEASE_PAYOUTS_ENABLED: s.flag ? 'true' : 'false' }
  delete env.E2E_MAINTENANCE_NOTICE
  s.booted = true // from here a failed boot may still have left a process: stop-server.sh checks the PID
  const r = await runScript(path.join(HERE, 'boot-server.sh'), [s.dir, String(s.port), s.db], env)
  const lines = r.out.trim().split('\n')
  if (r.code !== 0) throw new Error(`${s.label} did not boot: ${lines.slice(-6).join(' | ')}`)
  s.used = {}
  return lines
}
// The error lines of a server's log so far. boot-server.sh starts each boot with an
// empty log, so they are collected before every restart and once at the end. The
// Google Maps refusals every local server logs (a blanked key) are left out.
function harvestLog(s) {
  let text = ''
  try { text = fs.readFileSync(path.join(WORK, `server-${s.port}.log`), 'utf8') } catch { /* no log */ }
  s.logErrors.push(...text.split('\n').filter((l) => /error/i.test(l) && !/Routes API|Distance Matrix|Geocod|Places|PERMISSION_DENIED|rate-con Drive|rate-con content/i.test(l)))
}
async function restartBoth(why) {
  log(`  restarting both servers (${why})`)
  for (const s of bothSides) harvestLog(s)
  for (const s of bothSides) stopSync(s)
  await Promise.all(bothSides.map(boot))
  for (const s of bothSides) {
    const r = await request(s, 'GET', '/api/auth/session')
    if (jsonOf(r)?.user?.role !== 'Super Admin') throw new Error(`${s.label}: the session did not survive the restart`)
  }
}

// ---------------------------------------------------------------- HTTP
async function request(s, method, url, body) {
  const headers = { 'X-Requested-With': 'XMLHttpRequest' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (s.cookies.size) headers.Cookie = [...s.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  const res = await fetch(`http://127.0.0.1:${s.port}${url}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(240000),
  })
  for (const c of res.headers.getSetCookie?.() || []) {
    const kv = c.split(';')[0]
    const i = kv.indexOf('=')
    if (i > 0) s.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim())
  }
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    disposition: res.headers.get('content-disposition') || '',
    bytes: Buffer.from(await res.arrayBuffer()),
  }
}
const jsonOf = (r) => { try { return JSON.parse(r.bytes.toString('utf8')) } catch { return null } }

// ---------------------------------------------------------------- normalisation
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/
const WRITTEN = '<written during this run>'
function normJson(v) {
  if (typeof v === 'string') {
    if (ISO_DT.test(v)) { const t = Date.parse(v); if (!Number.isNaN(t) && t >= RUN_START.getTime() - 1000) return WRITTEN }
    return v
  }
  if (Array.isArray(v)) return v.map(normJson)
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = normJson(v[k]); return o }
  return v
}
// N2: each day this run has touched, in the process's zone and in the business zone
// (APP_TIMEZONE), in the formats the documents print their generation date with.
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function runDayStrings() {
  const out = new Set()
  for (const t of [RUN_START, new Date()]) {
    for (const timeZone of [undefined, APP_ZONE]) {
      const o = timeZone ? { timeZone } : {}
      out.add(new Intl.DateTimeFormat('en-US', { ...o, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(t))
      out.add(new Intl.DateTimeFormat('en-US', { ...o, year: 'numeric', month: 'long', day: 'numeric' }).format(t))
      out.add(new Intl.DateTimeFormat('en-US', { ...o, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t))
      out.add(new Intl.DateTimeFormat('en-US', { ...o, year: 'numeric', month: 'numeric', day: 'numeric' }).format(t))
      out.add(new Intl.DateTimeFormat('en-CA', { ...o, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t))
    }
  }
  // Longest first, so "Wednesday, September 30, 2026" goes before "September 30, 2026".
  return [...out].sort((a, b) => b.length - a.length)
}
function normText(s) {
  let t = String(s)
  for (const d of runDayStrings()) t = t.replace(new RegExp(escRe(d), 'g'), '<run date>')
  return t
}

let pdfjs = null
async function pdfPages(bytes) {
  if (!pdfjs) {
    const p = path.join(paths.appDir(), 'client', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')
    if (!fs.existsSync(p)) throw new Error(`pdfjs-dist is not installed at ${p} (the client install)`)
    pdfjs = await import(pathToFileURL(p).href)
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  const doc = await task.promise
  const pages = []
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent()
      pages.push(tc.items.map((it) => (typeof it.str === 'string' ? it.str : '')).join(' '))
    }
  } finally { await task.destroy().catch(() => {}) }
  return pages
}

// ---------------------------------------------------------------- comparison
const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
function diffJson(a, b, p, out) {
  if (out.length >= MAX_PATHS) return
  const ta = kindOf(a); const tb = kindOf(b)
  if (ta !== tb) { out.push(`${p || '(root)'}: ${ta} vs ${tb}`); return }
  if (ta === 'array') {
    if (a.length !== b.length) out.push(`${p || '(root)'}: length ${a.length} vs ${b.length}`)
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffJson(a[i], b[i], `${p}[${i}]`, out)
    return
  }
  if (ta === 'object') {
    const ka = Object.keys(a); const kb = Object.keys(b)
    for (const k of ka) if (!(k in b)) out.push(`${p}.${k}: only in A`)
    for (const k of kb) if (!(k in a)) out.push(`${p}.${k}: only in B`)
    const shared = ka.filter((k) => k in b)
    if (shared.join('\u0000') !== kb.filter((k) => k in a).join('\u0000')) out.push(`${p || '(root)'}: key order differs`)
    for (const k of shared) diffJson(a[k], b[k], `${p}.${k}`, out)
    return
  }
  if (a !== b) out.push(`${p || '(root)'}: value differs`)
}
// Where two sequences (lines, words) part: the common prefix and suffix are cut
// away, so one inserted word reads as one span, not as every word after it.
function span(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (i === a.length && i === b.length) return null
  let j = 0
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++
  const range = (n) => (n - j > i + 1 ? `${i + 1}-${n - j}` : n - j === i + 1 ? `${i + 1}` : `none (at ${i + 1})`)
  return `${range(a.length)} in A (of ${a.length}), ${range(b.length)} in B (of ${b.length})`
}
function diffLines(a, b, what, out) {
  const d = span(a.split(/\r?\n/), b.split(/\r?\n/))
  if (d) out.push(`${what} lines differ: ${d}`)
}
function diffPages(pa, pb, out) {
  if (pa.length !== pb.length) out.push(`pdf: ${pa.length} vs ${pb.length} pages`)
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const d = span(normText(pa[i]).split(/\s+/).filter(Boolean), normText(pb[i]).split(/\s+/).filter(Boolean))
    if (d) out.push(`pdf page ${i + 1} words differ: ${d}`)
  }
}

const tally = { requests: 0, compared: 0, same: 0, differ: 0, byEndpoint: {} }
const diffs = [] // { endpoint, url, paths }
const perInvestorMonths = new Map()
async function compare(endpoint, url, { limit } = {}) {
  if (limit) {
    if (bothSides.some((s) => (s.used[limit] || 0) >= LIMITS[limit])) await restartBoth(`the ${limit} limiter's window is used up`)
    for (const s of bothSides) s.used[limit] = (s.used[limit] || 0) + 1
  }
  const [ra, rb] = await Promise.all(bothSides.map((s) => request(s, 'GET', url)))
  tally.requests += 2
  tally.compared++
  const e = (tally.byEndpoint[endpoint] ||= { compared: 0, differ: 0, answers: {} })
  e.compared++
  // What was compared, as evidence: status and body type of each side's answer.
  for (const r of [ra, rb]) {
    const type = /json/i.test(r.contentType) ? 'JSON' : /pdf/i.test(r.contentType) ? 'PDF' : /csv/i.test(r.contentType) ? 'CSV' : r.contentType || 'no type'
    const code = r.status !== 200 && type === 'JSON' ? jsonOf(r)?.code : ''
    const k = `${r.status} ${type}${code ? ` ${code}` : ''}`
    e.answers[k] = (e.answers[k] || 0) + 1
  }
  const out = []
  if (ra.status !== rb.status) out.push(`(status) ${ra.status} vs ${rb.status}`)
  if (ra.status === 429 || rb.status === 429) out.push('(status) 429: a rate limiter answered; the harness miscounted its budget')
  // A server error's own message is a diagnosis, not data: it is shown, cut short.
  const errText = (r) => (r.status >= 500 ? ` "${String(jsonOf(r)?.error ?? '').replace(/\s+/g, ' ').slice(0, 160)}"` : '')
  if (ra.status >= 500 || rb.status >= 500) out.push(`(status) a server error: A ${ra.status}${errText(ra)}, B ${rb.status}${errText(rb)}`)
  if (ra.contentType !== rb.contentType) out.push('(content-type) differs')
  if (normText(ra.disposition) !== normText(rb.disposition)) out.push('(content-disposition) differs')
  let ja = null; let jb = null
  if (/json/i.test(ra.contentType) && /json/i.test(rb.contentType)) {
    ja = jsonOf(ra); jb = jsonOf(rb)
    if (ja === null || jb === null) out.push('(body) not JSON')
    else {
      diffJson(normJson(ja), normJson(jb), '', out)
      if (out.length >= MAX_PATHS) out.push(`(listing stopped at ${MAX_PATHS} paths)`)
    }
  } else if (/pdf/i.test(ra.contentType) && /pdf/i.test(rb.contentType)) {
    diffPages(await pdfPages(ra.bytes), await pdfPages(rb.bytes), out)
  } else {
    diffLines(normText(ra.bytes.toString('utf8')), normText(rb.bytes.toString('utf8')), 'body', out)
  }
  if (out.length) { tally.differ++; e.differ++; diffs.push({ endpoint, url, paths: out }) } else tally.same++
  return { ja, jb, status: ra.status }
}

// ---------------------------------------------------------------- portal vs ledger
function portalVsLedger(s, owner, investor, ledger, findings) {
  const months = investor?.production?.monthlyEarnings
  const rows = ledger?.payouts
  if (!Array.isArray(months) || !Array.isArray(rows)) { findings.push({ side: s.label, owner, month: '-', check: 'portal or ledger response unreadable' }); return 0 }
  const byPeriod = new Map(rows.map((r) => [r.period, r]))
  const cur = ledger.currentMonth || {}
  let n = 0
  for (const m of months) {
    n++
    const row = byPeriod.get(m.month)
    if (row) {
      if (row.recomputedAmount !== m.payable) findings.push({ side: s.label, owner, month: m.month, check: 'portal payable != ledger recomputedAmount' })
      if (row.amount !== m.payable) {
        const settled = !!row.finalizedAt || row.status !== 'owed'
        findings.push({ side: s.label, owner, month: m.month, check: settled ? `settled row (${row.status}${row.finalizedAt ? ', finalized' : ''}): ledger amount != portal payable` : 'OPEN row: ledger amount != portal payable', info: settled })
      }
    } else if (m.month === cur.period) {
      if (cur.payableIfClosedNow !== m.payable) findings.push({ side: s.label, owner, month: m.month, check: 'current month: payableIfClosedNow != portal payable' })
    } else if (m.month < cur.period) {
      findings.push({ side: s.label, owner, month: m.month, check: 'completed month in the portal with no ledger row' })
    }
  }
  const portalMonths = new Set(months.map((m) => m.month))
  for (const r of rows) if (!portalMonths.has(r.period)) findings.push({ side: s.label, owner, month: r.period, check: 'ledger row outside the portal\'s months', info: true })
  return n
}

// ---------------------------------------------------------------- the run
async function main() {
  log(`payout parity, FLAG=${FLAG} (B ${FLAG === 'on' ? 'boots with INVESTOR_LEASE_PAYOUTS_ENABLED=true' : 'and A both boot with the lease flag off'})`)
  log(`  A: ${SRC.A.text}${SRC.A.patch ? `, patched with ${SRC.A.patch}` : ''}`)
  log(`  B: ${SRC.B.text}${SRC.B.patch ? `, patched with ${SRC.B.patch}` : ''}`)
  log(`  sheet: SPREADSHEET_ID is set and is not production's; work dir: ${WORK}`)
  fs.mkdirSync(RUN_DIR, { mode: 0o700 })
  for (const s of bothSides) exportBuild(s)
  log(`  exported both builds into ${RUN_DIR}`)
  const pw = await makeDatabases()
  log('  two identical private database copies made (source opened read-only; Super Admin password set on the copy only)')
  sides.A.port = await pickPort(process.env.PORT_A, 0)
  sides.B.port = await pickPort(process.env.PORT_B, sides.A.port)
  const bootLines = await Promise.all(bothSides.map(boot))
  for (const [i, s] of bothSides.entries()) {
    log(`  ${s.label} on 127.0.0.1:${s.port}: ${bootLines[i].filter((l) => /^(lease payouts|ready)/.test(l)).join('; ')}`)
  }
  for (const s of bothSides) {
    const r = await request(s, 'POST', '/api/auth/login', { username: 'super_admin', password: pw })
    if (r.status !== 200) throw new Error(`${s.label}: the Super Admin sign-in answered ${r.status}`)
  }
  log('  the Super Admin signed in on both')

  // Every investor: the payouts console's list, and every account with role Investor.
  const owners = new Set()
  const first = await compare('GET /api/payouts', '/api/payouts')
  for (const j of [first.ja, first.jb]) for (const inv of j?.investors || []) owners.add(Number(inv.ownerId))
  for (const s of bothSides) {
    const u = jsonOf(await request(s, 'GET', '/api/users'))
    for (const x of u?.users || []) if (x.Role === 'Investor') owners.add(Number(x.id))
  }
  const ownerList = [...owners].filter(Boolean).sort((a, b) => a - b)
  log(`  investors: ${ownerList.length} (owner ids ${ownerList.join(', ')})`)

  const findings = []
  let portalMonths = 0
  const statementQueue = []
  for (const owner of ownerList) {
    const q = `as_user_id=${owner}`
    const inv = await compare('GET /api/investor', `/api/investor?${q}`)
    const pay = await compare('GET /api/investor/payouts', `/api/investor/payouts?${q}`)
    for (const [s, investor, ledger] of [[sides.A, inv.ja, pay.ja], [sides.B, inv.jb, pay.jb]]) portalMonths += portalVsLedger(s, owner, investor, ledger, findings)
    const periods = new Set()
    for (const j of [pay.ja, pay.jb]) {
      for (const r of j?.payouts || []) periods.add(r.period)
      if (j?.currentMonth?.period) periods.add(j.currentMonth.period)
    }
    const sorted = [...periods].filter((p) => /^\d{4}-\d{2}$/.test(p)).sort()
    perInvestorMonths.set(owner, sorted.length)
    for (const p of sorted) await compare('GET /api/investor/payouts/:period/detail', `/api/investor/payouts/${p}/detail?${q}`)
    await compare('GET /api/investor/load-report (monthly, json)', `/api/investor/load-report?${q}&period=monthly&limit=53`)
    await compare('GET /api/investor/load-report (weekly, json)', `/api/investor/load-report?${q}&period=weekly&limit=53`)
    await compare('GET /api/investor/load-report (monthly, csv)', `/api/investor/load-report?${q}&period=monthly&limit=53&format=csv`)
    await compare('GET /api/investor/load-report (monthly, pdf)', `/api/investor/load-report?${q}&period=monthly&limit=53&format=pdf`)
    await compare('GET /api/investor/tax-csv', `/api/investor/tax-csv?${q}`, { limit: 'taxCsv' })
    await compare('GET /api/investor/report', `/api/investor/report?${q}`, { limit: 'report' })
    const ledgerPeriods = new Set([...(pay.ja?.payouts || []), ...(pay.jb?.payouts || [])].map((r) => r.period))
    for (const p of [...ledgerPeriods].sort()) statementQueue.push({ owner, period: p })
  }
  // After every investor's reconcile has run on both: the console once more.
  await compare('GET /api/payouts (after every reconcile)', '/api/payouts')
  // Statements last: they are the slow part (a Chromium render each) and the only
  // part that may need a restart for the limiter.
  for (const { owner, period } of statementQueue) {
    await compare('GET /api/investor/payouts/:period/statement', `/api/investor/payouts/${period}/statement?as_user_id=${owner}`, { limit: 'statement' })
  }

  // ---- report
  const monthsTotal = [...perInvestorMonths.values()].reduce((a, b) => a + b, 0)
  const problems = findings.filter((f) => !f.info)
  const infos = findings.filter((f) => f.info)
  const secs = Math.round((Date.now() - RUN_START.getTime()) / 1000)
  // What each server logged as an error (the logs are deleted with the run).
  const logged = bothSides.map((s) => {
    harvestLog(s)
    return { side: s.label, count: s.logErrors.length, last: s.logErrors.slice(-5).map((l) => l.replace(/[^\s@]+@[^\s@]+/g, '<email>').replace(/\s+/g, ' ').slice(0, 200)) }
  })
  // The lines themselves only when they explain a difference: a server error, or one
  // side logging more errors than the other.
  const showLogged = diffs.some((d) => d.paths.some((p) => p.startsWith('(status) a server error'))) || logged[0].count !== logged[1].count
  if (!showLogged) for (const g of logged) g.last = []
  const lines = [
    `# Payout parity — FLAG=${FLAG} — ${diffs.length ? 'DIFFERENCES FOUND' : 'IDENTICAL'}`,
    '',
    `- A: ${SRC.A.text}${SRC.A.patch ? ` (patched: ${path.basename(SRC.A.patch)})` : ''}`,
    `- B: ${SRC.B.text}${SRC.B.patch ? ` (patched: ${path.basename(SRC.B.patch)})` : ''}; INVESTOR_LEASE_PAYOUTS_ENABLED=${sides.B.flag ? 'true' : 'false'} (A: false)`,
    `- Started ${RUN_START.toISOString()}, ${secs} s`,
    `- Investors: ${ownerList.length} (owner ids ${ownerList.join(', ')}); investor-months with a detail read: ${monthsTotal}; statements: ${statementQueue.length}`,
    `- Compared: ${tally.compared} request pairs (${tally.requests} requests); identical ${tally.same}; different ${tally.differ}`,
    '',
    '| Endpoint | Pairs compared | Different | Answers (both sides) |',
    '|---|---|---|---|',
    ...Object.entries(tally.byEndpoint).map(([k, v]) => `| ${k} | ${v.compared} | ${v.differ} | ${Object.entries(v.answers).map(([a, n]) => `${a} x${n}`).join(', ')} |`),
    '',
    '## Differences (paths only)',
    '',
    ...(diffs.length ? diffs.flatMap((d) => [`- \`${d.url}\``, ...d.paths.map((p) => `  - ${p}`)]) : ['None.']),
    '',
    `## Portal vs ledger, on each server (${portalMonths} portal months checked)`,
    '',
    ...(problems.length ? problems.map((f) => `- ${f.side} owner ${f.owner} ${f.month}: ${f.check}`) : ['No disagreement.']),
    ...(infos.length ? ['', 'For information (a settled row keeps the amount it was settled at; the live recompute may since have moved):', '', ...infos.map((f) => `- ${f.side} owner ${f.owner} ${f.month}: ${f.check}`)] : []),
    '',
    '## Errors the servers logged (Google Maps refusals left out; the last five each)',
    '',
    ...logged.flatMap((g) => [`- ${g.side}: ${g.count}`, ...g.last.map((l) => `  - ${l}`)]),
    '',
  ]
  fs.writeFileSync(RESULTS, lines.join('\n'), { mode: 0o600 })
  log('')
  log(lines.join('\n'))
  log(`results: ${RESULTS}`)
  return diffs.length || tally.compared === 0 ? 1 : 0
}

let code = 2
try {
  code = await main()
} catch (e) {
  console.error(`payout-parity: ${e.message}`)
  code = diffs.length ? 1 : 2
} finally {
  cleanupSync()
}
process.exit(code)
