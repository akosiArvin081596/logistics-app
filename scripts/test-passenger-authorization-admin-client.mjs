#!/usr/bin/env node
// The Super Admin page for passenger authorizations (PASSENGER_AUTHORIZATION_ENABLED): the
// logic in client/src/lib/passengerAuthorizationAdmin.js, and how
// PassengerAuthorizationsView.vue, the router and AppSidebar.vue use it.
//
// The server is the gate (scripts/test-passenger-authorization-routes.js): every admin
// route is Super Admin only, answers 404 FEATURE_OFF while the flag is off, and decides
// whether a row can still be signed, declined or revoked. The page only shows what it is
// sent and checks a form before the round trip:
//   §1 the lib: the tabs cover each displayStatus once; a row shows only under its tab and
//      offers only its own actions; the words; the countersign and reason checks and the
//      bodies they send; which answers re-read the list; the error words
//   §2 parity with the server: the bounds, the views, the routes and the live event are
//      the server's
//   §3 the page: actions only where the lib allows them; the checks before each post;
//      the bodies and URLs; one state object per dialog, replaced on open and close, and
//      a click that keeps its own; an old tab's late answer dropped; the PDF opened in a
//      new tab without an opener; nothing stored or logged; no role test; it compiles
//   §3b the page, mounted: while a countersign, decline or revoke is out, its dialog
//      can't be closed (Cancel, the X, Escape, a click outside), says it is being sent,
//      sends once, and no row offers an action; the answer closes the dialog (it
//      landed) or unlocks it with its words (refused, or no answer)
//   §4 the route and the sidebar: Super Admin only; the entry under Applications, for
//      no other role, shown only when the feature says true, asked by a Super Admin only
//   §5 flag off: the page says so and lists nothing; the sidebar hides the entry
//   §6 mutants: copies of the lib and the screens with one rule changed must each be
//      caught by the sections above
//
// Made-up people only. No DOM (§3b uses an in-memory renderer), no server, no build.
//   node scripts/test-passenger-authorization-admin-client.mjs      # exits 1 on any failure
//   PA_ADMIN_VIEW_VUE=<a copy of the page> node scripts/test-passenger-authorization-admin-client.mjs   # e.g. a base copy
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = path.join(ROOT, 'client', 'src')
const LIB = path.join(CLIENT_SRC, 'lib', 'passengerAuthorizationAdmin.js')
const FILES = {
  view: process.env.PA_ADMIN_VIEW_VUE || path.join(CLIENT_SRC, 'views', 'PassengerAuthorizationsView.vue'),
  router: path.join(CLIENT_SRC, 'router', 'index.js'),
  sidebar: path.join(CLIENT_SRC, 'components', 'layout', 'AppSidebar.vue'),
}

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const S0 = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, read(p)]))
const LIB_SRC = read(LIB)
// The lib's two imports, made absolute so a mutant copy loaded from a data: URL finds them.
const absImports = (src) => src
  .replace("from './signingConsent.js'", `from '${pathToFileURL(path.join(CLIENT_SRC, 'lib', 'signingConsent.js')).href}'`)
  .replace("from '../utils/datetime.js'", `from '${pathToFileURL(path.join(CLIENT_SRC, 'utils', 'datetime.js')).href}'`)
