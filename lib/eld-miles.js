// ELD odometer → miles driven. Pure math: no network, no database, no fs.
//
// WHY THIS EXISTS, AND WHY IT IS NOT `MAX(odometer) - MIN(odometer)`.
// The existing daily rollup (rollupOneDay in server.js) took the span, on the
// stated assumption that "odometer is monotonically increasing per vehicle".
// It is not. On 2026-08-11 LogisX-#2372's ELD was swapped or reset and its
// odometer dropped 219,818 miles in 0.17 h. `MAX - MIN` billed that reset as
// DISTANCE: the row is still in production reading 219,818 miles for one day,
// which alone inflates that truck's all-time total from ~24,744 to 244,562 —
// a figure the investor MyTrucks panel and Fleet Health both show today.
//
// Summing POSITIVE CONSECUTIVE DELTAS instead yields 3,369 miles for the same
// 30-day window. Measured across the whole fleet, delta-sum and span agree
// exactly wherever the sensor behaved (#33 5,873 = 5,873; #91 2,803 = 2,803),
// and diverge only where it did not. So this is strictly better information,
// not a different opinion.
//
// THE GUARDS ARE PER-DELTA AND THERE IS DELIBERATELY NO PER-DAY CAP. A real
// 1,247-mile day exists in this data — ~700 one-minute deltas averaging 1.78 mi,
// every one of them ordinary. A day cap loose enough not to clip that day would
// be useless against a 219,818 outlier, which guard 2 below catches for free.
//
// NOTHING IS EVER CARRIED. A rejected delta is dropped and the walk resumes
// from the next sample. Carrying it forward — "apply it to the following
// bucket" — would re-inject the same ±219,818 one row later and turn a visible
// outlier into an invisible one. The magnitude is recorded in `droppedMiles`
// instead, so the loss is countable rather than silent, and it is what flips a
// day's basis from 'eld' to 'partial'.

// Below any credible corruption in this fleet and above any credible single
// step. At ~1 ping/min a real delta is 0.1–1.2 mi; the observed corruption is
// six figures. Deltas at or under this are accepted UNCONDITIONALLY, which is
// what stops the rate guard below from eating a legitimate step whose timestamp
// jittered (a real 1.75-mi delta recorded over 30 s computes as 210 mph).
const ELD_DELTA_FLOOR_MI = 5;

// Longer than any feed hiccup, far shorter than any real outage here. The feed
// is ~1/min; a poller restart is minutes. The genuine dark periods in this
// fleet are DAYS (#2372 went dark 15 days; 18000505841 has been silent since
// 2026-07-27). 6 h sits with wide margin between the two.
const ELD_MAX_GAP_MS = 6 * 60 * 60 * 1000;

// Class-8 trucks do not sustain this. Only ever adjudicates deltas above the
// floor, so it cannot reject ordinary driving.
const ELD_MAX_MPH = 90;

/**
 * Judge one consecutive pair.
 *
 * Order matters and is not arbitrary — see each guard. Returns
 * `{ ok, miles, reason, movedWhileDark }`; `miles` is 0 on a rejection and the
 * rejected magnitude is returned separately as `rejectedMiles` so the caller
 * can account for it without re-deriving the subtraction.
 */
