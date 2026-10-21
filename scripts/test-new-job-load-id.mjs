#!/usr/bin/env node
// New Job holds a new Load ID to the rule the load's own pages open it by.
//
// WHY. The New Job form (POST /api/data on Job Tracking) accepted a Load ID with
// a space inside ("QA-R11B 555-010-0199"). The load's own pages refuse one: GET
// /api/loads/:loadId/status-history and /haul answer 400 "Invalid load id" and
// GET /api/loads/:loadId/ratecon.pdf answers RATECON_BAD_LOAD_ID, so the new
// load's details dialog half-loaded. One rule now holds for the create and the
// pages, and the pages' rule is not changed.
//
//   §1 lib/load-id-rule.js is the pages' rule: its two patterns are the ones
//      status-history, haul (server.js) and ratecon.pdf
//      (lib/ratecon-pdf-route.js) test, read out of their source; on a battery
//      of IDs it opens exactly what all three routes open, after trimming.
//   §2 client/src/lib/loadIdRule.js is the same rule: same patterns, message
//      and answers; the field message is blank for a blank field or an ID that
//      opens, and the rule's message otherwise.
//   §3 POST /api/data, lifted from server.js and run against a fake sheet: on
//      Job Tracking a Load ID the pages refuse is answered 400 INVALID_LOAD_ID
//      naming the column, with nothing appended or audited; edge spaces are
//      trimmed before the append; an ID that opens is appended as sent; a blank
//      Load ID and another tab are not judged by this rule.
//   §4 NewJobView.vue uses the client rule: the message under the Load ID
//      field, Create Job disabled while it shows, and submit() refusing before
//      the POST.
//
// Pure: no server, no database, no network. Made-up load IDs.
//   node scripts/test-new-job-load-id.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const require = createRequire(import.meta.url)
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
const RATECON_ROUTE_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'ratecon-pdf-route.js'), 'utf8')
const VIEW_SRC = fs.readFileSync(path.join(ROOT, 'client', 'src', 'views', 'NewJobView.vue'), 'utf8')

let pass = 0
const failures = []
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg) }
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1) }
function section(title) { console.log(`\n${title}`) }

const rule = require(path.join(ROOT, 'lib', 'load-id-rule.js'))
const clientRule = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'loadIdRule.js')).href)

