// Presentation logic for GET /api/admin/fuel-gallons-recovery.
//
// The endpoint reads the missing GALLONS back off a stored receipt image and
// returns, per receipt, a VERDICT plus a plain-English reason. This file turns
// that into something a human can scan: what each verdict means, which ones are
// work, which ones are closed, and how to say "these 25 are all locked" once
// instead of twenty-five times.
//
// Pure — no Vue, no fetch. Same contract and the same defensiveness as
// lib/fuelReview.js, which owns the queue these receipts also appear in:
//   · `undefined` ("the server didn't say") is NOT `null` and NOT 0. An absent
//     key renders NOTHING — no dash, no zero. A dash is a claim that we looked
//     and found nothing; silence is the only honest rendering of a question that
//     was never asked. See `has()` and the evidence rows.
//   · The verdict is the server's, never re-derived here. A second definition of
//     "recovered" living in the client is exactly how a UI comes to disagree
//     with the audit trail it is describing.
//
// WHY A TABLE OF VERDICTS RATHER THAN `if (verdict === 'recovered')`:
// judgeGallonsRecovery() has an ORDERED ladder of eleven outcomes and the apply
// path adds three more. Today's production data exercises exactly one of them
// (`locked_period`, 25 of 25). A screen built only around what is currently on
// screen would render an unstyled raw string like `no_gallons_on_receipt` the
// first time the periods reopen — so every verdict the server can emit is named
// here, including the three only the POST can produce.

import { toNum, asList, monthLabel } from './fuelReview';

/**
 * Is the key actually present on the wire?
 *
 * `hasOwnProperty` rather than a truthiness or null check, because the three
 * states are genuinely different and collapse in opposite directions:
 *   · absent   -> an older server, or a verdict decided before this was measured
 *   · null     -> present and deliberately not applicable to this verdict
 *   · 0        -> MEASURED, and the single most important value in the payload
 *                 ("the OCR'd total matched the stored amount to the cent")
 * A `row.amountDelta ||` fallback would print the corroboration's best possible
 * result as though it were missing.
 */
export function has(row, key) {
  return !!row && Object.prototype.hasOwnProperty.call(row, key) && row[key] !== null && row[key] !== undefined;
}

// ── The verdict table ────────────────────────────────────────────────────────
//
// `group` drives the summary strip and the ordering; `tone` drives colour only.
// They are separate because two verdicts can need the same colour and different
// grouping ('ocr_failed' and 'not_attempted' are both neutral, but only one of
// them is worth re-running immediately).
//
// `actionable: false` on `locked_period` is load-bearing and is asserted here,
// once, rather than at each call site — the panel must never offer a closed
// receipt as work. The same rule is already written into ExpensesTab's queue.
export const RECOVERY_GROUPS = {
  recoverable: {
    key: 'recoverable',
    label: 'Ready to apply',
    // Deliberately not "verified". The corroboration is strong (the reading's
    // own total reproduces the row's stored amount) but it is still a machine
    // reading a photograph, and the whole point of showing the evidence is that
    // a human signs it off. server.js says the same thing about the future chip
    // on recentFills: label it "read from receipt", never "verified".
    blurb: 'The receipt was read, its total matches the amount already on the row, and the implied price per gallon is inside this fleet’s normal range.',
  },
  closed: {
    key: 'closed',
    label: 'Closed month',
    blurb: 'Booked to a month that month-end close has finalized. Listed so the gap stays visible — but nothing here can be written.',
  },
  manual: {
    key: 'manual',
    label: 'Needs a person',
    blurb: 'Nothing is wrong with the row — there is simply no volume on the paper to read, or no paper to read it from. These have to be keyed by hand.',
  },
  refused: {
    key: 'refused',
    label: 'Reading refused',
    blurb: 'A reading came back and was disbelieved. Each one names which check it failed — the gallons are NOT proposed, deliberately.',
  },
  retry: {
    key: 'retry',
    label: 'Not read yet',
    blurb: 'The scanner did not return an answer for these. Nothing is decided about them either way; run it again.',
  },
  settled: {
    key: 'settled',
    label: 'Already handled',
    blurb: 'Resolved by someone else while the batch was running, so this run left them alone.',
  },
};

