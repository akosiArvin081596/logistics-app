#!/usr/bin/env node
// APP_TIMEZONE in the client: calendar dates stay calendar dates, and "today" and
// "the day this instant falls on" are the app's, never the viewer's.
//
// WHY THIS EXISTS. The owner decided two rules (2026-10-08):
//   D1. A date-only value ('YYYY-MM-DD': a load date, a start or end date, an
//       invoice period) is a calendar date. It is never converted through UTC and
//       shows the same date for every viewer in every time zone.
//   D2. When an instant has to become a date, or for "today", the zone is ONE
//       setting, APP_TIMEZONE (America/New_York unless the server's session answer
//       names another), never the browser's own.
// Before this, a dozen screens read "today" or a day off the viewer's clock. From
// Manila a driver's invoice week rolled to the next Saturday hours before it did in
// the US, and that week's end is what POST /api/invoices/generate bills; the IFTA
// report asked for the ELD pings between the VIEWER's midnights; a pickup stored as
// '2026-09-28' fell outside a Sep 28 date filter on every US phone.
//
// HOW. The corpus runs in four child processes, TZ=America/New_York,
// America/Chicago, Asia/Manila and UTC, and every child must pass and print
// byte-identical results: a value that still depends on the machine's zone cannot
// do both. Each child also runs the PRE-FIX code of the screens it covers, at the
// same pinned instants, and the parent requires those results to DIFFER by zone.
// That proves the four zones would have caught the bug, so a run that agrees is
// not agreeing by accident. Last, the parent checks that each fixed site calls the
// helpers (and imports them: an unimported helper in a <script setup> builds fine
// and throws at runtime).
//
// The helpers take a pinned instant where the screens use the clock (appToday(now)),
// so nothing here depends on when it runs.
//
// No network, no DOM, no database: client/src/utils/datetime.js under plain Node.
//
//   node scripts/test-app-timezone-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.join(path.dirname(SELF), '..')
const DATETIME_URL = pathToFileURL(path.join(ROOT, 'client', 'src', 'utils', 'datetime.js')).href
const CHILD_FLAG = 'APP_TZ_CLIENT_CHILD'
// Each zone with its offset from UTC on 2026-09-28 (getTimezoneOffset's sign), so a
// child that silently ran in some other zone is caught.
const ZONES = [
  ['America/New_York', 240],
  ['America/Chicago', 300],
  ['Asia/Manila', -480],
  ['UTC', 0],
]

const NEEDED = [
  'setAppTimeZone', 'appTimeZone', 'appToday', 'appDayOf', 'fmtAppDate',
  'appDayStartIso', 'appDayEndIso', 'shiftYmd', 'shiftYm', 'satFriWeekOf',
]

// The Saturday-to-Friday week of the instant `ms` on the US Eastern calendar,
// worked out apart from utils/datetime.js: the weekday comes from Intl's own
// `weekday` field, the dates from plain UTC arithmetic. It is the week the
// driver tab and the server's "now" week both count in under APP_TIMEZONE's
// default.
function easternWeekAt(ms) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
    .formatToParts(new Date(ms)).reduce((acc, x) => ((acc[x.type] = x.value), acc), {})
  const sinceSaturday = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(p.weekday)
  const start = Date.UTC(+p.year, +p.month - 1, +p.day - sinceSaturday)
  const key = (t) => new Date(t).toISOString().slice(0, 10)
  return { start: key(start), end: key(start + 6 * 86400000) }
}

// The server's getWeekRange(), lifted from server.js as it ships, on the server's
// own business zone (APP_TIMEZONE through lib/app-time.js, which is what the
// lifted function reads), so the driver tab's week can be compared with the week
// the server itself counts in.
function serverGetWeekRange() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
  const at = src.indexOf('function getWeekRange(referenceDate)')
  if (at < 0 || src.indexOf('function getWeekRange(', at + 1) >= 0) throw new Error('server.js must define getWeekRange() exactly once')
  let i = src.indexOf('{', at)
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) break
  }
  const appTime = createRequire(import.meta.url)('../lib/app-time.js')
  return new Function('APP_TIMEZONE', `${src.slice(at, i + 1)}\nreturn getWeekRange`)(appTime.appTimeZone())
}