// ── lift the shipped code ───────────────────────────────────────────────────
function liftRoute(src, head) {
  const needle = `\n${head}`
  const hits = src.split(needle).length - 1
  if (hits !== 1) die(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`)
  const a = src.indexOf(needle) + 1
  const end = src.indexOf('\n});', a)
  if (end < 0) die(`no column-0 "});" after ${head}`)
  return src.slice(a, end + '\n});'.length)
}
// The one pattern a per-load route tests its trimmed id against.
function routePattern(routeSrc, label) {
  const found = [...routeSrc.matchAll(/!rawId \|\| !\/(.+?)\/\.test\(rawId\)/g)]
  if (found.length !== 1) die(`${label}: expected exactly 1 "!rawId || !/.../.test(rawId)" check, found ${found.length}`)
  return found[0][1]
}

const STATUS_HISTORY = liftRoute(SRC, 'app.get("/api/loads/:loadId/status-history", requireAuth, async (req, res) => {')
const HAUL = liftRoute(SRC, 'app.get("/api/loads/:loadId/haul", requireAuth, haulLimiter, async (req, res) => {')
const POST_DATA = liftRoute(SRC, 'app.post("/api/data", requireRole("Super Admin"), async (req, res) => {')

const statusHistorySource = routePattern(STATUS_HISTORY, 'status-history')
const haulSource = routePattern(HAUL, 'haul')
const rateconMatch = RATECON_ROUTE_SRC.match(/\nconst LOAD_ID_RE = \/(.+?)\/;\n/)
if (!rateconMatch) die('could not find "const LOAD_ID_RE = /.../;" in lib/ratecon-pdf-route.js')
const rateconSource = rateconMatch[1]
if (!/if \(!LOAD_ID_RE\.test\(raw\)\) return refuse\(res, 400, "RATECON_BAD_LOAD_ID"/.test(RATECON_ROUTE_SRC)) {
  die('lib/ratecon-pdf-route.js no longer refuses an id failing LOAD_ID_RE with RATECON_BAD_LOAD_ID')
}

// The routes' own patterns, as the routes build them.
const STATUS_HISTORY_RE = new RegExp(statusHistorySource)
const HAUL_RE = new RegExp(haulSource)
const RATECON_RE = new RegExp(rateconSource)
const pagesOpen = (raw) => {
  const id = String(raw).trim()
  return !!id && STATUS_HISTORY_RE.test(id) && HAUL_RE.test(id) && RATECON_RE.test(id)
}

const SAMPLES = [
  // [id, opens]
  ['QA-R11B 555-010-0199', false],
  ['LD 7001', false],
  ['LD-7001', true],
  ['  LD-7001  ', true],
  ['\tLD-7001\r\n', true],
  ['#30080873', true],
  ['30080873', true],
  ['209875716', true],
  ['LD_7001.2-B', true],
  ['A#1', false],
  ['LD-7001#', false],
  ['##7001', false],
  ['-7001', false],
  ['.7001', false],
  ['_7001', false],
  ['.', false],
  ['..', false],
  ['#', false],
  ['LD/7001', false],
  ['LD\\7001', false],
  ['LD+7001', false],
  ['LD-7001-$700', false],
  ['LÖAD-7001', false],
  ['LD 7001', false],
  ['x'.repeat(40), true],
  ['x'.repeat(41), false],
  ['#' + 'x'.repeat(39), true],
  ['#' + 'x'.repeat(40), false],
  ['', false],
  ['   ', false],
]

// ═══════════════════════════════════════════════════════════════ §1
section('§1 lib/load-id-rule.js is the rule the load pages open a load by')
ok(statusHistorySource === haulSource, `§1 status-history and haul test one pattern (got ${statusHistorySource} vs ${haulSource})`)
ok(rule.LOAD_ROUTE_ID_RE.source === statusHistorySource, `§1 LOAD_ROUTE_ID_RE is the per-load routes' pattern (got ${rule.LOAD_ROUTE_ID_RE.source} vs ${statusHistorySource})`)
ok(rule.RATECON_PDF_ID_RE.source === rateconSource, `§1 RATECON_PDF_ID_RE is ratecon.pdf's pattern (got ${rule.RATECON_PDF_ID_RE.source} vs ${rateconSource})`)
ok(rule.LOAD_ROUTE_ID_RE.flags === '' && rule.RATECON_PDF_ID_RE.flags === '', '§1 neither pattern carries a flag the routes do not')
for (const [id, opens] of SAMPLES) {
  ok(pagesOpen(id) === opens, `§1 fixture: the routes ${opens ? 'open' : 'refuse'} ${JSON.stringify(id)}`)
  ok(rule.loadIdOpenable(id) === opens, `§1 loadIdOpenable(${JSON.stringify(id)}) is ${opens} (got ${rule.loadIdOpenable(id)})`)
  const refusal = rule.newLoadIdRefusal(id, 'Load ID')
  ok(opens ? refusal === null : (refusal && refusal.code === 'INVALID_LOAD_ID' && refusal.field === 'Load ID' && refusal.error === rule.LOAD_ID_RULE_MESSAGE),
    `§1 newLoadIdRefusal(${JSON.stringify(id)}) ${opens ? 'is null' : 'is 400 INVALID_LOAD_ID with the rule message'} (got ${JSON.stringify(refusal)})`)
}
ok(rule.trimLoadId('  LD-7001 ') === 'LD-7001' && rule.trimLoadId(30080873) === '30080873' && rule.trimLoadId(null) === '' && rule.trimLoadId({}) === '' && rule.trimLoadId(['LD-7001']) === '',
  '§1 trimLoadId trims text, reads a number as its digits, and anything else as blank')
ok(rule.loadIdOpenable(30080873) === true && rule.loadIdOpenable({ toString: () => 'LD-7001' }) === false,
  '§1 a number Load ID opens; an object never does')
ok(/no spaces/.test(rule.LOAD_ID_RULE_MESSAGE) && /40 characters/.test(rule.LOAD_ID_RULE_MESSAGE),
  `§1 the message names the spaces and the length (got ${JSON.stringify(rule.LOAD_ID_RULE_MESSAGE)})`)

// ═══════════════════════════════════════════════════════════════ §2
section('§2 client/src/lib/loadIdRule.js is the same rule')
ok(clientRule.LOAD_ROUTE_ID_RE.source === rule.LOAD_ROUTE_ID_RE.source && clientRule.RATECON_PDF_ID_RE.source === rule.RATECON_PDF_ID_RE.source,
  '§2 the client copy has the same two patterns')
ok(clientRule.LOAD_ID_RULE_MESSAGE === rule.LOAD_ID_RULE_MESSAGE, '§2 the client copy has the same message')
for (const [id, opens] of SAMPLES) {
  ok(clientRule.loadIdOpenable(id) === opens, `§2 client loadIdOpenable(${JSON.stringify(id)}) is ${opens}`)
  ok(clientRule.trimLoadId(id) === rule.trimLoadId(id), `§2 client trimLoadId(${JSON.stringify(id)}) matches the server's`)
  const expected = !String(id).trim() || opens ? '' : rule.LOAD_ID_RULE_MESSAGE
  ok(clientRule.loadIdFieldMessage(id) === expected, `§2 loadIdFieldMessage(${JSON.stringify(id)}) is ${expected ? 'the rule message' : 'blank'} (got ${JSON.stringify(clientRule.loadIdFieldMessage(id))})`)
}

// ═══════════════════════════════════════════════════════════════ §3
section('§3 POST /api/data — a Job Tracking Load ID the pages refuse is answered 400, nothing appended')
const HEADERS = ['Load ID', 'Contract ID', 'Driver', 'Status', 'Payment', 'Pickup Appointment', 'Assigned Date']
const IDX = Object.fromEntries(HEADERS.map((h, i) => [h, i]))
const row = (over = {}) => HEADERS.map((h) => (h in over ? over[h] : ''))

function mountPostData({ sheet = 'Job Tracking', guarded = true } = {}) {
  const rows = [HEADERS.slice(), row({ 'Load ID': 'LD-1001', Status: 'Unassigned' })]
  const writes = []
  const audits = []
  const sheets = {
    spreadsheets: {
      values: {
        get: async ({ range }) => ({ data: { values: /!1:1$/.test(range) ? [rows[0].slice()] : rows.map((r) => r.slice()) } }),
        append: async ({ range, requestBody }) => {
          writes.push({ range, row: requestBody.values[0].slice() })
          return { data: { updates: { updatedRange: `${range}!A${rows.length + 1}:G${rows.length + 1}` } } }
        },
      },
    },
  }
  let handler = null
  const env = {
    app: { post: (p, gate, h) => { handler = h } },
    requireRole: () => null,
    loadIdRule: rule,
    DRIVER_AVAILABILITY_ENABLED: false,
    getSheets: async () => sheets,
    SPREADSHEET_ID: 'sheet-under-test',
    getSheetName: () => sheet,
    resolveSheetTargetForWrite: async () => ({ resolved: true, metaUnreadable: false, title: sheet, guarded }),
    boundAddressForStorage: (v) => ({ value: v, tooLong: false }),
    ADDRESS_MAX_CHARS: 500,
    validateOwnerIdCell: () => null,
    a1SheetPrefix: (name) => `'${String(name).replace(/'/g, "''")}'`,
    driverCellRefusal: () => null,
    brokerContact: { contactNotAllowedRefusal: () => null },
    changedGuardedCells: () => [],
    sheetRowUpdateBlocker: () => null,
    guardedColumnReason: () => '',
    buildSheetUpdateAudit: (o) => o,
    sheetAuditWithCode: (d) => d,
    logAudit: (req, action) => { audits.push(action) },
    logAuditRefusal: (req, action) => { audits.push(action) },
    upsertLoadCoordsStmt: { run: () => {} },
    console: { error() {}, log() {}, warn() {} },
  }
  const names = Object.keys(env)
  new Function(...names, POST_DATA)(...names.map((k) => env[k]))
  if (typeof handler !== 'function') die('the lifted POST /api/data route did not register a handler')
  const run = async (body) => {
    const out = { code: 200, body: null }
    const res = { status(c) { out.code = c; return this }, json(b) { out.body = b; return this } }
    await handler({ query: {}, body, session: { user: { id: 1, role: 'Super Admin', username: 'super_admin' } } }, res)
    return out
  }
  return { run, writes, audits }
}

for (const id of ['QA-R11B 555-010-0199', 'LD 7001', 'A#1', '-7001', 'x'.repeat(41), 'LD/7001']) {
  const app = mountPostData()
  const r = await app.run({ values: row({ 'Load ID': id, Status: 'Unassigned' }) })
  const b = r.body || {}
  ok(r.code === 400 && b.code === 'INVALID_LOAD_ID' && b.field === 'Load ID' && b.error === rule.LOAD_ID_RULE_MESSAGE,
    `§3 Load ID ${JSON.stringify(id)}: 400 INVALID_LOAD_ID naming "Load ID", with the rule message (got ${r.code} ${JSON.stringify(b)})`)
  ok(app.writes.length === 0 && app.audits.length === 0,
    `§3 Load ID ${JSON.stringify(id)}: nothing appended or audited (got ${app.writes.length} appends, ${JSON.stringify(app.audits)})`)
}
for (const [label, sent, stored] of [
  ['an ID that opens', 'LD-7001', 'LD-7001'],
  ['an ID that opens, with a # in front', '#30080873', '#30080873'],
  ['an ID padded with spaces', '  LD-7002  ', 'LD-7002'],
  ['an ID padded with a tab and a line break', '\tLD-7003\r\n', 'LD-7003'],
]) {
  const app = mountPostData()
  const r = await app.run({ values: row({ 'Load ID': sent, Status: 'Unassigned', Payment: '1500' }) })
  const w = app.writes[0] || { row: [] }
  ok(r.code === 200 && app.writes.length === 1 && w.row[IDX['Load ID']] === stored && w.row[IDX.Payment] === '1500' && w.row[IDX.Status] === 'Unassigned',
    `§3 ${label}: 200, appended with Load ID ${JSON.stringify(stored)} and the other cells as sent (got ${r.code} ${JSON.stringify(r.body)}, ${JSON.stringify(w.row)})`)
  ok(JSON.stringify(app.audits) === '["create_sheet_row"]', `§3 ${label}: the create audited as before (got ${JSON.stringify(app.audits)})`)
}
{
  // A blank Load ID is not a Load ID the pages could be asked to open; the New
  // Job form asks for one before it posts. Not judged by this rule.
  const app = mountPostData()
  const r = await app.run({ values: row({ 'Load ID': '', Status: 'Unassigned' }) })
  ok(r.code === 200 && app.writes.length === 1, `§3 a blank Load ID: not judged by this rule, appended as before (got ${r.code} ${JSON.stringify(r.body)})`)
}
{
  // Another tab is not a load list; its cells are not judged.
  const app = mountPostData({ sheet: 'Payments Table', guarded: false })
  const r = await app.run({ values: row({ 'Load ID': 'QA-R11B 555-010-0199' }) })
  const w = app.writes[0] || { row: [] }
  ok(r.code === 200 && app.writes.length === 1 && w.row[IDX['Load ID']] === 'QA-R11B 555-010-0199',
    `§3 another tab: not judged, appended as sent (got ${r.code} ${JSON.stringify(r.body)}, ${JSON.stringify(w.row)})`)
}

// ═══════════════════════════════════════════════════════════════ §4
section('§4 NewJobView.vue applies the client rule')
const script = (VIEW_SRC.match(/<script setup>([\s\S]*?)<\/script>/) || [])[1] || ''
const template = (VIEW_SRC.match(/^<template>([\s\S]*)^<\/template>/m) || [])[1] || ''
const submitBody = (script.match(/\nasync function submit\(\) \{([\s\S]*?)\n\}\n/) || [])[1] || ''
ok(/import \{[^}]*\bloadIdFieldMessage\b[^}]*\} from '\.\.\/lib\/loadIdRule'/.test(script), '§4 the view imports loadIdFieldMessage from lib/loadIdRule')
ok(/const loadIdProblem = computed\(\(\) => loadIdFieldMessage\(form\.loadId\)\)/.test(script), '§4 loadIdProblem is the field message for form.loadId')
ok(/<div v-if="loadIdProblem"[^>]*class="field-error"[^>]*>\{\{ loadIdProblem \}\}<\/div>/.test(template), '§4 the message shows under the Load ID field')
ok(/:disabled="submitting \|\| !form\.loadId\.trim\(\) \|\| !!loadIdProblem"/.test(template), '§4 Create Job is disabled while the message shows')
const guardAt = submitBody.indexOf('if (loadIdProblem.value) {')
const postAt = submitBody.indexOf('api.post(')
ok(guardAt >= 0 && postAt > guardAt && /if \(loadIdProblem\.value\) \{\s*errorMsg\.value = loadIdProblem\.value\s*return\s*\}/.test(submitBody),
  '§4 submit() refuses with the message before the POST')

if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`)
  console.error(`\n${pass} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`\n${pass} passed, 0 failed`)
