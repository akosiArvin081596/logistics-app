#!/usr/bin/env node
// client/src/lib/autoInvoiceStatus.js: the words for the automatic invoice-draft
// status on Completed Loads, and their parity with the server's codes.
//
//   §1 PARITY: every reason code lib/auto-invoice-rules.js can send has words, and
//      nothing else does; every changed field the fingerprint can name has words;
//      the states the server's annotation sends are the ones worded
//   §2 the chips: "Draft ready in Gmail", "Waiting for POD", "Waiting: about to be
//      made", "Needs attention: <reason>", with their tones; nothing for a baseline,
//      skipped or malformed status
//   §3 the words are plain sentences: no markup, no address, each ends with a stop
//   §4 the "Needs attention" toggle, Try again and Mark checked
//   §5 the module is plain: no imports, no network, no Vue
//   §6 Approve on the Draft Invoice preview, while real automatic drafts are on:
//      the load's latest draft is read again, and one made since the load was
//      opened (the job's, or another person's) is named and needs a yes, as does a
//      read that failed; the check runs last, after every question and right
//      before the save, and never drops the already-drafted question; the page's
//      check and the preview's approve(), lifted from their files and run over
//      stand-ins, with mutants; off or shadow, nothing changes
//   §7 the automatic-draft settings dialog: each opening starts empty and Save
//      waits for that opening's read, so a failed read never saves over the
//      stored lists; the page's open and save, lifted and run over stand-ins
//   §8 a draft that may be in Gmail: the words send a person to Drafts and Sent
//      Mail, where the job itself looks
//   §9 invoices the job sent: "Sent to the broker", the stop words, the dialog
//   §10 a send waiting for its PODs to settle: "Waiting: about to send"
//   §11 each reason says what happened and what to do next, in words true whether
//      the sweep or the driver's Delivered starts the invoice: a load waiting for a
//      person never reads "tried again on its own"
//   §12 the driver's line above Delivered: the driver app only, never the tracker
//   §15 no alert address on the server (item 118): the settings dialog says alerts are off
//
// No network, no DOM, no database.
//   node scripts/test-auto-invoice-status-client.mjs      # exits 1 on any failure

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'
import { serverSource } from './lib/server-source.js'

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
eq(S.autoInvoiceChip({ state: 'queued', code: '' }), { label: 'Waiting: about to be made', tone: 'muted', reason: 'The invoice will be made shortly.' }, '§2 FAILS ON THE OLD CODE: queued')
eq(S.autoInvoiceChip({ state: 'queued', code: 'GEMINI_DOWN' }), { label: 'Waiting: rate-con reader down', tone: 'muted', reason: S.AUTO_INVOICE_REASONS.GEMINI_DOWN.text }, '§2 FAILS ON THE OLD CODE: queued after a temporary failure says why, on the chip too')
eq(S.autoInvoiceChip({ state: 'queued', code: 'SOMETHING_NEW' }), { label: 'Waiting: about to be made', tone: 'muted', reason: 'The invoice will be made shortly.' }, '§2 FAILS ON THE OLD CODE: queued with an unknown code still reads as about to be made')
eq(S.autoInvoiceChip({ state: 'working' }), { label: 'Making the invoice now', tone: 'muted', reason: 'The invoice is being made. It takes a minute or two.' }, '§2 FAILS ON THE OLD CODE: working')
eq(S.autoInvoiceChip({ state: 'needs_attention', code: 'RECIPIENT_DOMAIN_MISMATCH' }),
  { label: 'Needs attention: billing email on another domain', tone: 'bad', reason: S.AUTO_INVOICE_REASONS.RECIPIENT_DOMAIN_MISMATCH.text }, '§2 needs attention, with its reason')
eq(S.autoInvoiceChip({ state: 'needs_attention', code: 'SOMETHING_NEW' }), { label: 'Needs attention', tone: 'bad', reason: 'Draft it by hand.' }, '§2 an unknown code still reads as needs attention')
eq(S.autoInvoiceChip({ state: 'needs_attention', code: 'BROKER_DOMAIN_UNCONFIRMED' }).label, 'Needs attention: broker domain not confirmed', '§2 the recipient anchor: an unconfirmed broker domain')
eq(S.autoInvoiceChip({ state: 'needs_attention', code: 'BROKER_EMAIL_FREEMAIL' }).label, 'Needs attention: broker email is free mail', '§2 the recipient anchor: a free-mail broker Email')
eq(S.autoInvoiceChip({ state: 'needs_attention', code: 'RATECON_TOTAL_UNREAD' }),
  { label: "Needs attention: rate con total couldn't be read", tone: 'bad', reason: "The rate con's total couldn't be read, so it can't be checked against the Payment on Job Tracking. Try again reads it once more, or draft it by hand." },
  '§2 FAILS ON THE OLD CODE: a rate-con total that wasn\'t read')
ok(/Confirm it in the automatic-draft settings/.test(S.AUTO_INVOICE_REASONS.BROKER_DOMAIN_UNCONFIRMED.text), '§2 the unconfirmed reason says where to confirm the domain')
for (const bad of [null, undefined, 'drafted', {}, { state: 'baseline' }, { state: 'skipped', code: 'DRAFTED_BY_HAND' }, { state: '__proto__' }]) {
  eq(S.autoInvoiceChip(bad), null, `§2 no chip for ${JSON.stringify(bad)}`)
}
eq(S.autoInvoiceChip({ state: 'drafted', changed: ['toString', 7, 'payment'] }).reason, 'Changed since the draft: the Payment. Check the draft in Gmail, then Mark checked.', '§2 unknown changed fields are ignored')
for (const state of S.AUTO_INVOICE_STATES) ok(S.autoInvoiceChip({ state, code: '' }), `§2 ${state} has a chip`)

// ------------------------------------------------------------------ §3
section('§3  plain sentences')
for (const [code, { short, text, attentionText = text }] of Object.entries(S.AUTO_INVOICE_REASONS)) {
  ok(short && text && attentionText && short === short.trim() && text === text.trim() && attentionText === attentionText.trim(), `§3 ${code}: words present, trimmed`)
  ok(!/[<>@]/.test(short + text + attentionText), `§3 ${code}: no markup or address`)
  ok(/[.]$/.test(text) && /[.]$/.test(attentionText) && !/[.]$/.test(short), `§3 ${code}: the sentences end with a stop, the chip words don't`)
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

// One function from a component's <script setup>, as text: `[async ]function
// name(` to its closing brace. null when it isn't there exactly once.
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
const TAB = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'dashboard', 'CompletedLoadsTab.vue'), 'utf8')
const MODAL = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'dashboard', 'InvoiceDraftPreviewModal.vue'), 'utf8')
const fnOf = (name) => (typeof S[name] === 'function' ? S[name] : null)

