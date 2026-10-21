// The Load ID a NEW load may take: one its own pages can open.
//
// The client's copy of lib/load-id-rule.js, which explains the rule: the ID
// trimmed, then both patterns the load pages accept it by (the per-load routes
// and the rate-con viewer). New Job shows LOAD_ID_RULE_MESSAGE under the Load
// ID field and refuses to create the job until the ID passes; the server
// refuses it too (400 INVALID_LOAD_ID). scripts/test-new-job-load-id.mjs pins
// this copy equal to the server's.

export const LOAD_ROUTE_ID_RE = /^[A-Za-z0-9\-_.#]{1,40}$/
export const RATECON_PDF_ID_RE = /^#?[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

export const LOAD_ID_RULE_MESSAGE =
  'Load ID can only use letters, numbers, hyphens (-), underscores (_) and dots (.), with no spaces. ' +
  'It must start with a letter or number (a # in front is fine) and be at most 40 characters.'

// The ID as the load pages read it: edge whitespace trimmed. Text and numbers
// only; anything else reads as blank.
export function trimLoadId(raw) {
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return ''
}

// Whether a load's pages open this ID.
export function loadIdOpenable(raw) {
  const id = trimLoadId(raw)
  return LOAD_ROUTE_ID_RE.test(id) && RATECON_PDF_ID_RE.test(id)
}

// What New Job shows under the Load ID field: '' while the field is blank (the
// form asks for a Load ID on its own) or holds an ID the pages open.
export function loadIdFieldMessage(raw) {
  const id = trimLoadId(raw)
  return id && !loadIdOpenable(id) ? LOAD_ID_RULE_MESSAGE : ''
}
