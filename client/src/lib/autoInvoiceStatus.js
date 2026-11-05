// Automatic broker invoice drafts (AUTO_INVOICE_DRAFTS_ENABLED): the words for the
// status the server puts on a completed load's dashboard row as `_autoInvoice`
// ({ state, code, invoiceId, changed }; Super Admin only, real-draft mode only).
// The server sends codes (lib/auto-invoice-rules.js); this file is the one place
// they are worded. scripts/test-auto-invoice-status-client.mjs pins the codes,
// states and changed-field names to the server's. Display only, plus two checks
// the page runs (the Approve re-check and the settings Save), with no network:
// the page hands in its own read.

// Each reason: `short` follows "Needs attention: " or "Waiting: " on the chip; `text`
// is the sentence in the load dialog. `attentionText`, on a code a load can also hold
// while the job comes back to it, is the sentence once a person must act.
export const AUTO_INVOICE_REASONS = Object.freeze({
  WAITING_POD: { short: 'no POD yet', text: 'Waiting for the POD. Upload it; no invoice is made until then.', attentionText: 'No POD was found when the invoice was started. Upload it, then Try again.' },
  NOT_COMPLETED: { short: 'not delivered', text: "The load wasn't marked Delivered at the last check, so no invoice has been made. If it was delivered, set it back. If this line is still here a few minutes later, draft it by hand." },
  LOAD_DROPPED: { short: 'cancelled or deleted', text: 'The load was cancelled or deleted, so no invoice is made. Nothing to do.' },
  RATECON_MISSING: { short: 'no rate con', text: 'No rate con was found for this load. It is looked for again every 2 hours, three times; after that, draft it by hand.', attentionText: 'No rate con was found for this load. Add the rate con, then Try again, or draft it by hand.' },
  SEND_SETTLING: { short: 'about to send', text: 'The invoice is sent automatically once the wait after its newest POD is over, so a POD page added soon after goes with it. A new POD starts the wait again.' },
  RETRY_LATER: { short: 'last try failed', text: 'The last try failed. It is tried again on its own.', attentionText: 'Making the invoice failed. Try again, or draft it by hand.' },
  GEMINI_DOWN: { short: 'rate-con reader down', text: 'The rate-con reader is unavailable. It is tried again in 30 minutes.', attentionText: "The rate-con reader was unavailable, so no invoice was made. Try again once it's back, or draft it by hand." },
  RENDERER_BUSY: { short: 'PDF renderer busy', text: 'The PDF renderer was busy. It is tried again in a few minutes.', attentionText: 'The PDF renderer was busy, so no invoice was made. Try again in a few minutes.' },
  MAILBOX_PAUSED: { short: 'Gmail paused', text: 'Gmail refused the mailbox login, so automatic drafts are paused. They try again on their own.', attentionText: 'Gmail refused the mailbox login, so no invoice was made. LogisX waits up to 6 hours before it logs in again, so Try again after that. If it lasts, ask the mailbox owner to check it.' },
  SETTINGS_UNREADABLE: { short: 'settings unreadable', text: 'The automatic invoice settings could not be read, so nothing is made or sent. Save both lists in Automatic drafts.', attentionText: 'The automatic invoice settings could not be read, so nothing is made or sent. Open Automatic drafts, then save both lists, then Try again.' },
  SEND_UNCONFIRMED: { short: 'checking Sent Mail', text: 'The invoice email got no answer from Gmail, so it may have been sent. Sent Mail is checked again shortly. It is never sent twice.' },
  HAND_DRAFT_IN_FLIGHT: { short: 'being drafted by hand', text: 'Someone was drafting this invoice by hand, so it was not sent. It is looked at again in a few minutes.', attentionText: "Someone was drafting this invoice by hand, so it wasn't sent. If that draft didn't save, Try again." },
  ALREADY_DRAFTED: { short: 'drafted by hand', text: 'An invoice draft already existed for this load.' },
  DRAFTED_BY_HAND: { short: 'drafted by hand', text: 'Someone drafted this invoice by hand.' },
  BROKER_OPTED_OUT: { short: 'broker opted out', text: 'This broker is opted out of automatic drafts.' },
  LOAD_FACTORED: { short: 'factored (Triumph)', text: 'This load is factored: its invoice goes through Triumph, not by email.' },
  NO_BROKER_EMAIL: { short: 'no broker email', text: 'Job Tracking has no broker Email for this load. Add it, then Try again, or draft it by hand.' },
  BROKER_EMAIL_FREEMAIL: { short: 'broker email is free mail', text: "The broker Email on Job Tracking is a free-mail address, so it can't vouch for a billing email. Put the broker's company email on Job Tracking, then Try again, or draft it by hand." },
  BROKER_DOMAIN_UNCONFIRMED: { short: 'broker domain not confirmed', text: "This broker's email domain isn't on the confirmed list. Confirm it in the automatic-draft settings, then Try again, or draft it by hand." },
  CLOSED_MONTH: { short: 'closed month', text: 'The load is in a closed month. Draft it by hand if it still needs an invoice.' },
  MONTH_UNKNOWN: { short: "month can't be told", text: "The load's month can't be told from its dates. Check its dates, then Try again, or draft it by hand." },
  NO_DELIVERY_DATE: { short: 'no delivery date', text: 'The load has no delivery date. Set it on Job Tracking, then Try again, or draft it by hand.' },
  ADVANCE_LINES: { short: 'advance lines', text: 'The load has advance lines. Draft it by hand so the balance due is checked.' },
  POD_UNREADABLE: { short: 'POD file missing', text: "A POD on file has no readable file. Upload the POD again, delete the one that won't open, then Try again." },
  RECIPIENT_UNCONFIGURED: { short: 'no Bison inbox set', text: "Bison's invoice inbox is not set on the server. Draft it by hand." },
  OFF_GAP: { short: 'completed while off', text: 'The load was delivered while automatic invoices were off, so it may already be invoiced. Check Gmail Sent Mail, then draft it by hand if it still needs one.' },
  NO_BILLING_EMAIL: { short: 'no billing email', text: 'The rate con names no billing email for this broker. Draft it by hand and choose the recipient.' },
  RECIPIENT_DOMAIN_MISMATCH: { short: 'billing email on another domain', text: "The rate con's billing email is not on the broker's own domain. Draft it by hand and check the recipient." },
  RATECON_BY_CONTENT: { short: 'rate con found by content', text: 'The rate con was found only by reading Drive files. Draft it by hand and check it is the right one.' },
  TOTAL_MISMATCH: { short: 'totals differ', text: "The rate con's total and the Payment on Job Tracking don't agree, or the Payment isn't one plain amount. Check both; if a re-issued rate con changed it, see its alert. Fix Job Tracking if it's wrong, then Try again, or draft it by hand." },
  RATECON_TOTAL_UNREAD: { short: "rate con total couldn't be read", text: "The rate con's total couldn't be read, so it can't be checked against the Payment on Job Tracking. Try again reads it once more, or draft it by hand." },
  POD_PAGE_UNREADABLE: { short: 'POD page unreadable', text: "A POD page couldn't be read. Upload the POD again, delete the one that won't open, then Try again." },
  INVOICE_REFS_REQUIRED: { short: 'Bison Order # or PO # missing', text: "Bison's Order # or PO # couldn't be read. Draft it by hand and type them." },
  INVOICE_TOTAL_UNKNOWN: { short: 'total unknown', text: 'Neither the rate con nor Job Tracking gave an invoice total. Draft it by hand and type the total.' },
  TRAILER_MISMATCH: { short: 'trailer differs', text: "The rate con's trailer differs from Job Tracking. If Job Tracking is wrong, fix it, then Try again, or draft it by hand." },
  DRAFT_REFUSED: { short: 'draft refused', text: 'The invoice draft was refused. Draft it by hand to see why.' },
  DRAFT_FAILED: { short: 'Gmail kept failing', text: 'Making the invoice or saving it to Gmail kept failing. Try again, or draft it by hand.' },
  MAYBE_IN_GMAIL: { short: 'may already be in Gmail', text: 'The draft may already be in Gmail. Try again looks for it in Drafts and Sent Mail first; or check Gmail Drafts and Sent Mail.' },
  IN_GMAIL_UNRECORDED: { short: 'in Gmail, not recorded', text: "The invoice is in Gmail, but LogisX couldn't record it. Try again records it if it can. Check Gmail Drafts and Sent Mail before making another." },
  SEND_REFUSED: { short: 'not sent: last check failed', text: "The invoice email failed its last check before sending (recipient or attachments), so nothing was sent. Draft it by hand and check it." },
  MAYBE_SENT: { short: 'may already be sent', text: "The invoice email may have been sent to the broker, but it wasn't found in Gmail Sent Mail. Check Sent Mail before drafting it again. Try again searches Sent Mail once more; it never sends." },
  DRIVER_PENDING: { short: 'about to be made', text: "The driver just marked this load Delivered, so its invoice is about to be made." },
  NOT_BY_DRIVER: { short: 'no automatic invoice', text: "No automatic invoice was started for this load: only the driver's own Delivered starts one. Draft it by hand." },
  CAP_REACHED: { short: 'hourly or daily limit reached', text: "More invoices came due than the hourly or daily limit allows, so this one wasn't made. Try again in a while, or draft it by hand." },
  NO_MAILBOX: { short: 'no mailbox set', text: "No company mailbox is set on the server, so no invoice was made. Draft it by hand." },
  HANDED_OVER: { short: 'was in line at the change', text: "This load was in line when automatic invoices moved to the driver's Delivered, so its invoice wasn't made. Check Gmail, then Try again, or draft it by hand." },
  MAILBOX_HIT: { short: 'an email names this load', text: "An email already names this load, so nothing was sent. Check Gmail. If it still needs an invoice, draft it by hand." },
  MAILBOX_UNREAD: { short: "mailbox couldn't be searched", text: "The mailbox couldn't be searched, so nothing was sent. Try again in a while, or draft it by hand." },
  PAYMENTS_TABLE_HIT: { short: 'on the Payments Table', text: "The Payments Table already holds an invoice or payment for this load, so nothing was sent. Check it. If the load still needs an invoice, draft it by hand." },
  PAYMENTS_UNREAD: { short: "Payments Table couldn't be read", text: "The Payments Table couldn't be read, so nothing was sent. Try again in a while, or draft it by hand." },
  RECIPIENT_NOT_KNOWN: { short: 'billing email not used before', text: "The rate con's billing email isn't one a person has already used on invoices for 3 loads, so nothing was sent. Check it against the rate con, then draft it by hand." },
  RATECON_NAME_MISMATCH: { short: "rate con's name doesn't match", text: "The rate con's file name doesn't carry this load's whole number, so it may be another load's and nothing was sent. Check the rate con, then draft it by hand." },
  RATECON_NUMBER_MISMATCH: { short: "rate con's number doesn't match", text: "The rate con doesn't give this load's number, or gives another one, so it may be another load's and nothing was sent. Check the rate con, then draft it by hand." },
  RECIPIENT_CHECK_OFF: { short: 'billing email check is off', text: "The billing email check is switched off on the server, so this invoice wasn't made or sent. Draft it by hand." },
})

