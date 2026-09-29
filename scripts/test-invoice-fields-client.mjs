#!/usr/bin/env node
// The invoice draft editor's Order # rule and Notes limit — the CLIENT's copy.
//
// WHY THIS EXISTS. parseInvoiceOverrides() in server.js judges every body the
// invoice editor sends. InvoiceDraftPreviewModal.vue checks the same fields
// earlier, with client/src/lib/invoiceFields.js, so a field can say why it is
// wrong before a render is spent on a body the server would refuse. Two copies
// of one rule drift apart unless something holds them together; this runner is
// that something.
//
//   §1 the client rule: the agreed pattern, limits and messages, and the
//      verdict on a fixed case table — including the hidden-character message
//      and the NFC normalization the server applies first
//   §2 PARITY — server.js's INVOICE_ORDER_RE, lifted from the source: same
//      pattern source and flags, same verdict on every case; and anything the
//      editor lets through, the server's own clean-up + pattern accepts
//   §3 notesError(): the 500-character ceiling, counted on the NFC form, and
//      never looser than the server's own count
//   §4 the modal's wiring — Order # uses the shared rule and PO # keeps its own;
//      the request body ALWAYS carries `notes`; Reset empties them; a note
//      carried over from the last approved draft says so until it is touched
//   §5 the approve's outcome — the modal passes `preview` on, and the load
//      dialog never says "Draft ready in Gmail" when no draft was created
//   §6 DISCRIMINATION — defang each piece, require an assertion to flip
//
// No network, no DOM, no database, no Vue runtime (the modal's functions are
// lifted from the SFC and run over minimal stand-ins).
//
//   node scripts/test-invoice-fields-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const LIB_PATH = path.join(ROOT, 'client', 'src', 'lib', 'invoiceFields.js')

const {
  ORDER_NUMBER_RE, ORDER_NUMBER_MAX, ORDER_NUMBER_HINT, ORDER_NUMBER_HIDDEN_CHAR, orderNumberError,
  NOTES_MAX, notesError, notesLength,
} = await import(pathToFileURL(LIB_PATH).href)

let pass = 0
let fail = 0
function ok(label, cond) {
  if (cond) pass++
  else { fail++; console.error(`FAIL  ${label}`) }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else { fail++; console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`) }
}
// Every invisible or control character is built from its code point — never
// typed, so no editor or tool can turn it into something else on the way in.
const cp = (...codes) => String.fromCodePoint(...codes)
const TAB = cp(0x09)
const LINE_SEP = cp(0x2028)
const ZWSP = cp(0x200b)
const SOFT_HYPHEN = cp(0xad)
const NEL = cp(0x85)
const BOM = cp(0xfeff)
const RLO = cp(0x202e)
const PRIVATE_USE = cp(0xe000)
// e + COMBINING ACUTE: one character after NFC (U+00E9), two before it.
const E_ACUTE_DECOMPOSED = 'e' + cp(0x301)
// DEVANAGARI QA: one character that NFC turns into TWO (U+0915 U+093C) — it is
// a composition exclusion, so normalizing can LENGTHEN a value.
const QA = cp(0x958)
// Seeded, so a failure reproduces exactly.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// A value as a readable label: anything outside printable ASCII as <U+XXXX>.
const show = (v) => {
  const s = v.length > 24 ? v.slice(0, 12) + '...' : v
  const label = JSON.stringify(s.replace(/[^\x20-\x7e]/gu,
    (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`))
  return v.length > 24 ? `${label} (${v.length} chars)` : label
}

// The pattern both sides agreed to (the contract), written out once here.
const CONTRACT_SOURCE = String.raw`^[\p{L}\p{N}][^\p{C}\p{Zl}\p{Zp}<>]{0,79}$`
const CONTRACT_FLAGS = 'u'
const REQUIRED_MSG = 'An order number is required — it names the invoice attachment.'
const HIDDEN_MSG = "Remove the hidden character (a tab or line break from a paste) — it can't print on the invoice."

// [value, accepted?]. Shared by §1 and §2.
const CASES = [
  // accepted
  ['7101850-$700 ADV', true],
  ["A (ADV): 50% + fee & 'tax' @ dock", true],
  ['Caf' + cp(0xe9) + ' 12', true],
  ['SHP2607-A3BJ112', true],
  ['PO # 4471', true],
  ['A' + 'b'.repeat(79), true], // exactly 80
  // refused
  ['', false],
  ['   ', false],
  ['a<b', false],
  ['a>b', false],
  ['-500', false],
  ['$700', false],
  ['#1', false],
  ['=1+1', false],
  ['A' + 'b'.repeat(80), false], // 81
  ['a' + LINE_SEP + 'b', false],
  ['a' + TAB + 'b', false],
  [ZWSP, false],
  // Appended, so the indexed length checks above keep their cases.
  ['Caf' + E_ACUTE_DECOMPOSED + ' 12', true],                  // the same value as 'Café 12' once NFC'd
  ['A' + E_ACUTE_DECOMPOSED.repeat(79), true],                 // 159 characters raw, 80 after NFC
  [QA.repeat(40), true],                                       // 40 raw, 80 after NFC
  [QA.repeat(41), false],                                      // 41 raw, 82 after NFC
  ['SHP' + SOFT_HYPHEN + '2607', false],
  ['a' + NEL + 'b', false],
  ['a' + BOM + 'b', false],
  ['a' + RLO + 'b', false],
  ['A' + PRIVATE_USE, false],
]

