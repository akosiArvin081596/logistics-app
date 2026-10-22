#!/usr/bin/env node
// Loadboard > Completed > Needs Review (B15): display only.
//
// client/src/lib/loadReview.js flags a load whose Payment is blank or $0, or
// whose Pickup or Drop-off Address still says "Awaiting Rate Con". The rule
// stays as it is; what changes is what the screen says:
//   - each flagged row's badge names the reason ("No payment",
//     "Address: Awaiting Rate Con") instead of a bare "Review", on all three
//     load tabs;
//   - the Completed detail says why in words, and its hint no longer sends the
//     reader to Active Loads (a completed load isn't listed there): a Super
//     Admin gets a link to Data Manager, everyone else is told a Super Admin can
//     fix it there. The invoice-draft message that pointed to Active Loads now
//     points to Data Manager too.
// Not in this change: hiding loads in closed months (needs a server field).
//
//   §1 the rule, unchanged, on a case table; the reasons, the badge, the text.
//   §2 the tabs' source.
//   §3 rate-con driver instructions (plan PR 3): the server's
//      `_instructionsReview` codes add the reason 'instructions' to the same
//      badge and filter, with words for each code.
//
// No network, no DOM, no build.
//   node scripts/test-load-review.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', 'client', 'src')
const LIB_PATH = path.join(SRC, 'lib', 'loadReview.js')

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`)
}

const lib = await import(pathToFileURL(LIB_PATH).href)
const { needsReview, countNeedsReview, reviewReasons, reviewBadgeText, reviewReasonText } = lib
const has = (fn) => typeof fn === 'function'

// ---------------------------------------------------------------------------
console.log('§1 lib/loadReview.js')
// ---------------------------------------------------------------------------
// The sheet's header really is "  Payment  " (padded); the rule trims headers.
const PAY = '  Payment  '
const row = (payment, pickup = '1 Main St, Dallas, TX 75201', drop = '2 Elm St, Austin, TX 78701') =>
  ({ [PAY]: payment, 'Pickup Address': pickup, 'Drop-off Address': drop })
const AWAIT = 'Awaiting Rate Con'
const CASES = [
  // [row, needsReview, reasons]
  [row('$1,800.00'), false, []],
  [row('950'), false, []],
  [row(''), true, ['payment']],
  [row('   '), true, ['payment']],
  [row('0'), true, ['payment']],
  [row('$0'), true, ['payment']],
  [row('$0.00'), true, ['payment']],
  [row(' $ 0.00 '), true, ['payment']],
  [row(undefined), true, ['payment']],
  [row('$1,800.00', AWAIT), true, ['pickup']],
  [row('$1,800.00', undefined, 'awaiting  rate con'), true, ['drop']],
  [row('$1,800.00', AWAIT, AWAIT), true, ['pickup', 'drop']],
  [row('', AWAIT, AWAIT), true, ['payment', 'pickup', 'drop']],
  [null, false, []],
]
check('needsReview: the rule is unchanged', CASES.map(([r]) => needsReview(r)), CASES.map(([, n]) => n))
check('countNeedsReview: unchanged', countNeedsReview(CASES.map(([r]) => r)), CASES.filter(([, n]) => n).length)
check('reviewReasons, reviewBadgeText and reviewReasonText exist',
  [has(reviewReasons), has(reviewBadgeText), has(reviewReasonText)], [true, true, true])
if (has(reviewReasons) && has(reviewBadgeText) && has(reviewReasonText)) {
  check('reviewReasons: why each row is flagged', CASES.map(([r]) => reviewReasons(r)), CASES.map(([, , why]) => why))
  check('reviewReasons agrees with needsReview on every case',
    CASES.every(([r]) => (reviewReasons(r).length > 0) === needsReview(r)), true)
  check('reviewBadgeText: the badge names the reason',
    [row(''), row('$1,800.00', AWAIT), row('$1,800.00', undefined, AWAIT), row('', AWAIT), row('$1,800.00'), null].map(reviewBadgeText),
    ['No payment', 'Address: Awaiting Rate Con', 'Address: Awaiting Rate Con', 'No payment + address', '', ''])
  check('reviewReasonText: the reason in words',
    [row(''), row('$1,800.00', AWAIT), row('$1,800.00', undefined, AWAIT), row('$1,800.00', AWAIT, AWAIT), row('$0', AWAIT), row('$1,800.00')].map(reviewReasonText),
    [
      'Payment is blank or $0.',
      'Pickup Address says "Awaiting Rate Con".',
      'Drop-off Address says "Awaiting Rate Con".',
      'Pickup and Drop-off Addresses say "Awaiting Rate Con".',
      'Payment is blank or $0. Pickup Address says "Awaiting Rate Con".',
      '',
    ])
}

// ---------------------------------------------------------------------------
console.log('§2 the tabs')
// ---------------------------------------------------------------------------
const DASH = path.join(SRC, 'components', 'dashboard')
const read = (f) => fs.readFileSync(path.join(DASH, f), 'utf8')
const ROW_BADGE = '<span v-if="needsReview(job)" :style="reviewBadgeStyle" :title="reviewReasonText(job)">⚠ {{ reviewBadgeText(job) }}</span>'
for (const file of ['JobBoardTab.vue', 'ActiveLoadsTab.vue', 'CompletedLoadsTab.vue']) {
  const src = read(file)
  check(`${file}: imports the reason helpers`,
    src.includes("import { needsReview, countNeedsReview, reviewBadgeText, reviewReasonText } from '../../lib/loadReview'"), true)
  check(`${file}: no bare "⚠ Review" badge left`, src.includes('>⚠ Review</span>'), false)
  const expected = file === 'CompletedLoadsTab.vue' ? 1 : 2 // Completed stays a table on phones
  check(`${file}: every row badge names its reason`, src.split(ROW_BADGE).length - 1, expected)
}
{
  const src = read('CompletedLoadsTab.vue')
  check('Completed: nothing points to Active Loads for a fix', /Active Loads\s*(→|->)\s*Edit|Open in Active Loads/.test(src), false)
  check('Completed: the detail badge carries the reason',
    src.includes('<span v-if="selectedJob && needsReview(selectedJob)" :style="reviewBadgeStyle" :title="reviewReasonText(selectedJob)">⚠ {{ reviewBadgeText(selectedJob) }}</span>'), true)
  const note = (src.match(/<p v-if="selectedJob && needsReview\(selectedJob\)" class="review-note"[\s\S]*?<\/p>/) || [''])[0]
  check('Completed: the detail says why', note.includes('{{ reviewReasonText(selectedJob) }}'), true)
  check('Completed: a Super Admin gets a link to Data Manager',
    /<template v-if="auth\.isSuperAdmin">[^<]*<RouterLink to="\/data" class="review-note-link">Data Manager<\/RouterLink>/.test(note), true)
  check('Completed: everyone else is told a Super Admin can fix it there',
    /<template v-else>A Super Admin can fix it in Data Manager\./.test(note), true)
  check('Completed: the note says a closed month\'s Payment stays as it is',
    (note.match(/A closed month's Payment can't be changed\./g) || []).length, 2)
  check('Completed: the invoice-draft message points to Data Manager',
    src.includes('Add the Payment on this load in Data Manager (Job Tracking), then try again.'), true)
  check('Completed: the note has its style', /\.review-note \{/.test(src) && /\.review-note-link \{/.test(src), true)
}

// ---------------------------------------------------------------------------
console.log('§3 driver instructions (`_instructionsReview` codes on the dashboard rows)')
// ---------------------------------------------------------------------------
// The server puts the review codes of each open load whose driver instructions
// need a person on the dashboard row (codes only, never a token: PR 2,
// annotateDashboardRows()). The row joins the existing badge and the Needs Review
// filter as the reason 'instructions'; the badge says "Driver instructions need a
// look" and the title words each code. The client never works a code out itself.
const INSTRUCTION_WORDS = {
  no_rate_con: 'no rate con is on file',
  rate_con_unmatched: 'a rate-con file names this load but couldn\'t be matched to it',
  rate_con_not_read: 'the rate con on file hasn\'t been read yet',
  extract_failed: 'the rate con couldn\'t be read',
  load_number_unconfirmed: 'the load number on the rate con doesn\'t match',
  reference_missed: 'reference-like numbers on the rate con are missing',
  reference_not_on_rate_con: 'some references are not on the rate con',
  unusual_content: 'some items hold another address, redirect wording or no category',
  stop_place_mismatch: 'a stop\'s city or state differs from the load',
  refiltered: 'something stored was withheld under the current rules',
  money_or_number_withheld: 'some references were left out as amounts, phones or account numbers',
  reference_too_long: 'some references were too long and left out',
  reference_unknown_type: 'some references had a kind the app doesn\'t show',
  requirement_missed: 'the rate con mentions requirements the instructions don\'t include',
  stop_count_mismatch: 'the rate con lists a different number of stops',
  not_cross_checked: 'the rate con\'s text can\'t be checked for completeness',
  suspicious_text: 'some items read like instructions to a computer',
  rate_con_changed: 'a newer reading of the rate con is waiting',
}
{
  const ok = row('$1,800.00')
  const withCodes = (codes) => ({ ...ok, _instructionsReview: codes })
  check('a row with codes is flagged with the reason "instructions"', reviewReasons(withCodes(['no_rate_con'])), ['instructions'])
  check('needsReview: true for a row with codes', needsReview(withCodes(['rate_con_changed'])), true)
  check('no codes, an empty list or a non-list: not flagged',
    [ok, withCodes([]), withCodes('no_rate_con'), withCodes(null), withCodes({ no_rate_con: true })].map(needsReview), [false, false, false, false, false])
  check('the instructions reason comes after payment and address',
    reviewReasons({ ...row('', AWAIT), _instructionsReview: ['no_rate_con'] }), ['payment', 'pickup', 'instructions'])
  check('countNeedsReview counts rows flagged for instructions',
    countNeedsReview([ok, withCodes(['no_rate_con']), withCodes([]), withCodes(['extract_failed', 'refiltered'])]), 2)
  check('the badge: "Driver instructions need a look"', reviewBadgeText(withCodes(['extract_failed'])), 'Driver instructions need a look')
  check('the badge with another reason names both',
    [{ ...row(''), _instructionsReview: ['no_rate_con'] }, { ...row('$1,800.00', AWAIT), _instructionsReview: ['no_rate_con'] }].map(reviewBadgeText),
    ['No payment + instructions', 'Address: Awaiting Rate Con + instructions'])
  check('every code the server sends has words', Object.keys(INSTRUCTION_WORDS).map((c) => reviewReasonText(withCodes([c]))),
    Object.values(INSTRUCTION_WORDS).map((w) => `Driver instructions need a look: ${w}.`))
  check('several codes, in the order sent, each once',
    reviewReasonText(withCodes(['stop_place_mismatch', 'rate_con_changed', 'stop_place_mismatch'])),
    `Driver instructions need a look: ${INSTRUCTION_WORDS.stop_place_mismatch}; ${INSTRUCTION_WORDS.rate_con_changed}.`)
  check('a code the client doesn\'t know still flags the row, with the words it has',
    [needsReview(withCodes(['some_future_code'])), reviewReasonText(withCodes(['some_future_code'])), reviewReasonText(withCodes(['some_future_code', 'no_rate_con']))],
    [true, 'Driver instructions need a look.', `Driver instructions need a look: ${INSTRUCTION_WORDS.no_rate_con}.`])
  check('the words follow the existing reasons',
    reviewReasonText({ ...row(''), _instructionsReview: ['no_rate_con'] }),
    `Payment is blank or $0. Driver instructions need a look: ${INSTRUCTION_WORDS.no_rate_con}.`)
  check('only codes reach the words: a non-string entry is ignored',
    reviewReasonText(withCodes([{ text: 'T8273641' }, 42, 'no_rate_con'])), `Driver instructions need a look: ${INSTRUCTION_WORDS.no_rate_con}.`)
}
{
  // The load-detail badge of the two tabs that get the instructions codes says why.
  for (const file of ['JobBoardTab.vue', 'ActiveLoadsTab.vue']) {
    const src = read(file)
    check(`${file}: the detail badge's title gives the reason in words`,
      src.includes('<span v-if="selectedJob && needsReview(selectedJob)" :style="reviewBadgeStyle" :title="reviewReasonText(selectedJob)">⚠ {{ reviewBadgeText(selectedJob) }}</span>'), true)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
