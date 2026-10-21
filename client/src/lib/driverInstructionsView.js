// Rate-con driver instructions, the staff screen (DriverInstructionsSection.vue):
// what the section says and sends. Display only.
//
// The server is the gate (lib/driver-instructions-runtime.js, plan PR 2). It decides
// what a driver may see, refuses a staff edit it can't show, answers every route
// 404 while its flag is off, and serves the driver preview, the review reasons in
// words and any pending re-issue. Nothing here works out, filters or rewrites
// content: an edit goes to the server as typed, in the payload's shape.
//
// A refusal (400 INSTRUCTIONS_CONTENT_NOT_ALLOWED / INSTRUCTIONS_INVALID) is told
// by its code and the KIND of field only ("references", "item text"): never which
// item, never the server's own text, never a value. Runner:
// scripts/test-driver-instructions-client.mjs.

export const STAFF_ROLES = Object.freeze(['Super Admin', 'Dispatcher'])

export function canSeeDriverInstructions(role) {
  return typeof role === 'string' && STAFF_ROLES.includes(role)
}

// Display labels, the server's own (pinned equal to lib/driver-instructions.js).
export const REFERENCE_LABELS = Object.freeze({
  pickup_number: 'Pickup #',
  delivery_number: 'Delivery #',
  appointment_number: 'Appointment #',
  po_number: 'PO #',
  bol_number: 'BOL #',
  seal_number: 'Seal #',
  order_number: 'Order #',
  shipment_id: 'Shipment ID',
  line_reference: 'Ref #',
  other_reference: 'Reference',
})
export const CATEGORY_LABELS = Object.freeze({
  high_value: 'High value',
  no_unattended: 'Never unattended',
  same_driver: 'Same driver',
  seal: 'Seal',
  securement: 'Load securement',
  equipment: 'Equipment',
  temperature: 'Temperature',
  food_grade: 'Food grade',
  ppe: 'PPE',
  check_in: 'Check-in',
  photos: 'Photos',
  team: 'Team',
  tarp: 'Tarp',
  hazmat: 'Hazmat',
  twic: 'TWIC',
  drop_trailer: 'Drop trailer',
  scale_weight: 'Scale / weight',
  tandems: 'Tandems',
  bol_check: 'BOL check',
  work_required: 'Work required',
  hours: 'Hours',
  other: 'Other',
})
export const INSTRUCTION_KIND_LABELS = Object.freeze({
  shipper: 'Shipper instructions',
  receiver: 'Receiver instructions',
  warehouse: 'Warehouse',
  directions: 'Directions',
  hours: 'Hours',
})
export const STOP_KIND_LABELS = Object.freeze({
  pickup: 'Pickup',
  delivery: 'Delivery',
})

const labelOf = (map, key, fallback = '') => (typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : fallback)
export const referenceLabel = (ref) => (ref && typeof ref.label === 'string' && ref.label) || labelOf(REFERENCE_LABELS, ref?.type, 'Reference')
export const categoryLabel = (category) => labelOf(CATEGORY_LABELS, category, 'Requirement')
export const instructionKindLabel = (kind) => labelOf(INSTRUCTION_KIND_LABELS, kind, 'Instructions')
export const stopKindLabel = (kind) => labelOf(STOP_KIND_LABELS, kind, 'Stop')

export function instructionsUrl(loadId, action = '') {
  const base = `/api/loads/${encodeURIComponent(String(loadId ?? ''))}/driver-instructions`
  return action ? `${base}/${action}` : base
}

// ---------------------------------------------------------------- errors
// The kind of field a refusal names: "references" for any part of a reference,
// else the last part of the path ("text", "facility", "place", "category",
// "kind"); anything else reads as the instructions as a whole.
const FIELD_KIND_WORDS = Object.freeze({
  references: 'references',
  text: 'item text',
  facility: 'facility name',
  place: 'stop place',
  category: 'requirement kind',
  kind: 'kind',
  instructions: 'instructions',
})
export function fieldKindOf(field) {
  const s = typeof field === 'string' && field.length <= 200 ? field : ''
  const parts = s.replace(/\[\d{1,4}\]/g, '').split('.').filter(Boolean)
  if (parts.includes('references')) return 'references'
  const last = parts[parts.length - 1]
  return last && last !== 'instructions' && Object.hasOwn(FIELD_KIND_WORDS, last) ? last : 'instructions'
}

const RULE_MESSAGES = Object.freeze({
  number: "This can't be saved: it looks like a number or contact drivers must not see.",
  contact: "This can't be saved: it looks like a number or contact drivers must not see.",
  money: "This can't be saved: it looks like an amount drivers must not see.",
  terms: "This can't be saved: it looks like contract terms drivers must not see.",
  unusual: "This can't be saved: it holds another address, redirect wording or text drivers must not see.",
})
const RULE_FALLBACK = "This can't be saved: it holds something drivers must not see."
const INVALID_MESSAGE = "This can't be saved: an entry isn't in the expected form."

