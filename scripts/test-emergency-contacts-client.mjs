#!/usr/bin/env node
// Emergency contacts on the driver's onboarding lock screen (plan PR 2, §6.1): the
// logic in client/src/lib/emergencyContacts.js, and how DriverView.vue,
// EmergencyContactsForm.vue and the driver store use it.
//
// The server is the gate (scripts/test-emergency-contacts-routes.js): the routes
// answer only the driver himself, and the onboarding step waits for two contacts.
// The screen only shows what it is sent:
//   §1 the item exists only when the driver payload carries the counts; the store
//      keeps those three numbers and nothing else
//   §2 the progress counts the item only while the step itself is open
//      (documents_pending); a driver past it sees the item, never a lower
//      percentage; the step's tick follows the server's rule
//   §3 every refusal code has plain words; a 429 and a lost request too
//   §4 the form's rows and the body it sends: a new row left blank is dropped, a
//      refusal's index finds its row
//   §5 DriverView.vue: the item and its button (Driver only), the progress, the
//      "Documents Received!" card on the server's status, the form mounted for a
//      Driver only
//   §6 EmergencyContactsForm.vue: the list in the component only (never the store
//      or the browser's storage), read on every open, checked before the PUT, the
//      field limits the server's, the phone keypad, the add and remove bounds
//   §7 the store: the counts and no list
//
// No DOM, no server, no build.
//   node scripts/test-emergency-contacts-client.mjs      # exits 1 on any failure
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB = path.join(ROOT, 'client', 'src', 'lib', 'emergencyContacts.js')
const VIEW = path.join(ROOT, 'client', 'src', 'views', 'DriverView.vue')
const FORM = path.join(ROOT, 'client', 'src', 'components', 'driver', 'EmergencyContactsForm.vue')
const STORE = path.join(ROOT, 'client', 'src', 'stores', 'driver.js')
const server = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'emergency-contacts.js'))