const V = (key, group, label, tone, actionable = false) => [key, { key, group, label, tone, actionable }];

export const VERDICTS = Object.fromEntries([
  // The one success.
  V('recovered', 'recoverable', 'Gallons found', 'good', true),

  // Refused before a single Gemini call is made — a closed month costs nothing
  // to decline. Never actionable, at any call site.
  V('locked_period', 'closed', 'Month closed', 'muted', false),

  // Read, believed to be this row's receipt, but no volume on it (or nothing to
  // read at all). A person with the paper can fix these; the scanner can't.
  V('no_gallons_on_receipt', 'manual', 'No volume printed', 'amber'),
  V('no_photo', 'manual', 'No receipt on file', 'amber'),
  V('no_stored_amount', 'manual', 'No amount to check against', 'amber'),
  V('amount_unreadable', 'manual', 'Total unreadable', 'amber'),

  // A reading happened and failed a gate. These are the interesting ones: the
  // refusal is the feature working, not an error.
  V('amount_mismatch', 'refused', 'Wrong receipt', 'refused'),
  V('implausible_cpg', 'refused', 'Price out of range', 'refused'),
  V('implausible_gallons', 'refused', 'Volume out of range', 'refused'),
  V('no_price_band', 'refused', 'No price band', 'refused'),

  // No answer either way.
  V('ocr_failed', 'retry', 'Could not be read', 'neutral'),
  V('not_attempted', 'retry', 'Batch ran out of time', 'neutral'),

  // Apply-path only. Present because the POST returns the same row shape, and a
  // panel that renders the proposal but not the result of applying it would go
  // blank at the one moment someone is watching hardest.
  V('already_entered', 'settled', 'Entered elsewhere', 'muted'),
  V('vanished', 'settled', 'Row deleted', 'muted'),
]);

// Order the groups appear in. Recoverable first (it is the only thing anyone can
// act on), closed LAST but never hidden — the same call the volumeless queue
// makes, for the same reason: hiding a closed row recreates the blindness the
// queue exists to remove.
const GROUP_ORDER = ['recoverable', 'refused', 'manual', 'retry', 'settled', 'closed'];

/**
 * A verdict we have never seen. Rendered as itself rather than dropped, so a
 * server that grows a twelfth outcome shows up as an unstyled but VISIBLE row
 * instead of a receipt that silently vanishes from a reconciliation screen.
 */
export function verdictMeta(verdict) {
  const key = String(verdict || '').trim();
  return VERDICTS[key] || {
    key: key || 'unknown',
    group: 'retry',
    // Humanize rather than print the raw token: "no_gallons_on_receipt" in a
    // status column reads as a bug, which is the wrong thing to draw the eye.
    label: key ? key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Unknown',
    tone: 'neutral',
    actionable: false,
  };
}

export function groupMeta(group) {
  return RECOVERY_GROUPS[group] || RECOVERY_GROUPS.retry;
}

/** Is this receipt something a human can act on right now? */
export function isActionable(row) {
  return verdictMeta(row?.verdict).actionable === true && toNum(row?.proposedGallons) !== null;
}

/** A closed row. Asked as its own question so no call site re-derives it. */
export function isClosed(row) {
  return verdictMeta(row?.verdict).group === 'closed';
}

/**
 * One wire row -> display shape.
 *
 * Numbers go through toNum so '' and non-numeric text collapse to null rather
 * than NaN, and `has()` is captured up front so the template asks about
 * PRESENCE without repeating the hasOwnProperty dance in six places.
 */
