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
//   §4 the route and the sidebar: Super Admin only; the entry under Applications, for
//      no other role, shown only when the feature says true, asked by a Super Admin only
//   §5 flag off: the page says so and lists nothing; the sidebar hides the entry
//   §6 mutants: copies of the lib and the screens with one rule changed must each be
//      caught by the sections above
//
// Made-up people only. No DOM, no server, no build.
//   node scripts/test-passenger-authorization-admin-client.mjs      # exits 1 on any failure
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = path.join(ROOT, 'client', 'src')
const LIB = path.join(CLIENT_SRC, 'lib', 'passengerAuthorizationAdmin.js')
const FILES = {
  view: path.join(CLIENT_SRC, 'views', 'PassengerAuthorizationsView.vue'),
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
function section(c, label, fn) {
  try { fn() } catch (err) { c.eq(`${label} ran`, `threw: ${err && err.message}`, 'no throw') }
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
  c.ok('§3 closing either dialog goes through its close function',
    tpl.includes('<Dialog :open="sign.open" @update:open="(v) => { if (!v) closeSign() }">') && tpl.includes('<Dialog :open="decide.open" @update:open="(v) => { if (!v) closeReason() }">'))
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

const SECTIONS = { lib: libSection, parity: paritySection, page: pageSection, nav: navSection, off: offSection }
function runSections(c, L, S, names) {
  for (const n of names) section(c, n, () => (L ? SECTIONS[n](c, L, S) : c.eq(`${n}: the lib loads`, false, true)))
}

let lib = null
try { lib = await import(pathToFileURL(LIB).href) } catch { lib = null }

{
  const HEADS = { lib: '§1 the lib', parity: '§2 parity with the server', page: '§3 the page', nav: '§4 the route and the sidebar', off: '§5 flag off' }
  for (const n of Object.keys(SECTIONS)) {
    console.log(`\n${HEADS[n]}`)
    runSections(MAIN, lib, S0, [n])
    if (n === 'page') section(MAIN, 'compile', () => compileSection(MAIN))
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
    runSections(c, L, S, names)
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
    await mutant('M13', 'the countersign button without its check', fileMut('view', '<Button v-if="actionsFor(r).countersign" size="sm" @click="openSign(r)">Sign for LogisX</Button>\n                  <Button v-if="actionsFor(r).decline"',
      '<Button size="sm" @click="openSign(r)">Sign for LogisX</Button>\n                  <Button v-if="actionsFor(r).decline"'), ['page'])
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
  }
}

console.log(`\ntest-passenger-authorization-admin-client: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
