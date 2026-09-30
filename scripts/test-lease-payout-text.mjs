#!/usr/bin/env node
// Deterministic check on client/src/lib/leasePayoutText.js — the one client copy
// of the investor-facing wording for a month paid as a fixed monthly lease.
//
// WHY THIS EXISTS. Those sentences are agreed copy, printed word for word by the
// portal, the statement PDF and the load report. A "small tidy" of one of them
// here would leave the portal saying something different from the document the
// investor keeps, about the same payment. So each sentence is pinned character
// for character, filled with real figures, and every builder is paired with the
// input that must NOT produce a sentence (a full month has no reason; an unknown
// reason renders nothing rather than a guess). §4 pins every one equal to the
// server's one home for them, lib/lease-payout-text.js, which the client cannot
// load: this is the one parity check between the two copies.
//
// No network, no database, no Vue — pure input/output, safe anywhere.
//
//   node scripts/test-lease-payout-text.mjs      # exits 1 on any failure

import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.join(__dirname, '..', 'client', 'src', 'lib', 'leasePayoutText.js')

let pass = 0
let fail = 0

function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`)
  }
}

const CLIENT = await import(pathToFileURL(MODULE_PATH).href)
const {
  LEASE_LABEL, LEASE_SUB_LINE, LEASE_EXPLAIN, LEASE_REASON_PRORATED, LEASE_REASON_DOWNTIME,
  LEASE_REASON_NOT_IN_SERVICE, LEASE_LOSS_NOTE, LEASE_NO_LOAD_SHARE, LEASE_REASON_TEXT,
  leaseDollars, fillLeaseText, leaseSubLine, leaseExplain, leaseReasonLine,
} = CLIENT

// ---------------------------------------------------------------------------
// 1. THE CANONICAL SENTENCES, VERBATIM (L1–L10, templates as agreed)
// ---------------------------------------------------------------------------
check('L1', LEASE_LABEL, 'Fixed monthly lease')
check('L2', LEASE_SUB_LINE, 'Fixed monthly lease payment of {amount}')
check('L3', LEASE_EXPLAIN,
  "Under your agreement you are paid a fixed monthly lease of {amount}, not a share of net profit. Your truck's revenue and costs are shown for your information and do not change this payment.")
check('L4', LEASE_REASON_PRORATED, 'The lease covered {covered} of {days} days this month, so this month pays {paid}.')
check('L5', LEASE_REASON_DOWNTIME,
  'No lease payment is owed for this month: the truck had no activity, and your agreement (section 3.1) owes nothing during downtime.')
check('L6', LEASE_REASON_NOT_IN_SERVICE, 'No lease payment is owed for this month: no truck was in service under your lease.')
check('L7', LEASE_LOSS_NOTE,
  'A month your truck runs at a loss still pays the full lease. Losses are not carried forward against your lease.')
check('L10', LEASE_NO_LOAD_SHARE, 'Paid as a fixed monthly lease, so there is no per-load share.')
// Plain ASCII apostrophe and no invisible characters — a curly quote or a
// zero-width space pasted into one copy is exactly how two copies stop matching.
check('every sentence is printable ASCII',
  [LEASE_LABEL, LEASE_SUB_LINE, LEASE_EXPLAIN, LEASE_REASON_PRORATED, LEASE_REASON_DOWNTIME, LEASE_REASON_NOT_IN_SERVICE,
    LEASE_LOSS_NOTE, LEASE_NO_LOAD_SHARE]
    .every((t) => /^[\x20-\x7e]+$/.test(t)), true)
check('the reason map names exactly the three server reasons',
  Object.keys(LEASE_REASON_TEXT).sort(), ['downtime', 'not_in_service', 'prorated'])
check('the reason map is frozen', Object.isFrozen(LEASE_REASON_TEXT), true)

// ---------------------------------------------------------------------------
// 2. FILLED WITH REAL FIGURES
// ---------------------------------------------------------------------------
const FULL = { type: 'lease', leaseAmount: 2000, paidAmount: 2000, coveredDays: 30, daysInMonth: 30, reason: null }
const PRORATED = { type: 'lease', leaseAmount: 2000, paidAmount: 774, coveredDays: 12, daysInMonth: 31, reason: 'prorated' }
const DOWNTIME = { type: 'lease', leaseAmount: 2000, paidAmount: 0, coveredDays: 31, daysInMonth: 31, reason: 'downtime' }
const NOT_IN_SERVICE = { type: 'lease', leaseAmount: 2000, paidAmount: 0, coveredDays: 0, daysInMonth: 28, reason: 'not_in_service' }

check('L2 filled', leaseSubLine(FULL), 'Fixed monthly lease payment of $2,000')
check('L3 filled', leaseExplain(FULL),
  "Under your agreement you are paid a fixed monthly lease of $2,000, not a share of net profit. Your truck's revenue and costs are shown for your information and do not change this payment.")
// production.payoutBasis carries only { type, leaseAmount, effectiveMonth }.
check('L3 from the current-month basis shape', leaseExplain({ type: 'lease', leaseAmount: 12500, effectiveMonth: '2026-09' }),
  "Under your agreement you are paid a fixed monthly lease of $12,500, not a share of net profit. Your truck's revenue and costs are shown for your information and do not change this payment.")
check('L4 filled', leaseReasonLine(PRORATED), 'The lease covered 12 of 31 days this month, so this month pays $774.')
check('L5 filled', leaseReasonLine(DOWNTIME), LEASE_REASON_DOWNTIME)
check('L6 filled', leaseReasonLine(NOT_IN_SERVICE), LEASE_REASON_NOT_IN_SERVICE)

// PAIRED — the inputs that must not produce a reason.
check('a full month states no reason', leaseReasonLine(FULL), '')
check('an unknown reason renders no line, not a guess', leaseReasonLine({ ...FULL, reason: 'retired' }), '')
check('a reason named like an Object key is not a reason', leaseReasonLine({ ...FULL, reason: 'toString' }), '')
check('no basis, no reason', leaseReasonLine(null), '')

// ---------------------------------------------------------------------------
// 3. THE HELPERS
// ---------------------------------------------------------------------------
check('dollars read like the rest of the portal',
  [leaseDollars(2000), leaseDollars(12500), leaseDollars(0), leaseDollars(1933.4), leaseDollars(-50)],
  ['$2,000', '$12,500', '$0', '$1,933', '-$50'])
check('a non-number is $0, never "$NaN"', [leaseDollars(undefined), leaseDollars('x'), leaseDollars(null)], ['$0', '$0', '$0'])
// A missing value stays visible as its placeholder rather than vanishing into
// a sentence with a hole in it.
check('an unfilled placeholder stays visible', fillLeaseText(LEASE_SUB_LINE, {}), 'Fixed monthly lease payment of {amount}')
check('a zero fills, it is not treated as missing', fillLeaseText('{covered} of {days}', { covered: 0, days: 31 }), '0 of 31')
check('the amount comes off the basis, not a default', leaseSubLine({ type: 'lease', leaseAmount: 3150 }),
  'Fixed monthly lease payment of $3,150')

// ---------------------------------------------------------------------------
// 4. EQUAL TO THE SERVER'S ONE HOME (lib/lease-payout-text.js)
// ---------------------------------------------------------------------------
// The statement PDF and the load report print the server's copy; the portal
// prints this one. Every client sentence must be the server's, and every
// server sentence the portal could print must have its client copy.
const SERVER = createRequire(import.meta.url)(path.join(__dirname, '..', 'lib', 'lease-payout-text.js')).LEASE_TEXT
const PAIRS = {
  LEASE_LABEL: SERVER.LABEL,
  LEASE_SUB_LINE: SERVER.SUB_LINE,
  LEASE_EXPLAIN: SERVER.EXPLAIN,
  LEASE_REASON_PRORATED: SERVER.REASON.prorated,
  LEASE_REASON_DOWNTIME: SERVER.REASON.downtime,
  LEASE_REASON_NOT_IN_SERVICE: SERVER.REASON.not_in_service,
  LEASE_LOSS_NOTE: SERVER.LOSS_MONTH,
  LEASE_NO_LOAD_SHARE: SERVER.PER_LOAD_SHARE,
}
for (const [name, serverText] of Object.entries(PAIRS)) check(`${name} equals the server's`, CLIENT[name], serverText)
check('the reason map names the server\'s reasons', Object.keys(LEASE_REASON_TEXT).sort(), Object.keys(SERVER.REASON).sort())
check('every client sentence is paired with the server\'s',
  Object.keys(CLIENT).filter((k) => /^LEASE_[A-Z_]+$/.test(k) && typeof CLIENT[k] === 'string').sort(), Object.keys(PAIRS).sort())
// The server texts with no client copy are the report's, which only the server prints.
const paired = new Set(Object.values(PAIRS))
check('the server texts with no client copy are the report\'s own',
  Object.entries(SERVER).filter(([, v]) => typeof v === 'string' && !paired.has(v)).map(([k]) => k).sort(),
  ['REPORT_LABEL', 'REPORT_NOTE', 'REPORT_NOTE_DURING', 'REPORT_NOTE_FROM'])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
