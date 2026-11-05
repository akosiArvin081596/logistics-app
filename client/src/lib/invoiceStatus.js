// One invoice status on each completed load: the words for `_invoiceStatus`, which the server
// puts on a Super Admin's completed rows. lib/invoice-status.js works the status out from codes
// and evidence the browser never sees; this file only words it and groups rows by it.
// scripts/test-invoice-status-client.mjs pins the words and codes to the server's.

import { AUTO_INVOICE_REASONS, autoInvoiceChip, canMarkChecked, changedText } from './autoInvoiceStatus.js'
import { fmtTimestamp, fmtYmd } from '../utils/datetime.js'

// The order the filter offers them.
export const INVOICE_STATUS_LABELS = Object.freeze({
  sent: 'Sent by LogisX',
  by_hand: 'Invoiced by hand',
  draft: 'Draft in Gmail',
  waiting: 'Waiting',
  needs_attention: 'Needs attention',
  factored: 'Factored (Triumph)',
  none_found: 'No invoice found',
  unknown: "Couldn't check",
})

// The codes the rule adds to the claims' own. `short` follows the status's word on the chip;
// `text` is the sentence.
export const INVOICE_STATUS_REASONS = Object.freeze({
  DRAFT_NOT_IN_GMAIL: { short: 'in neither Gmail mailbox', text: "An invoice draft was made in the app, but it's in neither Gmail Drafts nor Sent Mail. Check Gmail, then draft it again if it's needed." },
  MENTIONED: { short: 'an email names this load', text: "An email names this load, but it doesn't look like an invoice. Check Gmail." },
  BISON_ORDER_NUMBER: { short: 'Bison Order # unknown', text: "Bison invoices carry Bison's own Order #, so a search by load number can't tell. Check Gmail." },
  NOT_SEARCHED: { short: 'not searched yet', text: "The mailbox hasn't been searched for this load yet." },
  SEARCH_FAILED: { short: 'mailbox search failed', text: "The mailbox search failed; it's tried again." },
  PAYMENTS_NOT_READ: { short: 'Payments Table not read yet', text: "The Payments Table hasn't been read for this load yet." },
  FACTORING_UNREADABLE: { short: "factoring marker can't be read", text: "The factoring marker couldn't be read, so this load's status can't be told." },
  EVIDENCE_UNREADABLE: { short: "records can't be read", text: "This load's invoice records couldn't be read. Reload in a minute." },
  INVOICE_MAYBE_DRAFTED: { short: 'may already be in Gmail', text: 'An invoice draft for this load may already be in Gmail. Use Check Gmail on the load before drafting again.' },
})

const FOUND = Object.freeze({ SENT_MAIL: 'sent_mail', PAYMENTS: 'payments_table', DRAFT_ROW: 'draft_row' })
export const INVOICE_STATUS_FOUND = Object.freeze(Object.values(FOUND))

// These say nothing about the load, so a job's chip that tells a person what to do stands: "No
// automatic invoice" and OFF_GAP each say to check Sent Mail, then draft it by hand. An email
// naming the load, or Bison's Order #, keep their own words, and so do records that can't be read:
// they may hold an invoice, so nothing says to draft over them.
const SAYS_NOTHING = new Set(['NOT_SEARCHED', 'SEARCH_FAILED', 'PAYMENTS_NOT_READ'])
const STANDS_OVER_NOTHING = new Set(['NOT_BY_DRIVER', 'OFF_GAP'])

const shown = (v) => (typeof v === 'string' ? v : '')

function reasonOf(code) {
  if (typeof code !== 'string') return null
  if (Object.hasOwn(INVOICE_STATUS_REASONS, code)) return INVOICE_STATUS_REASONS[code]
  return Object.hasOwn(AUTO_INVOICE_REASONS, code) ? AUTO_INVOICE_REASONS[code] : null
}

const withWord = (status, reason) => (reason ? `${INVOICE_STATUS_LABELS[status]}: ${reason.short}` : INVOICE_STATUS_LABELS[status])
const joined = (...parts) => parts.filter(Boolean).join(' ')
const numbered = (read) => (shown(read.invoiceId) ? `Invoice ${read.invoiceId}.` : '')

// A change since the job's draft or send: from `_autoInvoice` where Mark checked is offered, else
// from the status, as with the job off or in shadow, where no button can clear it. The mark
// outlives the status, and its sentence is the only reason given for that button: without it a
// person sends a draft that's out of date, or clears a warning nobody read.
function changeOf(read, auto) {
  if (canMarkChecked(auto)) return { changed: auto.changed, canCheck: true, sent: auto.sent === true }
  return changedText({ changed: read.changed }) ? { changed: read.changed, canCheck: false, sent: false } : null
}
const changeWords = (change, sent) => changedText({ changed: change.changed, sent }, { canCheck: change.canCheck })

