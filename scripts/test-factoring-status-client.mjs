#!/usr/bin/env node
// client/src/lib/factoringStatus.js and the screens that use it: factored loads
// (Triumph) and a Draft Invoice press whose Gmail draft may be there.
//
//   §1 the chip: "Factored (Triumph)" for a factored load, "final" once locked
//      (handed to Triumph, or handled in its process); nothing otherwise
//   §2 the switch and "Handled in Triumph's process" follow what the server
//      says (canMark, canRecordOutside), never a guess
//   §3 the "may be in Gmail" line: Check Gmail for a draft that may be there, a
//      person's answer for the fallback's; nothing to do while it is being saved
//   §4 the approve that may have saved a draft never says "Nothing was sent"
//   §5 every control is Super Admin only, and so is every call it makes; the
//      draft routes' callers stay CompletedLoadsTab.vue and the preview modal;
//      the switch's one line, word for word, only beside the switch and on no
//      other screen; each gate removed in turn is caught
//   §6 the four screens touched parse and compile (vue/compiler-sfc)
//   §7 a job's draft on a marked load says not to send it and to delete it, on the
//      row chip and in the dialog, while it may be in Gmail too; a load with no mark
//      reads as it did, in every state; a mark cleared after the run stopped on it
//      has its own chip, with nothing to retry; a job's draft whose mark was cleared
//      since doesn't read as ready; where it may already be sent, no line says the
//      invoice goes through Triumph, and the switch asks before it marks
//
// No network, no DOM, no database.
//   node scripts/test-factoring-status-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB = path.join(ROOT, 'client', 'src', 'lib', 'factoringStatus.js')
const DASH = path.join(ROOT, 'client', 'src', 'components', 'dashboard')
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
const S = fs.existsSync(LIB) ? await import(pathToFileURL(LIB).href) : null
const A = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'autoInvoiceStatus.js')).href)

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

if (!S) {
  failures.push('FAILS ON THE OLD CODE: client/src/lib/factoringStatus.js is missing')
} else {
  // ---------------------------------------------------------------- §1
  section('§1  the chip')
  eq(S.factoringChip({ factored: true, locked: false }), { label: 'Factored (Triumph)', tone: 'warn', reason: 'The invoice goes through Triumph, not by email. The Draft Invoice button refuses it.' },
    '§1 a factored load: "Factored (Triumph)", its invoice through Triumph')
  eq(S.factoringChip({ factored: true, locked: true, lockedVia: 'outside' }).reason, "Handled in Triumph's process. The app never invoices this load.", '§1 handled in Triumph\'s process: final')
  eq(S.factoringChip({ factored: true, locked: true, lockedVia: 'upload' }).label, 'Factored (Triumph): final', '§1 handed to Triumph: final')
  for (const v of [null, undefined, {}, { factored: false }, { factored: 'true' }, 'factored']) eq(S.factoringChip(v), null, `§1 nothing for ${JSON.stringify(v)}`)

  // ---------------------------------------------------------------- §2
  section('§2  who may act: what the server says')
  eq([S.canFactor({ canMark: true }), S.canFactor({ canMark: 'true' }), S.canFactor(null)], [true, false, false], '§2 the switch only when the server says canMark')
  eq([S.canRecordOutside({ canRecordOutside: true }), S.canRecordOutside({ factored: true }), S.canRecordOutside(undefined)], [true, false, false], "§2 \"Handled in Triumph's process\" only when the server says so")
  eq([S.reasonInput('  made-up\n reason  '), S.reasonInput('x'.repeat(250)).length, S.reasonInput(null)], ['made-up reason', 200, ''], '§2 a reason as the server keeps it: one line, at most 200')

  // ---------------------------------------------------------------- §3
  section('§3  the "may be in Gmail" line')
  eq(S.inflightLine({ state: 'maybe_drafted', invoiceId: '11032026-7', path: 'imap' }),
    { text: 'An invoice draft may be in Gmail (invoice #11032026-7). Check Gmail before drafting again.', canCheck: true, askPerson: false }, '§3 maybe drafted (IMAP): Check Gmail searches')
  eq(S.inflightLine({ state: 'maybe_drafted', invoiceId: '11032026-7', path: 'n8n' }).askPerson, true, '§3 maybe drafted (the fallback): a person answers')
  eq(S.inflightLine({ state: 'in_flight', invoiceId: '11032026-7', path: 'imap' }), { text: 'An invoice draft (invoice #11032026-7) is being saved now.', canCheck: false, askPerson: false }, '§3 in flight: nothing to do yet')
  eq([S.inflightLine(null), S.inflightLine({ state: 'other' })], [null, null], '§3 nothing for anything else')

  // ---------------------------------------------------------------- §4
  section('§4  an approve that may have saved a draft')
  eq([S.isMaybeSaved({ code: 'DRAFT_MAYBE_SAVED' }), S.isMaybeSaved({ code: 'DRAFT_SAVE_FAILED' }), S.isMaybeSaved(null)], [true, false, false], '§4 only DRAFT_MAYBE_SAVED')
}
{
  const MODAL = read(path.join(DASH, 'InvoiceDraftPreviewModal.vue'))
  const at = MODAL.indexOf('if (isMaybeSaved(e)) {')
  const nothing = MODAL.indexOf('Nothing was sent — your edits are still here.')
  ok(at > 0 && nothing > at && MODAL.slice(at, nothing).includes('return'), '§4 FAILS ON THE OLD CODE: the modal answers a maybe-saved draft before, and instead of, "Nothing was sent"')
}

