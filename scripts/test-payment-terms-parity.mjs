#!/usr/bin/env node
// The invite form's payment terms rules are the server's own.
//
// client/src/lib/paymentTerms.js refuses a lease amount or additional terms in
// the admin invite form before the save is sent, and describes terms in the
// portal and the admin screens; lib/investor-payment-terms.js refuses them
// again at the boundary and describes them in the lists, the admin email and
// the contracts. Two copies of one rule drift, and each direction costs
// something: a form that allows what the server refuses fails after the admin
// has finished typing; a form that refuses what the server allows blocks a
// legitimate invitation; a label that differs shows the investor one wording
// and the admin another.
//
// This runs both over one table of inputs (bidi, zero-width, line-separator,
// NUL, emoji and copyright / registered / trade mark inputs built with
// String.fromCodePoint) and compares every answer, field, reason and message,
// plus LIMITS, PAYMENT_TYPES, TYPE_LABELS, MESSAGES, STANDARD_SUMMARY,
// formatMoneyCents and describeTerms. A lease amount is whole dollars (a lease
// is paid in whole dollars), refused with one agreed message when it has
// cents. The sabotage controls prove the comparison can fail: copies of the
// client module with one limit, one pattern, one dropped character class, one
// change to the three allowed signs or the cents allowed again must each be
// reported.
//
// No network, no DB, no server — safe anywhere.
//   node scripts/test-payment-terms-parity.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const lib = require(path.join(__dirname, '..', 'lib', 'investor-payment-terms.js'))
const CLIENT_PATH = path.join(__dirname, '..', 'client', 'src', 'lib', 'paymentTerms.js')
const CLIENT_SRC = fs.readFileSync(CLIENT_PATH, 'utf8')
const client = await import(pathToFileURL(CLIENT_PATH).href)

let pass = 0
let fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.error(`FAIL  ${label}`) }
}

const cp = (...codes) => String.fromCodePoint(...codes)
const RLO = cp(0x202e)
const ZWSP = cp(0x200b)
const LSEP = cp(0x2028)
const PSEP = cp(0x2029)
const NUL = cp(0x0000)
const EMOJI = cp(0x1f600)
const SIGNS = cp(0x00a9, 0x00ae, 0x2122)
const EMOJI_PRESENTATION = cp(0xfe0f)