export function normalizeRecoveryRow(raw) {
  const meta = verdictMeta(raw?.verdict);
  const amount = toNum(raw?.amount);
  return {
    id: raw?.expenseId ?? raw?.id ?? null,
    localDay: String(raw?.localDay || ''),
    periodLabel: monthLabel(raw?.localDay),
    truckUnit: String(raw?.truckUnit || '').trim(),
    driver: String(raw?.driver || '').trim(),
    vendor: String(raw?.vendor || '').trim(),
    amount,
    verdict: meta.key,
    label: meta.label,
    tone: meta.tone,
    group: meta.group,
    actionable: meta.actionable === true && toNum(raw?.proposedGallons) !== null,
    // The server's sentence, rendered verbatim. It is written for a human, it
    // names the remedy, and it is the same string that lands in the audit line —
    // paraphrasing it here would put two wordings of one decision in the app.
    reason: String(raw?.reason || ''),
    proposedGallons: toNum(raw?.proposedGallons),
    impliedCpg: toNum(raw?.impliedCpg),
    amountDelta: toNum(raw?.amountDelta),
    // Tri-state, and it must stay tri-state: true (agreed), false (disagreed —
    // reported, never a gate), null/absent (not compared). See the "what is
    // deliberately NOT a gate" note in lib/receipt-gallons-recovery.js.
    dateMatches: raw?.dateMatches === true ? true : raw?.dateMatches === false ? false : null,
    ocrVendor: String(raw?.ocrVendor || ''),
    ocrDate: String(raw?.ocrDate || ''),
    ocrConfidence: String(raw?.ocrConfidence || ''),
    written: raw?.written === true,
    hasGallons: has(raw, 'proposedGallons'),
    hasCpg: has(raw, 'impliedCpg'),
    hasDelta: has(raw, 'amountDelta'),
    hasDateMatch: raw?.dateMatches === true || raw?.dateMatches === false,
    hasConfidence: has(raw, 'ocrConfidence') && String(raw.ocrConfidence).trim() !== '',
  };
}

export function recoveryRows(payload) {
  return asList(payload?.receipts).map(normalizeRecoveryRow);
}

/**
 * Rows sectioned BY VERDICT, ordered by group, each carrying its own count,
 * money, and — when every row in it says the same thing — the reason hoisted out
 * of the rows and onto the section.
 *
 * THE HOIST IS THE WHOLE POINT OF THIS FUNCTION. All 25 receipts in production
 * today carry the byte-identical sentence "This receipt is booked to a finalized
 * month. Reopen the period, or record the correction as a payout adjustment."
 * Rendering it per row is 25 reads of one fact — precisely the thing the brief
 * asks to replace with a single glance. Some reasons DO differ per row (the
 * refusals interpolate the actual figures: "$90.00 over 10 gal implies
 * $9.00/gal…"), and those must stay on the row, because there the sentence is
 * the evidence. So the split is decided from the data rather than from a list of
 * which verdicts are "static" — a list that would rot the moment a reason string
 * gained an interpolation.
 *
 * The MONEY is what makes this a finding rather than a chore: "25 receipts" is a
 * list, "$5,551.54 of diesel, all in closed months" is a fact about the books.
 */
export function verdictSections(rows) {
  const list = asList(rows);
  const acc = new Map();
  for (const r of list) {
    const cur = acc.get(r.verdict) || {
      verdict: r.verdict, label: r.label, tone: r.tone, group: r.group,
      count: 0, amount: 0, gallons: 0, rows: [],
    };
    cur.count += 1;
    cur.amount += r.amount ?? 0;
    if (r.proposedGallons !== null) cur.gallons += r.proposedGallons;
    cur.rows.push(r);
    acc.set(r.verdict, cur);
  }
  return [...acc.values()]
    .map((s) => {
      const reasons = new Set(s.rows.map((r) => r.reason).filter(Boolean));
      const shared = reasons.size === 1 && s.rows.every((r) => r.reason) ? [...reasons][0] : '';
      return {
        ...s,
        amount: round2(s.amount),
        gallons: round2(s.gallons),
        blurb: groupMeta(s.group).blurb,
        sharedReason: shared,
        // Rows still need their own reason whenever it is NOT the shared one.
        rowsCarryReason: !shared,
        actionableCount: s.rows.filter((r) => r.actionable).length,
      };
    })
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || b.count - a.count);
}

