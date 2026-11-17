// Factored loads (Triumph, per load): the words for what the server puts on a
// Super Admin's dashboard rows (lib/factoring-routes.js annotateDashboard()):
//   `_factoring`     { factored, locked, lockedVia, triumphState, canMark, canRecordOutside },
//                    and with Process with Triumph's switch on also { canProcess, canClear,
//                    canRetry, byButton, triumphCode, triumphStage, triumphAt,
//                    brokerInvoiceId, brokerInvoiceDate, paused }
//   `_draftInflight` { state, invoiceId, path }: a Draft Invoice press whose Gmail
//                    draft is being saved, or may be in Gmail
// Display only, with no network: scripts/test-factoring-status-client.mjs pins it.

import { isSharedLogin } from '../utils/sharedLogin.js'

// A day key ("2026-11-12") as the invoice prints it (11/12/2026); anything else as given.
const dayText = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''))
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(d || '')
}
// "Invoiced to the broker: N, D." for a load Process with Triumph took, or "".
const brokerInvoiceText = (f) => (f && f.brokerInvoiceId ? `Invoiced to the broker: ${f.brokerInvoiceId}${f.brokerInvoiceDate ? `, ${dayText(f.brokerInvoiceDate)}` : ''}.` : '')

// The chip for a row's `_factoring`: { label, tone, reason }, or null when the
// load isn't factored. Tones as autoInvoiceStatus.js's: ok, warn, bad, muted.
// `draftMayBeOut`: an invoice may already be in Gmail, or sent from there, so the
// line doesn't say where the invoice goes. A load Process with Triumph took was
// invoiced to the broker by the app, so its chip names that invoice instead.
export function factoringChip(f, { draftMayBeOut = false } = {}) {
  if (!f || typeof f !== 'object' || f.factored !== true) return null
  const invoiced = brokerInvoiceText(f)
  if (f.locked === true) {
    if (invoiced) {
      return {
        label: 'Factored (Triumph): final',
        tone: 'muted',
        reason: f.lockedVia === 'outside' ? `Handled in Triumph's process. ${invoiced}` : `Sent to Triumph. ${invoiced}`,
      }
    }
    return {
      label: 'Factored (Triumph): final',
      tone: 'muted',
      reason: f.lockedVia === 'outside'
        ? "Handled in Triumph's process. The app never invoices this load."
        : 'Handed to Triumph. The app never invoices this load again.',
    }
  }
  if (invoiced) return { label: 'Factored (Triumph)', tone: 'warn', reason: `${invoiced} Triumph gets the same invoice. The Draft Invoice button refuses it.` }
  return {
    label: 'Factored (Triumph)',
    tone: 'warn',
    reason: draftMayBeOut
      ? 'The app sends no invoice for it by email, and the Draft Invoice button refuses it.'
      : 'The invoice goes through Triumph, not by email. The Draft Invoice button refuses it.',
  }
}

// What a person is asked before a mark the server refused because an invoice draft exists, or
// may: "" for any other refusal.
const NOT_SENT_QUESTIONS = Object.freeze({
  INVOICE_ALREADY_DRAFTED: 'An invoice draft already exists for this load. Was it NOT sent to the broker? If you confirm, delete that draft in Gmail.',
  INVOICE_MAYBE_IN_GMAIL: 'An invoice draft for this load may be in Gmail, or may already have been sent from there. Was it NOT sent to the broker? If you confirm, delete any draft in Gmail.',
})
export const notSentQuestion = (code) => (typeof code === 'string' && Object.hasOwn(NOT_SENT_QUESTIONS, code) ? NOT_SENT_QUESTIONS[code] : '')

