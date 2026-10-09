#!/usr/bin/env node
// Deterministic check on the admin KPI page's side of the GET /api/admin/kpis
// contract: client/src/lib/kpiView.js, and the fixture it is checked against.
//
// What it pins:
//   1. scripts/fixtures/kpi-response.sample.json has the §4 shape of the frozen
//      contract: every field, type and allowed value, every metric key in catalog
//      order, a display string beside every figure. The shape check is itself
//      checked: broken copies of the fixture must each be refused.
//   2. The fixture covers what the page must handle: every status, kind and
//      confidence, a series with a gap between months that have figures, an
//      estimate with its assumptions, a stale approval, and before/after rows
//      that are date_not_set, insufficient and ok.
//   3. kpiView.js maps every value the contract names to a label (nothing lands
//      on "Unknown"), never throws on any metric, passes the server's display
//      strings through untouched, plots a month with no figure as a GAP (never
//      as 0), groups each metric exactly once, and builds the settings PUT body
//      from the changed fields only.
//   4. The page's components work out no figure (no toFixed, toLocaleString or
//      Math on a KPI value), and the route and sidebar entry are Super Admin only.
//   5. MUTANTS of kpiView.js, each a plausible regression, must each fail §3.
//   6. The server's own answer has the same shape: lib/kpi-metrics.js
//      computeKpis() on small fake inputs, stored the way server.js
//      kpiStoreResult() stores it, then buildKpiResponse(), passes the §1 check.
//
// The figures in the fixture are FAKE. No network, no server, no database, no Vue.
//
//   node scripts/test-kpi-contract.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const CLIENT_SRC = path.join(ROOT, 'client', 'src')
const LIB_PATH = path.join(CLIENT_SRC, 'lib', 'kpiView.js')
const LIB_SRC = fs.readFileSync(LIB_PATH, 'utf8')
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'kpi-response.sample.json'), 'utf8'))

let pass = 0
let fail = 0
function report(results) {
  for (const r of results) {
    if (r.ok) pass++
    else {
      fail++
      console.error(`FAIL  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`)
    }
  }
}
function collector() {
  const results = []
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : detail })
  const same = (name, actual, expected) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    check(name, a === e, `expected ${e}\n        actual   ${a}`)
  }
  return { results, check, same }
}
const clone = (v) => JSON.parse(JSON.stringify(v))

// ══ 1. The §4 shape ═══════════════════════════════════════════════════════════
const METRIC_KEYS = [
  'freight_tons_stated', 'freight_tons_estimated', 'loads_delivered', 'revenue', 'miles_driven', 'on_time_rate',
  'fleet_trucks', 'active_units', 'fuel_mpg', 'fuel_savings', 'co2_tonnes', 'ai_tasks', 'automated_tasks',
  'dispatch_calls', 'truck_utilization', 'paid_mile_share',
]
const ENUM = {
  kind: ['real', 'estimate', 'proxy', 'not_tracked'],
  unit: ['count', 'usd', 'lb_tons', 'miles', 'pct', 'trucks', 'units', 'mpg', 'gallons', 't_co2'],
  status: ['ok', 'partial', 'missing', 'not_tracked'],
  confidence: ['high', 'medium', 'low', 'none'],
  comparisonKind: ['mom', 'yoy', 't3m_yoy'],
  comparisonStatus: ['ok', 'missing'],
  event: ['ai_dispatch', 'dedicated'],
  beforeAfterStatus: ['ok', 'date_not_set', 'missing', 'insufficient'],
  runKind: ['nightly', 'manual', 'boot'],
  runStatus: ['ok', 'partial', 'failed', 'running'],
  digestStatus: ['pending', 'claimed', 'sent', 'failed', 'no_recipient'],
}
const METRIC_FIELDS = [
  'key', 'label', 'unit', 'kind', 'group', 'status', 'missingReason', 'definition', 'definitionVersion',
  'assumptions', 'source', 'warnings', 'value', 'display', 'current', 'totals', 'series', 'comparisons',
  'beforeAfter', 'coverage', 'confidence', 'breakdown', 'computedDay', 'approval',
]

const isStr = (v) => typeof v === 'string'
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isNumOrNull = (v) => v === null || isNum(v)
const isBool = (v) => typeof v === 'boolean'
const isYmd = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v)
const isYm = (v) => isStr(v) && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)
const isIso = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v))
const nextMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

