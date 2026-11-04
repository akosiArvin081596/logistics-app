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
//      each gate removed in turn is caught
//   §6 the four screens touched parse and compile (vue/compiler-sfc)
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
function controlsViolations(src) {
  const v = []
  if (!/<div v-if="auth\.isSuperAdmin && \(chip \|\| mayFactor \|\| mayRecord\)"/.test(src)) v.push('FactoringControls.vue is not Super Admin only')
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
}
for (const [name, file, src, check, from, to] of [
  ['the controls show to every role', 'FactoringControls.vue', CONTROLS, controlsViolations, '<div v-if="auth.isSuperAdmin && (chip || mayFactor || mayRecord)"', '<div v-if="chip || mayFactor || mayRecord"'],
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

console.log(`\n${pass} passed, ${failures.length} failed`)
for (const f of failures) console.log(`FAIL  ${f}`)
process.exit(failures.length ? 1 : 0)