const CODE_MESSAGES = Object.freeze({
  INSTRUCTIONS_UNVERIFIED: "Couldn't check this load's details right now; try again.",
  INSTRUCTIONS_REREAD_TOO_SOON: 'You can re-read this rate con again in a few minutes.',
  RATE_LIMITED: 'Too many changes in a short time. Try again in a few minutes.',
  INSTRUCTIONS_NO_RATE_CON: 'No rate con is on file for this load. Type the instructions instead.',
  INSTRUCTIONS_EXTRACT_BUSY: "The rate con can't be re-read right now. Try again later.",
  INSTRUCTIONS_EXTRACT_FAILED: "The rate con couldn't be read. Try again or type the instructions.",
  INSTRUCTIONS_NOTHING_TO_REVIEW: 'There is nothing to review yet.',
  INSTRUCTIONS_NO_PENDING: 'The newer reading is no longer waiting. The section has been refreshed.',
  LOAD_NOT_FOUND: "This load wasn't found.",
})
const FALLBACK_MESSAGE = 'Something went wrong with the driver instructions. Try again.'

// An error as useApi() throws it -> { hidden, message, fieldKind? }. `hidden`: the
// flag is off (a 404 with no code), so the section doesn't render at all.
export function instructionsError(err) {
  const status = err && typeof err.status === 'number' ? err.status : -1
  const code = err && typeof err.code === 'string' ? err.code : ''
  const data = err && err.data && typeof err.data === 'object' ? err.data : {}
  if (status === 404 && !code) return { hidden: true, message: '' }
  if (code === 'INSTRUCTIONS_CONTENT_NOT_ALLOWED' || code === 'INSTRUCTIONS_INVALID') {
    const fieldKind = fieldKindOf(data.field)
    const base = code === 'INSTRUCTIONS_INVALID'
      ? INVALID_MESSAGE
      : (typeof data.rule === 'string' && Object.hasOwn(RULE_MESSAGES, data.rule) ? RULE_MESSAGES[data.rule] : RULE_FALLBACK)
    return { hidden: false, message: `${base} Field: ${FIELD_KIND_WORDS[fieldKind]}.`, fieldKind }
  }
  if (Object.hasOwn(CODE_MESSAGES, code)) return { hidden: false, message: CODE_MESSAGES[code] }
  if (status === 403) return { hidden: false, message: 'Only a Super Admin or a Dispatcher can see driver instructions.' }
  if (status === 0) return { hidden: false, message: 'The request timed out. Check the connection and try again.' }
  return { hidden: false, message: FALLBACK_MESSAGE }
}

// ---------------------------------------------------------------- status
const STATUS_LABELS = Object.freeze({
  none: 'No instructions yet',
  failed: "Couldn't read the rate con",
  needs_review: 'Needs review',
  auto: 'Read from the rate con',
  reviewed: 'Reviewed',
})
const STATUS_TONES = Object.freeze({ none: 'muted', failed: 'bad', needs_review: 'warn', auto: 'ok', reviewed: 'ok' })

export function statusView(body) {
  const status = body && typeof body.status === 'string' ? body.status : ''
  const label = Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : 'Unknown'
  const tone = Object.hasOwn(STATUS_TONES, status) ? STATUS_TONES[status] : 'muted'
  let note
  if (status === 'none' || status === 'failed') note = 'Drivers see nothing for this load.'
  else if (body && body.published) note = 'Drivers see the version shown here.'
  else note = "Drivers don't see these until someone marks them reviewed."
  return { label, tone, note }
}

// The server answers 409 when nothing is stored yet or the read failed.
export function canMarkReviewed(body) {
  const status = body && body.status
  return status === 'auto' || status === 'needs_review' || status === 'reviewed'
}

const REREAD_WORDS = Object.freeze({
  insert: 'The rate con was read.',
  replace: 'The rate con was read again and the instructions were updated.',
  unchanged: 'The rate con was read again. Nothing changed.',
  pending: 'The rate con was read again. The new reading is waiting below: accept it or keep the current one.',
})
export function rereadResultText(result) {
  return typeof result === 'string' && Object.hasOwn(REREAD_WORDS, result) ? REREAD_WORDS[result] : 'The rate con was read again.'
}

// A pending re-issue beside what drivers see now, both exactly as served.
export function pendingCompare(body) {
  if (!body || !body.pending || typeof body.pending !== 'object' || !body.pending.payload) return null
  return { current: body.driverPreview, next: body.pending.payload, reasons: Array.isArray(body.pending.reasons) ? body.pending.reasons : [] }
}

// ---------------------------------------------------------------- flagged items
const FLAG_WORDS = Object.freeze({
  unusual_content: "Drivers don't see this: it holds another address or redirect wording.",
  suspicious_text: "Drivers don't see this: it reads like instructions to a computer.",
})
export function flagWords(flag) {
  return typeof flag === 'string' && Object.hasOwn(FLAG_WORDS, flag) ? FLAG_WORDS[flag] : "Drivers don't see this."
}
// An item of kind Other is saved (never refused) and never shown to drivers.
const OTHER_WHY = "Drivers don't see this: items of kind Other are never shown to drivers."
const OTHER_NOTE = 'Items of kind Other are never shown to drivers: pick another kind or remove it.'
const whyHidden = (item) => (item.category === 'other' ? OTHER_WHY : flagWords(item.flag))