// Every problem with `r` as a list of sentences; [] when it has the §4 shape.
function shapeErrors(r) {
  const errors = []
  const need = (ok, where, what) => { if (!ok) errors.push(`${where}: ${what}`) }
  const exactKeys = (obj, keys, where) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { errors.push(`${where}: not an object`); return false }
    for (const k of keys) need(Object.prototype.hasOwnProperty.call(obj, k), where, `missing "${k}"`)
    for (const k of Object.keys(obj)) need(keys.includes(k), where, `unexpected field "${k}"`)
    return true
  }
  const figure = (obj, where) => {
    need(isNumOrNull(obj.value), where, 'value is not a number or null')
    need(isStr(obj.display) && obj.display.length > 0, where, 'display is not a non-empty string')
  }

  if (!exactKeys(r, ['asOfDay', 'timeZone', 'generatedAt', 'job', 'settings', 'metrics'], 'response')) return errors
  need(isYmd(r.asOfDay), 'asOfDay', 'not YYYY-MM-DD')
  need(isStr(r.timeZone) && r.timeZone.length > 0, 'timeZone', 'not a string')
  need(isIso(r.generatedAt), 'generatedAt', 'not an ISO instant')

  const job = r.job
  if (exactKeys(job, ['enabled', 'snapshotSchedule', 'digestSchedule', 'lastRun', 'nextSnapshotAt', 'nextDigestAt', 'preview', 'lastDigest'], 'job')) {
    if (exactKeys(job.enabled, ['snapshot', 'digest'], 'job.enabled')) {
      need(isBool(job.enabled.snapshot) && isBool(job.enabled.digest), 'job.enabled', 'not booleans')
    }
    need(isStr(job.snapshotSchedule) && isStr(job.digestSchedule), 'job', 'schedules are not strings')
    if (job.lastRun !== null && exactKeys(job.lastRun, ['id', 'kind', 'status', 'startedAt', 'finishedAt', 'durationMs', 'errors'], 'job.lastRun')) {
      const run = job.lastRun
      need(ENUM.runKind.includes(run.kind), 'job.lastRun.kind', `"${run.kind}" not allowed`)
      need(ENUM.runStatus.includes(run.status), 'job.lastRun.status', `"${run.status}" not allowed`)
      need(isIso(run.startedAt), 'job.lastRun.startedAt', 'not an ISO instant')
      need(run.finishedAt === null || isIso(run.finishedAt), 'job.lastRun.finishedAt', 'not an ISO instant or null')
      need(isNumOrNull(run.durationMs), 'job.lastRun.durationMs', 'not a number or null')
      need(Array.isArray(run.errors), 'job.lastRun.errors', 'not an array')
      for (const [i, e] of (Array.isArray(run.errors) ? run.errors : []).entries()) {
        if (exactKeys(e, ['metric', 'code'], `job.lastRun.errors[${i}]`)) need(isStr(e.metric) && isStr(e.code), `job.lastRun.errors[${i}]`, 'not strings')
      }
    }
    need(job.nextSnapshotAt === null || isIso(job.nextSnapshotAt), 'job.nextSnapshotAt', 'not an ISO instant or null')
    need(job.nextDigestAt === null || isIso(job.nextDigestAt), 'job.nextDigestAt', 'not an ISO instant or null')
    if (exactKeys(job.preview, ['status', 'at'], 'job.preview')) {
      need(ENUM.digestStatus.includes(job.preview.status), 'job.preview.status', `"${job.preview.status}" not allowed`)
      need(job.preview.at === null || isIso(job.preview.at), 'job.preview.at', 'not an ISO instant or null')
    }
    if (job.lastDigest !== null && exactKeys(job.lastDigest, ['slotKey', 'status', 'at'], 'job.lastDigest')) {
      need(isStr(job.lastDigest.slotKey) && isStr(job.lastDigest.status), 'job.lastDigest', 'not strings')
      need(job.lastDigest.at === null || isIso(job.lastDigest.at), 'job.lastDigest.at', 'not an ISO instant or null')
    }
  }

  const s = r.settings
  if (exactKeys(s, ['aiDispatchStart', 'dedicatedStart', 'baselineMpg', 'recipients', 'defaultRecipientConfigured'], 'settings')) {
    if (exactKeys(s.aiDispatchStart, ['value', 'source', 'evidence'], 'settings.aiDispatchStart')) {
      need(s.aiDispatchStart.value === null || isYmd(s.aiDispatchStart.value), 'settings.aiDispatchStart.value', 'not YYYY-MM-DD or null')
      need(['derived', 'admin'].includes(s.aiDispatchStart.source), 'settings.aiDispatchStart.source', 'not derived/admin')
      need(isStr(s.aiDispatchStart.evidence), 'settings.aiDispatchStart.evidence', 'not a string')
    }
    if (exactKeys(s.dedicatedStart, ['value', 'source'], 'settings.dedicatedStart')) {
      need(s.dedicatedStart.value === null || isYmd(s.dedicatedStart.value), 'settings.dedicatedStart.value', 'not YYYY-MM-DD or null')
      need(s.dedicatedStart.source === null || s.dedicatedStart.source === 'admin', 'settings.dedicatedStart.source', 'not admin/null')
    }
    need(s.baselineMpg === null || (isNum(s.baselineMpg) && s.baselineMpg >= 3 && s.baselineMpg <= 15), 'settings.baselineMpg', 'not 3-15 or null')
    need(Array.isArray(s.recipients) && s.recipients.length <= 10 && s.recipients.every(isStr), 'settings.recipients', 'not up to 10 strings')
    need(isBool(s.defaultRecipientConfigured), 'settings.defaultRecipientConfigured', 'not a boolean')
  }

  need(Array.isArray(r.metrics), 'metrics', 'not an array')
  const asOfMonth = isYmd(r.asOfDay) ? r.asOfDay.slice(0, 7) : ''
  for (const m of Array.isArray(r.metrics) ? r.metrics : []) {
    const at = `metrics.${m?.key ?? '?'}`
    if (!exactKeys(m, METRIC_FIELDS, at)) continue
    need(isStr(m.key) && isStr(m.label) && isStr(m.group) && isStr(m.definition), at, 'key/label/group/definition not strings')
    need(ENUM.kind.includes(m.kind), `${at}.kind`, `"${m.kind}" not allowed`)
    need(ENUM.unit.includes(m.unit), `${at}.unit`, `"${m.unit}" not allowed`)
    need(ENUM.status.includes(m.status), `${at}.status`, `"${m.status}" not allowed`)
    need(ENUM.confidence.includes(m.confidence), `${at}.confidence`, `"${m.confidence}" not allowed`)
    need(Number.isInteger(m.definitionVersion) && m.definitionVersion >= 1, `${at}.definitionVersion`, 'not a positive integer')
    need(m.missingReason === null || isStr(m.missingReason), `${at}.missingReason`, 'not a string or null')
    if (m.status === 'missing' || m.status === 'not_tracked') {
      need(isStr(m.missingReason) && m.missingReason.length > 0, `${at}.missingReason`, 'a missing metric must say why')
      need(m.confidence === 'none', `${at}.confidence`, 'a missing metric has confidence none')
      need(m.value === null, `${at}.value`, 'a missing metric has no value (never 0)')
    }
    need(Array.isArray(m.assumptions) && m.assumptions.every(isStr), `${at}.assumptions`, 'not strings')
    need(Array.isArray(m.warnings) && m.warnings.every(isStr), `${at}.warnings`, 'not strings')
    if (m.source !== null && exactKeys(m.source, ['label', 'url'], `${at}.source`)) {
      need(isStr(m.source.label) && isStr(m.source.url) && /^https:\/\//.test(m.source.url), `${at}.source`, 'label/url not strings or url not https')
    }
    figure(m, at)
    if (exactKeys(m.current, ['from', 'to', 'value', 'display', 'label'], `${at}.current`)) {
      figure(m.current, `${at}.current`)
      need(isYmd(m.current.from) && isYmd(m.current.to), `${at}.current`, 'from/to not YYYY-MM-DD')
      need(isStr(m.current.label), `${at}.current.label`, 'not a string')
      need(m.value === m.current.value && m.display === m.current.display, at, 'value/display differ from current.value/current.display')
    }
    need(Array.isArray(m.totals), `${at}.totals`, 'not an array')
    for (const [i, t] of (Array.isArray(m.totals) ? m.totals : []).entries()) {
      if (exactKeys(t, ['label', 'from', 'to', 'value', 'display'], `${at}.totals[${i}]`)) {
        figure(t, `${at}.totals[${i}]`)
        need(isStr(t.label) && isYmd(t.from) && isYmd(t.to), `${at}.totals[${i}]`, 'label/from/to')
      }
    }
    need(Array.isArray(m.series), `${at}.series`, 'not an array')
    const series = Array.isArray(m.series) ? m.series : []
    for (const [i, p] of series.entries()) {
      if (exactKeys(p, ['period', 'value', 'display', 'coverage'], `${at}.series[${i}]`)) {
        figure(p, `${at}.series[${i}]`)
        need(isYm(p.period), `${at}.series[${i}].period`, 'not YYYY-MM')
        need(isNumOrNull(p.coverage), `${at}.series[${i}].coverage`, 'not a number or null')
        if (i > 0) need(p.period === nextMonth(series[i - 1].period), `${at}.series[${i}]`, 'months not consecutive and ascending')
      }
    }
    if (series.length) {
      need(series[0].period === '2025-04', `${at}.series`, 'does not start at 2025-04')
      need(series[series.length - 1].period === asOfMonth, `${at}.series`, 'does not end at the as-of month')
    }
    need(Array.isArray(m.comparisons), `${at}.comparisons`, 'not an array')
    for (const [i, c] of (Array.isArray(m.comparisons) ? m.comparisons : []).entries()) {
      const w = `${at}.comparisons[${i}]`
      if (!exactKeys(c, ['kind', 'label', 'basePeriod', 'value', 'baseValue', 'deltaPct', 'display', 'status'], w)) continue
      figure(c, w)
      need(ENUM.comparisonKind.includes(c.kind), `${w}.kind`, `"${c.kind}" not allowed`)
      need(ENUM.comparisonStatus.includes(c.status), `${w}.status`, `"${c.status}" not allowed`)
      need(isStr(c.label) && isStr(c.basePeriod), w, 'label/basePeriod not strings')
      need(isNumOrNull(c.baseValue) && isNumOrNull(c.deltaPct), w, 'baseValue/deltaPct not numbers or null')
      if (c.status === 'missing') need(c.deltaPct === null, w, 'a missing comparison has no deltaPct')
    }
    need(Array.isArray(m.beforeAfter), `${at}.beforeAfter`, 'not an array')
    for (const [i, b] of (Array.isArray(m.beforeAfter) ? m.beforeAfter : []).entries()) {
      const w = `${at}.beforeAfter[${i}]`
      if (!exactKeys(b, ['event', 'date', 'status', 'before', 'after', 'deltaPct', 'display', 'note'], w)) continue
      need(ENUM.event.includes(b.event), `${w}.event`, `"${b.event}" not allowed`)
      need(ENUM.beforeAfterStatus.includes(b.status), `${w}.status`, `"${b.status}" not allowed`)
      need(b.date === null || isYmd(b.date), `${w}.date`, 'not YYYY-MM-DD or null')
      if (b.status === 'date_not_set') need(b.date === null, w, 'date_not_set carries a date')
      for (const side of ['before', 'after']) {
        if (b[side] !== null && exactKeys(b[side], ['value', 'n', 'display'], `${w}.${side}`)) {
          figure(b[side], `${w}.${side}`)
          need(Number.isInteger(b[side].n) && b[side].n >= 0, `${w}.${side}.n`, 'not a count')
        }
      }
      need(isNumOrNull(b.deltaPct) && isStr(b.display) && isStr(b.note), w, 'deltaPct/display/note')
    }
    if (exactKeys(m.coverage, ['num', 'den', 'ratio', 'what', 'from', 'to'], `${at}.coverage`)) {
      const c = m.coverage
      need(Number.isInteger(c.num) && Number.isInteger(c.den) && c.num >= 0 && c.den >= 0, `${at}.coverage`, 'num/den not counts')
      need(isNumOrNull(c.ratio) && isStr(c.what), `${at}.coverage`, 'ratio/what')
      need((c.from === null || isYmd(c.from)) && (c.to === null || isYmd(c.to)), `${at}.coverage`, 'from/to not YYYY-MM-DD or null')
    }
    need(m.breakdown === null || Array.isArray(m.breakdown), `${at}.breakdown`, 'not an array or null')
    for (const [i, b] of (Array.isArray(m.breakdown) ? m.breakdown : []).entries()) {
      if (exactKeys(b, ['label', 'value', 'display'], `${at}.breakdown[${i}]`)) {
        figure(b, `${at}.breakdown[${i}]`)
        need(isStr(b.label), `${at}.breakdown[${i}].label`, 'not a string')
      }
    }
    need(m.computedDay === null || isYmd(m.computedDay), `${at}.computedDay`, 'not YYYY-MM-DD or null')
    if (exactKeys(m.approval, ['approved', 'by', 'at', 'stale'], `${at}.approval`)) {
      const a = m.approval
      need(isBool(a.approved) && isBool(a.stale), `${at}.approval`, 'approved/stale not booleans')
      need((a.by === null || isStr(a.by)) && (a.at === null || isIso(a.at)), `${at}.approval`, 'by/at')
      need(!(a.stale && a.approved), `${at}.approval`, 'a stale approval reads as approved')
    }
  }
  return errors
}

