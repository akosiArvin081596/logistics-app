#!/usr/bin/env node
// client/src/lib/autoInvoiceStatus.js: the words for the automatic invoice-draft
// status on Completed Loads, and their parity with the server's codes.
//
//   §1 PARITY: every reason code lib/auto-invoice-rules.js can send has words, and
//      nothing else does; every changed field the fingerprint can name has words;
//      the states the server's annotation sends are the ones worded
//   §2 the chips: "Draft ready in Gmail", "Waiting for POD", "Drafting soon",
//      "Needs attention: <reason>", with their tones; nothing for a baseline,
//      skipped or malformed status
//   §3 the words are plain sentences: no markup, no address, each ends with a stop
//   §4 the "Needs attention" toggle, Try again and Mark checked
//   §5 the module is plain: no imports, no network, no Vue
//
// No network, no DOM, no database.
//   node scripts/test-auto-invoice-status-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const rules = require(path.join(ROOT, 'lib', 'auto-invoice-rules.js'))
const CLIENT = path.join(ROOT, 'client', 'src', 'lib', 'autoInvoiceStatus.js')
const S = await import(pathToFileURL(CLIENT).href)

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

// ------------------------------------------------------------------ §1
section('§1  parity with the server')
eq(Object.keys(S.AUTO_INVOICE_REASONS).sort(), [...rules.REASON_CODES].sort(), '§1 the client words exactly the server reason codes')
const everyField = rules.fingerprintDiff(
  { completed: true, live: true, paymentCents: 1, brokerEmail: 'a', trailer: 'a', podIds: [1], rateConIds: [1] },
  { completed: false, live: false, paymentCents: 2, brokerEmail: 'b', trailer: 'b', podIds: [2], rateConIds: [2] },
)
eq(Object.keys(S.AUTO_INVOICE_CHANGED_WORDS).sort(), [...everyField].sort(), '§1 every field the fingerprint can name has words')
const JOB = fs.readFileSync(path.join(ROOT, 'lib', 'auto-invoice-job.js'), 'utf8')
const sent = /ledger\.listClaims\(db, (\[[^\]]{1,200}\])\)/.exec(JOB)
eq(sent ? JSON.parse(sent[1]) : null, [...S.AUTO_INVOICE_STATES], '§1 the states the annotation sends are the ones worded')
for (const s of S.AUTO_INVOICE_STATES) ok(rules.STATES.includes(s), `§1 ${s} is a server state`)

// ------------------------------------------------------------------ §2
section('§2  the chips')
eq(S.autoInvoiceChip({ state: 'drafted', code: '', invoiceId: '10202026-1', changed: [] }),
  { label: 'Draft ready in Gmail', tone: 'ok', reason: 'Invoice 10202026-1 is in Gmail Drafts. Check it and send it.' }, '§2 drafted')
eq(S.autoInvoiceChip({ state: 'drafted', code: '', invoiceId: '10202026-1', changed: ['payment', 'trailer'] }),
  { label: 'Draft ready in Gmail: load changed', tone: 'warn', reason: 'Changed since the draft: the Payment, the trailer. Check the draft in Gmail, then Mark checked.' }, '§2 drafted, then the load changed')
eq(S.autoInvoiceChip({ state: 'waiting', code: 'WAITING_POD' }).label, 'Waiting for POD', '§2 waiting for the POD')
eq(S.autoInvoiceChip({ state: 'waiting', code: 'RATECON_MISSING' }).label, 'Waiting for the rate con', '§2 waiting for the rate con')
eq(S.autoInvoiceChip({ state: 'waiting', code: 'LOAD_DROPPED' }).label, 'Waiting: cancelled or deleted', '§2 waiting for another reason')
eq(S.autoInvoiceChip({ state: 'queued', code: '' }), { label: 'Drafting soon', tone: 'muted', reason: 'The draft will be made shortly.' }, '§2 queued')
eq(S.autoInvoiceChip({ state: 'queued', code: 'GEMINI_DOWN' }).reason, S.AUTO_INVOICE_REASONS.GEMINI_DOWN.text, '§2 queued after a temporary failure says why')
eq(S.autoInvoiceChip({ state: 'working' }).label, 'Drafting now', '§2 working')
eq(S.autoInvoiceChip({ state: 'needs_attention', code: 'RECIPIENT_DOMAIN_MISMATCH' }),
  { label: 'Needs attention: billing email on another domain', tone: 'bad', reason: S.AUTO_INVOICE_REASONS.RECIPIENT_DOMAIN_MISMATCH.text }, '§2 needs attention, with its reason')
