/**
 * routeProgress.js — pure route-geometry math for driver turn-by-turn navigation.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS PURE
 * ----------------------------------------
 * Drive Mode used to advance a step only when the driver came within 25 m of
 * that step's polyline END, one step per GPS update, monotonically, with no
 * bearing or offset check. That works on a phone emitting a fix every second.
 * It cannot work on a truck: ELD fixes land ~30 s apart, which is ~700 m of
 * travel at highway speed, so the 25 m window is almost never sampled and the
 * banner sits on step 0 for the whole load. Drive Mode therefore only ever
 * functioned on one hardcoded phone-GPS test load.
 *
 * The replacement resyncs from scratch on every fix: project the position onto
 * the route polyline, convert the match to a distance-along-route offset, and
 * derive the step index from that offset. Nothing is incremental, so a phone
 * lock, a tunnel, or a 40-minute gap resyncs correctly on the next fix instead
 * of leaving the pointer stranded.
 *
 * FORWARD BIAS IS THE LOAD-BEARING PART. A route that crosses itself — every
 * cloverleaf, every out-and-back, every downtown grid loop — has two points on
 * the polyline within metres of each other but thousands of metres apart in
 * route order. A plain global nearest-point search picks whichever is a hair
 * closer, so one noisy fix on an overpass rewinds navigation by an hour. The
 * matcher therefore searches a corridor that starts just behind the previous
 * offset and runs forward, and only falls back to a global search when the
 * corridor genuinely contains no nearby route point (an off-route driver, or a
 * long gap in fixes). Even that fallback prefers a forward candidate.
 *
 * No imports, no DOM, no network: `client/package.json` is `"type": "module"`,
 * so this file is directly `node`-importable and is locked by
 * `scripts/test-route-progress.mjs`.
 */

// Degrees→metres scale factors. A local equirectangular projection is exact
// enough at the scale of one polyline segment (tens of metres to a few km) and
// is ~40x cheaper than haversine inside the per-segment inner loop, which runs
// over thousands of points on every GPS fix.
const METERS_PER_DEG_LAT = 110574
const METERS_PER_DEG_LNG_EQUATOR = 111320
const EARTH_RADIUS_M = 6371008.8

