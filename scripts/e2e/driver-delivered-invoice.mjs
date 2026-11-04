#!/usr/bin/env node
// LogisX — the driver's Delivered starts the invoice (AUTO_INVOICE_DRIVER_TRIGGER_ENABLED, on unless
// set to false), as a Super Admin sees it on Completed Loads, on made-up data only.
//
// What the page shows comes from the job itself: lib/auto-invoice-job.js runs in this process on an
// in-memory database, with a made-up sheet, engine, mailbox and SMTP sender, in the trigger's own
// mode. `_autoInvoice` is its annotateCompletedRows(), Try again is its own route, and a status write
// is the three lines PUT /api/driver/status adds (scripts/test-auto-invoice-wiring.js runs those on
// the route as shipped). Steps, each at 1280x800 and 375x812:
//   T   the chip moving: a load delivered before the switch has none; a driver taps two loads, and
//       while the first builds it reads "Making the invoice now" and the second "Waiting: about to
//       be made"; then both read "Sent to the broker": one SMTP call each, no draft; a repeat tap
//       sends nothing more
//   O   the office marks a load Delivered, a Dispatcher and a Super Admin each on the same route: no
//       record, no send; "No automatic invoice" in amber, its sentence in the load dialog, no Try
//       again, counted by Needs attention; a person's draft clears it
//   R   Try again's confirm, by what it would do: "sends" on a load held for a person (Cancel posts
//       nothing; OK posts once, answers "It's being made now.", looks first, one SMTP call); a hit in
//       the mailbox and a filled Payments Table row send nothing; "looks in Gmail" on MAYBE_SENT, which
//       never sends; "a Gmail draft" while sending is stopped; no Try again on OFF_GAP
//   G   no TLS connection, no socket to another host or a mail port from this process; the browser
//       opened no socket off this machine and asked no mail host. Any other host it asks (its web
//       fonts) is aborted, and only reported, as in time-off-chr-draft.mjs
//
// Like time-off-chr-draft.mjs this boots no server.js, reads no settings file or key and signs nobody
// in. It serves the checkout's built client/dist on 127.0.0.1 (E2E_PORT, or a free port the system
// picks) and answers every /api request in the browser. Every request to another host is aborted, the
// socket included, so no live event arrives: the page reads a change on a reload.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/driver-delivered-invoice.mjs
//
// Env: E2E_PORT (3000 and 5173 are refused, and so is a port in use), HEADED=1, CHROME_PATH, E2E_WORK_DIR.
// Output: PASS/FAIL lines, a final count, <work dir>/results-driver-delivered-invoice.md and screenshots
// in ~/LogisX-replica/screens/chr-invoice/. Exit 0 only when every row PASSes.
import { chromium } from 'playwright-core'
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
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = path.join(os.homedir(), 'LogisX-replica', 'screens', 'chr-invoice')
const PHONE = { tag: '375x812', viewport: { width: 375, height: 812 } }
const DESKTOP = { tag: '1280x800', viewport: { width: 1280, height: 800 } }

function die(msg) {
  console.error(`driver-delivered-invoice: ${msg}`)
  process.exit(2)
}

if (process.env.E2E_PORT && (!Number.isInteger(ASKED_PORT) || ASKED_PORT < 1024 || ASKED_PORT > 65535)) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (ASKED_PORT === 3000 || ASKED_PORT === 5173) die(`refusing port ${ASKED_PORT}: 3000 is production's port on the VPS and 5173 is Vite's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm --prefix client run build\` first`)

// ---------------------------------------------------------------- nothing leaves this process
// Set before any lib is loaded. Every socket goes through Socket.prototype.connect (http's agent
// keeps its own copy of net.createConnection, so patching that alone would miss it).
const wire = { tls: [], remote: [], mailPorts: [], offHost: new Set(), offHostSockets: [] }
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
  throw new Error('driver-delivered-invoice: TLS refused in this check')
}
const realConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedConnect(...args) {
  const { host, port } = targetOf(args)
  if (!LOOPBACK.has(host)) {
    wire.remote.push(host)
    throw new Error('driver-delivered-invoice: only 127.0.0.1 is reachable in this check')
  }
  if (MAIL_PORTS.has(port)) {
    wire.mailPorts.push(port)
    throw new Error('driver-delivered-invoice: mail ports are refused in this check')
  }
  return realConnect.apply(this, args)
}

// ---------------------------------------------------------------- the job, from the server's own modules
const require = createRequire(import.meta.url)
const Database = require(path.join(paths.REPO, 'node_modules', 'better-sqlite3'))
const jobLib = require(path.join(paths.REPO, 'lib', 'auto-invoice-job.js'))
const ledger = require(path.join(paths.REPO, 'lib', 'auto-invoice-ledger.js'))
const rules = require(path.join(paths.REPO, 'lib', 'auto-invoice-rules.js'))
const { textPdf } = require(path.join(paths.REPO, 'scripts', 'lib', 'made-up-pdf.js'))