const scriptOf = (src) => (src.match(/^<script setup>([\s\S]*?)^<\/script>/m) || [])[1] || ''
const templateOf = (src) => src.slice(0, Math.max(0, src.indexOf('\n<script')))
// Comments are dropped until none is left, so a comment inside a comment can't hide code.
const stripComments = (s) => {
  for (let prev = null; prev !== s;) {
    prev = s
    for (let p = null; p !== s;) { p = s; s = s.replace(/<!--[\s\S]*?-->/g, '') }
    for (let p = null; p !== s;) { p = s; s = s.replace(/\/\*[\s\S]*?\*\//g, '') }
  }
  return s.replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}
const count = (s, needle) => s.split(needle).length - 1

// ── reporting ────────────────────────────────────────────────────────────────
// The main run prints every result; a mutant run only counts what failed.
let pass = 0
let fail = 0
function checker(print) {
  const c = { failed: [] }
  c.eq = (name, actual, expected) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) { if (print) { pass++; console.log(`  ok    ${name}`) } return }
    c.failed.push(name)
    if (print) { fail++; console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`) }
  }
  c.ok = (name, cond) => c.eq(name, !!cond, true)
  return c
}
const MAIN = checker(true)
// A throw (a missing export on the old code) is that section's failure, never a crash.
async function section(c, label, fn) {
  try { await fn() } catch (err) { c.eq(`${label} ran`, `threw: ${err && err.message}`, 'no throw') }
}

// Made-up rows, one per displayStatus.
const row = (id, displayStatus, extra = {}) => ({
  id, reference: `PA-0000ABC${id}`, displayStatus, driverName: 'Casey Example', passengerName: 'Jane Example',
  passengerAdult: true, guardianName: '', guardianRelationship: '', truckUnit: 'T-0000',
  tripStart: 'Houston, TX', tripEnd: 'Dallas, TX', validFrom: '2026-11-02', expiresOn: '2026-11-09', ...extra,
})
const ROWS = [
  row(1, 'awaiting_company'), row(2, 'scheduled'), row(3, 'active'),
  row(4, 'expired'), row(5, 'declined'), row(6, 'revoked'),
]
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
const goodForm = { printedName: '  Sam Example ', title: ' Safety Manager ', agreed: true, signatureImage: PNG }
const apiError = (status, code = '') => Object.assign(new Error('x'), { status, code })

// ── §1 the lib ───────────────────────────────────────────────────────────────
function libSection(c, L) {
  const statuses = L.TABS.flatMap((t) => t.statuses)
  c.eq('§1 three tabs, in order', L.TABS.map((t) => [t.key, t.label]), [['waiting', 'Waiting'], ['authorized', 'Authorized'], ['ended', 'Ended']])
  c.eq('§1 each displayStatus belongs to exactly one tab', [...statuses].sort(), ['active', 'awaiting_company', 'declined', 'expired', 'revoked', 'scheduled'])
  c.eq('§1 a row shows only under its own tab', ['waiting', 'authorized', 'ended'].map((t) => L.rowsForTab(ROWS, t).map((r) => r.id)), [[1], [2, 3], [4, 5, 6]])
  c.eq('§1 rowsForTab() drops what is not a row', L.rowsForTab([null, 'x', [], { displayStatus: 'awaiting_company' }], 'waiting').length, 1)
  c.eq('§1 rowsForTab() of nothing is empty', [L.rowsForTab(undefined, 'waiting'), L.rowsForTab(null, 'ended')], [[], []])
  c.eq('§1 an unknown tab is the waiting tab', [L.tabKey('x'), L.tabKey(undefined), L.tabKey('ended'), L.tabKey('__proto__')], ['waiting', 'waiting', 'ended', 'waiting'])
  c.eq('§1 the list URL names one of the three views only',
    [L.listUrl('waiting'), L.listUrl('authorized'), L.listUrl('ended'), L.listUrl('all&x=1')],
    ['/api/admin/passenger-authorizations?view=waiting', '/api/admin/passenger-authorizations?view=authorized',
      '/api/admin/passenger-authorizations?view=ended', '/api/admin/passenger-authorizations?view=waiting'])
  c.eq('§1 the row URLs', [L.pdfUrl(7), L.countersignUrl(7), L.declineUrl(7), L.revokeUrl(7)],
    ['/api/passenger-authorizations/7/pdf', '/api/admin/passenger-authorizations/7/countersign',
      '/api/admin/passenger-authorizations/7/decline', '/api/admin/passenger-authorizations/7/revoke'])
  c.eq('§1 the row URLs encode what they are handed', [L.pdfUrl('../x'), L.countersignUrl('1/2')],
    ['/api/passenger-authorizations/..%2Fx/pdf', '/api/admin/passenger-authorizations/1%2F2/countersign'])
  c.eq('§1 actions: sign and decline while waiting; revoke while in force or starting later; none once ended',
    ROWS.map((r) => L.actionsFor(r)).map((a) => [a.countersign, a.decline, a.revoke]),
    [[true, true, false], [false, false, true], [false, false, true], [false, false, false], [false, false, false], [false, false, false]])
  c.eq('§1 no actions for an unknown status or no row', [L.actionsFor({ displayStatus: 'authorized' }), L.actionsFor(null)],
    [{ countersign: false, decline: false, revoke: false }, { countersign: false, decline: false, revoke: false }])
  c.eq('§1 the status words', ROWS.map(L.statusText), [
    'Waiting for company signature', 'Authorized, starts Nov 2, 2026', 'Authorized until Nov 9, 2026',
    'Expired Nov 9, 2026', 'Declined', 'Revoked'])
  c.eq('§1 the passenger words: adult, minor with the guardian',
    [L.passengerText(row(1, 'awaiting_company')), L.passengerText(row(1, 'awaiting_company', { passengerName: 'Riley Example', passengerAdult: false, guardianName: 'Pat Example', guardianRelationship: 'Parent' }))],
    ['Adult (18 or older)', 'Minor; signed by Parent Pat Example'])
  c.eq('§1 the trip and the dates', [L.tripText(ROWS[0]), L.datesText(ROWS[0])], ['Houston, TX → Dallas, TX', 'Nov 2, 2026 to Nov 9, 2026'])
  const signedBy = { companyPrintedName: 'Sam Example', companyTitle: 'Safety Manager', companySignedOn: 'November 3, 2026' }
  c.eq('§1 who signed, declined or ended it, and why',
    [L.decisionText(row(1, 'awaiting_company', { status: 'awaiting_company' })),
      L.decisionText(row(3, 'active', { status: 'authorized', ...signedBy })),
      L.decisionText(row(4, 'expired', { status: 'authorized', ...signedBy })),
      L.decisionText(row(4, 'expired', { status: 'awaiting_company' })),
      L.decisionText(row(5, 'declined', { status: 'declined', decidedBy: 'admin_example', decidedReason: 'Trip cancelled' })),
      L.decisionText(row(6, 'revoked', { status: 'revoked', ...signedBy, decidedBy: 'admin_example', decidedReason: 'Rider changed' })),
      L.decisionText(null)],
    ['', 'Signed by Sam Example, Safety Manager, November 3, 2026', 'Signed by Sam Example, Safety Manager, November 3, 2026',
      'Expired before the company signed.', 'Declined by admin_example: Trip cancelled',
      'Signed by Sam Example, Safety Manager, November 3, 2026. Revoked by admin_example: Rider changed', ''])

  // The countersign form.
  c.eq('§1 a full form has no problem', L.countersignProblem(goodForm), '')
  const name = (n) => L.countersignProblem({ ...goodForm, printedName: n }) === '' ? 'ok' : 'refused'
  c.eq('§1 the printed name: 2 to 100 characters after trimming',
    [name('S'), name(' Sa '), name('x'.repeat(100)), name('x'.repeat(101)), name(undefined), name(7)],
    ['refused', 'ok', 'ok', 'refused', 'refused', 'refused'])
  c.eq('§1 counted as the server counts: characters, whitespace runs folded',
    [name('é'.repeat(100)), name('😀'.repeat(100)), name(`${'x'.repeat(50)}     ${'x'.repeat(49)}`), name(' \n ')],
    ['ok', 'ok', 'ok', 'refused'])
  const title = (t) => L.countersignProblem({ ...goodForm, title: t }) === '' ? 'ok' : 'refused'
  c.eq('§1 the title: 2 to 60 characters after trimming',
    [title('M'), title(' Mg '), title('x'.repeat(60)), title('x'.repeat(61)), title(null)],
    ['refused', 'ok', 'ok', 'refused', 'refused'])
  c.eq('§1 the consent must be ticked (a real true)',
    [false, 'true', 1, undefined].map((a) => L.countersignProblem({ ...goodForm, agreed: a })),
    Array(4).fill('Tick the box to agree before you sign.'))
  c.eq('§1 a drawn PNG signature is required',
    ['', null, 'data:image/svg+xml;base64,PHN2Zz4=', 'https://example.com/s.png', `${PNG}"onerror`].map((s) => L.countersignProblem({ ...goodForm, signatureImage: s })),
    Array(5).fill('Draw your signature in the box.'))
  c.eq('§1 the countersign body: trimmed text, the image, the consent object',
    L.countersignPayload(goodForm),
    { printedName: 'Sam Example', title: 'Safety Manager', signatureImage: PNG, consent: { agreed: true, text: 'I have read and agree to the terms of this document' } })
  c.eq('§1 the body never turns a truthy tick into consent', L.countersignPayload({ ...goodForm, agreed: 'yes' }).consent.agreed, false)
  c.eq('§1 the body folds whitespace as the server does', L.countersignPayload({ ...goodForm, printedName: ' Sam \n  Example ' }).printedName, 'Sam Example')
  c.eq('§1 the body carries only the four fields',
    Object.keys(L.countersignPayload({ ...goodForm, row: { id: 1 }, busy: true, open: true })).sort(), ['consent', 'printedName', 'signatureImage', 'title'])

  // Decline and revoke.
  const reason = (t) => L.reasonProblem(t) === '' ? 'ok' : 'refused'
  c.eq('§1 the reason: 2 to 300 characters after trimming',
    [reason(' x '), reason('No'), reason('x'.repeat(300)), reason('x'.repeat(301)), reason(undefined)],
    ['refused', 'ok', 'ok', 'refused', 'refused'])
  c.eq('§1 the reason body is the trimmed text', L.reasonPayload('  Trip cancelled  '), { reason: 'Trip cancelled' })

  // Answers.
  c.eq('§1 the list is read again after: decided elsewhere, not revocable, expired, gone, switched off, no answer',
    [apiError(409, 'ALREADY_DECIDED'), apiError(409, 'NOT_REVOCABLE'), apiError(409, 'AUTHORIZATION_EXPIRED'), apiError(404, 'NOT_FOUND'), apiError(404, 'FEATURE_OFF'),
      apiError(0, 'TIMEOUT'), apiError(0, '')].map(L.reloadAfter),
    [true, true, true, true, true, true, true])
  c.eq('§1 ...and not after a refusal of the form, a failed render, a busy server or an incomplete row',
    [apiError(400, 'CONSENT_REQUIRED'), apiError(400, 'PRINTED_NAME_REQUIRED'), apiError(503, 'RENDER_FAILED'), apiError(429, 'RATE_LIMITED'), apiError(409, 'AUTHORIZATION_INCOMPLETE'), null].map(L.reloadAfter),
    [false, false, false, false, false, false])
  const words = [apiError(404, 'FEATURE_OFF'), apiError(409, 'ALREADY_DECIDED'), apiError(409, 'NOT_REVOCABLE'), apiError(409, 'AUTHORIZATION_EXPIRED'),
    apiError(409, 'AUTHORIZATION_INCOMPLETE'), apiError(400, 'PRINTED_NAME_REQUIRED'), apiError(400, 'TITLE_REQUIRED'), apiError(400, 'REASON_REQUIRED'),
    apiError(400, 'CONSENT_REQUIRED'), apiError(400, 'SIGNATURE_REQUIRED'), apiError(0, 'TIMEOUT'), apiError(404), apiError(413, 'IMAGE_TOO_LARGE'),
    apiError(429), apiError(503), apiError(400, 'X'), apiError(500)].map(L.actionErrorText)
  c.ok('§1 every refusal has its own plain words', words.every((w) => typeof w === 'string' && w.length > 10) && new Set(words).size === words.length)
  c.eq('§1 a code\'s words win over its status; an unknown code falls back to the status',
    [L.actionErrorText(apiError(404, 'FEATURE_OFF')), L.actionErrorText(apiError(0, 'X')), L.actionErrorText(apiError(429, 'X'))],
    ['Passenger authorizations are switched off on this server.', L.actionErrorText(apiError(0, 'TIMEOUT')), L.actionErrorText(apiError(429, 'RATE_LIMITED'))])
  c.ok('§1 a 503 says nothing was signed', /Nothing was signed/.test(L.actionErrorText(apiError(503))))
  c.ok('§1 no answer says to check before trying again', /check whether the change went through/.test(L.actionErrorText(apiError(0, 'TIMEOUT'))))
  c.eq('§1 the list errors', [L.listErrorText(apiError(404, 'FEATURE_OFF')), L.listErrorText(apiError(0, 'TIMEOUT')), L.listErrorText(apiError(500))],
    ['Passenger authorizations are switched off on this server.', 'No answer from the server.', 'Could not load passenger authorizations.'])
}

// ── §2 parity with the server ────────────────────────────────────────────────
const require = createRequire(import.meta.url)
const SERVER_LIB = path.join(ROOT, 'lib', 'passenger-authorization.js')
const SV_SRC = read(SERVER_LIB)
let SV = null
try { SV = require(SERVER_LIB) } catch { SV = null }
// The server's three lists, as its source writes them: { key: where clause }.
const serverViews = () => Object.fromEntries([...SV_SRC.matchAll(/^\t\t(\w+): \{ where: "([^"]+)", params: \(t\) => \[t\] \},$/gm)].map((m) => [m[1], m[2]]))

function paritySection(c, L, S) {
  if (!SV) { c.eq('§2 lib/passenger-authorization.js loads', false, true); return }
  c.eq('§2 the printed name, title and reason bounds are the server\'s',
    [L.PRINTED_NAME_MIN, L.PRINTED_NAME_MAX, L.TITLE_MIN, L.TITLE_MAX, L.REASON_MIN, L.REASON_MAX],
    [SV.LIMITS.nameMin, SV.LIMITS.companyNameMax, SV.LIMITS.nameMin, SV.LIMITS.companyTitleMax, SV.LIMITS.nameMin, SV.LIMITS.reasonMax])
  for (const [method, route] of [['get', '/api/admin/passenger-authorizations'], ['post', '/api/admin/passenger-authorizations/:id/countersign'],
    ['post', '/api/admin/passenger-authorizations/:id/decline'], ['post', '/api/admin/passenger-authorizations/:id/revoke']]) {
    c.ok(`§2 the server registers ${method.toUpperCase()} ${route} for a Super Admin`, SV_SRC.includes(`app.${method}("${route}", requireRole("Super Admin"), `))
  }
  c.ok('§2 the PDF link is a route the server registers', SV_SRC.includes('app.get("/api/passenger-authorizations/:id/pdf", '))
  c.ok('§2 the live event is the one the server announces', L.LIVE_EVENT === 'passenger-authorizations:changed' && SV_SRC.includes('notifyChange("passenger-authorizations")'))
  c.ok('§2 the list answer carries `authorizations` and `reviewNote`', /answer\(res, 200, \{ view, authorizations: rows\.map\(\(r\) => \w+\(r, todayKey\)\), reviewNote: /.test(SV_SRC))
  // The server sends a Super Admin its admin columns, camel-cased, plus displayStatus.
  const sent = new Set([...SV.ADMIN_COLUMNS.map((col) => col.replace(/_([a-z0-9])/g, (m, ch) => ch.toUpperCase())), 'displayStatus'])
  const readByPage = [...new Set([...(LIB_SRC + scriptOf(S.view) + templateOf(S.view)).matchAll(/\b(?:row|r|sign\.row|s\.row|d\.row)\.([a-z][A-Za-z]+)\b/g)].map((m) => m[1]))]
  c.eq('§2 every field the page reads is one the server sends a Super Admin', readByPage.filter((f) => !sent.has(f)), [])
  c.ok('§2 ...and the scan found the fields it shows', ['passengerName', 'tripStart', 'decidedReason', 'companyTitle', 'displayStatus'].every((f) => readByPage.includes(f)))

  // Every code countersign, decline or revoke can answer has words of its own (not the
  // generic line). The list's VIEW_INVALID never arises: listUrl() sends the three views only.
  const admin = SV_SRC.slice(SV_SRC.indexOf('app.post("/api/admin/passenger-authorizations/:id/countersign"'))
  const codes = new Set([...admin.matchAll(/refuse\(res, \d{3}, "([A-Z_]+)"|refusal: "([A-Z_]+)"/g)].map((m) => m[1] || m[2]))
  for (const shared of ['FEATURE_OFF', 'RATE_LIMITED', 'SIGNATURE_REQUIRED', 'CONSENT_REQUIRED']) codes.add(shared)
  codes.delete('FAILED')
  const generic = L.actionErrorText(apiError(418, 'UNKNOWN_CODE'))
  const unworded = [...codes].filter((code) => L.actionErrorText(apiError(418, code)) === generic)
  c.eq(`§2 every code the three admin actions answer has words (${codes.size} codes)`, unworded, [])
  c.ok('§2 ...and the scan found the routes\' codes', ['ALREADY_DECIDED', 'NOT_REVOCABLE', 'AUTHORIZATION_EXPIRED', 'REASON_REQUIRED', 'TITLE_REQUIRED'].every((k) => codes.has(k)))

  // Each server list holds only rows whose displayStatus its tab shows, and every row is
  // in exactly one list: a row never vanishes between the server and the screen.
  const views = serverViews()
  c.eq('§2 the server\'s lists are the three tabs', Object.keys(views).sort(), L.TABS.map((t) => t.key).sort())
  const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'))
  const db = new Database(':memory:')
  try {
    SV.ensureSchema(db)
    const cols = db.prepare('PRAGMA table_info(passenger_authorizations)').all()
    const today = '2026-11-10'
    const fixtures = [
      ['awaiting_company', '2026-11-08', '2026-11-20'], ['awaiting_company', '2026-11-01', '2026-11-09'],
      ['authorized', '2026-11-12', '2026-11-20'], ['authorized', '2026-11-01', '2026-11-10'], ['authorized', '2026-11-01', '2026-11-09'],
      ['declined', '2026-11-08', '2026-11-20'], ['revoked', '2026-11-08', '2026-11-20'], ['declined', '2026-10-01', '2026-11-01'],
    ]
    fixtures.forEach(([status, from, to], i) => {
      const values = Object.fromEntries(cols.filter((col) => col.name !== 'id').map((col) => [col.name, /INT/i.test(col.type) ? 0 : '']))
      Object.assign(values, { status, valid_from: from, expires_on: to, reference: `PA-0000000${i}`, request_id: `00000000-0000-4000-8000-00000000000${i}`, passenger_adult: 1 })
      const names = Object.keys(values)
      db.prepare(`INSERT INTO passenger_authorizations (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((n) => values[n]))
    })
    const seen = []
    for (const t of L.TABS) {
      const listed = views[t.key] ? db.prepare(`SELECT * FROM passenger_authorizations WHERE ${views[t.key]}`).all(today) : []
      const shown = L.rowsForTab(listed.map((r) => ({ id: r.id, displayStatus: SV.statusOf(r, today) })), t.key)
      c.eq(`§2 every row the server lists under "${t.key}" shows under that tab`, shown.length, listed.length)
      seen.push(...listed.map((r) => r.id))
    }
    c.eq('§2 every row is in exactly one list', seen.sort((a, b) => a - b), fixtures.map((_, i) => i + 1))
  } finally {
    db.close()
  }
}

// ── §3 the page ──────────────────────────────────────────────────────────────
function pageSection(c, L, S) {
  const v = S.view
  const tpl = stripComments(templateOf(v))
  const js = stripComments(scriptOf(v))
  c.ok('§3 the page exists', v !== '')
  for (const action of ['countersign', 'decline', 'revoke']) {
    c.eq(`§3 the ${action} button shows only where actionsFor() allows it (cards and table)`, count(tpl, `v-if="actionsFor(r).${action}"`), 2)
  }
  c.eq('§3 every button that opens a dialog carries its action check',
    [count(tpl, '@click="openSign(r)"'), count(tpl, "@click=\"openReason(r, 'decline')\""), count(tpl, "@click=\"openReason(r, 'revoke')\"")], [2, 2, 2])
  c.ok('§3 rows come through rowsForTab() for the tab on screen', js.includes('const rows = computed(() => rowsForTab(listed.value, tab.value))'))
  c.ok('§3 the list is read from listUrl() of the tab', js.includes('await api.get(listUrl(tab.value))'))
  c.eq('§3 an old tab\'s late answer is dropped (after the answer and after a refusal)', count(js, 'if (mine !== seq) return'), 2)

  const signFn = (js.match(/async function submitSign\(\) \{[\s\S]*?\n\}/) || [''])[0]
  c.ok('§3 the click keeps its own state object', signFn.startsWith('async function submitSign() {\n  const s = sign.value\n'))
  c.ok('§3 the signature is read from this open\'s pad at the click, before any await',
    signFn.includes("const form = { printedName: s.printedName, title: s.title, agreed: s.agreed, signatureImage: (padRef.value && padRef.value.toDataURL()) || '' }")
    && signFn.indexOf('const form = ') < signFn.indexOf('await '))
  c.ok('§3 the countersign is checked before it is sent', signFn.indexOf('countersignProblem(form)') > 0 && signFn.indexOf('countersignProblem(form)') < signFn.indexOf('await api.post('))
  c.ok('§3 the countersign posts countersignPayload() to countersignUrl() with time for the PDF',
    signFn.includes('await api.post(countersignUrl(s.row.id), countersignPayload(form), { timeout: 60000 })'))
  c.ok('§3 a late countersign answer touches only its own dialog', count(signFn, 'if (sign.value === s)') === 2)
  c.ok('§3 the list is read again when the answer says so', signFn.includes('if (reloadAfter(err)) load()'))
  c.ok('§3 a second click while one is out sends nothing', signFn.includes('if (s.busy || !s.row) return'))

  const reasonFn = (js.match(/async function submitReason\(\) \{[\s\S]*?\n\}/) || [''])[0]
  c.ok('§3 decline and revoke keep their own state object', reasonFn.startsWith('async function submitReason() {\n  const d = decide.value\n'))
  c.ok('§3 the reason is checked before it is sent', reasonFn.indexOf('reasonProblem(d.reason)') > 0 && reasonFn.indexOf('reasonProblem(d.reason)') < reasonFn.indexOf('await api.post('))
  c.ok('§3 decline and revoke post the trimmed reason to their own URL',
    reasonFn.includes("const url = d.kind === 'revoke' ? revokeUrl(d.row.id) : declineUrl(d.row.id)") && reasonFn.includes('await api.post(url, reasonPayload(d.reason))'))
  c.ok('§3 a late decline or revoke answer touches only its own dialog', count(reasonFn, 'if (decide.value === d)') === 2)
  c.ok('§3 the dialog kind is decline unless revoke is asked for', js.includes("kind: kind === 'revoke' ? 'revoke' : 'decline'"))

  c.ok('§3 the countersign dialog is replaced whole on open (a fresh pad) and on close',
    js.includes('sign.value = { ...blankSign(), open: true, row, padKey: ++padKey }') && /function closeSign\(\) \{\n {2}sign\.value = blankSign\(\)\n\}/.test(js))
  c.ok('§3 the blank state holds no name, title or tick, and no signature is kept in state',
    js.includes("const blankSign = () => ({ open: false, row: null, printedName: '', title: '', agreed: false, padKey: 0, busy: false, error: '' })")
    && !/signatureImage/.test(js.replace("signatureImage: (padRef.value && padRef.value.toDataURL()) || ''", '')))
  c.ok('§3 the reason dialog is replaced whole on open and on close', /function closeReason\(\) \{\n {2}decide\.value = blankDecide\(\)\n\}/.test(js) && js.includes('decide.value = { ...blankDecide(), open: true,'))
  c.ok('§3 every way to close either dialog (Cancel, the X, Escape, a click outside) goes through its dismiss function',
    tpl.includes('<Dialog :open="sign.open" @update:open="(v) => { if (!v) dismissSign() }">') && tpl.includes('<Dialog :open="decide.open" @update:open="(v) => { if (!v) dismissReason() }">')
    && count(tpl, '@click="dismissSign"') === 1 && count(tpl, '@click="dismissReason"') === 1 && !/closeSign|closeReason/.test(tpl))
  c.ok('§3 the pad is remounted per open and drawable only after the tick', /<SignaturePad\s+:key="sign\.padKey"\s+ref="padRef"\s+:disabled="!sign\.agreed"/.test(tpl))
  c.ok('§3 the tick\'s words are the consent text that is sent', tpl.includes('<span>{{ SIGNING_CONSENT_TEXT }}</span>') && js.includes("import { SIGNING_CONSENT_TEXT } from '../lib/signingConsent.js'"))
  c.ok('§3 the inputs stop at the server\'s lengths', tpl.includes(':maxlength="PRINTED_NAME_MAX"') && tpl.includes(':maxlength="TITLE_MAX"') && tpl.includes(':maxlength="REASON_MAX"'))
  const links = tpl.match(/<a [^>]*pdfUrl\([^>]*>/g) || []
  c.ok('§3 every PDF link is pdfUrl() of the row, in a new tab without an opener',
    links.length === 3 && links.every((a) => a.includes('target="_blank"') && a.includes('rel="noopener noreferrer"')))
  c.ok('§3 the page reloads on the live event', js.includes('useSocketRefresh(LIVE_EVENT, () => load())'))
  c.ok('§3 nothing is kept in the browser\'s storage', !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(js))
  c.ok('§3 nothing is logged', !/console\./.test(js))
  c.ok('§3 no role is tested in the page (the route and the server decide)', !/useAuthStore|\bauth\.|\.role\b/.test(js))
}

// ── §3b the page, mounted ────────────────────────────────────────────────────
// No DOM: an in-memory renderer, with stubs for the API, toast, viewport, socket and
// shadcn pieces. reka-ui's X, Escape and a click outside all call the root's
// onOpenChange(false), which for a controlled `open` only emits update:open(false).
let VUE = null
function vue() {
  if (VUE) return VUE
  const req = createRequire(path.join(ROOT, 'client', 'package.json'))
  VUE = { Vue: req('vue'), SFC: req('vue/compiler-sfc') }
  // v-model asks whether a field's root is a Document; set after Vue, which reads `document` at load.
  globalThis.document = globalThis.document || { activeElement: null }
  globalThis.Document = globalThis.Document || class Document {}
  globalThis.ShadowRoot = globalThis.ShadowRoot || class ShadowRoot {}
  return VUE
}

// The page's script and template as one function of its imports, per source text.
const viewFactories = new Map()
function viewFactory(src) {
  if (viewFactories.has(src)) return viewFactories.get(src)
  const { SFC } = vue()
  const { descriptor } = SFC.parse(src, { filename: 'PassengerAuthorizationsView.vue' })
  let body = SFC.compileScript(descriptor, { id: 'pa-view', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
  const specs = []
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, names, q, spec) => {
    specs.push(spec)
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '))
    return `const { ${binds.join(', ')} } = __deps[${JSON.stringify(spec)}];`
  })
  body = body.replace(/^import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, name, q, spec) => {
    specs.push(spec)
    return `const ${name} = __deps[${JSON.stringify(spec)}].default;`
  })
  body = body.replace(/^export default\s*/m, 'return ')
  if (/^\s*(import|export)\s/m.test(body)) throw new Error('the page has an import or export this harness cannot map')
  const make = (deps) => {
    const missing = specs.filter((s) => !Object.prototype.hasOwnProperty.call(deps, s))
    if (missing.length) throw new Error(`no stub for ${missing.join(', ')}`)
    return new Function('__deps', body)(deps)
  }
  viewFactories.set(src, make)
  return make
}

function viewDeps({ L, consent, api, toasts, isMobile }) {
  const { Vue } = vue()
  const stub = (tag) => Vue.defineComponent({ name: tag, inheritAttrs: false, setup: (_, { attrs, slots }) => () => Vue.h(tag, { ...attrs }, slots.default ? slots.default() : []) })
  // As reka-ui's, the dialog's content is there only while it is open.
  const Dialog = Vue.defineComponent({ name: 'Dialog', inheritAttrs: false, setup: (_, { attrs, slots }) => () => Vue.h('x-dialog', { ...attrs }, attrs.open && slots.default ? slots.default() : []) })
  const SignaturePad = Vue.defineComponent({
    name: 'SignaturePad',
    props: { disabled: Boolean, label: String, hint: String },
    setup(props, { expose }) {
      expose({ toDataURL: () => PNG, reset() {} })
      return () => Vue.h('x-pad', { disabled: props.disabled })
    },
  })
  return {
    vue: Vue,
    '../composables/useApi': { useApi: () => api },
    '../composables/useSocketRefresh': { useSocketRefresh: () => {} },
    '../composables/useViewport': { useViewport: () => ({ isMobile }) },
    '../composables/useToast': { useToast: () => ({ show: (message) => toasts.push(message) }) },
    '../lib/signingConsent.js': consent,
    '../lib/passengerAuthorizationAdmin.js': L,
    '@/components/ui/table': { Table: stub('x-table'), TableHeader: stub('x-thead'), TableBody: stub('x-tbody'), TableRow: stub('x-tr'), TableHead: stub('x-th'), TableCell: stub('x-td') },
    '@/components/ui/tabs': { Tabs: stub('x-tabs'), TabsList: stub('x-tabs-list'), TabsTrigger: stub('x-tab') },
    '@/components/ui/dialog': {
      Dialog, DialogContent: stub('x-dialog-content'), DialogScrollContent: stub('x-dialog-content'), DialogHeader: stub('x-dialog-header'),
      DialogTitle: stub('x-dialog-title'), DialogDescription: stub('x-dialog-description'), DialogFooter: stub('x-dialog-footer'),
    },
    '@/components/ui/button': { Button: stub('button') },
    '../components/shared/SkeletonLoader.vue': { default: stub('x-skeleton') },
    '../components/shared/EmptyState.vue': { default: stub('x-empty') },
    '../components/shared/SignaturePad.vue': { default: SignaturePad },
  }
}

function mountInMemory(Comp) {
  const { Vue } = vue()
  const node = (type, tag) => {
    const n = {
      type, tag, children: [], parent: null, props: {}, text: '', value: '', checked: false, listeners: {},
      addEventListener(ev, fn) { (n.listeners[ev] = n.listeners[ev] || []).push(fn) },
      removeEventListener(ev, fn) { n.listeners[ev] = (n.listeners[ev] || []).filter((f) => f !== fn) },
      getRootNode() { return {} },
    }
    return Vue.markRaw(n)
  }
  const ops = {
    insert(child, parent, anchor) {
      if (child.parent) ops.remove(child)
      const i = anchor ? parent.children.indexOf(anchor) : -1
      if (i >= 0) parent.children.splice(i, 0, child); else parent.children.push(child)
      child.parent = parent
    },
    remove(child) {
      const p = child.parent
      if (!p) return
      const i = p.children.indexOf(child)
      if (i >= 0) p.children.splice(i, 1)
      child.parent = null
    },
    createElement: (tag) => node('el', tag),
    createText: (t) => Object.assign(node('text'), { text: t }),
    createComment: (t) => Object.assign(node('comment'), { text: t }),
    setText(n, t) { n.text = t },
    setElementText(el, t) { el.children = []; if (t) ops.insert(Object.assign(node('text'), { text: t }), el) },
    parentNode: (n) => n.parent,
    nextSibling(n) { const p = n.parent; if (!p) return null; return p.children[p.children.indexOf(n) + 1] || null },
    querySelector: () => null,
    setScopeId() {},
    patchProp(el, key, prev, next) { el.props[key] = next },
  }
  const warnings = []
  const root = node('el', 'root')
  const app = Vue.createRenderer(ops).createApp(Comp)
  app.config.warnHandler = (msg) => warnings.push(String(msg))
  app.mount(root)
  const textOf = (n) => (!n ? '' : n.type === 'text' ? n.text : n.type === 'el' ? n.children.map(textOf).join(' ') : '')
  const all = (n, pred, out = []) => {
    if (!n) return out
    if (n.type === 'el' && pred(n)) out.push(n)
    for (const ch of n.children || []) all(ch, pred, out)
    return out
  }
  return {
    warnings,
    findAll: (pred, from = root) => all(from, pred),
    find: (pred, from = root) => all(from, pred)[0] || null,
    text: (n) => textOf(n).replace(/\s+/g, ' ').trim(),
    unmount: () => app.unmount(),
  }
}

const drain = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }
const evt = (el) => ({ preventDefault() {}, stopPropagation() {}, target: el, currentTarget: el })
const isDisabled = (el) => !!el && el.props.disabled != null && el.props.disabled !== false
// A handler the page gave an element, called as the browser would. A send it starts is
// not awaited: it stays out until the test answers it.
function fire(p, fn, ...args) {
  for (const f of Array.isArray(fn) ? fn : [fn]) {
    if (typeof f !== 'function') continue
    const r = f(...args)
    if (r && typeof r.then === 'function') r.catch((err) => p.thrown.push(String(err && err.message)))
  }
}
// A press as the browser makes one: a disabled button takes no click.
async function press(p, el) {
  if (!el || isDisabled(el)) return
  fire(p, el.props.onClick, evt(el))
  await drain()
}
async function typeInto(el, text) {
  if (!el) return
  el.value = text
  for (const fn of el.listeners.input || []) fn(evt(el))
  await drain()
}
async function tick(el) {
  if (!el) return
  el.checked = true
  for (const fn of el.listeners.change || []) fn(evt(el))
  await drain()
}
// The X, Escape or a click outside: what reka-ui's root does for each of them.
async function dismiss(p, dialog) {
  if (dialog) fire(p, dialog.props['onUpdate:open'], false)
  await drain()
}

const SIGNED_BY = { companyPrintedName: 'Sam Example', companyTitle: 'Safety Manager', companySignedOn: 'November 3, 2026' }
const LISTS = {
  waiting: [row(1, 'awaiting_company', { status: 'awaiting_company' }), row(7, 'awaiting_company', { status: 'awaiting_company' })],
  authorized: [row(2, 'scheduled', { status: 'authorized', ...SIGNED_BY }), row(3, 'active', { status: 'authorized', ...SIGNED_BY })],
}
// Lists answer at once; each post stays out until the test answers it.
function fakeApi() {
  const api = { gets: [], posts: [] }
  api.get = async (url) => {
    api.gets.push(url)
    const view = String(url).split('view=')[1] || ''
    return { view, authorizations: Object.prototype.hasOwnProperty.call(LISTS, view) ? LISTS[view] : [], reviewNote: '' }
  }
  api.post = (url, body, opts) => new Promise((resolve, reject) => { api.posts.push({ url, body, opts, resolve, reject }) })
  return api
}
const ROW_ACTIONS = ['Sign for LogisX', 'Decline', 'Revoke']
const SENDING = {
  sign: 'Sending your signature. You can\'t cancel it now: wait here for the answer, which can take up to a minute.',
  decline: 'Sending the decline. You can\'t cancel it now: wait here for the answer.',
  revoke: 'Sending the revocation. You can\'t cancel it now: wait here for the answer.',
}
const WORDS = {
  ALREADY_DECIDED: 'This authorization was already signed, declined or revoked. The list now shows where it stands.',
  TIMEOUT: 'No answer from the server. The list was read again: check whether the change went through before you try again.',
  RENDER_FAILED: 'The signed PDF could not be made just now. Nothing was signed: try again.',
}

async function mountedSection(c, L, S) {
  const { Vue } = vue()
  const consent = await import(pathToFileURL(path.join(CLIENT_SRC, 'lib', 'signingConsent.js')).href)
  const make = viewFactory(S.view)
  const noise = []
  async function mountPage({ mobile = false } = {}) {
    const api = fakeApi()
    const toasts = []
    const isMobile = Vue.ref(mobile)
    const m = mountInMemory(make(viewDeps({ L, consent, api, toasts, isMobile })))
    await drain()
    const inDialog = (n) => { for (let up = n.parent; up; up = up.parent) if (up.tag === 'x-dialog') return true; return false }
    const [signDialog, reasonDialog] = m.findAll((n) => n.tag === 'x-dialog')
    const p = {
      m, api, toasts, isMobile, signDialog, reasonDialog, thrown: [],
      button: (label, from) => m.find((n) => n.tag === 'button' && m.text(n) === label, from),
      rowButtons: () => m.findAll((n) => n.tag === 'button' && !inDialog(n) && ROW_ACTIONS.includes(m.text(n))),
      field: (pred) => m.find(pred),
      status: (dialog) => m.text(m.find((n) => n.props.role === 'status', dialog)),
      error: (dialog) => m.text(m.find((n) => n.props.role === 'alert', dialog)),
      done() { noise.push(...m.warnings, ...p.thrown); m.unmount() },
    }
    return p
  }
  // Every row action on the page, in the table and in the phone cards.
  async function rowActions(p) {
    const start = p.isMobile.value
    const seen = []
    for (const mobile of [start, !start]) {
      p.isMobile.value = mobile
      await drain()
      seen.push(...p.rowButtons().map((b) => ({ label: p.m.text(b), off: isDisabled(b), where: mobile ? 'card' : 'table' })))
    }
    p.isMobile.value = start
    await drain()
    return seen
  }
  const live = (seen) => ({ n: seen.length, live: seen.filter((b) => !b.off).map((b) => `${b.where} ${b.label}`) })
  async function fillSign(p) {
    await typeInto(p.field((n) => n.tag === 'input' && n.props.autocomplete === 'name'), 'Sam Example')
    await typeInto(p.field((n) => n.tag === 'input' && n.props.autocomplete === 'organization-title'), 'Safety Manager')
    await tick(p.field((n) => n.tag === 'input' && n.props.type === 'checkbox'))
  }

  // A countersign that lands (table).
  {
    const p = await mountPage()
    await press(p, p.rowButtons().find((b) => p.m.text(b) === 'Sign for LogisX'))
    await fillSign(p)
    const send = p.button('Sign for LogisX Inc.', p.signDialog)
    const cancel = p.button('Cancel', p.signDialog)
    await press(p, send)
    await press(p, cancel)
    await dismiss(p, p.signDialog)
    const rows = await rowActions(p)
    c.eq('§3b a countersign out: the dialog says it is being sent and can\'t be cancelled', p.status(p.signDialog), SENDING.sign)
    c.ok('§3b ...its Cancel and Sign buttons are disabled', isDisabled(cancel) && isDisabled(send))
    c.ok('§3b ...Cancel, the X, Escape and a click outside leave it open; it was sent once',
      p.signDialog.props.open === true && p.api.posts.length === 1 && p.api.posts[0].url === '/api/admin/passenger-authorizations/1/countersign')
    c.eq('§3b ...no row offers Sign or Decline, in the table or the cards', live(rows), { n: 8, live: [] })
    const openTillAnswer = p.signDialog.props.open === true
    if (p.api.posts[0]) p.api.posts[0].resolve({ ok: true })
    await drain()
    c.ok('§3b a countersign that lands: only the answer closes the dialog; the toast names it; the list is read again',
      openTillAnswer && p.signDialog.props.open === false && p.api.gets.length === 2
      && p.toasts.includes('Signed for LogisX Inc. (PA-0000ABC1). The driver is told in the app.'))
    const after = await rowActions(p)
    c.ok('§3b ...and only then do the rows offer their actions again', live(rows).live.length === 0 && rows.length === 8 && live(after).live.length === 8)
    p.done()
  }

  // A countersign refused (table): the dialog unlocks, so the person can retry or leave.
  {
    const p = await mountPage()
    await press(p, p.rowButtons().filter((b) => p.m.text(b) === 'Sign for LogisX')[1])
    await fillSign(p)
    const send = p.button('Sign for LogisX Inc.', p.signDialog)
    const cancel = p.button('Cancel', p.signDialog)
    await press(p, send)
    await dismiss(p, p.signDialog)
    const openTillAnswer = p.signDialog.props.open === true
    if (p.api.posts[0]) p.api.posts[0].reject(apiError(503, 'RENDER_FAILED'))
    await drain()
    c.ok('§3b a countersign refused: the dialog stays with its words and unlocks (Cancel and Sign live, no "sending" line)',
      openTillAnswer && p.signDialog.props.open === true && p.error(p.signDialog) === WORDS.RENDER_FAILED && p.status(p.signDialog) === ''
      && !isDisabled(cancel) && !isDisabled(send) && p.api.posts.length === 1 && p.api.posts[0].url === '/api/admin/passenger-authorizations/7/countersign')
    await dismiss(p, p.signDialog)
    c.ok('§3b ...and now the X, Escape or a click outside closes it', openTillAnswer && p.signDialog.props.open === false)
    p.done()
  }

  // A decline refused (phone cards); a second tap while it is out sends nothing.
  {
    const p = await mountPage({ mobile: true })
    await press(p, p.rowButtons().find((b) => p.m.text(b) === 'Decline'))
    await typeInto(p.field((n) => n.tag === 'textarea'), 'Trip cancelled')
    const send = p.button('Decline', p.reasonDialog)
    const cancel = p.button('Cancel', p.reasonDialog)
    await press(p, send)
    if (send) fire(p, send.props.onClick, evt(send))
    await drain()
    await press(p, cancel)
    await dismiss(p, p.reasonDialog)
    const rows = await rowActions(p)
    c.eq('§3b a decline out: the dialog says it is being sent and can\'t be cancelled', p.status(p.reasonDialog), SENDING.decline)
    c.ok('§3b ...its Cancel and Decline buttons are disabled', isDisabled(cancel) && isDisabled(send))
    c.ok('§3b ...a second tap, Cancel, the X, Escape and a click outside: still open, sent once',
      p.reasonDialog.props.open === true && p.api.posts.length === 1 && p.api.posts[0].url === '/api/admin/passenger-authorizations/1/decline')
    c.eq('§3b ...no row offers Sign or Decline, in the cards or the table', live(rows), { n: 8, live: [] })
    const openTillAnswer = p.reasonDialog.props.open === true
    if (p.api.posts[0]) p.api.posts[0].reject(apiError(409, 'ALREADY_DECIDED'))
    await drain()
    c.ok('§3b a decline refused: the dialog stays with its words, unlocks, and the list is read again',
      openTillAnswer && p.reasonDialog.props.open === true && p.error(p.reasonDialog) === WORDS.ALREADY_DECIDED && p.status(p.reasonDialog) === ''
      && !isDisabled(cancel) && !isDisabled(send) && p.api.gets.length === 2)
    await press(p, cancel)
    c.ok('§3b ...and now Cancel closes it', openTillAnswer && p.reasonDialog.props.open === false)
    p.done()
  }

  // A revoke with no answer (table, Authorized tab).
  {
    const p = await mountPage()
    const tabs = p.m.find((n) => n.tag === 'x-tabs')
    if (tabs) fire(p, tabs.props['onUpdate:modelValue'], 'authorized')
    await drain()
    await press(p, p.rowButtons().find((b) => p.m.text(b) === 'Revoke'))
    await typeInto(p.field((n) => n.tag === 'textarea'), 'Rider changed')
    const send = p.button('Revoke', p.reasonDialog)
    const cancel = p.button('Cancel', p.reasonDialog)
    await press(p, send)
    await press(p, cancel)
    await dismiss(p, p.reasonDialog)
    const rows = await rowActions(p)
    c.eq('§3b a revoke out: the dialog says it is being sent and can\'t be cancelled', p.status(p.reasonDialog), SENDING.revoke)
    c.ok('§3b ...Cancel, the X, Escape and a click outside leave it open; it was sent once',
      p.reasonDialog.props.open === true && isDisabled(cancel) && p.api.posts.length === 1 && p.api.posts[0].url === '/api/admin/passenger-authorizations/2/revoke')
    c.eq('§3b ...no row offers Revoke, in the table or the cards', live(rows), { n: 4, live: [] })
    const openTillAnswer = p.reasonDialog.props.open === true
    if (p.api.posts[0]) p.api.posts[0].reject(apiError(0, 'TIMEOUT'))
    await drain()
    c.ok('§3b a revoke with no answer: the dialog says to check, unlocks, and the list is read again',
      openTillAnswer && p.reasonDialog.props.open === true && p.error(p.reasonDialog) === WORDS.TIMEOUT && p.status(p.reasonDialog) === ''
      && !isDisabled(cancel) && p.api.gets.length === 3)
    await dismiss(p, p.reasonDialog)
    c.ok('§3b ...and now the X, Escape or a click outside closes it', openTillAnswer && p.reasonDialog.props.open === false)
    p.done()
  }

  // A decline that lands (table).
  {
    const p = await mountPage()
    await press(p, p.rowButtons().find((b) => p.m.text(b) === 'Decline'))
    await typeInto(p.field((n) => n.tag === 'textarea'), 'Trip cancelled')
    await press(p, p.button('Decline', p.reasonDialog))
    await press(p, p.button('Cancel', p.reasonDialog))
    await dismiss(p, p.reasonDialog)
    const rows = await rowActions(p)
    const openTillAnswer = p.reasonDialog.props.open === true
    if (p.api.posts[0]) p.api.posts[0].resolve({ ok: true })
    await drain()
    c.ok('§3b a decline that lands: only the answer closes the dialog; the toast names it; the list is read again',
      openTillAnswer && p.reasonDialog.props.open === false && p.api.posts.length === 1 && p.api.posts[0].url === '/api/admin/passenger-authorizations/1/decline'
      && p.api.gets.length === 2 && p.toasts.includes('Declined PA-0000ABC1. The driver is told in the app.'))
    const after = await rowActions(p)
    c.ok('§3b ...the rows\' actions come back only with the decline\'s answer', live(rows).live.length === 0 && rows.length === 8 && live(after).live.length === 8)
    p.done()
  }

  // A revoke that lands (phone cards, Authorized tab).
  {
    const p = await mountPage({ mobile: true })
    const tabs = p.m.find((n) => n.tag === 'x-tabs')
    if (tabs) fire(p, tabs.props['onUpdate:modelValue'], 'authorized')
    await drain()
    await press(p, p.rowButtons().find((b) => p.m.text(b) === 'Revoke'))
    await typeInto(p.field((n) => n.tag === 'textarea'), 'Rider changed')
    await press(p, p.button('Revoke', p.reasonDialog))
    await dismiss(p, p.reasonDialog)
    const rows = await rowActions(p)
    const openTillAnswer = p.reasonDialog.props.open === true
    if (p.api.posts[0]) p.api.posts[0].resolve({ ok: true })
    await drain()
    c.ok('§3b a revoke that lands: only the answer closes the dialog; the toast names it; the list is read again',
      openTillAnswer && p.reasonDialog.props.open === false && p.api.posts.length === 1 && p.api.posts[0].url === '/api/admin/passenger-authorizations/2/revoke'
      && p.api.gets.length === 3 && p.toasts.includes('Revoked PA-0000ABC2. The driver is told in the app.'))
    const after = await rowActions(p)
    c.ok('§3b ...the rows\' actions come back only with the revoke\'s answer', live(rows).live.length === 0 && rows.length === 4 && live(after).live.length === 4)
    p.done()
  }

  c.eq('§3b harness: the page ran with no Vue warning and no handler threw', noise, [])
}

// ── §4 the route and the sidebar ─────────────────────────────────────────────
function navSection(c, L, S) {
  c.ok('§4 the route is Super Admin only',
    /\{\s*\/\/[^\n]*\n\s*path: '\/admin\/passenger-authorizations',\s*name: 'admin-passenger-authorizations',\s*component: \(\) => import\('\.\.\/views\/PassengerAuthorizationsView\.vue'\),\s*meta: \{ roles: \['Super Admin'\] \},\s*\}/.test(S.router))
  c.eq('§4 one route for the page', count(S.router, "'/admin/passenger-authorizations'"), 1)
  const sb = S.sidebar
  const blocks = sb.split(/\n {2}(?=Dispatcher: \[|Investor: \[|Driver: \[)/)
  const admin = blocks[0].slice(blocks[0].indexOf("'Super Admin': ["))
  const apps = admin.slice(admin.indexOf("{ divider: true, label: 'Applications' }"), admin.indexOf("{ divider: true, label: 'System' }"))
  c.ok('§4 the entry is under Applications, marked as the feature\'s',
    apps.includes("{ to: '/admin/passenger-authorizations', icon: '&#128101;', label: 'Passenger Authorizations', feature: 'passengerAuthorization' },"))
  c.ok('§4 no other role has the entry', blocks.length === 4 && blocks.slice(1).every((b) => !b.includes('/admin/passenger-authorizations')))
  const js = stripComments(scriptOf(sb))
  c.ok('§4 only a Super Admin asks the server', js.includes("const passengerAuthEnabled = auth.user?.role === 'Super Admin' ? usePassengerAuthorizationFeature(useApi()) : ref(false)"))
  c.ok('§4 the entry shows only when the feature says true',
    js.includes("const navItems = computed(() => (navConfig[auth.user?.role] || [])\n  .filter((item) => item.feature !== 'passengerAuthorization' || passengerAuthEnabled.value === true))"))
}

// ── §5 flag off ──────────────────────────────────────────────────────────────
function offSection(c, L, S) {
  const js = stripComments(scriptOf(S.view))
  const tpl = stripComments(templateOf(S.view))
  c.ok('§5 FEATURE_OFF empties the list and says so', /if \(err && err\.code === 'FEATURE_OFF'\) \{\n {6}featureOff\.value = true\n {6}listed\.value = \[\]\n/.test(js))
  c.ok('§5 the page shows the words and no tabs or rows while off',
    tpl.includes('<p v-if="featureOff" class="pa-off" role="status">Passenger authorizations are switched off on this server.</p>\n    <template v-else>'))
  // The sidebar's filter, run on its own: the entry only for a real true.
  const filterSrc = (stripComments(scriptOf(S.sidebar)).match(/\.filter\(\(item\) => [^\n]*\)\)/) || [''])[0].slice('.filter('.length, -2)
  let shown = null
  try {
    const keep = new Function('passengerAuthEnabled', `return ${filterSrc}`)
    const items = [{ to: '/applications' }, { to: '/admin/passenger-authorizations', feature: 'passengerAuthorization' }]
    shown = [false, null, 'true', 1, true].map((value) => items.filter(keep({ value })).length)
  } catch { shown = null }
  c.eq('§5 the sidebar entry: hidden for false, unknown or truthy, shown for true', shown, [1, 1, 1, 1, 2])
}

// ── compiles ─────────────────────────────────────────────────────────────────
function compileSection(c) {
  const { parse, compileScript } = createRequire(path.join(ROOT, 'client', 'package.json'))('vue/compiler-sfc')
  for (const key of ['view', 'sidebar']) {
    let problem = ''
    try {
      const { descriptor, errors } = parse(S0[key], { filename: path.basename(FILES[key]) })
      if (errors.length) problem = String(errors[0].message || errors[0])
      else compileScript(descriptor, { id: key, inlineTemplate: true })
    } catch (err) {
      problem = String(err?.message || err).split('\n')[0]
    }
    c.eq(`§3 ${path.basename(FILES[key])} compiles`, problem, '')
  }
}

const SECTIONS = { lib: libSection, parity: paritySection, page: pageSection, mounted: mountedSection, nav: navSection, off: offSection }
async function runSections(c, L, S, names) {
  for (const n of names) await section(c, n, () => (L ? SECTIONS[n](c, L, S) : c.eq(`${n}: the lib loads`, false, true)))
}

let lib = null
try { lib = await import(pathToFileURL(LIB).href) } catch { lib = null }

{
  const HEADS = {
    lib: '§1 the lib', parity: '§2 parity with the server', page: '§3 the page', mounted: '§3b the page, mounted: while an action is out',
    nav: '§4 the route and the sidebar', off: '§5 flag off',
  }
  for (const n of Object.keys(SECTIONS)) {
    console.log(`\n${HEADS[n]}`)
    await runSections(MAIN, lib, S0, [n])
    if (n === 'page') await section(MAIN, 'compile', () => compileSection(MAIN))
  }

  // ── §6 mutants ─────────────────────────────────────────────────────────────
  console.log('\n§6 mutants')
  const once = (src, from, to) => {
    const n = src.split(from).length - 1
    if (n !== 1) throw new Error(`target found ${n}x (expected 1): ${from.slice(0, 70)}`)
    return src.replace(from, () => to)
  }
  async function mutant(id, label, build, names) {
    let L = lib
    let S = S0
    try {
      const made = build()
      if (made.lib !== undefined) L = await import(`data:text/javascript,${encodeURIComponent(absImports(made.lib))}`)
      if (made.files) S = { ...S0, ...made.files }
    } catch (err) {
      MAIN.eq(`§6 ${id}: ${label}: the mutation applies`, err.message, 'applies')
      return
    }
    const c = checker(false)
    await runSections(c, L, S, names)
    MAIN.eq(`§6 ${id}: ${label}: is caught`, c.failed.length > 0 ? 'caught' : 'not caught', 'caught')
  }
  const libMut = (from, to) => () => ({ lib: once(LIB_SRC, from, to) })
  const fileMut = (key, from, to) => () => ({ files: { [key]: once(S0[key], from, to) } })
  if (lib) {
    await mutant('M1', 'an expired row under Waiting', libMut("statuses: Object.freeze(['awaiting_company'])", "statuses: Object.freeze(['awaiting_company', 'expired'])"), ['lib'])
    await mutant('M2', 'rows shown whatever their status', libMut('.filter((r) => isRow(r) && statuses.includes(r.displayStatus))', '.filter((r) => isRow(r))'), ['lib'])
    await mutant('M3', 'any view name passed to the server', libMut("return TABS.some((t) => t.key === key) ? key : 'waiting'", "return key || 'waiting'"), ['lib'])
    await mutant('M4', 'revoke offered on an ended row', libMut("revoke: s === 'scheduled' || s === 'active',", "revoke: s !== 'awaiting_company',"), ['lib'])
    await mutant('M5', 'sign offered on an expired row', libMut("countersign: s === 'awaiting_company',", "countersign: s === 'awaiting_company' || s === 'expired',"), ['lib'])
    await mutant('M6', 'a one-letter printed name', libMut('export const PRINTED_NAME_MIN = 2', 'export const PRINTED_NAME_MIN = 1'), ['lib'])
    await mutant('M7', 'a title past the server\'s length', libMut('export const TITLE_MAX = 60', 'export const TITLE_MAX = 600'), ['lib'])
    await mutant('M8', 'no tick needed', libMut("if (f.agreed !== true) return 'Tick the box to agree before you sign.'\n", ''), ['lib'])
    await mutant('M9', 'any image text taken as a signature', libMut("if (typeof f.signatureImage !== 'string' || !PNG_DATA_URI.test(f.signatureImage))", "if (typeof f.signatureImage !== 'string' || !f.signatureImage)"), ['lib'])
    await mutant('M10', 'the name sent untrimmed', libMut('printedName: trimmed(f.printedName),', 'printedName: f.printedName,'), ['lib'])
    await mutant('M11', 'a reason past the server\'s length', libMut('export const REASON_MAX = 300', 'export const REASON_MAX = 3000'), ['lib'])
    await mutant('M12', 'the list not read again after a lost answer', libMut('(RELOAD_CODES.includes(err.code) || err.status === 0)', 'RELOAD_CODES.includes(err.code)'), ['lib'])
    await mutant('M29', 'the list not read again after a revoke that was too late', libMut("'ALREADY_DECIDED', 'NOT_REVOCABLE', ", "'ALREADY_DECIDED', "), ['lib'])
    await mutant('M30', 'a code the server answers left without words', libMut("  NOT_REVOCABLE: 'Only an authorization", "  NOT_REVOCABLE_X: 'Only an authorization"), ['parity'])
    await mutant('M31', 'an expired awaiting row shown under Ended without its words', libMut("if (row.status === 'awaiting_company' && row.displayStatus === 'expired') return 'Expired before the company signed.'\n", ''), ['lib'])
    await mutant('M32', 'lengths counted in UTF-16 units', libMut('const n = Array.from(text).length', 'const n = text.length'), ['lib'])
    await mutant('M33', 'the page showing a field the server never sends', fileMut('view', '<TableCell>{{ r.driverName }}</TableCell>', '<TableCell>{{ r.driverName }} {{ r.driverPhone }}</TableCell>'), ['parity'])
    await mutant('M13', 'the countersign button without its check', fileMut('view', '<Button v-if="actionsFor(r).countersign" size="sm" :disabled="sending" @click="openSign(r)">Sign for LogisX</Button>\n                  <Button v-if="actionsFor(r).decline"',
      '<Button size="sm" :disabled="sending" @click="openSign(r)">Sign for LogisX</Button>\n                  <Button v-if="actionsFor(r).decline"'), ['page'])
    await mutant('M14', 'the countersign sent before its check', fileMut('view', '  const problem = countersignProblem(form)\n  if (problem) {\n    s.error = problem\n    return\n  }\n', ''), ['page'])
    await mutant('M15', 'the dialog state kept between opens', fileMut('view', 'sign.value = { ...blankSign(), open: true, row, padKey: ++padKey }', 'sign.value = { ...sign.value, open: true, row, padKey: ++padKey }'), ['page'])
    await mutant('M16', 'a late answer written into whatever dialog is open', fileMut('view', '    if (sign.value === s) {\n      s.error = actionErrorText(err)', '    if (true) {\n      s.error = actionErrorText(err)'), ['page'])
    await mutant('M17', 'an old tab\'s answer kept', fileMut('view', '    const res = await api.get(listUrl(tab.value))\n    if (mine !== seq) return\n', '    const res = await api.get(listUrl(tab.value))\n'), ['page'])
    await mutant('M18', 'the PDF opened with an opener', fileMut('view', '<a :href="pdfUrl(sign.row.id)" target="_blank" rel="noopener noreferrer"', '<a :href="pdfUrl(sign.row.id)" target="_blank"'), ['page'])
    await mutant('M19', 'the pad drawable before the tick', fileMut('view', '            :disabled="!sign.agreed"\n', ''), ['page'])
    await mutant('M28', 'the signature not read from the pad at the click', fileMut('view', "signatureImage: (padRef.value && padRef.value.toDataURL()) || '' }", "signatureImage: '' }"), ['page'])
    await mutant('M20', 'revoke posted to the decline URL', fileMut('view', "const url = d.kind === 'revoke' ? revokeUrl(d.row.id) : declineUrl(d.row.id)", 'const url = declineUrl(d.row.id)'), ['page'])
    await mutant('M21', 'the route open to a Dispatcher', fileMut('router', "component: () => import('../views/PassengerAuthorizationsView.vue'),\n    meta: { roles: ['Super Admin'] },",
      "component: () => import('../views/PassengerAuthorizationsView.vue'),\n    meta: { roles: ['Super Admin', 'Dispatcher'] },"), ['nav'])
    await mutant('M22', 'the entry shown without the feature', fileMut('sidebar', " || passengerAuthEnabled.value === true))", ' || true))'), ['nav', 'off'])
    await mutant('M23', 'the entry shown for any truthy answer', fileMut('sidebar', " || passengerAuthEnabled.value === true))", ' || !!passengerAuthEnabled.value))'), ['off'])
    await mutant('M24', 'every role asks the server', fileMut('sidebar', "auth.user?.role === 'Super Admin' ? usePassengerAuthorizationFeature(useApi()) : ref(false)", 'usePassengerAuthorizationFeature(useApi())'), ['nav'])
    await mutant('M25', 'the entry given to Dispatchers', fileMut('sidebar', "  Dispatcher: [\n", "  Dispatcher: [\n    { to: '/admin/passenger-authorizations', icon: '&#128101;', label: 'Passenger Authorizations', feature: 'passengerAuthorization' },\n"), ['nav'])
    await mutant('M26', 'the list kept after FEATURE_OFF', fileMut('view', '      featureOff.value = true\n      listed.value = []\n', '      featureOff.value = true\n'), ['off'])
    await mutant('M27', 'the reason dialog state kept between opens', fileMut('view', 'function closeReason() {\n  decide.value = blankDecide()\n}', 'function closeReason() {\n  decide.value.open = false\n}'), ['page'])
    // While an action is out (§3b).
    await mutant('M34', 'the X, Escape or a click outside closing a countersign that is out', fileMut('view', 'function dismissSign() {\n  if (sign.value.busy) return\n', 'function dismissSign() {\n'), ['mounted'])
    await mutant('M35', 'Cancel live while the signature is out', fileMut('view', '<Button variant="outline" :disabled="sign.busy" @click="dismissSign">Cancel</Button>', '<Button variant="outline" @click="dismissSign">Cancel</Button>'), ['mounted'])
    await mutant('M36', 'a decline or revoke dialog closed while its action is out', fileMut('view', 'function dismissReason() {\n  if (decide.value.busy) return\n', 'function dismissReason() {\n'), ['mounted'])
    await mutant('M37', 'Cancel live while a decline or revoke is out', fileMut('view', '<Button variant="outline" :disabled="decide.busy" @click="dismissReason">Cancel</Button>', '<Button variant="outline" @click="dismissReason">Cancel</Button>'), ['mounted'])
    await mutant('M38', 'no word that the signature is being sent', fileMut('view', '<p v-if="sign.busy" class="pa-sending" role="status">', '<p v-if="false" class="pa-sending" role="status">'), ['mounted'])
    await mutant('M39', 'no word that a decline or revoke is being sent', fileMut('view', '<p v-if="decide.busy" class="pa-sending" role="status">', '<p v-if="false" class="pa-sending" role="status">'), ['mounted'])
    await mutant('M40', 'the rows\' actions live while a decline or revoke is out', fileMut('view', 'const sending = computed(() => sign.value.busy || decide.value.busy)', 'const sending = computed(() => sign.value.busy)'), ['mounted'])
    await mutant('M41', 'a phone card\'s Sign live while an action is out', fileMut('view', '<Button v-if="actionsFor(r).countersign" size="sm" :disabled="sending" @click="openSign(r)">Sign for LogisX</Button>\n              <Button',
      '<Button v-if="actionsFor(r).countersign" size="sm" @click="openSign(r)">Sign for LogisX</Button>\n              <Button'), ['mounted'])
    await mutant('M42', 'the table\'s Revoke live while a revoke is out', fileMut('view', ':disabled="sending" @click="openReason(r, \'revoke\')">Revoke</Button>\n                </div>', '@click="openReason(r, \'revoke\')">Revoke</Button>\n                </div>'), ['mounted'])
    await mutant('M43', 'a countersign that landed waiting on a close the person can\'t make', fileMut('view', '    if (sign.value === s) closeSign()\n', '    if (sign.value === s) dismissSign()\n'), ['mounted'])
    await mutant('M44', 'a refused countersign leaving its dialog locked', fileMut('view', '      s.busy = false\n', ''), ['mounted'])
    await mutant('M45', 'a refused decline or revoke leaving its dialog locked', fileMut('view', '      d.busy = false\n', ''), ['mounted'])
    await mutant('M46', 'a second decline tap while one is out sending again', fileMut('view', 'if (d.busy || !d.row) return', 'if (!d.row) return'), ['mounted'])
    await mutant('M47', 'the list not read again after a countersign lands', fileMut('view', '    toast(`Signed for LogisX Inc. (${s.row.reference}). The driver is told in the app.`)\n    load()\n', '    toast(`Signed for LogisX Inc. (${s.row.reference}). The driver is told in the app.`)\n'), ['mounted'])
    await mutant('M48', 'the Sign button live while the signature is out', fileMut('view', '<Button :disabled="sign.busy" @click="submitSign">', '<Button @click="submitSign">'), ['mounted'])
    await mutant('M49', 'a decline or revoke that landed waiting on a close the person can\'t make', fileMut('view', '    if (decide.value === d) closeReason()\n', '    if (decide.value === d) dismissReason()\n'), ['mounted'])
    await mutant('M50', 'the list not read again after a decline or revoke lands', fileMut('view', "    toast(`${d.kind === 'revoke' ? 'Revoked' : 'Declined'} ${d.row.reference}. The driver is told in the app.`)\n    load()\n",
      "    toast(`${d.kind === 'revoke' ? 'Revoked' : 'Declined'} ${d.row.reference}. The driver is told in the app.`)\n"), ['mounted'])
    await mutant('M51', 'a landed decline or revoke closing its dialog but leaving every row\'s actions off', fileMut('view', '    if (decide.value === d) closeReason()\n', '    if (decide.value === d) decide.value.open = false\n'), ['mounted'])
  }
}

console.log(`\ntest-passenger-authorization-admin-client: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
