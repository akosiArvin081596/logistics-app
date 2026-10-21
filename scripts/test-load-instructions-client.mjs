#!/usr/bin/env node
// Rate-con driver instructions, the driver's screen (plan PR 4, §7): the logic behind
// client/src/components/driver/LoadInstructions.vue and the list chips on LoadCard.vue,
// which lives in client/src/lib/loadInstructions.js.
//
// The server is the gate (lib/driver-instructions-runtime.js): GET
// /api/driver/loads/:loadId/instructions answers 404 while DRIVER_LOAD_INSTRUCTIONS_SCREEN_ENABLED
// (or flag 1, or the deny list) is off, 403 for another driver's load, { state: "checking" }
// while unpublished, and the published, re-filtered payload with its highlight codes;
// GET /api/driver/:driverName carries `_instructions: { state, highlights }` per load, codes
// only. The app only displays what it is sent:
//   - no card at all without the `_instructions` key (the flag off), on a 404 or a 403;
//   - "Load instructions are being checked by dispatch." while unpublished;
//   - chips from the server's codes, in its order; every item the server sent is shown
//     exactly once, in its order (directions and warehouse notes behind "More from the
//     rate con"); the browser never drops, reorders or rewrites content;
//   - a failed refresh keeps the last answer the server gave.
//
//   §1 pinned to the server's lists (lib/driver-instructions.js)
//   §2 the list chips, from the codes
//   §3 the route's answers and errors
//   §4 what the card shows
//   §5 each stop: every item once, nothing reordered
//   §6 the socket event
//   §7 the source: the card, LoadDetail, LoadCard, the store, DriverView
//
// No DOM, no server, no build.
//   node scripts/test-load-instructions-client.mjs      # exits 1 on any failure
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB = path.join(ROOT, 'client', 'src', 'lib', 'loadInstructions.js')
const DRIVER = path.join(ROOT, 'client', 'src', 'components', 'driver')
const CARD = path.join(DRIVER, 'LoadInstructions.vue')

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
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')

if (!fs.existsSync(LIB)) {
  eq('client/src/lib/loadInstructions.js exists', false, true)
  eq('LoadInstructions.vue exists', fs.existsSync(CARD), true)
  done()
}
const v = await import(pathToFileURL(LIB).href)
const server = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'driver-instructions.js'))

// Made-up payload, as the route serves it (already filtered and ordered by the server).
const PAYLOAD = {
  v: 1,
  loadRequirements: [
    { category: 'high_value', text: 'QA: never leave the trailer unattended.', critical: true },
    { category: 'equipment', text: 'QA: dry van only, clean floor.', critical: false },
  ],
  stops: [
    {
      seq: 1, kind: 'pickup', facility: 'QA Test Shipper', place: 'Memphis, TN',
      references: [{ type: 'pickup_number', label: 'Pickup #', value: 'QA-PU-1001' }, { type: 'line_reference', label: 'Ref #', value: 'QA-0000-000-000000-0000000000-00000000' }],
      requirements: [{ category: 'ppe', text: 'QA: hard hat at the dock.', critical: true }],
      instructions: [
        { kind: 'directions', text: 'QA: take the second gate.' },
        { kind: 'shipper', text: 'QA: check in at the guard shack.' },
        { kind: 'warehouse', text: 'QA: door four after noon.' },
        { kind: 'hours', text: 'QA: open 0700-1500.' },
      ],
    },
    { seq: 2, kind: 'delivery', facility: '', place: 'Dallas, TX', references: [], requirements: [], instructions: [] },
  ],
  footnote: 'From the rate con. Questions: contact dispatch.',
}

