/**
 * voiceLadder.js — pure decision logic for spoken turn-by-turn callouts.
 *
 * Client ask (Deshorn): "on the driver's side let's enhance the navigation part
 * so that they can hear the callouts and the directions."
 *
 * WHAT MAKES THIS HARD IS NOT THE SPEAKING. `speechSynthesis.speak()` is one
 * line. The hard part is deciding WHEN, from a position feed that is bursty
 * (30 s ELD fixes), sometimes stale, and sometimes absent — and doing it so
 * that a callout is never repeated, never contradicted, and never wrong.
 *
 * Four rules, each of which exists because breaking it is worse than silence:
 *
 *  1. EXACTLY ONCE per (routeVersion, stepIdx, phase). A repeated "turn right in
 *     half a mile" while the driver is queuing at that turn is how a driver
 *     mutes navigation permanently, at which point the feature is gone.
 *  2. NEVER UPWARD. Bands are ordered far → near. Once "in 1 mile" has been
 *     announced for a step, "in 2 miles" for that same step is a lie about the
 *     driver's own position and must be unreachable, including after a
 *     suppressed window (muted, backgrounded) reopens.
 *  3. NEVER A BAND LONGER THAN THE STEP. "In 2 miles, turn right" on a 300 m
 *     step is not a rounding error, it is a wrong instruction — the turn is at
 *     300 m. Bands longer than the step are consumed silently. The final
 *     ("now") band is exempt: it IS the instruction, so a short step still gets
 *     spoken.
 *  4. SUPPRESSION IS VISIBLE, NOT SILENT. Muted, backgrounded, or an
 *     ELD-sourced position all return the announcement flagged with a reason so
 *     the UI can render "voice paused — ELD position" instead of appearing
 *     broken. The ELD case matters most: a callout computed from a 30 s-old fix
 *     places the driver up to 700 m from where the callout assumes, which is
 *     worse than saying nothing.
 *
 * Pure: no DOM, no speechSynthesis, no timers. `client/package.json` is
 * `"type": "module"`, so this is directly `node`-importable and is locked by
 * `scripts/test-voice-ladder.mjs`.
 */

const MI = 1609.344

/**
 * The ladder, ordered FAR → NEAR. Index order is the "never upward" ordering:
 * a fired index may only ever increase within a (routeVersion, stepIdx).
 */
export const VOICE_PHASES = [
  { key: '2mi', meters: 2 * MI, label: 'In 2 miles' },
  { key: '1mi', meters: 1 * MI, label: 'In 1 mile' },
  { key: 'half', meters: 0.5 * MI, label: 'In half a mile' },
  { key: 'quarter', meters: 0.25 * MI, label: 'In a quarter mile' },
  // `always: true` exempts this band from rule 3 — see the header.
  { key: 'now', meters: 60, label: '', always: true },
]

export const SUPPRESS_REASONS = {
  muted: 'Voice muted',
  hidden: 'App in background',
  eld: 'ELD position — too stale for callouts',
  unsupported: 'Voice not supported on this device',
  locked: 'Tap Navigate to enable voice',
}