// The fields the server compares after a draft (rules.fingerprintDiff()).
export const AUTO_INVOICE_CHANGED_WORDS = Object.freeze({
  status: 'its status',
  removed: 'it was cancelled or deleted',
  payment: 'the Payment',
  brokerEmail: 'the broker Email',
  trailer: 'the trailer',
  pods: 'its POD files',
  rateCons: 'its rate con files',
})

// The states the server sends on a row; it never sends "baseline" or "skipped".
export const AUTO_INVOICE_STATES = Object.freeze(['waiting', 'queued', 'working', 'drafted', 'needs_attention'])

function reasonOf(code) {
  return typeof code === 'string' && Object.hasOwn(AUTO_INVOICE_REASONS, code) ? AUTO_INVOICE_REASONS[code] : null
}

function changedOf(status) {
  const list = status && Array.isArray(status.changed) ? status.changed : []
  return list.filter((f) => typeof f === 'string' && Object.hasOwn(AUTO_INVOICE_CHANGED_WORDS, f))
}

export function changedText(status) {
  const fields = changedOf(status)
  if (!fields.length) return ''
  const list = fields.map((f) => AUTO_INVOICE_CHANGED_WORDS[f]).join(', ')
  if (status.sent === true) return `Changed since the invoice was sent to the broker: ${list}. Check with the broker whether a corrected invoice is needed, then Mark checked.`
  return `Changed since the draft: ${list}. Check the draft in Gmail, then Mark checked.`
}

