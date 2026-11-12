#!/usr/bin/env node
// LogisX — the "factored" mark as a Super Admin uses it (lib/factoring-store.js,
// lib/factoring-routes.js, FactoringControls.vue), at 1280x800, on made-up data only.
//
// What the page shows comes from the server's own modules: they run in this process on an
// in-memory database, with a made-up sheet, engine and mailbox. `_factoring` is annotateDashboard()'s,
// `_autoInvoice` the job's annotateCompletedRows(), the switch and Try again post to the modules' own
// handlers, and a Draft Invoice press runs draftEarly(), the check server.js makes before anything
// is read or minted (scripts/test-invoice-draft-factored.js runs that route as shipped). Steps:
//   F   a listed account, both settings on: the switch with its one line; marks with a reason (the
//       button waits for one); one POST, one row, one audit row; the chip shows with the line, on
//       the server's own answer after a reload too; once the load is delivered, the Draft Invoice
//       button refuses it in words, and a confirmation answers 409 NOA_UNCONFIGURED; nothing reaches
//       the point where prepare() starts, while a load that isn't factored does
//   N   a Super Admin not listed, the same settings: the chip only on a marked load, nothing on any
//       other, no switch, no reason box, no line; the Draft Invoice button refuses; marking answers
//       403 and writes nothing; a confirmation answers 409 NOA_UNCONFIGURED
//   O   as production ships, both settings unset: no switch for anyone, the marking route answers
//       404 FEATURE_OFF; a load the lead's script marked shows the chip and is refused all the same
//   D   a job's Gmail draft: "Check it and send it" until a listed account marks the load (the switch
//       asks once); then the dialog and the row chip say not to send it and to delete it, on the
//       server's own answer after a reload and for a Super Admin not listed too
//   D2  a job's draft, marked, then cleared: no green "Draft ready" but a chip of its own that says
//       to check Gmail, Sent Mail included; a person's draft from before the clear leaves it, and one
//       made since takes over, so no chip keeps the old number
//   T   a draft that may be in Gmail, each of the two codes: the mark asks first, and a no leaves it
//       unmarked; a yes marks it, and nothing says it goes through Triumph; the row says not to send
//       it; Try again finds the draft and records it, and the row still says so; nothing is sent or
//       appended
//   C   marked, tapped, cleared: no chip while marked; once cleared, on a reload, "No automatic
//       invoice" with its own sentence and no Try again; the claim stays closed, nothing is sent, and
//       the Draft Invoice button passes the check, so a person can draft it
//   C2  the same with the driver's trigger off, the sweep's way: the same chip
//   M   a marked load's Load ID (the lines the row saves add around their write; the routes as shipped
//       are in scripts/test-row-save-cell-writes.js): a change is refused, a respelling too, with the way
//       through in one sentence; clear, change, mark again works, the chip shows on the new ID and the
//       tap stops on it; a dialog left open on the old ID can't mark that key
//   G   no TLS connection, no socket to another host or a mail port from this process; the browser
//       asked no mail host and opened no socket off this machine
//
// Like driver-delivered-invoice.mjs this boots no server.js, reads no settings file or key and signs
// nobody in. It serves the checkout's built client/dist on 127.0.0.1 (E2E_PORT, or a free port the
// system picks) and answers every /api request in the browser. Every request to another host is
// aborted, the socket included, so the page reads a change on a reload.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/factoring-mark-usable.mjs
//
// Env: E2E_PORT (3000 and 5173 are refused, and so is a port in use), HEADED=1, CHROME_PATH, E2E_WORK_DIR.
// Output: PASS/FAIL lines, a final count, <work dir>/results-factoring-mark-usable.md and screenshots
// in ~/LogisX-replica/screens/factoring-mark/. Exit 0 only when every row PASSes.
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
const SHOT_DIR = path.join(os.homedir(), 'LogisX-replica', 'screens', 'factoring-mark')
const VIEWPORT = { width: 1280, height: 800 }

function die(msg) {
  console.error(`factoring-mark-usable: ${msg}`)
  process.exit(2)
}

if (process.env.E2E_PORT && (!Number.isInteger(ASKED_PORT) || ASKED_PORT < 1024 || ASKED_PORT > 65535)) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (ASKED_PORT === 3000 || ASKED_PORT === 5173) die(`refusing port ${ASKED_PORT}: 3000 is production's port on the VPS and 5173 is Vite's`)
if (!fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm --prefix client run build\` first`)

// ---------------------------------------------------------------- nothing leaves this process
// Set before any lib is loaded. Every socket goes through Socket.prototype.connect (http's agent
// keeps its own copy of net.createConnection, so patching that alone would miss it).
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
  throw new Error('factoring-mark-usable: TLS refused in this check')
}
const realConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedConnect(...args) {
  const { host, port } = targetOf(args)
  if (!LOOPBACK.has(host)) {
    wire.remote.push(host)
    throw new Error('factoring-mark-usable: only 127.0.0.1 is reachable in this check')
  }
  if (MAIL_PORTS.has(port)) {
    wire.mailPorts.push(port)
    throw new Error('factoring-mark-usable: mail ports are refused in this check')
  }
  return realConnect.apply(this, args)
}

// ---------------------------------------------------------------- the server's own modules
const require = createRequire(import.meta.url)
const Database = require(path.join(paths.REPO, 'node_modules', 'better-sqlite3'))
const store = require(path.join(paths.REPO, 'lib', 'factoring-store.js'))
const routesLib = require(path.join(paths.REPO, 'lib', 'factoring-routes.js'))
const rules = require(path.join(paths.REPO, 'lib', 'auto-invoice-rules.js'))
const jobLib = require(path.join(paths.REPO, 'lib', 'auto-invoice-job.js'))
const ledger = require(path.join(paths.REPO, 'lib', 'auto-invoice-ledger.js'))
const { textPdf } = require(path.join(paths.REPO, 'scripts', 'lib', 'made-up-pdf.js'))

// ---------------------------------------------------------------- made-up fixtures
const account = (id, username, fullName) => Object.freeze({ id, username, role: 'Super Admin', driverName: '', email: '', fullName, companyName: '', mustChangePassword: false })
const LISTED = account(90411, 'qa-factoring-listed', 'QA Factoring Listed')
const NOT_LISTED = account(90412, 'qa-factoring-other', 'QA Factoring Other')
const SETTINGS_ON = Object.freeze({ TRIUMPH_FACTORING_ENABLED: 'true', TRIUMPH_FACTOR_MARK_IDS: String(LISTED.id) })
const SETTINGS_UNSET = Object.freeze({})
const DRIVER_NAME = 'Casey Example'
// The columns the page shows; the job also reads the broker Email, which this list leaves off.
const HEADERS = ['Load ID', 'Status', 'Driver', 'Truck', 'Pickup Address', 'Drop-off Address', 'Payment', 'Completion Date']
const JOB_HEADERS = [...HEADERS, 'Email']
// A domain the job drafts for, not one it sends to, so its invoice waits in Gmail for a person.
const DRAFT_DOMAIN = 'draft-broker.example.test'
const SEND_DOMAIN = 'send-broker.example.test'
const BROKER = `ops@${DRAFT_DOMAIN}`
const BILLING = `billing@${DRAFT_DOMAIN}`
const PAYMENTS_HEADERS = Object.freeze([' Job ID', 'Contract ID', 'Payment Amount', 'Invoice Number', 'Payment Date', 'Payment Status'])
const TO_MARK = 'QA-FACT-9001'
const ACTIVE_PLAIN = 'QA-FACT-9002'
const DONE_PLAIN = 'QA-FACT-9003'
const REASON = 'made-up: factored by hand for this check'

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const [TY, TM, TD] = TODAY.split('-')
const DELIVERED_ON = `${TM}/${TD}/${TY} 09:15:00`

