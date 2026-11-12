#!/usr/bin/env node
// The browser's half of the switch to US Central (the Central time plan, made-up
// data only): the server's answers carry `appTimeZoneEra` ({ before, from }) once
// APP_TIMEZONE_FROM is set, and client/src/utils/datetime.js reads each stamp and
// each past instant on the clock in force when it was made; "now" on the app zone.
//
//   §1 setAppTimeZoneEra(): there is none until an answer brings one; a readable era is adopted; one with a zone this browser
//      doesn't know, a moment that is not an ISO instant in UTC, or no era at all
//      leaves none (an answer without one ends it). Never throws.
//   §2 a bare sheet stamp in each of the four eras keeps its written date and reads
//      its true instant: UTC's before 2026-08-03, Houston's to 2026-10-08,
//      Eastern's to the switch, Central's after; the hour the switch repeats reads
//      as its first, Eastern instant, as the server reads it.
//   §3 a past instant keeps its day and its label: 11:30 PM EST on Nov 16 shows as
//      Nov 16, 11:30 PM EST after the switch; a day's bounds are on the clock of
//      that day (Nov 17 runs 25 hours; Oct 1, an IFTA range start, is Eastern).
//   §4 "now" is the app zone's: after the switch the 11 PM-midnight CT hour is the
//      Central day (E4 the week the driver bills, E7 a receipt's default date),
//      and the Friday cutoff is 6:30 PM CT.
//   §5 labels follow the zone: appZoneLabel() "ET", then "CT".
//   §6 with no era every helper gives exactly its answer before (each against the
//      formula it replaced), over a grid around both DST changes and the switch.
//   §7 the auth store hands every answer's era over with its zone.
// Every check runs again in child processes under TZ=UTC, America/Chicago and
// Asia/Manila; the answers must be the same.
//
//   node scripts/test-central-time-client.mjs        # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = fileURLToPath(import.meta.url)
const ROOT = path.join(path.dirname(HERE), '..')
const DT = path.join(ROOT, 'client', 'src', 'utils', 'datetime.js')
const AUTH = path.join(ROOT, 'client', 'src', 'stores', 'auth.js')
const NY = 'America/New_York'
const CHI = 'America/Chicago'
const FROM = '2026-11-18T02:00:00.000Z'
const ERA = { before: NY, from: FROM }