// ------------------------------------------------------------------ §6
section('§6  Approve re-reads the load\'s drafts while real automatic drafts are on')
const AUTO_DRAFT = Object.freeze({ invoice_id: '10202026-7', created_at: '2026-10-20T14:05:00Z', via: 'auto-imap', recipient: 'billing@example-broker.test' })
const HAND_DRAFT = Object.freeze({ invoice_id: '10192026-3', created_at: '2026-10-19T16:00:00Z', via: 'imap', recipient: 'billing@example-broker.test' })
{
  const made = fnOf('draftMadeSince')
  ok(made, '§6 draftMadeSince() is exported')
  if (made) {
    eq([made(null, null), made(null, AUTO_DRAFT), made(HAND_DRAFT, HAND_DRAFT), made(HAND_DRAFT, { ...HAND_DRAFT }), made(HAND_DRAFT, AUTO_DRAFT), made(HAND_DRAFT, null)],
      [false, true, false, false, true, false], '§6 a draft is new when the latest row differs from the one known at open (none known counts)')
  }
  const recheck = fnOf('recheckLoadDrafts')
  ok(recheck, '§6 recheckLoadDrafts() is exported')
  if (recheck) {
    const run = async (known, latest, answer = true) => {
      const questions = []
      const r = await recheck({
        known,
        readLatest: async () => { if (latest instanceof Error) throw latest; return latest },
        confirm: (text) => { questions.push(text); return answer },
      })
      return { ...r, questions }
    }
    const none = await run(null, null)
    eq([none.go, none.asked, none.questions], [true, false, []], '§6 no draft then or now: Approve goes on, nothing asked')
    const same = await run(HAND_DRAFT, { ...HAND_DRAFT })
    eq([same.go, same.asked, same.questions], [true, false, []], '§6 the draft the dialog showed is still the latest: nothing new asked (the preview\'s own question follows)')
    const meanwhile = await run(null, AUTO_DRAFT, false)
    eq([meanwhile.go, meanwhile.asked], [false, true], '§6 the job drafted the load while the preview was open: a "no" stops the approve')
    eq(meanwhile.questions, ['The automatic invoice drafts made an invoice draft for this load (invoice 10202026-7) since you opened it. Approving creates ANOTHER Gmail draft with a new invoice number (that draft is NOT removed). Continue?'],
      '§6 ...asked once, naming the automatic draft and its invoice number')
    const meanwhileYes = await run(null, AUTO_DRAFT, true)
    eq([meanwhileYes.go, meanwhileYes.asked, meanwhileYes.latest], [true, true, AUTO_DRAFT], '§6 ...a "yes" goes on, and the row read is handed back')
    const person = await run(AUTO_DRAFT, HAND_DRAFT, true)
    ok(/^Someone made an invoice draft for this load \(invoice 10192026-3\) since you opened it\./.test(person.questions[0] || ''), '§6 another person\'s draft made meanwhile is named too')
    const failed = await run(null, new Error('made-up outage'), false)
    eq([failed.go, failed.asked, failed.questions, failed.latest], [false, true, ['Could not check whether an invoice draft was made for this load since you opened it. Approve anyway?'], undefined],
      '§6 a read that fails is asked about, never taken as "no draft"')
    ok(![...meanwhile.questions, ...person.questions, ...failed.questions].some((q) => /@/.test(q)), '§6 no address in a question')
  }
}
{
  // The page: CompletedLoadsTab.vue's beforeApproveDraft(), over stand-ins.
  const src = liftFn(TAB, 'beforeApproveDraft', { async: true })
  ok(src, '§6 CompletedLoadsTab.vue defines beforeApproveDraft() once')
  const recheck = fnOf('recheckLoadDrafts')
  if (src && recheck) {
    const page = async ({ superAdmin = true, known = null, latest = null, answer = true } = {}) => {
      const gets = []
      const asked = []
      const approvedDraft = { value: known }
      const fn = new Function('auth', 'loadIdValue', 'recheckLoadDrafts', 'approvedDraft', 'api', 'window', `${src}\nreturn beforeApproveDraft;`)(
        { isSuperAdmin: superAdmin }, { value: 'LD-TEST #7' }, recheck, approvedDraft,
        { get: async (u) => { gets.push(u); return { draft: latest } } },
        { confirm: (t) => { asked.push(t); return answer } },
      )
      const r = await fn()
      return { r, gets, asked, approvedDraft: approvedDraft.value }
    }
    const fresh = await page({ latest: AUTO_DRAFT, answer: false })
    eq([fresh.r.go, fresh.gets, fresh.asked.length], [false, ['/api/loads/LD-TEST%20%237/invoice-draft'], 1], '§6 the page reads GET …/invoice-draft for the load, encoded, and asks')
    eq(fresh.approvedDraft, AUTO_DRAFT, '§6 ...and the dialog\'s draft line then shows the draft made meanwhile')
    const quiet = await page({ known: HAND_DRAFT, latest: HAND_DRAFT })
    eq([quiet.r.go, quiet.r.asked, quiet.asked.length, quiet.approvedDraft], [true, false, 0, HAND_DRAFT], '§6 nothing new: no question, the line unchanged')
    const other = await page({ superAdmin: false, latest: AUTO_DRAFT })
    eq([other.r.go, other.gets.length], [false, 0], '§6 anyone but a Super Admin: stopped, nothing read')
  }
  const mount = (/<InvoiceDraftPreviewModal\b[\s\S]*?\/>/.exec(TAB) || [''])[0]
  ok(mount.includes(':before-approve="autoMode === \'on\' ? beforeApproveDraft : null"'), '§6 the page hands the check to the preview only while real automatic drafts are on (off and shadow approve as before)')
}
{
  // The preview: InvoiceDraftPreviewModal.vue's approve(), over stand-ins.
  const src = liftFn(MODAL, 'approve', { async: true })
  ok(src && /beforeApprove/.test(src), '§6 the preview\'s approve() asks the page\'s check')
  ok(/\bbeforeApprove: \{ type: Function, default: null \}/.test(MODAL), '§6 the preview\'s beforeApprove prop: a function, none by default')
  if (src) {
    const approveWith = ({ beforeApprove, alreadyDrafted = false, confirm = true, refuseFirst = null, prompt = null }) => {
      const posts = []
      const bodies = []
      const confirms = []
      const prompts = []
      const approving = { value: false }
      const approveError = { value: '' }
      const fn = new Function(
        'approving', 'canApprove', 'props', 'window', 'edited', 'approveError', 'buildOverrideBody', 'api', 'APPROVE_TIMEOUT_MS',
        'emit', 'recipient', 'originalTo', 'str', 'totalChangeConfirm', 'DUPLICATE_APPROVE_MSG', 'isMaybeSaved', 'isReissueRefusal', 'reissuePrompt', 'reissueBody',
        `${src}\nreturn approve;`,
      )(
        approving, { value: true }, { alreadyDrafted, loadId: 'LD-TEST-0007', beforeApprove },
        { confirm: (t) => { confirms.push(t); return confirm }, prompt: (t) => { prompts.push(t); return prompt } },
        { value: { total: false } }, approveError, () => ({ invoiceTo: 'ap@example.com' }),
        { post: async (u, b) => { posts.push(u); bodies.push(b); if (refuseFirst && posts.length === 1) throw refuseFirst; return { invoiceId: 'INV-1', warnings: [] } } }, 60000,
        () => {}, { value: 'ap@example.com' }, { value: 'ap@example.com' }, (v) => (v == null ? '' : String(v)), () => '', 'ALREADY DRAFTED?',
        () => false, S.isReissueRefusal, S.reissuePrompt, S.reissueBody,
      )
      return { approve: fn, posts, bodies, confirms, prompts, approving, approveError }
    }
    let a = approveWith({ beforeApprove: async () => ({ go: false, asked: true }) })
    await a.approve()
    eq([a.posts.length, a.confirms], [0, []], '§6 the check says stop: nothing is posted')
    a = approveWith({ beforeApprove: async () => ({ go: true, asked: true }), alreadyDrafted: true })
    await a.approve()
    eq([a.posts.length, a.confirms], [1, ['ALREADY DRAFTED?']],
      '§6 FAILS ON THE OLD CODE: the check asked about something new and was told yes: one post, and the already-drafted question was still asked, before the check')
    a = approveWith({ beforeApprove: async () => ({ go: true, asked: false }), alreadyDrafted: true })
    await a.approve()
    eq([a.posts.length, a.confirms], [1, ['ALREADY DRAFTED?']], '§6 nothing new found: the already-drafted question is still asked')
    let release = null
    a = approveWith({ beforeApprove: () => new Promise((r) => { release = r }) })
    const first = a.approve()
    const heldWhileReading = a.approving.value
    await a.approve()
    if (release) release({ go: true, asked: false })
    await first
    eq([heldWhileReading, a.posts.length], [true, 1], '§6 Approve is held while the check reads: a second click makes nothing')
    a = approveWith({ beforeApprove: async () => { throw new Error('made-up') } })
    await a.approve()
    eq([a.posts.length, Boolean(a.approveError.value), a.approving.value], [0, true, false], '§6 a check that throws: nothing posted, an error shown, Approve free again')
    a = approveWith({ beforeApprove: null, alreadyDrafted: true })
    await a.approve()
    eq([a.posts.length, a.confirms], [1, ['ALREADY DRAFTED?']], '§6 no check (automatic drafts off or shadow): the approve as before')

    // The automatic job sent this load's invoice: another goes only with a reason.
    const sentRefusal = Object.assign(new Error('Invoice #10202026-1 for this load was already sent to the broker automatically.'), { status: 409, code: 'INVOICE_ALREADY_SENT' })
    a = approveWith({ beforeApprove: null, refuseFirst: sentRefusal, prompt: '  corrected rate per the broker  ' })
    await a.approve()
    eq([a.posts.length, a.prompts.length, a.bodies[1]], [2, 1, { invoiceTo: 'ap@example.com', confirmReissue: true, reissueReason: 'corrected rate per the broker' }],
      '§6 FAILS ON THE OLD CODE: refused as already sent: the reason is asked once, and the same body goes again with the re-issue confirmed')
    ok(/already sent/.test(a.prompts[0] || '') && /reason/.test(a.prompts[0] || ''), '§6 ...the question says the invoice went and asks for the reason')
    a = approveWith({ beforeApprove: null, refuseFirst: sentRefusal, prompt: null })
    await a.approve()
    eq([a.posts.length, /already sent/.test(a.approveError.value), /Nothing was sent/.test(a.approveError.value)], [1, true, true],
      '§6 ...Cancel (or no reason): nothing more is posted, and the refusal is shown')
    a = approveWith({ beforeApprove: null, refuseFirst: sentRefusal, prompt: '   ' })
    await a.approve()
    eq(a.posts.length, 1, '§6 ...only spaces: nothing more is posted')
    a = approveWith({ beforeApprove: null, refuseFirst: Object.assign(new Error('made-up refusal'), { status: 409, code: 'TRAILER_MISMATCH' }), prompt: 'x' })
    await a.approve()
    eq([a.posts.length, a.prompts.length], [1, 0], '§6 any other refusal: no re-issue question, one post')
  }
}
{
  // The order inside the preview's approve(): every question first, then the
  // page's check, then the post, so the check sees a draft made while a question
  // was open; the already-drafted question is never dropped for the check.
  const src = liftFn(MODAL, 'approve', { async: true })
  if (src) {
    const order = (fnSrc, { check = async () => ({ go: true, asked: false }), alreadyDrafted = false, totalEdited = false, answers = [], events = [] } = {}) => {
      const approving = { value: false }
      const approveError = { value: '' }
      const left = [...answers]
      const fn = new Function(
        'approving', 'canApprove', 'props', 'window', 'edited', 'approveError', 'buildOverrideBody', 'api', 'APPROVE_TIMEOUT_MS',
        'emit', 'recipient', 'originalTo', 'str', 'totalChangeConfirm', 'DUPLICATE_APPROVE_MSG', 'isMaybeSaved', 'isReissueRefusal', 'reissuePrompt', 'reissueBody',
        `${fnSrc}\nreturn approve;`,
      )(
        approving, { value: true },
        { alreadyDrafted, loadId: 'LD-TEST-0008', beforeApprove: check && (async () => { events.push('check'); return check() }) },
        { confirm: (t) => { events.push(`ask: ${t}`); return left.length ? left.shift() : true }, prompt: () => null },
        { value: { total: totalEdited } }, approveError, () => ({}), { post: async () => { events.push('post'); return { invoiceId: 'INV-2', warnings: [] } } }, 60000,
        () => {}, { value: 'ap@example.com' }, { value: 'ap@example.com' }, (v) => (v == null ? '' : String(v)), () => 'TOTAL CHANGED?', 'ALREADY DRAFTED?',
        () => false, () => false, () => '', () => null,
      )
      return { approve: fn, events, approving, approveError }
    }
    const QUESTIONS = ['ask: ALREADY DRAFTED?', 'ask: TOTAL CHANGED?']
    let o = order(src, { alreadyDrafted: true, totalEdited: true })
    await o.approve()
    eq(o.events, [...QUESTIONS, 'check', 'post'], '§6 FAILS ON THE OLD CODE: the check runs last, right before the save: after the already-drafted and total questions, nothing between it and the post')
    o = order(src, { alreadyDrafted: true, answers: [false] })
    await o.approve()
    eq(o.events, ['ask: ALREADY DRAFTED?'], '§6 FAILS ON THE OLD CODE: a "no" to a question: no check is read and nothing is posted')
    o = order(src, { totalEdited: true, check: async () => ({ go: false, asked: true }) })
    await o.approve()
    eq([o.events, o.approving.value], [['ask: TOTAL CHANGED?', 'check'], false], '§6 FAILS ON THE OLD CODE: the check says stop after the questions: nothing posted, Approve free again')
    o = order(src, { alreadyDrafted: true, check: async () => ({ go: true, asked: true, latest: undefined }) })
    await o.approve()
    eq(o.events, ['ask: ALREADY DRAFTED?', 'check', 'post'], '§6 FAILS ON THE OLD CODE: a check whose read failed (its own question answered yes) never drops the already-drafted question')
    const recheck = fnOf('recheckLoadDrafts')
    const shared = []
    o = order(src, {
      alreadyDrafted: true,
      events: shared,
      check: () => recheck({ known: HAND_DRAFT, readLatest: async () => { throw new Error('made-up outage') }, confirm: (t) => { shared.push(`ask: ${t}`); return true } }),
    })
    await o.approve()
    eq(shared, ['ask: ALREADY DRAFTED?', 'check', `ask: ${S.DRAFT_RECHECK_FAILED_TEXT}`, 'post'],
      '§6 FAILS ON THE OLD CODE: with the page\'s own re-check and a read that fails: the already-drafted warning, then "could not check", then the post')
    let calls = 0
    o = order(src, { check: async () => { calls++; if (calls === 1) throw new Error('made-up'); return { go: false, asked: true } } })
    await o.approve()
    const shown = o.approveError.value
    await o.approve()
    eq([Boolean(shown), o.approveError.value, o.events.filter((e) => e === 'post').length], [true, '', 0],
      '§6 FAILS ON THE OLD CODE: the error a check that threw left is cleared at the next Approve, before its check')

    // Each decision removed in turn: the case that pins it must change.
    const once = (s, from, to) => (s && s.split(from).length === 2 ? s.replace(from, () => to) : null)
    const checkFirst = once(once(src, '  if (approving.value || !canApprove.value) return\n',
      '  if (approving.value || !canApprove.value) return\n  if (props.beforeApprove) { const early = await props.beforeApprove(); if (!early || !early.go) return }\n'),
    '    if (props.beforeApprove) {\n      let check = null', '    if (false) {\n      let check = null')
    const noDuplicate = once(src, 'if (props.alreadyDrafted && !window.confirm(DUPLICATE_APPROVE_MSG)) return',
      'if (props.alreadyDrafted && !props.beforeApprove && !window.confirm(DUPLICATE_APPROVE_MSG)) return')
    const keepsError = once(src, '  approving.value = true\n  approveError.value = \'\'\n  try {\n', '  approving.value = true\n  try {\n')
    ok(checkFirst && noDuplicate && keepsError, '§6 MUTANTS applied to approve() once each')
    if (checkFirst) {
      const m = order(checkFirst, { alreadyDrafted: true, totalEdited: true })
      await m.approve()
      ok(JSON.stringify(m.events) !== JSON.stringify([...QUESTIONS, 'check', 'post']), '§6 MUTANT the check before the questions (the old order): caught')
    }
    if (noDuplicate) {
      const m = order(noDuplicate, { alreadyDrafted: true, check: async () => ({ go: true, asked: true, latest: undefined }) })
      await m.approve()
      ok(!m.events.includes('ask: ALREADY DRAFTED?'), '§6 MUTANT the already-drafted question dropped while a check runs: caught')
    }
    if (keepsError) {
      let n = 0
      const m = order(keepsError, { check: async () => { n++; if (n === 1) throw new Error('made-up'); return { go: false, asked: true } } })
      await m.approve()
      await m.approve()
      ok(m.approveError.value !== '', '§6 MUTANT the old error kept at the next Approve: caught')
    }
  }
}

