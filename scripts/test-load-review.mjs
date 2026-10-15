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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