// May this account switch the load's factoring (the server says so: a listed
// account, marking on, the row not locked)?
export const canFactor = (f) => Boolean(f && typeof f === 'object' && f.canMark === true)
// May it record "Handled in Triumph's process" (a listed account, a factored
// load not yet locked)?
export const canRecordOutside = (f) => Boolean(f && typeof f === 'object' && f.canRecordOutside === true)
// "Factor with Triumph": the switch, on a load not yet factored.
export const canMarkFactored = (f) => canFactor(f) && f.factored !== true
// "Clear factored", a button of its own. The server says so with Process with Triumph's
// switch on (canClear); with it off the row carries no canClear, and the button shows where
// the one switch read "Clear factored" before: marking allowed on a factored row.
export const canClear = (f) => Boolean(f && typeof f === 'object'
  && (f.canClear === true || (f.canClear === undefined && f.canMark === true && f.factored === true)))
// The Process with Triumph button: the server's word alone.
export const canProcess = (f) => Boolean(f && typeof f === 'object' && f.canProcess === true)
// Try again on a stopped button claim: the server's word alone.
export const canRetryTriumph = (f) => Boolean(f && typeof f === 'object' && f.canRetry === true)

// The codes a Try again would only repeat (lib/factoring-store.js BUTTON_STOPS, pinned equal by
// scripts/test-factoring-status-client.mjs): the load stays with its invoice to the broker.
export const BUTTON_STOPS = Object.freeze(['ADVANCE_ON_RATECON', 'RATECON_UNREAD', 'DVIR_LINES', 'TOTAL_MISMATCH', 'INVOICE_CHANGED', 'PAID_ALREADY', 'INVOICE_TOO_OLD', 'NUMBER_VOIDED'])
const UPLOAD_STAGES = Object.freeze(['pdf_uploading', 'pdf_uploaded'])

// Why a button claim stopped, in words that follow "Not sent to Triumph: ".
const STOP_WORDS = Object.freeze({
  ADVANCE_ON_RATECON: "the rate con shows an advance, or the app couldn't rule one out",
  RATECON_UNREAD: "the app couldn't read the rate con well enough to rule out an advance",
  DVIR_LINES: 'the rate con shows a DVIR deduction, or was re-issued for less',
  TOTAL_MISMATCH: "the rate con's total and the load's Payment disagree",
  INVOICE_CHANGED: 'the invoice no longer matches the one the broker got',
  PAID_ALREADY: 'the Payments Table shows a payment date for this load',
  INVOICE_TOO_OLD: 'its invoice went to the broker more than 30 days ago',
  NUMBER_VOIDED: "its invoice number can't be used",
  SUBMIT_FAILED: 'the upload to Triumph kept failing',
  NOT_LIVE: "the app isn't sending to Triumph right now",
  DEBTOR_UNMAPPED: "no debtor name is set for this broker in Triumph's settings",
  NOA_UNCONFIGURED: "Triumph's assignment lines aren't set",
  DENY_LIST_UNSET: "the carrier deny list isn't set",
  SETTINGS_UNREADABLE: "Triumph's settings couldn't be read",
  PROTECTED_VALUE: 'a protected value was found on what would go',
  FIELD_NOT_PRINTED: "a value in Triumph's file isn't printed on the invoice",
  WAITING_POD: 'no POD is on file yet',
  POD_UNREADABLE: "a POD can't be read",
  DOCUMENT_MISSING: 'a document is missing',
  DOCUMENT_UNREADABLE: "a document can't be read",
  MERGE_FAILED: "the documents couldn't be put together",
  BATCH_TOO_LARGE: 'the documents are too large for Triumph',
  RATECON_MISSING: "the rate con wasn't found",
  CLOSED_MONTH: "the load's month is closed",
  MONTH_UNKNOWN: "the load's month can't be told",
  ALREADY_INVOICED: 'another invoice is on file for this load',
  INVOICE_DRAFT_IN_FLIGHT: 'an invoice draft for this load is being saved',
  INVOICE_MAYBE_DRAFTED: 'an invoice draft for this load may be in Gmail',
  NOT_FACTORED: 'its mark was cleared',
  FACTORING_LOCKED: 'its mark is final',
  FACTORING_CHANGED: 'its mark changed while it was being built',
  BATCH_FILES_CHANGED: 'its built files changed',
  LOAD_DROPPED: 'the load was cancelled or deleted',
  NOT_COMPLETED: "the load isn't marked delivered",
  NO_DELIVERY_DATE: 'the load has no delivery date',
  ADVANCE_LINES: 'its invoice has an advance line',
  NO_BROKER_EMAIL: 'the load has no broker email',
  BROKER_EMAIL_FREEMAIL: "the broker email is a personal address, not the broker's own",
  BROKER_DOMAIN_UNCONFIRMED: "the broker's email domain isn't confirmed yet",
  RATECON_TOTAL_UNREAD: "the app couldn't read the total on the rate con",
  RECIPIENT_DOMAIN_MISMATCH: "the invoice's recipient isn't at the broker's domain",
  STAGE_INVALID: 'the app found it at an unexpected step',
  LOCK_MISSING: "its mark wasn't locked for the upload",
})
export const triumphStopWords = (code) => (typeof code === 'string' && Object.hasOwn(STOP_WORDS, code) ? STOP_WORDS[code] : `the app stopped it (${code || 'no reason given'})`)