// ------------------------------------------------------------------ §7
section('§7  the settings dialog: Save waits for a read that worked')
{
  const can = fnOf('canSaveAutoSettings')
  ok(can, '§7 canSaveAutoSettings() is exported')
  if (can) {
    eq([can({ read: true }), can({ read: false }), can({}), can(), can({ read: true, loading: true }), can({ read: true, saving: true }), can({ read: 'yes' })],
      [true, false, false, false, false, false, false], '§7 Save only after this opening\'s read worked, and not while reading or saving')
  }
  const openSrc = liftFn(TAB, 'openAutoSettings', { async: true })
  const saveSrc = liftFn(TAB, 'saveAutoSettings', { async: true })
  ok(openSrc && saveSrc, '§7 the page\'s openAutoSettings() and saveAutoSettings() are found')
  if (openSrc && saveSrc) {
    const NAMES = ['auth', 'autoSettingsLoading', 'autoSettingsOpen', 'autoSettingsError', 'autoSettingsProblem', 'autoSettingsRead', 'autoConfirmedText',
      'autoOptOutText', 'api', 'AUTO_INVOICE_REASONS', 'autoSettingsSaving', 'canSaveAutoSettings', 'domainList', 'toast', 'dashboard', 'autoSend', 'autoRecipientCheck', 'autoAlerts']
    const dialog = (getAnswer) => {
      const st = {
        auth: { isSuperAdmin: true }, autoSettingsLoading: { value: false }, autoSettingsOpen: { value: false }, autoSettingsError: { value: '' },
        autoSettingsProblem: { value: '' }, autoSettingsRead: { value: true }, autoConfirmedText: { value: 'stale-confirmed.test' },
        autoOptOutText: { value: 'stale-optout.test' }, puts: [], autoSend: { value: { domains: ['stale.test'], stopped: null } },
        autoRecipientCheck: { value: { on: false, domain: 'stale.test', days: 7, held: { count: 9, byCode: {} } } },
        autoAlerts: { value: { on: false, from: 'an earlier opening' } },
      }
      const api = {
        get: async () => { const v = getAnswer(); if (v instanceof Error) throw v; return v },
        put: async (u, body) => { st.puts.push([u, body]); return body },
      }
      const deps = [st.auth, st.autoSettingsLoading, st.autoSettingsOpen, st.autoSettingsError, st.autoSettingsProblem, st.autoSettingsRead, st.autoConfirmedText,
        st.autoOptOutText, api, S.AUTO_INVOICE_REASONS, { value: false }, can || (() => true), (t) => String(t || '').split(/[\s,;]+/).filter(Boolean), () => {}, { refresh: async () => {} }, st.autoSend, st.autoRecipientCheck, st.autoAlerts]
      const open = new Function(...NAMES, `${openSrc}\nreturn openAutoSettings;`)(...deps)
      const save = new Function(...NAMES, `${saveSrc}\nreturn saveAutoSettings;`)(...deps)
      return { st, open, save }
    }
    // The review's case: the read times out; the text from an earlier opening must not be saved.
    const bad = dialog(() => Object.assign(new Error('Request timed out'), { status: 0 }))
    await bad.open()
    eq([bad.st.autoConfirmedText.value, bad.st.autoOptOutText.value, bad.st.autoSettingsRead.value, Boolean(bad.st.autoSettingsError.value)], ['', '', false, true],
      '§7 a failed read: both lists start empty (nothing from an earlier opening), not read, the error shown')
    eq(bad.st.autoRecipientCheck.value, null, '§7 ...and no line about the check from an earlier opening')
    const heldRead = { on: true, domain: 'chrobinson.com', days: 7, held: { count: 1, byCode: { RECIPIENT_NOT_KNOWN: 1 } } }
    const readsCheck = dialog(() => ({ optOutDomains: [], confirmedBrokerDomains: [], unreadable: false, dropped: [], recipientCheck: heldRead }))
    await readsCheck.open()
    eq(readsCheck.st.autoRecipientCheck.value, heldRead, '§7 a read that says what the check has held: the dialog has it')
    const readsNone = dialog(() => ({ optOutDomains: [], confirmedBrokerDomains: [], unreadable: false, dropped: [] }))
    await readsNone.open()
    eq(readsNone.st.autoRecipientCheck.value, null, '§7 ...one that says nothing: no line')
    eq([bad.st.autoAlerts.value, readsNone.st.autoAlerts.value], [null, null], '§7 FAILS ON THE OLD CODE: no line about alerts from an earlier opening, after a failed read or one that says nothing (item 118)')
    const alertsOff = dialog(() => ({ optOutDomains: [], confirmedBrokerDomains: [], unreadable: false, dropped: [], alerts: { on: false } }))
    await alertsOff.open()
    eq(alertsOff.st.autoAlerts.value, { on: false }, '§7 FAILS ON THE OLD CODE: ...a read that says alerts are off: the dialog has it (item 118)')
    bad.st.autoConfirmedText.value = 'example-new.test'
    await bad.save()
    eq(bad.st.puts, [], '§7 ...and Save sends nothing, so the stored opt-outs are never replaced by an empty list')
    const good = dialog(() => ({ optOutDomains: ['example-optout.test'], confirmedBrokerDomains: ['example-broker.test'], unreadable: false, dropped: [] }))
    await good.open()
    eq([good.st.autoConfirmedText.value, good.st.autoOptOutText.value, good.st.autoSettingsRead.value], ['example-broker.test', 'example-optout.test', true], '§7 a read that worked fills both lists')
    eq([bad.st.autoSend.value, good.st.autoSend.value], [null, null], '§7 sending off (no `send` in the read), or a failed read: no sending section, nothing kept from an earlier opening')
    const sendOn = dialog(() => ({ optOutDomains: [], confirmedBrokerDomains: ['example-broker.test'], unreadable: false, dropped: [], send: { domains: ['example-broker.test'], stopped: null } }))
    await sendOn.open()
    eq(sendOn.st.autoSend.value, { domains: ['example-broker.test'], stopped: null }, '§7 sending on: the read\'s `send` is kept for the dialog')
    good.st.autoConfirmedText.value = 'example-broker.test\nexample-new.test'
    await good.save()
    eq(good.st.puts, [['/api/auto-invoice/settings', { confirmedBrokerDomains: ['example-broker.test', 'example-new.test'], optOutDomains: ['example-optout.test'] }]],
      '§7 ...then Save sends both lists, the opt-outs as read')
  }
  const saveTag = (/<button[^>]*@click="saveAutoSettings"[^>]*>/.exec(TAB) || [''])[0]
  ok(/:disabled="!autoSettingsCanSave"/.test(saveTag), '§7 the Save button is disabled until the read worked (autoSettingsCanSave)')
  ok(/const autoSettingsCanSave = computed\(\(\) => canSaveAutoSettings\(\{ read: autoSettingsRead\.value, loading: autoSettingsLoading\.value, saving: autoSettingsSaving\.value \}\)\)/.test(TAB),
    '§7 ...which is canSaveAutoSettings() over the read, loading and saving flags')
  const areas = TAB.match(/<textarea id="auto-(?:confirmed|opt-out)"[^>]*>/g) || []
  ok(areas.length === 2 && areas.every((t) => t.includes(':disabled="autoSettingsLoading || !autoSettingsRead"')), '§7 both lists stay disabled until the read worked')
}