// ---------------------------------------------------------------------------
console.log('§1 pinned to the server\'s lists')
// ---------------------------------------------------------------------------
eq('the chip codes are the server\'s critical categories, in its order', v.CHIP_CODES, server.CRITICAL_CATEGORIES)
eq('each chip says the server\'s category label', v.chipsOf(server.CRITICAL_CATEGORIES).map((c) => c.label), server.CRITICAL_CATEGORIES.map((c) => server.CATEGORY_LABELS[c]))
eq('the collapsed kinds are server instruction kinds', v.MORE_KINDS.every((k) => server.INSTRUCTION_KINDS.includes(k)) && v.MORE_KINDS.join() === 'directions,warehouse', true)
eq('the unpublished line, word for word', v.CHECKING_TEXT, 'Load instructions are being checked by dispatch.')
eq('the route, encoded', [v.driverInstructionsUrl('QA 1001/x'), v.driverInstructionsUrl('#QA-1'), v.driverInstructionsUrl(null)],
  ['/api/driver/loads/QA%201001%2Fx/instructions', '/api/driver/loads/%23QA-1/instructions', '/api/driver/loads//instructions'])
eq('the load key the server uses (trim, lower case, no leading #)', [v.instructionsKey(' #QA-DI-1 '), v.instructionsKey('qa-di-1'), v.instructionsKey(null)], ['qa-di-1', 'qa-di-1', ''])

// ---------------------------------------------------------------------------
console.log('§2 the list chips, from the codes')
// ---------------------------------------------------------------------------
const load = (summary) => ({ 'Load ID': 'QA-DI-1', ...(summary === undefined ? {} : { _instructions: summary }) })
eq('published: one chip per code, in the server\'s order', v.listChips(load({ state: 'published', highlights: ['seal', 'high_value', 'ppe'] })).map((c) => [c.code, c.label]),
  [['seal', 'Seal'], ['high_value', 'High value'], ['ppe', 'PPE']])
eq('a code the app has no chip for is not shown (never a made-up label)', v.listChips(load({ state: 'published', highlights: ['high_value', 'tracking', 7, null] })).map((c) => c.code), ['high_value'])
eq('checking, none, no key, or no list: no chips', [
  v.listChips(load({ state: 'checking', highlights: ['high_value'] })),
  v.listChips(load({ state: 'none', highlights: [] })),
  v.listChips(load(undefined)),
  v.listChips(load({ state: 'published', highlights: 'high_value' })),
  v.listChips(null),
], [[], [], [], [], []])

// ---------------------------------------------------------------------------
console.log('§3 the route\'s answers and errors')
// ---------------------------------------------------------------------------
{
  const pub = v.answerOf({ state: 'published', highlights: ['high_value', 'ppe'], payload: PAYLOAD })
  eq('published: the payload exactly as sent', pub.payload, PAYLOAD)
  eq('published: the highlight codes as sent', pub.highlights, ['high_value', 'ppe'])
  eq('checking', v.answerOf({ state: 'checking' }), { state: 'checking', highlights: [], payload: null })
  eq('none, an unknown state, or a published answer with no payload: none', [v.answerOf({ state: 'none' }), v.answerOf({ state: 'later' }), v.answerOf({ state: 'published' }), v.answerOf(null)].map((a) => a.state), ['none', 'none', 'none', 'none'])
  const err = (status, code = '') => Object.assign(new Error('x'), { status, code })
  const first = v.entryAfter(null, { body: { state: 'published', highlights: [], payload: PAYLOAD } })
  eq('a good answer', [first.answer.state, first.loading, first.failed, first.gone], ['published', false, false, false])
  eq('loading keeps the last answer on screen', [v.entryLoading(first).answer.state, v.entryLoading(first).loading], ['published', true])
  eq('404 (the flag off) and 403 (not his load): gone, nothing kept', [v.entryAfter(first, { error: err(404) }), v.entryAfter(first, { error: err(403) })].map((e) => [e.gone, e.answer]), [[true, null], [true, null]])
  const lost = v.entryAfter(first, { error: err(503, 'INSTRUCTIONS_UNVERIFIED') })
  eq('503 or no answer: failed, the last answer kept', [lost.failed, lost.answer && lost.answer.state, v.entryAfter(null, { error: new Error('offline') }).failed, v.entryAfter(null, { error: new Error('offline') }).answer], [true, 'published', true, null])
  eq('503 LOAD_OWNERSHIP_UNVERIFIED is a retry, not gone', v.entryAfter(null, { error: err(503, 'LOAD_OWNERSHIP_UNVERIFIED') }).gone, false)
}

