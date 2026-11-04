// The Super Admin page for passenger authorizations (PASSENGER_AUTHORIZATION_ENABLED): its
// tabs, words, the actions a row offers and the checks before a send. The server is the gate
// (scripts/test-passenger-authorization-routes.js): it decides who sees a row, the row's
// displayStatus, and whether it can still be signed, declined or revoked. These checks only
// give a message before the round trip; scripts/test-passenger-authorization-admin-client.mjs
// pins them to the server's rules.

import { buildConsent } from './signingConsent.js'
import { fmtYmd } from '../utils/datetime.js'

export const LIVE_EVENT = 'passenger-authorizations:changed'
export const PRINTED_NAME_MIN = 2
export const PRINTED_NAME_MAX = 100
export const TITLE_MIN = 2
export const TITLE_MAX = 60
export const REASON_MIN = 2
export const REASON_MAX = 300

// Each displayStatus belongs to exactly one tab, and each tab is one of the server's views.
export const TABS = Object.freeze([
  Object.freeze({ key: 'waiting', label: 'Waiting', statuses: Object.freeze(['awaiting_company']) }),
  Object.freeze({ key: 'authorized', label: 'Authorized', statuses: Object.freeze(['scheduled', 'active']) }),
  Object.freeze({ key: 'ended', label: 'Ended', statuses: Object.freeze(['expired', 'declined', 'revoked']) }),
])

export function tabKey(key) {
  return TABS.some((t) => t.key === key) ? key : 'waiting'
}

export function listUrl(tab) {
  return `/api/admin/passenger-authorizations?view=${tabKey(tab)}`
}

const idPart = (id) => encodeURIComponent(String(id))
export const pdfUrl = (id) => `/api/passenger-authorizations/${idPart(id)}/pdf`
export const countersignUrl = (id) => `/api/admin/passenger-authorizations/${idPart(id)}/countersign`
export const declineUrl = (id) => `/api/admin/passenger-authorizations/${idPart(id)}/decline`
export const revokeUrl = (id) => `/api/admin/passenger-authorizations/${idPart(id)}/revoke`

const isRow = (r) => !!r && typeof r === 'object' && !Array.isArray(r)

// Only the rows whose displayStatus belongs to the tab: a row that moved on between the
// server's read and this render never shows under a tab, or with an action, it no longer has.
export function rowsForTab(rows, tab) {
  const statuses = TABS.find((t) => t.key === tabKey(tab)).statuses
  return (Array.isArray(rows) ? rows : []).filter((r) => isRow(r) && statuses.includes(r.displayStatus))
}

export function actionsFor(row) {
  const s = isRow(row) ? row.displayStatus : ''
  return {
    countersign: s === 'awaiting_company',
    decline: s === 'awaiting_company',
    revoke: s === 'scheduled' || s === 'active',
  }
}

export function statusText(row) {
  if (!isRow(row)) return ''
  switch (row.displayStatus) {
    case 'awaiting_company': return 'Waiting for company signature'
    case 'scheduled': return `Authorized, starts ${fmtYmd(row.validFrom)}`
    case 'active': return `Authorized until ${fmtYmd(row.expiresOn)}`
    case 'expired': return `Expired ${fmtYmd(row.expiresOn)}`
    case 'declined': return 'Declined'
    case 'revoked': return 'Revoked'
    default: return ''
  }
}

export function passengerText(row) {
  if (!isRow(row)) return ''
  if (row.passengerAdult === true) return 'Adult (18 or older)'
  return `Minor; signed by ${row.guardianRelationship || 'guardian'} ${row.guardianName || ''}`.trim()
}

export function tripText(row) {
  return isRow(row) ? `${row.tripStart || '—'} → ${row.tripEnd || '—'}` : ''
}

export function datesText(row) {
  return isRow(row) ? `${fmtYmd(row.validFrom)} to ${fmtYmd(row.expiresOn)}` : ''
}

// Who signed for the company, or who declined or ended it and why ('' when nobody has).
export function decisionText(row) {
  if (!isRow(row)) return ''
  if (row.status === 'authorized' || (row.status === 'revoked' && row.companyPrintedName)) {
    const signed = `Signed by ${row.companyPrintedName}, ${row.companyTitle}, ${row.companySignedOn}`
    if (row.status === 'authorized') return signed
    return `${signed}. Revoked by ${row.decidedBy}: ${row.decidedReason}`
  }
  if (row.status === 'declined') return `Declined by ${row.decidedBy}: ${row.decidedReason}`
  if (row.status === 'awaiting_company' && row.displayStatus === 'expired') return 'Expired before the company signed.'
  return ''
}

