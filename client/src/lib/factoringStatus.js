// Factored loads (Triumph, per load): the words for what the server puts on a
// Super Admin's dashboard rows (lib/factoring-routes.js annotateDashboard()):
//   `_factoring`     { factored, locked, lockedVia, triumphState, canMark, canRecordOutside }
//   `_draftInflight` { state, invoiceId, path }: a Draft Invoice press whose Gmail
//                    draft is being saved, or may be in Gmail
// Display only, with no network: scripts/test-factoring-status-client.mjs pins it.

// The chip for a row's `_factoring`: { label, tone, reason }, or null when the
// load isn't factored. Tones as autoInvoiceStatus.js's: ok, warn, bad, muted.
// `draftMayBeOut`: an invoice may already be in Gmail, or sent from there, so the
// line doesn't say where the invoice goes.
export function factoringChip(f, { draftMayBeOut = false } = {}) {
  if (!f || typeof f !== 'object' || f.factored !== true) return null
  if (f.locked === true) {
    return {
      label: 'Factored (Triumph): final',
      tone: 'muted',
      reason: f.lockedVia === 'outside'
        ? "Handled in Triumph's process. The app never invoices this load."
        : 'Handed to Triumph. The app never invoices this load again.',
    }
  }
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