// The chip for a row's `_autoInvoice`: { label, tone, reason }, or null when
// there is nothing to show. Tones: ok, warn, bad, muted.
export function autoInvoiceChip(status) {
  if (!status || typeof status !== 'object') return null
  const reason = reasonOf(status.code)
  switch (status.state) {
    case 'drafted': {
      const id = typeof status.invoiceId === 'string' ? status.invoiceId : ''
      // Sent by the automatic job: it is in Sent Mail, and nobody sends it again.
      if (status.sent === true) {
        if (changedOf(status).length) return { label: 'Sent to the broker: load changed', tone: 'warn', reason: changedText(status) }
        return { label: 'Sent to the broker', tone: 'ok', reason: id ? `Invoice ${id} was sent to the broker automatically. Its copy is in Gmail Sent Mail.` : 'The invoice was sent to the broker automatically. Its copy is in Gmail Sent Mail.' }
      }
      if (changedOf(status).length) return { label: 'Draft ready in Gmail: load changed', tone: 'warn', reason: changedText(status) }
      return { label: 'Draft ready in Gmail', tone: 'ok', reason: id ? `Invoice ${id} is in Gmail Drafts. Check it and send it.` : 'The invoice is in Gmail Drafts. Check it and send it.' }
    }
    case 'waiting':
      if (status.code === 'WAITING_POD') return { label: 'Waiting for POD', tone: 'muted', reason: reason.text }
      if (status.code === 'RATECON_MISSING') return { label: 'Waiting for the rate con', tone: 'muted', reason: reason.text }
      return { label: reason ? `Waiting: ${reason.short}` : 'Waiting', tone: 'muted', reason: reason ? reason.text : '' }
    case 'queued':
      if (status.code === 'SEND_UNCONFIRMED') return { label: 'Checking Sent Mail', tone: 'warn', reason: reason.text }
      if (reason) return { label: `Waiting: ${reason.short}`, tone: 'muted', reason: reason.text }
      return { label: 'Waiting: about to be made', tone: 'muted', reason: 'The invoice will be made shortly.' }
    case 'working':
      return { label: 'Making the invoice now', tone: 'muted', reason: 'The invoice is being made. It takes a minute or two.' }
    case 'needs_attention':
      // Nothing failed on this load: nothing was started, so a person drafts it.
      if (status.code === 'NOT_BY_DRIVER') return { label: 'No automatic invoice', tone: 'warn', reason: reason.text }
      return { label: reason ? `Needs attention: ${reason.short}` : 'Needs attention', tone: 'bad', reason: reason ? (reason.attentionText || reason.text) : 'Draft it by hand.' }
    default:
      return null
  }
}

