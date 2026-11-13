// The before-payroll check's page (GET /api/admin/payroll-check): its words, the weeks it offers and
// views of the server's answer. The server finds every day, line and reason and sums every figure;
// this only names them and shows whole cents as dollars. Pinned by scripts/test-payroll-check-client.mjs.
import { formatMoneyCents } from './paymentTerms.js'
import { monthLabel } from './monthLabel.js'
import { fmtAppInstant, fmtYmd, isYmd, satFriWeekOf, shiftYmd } from '../utils/datetime.js'

export const CHECK_URL = '/api/admin/payroll-check'
export const PAGE_ROUTE_NAME = 'invoices-payroll-check'
const WEEKS_OFFERED = 8

// Every fixed word the page and the Invoices link show, in one place.
export const WORDS = Object.freeze({
  link: 'Before-payroll check',
  title: 'Before-payroll check',
  intro: 'What no invoice holds yet, and what waits for you, before you pay a week. Read only: nothing here changes an invoice.',
  back: 'Back to Invoices',
  week: 'Week',
  again: 'Check again',
  retry: 'Try again',
  loading: 'Checking…',
  off: 'The before-payroll check is not switched on.',
  refused: 'That week can\'t be checked. Pick another week.',
  retryLine: 'The check couldn\'t run just now. Try again in a moment.',
  failed: 'The check couldn\'t be loaded. Try again in a moment.',
  forbidden: 'Only a Super Admin can run the before-payroll check.',
  allClear: 'Nothing to look at for this week.',
  empty: 'Nothing here.',
  totals: 'Totals',
  byDriver: 'By driver and week',
  driver: 'Driver',
  weekColumn: 'Week',
  why: 'Why',
  checkedAt: 'Checked',
})

// The six lists the server sends, each with its columns; the reason column shows on the lists that
// carry one. `short` names a list in the totals and the roll-up.
const PARTS = Object.freeze({
  ledgerDays: {
    title: 'Days no invoice pays', short: 'Days no invoice pays', reasons: true,
    columns: [['day', 'Day'], ['load', 'Load'], ['invoice', 'Week\'s invoice'], ['amount', 'Amount']],
  },
  invoiceDays: {
    title: 'Days paid that the books no longer count', short: 'Paid days the books dropped', reasons: true,
    columns: [['day', 'Day'], ['invoice', 'Invoice'], ['load', 'Load'], ['amount', 'Amount']],
  },
  personalLines: {
    title: 'Personal lines on no invoice', short: 'Personal lines', reasons: true,
    columns: [['date', 'Receipt date'], ['vendor', 'Vendor'], ['amount', 'Amount']],
  },
  pendingReceipts: {
    title: 'Receipts still Pending', short: 'Pending receipts', reasons: false,
    columns: [['date', 'Date'], ['type', 'Type'], ['load', 'Load'], ['amount', 'Amount']],
  },
  correctionDrafts: {
    title: 'Correction invoices to approve', short: 'Corrections to approve', reasons: false,
    columns: [['invoice', 'Invoice'], ['status', 'Status'], ['kind', 'For'], ['corrects', 'Corrects'], ['amount', 'Total due']],
  },
  percentageLoads: {
    title: 'Percentage drivers\' loads no invoice bills', short: 'Percentage loads (revenue)', reasons: true,
    columns: [['load', 'Load'], ['completed', 'Completed'], ['amount', 'Revenue']],
  },
})
const PART_KEYS = Object.keys(PARTS)

// The plan's five sections; the fifth holds two lists.
export const SECTIONS = Object.freeze([
  { key: 'ledgerDays', title: 'Days no invoice pays', note: 'The books count these days as pay, but no invoice holds them. Each says why.', parts: ['ledgerDays'] },
  { key: 'invoiceDays', title: 'Days paid that the books no longer count', note: 'An invoice paid these days and the books leave them out now. Nothing is taken back; you decide.', parts: ['invoiceDays'] },
  { key: 'personalLines', title: 'Personal lines on no invoice', note: 'Personal expenses still waiting to come off an invoice, and why.', parts: ['personalLines'] },
  { key: 'pendingReceipts', title: 'Receipts still Pending', note: 'No one has approved, rejected or marked these yet. Decide each before payroll.', parts: ['pendingReceipts'] },
  { key: 'waiting', title: 'Waiting on you', note: 'Correction invoices to approve, and percentage drivers\' loads no invoice bills yet.', parts: ['correctionDrafts', 'percentageLoads'] },
])

