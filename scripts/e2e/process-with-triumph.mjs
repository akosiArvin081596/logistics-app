#!/usr/bin/env node
// LogisX: Process with Triumph as a Super Admin uses it (lib/triumph-process.js, lib/factoring-routes.js,
// lib/triumph-job.js, CompletedLoadsTab.vue), on made-up data only, at a true 1280 px and a true 390 px.
//
// The page's rows come from the server's own modules, run in this process on an in-memory database with
// Process with Triumph's switch on: annotateDashboard() marks them, the routes' own handlers answer the
// press, Try again and Clear factored, and the Triumph job uploads through its real transport
// (lib/triumph-transfer.js) to the fake Triumph SFTP (scripts/e2e/fake-triumph.cjs) on 127.0.0.1. The
// invoice engine is a stand-in, as in scripts/test-triumph-job.js: a made-up rate con, and a made-up
// invoice page under the number the job hands it. Steps:
//   P1  a delivered C.H. Robinson load whose automatic invoice went: "Process with Triumph" beside
//       "Draft Invoice Email" (1280 and 390)
//   P2  one press, no question: the tile says "Sending to Triumph…" (1280 and 390)
//   P3  the job runs: the fake receives the PDF and the CSV with the broker's own number N, date D and
//       total T; one draft row, the broker's; no number voided; nothing on the fake removed or renamed
//   P4  with no reload, the tile turns to "Sent to Triumph · <time>" (1280 and 390)
//   P5  never twice: a second press while it waits its turn, 409 "This load is already with Triumph."; one
//       once it went, 409 in FACTORING_LOCKED's words
//   P6  an advance read recorded after the page opened: the press is refused in plain words (1280 and 390)
//   P7  a load that turned out not to be C.H. Robinson's: refused in plain words (1280 and 390)
//   P8  a stop a retry can change (no debtor name set): Try again offered; with the name set, it goes (1280)
//   P9  the job's own second look finds an advance on the rate con: the tile names Clear factored, which
//       puts the load back with its invoice to the broker, the broker's number untouched (1280)
//   W   every 390 screen is a true phone: a new context (390 x 844, isMobile, deviceScaleFactor 2) whose
//       documentElement.clientWidth is 390 and whose scrollWidth isn't above it
//   G   nothing left this machine; no page error; no write the check doesn't answer
//
// It boots no server.js, reads no settings file or key, signs nobody in and sends nothing: the built
// client/dist is served on 127.0.0.1 and every /api request is answered in the browser.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/process-with-triumph.mjs
//   E2E_SELF_CHECK=1 node scripts/e2e/process-with-triumph.mjs   (the server half alone: no browser, no build)
//
// Env: E2E_PORT (3000 and 5173 are refused), HEADED=1, SHOT_DIR (default
// ~/LogisX-replica/reports/cc/work/process-with-triumph/pr1/screens). Output: PASS/FAIL lines, a count,
// <SHOT_DIR>/results-process-with-triumph.md and the screens. Exit 0 only when every row passes.
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
const SELF_CHECK = process.env.E2E_SELF_CHECK === '1'
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.homedir(), 'LogisX-replica', 'reports', 'cc', 'work', 'process-with-triumph', 'pr1', 'screens')
const DESK = Object.freeze({ width: 1280, height: 800 })
const PHONE = Object.freeze({ width: 390, height: 844 })

function die(msg) {
  console.error(`process-with-triumph: ${msg}`)
  process.exit(2)
}
if (process.env.E2E_PORT && (!Number.isInteger(ASKED_PORT) || ASKED_PORT < 1024 || ASKED_PORT > 65535)) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (ASKED_PORT === 3000 || ASKED_PORT === 5173) die(`refusing port ${ASKED_PORT}: 3000 is production's port on the VPS and 5173 is Vite's`)
if (!SELF_CHECK && !fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm --prefix client run build\` first`)

// ---------------------------------------------------------------- nothing leaves this process
// Set before any lib is loaded. Every socket goes through Socket.prototype.connect.
const wire = { tls: [], remote: [], mailPorts: [] }
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', ''])
const MAIL_PORTS = new Set([25, 143, 465, 587, 993])
function targetOf(args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (a && typeof a === 'object') return a.path ? { host: '', port: 0 } : { host: String(a.host || a.hostname || ''), port: Number(a.port) || 0 }
  if (typeof a === 'number' || /^\d+$/.test(String(a))) return { host: typeof args[1] === 'string' ? args[1] : '', port: Number(a) }
  return { host: '', port: 0 }
}
tls.connect = function refusedTls(...args) {
  wire.tls.push(targetOf(args).host || '(unnamed)')
  throw new Error('process-with-triumph: TLS refused in this check')
}
const realConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedConnect(...args) {
  const { host, port } = targetOf(args)
  if (!LOOPBACK.has(host)) {
    wire.remote.push(host)
    throw new Error('process-with-triumph: only 127.0.0.1 is reachable in this check')
  }
  if (MAIL_PORTS.has(port)) {
    wire.mailPorts.push(port)
    throw new Error('process-with-triumph: mail ports are refused in this check')
  }
  return realConnect.apply(this, args)
}