// ══ §1 — the client rule ═══════════════════════════════════════════════════════
console.log('\n§1  client/src/lib/invoiceFields.js — the agreed rule')
eq('ORDER_NUMBER_RE source is the contract pattern', ORDER_NUMBER_RE.source, CONTRACT_SOURCE)
eq('ORDER_NUMBER_RE flags are the contract flags', ORDER_NUMBER_RE.flags, CONTRACT_FLAGS)
eq('ORDER_NUMBER_MAX is 80', ORDER_NUMBER_MAX, 80)
eq('ORDER_NUMBER_HINT wording', ORDER_NUMBER_HINT, 'Must start with a letter or number — any characters except < and >, 80 max.')
eq('NOTES_MAX is 500', NOTES_MAX, 500)
eq('the 80-character case really is 80 characters', CASES[5][0].length, 80)
eq('the 81-character case really is 81 characters', CASES[14][0].length, 81)
for (const [v, accepted] of CASES) {
  const err = orderNumberError(v)
  if (accepted) eq(`accepts ${show(v)}`, err, '')
  else ok(`refuses ${show(v)}`, err !== '')
}
eq('blank → the "required" message', orderNumberError(''), REQUIRED_MSG)
eq('whitespace only → the "required" message (trimmed first)', orderNumberError('   '), REQUIRED_MSG)
eq('null / undefined → the "required" message', [orderNumberError(null), orderNumberError(undefined)], [REQUIRED_MSG, REQUIRED_MSG])
eq('a bad character → the hint', orderNumberError('a<b'), ORDER_NUMBER_HINT)
eq('81 characters → the hint', orderNumberError('A' + 'b'.repeat(80)), ORDER_NUMBER_HINT)
eq('surrounding spaces are trimmed before the check', orderNumberError('  7101850-$700 ADV  '), '')

// Hidden characters: the specific sentence, not the generic hint over a value
// that looks fine in the field.
eq('ORDER_NUMBER_HIDDEN_CHAR wording', ORDER_NUMBER_HIDDEN_CHAR, HIDDEN_MSG)
for (const [label, v] of [
  ['a tab pasted from a spreadsheet cell', '7101850' + TAB + 'ADV'],
  ['a line break (U+2028)', '7101850' + LINE_SEP + 'ADV'],
  ['a line feed', '7101850' + cp(0x0a) + 'ADV'],
  ['a soft hyphen', 'SHP' + SOFT_HYPHEN + '2607'],
  ['a zero-width space', '7101850' + ZWSP + 'ADV'],
  ['a zero-width space alone (trim leaves it)', ZWSP],
  ['a NEL control', 'a' + NEL + 'b'],
  ['a byte-order mark mid-value', 'a' + BOM + 'b'],
  ['a bidi override', 'a' + RLO + 'b'],
]) eq(`${label} → the hidden-character message`, orderNumberError(v), HIDDEN_MSG)
eq('a trailing tab is trimmed, not reported (it never reaches the invoice)', orderNumberError('7101850' + TAB), '')
eq('a private-use character is not a "hidden character" — the generic hint', orderNumberError('A' + PRIVATE_USE), ORDER_NUMBER_HINT)
eq('< still gets the generic hint', orderNumberError('a<b'), ORDER_NUMBER_HINT)

// NFC before the check, as the server does.
eq('a decomposed accent is judged as the server sees it: 159 raw characters, 80 after NFC → accepted',
  orderNumberError('A' + E_ACUTE_DECOMPOSED.repeat(79)), '')
eq('a character NFC lengthens is counted after NFC: 41 × U+0958 is 82 → the hint', orderNumberError(QA.repeat(41)), ORDER_NUMBER_HINT)
eq('…and 40 × U+0958 (80 after NFC) is accepted', orderNumberError(QA.repeat(40)), '')

// ══ §2 — PARITY with server.js ═════════════════════════════════════════════════
console.log('\n§2  PARITY — server.js INVOICE_ORDER_RE')
const SERVER_SRC = read('server.js')

