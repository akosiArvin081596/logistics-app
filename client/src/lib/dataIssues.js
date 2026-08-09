// Admin "Data Issues" — the detector queues that ship with no UI.
//
// Sibling of lib/fuelReview.js, same spirit and the same hard contract: pure
// functions, no Vue, and `undefined` ("this server / this call could not tell
// us") is NEVER `[]` ("we checked, nothing to report"). The first must stay
// silent; only the second may say "all clear". The lock, count and month-label
// helpers are IMPORTED from fuelReview rather than re-implemented, so a locked
// row means exactly the same thing on this page as it does in Fuel Logs.
//
// WHY A SECOND FILE AT ALL. fuelReview's REVIEW_QUEUES is bound to ONE payload
// (`isQueueAvailable(fuel, key)` reads `fuel[q.field]`), and its
// `reviewClearPhrases(fuel)` composes reassurance from that single object.
// These five queues come from five different endpoints with five different
// failure modes, so folding them into that registry would make one payload
// answer for calls it never made — and would change what ExpensesTab says about
// fuel. Same pattern, own registry.
//
// Nothing here decides anything on the fleet's behalf. Every queue is an
// OBSERVATION; the two that have a write path (regenerate a signed document)
// name it explicitly, and the rest are read-only by construction.

import { toNum, asList, lockState, monthLabel, queueCounts } from './fuelReview'

export { toNum, asList, lockState, monthLabel, queueCounts }

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * One entry per detector. `clear` is what this queue is entitled to assert when
 * it answered and came back empty — per-queue, never one page-wide sentence,
 * for the same reason reviewClearPhrases() composes rather than hardcodes: a
 * queue that failed to load has established nothing, and a page-wide "all
 * clear" would speak for it.
 *
 * `manual: true` marks a queue that must NOT be fetched on mount. See
 * RATECON_COST_NOTE — this is a cost/side-effect property of the endpoint, not
 * a UI preference.
 */
export const ISSUE_QUEUES = [
  {
    key: 'duplicates',
    label: 'Duplicate receipts',
    clear: 'no receipt looks double-booked',
    blurb: 'The same purchase booked twice — same truck, same day, same amount.',
  },
  {
    key: 'ratecon',
    label: 'Rate cons with no load',
    clear: 'every rate-con email became a load',
    blurb: 'A rate con arrived by email but never became a row in Job Tracking.',
    manual: true,
  },
  {
    key: 'onboarding',
    label: 'Onboarding documents that failed to render',
    clear: 'every onboarding document rendered',
    blurb: 'A signed onboarding document whose PDF never got written.',
  },
  {
    key: 'linxup',
    // ⚠️ NOT "positions with no truck". The counter increments on
    // `if (!driverName)`, and driverName comes from a join of truck_assignments
    // to trucks, so it fires for an UNLINKED truck *and* for a linked truck with
    // no active assignment. Those are two different fixes (link the device vs
    // assign a driver), and naming only the first sends people to the wrong one.
    label: 'GPS positions not tied to a driver',
    clear: 'every GPS position reached a driver',
    blurb: "Linxup sent a position we couldn't attribute — the truck isn't linked, or it has no active driver assignment.",
  },
  {
    key: 'fuelverify',
    label: 'Fuel range accuracy',
    clear: 'every instrumented truck backtests cleanly',
    blurb: "Each truck's range formula, backtested against its own fill history.",
  },
]

/**
 * ⚠️ WHY THE RATE-CON QUEUE IS LOAD-ON-DEMAND AND MUST STAY THAT WAY.
 *
 * `GET /api/admin/ratecon-reconcile` is not a cheap read and is not
 * structurally read-only. Every call opens IMAP against the PRODUCTION mailbox
 * and sweeps the last `windowDays` of mail, and reconcileRateCons() always does
 * its resolve/retire bookkeeping against ratecon_reconcile_alerts. Wiring it to
 * onMounted would run that sweep on every visit to this page, including every
 * back-navigation.
 *
 * What it does NOT do is consume the once-per-load alert: since the GET/POST
 * split, `alert` is passed positionally and hardcoded false on the GET, so a
 * row it inserts carries alerted_at = NULL and the next real alerting run still
 * fires. `?dryRun=true` is accepted as an inert no-op and is sent only so the
 * request matches the existing runbooks.
 */