// ---------------------------------------------------------------- the server's own modules
const require = createRequire(import.meta.url)
const lib = (name) => require(path.join(paths.REPO, 'lib', name))
const Database = require(path.join(paths.REPO, 'node_modules', 'better-sqlite3'))
const factoring = lib('factoring-store.js')
const routesLib = lib('factoring-routes.js')
const ledger = lib('triumph-ledger.js')
const processLib = lib('triumph-process.js')
const jobLib = lib('triumph-job.js')
const transferLib = lib('triumph-transfer.js')
const autoLedger = lib('auto-invoice-ledger.js')
const autoRules = lib('auto-invoice-rules.js')
const brokerInvoice = lib('broker-invoice.js')
const rateconAdvanceRead = lib('ratecon-advance-read.js')
const { createRedactor } = lib('chr-events.js')
const { textPdf } = require(path.join(paths.REPO, 'scripts', 'lib', 'made-up-pdf.js'))
const { startFakeTriumph, fingerprintOfKey } = require(path.join(paths.REPO, 'scripts', 'e2e', 'fake-triumph.cjs'))
const { utils: { generateKeyPairSync: sshKeyPair, parseKey } } = require(path.join(paths.REPO, 'node_modules', 'ssh2'))
const { PDFDocument, StandardFonts } = require(path.join(paths.REPO, 'node_modules', 'pdf-lib'))

// ---------------------------------------------------------------- made-up fixtures
const LISTED = Object.freeze({ id: 90421, username: 'qa-triumph-listed', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Triumph Listed', companyName: '', mustChangePassword: false })
const NOA = Object.freeze(['MADE-UP FACTOR LINE ONE', 'MADE-UP FACTOR LINE TWO', 'MADE-UP FACTOR LLC', 'MADE-UP REMIT LINE'])
const DEBTOR = 'Made-up Robinson Debtor'
const BROKER = 'made-up.agent@chrobinson.com'
const OTHER_BROKER = 'made-up.agent@example-broker.test'
const TOTAL = '$2,150.00'
const SUBMIT = '/made-up/submit'
const DENY = '998877665544'
const HEADERS = ['Load ID', 'Status', 'Driver', 'Truck', 'Pickup Address', 'Drop-off Address', 'Payment', 'Completion Date']
const JOB_HEADERS = [...HEADERS, 'Email']
// Six made-up C.H. Robinson Load IDs: E and A go (1280, 390), B and C are refused, F waits on a
// setting, D stops at the job's second look.
const LOADS = Object.freeze({ A: '123456711', B: '123456712', C: '123456713', D: '123456714', E: '123456715', F: '123456716' })
// The invoice went two days ago (on the business clock), the load delivered that morning.
const dayKeyOf = (instant) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant)
const D = dayKeyOf(new Date(Date.now() - 2 * 86400000))
const [DY, DM, DD] = D.split('-')
const SENT_AT = `${D}T16:00:00.000Z`
const DELIVERED_ON = `${DM}/${DD}/${DY} 09:15:00`
const CSV_DATE = `${DM}/${DD}/${DY}`
const rateConText = (id) => `C.H. Robinson Booked Load # ${id} Carrier Rate Confirmation for a made-up test load. Debtor: ${DEBTOR}. Pickup at Test Shipper; delivery at Test Consignee. Equipment: van. Commodity weight 20,000 lbs. Rate Detail Line Haul 1.00 $2,150.00 $2,150.00 Total: $2,150.00`
const ADVANCE_LABELS = 'Advanced Total: $500.00 New Total: $1,650.00'
const REASON = 'made-up: keep it with its invoice to the broker'

// The screen's words, pinned here so a changed word is a FAIL rather than a matching read.
const WORDS = Object.freeze({
  button: 'Process with Triumph',
  sending: 'Sending to Triumph…',
  sentPrefix: 'Sent to Triumph · ',
  already: 'This load is already with Triumph.',
  locked: 'This load was handed to Triumph, so its invoice is final there. Nothing can change it in the app.',
  advance: "Not sent to Triumph. This load's rate con shows an advance, or the app couldn't rule one out: it stays with its invoice to the broker.",
  notChr: 'Not sent to Triumph. Only C.H. Robinson loads can go to Triumph from this button for now. Invoice this one the usual way.',
  retryStop: "Not sent to Triumph: no debtor name is set for this broker in Triumph's settings. Its invoice to the broker stands. Try again",
  netStop: "Not sent to Triumph: the rate con shows an advance, or the app couldn't rule one out. It stays with its invoice to the broker: Clear factored puts it back there alone.",
  cleared: 'No longer factored: it stays with its invoice to the broker.',
  clearedTile: 'Not sent to Triumph. It stays with its invoice to the broker.',
})

function keyPair() {
  for (let i = 0; i < 50; i++) {
    const k = sshKeyPair('ed25519')
    if (!(parseKey(k.private) instanceof Error)) return k
  }
  throw new Error('no usable made-up ed25519 key in 50 tries')
}
async function pdfOf(lines) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  lines.forEach((text, i) => page.drawText(`${text} `, { x: 54, y: 720 - i * 20, size: 12, font }))
  return Buffer.from(await doc.save({ useObjectStreams: false }))
}

