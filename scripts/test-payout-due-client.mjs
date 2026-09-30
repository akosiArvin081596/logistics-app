#!/usr/bin/env node
// Deterministic check on client/src/lib/payoutDue.js: which rows of the Super
// Admin Payouts console have money to settle, and how a $0 row is labelled.
//
// WHY THIS EXISTS. A month that pays $0 (no activity, a loss carried forward,
// earnings absorbed by an earlier loss, a lease month the lease does not pay)
// read "nothing due" on the investor's own Payouts page but "OWED" on the
// console, with a due date and Mark Processing / Mark Paid beside it. The server
// refuses both on such a row (409 "Nothing to settle for this period"), so the
// buttons were dead ends that invited booking $0 as paid, and the two screens
// told different stories about one row.
//
// Four parts:
//   1. The rule itself, on the server's real row shapes.
//   2. It is the server's rule: the settle refusal and effectiveAmount are the
//      same arithmetic, so "effectiveAmount > 0" is exactly "settleable".
//   3. It is the investor page's rule and words (PayoutsSection.vue).
//   4. The console gates both settle buttons on it and nothing else.
//
// No network, no database, no Vue: pure input/output plus source reads.
//
//   node scripts/test-payout-due-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`)
  }
}

const { hasAmountDue, showsNothingDue, nothingDueReason } = await import(
  pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'payoutDue.js')).href
)

// Rows as GET /api/investor/payouts and GET /api/payouts shape them:
// effectiveAmount = max(0, round(amount + adjustment)).
const row = (o) => ({ status: 'owed', amount: 0, adjustment: 0, effectiveAmount: 0, ...o })
const idle = row({ monthEarnings: 0, lossCarriedIn: 0, lossDeferred: 0 })
const loss = row({ monthEarnings: -250, lossCarriedIn: 0, lossDeferred: 250 })
const absorbed = row({ monthEarnings: 300, lossCarriedIn: 300, lossDeferred: 0 })
const normal = row({ amount: 4500, effectiveAmount: 4500, monthEarnings: 4500, lossCarriedIn: 0, lossDeferred: 0 })
const partlyAbsorbed = row({ amount: 700, effectiveAmount: 700, monthEarnings: 1000, lossCarriedIn: 300, lossDeferred: 0 })
const adjustedUp = row({ amount: 0, adjustment: 150, effectiveAmount: 150, monthEarnings: -250, lossDeferred: 250 })
const adjustedOut = row({ amount: 500, adjustment: -500, effectiveAmount: 0, status: 'processing' })
const paidZero = row({ status: 'paid' })
const lease = (paidAmount, reason) => ({ type: 'lease', leaseAmount: 2000, paidAmount, coveredDays: 30, daysInMonth: 30, reason })
const leaseDowntime = row({ payoutBasis: lease(0, 'downtime'), monthEarnings: 0, lossCarriedIn: 0, lossDeferred: 0 })
const leaseNotInService = row({ payoutBasis: lease(0, 'not_in_service') })
const leaseFull = row({ amount: 2000, effectiveAmount: 2000, payoutBasis: lease(2000, null) })

// ---------------------------------------------------------------- 1. the rule
check('1a idle $0 month has nothing due', hasAmountDue(idle), false)
check('1b loss month settled at $0 has nothing due', hasAmountDue(loss), false)
check('1c month absorbed by an earlier loss has nothing due', hasAmountDue(absorbed), false)
check('1d a paying month has money due', hasAmountDue(normal), true)
check('1e a $0 month adjusted up to $150 has money due', hasAmountDue(adjustedUp), true)
check('1f a month adjusted down to $0 has nothing due', hasAmountDue(adjustedOut), false)
check('1g lease downtime month has nothing due', hasAmountDue(leaseDowntime), false)
check('1h full lease month has money due', hasAmountDue(leaseFull), true)
check('1i no row has nothing due', hasAmountDue(null), false)
check('1j a garbage figure is not money due', hasAmountDue(row({ effectiveAmount: 'n/a' })), false)
// Without effectiveAmount the same arithmetic as the server, never the raw amount.
check('1k no effectiveAmount: amount + adjustment', hasAmountDue({ status: 'owed', amount: 500, adjustment: -500 }), false)
check('1l no effectiveAmount: rounds like the server ($0.40 is $0)', hasAmountDue({ status: 'owed', amount: 0, adjustment: 0.4 }), false)
check('1m no effectiveAmount: $1 is due', hasAmountDue({ status: 'owed', amount: 1 }), true)