{
  const { results, check, same } = collector()
  const errors = shapeErrors(FIXTURE)
  check('§4 fixture has the contract shape', errors.length === 0, errors.slice(0, 8).join('\n        '))
  same('§1 every metric key once, in catalog order', FIXTURE.metrics.map((m) => m.key), METRIC_KEYS)

  // The shape check must refuse each of these broken copies.
  const broken = [
    ['a figure with no display', (r) => { r.metrics[0].display = '' }],
    ['a series value sent as text', (r) => { r.metrics[2].series[0].value = 'n/a' }],
    ['a kind the contract does not name', (r) => { r.metrics[0].kind = 'guess' }],
    ['a missing comparison with a delta', (r) => { r.metrics[0].comparisons[1].deltaPct = 0.1 }],
    ['a stale approval that reads approved', (r) => { r.metrics[1].approval.approved = true }],
    ['a field outside the contract', (r) => { r.metrics[3].driverName = 'Zed Sentinel' }],
    ['date_not_set carrying a date', (r) => { r.metrics[14].beforeAfter[1].date = '2026-06-01' }],
    ['value differing from current.value', (r) => { r.metrics[3].value = 1 }],
    ['months out of order', (r) => { const s = r.metrics[2].series; [s[3], s[4]] = [s[4], s[3]] }],
    ['a missing metric shown as 0', (r) => { r.metrics[9].value = 0; r.metrics[9].current.value = 0 }],
    ['a run status the contract does not name', (r) => { r.job.lastRun.status = 'done' }],
    ['eleven recipients', (r) => { r.settings.recipients = Array.from({ length: 11 }, (_, i) => `r${i}@example.test`) }],
  ]
  for (const [name, breakIt] of broken) {
    const copy = clone(FIXTURE)
    breakIt(copy)
    check(`shape check refuses: ${name}`, shapeErrors(copy).length > 0, 'the broken copy passed')
  }
  report(results)
}