async function checks() {
  const dt = await import(pathToFileURL(DT).href)
  const out = []
  const check = (name, fn, want) => {
    let got
    try { got = fn() } catch (err) { got = `threw: ${String(err && err.message).split('\n')[0]}` }
    out.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })
  }
  const has = typeof dt.setAppTimeZoneEra === 'function'
  const setEra = (era) => (has ? dt.setAppTimeZoneEra(era) : 'none: no setAppTimeZoneEra()')
  const iso = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null)
  const TIME = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }

  // §1
  dt.setAppTimeZone(CHI)
  check('§1 no era until an answer brings one: a past instant reads on the app zone', () => dt.fmtAppInstant('2026-11-17T04:30:00Z'), 'Nov 16, 2026, 10:30 PM CST')
  check('§1 a readable era is adopted', () => { const e = setEra(ERA); return e && [e.before, e.fromMs] }, [NY, Date.parse(FROM)])
  check('§1 a zone this browser does not know leaves none', () => setEra({ before: 'Mars/Olympus', from: FROM }), null)
  check('§1 a moment that is not an ISO instant in UTC leaves none', () => [setEra({ before: NY, from: '11/18/2026 02:00' }), setEra({ before: NY, from: '2026-11-18T02:00:00-06:00' })], [null, null])
  check('§1 an offset or abbreviation for the zone leaves none', () => setEra({ before: 'EST', from: FROM }), null)
  check('§1 an answer without one ends it', () => { setEra(ERA); return [setEra(undefined), setEra(null), setEra('x')] }, [null, null, null])
  check('§1 ...and an instant before the moment reads on the app zone again', () => { setEra(undefined); return dt.fmtAppInstant('2026-11-17T04:30:00Z') }, 'Nov 16, 2026, 10:30 PM CST')

  // §2 and §3: on the Central clock, with the era
  setEra(ERA)
  check('§2 a UTC-era stamp (before 2026-08-03) is a UTC wall clock', () => iso(dt.parseSheetStamp('07/01/2026 0:12:00')), '2026-07-01T00:12:00.000Z')
  check('§2 a Houston-era stamp (Oct 2) is a Houston wall clock', () => iso(dt.parseSheetStamp('10/02/2026 9:05:00')), '2026-10-02T14:05:00.000Z')
  check('§2 an Eastern-era stamp (Nov 16 11:30 PM) stays Eastern after the switch', () => iso(dt.parseSheetStamp('11/16/2026 23:30:00')), '2026-11-17T04:30:00.000Z')
  check('§2 the hour the switch repeats (Nov 17 8:30 PM) reads as its first, Eastern instant', () => iso(dt.parseSheetStamp('11/17/2026 20:30:00')), '2026-11-18T01:30:00.000Z')
  check('§2 9:30 PM that evening is past the moment: Central', () => iso(dt.parseSheetStamp('11/17/2026 21:30:00')), '2026-11-18T03:30:00.000Z')
  check('§2 a Central-era stamp (Nov 30 11:30 PM) is a Central wall clock', () => iso(dt.parseSheetStamp('11/30/2026 23:30:00')), '2026-12-01T05:30:00.000Z')
  check('§2 every stamp is shown exactly as written, with its own date', () => ['11/16/2026 23:30:00', '11/30/2026 23:30:00'].map((v) => dt.fmtSheetMoment(v)), ['11/16/2026, 11:30 PM', '11/30/2026, 11:30 PM'])
  check('§3 a past instant keeps its label and day: Nov 16 11:30 PM EST', () => [dt.fmtAppInstant('2026-11-17T04:30:00Z'), dt.appDayOf('2026-11-17T04:30:00Z'), dt.fmtAppDate('2026-11-17T04:30:00Z')], ['Nov 16, 2026, 11:30 PM EST', '2026-11-16', 'Nov 16, 2026'])
  check('§3 Oct 31 11:30 PM CDT (Nov 1 12:30 AM EDT) stays on Nov 1', () => [dt.appDayOf('2026-11-01T04:30:00Z'), dt.fmtYmd('2026-11-01T04:30:00Z')], ['2026-11-01', 'Nov 1, 2026'])
  check('§3 an instant after the switch reads on Central: Nov 30 11:30 PM CST', () => [dt.fmtAppInstant('2026-12-01T05:30:00Z'), dt.appDayOf('2026-12-01T05:30:00Z'), dt.fmtTimestamp('2026-12-01T05:30:00Z')], ['Nov 30, 2026, 11:30 PM CST', '2026-11-30', 'Nov 30, 2026, 11:30 PM CST'])
  check('§3 the switch evening: 8:30 PM EST before the moment, 8:30 PM CST after it', () => [dt.fmtAppInstant('2026-11-18T01:30:00Z', TIME), dt.fmtAppInstant('2026-11-18T02:30:00Z', TIME)], ['Nov 17, 2026, 8:30 PM EST', 'Nov 17, 2026, 8:30 PM CST'])
  check('§3 a sort key follows the label it sorts', () => [dt.sheetSortKey('2026-11-17T04:30:00Z'), dt.sheetSortKey('2026-12-01T05:30:00Z')], ['20261116233000', '20261130233000'])
  check('§3 the switch day runs 25 hours: Eastern midnight to Central midnight', () => [dt.appDayStartIso('2026-11-17'), dt.appDayEndIso('2026-11-17'), dt.appDayStartIso('2026-11-18')],
    ['2026-11-17T05:00:00.000Z', '2026-11-18T05:59:59.999Z', '2026-11-18T06:00:00.000Z'])
  check('§3 an IFTA range from Oct 1 starts at Eastern midnight; one to Nov 30 ends at Central midnight', () => [dt.appDayStartIso('2026-10-01'), dt.appDayEndIso('2026-11-30')], ['2026-10-01T04:00:00.000Z', '2026-12-01T05:59:59.999Z'])

  // §4 "now"
  const dec4Late = Date.parse('2026-12-05T05:30:00Z')
  check('§4 E4 Fri Dec 4 11:30 PM CST: today is Dec 4, the week the driver bills ends Dec 4', () => [dt.appToday(dec4Late), dt.satFriWeekOf(dt.appToday(dec4Late)).end], ['2026-12-04', '2026-12-04'])
  check('§4 E7 a receipt logged Mon Nov 30 11:30 PM CST defaults to Nov 30', () => dt.appToday(Date.parse('2026-12-01T05:30:00Z')), '2026-11-30')
  check('§4 the cutoff is Friday 6:30 PM CT', () => [dt.isAfterAppTime('2026-11-20', '18:30', Date.parse('2026-11-21T00:29:59Z')), dt.isAfterAppTime('2026-11-20', '18:30', Date.parse('2026-11-21T00:30:01Z'))], [false, true])
  check('§4 the zone in use is the app zone', () => dt.appTimeZone(), CHI)

  // §5
  check('§5 labels name the business clock: CT on Central', () => (typeof dt.appZoneLabel === 'function' ? dt.appZoneLabel(Date.parse('2026-12-01T12:00:00Z')) : 'none'), 'CT')
  dt.setAppTimeZone(NY)
  check('§5 ...ET on Eastern', () => (typeof dt.appZoneLabel === 'function' ? dt.appZoneLabel(Date.parse('2026-12-01T12:00:00Z')) : 'none'), 'ET')

  // §6 no era: every helper as it was
  setEra(undefined)
  const instants = []
  for (let t = Date.parse('2026-10-31T12:00:00Z'); t <= Date.parse('2026-11-02T12:00:00Z'); t += 17 * 60000) instants.push(t)
  for (let t = Date.parse('2026-11-17T12:00:00Z'); t <= Date.parse('2026-11-19T12:00:00Z'); t += 13 * 60000) instants.push(t)
  for (let t = Date.parse('2027-03-13T12:00:00Z'); t <= Date.parse('2027-03-15T12:00:00Z'); t += 19 * 60000) instants.push(t)
  const nyLabel = (t) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: NY, timeZoneName: 'short' }).format(new Date(t))
  const nyDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t))
  check('§6 no era: fmtAppInstant() and appDayOf() are the Eastern label and day, as before', () => instants.filter((t) => dt.fmtAppInstant(t) !== nyLabel(t) || dt.appDayOf(t) !== nyDay(t)).length, 0)
  const days = []
  for (let t = Date.parse('2026-10-01T12:00:00Z'); t <= Date.parse('2027-04-01T12:00:00Z'); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10))
  check('§6 no era: a day starts at its Eastern midnight, as before', () => days.filter((d) => { const t = Date.parse(dt.appDayStartIso(d)); return nyDay(t) !== d || nyDay(t - 1) === d }).length, 0)
  check('§6 no era: a stamp from 2026-10-09 is an Eastern wall clock, as before', () => days.filter((d) => {
    const [y, m, dd] = d.split('-').map(Number)
    const t = dt.parseSheetStamp(`${m}/${dd}/${y} 23:30:00`).getTime()
    return d >= '2026-10-09' && (nyDay(t) !== d || new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t)) !== '23:30')
  }).length, 0)
  return out
}