/**
 * The chip strip: one entry per verdict actually present, count + money.
 *
 * This is the "single glance" requirement. Counts come from the ROWS rather than
 * `summary.byVerdict` — the two describe the same batch, but only the rows carry
 * the amount, and deriving the pair from one source means the count and the
 * money can never disagree on screen.
 */
export function verdictChips(rows) {
  const list = asList(rows);
  const acc = new Map();
  for (const r of list) {
    const cur = acc.get(r.verdict) || { verdict: r.verdict, label: r.label, tone: r.tone, group: r.group, count: 0, amount: 0 };
    cur.count += 1;
    cur.amount += r.amount ?? 0;
    acc.set(r.verdict, cur);
  }
  const order = (v) => GROUP_ORDER.indexOf(verdictMeta(v).group);
  return [...acc.values()]
    .map((c) => ({ ...c, amount: round2(c.amount) }))
    .sort((a, b) => order(a.verdict) - order(b.verdict) || b.count - a.count);
}

/**
 * Where an implied price sits against the fleet's own band, as a 0-1 position
 * for a meter, plus whether it fell outside.
 *
 * The point of drawing this rather than printing two numbers: `$9.00/gal` next
 * to `$2.85-$6.78` is arithmetic the reader has to do. A marker sitting hard
 * against the end of a bar is not. That receipt (expense #149, $90.00 over 10
 * gal, a perfectly matching total) is the exact case the price gate exists for,
 * so it has to LOOK wrong, not merely be reported as wrong.
 *
 * Returns null when either half is missing — a meter with no band is a bar chart
 * of one number, which invites exactly the eyeballed comparison it replaced.
 */
export function cpgMeter(cpg, band) {
  const v = toNum(cpg);
  const lo = toNum(band?.min);
  const hi = toNum(band?.max);
  if (v === null || lo === null || hi === null || !(hi > lo)) return null;
  // A quarter of the band's width of runway on each side, so an in-band value
  // never renders flush against the edge and an out-of-band one has somewhere
  // visible to sit. Values beyond the runway clamp and are flagged, rather than
  // rescaling the axis — a band that grows to fit its outlier stops being a band.
  const pad = (hi - lo) * 0.25;
  const axisLo = lo - pad;
  const axisHi = hi + pad;
  const clamp = (n) => Math.max(0, Math.min(1, n));
  return {
    value: v,
    min: lo,
    max: hi,
    inBand: v >= lo && v <= hi,
    // Band edges as a percentage of the drawn axis.
    bandStartPct: clamp((lo - axisLo) / (axisHi - axisLo)) * 100,
    bandEndPct: clamp((hi - axisLo) / (axisHi - axisLo)) * 100,
    valuePct: clamp((v - axisLo) / (axisHi - axisLo)) * 100,
    // True when the marker is pinned at an end and its real position is further
    // out, so the UI can say "off the scale" instead of implying it is merely
    // at the edge.
    clamped: v < axisLo || v > axisHi,
    below: v < lo,
    above: v > hi,
  };
}

/**
 * How the band itself was derived. `fleet` is measured from this carrier's own
 * priced receipts; either fallback means the sample was unusable and a fixed
 * band is standing in — which changes how much weight a refusal deserves, so it
 * is surfaced rather than left in the payload.
 */