export const RATECON_COST_NOTE =
  'Runs a live IMAP sweep of the rate-con mailbox, so it runs only when you ask it to.'

// ---------------------------------------------------------------------------
// Per-queue load state
// ---------------------------------------------------------------------------

/**
 * The state machine every queue box renders from. `error` and `empty` are
 * deliberately different terminal states and must never collapse into each
 * other — "we could not ask" rendered as "all clear" is the exact failure this
 * whole page exists to end.
 *
 *   idle    — not asked yet (manual queues start here)
 *   loading — in flight
 *   ok      — answered; `data` is authoritative, empty means genuinely empty
 *   error   — could not ask, or the server refused. Assert NOTHING.
 */
export function emptyQueueState(q) {
  return { status: q && q.manual ? 'idle' : 'loading', error: '', data: null }
}

/** Only an `ok` queue may speak. */
export function queueAnswered(st) {
  return Boolean(st) && st.status === 'ok'
}

/**
 * ⚠️ ANSWERING IS NOT ESTABLISHING, AND CONFLATING THEM IS THE BUG THIS PAGE
 * EXISTS TO PREVENT — one level deeper than absent-vs-empty.
 *
 * Two of these endpoints return HTTP 200 with a perfectly well-formed zero when
 * their detector is not running at all:
 *   - GET /api/fuel/verify with `sweepHasRun: false` has no fill history to
 *     backtest, so every truck reads "unmeasured" and the overstatement count is
 *     0. That is the sweep being off, not three trucks agreeing.
 *   - GET /api/eld/linxup/health with no webhook token has counted nothing since
 *     boot, so `unlinkedPositions` is 0 because the counter's initial value is 0.
 * Both were measured returning exactly that on a production snapshot. Treating
 * either as "all clear" prints a clean bill of health for a check that never
 * ran — which is precisely the failure mode reviewClearPhrases() was written to
 * avoid, and it would be worse here because nothing else is watching.
 *
 * The three SQLite-backed queues are pure queries over tables that always
 * exist, so answering and establishing coincide for them.
 */
export function queueEstablished(key, ctx) {
  if (key === 'fuelverify') return Boolean(ctx?.sweepHasRun)
  if (key === 'linxup') return Boolean(ctx?.linxupMeaningful)
  return true
}

/** Why a queue answered but established nothing — shown instead of "clear". */
export function queueInconclusiveText(key, ctx) {
  if (key === 'fuelverify' && !ctx?.sweepHasRun) {
    return 'the fuel-event sweep has never run, so there is no fill history to check against'
  }
  if (key === 'linxup' && !ctx?.linxupMeaningful) {
    return ctx?.linxupHasToken
      ? 'no Linxup message has arrived since this server started'
      : 'the Linxup webhook has no token configured, so nothing is being counted'
  }
  return ''
}

/**
 * The one-line reason a queue cannot report, in the reader's terms. A 403 is
 * called out separately from a generic failure because it is not a transient
 * fault — it means this account cannot see this detector at all, and retrying
 * will never change that.
 */
export function queueErrorText(st) {
  if (!st || st.status !== 'error') return ''
  if (st.status === 'error' && st.httpStatus === 403) {
    return "Couldn't load — this account isn't allowed to read this check."
  }
  if (st.httpStatus === 404) return "Couldn't load — this server doesn't have this check yet."
  return st.error ? `Couldn't load — ${st.error}` : "Couldn't load."
}

// ---------------------------------------------------------------------------
// 1. Duplicate receipts  (GET /api/expenses/fuel-analytics)
// ---------------------------------------------------------------------------

/**
 * A candidate double-booking.
 *
 * ⚠️ READ-ONLY BY CONSTRUCTION. duplicateReceiptGroups() has no write path —
 * no void, no merge, no delete — so this normalizer deliberately exposes no
 * mutation affordance. The only action a row earns is "go look at the expense".
 *
 * ⚠️ THE LOCK IS PER ROW, NOT PER GROUP. A truck-day-amount group can hold one
 * receipt in an open month and one in a finalized month, and three of the five
 * real production duplicates sit in closed months. Summing them into a single
 * count would tell an admin there are five things to fix when two are fixable —
 * so `counts` is the split, and `allClosed` marks a group that is reference
 * material rather than work.
 *
 * NOTE the date key: `localDay`, not `date`. Binding to `date` renders an em
 * dash on every row, silently.
 */
