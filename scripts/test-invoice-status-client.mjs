#!/usr/bin/env node
// client/src/lib/invoiceStatus.js and Completed Loads: one invoice status on each completed
// load, as a Super Admin reads it. The server works the status out; the browser words it.
//
//   §1 PARITY: the eight status words and every status code are the server's, exactly
//   §2 each status's chip and dialog line: words, tone, date, invoice number, why
//   §3 the sentences: the plan's, word for word, and each a plain sentence
//   §4 a load nothing will invoice keeps "No automatic invoice" while the mailbox says nothing,
//      and "No invoice found" comes only from the server, on the server's own answers
//   §5 with no status on the rows (the kill switch), every chip is today's
//   §6 Mark checked and Try again keep reading `_autoInvoice`; `retry: "none"` is respected;
//      the open dialog after either, run over stand-ins
//   §7 the filter: words and counts, a row with no status in no bucket, and on the page: page 1,
//      Clear, the export note, the toggle's title
//   §8 Super Admin only, on the page
//   §9 no status is worked out here: a plain module that reads codes
//
// No network, no DOM, no database. Made-up data only.
//   node scripts/test-invoice-status-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const server = require(path.join(ROOT, 'lib', 'invoice-status.js'))
const CLIENT = path.join(ROOT, 'client', 'src', 'lib', 'invoiceStatus.js')
const A = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'autoInvoiceStatus.js')).href)
// Loaded this way so a tree without the module fails case by case, not on one import.
const S = await import(pathToFileURL(CLIENT).href).catch(() => ({}))
const TAB = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'dashboard', 'CompletedLoadsTab.vue'), 'utf8')

let pass = 0
const failures = []
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; return }
  failures.push(`${label}\n      expected ${e}\n      actual   ${a}`)
}
function ok(cond, label) { eq(Boolean(cond), true, label) }
function section(t) { console.log(`\n${t}`) }
const fnOf = (name) => (typeof S[name] === 'function' ? S[name] : () => undefined)
const chip = typeof S.invoiceStatusChip === 'function' ? S.invoiceStatusChip : () => ({ label: '(no module)', tone: '', reason: '' })
const row =(read, auto) => ({ _invoiceStatus: read, ...(auto ? { _autoInvoice: auto } : {}) })

// One function from a component's <script setup>, as text. null when it isn't there exactly once.
function liftFn(src, name, { async = false } = {}) {
  const needle = `\n${async ? 'async ' : ''}function ${name}(`
  if (src.split(needle).length - 1 !== 1) return null
  const a = src.indexOf(needle) + 1
  const bodyOpen = src.indexOf(') {', a) + 2
  let depth = 0
  for (let i = bodyOpen; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(a, i + 1)
  }
  return null
}

// ------------------------------------------------------------------ §1
section('§1  parity with the server')
eq(S.INVOICE_STATUS_LABELS || null, server.STATUS_LABELS, '§1 FAILS ON THE OLD CODE: the eight words are the server\'s, for the same keys, in the same order')
eq(Object.keys(server.STATUS_LABELS).length, 8, '§1 there are eight')
eq(Object.keys(S.INVOICE_STATUS_REASONS || {}).sort(), [...server.STATUS_CODES].sort(), '§1 FAILS ON THE OLD CODE: every status code the rule adds has words, and nothing else does')
eq([...(S.INVOICE_STATUS_FOUND || [])].sort(), Object.values(server.FOUND).sort(), '§1 FAILS ON THE OLD CODE: every place an "Invoiced by hand" can be found has words')
for (const code of server.STATUS_CODES) ok(!Object.hasOwn(A.AUTO_INVOICE_REASONS, code), `§1 ${code} is the status's own, not a claim's: the two lists don't overlap`)