// ---------------------------------------------------------------- made-up fixtures
const ADMIN = { id: 90331, username: 'qa-delivered-admin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Delivered Admin', companyName: '', mustChangePassword: false }
const DISPATCHER = Object.freeze({ role: 'Dispatcher' })
const DRIVER = Object.freeze({ role: 'Driver' })
const DRIVER_NAME = 'Casey Example'
const DOMAIN = 'broker.example.test'
const BROKER = `ops@${DOMAIN}`
const BILLING = `billing@${DOMAIN}`
const PAYMENTS_HEADERS = Object.freeze([' Job ID', 'Contract ID', 'Payment Amount', 'Invoice Number', 'Payment Date', 'Payment Status'])

// The columns the page shows; the job also reads the broker Email, which this list leaves off.
const HEADERS = ['Load ID', 'Status', 'Driver', 'Truck', 'Pickup Address', 'Drop-off Address', 'Payment', 'Completion Date']
const JOB_HEADERS = [...HEADERS, 'Email']

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const [TY, TM, TD] = TODAY.split('-')
const DELIVERED_ON = `${TM}/${TD}/${TY} 09:15:00`

// The screen's copy, pinned here so a changed word is a FAIL rather than a matching read.
const WORDS = {
  queued: { label: 'Waiting: about to be made', tone: 'muted', reason: 'The invoice will be made shortly.' },
  working: { label: 'Making the invoice now', tone: 'muted', reason: 'The invoice is being made. It takes a minute or two.' },
  sent: (id) => ({ label: 'Sent to the broker', tone: 'ok', reason: `Invoice ${id} was sent to the broker automatically. Its copy is in Gmail Sent Mail.` }),
  notStarted: { label: 'No automatic invoice', tone: 'warn', reason: "No automatic invoice was started for this load: only the driver's own Delivered starts one. Draft it by hand." },
  mailboxHit: { label: 'Needs attention: an email names this load', tone: 'bad', reason: 'An email already names this load, so nothing was sent. Check Gmail. If it still needs an invoice, draft it by hand.' },
  paymentsHit: { label: 'Needs attention: on the Payments Table', tone: 'bad', reason: 'The Payments Table already holds an invoice or payment for this load, so nothing was sent. Check it. If the load still needs an invoice, draft it by hand.' },
  held: { label: 'Needs attention: totals differ', tone: 'bad' },
  maybeSent: { label: 'Needs attention: may already be sent', tone: 'bad' },
  offGap: { label: 'Needs attention: completed while off', tone: 'bad' },
}
const CONFIRM_SEND = 'Try again looks in the mailbox and the Payments Table, then sends this invoice to the broker if every check passes. Continue?'
const CONFIRM_SEARCH = 'Try again looks in Gmail first for what may already have gone. Continue?'
const CONFIRM_DRAFT = 'Try again makes this invoice a Gmail draft for a person to send, if every check passes. Continue?'
const DONE_TEXT = "It's being made now."

function gate() {
  let open = null
  const p = new Promise((resolve) => { open = resolve })
  return { p, open }
}

