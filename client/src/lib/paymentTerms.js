// Payment terms for an investor invitation — the client copy of the rules in
// lib/investor-payment-terms.js, so the invite form refuses exactly what the
// server refuses and names the same field with the same message, and the
// portal and the admin screens describe terms in the same words.
//
// Pure: no Vue, no DOM, so it runs under plain Node. The server stays the
// authority; this copy only answers first. scripts/test-payment-terms-parity.mjs
// runs both over one table of inputs and fails on any difference, in LIMITS,
// the labels, the messages or a single answer.
//
// Contract wording only: these terms change what the agreements say, never
// how a payout is computed (payouts come from the investor's Split %).

export const PAYMENT_TYPES = Object.freeze(['split', 'lease'])

export const LIMITS = Object.freeze({
  LEASE_MIN_CENTS: 100,
  LEASE_MAX_CENTS: 10000000,
  DETAILS_MAX: 2000,
  DETAILS_MAX_LINES: 30,
  DETAILS_RAW_MAX: 8000,
  NAME_MAX: 120,
  AMOUNT_RAW_MAX: 16,
})

export const TYPE_LABELS = Object.freeze({
  split: '50/50 profit split',
  lease: 'Fixed monthly lease payment',
})

export const STANDARD_SUMMARY = '50/50 profit split — standard contract terms'

export const MESSAGES = Object.freeze({
  invalid_type: 'Choose a payment type: a 50/50 profit split or a fixed monthly lease payment.',
  amount_required: 'Enter the monthly lease amount.',
  invalid_amount: 'Enter the monthly lease amount in dollars and cents, for example 2000 or 2000.50.',
  amount_out_of_range: 'The monthly lease amount must be between $1.00 and $100,000.00.',
  amount_not_allowed: 'A 50/50 profit split has no monthly amount.',
  details_not_text: 'Additional terms must be text.',
  details_too_long: `Additional terms can be at most ${LIMITS.DETAILS_MAX} characters.`,
  details_too_many_lines: `Additional terms can be at most ${LIMITS.DETAILS_MAX_LINES} lines.`,
  unsupported_characters: 'Additional terms can use Latin letters, numbers, punctuation and symbols only (no emoji or other scripts).',
})

const AMOUNT_RE = /^\d{1,9}(?:\.\d{1,2})?$/
const LINE_SEPARATORS_RE = /[\p{Zl}\p{Zp}]/gu
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u
const OTHER_SCRIPT_RE = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u
// The copyright, registered and trade mark signs are Extended_Pictographic, but
// in running text they are ordinary symbols, so these three (and no other) are
// set aside before the emoji test. Followed by U+FE0F they ask for the emoji,
// which EMOJI_PARTS_RE below refuses. Built from code points.
const TEXT_SYMBOLS_RE = new RegExp(`[${String.fromCodePoint(0xa9, 0xae, 0x2122)}]`, 'gu')
// The pieces emoji are assembled from that are not themselves Extended_Pictographic:
// regional indicators (flags), skin-tone modifiers, the combining keycap and the
// emoji presentation selector. Built from code points.
const EMOJI_PARTS_RE = new RegExp(`[\\p{Regional_Indicator}\\p{Emoji_Modifier}${String.fromCodePoint(0x20e3, 0xfe0f)}]`, 'u')

const isBlank = (v) => v === undefined || v === null || v === ''

// Dollars → whole cents, from the digits (never floating point). A number, or
// text that after trim and at most one leading "$" is up to 9 digits with at
// most two decimals; the length is checked before the pattern runs.
export function parseLeaseAmountToCents(value) {
  if (isBlank(value)) return { ok: false, reason: 'amount_required' }
  let text
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, reason: 'invalid_amount' }
    text = String(value)
  } else if (typeof value === 'string') {
    text = value
  } else {
    return { ok: false, reason: 'invalid_amount' }
  }
  if (text.length > LIMITS.AMOUNT_RAW_MAX) return { ok: false, reason: 'invalid_amount' }
  text = text.trim()
  if (text === '') return { ok: false, reason: 'amount_required' }
  if (text[0] === '$') text = text.slice(1)
  if (!AMOUNT_RE.test(text)) return { ok: false, reason: 'invalid_amount' }
  const [whole, frac = ''] = text.split('.')
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  if (cents < LIMITS.LEASE_MIN_CENTS || cents > LIMITS.LEASE_MAX_CENTS) return { ok: false, reason: 'amount_out_of_range' }
  return { ok: true, value: cents }
}

