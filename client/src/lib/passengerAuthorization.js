// A driver's passenger authorizations on the phone (PASSENGER_AUTHORIZATION_ENABLED):
// the words for each status, the form's state and checks, and the body sent.
//
// The server decides (lib/passenger-authorization.js). The checks here copy its
// rules so the form can say what is missing before anyone signs; they never let
// through what the server would refuse, and the server refuses whatever they miss.
//
// Pure apart from the two imports: no network, no storage but the one "Not now" key.
import { fmtYmd, shiftYmd } from '../utils/datetime.js'
import { buildConsent } from './signingConsent.js'

export const FEATURE_URL = '/api/passenger-authorizations/feature'
export const LIST_URL = '/api/passenger-authorizations'
export const FORM_PDF_URL = '/api/passenger-authorizations/form.pdf'
// Sent to the driver's own room when the company signs, declines or ends one.
export const LIVE_EVENT = 'passenger-authorizations:changed'
// The server renders the PDF before it answers, so a slow phone line gets longer than
// useApi()'s 20 s. A timeout is safe to repeat: the same request id files once.
export const SUBMIT_TIMEOUT_MS = 60000

// The PDF of one of the driver's own rows, or null for anything but a positive whole id.
export function pdfUrl(id) {
  return Number.isSafeInteger(id) && id > 0 ? `/api/passenger-authorizations/${id}/pdf` : null
}

// The server's limits: names and points in characters after its clean-up, days on the calendar.
export const LIMITS = Object.freeze({
  NAME_MIN: 2,
  NAME_MAX: 100,
  RELATIONSHIP_MIN: 2,
  RELATIONSHIP_MAX: 40,
  TRIP_POINT_MIN: 2,
  TRIP_POINT_MAX: 120,
  TRUCK_UNIT_MAX: 20,
  START_WITHIN_DAYS: 90,
  EXPIRY_WITHIN_DAYS: 365,
})

// What the form prints for the passenger's age (lib/passenger-authorization-text.js;
// scripts/test-passenger-authorization-client.mjs pins the two equal).
export const AGE_STATEMENT = Object.freeze({
  adult: '18 or older',
  minor: 'Under 18 and older than 10; a parent or legal guardian signs below',
})

export const MESSAGES = Object.freeze({
  PASSENGER_NAME_REQUIRED: 'Enter the passenger\'s full name.',
  PASSENGER_AGE_REQUIRED: 'Say whether the passenger is 18 or older.',
  GUARDIAN_REQUIRED: 'For a passenger under 18, enter the parent or guardian\'s full name and how they are related.',
  MINOR_ATTESTATION_REQUIRED: 'For a passenger under 18, confirm they are older than 10 and fit the seat and seat belt.',
  TRIP_POINTS_REQUIRED: 'Enter where the trip starts and where it ends.',
  DATES_INVALID: 'Pick a start date from today to 90 days ahead, and an end date on or after it.',
  EXPIRY_TOO_LONG: 'The end date can be at most one year after the start date.',
  TRUCK_UNIT_REQUIRED: 'Enter the truck unit number.',
  TRUCK_UNIT_TOO_LONG: 'The truck unit number can be at most 20 characters.',
  SIGNATURE_REQUIRED: 'The passenger (or parent or guardian) and you both need to sign.',
  CONSENT_REQUIRED: 'Each signer needs to tick the box before signing.',
  IMAGE_TOO_LARGE: 'A signature couldn\'t be read. Clear both signatures and sign again.',
  UNSUPPORTED_IMAGE_TYPE: 'A signature couldn\'t be read. Clear both signatures and sign again.',
  REQUEST_ID_REQUIRED: 'This form couldn\'t be sent. Close it and start again.',
  REQUEST_ID_CONFLICT: 'This form couldn\'t be sent. Close it and start again.',
  TOO_MANY_OPEN: 'You already have 10 passenger authorizations waiting or valid. Add another once one has ended.',
  DRIVER_NAME_REQUIRED: 'Your account has no driver name on file. Ask the office to add it, then try again.',
  SIGN_IN_AGAIN: 'Your session is out of date. Sign in again.',
  FEATURE_OFF: 'Passenger authorizations aren\'t available right now.',
  RETRY: 'The form couldn\'t be saved. What you entered and both signatures are kept: tap Submit to try again.',
  OFFLINE: 'Couldn\'t reach LogisX. What you entered and both signatures are kept: tap Submit to try again.',
  SLOW: 'LogisX took too long to answer. What you entered and both signatures are kept: tap Submit to try again.',
  PENDING: 'LogisX may already have this form. So that it is filed once, nothing on it can change until LogisX answers: tap Submit again. If you close it, look for it in your list before starting a new one.',
  TOO_MANY: 'Too many tries in a short time. Wait a few minutes, then tap Submit again.',
  SESSION_ENDED: 'Your session ended. Sign in again.',
  SEND_FAILED: 'The form couldn\'t be sent. Try again.',
  READ_FAILED: 'Your passenger authorizations couldn\'t be loaded. Try again.',
  OFFLINE_READ: 'Couldn\'t reach LogisX. Check your signal and try again.',
  NO_REQUEST_ID: 'This phone\'s browser can\'t send this form. Update the browser, then try again.',
})