function sentChip(read, change) {
  const date = fmtYmd(shown(read.date), { fallback: '' })
  const sent = `${shown(read.invoiceId) ? `Invoice ${read.invoiceId}` : 'The invoice'} was sent to the broker automatically${date ? ` on ${date}` : ''}.`
  if (change) return { label: `${INVOICE_STATUS_LABELS.sent}: load changed`, tone: 'warn', reason: `${sent} ${changeWords(change, true)}` }
  return { label: INVOICE_STATUS_LABELS.sent, tone: 'ok', reason: `${sent} Its copy is in Gmail Sent Mail.` }
}

function byHandWords(read) {
  const id = shown(read.invoiceId)
  if (read.found === FOUND.DRAFT_ROW || read.sentUnchecked === true) {
    // A draft row proves a draft was made, not that it went, so it says what isn't known yet.
    return { label: `${INVOICE_STATUS_LABELS.by_hand}: Sent Mail not checked yet`, tone: 'muted', reason: `Someone drafted ${id ? `invoice ${id}` : 'this invoice'} by hand. Sent Mail not checked yet.` }
  }
  if (read.found === FOUND.SENT_MAIL) {
    const date = fmtYmd(shown(read.date), { fallback: '' })
    return { label: INVOICE_STATUS_LABELS.by_hand, tone: 'ok', reason: `${id ? `Invoice ${id} is` : 'An invoice for this load is'} in Gmail Sent Mail${date ? `, dated ${date}` : ''}.` }
  }
  const where = read.found === FOUND.PAYMENTS ? 'The Payments Table holds an invoice or payment for this load.' : ''
  return { label: INVOICE_STATUS_LABELS.by_hand, tone: 'ok', reason: joined(numbered(read), where) }
}

function byHandChip(read, change) {
  const chip = byHandWords(read)
  if (!change) return chip
  return { label: `${INVOICE_STATUS_LABELS.by_hand}: load changed`, tone: 'warn', reason: joined(chip.reason, changeWords(change, true)) }
}

function draftChip(read, change) {
  const id = shown(read.invoiceId)
  const whose = read.whose === 'job' ? 'LogisX made this draft.' : read.whose === 'person' ? 'Someone made this draft by hand.' : ''
  // With no search behind it, a person may already have sent it, so "send it" could bill twice.
  if (read.sentUnchecked === true) {
    const where = `${id ? `Invoice ${id}` : 'The invoice'} may be in Gmail Drafts, or already in Sent Mail if someone sent it: neither has been checked yet.`
    if (change) return { label: `${INVOICE_STATUS_LABELS.draft}: load changed`, tone: 'warn', reason: joined(whose, where, changeWords(change, false)) }
    return { label: `${INVOICE_STATUS_LABELS.draft}: Sent Mail not checked yet`, tone: 'muted', reason: joined(whose, where, 'Look in both before sending it or drafting again.') }
  }
  // Seen at the last search, and a person may have sent or deleted it since.
  const when = fmtTimestamp(shown(read.searchedAt), { fallback: '' })
  const where = `${id ? `Invoice ${id}` : 'An invoice for this load'} was in Gmail Drafts when last searched${when ? `, ${when}` : ''}. It may have been sent or deleted since: look in Drafts and Sent Mail`
  // Why the job held it, or an email that may be the invoice: either makes sending it the wrong
  // next step, so "send it" goes and both are said.
  const hold = reasonOf(read.code)
  const held = read.code ? `LogisX held this load${hold ? `: ${hold.short}` : ''}. Check that before sending it.` : ''
  const named = read.mentioned === true && read.code !== 'MAILBOX_HIT' ? 'An email also names this load, and it may be the invoice. Check it before sending the draft.' : ''
  if (change) return { label: `${INVOICE_STATUS_LABELS.draft}: load changed`, tone: 'warn', reason: joined(whose, `${where}.`, held, named, changeWords(change, false)) }
  if (held || named) {
    const short = hold ? hold.short : named ? 'an email names this load' : ''
    return { label: short ? `${INVOICE_STATUS_LABELS.draft}: ${short}` : INVOICE_STATUS_LABELS.draft, tone: 'warn', reason: joined(whose, `${where}.`, held, named) }
  }
  return { label: INVOICE_STATUS_LABELS.draft, tone: 'ok', reason: joined(whose, `${where}, and send it if it still needs sending.`) }
}

// Any other status keeps its own words, then says what changed and what to do.
function withChange(chip, change) {
  if (!change) return chip
  return { ...chip, tone: chip.tone === 'bad' ? 'bad' : 'warn', reason: joined(chip.reason, changeWords(change, change.sent)) }
}

function waitingChip(read, auto) {
  const reason = reasonOf(read.code)
  // A send with no answer: nothing is being made, and it may have gone.
  if (read.code === 'SEND_UNCONFIRMED') return { label: withWord('waiting', reason), tone: 'warn', reason: reason.text }
  if (auto && auto.state === 'working') return autoInvoiceChip(auto)
  if (reason) return { label: withWord('waiting', reason), tone: 'muted', reason: reason.text }
  return autoInvoiceChip({ state: 'queued' })
}