// The additional terms as the server stores them: line breaks to LF, tabs to a
// space, invisible code points dropped (LF kept), NFC, line ends trimmed, at
// most one blank line in a row, the whole trimmed. Emoji and other scripts are
// refused; the copyright, registered and trade mark signs are not.
export function normalizeDetails(value) {
  if (value === undefined || value === null) return { ok: true, value: '' }
  if (typeof value !== 'string') return { ok: false, reason: 'details_not_text' }
  if (value.length > LIMITS.DETAILS_RAW_MAX) return { ok: false, reason: 'details_too_long' }
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(LINE_SEPARATORS_RE, '\n')
    .replace(/\t/g, ' ')
    .replace(INVISIBLE_RE, (c) => (c === '\n' ? c : ''))
    .normalize('NFC')
  const kept = []
  for (const line of cleaned.split('\n')) {
    const trimmed = line.trimEnd()
    if (trimmed === '' && kept.length && kept[kept.length - 1] === '') continue
    kept.push(trimmed)
  }
  const text = kept.join('\n').trim()
  if (text.length > LIMITS.DETAILS_MAX) return { ok: false, reason: 'details_too_long' }
  if (text && text.split('\n').length > LIMITS.DETAILS_MAX_LINES) return { ok: false, reason: 'details_too_many_lines' }
  if (PICTOGRAPHIC_RE.test(text.replace(TEXT_SYMBOLS_RE, '')) || EMOJI_PARTS_RE.test(text) || OTHER_SCRIPT_RE.test(text)) return { ok: false, reason: 'unsupported_characters' }
  return { ok: true, value: text }
}

function termsRefusal(field, reason) {
  return { ok: false, field, reason, message: MESSAGES[reason] }
}

// The invite form's three fields → the terms the server will store, or the
// first refusal ({ field, reason, message }).
export function normalizeTermsInput({ paymentType, leaseAmount, details } = {}) {
  if (!PAYMENT_TYPES.includes(paymentType)) return termsRefusal('paymentType', 'invalid_type')
  let leaseAmountCents = null
  if (paymentType === 'lease') {
    const amount = parseLeaseAmountToCents(leaseAmount)
    if (!amount.ok) return termsRefusal('leaseAmount', amount.reason)
    leaseAmountCents = amount.value
  } else if (!isBlank(leaseAmount)) {
    return termsRefusal('leaseAmount', 'amount_not_allowed')
  }
  const d = normalizeDetails(details)
  if (!d.ok) return termsRefusal('details', d.reason)
  return { ok: true, value: { type: paymentType, leaseAmountCents, details: d.value } }
}

// "$2,000.00", grouped by hand so no locale can change it. "" for anything
// that is not a whole, non-negative number of cents.
export function formatMoneyCents(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) return ''
  const digits = String(Math.floor(cents / 100))
  let grouped = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ','
    grouped += digits[i]
  }
  return `$${grouped}.${String(cents % 100).padStart(2, '0')}`
}

// A split with no additional terms is the standard contract (null).
function effectiveTerms(terms) {
  if (!terms || !PAYMENT_TYPES.includes(terms.type)) return null
  const details = typeof terms.details === 'string' ? terms.details : ''
  if (terms.type === 'split' && !details) return null
  return { type: terms.type, leaseAmountCents: terms.type === 'lease' ? terms.leaseAmountCents : null, details }
}

// { typeLabel, amountLabel, summary } — the same words the server uses in the
// invite list, the application list and the admin email.
export function describeTerms(terms) {
  const t = effectiveTerms(terms)
  if (!t) return { typeLabel: TYPE_LABELS.split, amountLabel: '', summary: STANDARD_SUMMARY }
  const amountLabel = t.type === 'lease' ? `${formatMoneyCents(t.leaseAmountCents)} per month` : ''
  const parts = [TYPE_LABELS[t.type]]
  if (amountLabel) parts.push(amountLabel)
  if (t.details) parts.push('with additional terms')
  return { typeLabel: TYPE_LABELS[t.type], amountLabel, summary: parts.join(' — ') }
}