// ══ 6. The server's own answer ════════════════════════════════════════════════
{
  const { results, check } = collector()
  const require = createRequire(import.meta.url)
  const M = require('../lib/kpi-metrics.js')
  const day = '2026-10-09'
  const loads = []
  const add = (d, status, extra) => loads.push({ loadId: `T-${loads.length + 1}`, status, day: d, contractIdBlank: loads.length % 2 === 0, driverKey: `zed sentinel ${loads.length % 3}`, truckKey: 'zed-1', detailsText: 'Weight: 40,000 lbs', revenue: 2500, ...extra })
  for (const d of ['2025-09-04', '2025-09-18', '2025-10-02', '2026-04-14', '2026-05-12', '2026-06-09', '2026-07-07', '2026-08-04', '2026-09-01', '2026-09-15', '2026-10-06']) add(d, 'Delivered')
  add('2026-09-20', 'In Transit', { revenue: 0 })
  const eldDaily = []
  for (let i = 1; i <= 30; i++) eldDaily.push({ day: `2026-09-${String(i).padStart(2, '0')}`, truckId: 'zed-1', miles: i % 7 === 0 ? 0 : 350 })
  const inputs = {
    asOfDay: day,
    settings: { aiDispatchStart: null, dedicatedStart: null, baselineMpg: null },
    loads, ratecon: [], eldDaily,
    trucks: [{ id: 'zed-1', status: 'Active', createdDay: '2026-04-15', inServiceDay: null, retiredDay: null, hasEld: true }],
    fleetHistory: [],
    fuelReceipts: [{ day: '2026-09-10', amount: 500, gallons: 100, status: 'Approved' }, { day: '2026-09-20', amount: 520, gallons: 104, status: '' }],
    arrivals: [{ loadId: 'T-10', appointmentText: '09/15/2026 14:00', destLng: -95.3, eldArriveMs: Date.parse('2026-09-15T18:00:00Z'), receiverEvents: [], deliveredDay: '2026-09-15' }],
    loadMiles: [], activity: { aiReceipts: ['2026-09-10'], aiExpenseInsights: [], geofenceStatuses: ['2026-09-15'], invoiceAutogenRuns: [] },
  }
  const out = M.computeKpis(inputs)
  const computedAt = '2026-10-09T08:00:00.000Z'
  const snapshots = out.metrics.map((m) => ({
    day, metric_key: m.key, value: Number.isFinite(m.value) ? m.value : null, display: m.display, status: m.status, confidence: m.confidence,
    definition_version: 1, computed_at: computedAt,
    payload: JSON.stringify({ current: m.current, totals: m.totals, comparisons: m.comparisons, beforeAfter: m.beforeAfter, coverage: m.coverage, warnings: m.warnings, assumptions: m.assumptions, breakdown: m.breakdown, missingReason: m.missingReason }),
  }))
  const series = out.metrics.flatMap((m) => m.series.map((x) => ({ metric_key: m.key, period: x.period, value: x.value, display: x.display, coverage: x.coverage, computed_at: computedAt })))
  const job = { enabled: { snapshot: true, digest: true }, snapshotSchedule: 'Daily at 4:00 AM Eastern (3:00 AM Central)', digestSchedule: 'Mondays at 9:00 AM Eastern (8:00 AM Central)',
    lastRun: { id: 1, kind: 'nightly', status: 'ok', startedAt: computedAt, finishedAt: computedAt, durationMs: 900, errors: [] },
    nextSnapshotAt: '2026-10-10T08:00:00.000Z', nextDigestAt: '2026-10-12T13:00:00.000Z', preview: { status: 'pending', at: null }, lastDigest: null }
  const response = M.buildKpiResponse({ asOfDay: day, timeZone: 'America/New_York', generatedAt: computedAt, job,
    settings: { aiDispatchStart: null, dedicatedStart: null, baselineMpg: null, recipients: [] }, defaultRecipientConfigured: true,
    derived: out.derived, snapshots, series, approvals: [] })
  const errors = shapeErrors(JSON.parse(JSON.stringify(response)))
  check('§6 the server-built answer has the contract shape', errors.length === 0, errors.slice(0, 8).join('\n        '))
  check('§6 no metric is approved by default', response.metrics.every((m) => m.approval.approved === false))
  check('§6 no load id or driver key in the answer', !/T-\d|zed sentinel/.test(JSON.stringify(response)))
  report(results)
}

