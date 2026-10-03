// The Financials page's selection (range, granularity, grouping), its URL form,
// and the display helpers its tables share.
//
// No money is computed here. Every figure on the page is one the server returned
// (GET /api/financials/report, lib/financials-report.js); this module only
// decides which dates to ask for, formats what came back, and orders rows by
// comparing values. Calendar arithmetic runs on noon UTC, like the server's, so
// no clock zone can shift a day.
//
// Pure: no Vue, no network, no storage. Runner: scripts/test-financials-view.mjs.

export const GRANULARITIES = Object.freeze([
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week', hint: 'Sat–Fri' },
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'year', label: 'Year' },
])

// `noun` names one row of the grouping ("Showing 100 of 178 loads").
export const GROUPINGS = Object.freeze([
  { key: 'fleet', label: 'Fleet P&L', noun: 'fleet', title: 'Fleet P&L' },
  { key: 'truck', label: 'Trucks', noun: 'trucks', title: 'By truck' },
  { key: 'driver', label: 'Drivers', noun: 'drivers', title: 'By driver' },
  { key: 'load', label: 'Loads', noun: 'loads', title: 'By load' },
  { key: 'pickupState', label: 'Pickup states', noun: 'pickup states', title: 'By pickup state' },
  { key: 'deliveryState', label: 'Delivery states', noun: 'delivery states', title: 'By delivery state' },
  { key: 'owner', label: 'Owners', noun: 'owners', title: 'By owner' },
])

export const RANGE_PRESETS = Object.freeze([
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'thisQuarter', label: 'This quarter' },
  { key: 'lastQuarter', label: 'Last quarter' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'last12', label: 'Last 12 months' },
  { key: 'custom', label: 'Custom' },
])

export const DEFAULT_SELECTION = Object.freeze({ range: 'last12', granularity: 'month', groupBy: 'fleet' })

// The server's limits (financialsReportQuery() in server.js): a daily report
// covers at most 400 days, any report at most 3,700. Checked here only to say so
// before asking; the server stays the authority (400 INVALID_REPORT_QUERY).
export const DAILY_MAX_DAYS = 400
export const RANGE_MAX_DAYS = 3700
// The years the server accepts (LOCK_PERIOD_MIN_YEAR / LOCK_PERIOD_MAX_YEAR).
export const MIN_YEAR = 2000
export const MAX_YEAR = 2100

// Rows shown before "Show all" in a grouped table.
export const GROUP_ROW_LIMIT = 100

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const pad2 = (n) => String(n).padStart(2, '0')
const dayMs = (d) => Date.parse(`${d}T12:00:00Z`)

/** A real calendar date 'YYYY-MM-DD' from MIN_YEAR to MAX_YEAR (rejects '2026-02-30', '2026-13-01', '9999-12-31'). */
export function isCalendarDay(v) {
  if (typeof v !== 'string' || !YMD_RE.test(v)) return false
  const y = Number(v.slice(0, 4))
  if (y < MIN_YEAR || y > MAX_YEAR) return false
  const ms = dayMs(v)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v
}

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}
// Month arithmetic on (year, month) pairs; month is 1-12.
function shiftMonth(y, m, delta) {
  const idx = y * 12 + (m - 1) + delta
  return [Math.floor(idx / 12), (idx % 12) + 1]
}
const firstOf = (y, m) => `${y}-${pad2(m)}-01`
const lastOf = (y, m) => `${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}`

/**
 * The dates a quick pick covers, ending today where the period is still running.
 * `today` is the carrier's day ('YYYY-MM-DD', America/Chicago: houstonToday()).
 * "Last 12 months" is the server's own default: the 1st of the month eleven
 * months back through today. Returns null for 'custom' or an unknown key.
 */
export function presetRange(preset, today) {
  if (!isCalendarDay(today)) return null
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  const q0 = Math.floor((m - 1) / 3) * 3 + 1 // first month of this quarter
  switch (preset) {
    case 'thisMonth':
      return { from: firstOf(y, m), to: today }
    case 'lastMonth': {
      const [py, pm] = shiftMonth(y, m, -1)
      return { from: firstOf(py, pm), to: lastOf(py, pm) }
    }
    case 'thisQuarter':
      return { from: firstOf(y, q0), to: today }
    case 'lastQuarter': {
      const [sy, sm] = shiftMonth(y, q0, -3)
      const [ey, em] = shiftMonth(y, q0, -1)
      return { from: firstOf(sy, sm), to: lastOf(ey, em) }
    }
    case 'ytd':
      return { from: `${y}-01-01`, to: today }
    case 'last12': {
      const [sy, sm] = shiftMonth(y, m, -11)
      return { from: firstOf(sy, sm), to: today }
    }
    default:
      return null
  }
}

