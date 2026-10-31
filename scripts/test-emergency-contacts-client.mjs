#!/usr/bin/env node
// Emergency contacts on the driver's phone and on the office screens: the logic in
// client/src/lib/emergencyContacts.js, and how DriverView.vue, EmergencyContactsForm.vue,
// EmergencyContactsPrompt.vue, DriverEmergencyContactsCard.vue, EmergencyContactsPanel.vue,
// DriverTable.vue, FleetTab.vue and the driver store use it.
//
// The server is the gate (scripts/test-emergency-contacts-routes.js): the driver's routes
// answer only the driver himself, the staff routes only Super Admin and Dispatcher, and
// every route answers 404 FEATURE_OFF while EMERGENCY_CONTACTS_ENABLED is off. The
// screens only show what they are sent:
//   §1 the item exists only when the driver payload carries the counts; the store keeps
//      those three numbers and nothing else
//   §2 the progress counts the item while the step is open (documents_pending) and once
//      it is done at any status, so the count never drops on completion (6 of 6); a
//      driver past the step without contacts never sees a lower percentage
//   §3 every refusal code has plain words; a 429 and a lost request too
//   §4 the form's rows and the body it sends: a new row left blank is dropped, a
//      refusal's index finds its row
//   §5 DriverView.vue's lock screen: the item (the whole row opens the form for a
//      Driver, its button 44 px high), the progress, "Documents Received!" on the
//      server's status, the form mounted for a Driver only
//   §6 EmergencyContactsForm.vue: the list in the component only, read on every open,
//      checked before the PUT, the field limits the server's (counted as sent), the
//      phone keypad, the add and remove bounds, the suggestions wrap
//   §7 the store: the counts and no list
//   §8 the step counts the five documents the server counts (ONBOARDING_DOC_KEYS is
//      server.js's ONBOARDING_DOCS): a signed document under another key never counts
//   §9 the sign-in prompt: a Driver with fewer than two on file, past onboarding, after
//      the first load, not yet answered this app start, no other window up (the load
//      page holds Drive Mode), the truck not moving; "Remind me later" and "Add now"
//      write no web storage, and the answer lives in the view (back at the next start)
//  §10 the Kit card: only with the counts and for a Driver; the list read from the
//      driver's own route into the card alone; tel: links from the stored number only
//  §11 the office panel: the staff routes only, hidden while the feature is off, the
//      linked:false words, and mounted in the Drivers page detail and the Fleet dialog
//  §12 a save whose answer was lost: the next Save reads the list and takes back the
//      stored ids, so it changes nothing it already made
//  §13 the field limits counted as the server counts them (UTF-16 units as sent)
//  §14 mutants: copies of the lib and the screens with one rule changed must each be
//      caught by the sections above
//
// No DOM, no server, no build.
//   node scripts/test-emergency-contacts-client.mjs      # exits 1 on any failure
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const LIB = path.join(ROOT, 'client', 'src', 'lib', 'emergencyContacts.js')
const FILES = {
  view: path.join(ROOT, 'client', 'src', 'views', 'DriverView.vue'),
  form: path.join(ROOT, 'client', 'src', 'components', 'driver', 'EmergencyContactsForm.vue'),
  store: path.join(ROOT, 'client', 'src', 'stores', 'driver.js'),
  prompt: path.join(ROOT, 'client', 'src', 'components', 'driver', 'EmergencyContactsPrompt.vue'),
  card: path.join(ROOT, 'client', 'src', 'components', 'driver', 'DriverEmergencyContactsCard.vue'),
  panel: path.join(ROOT, 'client', 'src', 'components', 'drivers-db', 'EmergencyContactsPanel.vue'),
  table: path.join(ROOT, 'client', 'src', 'components', 'drivers-db', 'DriverTable.vue'),
  fleet: path.join(ROOT, 'client', 'src', 'components', 'dashboard', 'FleetTab.vue'),
}
const server = require(path.join(ROOT, 'lib', 'emergency-contacts.js'))
const { serverSource } = require(path.join(ROOT, 'scripts', 'lib', 'server-source.js'))

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const S0 = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, read(p)]))
const LIB_SRC = read(LIB)
// A .vue file's <script setup>, <template> and <style>, apart.
const scriptOf = (src) => (src.match(/<script setup>([\s\S]*?)<\/script>/) || [])[1] || ''
const templateOf = (src) => src.slice(0, Math.max(0, src.indexOf('<script')))
const styleOf = (src) => (src.match(/<style scoped>([\s\S]*?)<\/style>/) || [])[1] || ''
const storageRe = /localStorage|sessionStorage|indexedDB|document\.cookie/

