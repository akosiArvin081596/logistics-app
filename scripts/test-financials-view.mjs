#!/usr/bin/env node
// Deterministic check on client/src/lib/financialsView.js — the Financials
// page's range quick picks, its URL form, its formatting and its row ordering.
//
// What it pins:
//   1. Quick picks name the right days: month, quarter and year edges, leap
//      February, the January → December roll, and "Last 12 months" equal to the
//      server's default (financialsReportQuery(): the 1st, eleven months back).
//   2. The URL round-trips: a selection written by selectionQuery() reads back
//      the same with readSelection(); presets re-read against today; junk falls
//      back to the defaults instead of reaching the server.
//   3. The server's limits are said before asking: a daily report over 400 days,
//      a reversed range, a range over ten years.
//   4. Formatting shows the server's figure to the cent and never invents one:
//      null is an em-dash, never "$0.00"; "-$0.00" never appears.
//   5. Sorting compares and never combines: rows without a figure go last in
//      both directions, catch-all groups (Settlement adjustment, investor
//      payouts, unallocated) sit apart from named rows, and the row limit cuts
//      only the named rows.
//   6. The presets Today, Last week (the last complete Saturday-Friday week),
//      This year and Last year, on the Eastern business day: 11:30 PM ET on a
//      Friday is still Friday; January, leap February and quarter edges; the
//      short-period note.
//   7. The server's copy (lib/financials-presets.js) equals the client's: the
//      same keys and labels, and the same dates for every preset on every day
//      of 2024-2027, by day and by instant.
//
// No network, no sheet, no database, no Vue — pure input/output, safe anywhere.
//
//   node scripts/test-financials-view.mjs      # exits 1 on any failure

import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

