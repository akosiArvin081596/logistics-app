#!/usr/bin/env node
// LogisX: one invoice status on each completed load, as a Super Admin sees it on Completed Loads,
// on made-up data only.
//
// What the page shows comes from the server's own modules: lib/auto-invoice-job.js and
// lib/invoice-evidence.js run in this process on an in-memory database, with a made-up sheet,
// engine, mailbox and SMTP sender. `_autoInvoice` and `_invoiceStatus` are their
// annotateCompletedRows(), in server.js's order, and Try again and Mark checked are the job's own
// routes. A saved mailbox answer is written by the module's saveAnswer(), never by a search: nothing
// here reads a mailbox. Steps, each at 1280x800 and 390x844:
//   E   every status the mailbox pass off can give: the row's chip (words, tone, title) and the load
//       dialog's one line. An office-marked load reads "No automatic invoice", even with a clean
//       answer saved; "No invoice found" appears nowhere
//   F   the filter: the eight words with their counts, each choice lists that status's rows, a choice
//       goes back to page 1, the counts follow the search, Clear, the note about the file, the
//       Needs attention toggle's title and its different number; the download asks for no status
//       and its file carries the three columns (the export route itself: test-invoice-evidence.js)
//   A   the dialog's buttons: Try again takes the line to the job's words, then the row to Sent by
//       LogisX; Mark checked takes the mark off; `retry: "none"` offers no Try again; the load being
//       built moves on once its build ends
//   P   the mailbox pass on: "No invoice found" only from the search's own answer; an office-marked
//       load not reached yet keeps "No automatic invoice"; "in neither" reads Needs attention
//   K   the kill switch: no status on the rows, today's chips, no select, today's note and title
//   D   a Dispatcher sees none of it, even if a row came with the fields
//   G   no TLS connection, no socket to another host or a mail port from this process; the browser
//       opened no socket off this machine and asked no mail host
//
// Like driver-delivered-invoice.mjs this boots no server.js, reads no settings file or key and signs
// nobody in. It serves the checkout's built client/dist on 127.0.0.1 (E2E_PORT, or a free port the
// system picks) and answers every /api request in the browser. Every request to another host is
// aborted, the socket included, so the page reads a change on a reload.
//
//   npm --prefix scripts/e2e ci     (once; playwright-core)
//   npm --prefix client run build   (the build under test)
//   node scripts/e2e/invoice-status.mjs
//   node scripts/e2e/invoice-status.mjs --world   (no browser and no build: each world's rows, through
//                                                  the client's own words, against the words below)
//
// Env: E2E_PORT (3000 and 5173 are refused, and so is a port in use), HEADED=1, CHROME_PATH, E2E_WORK_DIR.
// Output: PASS/FAIL lines, a final count, <work dir>/results-invoice-status.md and screenshots in
// ~/LogisX-replica/screens/invoice-status/. Exit 0 only when every row PASSes.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import paths from './paths.cjs'

const WORLD_ONLY = process.argv.includes('--world')
const HOST = '127.0.0.1'
const ASKED_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 0
let PORT = ASKED_PORT
let BASE = ''
const HEADED = process.env.HEADED === '1'
const DIST = path.join(paths.REPO, 'client', 'dist')
const SHOT_DIR = path.join(os.homedir(), 'LogisX-replica', 'screens', 'invoice-status')
const PHONE = { tag: '390x844', viewport: { width: 390, height: 844 } }
const DESKTOP = { tag: '1280x800', viewport: { width: 1280, height: 800 } }

function die(msg) {
  console.error(`invoice-status: ${msg}`)
  process.exit(2)
}

if (process.env.E2E_PORT && (!Number.isInteger(ASKED_PORT) || ASKED_PORT < 1024 || ASKED_PORT > 65535)) die(`E2E_PORT must be a port number from 1024 to 65535; got "${process.env.E2E_PORT}"`)
if (ASKED_PORT === 3000 || ASKED_PORT === 5173) die(`refusing port ${ASKED_PORT}: 3000 is production's port on the VPS and 5173 is Vite's`)
if (!WORLD_ONLY && !fs.existsSync(path.join(DIST, 'index.html'))) die(`no ${path.join(DIST, 'index.html')}: run \`npm --prefix client run build\` first`)

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
  throw new Error('invoice-status: TLS refused in this check')
}
const realConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedConnect(...args) {
  const { host, port } = targetOf(args)
  if (!LOOPBACK.has(host)) {
    wire.remote.push(host)
    throw new Error('invoice-status: only 127.0.0.1 is reachable in this check')
  }
  if (MAIL_PORTS.has(port)) {
    wire.mailPorts.push(port)
    throw new Error('invoice-status: mail ports are refused in this check')
  }
  return realConnect.apply(this, args)
}

// ---------------------------------------------------------------- the server's own modules
const require = createRequire(import.meta.url)
const Database = require(path.join(paths.REPO, 'node_modules', 'better-sqlite3'))
const jobLib = require(path.join(paths.REPO, 'lib', 'auto-invoice-job.js'))
const ledger = require(path.join(paths.REPO, 'lib', 'auto-invoice-ledger.js'))
const rules = require(path.join(paths.REPO, 'lib', 'auto-invoice-rules.js'))
const factoring = require(path.join(paths.REPO, 'lib', 'factoring-store.js'))
const evidenceLib = require(path.join(paths.REPO, 'lib', 'invoice-evidence.js'))
const mailboxSearch = require(path.join(paths.REPO, 'lib', 'invoice-mailbox-search.js'))
const { textPdf } = require(path.join(paths.REPO, 'scripts', 'lib', 'made-up-pdf.js'))
// The toggle counts by this, and --world compares against the client's own words.
const clientAuto = await import(pathToFileURL(path.join(paths.REPO, 'client', 'src', 'lib', 'autoInvoiceStatus.js')).href)
const clientStatus = await import(pathToFileURL(path.join(paths.REPO, 'client', 'src', 'lib', 'invoiceStatus.js')).href)

// ---------------------------------------------------------------- made-up fixtures
const ADMIN = { id: 90341, username: 'qa-status-admin', role: 'Super Admin', driverName: '', email: '', fullName: 'QA Status Admin', companyName: '', mustChangePassword: false }
const DISPATCHER = { id: 90342, username: 'qa-status-dispatcher', role: 'Dispatcher', driverName: '', email: '', fullName: 'QA Status Dispatcher', companyName: '', mustChangePassword: false }
const DRIVER = Object.freeze({ role: 'Driver' })
const OFFICE = Object.freeze({ role: 'Dispatcher' })
const DRIVER_NAME = 'Casey Example'
const DOMAIN = 'broker.example.test'
const OTHER_DOMAIN = 'other-broker.example.test'
const BROKER = `ops@${DOMAIN}`
const OTHER_BROKER = `ops@${OTHER_DOMAIN}`
const PAYMENTS_HEADERS = Object.freeze([' Job ID', 'Contract ID', 'Payment Amount', 'Invoice Number', 'Payment Date', 'Payment Status'])

// The columns the page shows; the job also reads the broker Email, which this list leaves off.
const HEADERS = ['Load ID', 'Status', 'Driver', 'Truck', 'Pickup Address', 'Drop-off Address', 'Payment', 'Completion Date']
const JOB_HEADERS = [...HEADERS, 'Email']

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const [TY, TM, TD] = TODAY.split('-')
const DELIVERED_ON = `${TM}/${TD}/${TY} 09:15:00`
// Older, so it sorts below every load under test whatever the order it was added in.
const DELIVERED_LONG_AGO = `${TM}/01/${Number(TY) - 1} 09:15:00`
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const TODAY_SHOWN = `${MONTHS[Number(TM) - 1]} ${Number(TD)}, ${TY}`
const NUMBER = (n) => `${TM}${TD}${TY}-${n}`