// ------------------------------------------------------------------ §2
section('§2  each status, on the row and in the dialog')
const ID = '11042026-7'
const DAY = '2026-11-04'
const SHOWN = 'Nov 4, 2026'
const AT = '2026-11-04T14:30:00Z'
const ATTENTION = (code) => A.AUTO_INVOICE_REASONS[code].attentionText || A.AUTO_INVOICE_REASONS[code].text
const CASES = [
  ['sent', { status: 'sent', invoiceId: ID, date: DAY }, { label: 'Sent by LogisX', tone: 'ok', reason: `Invoice ${ID} was sent to the broker automatically on ${SHOWN}. Its copy is in Gmail Sent Mail.` }],
  ['sent, no number or date', { status: 'sent' }, { label: 'Sent by LogisX', tone: 'ok', reason: 'The invoice was sent to the broker automatically. Its copy is in Gmail Sent Mail.' }],
  ['sent, the load changed', { status: 'sent', invoiceId: ID, date: DAY, changed: ['payment', 'trailer'] }, { label: 'Sent by LogisX: load changed', tone: 'warn', reason: `Invoice ${ID} was sent to the broker automatically on ${SHOWN}. Changed since the invoice was sent to the broker: the Payment, the trailer. Check with the broker whether a corrected invoice is needed, then Mark checked.` }],
  ['sent, a change this client has no words for', { status: 'sent', changed: ['toString'] }, { label: 'Sent by LogisX', tone: 'ok', reason: 'The invoice was sent to the broker automatically. Its copy is in Gmail Sent Mail.' }],
  ['by hand, in Sent Mail', { status: 'by_hand', invoiceId: ID, date: DAY, found: 'sent_mail' }, { label: 'Invoiced by hand', tone: 'ok', reason: `Invoice ${ID} is in Gmail Sent Mail, dated ${SHOWN}.` }],
  ['by hand, in Sent Mail, no row and no date', { status: 'by_hand', found: 'sent_mail' }, { label: 'Invoiced by hand', tone: 'ok', reason: 'An invoice for this load is in Gmail Sent Mail.' }],
  ['by hand, on the Payments Table', { status: 'by_hand', found: 'payments_table' }, { label: 'Invoiced by hand', tone: 'ok', reason: 'The Payments Table holds an invoice or payment for this load.' }],
  ['by hand, on the Payments Table, with a row\'s number', { status: 'by_hand', invoiceId: ID, found: 'payments_table' }, { label: 'Invoiced by hand', tone: 'ok', reason: `Invoice ${ID}. The Payments Table holds an invoice or payment for this load.` }],
  ['by hand, a draft row not checked', { status: 'by_hand', invoiceId: ID, found: 'draft_row', sentUnchecked: true }, { label: 'Invoiced by hand: Sent Mail not checked yet', tone: 'muted', reason: `Someone drafted invoice ${ID} by hand. Sent Mail not checked yet.` }],
  ['by hand, a draft row with no number', { status: 'by_hand', found: 'draft_row', sentUnchecked: true }, { label: 'Invoiced by hand: Sent Mail not checked yet', tone: 'muted', reason: 'Someone drafted this invoice by hand. Sent Mail not checked yet.' }],
  ['draft, the job\'s', { status: 'draft', invoiceId: ID, whose: 'job' }, { label: 'Draft in Gmail', tone: 'ok', reason: `LogisX made this draft. Invoice ${ID} is in Gmail Drafts. Check it and send it.` }],
  ['draft, a person\'s', { status: 'draft', invoiceId: ID, whose: 'person' }, { label: 'Draft in Gmail', tone: 'ok', reason: `Someone made this draft by hand. Invoice ${ID} is in Gmail Drafts. Check it and send it.` }],
  ['draft, found with no row', { status: 'draft' }, { label: 'Draft in Gmail', tone: 'ok', reason: 'An invoice for this load is in Gmail Drafts. Check it and send it.' }],
  ['waiting, no code', { status: 'waiting' }, { label: 'Waiting: about to be made', tone: 'muted', reason: 'The invoice will be made shortly.' }],
  ['waiting, a claim\'s code', { status: 'waiting', code: 'GEMINI_DOWN' }, { label: 'Waiting: rate-con reader down', tone: 'muted', reason: A.AUTO_INVOICE_REASONS.GEMINI_DOWN.text }],
  ['waiting, a driver\'s tap', { status: 'waiting', code: 'DRIVER_PENDING' }, { label: 'Waiting: about to be made', tone: 'muted', reason: A.AUTO_INVOICE_REASONS.DRIVER_PENDING.text }],
  ['waiting, a press in flight', { status: 'waiting', code: 'HAND_DRAFT_IN_FLIGHT' }, { label: 'Waiting: being drafted by hand', tone: 'muted', reason: A.AUTO_INVOICE_REASONS.HAND_DRAFT_IN_FLIGHT.text }],
  ['waiting, a send with no answer', { status: 'waiting', code: 'SEND_UNCONFIRMED' }, { label: 'Waiting: checking Sent Mail', tone: 'warn', reason: A.AUTO_INVOICE_REASONS.SEND_UNCONFIRMED.text }],
  ['needs attention', { status: 'needs_attention', code: 'TOTAL_MISMATCH' }, { label: 'Needs attention: totals differ', tone: 'bad', reason: ATTENTION('TOTAL_MISMATCH') }],
  ['needs attention, the person\'s sentence on a code the sweep can also hold', { status: 'needs_attention', code: 'RETRY_LATER' }, { label: 'Needs attention: last try failed', tone: 'bad', reason: ATTENTION('RETRY_LATER') }],
  ['needs attention, a code this client has no words for', { status: 'needs_attention', code: 'SOMETHING_NEW' }, { label: 'Needs attention', tone: 'bad', reason: 'Draft it by hand.' }],
  ['needs attention, the status\'s own code', { status: 'needs_attention', code: 'DRAFT_NOT_IN_GMAIL', invoiceId: ID }, { label: 'Needs attention: in neither Gmail mailbox', tone: 'bad', reason: `Invoice ${ID}. An invoice draft was made in the app, but it's in neither Gmail Drafts nor Sent Mail. Check Gmail, then draft it again if it's needed.` }],
  ['needs attention, and an email names the load', { status: 'needs_attention', code: 'RENDERER_BUSY', mentioned: true }, { label: 'Needs attention: PDF renderer busy', tone: 'bad', reason: `${ATTENTION('RENDERER_BUSY')} An email names this load, but it doesn't look like an invoice. Check Gmail.` }],
  ['needs attention, a mailbox hit says it once', { status: 'needs_attention', code: 'MAILBOX_HIT', mentioned: true }, { label: 'Needs attention: an email names this load', tone: 'bad', reason: ATTENTION('MAILBOX_HIT') }],
  ['factored', { status: 'factored' }, { label: 'Factored (Triumph)', tone: 'muted', reason: A.AUTO_INVOICE_REASONS.LOAD_FACTORED.text }],
  ['no invoice found', { status: 'none_found', searchedAt: AT }, { label: 'No invoice found', tone: 'warn', reason: 'Gmail Drafts and Sent Mail hold no invoice for this load, last searched Nov 4, 2026, 9:30 AM EST. That isn\'t proof: it may have been billed another way.' }],
  ['no invoice found, no time', { status: 'none_found' }, { label: 'No invoice found', tone: 'warn', reason: 'Gmail Drafts and Sent Mail hold no invoice for this load. That isn\'t proof: it may have been billed another way.' }],
  ['couldn\'t check', { status: 'unknown', code: 'NOT_SEARCHED' }, { label: 'Couldn\'t check: not searched yet', tone: 'muted', reason: 'The mailbox hasn\'t been searched for this load yet.' }],
  ['couldn\'t check, a closed month\'s draft', { status: 'unknown', code: 'DRAFT_NOT_IN_GMAIL', invoiceId: ID }, { label: 'Couldn\'t check: in neither Gmail mailbox', tone: 'muted', reason: `Invoice ${ID}. An invoice draft was made in the app, but it's in neither Gmail Drafts nor Sent Mail. Check Gmail, then draft it again if it's needed.` }],
  ['couldn\'t check, a claim\'s code', { status: 'unknown', code: 'MAYBE_SENT' }, { label: 'Couldn\'t check: may already be sent', tone: 'muted', reason: A.AUTO_INVOICE_REASONS.MAYBE_SENT.text }],
  ['couldn\'t check, no words', { status: 'unknown', code: 'SOMETHING_NEW' }, { label: 'Couldn\'t check', tone: 'muted', reason: '' }],
]
for (const [name, read, want] of CASES) eq(chip(row(read)), want, `§2 FAILS ON THE OLD CODE: ${name}`)
for (const key of Object.keys(server.STATUS_LABELS)) {
  const c = chip(row({ status: key }))
  ok(c && c.label.startsWith(server.STATUS_LABELS[key]), `§2 FAILS ON THE OLD CODE: ${key}'s chip starts with its word`)
}
{
  // While the invoice is being made the chip keeps §8's words: the status has no state of its own.
  const working = { state: 'working', code: '', invoiceId: '', changed: [] }
  eq(chip(row({ status: 'waiting' }, working)), { label: 'Making the invoice now', tone: 'muted', reason: 'The invoice is being made. It takes a minute or two.' }, '§2 FAILS ON THE OLD CODE: a load being built reads "Making the invoice now"')
  eq(chip(row({ status: 'waiting', code: 'GEMINI_DOWN' }, { ...working, code: 'GEMINI_DOWN' })).label, 'Making the invoice now', '§2 FAILS ON THE OLD CODE: ...whatever its last try left on the claim')
  eq(chip(row({ status: 'waiting', code: 'SEND_UNCONFIRMED' }, { ...working, code: 'SEND_UNCONFIRMED' })).label, 'Waiting: checking Sent Mail', '§2 FAILS ON THE OLD CODE: ...but a send with no answer says so: nothing is being made')
}
for (const bad of [null, undefined, 'sent', {}, { status: '__proto__' }, { status: 'toString' }, { status: 'SOMETHING_NEW' }, { status: 7 }]) {
  eq(chip({ _invoiceStatus: bad }), null, `§2 ${JSON.stringify(bad)} from the server: no chip, and never a word this file guessed`)
}
for (const code of ['__proto__', 'constructor', 'toString']) {
  eq(chip(row({ status: 'unknown', code })), { label: "Couldn't check", tone: 'muted', reason: '' }, `§2 FAILS ON THE OLD CODE: the code "${code}" is no reason, on the chip or the line`)
}

