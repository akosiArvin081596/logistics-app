#!/usr/bin/env node
// Request a fresh signature on the screens (ONBOARDING_RESIGN_ENABLED): the logic in
// client/src/lib/resignRequest.js and how the driver app and the Drivers page use it.
//
// The server is the gate (scripts/test-onboarding-resign.js): it decides which
// documents carry a request and who sees what. The screens only show what they are
// sent:
//   §1 the lib: a document is "asked again" only when the payload says so; the row
//      word, the form, the PDF and the card text; the notice's document; the staff
//      state from the server's keys alone; the reason check; the two URLs
//   §2 flag off: documents without the keys behave exactly as before (the row word,
//      the form, the PDF address, no card, no staff control)
//   §3 parity with the server: the notice type, the reason bounds, the live event's
//      name and the preview address are the server's
//   §4 DriverView.vue: the row word, the card only for marked documents, the signing
//      window in the normal app, the notice tap, the live event on and off
//   §5 DocumentSignModal.vue: the form for a requested document, its heading and note,
//      the PDF address through documentUrl()
//   §6 NotificationList.vue: the notice's icon
//   §7 the Drivers page: the control only when the answer carries the keys, posting the
//      trimmed reason to the request URL and nothing to the cancel URL; no role test in
//      the browser
//
// No DOM, no server, no build.
//   node scripts/test-onboarding-resign-client.mjs      # exits 1 on any failure
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB = path.join(ROOT, 'client', 'src', 'lib', 'resignRequest.js')
const VIEW = path.join(ROOT, 'client', 'src', 'views', 'DriverView.vue')
const MODAL = path.join(ROOT, 'client', 'src', 'components', 'driver', 'DocumentSignModal.vue')
const CARD = path.join(ROOT, 'client', 'src', 'components', 'driver', 'ResignRequestCard.vue')
const NOTICES = path.join(ROOT, 'client', 'src', 'components', 'driver', 'NotificationList.vue')
const TABLE = path.join(ROOT, 'client', 'src', 'components', 'drivers-db', 'DriverTable.vue')
const CONTROL = path.join(ROOT, 'client', 'src', 'components', 'drivers-db', 'ResignRequestControl.vue')
const SERVER_LIB = path.join(ROOT, 'lib', 'onboarding-resign.js')

let pass = 0
let fail = 0
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok    ${name}`); return }
  fail++
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`)
}
const ok = (name, cond) => eq(name, !!cond, true)
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

let L = null
try { L = await import(pathToFileURL(LIB).href) } catch { L = null }
let S = null
try { S = createRequire(import.meta.url)(SERVER_LIB) } catch { S = null }
const serverSource = createRequire(import.meta.url)('./lib/server-source.js').serverSource
const SRC = serverSource()

const signed = { doc_key: 'mobile_policy', doc_name: 'LogisX Inc. Mobile Policy', signed: 1, signed_pdf_url: '/uploads/onboarding-signed/mobile_policy-90102-signed.pdf' }
const unsigned = { doc_key: 'equipment_policy', doc_name: 'Contracted Provider Equipment Policy', signed: 0, signed_pdf_url: '' }
const asked = { ...signed, resign_requested: true }
const notAsked = { ...signed, resign_requested: false }