// One made-up server's state: the database, the fake Triumph, the routes and the job.
async function freshServer() {
  const hostKey = keyPair()
  const clientKey = keyPair()
  const fake = await startFakeTriumph({ hostKey: hostKey.private, clientKey: clientKey.private, folders: [SUBMIT] })
  const env = Object.freeze({
    TRIUMPH_SUBMIT_ENABLED: 'true', TRIUMPH_SUBMIT_DRY_RUN: 'false', TRIUMPH_LIVE_CONFIRMED_ON: '2026-11-05',
    TRIUMPH_HOST: fake.host, TRIUMPH_PORT: String(fake.port), TRIUMPH_USER: 'made-up-user', TRIUMPH_KEY_FILE: '/made-up/not-a-real-key-file',
    TRIUMPH_HOST_FINGERPRINT: fingerprintOfKey(hostKey.private), TRIUMPH_HOST_KEY_TYPE: 'ED25519', TRIUMPH_SUBMIT_DIR: SUBMIT,
    TRIUMPH_FACTORING_ENABLED: 'true', TRIUMPH_FACTOR_MARK_IDS: String(LISTED.id), TRIUMPH_PROCESS_BUTTON_ENABLED: 'true', TRIUMPH_NOA_LINES: NOA.join('\n'),
  })
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT, recipient_source TEXT, total TEXT,
    broker_name TEXT, order_number TEXT, via TEXT, created_by TEXT, edited INTEGER DEFAULT 0, edited_fields TEXT, overrides_json TEXT, total_source TEXT,
    sheet_total TEXT, ratecon_total TEXT, invoice_id_minted TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE documents (id INTEGER PRIMARY KEY, load_id TEXT, type TEXT, file_name TEXT, drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at TEXT, deleted_at TEXT);
    CREATE TABLE deleted_loads (load_id TEXT);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by TEXT);`)
  factoring.ensureSchema(db)
  autoLedger.ensureSchema(db)
  processLib.ensureSchema(db)
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('auto_invoice.settings', ?)").run(JSON.stringify({ optOutDomains: [], confirmedBrokerDomains: ['chrobinson.com'] }))
  const s = { db, fake, env, rows: [], ratecons: new Map(), numbers: {}, mounted: {}, audits: [], refusals: [], batchDir: fs.mkdtempSync(path.join(os.tmpdir(), 'process-with-triumph-e2e-')) }
  s.setDebtor = (on) => db.prepare("INSERT INTO app_settings (key, value) VALUES ('factoring.settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ debtorNames: on ? { 'chrobinson.com': DEBTOR } : {} }))
  s.setDebtor(true)
  // A delivered load whose automatic invoice went to the broker: its POD before the send, one draft
  // row via auto-smtp, and the automatic claim recorded with the send's fingerprint.
  Object.entries(LOADS).forEach(([name, id], i) => {
    s.rows.push({
      'Load ID': id, Status: 'Delivered', Driver: 'Casey Example', Truck: 'QA-T1', 'Pickup Address': '100 Example Rd, Memphis, TN 38118',
      'Drop-off Address': '200 Sample Ave, Dallas, TX 75201', Payment: TOTAL, 'Completion Date': DELIVERED_ON, Email: BROKER,
    })
    s.ratecons.set(id, textPdf(name === 'D' ? `${rateConText(id)} ${ADVANCE_LABELS}` : rateConText(id), { mode: 'literal' }))
    const podId = 100 + i
    db.prepare("INSERT INTO documents (id, load_id, type, file_name, drive_url, uploaded_at) VALUES (?, ?, 'POD', ?, ?, ?)").run(podId, id, `${id}_pod.pdf`, `/uploads/${id}_pod.pdf`, `${D} 14:00:00`)
    const N = `${DM}${DD}${DY}-${i + 1}`
    s.numbers[name] = N
    const rowId = Number(db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, total, broker_name, order_number, via, created_by) VALUES (?, ?, ?, ?, 'C.H. Robinson (made up)', ?, 'auto-smtp', 'auto-invoice')")
      .run(id, N, BROKER, TOTAL, id).lastInsertRowid)
    autoLedger.insertClaim(db, { key: id, loadId: id, state: 'drafted', nowIso: SENT_AT })
    const fingerprint = autoRules.fingerprint({ completed: true, live: true, paymentCents: 215000, brokerEmail: BROKER, trailer: '', podIds: [podId], rateConIds: [] })
    autoLedger.transition(db, id, { from: ['drafted'], nowIso: SENT_AT, patch: { delivery: 'send', stage: 'recorded', invoice_id: N, invoice_date: D, sent_at: SENT_AT, draft_row_id: rowId,
      sent_json: JSON.stringify({ to: BROKER, subject: `C.H. Robinson Order #${id}`, total: TOTAL }), fingerprint_json: JSON.stringify(fingerprint) } })
  })
  s.row = (id) => s.rows.find((r) => r['Load ID'] === id)
  s.readJobTracking = async () => ({ headers: JOB_HEADERS, data: s.rows.map((r) => ({ ...r })) })
  const engine = {
    async prepare({ loadId }) {
      const buffer = s.ratecons.get(loadId)
      return { ok: true, ctx: { loadId, loadRef: loadId, orderNumber: loadId, assignment: { lines: NOA }, rateconBuffer: buffer,
        rateconCandidates: [{ source: 'documents', buffer }], paidRead: { 'Load Number': loadId } } }
    },
    async render(ctx, { invoiceId, invoiceDate }) {
      const invoicePdf = await pdfOf(['INVOICE (MADE UP)', `Invoice ID #: ${invoiceId}`, `Date: ${brokerInvoice.formatDate(invoiceDate)}`, `Order #: ${ctx.orderNumber}`, `Total: ${TOTAL}`, ...NOA])
      return { invoicePdf, total: TOTAL, to: BROKER }
    },
    // A Process with Triumph claim keeps the broker's own row: the job never records a second.
    async record() { throw new Error('process-with-triumph: the job recorded a second invoice row') },
  }
  const pod = await pdfOf(['PROOF OF DELIVERY (MADE UP)'])
  s.transport = transferLib.create({ db, env, readKeyFile: () => clientKey.private })
  s.job = jobLib.create({
    db, env, readJobTracking: s.readJobTracking, closedMonthsOf: () => [],
    dayKeyOf: (cell) => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(cell || ''))
      return m ? `${m[3]}-${m[1]}-${m[2]}` : ''
    },
    engine, nextInvoiceNumber: () => { throw new Error('process-with-triumph: the job minted a number') },
    loadDocuments: async (loadId) => db.prepare("SELECT id, type, uploaded_at FROM documents WHERE load_id = ? AND type = 'POD'").all(loadId).map((d) => ({ ...d, buffer: pod })),
    transport: s.transport, noaLines: NOA, denyHits: createRedactor({ denyList: DENY }).hits, savedInvoiceEvidence: () => false, batchDir: s.batchDir, processButtonOn: true,
    logAudit: (req, action, entity, id, details) => s.audits.push({ action, id, details: String(details || '') }),
    notify: () => {}, log: { info() {}, warn() {}, error() {} }, workerId: 'qa-triumph-worker',
    // The press wakes the job; this check runs each turn itself, so a screen can be taken between them.
    setImmediate: () => {},
  })
  s.routes = routesLib.create({
    db, env, reissueHoldOn: true, triumphJob: () => s.job, readJobTracking: s.readJobTracking, closedMonthsOf: () => [],
    logAudit: (req, action, entity, id, details) => s.audits.push({ action, id, details: String(details || '') }),
    logAuditRefusal: (req, action, entity, id, details, code) => s.refusals.push({ action, id, code }),
    log: { info() {}, warn() {}, error() {} },
  })
  const app = { post: (p, ...chain) => { s.mounted[p] = chain }, get: (p, ...chain) => { s.mounted[`GET ${p}`] = chain }, use() {} }
  s.routes.mount(app, {
    requireRole: (role) => (req, res, next) => (req.session && req.session.user && req.session.user.role === role ? next() : res.status(403).json({ code: 'FORBIDDEN' })),
    refuseCrossSite: (req, res, next) => next(),
  })
  // A route's own handlers, in order, as Express would run them.
  s.call = async (route, user, params, body) => {
    const out = { status: 200, body: null }
    const res = { status(c) { out.status = c; return res }, json(b) { out.body = b; return res } }
    const req = { params, body, query: {}, headers: {}, session: { user }, get: () => '' }
    for (const handler of s.mounted[route] || []) {
      let goOn = false
      let failed = null
      await handler(req, res, (e) => { if (e) failed = e; else goOn = true })
      if (failed) return { status: 500, body: { error: String(failed && failed.message) } }
      if (!goOn) break
    }
    return out
  }
  s.press = (id) => s.call('/api/factoring/process-with-triumph', LISTED, {}, { loadId: id })
  s.retry = (id) => s.call('/api/factoring/triumph-retry', LISTED, {}, { loadId: id })
  s.clear = (id) => s.call('/api/factoring/loads/:loadKey', LISTED, { loadKey: id }, { factored: false, reason: REASON, loadId: id })
  s.claim = (id) => ledger.getClaim(db, id)
  s.marker = (id) => db.prepare('SELECT * FROM load_factoring WHERE load_key = ?').get(id) || null
  s.auto = (id) => db.prepare('SELECT invoice_id, number_voided_at FROM auto_invoice_claims WHERE load_key = ?').get(id)
  s.drafts = (id) => db.prepare('SELECT id, invoice_id, via FROM load_invoice_drafts WHERE load_id = ? ORDER BY id').all(id)
  // An advance read on file for the load, as the extract route records one for a revised rate con.
  s.recordAdvanceRead = (id) => {
    rateconAdvanceRead.ensureTable(db)
    db.prepare(`INSERT INTO ${rateconAdvanceRead.TABLE} (load_key, at, verdict, reason, total_cents, advance_cents, new_total_cents, switch_on) VALUES (?, ?, 'person', 'after_invoice', 215000, 50000, 165000, 0)`).run(id, new Date().toISOString())
  }
  s.dropAdvanceReads = (id) => {
    rateconAdvanceRead.ensureTable(db)
    db.prepare(`DELETE FROM ${rateconAdvanceRead.TABLE} WHERE load_key = ?`).run(id)
  }
  // The row's `_factoring` as a Super Admin's dashboard reads it now.
  s.factoringOf = (id) => {
    const completed = [{ ...s.row(id) }]
    s.routes.annotateDashboard({ session: { user: LISTED } }, { headers: JOB_HEADERS, active: [], completed })
    return completed[0]._factoring || null
  }
  s.close = async () => {
    await fake.close()
    fs.rmSync(s.batchDir, { recursive: true, force: true })
  }
  return s
}

