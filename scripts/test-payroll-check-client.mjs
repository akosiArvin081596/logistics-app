#!/usr/bin/env node
// The before-payroll check's page — the CLIENT's half. GET /api/admin/payroll-check (server.js
// payrollCheck(), lib/payroll-check.js) finds every day, line and reason and sums every figure; its
// role gate and switch are the real controls (scripts/test-payroll-check.js). This pins the screen:
//
//   §1 client/src/lib/payrollCheck.js: who may see it (a Super Admin only), the switch read off the
//      route's own answer, the request, the weeks offered (Fridays, the last finished week first, on
//      the business clock), whole cents shown as dollars by the app's formatMoneyCents() only.
//   §2 a refusal in words: a 404 is "not switched on", a 400 shows the server's words, a 503 a retry line.
//   §3 the view of an answer in the route's exact shape (lib/payroll-check.js's own shapeCheck() over
//      made-up items): the server's totals, each item under its driver and week with its reason's tag
//      and the server's own sentence, the per driver and week roll-up; a malformed answer is none.
//   §4 the Invoices link (PayrollCheckLink.vue), mounted: a Super Admin's, shown only once the route
//      says the switch is on, asked once per page; every other role renders nothing and asks nothing.
//   §5 the page (PayrollCheckView.vue), mounted: nothing and no request for any other role; a Super
//      Admin's check for the default week, a week picked, Check again; switched off, refused, a 503 and
//      Try again; a table on a desktop, cards on a phone.
//   §6 wiring, from source: the page's route is Super Admin only; Invoices shows the link to a Super
//      Admin only; GET is the only request; no v-html; no money computed or formatted beyond
//      formatMoneyCents().
//
// Made-up values only. No DOM, no server, no network. Vue comes from this checkout's client/node_modules.
//   node scripts/test-payroll-check-client.mjs      # exits 1 on any failure
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))
const read = (rel) => (exists(rel) ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : '')
const require = createRequire(import.meta.url)
const clientRequire = createRequire(path.join(ROOT, 'client', 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')

let pass = 0
let fail = 0
function ok(label, cond, detail = '') {
  if (cond) { pass++; return }
  fail++
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(label, a === e, `expected ${e}\n        actual   ${a}`)
}
const section = (t) => console.log(`\n${t}`)

// A file's code without its comments: each <!-- -->, /* */ and // comment (a "//" right after ":"
// is a URL, kept) skipped to its end, in one pass.
function code(src) {
  const s = String(src)
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s.startsWith('<!--', i)) { const end = s.indexOf('-->', i + 4); i = end === -1 ? s.length : end + 3; continue }
    if (s.startsWith('/*', i)) { const end = s.indexOf('*/', i + 2); i = end === -1 ? s.length : end + 2; continue }
    if (s.startsWith('//', i) && s[i - 1] !== ':') { const end = s.indexOf('\n', i + 2); i = end === -1 ? s.length : end; continue }
    out += s[i]
    i++
  }
  return out
}

const LIB = 'client/src/lib/payrollCheck.js'
const SWITCH = 'client/src/composables/usePayrollCheckSwitch.js'
const LINK = 'client/src/components/invoices/PayrollCheckLink.vue'
const PAGE = 'client/src/views/PayrollCheckView.vue'
const CHECK_URL = '/api/admin/payroll-check'
const ROLES_NOT_SA = ['Dispatcher', 'Driver', 'Investor', 'KPI Viewer', 'super admin', '', null]

let lib = null
try { lib = exists(LIB) ? await import(pathToFileURL(path.join(ROOT, LIB)).href) : null } catch (err) { console.log(`  (${LIB} did not load: ${err.message})`) }
const has = (...names) => !!lib && names.every((n) => typeof lib[n] === 'function')