// The screen's copy, pinned here so a changed word is a FAIL rather than a matching read.
const WORDS = {
  line: "Mark before the driver taps Delivered. After the invoice goes out, this can't be undone here.",
  notFactored: 'Not factored.',
  chip: 'Factored (Triumph). The invoice goes through Triumph, not by email. The Draft Invoice button refuses it.',
  chipOut: 'Factored (Triumph). The app sends no invoice for it by email, and the Draft Invoice button refuses it.',
  marked: 'Marked factored: its invoice goes through Triumph.',
  markedAsked: 'Marked factored. If a draft is in Gmail Drafts, delete it.',
  refused: 'This load is factored: its invoice goes through Triumph, not by email.',
  refusedOut: 'This load is factored, so no invoice can be drafted here. One may already be in Gmail, so check Gmail Drafts and Sent Mail.',
  askMaybe: 'An invoice draft for this load may be in Gmail, or may already have been sent from there. Was it NOT sent to the broker? If you confirm, delete any draft in Gmail.',
  refusedMaybe: 'An invoice draft for this load may be in Gmail, or may already have been sent from there. If it was not sent, confirm that with a reason, then delete any draft in Gmail.',
  notOnSheet: 'No row on Job Tracking holds this Load ID now, so nothing was changed. Reload the page and open the load again.',
  idRefused: "This load is marked factored, so its Load ID can't be changed: whoever manages factored loads can clear the mark, change the ID, then mark the load again.",
  noa: "This load is factored, and the app can't put Triumph's assignment on an invoice yet, so no draft was made. Its invoice goes through Triumph's own process.",
  notListed: 'Only the accounts listed for factoring may do this.',
  draftReady: { label: 'Draft ready in Gmail', tone: 'ok', reason: (id) => `Invoice ${id} is in Gmail Drafts. Check it and send it.` },
  dontSend: { label: "Factored: don't send the draft, delete it", tone: 'bad', reason: (what) => `Don't send ${what}: this load is marked factored. If its draft is in Gmail Drafts, delete it. If it's in Sent Mail, it already went to the broker, so tell whoever manages factored loads.` },
  cleared: { label: 'No automatic invoice', tone: 'warn', reason: 'This load was marked factored when its invoice came due, so no automatic invoice was made. The mark has been cleared, so draft it by hand.' },
  clearedDraft: { label: 'Mark cleared: check Gmail', tone: 'warn', reason: "This load's mark was cleared. If its draft is still in Gmail Drafts, check it and send it. If it's in Sent Mail, it already went to the broker. If it's in neither, draft it by hand." },
  clearedDone: 'No longer factored. If it is already delivered, draft its invoice by hand.',
  retrySearch: 'Try again looks in Gmail first for what may already have gone. Continue?',
  oldSend: 'Check it and send it',
}