const GRANULARITY_KEYS = new Set(GRANULARITIES.map((g) => g.key))
const GROUPING_KEYS = new Set(GROUPINGS.map((g) => g.key))
const PRESET_KEYS = new Set(RANGE_PRESETS.map((p) => p.key))

const one = (v) => (Array.isArray(v) ? v[0] : v)
const str = (v) => (v == null ? '' : String(one(v)).trim())

/**
 * The selection a URL query names, with every gap filled from the defaults.
 * A preset is re-read against `today` (a shared "Last month" link means last
 * month on the day it is opened); 'custom' keeps its own dates. A query with
 * dates but no range is custom. Unknown values fall back to the defaults.
 */
export function readSelection(query, today) {
  const q = query && typeof query === 'object' ? query : {}
  const granularity = GRANULARITY_KEYS.has(str(q.granularity)) ? str(q.granularity) : DEFAULT_SELECTION.granularity
  const groupBy = GROUPING_KEYS.has(str(q.groupBy)) ? str(q.groupBy) : DEFAULT_SELECTION.groupBy
  let range = PRESET_KEYS.has(str(q.range)) ? str(q.range) : ''
  const from = str(q.from)
  const to = str(q.to)
  if (!range && (from || to)) range = 'custom'
  if (range === 'custom') {
    if (isCalendarDay(from) && isCalendarDay(to)) return { range, from, to, granularity, groupBy }
    // Custom without two readable dates: show the default range, still custom,
    // so the date fields open on something real.
    const d = presetRange(DEFAULT_SELECTION.range, today) || { from: '', to: '' }
    return { range, from: isCalendarDay(from) ? from : d.from, to: isCalendarDay(to) ? to : d.to, granularity, groupBy }
  }
  if (!range) range = DEFAULT_SELECTION.range
  const r = presetRange(range, today) || { from: '', to: '' }
  return { range, from: r.from, to: r.to, granularity, groupBy }
}

/** The URL query for a selection: dates only when they are custom. */
export function selectionQuery(sel) {
  const out = { range: sel.range, granularity: sel.granularity, groupBy: sel.groupBy }
  if (sel.range === 'custom') {
    out.from = sel.from
    out.to = sel.to
  }
  return out
}

/** Calendar days from `from` to `to` (0 for the same day). NaN if unreadable. */
export function daySpan(from, to) {
  if (!isCalendarDay(from) || !isCalendarDay(to)) return NaN
  return Math.round((dayMs(to) - dayMs(from)) / 86400000)
}

/** '' when the server would accept the selection, else what to tell the user. */
export function selectionError(sel) {
  if (!sel || !isCalendarDay(sel.from) || !isCalendarDay(sel.to)) return `Pick a start and an end date from ${MIN_YEAR} to ${MAX_YEAR}.`
  const span = daySpan(sel.from, sel.to)
  if (span < 0) return 'The start date must be on or before the end date.'
  if (span > RANGE_MAX_DAYS) return 'The range can be at most ten years.'
  if (sel.granularity === 'day' && span > DAILY_MAX_DAYS) {
    return `A daily report can cover at most ${DAILY_MAX_DAYS} days. Pick a shorter range, or view it by week or month.`
  }
  return ''
}

/** The report's query string, shared by the JSON request and the CSV link. */
export function reportSearch(sel) {
  return new URLSearchParams({
    from: sel.from,
    to: sel.to,
    granularity: sel.granularity,
    groupBy: sel.groupBy,
  }).toString()
}

// ── display ────────────────────────────────────────────────────────────────

const BASIS_LABELS = { settled: 'Settled', live: 'Live', mixed: 'Mixed', none: 'No activity' }
const BASIS_TITLES = {
  settled: 'Closed months, shown exactly as they settled',
  live: 'Open months, calculated live',
  mixed: 'Part settled (closed months), part live (open months)',
  none: 'Nothing recorded in this period',
}
export function basisLabel(basis) {
  return BASIS_LABELS[basis] || ''
}
export function basisTitle(basis) {
  return BASIS_TITLES[basis] || ''
}

const MILES_SOURCES = {
  eld: 'ELD miles',
  ratecon: 'Rate-con miles',
  road: 'Road route miles',
  straight_line: 'Straight-line estimate',
}
/** How a load's miles were measured (lib/load-miles.js sources). */
export function milesSourceLabel(source) {
  return MILES_SOURCES[source] || 'No miles recorded'
}

const MONEY = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const COUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

const finite = (n) => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n))