// ------------------------------------------------------------------ §8
section('§8  a draft that may be in Gmail: Drafts and Sent Mail')
ok(/Drafts and Sent Mail/.test(S.AUTO_INVOICE_REASONS.MAYBE_IN_GMAIL.text), '§8 MAYBE_IN_GMAIL: Try again looks in Drafts and Sent Mail')
ok(S.AUTO_INVOICE_REASONS.LOAD_FACTORED && /Triumph/.test(S.AUTO_INVOICE_REASONS.LOAD_FACTORED.text) && /not by email/.test(S.AUTO_INVOICE_REASONS.LOAD_FACTORED.text),
  '§8 FAILS ON THE OLD CODE: LOAD_FACTORED has words: its invoice goes through Triumph, not by email')
ok(/Drafts and Sent Mail/.test(S.AUTO_INVOICE_REASONS.IN_GMAIL_UNRECORDED.text), '§8 IN_GMAIL_UNRECORDED: a person checks Drafts and Sent Mail before drafting again')

// ------------------------------------------------------------------ §9
section('§9  invoices the job sent (AUTO_INVOICE_SEND_ENABLED): never "check it and send it"')
{
  const sentChip = S.autoInvoiceChip({ state: 'drafted', code: '', invoiceId: '10202026-1', changed: [], sent: true })
  eq(sentChip && [sentChip.label, sentChip.tone], ['Sent to the broker', 'ok'], '§9 FAILS ON THE OLD CODE: an invoice the job sent reads "Sent to the broker"')
  ok(sentChip && /Sent Mail/.test(sentChip.reason) && !/Drafts|send it/i.test(sentChip.reason), '§9 ...in Sent Mail, never "in Gmail Drafts, check it and send it"')
  const changed = S.autoInvoiceChip({ state: 'drafted', code: '', invoiceId: '10202026-1', changed: ['payment'], sent: true })
  ok(changed && changed.label === 'Sent to the broker: load changed' && /sent to the broker/.test(changed.reason) && !/Check the draft/.test(changed.reason),
    '§9 FAILS ON THE OLD CODE: a load changed after its send says the invoice already went, not "check the draft"')
  const draft = S.autoInvoiceChip({ state: 'drafted', code: '', invoiceId: '10202026-1', changed: [] })
  eq(draft && draft.label, 'Draft ready in Gmail', '§9 a draft (no `sent`) reads as before')
  const checking = S.autoInvoiceChip({ state: 'queued', code: 'SEND_UNCONFIRMED' })
  eq(checking && checking.label, 'Checking Sent Mail', '§9 FAILS ON THE OLD CODE: a send with no answer reads "Checking Sent Mail", not "Drafting soon"')
  ok(/never sent twice/i.test((S.AUTO_INVOICE_REASONS.SEND_UNCONFIRMED || {}).text || '') && /never sends/i.test((S.AUTO_INVOICE_REASONS.MAYBE_SENT || {}).text || ''),
    '§9 SEND_UNCONFIRMED and MAYBE_SENT say the invoice is never sent again')
  ok(/SENT an invoice/.test(S.draftMadeSinceText({ invoice_id: '10202026-1', via: 'auto-smtp' })), '§9 FAILS ON THE OLD CODE: Approve names an invoice the job SENT since the dialog opened')
  ok(/automatic invoice drafts made/.test(S.draftMadeSinceText({ invoice_id: '10202026-1', via: 'auto-imap' })), '§9 ...and the job\'s draft as before')
  eq([...(S.AUTO_INVOICE_VIAS || [])].sort(), [...(rules.JOB_VIAS || ['(none on this tree)'])].sort(), '§9 FAILS ON THE OLD CODE: the client knows the job\'s via values exactly (rules.JOB_VIAS)')

  // The stop's words: exactly the server's reasons. A tree without sending names
  // its failures instead of stopping the run.
  let sendRules = null
  try { sendRules = require(path.join(ROOT, 'lib', 'auto-invoice-send.js')) } catch { sendRules = null }
  eq(Object.keys(S.AUTO_INVOICE_STOP_WORDS || {}).sort(), [...((sendRules && sendRules.STOP_REASONS) || ['(none on this tree)'])].sort(), '§9 FAILS ON THE OLD CODE: the client words exactly the server\'s stop reasons')
  const sendState = fnOf('autoSendState') || (() => undefined)
  eq(sendState(null), null, '§9 FAILS ON THE OLD CODE: sending off: no sending section')
  const on = sendState({ domains: ['example-broker.test'], stopped: null })
  ok(on && on.canStop === true && /example-broker\.test/.test(on.text), '§9 sending on: the domains it sends to, and Stop offered')
  const stopped = sendState({ domains: ['example-broker.test'], stopped: { at: '2026-10-20T14:00:00.000Z', reason: 'SMTP_REFUSED' } })
  ok(stopped && stopped.canStop === false && /stopped/.test(stopped.text) && /refused an invoice email/.test(stopped.text) && /Only the server/.test(stopped.text),
    '§9 stopped: why, and no button (only the server resumes)')
  // Holds never stop sending (AUTO_INVOICE_HOLD_ONE_LOAD): no stop reason counts held loads, on either side.
  ok(!Object.hasOwn(S.AUTO_INVOICE_STOP_WORDS || {}, 'TOO_MANY_HELD') && Boolean(sendRules) && !sendRules.STOP_REASONS.includes('TOO_MANY_HELD'),
    '§9 FAILS ON THE OLD CODE: no stop reason counts held loads, on either side')
  const unknown = sendState({ domains: ['example-broker.test'], stopped: { at: '2026-10-20T14:00:00.000Z', reason: 'TOO_MANY_HELD' } })
  eq(unknown && unknown.text, 'Automatic sending is stopped. Invoices are drafted in Gmail for a person to send. Only the server can turn sending back on.',
    '§9 FAILS ON THE OLD CODE: a stop whose reason has no words here reads as stopped, with no reason given')
  const stopTag = (/<button[^>]*@click="stopAutoSend"[^>]*>/.exec(TAB) || [''])[0]
  ok(/v-if="autoSendView\.canStop"/.test(stopTag) && /:disabled="autoSendStopping"/.test(stopTag), '§9 FAILS ON THE OLD CODE: the dialog\'s Stop button shows only while sending can be stopped')
  const stopSrc = liftFn(TAB, 'stopAutoSend', { async: true })
  ok(stopSrc && /window\.confirm\(AUTO_SEND_STOP_CONFIRM\)/.test(stopSrc) && /api\.post\('\/api\/auto-invoice\/send\/stop', \{\}\)/.test(stopSrc),
    '§9 ...asks first, then posts to the set-only Stop route')
  ok(!/send\/resume|clearSendStop/.test(TAB), '§9 the page has no way to resume sending')
}

