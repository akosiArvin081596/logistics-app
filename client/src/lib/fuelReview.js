// Fuel-up / receipt reconciliation helpers.
//
// Single source of truth for the two Fuel Logs review queues, for the tank
// calibration readout, and for how an odometer reading is labelled wherever it
// appears. Same shape and spirit as lib/loadReview.js: pure functions, no Vue,
// so the expenses panel and the truck record can never drift on what "no
// reading", "implied capacity", or "worth a look" means.
//
// WHY THE DEFENSIVENESS: these fields are added by a newer server. Every reader
// has to survive an older one that doesn't send them — and the distinction that
// matters is that `undefined` ("this server can't tell us") is NOT `[]` ("we
// checked, nothing to review"). The first must stay silent; only the second may
// say "all clear". Callers get that split from isReviewAvailable(), never from
// a truthiness check on the array.
//
// Nothing here decides anything on a truck's behalf. The calibration figures in
// particular are an OBSERVATION next to a CONFIGURATION — a human changes the
// configured capacity, in Trucks → Edit.

// The ONE import in this file, and the '.js' on it, are both deliberate: the
// month formatter is shared with lib/payoutPeriod.js (two copies of it under one
// name in one directory is what this change undoes), and bare Node — the
// scripts/test-*.js locks — resolves only the explicit specifier. Imported
// rather than re-exported straight through because this file calls it itself.
import { monthLabel } from './monthLabel.js';