export function toRad(deg) {
  return (deg * Math.PI) / 180
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Accept every point shape this codebase produces:
 *   - the server's route/step polylines: { latitude, longitude }
 *   - Google Maps + local UI code:       { lat, lng }
 * Returns null for anything non-finite so a single bad row cannot poison a path.
 */
export function normalizePoint(p) {
  if (!p || typeof p !== 'object') return null
  const lat = Number.isFinite(p.lat) ? p.lat : p.latitude
  const lng = Number.isFinite(p.lng) ? p.lng : p.longitude
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { lat, lng }
}

export function normalizePath(points) {
  if (!Array.isArray(points)) return []
  const out = []
  for (const p of points) {
    const n = normalizePoint(p)
    if (n) out.push(n)
  }
  return out
}

/** Great-circle distance in metres. Used for cumulative route length, where the
 *  errors of a flat projection would compound over hundreds of segments. */
export function haversineMeters(a, b) {
  const pa = normalizePoint(a)
  const pb = normalizePoint(b)
  if (!pa || !pb) return Infinity
  const dLat = toRad(pb.lat - pa.lat)
  const dLng = toRad(pb.lng - pa.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(pa.lat)) * Math.cos(toRad(pb.lat)) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

/**
 * Perpendicular projection of `p` onto segment a→b.
 *
 * ⚠️ The scaling by cos(lat) is the whole point of this function. The previous
 * in-component implementation (DriverRouteMap's snapToRoute) compared SQUARED
 * DEGREES with no scaling, so its single "80 m" threshold was really ~80 m
 * north-south and ~104 m east-west at 40°N — anisotropic, and the anisotropy
 * grows with latitude. Distances here are honest metres in every direction.
 */
export function projectOntoSegment(p, a, b) {
  const pp = normalizePoint(p)
  const pa = normalizePoint(a)
  const pb = normalizePoint(b)
  if (!pp || !pa || !pb) return null
  const kx = METERS_PER_DEG_LNG_EQUATOR * Math.cos(toRad((pa.lat + pb.lat) / 2))
  const ky = METERS_PER_DEG_LAT
  const bx = (pb.lng - pa.lng) * kx
  const by = (pb.lat - pa.lat) * ky
  const px = (pp.lng - pa.lng) * kx
  const py = (pp.lat - pa.lat) * ky
  const lenSq = bx * bx + by * by
  let t = lenSq === 0 ? 0 : (px * bx + py * by) / lenSq
  t = clamp(t, 0, 1)
  const projX = t * bx
  const projY = t * by
  return {
    t,
    lat: pa.lat + (pb.lat - pa.lat) * t,
    lng: pa.lng + (pb.lng - pa.lng) * t,
    distanceMeters: Math.hypot(projX - px, projY - py),
  }
}

/**
 * Precompute the cumulative along-route distance of every polyline vertex.
 * Everything downstream (step index, distance-to-maneuver, remaining distance,
 * the forward corridor) is expressed as a single scalar offset in metres, which
 * is what makes "am I ahead of or behind where I was?" answerable at all.
 */
export function buildRouteIndex(points) {
  const path = normalizePath(points)
  const cumulative = new Array(path.length)
  cumulative[0] = 0
  for (let i = 1; i < path.length; i++) {
    cumulative[i] = cumulative[i - 1] + haversineMeters(path[i - 1], path[i])
  }
  return {
    path,
    cumulative,
    totalMeters: path.length ? cumulative[path.length - 1] : 0,
  }
}

/** First segment index i whose far end (cumulative[i+1]) reaches `target`. */
function firstSegmentAtOrAfter(cumulative, target) {
  let lo = 0
  let hi = cumulative.length - 2
  if (hi < 0) return 0
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cumulative[mid + 1] >= target) hi = mid
    else lo = mid + 1
  }
  return lo
}

function scanSegments(index, point, fromSeg, toSeg) {
  const { path, cumulative } = index
  let best = null
  const last = Math.min(toSeg, path.length - 2)
  for (let i = Math.max(0, fromSeg); i <= last; i++) {
    const proj = projectOntoSegment(point, path[i], path[i + 1])
    if (!proj) continue
    if (best === null || proj.distanceMeters < best.distanceMeters) {
      const segLen = cumulative[i + 1] - cumulative[i]
      best = {
        segIdx: i,
        t: proj.t,
        lat: proj.lat,
        lng: proj.lng,
        distanceMeters: proj.distanceMeters,
        offsetMeters: cumulative[i] + segLen * proj.t,
      }
    }
  }
  return best
}

/** Unconstrained nearest point on the whole polyline. Used for cosmetic pin
 *  snapping, where there is no previous offset to bias against. */
export function nearestPointOnPath(index, point) {
  if (!index || !index.path || index.path.length < 2) return null
  return scanSegments(index, point, 0, index.path.length - 2)
}

export const MATCH_DEFAULTS = {
  // Ceiling on plausible ground speed when sizing the forward corridor from
  // elapsed time. 45 m/s ≈ 100 mph: far above any legal truck speed, so it can
  // only ever make the corridor too generous, never too tight.
  maxSpeedMps: 45,
  // How far BEHIND the previous offset the corridor reaches. This is a GPS
  // jitter allowance, not a reversal allowance — keep it small or a cloverleaf
  // can rewind through it.
  backTrackToleranceM: 60,
  // Corridor floor, for a first fix or a same-second update.
  minForwardWindowM: 1500,
  // A corridor match worse than this means we probably are not on the corridor
  // at all (off route, or a long unsampled gap) — escalate to a global search.
  offRouteToleranceM: 120,
  // In the global fallback, a forward candidate wins unless a backward one is
  // better by more than this. Prevents an overpass from rewinding the route.
  forwardPreferenceM: 75,
}

