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
//      read that failed; the page's check and the preview's approve(), lifted
//      from their files and run over stand-ins; off or shadow, nothing changes
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
    eq([a.posts.length, a.confirms], [1, []], '§6 the check asked and was told yes: one post, and the already-drafted question isn\'t asked twice')
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
      'autoOptOutText', 'api', 'AUTO_INVOICE_REASONS', 'autoSettingsSaving', 'canSaveAutoSettings', 'domainList', 'toast', 'dashboard', 'autoSend']
    const dialog = (getAnswer) => {
      const st = {
        auth: { isSuperAdmin: true }, autoSettingsLoading: { value: false }, autoSettingsOpen: { value: false }, autoSettingsError: { value: '' },
        autoSettingsProblem: { value: '' }, autoSettingsRead: { value: true }, autoConfirmedText: { value: 'stale-confirmed.test' },
        autoOptOutText: { value: 'stale-optout.test' }, puts: [], autoSend: { value: { domains: ['stale.test'], stopped: null } },
      }
      const api = {
        get: async () => { const v = getAnswer(); if (v instanceof Error) throw v; return v },
        put: async (u, body) => { st.puts.push([u, body]); return body },
      }
      const deps = [st.auth, st.autoSettingsLoading, st.autoSettingsOpen, st.autoSettingsError, st.autoSettingsProblem, st.autoSettingsRead, st.autoConfirmedText,
        st.autoOptOutText, api, S.AUTO_INVOICE_REASONS, { value: false }, can || (() => true), (t) => String(t || '').split(/[\s,;]+/).filter(Boolean), () => {}, { refresh: async () => {} }, st.autoSend]
      const open = new Function(...NAMES, `${openSrc}\nreturn openAutoSettings;`)(...deps)
      const save = new Function(...NAMES, `${saveSrc}\nreturn saveAutoSettings;`)(...deps)
      return { st, open, save }
    }
    // The review's case: the read times out; the text from an earlier opening must not be saved.
    const bad = dialog(() => Object.assign(new Error('Request timed out'), { status: 0 }))
    await bad.open()
    eq([bad.st.autoConfirmedText.value, bad.st.autoOptOutText.value, bad.st.autoSettingsRead.value, Boolean(bad.st.autoSettingsError.value)], ['', '', false, true],
      '§7 a failed read: both lists start empty (nothing from an earlier opening), not read, the error shown')
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
    NOT_COMPLETED: 'The load is no longer marked Delivered, so no invoice is made. If it was delivered, set it back, then draft it by hand.',
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
  eq(R.SETTINGS_UNREADABLE && R.SETTINGS_UNREADABLE.short, 'settings unreadable', '§11 FAILS ON THE OLD CODE: SETTINGS_UNREADABLE names the settings, not one list')
  ok(!/within a few minutes/.test(R.WAITING_POD.text), '§11 WAITING_POD promises no time: nothing but the sweep could keep one')
  eq(rules.LOGIN_PAUSE_MAX_MS, 6 * 60 * 60 * 1000, '§11 MAILBOX_PAUSED\'s "up to 6 hours" is the job\'s longest pause')
}

// ------------------------------------------------------------------ §12
section('§12 the driver\'s line above Delivered')
{
  const STEPPER = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'driver', 'StatusStepper.vue'), 'utf8')
  const LINE = 'Upload every POD page before you tap Delivered. The invoice is made soon after you tap. If anything changes later, tell dispatch or a Super Admin right away.'
  eq(STEPPER.split(LINE).length - 1, 1, '§12 FAILS ON THE OLD CODE: the line is there once, word for word')
  const actions = (/<template v-if="!readOnly">[\s\S]*?<div v-if="requiresUpload"/.exec(STEPPER) || [''])[0]
  ok(actions.includes(LINE), '§12 FAILS ON THE OLD CODE: inside the driver-only block, never on the public tracker, and above the upload hint')
  const tag = (new RegExp(`<div ([^>]*)>\\s*${LINE.slice(0, 40)}`).exec(STEPPER) || ['', ''])[1]
  ok(/v-if="nextStep && nextStep\.value === 'Delivered'"/.test(tag), '§12 FAILS ON THE OLD CODE: only while the next step is Delivered')
  ok(!/v-else/.test(tag), '§12 ...outside the hint chain, so it shows with the upload hint too')
  ok(/<div v-if="requiresUpload"/.test(STEPPER) && /<div v-else-if="blocked"/.test(STEPPER) && /<div v-else-if="gpsLine"/.test(STEPPER), '§12 the hint chain below it is unchanged')
}

console.log(`\n${'='.repeat(64)}`)
if (failures.length) {
  console.log(`FAILURES (${failures.length}):`)
  failures.forEach((f) => console.log(`  ✗ ${f}`))
  console.log(`\n${pass} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`✓ ${pass} assertions passed`)