const ID = {
  SENT: 'QA-SENT-9001', CHANGED: 'QA-CHANGED-9002', MAIL_HAND: 'QA-MAILHAND-9003', HAND_ROW: 'QA-HANDROW-9004', PAYMENTS: 'QA-PAYMENTS-9005',
  JOB_DRAFT: 'QA-JOBDRAFT-9006', PERSON: 'QA-PERSON-9007', WORKING: 'QA-WORKING-9008', QUEUED: 'QA-QUEUED-9009', CHECKING: 'QA-CHECKING-9010',
  HELD: 'QA-HELD-9011', HELD_NONE: 'QA-HELDNONE-9012', FACTORED: 'QA-FACTORED-9013', OFFICE: 'QA-OFFICE-9014', OFFICE_CLEAN: 'QA-OFFCLEAN-9015', OLD: 'QA-OLD-8000',
  P_CLEAN: 'QA-PASSCLEAN-9101', P_UNSEARCHED: 'QA-PASSNEW-9102', P_GONE: 'QA-PASSGONE-9103', P_MENTION: 'QA-PASSNAME-9104',
}
const OLD_FILLER = 30

// The screen's copy, pinned here so a changed word is a FAIL rather than a matching read.
const NOT_STARTED = { label: 'No automatic invoice', tone: 'warn', reason: "No automatic invoice was started for this load: only the driver's own Delivered starts one. Draft it by hand." }
const WORDS = {
  sent: (id) => ({ label: 'Sent by LogisX', tone: 'ok', reason: `Invoice ${id} was sent to the broker automatically on ${TODAY_SHOWN}. Its copy is in Gmail Sent Mail.` }),
  changed: (id) => ({ label: 'Sent by LogisX: load changed', tone: 'warn', reason: `Invoice ${id} was sent to the broker automatically on ${TODAY_SHOWN}. Changed since the invoice was sent to the broker: the Payment. Check with the broker whether a corrected invoice is needed, then Mark checked.` }),
  mailHand: { label: 'Invoiced by hand', tone: 'ok', reason: `An invoice for this load is in Gmail Sent Mail, dated ${TODAY_SHOWN}.` },
  handRow: (id) => ({ label: 'Invoiced by hand: Sent Mail not checked yet', tone: 'muted', reason: `Someone drafted invoice ${id} by hand. Sent Mail not checked yet.` }),
  payments: { label: 'Invoiced by hand', tone: 'ok', reason: 'The Payments Table holds an invoice or payment for this load.' },
  jobDraft: (id) => ({ label: 'Draft in Gmail', tone: 'ok', reason: `LogisX made this draft. Invoice ${id} is in Gmail Drafts. Check it and send it.` }),
  personDraft: (id) => ({ label: 'Draft in Gmail', tone: 'ok', reason: `Someone made this draft by hand. Invoice ${id} is in Gmail Drafts. Check it and send it.` }),
  working: { label: 'Making the invoice now', tone: 'muted', reason: 'The invoice is being made. It takes a minute or two.' },
  queued: { label: 'Waiting: about to be made', tone: 'muted', reason: 'The invoice will be made shortly.' },
  checking: { label: 'Waiting: checking Sent Mail', tone: 'warn', reason: 'The invoice email got no answer from Gmail, so it may have been sent. Sent Mail is checked again shortly. It is never sent twice.' },
  held: { label: 'Needs attention: totals differ', tone: 'bad', reason: "The rate con's total and the Payment on Job Tracking don't agree, or the Payment isn't one plain amount. Check both; if a re-issued rate con changed it, see its alert. Fix Job Tracking if it's wrong, then Try again, or draft it by hand." },
  factored: { label: 'Factored (Triumph)', tone: 'muted', reason: 'This load is factored: its invoice goes through Triumph, not by email.' },
  notSearched: { label: "Couldn't check: not searched yet", tone: 'muted', reason: "The mailbox hasn't been searched for this load yet." },
  noneFound: { label: 'No invoice found', tone: 'warn', reason: /^Gmail Drafts and Sent Mail hold no invoice for this load, last searched .+ E[SD]T\. That isn't proof: it may have been billed another way\.$/ },
  gone: (id) => ({ label: 'Needs attention: in neither Gmail mailbox', tone: 'bad', reason: `Invoice ${id}. An invoice draft was made in the app, but it's in neither Gmail Drafts nor Sent Mail. Check Gmail, then draft it again if it's needed.` }),
  mention: { label: "Couldn't check: an email names this load", tone: 'muted', reason: "An email names this load, but it doesn't look like an invoice. Check Gmail." },
  // The job's own chips, with no status on the row.
  jobSent: (id) => ({ label: 'Sent to the broker', tone: 'ok', reason: `Invoice ${id} was sent to the broker automatically. Its copy is in Gmail Sent Mail.` }),
}
const EIGHT = ['Sent by LogisX', 'Invoiced by hand', 'Draft in Gmail', 'Waiting', 'Needs attention', 'Factored (Triumph)', 'No invoice found', "Couldn't check"]
const DONE_TEXT = "It's being made now."
const NOTE_ALL = 'Search, Needs Review, Needs attention and Invoice status aren’t applied to the downloaded file.'
const NOTE_TODAY = 'Search, Needs Review and Needs attention aren’t applied to the downloaded file.'
const TITLE_TODAY = 'Show only loads whose automatic invoice draft needs attention'

function gate() {
  let open = null
  const p = new Promise((resolve) => { open = resolve })
  return { p, open }
}
async function until(check, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

// One made-up server's worth of state, with the job and the status on it. A load's row is what Job
// Tracking would hold.
async function freshServer({ user = ADMIN, env = {}, oldLoads = 0 } = {}) {
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
  factoring.ensureSchema(db)
  const s = {
    db,
    user,
    leak: false,
    rows: [],
    smtp: [],
    appends: [],
    looks: [],
    payments: [[...PAYMENTS_HEADERS]],
    retryPosts: [],
    checkedPosts: [],
    renderHook: null,
    prepareHook: null,
    logs: [],
    numbers: 0,
    ids: 0,
    routes: {},
  }
  s.row = (id) => s.rows.find((r) => rules.loadKey(r['Load ID']) === rules.loadKey(id)) || null
  s.addLoad = (id, status = 'At Receiver', { email = BROKER, deliveredOn = DELIVERED_ON } = {}) => {
    s.rows.push({
      _rowIndex: s.rows.length + 2,
      'Load ID': id,
      Status: status,
      Driver: DRIVER_NAME,
      Truck: 'QA-T1',
      'Pickup Address': '100 Example Rd, Memphis, TN 38118',
      'Drop-off Address': '200 Sample Ave, Dallas, TX 75201',
      Payment: '$1,234.00',
      'Completion Date': status === 'Delivered' ? deliveredOn : '',
      Email: email,
      _pickupStreet: '100 Example Rd',
      _pickupLocation: 'Memphis, TN 38118',
      _dropStreet: '200 Sample Ave',
      _dropLocation: 'Dallas, TX 75201',
    })
    db.prepare("INSERT INTO documents (load_id, type, file_name, drive_url, uploaded_at) VALUES (?, 'POD', ?, ?, datetime('now', '-60 minutes'))").run(id, `${id}_POD.pdf`, `/uploads/${id}_POD.pdf`)
  }
  ledger.writeSettings(db, { optOutDomains: [], confirmedBrokerDomains: [DOMAIN, OTHER_DOMAIN] }, { by: ADMIN.username, nowIso: new Date().toISOString() })
  const log = { warn: (m) => s.logs.push(m), error: (m) => s.logs.push(m) }
  const dayKeyOf = (cell) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(cell || ''))
    return m ? `${m[3]}-${m[1]}-${m[2]}` : ''
  }
  const job = jobLib.create({
    db,
    env: { AUTO_INVOICE_DRAFTS_ENABLED: 'true', AUTO_INVOICE_DRAFTS_SHADOW: 'false' },
    readJobTracking: async () => ({ headers: JOB_HEADERS, data: s.rows.map((r) => ({ ...r })) }),
    closedMonthsOf: () => [],
    dayKeyOf,
    uploadsRoot: path.join(path.sep, 'made-up', 'uploads'),
    fileExists: () => true,
    engine: {
      async prepare({ loadId }) {
        if (s.prepareHook) {
          const refused = s.prepareHook(loadId)
          if (refused) return refused
        }
        const domain = String((s.row(loadId) || {}).Email || BROKER).split('@')[1]
        return { ok: true, ctx: { loadId, to: `billing@${domain}` } }
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
    nextInvoiceNumber: () => NUMBER(++s.numbers),
    appendGmailDraft: async (o) => { s.appends.push(o.to); return { ok: true } },
    findDraftByMessageId: async () => ({ found: false, count: 0, mailbox: '', like: { count: 0 } }),
    newMessageId: () => `<qa-status-${++s.ids}.auto-invoice@example.com>`,
    mailbox: () => ({ user: 'qa-mailbox@example.com', pass: 'made-up' }),
    bisonRecipient: () => '',
    logAudit: () => {},
    notify: () => {},
    geminiUnavailableAt: () => null,
    log,
    timeZone: 'America/New_York',
    workerId: 'qa-status-worker',
    send: { enabled: true, domains: [DOMAIN], settleMinutes: 0 },
    sendMail: async (o) => { s.smtp.push({ to: o.to, loadId: o.subject.replace(/^.*#/, '') }); return { ok: true } },
    readPaymentsTable: async () => s.payments,
    lookInMailbox: async (o) => { s.looks.push(o.loadNumber); return { verdict: 'clean', mailboxes: {} } },
    sleep: async () => {},
  })
  s.job = job
  s.evidence = evidenceLib.create({ db, env, replica: false, closedMonthsOf: () => [], dayKeyOf, sweepOn: () => false, timeZone: 'America/New_York', log })
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
  s.seedClaim = (id, fields) => {
    ledger.insertClaim(db, { key: rules.loadKey(id), loadId: id, state: fields.state, code: fields.reason_code || '', nowIso: new Date().toISOString() })
    const { state: _state, ...rest } = fields
    const cols = Object.keys(rest)
    if (cols.length) db.prepare(`UPDATE auto_invoice_claims SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE load_key = ?`).run(...cols.map((c) => rest[c]), rules.loadKey(id))
  }
  s.handDraft = (id, invoiceId) => db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, via, created_by) VALUES (?, ?, ?, 'ratecon', 'imap', ?)").run(id, invoiceId, `billing@${DOMAIN}`, ADMIN.username)
  // A mailbox answer as the search would have saved it. Counts only: no address or subject exists here.
  s.saveAnswer = (id, { draftsInvoice = 0, sentInvoice = 0, sentMention = 0, firstSent = '', payments = false } = {}) => {
    const nowIso = new Date().toISOString()
    const verdict = sentInvoice || draftsInvoice ? mailboxSearch.KIND.INVOICE : sentMention ? mailboxSearch.KIND.MENTION : mailboxSearch.CLEAN
    evidenceLib.saveAnswer(db, rules.loadKey(id), { verdict, mailboxes: { drafts: { invoice: draftsInvoice, mention: 0 }, sent: { invoice: sentInvoice, mention: sentMention, firstInvoiceDate: firstSent } } }, { nowIso, paymentsAt: payments ? nowIso : '' })
  }
  // A load delivered before the switch: the first start-up leaves it to people.
  s.addLoad(ID.OLD, 'Delivered', { deliveredOn: DELIVERED_LONG_AGO })
  for (let i = 0; i < oldLoads; i++) s.addLoad(`QA-OLD-${7000 + i}`, 'Delivered', { deliveredOn: DELIVERED_LONG_AGO })
  job.startTrigger()
  await job.finishStartUp()
  return s
}

// A load a driver delivered, its invoice gone by the time this returns.
async function driverSends(s, id, opts) {
  s.addLoad(id, 'At Receiver', opts)
  s.statusWrite(DRIVER, id)
  return until(() => (s.claim(id) || {}).state === 'drafted')
}
// A load a driver delivered, held for a person.
async function driverHeld(s, id) {
  s.addLoad(id)
  s.prepareHook = (loadId) => (loadId === id ? { ok: false, http: 422, code: 'TOTAL_MISMATCH' } : null)
  s.statusWrite(DRIVER, id)
  const held = await until(() => (s.claim(id) || {}).state === 'needs_attention')
  s.prepareHook = null
  return held
}
const markChanged = (s, id) => s.db.prepare('UPDATE auto_invoice_claims SET changed_fields = ?, changed_at = ? WHERE load_key = ?').run('payment', new Date().toISOString(), rules.loadKey(id))
const noneLeftRunning = (s) => until(() => !ledger.listClaims(s.db, ['queued', 'working']).length, 15000)
// A read's own check may still be finishing, and it mustn't meet a closed database.
async function closeWorld(s) {
  if (s.held) s.held.open()
  await noneLeftRunning(s)
  await new Promise((r) => setTimeout(r, 200))
  s.db.close()
}

// Every status the mailbox pass off can give, one load each, with one load's build held open so the
// page can see it being made. What each should read is listed with it.
async function statusWorld() {
  const s = await freshServer({ oldLoads: OLD_FILLER })
  const ran = [
    await driverSends(s, ID.SENT),
    await driverSends(s, ID.CHANGED),
    await driverSends(s, ID.JOB_DRAFT, { email: OTHER_BROKER }),
    await driverHeld(s, ID.HELD),
    await driverHeld(s, ID.HELD_NONE),
  ]
  if (!ran.every(Boolean)) throw new Error(`a made-up load's run didn't finish: ${JSON.stringify(ran)}`)
  markChanged(s, ID.CHANGED)
  s.saveAnswer(ID.HELD_NONE, { draftsInvoice: 1 })

  s.addLoad(ID.MAIL_HAND, 'Delivered')
  s.saveAnswer(ID.MAIL_HAND, { sentInvoice: 1, firstSent: `${TODAY}T14:00:00.000Z` })
  s.addLoad(ID.HAND_ROW, 'Delivered')
  s.handDraft(ID.HAND_ROW, NUMBER(80))
  s.addLoad(ID.PAYMENTS, 'Delivered')
  evidenceLib.savePayments(s.db, rules.loadKey(ID.PAYMENTS), { payments_status: 1 }, { nowIso: new Date().toISOString() })
  s.addLoad(ID.PERSON, 'Delivered')
  s.handDraft(ID.PERSON, NUMBER(81))
  s.saveAnswer(ID.PERSON, { draftsInvoice: 1 })
  s.addLoad(ID.FACTORED, 'Delivered')
  const marked = factoring.mark(s.db, { key: rules.loadKey(ID.FACTORED), loadId: ID.FACTORED, reason: 'made-up', actor: ADMIN, nowIso: new Date().toISOString() })
  if (!marked || !marked.ok) throw new Error(`the made-up factoring mark was refused: ${JSON.stringify(marked)}`)
  s.addLoad(ID.OFFICE)
  s.statusWrite(OFFICE, ID.OFFICE)
  s.addLoad(ID.OFFICE_CLEAN)
  s.statusWrite(OFFICE, ID.OFFICE_CLEAN)
  s.saveAnswer(ID.OFFICE_CLEAN, { payments: true })

  // Held open until a part lets it go, so the queued loads stay queued: one run at a time.
  s.held = gate()
  s.renderHook = (loadId) => (loadId === ID.WORKING ? s.held.p : undefined)
  s.addLoad(ID.WORKING)
  s.statusWrite(DRIVER, ID.WORKING)
  const building = await until(() => (s.claim(ID.WORKING) || {}).state === 'working' && (s.claim(ID.WORKING) || {}).stage === 'reserved')
  s.addLoad(ID.QUEUED)
  s.statusWrite(DRIVER, ID.QUEUED)
  const inLine = await until(() => (s.claim(ID.QUEUED) || {}).state === 'queued')
  if (!building || !inLine) throw new Error(`the held build didn't settle: working ${JSON.stringify((s.claim(ID.WORKING) || {}).state)}, queued ${JSON.stringify((s.claim(ID.QUEUED) || {}).state)}`)
  s.addLoad(ID.CHECKING, 'Delivered')
  s.seedClaim(ID.CHECKING, { state: 'queued', reason_code: 'SEND_UNCONFIRMED', stage: 'appending', delivery: 'send', invoice_id: NUMBER(82), message_id: '<qa-status-checking.auto-invoice@example.com>', sent_json: '{}' })

  const number = (id) => (s.claim(id) || {}).invoice_id
  s.expected = [
    [ID.SENT, 'sent', WORDS.sent(number(ID.SENT)), []],
    [ID.CHANGED, 'sent', WORDS.changed(number(ID.CHANGED)), ['Mark checked']],
    [ID.MAIL_HAND, 'by_hand', WORDS.mailHand, []],
    [ID.HAND_ROW, 'by_hand', WORDS.handRow(NUMBER(80)), []],
    [ID.PAYMENTS, 'by_hand', WORDS.payments, []],
    [ID.JOB_DRAFT, 'draft', WORDS.jobDraft(number(ID.JOB_DRAFT)), []],
    [ID.PERSON, 'draft', WORDS.personDraft(NUMBER(81)), []],
    [ID.WORKING, 'waiting', WORDS.working, []],
    [ID.QUEUED, 'waiting', WORDS.queued, []],
    [ID.CHECKING, 'waiting', WORDS.checking, []],
    [ID.HELD, 'needs_attention', WORDS.held, ['Try again']],
    [ID.HELD_NONE, 'needs_attention', WORDS.held, []],
    [ID.FACTORED, 'factored', WORDS.factored, []],
    [ID.OFFICE, 'unknown', NOT_STARTED, []],
    [ID.OFFICE_CLEAN, 'unknown', NOT_STARTED, []],
    [ID.OLD, 'unknown', WORDS.notSearched, []],
  ]
  return s
}

// The same rows with the mailbox pass on.
async function passWorld() {
  const s = await freshServer({ env: { INVOICE_MAILBOX_PASS_ENABLED: 'true' } })
  s.addLoad(ID.P_CLEAN)
  s.statusWrite(OFFICE, ID.P_CLEAN)
  s.saveAnswer(ID.P_CLEAN, { payments: true })
  s.addLoad(ID.P_UNSEARCHED)
  s.statusWrite(OFFICE, ID.P_UNSEARCHED)
  s.addLoad(ID.P_GONE, 'Delivered')
  s.handDraft(ID.P_GONE, NUMBER(83))
  s.saveAnswer(ID.P_GONE, { payments: true })
  s.addLoad(ID.P_MENTION)
  s.statusWrite(OFFICE, ID.P_MENTION)
  s.saveAnswer(ID.P_MENTION, { sentMention: 1, payments: true })
  s.expected = [
    [ID.P_CLEAN, 'none_found', WORDS.noneFound, []],
    [ID.P_UNSEARCHED, 'unknown', NOT_STARTED, []],
    [ID.P_GONE, 'needs_attention', WORDS.gone(NUMBER(83)), []],
    [ID.P_MENTION, 'unknown', WORDS.mention, []],
    [ID.OLD, 'unknown', WORDS.notSearched, []],
  ]
  return s
}

// The kill switch: the job's chips, with no status on any row.
async function killedWorld() {
  const s = await freshServer({ env: { INVOICE_STATUS_ENABLED: 'false' } })
  await driverSends(s, ID.SENT)
  s.addLoad(ID.OFFICE)
  s.statusWrite(OFFICE, ID.OFFICE)
  s.expected = [[ID.SENT, '', WORDS.jobSent((s.claim(ID.SENT) || {}).invoice_id), []], [ID.OFFICE, '', NOT_STARTED, []], [ID.OLD, '', null, []]]
  return s
}

const isAdmin = (s) => s.user.role === 'Super Admin'
function completedRows(s) {
  const completed = s.rows.filter((r) => rules.isCompletedStatus(r.Status)).map((r) => ({ ...r }))
  // server.js's order: the job's chip, then the status.
  s.job.annotateCompletedRows({ rows: completed, headers: JOB_HEADERS, isSuperAdmin: isAdmin(s) })
  s.evidence.annotateCompletedRows({ rows: completed, headers: JOB_HEADERS, isSuperAdmin: isAdmin(s) })
  if (s.leak) for (const r of completed) { r._invoiceStatus = { status: 'sent', invoiceId: NUMBER(99) }; r._autoInvoice = { state: 'needs_attention', code: 'NOT_BY_DRIVER', trigger: true, retry: 'none', changed: [] } }
  return completed
}

function dashboardBody(s) {
  const completed = completedRows(s)
  return {
    timestamp: new Date().toISOString(),
    kpis: { activeLoads: 0, unassignedLoads: 0, completedThisWeek: completed.length, completedThisMonth: completed.length, fleetUtilization: { assigned: 0, total: 1 }, revenue: { total: 0, paid: 0, pending: 0 } },
    unassignedJobs: [], jobTrackingHeaders: HEADERS, completedHeaders: HEADERS, activeJobs: [],
    completedJobs: completed,
    fleet: [], drivers: [DRIVER_NAME], driverQueues: {},
    ...(isAdmin(s) ? { autoInvoice: { mode: 'on' } } : {}),
  }
}

const json200 = (body) => ({ status: 200, body })
const parse = (raw) => { try { return JSON.parse(raw || 'null') } catch { return null } }

function answerGet(s, pathname) {
  if (pathname === '/api/auth/session') return json200({ authenticated: true, user: s.user, appTimeZone: 'America/New_York' })
  if (pathname === '/api/dashboard') return json200(dashboardBody(s))
  if (pathname === '/api/dispatch-notifications') return json200({ notifications: [], unreadCount: 0 })
  if (pathname === '/api/load-ratings/averages') return json200({ averages: {} })
  if (pathname === '/api/truck-assignments') return json200({ assignments: [] })
  if (pathname === '/api/config/maps-key') return json200({ key: 'qa-status-no-key' })
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

// Try again and Mark checked, through the job's own routes. Anything else the page writes is listed.
async function answerWrite(s, method, pathname, raw) {
  const m = pathname.match(/^\/api\/auto-invoice\/loads\/([^/]+)\/(retry|checked)$/)
  if (method === 'POST' && m) {
    const loadKey = decodeURIComponent(m[1])
    ;(m[2] === 'retry' ? s.retryPosts : s.checkedPosts).push(loadKey)
    return s.callRoute(`POST /api/auto-invoice/loads/:loadKey/${m[2]}`, { loadKey }, parse(raw) || {})
  }
  return null
}

// ---------------------------------------------------------------- the static server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.webmanifest': 'application/manifest+json' }

// A download may not pass through the page's route handler, so the export is answered here. The file
// is the three cells exportColumns() gives each row, beside the Load ID.
let exportWorld = null
const exportAsks = []
function serveExport(req, res) {
  exportAsks.push(req.url)
  const cols = exportWorld ? exportWorld.evidence.exportColumns({ headers: JOB_HEADERS }) : null
  const rows = exportWorld ? exportWorld.rows.filter((r) => rules.isCompletedStatus(r.Status)) : []
  const lines = [['Load ID', ...(cols ? cols.headers : [])], ...rows.map((r) => [r['Load ID'], ...(cols ? cols.cells(r) : [])])]
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="completed-loads.csv"', 'cache-control': 'no-store' })
  res.end(lines.map((cells) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'))
}

function serveDist(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, BASE).pathname) } catch { rel = '/' }
  if (rel === '/api/loads/completed/export') return serveExport(req, res)
  if (rel.startsWith('/api/') || rel.startsWith('/socket.io/') || rel.startsWith('/uploads/')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not served by this check"}')
    return undefined
  }
  const file = path.resolve(DIST, '.' + path.posix.normalize(rel))
  const inside = file === DIST || file.startsWith(DIST + path.sep)
  const target = inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(DIST, 'index.html')
  res.writeHead(200, { 'content-type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(target).pipe(res)
  return undefined
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

const reasonMatches = (want, got) => (want instanceof RegExp ? want.test(got) : want === got)
const sameChip = (want, got) => (want === null ? got === null : Boolean(got) && got.label === want.label && got.tone === want.tone && reasonMatches(want.reason, got.reason))

// ---------------------------------------------------------------- page helpers
// `dialogs.plan` holds the answers to the next browser dialogs. A dialog with no planned answer is
// dismissed, and `dialogs.seen` shows it, so an extra question fails its row.
async function openPage(browser, size, s) {
  const phone = size.viewport.width < 640
  const ctx = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block', acceptDownloads: true })
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.host !== `${HOST}:${PORT}`) { wire.offHost.add(u.host); return route.abort() }
    if (u.pathname.startsWith('/socket.io/')) return route.abort()
    if (u.pathname === '/api/loads/completed/export') return route.continue()
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
const SELECT = '#cl-invoice-status'
const toggleText = async (page) => ((await page.locator('button.auto-toggle').count()) ? locText(page.locator('button.auto-toggle')) : '')
const shownIds = async (page) => (await page.locator('tbody tr').allTextContents()).map((t) => (/QA-[A-Z]+-\d+/.exec(t) || [''])[0]).filter(Boolean)

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
  const pass = count === 1 && label === want.label && cls.includes(`auto-chip--${want.tone}`) && reasonMatches(want.reason, tip)
  record(step, title, `one chip "${want.label}", tone ${want.tone}, title ${want.reason}`, `chips ${count}, label "${label}", class "${cls}", title "${tip}"`, pass)
}

async function openLine(page, id) {
  await rowOf(page, id).locator('.auto-chip').click({ timeout: 8000 })
  return appears(page, '.auto-line', 8000)
}
async function closeLine(page) {
  await page.keyboard.press('Escape')
  await hides(page, '.auto-line')
}
const lineButtons = async (page) => (await page.locator('.auto-line button').allTextContents()).map((t) => t.trim())

// The dialog's one line: "<label>. <reason>", its tone, and which buttons sit on it.
async function lineStep(page, step, title, id, want, buttons = []) {
  const opened = await openLine(page, id)
  const lines = opened ? await page.locator('.auto-line').count() : 0
  const text = opened ? await locText(page.locator('.auto-line-text')) : ''
  const cls = opened ? (await page.locator('.auto-line').first().getAttribute('class')) || '' : ''
  const got = opened ? await lineButtons(page) : ['(not opened)']
  const prefix = `${want.label}. `
  const pass = lines === 1 && text.startsWith(prefix) && reasonMatches(want.reason, text.slice(prefix.length)) && cls.includes(`auto-line--${want.tone}`) && JSON.stringify(got) === JSON.stringify(buttons)
  record(step, title, `one line "${want.label}. ${want.reason}", tone ${want.tone}, buttons ${JSON.stringify(buttons)}`, `lines ${lines}, "${text}", class "${cls}", buttons ${JSON.stringify(got)}`, pass)
  if (opened) await closeLine(page)
}

// What a status's rows should be, from the world's list and what its filler adds.
const idsOf = (s, status) => s.expected.filter(([, st]) => st === status).map(([id]) => id).sort()
const wantCount = (s, status) => idsOf(s, status).length + (status === 'unknown' && s.fillers ? s.fillers : 0)

// ---------------------------------------------------------------- E: every status
async function statusRun(browser, size) {
  const tag = `E-${size.tag}`
  const s = await statusWorld()
  const { ctx, page } = await openPage(browser, size, s)
  try {
    const listed = await openCompleted(page)
    record(`${tag}-list`, 'Completed Loads lists the loads', 'rows', `listed ${listed}`, listed)
    if (!listed) return
    for (const [id, , want] of s.expected) await chipStep(page, `${tag}-${id}`, `The row of ${id}`, id, want)
    const fits = await noSideScroll(page)
    const file = await shot(page, `${tag}-chips`)
    record(`${tag}-fits`, 'The list fits with the chips', 'no side scroll', `fits ${fits}`, fits, file)
    const anyNone = await page.locator('.auto-chip', { hasText: 'No invoice found' }).count()
    record(`${tag}-none`, 'With the pass off nothing reads "No invoice found"', 'no such chip', `chips ${anyNone}`, anyNone === 0)
    for (const [id, , want, buttons] of s.expected) await lineStep(page, `${tag}-${id}-line`, `The dialog of ${id}`, id, want, buttons)
    await openLine(page, ID.CHANGED)
    const lineFits = await noSideScroll(page)
    const lineFile = await shot(page, `${tag}-line`)
    record(`${tag}-line-fits`, 'The dialog fits, with the line and its button', 'no side scroll', `fits ${lineFits}`, lineFits, lineFile)
    await closeLine(page)
  } finally {
    await ctx.close()
    await closeWorld(s)
  }
}

// ---------------------------------------------------------------- F: the filter
async function filterRun(browser, size) {
  const tag = `F-${size.tag}`
  const s = await statusWorld()
  s.fillers = OLD_FILLER
  exportWorld = s
  const { ctx, page } = await openPage(browser, size, s)
  try {
    if (!await openCompleted(page)) {
      record(`${tag}-list`, 'Completed Loads lists the loads', 'rows', 'not listed', false)
      return
    }
    const STATUSES = ['sent', 'by_hand', 'draft', 'waiting', 'needs_attention', 'factored', 'none_found', 'unknown']
    const options = (await page.locator(`${SELECT} option`).allTextContents()).map((t) => t.trim())
    const wantOptions = ['All invoice statuses', ...STATUSES.map((st, i) => `${EIGHT[i]} (${wantCount(s, st)})`)]
    const barFile = await shot(page, `${tag}-bar`)
    record(`${tag}-options`, 'The select offers all, then the eight with their counts', JSON.stringify(wantOptions), JSON.stringify(options), JSON.stringify(options) === JSON.stringify(wantOptions), barFile)
    const barFits = await noSideScroll(page)
    record(`${tag}-fits`, 'The bar fits with the select', 'no side scroll', `fits ${barFits}`, barFits)

    // A choice goes back to page 1: on page 2 a short list would otherwise show nothing.
    await page.locator('[aria-label="Next page"]').first().click({ timeout: 5000 })
    await appears(page, 'tbody tr', 5000)
    const onTwo = await locText(page.locator('.pagination-info'))
    await page.selectOption(SELECT, 'needs_attention')
    await page.waitForTimeout(200)
    const attention = (await shownIds(page)).sort()
    const wantAttention = idsOf(s, 'needs_attention')
    const pickFile = await shot(page, `${tag}-picked`)
    record(`${tag}-page-one`, 'A choice on page 2 goes back to page 1', `from "26-..."; lists ${wantAttention.join(', ')}`, `from "${onTwo}"; lists ${attention.join(', ')}`, /^26/.test(onTwo) && JSON.stringify(attention) === JSON.stringify(wantAttention), pickFile)
    const count = await locText(page.locator('.cl-count'))
    const note = await locText(page.locator('.cl-note'))
    record(`${tag}-note`, 'The count, and the note names the status', `"${wantAttention.length} loads"; "${NOTE_ALL}"`, `"${count}"; "${note}"`, count === `${wantAttention.length} loads` && note === NOTE_ALL)

    // The download asks for no status, and the file holds every load.
    const asksBefore = exportAsks.length
    const asked = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
    await page.locator('button.cl-download').click({ timeout: 5000 })
    const download = await asked
    const url = download ? download.url() : ''
    let csv = ''
    if (download) { try { csv = fs.readFileSync(await download.path(), 'utf8') } catch { csv = '' } }
    const lines = csv.split('\n')
    const number = (s.claim(ID.SENT) || {}).invoice_id
    const sentLine = lines.find((l) => l.startsWith(`"${ID.SENT}"`)) || ''
    const wantSentLine = `"${ID.SENT}","Sent by LogisX","${number}","${TODAY}"`
    const noStatusAsked = Boolean(url) && !/[?&][^=]*status/i.test(url)
    record(`${tag}-csv`, 'The download takes no status; the file has the three columns and every load', `a URL with no status; header "Load ID","Invoice Status","Invoice #","Invoice Date"; ${s.rows.filter((r) => rules.isCompletedStatus(r.Status)).length} rows; ${wantSentLine}`,
      `url "${url}" (server asks ${exportAsks.length - asksBefore}); header ${lines[0]}; rows ${lines.length - 1}; ${sentLine}`,
      noStatusAsked && lines[0] === '"Load ID","Invoice Status","Invoice #","Invoice Date"' && lines.length - 1 === s.rows.filter((r) => rules.isCompletedStatus(r.Status)).length && sentLine === wantSentLine)

    for (const st of STATUSES) {
      await page.selectOption(SELECT, st)
      await page.waitForTimeout(150)
      const got = (await shownIds(page)).sort()
      if (st === 'unknown') {
        const info = await locText(page.locator('.pagination-info'))
        record(`${tag}-pick-${st}`, `Choosing ${st}`, `"1-25 of ${wantCount(s, st)}"`, `"${info}"`, info.replace(/\D+/g, '-') === `1-25-${wantCount(s, st)}`)
      } else if (st === 'none_found') {
        const said = await page.getByText('No completed loads match these filters.').count()
        record(`${tag}-pick-${st}`, 'Choosing No invoice found, with the pass off', 'no rows, and it says so', `rows ${got.length}, said ${said}`, got.length === 0 && said === 1)
      } else {
        const want = idsOf(s, st)
        record(`${tag}-pick-${st}`, `Choosing ${st}`, want.join(', '), got.join(', '), JSON.stringify(got) === JSON.stringify(want))
      }
    }

    // Clear puts it all back.
    await page.locator('button.cl-clear', { hasText: 'Clear' }).click({ timeout: 5000 })
    await page.waitForTimeout(150)
    const cleared = await page.locator(SELECT).inputValue()
    const info = await locText(page.locator('.pagination-info'))
    const total = s.rows.filter((r) => rules.isCompletedStatus(r.Status)).length
    record(`${tag}-clear`, 'Clear clears the choice', `no choice; "1-25 of ${total}"`, `choice "${cleared}"; "${info}"`, cleared === '' && info.replace(/\D+/g, '-') === `1-25-${total}`)

    // The counts follow the search: what picking each would list.
    await page.locator('.dash-search-bar input').first().fill(ID.SENT)
    await page.waitForTimeout(250)
    const narrowed = (await page.locator(`${SELECT} option`).allTextContents()).map((t) => t.trim())
    record(`${tag}-search`, 'The counts follow the search', 'Sent by LogisX (1), the rest (0)', narrowed.join('; '), narrowed.includes('Sent by LogisX (1)') && narrowed.includes("Couldn't check (0)") && narrowed.includes('Waiting (0)'))
    await page.locator('.dash-search-bar input').first().fill('')
    await page.waitForTimeout(150)

    // The toggle counts by the job's status, so its number can differ, and its title says so.
    const wantToggle = completedRows(s).filter(clientAuto.autoInvoiceNeedsAttention).length
    const toggle = await toggleText(page)
    const title = (await page.locator('button.auto-toggle').first().getAttribute('title')) || ''
    record(`${tag}-toggle`, 'The Needs attention toggle has its own number, and its title says why', `"Needs attention (${wantToggle})", not the select's ${wantCount(s, 'needs_attention')}; the title names the filter`, `"${toggle}"; "${title}"`,
      toggle === `Needs attention (${wantToggle})` && wantToggle !== wantCount(s, 'needs_attention') && /can differ from the Invoice status filter/.test(title))
  } finally {
    await ctx.close()
    exportWorld = null
    await closeWorld(s)
  }
}

// ---------------------------------------------------------------- A: the dialog's buttons
async function actionRun(browser, size) {
  const tag = `A-${size.tag}`
  const s = await statusWorld()
  const { ctx, page, dialogs } = await openPage(browser, size, s)
  try {
    if (!await openCompleted(page)) {
      record(`${tag}-list`, 'Completed Loads lists the loads', 'rows', 'not listed', false)
      return
    }
    // The saved evidence takes Try again away, whatever the status reads.
    const noneRow = completedRows(s).find((r) => r['Load ID'] === ID.HELD_NONE)
    const noneRetry = noneRow && noneRow._autoInvoice ? noneRow._autoInvoice.retry : ''
    await openLine(page, ID.HELD_NONE)
    const noneButtons = await lineButtons(page)
    const noneFile = await shot(page, `${tag}-retry-none`)
    record(`${tag}-retry-none`, 'retry "none": no Try again', 'the server says "none"; no button', `retry "${noneRetry}", buttons ${JSON.stringify(noneButtons)}`, noneRetry === 'none' && noneButtons.length === 0, noneFile)
    await closeLine(page)

    // Mark checked: the mark goes, in the dialog at once and on the row after a read.
    await openLine(page, ID.CHANGED)
    await page.locator('.auto-line button', { hasText: 'Mark checked' }).click({ timeout: 5000 })
    const posted = await until(() => s.checkedPosts.length === 1, 5000)
    const answered = await appears(page, '.auto-result:has-text("Marked checked.")', 5000)
    const checkedLine = await locText(page.locator('.auto-line-text'))
    const wantChecked = WORDS.sent((s.claim(ID.CHANGED) || {}).invoice_id)
    record(`${tag}-checked`, 'Mark checked posts once; the line loses the mark', `one POST; "${wantChecked.label}. ${wantChecked.reason}"`, `posts ${s.checkedPosts.length}, answered ${answered}, "${checkedLine}"`, posted && answered && checkedLine === `${wantChecked.label}. ${wantChecked.reason}`)
    await closeLine(page)
    await reloadCompleted(page)
    await chipStep(page, `${tag}-checked-row`, 'The row after it', ID.CHANGED, wantChecked)

    // The held build is let go: the load moves on, and the queue behind it goes too.
    await chipStep(page, `${tag}-working`, 'A load being built', ID.WORKING, WORDS.working)
    s.held.open()
    await noneLeftRunning(s)
    await reloadCompleted(page)
    await chipStep(page, `${tag}-working-sent`, 'The same load once its build ends', ID.WORKING, WORDS.sent((s.claim(ID.WORKING) || {}).invoice_id))

    // Try again: asks, posts once, and the line stops saying Needs attention until the next read.
    // Sending may have stopped by now (the queue's SEND_UNCONFIRMED load ends MAYBE_SENT), so this
    // reads its confirm from the line rather than assuming which it is.
    await openLine(page, ID.HELD)
    dialogs.plan.push({ accept: false })
    await page.locator('.auto-line button', { hasText: 'Try again' }).click({ timeout: 5000 })
    await until(() => dialogs.seen.length > 0, 5000)
    const cancelledText = await locText(page.locator('.auto-line-text'))
    record(`${tag}-cancel`, 'Try again asks first, and Cancel posts nothing', 'one confirm; no POST; the line as it was', `${JSON.stringify(dialogs.seen[dialogs.seen.length - 1])}, posts ${s.retryPosts.length}, "${cancelledText.slice(0, 60)}"`,
      dialogs.seen.length === 1 && dialogs.seen[0].type === 'confirm' && s.retryPosts.length === 0 && cancelledText.startsWith(`${WORDS.held.label}. `))
    dialogs.plan.push({ accept: true })
    await page.locator('.auto-line button', { hasText: 'Try again' }).click({ timeout: 5000 })
    await until(() => s.retryPosts.length === 1, 5000)
    const taken = await appears(page, `.auto-result:has-text("${DONE_TEXT}")`, 5000)
    const takenText = await locText(page.locator('.auto-line-text'))
    const takenFile = await shot(page, `${tag}-try-again`)
    record(`${tag}-try-again`, 'OK posts once; the line reads the job\'s words', `one POST; "${DONE_TEXT}"; "${WORDS.queued.label}. ${WORDS.queued.reason}"`, `posts ${s.retryPosts.length}, answered ${taken}, "${takenText}"`, s.retryPosts.length === 1 && taken && takenText === `${WORDS.queued.label}. ${WORDS.queued.reason}`, takenFile)
    await closeLine(page)
    const settled = await noneLeftRunning(s)
    await reloadCompleted(page)
    const after = rowOf(page, ID.HELD).locator('.auto-chip')
    const afterLabel = await locText(after)
    record(`${tag}-after-try`, 'The row after a read reads the server\'s status', 'the run finished; a status word, not "Needs attention: totals differ"', `settled ${settled}, "${afterLabel}"`, settled && EIGHT.some((w) => afterLabel.startsWith(w)) && afterLabel !== WORDS.held.label)
  } finally {
    await ctx.close()
    await closeWorld(s)
  }
}

// ---------------------------------------------------------------- P: the mailbox pass on
async function passRun(browser, size) {
  const tag = `P-${size.tag}`
  const s = await passWorld()
  const { ctx, page } = await openPage(browser, size, s)
  try {
    if (!await openCompleted(page)) {
      record(`${tag}-list`, 'Completed Loads lists the loads', 'rows', 'not listed', false)
      return
    }
    for (const [id, , want, buttons] of s.expected) {
      await chipStep(page, `${tag}-${id}`, `The row of ${id}`, id, want)
      await lineStep(page, `${tag}-${id}-line`, `The dialog of ${id}`, id, want, buttons)
    }
    const options = (await page.locator(`${SELECT} option`).allTextContents()).map((t) => t.trim())
    const fits = await noSideScroll(page)
    const file = await shot(page, `${tag}-chips`)
    record(`${tag}-count`, 'The select counts the search\'s answer', '"No invoice found (1)"; no side scroll', `${options.join('; ')}; fits ${fits}`, options.includes('No invoice found (1)') && fits, file)
  } finally {
    await ctx.close()
    await closeWorld(s)
  }
}

// ---------------------------------------------------------------- K: the kill switch
async function killedRun(browser, size) {
  const tag = `K-${size.tag}`
  const s = await killedWorld()
  const { ctx, page } = await openPage(browser, size, s)
  try {
    if (!await openCompleted(page)) {
      record(`${tag}-list`, 'Completed Loads lists the loads', 'rows', 'not listed', false)
      return
    }
    const carried = completedRows(s).filter((r) => r._invoiceStatus).length
    record(`${tag}-rows`, 'The server puts no status on a row', 'none', `rows with one ${carried}`, carried === 0)
    for (const [id, , want] of s.expected) await chipStep(page, `${tag}-${id}`, `The row of ${id}`, id, want)
    const select = await page.locator(SELECT).count()
    const title = (await page.locator('button.auto-toggle').first().getAttribute('title')) || ''
    await page.locator('.dash-search-bar input').first().fill(ID.SENT)
    await page.waitForTimeout(250)
    const note = await locText(page.locator('.cl-note'))
    const file = await shot(page, `${tag}-today`)
    record(`${tag}-today`, 'No select, today\'s title, today\'s note', `no select; "${TITLE_TODAY}"; "${NOTE_TODAY}"`, `selects ${select}; "${title}"; "${note}"`, select === 0 && title === TITLE_TODAY && note === NOTE_TODAY, file)
  } finally {
    await ctx.close()
    await closeWorld(s)
  }
}

// ---------------------------------------------------------------- D: a Dispatcher
async function dispatcherRun(browser, size) {
  const tag = `D-${size.tag}`
  const s = await freshServer({ user: DISPATCHER })
  s.addLoad(ID.OFFICE, 'Delivered')
  const { ctx, page } = await openPage(browser, size, s)
  try {
    if (!await openCompleted(page)) {
      record(`${tag}-list`, 'Completed Loads lists the loads', 'rows', 'not listed', false)
      return
    }
    const carried = completedRows(s).filter((r) => r._invoiceStatus || r._autoInvoice).length
    const see = async () => ({ chips: await page.locator('.auto-chip').count(), selects: await page.locator(SELECT).count(), bar: await page.locator('.cl-bar').count(), words: await page.getByText('Invoice status', { exact: false }).count() })
    const first = await see()
    const file = await shot(page, `${tag}-none`)
    record(`${tag}-none`, 'A Dispatcher sees no chip, select or word', 'no field on a row; nothing on screen', `rows with a field ${carried}; ${JSON.stringify(first)}`, carried === 0 && first.chips === 0 && first.selects === 0 && first.words === 0, file)
    s.leak = true
    await reloadCompleted(page)
    const leaked = await see()
    record(`${tag}-leak`, 'Even a row that came with the fields shows nothing', 'nothing on screen', JSON.stringify(leaked), leaked.chips === 0 && leaked.selects === 0 && leaked.words === 0)
  } finally {
    await ctx.close()
    await closeWorld(s)
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

// ---------------------------------------------------------------- --world: no browser
async function worldCheck() {
  for (const [name, build] of [['E', statusWorld], ['P', passWorld], ['K', killedWorld]]) {
    const s = await build()
    const body = dashboardBody(s)
    const byId = new Map(body.completedJobs.map((r) => [r['Load ID'], r]))
    for (const [id, status, want, buttons] of s.expected) {
      const r = byId.get(id)
      const got = r ? clientStatus.invoiceStatusChip(r) : undefined
      const read = r ? r._invoiceStatus : undefined
      const auto = r ? r._autoInvoice : undefined
      const gotButtons = [...(clientAuto.canMarkChecked(auto) ? ['Mark checked'] : []), ...(clientAuto.canTryAgain(auto) ? ['Try again'] : [])]
      const statusOk = status ? read && read.status === status : !read
      record(`W-${name}-${id}`, `${id}: the server's answer through the client's words`, `status ${status || '(none)'}; ${JSON.stringify(want && { ...want, reason: String(want.reason) })}; buttons ${JSON.stringify(buttons)}`,
        `status ${JSON.stringify(read)}; ${JSON.stringify(got)}; retry ${JSON.stringify(auto && auto.retry)}; buttons ${JSON.stringify(gotButtons)}`,
        Boolean(statusOk) && sameChip(want, got || null) && JSON.stringify(gotButtons) === JSON.stringify(buttons))
    }
    if (name === 'E') {
      s.fillers = OLD_FILLER
      const counts = clientStatus.invoiceStatusOptions(body.completedJobs).map((o) => `${o.value}:${o.count}`)
      const want = ['sent', 'by_hand', 'draft', 'waiting', 'needs_attention', 'factored', 'none_found', 'unknown'].map((st) => `${st}:${wantCount(s, st)}`)
      record('W-E-counts', 'The select\'s counts', want.join(' '), counts.join(' '), JSON.stringify(counts) === JSON.stringify(want))
      const toggle = body.completedJobs.filter(clientAuto.autoInvoiceNeedsAttention).length
      record('W-E-toggle', 'The toggle\'s number differs from the select\'s', `not ${wantCount(s, 'needs_attention')}`, String(toggle), toggle !== wantCount(s, 'needs_attention'))
      const cols = s.evidence.exportColumns({ headers: JOB_HEADERS })
      const sentCells = cols.cells(s.row(ID.SENT))
      record('W-E-csv', 'The file\'s cells', `Sent by LogisX, ${(s.claim(ID.SENT) || {}).invoice_id}, ${TODAY}`, sentCells.join(', '), sentCells[0] === 'Sent by LogisX' && sentCells[1] === (s.claim(ID.SENT) || {}).invoice_id && sentCells[2] === TODAY)
      const smtpOnce = [ID.SENT, ID.CHANGED].map((id) => s.smtp.filter((m) => m.loadId === id).length).join(',')
      record('W-E-smtp', 'One SMTP call for each load the job sent, none for its draft', '1,1 and 0', `${smtpOnce} and ${s.smtp.filter((m) => m.loadId === ID.JOB_DRAFT).length}`, smtpOnce === '1,1' && !s.smtp.some((m) => m.loadId === ID.JOB_DRAFT))
    }
    if (s.logs.length) console.log(`      logs in ${name}: ${s.logs.join(' | ').slice(0, 400)}`)
    await closeWorld(s)
  }
  // The Dispatcher's rows carry neither field.
  const d = await freshServer({ user: DISPATCHER })
  d.addLoad(ID.OFFICE, 'Delivered')
  const carried = completedRows(d).filter((r) => r._invoiceStatus || r._autoInvoice).length
  record('W-D', 'A Dispatcher\'s rows carry neither field', 'none', String(carried), carried === 0)
  await closeWorld(d)
  wireStep()
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`invoice-status --world: ${passed}/${rows.length} PASS, ${rows.length - passed} FAIL (no browser)`)
  process.exit(passed === rows.length ? 0 : 1)
}

async function main() {
  if (WORLD_ONLY) return worldCheck()
  if (ASKED_PORT && await portInUse(ASKED_PORT)) die(`port ${ASKED_PORT} is in use (another e2e server?): set E2E_PORT to a free one`)
  const server = http.createServer(serveDist)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ASKED_PORT, HOST, resolve) })
  PORT = server.address().port
  if (PORT === 3000 || PORT === 5173) { server.close(); die(`the system picked port ${PORT}: set E2E_PORT to a free one`) }
  BASE = `http://${HOST}:${PORT}`
  console.log(`invoice-status: serving ${DIST} on ${BASE} (made-up data; no server.js, no mailbox)`)
  const browser = await chromium.launch({ executablePath: await paths.chromePath(), headless: !HEADED })
  try {
    for (const size of [DESKTOP, PHONE]) {
      for (const [name, run] of [['E', statusRun], ['F', filterRun], ['A', actionRun], ['P', passRun], ['K', killedRun], ['D', dispatcherRun]]) {
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

  const resultsFile = path.join(paths.workDir(), 'results-invoice-status.md')
  const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const out = [
    '# One invoice status on each completed load: what a Super Admin sees', '',
    `Build: ${DIST}. Made-up data only. ${new Date().toISOString()}`, '',
    '| Step | Check | Expected | Observed | Verdict | Screenshot |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.step} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${r.shot ? path.basename(r.shot) : ''} |`),
    '', `Other writes sent by the page (not part of the verdict): ${otherWrites.length ? otherWrites.join('; ') : 'none'}`,
    '', `Endpoints answered with {} (not part of the verdict): ${[...unanswered].sort().join(', ') || 'none'}`,
    '', `Page errors (not part of the verdict): ${pageErrors.length ? pageErrors.join('; ') : 'none'}`, '',
  ].join('\n')
  fs.writeFileSync(resultsFile, out, { mode: 0o600 })
  const passed = rows.filter((r) => r.verdict === 'PASS').length
  console.log(`invoice-status: ${passed}/${rows.length} PASS, ${rows.length - passed} FAIL; results ${resultsFile}; screenshots ${SHOT_DIR}`)
  if (pageErrors.length) console.log(`invoice-status: page errors: ${pageErrors.join(' | ')}`)
  process.exit(passed === rows.length ? 0 : 1)
}

main().catch((e) => {
  console.error(`invoice-status: aborted: ${e.stack || e}`)
  process.exit(1)
})
