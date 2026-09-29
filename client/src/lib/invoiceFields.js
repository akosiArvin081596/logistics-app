// The invoice draft editor's Order # rule and Notes limit — the client's copy.
//
// THE SERVER DECIDES. parseInvoiceOverrides() in server.js judges every body
// sent to POST /api/loads/:loadId/draft-invoice and /invoice-preview, and this
// file mirrors its Order # pattern (INVOICE_ORDER_RE) and its Notes ceiling.
// It is a courtesy, not the guard: it lets the field say WHY a value is wrong
// before a Chromium render is spent on a body the server would refuse.
//
// scripts/test-invoice-fields-client.mjs pins the parity — same pattern source
// and flags as server.js, and the same verdict on a shared case table. Change
// the rule in both files together.
//
// PO # is NOT governed here: it keeps its original, narrower rule (REF_RE in
// InvoiceDraftPreviewModal.vue, INVOICE_REF_RE on the server).
//
// Pure: no network, no DOM, no Vue.

// Must start with a letter or number; after that any printable character,
// spaces and $ , ( ) : + & ' @ % included — 80 in all. \p{C} refuses control,
// zero-width and bidi characters, \p{Zl}/\p{Zp} the Unicode line breaks, and
// < > stay refused. Anchored, one bounded class: linear on any input.
export const ORDER_NUMBER_RE = /^[\p{L}\p{N}][^\p{C}\p{Zl}\p{Zp}<>]{0,79}$/u
export const ORDER_NUMBER_MAX = 80
export const ORDER_NUMBER_HINT = 'Must start with a letter or number — any characters except < and >, 80 max.'

// '' when the Order # is acceptable, otherwise the sentence to show under the
// field. Trimmed first, as the modal trims what it sends.
export function orderNumberError(value) {
  const v = value == null ? '' : String(value).trim()
  // Not merely required for the printed line: it also names the invoice
  // attachment, so an empty one produces a file literally called ".pdf".
  if (!v) return 'An order number is required — it names the invoice attachment.'
  return ORDER_NUMBER_RE.test(v) ? '' : ORDER_NUMBER_HINT
}

// The server counts characters (code points) after its own clean-up; this
// counts UTF-16 units, which is never fewer, so a note this accepts the server
// accepts too. The textarea's maxlength counts UTF-16 units as well.
export const NOTES_MAX = 500

export function notesError(value) {
  const v = value == null ? '' : String(value)
  return v.length > NOTES_MAX ? `Notes must be ${NOTES_MAX} characters or fewer.` : ''
}