// §7: the store passes each answer's era with its zone.
function storeChecks() {
  const src = fs.readFileSync(AUTH, 'utf8')
  const body = (head, end) => { const a = src.indexOf(head); return a < 0 ? '' : src.slice(a, src.indexOf(end, a)) }
  const out = []
  const t = (name, ok) => out.push({ name, ok, got: ok, want: true })
  t('§7 stores/auth.js imports setAppTimeZoneEra from utils/datetime', /import\s*\{[^}]*\bsetAppTimeZoneEra\b[^}]*\}\s*from\s*'\.\.\/utils\/datetime\.js'/.test(src))
  t('§7 probeSession() hands over the session answer\'s era', body('async function probeSession(', '\n}\n').includes('setAppTimeZoneEra(data.appTimeZoneEra)'))
  for (const fn of ['async login(', 'async setup(']) t(`§7 ${fn}) hands over its answer's era`, body(fn, '\n    },').includes('setAppTimeZoneEra(data.appTimeZoneEra)'))
  return out
}

if (process.argv[2] === '--child') {
  process.stdout.write(JSON.stringify(await checks()))
  process.exit(0)
}

let pass = 0
const failures = []
const record = (results, label) => {
  for (const x of results) {
    if (x.ok) pass++
    else failures.push(`${label ? `[${label}] ` : ''}${x.name}\n      got  ${JSON.stringify(x.got)}\n      want ${JSON.stringify(x.want)}`)
  }
}
const here = await checks()
record(here)
for (const x of here) console.log(`  ${x.ok ? 'ok  ' : 'FAIL'} ${x.name}`)
const store = storeChecks()
record(store)
for (const x of store) console.log(`  ${x.ok ? 'ok  ' : 'FAIL'} ${x.name}`)
for (const tz of ['UTC', 'America/Chicago', 'Asia/Manila']) {
  const r = spawnSync(process.execPath, [HERE, '--child'], { env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 60000 })
  let got = null
  try { got = JSON.parse(r.stdout) } catch { got = null }
  const same = JSON.stringify(got) === JSON.stringify(here)
  if (same) pass++; else failures.push(`TZ=${tz}: the answers differ from this process's (exit ${r.status})`)
  console.log(`  ${same ? 'ok  ' : 'FAIL'} the same answers under TZ=${tz}`)
}
if (failures.length) {
  console.error(`\nFAILURES (${failures.length}):`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  console.error(`\n${pass} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`\n✓ ${pass} checks passed`)