// What the "Needs attention" toggle counts: a load a person must draft, or a
// draft whose load changed since.
export function autoInvoiceNeedsAttention(row) {
  const s = row && row._autoInvoice
  if (!s || typeof s !== 'object') return false
  return s.state === 'needs_attention' || (s.state === 'drafted' && changedOf(s).length > 0)
}

// The server says what Try again would do (`retry`) while the driver's Delivered starts
// the invoice: "none" is a load it refuses, and a load nothing started has nothing to retry.
export const canTryAgain = (status) => Boolean(status && status.state === 'needs_attention' && status.code !== 'NOT_BY_DRIVER' && status.retry !== 'none')
export const canMarkChecked = (status) => Boolean(status && status.state === 'drafted' && changedOf(status).length > 0)

// The question before Try again, while it is the only retry and can send at once: "" asks
// nothing (the 5-minute sweep's Try again only queues the load).
export function tryAgainConfirmText(status) {
  if (!status || status.trigger !== true) return ''
  if (status.retry === 'send') return 'Try again looks in the mailbox and the Payments Table, then sends this invoice to the broker if every check passes. Continue?'
  if (status.retry === 'search') return 'Try again looks in Gmail first for what may already have gone. Continue?'
  return 'Try again makes this invoice a Gmail draft for a person to send, if every check passes. Continue?'
}