export function stripHtml(s) {
  return (s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * "Turn right onto Mabini St toward X" → "Mabini St".
 * Shared with the Drive Mode banner so the street the driver READS and the
 * street they HEAR can never disagree.
 */
export function extractStreetName(instruction) {
  const clean = stripHtml(instruction)
  const onto = clean.match(/\bonto\s+(.+?)(?:\s+toward\b|\s+for\b|$)/i)
  if (onto) return onto[1].trim()
  const on = clean.match(/\bon\s+(.+?)(?:\s+toward\b|\s+for\b|$)/i)
  if (on) return on[1].trim()
  return clean
}

const MANEUVER_PHRASES = {
  TURN_LEFT: 'turn left',
  TURN_RIGHT: 'turn right',
  TURN_SLIGHT_LEFT: 'keep left',
  TURN_SLIGHT_RIGHT: 'keep right',
  TURN_SHARP_LEFT: 'make a sharp left',
  TURN_SHARP_RIGHT: 'make a sharp right',
  U_TURN_LEFT: 'make a U-turn',
  U_TURN_RIGHT: 'make a U-turn',
  STRAIGHT: 'continue straight',
  RAMP_LEFT: 'take the ramp on the left',
  RAMP_RIGHT: 'take the ramp on the right',
  MERGE: 'merge',
  FORK_LEFT: 'keep left at the fork',
  FORK_RIGHT: 'keep right at the fork',
  FERRY: 'board the ferry',
  ROUNDABOUT_LEFT: 'enter the roundabout',
  ROUNDABOUT_RIGHT: 'enter the roundabout',
  DEPART: 'start out',
  NAME_CHANGE: 'continue',
  DESTINATION: 'arrive at your destination',
}

export function describeManeuver(maneuver) {
  return MANEUVER_PHRASES[maneuver] || 'continue'
}

/**
 * Build the spoken sentence for a band + step. Deliberately falls back to
 * Google's own instruction text when the maneuver code is one we do not map —
 * a slightly clunky sentence beats a confidently wrong "continue".
 */
export function announcementText(phase, step) {
  if (!phase || !step) return ''
  const maneuver = step.maneuver || ''
  const action = MANEUVER_PHRASES[maneuver] || ''
  const street = extractStreetName(step.instruction)
  let core
  if (action) {
    core = maneuver === 'DESTINATION' || !street || street === action ? action : `${action} onto ${street}`
  } else {
    core = stripHtml(step.instruction) || 'continue'
  }
  if (!phase.label) return core.charAt(0).toUpperCase() + core.slice(1)
  return `${phase.label}, ${core}`
}

/**
 * Index of the NEAREST band the driver has already entered, or -1 when they are
 * still beyond the furthest band. Scanning from the near end is what makes a
 * single fix that skips three bands (a 30 s ELD gap at highway speed covers
 * 700 m, which crosses half a mile AND a quarter mile) announce the nearest one
 * rather than a stale far one.
 */
export function bandIndexForDistance(distanceMeters, phases = VOICE_PHASES) {
  if (!Number.isFinite(distanceMeters)) return -1
  for (let i = phases.length - 1; i >= 0; i--) {
    if (distanceMeters <= phases[i].meters) return i
  }
  return -1
}

/**
 * @param options {
 *   phases,                  // override the ladder (tests)
 * }
 * @returns { evaluate(input), reset(), state() }
 *
 * evaluate(input) where input = {
 *   routeVersion,            // bump ⇒ new route ⇒ every band is fresh again
 *   stepIdx,
 *   step,                    // { maneuver, instruction, distanceMeters }
 *   distanceMeters,          // ALONG-ROUTE distance to the maneuver
 *   stepDistanceMeters,      // the step's own length (rule 3)
 *   muted, hidden,           // booleans
 *   positionSource,          // 'phone' | 'eld' | ...
 *   voiceReady,              // false until the iOS gesture unlock has happened
 *   supported,               // false when speechSynthesis is absent
 * }
 *
 * returns null when nothing new crossed, else
 *   { phase, phaseKey, text, distanceMeters, suppressed:false }
 *   { phase, phaseKey, text, distanceMeters, suppressed:true, reason }
 */
export function createVoiceLadder(options = {}) {
  const phases = options.phases || VOICE_PHASES
  let version = null
  let firedByStep = new Map() // stepIdx → highest band index consumed

  function reset() {
    version = null
    firedByStep = new Map()
  }

  function suppressionReason(input) {
    if (input.supported === false) return 'unsupported'
    if (input.muted) return 'muted'
    if (input.hidden) return 'hidden'
    if (input.voiceReady === false) return 'locked'
    // ⚠️ Deliberately last: a driver who is muted AND on ELD should be told the
    // thing they can act on. The ELD reason is informational, the others are not.
    if (input.positionSource && input.positionSource !== 'phone') return 'eld'
    return null
  }

  function evaluate(input = {}) {
    const { routeVersion = 0, stepIdx = 0, step = null, distanceMeters, stepDistanceMeters } = input
    if (!step || !Number.isFinite(distanceMeters) || stepIdx < 0) return null

    if (version !== routeVersion) {
      // A reroute replaces the geometry, so every band on every step is new.
      version = routeVersion
      firedByStep = new Map()
    }

    const bandIdx = bandIndexForDistance(distanceMeters, phases)
    if (bandIdx < 0) return null

    const already = firedByStep.has(stepIdx) ? firedByStep.get(stepIdx) : -1
    if (bandIdx <= already) return null // rule 1 + rule 2

    const phase = phases[bandIdx]

    // Rule 3 — a band longer than the step is consumed without speaking, which
    // is also what stops it re-firing on the next tick.
    if (!phase.always && Number.isFinite(stepDistanceMeters) && phase.meters > stepDistanceMeters) {
      firedByStep.set(stepIdx, bandIdx)
      return null
    }

    // Consume BEFORE deciding whether to speak. A suppressed band must not come
    // back later as an upward announcement once the driver unmutes.
    firedByStep.set(stepIdx, bandIdx)

    const text = announcementText(phase, step)
    const reason = suppressionReason(input)
    if (reason) {
      return {
        phase,
        phaseKey: phase.key,
        text,
        distanceMeters,
        suppressed: true,
        reason,
        reasonLabel: SUPPRESS_REASONS[reason] || reason,
      }
    }
    return { phase, phaseKey: phase.key, text, distanceMeters, suppressed: false, reason: null }
  }

  return {
    evaluate,
    reset,
    state() {
      return { version, fired: new Map(firedByStep) }
    },
  }
}