// ══ 2. What the fixture covers ════════════════════════════════════════════════
{
  const { results, check } = collector()
  const ms = FIXTURE.metrics
  for (const s of ENUM.status) check(`fixture has a metric with status ${s}`, ms.some((m) => m.status === s))
  for (const k of ENUM.kind) check(`fixture has a metric of kind ${k}`, ms.some((m) => m.kind === k))
  for (const c of ENUM.confidence) check(`fixture has a metric with confidence ${c}`, ms.some((m) => m.confidence === c))
  check('fixture has a series gap between months with figures', ms.some((m) => {
    const v = m.series.map((p) => p.value)
    return v.some((x, i) => x === null && v.slice(0, i).some((y) => y !== null) && v.slice(i + 1).some((y) => y !== null))
  }))
  check('fixture has an estimate with assumptions', ms.some((m) => m.kind === 'estimate' && m.status === 'ok' && m.assumptions.length > 0))
  check('fixture has a stale approval', ms.some((m) => m.approval.stale))
  check('fixture has an approved metric', ms.some((m) => m.approval.approved))
  for (const s of ['date_not_set', 'insufficient', 'ok']) {
    check(`fixture has a before/after row ${s}`, ms.some((m) => m.beforeAfter.some((b) => b.status === s)))
  }
  check('fixture has a missing comparison', ms.some((m) => m.comparisons.some((c) => c.status === 'missing')))
  check('fixture has a breakdown and a null breakdown', ms.some((m) => m.breakdown) && ms.some((m) => m.breakdown === null))
  check('fixture has an empty series', ms.some((m) => m.series.length === 0))
  check('fixture has a warning', ms.some((m) => m.warnings.length > 0))
  check('fixture has a source link', ms.some((m) => m.source && m.source.url))
  report(results)
}

// ══ 3. kpiView.js ═════════════════════════════════════════════════════════════
// The labels the page must show, written out here rather than read from the
// module, so a changed or missing mapping fails.
const KIND_LABEL = { real: 'Real', estimate: 'Estimate', proxy: 'Proxy', not_tracked: 'Not tracked' }
const STATUS_LABEL = { missing: 'Missing data', not_tracked: 'Not tracked' }
const EVENT_LABEL = { ai_dispatch: 'AI dispatch', dedicated: 'Dedicated contracts' }