// ---------------------------------------------------------------- results
const rows = []
const unanswered = new Set()
const otherWrites = []
const pageErrors = []
const offHost = new Set()
function record(step, title, expected, observed, pass, shotFile = '') {
  rows.push({ step, title, expected, observed, verdict: pass ? 'PASS' : 'FAIL', shot: shotFile })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${observed}`)
  if (!pass) console.log(`      expected: ${expected}`)
}

// ---------------------------------------------------------------- server-side checks (both halves)
function checkWent(s, step, name) {
  const id = LOADS[name]
  const N = s.numbers[name]
  const c = s.claim(id) || {}
  const csv = c.csv_name ? String(s.fake.files.get(`${SUBMIT}/${c.csv_name}`) || '') : ''
  const pdf = s.fake.files.get(`${SUBMIT}/${N}.pdf`)
  const want = `DTR_NAME,INVOICE#,INV_DATE,PO,INVAMT\r\n${DEBTOR},${N},${CSV_DATE},${id},2150.00\r\n`
  record(step, `the fake receives load ${name}'s PDF and CSV`, `submitted under ${N}; ${N}.pdf; the CSV row ${DEBTOR},${N},${CSV_DATE},${id},2150.00`,
    `${c.state || 'no claim'} under ${c.invoice_id || '-'}; pdf ${pdf ? 'there' : 'missing'}; csv ${JSON.stringify(csv.split('\r\n')[1] || '')}`,
    c.state === 'submitted' && c.invoice_id === N && Boolean(pdf) && Buffer.from(pdf).subarray(0, 5).toString('latin1') === '%PDF-' && csv.startsWith(want))
  const drafts = s.drafts(id)
  record(step, `load ${name}: one draft row, the broker's, and no number voided`, `[${N} via auto-smtp]; nothing voided`,
    `${JSON.stringify(drafts.map((r) => `${r.invoice_id} via ${r.via}`))}; auto "${s.auto(id).number_voided_at}", claim "${c.number_voided_at || ''}"`,
    drafts.length === 1 && drafts[0].invoice_id === N && drafts[0].via === 'auto-smtp' && s.auto(id).number_voided_at === '' && !c.number_voided_at)
  const destructive = s.fake.writeOps().filter((o) => ['REMOVE', 'RENAME', 'MKDIR', 'RMDIR', 'SETSTAT', 'FSETSTAT', 'SYMLINK'].includes(o.op))
  record(step, 'nothing on the fake removed, renamed or changed', 'no such request', destructive.map((o) => o.op).join(',') || 'none', destructive.length === 0)
}
function checkNothingTaken(s, step, name) {
  const id = LOADS[name]
  record(step, `load ${name}: nothing written`, 'no mark, no claim, its number not voided', `mark ${s.marker(id) ? 'there' : 'none'}, claim ${s.claim(id) ? 'there' : 'none'}, voided "${s.auto(id).number_voided_at}"`,
    !s.marker(id) && !s.claim(id) && s.auto(id).number_voided_at === '')
}