// One made-up server's worth of state and the job on it. A load's row is what Job Tracking would hold.
async function freshServer() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, driver TEXT NOT NULL DEFAULT '', type TEXT NOT NULL,
      file_name TEXT NOT NULL, drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_at DATETIME DEFAULT NULL);
    CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT, recipient_source TEXT,
      total TEXT, broker_name TEXT, order_number TEXT, via TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), created_by TEXT,
      edited INTEGER DEFAULT 0, edited_fields TEXT DEFAULT '');
    CREATE TABLE deleted_loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, row_index INTEGER DEFAULT 0, deleted_at DATETIME, deleted_by TEXT DEFAULT '');
    CREATE TABLE broker_invoice_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, load_key TEXT NOT NULL, voided_at TEXT);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
  `)
  const s = {
    db,
    rows: [],
    smtp: [],
    appends: [],
    looks: [],
    paymentsReads: 0,
    payments: [[...PAYMENTS_HEADERS]],
    lookAnswer: { verdict: 'clean', mailboxes: {} },
    retryPosts: [],
    renderHook: null,
    prepareHook: null,
    logs: [],
    numbers: 0,
    ids: 0,
    routes: {},
  }
  s.row = (id) => s.rows.find((r) => rules.loadKey(r['Load ID']) === rules.loadKey(id)) || null
  s.addLoad = (id, status = 'At Receiver') => {
    s.rows.push({
      _rowIndex: s.rows.length + 2,
      'Load ID': id,
      Status: status,
      Driver: DRIVER_NAME,
      Truck: 'QA-T1',
      'Pickup Address': '100 Example Rd, Memphis, TN 38118',
      'Drop-off Address': '200 Sample Ave, Dallas, TX 75201',
      Payment: '$1,234.00',
      'Completion Date': status === 'Delivered' ? DELIVERED_ON : '',
      Email: BROKER,
      _pickupStreet: '100 Example Rd',
      _pickupLocation: 'Memphis, TN 38118',
      _dropStreet: '200 Sample Ave',
      _dropLocation: 'Dallas, TX 75201',
    })
    db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES (?, 'POD', ?, ?, datetime('now', '-60 minutes'))").run(id, `${id}_POD.pdf`, `/uploads/${id}_POD.pdf`)
  }
  ledger.writeSettings(db, { optOutDomains: [], confirmedBrokerDomains: [DOMAIN] }, { by: ADMIN.username, nowIso: new Date().toISOString() })
  const job = jobLib.create({
    db,
    env: { AUTO_INVOICE_DRAFTS_ENABLED: 'true', AUTO_INVOICE_DRAFTS_SHADOW: 'false' },
    readJobTracking: async () => ({ headers: JOB_HEADERS, data: s.rows.map((r) => ({ ...r })) }),
    closedMonthsOf: () => [],
    dayKeyOf: (cell) => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(cell || ''))
      return m ? `${m[3]}-${m[1]}-${m[2]}` : ''
    },
    uploadsRoot: path.join(path.sep, 'made-up', 'uploads'),
    fileExists: () => true,
    engine: {
      async prepare({ loadId }) {
        if (s.prepareHook) {
          const refused = s.prepareHook(loadId)
          if (refused) return refused
        }
        return { ok: true, ctx: { loadId, to: BILLING } }
      },
      async render(ctx, opts) {
        if (s.renderHook) await s.renderHook(ctx.loadId)
        const ref = String(ctx.loadId)
        const [y, m, d] = String(opts.invoiceDate).split('-')
        return {
          to: ctx.to,
          subject: `Example Freight Order #${ref}`,
          html: `<p>Please see the attached documents for load number ${ref}.</p>`,
          attachments: [
            { filename: `Example Freight Invoice Order #${ref}.pdf`, content: textPdf(`INVOICE Invoice ID # : ${opts.invoiceId} Date: ${m}/${d}/${y} Made-up Co. Load ID# ${ref} Total $1,234.00`), contentType: 'application/pdf' },
            { filename: `${ref}_POD.pdf`, content: Buffer.from(`%PDF-1.4 made-up POD for ${ref}`), contentType: 'application/pdf' },
            { filename: `${ref}.pdf`, content: Buffer.from(`%PDF-1.4 made-up rate con for ${ref}`), contentType: 'application/pdf' },
          ],
          total: '$1,234.00',
        }
      },
      async record(ctx, rendered, opts) {
        const r = db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', ?, ?)")
          .run(ctx.loadId, opts.invoiceId, rendered.to, opts.via, opts.actor.username)
        return { recorded: true, draftRowId: r.lastInsertRowid }
      },
    },
    nextInvoiceNumber: () => `${TM}${TD}${TY}-${++s.numbers}`,
    appendGmailDraft: async (o) => { s.appends.push(o.to); return { ok: true } },
    findDraftByMessageId: async () => ({ found: false, count: 0, mailbox: '', like: { count: 0 } }),
    newMessageId: () => `<qa-delivered-${++s.ids}.auto-invoice@example.com>`,
    mailbox: () => ({ user: 'qa-mailbox@example.com', pass: 'made-up' }),
    bisonRecipient: () => '',
    logAudit: () => {},
    notify: () => {},
    geminiUnavailableAt: () => null,
    log: { warn: (m) => s.logs.push(m), error: (m) => s.logs.push(m) },
    timeZone: 'America/New_York',
    workerId: 'qa-delivered-worker',
    send: { enabled: true, domains: [DOMAIN], settleMinutes: 0 },
    sendMail: async (o) => { s.smtp.push({ to: o.to, loadId: o.subject.replace(/^.*#/, ''), attachments: o.attachments.map((a) => a.filename) }); return { ok: true } },
    readPaymentsTable: async () => { s.paymentsReads++; return s.payments },
    lookInMailbox: async (o) => { s.looks.push(o.loadNumber); return s.lookAnswer },
    sleep: async () => {},
  })
  s.job = job
  const add = (method) => (p, ...handlers) => { s.routes[`${method} ${p}`] = handlers }
  job.mount({ get: add('GET'), put: add('PUT'), post: add('POST') }, { requireRole: () => (req, res, next) => next() })
  s.callRoute = async (name, params, body) => {
    const out = { status: 200, body: {} }
    const res = { status(c) { out.status = c; return res }, json(b) { out.body = b; return res } }
    const req = { params, body, session: { user: ADMIN } }
    for (const handler of s.routes[name] || []) {
      let goOn = false
      await handler(req, res, () => { goOn = true })
      if (!goOn) break
    }
    return out
  }
  // The three lines PUT /api/driver/status adds, around the write they guard.
  s.statusWrite = (who, id, newStatus = 'Delivered') => {
    const row = s.row(id)
    const start = job.driverDelivered({ role: who.role, loadId: id, oldStatus: row.Status, newStatus, readBack: async () => s.row(id).Status })
    row.Status = newStatus
    if (rules.isCompletedStatus(newStatus)) row['Completion Date'] = DELIVERED_ON
    start.written()
  }
  s.claim = (id) => ledger.getClaim(db, rules.loadKey(id))
  // A claim as an earlier run left it.
  s.seedClaim = (id, fields) => {
    ledger.insertClaim(db, { key: rules.loadKey(id), loadId: id, state: fields.state, code: fields.reason_code || '', nowIso: new Date().toISOString() })
    const { state: _state, ...rest } = fields
    const cols = Object.keys(rest)
    if (cols.length) db.prepare(`UPDATE auto_invoice_claims SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE load_key = ?`).run(...cols.map((c) => rest[c]), rules.loadKey(id))
  }
  s.handDraft = (id) => db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', 'imap', ?)").run(id, `${TM}${TD}${TY}-90`, BILLING, ADMIN.username)
  // A load delivered before the switch: the first start-up leaves it to people.
  s.addLoad('QA-OLD-8000', 'Delivered')
  job.startTrigger()
  await job.finishStartUp()
  return s
}

function dashboardBody(s) {
  const completed = s.rows.filter((r) => rules.isCompletedStatus(r.Status)).map((r) => ({ ...r }))
  s.job.annotateCompletedRows({ rows: completed, headers: JOB_HEADERS, isSuperAdmin: true })
  return {
    timestamp: new Date().toISOString(),
    kpis: { activeLoads: 0, unassignedLoads: 0, completedThisWeek: completed.length, completedThisMonth: completed.length, fleetUtilization: { assigned: 0, total: 1 }, revenue: { total: 0, paid: 0, pending: 0 } },
    unassignedJobs: [], jobTrackingHeaders: HEADERS, completedHeaders: HEADERS, activeJobs: [],
    completedJobs: completed,
    fleet: [], drivers: [DRIVER_NAME], driverQueues: {},
    autoInvoice: { mode: 'on' },
  }
}

const json200 = (body) => ({ status: 200, body })
const parse = (raw) => { try { return JSON.parse(raw || 'null') } catch { return null } }

function answerGet(s, pathname) {
  if (pathname === '/api/auth/session') return json200({ authenticated: true, user: ADMIN, appTimeZone: 'America/New_York' })
  if (pathname === '/api/dashboard') return json200(dashboardBody(s))
  if (pathname === '/api/auto-invoice/settings') return json200({ ...ledger.readSettings(s.db), send: { domains: [DOMAIN], stopped: ledger.getSendStop(s.db) } })
  if (pathname === '/api/dispatch-notifications') return json200({ notifications: [], unreadCount: 0 })
  if (pathname === '/api/load-ratings/averages') return json200({ averages: {} })
  if (pathname === '/api/truck-assignments') return json200({ assignments: [] })
  if (pathname === '/api/config/maps-key') return json200({ key: 'qa-delivered-no-key' })
  if (pathname === '/api/locations/latest') return json200({ locations: [] })
  if (pathname === '/api/integrations/chr/status') return json200({ enabled: false })
  if (pathname.startsWith('/api/load-ratings/')) return json200({ rating: 0 })
  if (pathname.startsWith('/api/geocode/load/')) return json200({})
  let m
  if ((m = pathname.match(/^\/api\/documents\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1])
    return json200({ documents: [{ id: 501, type: 'POD', file_name: `${id}_POD.pdf`, drive_url: null, uploaded_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }] })
  }
  if (/^\/api\/loads\/[^/]+\/invoice-draft$/.test(pathname)) return json200({ draft: null })
  if (/^\/api\/loads\/[^/]+\/status-history$/.test(pathname)) return json200({ phases: [] })
  if (/^\/api\/loads\/[^/]+\/haul$/.test(pathname)) return json200({ driven: null, lane: null })
  if (/^\/api\/loads\/[^/]+\/ratecon\.pdf$/.test(pathname)) return { status: 404, body: { error: 'No rate con in this check.', code: 'RATECON_NOT_FOUND' } }
  return null
}

// Try again, through the job's own route. Anything else the page writes is listed, not answered for real.
async function answerWrite(s, method, pathname, raw) {
  const m = pathname.match(/^\/api\/auto-invoice\/loads\/([^/]+)\/retry$/)
  if (method === 'POST' && m) {
    const loadKey = decodeURIComponent(m[1])
    s.retryPosts.push(loadKey)
    return s.callRoute('POST /api/auto-invoice/loads/:loadKey/retry', { loadKey }, parse(raw) || {})
  }
  return null
}

// ---------------------------------------------------------------- the static server
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

function portInUse(port) {
  return new Promise((resolve) => {
    const c = net.connect({ host: HOST, port }, () => { c.destroy(); resolve(true) })
    c.on('error', () => resolve(false))
  })
}

// ---------------------------------------------------------------- results
const rows = []
const otherWrites = []
const unanswered = new Set()
const pageErrors = []
function record(step, title, expected, observed, pass, shotFile = '') {
  rows.push({ step, title, expected, observed, verdict: pass ? 'PASS' : 'FAIL', shot: shotFile })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${step}  ${title}: ${observed}`)
  if (!pass) console.log(`      expected: ${expected}`)
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(SHOT_DIR, `${name}.png`)
  await page.screenshot({ path: file })
  return file
}

// ---------------------------------------------------------------- page helpers
// `dialogs.plan` holds the answers to the next browser dialogs. A dialog with no planned answer is
// dismissed, and `dialogs.seen` shows it, so an extra question fails its row.
async function openPage(browser, size, s) {
  const phone = size.viewport.width < 640
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) { wire.offHost.add(u.host); return route.abort() }
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    const isGet = req.method() === 'GET'
    const out = isGet ? answerGet(s, u.pathname) : await answerWrite(s, req.method(), u.pathname, req.postData())
    if (out === null) {
      if (isGet) unanswered.add(u.pathname)
      else otherWrites.push(`${size.tag} ${req.method()} ${u.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({ status: out.status, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out.body) })
  })
  const page = await ctx.newPage()
  const dialogs = { seen: [], plan: [] }
  page.on('pageerror', (e) => pageErrors.push(`${size.tag}: ${String(e.message || e).slice(0, 200)}`))
  page.on('websocket', (ws) => {
    let host = ''
    try { host = new URL(ws.url()).host } catch { host = '(unreadable)' }
    if (host !== `${HOST}:${PORT}`) wire.offHostSockets.push(host)
  })
  page.on('dialog', async (d) => {
    const answer = dialogs.plan.shift() || { accept: false }
    dialogs.seen.push({ type: d.type(), message: d.message() })
    if (answer.accept) await d.accept().catch(() => {})
    else await d.dismiss().catch(() => {})
  })
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  return { ctx, page, dialogs }
}

