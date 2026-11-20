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
//   §8 the note box, labelled "Note (required)", asks the shared login for its name and why
//      (saying why it asks), and every other account why; the server's rows name the shared
//      login in the screens' own words; each rule changed in turn is caught
//   §9 Process with Triumph: every tile row of the plan's §1.3 in order, Try again only on a
//      stop a retry can change (the server's own list); Clear factored and "Factor with
//      Triumph" as two buttons on the server's word, one of them where the one switch was
//      with the switch off; the chip names the broker's invoice; the button beside Draft
//      Invoice Email, Super Admin only, one press with no question; mutants of each
//   §10-§15 the Triumph status plan, Part 1: the step line (§10); the calm line, the wait words
//      and the retry's try count (§11); the chip by the tile's own table (§12); the too-large
//      words with the server's numbers, and "under Other options" (§13); Other options, folded
//      and shown on the server's word, each help line beside its own button (§14); the open load
//      taking the fresh row on every read of the dashboard, and the step line on it (§15);
//      mutants of each
//
// No network, no DOM, no database.
//   node scripts/test-factoring-status-client.mjs      # exits 1 on any failure

import fs from 'fs'
import os from 'os'
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
  if (!/<div v-if="auth\.isSuperAdmin && \(chip \|\| mayFactor \|\| mayClear \|\| mayRecord \|\| result\)"/.test(src)) v.push('FactoringControls.vue is not Super Admin only')
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
  eq(files.filter((f) => /\/api\/factoring\/loads\//.test(read(f))).map(rel), ['client/src/components/dashboard/FactoringControls.vue'], '§5 the marking routes are called from FactoringControls.vue only')
  eq(files.filter((f) => /\/api\/factoring\/(?:process-with-triumph|triumph-retry)/.test(read(f))).map(rel), ['client/src/components/dashboard/CompletedLoadsTab.vue'], '§5 FAILS ON THE OLD CODE: Process with Triumph and its Try again are called from Completed Loads only')
  eq(files.filter((f) => /\/api\/factoring\//.test(read(f))).map(rel).sort(), ['client/src/components/dashboard/CompletedLoadsTab.vue', 'client/src/components/dashboard/FactoringControls.vue'], '§5 ...and no other screen calls a factoring route')
  eq(files.filter((f) => /invoice-draft-inflight/.test(read(f))).map(rel), ['client/src/components/dashboard/CompletedLoadsTab.vue'], '§5 "Check Gmail" is called from Completed Loads only')
  eq(files.filter((f) => read(f).includes(MARK_WORDS)).map(rel), ['client/src/components/dashboard/FactoringControls.vue'], "§5 FAILS ON THE OLD CODE: the switch's one line is in FactoringControls.vue and on no other screen: a driver never sees it")
  eq(files.filter((f) => /FactoringControls/.test(read(f))).map(rel).sort(), ['client/src/components/dashboard/ActiveLoadsTab.vue', 'client/src/components/dashboard/CompletedLoadsTab.vue'], '§5 the controls are mounted on the two office tabs only')
}
for (const [name, file, src, check, from, to] of [
  ['the controls show to every role', 'FactoringControls.vue', CONTROLS, controlsViolations, '<div v-if="auth.isSuperAdmin && (chip || mayFactor || mayClear || mayRecord || result)"', '<div v-if="chip || mayFactor || mayClear || mayRecord || result"'],
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
  const CLEARED_DRAFT = { label: 'Mark cleared: check Gmail', tone: 'warn', reason: "This load's mark was cleared. If its draft is still in Gmail Drafts, check it and send it. If it's in Sent Mail, it already went to the broker. If it's in neither, draft it by hand." }
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
  ok(CONTROLS.includes("const question = next && e ? notSentQuestion(e.code) : ''") && CONTROLS.includes('draftMayBeOut: draftMayBeOut(props.job && props.job._autoInvoice)'), '§7 FAILS ON THE OLD CODE: the switch reads the question and the row\'s status from those two')
  ok(CONTROLS.includes("'Marked factored. If a draft is in Gmail Drafts, delete it.'"), '§7 FAILS ON THE OLD CODE: a mark that had to ask answers without saying it goes through Triumph')
}

// ---------------------------------------------------------------- §8
section("§8  the reason box's hint on the shared login")
{
  const SL = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'utils', 'sharedLogin.js')).href)
  // The Triumph status plan, 3e: the box is labelled "Note (required)"; its hint asks why, and the
  // shared login also for a name, saying why it asks.
  const HINT_SHARED = 'Your name and why: this login is shared, so the app asks who you are'
  const HINT = 'Why'
  // The hint for each account: the shared login's rows name the login, not a person, so it is asked for a name.
  const hintViolations = (mod) => {
    if (!mod || typeof mod.reasonHint !== 'function') return ['reasonHint() is missing']
    const v = []
    for (const name of ['super_admin', ' Super_Admin ']) if (mod.reasonHint(name) !== HINT_SHARED) v.push(`the shared login (${JSON.stringify(name)}) is not asked for its name and why`)
    for (const name of ['made-up-admin', '', null, undefined]) if (mod.reasonHint(name) !== HINT) v.push(`${JSON.stringify(name)} is not asked for a reason as before`)
    return v
  }
  const BOX = '<input :id="noteId" v-model="reason" class="fact-reason" type="text" maxlength="200" :placeholder="hint" :disabled="busy" />'
  const LABEL = '<label class="fact-label" :for="noteId">{{ NOTE_LABEL }}</label>'
  const HINT_LINE = 'const hint = computed(() => reasonHint(auth.user?.username))'
  const boxViolations = (src) => {
    const v = []
    if (!src.includes(BOX)) v.push('the note box does not show the hint')
    if (!src.includes(LABEL) || !src.includes('const noteId = useId()')) v.push('the note box has no label of its own')
    if (!src.includes(HINT_LINE)) v.push("the hint is not the signed-in account's")
    if (src.includes('placeholder="Reason (required)"')) v.push('a fixed placeholder is left')
    return v
  }
  eq(hintViolations(S), [], `§8 FAILS ON THE OLD CODE (3e): "${HINT_SHARED}" on the shared login, however spelled; "${HINT}" for any other account`)
  eq(S && S.NOTE_LABEL, 'Note (required)', '§8 FAILS ON THE OLD CODE (3e): the box is labelled "Note (required)"')
  eq(boxViolations(CONTROLS), [], "§8 FAILS ON THE OLD CODE (3e): the note box is labelled and shows the signed-in account's hint, and no fixed one")
  ok(read(path.join(ROOT, 'lib', 'sign-in.js')).includes(`const SHARED_LOGIN_NOTE = "${SL.SHARED_LOGIN_NOTE}";`),
    "§8 FAILS ON THE OLD CODE: the server's rows (factoring, an automatic invoice's start) name the shared login in the screens' own words, kept beside isSharedLoginName()")
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(p)
    return /\.(vue|js|ts)$/.test(e.name) ? [p] : []
  })
  eq(walk(path.join(ROOT, 'client', 'src')).filter((f) => read(f).includes(HINT_SHARED)).map((f) => path.relative(ROOT, f).split(path.sep).join('/')), ['client/src/lib/factoringStatus.js'],
    '§8 FAILS ON THE OLD CODE: the hint is worded in one place')

  // Each rule changed in turn: the module's in a temp copy beside its import, the box's as text.
  const LIB_SRC = read(LIB)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factoring-hint-'))
  try {
    fs.mkdirSync(path.join(tmp, 'lib'))
    fs.mkdirSync(path.join(tmp, 'utils'))
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}\n')
    fs.copyFileSync(path.join(ROOT, 'client', 'src', 'utils', 'sharedLogin.js'), path.join(tmp, 'utils', 'sharedLogin.js'))
    let n = 0
    for (const [name, from, to] of [
      ['the hint asks everyone for a name', `(isSharedLogin(username) ? '${HINT_SHARED}'`, `(true ? '${HINT_SHARED}'`],
      ['the hint asks no one for a name', `(isSharedLogin(username) ? '${HINT_SHARED}'`, `(false ? '${HINT_SHARED}'`],
      ['the hint loses its words', `'${HINT_SHARED}'`, "'Your name and why'"],
    ]) {
      if (LIB_SRC.split(from).length - 1 !== 1) { failures.push(`§8 mutant anchor not found once in factoringStatus.js: ${name}`); continue }
      const file = path.join(tmp, 'lib', `factoringStatus-${++n}.js`)
      fs.writeFileSync(file, LIB_SRC.replace(from, to))
      let v
      try { v = hintViolations(await import(pathToFileURL(file).href)) } catch (e) { v = [`threw: ${e && e.message}`] }
      ok(v.length > 0, `§8 MUTANT ${name}: caught`)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  for (const [name, from, to] of [
    ['the box keeps a fixed placeholder', ':placeholder="hint"', 'placeholder="Reason (required)"'],
    ['the hint read from the role, not the account', 'reasonHint(auth.user?.username)', 'reasonHint(auth.user?.role)'],
    ['the box without its label (3e)', LABEL, ''],
  ]) {
    if (CONTROLS.split(from).length - 1 !== 1) { failures.push(`§8 mutant anchor not found once in FactoringControls.vue: ${name}`); continue }
    ok(boxViolations(CONTROLS.replace(from, to)).length > 0, `§8 MUTANT ${name}: caught`)
  }
}

