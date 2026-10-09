#!/usr/bin/env node
// The client's business zone moves from Houston to APP_TIMEZONE (US Eastern).
//
// WHY THIS EXISTS. The client decided on 2026-10-08 that every date and time in
// LogisX is US Eastern (America/New_York, EST and EDT by themselves). It replaced
// the 2026-08-04 rule "all time and date are Houston time". The zone is one
// setting, APP_TIMEZONE, which the server sends on GET /api/auth/session. So every
// Houston pin in client/src moves to it:
//   - a time that carries its zone renders in the app zone, labelled (EDT/EST);
//   - "today" defaults and an instant's day are the app zone's;
//   - the driver invoice tab's Friday 6:30 PM cutoff is read on the app zone's
//     clock, as the server's isAfterDeadline() is;
//   - the viewer-zone echo shows for a browser outside the app zone;
//   - a bare sheet stamp resolves by its era: UTC before 2026-08-03, Houston to
//     2026-10-08, the app zone from 2026-10-09 (stored stamps are never rewritten).
// Under the old pins, 11:30 PM Central on Oct 13 read "Oct 13 ... CDT" and was
// still Oct 13 for every default, while the business was already on Oct 14.
//
// HOW. As scripts/test-app-timezone-client.mjs: the corpus runs in four child
// processes, TZ=America/New_York, America/Chicago, Asia/Manila and UTC, and every
// child must pass and print byte-identical results. Chicago is in the set because
// a value read off the machine's clock there looks exactly like the old Houston
// pin. The viewer-zone echo is the one answer that SHOULD differ by machine, so
// each child reports it and the parent checks it per zone. Last, the parent reads
// client/src: no Houston pin, no hard-coded zone and no Central wording is left,
// and each fixed site imports and calls the shared helpers.
//
// No network, no DOM, no database: client/src under plain Node.
//
//   node scripts/test-app-zone-switch-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.join(path.dirname(SELF), '..')
const SRC = path.join(ROOT, 'client', 'src')
const url = (rel) => pathToFileURL(path.join(SRC, rel)).href
const CHILD_FLAG = 'APP_ZONE_SWITCH_CHILD'
// Each zone with its offset from UTC on 2026-10-14 (getTimezoneOffset's sign), so
// a child that silently ran in some other zone is caught.
const ZONES = [
  ['America/New_York', 240],
  ['America/Chicago', 300],
  ['Asia/Manila', -480],
  ['UTC', 0],
]

const NEEDED = ['setAppTimeZone', 'appTimeZone', 'appToday', 'appDayOf', 'fmtAppDate', 'fmtAppInstant', 'isAfterAppTime',
  'fmtTimestamp', 'fmtSheetMoment', 'fmtYmd', 'fmtArrivalClock', 'sheetSortKey', 'parseSheetStamp', 'viewerZoneNote']

// 11:30 PM Central on Tuesday Oct 13 = 12:30 AM Eastern on Wednesday Oct 14.
const A = '2026-10-14T04:30:00Z'