function acceptOdoDelta(prevOdo, currOdo, prevMs, currMs) {
	const dtMs = currMs - prevMs;
	const d = currOdo - prevOdo;

	// 1. Time did not advance. Unreachable once samples are deduped by
	//    timestamp, but asserted rather than assumed: it is what would divide
	//    by zero in guard 5.
	if (!(dtMs > 0)) {
		return { ok: false, miles: 0, rejectedMiles: Math.abs(d) || 0, reason: "nonmonotonic_time", movedWhileDark: false };
	}

	// 2. A ZERO delta is a PARKED TRUCK, not an anomaly. It must be ACCEPTED as
	//    zero miles, never counted as a rejection — a stationary truck emits
	//    hundreds of them an hour, and treating them as rejections would flag
	//    every parked day 'partial' and drain that label of meaning.
	if (d === 0) {
		return { ok: true, miles: 0, reason: "", movedWhileDark: false };
	}

	// 3. THE #2372 FIX. A NEGATIVE delta on a monotonic sensor has exactly one
	//    physical meaning — the device was swapped or reset — and the miles it
	//    "represents" were never driven. Dropping it lets the very next delta
	//    start from the new device's baseline, which is precisely why delta-sum
	//    recovers 3,369 where the span reports -216,449.
	if (d < 0) {
		return { ok: false, miles: 0, rejectedMiles: Math.abs(d), reason: "reset", movedWhileDark: false };
	}

	// 4. Small enough that no guard below could learn anything. MUST precede
	//    guards 5 and 6 — see ELD_DELTA_FLOOR_MI. This is also what keeps an
	//    overnight rest (a long gap across which the truck did not move) from
	//    flagging the day partial.
	if (d <= ELD_DELTA_FLOOR_MI) {
		return { ok: true, miles: d, reason: "", movedWhileDark: false };
	}

	// 5. We were dark and the truck moved more than the floor while we were.
	//    Those miles are real, but they belong to no day and no driver we can
	//    name — the pings that would have placed them do not exist. Counting
	//    them would dump a dark truck's whole return onto whatever day it
	//    reappeared. Dropping them is the honest answer, and it is what makes
	//    the day 'partial' rather than silently wrong.
	//    NOTE this is reached only when d > floor, so a parked overnight gap
	//    has already been accepted at guard 4 and never lands here.
	if (dtMs > ELD_MAX_GAP_MS) {
		return { ok: false, miles: 0, rejectedMiles: d, reason: "gap", movedWhileDark: true };
	}

	// 6. Physically impossible within a short window — a re-based device that
	//    happened to land HIGHER, which guard 3 cannot see.
	const mph = d / (dtMs / 3600000);
	if (mph > ELD_MAX_MPH) {
		return { ok: false, miles: 0, rejectedMiles: d, reason: "rate", movedWhileDark: true };
	}

	return { ok: true, miles: d, reason: "", movedWhileDark: false };
}

/**
 * Collapse duplicate timestamps, keeping the largest odometer at each instant.
 *
 * Duplicate `location_date_ms` rows demonstrably exist in this table —
 * fuelEventSeries() in server.js already carries a `GROUP BY location_date_ms`
 * for exactly this reason — and a duplicate is what would make guard 1 fire.
 * Done here so every caller gets it, rather than depending on each SQL site
 * remembering.
 */
function dedupeSamples(samples) {
	const byMs = new Map();
	for (const s of samples || []) {
		const ms = Number(s && s.ms);
		const odo = Number(s && s.odo);
		if (!Number.isFinite(ms) || !Number.isFinite(odo) || odo <= 0) continue;
		const prev = byMs.get(ms);
		if (prev === undefined || odo > prev.odo) byMs.set(ms, { ms, odo, lng: s.lng });
		}
	return [...byMs.values()].sort((a, b) => a.ms - b.ms);
}

/**
 * Sum one vehicle's miles over an ordered sample list.
 *
 * `maxGapMs` counts ONLY gaps the truck moved across (`movedWhileDark`). A
 * fleet whose ELDs report on ignition produces a 10-hour gap every night; if
 * those counted, every day would read 'partial' and the label would stop
 * meaning anything.
 */
function sumOdoDeltas(samples) {
	const rows = dedupeSamples(samples);
	const out = { miles: 0, droppedMiles: 0, rejected: 0, maxGapMs: 0, samples: rows.length, reasons: {} };
	for (let i = 1; i < rows.length; i++) {
		const v = acceptOdoDelta(rows[i - 1].odo, rows[i].odo, rows[i - 1].ms, rows[i].ms);
		if (v.ok) {
			out.miles += v.miles;
			continue;
		}
		out.rejected += 1;
		out.droppedMiles += v.rejectedMiles || 0;
		out.reasons[v.reason] = (out.reasons[v.reason] || 0) + 1;
		if (v.movedWhileDark) {
			const dt = rows[i].ms - rows[i - 1].ms;
			if (dt > out.maxGapMs) out.maxGapMs = dt;
		}
	}
	out.miles = Math.round(out.miles * 10) / 10;
	out.droppedMiles = Math.round(out.droppedMiles * 10) / 10;
	return out;
}

/**
 * Split one vehicle's miles into (day, driver) buckets.
 *
 * `dayOf(ms, lng)` and `driverAt(ms)` are INJECTED so this module stays pure —
 * server.js passes the truck-local day bucketer and the assignment resolver.
 *
 * A delta spans two pings and is attributed to the LATER one. At ~1 ping/min
 * that moves at most ~1.2 mi across a day or driver boundary, which is below
 * the resolution of anything built on this. Splitting it proportionally would
 * imply a precision the sample rate does not support.
 */