let pass = 0
let fail = 0
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok    ${name}`); return }
  fail++
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`)
}
function done() {
  console.log(`\ntest-emergency-contacts-client: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')

if (!fs.existsSync(LIB) || !fs.existsSync(FORM)) {
  eq('client/src/lib/emergencyContacts.js exists', fs.existsSync(LIB), true)
  eq('client/src/components/driver/EmergencyContactsForm.vue exists', fs.existsSync(FORM), true)
  eq('DriverView.vue names EmergencyContactsForm', read(VIEW).includes('EmergencyContactsForm'), true)
  eq('the driver store keeps emergencyContacts', read(STORE).includes('emergencyContacts'), true)
  done()
}
const v = await import(pathToFileURL(LIB).href)
const view = read(VIEW)
const form = read(FORM)
const store = read(STORE)
// A .vue file's <script setup> and <template>, apart.
const scriptOf = (src) => (src.match(/<script setup>([\s\S]*?)<\/script>/) || [])[1] || ''
const templateOf = (src) => src.slice(0, Math.max(0, src.indexOf('<script')))

// ── §1 the counts ────────────────────────────────────────────────────────────
console.log('§1 the item exists only with the payload\'s counts')
eq('§1 no key (the flag off, or a Super Admin): no counts', [v.contactCounts(undefined), v.contactCounts(null)], [null, null])
eq('§1 a malformed key: no counts', [v.contactCounts([]), v.contactCounts('2'), v.contactCounts(7)], [null, null, null])
eq('§1 the three counts, and only them, are kept',
  v.contactCounts({ required: 2, maximum: 5, onFile: 1, contacts: [{ name: 'Quinn Example', phone: '+12025550143' }], extra: 'x' }),
  { required: 2, maximum: 5, onFile: 1 })
eq('§1 counts that are not whole numbers fall back to the rules', v.contactCounts({ required: '2', maximum: -1, onFile: 1.5 }),
  { required: v.MIN_CONTACTS, maximum: v.MAX_CONTACTS, onFile: 0 })
eq('§1 the item: none without counts; done at the required number', [v.contactsItem(null), v.contactsItem({ required: 2, maximum: 5, onFile: 1 }), v.contactsItem({ required: 2, maximum: 5, onFile: 2 })],
  [null, { required: 2, onFile: 1, done: false, label: '1 of 2 added', action: 'Edit' }, { required: 2, onFile: 2, done: true, label: '2 added', action: 'Edit' }])
eq('§1 nothing on file yet: "0 of 2 added", Add', v.contactsItem({ required: 2, maximum: 5, onFile: 0 }), { required: 2, onFile: 0, done: false, label: '0 of 2 added', action: 'Add' })

// ── §2 the progress ──────────────────────────────────────────────────────────
console.log('\n§2 the progress and the step\'s tick')
const counts = (onFile) => ({ required: 2, maximum: 5, onFile })
const step = (status, signed, onFile, total = 5) => {
  const s = v.signingStepView({ status, signed, total, counts: onFile === null ? null : counts(onFile) })
  return [s.counted, s.done, s.of, s.pct, s.stepDone]
}
eq('§2 no counts (the flag off): the documents alone, as before', [step('documents_pending', 3, null), step('documents_pending', 5, null)], [[false, 3, 5, 60, false], [false, 5, 5, 100, true]])
eq('§2 at the step, five signed, no contacts: 5 of 6, 83%, not done', step('documents_pending', 5, 0), [true, 5, 6, 83, false])
eq('§2 at the step, five signed, one contact: still 5 of 6', step('documents_pending', 5, 1), [true, 5, 6, 83, false])
eq('§2 at the step, five signed, two contacts: 6 of 6, done', step('documents_pending', 5, 2), [true, 6, 6, 100, true])
eq('§2 at the step, three signed, two contacts: 4 of 6, not done', step('documents_pending', 3, 2), [true, 4, 6, 67, false])
eq('§2 past the step (documents_signed) with no contacts: the item is not counted, 100%, done', step('documents_signed', 5, 0), [false, 5, 5, 100, true])
eq('§2 ...and the item is still shown, not done', v.signingStepView({ status: 'documents_signed', signed: 5, total: 5, counts: counts(0) }).item, { required: 2, onFile: 0, done: false, label: '0 of 2 added', action: 'Add' })
eq('§2 no documents listed: the step is never done', step('documents_pending', 0, 2, 0), [true, 1, 1, 100, false])

// ── §3 the words ─────────────────────────────────────────────────────────────
console.log('\n§3 every refusal in plain words')
const apiError = (status, code = '', data = {}) => Object.assign(new Error('x'), { status, code, data })
for (const code of Object.keys(server.REFUSAL_TEXT)) {
  eq(`§3 ${code} has words of its own`, typeof v.MESSAGES[code] === 'string' && v.MESSAGES[code].length > 10, true)
}
eq('§3 the plan\'s words', [v.MESSAGES.EMERGENCY_CONTACTS_MIN, v.MESSAGES.EMERGENCY_CONTACTS_MAX, v.MESSAGES.CONTACT_NAME_INVALID, v.MESSAGES.CONTACT_RELATIONSHIP_INVALID,
  v.MESSAGES.CONTACT_PHONE_INVALID, v.MESSAGES.CONTACT_PHONE_DUPLICATE, v.MESSAGES.FEATURE_OFF], [
  'Add at least two contacts.', 'You can add up to five contacts.', 'Enter the contact\'s name.', 'Say how this person is related to you.',
  'Enter a 10-digit US or Canadian number, or an international number starting with +.', 'Each contact needs a different phone number.',
  'Emergency contacts aren\'t available right now.'])
eq('§3 a list changed elsewhere (409): open it again', v.refusalText(apiError(409, 'CONTACT_NOT_FOUND')), 'This list changed somewhere else. Open it again, then save your changes.')
eq('§3 the route switched off (404 FEATURE_OFF)', v.refusalText(apiError(404, 'FEATURE_OFF')), v.MESSAGES.FEATURE_OFF)
eq('§3 the server\'s own 422 by its code', v.refusalText(apiError(422, 'EMERGENCY_CONTACTS_MIN')), 'Add at least two contacts.')
eq('§3 the write limit (429, no code)', v.refusalText(apiError(429)), v.MESSAGES.TOO_MANY)
eq('§3 no answer (a timeout, or no connection)', [v.refusalText(apiError(0, 'TIMEOUT')), v.refusalText(new TypeError('Failed to fetch'))], [v.MESSAGES.OFFLINE, v.MESSAGES.OFFLINE])
eq('§3 the session ended (401)', v.refusalText(apiError(401)), v.MESSAGES.SESSION_ENDED)
eq('§3 anything else: the read or the save failed', [v.refusalText(apiError(500, 'READ_FAILED'), 'READ_FAILED'), v.refusalText(apiError(500), 'READ_FAILED'), v.refusalText(apiError(403, 'CSRF_HEADER_REQUIRED'))],
  [v.MESSAGES.READ_FAILED, v.MESSAGES.READ_FAILED, v.MESSAGES.SAVE_FAILED])
eq('§3 a field\'s refusal names its field', ['CONTACT_NAME_INVALID', 'CONTACT_RELATIONSHIP_INVALID', 'CONTACT_PHONE_INVALID', 'CONTACT_PHONE_DUPLICATE', 'EMERGENCY_CONTACTS_MIN', 'NOPE'].map(v.fieldOfRefusal),
  ['name', 'relationship', 'phone', 'phone', null, null])
eq('§3 the words never tell anyone to reopen anything', Object.values(v.MESSAGES).filter((t) => /reopen/i.test(t)), [])

// ── §4 the rows and the body ─────────────────────────────────────────────────
console.log('\n§4 the rows and the body sent')
const stored = [
  { id: 31, position: 1, name: 'Quinn Example', relationship: 'Spouse', phone: '+12025550143', phoneDisplay: '(202) 555-0143' },
  { id: 32, position: 2, name: 'Jordan Placeholder', relationship: 'Friend', phone: '+442079460958', phoneDisplay: '+442079460958' },
]
eq('§4 nothing stored: two blank rows', v.draftRows([]), [v.blankRow(), v.blankRow()])
eq('§4 a stored list: each row keeps its id, the number as the server shows it', v.draftRows(stored), [
  { id: 31, name: 'Quinn Example', relationship: 'Spouse', phone: '(202) 555-0143' },
  { id: 32, name: 'Jordan Placeholder', relationship: 'Friend', phone: '+442079460958' }])
eq('§4 one stored: one more blank row', v.draftRows(stored.slice(0, 1)).length, 2)
eq('§4 never more rows than the maximum', v.draftRows(Array.from({ length: 7 }, (_, i) => ({ ...stored[0], id: 40 + i }))).length, v.MAX_CONTACTS)
const rows = [
  { id: null, name: 'Harper Example', relationship: 'Parent', phone: '1-312-555-0178' },
  { id: null, name: ' ', relationship: '', phone: '' },
  { id: 32, name: '', relationship: '', phone: '' },
  { id: null, name: 'Riley Fixture', relationship: 'Relative', phone: '512-555-0149' },
]
const sent = v.listToSend(rows)
eq('§4 a new row left blank is dropped; a stored one emptied is still sent (its id kept)', sent.body.contacts, [
  { name: 'Harper Example', relationship: 'Parent', phone: '1-312-555-0178' },
  { id: 32, name: '', relationship: '', phone: '' },
  { name: 'Riley Fixture', relationship: 'Relative', phone: '512-555-0149' }])
eq('§4 ...each entry knows its row, so a refusal\'s index lands on it', sent.rowOf, [0, 2, 3])
eq('§4 ...and the check sends the emptied one back as row 3\'s name', (() => { const r = v.validateContactList(sent.body); return [r.code, sent.rowOf[r.index]] })(), ['CONTACT_NAME_INVALID', 2])
eq('§4 one contact and a blank row: the minimum, before anything is sent', v.validateContactList(v.listToSend([rows[0], rows[1]]).body).code, 'EMERGENCY_CONTACTS_MIN')
eq('§4 the read and the save go to the driver\'s own route', v.CONTACTS_URL, '/api/driver/me/emergency-contacts')

// ── §5 DriverView.vue ────────────────────────────────────────────────────────
console.log('\n§5 DriverView.vue')
const vt = templateOf(view)
const vs = scriptOf(view)
eq('§5 the item is rendered only when the payload carries the counts', /<div v-if="signingStep\.item" class="ob-doc-item ob-contacts" data-testid="ob-contacts">/.test(vt), true)
eq('§5 ...inside step 1\'s list, after the documents', /<div v-for="doc in onboardingDocs"[\s\S]*?<\/div>\s*<\/div>\s*<!--[^>]*-->\s*<div v-if="signingStep\.item"/.test(vt), true)
eq('§5 its counts come from the store\'s payload, and the view never fetches the list',
  [vs.includes('counts: driverStore.emergencyContacts,'), /emergency-contacts/.test(vs)], [true, false])
eq('§5 the button only for a Driver with the counts', [
  vs.includes("const canEditContacts = computed(() => auth.user?.role === 'Driver' && !!driverStore.emergencyContacts)"),
  /<button v-if="canEditContacts" type="button" class="ob-doc-action ob-contacts-btn" data-testid="ob-contacts-btn" @click="showContactsForm = true">\{\{ signingStep\.item\.action \}\}<\/button>/.test(vt),
], [true, true])
eq('§5 the form is mounted for a Driver only', /<EmergencyContactsForm v-if="canEditContacts" :show="showContactsForm" @close="showContactsForm = false" \/>/.test(vt), true)
eq('§5 the progress label and bar read signingStep.pct', [(vt.match(/signingStep\.pct/g) || []).length, /onboardingPct/.test(view)], [2, false])
eq('§5 step 1 counts the item with the documents, and ticks on the server\'s rule',
  [vt.includes('{{ signingStep.done }}/{{ signingStep.of }} completed'), vt.includes("signingStep.stepDone ? 'ob-done' : 'ob-active'")], [true, true])
eq('§5 "Documents Received!" shows on the server\'s status, not a client count',
  [/<div v-if="stepAccepted" class="card ob-step">\s*<div class="ob-next-steps">/.test(vt), vs.includes("const stepAccepted = computed(() => driverStore.onboarding?.status === 'documents_signed')"), /allDocsSigned/.test(view)],
  [true, true, false])
eq('§5 signingStep is the lib\'s, over the documents and the payload', /const signingStep = computed\(\(\) => signingStepView\(\{\s*status: driverStore\.onboarding\?\.status,\s*signed: signedCount\.value,\s*total: totalDocs\.value,\s*counts: driverStore\.emergencyContacts,\s*\}\)\)/.test(vs), true)

// ── §6 EmergencyContactsForm.vue ─────────────────────────────────────────────
console.log('\n§6 EmergencyContactsForm.vue')
const ft = templateOf(form)
const fs6 = scriptOf(form)
eq('§6 the list lives in the component: rows is a local ref', /^const rows = ref\(\[\]\)$/m.test(fs6), true)
eq('§6 ...never the store: its one store call is loadData()', [(fs6.match(/driverStore\.\w+/g) || [])].map((m) => [...new Set(m)]), [['driverStore.loadData']])
eq('§6 ...never the browser\'s storage', /localStorage|sessionStorage|indexedDB|document\.cookie/.test(form), false)
eq('§6 read on every open, dropped on every close', /watch\(\(\) => props\.show, \(open\) => \{\s*reset\(\)\s*if \(open\) load\(\)\s*\}, \{ immediate: true \}\)/.test(fs6), true)
eq('§6 reads and writes the driver\'s own route only', [fs6.includes('await api.get(CONTACTS_URL)'), fs6.includes('await api.put(CONTACTS_URL, body)'), /drivers-directory/.test(form)], [true, true, false])
eq('§6 the list is checked with the server\'s rules before the PUT', /const check = validateContactList\(body\)\s*if \(!check\.ok\) \{[^}]*\}[\s\S]*await api\.put\(CONTACTS_URL, body\)/.test(fs6), true)
eq('§6 after a save the payload is read again (the status may have moved)', fs6.includes('await driverStore.loadData()'), true)
eq('§6 the field limits are the lib\'s', [
  ft.includes(':maxlength="CONTACT_NAME_MAX"'), ft.includes(':maxlength="RELATIONSHIP_MAX"'), ft.includes(':maxlength="PHONE_RAW_MAX"'),
], [true, true, true])
eq('§6 ...and the lib\'s are the server\'s: 80, 40, 32', [v.CONTACT_NAME_MAX, v.RELATIONSHIP_MAX, v.PHONE_RAW_MAX], [server.CONTACT_NAME_MAX, server.RELATIONSHIP_MAX, server.PHONE_RAW_MAX])
eq('§6 the phone field opens the phone keypad; no field fills itself in',
  [/type="tel"\s+inputmode="tel"/.test(ft), (ft.match(/autocomplete="off"/g) || []).length], [true, 3])
eq('§6 remove only above the minimum, add only below the maximum',
  [ft.includes('v-if="rows.length > MIN_CONTACTS"'), ft.includes('v-if="rows.length < MAX_CONTACTS"')], [true, true])
eq('§6 the relationship suggestions are the lib\'s', ft.includes('v-for="s in RELATIONSHIP_SUGGESTIONS"'), true)
eq('§6 a late answer after a close never lands on the next open', [(fs6.match(/if \(seq !== loadSeq\) return/g) || []).length >= 3, fs6.includes('loadSeq++')], [true, true])

// ── §7 the store ─────────────────────────────────────────────────────────────
console.log('\n§7 the driver store')
eq('§7 emergencyContacts starts null and holds the payload\'s counts only',
  [/\n {4}emergencyContacts: null,\n/.test(store), store.includes('this.emergencyContacts = contactCounts(data.emergencyContacts)'), store.includes("import { contactCounts } from '../lib/emergencyContacts'")],
  [true, true, true])
eq('§7 the store never fetches or keeps the list', /emergency-contacts|contacts:\s*\[/.test(store), false)

done()