// ------------------------------------------------------------------ made-up answer, the route's own shape
// Each item as server.js payrollCheck() builds it; the answer as the route sends it, through the server's
// own shapeCheck() (lib/payroll-check.js), so the screen is tested against the exact shape it gets.
const { shapeCheck } = require(path.join(ROOT, 'lib', 'payroll-check.js'))
const SCOPE = { weekEnd: '2026-10-16', weekStart: '2026-10-10', rangeStart: '2026-09-26', latestClosedMonth: '2026-09', firstOpenMonth: '2026-10', lastFinishedWeekEnd: '2026-10-16' }
const day = (driverName, weekStart, d, extra) => ({
  driverKey: driverName.toLowerCase(), driverName, weekStart, day: d, payMonth: d.slice(0, 7), loadId: '', added: false, loadCompleted: '',
  scopes: [{ ownerId: 5, month: d.slice(0, 7), cents: 26000, loadId: '' }], overlap: false, cents: 26000, invoiceNumber: '', invoiceStatus: '', ...extra,
})
const SECTIONS_IN = {
  ledgerDays: [
    day('Avery Lund', '2026-10-03', '2026-10-08', { loadId: 'PX101', loadCompleted: '2026-10-12', invoiceNumber: 'INV-AL-2026W41-01', invoiceStatus: 'Submitted', reason: 'completedAfterInvoice', text: 'its load PX101 was completed on 2026-10-12, in a later week; INV-AL-2026W41-01 bills only the loads completed in its own week' }),
    day('Avery Lund', '2026-10-03', '2026-10-09', { loadId: 'PX101', loadCompleted: '2026-10-12', invoiceNumber: 'INV-AL-2026W41-01', invoiceStatus: 'Submitted', reason: 'completedAfterInvoice', text: 'its load PX101 was completed on 2026-10-12, in a later week; INV-AL-2026W41-01 bills only the loads completed in its own week' }),
    day('Avery Lund', '2026-10-10', '2026-10-13', { loadId: 'PX102', invoiceNumber: 'INV-AL-2026W42-01', invoiceStatus: 'Draft', reason: 'unexplained', text: 'no known reason: INV-AL-2026W42-01 bills load PX102 and its window holds the day, but the load\'s truck reports to no ELD' }),
    day('Blair Moss', '2026-10-03', '2026-10-07', { added: true, cents: 26237, invoiceNumber: 'INV-BM-2026W41-01', invoiceStatus: 'Approved', reason: 'addedAfterInvoice', text: 'added on Driver Pay Overrides after INV-BM-2026W41-01 was made' }),
    day('Casey Rowe', '2026-10-03', '2026-10-06', { loadId: 'PX301', reason: 'noWeeklyInvoice', text: 'the week of 2026-10-03 to 2026-10-09 has no weekly invoice' }),
  ],
  invoiceDays: [
    { driverKey: 'drew pike', driverName: 'Drew Pike', weekStart: '2026-10-10', day: '2026-10-13', invoiceNumber: 'INV-DP-2026W42-01', status: 'Draft', source: 'grid', loadIds: ['PX401'], cents: 26000,
      reason: 'removeOverride', text: 'a "remove" on Driver Pay Overrides takes it out of the books; INV-DP-2026W42-01 paid it and stays as issued' },
  ],
  personalLines: [
    { driverKey: 'gray unlisted', driverName: 'Gray Unlisted', weekStart: '2026-10-03', lineId: 7, expenseId: 31, state: 'carried', cents: 4550, shareCents: 0, merchant: 'Made-up Fuel Stop', receiptDate: '2026-10-07',
      reason: 'unknownDriver', text: 'the receipt\'s driver matches no driver in the Drivers Database, so no weekly invoice takes the line' },
    { driverKey: 'emery tull', driverName: 'Emery Tull', weekStart: '2026-10-03', lineId: 8, expenseId: 32, state: 'pending', cents: 3000, shareCents: 900, merchant: 'Made-up Diner', receiptDate: '2026-10-06',
      reason: 'pending', text: 'waits for its week\'s weekly invoice' },
  ],
  pendingReceipts: [
    { driverKey: 'avery lund', driverName: 'Avery Lund', weekStart: '2026-10-10', expenseId: 41, date: '2026-10-14', type: 'Maintenance', loadId: '', cents: 6125 },
  ],
  correctionDrafts: [
    { driverKey: 'finley hart', driverName: 'Finley Hart', weekStart: '2026-10-03', weekEnd: '2026-10-09', invoiceNumber: 'INV-M-FH-2026W41-01', status: 'Draft', kind: 'days', correctionOf: 'INV-FH-2026W41-01', cents: 52000 },
    { driverKey: 'finley hart', driverName: 'Finley Hart', weekStart: '2026-10-10', weekEnd: '2026-10-16', invoiceNumber: 'INV-M-FH-2026W42-01', status: 'Submitted', kind: 'personal', correctionOf: '', cents: -4550 },
  ],
  percentageLoads: [
    { driverKey: 'emery tull', driverName: 'Emery Tull', weekStart: '2026-10-03', loadId: 'PX502', completed: '2026-10-09', paymentCents: 200000, reason: 'completedAfterInvoice',
      text: 'it was completed (2026-10-09) after INV-ET-2026W41-01 was made; a weekly invoice bills only the loads completed when it is made' },
    { driverKey: 'emery tull', driverName: 'Emery Tull', weekStart: '', loadId: 'PX503', completed: '', paymentCents: null, reason: 'loadUndated',
      text: 'it has no Status Update Date or Completion Date, so no weekly invoice bills it' },
  ],
}
const ANSWER = JSON.parse(JSON.stringify(shapeCheck({
  scope: SCOPE, names: true, sections: SECTIONS_IN, rules: { tripWorkDaysFrom: '', personalReceiptWeek: true }, generatedAt: '2026-10-17T16:00:00.000Z',
})))
const EMPTY_ANSWER = JSON.parse(JSON.stringify(shapeCheck({
  scope: SCOPE, names: true, sections: { ledgerDays: [], invoiceDays: [], personalLines: [], pendingReceipts: [], correctionDrafts: [], percentageLoads: [] }, generatedAt: '2026-10-17T16:00:00.000Z',
})))
// An error as useApi() throws it: the server's words and code, the status, the parsed body.
const apiError = (status, error, code = '') => Object.assign(new Error(error || `Request failed (${status})`), { status, code, data: error ? { error, code } : {} })
const TODAY = '2026-10-17' // a Saturday, the business clock's day: the week of Oct 10-16 has just finished

