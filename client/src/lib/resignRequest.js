// A fresh signature a Super Admin asked for (ONBOARDING_RESIGN_ENABLED). The server
// decides which documents carry a request: the driver payload marks them with
// `resign_requested`, and a Super Admin's Drivers page answer adds `resign` and
// `resignable` (both only while the flag is on). This file only words and sorts what
// it is sent; scripts/test-onboarding-resign-client.mjs pins it to the server's rules.
//
// Pure: no imports.

export const NOTICE_TYPE = 'resign-requested'
export const LIVE_EVENT = 'onboarding-resign-requested'
export const REASON_MIN = 10
export const REASON_MAX = 300
export const SIGN_AGAIN_NOTE = "We've asked for a fresh signature on this document. Your earlier signed copy stays on file."

export function isRequested(doc) {
  return !!doc && !!doc.signed && doc.resign_requested === true
}

export function requestedDocs(docs) {
  return (Array.isArray(docs) ? docs : []).filter(isRequested)
}

// The word on a document's row of the onboarding screen.
export function docAction(doc) {
  if (isRequested(doc)) return 'Sign again'
  return doc && doc.signed ? 'View' : 'Sign'
}

// The signing window shows its form for an unsigned document, or one asked again.
export function showSignForm(doc) {
  return !!doc && (!doc.signed || isRequested(doc))
}

// The signing window's PDF: the signed copy, or the document to sign (a fresh copy
// is read before it is signed).
export function documentUrl(doc) {
  if (!doc) return ''
  if (doc.signed && doc.signed_pdf_url && !isRequested(doc)) return doc.signed_pdf_url
  return `/api/onboarding/documents/${doc.doc_key}/pdf`
}

export function cardText(doc) {
  return `We need a fresh signature on ${(doc && doc.doc_name) || 'a document'}. Your earlier signed copy stays on file.`
}

// The document a "Please sign again" notice names, or '' for any other notice.
export function noticeDocKey(notif) {
  if (!notif || notif.type !== NOTICE_TYPE) return ''
  try {
    const meta = JSON.parse(notif.metadata || '{}')
    return meta && typeof meta.docKey === 'string' ? meta.docKey : ''
  } catch {
    return ''
  }
}

// What the Drivers page shows beside a document, from the server's keys alone.
export function staffState(doc) {
  if (doc && doc.resign && typeof doc.resign === 'object') return 'requested'
  if (doc && doc.resignable === true) return 'can-ask'
  return 'none'
}

// What is wrong with a reason before it is sent ('' when nothing is). The server checks again.
export function reasonProblem(text) {
  const n = Array.from(typeof text === 'string' ? text.trim() : '').length
  if (n < REASON_MIN) return `Give a reason of at least ${REASON_MIN} characters.`
  if (n > REASON_MAX) return `Keep the reason to ${REASON_MAX} characters or fewer.`
  return ''
}

export function requestUrl(userId, docKey) {
  return `/api/admin/onboarding/${encodeURIComponent(userId)}/documents/${encodeURIComponent(docKey)}/request-signature`
}

export function cancelUrl(userId, docKey) {
  return `/api/admin/onboarding/${encodeURIComponent(userId)}/documents/${encodeURIComponent(docKey)}/cancel-signature-request`
}