// A one-line `const NAME = …;`, anchored on a newline and counted, so a mention
// in a comment cannot be taken for the definition and a second copy fails the
// run instead of lifting either.
function liftConstLine(src, head) {
  const needle = `\n${head}`
  const hits = src.split(needle).length - 1
  if (hits !== 1) throw new Error(`expected exactly 1 line starting ${JSON.stringify(head)} in server.js, found ${hits}`)
  const a = src.indexOf(needle) + 1
  return src.slice(a, src.indexOf('\n', a))
}
function liftServerFunction(src, name) {
  const needle = `\nfunction ${name}(`
  const hits = src.split(needle).length - 1
  if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`)
  const a = src.indexOf(needle) + 1
  return src.slice(a, src.indexOf('\n}\n', a) + 2)
}

let SERVER_ORDER_RE = null
try {
  const line = liftConstLine(SERVER_SRC, 'const INVOICE_ORDER_RE = ')
  SERVER_ORDER_RE = new Function(`"use strict";\n${line}\nreturn INVOICE_ORDER_RE;`)()
} catch (e) {
  console.error(`      ${e.message} — the server half of this rule is not on this branch`)
}
ok('server.js defines INVOICE_ORDER_RE exactly once, as a RegExp', SERVER_ORDER_RE instanceof RegExp)
if (SERVER_ORDER_RE) {
  eq('same pattern source as server.js', ORDER_NUMBER_RE.source, SERVER_ORDER_RE.source)
  eq('same flags as server.js', ORDER_NUMBER_RE.flags, SERVER_ORDER_RE.flags)
  eq('the same verdict on every case in the table',
    CASES.filter(([v]) => ORDER_NUMBER_RE.test(v) !== SERVER_ORDER_RE.test(v)).map(([v]) => show(v)), [])

  // The server cleans a value (sanitizeEvidenceText: NFC, control/bidi → space,
  // trim) before its pattern judges it; the editor trims. Restated from the
  // contract: `v = sanitizeEvidenceText(raw, INVOICE_FIELD_SCAN_MAX)`, refused
  // when `!v || !INVOICE_ORDER_RE.test(v)`. The editor may be STRICTER (it
  // refuses a tab the server would turn into a space) but never looser: a value
  // it lets through must not come back as a 400 after the preview.
  const serverAccepts = new Function(`"use strict";\n${[
    liftConstLine(SERVER_SRC, 'const EVIDENCE_TEXT_STRIP = '),
    liftServerFunction(SERVER_SRC, 'sanitizeEvidenceText'),
    liftConstLine(SERVER_SRC, 'const INVOICE_FIELD_SCAN_MAX = '),
    liftConstLine(SERVER_SRC, 'const INVOICE_ORDER_RE = '),
  ].join('\n')}
return (raw) => { const v = sanitizeEvidenceText(raw, INVOICE_FIELD_SCAN_MAX); return !!v && INVOICE_ORDER_RE.test(v); };`)()

  const ALPHABET = [
    'a', 'Z', '0', '7', ' ', ' ', '-', '$', '#', '.', ',', '(', ')', ':', '+', '&', "'", '@', '%', '/', '<', '>', '=',
    TAB, LINE_SEP, ZWSP, cp(0x0a), cp(0x0d), cp(0x85), cp(0xa0), cp(0xad), cp(0x202e), cp(0x2066), cp(0xfeff),
    cp(0xe9), cp(0x301), cp(0x1f69a), QA, SOFT_HYPHEN,
  ]
  const rand = mulberry32(20260929)
  const corpus = CASES.map(([v]) => v)
  for (let n = 0; n < 20000; n++) {
    const len = rand() < 0.05 ? 76 + Math.floor(rand() * 8) : Math.floor(rand() * 24)
    let s = rand() < 0.6 ? 'A' : ''
    for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)]
    corpus.push(s)
  }
  const looser = corpus.filter((v) => orderNumberError(v) === '' && !serverAccepts(v))
  eq(`nothing the editor accepts is refused by the server (${corpus.length} values)`, looser.slice(0, 5).map(show), [])
  ok('(control) the corpus holds values the editor accepts', corpus.some((v) => orderNumberError(v) === ''))

  // Where NFC changes the count, the two must agree BOTH ways — the editor's
  // verdict is the server's. Before the editor normalized, 41 × U+0958 passed
  // here and came back from the server as a 400.
  const NFC_CASES = ['Caf' + E_ACUTE_DECOMPOSED + ' 12', 'A' + E_ACUTE_DECOMPOSED.repeat(79), QA.repeat(40), QA.repeat(41)]
  eq('on every NFC-sensitive case the editor and the server give the same verdict',
    NFC_CASES.filter((v) => (orderNumberError(v) === '') !== serverAccepts(v)).map(show), [])
  ok('(control) the server itself refuses 41 × U+0958 and accepts 40', !serverAccepts(QA.repeat(41)) && serverAccepts(QA.repeat(40)))
}

// ══ §3 — notesError() ══════════════════════════════════════════════════════════
console.log('\n§3  notesError()')
eq('"" is fine', notesError(''), '')
eq('null / undefined are fine', [notesError(null), notesError(undefined)], ['', ''])
eq('500 characters are fine', notesError('n'.repeat(500)), '')
eq('501 characters are refused', notesError('n'.repeat(501)), 'Notes must be 500 characters or fewer.')
eq('line breaks count as characters', notesError('n'.repeat(499) + '\n'), '')
// UTF-16 units, as the textarea's maxlength counts: never looser than the
// server's count of code points.
ok('an astral character counts twice (never looser than the server)', notesError(cp(0x1f69a).repeat(251)) !== '')
// Counted on the NFC form, as the server counts.
eq('notesLength counts the NFC form (a decomposed accent is one)', notesLength(E_ACUTE_DECOMPOSED), 1)
eq('notesLength of null / undefined is 0', [notesLength(null), notesLength(undefined)], [0, 0])
ok('251 × U+0958 (251 raw, 502 after NFC) are refused', notesError(QA.repeat(251)) !== '')
eq('250 × U+0958 (500 after NFC) are fine', notesError(QA.repeat(250)), '')
eq('300 decomposed accents (600 raw, 300 after NFC) are fine', notesError(E_ACUTE_DECOMPOSED.repeat(300)), '')

// The claim in lib/invoiceFields.js, checked against the server's own code: a
// note the editor accepts, parseInvoiceOverrides accepts too.
let serverAcceptsNotes = null
try {
  serverAcceptsNotes = new Function(`"use strict";\n${[
    liftConstLine(SERVER_SRC, 'const EVIDENCE_TEXT_STRIP = '),
    liftConstLine(SERVER_SRC, 'const INVOICE_NOTES_MAX = '),
    liftConstLine(SERVER_SRC, 'const INVOICE_NOTES_SCAN_MAX = '),
    liftServerFunction(SERVER_SRC, 'sanitizeInvoiceNotes'),
  ].join('\n')}
return (raw) => raw.length <= INVOICE_NOTES_SCAN_MAX && Array.from(sanitizeInvoiceNotes(raw, INVOICE_NOTES_SCAN_MAX)).length <= INVOICE_NOTES_MAX;`)()
} catch (e) {
  console.error(`      ${e.message} — the server's notes clean-up is not on this branch`)
}
ok('server.js\'s notes clean-up and limit are lifted', typeof serverAcceptsNotes === 'function')
const notesCorpus = []
if (serverAcceptsNotes) {
  const NOTE_ALPHABET = ['n', ' ', '  ', cp(0x0a), cp(0x0d, 0x0a), TAB, ZWSP, QA, E_ACUTE_DECOMPOSED, cp(0xe9), cp(0x1f69a), cp(0xfb1d)]
  const rand = mulberry32(20260930)
  for (let n = 0; n < 3000; n++) {
    // Around the limit: 470-530 UTF-16 units of raw text.
    const target = 470 + Math.floor(rand() * 60)
    let v = ''
    while (v.length < target) v += NOTE_ALPHABET[Math.floor(rand() * NOTE_ALPHABET.length)]
    notesCorpus.push(v)
  }
  notesCorpus.push(QA.repeat(250), QA.repeat(251), E_ACUTE_DECOMPOSED.repeat(300), cp(0x1f69a).repeat(250))
  const looser = notesCorpus.filter((v) => notesError(v) === '' && !serverAcceptsNotes(v))
  eq(`no note the editor accepts is refused by the server (${notesCorpus.length} notes)`, looser.slice(0, 3).map(show), [])
  ok('(control) the corpus holds notes the editor accepts AND notes it refuses',
    notesCorpus.some((v) => notesError(v) === '') && notesCorpus.some((v) => notesError(v) !== ''))
}