// The server's reason codes as short tags; its own sentence goes beside each.
export const REASONS = Object.freeze({
  mayBePaid: 'May already be paid',
  settlesInClosedMonth: 'Load settles in a closed month',
  noWeeklyInvoice: 'No weekly invoice',
  twoWeeklyInvoices: 'Two weekly invoices',
  deletedDraft: 'Correction was deleted',
  closedMonth: 'Closed month',
  beforeFrom: 'Before the start month',
  addedAfterInvoice: 'Added after the invoice',
  blankPickup: 'Blank pickup',
  loadUndated: 'Load has no date',
  completedAfterInvoice: 'Completed after the invoice',
  investorScopeNoEld: 'Investor books: no ELD',
  invoiceEldNoDriving: 'ELD showed no driving',
  unexplained: 'No known reason',
  removeOverride: 'Removed on overrides',
  addRemoved: 'Added day taken off',
  loadNotLive: 'Load no longer live',
  blankDropoff: 'Blank drop-off',
  ledgerLeavesOut: 'Books leave it out',
  unknownDriver: 'Driver not in the Drivers Database',
  carried: 'Carried',
  needsCorrection: 'Needs a correction',
  pending: 'Waiting for its invoice',
  mayBeBilled: 'May already be billed',
})

const KINDS = Object.freeze({ days: 'Missed days', personal: 'Personal', other: 'Other correction' })

const own = (o, k) => !!o && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k)
const str = (v) => (typeof v === 'string' ? v.trim() : '')

export function canSeePayrollCheck(role) {
  return role === 'Super Admin'
}

// Only a Super Admin asks, with no week: the route answers 404 while switched off and, while on,
// refuses the missing week before it reads anything.
export function probeUrl(role) {
  return canSeePayrollCheck(role) ? CHECK_URL : ''
}

// true on, false off, null when the answer can't tell (ask again on the next page).
export function switchFromProbe(status, code) {
  if (status === 404) return false
  if (status === 200) return true
  if (status === 400 && code === 'PAYROLL_CHECK_WEEK_END_INVALID') return true
  return null
}

export function checkUrl(weekEnd) {
  return `${CHECK_URL}?weekEnd=${encodeURIComponent(String(weekEnd ?? ''))}`
}

// The Friday before the business week holding `today` (Saturday to Friday, as the invoices run).
export function lastFinishedWeekEnd(today) {
  const week = satFriWeekOf(today)
  return week ? shiftYmd(week.start, -1) : ''
}

// "Oct 3 – Oct 9, 2026" from a week's Saturday (and its own last day, when it has one).
export function weekRangeText(start, end = '') {
  const s = str(start)
  const e = isYmd(end) ? str(end) : shiftYmd(s, 6)
  const sText = isYmd(s) ? fmtYmd(s, { fallback: '' }) : ''
  const eText = isYmd(e) ? fmtYmd(e, { fallback: '' }) : ''
  if (!sText || !eText) return ''
  return s.slice(0, 4) === e.slice(0, 4) ? `${sText.replace(/, \d{4}$/, '')} – ${eText}` : `${sText} – ${eText}`
}

// The finished weeks a person may ask for, newest first; the server refuses one wholly in a closed month.
export function weekOptions(today, n = WEEKS_OFFERED) {
  const last = lastFinishedWeekEnd(today)
  if (!last) return []
  const out = []
  for (let i = 0; i < n; i++) {
    const end = shiftYmd(last, -7 * i)
    out.push({ value: end, label: weekRangeText(shiftYmd(end, -6), end) })
  }
  return out
}

// The server's whole cents in dollars, through the app's own formatter; anything else is a dash.
export function centsText(cents) {
  if (!Number.isSafeInteger(cents)) return '—'
  const dollars = formatMoneyCents(Math.abs(cents))
  return cents < 0 ? `-${dollars}` : dollars
}

export function reasonTag(code) {
  return own(REASONS, code) ? REASONS[code] : 'Other'
}

const serverWords = (err) => (err && err.data && typeof err.data.error === 'string' ? err.data.error.trim() : '')

// What a refused or failed read shows: off, the server's own words, or a line to try again.
export function errorView(err) {
  const status = err && Number.isInteger(err.status) ? err.status : 0
  const said = serverWords(err)
  if (status === 404) return { kind: 'off', text: WORDS.off }
  if (status === 400) return { kind: 'refused', text: said || WORDS.refused }
  if (status === 503) return { kind: 'retry', text: said || WORDS.retryLine }
  if (status === 403) return { kind: 'failed', text: WORDS.forbidden }
  return { kind: 'failed', text: said || WORDS.failed }
}

const dayText = (v) => (isYmd(v) ? fmtYmd(v) : '—')
const invoiceText = (number, status) => {
  const n = str(number)
  if (!n) return 'None'
  return str(status) ? `${n} (${str(status)})` : n
}