// ══ The corpus: runs inside each child ═══════════════════════════════════════
async function corpus() {
  const dt = await import(DATETIME_URL)
  const checks = []
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    checks.push([label, a, a === e ? 'ok' : `expected ${e}`])
  }
  const local = { offset: new Date('2026-09-28T12:00:00Z').getTimezoneOffset() }

  const missing = NEEDED.filter((n) => typeof dt[n] !== 'function')
  check('utils/datetime.js exports the APP_TIMEZONE helpers', missing, [])
  if (missing.length) return { local, checks, preFix: preFix(dt) }

  const at = (iso) => Date.parse(iso)
  const LONG = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }

  // ── 1. The setting's default ────────────────────────────────────────────────
  check('1.1 APP_TIMEZONE defaults to America/New_York', dt.appTimeZone(), 'America/New_York')

  // ── 2. D1: calendar dates stay calendar dates ───────────────────────────────
  const WEEK_0926 = { start: '2026-09-26', end: '2026-10-02' }
  check('2.1 Monday 2026-09-28 sits in the Sat-Fri week 09-26..10-02', dt.satFriWeekOf('2026-09-28'), WEEK_0926)
  check("2.2 a Saturday (2026-09-26) starts its own week", dt.satFriWeekOf('2026-09-26'), WEEK_0926)
  check('2.3 a Friday (2026-10-02) ends its own week', dt.satFriWeekOf('2026-10-02'), WEEK_0926)
  check('2.4 the next Saturday starts the next week', dt.satFriWeekOf('2026-10-03'), { start: '2026-10-03', end: '2026-10-09' })
  check('2.5 the week holding the fall-back Sunday', dt.satFriWeekOf('2026-11-01'), { start: '2026-10-31', end: '2026-11-06' })
  check('2.6 the week holding the spring-forward Sunday', dt.satFriWeekOf('2026-03-08'), { start: '2026-03-07', end: '2026-03-13' })
  check('2.7 a week across New Year', dt.satFriWeekOf('2026-12-31'), { start: '2026-12-26', end: '2027-01-01' })
  check('2.8 no week for what is not a calendar day',
    ['', null, '9/28/2026', '2026-09-28T00:00:00Z', '2026-02-30'].map((v) => dt.satFriWeekOf(v)), [null, null, null, null, null])
  check('2.9 shiftYmd steps calendar days',
    [
      dt.shiftYmd('2026-09-28', 0), dt.shiftYmd('2026-09-28', 1), dt.shiftYmd('2026-09-30', 1),
      dt.shiftYmd('2026-03-01', -1), dt.shiftYmd('2028-03-01', -1), dt.shiftYmd('2026-12-31', 1),
      dt.shiftYmd('2026-10-31', 1), dt.shiftYmd('2026-11-01', 1), dt.shiftYmd('2026-03-08', 1),
      dt.shiftYmd('2026-10-08', -7),
    ],
    ['2026-09-28', '2026-09-29', '2026-10-01', '2026-02-28', '2028-02-29', '2027-01-01',
      '2026-11-01', '2026-11-02', '2026-03-09', '2026-10-01'])
  check('2.10 shiftYmd refuses what it cannot step',
    [dt.shiftYmd('', 1), dt.shiftYmd('2026-02-30', 1), dt.shiftYmd('2026-09-28', 1.5), dt.shiftYmd('2026-09-28', NaN)], ['', '', '', ''])
  check('2.11 shiftYm steps calendar months',
    [dt.shiftYm('2026-09', 1), dt.shiftYm('2026-12', 1), dt.shiftYm('2026-01', -1), dt.shiftYm('2026-09', -6), dt.shiftYm('2026-09', 5), dt.shiftYm('2026-01', 1)],
    ['2026-10', '2027-01', '2025-12', '2026-03', '2027-02', '2026-02'])
  check('2.12 shiftYm refuses what it cannot step',
    [dt.shiftYm('2026-13', 1), dt.shiftYm('2026-00', 1), dt.shiftYm('2026-09-28', 1), dt.shiftYm('', 0), dt.shiftYm('2026-09', Infinity)], ['', '', '', '', ''])
  check('2.13 a calendar date is its own day, and a day that does not exist is none',
    [dt.appDayOf('2026-09-28'), dt.appDayOf(' 2026-09-28 '), dt.appDayOf('2026-02-30'), dt.appDayOf('2026-13-01')], ['2026-09-28', '2026-09-28', '', ''])
  check('2.14 a calendar date shows as itself, Monday Sep 28 everywhere',
    [dt.fmtAppDate('2026-09-28'), dt.fmtAppDate('2026-09-28', LONG), dt.fmtAppDate('2026-09-01', { month: 'short', year: 'numeric' })],
    ['Sep 28, 2026', 'Monday, September 28, 2026', 'Sep 2026'])
  check('2.15 a date that does not exist shows the fallback', [dt.fmtAppDate('2026-02-30'), dt.fmtAppDate('2026-02-30', { fallback: '' })], ['—', ''])

  // ── 3. D2: an instant becomes a day in the app's zone ───────────────────────
  check('3.1 23:30 EDT on Sep 28 is Sep 28 (already Sep 29 in Manila and UTC)',
    [dt.appDayOf('2026-09-28T23:30:00-04:00'), dt.appDayOf(at('2026-09-28T23:30:00-04:00')), dt.appDayOf(new Date('2026-09-28T23:30:00-04:00')), dt.appDayOf('2026-09-29T03:30:00Z')],
    ['2026-09-28', '2026-09-28', '2026-09-28', '2026-09-28'])
  check('3.2 00:30 EDT on Sep 29 is Sep 29', dt.appDayOf('2026-09-29T00:30:00-04:00'), '2026-09-29')
  check('3.3 the last half hour of September is still September', dt.appDayOf('2026-09-30T23:30:00-04:00'), '2026-09-30')
  check('3.4 fall back: 01:30 EDT, 01:30 EST and 23:30 EST are all Nov 1; 00:30 EST is Nov 2',
    ['2026-11-01T01:30:00-04:00', '2026-11-01T01:30:00-05:00', '2026-11-01T23:30:00-05:00', '2026-11-02T00:30:00-05:00'].map((v) => dt.appDayOf(v)),
    ['2026-11-01', '2026-11-01', '2026-11-01', '2026-11-02'])
  check('3.5 spring forward: either side of the skipped hour is Mar 8',
    [dt.appDayOf('2026-03-08T01:59:59-05:00'), dt.appDayOf('2026-03-08T03:00:00-04:00')], ['2026-03-08', '2026-03-08'])
  check('3.6 no day for what is not an instant (a bare wall clock is never guessed at)',
    ['', null, undefined, 'not a date', NaN, new Date('x'), 1e20, '2026-09-28 23:30:00', '09/28/2026 23:30'].map((v) => dt.appDayOf(v)),
    ['', '', '', '', '', '', '', '', ''])
  check('3.7 appToday(now) is the app-zone day of now', dt.appToday(at('2026-09-28T23:30:00-04:00')), '2026-09-28')
  const before = dt.appDayOf(Date.now())
  const today = dt.appToday()
  check("3.8 appToday() is today's app-zone day", /^\d{4}-\d{2}-\d{2}$/.test(today) && (today === before || today === dt.appDayOf(Date.now())), true)
  check('3.9 fmtAppDate shows the app-zone date of an instant',
    [dt.fmtAppDate('2026-09-28T23:30:00-04:00'), dt.fmtAppDate(at('2026-09-28T23:30:00-04:00')), dt.fmtAppDate(new Date('2026-09-29T03:30:00Z'), LONG)],
    ['Sep 28, 2026', 'Sep 28, 2026', 'Monday, September 28, 2026'])
  check('3.10 fmtAppDate ignores a timeZone it is handed: the zone is the setting',
    dt.fmtAppDate('2026-09-29T03:30:00Z', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' }), 'Sep 28, 2026')
  check('3.11 fmtAppDate falls back on what it cannot read',
    [dt.fmtAppDate(''), dt.fmtAppDate('', { fallback: '' }), dt.fmtAppDate('2026-09-28 23:30:00'), dt.fmtAppDate(NaN), dt.fmtAppDate(null, { fallback: '?' })],
    ['—', '', '—', '—', '?'])

  // ── 4. The bounds of an app-zone day (what the IFTA routes filter on) ────────
  const bounds = (d) => [dt.appDayStartIso(d), dt.appDayEndIso(d)]
  check('4.1 an ordinary EDT day', bounds('2026-09-28'), ['2026-09-28T04:00:00.000Z', '2026-09-29T03:59:59.999Z'])
  check('4.2 the fall-back day runs 25 hours', bounds('2026-11-01'), ['2026-11-01T04:00:00.000Z', '2026-11-02T04:59:59.999Z'])
  check('4.3 the spring-forward day runs 23 hours', bounds('2026-03-08'), ['2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.999Z'])
  check('4.4 New Year\'s Eve (EST)', bounds('2026-12-31'), ['2026-12-31T05:00:00.000Z', '2027-01-01T04:59:59.999Z'])
  check('4.5 no bounds for what is not a calendar day',
    [dt.appDayStartIso(''), dt.appDayEndIso(''), dt.appDayStartIso('2026-02-30'), dt.appDayEndIso('2026-09-28T00:00:00Z')], ['', '', '', ''])
  const ROUND = ['2026-03-07', '2026-03-08', '2026-03-09', '2026-10-31', '2026-11-01', '2026-11-02', '2026-12-31', '2028-02-29']
  check('4.6 each day\'s bounds fall on that day, and one ms outside them on its neighbours',
    ROUND.filter((d) => {
      const [s, e] = bounds(d).map(Date.parse)
      return !(dt.appDayOf(s) === d && dt.appDayOf(e) === d && dt.appDayOf(s - 1) === dt.shiftYmd(d, -1) && dt.appDayOf(e + 1) === dt.shiftYmd(d, 1))
    }), [])
  check('4.7 hours in a day: 23 / 24 / 25',
    ['2026-03-08', '2026-09-28', '2026-11-01'].map((d) => (Date.parse(dt.appDayEndIso(d)) + 1 - Date.parse(dt.appDayStartIso(d))) / 3600000), [23, 24, 25])

  // ── 5. The zoned helpers share this zone (test-app-zone-switch-client.mjs has the rest) ─
  const iso = (d) => (d ? d.toISOString() : null)
  check('5.1 parseSheetStamp resolves each era: UTC before 2026-08-03, Houston to 2026-10-08, the app zone after',
    ['08/04/2026 8:05:07', '11/01/2026 01:30:00', '03/14/2027 02:30:00', '11/01/2026 23:30', '07/01/2026 00:12:00'].map((s) => iso(dt.parseSheetStamp(s))),
    ['2026-08-04T13:05:07.000Z', '2026-11-01T05:30:00.000Z', '2027-03-14T06:30:00.000Z', '2026-11-02T04:30:00.000Z', '2026-07-01T00:12:00.000Z'])
  check('5.2 fmtTimestamp renders the app zone', dt.fmtTimestamp('2026-08-04T13:05:07Z'), 'Aug 4, 2026, 9:05 AM EDT')

  // ── 6. setAppTimeZone: the server's setting, when the browser knows the zone ─
  check('6.1 setAppTimeZone(America/Chicago) takes it', [dt.setAppTimeZone('America/Chicago'), dt.appTimeZone()], ['America/Chicago', 'America/Chicago'])
  check('6.2 Chicago: 23:30 EDT is 22:30 CDT, the same day', dt.appDayOf('2026-09-28T23:30:00-04:00'), '2026-09-28')
  check('6.3 Chicago: 00:30 EDT on Sep 29 is 23:30 CDT, the previous day', dt.appDayOf('2026-09-29T00:30:00-04:00'), '2026-09-28')
  check('6.4 Chicago: the day starts at 05:00Z in CDT', dt.appDayStartIso('2026-09-28'), '2026-09-28T05:00:00.000Z')
  check('6.5 anything the browser does not accept keeps the zone in use',
    ['Not/AZone', '', ' America/Denver ', null, undefined, 42, {}, ['America/Denver']].map((v) => [dt.setAppTimeZone(v), dt.appTimeZone()]),
    Array(8).fill(['America/Chicago', 'America/Chicago']))
  check('6.5b an offset or an abbreviation (no daylight time) is not a zone name either',
    ['-0400', '+05:00', 'EST', 'utc', 'GMT'].map((v) => dt.setAppTimeZone(v)), Array(5).fill('America/Chicago'))
  check('6.5c "UTC" is', [dt.setAppTimeZone('UTC'), dt.appDayOf('2026-09-29T03:30:00Z'), dt.setAppTimeZone('America/Chicago')],
    ['UTC', '2026-09-29', 'America/Chicago'])
  check('6.5d Chicago: appToday(now) is the Chicago day of a pinned instant',
    [dt.appToday(at('2026-10-03T04:30:00Z')), dt.appToday(new Date('2026-10-03T05:30:00Z'))], ['2026-10-02', '2026-10-03'])
  check('6.6 the setting decides, whatever the zone (Manila)', [dt.setAppTimeZone('Asia/Manila'), dt.appDayOf('2026-09-28T23:30:00-04:00')], ['Asia/Manila', '2026-09-29'])
  check('6.7 ...and the time formatters follow it (a calendar date does not move)', [dt.fmtTimestamp('2026-08-04T13:05:07Z'), dt.fmtYmd('2026-09-28')], ['Aug 4, 2026, 9:05 PM GMT+8', 'Sep 28, 2026'])
  dt.setAppTimeZone('America/Havana') // its DST skips midnight itself: 00:00 -> 01:00
  check('6.8 a zone west of UTC whose DST skips midnight: the day starts at 01:00', [dt.appDayStartIso('2026-03-08'), dt.appDayEndIso('2026-03-07')],
    ['2026-03-08T05:00:00.000Z', '2026-03-08T04:59:59.999Z'])
  dt.setAppTimeZone('Asia/Beirut') // the same skip east of UTC
  check('6.8b ...and one east of UTC', [dt.appDayStartIso('2026-03-29'), dt.appDayEndIso('2026-03-28')],
    ['2026-03-28T22:00:00.000Z', '2026-03-28T21:59:59.999Z'])
  dt.setAppTimeZone('America/Santiago') // its DST repeats the hour before midnight
  check('6.9 a zone whose DST repeats the hour before midnight', [dt.appDayStartIso('2026-04-05'), dt.appDayEndIso('2026-04-04')],
    ['2026-04-05T04:00:00.000Z', '2026-04-05T03:59:59.999Z'])
  check('6.10 back to the default', dt.setAppTimeZone('America/New_York'), 'America/New_York')

  // ── 7. The fixed screens, as each one now computes ───────────────────────────
  // InvoiceTab.vue: weekRange = satFriWeekOf(shiftYmd(appToday(), -7 * weekOffset)).
  // The week counts in the app zone, like the server's own "now" week, the
  // Friday 6:30 PM cutoff and the Friday batch it has to agree with.
  const invoiceWeek = (now, back) => dt.satFriWeekOf(dt.shiftYmd(dt.appToday(at(now)), -7 * back))
  check('7.1 invoice week at Fri 23:30 EDT (Saturday in Manila and UTC): this week and last',
    [invoiceWeek('2026-10-03T03:30:00Z', 0), invoiceWeek('2026-10-03T03:30:00Z', 1)],
    [WEEK_0926, { start: '2026-09-19', end: '2026-09-25' }])
  check('7.1b invoice week at Fri 23:30 CDT (already Sat 00:30 in New York): the next week',
    invoiceWeek('2026-10-03T04:30:00Z', 0), { start: '2026-10-03', end: '2026-10-09' })
  // The tab's week, the server's own week (getWeekRange() of the instant) and the
  // Eastern week worked out apart (easternWeekAt) agree at every quarter hour
  // across Friday night into Saturday, in summer time and on both sides of each
  // switch.
  const serverWeekAt = serverGetWeekRange()
  const seams = ['2026-10-02', '2026-10-30', '2026-11-06', '2027-03-12', '2027-03-19']
  const disagree = []
  for (const friday of seams) {
    const from = Date.parse(`${friday}T12:00:00Z`)
    for (let t = from; t < from + 30 * 3600 * 1000; t += 15 * 60 * 1000) {
      const tab = dt.satFriWeekOf(dt.appToday(t))
      const ref = easternWeekAt(t)
      const srv = serverWeekAt(new Date(t))
      if (tab.start !== ref.start || tab.end !== ref.end || srv.weekStart !== tab.start || srv.weekEnd !== tab.end) disagree.push(new Date(t).toISOString())
    }
  }
  check('7.1c the tab\'s week is the server\'s week and the Eastern week at every quarter hour of five Friday-to-Saturday seams', disagree, [])
  check('7.2 invoice week on Thu Oct 8: 0, 1 and 6 weeks back',
    [0, 1, 6].map((k) => invoiceWeek('2026-10-08T16:00:00Z', k)),
    [{ start: '2026-10-03', end: '2026-10-09' }, WEEK_0926, { start: '2026-08-22', end: '2026-08-28' }])
  check('7.3 invoice week at Fri 23:30 EST, after the clocks went back',
    [invoiceWeek('2026-11-07T04:30:00Z', 0), invoiceWeek('2026-11-07T04:30:00Z', 1)],
    [{ start: '2026-10-31', end: '2026-11-06' }, { start: '2026-10-24', end: '2026-10-30' }])
  // EarningsSection.vue "+ Add day": today (the app zone's, a pay day) when it is
  // in the selected month, else the 1st.
  const addDay = (now, min, max) => { const t = dt.appToday(at(now)); return t >= min && t <= max ? t : min }
  check('7.4 "+ Add day" at 23:30 EDT on Sep 30 defaults to Sep 30', addDay('2026-10-01T03:30:00Z', '2026-09-01', '2026-09-30'), '2026-09-30')
  check('7.4b "+ Add day" at 23:30 CDT on Sep 30 (already Oct 1 in New York) is past September: the 1st',
    addDay('2026-10-01T04:30:00Z', '2026-09-01', '2026-09-30'), '2026-09-01')
  // ExpensesTab.vue IFTA range: the From day's start to the To day's end.
  check('7.5 IFTA range for September', [dt.appDayStartIso('2026-09-01'), dt.appDayEndIso('2026-09-30')], ['2026-09-01T04:00:00.000Z', '2026-10-01T03:59:59.999Z'])
  // stores/driver.js date filter: the pickup cell read as a calendar date first.
  const pickupInRange = (raw, fromYmd, toYmd) => {
    const from = dt.parseYmdLocal(fromYmd)
    const to = dt.parseYmdLocal(toYmd)
    if (to) to.setHours(23, 59, 59, 999)
    const cleaned = raw.replace(/(\d{1,2}:\d{2})\s*-\s*\d{1,2}:\d{2}/, '$1').trim()
    const d = dt.parseYmdLocal(cleaned) || new Date(cleaned)
    if (isNaN(d)) return false
    if (from && d < from) return false
    if (to && d > to) return false
    return true
  }
  check('7.6 driver date filter Sep 28..Sep 28',
    ['2026-09-28', '2026-09-27', '2026-09-29', '9/28/2026', '9/28/2026 14:00 - 16:00', '9/29/2026 00:00'].map((c) => pickupInRange(c, '2026-09-28', '2026-09-28')),
    [true, false, false, true, true, false])
  // DriverPayOverridesView.vue: the calendar's "today" ring.
  check('7.7 the "today" ring at 23:30 EDT on Sep 30', ['2026-09-30', '2026-10-01'].map((d) => d === dt.appToday(at('2026-10-01T03:30:00Z'))), [true, false])
  // ProductionSection.vue: 12 months, the app's current month in the middle.
  const current = dt.appToday(at('2026-10-01T03:30:00Z')).slice(0, 7)
  check('7.8 12-month chart at 23:30 EDT on Sep 30: six back, September, five ahead',
    Array.from({ length: 12 }, (_, j) => dt.shiftYm(current, j - 6)),
    ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'])
  // InvestorView.vue header.
  check('7.9 investor header at 23:30 EDT on Sep 30', dt.fmtAppDate(at('2026-10-01T03:30:00Z'), LONG), 'Wednesday, September 30, 2026')
  // CashFlowSection.vue break-even label: whole months from the app's current month.
  const breakEven = (now, n) => dt.fmtAppDate(`${dt.shiftYm(dt.appToday(at(now)).slice(0, 7), n)}-01`, { month: 'short', year: 'numeric' })
  check('7.10 break-even month: +0 and +4 from September; +1 from Jan 31 is February',
    [breakEven('2026-10-01T03:30:00Z', 0), breakEven('2026-10-01T03:30:00Z', 4), breakEven('2027-01-31T17:00:00Z', 1)],
    ['Sep 2026', 'Jan 2027', 'Feb 2027'])
  // NotificationsView.vue buckets, by app-zone day keys.
  const bucket = (createdAt, todayYmd) => {
    const day = createdAt ? dt.appDayOf(createdAt) : ''
    if (!day) return 'older'
    if (day >= todayYmd) return 'today'
    if (day >= dt.shiftYmd(todayYmd, -1)) return 'yesterday'
    if (day >= dt.shiftYmd(todayYmd, -7)) return 'thisWeek'
    return 'older'
  }
  const nowDay = dt.appToday(at('2026-10-08T03:30:00Z'))
  check('7.11 notification buckets at 23:30 EDT on Oct 7',
    ['2026-10-07T23:00:00Z', '2026-10-08T03:00:00Z', '2026-10-07T04:00:00Z', '2026-10-07T03:59:59Z', '2026-09-30T04:00:00Z', '2026-09-30T03:59:59Z', '', 'garbage']
      .map((c) => bucket(c, nowDay)),
    ['today', 'today', 'today', 'yesterday', 'thisWeek', 'older', 'older', 'older'])
  // InsightsCard.vue caption.
  const updated = (gen, now) => {
    const genDay = dt.appDayOf(gen)
    return genDay && genDay !== dt.appToday(at(now)) ? `Updated ${dt.fmtAppDate(genDay)}` : 'Updated earlier today'
  }
  check('7.12 insights caption at 23:30 EDT on Oct 7',
    [updated('2026-10-07T23:00:00Z', '2026-10-08T03:30:00Z'), updated('2026-10-07T03:00:00Z', '2026-10-08T03:30:00Z')],
    ['Updated earlier today', 'Updated Oct 6, 2026'])
  // DocumentSignModal.vue, NotificationList.vue, DriverPayOverridesView.vue: an instant shown as a date.
  check('7.13 a timestamp shown as a date', [dt.fmtAppDate('2026-09-29T02:15:00Z'), dt.fmtAppDate(new Date('2026-09-29T02:15:00Z'))], ['Sep 28, 2026', 'Sep 28, 2026'])

  return { local, checks, preFix: preFix(dt) }
}

// ══ The pre-fix code, at the same pinned instants ════════════════════════════
// Each is the replaced code with `new Date()` pinned to an instant (and
// toLocaleDateString's locale pinned to en-US, which is not what is under test).
// The parent requires every one to give a different answer in at least one zone.
function preFix(dt) {
  const pad = (n) => String(n).padStart(2, '0')
  const localYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const pinned = (iso) => new Date(iso)
  return {
    'InvoiceTab week (Fri 23:30 EDT)': (() => {
      const now = pinned('2026-10-03T03:30:00Z')
      const ref = new Date(now.getTime() - 0 * 7 * 86400000)
      const day = ref.getDay()
      const satOffset = day === 6 ? 0 : day + 1
      const start = new Date(ref)
      start.setDate(ref.getDate() - satOffset)
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(start.getDate() + 6)
      return `${localYmd(start)}..${localYmd(end)}`
    })(),
    'EarningsSection add-day default': localYmd(pinned('2026-10-01T03:30:00Z')),
    'ExpensesTab IFTA start for Nov 1': new Date('2026-11-01' + 'T00:00:00').toISOString(),
    'driver.js filter keeps a 2026-09-28 pickup': (() => {
      const from = dt.parseYmdLocal('2026-09-28')
      const to = dt.parseYmdLocal('2026-09-28')
      to.setHours(23, 59, 59, 999)
      const d = new Date('2026-09-28')
      return !(d < from) && !(d > to)
    })(),
    'DriverPayOverrides today ring on Sep 30': localYmd(pinned('2026-10-01T03:30:00Z')) === '2026-09-30',
    'ProductionSection current month': (() => {
      const now = pinned('2026-10-01T03:30:00Z')
      const d = new Date(now.getFullYear(), now.getMonth(), 1)
      return d.getFullYear() + '-' + pad(d.getMonth() + 1)
    })(),
    'InvestorView header': pinned('2026-10-01T03:30:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    'CashFlowSection break-even month': (() => {
      const d = pinned('2026-10-01T03:30:00Z')
      d.setMonth(d.getMonth() + 0)
      return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    })(),
    'NotificationsView bucket of 19:00 EDT': (() => {
      const now = pinned('2026-10-08T03:30:00Z')
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      const t = new Date('2026-10-07T23:00:00Z').getTime()
      return t >= startOfToday ? 'today' : t >= startOfToday - 24 * 3600 * 1000 ? 'yesterday' : 'earlier'
    })(),
    'InsightsCard caption': (() => {
      const gen = new Date('2026-10-07T23:00:00Z')
      return gen.toDateString() !== pinned('2026-10-08T03:30:00Z').toDateString() ? `Updated ${gen.toLocaleDateString('en-US')}` : 'Updated earlier today'
    })(),
    'DocumentSignModal signed date': new Date('2026-09-29T02:15:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    'toLocaleDateString() date-only displays': new Date('2026-09-29T02:15:00Z').toLocaleDateString('en-US'),
  }
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

console.log('APP_TIMEZONE client checks (client/src/utils/datetime.js), run once per machine zone:')
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

  console.log('\nThe pre-fix code at the same instants (each must differ by zone):')
  for (const key of Object.keys(done[0].report.preFix)) {
    const values = done.map((r) => r.report.preFix[key])
    const differs = new Set(values.map((v) => JSON.stringify(v))).size > 1
    if (!differs) fail(`pre-fix "${key}" gave one answer in every zone, so this run could not have caught it`)
    console.log(`  ${differs ? 'differs' : 'SAME   '}  ${key}: ${done.map((r, i) => `${r.tz} ${JSON.stringify(values[i])}`).join(' | ')}`)
  }
}

// ══ The fixed sites call the helpers ═════════════════════════════════════════
// `has` must appear and `gone` must not; `imports` must be named in the file's
// import from utils/datetime.
const SITES = [
  ['client/src/components/driver/InvoiceTab.vue', ['appToday', 'satFriWeekOf', 'shiftYmd'],
    ['satFriWeekOf(shiftYmd(appToday(), -7 * weekOffset.value))'],
    ['now.getTime() - weekOffset.value * 7 * 86400000', 'fmtLocalYMD', 'houstonToday']],
  ['client/src/components/investor/EarningsSection.vue', ['appToday'], ['const todayStr = appToday()'],
    ['${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}', 'houstonToday']],
  ['client/src/components/invoices/PaymentReportDialog.vue', ['appDayOf', 'fmtYmd'], ['fmtYmd(appDayOf(inv.paid_at))'], ['fmtYmd(inv.paid_at)']],
  ['client/src/components/dashboard/ExpensesTab.vue', ['appDayStartIso', 'appDayEndIso'],
    ['appDayStartIso(iftaStart.value)', 'appDayEndIso(iftaEnd.value)'],
    ["new Date(iftaStart.value + 'T00:00:00')", "new Date(iftaEnd.value + 'T23:59:59')"]],
  ['client/src/stores/driver.js', ['parseYmdLocal'], ['const d = parseYmdLocal(cleaned) || new Date(cleaned)'], ['const d = new Date(cleaned)']],
  ['client/src/views/DriverPayOverridesView.vue', ['appToday', 'fmtAppDate'], ['cell.date === appToday()', 'return fmtAppDate(d)'],
    ['return d.toLocaleDateString()', '${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}']],
  ['client/src/components/investor/ProductionSection.vue', ['appToday', 'shiftYm'], ['appToday().slice(0, 7)', 'shiftYm(current, i)'],
    ['new Date(now.getFullYear(), now.getMonth() + i, 1)']],
  ['client/src/views/InvestorView.vue', ['fmtAppDate'], ["fmtAppDate(Date.now(), { weekday: 'long'"], ["new Date().toLocaleDateString('en-US', { weekday"]],
  ['client/src/components/investor/CashFlowSection.vue', ['appToday', 'fmtAppDate', 'shiftYm'],
    ['shiftYm(appToday().slice(0, 7), monthsRemaining)'], ['d.setMonth(d.getMonth() + monthsRemaining)']],
  ['client/src/components/driver/DocumentSignModal.vue', ['fmtAppDate'], ['fmtAppDate(d, '], ['new Date(d).toLocaleDateString(']],
  ['client/src/components/driver/NotificationList.vue', ['fmtAppDate'], ['return fmtAppDate(d)'], ['return d.toLocaleDateString()']],
  ['client/src/components/dashboard/expenses/InsightsCard.vue', ['appDayOf', 'appToday', 'fmtAppDate'],
    ['appDayOf(data.value.generatedAt)', 'genDay !== appToday()'], ['toDateString()', 'gen.toLocaleDateString()']],
  ['client/src/views/NotificationsView.vue', ['appDayOf', 'appToday', 'shiftYmd'], ['appDayOf(n.createdAt)', 'appToday()'],
    ['new Date(now.getFullYear(), now.getMonth(), now.getDate())']],
  ['client/src/stores/auth.js', ['setAppTimeZone'], ['setAppTimeZone(data.appTimeZone)'], []],
]
const DATETIME_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*'(?:\.\.\/)+utils\/datetime(?:\.js)?'/
let sitesOk = 0
for (const [rel, imports, has, gone] of SITES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const m = DATETIME_IMPORT_RE.exec(src)
  const named = new Set(m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [])
  const problems = [
    ...imports.filter((n) => !named.has(n)).map((n) => `does not import ${n} from utils/datetime`),
    ...has.filter((s) => !src.includes(s)).map((s) => `lacks: ${s}`),
    ...gone.filter((s) => src.includes(s)).map((s) => `still has: ${s}`),
  ]
  for (const p of problems) fail(`${rel} ${p}`)
  if (!problems.length) sitesOk++
}
console.log(`\nFixed sites call the helpers: ${sitesOk}/${SITES.length} files`)

// The auth store hands the session answer's zone over inside probeSession(), the
// one function every GET /api/auth/session goes through.
{
  const auth = fs.readFileSync(path.join(ROOT, 'client', 'src', 'stores', 'auth.js'), 'utf8')
  const at = auth.indexOf('async function probeSession(')
  const body = at < 0 ? '' : auth.slice(at, auth.indexOf('\n}\n', at))
  if (!body.includes('setAppTimeZone(data.appTimeZone)')) fail('stores/auth.js probeSession() must pass the answer\'s appTimeZone to setAppTimeZone()')
  // A fresh /login page runs no session check, so login() and setup() take the
  // zone from their own answers (both routes return appTimeZone).
  for (const fn of ['async login(', 'async setup(']) {
    const from = auth.indexOf(fn)
    const fnBody = from < 0 ? '' : auth.slice(from, auth.indexOf('\n    },', from))
    if (!fnBody.includes('setAppTimeZone(data.appTimeZone)')) fail(`stores/auth.js ${fn}) must pass its answer's appTimeZone to setAppTimeZone()`)
  }
}

if (failed) {
  console.error(`\n${failed} failure(s)`)
  process.exit(1)
}
console.log('\nPASS  APP_TIMEZONE client helpers and the sites that use them')