// The server's refusal codes (lib/passenger-authorization.js), each with words above.
const SERVER_CODES = Object.freeze(Object.fromEntries([
  'REQUEST_ID_REQUIRED', 'PASSENGER_NAME_REQUIRED', 'PASSENGER_AGE_REQUIRED', 'GUARDIAN_REQUIRED',
  'MINOR_ATTESTATION_REQUIRED', 'TRIP_POINTS_REQUIRED', 'DATES_INVALID', 'EXPIRY_TOO_LONG', 'TRUCK_UNIT_REQUIRED',
  'TRUCK_UNIT_TOO_LONG', 'SIGNATURE_REQUIRED', 'CONSENT_REQUIRED', 'IMAGE_TOO_LARGE', 'UNSUPPORTED_IMAGE_TYPE',
  'REQUEST_ID_CONFLICT', 'TOO_MANY_OPEN', 'DRIVER_NAME_REQUIRED', 'SIGN_IN_AGAIN', 'FEATURE_OFF',
].map((c) => [c, true])))
export const SERVER_REFUSAL_CODES = Object.freeze(Object.keys(SERVER_CODES))

// Which part of the form a refusal is about, to say where to look.
const FIELD_OF = Object.freeze({
  PASSENGER_NAME_REQUIRED: 'passengerName',
  PASSENGER_AGE_REQUIRED: 'passengerAdult',
  GUARDIAN_REQUIRED: 'guardian',
  MINOR_ATTESTATION_REQUIRED: 'minorAttested',
  TRIP_POINTS_REQUIRED: 'trip',
  DATES_INVALID: 'dates',
  EXPIRY_TOO_LONG: 'dates',
  TRUCK_UNIT_REQUIRED: 'truckUnit',
  TRUCK_UNIT_TOO_LONG: 'truckUnit',
})

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v) => (typeof v === 'string' ? v.trim() : '')

// A field's length as the server reads it for a limit of `max`: control, zero-width,
// line-separator and direction characters become spaces (server.js
// sanitizeEvidenceText), runs of spaces count once, the ends are trimmed, and
// characters are counted, not UTF-16 units. Over 8 x max is refused unread.
// The class is spelled by code point so none of them sits in this file as itself.
const cp = (n) => String.fromCharCode(n)
const STRIP_RE = new RegExp(`[${cp(0x00)}-${cp(0x1f)}${cp(0x7f)}-${cp(0x9f)}${cp(0x200b)}-${cp(0x200f)}${cp(0x2028)}${cp(0x2029)}${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}${cp(0xfeff)}]+`, 'g')
export function cleanLength(v, max) {
  if (typeof v !== 'string') return 0
  if (v.length > max * 8) return Infinity
  const kept = Array.from(v.normalize('NFC').replace(STRIP_RE, ' ').trim()).slice(0, max * 4).join('')
  return Array.from(kept.replace(/\s+/g, ' ').trim()).length
}
// Checked as sent: buildSubmission() trims every field.
const within = (v, min, max) => {
  const n = cleanLength(text(v), max)
  return n >= min && n <= max
}