// Each list's cells, from the item's own fields only.
const CELLS = {
  ledgerDays: (x) => ({ day: dayText(x.day), load: str(x.loadId) || (x.added === true ? 'Added day' : '—'), invoice: invoiceText(x.invoiceNumber, x.invoiceStatus), amount: centsText(x.cents) }),
  invoiceDays: (x) => ({ day: dayText(x.day), invoice: invoiceText(x.invoiceNumber, x.status), load: (Array.isArray(x.loadIds) ? x.loadIds.filter((l) => str(l)).join(', ') : '') || '—', amount: centsText(x.cents) }),
  personalLines: (x) => ({
    date: dayText(x.receiptDate), vendor: str(x.merchant) || '—',
    amount: Number.isSafeInteger(x.shareCents) && x.shareCents > 0 ? `${centsText(x.cents)} (share returned +${centsText(x.shareCents)})` : centsText(x.cents),
  }),
  pendingReceipts: (x) => ({ date: dayText(x.date), type: str(x.type) || '—', load: str(x.loadId) || '—', amount: centsText(x.cents) }),
  correctionDrafts: (x) => ({ invoice: str(x.invoiceNumber) || '—', status: str(x.status) || '—', kind: own(KINDS, x.kind) ? KINDS[x.kind] : 'Correction', corrects: str(x.correctionOf) || '—', amount: centsText(x.cents) }),
  percentageLoads: (x) => ({ load: str(x.loadId) || '—', completed: isYmd(x.completed) ? fmtYmd(x.completed) : 'No date', amount: centsText(x.paymentCents) }),
}

// One list's items under a heading per driver and week, in the server's order (it sorts by driver,
// then week), each with its cells, its reason's tag and the server's own sentence.
function partView(key, items) {
  const def = PARTS[key]
  const groups = []
  items.forEach((x, i) => {
    const item = x && typeof x === 'object' ? x : {}
    const driver = str(item.driver) || '(no driver)'
    const weekStart = str(item.weekStart)
    const groupKey = `${driver}\t${weekStart}`
    let g = groups[groups.length - 1]
    if (!g || g.key !== groupKey) {
      g = { key: groupKey, label: `${driver} · ${weekRangeText(weekStart, item.weekEnd) || 'no week'}`, rows: [] }
      groups.push(g)
    }
    g.rows.push({
      key: `${key}:${i}`,
      cells: CELLS[key](item),
      tag: def.reasons ? reasonTag(item.reason) : '',
      text: def.reasons ? str(item.text) : '',
    })
  })
  return { key, title: def.title, reasons: def.reasons, columns: def.columns.map(([k, label]) => ({ key: k, label })), groups }
}

const countOf = (v) => (Number.isInteger(v) ? v : 0)
const byReasonView = (counts) => (counts && typeof counts === 'object'
  ? Object.keys(counts).map((code) => ({ code, tag: reasonTag(code), count: countOf(counts[code]) }))
  : [])

function scopeText(a) {
  const end = dayText(a.weekEnd)
  if (!isYmd(a.rangeStart)) return `Checked every week up to ${end}.`
  const closed = monthLabel(a.latestClosedMonth)
  return `Checked from ${dayText(a.rangeStart)}, the first week of the open months, to ${end}.${closed ? ` ${closed} and earlier are closed.` : ''}`
}

// The page's whole view of one answer, or null when it isn't in the route's shape (nothing is guessed).
export function checkView(answer) {
  if (!answer || typeof answer !== 'object') return null
  if (!PART_KEYS.every((k) => Array.isArray(answer[k])) || !answer.summary || typeof answer.summary !== 'object' || !Array.isArray(answer.drivers)) return null
  const summary = answer.summary
  const totals = PART_KEYS.map((k) => {
    const s = summary[k] && typeof summary[k] === 'object' ? summary[k] : {}
    return { key: k, title: PARTS[k].short, count: countOf(s.count), amount: centsText(k === 'percentageLoads' ? s.paymentCents : s.cents), byReason: byReasonView(s.byReason) }
  })
  const parts = Object.fromEntries(PART_KEYS.map((k) => [k, partView(k, answer[k])]))
  const drivers = []
  for (const d of answer.drivers) {
    const weeks = d && Array.isArray(d.weeks) ? d.weeks : []
    for (const w of weeks) {
      const counts = w && w.counts && typeof w.counts === 'object' ? w.counts : {}
      const cents = w && w.cents && typeof w.cents === 'object' ? w.cents : {}
      drivers.push({
        key: `${str(d.driver)}\t${str(w.weekStart)}`,
        driver: str(d.driver) || '(no driver)',
        week: weekRangeText(w.weekStart, w.weekEnd) || 'no week',
        cells: PART_KEYS.map((k) => {
          const count = countOf(counts[k])
          const amount = centsText(k === 'percentageLoads' ? w.percentageRevenueCents : cents[k])
          return { key: k, count, amount, text: count ? `${count} · ${amount}` : '—' }
        }),
      })
    }
  }
  return {
    weekText: weekRangeText(answer.weekStart, answer.weekEnd),
    scopeText: scopeText(answer),
    generatedText: answer.generatedAt ? fmtAppInstant(answer.generatedAt, { fallback: '' }) : '',
    totals,
    rollupColumns: PART_KEYS.map((k) => ({ key: k, label: PARTS[k].short })),
    sections: SECTIONS.map((s) => ({ key: s.key, title: s.title, note: s.note, parts: s.parts.map((k) => parts[k]) })),
    drivers,
    clear: totals.every((t) => t.count === 0),
  }
}