// ══ The corpus: runs inside each child ═══════════════════════════════════════
async function corpus() {
  const mod = await import(url('utils/datetime.js'))
  // A missing helper answers its own name instead of throwing, so every check
  // still runs and reports against code that lacks it.
  const dt = new Proxy(mod, { get: (m, k) => (typeof m[k] === 'function' ? m[k] : () => `missing ${String(k)}`) })
  const { presetRange } = await import(url('lib/financialsView.js'))
  const { monthBounds } = await import(url('components/investors/payoutBasis.js'))
  const checks = []
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    checks.push([label, a, a === e ? 'ok' : `expected ${e}`])
  }
  const local = { offset: new Date('2026-10-14T12:00:00Z').getTimezoneOffset() }

  check('utils/datetime.js exports the app-zone helpers', NEEDED.filter((n) => typeof mod[n] !== 'function'), [])
  check('houstonToday is gone: one helper per question, appToday', typeof mod.houstonToday, 'undefined')

  const at = (iso) => Date.parse(iso)
  const iso = (d) => (d ? d.toISOString() : null)
  const TIME = { hour: 'numeric', minute: '2-digit' }
  check('0.1 the zone in use is the default, America/New_York', dt.appTimeZone(), 'America/New_York')

  // ── (a) 11:30 PM Central on a weekday is already the next day ───────────────
  check('a.1 appToday and appDayOf at 11:30 PM CDT on Tue Oct 13 give Wed Oct 14',
    [dt.appToday(at(A)), dt.appDayOf(A), dt.appDayOf(at(A)), dt.appDayOf(new Date(A))], Array(4).fill('2026-10-14'))
  check('a.2 fmtTimestamp: the app zone, labelled EDT', dt.fmtTimestamp(A), 'Oct 14, 2026, 12:30 AM EDT')
  check('a.3 fmtSheetMoment on a zoned value: the same', dt.fmtSheetMoment(A), 'Oct 14, 2026, 12:30 AM EDT')
  check('a.4 fmtYmd on an instant: its app-zone date', dt.fmtYmd(A), 'Oct 14, 2026')
  check('a.5 fmtArrivalClock, from an epoch and from ISO with the weekday',
    [dt.fmtArrivalClock(at(A)), dt.fmtArrivalClock(A, { weekday: true })], ['Oct 14, 12:30 AM EDT', 'Wed, Oct 14, 12:30 AM EDT'])
  check('a.6 fmtAppInstant: a chat time, a list time, a labelled date, the default',
    [
      dt.fmtAppInstant(A, TIME),
      dt.fmtAppInstant(A, { month: 'short', day: 'numeric', ...TIME }),
      dt.fmtAppInstant(A, { month: 'short', day: 'numeric', year: 'numeric' }),
      dt.fmtAppInstant(A),
      dt.fmtAppInstant(new Date(A), { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    ],
    ['12:30 AM EDT', 'Oct 14, 12:30 AM EDT', 'Oct 14, 2026, EDT', 'Oct 14, 2026, 12:30 AM EDT', '12:30:00 AM EDT'])
  check('a.7 fmtAppInstant ignores a zone or a label it is handed: the zone is the setting, the label is always there',
    dt.fmtAppInstant(A, { ...TIME, timeZone: 'America/Chicago', timeZoneName: 'long' }), '12:30 AM EDT')
  check('a.8 fmtAppInstant gives the fallback for what is not an instant (a bare wall clock and a calendar date included)',
    ['', null, undefined, 'garbage', '10/13/2026 23:30', '2026-10-13', NaN, new Date('x')].map((v) => dt.fmtAppInstant(v)), Array(8).fill('—'))
  check('a.9 ...or the fallback it is given', [dt.fmtAppInstant('', { fallback: '' }), dt.fmtAppInstant('x', { ...TIME, fallback: 'x' })], ['', 'x'])
  check('a.10 sheetSortKey keys a zoned value on its app-zone clock', dt.sheetSortKey(A), '20261014003000')
  check('a.11 the Job Tracking "Assigned Date" default (M/D/YYYY) is the app-zone day',
    dt.fmtAppDate(at(A), { month: 'numeric', day: 'numeric', year: 'numeric' }), '10/14/2026')

  // ── (b) The switch from daylight time, Sun Nov 1 (and back, Sun 2027-03-14) ─
  const B = ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']
  check('b.1 1:30 AM twice on Nov 1: EDT, then EST', B.map((v) => dt.fmtAppInstant(v, TIME)), ['1:30 AM EDT', '1:30 AM EST'])
  check('b.2 ...both on Nov 1', B.map((v) => [dt.appDayOf(v), dt.appToday(at(v))]), [['2026-11-01', '2026-11-01'], ['2026-11-01', '2026-11-01']])
  check('b.3 fmtTimestamp across the switch', B.map((v) => dt.fmtTimestamp(v)), ['Nov 1, 2026, 1:30 AM EDT', 'Nov 1, 2026, 1:30 AM EST'])
  check('b.4 spring forward: 1:59 AM EST, then 3:00 AM EDT',
    ['2027-03-14T06:59:00Z', '2027-03-14T07:00:00Z'].map((v) => dt.fmtAppInstant(v, TIME)), ['1:59 AM EST', '3:00 AM EDT'])

  // ── (c) Month end ────────────────────────────────────────────────────────────
  const C1 = '2026-10-31T23:30:00-05:00' // 11:30 PM CDT on Oct 31
  const C2 = '2026-11-30T23:30:00-05:00' // 11:30 PM EST on Nov 30
  check('c.1 11:30 PM Central on Oct 31 is Nov 1 in the app zone',
    [dt.appDayOf(C1), dt.appToday(at(C1)), dt.fmtTimestamp(C1)], ['2026-11-01', '2026-11-01', 'Nov 1, 2026, 12:30 AM EDT'])
  check('c.2 11:30 PM Eastern on Nov 30 stays Nov 30',
    [dt.appDayOf(C2), dt.appToday(at(C2)), dt.fmtTimestamp(C2)], ['2026-11-30', '2026-11-30', 'Nov 30, 2026, 11:30 PM EST'])
  check('c.3 Financials "this month" and the payout-basis month read the app-zone day',
    [presetRange('thisMonth', dt.appToday(at(C1))), monthBounds(dt.appToday(at(C1))).start, presetRange('thisMonth', dt.appToday(at(C2)))],
    [{ from: '2026-11-01', to: '2026-11-01' }, '2026-11', { from: '2026-11-01', to: '2026-11-30' }])

  // ── (d) parseSheetStamp: three eras, picked by the stamp's own date ──────────
  check('d.1 UTC before 2026-08-03, Houston to 2026-10-08, the app zone from 2026-10-09',
    ['08/02/2026 9:05:00', '07/01/2026 00:12:00', '08/03/2026 9:05:00', '10/08/2026 9:05:00', '10/08/2026 23:59:59',
      '10/09/2026 0:00:00', '10/09/2026 9:05:00', '12/01/2026 9:05'].map((s) => iso(dt.parseSheetStamp(s))),
    ['2026-08-02T09:05:00.000Z', '2026-07-01T00:12:00.000Z', '2026-08-03T14:05:00.000Z', '2026-10-08T14:05:00.000Z', '2026-10-09T04:59:59.000Z',
      '2026-10-09T04:00:00.000Z', '2026-10-09T13:05:00.000Z', '2026-12-01T14:05:00.000Z'])
  dt.setAppTimeZone('Asia/Manila')
  check('d.2 the app-zone era follows the setting; the UTC and Houston eras are history and do not',
    ['08/02/2026 9:05:00', '10/08/2026 9:05:00', '10/09/2026 9:05:00'].map((s) => iso(dt.parseSheetStamp(s))),
    ['2026-08-02T09:05:00.000Z', '2026-10-08T14:05:00.000Z', '2026-10-09T01:05:00.000Z'])
  dt.setAppTimeZone('America/New_York')
  check('d.3 not a stamp, no instant', ['', 'garbage'].map((s) => dt.parseSheetStamp(s)), [null, null])

  // ── (e) The driver invoice tab's Friday 6:30 PM ET cutoff ────────────────────
  const FRI = '2026-10-09'
  check('e.1 Friday Oct 9, 6:30 PM EDT: not before, not AT it, from the next second on',
    ['2026-10-09T22:00:00Z', '2026-10-09T22:30:00Z', '2026-10-09T22:30:01Z', '2026-10-09T23:15:00Z', '2026-10-10T13:00:00Z', '2026-10-08T23:00:00Z']
      .map((t) => dt.isAfterAppTime(FRI, '18:30', at(t))),
    [false, false, true, true, true, false])
  check('e.2 ...and in EST, after the clocks went back', ['2026-11-06T23:30:00Z', '2026-11-06T23:30:01Z'].map((t) => dt.isAfterAppTime('2026-11-06', '18:30', at(t))), [false, true])
  check('e.3 no verdict without a real day, a real HH:MM and an instant',
    [['', '18:30', A], ['2026-02-30', '18:30', A], ['10/09/2026', '18:30', A], [FRI, '6:30 PM', A], [FRI, '24:00', A], [FRI, '18:30', NaN], [FRI, '18:30', 'garbage']]
      .map(([d, hm, now]) => dt.isAfterAppTime(d, hm, typeof now === 'string' && now !== 'garbage' ? at(now) : now)),
    Array(7).fill(false))
  check('e.4 "now" defaults to the clock', [dt.isAfterAppTime('2000-01-07', '18:30'), dt.isAfterAppTime('2999-01-04', '18:30')], [true, false])

  // ── (f) The zone is a setting, not a constant ────────────────────────────────
  check('f.1 setAppTimeZone(America/Chicago) takes it', dt.setAppTimeZone('America/Chicago'), 'America/Chicago')
  check('f.2 Chicago: 04:30Z on Oct 14 is 11:30 PM CDT on Oct 13 everywhere',
    [dt.appToday(at(A)), dt.fmtTimestamp(A), dt.fmtAppInstant(A, TIME), dt.fmtArrivalClock(at(A)), dt.fmtYmd(A), dt.sheetSortKey(A)],
    ['2026-10-13', 'Oct 13, 2026, 11:30 PM CDT', '11:30 PM CDT', 'Oct 13, 11:30 PM CDT', 'Oct 13, 2026', '20261013233000'])
  check('f.3 Chicago: the cutoff follows (7:15 PM EDT is 6:15 PM CDT, not yet)', dt.isAfterAppTime(FRI, '18:30', at('2026-10-09T23:15:00Z')), false)
  check('f.4 Chicago: a stamp from the app-zone era is a Chicago wall clock', iso(dt.parseSheetStamp('10/09/2026 9:05:00')), '2026-10-09T14:05:00.000Z')
  check('f.5 back to the default', dt.setAppTimeZone('America/New_York'), 'America/New_York')
  check('f.6 ...and the formatters follow it back', dt.fmtTimestamp(A), 'Oct 14, 2026, 12:30 AM EDT')

  // The viewer-zone echo depends on the machine by design; the parent checks it.
  const notes = [dt.viewerZoneNote(A), dt.viewerZoneNote('10/13/2026 23:30')]
  dt.setAppTimeZone('America/Chicago')
  notes.push(dt.viewerZoneNote(A))
  dt.setAppTimeZone('America/New_York')
  return { local, checks, notes }
}

if (process.env[CHILD_FLAG]) {
  process.stdout.write(JSON.stringify(await corpus()))
  process.exit(0)
}

// ══ The parent: four zones, one answer ═══════════════════════════════════════
let failed = 0
const fail = (msg) => {
  failed++
  console.error(`FAIL  ${msg}`)
}

const runs = ZONES.map(([tz, offset]) => {
  try {
    const out = execFileSync(process.execPath, [SELF], { env: { ...process.env, TZ: tz, [CHILD_FLAG]: '1' }, encoding: 'utf8' })
    return { tz, offset, report: JSON.parse(out) }
  } catch (err) {
    return { tz, offset, crash: String((err && (err.stderr || err.message)) || err) }
  }
})

console.log('App-zone switch, client (client/src/utils/datetime.js), run once per machine zone:')
for (const r of runs) {
  if (r.crash) {
    fail(`TZ=${r.tz}: the child crashed\n${r.crash}`)
    continue
  }
  const { local, checks } = r.report
  if (local.offset !== r.offset) fail(`TZ=${r.tz}: the child ran at UTC offset ${-local.offset} min, not ${-r.offset}: the zone did not take effect`)
  const bad = checks.filter(([, , verdict]) => verdict !== 'ok')
  for (const [label, actual, verdict] of bad) fail(`TZ=${r.tz}  ${label}\n        ${verdict}\n        actual   ${actual}`)
  console.log(`  ${r.tz.padEnd(17)} ${String(checks.length - bad.length).padStart(3)}/${checks.length} pass`)
}

const done = runs.filter((r) => r.report)
if (done.length === ZONES.length) {
  const [first, ...rest] = done.map((r) => JSON.stringify(r.report.checks))
  const same = rest.every((s) => s === first)
  if (!same) fail('the four zones did not print identical results (a value still depends on the machine zone)')
  console.log(`  identical results in all four zones: ${same ? 'yes' : 'NO'}`)
}

// The echo: '' for a browser already in the app zone, else the same instant on
// the viewer's own clock. A bare wall clock has no instant, so never an echo.
// The third value is with the setting on Chicago.
const NOTES = {
  'America/New_York': ['', '', '(Your time: Oct 14, 12:30 AM)'],
  'America/Chicago': ['(Your time: Oct 13, 11:30 PM)', '', ''],
  'Asia/Manila': ['(PH Time: Oct 14, 12:30 PM)', '', '(PH Time: Oct 14, 12:30 PM)'],
  UTC: ['(Your time: Oct 14, 4:30 AM)', '', '(Your time: Oct 14, 4:30 AM)'],
}
let notesOk = 0
for (const r of done) {
  const a = JSON.stringify(r.report.notes)
  const e = JSON.stringify(NOTES[r.tz])
  if (a === e) notesOk++
  else fail(`TZ=${r.tz}  viewerZoneNote: the echo shows only outside the app zone\n        expected ${e}\n        actual   ${a}`)
}
console.log(`  viewer-zone echo right for each machine zone: ${notesOk}/${ZONES.length}`)

// ══ client/src: no Houston pin, no hard-coded zone ═══════════════════════════
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.(vue|js|mjs|ts)$/.test(e.name) ? [p] : []
  })
}
const files = walk(SRC).map((p) => ({ rel: path.relative(ROOT, p).split(path.sep).join('/'), src: fs.readFileSync(p, 'utf8') }))
const DATETIME = 'client/src/utils/datetime.js'
const datetimeSrc = files.find((f) => f.rel === DATETIME).src

