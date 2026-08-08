// Pure decision logic for "is this the same PURCHASE entered twice?" — no
// network, no DB, no fs. server.js owns the query, the period lock, the
// conscious-override suppression and the wire shape.
//
// WHY THIS EXISTS. `expenses.receipt_hash` answers "is this the same FILE",
// which is a different question. The same receipt routinely reaches the app as
// two different images — the driver photographs it on his phone (HEIC, converted
// client-side) and an admin later bulk-uploads the copy the driver texted him,
// or ScanKit enhances one pass and falls back to the raw photo on another. The
// bytes differ, the hash differs, and the P&L is billed twice. $1,115.35 of
// production spend is double-booked across 5 pairs that way, and every one of
// them was found by hand.
//
// ⚠️ THE OBVIOUS CONTENT KEY IS TOO AGGRESSIVE. Truck + day + amount alone
// flags three production pairs that are legitimately separate fill-ups:
//
//     2026-06-18  $200  SHELL 48.09 gal    ·  5 STAR 51.30 gal
//     2026-06-24  $200  QuikTrip 52.65     ·  FAST LANE 41.68
//     2026-08-01  $400  CAMERON 83.35      ·  5 STAR 87.93
//
// A driver putting $200 in twice in one day is normal, and round prepaid amounts
// ($100/$200/$400) are exactly the ones that repeat. So the key alone is a
// CANDIDATE, never a verdict, and the verdict is reached by trying to EXONERATE
// the pair rather than by trying to convict it.
//
// TWO INDEPENDENT EXONERATORS, both measured against the production set:
//   (1) VENDOR DISAGREEMENT — both sides name a merchant and the merchants
//       differ. Clears all three pairs above.
//   (2) VOLUME DISAGREEMENT — both sides carry gallons and they differ by more
//       than a transcription slip. Also clears all three, independently: the
//       legitimate pairs differ by 5-21%, while a receipt read twice reproduces
//       its own volume.
// Either one is sufficient. Two of them because vendor is missing on one side of
// three of the five real duplicates — which is the whole reason the existing
// create-time check never fired — so a rule resting on vendor alone would go
// blind on exactly the cases that cost the money.
//
// ⚠️ TYPE IS DELIBERATELY NOT PART OF THE KEY. Two of the five production
// duplicates are not typed `Fuel`: the 2026-05-12 $15.25 Pilot pair is `Other`,
// and the 2026-06-16 $400 QuikTrip pair is typed `Maintenance` on BOTH sides
// while being a 97.59-gallon diesel receipt. Keying on type would drop 2 of 5.
// The same argument rules out filtering the scan to fuel.
//
// ⚠️ CREATION TIME IS NOT A SIGNAL. It reads like one — a re-entry weeks later
// looks obvious — but measured, it separates nothing: two of the five duplicates
// were created 2 minutes apart (17:17:47/17:19:43 and 12:42:25/12:44:55), which
// is the same spacing as the legitimate pairs (20:00:04/20:01:38). Somebody
// working through a stack of receipts produces both. It is not used.

// A pair whose gallons differ by more than EITHER bound is exonerated. Generous
// enough to still convict a re-typed 97.59 vs 97.6, tight enough that the
// closest legitimate production pair (83.35 vs 87.93, 5.2%) clears comfortably.
const GALLONS_DISAGREE_MIN_ABS = 0.5;
const GALLONS_DISAGREE_MIN_REL = 0.01;

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

const s = (v) => String(v == null ? "" : v).trim();
const money = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const vol = (v) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : 0;
};