// The server half with no browser: each step's rule through the routes and the job alone.
async function serverHalf(s) {
  const before = s.factoringOf(LOADS.E)
  record('P1s', 'canProcess on a delivered C.H. Robinson load whose invoice went', 'true', String(before && before.canProcess), Boolean(before) && before.canProcess === true)
  const p = await s.press(LOADS.E)
  record('P2s', 'one press with { loadId } only', '200, the claim queued under the broker\'s number', `${p.status}, ${(s.claim(LOADS.E) || {}).state}, ${(s.claim(LOADS.E) || {}).invoice_id}`,
    p.status === 200 && (s.claim(LOADS.E) || {}).state === 'queued' && (s.claim(LOADS.E) || {}).invoice_id === s.numbers.E)
  const queued = await s.press(LOADS.E)
  record('P5s', 'a second press while it waits its turn', `409 ${WORDS.already}`, `${queued.status} ${queued.body && queued.body.error}`, queued.status === 409 && queued.body.error === WORDS.already)
  await s.job.tick()
  checkWent(s, 'P3s', 'E')
  const again = await s.press(LOADS.E)
  record('P5s', 'a press once it went', `409 ${WORDS.locked}`, `${again.status} ${again.body && again.body.error}`, again.status === 409 && again.body.error === WORDS.locked)
  s.recordAdvanceRead(LOADS.B)
  const b = await s.press(LOADS.B)
  record('P6s', 'an advance read on file', `409 ${WORDS.advance}`, `${b.status} Not sent to Triumph. ${b.body && b.body.error}`, b.status === 409 && `Not sent to Triumph. ${b.body.error}` === WORDS.advance)
  checkNothingTaken(s, 'P6s', 'B')
  s.row(LOADS.C).Email = OTHER_BROKER
  const c = await s.press(LOADS.C)
  record('P7s', 'not C.H. Robinson\'s', `409 ${WORDS.notChr}`, `${c.status} Not sent to Triumph. ${c.body && c.body.error}`, c.status === 409 && `Not sent to Triumph. ${c.body.error}` === WORDS.notChr)
  checkNothingTaken(s, 'P7s', 'C')
  s.setDebtor(false)
  await s.press(LOADS.F)
  await s.job.tick()
  const stopped = s.claim(LOADS.F) || {}
  const offered = s.factoringOf(LOADS.F) || {}
  record('P8s', 'a stop a retry can change', 'needs_attention DEBTOR_UNMAPPED, Try again offered', `${stopped.state} ${stopped.reason_code}, canRetry ${offered.canRetry}`,
    stopped.state === 'needs_attention' && stopped.reason_code === 'DEBTOR_UNMAPPED' && offered.canRetry === true)
  s.setDebtor(true)
  const r = await s.retry(LOADS.F)
  await s.job.tick()
  record('P8s', 'Try again, with the name set', '200, then submitted', `${r.status}, ${(s.claim(LOADS.F) || {}).state}`, r.status === 200 && (s.claim(LOADS.F) || {}).state === 'submitted')
  checkWent(s, 'P8s', 'F')
  await s.press(LOADS.D)
  await s.job.tick()
  const net2 = s.claim(LOADS.D) || {}
  const fD = s.factoringOf(LOADS.D) || {}
  record('P9s', 'the second look stops on the rate con\'s advance', 'needs_attention ADVANCE_ON_RATECON; Clear factored offered, Try again not', `${net2.state} ${net2.reason_code}; canClear ${fD.canClear}, canRetry ${fD.canRetry}`,
    net2.state === 'needs_attention' && net2.reason_code === 'ADVANCE_ON_RATECON' && fD.canClear === true && fD.canRetry === false)
  const cl = await s.clear(LOADS.D)
  record('P9s', 'Clear factored: back with the broker, the number kept', `200; not factored; ${s.numbers.D} not voided; nothing sent`, `${cl.status}; factored ${(s.marker(LOADS.D) || {}).factored}; voided "${s.auto(LOADS.D).number_voided_at}"`,
    cl.status === 200 && Number((s.marker(LOADS.D) || {}).factored) === 0 && s.auto(LOADS.D).number_voided_at === '' && s.fake.files.get(`${SUBMIT}/${s.numbers.D}.pdf`) === undefined)
}

