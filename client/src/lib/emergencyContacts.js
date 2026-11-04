// A driver's emergency contacts on the phone. The checks are the server's own
// (lib/emergency-contacts.js), copied so the form answers at once and never sends
// what the server refuses; scripts/test-emergency-contacts-parity.mjs pins the two
// equal. The words, the form's rows and the onboarding item are the client's.
//
// Pure: no imports. Length caps run before any per-character walk, and every
// pattern tests one character.

export const MIN_CONTACTS = 2
export const MAX_CONTACTS = 5
export const CONTACT_NAME_MAX = 80
export const RELATIONSHIP_MAX = 40
export const PHONE_RAW_MAX = 32
export const BODY_MAX_ENTRIES = 20
export const RELATIONSHIP_SUGGESTIONS = Object.freeze(['Spouse', 'Partner', 'Parent', 'Child', 'Sibling', 'Relative', 'Friend', 'Other'])

// The driver's own list: the only route the phone reads or writes.
export const CONTACTS_URL = '/api/driver/me/emergency-contacts'

// The five documents the signing step needs, as server.js's ONBOARDING_DOCS lists
// them (scripts/test-emergency-contacts-client.mjs pins the two equal). A signed
// document under any other key never counts, as on the server.
export const ONBOARDING_DOC_KEYS = Object.freeze(['contractor_agreement', 'equipment_policy', 'w9', 'mobile_policy', 'substance_policy'])

// What the phone says for each refusal code, the server's and its own.
export const MESSAGES = Object.freeze({
  INVALID_BODY: 'This list could not be read. Close it and try again.',
  EMERGENCY_CONTACTS_MIN: 'Add at least two contacts.',
  EMERGENCY_CONTACTS_MAX: 'You can add up to five contacts.',
  CONTACT_NAME_INVALID: 'Enter the contact\'s name.',
  CONTACT_RELATIONSHIP_INVALID: 'Say how this person is related to you.',
  CONTACT_PHONE_INVALID: 'Enter a 10-digit US or Canadian number, or an international number starting with +.',
  CONTACT_PHONE_DUPLICATE: 'Each contact needs a different phone number.',
  CONTACT_NOT_FOUND: 'This list changed somewhere else. Open it again, then save your changes.',
  FEATURE_OFF: 'Emergency contacts aren\'t available right now.',
  DRIVER_ACCOUNT_REQUIRED: 'Only a driver can add emergency contacts here.',
  READ_FAILED: 'Your emergency contacts couldn\'t be loaded. Try again.',
  SAVE_FAILED: 'Your emergency contacts couldn\'t be saved. Try again.',
  TOO_MANY: 'Too many changes in a short time. Wait a few minutes, then try again.',
  OFFLINE: 'Couldn\'t reach LogisX. Check your signal and try again.',
  SESSION_ENDED: 'Your session ended. Sign in again.',
  NO_DRIVER_ACCOUNT: 'No driver account is linked to this directory row. Contacts are kept on the driver\'s sign-in account.',
  DRIVER_ACCOUNT_AMBIGUOUS: 'Two driver accounts match this name. Fix the names first.',
  DRIVER_NOT_FOUND: 'This driver is not in the Drivers directory.',
  INVALID_DRIVER_ID: 'This driver is not in the Drivers directory.',
})

// The office screens' words for a failed read or save: about the driver, not "your".
const STAFF_WORDS = Object.freeze({
  READ_FAILED: 'This driver\'s emergency contacts couldn\'t be loaded. Try again.',
  SAVE_FAILED: 'This driver\'s emergency contacts couldn\'t be saved. Try again.',
})

// One character each.
const WHITESPACE_RE = /^[\t\n\v\f\r\p{Zs}]$/u
const FORBIDDEN_RE = /^[\p{C}\p{Zl}\p{Zp}]$/u
const LETTER_RE = /^\p{L}$/u

// A name or relationship as stored: trimmed, each run of whitespace one space, no
// control, format or private-use character, at least one letter, and at most
// `max` characters as sent.
export function cleanContactText(raw, max) {
  if (typeof raw !== 'string' || raw.length > max) return { ok: false }
  let value = ''
  let space = false
  let letter = false
  for (const ch of raw) {
    if (WHITESPACE_RE.test(ch)) { space = value.length > 0; continue }
    if (FORBIDDEN_RE.test(ch)) return { ok: false }
    if (space) { value += ' '; space = false }
    value += ch
    if (!letter && LETTER_RE.test(ch)) letter = true
  }
  return value && letter ? { ok: true, value } : { ok: false }
}

