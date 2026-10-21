#!/usr/bin/env node
// Rate-con driver instructions, the staff screen (plan PR 3, §4): the logic behind
// client/src/components/dashboard/DriverInstructionsSection.vue, which lives in
// client/src/lib/driverInstructionsView.js.
//
// The server is the gate (PR 2, lib/driver-instructions-runtime.js): every route
// answers 404 while the flag is off, refuses a staff edit with
// 400 INSTRUCTIONS_CONTENT_NOT_ALLOWED { rule, field } (a field KIND for a number or
// contact rule), and serves the driver preview, the review reasons in words and the
// pending re-issue. The section only displays what it is sent:
//   - it renders for Super Admin and Dispatcher only, and not at all on a 404 with
//     no code (the flag off);
//   - each error code gets a plain message; a refusal names the field kind only,
//     never which item (no index, no path, no value, never the server's own text);
//   - a pending re-issue is shown side by side with what drivers see now;
//   - an edit sends what the person typed, in the payload's shape: the browser
//     never drops, trims or rewrites content (the server refuses or keeps it).
//
//   §1 the role gate
//   §2 the error messages, one per code
//   §3 refusals name the field kind only
//   §4 the section hides on the flag-off 404, and only then
//   §5 the pending re-issue, side by side
//   §6 the status in words; what Mark reviewed and the re-read answer say
//   §7 the edit draft and the body sent: shape only, content untouched
//   §8 the display labels match the server's (lib/driver-instructions.js)
//   §9 the source: the section, its routes, the two tabs
//
// No DOM, no server, no build.
//   node scripts/test-driver-instructions-client.mjs      # exits 1 on any failure
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB = path.join(ROOT, 'client', 'src', 'lib', 'driverInstructionsView.js')
const SECTION = path.join(ROOT, 'client', 'src', 'components', 'dashboard', 'DriverInstructionsSection.vue')