// ── reporting ────────────────────────────────────────────────────────────────
// A section reports through a checker: the main run prints every result; a mutant
// run only counts what failed.
let pass = 0
let fail = 0
function checker(print) {
  const c = { failed: [] }
  c.eq = (name, actual, expected) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) { if (print) { pass++; console.log(`  ok    ${name}`) } return }
    c.failed.push(name)
    if (print) { fail++; console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`) }
  }
  return c
}
const MAIN = checker(true)
// Runs a section so a throw (a missing export on the old code) is that section's
// failure, never a crash.
function section(c, label, fn) {
  try { fn() } catch (err) { c.eq(`${label} ran`, `threw: ${err && err.message}`, 'no throw') }
}
const fnOf = (L, name) => {
  if (typeof L[name] !== 'function') throw new Error(`the lib has no ${name}()`)
  return L[name]
}

// ── §1 the counts ────────────────────────────────────────────────────────────
function countsSection(c, L) {
  c.eq('§1 no key (the flag off, or a Super Admin): no counts', [L.contactCounts(undefined), L.contactCounts(null)], [null, null])
  c.eq('§1 a malformed key: no counts', [L.contactCounts([]), L.contactCounts('2'), L.contactCounts(7)], [null, null, null])
  c.eq('§1 the three counts, and only them, are kept',
    L.contactCounts({ required: 2, maximum: 5, onFile: 1, contacts: [{ name: 'Quinn Example', phone: '+12025550143' }], extra: 'x' }),
    { required: 2, maximum: 5, onFile: 1 })
  c.eq('§1 counts that are not whole numbers fall back to the rules', L.contactCounts({ required: '2', maximum: -1, onFile: 1.5 }),
    { required: L.MIN_CONTACTS, maximum: L.MAX_CONTACTS, onFile: 0 })
  c.eq('§1 the item: none without counts; done at the required number', [L.contactsItem(null), L.contactsItem({ required: 2, maximum: 5, onFile: 1 }), L.contactsItem({ required: 2, maximum: 5, onFile: 2 })],
    [null, { required: 2, onFile: 1, done: false, label: '1 of 2 added', action: 'Edit' }, { required: 2, onFile: 2, done: true, label: '2 added', action: 'Edit' }])
  c.eq('§1 nothing on file yet: "0 of 2 added", Add', L.contactsItem({ required: 2, maximum: 5, onFile: 0 }), { required: 2, onFile: 0, done: false, label: '0 of 2 added', action: 'Add' })
}

// ── §2 the progress ──────────────────────────────────────────────────────────
function progressSection(c, L) {
  const counts = (onFile) => ({ required: 2, maximum: 5, onFile })
  const step = (status, signed, onFile, total = 5) => {
    const s = L.signingStepView({ status, signed, total, counts: onFile === null ? null : counts(onFile) })
    return [s.counted, s.done, s.of, s.pct, s.stepDone]
  }
  c.eq('§2 no counts (the flag off): the documents alone, as before', [step('documents_pending', 3, null), step('documents_pending', 5, null)], [[false, 3, 5, 60, false], [false, 5, 5, 100, true]])
  c.eq('§2 at the step, five signed, no contacts: 5 of 6, 83%, not done', step('documents_pending', 5, 0), [true, 5, 6, 83, false])
  c.eq('§2 at the step, five signed, one contact: still 5 of 6', step('documents_pending', 5, 1), [true, 5, 6, 83, false])
  c.eq('§2 at the step, five signed, two contacts: 6 of 6, done', step('documents_pending', 5, 2), [true, 6, 6, 100, true])
  c.eq('§2 at the step, three signed, two contacts: 4 of 6, not done', step('documents_pending', 3, 2), [true, 4, 6, 67, false])
  c.eq('§2 past the step (documents_signed) with no contacts: the item is not counted, 100%, done', step('documents_signed', 5, 0), [false, 5, 5, 100, true])
  c.eq('§2 ...and the item is still shown, not done', L.signingStepView({ status: 'documents_signed', signed: 5, total: 5, counts: counts(0) }).item, { required: 2, onFile: 0, done: false, label: '0 of 2 added', action: 'Add' })
  c.eq('§2 the step just completed by the second contact (now documents_signed): 6 of 6, never 5 of 5 under six ticks', step('documents_signed', 5, 2), [true, 6, 6, 100, true])
  c.eq('§2 a driver past the step with one contact: not counted, still 100%', step('documents_signed', 5, 1), [false, 5, 5, 100, true])
  c.eq('§2 no documents listed: the step is never done', step('documents_pending', 0, 2, 0), [true, 1, 1, 100, false])
}

// ── §3 the words ─────────────────────────────────────────────────────────────
function wordsSection(c, L) {
  const apiError = (status, code = '', data = {}) => Object.assign(new Error('x'), { status, code, data })
  for (const code of Object.keys(server.REFUSAL_TEXT)) {
    c.eq(`§3 ${code} has words of its own`, typeof L.MESSAGES[code] === 'string' && L.MESSAGES[code].length > 10, true)
  }
  c.eq('§3 the plan\'s words', [L.MESSAGES.EMERGENCY_CONTACTS_MIN, L.MESSAGES.EMERGENCY_CONTACTS_MAX, L.MESSAGES.CONTACT_NAME_INVALID, L.MESSAGES.CONTACT_RELATIONSHIP_INVALID,
    L.MESSAGES.CONTACT_PHONE_INVALID, L.MESSAGES.CONTACT_PHONE_DUPLICATE, L.MESSAGES.FEATURE_OFF], [
    'Add at least two contacts.', 'You can add up to five contacts.', 'Enter the contact\'s name.', 'Say how this person is related to you.',
    'Enter a 10-digit US or Canadian number, or an international number starting with +.', 'Each contact needs a different phone number.',
    'Emergency contacts aren\'t available right now.'])
  c.eq('§3 a list changed elsewhere (409): open it again', L.refusalText(apiError(409, 'CONTACT_NOT_FOUND')), 'This list changed somewhere else. Open it again, then save your changes.')
  c.eq('§3 the route switched off (404 FEATURE_OFF)', L.refusalText(apiError(404, 'FEATURE_OFF')), L.MESSAGES.FEATURE_OFF)
  c.eq('§3 the server\'s own 422 by its code', L.refusalText(apiError(422, 'EMERGENCY_CONTACTS_MIN')), 'Add at least two contacts.')
  c.eq('§3 the write limit (429, no code)', L.refusalText(apiError(429)), L.MESSAGES.TOO_MANY)
  c.eq('§3 no answer (a timeout, or no connection)', [L.refusalText(apiError(0, 'TIMEOUT')), L.refusalText(new TypeError('Failed to fetch'))], [L.MESSAGES.OFFLINE, L.MESSAGES.OFFLINE])
  c.eq('§3 the session ended (401)', L.refusalText(apiError(401)), L.MESSAGES.SESSION_ENDED)
  c.eq('§3 anything else: the read or the save failed', [L.refusalText(apiError(500, 'READ_FAILED'), 'READ_FAILED'), L.refusalText(apiError(500), 'READ_FAILED'), L.refusalText(apiError(403, 'CSRF_HEADER_REQUIRED'))],
    [L.MESSAGES.READ_FAILED, L.MESSAGES.READ_FAILED, L.MESSAGES.SAVE_FAILED])
  c.eq('§3 a field\'s refusal names its field', ['CONTACT_NAME_INVALID', 'CONTACT_RELATIONSHIP_INVALID', 'CONTACT_PHONE_INVALID', 'CONTACT_PHONE_DUPLICATE', 'EMERGENCY_CONTACTS_MIN', 'NOPE'].map(L.fieldOfRefusal),
    ['name', 'relationship', 'phone', 'phone', null, null])
  c.eq('§3 the words never tell anyone to reopen anything', Object.values(L.MESSAGES).filter((t) => /reopen/i.test(t)), [])
}

// ── §4 the rows and the body ─────────────────────────────────────────────────
const STORED = [
  { id: 31, position: 1, name: 'Quinn Example', relationship: 'Spouse', phone: '+12025550143', phoneDisplay: '(202) 555-0143' },
  { id: 32, position: 2, name: 'Jordan Placeholder', relationship: 'Friend', phone: '+442079460958', phoneDisplay: '+442079460958' },
]
function rowsSection(c, L) {
  c.eq('§4 nothing stored: two blank rows', L.draftRows([]), [L.blankRow(), L.blankRow()])
  c.eq('§4 a stored list: each row keeps its id, the number as the server shows it', L.draftRows(STORED), [
    { id: 31, name: 'Quinn Example', relationship: 'Spouse', phone: '(202) 555-0143' },
    { id: 32, name: 'Jordan Placeholder', relationship: 'Friend', phone: '+442079460958' }])
  c.eq('§4 one stored: one more blank row', L.draftRows(STORED.slice(0, 1)).length, 2)
  c.eq('§4 never more rows than the maximum', L.draftRows(Array.from({ length: 7 }, (_, i) => ({ ...STORED[0], id: 40 + i }))).length, L.MAX_CONTACTS)
  const rows = [
    { id: null, name: 'Harper Example', relationship: 'Parent', phone: '1-312-555-0178' },
    { id: null, name: ' ', relationship: '', phone: '' },
    { id: 32, name: '', relationship: '', phone: '' },
    { id: null, name: 'Riley Fixture', relationship: 'Relative', phone: '512-555-0149' },
  ]
  const sent = L.listToSend(rows)
  c.eq('§4 a new row left blank is dropped; a stored one emptied is still sent (its id kept)', sent.body.contacts, [
    { name: 'Harper Example', relationship: 'Parent', phone: '1-312-555-0178' },
    { id: 32, name: '', relationship: '', phone: '' },
    { name: 'Riley Fixture', relationship: 'Relative', phone: '512-555-0149' }])
  c.eq('§4 ...each entry knows its row, so a refusal\'s index lands on it', sent.rowOf, [0, 2, 3])
  c.eq('§4 ...and the check sends the emptied one back as row 3\'s name', (() => { const r = L.validateContactList(sent.body); return [r.code, sent.rowOf[r.index]] })(), ['CONTACT_NAME_INVALID', 2])
  c.eq('§4 one contact and a blank row: the minimum, before anything is sent', L.validateContactList(L.listToSend([rows[0], rows[1]]).body).code, 'EMERGENCY_CONTACTS_MIN')
  c.eq('§4 the read and the save go to the driver\'s own route', L.CONTACTS_URL, '/api/driver/me/emergency-contacts')
}

// ── §5 DriverView.vue's lock screen ──────────────────────────────────────────
// The lock screen's part of the template: up to the account-load failure screen.
const lockScreenOf = (view) => templateOf(view).split('<template v-else-if="initialLoadFailed">')[0]
const normalUiOf = (view) => {
  const t = templateOf(view)
  const at = t.indexOf('<!-- NORMAL DRIVER UI')
  const end = t.indexOf('</template><!-- end normal driver UI -->')
  return at < 0 || end < 0 ? '' : t.slice(at, end)
}
function lockScreenSection(c, L, S) {
  const vt = templateOf(S.view)
  const vs = scriptOf(S.view)
  c.eq('§5 the item is rendered only when the payload carries the counts', /<div\s+v-if="signingStep\.item"\s+class="ob-doc-item ob-contacts"[^>]*data-testid="ob-contacts"/.test(vt), true)
  c.eq('§5 ...inside step 1\'s list, after the documents', /<div v-for="doc in onboardingDocs"[\s\S]*?<\/div>\s*<\/div>\s*<!--[^>]*-->\s*<div\s+v-if="signingStep\.item"/.test(vt), true)
  c.eq('§5 its counts come from the store\'s payload, and the view never fetches the list',
    [vs.includes('counts: driverStore.emergencyContacts,'), /emergency-contacts/.test(vs)], [true, false])
  c.eq('§5 the form opens for a Driver with the counts only', [
    vs.includes("const canEditContacts = computed(() => auth.user?.role === 'Driver' && !!driverStore.emergencyContacts)"),
    /function openContactsForm\(\) \{\s*if \(canEditContacts\.value\) showContactsForm\.value = true\s*\}/.test(vs),
  ], [true, true])
  c.eq('§5 the whole contacts row is the tap target, as a document row is; its button too (one open, not two)', [
    /<div\s+v-if="signingStep\.item"[^>]*@click="openContactsForm"[^>]*>/.test(vt),
    /<button v-if="canEditContacts" type="button" class="ob-doc-action ob-contacts-btn" data-testid="ob-contacts-btn" @click\.stop="openContactsForm">\{\{ signingStep\.item\.action \}\}<\/button>/.test(vt),
  ], [true, true])
  c.eq('§5 the button is 44 px high', /\.ob-contacts-btn \{[^}]*min-height: 44px;/.test(styleOf(S.view)), true)
  c.eq('§5 the lock screen\'s form is mounted for a Driver only', /<EmergencyContactsForm v-if="canEditContacts" :show="showContactsForm" @close="showContactsForm = false" \/>/.test(lockScreenOf(S.view)), true)
  c.eq('§5 the progress label and bar read signingStep.pct', [(vt.match(/signingStep\.pct/g) || []).length, /onboardingPct/.test(S.view)], [2, false])
  c.eq('§5 step 1 counts the item with the documents, and ticks on the server\'s rule',
    [vt.includes('{{ signingStep.done }}/{{ signingStep.of }} completed'), vt.includes("signingStep.stepDone ? 'ob-done' : 'ob-active'")], [true, true])
  c.eq('§5 "Documents Received!" shows on the server\'s status, not a client count',
    [/<div v-if="stepAccepted" class="card ob-step">\s*<div class="ob-next-steps">/.test(vt), vs.includes("const stepAccepted = computed(() => driverStore.onboarding?.status === 'documents_signed')"), /allDocsSigned/.test(S.view)],
    [true, true, false])
  c.eq('§5 signingStep is the lib\'s, over the documents and the payload', /const signingStep = computed\(\(\) => signingStepView\(\{\s*status: driverStore\.onboarding\?\.status,\s*signed: signedCount\.value,\s*total: totalDocs\.value,\s*counts: driverStore\.emergencyContacts,\s*\}\)\)/.test(vs), true)
}

// ── §6 EmergencyContactsForm.vue ─────────────────────────────────────────────
function formSection(c, L, S) {
  const ft = templateOf(S.form)
  const fs6 = scriptOf(S.form)
  c.eq('§6 the list lives in the component: rows is a local ref', /^const rows = ref\(\[\]\)$/m.test(fs6), true)
  c.eq('§6 ...never the store: its one store call is loadData()', [(fs6.match(/driverStore\.\w+/g) || [])].map((m) => [...new Set(m)]), [['driverStore.loadData']])
  c.eq('§6 ...never the browser\'s storage', storageRe.test(S.form), false)
  c.eq('§6 read on every open, dropped on every close', /watch\(\(\) => props\.show, \(open\) => \{\s*reset\(\)\s*if \(open\) load\(\)\s*\}, \{ immediate: true \}\)/.test(fs6), true)
  c.eq('§6 reads and writes the driver\'s own route only', [fs6.includes('await api.get(CONTACTS_URL)'), fs6.includes('await api.put(CONTACTS_URL, body)'), /drivers-directory/.test(S.form)], [true, true, false])
  c.eq('§6 the list is checked with the server\'s rules before the PUT', /const check = validateContactList\(body\)\s*if \(!check\.ok\) \{[^}]*\}[\s\S]*await api\.put\(CONTACTS_URL, body\)/.test(fs6), true)
  c.eq('§6 after a save the form says so and the payload is read again (the status may have moved)', [fs6.includes("emit('saved')"), fs6.includes('await driverStore.loadData()')], [true, true])
  c.eq('§6 the field limits are the lib\'s', [
    ft.includes(':maxlength="CONTACT_NAME_MAX"'), ft.includes(':maxlength="RELATIONSHIP_MAX"'), ft.includes(':maxlength="PHONE_RAW_MAX"'),
  ], [true, true, true])
  c.eq('§6 ...and the lib\'s are the server\'s: 80, 40, 32', [L.CONTACT_NAME_MAX, L.RELATIONSHIP_MAX, L.PHONE_RAW_MAX], [server.CONTACT_NAME_MAX, server.RELATIONSHIP_MAX, server.PHONE_RAW_MAX])
  c.eq('§6 the phone field opens the phone keypad; no field fills itself in',
    [/type="tel"\s+inputmode="tel"/.test(ft), (ft.match(/autocomplete="off"/g) || []).length], [true, 3])
  c.eq('§6 remove only above the minimum, add only below the maximum',
    [ft.includes('v-if="rows.length > MIN_CONTACTS"'), ft.includes('v-if="rows.length < MAX_CONTACTS"')], [true, true])
  c.eq('§6 the relationship suggestions are the lib\'s', ft.includes('v-for="s in RELATIONSHIP_SUGGESTIONS"'), true)
  c.eq('§6 a late answer after a close never lands on the next open', [(fs6.match(/if \(seq !== loadSeq\) return/g) || []).length >= 3, fs6.includes('loadSeq++')], [true, true])
  const chips = (styleOf(S.form).match(/\.ec-chips \{([^}]*)\}/) || [])[1] || ''
  c.eq('§6 the suggestions wrap onto a second line at phone width (no hidden sideways scroll)', [/flex-wrap: wrap;/.test(chips), /overflow-x/.test(chips)], [true, false])
}

// ── §7 the store ─────────────────────────────────────────────────────────────
function storeSection(c, L, S) {
  c.eq('§7 emergencyContacts starts null and holds the payload\'s counts only',
    [/\n {4}emergencyContacts: null,\n/.test(S.store), S.store.includes('this.emergencyContacts = contactCounts(data.emergencyContacts)'), S.store.includes("import { contactCounts } from '../lib/emergencyContacts'")],
    [true, true, true])
  c.eq('§7 the store never fetches or keeps the list', /emergency-contacts|contacts:\s*\[/.test(S.store), false)
}

// ── §8 the five documents ────────────────────────────────────────────────────
// server.js's ONBOARDING_DOCS keys, read from its source.
function serverDocKeys() {
  const src = serverSource()
  const at = src.indexOf('\nconst ONBOARDING_DOCS = [')
  const end = at < 0 ? -1 : src.indexOf('\n];', at)
  if (at < 0 || end < 0) return null
  return [...src.slice(at, end).matchAll(/\{ key: "([a-z0-9_]+)"/g)].map((m) => m[1])
}
const SERVER_DOC_KEYS = serverDocKeys()
function docsSection(c, L, S) {
  c.eq('(fixture) server.js lists five onboarding documents', Array.isArray(SERVER_DOC_KEYS) && SERVER_DOC_KEYS.length === 5, true)
  c.eq('§8 the client\'s ONBOARDING_DOC_KEYS are server.js\'s ONBOARDING_DOCS keys, in order', L.ONBOARDING_DOC_KEYS, SERVER_DOC_KEYS)
  const count = fnOf(L, 'requiredSignedCount')
  const doc = (key, signed = true) => ({ doc_key: key, doc_name: key, signed })
  const five = SERVER_DOC_KEYS.map((k) => doc(k))
  c.eq('§8 five signed: 5', count(five), 5)
  c.eq('§8 four of the five and another document signed: 4, as the server counts (never 5)', count([...five.slice(0, 4), doc('service_invoice')]), 4)
  c.eq('§8 the five and another document signed: 5 (never 6)', count([...five, doc('passenger_authorization')]), 5)
  c.eq('§8 an unsigned one, a repeated key and a 1/0 flag', count([doc(SERVER_DOC_KEYS[0], 1), doc(SERVER_DOC_KEYS[0], 1), doc(SERVER_DOC_KEYS[1], 0), doc(SERVER_DOC_KEYS[2], false)]), 1)
  c.eq('§8 no list: 0', [count(null), count(undefined), count('w9'), count([null, 'x'])], [0, 0, 0, 0])
  const vs = scriptOf(S.view)
  c.eq('§8 the lock screen counts with it', vs.includes('const signedCount = computed(() => requiredSignedCount(onboardingDocs.value))'), true)
  c.eq('§8 ...and the server\'s document count, else the lib\'s', vs.includes('const totalDocs = computed(() => driverStore.onboarding?.totalDocs || ONBOARDING_DOC_KEYS.length)'), true)
}

// ── §9 the sign-in prompt ────────────────────────────────────────────────────
const PROMPT_BASE = Object.freeze({
  role: 'Driver', counts: { required: 2, maximum: 5, onFile: 0 }, onboarding: false, loaded: true, answered: false,
  welcomeOpen: false, loadOpen: false, dialogOpen: false, motionAllowed: true,
})
function promptSection(c, L, S) {
  const due = fnOf(L, 'contactsPromptDue')
  const at = (over) => due({ ...PROMPT_BASE, ...over })
  c.eq('§9 a Driver with none on file, past onboarding, after the first load, nothing else up, parked: shown', at({}), true)
  c.eq('§9 ...with one on file: shown', at({ counts: { required: 2, maximum: 5, onFile: 1 } }), true)
  const held = [
    ['a Super Admin previewing the page', { role: 'Super Admin' }],
    ['a Dispatcher', { role: 'Dispatcher' }],
    ['an Investor', { role: 'Investor' }],
    ['no counts (the flag off)', { counts: null }],
    ['two on file', { counts: { required: 2, maximum: 5, onFile: 2 } }],
    ['five on file', { counts: { required: 2, maximum: 5, onFile: 5 } }],
    ['still onboarding (the lock screen asks there)', { onboarding: true }],
    ['the first load not done yet', { loaded: false }],
    ['already answered this app start', { answered: true }],
    ['the welcome window open', { welcomeOpen: true }],
    ['a load page open (Drive Mode lives there)', { loadOpen: true }],
    ['another window open (a signature, a decline, the form itself)', { dialogOpen: true }],
    ['the truck moving, or stopped under 2 minutes', { motionAllowed: false }],
  ]
  for (const [label, over] of held) c.eq(`§9 held back: ${label}`, at(over), false)
  c.eq('§9 held back on anything unclear: no input, a missing gate', [due(undefined), due(null), at({ motionAllowed: undefined }), at({ loaded: undefined }), at({ onboarding: undefined })], [false, false, false, false, false])

  const vt = templateOf(S.view)
  const vs = scriptOf(S.view)
  const normal = normalUiOf(S.view)
  const mounts = vt.match(/<(?:EmergencyContactsPrompt|EmergencyContactsForm|DriverEmergencyContactsCard)\b[^>]*>/g) || []
  c.eq('§9 the flag off (no counts in the payload): every driver-side contacts piece is gated on canEditContacts, so none mounts', [
    mounts.length, mounts.filter((m) => /\sv-if="canEditContacts"/.test(m)).length,
  ], [4, 4])
  c.eq('§9 the prompt is in the normal driver screen only, for a Driver with the counts', [
    /<EmergencyContactsPrompt v-if="canEditContacts" :show="showContactsPrompt" @add="contactsPromptAdd" @later="contactsPromptLater" \/>/.test(normal),
    /<EmergencyContactsPrompt/.test(lockScreenOf(S.view)),
  ], [true, false])
  c.eq('§9 ...beside its own form, which tells the Kit card a save happened',
    /<EmergencyContactsForm v-if="canEditContacts" :show="showContactsForm" @close="showContactsForm = false" @saved="contactsRevision\+\+" \/>/.test(normal), true)
  const wiring = (vs.match(/const showContactsPrompt = computed\(\(\) => contactsPromptDue\(\{([\s\S]*?)\}\)\)/) || [])[1] || ''
  c.eq('§9 the view asks the lib with each input from its own source', [
    'role: auth.user?.role,', 'counts: driverStore.emergencyContacts,', 'onboarding: isOnboarding.value,', 'loaded: contactsPromptReady.value,',
    'answered: contactsPromptAnswered.value,', 'welcomeOpen: showWelcomeModal.value,', 'loadOpen: !!detailLoad.value,',
    'dialogOpen: showSignModal.value || showDeclineConfirm.value || showContactsForm.value,', 'motionAllowed: voiceGate.value.allowed,',
  ].map((line) => wiring.includes(line)), Array(9).fill(true))
  c.eq('§9 the answer lives in this view only: a ref of the mounted view, back at the next app start (each sign-in mounts the view)', [
    /^const contactsPromptAnswered = ref\(false\)$/m.test(vs),
    /contactsPromptAnswered/.test(S.store),
  ], [true, false])
  c.eq('§9 "Remind me later" only marks it answered', /function contactsPromptLater\(\) \{\s*contactsPromptAnswered\.value = true\s*\}/.test(vs), true)
  c.eq('§9 "Add now" marks it answered and opens the form', /function contactsPromptAdd\(\) \{\s*contactsPromptAnswered\.value = true\s*openContactsForm\(\)\s*\}/.test(vs), true)
  const promptLines = vs.split('\n').filter((l) => /contactsPrompt/.test(l))
  c.eq('§9 no web storage: none in the prompt, none on a line of the view that handles it', [storageRe.test(S.prompt), promptLines.some((l) => storageRe.test(l))], [false, false])
  c.eq('§9 ready only after the first load succeeded, a moment later (the first ELD read can hold it back)', [
    /await driverStore\.loadData\(\)\s*initialLoadFailed\.value = false\s*maybeShowWelcome\(\)\s*scheduleContactsPrompt\(\)/.test(vs),
    /setTimeout\(\(\) => \{\s*contactsPromptTimer = null\s*if \(isMounted\) contactsPromptReady\.value = true\s*\}, CONTACTS_PROMPT_SETTLE_MS\)/.test(vs),
    /clearTimeout\(contactsPromptTimer\)/.test(vs),
  ], [true, true, true])
  const pt = templateOf(S.prompt)
  c.eq('§9 the prompt\'s words and its two answers', [
    pt.includes('Add your emergency contacts'),
    pt.includes('LogisX keeps at least two people we can call if something happens to you on the road. It takes about two minutes.'),
    /data-testid="ec-prompt-add"[^>]*@click="emit\('add'\)"[^>]*>Add now</.test(pt),
    /data-testid="ec-prompt-later"[^>]*@click="emit\('later'\)"[^>]*>Remind me later</.test(pt),
  ], [true, true, true, true])
  c.eq('§9 the prompt reads nothing and is closed only by an answer', [/useApi|api\.|fetch\(/.test(scriptOf(S.prompt)), /:close-on-click-overlay="false"/.test(pt)], [false, true])
}

// ── §10 the Kit card ─────────────────────────────────────────────────────────
function cardSection(c, L, S) {
  const lines = fnOf(L, 'contactLines')
  c.eq('§10 the lines: the number as the server shows it, a tel: link from the stored E.164 number, the first marked primary', lines(STORED), [
    { id: 31, primary: true, name: 'Quinn Example', relationship: 'Spouse', phone: '(202) 555-0143', tel: 'tel:+12025550143' },
    { id: 32, primary: false, name: 'Jordan Placeholder', relationship: 'Friend', phone: '+442079460958', tel: 'tel:+442079460958' }])
  c.eq('§10 a number not in E.164 form gets no link; junk entries are dropped', lines([{ id: 5, name: 'Sky Testcase', relationship: 'Other', phone: 'javascript:x', phoneDisplay: '' }, null, 'x']),
    [{ id: 5, primary: true, name: 'Sky Testcase', relationship: 'Other', phone: '', tel: null }])
  c.eq('§10 ...and other near misses get none either', ['+0123456789', '+1234567', '+1234567890123456', '12025550143', '+1202555014x'].map((p) => lines([{ id: 1, name: 'A', relationship: 'B', phone: p }])[0].tel), [null, null, null, null, null])
  c.eq('§10 no list: no lines', [lines(null), lines(undefined), lines('x')], [[], [], []])

  const vs = scriptOf(S.view)
  const kit = (templateOf(S.view).match(/<!-- KIT TAB -->([\s\S]*?)<\/section>/) || [])[1] || ''
  c.eq('§10 the card is in the Kit tab, for a Driver with the counts only, outside the loading template (a refresh never remounts it)', [
    /<\/template>\s*(?:<!--[^>]*-->\s*)?<DriverEmergencyContactsCard v-if="canEditContacts" :revision="contactsRevision" @edit="openContactsForm" \/>/.test(kit),
    (S.view.match(/<DriverEmergencyContactsCard/g) || []).length,
  ], [true, 1])
  c.eq('§10 the view counts saves for it', /^const contactsRevision = ref\(0\)$/m.test(vs), true)
  const cs = scriptOf(S.card)
  const ct = templateOf(S.card)
  c.eq('§10 the card reads the driver\'s own route, keeps the list in itself, and knows nothing of the store or the office routes', [
    cs.includes('await api.get(CONTACTS_URL)'), /^const contacts = ref\(\[\]\)$/m.test(cs), /useDriverStore|drivers-directory|api\.put|api\.post/.test(S.card), storageRe.test(S.card),
  ], [true, true, false, false])
  c.eq('§10 it reads again on every save the view counts, and drops the list when it goes', [
    /watch\(\(\) => props\.revision, load, \{ immediate: true \}\)/.test(cs), /onUnmounted\(\(\) => \{[^}]*contacts\.value = \[\][^}]*\}\)/.test(cs),
  ], [true, true])
  c.eq('§10 its lines are the lib\'s, each number a tap to call, and the empty words', [
    cs.includes('contactLines(contacts.value)'), /<a v-if="line\.tel" :href="line\.tel"/.test(ct), ct.includes('No emergency contacts yet. Add at least two.'),
  ], [true, true, true])
  c.eq('§10 Edit asks the view for the form', /@click="emit\('edit'\)"/.test(ct), true)
}

// ── §11 the office panel ─────────────────────────────────────────────────────
function panelSection(c, L, S) {
  const url = fnOf(L, 'staffContactsUrl')
  c.eq('§11 the staff route for a Drivers page row', url(501), '/api/drivers-directory/501/emergency-contacts')
  c.eq('§11 ...and none for anything but a positive whole id', [url(0), url(-1), url(1.5), url('501'), url(null), url(undefined), url(2 ** 53)], [null, null, null, null, null, null, null])
  c.eq('§11 a 404 FEATURE_OFF, and only that, says the feature is off', [
    L.isFeatureOff({ status: 404, code: 'FEATURE_OFF' }), L.isFeatureOff({ status: 404, code: 'DRIVER_NOT_FOUND' }), L.isFeatureOff({ status: 403, code: 'FEATURE_OFF' }), L.isFeatureOff(null),
  ], [true, false, false, false])
  c.eq('§11 linked:false in words', [L.linkedText('no_driver_account'), L.linkedText('ambiguous'), L.linkedText(undefined)], [
    'No driver account is linked to this directory row. Contacts are kept on the driver\'s sign-in account.',
    'Two driver accounts match this name. Fix the names first.',
    'No driver account is linked to this directory row. Contacts are kept on the driver\'s sign-in account.'])
  c.eq('§11 the staff PUT\'s 409s in the same words', [L.refusalText({ status: 409, code: 'NO_DRIVER_ACCOUNT' }), L.refusalText({ status: 409, code: 'DRIVER_ACCOUNT_AMBIGUOUS' })],
    [L.linkedText('no_driver_account'), L.linkedText('ambiguous')])
  c.eq('§11 a failed read or save names the driver, not "your"', [L.staffRefusalText({ status: 500, code: 'READ_FAILED' }, 'READ_FAILED'), L.staffRefusalText({ status: 500 }), L.staffRefusalText({ status: 422, code: 'CONTACT_PHONE_INVALID' })], [
    'This driver\'s emergency contacts couldn\'t be loaded. Try again.', 'This driver\'s emergency contacts couldn\'t be saved. Try again.', L.MESSAGES.CONTACT_PHONE_INVALID])

  const ps = scriptOf(S.panel)
  const pt = templateOf(S.panel)
  const apiPaths = [...S.panel.matchAll(/['"`](\/api\/[^'"`]*)['"`]/g)].map((m) => m[1])
  c.eq('§11 the panel names one route of its own (the directory, to find a driver by name) and reaches the rest through staffContactsUrl()', [
    [...new Set(apiPaths)], /CONTACTS_URL/.test(S.panel), (ps.match(/staffContactsUrl\(/g) || []).length >= 2,
  ], [['/api/drivers-directory'], false, true])
  c.eq('§11 ...reads and writes through it', [/const answer = await api\.get\(url\)/.test(ps), /await api\.put\(url, body\)/.test(ps)], [true, true])
  c.eq('§11 the list lives in the panel only, never the browser\'s storage, never the console', [/^const stored = ref\(\[\]\)$/m.test(ps), storageRe.test(S.panel), /console\./.test(S.panel)], [true, false, false])
  c.eq('§11 hidden until the server answers, and for the rest of the page load once it says the feature is off', [
    /^const hidden = ref\(true\)$/m.test(ps), /if \(isFeatureOff\(err\)\) \{\s*featureOffSeen = true/.test(ps), /^let featureOffSeen = false$/m.test(ps), /^\s*<section v-if="!hidden"/m.test(pt),
  ], [true, true, true, true])
  c.eq('§11 linked:false shown in words; each number a tap to call; the lib\'s lines', [
    ps.includes('linkedText('), /<a v-if="line\.tel" :href="line\.tel"/.test(pt), ps.includes('contactLines(stored.value)'),
  ], [true, true, true])
  c.eq('§11 the edit form: the limits, the phone keypad, no field fills itself in, the add and remove bounds', [
    pt.includes(':maxlength="CONTACT_NAME_MAX"'), pt.includes(':maxlength="RELATIONSHIP_MAX"'), pt.includes(':maxlength="PHONE_RAW_MAX"'),
    /type="tel"\s+inputmode="tel"/.test(pt), (pt.match(/autocomplete="off"/g) || []).length, pt.includes('v-if="rows.length > MIN_CONTACTS"'), pt.includes('v-if="rows.length < MAX_CONTACTS"'),
  ], [true, true, true, true, 3, true, true])
  c.eq('§11 checked with the server\'s rules before the PUT', /const check = validateContactList\(sent\.body\)\s*if \(!check\.ok\) \{[^}]*\}[\s\S]*await api\.put\(url, body\)/.test(ps), true)

  const table = S.table
  const drug = table.indexOf('Pre-Employment Drug Test')
  const mount = table.search(/<EmergencyContactsPanel v-if="viewDrv\._rowIndex" :directory-id="viewDrv\._rowIndex" \/>/)
  const shared = table.indexOf('<LegalDocumentPortal')
  c.eq('§11 mounted in the Drivers page detail, between the drug test and the shared documents, by the row\'s id', [drug > 0, mount > drug, shared > mount], [true, true, true])
  c.eq('§11 ...and imported there', table.includes("import EmergencyContactsPanel from './EmergencyContactsPanel.vue'"), true)
  const fleet = S.fleet
  const contact = fleet.indexOf('<div class="dash-section-title">Contact</div>')
  const fmount = fleet.search(/<EmergencyContactsPanel v-if="selected" :driver-name="selected\.Driver" \/>/)
  const avail = fleet.indexOf('<DriverAvailabilityPanel')
  c.eq('§11 mounted in the Fleet & Drivers dialog, after Contact and before the time off, by the driver\'s name', [contact > 0, fmount > contact, avail > fmount], [true, true, true])
  c.eq('§11 ...and imported there', fleet.includes("import EmergencyContactsPanel from '../drivers-db/EmergencyContactsPanel.vue'"), true)
}

// ── §12 a lost answer ────────────────────────────────────────────────────────
function lostAnswerSection(c, L, S) {
  const adopt = fnOf(L, 'adoptStoredIds')
  const typed = [
    { id: null, key: 1, name: 'Quinn Example', relationship: 'Spouse', phone: '(202) 555-0143' },
    { id: null, key: 2, name: ' Jordan   Placeholder ', relationship: 'Friend', phone: '+44 20 7946 0958' },
  ]
  c.eq('§12 the list the lost save stored: each row takes its contact\'s id (matched as stored), nothing else changes',
    adopt(typed, STORED), [{ ...typed[0], id: 31 }, { ...typed[1], id: 32 }])
  c.eq('§12 ...so the next body names both ids (a no-op on the server)', L.listToSend(adopt(typed, STORED)).body.contacts.map((x) => x.id), [31, 32])
  c.eq('§12 a row edited since does not match and stays new', adopt([{ ...typed[0], name: 'Quinn Example Jr' }], STORED)[0].id, null)
  c.eq('§12 a row that already has an id keeps it, and that id is never given twice', adopt([{ ...typed[0], id: 31 }, { ...typed[0] }], STORED).map((r) => r.id), [31, null])
  c.eq('§12 two rows typed alike: only the first takes the id', adopt([typed[0], { ...typed[0], key: 3 }], STORED).map((r) => r.id), [31, null])
  c.eq('§12 nothing stored, or junk: the rows as they were', [adopt(typed, []), adopt(typed, null), adopt(typed, [null, { id: 'x' }])], [typed, typed, typed])
  c.eq('§12 no rows: none', [adopt(null, STORED), adopt([], STORED)], [[], []])

  const fs12 = scriptOf(S.form)
  c.eq('§12 the form: a save with no answer (replyLost()) marks the ids stale, and the next Save reads the list and takes them back first', [
    fs12.includes("import { replyLost } from '../../lib/saveOutcome'"),
    /if \(replyLost\(err\)\) idsStale = true/.test(fs12),
    /if \(idsStale && !\(await takeBackStoredIds\(\)\)\) return\s*const \{ body, rowOf \} = listToSend\(rows\.value\)/.test(fs12),
    /rows\.value = adoptStoredIds\(rows\.value, fresh && fresh\.contacts\)\s*idsStale = false/.test(fs12),
    /function reset\(\) \{[^}]*idsStale = false/.test(fs12),
  ], [true, true, true, true, true])
  const ps = scriptOf(S.panel)
  c.eq('§12 the panel does the same', [
    /if \(replyLost\(err\)\) idsStale = true/.test(ps),
    /if \(idsStale\) \{\s*const fresh = await api\.get\(url\)[\s\S]*?rows\.value = adoptStoredIds\(rows\.value, fresh && fresh\.contacts\)\s*idsStale = false/.test(ps),
  ], [true, true])
}

// ── §13 the field limits as sent ─────────────────────────────────────────────
function limitsSection(c, L, S) {
  const clamp = fnOf(L, 'clampToLimit')
  const face = String.fromCodePoint(0x1f600)
  c.eq('§13 a text within the limit is kept', [clamp('Quinn Example', 80), clamp('x'.repeat(80), 80), clamp('', 80)], ['Quinn Example', 'x'.repeat(80), ''])
  c.eq('§13 a longer one is cut to the limit in UTF-16 units, the server\'s count', clamp('x'.repeat(81), 80).length, 80)
  c.eq('§13 ...never splitting a character in two (an emoji is two units)', [clamp('a' + face.repeat(40), 80), clamp(face.repeat(41), 80).length], ['a' + face.repeat(39), 80])
  c.eq('§13 ...so what the field holds the server accepts', L.cleanContactText(clamp('a' + face.repeat(40), 80), 80).ok, true)
  c.eq('§13 anything but text: empty', [clamp(null, 80), clamp(42, 80), clamp(undefined, 80)], ['', '', ''])
  const ft = templateOf(S.form)
  const fs13 = scriptOf(S.form)
  c.eq('§13 each field of the form clamps with the lib\'s count as the driver types (Vant\'s maxlength counts characters)', [
    /const clampName = \(v\) => clampToLimit\(v, CONTACT_NAME_MAX\)/.test(fs13),
    /const clampRelationship = \(v\) => clampToLimit\(v, RELATIONSHIP_MAX\)/.test(fs13),
    /const clampPhone = \(v\) => clampToLimit\(v, PHONE_RAW_MAX\)/.test(fs13),
    ft.includes(':formatter="clampName"'), ft.includes(':formatter="clampRelationship"'), ft.includes(':formatter="clampPhone"'),
  ], [true, true, true, true, true, true])
}

const SECTIONS = {
  counts: ['§1', countsSection], progress: ['§2', progressSection], words: ['§3', wordsSection], rows: ['§4', rowsSection],
  lock: ['§5', lockScreenSection], form: ['§6', formSection], store: ['§7', storeSection], docs: ['§8', docsSection],
  prompt: ['§9', promptSection], card: ['§10', cardSection], panel: ['§11', panelSection], lost: ['§12', lostAnswerSection], limits: ['§13', limitsSection],
}
function runSections(c, L, S, names = Object.keys(SECTIONS)) {
  for (const n of names) {
    const [label, fn] = SECTIONS[n]
    section(c, label, () => fn(c, L, S))
  }
}

// ── the run ──────────────────────────────────────────────────────────────────
if (!fs.existsSync(LIB) || !fs.existsSync(FILES.form)) {
  MAIN.eq('client/src/lib/emergencyContacts.js exists', fs.existsSync(LIB), true)
  MAIN.eq('client/src/components/driver/EmergencyContactsForm.vue exists', fs.existsSync(FILES.form), true)
} else {
  const lib = await import(pathToFileURL(LIB).href)
  const HEADS = {
    counts: '§1 the item exists only with the payload\'s counts', progress: '§2 the progress and the step\'s tick', words: '§3 every refusal in plain words',
    rows: '§4 the rows and the body sent', lock: '§5 DriverView.vue\'s lock screen', form: '§6 EmergencyContactsForm.vue', store: '§7 the driver store',
    docs: '§8 the five documents the server counts', prompt: '§9 the sign-in prompt', card: '§10 the Kit card', panel: '§11 the office panel',
    lost: '§12 a save whose answer was lost', limits: '§13 the field limits as sent',
  }
  for (const n of Object.keys(SECTIONS)) {
    console.log(`\n${HEADS[n]}`)
    runSections(MAIN, lib, S0, [n])
  }

  // ── §14 mutants ────────────────────────────────────────────────────────────
  console.log('\n§14 mutants')
  const once = (src, from, to) => {
    const n = src.split(from).length - 1
    if (n !== 1) throw new Error(`target found ${n}x (expected 1): ${from.slice(0, 70)}`)
    return src.replace(from, () => to)
  }
  async function mutant(id, label, build, names) {
    let L = lib
    let S = S0
    try {
      const made = build()
      if (made.lib !== undefined) L = await import(`data:text/javascript,${encodeURIComponent(made.lib)}`)
      if (made.files) S = { ...S0, ...made.files }
    } catch (err) {
      MAIN.eq(`§14 ${id}: ${label} — the mutation applies`, err.message, 'applies')
      return
    }
    const c = checker(false)
    runSections(c, L, S, names)
    MAIN.eq(`§14 ${id}: ${label} — is caught`, c.failed.length > 0 ? 'caught' : 'not caught', 'caught')
  }
  const libMut = (from, to) => () => ({ lib: once(LIB_SRC, from, to) })
  const fileMut = (key, from, to) => () => ({ files: { [key]: once(S0[key], from, to) } })
  await mutant('M1', 'the step counts the item only while documents_pending (the 5/5 after the save)',
    libMut("const counted = !!item && (status === 'documents_pending' || item.done)", "const counted = !!item && status === 'documents_pending'"), ['progress'])
  await mutant('M2', 'every signed document counted, one outside the five too',
    libMut('return ONBOARDING_DOC_KEYS.filter((k) => signedKeys.has(k)).length', 'return signedKeys.size'), ['docs'])
  await mutant('M3', 'the prompt ignoring a moving truck', libMut('return s.motionAllowed === true', 'return true'), ['prompt'])
  await mutant('M4', 'the prompt during onboarding', libMut('if (s.onboarding !== false || s.loaded !== true', 'if (s.loaded !== true'), ['prompt'])
  await mutant('M5', 'the prompt again after an answer', libMut(' || s.answered !== false) return false', ') return false'), ['prompt'])
  await mutant('M6', 'the prompt over a load page (Drive Mode)', libMut('if (s.welcomeOpen || s.loadOpen || s.dialogOpen) return false', 'if (s.welcomeOpen || s.dialogOpen) return false'), ['prompt'])
  await mutant('M7', 'the prompt for any role', libMut("if (!isPlainObject(s) || s.role !== 'Driver') return false", 'if (!isPlainObject(s)) return false'), ['prompt'])
  await mutant('M8', 'the staff URL pointed at the driver\'s own route', libMut('? `/api/drivers-directory/${directoryId}/emergency-contacts` : null', '? CONTACTS_URL : null'), ['panel'])
  await mutant('M9', 'a lost save\'s ids never taken back', libMut('const hit = key === null ? -1 : free.findIndex((c) => c.key === key)', 'const hit = -1'), ['lost'])
  await mutant('M10', 'the field cut counted in characters', libMut('if (value.length <= limit) return value', 'if ([...value].length <= limit) return value'), ['limits'])
  await mutant('M11', 'a tel: link for any text', libMut('const tel = telNumber(c.phone)', 'const tel = typeof c.phone === \'string\' ? c.phone : \'\''), ['card'])
  await mutant('M12', 'the Kit card for anyone with the page', fileMut('view', '<DriverEmergencyContactsCard v-if="canEditContacts"', '<DriverEmergencyContactsCard'), ['card'])
  await mutant('M13', '"Remind me later" written to the browser\'s storage',
    fileMut('view', 'function contactsPromptLater() {\n  contactsPromptAnswered.value = true\n', "function contactsPromptLater() {\n  contactsPromptAnswered.value = true\n  try { localStorage.setItem('contactsPromptAnswered', '1') } catch { /* private mode */ }\n"), ['prompt'])
  await mutant('M14', 'the prompt planted on the lock screen too',
    fileMut('view', '<EmergencyContactsForm v-if="canEditContacts" :show="showContactsForm" @close="showContactsForm = false" />',
      '<EmergencyContactsForm v-if="canEditContacts" :show="showContactsForm" @close="showContactsForm = false" />\n      <EmergencyContactsPrompt v-if="canEditContacts" :show="showContactsPrompt" @add="contactsPromptAdd" @later="contactsPromptLater" />'), ['prompt'])
  await mutant('M15', 'the prompt ignoring an open load page in the view', fileMut('view', 'loadOpen: !!detailLoad.value,', 'loadOpen: false,'), ['prompt'])
  await mutant('M16', 'the panel reading the driver\'s own route', fileMut('panel', 'const answer = await api.get(url)', "const answer = await api.get('/api/driver/me/emergency-contacts')"), ['panel'])
  await mutant('M17', 'the panel shown before the server answers', fileMut('panel', 'const hidden = ref(true)', 'const hidden = ref(false)'), ['panel'])
  await mutant('M18', 'the Fleet dialog without the panel', fileMut('fleet', '<EmergencyContactsPanel v-if="selected" :driver-name="selected.Driver" />', ''), ['panel'])
  await mutant('M19', 'the form never reading the list again after a lost answer', fileMut('form', 'if (replyLost(err)) idsStale = true', ''), ['lost'])
  await mutant('M20', 'one field without the clamp', fileMut('form', ':formatter="clampName"', ''), ['limits'])
  await mutant('M21', 'the contacts row no longer a tap target', fileMut('view', '@click="openContactsForm"', ''), ['lock'])
  await mutant('M22', 'the card keeping the list in the store', fileMut('card', 'const contacts = ref([])', 'const contacts = ref(useDriverStore().contactsList || [])'), ['card'])
}

console.log(`\ntest-emergency-contacts-client: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