// NXX: first digit 2-9, and not N11 (211, 311, ... 911 are service codes).
function nanpCodeOk(three) {
  return three[0] >= '2' && three[0] <= '9' && !(three[1] === '1' && three[2] === '1')
}

function nanpDisplay(ten) {
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`
}

// A phone number as stored (E.164) and as shown: ten digits, or 1 and ten, is a
// US or Canadian number; a + and another country code is 8 to 15 digits, the first
// not 0. Digits, spaces, - . ( ) and one leading +. No extensions.
export function normalizePhone(raw) {
  if (typeof raw !== 'string' || raw.length > PHONE_RAW_MAX) return { ok: false }
  const text = raw.trim()
  const plus = text.startsWith('+')
  let digits = ''
  for (const ch of plus ? text.slice(1) : text) {
    if (ch >= '0' && ch <= '9') digits += ch
    else if (ch !== ' ' && ch !== '-' && ch !== '.' && ch !== '(' && ch !== ')') return { ok: false }
  }
  let ten = null
  if (plus) {
    if (digits.startsWith('1')) {
      if (digits.length !== 11) return { ok: false }
      ten = digits.slice(1)
    } else {
      if (digits.length < 8 || digits.length > 15 || digits[0] === '0') return { ok: false }
      return { ok: true, e164: `+${digits}`, display: `+${digits}` }
    }
  } else if (digits.length === 10) {
    ten = digits
  } else if (digits.length === 11 && digits[0] === '1') {
    ten = digits.slice(1)
  } else {
    return { ok: false }
  }
  if (!nanpCodeOk(ten.slice(0, 3)) || !nanpCodeOk(ten.slice(3, 6))) return { ok: false }
  return { ok: true, e164: `+1${ten}`, display: nanpDisplay(ten) }
}

function refusal(status, code, index) {
  return { ok: false, status, code, ...(index === undefined ? {} : { index }), error: MESSAGES[code] }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// The server's check of a PUT body, in its order: the shape (400 INVALID_BODY),
// the count (422 _MIN / _MAX), then each entry's name, relationship and phone,
// and a number already in the list (422 with the entry's index).
export function validateContactList(body) {
  if (!isPlainObject(body) || !Array.isArray(body.contacts) || body.contacts.length > BODY_MAX_ENTRIES) {
    return refusal(400, 'INVALID_BODY')
  }
  const entries = body.contacts
  const ids = new Set()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!isPlainObject(e)) return refusal(400, 'INVALID_BODY', i)
    if (e.id === undefined || e.id === null) continue
    if (!Number.isSafeInteger(e.id) || e.id <= 0 || ids.has(e.id)) return refusal(400, 'INVALID_BODY', i)
    ids.add(e.id)
  }
  if (entries.length < MIN_CONTACTS) return refusal(422, 'EMERGENCY_CONTACTS_MIN')
  if (entries.length > MAX_CONTACTS) return refusal(422, 'EMERGENCY_CONTACTS_MAX')
  const list = []
  const phones = new Set()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const name = cleanContactText(e.name, CONTACT_NAME_MAX)
    if (!name.ok) return refusal(422, 'CONTACT_NAME_INVALID', i)
    const relationship = cleanContactText(e.relationship, RELATIONSHIP_MAX)
    if (!relationship.ok) return refusal(422, 'CONTACT_RELATIONSHIP_INVALID', i)
    const phone = normalizePhone(e.phone)
    if (!phone.ok) return refusal(422, 'CONTACT_PHONE_INVALID', i)
    if (phones.has(phone.e164)) return refusal(422, 'CONTACT_PHONE_DUPLICATE', i)
    phones.add(phone.e164)
    list.push({ id: e.id === undefined || e.id === null ? null : e.id, position: i + 1, name: name.value, relationship: relationship.value, phone: phone.e164 })
  }
  return { ok: true, list }
}

const FIELD_OF = Object.freeze({
  CONTACT_NAME_INVALID: 'name',
  CONTACT_RELATIONSHIP_INVALID: 'relationship',
  CONTACT_PHONE_INVALID: 'phone',
  CONTACT_PHONE_DUPLICATE: 'phone',
})

// The field a refusal names ('name', 'relationship', 'phone'), or null.
export function fieldOfRefusal(code) {
  return Object.prototype.hasOwnProperty.call(FIELD_OF, code) ? FIELD_OF[code] : null
}

// The words for a failed read or save (useApi()'s error). The write limiter's 429
// carries no code; a request that got no answer has no status.
export function refusalText(err, fallback = 'SAVE_FAILED') {
  const code = err && typeof err.code === 'string' ? err.code : ''
  if (code && Object.prototype.hasOwnProperty.call(MESSAGES, code)) return MESSAGES[code]
  const status = err && Number.isInteger(err.status) ? err.status : 0
  if (status === 429) return MESSAGES.TOO_MANY
  if (status === 401) return MESSAGES.SESSION_ENDED
  if (!status) return MESSAGES.OFFLINE
  return MESSAGES[fallback] || MESSAGES.SAVE_FAILED
}

// refusalText() for the office panel.
export function staffRefusalText(err, fallback = 'SAVE_FAILED') {
  const text = refusalText(err, fallback)
  if (text === MESSAGES.READ_FAILED) return STAFF_WORDS.READ_FAILED
  if (text === MESSAGES.SAVE_FAILED) return STAFF_WORDS.SAVE_FAILED
  return text
}

// A 404 FEATURE_OFF: EMERGENCY_CONTACTS_ENABLED is off on the server.
export function isFeatureOff(err) {
  return !!err && err.status === 404 && err.code === 'FEATURE_OFF'
}

// A Drivers page row's list: the office screens' only contacts route (Super Admin
// and Dispatcher). null for anything but a positive whole id.
export function staffContactsUrl(directoryId) {
  return Number.isSafeInteger(directoryId) && directoryId > 0 ? `/api/drivers-directory/${directoryId}/emergency-contacts` : null
}

// The staff GET's linked:false reason in words.
export function linkedText(reason) {
  return reason === 'ambiguous' ? MESSAGES.DRIVER_ACCOUNT_AMBIGUOUS : MESSAGES.NO_DRIVER_ACCOUNT
}

export function blankRow() {
  return { id: null, name: '', relationship: '', phone: '' }
}

// The form's rows: the stored contacts in order, each keeping its id and its number
// as the server shows it, then blank rows up to the minimum.
export function draftRows(contacts) {
  const rows = (Array.isArray(contacts) ? contacts : []).slice(0, MAX_CONTACTS).map((c) => ({
    id: c && Number.isSafeInteger(c.id) && c.id > 0 ? c.id : null,
    name: c && typeof c.name === 'string' ? c.name : '',
    relationship: c && typeof c.relationship === 'string' ? c.relationship : '',
    phone: c && typeof c.phoneDisplay === 'string' && c.phoneDisplay ? c.phoneDisplay : (c && typeof c.phone === 'string' ? c.phone : ''),
  }))
  while (rows.length < MIN_CONTACTS) rows.push(blankRow())
  return rows
}

// The PUT body for the rows on screen, as typed. A new row left wholly blank is no
// contact and is dropped; a stored one emptied is sent, so the check names it.
// rowOf[i] is the row entry i came from, for a refusal's index.
export function listToSend(rows) {
  const contacts = []
  const rowOf = []
  ;(Array.isArray(rows) ? rows : []).forEach((r, i) => {
    const blank = ![r.name, r.relationship, r.phone].some((x) => typeof x === 'string' && x.trim())
    if (blank && r.id === null) return
    contacts.push({ ...(r.id === null ? {} : { id: r.id }), name: r.name, relationship: r.relationship, phone: r.phone })
    rowOf.push(i)
  })
  return { body: { contacts }, rowOf }
}

// A name, relationship and number as the server would store them, or null.
function storedKey(name, relationship, phone) {
  const n = cleanContactText(name, CONTACT_NAME_MAX)
  const r = cleanContactText(relationship, RELATIONSHIP_MAX)
  const p = normalizePhone(phone)
  return n.ok && r.ok && p.ok ? `${n.value}\u0000${r.value}\u0000${p.e164}` : null
}

// After a save whose answer was lost the list may be stored already: each row with
// no id takes the id of a stored contact it matches as stored, one row per contact,
// so the next Save changes nothing instead of replacing the list with copies.
export function adoptStoredIds(rows, stored) {
  const list = Array.isArray(rows) ? rows : []
  const held = new Set(list.map((r) => (isPlainObject(r) ? r.id : null)).filter((id) => Number.isSafeInteger(id) && id > 0))
  const free = (Array.isArray(stored) ? stored : [])
    .filter((c) => isPlainObject(c) && Number.isSafeInteger(c.id) && c.id > 0 && !held.has(c.id))
    .map((c) => ({ id: c.id, key: storedKey(c.name, c.relationship, c.phone) }))
  return list.map((row) => {
    if (!isPlainObject(row) || row.id !== null) return row
    const key = storedKey(row.name, row.relationship, row.phone)
    const hit = key === null ? -1 : free.findIndex((c) => c.key === key)
    if (hit < 0) return row
    const [c] = free.splice(hit, 1)
    return { ...row, id: c.id }
  })
}

// A field's text cut to `limit` UTF-16 units, the length the server counts, never
// splitting a character in two (Vant's maxlength counts characters instead).
export function clampToLimit(value, limit) {
  if (typeof value !== 'string') return ''
  if (value.length <= limit) return value
  const cut = value.slice(0, limit)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

// A stored number fit to dial: + and 8 to 15 digits, the first not 0, or ''.
function telNumber(phone) {
  if (typeof phone !== 'string' || phone.length < 9 || phone.length > 16 || phone[0] !== '+' || phone[1] === '0') return ''
  for (const ch of phone.slice(1)) if (ch < '0' || ch > '9') return ''
  return phone
}

// The stored contacts as a list shows them: the number as the server shows it, and
// a tel: link built from the stored E.164 number only.
export function contactLines(contacts) {
  return (Array.isArray(contacts) ? contacts : []).filter(isPlainObject).slice(0, MAX_CONTACTS).map((c, i) => {
    const tel = telNumber(c.phone)
    return {
      id: Number.isSafeInteger(c.id) ? c.id : null,
      primary: i === 0,
      name: typeof c.name === 'string' ? c.name : '',
      relationship: typeof c.relationship === 'string' ? c.relationship : '',
      phone: typeof c.phoneDisplay === 'string' && c.phoneDisplay ? c.phoneDisplay : tel,
      tel: tel ? `tel:${tel}` : null,
    }
  })
}

const wholeAtLeast = (n, min, fallback) => (Number.isInteger(n) && n >= min ? n : fallback)

// The driver payload's emergencyContacts as the store keeps it: the three counts and
// nothing else, or null when the payload has no such key (the flag off).
export function contactCounts(raw) {
  if (!isPlainObject(raw)) return null
  return {
    required: wholeAtLeast(raw.required, 1, MIN_CONTACTS),
    maximum: wholeAtLeast(raw.maximum, 1, MAX_CONTACTS),
    onFile: wholeAtLeast(raw.onFile, 0, 0),
  }
}

// The lock screen's contacts item, or null without counts.
export function contactsItem(counts) {
  if (!isPlainObject(counts)) return null
  const required = wholeAtLeast(counts.required, 1, MIN_CONTACTS)
  const onFile = wholeAtLeast(counts.onFile, 0, 0)
  const done = onFile >= required
  return { required, onFile, done, label: done ? `${onFile} added` : `${onFile} of ${required} added`, action: onFile > 0 ? 'Edit' : 'Add' }
}

// How many of the five documents the payload's rows show signed.
export function requiredSignedCount(documents) {
  if (!Array.isArray(documents)) return 0
  const signedKeys = new Set(documents.filter((d) => isPlainObject(d) && d.signed).map((d) => d.doc_key))
  return ONBOARDING_DOC_KEYS.filter((k) => signedKeys.has(k)).length
}

// Step 1 of the lock screen as the server judges it (onboardingSigningStepState()):
// the documents, and the contacts item while the step is open or once it is done
// (so the count never drops on completion). Past the step, never a lower percentage.
export function signingStepView({ status, signed, total, counts }) {
  const item = contactsItem(counts)
  const counted = !!item && (status === 'documents_pending' || item.done)
  const docsTotal = Number.isInteger(total) && total > 0 ? total : 0
  const docsSigned = Number.isInteger(signed) && signed > 0 ? Math.min(signed, docsTotal) : 0
  const done = docsSigned + (counted && item.done ? 1 : 0)
  const of = docsTotal + (counted ? 1 : 0)
  return {
    item,
    counted,
    done,
    of,
    pct: of > 0 ? Math.round((done / of) * 100) : 0,
    stepDone: docsTotal > 0 && docsSigned >= docsTotal && (!item || item.done || status !== 'documents_pending'),
  }
}

// Whether the sign-in prompt for emergency contacts may show now. The caller asks
// again whenever an input changes, so a prompt held back (another window up, the
// load page where Drive Mode lives, a moving truck) waits instead of being skipped.
export function contactsPromptDue(s) {
  if (!isPlainObject(s) || s.role !== 'Driver') return false
  const counts = contactCounts(s.counts)
  if (!counts || counts.onFile >= counts.required) return false
  if (s.onboarding !== false || s.loaded !== true || s.answered !== false) return false
  if (s.welcomeOpen || s.loadOpen || s.dialogOpen) return false
  return s.motionAllowed === true
}