function attentionChip(read) {
  const reason = reasonOf(read.code)
  const why = reason ? (reason.attentionText || reason.text) : 'Draft it by hand.'
  // MAILBOX_HIT already says an email names the load.
  const mention = read.mentioned === true && read.code !== 'MAILBOX_HIT' ? INVOICE_STATUS_REASONS.MENTIONED.text : ''
  return { label: withWord('needs_attention', reason), tone: 'bad', reason: joined(numbered(read), why, mention) }
}

function noneFoundChip(read) {
  const when = fmtTimestamp(shown(read.searchedAt), { fallback: '' })
  return { label: INVOICE_STATUS_LABELS.none_found, tone: 'warn', reason: `Gmail Drafts and Sent Mail hold no invoice for this load${when ? `, last searched ${when}` : ''}. That isn't proof: it may have been billed another way.` }
}

function unknownChip(read) {
  const reason = reasonOf(read.code)
  return { label: withWord('unknown', reason), tone: 'muted', reason: joined(numbered(read), reason ? reason.text : '') }
}

// A status from the server this file has a word for.
const statusOf = (row) => {
  const read = row && row._invoiceStatus
  return read && typeof read === 'object' && typeof read.status === 'string' && Object.hasOwn(INVOICE_STATUS_LABELS, read.status) ? read : null
}

export const hasInvoiceStatus = (row) => statusOf(row) !== null

// The one chip on a completed row, and its line in the load dialog: { label, tone, reason }, or
// null. With no status on the row (the kill switch) it's the job's own chip, as before.
export function invoiceStatusChip(row) {
  const auto = row ? row._autoInvoice : null
  const read = statusOf(row)
  if (!read) return autoInvoiceChip(auto)
  if (auto && STANDS_OVER_NOTHING.has(auto.code) && read.status === 'unknown' && SAYS_NOTHING.has(read.code)) return autoInvoiceChip(auto)
  const change = changeOf(read, auto)
  switch (read.status) {
    case 'sent': return sentChip(read, change)
    case 'by_hand': return byHandChip(read, change)
    case 'draft': return draftChip(read, change)
    case 'waiting': return withChange(waitingChip(read, auto), change)
    case 'needs_attention': return withChange(attentionChip(read), change)
    case 'factored': return withChange({ label: INVOICE_STATUS_LABELS.factored, tone: 'muted', reason: AUTO_INVOICE_REASONS.LOAD_FACTORED.text }, change)
    case 'none_found': return withChange(noneFoundChip(read), change)
    default: return withChange(unknownChip(read), change)
  }
}

// --- the filter ---------------------------------------------------------------------------

// The statuses with how many of `rows` hold each. A row with no status is in no bucket: nothing
// here decides that a load couldn't be checked. `none_found` is offered only on the server's word
// that the mailbox pass is on, since nothing else can say it.
export function invoiceStatusOptions(rows, { mailboxPass = false } = {}) {
  const counts = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const read = statusOf(row)
    if (read) counts.set(read.status, (counts.get(read.status) || 0) + 1)
  }
  return Object.entries(INVOICE_STATUS_LABELS)
    .filter(([value]) => value !== 'none_found' || mailboxPass === true)
    .map(([value, label]) => {
      const count = counts.get(value) || 0
      return { value, label, count, text: `${label} (${count})` }
    })
}

export function filterByInvoiceStatus(rows, value) {
  if (!value) return rows
  const list = Array.isArray(rows) ? rows : []
  return list.filter((row) => {
    const read = statusOf(row)
    return Boolean(read) && read.status === value
  })
}

// --- the page's other words -----------------------------------------------------------------

// The open dialog holds its own copy of the row, read when it opened. Mark checked taken: the
// same status, without the mark the server just cleared. Try again taken: no status at all, so
// the line reads the job's own words until the next read; the browser doesn't choose a new one.
export function statusAfterAction(kind, read) {
  if (kind !== 'checked' || !read || typeof read !== 'object') return undefined
  const { changed: _changed, ...rest } = read
  return rest
}

// The server's refusal when the load holds more changes than the line named: Mark checked covers
// only what a person was shown. The open line takes the server's list, so it names them, and the
// next press has been shown them.
export const isChangedAgain = (e) => Boolean(e && e.status === 409 && e.code === 'AUTO_INVOICE_CHANGED_AGAIN')

export function jobAfterChangedAgain(job, e) {
  const list = e && e.data && Array.isArray(e.data.changed) ? e.data.changed.filter((f) => typeof f === 'string') : []
  if (!job || !list.length) return job
  return { ...job, _autoInvoice: { ...job._autoInvoice, changed: list } }
}

export function exportNoteText({ attention = false, status = false } = {}) {
  const names = ['Search', 'Needs Review', ...(attention ? ['Needs attention'] : []), ...(status ? ['Invoice status'] : [])]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} aren’t applied to the downloaded file.`
}

// The toggle counts by the job's status and the select by the invoice status, so they can differ.
export function attentionToggleTitle({ on = false, statusShown = false } = {}) {
  const base = `${on ? 'Showing' : 'Show'} only loads whose automatic invoice draft needs attention`
  return statusShown ? `${base}. It also counts a load changed after its invoice went and a load nothing started, so its number can differ from the Invoice status filter's.` : base
}