// Left on purpose, each with its reason. Anything else that names a zone fails.
const KEEP_ZONE_LINES = []
const IANA_RE = /['"`](?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|US|Canada|Mexico|Brazil|Chile)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?['"`]/
const strayZones = []
for (const f of files) {
  if (f.rel === DATETIME) continue
  f.src.split('\n').forEach((line, i) => {
    if (!IANA_RE.test(line)) return
    if (KEEP_ZONE_LINES.some(([rel, text]) => rel === f.rel && line.includes(text))) return
    strayZones.push(`${f.rel}:${i + 1}`)
  })
}
if (strayZones.length) fail(`a hard-coded zone outside utils/datetime.js (use appTimeZone() through the helpers):\n        ${strayZones.join('\n        ')}`)
for (const [rel, text] of KEEP_ZONE_LINES) {
  const f = files.find((x) => x.rel === rel)
  if (!f || !f.src.includes(text)) fail(`${rel}: the line kept on purpose is gone; drop it from KEEP_ZONE_LINES`)
}

// In utils/datetime.js the zones are the setting's default, the Manila label of
// the viewer echo, and Houston only as the history of the 2026-08-03..10-08 stamps.
const zonesInDatetime = [...new Set((datetimeSrc.match(new RegExp(IANA_RE.source, 'g')) || []).map((s) => s.slice(1, -1)))].sort()
if (JSON.stringify(zonesInDatetime) !== JSON.stringify(['America/Chicago', 'America/New_York', 'Asia/Manila'])) {
  fail(`utils/datetime.js names the zones ${JSON.stringify(zonesInDatetime)}; expected only the default, the Manila label and the Houston stamp era`)
}
if (!/^const SHEET_STAMP_HOUSTON_ZONE = 'America\/Chicago'$/m.test(datetimeSrc)) fail('utils/datetime.js: America/Chicago may appear only as SHEET_STAMP_HOUSTON_ZONE')
// lib/app-time.js on the server holds the same two names and values.
for (const line of ["const SHEET_STAMP_HOUSTON_FROM = '2026-08-03'", "const SHEET_STAMP_APP_ZONE_FROM = '2026-10-09'"]) {
  if (!new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(datetimeSrc)) fail(`utils/datetime.js lacks the line: ${line}`)
}

const houstonNames = files.flatMap((f) => (/\bhoustonToday\b|\bHOUSTON(?:_TZ)?\b|\bcstNow\b|\bcentralDay\b/.test(f.src) ? [f.rel] : []))
if (houstonNames.length) fail(`Houston-named helpers or constants remain in: ${houstonNames.join(', ')}`)

// What a person can read: no Central/Houston wording in any template.
const centralWords = []
for (const f of files.filter((x) => x.rel.endsWith('.vue'))) {
  const m = /<template>([\s\S]*)<\/template>/.exec(f.src)
  const tpl = m ? m[1].replace(/<!--[\s\S]*?-->/g, '') : ''
  const hit = tpl.match(/\b(?:CST|CDT|CT|Central Time|Central time|Houston time|Houston)\b/)
  if (hit) centralWords.push(`${f.rel} ("${hit[0]}")`)
}
if (centralWords.length) fail(`Central or Houston wording on screen:\n        ${centralWords.join('\n        ')}`)

// ══ The fixed sites import and call the helpers ══════════════════════════════
// `imports` must be named in the file's import from utils/datetime; `has` must
// appear and `gone` must not.
const SITES = [
  ['client/src/components/driver/InvoiceTab.vue', ['appTimeZone', 'appToday', 'isAfterAppTime', 'satFriWeekOf', 'shiftYmd'],
    ["isAfterAppTime(weekEnd.value, '18:30')", 'Friday 6:30 PM {{ zoneLabel }}', "zoneName('shortGeneric')", "catch { return zoneName('short') }"], ['toLocaleString(', '6:30 PM CST', '6:30 PM ET)']],
  ['client/src/components/data-manager/AddRowModal.vue', ['fmtAppDate'],
    ["'Assigned Date': appDayText", "'Status Update Date': appDayText"], ['toLocaleDateString(']],
  ['client/src/components/shared/StatusTimeline.vue', ['fmtTimestamp', 'viewerZoneNote'],
    ['viewerZoneNote(p.startedAt)', 'viewerZoneNote(p.endedAt)'], ['resolvedOptions', 'Intl.DateTimeFormat']],
  ['client/src/components/dashboard/ChatBubble.vue', ['fmtAppInstant'], ['fmtAppInstant('], ['toLocaleTimeString(']],
  ['client/src/components/dashboard/MessagingPanel.vue', ['fmtAppInstant'], ['fmtAppInstant('], ['toLocaleTimeString(']],
  ['client/src/components/driver/ChatView.vue', ['fmtAppInstant'], ['fmtAppInstant('], ['toLocaleTimeString(']],
  ['client/src/components/investor/InvestorChat.vue', ['fmtAppInstant'], ['fmtAppInstant('], ['toLocaleString(']],
  ['client/src/components/dashboard/CompletedLoadsTab.vue', ['fmtAppInstant'], ['fmtAppInstant(ts, {'], ['new Intl.DateTimeFormat(']],
  ['client/src/components/dashboard/ExpensesTab.vue', ['appToday', 'fmtAppInstant'], ['fmtAppInstant(iso, {', 'date: appToday()', 'paidDate: appToday()'], ['toLocaleTimeString(']],
  ['client/src/components/dashboard/TrackingMap.vue', ['fmtAppInstant'], ['fmtAppInstant(ts, {'], ['toLocaleTimeString(']],
  ['client/src/views/InvoicesView.vue', ['appToday', 'fmtAppInstant'], ['invoices-${appToday()}.csv'], ['toLocaleDateString(\'en-CA\'', 'new Date(d).toLocaleString(', 'new Date(d).toLocaleDateString(']],
  ['client/src/views/ApplicationsView.vue', ['fmtAppInstant'], ['fmtAppInstant(d, {'], []],
  ['client/src/views/InvestorApplicationsView.vue', ['fmtAppInstant'], ['fmtAppInstant('], []],
  ['client/src/views/AdminToolsView.vue', ['fmtAppInstant'], ['fmtAppInstant(ts, {'], []],
  ['client/src/views/DashboardView.vue', ['fmtAppInstant'], ['fmtAppInstant(store.timestamp, {'], ['new Date(store.timestamp).toLocaleTimeString(']],
  ['client/src/components/users/UserTable.vue', ['fmtAppInstant', 'fmtTimestamp'], ['fmtAppInstant(dateStr, {'], ['toLocaleDateString(']],
  ['client/src/components/investors/InvestorInvitesPanel.vue', ['fmtAppDate', 'fmtTimestamp'], ['fmtAppDate(iso)'], ['new Intl.DateTimeFormat(']],
  ['client/src/components/investors/InvestorPaymentTermsSection.vue', ['fmtAppDate'], ['fmtAppDate('], ['new Intl.DateTimeFormat(']],
  ['client/src/components/apply/StepReferences.vue', ['appToday'], ['props.form.signature_date = appToday()'], []],
  ['client/src/components/driver/ExpenseForm.vue', ['appToday'], ['date: appToday()', 'const today = appToday()', 'defaultedDate.value = appToday()'], []],
  ['client/src/components/investor/EarningsSection.vue', ['appToday'], ['const todayStr = appToday()'], []],
  ['client/src/components/investor/ExpensesSection.vue', ['appToday'], ['const todayIso = computed(() => appToday())'], []],
  ['client/src/components/investors/PayoutBasisPanel.vue', ['appToday'], ['monthBounds(appToday(), '], []],
  ['client/src/views/FinancialsView.vue', ['appToday'], ['readSelection(route.query, appToday())'], []],
  ['client/src/views/NewJobView.vue', ['appToday'], ['const today = appToday()'], []],
]
const DATETIME_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*'(?:@\/|(?:\.\.?\/)+)utils\/datetime(?:\.js)?'/
let sitesOk = 0
for (const [rel, imports, has, gone] of SITES) {
  const f = files.find((x) => x.rel === rel)
  if (!f) {
    fail(`${rel} is missing`)
    continue
  }
  const m = DATETIME_IMPORT_RE.exec(f.src)
  const named = new Set(m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [])
  const problems = [
    ...imports.filter((n) => !named.has(n)).map((n) => `does not import ${n} from utils/datetime`),
    ...has.filter((s) => !f.src.includes(s)).map((s) => `lacks: ${s}`),
    ...gone.filter((s) => f.src.includes(s)).map((s) => `still has: ${s}`),
  ]
  for (const p of problems) fail(`${rel} ${p}`)
  if (!problems.length) sitesOk++
}
console.log(`\nNo stray zone, no Houston name, no Central wording: ${strayZones.length + houstonNames.length + centralWords.length ? 'NO' : 'yes'}`)
console.log(`Fixed sites call the helpers: ${sitesOk}/${SITES.length} files`)

if (failed) {
  console.error(`\n${failed} failure(s)`)
  process.exit(1)
}
console.log('\nPASS  the client reads dates and times in the app zone (APP_TIMEZONE)')