function splitDeltasByDayAndDriver(samples, opts) {
	const dayOf = (opts && opts.dayOf) || (() => "");
	const driverAt = (opts && opts.driverAt) || (() => "");
	const rows = dedupeSamples(samples);
	const buckets = new Map();

	const bucketFor = (day, driverName) => {
		const driverKey = String(driverName || "").trim().toLowerCase();
		const key = `${day}|${driverKey}`;
		let b = buckets.get(key);
		if (!b) {
			b = {
				localDay: day, driverKey, driverName: driverName || "",
				miles: 0, droppedMiles: 0, rejected: 0, maxGapMs: 0, samples: 0,
				firstMs: rows.length ? rows[0].ms : 0, lastMs: 0, reasons: {},
			};
			buckets.set(key, b);
		}
		return b;
	};

	// Every sample counts toward its own bucket's sample tally, so a day with
	// pings but no movement is distinguishable from a day with no pings at all
	// (which produces no row, and is reported as 'no-data' at read time).
	for (const r of rows) {
		const b = bucketFor(dayOf(r.ms, r.lng), driverAt(r.ms));
		b.samples += 1;
		if (!b.firstMs || r.ms < b.firstMs) b.firstMs = r.ms;
		if (r.ms > b.lastMs) b.lastMs = r.ms;
	}

	for (let i = 1; i < rows.length; i++) {
		const cur = rows[i];
		const v = acceptOdoDelta(rows[i - 1].odo, cur.odo, rows[i - 1].ms, cur.ms);
		const b = bucketFor(dayOf(cur.ms, cur.lng), driverAt(cur.ms));
		if (v.ok) {
			b.miles += v.miles;
			continue;
		}
		b.rejected += 1;
		b.droppedMiles += v.rejectedMiles || 0;
		b.reasons[v.reason] = (b.reasons[v.reason] || 0) + 1;
		if (v.movedWhileDark) {
			const dt = cur.ms - rows[i - 1].ms;
			if (dt > b.maxGapMs) b.maxGapMs = dt;
		}
	}

	for (const b of buckets.values()) {
		b.miles = Math.round(b.miles * 10) / 10;
		b.droppedMiles = Math.round(b.droppedMiles * 10) / 10;
		b.basis = dayBasis(b);
	}
	return buckets;
}

/**
 * One day's basis. 'eld' only when nothing was thrown away — anything else
 * overstates how much of that day we actually saw.
 */
function dayBasis(agg) {
	if (!agg || !agg.samples) return "no-data";
	return agg.rejected === 0 && agg.maxGapMs === 0 ? "eld" : "partial";
}

/**
 * Roll many day-baskets up into one label for a week / month / total.
 *
 * Same shape as daySrcLabel() in server.js: a reduce over per-day flags, never
 * a fresh judgement. Any partial day makes the period partial — a period is
 * only 'eld' if we saw all of it.
 */
function basisLabel(bases) {
	const list = (bases || []).filter(Boolean);
	if (!list.length) return "no-data";
	if (list.every((b) => b === "no-data")) return "no-data";
	return list.every((b) => b === "eld") ? "eld" : "partial";
}

// ---------------------------------------------------------------------------
// Truck-local day bucketing.
//
// MOVED HERE from server.js so the rollup, the backfill script and the driver-pay
// path all share ONE copy. A second hand-written copy of this rule is exactly the
// drift hazard that produced DRIVER_RENAME_TARGETS, truckChargedInMonth() and
// investorExpenseScopeSql() — and here a divergence would put a driver's miles in
// a different week from the invoice that pays for them.
//
// US-centric by design; revisit if the fleet ever runs outside the lower 48.
// Falls back to Central (the zone the Sat-Fri invoice week is built in) when
// longitude is unknown.
function usTzForLongitude(lng) {
	if (typeof lng !== "number" || isNaN(lng)) return "America/Chicago";
	if (lng >= -85) return "America/New_York";
	if (lng >= -100) return "America/Chicago";
	if (lng >= -114) return "America/Denver";
	return "America/Los_Angeles";
}

// One Intl formatter per zone — constructing them is the expensive part, and
// this runs once per ping over ~1M rows.
const _tzDayFmtCache = {};
function localDayInTz(ms, tz) {
	let f = _tzDayFmtCache[tz];
	if (!f) f = _tzDayFmtCache[tz] = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
	let y = "", m = "", d = "";
	for (const p of f.formatToParts(new Date(ms))) {
		if (p.type === "year") y = p.value; else if (p.type === "month") m = p.value; else if (p.type === "day") d = p.value;
	}
	return `${y}-${m}-${d}`; // "YYYY-MM-DD" in the given zone
}