// ------------------------------------------------------------------ §1 the lib
section('§1 lib/payrollCheck.js: roles, the switch, the request, the weeks, cents as dollars')
ok(`${LIB} exists and loads`, !!lib)
ok('…with its helpers', has('canSeePayrollCheck', 'probeUrl', 'switchFromProbe', 'checkUrl', 'lastFinishedWeekEnd', 'weekOptions', 'weekRangeText', 'centsText', 'reasonTag', 'errorView', 'checkView'))
if (has('canSeePayrollCheck', 'probeUrl', 'switchFromProbe', 'checkUrl')) {
  eq('only a Super Admin may see it', ['Super Admin', ...ROLES_NOT_SA, undefined].map(lib.canSeePayrollCheck), [true, false, false, false, false, false, false, false, false])
  eq('only a Super Admin asks whether it is switched on, with no week', ['Super Admin', ...ROLES_NOT_SA].map(lib.probeUrl), [CHECK_URL, '', '', '', '', '', '', ''])
  eq('the switch from the route\'s answer: 404 off; the missing week refused (400) or an answer (200) on; anything else unknown',
    [[404, 'FEATURE_OFF'], [404, ''], [400, 'PAYROLL_CHECK_WEEK_END_INVALID'], [200, ''], [400, 'PAYROLL_CHECK_WEEK_CLOSED'], [403, ''], [429, ''], [503, 'PERIOD_LOCK_UNREADABLE'], [0, 'TIMEOUT'], [500, '']]
      .map(([s, c]) => lib.switchFromProbe(s, c)),
    [false, false, true, true, null, null, null, null, null, null])
  eq('the request names the week\'s Friday', [lib.checkUrl('2026-10-16'), lib.checkUrl('2026-10-16&x=1')], [`${CHECK_URL}?weekEnd=2026-10-16`, `${CHECK_URL}?weekEnd=2026-10-16%26x%3D1`])
  eq('the page\'s route name', lib.PAGE_ROUTE_NAME, 'invoices-payroll-check')
}
if (has('lastFinishedWeekEnd', 'weekOptions', 'weekRangeText')) {
  eq('the last finished week ends the Friday before this Saturday-Friday week',
    ['2026-10-17', '2026-10-16', '2026-10-15', '2026-10-10', '2027-01-01', 'nope'].map(lib.lastFinishedWeekEnd),
    ['2026-10-16', '2026-10-09', '2026-10-09', '2026-10-09', '2026-12-25', ''])
  const weeks = lib.weekOptions(TODAY)
  eq('eight weeks offered, newest first, each a Friday a week apart', weeks.map((w) => w.value),
    ['2026-10-16', '2026-10-09', '2026-10-02', '2026-09-25', '2026-09-18', '2026-09-11', '2026-09-04', '2026-08-28'])
  eq('…each labelled with its Saturday to Friday', weeks.slice(0, 3).map((w) => w.label), ['Oct 10 – Oct 16, 2026', 'Oct 3 – Oct 9, 2026', 'Sep 26 – Oct 2, 2026'])
  eq('…across a new year the label names both years', lib.weekOptions('2027-01-02')[0].label, 'Dec 26, 2026 – Jan 1, 2027')
  eq('…no day, no weeks', lib.weekOptions(''), [])
  eq('a week\'s words from its Saturday, or its own end', [lib.weekRangeText('2026-10-03'), lib.weekRangeText('2026-11-01', '2026-11-06'), lib.weekRangeText(''), lib.weekRangeText('2026-02-30')],
    ['Oct 3 – Oct 9, 2026', 'Nov 1 – Nov 6, 2026', '', ''])
}
if (has('centsText')) {
  eq('whole cents as dollars', [26000, 1066474, 26237, 0, 5, -4550, 100000000].map(lib.centsText),
    ['$260.00', '$10,664.74', '$262.37', '$0.00', '$0.05', '-$45.50', '$1,000,000.00'])
  eq('anything not whole cents is a dash, never a guess', [null, undefined, 12.5, '100', NaN, Infinity].map(lib.centsText), ['—', '—', '—', '—', '—', '—'])
}
if (has('reasonTag')) {
  eq('each reason the server sends has a short tag', ['completedAfterInvoice', 'addedAfterInvoice', 'noWeeklyInvoice', 'blankPickup', 'mayBePaid', 'settlesInClosedMonth', 'removeOverride', 'unknownDriver', 'mayBeBilled', 'unexplained'].map(lib.reasonTag),
    ['Completed after the invoice', 'Added after the invoice', 'No weekly invoice', 'Blank pickup', 'May already be paid', 'Load settles in a closed month', 'Removed on overrides', 'Driver not in the Drivers Database', 'May already be billed', 'No known reason'])
  eq('…every code lib/payroll-check.js can send is named', (() => {
    const src = read('lib/payroll-check.js')
    const codes = [...new Set([...src.matchAll(/(?:out\(|reason: )"([a-zA-Z]+)"/g)].map((m) => m[1]))].sort()
    return codes.filter((c) => lib.reasonTag(c) === 'Other')
  })(), [])
  eq('…an unknown one reads Other', [lib.reasonTag('somethingNew'), lib.reasonTag('constructor'), lib.reasonTag(undefined)], ['Other', 'Other', 'Other'])
}

// ------------------------------------------------------------------ §2 refusals in words
section('§2 a refusal in words: off, the server\'s 400 words, a 503 retry line')
if (has('errorView') && lib.WORDS) {
  const W = lib.WORDS
  eq('404 FEATURE_OFF: not switched on', lib.errorView(apiError(404, 'The before-payroll check is switched off on this server.', 'FEATURE_OFF')), { kind: 'off', text: W.off })
  eq('a 400 shows the server\'s words', lib.errorView(apiError(400, 'The week ending 2026-09-25 lies wholly in closed months (the latest closed month is 2026-09); the earliest week to check ends 2026-10-02.', 'PAYROLL_CHECK_WEEK_CLOSED')),
    { kind: 'refused', text: 'The week ending 2026-09-25 lies wholly in closed months (the latest closed month is 2026-09); the earliest week to check ends 2026-10-02.' })
  eq('…a 400 with no words: a plain line', lib.errorView(apiError(400, '')), { kind: 'refused', text: W.refused })
  eq('a 503 is a retry line, in the server\'s words', lib.errorView(apiError(503, 'The month locks cannot be read, so the open months cannot be told. Try again in a moment.', 'PERIOD_LOCK_UNREADABLE')),
    { kind: 'retry', text: 'The month locks cannot be read, so the open months cannot be told. Try again in a moment.' })
  eq('…a 503 with no words (a gateway): the plain retry line', lib.errorView(apiError(503, '')), { kind: 'retry', text: W.retryLine })
  eq('a 403: only a Super Admin', lib.errorView(apiError(403, 'Forbidden')), { kind: 'failed', text: W.forbidden })
  eq('a 429 or a 500: the server\'s words', [lib.errorView(apiError(429, 'Too many payroll checks. Try again in a few minutes.')), lib.errorView(apiError(500, 'The before-payroll check failed; nothing was changed. Try again in a moment.'))],
    [{ kind: 'failed', text: 'Too many payroll checks. Try again in a few minutes.' }, { kind: 'failed', text: 'The before-payroll check failed; nothing was changed. Try again in a moment.' }])
  eq('…no answer at all: a plain line', [lib.errorView(Object.assign(new Error('The request timed out.'), { status: 0, code: 'TIMEOUT' })), lib.errorView(null)],
    [{ kind: 'failed', text: W.failed }, { kind: 'failed', text: W.failed }])
  ok('the lines are plain words', [W.off, W.retryLine, W.refused, W.failed, W.forbidden].every((s) => typeof s === 'string' && s.length > 10 && !/[A-Z_]{6,}/.test(s)))
} else ok('errorView and WORDS exist', false)

// ------------------------------------------------------------------ §3 the view of an answer
section('§3 the view: the server\'s totals, each item under its driver and week with its tag and sentence, the roll-up')
let VIEW = null
if (has('checkView')) {
  VIEW = lib.checkView(ANSWER)
  ok('an answer in the route\'s shape has a view', !!VIEW)
  eq('a malformed answer has none (no list is guessed)', [lib.checkView(null), lib.checkView({}), lib.checkView({ ...ANSWER, ledgerDays: 'x' }), lib.checkView({ ...ANSWER, summary: null })], [null, null, null, null])
}
if (VIEW) {
  eq('the week and the range the server checked', [VIEW.weekText, VIEW.scopeText],
    ['Oct 10 – Oct 16, 2026', 'Checked from Sep 26, 2026, the first week of the open months, to Oct 16, 2026. September 2026 and earlier are closed.'])
  eq('…with no month closed, every week up to it', lib.checkView({ ...ANSWER, rangeStart: '', latestClosedMonth: '' }).scopeText, 'Checked every week up to Oct 16, 2026.')
  eq('the totals are the server\'s counts and cents, in dollars', VIEW.totals.map((t) => [t.key, t.count, t.amount]), [
    ['ledgerDays', 5, '$1,302.37'], ['invoiceDays', 1, '$260.00'], ['personalLines', 2, '$75.50'], ['pendingReceipts', 1, '$61.25'], ['correctionDrafts', 2, '$474.50'], ['percentageLoads', 2, '$2,000.00'],
  ])
  eq('…each the server\'s own summary figure', VIEW.totals.map((t) => t.amount),
    ['ledgerDays', 'invoiceDays', 'personalLines', 'pendingReceipts', 'correctionDrafts'].map((k) => lib.centsText(ANSWER.summary[k].cents)).concat(lib.centsText(ANSWER.summary.percentageLoads.paymentCents)))
  eq('…and the server\'s count by reason, tagged', VIEW.totals[0].byReason, [
    { code: 'addedAfterInvoice', tag: 'Added after the invoice', count: 1 }, { code: 'completedAfterInvoice', tag: 'Completed after the invoice', count: 2 },
    { code: 'noWeeklyInvoice', tag: 'No weekly invoice', count: 1 }, { code: 'unexplained', tag: 'No known reason', count: 1 },
  ])
  eq('five sections, the fifth with two lists', VIEW.sections.map((s) => [s.key, s.parts.map((p) => p.key)]), [
    ['ledgerDays', ['ledgerDays']], ['invoiceDays', ['invoiceDays']], ['personalLines', ['personalLines']], ['pendingReceipts', ['pendingReceipts']], ['waiting', ['correctionDrafts', 'percentageLoads']],
  ])
  const part = (k) => VIEW.sections.flatMap((s) => s.parts).find((p) => p.key === k)
  eq('days no invoice pays: grouped per driver and week, in the server\'s order', part('ledgerDays').groups.map((g) => [g.label, g.rows.length]), [
    ['Avery Lund · Oct 3 – Oct 9, 2026', 2], ['Avery Lund · Oct 10 – Oct 16, 2026', 1], ['Blair Moss · Oct 3 – Oct 9, 2026', 1], ['Casey Rowe · Oct 3 – Oct 9, 2026', 1],
  ])
  eq('…each row: the day, its load, the week\'s invoice, the amount, the tag and the server\'s sentence as sent', part('ledgerDays').groups[0].rows[0],
    { key: 'ledgerDays:0', cells: { day: 'Oct 8, 2026', load: 'PX101', invoice: 'INV-AL-2026W41-01 (Submitted)', amount: '$260.00' }, tag: 'Completed after the invoice', text: SECTIONS_IN.ledgerDays[0].text })
  eq('…an added day names no load; a week with no invoice says None', [part('ledgerDays').groups[2].rows[0].cells, part('ledgerDays').groups[3].rows[0].cells],
    [{ day: 'Oct 7, 2026', load: 'Added day', invoice: 'INV-BM-2026W41-01 (Approved)', amount: '$262.37' }, { day: 'Oct 6, 2026', load: 'PX301', invoice: 'None', amount: '$260.00' }])
  eq('…its columns, then Why', [part('ledgerDays').columns.map((c) => c.label), part('ledgerDays').reasons], [['Day', 'Load', 'Week\'s invoice', 'Amount'], true])
  eq('days an invoice paid that the books no longer count', part('invoiceDays').groups.map((g) => [g.label, g.rows.map((r) => [r.cells, r.tag])]), [
    ['Drew Pike · Oct 10 – Oct 16, 2026', [[{ day: 'Oct 13, 2026', invoice: 'INV-DP-2026W42-01 (Draft)', load: 'PX401', amount: '$260.00' }, 'Removed on overrides']]],
  ])
  eq('Personal lines: the receipt, the amount (and a share returned), the tag; drivers in the server\'s order', part('personalLines').groups.map((g) => [g.label, g.rows.map((r) => [r.cells, r.tag])]), [
    ['Emery Tull · Oct 3 – Oct 9, 2026', [[{ date: 'Oct 6, 2026', vendor: 'Made-up Diner', amount: '$30.00 (share returned +$9.00)' }, 'Waiting for its invoice']]],
    ['Gray Unlisted · Oct 3 – Oct 9, 2026', [[{ date: 'Oct 7, 2026', vendor: 'Made-up Fuel Stop', amount: '$45.50' }, 'Driver not in the Drivers Database']]],
  ])
  eq('receipts still Pending: no reason column (a person decides each)', [part('pendingReceipts').reasons, part('pendingReceipts').groups[0].rows[0].cells],
    [false, { date: 'Oct 14, 2026', type: 'Maintenance', load: '—', amount: '$61.25' }])
  eq('correction invoices waiting: what each is for, what it corrects, its total due as sent (a credit too)', part('correctionDrafts').groups.map((g) => [g.label, g.rows[0].cells]), [
    ['Finley Hart · Oct 3 – Oct 9, 2026', { invoice: 'INV-M-FH-2026W41-01', status: 'Draft', kind: 'Missed days', corrects: 'INV-FH-2026W41-01', amount: '$520.00' }],
    ['Finley Hart · Oct 10 – Oct 16, 2026', { invoice: 'INV-M-FH-2026W42-01', status: 'Submitted', kind: 'Personal', corrects: '—', amount: '-$45.50' }],
  ])
  eq('percentage drivers\' loads: revenue as the books read it, or a dash; an undated load in no week (first, as the server sorts it)', part('percentageLoads').groups.map((g) => [g.label, g.rows[0].cells, g.rows[0].tag]), [
    ['Emery Tull · no week', { load: 'PX503', completed: 'No date', amount: '—' }, 'Load has no date'],
    ['Emery Tull · Oct 3 – Oct 9, 2026', { load: 'PX502', completed: 'Oct 9, 2026', amount: '$2,000.00' }, 'Completed after the invoice'],
  ])
  // The undated load's revenue is unknown in its list (a dash) and 0 in the server's roll-up sum: each as sent.
  eq('the roll-up: one row per driver and week, the server\'s count and amount per list', VIEW.drivers.map((r) => [r.driver, r.week, r.cells.filter((c) => c.count).map((c) => `${c.key} ${c.text}`)]), [
    ['Avery Lund', 'Oct 3 – Oct 9, 2026', ['ledgerDays 2 · $520.00']],
    ['Avery Lund', 'Oct 10 – Oct 16, 2026', ['ledgerDays 1 · $260.00', 'pendingReceipts 1 · $61.25']],
    ['Blair Moss', 'Oct 3 – Oct 9, 2026', ['ledgerDays 1 · $262.37']],
    ['Casey Rowe', 'Oct 3 – Oct 9, 2026', ['ledgerDays 1 · $260.00']],
    ['Drew Pike', 'Oct 10 – Oct 16, 2026', ['invoiceDays 1 · $260.00']],
    ['Emery Tull', 'no week', ['percentageLoads 1 · $0.00']],
    ['Emery Tull', 'Oct 3 – Oct 9, 2026', ['personalLines 1 · $30.00', 'percentageLoads 1 · $2,000.00']],
    ['Finley Hart', 'Oct 3 – Oct 9, 2026', ['correctionDrafts 1 · $520.00']],
    ['Finley Hart', 'Oct 10 – Oct 16, 2026', ['correctionDrafts 1 · -$45.50']],
    ['Gray Unlisted', 'Oct 3 – Oct 9, 2026', ['personalLines 1 · $45.50']],
  ])
  eq('…an empty list in a row reads a dash', VIEW.drivers[0].cells.find((c) => c.key === 'invoiceDays').text, '—')
  eq('nothing to look at: every list empty, and said so', [lib.checkView(EMPTY_ANSWER).clear, VIEW.clear], [true, false])
  ok('the generated time is the business clock\'s, with its zone', /^Oct 17, 2026, 12:00 PM EDT$/.test(VIEW.generatedText), VIEW.generatedText)
}

// ------------------------------------------------------------------ in-memory mount
// No DOM: an in-memory renderer (the one scripts/test-deleted-loads-view.mjs uses).
globalThis.document = globalThis.document || { activeElement: null, addEventListener() {}, removeEventListener() {} }
globalThis.Document = globalThis.Document || class Document {}
globalThis.ShadowRoot = globalThis.ShadowRoot || class ShadowRoot {}
function mountInMemory(Comp, { components = {} } = {}) {
  const node = (type, tag) => Vue.markRaw({
    type, tag, children: [], parent: null, props: {}, text: '', value: '', listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn) },
    removeEventListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((x) => x !== fn) },
    getRootNode() { return {} },
    focus() {},
  })
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
    patchProp(el, key, prev, next) {
      el.props[key] = next
      if (key === 'value') el.value = next
    },
  }
  const warnings = []
  const root = node('el', 'root')
  const app = Vue.createRenderer(ops).createApp(Comp)
  for (const [name, c] of Object.entries(components)) app.component(name, c)
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
    root, warnings,
    findAll: (pred, from = root) => all(from, pred),
    find: (pred, from = root) => all(from, pred)[0] || null,
    text: (n = root) => textOf(n).replace(/\s+/g, ' ').trim(),
    unmount: () => app.unmount(),
  }
}
const drain = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }
const evt = (el) => ({ preventDefault() {}, stopPropagation() {}, target: el, currentTarget: el })
async function press(el) {
  if (!el || (el.props.disabled != null && el.props.disabled !== false)) return
  const fns = Array.isArray(el.props.onClick) ? el.props.onClick : [el.props.onClick]
  for (const fn of fns) if (typeof fn === 'function') { const r = fn(evt(el)); if (r && r.catch) r.catch(() => {}) }
  await drain()
}
async function choose(el, value) {
  if (!el) return
  el.value = value
  const fns = Array.isArray(el.props.onChange) ? el.props.onChange : [el.props.onChange]
  for (const fn of fns) if (typeof fn === 'function') fn(evt(el))
  await drain()
}