const locText = (loc) => loc.first().textContent({ timeout: 2000 }).then((t) => (t || '').replace(/\s+/g, ' ').trim(), () => '')
async function appears(page, selector, ms) {
  try { await page.waitForSelector(selector, { state: 'visible', timeout: ms }); return true } catch { return false }
}
const hides = (page, selector, ms = 5000) => page.waitForSelector(selector, { state: 'hidden', timeout: ms }).then(() => true, () => false)
async function until(check, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1)

async function openCompleted(page) {
  await page.locator('[role="tab"]', { hasText: 'Completed' }).first().click({ timeout: 15000 })
  return appears(page, 'tbody tr', 10000)
}
// The socket is aborted here, so a change on the server reaches the page by a reload.
async function reloadCompleted(page) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  return openCompleted(page)
}
const rowOf = (page, id) => page.locator('tbody tr', { hasText: id }).first()
const toggleText = async (page) => ((await page.locator('button.auto-toggle').count()) ? locText(page.locator('button.auto-toggle')) : '')

// The chip on a load's row, against the words pinned above. `want` null: no chip.
async function chipStep(page, step, title, id, want) {
  const chip = rowOf(page, id).locator('.auto-chip')
  const count = await chip.count()
  const label = count ? await locText(chip) : ''
  const cls = count ? (await chip.first().getAttribute('class')) || '' : ''
  const tip = count ? (await chip.first().getAttribute('title')) || '' : ''
  if (!want) {
    record(step, title, 'no chip on the row', `chips ${count}${label ? `, "${label}"` : ''}`, count === 0)
    return
  }
  const pass = count === 1 && label === want.label && cls.includes(`auto-chip--${want.tone}`) && (!want.reason || tip === want.reason)
  record(step, title, `one chip "${want.label}", tone ${want.tone}${want.reason ? `, title "${want.reason}"` : ''}`, `chips ${count}, label "${label}", class "${cls}", title "${tip}"`, pass)
}