// One table for every function compared below.
const TERMS_INPUTS = [
  { paymentType: 'lease', leaseAmount: '2000' },
  { paymentType: 'lease', leaseAmount: ' $2000.5 ' },
  { paymentType: 'lease', leaseAmount: 1234.56 },
  { paymentType: 'lease', leaseAmount: '1' },
  { paymentType: 'lease', leaseAmount: '100000' },
  { paymentType: 'lease', leaseAmount: '100000.01' },
  { paymentType: 'lease', leaseAmount: '0.99' },
  { paymentType: 'lease', leaseAmount: '2,000' },
  { paymentType: 'lease', leaseAmount: '0x10' },
  { paymentType: 'lease', leaseAmount: '1e3' },
  { paymentType: 'lease', leaseAmount: '-5' },
  { paymentType: 'lease', leaseAmount: 'Infinity' },
  { paymentType: 'lease', leaseAmount: Infinity },
  { paymentType: 'lease', leaseAmount: NaN },
  { paymentType: 'lease', leaseAmount: '2000.123' },
  { paymentType: 'lease', leaseAmount: '2000.000' },
  { paymentType: 'lease', leaseAmount: '2000.00' },
  { paymentType: 'lease', leaseAmount: '2000.0' },
  { paymentType: 'lease', leaseAmount: '2000.50' },
  { paymentType: 'lease', leaseAmount: '2000.01' },
  { paymentType: 'lease', leaseAmount: 2000.5 },
  { paymentType: 'lease', leaseAmount: 2000 },
  { paymentType: 'lease', leaseAmount: '$1' },
  { paymentType: 'lease', leaseAmount: '0.50' },
  { paymentType: 'lease', leaseAmount: '100000.00' },
  { paymentType: 'lease', leaseAmount: '100001' },
  { paymentType: 'lease', leaseAmount: '$$5' },
  { paymentType: 'lease', leaseAmount: '0000000000002000.' },
  { paymentType: 'lease', leaseAmount: ['2000'] },
  { paymentType: 'lease' },
  { paymentType: 'lease', leaseAmount: '   ' },
  { paymentType: 'split', leaseAmount: '' },
  { paymentType: 'split', leaseAmount: '5' },
  { paymentType: 'Split' },
  {},
  { paymentType: 'split', details: `${RLO}Net ${ZWSP}30${NUL} days` },
  { paymentType: 'split', details: `Line one${LSEP}Line two${PSEP}Line three` },
  { paymentType: 'split', details: '  \r\n A\tB   \r\rC\r\n\r\n\r\n\n  D  \n\n' },
  { paymentType: 'split', details: `Caf${cp(0x65, 0x301)}` },
  { paymentType: 'split', details: `A${String.fromCharCode(0xd800)}B${cp(0xe000)}C` },
  { paymentType: 'split', details: `Great ${EMOJI}` },
  { paymentType: 'split', details: `Call 1${cp(0xfe0f, 0x20e3)} now` },
  { paymentType: 'split', details: `Based in ${cp(0x1f1fa, 0x1f1f8)}` },
  { paymentType: 'split', details: `ok ${cp(0x1f3fd)}` },
  { paymentType: 'split', details: `Acme${cp(0x2122)} ${cp(0xa9)}2026 ${cp(0xae)}` },
  { paymentType: 'split', details: `${SIGNS} ${EMOJI}` },
  { paymentType: 'split', details: `${cp(0xa9)}${EMOJI_PRESENTATION} 2026` },
  { paymentType: 'split', details: `Acme${cp(0x2122)}${EMOJI_PRESENTATION}` },
  { paymentType: 'split', details: `See ${cp(0x2139)}` },
  { paymentType: 'split', details: `P${cp(0x430)}yment` },
  { paymentType: 'split', details: 42 },
  { paymentType: 'split', details: 'x'.repeat(2000) },
  { paymentType: 'split', details: 'x'.repeat(2001) },
  { paymentType: 'split', details: ' '.repeat(8001) },
  { paymentType: 'split', details: Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') },
  { paymentType: 'split', details: Array.from({ length: 31 }, (_, i) => `l${i}`).join('\n') },
  { paymentType: 'lease', leaseAmount: '1500', details: '5% of $1,000 — per § 3.3 (naïve)' },
]
const AMOUNT_INPUTS = TERMS_INPUTS.filter((t) => 'leaseAmount' in t).map((t) => t.leaseAmount).concat([undefined, null, '', 0, 1e21, '$1.00', '99999.99'])
const CENTS = [0, 5, 100, 99999, 100000, 200000, 123456789, 10000000, 99999999999, -1, 1.5, '100', null]
const TERMS = [
  null,
  { type: 'split', leaseAmountCents: null, details: '' },
  { type: 'split', leaseAmountCents: null, details: 'Reviewed after 12 months.' },
  { type: 'lease', leaseAmountCents: 200000, details: '' },
  { type: 'lease', leaseAmountCents: 123456, details: 'Paid on the 5th.' },
]

const j = (v) => JSON.stringify(v)
// Every difference between a client module and the lib, one sentence each.
function differences(c) {
  const out = []
  const same = (label, a, b) => { if (j(a) !== j(b)) out.push(`${label}: client ${j(a)}, server ${j(b)}`) }
  same('LIMITS', c.LIMITS, lib.LIMITS)
  same('PAYMENT_TYPES', c.PAYMENT_TYPES, lib.PAYMENT_TYPES)
  same('TYPE_LABELS', c.TYPE_LABELS, lib.TYPE_LABELS)
  same('MESSAGES', c.MESSAGES, lib.MESSAGES)
  same('STANDARD_SUMMARY', c.STANDARD_SUMMARY, lib.STANDARD_SUMMARY)
  for (const input of TERMS_INPUTS) same(`normalizeTermsInput(${j(input).slice(0, 70)})`, c.normalizeTermsInput(input), lib.normalizeTermsInput(input))
  for (const v of AMOUNT_INPUTS) same(`parseLeaseAmountToCents(${j(v)})`, c.parseLeaseAmountToCents(v), lib.parseLeaseAmountToCents(v))
  for (const v of CENTS) same(`formatMoneyCents(${j(v)})`, c.formatMoneyCents(v), lib.formatMoneyCents(v))
  for (const t of TERMS) same(`describeTerms(${j(t)})`, c.describeTerms(t), lib.describeTerms(t))
  return out
}

// ══ The real pair ═════════════════════════════════════════════════════════════
const real = differences(client)
ok(`the client mirror agrees with the server on every input (${real.length} difference(s))${real.length ? `:\n        ${real.slice(0, 10).join('\n        ')}` : ''}`, real.length === 0)
ok('the table exercises every refusal reason', ['invalid_type', 'amount_required', 'invalid_amount', 'amount_out_of_range', 'amount_not_allowed',
  'details_not_text', 'details_too_long', 'details_too_many_lines', 'unsupported_characters']
  .every((reason) => TERMS_INPUTS.some((i) => lib.normalizeTermsInput(i).reason === reason)))
ok('the client module is pure (no imports)', !/^\s*import\s/m.test(CLIENT_SRC))

// ══ Whole dollars ═════════════════════════════════════════════════════════════
// A lease is paid in whole dollars, so an invite's amount is whole dollars too:
// cents are refused on both sides with one message, before the range.
const WHOLE_DOLLARS = 'Enter the monthly lease amount in whole dollars, for example 2000.'
ok('the whole-dollar message is the agreed wording, on both sides', client.MESSAGES.invalid_amount === WHOLE_DOLLARS && lib.MESSAGES.invalid_amount === WHOLE_DOLLARS)
for (const [input, cents] of [['2000', 200000], [2000, 200000], ['$1', 100], ['2000.00', 200000], ['100000', 10000000]]) {
  const got = client.parseLeaseAmountToCents(input)
  ok(`whole dollars ${j(input)} → ${cents} cents`, got.ok && got.value === cents)
}
for (const input of ['2000.50', '2000.01', 2000.5, '0.50', '0.99', '1234.56']) {
  ok(`cents ${j(input)} refused as not whole dollars`, client.parseLeaseAmountToCents(input).reason === 'invalid_amount' &&
    client.normalizeTermsInput({ paymentType: 'lease', leaseAmount: input }).message === WHOLE_DOLLARS)
}
ok('out of range in whole dollars is still out of range', client.parseLeaseAmountToCents('100001').reason === 'amount_out_of_range' && client.parseLeaseAmountToCents('0').reason === 'amount_out_of_range')
const OUT_OF_RANGE = 'The monthly lease amount must be between $1 and $100,000.'
ok('the range message is in whole dollars, like every lease amount, on both sides', client.MESSAGES.amount_out_of_range === OUT_OF_RANGE && lib.MESSAGES.amount_out_of_range === OUT_OF_RANGE)

// ══ Sabotage controls ═════════════════════════════════════════════════════════
async function sabotaged(from, to) {
  if (!CLIENT_SRC.includes(from)) throw new Error(`sabotage anchor not found: ${from}`)
  const src = CLIENT_SRC.replace(from, to)
  return import(`data:text/javascript,${encodeURIComponent(src)}`)
}
const CONTROLS = [
  ['a limit changed', 'DETAILS_MAX: 2000,', 'DETAILS_MAX: 2001,'],
  ['the amount pattern allowing three decimals', "(?:\\.\\d{1,2})?$/", "(?:\\.\\d{1,3})?$/"],
  ['format characters no longer dropped', '\\p{Cc}\\p{Cf}\\p{Co}', '\\p{Cc}\\p{Co}'],
  ['the copyright, registered and trade mark signs no longer allowed', "text.replace(TEXT_SYMBOLS_RE, '')", 'text'],
  ['a fourth pictograph allowed', 'String.fromCodePoint(0xa9, 0xae, 0x2122)', 'String.fromCodePoint(0xa9, 0xae, 0x2122, 0x2139)'],
  ['emoji parts no longer refused', ' || EMOJI_PARTS_RE.test(text)', ''],
  ['a type label reworded', "lease: 'Fixed monthly lease payment',", "lease: 'Fixed monthly payment',"],
  ['a message reworded', "amount_required: 'Enter the monthly lease amount.',", "amount_required: 'Enter an amount.',"],
  ['cents allowed again', "  if (cents % 100 !== 0) return { ok: false, reason: 'invalid_amount' }\n", ''],
  ['the whole-dollar message reworded', 'in whole dollars, for example 2000.', 'in whole dollars.'],
  ['the grouping separator changed', "grouped += ','", "grouped += '.'"],
]
for (const [label, from, to] of CONTROLS) {
  const found = differences(await sabotaged(from, to))
  ok(`SABOTAGE: ${label} is reported`, found.length > 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
