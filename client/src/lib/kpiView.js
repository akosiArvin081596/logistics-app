// Display helpers for the admin KPI page (views/KpisView.vue, components/kpis/*).
//
// THE SERVER IS THE SOURCE OF EVERY FIGURE. GET /api/admin/kpis sends each number
// with a `display` string built on the server, and this page shows those strings
// as they are. Nothing here adds, divides, rounds or re-formats a KPI value: a
// figure the browser worked out could drift from the one the digest email and the
// data room read, and the approval flag vouches for the server's figure only. The
// one place a value is read as a number is the sparkline, which maps it to a pixel
// position and never shows it.
//
// Pure: no Vue, no network, no imports, so scripts/test-kpi-contract.mjs can load
// this file (and its mutants) in bare Node.

// A value the page has no label for. Rendered rather than thrown, so a new value
// on the server degrades to "Unknown" instead of blanking the page; the contract
// runner fails when a value the contract names lands here.
const UNKNOWN = Object.freeze({ label: 'Unknown', tone: 'muted', known: false })

// The metric's kind, as the catalog states it.
export const KIND_BADGES = Object.freeze({
  real: Object.freeze({ label: 'Real', tone: 'real' }),
  estimate: Object.freeze({ label: 'Estimate', tone: 'estimate' }),
  proxy: Object.freeze({ label: 'Proxy', tone: 'proxy' }),
  not_tracked: Object.freeze({ label: 'Not tracked', tone: 'muted' }),
})

// A status other than 'ok' says more than the kind does, so it takes the badge:
// a real metric with no figure must not read "Real".
export const STATUS_BADGES = Object.freeze({
  ok: null,
  partial: null,
  missing: Object.freeze({ label: 'Missing data', tone: 'missing' }),
  not_tracked: Object.freeze({ label: 'Not tracked', tone: 'muted' }),
})

// Shown next to the kind badge while a figure covers only part of its data.
export const PARTIAL_BADGE = Object.freeze({ label: 'Partial coverage', tone: 'partial' })

export const CONFIDENCE_BADGES = Object.freeze({
  high: Object.freeze({ label: 'High confidence', tone: 'high' }),
  medium: Object.freeze({ label: 'Medium confidence', tone: 'medium' }),
  low: Object.freeze({ label: 'Low confidence', tone: 'low' }),
  none: Object.freeze({ label: 'No figure', tone: 'muted' }),
})

export const RUN_STATUS_BADGES = Object.freeze({
  ok: Object.freeze({ label: 'Completed', tone: 'high' }),
  partial: Object.freeze({ label: 'Completed with gaps', tone: 'low' }),
  failed: Object.freeze({ label: 'Failed', tone: 'missing' }),
  running: Object.freeze({ label: 'Running', tone: 'partial' }),
})

export const RUN_KIND_LABELS = Object.freeze({
  nightly: 'Nightly',
  manual: 'Started by an admin',
  boot: 'After a restart',
})

// The preview digest (one send to the admin inbox after the first snapshot) and
// the weekly digest share these states.
export const DIGEST_STATUS_BADGES = Object.freeze({
  pending: Object.freeze({ label: 'Not sent yet', tone: 'muted' }),
  claimed: Object.freeze({ label: 'Sending', tone: 'partial' }),
  sent: Object.freeze({ label: 'Sent', tone: 'high' }),
  failed: Object.freeze({ label: 'Failed', tone: 'missing' }),
  no_recipient: Object.freeze({ label: 'No admin inbox set', tone: 'low' }),
})

export const EVENT_LABELS = Object.freeze({
  ai_dispatch: 'AI dispatch',
  dedicated: 'Dedicated contracts',
})

export const BEFORE_AFTER_STATUS_LABELS = Object.freeze({
  ok: '',
  date_not_set: 'Date not set',
  missing: 'Missing data',
  insufficient: 'Not enough data',
})

function lookup(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) && table[key] ? { ...table[key], known: true } : UNKNOWN
}