async function openLine(page, id) {
  await rowOf(page, id).locator('.auto-chip').click({ timeout: 8000 })
  return appears(page, '.auto-line', 8000)
}
async function closeLine(page) {
  await page.keyboard.press('Escape')
  await hides(page, '.auto-line')
}
const tryAgainButton = (page) => page.locator('.auto-line button', { hasText: 'Try again' })

// ---------------------------------------------------------------- T: the chip moving
async function chipRun(browser, size) {
  const tag = `T-${size.tag}`
  const s = await freshServer()
  const FIRST = 'QA-TAP-8001'
  const SECOND = 'QA-TAP-8002'
  s.addLoad(FIRST)
  s.addLoad(SECOND)
  const { ctx, page } = await openPage(browser, size, s)
  try {
    const listed = await openCompleted(page)
    record(`${tag}-list`, 'Completed Loads lists the load delivered before the switch', 'a row', `listed ${listed}`, listed)
    if (!listed) return
    await chipStep(page, `${tag}-old`, 'A load delivered before the switch', 'QA-OLD-8000', null)

    // The first load's build is held open, so the page can see both while one is being made.
    const held = gate()
    s.renderHook = (loadId) => (loadId === FIRST ? held.p : undefined)
    s.statusWrite(DRIVER, FIRST)
    const building = await until(() => (s.claim(FIRST) || {}).state === 'working' && (s.claim(FIRST) || {}).stage === 'reserved')
    s.statusWrite(DRIVER, SECOND)
    const inLine = await until(() => (s.claim(SECOND) || {}).state === 'queued')
    record(`${tag}-tap`, 'A driver taps Delivered on two loads, with no tick and no timer', 'the first is being built, the second waits its turn, nothing has gone', `first ${(s.claim(FIRST) || {}).state}, second ${(s.claim(SECOND) || {}).state}, SMTP ${s.smtp.length}`, building && inLine && s.smtp.length === 0)
    await reloadCompleted(page)
    await chipStep(page, `${tag}-working`, 'The load being built', FIRST, WORDS.working)
    await chipStep(page, `${tag}-queued`, 'The load waiting its turn', SECOND, WORDS.queued)
    const movingFile = await shot(page, `${tag}-moving`)
    const fits = await noSideScroll(page)
    record(`${tag}-moving`, 'The list fits while the chips move', 'no side scroll', `fits ${fits}`, fits, movingFile)

    held.open()
    const done = await until(() => s.smtp.length === 2 && (s.claim(SECOND) || {}).state === 'drafted')
    await reloadCompleted(page)
    await chipStep(page, `${tag}-sent-1`, 'The first load, gone', FIRST, WORDS.sent((s.claim(FIRST) || {}).invoice_id))
    await chipStep(page, `${tag}-sent-2`, 'The second load, gone in its turn', SECOND, WORDS.sent((s.claim(SECOND) || {}).invoice_id))
    const each = [FIRST, SECOND].map((id) => s.smtp.filter((m) => m.loadId === id).length)
    const files = s.smtp.find((m) => m.loadId === FIRST)
    const sentFile = await shot(page, `${tag}-sent`)
    record(`${tag}-one-each`, 'One SMTP call per load, with no draft', 'one each, to the billing address: invoice, POD, rate con; no Gmail append', `calls ${each.join(',')}, to ${files ? files.to : ''}, files ${files ? files.attachments.length : 0}, appends ${s.appends.length}`,
      done && each[0] === 1 && each[1] === 1 && !!files && files.to === BILLING && files.attachments.length === 3 && s.appends.length === 0, sentFile)

    s.statusWrite(DRIVER, FIRST)
    await new Promise((r) => setTimeout(r, 300))
    record(`${tag}-repeat`, 'A repeat tap on a load sent', 'nothing more', `SMTP ${s.smtp.length}, state ${(s.claim(FIRST) || {}).state}`, s.smtp.length === 2 && (s.claim(FIRST) || {}).state === 'drafted')
  } finally {
    await ctx.close()
    s.db.close()
  }
}