export function normalizeDuplicateGroup(raw) {
  const rows = asList(raw?.rows).map((r) => ({
    id: r?.id ?? r?.expenseId ?? null,
    localDay: String(r?.localDay ?? '').trim(),
    type: String(r?.type ?? '').trim(),
    truckUnit: String(r?.truckUnit ?? '').trim(),
    driver: String(r?.driver ?? '').trim(),
    amount: toNum(r?.amount),
    gallons: toNum(r?.gallons),
    vendor: String(r?.vendor ?? '').trim(),
    // Server-told or null — never inferred from the date. See lockState.
    locked: lockState(r),
    periodLabel: monthLabel(r?.localDay),
  }))
  const counts = queueCounts(rows)
  return {
    key: String(raw?.key ?? ''),
    truckUnit: String(raw?.truckUnit ?? '').trim(),
    driver: String(raw?.driver ?? '').trim(),
    localDay: String(raw?.localDay ?? '').trim(),
    periodLabel: monthLabel(raw?.localDay),
    amount: toNum(raw?.amount),
    // What double-booking THIS group costs: every copy after the first.
    excessAmount: toNum(raw?.excessAmount),
    confidence: String(raw?.confidence ?? '').trim(),
    reasons: asList(raw?.reasons).map((x) => String(x)),
    rows,
    counts,
    // Every copy sits in a closed month: still worth showing (the money was
    // still booked twice) but there is nothing to do about it this month.
    allClosed: rows.length > 0 && counts.actionable === 0,
  }
}

export function duplicateGroups(payload) {
  return asList(payload?.duplicateReceipts).map(normalizeDuplicateGroup)
}

/**
 * ⚠️ COUNTS COME FROM THE SERVER'S SUMMARY, NOT FROM groups.length.
 *
 * The group list is capped (FUEL_DUPLICATE_MAX_GROUPS) while
 * summarizeDuplicates() runs over the FULL set, so deriving the headline from
 * the rendered rows would quietly understate the very total this section leads
 * with. Derivation is the fallback for a payload that sends groups without a
 * summary, and it is exact in that case because the groups are then all there
 * is.
 *
 * Returns null when there is nothing to summarise, so the caller renders no
 * strip rather than an empty one.
 */
export function duplicateSummary(payload) {
  const raw = payload?.duplicateSummary
  const groups = duplicateGroups(payload)
  if (!raw && !groups.length) return null

  const byConfidence = raw?.byConfidence || {}
  const serverTrucks = Array.isArray(raw?.byTruck) ? raw.byTruck : null
  const byTruck = serverTrucks
    // ORDER PRESERVED — the server sorts biggest-money-first and breaks ties on
    // group count then unit so the strip is stable run to run.
    ? serverTrucks.map((t) => ({
      truckUnit: String(t?.truckUnit ?? '').trim(),
      groups: toNum(t?.groups) ?? 0,
      excessAmount: toNum(t?.excessAmount) ?? 0,
    }))
    : []

  const groupCount = toNum(raw?.groupCount) ?? groups.length
  const rowCount = toNum(raw?.rowCount) ?? groups.reduce((s, g) => s + g.rows.length, 0)
  const excessAmount = toNum(raw?.excessAmount)
    ?? groups.reduce((s, g) => s + (g.excessAmount ?? 0), 0)

  return {
    groupCount,
    rowCount,
    excessAmount,
    byConfidence: {
      high: toNum(byConfidence.high) ?? 0,
      medium: toNum(byConfidence.medium) ?? 0,
      low: toNum(byConfidence.low) ?? 0,
    },
    byTruck,
    // True when the server capped the list, so the page can say so instead of
    // letting a reader count the rows and disbelieve the headline.
    truncated: groupCount > groups.length,
    shown: groups.length,
  }
}

/**
 * The split across every rendered group's rows — "N to fix · M closed".
 *
 * `actionable` leads because the count exists to answer "how much work is
 * there". Folding closed rows in overstates the work AND guarantees the queue
 * can never reach zero, which is how the rate-con reconciler's daily mail came
 * to be ignored.
 */
export function duplicateRowCounts(groups) {
  const all = asList(groups).flatMap((g) => asList(g.rows))
  return queueCounts(all)
}

// ---------------------------------------------------------------------------
// 2. Rate-con reconciliation  (GET /api/admin/ratecon-reconcile?dryRun=true)
// ---------------------------------------------------------------------------