// What a person reads once the server has taken Try again.
export const tryAgainDoneText = (status) => (status && status.trigger === true ? "It's being made now." : 'It will be tried again within a few minutes.')

// --- Approve on the Draft Invoice preview, while real automatic drafts are on ---
// The job may draft a load while a person reads its preview, so Approve reads the
// load's latest draft row again and sets it against the one the load dialog had
// when it opened: a draft made in between (the job's, or another person's) is
// named and needs a yes, and so does a read that failed. A second invoice is never
// made unseen.

const DRAFT_FIELDS = Object.freeze(['invoice_id', 'created_at', 'via'])
const draftKey = (d) => (d && typeof d === 'object' ? DRAFT_FIELDS.map((f) => String(d[f] ?? '')).join('|') : '')

// Is `latest` (the row now, or null) a draft the dialog didn't know as `known`?
export function draftMadeSince(known, latest) {
  if (!latest || typeof latest !== 'object') return false
  return draftKey(known) !== draftKey(latest)
}

export const DRAFT_RECHECK_FAILED_TEXT = 'Could not check whether an invoice draft was made for this load since you opened it. Approve anyway?'

// The automatic job's own rows: its Gmail draft, and an invoice it sent
// (JOB_VIAS in lib/auto-invoice-rules.js).
const AUTO_DRAFT_VIA = 'auto-imap'
const AUTO_SENT_VIA = 'auto-smtp'
export const AUTO_INVOICE_VIAS = Object.freeze([AUTO_DRAFT_VIA, AUTO_SENT_VIA])

export function draftMadeSinceText(latest) {
  const id = latest && typeof latest.invoice_id === 'string' && latest.invoice_id ? ` (invoice ${latest.invoice_id})` : ''
  if (latest && latest.via === AUTO_SENT_VIA) {
    return `The automatic invoice job SENT an invoice for this load to the broker${id} since you opened it. Approving creates ANOTHER invoice with a new invoice number. Continue?`
  }
  const who = latest && latest.via === AUTO_DRAFT_VIA ? 'The automatic invoice drafts made' : 'Someone made'
  return `${who} an invoice draft for this load${id} since you opened it. Approving creates ANOTHER Gmail draft with a new invoice number (that draft is NOT removed). Continue?`
}

// Resolves { go, asked, latest }: `go` false stops the approve; `asked` says a
// question was put, so the preview asks no second one; `latest` is the row read
// (null for none), or undefined when the read failed. `readLatest` and `confirm`
// come from the page.
export async function recheckLoadDrafts({ known = null, readLatest, confirm }) {
  let latest
  try {
    latest = await readLatest()
  } catch {
    return { go: confirm(DRAFT_RECHECK_FAILED_TEXT) === true, asked: true, latest: undefined }
  }
  if (!draftMadeSince(known, latest)) return { go: true, asked: false, latest }
  return { go: confirm(draftMadeSinceText(latest)) === true, asked: true, latest }
}

// --- Approve on a load whose invoice the automatic job sent ---
// The server answers 409 INVOICE_ALREADY_SENT; another invoice goes only with a
// reason the person types, which the server records.
export const isReissueRefusal = (e) => Boolean(e && e.status === 409 && e.code === 'INVOICE_ALREADY_SENT')

export function reissuePrompt(e) {
  const said = (e && typeof e.message === 'string' && e.message) || "This load's invoice was already sent to the broker automatically."
  return `${said}\n\nTo issue another invoice anyway, type the reason (it is recorded). Cancel keeps things as they are.`
}

// The approve body again with the re-issue confirmed, or null when no reason was
// typed (Cancel, or only spaces).
export function reissueBody(body, reason) {
  const why = typeof reason === 'string' ? reason.trim().slice(0, 200) : ''
  if (!why) return null
  return { ...(body && typeof body === 'object' ? body : {}), confirmReissue: true, reissueReason: why }
}