// ---------------------------------------------------------------- O: the office's Delivered
async function officeRun(browser, size) {
  const tag = `O-${size.tag}`
  const s = await freshServer()
  const BY_DISPATCH = 'QA-OFFICE-8101'
  const BY_ADMIN = 'QA-OFFICE-8102'
  s.addLoad(BY_DISPATCH)
  s.addLoad(BY_ADMIN)
  s.statusWrite(DISPATCHER, BY_DISPATCH)
  s.statusWrite(ADMIN, BY_ADMIN)
  await new Promise((r) => setTimeout(r, 300))
  const { ctx, page } = await openPage(browser, size, s)
  try {
    record(`${tag}-none`, 'The office marks two loads Delivered on the driver\'s route', 'no record and no send for either', `claims ${JSON.stringify([s.claim(BY_DISPATCH), s.claim(BY_ADMIN)].map((c) => (c ? c.state : null)))}, SMTP ${s.smtp.length}, appends ${s.appends.length}`,
      !s.claim(BY_DISPATCH) && !s.claim(BY_ADMIN) && s.smtp.length === 0 && s.appends.length === 0)
    const listed = await openCompleted(page)
    if (!listed) {
      record(`${tag}-list`, 'Completed Loads lists them', 'rows', 'not listed', false)
      return
    }
    await chipStep(page, `${tag}-dispatcher`, 'A Dispatcher\'s Delivered', BY_DISPATCH, WORDS.notStarted)
    await chipStep(page, `${tag}-admin`, 'A Super Admin\'s Delivered', BY_ADMIN, WORDS.notStarted)
    const toggle = await toggleText(page)
    const fits = await noSideScroll(page)
    const listFile = await shot(page, `${tag}-chips`)
    record(`${tag}-toggle`, 'Needs attention counts them, and the list fits', '"Needs attention (2)"; no side scroll', `toggle "${toggle}", fits ${fits}`, toggle === 'Needs attention (2)' && fits, listFile)

    const opened = await openLine(page, BY_DISPATCH)
    const line = page.locator('.auto-line')
    const text = opened ? await locText(line) : ''
    const cls = opened ? (await line.first().getAttribute('class')) || '' : ''
    const buttons = opened ? await page.locator('.auto-line button').count() : -1
    const want = `${WORDS.notStarted.label}. ${WORDS.notStarted.reason}`
    const lineFile = await shot(page, `${tag}-line`)
    record(`${tag}-line`, 'The load dialog\'s line', `"${want}", amber, no button on it (no Try again: there is nothing to retry)`, `"${text}", class "${cls}", buttons ${buttons}`, text === want && cls.includes('auto-line--warn') && buttons === 0, lineFile)
    if (opened) await closeLine(page)

    s.handDraft(BY_DISPATCH)
    await reloadCompleted(page)
    await chipStep(page, `${tag}-drafted`, 'A person drafts it by hand', BY_DISPATCH, null)
    const after = await toggleText(page)
    record(`${tag}-after`, 'Needs attention counts the one left', '"Needs attention (1)"', `toggle "${after}"`, after === 'Needs attention (1)')
  } finally {
    await ctx.close()
    s.db.close()
  }
}

// ---------------------------------------------------------------- R: Try again's confirm
// A load a driver delivered, held for a person: what a fix to the sheet then Try again meets.
async function heldLoad(s, id) {
  s.addLoad(id)
  s.prepareHook = (loadId) => (loadId === id ? { ok: false, http: 422, code: 'TOTAL_MISMATCH' } : null)
  s.statusWrite(DRIVER, id)
  await until(() => (s.claim(id) || {}).state === 'needs_attention')
  s.prepareHook = null
}

async function pressTryAgain(page, dialogs, accept) {
  const before = dialogs.seen.length
  dialogs.plan.push({ accept })
  await tryAgainButton(page).click({ timeout: 5000 })
  await until(() => dialogs.seen.length > before, 5000)
  return dialogs.seen[dialogs.seen.length - 1] || { type: '', message: '' }
}