export function bandSourceNote(band) {
  const n = toNum(band?.n);
  const src = String(band?.source || '');
  if (src === 'fleet') {
    return n === null
      ? 'Derived from this fleet’s own priced fuel receipts.'
      : `Derived from the ${n} fuel receipts on file that already record a volume — so it tracks this carrier’s actual buying, not a hardcoded constant.`;
  }
  if (src === 'fallback') {
    return `Too few priced receipts on file${n === null ? '' : ` (${n})`} to derive a band from this fleet, so a fixed range is standing in.`;
  }
  if (src === 'fallback_degenerate') {
    return 'The fleet’s own priced receipts produced an unusable band, so a fixed range is standing in.';
  }
  return '';
}

/**
 * The one-sentence finding, composed from what the run actually established.
 *
 * Composed rather than templated per state for the same reason
 * reviewClearPhrases() is: the sentence must never outrun the data. When every
 * candidate landed on one verdict, it SAYS so — that is the single glance the
 * whole screen is for, and today it is the true description of production.
 */
export function recoveryHeadline(rows) {
  const list = asList(rows);
  if (!list.length) return '';
  const money = fmtMoney(list.reduce((s, r) => s + (r.amount ?? 0), 0));
  const n = list.length;
  const receipts = `${n} receipt${n === 1 ? '' : 's'}`;
  const chips = verdictChips(list);

  if (chips.length === 1) {
    const only = chips[0];
    const g = groupMeta(only.group);
    return `All ${receipts} examined (${money}) came back the same: ${only.label.toLowerCase()}. ${g.blurb}`;
  }

  const ready = list.filter(isActionable);
  const closed = list.filter(isClosed);
  const parts = [`${receipts} examined (${money})`];
  if (ready.length) {
    const gal = round2(ready.reduce((s, r) => s + (r.proposedGallons ?? 0), 0));
    parts.push(`${ready.length} ready to apply (${gal} gal)`);
  }
  if (closed.length) parts.push(`${closed.length} in a closed month`);
  const rest = n - ready.length - closed.length;
  if (rest > 0) parts.push(`${rest} refused or unread`);
  return parts.join(' · ') + '.';
}

// The server's own ceiling on one call (FUEL_GALLONS_BATCH_MAX). A backlog at or
// under this can be covered in a single pass by asking for it; past it, no
// single run can finish and saying otherwise would be the same false promise
// this function exists to remove.
export const BATCH_MAX = 40;

/**
 * What this run actually covered — and, when it didn't cover everything, WHICH
 * KIND of "not covered" it was. The two have opposite remedies and the payload
 * folds them into one `remaining`, so they have to be separated here.
 *
 * ⚠️ THIS IS WHY THE NAIVE WORDING IS A BUG. `remaining` counts two things:
 *   · rows past the batch cap. The candidate query is
 *     `ORDER BY e.date DESC, e.id DESC` and the batch is `slice(0, cap)` — fully
 *     deterministic. So re-running at the same limit returns THE IDENTICAL SET,
 *     forever. "Run it again to pick them up" is a loop with no exit, and an
 *     admin who follows it concludes the tool is broken. They need a BIGGER
 *     limit, which is a different button.
 *   · rows stamped `not_attempted` because the batch hit its two-minute
 *     deadline. Those genuinely are picked up by running again.
 * Today's production backlog is 29 with 25 selected: the 4 "remaining" are the
 * first kind — a cap, not a queue that drains.
 */
export function coverageDetail(payload, rows) {
  const backlog = toNum(payload?.backlog);
  const remaining = toNum(payload?.remaining) || 0;
  const examined = asList(payload?.receipts).length;
  const notAttempted = asList(rows).filter((r) => r.verdict === 'not_attempted').length;
  // Everything `remaining` did not explain as a deadline casualty is over-cap.
  const overCap = Math.max(0, remaining - notAttempted);
  return {
    backlog, examined, remaining, notAttempted, overCap,
    // A single wider pass can finish the job only if the whole backlog fits.
    canScanAll: overCap > 0 && backlog !== null && backlog <= BATCH_MAX,
    scanAllLimit: backlog !== null ? Math.min(backlog, BATCH_MAX) : BATCH_MAX,
  };
}