// ------------------------------------------------------------------ §10
section('§10 a send waiting for its PODs to settle (AUTO_INVOICE_SEND_SETTLE_MINUTES)')
{
  const settling = S.autoInvoiceChip({ state: 'waiting', code: 'SEND_SETTLING' })
  eq(settling && [settling.label, settling.tone], ['Waiting: about to send', 'muted'],
    '§10 FAILS ON THE OLD CODE: a load whose invoice waits for its PODs to settle reads "Waiting: about to send" (the waiting chip, muted)')
  const text = (S.AUTO_INVOICE_REASONS.SEND_SETTLING || {}).text || ''
  ok(/sent automatically/.test(text) && /newest POD/.test(text) && /new POD starts the wait again/.test(text),
    '§10 FAILS ON THE OLD CODE: ...it says the invoice goes on its own after the wait that follows the newest POD, and that a new POD starts the wait again')
  eq([S.autoInvoiceNeedsAttention({ _autoInvoice: { state: 'waiting', code: 'SEND_SETTLING' } }), S.canTryAgain({ state: 'waiting', code: 'SEND_SETTLING' })], [false, false],
    '§10 ...not a load for a person: not counted as Needs attention, no Try again')
}

// ------------------------------------------------------------------ §11
section('§11 what happened and what to do next, whichever starts the invoice')
{
  const R = S.AUTO_INVOICE_REASONS
  const TEXT = {
    WAITING_POD: 'Waiting for the POD. Upload it; no invoice is made until then.',
    NOT_COMPLETED: "The load wasn't marked Delivered at the last check, so no invoice has been made. If it was delivered, set it back. Reload this page in 10 minutes and open this load again. If this line is still here, draft it by hand.",
    LOAD_DROPPED: 'The load was cancelled or deleted, so no invoice is made. Nothing to do.',
    SETTINGS_UNREADABLE: 'The automatic invoice settings could not be read, so nothing is made or sent. Save both lists in Automatic drafts.',
    NO_BROKER_EMAIL: 'Job Tracking has no broker Email for this load. Add it, then Try again, or draft it by hand.',
    BROKER_EMAIL_FREEMAIL: "The broker Email on Job Tracking is a free-mail address, so it can't vouch for a billing email. Put the broker's company email on Job Tracking, then Try again, or draft it by hand.",
    MONTH_UNKNOWN: "The load's month can't be told from its dates. Check its dates, then Try again, or draft it by hand.",
    OFF_GAP: 'The load was delivered while automatic invoices were off, so it may already be invoiced. Check Gmail Sent Mail, then draft it by hand if it still needs one.',
    TOTAL_MISMATCH: "The rate con's total and the Payment on Job Tracking don't agree, or the Payment isn't one plain amount. Check both; if a re-issued rate con changed it, see its alert. Fix Job Tracking if it's wrong, then Try again, or draft it by hand.",
    RATECON_TOTAL_UNREAD: "The rate con's total couldn't be read, so it can't be checked against the Payment on Job Tracking. Try again reads it once more, or draft it by hand.",
    INVOICE_TOTAL_UNKNOWN: 'Neither the rate con nor Job Tracking gave an invoice total. Draft it by hand and type the total.',
    TRAILER_MISMATCH: "The rate con's trailer differs from Job Tracking. If Job Tracking is wrong, fix it, then Try again, or draft it by hand.",
    DRAFT_FAILED: 'Making the invoice or saving it to Gmail kept failing. Try again, or draft it by hand.',
    POD_UNREADABLE: "A POD on file has no readable file. Upload the POD again, delete the one that won't open, then Try again.",
    POD_PAGE_UNREADABLE: "A POD page couldn't be read. Upload the POD again, delete the one that won't open, then Try again.",
    IN_GMAIL_UNRECORDED: "The invoice is in Gmail, but LogisX couldn't record it. Try again records it if it can. Check Gmail Drafts and Sent Mail before making another.",
  }
  for (const [code, words] of Object.entries(TEXT)) eq(R[code] && R[code].text, words, `§11 FAILS ON THE OLD CODE: ${code}: the sentence`)

  // While a person must act: the job isn't coming back to this load by itself.
  const ATTENTION = {
    WAITING_POD: 'No POD was found when the invoice was started. Upload it, then Try again.',
    RATECON_MISSING: 'No rate con was found for this load. Add the rate con, then Try again, or draft it by hand.',
    RETRY_LATER: 'Making the invoice failed. Try again, or draft it by hand.',
    GEMINI_DOWN: "The rate-con reader was unavailable, so no invoice was made. Try again once it's back, or draft it by hand.",
    RENDERER_BUSY: 'The PDF renderer was busy, so no invoice was made. Try again in a few minutes.',
    MAILBOX_PAUSED: 'Gmail refused the mailbox login, so no invoice was made. LogisX waits up to 6 hours before it logs in again, so Try again after that. If it lasts, ask the mailbox owner to check it.',
    HAND_DRAFT_IN_FLIGHT: "Someone was drafting this invoice by hand, so it wasn't sent. If that draft didn't save, Try again.",
    SETTINGS_UNREADABLE: 'The automatic invoice settings could not be read, so nothing is made or sent. Open Automatic drafts, then save both lists, then Try again.',
  }
  for (const [code, words] of Object.entries(ATTENTION)) {
    const chip = S.autoInvoiceChip({ state: 'needs_attention', code })
    eq(chip && chip.reason, words, `§11 FAILS ON THE OLD CODE: ${code}: while it needs a person, the chip reads its own sentence`)
  }
  eq(S.autoInvoiceChip({ state: 'needs_attention', code: 'CLOSED_MONTH' }).reason, R.CLOSED_MONTH.text, '§11 a code with one sentence reads it in every state')

  // The sentences the sweep's own retries show stay until a person is needed.
  const SWEEP = {
    RATECON_MISSING: ['waiting', 'No rate con was found for this load. It is looked for again every 2 hours, three times; after that, draft it by hand.'],
    RETRY_LATER: ['queued', 'The last try failed. It is tried again on its own.'],
    GEMINI_DOWN: ['queued', 'The rate-con reader is unavailable. It is tried again in 30 minutes.'],
    RENDERER_BUSY: ['queued', 'The PDF renderer was busy. It is tried again in a few minutes.'],
    MAILBOX_PAUSED: ['queued', 'Gmail refused the mailbox login, so automatic drafts are paused. They try again on their own.'],
    HAND_DRAFT_IN_FLIGHT: ['queued', 'Someone was drafting this invoice by hand, so it was not sent. It is looked at again in a few minutes.'],
  }
  for (const [code, [state, words]] of Object.entries(SWEEP)) eq(S.autoInvoiceChip({ state, code }).reason, words, `§11 ${code}, ${state}: the sweep's sentence, for as long as the sweep holds it`)

  // No code, in any state, tells a person the job comes back on its own once it needs them.
  const COMES_BACK = /on (?:its|their) own|tried again in|looked for again|looked at again/
  for (const code of rules.REASON_CODES) {
    ok(!COMES_BACK.test(S.autoInvoiceChip({ state: 'needs_attention', code }).reason), `§11 FAILS ON THE OLD CODE: ${code}: needs attention, and no promise the job comes back by itself`)
    ok(!/trying again/.test(S.autoInvoiceChip({ state: 'needs_attention', code }).label), `§11 FAILS ON THE OLD CODE: ${code}: the chip doesn't read "Needs attention: trying again"`)
  }
  // The states the sweep holds a load in have no Try again button, so their
  // sentences can't ask for one; the settings dialog shows SETTINGS_UNREADABLE's too.
  for (const code of ['RETRY_LATER', 'GEMINI_DOWN', 'RENDERER_BUSY', 'MAILBOX_PAUSED', 'SETTINGS_UNREADABLE', 'SEND_UNCONFIRMED', 'HAND_DRAFT_IN_FLIGHT']) {
    eq(S.canTryAgain({ state: 'queued', code }), false, `§11 ${code}, queued: no Try again button`)
    ok(!/Try again/.test(R[code].text), `§11 ${code}: its queued sentence doesn't ask for Try again`)
  }
  eq(S.autoInvoiceChip({ state: 'waiting', code: 'NOT_COMPLETED' }).label, 'Waiting: not delivered', '§11 NOT_COMPLETED keeps its chip words')
  // The job tells no page when it moves a load, and the open dialog keeps the copy it opened
  // with. A reload shuts the dialog, so "still here" means something only after a new look.
  ok(/Reload this page in \d+ minutes and open this load again\. If this line is still here, draft it by hand\.$/.test(R.NOT_COMPLETED.text), '§11 FAILS ON THE OLD CODE: NOT_COMPLETED: a person reloads and opens the load again before judging the line')
  ok(!/a few minutes later/.test(R.NOT_COMPLETED.text), '§11 FAILS ON THE OLD CODE: NOT_COMPLETED: waiting on an open page is no test: the line never moves there')
  // With the driver's trigger off, the sweep ticks on this timer and a slow run can skip one tick.
  const tick = /const AUTO_INVOICE_TICK_MS = (\d+) \* 60 \* 1000;/.exec(serverSource())
  eq(Number((/Reload this page in (\d+) minutes/.exec(R.NOT_COMPLETED.text) || [])[1]), tick && Number(tick[1]) * 2, '§11 FAILS ON THE OLD CODE: NOT_COMPLETED: the wait covers the sweep\'s tick and one tick skipped behind a slow run')
  eq(R.SETTINGS_UNREADABLE && R.SETTINGS_UNREADABLE.short, 'settings unreadable', '§11 FAILS ON THE OLD CODE: SETTINGS_UNREADABLE names the settings, not one list')
  ok(!/within a few minutes/.test(R.WAITING_POD.text), '§11 WAITING_POD promises no time: nothing but the sweep could keep one')
  eq(rules.LOGIN_PAUSE_MAX_MS, 6 * 60 * 60 * 1000, '§11 MAILBOX_PAUSED\'s "up to 6 hours" is the job\'s longest pause')
}