function viewChecks(v) {
  const { results, check, same } = collector()
  const guard = (name, fn) => {
    try {
      fn()
    } catch (err) {
      check(`${name} does not throw`, false, String(err?.stack || err).split('\n').slice(0, 3).join('\n        '))
    }
  }

  // Badges: every value the contract names has a label.
  guard('badges', () => {
    for (const k of ENUM.kind) {
      const b = v.kindBadge({ status: 'ok', kind: k })
      check(`kind ${k} has its badge`, b.known !== false && b.label === KIND_LABEL[k], `got ${JSON.stringify(b)}`)
    }
    for (const s of ENUM.status) {
      const b = v.kindBadge({ status: s, kind: 'real' })
      check(`status ${s} has a badge`, b.known !== false && b.label === (STATUS_LABEL[s] || 'Real'), `got ${JSON.stringify(b)}`)
    }
    const confidence = ENUM.confidence.map((c) => v.confidenceBadge(c))
    check('every confidence has a badge', confidence.every((b) => b.known !== false && b.label), JSON.stringify(confidence))
    check('confidence badges are distinct', new Set(confidence.map((b) => b.label)).size === ENUM.confidence.length)
    for (const s of ENUM.runStatus) check(`run status ${s} has a badge`, v.runStatusBadge(s).known !== false)
    for (const k of ENUM.runKind) check(`run kind ${k} has a label`, v.runKindLabel(k) !== 'Unknown')
    for (const s of ENUM.digestStatus) check(`digest status ${s} has a badge`, v.digestStatusBadge(s).known !== false)
    for (const e of ENUM.event) same(`event ${e} label`, v.eventLabel(e), EVENT_LABEL[e])
    check('an unknown kind shows "Unknown", never throws', v.kindBadge({ status: 'ok', kind: 'later' }).label === 'Unknown')
    check('an unknown status shows "Unknown"', v.kindBadge({ status: 'later', kind: 'real' }).label === 'Unknown')
    for (const m of FIXTURE.metrics) {
      const b = v.kindBadge(m)
      const expected = STATUS_LABEL[m.status] || KIND_LABEL[m.kind]
      check(`${m.key}: badge reads "${expected}"`, b.label === expected && b.known !== false, `got ${JSON.stringify(b)}`)
      check(`${m.key}: confidence badge`, v.confidenceBadge(m.confidence).known !== false)
    }
  })

  // Sparkline: a month with no figure is a gap, never a 0.
  guard('sparkline', () => {
    for (const m of FIXTURE.metrics) {
      const s = v.sparkline(m.series)
      const nullIdx = m.series.flatMap((p, i) => (p.value === null ? [i] : []))
      const numIdx = m.series.flatMap((p, i) => (p.value === null ? [] : [i]))
      same(`${m.key}: every month without a figure is a gap`, s.gaps.map((g) => g.index), nullIdx)
      same(`${m.key}: every month with a figure is a point`, s.points.map((p) => p.index), numIdx)
      check(`${m.key}: points stay inside the box`, s.points.every((p) => p.y >= 0 && p.y <= s.height && p.x >= 0 && p.x <= s.width))
      const xs = [...s.points, ...s.gaps].sort((a, b) => a.index - b.index).map((p) => p.x)
      check(`${m.key}: months run left to right`, xs.every((x, i) => i === 0 || x > xs[i - 1]))
      check(`${m.key}: hasData`, s.hasData === numIdx.length > 0)
      check(`${m.key}: point labels are the server's display`, s.points.every((p) => p.display === m.series[p.index].display)
        && s.gaps.every((g) => g.display === m.series[g.index].display))
    }
    const loads = FIXTURE.metrics.find((m) => m.key === 'loads_delivered')
    const ls = v.sparkline(loads.series)
    check('loads: the Dec–Mar gap splits the line in two', ls.lines.length === 2, `got ${ls.lines.length} line(s)`)
    same('loads: first and last month', [ls.first, ls.last], ['2025-04', '2026-10'])
    const open = v.sparkline(loads.series, { openPeriod: '2026-10' })
    const openAt = open.points.length ? `${open.points[open.points.length - 1].x.toFixed(2)},` : '?'
    check('the month in progress is a dashed step, not part of the line',
      open.openLine.includes(openAt) && open.openIndex === 18 && open.lines.length === 2 && !open.lines.some((l) => l.includes(openAt)),
      JSON.stringify({ openLine: open.openLine, openIndex: open.openIndex, lines: open.lines.length }))
    same('no open month when the series ends before it', [v.sparkline(loads.series, { openPeriod: '2026-11' }).openLine, v.sparkline(loads.series).openIndex], ['', -1])
    const iso = v.sparkline([{ period: '2026-01', value: 5, display: '5' }, { period: '2026-02', value: null, display: 'No records' }, { period: '2026-03', value: 7, display: '7' }])
    check('a lone month either side of a gap draws no line across it', iso.lines.length === 0 && iso.points.length === 2 && iso.gaps.length === 1)
    const flat = v.sparkline([3, 3, 3].map((value, i) => ({ period: `2026-0${i + 1}`, value, display: '3' })))
    check('a flat series sits mid-height', flat.points.every((p) => p.y === flat.height / 2))
    const up = v.sparkline([1, 9, 4].map((value, i) => ({ period: `2026-0${i + 1}`, value, display: String(value) })))
    check('the highest month is drawn highest', up.points[1].y < up.points[2].y && up.points[2].y < up.points[0].y)
    const zero = v.sparkline([{ period: '2026-01', value: 0, display: '0' }, { period: '2026-02', value: 4, display: '4' }])
    check('a real 0 is plotted (it is a figure, not a gap)', zero.points.length === 2 && zero.gaps.length === 0)
    const empty = v.sparkline([])
    check('an empty series has nothing to draw', !empty.hasData && empty.lines.length === 0 && empty.first === '')
    check('no series at all does not throw', v.sparkline(undefined).hasData === false)
  })

  guard('groups', () => {
    const groups = v.groupMetrics(FIXTURE.metrics)
    same('groups: every metric exactly once', groups.flatMap((g) => g.metrics.map((m) => m.key)).sort(), [...METRIC_KEYS].sort())
    same('groups: in the order each first appears', groups.map((g) => g.key), [...new Set(FIXTURE.metrics.map((m) => m.group))])
    check('groups: catalog order kept inside a group', groups.every((g) => {
      const idx = g.metrics.map((m) => METRIC_KEYS.indexOf(m.key))
      return idx.every((x, i) => i === 0 || x > idx[i - 1])
    }))
    same('group label from a key', v.groupLabel('fuel_and_carbon'), 'Fuel and carbon')
    same('group label kept when already words', v.groupLabel('Fleet'), 'Fleet')
    same('group label for none', v.groupLabel(''), 'Other')
  })

  guard('rows', () => {
    for (const m of FIXTURE.metrics) {
      for (const c of m.comparisons) {
        const row = v.comparisonRow(c)
        check(`${m.key}: comparison "${c.label}" shown as sent`, row.display === c.display && row.label === c.label && row.muted === (c.status !== 'ok'))
      }
      for (const b of m.beforeAfter) {
        const row = v.beforeAfterRow(b, (d) => `<${d}>`)
        check(`${m.key}/${b.event}: event label`, row.event === EVENT_LABEL[b.event])
        check(`${m.key}/${b.event}: date`, row.dateText === (b.date ? `<${b.date}>` : 'Date not set'), `got ${row.dateText}`)
        check(`${m.key}/${b.event}: sides as sent`, row.before === (b.before ? b.before.display : '') && row.after === (b.after ? b.after.display : ''))
        check(`${m.key}/${b.event}: note and display as sent`, row.note === b.note && row.display === b.display)
      }
    }
    const notSet = v.beforeAfterRow({ event: 'dedicated', date: null, status: 'date_not_set', before: null, after: null, deltaPct: null, display: '', note: 'Set it.' })
    same('date_not_set row', [notSet.dateText, notSet.statusLabel, notSet.hasSides, notSet.muted], ['Date not set', 'Date not set', false, true])
    const insufficient = v.beforeAfterRow({ event: 'ai_dispatch', date: '2026-04-13', status: 'insufficient', before: { value: null, n: 0, display: 'No data' }, after: { value: 0.7, n: 40, display: '70.0%' }, deltaPct: null, display: 'Not enough data', note: 'n' })
    same('insufficient row', [insufficient.statusLabel, insufficient.before, insufficient.after, insufficient.muted], ['Not enough data', 'No data', '70.0%', true])
    same('missing row label', v.beforeAfterRow({ event: 'dedicated', status: 'missing' }).statusLabel, 'Missing data')
    same('ok row has no status label', v.beforeAfterRow({ event: 'dedicated', date: '2026-09-14', status: 'ok', before: { display: 'a' }, after: { display: 'b' }, display: '+1%', note: '' }).statusLabel, '')

    for (const m of FIXTURE.metrics) {
      const text = v.coverageText(m.coverage)
      check(`${m.key}: coverage is "num of den", nothing worked out`,
        text === `${m.coverage.what}: ${m.coverage.num.toLocaleString('en-US')} of ${m.coverage.den.toLocaleString('en-US')}` && !text.includes('%'), `got ${text}`)
    }
    same('coverage counts get separators', v.coverageText({ num: 1234, den: 5678, ratio: 0.5, what: 'Loads' }), 'Loads: 1,234 of 5,678')
    same('coverage never shows the ratio', v.coverageText({ num: 1, den: 3, ratio: 0.33, what: '' }), '1 of 3')
    same('coverage with no counts', v.coverageText({ what: 'Call records' }), 'Call records')
    same('coverage absent', v.coverageText(null), '')
  })

  guard('approval', () => {
    for (const m of FIXTURE.metrics) {
      const a = v.approvalView(m.approval)
      check(`${m.key}: approval answer`, a.answer === (m.approval.approved ? 'Yes' : 'No'))
      check(`${m.key}: stale note`, a.staleNote === (m.approval.stale ? 'Approval reset: definition or settings changed' : ''), `got "${a.staleNote}"`)
    }
    same('only true approves', ['true', 1, 'yes', null, undefined].map((approved) => v.approvalView({ approved }).answer), ['No', 'No', 'No', 'No', 'No'])
    same('no approval object', v.approvalView(undefined), { approved: false, answer: 'No', stale: false, staleNote: '', by: '', at: '' })
    const yes = v.approvalConfirmText('Loads delivered', true)
    check('approve dialog says what it means', yes.body.includes('Sheila and the data room may use this figure') && yes.title.includes('Loads delivered'))
    const no = v.approvalConfirmText('Loads delivered', false)
    check('withdraw dialog says what it means', no.body.includes('may no longer use this figure') && no.action === 'Withdraw approval')
  })

  guard('job', () => {
    same('durations', [38500, 125000, 120000, 500, 0, null, -1, NaN].map((ms) => v.durationText(ms)), ['39 s', '2 min 5 s', '2 min', '<1 s', '<1 s', '', '', ''])
    same('409 says a run is going', v.recomputeErrorMessage({ status: 409, code: 'KPI_RUN_IN_PROGRESS', message: 'Server sentence' }), 'A run is already in progress')
    same('429 says wait', v.recomputeErrorMessage({ status: 429, message: 'Server sentence' }), 'Please wait before recomputing again')
    same('anything else is the server sentence', v.recomputeErrorMessage({ status: 500, message: 'Server sentence' }), 'Server sentence')
    same('no sentence at all', v.recomputeErrorMessage({ status: 0 }), 'The recompute could not be started.')
  })

  guard('settings', () => {
    const fx = FIXTURE.settings
    same('form from the fixture', v.settingsFormFrom(fx), { aiDispatchStart: '', dedicatedStart: '', baselineMpg: '', recipients: '' })
    same('an unchanged form sends nothing', v.settingsChanges(fx, v.settingsFormFrom(fx)), { body: {}, changed: [], errors: {} })
    const form = (over) => ({ ...v.settingsFormFrom(fx), ...over })
    same('only the changed field is sent (MPG)', v.settingsChanges(fx, form({ baselineMpg: '7.5' })).body, { baselineMpg: 7.5 })
    same('a number from the number box', v.settingsChanges(fx, form({ baselineMpg: 7 })).body, { baselineMpg: 7 })
    same('only the changed field is sent (dedicated)', v.settingsChanges(fx, form({ dedicatedStart: '2026-06-01' })).body, { dedicatedStart: '2026-06-01' })
    same('a derived AI start overridden', v.settingsChanges(fx, form({ aiDispatchStart: '2026-05-02' })).body, { aiDispatchStart: '2026-05-02' })
    const admin = { ...fx, aiDispatchStart: { value: '2026-05-01', source: 'admin', evidence: '' }, dedicatedStart: { value: '2026-06-01', source: 'admin' }, baselineMpg: 8, recipients: ['ops@example.test'] }
    same('form from admin-set settings', v.settingsFormFrom(admin), { aiDispatchStart: '2026-05-01', dedicatedStart: '2026-06-01', baselineMpg: '8', recipients: 'ops@example.test' })
    const adminForm = (over) => ({ ...v.settingsFormFrom(admin), ...over })
    same('"Use data" clears the override to null', v.settingsChanges(admin, adminForm({ aiDispatchStart: '' })).body, { aiDispatchStart: null })
    same('clearing dedicated sends null', v.settingsChanges(admin, adminForm({ dedicatedStart: '' })).body, { dedicatedStart: null })
    same('clearing MPG sends null', v.settingsChanges(admin, adminForm({ baselineMpg: '' })).body, { baselineMpg: null })
    same('same MPG written differently is no change', v.settingsChanges(admin, adminForm({ baselineMpg: '8.0' })).body, {})
    for (const bad of ['2.9', '15.1', '0', '-4', 'abc', 'Infinity']) {
      const r = v.settingsChanges(fx, form({ baselineMpg: bad }))
      check(`MPG "${bad}" is refused before asking`, !!r.errors.baselineMpg && !('baselineMpg' in r.body))
    }
    for (const okMpg of ['3', '15', '6.5']) check(`MPG "${okMpg}" is accepted`, !v.settingsChanges(fx, form({ baselineMpg: okMpg })).errors.baselineMpg)
    check('a date that is not YYYY-MM-DD is refused', !!v.settingsChanges(fx, form({ dedicatedStart: '06/01/2026' })).errors.dedicatedStart)
    same('recipients trimmed, lower-cased, each once', v.parseRecipients(' A@Example.test\na@example.test, b@example.test;\n\n'), ['a@example.test', 'b@example.test'])
    same('recipients changed', v.settingsChanges(fx, form({ recipients: 'B@example.test' })).body, { recipients: ['b@example.test'] })
    same('recipients only re-cased are no change', v.settingsChanges(admin, adminForm({ recipients: 'OPS@example.test' })).body, {})
    same('emptied recipients send []', v.settingsChanges(admin, adminForm({ recipients: '' })).body, { recipients: [] })
    const eleven = Array.from({ length: 11 }, (_, i) => `r${i}@example.test`).join('\n')
    check('eleven recipients are refused', !!v.settingsChanges(fx, form({ recipients: eleven })).errors.recipients)
    const tenPlusDuplicate = `${Array.from({ length: 10 }, (_, i) => `r${i}@example.test`).join('\n')}\nR0@example.test`
    check('ten plus a duplicate is ten', !v.settingsChanges(fx, form({ recipients: tenPlusDuplicate })).errors.recipients)
    same('a 400 names its field', v.settingsErrorFrom({ status: 400, message: 'Baseline MPG must be 3 to 15.', data: { error: 'x', code: 'INVALID_KPI_SETTINGS', field: 'baselineMpg' } }),
      { field: 'baselineMpg', message: 'Baseline MPG must be 3 to 15.' })
    same('a field outside the form is shown on the form', v.settingsErrorFrom({ message: 'No.', data: { field: '__proto__' } }), { field: null, message: 'No.' })
  })

  return results
}

