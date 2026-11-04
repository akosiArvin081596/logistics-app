#!/usr/bin/env node
// The driver's passenger authorization screens (PASSENGER_AUTHORIZATION_ENABLED):
// client/src/lib/passengerAuthorization.js and the card, form and signature pad that
// use it.
//
// The server decides (lib/passenger-authorization.js and its routes runner). The
// screens only collect, show and send:
//   §1 the routes and the live event the screens use
//   §2 the words for each status; one the phone doesn't know never reads as valid
//   §3 the body sent: strict booleans, an adult's guardian lines blank, each signer's
//      consent from buildConsent(), the two images, the request id
//   §4 the request id: a UUID v4 made once per opening, kept by a repeat of Submit
//   §5 the blank state: no passenger's name or image after a close
//   §6 the dates: the pickers' bounds and the server's windows, at their edges
//   §7 the details checks, one per refusal code, on cleaned text
//   §8 every refusal and failure in plain words
//   §9 parity: the age words the form prints, and the server module's rules once
//      it is there
//   §10 the feature gate: nothing shows unless the feature route says true, and
//      only for a Driver
//   §11 DriverView.vue: the optional card on the lock screen and in the Kit, outside
//      the step's count and outside the Kit's loading swap
//   §12 privacy: the rows live in the card alone; the browser keeps one flag, never
//      a passenger's data
//   §13 SignaturePad.vue: every way a stroke ends, the lock, the PNG
//   §14 the form: the signing order, the lock on the details, Submit only when done
//   §15 the summary of what prints, and who signs for the passenger
//   §16 the new components compile with the client's compiler
//   §17 mutants: copies with one rule changed must each be caught by the sections
//
// No DOM, no server, no build. Made-up names only.
//   node scripts/test-passenger-authorization-client.mjs      # exits 1 on any failure
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const CLIENT = path.join(ROOT, 'client')
const LIB = path.join(CLIENT, 'src', 'lib', 'passengerAuthorization.js')
const DATETIME = path.join(CLIENT, 'src', 'utils', 'datetime.js')
const CONSENT = path.join(CLIENT, 'src', 'lib', 'signingConsent.js')
const FILES = {
  view: path.join(CLIENT, 'src', 'views', 'DriverView.vue'),
  card: path.join(CLIENT, 'src', 'components', 'driver', 'PassengerAuthorizationsCard.vue'),
  modal: path.join(CLIENT, 'src', 'components', 'driver', 'PassengerAuthorizationModal.vue'),
  pad: path.join(CLIENT, 'src', 'components', 'shared', 'SignaturePad.vue'),
  feature: path.join(CLIENT, 'src', 'composables', 'usePassengerAuthorizationFeature.js'),
}
const TEXT = require(path.join(ROOT, 'lib', 'passenger-authorization-text.js')).PASSENGER_AUTHORIZATION_TEXT
const SERVER_LIB = path.join(ROOT, 'lib', 'passenger-authorization.js')
// server.js's sanitizeEvidenceText(), lifted as the server runs it: the clean-up the
// server's checks read every field through.
const sanitizeEvidenceText = (() => {
  try {
    const src = require(path.join(ROOT, 'scripts', 'lib', 'server-source.js')).serverSource()
    const { closure } = require(path.join(ROOT, 'scripts', 'lib', 'server-lift.js'))
    return new Function(`${closure(src, { roots: ['sanitizeEvidenceText'] }).text}\nreturn sanitizeEvidenceText`)()
  } catch { return null }
})()

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const S0 = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, read(p)]))
const LIB_SRC = read(LIB)
// A .vue file's <script setup> and <template>, apart; tags matched at a line start.
const scriptOf = (src) => (src.match(/^<script setup>([\s\S]*?)^<\/script>/m) || [])[1] || ''
const templateOf = (src) => src.slice(0, Math.max(0, src.indexOf('\n<script')))
// The body of `function name(...) {` up to the next line holding only "}".
const fnBody = (src, name) => {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) return ''
  const end = src.indexOf('\n}\n', at)
  return end < 0 ? src.slice(at) : src.slice(at, end + 2)
}
const count = (src, s) => src.split(s).length - 1
const storageRe = /localStorage|sessionStorage|indexedDB|document\.cookie/

// ── reporting ────────────────────────────────────────────────────────────────
// The main run prints every result; a mutant run only counts what failed.
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
  c.ok = (name, cond) => c.eq(name, !!cond, true)
  return c
}
const MAIN = checker(true)
// A throw (a missing export on the old code) is the section's failure, never a crash.
function section(c, label, fn) {
  try { fn() } catch (err) { c.eq(`${label} ran`, `threw: ${err && err.message}`, 'no throw') }
}

// Made-up values (the plan's Appendix B).
const TODAY = '2026-11-02'
const IMG_P = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const IMG_D = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const RID = '0f1e2d3c-4b5a-4987-a6b5-c4d3e2f1a0b9'
const adultForm = (o = {}) => ({
  ...blank(), requestId: RID, passengerName: 'Jane Example', passengerAdult: true, truckUnit: 'T-0000',
  tripStart: 'Houston, TX', tripEnd: 'Dallas, TX', validFrom: TODAY, expiresOn: '2026-11-09', ...o,
})
const minorForm = (o = {}) => adultForm({
  passengerName: 'Riley Example', passengerAdult: false, guardianName: 'Pat Example', guardianRelationship: 'Parent', minorAttested: true, ...o,
})
const signed = (s) => ({ ...s, passengerAgreed: true, passengerSigned: true, driverAgreed: true, driverSigned: true })
let blank = () => ({})

// ── §1 routes ────────────────────────────────────────────────────────────────
function routesSection(c, L) {
  c.eq('§1 the feature route, the list, the blank form', [L.FEATURE_URL, L.LIST_URL, L.FORM_PDF_URL],
    ['/api/passenger-authorizations/feature', '/api/passenger-authorizations', '/api/passenger-authorizations/form.pdf'])
  c.eq('§1 the live event is the domain\'s :changed', L.LIVE_EVENT, 'passenger-authorizations:changed')
  c.eq('§1 a row\'s PDF by its id', L.pdfUrl(7), '/api/passenger-authorizations/7/pdf')
  c.eq('§1 no PDF link for an id that is not a positive whole number', [L.pdfUrl(0), L.pdfUrl(-3), L.pdfUrl(1.5), L.pdfUrl('7'), L.pdfUrl('../x'), L.pdfUrl(null), L.pdfUrl(undefined)],
    [null, null, null, null, null, null, null])
  c.eq('§1 the create call waits a minute (the server renders first)', L.SUBMIT_TIMEOUT_MS, 60000)
}

// ── §2 status words ──────────────────────────────────────────────────────────
function statusSection(c, L) {
  const row = (displayStatus) => ({ id: 1, displayStatus, validFrom: '2026-11-04', expiresOn: '2026-11-09' })
  const words = (s) => L.statusView(row(s))
  c.eq('§2 waiting for the company', words('awaiting_company'), { key: 'awaiting_company', text: 'Waiting for company signature', tone: 'wait' })
  c.eq('§2 authorized and started', words('active'), { key: 'active', text: 'Authorized until Nov 9, 2026', tone: 'ok' })
  c.eq('§2 authorized, not started yet', words('scheduled'), { key: 'scheduled', text: 'Authorized from Nov 4, 2026 until Nov 9, 2026', tone: 'ok' })
  c.eq('§2 expired', words('expired'), { key: 'expired', text: 'Expired Nov 9, 2026', tone: 'ended' })
  c.eq('§2 declined', words('declined'), { key: 'declined', text: 'Declined by the company', tone: 'ended' })
  c.eq('§2 ended by the company', words('revoked'), { key: 'revoked', text: 'Ended by the company', tone: 'ended' })
  for (const s of ['authorized', 'AUTHORIZED', 'Active', '', undefined, null, 7]) {
    const v = words(s)
    c.ok(`§2 a status the phone doesn't know (${JSON.stringify(s)}) never reads as valid or waiting`, v.tone === 'ended' && !/authori[sz]ed|waiting/i.test(v.text))
  }
  c.eq('§2 no row at all: not valid', L.statusView(null).key, 'unknown')

  const listed = { id: 12, reference: 'PA-0000ABCD', passengerName: 'Riley Example', passengerAdult: false, tripStart: 'Houston, TX', tripEnd: 'Dallas, TX',
    validFrom: '2026-11-02', expiresOn: '2026-11-09', displayStatus: 'awaiting_company' }
  c.eq('§2 a row as the card shows it', L.rowView(listed), {
    id: 12, reference: 'PA-0000ABCD', passengerName: 'Riley Example', minor: true, tripStart: 'Houston, TX', tripEnd: 'Dallas, TX',
    dates: 'Nov 2, 2026 to Nov 9, 2026', status: { key: 'awaiting_company', text: 'Waiting for company signature', tone: 'wait' }, pdfUrl: '/api/passenger-authorizations/12/pdf',
  })
  c.eq('§2 "Under 18" only for a real false', [L.rowView({ ...listed, passengerAdult: true }).minor, L.rowView({ ...listed, passengerAdult: undefined }).minor, L.rowView({ ...listed, passengerAdult: 0 }).minor], [false, false, false])
  c.eq('§2 the list keeps rows with a usable id, in the order sent', L.listView({ authorizations: [listed, { ...listed, id: 0 }, null, 'x', { ...listed, id: '13' }, { ...listed, id: 11 }] }).map((r) => r.id), [12, 11])
  c.eq('§2 an answer without the list: no rows', [L.listView(null), L.listView({}), L.listView([listed]), L.listView({ authorizations: 'x' })], [[], [], [], []])
  c.eq('§2 the create answer, bare or wrapped', [L.createdView(listed)?.reference, L.createdView({ authorization: listed })?.reference, L.createdView({}), L.createdView(null)], ['PA-0000ABCD', 'PA-0000ABCD', null, null])
}