// buildDriverAtResolver(truckIds) — the ONE answer to "who was driving truck X
// at time T".
//
// ⚠️ THERE ARE FOUR SPELLINGS OF THIS QUESTION IN THIS FILE AND ONLY ONE WAS
// TIME-AWARE. The IFTA handler carries a driverAt(truckId, isoTs) closure; every
// other site joins on `ta.end_date = ''`, which answers "who is on this truck
// RIGHT NOW". Those are genuinely different questions and the present-tense ones
// must stay as they are — using a present-tense answer as a historical filter is
// the exact hazard recorded for getInvestorDriverSet(). This helper replaces the
// HISTORICAL copies only.
//
// ⚠️ end_date === '' MEANS STILL OPEN, i.e. UNBOUNDED — never the epoch. Reading
// it the other way strips every current driver of every mile they have driven.
// Same `''`-means-unbounded convention as truckChargeFromMonth().
//
// ⚠️ THE DATE TRAP. truck_assignments.start_date is a full ISO INSTANT
// ('2026-08-14T11:34:03.958Z'), because assignDriverToTruck() writes
// new Date().toISOString(). Comparing that against a bare 'YYYY-MM-DD' fails for
// every afternoon assignment — the post-mortem is at the expenses subquery
// above. That is why there are two forms rather than one coerced comparison:
// .atInstant compares epoch ms (both sides true instants) and .atDay compares
// substr(x,1,10) on BOTH bounds, which is what makes the boundary day inclusive
// at both ends.
//
// Assignments are sorted start_date DESC and the FIRST covering row wins, so
// overlapping rows resolve to the one most recently put in force. (The old IFTA
// closure sorted ASC and returned the oldest — the expenses subquery already
// settled this the other way with ORDER BY ta.start_date DESC LIMIT 1.)
function buildDriverAtResolver(assignmentRows) {
	const byTruck = new Map();
	let unparsed = 0;
	for (const r of assignmentRows || []) {
		const startMs = Date.parse(r.start_date);
		if (!Number.isFinite(startMs)) { unparsed += 1; continue; }
		const openEnd = !r.end_date;
		const endMs = openEnd ? Infinity : Date.parse(r.end_date);
		if (!openEnd && !Number.isFinite(endMs)) { unparsed += 1; continue; }
		let list = byTruck.get(r.truck_id);
		if (!list) byTruck.set(r.truck_id, (list = []));
		list.push({
			startMs, endMs,
			startDay: String(r.start_date).slice(0, 10),
			endDay: openEnd ? "9999-12-31" : String(r.end_date).slice(0, 10),
			driverName: r.driver_name || "",
		});
	}
	for (const list of byTruck.values()) list.sort((a, b) => b.startMs - a.startMs);
	return {
		unresolvedRows: unparsed,
		// Full-fidelity: use this wherever a real instant is available (the
		// mileage rollup has the ping's ms, so a mid-day handover splits exactly).
		atInstant(truckId, ms) {
			for (const a of byTruck.get(Number(truckId)) || []) {
				if (ms >= a.startMs && ms <= a.endMs) return a.driverName;
			}
			return "";
		},
		// Day-grain: both bounds INCLUSIVE, so the handover day belongs to both
		// sides rather than to neither.
		atDay(truckId, day) {
			const d = String(day || "").slice(0, 10);
			for (const a of byTruck.get(Number(truckId)) || []) {
				if (d >= a.startDay && d <= a.endDay) return a.driverName;
			}
			return "";
		},
		// Everyone who held the truck at any point in a window.
		overlaps(truckId, fromMs, toMs) {
			const out = new Set();
			for (const a of byTruck.get(Number(truckId)) || []) {
				if (a.startMs <= toMs && a.endMs >= fromMs) out.add(a.driverName);
			}
			return out;
		},
	};
}


module.exports = {
	ELD_DELTA_FLOOR_MI,
	ELD_MAX_GAP_MS,
	ELD_MAX_MPH,
	acceptOdoDelta,
	dedupeSamples,
	sumOdoDeltas,
	splitDeltasByDayAndDriver,
	dayBasis,
	basisLabel,
	usTzForLongitude,
	localDayInTz,
	buildDriverAtResolver,
};