// Both sides read the business day in the default zone, whatever the shell sets.
process.env.APP_TIMEZONE = 'America/New_York'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.join(__dirname, '..', 'client', 'src', 'lib', 'financialsView.js')
const v = await import(pathToFileURL(MODULE_PATH).href)
const dt = await import(pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'utils', 'datetime.js')).href)
const lib = createRequire(import.meta.url)(path.join(__dirname, '..', 'lib', 'financials-presets.js'))

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  fail++
  console.error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`)
}

// ── 1. quick picks ─────────────────────────────────────────────────────────
const T = '2026-10-02'
check('thisMonth', v.presetRange('thisMonth', T), { from: '2026-10-01', to: T })
check('lastMonth', v.presetRange('lastMonth', T), { from: '2026-09-01', to: '2026-09-30' })
check('thisQuarter', v.presetRange('thisQuarter', T), { from: '2026-10-01', to: T })
check('lastQuarter', v.presetRange('lastQuarter', T), { from: '2026-07-01', to: '2026-09-30' })
check('ytd', v.presetRange('ytd', T), { from: '2026-01-01', to: T })
check('last12 = server default', v.presetRange('last12', T), { from: '2025-11-01', to: T })
check('custom has no preset range', v.presetRange('custom', T), null)
check('unknown preset', v.presetRange('nope', T), null)
check('unreadable today', v.presetRange('thisMonth', '2026-13-01'), null)

check('lastMonth across the year', v.presetRange('lastMonth', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' })
check('lastQuarter across the year', v.presetRange('lastQuarter', '2026-02-10'), { from: '2025-10-01', to: '2025-12-31' })
check('thisQuarter mid-quarter', v.presetRange('thisQuarter', '2026-05-20'), { from: '2026-04-01', to: '2026-05-20' })
check('lastMonth leap February', v.presetRange('lastMonth', '2028-03-05'), { from: '2028-02-01', to: '2028-02-29' })
check('lastMonth plain February', v.presetRange('lastMonth', '2026-03-31'), { from: '2026-02-01', to: '2026-02-28' })
check('last12 in January', v.presetRange('last12', '2026-01-31'), { from: '2025-02-01', to: '2026-01-31' })
check('last12 in December', v.presetRange('last12', '2026-12-01'), { from: '2026-01-01', to: '2026-12-01' })

check('calendar day ok', v.isCalendarDay('2028-02-29'), true)
check('calendar day Feb 30', v.isCalendarDay('2026-02-30'), false)
check('calendar day month 13', v.isCalendarDay('2026-13-01'), false)
check('calendar day loose text', v.isCalendarDay('2026-1-1'), false)
check('calendar day year 2100 ok', v.isCalendarDay('2100-12-31'), true)
check('calendar day year 2101', v.isCalendarDay('2101-01-01'), false)
check('calendar day year 9999', v.isCalendarDay('9999-12-31'), false)
check('calendar day year 1999', v.isCalendarDay('1999-12-31'), false)

// ── 2. URL round trip ──────────────────────────────────────────────────────
check('empty query → defaults', v.readSelection({}, T),
  { range: 'last12', from: '2025-11-01', to: T, granularity: 'month', groupBy: 'fleet' })
check('preset query', v.readSelection({ range: 'lastQuarter', granularity: 'week', groupBy: 'load' }, T),
  { range: 'lastQuarter', from: '2026-07-01', to: '2026-09-30', granularity: 'week', groupBy: 'load' })
check('preset ignores stale dates in the URL', v.readSelection({ range: 'thisMonth', from: '2020-01-01', to: '2020-01-31' }, T),
  { range: 'thisMonth', from: '2026-10-01', to: T, granularity: 'month', groupBy: 'fleet' })
check('custom keeps its dates', v.readSelection({ range: 'custom', from: '2026-03-01', to: '2026-03-31', granularity: 'day', groupBy: 'driver' }, T),
  { range: 'custom', from: '2026-03-01', to: '2026-03-31', granularity: 'day', groupBy: 'driver' })
check('dates without a range are custom', v.readSelection({ from: '2026-03-01', to: '2026-04-30' }, T),
  { range: 'custom', from: '2026-03-01', to: '2026-04-30', granularity: 'month', groupBy: 'fleet' })
check('custom with a bad date falls back for that end only', v.readSelection({ range: 'custom', from: '2026-02-30', to: '2026-04-30' }, T),
  { range: 'custom', from: '2025-11-01', to: '2026-04-30', granularity: 'month', groupBy: 'fleet' })
check('junk values → defaults', v.readSelection({ range: 'forever', granularity: 'hour', groupBy: 'broker' }, T),
  { range: 'last12', from: '2025-11-01', to: T, granularity: 'month', groupBy: 'fleet' })
check('array query values take the first', v.readSelection({ groupBy: ['truck', 'driver'] }, T).groupBy, 'truck')

const custom = { range: 'custom', from: '2026-03-01', to: '2026-03-31', granularity: 'week', groupBy: 'pickupState' }
check('custom query has dates', v.selectionQuery(custom),
  { range: 'custom', granularity: 'week', groupBy: 'pickupState', from: '2026-03-01', to: '2026-03-31' })
check('custom round trip', v.readSelection(v.selectionQuery(custom), T), custom)
const preset = v.readSelection({ range: 'ytd', groupBy: 'owner' }, T)
check('preset query has no dates', v.selectionQuery(preset), { range: 'ytd', granularity: 'month', groupBy: 'owner' })
check('preset round trip', v.readSelection(v.selectionQuery(preset), T), preset)

check('report search', v.reportSearch(custom), 'from=2026-03-01&to=2026-03-31&granularity=week&groupBy=pickupState')

// ── 3. limits said before asking ───────────────────────────────────────────
const sel = (from, to, granularity = 'month') => ({ range: 'custom', from, to, granularity, groupBy: 'fleet' })
check('ok range', v.selectionError(sel('2026-01-01', '2026-03-31')), '')
check('same day ok', v.selectionError(sel(T, T, 'day')), '')
check('reversed', v.selectionError(sel('2026-03-31', '2026-01-01')), 'The start date must be on or before the end date.')
check('missing date', v.selectionError(sel('', T)), 'Pick a start and an end date from 2000 to 2100.')
check('daily 400 days ok (server: span > 400 refused)', v.selectionError(sel('2025-01-01', '2026-02-05', 'day')), '')
check('daily span', v.daySpan('2025-01-01', '2026-02-05'), 400)
check('daily 401 days refused', v.selectionError(sel('2025-01-01', '2026-02-06', 'day')).startsWith('A daily report can cover at most 400 days'), true)
check('weekly over 400 days ok', v.selectionError(sel('2024-01-01', '2026-02-06', 'week')), '')
check('over ten years refused', v.selectionError(sel('2010-01-01', '2026-01-01')), 'The range can be at most ten years.')
check('last12 by day fits', v.selectionError({ ...v.readSelection({ granularity: 'day' }, T) }), '')

// ── 4. formatting ──────────────────────────────────────────────────────────
check('money cents', v.formatMoney(246210.84), '$246,210.84')
check('money whole', v.formatMoney(64620), '$64,620.00')
check('money negative', v.formatMoney(-4200.5), '-$4,200.50')
check('money zero', v.formatMoney(0), '$0.00')
check('money negative zero', v.formatMoney(-0), '$0.00')
check('money tiny negative rounds to zero, no minus', v.formatMoney(-0.001), '$0.00')
check('money null', v.formatMoney(null), '—')
check('money undefined', v.formatMoney(undefined), '—')
check('money NaN', v.formatMoney(NaN), '—')
check('pct', v.formatPct(37.8), '37.8%')
check('pct negative', v.formatPct(-12.5), '-12.5%')
check('pct null (no revenue)', v.formatPct(null), '—')
check('count', v.formatCount(71242), '71,242')
check('count zero', v.formatCount(0), '0')
check('count null', v.formatCount(null), '—')
check('per mile', v.formatPerMile(3.46), '$3.46')
check('per mile null (no miles)', v.formatPerMile(null), '—')
check('sign pos', v.signClass(1), 'pos')
check('sign neg', v.signClass(-0.01), 'neg')
check('sign zero', v.signClass(0), '')
check('sign null', v.signClass(null), '')
check('basis labels', ['settled', 'live', 'mixed', 'none', 'x'].map(v.basisLabel), ['Settled', 'Live', 'Mixed', 'No activity', ''])
check('miles sources', ['eld', 'ratecon', 'road', 'straight_line', ''].map(v.milesSourceLabel),
  ['ELD miles', 'Rate-con miles', 'Road route miles', 'Straight-line estimate', 'No miles recorded'])
const col = (key) => v.GROUP_COLUMNS.find((c) => c.key === key)
const fig = { revenue: 1000.5, totalCosts: 900, margin: 100.5, marginPct: 10, loads: 3, miles: 1200, revenuePerMile: 0.83 }
check('columns format the server figures', v.GROUP_COLUMNS.map((c) => v.formatColumn(fig, c)),
  ['$1,000.50', '$900.00', '$100.50', '10.0%', '3', '1,200', '$0.83'])
check('column of a missing figures object', v.formatColumn(null, col('revenue')), '—')

// ── 5. ordering ────────────────────────────────────────────────────────────
const g = (key, label, total) => ({ key, label, total, byPeriod: {} })
const groups = [
  g('truck:a', 'Truck 10', { revenue: 500, margin: -20, marginPct: -4, revenuePerMile: 2 }),
  g('truck:b', 'Truck 2', { revenue: 900, margin: 300, marginPct: 33.3, revenuePerMile: null }),
  g('truck:c', 'Truck 1', { revenue: 900, margin: 50, marginPct: 5.6, revenuePerMile: 3 }),
  g('settlement_adjustment', 'Settlement adjustment', { revenue: 0, margin: 300, marginPct: null, revenuePerMile: null }),
  g('investor_payouts', 'Investor payouts', { revenue: 0, margin: -900, marginPct: null, revenuePerMile: null }),
  g('truck:', 'No truck', { revenue: 1000, margin: 10, marginPct: 1, revenuePerMile: 1 }),
]
const keys = (list) => list.map((x) => x.key)
check('revenue desc, ties by label', keys(v.sortGroups(groups.slice(0, 3), 'revenue', 'desc')), ['truck:c', 'truck:b', 'truck:a'])
check('revenue asc, ties by label', keys(v.sortGroups(groups.slice(0, 3), 'revenue', 'asc')), ['truck:a', 'truck:c', 'truck:b'])
check('label asc is numeric-aware', keys(v.sortGroups(groups.slice(0, 3), 'label', 'asc')), ['truck:c', 'truck:b', 'truck:a'])
check('null rate last when desc', keys(v.sortGroups(groups.slice(0, 3), 'revenuePerMile', 'desc')), ['truck:c', 'truck:a', 'truck:b'])
check('null rate last when asc', keys(v.sortGroups(groups.slice(0, 3), 'revenuePerMile', 'asc')), ['truck:a', 'truck:c', 'truck:b'])
check('sort does not mutate', keys(groups), ['truck:a', 'truck:b', 'truck:c', 'settlement_adjustment', 'investor_payouts', 'truck:'])
check('catch-all keys', ['settlement_adjustment', 'investor_payouts', 'overhead', 'unallocated', 'unallocated:logisx-#33', 'truck:', 'driver:', 'state:',
  'truck:a', 'driver:jo', 'state:TX', 'owner:0', 'load:123'].map(v.isCatchAllGroup),
  [true, true, true, true, true, true, true, true, false, false, false, false, false])

const rows = v.groupRows(groups, { sortKey: 'margin', sortDir: 'desc' })
check('named rows sorted apart from catch-alls', keys(rows.visible), ['truck:b', 'truck:c', 'truck:a'])
check('catch-alls by label', keys(rows.other), ['investor_payouts', 'truck:', 'settlement_adjustment'])
check('counts', [rows.namedCount, rows.hidden], [3, 0])
const many = Array.from({ length: 250 }, (_, i) => g(`load:${i}`, `L${i}`, { revenue: i }))
const cut = v.groupRows(many.concat(groups.slice(3)), {})
check('limit cuts named rows only', [cut.visible.length, cut.other.length, cut.namedCount, cut.hidden], [100, 3, 250, 150])
check('limit keeps the top by revenue', [cut.visible[0].key, cut.visible[99].key], ['load:249', 'load:150'])
const all = v.groupRows(many, { showAll: true })
check('show all', [all.visible.length, all.hidden], [250, 0])

// ── 6. presets: Today, Last week, This year, Last year ─────────────────────
// Each case runs on both copies; §7 then pins them equal on every day.
const both = (label, preset, today, expected) => {
  check(`client ${label}`, v.presetRange(preset, today), expected)
  check(`lib ${label}`, lib.presetRange(preset, today), expected)
}
check('preset keys in page order', v.RANGE_PRESETS.map((p) => p.key),
  ['today', 'lastWeek', 'thisMonth', 'lastMonth', 'thisQuarter', 'lastQuarter', 'ytd', 'lastYear', 'last12', 'custom'])
check('ytd keeps its key, shown as This year', v.RANGE_PRESETS.find((p) => p.key === 'ytd').label, 'This year')

both('today', 'today', '2026-10-30', { from: '2026-10-30', to: '2026-10-30' })
both('this year', 'ytd', '2026-10-30', { from: '2026-01-01', to: '2026-10-30' })
both('last year', 'lastYear', '2026-10-30', { from: '2025-01-01', to: '2025-12-31' })
both('last year on Jan 1', 'lastYear', '2027-01-01', { from: '2026-01-01', to: '2026-12-31' })
both('this year on Jan 1', 'ytd', '2027-01-01', { from: '2027-01-01', to: '2027-01-01' })

// Last week is the last COMPLETE Saturday-Friday week: on a Saturday it is the
// week that ended yesterday; on a Friday the current week is not over yet.
both('last week on a Friday', 'lastWeek', '2026-10-30', { from: '2026-10-17', to: '2026-10-23' })
both('last week on a Saturday', 'lastWeek', '2026-10-31', { from: '2026-10-24', to: '2026-10-30' })
both('last week on a Sunday', 'lastWeek', '2026-11-01', { from: '2026-10-24', to: '2026-10-30' })
both('last week across the year', 'lastWeek', '2027-01-08', { from: '2026-12-26', to: '2027-01-01' })
both('last week over leap day', 'lastWeek', '2028-03-04', { from: '2028-02-26', to: '2028-03-03' })
both('last week before leap Feb ends', 'lastWeek', '2024-03-01', { from: '2024-02-17', to: '2024-02-23' })

// January and leap February.
both('last month in January', 'lastMonth', '2026-01-15', { from: '2025-12-01', to: '2025-12-31' })
both('last month leap Feb', 'lastMonth', '2028-03-01', { from: '2028-02-01', to: '2028-02-29' })
both('last month leap Feb 2024', 'lastMonth', '2024-03-31', { from: '2024-02-01', to: '2024-02-29' })
both('this month on leap day', 'thisMonth', '2028-02-29', { from: '2028-02-01', to: '2028-02-29' })
both('last 12 on leap day', 'last12', '2028-02-29', { from: '2027-03-01', to: '2028-02-29' })

// Quarter edges.
both('this quarter on its last day', 'thisQuarter', '2026-03-31', { from: '2026-01-01', to: '2026-03-31' })
both('this quarter on its first day', 'thisQuarter', '2026-04-01', { from: '2026-04-01', to: '2026-04-01' })
both('last quarter on a quarter first day', 'lastQuarter', '2026-04-01', { from: '2026-01-01', to: '2026-03-31' })
both('last quarter on Dec 31', 'lastQuarter', '2026-12-31', { from: '2026-07-01', to: '2026-09-30' })
both('last quarter on Jan 1', 'lastQuarter', '2027-01-01', { from: '2026-10-01', to: '2026-12-31' })
both('custom', 'custom', '2026-10-30', null)
both('unknown', 'nextWeek', '2026-10-30', null)
both('unreadable today', 'today', '2026-02-30', null)

// Eastern days: the business day, not the UTC date, picks the period.
const at = (iso) => new Date(iso)
const FRI_2330_EDT = '2026-10-31T03:30:00Z' // Fri Oct 30, 11:30 PM EDT; already Saturday in UTC
check('11:30 PM ET Friday is Friday (lib)', lib.presetRangeAt('today', at(FRI_2330_EDT)), { from: '2026-10-30', to: '2026-10-30' })
check('11:30 PM ET Friday is Friday (client)', dt.appToday(Date.parse(FRI_2330_EDT)), '2026-10-30')
check('11:30 PM ET Friday: last week ended a week ago', lib.presetRangeAt('lastWeek', at(FRI_2330_EDT)), { from: '2026-10-17', to: '2026-10-23' })
check('...not the UTC Saturday answer', JSON.stringify(lib.presetRangeAt('lastWeek', at(FRI_2330_EDT))) === JSON.stringify(lib.presetRange('lastWeek', '2026-10-31')), false)
const FRI_2330_EST = '2027-01-09T04:30:00Z' // Fri Jan 8 2027, 11:30 PM EST
check('11:30 PM EST Friday: last week (lib)', lib.presetRangeAt('lastWeek', at(FRI_2330_EST)), { from: '2026-12-26', to: '2027-01-01' })
check('11:30 PM EST Friday (client)', v.presetRange('lastWeek', dt.appToday(Date.parse(FRI_2330_EST))), { from: '2026-12-26', to: '2027-01-01' })
check('last second of Oct ET is October', lib.presetRangeAt('lastMonth', at('2026-11-01T03:59:59Z')), { from: '2026-09-01', to: '2026-09-30' })
check('first second of Nov ET is November', lib.presetRangeAt('lastMonth', at('2026-11-01T04:00:00Z')), { from: '2026-10-01', to: '2026-10-31' })
check('New Year’s Eve 11:59 PM EST is still last year', lib.presetRangeAt('lastYear', at('2027-01-01T04:59:59Z')), { from: '2025-01-01', to: '2025-12-31' })
check('New Year 12:00 AM EST', lib.presetRangeAt('lastYear', at('2027-01-01T05:00:00Z')), { from: '2026-01-01', to: '2026-12-31' })

// URL: the new keys round-trip, and the quick links on /admin/financials read as named.
check('last week from the URL', v.readSelection({ range: 'lastWeek', granularity: 'day', groupBy: 'truck' }, '2026-10-31'),
  { range: 'lastWeek', from: '2026-10-24', to: '2026-10-30', granularity: 'day', groupBy: 'truck' })
check('quick link lastMonth by truck', v.readSelection({ range: 'lastMonth', groupBy: 'truck' }, T),
  { range: 'lastMonth', from: '2026-09-01', to: '2026-09-30', granularity: 'month', groupBy: 'truck' })
check('quick link lastMonth by driver', v.readSelection({ range: 'lastMonth', groupBy: 'driver' }, T).groupBy, 'driver')
const ly = v.readSelection({ range: 'lastYear' }, T)
check('last year round trip', v.readSelection(v.selectionQuery(ly), T), ly)
check('last year by day fits the daily limit', v.selectionError({ ...ly, granularity: 'day' }), '')

// The short-period note.
const s = (preset, today, granularity = 'month') => ({ ...v.presetRange(preset, today), range: preset, granularity, groupBy: 'fleet' })
const noted = (sel) => v.shortPeriodNote(sel) !== ''
check('note: today', noted(s('today', '2026-10-30')), true)
check('note: last week', noted(s('lastWeek', '2026-10-30')), true)
check('note: this month on day 14', noted(s('thisMonth', '2026-10-14')), true)
check('note: this month on day 15', noted(s('thisMonth', '2026-10-15')), false)
check('note: last month by month', noted(s('lastMonth', '2026-10-30')), false)
check('note: last 12 by week', noted(s('last12', '2026-10-30', 'week')), true)
check('note: last quarter by day', noted(s('lastQuarter', '2026-10-30', 'day')), true)
check('note: unreadable dates', v.shortPeriodNote({ from: '', to: '', granularity: 'day' }), '')
check('note: reversed range', v.shortPeriodNote({ from: '2026-10-30', to: '2026-10-01', granularity: 'day' }), '')
check('note names the delivery rule', v.shortPeriodNote(s('today', '2026-10-30')).includes('only once the load is delivered'), true)

// ── 7. client and server presets agree, 2024-2027 ──────────────────────────
check('lib keys and labels = client', lib.RANGE_PRESETS.map((p) => [p.key, p.label]), v.RANGE_PRESETS.map((p) => [p.key, p.label]))
check('lib key list', [...lib.PRESET_KEYS], v.RANGE_PRESETS.map((p) => p.key))
check('lib label', [lib.presetLabel('lastWeek'), lib.presetLabel('nope')], ['Last week', ''])

const DAY = 86400000
const days = []
for (let ms = Date.parse('2024-01-01T12:00:00Z'); ms <= Date.parse('2027-12-31T12:00:00Z'); ms += DAY) {
  days.push(new Date(ms).toISOString().slice(0, 10))
}
check('2024-2027 has 1461 days', days.length, 1461)
for (const { key } of v.RANGE_PRESETS) {
  const byDay = []
  const byInstant = []
  for (const d of days) {
    const c = v.presetRange(key, d)
    const l = lib.presetRange(key, d)
    if (JSON.stringify(c) !== JSON.stringify(l)) byDay.push(`${d}: client ${JSON.stringify(c)} lib ${JSON.stringify(l)}`)
    // 11:30 PM Eastern on day d (03:30 or 04:30 UTC the next day): both read day d.
    for (const iso of [`${d}T23:30:00-04:00`, `${d}T23:30:00-05:00`]) {
      const instant = new Date(iso)
      const ci = v.presetRange(key, dt.appToday(instant.getTime()))
      const li = lib.presetRangeAt(key, instant)
      if (JSON.stringify(ci) !== JSON.stringify(li)) byInstant.push(`${iso}: client ${JSON.stringify(ci)} lib ${JSON.stringify(li)}`)
    }
  }
  check(`parity by day: ${key}`, byDay.slice(0, 3), [])
  check(`parity by instant: ${key}`, byInstant.slice(0, 3), [])
}

// Last week, on every day: a whole Saturday-Friday week that ended 1 to 7 days ago.
const weekBad = []
for (const d of days) {
  const r = lib.presetRange('lastWeek', d)
  const ok = new Date(Date.parse(`${r.from}T12:00:00Z`)).getUTCDay() === 6
    && v.daySpan(r.from, r.to) === 6
    && v.daySpan(r.to, d) >= 1 && v.daySpan(r.to, d) <= 7
  if (!ok) weekBad.push(`${d}: ${JSON.stringify(r)}`)
}
check('last week is the last complete Sat-Fri week on every day', weekBad.slice(0, 3), [])

console.log(`${fail ? 'FAIL' : 'PASS'} test-financials-view: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
