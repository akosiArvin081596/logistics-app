// Pure decision logic for recovering GALLONS onto fuel receipts that carry a
// dollar amount and no volume. No network, no DB, no filesystem — server.js owns
// the candidate query, the period lock, the Gemini call, the UPDATE and the
// audit line; this file owns the one question "may we believe this reading?".
//
// WHY THIS EXISTS. 29 production fuel receipts hold $6,131.54 of diesel with a
// price and no gallons, 28 of them on LogisX-#33. Gallons are the denominator of
// every honest fuel number, so their absence is not cosmetic: it is why #33's
// tank-to-tank MPG rests on 24 of its 105 detected fills, and why cost-per-mile
// can only ever be quoted as a floor. Most of these were typed in by hand and
// never OCR'd at all — the volume is printed on the paper we already stored.
//
// THE DESIGN RULE IS PROPOSE, NOT WRITE. This is a finance row feeding investor
// settlements, so the standing discipline applies: leave it unmatched rather
// than wrong. Everything below is built to produce a REFUSAL with a stated
// reason in preference to a plausible guess.
//
// ── THE CORROBORATION, AND WHY IT IS FREE ─────────────────────────────────────
// The receipt already carries a fact we independently know: its total. So the
// model is not asked "what are the gallons" and believed; it is asked to read
// the whole receipt, and its GALLONS are trusted only when its TOTAL reproduces
// the amount already on the row. A model reading the wrong document, or
// hallucinating a fuel receipt out of a toll slip, cannot also land the stored
// total to the cent. Measured on all 24 unlocked production candidates the
// amount matched EXACTLY — $0.00 delta, 24 of 24 — so this gate costs nothing on
// good reads while being the single thing standing between an OCR artifact and
// a settlement figure.
//
// ── AND WHY THE AMOUNT ALONE IS NOT ENOUGH ────────────────────────────────────
// Expense #149 ($90.00, QuikTrip #4049) returned a perfectly matching total and
// `gallons: 10`, i.e. $9.00/gal — roughly double any diesel price in the period.
// The amount gate passed it. Only the second, independent check catches it: the
// implied cost per gallon must be plausible, and "plausible" is derived from the
// fleet's OWN priced receipts rather than a hardcoded band, so it tracks the
// market and this carrier's actual buying without anyone maintaining a constant.
// That is the same self-calibration trick legBurnedGallons uses on `rise`: let
// the data supply its own scale.
//
// Two gates, two failure modes: the amount catches "read the wrong paper", the
// price catches "read the right paper, wrong line".
//
// ── WHAT IS DELIBERATELY *NOT* A GATE ─────────────────────────────────────────
// The receipt DATE. It agreed on 22 of 24, and both disagreements were on
// receipts whose totals matched to the cent (#150 read 2023-07-17 against a
// stored 2026-07-27 — a faint print, not a different document; #172's row is
// dated 2017-07-15, a typo the receipt itself contradicts). Gating on it would
// refuse two genuine recoveries to catch nothing, so the date is REPORTED as
// evidence for the human and never decides. Likewise the model's self-reported
// `confidence`: the amount match is strictly harder evidence than the model's
// own opinion of itself, and stacking a soft signal on top of a hard one only
// adds false refusals.

// Cost-per-gallon plausibility, derived from the fleet's own priced receipts.
// Percentiles (not min/max) because the sample contains two obvious keying
// errors — a $600.00/1 gal and a $37.00/102.91 gal row — and a band anchored on
// extremes would be defined by exactly the data this check exists to catch.
const CPG_PCT_LO = 0.05;
const CPG_PCT_HI = 0.95;
// Padding outside the observed 5th/95th. The band must admit a real fill at a
// price this fleet simply has not paid yet (a cheap bulk stop, a spike) while
// still refusing an order-of-magnitude miss. Measured on production (97 priced
// receipts, the same filter the endpoint uses) p05/p95 are $3.80/$5.02, giving a
// band of $2.85-$6.78 — so the $9.00 artifact above falls outside with room to
// spare, and the lowest genuine fill in the set ($3.60/gal, QuikTrip #07010)
// clears the floor by 26%.
const CPG_PAD_LO = 0.75;
const CPG_PAD_HI = 1.35;
// Hard stops the data-driven band may never travel outside. A dataset poisoned
// with enough bad rows could otherwise widen its own acceptance until it
// admitted the errors that widened it.
const CPG_ABS_MIN = 1.5;
const CPG_ABS_MAX = 8.0;
// Below this many priced receipts the percentiles are an anecdote, so a fixed
// band is used instead. Wide enough to cover every US retail diesel price in the
// period, narrow enough to still reject a decimal-point slip.
const CPG_MIN_SAMPLES = 20;
const CPG_FALLBACK_LO = 2.5;
const CPG_FALLBACK_HI = 7.0;