/**
 * Match a raw GPS position to a distance-along-route offset.
 *
 * @param index   buildRouteIndex() output
 * @param point   { lat, lng } | { latitude, longitude }
 * @param options {
 *   previousOffsetMeters: number|null   // null ⇒ first fix, global search
 *   elapsedMs: number|null              // since the previous match; sizes the corridor
 *   ...MATCH_DEFAULTS overrides
 * }
 * @returns {
 *   offsetMeters, segIdx, t, lat, lng,
 *   distanceMeters,   // perpendicular distance from the route (the deviation signal)
 *   matchMode,        // 'initial' | 'forward' | 'global'
 *   movedBackward     // true only when a global resync genuinely went backwards
 * } | null
 */
export function matchToRoute(index, point, options = {}) {
  if (!index || !index.path || index.path.length < 2) return null
  const pt = normalizePoint(point)
  if (!pt) return null
  const o = { ...MATCH_DEFAULTS, ...options }
  const prev = Number.isFinite(o.previousOffsetMeters) ? o.previousOffsetMeters : null

  if (prev === null) {
    const g = scanSegments(index, pt, 0, index.path.length - 2)
    return g ? { ...g, matchMode: 'initial', movedBackward: false } : null
  }

  // ── Stage 1: forward corridor ───────────────────────────────────────────────
  // Sized by elapsed time so a 40-minute gap widens the corridor by 40 minutes
  // of travel rather than declaring the driver off-route.
  const elapsedSec = Number.isFinite(o.elapsedMs) && o.elapsedMs > 0 ? o.elapsedMs / 1000 : 0
  const forwardWindow = Math.max(o.minForwardWindowM, elapsedSec * o.maxSpeedMps * 1.5)
  const lo = prev - o.backTrackToleranceM
  const hi = prev + forwardWindow
  const fromSeg = firstSegmentAtOrAfter(index.cumulative, lo)
  const toSeg = firstSegmentAtOrAfter(index.cumulative, hi)
  const local = scanSegments(index, pt, fromSeg, toSeg)
  if (local && local.distanceMeters <= o.offRouteToleranceM) {
    return { ...local, matchMode: 'forward', movedBackward: false }
  }

  // ── Stage 2: global resync, forward-preferring ──────────────────────────────
  // Reached when the corridor holds nothing close: the driver left the route, or
  // the fix is so far ahead that even the time-sized corridor missed it.
  const globalAny = scanSegments(index, pt, 0, index.path.length - 2)
  if (!globalAny) return local ? { ...local, matchMode: 'forward', movedBackward: false } : null
  const forwardFrom = firstSegmentAtOrAfter(index.cumulative, lo)
  const globalForward = scanSegments(index, pt, forwardFrom, index.path.length - 2)
  let chosen = globalAny
  if (
    globalForward &&
    globalForward.distanceMeters <= globalAny.distanceMeters + o.forwardPreferenceM
  ) {
    chosen = globalForward
  }
  // Keep the corridor answer when the global search is not meaningfully better;
  // a tie must not be an excuse to jump.
  if (local && local.distanceMeters <= chosen.distanceMeters + 1) {
    return { ...local, matchMode: 'forward', movedBackward: false }
  }
  return {
    ...chosen,
    matchMode: 'global',
    movedBackward: chosen.offsetMeters < prev - o.backTrackToleranceM,
  }
}

/**
 * Start offset (metres along the route) of every step, plus a terminal entry so
 * `stepOffsets[i + 1]` is always the distance at which step i's maneuver occurs.
 *
 * Three sources, in descending order of trustworthiness:
 *   1. `step.startIdx` — the index into the route polyline where the step
 *      begins. Exact, and the only source that survives Google's step polylines
 *      being downsampled separately from the route polyline.
 *   2. `step.polyline[0]` projected onto the route, accumulated forward so a
 *      self-crossing route cannot map a later step behind an earlier one.
 *   3. A cumulative sum of `step.distanceMeters`. Always available, and correct
 *      to within the rounding Google applies to each step.
 *
 * The result is forced monotone non-decreasing whichever source ran, because
 * every consumer (step lookup, distance-to-maneuver, remaining distance) is
 * only meaningful on a monotone array.
 */
