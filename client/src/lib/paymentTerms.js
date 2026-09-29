// Per-investor payment terms: the client's copy of the input rules in
// lib/investor-payment-terms.js, so the admin hears about a bad amount or an
// over-long amendment in the form rather than from the server's 400.
//
// THE SERVER DECIDES. This file only mirrors it: LIMITS, normalizeTermsInput,
// parseLeaseAmountToCents, formatMoneyCents and describeTerms.
//
// Pure: no network, no DOM, no Vue. Every special character is matched through
// a \p{…} class; none is typed literally.

export const LIMITS = Object.freeze({
  LEASE_MIN_CENTS: 100,
  LEASE_MAX_CENTS: 10000000,
  DETAILS_MAX: 2000,
  DETAILS_MAX_LINES: 30,
  DETAILS_RAW_MAX: 8000,
  NAME_MAX: 120,
  AMOUNT_RAW_MAX: 16,
})

const PAYMENT_TYPES = ['split', 'lease']

const TYPE_LABELS = {
  split: '50/50 profit split',
  lease: 'Fixed monthly lease payment',
}

// Linear: one bounded run of digits, then an optional bounded fraction.
const AMOUNT_RE = /^\d{1,9}(?:\.\d{1,2})?$/
const LINE_SEPARATOR_RE = /[\p{Zl}\p{Zp}]/gu
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u
const OTHER_SCRIPT_RE = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u
const LF = '\n'

export function formatMoneyCents(cents) {
  if (!Number.isSafeInteger(cents)) return ''
  const abs = Math.abs(cents)
  const whole = String(Math.floor(abs / 100))
  const fraction = String(abs % 100).padStart(2, '0')
  const groups = []
  for (let end = whole.length; end > 0; end -= 3) groups.unshift(whole.slice(Math.max(0, end - 3), end))
  return `${cents < 0 ? '-' : ''}$${groups.join(',')}.${fraction}`
}

const MESSAGES = {
  invalid_payment_type: 'Choose a payment type.',
  amount_required: 'Enter the monthly lease amount.',
  invalid_amount: 'Enter the amount in dollars and cents, like 2000 or 2000.50, with no commas.',
  amount_out_of_range: `The monthly amount must be between ${formatMoneyCents(LIMITS.LEASE_MIN_CENTS)} and ${formatMoneyCents(LIMITS.LEASE_MAX_CENTS)}.`,
  amount_not_allowed: 'A 50/50 profit split takes no monthly amount.',
  invalid_details: 'Additional terms must be text.',
  details_too_long: `Additional terms can be at most ${LIMITS.DETAILS_MAX.toLocaleString('en-US')} characters.`,
  details_too_many_lines: `Additional terms can be at most ${LIMITS.DETAILS_MAX_LINES} lines.`,
  unsupported_characters: 'Additional terms can use Latin letters, numbers and punctuation only, with no emoji.',
}

function refusal(field, reason) {
  return { ok: false, field, reason, message: MESSAGES[reason] }
}

// { ok: true, cents } or { ok: false, reason }. A number, or a string that
// after trimming and at most one leading "$" is whole dollars with up to two
// decimals. The cents come from the digits, never from float arithmetic.
export function parseLeaseAmountToCents(input) {
  if (input === undefined || input === null) return { ok: false, reason: 'amount_required' }
  let text
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, reason: 'invalid_amount' }
    text = String(input)
  } else if (typeof input === 'string') {
    if (input.length > LIMITS.AMOUNT_RAW_MAX) return { ok: false, reason: 'invalid_amount' }
    text = input.trim()
    if (text.startsWith('$')) text = text.slice(1)
  } else {
    return { ok: false, reason: 'invalid_amount' }
  }
  if (text === '') return { ok: false, reason: 'amount_required' }
  if (!AMOUNT_RE.test(text)) return { ok: false, reason: 'invalid_amount' }
  const [whole, fraction = ''] = text.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (cents < LIMITS.LEASE_MIN_CENTS || cents > LIMITS.LEASE_MAX_CENTS) {
    return { ok: false, reason: 'amount_out_of_range' }
  }
  return { ok: true, cents }
}

// { ok: true, value } or { ok: false, reason }. The same steps, in the same
// order, as the server's normalizeDetails.
function normalizeDetailsText(raw) {
  const input = raw === undefined || raw === null ? '' : raw
  if (typeof input !== 'string') return { ok: false, reason: 'invalid_details' }
  if (input.length > LIMITS.DETAILS_RAW_MAX) return { ok: false, reason: 'details_too_long' }

  const flat = input
    .replace(/\r\n?/g, LF)
    .replace(LINE_SEPARATOR_RE, LF)
    .replace(/\t/g, ' ')
    .replace(INVISIBLE_RE, (ch) => (ch === LF ? ch : ''))
    .normalize('NFC')

  // Line ends are trimmed line by line, and a run of blank lines keeps one.
  const lines = []
  for (const line of flat.split(LF)) {
    const trimmed = line.trimEnd()
    if (trimmed === '' && lines.length && lines[lines.length - 1] === '') continue
    lines.push(trimmed)
  }
  const value = lines.join(LF).trim()

  if (value.length > LIMITS.DETAILS_MAX) return { ok: false, reason: 'details_too_long' }
  if (value && value.split(LF).length > LIMITS.DETAILS_MAX_LINES) {
    return { ok: false, reason: 'details_too_many_lines' }
  }
  if (PICTOGRAPHIC_RE.test(value) || OTHER_SCRIPT_RE.test(value)) {
    return { ok: false, reason: 'unsupported_characters' }
  }
  return { ok: true, value }
}

// { ok: true, value: { type, leaseAmountCents, details } }
// or { ok: false, field, reason, message }.
export function normalizeTermsInput({ paymentType, leaseAmount, details } = {}) {
  if (!PAYMENT_TYPES.includes(paymentType)) return refusal('paymentType', 'invalid_payment_type')

  let leaseAmountCents = null
  if (paymentType === 'lease') {
    const amount = parseLeaseAmountToCents(leaseAmount)
    if (!amount.ok) return refusal('leaseAmount', amount.reason)
    leaseAmountCents = amount.cents
  } else if (leaseAmount !== undefined && leaseAmount !== null && leaseAmount !== '') {
    return refusal('leaseAmount', 'amount_not_allowed')
  }

  const normalized = normalizeDetailsText(details)
  if (!normalized.ok) return refusal('details', normalized.reason)

  return { ok: true, value: { type: paymentType, leaseAmountCents, details: normalized.value } }
}

// { typeLabel, amountLabel, summary } for a terms value, or for null (the
// standard contract).
export function describeTerms(terms) {
  if (!terms) return { typeLabel: TYPE_LABELS.split, amountLabel: '', summary: 'Standard 50/50' }
  if (terms.type === 'lease') {
    const amountLabel = formatMoneyCents(terms.leaseAmountCents)
    return { typeLabel: TYPE_LABELS.lease, amountLabel, summary: `Lease ${amountLabel}/mo` }
  }
  return {
    typeLabel: TYPE_LABELS.split,
    amountLabel: '',
    summary: terms.details ? '50/50 with additional terms' : 'Standard 50/50',
  }
}