// ------------------------------------------------------------------ §12
section('§12 the driver\'s line above Delivered')
{
  const STEPPER = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'driver', 'StatusStepper.vue'), 'utf8')
  const LINE = 'Upload every POD page before you tap Delivered. The invoice is made right after you tap. If anything changes later, tell dispatch or a Super Admin right away.'
  eq(STEPPER.split(LINE).length - 1, 1, '§12 FAILS ON THE OLD CODE: the line is there once, word for word')
  const actions = (/<template v-if="!readOnly">[\s\S]*?<div v-if="requiresUpload"/.exec(STEPPER) || [''])[0]
  ok(actions.includes(LINE), '§12 FAILS ON THE OLD CODE: inside the driver-only block, never on the public tracker, and above the upload hint')
  const tag = (new RegExp(`<div ([^>]*)>\\s*${LINE.slice(0, 40)}`).exec(STEPPER) || ['', ''])[1]
  ok(/v-if="nextStep && nextStep\.value === 'Delivered'"/.test(tag), '§12 FAILS ON THE OLD CODE: only while the next step is Delivered')
  ok(!/v-else/.test(tag), '§12 ...outside the hint chain, so it shows with the upload hint too')
  // The driver walkthrough's strict locator and the guide capture's querySelector
  // both find the POD gate by this class, so it stays on one element.
  eq((STEPPER.match(/class="upload-hint"/g) || []).length, 1, '§12 .upload-hint is on the POD gate alone')
  ok(/class="delivered-line"/.test(tag) && /\.upload-hint,\s*\.delivered-line \{/.test(STEPPER), '§12 ...the line has its own class, with the same style')
  ok(/<div v-if="requiresUpload"/.test(STEPPER) && /<div v-else-if="blocked"/.test(STEPPER) && /<div v-else-if="gpsLine"/.test(STEPPER), '§12 the hint chain below it is unchanged')
}

// ------------------------------------------------------------------ §13
section('§13 the driver\'s Delivered starts the invoice: what a Super Admin reads')
{
  const chip = S.autoInvoiceChip({ state: 'needs_attention', code: 'NOT_BY_DRIVER', invoiceId: '', changed: [], trigger: true, retry: 'none' })
  eq(chip && [chip.label, chip.tone], ['No automatic invoice', 'warn'], '§13 FAILS ON THE OLD CODE: a completed load nothing will invoice reads "No automatic invoice", amber, never "Needs attention: ..." in red')
  ok(chip && /only the driver's own Delivered/.test(chip.reason) && /Draft it by hand/.test(chip.reason), '§13 FAILS ON THE OLD CODE: ...it says why and what to do')
  ok(chip && !/Someone other than the driver/.test(chip.reason), '§13 ...and doesn\'t blame the office: a failed write or a restart can leave a driver\'s own tap here too')
  eq(S.autoInvoiceNeedsAttention({ _autoInvoice: { state: 'needs_attention', code: 'NOT_BY_DRIVER' } }), true, '§13 ...the toggle counts it, so it can\'t be forgotten')
  eq([S.canTryAgain({ state: 'needs_attention', code: 'NOT_BY_DRIVER' }), S.canMarkChecked({ state: 'needs_attention', code: 'NOT_BY_DRIVER' })], [false, false], '§13 FAILS ON THE OLD CODE: ...with no Try again: the route has no claim to retry')
  eq([S.canTryAgain({ state: 'needs_attention', code: 'OFF_GAP', retry: 'none' }), S.canTryAgain({ state: 'needs_attention', code: 'OFF_GAP' })], [false, true], '§13 FAILS ON THE OLD CODE: OFF_GAP: no Try again when the server says so (the driver\'s trigger); the sweep\'s row keeps it')

  const send = { state: 'needs_attention', code: 'RETRY_LATER', trigger: true, retry: 'send' }
  ok(/looks in the mailbox/.test(S.tryAgainConfirmText(send)) && /sends this invoice/.test(S.tryAgainConfirmText(send)), '§13 FAILS ON THE OLD CODE: the confirm says Try again looks first, then sends')
  ok(/draft/.test(S.tryAgainConfirmText({ ...send, retry: 'draft' })) && !/sends this invoice/.test(S.tryAgainConfirmText({ ...send, retry: 'draft' })), '§13 FAILS ON THE OLD CODE: ...and makes a draft where it would (a broker not on the list, or sending stopped)')
  ok(/looks in Gmail/.test(S.tryAgainConfirmText({ ...send, code: 'MAYBE_SENT', retry: 'search' })) && !/sends/.test(S.tryAgainConfirmText({ ...send, code: 'MAYBE_SENT', retry: 'search' })), '§13 FAILS ON THE OLD CODE: ...and never says "sends" on a load it only searches for')
  eq([S.tryAgainConfirmText({ state: 'needs_attention', code: 'RETRY_LATER' }), S.tryAgainConfirmText(null)], ['', ''], '§13 the sweep\'s Try again only queues the load: nothing to ask')
  eq([S.tryAgainDoneText(send), S.tryAgainDoneText({ state: 'needs_attention' })], ["It's being made now.", 'It will be tried again within a few minutes.'], '§13 FAILS ON THE OLD CODE: the answer says when, for each')

  const NEW_CODES = ['DRIVER_PENDING', 'NOT_BY_DRIVER', 'CAP_REACHED', 'NO_MAILBOX', 'HANDED_OVER', 'MAILBOX_HIT', 'MAILBOX_UNREAD', 'PAYMENTS_TABLE_HIT', 'PAYMENTS_UNREAD']
  for (const code of NEW_CODES) ok(rules.REASON_CODES.includes(code) && S.AUTO_INVOICE_REASONS[code], `§13 FAILS ON THE OLD CODE: ${code} is a server code with words`)
  for (const code of ['MAILBOX_HIT', 'MAILBOX_UNREAD', 'PAYMENTS_TABLE_HIT', 'PAYMENTS_UNREAD']) ok(/nothing was sent/.test(S.AUTO_INVOICE_REASONS[code].text), `§13 ${code} says nothing was sent`)

  const TAB_SRC = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'dashboard', 'CompletedLoadsTab.vue'), 'utf8')
  const action = liftFn(TAB_SRC, 'autoInvoiceAction', { async: true })
  ok(action && /const ask = kind === 'retry' \? tryAgainConfirmText\(status\) : ''/.test(action) && /if \(ask && !window\.confirm\(ask\)\) return/.test(action), '§13 FAILS ON THE OLD CODE: the dialog\'s Try again asks first, before anything is posted')
  ok(action && action.indexOf('window.confirm(ask)') < action.indexOf('api.post('), '§13 ...a "no" posts nothing')
  ok(action && /tryAgainDoneText\(status\)/.test(action) && !/within a few minutes/.test(action), '§13 FAILS ON THE OLD CODE: its answer comes from the status, not from a fixed sentence')
}