let pass = 0
let fail = 0
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`)
}
function done() {
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

if (!fs.existsSync(LIB)) {
  eq('client/src/lib/driverInstructionsView.js exists', false, true)
  eq('DriverInstructionsSection.vue exists', fs.existsSync(SECTION), true)
  done()
}
const v = await import(pathToFileURL(LIB).href)
const server = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'driver-instructions.js'))

// An error as useApi() throws it: message from the server, status, code, data.
function apiError(status, data = {}) {
  const e = new Error(data.error || `Request failed (${status})`)
  e.status = status
  e.code = data.code || ''
  e.data = data
  return e
}
const MADE_UP_DENY = 'T8273641'

// ---------------------------------------------------------------------------
console.log('§1 the role gate')
// ---------------------------------------------------------------------------
eq('Super Admin and Dispatcher see the section; nobody else',
  ['Super Admin', 'Dispatcher', 'Driver', 'Investor', '', undefined, null, 'super admin'].map(v.canSeeDriverInstructions),
  [true, true, false, false, false, false, false, false])

// ---------------------------------------------------------------------------
console.log('§2 the error messages')
// ---------------------------------------------------------------------------
{
  const msg = (status, data) => v.instructionsError(apiError(status, data)).message
  eq('503 INSTRUCTIONS_UNVERIFIED', msg(503, { code: 'INSTRUCTIONS_UNVERIFIED', error: 'x' }), 'Couldn\'t check this load\'s details right now; try again.')
  eq('429 INSTRUCTIONS_REREAD_TOO_SOON', msg(429, { code: 'INSTRUCTIONS_REREAD_TOO_SOON' }), 'You can re-read this rate con again in a few minutes.')
  eq('429 RATE_LIMITED (the per-user write limit)', msg(429, { code: 'RATE_LIMITED' }), 'Too many changes in a short time. Try again in a few minutes.')
  eq('404 INSTRUCTIONS_NO_RATE_CON', msg(404, { code: 'INSTRUCTIONS_NO_RATE_CON' }), 'No rate con is on file for this load. Type the instructions instead.')
  eq('503 INSTRUCTIONS_EXTRACT_BUSY', msg(503, { code: 'INSTRUCTIONS_EXTRACT_BUSY' }), 'The rate con can\'t be re-read right now. Try again later.')
  eq('502 INSTRUCTIONS_EXTRACT_FAILED', msg(502, { code: 'INSTRUCTIONS_EXTRACT_FAILED' }), 'The rate con couldn\'t be read. Try again or type the instructions.')
  eq('409 INSTRUCTIONS_NOTHING_TO_REVIEW', msg(409, { code: 'INSTRUCTIONS_NOTHING_TO_REVIEW' }), 'There is nothing to review yet.')
  eq('409 INSTRUCTIONS_NO_PENDING', msg(409, { code: 'INSTRUCTIONS_NO_PENDING' }), 'The newer reading is no longer waiting. The section has been refreshed.')
  eq('404 LOAD_NOT_FOUND', msg(404, { code: 'LOAD_NOT_FOUND' }), 'This load wasn\'t found.')
  eq('403', msg(403, { error: 'Forbidden' }), 'Only a Super Admin or a Dispatcher can see driver instructions.')
  eq('a timeout (status 0)', msg(0, { code: 'TIMEOUT' }), 'The request timed out. Check the connection and try again.')
  eq('anything else', msg(500, { error: 'The driver instructions couldn\'t be loaded.' }), 'Something went wrong with the driver instructions. Try again.')
  eq('a non-error', v.instructionsError(null).message, 'Something went wrong with the driver instructions. Try again.')
  // The server's own `error` text is never what the section shows.
  const odd = apiError(500, { error: `leak ${MADE_UP_DENY}` })
  eq('the server\'s error text is never shown', v.instructionsError(odd).message.includes(MADE_UP_DENY), false)
}

// ---------------------------------------------------------------------------
console.log('§3 refusals name the field kind only')
// ---------------------------------------------------------------------------
{
  const refusal = (rule, field) => v.instructionsError(apiError(400, { code: 'INSTRUCTIONS_CONTENT_NOT_ALLOWED', error: 'This can\'t be shown to drivers. Remove it and save again.', rule, field }))
  const NUMBER = 'This can\'t be saved: it looks like a number or contact drivers must not see.'
  eq('number rule, references', refusal('number', 'references'), { hidden: false, message: `${NUMBER} Field: references.`, fieldKind: 'references' })
  eq('contact rule, text', refusal('contact', 'text'), { hidden: false, message: `${NUMBER} Field: item text.`, fieldKind: 'text' })
  eq('number rule, facility', refusal('number', 'facility').message, `${NUMBER} Field: facility name.`)
  eq('money rule (the server sends a full path): kind only',
    refusal('money', 'stops[1].requirements[3].text'),
    { hidden: false, message: 'This can\'t be saved: it looks like an amount drivers must not see. Field: item text.', fieldKind: 'text' })
  eq('terms rule', refusal('terms', 'loadRequirements[0].text').message, 'This can\'t be saved: it looks like contract terms drivers must not see. Field: item text.')
  eq('unusual (another address, redirect wording)', refusal('unusual', 'stops[0].instructions[2].text').message,
    'This can\'t be saved: it holds another address, redirect wording or text drivers must not see. Field: item text.')
  eq('a rule the client doesn\'t know', refusal('something_new', 'stops[0].facility').message, 'This can\'t be saved: it holds something drivers must not see. Field: facility name.')
  eq('a reference path reads "references", whatever part of it',
    ['stops[2].references[11].value', 'stops[0].references[0].label', 'stops[0].references[4]', 'references'].map((f) => refusal('number', f).fieldKind),
    ['references', 'references', 'references', 'references'])
  eq('400 INSTRUCTIONS_INVALID: kind only',
    v.instructionsError(apiError(400, { code: 'INSTRUCTIONS_INVALID', field: 'stops[3].requirements[7].category', rule: '' })),
    { hidden: false, message: 'This can\'t be saved: an entry isn\'t in the expected form. Field: requirement kind.', fieldKind: 'category' })
  eq('fieldKindOf: unknown and odd fields fall back to "instructions"',
    [undefined, '', 'payload', 'stops', 'stops[0]', 'loadRequirements', 'stops[0].place', 'stops[1].kind', 'stops[1].instructions[0].kind', 'x'.repeat(500)].map(v.fieldKindOf),
    ['instructions', 'instructions', 'instructions', 'instructions', 'instructions', 'instructions', 'place', 'kind', 'kind', 'instructions'])
  // Never which item: no index, no path, no value, whatever the body carries.
  const leaky = [
    refusal('number', 'stops[1].references[2].value'),
    refusal('money', 'stops[0].requirements[3].text'),
    v.instructionsError(apiError(400, { code: 'INSTRUCTIONS_CONTENT_NOT_ALLOWED', rule: 'number', field: 'references', value: MADE_UP_DENY, item: 3 })),
  ]
  eq('a refusal message holds no index, path, digit or value',
    leaky.map((r) => /\[|\]|stops|requirements|\d/.test(r.message)), [false, false, false])
}

// ---------------------------------------------------------------------------
console.log('§4 hidden while the flag is off')
// ---------------------------------------------------------------------------
eq('404 with no code (the flag off) hides the section',
  [apiError(404, { error: 'Not found' }), apiError(404, {})].map((e) => v.instructionsError(e).hidden), [true, true])
eq('a 404 with a code does not hide it',
  [apiError(404, { code: 'INSTRUCTIONS_NO_RATE_CON' }), apiError(404, { code: 'LOAD_NOT_FOUND' })].map((e) => v.instructionsError(e).hidden), [false, false])
eq('other statuses never hide it',
  [400, 403, 409, 429, 500, 502, 503, 0].map((s) => v.instructionsError(apiError(s, {})).hidden), [false, false, false, false, false, false, false, false])

// ---------------------------------------------------------------------------
console.log('§5 the pending re-issue, side by side')
// ---------------------------------------------------------------------------
const STOP = (over = {}) => ({ seq: 1, kind: 'pickup', facility: 'QA Test Shipper', place: 'Testville, TX', references: [{ type: 'pickup_number', label: 'Pickup #', value: 'QA-PU-1001' }], requirements: [{ category: 'seal', text: 'Seal the trailer before leaving.', critical: true }], instructions: [{ kind: 'shipper', text: 'Check in at the guard shack.' }], ...over })
const PAYLOAD = (over = {}) => ({ v: 1, loadRequirements: [{ category: 'ppe', text: 'Hard hat and vest on site.', critical: true }], stops: [STOP()], footnote: 'From the rate con. Questions: contact dispatch.', ...over })
const BODY = (over = {}) => ({ status: 'auto', published: true, publishedAt: '2026-10-21T20:00:00Z', reviewedAt: '', reviewedBy: '', payload: PAYLOAD(), driverPreview: PAYLOAD(), reasons: [], pending: null, refiltered: false, unmatchedFiles: 0, ...over })
{
  eq('no pending: nothing side by side', [v.pendingCompare(BODY()), v.pendingCompare(null), v.pendingCompare({})], [null, null, null])
  const next = PAYLOAD({ stops: [STOP({ facility: 'QA Test Shipper Dock 2' })] })
  const body = BODY({ pending: { payload: next, reasons: [{ code: 'rate_con_changed', text: 'A newer reading of the rate con is waiting: accept it or keep the current one.' }] } })
  const cmp = v.pendingCompare(body)
  eq('pending: drivers\' current version beside the new reading, exactly as served',
    cmp && [cmp.current === body.driverPreview, cmp.next === body.pending.payload, cmp.reasons], [true, true, body.pending.reasons])
  eq('pending with no reasons list: an empty list', v.pendingCompare(BODY({ pending: { payload: next } })).reasons, [])
}

// ---------------------------------------------------------------------------
console.log('§6 the status in words')
// ---------------------------------------------------------------------------
eq('statusView: each status, published or not',
  [
    BODY({ status: 'none', published: false }),
    BODY({ status: 'failed', published: false }),
    BODY({ status: 'needs_review', published: false }),
    BODY({ status: 'needs_review', published: true }),
    BODY({ status: 'auto', published: true }),
    BODY({ status: 'reviewed', published: true }),
    BODY({ status: 'something_new', published: false }),
  ].map((b) => [v.statusView(b).label, v.statusView(b).note]),
  [
    ['No instructions yet', 'Drivers see nothing for this load.'],
    ['Couldn\'t read the rate con', 'Drivers see nothing for this load.'],
    ['Needs review', 'Drivers don\'t see these until someone marks them reviewed.'],
    ['Needs review', 'Drivers see the version shown here.'],
    ['Read from the rate con', 'Drivers see the version shown here.'],
    ['Reviewed', 'Drivers see the version shown here.'],
    ['Unknown', 'Drivers don\'t see these until someone marks them reviewed.'],
  ])
eq('canMarkReviewed: not before anything is stored or after a failed read (the server answers 409)',
  ['none', 'failed', 'auto', 'needs_review', 'reviewed'].map((status) => v.canMarkReviewed(BODY({ status }))), [false, false, true, true, true])
eq('the re-read answer in words',
  ['insert', 'replace', 'unchanged', 'pending', 'other', undefined].map(v.rereadResultText),
  [
    'The rate con was read.',
    'The rate con was read again and the instructions were updated.',
    'The rate con was read again. Nothing changed.',
    'The rate con was read again. The new reading is waiting below: accept it or keep the current one.',
    'The rate con was read again.',
    'The rate con was read again.',
  ])
eq('hiddenFromDrivers: the items the server flagged, with words; nothing else',
  v.hiddenFromDrivers(PAYLOAD({
    loadRequirements: [{ category: 'other', text: 'QA other item.', critical: false, flag: 'unusual_content' }],
    stops: [STOP({ instructions: [{ kind: 'receiver', text: 'QA redirect item.', flag: 'unusual_content' }, { kind: 'shipper', text: 'Fine.' }], requirements: [{ category: 'seal', text: 'QA odd text.', flag: 'suspicious_text' }] })],
  })),
  [
    { where: 'Whole load', label: 'Other', text: 'QA other item.', why: 'Drivers don\'t see this: items of kind Other are never shown to drivers.' },
    { where: 'Stop 1 · Pickup', label: 'Seal', text: 'QA odd text.', why: 'Drivers don\'t see this: it reads like instructions to a computer.' },
    { where: 'Stop 1 · Pickup', label: 'Receiver instructions', text: 'QA redirect item.', why: 'Drivers don\'t see this: it holds another address or redirect wording.' },
  ])
eq('hiddenFromDrivers: none flagged, or no payload', [v.hiddenFromDrivers(PAYLOAD()), v.hiddenFromDrivers(null)], [[], []])
{
  // The "Hidden from drivers" chip in a payload view gives the same reason as the list.
  const payloadView = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'dashboard', 'DriverInstructionsPayload.vue'), 'utf8')
  eq('whyHidden(): Other says kind Other; flagged text says why; the payload view\'s chips use it',
    [
      typeof v.whyHidden === 'function' ? [v.whyHidden({ category: 'other', flag: 'unusual_content' }), v.whyHidden({ kind: 'receiver', flag: 'unusual_content' }), v.whyHidden(null)] : null,
      (payloadView.match(/:title="whyHidden\((r|x)\)"/g) || []).length,
      /flagWords/.test(payloadView),
    ],
    [
      ['Drivers don\'t see this: items of kind Other are never shown to drivers.', 'Drivers don\'t see this: it holds another address or redirect wording.', ''],
      3,
      false,
    ])
}
// An item of kind Other saves (it is never refused) and stays hidden from drivers; an
// item the server flagged for its text is refused until it is removed or reworded.
eq('draftItemNote: Other is never shown; flagged text must go or change; nothing otherwise',
  typeof v.draftItemNote === 'function'
    ? [{ category: 'other', text: 'x' }, { category: 'other', text: 'x', flag: 'unusual_content' }, { kind: 'receiver', text: 'x', flag: 'unusual_content' }, { category: 'seal', text: 'x', flag: 'suspicious_text' }, { category: 'seal', text: 'x' }, null].map(v.draftItemNote)
    : null,
  [
    'Items of kind Other are never shown to drivers: pick another kind or remove it.',
    'Items of kind Other are never shown to drivers: pick another kind or remove it.',
    'Drivers don\'t see this: it holds another address or redirect wording. Remove it or reword it before saving.',
    'Drivers don\'t see this: it reads like instructions to a computer. Remove it or reword it before saving.',
    '',
    '',
  ])
eq('the Save and Mark reviewed notices say when some items stay hidden',
  typeof v.doneText === 'function'
    ? [v.doneText('Saved.', BODY()), v.doneText('Marked reviewed.', BODY({ payload: PAYLOAD({ loadRequirements: [{ category: 'other', text: 'x', flag: 'unusual_content' }] }) })), v.doneText('Saved.', null)]
    : null,
  [
    'Saved. Drivers see this version.',
    'Marked reviewed. Drivers see this version, except the items under "Not shown to drivers".',
    'Saved. Drivers see this version.',
  ])

// ---------------------------------------------------------------------------
console.log('§7 the edit draft and the body sent')
// ---------------------------------------------------------------------------
{
  const stored = PAYLOAD({ loadRequirements: [{ category: 'other', text: 'QA other item.', critical: false, flag: 'unusual_content' }] })
  const draft = v.editDraftFrom(stored)
  eq('the draft starts from the staff payload, flags kept for display', draft.loadRequirements[0].flag, 'unusual_content')
  draft.stops[0].references.push({ ...v.blankReference(), value: `  ${MADE_UP_DENY} ` })
  draft.stops[0].requirements.push(v.blankRequirement())
  draft.stops[0].instructions[0].text = 'Check in at gate 4 , then wait.'
  draft.stops.push(v.blankStop('delivery'))
  const body = v.editBody(draft)
  eq('the draft is a copy: the stored payload is untouched', stored.stops[0].references.length, 1)
  eq('the body: { payload } in the payload\'s shape, display keys left out',
    body,
    {
      payload: {
        loadRequirements: [{ category: 'other', text: 'QA other item.' }],
        stops: [
          {
            kind: 'pickup', facility: 'QA Test Shipper', place: 'Testville, TX',
            references: [{ type: 'pickup_number', label: '', value: 'QA-PU-1001' }, { type: 'other_reference', label: '', value: `  ${MADE_UP_DENY} ` }],
            requirements: [{ category: 'seal', text: 'Seal the trailer before leaving.' }, { category: 'check_in', text: '' }],
            instructions: [{ kind: 'shipper', text: 'Check in at gate 4 , then wait.' }],
          },
          { kind: 'delivery', facility: '', place: '', references: [], requirements: [], instructions: [] },
        ],
      },
    })
  eq('the browser drops nothing: the made-up deny value and the blank item go to the server as typed',
    [JSON.stringify(body).includes(`  ${MADE_UP_DENY} `), body.payload.stops[0].requirements.length], [true, 2])
  eq('editDraftFrom: no payload gives an empty draft', v.editDraftFrom(null), { loadRequirements: [], stops: [] })
  eq('blank items', [v.blankReference(), v.blankRequirement(), v.blankInstruction(), v.blankStop('pickup')],
    [{ type: 'other_reference', label: '', value: '' }, { category: 'check_in', text: '' }, { kind: 'shipper', text: '' },
      { kind: 'pickup', facility: '', place: '', references: [], requirements: [], instructions: [] }])
}

{
  // M1: the server stores each reference with its kind's own label ("Pickup #"). A
  // kind changed in the draft must not carry the old kind's label to the server.
  const d = v.editDraftFrom(PAYLOAD())
  eq('M1 the draft leaves a kind\'s own default label blank', d.stops[0].references[0].label, '')
  d.stops[0].references[0].type = 'po_number'
  eq('M1 a kind changed in the draft sends label "" (the server applies the new kind\'s label)',
    v.editBody(d).payload.stops[0].references[0], { type: 'po_number', label: '', value: 'QA-PU-1001' })
  const own = v.editDraftFrom(PAYLOAD({ stops: [STOP({ references: [{ type: 'pickup_number', label: 'PU Ref', value: 'QA-PU-1001' }] })] }))
  eq('M1 a label of its own stays in the draft', own.stops[0].references[0].label, 'PU Ref')
  const typed = { type: 'pickup_number', label: 'Pickup #', value: 'QA-1' }
  const mine = { type: 'pickup_number', label: 'PU Ref', value: 'QA-1' }
  if (typeof v.setReferenceType === 'function') { v.setReferenceType(typed, 'po_number'); v.setReferenceType(mine, 'po_number') }
  eq('M1 setReferenceType(): the old kind\'s default label is cleared with the kind; a label of its own stays',
    [typed, mine], [{ type: 'po_number', label: '', value: 'QA-1' }, { type: 'po_number', label: 'PU Ref', value: 'QA-1' }])
}

// ---------------------------------------------------------------------------
console.log('§8 the labels match the server\'s')
// ---------------------------------------------------------------------------
eq('reference labels', v.REFERENCE_LABELS, server.REFERENCE_LABELS)
eq('requirement category labels', v.CATEGORY_LABELS, server.CATEGORY_LABELS)
eq('instruction kinds', Object.keys(v.INSTRUCTION_KIND_LABELS), server.INSTRUCTION_KINDS)
eq('stop kinds', Object.keys(v.STOP_KIND_LABELS), server.STOP_KINDS)
eq('the routes', ['', 'review', 'accept-pending', 're-extract'].map((a) => v.instructionsUrl('QA 1001/x', a)),
  ['/api/loads/QA%201001%2Fx/driver-instructions', '/api/loads/QA%201001%2Fx/driver-instructions/review',
    '/api/loads/QA%201001%2Fx/driver-instructions/accept-pending', '/api/loads/QA%201001%2Fx/driver-instructions/re-extract'])

{
  // The dashboard badge words every code the server can send, and no other.
  const review = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'loadReview.js')).href)
  eq('the badge words cover exactly the server\'s review codes',
    Object.keys(review.INSTRUCTION_REVIEW_WORDS || {}).sort(), Object.keys(server.REVIEW_REASONS).sort())
}
{
  // After a write the tabs refresh the dashboard and hand the open load its fresh codes.
  const rows = [{ _rowIndex: 2, _instructionsReview: ['no_rate_con'] }, { _rowIndex: 3 }]
  const fresh = typeof v.freshInstructionCodes === 'function' ? v.freshInstructionCodes : () => 'missing'
  eq('freshInstructionCodes: the refreshed row\'s codes, [] when it has none, null when the row is gone',
    [fresh({ _rowIndex: 2 }, rows), fresh({ _rowIndex: 3, _instructionsReview: ['rate_con_changed'] }, rows), fresh({ _rowIndex: 9 }, rows), fresh(null, rows), fresh({ _rowIndex: 2 }, null)],
    [['no_rate_con'], [], null, null, null])
}

// ---------------------------------------------------------------------------
console.log('§9 the source')
// ---------------------------------------------------------------------------
{
  const src = fs.existsSync(SECTION) ? fs.readFileSync(SECTION, 'utf8') : ''
  eq('DriverInstructionsSection.vue exists', !!src, true)
  eq('the section renders only for staff, and not while the flag is off', /<section v-if="visible"/.test(src) && /const visible = computed\(\(\) => canSee\.value && !off\.value\)/.test(src), true)
  eq('the role gate is the lib\'s', src.includes('canSeeDriverInstructions(auth.user?.role)'), true)
  eq('nothing is fetched for another role or a closed panel', /if \(!canSee\.value \|\| !props\.open \|\| !id\) return/.test(src), true)
  eq('every error goes through instructionsError(): each catch calls fail(), which reads only its answer',
    [
      src.includes('const view = instructionsError(e)'),
      (src.match(/catch \(e\) \{/g) || []).length > 0 && (src.match(/catch \(e\) \{/g) || []).length === (src.match(/^\s+fail\(e\)$/gm) || []).length,
      /\b(e|err|error)\.(message|data|status|code)\b/.test(src),
    ], [true, true, false])
  eq('the refusal\'s field is never rendered raw', /\.field\b/.test(src), false)
  eq('Mark reviewed, Accept / Keep, Re-read and Save use the routes',
    [
      /api\.post\(instructionsUrl\(id, 'review'\), \{\}\)/.test(src),
      /api\.post\(instructionsUrl\(id, 'accept-pending'\), \{ action \}\)/.test(src),
      /api\.post\(instructionsUrl\(id, 're-extract'\), \{\}, \{ timeout: REREAD_TIMEOUT_MS \}\)/.test(src),
      /api\.put\(instructionsUrl\(id\), editBody\(draft\.value\)\)/.test(src),
    ], [true, true, true, true])
  eq('the buttons are there', ['>Edit<', '>Mark reviewed<', '>Accept the new rate con<', '>Keep current<', '>Re-read the rate con<'].map((b) => src.includes(b)), [true, true, true, true, true])
  eq('the preview is the server\'s driverPreview', src.includes('body.driverPreview'), true)
  eq('messages are announced', /role="alert"/.test(src) && /role="status"/.test(src), true)
  {
    const form = (src.match(/<form v-if="editing && draft"[\s\S]*?<\/form>/) || [''])[0]
    eq('while editing, a refusal shows beside Save (and not at the top as well)',
      [/<p v-if="errorText" role="alert"[^>]*data-testid="di-error"/.test(form), /<p v-if="errorText && !editing" role="alert"/.test(src)], [true, true])
  }
  eq('one pane below md (the side-by-side is two columns only from md)', src.includes('md:grid-cols-2'), true)
  const dash = path.join(ROOT, 'client', 'src', 'components', 'dashboard')
  const active = fs.readFileSync(path.join(dash, 'ActiveLoadsTab.vue'), 'utf8')
  const board = fs.readFileSync(path.join(dash, 'JobBoardTab.vue'), 'utf8')
  for (const [name, tab] of [['ActiveLoadsTab.vue', active], ['JobBoardTab.vue', board]]) {
    eq(`${name}: imports the section`, tab.includes("import DriverInstructionsSection from './DriverInstructionsSection.vue'"), true)
    eq(`${name}: renders it once in the load detail, for the open load`, (tab.match(/<DriverInstructionsSection :load-id="loadIdValue" :open="!!selectedJob" @changed="onInstructionsChanged" \/>/g) || []).length, 1)
  }
  eq('ActiveLoadsTab.vue: beside LoadHaulSection', /<LoadHaulSection[^\n]*\/>\s*\n\s*<\/div>\s*\n\s*<DriverInstructionsSection /.test(active), true)
  eq('M1 a reference\'s kind changes through setReferenceType()', /<select :value="ref\.type"[^>]*@change="setReferenceType\(ref, \$event\.target\.value\)"/.test(src) && !/v-model="ref\.type"/.test(src), true)
  eq('every draft item\'s note is draftItemNote()\'s', (src.match(/draftItemNote\((r|x)\)/g) || []).length >= 6 && !/Remove it or reword it before saving/.test(src), true)
  eq('Save and Mark reviewed say when items stay hidden', src.includes("doneText('Saved.', answer)") && src.includes("doneText('Marked reviewed.', answer)"), true)
  eq('a successful write emits changed', /const emit = defineEmits\(\['changed'\]\)/.test(src) && /noticeText\.value = done\(answer\)\s*\n\s*emit\('changed'\)/.test(src), true)
  eq('a failed first read offers Try again', /<Button v-if="!body && errorText && !loading"[^>]*@click="load"[^>]*>Try again<\/Button>/.test(src), true)
  eq('the section keeps a gap above it', /\.di-section \{ margin: 1rem 0; \}/.test(src), true)
  for (const [name, tab] of [['ActiveLoadsTab.vue', active], ['JobBoardTab.vue', board]]) {
    eq(`${name}: a change refreshes the dashboard and the open load's codes`,
      tab.includes('<DriverInstructionsSection :load-id="loadIdValue" :open="!!selectedJob" @changed="onInstructionsChanged" />') &&
      /async function onInstructionsChanged\(\) \{\s*\n\s*try \{ await dashStore\.refresh\(\) \} catch \{[^}]*\}\s*\n\s*await nextTick\(\)\s*\n\s*const codes = freshInstructionCodes\(selectedJob\.value, props\.jobs\)/.test(tab), true)
  }
}

done()