// A committed SFC's <script setup> + <template> as a component of its imports; every import must be
// given, a default import as { default }.
function factory(rel) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) return null
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), { filename: path.basename(file) })
  let body = compileScript(descriptor, { id: path.basename(file), inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
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
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${rel}: an import or export this harness cannot map`)
  return (deps) => {
    const missing = specs.filter((s) => s !== 'vue' && !Object.prototype.hasOwnProperty.call(deps, s))
    if (missing.length) throw new Error(`${rel}: no stub for ${missing.join(', ')}`)
    return new Function('__deps', body)({ vue: Vue, ...deps })
  }
}
const RouterLinkStub = Vue.defineComponent({
  name: 'RouterLink',
  props: { to: { type: [String, Object], default: null } },
  setup(props, { slots, attrs }) {
    return () => Vue.h('a', { ...attrs, 'data-to': JSON.stringify(props.to) }, slots.default ? slots.default() : [])
  },
})
// A GET the test answers: `answer(url, n)` returns the body or throws an error as useApi() does.
function fakeApi(answer) {
  const api = { gets: [], writes: [] }
  api.get = async (url) => { api.gets.push(url); return answer(url, api.gets.length) }
  for (const m of ['post', 'put', 'patch', 'del', 'request']) api[m] = async (url) => { api.writes.push(`${m} ${url}`); return {} }
  return api
}
const auth = (role) => ({ useAuthStore: () => ({ user: role ? { role } : null, isSuperAdmin: role === 'Super Admin' }) })

// ------------------------------------------------------------------ §4 the link on Invoices
section('§4 the Invoices link: a Super Admin\'s, once the route says the switch is on; asked once per page')
const LINK_MAKE = factory(LINK)
ok(`${LINK} exists`, !!LINK_MAKE)
ok(`${SWITCH} exists`, exists(SWITCH))
let switchCase = 0
async function freshSwitch() {
  switchCase++
  return import(`${pathToFileURL(path.join(ROOT, SWITCH)).href}?case=${switchCase}`)
}
async function mountLink(role, answer, { mod = null } = {}) {
  const api = fakeApi(answer)
  const sw = mod || await freshSwitch()
  const Comp = LINK_MAKE({
    '../../composables/useApi': { useApi: () => api },
    '../../stores/auth': auth(role),
    '../../composables/usePayrollCheckSwitch.js': sw,
    '../../lib/payrollCheck.js': lib,
  })
  const m = mountInMemory(Comp, { components: { RouterLink: RouterLinkStub } })
  await drain()
  return { m, api, sw, link: () => m.find((n) => n.tag === 'a') }
}
let linkOk = false
if (LINK_MAKE && lib && exists(SWITCH)) {
  try { linkOk = !!(await mountLink('Super Admin', () => { throw apiError(404, 'off', 'FEATURE_OFF') })) } catch (err) { console.log(`  (the link did not mount: ${err.message})`) }
}
ok('the link mounts in this harness', linkOk)
if (linkOk) {
  const on = await mountLink('Super Admin', () => { throw apiError(400, 'weekEnd must be a day, as YYYY-MM-DD: the Friday that ends the last week to check.', 'PAYROLL_CHECK_WEEK_END_INVALID') })
  eq('Super Admin, switched on: the route is asked once, with no week (it refuses the missing week before reading anything)', on.api.gets, [CHECK_URL])
  eq('…the link shows, to the page, in plain words', [!!on.link(), on.link() && on.link().props['data-to'], on.m.text()], [true, JSON.stringify({ name: 'invoices-payroll-check' }), lib.WORDS.link])
  eq('…and Vue warns of nothing', on.m.warnings, [])
  const off = await mountLink('Super Admin', () => { throw apiError(404, 'The before-payroll check is switched off on this server.', 'FEATURE_OFF') })
  eq('Super Admin, switched off (404 FEATURE_OFF): no link', [off.api.gets, off.m.text(), !!off.link()], [[CHECK_URL], '', false])
  for (const [label, err] of [['a 503', apiError(503, 'The month locks cannot be read.', 'PERIOD_LOCK_UNREADABLE')], ['a 429', apiError(429, 'Too many payroll checks.')], ['no answer', Object.assign(new Error('timed out'), { status: 0, code: 'TIMEOUT' })]]) {
    const r = await mountLink('Super Admin', () => { throw err })
    eq(`Super Admin, ${label}: no link (unknown is off)`, [r.m.text(), !!r.link()], ['', false])
  }
  const twice = await mountLink('Super Admin', () => { throw apiError(400, 'no week', 'PAYROLL_CHECK_WEEK_END_INVALID') })
  const again = await mountLink('Super Admin', () => { throw apiError(400, 'no week', 'PAYROLL_CHECK_WEEK_END_INVALID') }, { mod: twice.sw })
  eq('…a second Invoices visit on the same page asks nothing more', [twice.api.gets.length, again.api.gets.length, !!again.link()], [1, 0, true])
  const told = await freshSwitch()
  told.notePayrollCheckSwitch(true)
  const known = await mountLink('Super Admin', () => { throw new Error('asked') }, { mod: told })
  eq('…nor once the page itself has had an answer', [known.api.gets, !!known.link()], [[], true])
  for (const role of ROLES_NOT_SA) {
    const r = await mountLink(role, () => ANSWER)
    eq(`${role || 'no user'}: no link, and the route is never asked`, [r.m.text(), !!r.link(), r.api.gets], ['', false, []])
  }
  eq('the link sends no write', [on.api.writes, off.api.writes], [[], []])
}

// ------------------------------------------------------------------ §5 the page
section('§5 the page: Super Admin only; the default week; a week picked; off, refused, 503 and Try again; table or cards')
const PAGE_MAKE = factory(PAGE)
ok(`${PAGE} exists`, !!PAGE_MAKE)
async function mountPage({ role = 'Super Admin', mobile = false, answer = () => ANSWER } = {}) {
  const api = fakeApi(answer)
  const notes = []
  const Comp = PAGE_MAKE({
    '../composables/useApi': { useApi: () => api },
    '../composables/useViewport': { useViewport: () => ({ isMobile: Vue.ref(mobile) }) },
    '../composables/useElementWidth': { useElementWidth: () => ({ width: Vue.ref(0) }) },
    '../stores/auth': auth(role),
    '../utils/datetime': { appToday: () => TODAY },
    '../composables/usePayrollCheckSwitch.js': { notePayrollCheckSwitch: (v) => notes.push(v) },
    '../lib/payrollCheck.js': lib,
  })
  const m = mountInMemory(Comp, { components: { RouterLink: RouterLinkStub } })
  await drain()
  const byTest = (id) => m.find((n) => n.props['data-testid'] === id)
  const allByTest = (id) => m.findAll((n) => n.props['data-testid'] === id)
  return {
    m, api, notes, byTest, allByTest,
    select: () => m.find((n) => n.tag === 'select'),
    button: (label) => m.find((n) => n.tag === 'button' && m.text(n) === label),
    tables: () => m.findAll((n) => n.tag === 'table'),
    cards: () => allByTest('pc-card'),
  }
}
let pageOk = false
if (PAGE_MAKE && lib) {
  try { pageOk = !!(await mountPage()) } catch (err) { console.log(`  (the page did not mount: ${err.message})`) }
}
ok('the page mounts in this harness', pageOk)
if (pageOk) {
  const W = lib.WORDS
  for (const role of ROLES_NOT_SA) {
    const p = await mountPage({ role })
    eq(`${role || 'no user'}: nothing rendered, and the route is never asked`, [p.m.text(), p.api.gets], ['', []])
  }

  const p = await mountPage()
  eq('Super Admin: one request, for the last finished week by the business clock', p.api.gets, [`${CHECK_URL}?weekEnd=2026-10-16`])
  eq('…the week picker: eight Fridays, that week chosen', [p.select() && p.select().value, p.m.findAll((n) => n.tag === 'option').map((o) => o.props.value)],
    ['2026-10-16', lib.weekOptions(TODAY).map((w) => w.value)])
  eq('…the switch is noted on, for the Invoices link', p.notes, [true])
  const txt = p.m.text()
  ok('…the title, the week and the range checked', [W.title, VIEW && VIEW.weekText, VIEW && VIEW.scopeText].every((s) => s && txt.includes(s)), txt.slice(0, 300))
  ok('…each section\'s title', VIEW && VIEW.sections.every((s) => txt.includes(s.title)))
  eq('…the server\'s totals, each count and amount as the view gives them', p.allByTest('pc-total').map((t) => [p.m.text(p.m.find((n) => n.props['data-testid'] === 'pc-total-count', t)), p.m.text(p.m.find((n) => n.props['data-testid'] === 'pc-total-amount', t))]),
    VIEW ? VIEW.totals.map((t) => [String(t.count), t.amount]) : null)
  const rows = p.allByTest('pc-row')
  const allRows = VIEW ? VIEW.sections.flatMap((s) => s.parts).flatMap((pt) => pt.groups.flatMap((g) => g.rows.map((r) => ({ pt, r })))) : []
  eq('…every item a row, in the server\'s order', rows.length, allRows.length)
  eq('…each row\'s cells, tag and sentence as the view gives them', rows.map((n) => [
    p.m.findAll((c) => c.props['data-cell'] != null, n).map((c) => p.m.text(c)),
    p.m.text(p.m.find((c) => c.props['data-testid'] === 'pc-tag', n)),
    p.m.text(p.m.find((c) => c.props['data-testid'] === 'pc-why', n)),
  ]), allRows.map(({ pt, r }) => [pt.columns.map((c) => r.cells[c.key]), pt.reasons ? r.tag : '', pt.reasons ? r.text : '']))
  eq('…each driver and week\'s heading', p.allByTest('pc-group').map((n) => p.m.text(n)), VIEW ? VIEW.sections.flatMap((s) => s.parts).flatMap((pt) => pt.groups.map((g) => g.label)) : null)
  eq('…the roll-up, one row per driver and week', p.allByTest('pc-rollup-row').map((n) => p.m.text(n)),
    VIEW ? VIEW.drivers.map((r) => [r.driver, r.week, ...r.cells.map((c) => c.text)].join(' ')) : null)
  eq('…on a desktop: tables, no cards', [p.tables().length > 0, p.cards().length], [true, 0])
  eq('…and Vue warns of nothing', p.m.warnings, [])

  await choose(p.select(), '2026-10-09')
  eq('a week picked: one more request, for that week', p.api.gets, [`${CHECK_URL}?weekEnd=2026-10-16`, `${CHECK_URL}?weekEnd=2026-10-09`])
  await press(p.button(W.again))
  eq('Check again: the same week asked again', p.api.gets.slice(-1), [`${CHECK_URL}?weekEnd=2026-10-09`])
  eq('…only GETs, ever', p.api.writes, [])

  const phone = await mountPage({ mobile: true })
  eq('on a phone: cards, no table, one per item', [phone.tables().length, phone.cards().length], [0, allRows.length])
  eq('…the roll-up as cards too, one per driver and week', phone.allByTest('pc-rollup-row').length, VIEW ? VIEW.drivers.length : null)
  eq('…and Vue warns of nothing', phone.m.warnings, [])
  const card = phone.cards()[0]
  ok('…a card holds each field\'s label and value, the tag and the server\'s sentence', !!card && VIEW
    && [...VIEW.sections[0].parts[0].columns.map((c) => c.label), allRows[0].r.cells.day, allRows[0].r.tag, allRows[0].r.text].every((s) => phone.m.text(card).includes(s)), card ? phone.m.text(card) : 'no card')

  const off = await mountPage({ answer: () => { throw apiError(404, 'The before-payroll check is switched off on this server.', 'FEATURE_OFF') } })
  eq('switched off: the plain line, no week picker, no list, the switch noted off', [off.m.text().includes(W.off), !!off.select(), off.allByTest('pc-row').length, off.allByTest('pc-total').length, off.notes],
    [true, false, 0, 0, [false]])
  ok('…and nothing else but the title and the way back', off.m.text() === `${W.title} ${W.intro} ${W.back} ${W.off}`, off.m.text())

  const closed = 'The week ending 2026-09-25 lies wholly in closed months (the latest closed month is 2026-09); the earliest week to check ends 2026-10-02.'
  const refused = await mountPage({ answer: () => { throw apiError(400, closed, 'PAYROLL_CHECK_WEEK_CLOSED') } })
  eq('a 400: the server\'s words, the picker kept to pick another week, no list, no Try again', [
    refused.m.text(refused.byTest('pc-refused')), !!refused.select(), refused.allByTest('pc-row').length, !!refused.button(W.retry),
  ], [closed, true, 0, false])

  let calls = 0
  const busy = await mountPage({ answer: () => { calls++; if (calls === 1) throw apiError(503, 'The month locks cannot be read, so the open months cannot be told. Try again in a moment.', 'PERIOD_LOCK_UNREADABLE'); return ANSWER } })
  eq('a 503: a retry line in the server\'s words, with Try again', [busy.m.text(busy.byTest('pc-retry')).startsWith('The month locks cannot be read'), !!busy.button(W.retry), busy.allByTest('pc-row').length], [true, true, 0])
  await press(busy.button(W.retry))
  eq('…Try again asks the same week again, and the answer shows', [busy.api.gets, busy.allByTest('pc-row').length, !!busy.byTest('pc-retry')],
    [[`${CHECK_URL}?weekEnd=2026-10-16`, `${CHECK_URL}?weekEnd=2026-10-16`], allRows.length, false])
  const gateway = await mountPage({ answer: () => { throw apiError(503, '') } })
  ok('…a 503 with no words: the plain retry line', gateway.m.text(gateway.byTest('pc-retry')).includes(W.retryLine), gateway.m.text())

  const failed = await mountPage({ answer: () => ({ weekEnd: '2026-10-16' }) })
  ok('an answer not in the route\'s shape: a plain line with Try again, no list', failed.m.text().includes(W.failed) && !!failed.button(W.retry) && failed.allByTest('pc-row').length === 0, failed.m.text())

  const clear = await mountPage({ answer: () => EMPTY_ANSWER })
  ok('nothing to look at: said once, and each section says it is empty', clear.m.text().includes(W.allClear) && clear.allByTest('pc-empty').length === 6, clear.m.text())

  let slowResolve = null
  let n = 0
  const race = await mountPage({ answer: (url) => { n++; if (n === 1) return new Promise((r) => { slowResolve = () => r(EMPTY_ANSWER) }); return ANSWER } })
  await choose(race.select(), '2026-10-09')
  slowResolve()
  await drain()
  eq('only the newest answer lands: a slow answer for an earlier week is dropped', [race.allByTest('pc-row').length, race.select().value], [allRows.length, '2026-10-09'])
}

// ------------------------------------------------------------------ §6 wiring
section('§6 wiring: the route Super Admin only, the link on Invoices, GET only, no v-html, no money worked out')
const ROUTER = read('client/src/router/index.js')
const routeBlock = (ROUTER.match(/\{\s*(?:\/\/[^\n]*\n\s*)*path: '\/invoices\/payroll-check',[\s\S]*?\n {2}\}/) || [''])[0]
ok('the page has a route, /invoices/payroll-check, named invoices-payroll-check', /name: 'invoices-payroll-check'/.test(routeBlock) && /PayrollCheckView\.vue/.test(routeBlock))
ok('…Super Admin only', /meta: \{ roles: \['Super Admin'\] \}/.test(routeBlock))
const INVOICES = read('client/src/views/InvoicesView.vue')
eq('Invoices shows the link once, to a Super Admin only', INVOICES.match(/<PayrollCheckLink\b[^>]*>/g) || [], ['<PayrollCheckLink v-if="auth.isSuperAdmin" />'])
ok('…imported from components/invoices', INVOICES.includes("import PayrollCheckLink from '../components/invoices/PayrollCheckLink.vue'"))
eq('…and keeps the one v-html it had (its cards\' fixed icons)', (INVOICES.match(/v-html/g) || []).length, 1)

const FILES = [LIB, SWITCH, LINK, PAGE]
// Arithmetic beside a money word ("-" only with a space before it, so a class name such as
// pc-total-amount is not read as a sum), or any number formatting but the lib's one helper.
const MONEY = '(?:cents|amount|total|share|payment|revenue)'
const ARITHMETIC = new RegExp(`(?<![\\w-])${MONEY}\\w*(?:\\s*[*/+]|\\s+-)\\s*[\\w(]|[\\w)](?:\\s*[*/+]|\\s+-)\\s*${MONEY}\\w*(?![\\w-])|\\/\\s*100\\b|\\*\\s*100\\b|\\.reduce\\(|toFixed\\(|toLocaleString\\(|NumberFormat`, 'gi')
ok('the arithmetic pattern catches a planted sum, product and formatting', ['a.cents / 100', 'total + 1', 'x * amount', 'n.toFixed(2)', 'list.reduce((c, x) => c + x.cents, 0)', 'base - shareCents']
  .every((s) => { ARITHMETIC.lastIndex = 0; return ARITHMETIC.test(s) }))
ok('…and passes a class name and a date step', ['class="pc-total-amount"', 'shiftYmd(end, -7 * i)', 'formatMoneyCents(Math.abs(cents))'].every((s) => { ARITHMETIC.lastIndex = 0; return !ARITHMETIC.test(s) }))
for (const f of FILES) {
  const src = code(read(f))
  ok(`${f}: exists`, src.length > 0)
  eq(`${f}: GET is the only request (no post, put, patch, delete or fetch)`, src.match(/\bapi\.(?:post|put|patch|del|request)\(|\bfetch\(/g) || [], [])
  eq(`${f}: no v-html`, src.match(/v-html|innerHTML/g) || [], [])
  eq(`${f}: no money computed or formatted (no sum, product, share or number formatting of a figure)`, src.match(ARITHMETIC) || [], [])
}
for (const f of [LINK, PAGE]) {
  eq(`${f}: reads no raw figure (every amount comes through the lib's view)`, code(read(f)).match(/\w*[cC]ents\b/g) || [], [])
}
const libSrc = code(read(LIB))
ok('the lib turns cents into dollars with the app\'s formatMoneyCents() only, in one place',
  libSrc.includes("import { formatMoneyCents } from './paymentTerms.js'") && (libSrc.match(/formatMoneyCents\(/g) || []).length === 1)
ok('…and the page reads the business day, never the browser\'s', code(read(PAGE)).includes("import { appToday } from '../utils/datetime'") && !/new Date\(/.test(code(read(PAGE)) + libSrc))

section('§7 the Invoices header wraps at every width: one row while it fits, the actions under the title when not; the link tall enough to tap on a phone')
// Each block of a file's styles that starts with `head` (every @media block by default), up to its own
// closing brace, and the styles with those blocks taken out.
function mediaBlocks(src, head = '@media') {
  const style = code(String(src).split('<style')[1] || '')
  const blocks = []
  let rest = ''
  let from = 0
  for (let at = style.indexOf(head); at !== -1; at = style.indexOf(head, from)) {
    rest += style.slice(from, at)
    let depth = 0
    let i = style.indexOf('{', at)
    for (; i < style.length; i++) {
      if (style[i] === '{') depth++
      else if (style[i] === '}' && --depth === 0) break
    }
    blocks.push(style.slice(at, i + 1))
    from = i + 1
  }
  return { blocks: blocks.join('\n'), rest: rest + style.slice(from) }
}
const rule = (css, sel) => (css.match(new RegExp(`(?:^|[\\s,}])${sel.replace(/[.\\-]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`)) || [])[1] || ''
{
  ok('the header, its title and its actions carry their own classes, beside the classes they had',
    /<div class="dash-header inv-header">/.test(INVOICES) && /<div class="inv-header-title">/.test(INVOICES) && /<div class="flex items-center gap-3 inv-header-actions">/.test(INVOICES))
  const inv = mediaBlocks(INVOICES)
  ok('at every width the header wraps (its rule is in no @media block)', /flex-wrap:\s*wrap/.test(rule(inv.rest, '.inv-header')), rule(inv.rest, '.inv-header') || 'no rule outside @media')
  ok('…and its actions wrap and may be narrower than their buttons in a row', /flex-wrap:\s*wrap/.test(rule(inv.rest, '.inv-header-actions')) && /min-width:\s*0/.test(rule(inv.rest, '.inv-header-actions')),
    rule(inv.rest, '.inv-header-actions') || 'no rule outside @media')
  // The row breaks on the title's basis, not its full width: a basis of at most 16rem keeps the
  // actions beside the title wherever the two fit, and the title grows into what is left.
  const basis = rule(inv.rest, '.inv-header-title').match(/flex:\s*1\s+1\s+([\d.]+)rem/)
  ok('…the title grows and breaks the row on a small basis (at most 16rem), and may shrink',
    !!basis && Number(basis[1]) > 0 && Number(basis[1]) <= 16 && /min-width:\s*0/.test(rule(inv.rest, '.inv-header-title')), rule(inv.rest, '.inv-header-title') || 'no rule outside @media')
  eq('…and no @media block touches the header, so no width is left without the wrap', inv.blocks.match(/\.inv-header[\w-]*/g) || [], [])
  const link = mediaBlocks(read(LINK), '@media (max-width: 767px) {')
  const tall = rule(link.blocks, '.payroll-check-link').match(/(?:^|[;\s])(?:min-)?height:\s*([\d.]+)rem/)
  ok('on a phone the link is at least 40 px tall (a finger\'s tap)', !!tall && Number(tall[1]) * 16 >= 40, rule(link.blocks, '.payroll-check-link') || 'no phone rule')
  ok('…and beside the desktop buttons it keeps their 2.25rem', /height:\s*2\.25rem/.test(rule(link.rest, '.payroll-check-link')), rule(link.rest, '.payroll-check-link'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
