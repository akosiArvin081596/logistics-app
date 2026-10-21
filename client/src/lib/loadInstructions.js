// Rate-con driver instructions, the driver's screen (plan PR 4): what the load card
// (components/driver/LoadInstructions.vue) and the list chips (LoadCard.vue) show.
// Display only.
//
// The server is the gate (lib/driver-instructions-runtime.js). GET
// /api/driver/loads/:loadId/instructions answers 404 while the screen's flag is off,
// 403 for a load that isn't the driver's, { state: "checking" } until dispatch has
// published it, and otherwise the published payload, already filtered and ordered,
// with its highlight codes. GET /api/driver/:driverName carries
// `_instructions: { state, highlights }` per load (codes only), and only while the
// flag is on. Nothing here drops, reorders or rewrites what the server sent: each
// item is shown once, in its order; a code the app has no chip for is simply not a
// chip. Runner: scripts/test-load-instructions-client.mjs.
import { CATEGORY_LABELS } from './driverInstructionsView.js'

export const CARD_TITLE = 'Load instructions'
export const CHECKING_TEXT = 'Load instructions are being checked by dispatch.'
export const LOADING_TEXT = 'Loading load instructions…'
export const ERROR_TEXT = "Load instructions couldn't be loaded."
export const STALE_TEXT = "Couldn't check for newer load instructions."
export const MORE_LABEL = 'More from the rate con (directions, warehouse notes)'

// The codes a chip can show: the server's critical categories, in its order (pinned
// equal to lib/driver-instructions.js CRITICAL_CATEGORIES).
export const CHIP_CODES = Object.freeze(['high_value', 'no_unattended', 'same_driver', 'seal', 'hazmat', 'temperature', 'team', 'ppe'])
// Instruction kinds shown behind "More from the rate con", per stop.
export const MORE_KINDS = Object.freeze(['directions', 'warehouse'])

export function driverInstructionsUrl(loadId) {
  return `/api/driver/loads/${encodeURIComponent(String(loadId ?? ''))}/instructions`
}

// The server's load key (normLoadKey()): trimmed, lower case, no leading "#".
export function instructionsKey(loadId) {
  return String(loadId ?? '').trim().toLowerCase().replace(/^#/, '')
}

export function chipsOf(codes) {
  if (!Array.isArray(codes)) return []
  return codes.filter((c) => typeof c === 'string' && CHIP_CODES.includes(c)).map((code) => ({ code, label: CATEGORY_LABELS[code] }))
}

// The list card's chips: the published load's codes, nothing else.
export function listChips(load) {
  const s = load && typeof load === 'object' ? load._instructions : null
  return s && typeof s === 'object' && s.state === 'published' ? chipsOf(s.highlights) : []
}

// A load is read when the payload carried its key and the server has something for it.
export function shouldFetch(summary) {
  return !!summary && typeof summary === 'object' && summary.state !== 'none'
}

// The route's answer, as sent: { state, highlights, payload }.
export function answerOf(body) {
  const b = body && typeof body === 'object' ? body : {}
  if (b.state === 'published' && b.payload && typeof b.payload === 'object') {
    return { state: 'published', highlights: Array.isArray(b.highlights) ? b.highlights : [], payload: b.payload }
  }
  return { state: b.state === 'checking' ? 'checking' : 'none', highlights: [], payload: null }
}

// The store's entry per load: the last answer, and whether a read is running, failed
// (the last answer stays on screen) or was refused (404: the flag off; 403: not his
// load), which leaves nothing to show.
export function entryLoading(prev) {
  return { answer: prev?.answer || null, loading: true, failed: false, gone: false }
}
export function entryAfter(prev, { body, error } = {}) {
  if (!error) return { answer: answerOf(body), loading: false, failed: false, gone: false }
  if (error.status === 404 || error.status === 403) return { answer: null, loading: false, failed: false, gone: true }
  return { answer: prev?.answer || null, loading: false, failed: true, gone: false }
}

// What the card shows: hidden | loading | checking | card | error (`stale` when a
// newer read failed and the last answer stays).
export function cardView(summary, entry) {
  if (!summary || typeof summary !== 'object') return { kind: 'hidden' }
  if (entry?.gone) return { kind: 'hidden' }
  const a = entry?.answer
  if (a) {
    if (a.state === 'published') return { kind: 'card', stale: !!entry.failed }
    if (a.state === 'checking') return { kind: 'checking' }
    return { kind: 'hidden' }
  }
  if (entry?.failed) return { kind: 'error' }
  return shouldFetch(summary) ? { kind: 'loading' } : { kind: 'hidden' }
}

// One stop's lists for the card, in the server's order: directions and warehouse
// notes go behind "More from the rate con"; every item appears exactly once.
export function stopParts(stop) {
  const list = (v) => (Array.isArray(v) ? v : [])
  const s = stop && typeof stop === 'object' ? stop : {}
  const instructions = list(s.instructions)
  return {
    references: list(s.references),
    requirements: list(s.requirements),
    instructions: instructions.filter((x) => !MORE_KINDS.includes(x?.kind)),
    more: instructions.filter((x) => MORE_KINDS.includes(x?.kind)),
  }
}

// The socket event `driver-instructions-changed` carries { loadId } only.
export function isInstructionsEvent(payload) {
  return !!payload && typeof payload.loadId === 'string' && payload.loadId.length > 0 && payload.loadId.length <= 80
}