// ── §3 the body sent ─────────────────────────────────────────────────────────
function bodySection(c, L) {
  const images = { passenger: IMG_P, driver: IMG_D }
  const adult = L.buildSubmission(signed(adultForm({ guardianName: 'Pat Example', guardianRelationship: 'Parent', minorAttested: true })), images)
  c.eq('§3 an adult: the whole body, guardian lines blank and the minor\'s box unticked whatever was typed', adult, {
    requestId: RID, passengerName: 'Jane Example', passengerAdult: true, guardianName: '', guardianRelationship: '', minorAttested: false,
    truckUnit: 'T-0000', tripStart: 'Houston, TX', tripEnd: 'Dallas, TX', validFrom: TODAY, expiresOn: '2026-11-09',
    passengerSignatureImage: IMG_P, passengerConsent: { agreed: true, text: 'I have read and agree to the terms of this document' },
    driverSignatureImage: IMG_D, driverConsent: { agreed: true, text: 'I have read and agree to the terms of this document' },
  })
  const minor = L.buildSubmission(signed(minorForm({ guardianName: '  Pat Example ' })), images)
  c.eq('§3 a minor: the guardian lines (trimmed) and the box sent', [minor.passengerAdult, minor.guardianName, minor.guardianRelationship, minor.minorAttested],
    [false, 'Pat Example', 'Parent', true])
  c.eq('§3 a minor\'s box is ticked only by a real true', L.buildSubmission(signed(minorForm({ minorAttested: 'yes' })), images).minorAttested, false)
  for (const age of [null, undefined, 'true', 'false', 1, 0, '']) {
    c.eq(`§3 an age answer that is not a real yes or no (${JSON.stringify(age)}) sends nothing`, L.buildSubmission(signed(adultForm({ passengerAdult: age })), images), null)
  }
  c.eq('§3 the booleans are booleans', [typeof adult.passengerAdult, typeof adult.minorAttested, typeof adult.passengerConsent.agreed, typeof adult.driverConsent.agreed],
    ['boolean', 'boolean', 'boolean', 'boolean'])
  const unticked = L.buildSubmission(adultForm({ passengerAgreed: false, driverAgreed: 'true' }), images)
  c.eq('§3 each consent is what that signer ticked, from buildConsent()', [unticked.passengerConsent, unticked.driverConsent],
    [{ agreed: false, text: 'I have read and agree to the terms of this document' }, { agreed: false, text: 'I have read and agree to the terms of this document' }])
  c.eq('§3 a missing image goes as null (the server answers SIGNATURE_REQUIRED)', [L.buildSubmission(signed(adultForm()), {}).passengerSignatureImage, L.buildSubmission(signed(adultForm()), null).driverSignatureImage], [null, null])
  c.eq('§3 no state, no body', [L.buildSubmission(null, images), L.buildSubmission('x', images)], [null, null])
}