// ---------------------------------------------------------------------------
console.log('§4 what the card shows')
// ---------------------------------------------------------------------------
{
  const pubEntry = v.entryAfter(null, { body: { state: 'published', highlights: [], payload: PAYLOAD } })
  const checking = v.entryAfter(null, { body: { state: 'checking' } })
  const none = v.entryAfter(null, { body: { state: 'none' } })
  const gone = v.entryAfter(null, { error: Object.assign(new Error('x'), { status: 404 }) })
  const failed = v.entryAfter(null, { error: new Error('offline') })
  const stale = v.entryAfter(pubEntry, { error: new Error('offline') })
  const S = (state) => ({ state, highlights: [] })
  eq('the card for each case', [
    v.cardView(undefined, pubEntry),
    v.cardView(S('published'), undefined),
    v.cardView(S('none'), undefined),
    v.cardView(S('checking'), checking),
    v.cardView(S('published'), pubEntry),
    v.cardView(S('published'), none),
    v.cardView(S('published'), gone),
    v.cardView(S('published'), failed),
    v.cardView(S('published'), stale),
    v.cardView(S('published'), v.entryLoading(pubEntry)),
  ].map((c) => c.kind + (c.stale ? '+stale' : '')), ['hidden', 'loading', 'hidden', 'checking', 'card', 'hidden', 'hidden', 'error', 'card+stale', 'card'])
  eq('a load is fetched when it has the key and the server has something for it', [v.shouldFetch(undefined), v.shouldFetch(S('none')), v.shouldFetch(S('checking')), v.shouldFetch(S('published'))], [false, false, true, true])
}

// ---------------------------------------------------------------------------
console.log('§5 each stop: every item once, nothing reordered')
// ---------------------------------------------------------------------------
{
  const parts = v.stopParts(PAYLOAD.stops[0])
  eq('instructions shown on the card, in order', parts.instructions.map((x) => x.kind), ['shipper', 'hours'])
  eq('directions and warehouse notes behind "More from the rate con", in order', parts.more.map((x) => x.kind), ['directions', 'warehouse'])
  eq('every instruction exactly once, untouched', [...parts.instructions, ...parts.more].map((x) => x.text).sort(), PAYLOAD.stops[0].instructions.map((x) => x.text).sort())
  eq('references and requirements as sent (same objects, same order)', [parts.references === PAYLOAD.stops[0].references, parts.requirements === PAYLOAD.stops[0].requirements], [true, true])
  eq('an empty or odd stop', v.stopParts({ kind: 'delivery' }), { references: [], requirements: [], instructions: [], more: [] })
  eq('the "more" label', v.MORE_LABEL, 'More from the rate con (directions, warehouse notes)')
}

// ---------------------------------------------------------------------------
console.log('§6 the socket event')
// ---------------------------------------------------------------------------
eq('driver-instructions-changed carries { loadId } only', [
  v.isInstructionsEvent({ loadId: 'QA-DI-1' }), v.isInstructionsEvent({ loadId: '' }), v.isInstructionsEvent({ loadId: 5 }),
  v.isInstructionsEvent(null), v.isInstructionsEvent({ loadId: 'x'.repeat(81) }),
], [true, false, false, false, false])