// ---------------------------------------------------------------- the browser half
const json200 = (body) => ({ status: 200, body })
const parse = (raw) => { try { return JSON.parse(raw || 'null') } catch { return null } }
function dashboardBody(s, user) {
  const completed = s.rows.map((r) => ({ ...r }))
  s.routes.annotateDashboard({ session: { user } }, { headers: JOB_HEADERS, active: [], completed })
  return {
    timestamp: new Date().toISOString(),
    kpis: { activeLoads: 0, unassignedLoads: 0, completedThisWeek: completed.length, completedThisMonth: completed.length, fleetUtilization: { assigned: 1, total: 1 }, revenue: { total: 0, paid: 0, pending: 0 } },
    unassignedJobs: [], jobTrackingHeaders: HEADERS, completedHeaders: HEADERS, activeJobs: [], completedJobs: completed,
    fleet: [{ Driver: 'Casey Example', Truck: 'QA-T1', Status: 'Available', CompletedLoads: completed.length, CurrentLoad: '', Phone: '(512) 555-0100', QueueCount: 0, QueuedLoadIds: [] }],
    drivers: ['Casey Example'], driverQueues: {}, autoInvoice: { mode: 'on' },
  }
}
function answerGet(s, user, pathname) {
  if (pathname === '/api/auth/session') return json200({ authenticated: true, user, appTimeZone: 'America/New_York' })
  if (pathname === '/api/dashboard') return json200(dashboardBody(s, user))
  if (pathname === '/api/auto-invoice/settings') return json200({ ...autoLedger.readSettings(s.db), send: { domains: ['chrobinson.com'], stopped: autoLedger.getSendStop(s.db) } })
  if (pathname === '/api/dispatch-notifications') return json200({ notifications: [], unreadCount: 0 })
  if (pathname === '/api/load-ratings/averages') return json200({ averages: {} })
  if (pathname === '/api/truck-assignments') return json200({ assignments: [] })
  if (pathname === '/api/config/maps-key') return json200({ key: 'qa-triumph-no-key' })
  if (pathname === '/api/locations/latest') return json200({ locations: [] })
  if (pathname === '/api/integrations/chr/status') return json200({ enabled: false })
  if (pathname.startsWith('/api/load-ratings/')) return json200({ rating: 0 })
  if (pathname.startsWith('/api/geocode/load/')) return json200({})
  if (/^\/api\/documents\/[^/]+$/.test(pathname)) return json200({ documents: [] })
  if (/^\/api\/loads\/[^/]+\/invoice-draft$/.test(pathname)) return json200({ draft: null })
  if (/^\/api\/loads\/[^/]+\/status-history$/.test(pathname)) return json200({ phases: [] })
  if (/^\/api\/loads\/[^/]+\/haul$/.test(pathname)) return json200({ driven: null, lane: null })
  if (/^\/api\/loads\/[^/]+\/ratecon\.pdf$/.test(pathname)) return { status: 404, body: { error: 'No rate con in this check.', code: 'RATECON_NOT_FOUND' } }
  return null
}
// The press, Try again and Clear factored through their own handlers; any other write is listed.
async function answerWrite(s, user, method, url, raw) {
  if (method !== 'POST') return null
  const body = parse(raw) || {}
  if (url.pathname === '/api/factoring/process-with-triumph' || url.pathname === '/api/factoring/triumph-retry') return s.call(url.pathname, user, {}, body)
  const m = /^\/api\/factoring\/loads\/([^/]+)$/.exec(url.pathname)
  if (m) return s.call('/api/factoring/loads/:loadKey', user, { loadKey: decodeURIComponent(m[1]) }, body)
  return null
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.webmanifest': 'application/manifest+json' }
function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by this check"}')
    return
  }
  const file = path.resolve(DIST, '.' + path.posix.normalize(rel))
  const inside = file === DIST || file.startsWith(DIST + path.sep)
  const target = inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(DIST, 'index.html')
  res.writeHead(200, { 'content-type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(target).pipe(res)
}

const DIALOG = '[role="dialog"]'
// A desk context at 1280, or a true phone: Playwright's own emulation, a new context each time.
async function openPage(browser, s, { phone = false } = {}) {
  const ctx = await browser.newContext(phone
    ? { viewport: PHONE, isMobile: true, deviceScaleFactor: 2, serviceWorkers: 'block' }
    : { viewport: DESK, deviceScaleFactor: 1, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) { offHost.add(u.host); return route.abort() }
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    const isGet = req.method() === 'GET'
    const out = isGet ? answerGet(s, LISTED, u.pathname) : await answerWrite(s, LISTED, req.method(), u, req.postData())
    if (out === null) {
      if (isGet) unanswered.add(u.pathname)
      else otherWrites.push(`${req.method()} ${u.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({ status: out.status, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out.body) })
  })
  const page = await ctx.newPage()
  const questions = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 200)))
  page.on('dialog', async (d) => { questions.push(d.message()); await d.dismiss().catch(() => {}) })
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.locator('[role="tab"]', { hasText: 'Completed' }).first().click({ timeout: 15000 })
  return { ctx, page, questions, phone }
}
const locText = (loc) => loc.first().textContent({ timeout: 2000 }).then((t) => (t || '').replace(/\s+/g, ' ').trim(), () => '')
async function openLoad(view, id) {
  const row = view.page.locator('tbody tr', { hasText: id }).first()
  if (!(await row.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false))) return false
  await row.locator('td').first().click({ timeout: 8000 })
  return view.page.waitForSelector(DIALOG, { state: 'visible', timeout: 8000 }).then(() => true, () => false)
}
const processButton = (view) => view.page.locator(`${DIALOG} button.triumph-btn`)
const tileText = async (view) => ((await view.page.locator(`${DIALOG} .triumph-line`).count()) ? locText(view.page.locator(`${DIALOG} .triumph-line .auto-line-text`)) : '')
// Waits for the tile to read as `test` says, up to `ms`; the text it last read.
async function tileUntil(view, test, ms) {
  const end = Date.now() + ms
  let last = ''
  while (Date.now() < end) {
    last = await tileText(view)
    if (test(last)) return last
    await new Promise((r) => setTimeout(r, 250))
  }
  return last
}
async function screen(view, name, step) {
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(SHOT_DIR, `${name}-${view.phone ? '390' : '1280'}.png`)
  await view.page.screenshot({ path: file })
  if (view.phone) {
    const l = await view.page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
    record('W', `${step} ${name} at a true 390`, 'clientWidth 390, scrollWidth at most 390', `clientWidth ${l.client}, scrollWidth ${l.scroll}`, l.client === PHONE.width && l.scroll <= PHONE.width, file)
  }
  return file
}
const tag = (view, step) => `${step}${view.phone ? ' (390)' : ''}`
// The press as a second tab would send it: the page's own fetch, with the app's header.
const pressFromPage = (view, id) => view.page.evaluate(async (loadId) => {
  const res = await fetch('/api/factoring/process-with-triumph', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ loadId }) })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}, id)

async function browserHalf(s) {
  const { chromium } = await import('playwright-core')
  const server = http.createServer(serveDist)
  await new Promise((resolve) => server.listen(PORT, HOST, resolve))
  PORT = server.address().port
  BASE = `http://${HOST}:${PORT}`
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    // P1: the button beside Draft Invoice Email.
    for (const phone of [false, true]) {
      const view = await openPage(browser, s, { phone })
      const opened = await openLoad(view, LOADS.E)
      const beside = opened && await view.page.evaluate((sel) => {
        const draft = [...document.querySelectorAll(`${sel} button`)].find((b) => /Draft Invoice Email/.test(b.textContent || ''))
        const triumph = document.querySelector(`${sel} button.triumph-btn`)
        return Boolean(draft && triumph && draft.parentElement === triumph.parentElement)
      }, DIALOG)
      const label = opened ? await locText(processButton(view)) : ''
      record(tag(view, 'P1'), 'the Completed tile: Process with Triumph beside Draft Invoice Email', `"${WORDS.button}", in the same row`, `opened ${opened}, beside ${beside}, "${label}"`,
        opened && beside && label === WORDS.button, await screen(view, 'tile-with-button', 'P1'))
      await view.ctx.close()
    }
    // P2-P4: a press, "Sending to Triumph…", the job's turn, then "Sent to Triumph" with no reload.
    for (const [phone, name] of [[false, 'E'], [true, 'A']]) {
      const view = await openPage(browser, s, { phone })
      await openLoad(view, LOADS[name])
      await processButton(view).click({ timeout: 8000 })
      const sending = await tileUntil(view, (t) => t === WORDS.sending, 8000)
      record(tag(view, 'P2'), `one press, no question: load ${name}'s tile`, `${WORDS.sending}; no question asked`, `${sending}; questions ${view.questions.length}`,
        sending === WORDS.sending && view.questions.length === 0, await screen(view, 'tile-sending', 'P2'))
      if (!phone) {
        const r = await pressFromPage(view, LOADS[name])
        record('P5', 'a second press while it waits its turn', `409 ${WORDS.already}`, `${r.status} ${r.body.error}`, r.status === 409 && r.body.error === WORDS.already)
      }
      await s.job.tick()
      if (!phone) checkWent(s, 'P3', name)
      const sent = await tileUntil(view, (t) => t.startsWith(WORDS.sentPrefix), 15000)
      record(tag(view, 'P4'), `with no reload: load ${name}'s tile`, `${WORDS.sentPrefix}<time>`, sent, sent.startsWith(WORDS.sentPrefix) && sent.length > WORDS.sentPrefix.length + 4,
        await screen(view, 'tile-sent', 'P4'))
      await view.ctx.close()
    }
    // P5: a press of a load that went, from the page.
    {
      const view = await openPage(browser, s)
      const r = await pressFromPage(view, LOADS.E)
      record('P5', 'a press once it went', `409 ${WORDS.locked}`, `${r.status} ${r.body.error}`, r.status === 409 && r.body.error === WORDS.locked)
      await view.ctx.close()
    }
    // P6 and P7: the page opens on a load the press would take; the load changes; the press is refused.
    const refusals = [
      ['P6', 'B', 'refused-advance', WORDS.advance, () => s.recordAdvanceRead(LOADS.B), () => s.dropAdvanceReads(LOADS.B)],
      ['P7', 'C', 'refused-not-chr', WORDS.notChr, () => { s.row(LOADS.C).Email = OTHER_BROKER }, () => { s.row(LOADS.C).Email = BROKER }],
    ]
    for (const [step, name, shot, words, change, undo] of refusals) {
      for (const phone of [false, true]) {
        undo()
        const view = await openPage(browser, s, { phone })
        await openLoad(view, LOADS[name])
        const offered = (await processButton(view).count()) === 1
        change()
        await processButton(view).click({ timeout: 8000 }).catch(() => {})
        const said = await tileUntil(view, (t) => t === words, 8000)
        record(tag(view, step), `load ${name}: offered, then refused in plain words`, `button shown; "${words}"`, `button ${offered ? 'shown' : 'missing'}; "${said}"`, offered && said === words,
          await screen(view, shot, step))
        await view.ctx.close()
      }
      checkNothingTaken(s, step, name)
    }
    // P8: no debtor name set: the job stops, Try again is offered; with the name set, it goes.
    {
      s.setDebtor(false)
      const view = await openPage(browser, s)
      await openLoad(view, LOADS.F)
      await processButton(view).click({ timeout: 8000 })
      await tileUntil(view, (t) => t === WORDS.sending, 8000)
      await s.job.tick()
      const stop = await tileUntil(view, (t) => t.startsWith(WORDS.retryStop), 15000)
      const tryAgain = view.page.locator(`${DIALOG} .triumph-line button`, { hasText: 'Try again' })
      const offered = (await tryAgain.count()) === 1
      record('P8', 'a stop a retry can change: Try again offered', `${WORDS.retryStop}…; a Try again button`, `"${stop}"; button ${offered ? 'shown' : 'missing'}`,
        stop.startsWith(WORDS.retryStop) && offered, await screen(view, 'tile-try-again', 'P8'))
      s.setDebtor(true)
      if (offered) await tryAgain.click({ timeout: 8000 })
      await tileUntil(view, (t) => t === WORDS.sending, 8000)
      await s.job.tick()
      const sent = await tileUntil(view, (t) => t.startsWith(WORDS.sentPrefix), 15000)
      record('P8', 'Try again with the name set: it goes', `${WORDS.sentPrefix}<time>`, sent, sent.startsWith(WORDS.sentPrefix), await screen(view, 'tile-sent-after-try-again', 'P8'))
      checkWent(s, 'P8', 'F')
      await view.ctx.close()
    }
    // P9: the job's second look stops on the rate con's advance; Clear factored keeps the broker's invoice.
    {
      const view = await openPage(browser, s)
      await openLoad(view, LOADS.D)
      await processButton(view).click({ timeout: 8000 })
      await tileUntil(view, (t) => t === WORDS.sending, 8000)
      await s.job.tick()
      const stop = await tileUntil(view, (t) => t === WORDS.netStop, 15000)
      record('P9', 'the second look stops on an advance: the tile names Clear factored', WORDS.netStop, stop, stop === WORDS.netStop, await screen(view, 'tile-second-look-stop', 'P9'))
      await view.page.locator(`${DIALOG} .fact-reason`).fill(REASON)
      await view.page.locator(`${DIALOG} .fact-btn`, { hasText: 'Clear factored' }).click({ timeout: 8000 })
      const said = await view.page.waitForSelector(`${DIALOG} .fact-result`, { timeout: 8000 }).then(() => locText(view.page.locator(`${DIALOG} .fact-result`)), () => '')
      const after = await tileUntil(view, (t) => t === WORDS.clearedTile, 8000)
      record('P9', 'Clear factored: back with its invoice to the broker alone', `"${WORDS.cleared}" / "${WORDS.clearedTile}"; ${s.numbers.D} not voided; nothing sent`,
        `"${said}" / "${after}"; voided "${s.auto(LOADS.D).number_voided_at}"; pdf ${s.fake.files.get(`${SUBMIT}/${s.numbers.D}.pdf`) ? 'sent' : 'not sent'}`,
        said === WORDS.cleared && after === WORDS.clearedTile && s.auto(LOADS.D).number_voided_at === '' && !s.fake.files.get(`${SUBMIT}/${s.numbers.D}.pdf`),
        await screen(view, 'tile-cleared', 'P9'))
      await view.ctx.close()
    }
  } finally {
    await browser.close().catch(() => {})
    server.close()
  }
}

;(async () => {
  const s = await freshServer()
  try {
    if (SELF_CHECK) await serverHalf(s)
    else await browserHalf(s)
  } finally {
    await s.close()
  }
  record('G', 'nothing left this machine', 'no TLS, no remote socket, no mail port, no other host', `tls ${wire.tls.length}, remote ${wire.remote.length}, mail ${wire.mailPorts.length}, hosts ${[...offHost].join(',') || 'none'}`,
    !wire.tls.length && !wire.remote.length && !wire.mailPorts.length && !offHost.size)
  if (!SELF_CHECK) {
    record('G', 'no page error, and no write this check doesn\'t answer', 'none', `errors ${pageErrors.join(' | ') || 'none'}; writes ${otherWrites.join(',') || 'none'}`, !pageErrors.length && !otherWrites.length)
    fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(SHOT_DIR, 'results-process-with-triumph.md'), [
      '| Step | Check | Expected | Observed | Verdict | Screen |', '|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.step} | ${r.title} | ${r.expected} | ${r.observed} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
      '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`, '',
    ].join('\n'))
  }
  const failed = rows.filter((r) => r.verdict === 'FAIL').length
  console.log(`\n${rows.length - failed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(`process-with-triumph: ${e && e.stack}`)
  process.exit(1)
})