// ------------------------------------------------------------------ §3
section('§3  the sentences')
{
  const R = S.INVOICE_STATUS_REASONS || {}
  const PLAN = {
    DRAFT_NOT_IN_GMAIL: "An invoice draft was made in the app, but it's in neither Gmail Drafts nor Sent Mail. Check Gmail, then draft it again if it's needed.",
    MENTIONED: "An email names this load, but it doesn't look like an invoice. Check Gmail.",
    BISON_ORDER_NUMBER: "Bison invoices carry Bison's own Order #, so a search by load number can't tell. Check Gmail.",
    NOT_SEARCHED: "The mailbox hasn't been searched for this load yet.",
    SEARCH_FAILED: "The mailbox search failed; it's tried again.",
  }
  const PROPOSED = {
    PAYMENTS_NOT_READ: "The Payments Table hasn't been read for this load yet.",
    FACTORING_UNREADABLE: "The factoring marker couldn't be read, so this load's status can't be told.",
    EVIDENCE_UNREADABLE: "This load's invoice records couldn't be read. Reload in a minute.",
    INVOICE_MAYBE_DRAFTED: 'An invoice draft for this load may already be in Gmail. Use Check Gmail on the load before drafting again.',
  }
  for (const [code, words] of Object.entries({ ...PLAN, ...PROPOSED })) eq(R[code] && R[code].text, words, `§3 FAILS ON THE OLD CODE: ${code}: the sentence, word for word`)
  for (const [code, { short, text }] of Object.entries(R)) {
    ok(short && text && short === short.trim() && text === text.trim(), `§3 ${code}: words present, trimmed`)
    ok(!/[<>@]/.test(short + text), `§3 ${code}: no markup or address`)
    ok(/[.]$/.test(text) && !/[.]$/.test(short), `§3 ${code}: the sentence ends with a stop, the chip words don't`)
    ok(short.length <= 32, `§3 ${code}: the chip words fit (${short.length})`)
  }
  eq(R.NOT_SEARCHED && R.NOT_SEARCHED.short, 'not searched yet', '§3 FAILS ON THE OLD CODE: "Couldn\'t check: not searched yet" is the plan\'s chip')
  for (const [name, read] of CASES) {
    const c = chip(row(read))
    ok(c && !/\b(?:undefined|null|NaN)\b/.test(`${c.label} ${c.reason}`) && !/\s{2}/.test(c.reason) && !/^\s|\s$/.test(c.reason), `§3 FAILS ON THE OLD CODE: ${name}: no gap, and no blank value spelled out`)
  }
}