console.log('\n§1 the lib')
if (!L) {
  eq('client/src/lib/resignRequest.js loads', false, true)
} else {
  eq('§1 a document is asked again only when signed and marked true', [asked, notAsked, { ...unsigned, resign_requested: true }, { ...signed, resign_requested: 'true' }, null].map(L.isRequested), [true, false, false, false, false])
  eq('§1 requestedDocs() keeps the marked ones, in order', L.requestedDocs([unsigned, asked, notAsked, { ...asked, doc_key: 'substance_policy' }]).map((d) => d.doc_key), ['mobile_policy', 'substance_policy'])
  eq('§1 requestedDocs() of nothing is empty', [L.requestedDocs(undefined), L.requestedDocs(null)], [[], []])
  eq('§1 the row word: Sign again / View / Sign', [L.docAction(asked), L.docAction(notAsked), L.docAction(unsigned)], ['Sign again', 'View', 'Sign'])
  eq('§1 the form shows for an unsigned or an asked document only', [L.showSignForm(asked), L.showSignForm(notAsked), L.showSignForm(unsigned), L.showSignForm(null)], [true, false, true, false])
  eq('§1 the PDF: the document to sign when asked, the signed copy otherwise',
    [L.documentUrl(asked), L.documentUrl(notAsked), L.documentUrl(unsigned), L.documentUrl(null)],
    ['/api/onboarding/documents/mobile_policy/pdf', signed.signed_pdf_url, '/api/onboarding/documents/equipment_policy/pdf', ''])
  eq('§1 the card names the document and says the earlier copy stays', L.cardText(asked), 'We need a fresh signature on LogisX Inc. Mobile Policy. Your earlier signed copy stays on file.')
  eq('§1 the notice names its document; any other notice names none',
    [L.noticeDocKey({ type: 'resign-requested', metadata: '{"docKey":"mobile_policy"}' }), L.noticeDocKey({ type: 'message', metadata: '{"docKey":"mobile_policy"}' }),
      L.noticeDocKey({ type: 'resign-requested', metadata: 'not json' }), L.noticeDocKey({ type: 'resign-requested', metadata: '{"docKey":7}' }), L.noticeDocKey(null)],
    ['mobile_policy', '', '', '', ''])
  eq('§1 the staff state from the server keys alone',
    [L.staffState({ resign: { reason: 'x' }, resignable: false }), L.staffState({ resign: null, resignable: true }), L.staffState({ resign: null, resignable: false }), L.staffState({}), L.staffState({ resignable: 'true' })],
    ['requested', 'can-ask', 'none', 'none', 'none'])
  eq('§1 the reason: 10 to 300 characters after trimming',
    [L.reasonProblem('Too short'), L.reasonProblem('   Ten chars!   '), L.reasonProblem('x'.repeat(300)), L.reasonProblem('x'.repeat(301)), L.reasonProblem(undefined)].map((p) => p === '' ? 'ok' : 'refused'),
    ['refused', 'ok', 'ok', 'refused', 'refused'])
  eq('§1 the two URLs', [L.requestUrl(90102, 'mobile_policy'), L.cancelUrl(90102, 'mobile_policy')],
    ['/api/admin/onboarding/90102/documents/mobile_policy/request-signature', '/api/admin/onboarding/90102/documents/mobile_policy/cancel-signature-request'])
  eq('§1 the URLs encode what they are handed', L.requestUrl('9/1', 'a b'), '/api/admin/onboarding/9%2F1/documents/a%20b/request-signature')
}

console.log('\n§2 flag off: documents without the keys')
if (L) {
  const before = (doc) => (doc.signed ? 'View' : 'Sign')
  const oldUrl = (doc) => (doc.signed && doc.signed_pdf_url ? doc.signed_pdf_url : `/api/onboarding/documents/${doc.doc_key}/pdf`)
  for (const doc of [signed, unsigned, { ...signed, signed_pdf_url: '' }]) {
    eq(`§2 ${doc.doc_key} (signed ${doc.signed}, url ${doc.signed_pdf_url ? 'set' : 'blank'}): the row word, the form and the PDF as before`,
      [L.docAction(doc), L.showSignForm(doc), L.documentUrl(doc)], [before(doc), !doc.signed, oldUrl(doc)])
  }
  eq('§2 no card and no staff control', [L.requestedDocs([signed, unsigned]).length, L.staffState(signed), L.staffState(unsigned)], [0, 'none', 'none'])
}

console.log('\n§3 parity with the server')
if (L && S) {
  eq('§3 the notice type', L.NOTICE_TYPE, S.NOTICE_TYPE)
  eq('§3 the reason bounds', [L.REASON_MIN, L.REASON_MAX], [S.REASON_MIN, S.REASON_MAX])
  ok('§3 the live event is the one server.js emits', SRC.includes(`.emit("${L.LIVE_EVENT}", `))
  ok('§3 the preview address is the route the server registers', SRC.includes('app.get("/api/onboarding/documents/:docKey/pdf", '))
} else {
  eq('§3 both libs load', [!!L, !!S], [true, true])
}

console.log('\n§4 DriverView.vue')
const vt = read(VIEW)
ok('§4 the onboarding row word comes from docAction(doc)', vt.includes('<div class="ob-doc-action">{{ docAction(doc) }}</div>'))
ok('§4 the card renders only for marked documents and opens the signing window',
  vt.includes('<ResignRequestCard v-if="resignDocs.length" :docs="resignDocs" @sign="openOnboardingDoc" />'))