async function tryAgainRun(browser, size) {
  const tag = `R-${size.tag}`
  const s = await freshServer()
  const CLEAN = 'QA-HOLD-8201'
  const HIT = 'QA-HOLD-8202'
  const TABLE = 'QA-HOLD-8203'
  const MAYBE = 'QA-MAYBE-8204'
  const GAP = 'QA-GAP-8205'
  const STOPPED = 'QA-HOLD-8206'
  await heldLoad(s, CLEAN)
  await heldLoad(s, HIT)
  await heldLoad(s, TABLE)
  await heldLoad(s, STOPPED)
  s.addLoad(MAYBE, 'Delivered')
  s.seedClaim(MAYBE, { state: 'needs_attention', reason_code: 'MAYBE_SENT', stage: 'appending', delivery: 'send', invoice_id: `${TM}${TD}${TY}-70`, message_id: '<qa-delivered-maybe.auto-invoice@example.com>', sent_json: '{}' })
  s.addLoad(GAP, 'Delivered')
  s.seedClaim(GAP, { state: 'needs_attention', reason_code: 'OFF_GAP' })
  const { ctx, page, dialogs } = await openPage(browser, size, s)
  try {
    const listed = await openCompleted(page)
    if (!listed) {
      record(`${tag}-list`, 'Completed Loads lists them', 'rows', 'not listed', false)
      return
    }
    await chipStep(page, `${tag}-held`, 'A load held for a person', CLEAN, WORDS.held)

    // Cancel: nothing is posted.
    let opened = await openLine(page, CLEAN)
    let asked = opened ? await pressTryAgain(page, dialogs, false) : { type: '', message: '' }
    await new Promise((r) => setTimeout(r, 300))
    const askFile = await shot(page, `${tag}-held-line`)
    record(`${tag}-cancel`, 'Try again asks first, and Cancel posts nothing', `one confirm "${CONFIRM_SEND}"; no POST; the claim as it was`, `${asked.type} "${asked.message}", posts ${s.retryPosts.length}, state ${s.claim(CLEAN).state}`,
      asked.type === 'confirm' && asked.message === CONFIRM_SEND && s.retryPosts.length === 0 && s.claim(CLEAN).state === 'needs_attention', askFile)

    // OK: one POST, the answer, the look, one send.
    asked = opened ? await pressTryAgain(page, dialogs, true) : asked
    const posted = await until(() => s.retryPosts.length === 1, 5000)
    const answered = await appears(page, `.auto-result:has-text("${DONE_TEXT}")`, 5000)
    const sentOnce = await until(() => s.smtp.length === 1 && s.claim(CLEAN).state === 'drafted')
    const okFile = await shot(page, `${tag}-answer`)
    record(`${tag}-ok`, 'OK posts once, says it\'s being made, looks first, and sends once', `one POST; "${DONE_TEXT}"; the Payments Table and the mailbox read once each; one SMTP call`,
      `posts ${s.retryPosts.length}, answer shown ${answered}, table reads ${s.paymentsReads}, looks ${s.looks.join(',')}, SMTP ${s.smtp.length}, state ${s.claim(CLEAN).state}`,
      posted && answered && sentOnce && s.paymentsReads === 1 && s.looks.length === 1 && s.looks[0] === CLEAN, okFile)
    await closeLine(page)
    await reloadCompleted(page)
    await chipStep(page, `${tag}-sent`, 'The page after it', CLEAN, WORDS.sent(s.claim(CLEAN).invoice_id))

    // A hit in the mailbox: refused, nothing sent, Try again still there.
    s.lookAnswer = { verdict: 'mention', mailboxes: {} }
    opened = await openLine(page, HIT)
    if (opened) await pressTryAgain(page, dialogs, true)
    await until(() => s.claim(HIT).state === 'needs_attention' && s.claim(HIT).reason_code === 'MAILBOX_HIT')
    s.lookAnswer = { verdict: 'clean', mailboxes: {} }
    if (opened) await closeLine(page)
    await reloadCompleted(page)
    await chipStep(page, `${tag}-hit`, 'An email already names the load', HIT, WORDS.mailboxHit)
    const hitFile = await shot(page, `${tag}-hit`)
    record(`${tag}-hit-sent`, 'A hit sends nothing and uses no number', 'one SMTP call in all, no number on this load', `SMTP ${s.smtp.length}, number "${s.claim(HIT).invoice_id}"`, s.smtp.length === 1 && !s.claim(HIT).invoice_id, hitFile)

    // A filled Payments Table row: the same.
    s.payments.push([TABLE, 'Example Freight', '$1,234.00', '', '', 'Paid'])
    opened = await openLine(page, TABLE)
    if (opened) await pressTryAgain(page, dialogs, true)
    await until(() => s.claim(TABLE).reason_code === 'PAYMENTS_TABLE_HIT')
    if (opened) await closeLine(page)
    await reloadCompleted(page)
    await chipStep(page, `${tag}-table`, 'A filled Payments Table row', TABLE, WORDS.paymentsHit)
    record(`${tag}-table-sent`, 'It sends nothing either', 'one SMTP call in all', `SMTP ${s.smtp.length}`, s.smtp.length === 1)

    // MAYBE_SENT: the confirm doesn't say "sends", and the press only searches.
    await chipStep(page, `${tag}-maybe`, 'A send that may have gone', MAYBE, WORDS.maybeSent)
    opened = await openLine(page, MAYBE)
    asked = opened ? await pressTryAgain(page, dialogs, true) : { type: '', message: '' }
    // Its search ends MAYBE_SENT with the stop, so the stop says the run is over.
    await until(() => !!ledger.getSendStop(s.db))
    const maybeFile = await shot(page, `${tag}-maybe-line`)
    record(`${tag}-maybe-confirm`, 'Its confirm says it looks, and the press sends nothing', `"${CONFIRM_SEARCH}"; one SMTP call in all; still MAYBE_SENT`, `"${asked.message}", SMTP ${s.smtp.length}, ${s.claim(MAYBE).state} ${s.claim(MAYBE).reason_code}`,
      asked.message === CONFIRM_SEARCH && s.smtp.length === 1 && s.claim(MAYBE).reason_code === 'MAYBE_SENT', maybeFile)
    if (opened) await closeLine(page)

    // Sending stopped (that MAYBE_SENT set the stop): the confirm says draft. Cancel posts nothing.
    await reloadCompleted(page)
    const postsBefore = s.retryPosts.length
    opened = await openLine(page, STOPPED)
    asked = opened ? await pressTryAgain(page, dialogs, false) : { type: '', message: '' }
    record(`${tag}-stopped`, 'While sending is stopped, the confirm says it makes a draft', `the stop is set; "${CONFIRM_DRAFT}"; Cancel posts nothing`, `stop ${JSON.stringify((ledger.getSendStop(s.db) || {}).reason)}, "${asked.message}", posts ${s.retryPosts.length - postsBefore}`,
      !!ledger.getSendStop(s.db) && asked.message === CONFIRM_DRAFT && s.retryPosts.length === postsBefore)
    if (opened) await closeLine(page)

    // OFF_GAP: no Try again; the server refuses it too.
    await chipStep(page, `${tag}-gap`, 'A load delivered while the job was off', GAP, WORDS.offGap)
    opened = await openLine(page, GAP)
    const buttons = opened ? await tryAgainButton(page).count() : -1
    const gapFile = await shot(page, `${tag}-gap-line`)
    const refused = await s.callRoute('POST /api/auto-invoice/loads/:loadKey/retry', { loadKey: GAP }, {})
    record(`${tag}-gap-line`, 'It offers no Try again, and the route refuses it', 'no Try again button; 409', `buttons ${buttons}, route ${refused.status} ${refused.body && refused.body.code}`, buttons === 0 && refused.status === 409, gapFile)
    if (opened) await closeLine(page)
  } finally {
    await ctx.close()
    s.db.close()
  }
}