export function buildStepOffsets(steps, index) {
  const list = Array.isArray(steps) ? steps : []
  const total = index && Number.isFinite(index.totalMeters) ? index.totalMeters : 0
  const offsets = new Array(list.length + 1)
  offsets[0] = 0
  let running = 0
  let prevOffset = 0
  for (let i = 0; i < list.length; i++) {
    const step = list[i] || {}
    let start = null

    if (
      index &&
      Number.isFinite(step.startIdx) &&
      step.startIdx >= 0 &&
      step.startIdx < index.cumulative.length
    ) {
      start = index.cumulative[step.startIdx]
    } else if (index && index.path.length >= 2 && Array.isArray(step.polyline) && step.polyline.length) {
      const m = matchToRoute(index, step.polyline[0], {
        previousOffsetMeters: i === 0 ? null : prevOffset,
        // Steps are contiguous, so the next one starts within this one's length.
        minForwardWindowM: Math.max(1500, (step.distanceMeters || 0) * 2 + 500),
        offRouteToleranceM: 250,
      })
      if (m) start = m.offsetMeters
    }

    if (start === null) start = running
    if (i === 0) start = 0
    if (start < prevOffset) start = prevOffset
    if (total > 0 && start > total) start = total
    offsets[i] = start
    prevOffset = start
    running += step.distanceMeters || 0
  }
  const tail = total > 0 ? total : running
  offsets[list.length] = Math.max(prevOffset, tail)
  return offsets
}

/**
 * Which step is the driver on, given an along-route offset? Largest i with
 * stepOffsets[i] <= offset. This is a derivation, not an increment: it is
 * correct for a driver who has been in a tunnel for 20 minutes, and it cannot
 * drift out of sync with the offset the way a hand-advanced pointer does.
 */
export function stepIndexForOffset(stepOffsets, offsetMeters, stepCount) {
  if (!Array.isArray(stepOffsets) || stepOffsets.length < 2) return 0
  const n = Number.isFinite(stepCount) ? stepCount : stepOffsets.length - 1
  if (n <= 0) return 0
  if (!Number.isFinite(offsetMeters)) return 0
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (stepOffsets[mid] <= offsetMeters) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Along-route metres from the driver to the end of the current step, i.e. to
 *  the next maneuver. Never a straight line — the old banner used haversine to
 *  the step's end point, which under-reads badly on any curve or switchback. */
export function distanceToManeuver(stepOffsets, stepIdx, offsetMeters) {
  if (!Array.isArray(stepOffsets) || stepIdx < 0 || stepIdx + 1 >= stepOffsets.length) return null
  if (!Number.isFinite(offsetMeters)) return null
  return Math.max(0, stepOffsets[stepIdx + 1] - offsetMeters)
}

/** Route metres still to drive. */
export function remainingMeters(index, offsetMeters) {
  if (!index || !Number.isFinite(index.totalMeters)) return null
  if (!Number.isFinite(offsetMeters)) return index ? index.totalMeters : null
  return Math.max(0, index.totalMeters - offsetMeters)
}

/**
 * Seconds still to drive: the un-driven fraction of the current step plus every
 * later step in full. Pro-rating the current step by distance is what stops the
 * ETA freezing for the whole of a 40-mile interstate step.
 */
export function remainingSeconds(steps, stepOffsets, stepIdx, offsetMeters) {
  const list = Array.isArray(steps) ? steps : []
  if (!list.length) return null
  let total = 0
  for (let i = Math.max(0, stepIdx) + 1; i < list.length; i++) {
    total += list[i].durationSec || 0
  }
  const cur = list[Math.max(0, stepIdx)]
  if (cur) {
    const curDur = cur.durationSec || 0
    const start = stepOffsets && stepOffsets[stepIdx]
    const end = stepOffsets && stepOffsets[stepIdx + 1]
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && Number.isFinite(offsetMeters)) {
      const frac = clamp((end - offsetMeters) / (end - start), 0, 1)
      total += curDur * frac
    } else {
      total += curDur
    }
  }
  return total
}