eq(S.autoInvoiceChip({ state: 'needs_attention', code: 'SOMETHING_NEW' }), { label: 'Needs attention', tone: 'bad', reason: 'Draft it by hand.' }, '§2 an unknown code still reads as needs attention')
eq(S.autoInvoiceChip({ state: 'needs_attention', code: 'BROKER_DOMAIN_UNCONFIRMED' }).label, 'Needs attention: broker domain not confirmed', '§2 the recipient anchor: an unconfirmed broker domain')
eq(S.autoInvoiceChip({ state: 'needs_attention', code: 'BROKER_EMAIL_FREEMAIL' }).label, 'Needs attention: broker email is free mail', '§2 the recipient anchor: a free-mail broker Email')
ok(/Confirm it in the automatic-draft settings/.test(S.AUTO_INVOICE_REASONS.BROKER_DOMAIN_UNCONFIRMED.text), '§2 the unconfirmed reason says where to confirm the domain')
for (const bad of [null, undefined, 'drafted', {}, { state: 'baseline' }, { state: 'skipped', code: 'DRAFTED_BY_HAND' }, { state: '__proto__' }]) {
  eq(S.autoInvoiceChip(bad), null, `§2 no chip for ${JSON.stringify(bad)}`)
}
eq(S.autoInvoiceChip({ state: 'drafted', changed: ['toString', 7, 'payment'] }).reason, 'Changed since the draft: the Payment. Check the draft in Gmail, then Mark checked.', '§2 unknown changed fields are ignored')
for (const state of S.AUTO_INVOICE_STATES) ok(S.autoInvoiceChip({ state, code: '' }), `§2 ${state} has a chip`)

// ------------------------------------------------------------------ §3
section('§3  plain sentences')
for (const [code, { short, text }] of Object.entries(S.AUTO_INVOICE_REASONS)) {
  ok(short && text && short === short.trim() && text === text.trim(), `§3 ${code}: words present, trimmed`)
  ok(!/[<>@]/.test(short + text), `§3 ${code}: no markup or address`)
  ok(/[.]$/.test(text) && !/[.]$/.test(short), `§3 ${code}: the sentence ends with a stop, the chip words don't`)
  ok(short.length <= 32, `§3 ${code}: the chip words fit (${short.length})`)
}

// ------------------------------------------------------------------ §4
section('§4  the toggle and the actions')
eq([
  { _autoInvoice: { state: 'needs_attention', code: 'OFF_GAP' } },
  { _autoInvoice: { state: 'drafted', changed: ['status'] } },
  { _autoInvoice: { state: 'drafted', changed: [] } },
  { _autoInvoice: { state: 'waiting', code: 'WAITING_POD' } },
  {},
  null,
].map(S.autoInvoiceNeedsAttention), [true, true, false, false, false, false], '§4 the toggle counts a person\'s loads and changed drafts')
eq([S.canTryAgain({ state: 'needs_attention' }), S.canTryAgain({ state: 'drafted' }), S.canTryAgain(null)], [true, false, false], '§4 Try again: needs attention only (the server\'s rule)')
eq([S.canMarkChecked({ state: 'drafted', changed: ['payment'] }), S.canMarkChecked({ state: 'drafted', changed: [] }), S.canMarkChecked({ state: 'needs_attention' })], [true, false, false], '§4 Mark checked: a changed draft only')

// ------------------------------------------------------------------ §5
section('§5  a plain module')
const SRC = fs.readFileSync(CLIENT, 'utf8')
ok(!/^\s*import\b/m.test(SRC), '§5 no imports')
ok(!/\bfetch\s*\(|useApi|\bref\(|from 'vue'/.test(SRC), '§5 no network or Vue')

console.log(`\n${'='.repeat(64)}`)
if (failures.length) {
  console.log(`FAILURES (${failures.length}):`)
  failures.forEach((f) => console.log(`  ✗ ${f}`))
  console.log(`\n${pass} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`✓ ${pass} assertions passed`)