/** The one kind/status badge on a metric card: Real, Estimate, Proxy, Missing data or Not tracked. */
export function kindBadge(metric) {
  const status = metric?.status
  if (Object.prototype.hasOwnProperty.call(STATUS_BADGES, status) && STATUS_BADGES[status]) {
    return { ...STATUS_BADGES[status], known: true }
  }
  if (!Object.prototype.hasOwnProperty.call(STATUS_BADGES, status)) return UNKNOWN
  return lookup(KIND_BADGES, metric?.kind)
}

export function confidenceBadge(confidence) {
  return lookup(CONFIDENCE_BADGES, confidence)
}

export function runStatusBadge(status) {
  return lookup(RUN_STATUS_BADGES, status)
}

export function runKindLabel(kind) {
  return Object.prototype.hasOwnProperty.call(RUN_KIND_LABELS, kind) ? RUN_KIND_LABELS[kind] : UNKNOWN.label
}

export function digestStatusBadge(status) {
  return lookup(DIGEST_STATUS_BADGES, status)
}

export function eventLabel(event) {
  return Object.prototype.hasOwnProperty.call(EVENT_LABELS, event) ? EVENT_LABELS[event] : UNKNOWN.label
}

// ── Groups ─────────────────────────────────────────────────────────────────────
// The catalog names each metric's group and sends the metrics in catalog order,
// so a group is placed where its first metric is. A group key such as
// "fuel_and_carbon" reads "Fuel and carbon"; a key that is already words is kept.