// How far the OCR'd total may sit from the stored amount. Observed delta on
// every real candidate is $0.00, so this is slack rather than a crutch: it
// exists only so a cent of rounding on a large ticket cannot refuse an otherwise
// perfect read. Kept proportional AND floored, because $0.02 is meaningless on
// $500 and 0.1% is meaningless on $30.
const AMOUNT_TOL_ABS = 0.02;
const AMOUNT_TOL_FRAC = 0.001;

// Below a gallon is a misread, not a purchase. Deliberately NOT aligned to
// FUEL_MATCH_MIN_GALLONS (5), the fuel-event matcher's eligibility floor, even
// though they look like the same idea: that threshold exists to stop a small
// receipt pairing with a sensor wobble, and it does its own job on its own side.
// Raising this to 5 to "agree" with it would refuse to record a genuine 3-gallon
// top-up — a true fact about the fleet's spend, useful to cost-per-gallon —
// purely because a different subsystem would decline to match it. A recovered
// volume under 5 simply never becomes a leg, which is correct and needs no help
// from here. (DEF is excluded upstream by isDefReceipt, not by this bound.)
const MIN_RECOVERABLE_GALLONS = 1;
// No single fill on this fleet exceeds ~203 gallons (the largest observed, twice,
// on #33). Anything past 400 is a misplaced decimal, not a truck.
const MAX_RECOVERABLE_GALLONS = 400;

const num = (v) => {
	const n = typeof v === "number" ? v : parseFloat(v);
	return Number.isFinite(n) ? n : null;
};
const round2 = (n) => Math.round(n * 100) / 100;

function percentile(sortedAsc, p) {
	if (!sortedAsc.length) return null;
	const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * (sortedAsc.length - 1))));
	return sortedAsc[i];
}

// cpgBand(samples) -> { min, max, n, source }
// samples = [{ amount, gallons }] — every fuel receipt that ALREADY carries a
// volume. `source` says whether the band came from this fleet or the fallback,
// because a band nobody can trace is a band nobody can argue with.
function cpgBand(samples) {
	const vals = (Array.isArray(samples) ? samples : [])
		.map((s) => {
			const a = num(s && s.amount);
			const g = num(s && s.gallons);
			return a != null && g != null && a > 0 && g > 0 ? a / g : null;
		})
		.filter((v) => v != null && Number.isFinite(v) && v > 0)
		.sort((a, b) => a - b);

	if (vals.length < CPG_MIN_SAMPLES) {
		return { min: CPG_FALLBACK_LO, max: CPG_FALLBACK_HI, n: vals.length, source: "fallback" };
	}
	const lo = percentile(vals, CPG_PCT_LO) * CPG_PAD_LO;
	const hi = percentile(vals, CPG_PCT_HI) * CPG_PAD_HI;
	const min = round2(Math.max(CPG_ABS_MIN, lo));
	const max = round2(Math.min(CPG_ABS_MAX, hi));
	// The two clamps are independent, so a degenerate sample (every receipt priced
	// under ~$1.11/gal, i.e. p95 x 1.35 < the $1.50 floor) can invert the band. It
	// already fails safe — an inverted band accepts nothing — but SILENTLY, and a
	// band that rejects every receipt for an unstated reason is exactly the kind of
	// quiet nothing-happened this feature exists to stop. Fall back to the fixed
	// band and say the sample was unusable.
	if (min > max) return { min: CPG_FALLBACK_LO, max: CPG_FALLBACK_HI, n: vals.length, source: "fallback_degenerate" };
	return { min, max, n: vals.length, source: "fleet" };
}

function amountTolerance(stored) {
	const a = num(stored) || 0;
	return Math.max(AMOUNT_TOL_ABS, Math.abs(a) * AMOUNT_TOL_FRAC);
}