// ---------------------------------------------------------------- §9
section('§9  Process with Triumph: the button, the tile, the chip')
{
  const { createRequire } = await import('module')
  const serverStore = createRequire(path.join(ROOT, 'package.json'))(path.join(ROOT, 'lib', 'factoring-store.js'))
  const LIB_SRC = read(LIB)
  const has = (fn) => Boolean(S && typeof S[fn] === 'function')
  for (const fn of ['triumphTile', 'canProcess', 'canClear', 'canMarkFactored', 'pressFailure'].filter((f) => !has(f))) failures.push(`§9 FAILS ON THE OLD CODE: factoringStatus.js has no ${fn}()`)
  const N = '11102026-4'
  const D = '2026-11-10'
  const fmt = (iso) => `at ${iso}`
  const base = { factored: true, locked: false, lockedVia: '', byButton: true, canClear: true, canRetry: true, triumphStage: 'reserved', triumphAt: '', brokerInvoiceId: N, brokerInvoiceDate: D, paused: '' }
  const tileViolations = (L) => {
    const v = []
    if (!L || typeof L.triumphTile !== 'function') return ['no triumphTile()']
    const t = (over) => L.triumphTile({ ...base, ...over }, { formatTime: fmt })
    const want = (label, got, text, tryAgain) => { if (!got || got.text !== text || got.tryAgain !== tryAgain) v.push(`${label}: ${JSON.stringify(got)}`) }
    want('the mark cleared', t({ factored: false, triumphState: 'queued' }), "Not sent to Triumph. The broker's invoice already went out as usual.", false)
    want('queued while paused', t({ triumphState: 'queued', paused: 'LOGIN_REFUSED' }), "Paused: Triumph refused the app's sign-in. The broker's invoice already went out as usual.", false)
    want('queued', t({ triumphState: 'queued' }), 'Sending to Triumph…', false)
    want('working', t({ triumphState: 'working', paused: 'LOGIN_REFUSED' }), 'Sending to Triumph…', false)
    want('submitted', t({ triumphState: 'submitted', locked: true, lockedVia: 'upload', triumphAt: '2026-11-12T15:30:00.000Z' }), 'Sent to Triumph · at 2026-11-12T15:30:00.000Z', false)
    want('waiting', t({ triumphState: 'waiting', triumphCode: 'INVOICE_DRAFT_IN_FLIGHT' }), 'Waiting: an invoice draft for this load is being saved.', false)
    want('maybe submitted', t({ triumphState: 'needs_attention', triumphCode: 'MAYBE_SUBMITTED', triumphStage: 'csv_uploading', canClear: false, canRetry: false }), "May have reached Triumph: a person checks Triumph's side.", false)
    want('a stop after the lock', t({ triumphState: 'needs_attention', triumphCode: 'INVOICE_TOO_OLD', triumphStage: 'pdf_uploading', locked: true, lockedVia: 'upload', canClear: false, canRetry: false }),
      "Its PDF may be on Triumph's server, but nothing was triggered there. The mark stays locked; a person checks Triumph's side.", false)
    for (const code of L.BUTTON_STOPS || []) {
      // Even a row that says canRetry gets no Try again on these.
      const got = t({ triumphState: 'needs_attention', triumphCode: code })
      if (!got || got.tryAgain !== false || !got.text.startsWith('Not sent to Triumph: ') || !got.text.endsWith("The broker's invoice already went out as usual. To keep it with the broker only, press Clear factored under Other options.")) v.push(`${code}: ${JSON.stringify(got)}`)
    }
    want('another code', t({ triumphState: 'needs_attention', triumphCode: 'SUBMIT_FAILED' }), "Not sent to Triumph: the upload to Triumph kept failing. The broker's invoice already went out as usual. Press Try again, or Clear factored under Other options to keep it with the broker only.", true)
    want('another code, not listed', t({ triumphState: 'needs_attention', triumphCode: 'SUBMIT_FAILED', canClear: false, canRetry: false }), "Not sent to Triumph: the upload to Triumph kept failing. The broker's invoice already went out as usual.", false)
    want('handled outside', t({ triumphState: 'closed_outside', locked: true, lockedVia: 'outside' }), "Handled in Triumph's process. Invoiced to the broker: 11102026-4, 11/10/2026.", false)
    want('skipped', t({ triumphState: 'skipped', triumphCode: 'FACTORING_LOCKED' }), "Not sent to Triumph: its mark is final. The broker's invoice already went out as usual.", false)
    if (L.triumphTile({ ...base, byButton: false, triumphState: 'queued' }) !== null) v.push('a claim the button did not arm has a tile')
    if (L.triumphTile({ factored: false, canMark: true }) !== null) v.push('a row with no claim has a tile')
    return v
  }
  eq(S ? tileViolations(S) : ['no module'], [], '§9 FAILS ON THE OLD CODE: every tile row of plan §1.3 in order, Try again only where it can change the stop (N-L1, N-L2, N2-L2)')
  eq(S && S.BUTTON_STOPS ? [...S.BUTTON_STOPS].sort() : null, serverStore.BUTTON_STOPS ? [...serverStore.BUTTON_STOPS].sort() : 'none on the server', "§9 FAILS ON THE OLD CODE: the codes a retry can't change are the server's own")
  // Clear factored on its own; "Factor with Triumph" only on a load not yet factored. With the switch
  // off (no canClear on the row), the same one button shows as before.
  const actions = (f) => (has('canMarkFactored') && has('canClear') ? [S.canMarkFactored(f) ? 'Factor with Triumph' : '', S.canClear(f) ? 'Clear factored' : ''].filter(Boolean) : null)
  eq([actions({ factored: false, canMark: true }), actions({ factored: true, canMark: true }), actions({ factored: true, canMark: false }), actions({ factored: true, locked: true, canMark: false })],
    [['Factor with Triumph'], ['Clear factored'], [], []], '§9 FAILS ON THE OLD CODE: the switch off: "Factor with Triumph" or "Clear factored", exactly where the one switch showed each')
  eq([actions({ factored: true, canMark: false, canClear: true }), actions({ factored: true, canMark: false, canClear: false }), actions({ factored: false, canMark: false, canClear: false })],
    [['Clear factored'], [], []], '§9 FAILS ON THE OLD CODE (N-L6): the switch on: no "Factor with Triumph" anywhere; Clear factored where the server says')
  eq(has('canProcess') && has('canRetryTriumph') ? [S.canProcess({ canProcess: true }), S.canProcess({ canProcess: 'true' }), S.canProcess(null), S.canRetryTriumph({ canRetry: 1 })] : null, [true, false, false, false], '§9 FAILS ON THE OLD CODE: the button and Try again: the server\'s own true, nothing else')
  // L7: the chip names the invoice the broker got, never "not by email".
  const chip = (over) => (S ? S.factoringChip({ ...base, ...over }) : null)
  eq([chip({}).reason, chip({ locked: true, lockedVia: 'upload' }).reason, chip({ locked: true, lockedVia: 'outside' }).reason],
    ['Invoiced to the broker: 11102026-4, 11/10/2026. The Draft Invoice button refuses it.', 'Sent to Triumph. Invoiced to the broker: 11102026-4, 11/10/2026.', "Handled in Triumph's process. Invoiced to the broker: 11102026-4, 11/10/2026."],
    '§9 FAILS ON THE OLD CODE (L7, M2): a load the button took: the chip names the broker\'s invoice, never "Triumph gets the same invoice"; "Sent to Triumph" once handed over')
  ok(S && !/not by email|never invoices/.test(JSON.stringify([chip({}), chip({ locked: true, lockedVia: 'upload' }), chip({ locked: true, lockedVia: 'outside' })])), '§9 (L7) ...and never says "not by email" or that the app never invoices it')
  eq(S ? S.factoringChip({ factored: true, locked: true, lockedVia: 'upload' }).reason : null, 'Handed to Triumph. The app never invoices this load again.', '§9 a load marked any other way: the chip as before')
  // M1: only a refusal the press made before any write says "Not sent to Triumph". A second press,
  // no answer, or an answer the press didn't name may follow a write: none of them says "not sent".
  const UNCONFIRMED = "The app couldn't confirm the send: it may be on its way to Triumph. Reload the load to see where it stands."
  const PRESS_REFUSED = [
    { status: 409, code: 'NOT_CHR', message: 'Only C.H. Robinson loads can go to Triumph from this button for now. Invoice this one the usual way.' },
    { status: 503, code: 'SUBMIT_PAUSED', message: 'Sending to Triumph is paused right now, so nothing was marked. Try again once it resumes.' },
    { status: 503, code: 'RECORDS_UNREADABLE', message: "This load's records couldn't be read, so nothing was marked. Try again in a minute." },
  ]
  const PRESS_ALREADY = [
    { status: 409, code: 'TRIUMPH_ALREADY', message: 'This load is already on its way to Triumph.' },
    { status: 409, code: 'FACTORING_LOCKED', message: 'This load was handed to Triumph, so its invoice is final there. Nothing can change it in the app.' },
  ]
  const PRESS_UNKNOWN = [
    { status: 0, code: 'TIMEOUT', message: 'The request timed out. Please check your connection and try again.' },
    { message: 'Failed to fetch' },
    { status: 500, code: '', message: 'Request failed (500)' },
    { status: 502, code: '', message: 'Request failed (502)' },
    { status: 504, code: '', message: 'Request failed (504)' },
    { status: 503, code: 'MADE_UP_OTHER', message: 'Made-up words the press never answers with.' },
  ]
  const pressViolations = (M) => {
    if (!M || typeof M.pressFailure !== 'function') return ['no pressFailure()']
    const v = []
    for (const e of PRESS_REFUSED) { const o = M.pressFailure(e); if (o.kind !== 'refused' || o.tone !== 'bad' || o.text !== `Not sent to Triumph. ${e.message}`) v.push(`refused ${e.code}`) }
    for (const e of PRESS_ALREADY) { const o = M.pressFailure(e); if (o.kind !== 'already' || o.tone === 'bad' || o.text !== e.message) v.push(`already ${e.code}`) }
    for (const e of PRESS_UNKNOWN) { const o = M.pressFailure(e); if (o.kind !== 'unknown' || o.tone === 'bad' || o.text !== UNCONFIRMED) v.push(`unknown ${e.status}`) }
    return v
  }
  eq(has('pressFailure') ? PRESS_REFUSED.map((e) => S.pressFailure(e)) : null, PRESS_REFUSED.map((e) => ({ kind: 'refused', tone: 'bad', text: `Not sent to Triumph. ${e.message}` })),
    '§9 FAILS ON THE OLD CODE: a refusal the press made before any write: "Not sent to Triumph" and the server\'s words')
  eq(has('pressFailure') ? PRESS_ALREADY.map((e) => S.pressFailure(e)) : null, PRESS_ALREADY.map((e) => ({ kind: 'already', tone: 'muted', text: e.message })),
    '§9 FAILS ON THE OLD CODE (M1): a second press never says "Not sent": the server\'s words, until the load\'s own line reads')
  eq(has('pressFailure') ? PRESS_UNKNOWN.map((e) => S.pressFailure(e)) : null, PRESS_UNKNOWN.map(() => ({ kind: 'unknown', tone: 'warn', text: UNCONFIRMED })),
    '§9 FAILS ON THE OLD CODE (M1): no answer, or one the press didn\'t name, never says "Not sent": it may be on its way, and the load is read again')
  ok(has('pressFailure') && ![...PRESS_ALREADY, ...PRESS_UNKNOWN].some((e) => /not sent|by hand|portal/i.test(S.pressFailure(e).text)), '§9 (M1) ...and none of those says "not sent" or asks for anything by hand')
  // L5: plain words for each stop the review listed, never "the app stopped it (CODE)".
  const PLAIN_STOPS = ['LOAD_DROPPED', 'NOT_COMPLETED', 'NO_DELIVERY_DATE', 'ADVANCE_LINES', 'NO_BROKER_EMAIL', 'BROKER_EMAIL_FREEMAIL', 'BROKER_DOMAIN_UNCONFIRMED', 'RATECON_TOTAL_UNREAD', 'RECIPIENT_DOMAIN_MISMATCH', 'STAGE_INVALID', 'LOCK_MISSING']
  const unworded = (M) => PLAIN_STOPS.filter((c) => typeof M.triumphStopWords !== 'function' || /^the app stopped it \(|[A-Z]{2,}_[A-Z]/.test(M.triumphStopWords(c)))
  eq(S ? unworded(S) : PLAIN_STOPS, [], '§9 FAILS ON THE OLD CODE (L5): plain words for each of these stops, never "the app stopped it (CODE)"')
  // The Completed tab: beside Draft Invoice Email, Super Admin only, one press with no question.
  const completedButtonViolations = (src) => {
    const v = []
    const draftAt = src.indexOf("'✉ Draft Invoice Email'")
    const btnAt = src.indexOf('@click="processWithTriumph"')
    const rowEnd = src.indexOf('</div>', draftAt)
    if (!(draftAt > 0 && btnAt > draftAt && btnAt < rowEnd)) v.push('the button is not beside Draft Invoice Email')
    if (!/<button v-if="auth\.isSuperAdmin && \(showProcessButton \|\| triumphPressing\)"/.test(src)) v.push('the button is not Super Admin only, or shows without the server\'s word')
    if (!/const showProcessButton = computed\(\(\) => Boolean\(auth\.isSuperAdmin && selectedJob\.value && canProcess\(selectedJob\.value\._factoring\)\)\)/.test(src)) v.push('the button does not follow canProcess alone')
    const fnAt = src.indexOf('async function processWithTriumph() {')
    const fnEnd = src.indexOf('\n}\n', fnAt)
    const fn = fnAt >= 0 ? src.slice(fnAt, fnEnd) : ''
    if (!/^async function processWithTriumph\(\) \{\n {2}if \(!auth\.isSuperAdmin\b/.test(fn)) v.push('the press does not refuse a non-Super-Admin first')
    if (/confirm\(|prompt\(|reason/i.test(fn)) v.push('the press asks a question or takes a reason')
    if (!fn.includes("api.post('/api/factoring/process-with-triumph', { loadId: loadRefValue.value })")) v.push('the press sends more than { loadId }')
    if (!/'Sending to Triumph…' : 'Process with Triumph'/.test(src)) v.push('the button does not say "Sending to Triumph…" while it presses')
    if (!/<button v-if="selectedTriumphTile\.tryAgain"/.test(src)) v.push('Try again does not follow the tile')
    if (!/const selectedTriumphTile = computed\(\(\) => \(auth\.isSuperAdmin && selectedJob\.value/.test(src)) v.push('the tile reads for every role')
    return v
  }
  eq(completedButtonViolations(COMPLETED), [], '§9 FAILS ON THE OLD CODE: Process with Triumph beside Draft Invoice Email: Super Admin only, on the server\'s word, one press with no question, "Sending to Triumph…" while it goes')
  for (const [name, from, to] of [
    ['the press asks first', "  triumphPressing.value = true; triumphResult.value = null\n  try {\n    const r = await api.post('/api/factoring/process-with-triumph'", "  if (!window.confirm('Send to Triumph?')) return\n  triumphPressing.value = true; triumphResult.value = null\n  try {\n    const r = await api.post('/api/factoring/process-with-triumph'"],
    ['the button shown on any delivered load', 'selectedJob.value && canProcess(selectedJob.value._factoring)', 'selectedJob.value'],
    ['Try again shown on every tile', '<button v-if="selectedTriumphTile.tryAgain"', '<button v-if="selectedTriumphTile"'],
    ['the press for every role', "async function processWithTriumph() {\n  if (!auth.isSuperAdmin || ", "async function processWithTriumph() {\n  if ("],
  ]) {
    if (COMPLETED.split(from).length - 1 !== 1) { failures.push(`§9 mutant anchor not found once in CompletedLoadsTab.vue: ${name}`); continue }
    ok(completedButtonViolations(COMPLETED.replace(from, to)).length > 0, `§9 MUTANT ${name}: caught`)
  }
  // M1: after a second press or an unconfirmed one, the tab reads the load again, and the load's
  // own line takes the place of the words.
  const unconfirmedViolations = (src) => {
    const v = []
    const fnAt = src.indexOf('async function processWithTriumph() {')
    const fn = fnAt >= 0 ? src.slice(fnAt, src.indexOf('\n}\n', fnAt)) : ''
    if (!fn.includes('const out = pressFailure(e)')) v.push('a failed press is not read through pressFailure()')
    if (!fn.includes("    if (out.kind !== 'refused') showTrueTile()\n")) v.push('after "already" or no answer, the load is not read again')
    const tAt = src.indexOf('async function showTrueTile() {')
    const t = tAt >= 0 ? src.slice(tAt, src.indexOf('\n}\n', tAt)) : ''
    if (!t.includes('await dashboard.refresh()') || !t.includes('freshFactoring()')) v.push('the load is not read again')
    if (!t.includes('  if (selectedTriumphTile.value) triumphResult.value = null\n')) v.push("the words stay over the load's own line")
    if (src.includes('processRefusalText')) v.push('the old "Not sent" words are still used')
    return v
  }
  eq(unconfirmedViolations(COMPLETED), [], '§9 FAILS ON THE OLD CODE (M1): after a second press or an unconfirmed one, the tab reads the load again and shows its own line')
  for (const [name, from, to] of [
    ['the load not read again after "already" or no answer (M1)', "    if (out.kind !== 'refused') showTrueTile()\n    else dashboard.refresh().catch(() => {})", '    dashboard.refresh().catch(() => {})'],
    ["the words kept over the load's own line (M1)", '  if (selectedTriumphTile.value) triumphResult.value = null\n', ''],
    ['every failed press read as "Not sent" (M1)', 'const out = pressFailure(e)', "const out = { kind: 'refused', tone: 'bad', text: 'Not sent to Triumph.' }"],
  ]) {
    if (COMPLETED.split(from).length - 1 !== 1) { failures.push(`§9 mutant anchor not found once in CompletedLoadsTab.vue: ${name}`); continue }
    ok(unconfirmedViolations(COMPLETED.replace(from, to)).length > 0, `§9 MUTANT ${name}: caught`)
  }
  const controlsSplitViolations = (src) => {
    const v = []
    if (!src.includes('<button v-if="mayMark" type="button" class="fact-btn" :disabled="busy || !reasonOk" @click="setFactored(true)">Factor with Triumph</button>')) v.push('"Factor with Triumph" is not its own button on canMarkFactored')
    if (!src.includes('<button v-if="mayClear" type="button" class="fact-btn" :disabled="busy || !reasonOk" @click="setFactored(false)">Clear factored</button>')) v.push('"Clear factored" is not its own button on canClear')
    if (!src.includes('const mayMark = computed(() => canMarkFactored(status.value))') || !src.includes('const mayClear = computed(() => canClear(status.value))')) v.push('the buttons do not follow the server\'s words')
    return v
  }
  eq(controlsSplitViolations(CONTROLS), [], '§9 FAILS ON THE OLD CODE (N-L6): the one switch split in two: "Factor with Triumph" and "Clear factored", each on the server\'s word; Clear factored keeps its reason box')
  ok(controlsSplitViolations(CONTROLS.replace('const mayClear = computed(() => canClear(status.value))', 'const mayClear = computed(() => factored.value)')).length > 0, '§9 MUTANT Clear factored on any factored load: caught')
  // With the switch on, a cleared load has no chip and nothing left to press: the box must stay
  // while it has its own words to show ("No longer factored: it stays with its invoice to the broker.").
  const SHOWS_RESULT = 'v-if="auth.isSuperAdmin && (chip || mayFactor || mayClear || mayRecord || result)"'
  const hidesResult = (src) => !src.includes(SHOWS_RESULT)
  ok(!hidesResult(CONTROLS), "§9 FAILS ON THE OLD CODE: Clear factored's own words stay on screen after the clear, though nothing is left to press")
  ok(CONTROLS.split(SHOWS_RESULT).length - 1 === 1 && hidesResult(CONTROLS.replace(SHOWS_RESULT, 'v-if="auth.isSuperAdmin && (chip || mayFactor || mayClear || mayRecord)"')),
    "§9 MUTANT a clear's words hidden with the box once nothing is left to press: caught")
  // Mutants of the lib's own rules, each a copy run from a temp folder.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factoring-status-9-'))
  try {
    fs.mkdirSync(path.join(tmp, 'lib'))
    fs.mkdirSync(path.join(tmp, 'utils'))
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}\n')
    fs.copyFileSync(path.join(ROOT, 'client', 'src', 'utils', 'sharedLogin.js'), path.join(tmp, 'utils', 'sharedLogin.js'))
    let n = 0
    for (const [name, from, to, check] of [
      ['Try again offered on a code a retry can\'t change (N-L1)', "    if (BUTTON_STOPS.includes(code)) return { text: `Not sent to Triumph: ${triumphStopWords(code)}. ${BROKER_WENT}", "    if (false) return { text: `Not sent to Triumph: ${triumphStopWords(code)}. ${BROKER_WENT}", tileViolations],
      ['the stop after the lock read as one before it (N2-L2)', '    if (UPLOAD_STAGES.includes(stage)) {', '    if (false) {', tileViolations],
      ['Sending before the pause', "  if (state === 'queued' && f.paused) return { text:", "  if (false) return { text:", tileViolations],
      ['a cleared mark still read as on its way', "  if (f.factored !== true) return { text: `Not sent to Triumph. ${BROKER_WENT}`", "  if (false) return { text: `Not sent to Triumph. ${BROKER_WENT}`", tileViolations],
      ['MAYBE_SUBMITTED read as a plain stop', "    if (code === 'MAYBE_SUBMITTED' || AFTER_CSV_STAGES.includes(stage)) return", "    if (false) return", tileViolations],
      ['Clear factored named where the server doesn\'t offer it', "  return clear ? ` ${KEEP_WITH_BROKER}` : ''", "  return true ? ` ${KEEP_WITH_BROKER}` : ''", tileViolations],
      ['a second press read as "Not sent" (M1)', "const PRESS_ALREADY = Object.freeze(['TRIUMPH_ALREADY', 'FACTORING_LOCKED'])", 'const PRESS_ALREADY = Object.freeze([])', pressViolations],
      ['no answer read as "Not sent" (M1)', "  return { kind: 'unknown', tone: 'warn', text: PRESS_UNCONFIRMED }", "  return { kind: 'refused', tone: 'bad', text: \"Not sent to Triumph: the answer didn't come back.\" }", pressViolations],
      ['a 5xx the press didn\'t name read as "Not sent" (M1)', '(status >= 500 && PRESS_NOTHING_WRITTEN_5XX.includes(code))', '(status >= 500)', pressViolations],
    ]) {
      if (LIB_SRC.split(from).length - 1 !== 1) { failures.push(`§9 mutant anchor not found once in factoringStatus.js: ${name}`); continue }
      const file = path.join(tmp, 'lib', `factoringStatus-9-${++n}.js`)
      fs.writeFileSync(file, LIB_SRC.replace(from, to))
      let v
      try { v = check(await import(pathToFileURL(file).href)) } catch (e) { v = [`threw: ${e && e.message}`] }
      ok(v.length > 0, `§9 MUTANT ${name}: caught`)
    }
    const canClearMutant = path.join(tmp, 'lib', 'factoringStatus-9-clear.js')
    const clearFrom = "(f.canClear === true || (f.canClear === undefined && f.canMark === true && f.factored === true))"
    if (LIB_SRC.split(clearFrom).length - 1 !== 1) failures.push('§9 mutant anchor not found once in factoringStatus.js: Clear factored with the switch off')
    else {
      fs.writeFileSync(canClearMutant, LIB_SRC.replace(clearFrom, '(f.canClear === true)'))
      const M = await import(pathToFileURL(canClearMutant).href)
      ok(!M.canClear({ factored: true, canMark: true }), '§9 MUTANT Clear factored gone with the switch off: caught')
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- §10-§15
// The Triumph status plan, Part 1. Each check runs on the shipped files, then on each mutant: the
// lib's from a temp copy beside its import, the screens' as text.
{
  const LIB_SRC = read(LIB)
  const has = (M, fn) => Boolean(M && typeof M[fn] === 'function')
  const fmt = (iso) => `<${iso}>`
  const P = '2026-11-19T03:26:00.000Z'
  const base = Object.freeze({ factored: true, locked: false, lockedVia: '', byButton: true, canClear: true, canRetry: true, canRecordOutside: true, triumphStage: '', triumphAt: '', triumphCode: '',
    brokerInvoiceId: '11102026-4', brokerInvoiceDate: '2026-11-10', paused: '', triumphPressedAt: P, triumphPages: null, triumphAttempts: 0, triumphTryLimit: 4, triumphNextAt: '', triumphTooLarge: null, otherOptions: true })
  const MY = 'Not shown in the app yet. Look for it in MyTriumph.'
  const WENT = "The broker's invoice already went out as usual."
  const INV = 'Invoiced to the broker: 11102026-4, 11/10/2026.'

  // §10 the step line (3b, N4): each step from the server's own facts.
  const stepsViolations = (M) => {
    if (!has(M, 'triumphSteps')) return ['no triumphSteps()']
    const v = []
    const lines = (over) => M.triumphSteps({ ...base, ...over }, { formatTime: fmt }).map((s) => `${s.done ? '✓' : '○'} ${s.text}`)
    const want = (label, got, exp) => { if (JSON.stringify(got) !== JSON.stringify(exp)) v.push(`${label}: ${JSON.stringify(got)}`) }
    const theirs = (sent) => ['Received by Triumph', 'Accepted, purchased', 'Funded'].map((l) => `○ ${sent ? `${l}: ${MY}` : l}`)
    want('a fresh press', lines({ triumphState: 'queued' }), [`✓ Pressed <${P}>`, '○ Documents checked', '○ Uploaded to Triumph', ...theirs(false)])
    want('built', lines({ triumphState: 'working', triumphStage: 'built', triumphPages: 6 }), [`✓ Pressed <${P}>`, '✓ Documents checked: 6 pages', '○ Uploaded to Triumph', ...theirs(false)])
    want('one page', lines({ triumphState: 'working', triumphStage: 'pdf_uploaded', triumphPages: 1 })[1], '✓ Documents checked: 1 page')
    want('sent', lines({ triumphState: 'submitted', triumphStage: 'recorded', triumphPages: 6, triumphAt: '2026-11-19T03:31:00.000Z', locked: true, lockedVia: 'upload' }),
      [`✓ Pressed <${P}>`, '✓ Documents checked: 6 pages', "✓ Uploaded to Triumph <2026-11-19T03:31:00.000Z>. The file sizes on Triumph's server matched what the app sent.", ...theirs(true)])
    want('a stop after the lock', lines({ triumphState: 'needs_attention', triumphStage: 'pdf_uploading', triumphCode: 'SUBMIT_FAILED', triumphPages: 6, locked: true, lockedVia: 'upload' }),
      [`✓ Pressed <${P}>`, '✓ Documents checked: 6 pages', '○ Uploaded to Triumph', ...theirs(false)])
    want('a size stop, never built', lines({ triumphState: 'needs_attention', triumphStage: 'rendered', triumphCode: 'BATCH_TOO_LARGE', triumphPages: 6 })[1], '○ Documents checked')
    for (const [label, over] of [["handled in Triumph's process", { triumphState: 'closed_outside', locked: true, lockedVia: 'outside' }], ['given up', { triumphState: 'skipped', triumphCode: 'NOT_FACTORED' }],
      ['a cleared mark', { factored: false, triumphState: 'queued' }], ["a claim the button didn't arm", { byButton: false, triumphState: 'queued' }], ['no claim', { triumphState: '' }]]) {
      if (M.triumphSteps({ ...base, ...over }).length) v.push(`${label}: a step line`)
    }
    return v
  }

  // §11 the calm line (3a, L6), the wait words (N3) and the retry's try count (L5): never amber while it goes.
  const waitViolations = (M) => {
    if (!has(M, 'triumphTile')) return ['no triumphTile()']
    const v = []
    const t = (over, opts = {}) => M.triumphTile({ ...base, ...over }, { formatTime: fmt, ...opts })
    const want = (label, got, text, tone = 'muted') => { if (!got || got.text !== text || got.tone !== tone || got.tryAgain !== false) v.push(`${label}: ${JSON.stringify(got)}`) }
    want('a fresh press', t({ triumphState: 'queued' }), `Sending to Triumph… Taken at <${P}>.`)
    want('being worked', t({ triumphState: 'working' }), `Sending to Triumph… Taken at <${P}>.`)
    want('still on its way after the last read', t({ triumphState: 'queued' }, { late: true }), 'Still on its way. Reload to see where it stands.')
    want('Friday evening', t({ triumphState: 'queued', triumphCode: 'QUIET_WINDOW', triumphNextAt: '2026-11-14T00:30:00.000Z' }), "Waiting: Friday evening is the app's weekly invoice run; it goes after.")
    for (const code of ['RENDERER_BUSY', 'GEMINI_DOWN']) want(code, t({ triumphState: 'queued', triumphCode: code, triumphAttempts: 1 }), "Waiting: the app's invoice maker or document reader isn't available; it tries again by itself.")
    want("a pause's code left after it ended", t({ triumphState: 'queued', triumphCode: 'LOGIN_REFUSED' }), 'Waiting: sending was paused; it tries again by itself.')
    want('paused now (N7)', t({ triumphState: 'queued', triumphCode: 'LOGIN_REFUSED', paused: 'LOGIN_REFUSED' }), `Paused: Triumph refused the app's sign-in. ${WENT}`, 'warn')
    want('a retry', t({ triumphState: 'queued', triumphCode: 'RETRY_LATER', triumphAttempts: 1, triumphNextAt: '2026-11-19T03:41:00.000Z' }), "Waiting to retry: a step didn't go through. Next try about <2026-11-19T03:41:00.000Z> (try 2 of 4).")
    want('the last retry', t({ triumphState: 'queued', triumphCode: 'RETRY_LATER', triumphAttempts: 3, triumphNextAt: '2026-11-19T07:41:00.000Z' }), "Waiting to retry: a step didn't go through. Next try about <2026-11-19T07:41:00.000Z> (try 4 of 4).")
    want('a wait that cost no try', t({ triumphState: 'queued', triumphCode: 'RETRY_LATER', triumphAttempts: 0, triumphNextAt: '2026-11-19T03:31:00.000Z' }), "Waiting to retry: a step didn't go through. Next try about <2026-11-19T03:31:00.000Z>.")
    want('the mark unreadable', t({ triumphState: 'queued', triumphCode: 'FACTORING_UNREADABLE', triumphAttempts: 2, triumphNextAt: '2026-11-19T04:26:00.000Z' }), "Waiting to retry: the factoring mark couldn't be read. Next try about <2026-11-19T04:26:00.000Z> (try 3 of 4).")
    const noLimit = t({ triumphState: 'queued', triumphCode: 'RETRY_LATER', triumphAttempts: 1, triumphTryLimit: undefined, triumphNextAt: '2026-11-19T03:41:00.000Z' })
    if (!noLimit || /try \d of/.test(noLimit.text)) v.push('a try count with no limit from the server')
    return v
  }

  // §12 the chip by the tile's own table (3c, N7, M2); "Handled in Triumph's process" read first.
  const chipViolations = (M) => {
    if (!M || typeof M.factoringChip !== 'function') return ['no factoringChip()']
    const v = []
    const c = (over) => M.factoringChip({ ...base, ...over })
    const want = (label, got, text, tone, reason = '') => { if (!got || got.label !== text || got.tone !== tone || got.reason !== reason) v.push(`${label}: ${JSON.stringify(got)}`) }
    want('queued', c({ triumphState: 'queued' }), 'Factored (Triumph): sending', 'muted')
    want('working', c({ triumphState: 'working' }), 'Factored (Triumph): sending', 'muted')
    want('a retry wait', c({ triumphState: 'queued', triumphCode: 'RETRY_LATER', triumphAttempts: 1 }), 'Factored (Triumph): sending', 'muted')
    want('a resumed upload, locked', c({ triumphState: 'queued', triumphCode: 'RETRY_LATER', triumphStage: 'pdf_uploading', locked: true, lockedVia: 'upload' }), 'Factored (Triumph): sending', 'muted')
    want('paused', c({ triumphState: 'queued', paused: 'LOGIN_REFUSED' }), 'Factored (Triumph): paused', 'warn')
    want('submitted', c({ triumphState: 'submitted', triumphStage: 'recorded', locked: true, lockedVia: 'upload' }), 'Factored (Triumph): final', 'muted', `Sent to Triumph. ${INV}`)
    want('MAYBE_SUBMITTED', c({ triumphState: 'needs_attention', triumphCode: 'MAYBE_SUBMITTED', triumphStage: 'csv_uploading', locked: true, lockedVia: 'upload' }), 'Factored (Triumph): may have reached Triumph', 'bad', 'A person checks.')
    want('csv_uploaded', c({ triumphState: 'needs_attention', triumphCode: 'STAGE_INVALID', triumphStage: 'csv_uploaded', locked: true, lockedVia: 'upload' }), 'Factored (Triumph): may have reached Triumph', 'bad', 'A person checks.')
    for (const stage of ['pdf_uploading', 'pdf_uploaded']) want(`a stop at ${stage}`, c({ triumphState: 'needs_attention', triumphCode: 'SUBMIT_FAILED', triumphStage: stage, locked: true, lockedVia: 'upload' }), 'Factored (Triumph): nothing triggered at Triumph', 'bad', 'A person checks.')
    for (const stage of ['', 'reserved', 'rendered', 'built']) want(`a stop at "${stage}"`, c({ triumphState: 'needs_attention', triumphCode: 'BATCH_TOO_LARGE', triumphStage: stage }), 'Factored (Triumph): not sent', 'warn')
    want('given up', c({ triumphState: 'skipped', triumphCode: 'LOAD_DROPPED' }), 'Factored (Triumph): not sent', 'warn')
    want('waiting', c({ triumphState: 'waiting', triumphCode: 'INVOICE_DRAFT_IN_FLIGHT' }), 'Factored (Triumph): waiting', 'warn')
    want('staged', c({ triumphState: 'staged', triumphStage: 'built' }), 'Factored (Triumph): waiting', 'warn')
    want('handled outside, read first', c({ triumphState: 'needs_attention', triumphCode: 'BATCH_TOO_LARGE', triumphStage: 'rendered', locked: true, lockedVia: 'outside' }), 'Factored (Triumph): final', 'muted', `Handled in Triumph's process. ${INV}`)
    return v
  }
  // The chip and the line beside it say the same thing, state by state (M2).
  const agreeViolations = (M) => {
    if (!M || typeof M.factoringChip !== 'function' || typeof M.triumphTile !== 'function') return ['no chip or no tile']
    const v = []
    for (const [over, word, line] of [
      [{ triumphState: 'queued' }, 'sending', /^Sending to Triumph…/],
      [{ triumphState: 'queued', triumphCode: 'RETRY_LATER', triumphAttempts: 1 }, 'sending', /^Waiting to retry: /],
      [{ triumphState: 'queued', triumphCode: 'QUIET_WINDOW' }, 'sending', /^Waiting: /],
      [{ triumphState: 'queued', paused: 'LOGIN_REFUSED' }, 'paused', /^Paused: /],
      [{ triumphState: 'waiting', triumphCode: 'NOT_COMPLETED' }, 'waiting', /^Waiting: /],
      [{ triumphState: 'needs_attention', triumphCode: 'SUBMIT_FAILED', triumphStage: 'built' }, 'not sent', /^Not sent to Triumph: /],
      [{ triumphState: 'needs_attention', triumphCode: 'BATCH_TOO_LARGE', triumphStage: 'rendered' }, 'not sent', /^Too large for Triumph: /],
      [{ triumphState: 'needs_attention', triumphCode: 'SUBMIT_FAILED', triumphStage: 'pdf_uploading', locked: true, lockedVia: 'upload' }, 'nothing triggered at Triumph', /^Its PDF may be on Triumph's server, but nothing was triggered there/],
      [{ triumphState: 'needs_attention', triumphCode: 'MAYBE_SUBMITTED', triumphStage: 'csv_uploading', locked: true, lockedVia: 'upload' }, 'may have reached Triumph', /^May have reached Triumph/],
      [{ triumphState: 'submitted', triumphStage: 'recorded', locked: true, lockedVia: 'upload', triumphAt: P }, 'final', /^Sent to Triumph · /],
    ]) {
      const chip = M.factoringChip({ ...base, ...over })
      const tile = M.triumphTile({ ...base, ...over }, { formatTime: fmt })
      if (!chip || chip.label !== `Factored (Triumph): ${word}` || !tile || !line.test(tile.text)) v.push(`${JSON.stringify(over)}: "${chip && chip.label}" beside "${tile && tile.text}"`)
    }
    return v
  }

  // §13 the too-large words (N5, L3, L4): the server's numbers when it kept them, each way out only where offered.
  const N5 = "Too large for Triumph: the invoice, rate con and delivery papers come to 1,011,000 bytes; the app sends at most 921,599. Nothing was sent, and the broker's invoice already went out as usual. To fix it: delete a duplicate BOL or POD, or replace a very large scan with a smaller copy, then press Try again. Or send it in MyTriumph, then under Other options press Handled in Triumph's process, or Clear factored to keep it with the broker only."
  const tooLargeViolations = (M) => {
    if (!has(M, 'triumphTile')) return ['no triumphTile()']
    const v = []
    const t = (over) => M.triumphTile({ ...base, triumphState: 'needs_attention', triumphCode: 'BATCH_TOO_LARGE', triumphStage: 'rendered', ...over }, { formatTime: fmt })
    const want = (label, got, text, tryAgain) => { if (!got || got.text !== text || got.tryAgain !== tryAgain) v.push(`${label}: ${JSON.stringify(got)}`) }
    const unsized = N5.replace('come to 1,011,000 bytes; the app sends at most 921,599.', 'come to more than the app sends.')
    const head = unsized.slice(0, unsized.indexOf(' To fix it'))
    want('the kept size', t({ triumphTooLarge: { bytes: 1011000, limit: 921599 } }), N5, true)
    want('no kept size (the switch off)', t({}), unsized, true)
    want('a size that is not a number', t({ triumphTooLarge: { bytes: '1011000', limit: 921599 } }), unsized, true)
    want('an account not listed: no way out named', t({ canRetry: false, canClear: false, canRecordOutside: false }), head, false)
    want('Handled only', t({ canClear: false }), `${head} To fix it: delete a duplicate BOL or POD, or replace a very large scan with a smaller copy, then press Try again. Or send it in MyTriumph, then under Other options press Handled in Triumph's process.`, true)
    want('Clear factored only, no Try again', t({ canRetry: false, canRecordOutside: false }), `${head} Under Other options, press Clear factored to keep it with the broker only.`, false)
    const other = M.triumphTile({ ...base, triumphState: 'needs_attention', triumphCode: 'MERGE_FAILED', triumphStage: 'rendered', triumphTooLarge: { bytes: 1011000, limit: 921599 } }, { formatTime: fmt })
    if (!other || /bytes|1,011,000/.test(other.text)) v.push(`another code shows a size: ${JSON.stringify(other)}`)
    return v
  }
  // Every line the tile can say: "Its invoice to the broker stands" is gone (3d), and a line that names a
  // manual button says it is under Other options (N5).
  const everyLineViolations = (M) => {
    if (!has(M, 'triumphTile')) return ['no triumphTile()']
    const v = []
    const codes = [...(M.BUTTON_STOPS || []), 'SUBMIT_FAILED', 'BATCH_TOO_LARGE', 'DEBTOR_UNMAPPED', 'MAYBE_SUBMITTED', 'NOT_FACTORED', 'RETRY_LATER', 'QUIET_WINDOW', 'LOGIN_REFUSED', '']
    for (const state of ['queued', 'working', 'submitted', 'waiting', 'needs_attention', 'closed_outside', 'skipped', 'staged']) {
      for (const code of codes) for (const stage of ['', 'rendered', 'pdf_uploading', 'csv_uploading']) for (const factored of [true, false]) {
        const got = M.triumphTile({ ...base, triumphState: state, triumphCode: code, triumphStage: stage, factored, locked: stage.endsWith('uploading'), lockedVia: stage.endsWith('uploading') ? 'upload' : '' }, { formatTime: fmt })
        if (!got) continue
        if (/invoice to the broker stands|Triumph gets the same invoice|stays with its invoice/.test(got.text)) v.push(`${state} ${code} ${stage}: ${got.text}`)
        if (/press (Clear factored|Handled in Triumph's process)|, or Clear factored/.test(got.text) && !/under Other options/i.test(got.text)) v.push(`${state} ${code} ${stage}: a manual button named without "under Other options"`)
      }
    }
    return v
  }

  // §14 Other options (3e, N8): folded on the server's word, never open by default, each help line beside its button.
  const MANUAL_WORDS = Object.freeze({ link: 'Other options', heading: "If this load won't go through the app", handled: "Handled in Triumph's process: you sent it to Triumph another way, for example in MyTriumph.",
    clear: 'Clear factored: takes the load off Triumph; an invoice the broker already got stands; if none went, invoice it the usual way.', both: 'Either one needs a short note.', one: 'It needs a short note.' })
  const manualViolations = (M) => {
    if (!has(M, 'manualControls') || !M.OTHER_OPTIONS) return ['no manualControls() or OTHER_OPTIONS']
    const v = []
    const got = [undefined, null, {}, { otherOptions: 'true' }, { otherOptions: true }, { otherOptions: false }].map((f) => M.manualControls(f))
    if (JSON.stringify(got) !== JSON.stringify(['today', 'today', 'today', 'today', 'folded', 'hidden'])) v.push(`manualControls: ${JSON.stringify(got)}`)
    for (const [k, words] of Object.entries(MANUAL_WORDS)) if (M.OTHER_OPTIONS[k] !== words) v.push(`OTHER_OPTIONS.${k}: ${JSON.stringify(M.OTHER_OPTIONS[k])}`)
    return v
  }
  const CLEAR_BTN = '<button v-if="mayClear" type="button" class="fact-btn" :disabled="busy || !reasonOk" @click="setFactored(false)">Clear factored</button>'
  const HANDLED_BTN = '<button v-if="mayRecord" type="button" class="fact-btn" :disabled="busy || !reasonOk" @click="recordOutside">Handled in Triumph\'s process</button>'
  const LINK = '<button v-if="folded && (mayClear || mayRecord)" type="button" class="fact-more" :aria-expanded="open ? \'true\' : \'false\'" @click="open = !open">{{ OTHER_OPTIONS.link }}</button>'
  const SHOWN = /const actionsShown = computed\(\(\) => \(manual\.value === 'today'\n\s+\? mayMark\.value \|\| mayClear\.value \|\| mayRecord\.value\n\s+: folded\.value && open\.value && \(mayClear\.value \|\| mayRecord\.value\)\)\)/
  const foldViolations = (src) => {
    const v = []
    if (!src.includes(LINK)) v.push('no plain "Other options" link, or one shown with no fold')
    if (!src.includes('const open = ref(false)')) v.push('Other options open by default')
    if (!src.includes('const manual = computed(() => manualControls(status.value))') || !src.includes("const folded = computed(() => manual.value === 'folded')")) v.push("the fold not on the server's word")
    if (!SHOWN.test(src)) v.push('the actions not as before with no flag, or not only once opened with it')
    if (!src.includes(`${CLEAR_BTN}\n      <span v-if="folded && mayClear" class="fact-help">{{ OTHER_OPTIONS.clear }}</span>`)) v.push("Clear factored's help line not beside it (N8)")
    if (!src.includes(`${HANDLED_BTN}\n      <span v-if="folded && mayRecord" class="fact-help">{{ OTHER_OPTIONS.handled }}</span>`)) v.push("Handled in Triumph's process's help line not beside it (N8)")
    if (!src.includes('<p v-if="folded" class="fact-heading">{{ OTHER_OPTIONS.heading }}</p>')) v.push('no heading')
    if (!/\.fact-actions--folded \{[^}]*background: #fff;/.test(src)) v.push('the folded panel not plain')
    if (!src.includes("watch(() => props.loadId, () => { reason.value = ''; result.value = null; open.value = false })")) v.push('Other options left open on another load')
    return v
  }

  // §15 the open load follows every read of the dashboard (3f), says "Still on its way" after the last
  // follow-up read (L6), and shows its step line.
  const followViolations = (src) => {
    const v = []
    if (!src.includes('watch(() => props.jobs, () => freshFactoring())')) v.push('the open load keeps its own copy after a read of the dashboard')
    const at = src.indexOf('async function followTile() {')
    const body = at >= 0 ? src.slice(at, src.indexOf('\n}\n', at)) : ''
    if (!body.includes('  triumphLate.value = false\n') || !body.endsWith('\n  if (mine === triumphFollow) triumphLate.value = true')) v.push('"Still on its way" not set after the last read, or not reset at the next')
    if (!src.includes('triumphTile(selectedJob.value._factoring, { formatTime: (t) => fmtDraftDate(t), late: triumphLate.value })')) v.push('the line not told the load is late')
    if (!src.includes('triumphResult.value = null; triumphFollow += 1; triumphLate.value = false')) v.push('"Still on its way" kept on another load')
    if (!/const selectedTriumphSteps = computed\(\(\) => \(auth\.isSuperAdmin && selectedJob\.value\n\s+\? triumphSteps\(selectedJob\.value\._factoring/.test(src)) v.push("the step line not a Super Admin's, or not the server's row")
    if (!src.includes('<ol v-if="!triumphResult && selectedTriumphSteps.length" class="triumph-steps"')) v.push('no step line under the Triumph line')
    return v
  }

  const LIB_CHECKS = [['§10', stepsViolations, '§10 FAILS ON THE OLD CODE (3b, N4): Pressed, Documents checked and Uploaded from the server\'s own facts, then Triumph\'s three, which say to look in MyTriumph once it went'],
    ['§11', waitViolations, '§11 FAILS ON THE OLD CODE (3a, N3, L5, L6): a calm line while it goes, the wait words, the server\'s try count, "Still on its way" after the last read; never amber'],
    ['§12', chipViolations, '§12 FAILS ON THE OLD CODE (3c, N7): the chip by the claim\'s own table, Handled in Triumph\'s process read first'],
    ['§12', agreeViolations, '§12 FAILS ON THE OLD CODE (M2): the chip and the line beside it agree, state by state'],
    ['§13', tooLargeViolations, '§13 FAILS ON THE OLD CODE (N5, L3, L4): the too-large words with the server\'s numbers, or without them; each way out only where offered'],
    ['§13', everyLineViolations, '§13 FAILS ON THE OLD CODE (3d, N5): no line says "Its invoice to the broker stands", and a line naming a manual button says "under Other options"'],
    ['§14', manualViolations, '§14 FAILS ON THE OLD CODE (3e): the manual actions as before with no flag, folded or hidden on the server\'s word; the words under Other options']]
  for (const [sec, check, label] of LIB_CHECKS) {
    if (sec === '§10' || sec === '§13') section(`${sec}  the Triumph status plan, Part 1`)
    eq(S ? check(S) : ['no module'], [], label)
  }
  eq(foldViolations(CONTROLS), [], '§14 FAILS ON THE OLD CODE (3e, N8): a plain "Other options" link, never open by default; the heading, the note box and each help line beside its own button')
  eq(followViolations(COMPLETED), [], '§15 FAILS ON THE OLD CODE (3f, L6): the open load takes the fresh row on every read of the dashboard; "Still on its way" after the last follow-up read; the step line under the Triumph line')

  // Mutants of the lib's new rules, each a copy run from a temp folder.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factoring-status-10-'))
  try {
    fs.mkdirSync(path.join(tmp, 'lib'))
    fs.mkdirSync(path.join(tmp, 'utils'))
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}\n')
    fs.copyFileSync(path.join(ROOT, 'client', 'src', 'utils', 'sharedLogin.js'), path.join(tmp, 'utils', 'sharedLogin.js'))
    let n = 0
    for (const [name, from, to, check] of [
      ["Triumph's three said before the upload went", "text: sent ? `${label}: ${MYTRIUMPH}` : label })", "text: `${label}: ${MYTRIUMPH}` })", stepsViolations],
      ['pages shown before the batch is built', 'text: built && pages ?', 'text: pages ?', stepsViolations],
      ['Uploaded done before it went', "{ key: 'uploaded', done: sent,", "{ key: 'uploaded', done: built,", stepsViolations],
      ["a step line for a load handled in Triumph's process", "  if (f.triumphState === 'closed_outside' || f.triumphState === 'skipped') return []", '  if (false) return []', stepsViolations],
      ['a wait that costs no try read as a retry', "  if (state === 'queued' && Object.hasOwn(FREE_WAIT_WORDS, code)) return", '  if (false) return', waitViolations],
      ["a pause's code read as a retry", "  if (state === 'queued' && PAUSE_CODES.includes(code)) return", '  if (false) return', waitViolations],
      ['the try count off by one', 'try ${f.triumphAttempts + 1} of', 'try ${f.triumphAttempts} of', waitViolations],
      ['a count for a wait that cost no try', 'f.triumphAttempts > 0 && f.triumphAttempts < f.triumphTryLimit', 'f.triumphAttempts >= 0 && f.triumphAttempts < f.triumphTryLimit', waitViolations],
      ['never "Still on its way"', '    if (late) return', '    if (false) return', waitViolations],
      ['no "Taken at"', "${f.triumphPressedAt ? ` Taken at ${formatTime(f.triumphPressedAt)}.` : ''}", '', waitViolations],
      ['the chip blind to the claim', 'const followed = f.byButton === true ? buttonChip(f, invoiced) : null', 'const followed = null', chipViolations],
      ["Handled in Triumph's process not read first", "  if (f.locked === true && f.lockedVia === 'outside') {", '  if (false) {', chipViolations],
      ['a stop after the lock read as one before it', "    if (UPLOAD_STAGES.includes(stage)) return chip('nothing triggered at Triumph'", "    if (false) return chip('nothing triggered at Triumph'", chipViolations],
      ["the CSV's stages read as after the lock alone", "    if (f.triumphCode === 'MAYBE_SUBMITTED' || AFTER_CSV_STAGES.includes(stage)) return chip(", "    if (f.triumphCode === 'MAYBE_SUBMITTED') return chip(", chipViolations],
      ['a pause read as sending', "  if (state === 'queued' && f.paused) return chip('paused', 'warn')", "  if (false) return chip('paused', 'warn')", chipViolations],
      ['staged read as the old chip', "  if (state === 'waiting' || state === 'staged') return chip(", "  if (state === 'waiting') return chip(", chipViolations],
      ['the kept size ignored', 'const size = f.triumphTooLarge && typeof f.triumphTooLarge', 'const size = null && f.triumphTooLarge && typeof f.triumphTooLarge', tooLargeViolations],
      ['Try again named where not offered', "  if (retry) parts.push('To fix it:", "  if (true) parts.push('To fix it:", tooLargeViolations],
      ['Handled and Clear named where not offered', 'const other = record && clear ?', 'const other = true ?', tooLargeViolations],
      ['a size stop in the plain stop words', "    if (code === 'BATCH_TOO_LARGE') return { text: tooLargeText(", "    if (false) return { text: tooLargeText(", tooLargeViolations],
      ['"Its invoice to the broker stands" kept', "const BROKER_WENT = \"The broker's invoice already went out as usual.\"", "const BROKER_WENT = 'Its invoice to the broker stands.'", everyLineViolations],
      ['Clear factored named without "under Other options"', "const KEEP_WITH_BROKER = 'To keep it with the broker only, press Clear factored under Other options.'", "const KEEP_WITH_BROKER = 'To keep it with the broker only, press Clear factored.'", everyLineViolations],
      ['hidden read as before', "f.otherOptions ? 'folded' : 'hidden'", "f.otherOptions ? 'folded' : 'today'", manualViolations],
      ['a flag that is not the server\'s boolean trusted', "typeof f.otherOptions !== 'boolean' ? 'today'", "f.otherOptions === undefined ? 'today'", manualViolations],
    ]) {
      if (LIB_SRC.split(from).length - 1 !== 1) { failures.push(`§10-§14 mutant anchor not found once in factoringStatus.js: ${name}`); continue }
      const file = path.join(tmp, 'lib', `factoringStatus-10-${++n}.js`)
      fs.writeFileSync(file, LIB_SRC.replace(from, () => to))
      let v
      try { v = check(await import(pathToFileURL(file).href)) } catch (e) { v = [`threw: ${e && e.message}`] }
      ok(v.length > 0, `§10-§14 MUTANT ${name}: caught`)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  // Mutants of the screens, as text.
  for (const [name, file, src, check, from, to] of [
    ['the link shown with no fold', 'FactoringControls.vue', CONTROLS, foldViolations, '<button v-if="folded && (mayClear || mayRecord)" ', '<button v-if="mayClear || mayRecord" '],
    ['Other options open by default', 'FactoringControls.vue', CONTROLS, foldViolations, 'const open = ref(false)', 'const open = ref(true)'],
    ["Clear factored's help line gone", 'FactoringControls.vue', CONTROLS, foldViolations, '\n      <span v-if="folded && mayClear" class="fact-help">{{ OTHER_OPTIONS.clear }}</span>', ''],
    ['the folded actions shown unopened', 'FactoringControls.vue', CONTROLS, foldViolations, ': folded.value && open.value && (', ': folded.value && ('],
    ['the folded panel amber', 'FactoringControls.vue', CONTROLS, foldViolations, '  border-radius: 6px;\n  background: #fff;\n  color: #374151;\n}', '  border-radius: 6px;\n  background: #fffbeb;\n  color: #374151;\n}'],
    ['the open load keeps its own copy', 'CompletedLoadsTab.vue', COMPLETED, followViolations, 'watch(() => props.jobs, () => freshFactoring())\n', ''],
    ['"Still on its way" never set', 'CompletedLoadsTab.vue', COMPLETED, followViolations, '  if (mine === triumphFollow) triumphLate.value = true\n', ''],
    ['the step line for every role', 'CompletedLoadsTab.vue', COMPLETED, followViolations, 'const selectedTriumphSteps = computed(() => (auth.isSuperAdmin && selectedJob.value', 'const selectedTriumphSteps = computed(() => (selectedJob.value'],
  ]) {
    if (src.split(from).length - 1 !== 1) { failures.push(`§14-§15 mutant anchor not found once in ${file}: ${name}`); continue }
    ok(check(src.replace(from, () => to)).length > 0, `§14-§15 MUTANT ${name}: caught`)
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`)
for (const f of failures) console.log(`FAIL  ${f}`)
process.exit(failures.length ? 1 : 0)