const PAUSE_WORDS = Object.freeze({
  LOGIN_REFUSED: "Triumph refused the app's sign-in",
  HOST_KEY_MISMATCH: "Triumph's server didn't show the key the app expects",
  MAYBE_SUBMITTED: 'a person checks one earlier submission first',
})
const pauseWords = (reason) => (Object.hasOwn(PAUSE_WORDS, reason) ? PAUSE_WORDS[reason] : 'sending to Triumph is paused')

// The tile line of a load Process with Triumph took: { text, tone, tryAgain }, or null for any
// other load. Read top down, the first row that matches. Clear factored is the factoring
// controls' own button (canClear); the words name it only where the server offers it.
// `formatTime(iso)` prints the submission's time on the business clock.
export function triumphTile(f, { formatTime = (iso) => String(iso || '') } = {}) {
  if (!f || typeof f !== 'object' || f.byButton !== true || !f.triumphState) return null
  const state = f.triumphState
  const code = typeof f.triumphCode === 'string' ? f.triumphCode : ''
  const clear = canClear(f)
  const retry = canRetryTriumph(f)
  if (f.factored !== true) return { text: 'Not sent to Triumph. It stays with its invoice to the broker.', tone: 'muted', tryAgain: false }
  if (state === 'queued' && f.paused) return { text: `Paused: ${pauseWords(f.paused)}. Its invoice to the broker stands.`, tone: 'warn', tryAgain: false }
  if (state === 'queued' || state === 'working') return { text: 'Sending to Triumph…', tone: 'muted', tryAgain: false }
  if (state === 'submitted') return { text: `Sent to Triumph · ${formatTime(f.triumphAt)}`, tone: 'ok', tryAgain: false }
  if (state === 'waiting') return { text: `Waiting: ${triumphStopWords(code)}.`, tone: 'warn', tryAgain: false }
  if (state === 'needs_attention') {
    if (code === 'MAYBE_SUBMITTED') return { text: "May have reached Triumph: a person checks Triumph's side.", tone: 'bad', tryAgain: false }
    if (BUTTON_STOPS.includes(code) && UPLOAD_STAGES.includes(f.triumphStage)) {
      return { text: "Its PDF may be on Triumph's server, but nothing was triggered there. The mark stays locked; a person checks Triumph's side.", tone: 'bad', tryAgain: false }
    }
    if (BUTTON_STOPS.includes(code)) {
      return { text: `Not sent to Triumph: ${triumphStopWords(code)}. It stays with its invoice to the broker${clear ? ': Clear factored puts it back there alone.' : '.'}`, tone: 'warn', tryAgain: false }
    }
    const ways = [retry ? 'Try again' : '', clear ? 'Clear factored to keep it with the broker' : ''].filter(Boolean)
    return { text: `Not sent to Triumph: ${triumphStopWords(code)}. Its invoice to the broker stands.${ways.length ? ` ${ways.join(', or ')}.` : ''}`, tone: 'warn', tryAgain: retry }
  }
  if (state === 'closed_outside') return { text: `Handled in Triumph's process. ${brokerInvoiceText(f) || 'Invoiced to the broker.'}`, tone: 'muted', tryAgain: false }
  if (state === 'skipped') return { text: `Not sent to Triumph: ${triumphStopWords(code)}. Its invoice to the broker stands.`, tone: 'muted', tryAgain: false }
  return { text: 'Not sent to Triumph. Its invoice to the broker stands.', tone: 'muted', tryAgain: false }
}