// A real calendar day written 'YYYY-MM-DD', nothing around it.
export function isDay(v) {
  return typeof v === 'string' && v !== '' && shiftYmd(v, 0) === v
}

// The date pickers' bounds: the start from today to 90 days on, the end from the
// start to a year after it.
export function dateBounds(today, validFrom) {
  const start = isDay(validFrom) ? validFrom : today
  return {
    validFromMin: today,
    validFromMax: shiftYmd(today, LIMITS.START_WITHIN_DAYS),
    expiresMin: start,
    expiresMax: shiftYmd(start, LIMITS.EXPIRY_WITHIN_DAYS),
  }
}

// The trip details as the server checks them, in its order. `today` is the
// business day (appToday()).
export function checkDetails(s, today) {
  const no = (code) => ({ ok: false, code, field: FIELD_OF[code], error: MESSAGES[code] })
  if (!isPlainObject(s)) return no('PASSENGER_NAME_REQUIRED')
  if (!within(s.passengerName, LIMITS.NAME_MIN, LIMITS.NAME_MAX)) return no('PASSENGER_NAME_REQUIRED')
  if (s.passengerAdult !== true && s.passengerAdult !== false) return no('PASSENGER_AGE_REQUIRED')
  if (s.passengerAdult === false) {
    if (!within(s.guardianName, LIMITS.NAME_MIN, LIMITS.NAME_MAX) ||
      !within(s.guardianRelationship, LIMITS.RELATIONSHIP_MIN, LIMITS.RELATIONSHIP_MAX)) return no('GUARDIAN_REQUIRED')
    if (s.minorAttested !== true) return no('MINOR_ATTESTATION_REQUIRED')
  }
  // The form names the truck, and it never reads AUTHORIZED with that line blank.
  const unit = cleanLength(text(s.truckUnit), LIMITS.TRUCK_UNIT_MAX)
  if (unit === 0) return no('TRUCK_UNIT_REQUIRED')
  if (unit > LIMITS.TRUCK_UNIT_MAX) return no('TRUCK_UNIT_TOO_LONG')
  if (!within(s.tripStart, LIMITS.TRIP_POINT_MIN, LIMITS.TRIP_POINT_MAX) ||
    !within(s.tripEnd, LIMITS.TRIP_POINT_MIN, LIMITS.TRIP_POINT_MAX)) return no('TRIP_POINTS_REQUIRED')
  if (!isDay(today) || !isDay(s.validFrom) || !isDay(s.expiresOn)) return no('DATES_INVALID')
  if (s.validFrom < today || s.validFrom > shiftYmd(today, LIMITS.START_WITHIN_DAYS) || s.expiresOn < s.validFrom) return no('DATES_INVALID')
  if (s.expiresOn > shiftYmd(s.validFrom, LIMITS.EXPIRY_WITHIN_DAYS)) return no('EXPIRY_TOO_LONG')
  return { ok: true }
}

// Who signs for the passenger: the passenger, or for a minor the parent or guardian.
export function signerName(s) {
  if (!isPlainObject(s)) return ''
  if (s.passengerAdult === true) return text(s.passengerName)
  if (s.passengerAdult === false) return text(s.guardianName)
  return ''
}

// A UUID v4 for one opening of the form: a repeat of the same submit (a lost
// answer, a double tap) is the same request, and the server files it once.
export const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function newRequestId(c = globalThis.crypto) {
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  return ''
}

// The form's whole state, one object: the modal replaces it on open and on close,
// so nothing typed for one passenger is there for the next. No signature image
// lives here; the pads hold them until Submit.
export function blankState({ requestId = '', today = '', truckUnit = '' } = {}) {
  return {
    requestId,
    passengerName: '',
    passengerAdult: null,
    guardianName: '',
    guardianRelationship: '',
    minorAttested: false,
    truckUnit: typeof truckUnit === 'string' ? truckUnit.trim().slice(0, LIMITS.TRUCK_UNIT_MAX) : '',
    tripStart: '',
    tripEnd: '',
    validFrom: isDay(today) ? today : '',
    expiresOn: '',
    passengerAgreed: false,
    passengerSigned: false,
    driverAgreed: false,
    driverSigned: false,
    submitting: false,
    pending: false,
    error: '',
    sent: null,
  }
}