// Which bucket does this row compete in? Truck first — a receipt is the TRUCK's
// cost and a truck can change hands mid-month — falling back to the driver when
// the row has no truck stamped. The fallback matters: without it every
// truckless row (an unlinked driver, a fixture) would land in one giant bucket
// keyed on the empty string and cross-match strangers.
function duplicateKey(row) {
	const cents = money(row && row.amount);
	const date = s(row && row.date);
	if (cents == null || cents <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	const truck = s(row && row.truck_unit).toLowerCase();
	const scope = truck ? `t:${truck}` : `d:${s(row && row.driver).toLowerCase().replace(/\s+/g, " ")}`;
	if (scope === "d:") return null; // neither truck nor driver — nothing to scope to
	return `${scope}|${date}|${cents}`;
}

// The verdict for ONE pair. Returns why, in both directions, because a queue
// that says "duplicate" without saying what it compared cannot be audited by the
// person who has to act on it.
function judgeReceiptPair(a, b) {
	const reasons = [];
	const va = s(a && a.vendor_normalized).toUpperCase();
	const vb = s(b && b.vendor_normalized).toUpperCase();
	const ga = vol(a && a.gallons);
	const gb = vol(b && b.gallons);

	// Exonerator 1 — both name a merchant, and they are different merchants.
	if (va && vb && va !== vb) {
		return { duplicate: false, confidence: null, reasons: [`different merchants (${va} vs ${vb})`] };
	}
	// Exonerator 2 — both carry a volume, and the volumes disagree by more than a
	// transcription slip. Independent of vendor on purpose: it still clears a pair
	// where one side's merchant never got typed.
	if (ga > 0 && gb > 0) {
		const diff = Math.abs(ga - gb);
		if (diff > GALLONS_DISAGREE_MIN_ABS && diff / Math.max(ga, gb) > GALLONS_DISAGREE_MIN_REL) {
			return { duplicate: false, confidence: null, reasons: [`different volumes (${ga} vs ${gb} gal)`] };
		}
	}

	// Nothing exonerates it. How loudly to say so depends on how much the two
	// rows actually agree about — a missing merchant is SUGGESTIVE, never proof.
	let confidence;
	if (va && vb) {
		confidence = "high";
		reasons.push(`same merchant (${va})`);
	} else if (va || vb) {
		confidence = "medium";
		reasons.push(`merchant missing on one side (${va || vb} vs blank)`);
	} else {
		confidence = "low";
		reasons.push("no merchant on either side");
	}
	if (ga > 0 && gb > 0) reasons.push(`same volume (${ga} gal)`);
	else if (ga > 0 || gb > 0) reasons.push(`volume on one side only (${ga || gb} gal)`);
	else reasons.push("no volume on either side");
	return { duplicate: true, confidence, reasons };
}

// Group rows into duplicate CANDIDATES.
//
// A group is emitted when at least one pair inside its key survives both
// exonerators; rows that every surviving member exonerates are dropped from it.
// So a truck-day-amount holding one duplicate pair AND one unrelated third fill
// reports the pair, not the trio.
function findDuplicateGroups(rows, { suppressedIds = new Set() } = {}) {
	const buckets = new Map();
	for (const r of rows || []) {
		const k = duplicateKey(r);
		if (!k) continue;
		if (!buckets.has(k)) buckets.set(k, []);
		buckets.get(k).push(r);
	}

	const groups = [];
	for (const [key, members] of buckets) {
		if (members.length < 2) continue;
		// A group anybody consciously accepted at create time is closed, not
		// re-litigated forever. That signal already exists (audit_trail
		// `expense_duplicate_override`) and server.js passes it in.
		if (members.some((m) => suppressedIds.has(m.id))) continue;

		const linked = new Set();
		const pairs = [];
		let best = null;
		for (let i = 0; i < members.length; i++) {
			for (let j = i + 1; j < members.length; j++) {
				const verdict = judgeReceiptPair(members[i], members[j]);
				if (!verdict.duplicate) continue;
				linked.add(members[i].id);
				linked.add(members[j].id);
				pairs.push({ ids: [members[i].id, members[j].id], confidence: verdict.confidence, reasons: verdict.reasons });
				if (!best || CONFIDENCE_RANK[verdict.confidence] > CONFIDENCE_RANK[best.confidence]) best = verdict;
			}
		}
		if (!pairs.length) continue;

		const kept = members.filter((m) => linked.has(m.id));
		const amount = Number(kept[0].amount) || 0;
		groups.push({
			key,
			truckUnit: s(kept[0].truck_unit),
			driver: s(kept[0].driver),
			date: s(kept[0].date),
			amount,
			// What double-booking THIS group costs: every copy after the first.
			excessAmount: Math.round(amount * (kept.length - 1) * 100) / 100,
			confidence: best.confidence,
			reasons: best.reasons,
			pairs,
			rows: kept,
		});
	}

	// Loudest first: biggest money, then confidence, then newest — and `key` last
	// so the order is stable run to run rather than Map insertion order.
	groups.sort((x, y) =>
		y.excessAmount - x.excessAmount ||
		CONFIDENCE_RANK[y.confidence] - CONFIDENCE_RANK[x.confidence] ||
		(y.date < x.date ? -1 : y.date > x.date ? 1 : 0) ||
		x.key.localeCompare(y.key));
	return groups;
}

function summarizeDuplicates(groups) {
	const round2 = (n) => Math.round(n * 100) / 100;
	const byTruck = new Map();
	let excessAmount = 0, rowCount = 0;
	const byConfidence = { high: 0, medium: 0, low: 0 };
	for (const g of groups || []) {
		excessAmount += g.excessAmount;
		rowCount += g.rows.length;
		byConfidence[g.confidence] = (byConfidence[g.confidence] || 0) + 1;
		const unit = s(g.truckUnit);
		const k = unit.toLowerCase();
		let t = byTruck.get(k);
		if (!t) byTruck.set(k, (t = { truckUnit: unit, groups: 0, excessAmount: 0 }));
		t.groups++;
		t.excessAmount += g.excessAmount;
	}
	return {
		groupCount: (groups || []).length,
		rowCount,
		excessAmount: round2(excessAmount),
		byConfidence,
		byTruck: [...byTruck.values()]
			.map((t) => ({ ...t, excessAmount: round2(t.excessAmount) }))
			.sort((a, b) => b.excessAmount - a.excessAmount || b.groups - a.groups
				|| a.truckUnit.localeCompare(b.truckUnit)),
	};
}

module.exports = {
	GALLONS_DISAGREE_MIN_ABS,
	GALLONS_DISAGREE_MIN_REL,
	// Exported so the create-time warning in server.js ranks "which candidate is
	// the strongest match" off the SAME table this module sorts groups by, rather
	// than keeping a second copy that can drift out of step with it.
	CONFIDENCE_RANK,
	duplicateKey,
	judgeReceiptPair,
	findDuplicateGroups,
	summarizeDuplicates,
};