// One made-up server's worth of state: the factoring routes with the settings given, and the job.
// `trigger` false: the driver's Delivered starts nothing, and the sweep finds the loads.
async function freshServer(env, { trigger = true } = {}) {
  const db = new Database(':memory:')
  store.ensureSchema(db)
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
  const s = { db, rows: [], audits: [], refusals: [], markPosts: [], retryPosts: [], presses: [], reachedPrepare: [], mounted: {}, jobRoutes: {}, gmail: new Set(), appends: [], smtp: [], logs: [], numbers: 0, ids: 0 }
  s.addLoad = (id, status) => {
    s.rows.push({
      _rowIndex: s.rows.length + 2,
      _id: s.rows.length + 2,
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
  s.addLoad(TO_MARK, 'In Transit')
  s.addLoad(ACTIVE_PLAIN, 'In Transit')
  s.addLoad(DONE_PLAIN, 'Delivered')
  ledger.writeSettings(db, { optOutDomains: [], confirmedBrokerDomains: [DRAFT_DOMAIN, SEND_DOMAIN] }, { by: LISTED.username, nowIso: new Date().toISOString() })
  s.job = jobLib.create({
    db,
    env: { AUTO_INVOICE_DRAFTS_ENABLED: 'true', AUTO_INVOICE_DRAFTS_SHADOW: 'false', ...(trigger ? {} : { AUTO_INVOICE_DRIVER_TRIGGER_ENABLED: 'false' }) },
    readJobTracking: async () => ({ headers: JOB_HEADERS, data: s.rows.map((r) => ({ ...r })) }),
    closedMonthsOf: () => [],
    dayKeyOf: (cell) => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(cell || ''))
      return m ? `${m[3]}-${m[1]}-${m[2]}` : ''
    },
    uploadsRoot: path.join(path.sep, 'made-up', 'uploads'),
    fileExists: () => true,
    engine: {
      async prepare({ loadId }) { return { ok: true, ctx: { loadId, to: BILLING } } },
      async render(ctx, opts) {
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
    appendGmailDraft: async (o) => { s.appends.push(o.to); s.gmail.add(o.messageId); return { ok: true } },
    findDraftByMessageId: async ({ messageId, alsoLike }) => {
      const found = s.gmail.has(messageId)
      return { found, count: found ? 1 : 0, mailbox: found ? '[Gmail]/Drafts' : '', ...(alsoLike ? { like: { count: 0 } } : {}) }
    },
    newMessageId: () => `<qa-factoring-${++s.ids}.auto-invoice@example.com>`,
    mailbox: () => ({ user: 'qa-mailbox@example.com', pass: 'made-up' }),
    bisonRecipient: () => '',
    logAudit: () => {},
    notify: () => {},
    geminiUnavailableAt: () => null,
    log: { warn: (m) => s.logs.push(m), error: (m) => s.logs.push(m) },
    timeZone: 'America/New_York',
    workerId: 'qa-factoring-worker',
    send: { enabled: true, domains: [SEND_DOMAIN], settleMinutes: 0 },
    sendMail: async (o) => { s.smtp.push(o.to); return { ok: true } },
    readPaymentsTable: async () => [[...PAYMENTS_HEADERS]],
    lookInMailbox: async () => ({ verdict: 'clean', mailboxes: {} }),
    sleep: async () => {},
  })
  const addJobRoute = (method) => (p, ...handlers) => { s.jobRoutes[`${method} ${p}`] = handlers }
  s.job.mount({ get: addJobRoute('GET'), put: addJobRoute('PUT'), post: addJobRoute('POST') }, { requireRole: () => (req, res, next) => next() })
  // The loads above are from before the switch: the first start-up leaves them to people.
  s.job.startTrigger()
  await s.job.finishStartUp()
  // With the trigger off, the first sweep does.
  if (!trigger) await s.job.tick()
  // The lines PUT /api/driver/status adds around its write.
  s.tap = (id) => {
    const row = s.rows.find((r) => r['Load ID'] === id)
    const start = s.job.driverDelivered({ role: 'Driver', loadId: id, oldStatus: row.Status, newStatus: 'Delivered', readBack: async () => row.Status })
    row.Status = 'Delivered'
    row['Completion Date'] = DELIVERED_ON
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
  s.routes = routesLib.create({
    db,
    env,
    logAudit: (req, action, entity, id, details) => s.audits.push({ action, id, details: String(details || ''), by: req.session.user.username }),
    logAuditRefusal: (req, action, entity, id, details, code) => s.refusals.push({ action, id, code, by: req.session.user.username }),
    readJobTracking: async () => ({ headers: JOB_HEADERS, data: s.rows.map((r) => ({ ...r })) }),
  })
  // The lines PUT /api/data/:rowIndex adds around its write.
  s.saveLoadId = (from, to) => {
    const row = s.rows.find((r) => r['Load ID'] === from)
    const save = s.routes.loadIdSave({ from, to })
    if (!save.ok) return save
    row['Load ID'] = to
    save.done()
    return save
  }
  // A person's own Draft Invoice row, as the route records it.
  s.handDraft = (id, number, stamp) => db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by, created_at) VALUES (?, ?, ?, 'ratecon', 'imap', ?, ?)").run(id, number, BILLING, LISTED.username, stamp)
  s.routes.mount({ post: (p, ...chain) => { s.mounted[p] = chain } }, {
    requireRole: (role) => (req, res, next) => (req.session.user.role === role ? next() : res.status(403).json({ code: 'FORBIDDEN' })),
    refuseCrossSite: (req, res, next) => next(),
  })
  const runChain = async (handlers, user, params, body) => {
    const out = { status: 200, body: {} }
    const res = { status(c) { out.status = c; return res }, json(b) { out.body = b; return res } }
    const req = { params, body, session: { user } }
    for (const handler of handlers || []) {
      let goOn = false
      await handler(req, res, () => { goOn = true })
      if (!goOn) break
    }
    return out
  }
  s.call = (route, user, params, body) => runChain(s.mounted[route], user, params, body)
  s.callJob = (route, user, params, body) => runChain(s.jobRoutes[route], user, params, body)
  s.marker = (id) => db.prepare('SELECT factored, source, reason, set_by, set_by_id FROM load_factoring WHERE load_key = ?').get(rules.loadKey(id)) || null
  // What the lead's scripts/factoring-mark.js does, whatever the settings say.
  s.markByScript = (id) => store.mark(db, { key: rules.loadKey(id), loadId: id, reason: 'made-up: from the list', source: 'script', actor: { id: 0, username: 'factoring-mark' }, nowIso: new Date().toISOString(), audit: () => {} })
  // A driver's Delivered, as far as the page can see: the row moves to Completed.
  s.deliver = (id) => {
    const row = s.rows.find((r) => r['Load ID'] === id)
    row.Status = 'Delivered'
    row['Completion Date'] = DELIVERED_ON
  }
  return s
}

const json200 = (body) => ({ status: 200, body })
const parse = (raw) => { try { return JSON.parse(raw || 'null') } catch { return null } }

function dashboardBody(s, user) {
  const active = s.rows.filter((r) => !rules.isCompletedStatus(r.Status)).map((r) => ({ ...r }))
  const completed = s.rows.filter((r) => rules.isCompletedStatus(r.Status)).map((r) => ({ ...r }))
  // In the server's order: the job's status, then the mark.
  s.job.annotateCompletedRows({ rows: completed, headers: JOB_HEADERS, isSuperAdmin: user.role === 'Super Admin' })
  s.routes.annotateDashboard({ session: { user } }, { headers: JOB_HEADERS, active, completed })
  return {
    timestamp: new Date().toISOString(),
    kpis: { activeLoads: active.length, unassignedLoads: 0, completedThisWeek: completed.length, completedThisMonth: completed.length, fleetUtilization: { assigned: 1, total: 1 }, revenue: { total: 0, paid: 0, pending: 0 } },
    unassignedJobs: [], jobTrackingHeaders: HEADERS, completedHeaders: HEADERS, activeJobs: active, completedJobs: completed,
    fleet: [{ Driver: DRIVER_NAME, Truck: 'QA-T1', Status: 'On Load', CompletedLoads: 1, CurrentLoad: ACTIVE_PLAIN, Phone: '(512) 555-0100', QueueCount: 0, QueuedLoadIds: [] }],
    drivers: [DRIVER_NAME], driverQueues: {},
    autoInvoice: { mode: 'on' },
  }
}

function answerGet(s, user, pathname) {
  if (pathname === '/api/auth/session') return json200({ authenticated: true, user, appTimeZone: 'America/New_York' })
  if (pathname === '/api/dashboard') return json200(dashboardBody(s, user))
  if (pathname === '/api/auto-invoice/settings') return json200({ ...ledger.readSettings(s.db), send: { domains: [SEND_DOMAIN], stopped: ledger.getSendStop(s.db) } })
  if (pathname === '/api/dispatch-notifications') return json200({ notifications: [], unreadCount: 0 })
  if (pathname === '/api/load-ratings/averages') return json200({ averages: {} })
  if (pathname === '/api/truck-assignments') return json200({ assignments: [] })
  if (pathname === '/api/config/maps-key') return json200({ key: 'qa-factoring-no-key' })
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

// The marking route and Try again through their own handlers; a Draft Invoice press through the
// route's first check, stopping where prepare() would start. Anything else the page writes is
// listed, not answered.
async function answerWrite(s, user, method, url, raw) {
  if (method !== 'POST') return null
  const body = parse(raw) || {}
  let m
  if ((m = url.pathname.match(/^\/api\/factoring\/loads\/([^/]+)$/))) {
    const loadKey = decodeURIComponent(m[1])
    s.markPosts.push({ loadKey, body, by: user.username })
    return s.call('/api/factoring/loads/:loadKey', user, { loadKey }, body)
  }
  if ((m = url.pathname.match(/^\/api\/auto-invoice\/loads\/([^/]+)\/retry$/))) {
    const loadKey = decodeURIComponent(m[1])
    s.retryPosts.push(loadKey)
    return s.callJob('POST /api/auto-invoice/loads/:loadKey/retry', user, { loadKey }, body)
  }
  if ((m = url.pathname.match(/^\/api\/loads\/([^/]+)\/draft-invoice$/))) {
    const loadId = decodeURIComponent(m[1])
    s.presses.push({ loadId, dryRun: url.searchParams.get('dryRun') === '1', by: user.username })
    const check = s.routes.draftEarly({ body, session: { user } }, loadId)
    if (!check.ok) return { status: check.http, body: check.json }
    s.reachedPrepare.push(loadId)
    return { status: 409, body: { error: 'made-up: this check stops where prepare() would start.', code: 'E2E_STOPS_HERE' } }
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
const offHost = new Set()
const offHostSockets = []
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
const DIALOG = '[role="dialog"]'

async function openPage(browser, s, user) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: 'block' })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) { offHost.add(u.host); return route.abort() }
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (!u.pathname.startsWith('/api/')) return route.continue()
    const isGet = req.method() === 'GET'
    const out = isGet ? answerGet(s, user, u.pathname) : await answerWrite(s, user, req.method(), u, req.postData())
    if (out === null) {
      if (isGet) unanswered.add(u.pathname)
      else otherWrites.push(`${req.method()} ${u.pathname}`)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({ status: out.status, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(out.body) })
  })
  const page = await ctx.newPage()
  // `dialogs.plan` holds the answers to the next browser dialogs. One with no planned answer is
  // dismissed, and `dialogs.seen` shows it, so an extra question fails its row.
  const dialogs = { seen: [], plan: [] }
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 200)))
  page.on('websocket', (ws) => {
    let host = ''
    try { host = new URL(ws.url()).host } catch { host = '(unreadable)' }
    if (host !== `${HOST}:${PORT}`) offHostSockets.push(host)
  })
  page.on('dialog', async (d) => {
    const answer = dialogs.plan.shift() || { accept: false }
    dialogs.seen.push(d.message())
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
const gone = (page, selector, ms = 5000) => page.waitForSelector(selector, { state: 'hidden', timeout: ms }).then(() => true, () => false)
async function until(check, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

async function openTab(page, name) {
  await page.locator('[role="tab"]', { hasText: name }).first().click({ timeout: 15000 })
  return true
}
// By the load's own row: each load is in one list at a time, whichever tabs stay mounted.
async function openLoad(page, id) {
  const row = page.locator('tbody tr', { hasText: id }).first()
  const listed = await row.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
  if (!listed) return false
  await row.locator('td').first().click({ timeout: 8000 })
  return appears(page, DIALOG, 8000)
}
async function closeLoad(page) {
  await page.keyboard.press('Escape')
  return gone(page, DIALOG)
}
const count = (page, selector) => page.locator(selector).count()
// The controls as the open dialog shows them.
const controlsOf = async (page) => ({
  lines: await count(page, '.fact-line'),
  text: await count(page, '.fact-text') ? await locText(page.locator('.fact-text')) : '',
  note: await count(page, '.fact-note') ? await locText(page.locator('.fact-note')) : '',
  reasonBoxes: await count(page, '.fact-reason'),
  buttons: await count(page, '.fact-btn'),
})
const showsChipOnly = (c) => c.lines === 1 && c.text === WORDS.chip && c.note === '' && c.reasonBoxes === 0 && c.buttons === 0
const showsNothing = (c) => c.lines === 0 && c.text === '' && c.note === '' && c.reasonBoxes === 0 && c.buttons === 0

// A press of the dialog's button, and the words it answers with.
async function pressDraftInvoice(page) {
  await page.locator(`${DIALOG} button`, { hasText: 'Draft Invoice Email' }).first().click({ timeout: 8000 })
  const shown = await appears(page, '.draft-result', 8000)
  return shown ? locText(page.locator('.draft-result')) : ''
}
const postFromPage = (page, url, body) => page.evaluate(async ([target, payload]) => {
  const r = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(payload) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}, [url, body])
const draftUrl = (id, dry = false) => `/api/loads/${encodeURIComponent(id)}/draft-invoice${dry ? '?dryRun=1' : ''}`
const CONFIRM = Object.freeze({ confirmFactored: true, factoredReason: 'made-up: asked for a copy' })

// The job's status as the page words it: the chip on a load's row, and the line in its dialog.
async function rowChipOf(page, id) {
  const chip = page.locator('tbody tr', { hasText: id }).first().locator('.auto-chip')
  const count = await chip.count()
  if (!count) return { count: 0, label: '', tone: '', reason: '' }
  const cls = (await chip.first().getAttribute('class')) || ''
  return { count, label: await locText(chip), tone: (/auto-chip--(\w+)/.exec(cls) || [])[1] || '', reason: (await chip.first().getAttribute('title')) || '' }
}
async function dialogLineOf(page) {
  const line = page.locator(`${DIALOG} .auto-line`).first()
  if (!(await page.locator(`${DIALOG} .auto-line`).count())) return { count: 0, text: '', tone: '', buttons: [] }
  const cls = (await line.getAttribute('class')) || ''
  return { count: 1, text: await locText(line.locator('.auto-line-text')), tone: (/auto-line--(\w+)/.exec(cls) || [])[1] || '', buttons: (await line.locator('button').allTextContents()).map((t) => t.trim()) }
}
const dialogText = (page) => locText(page.locator(DIALOG))
const chipIs = (c, want, reason) => c.count === 1 && c.label === want.label && c.tone === want.tone && c.reason === reason
const lineIs = (l, want, reason) => l.count === 1 && l.text === `${want.label}. ${reason}` && l.tone === want.tone
// The socket is aborted here, so a change on the server reaches the page by a reload.
async function reloadCompleted(page) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openTab(page, 'Completed')
}
async function markInDialog(page, dialogs, { answer = null } = {}) {
  await page.locator('.fact-reason').fill(REASON)
  if (answer) dialogs.plan.push(answer)
  await page.locator('.fact-btn', { hasText: 'Factor with Triumph' }).click({ timeout: 5000 })
  return appears(page, '.fact-result--ok', 8000)
}

// ---------------------------------------------------------------- F: a listed account
async function listedRun(browser) {
  const s = await freshServer(SETTINGS_ON)
  const { ctx, page, dialogs } = await openPage(browser, s, LISTED)
  try {
    const listed = await openTab(page, 'Active Loads')
    const opened = listed && await openLoad(page, TO_MARK)
    if (!opened) {
      record('F-open', 'Active Loads opens the load', 'the load dialog', `listed ${listed}, opened ${opened}`, false)
      return
    }
    const button = page.locator('.fact-btn', { hasText: 'Factor with Triumph' })
    const before = await controlsOf(page)
    const disabledEmpty = await button.isDisabled({ timeout: 5000 }).catch(() => false)
    await page.locator('.fact-reason').fill('   ')
    const disabledBlank = await button.isDisabled({ timeout: 5000 }).catch(() => false)
    const openFile = await shot(page, 'F-switch')
    record('F-switch', 'The switch shows with its one line, and waits for a reason', `"${WORDS.notFactored}"; the line "${WORDS.line}"; one reason box; "Factor with Triumph" disabled with no reason, or a blank one; nothing posted`,
      `text "${before.text}", line "${before.note}", reason boxes ${before.reasonBoxes}, disabled empty ${disabledEmpty}, blank ${disabledBlank}, posts ${s.markPosts.length}`,
      before.lines === 1 && before.text === WORDS.notFactored && before.note === WORDS.line && before.reasonBoxes === 1 && disabledEmpty && disabledBlank && s.markPosts.length === 0, openFile)

    await page.locator('.fact-reason').fill(REASON)
    await button.click({ timeout: 5000 })
    const posted = await until(() => s.markPosts.length === 1)
    const answered = await appears(page, '.fact-result--ok', 8000)
    const answer = answered ? await locText(page.locator('.fact-result--ok')) : ''
    const row = s.marker(TO_MARK)
    const audits = s.audits.filter((a) => a.action === 'factoring_marked')
    record('F-mark', 'A listed account marks it with a reason', `one POST with the reason; "${WORDS.marked}"; one row by this account; one factoring_marked audit row with the reason; no browser dialog`,
      `posts ${s.markPosts.length}, reason sent "${posted ? s.markPosts[0].body.reason : ''}", answer "${answer}", row ${JSON.stringify(row)}, audits ${JSON.stringify(audits)}, dialogs ${dialogs.seen.length}`,
      posted && s.markPosts.length === 1 && s.markPosts[0].body.factored === true && s.markPosts[0].body.reason === REASON && answer === WORDS.marked
        && !!row && row.factored === 1 && row.source === 'person' && row.reason === REASON && row.set_by === LISTED.username && row.set_by_id === LISTED.id
        && audits.length === 1 && audits[0].by === LISTED.username && audits[0].details.includes(REASON) && dialogs.seen.length === 0)

    const after = await controlsOf(page)
    const clearShown = await count(page, '.fact-btn:has-text("Clear factored")')
    const chipFile = await shot(page, 'F-chip')
    record('F-chip', 'The chip shows, with the line', `"${WORDS.chip}" with the line "${WORDS.line}"; the switch now reads "Clear factored"`,
      `text "${after.text}", line "${after.note}", Clear factored ${clearShown}`, after.text === WORDS.chip && after.note === WORDS.line && clearShown === 1, chipFile)

    await closeLoad(page)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const relisted = await openTab(page, 'Active Loads')
    const reopened = relisted && await openLoad(page, TO_MARK)
    const reread = reopened ? await controlsOf(page) : {}
    record('F-reload', 'The same on the server\'s own answer, after a reload', 'the chip and the line', `opened ${reopened}, text "${reread.text}", line "${reread.note}"`, reopened && reread.text === WORDS.chip && reread.note === WORDS.line)
    if (reopened) await closeLoad(page)

    s.deliver(TO_MARK)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const completed = await openTab(page, 'Completed')
    const openedDone = completed && await openLoad(page, TO_MARK)
    if (!openedDone) {
      record('F-completed', 'Completed Loads opens the marked load', 'the load dialog', `listed ${completed}, opened ${openedDone}`, false)
      return
    }
    const done = await controlsOf(page)
    const words = await pressDraftInvoice(page)
    const pressFile = await shot(page, 'F-refused')
    record('F-refused', 'The Draft Invoice button refuses the marked load', `the chip; one dry-run press; the words "${WORDS.refused}"; nothing reaches prepare()`,
      `text "${done.text}", presses ${JSON.stringify(s.presses)}, words "${words}", reached prepare ${JSON.stringify(s.reachedPrepare)}`,
      done.text === WORDS.chip && s.presses.length === 1 && s.presses[0].dryRun === true && words === WORDS.refused && s.reachedPrepare.length === 0, pressFile)

    const confirmed = await postFromPage(page, draftUrl(TO_MARK), CONFIRM)
    record('F-confirm', 'A listed account\'s confirmation is refused', `409 NOA_UNCONFIGURED, "${WORDS.noa}"; nothing reaches prepare()`,
      `${confirmed.status} ${confirmed.body.code}, "${confirmed.body.error}", reached prepare ${JSON.stringify(s.reachedPrepare)}`,
      confirmed.status === 409 && confirmed.body.code === 'NOA_UNCONFIGURED' && confirmed.body.error === WORDS.noa && s.reachedPrepare.length === 0)

    const plain = await postFromPage(page, draftUrl(DONE_PLAIN, true), {})
    record('F-plain', 'A load that isn\'t factored passes the check', `it reaches prepare(): ${DONE_PLAIN}, and only that load`, `${plain.status} ${plain.body.code}, reached prepare ${JSON.stringify(s.reachedPrepare)}`,
      plain.body.code === 'E2E_STOPS_HERE' && s.reachedPrepare.length === 1 && s.reachedPrepare[0] === DONE_PLAIN)
  } finally {
    await ctx.close()
    s.db.close()
  }
}

// ---------------------------------------------------------------- N: a Super Admin not listed
async function notListedRun(browser) {
  const s = await freshServer(SETTINGS_ON)
  s.deliver(TO_MARK)
  const premark = s.markByScript(TO_MARK)
  const { ctx, page } = await openPage(browser, s, NOT_LISTED)
  try {
    const completed = await openTab(page, 'Completed')
    const opened = completed && await openLoad(page, TO_MARK)
    if (!opened) {
      record('N-open', 'Completed Loads opens the marked load', 'the load dialog', `mark ${JSON.stringify(premark)}, listed ${completed}, opened ${opened}`, false)
      return
    }
    const marked = await controlsOf(page)
    const words = await pressDraftInvoice(page)
    const chipFile = await shot(page, 'N-chip-only')
    record('N-chip', 'A Super Admin not listed sees the chip only', `"${WORDS.chip}"; no line, no reason box, no button`, JSON.stringify(marked), showsChipOnly(marked), chipFile)
    record('N-refused', 'The Draft Invoice button refuses them too', `"${WORDS.refused}"; nothing reaches prepare()`, `words "${words}", reached prepare ${JSON.stringify(s.reachedPrepare)}`, words === WORDS.refused && s.reachedPrepare.length === 0)

    const confirmed = await postFromPage(page, draftUrl(TO_MARK), CONFIRM)
    record('N-confirm', 'Their confirmation gets the same answer as a listed account\'s', '409 NOA_UNCONFIGURED; nothing reaches prepare()',
      `${confirmed.status} ${confirmed.body.code}, reached prepare ${JSON.stringify(s.reachedPrepare)}`, confirmed.status === 409 && confirmed.body.code === 'NOA_UNCONFIGURED' && s.reachedPrepare.length === 0)
    await closeLoad(page)

    const active = await openTab(page, 'Active Loads')
    const openedPlain = active && await openLoad(page, ACTIVE_PLAIN)
    const plain = openedPlain ? await controlsOf(page) : {}
    const plainFile = await shot(page, 'N-no-switch')
    record('N-no-switch', 'A load with no mark: no switch at all', 'no chip, no line, no reason box, no button', `opened ${openedPlain}, ${JSON.stringify(plain)}`, openedPlain && showsNothing(plain), plainFile)

    const tried = await postFromPage(page, `/api/factoring/loads/${encodeURIComponent(rules.loadKey(ACTIVE_PLAIN))}`, { factored: true, reason: REASON })
    record('N-post', 'Marking by hand is refused', `403 FACTORING_NOT_LISTED, "${WORDS.notListed}"; no row`, `${tried.status} ${tried.body.code}, "${tried.body.error}", row ${JSON.stringify(s.marker(ACTIVE_PLAIN))}`,
      tried.status === 403 && tried.body.code === 'FACTORING_NOT_LISTED' && tried.body.error === WORDS.notListed && s.marker(ACTIVE_PLAIN) === null)
  } finally {
    await ctx.close()
    s.db.close()
  }
}

// ---------------------------------------------------------------- O: as production ships
async function settingsUnsetRun(browser) {
  const s = await freshServer(SETTINGS_UNSET)
  s.deliver(TO_MARK)
  const premark = s.markByScript(TO_MARK)
  const { ctx, page } = await openPage(browser, s, LISTED)
  try {
    const active = await openTab(page, 'Active Loads')
    const openedPlain = active && await openLoad(page, ACTIVE_PLAIN)
    const plain = openedPlain ? await controlsOf(page) : {}
    record('O-no-switch', 'Both settings unset: no switch, for the account that would be listed', 'no chip, no line, no reason box, no button', `opened ${openedPlain}, ${JSON.stringify(plain)}`, openedPlain && showsNothing(plain))
    const tried = await postFromPage(page, `/api/factoring/loads/${encodeURIComponent(rules.loadKey(ACTIVE_PLAIN))}`, { factored: true, reason: REASON })
    record('O-post', 'The marking route is off', '404 FEATURE_OFF; no row', `${tried.status} ${tried.body.code}, row ${JSON.stringify(s.marker(ACTIVE_PLAIN))}`, tried.status === 404 && tried.body.code === 'FEATURE_OFF' && s.marker(ACTIVE_PLAIN) === null)
    if (openedPlain) await closeLoad(page)

    const completed = await openTab(page, 'Completed')
    const opened = completed && await openLoad(page, TO_MARK)
    if (!opened) {
      record('O-open', 'Completed Loads opens the load the script marked', 'the load dialog', `mark ${JSON.stringify(premark)}, listed ${completed}, opened ${opened}`, false)
      return
    }
    const marked = await controlsOf(page)
    const words = await pressDraftInvoice(page)
    const file = await shot(page, 'O-script-marked')
    record('O-marked', 'A load the lead\'s script marked: the chip only, and refused all the same', `"${WORDS.chip}"; no line, no reason box, no button; "${WORDS.refused}"; nothing reaches prepare()`,
      `${JSON.stringify(marked)}, words "${words}", reached prepare ${JSON.stringify(s.reachedPrepare)}`, showsChipOnly(marked) && words === WORDS.refused && s.reachedPrepare.length === 0, file)
  } finally {
    await ctx.close()
    s.db.close()
  }
}

// ---------------------------------------------------------------- D: a job's draft, then marked
async function draftRun(browser) {
  const ID = 'QA-FACT-9101'
  const s = await freshServer(SETTINGS_ON)
  s.addLoad(ID, 'At Receiver')
  s.tap(ID)
  const drafted = await until(() => (s.claim(ID) || {}).state === 'drafted')
  const number = (s.claim(ID) || {}).invoice_id || ''
  const { ctx, page, dialogs } = await openPage(browser, s, LISTED)
  try {
    await openTab(page, 'Completed')
    const opened = await openLoad(page, ID)
    if (!opened) {
      record('D-open', 'Completed Loads opens the job\'s draft', 'the load dialog', `drafted ${drafted}, opened ${opened}`, false)
      return
    }
    const beforeChip = await rowChipOf(page, ID)
    const beforeLine = await dialogLineOf(page)
    const beforeReason = WORDS.draftReady.reason(number)
    record('D-before', 'Before any mark, a job\'s draft says to check it and send it', `row and dialog "${WORDS.draftReady.label}": "${beforeReason}"; one append, no SMTP`,
      `row ${JSON.stringify(beforeChip)}, dialog ${JSON.stringify(beforeLine)}, appends ${s.appends.length}, SMTP ${s.smtp.length}`,
      drafted && chipIs(beforeChip, WORDS.draftReady, beforeReason) && lineIs(beforeLine, WORDS.draftReady, beforeReason) && s.appends.length === 1 && s.smtp.length === 0)

    // A draft exists, so the switch asks once before marking.
    const marked = await markInDialog(page, dialogs, { answer: { accept: true } })
    const answer = marked ? await locText(page.locator('.fact-result--ok')) : ''
    const factText = await locText(page.locator('.fact-text'))
    const want = WORDS.dontSend.reason(`invoice ${number}`)
    const line = await dialogLineOf(page)
    const inDialog = await dialogText(page)
    const lineFile = await shot(page, 'D-dialog')
    record('D-dialog', 'Marked: the dialog says not to send it and to delete it', `one question; "${WORDS.markedAsked}"; "${WORDS.chipOut}"; the line "${WORDS.dontSend.label}. ${want}", red; "${WORDS.oldSend}" nowhere in the dialog`,
      `marked ${marked}, questions ${dialogs.seen.length}, answer "${answer}", text "${factText}", line ${JSON.stringify(line)}, old words shown ${inDialog.includes(WORDS.oldSend)}`,
      marked && dialogs.seen.length === 1 && answer === WORDS.markedAsked && factText === WORDS.chipOut && lineIs(line, WORDS.dontSend, want) && !inDialog.includes(WORDS.oldSend), lineFile)
    await closeLoad(page)

    await reloadCompleted(page)
    const reopened = await openLoad(page, ID)
    const chip = await rowChipOf(page, ID)
    const again = reopened ? await dialogLineOf(page) : {}
    const chipFile = await shot(page, 'D-row')
    record('D-row', 'On the server\'s own answer, after a reload: the row chip and the dialog', `row chip "${WORDS.dontSend.label}", red, its title the sentence; the dialog the same`,
      `row ${JSON.stringify(chip)}, dialog ${JSON.stringify(again)}`, chipIs(chip, WORDS.dontSend, want) && lineIs(again, WORDS.dontSend, want), chipFile)
  } finally {
    await ctx.close()
  }
  // Any Super Admin reads it: `_factoring` is on a marked row for all of them.
  const other = await openPage(browser, s, NOT_LISTED)
  try {
    await openTab(other.page, 'Completed')
    const opened = await openLoad(other.page, ID)
    const chip = await rowChipOf(other.page, ID)
    const line = opened ? await dialogLineOf(other.page) : {}
    const want = WORDS.dontSend.reason(`invoice ${number}`)
    record('D-not-listed', 'A Super Admin not listed reads the same', `row chip and dialog "${WORDS.dontSend.label}"`, `row ${JSON.stringify(chip)}, dialog ${JSON.stringify(line)}`,
      chipIs(chip, WORDS.dontSend, want) && lineIs(line, WORDS.dontSend, want))
  } finally {
    await other.ctx.close()
    s.db.close()
  }
}

// ---------------------------------------------------------------- D2: a job's draft, marked, cleared
async function clearedDraftRun(browser) {
  const ID = 'QA-FACT-9102'
  const OLDER = 'QA-FACT-9103'
  const s = await freshServer(SETTINGS_ON)
  for (const id of [ID, OLDER]) s.addLoad(id, 'At Receiver')
  s.tap(ID)
  s.tap(OLDER)
  const drafted = await until(() => (s.claim(ID) || {}).state === 'drafted' && (s.claim(OLDER) || {}).state === 'drafted')
  const first = await s.call('/api/factoring/loads/:loadKey', LISTED, { loadKey: rules.loadKey(ID) }, { factored: true, reason: REASON, loadId: ID, confirmNotSent: true })
  // A person's draft too, from before the mark: confirmed not sent and told to be deleted, like the job's.
  s.handDraft(OLDER, `${TM}${TD}${TY}-9103`, new Date(Date.now() - 60000).toISOString())
  await s.call('/api/factoring/loads/:loadKey', LISTED, { loadKey: rules.loadKey(OLDER) }, { factored: true, reason: REASON, loadId: OLDER, confirmNotSent: true })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await s.call('/api/factoring/loads/:loadKey', LISTED, { loadKey: rules.loadKey(OLDER) }, { factored: false, reason: REASON, loadId: OLDER })
  const { ctx, page } = await openPage(browser, s, LISTED)
  try {
    await openTab(page, 'Completed')
    const opened = await openLoad(page, ID)
    if (!opened) {
      record('D2-open', 'Completed Loads opens the marked draft', 'the load dialog', `drafted ${drafted}, marked ${first.status}, opened ${opened}`, false)
      return
    }
    await page.locator('.fact-reason').fill(REASON)
    await page.locator('.fact-btn', { hasText: 'Clear factored' }).click({ timeout: 5000 })
    const shown = await appears(page, '.fact-result--ok', 8000)
    await closeLoad(page)
    await reloadCompleted(page)
    const reopened = await openLoad(page, ID)
    const chip = await rowChipOf(page, ID)
    const line = reopened ? await dialogLineOf(page) : {}
    const inDialog = reopened ? await dialogText(page) : ''
    const file = await shot(page, 'D2-cleared')
    record('D2-cleared', 'Cleared: no green "Draft ready", and a chip of its own', `row chip and dialog "${WORDS.clearedDraft.label}", amber: "${WORDS.clearedDraft.reason}"; no button on the line; "${WORDS.draftReady.label}" nowhere; the claim stays drafted`,
      `cleared ${shown}, row ${JSON.stringify(chip)}, dialog ${JSON.stringify(line)}, old label shown ${inDialog.includes(WORDS.draftReady.label)}, claim ${(s.claim(ID) || {}).state}`,
      shown && chipIs(chip, WORDS.clearedDraft, WORDS.clearedDraft.reason) && lineIs(line, WORDS.clearedDraft, WORDS.clearedDraft.reason) && line.buttons.length === 0 && !inDialog.includes(WORDS.draftReady.label) && (s.claim(ID) || {}).state === 'drafted', file)
    if (reopened) await closeLoad(page)

    const olderChip = await rowChipOf(page, OLDER)
    record('D2-older', 'A person\'s draft from before the clear leaves the chip', `row chip "${WORDS.clearedDraft.label}"`, `row ${JSON.stringify(olderChip)}`, chipIs(olderChip, WORDS.clearedDraft, WORDS.clearedDraft.reason))

    // Stamped ahead of the clock: a draft row's stamp is to the second, and the clear's to the millisecond.
    s.handDraft(ID, `${TM}${TD}${TY}-9102`, new Date(Date.now() + 2000).toISOString())
    await reloadCompleted(page)
    const again = await openLoad(page, ID)
    const handChip = await rowChipOf(page, ID)
    const handLine = again ? await dialogLineOf(page) : {}
    record('D2-hand', 'A person\'s own draft since the clear: no chip keeps the old number', 'no row chip, no dialog line', `row ${JSON.stringify(handChip)}, dialog ${JSON.stringify(handLine)}`, again && handChip.count === 0 && handLine.count === 0)
  } finally {
    await ctx.close()
    s.db.close()
  }
}

// ---------------------------------------------------------------- T: may be in Gmail, then Try again
async function tryAgainRun(browser) {
  for (const [n, code, stage] of [[9201, 'MAYBE_IN_GMAIL', 'appending'], [9202, 'IN_GMAIL_UNRECORDED', 'appended']]) {
    const ID = `QA-FACT-${n}`
    const tag = `T-${code}`
    const number = `${TM}${TD}${TY}-${n}`
    const messageId = `<qa-factoring-${n}.auto-invoice@example.com>`
    const s = await freshServer(SETTINGS_ON)
    s.addLoad(ID, 'Delivered')
    s.gmail.add(messageId)
    s.seedClaim(ID, { state: 'needs_attention', reason_code: code, stage, delivery: '', invoice_id: number, invoice_date: TODAY, reserved_at: new Date().toISOString(), message_id: messageId,
      sent_json: JSON.stringify({ to: BILLING, subject: `Example Freight Order #${ID}`, total: '$1,234.00' }) })
    const { ctx, page, dialogs } = await openPage(browser, s, LISTED)
    try {
      await openTab(page, 'Completed')
      const opened = await openLoad(page, ID)
      if (!opened) {
        record(`${tag}-open`, 'Completed Loads opens the load', 'the load dialog', `opened ${opened}`, false)
        continue
      }
      // It may already have been sent from Gmail, so the mark asks first.
      await page.locator('.fact-reason').fill(REASON)
      dialogs.plan.push({ accept: false })
      await page.locator('.fact-btn', { hasText: 'Factor with Triumph' }).click({ timeout: 5000 })
      const refusedShown = await appears(page, '.fact-result--error', 8000)
      const refusedWords = refusedShown ? await locText(page.locator('.fact-result--error')) : ''
      record(`${tag}-asked`, `${code}: the mark asks first, and a no leaves the load unmarked`, `one question, "${WORDS.askMaybe}"; "${WORDS.refusedMaybe}"; no row`,
        `questions ${JSON.stringify(dialogs.seen)}, answer "${refusedWords}", row ${JSON.stringify(s.marker(ID))}`,
        dialogs.seen.length === 1 && dialogs.seen[0] === WORDS.askMaybe && refusedWords === WORDS.refusedMaybe && s.marker(ID) === null)

      const marked = await markInDialog(page, dialogs, { answer: { accept: true } })
      const answer = marked ? await locText(page.locator('.fact-result--ok')) : ''
      const factText = await locText(page.locator('.fact-text'))
      const shownFirst = WORDS.dontSend.reason('the invoice draft')
      const line = await dialogLineOf(page)
      const press = await postFromPage(page, draftUrl(ID, true), {})
      const lineFile = await shot(page, `${tag}-marked`)
      record(`${tag}-marked`, `${code}, a yes marks it: the dialog says not to send it, and nothing says it goes through Triumph`, `a second question, the same; "${WORDS.markedAsked}"; "${WORDS.chipOut}"; the line opens "${WORDS.dontSend.label}. ${shownFirst}"; Try again still offered; a press answers "${WORDS.refusedOut}"`,
        `marked ${marked}, questions ${dialogs.seen.length}, answer "${answer}", text "${factText}", line "${line.text}", buttons ${JSON.stringify(line.buttons)}, press ${press.status} "${press.body.error}"`,
        marked && dialogs.seen.length === 2 && dialogs.seen[1] === WORDS.askMaybe && answer === WORDS.markedAsked && factText === WORDS.chipOut && line.tone === WORDS.dontSend.tone && line.text.startsWith(`${WORDS.dontSend.label}. ${shownFirst}`) && line.buttons.includes('Try again')
          && press.status === 409 && press.body.error === WORDS.refusedOut, lineFile)

      dialogs.plan.push({ accept: true })
      await page.locator(`${DIALOG} .auto-line button`, { hasText: 'Try again' }).click({ timeout: 5000 })
      const recorded = await until(() => (s.claim(ID) || {}).state === 'drafted')
      await closeLoad(page)
      await reloadCompleted(page)
      const reopened = await openLoad(page, ID)
      const chip = await rowChipOf(page, ID)
      const after = reopened ? await dialogLineOf(page) : {}
      const inDialog = reopened ? await dialogText(page) : ''
      const want = WORDS.dontSend.reason(`invoice ${number}`)
      const afterFile = await shot(page, `${tag}-recorded`)
      record(`${tag}-recorded`, `${code}: Try again records the draft, and the row still says not to send it`, `one POST after "${WORDS.retrySearch}"; drafted; row chip and dialog "${WORDS.dontSend.label}"; "${WORDS.oldSend}" nowhere; no SMTP, no append`,
        `posts ${s.retryPosts.length}, question "${dialogs.seen[dialogs.seen.length - 1] || ''}", recorded ${recorded}, row ${JSON.stringify(chip)}, dialog ${JSON.stringify(after)}, old words shown ${inDialog.includes(WORDS.oldSend)}, SMTP ${s.smtp.length}, appends ${s.appends.length}`,
        s.retryPosts.length === 1 && dialogs.seen[dialogs.seen.length - 1] === WORDS.retrySearch && recorded && chipIs(chip, WORDS.dontSend, want) && lineIs(after, WORDS.dontSend, want)
          && !inDialog.includes(WORDS.oldSend) && s.smtp.length === 0 && s.appends.length === 0, afterFile)
    } finally {
      await ctx.close()
      s.db.close()
    }
  }
}

// ---------------------------------------------------------------- C: marked, tapped, cleared
async function clearedRun(browser) {
  const ID = 'QA-FACT-9301'
  const s = await freshServer(SETTINGS_ON)
  s.addLoad(ID, 'At Receiver')
  await s.call('/api/factoring/loads/:loadKey', LISTED, { loadKey: rules.loadKey(ID) }, { factored: true, reason: REASON, loadId: ID })
  s.tap(ID)
  const stopped = await until(() => { const c = s.claim(ID); return Boolean(c && c.state === 'skipped' && c.reason_code === 'LOAD_FACTORED') })
  const { ctx, page, dialogs } = await openPage(browser, s, LISTED)
  try {
    await openTab(page, 'Completed')
    const opened = await openLoad(page, ID)
    if (!opened) {
      record('C-open', 'Completed Loads opens the marked load', 'the load dialog', `stopped ${stopped}, opened ${opened}`, false)
      return
    }
    const whileMarked = await rowChipOf(page, ID)
    record('C-marked', 'Marked and tapped: the run stops on the mark, and the row has no job chip', 'skipped LOAD_FACTORED; no chip; no draft, send or number',
      `stopped ${stopped}, chips ${whileMarked.count}, appends ${s.appends.length}, SMTP ${s.smtp.length}, number "${(s.claim(ID) || {}).invoice_id || ''}"`,
      stopped && whileMarked.count === 0 && s.appends.length === 0 && s.smtp.length === 0 && !(s.claim(ID) || {}).invoice_id)

    await page.locator('.fact-reason').fill(REASON)
    await page.locator('.fact-btn', { hasText: 'Clear factored' }).click({ timeout: 5000 })
    const shown = await appears(page, '.fact-result--ok', 8000)
    const answer = shown ? await locText(page.locator('.fact-result--ok')) : ''
    await closeLoad(page)
    await reloadCompleted(page)
    const reopened = await openLoad(page, ID)
    const chip = await rowChipOf(page, ID)
    const line = reopened ? await dialogLineOf(page) : {}
    const file = await shot(page, 'C-cleared')
    record('C-cleared', 'Cleared: a chip of its own, with nothing to retry', `"${WORDS.clearedDone}"; row chip "${WORDS.cleared.label}", amber, its title "${WORDS.cleared.reason}"; the dialog the same, with no button on its line`,
      `answer "${answer}", row ${JSON.stringify(chip)}, dialog ${JSON.stringify(line)}`,
      answer === WORDS.clearedDone && chipIs(chip, WORDS.cleared, WORDS.cleared.reason) && lineIs(line, WORDS.cleared, WORDS.cleared.reason) && line.buttons.length === 0, file)
    await pressDraftInvoice(page)
    const claim = s.claim(ID) || {}
    record('C-by-hand', 'No automatic send comes back, and a person can draft it', `the press passes the check and reaches prepare(), this load only; the claim stays skipped LOAD_FACTORED; no append, no SMTP, no number; no browser question`,
      `reached prepare ${JSON.stringify(s.reachedPrepare)}, claim ${claim.state} ${claim.reason_code}, appends ${s.appends.length}, SMTP ${s.smtp.length}, number "${claim.invoice_id || ''}", questions ${dialogs.seen.length}`,
      s.reachedPrepare.length === 1 && s.reachedPrepare[0] === ID && claim.state === 'skipped' && claim.reason_code === 'LOAD_FACTORED' && s.appends.length === 0 && s.smtp.length === 0 && !claim.invoice_id && dialogs.seen.length === 0)
  } finally {
    await ctx.close()
    s.db.close()
  }
}

// ---------------------------------------------------------------- C2: the same, the sweep's way
async function clearedSweepRun(browser) {
  const ID = 'QA-FACT-9302'
  const s = await freshServer(SETTINGS_ON, { trigger: false })
  s.addLoad(ID, 'Delivered')
  await s.call('/api/factoring/loads/:loadKey', LISTED, { loadKey: rules.loadKey(ID) }, { factored: true, reason: REASON, loadId: ID })
  await s.job.tick()
  const before = s.claim(ID) || {}
  const stopped = before.state === 'skipped' && before.reason_code === 'LOAD_FACTORED'
  await s.call('/api/factoring/loads/:loadKey', LISTED, { loadKey: rules.loadKey(ID) }, { factored: false, reason: REASON, loadId: ID })
  await s.job.tick()
  const { ctx, page } = await openPage(browser, s, LISTED)
  try {
    await openTab(page, 'Completed')
    const opened = await openLoad(page, ID)
    const chip = await rowChipOf(page, ID)
    const line = opened ? await dialogLineOf(page) : {}
    const claim = s.claim(ID) || {}
    const file = await shot(page, 'C2-sweep')
    record('C2-sweep', 'The driver\'s trigger off: the same chip, and the claim stays closed', `the sweep skips it while marked; row chip and dialog "${WORDS.cleared.label}", with no button on the line; another sweep changes nothing; no append, no SMTP`,
      `stopped ${stopped}, row ${JSON.stringify(chip)}, dialog ${JSON.stringify(line)}, claim ${claim.state} ${claim.reason_code}, appends ${s.appends.length}, SMTP ${s.smtp.length}`,
      stopped && chipIs(chip, WORDS.cleared, WORDS.cleared.reason) && lineIs(line, WORDS.cleared, WORDS.cleared.reason) && line.buttons.length === 0 && claim.state === 'skipped' && claim.reason_code === 'LOAD_FACTORED' && s.appends.length === 0 && s.smtp.length === 0, file)
  } finally {
    await ctx.close()
    s.db.close()
  }
}

// ---------------------------------------------------------------- M: a marked load's Load ID
async function markedIdRun(browser) {
  const OLD = 'QA-FACT-9401'
  const NEW = 'QA-FACT-9402'
  const OPEN_OLD = 'QA-FACT-9403'
  const OPEN_NEW = 'QA-FACT-9404'
  const s = await freshServer(SETTINGS_ON)
  for (const id of [OLD, OPEN_OLD]) s.addLoad(id, 'In Transit')
  const press = (id, factored) => s.call('/api/factoring/loads/:loadKey', LISTED, { loadKey: rules.loadKey(id) }, { factored, reason: REASON, loadId: id })
  await press(OLD, true)

  // While marked, a new ID and a respelling the mark's key reads as the same load both refuse.
  const refused = s.saveLoadId(OLD, NEW)
  const respelled = s.saveLoadId(OLD, `#${OLD}`)
  const kept = s.rows.some((r) => r['Load ID'] === OLD)
  record('M-refused', 'A marked load\'s Load ID can\'t change, a respelling included', `each 409 LOAD_ID_FACTORED, "${WORDS.idRefused}"; the row and the mark as they were; no row on the new ID`,
    `${refused.http} ${refused.code}, "${(refused.json || {}).error}"; respelled ${respelled.http} ${respelled.code}; row ${kept ? 'kept' : 'changed'}, mark ${JSON.stringify(s.marker(OLD))}, new ${JSON.stringify(s.marker(NEW))}`,
    refused.http === 409 && refused.code === 'LOAD_ID_FACTORED' && (refused.json || {}).error === WORDS.idRefused && respelled.http === 409 && respelled.code === 'LOAD_ID_FACTORED' && kept && (s.marker(OLD) || {}).factored === 1 && s.marker(NEW) === null)

  const cleared = await press(OLD, false)
  const saved = s.saveLoadId(OLD, NEW)
  const again = await press(NEW, true)
  record('M-way', 'The way through: clear the mark, change the ID, mark again', 'each step goes through; the new ID marked; the old row reads cleared',
    `cleared ${cleared.status}, saved ${saved.ok}, marked ${again.status}, new ${JSON.stringify(s.marker(NEW))}, old ${JSON.stringify(s.marker(OLD))}`,
    cleared.status === 200 && saved.ok === true && again.status === 200 && (s.marker(NEW) || {}).factored === 1 && (s.marker(OLD) || {}).factored === 0)

  const { ctx, page } = await openPage(browser, s, LISTED)
  try {
    await openTab(page, 'Active Loads')
    const opened = await openLoad(page, NEW)
    const shows = opened ? await controlsOf(page) : {}
    const file = await shot(page, 'M-new-id')
    record('M-chip', 'The new ID shows the chip', `"${WORDS.chip}"`, `opened ${opened}, text "${shows.text}"`, opened && shows.text === WORDS.chip, file)
    if (opened) await closeLoad(page)

    // A dialog left open while the ID changes elsewhere.
    const openedOld = await openLoad(page, OPEN_OLD)
    if (!openedOld) {
      record('M-stale', 'A dialog left open on the old ID', 'the load dialog', `opened ${openedOld}`, false)
    } else {
      s.saveLoadId(OPEN_OLD, OPEN_NEW)
      await page.locator('.fact-reason').fill(REASON)
      await page.locator('.fact-btn', { hasText: 'Factor with Triumph' }).click({ timeout: 5000 })
      const shown = await appears(page, '.fact-result--error', 8000)
      const words = shown ? await locText(page.locator('.fact-result--error')) : ''
      const staleFile = await shot(page, 'M-stale')
      record('M-stale', 'A dialog left open on the old ID can\'t mark that key', `"${WORDS.notOnSheet}"; no row on either ID`,
        `answer "${words}", old ${JSON.stringify(s.marker(OPEN_OLD))}, new ${JSON.stringify(s.marker(OPEN_NEW))}`, words === WORDS.notOnSheet && s.marker(OPEN_OLD) === null && s.marker(OPEN_NEW) === null, staleFile)
    }
  } finally {
    await ctx.close()
  }

  s.tap(NEW)
  const stopped = await until(() => { const c = s.claim(NEW); return Boolean(c && c.state === 'skipped' && c.reason_code === 'LOAD_FACTORED') })
  record('M-tap', 'The tap on the new ID stops on the mark', 'skipped LOAD_FACTORED; no append, no SMTP', `stopped ${stopped}, appends ${s.appends.length}, SMTP ${s.smtp.length}`, stopped && s.appends.length === 0 && s.smtp.length === 0)
  s.db.close()
}

// ---------------------------------------------------------------- G: nothing left this machine
function wireStep() {
  const hosts = [...offHost].sort()
  const mailHosts = hosts.filter((h) => /mail|imap|smtp/i.test(h))
  record('G', 'Nothing left this machine', 'no TLS connection, no socket to another host or a mail port; no browser socket off this machine and no mail host asked (any other host it asked was aborted, and is only reported)',
    `TLS ${wire.tls.length}, remote ${wire.remote.length}, mail ports ${wire.mailPorts.length}, browser sockets off this machine ${offHostSockets.length}, hosts aborted ${hosts.join(',') || 'none'}`,
    wire.tls.length === 0 && wire.remote.length === 0 && wire.mailPorts.length === 0 && offHostSockets.length === 0 && mailHosts.length === 0)
}

async function main() {
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ASKED_PORT, HOST, resolve) })
  PORT = server.address().port
  if (PORT === 3000 || PORT === 5173) { server.close(); die(`the system picked port ${PORT}: set E2E_PORT to a free one`) }
  BASE = `http://${HOST}:${PORT}`
  console.log(`factoring-mark-usable: serving ${DIST} on ${BASE} (made-up data; no server.js, no mailbox)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const [name, run] of [['F', listedRun], ['N', notListedRun], ['O', settingsUnsetRun], ['D', draftRun], ['D2', clearedDraftRun], ['T', tryAgainRun], ['C', clearedRun], ['C2', clearedSweepRun], ['M', markedIdRun]]) {
      try {
        await run(browser)
      } catch (e) {
        record(name, 'The part ran to its end', 'no error', String(e && e.message).slice(0, 300), false)
      }
    }
  } finally {
    await browser.close()
    server.close()
  }
  wireStep()

  const resultsFile = path.join(paths.workDir(), 'results-factoring-mark-usable.md')
  const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    '# The factored mark: what a Super Admin sees', '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Other writes sent by the page (not part of the verdict): ${otherWrites.length ? otherWrites.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, out, { mode: 0o600 })
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`factoring-mark-usable: ${passed}/${rows.length} PASS, ${rows.length - passed} FAIL; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  if (pageErrors.length) console.log(`factoring-mark-usable: page errors: ${pageErrors.join(' | ')}`)
  process.exit(passed === rows.length ? 0 : 1)
}

main().catch((e) => {
  console.error(`factoring-mark-usable: aborted: ${e.stack || e}`)
  process.exit(1)
})