// What the signers may touch now. While a Submit is out, or after one whose answer
// was lost (the server may have filed it under this request id), nothing that would
// change what was sent can move: only Submit again, the same id with the same form.
export function formControls(s, today) {
  const st = isPlainObject(s) ? s : {}
  const frozen = st.submitting === true || st.pending === true
  const signed = st.passengerSigned === true || st.driverSigned === true
  const detailsOk = checkDetails(st, today).ok
  const passengerDone = detailsOk && st.passengerAgreed === true && st.passengerSigned === true
  return {
    detailsLocked: frozen || signed,
    changeDetails: !frozen && signed,
    passengerConsent: !frozen && detailsOk,
    passengerPad: !frozen && detailsOk && st.passengerAgreed === true,
    driverConsent: !frozen && passengerDone,
    driverPad: !frozen && passengerDone && st.driverAgreed === true,
    submitLabel: st.submitting === true ? 'Sending…' : st.pending === true ? 'Submit again' : 'Submit',
  }
}

// The POST body, or null when the age answer is not a real yes or no: a missing
// answer must never go out as "under 18". An adult's guardian lines go blank and
// the minor's box unticked, whatever was typed before the answer changed.
export function buildSubmission(s, images) {
  if (!isPlainObject(s) || (s.passengerAdult !== true && s.passengerAdult !== false)) return null
  const adult = s.passengerAdult === true
  const img = isPlainObject(images) ? images : {}
  return {
    requestId: typeof s.requestId === 'string' ? s.requestId : '',
    passengerName: text(s.passengerName),
    passengerAdult: adult,
    guardianName: adult ? '' : text(s.guardianName),
    guardianRelationship: adult ? '' : text(s.guardianRelationship),
    minorAttested: adult ? false : s.minorAttested === true,
    truckUnit: text(s.truckUnit),
    tripStart: text(s.tripStart),
    tripEnd: text(s.tripEnd),
    validFrom: text(s.validFrom),
    expiresOn: text(s.expiresOn),
    passengerSignatureImage: typeof img.passenger === 'string' ? img.passenger : null,
    passengerConsent: buildConsent(s.passengerAgreed),
    driverSignatureImage: typeof img.driver === 'string' ? img.driver : null,
    driverConsent: buildConsent(s.driverAgreed),
  }
}

// Every part done: details, both boxes ticked, both pads signed, an id, nothing in flight.
export function canSubmit(s, today) {
  return isPlainObject(s) && REQUEST_ID_RE.test(s.requestId || '') && !s.submitting &&
    checkDetails(s, today).ok && s.passengerAgreed === true && s.passengerSigned === true &&
    s.driverAgreed === true && s.driverSigned === true
}

// What the summary shows will print, in the form's order.
export function summaryLines(s, driverName) {
  if (!isPlainObject(s)) return []
  const adult = s.passengerAdult === true
  const minor = s.passengerAdult === false
  const lines = [
    { label: 'Passenger', value: text(s.passengerName) },
    { label: 'Passenger\'s age', value: adult ? AGE_STATEMENT.adult : minor ? AGE_STATEMENT.minor : '' },
  ]
  if (minor) lines.push({ label: 'Parent or guardian', value: [text(s.guardianName), text(s.guardianRelationship)].filter(Boolean).join(', ') })
  lines.push(
    { label: 'Driver (the only driver)', value: text(driverName) },
    { label: 'Truck unit', value: text(s.truckUnit) },
    { label: 'Trip starts at', value: text(s.tripStart) },
    { label: 'Trip ends at', value: text(s.tripEnd) },
    { label: 'Valid from', value: isDay(s.validFrom) ? fmtYmd(s.validFrom) : '' },
    { label: 'Expires', value: isDay(s.expiresOn) ? `11:59 p.m. on ${fmtYmd(s.expiresOn)}` : '' },
  )
  return lines
}