// ══ §4 — the modal's wiring ════════════════════════════════════════════════════
console.log('\n§4  InvoiceDraftPreviewModal.vue')
const MODAL_REL = 'client/src/components/dashboard/InvoiceDraftPreviewModal.vue'
const MODAL = read(MODAL_REL)

// Brace-count `function name(` out of a source text. The first `{` after the
// parameter list's last `)` opens the body.
function liftFn(src, name, { async = false, rel = MODAL_REL } = {}) {
  const needle = `\n${async ? 'async ' : ''}function ${name}(`
  const hits = src.split(needle).length - 1
  if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in ${rel}, found ${hits}`)
  const a = src.indexOf(needle) + 1
  const bodyOpen = src.indexOf(') {', a) + 2
  let depth = 0
  for (let i = bodyOpen; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(a, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}
// One `<tag …>` whose text contains `marker`, read to the first `>` outside quotes.
function tagWith(src, tag, marker) {
  let at = src.indexOf(`<${tag}`)
  while (at >= 0) {
    let quote = ''
    let i = at + tag.length + 1
    for (; i < src.length; i++) {
      const c = src[i]
      if (quote) { if (c === quote) quote = '' } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
    }
    const text = src.slice(at, i + 1)
    if (text.includes(marker)) return text
    at = src.indexOf(`<${tag}`, i)
  }
  return ''
}

ok('imports the shared rule from lib/invoiceFields',
  /import \{[^}]*\borderNumberError\b[^}]*\bnotesError\b[^}]*\} from '\.\.\/\.\.\/lib\/invoiceFields'/.test(MODAL))
ok('does not declare its own copy of the Order # pattern', !/\bconst ORDER_NUMBER_RE\b/.test(MODAL))
ok('the Order # error comes from orderNumberError(form.orderNumber)',
  /const ordErr = orderNumberError\(form\.orderNumber\)\n\s*if \(ordErr\) e\.orderNumber = ordErr/.test(MODAL))
eq('REF_RE judges exactly one value, and it is the PO #',
  [...MODAL.matchAll(/REF_RE\.test\(([^)]*)\)/g)].map((m) => m[1]), ['po'])
ok('PO # keeps its original message', MODAL.includes("if (po && !REF_RE.test(po)) e.poNumber = 'Letters, numbers, spaces and . _ / # - only, 40 max.'"))
ok('the Notes error comes from notesError(form.notes)', /const notesErr = notesError\(form\.notes\)\n\s*if \(notesErr\) e\.notes = notesErr/.test(MODAL))

const orderTag = tagWith(MODAL, 'input', 'id="idp-order"')
ok('the Order # input is found', orderTag !== '')
ok('the Order # input is capped by ORDER_NUMBER_MAX', /:maxlength="ORDER_NUMBER_MAX"/.test(orderTag) && !/\smaxlength="/.test(orderTag))
const poTag = tagWith(MODAL, 'input', 'id="idp-po"')
ok('the PO # input keeps maxlength="40"', /\smaxlength="40"/.test(poTag))
const notesTag = tagWith(MODAL, 'textarea', 'id="idp-notes"')
ok('the Notes textarea is found', notesTag !== '')
ok('…bound to form.notes', notesTag.includes('v-model="form.notes"'))
ok('…capped by NOTES_MAX', /:maxlength="NOTES_MAX"/.test(notesTag))
ok('…re-renders the preview on input like every other field', notesTag.includes('@input="onFieldInput"'))
ok('…disabled while approving', notesTag.includes(':disabled="approving"'))
ok('the Notes field sits after Delivery date and before Subject',
  MODAL.indexOf('id="idp-delivery"') < MODAL.indexOf('id="idp-notes"') && MODAL.indexOf('id="idp-notes"') < MODAL.indexOf('id="idp-subject"'))
ok('imports notesLength from lib/invoiceFields',
  /import \{[^}]*\bnotesLength\b[^}]*\} from '\.\.\/\.\.\/lib\/invoiceFields'/.test(MODAL))
ok('the counter shows notesLength (the count the limit is judged on) against NOTES_MAX',
  MODAL.includes('{{ notesLength(form.notes) }} / {{ NOTES_MAX }}') && !MODAL.includes('{{ form.notes.length }}'))
ok('…and turns amber on the same count', MODAL.includes('const notesNearLimit = computed(() => notesLength(form.notes) >= NOTES_WARN_AT)'))

{
  const line = MODAL.match(/\nconst FIELD_ORDER = (\[[^\n]*\])/)
  const order = line ? JSON.parse(line[1].replace(/'/g, '"')) : []
  eq('FIELD_ORDER lists notes right after deliveryDate, last', order.slice(-2), ['deliveryDate', 'notes'])
}

// buildOverrideBody(), lifted with has() and run over stand-ins.
const BODY_SRC = `${liftFn(MODAL, 'has')}\n${liftFn(MODAL, 'buildOverrideBody')}`
function bodyBuilder(src, notes, dryRunKeys = {}) {
  const form = {
    invoiceId: 'INV-1', invoiceDate: '2026-09-29', orderNumber: '7101850-$700 ADV', total: '3000.00',
    billToName: '', brokerName: '', poNumber: '', deliveryDate: '', notes,
  }
  const edited = { billToName: false, brokerName: false, poNumber: false, deliveryDate: false, notes: false }
  return new Function('pv', 'form', 'recipient', 'edited', 'noPoOnRatecon', 'pinnedIsBison', 'str', `${src}\nreturn buildOverrideBody;`)(
    { value: dryRunKeys }, form, { value: 'ap@example.com' }, { value: edited }, { value: false }, { value: null },
    (v) => (v == null ? '' : String(v)),
  )
}
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const MULTI = 'Line one' + cp(0x0d, 0x0a) + '  Line two  '
for (const forPreview of [true, false]) {
  const which = forPreview ? 'preview' : 'approve'
  const empty = bodyBuilder(BODY_SRC, '')({ forPreview })
  ok(`the ${which} body carries notes even when the box is empty`, hasOwn(empty, 'notes') && empty.notes === '')
  const multi = bodyBuilder(BODY_SRC, MULTI)({ forPreview })
  eq(`the ${which} body carries the note raw (the server normalizes it)`, multi.notes, MULTI)
  eq(`the ${which} body carries the Order # trimmed, unchanged otherwise`,
    bodyBuilder(BODY_SRC, '')({ forPreview }).orderNumber, '7101850-$700 ADV')
}