// What the tile says when a press didn't go through: { kind, tone, text }. Only a refusal the
// press made before writing anything says "Not sent to Triumph" ('refused'). A second press
// ('already': on its way, with Triumph, or its mark final) and an answer that never came or that
// the press didn't name ('unknown') may follow a write: neither says "not sent", and the tab
// reads the load again so its own line shows.
const PRESS_ALREADY = Object.freeze(['TRIUMPH_ALREADY', 'FACTORING_LOCKED'])
// The press's own 503s, each answered before any write.
const PRESS_NOTHING_WRITTEN_5XX = Object.freeze(['SUBMIT_PAUSED', 'TRANSPORT_UNCONFIGURED', 'FACTORING_UNREADABLE', 'RECORDS_UNREADABLE'])
export const PRESS_UNCONFIRMED = "The app couldn't confirm the send: it may be on its way to Triumph. Reload the load to see where it stands."
export function pressFailure(e) {
  const status = Number(e && e.status)
  const code = e && typeof e.code === 'string' ? e.code : ''
  const words = code && typeof e.message === 'string' ? e.message : ''
  if (words && status >= 400 && PRESS_ALREADY.includes(code)) return { kind: 'already', tone: 'muted', text: words }
  if (words && ((status >= 400 && status < 500) || (status >= 500 && PRESS_NOTHING_WRITTEN_5XX.includes(code)))) {
    return { kind: 'refused', tone: 'bad', text: `Not sent to Triumph. ${words}` }
  }
  return { kind: 'unknown', tone: 'warn', text: PRESS_UNCONFIRMED }
}

// The line for a row's `_draftInflight`: { text, canCheck, askPerson }, or null.
// A draft that may be in Gmail is checked with "Check Gmail": by a search for an
// IMAP draft, by a person's answer for the n8n path.
export function inflightLine(d) {
  if (!d || typeof d !== 'object') return null
  const id = typeof d.invoiceId === 'string' && d.invoiceId ? ` (invoice #${d.invoiceId})` : ''
  if (d.state === 'maybe_drafted') {
    return { text: `An invoice draft may be in Gmail${id}. Check Gmail before drafting again.`, canCheck: true, askPerson: d.path === 'n8n' }
  }
  if (d.state === 'in_flight') return { text: `An invoice draft${id} is being saved now.`, canCheck: false, askPerson: false }
  return null
}

// The approve's answer when Gmail (or the fallback) never answered: the draft
// may exist, so the modal must not say "Nothing was sent".
export const isMaybeSaved = (e) => Boolean(e && e.code === 'DRAFT_MAYBE_SAVED')

// A reason as the server keeps it: one line, at most 200 characters.
export function reasonInput(s) {
  return Array.from(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, 200).join('')
}

// The reason box's hint for the signed-in account. A row the shared login writes names the
// login, not a person, so on it the reason is where the person's name goes.
export const reasonHint = (username) => (isSharedLogin(username) ? 'Your name and why (required)' : 'Reason (required)')