// A failed POST in words, and the part of the form it is about. `lost`: no answer
// or a 5xx, so the server may have filed it; the form then stays exactly as sent,
// and a repeat with the same request id is answered with that row.
export function submitFailure(err) {
  const code = err && typeof err.code === 'string' ? err.code : ''
  const status = err && Number.isInteger(err.status) ? err.status : 0
  const lost = !status || status >= 500
  if (code && own(SERVER_CODES, code)) return { text: MESSAGES[code], field: own(FIELD_OF, code) ? FIELD_OF[code] : '', lost }
  if (status === 503) return { text: MESSAGES.RETRY, field: '', lost }
  if (status === 429) return { text: MESSAGES.TOO_MANY, field: '', lost }
  if (status === 401) return { text: MESSAGES.SESSION_ENDED, field: '', lost }
  if (!status) return { text: code === 'TIMEOUT' ? MESSAGES.SLOW : MESSAGES.OFFLINE, field: '', lost }
  return { text: MESSAGES.SEND_FAILED, field: '', lost }
}

// A list read's failure in words.
export function readFailure(err) {
  const status = err && Number.isInteger(err.status) ? err.status : 0
  if (status === 401) return MESSAGES.SESSION_ENDED
  if (!status) return MESSAGES.OFFLINE_READ
  return MESSAGES.READ_FAILED
}

// The feature route's answer: on only for a real `true`.
export function featureEnabled(answer) {
  return isPlainObject(answer) && answer.enabled === true
}

// The words for each status. Anything the phone does not know never reads as valid.
export function statusView(row) {
  const r = isPlainObject(row) ? row : {}
  const from = isDay(r.validFrom) ? fmtYmd(r.validFrom) : ''
  const until = isDay(r.expiresOn) ? fmtYmd(r.expiresOn) : ''
  switch (r.displayStatus) {
    case 'awaiting_company': return { key: 'awaiting_company', text: 'Waiting for company signature', tone: 'wait' }
    case 'scheduled': return { key: 'scheduled', text: `Authorized from ${from} until ${until}`, tone: 'ok' }
    case 'active': return { key: 'active', text: `Authorized until ${until}`, tone: 'ok' }
    case 'expired': return { key: 'expired', text: until ? `Expired ${until}` : 'Expired', tone: 'ended' }
    case 'declined': return { key: 'declined', text: 'Declined by the company', tone: 'ended' }
    case 'revoked': return { key: 'revoked', text: 'Ended by the company', tone: 'ended' }
    default: return { key: 'unknown', text: 'Not valid', tone: 'ended' }
  }
}

// One of the driver's rows as the card shows it, or null without a usable id.
export function rowView(raw) {
  if (!isPlainObject(raw) || !Number.isSafeInteger(raw.id) || raw.id <= 0) return null
  const from = isDay(raw.validFrom) ? fmtYmd(raw.validFrom) : ''
  const until = isDay(raw.expiresOn) ? fmtYmd(raw.expiresOn) : ''
  return {
    id: raw.id,
    reference: text(raw.reference),
    passengerName: text(raw.passengerName),
    minor: raw.passengerAdult === false,
    tripStart: text(raw.tripStart),
    tripEnd: text(raw.tripEnd),
    dates: from && until ? `${from} to ${until}` : '',
    status: statusView(raw),
    pdfUrl: pdfUrl(raw.id),
  }
}

// The list route's answer as rows, newest first as sent.
export function listView(answer) {
  const rows = isPlainObject(answer) && Array.isArray(answer.authorizations) ? answer.authorizations : []
  return rows.map(rowView).filter(Boolean)
}

// The create route's answer (201, or 200 for a repeated request) as a row.
export function createdView(answer) {
  return rowView(isPlainObject(answer) && isPlainObject(answer.authorization) ? answer.authorization : answer)
}

// "Not now" on the onboarding card: this browser only, a flag and nothing else.
export const NOT_NOW_KEY = 'logisx.passengerAuthorization.notNow'
export function readNotNow(storage) {
  try { return !!storage && storage.getItem(NOT_NOW_KEY) === '1' } catch { return false }
}
export function writeNotNow(storage, on) {
  try {
    if (!storage) return
    if (on) storage.setItem(NOT_NOW_KEY, '1')
    else storage.removeItem(NOT_NOW_KEY)
  } catch { /* private mode or storage off: the card just stays open */ }
}