// resetToExtracted(), run with a seed that carries a note from the last draft.
const RESET_SRC = liftFn(MODAL, 'resetToExtracted')
function runReset(src) {
  const form = { orderNumber: 'typed', notes: 'typed note' }
  const calls = []
  const seeded = { value: {} }
  const seedForm = () => {
    form.orderNumber = 'SEEDED'; form.notes = 'Carried over from the last approved draft'
    seeded.value = { orderNumber: 'SEEDED', notes: 'Carried over from the last approved draft' }
  }
  new Function('seedForm', 'form', 'seeded', 'previewError', 'schedulePreview', `${src}\nreturn resetToExtracted;`)(
    seedForm, form, seeded, { value: 'stale error' }, (opts) => calls.push(opts),
  )()
  return { form, seeded, calls }
}
{
  const { form, seeded, calls } = runReset(RESET_SRC)
  eq('Reset puts the other fields back to the seed', form.orderNumber, 'SEEDED')
  eq('Reset empties Notes, not back to the carried-over note', form.notes, '')
  eq('…and makes empty the Notes baseline, so the box does not read as edited',
    [seeded.value.notes, seeded.value.orderNumber], ['', 'SEEDED'])
  eq('Reset re-renders at once', calls, [{ immediate: true }])
}

// anyEdited: a carried-over note keeps Reset enabled even with nothing edited.
function liftAnyEdited(src) {
  const a = src.indexOf('\nconst anyEdited = computed(')
  if (a < 0) throw new Error('const anyEdited not found')
  return src.slice(a + 1, src.indexOf('\n)\n', a + 1) + 2)
}
const ANY_SRC = liftAnyEdited(MODAL)
const computed = (fn) => ({ get value() { return fn() } })
function anyEdited(src, notes) {
  const noEdits = { billToName: false, total: false, notes: false }
  return new Function('computed', 'isEdited', 'edited', 'form', `${src}\nreturn anyEdited.value;`)(
    computed, { value: false }, { value: noEdits }, { notes },
  )
}
eq('Reset is enabled by a note alone', anyEdited(ANY_SRC, 'Carried over'), true)
eq('…and not by an empty or blank one', [anyEdited(ANY_SRC, ''), anyEdited(ANY_SRC, '   ')], [false, false])

