#!/usr/bin/env node
// B20 Phase 1, the CLIENT half: the invoice editor's advance lines.
//
// The server decides every figure. The editor (InvoiceDraftPreviewModal.vue and
// its InvoiceAdvanceLines.vue section) lists the load's advance lines, lets a
// Super Admin add or void one, ticks which ones print, and shows the line haul,
// the advances and the balance due exactly as the server's dryRun / preview
// answered them. It never adds or subtracts money. With the flag off the dryRun
// carries no `invoiceLines`, and the editor shows and sends nothing new.
//
//   §1 the client rules mirror lib/broker-invoice-lines.js: same patterns,
//      limits and sentences, and the same verdict on a shared case table
//   §2 the add form's request body
//   §3 InvoiceAdvanceLines.vue: the two routes it calls, the figures it shows
//      as given, no money arithmetic
//   §4 the modal: the section only when the dryRun carried invoiceLines; the
//      request body unchanged without it (its own buildOverrideBody, run);
//      with it, lineIds always and the footnote only once edited; the total
//      locked to the line haul while a line is ticked
//   §5 who calls the invoice-lines routes, who mounts the section
//   §6 DISCRIMINATION: break each piece, require an assertion to flip
//
// No network, no DOM, no database, no Vue runtime.
//   node scripts/test-invoice-lines-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const rel = (p) => path.join(ROOT, p)
const exists = (p) => fs.existsSync(rel(p))
const read = (p) => fs.readFileSync(rel(p), 'utf8')

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
function section(t) { console.log(`\n${t}`) }
// The component's script may hand money strings around, never compute one:
// no parse, no sum, no scaling, no balance of its own.
function noMoneyArithmetic(script) {
  return !/parseFloat|parseInt|Number\(|\.reduce\(|Math\.|\*\s*100|\/\s*100|Cents\s*[-+*/]|[-+*/]\s*[\w.]*Cents\b|balance\w*\s*=/.test(script)
}
// A missing file fails its section by name instead of stopping the run.
function guard(label, fn) {
  try { fn() } catch (e) { fail++; console.error(`FAIL  ${label}: ${String((e && e.message) || e).split('\n')[0]}`) }
}

const CLIENT_LIB = 'client/src/lib/invoiceLines.js'
const SERVER_LIB = 'lib/broker-invoice-lines.js'
const COMPONENT = 'client/src/components/dashboard/InvoiceAdvanceLines.vue'
const MODAL_REL = 'client/src/components/dashboard/InvoiceDraftPreviewModal.vue'

let C = null
let S = null
if (exists(CLIENT_LIB)) C = await import(pathToFileURL(rel(CLIENT_LIB)).href)
if (exists(SERVER_LIB)) S = createRequire(import.meta.url)(rel(SERVER_LIB))

// ════════════════════════════════════════════════════════════════════════════
section('§1 the client rules mirror lib/broker-invoice-lines.js')
guard('§1', () => {
  if (!C) throw new Error(`${CLIENT_LIB} does not exist yet (the B20 build adds it)`)
  if (!S) throw new Error(`${SERVER_LIB} does not exist yet (the B20 build adds it)`)
  for (const name of ['LINE_LABEL_RE', 'LINE_REFERENCE_RE', 'LINE_AMOUNT_RE']) {
    eq(`${name}: same pattern source and flags`, [C[name].source, C[name].flags], [S[name].source, S[name].flags])
  }
  for (const name of ['LINE_LABEL_MAX', 'LINE_REFERENCE_MAX', 'LINE_NOTE_MAX', 'FOOTNOTE_MAX', 'VOID_REASON_MAX', 'DEFAULT_ADVANCE_LABEL']) {
    eq(`${name}: same value`, C[name], S[name])
  }
  eq('the default label is the owner\'s', C.DEFAULT_ADVANCE_LABEL, 'Fuel advance')
  eq('every sentence the client shows is the server\'s own', C.LINE_MESSAGES, S.LINE_MESSAGES)

  // The verdict table: the client says '' exactly when the server accepts, and
  // otherwise the server's sentence for that field.
  const serverVerdict = (body, field) => {
    const r = S.parseNewLine({ amount: '650', ...body })
    return r.ok ? '' : (r.field === field ? r.error : `(refused on ${r.field})`)
  }
  const CASES = {
    label: ['Fuel advance', 'Comdata advance', 'Advance (EFS) – 50%', 'A'.repeat(80), 'A'.repeat(81), '#advance', '-advance', 'Fuel <advance>', '', '  '],
    amount: ['650', '650.5', '650.05', '$1,200.00', '1,000,000', '1,000,000.01', '0', '0.00', '-650', '12abc34', '1e9', '0.001', '', ' ', '1.'],
    receivedOn: ['', '2026-10-12', '2026-02-29', '2028-02-29', '2026-13-01', '0000-01-14', '10/12/2026', '2101-01-01', '1999-12-31'],
    reference: ['', 'EFS-55501', 'EFS 55501', 'a/b.c_d#1', '-EFS', 'EFS$1', 'E'.repeat(40), 'E'.repeat(41)],
    note: ['', 'Paid at the truck stop', 'x'.repeat(500), 'x'.repeat(501)],
  }
  const clientFn = { label: C.lineLabelError, amount: C.lineAmountError, receivedOn: C.lineDateError, reference: C.lineReferenceError, note: C.lineNoteError }
  for (const [field, values] of Object.entries(CASES)) {
    for (const v of values) {
      const body = field === 'amount' ? { amount: v } : { [field]: v }
      eq(`${field} ${JSON.stringify(v).slice(0, 40)}: client and server agree`, clientFn[field](v), serverVerdict(body, field))
    }
  }
  // Footnote and void reason.
  for (const v of ['', '*$650 for fuel advance', 'x'.repeat(500), 'x'.repeat(501)]) {
    const r = S.parseLineSelection({ footnote: v })
    eq(`footnote ${v.length} chars: client and server agree`, C.footnoteError(v), r.ok ? '' : r.error)
  }
  for (const v of ['Entered twice', '', '   ', 'x'.repeat(200), 'x'.repeat(201)]) {
    const r = S.parseVoid({ reason: v })
    eq(`void reason ${JSON.stringify(v).slice(0, 20)}: client and server agree`, C.voidReasonError(v), r.ok ? '' : r.error)
  }
  // A hidden character the server would turn into a space: the client refuses
  // it outright (stricter is allowed; looser is not).
  ok('a tab in the label is refused by the client', C.lineLabelError('Fuel\tadvance') !== '')
})

// ════════════════════════════════════════════════════════════════════════════
section('§2 the add form\'s request body')
guard('§2', () => {
  if (!C) throw new Error(`${CLIENT_LIB} does not exist yet`)
  eq('raw values, the kind fixed, the label defaulted', C.newLineBody({ label: '  ', amount: ' 650.00 ', receivedOn: '2026-10-12', reference: ' EFS-55501 ', note: 'n' }),
    { kind: 'advance', label: 'Fuel advance', amount: '650.00', receivedOn: '2026-10-12', reference: 'EFS-55501', note: 'n' })
  eq('the server accepts what the form builds', S.parseNewLine(C.newLineBody({ label: '', amount: '650', receivedOn: '', reference: '', note: '' })).ok, true)
  eq('newLineErrors names each wrong field', Object.keys(C.newLineErrors({ label: '#x', amount: 'abc', receivedOn: '2026-02-30', reference: '-r', note: 'x'.repeat(501) })).sort(),
    ['amount', 'label', 'note', 'receivedOn', 'reference'])
  eq('…and nothing for a good line', C.newLineErrors({ label: '', amount: '650', receivedOn: '', reference: '', note: '' }), {})
})

// ════════════════════════════════════════════════════════════════════════════
section('§3 InvoiceAdvanceLines.vue')
let COMP = ''
guard('§3', () => {
  if (!exists(COMPONENT)) throw new Error(`${COMPONENT} does not exist yet (the B20 build adds it)`)
  COMP = read(COMPONENT)
  const script = COMP.slice(COMP.indexOf('<script setup>'), COMP.indexOf('</script>'))
  const urls = [...script.matchAll(/api\.(get|post|put|delete)\(\s*`([^`]*)`/g)].map((m) => `${m[1]} ${m[2]}`)
  eq('it calls exactly the add and void routes', urls.sort(), [
    'post /api/loads/${encodeURIComponent(props.loadId)}/invoice-lines',
    'post /api/loads/${encodeURIComponent(props.loadId)}/invoice-lines/${encodeURIComponent(String(line.id))}/void',
  ].sort())
  ok('the add posts newLineBody(addForm)', /invoice-lines`,\s*newLineBody\(addForm\)/.test(script))
  ok('the void posts the typed reason', /\/void`,\s*\{ reason: voidReason\.value \}/.test(script))
  ok('imports its rules from lib/invoiceLines', /from '\.\.\/\.\.\/lib\/invoiceLines'/.test(script))
  ok('the figures are the server\'s strings: line haul, advances, balance due',
    COMP.includes('{{ summary.lineHaul }}') && COMP.includes('{{ summary.advances }}') && COMP.includes('{{ summary.balanceDue }}'))
  ok('each line shows its server-formatted amount', COMP.includes('{{ line.amount }}'))
  ok('no money arithmetic: no parse, sum or scaling in the script', noMoneyArithmetic(script))
  ok('the section says the lines are invoice-only', /Invoice only/.test(COMP) && /Job Tracking, revenue, driver pay, investor payouts and the P&amp;L/.test(COMP))
  ok('a same-amount receipt is named from receiptWarnings', /receiptWarnings/.test(COMP) && /same amount/.test(COMP))
  ok('every control is disabled while the editor approves', (COMP.match(/:disabled="[^"]*\bdisabled\b/g) || []).length >= 4)
})

// ════════════════════════════════════════════════════════════════════════════
section('§4 the modal')
const MODAL = read(MODAL_REL)
function liftFn(src, name) {
  const needle = `\nfunction ${name}(`
  const hits = src.split(needle).length - 1
  if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in ${MODAL_REL}, found ${hits}`)
  const a = src.indexOf(needle) + 1
  const bodyOpen = src.indexOf(') {', a) + 2
  let depth = 0
  for (let i = bodyOpen; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(a, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}
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
const computed = (fn) => ({ get value() { return fn() } })
const str = (v) => (v == null ? '' : String(v))
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
// The modal's own buildOverrideBody(), run over stand-ins.
function bodyOf(src, dryRun, over = {}) {
  const form = {
    invoiceId: 'INV-1', invoiceDate: '2026-10-16', orderNumber: '7000002', total: '2400.00', billToName: '', brokerName: '',
    poNumber: '', deliveryDate: '', notes: '', emailBody: '', lineIds: [], footnote: '', ...over.form,
  }
  const edited = { billToName: false, brokerName: false, poNumber: false, deliveryDate: false, notes: false, emailBody: false, footnote: false, ...over.edited }
  const fn = new Function('pv', 'form', 'recipient', 'edited', 'noPoOnRatecon', 'pinnedIsBison', 'str', `${src}\nreturn buildOverrideBody;`)(
    { value: dryRun }, form, { value: 'ap@example.test' }, { value: edited }, { value: false }, { value: null }, str)
  return { preview: fn({ forPreview: true }), approve: fn({ forPreview: false }), form }
}
guard('§4', () => {
  const BODY_SRC = `${liftFn(MODAL, 'has')}\n${liftFn(MODAL, 'buildOverrideBody')}`
  // Flag off: the dryRun has no invoiceLines, and the body is what it always was.
  const off = bodyOf(BODY_SRC, { orderNumber: '7000002' }, { form: { lineIds: [3], footnote: 'typed' }, edited: { footnote: true } })
  for (const which of ['preview', 'approve']) {
    ok(`flag off: the ${which} body carries no lineIds and no footnote`, !hasOwn(off[which], 'lineIds') && !hasOwn(off[which], 'footnote'))
  }
  const LINES = { available: [], selectedIds: [], summary: null, error: null, receiptWarnings: [] }
  const on = bodyOf(BODY_SRC, { orderNumber: '7000002', invoiceLines: LINES }, { form: { lineIds: [3, 5], footnote: '*$650 for fuel advance' } })
  for (const which of ['preview', 'approve']) {
    eq(`flag on: the ${which} body always names the ticked lines`, on[which].lineIds, [3, 5])
    ok(`…a copy, never the form's own array`, on[which].lineIds !== on.form.lineIds)
    ok(`…and leaves an unedited footnote to the server's default`, !hasOwn(on[which], 'footnote'))
  }
  const none = bodyOf(BODY_SRC, { invoiceLines: LINES }, { form: { lineIds: [] } })
  eq('no line ticked: an explicit empty list (the server prints none)', none.approve.lineIds, [])
  const typed = bodyOf(BODY_SRC, { invoiceLines: LINES }, { form: { lineIds: [3], footnote: '*Paid by EFS check' }, edited: { footnote: true } })
  eq('an edited footnote is sent raw, on both', [typed.preview.footnote, typed.approve.footnote], ['*Paid by EFS check', '*Paid by EFS check'])
  const cleared = bodyOf(BODY_SRC, { invoiceLines: LINES }, { form: { lineIds: [3], footnote: '' }, edited: { footnote: true } })
  eq('a cleared footnote is sent as "" (none printed)', cleared.approve.footnote, '')
  ok('never an amount, a balance or a line\'s figures', !/amount|balance|Cents/i.test(JSON.stringify(on.approve)))

  // The edited flag for the footnote: against the server's current default.
  const EDITED_SRC = liftComputed(MODAL, 'edited')
  const editedOf = (formFoot, seededFoot) => new Function('computed', 'seeded', 'form', 'str', 'moneyValue', `${EDITED_SRC}\nreturn edited.value;`)(
    computed, { value: { footnote: seededFoot } }, { footnote: formFoot, total: '', billToName: '', brokerName: '', invoiceId: '', invoiceDate: '', orderNumber: '', poNumber: '', deliveryDate: '', notes: '', emailBody: '' }, str, () => null).footnote
  eq('footnote edited only when it differs from the default (trimmed)', [editedOf('*$650 for fuel advance ', '*$650 for fuel advance'), editedOf('*x', '*$650 for fuel advance')], [false, true])
  eq('flag off: no footnote anywhere, never edited', editedOf(undefined, undefined), false)

  // The section and its gate.
  ok('imports InvoiceAdvanceLines.vue', /import InvoiceAdvanceLines from '\.\/InvoiceAdvanceLines\.vue'/.test(MODAL))
  ok('linesState is the dryRun\'s invoiceLines object, else null',
    MODAL.includes("const linesState = computed(() => (pv.value.invoiceLines && typeof pv.value.invoiceLines === 'object' ? pv.value.invoiceLines : null))"))
  const mounts = [...MODAL.matchAll(/<InvoiceAdvanceLines\b[^>]*>/g)].map((m) => m[0])
  eq('mounted once', mounts.length, 1)
  ok('…only when linesState', mounts.length === 1 && /\sv-if="linesState"/.test(mounts[0]))
  ok('…given the server\'s figures, never figures of its own', mounts.length === 1 && /:summary="linesSummary"/.test(mounts[0]) && /:footnote-default="str\(seeded\.footnote\)"/.test(mounts[0]))
  ok('…disabled while approving', mounts.length === 1 && /:disabled="approving"/.test(mounts[0]))

  // The total is the line haul while a line is ticked.
  ok('linesLockTotal: a line ticked under the flag',
    MODAL.includes('const linesLockTotal = computed(() => !!linesState.value && form.lineIds.length > 0)'))
  const totalTag = (MODAL.match(/<input\s[^>]*id="idp-total"[^>]*>/) || [''])[0]
  ok('the Total input is read-only while locked', /:readonly="linesLockTotal"/.test(totalTag))
  ok('…and its label says "Line haul" then', MODAL.includes("{{ linesLockTotal ? 'Line haul' : 'Total' }}"))
  const SELECT_SRC = liftFn(MODAL, 'onLinesSelect')
  const form = { lineIds: [], total: '1750.00' }
  const calls = []
  new Function('form', 'seeded', 'str', 'schedulePreview', `${SELECT_SRC}\nreturn onLinesSelect;`)(
    form, { value: { total: '2400.00' } }, str, (o) => calls.push(o))([4])
  eq('ticking a line puts the total back to the line haul the server derived, and renders at once', [form.lineIds, form.total, calls], [[4], '2400.00', [{ immediate: true }]])

  // The preview's figures are adopted as the server sent them.
  const ADOPT_SRC = liftFn(MODAL, 'adoptLines')
  ok('adoptLines takes the summary from the response, never computes one',
    /linesSummary\.value = /.test(ADOPT_SRC) && !/[-+]\s*\w*Cents|Cents\s*[-+]|parseFloat|Number\(|reduce\(/.test(ADOPT_SRC))
  const st = { linesState: { value: LINES }, linesSummary: { value: null }, linesError: { value: { code: 'X' } }, form: { footnote: '' }, seeded: { value: { footnote: '' } } }
  const adopt = new Function('linesState', 'linesSummary', 'linesError', 'form', 'seeded', 'edited', 'str', `${ADOPT_SRC}\nreturn adoptLines;`)(
    st.linesState, st.linesSummary, st.linesError, st.form, st.seeded, { value: { footnote: false } }, str)
  const SUM = { lineHaul: '$2,400.00', advances: '-$650.00', balanceDue: '$1,750.00', footnote: '*$650 for fuel advance', footnoteDefault: '*$650 for fuel advance' }
  adopt({ invoiceLines: { summary: SUM } })
  eq('adopted: the summary, the error cleared, the default footnote followed', [st.linesSummary.value, st.linesError.value, st.form.footnote, st.seeded.value.footnote], [SUM, null, SUM.footnoteDefault, SUM.footnoteDefault])
})

// ════════════════════════════════════════════════════════════════════════════
section('§5 who calls the invoice-lines routes, who mounts the section')
guard('§5', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(p)
    return /\.(vue|js|ts|html)$/.test(e.name) ? [p] : []
  })
  const files = walk(rel('client/src'))
  const relOf = (f) => path.relative(ROOT, f).split(path.sep).join('/')
  // Comment lines name routes without calling them (the admin-only runner's rule).
  const code = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n')
  const callers = files.filter((f) => /\/invoice-lines\b/.test(code(f))).map(relOf).sort()
  eq('only InvoiceAdvanceLines.vue calls /invoice-lines', callers, [COMPONENT])
  const mounts = files.filter((f) => /<InvoiceAdvanceLines\b/.test(fs.readFileSync(f, 'utf8'))).map(relOf)
  eq('only the invoice editor mounts it (and the editor is Super Admin only)', mounts, [MODAL_REL])
})

// ════════════════════════════════════════════════════════════════════════════
section('§6 DISCRIMINATION')
guard('§6', () => {
  const BODY_SRC = `${liftFn(MODAL, 'has')}\n${liftFn(MODAL, 'buildOverrideBody')}`
  const gate = 'if (pv.value.invoiceLines) {'
  ok('mutant anchor: the body\'s lines gate is found once', BODY_SRC.split(gate).length - 1 === 1)
  const always = BODY_SRC.replace(gate, 'if (true) {')
  const leaked = bodyOf(always, {}, { form: { lineIds: [3] } })
  ok('MUTANT the lines keys sent with the flag off: caught', hasOwn(leaked.approve, 'lineIds'))
  const footAlways = BODY_SRC.replace('if (edited.value.footnote) body.footnote = form.footnote', 'body.footnote = form.footnote')
  ok('mutant anchor: the footnote rule is found once', footAlways !== BODY_SRC)
  ok('MUTANT an unedited footnote sent: caught', hasOwn(bodyOf(footAlways, { invoiceLines: {} }, { form: { lineIds: [3], footnote: 'd' } }).approve, 'footnote'))
  const ungated = MODAL.replace(/(<InvoiceAdvanceLines\b[^>]*?)\sv-if="linesState"/, '$1')
  ok('MUTANT the section shown without the flag: caught', ungated !== MODAL && !/<InvoiceAdvanceLines\b[^>]*\sv-if="linesState"/.test(ungated))
  if (COMP) {
    const script = COMP.slice(COMP.indexOf('<script setup>'), COMP.indexOf('</script>'))
    for (const [name, planted] of [
      ['a balance computed from the cents', 'const balance = computed(() => props.summary.lineHaulCents - props.summary.advancesCents)'],
      ['the advances summed', 'const total = props.available.reduce((s, l) => s + l.amountCents, 0)'],
      ['an amount parsed', 'const n = parseFloat(addForm.amount)'],
    ]) {
      ok(`MUTANT ${name}: caught`, !noMoneyArithmetic(`${script}\n${planted}\n`))
    }
  }
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