// ---------------------------------------------------------------- §5
section('§5  Super Admin only')
const MARK_WORDS = "Mark before the driver taps Delivered. After the invoice goes out, this can't be undone here."
function controlsViolations(src) {
  const v = []
  if (!/<div v-if="auth\.isSuperAdmin && \(chip \|\| mayFactor \|\| mayRecord\)"/.test(src)) v.push('FactoringControls.vue is not Super Admin only')
  if (!src.includes(`<p v-if="mayFactor" class="fact-note">${MARK_WORDS}</p>`)) v.push("the switch's one line is not there word for word, beside the switch only")
  for (const fn of ['setFactored', 'recordOutside']) {
    if (!new RegExp(`async function ${fn}\\([^)]*\\) \\{\\n\\s*if \\(!auth\\.isSuperAdmin\\b`).test(src)) v.push(`${fn}() does not refuse a non-Super-Admin first`)
  }
  const calls = (src.match(/api\.post\(/g) || []).length
  if (calls !== 3) v.push(`expected three calls (mark, its confirmed retry, handled-outside), found ${calls}`)
  return v
}
function completedViolations(src) {
  const v = []
  const block = (needle) => {
    const at = src.indexOf(needle)
    if (at < 0) return false
    const open = src.lastIndexOf('<template v-if="auth.isSuperAdmin">', at)
    const close = src.indexOf('</template>', open)
    return open >= 0 && close > at && !src.slice(open + 10, at).includes('<template v-if="auth.isSuperAdmin">')
  }
  for (const [needle, what] of [['<FactoringControls', 'the factoring controls'], ['v-if="selectedInflight"', 'the "may be in Gmail" line'], ["@click=\"checkGmail('in_gmail')\"", "a person's answer"]]) {
    if (!block(needle)) v.push(`${what} is not inside the Super Admin block`)
  }
  if (!/const selectedInflight = computed\(\(\) => \(auth\.isSuperAdmin && /.test(src)) v.push('selectedInflight does not read for a Super Admin only')
  if (!/async function checkGmail\([^)]*\) \{\n\s*if \(!auth\.isSuperAdmin\b/.test(src)) v.push('checkGmail() does not refuse a non-Super-Admin first')
  return v
}
function activeViolations(src) {
  return /<FactoringControls v-if="auth\.isSuperAdmin"/.test(src) ? [] : ['ActiveLoadsTab.vue mounts the factoring controls for every role']
}
const CONTROLS = read(path.join(DASH, 'FactoringControls.vue'))
const COMPLETED = read(path.join(DASH, 'CompletedLoadsTab.vue'))
const ACTIVE = read(path.join(DASH, 'ActiveLoadsTab.vue'))
eq(controlsViolations(CONTROLS), [], '§5 FAILS ON THE OLD CODE: FactoringControls.vue shows to, and calls for, a Super Admin only')
eq(completedViolations(COMPLETED), [], '§5 FAILS ON THE OLD CODE: Completed Loads: the controls, the "may be in Gmail" line and Check Gmail are Super Admin only')
eq(activeViolations(ACTIVE), [], '§5 FAILS ON THE OLD CODE: Active Loads mounts the controls for a Super Admin only')
{
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(p)
    return /\.(vue|js|ts)$/.test(e.name) ? [p] : []
  })
  const files = walk(path.join(ROOT, 'client', 'src'))
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')
  eq(files.filter((f) => /\/api\/factoring\//.test(read(f))).map(rel), ['client/src/components/dashboard/FactoringControls.vue'], '§5 the factoring routes are called from FactoringControls.vue only')
  eq(files.filter((f) => /invoice-draft-inflight/.test(read(f))).map(rel), ['client/src/components/dashboard/CompletedLoadsTab.vue'], '§5 "Check Gmail" is called from Completed Loads only')
  eq(files.filter((f) => read(f).includes(MARK_WORDS)).map(rel), ['client/src/components/dashboard/FactoringControls.vue'], "§5 FAILS ON THE OLD CODE: the switch's one line is in FactoringControls.vue and on no other screen: a driver never sees it")
  eq(files.filter((f) => /FactoringControls/.test(read(f))).map(rel).sort(), ['client/src/components/dashboard/ActiveLoadsTab.vue', 'client/src/components/dashboard/CompletedLoadsTab.vue'], '§5 the controls are mounted on the two office tabs only')
}
for (const [name, file, src, check, from, to] of [
  ['the controls show to every role', 'FactoringControls.vue', CONTROLS, controlsViolations, '<div v-if="auth.isSuperAdmin && (chip || mayFactor || mayRecord)"', '<div v-if="chip || mayFactor || mayRecord"'],
  ['the line shows with no switch', 'FactoringControls.vue', CONTROLS, controlsViolations, '<p v-if="mayFactor" class="fact-note">', '<p class="fact-note">'],
  ['the line loses a word', 'FactoringControls.vue', CONTROLS, controlsViolations, 'After the invoice goes out, this', 'After the invoice goes, this'],
  ['setFactored() runs for every role', 'FactoringControls.vue', CONTROLS, controlsViolations, 'async function setFactored(next) {\n  if (!auth.isSuperAdmin || ', 'async function setFactored(next) {\n  if ('],
  ['Check Gmail runs for every role', 'CompletedLoadsTab.vue', COMPLETED, completedViolations, "async function checkGmail(answer = '') {\n  if (!auth.isSuperAdmin || ", "async function checkGmail(answer = '') {\n  if ("],
  ['the line reads for every role', 'CompletedLoadsTab.vue', COMPLETED, completedViolations, 'computed(() => (auth.isSuperAdmin && selectedJob.value ? inflightLine(', 'computed(() => (selectedJob.value ? inflightLine('],
  ['Active Loads mounts the controls for every role', 'ActiveLoadsTab.vue', ACTIVE, activeViolations, '<FactoringControls v-if="auth.isSuperAdmin"', '<FactoringControls v-if="true"'],
]) {
  if (src.split(from).length - 1 !== 1) { failures.push(`§5 mutant anchor not found once in ${file}: ${name}`); continue }
  ok(check(src.replace(from, to)).length > 0, `§5 MUTANT ${name}: caught`)
}

// ---------------------------------------------------------------- §6
section('§6  the screens compile')
{
  const { createRequire } = await import('module')
  const clientRequire = createRequire(path.join(ROOT, 'client', 'package.json'))
  const { parse, compileScript } = clientRequire('vue/compiler-sfc')
  for (const name of ['FactoringControls.vue', 'CompletedLoadsTab.vue', 'ActiveLoadsTab.vue', 'InvoiceDraftPreviewModal.vue']) {
    let problem = ''
    try {
      const { descriptor, errors } = parse(read(path.join(DASH, name)), { filename: name })
      if (errors.length) problem = String(errors[0] && errors[0].message)
      else compileScript(descriptor, { id: name, inlineTemplate: true })
    } catch (e) {
      problem = String(e && e.message).slice(0, 200)
    }
    eq(problem, '', `§6 ${name} parses and compiles (script and template)`)
  }
}

// ---------------------------------------------------------------- §7
section("§7  a job's draft on a marked load; a mark cleared after the run stopped on it")
{
  // A tree without the row's own chip reads the status alone, so these fail by name.
  const rowChip = (row) => (A.autoInvoiceRowChip ? A.autoInvoiceRowChip(row) : A.autoInvoiceChip(row && row._autoInvoice))
  const MARKED = Object.freeze({ factored: true, locked: false, lockedVia: '', triumphState: '', canMark: false, canRecordOutside: false })
  const LABEL = "Factored: don't send the draft, delete it"
  const dontSend = (what) => `Don't send ${what}: this load is marked factored. If its draft is in Gmail Drafts, delete it. If it's in Sent Mail, it already went to the broker, so tell whoever manages factored loads.`
  const drafted = Object.freeze({ state: 'drafted', code: '', invoiceId: '10202026-1', changed: [] })

  eq(rowChip({ _autoInvoice: drafted, _factoring: MARKED }), { label: LABEL, tone: 'bad', reason: dontSend('invoice 10202026-1') },
    "§7 FAILS ON THE OLD CODE: a job's draft on a marked load says not to send it and to delete it")
  eq(rowChip({ _autoInvoice: { ...drafted, invoiceId: '' }, _factoring: MARKED }), { label: LABEL, tone: 'bad', reason: dontSend('the invoice draft') },
    '§7 FAILS ON THE OLD CODE: ...with no number on the status, the same')
  eq(rowChip({ _autoInvoice: { ...drafted, changed: ['payment'] }, _factoring: MARKED }), { label: LABEL, tone: 'bad', reason: dontSend('invoice 10202026-1') },
    '§7 FAILS ON THE OLD CODE: ...and a draft whose load changed since doesn\'t say to check it in Gmail')
  eq(rowChip({ _autoInvoice: drafted, _factoring: { ...MARKED, locked: true, lockedVia: 'outside' } }), { label: LABEL, tone: 'bad', reason: dontSend('invoice 10202026-1') },
    '§7 FAILS ON THE OLD CODE: ...a load handled in Triumph\'s process, the same')
  for (const code of ['MAYBE_IN_GMAIL', 'IN_GMAIL_UNRECORDED']) {
    const maybe = { state: 'needs_attention', code, invoiceId: '', changed: [], trigger: true, retry: 'search' }
    eq(rowChip({ _autoInvoice: maybe, _factoring: MARKED }), { label: LABEL, tone: 'bad', reason: `${dontSend('the invoice draft')} ${A.AUTO_INVOICE_REASONS[code].text}` },
      `§7 FAILS ON THE OLD CODE: ${code} on a marked load says it too, before what Try again does`)
    eq([A.canTryAgain(maybe), A.autoInvoiceNeedsAttention({ _autoInvoice: maybe, _factoring: MARKED })], [true, true], `§7 ...${code}: Try again and the toggle as they were`)
  }
  for (const code of Object.keys(A.AUTO_INVOICE_REASONS)) {
    const chip = rowChip({ _autoInvoice: { state: 'needs_attention', code }, _factoring: MARKED })
    ok(!/send it/.test(`${chip.label} ${chip.reason}`), `§7 no sentence tells a person to send a marked load's invoice (${code})`)
  }
  ok(!/send it/.test(rowChip({ _autoInvoice: drafted, _factoring: MARKED }).reason), "§7 FAILS ON THE OLD CODE: the drafted chip doesn't say to send it")

  // With no mark, every status reads exactly as it did.
  const everyStatus = [
    drafted, { ...drafted, invoiceId: '' }, { ...drafted, changed: ['payment'] }, { ...drafted, sent: true }, { ...drafted, sent: true, changed: ['payment'] },
    { state: 'queued', code: '' }, { state: 'working', code: '' }, { state: 'waiting', code: '' },
    ...Object.keys(A.AUTO_INVOICE_REASONS).flatMap((code) => ['waiting', 'queued', 'needs_attention'].map((state) => ({ state, code }))),
    null, undefined, 'drafted', {},
  ]
  let differing = 0
  for (const status of everyStatus) {
    const was = A.autoInvoiceChip(status)
    for (const factoring of [undefined, null, { factored: false }, { factored: 'true' }, {}, 'factored']) {
      if (JSON.stringify(rowChip({ _autoInvoice: status, _factoring: factoring })) !== JSON.stringify(was)) differing++
    }
  }
  eq(differing, 0, `§7 no mark: all ${everyStatus.length} statuses read as autoInvoiceChip() reads them`)
  // A mark changes the draft's words only: what was sent stays said, and other codes are as they were.
  eq(rowChip({ _autoInvoice: { ...drafted, sent: true }, _factoring: MARKED }), A.autoInvoiceChip({ ...drafted, sent: true }), '§7 an invoice the job sent still reads "Sent to the broker"')
  for (const code of ['TOTAL_MISMATCH', 'MAYBE_SENT', 'NOT_BY_DRIVER']) {
    const status = { state: 'needs_attention', code }
    eq(rowChip({ _autoInvoice: status, _factoring: MARKED }), A.autoInvoiceChip(status), `§7 ${code} on a marked load: its own words, as before`)
  }
  eq([rowChip({ _factoring: MARKED }), A.autoInvoiceRowChip ? A.autoInvoiceRowChip(null) : null], [null, null], '§7 a marked load with no status, and no row: nothing')

  // Both places a Super Admin reads it: the row and the dialog.
  const TAB = read(path.join(DASH, 'CompletedLoadsTab.vue'))
  ok(TAB.includes('const autoChip = (job) => (auth.isSuperAdmin && job ? autoInvoiceRowChip(job) : null)'), '§7 FAILS ON THE OLD CODE: the row chip reads the row, its mark included')
  ok(TAB.includes('const selectedAutoChip = computed(() => autoChip(selectedJob.value))'), '§7 ...and so does the dialog, through the same function')
  ok(!TAB.includes('autoInvoiceChip('), '§7 FAILS ON THE OLD CODE: Completed Loads never words a status without its row')

  // A mark cleared after the run stopped on it. A code with no words throws in the chip's own
  // branch, so it's read here to fail by name.
  const cleared = { state: 'needs_attention', code: 'FACTORED_MARK_CLEARED', invoiceId: '', changed: [], trigger: true, retry: 'none' }
  const readChip = (status) => { try { return A.autoInvoiceChip(status) } catch (e) { return `threw: ${e && e.message}` } }
  eq(readChip(cleared), { label: 'No automatic invoice', tone: 'warn', reason: 'This load was marked factored when its invoice came due, so no automatic invoice was made. The mark has been cleared, so draft it by hand.' },
    '§7 FAILS ON THE OLD CODE: a mark cleared after the run stopped on it has its own true sentence')
  eq(A.autoInvoiceNeedsAttention({ _autoInvoice: cleared }), true, '§7 ...the toggle counts it, so it can\'t be forgotten')
  eq([A.canTryAgain(cleared), A.canTryAgain({ state: 'needs_attention', code: 'FACTORED_MARK_CLEARED' }), A.canMarkChecked(cleared)], [false, false, false], '§7 FAILS ON THE OLD CODE: ...nothing to retry: a person drafts it')

  // A job's draft whose mark was cleared since: it may have been deleted as the chip said.
  const clearedDraft = Object.freeze({ ...drafted, markCleared: true })
  const CLEARED_DRAFT = { label: 'Mark cleared: check Gmail Drafts', tone: 'warn', reason: "This load's mark was cleared. If its draft was deleted while it was marked, draft it by hand. If it's still in Gmail Drafts, check it and send it." }
  eq(readChip(clearedDraft), CLEARED_DRAFT, '§7 FAILS ON THE OLD CODE: a draft whose mark was cleared since reads neither green nor "is in Gmail Drafts"')
  eq(readChip({ ...clearedDraft, changed: ['payment'] }), CLEARED_DRAFT, '§7 FAILS ON THE OLD CODE: ...its load changed too: the same')
  eq(readChip({ ...clearedDraft, sent: true }).label, 'Sent to the broker', '§7 ...an invoice the job sent still reads as sent')
  eq([A.autoInvoiceNeedsAttention({ _autoInvoice: clearedDraft }), A.canTryAgain(clearedDraft)], [false, false], '§7 ...it counts for nothing a person could ever clear, and has no Try again')

  // Where it may already be sent: no line says the invoice goes through Triumph.
  for (const [label, status] of [['a job\'s draft', drafted], ['MAYBE_IN_GMAIL', { state: 'needs_attention', code: 'MAYBE_IN_GMAIL' }], ['IN_GMAIL_UNRECORDED', { state: 'needs_attention', code: 'IN_GMAIL_UNRECORDED' }]]) {
    ok(!/through Triumph/.test(rowChip({ _autoInvoice: status, _factoring: MARKED }).reason), `§7 FAILS ON THE OLD CODE: ${label}, marked: the row doesn't say the invoice goes through Triumph`)
  }
  const mayBeOut = (status) => (A.draftMayBeOut ? A.draftMayBeOut(status) : false)
  eq([drafted, { ...drafted, sent: true }, { state: 'needs_attention', code: 'MAYBE_IN_GMAIL' }, { state: 'needs_attention', code: 'IN_GMAIL_UNRECORDED' }].map(mayBeOut), [true, true, true, true],
    '§7 FAILS ON THE OLD CODE: a job\'s draft, an invoice it sent and both may-be codes may already be out')
  eq([{ state: 'needs_attention', code: 'TOTAL_MISMATCH' }, { state: 'queued', code: '' }, { state: 'waiting', code: 'MAYBE_IN_GMAIL' }, null, undefined, 'drafted'].map((s) => (A.draftMayBeOut ? A.draftMayBeOut(s) : false)), [false, false, false, false, false, false], '§7 ...nothing else is')
  eq(S.factoringChip(MARKED, { draftMayBeOut: true }), { label: 'Factored (Triumph)', tone: 'warn', reason: 'The app sends no invoice for it by email, and the Draft Invoice button refuses it.' },
    '§7 FAILS ON THE OLD CODE: the factoring line beside such a draft doesn\'t say it goes through Triumph')
  eq(S.factoringChip(MARKED, { draftMayBeOut: false }).reason, S.factoringChip(MARKED).reason, '§7 ...with no draft out, its usual words')
  eq(S.factoringChip({ ...MARKED, locked: true, lockedVia: 'outside' }, { draftMayBeOut: true }).reason, "Handled in Triumph's process. The app never invoices this load.", '§7 ...a final row, its own words')
  const ask = (code) => (S.notSentQuestion ? S.notSentQuestion(code) : '')
  eq(ask('INVOICE_ALREADY_DRAFTED'), 'An invoice draft already exists for this load. Was it NOT sent to the broker? If you confirm, delete that draft in Gmail.', '§7 FAILS ON THE OLD CODE: the switch\'s question on a draft row, as it was')
  eq(ask('INVOICE_MAYBE_IN_GMAIL'), 'An invoice draft for this load may be in Gmail, or may already have been sent from there. Was it NOT sent to the broker? If you confirm, delete any draft in Gmail.', '§7 FAILS ON THE OLD CODE: the switch asks on a draft that may be in Gmail')
  eq([ask('LOAD_FACTORED'), ask(''), ask(undefined), ask('constructor')], ['', '', '', ''], '§7 ...and on nothing else')
  ok(CONTROLS.includes('notSentQuestion(e.code)') && CONTROLS.includes('draftMayBeOut: draftMayBeOut(props.job && props.job._autoInvoice)'), '§7 FAILS ON THE OLD CODE: the switch reads the question and the row\'s status from those two')
  ok(CONTROLS.includes("'Marked factored. If a draft is in Gmail Drafts, delete it.'"), '§7 FAILS ON THE OLD CODE: a mark that had to ask answers without saying it goes through Triumph')
}

console.log(`\n${pass} passed, ${failures.length} failed`)
for (const f of failures) console.log(`FAIL  ${f}`)
process.exit(failures.length ? 1 : 0)