// The carried-over hint: shown while the box still holds the note seeded from
// the last approved draft, gone once it is edited, cleared or Reset.
const CARRIED_TEXT = "Carried over from this load's last approved invoice — clear it or use Reset if it no longer applies."
const carriedTag = tagWith(MODAL, 'p', 'id="idp-notes-carried"')
ok('the carried-over hint is found', carriedTag !== '')
ok('…shown only while notesCarriedOver', /\sv-if="notesCarriedOver"/.test(carriedTag))
{
  const at = MODAL.indexOf(carriedTag)
  ok('…with the agreed sentence', carriedTag !== '' && MODAL.slice(at, MODAL.indexOf('</p>', at)).includes(CARRIED_TEXT))
}
ok('…under the Notes box: after the textarea, before the "Printed on the invoice" hint',
  MODAL.indexOf('id="idp-notes"') < MODAL.indexOf('id="idp-notes-carried"') &&
  MODAL.indexOf('id="idp-notes-carried"') < MODAL.indexOf('id="idp-notes-hint"'))
ok('…and the textarea is described by it while it shows',
  notesTag.includes(`:aria-describedby="notesCarriedOver ? 'idp-notes-carried idp-notes-count idp-notes-hint' : 'idp-notes-count idp-notes-hint'"`))

// `const NAME = computed(` as source: the line itself for a one-liner, otherwise
// through the first later line that is exactly `)` or `})`.
function liftComputed(src, name) {
  const needle = `\nconst ${name} = computed(`
  const hits = src.split(needle).length - 1
  if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name} in ${MODAL_REL}, found ${hits}`)
  const lines = src.slice(src.indexOf(needle) + 1).split('\n')
  if (/\)$/.test(lines[0])) return lines[0]
  const end = lines.findIndex((l, i) => i > 0 && /^\}?\)$/.test(l))
  if (end < 0) throw new Error(`no closing line for ${name}`)
  return lines.slice(0, end + 1).join('\n')
}
const EDITED_SRC = liftComputed(MODAL, 'edited')
const CARRIED_SRC = liftComputed(MODAL, 'notesCarriedOver')
// The modal's own `edited` and `notesCarriedOver`, over a plain form and seed.
function carriedOver(carriedSrc, formNotes, seededNotes) {
  const blank = { billToName: '', brokerName: '', total: '', invoiceId: '', invoiceDate: '', orderNumber: '', poNumber: '', deliveryDate: '' }
  return new Function('computed', 'seeded', 'form', 'str', 'moneyValue', `${EDITED_SRC}\n${carriedSrc}\nreturn notesCarriedOver.value;`)(
    computed, { value: { ...blank, notes: seededNotes } }, { ...blank, notes: formNotes },
    (v) => (v == null ? '' : String(v)), (v) => (v ? Number(v) : null),
  )
}
const SAVED = 'Advance $700 paid at pickup.'
eq('the hint shows while the box holds the carried-over note untouched', carriedOver(CARRIED_SRC, SAVED, SAVED), true)
eq('…and while only surrounding whitespace differs (not an edit)', carriedOver(CARRIED_SRC, `  ${SAVED}  `, SAVED), true)
eq('…is gone once the note is typed into', carriedOver(CARRIED_SRC, `${SAVED} x`, SAVED), false)
eq('…is gone once the box is cleared', carriedOver(CARRIED_SRC, '', SAVED), false)
eq('…never shows when nothing was carried over',
  [carriedOver(CARRIED_SRC, '', ''), carriedOver(CARRIED_SRC, 'typed', ''), carriedOver(CARRIED_SRC, '', '   ')], [false, false, false])
{
  // Reset, run for real above: it empties the seed as well, so the hint stays gone.
  const { form, seeded } = runReset(RESET_SRC)
  eq('…and is gone after Reset', carriedOver(CARRIED_SRC, form.notes, seeded.value.notes), false)
}

// ══ §5 — the approve's outcome ═════════════════════════════════════════════════
console.log('\n§5  the approve → the load dialog\'s message')
const TAB_REL = 'client/src/components/dashboard/CompletedLoadsTab.vue'
const TAB_SRC = read(TAB_REL)

// The modal's approve(), run over stand-ins with a canned server answer.
const APPROVE_SRC = liftFn(MODAL, 'approve', { async: true })
async function runApprove(src, response) {
  const emitted = []
  const approve = new Function(
    'approving', 'canApprove', 'props', 'window', 'edited', 'approveError', 'buildOverrideBody', 'api', 'APPROVE_TIMEOUT_MS',
    'emit', 'recipient', 'originalTo', 'str', 'totalChangeConfirm', 'DUPLICATE_APPROVE_MSG',
    `${src}\nreturn approve;`,
  )(
    { value: false }, { value: true }, { alreadyDrafted: false, loadId: 'L-1' }, { confirm: () => true }, { value: { total: false } },
    { value: '' }, () => ({}), { post: async () => response }, 60000,
    (name, payload) => emitted.push([name, payload]), { value: 'ap@example.com' }, { value: 'ap@example.com' },
    (v) => (v == null ? '' : String(v)), () => '', '',
  )
  await approve()
  return (emitted.find(([n]) => n === 'approved') || [])[1] || null
}
const NO_MAIL = {
  success: true, preview: true, invoiceId: 'INV-9', invoicePdfBase64: 'x',
  note: 'No Gmail/n8n draft target configured — invoice generated (preview only).', warnings: [],
}
const COLLISION = "Invoice # INV-9 is already recorded on another load's draft."
const IMAP_OK = { success: true, invoiceId: 'INV-9', via: 'imap', draftMailbox: '[Gmail]/Drafts', warnings: [] }
{
  const p = await runApprove(APPROVE_SRC, NO_MAIL)
  eq('a no-mail-target answer is emitted as preview: true, with the server\'s note', [p?.preview, p?.note, p?.invoiceId], [true, NO_MAIL.note, 'INV-9'])
  const q = await runApprove(APPROVE_SRC, { ...IMAP_OK, warnings: [COLLISION, ''] })
  eq('a real draft is emitted as preview: false, with its warnings (blanks dropped)', [q?.preview, q?.warnings], [false, [COLLISION]])
  const r = await runApprove(APPROVE_SRC, { ...IMAP_OK, preview: 'true' })
  eq('preview is strict: only a real true counts', r?.preview, false)
  const w = await runApprove(APPROVE_SRC, { success: true, invoiceId: 'INV-9' })
  eq('an answer with no warnings key is emitted with none', w?.warnings, [])
}

// CompletedLoadsTab's onDraftApproved(), run over stand-ins.
const ON_APPROVED_SRC = liftFn(TAB_SRC, 'onDraftApproved', { async: true, rel: TAB_REL })
async function runOnApproved(src, payload) {
  const gets = []
  const previewOpen = { value: true }
  const draftResult = { value: null }
  const approvedDraft = { value: 'before' }
  const fn = new Function('previewOpen', 'draftResult', 'loadIdValue', 'auth', 'api', 'approvedDraft', `${src}\nreturn onDraftApproved;`)(
    previewOpen, draftResult, { value: 'L-1' }, { isSuperAdmin: true },
    { get: async (u) => { gets.push(u); return { draft: null } } }, approvedDraft,
  )
  await fn(payload)
  return { result: draftResult.value, gets, previewOpen: previewOpen.value, approvedDraft: approvedDraft.value }
}
{
  const a = await runOnApproved(ON_APPROVED_SRC, await runApprove(APPROVE_SRC, NO_MAIL))
  ok('no draft created: the message does NOT say "Draft ready in Gmail"', !/Draft ready in Gmail/.test(a.result?.msg || ''))
  eq('…it says the invoice was generated and no Gmail draft was created',
    a.result?.msg, 'Invoice INV-9 was generated, but no Gmail draft was created — this server has no mail account configured.')
  eq('…in amber', a.result?.tone, 'warn')
  eq('…the preview closes and the approved-draft line is still re-read (and finds none)',
    [a.previewOpen, a.gets, a.approvedDraft], [false, ['/api/loads/L-1/invoice-draft'], null])
  const b = await runOnApproved(ON_APPROVED_SRC, await runApprove(APPROVE_SRC, IMAP_OK))
  eq('a real draft keeps the success message, in green',
    [b.result?.tone, b.result?.msg], ['ok', '✓ Draft ready in Gmail (invoice INV-9). Verify the details, then send.'])
  const c = await runOnApproved(ON_APPROVED_SRC, await runApprove(APPROVE_SRC, { ...IMAP_OK, warnings: [COLLISION] }))
  eq('a real draft with a warning: the success message, amber, the warning carried to the dialog',
    [c.result?.tone, /Draft ready in Gmail/.test(c.result?.msg || ''), c.result?.warnings], ['warn', true, [COLLISION]])
}
const resultTag = tagWith(TAB_SRC, 'div', 'v-if="draftResult"')
ok('the dialog\'s message has class="draft-result" (the e2e harness reads it) and a live-region role',
  /\sclass="draft-result"/.test(resultTag) && resultTag.includes(`:role="draftResult.tone === 'error' ? 'alert' : 'status'"`))
ok('…and lists the warnings under the message', TAB_SRC.includes('<span v-for="w in draftResult.warnings || []" :key="w"'))
ok('the message is styled by tone (ok / warn / error), and a failed preview is an error',
  /\nconst DRAFT_TONES = \{\n  ok: \{[^\n]*\},\n  warn: \{[^\n]*\},\n  error: \{[^\n]*\},\n\}/.test(TAB_SRC) &&
  TAB_SRC.includes("draftResult.value = { tone: 'error', msg }") && !/draftResult\.value\s*=\s*\{\s*ok:/.test(TAB_SRC))

// ══ §6 — DISCRIMINATION ════════════════════════════════════════════════════════
console.log('\n§6  DISCRIMINATION — defang each piece, require an assertion to flip')
{
  const refLine = MODAL.match(/\nconst REF_RE = (\/[^\n]+\/)\n/)
  const OLD_REF_RE = refLine ? new Function(`return ${refLine[1]}`)() : null
  ok('MUTANT: the PO # rule (the old Order # rule) refuses "7101850-$700 ADV", the new rule accepts it',
    OLD_REF_RE instanceof RegExp && !OLD_REF_RE.test('7101850-$700 ADV') && orderNumberError('7101850-$700 ADV') === '')
}
{
  const LIB_SRC = fs.readFileSync(LIB_PATH, 'utf8')
  const drifted = LIB_SRC.replace('<>]{0,79}$/u', '<>]{0,99}$/u')
  const mod = await import('data:text/javascript,' + encodeURIComponent(drifted))
  ok('MUTANT: a client pattern 20 characters longer than the contract is caught by §1/§2',
    drifted !== LIB_SRC && mod.ORDER_NUMBER_RE.source !== CONTRACT_SOURCE &&
    (!SERVER_ORDER_RE || mod.ORDER_NUMBER_RE.source !== SERVER_ORDER_RE.source) &&
    mod.orderNumberError('A' + 'b'.repeat(80)) === '')
}
{
  const MUT = BODY_SRC.replace(/\n\s*notes: form\.notes,/, '\n  }\n  if (form.notes) {\n    body.notes = form.notes')
  const b = bodyBuilder(MUT, '')({ forPreview: false })
  ok('MUTANT: a body that sends notes only when non-empty is caught by §4',
    MUT !== BODY_SRC && !hasOwn(b, 'notes'))
}
{
  const MUT = RESET_SRC.replace(/\n\s*form\.notes = ''/, '')
  ok('MUTANT: a Reset that restores the carried-over note is caught by §4',
    MUT !== RESET_SRC && runReset(MUT).form.notes !== '')
}
{
  const MUT = ANY_SRC.replace(' || !!form.notes.trim()', '')
  ok('MUTANT: a Reset disabled over a carried-over note is caught by §4',
    MUT !== ANY_SRC && anyEdited(MUT, 'Carried over') === false)
}

{
  const LIB_SRC = fs.readFileSync(LIB_PATH, 'utf8')
  const load = (src) => import('data:text/javascript,' + encodeURIComponent(src))
  const noNfc = LIB_SRC.replace("const n = v.normalize('NFC')", 'const n = v')
  const m1 = await load(noNfc)
  ok('MUTANT: an Order # judged without NFC is caught by §1 (41 × U+0958 passes the editor; 82 on the server)',
    noNfc !== LIB_SRC && m1.orderNumberError(QA.repeat(41)) === '')
  const noHidden = LIB_SRC.replace('  if (HIDDEN_CHAR_RE.test(n)) return ORDER_NUMBER_HIDDEN_CHAR\n', '')
  const m2 = await load(noHidden)
  ok('MUTANT: without the hidden-character check a pasted tab gets the generic hint — caught by §1',
    noHidden !== LIB_SRC && m2.orderNumberError('7101850' + TAB + 'ADV') === m2.ORDER_NUMBER_HINT)
  const rawCount = LIB_SRC.replace(".normalize('NFC').length", '.length')
  const m3 = await load(rawCount)
  ok('MUTANT: Notes counted on the raw text is caught by §3 (251 × U+0958 passes the editor, the server refuses it)',
    rawCount !== LIB_SRC && m3.notesError(QA.repeat(251)) === '' && !!serverAcceptsNotes && !serverAcceptsNotes(QA.repeat(251)))
}
{
  const MUT = APPROVE_SRC.replace('      preview: r.preview === true,\n', '')
  const d = await runOnApproved(ON_APPROVED_SRC, await runApprove(MUT, NO_MAIL))
  ok('MUTANT: an approve that drops `preview` is caught by §5 (the dialog says "Draft ready in Gmail" with no draft)',
    MUT !== APPROVE_SRC && /Draft ready in Gmail/.test(d.result?.msg || ''))
}
{
  const MUT = ON_APPROVED_SRC.replace('payload.preview === true', 'false')
  const d = await runOnApproved(MUT, await runApprove(APPROVE_SRC, NO_MAIL))
  ok('MUTANT: a dialog that ignores `preview` is caught by §5',
    MUT !== ON_APPROVED_SRC && /Draft ready in Gmail/.test(d.result?.msg || ''))
}
{
  const MUT = CARRIED_SRC.replace(' && !edited.value.notes', '')
  ok('MUTANT: a carried-over hint that stays after the note is edited is caught by §4',
    MUT !== CARRIED_SRC && carriedOver(MUT, `${SAVED} x`, SAVED) === true)
}

console.log(`\ninvoice-fields-client: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