// ------------------------------------------------------------------ §14
section('§14 who a C.H. Robinson invoice may go to: what a Super Admin reads')
{
  const WORDS = {
    RECIPIENT_NOT_KNOWN: ['billing email not used before', "The rate con's billing email isn't one a person has already used on invoices for 3 loads, so nothing was sent. Check it against the rate con, then draft it by hand."],
    RATECON_NAME_MISMATCH: ["rate con's name doesn't match", "The rate con's file name doesn't carry this load's whole number, so it may be another load's and nothing was sent. Check the rate con, then draft it by hand."],
    RATECON_NUMBER_MISMATCH: ["rate con's number doesn't match", "The rate con doesn't give this load's number, or gives another one, so it may be another load's and nothing was sent. Check the rate con, then draft it by hand."],
    RECIPIENT_CHECK_OFF: ['billing email check is off', "The billing email check is switched off on the server, so this invoice wasn't made or sent. Draft it by hand."],
  }
  for (const [code, [short, text]] of Object.entries(WORDS)) {
    ok(rules.REASON_CODES.includes(code), `§14 ${code} is a server code`)
    const chip = S.autoInvoiceChip({ state: 'needs_attention', code, invoiceId: '', changed: [], trigger: true, retry: 'send' })
    eq(chip && [chip.label, chip.tone, chip.reason], [`Needs attention: ${short}`, 'bad', text], `§14 ${code}: a person reads what happened and what to do next`)
    eq(S.autoInvoiceNeedsAttention({ _autoInvoice: { state: 'needs_attention', code } }), true, `§14 ${code}: the toggle counts it`)
  }
  eq(S.canTryAgain({ state: 'needs_attention', code: 'RECIPIENT_NOT_KNOWN', retry: 'send' }), true, '§14 an address not yet known: Try again is offered, for once a person has invoiced it')
  eq(S.canTryAgain({ state: 'needs_attention', code: 'RECIPIENT_CHECK_OFF', retry: 'none' }), false, '§14 the check off: no Try again, since a run can only stop here again')
  ok(/if every check passes/.test(S.tryAgainConfirmText({ state: 'needs_attention', code: 'RECIPIENT_NOT_KNOWN', trigger: true, retry: 'send' })), '§14 the confirm on a load that could send promises nothing past the checks')

  // What the settings dialog says of sending and of the check, from the settings read's own fields.
  const sendText = fnOf('autoSendState') || (() => undefined)
  const checkState = fnOf('recipientCheckState') || (() => ({ text: '(no such function on this tree)' }))
  const CHR = 'chrobinson.com'
  const OFF = { on: false, domain: CHR, days: 7, held: { count: 0, byCode: {} } }
  const ON_LIST = { domains: [CHR], stopped: null }
  const SENT_WORDS = `On: invoices to ${CHR} are sent to the broker automatically, with the POD and the rate con, and their copies are in Gmail Sent Mail. Other brokers get Gmail drafts.`
  eq(sendText(ON_LIST).text, SENT_WORDS, '§14 the check on, sending on: the sentence as before')
  eq(sendText(ON_LIST, null).text, SENT_WORDS, '§14 ...with nothing from the check')
  eq(sendText(ON_LIST, { on: true, domain: CHR, days: 7, held: { count: 2, byCode: { RECIPIENT_NOT_KNOWN: 2 } } }).text, SENT_WORDS, '§14 ...and with loads held: the check has its own line')
  const offSend = sendText(ON_LIST, OFF)
  eq(offSend && offSend.text, `Invoices to ${CHR} aren't sent while the billing email check is off: each load stops at Needs attention for a person to draft by hand. Other brokers get Gmail drafts.`, '§14 the check off: it no longer says invoices are sent')
  ok(offSend && !/are sent/.test(offSend.text), '§14 ...anywhere in the sentence')
  eq(offSend && [offSend.stopped, offSend.canStop], [false, true], '§14 ...and Stop stays offered')
  eq(sendText({ domains: [CHR, 'example-broker.test'], stopped: null }, OFF).text, `On: invoices to example-broker.test are sent to the broker automatically, with the POD and the rate con, and their copies are in Gmail Sent Mail. Invoices to ${CHR} aren't sent while the billing email check is off: each load stops at Needs attention for a person to draft by hand. Other brokers get Gmail drafts.`, '§14 another domain on the list keeps its sentence')
  eq(sendText({ domains: [`billing.${CHR}`], stopped: null }, OFF).text, `Invoices to ${CHR} aren't sent while the billing email check is off: each load stops at Needs attention for a person to draft by hand. Other brokers get Gmail drafts.`, '§14 a subdomain is held with it')
  const stoppedOff = sendText({ domains: [CHR], stopped: { at: 'x', reason: 'SMTP_REFUSED' } }, OFF)
  ok(stoppedOff && stoppedOff.stopped === true && stoppedOff.canStop === false && /Automatic sending is stopped/.test(stoppedOff.text), '§14 stopped, with the check off: it still says stopped')
  eq(checkState(null), null, '§14 nothing from the server: no line')
  eq(checkState({ on: true, domain: CHR, days: 7, held: { count: 0, byCode: {} } }), null, '§14 the check on, nothing held: no line')
  eq(checkState(OFF) && checkState(OFF).text, `The billing email check is switched off on the server, so invoices to ${CHR} aren't made or sent: each load stops at Needs attention for a person to draft by hand.`, '§14 the check off: the line says so plainly')
  eq(checkState({ ...OFF, held: { count: 3, byCode: { RECIPIENT_CHECK_OFF: 3 } } }).text, `The billing email check is switched off on the server, so invoices to ${CHR} aren't made or sent: each load stops at Needs attention for a person to draft by hand. 3 ${CHR} loads were held in the last 7 days.`, '§14 ...and what was held')
  eq(checkState({ ...OFF, held: { count: 1, byCode: { RATECON_MISSING: 1 } } }).text, `The billing email check is switched off on the server, so invoices to ${CHR} aren't made or sent: each load stops at Needs attention for a person to draft by hand. 1 ${CHR} load was held in the last 7 days.`, '§14 ...one load, on a stop ahead of the check')
  const STOP_TOO = `If ${CHR}'s billing address changed, its rate cons now read differently or they're filed under other names, every new load will stop too. See Needs attention on Completed Loads.`
  eq(checkState({ on: true, domain: CHR, days: 7, held: { count: 1, byCode: { RECIPIENT_NOT_KNOWN: 1 } } }).text, `1 ${CHR} load was held in the last 7 days, so its invoice was not sent (1 billing email not used before). ${STOP_TOO}`, '§14 one load held: the line says so plainly')
  eq(checkState({ on: true, domain: CHR, days: 7, held: { count: 3, byCode: { RATECON_NUMBER_MISMATCH: 1, RECIPIENT_NOT_KNOWN: 2 } } }).text, `3 ${CHR} loads were held in the last 7 days, so their invoices were not sent (1 rate con's number doesn't match, 2 billing email not used before). ${STOP_TOO}`, '§14 several held: by reason')
  eq(checkState({ on: true, domain: CHR, days: 7, held: { count: 4, byCode: { NO_BILLING_EMAIL: 1, RATECON_BY_CONTENT: 1, RATECON_MISSING: 1, RATECON_TOTAL_UNREAD: 1, RECIPIENT_DOMAIN_MISMATCH: 0 } } }).text, `4 ${CHR} loads were held in the last 7 days, so their invoices were not sent (1 no billing email, 1 rate con found by content, 1 no rate con, 1 rate con total couldn't be read, 0 billing email on another domain). ${STOP_TOO}`, '§14 every code the server counts has its words')
  eq(checkState({ on: true, domain: CHR, days: 7, held: { count: 1, byCode: { MADE_UP_CODE: 1 } } }).text, `1 ${CHR} load was held in the last 7 days, so its invoice was not sent. ${STOP_TOO}`, '§14 a reason this client has no words for: left out, the count stays')
  ok(/^2 C\.H\. Robinson loads were held in the last 7 days, /.test(checkState({ on: true, days: 7, held: { count: 2, byCode: {} } }).text), '§14 a read with no domain: the line still reads as a sentence')
  for (const bad of ['off', 1, [], { on: 'false' }]) eq(checkState(bad), null, `§14 ${JSON.stringify(bad)}: no line`)
  ok(Array.isArray(rules.KNOWN_ADDRESS_HOLD_CODES) && rules.KNOWN_ADDRESS_HOLD_CODES.length > 0, '§14 the server has a list of what it counts')
  for (const code of rules.KNOWN_ADDRESS_HOLD_CODES || []) ok(Object.hasOwn(S.AUTO_INVOICE_REASONS, code), `§14 ${code}: the server counts it and this client has its words`)

  // The dialog's mode line, from the same read: with the check off it doesn't promise those invoices.
  const modeLine = fnOf('autoModeLine') || (() => '(no such function on this tree)')
  const SEND_LINE = 'On: each load delivered with its POD gets its broker invoice, sent automatically where sending is on (below), else as a Gmail draft a person checks and sends.'
  const DRAFT_LINE = 'On: each load delivered with its POD gets its broker invoice as a Gmail draft. Nothing is sent: a person checks each draft and sends it.'
  const SHADOW_LINE = 'Shadow: it records what it would draft, and drafts nothing.'
  const EXCEPT = ` Except invoices to ${CHR}: with the billing email check off, each load stops at Needs attention for a person to draft by hand.`
  eq(modeLine('on', { sending: true }), SEND_LINE, '§14 the mode line, sending on: as before')
  eq(modeLine('on', { sending: false }), DRAFT_LINE, '§14 the mode line, sending off: as before')
  eq(modeLine('shadow', {}), SHADOW_LINE, '§14 the mode line, shadow: as before')
  eq(modeLine('on', { sending: true, check: { on: true, domain: CHR, days: 7, held: { count: 2, byCode: {} } } }), SEND_LINE, '§14 the mode line, loads held with the check on: as before, the check has its own line')
  eq(modeLine('on', { sending: true, check: OFF }), `${SEND_LINE}${EXCEPT}`, '§14 the mode line, the check off, sending on: it says those invoices stop')
  eq(modeLine('on', { sending: false, check: OFF }), `${DRAFT_LINE}${EXCEPT}`, '§14 the mode line, the check off, sending off: the same')
  eq(modeLine('shadow', { check: OFF }), SHADOW_LINE, '§14 the mode line, shadow: the check holds nothing there')
  for (const bad of ['off', 1, [], { on: 'false' }, { on: 'false', domain: CHR }, { domain: CHR }, { on: false }, { on: false, domain: 7 }]) eq(modeLine('on', { sending: true, check: bad }), SEND_LINE, `§14 the mode line, ${JSON.stringify(bad)} from the server: no exception read into it`)

  // The dialog: its line, and the read it comes from.
  const DIALOG = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'dashboard', 'CompletedLoadsTab.vue'), 'utf8')
  ok(/<p v-if="recipientCheckView" class="auto-settings-problem" role="alert">\{\{ recipientCheckView\.text \}\}<\/p>/.test(DIALOG), '§14 the dialog shows the line, as a problem a person reads first')
  ok(DIALOG.indexOf('recipientCheckView.text') < DIALOG.indexOf('<template v-if="autoSendView">'), '§14 ...outside the sending section, so it shows with sending off too')
  ok(/const recipientCheckView = computed\(\(\) => recipientCheckState\(autoRecipientCheck\.value\)\)/.test(DIALOG), '§14 ...from the check as this opening read it')
  ok(/const autoSendView = computed\(\(\) => autoSendState\(autoSend\.value, autoRecipientCheck\.value\)\)/.test(DIALOG), '§14 the sending sentence is told the check too')
  ok(/const autoModeText = computed\(\(\) => autoModeLine\(autoMode\.value, \{ sending: Boolean\(autoSendView\.value\), check: autoRecipientCheck\.value \}\)\)/.test(DIALOG), '§14 the mode line is told it too')
  ok(/autoRecipientCheck\.value = s && s\.recipientCheck && typeof s\.recipientCheck === 'object' \? s\.recipientCheck : null/.test(DIALOG), '§14 the read sets it')
  ok(/autoSend\.value = null; autoRecipientCheck\.value = null/.test(DIALOG), '§14 each opening starts with none, so an old read can\'t show')
}