/**
 * A rate-con email whose load number never reached Job Tracking.
 *
 * Only INBOUND mail is a signal — the label is not a rate-con inbox, and ~20 of
 * 68 messages under it in a live window were sent BY us. The server already
 * drops those (`selfSentSkipped`); this just reports the figure so a reader can
 * see that the filter ran.
 */
export function normalizeRateconGap(raw) {
  return {
    loadNumber: String(raw?.loadNumber ?? '').trim(),
    subject: String(raw?.subject ?? '').trim(),
    date: String(raw?.date ?? '').trim(),
  }
}

export function rateconReport(payload) {
  if (!payload) return null
  const missing = asList(payload.missing).map(normalizeRateconGap)
  return {
    enabled: Boolean(payload.enabled),
    windowDays: toNum(payload.windowDays),
    mailbox: String(payload.mailbox ?? '').trim(),
    scanned: toNum(payload.scanned) ?? 0,
    selfSentSkipped: toNum(payload.selfSentSkipped) ?? 0,
    // ⚠️ An ARRAY of load ids, not a count — `retired.push(row.load_id)`.
    // Reading it as a number renders "NaN retired" on every clean sweep.
    retired: asList(payload.retired).map((x) => String(x)),
    missing,
    // A browsing GET never alerts, so this should always be empty here. Carried
    // so the page can prove that rather than assert it.
    newlyAlerted: asList(payload.newlyAlerted).map((x) => String(x)),
  }
}

// ---------------------------------------------------------------------------
// 3. Onboarding document failures  (GET /api/admin/onboarding-doc-failures)
// ---------------------------------------------------------------------------

/**
 * A signed onboarding document whose PDF never got written.
 *
 * ⚠️ MIXED CASING ON THE WIRE, AND IT IS NOT A TYPO. The alert columns come
 * straight off the table in snake_case (`doc_key`, `owner_id`, `first_seen`)
 * while the joined enrichment is camelCase (`signedPdfUrl`, `hasStoredSignature`,
 * `regeneratable`). Reading `docKey` here returns undefined and the regenerate
 * call would then POST to `/documents/undefined/regenerate`.
 *
 * ⚠️ `regeneratable` IS THE SERVER'S ANSWER, not a guess from `scope`. Only the
 * investor-application scope has an admin regenerate route; a driver retries by
 * signing again in their own app, which is reachable, so offering an admin
 * button there would be a dead control.
 */
export function normalizeOnboardingFailure(raw) {
  const ownerId = toNum(raw?.owner_id)
  return {
    alertKey: String(raw?.alert_key ?? ''),
    scope: String(raw?.scope ?? '').trim(),
    ownerId,
    docKey: String(raw?.doc_key ?? '').trim(),
    docName: String(raw?.doc_name ?? '').trim(),
    reason: String(raw?.reason ?? '').trim(),
    firstSeen: String(raw?.first_seen ?? '').trim(),
    resolvedAt: raw?.resolved_at || null,
    signed: raw?.signed === true ? true : raw?.signed === false ? false : null,
    signedPdfUrl: raw?.signedPdfUrl || null,
    signingError: String(raw?.signingError ?? '').trim(),
    // Whether a regenerate could actually work: no stored signature means there
    // is nothing to re-render from, and the route 409s with NO_STORED_SIGNATURE.
    hasStoredSignature: raw?.hasStoredSignature === true
      ? true : raw?.hasStoredSignature === false ? false : null,
    regeneratable: raw?.regeneratable === true && Number.isFinite(ownerId) && ownerId > 0,
  }
}

export function onboardingFailures(payload) {
  return asList(payload?.failures).map(normalizeOnboardingFailure)
}

/**
 * Can this row's button be offered, and if not, why?
 *
 * Returns '' when it can. The refusals mirror the server's own 409s so the page
 * never offers a click that is guaranteed to fail.
 */
export function regenerateBlockedReason(f) {
  if (!f) return 'Nothing to regenerate.'
  if (!f.regeneratable) {
    return f.scope === 'driver'
      ? 'The driver re-signs this in their own app — there is no admin re-render for it.'
      : 'This scope has no admin re-render.'
  }
  if (f.hasStoredSignature === false) {
    return 'No signature on file, so there is nothing to re-render from. The investor has to sign it again.'
  }
  return ''
}

