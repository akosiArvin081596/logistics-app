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
//   §4 "Needs Confirmation" pickup dates (pickup plan 2026-10-21, PR 2): the
//      server's `_review` codes pickup_unconfirmed and pickup_unconfirmed_closed
//      add their reason, badge and words and are counted; the open code gets a
//      "Mark confirmed" button in the three load-detail panes, the closed code
//      none; the days read the same in Los Angeles and Manila (L3).
//
// No network, no DOM, no build.
//   node scripts/test-load-review.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', 'client', 'src')
const LIB_PATH = path.join(SRC, 'lib', 'loadReview.js')

// §4's time-zone probe: this runner run again under another TZ prints the
// pickup words, so the parent can compare zones.
const PROBE_ROWS = [
  { _review: [{ code: 'pickup_unconfirmed', stored: '2026-09-01', arrived: '2026-10-01' }] },
  { _review: [{ code: 'pickup_unconfirmed_closed', stored: '2026-09-01', closedMonth: '2026-09' }] },
]
if (process.argv[2] === '--tz-probe') {
  const probe = await import(pathToFileURL(LIB_PATH).href)
  const words = (name, job) => (typeof probe[name] === 'function' ? probe[name](job) : null)
  process.stdout.write(JSON.stringify([...PROBE_ROWS.map((j) => words('pickupReviewText', j)), words('pickupConfirmTitle', PROBE_ROWS[0])]))
  process.exit(0)
}

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
// The names a tab imports from lib/loadReview.
const reviewImports = (src) => {
  const m = src.match(/import \{([^}]*)\} from '\.\.\/\.\.\/lib\/loadReview'/)
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : []
}
for (const file of ['JobBoardTab.vue', 'ActiveLoadsTab.vue', 'CompletedLoadsTab.vue']) {
  const src = read(file)
  check(`${file}: imports the reason helpers`,
    ['needsReview', 'countNeedsReview', 'reviewBadgeText', 'reviewReasonText'].every((n) => reviewImports(src).includes(n)), true)
  check(`${file}: no bare "⚠ Review" badge left`, src.includes('>⚠ Review</span>'), false)
  const expected = file === 'CompletedLoadsTab.vue' ? 1 : 2 // Completed stays a table on phones
  check(`${file}: every row badge names its reason`, src.split(ROW_BADGE).length - 1, expected)
}
{
  const src = read('CompletedLoadsTab.vue')
  check('Completed: nothing points to Active Loads for a fix', /Active Loads\s*(→|->)\s*Edit|Open in Active Loads/.test(src), false)
  check('Completed: the detail badge carries the reason',
    src.includes('<span v-if="selectedJob && needsReview(selectedJob)" :style="reviewBadgeStyle" :title="reviewReasonText(selectedJob)">⚠ {{ reviewBadgeText(selectedJob) }}</span>'), true)
  // The note words every reason but the pickup date, which has its own block (§4).
  const note = (src.match(/<p v-if="reviewNoteText" class="review-note"[\s\S]*?<\/p>/) || [''])[0]
  check('Completed: the detail says why', note.includes('{{ reviewNoteText }}')
    && src.includes('const reviewNoteText = computed(() => (selectedJob.value ? reviewReasonText(selectedJob.value, { pickup: false }) : \'\'))'), true)
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

// ---------------------------------------------------------------------------
console.log('§4 Needs Confirmation pickup dates (`_review` codes on the dashboard rows)')
// ---------------------------------------------------------------------------
// The server's `_review` entry (lib/load-review-flags.js): { code, stored?,
// arrived?, closedMonth?, replaced? }, days as 'YYYY-MM-DD' / 'YYYY-MM' strings.
// Every helper is looked up by name so a missing one fails its checks instead
// of stopping the runner.
const OPEN = 'pickup_unconfirmed'
const CLOSED = 'pickup_unconfirmed_closed'
const fn = (name) => (typeof lib[name] === 'function' ? lib[name] : () => undefined)
const pickupReviewText = fn('pickupReviewText')
const pickupConfirmedRequest = fn('pickupConfirmedRequest')
const canMarkPickupConfirmed = fn('canMarkPickupConfirmed')
const pickupConfirmTitle = fn('pickupConfirmTitle')
const pickupConfirmedToast = fn('pickupConfirmedToast')
const pickupConfirmErrorText = fn('pickupConfirmErrorText')
const withoutPickupReview = fn('withoutPickupReview')
const freshReview = fn('freshReview')
const NC = "The rate con marks the pickup date 'Needs Confirmation'."
const CORRECT = 'Correct the Pickup Appointment or mark it confirmed.'
{
  const ok = row('$1,800.00')
  const withReview = (review, extra = {}) => ({ ...ok, 'Load ID': '900000123', _rowIndex: 7, _review: review, ...extra })
  const open = withReview([{ code: OPEN, stored: '2026-10-06' }])
  const closed = withReview([{ code: CLOSED, stored: '2026-09-29', arrived: '2026-10-17', closedMonth: '2026-09' }])

  // The reason, the filter and the count.
  check('the open code is a reason of its own', reviewReasons(open), [OPEN])
  check('the closed code is a reason of its own', reviewReasons(closed), [CLOSED])
  check('needsReview: true for either code', [needsReview(open), needsReview(closed)], [true, true])
  check('countNeedsReview counts rows with either code', countNeedsReview([ok, open, closed, withReview([])]), 2)
  check('the pickup-date reason comes after the others',
    reviewReasons({ ...open, [PAY]: '', 'Pickup Address': AWAIT, _instructionsReview: ['no_rate_con'] }), ['payment', 'pickup', 'instructions', OPEN])

  // The badge.
  check('the badges', [open, closed].map(reviewBadgeText), ['Pickup date unconfirmed', 'Pickup date unconfirmed (closed month)'])
  check('the badge with other reasons names the pickup date last',
    [{ ...open, [PAY]: '' }, { ...closed, _instructionsReview: ['no_rate_con'] }, { ...open, [PAY]: '', 'Pickup Address': AWAIT, _instructionsReview: ['no_rate_con'] }].map(reviewBadgeText),
    ['No payment + pickup date', 'Driver instructions need a look + pickup date', 'No payment + address + instructions + pickup date'])

  // The words, open code.
  check('open: the rate con marks the date', pickupReviewText(open), `${NC} Confirm the real pickup date.`)
  check('open: the driver reached the shipper on another day',
    pickupReviewText(withReview([{ code: OPEN, stored: '2026-09-29', arrived: '2026-10-17' }])),
    `The driver reached the shipper on Oct 17; the Pickup Appointment says Sep 29. ${CORRECT}`)
  check('open: a tap with no readable stored day',
    pickupReviewText(withReview([{ code: OPEN, arrived: '2026-10-17' }])),
    `${NC} The driver reached the shipper on Oct 17. ${CORRECT}`)
  check('open: a later rate con replaced a person\'s date',
    pickupReviewText(withReview([{ code: OPEN, stored: '2026-10-06', replaced: true }])),
    'A later rate con replaced the pickup date you confirmed. Confirm the real pickup date.')
  check('open: replaced, and the driver reached the shipper on another day',
    pickupReviewText(withReview([{ code: OPEN, stored: '2026-10-06', arrived: '2026-10-12', replaced: true }])),
    `A later rate con replaced the pickup date you confirmed. The driver reached the shipper on Oct 12; the Pickup Appointment says Oct 6. ${CORRECT}`)

  // The words, closed code: the month comes from closedMonth (review Low 4).
  check('closed: the stored date is in the closed month', pickupReviewText(closed),
    "The rate con marked this pickup date 'Needs Confirmation', and the stored date is in a closed month (September 2026), so it can't be edited here.")
  check('closed: the month name follows closedMonth',
    pickupReviewText(withReview([{ code: CLOSED, stored: '2026-11-30', closedMonth: '2026-11' }])),
    "The rate con marked this pickup date 'Needs Confirmation', and the stored date is in a closed month (November 2026), so it can't be edited here.")
  check('closed: another of the load\'s months is the closed one',
    pickupReviewText(withReview([{ code: CLOSED, stored: '2026-10-02', closedMonth: '2026-09' }])),
    "The rate con marked this pickup date 'Needs Confirmation', and this load has a date in a closed month (September 2026), so the pickup date can't be edited here.")
  check('closed: an unreadable month is left out, never printed',
    pickupReviewText(withReview([{ code: CLOSED, stored: '2026-09-29', closedMonth: '2026-13' }])),
    "The rate con marked this pickup date 'Needs Confirmation', and the stored date is in a closed month, so it can't be edited here.")
  const libSrc = fs.readFileSync(LIB_PATH, 'utf8')
  check('lib/loadReview.js names no month itself; the closed words still name one',
    [/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(libSrc), String(pickupReviewText(closed) ?? '').includes('(September 2026)')], [false, true])

  // Dates only, read by splitting.
  const wordsOf = (j) => String(pickupReviewText(j) ?? '')
  check('the words never name the load', [open, closed].every((j) => wordsOf(j) !== '' && !wordsOf(j).includes('900000123')), true)
  check('a day that isn\'t real, or isn\'t YYYY-MM-DD, is left out',
    [
      withReview([{ code: OPEN, stored: '2026-02-30', arrived: '10/17/2026' }]),
      withReview([{ code: OPEN, stored: '2026-13-01', arrived: 20261017 }]),
      withReview([{ code: OPEN, stored: '2026-10-06', arrived: '2026-10-17T03:30:00Z' }]),
    ].map(pickupReviewText),
    [`${NC} Confirm the real pickup date.`, `${NC} Confirm the real pickup date.`, `${NC} Confirm the real pickup date.`])
  check('a leap day reads as itself',
    [pickupReviewText(withReview([{ code: OPEN, stored: '2028-02-29', arrived: '2028-03-02' }])), pickupReviewText(withReview([{ code: OPEN, stored: '2026-02-29', arrived: '2026-03-02' }]))],
    [`The driver reached the shipper on Mar 2; the Pickup Appointment says Feb 29. ${CORRECT}`, `${NC} The driver reached the shipper on Mar 2. ${CORRECT}`])
  check('lib/loadReview.js builds no Date: it splits the day', [/new Date\(|Date\.parse\(/.test(libSrc), libSrc.includes(".split('-')")], [false, true])
  const probe = (tz) => {
    try {
      return JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--tz-probe'], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }))
    } catch (e) {
      return `probe failed: ${e.message}`
    }
  }
  const PROBE_WANT = [
    `The driver reached the shipper on Oct 1; the Pickup Appointment says Sep 1. ${CORRECT}`,
    "The rate con marked this pickup date 'Needs Confirmation', and the stored date is in a closed month (September 2026), so it can't be edited here.",
    'Keep the Pickup Appointment (Sep 1) as the real pickup date. The change is logged.',
  ]
  check('(L3) the days read the same in Los Angeles', probe('America/Los_Angeles'), PROBE_WANT)
  check('(L3) the days read the same in Manila', probe('Asia/Manila'), PROBE_WANT)

  // The words in the shared reason text, and without them.
  check('reviewReasonText: the pickup words follow the others',
    reviewReasonText({ ...open, [PAY]: '' }), `Payment is blank or $0. ${NC} Confirm the real pickup date.`)
  check('reviewReasonText with { pickup: false } leaves the pickup words out',
    [reviewReasonText(closed), reviewReasonText({ ...open, [PAY]: '' }, { pickup: false }), reviewReasonText(closed, { pickup: false }), reviewReasonText(ok, { pickup: false })],
    [pickupReviewText(closed) || 'the closed words', 'Payment is blank or $0.', '', ''])

  // Only the two codes, on objects, in a list.
  check('anything but the two codes, on objects in a `_review` list, flags nothing',
    [withReview([{ code: 'some_future_code' }]), withReview([OPEN]), withReview({ code: OPEN }), withReview(null), withReview([null, 42]), withReview([null, { code: OPEN }])].map(needsReview),
    [false, false, false, false, false, true])
  check('the pickup entry is found among others', reviewReasons(withReview([{ code: 'some_future_code' }, { code: CLOSED, closedMonth: '2026-09' }])), [CLOSED])

  // The "Mark confirmed" call.
  check('the open code\'s call: POST /api/loads/pickup-confirmed by row index and Load ID',
    pickupConfirmedRequest(open, 'Load ID'), { url: '/api/loads/pickup-confirmed', body: { rowIndex: 7, loadId: '900000123' } })
  check('a Load ID withheld from this user goes by its key',
    pickupConfirmedRequest(withReview([{ code: OPEN, stored: '2026-10-06' }], { 'Load ID': '', _loadKey: 'k-made-up-1' }), 'Load ID'),
    { url: '/api/loads/pickup-confirmed', body: { rowIndex: 7, loadId: 'k-made-up-1' } })
  check('no button for the closed code, an unaddressable row or no code',
    [closed, withReview([{ code: OPEN }], { _rowIndex: undefined }), withReview([{ code: OPEN }], { _rowIndex: 1 }), withReview([{ code: OPEN }], { 'Load ID': '' }), ok].map((j) => canMarkPickupConfirmed(j, 'Load ID')),
    [false, false, false, false, false])
  check('a button for the open code', canMarkPickupConfirmed(open, 'Load ID'), true)
  check('the closed words never offer the button', wordsOf(closed) !== '' && !wordsOf(closed).includes('mark it confirmed'), true)
  check('the button\'s title names the kept day',
    [pickupConfirmTitle(open), pickupConfirmTitle(withReview([{ code: OPEN }]))],
    ['Keep the Pickup Appointment (Oct 6) as the real pickup date. The change is logged.', 'Keep the Pickup Appointment as the real pickup date. The change is logged.'])
  check('the toasts', [pickupConfirmedToast({ ok: true, stored: '2026-10-06' }), pickupConfirmedToast({ ok: true, alreadyConfirmed: true })],
    ['Pickup date marked confirmed.', 'This pickup date was already confirmed.'])
  const said = (status, code, error) => ({ status, code, data: { error }, message: error })
  check('a refusal in the server\'s words, the feature off or a role refused in the app\'s',
    [
      pickupConfirmErrorText(said(409, 'PERIOD_FINALIZED', 'This load has a date in a closed month, or one that can\'t be placed in a month, so its pickup date can\'t be confirmed here.')),
      pickupConfirmErrorText(said(409, 'ROW_MOVED', 'Row 7 no longer holds this load. Reload the dashboard and open the load again.')),
      pickupConfirmErrorText(said(404, '', 'Not found')),
      pickupConfirmErrorText(said(404, 'LOAD_KEY_UNKNOWN', 'This load\'s link is out of date. Reload the page and open the load again.')),
      pickupConfirmErrorText(said(403, '', 'Forbidden')),
      pickupConfirmErrorText({ status: 0, code: 'TIMEOUT', message: 'The request timed out. Please check your connection and try again.' }),
      pickupConfirmErrorText(undefined),
    ],
    [
      'This load has a date in a closed month, or one that can\'t be placed in a month, so its pickup date can\'t be confirmed here.',
      'Row 7 no longer holds this load. Reload the dashboard and open the load again.',
      'Marking a pickup date confirmed isn\'t available right now. Reload the dashboard.',
      'This load\'s link is out of date. Reload the page and open the load again.',
      'Only a Super Admin or a Dispatcher can mark a pickup date confirmed.',
      'The request timed out. Please check your connection and try again.',
      'The pickup date could not be marked confirmed. Try again.',
    ])

  // After the call: the badge clears at once, then follows the refreshed row.
  const two = withReview([{ code: OPEN, stored: '2026-10-06' }, { code: 'some_future_code' }])
  const cleared = withoutPickupReview(two)
  check('withoutPickupReview drops the pickup entry only, and copies',
    [cleared && cleared._review, needsReview(cleared), two._review.length], [[{ code: 'some_future_code' }], false, 2])
  check('freshReview: the refreshed row\'s list, [] without one, null when the row is gone',
    [freshReview(open, [{ _rowIndex: 7, _review: [{ code: CLOSED }] }]), freshReview(open, [{ _rowIndex: 7 }]), freshReview(open, [{ _rowIndex: 8, _review: [] }])],
    [[{ code: CLOSED }], [], null])
  check('the filter toggle\'s title is one string', typeof lib.REVIEW_FILTER_TITLE === 'string' && lib.REVIEW_FILTER_TITLE.length > 0, true)
}
{
  // The three load-detail panes and the filter toggles.
  const PANE = '<div v-if="selectedJob && pickupReview(selectedJob)" class="pickup-review" role="note">'
  const BUTTON = '<button v-if="canConfirmPickup && canMarkPickupConfirmed(selectedJob, loadIdCol)" type="button" class="pickup-review-btn" :disabled="pickupMarking" :title="pickupConfirmTitle(selectedJob)" @click="markPickupConfirmed">{{ pickupMarking ? \'Marking…\' : \'Mark confirmed\' }}</button>'
  for (const file of ['JobBoardTab.vue', 'ActiveLoadsTab.vue', 'CompletedLoadsTab.vue']) {
    const src = read(file)
    const pane = (src.match(new RegExp(PANE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?</div>')) || [''])[0]
    check(`${file}: the load detail has the pickup-date block, its words and its button`,
      [pane.includes('{{ pickupReviewText(selectedJob) }}'), pane.includes(BUTTON), pane.includes('<p v-if="pickupMarkError" class="pickup-review-error" role="alert">{{ pickupMarkError }}</p>')], [true, true, true])
    check(`${file}: the button posts the lib's call`,
      src.includes('const call = pickupConfirmedRequest(job, loadIdCol.value)') && src.includes('await api.post(call.url, call.body)'), true)
    check(`${file}: a Super Admin or Dispatcher gets the button`,
      src.includes("const canConfirmPickup = computed(() => auth.isSuperAdmin || auth.user?.role === 'Dispatcher')"), true)
    check(`${file}: the block has its style`, /\.pickup-review \{/.test(src) && /\.pickup-review-btn \{/.test(src), true)
    check(`${file}: the filter toggle's title names no single cause`,
      [src.includes('couldn’t fully extract the rate-con'), src.includes(":title=\"needsReviewOnly ? 'Showing only loads that need review' : REVIEW_FILTER_TITLE\"")], [false, true])
    check(`${file}: imports the pickup-date helpers`,
      ['REVIEW_FILTER_TITLE', 'pickupReview', 'pickupReviewText', 'canMarkPickupConfirmed', 'pickupConfirmTitle', 'pickupConfirmedRequest', 'pickupConfirmedToast', 'pickupConfirmErrorText', 'withoutPickupReview', 'freshReview']
        .every((n) => reviewImports(src).includes(n)), true)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
