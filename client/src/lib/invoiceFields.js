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

// The characters a paste brings in that nobody can see in the field: a tab or
// line break from a spreadsheet cell (Cc), a soft hyphen or zero-width
// character (Cf), and the Unicode line and paragraph separators. The pattern
// refuses every one, and without this the field would show the generic hint
// over a value that looks perfectly fine. One class, no quantifier: linear.
const HIDDEN_CHAR_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
export const ORDER_NUMBER_HIDDEN_CHAR =
  "Remove the hidden character (a tab or line break from a paste) — it can't print on the invoice."

// '' when the Order # is acceptable, otherwise the sentence to show under the
// field. Trimmed first, as the modal trims what it sends.
//
// NFC-normalized before it is judged, because the server normalizes first too
// (sanitizeEvidenceText). Without it the two can count the same value
// differently: an accent typed as a letter plus a combining mark is two
// characters here and one there, and a few characters (U+0958, for one) grow
// to two under NFC — so the editor could pass a value the server then refuses
// as over 80. Only the verdict uses the normalized form; the modal still sends
// what was typed, and the server normalizes it on arrival.
export function orderNumberError(value) {
  const v = value == null ? '' : String(value).trim()
  // Not merely required for the printed line: it also names the invoice
  // attachment, so an empty one produces a file literally called ".pdf".
  if (!v) return 'An order number is required — it names the invoice attachment.'
  const n = v.normalize('NFC')
  if (HIDDEN_CHAR_RE.test(n)) return ORDER_NUMBER_HIDDEN_CHAR
  return ORDER_NUMBER_RE.test(n) ? '' : ORDER_NUMBER_HINT
}

// The length the Notes limit is judged on: UTF-16 units of the NFC form.
//
// The server counts code points after NFC and its own clean-up (control and
// zero-width runs become ONE space, CRLF becomes LF, the ends are trimmed), and
// none of those steps lengthens the text. So this count is never smaller than
// the server's — a note this accepts, the server accepts too. Counting the RAW
// text would not hold that: a character NFC expands (U+0958 becomes two) would
// be one here and two there. A character outside the BMP (an emoji) counts
// twice here and once on the server, which only ever makes this stricter; the
// textarea's maxlength counts UTF-16 units of the raw text as well.
export const NOTES_MAX = 500

export function notesLength(value) {
  return (value == null ? '' : String(value)).normalize('NFC').length
}

export function notesError(value) {
  return notesLength(value) > NOTES_MAX ? `Notes must be ${NOTES_MAX} characters or fewer.` : ''
}