check('1n owed $0 row reads "nothing due"', showsNothingDue(idle), true)
check('1o owed paying row reads its status', showsNothingDue(normal), false)
check('1p $0 row already processing keeps its status', showsNothingDue(adjustedOut), false)
check('1q $0 row already paid keeps its status', showsNothingDue(paidZero), false)
check('1r lease $0 row reads "nothing due"', showsNothingDue(leaseNotInService), true)
check('1s no row', showsNothingDue(undefined), false)

check('1t loss month: the loss carried forward', nothingDueReason(loss), '$250 loss carried to later months')
check('1u absorbed month: earnings applied to an earlier loss', nothingDueReason(absorbed), 'earned $300 · $300 applied to an earlier loss')
check('1v idle month: no reason to give', nothingDueReason(idle), '')
check('1w lease month: the lease reason is shown instead', nothingDueReason(leaseDowntime), '')
check('1x lease month with a stray loss field: still the lease reason', nothingDueReason({ ...leaseDowntime, lossDeferred: 250 }), '')
check('1y paying month: unchanged, no reason', nothingDueReason(partlyAbsorbed), '')
check('1z $0 month adjusted up: unchanged, no reason', nothingDueReason(adjustedUp), '')

// ---------------------------------------------------------------- 2. the server's rule
const server = read('server.js')
check('2a status route computes the payable as round(amount + adjustment)',
  server.includes('const settleable = Math.round((payout.amount || 0) + Number(payout.adjustment || 0));'), true)
check('2b status route refuses a forward move on a $0 payable (reopen exempt)',
  /if \(!isReopen && settleable <= 0\) \{\s{1,40}return res\.status\(409\)\.json\(\{ error: "Nothing to settle for this period/.test(server), true)
check('2c effectiveAmount is the same figure clamped at $0',
  server.includes('effectiveAmount: Math.max(0, Math.round((r.amount || 0) + adjustment)),'), true)

// ---------------------------------------------------------------- 3. the investor page
const section = read('client/src/components/investor/PayoutsSection.vue')
check('3a investor page: settleable is effective(p) > 0', /function settleable\(p\) \{\s{1,20}return effective\(p\) > 0\s{0,5}\}/.test(section), true)
check('3b investor page: "nothing due" pill', section.includes('<span v-else class="status-pill st-none">nothing due</span>'), true)
check('3c investor page: loss-carried words', section.includes('{{ fmt(p.lossDeferred) }} loss carried to later months'), true)
check('3d investor page: earlier-loss words',
  section.includes('earned {{ fmt(p.monthEarnings) }} · {{ fmt(p.lossCarriedIn) }} applied to an earlier loss'), true)

// ---------------------------------------------------------------- 4. the console
const view = read('client/src/views/PayoutsView.vue')
const settleButtons = [...view.matchAll(/<button\b([^>]{0,600})>\s{0,40}(Mark Processing|Mark Paid)\s{0,40}<\/button>/g)]
check('4a console has one Mark Processing and one Mark Paid button', settleButtons.map((m) => m[2]), ['Mark Processing', 'Mark Paid'])
for (const m of settleButtons) {
  check(`4b ${m[2]} is offered only when hasAmountDue(p)`, /v-if="[^"]{1,80} && hasAmountDue\(p\)"/.test(m[1]), true)
}
check('4c console status pill reads "nothing due" on showsNothingDue(p)', view.includes('v-if="showsNothingDue(p)"'), true)
check('4d console explains a $0 split month with nothingDueReason(p)', view.includes('v-else-if="nothingDueReason(p)"'), true)

console.log(`payout-due-client: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