// ---------------------------------------------------------------------------
// 4. Linxup unlinked positions  (GET /api/eld/linxup/health)
// ---------------------------------------------------------------------------

/**
 * ⚠️ `unlinkedPositions` IS AN IN-MEMORY COUNTER, NOT A QUERYABLE BACKLOG.
 *
 * It is a plain integer on a module-scope object that starts at 0 and is
 * incremented per unmatched position, so it resets to 0 on every restart and
 * there is no list to open. That makes a bare "0" ambiguous three ways: nothing
 * unlinked, the process restarted, or the feed is not running at all. The
 * `meaningful` flag below is what stops the page rendering the third case as a
 * clean bill of health — with the feed disabled or no token configured, the
 * counter is describing nothing.
 */
export function linxupReport(payload) {
  if (!payload) return null
  const enabled = Boolean(payload.enabled)
  const hasToken = Boolean(payload.hasToken)
  const counts = payload.messageCounts && typeof payload.messageCounts === 'object'
    ? payload.messageCounts : {}
  const received = Object.values(counts).reduce((s, v) => s + (toNum(v) ?? 0), 0)
  return {
    enabled,
    hasToken,
    speedUnit: String(payload.speedUnit ?? '').trim(),
    lastReceived: payload.lastReceived || null,
    lastWritten: payload.lastWritten || null,
    lastError: payload.lastError || null,
    messageCounts: Object.entries(counts)
      .map(([type, n]) => ({ type, count: toNum(n) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    unlinked: toNum(payload.unlinkedPositions) ?? 0,
    // The counter only says something once the webhook is actually configured
    // AND has been sent at least one message since boot.
    meaningful: hasToken && received > 0,
    // Written positions need the master write switch; with it off, Linxup
    // messages are counted and discarded, so "0 unlinked" is trivially true.
    ingesting: enabled && hasToken,
  }
}

// ---------------------------------------------------------------------------
// 5. Fuel range verification  (GET /api/fuel/verify)
// ---------------------------------------------------------------------------

/** How far off a truck's range formula is, and whether that is worth a look. */
export const OVERSTATEMENT_CHECK = 1.25

export function normalizeVerifyTruck(raw) {
  const bt = raw?.backtest || {}
  const live = raw?.live || {}
  const inputs = raw?.panelInputs || {}
  const ev = raw?.tankEvidence || null
  const factor = toNum(bt.overstatementFactor)
  const legs = toNum(bt.legs) ?? 0
  return {
    vehicleId: String(raw?.vehicleId ?? '').trim(),
    unitNumber: String(raw?.unitNumber ?? '').trim() || '—',
    assignedDriver: raw?.assignedDriver || '',
    tankGallons: toNum(inputs.tankGallons),
    tankSource: String(inputs.tankSource ?? '').trim(),
    mpg: toNum(inputs.mpg),
    mpgSource: String(inputs.mpgSource ?? '').trim(),
    legs,
    overstatementFactor: factor,
    measuredMilesPerPoint: toNum(bt.measuredMilesPerPoint),
    claimedMilesPerPoint: toNum(bt.claimedMilesPerPoint),
    legsOverstated: toNum(bt.legsOverstated),
    fuelPct: toNum(live.fuelPct),
    panelWouldShowMiles: toNum(live.panelWouldShowMiles),
    // ⚠️ THE LOW END IS THE PLANNING NUMBER. Rendering `typical` re-creates the
    // ~2x-optimistic bug this endpoint exists to measure.
    measuredLowMiles: toNum(live.measuredLowMiles),
    measuredTypicalMiles: toNum(live.measuredTypicalMiles),
    basis: String(live.basis ?? '').trim(),
    // No legs means no verdict — not a passing one.
    verdict: legs <= 0 || factor === null
      ? 'unmeasured'
      : (factor >= OVERSTATEMENT_CHECK ? 'over' : factor <= 1 / OVERSTATEMENT_CHECK ? 'under' : 'ok'),
    tank: normalizeTankEvidence(ev),
  }
}

/**
 * The four figures a human needs to settle "how big is this tank?", each
 * labelled by what it actually measures.
 *
 * ⚠️⚠️ `sensed` IS NOT CAPACITY AND MUST NEVER BE OFFERED AS THE ANSWER.
 * summarizeCalibration is bimodal at ~2x on both instrumented trucks because
 * the sender reads ONE saddle tank: a fill that tops up the sensed tank and a
 * fill that tops up both produce two populations. #33's lower mode is ~117 gal
 * while that truck has twice taken a single 202.7-gallon fill, so 117 is a hard
 * contradiction of its own fill history. Writing it to fuel_tank_gallons would
 * show HALF the true range — and underestimating range is the direction that
 * strands a truck on a shoulder, whereas overestimating costs one fuel stop.
 *
 * `floor` is the honest lower bound and it is evidence, not inference: the
 * largest single fill the truck has ever taken cannot exceed its capacity.
 */
export function normalizeTankEvidence(raw) {
  if (!raw) return null
  const sensed = raw.sensedGallonsPer100Pct || {}
  const lower = raw.sensedLowerMode || null
  return {
    sampleCount: toNum(raw.sampleCount) ?? 0,
    configured: toNum(raw.configuredGallons),
    // Object on the wire, not a scalar — median plus the spread.
    sensedMedian: toNum(sensed.median),
    sensedP25: toNum(sensed.p25),
    sensedP75: toNum(sensed.p75),
    bimodal: Boolean(raw.bimodal),
    bimodalNote: raw.bimodalNote || '',
    sensedLowerMode: lower ? toNum(lower.median) : null,
    sensedLowerCount: lower ? (toNum(lower.sampleCount) ?? 0) : null,
    // Inferred from the burn side, which is what the truck actually draws on.
    burnImplied: toNum(raw.burnImpliedGallonsPer100Pct),
    // A hard floor: the truck has physically accepted this much in one fill.
    floor: toNum(raw.largestSingleFillGallons),
  }
}

export function verifyTrucks(payload) {
  return asList(payload?.trucks).map(normalizeVerifyTruck)
}

/** Trucks whose backtest actually disagrees with the panel — the amber count. */
export function countVerifyChecks(rows) {
  return asList(rows).filter((r) => r.verdict === 'over' || r.verdict === 'under').length
}

/**
 * The truck whose tank size is genuinely unsettled, for the decision card.
 *
 * Picks the widest disagreement between the configured figure and the two
 * independent estimates rather than hardcoding a unit number — the fleet
 * changes, and a card naming a truck that has since been corrected is worse
 * than no card. Returns null when nothing disagrees enough to ask about.
 */
export const TANK_DISAGREE_PCT = 15

export function tankDecisionCandidate(rows) {
  let best = null
  for (const r of asList(rows)) {
    const t = r.tank
    if (!t || !t.configured) continue
    // Compare against the two figures that are NOT the sensed lower mode.
    const rivals = [t.burnImplied, t.floor].filter((v) => v !== null && v > 0)
    if (!rivals.length) continue
    const gap = Math.max(...rivals.map((v) => Math.abs(v - t.configured) / t.configured)) * 100
    if (gap < TANK_DISAGREE_PCT) continue
    if (!best || gap > best.gapPct) best = { truck: r, gapPct: Math.round(gap) }
  }
  return best
}

/**
 * The truck to ASK ABOUT when there is no corroborating evidence yet.
 *
 * ⚠️ THE QUESTION DOES NOT GO AWAY JUST BECAUSE THE EVIDENCE IS MISSING. With
 * the fuel-event sweep off, `tankEvidence` is null on every truck, so
 * tankDecisionCandidate() returns null — and dropping the card there would hide
 * the open question at exactly the moment nothing is measuring it. Measured on a
 * production snapshot: sweepHasRun false, all three trucks null evidence, and
 * `LogisX-#33` still configured at 300 gal driving a 449-mile panel figure.
 *
 * Prefers a truck whose tank someone actually CONFIGURED — that is the number
 * being asserted, and therefore the one worth confirming — over one silently
 * running on the fleet default. Ties break on the widest panel-vs-planning
 * spread, which is the spread a driver would be planning against.
 */
export function tankDecisionFallback(rows) {
  const list = asList(rows).filter((r) => r.tankGallons !== null && r.tankGallons > 0)
  if (!list.length) return null
  const spread = (r) => (r.panelWouldShowMiles ?? 0) - (r.measuredLowMiles ?? 0)
  const configured = list.filter((r) => r.tankSource === 'truck')
  const pool = configured.length ? configured : list
  return pool.slice().sort((a, b) => spread(b) - spread(a))[0] || null
}