/** '', null, undefined and non-numeric text all collapse to null — never 0. */
export function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Array or nothing. Keeps `v-for` off undefined without hiding the difference. */
export function asList(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * An odometer for display. 0 and blank both mean "never recorded" on this data
 * (no tractor reads 0), so both fall back rather than printing a confident 0 —
 * the contract is explicit that null renders as an em dash, never as zero.
 */
export function fmtOdometer(v, { fallback = '—', unit = '' } = {}) {
  const n = toNum(v);
  if (n === null || n <= 0) return fallback;
  return Math.round(n).toLocaleString('en-US') + unit;
}

/**
 * A hand-entered reading that is too low to be a tractor's odometer. Exists
 * because both odometers ever typed on a receipt in this fleet are wrong, and
 * one of them is the literal value 1.0.
 *
 * Only applied to receipt-sourced numbers: a telemetry reading is machine-read,
 * so a low value there is a device story, not a typing story. Deliberately a
 * very low bar (1,000 mi) so it flags obvious junk and leaves judgement calls
 * alone — the other bad reading in this data (96,538 against a true 992,938)
 * is NOT detectable without the truck's real figure, and is not guessed at.
 */
export function isSuspectOdometer(v, source) {
  if (source !== 'receipt') return false;
  const n = toNum(v);
  return n !== null && n > 0 && n < 1000;
}

const ODOMETER_SOURCES = {
  receipt: {
    key: 'receipt',
    label: 'receipt',
    title: 'Read off the receipt the driver uploaded.',
  },
  telemetry: {
    key: 'telemetry',
    label: 'ELD',
    title: "From the truck's ELD at the moment the tank rose — derived by the system, not written on the receipt.",
  },
};

/**
 * Provenance chip for an odometer, or null when the server didn't say.
 *
 * Null is the honest answer for an older server AND for a row it couldn't
 * attribute: showing no chip claims nothing, whereas defaulting to "receipt"
 * would put a derived number on the paper.
 */
export function odometerSource(source) {
  return ODOMETER_SOURCES[source] || null;
}

// ---------------------------------------------------------------------------
// Review queues
// ---------------------------------------------------------------------------

/**
 * The four review queues, and the payload key each one answers.
 *
 * They are kept SEPARATE rather than merged into one "problems" list because
 * they are four different problems with four different fixes: chase a missing
 * receipt · check the truck on a receipt · type the gallons in · correct a typed
 * odometer. A single list would force a "kind" column and lose the count that
 * makes each one actionable.
 *
 * `clear` is what this queue is entitled to assert when it is available and
 * empty — see reviewClearPhrases() for why that is per-queue and not one
 * sentence.
 */
export const REVIEW_QUEUES = [
  { key: 'fills', field: 'unmatchedFills', clear: 'every fuel-up has a receipt' },
  { key: 'receipts', field: 'unmatchedReceipts', clear: 'every receipt has a fuel-up' },
  { key: 'volumeless', field: 'volumelessReceipts', clear: 'every fuel receipt has gallons' },
  { key: 'odometer', field: 'odometerConflicts', clear: 'no receipt odometer disagrees with the ELD' },
];

/**
 * Did this server answer THIS question? Availability is per-queue, not one flag
 * for the panel, and that distinction is the whole absent-vs-[] contract applied
 * one level up.
 *
 * The queues do not necessarily ship together. The three telemetry-derived ones
 * are omitted wholesale until the fuel-event sweep has populated its table,
 * whereas "which fuel receipt has no gallons on it" is answerable from the
 * expenses table alone and needs no telemetry at all. A single panel-wide flag
 * would therefore let one queue's silence suppress another queue's real answer —
 * or worse, let a queue that never ran borrow another's clean bill of health.
 */
export function isQueueAvailable(fuel, which) {
  const q = REVIEW_QUEUES.find((x) => x.key === which);
  return Boolean(q) && Array.isArray(fuel?.[q.field]);
}

/**
 * Did this server answer ANY of them? Drives whether the review bar renders at
 * all — see the undefined-vs-[] note at the top of the file.
 */
export function isReviewAvailable(fuel) {
  return REVIEW_QUEUES.some((q) => Array.isArray(fuel?.[q.field]));
}

/**
 * The "all clear" phrases this payload has actually earned: one per queue that
 * both answered and came back EMPTY.
 *
 * Composed rather than hardcoded so the reassurance can never outrun the data.
 * A server that sends only `volumelessReceipts: []` has established exactly one
 * fact, and printing the old fixed sentence there would tell a reader that every
 * fuel-up has a receipt — a question that server never asked.
 *
 * "Clear" is deliberately zero ROWS, not zero actionable rows. A queue holding
 * nothing but locked-period rows is not clear: the data in it is still known to
 * be wrong, it just can't be fixed this month. Saying "all clear" over it would
 * be the same misreporting these queues were built to end — and unlike a queue
 * that empties, this one would keep saying it forever.
 */
export function reviewClearPhrases(fuel) {
  return REVIEW_QUEUES
    .filter((q) => Array.isArray(fuel?.[q.field]) && fuel[q.field].length === 0)
    .map((q) => q.clear);
}

// ---------------------------------------------------------------------------
// Month-end close
// ---------------------------------------------------------------------------

/**
 * Is this row's month already finalized by month-end close?
 *
 * SERVER-TOLD ONLY. There is no client-side derivation here and there must never
 * be one: `period_locks` changes every month (14 rows today, 2025-05 → 2026-06),
 * a lock can be reopened by an admin, and the close date is env-tuned
 * (`settlement_grace_days`). A hardcoded month list in the bundle would be stale
 * the first time a period closed and would then either grey out rows a human
 * could still fix, or invite an edit on a month that had just closed.
 *
 * THREE-VALUED, and the third value is the point:
 *   true  — server says finalized. Show it, don't offer the fix.
 *   false — server says open. Fully actionable.
 *   null  — server didn't say. Behave exactly as this panel did before locks
 *           existed: no badge, no split count, row stays actionable.
 *
 * null must not collapse to either boolean. Treating "didn't say" as locked
 * would silently disable a queue the moment it talked to an older server;
 * treating it as open is what the panel already does today, so it is the honest
 * no-op — but it is chosen explicitly here rather than falling out of a
 * truthiness check, so the distinction survives the next edit.
 */
export function lockState(raw) {
  const v = raw?.periodLocked;
  return v === true ? true : v === false ? false : null;
}

/**
 * "May 2026" from a "YYYY-MM-DD" or "YYYY-MM" key, for the closed badge's title.
 *
 * Re-exported, not re-implemented: this file's copy WAS the reference version of
 * the contract (tolerant input, '' when it cannot read the key), so it now names
 * lib/monthLabel.js as the one definition and keeps the export so every existing
 * importer — including lib/dataIssues.js and lib/gallonsRecovery.js, which take
 * it from here — is untouched. Behaviour is unchanged, save that a key with
 * stray whitespace now labels instead of blanking.
 *
 * This is presentation of a date the row already carries, NOT a derivation of
 * lock state; lockState() above is the only thing that decides closed-ness.
 */
export { monthLabel };

/**
 * Split a queue into what someone can act on and what is closed.
 *
 * The primary count everywhere in this panel is `actionable`, because the count
 * exists to answer "how much work is there" — the number that gets someone to
 * click. Folding locked rows into it overstates the work AND guarantees the
 * queue can never reach zero, which is precisely how the rate-con reconciler's
 * daily "needs a manual check" mail taught everyone to ignore it. `closed` is
 * reported alongside, never hidden and never merged.
 *
 * A row whose lock state is unknown counts as actionable — see lockState.
 */
export function queueCounts(rows) {
  const list = asList(rows);
  let closed = 0;
  for (const r of list) if (r?.locked === true) closed++;
  return { total: list.length, actionable: list.length - closed, closed };
}

/**
 * A refuel episode the ELD saw with no receipt filed against it.
 *
 * Field names are the settled analytics contract (`fuelEventWire` in server.js).
 * There is deliberately no second spelling accepted: while the contract was open
 * this read both namings, but a fallback whose branch can never be taken is a
 * branch nobody maintains — it would quietly rot into a lie about what the
 * server sends.
 */
export function normalizeUnmatchedFill(raw) {
  const vehicleId = String(raw?.vehicleId ?? '').trim();
  const unitNumber = String(raw?.unitNumber ?? '').trim();
  const pctBefore = toNum(raw?.pctBefore);
  const pctAfter = toNum(raw?.pctAfter);
  const rise = toNum(raw?.rise);
  return {
    // Server-assigned and stable per episode — a truck can fill twice in a day,
    // so neither the day nor the truck is a key on its own.
    key: raw?.eventId ?? `${vehicleId || unitNumber || 'unknown'}:${toNum(raw?.atMs) ?? ''}`,
    vehicleId,
    // Falls back to the raw device id so an unlinked truck still identifies
    // itself; `linked` lets the row say which one it is showing.
    unitNumber,
    label: unitNumber || vehicleId || '—',
    linked: Boolean(unitNumber),
    // Only worth saying "unlinked" when there IS a device id standing in for a
    // unit number. With neither, the row is just blank and the chip would be
    // labelling nothing.
    showUnlinked: !unitNumber && Boolean(vehicleId),
    localDay: String(raw?.localDay ?? '').trim(),
    atMs: toNum(raw?.atMs),
    pctBefore,
    pctAfter,
    // The server sends `rise` alongside the endpoints; prefer the endpoints so
    // the cell can show what the needle actually did, and fall back to `rise`
    // so a payload carrying only the jump still says how big it was.
    risePts: pctBefore !== null && pctAfter !== null
      ? Math.round(pctAfter - pctBefore)
      : (rise !== null ? Math.round(rise) : null),
    odometer: toNum(raw?.odometer),
  };
}

/**
 * A fuel receipt with no detected tank rise behind it.
 *
 * NOTE the date key: this is `localDay` (the Houston business day), NOT `date`.
 * The receipt's own `date` column is what feeds it server-side, but the wire
 * name is `localDay` on both reconciliation lists so they read alike. Binding
 * this to `date` renders an em dash on every row — silently, since a missing
 * date looks exactly like a receipt with no date.
 *
 * There is no `driver` on this payload (the sweep joins expenses to trucks, not
 * to drivers), which is why the queue table has no Driver column — see the note
 * there. The detail modal a row opens has the driver.
 */
export function normalizeUnmatchedReceipt(raw) {
  return {
    id: raw?.id ?? null,
    localDay: String(raw?.localDay ?? '').trim(),
    truckUnit: String(raw?.truckUnit ?? '').trim(),
    vendor: String(raw?.vendor ?? '').trim(),
    gallons: toNum(raw?.gallons),
    amount: toNum(raw?.amount),
  };
}

export function unmatchedFills(fuel) {
  return asList(fuel?.unmatchedFills).map(normalizeUnmatchedFill);
}

export function unmatchedReceipts(fuel) {
  return asList(fuel?.unmatchedReceipts).map(normalizeUnmatchedReceipt);
}

/**
 * A fuel receipt carrying a dollar amount and no gallons.
 *
 * The costliest of the four queues by a distance, and the cheapest to fix: 25 of
 * #33's 32 fuel receipts have no volume on them, which is why that truck cannot
 * assemble enough tank-to-tank legs to measure its own MPG and its driver still
 * sees the 6.5 fleet default. Every row here is somebody opening the receipt and
 * typing one number.
 *
 * Unlike normalizeUnmatchedReceipt this payload DOES carry `driver` — it is
 * sourced from the expense row itself rather than from a join to trucks — which
 * is why this queue's table has a Driver column and the other's deliberately
 * does not. Do not "harmonize" the two; each shows what its own payload knows.
 *
 * `amount` is kept null rather than 0 when absent. A volumeless receipt whose
 * amount also failed to read is a worse row, not a $0.00 one, and the total must
 * not silently absorb it as nothing.
 */
export function normalizeVolumelessReceipt(raw) {
  return {
    // `expenseId`, verified against the live payload — note this queue keys the
    // expense differently from odometerConflicts, which calls the same entity
    // `id`. Only the one spelling is read, per the no-dead-branches rule the
    // unmatched-fill normalizer above spells out.
    id: raw?.expenseId ?? null,
    localDay: String(raw?.localDay ?? '').trim(),
    truckUnit: String(raw?.truckUnit ?? '').trim(),
    vendor: String(raw?.vendor ?? '').trim(),
    driver: String(raw?.driver ?? '').trim(),
    amount: toNum(raw?.amount),
    // Month-end close. Server-told or null — never inferred from the date.
    locked: lockState(raw),
    periodLabel: monthLabel(raw?.localDay),
  };
}

export function volumelessReceipts(fuel) {
  return asList(fuel?.volumelessReceipts).map(normalizeVolumelessReceipt);
}

/**
 * The per-truck rollup — the line that turns 25 scattered rows into "#33 needs
 * attention", which is the actual insight in this queue.
 *
 * The SERVER's summary wins whenever it is present, and that is not deference
 * for its own sake: the row list may be capped (odometerConflicts already is, at
 * 100) while a server-side summary counts everything, so deriving over a
 * truncated list would quietly understate the very total the section leads with.
 * Deriving is the fallback for a payload that sends rows without a summary, and
 * it is exact in that case because the rows are then all there is.
 *
 * Returns null when there is nothing to summarise, so the caller renders no
 * strip at all rather than an empty one.
 */
export function volumelessSummary(fuel) {
  const rows = volumelessReceipts(fuel);
  const raw = fuel?.volumelessSummary;
  const serverTrucks = Array.isArray(raw?.byTruck) ? raw.byTruck : null;

  let byTruck;
  if (serverTrucks) {
    // ORDER PRESERVED. The server sorts biggest-money-first and breaks ties on
    // count then unit specifically so the strip is stable run to run; re-sorting
    // here would silently override a deliberate, documented ordering with a
    // different one (they disagree whenever a truck has many small receipts and
    // another has few large ones).
    byTruck = serverTrucks.map((t) => ({
      truckUnit: String(t?.truckUnit ?? '').trim(),
      count: toNum(t?.count) ?? 0,
      totalAmount: toNum(t?.totalAmount) ?? 0,
    }));
  } else {
    // Derived fallback only. Grouped case-insensitively and sorted to the same
    // rule the server uses, so a payload without a summary still produces the
    // order a payload with one would have had.
    const acc = new Map();
    for (const r of rows) {
      const unit = r.truckUnit || '';
      const key = unit.toLowerCase();
      const cur = acc.get(key) || { truckUnit: unit, count: 0, totalAmount: 0 };
      cur.count += 1;
      cur.totalAmount += r.amount ?? 0;
      acc.set(key, cur);
    }
    byTruck = [...acc.values()].map((g) => ({ ...g, totalAmount: Math.round(g.totalAmount * 100) / 100 }));
    byTruck.sort((a, b) => b.totalAmount - a.totalAmount || b.count - a.count
      || a.truckUnit.localeCompare(b.truckUnit));
  }

  const count = toNum(raw?.count) ?? rows.length;
  const totalAmount = toNum(raw?.totalAmount)
    ?? rows.reduce((s, r) => s + (r.amount ?? 0), 0);

  if (!count && !byTruck.length) return null;
  return { count, totalAmount, byTruck };
}

/**
 * A hand-typed receipt odometer that the truck's own ELD contradicts.
 *
 * NOT a decaying work queue, and the server deliberately does not window it —
 * both real conflicts in this fleet are already older than the 45-day window the
 * other queues use. A missing receipt from three months ago is history; a wrong
 * odometer on a finance row stays wrong until a human edits it. One of these
 * (96,538 typed on a truck reading 970,209) is why fleet cost-per-mile once read
 * half a cent. Do not add a date filter to this queue.
 *
 * `suspect` is always the RECEIPT side. That is not a guess about which number
 * is further from the truth — it is which one a person typed: the ELD figure is
 * machine-read at the moment the tank rose, and the server has already excluded
 * rows it backfilled itself (odometer_source = 'telemetry'). Presenting the pair
 * neutrally would leave the reader to work out which is the candidate for
 * correction, when only one of them ever is.
 */
export function normalizeOdometerConflict(raw) {
  const receiptOdometer = toNum(raw?.receiptOdometer);
  const eldOdometer = toNum(raw?.eldOdometer);
  const bothKnown = receiptOdometer !== null && eldOdometer !== null;
  return {
    // The EXPENSE id, not the fuel-event id — this row's fix is editing the
    // receipt, so it is what opens the detail modal.
    id: raw?.id ?? null,
    // The episode's Houston business day. `receiptDate` is the receipt's own
    // date column and can differ by a day on an adjacent-day match, so both are
    // carried and the table shows the receipt's own date next to the reading it
    // belongs to.
    localDay: String(raw?.localDay ?? '').trim(),
    receiptDate: String(raw?.receiptDate ?? '').trim(),
    unitNumber: String(raw?.unitNumber ?? '').trim(),
    receiptOdometer,
    eldOdometer,
    deltaMi: bothKnown ? Math.abs(receiptOdometer - eldOdometer) : null,
    // Which way the typed figure is wrong. Both real ones read low, and saying
    // so is more useful than a bare magnitude when the delta is six digits.
    direction: bothKnown ? (receiptOdometer < eldOdometer ? 'low' : 'high') : null,
    // Additionally implausible on its face — a tractor does not read 1 mi. Drives
    // the extra "check" chip, reusing the Recent Fuel Fills vocabulary.
    grosslyLow: isSuspectOdometer(raw?.receiptOdometer, 'receipt'),
    // Month-end close. Keyed off the RECEIPT's own date, because the row's fix is
    // an edit to that expense and it is that expense's period that governs
    // whether the edit is allowed — the episode's localDay can sit a day either
    // side on an adjacent-day match, and at a month boundary the two disagree
    // about which period is in question. Server-told; see lockState.
    locked: lockState(raw),
    periodLabel: monthLabel(raw?.receiptDate || raw?.localDay),
  };
}

export function odometerConflicts(fuel) {
  return asList(fuel?.odometerConflicts).map(normalizeOdometerConflict);
}

// ---------------------------------------------------------------------------
// Tank calibration
// ---------------------------------------------------------------------------

/** Gap between implied and configured capacity that is worth a human look. */
export const CALIBRATION_VARIANCE_PCT = 20;
/** Below this many fills the median is reported but called out as thin. */
export const CALIBRATION_MIN_SAMPLES = 3;

/**
 * One truck's configured capacity next to the capacity its own fills imply.
 *
 * status:
 *   'no-data'   — no usable fills yet, nothing to compare
 *   'no-config' — fills imply a size but no capacity is set on the truck
 *                 (the fuel-range estimate is running on the 200 gal default)
 *   'check'     — implied and configured differ by more than the threshold
 *   'ok'        — they agree within the threshold
 *
 * `thin` is orthogonal to status on purpose: a 3-fill sample with a 61% gap is
 * still worth opening, it just gets shown with its sample count so nobody reads
 * it as settled.
 *
 * ⚠️ THE MEDIAN IS THE WRONG NUMBER ON A BIMODAL TRUCK, and both instrumented
 * trucks are bimodal. Twin saddle tanks with a sender on only one of them
 * produce two populations of samples: a fill that tops up just the sensed tank,
 * and a fill that tops up both — the second puts in about double the gallons for
 * the same needle movement (#2372 ~70 / ~135, #33 ~117 / ~230). The overall
 * median of #33 is 143.5, which is neither, and comparing THAT to the configured
 * 300 gives a 52% gap that describes no real tank.
 *
 * So when the server flags `bimodal`, the headline figure is `lowerMode.median`
 * — the gallons behind one full sweep of the sensor, which is the number that
 * actually converts a fuel percentage into gallons and therefore the one the
 * range estimate depends on. `impliedBasis` records which population was used so
 * the cell can say so out loud; picking a mode silently would be exactly the
 * unlabelled guess the rest of this file exists to prevent.
 */
export function normalizeCalibration(raw) {
  const implied = raw?.impliedGallonsPer100Pct || {};
  const median = toNum(implied.median);
  const p25 = toNum(implied.p25);
  const p75 = toNum(implied.p75);
  const min = toNum(implied.min);
  const max = toNum(implied.max);

  const rawLower = raw?.lowerMode || null;
  const lowerMode = rawLower ? {
    median: toNum(rawLower.median),
    min: toNum(rawLower.min),
    max: toNum(rawLower.max),
    sampleCount: toNum(rawLower.sampleCount) ?? 0,
  } : null;
  const bimodal = Boolean(raw?.bimodal);

  // The figure a human should read, and where it came from.
  const useLower = bimodal && lowerMode !== null && lowerMode.median !== null && lowerMode.median > 0;
  const impliedGallons = useLower ? lowerMode.median : median;
  const impliedBasis = useLower ? 'lower-mode' : 'median';
  // Range shown beside it, drawn from the SAME population as the headline: the
  // lower mode's own spread when that is the basis, else the interquartile
  // range. p25–p75 rather than min–max because a single outlier fill should not
  // make a well-behaved truck look uncertain.
  const rangeLow = useLower ? lowerMode.min : p25;
  const rangeHigh = useLower ? lowerMode.max : p75;

  const configuredRaw = toNum(raw?.configuredGallons);
  const configured = configuredRaw !== null && configuredRaw > 0 ? configuredRaw : null;
  const sampleCount = toNum(raw?.sampleCount) ?? 0;

  let status = 'ok';
  let deltaPct = null;
  if (impliedGallons === null || impliedGallons <= 0 || sampleCount <= 0) {
    status = 'no-data';
  } else if (configured === null) {
    status = 'no-config';
  } else {
    deltaPct = Math.round(((impliedGallons - configured) / configured) * 100);
    status = Math.abs(deltaPct) >= CALIBRATION_VARIANCE_PCT ? 'check' : 'ok';
  }

  return {
    vehicleId: String(raw?.vehicleId ?? '').trim(),
    unitNumber: String(raw?.unitNumber ?? '').trim() || '—',
    configured,
    implied: impliedGallons,
    impliedBasis,
    rangeLow,
    rangeHigh,
    bimodal,
    lowerMode,
    // Kept for the "all fills" figure the bimodal explanation quotes, so the
    // reader can see the number they'd have got from a naive median.
    median,
    min,
    max,
    sampleCount,
    deltaPct,
    status,
    thin: sampleCount > 0 && sampleCount < CALIBRATION_MIN_SAMPLES,
    // Receipt-derived MPG rides along on this payload: same matched fills, and
    // it is the figure the whole reconciliation exists to make possible.
    receiptMpg: toNum(raw?.receiptMpg),
    mpgLegCount: toNum(raw?.mpgLegCount) ?? 0,
  };
}

/** True when any row needs the twin-tank explanation shown. */
export function anyBimodal(rows) {
  return Array.isArray(rows) && rows.some(r => r?.bimodal);
}

export function tankCalibration(fuel) {
  return asList(fuel?.tankCalibration).map(normalizeCalibration);
}

/** Rows a human should actually look at — drives the amber count badge. */
export function countCalibrationChecks(rows) {
  if (!Array.isArray(rows)) return 0;
  let n = 0;
  for (const r of rows) if (r?.status === 'check' || r?.status === 'no-config') n++;
  return n;
}

// ---------------------------------------------------------------------------
// MPG provenance (GET /api/fuel/range → mpgSource)
// ---------------------------------------------------------------------------

/**
 * How a truck's MPG was arrived at, ranked BEST FIRST.
 *
 * The ordering is the point, and it is not the obvious one. Both the admin Fuel
 * Finder and the driver panel used to treat this as a boolean — "from your ELD"
 * or "fleet default" — so 'receipts' arriving would have been binned with the
 * default and labelled a guess. It is the opposite: receipt-derived MPG divides
 * ELD odometer miles by PUMP gallons off the receipt, so no fuel-percentage
 * reading and no tank-size assumption is in the path at all. The fuel_pct route
 * inherits both, which is how the fleet ended up showing 1.36 and 1.66 mpg for
 * trucks actually running 6.18 and 4.76.
 *
 * rank: 2 measured without assumptions · 1 measured through the tank sensor
 *       · 0 not measured at all.
 *
 * An unrecognised or missing value returns null, and callers show NO badge and
 * NO note — the same convention DriverFuelPanel already uses for `tankSource`.
 * Asserting "fleet default" over a value we don't understand would be a guess
 * about a guess.
 */
const MPG_SOURCES = {
  receipts: {
    key: 'receipts', rank: 2,
    short: 'receipts',
    driver: 'from your fuel receipts',
    title: "Measured from real pump gallons on your receipts against ELD odometer miles — the most accurate basis available, with no tank-sensor reading or tank-size assumption involved.",
  },
  eld: {
    key: 'eld', rank: 1,
    short: 'ELD',
    driver: 'from your ELD',
    title: "Derived from the ELD's fuel-level readings and the recorded tank size.",
  },
  default: {
    key: 'default', rank: 0,
    short: 'est',
    driver: 'fleet default',
    title: 'Not measured for this truck yet — a fleet-wide default is standing in.',
  },
};

export function mpgSource(value) {
  return MPG_SOURCES[value] || null;
}

// ---------------------------------------------------------------------------
// Range interval + trip verdict (GET /api/fuel/range, GET /api/fuel/trip-plan)
// ---------------------------------------------------------------------------

/**
 * How a range figure was arrived at. Ranked BEST FIRST, deliberately the same
 * shape and ordering convention as MPG_SOURCES above so a surface that already
 * badges `mpgSource` needs no second concept for `rangeBasis`.
 *
 * rank: 2 this truck's own measured fill history · 1 a derated fleet estimate
 *       · 0 no live fuel reading at all.
 *
 * WHY 'estimated' IS NOT A DASH AND NOT A GUESS. On an estimated basis the
 * server sends `typical` and `high` as null ON PURPOSE: with no measured legs
 * there is no spread to report, and inventing one is precisely how a driver came
 * to be shown "449 mi" of range on a truck that had about 210. So a caller must
 * render the absence as a sentence — "we can't tell you that yet" — and must
 * never substitute `rangeMiles` (the raw tank x mpg point estimate) to fill the
 * hole. rangeReadout() below enforces that; it has no fallback path.
 */
const RANGE_BASES = {
  measured: {
    key: 'measured', rank: 2,
    short: 'measured',
    driver: "from your truck's own fill-ups",
    title:
      "Measured end-to-end from this truck's own refuels: ELD odometer miles against gauge points used. It needs neither the configured tank size nor an MPG figure, so it inherits the error in neither.",
  },
  estimated: {
    key: 'estimated', rank: 1,
    short: 'estimated',
    driver: 'fleet estimate',
    title:
      "This truck has no usable fill history yet, so the range is the tank-size x MPG estimate cut down by the overstatement that formula was measured to carry across the fleet. It is a floor, not a forecast.",
  },
  unknown: {
    key: 'unknown', rank: 0,
    short: 'no reading',
    driver: 'no fuel reading',
    title: 'No live fuel level is coming from this truck, so no range can be worked out.',
  },
};

export function rangeBasis(value) {
  return RANGE_BASES[value] || null;
}

/**
 * The verdict on whether a load's remaining route fits in the tank.
 *
 * `tone` drives colour and nothing else decides it — in particular a caller must
 * never re-derive "can they make it" by comparing numbers itself. The server
 * judges `clears` on the LOW end of the interval and derates an estimated basis
 * first, so a 348-mile point estimate against a 346.9-mile route correctly comes
 * back `insufficient`. Any client-side re-comparison would quietly undo that.
 */
const TRIP_VERDICTS = {
  clears: {
    key: 'clears', tone: 'ok',
    driver: 'You can make this run',
    dispatch: 'Route clears',
    chip: 'clears',
    title: 'The low end of the range covers the remaining route plus a reserve.',
  },
  tight: {
    key: 'tight', tone: 'warn',
    driver: 'Too close to count on — plan a stop',
    dispatch: 'Tight — plan a stop',
    chip: 'fuel tight',
    title:
      'A typical run would reach, but the low end does not. Close enough that one heavy load or one headwind decides it, so it must not be relied on.',
  },
  insufficient: {
    key: 'insufficient', tone: 'bad',
    driver: 'Not enough fuel — you need to stop',
    dispatch: 'Will not reach — fuel stop required',
    chip: 'stop needed',
    title: 'Even a typical run does not reach the destination on what is in the tank.',
  },
  unknown: {
    key: 'unknown', tone: 'unknown',
    driver: "Can't tell you yet",
    dispatch: 'No verdict',
    chip: 'no verdict',
    title: 'Without a live fuel reading or a route distance there is nothing to judge.',
  },
};

export function tripVerdict(value) {
  return TRIP_VERDICTS[value] || null;
}

/**
 * Normalize the interval half of either fuel payload into ONE shape.
 *
 * Two endpoints carry the same interval in two layouts — `/api/fuel/range`
 * flattens it (`rangeLowMiles`…) while `/api/fuel/trip-plan` nests it under
 * `range` — and both feed the same components. Normalizing here is what keeps
 * the "never fall back to the point estimate" rule in a single place instead of
 * once per surface.
 *
 * `known` is the gate for rendering any figure at all; `hasSpread` is the gate
 * for rendering the typical/best-case pair. They are separate because the
 * estimated basis is `known: true, hasSpread: false` — there IS a number to
 * plan against, there is just no distribution around it.
 */
function normalizeRange(src) {
  const basisKey = src && typeof src.basis === 'string' ? src.basis : 'unknown';
  const info = rangeBasis(basisKey);
  const planning = toNum(src && src.planning);
  const typical = toNum(src && src.typical);
  const high = toNum(src && src.high);
  return {
    basis: info ? info.key : '',
    basisInfo: info,
    planning,
    typical,
    high,
    low: toNum(src && src.low),
    milesPerPoint: toNum(src && src.milesPerPoint),
    known: planning !== null,
    // Only a measured basis carries a distribution. Guard on the values rather
    // than on the basis string so an unrecognised future basis that DOES send a
    // spread still renders it, and one that doesn't stays quiet.
    hasSpread: typical !== null && high !== null,
  };
}

/** Interval from a GET /api/fuel/range payload. */
export function rangeReadout(d) {
  return normalizeRange({
    basis: d && d.rangeBasis,
    planning: d && d.rangePlanningMiles,
    typical: d && d.rangeTypicalMiles,
    high: d && d.rangeHighMiles,
    low: d && d.rangeLowMiles,
    milesPerPoint: d && d.milesPerFuelPoint,
  });
}

/** Interval from a GET /api/fuel/trip-plan payload (already nested). */
export function planRangeReadout(p) {
  return normalizeRange(p && p.range);
}

/**
 * Why a 'measured' basis deserves to be trusted, in the truck's own terms.
 * Returns '' when the server sent no evidence — which is itself the reason the
 * basis is not 'measured', so there is nothing to explain.
 */
export function rangeEvidenceText(ev) {
  const legs = toNum(ev && ev.legs);
  const miles = toNum(ev && ev.miles);
  if (legs === null || legs <= 0) return '';
  const fills = `${Math.round(legs)} fill-up${Math.round(legs) === 1 ? '' : 's'}`;
  if (miles === null || miles <= 0) return fills;
  return `${fills} · ${Math.round(miles).toLocaleString('en-US')} mi`;
}

/** "1,204" — miles for display. null/blank yields '' so callers can v-if it. */
export function milesText(v) {
  const n = toNum(v);
  return n === null ? '' : Math.round(n).toLocaleString('en-US');
}

/** Plain-language verdict for the status cell. Neutral by design. */
export function calibrationVerdict(row) {
  if (!row) return '';
  if (row.status === 'no-data') return 'Not enough fills yet';
  if (row.status === 'no-config') return 'No capacity set — range uses the 200 gal default';
  if (row.status === 'ok') return 'Within ' + CALIBRATION_VARIANCE_PCT + '% of configured';
  const d = row.deltaPct;
  if (d === null) return '';
  return d < 0
    ? `${Math.abs(d)}% below configured`
    : `${d}% above configured`;
}