// ------------------------------------------------------------------ §4
section('§4  "No automatic invoice", and "No invoice found" from the server alone')
{
  const NOT_BY_DRIVER = { state: 'needs_attention', code: 'NOT_BY_DRIVER', invoiceId: '', changed: [], trigger: true, retry: 'none' }
  const tChip = A.autoInvoiceChip(NOT_BY_DRIVER)
  eq(tChip.label, 'No automatic invoice', '§4 the chip the trigger shipped')
  // The server's own answers, so a load the office marked Delivered is read as the rule reads it.
  const answers = (over) => server.statusOf({ claim: null, rows: [], presses: [], factored: false, triumphDone: false, saved: null, isBison: false, closedMonth: () => false, sweepOn: false, passOn: false, dayOf: () => DAY, ...over })
  const clean = { result: 'answered', searched_at: AT, payments_checked_at: AT }
  const notSearched = answers({})
  eq(notSearched, { status: 'unknown', code: 'NOT_SEARCHED' }, '§4 with the pass off, the rule answers NOT_SEARCHED for that load')
  eq(chip(row(notSearched, NOT_BY_DRIVER)), tChip, '§4 FAILS ON THE OLD CODE: ...and it still reads "No automatic invoice", or the load gets forgotten')
  const cleanOff = answers({ saved: clean })
  eq(cleanOff, { status: 'unknown', code: 'NOT_SEARCHED' }, '§4 a clean answer saved earlier claims nothing with the pass off')
  eq(chip(row(cleanOff, NOT_BY_DRIVER)), tChip, '§4 FAILS ON THE OLD CODE: ...and it reads "No automatic invoice" too')
  for (const code of ['NOT_SEARCHED', 'SEARCH_FAILED', 'PAYMENTS_NOT_READ', 'EVIDENCE_UNREADABLE']) {
    eq(chip(row({ status: 'unknown', code }, NOT_BY_DRIVER)), tChip, `§4 FAILS ON THE OLD CODE: ${code} says nothing about the load, so it doesn't hide the chip`)
  }
  // Evidence about the load beats it: "Draft it by hand" could bill a load twice.
  for (const code of ['MENTIONED', 'BISON_ORDER_NUMBER']) {
    eq(chip(row({ status: 'unknown', code }, NOT_BY_DRIVER)).label, `Couldn't check: ${S.INVOICE_STATUS_REASONS ? S.INVOICE_STATUS_REASONS[code].short : ''}`, `§4 FAILS ON THE OLD CODE: ${code} keeps its own words: it asks a person to check Gmail first`)
  }
  eq(chip(row(answers({ saved: { ...clean, sent_invoice: 1, first_sent_at: AT } }), NOT_BY_DRIVER)).label, 'Invoiced by hand', '§4 FAILS ON THE OLD CODE: an invoice in Sent Mail beats it')
  eq(chip(row(answers({ saved: { drafts_invoice: 1 } }), NOT_BY_DRIVER)).label, 'Draft in Gmail', '§4 FAILS ON THE OLD CODE: an invoice in Drafts beats it')
  eq(chip(row(answers({ passOn: true, saved: clean }), NOT_BY_DRIVER)).label, 'No invoice found', '§4 FAILS ON THE OLD CODE: with the pass on, the search\'s answer beats it')
  eq(chip(row(answers({ passOn: true }), NOT_BY_DRIVER)), tChip, '§4 FAILS ON THE OLD CODE: ...and until the pass reaches the load, the chip stays')
  eq(chip(row(notSearched)).label, "Couldn't check: not searched yet", '§4 FAILS ON THE OLD CODE: an old load with no such chip reads Couldn\'t check')
  eq(chip(row(notSearched, { state: 'needs_attention', code: 'OFF_GAP', invoiceId: '', changed: [] })).label, "Couldn't check: not searched yet", '§4 FAILS ON THE OLD CODE: ...and so does OFF_GAP: only NOT_BY_DRIVER takes this path')

  // "No invoice found" only for the server's none_found, across every other status and chip.
  const AUTOS = [undefined, NOT_BY_DRIVER, { state: 'drafted', changed: [] }, { state: 'needs_attention', code: 'OFF_GAP' }, { state: 'waiting', code: 'WAITING_POD' }, { state: 'working' }, { state: 'queued' }]
  const READS = [undefined, null, ...CASES.map(([, read]) => read).filter((r) => r.status !== 'none_found'), ...server.STATUS_CODES.map((code) => ({ status: 'unknown', code }))]
  let leaked = 0
  for (const read of READS) for (const auto of AUTOS) if (/No invoice found/.test(JSON.stringify(chip(row(read, auto)) || ''))) leaked++
  eq(leaked, 0, '§4 no other answer, with any chip beside it, ever reads "No invoice found"')
  eq((fnOf('invoiceStatusOptions')([row({ status: 'unknown', code: 'NOT_SEARCHED' }), {}]) || []).find((o) => o.value === 'none_found')?.count, 0,'§4 FAILS ON THE OLD CODE: nor does the filter count one')
  eq(TAB.split('No invoice found').length - 1, 0, '§4 the page names no status: the words live in one file')
  const LIB = fs.existsSync(CLIENT) ? fs.readFileSync(CLIENT, 'utf8') : ''
  eq(LIB.split('No invoice found').length - 1, 1, '§4 FAILS ON THE OLD CODE: that file has the words once, in the table the runner pins')
}

