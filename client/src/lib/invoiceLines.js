// Advance lines on a broker invoice (B20) — the client's copy of the input
// rules.
//
// THE SERVER DECIDES. lib/broker-invoice-lines.js judges every line a Super
// Admin adds and every footnote a draft carries, computes the line haul, the
// advances and the balance due, and formats them. This file only lets a field
// say what is wrong before a request is sent, in the server's own words; it
// computes no figure the editor shows. scripts/test-invoice-lines-client.mjs
// pins it to the server: the same patterns, limits and sentences, and the same
// verdict on a shared case table. Change the rule in both files together.
//
// Pure: no network, no DOM, no Vue.

export const DEFAULT_ADVANCE_LABEL = 'Fuel advance'
export const LINE_LABEL_MAX = 80
export const LINE_REFERENCE_MAX = 40
export const LINE_NOTE_MAX = 500
export const FOOTNOTE_MAX = 500
export const VOID_REASON_MAX = 200

// The invoice Total's money shape, the Order # rule (80) and the PO # rule (40).
export const LINE_AMOUNT_RE = /^\$?\s*(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?$/
export const LINE_LABEL_RE = /^[\p{L}\p{N}][^\p{C}\p{Zl}\p{Zp}<>]{0,79}$/u
export const LINE_REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._\/#-]{0,39}$/
const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
// $1,000,000.00, the server's ceiling.
const AMOUNT_MAX_CENTS = 100000000
// A tab, line break or invisible character from a paste: the server would turn
// it into a space; the field refuses it so what is typed is what prints.
const HIDDEN_CHAR_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

export const LINE_MESSAGES = Object.freeze({
  BODY_INVALID: 'Send the line as a JSON object.',
  KIND_INVALID: 'Only advance lines can be added.',
  LABEL_INVALID: 'The label must be 1–80 characters, start with a letter or number, and contain no line breaks, control characters, < or >.',
  AMOUNT_INVALID: 'Enter the advance amount, e.g. 650 or 650.00.',
  AMOUNT_OUT_OF_RANGE: 'The amount must be between $0.01 and $1,000,000.00.',
  DATE_INVALID: 'The received date must be a real date in YYYY-MM-DD form.',
  REFERENCE_INVALID: 'The reference must start with a letter or number and use only letters, numbers, spaces or . _ / # - (40 at most).',
  NOTE_INVALID: 'The note must be text.',
  NOTE_TOO_LONG: 'The note must be 500 characters or fewer.',
  FOOTNOTE_INVALID: 'The footnote must be text.',
  FOOTNOTE_TOO_LONG: 'The footnote must be 500 characters or fewer.',
  VOID_REASON_REQUIRED: 'Say why the line is voided.',
  VOID_REASON_INVALID: 'The reason must be text.',
  VOID_REASON_TOO_LONG: 'The reason must be 200 characters or fewer.',
  IDS_INVALID: 'lineIds must be a list of at most 20 line numbers.',
})

const text = (v) => (v == null ? '' : String(v))

// '' when the label is acceptable (blank means the default label), else the
// server's sentence.
export function lineLabelError(value) {
  const v = text(value).trim()
  if (!v) return ''
  const n = v.normalize('NFC')
  if (HIDDEN_CHAR_RE.test(n) || !LINE_LABEL_RE.test(n)) return LINE_MESSAGES.LABEL_INVALID
  return ''
}

// The amount's verdict: the shape first, then the range, read as text (the
// whole dollars and the cents), never as a float. Validation only: the editor
// never shows a figure it computed.
export function lineAmountError(value) {
  const v = text(value).trim()
  if (!LINE_AMOUNT_RE.test(v)) return LINE_MESSAGES.AMOUNT_INVALID
  const [whole, frac = ''] = v.replace(/[$,\s]/g, '').split('.')
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2))
  if (!(cents >= 1 && cents <= AMOUNT_MAX_CENTS)) return LINE_MESSAGES.AMOUNT_OUT_OF_RANGE
  return ''
}

// A received date is optional; when given, a real day from 2000 to 2100.
export function lineDateError(value) {
  const v = text(value).trim()
  if (!v) return ''
  const m = ISO_DAY_RE.exec(v)
  if (!m) return LINE_MESSAGES.DATE_INVALID
  const y = +m[1]
  const mo = +m[2]
  const d = +m[3]
  if (!(y >= 2000 && y <= 2100) || !(mo >= 1 && mo <= 12) || !(d >= 1)) return LINE_MESSAGES.DATE_INVALID
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ? '' : LINE_MESSAGES.DATE_INVALID
}

export function lineReferenceError(value) {
  const v = text(value).trim()
  if (!v) return ''
  return LINE_REFERENCE_RE.test(v) ? '' : LINE_MESSAGES.REFERENCE_INVALID
}

// Lengths on the NFC form in UTF-16 units: never smaller than the server's
// codepoint count after its clean-up, so a value accepted here is accepted
// there.
const longerThan = (value, max) => text(value).normalize('NFC').trim().length > max

export function lineNoteError(value) {
  return longerThan(value, LINE_NOTE_MAX) ? LINE_MESSAGES.NOTE_TOO_LONG : ''
}

export function footnoteError(value) {
  return longerThan(value, FOOTNOTE_MAX) ? LINE_MESSAGES.FOOTNOTE_TOO_LONG : ''
}

export function voidReasonError(value) {
  const v = text(value).trim()
  if (!v) return LINE_MESSAGES.VOID_REASON_REQUIRED
  return v.normalize('NFC').length > VOID_REASON_MAX ? LINE_MESSAGES.VOID_REASON_TOO_LONG : ''
}

// { field: sentence } for every field of the add form that is wrong; {} when
// the line can be sent.
export function newLineErrors(form) {
  const f = form || {}
  const out = {}
  const checks = [
    ['label', lineLabelError(f.label)],
    ['amount', lineAmountError(f.amount)],
    ['receivedOn', lineDateError(f.receivedOn)],
    ['reference', lineReferenceError(f.reference)],
    ['note', lineNoteError(f.note)],
  ]
  for (const [field, error] of checks) if (error) out[field] = error
  return out
}

// The footnote the server writes for these lines (defaultFootnote() in
// lib/broker-invoice-lines.js), shown in the box the moment a line is ticked,
// before the preview answers with the server's own. Text only: each line's
// amount is the server's formatted string ("$650.00"), shortened to "$650" for
// whole dollars; the label reads mid-sentence ("Fuel advance" -> "fuel
// advance", an acronym kept). One line per advance, in the order given.
export function footnoteDefaultFor(lines) {
  return (Array.isArray(lines) ? lines : []).map((l) => {
    const amount = text(l && l.amount).replace(/\.00$/, '')
    const label = text(l && l.label)
    const mid = /^\p{Lu}\p{Ll}/u.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label
    return `*${amount} for ${mid}`
  }).join('\n')
}

// The body POST /api/loads/:loadId/invoice-lines receives: raw text (the
// server cleans and judges it again), an advance, the default label when the
// label is blank.
export function newLineBody(form) {
  const f = form || {}
  return {
    kind: 'advance',
    label: text(f.label).trim() || DEFAULT_ADVANCE_LABEL,
    amount: text(f.amount).trim(),
    receivedOn: text(f.receivedOn).trim(),
    reference: text(f.reference).trim(),
    note: text(f.note),
  }
}