// Text as the server counts it: whitespace runs folded, trimmed, in characters.
const trimmed = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
const outside = (text, min, max) => {
  const n = Array.from(text).length
  return n < min || n > max
}
const PNG_DATA_URI = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/

// What stops a countersign before it is sent ('' when nothing does). The server checks again.
export function countersignProblem(form) {
  const f = isRow(form) ? form : {}
  if (outside(trimmed(f.printedName), PRINTED_NAME_MIN, PRINTED_NAME_MAX)) {
    return `Type your full name (${PRINTED_NAME_MIN} to ${PRINTED_NAME_MAX} characters).`
  }
  if (outside(trimmed(f.title), TITLE_MIN, TITLE_MAX)) return `Type your title (${TITLE_MIN} to ${TITLE_MAX} characters).`
  if (f.agreed !== true) return 'Tick the box to agree before you sign.'
  if (typeof f.signatureImage !== 'string' || !PNG_DATA_URI.test(f.signatureImage)) return 'Draw your signature in the box.'
  return ''
}

export function countersignPayload(form) {
  const f = isRow(form) ? form : {}
  return {
    printedName: trimmed(f.printedName),
    title: trimmed(f.title),
    signatureImage: typeof f.signatureImage === 'string' ? f.signatureImage : '',
    consent: buildConsent(f.agreed),
  }
}

export function reasonProblem(text) {
  if (outside(trimmed(text), REASON_MIN, REASON_MAX)) return `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.`
  return ''
}

export const reasonPayload = (text) => ({ reason: trimmed(text) })

// After these answers the row on screen may be out of date (decided elsewhere, expired,
// gone, or the request's fate unknown), so the list is read again.
const RELOAD_CODES = ['ALREADY_DECIDED', 'NOT_REVOCABLE', 'AUTHORIZATION_EXPIRED', 'NOT_FOUND', 'FEATURE_OFF', 'TIMEOUT']
export function reloadAfter(err) {
  return !!err && (RELOAD_CODES.includes(err.code) || err.status === 0)
}

const CODE_WORDS = Object.freeze({
  FEATURE_OFF: 'Passenger authorizations are switched off on this server.',
  NOT_FOUND: 'This authorization is no longer listed. The list was read again.',
  ALREADY_DECIDED: 'This authorization was already signed, declined or revoked. The list now shows where it stands.',
  NOT_REVOCABLE: 'Only an authorization the company has signed can be revoked. The list now shows where it stands.',
  AUTHORIZATION_EXPIRED: 'This authorization has expired, so it can no longer be signed. The driver can send a new one.',
  AUTHORIZATION_INCOMPLETE: 'This authorization is missing something the form needs, so it can\'t be signed. Decline it so the driver can send a new one.',
  PRINTED_NAME_REQUIRED: `Type your full name (${PRINTED_NAME_MIN} to ${PRINTED_NAME_MAX} characters).`,
  TITLE_REQUIRED: `Type your title (${TITLE_MIN} to ${TITLE_MAX} characters).`,
  REASON_REQUIRED: `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.`,
  CONSENT_REQUIRED: 'Tick the box to agree before you sign.',
  SIGNATURE_REQUIRED: 'Draw your signature in the box.',
  RENDER_FAILED: 'The signed PDF could not be made just now. Nothing was signed: try again.',
  RATE_LIMITED: 'Too many tries in a short time. Wait a few minutes and try again.',
  TIMEOUT: 'No answer from the server. The list was read again: check whether the change went through before you try again.',
})

export function actionErrorText(err) {
  const code = (err && err.code) || ''
  const status = (err && err.status) || 0
  if (Object.prototype.hasOwnProperty.call(CODE_WORDS, code)) return CODE_WORDS[code]
  if (status === 0) return CODE_WORDS.TIMEOUT
  if (status === 404) return CODE_WORDS.NOT_FOUND
  if (status === 413 || status === 415) return 'The signature could not be used. Clear it, draw it again and try again.'
  if (status === 429) return CODE_WORDS.RATE_LIMITED
  if (status === 503) return CODE_WORDS.RENDER_FAILED
  if (status === 400) return 'Check the form and try again.'
  return 'Something went wrong. Try again.'
}

export function listErrorText(err) {
  if (err && err.code === 'FEATURE_OFF') return 'Passenger authorizations are switched off on this server.'
  if (err && err.code === 'TIMEOUT') return 'No answer from the server.'
  return 'Could not load passenger authorizations.'
}