// ---------------------------------------------------------------- G: nothing left
function wireStep() {
  // A page request to another host (its web fonts) is aborted in openPage(), so it's only reported.
  const offHost = [...wire.offHost].sort()
  const mailHosts = offHost.filter((h) => /mail|imap|smtp/i.test(h))
  record('G', 'Nothing left this machine',
    'no TLS connection, no socket to another host or a mail port; no browser socket off this machine and no mail host asked by the browser (any other host it asked was aborted, and is only reported)',
    `TLS ${wire.tls.length}, remote ${wire.remote.length}, mail ports ${wire.mailPorts.length}, browser sockets off this machine ${wire.offHostSockets.length}, hosts aborted ${offHost.join(',') || 'none'}`,
    wire.tls.length === 0 && wire.remote.length === 0 && wire.mailPorts.length === 0 && wire.offHostSockets.length === 0 && mailHosts.length === 0)
}

async function main() {
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ASKED_PORT, HOST, resolve) })
  PORT = server.address().port
  if (PORT === 3000 || PORT === 5173) { server.close(); die(`the system picked port ${PORT}: set E2E_PORT to a free one`) }
  BASE = `http://${HOST}:${PORT}`
  console.log(`driver-delivered-invoice: serving ${DIST} on ${BASE} (made-up data; no server.js, no mailbox)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const size of [DESKTOP, PHONE]) {
      for (const [name, run] of [['T', chipRun], ['O', officeRun], ['R', tryAgainRun]]) {
        try {
          await run(browser, size)
        } catch (e) {
          record(`${name}-${size.tag}`, 'The part ran to its end', 'no error', String(e && e.message).slice(0, 300), false)
        }
      }
    }
  } finally {
    await browser.close()
    server.close()
  }
  wireStep()

  const resultsFile = path.join(paths.workDir(), 'results-driver-delivered-invoice.md')
  const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    '# The driver\'s Delivered: what a Super Admin sees', '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Other writes sent by the page (not part of the verdict): ${otherWrites.length ? otherWrites.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, out, { mode: 0o600 })
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`driver-delivered-invoice: ${passed}/${rows.length} PASS, ${rows.length - passed} FAIL; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  if (pageErrors.length) console.log(`driver-delivered-invoice: page errors: ${pageErrors.join(' | ')}`)
  process.exit(passed === rows.length ? 0 : 1)
}

main().catch((e) => {
  console.error(`driver-delivered-invoice: aborted: ${e.stack || e}`)
  process.exit(1)
})