const shipped = await import(pathToFileURL(LIB_PATH).href)
report(viewChecks(shipped))

// ══ 4. The page's own files ═══════════════════════════════════════════════════
{
  const { results, check } = collector()
  const read = (rel) => fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8')
  const pageFiles = ['views/KpisView.vue', ...fs.readdirSync(path.join(CLIENT_SRC, 'components', 'kpis')).map((f) => `components/kpis/${f}`)]
  for (const rel of pageFiles) {
    const src = read(rel)
    const hit = src.match(/\btoFixed\(|\btoLocaleString\(|\bMath\.|\bparseFloat\(|\bNumber\(|\* ?100\b/)
    check(`${rel} works out no figure`, !hit, `found "${hit?.[0]}"`)
  }
  const card = read('components/kpis/KpiMetricCard.vue')
  check('the source link opens safely', /target="_blank" rel="noopener noreferrer"/.test(card))
  const router = read('router/index.js')
  const route = /\{\s*path: '\/admin\/kpis',\s*name: 'kpis',\s*component: \(\) => import\('\.\.\/views\/KpisView\.vue'\),\s*meta: \{ roles: \['Super Admin'\] \},\s*\}/.test(router)
  check('route /admin/kpis is Super Admin only', route)
  const sidebar = read('components/layout/AppSidebar.vue')
  const blocks = sidebar.split(/\n  (?=Dispatcher: \[|Investor: \[|Driver: \[)/)
  const adminBlock = blocks[0].slice(blocks[0].indexOf("'Super Admin': ["))
  check('sidebar: KPIs in the Super Admin System group', /\{ divider: true, label: 'System' \}[\s\S]*\{ to: '\/admin\/kpis', icon: '[^']+', label: 'KPIs' \}/.test(adminBlock))
  check('sidebar: KPIs for no other role', blocks.slice(1).every((b) => !b.includes('/admin/kpis')))
  const store = read('stores/kpis.js')
  for (const url of ["api.get('/api/admin/kpis')", '`/api/admin/kpis/approvals/${encodeURIComponent(key)}`', "'/api/admin/kpis/settings'", "'/api/admin/kpis/recompute'"]) {
    check(`store calls ${url}`, store.includes(url))
  }
  check('the page reloads on kpis:changed', read('views/KpisView.vue').includes("useSocketRefresh('kpis:changed'"))
  report(results)
}

// ══ 5. Mutants ════════════════════════════════════════════════════════════════
function mutate(from, to) {
  const n = LIB_SRC.split(from).length - 1
  if (n !== 1) throw new Error(`mutant anchor not found exactly once (${n}x): ${from.slice(0, 80)}`)
  return LIB_SRC.replace(from, () => to)
}
const load = (src) => import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`)
const MUTANTS = [
  ['M1 a kind with no badge mapping', mutate("  estimate: Object.freeze({ label: 'Estimate', tone: 'estimate' }),\n", '')],
  ['M2 a month with no figure plotted as 0', mutate("return typeof value === 'number' && Number.isFinite(value)", 'return Number.isFinite(Number(value))')],
  ['M3 the line joined across a gap', mutate('      gaps.push({ index: i, x: xAt(i), period, display })\n      if (run.length) segments.push(run)\n      run = []\n', '      gaps.push({ index: i, x: xAt(i), period, display })\n')],
  ['M4 a missing metric badged as its kind', mutate('if (Object.prototype.hasOwnProperty.call(STATUS_BADGES, status) && STATUS_BADGES[status]) {', 'if (false) {')],
  ['M5 the stale-approval note dropped', mutate("staleNote: stale ? APPROVAL_STALE_NOTE : ''", "staleNote: ''")],
  ['M6 any truthy value reads as approved', mutate('const approved = approval?.approved === true', 'const approved = !!approval?.approved')],
  ['M7 an unset event date shown blank', mutate('dateText: date ? formatDate(date) : BEFORE_AFTER_STATUS_LABELS.date_not_set', "dateText: date ? formatDate(date) : ''")],
  ['M8 coverage worked out as a percentage', mutate("const counts = `${num.toLocaleString('en-US')} of ${den.toLocaleString('en-US')}`", 'const counts = `${Math.round((num / den) * 100)}%`')],
  ['M9 settings save sends every field', mutate('if (next !== dateOrNull(original[field])) body[field] = next', 'body[field] = next')],
  ['M10 409 shown as a generic failure', mutate("if (err?.status === 409 || err?.code === 'KPI_RUN_IN_PROGRESS') return RECOMPUTE_MESSAGES.inProgress\n", '')],
  ['M11 429 shown as a generic failure', mutate('if (err?.status === 429) return RECOMPUTE_MESSAGES.tooSoon\n', '')],
  ['M12 "Use data" sends an empty string, not null', mutate("return String(text ?? '').trim() || null", "return String(text ?? '').trim()")],
  ['M13 the MPG range check reduced to > 0', mutate('mpg >= MPG_MIN && mpg <= MPG_MAX', 'mpg > 0')],
  ['M14 recipients compared without lower-casing', mutate('const address = part.trim().toLowerCase()', 'const address = part.trim()')],
  ['M15 groups sorted by name instead of catalog order', mutate('  return groups\n}', '  return groups.sort((a, b) => a.label.localeCompare(b.label))\n}')],
  ['M16 the sparkline drawn upside down', mutate('height - pad - ((v - low) / (high - low)) * (height - 2 * pad)', 'pad + ((v - low) / (high - low)) * (height - 2 * pad)')],
  ['M17 the month in progress drawn as part of the solid line', mutate('if (open && lastRun.length > 1) {', 'if (false) {')],
]
for (const [label, src] of MUTANTS) {
  const failed = viewChecks(await load(src)).filter((r) => !r.ok)
  if (failed.length) pass++
  else {
    fail++
    console.error(`FAIL  mutant not caught: ${label}`)
  }
  console.log(`  ${failed.length ? 'caught ' : 'MISSED '} ${label}${failed[0] ? ` — ${failed.length} check(s), e.g. ✗ ${failed[0].name}` : ''}`)
}

console.log(`\nkpi-contract: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