ok('§4 resignDocs is requestedDocs() of the payload', vt.includes('const resignDocs = computed(() => requestedDocs(driverStore.onboarding?.documents))'))
const normal = vt.slice(vt.indexOf('<!-- NORMAL DRIVER UI'))
ok('§4 the normal app mounts the signing window', /<DocumentSignModal\s+:show="showSignModal"\s+:doc="selectedDoc"/.test(normal))
ok('§4 the notice tap opens a still-asked document, else the Kit',
  vt.includes('} else if (notif.type === NOTICE_TYPE) {') && vt.includes('const doc = resignDocs.value.find((d) => d.doc_key === noticeDocKey(notif))')
  && vt.includes("if (doc) openOnboardingDoc(doc)\n      else currentTab.value = 'kit'"))
ok('§4 the live event refetches (no reason in it) and is removed on unmount',
  vt.includes('socket.on(LIVE_EVENT, onResignRequested)') && vt.includes('socket.off(LIVE_EVENT, onResignRequested)') && /function onResignRequested\(\) \{[\s\S]*?scheduleDriverRefetch\(\)/.test(vt))
const card = read(CARD)
ok('§4 the card shows cardText() and a Sign again button per document', card.includes('{{ cardText(doc) }}') && card.includes("@click=\"emit('sign', doc)\">Sign again</button>"))

console.log('\n§5 DocumentSignModal.vue')
const mt = read(MODAL)
ok('§5 the form shows through showSignForm(doc)', mt.includes('<div v-if="showSignForm(doc)" class="sign-content">'))
ok('§5 the signed panel is unchanged for everything else', mt.includes('<div v-else-if="doc?.signed" class="sign-done">'))
ok('§5 the heading and the note for a requested document', mt.includes("{{ isResign ? 'Sign Again' : 'Sign Document' }}") && mt.includes('<p v-if="isResign" class="sign-again-note">{{ SIGN_AGAIN_NOTE }}</p>'))
ok('§5 the PDF address through documentUrl()', /const pdfUrl = computed\(\(\) => \{\n {2}if \(state\.value\.pdfUrlOverride\) return state\.value\.pdfUrlOverride\n {2}return documentUrl\(props\.doc\)\n\}\)/.test(mt))
ok('§5 the consent stays transmitted as before', mt.includes('buildConsent(s.agreed)'))

console.log('\n§6 NotificationList.vue')
ok("§6 the notice's icon", read(NOTICES).includes("if (type === 'resign-requested') return '&#9997;'"))

console.log('\n§7 the Drivers page')
const tt = read(TABLE)
ok('§7 the control only when the answer carries the keys',
  /<ResignRequestControl\s+v-if="docsData\.userId && 'resignable' in doc"\s+:doc="doc"\s+:user-id="docsData\.userId"\s+@changed="reloadDocs"/.test(tt))
ok('§7 userId comes from the answer only', tt.includes('docsData.userId = res.userId || null'))
const ct = read(CONTROL)
ok('§7 the request posts the trimmed reason to requestUrl()', ct.includes('await api.post(requestUrl(props.userId, props.doc.doc_key), { reason: reason.value.trim() })'))
ok('§7 the withdrawal posts nothing to cancelUrl()', ct.includes('await api.post(cancelUrl(props.userId, props.doc.doc_key), {})'))
ok('§7 the state comes from staffState()', ct.includes('const state = computed(() => staffState(props.doc))'))
// Comments are dropped until none is left, so a comment inside a comment can't hide a role test.
const stripComments = (s) => {
  let prev
  do { prev = s; s = s.replace(/<!--[\s\S]*?-->/g, '') } while (s !== prev)
  return s.replace(/\/\/.*$/gm, '')
}
ok('§7 no role is tested in the browser (the server sends the keys to a Super Admin only)',
  ct !== '' && !/useAuthStore|\bauth\.|\.role\b/.test(stripComments(ct)))
ok('§7 the form says the original stays and the driver is told in the app only', ct.includes('The signed original stays on file as history. The driver is told in the app only: no email or text.'))

console.log(`\ntest-onboarding-resign-client: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