export const DEVIATION_DEFAULTS = {
  // Half a US highway lane group plus GPS error. Below this, a snapped pin is
  // indistinguishable from being on the road.
  offRouteMeters: 80,
  // GPS noise is uncorrelated between fixes; a genuine wrong turn is not. Three
  // consecutive confirmations is the cheapest filter that separates them.
  confirmSamples: 3,
  cooldownMs: 45000,
  // Hard ceiling per trip. A reroute is a billed Google Routes call; a truck
  // stuck in a yard with a bad route must not be able to bill unboundedly.
  maxReroutes: 5,
  // A confirming sample must be this far from the previously counted one.
  // ⚠️ This is the parked-truck guard: a truck shut down 300 m off route emits
  // the same coordinate forever, which would otherwise confirm within three
  // fixes and then re-confirm after every cooldown for the whole rest period.
  minMovementMeters: 40,
}

/**
 * Deviation-triggered reroute gate.
 *
 * Replaces a purely time-based rule ("moved 0.06 mi AND 60 s elapsed → refetch")
 * that rerouted a driver who was perfectly on route and never rerouted one who
 * was not. This is also the cost control: at a 60 s poll the old rule authorised
 * ~600 Google Routes calls per driver per day; deviation-triggered is ~20.
 *
 * Stateful but pure — no timers, no clock reads. The caller supplies `timestamp`.
 */
export function createDeviationDetector(options = {}) {
  const o = { ...DEVIATION_DEFAULTS, ...options }
  let consecutive = 0
  let lastCountedPoint = null
  let lastRerouteAt = -Infinity
  let rerouteCount = 0

  function reset(opts = {}) {
    consecutive = 0
    lastCountedPoint = null
    if (opts.clearBudget) {
      rerouteCount = 0
      lastRerouteAt = -Infinity
    }
  }

  function update({ point, distanceFromRouteMeters, timestamp = 0 } = {}) {
    const base = { offRoute: false, consecutive, shouldReroute: false, reason: 'unknown', rerouteCount }
    if (!Number.isFinite(distanceFromRouteMeters)) {
      return { ...base, reason: 'no-match' }
    }
    if (distanceFromRouteMeters <= o.offRouteMeters) {
      consecutive = 0
      lastCountedPoint = null
      return { ...base, consecutive: 0, reason: 'on-route' }
    }

    const p = normalizePoint(point)
    if (p && lastCountedPoint && haversineMeters(p, lastCountedPoint) < o.minMovementMeters) {
      // Off route but not moving. Parked in a yard, a truck stop, a customer's
      // lot — none of which is a wrong turn, and none of which a new route fixes.
      return { ...base, offRoute: true, reason: 'stationary' }
    }

    consecutive += 1
    if (p) lastCountedPoint = p

    if (consecutive < o.confirmSamples) {
      return { ...base, offRoute: true, consecutive, reason: 'confirming' }
    }
    if (rerouteCount >= o.maxReroutes) {
      return { ...base, offRoute: true, consecutive, reason: 'cap-reached' }
    }
    if (Number.isFinite(timestamp) && timestamp - lastRerouteAt < o.cooldownMs) {
      return { ...base, offRoute: true, consecutive, reason: 'cooldown' }
    }

    lastRerouteAt = Number.isFinite(timestamp) ? timestamp : 0
    rerouteCount += 1
    consecutive = 0
    lastCountedPoint = null
    return { offRoute: true, consecutive: 0, shouldReroute: true, reason: 'deviation', rerouteCount }
  }

  return {
    update,
    reset,
    get rerouteCount() {
      return rerouteCount
    },
    get consecutive() {
      return consecutive
    },
  }
}