// judgeGallonsRecovery({ storedAmount, storedDate, ocr, band, locked, lockUnreadable })
//   -> { verdict, gallons, cpg, amountDelta, dateMatches, reason }
//
// The ladder is ORDERED and the order is the point. `locked` is first so a
// closed month is refused before a Gemini call is ever made — a guard that
// spends money before refusing is a guard with a bill attached. Everything after
// it moves from "we could not read it" to "we read it and disbelieve it", so the
// verdict always names the cheapest true reason rather than the last one checked.
//
// `gallons` is non-null ONLY on 'recovered'. Every other verdict returns null so
// a caller cannot accidentally write a value that failed a gate.
function judgeGallonsRecovery({ storedAmount, storedDate, ocr, band, locked, lockUnreadable, photoError } = {}) {
	const amount = num(storedAmount);
	const out = (verdict, reason, extra = {}) => ({
		verdict, gallons: null, cpg: null, amountDelta: null, dateMatches: null, reason, ...extra,
	});

	if (lockUnreadable) {
		return out("locked_period",
			"The period lock table could not be read, so this receipt's month cannot be confirmed open. Recovery is held until that is fixed.");
	}
	if (locked) {
		return out("locked_period",
			"This receipt is booked to a finalized month. Reopen the period, or record the correction as a payout adjustment.");
	}
	if (photoError) return out("no_photo", photoError);
	if (!ocr) return out("ocr_failed", "The receipt could not be read.");
	if (amount == null || !(amount > 0)) {
		return out("no_stored_amount", "The row has no positive amount to corroborate a reading against.");
	}

	const ocrAmount = num(ocr.amount);
	if (ocrAmount == null || !(ocrAmount > 0)) {
		return out("amount_unreadable",
			"No total could be read off the receipt, so there is nothing to corroborate the gallons against.");
	}
	const delta = round2(ocrAmount - amount);
	const dateMatches = ocr.date && storedDate ? String(ocr.date).slice(0, 10) === String(storedDate).slice(0, 10) : null;
	if (Math.abs(ocrAmount - amount) > amountTolerance(amount)) {
		return out("amount_mismatch",
			`The receipt reads $${ocrAmount.toFixed(2)} but the row says $${amount.toFixed(2)}. The reading is not of this row's receipt, so its gallons cannot be trusted.`,
			{ amountDelta: delta, dateMatches });
	}

	const g = num(ocr.gallons);
	if (g == null || !(g > 0)) {
		return out("no_gallons_on_receipt",
			"The receipt was read correctly (its total matches) but prints no volume. This one has to be keyed by a human.",
			{ amountDelta: delta, dateMatches });
	}
	if (g < MIN_RECOVERABLE_GALLONS || g > MAX_RECOVERABLE_GALLONS) {
		return out("implausible_gallons",
			`${g} gallons is outside anything this fleet pumps (${MIN_RECOVERABLE_GALLONS}-${MAX_RECOVERABLE_GALLONS}).`,
			{ amountDelta: delta, dateMatches });
	}

	const cpg = round2(amount / g);
	const lo = num(band && band.min), hi = num(band && band.max);
	if (lo == null || hi == null) {
		return out("no_price_band", "No cost-per-gallon band was available to sanity-check the reading against.",
			{ amountDelta: delta, dateMatches });
	}
	if (cpg < lo || cpg > hi) {
		return out("implausible_cpg",
			`$${amount.toFixed(2)} over ${g} gal implies $${cpg.toFixed(2)}/gal, outside this fleet's $${lo.toFixed(2)}-$${hi.toFixed(2)}. The total is right, so the volume is the misread line.`,
			{ cpg, amountDelta: delta, dateMatches });
	}

	return {
		verdict: "recovered",
		gallons: round2(g),
		cpg,
		amountDelta: delta,
		dateMatches,
		reason: `Total matches to the cent ($${amount.toFixed(2)}) and $${cpg.toFixed(2)}/gal is inside this fleet's normal range.`,
	};
}

// Roll a list of judged rows into the counts a report leads with. Every verdict
// that occurred is named — a summary that only reports successes is the silent
// partial success this whole feature exists to avoid.
function summarizeRecovery(results) {
	const rows = Array.isArray(results) ? results : [];
	const byVerdict = {};
	let recoveredGallons = 0, recoveredAmount = 0, notRecoveredAmount = 0;
	for (const r of rows) {
		byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
		const amt = num(r.amount) || 0;
		if (r.verdict === "recovered") {
			recoveredGallons += num(r.gallons) || 0;
			recoveredAmount += amt;
		} else {
			notRecoveredAmount += amt;
		}
	}
	const recovered = byVerdict.recovered || 0;
	// A row is ATTEMPTED only if a reading was actually taken. Three verdicts are
	// decided without one and must not count against the reader's accuracy:
	// 'locked_period' and 'no_photo' are refused before any call is made, and
	// 'not_attempted' is a row the batch deadline never reached. Folding those in
	// would let a hit rate move because a month closed or a batch ran long, which
	// hides a change in either number behind the other.
	const NOT_READ = new Set(["locked_period", "no_photo", "not_attempted"]);
	return {
		candidates: rows.length,
		recovered,
		// "Not recovered", which is broader than "refused" — it also covers the rows
		// above that were never read. byVerdict is what says which.
		notRecovered: rows.length - recovered,
		attempted: rows.filter((r) => !NOT_READ.has(r.verdict)).length,
		recoveredGallons: round2(recoveredGallons),
		recoveredAmount: round2(recoveredAmount),
		notRecoveredAmount: round2(notRecoveredAmount),
		byVerdict,
	};
}

module.exports = {
	cpgBand,
	judgeGallonsRecovery,
	summarizeRecovery,
	amountTolerance,
	CPG_MIN_SAMPLES,
	CPG_FALLBACK_LO,
	CPG_FALLBACK_HI,
	CPG_ABS_MIN,
	CPG_ABS_MAX,
	MIN_RECOVERABLE_GALLONS,
	MAX_RECOVERABLE_GALLONS,
};
