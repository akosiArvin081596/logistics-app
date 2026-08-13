#!/usr/bin/env node
// Deterministic check on client/src/utils/voiceLadder.js — the decision logic
// behind spoken turn-by-turn callouts in the driver app's Drive Mode.
//
// WHY THIS EXISTS. Client ask (Deshorn): "on the driver's side let's enhance the
// navigation part so that they can hear the callouts and the directions."
// Speaking is one line of speechSynthesis; the whole risk is in WHEN. The
// position feed is bursty (ELD fixes ~30 s apart, which is ~700 m at highway
// speed, enough to cross three ladder bands between two samples), sometimes
// stale, and sometimes absent entirely. Every one of the four rules below is
// here because breaking it is worse than saying nothing at all:
//
//   1. EXACTLY ONCE per (routeVersion, stepIdx, phase). A callout that repeats
//      while the driver queues at the turn is how a driver mutes navigation
//      permanently — at which point the feature no longer exists.
//   2. NEVER UPWARD. Once "in 1 mile" has been said for a step, "in 2 miles"
//      for that same step is a false statement about the driver's own position.
//      This must survive a suppressed window reopening (unmute, foreground).
//   3. NEVER A BAND LONGER THAN THE STEP. "In 2 miles, turn right" on a 300 m
//      step is not a rounding error — the turn is 300 m away. The final band is
//      exempt, because it IS the instruction.
//   4. SUPPRESSION IS VISIBLE. Muted, backgrounded, or an ELD-sourced position
//      return the announcement flagged with a reason so the UI can show "voice
//      paused" rather than looking broken. The ELD case is the important one: a
//      callout computed from a 30 s-old fix can be 700 m from where it claims.
//
// EVERY CASE IS PAIRED, so a trivial implementation cannot pass:
//   - "always return null"   fails 1 (nothing ever fires)
//   - "always fire"          fails 1b (repeats), 2 (upward), 3 (short step)
//   - "fire the far band"    fails 1c (a 700 m jump must announce the NEAREST)
//   - "suppress by skipping" fails 4b (an unmuted driver would hear a stale band)
//   - "reset on every tick"  fails 5 (only a routeVersion bump may re-arm)
//
// No network, no DOM, no speechSynthesis — pure input/output.
//
//   node scripts/test-voice-ladder.mjs      # exits 1 on any failure

import {
  createVoiceLadder,
  bandIndexForDistance,
  announcementText,
  extractStreetName,
  describeManeuver,
  VOICE_PHASES,
} from '../client/src/utils/voiceLadder.js'

let pass = 0
let fail = 0