// ------------------------------------------------------------------ §5
section('§5  no status on the rows (the kill switch, or not a Super Admin)')
{
  const AUTOS = [
    { state: 'drafted', code: '', invoiceId: ID, changed: [] }, { state: 'drafted', code: '', invoiceId: ID, changed: ['payment'], sent: true },
    { state: 'waiting', code: 'WAITING_POD' }, { state: 'queued', code: '' }, { state: 'queued', code: 'SEND_UNCONFIRMED' }, { state: 'working' },
    { state: 'needs_attention', code: 'TOTAL_MISMATCH' }, { state: 'needs_attention', code: 'NOT_BY_DRIVER', trigger: true, retry: 'none' },
  ]
  for (const auto of AUTOS) eq(chip({ _autoInvoice: auto }), A.autoInvoiceChip(auto), `§5 FAILS ON THE OLD CODE: ${auto.state} ${auto.code || ''}: today's chip, unchanged`)
  eq(chip({}), null, '§5 no status and no claim: no chip')
  eq(chip(null), null, '§5 no row: no chip')
  eq(fnOf('hasInvoiceStatus')({ _autoInvoice: AUTOS[0] }), false, '§5 FAILS ON THE OLD CODE: a row with only the job\'s status has no invoice status')
  eq(fnOf('hasInvoiceStatus')({ _invoiceStatus: { status: 'sent' } }), true, '§5 FAILS ON THE OLD CODE: ...and one from the server has')
  eq(fnOf('hasInvoiceStatus')({ _invoiceStatus: { status: 'SOMETHING_NEW' } }), false, '§5 FAILS ON THE OLD CODE: ...a status this client has no word for doesn\'t turn the filter on')
}