export function groupLabel(group) {
  const text = String(group ?? '').trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  if (!text) return 'Other'
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** [{ key, label, metrics }] in the order each group first appears; every metric once. */
export function groupMetrics(metrics) {
  const groups = []
  const byKey = new Map()
  for (const metric of Array.isArray(metrics) ? metrics : []) {
    const key = String(metric?.group ?? '').trim() || 'other'
    let group = byKey.get(key)
    if (!group) {
      group = { key, label: groupLabel(key), metrics: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.metrics.push(metric)
  }
  return groups
}

// ── Sparkline ──────────────────────────────────────────────────────────────────
// One point per month of `series`. A month with no figure (value null: "No
// records", "No data") is a GAP: the line breaks there and a tick marks the month.
// It is never drawn as 0, which would read as a month with nothing delivered. The
// values are placed between the lowest and highest plotted month, so the line
// shows the shape of the trend; the figures themselves are the `display` strings.
//
// `openPeriod` names the month still in progress (the as-of month, 'YYYY-MM'). Its
// figure covers only the days so far, so the step into it is drawn dashed rather
// than as part of the line: a solid drop there reads as a collapse.

export const SPARK_WIDTH = 240
export const SPARK_HEIGHT = 48
export const SPARK_PAD = 4

function isPlotted(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

export function sparkline(series, { width = SPARK_WIDTH, height = SPARK_HEIGHT, pad = SPARK_PAD, openPeriod = '' } = {}) {
  const list = Array.isArray(series) ? series : []
  const count = list.length
  const values = list.filter((p) => isPlotted(p?.value)).map((p) => p.value)
  const low = values.length ? Math.min(...values) : 0
  const high = values.length ? Math.max(...values) : 0
  const xAt = (i) => (count === 1 ? width / 2 : pad + (i / (count - 1)) * (width - 2 * pad))
  const yAt = (v) => (high === low ? height / 2 : height - pad - ((v - low) / (high - low)) * (height - 2 * pad))

  const points = []
  const gaps = []
  const segments = []
  let run = []
  list.forEach((p, i) => {
    const period = String(p?.period ?? '')
    const display = String(p?.display ?? '')
    if (isPlotted(p?.value)) {
      const point = { index: i, x: xAt(i), y: yAt(p.value), period, display }
      points.push(point)
      run.push(point)
    } else {
      gaps.push({ index: i, x: xAt(i), period, display })
      if (run.length) segments.push(run)
      run = []
    }
  })
  if (run.length) segments.push(run)

  const toAttr = (pts) => pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
  const lastRun = segments[segments.length - 1]
  const lastPoint = lastRun ? lastRun[lastRun.length - 1] : null
  const open = !!openPeriod && !!lastPoint && lastPoint.period === openPeriod && lastPoint.index === count - 1
  let openLine = ''
  if (open && lastRun.length > 1) {
    openLine = toAttr(lastRun.slice(-2))
    segments[segments.length - 1] = lastRun.slice(0, -1)
  }

  return {
    width,
    height,
    points,
    gaps,
    // Each unbroken run of months, as an SVG points attribute. A run of one month
    // is drawn as its dot alone.
    lines: segments.filter((s) => s.length > 1).map(toAttr),
    // The dashed step into the month in progress; '' when there is none.
    openLine,
    openIndex: open ? lastPoint.index : -1,
    first: count ? String(list[0]?.period ?? '') : '',
    last: count ? String(list[count - 1]?.period ?? '') : '',
    hasData: points.length > 0,
  }
}

// ── Rows ───────────────────────────────────────────────────────────────────────

/** A comparison as shown: the server's label and display; a missing one is muted. */
export function comparisonRow(comparison) {
  return {
    label: String(comparison?.label ?? ''),
    display: String(comparison?.display ?? ''),
    muted: comparison?.status !== 'ok',
  }
}

/**
 * A before/after row. `formatDate` turns the event's 'YYYY-MM-DD' into words
 * (the page passes utils/datetime.js fmtYmd); a date the admins have not set
 * reads "Date not set".
 */
export function beforeAfterRow(row, formatDate = (d) => d) {
  const status = String(row?.status ?? '')
  const date = typeof row?.date === 'string' && row.date ? row.date : null
  return {
    event: eventLabel(row?.event),
    dateText: date ? formatDate(date) : BEFORE_AFTER_STATUS_LABELS.date_not_set,
    status,
    statusLabel: Object.prototype.hasOwnProperty.call(BEFORE_AFTER_STATUS_LABELS, status) ? BEFORE_AFTER_STATUS_LABELS[status] : UNKNOWN.label,
    before: row?.before ? String(row.before.display ?? '') : '',
    after: row?.after ? String(row.after.display ?? '') : '',
    hasSides: !!(row?.before || row?.after),
    display: String(row?.display ?? ''),
    note: String(row?.note ?? ''),
    muted: status !== 'ok',
  }
}

/**
 * "Delivered loads with a stated weight: 31 of 120". The two counts as the server
 * sent them; no share is worked out here (the contract sends no display for the
 * ratio, so none is shown).
 */
export function coverageText(coverage) {
  const what = String(coverage?.what ?? '').trim()
  const num = coverage?.num
  const den = coverage?.den
  if (!Number.isFinite(num) || !Number.isFinite(den)) return what
  const counts = `${num.toLocaleString('en-US')} of ${den.toLocaleString('en-US')}`
  return what ? `${what}: ${counts}` : counts
}

export const APPROVAL_STALE_NOTE = 'Approval reset: definition or settings changed'

export function approvalView(approval) {
  const approved = approval?.approved === true
  const stale = approval?.stale === true
  return {
    approved,
    answer: approved ? 'Yes' : 'No',
    stale,
    staleNote: stale ? APPROVAL_STALE_NOTE : '',
    by: typeof approval?.by === 'string' && approval.by ? approval.by : '',
    at: typeof approval?.at === 'string' && approval.at ? approval.at : '',
  }
}

/** What the confirm dialog says before an approval is set or withdrawn. */
export function approvalConfirmText(label, approve) {
  const name = String(label ?? '').trim() || 'this metric'
  return approve
    ? {
        title: `Approve “${name}” for public use?`,
        body: 'Social posts and the investor data room may use this figure. The approval resets by itself when the definition or the settings it uses change.',
        action: 'Approve for public use',
      }
    : {
        title: `Withdraw approval for “${name}”?`,
        body: 'Social posts and the investor data room may no longer use this figure.',
        action: 'Withdraw approval',
      }
}

/** A run's length: "38 s", "2 min 5 s", "<1 s". Job timing only, never a KPI. */
export function durationText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return '<1 s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const rest = seconds % 60
  return rest ? `${Math.floor(seconds / 60)} min ${rest} s` : `${Math.floor(seconds / 60)} min`
}

// ── Recompute and settings answers ─────────────────────────────────────────────

export const RECOMPUTE_MESSAGES = Object.freeze({
  inProgress: 'A run is already in progress',
  tooSoon: 'Please wait before recomputing again',
  fallback: 'The recompute could not be started.',
})

export function recomputeErrorMessage(err) {
  if (err?.status === 409 || err?.code === 'KPI_RUN_IN_PROGRESS') return RECOMPUTE_MESSAGES.inProgress
  if (err?.status === 429) return RECOMPUTE_MESSAGES.tooSoon
  return err?.message || RECOMPUTE_MESSAGES.fallback
}

export const SETTINGS_FIELDS = Object.freeze(['aiDispatchStart', 'dedicatedStart', 'baselineMpg', 'recipients'])
export const MPG_MIN = 3
export const MPG_MAX = 15
export const RECIPIENTS_MAX = 10

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/** The server's 400 { error, code, field } as { field, message }; field is null when it names none of the form's. */
export function settingsErrorFrom(err) {
  const field = err?.data?.field
  return {
    field: SETTINGS_FIELDS.includes(field) ? field : null,
    message: err?.message || 'The KPI settings could not be saved.',
  }
}

/** The editable form, from §4 settings. The AI dispatch box holds only an admin override. */
export function settingsFormFrom(settings) {
  const ai = settings?.aiDispatchStart
  const mpg = settings?.baselineMpg
  return {
    aiDispatchStart: ai?.source === 'admin' && typeof ai.value === 'string' ? ai.value : '',
    dedicatedStart: typeof settings?.dedicatedStart?.value === 'string' ? settings.dedicatedStart.value : '',
    baselineMpg: typeof mpg === 'number' && Number.isFinite(mpg) ? String(mpg) : '',
    recipients: Array.isArray(settings?.recipients) ? settings.recipients.join('\n') : '',
  }
}

/**
 * The recipients box as the server will store it: one address per line (commas
 * and spaces separate too), trimmed, lower-cased, each once. The server checks
 * every address; this only counts them.
 */
export function parseRecipients(text) {
  const seen = new Set()
  for (const part of String(text ?? '').split(/[\s,;]+/)) {
    const address = part.trim().toLowerCase()
    if (address) seen.add(address)
  }
  return [...seen]
}

function dateOrNull(text) {
  return String(text ?? '').trim() || null
}

/**
 * Compares the form with the settings it was opened from and returns the PUT
 * body with ONLY the fields that changed, plus any error the form can see before
 * asking (the server checks everything again and its answer wins).
 *   { body: { baselineMpg: 7.5 }, changed: ['baselineMpg'], errors: {} }
 */
export function settingsChanges(settings, form) {
  const original = settingsFormFrom(settings)
  const body = {}
  const errors = {}

  for (const field of ['aiDispatchStart', 'dedicatedStart']) {
    const next = dateOrNull(form?.[field])
    if (next !== null && !YMD_RE.test(next)) {
      errors[field] = 'Enter a date as YYYY-MM-DD, or leave it empty.'
      continue
    }
    if (next !== dateOrNull(original[field])) body[field] = next
  }

  const mpgText = String(form?.baselineMpg ?? '').trim()
  const mpg = mpgText === '' ? null : Number(mpgText)
  if (mpg !== null && !(Number.isFinite(mpg) && mpg >= MPG_MIN && mpg <= MPG_MAX)) {
    errors.baselineMpg = `Baseline MPG must be a number from ${MPG_MIN} to ${MPG_MAX}, or empty.`
  } else {
    const before = original.baselineMpg === '' ? null : Number(original.baselineMpg)
    if (mpg !== before) body.baselineMpg = mpg
  }

  const recipients = parseRecipients(form?.recipients)
  if (recipients.length > RECIPIENTS_MAX) {
    errors.recipients = `At most ${RECIPIENTS_MAX} recipients.`
  } else if (recipients.join('\n') !== parseRecipients(original.recipients).join('\n')) {
    body.recipients = recipients
  }

  return { body, changed: Object.keys(body), errors }
}