function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`)
  }
}

const MI = 1609.344
// A long interstate step — every band is shorter than it, so every band is
// legitimately reachable.
const LONG_STEP = {
  maneuver: 'TURN_RIGHT',
  instruction: 'Turn right onto <b>Beltway 8</b>',
  distanceMeters: 12000,
}
// A city step shorter than four of the five bands. Case 3's subject.
const SHORT_STEP = {
  maneuver: 'TURN_LEFT',
  instruction: 'Turn left onto S Main St',
  distanceMeters: 300,
}

function feed(ladder, distance, extra = {}) {
  return ladder.evaluate({
    routeVersion: 1,
    stepIdx: 0,
    step: LONG_STEP,
    stepDistanceMeters: LONG_STEP.distanceMeters,
    distanceMeters: distance,
    positionSource: 'phone',
    supported: true,
    voiceReady: true,
    ...extra,
  })
}
const keyOf = (r) => (r ? (r.suppressed ? `${r.phaseKey}!${r.reason}` : r.phaseKey) : null)

// ══════════════════════════════════════════════════════════════════════════════
// CASE 1 — each phase fires exactly once, in order, nearest-band-wins
// ══════════════════════════════════════════════════════════════════════════════
{
  const l = createVoiceLadder()
  check('case1 beyond every band → silence', keyOf(feed(l, 5000)), null)
  check('case1 crossing 2 mi', keyOf(feed(l, 2 * MI - 5)), '2mi')
  check('case1 still inside 2 mi → no repeat', keyOf(feed(l, 2 * MI - 400)), null)
  check('case1 still inside 2 mi → no repeat (again)', keyOf(feed(l, 1800)), null)
  check('case1 crossing 1 mi', keyOf(feed(l, 1 * MI - 5)), '1mi')
  check('case1 still inside 1 mi → no repeat', keyOf(feed(l, 1000)), null)
  check('case1 crossing half a mile', keyOf(feed(l, 0.5 * MI - 5)), 'half')
  check('case1 crossing a quarter mile', keyOf(feed(l, 0.25 * MI - 5)), 'quarter')
  check('case1 at the maneuver', keyOf(feed(l, 30)), 'now')
  check('case1 past the maneuver → silence', keyOf(feed(l, 5)), null)
  check('case1 past the maneuver → still silence', keyOf(feed(l, 0)), null)

  // 1b — the same ladder fed the SAME distance twenty times says it once.
  const l2 = createVoiceLadder()
  let spoke = 0
  for (let i = 0; i < 20; i++) if (feed(l2, 800)) spoke++
  check('case1b twenty identical fixes → one callout', spoke, 1)

  // 1c — a single 700 m ELD hop that crosses TWO bands announces the NEAREST.
  // Announcing "in half a mile" when the driver is already at a quarter mile is
  // rule 2 in miniature, and it is the normal case at 30 s fix spacing.
  const l3 = createVoiceLadder()
  feed(l3, 1 * MI - 5)
  check('case1c a hop over two bands announces the nearer one', keyOf(feed(l3, 380)), 'quarter')
  check('case1c the skipped band never arrives late', keyOf(feed(l3, 370)), null)

  // 1d — bandIndexForDistance is the primitive; it must pick nearest, not first.
  check('case1d band for 5000 m', bandIndexForDistance(5000), -1)
  check('case1d band for 3000 m', bandIndexForDistance(3000), 0)
  check('case1d band for 380 m', bandIndexForDistance(380), 3)
  check('case1d band for 10 m', bandIndexForDistance(10), 4)
  check('case1d band for a non-number', bandIndexForDistance(undefined), -1)
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 2 — never upward
// ══════════════════════════════════════════════════════════════════════════════
{
  const l = createVoiceLadder()
  check('case2 crossing 1 mi', keyOf(feed(l, 1500)), '1mi')
  // GPS noise, a re-fetch, or a stale cached fix can hand back a LARGER
  // distance for the same step. It must never re-open a band already passed.
  check('case2 a bounce back to 2 mi says nothing', keyOf(feed(l, 3000)), null)
  check('case2 a bounce back beyond every band says nothing', keyOf(feed(l, 9000)), null)
  check('case2 the ladder still advances downward afterwards', keyOf(feed(l, 700)), 'half')
  check('case2 and does not repeat that either', keyOf(feed(l, 720)), null)

  // A NEW step gets its own fresh ladder — the "once" rule is per step, not
  // per route, or only the first turn of a load would ever be announced.
  const onStep2 = l.evaluate({
    routeVersion: 1,
    stepIdx: 1,
    step: LONG_STEP,
    stepDistanceMeters: LONG_STEP.distanceMeters,
    distanceMeters: 3000,
    positionSource: 'phone',
    supported: true,
    voiceReady: true,
  })
  check('case2 the next step starts at the top of the ladder', keyOf(onStep2), '2mi')
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 3 — never announces a phase longer than its own step
// ══════════════════════════════════════════════════════════════════════════════
{
  const l = createVoiceLadder()
  const shortFeed = (d) =>
    l.evaluate({
      routeVersion: 1,
      stepIdx: 0,
      step: SHORT_STEP,
      stepDistanceMeters: SHORT_STEP.distanceMeters,
      distanceMeters: d,
      positionSource: 'phone',
      supported: true,
      voiceReady: true,
    })
  // Distance can never exceed the step's own length, so on a 300 m step the
  // only reachable bands are "quarter" (402 m — still longer than the step) and
  // "now". The quarter band must be swallowed.
  check('case3 300 m out on a 300 m step → silence, not "in a quarter mile"', keyOf(shortFeed(300)), null)
  check('case3 280 m out → still silence', keyOf(shortFeed(280)), null)
  check('case3 the turn itself IS announced', keyOf(shortFeed(40)), 'now')
  check('case3 and only once', keyOf(shortFeed(20)), null)

  // Paired: the SAME quarter-mile band on a step long enough to hold it fires
  // normally, so "never fire quarter" cannot pass case 3.
  const l2 = createVoiceLadder()
  const longQuarter = l2.evaluate({
    routeVersion: 1,
    stepIdx: 0,
    step: LONG_STEP,
    stepDistanceMeters: 4000,
    distanceMeters: 390,
    positionSource: 'phone',
    supported: true,
    voiceReady: true,
  })
  check('case3 paired: quarter mile on a 4 km step DOES fire', keyOf(longQuarter), 'quarter')

  // The exemption itself. An interchange connector or a "turn right, then
  // immediately left" pair produces steps of 20–30 m — SHORTER than the final
  // band. Those are exactly the maneuvers a driver most needs spoken, so the
  // final band must ignore the step-length rule rather than swallowing them.
  const tiny = createVoiceLadder()
  const tinyFeed = (d) =>
    tiny.evaluate({
      routeVersion: 1,
      stepIdx: 0,
      step: { maneuver: 'TURN_RIGHT', instruction: 'Turn right onto the ramp', distanceMeters: 25 },
      stepDistanceMeters: 25,
      distanceMeters: d,
      positionSource: 'phone',
      supported: true,
      voiceReady: true,
    })
  check('case3 a 25 m connector step still speaks its turn', keyOf(tinyFeed(20)), 'now')
  check('case3 and still only once', keyOf(tinyFeed(8)), null)

  // A step exactly at a band boundary is inclusive — 1 mile of step may say
  // "in 1 mile"; anything stricter would silence a very common city block run.
  const l3 = createVoiceLadder()
  const boundary = l3.evaluate({
    routeVersion: 1,
    stepIdx: 0,
    step: LONG_STEP,
    stepDistanceMeters: MI,
    distanceMeters: MI,
    positionSource: 'phone',
    supported: true,
    voiceReady: true,
  })
  check('case3 a band exactly as long as the step fires', keyOf(boundary), '1mi')
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 4 — suppressed when muted, backgrounded, or ELD-sourced
// ══════════════════════════════════════════════════════════════════════════════
{
  const muted = createVoiceLadder()
  const rM = feed(muted, 3000, { muted: true })
  check('case4 muted → suppressed', rM.suppressed, true)
  check('case4 muted → reason', rM.reason, 'muted')
  check('case4 muted → still carries the text for the UI', rM.text.length > 0, true)

  const hidden = createVoiceLadder()
  const rH = feed(hidden, 3000, { hidden: true })
  check('case4 backgrounded → suppressed', rH.suppressed, true)
  check('case4 backgrounded → reason', rH.reason, 'hidden')

  // ⚠️ The one that matters most. An ELD fix is up to 30 s old; at 65 mph that
  // is ~870 m. "Turn right now" computed from it is a wrong instruction, so
  // Drive Mode goes quiet and SAYS SO rather than guessing.
  const eld = createVoiceLadder()
  const rE = feed(eld, 3000, { positionSource: 'eld' })
  check('case4 ELD position → suppressed', rE.suppressed, true)
  check('case4 ELD position → reason', rE.reason, 'eld')
  check('case4 ELD suppression carries a human-readable label', typeof rE.reasonLabel, 'string')

  const noSupport = createVoiceLadder()
  const rU = feed(noSupport, 3000, { supported: false })
  check('case4 no speechSynthesis → suppressed', rU.reason, 'unsupported')

  // iOS refuses to speak until a user gesture has unlocked the synthesiser. The
  // "Navigate" tap is that gesture; until it happens the ladder reports 'locked'
  // so the UI can say so instead of being mysteriously silent forever.
  const locked = createVoiceLadder()
  check('case4 before the iOS gesture unlock → locked', feed(locked, 3000, { voiceReady: false }).reason, 'locked')

  // 4b — a suppressed band is CONSUMED. Unmuting must not release a stale
  // "in 2 miles" at a driver who is now 1.2 miles out; that is rule 2 arriving
  // through the back door, and it is the single most likely bug in this file.
  const unmute = createVoiceLadder()
  check('case4b muted at 2 mi', keyOf(feed(unmute, 3000, { muted: true })), '2mi!muted')
  check('case4b unmuted, still in the 2 mi band → nothing stale', keyOf(feed(unmute, 1900)), null)
  check('case4b unmuted, crossing 1 mi → speaks normally', keyOf(feed(unmute, 1500)), '1mi')
  check('case4b and that one is NOT suppressed', feed(createVoiceLadder(), 1500).suppressed, false)
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 5 — a routeVersion bump re-arms the whole ladder
// ══════════════════════════════════════════════════════════════════════════════
{
  const l = createVoiceLadder()
  check('case5 v1 crosses 2 mi', keyOf(feed(l, 3000)), '2mi')
  check('case5 v1 crosses 1 mi', keyOf(feed(l, 1500)), '1mi')
  check('case5 v1 does not repeat', keyOf(feed(l, 1500)), null)

  const bumped = (d, stepIdx = 0) =>
    l.evaluate({
      routeVersion: 2,
      stepIdx,
      step: LONG_STEP,
      stepDistanceMeters: LONG_STEP.distanceMeters,
      distanceMeters: d,
      positionSource: 'phone',
      supported: true,
      voiceReady: true,
    })
  // A reroute replaces the geometry: step 0 of the NEW route is a different
  // turn, so its 2-mile callout is new information, not a repeat.
  check('case5 after a reroute, 2 mi fires again', keyOf(bumped(3000)), '2mi')
  check('case5 the new route still dedupes', keyOf(bumped(2900)), null)
  check('case5 and still refuses to go upward', keyOf(bumped(9000)), null)

  // Paired: the version must be the ONLY thing that re-arms it. A ladder that
  // reset on every call would pass "fires again" while failing every dedupe
  // assertion above — and a ladder keyed on object identity would re-arm on
  // each 30 s poll, since the parent rebuilds the route payload every time.
  check('case5 same version, same step, no re-arm', keyOf(bumped(3000)), null)
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 6 — the spoken sentence itself
// ══════════════════════════════════════════════════════════════════════════════
{
  check('case6 street name out of an "onto" instruction', extractStreetName('Turn right onto <b>Beltway 8</b>'), 'Beltway 8')
  check('case6 street name out of an "on" instruction', extractStreetName('Continue on I-45 N toward Dallas'), 'I-45 N')
  check('case6 HTML is stripped, never rendered', extractStreetName('Turn left onto <div>Main St</div>'), 'Main St')
  check('case6 maneuver phrase', describeManeuver('TURN_SLIGHT_RIGHT'), 'keep right')
  check('case6 unknown maneuver falls back', describeManeuver('WARP_DRIVE'), 'continue')

  const twoMi = VOICE_PHASES[0]
  const now = VOICE_PHASES[VOICE_PHASES.length - 1]
  check('case6 far-band sentence', announcementText(twoMi, LONG_STEP), 'In 2 miles, turn right onto Beltway 8')
  check('case6 now-band sentence', announcementText(now, LONG_STEP), 'Turn right onto Beltway 8')
  check(
    'case6 arrival does not say "onto"',
    announcementText(now, { maneuver: 'DESTINATION', instruction: 'Your destination is on the right' }),
    'Arrive at your destination',
  )
  check(
    'case6 an unmapped maneuver speaks Google\'s own words rather than guessing',
    announcementText(now, { maneuver: 'WARP_DRIVE', instruction: 'Take the <b>third</b> exit' }),
    'Take the third exit',
  )
  check('case6 the ladder is ordered far → near', VOICE_PHASES.map((p) => p.meters).every((m, i, a) => i === 0 || m < a[i - 1]), true)
  check('case6 only the final band is step-length exempt', VOICE_PHASES.filter((p) => p.always).length, 1)
  check('case6 the exempt band is the last one', VOICE_PHASES[VOICE_PHASES.length - 1].always, true)
}

console.log(`\nvoice-ladder: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
