// Driver safety for voice notes (49 CFR 392.82: no hand-held phone use while
// driving, which includes sitting at a light or in traffic). The driver app's
// copy of the server's lib/voice-note-gate.js decision, which it cannot load;
// scripts/test-voice-note-text.mjs pins the two to the same answer for every
// case. The server refuses a Driver's upload while the truck is moving (409
// VOICE_NOTE_WHILE_MOVING); this decides the record button before that.
//
//   unknown  no fix, a fix older than 3 minutes (engine off, dead zone), one
//            stamped more than 2 minutes ahead, or no speed: allowed, with the note
//   moving   a fresh fix above 5 mph: the mic is disabled
//   stopping stopped under 2 minutes (a light, traffic), or stopped since an
//            unknown time: disabled
//   parked   stopped 2 minutes or more: allowed
//
// The note under the composer shows in every state. It is a safety aid, not a
// compliance guarantee: a stale fix while driving reads as unknown.

export const MOVING_MPS = 2.235
export const FRESH_MS = 3 * 60 * 1000
export const FUTURE_SKEW_MS = 2 * 60 * 1000
export const STOPPED_MIN_MS = 2 * 60 * 1000

const isMoving = (fix) => !!fix && Number.isFinite(fix.speed) && fix.speed > MOVING_MPS

export function fixState(fix, nowMs) {
  if (!fix || !Number.isFinite(fix.location_date_ms) || !Number.isFinite(nowMs)) return 'unknown'
  const age = nowMs - fix.location_date_ms
  if (!(age >= -FUTURE_SKEW_MS) || !(age <= FRESH_MS)) return 'unknown'
  if (!Number.isFinite(fix.speed)) return 'unknown'
  return isMoving(fix) ? 'moving' : 'stopped'
}

// { allowed, state }: "moving", "stopping", "parked" or "unknown".
export function recordGate({ fix, stoppedSince, nowMs }) {
  const state = fixState(fix, nowMs)
  if (state === 'unknown') return { allowed: true, state }
  if (state === 'moving') return { allowed: false, state }
  const stoppedFor = Number.isFinite(stoppedSince) ? nowMs - stoppedSince : NaN
  if (!(stoppedFor >= STOPPED_MIN_MS)) return { allowed: false, state: 'stopping' }
  return { allowed: true, state: 'parked' }
}

export const VOICE_GATE_BLOCKED_NOTE = 'Voice notes are off while the truck is moving. Park first, then record.'
export const VOICE_GATE_PARKED_NOTE = 'Record only when parked.'
export const voiceGateNote = (gate) => (gate && gate.allowed === false ? VOICE_GATE_BLOCKED_NOTE : VOICE_GATE_PARKED_NOTE)

// The gate's input from the truck's latest ELD fix as the driver app holds it,
// in THIS PHONE'S clock: { fix: { speed, location_date_ms }, stoppedSince }, or
// null when there is no fix. `prev` is the previous answer.
//
// - GET /api/driver/position gives the fix's age (lastPingAge, measured on the
//   server) and stoppedSinceMs (server time). The fix is dated now minus its
//   age, and stoppedSinceMs moves by the same difference, so a phone clock that
//   is off never makes a moving truck look stale or a parked one look fresh.
// - The live feed (socket location-update) carries no stoppedSinceMs: a moving
//   fix has none, a stopped one keeps the stop already known, and the first
//   stopped fix after moving starts the stop at its own time (the 2-minute wait
//   counts from there).
// - A phone GPS fix is never the basis: it changes nothing.
export function eldMotion(raw, prev, nowMs) {
  if (!raw) return null
  if (raw.source === 'phone') return prev || null
  const speed = Number.isFinite(raw.speed) ? raw.speed : NaN
  const stamped = Date.parse(raw.timestamp || '')
  const age = Number(raw.lastPingAge)
  const fixMs = raw.lastPingAge != null && Number.isFinite(age) ? nowMs - age : stamped
  if (!Number.isFinite(fixMs)) return null
  const fix = { speed, location_date_ms: fixMs }
  if (isMoving(fix)) return { fix, stoppedSince: null }
  if (raw.stoppedSinceMs != null && Number.isFinite(Number(raw.stoppedSinceMs))) {
    const shift = Number.isFinite(stamped) ? fixMs - stamped : 0
    return { fix, stoppedSince: Number(raw.stoppedSinceMs) + shift }
  }
  if (prev && prev.fix && !isMoving(prev.fix) && Number.isFinite(prev.stoppedSince)) return { fix, stoppedSince: prev.stoppedSince }
  return { fix, stoppedSince: fixMs }
}