// ── §4 the request id ────────────────────────────────────────────────────────
function requestIdSection(c, L, S) {
  c.eq('§4 randomUUID when the browser has it', L.newRequestId({ randomUUID: () => RID }), RID)
  c.eq('§4 else 16 random bytes made a v4 UUID', L.newRequestId({ getRandomValues: (a) => a.fill(0) }), '00000000-0000-4000-8000-000000000000')
  c.ok('§4 ...whatever the bytes', L.REQUEST_ID_RE.test(L.newRequestId({ getRandomValues: (a) => a.fill(255) })))
  c.eq('§4 no crypto: no id (Submit stays off and says why)', [L.newRequestId({}), L.newRequestId(null)], ['', ''])
  c.ok('§4 the real crypto gives a v4 UUID', L.REQUEST_ID_RE.test(L.newRequestId()))
  c.eq('§4 the state carries the id it is given', [L.blankState({ requestId: RID }).requestId, L.blankState().requestId], [RID, ''])
  const script = scriptOf(S.modal)
  c.eq('§4 the form makes an id in one place only', count(script, 'newRequestId('), 1)
  const watcher = (script.match(/watch\(\(\) => props\.show, \(open\) => \{[\s\S]*?\n\}, \{ immediate: true \}\)/) || [''])[0]
  c.ok('§4 ...when it opens', /state\.value = open \? blankState\(\{ requestId: newRequestId\(\)/.test(watcher))
  c.ok('§4 Submit never changes it, so a repeat after a lost answer is the same request', !/requestId/.test(fnBody(script, 'submit')))
}

// ── §5 the blank state ───────────────────────────────────────────────────────
function blankSection(c, L, S) {
  const b = L.blankState()
  c.eq('§5 nothing typed, ticked, signed or sent', [b.passengerName, b.passengerAdult, b.guardianName, b.guardianRelationship, b.minorAttested, b.truckUnit,
    b.tripStart, b.tripEnd, b.validFrom, b.expiresOn, b.passengerAgreed, b.passengerSigned, b.driverAgreed, b.driverSigned, b.submitting, b.pending, b.error, b.sent],
  ['', null, '', '', false, '', '', '', '', '', false, false, false, false, false, false, '', null])
  c.ok('§5 no key holds an image, and no value is one', !Object.keys(b).some((k) => /image/i.test(k)) && !JSON.stringify(b).includes('data:'))
  const opened = L.blankState({ requestId: RID, today: TODAY, truckUnit: '  T-0000 ' })
  c.eq('§5 an opening starts the trip today with the truck prefilled', [opened.validFrom, opened.truckUnit, opened.passengerName], [TODAY, 'T-0000', ''])
  c.eq('§5 a prefill is cut to the limit; a start that is not a real day is left blank', [L.blankState({ truckUnit: 'T'.repeat(30) }).truckUnit.length, L.blankState({ today: '2026-02-30' }).validFrom], [20, ''])
  const script = scriptOf(S.modal)
  const watcher = (script.match(/watch\(\(\) => props\.show, \(open\) => \{[\s\S]*?\n\}, \{ immediate: true \}\)/) || [''])[0]
  c.ok('§5 the form\'s state is replaced on both edges of show, from the start', /state\.value = open \? blankState\(\{[^\n]*\}\) : blankState\(\)/.test(watcher))
  c.ok('§5 ...and the day goes too', /today\.value = open \? appToday\(\) : ''/.test(watcher))
  c.ok('§5 the pads live inside the v-if, so a closed form holds no drawn signature', /<div v-if="show" class="pam-overlay">[\s\S]*<SignaturePad[\s\S]*ref="passengerPad"[\s\S]*<SignaturePad[\s\S]*ref="driverPad"/.test(templateOf(S.modal)))
  const submit = fnBody(script, 'submit')
  const firstAwait = submit.indexOf('await ')
  c.ok('§5 Submit pins its state object before the first await', firstAwait > 0 && submit.indexOf('const s = state.value') >= 0 && submit.indexOf('const s = state.value') < firstAwait)
  c.ok('§5 ...and never reads the live one after it', !submit.slice(firstAwait).includes('state.value'))
  c.ok('§5 ...and takes both images before it', submit.indexOf('toDataURL()') > 0 && submit.lastIndexOf('toDataURL()') < firstAwait)
}

// ── §6 the dates ─────────────────────────────────────────────────────────────
function datesSection(c, L, S) {
  c.eq('§6 the pickers\' bounds: start today to +90, end from the start to +365', L.dateBounds(TODAY, '2026-11-04'),
    { validFromMin: TODAY, validFromMax: '2027-01-31', expiresMin: '2026-11-04', expiresMax: '2027-11-04' })
  c.eq('§6 no start picked yet: the end is bounded from today', L.dateBounds(TODAY, ''), { validFromMin: TODAY, validFromMax: '2027-01-31', expiresMin: TODAY, expiresMax: '2027-11-02' })
  const code = (o) => L.checkDetails(adultForm(o), TODAY).code || 'ok'
  c.eq('§6 the start: today and +90 pass; yesterday and +91 do not', [code({ validFrom: TODAY }), code({ validFrom: '2027-01-31', expiresOn: '2027-01-31' }), code({ validFrom: '2026-11-01' }), code({ validFrom: '2027-02-01', expiresOn: '2027-02-02' })],
    ['ok', 'ok', 'DATES_INVALID', 'DATES_INVALID'])
  c.eq('§6 the end: the start day and +365 pass; the day before is invalid, +366 too long', [code({ expiresOn: TODAY }), code({ expiresOn: '2027-11-02' }), code({ expiresOn: '2026-11-01' }), code({ expiresOn: '2027-11-03' })],
    ['ok', 'ok', 'DATES_INVALID', 'EXPIRY_TOO_LONG'])
  c.eq('§6 a day that is not on the calendar, or not a bare day, is invalid', [code({ expiresOn: '2027-02-30' }), code({ expiresOn: '2026-11-9' }), code({ expiresOn: ' 2026-11-09' }), code({ expiresOn: '' }), code({ validFrom: '2026-11-02T00:00:00Z' })],
    ['DATES_INVALID', 'DATES_INVALID', 'DATES_INVALID', 'DATES_INVALID', 'DATES_INVALID'])
  c.eq('§6 no business day known: nothing passes', L.checkDetails(adultForm(), '').code, 'DATES_INVALID')
  c.eq('§6 isDay', [L.isDay('2028-02-29'), L.isDay('2027-02-29'), L.isDay('2026-13-01'), L.isDay(20261102), L.isDay(null)], [true, false, false, false, false])
  c.ok('§6 the form\'s today is the business day (appToday()), never the phone\'s', /import \{ appToday \} from '..\/..\/utils\/datetime'/.test(scriptOf(S.modal)) && !/new Date\(/.test(scriptOf(S.modal)))
  c.ok('§6 the pickers use the bounds', /type="date" :min="bounds\.validFromMin" :max="bounds\.validFromMax"/.test(S.modal) && /type="date" :min="bounds\.expiresMin" :max="bounds\.expiresMax"/.test(S.modal))
}

// ── §7 the details checks ────────────────────────────────────────────────────
function detailsSection(c, L) {
  const code = (s) => L.checkDetails(s, TODAY).code || 'ok'
  c.eq('§7 a complete adult and a complete minor pass', [code(adultForm()), code(minorForm())], ['ok', 'ok'])
  c.eq('§7 the passenger\'s name: 2 to 100 characters after clean-up', [code(adultForm({ passengerName: 'J' })), code(adultForm({ passengerName: 'Jo' })), code(adultForm({ passengerName: 'J'.repeat(100) })), code(adultForm({ passengerName: 'J'.repeat(101) })), code(adultForm({ passengerName: '   ' }))],
    ['PASSENGER_NAME_REQUIRED', 'ok', 'ok', 'PASSENGER_NAME_REQUIRED', 'PASSENGER_NAME_REQUIRED'])
  const [NUL, ZWSP, RLO] = [0x00, 0x200b, 0x202e].map((n) => String.fromCharCode(n))
  c.eq('§7 control, zero-width and direction characters do not count toward a name', [code(adultForm({ passengerName: `${ZWSP}J${ZWSP}` })), code(adultForm({ passengerName: `${NUL}J${RLO}` })), L.cleanLength(` Jane${ZWSP} Example\n`, 100)],
    ['PASSENGER_NAME_REQUIRED', 'PASSENGER_NAME_REQUIRED', 12])
  c.eq('§7 runs of spaces count once, as the server reads them', [L.cleanLength('Jane     Example', 100), code(adultForm({ passengerName: `${'J'.repeat(50)}   ${'E'.repeat(49)}` }))], [12, 'ok'])
  c.eq('§7 anything over 8 x the limit is refused unread', [L.cleanLength(' '.repeat(801), 100), code(adultForm({ passengerName: `Jane${' x'.repeat(400)}` })), L.cleanLength(7, 100)], [Infinity, 'PASSENGER_NAME_REQUIRED', 0])
  c.eq('§7 a field is judged as sent, trimmed', [code(adultForm({ passengerName: `Jane${' '.repeat(800)}` })), code(adultForm({ truckUnit: `  T-0000${' '.repeat(30)}` }))], ['ok', 'ok'])
  c.eq('§7 the age: a real yes or no', [code(adultForm({ passengerAdult: null })), code(adultForm({ passengerAdult: 'true' })), code(adultForm({ passengerAdult: 1 }))],
    ['PASSENGER_AGE_REQUIRED', 'PASSENGER_AGE_REQUIRED', 'PASSENGER_AGE_REQUIRED'])
  c.eq('§7 a minor needs the guardian\'s name (2-100) and relationship (2-40)', [code(minorForm({ guardianName: '' })), code(minorForm({ guardianRelationship: 'P' })), code(minorForm({ guardianRelationship: 'P'.repeat(41) })), code(minorForm({ guardianRelationship: 'P'.repeat(40) }))],
    ['GUARDIAN_REQUIRED', 'GUARDIAN_REQUIRED', 'GUARDIAN_REQUIRED', 'ok'])
  c.eq('§7 ...and the box, ticked for real', [code(minorForm({ minorAttested: false })), code(minorForm({ minorAttested: 'true' }))], ['MINOR_ATTESTATION_REQUIRED', 'MINOR_ATTESTATION_REQUIRED'])
  c.eq('§7 an adult needs neither', code(adultForm({ guardianName: '', guardianRelationship: '', minorAttested: false })), 'ok')
  c.eq('§7 both ends of the trip, 2 to 120 each', [code(adultForm({ tripStart: '' })), code(adultForm({ tripEnd: 'D' })), code(adultForm({ tripEnd: 'D'.repeat(121) })), code(adultForm({ tripEnd: 'D'.repeat(120) }))],
    ['TRIP_POINTS_REQUIRED', 'TRIP_POINTS_REQUIRED', 'TRIP_POINTS_REQUIRED', 'ok'])
  c.eq('§7 the truck unit: required (the form never reads AUTHORIZED without it), at most 20', [code(adultForm({ truckUnit: '' })), code(adultForm({ truckUnit: '   ' })), code(adultForm({ truckUnit: 'T'.repeat(21) })), code(adultForm({ truckUnit: 'T'.repeat(20) }))],
    ['TRUCK_UNIT_REQUIRED', 'TRUCK_UNIT_REQUIRED', 'TRUCK_UNIT_TOO_LONG', 'ok'])
  c.eq('§7 the server\'s order: name, age, guardian, truck, trip, dates', [code(adultForm({ passengerName: '', passengerAdult: null, tripStart: '' })), code(adultForm({ passengerAdult: null, truckUnit: '' })),
    code(minorForm({ minorAttested: false, truckUnit: '' })), code(adultForm({ truckUnit: '', tripStart: '' })), code(adultForm({ tripStart: '', expiresOn: '' }))],
  ['PASSENGER_NAME_REQUIRED', 'PASSENGER_AGE_REQUIRED', 'MINOR_ATTESTATION_REQUIRED', 'TRUCK_UNIT_REQUIRED', 'TRIP_POINTS_REQUIRED'])
  const r = L.checkDetails(adultForm({ tripEnd: '' }), TODAY)
  c.eq('§7 a refusal names its field and its words', [r.ok, r.field, r.error], [false, 'trip', 'Enter where the trip starts and where it ends.'])
  c.eq('§7 no state: refused', L.checkDetails(null, TODAY).ok, false)
}

// ── §8 the words ─────────────────────────────────────────────────────────────
function wordsSection(c, L) {
  const err = (status, code = '') => Object.assign(new Error('x'), { status, code })
  for (const code of L.SERVER_REFUSAL_CODES) {
    c.ok(`§8 ${code} has words of its own`, typeof L.MESSAGES[code] === 'string' && L.MESSAGES[code].length > 10 && L.submitFailure(err(400, code)).text === L.MESSAGES[code])
  }
  c.eq('§8 a render failure (503): try again, everything kept', L.submitFailure(err(503, 'PDF_RENDER_FAILED')).text, 'The form couldn\'t be saved. What you entered and both signatures are kept: tap Submit to try again.')
  c.eq('§8 no answer: try again, everything kept', L.submitFailure(err(0)).text, 'Couldn\'t reach LogisX. What you entered and both signatures are kept: tap Submit to try again.')
  c.eq('§8 no answer in time: said so, everything kept', L.submitFailure(err(0, 'TIMEOUT')).text, 'LogisX took too long to answer. What you entered and both signatures are kept: tap Submit to try again.')
  c.eq('§8 the limiter, the session, anything else', [L.submitFailure(err(429)).text, L.submitFailure(err(401)).text, L.submitFailure(err(500)).text],
    [L.MESSAGES.TOO_MANY, L.MESSAGES.SESSION_ENDED, L.MESSAGES.SEND_FAILED])
  c.eq('§8 a code the server never sends is not shown as one', L.submitFailure(err(400, 'RETRY')).text, L.MESSAGES.SEND_FAILED)
  c.eq('§8 a refusal about a field names it', [L.submitFailure(err(400, 'DATES_INVALID')).field, L.submitFailure(err(409, 'TOO_MANY_OPEN')).field], ['dates', ''])
  c.eq('§8 no answer, or a 5xx, is a lost answer: the server may have filed it', [err(0), err(0, 'TIMEOUT'), err(500), err(502), err(503, 'RENDER_FAILED'), err(504)].map((e) => L.submitFailure(e).lost),
    [true, true, true, true, true, true])
  c.eq('§8 an answer that refuses is not lost', [err(400, 'DATES_INVALID'), err(409, 'TOO_MANY_OPEN'), err(429), err(401), err(403, 'SIGN_IN_AGAIN'), err(404, 'FEATURE_OFF'), err(413, 'IMAGE_TOO_LARGE')].map((e) => L.submitFailure(e).lost),
    [false, false, false, false, false, false, false])
  c.eq('§8 the list read', [L.readFailure(err(0)), L.readFailure(err(401)), L.readFailure(err(500))], [L.MESSAGES.OFFLINE_READ, L.MESSAGES.SESSION_ENDED, L.MESSAGES.READ_FAILED])
  c.ok('§8 no words name a passenger\'s age or a person', !/Example/.test(JSON.stringify(L.MESSAGES)))
}

// ── §9 parity ────────────────────────────────────────────────────────────────
function paritySection(c, L) {
  c.eq('§9 the age words are the ones the form prints', L.AGE_STATEMENT, { adult: TEXT.AGE_STATEMENT.adult, minor: TEXT.AGE_STATEMENT.minor })
  c.ok('§9 server.js\'s sanitizeEvidenceText() lifts', typeof sanitizeEvidenceText === 'function')
  if (typeof sanitizeEvidenceText === 'function') {
    const differ = []
    // The server's reading of a field limited to 10: cleaned, runs folded, trimmed.
    const serverLength = (s) => Array.from(String(sanitizeEvidenceText(s, 40)).replace(/\s+/g, ' ').trim()).length
    for (let n = 0; n <= 0x3000 && differ.length < 5; n++) {
      const word = `A${String.fromCharCode(n)}${String.fromCharCode(n)}B`
      if (L.cleanLength(word, 10) !== serverLength(word)) differ.push(n.toString(16))
    }
    const bom = `A${String.fromCharCode(0xfeff)}B`
    if (L.cleanLength(bom, 10) !== serverLength(bom)) differ.push('feff')
    c.eq('§9 every character up to U+3000 (and the BOM) is read as the server reads it', differ, [])
  }
  c.eq('§9 the server\'s limits', L.LIMITS, { NAME_MIN: 2, NAME_MAX: 100, RELATIONSHIP_MIN: 2, RELATIONSHIP_MAX: 40, TRIP_POINT_MIN: 2, TRIP_POINT_MAX: 120, TRUCK_UNIT_MAX: 20, START_WITHIN_DAYS: 90, EXPIRY_WITHIN_DAYS: 365 })
}

// ── §10 the feature gate ─────────────────────────────────────────────────────
function featureSection(c, L, S) {
  c.eq('§10 on only for a real true', [L.featureEnabled({ enabled: true }), L.featureEnabled({ enabled: 'true' }), L.featureEnabled({ enabled: 1 }), L.featureEnabled({}), L.featureEnabled(null), L.featureEnabled([true])],
    [true, false, false, false, false, false])
  const f = S.feature
  c.ok('§10 one read of the feature route per page', /const enabled = ref\(false\)\nlet known = false\nlet pending = null\n\nexport function usePassengerAuthorizationFeature/.test(f) && /api\.get\(FEATURE_URL\)/.test(f))
  c.ok('§10 ...decided by featureEnabled()', /enabled\.value = featureEnabled\(data\)/.test(f))
  const script = scriptOf(S.card)
  c.ok('§10 the card shows only for a Driver with the feature on', /const shown = computed\(\(\) => isDriver\.value && enabled\.value\)/.test(script) && /<section v-if="shown"/.test(templateOf(S.card)))
  c.ok('§10 ...and anyone else never asks the feature route', /const isDriver = computed\(\(\) => auth\.user\?\.role === 'Driver'\)/.test(script) && /const enabled = isDriver\.value \? usePassengerAuthorizationFeature\(api\) : ref\(false\)/.test(script))
  c.ok('§10 the list is read only while shown', /async function load\(\) \{\n {2}if \(!shown\.value\) return/.test(script))
}

// ── §11 DriverView.vue ───────────────────────────────────────────────────────
function viewSection(c, L, S) {
  const v = S.view
  const t = templateOf(v)
  c.eq('§11 two cards: the lock screen\'s and the Kit\'s', count(t, '<PassengerAuthorizationsCard'), 2)
  const lock = t.indexOf('<PassengerAuthorizationsCard compact ')
  c.ok('§11 the lock screen\'s is compact, after Step 1 (and its contacts item), before the next steps', lock > t.indexOf('data-testid="ob-contacts"') && lock < t.indexOf('v-if="stepAccepted"') && lock < t.indexOf('<template v-else-if="initialLoadFailed">'))
  const kitAt = t.indexOf('<section v-if="currentTab === \'kit\'"')
  const kit = kitAt < 0 ? '' : t.slice(kitAt, t.indexOf('</section>', kitAt))
  const kitCard = kit.indexOf('<PassengerAuthorizationsCard ')
  c.ok('§11 the Kit\'s is the full card, outside the loading swap (a refresh never closes a form being signed)', kitCard > 0 && kitCard > kit.lastIndexOf('</template>') && !/<PassengerAuthorizationsCard compact/.test(kit))
  c.ok('§11 both get the driver\'s name and the truck prefill', count(t, ':driver-name="driverStore.driverName" :truck-unit="String(driverStore.truck?.unit_number ?? \'\')"') === 2)
  const lines = scriptOf(v).split('\n').filter((l) => /passenger/i.test(l))
  c.eq('§11 the script gains the import and nothing else: the step, its count and its percentage are untouched', lines, ["import PassengerAuthorizationsCard from '../components/driver/PassengerAuthorizationsCard.vue'"])
  c.ok('§11 the count stays the five documents and the contacts', /const signingStep = computed\(\(\) => signingStepView\(\{\n {2}status: driverStore\.onboarding\?\.status,\n {2}signed: signedCount\.value,\n {2}total: totalDocs\.value,\n {2}counts: driverStore\.emergencyContacts,\n\}\)\)/.test(v))
}

// ── §12 privacy ──────────────────────────────────────────────────────────────
function privacySection(c, L, S) {
  const store = new Map()
  const fake = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
  L.writeNotNow(fake, true)
  c.eq('§12 "Not now" keeps one flag, nothing else', [...store.entries()], [['logisx.passengerAuthorization.notNow', '1']])
  c.eq('§12 ...read back', L.readNotNow(fake), true)
  L.writeNotNow(fake, false)
  c.eq('§12 "Show" takes it away', [store.size, L.readNotNow(fake)], [0, false])
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
  c.eq('§12 a browser with storage off: the card stays open, nothing throws', [L.readNotNow(broken), L.writeNotNow(broken, true), L.readNotNow(null), L.writeNotNow(null, true)], [false, undefined, false, undefined])
  const card = scriptOf(S.card)
  c.ok('§12 the rows live in the card: a local ref, emptied on unmount, never the store', /const rows = ref\(\[\]\)/.test(card) && /onUnmounted\(\(\) => \{[\s\S]*rows\.value = \[\]/.test(card) && !/useDriverStore|stores\/driver/.test(card))
  c.ok('§12 the card touches the browser\'s storage only through the "Not now" flag', (card.match(/localStorage/g) || []).length === 1 && /function storage\(\) \{\n {2}try \{ return window\.localStorage \} catch \{ return null \}/.test(card) && !/setItem|getItem/.test(card))
  for (const k of ['modal', 'pad', 'feature']) c.ok(`§12 ${k}: no browser storage`, !storageRe.test(S[k]))
  c.ok('§12 the lib touches storage only through the one key', count(LIB_SRC_NOW(), 'setItem(') === 1 && /storage\.setItem\(NOT_NOW_KEY, '1'\)/.test(LIB_SRC_NOW()))
  for (const k of ['card', 'modal', 'pad', 'feature']) c.ok(`§12 ${k}: no console output and no v-html`, !/console\.|v-html/.test(S[k]))
  c.ok('§12 the lib: no console output', !/console\./.test(LIB_SRC_NOW()))
}
let LIB_SRC_NOW = () => LIB_SRC

// ── §13 SignaturePad.vue ─────────────────────────────────────────────────────
function padSection(c, L, S) {
  const t = templateOf(S.pad)
  const script = scriptOf(S.pad)
  c.ok('§13 a stroke ends on pointerup, pointerleave and pointercancel alike', /@pointerup="endDraw"\s+@pointerleave="endDraw"\s+@pointercancel="endDraw"/.test(t))
  c.ok('§13 the pointer is captured', /setPointerCapture\(e\.pointerId\)/.test(script))
  c.ok('§13 every end and every wipe clears the drawing gate', /function endDraw\(\) \{ isDrawing = false \}/.test(script) && /function reset\(\) \{\n {2}isDrawing = false/.test(script) && /watch\(\(\) => props\.disabled, \(off\) => \{ if \(off\) isDrawing = false \}\)/.test(script))
  c.ok('§13 a locked pad never starts or continues a stroke', /function startDraw\(e\) \{\n {2}if \(props\.disabled/.test(script) && /function draw\(e\) \{\n {2}if \(!isDrawing \|\| props\.disabled\) return/.test(script))
  c.ok('§13 the image is a PNG, and only once something was drawn', /return hasDrawn\.value && canvasRef\.value \? canvasRef\.value\.toDataURL\('image\/png'\) : null/.test(script))
  c.ok('§13 a tap without a stroke draws nothing: hasDrawn is set in draw() only', count(script, 'hasDrawn.value = true') === 1 && fnBody(script, 'draw').includes('hasDrawn.value = true'))
  c.ok('§13 the page does not scroll under a stroke', /touch-action: none/.test(S.pad))
  c.ok('§13 reset and toDataURL are the only ways in', /defineExpose\(\{ reset, toDataURL \}\)/.test(script))
}

// ── §14 the form ─────────────────────────────────────────────────────────────
function formSection(c, L, S) {
  const t = templateOf(S.modal)
  const script = scriptOf(S.modal)
  c.ok('§14 the form binds every field, box, pad and "Change details" to formControls()', /<fieldset class="pam-fields" :disabled="controls\.detailsLocked">/.test(t) &&
    /v-if="controls\.changeDetails"[^>]*@click="changeDetails"/.test(t) &&
    /v-model="state\.passengerAgreed" type="checkbox" :disabled="!controls\.passengerConsent"/.test(t) && /ref="passengerPad"[\s\S]*?:disabled="!controls\.passengerPad"/.test(t) &&
    /v-model="state\.driverAgreed" type="checkbox" :disabled="!controls\.driverConsent"/.test(t) && /ref="driverPad"[\s\S]*?:disabled="!controls\.driverPad"/.test(t) &&
    /\{\{ controls\.submitLabel \}\}/.test(t) && /const controls = computed\(\(\) => formControls\(state\.value, today\.value\)\)/.test(script))
  c.ok('§14 a lost answer freezes the form it was sent from', /catch \(err\) \{\n {4}const failure = submitFailure\(err\)\n {4}s\.error = failure\.text\n {4}if \(failure\.lost\) s\.pending = true\n {2}\}/.test(fnBody(script, 'submit')))
  c.ok('§14 ...until the form is sent or closed: nothing else clears it', count(script, 'pending') === 1 && /<p v-if="state\.pending" [^>]*>\{\{ MESSAGES\.PENDING \}\}<\/p>/.test(t))
  // What may move, from formControls(): [detailsLocked, changeDetails, passengerConsent, passengerPad, driverConsent, driverPad, submitLabel].
  const ctl = (o, today = TODAY) => { const v = L.formControls({ ...adultForm(), ...o }, today); return [v.detailsLocked, v.changeDetails, v.passengerConsent, v.passengerPad, v.driverConsent, v.driverPad, v.submitLabel] }
  c.eq('§14 details incomplete: nothing to sign yet', ctl({ tripEnd: '' }), [false, false, false, false, false, false, 'Submit'])
  c.eq('§14 the passenger\'s box waits for complete details, the pad for the box', [ctl({}), ctl({ passengerAgreed: true })],
    [[false, false, true, false, false, false, 'Submit'], [false, false, true, true, false, false, 'Submit']])
  c.eq('§14 the driver signs after the passenger: his box once the passenger has ticked and signed, his pad once he ticks',
    [ctl({ passengerAgreed: true, passengerSigned: true }), ctl({ passengerAgreed: true, passengerSigned: true, driverAgreed: true }), ctl({ passengerSigned: true })],
    [[true, true, true, true, true, false, 'Submit'], [true, true, true, true, true, true, 'Submit'], [true, true, true, false, false, false, 'Submit']])
  c.eq('§14 the details lock once either side has signed, and "Change details" is offered', [ctl({ driverSigned: true }).slice(0, 2), ctl({ passengerSigned: true }).slice(0, 2)], [[true, true], [true, true]])
  c.eq('§14 while Submit is out nothing moves', ctl({ ...signed({}), submitting: true }), [true, false, false, false, false, false, 'Sending…'])
  c.eq('§14 after a lost answer nothing that changes what was sent can move: only Submit again', ctl({ ...signed({}), pending: true }), [true, false, false, false, false, false, 'Submit again'])
  c.eq('§14 ...and Submit again is the same request, on', L.canSubmit({ ...signed(adultForm()), pending: true }, TODAY), true)
  const repass = fnBody(script, 'passengerPadChanged')
  c.ok('§14 the driver signs last: a passenger signature cleared takes the driver\'s with it', /ref="passengerPad"[\s\S]*?@change="passengerPadChanged"/.test(t) &&
    /state\.value\.passengerSigned = drawn\n {2}if \(drawn\) return\n {2}driverPad\.value\?\.reset\(\)\n {2}Object\.assign\(state\.value, \{ driverAgreed: false, driverSigned: false \}\)/.test(repass))
  const change = fnBody(script, 'changeDetails')
  c.ok('§14 changing them wipes both signatures and both boxes', /passengerPad\.value\?\.reset\(\)/.test(change) && /driverPad\.value\?\.reset\(\)/.test(change) && /passengerAgreed: false, passengerSigned: false, driverAgreed: false, driverSigned: false/.test(change))
  c.ok('§14 Submit is on only when canSubmit() says so, and checks again on the press', /:disabled="!ready"/.test(t) && /const ready = computed\(\(\) => canSubmit\(state\.value, today\.value\)\)/.test(script) && /if \(!canSubmit\(s, today\.value\)\) return/.test(fnBody(script, 'submit')))
  c.ok('§14 one POST to the list route, with the long wait', /await api\.post\(LIST_URL, body, \{ timeout: SUBMIT_TIMEOUT_MS \}\)/.test(script))
  c.ok('§14 the close waits while sending', /class="pam-close" aria-label="Close" data-testid="pa-close" :disabled="state\.submitting"/.test(t))
  c.ok('§14 the done screen says it is not valid yet', /Sent to LogisX for signature\./.test(t) && /Not valid until the company signs\./.test(t))
  c.ok('§14 the consent words are the shared constant', count(t, '{{ SIGNING_CONSENT_TEXT }}') === 2)
  c.ok('§14 the form sits on the page body (no parent clips it); only its body scrolls', /<Teleport to="body">/.test(t) && /\.pam-body \{ flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;/.test(S.modal))
  const ready = (o) => L.canSubmit({ ...signed(adultForm()), ...o }, TODAY)
  c.eq('§14 canSubmit: all done', ready({}), true)
  c.eq('§14 canSubmit: any part missing', [ready({ passengerAgreed: false }), ready({ passengerSigned: false }), ready({ driverAgreed: false }), ready({ driverSigned: false }),
    ready({ submitting: true }), ready({ requestId: '' }), ready({ requestId: 'not-a-uuid' }), ready({ tripEnd: '' }), ready({ passengerAgreed: 'true' })],
  [false, false, false, false, false, false, false, false, false])
}

// ── §15 the summary ──────────────────────────────────────────────────────────
function summarySection(c, L) {
  c.eq('§15 an adult: what prints, in the form\'s order', L.summaryLines(adultForm(), 'Casey Example'), [
    { label: 'Passenger', value: 'Jane Example' }, { label: 'Passenger\'s age', value: TEXT.AGE_STATEMENT.adult },
    { label: 'Driver (the only driver)', value: 'Casey Example' }, { label: 'Truck unit', value: 'T-0000' },
    { label: 'Trip starts at', value: 'Houston, TX' }, { label: 'Trip ends at', value: 'Dallas, TX' },
    { label: 'Valid from', value: 'Nov 2, 2026' }, { label: 'Expires', value: '11:59 p.m. on Nov 9, 2026' },
  ])
  const minor = L.summaryLines(minorForm(), 'Casey Example')
  c.eq('§15 a minor: the age words and the guardian line', [minor[1].value, minor[2]], [TEXT.AGE_STATEMENT.minor, { label: 'Parent or guardian', value: 'Pat Example, Parent' }])
  c.eq('§15 who signs for the passenger', [L.signerName(adultForm()), L.signerName(minorForm()), L.signerName(adultForm({ passengerAdult: null })), L.signerName(null)], ['Jane Example', 'Pat Example', '', ''])
}

// ── §16 compile ──────────────────────────────────────────────────────────────
function compileSection(c) {
  let sfc = null
  try { sfc = createRequire(path.join(CLIENT, 'package.json'))('vue/compiler-sfc') } catch { sfc = null }
  if (!sfc) { c.eq('§16 the client\'s compiler is installed (npm install)', false, true); return }
  for (const k of ['card', 'modal', 'pad', 'view']) {
    const { descriptor, errors } = sfc.parse(S0[k], { filename: FILES[k] })
    let problems = errors.map((e) => String(e.message || e))
    if (!problems.length) {
      try {
        const script = sfc.compileScript(descriptor, { id: k, inlineTemplate: true })
        if (!script.content) problems.push('no script output')
      } catch (err) { problems.push(err.message) }
    }
    c.eq(`§16 ${path.basename(FILES[k])} compiles`, problems, [])
  }
}

const SECTIONS = {
  routes: ['§1 the routes and the live event', routesSection],
  status: ['§2 the words for each status', statusSection],
  body: ['§3 the body sent', bodySection],
  requestId: ['§4 the request id', requestIdSection],
  blank: ['§5 the blank state', blankSection],
  dates: ['§6 the dates', datesSection],
  details: ['§7 the details checks', detailsSection],
  words: ['§8 every refusal in plain words', wordsSection],
  parity: ['§9 parity with the form and the server', paritySection],
  feature: ['§10 the feature gate', featureSection],
  view: ['§11 DriverView.vue', viewSection],
  privacy: ['§12 privacy', privacySection],
  pad: ['§13 SignaturePad.vue', padSection],
  form: ['§14 the form', formSection],
  summary: ['§15 the summary', summarySection],
}
function runSections(c, L, S, names) {
  blank = () => L.blankState()
  for (const n of names) {
    const [label, fn] = SECTIONS[n]
    section(c, label, () => fn(c, L, S))
  }
}

// ── the run ──────────────────────────────────────────────────────────────────
const missing = [LIB, ...Object.values(FILES)].filter((p) => !fs.existsSync(p))
if (missing.length) {
  for (const p of missing) MAIN.eq(`${path.relative(ROOT, p)} exists`, false, true)
} else {
  const lib = await import(pathToFileURL(LIB).href)
  for (const n of Object.keys(SECTIONS)) {
    console.log(`\n${SECTIONS[n][0]}`)
    runSections(MAIN, lib, S0, [n])
  }
  if (fs.existsSync(SERVER_LIB)) {
    console.log('\n§9 parity with lib/passenger-authorization.js')
    section(MAIN, '§9 server', () => serverParity(MAIN, lib, require(SERVER_LIB)))
  }
  console.log('\n§16 the new components compile')
  compileSection(MAIN)

  // ── §17 mutants ────────────────────────────────────────────────────────────
  console.log('\n§17 mutants')
  const once = (src, from, to) => {
    const n = src.split(from).length - 1
    if (n !== 1) throw new Error(`target found ${n}x (expected 1): ${from.slice(0, 70)}`)
    return src.replace(from, () => to)
  }
  // A data: module resolves no relative import, so the lib's two point at the real files.
  const importable = (src) => src
    .replace("from '../utils/datetime.js'", `from '${pathToFileURL(DATETIME).href}'`)
    .replace("from './signingConsent.js'", `from '${pathToFileURL(CONSENT).href}'`)
  async function mutant(id, label, build, names) {
    let L = lib
    let S = S0
    let libSrc = LIB_SRC
    try {
      const made = build()
      if (made.lib !== undefined) { libSrc = made.lib; L = await import(`data:text/javascript,${encodeURIComponent(importable(made.lib))}`) }
      if (made.files) S = { ...S0, ...made.files }
    } catch (err) {
      MAIN.eq(`§17 ${id}: ${label}: the mutation applies`, err.message, 'applies')
      return
    }
    const c = checker(false)
    LIB_SRC_NOW = () => libSrc
    runSections(c, L, S, names)
    LIB_SRC_NOW = () => LIB_SRC
    MAIN.eq(`§17 ${id}: ${label}: is caught`, c.failed.length > 0 ? 'caught' : 'not caught', 'caught')
  }
  const libMut = (from, to) => () => ({ lib: once(LIB_SRC, from, to) })
  const fileMut = (key, from, to) => () => ({ files: { [key]: once(S0[key], from, to) } })

  await mutant('M1', 'a missing age answer sent as "under 18"', libMut('if (!isPlainObject(s) || (s.passengerAdult !== true && s.passengerAdult !== false)) return null', 'if (!isPlainObject(s)) return null'), ['body'])
  await mutant('M2', 'an adult\'s form sending the guardian typed earlier', libMut("guardianName: adult ? '' : text(s.guardianName),", 'guardianName: text(s.guardianName),'), ['body'])
  await mutant('M3', 'the minor\'s box ticked by any truthy value', libMut('minorAttested: adult ? false : s.minorAttested === true,', 'minorAttested: adult ? false : !!s.minorAttested,'), ['body'])
  await mutant('M4', 'the passenger\'s consent sent as agreed whatever was ticked', libMut('passengerConsent: buildConsent(s.passengerAgreed),', 'passengerConsent: buildConsent(true),'), ['body'])
  await mutant('M5', 'a status the phone doesn\'t know shown as waiting', libMut("default: return { key: 'unknown', text: 'Not valid', tone: 'ended' }", "default: return { key: 'unknown', text: 'Waiting for company signature', tone: 'wait' }"), ['status'])
  await mutant('M6', 'the feature on for any truthy answer', libMut('return isPlainObject(answer) && answer.enabled === true', 'return isPlainObject(answer) && !!answer.enabled'), ['feature'])
  await mutant('M7', 'a PDF link for any id', libMut('return Number.isSafeInteger(id) && id > 0 ? `/api/passenger-authorizations/${id}/pdf` : null', 'return id != null ? `/api/passenger-authorizations/${id}/pdf` : null'), ['routes'])
  await mutant('M8', 'a start 91 days on accepted', libMut('s.validFrom > shiftYmd(today, LIMITS.START_WITHIN_DAYS)', 's.validFrom > shiftYmd(today, LIMITS.START_WITHIN_DAYS + 1)'), ['dates'])
  await mutant('M9', 'an end more than a year after the start accepted', libMut("  if (s.expiresOn > shiftYmd(s.validFrom, LIMITS.EXPIRY_WITHIN_DAYS)) return no('EXPIRY_TOO_LONG')\n", ''), ['dates'])
  await mutant('M10', 'a start in the past accepted', libMut('if (s.validFrom < today || s.validFrom >', 'if (s.validFrom >'), ['dates'])
  await mutant('M11', 'a day off the calendar taken for a day', libMut("return typeof v === 'string' && v !== '' && shiftYmd(v, 0) === v", "return typeof v === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(v)"), ['dates'])
  await mutant('M12', 'the truck unit optional', libMut("  if (unit === 0) return no('TRUCK_UNIT_REQUIRED')\n", ''), ['details'])
  await mutant('M13', 'names counted before the server\'s clean-up', libMut("const kept = Array.from(v.normalize('NFC').replace(STRIP_RE, ' ').trim())", 'const kept = Array.from(v.trim())'), ['details'])
  await mutant('M38', 'runs of spaces counted one by one', libMut("return Array.from(kept.replace(/\\s+/g, ' ').trim()).length", 'return Array.from(kept.trim()).length'), ['details'])
  await mutant('M39', 'a huge paste walked instead of refused', libMut('  if (v.length > max * 8) return Infinity\n', ''), ['details'])
  await mutant('M40', 'a field judged before the trim it is sent with', libMut('  const n = cleanLength(text(v), max)\n', '  const n = cleanLength(typeof v === \'string\' ? v : \'\', max)\n'), ['details'])
  await mutant('M14', '"Not now" throwing when storage is off', libMut('  try {\n    if (!storage) return\n    if (on) storage.setItem(NOT_NOW_KEY, \'1\')\n    else storage.removeItem(NOT_NOW_KEY)\n  } catch { /* private mode or storage off: the card just stays open */ }',
    '  if (!storage) return\n  if (on) storage.setItem(NOT_NOW_KEY, \'1\')\n  else storage.removeItem(NOT_NOW_KEY)'), ['privacy'])
  await mutant('M15', 'a fallback id that is not a v4 UUID', libMut('    b[6] = (b[6] & 0x0f) | 0x40\n', ''), ['requestId'])
  await mutant('M16', 'the form keeping its state after a close', fileMut('modal', "state.value = open ? blankState({ requestId: newRequestId(), today: today.value, truckUnit: props.truckUnit }) : blankState()",
    'if (open) state.value = blankState({ requestId: newRequestId(), today: today.value, truckUnit: props.truckUnit })'), ['blank'])
  await mutant('M17', 'a new request id on each Submit (a repeat files twice)', fileMut('modal', '  s.submitting = true\n', '  s.requestId = newRequestId()\n  s.submitting = true\n'), ['requestId'])
  await mutant('M18', 'a late answer written to the next opening\'s form', fileMut('modal', '    s.error = failure.text\n', '    state.value.error = failure.text\n'), ['blank'])
  await mutant('M19', 'the Kit card inside the loading swap', () => {
    const tag = '        <!-- Passenger authorizations: outside the loading swap too, so a refresh never closes a form being signed -->\n        <PassengerAuthorizationsCard :driver-name="driverStore.driverName" :truck-unit="String(driverStore.truck?.unit_number ?? \'\')" />\n'
    const out = once(S0.view, tag, '')
    // Anchored on the last card inside the loading template (the time-off card's close).
    const inside = '            @message-dispatch="handleTabSwitch(\'messages\')"\n          />\n'
    return { files: { view: once(out, inside, `${inside}${tag}`) } }
  }, ['view'])
  await mutant('M20', 'the card for any role', fileMut('card', 'const shown = computed(() => isDriver.value && enabled.value)', 'const shown = computed(() => enabled.value)'), ['feature'])
  await mutant('M21', 'the rows kept in the driver store', fileMut('card', 'const rows = ref([])', 'const rows = ref(useDriverStore().passengerRows || [])'), ['privacy'])
  await mutant('M22', 'a stroke the browser cancels never ending', fileMut('pad', '      @pointercancel="endDraw"\n', ''), ['pad'])
  await mutant('M23', 'a wipe leaving the drawing gate open', fileMut('pad', 'function reset() {\n  isDrawing = false\n', 'function reset() {\n'), ['pad'])
  await mutant('M24', 'a locked pad still drawing', fileMut('pad', 'if (!isDrawing || props.disabled) return', 'if (!isDrawing) return'), ['pad'])
  await mutant('M25', 'the driver signing before the passenger', libMut('    driverConsent: !frozen && passengerDone,\n', '    driverConsent: !frozen,\n'), ['form'])
  await mutant('M26', 'Submit without the driver\'s consent', libMut('s.passengerSigned === true &&\n    s.driverAgreed === true && s.driverSigned === true', 's.passengerSigned === true &&\n    s.driverSigned === true'), ['form'])
  await mutant('M27', 'a row without an id listed', libMut('return rows.map(rowView).filter(Boolean)', 'return rows.map((r) => rowView(r) || { id: 0, status: statusView(r) })'), ['status', 'privacy', 'view'])
  await mutant('M28', 'the feature route asked for anyone previewing the driver app', fileMut('card', 'const enabled = isDriver.value ? usePassengerAuthorizationFeature(api) : ref(false)', 'const enabled = usePassengerAuthorizationFeature(api)'), ['feature'])
  await mutant('M29', 'the create call on the 20 s default', fileMut('modal', 'await api.post(LIST_URL, body, { timeout: SUBMIT_TIMEOUT_MS })', 'await api.post(LIST_URL, body)'), ['form'])
  await mutant('M30', 'a render failure read as final', libMut('if (status === 503) return { text: MESSAGES.RETRY, field: \'\', lost }', 'if (status === 503) return { text: MESSAGES.SEND_FAILED, field: \'\', lost }'), ['words'])
  await mutant('M31', 'changing details leaving the passenger\'s signature', fileMut('modal', '  passengerPad.value?.reset()\n', ''), ['form'])
  await mutant('M32', 'the details editable after signing', libMut('    detailsLocked: frozen || signed,\n', '    detailsLocked: frozen,\n'), ['form'])
  await mutant('M33', 'the lock-screen card counted in the step', fileMut('view', '  counts: driverStore.emergencyContacts,\n})', '  counts: driverStore.emergencyContacts,\n  passengerCard: true,\n})'), ['view'])
  await mutant('M34', 'the age words drifting from the form\'s', libMut("adult: '18 or older',", "adult: '18 or over',"), ['parity', 'summary'])
  await mutant('M35', 'a list row\'s minor flag read loosely', libMut('minor: raw.passengerAdult === false,', 'minor: !raw.passengerAdult,'), ['status'])
  await mutant('M36', 'the passenger re-signing after the driver, the driver\'s signature kept', fileMut('modal', '  if (drawn) return\n  driverPad.value?.reset()\n', '  if (drawn) return\n'), ['form'])
  await mutant('M37', 'a timeout told as no signal', libMut("text: code === 'TIMEOUT' ? MESSAGES.SLOW : MESSAGES.OFFLINE", 'text: MESSAGES.OFFLINE'), ['words'])
  await mutant('M41', 'a lost answer leaving the form editable (the fix round 1 Medium)', fileMut('modal', '    if (failure.lost) s.pending = true\n', ''), ['form'])
  await mutant('M42', '"Change details" offered after a lost answer', libMut('    changeDetails: !frozen && signed,\n', '    changeDetails: signed,\n'), ['form'])
  await mutant('M43', 'the pads live after a lost answer (Clear and re-sign, same id)', libMut('    passengerPad: !frozen && detailsOk && st.passengerAgreed === true,\n', '    passengerPad: detailsOk && st.passengerAgreed === true,\n'), ['form'])
  await mutant('M44', 'a gateway 5xx not taken for a lost answer', libMut('  const lost = !status || status >= 500\n', '  const lost = !status\n'), ['words'])
  await mutant('M45', 'a refusal taken for a lost answer', libMut('  const lost = !status || status >= 500\n', '  const lost = !status || status >= 400\n'), ['words'])
  await mutant('M46', 'the form unfrozen by a later failure', fileMut('modal', '    if (failure.lost) s.pending = true\n', '    s.pending = failure.lost\n'), ['form'])
}

// Once lib/passenger-authorization.js exists: the screens' rules are the server's.
// The server's own validator reads the body the phone builds from each form.
function serverParity(c, L, srv) {
  const S = srv.LIMITS
  c.eq('§9 the limits are the server\'s', L.LIMITS, {
    NAME_MIN: S.nameMin, NAME_MAX: S.passengerNameMax, RELATIONSHIP_MIN: S.nameMin, RELATIONSHIP_MAX: S.relationshipMax,
    TRIP_POINT_MIN: S.nameMin, TRIP_POINT_MAX: S.tripPointMax, TRUCK_UNIT_MAX: S.truckUnitMax, START_WITHIN_DAYS: S.validFromMaxDays, EXPIRY_WITHIN_DAYS: S.expiryMaxDays,
  })
  c.eq('§9 a guardian\'s name has the passenger\'s limit', S.guardianNameMax, S.passengerNameMax)
  // The company's routes are the admin page's; these the phone answers by status.
  const ADMIN_ONLY = ['PRINTED_NAME_REQUIRED', 'TITLE_REQUIRED', 'REASON_REQUIRED', 'ALREADY_DECIDED', 'AUTHORIZATION_EXPIRED', 'AUTHORIZATION_INCOMPLETE', 'NOT_REVOCABLE', 'VIEW_INVALID']
  const BY_STATUS = ['RENDER_FAILED', 'RATE_LIMITED', 'FAILED', 'NOT_FOUND', 'PDF_UNAVAILABLE']
  c.eq('§9 every code the driver\'s routes can send has words on the phone', Object.keys(srv.MESSAGES).filter((k) => !ADMIN_ONLY.includes(k) && !BY_STATUS.includes(k) && !L.SERVER_REFUSAL_CODES.includes(k)), [])
  c.eq('§9 the request id shape is the server\'s', String(L.REQUEST_ID_RE), String(srv.REQUEST_ID_RE))
  // A list row carries the public columns, camel-cased, and displayStatus: each line the card shows is filled from them.
  const served = Object.fromEntries(srv.PUBLIC_COLUMNS.map((col) => [col.replace(/_([a-z0-9])/g, (m, ch) => ch.toUpperCase()), col]))
  const sample = { displayStatus: 'active' }
  for (const [key, col] of Object.entries(served)) {
    sample[key] = col === 'id' ? 5 : col === 'passenger_adult' ? false : /^(valid_from|expires_on)$/.test(col) ? '2026-11-09' : `x-${col}`
  }
  const view = L.rowView(sample)
  c.eq('§9 every line of a card row is filled from what the list answers', view && Object.entries(view).filter(([, v]) => v === '' || v === null).map(([k]) => k), [])
  c.eq('§9 ...and the minor flag and the status come through', view && [view.minor, view.status.key], [true, 'active'])
  c.ok('§9 server.js\'s sanitizeEvidenceText() lifts for the validator', typeof sanitizeEvidenceText === 'function')
  if (typeof sanitizeEvidenceText !== 'function') return
  const [ZWSP, NBSP] = [0x200b, 0xa0].map((n) => String.fromCharCode(n))
  const cases = [
    ['an adult', adultForm()], ['a minor', minorForm()],
    ['a one-letter name', adultForm({ passengerName: 'J' })], ['a 100-letter name', adultForm({ passengerName: 'J'.repeat(100) })],
    ['a 101-letter name', adultForm({ passengerName: 'J'.repeat(101) })], ['a name of spaces', adultForm({ passengerName: '    ' })],
    ['a name padded with zero-width spaces', adultForm({ passengerName: `${ZWSP}J${ZWSP}` })], ['a name with runs of spaces at the limit', adultForm({ passengerName: `${'J'.repeat(50)}   ${'E'.repeat(49)}` })],
    ['a name with no-break spaces', adultForm({ passengerName: `Jane${NBSP}${NBSP}Example` })], ['a name padded with 800 spaces', adultForm({ passengerName: `Jane${' '.repeat(800)}` })],
    ['an 804-character paste', adultForm({ passengerName: `Jane${' x'.repeat(400)}` })], ['a truck unit padded with spaces', adultForm({ truckUnit: `  T-0000${' '.repeat(30)}` })],
    ['no age answer', adultForm({ passengerAdult: null })], ['a minor without a guardian', minorForm({ guardianName: '' })],
    ['a one-letter relationship', minorForm({ guardianRelationship: 'P' })], ['a 41-letter relationship', minorForm({ guardianRelationship: 'P'.repeat(41) })],
    ['a minor without the box', minorForm({ minorAttested: false })], ['no trip start', adultForm({ tripStart: '' })],
    ['a 121-letter trip end', adultForm({ tripEnd: 'D'.repeat(121) })], ['no truck unit', adultForm({ truckUnit: '' })],
    ['a truck unit of spaces', adultForm({ truckUnit: '   ' })], ['a 21-letter truck unit', adultForm({ truckUnit: 'T'.repeat(21) })],
    ['a start yesterday', adultForm({ validFrom: '2026-11-01' })], ['a start at +90', adultForm({ validFrom: '2027-01-31', expiresOn: '2027-01-31' })],
    ['a start at +91', adultForm({ validFrom: '2027-02-01', expiresOn: '2027-02-02' })], ['an end before the start', adultForm({ expiresOn: '2026-11-01' })],
    ['an end at +365', adultForm({ expiresOn: '2027-11-02' })], ['an end at +366', adultForm({ expiresOn: '2027-11-03' })],
    ['an end off the calendar', adultForm({ expiresOn: '2027-02-30' })], ['no end', adultForm({ expiresOn: '' })],
    ['no truck unit and no trip start', adultForm({ truckUnit: '', tripStart: '' })], ['a minor without the box or a truck unit', minorForm({ minorAttested: false, truckUnit: '' })],
    ['no trip start and no end date', adultForm({ tripStart: '', expiresOn: '' })],
  ]
  for (const [label, s] of cases) {
    const phone = L.checkDetails(s, TODAY).code || 'ok'
    const body = L.buildSubmission(signed(s), { passenger: IMG_P, driver: IMG_D })
    const server = srv.validateSubmission(body || { requestId: s.requestId, passengerAdult: s.passengerAdult, passengerName: s.passengerName }, { todayKey: TODAY, cleanText: sanitizeEvidenceText })
    c.eq(`§9 ${label}: the phone and the server's validator agree`, phone, server.ok ? 'ok' : server.code)
  }
  const shown = new Set()
  for (const status of ['awaiting_company', 'authorized', 'declined', 'revoked', 'unheard-of']) {
    for (const [from, until] of [['2026-11-01', '2026-11-01'], ['2026-11-02', '2026-11-09'], ['2026-11-03', '2026-11-09']]) {
      shown.add(srv.statusOf({ status, valid_from: from, expires_on: until }, TODAY))
    }
  }
  const words = [...shown].sort().map((d) => [d, L.statusView({ displayStatus: d, validFrom: TODAY, expiresOn: '2026-11-09' }).key])
  c.eq('§9 the phone has words for every status the server shows', words, [...shown].sort().map((d) => [d, d]))
}

console.log(`\ntest-passenger-authorization-client: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
