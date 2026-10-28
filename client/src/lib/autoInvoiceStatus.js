// Automatic broker invoice drafts (AUTO_INVOICE_DRAFTS_ENABLED): the words for the
// status the server puts on a completed load's dashboard row as `_autoInvoice`
// ({ state, code, invoiceId, changed }; Super Admin only, real-draft mode only).
// The server sends codes (lib/auto-invoice-rules.js); this file is the one place
// they are worded. scripts/test-auto-invoice-status-client.mjs pins the codes,
// states and changed-field names to the server's. Display only.

// Each reason: `short` follows "Needs attention: " on the chip; `text` is the
// sentence in the load dialog.
export const AUTO_INVOICE_REASONS = Object.freeze({
  WAITING_POD: { short: 'no POD yet', text: 'Waiting for the POD. The draft is made once a POD is uploaded.' },
  NOT_COMPLETED: { short: 'not delivered', text: 'The load is no longer marked delivered.' },
  LOAD_DROPPED: { short: 'cancelled or deleted', text: 'The load was cancelled or deleted.' },
  RATECON_MISSING: { short: 'no rate con', text: 'No rate con was found for this load. It is looked for again every 2 hours, three times; after that, draft it by hand.' },
  RETRY_LATER: { short: 'trying again', text: 'The last try failed. It is tried again on its own.' },
  GEMINI_DOWN: { short: 'rate-con reader down', text: 'The rate-con reader is unavailable. It is tried again in 30 minutes.' },
  RENDERER_BUSY: { short: 'PDF renderer busy', text: 'The PDF renderer was busy. It is tried again in a few minutes.' },
  MAILBOX_PAUSED: { short: 'Gmail paused', text: 'Gmail refused the mailbox login, so automatic drafts are paused. They try again on their own.' },
  SETTINGS_UNREADABLE: { short: 'opt-out list unreadable', text: 'The opt-out list could not be read, so nothing is drafted. Save the opt-out list again.' },
  ALREADY_DRAFTED: { short: 'drafted by hand', text: 'An invoice draft already existed for this load.' },
  DRAFTED_BY_HAND: { short: 'drafted by hand', text: 'Someone drafted this invoice by hand.' },
  BROKER_OPTED_OUT: { short: 'broker opted out', text: 'This broker is opted out of automatic drafts.' },
  NO_BROKER_EMAIL: { short: 'no broker email', text: 'Job Tracking has no broker Email for this load. Draft it by hand.' },
  CLOSED_MONTH: { short: 'closed month', text: 'The load is in a closed month. Draft it by hand if it still needs an invoice.' },
  MONTH_UNKNOWN: { short: "month can't be told", text: "The load's month can't be told from its dates. Check its dates, then draft it by hand." },
  NO_DELIVERY_DATE: { short: 'no delivery date', text: 'The load has no delivery date. Set it on Job Tracking, then Try again, or draft it by hand.' },
  ADVANCE_LINES: { short: 'advance lines', text: 'The load has advance lines. Draft it by hand so the balance due is checked.' },
  POD_UNREADABLE: { short: 'POD file missing', text: 'A POD on file has no readable file. Upload the POD again, then Try again.' },
  RECIPIENT_UNCONFIGURED: { short: 'no Bison inbox set', text: "Bison's invoice inbox is not set on the server. Draft it by hand." },
  OFF_GAP: { short: 'completed while off', text: 'The load was completed while automatic drafts were off. Draft it by hand.' },
  NO_BILLING_EMAIL: { short: 'no billing email', text: 'The rate con names no billing email for this broker. Draft it by hand and choose the recipient.' },
  RECIPIENT_DOMAIN_MISMATCH: { short: 'billing email on another domain', text: "The rate con's billing email is not on the broker's own domain. Draft it by hand and check the recipient." },
  RATECON_BY_CONTENT: { short: 'rate con found by content', text: 'The rate con was found only by reading Drive files. Draft it by hand and check it is the right one.' },
  TOTAL_MISMATCH: { short: 'totals differ', text: "The rate con's total differs from the Payment on Job Tracking. Draft it by hand." },
  POD_PAGE_UNREADABLE: { short: 'POD page unreadable', text: "A POD page couldn't be read. Upload the POD again, then Try again." },
  INVOICE_REFS_REQUIRED: { short: 'Bison Order # or PO # missing', text: "Bison's Order # or PO # couldn't be read. Draft it by hand and type them." },
  INVOICE_TOTAL_UNKNOWN: { short: 'total unknown', text: 'No invoice total could be found. Draft it by hand.' },
  TRAILER_MISMATCH: { short: 'trailer differs', text: "The rate con's trailer differs from Job Tracking. Draft it by hand." },
  DRAFT_REFUSED: { short: 'draft refused', text: 'The invoice draft was refused. Draft it by hand to see why.' },
  DRAFT_FAILED: { short: 'Gmail kept failing', text: 'Saving the draft to Gmail kept failing. Try again, or draft it by hand.' },
  MAYBE_IN_GMAIL: { short: 'may already be in Gmail', text: 'The draft may already be in Gmail. Try again looks for it there first; or check Gmail Drafts.' },
  IN_GMAIL_UNRECORDED: { short: 'in Gmail, not recorded', text: "The draft is in Gmail, but LogisX couldn't record it. Check Gmail Drafts before drafting again." },
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
  return `Changed since the draft: ${fields.map((f) => AUTO_INVOICE_CHANGED_WORDS[f]).join(', ')}. Check the draft in Gmail, then Mark checked.`
}

// The chip for a row's `_autoInvoice`: { label, tone, reason }, or null when
// there is nothing to show. Tones: ok, warn, bad, muted.
export function autoInvoiceChip(status) {
  if (!status || typeof status !== 'object') return null
  const reason = reasonOf(status.code)
  switch (status.state) {
    case 'drafted': {
      if (changedOf(status).length) return { label: 'Draft ready in Gmail: load changed', tone: 'warn', reason: changedText(status) }
      const id = typeof status.invoiceId === 'string' ? status.invoiceId : ''
      return { label: 'Draft ready in Gmail', tone: 'ok', reason: id ? `Invoice ${id} is in Gmail Drafts. Check it and send it.` : 'The invoice is in Gmail Drafts. Check it and send it.' }
    }
    case 'waiting':
      if (status.code === 'WAITING_POD') return { label: 'Waiting for POD', tone: 'muted', reason: reason.text }
      if (status.code === 'RATECON_MISSING') return { label: 'Waiting for the rate con', tone: 'muted', reason: reason.text }
      return { label: reason ? `Waiting: ${reason.short}` : 'Waiting', tone: 'muted', reason: reason ? reason.text : '' }
    case 'queued':
      return { label: 'Drafting soon', tone: 'muted', reason: reason ? reason.text : 'The draft will be made shortly.' }
    case 'working':
      return { label: 'Drafting now', tone: 'muted', reason: 'The draft is being made.' }
    case 'needs_attention':
      return { label: reason ? `Needs attention: ${reason.short}` : 'Needs attention', tone: 'bad', reason: reason ? reason.text : 'Draft it by hand.' }
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

export const canTryAgain = (status) => Boolean(status && status.state === 'needs_attention')
export const canMarkChecked = (status) => Boolean(status && status.state === 'drafted' && changedOf(status).length > 0)