/** A server dollar figure to the cent: 4200.5 → "$4,200.50", -12 → "-$12.00", null → "—". */
export function formatMoney(n) {
  if (!finite(n)) return '—'
  const text = MONEY.format(Math.abs(Number(n)))
  return Number(n) < 0 && text !== '0.00' ? `-$${text}` : `$${text}`
}

/** A server percentage (already rounded to one decimal): 37.8 → "37.8%", null → "—". */
export function formatPct(n) {
  if (!finite(n)) return '—'
  const text = Math.abs(Number(n)).toFixed(1)
  return Number(n) < 0 && text !== '0.0' ? `-${text}%` : `${text}%`
}

/** A count (loads, miles): 71242 → "71,242", null → "—". */
export function formatCount(n) {
  if (!finite(n)) return '—'
  return COUNT.format(Number(n))
}

/** A per-mile figure from the server: 3.46 → "$3.46", null (no miles) → "—". */
export function formatPerMile(n) {
  return formatMoney(n)
}

/** Positive / negative / zero class for a figure, by sign only. */
export function signClass(n) {
  if (!finite(n) || Number(n) === 0) return ''
  return Number(n) > 0 ? 'pos' : 'neg'
}

// ── grouped tables ─────────────────────────────────────────────────────────

// Groups that hold what belongs to no single truck, driver, load or state: the
// Settlement adjustment, investor payouts, company overhead, and the "no truck"
// / "not tied to a driver" / "unallocated" / "state unknown" buckets. They are
// listed after the named rows, so a sort reads over real trucks, drivers and
// loads. An owner grouping's "Company" (owner:0) is a real owner and stays.
export function isCatchAllGroup(key) {
  const k = String(key || '')
  return k === 'settlement_adjustment' || k === 'investor_payouts' || k === 'overhead'
    || k === 'unallocated' || k.startsWith('unallocated:')
    || k === 'truck:' || k === 'driver:' || k === 'state:'
}

export const GROUP_COLUMNS = Object.freeze([
  { key: 'revenue', label: 'Revenue', kind: 'money' },
  { key: 'totalCosts', label: 'Total costs', kind: 'money' },
  { key: 'margin', label: 'Margin', kind: 'money', signed: true },
  { key: 'marginPct', label: 'Margin %', kind: 'pct', signed: true },
  { key: 'loads', label: 'Loads', kind: 'count' },
  { key: 'miles', label: 'Miles', kind: 'count' },
  { key: 'revenuePerMile', label: 'Revenue / mile', kind: 'perMile' },
])

/** One figure of a figures object, formatted for its column. */
export function formatColumn(figures, column) {
  const v = figures ? figures[column.key] : null
  switch (column.kind) {
    case 'money': return formatMoney(v)
    case 'pct': return formatPct(v)
    case 'perMile': return formatPerMile(v)
    default: return formatCount(v)
  }
}

const LABEL_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/**
 * A sorted copy of `groups`. `key` is 'label' or a figure of `group.total`;
 * `dir` is 'asc' or 'desc'. Rows without the figure (a margin % with no
 * revenue, a rate with no miles) go last either way; ties keep label order.
 * Values are compared, never combined.
 */
export function sortGroups(groups, key, dir) {
  const sign = dir === 'asc' ? 1 : -1
  const list = Array.isArray(groups) ? [...groups] : []
  const byLabel = (a, b) => LABEL_COLLATOR.compare(String(a.label ?? ''), String(b.label ?? ''))
  if (key === 'label') return list.sort((a, b) => sign * byLabel(a, b))
  return list.sort((a, b) => {
    const av = a.total ? a.total[key] : null
    const bv = b.total ? b.total[key] : null
    const ah = finite(av)
    const bh = finite(bv)
    if (!ah || !bh) return ah === bh ? byLabel(a, b) : (ah ? -1 : 1)
    if (Number(av) !== Number(bv)) return Number(av) < Number(bv) ? -sign : sign
    return byLabel(a, b)
  })
}

/** Named rows (sorted, then cut to `limit` unless `showAll`) and catch-all rows. */
export function groupRows(groups, { sortKey = 'revenue', sortDir = 'desc', showAll = false, limit = GROUP_ROW_LIMIT } = {}) {
  const list = Array.isArray(groups) ? groups : []
  const named = sortGroups(list.filter((g) => !isCatchAllGroup(g.key)), sortKey, sortDir)
  const other = sortGroups(list.filter((g) => isCatchAllGroup(g.key)), 'label', 'asc')
  const visible = showAll ? named : named.slice(0, limit)
  return { visible, other, namedCount: named.length, hidden: named.length - visible.length }
}