// ------------------------------------------------------------------ §6
section('§6  Mark checked, Try again and `retry: "none"`')
{
  const tag = (name) => (new RegExp(`<button[^>]*@click="autoInvoiceAction\\('${name}'\\)"[^>]*>`).exec(TAB) || [''])[0]
  ok(/v-if="canMarkChecked\(selectedJob\._autoInvoice\)"/.test(tag('checked')), '§6 Mark checked reads `_autoInvoice`')
  ok(/v-if="canTryAgain\(selectedJob\._autoInvoice\)"/.test(tag('retry')), '§6 Try again reads `_autoInvoice`')
  ok(!/canTryAgain\(selectedJob\._invoiceStatus|canMarkChecked\(selectedJob\._invoiceStatus/.test(TAB), '§6 ...neither reads the status')
  // The status's line and its buttons share one line, the buttons by the job's rules.
  const lineOpen = TAB.indexOf('<div v-if="selectedAutoChip" class="auto-line"')
  ok(lineOpen > 0 && TAB.indexOf('<span class="auto-line-text"><strong>{{ selectedAutoChip.label }}.</strong> {{ selectedAutoChip.reason }}</span>', lineOpen) > lineOpen, '§6 the dialog\'s one line reads label, then reason')
  ok(/const selectedAutoChip = computed\(\(\) => autoChip\(selectedJob\.value\)\)/.test(TAB), '§6 ...the same words as the row')
  ok(/const autoChip = \(job\) => \(auth\.isSuperAdmin && job \? invoiceStatusChip\(job\) : null\)/.test(TAB), '§6 FAILS ON THE OLD CODE: the row\'s chip is the invoice status\'s')

  for (const retry of ['none']) {
    for (const code of ['RETRY_LATER', 'OFF_GAP', 'NOT_BY_DRIVER']) {
      eq(A.canTryAgain({ state: 'needs_attention', code, retry }), false, `§6 ${code}, retry "${retry}": no Try again, whatever the status reads`)
    }
  }
  eq(A.canTryAgain({ state: 'needs_attention', code: 'RETRY_LATER', retry: 'send' }), true, '§6 retry "send": Try again')

  // The open dialog holds its own copy of the row, so it words what the server just took.
  const src = liftFn(TAB, 'autoInvoiceAction', { async: true })
  ok(src, '§6 the page\'s autoInvoiceAction() is found')
  const run = async (kind, job, { refuse = false, answer = true } = {}) => {
    const selectedJob = { value: job }
    const autoActionResult = { value: null }
    const posts = []
    const fn = new Function('auth', 'loadRefValue', 'autoBusy', 'selectedJob', 'tryAgainConfirmText', 'window', 'autoActionResult', 'api', 'tryAgainDoneText', 'dashboard', 'statusAfterAction', `${src}\nreturn autoInvoiceAction;`)(
      { isSuperAdmin: true }, { value: 'QA-1' }, { value: false }, selectedJob, A.tryAgainConfirmText, { confirm: () => answer }, autoActionResult,
      { post: async (u) => { posts.push(u); if (refuse) throw Object.assign(new Error('made-up refusal'), { status: 409 }) } },
      A.tryAgainDoneText, { refresh: async () => {} }, fnOf('statusAfterAction'),
    )
    await fn(kind)
    return { job: selectedJob.value, posts, result: autoActionResult.value }
  }
  if (src) {
    const held = { _invoiceStatus: { status: 'needs_attention', code: 'TOTAL_MISMATCH' }, _autoInvoice: { state: 'needs_attention', code: 'TOTAL_MISMATCH', trigger: true, retry: 'send' } }
    const retried = await run('retry', held)
    eq(chip(retried.job), { label: 'Waiting: about to be made', tone: 'muted', reason: 'The invoice will be made shortly.' }, '§6 FAILS ON THE OLD CODE: Try again taken: the line stops saying Needs attention, in the job\'s words')
    eq(retried.job._invoiceStatus, undefined, '§6 FAILS ON THE OLD CODE: ...the old status isn\'t kept, and the browser makes up no new one')
    const refused = await run('retry', held, { refuse: true })
    eq(refused.job._invoiceStatus, held._invoiceStatus, '§6 Try again refused: the line stays as the server last said')
    const cancelled = await run('retry', held, { answer: false })
    eq([cancelled.posts.length, cancelled.job._invoiceStatus], [0, held._invoiceStatus], '§6 Try again cancelled: nothing posted, the line as it was')

    const changed = { _invoiceStatus: { status: 'sent', invoiceId: ID, date: DAY, changed: ['payment'] }, _autoInvoice: { state: 'drafted', code: '', invoiceId: ID, changed: ['payment'], sent: true } }
    eq(chip(changed).label, 'Sent by LogisX: load changed', '§6 FAILS ON THE OLD CODE: a load changed after its send')
    const checked = await run('checked', changed)
    eq(chip(checked.job), { label: 'Sent by LogisX', tone: 'ok', reason: `Invoice ${ID} was sent to the broker automatically on ${SHOWN}. Its copy is in Gmail Sent Mail.` }, '§6 FAILS ON THE OLD CODE: Mark checked taken: the mark goes, and the status stays')
    const notChecked = await run('checked', changed, { refuse: true })
    eq(chip(notChecked.job).label, 'Sent by LogisX: load changed', '§6 FAILS ON THE OLD CODE: Mark checked refused: the mark stays')

    const noStatus = { _autoInvoice: { state: 'needs_attention', code: 'TOTAL_MISMATCH' } }
    const retriedOff = await run('retry', noStatus)
    eq(chip(retriedOff.job).label, 'Waiting: about to be made', '§6 with no status on the row, Try again reads as today')
    eq(Object.hasOwn(retriedOff.job, '_invoiceStatus') && retriedOff.job._invoiceStatus !== undefined, false, '§6 ...and adds none')
  }
  eq(fnOf('statusAfterAction')('checked', undefined), undefined, '§6 Mark checked with no status: none')
}

// ------------------------------------------------------------------ §7
section('§7  the filter')
{
  const rows = [
    row({ status: 'sent' }), row({ status: 'sent', changed: ['payment'] }), row({ status: 'by_hand', found: 'sent_mail' }), row({ status: 'draft' }),
    row({ status: 'waiting' }), row({ status: 'needs_attention', code: 'TOTAL_MISMATCH' }), row({ status: 'factored' }), row({ status: 'none_found' }),
    row({ status: 'unknown', code: 'NOT_SEARCHED' }), row({ status: 'unknown', code: 'NOT_SEARCHED' }, { state: 'needs_attention', code: 'NOT_BY_DRIVER' }),
    { _autoInvoice: { state: 'drafted', changed: [] } }, {}, row({ status: 'SOMETHING_NEW' }), null,
  ]
  const options = fnOf('invoiceStatusOptions')(rows) || []
  eq(options.map((o) => [o.value, o.label, o.count, o.text]), [
    ['sent', 'Sent by LogisX', 2, 'Sent by LogisX (2)'], ['by_hand', 'Invoiced by hand', 1, 'Invoiced by hand (1)'], ['draft', 'Draft in Gmail', 1, 'Draft in Gmail (1)'],
    ['waiting', 'Waiting', 1, 'Waiting (1)'], ['needs_attention', 'Needs attention', 1, 'Needs attention (1)'], ['factored', 'Factored (Triumph)', 1, 'Factored (Triumph) (1)'],
    ['none_found', 'No invoice found', 1, 'No invoice found (1)'], ['unknown', "Couldn't check", 2, "Couldn't check (2)"],
  ], '§7 FAILS ON THE OLD CODE: the eight words with their counts: a row with no status, or one this client can\'t word, is in no bucket')
  const filter = fnOf('filterByInvoiceStatus')
  eq(filter(rows, 'sent')?.length, 2, '§7 FAILS ON THE OLD CODE: the filter lists a status\'s rows')
  eq(filter(rows, 'unknown')?.length, 2, '§7 FAILS ON THE OLD CODE: a row with no status never lands in Couldn\'t check')
  ok(filter(rows, '') === rows, '§7 FAILS ON THE OLD CODE: no choice: every row, the same list')
  eq(filter(rows, '__proto__')?.length, 0, '§7 FAILS ON THE OLD CODE: a choice that isn\'t a status lists nothing')
  eq(filter(null, 'sent'), [], '§7 FAILS ON THE OLD CODE: no rows: none')

  // On the page.
  const bar = TAB.slice(TAB.indexOf('<div v-if="auth.isSuperAdmin" class="cl-bar">'), TAB.indexOf('class="cl-actions"'))
  ok(/<div v-if="invoiceStatusOn" class="cl-field">\s*<label class="cl-label" for="cl-invoice-status">Invoice status<\/label>\s*<select id="cl-invoice-status" v-model="invoiceStatusChoice" class="dash-select cl-control cl-invoice-status">/.test(bar), '§7 FAILS ON THE OLD CODE: a labelled select in the Super Admin bar, while the rows have a status')
  ok(/<option value="">All invoice statuses<\/option>\s*<option v-for="o in invoiceStatusChoices" :key="o\.value" :value="o\.value">\{\{ o\.text \}\}<\/option>/.test(bar), '§7 FAILS ON THE OLD CODE: ...offering all, then the eight with their counts')
  ok(/const searchResult = computed\(\(\) => \{\s*const pool = filterByInvoiceStatus\(poolBeforeStatus\.value, invoiceStatusOn\.value \? invoiceStatusChoice\.value : ''\)\s*return searchLoads\(pool, searchQuery\.value, loadIdCol\.value\)/.test(TAB), '§7 FAILS ON THE OLD CODE: the list applies it, and only while the select is there')
  ok(/const invoiceStatusChoices = computed\(\(\) => invoiceStatusOptions\(searchLoads\(poolBeforeStatus\.value, searchQuery\.value, loadIdCol\.value\)\.rows\)\)/.test(TAB), '§7 FAILS ON THE OLD CODE: its counts are what picking each would list: the other filters and the search applied, not itself')
  ok(/watch\(invoiceStatusChoice, \(\) => goTo\(1\)\)/.test(TAB), '§7 FAILS ON THE OLD CODE: a choice goes back to page 1, like the other filters')
  ok(/watch\(invoiceStatusOn, \(on\) => \{ if \(!on\) invoiceStatusChoice\.value = '' \}\)/.test(TAB), '§7 FAILS ON THE OLD CODE: the select gone (the kill switch), the choice goes with it')
  ok(/const filtersActive = computed\(\(\) => !!\(driverFilter\.value \|\| fromDate\.value \|\| toDate\.value \|\| invoiceStatusChoice\.value\)\)/.test(TAB), '§7 FAILS ON THE OLD CODE: Clear and the count show for it')
  const clearSrc = liftFn(TAB, 'clearFilters')
  ok(clearSrc, '§7 clearFilters() is found')
  if (clearSrc) {
    const refs = { driverFilter: { value: 'a' }, fromDate: { value: 'b' }, toDate: { value: 'c' }, invoiceStatusChoice: { value: 'sent' } }
    new Function(...Object.keys(refs), `${clearSrc}\nclearFilters();`)(...Object.values(refs))
    eq(Object.values(refs).map((r) => r.value), ['', '', '', ''], '§7 FAILS ON THE OLD CODE: Clear clears it too')
  }
  ok(/const exportMatches = computed\(\(\) => \{(?:(?!invoiceStatus)[\s\S]){0,1400}?return pool\n\}\)/.test(TAB), '§7 the export\'s predicates stay the driver and the dates: the endpoint takes no status')
  ok(/const exportWiderThanTable = computed\(\(\) => canDownload\.value && \(!!searchQuery\.value\.trim\(\) \|\| needsReviewOnly\.value \|\| autoAttentionOnly\.value \|\| !!invoiceStatusChoice\.value\)\)/.test(TAB), '§7 FAILS ON THE OLD CODE: a choice makes the file wider than the table, so the note shows')
  ok(/<p v-if="exportWiderThanTable" class="cl-note">\{\{ exportNote \}\}<\/p>/.test(TAB), '§7 FAILS ON THE OLD CODE: the note is the computed one')
  const note = fnOf('exportNoteText')
  eq([note({ attention: false, status: false }), note({ attention: true, status: false }), note({ attention: false, status: true }), note({ attention: true, status: true })], [
    'Search and Needs Review aren’t applied to the downloaded file.',
    'Search, Needs Review and Needs attention aren’t applied to the downloaded file.',
    'Search, Needs Review and Invoice status aren’t applied to the downloaded file.',
    'Search, Needs Review, Needs attention and Invoice status aren’t applied to the downloaded file.',
  ], '§7 FAILS ON THE OLD CODE: the note names it, and with no status reads as today')
  const title = fnOf('attentionToggleTitle')
  eq([title({ on: false, statusShown: false }), title({ on: true, statusShown: false })], ['Show only loads whose automatic invoice draft needs attention', 'Showing only loads whose automatic invoice draft needs attention'], '§7 FAILS ON THE OLD CODE: with no status, the toggle\'s title is today\'s')
  ok(/can differ from the Invoice status filter/.test(title({ on: false, statusShown: true }) || '') && /load changed after its invoice went/.test(title({ on: false, statusShown: true }) || ''), '§7 FAILS ON THE OLD CODE: with the status on, it says why its number can differ from the select\'s')
  ok(/:title="autoToggleTitle"/.test(TAB), '§7 FAILS ON THE OLD CODE: the toggle reads that title')
  ok(/\.filter\(autoInvoiceNeedsAttention\)/.test(TAB) && !/_invoiceStatus/.test((/const autoAttentionCount = [^\n]*/.exec(TAB) || [''])[0]), '§7 the toggle still counts by the job\'s status')
  ok(/@media \(max-width: 640px\)[\s\S]{0,400}\.cl-invoice-status/.test(TAB), '§7 FAILS ON THE OLD CODE: on a phone the select takes the row, like the driver\'s')
}

// ------------------------------------------------------------------ §8
section('§8  Super Admin only')
{
  ok(/const invoiceStatusOn = computed\(\(\) => auth\.isSuperAdmin && props\.jobs\.some\(hasInvoiceStatus\)\)/.test(TAB), '§8 FAILS ON THE OLD CODE: the select and the filter are a Super Admin\'s, whatever a row carries')
  ok(/const autoChip = \(job\) => \(auth\.isSuperAdmin && job \? /.test(TAB), '§8 the chip refuses anyone else first')
  ok(/<span v-if="auth\.isSuperAdmin && autoChip\(job\)" class="auto-chip"/.test(TAB), '§8 ...on the row')
  const dialog = TAB.slice(TAB.indexOf('<template v-if="auth.isSuperAdmin">'), TAB.indexOf('<DialogDescription class="sr-only">Details for load'))
  ok(dialog.includes('selectedAutoChip'), '§8 ...and the dialog\'s line is inside the Super Admin block')
  ok(TAB.split('selectedAutoChip"').length - 1 === 1 && TAB.indexOf('<div v-if="auth.isSuperAdmin" class="cl-bar">') < TAB.indexOf('cl-invoice-status"'), '§8 the line has one place, and the select sits in the Super Admin bar')
  ok(/const exportNote = computed\(\(\) => exportNoteText\(\{ attention: auth\.isSuperAdmin && autoMode\.value !== 'off', status: invoiceStatusOn\.value \}\)\)/.test(TAB), '§8 FAILS ON THE OLD CODE: the note says "Invoice status" only where the select is')
}

// ------------------------------------------------------------------ §9
section('§9  the browser only words it')
{
  const LIB = fs.existsSync(CLIENT) ? fs.readFileSync(CLIENT, 'utf8') : ''
  const imports = [...LIB.matchAll(/^\s*import\b[^\n]*from '([^']+)'/gm)].map((m) => m[1])
  eq(imports.sort(), ['../utils/datetime.js', './autoInvoiceStatus.js'], '§9 FAILS ON THE OLD CODE: it imports only the job\'s words and the date helpers')
  ok(LIB && !/\bfetch\s*\(|useApi|\bref\(|from 'vue'|\bDate\(|Date\.now/.test(LIB), '§9 FAILS ON THE OLD CODE: no network, Vue or clock of its own')
  // A status is the server's: this file never reads what the rule reads to work one out.
  ok(LIB && !/_factoring|_draftInflight|sent_invoice|drafts_invoice|sent_mention|payments_(?:invoice|payment|status|checked)|searched_at|reason_code|\.delivery\b|\.stage\b/.test(LIB), '§9 FAILS ON THE OLD CODE: it reads none of the rule\'s evidence')
  ok(LIB && !/\bstatus:\s*'/.test(LIB), '§9 FAILS ON THE OLD CODE: it never writes a status onto a row')
  ok(!/_invoiceStatus\s*:\s*\{/.test(TAB), '§9 the page never writes a status onto a row either')
  eq(fnOf('statusAfterAction')('retry', { status: 'needs_attention', code: 'TOTAL_MISMATCH' }), undefined, '§9 Try again taken: no status, rather than one the browser chose')
  eq(fnOf('statusAfterAction')('checked', { status: 'sent', invoiceId: ID, changed: ['payment'] }), { status: 'sent', invoiceId: ID }, '§9 FAILS ON THE OLD CODE: Mark checked taken: the same status, without the mark the server just cleared')
}

console.log(`\n${'='.repeat(64)}`)
if (failures.length) {
  console.log(`FAILURES (${failures.length}):`)
  failures.forEach((f) => console.log(`  ✗ ${f}`))
  console.log(`\n${pass} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`✓ ${pass} assertions passed`)
