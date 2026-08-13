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
// These SIX queues come from six different endpoints with six different failure
// modes, so folding them into that registry would make one payload answer for
// calls it never made — and would change what ExpensesTab says about fuel. Same
// pattern, own registry. (The number is ISSUE_QUEUES.length; this sentence has
// already been wrong once, left at five when the month-end queue was added.)
//
// Nothing here decides anything on the fleet's behalf. Every queue is an
// OBSERVATION; the two that have a write path (regenerate a signed document)
// name it explicitly, and the rest are read-only by construction.

// The extension is explicit so this module can be imported by bare Node (the
// verification scripts) as well as by Vite. Vite resolves both forms; Node ESM
// resolves only this one, and an extensionless specifier fails with
// ERR_MODULE_NOT_FOUND before a single assertion runs. fuelReview.js itself
// imports nothing, so the fix stops here rather than cascading.
import { toNum, asList, lockState, monthLabel, queueCounts } from './fuelReview.js'

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
  {
    // ⚠️ NOT "refused writes", and not "frozen invoices" either. This queue has
    // TWO halves that answer different questions — what a closed month REFUSED
    // (which only exists if somebody happened to try) and what a closed month is
    // HOLDING right now (which is true whether or not anyone has bumped into it)
    // — and naming only one sends people looking for the other in the wrong
    // place. Same reasoning as the linxup label above.
    //
    // The order of this array is the order of the queue bar, and the sections in
    // DataIssuesView follow it — so a new queue goes on the end of both.
    key: 'periodlock',
    label: 'Blocked by month-end close',
    clear: 'nothing is held by a closed month',
    blurb: 'Writes a closed month refused, and the invoices it is still holding — un-adjustable, and some of them un-payable.',
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
 * ⚠️ AND THE MONTH-END QUEUE IS A THIRD OF THE SAME KIND, with two distinct ways
 * of returning a well-formed zero that means nothing:
 *   - `period_locks` unreadable. Every write guard in the app fails CLOSED on
 *     that table, so the app is at that moment refusing invoice adjustments,
 *     truck edits, expense status flips and driver renames it cannot confirm are
 *     safe — while this endpoint, which fails closed the same way, deliberately
 *     lists no invoice (one root cause is not twenty-nine findings). "Nothing
 *     stuck" would be the exact inverse of the truth.
 *   - No month has ever been finalized. Then nothing CAN be frozen by one and no
 *     lock refusal can have fired, so an empty queue is trivially true and says
 *     nothing about whether month-end close works. This is the ships-dormant
 *     default: `PERIOD_FINALIZE_ENABLED` off and `period_locks` empty.
 *   - `audit_trail` unreadable. The current-state half still computes, but the
 *     history half is unknown, and "no write was ever refused" is not something
 *     to assert from a table that could not be read.
 *
 * The three SQLite-backed queues are pure queries over tables that always
 * exist, so answering and establishing coincide for them.
 */
export function queueEstablished(key, ctx) {
  if (key === 'fuelverify') return Boolean(ctx?.sweepHasRun)
  if (key === 'linxup') return Boolean(ctx?.linxupMeaningful)
  if (key === 'periodlock') return Boolean(ctx?.periodLockMeaningful)
  return true
}

/**
 * Did the payload behind `key` actually ARRIVE?
 *
 * ⚠️ THIS IS THE ABSENT-VS-EMPTY RULE ONE LEVEL UP FROM WHERE THE REST OF THE FILE
 * ENFORCES IT, and all three establishment-gated queues had the same hole. Their
 * context flags are built with `Boolean(payload?.x)`, so a payload that never
 * arrived produces the SAME `false` a payload that arrived saying "off" produces —
 * and queueInconclusiveText() then printed a confident sentence about a server
 * state it had not been told. After a 403 or a network failure the month-end queue
 * read "automatic month-close is switched off and no month has ever been
 * finalized, so nothing can be held by one" against a database with FIFTEEN months
 * locked; fuel read "the fuel-event sweep has never run"; Linxup read "the webhook
 * has no token configured". None of the three is something a failed call can know.
 *
 * ⚠️ ABSENT MEANS NO. A ctx with no `answered` map has not told us the call
 * landed, and a check that cannot tell must not speak — the same direction
 * periodLockReport() fails in when it returns null for an absent payload. The one
 * production caller (establishCtx in DataIssuesView) supplies the map for every
 * registered queue, so this costs nothing there and refuses only hand-built
 * contexts that never established anything in the first place.
 */
export function queueCtxAnswered(ctx, key) {
  return Boolean(ctx && ctx.answered && ctx.answered[key] === true)
}

/**
 * Why a queue answered but established nothing — shown instead of "clear".
 *
 * '' when the payload never arrived, which is what puts the caller back on its
 * "couldn't load" wording. See queueCtxAnswered().
 */
export function queueInconclusiveText(key, ctx) {
  if (!queueCtxAnswered(ctx, key)) return ''
  if (key === 'fuelverify' && !ctx?.sweepHasRun) {
    return 'the fuel-event sweep has never run, so there is no fill history to check against'
  }
  if (key === 'linxup' && !ctx?.linxupMeaningful) {
    return ctx?.linxupHasToken
      ? 'no Linxup message has arrived since this server started'
      : 'the Linxup webhook has no token configured, so nothing is being counted'
  }
  if (key === 'periodlock' && !ctx?.periodLockMeaningful) return periodLockInconclusiveText(ctx)
  return ''
}

/**
 * Why the month-end queue established nothing, ordered LOUDEST FIRST.
 *
 * An unreadable lock table leads because it is a fault rather than a
 * configuration: it is the only one of these that means the running app is
 * currently refusing writes, so it must not be reported behind "no month has
 * been finalized yet". Kept separate from queueInconclusiveText() so the section
 * can render the same sentence in its own context strip without going through
 * the shared status box — see the note on the periodlock section in
 * DataIssuesView.
 *
 * ⚠️ AND IT MUST MAKE THE SAME ANSWERED CHECK, because it is called DIRECTLY by
 * that strip as well as through queueInconclusiveText(). Gating only the shared
 * entry point would leave the section rendering the sentence the shared path just
 * learned not to say. `locksReadable`/`auditReadable` are tested for `=== false`
 * precisely so a null cannot be read as a fault — but that same null then falls
 * through to the `!lockedCount` rung, which asserts both the close-flag state and
 * that no month was ever finalized. Neither is knowable from a call that failed.
 */
export function periodLockInconclusiveText(ctx) {
  if (!ctx) return ''
  if (!queueCtxAnswered(ctx, 'periodlock')) return ''
  if (ctx.periodLockMeaningful) return ''
  if (ctx.locksReadable === false) {
    return "the month-end lock table can't be read, so every write guard in the app is refusing what it can't confirm is safe"
  }
  if (ctx.auditReadable === false) {
    return "the audit trail can't be read, so refused writes can't be listed"
  }
  if (!ctx.lockedCount) {
    return ctx.closeEnabled
      ? 'no month has been finalized yet, so nothing can be held by one'
      : 'automatic month-close is switched off and no month has ever been finalized, so nothing can be held by one'
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
 * ⚠️ THERE IS A VOID PATH NOW, AND IT REUSES THE EXISTING MECHANISM RATHER THAN
 * INVENTING ONE. A copy is voided by REJECTING it —
 * `PUT /api/expenses/bulk-status` with `status: 'Rejected'` — because that is
 * already what "this receipt is not spend" means everywhere else in the app:
 * `EXPENSE_PNL_FILTER` drops a Rejected row from every P&L, and the duplicate
 * detector itself runs under that same filter. So one reject removes the copy
 * from the investor portal AND from future duplicate matching, with no second
 * concept to keep in sync. Nothing is deleted: the row keeps its id, its
 * receipt image and its history, and setting the status back restores it.
 *
 * ⚠️ THE GROUP HAS NO CANONICAL ORIGINAL, which is why this normalizer still
 * exposes no "the copy". Truck+day+amount is the whole key; neither row is
 * marked as the first, and `id` order is insertion order, not truth. A human
 * picks. The two rules that follow from that are in voidableRows() and
 * voidSelectionCheck(): nothing is selected by default, and one copy always has
 * to survive.
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
    // The settlement month and how far it has settled, straight from the server.
    period: String(raw?.period ?? '').trim(),
    settlement: String(raw?.settlement ?? '').trim().toLowerCase(),
    remedy: duplicateRemedy(rows.length > 0 && counts.actionable === 0, raw?.settlement),
  }
}

/**
 * What can actually be DONE about a duplicate group — the question this queue
 * exists to answer and could not, because "closed" was the only thing it knew.
 *
 * ⚠️ CLOSED IS NOT ONE STATE, AND CONFLATING THE TWO IS WHY THIS PAGE READ AS A
 * DEAD END. A finalized month whose payout is still `owed` has moved NO MONEY:
 * the fix is an ordinary reopen → void → re-finalize, with nothing to recover
 * from anyone. A month already `paid` cannot be un-sent and is a genuine
 * adjustment conversation. Measured on production 2026-08-12, $700 of the
 * $1,115 of known duplicates was in the first bucket and only $415 in the
 * second — so treating them alike wrote off most of the recoverable money.
 *
 * Note the SIGN while reading this: a duplicate EXPENSE depresses net profit, so
 * it UNDERPAYS the investor. Every correction here pays them more. There is no
 * clawback in any of these branches.
 *
 * Unknown settlement is deliberately reported as unknown rather than assumed
 * safe — the server fails closed to 'unknown' when it cannot read the payouts.
 */
export function duplicateRemedy(allClosed, settlement) {
  if (!allClosed) return 'open'
  const s = String(settlement ?? '').trim().toLowerCase()
  if (s === 'owed' || s === 'none') return 'correctable'
  if (s === 'paid' || s === 'processing') return 'settled'
  return 'unknown'
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
// 1a. Voiding a copy  (PUT /api/expenses/bulk-status, status 'Rejected')
// ---------------------------------------------------------------------------

/**
 * The status that voids a receipt. Not a delete, and deliberately the same word
 * the Expenses screen uses — one vocabulary for "this is not spend".
 */
export const VOID_STATUS = 'Rejected'

/**
 * May this ROW be offered for voiding?
 *
 * ⚠️ `locked === true` IS THE ONLY REFUSAL, and it is a refusal about the
 * BUTTON, not about the server. bulk-status does not 409 on a finalized row —
 * it withholds it, counts it into `skippedFinalized`, and returns 200. So
 * offering a checkbox here would not produce an error a reader could act on; it
 * would produce a click that silently did nothing, which is the same dead end
 * as a button that always fails, only quieter.
 *
 * `locked === null` ("this server didn't say") stays selectable, exactly as
 * lockState() specifies: that is how this queue behaved before locks existed,
 * and it is the server's job to withhold the row if it turns out to be closed.
 * Treating "didn't say" as locked would disable the whole feature the moment it
 * met an older server.
 */
export function rowVoidable(row) {
  return Boolean(row) && row.locked !== true
}

/**
 * The rows in a group a human may actually choose from.
 *
 * ⚠️ TWO GATES, CHECKED INDEPENDENTLY THOUGH THEY AGREE TODAY. The group gate
 * (`remedy === 'open'`) and the row gate (`locked !== true`) are currently
 * equivalent by construction — duplicateRemedy() returns anything other than
 * 'open' only when `counts.actionable === 0`, i.e. when every row is already
 * locked, so a settled group has no unlocked rows to offer anyway. The group
 * gate is kept explicit precisely because that equivalence is an accident of
 * how duplicateRemedy() is written: the day it stops keying on `allClosed`, a
 * paid month must not silently acquire a set of checkboxes.
 */
export function voidableRows(group) {
  if (!group || group.remedy !== 'open') return []
  return asList(group.rows).filter(rowVoidable)
}

/**
 * Why this group offers no void, in the reader's terms. '' when it does.
 *
 * Same shape and same job as regenerateBlockedReason(): the page must never
 * render a control whose only possible outcome is nothing happening. Each
 * branch names the remedy that DOES apply, because "you can't do it here" on
 * its own is what made this page read as a dead end in the first place.
 *
 * ⚠️ 'correctable' IS A REFUSAL, NOT AN OVERSIGHT. That month is finalized with
 * its payout still owed, so the money is genuinely recoverable — but recovering
 * it means reopening a closed month, which restates a period and belongs on the
 * Payouts console with its required reason and its audit row. Offering it from
 * a data-hygiene page would let a cleanup click reopen a settlement.
 */
export function voidBlockedReason(group) {
  if (!group) return 'Nothing to void.'
  const month = group.period || 'This month'
  if (group.remedy === 'open') {
    // The empty branch is unreachable against today's server — 'open' means at
    // least one row is unlocked — and it is kept because this function is what
    // guarantees the page never shows a group with neither a control nor a
    // reason. That invariant should not depend on two definitions agreeing.
    return voidableRows(group).length ? '' : 'No copy in this group is in an open month.'
  }
  if (group.remedy === 'correctable') {
    return `${month} is finalized, but its payout has not been sent — no money has moved, so this is still recoverable. `
      + 'Reopen the month in Payouts first; voiding a receipt is not something to do from here while the period is closed.'
  }
  if (group.remedy === 'settled') {
    return `${month} is finalized and its payout has already gone out. Voiding the copy now would not change what was sent — `
      + 'the correction is a payout adjustment, which is a decision rather than a cleanup.'
  }
  return `${month} is finalized and its settlement state could not be read, so it is treated as already settled. `
    + 'Check the payout for that month before doing anything here.'
}

/**
 * Is this selection safe to send, and if not, why?
 *
 * ⚠️ ONE COPY ALWAYS SURVIVES, AND THIS IS THE RULE THAT COSTS MONEY IF IT
 * GOES. Read the sign carefully: a duplicate EXPENSE depresses net profit and
 * therefore UNDERPAYS the investor, so voiding the extra copy pays them more.
 * Voiding EVERY copy overshoots — it removes a purchase that really happened,
 * which overstates profit and OVERPAYS. That is the one direction in this whole
 * queue that takes money from someone, and it is two clicks away from the
 * correct action. It also deletes the gallons behind the fuel figures.
 *
 * "What survives" is exactly "rows not selected": the detector runs under
 * EXPENSE_PNL_FILTER, so every row in a group is a live, non-rejected expense —
 * including a locked one, which cannot be selected but is still on the books
 * and still counts as the surviving copy.
 *
 * If the whole purchase really is bogus, that is a different action on a
 * different screen (reject it in Expenses), and this says so rather than
 * quietly clamping the selection.
 */
export function voidSelectionCheck(group, selectedIds) {
  const eligible = voidableRows(group)
  const wanted = new Set(asList(selectedIds).map((v) => String(v)))
  const rows = eligible.filter((r) => wanted.has(String(r.id)))
  const total = asList(group?.rows).length
  const keeps = total - rows.length

  if (!rows.length) {
    return { ok: false, rows, keeps, reason: 'Pick which copy to reject — nothing is selected.' }
  }
  if (keeps < 1) {
    return {
      ok: false,
      rows,
      keeps,
      reason: 'That would reject every copy, which removes a purchase that really happened. '
        + 'Leave one on the books. If the whole receipt is bogus, reject it in Expenses instead.',
    }
  }
  return { ok: true, rows, keeps, reason: '' }
}

/** "#141, #142" — the ids, spelled out, for a confirmation that must be exact. */
export function voidIdList(rows) {
  return asList(rows).map((r) => `#${r.id}`).join(', ')
}

/** Ids, plural noun and total for the confirmation's opening line. */
function voidHeadline(group, rows, m) {
  const n = rows.length
  const total = rows.reduce((s, r) => s + (r.amount ?? 0), 0)
  return `Rejecting ${voidIdList(rows)} — ${n} receipt${n === 1 ? '' : 's'} `
    + `on ${group?.truckUnit || group?.driver || 'this truck'}, ${m(total)} in total:`
}

/**
 * The confirmation text. Names every id and every amount, on purpose.
 *
 * A confirm that says "reject 2 receipts?" is not a confirmation of anything —
 * the operator has already stopped reading the table by the time they reach it,
 * and this is a live financial row. So the dialog restates what is about to be
 * voided (id, date, vendor, amount, each on its own line), what survives, and
 * how to undo it. ConfirmModal renders `white-space: pre-line`, so the newlines
 * here are real; the cancel-load confirm composes its load/route/payment summary
 * the same way and for the same reason.
 *
 * The ids appear TWICE — once in the opening line and once per detail row — so
 * that someone who reads only the first sentence still sees which receipts they
 * are about to void. Redundancy is cheap; voiding the wrong row is not.
 */
export function voidConfirmMessage(group, rows, fmtMoney) {
  const list = asList(rows)
  const m = typeof fmtMoney === 'function' ? fmtMoney : (v) => `$${Number(v ?? 0).toFixed(2)}`
  const keeps = asList(group?.rows).length - list.length
  const lines = list.map((r) => {
    const bits = [`#${r.id}`, r.localDay || '', r.vendor || '', m(r.amount)].filter(Boolean)
    return `  · ${bits.join('  ·  ')}`
  })
  return [
    voidHeadline(group, list, m),
    lines.join('\n'),
    `${keeps} cop${keeps === 1 ? 'y' : 'ies'} stays on the books, so the purchase itself is still counted.`,
    'A rejected receipt leaves the P&L and the investor portal and stops matching as a duplicate. '
      + 'Nothing is deleted — the row and its receipt image stay, and setting the status back restores it.',
  ].join('\n\n')
}

/**
 * The optional note that rides along with the void.
 *
 * ⚠️ THIS PAGE'S COPY USED TO SAY THERE WAS NO SUCH RECORD, AND IT WAS RIGHT AT
 * THE TIME. `PUT /api/expenses/bulk-status` accepted no reason and wrote no
 * audit row, so the confirm collected an acknowledgement instead — a field
 * implying a stored note that did not exist is exactly the overclaim this page
 * exists to avoid. The endpoint now does both: it writes ONE `audit_trail` row
 * per call (`bulk_update_expense_status`, carrying the account, the time, the
 * target status and the full id list) and appends `— reason: <text>` to it when
 * a reason is sent. So the honesty problem inverted, and the copy had to move.
 *
 * ⚠️ OPTIONAL, MIRRORING THE SERVER. `expenseStatusReason()` reads `body.reason`
 * if it is a string and the route works identically without it — there is no
 * 400 to mirror, unlike `POST /api/dispatch/cancel`'s CANCEL_REASON_REQUIRED,
 * which is what makes the cancel-load confirm's required field a real contract
 * rather than a local rule. A client-side-only requirement here would be
 * unenforced: ExpensesTab's bulk approve/reject and any curl reach the same
 * endpoint and still write reasonless rows, so a reader of `audit_trail` could
 * not tell "no reason given" from "sent by a caller that never asks". The
 * acknowledgement remains the gate on intent; this only records the part a
 * human can add that the ids cannot.
 */
export const VOID_REASON_MAX = 300

/**
 * Client-side mirror of the server's `expenseStatusReason()` — collapse the
 * characters that would break a one-line audit detail, trim, cap.
 *
 * The trailing trim is NOT in the server's version and is deliberate: it makes
 * the output a FIXED POINT of the server transform, so what a character counter
 * shows is byte-for-byte what gets stored. Without it a cut landing just after a
 * space would send 300 characters and store 299, and the page would be
 * misreporting its own write by one — small, but this is the page that promises
 * it never claims more than happened.
 */
export function normalizeVoidReason(raw) {
  return String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, VOID_REASON_MAX)
    .trim()
}

/**
 * The exact PUT body.
 *
 * ⚠️ `reason` IS OMITTED WHEN BLANK, never sent as `''`. The server's normalizer
 * treats both the same today, but an absent key and an empty string are
 * different claims — the first says nothing was written, the second says an
 * empty note was. Same absent-vs-empty rule the queues run on, applied to the
 * request side.
 *
 * `ids` and `status` are untouched, so an older server that ignores the extra
 * key gets byte-identical behaviour to before.
 */
export function voidRequestBody(ids, reason) {
  const body = { ids: asList(ids), status: VOID_STATUS }
  const note = normalizeVoidReason(reason)
  if (note) body.reason = note
  return body
}

/**
 * What the server actually did. SERVER-TOLD ONLY.
 *
 * ⚠️ THE RESPONSE SAYS HOW MANY ROWS WERE WITHHELD, NEVER WHICH, and the gap
 * cannot be closed from here. Matching each row's date against
 * `finalizedPeriods` is the obvious inference and it is WRONG:
 * `expenses.posted_period` books a receipt whose own month is closed into the
 * current open one, so a row dated 2026-05 can be perfectly editable while its
 * date says otherwise — a live example sits in this data. That is why the
 * caller re-reads the queue instead of patching rows optimistically, and why
 * this function reports counts rather than marking rows.
 *
 * ⚠️ AN ABSENT `updated` IS NOT `updated: 0`. A server predating that field
 * answered 200 only when it had written everything, so absent falls back to the
 * number attempted — the same absent-vs-empty rule the queues use. Reading it
 * as zero would report a completely successful void as a total failure.
 *
 * `periods` is whatever the server named and is deliberately empty when
 * `periodLockUnreadable` is set: in that case those months are UNKNOWN, not
 * closed, and printing them as finalized would report a month-end that never
 * happened.
 */
export function summarizeVoidResult(resp, attempted) {
  const n = toNum(attempted) ?? 0
  const reported = toNum(resp?.updated)
  const updated = reported === null ? n : reported
  const withheld = toNum(resp?.skippedFinalized) ?? 0
  const missing = toNum(resp?.skipped) ?? 0
  const lockUnreadable = resp?.periodLockUnreadable === true
  const periods = lockUnreadable ? [] : asList(resp?.finalizedPeriods).map((p) => String(p)).filter(Boolean)
  return {
    attempted: n,
    updated,
    withheld,
    missing,
    lockUnreadable,
    periods: [...new Set(periods)].sort(),
    complete: updated >= n && withheld === 0 && missing === 0,
    // A withheld row will be withheld again for the same reason, so retrying is
    // only the fix when the lock table itself could not be read.
    retryable: lockUnreadable,
  }
}

/** "May 2026", "May 2026 and June 2026", "April 2026, May 2026 and June 2026". */
export function periodList(periods) {
  const names = asList(periods).map((p) => monthLabel(p) || p).filter(Boolean)
  if (names.length <= 1) return names[0] || ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The outcome sentence. Never "done" unless everything landed.
 *
 * The failure this guards is the one ExpensesTab's bulk approve shipped with:
 * a partial write reported as a complete one. Here the stakes are the same in
 * reverse — an operator who believes a copy was voided stops looking for it.
 */
export function voidResultText(res) {
  if (!res) return ''
  const n = res.updated
  const rejected = `${n} receipt${n === 1 ? '' : 's'} rejected`
  if (res.complete) return `${rejected}.`
  const tail = []
  if (res.withheld) {
    tail.push(res.lockUnreadable
      ? `${res.withheld} could not be touched — the period lock table could not be read, so no month could be confirmed open`
      : `${res.withheld} withheld — ${periodList(res.periods) || 'that month'} ${res.periods.length === 1 ? 'is' : 'are'} finalized`)
  }
  if (res.missing) tail.push(`${res.missing} no longer exist${res.missing === 1 ? 's' : ''}`)
  if (!tail.length && res.updated < res.attempted) {
    tail.push(`${res.attempted - res.updated} unchanged, and the server did not say why`)
  }
  return `${rejected}. ${tail.join('; ')}.`
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

// ---------------------------------------------------------------------------
// 6. Month-end close  (GET /api/admin/period-lock-issues)
// ---------------------------------------------------------------------------
//
// Client ask, verbatim: "everything that is concerning the lock month or date it
// should go to that page where we show all the concerns."
//
// TWO HALVES, and the queue is wrong without either. HISTORY is what a closed
// month REFUSED — it only exists if somebody happened to try, and until the
// refusal-audit work most of those guards returned a 409 and wrote nothing at
// all. CURRENT STATE is what a closed month is HOLDING right now, which is true
// whether or not anyone has bumped into it yet.
//
// ⚠️ EXPENSES REDIRECTED VIA `posted_period` ARE DELIBERATELY ABSENT. Owner's
// call: the redirect is the system working as designed, both admin surfaces
// already say so at the moment it happens, and with every month through 2026-07
// locked it fires on essentially every backdated receipt. Listing them would
// bury the rows that do need someone — the exact failure that taught everyone to
// ignore the rate-con reconciler's daily mail.

/**
 * ⚠️ THE HISTORY'S HONEST LIMIT, stated on the page rather than implied.
 *
 * A period refusal is never purged — purgeOldAuditRefusals() deletes only rows on
 * its action allowlist AND without the `[PERIOD_` marker, and nothing else prunes
 * audit_trail — so this list genuinely reaches back as far as its oldest row.
 * What it CANNOT show is a write refused before this server started recording
 * refusals, because those wrote nothing anywhere. An empty history therefore
 * means "nothing has been refused since the recording started", never "nothing
 * has ever been refused", and the difference is the whole reason this note is
 * rendered instead of assumed.
 */
export const PERIOD_HISTORY_NOTE =
  'Refused writes are never purged, so this reaches back as far as the oldest row shown — but a write '
  + 'refused before this server began recording refusals left no record anywhere.'

/**
 * A recorded refusal.
 *
 * ⚠️ `account`, NEVER `who`. `super_admin` is a SHARED login used by several
 * people, so this names a login and a session and can never name a person. The
 * field is called what it holds, and the page must keep saying "account".
 *
 * `periods` is server-parsed and already filtered to well-formed month keys;
 * `unnamedPeriods` is the flag for a row that mentioned months it could not name
 * ("(unrecognized date)", or a list the audit formatter truncated). Rendering
 * either as a month would send someone to reopen a period that does not exist.
 */
export function normalizePeriodRefusal(raw) {
  const periods = asList(raw?.periods).map((p) => String(p)).filter(Boolean)
  return {
    id: raw?.id ?? null,
    at: String(raw?.at ?? '').trim(),
    account: String(raw?.account ?? '').trim(),
    role: String(raw?.role ?? '').trim(),
    action: String(raw?.action ?? '').trim(),
    entity: String(raw?.entity ?? '').trim(),
    entityId: String(raw?.entityId ?? '').trim(),
    code: String(raw?.code ?? '').trim(),
    periods,
    periodLabels: periods.map((p) => monthLabel(p) || p),
    unnamedPeriods: raw?.unnamedPeriods === true,
    attempted: String(raw?.attempted ?? '').trim(),
    note: String(raw?.note ?? '').trim(),
    // ⚠️ toNum, so an absent count stays null rather than becoming 0. A row that
    // says "+0 more suppressed" is a claim the server never made.
    suppressed: toNum(raw?.suppressed),
    details: String(raw?.details ?? ''),
  }
}

/**
 * What a cause code means, in the reader's terms.
 *
 * ⚠️ AN UNRECOGNISED CODE RETURNS '', and the row then renders its raw `details`
 * instead. This is the queue whose entire premise is that a guard added later
 * shows up here without a code change — inventing a sentence for a code this
 * file has never seen would be the one place that premise turns into a lie.
 */
export function refusalCauseText(code) {
  const c = String(code ?? '').trim()
  if (c === 'PERIOD_FINALIZED') return 'the month this would have changed is already closed'
  if (c === 'PERIOD_LOCK_UNREADABLE') {
    return "the server couldn't read the month-end lock table, so it withheld the write rather than risk restating a closed month"
  }
  if (c === 'PERIOD_UNRESOLVED') {
    return "the row carries a date the server can't resolve to a month, so no month it would restate could be confirmed open"
  }
  if (c === 'PERIOD_NOT_FINALIZED') {
    return "the month is over but still inside its grace window, so it isn't settleable yet"
  }
  return ''
}

/**
 * An invoice a closed month is holding.
 *
 * ⚠️ `neverPayable` IS THE FIGURE THIS QUEUE EXISTS FOR. Only the `paid`
 * transition carries a month-end guard — submit, approve and processing do not —
 * so a Draft in a finalized month walks all the way to Approved and then stops
 * for good. Unlike an un-adjustable invoice, which needs nothing unless somebody
 * wants to change it, this one is waiting on a payment that cannot arrive, and
 * there is no in-app remedy short of reopening the month.
 *
 * `adjustable` is server-told and always false here by construction: a row only
 * reaches this list because invoiceMonthLockBlockers() refused it.
 */
export function normalizeFrozenInvoice(raw) {
  const periods = asList(raw?.periods).map((p) => String(p)).filter(Boolean)
  return {
    id: raw?.id ?? null,
    invoiceNumber: String(raw?.invoiceNumber ?? '').trim(),
    driver: String(raw?.driver ?? '').trim(),
    weekStart: String(raw?.weekStart ?? '').trim(),
    weekEnd: String(raw?.weekEnd ?? '').trim(),
    status: String(raw?.status ?? '').trim(),
    isManual: raw?.isManual === true,
    amount: toNum(raw?.amount),
    paidAt: String(raw?.paidAt ?? '').trim(),
    cause: String(raw?.cause ?? '').trim(),
    periods,
    periodLabels: periods.map((p) => monthLabel(p) || p),
    adjustable: raw?.adjustable === true,
    neverPayable: raw?.neverPayable === true,
    // ⚠️ NOT `!neverPayable`. Server-told, and it is a THIRD state: the server
    // tests an explicit terminal list (Paid / Rejected), so an unrecognised status
    // is neither stuck-before-paid nor settled. Deriving it by negation here would
    // silently promote an unknown status to "finished, nothing waiting on it" —
    // the one direction that stops a row being reported at all.
    settled: raw?.settled === true,
    detail: String(raw?.detail ?? '').trim(),
    remedy: String(raw?.remedy ?? '').trim(),
  }
}

/**
 * What is actually stuck about this invoice, and what it would take to unstick
 * it. Same job as voidBlockedReason(): the page must never state a problem
 * without naming the remedy that applies to it.
 *
 * ⚠️ THE UNRESOLVED-DATE BRANCH IS A DEAD END AND SAYS SO. No route in this app
 * can edit `week_start` / `week_end` — the only two writers are the INSERTs — so
 * "reopen the month" is not merely unhelpful there, it names no month at all.
 *
 * ⚠️ BUT STATUS STILL DECIDES, ON BOTH BRANCHES. That arm used to return before
 * any status check, so a PAID invoice with an unparseable week date was told it
 * "has to be regenerated" — telling someone to redo a settlement that has already
 * been sent, while the queue's own headline count (server-side `noRemedy`) had
 * stopped counting it as work. `settled` is server-told and is a third state, not
 * `!neverPayable`: an unrecognised status keeps the dead-end sentence AND its
 * place in the count, so the row and the headline agree in that case too. Zero
 * rows reach this arm today (0 of 25 frozen) — shape for the day one does.
 */
export function frozenInvoiceImpact(inv) {
  if (!inv) return ''
  if (inv.cause === 'PERIOD_UNRESOLVED') {
    return inv.settled
      ? "Can't be adjusted, and its billing dates can't be resolved to a month — but it is already "
        + `${inv.status || 'settled'}, so nothing is waiting on it.`
      : "Neither adjustable nor payable, and no route in the app can edit an invoice's billing dates — "
        + 'this one has to be regenerated.'
  }
  const months = inv.periodLabels.length ? periodList(inv.periods) : ''
  const where = months ? `${months} would have to be reopened first` : 'the month would have to be reopened first'
  if (inv.neverPayable) {
    return `Can't be adjusted, and can never be marked Paid — it is ${inv.status || 'unpaid'}, and ${where}.`
  }
  return `Can't be adjusted. It is already ${inv.status || 'settled'}, so nothing is waiting on it.`
}

/**
 * The whole payload, or null.
 *
 * ⚠️ null FOR AN ABSENT PAYLOAD, and it is the same rule the queue states run on
 * one level up. A synthesised zero here would flow straight into
 * periodIssueCounts() and out to the bar as a confident "0", from a call that
 * never answered. The caller only ever reaches this with an `ok` state, and this
 * is the guard for the day that stops being true.
 *
 * Everything reported is SERVER-TOLD. In particular `meaningful` is derived only
 * from facts the server stated about its own tables — never from the shape of the
 * lists, because "both lists are empty" is precisely the input that cannot tell
 * a healthy month-end from one that never ran.
 */
export function periodLockReport(payload) {
  if (!payload) return null
  const s = payload.invoiceSummary || {}
  const locksReadable = payload.locksReadable !== false
  const auditReadable = payload.auditReadable !== false
  const lockedPeriods = asList(payload.lockedPeriods).map((p) => String(p)).filter(Boolean)
  const lockedCount = toNum(payload.lockedCount) ?? lockedPeriods.length
  const refusalCount = toNum(payload.refusalCount) ?? 0
  const refusals = asList(payload.refusals).map(normalizePeriodRefusal)
  const invoices = asList(payload.invoices).map(normalizeFrozenInvoice)
  const invoiceCount = toNum(payload.invoiceCount) ?? invoices.length
  return {
    closeEnabled: Boolean(payload.closeEnabled),
    locksReadable,
    auditReadable,
    lockedPeriods,
    lockedCount,
    currentPeriod: String(payload.currentPeriod ?? '').trim(),
    auditRows: toNum(payload.auditRows) ?? 0,

    refusals,
    // ⚠️ 0 RATHER THAN null WHEN `auditReadable` IS FALSE, and that is the
    // server's shape, not a coercion introduced here: it initialises the counter
    // before the try, so a failed read reports zero refusals. Left as 0 because
    // periodIssueCounts() adds it, and a null there turns the queue's headline
    // into NaN — but it means NO SURFACE MAY PRINT THIS NUMBER WITHOUT CHECKING
    // `auditReadable` FIRST. The rollup card in DataIssuesView renders "—" and
    // says the table couldn't be read; anything new here must do the same.
    refusalCount,
    // Server-told, never `refusalCount > refusals.length` — the two agree today
    // and the server is the only side that has seen the full set.
    refusalTruncated: payload.refusalTruncated === true,
    refusalShown: toNum(payload.refusalShown) ?? refusals.length,
    refusalOldest: payload.refusalOldest || null,
    refusalNewest: payload.refusalNewest || null,

    invoices,
    invoiceCount,
    invoiceTruncated: payload.invoiceTruncated === true,
    invoiceShown: toNum(payload.invoiceShown) ?? invoices.length,
    liveInvoices: toNum(payload.liveInvoices) ?? 0,
    summary: {
      live: toNum(s.live) ?? 0,
      frozen: toNum(s.frozen) ?? 0,
      neverPayable: toNum(s.neverPayable) ?? 0,
      unresolvedDates: toNum(s.unresolvedDates) ?? 0,
      // ⚠️ SERVER-TOLD, NEVER `neverPayable + unresolvedDates`. The two overlap —
      // a Draft carrying an unparseable week date is both — so adding them here
      // would double-count that row in the headline the queue leads with.
      noRemedy: toNum(s.noRemedy) ?? 0,
      frozenAmount: toNum(s.frozenAmount) ?? 0,
      neverPayableAmount: toNum(s.neverPayableAmount) ?? 0,
    },

    // The establishment contract, as one boolean. See queueEstablished().
    meaningful: locksReadable && auditReadable && lockedCount > 0,
  }
}

/**
 * The bar's split — "N to fix · M closed".
 *
 * `actionable` leads because the count exists to answer "how much work is
 * there", and only a row with NO in-app remedy is work: an invoice that can
 * never be marked Paid, or one whose billing dates cannot be resolved at all. A
 * refused write already didn't happen and an un-adjustable-but-settled invoice
 * needs nothing, so both sit under `closed` — which is the literal truth for
 * every row in this queue, all of which are about a closed month.
 *
 * Both figures come from the server's full-set counts, never from the rendered
 * lists, so a truncated table can never understate the headline.
 */
export function periodIssueCounts(report) {
  if (!report) return { total: 0, actionable: 0, closed: 0 }
  const total = report.invoiceCount + report.refusalCount
  const actionable = Math.min(report.summary.noRemedy, total)
  return { total, actionable, closed: Math.max(0, total - actionable) }
}