// --- Automatic sending (AUTO_INVOICE_SEND_ENABLED), in the settings dialog ---
// The settings read carries `send` ({ domains, stopped: { at, reason } | null })
// only while sending is on. Why it stopped, by the server's codes
// (STOP_WORDS in lib/auto-invoice-send.js; pinned equal by the runner).
export const AUTO_INVOICE_STOP_WORDS = Object.freeze({
  STOPPED_BY_ADMIN: 'A Super Admin stopped it.',
  SMTP_LOGIN_REFUSED: 'Gmail refused the mailbox login for sending.',
  SMTP_REFUSED: 'Gmail refused an invoice email.',
  SEND_UNANSWERED: 'Gmail did not answer an invoice email, so it may have been sent.',
  MAYBE_SENT: 'An invoice email may have been sent but was not found in Sent Mail.',
  LOAD_CHANGED_AFTER_SEND: 'A load changed after its invoice was sent.',
})

export const AUTO_SEND_STOP_CONFIRM = 'Stop sending invoices automatically? Invoices will be drafted in Gmail for a person to send. Only the server can turn sending back on.'

// The dialog's sentence about sending, and whether Stop is offered. `check`: the settings read's
// `recipientCheck`. With that check off, its domain's invoices stop at a person, so the sentence
// doesn't say they are sent.
export function autoSendState(send, check = null) {
  if (!send || typeof send !== 'object') return null
  const domains = Array.isArray(send.domains) ? send.domains.filter((d) => typeof d === 'string') : []
  const stopped = send.stopped && typeof send.stopped === 'object' ? send.stopped : null
  if (stopped) {
    const why = typeof stopped.reason === 'string' && Object.hasOwn(AUTO_INVOICE_STOP_WORDS, stopped.reason) ? ` ${AUTO_INVOICE_STOP_WORDS[stopped.reason]}` : ''
    return { stopped: true, canStop: false, text: `Automatic sending is stopped.${why} Invoices are drafted in Gmail for a person to send. Only the server can turn sending back on.` }
  }
  const heldDomain = check && typeof check === 'object' && check.on === false && typeof check.domain === 'string' ? check.domain : ''
  const going = heldDomain ? domains.filter((d) => d !== heldDomain && !d.endsWith(`.${heldDomain}`)) : domains
  const heldText = heldDomain ? `Invoices to ${heldDomain} aren't sent while the billing email check is off: each load stops at Needs attention for a person to draft by hand. ` : ''
  if (heldDomain && !going.length) return { stopped: false, canStop: true, text: `${heldText}Other brokers get Gmail drafts.` }
  const where = going.length ? going.join(', ') : 'no domain'
  return { stopped: false, canStop: true, text: `On: invoices to ${where} are sent to the broker automatically, with the POD and the rate con, and their copies are in Gmail Sent Mail. ${heldText}Other brokers get Gmail drafts.` }
}

// The dialog's line about the billing email check, from the settings read's `recipientCheck`, which
// the server sends only when it is off or has held loads lately. { text }, or null for no line.
export function recipientCheckState(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return null
  const domain = typeof check.domain === 'string' ? check.domain : 'this broker'
  const days = Number.isInteger(check.days) ? check.days : 7
  const held = check.held && typeof check.held === 'object' ? check.held : {}
  const count = Number.isInteger(held.count) && held.count > 0 ? held.count : 0
  const loads = count === 1 ? '1 load' : `${count} loads`
  if (check.on === false) {
    const off = `The billing email check is switched off on the server, so invoices to ${domain} aren't made or sent: each load stops at Needs attention for a person to draft by hand.`
    return { text: count ? `${off} It has held ${loads} in the last ${days} days.` : off }
  }
  if (check.on !== true || !count) return null
  const reasons = Object.entries(held.byCode && typeof held.byCode === 'object' ? held.byCode : {})
    .filter(([code]) => reasonOf(code))
    .map(([code, n]) => `${n} ${reasonOf(code).short}`)
  return { text: `The billing email check has held ${loads} in the last ${days} days, so ${count === 1 ? 'its invoice was' : 'their invoices were'} not sent${reasons.length ? ` (${reasons.join(', ')})` : ''}. If ${domain}'s billing address changed or its rate cons now read differently, every new load will stop too. See Needs attention on Completed Loads.` }
}

// The automatic-draft settings dialog's Save: only once this opening's read has
// worked (lists saved without it would replace the stored ones, the opt-outs
// among them), and not while a read or a save is running.
export function canSaveAutoSettings({ read = false, loading = false, saving = false } = {}) {
  return read === true && !loading && !saving
}