// ------------------------------------------------------------------ §15
section('§15 no alert address on the server (item 118): the settings dialog says alerts are off')
{
  const alertState = fnOf('autoAlertState') || (() => ({ text: '(no such function on this tree)' }))
  const off = alertState({ on: false })
  eq(off && off.text, 'Alerts are off: with no address set on the server, nothing is mailed when a load is held or sending stops.',
    '§15 FAILS ON THE OLD CODE: the read says alerts are off: one line, in the plan\'s words')
  for (const v of [null, undefined, { on: true }, 'off', [], { on: 'false' }, {}]) eq(fnOf('autoAlertState') ? alertState(v) : 'none', fnOf('autoAlertState') ? null : 'none', `§15 ${JSON.stringify(v)}: no line`)
  const DIALOG = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'dashboard', 'CompletedLoadsTab.vue'), 'utf8')
  ok(/<p v-if="alertsView" class="auto-settings-problem" role="alert">\{\{ alertsView\.text \}\}<\/p>/.test(DIALOG), '§15 FAILS ON THE OLD CODE: the dialog shows it, as a problem a person reads first')
  ok(DIALOG.indexOf('alertsView.text') > 0 && DIALOG.indexOf('alertsView.text') < DIALOG.indexOf('<template v-if="autoSendView">'), '§15 FAILS ON THE OLD CODE: ...outside the sending section, so it shows whatever sending says')
  ok(/const alertsView = computed\(\(\) => autoAlertState\(autoAlerts\.value\)\)/.test(DIALOG), '§15 FAILS ON THE OLD CODE: ...from this opening\'s read')
  ok(/autoAlerts\.value = s && s\.alerts && typeof s\.alerts === 'object' \? s\.alerts : null/.test(DIALOG), '§15 FAILS ON THE OLD CODE: the read sets it')
  ok(/autoRecipientCheck\.value = null; autoAlerts\.value = null/.test(DIALOG), '§15 FAILS ON THE OLD CODE: each opening starts with none, so an old read can\'t show')
  // Display only: nothing in the dialog sends, saves or stops on it.
  const openSrc = liftFn(DIALOG, 'openAutoSettings', { async: true }) || ''
  const saveSrc = liftFn(DIALOG, 'saveAutoSettings', { async: true }) || ''
  ok(!/alert/i.test(saveSrc) && (openSrc.match(/autoAlerts/g) || []).length === 2, '§15 display only: the read sets it, nothing else touches it')
}

console.log(`\n${'='.repeat(64)}`)
if (failures.length) {
  console.log(`FAILURES (${failures.length}):`)
  failures.forEach((f) => console.log(`  ✗ ${f}`))
  console.log(`\n${pass} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`✓ ${pass} assertions passed`)