// The note under an item in the edit form: kind Other never reaches drivers; an item
// the server flagged for its text is refused until it is removed or reworded.
export function draftItemNote(item) {
  if (!item || typeof item !== 'object') return ''
  if (item.category === 'other') return OTHER_NOTE
  return item.flag ? `${flagWords(item.flag)} Remove it or reword it before saving.` : ''
}

// What a successful Save or Mark reviewed says, from the server's answer.
export function doneText(prefix, body) {
  return hiddenFromDrivers(body && body.payload).length
    ? `${prefix} Drivers see this version, except the items under "Not shown to drivers".`
    : `${prefix} Drivers see this version.`
}

// The items the server marked with a `flag` in the staff payload (the driver view
// leaves them out), in payload order, with words.
export function hiddenFromDrivers(payload) {
  if (!payload || typeof payload !== 'object') return []
  const out = []
  const add = (where, label, item) => {
    if (item && item.flag) out.push({ where, label, text: String(item.text ?? ''), why: whyHidden(item) })
  }
  for (const r of Array.isArray(payload.loadRequirements) ? payload.loadRequirements : []) add('Whole load', categoryLabel(r?.category), r)
  ;(Array.isArray(payload.stops) ? payload.stops : []).forEach((s, i) => {
    const where = `Stop ${i + 1} · ${stopKindLabel(s?.kind)}`
    for (const r of Array.isArray(s?.requirements) ? s.requirements : []) add(where, categoryLabel(r?.category), r)
    for (const x of Array.isArray(s?.instructions) ? s.instructions : []) add(where, instructionKindLabel(x?.kind), x)
  })
  return out
}

// ---------------------------------------------------------------- editing
const str = (v) => (typeof v === 'string' ? v : '')
const list = (v) => (Array.isArray(v) ? v : [])

export const blankReference = () => ({ type: 'other_reference', label: '', value: '' })
export const blankRequirement = () => ({ category: 'check_in', text: '' })
export const blankInstruction = () => ({ kind: 'shipper', text: '' })
export const blankStop = (kind = 'pickup') => ({ kind, facility: '', place: '', references: [], requirements: [], instructions: [] })

function draftItem(item, key) {
  const out = { [key]: str(item?.[key]), text: str(item?.text) }
  if (item && item.flag) out.flag = item.flag
  return out
}

// The server stores each reference with a label: its own, or its kind's default
// ("Pickup #"). The draft holds only a label of its own, so a kind changed in the
// form never carries the old kind's label to the server (which applies the new
// kind's default to a blank one).
const ownLabel = (type, label) => (label && Object.hasOwn(REFERENCE_LABELS, type) && label === REFERENCE_LABELS[type] ? '' : label)

// The form's kind picker: the old kind's default label goes with the old kind.
export function setReferenceType(ref, type) {
  if (!ref || typeof ref !== 'object') return
  ref.label = ownLabel(ref.type, str(ref.label))
  ref.type = str(type)
}

// An editable copy of the staff payload. `flag` stays on a copy of a flagged
// item, for display only; editBody() never sends it.
export function editDraftFrom(payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  return {
    loadRequirements: list(p.loadRequirements).map((r) => draftItem(r, 'category')),
    stops: list(p.stops).map((s) => ({
      kind: str(s?.kind),
      facility: str(s?.facility),
      place: str(s?.place),
      references: list(s?.references).map((r) => ({ type: str(r?.type), label: ownLabel(str(r?.type), str(r?.label)), value: str(r?.value) })),
      requirements: list(s?.requirements).map((r) => draftItem(r, 'category')),
      instructions: list(s?.instructions).map((x) => draftItem(x, 'kind')),
    })),
  }
}

// The PUT body: the payload's shape, every value exactly as typed.
export function editBody(draft) {
  const d = draft && typeof draft === 'object' ? draft : {}
  return {
    payload: {
      loadRequirements: list(d.loadRequirements).map((r) => ({ category: r.category, text: r.text })),
      stops: list(d.stops).map((s) => ({
        kind: s.kind,
        facility: s.facility,
        place: s.place,
        references: list(s.references).map((r) => ({ type: r.type, label: r.label, value: r.value })),
        requirements: list(s.requirements).map((r) => ({ category: r.category, text: r.text })),
        instructions: list(s.instructions).map((x) => ({ kind: x.kind, text: x.text })),
      })),
    },
  }
}

// After a write the tabs refresh the dashboard: the open load's codes from its
// refreshed row ([] when it carries none), or null when the row is gone.
export function freshInstructionCodes(selected, rows) {
  if (!selected || !Array.isArray(rows)) return null
  const row = rows.find((r) => r && r._rowIndex === selected._rowIndex)
  if (!row) return null
  return Array.isArray(row._instructionsReview) ? row._instructionsReview : []
}