// ---------------------------------------------------------------------------
console.log('§7 the source')
// ---------------------------------------------------------------------------
{
  const card = read(CARD)
  const detail = read(path.join(DRIVER, 'LoadDetail.vue'))
  const listCard = read(path.join(DRIVER, 'LoadCard.vue'))
  const store = read(path.join(ROOT, 'client', 'src', 'stores', 'driver.js'))
  const view = read(path.join(ROOT, 'client', 'src', 'views', 'DriverView.vue'))
  const script = (src) => (src.match(/<script setup>[\s\S]*?<\/script>/) || [''])[0]
  eq('LoadInstructions.vue exists', !!card, true)
  eq('no v-html in the card, the load detail or the list card', [/v-html/.test(card), /v-html/.test(detail), /v-html/.test(listCard)], [false, false, false])
  eq('no link or markup built from the text (no innerHTML, no href from an item)', /innerHTML|:href=/.test(card), false)
  eq('the card neither filters nor sorts (its script has no .filter( or .sort()', /\.filter\(|\.sort\(/.test(script(card)), false)
  eq('the card is the lib\'s: cardView, stopParts, chipsOf and the checking line', ['cardView(', 'stopParts(', 'chipsOf(', 'CHECKING_TEXT'].map((s) => card.includes(s)), [true, true, true, true])
  eq('it fetches through the store, only when shouldFetch()', /if \(shouldFetch\(props\.summary\)\) driverStore\.fetchLoadInstructions\(props\.loadId\)/.test(card), true)
  eq('the footnote is the payload\'s own', /\{\{ payload\.footnote \}\}/.test(card), true)
  eq('the unpublished line is a status for assistive tech', /role="status"[^>]*>\{\{ CHECKING_TEXT \}\}/.test(card), true)
  eq('reference values: monospace, long values wrap', /\.li-ref-value \{[^}]*font-family: 'JetBrains Mono'[^}]*overflow-wrap: anywhere/.test(card), true)
  eq('copy buttons and the "more" toggle are at least 44 px tall', /\.li-copy \{[^}]*min-height: 44px/.test(card) && /\.li-more > summary \{[^}]*min-height: 44px/.test(card), true)
  eq('each copy button names what it copies', /:aria-label="`Copy \$\{referenceLabel\(ref\)\} \$\{ref\.value\}`"/.test(card), true)
  eq('directions and warehouse notes collapsed per stop (details / summary)', /<details v-if="parts\.more\.length" class="li-more">/.test(card) && card.includes('{{ MORE_LABEL }}'), true)
  {
    const banner = detail.indexOf('class="route-banner"')
    const comp = detail.indexOf('<LoadInstructions')
    const gps = detail.indexOf('class="phone-gps-banner"')
    const collapse = detail.indexOf('<van-collapse ')
    eq('LoadDetail: the card goes directly under the route banner, before the phone-GPS banner and the sections', banner > 0 && comp > banner && comp < gps && comp < collapse, true)
    eq('LoadDetail: only when the load carries the key (the flag on)', /<LoadInstructions v-if="load\._instructions" :load-id="String\(loadId \|\| ''\)" :summary="load\._instructions" \/>/.test(detail), true)
    eq('LoadDetail: imports it', detail.includes("import LoadInstructions from './LoadInstructions.vue'"), true)
  }
  eq('LoadCard: the chips come from listChips(), codes only', listCard.includes("import { listChips } from '../../lib/loadInstructions.js'") && /const chips = computed\(\(\) => listChips\(props\.load\)\)/.test(listCard), true)
  eq('LoadCard: a list with an accessible name', /<ul v-if="chips\.length" class="card-chips" aria-label="Load requirements">/.test(listCard), true)
  eq('the store: one action, the lib\'s URL and answers, and a per-load sequence so a late answer never wins',
    [/async fetchLoadInstructions\(loadId\) \{/.test(store), store.includes('api.get(driverInstructionsUrl(loadId))'), store.includes('entryAfter(prev, { body })'), store.includes('entryAfter(prev, { error })'), /instructionSeq\.get\(key\) !== seq/.test(store)],
    [true, true, true, true, true])
  eq('the store keeps instructions per load key', /instructions: \{\},/.test(store), true)
  eq('DriverView listens to driver-instructions-changed and stops listening on unmount',
    [/socket\.on\('driver-instructions-changed', onInstructionsChanged\)/.test(view), /socket\.off\('driver-instructions-changed', onInstructionsChanged\)/.test(view)], [true, true])
  eq('DriverView: the event re-reads the open load\'s card and refreshes the list (debounced)',
    /function onInstructionsChanged\(payload\) \{\s*\n\s*if \(!isMounted \|\| !isInstructionsEvent\(payload\)\) return\s*\n\s*if \(instructionsKey\(payload\.loadId\) === instructionsKey\(detailLoadId\.value\)\) driverStore\.fetchLoadInstructions\(detailLoadId\.value\)\s*\n\s*scheduleDriverRefetch\(\)\s*\n\s*\}/.test(view), true)
}

done()