export function coverageNote(payload, rows) {
  const c = coverageDetail(payload, rows);
  if (c.backlog === null || !c.examined) return '';
  if (!c.remaining) {
    return c.backlog > c.examined
      ? `Examined ${c.examined} of ${c.backlog} receipts in the backlog.`
      : `Examined all ${c.examined} receipt${c.examined === 1 ? '' : 's'} in the backlog.`;
  }

  const parts = [`Examined ${c.examined} of ${c.backlog} receipts.`];
  if (c.overCap > 0) {
    // Named as a CAP, never as a queue that drains — and the remedy is stated
    // as the wider scan, not as "run it again".
    parts.push(
      c.canScanAll
        ? `${c.overCap} more ${c.overCap === 1 ? 'sits' : 'sit'} past this pass’s limit of ${c.examined}; a re-run reads the same ${c.examined} again, so use “Scan all ${c.scanAllLimit}” to reach ${c.overCap === 1 ? 'it' : 'them'}.`
        : `${c.overCap} more ${c.overCap === 1 ? 'sits' : 'sit'} past the ${BATCH_MAX}-receipt ceiling on a single pass. Clearing the ones above is what brings ${c.overCap === 1 ? 'it' : 'them'} into range — re-running alone reads the same ${c.examined} again.`
    );
  }
  if (c.notAttempted > 0) {
    parts.push(`${c.notAttempted} ran out of time and ${c.notAttempted === 1 ? 'is' : 'are'} picked up by running again.`);
  }
  return parts.join(' ');
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Money, always two decimals and grouped. Matches ExpensesTab's fmtMoney. */
export function fmtMoney(v) {
  return v === null || v === undefined
    ? ''
    : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Gallons. Trailing zeros dropped — 42.00 gal is not more precise than 42. */
export function fmtGallons(v) {
  const n = toNum(v);
  return n === null ? '' : `${Number(n.toFixed(2))} gal`;
}

/** A price per gallon. Always 2dp — "$4.5/gal" reads as a truncation. */
export function fmtCpg(v) {
  const n = toNum(v);
  return n === null ? '' : `$${n.toFixed(2)}/gal`;
}

/**
 * The amount-corroboration result: did the gate PASS, and how to say so.
 *
 * ⚠️ PASS/FAIL COMES FROM THE VERDICT, NOT FROM `delta === 0`. The server's
 * tolerance is `max($0.02, 0.1% of the amount)` — deliberate slack so a cent of
 * rounding on a large ticket cannot refuse an otherwise perfect read. So a
 * non-zero delta on a `recovered` row means the gate PASSED WITH SLACK, and
 * marking it with a red cross would contradict both the verdict beside it and
 * the server's own sentence ("Total matches to the cent"). Only
 * `amount_mismatch` is the failure, and it is the verdict that says so.
 *
 * This is the same rule the rest of this file follows: the server judged it,
 * the client renders it. Re-deriving the judgement here is how a UI comes to
 * disagree with the audit line describing the same row.
 *
 * `0` still gets its own wording, because it is the strongest evidence in the
 * payload — measured across all 24 unlocked production candidates it was $0.00,
 * 24 times — and "matches to the cent" says that far better than "$0.00 over".
 */
export function amountEvidence(row) {
  const n = toNum(row?.amountDelta);
  if (n === null) return null;
  const failed = row?.verdict === 'amount_mismatch';
  if (failed) {
    const sign = n > 0 ? 'over' : 'under';
    return { ok: false, text: `${fmtMoney(Math.abs(n))} ${sign} the amount on the row` };
  }
  if (n === 0) return { ok: true, text: 'matches to the cent' };
  const sign = n > 0 ? 'over' : 'under';
  return { ok: true, text: `within tolerance — ${fmtMoney(Math.abs(n))} ${sign}` };
}
