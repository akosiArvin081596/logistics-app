"use strict";

// ===========================================================================
// ratecon-drive-index — resolve WHICH archived rate-con belongs to a load,
// by reading the document instead of trusting its file name.
//
// WHY THIS EXISTS
// ---------------
// The n8n dispatch workflow drops every emailed rate-con into one Drive folder
// named with the raw email SUBJECT line. getRateConBytes() then looks the file
// up with `name contains '<our Load ID>'`, on the assumption spelled out in its
// own comment: "We match on the order number (== loadId for Bison)".
//
// That equality is not a rule. Measured 2026-08-19 against the live folder
// (697 files) and the live sheet (421 rows): 50 loads have NO file-name match,
// 3 of them Bison. The incident that prompted this: load 30080873 is filed as
// "Subject: Bison Transport Order #7101850" — Bison's order number, not ours.
// Both numbers are printed inside the PDF; only one made it into the subject.
// The lookup found nothing, so the invoice went to Bison AP with our load id
// standing in for Order #7101850 and no PO # at all.
//
// So: when the name misses, read the text and look for the load id INSIDE it.
//
// ⚠️ SAFETY — WHY THIS FILE IS PARANOID ABOUT MATCHING
// ----------------------------------------------------
// The bytes this picks are ATTACHED TO AN OUTBOUND GMAIL DRAFT ADDRESSED TO
// THE BROKER. A wrong match does not merely produce a wrong invoice — it mails
// another customer's rate and lane to a third party. A miss is recoverable (the
// draft route stops and asks a human); a false positive is not. Every rule
// below is therefore biased toward returning nothing.
//
// The bar: the load id must appear as a WHOLE TOKEN (fracture-resistant — see
// textHasToken), and at least MIN_CORROBORATIONS facts that are specific to THIS
// LOAD must also appear in the same document. Anything less is reported as
// `unconfirmed` and never auto-attached.
//
// ⚠️ "INDEPENDENT" IS NOT THE SAME AS "LOAD-SPECIFIC", and an earlier draft of
// this file confused the two. The broker's email domain and our trailer number
// are independent of the document — but they identify the BROKER and the
// EQUIPMENT, not the load. Every Bison rate-con contains bisontransport.com, and
// a trailer runs twenty loads a month, so counting either as corroboration
// collapses the bar back to the id gate alone. They now contribute to `score`
// (they are still evidence of *something*) and never to `corroborations`.
//
// Pure — no network, no DB, no fs. Bytes are fetched by the caller through the
// injected `readText`. Same shape as ratecon-load.js / fuel-model.js.
// ===========================================================================

// A load id shorter than this is not evidence of anything. Five digits is
// already a US zip, a partial phone, a PO number and a weight; four is worse.
// Every id in the live sheet is >= 7 characters, so this costs us nothing real.
const MIN_LOAD_ID_LEN = 5;

// How many LOAD-SPECIFIC facts must agree before a content match may be
// attached to an outbound broker email. Two, because any single one of them can
// coincide: two loads in a month can share a $1,800 rate, and a busy lane
// repeats the same pickup city for weeks.
const MIN_CORROBORATIONS = 2;

// A sheet cell can hold a raw Google Sheets date serial ("45890"), which
// Date.parse() happily reads as the year 45890 — and a single absurd anchor
// would put EVERY file outside the window and silently empty the scan. Anchors
// further than this from the present are treated as unparseable.
const MAX_ANCHOR_SKEW_MS = 5 * 365 * 24 * 60 * 60 * 1000;

// Default window around the load's own dates. Rate-cons arrive days before
// pickup and the load can be drafted weeks after delivery, so this is
// deliberately generous — the file CAP is the real cost control, not the days.
const DEFAULT_WINDOW_DAYS = 21;
const DEFAULT_MAX_FILES = 40;
// Round trips, not bytes, are the cost here (see pickRateConForLoad).
const DEFAULT_CONCURRENCY = 6;

// ---------------------------------------------------------------------------
// Load-id normalization. Job Tracking holds both "513987502" and "#513987502"
// (see getLoadCoordsRow() in server.js, which had to learn the same lesson),
// and the PDF prints the bare number.
// ---------------------------------------------------------------------------
function normLoadId(id) {
	return String(id == null ? "" : id).trim().replace(/^#/, "").trim();
}

function escapeRe(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Walk over whitespace from `i` in direction `dir`; true when the first
// non-space character is a digit. `maxGap` keeps "a number three words away"
// from counting as adjacent.
function digitAcrossGap(s, i, dir, maxGap = 3) {
	let k = i;
	let gaps = 0;
	while (k >= 0 && k < s.length && /\s/.test(s[k])) {
		if (++gaps > maxGap) return false;
		k += dir;
	}
	return k >= 0 && k < s.length && /[0-9]/.test(s[k]);
}

// Whole-token containment. "30080873" must not match inside "300808731".
//
// ⚠️ Deliberately NOT \b, and the difference is not cosmetic. \b counts "_" as
// a word character, so it REFUSES "SHIPMENT_30080873" — a perfectly ordinary
// way for a rate-con to print our load id, and refusing it costs us a real
// match. This rule accepts it.
//
// ⚠️⚠️ AND THE CHARACTER-LEVEL BOUNDARY IS NOT ENOUGH ON ITS OWN, because of the
// extractor this is paired with. harvestPdfStrings() (lib/broker-invoice.js)
// harvests every `(...)` literal and SPACE-JOINS them, and PDF kerning routinely
// splits a number across literals: `[(Order # )-2(30080873)-140(1)] TJ` is the
// number 300808731, but it extracts as "Order #  30080873 1". A pure boundary
// test then reports a hit for load 30080873 on a document that never mentioned
// it. That is not hypothetical — real files in this corpus already extract with
// runs like "2216467 0", "54406 1", "3575 7", and a false hit here MAILS
// ANOTHER CUSTOMER'S RATE CONFIRMATION TO A BROKER.
//
// So a match is also refused when a digit sits across a whitespace gap on either
// side. Verified against the real document this was built for, where the id
// reads "LEG #: 30080873 PO #: 2795482" — flanked by letters, so it still hits.
// The cost is recall on a genuine "…30080873 1 pallet…", which is the right
// trade when the failure mode on the other side is a data leak.
function textHasToken(text, token) {
	const t = String(token || "");
	if (!t) return false;
	const s = String(text || "");
	// Lookahead, not a consuming class, so overlapping occurrences still scan.
	const re = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(t)}(?=$|[^A-Za-z0-9])`, "g");
	let m;
	while ((m = re.exec(s)) !== null) {
		const start = m.index + (m[0].length - t.length);
		const end = start + t.length;
		// One clean occurrence is enough; a fractured one elsewhere must not veto it.
		if (!digitAcrossGap(s, start - 1, -1) && !digitAcrossGap(s, end, 1)) return true;
		re.lastIndex = end;
	}
	return false;
}

// Every money-shaped figure in the document, as Numbers. Rate-cons always
// print cents ("1,800.00"), so requiring the decimals keeps this from matching
// zip codes, weights, phone fragments and order numbers.
//
// The {0,20} is the house rule on bounded quantifiers, not a guess about money:
// this runs over text extracted from a PDF that arrived by EMAIL, and this repo
// has had three separate super-linear parsers block the event loop in
// production (9 s, 28 s, 113 s). A single star is linear today, but the bound
// costs nothing and survives the next person editing this pattern. No real
// figure needs more than 20 characters ahead of the decimal point.
function moneyFigures(text) {
	const out = [];
	const re = /\d[\d,]{0,20}\.\d{2}/g;
	let m;
	while ((m = re.exec(String(text || ""))) !== null) {
		const n = parseFloat(m[0].replace(/,/g, ""));
		if (isFinite(n) && n > 0) out.push(n);
	}
	return out;
}

// The reference numbers a Drive file NAME (i.e. the email subject) carries.
//
// This is the other half of the same mismatch. "Subject: Bison Transport Order
// #7101850" is how load 30080873 is filed, so reconcileRateCons() — which reads
// subjects — declares 7101850 an ingestion gap even though the load has been in
// Job Tracking all along. Once a file is matched to a load by content, the
// numbers in its name are PROVEN aliases for that load and can stop the alert.
//
// ⚠️ SEVEN, not MIN_LOAD_ID_LEN. An alias permanently suppresses a
// reconcileRateCons() alert for that number, so a wrong one is a silent
// monitoring hole with no expiry. A US ZIP is exactly 5 digits and subjects
// routinely carry them ("... - AMES IA 50010 - ..."), so a 5-digit floor
// records zips as load aliases. Every load id in the live sheet is >= 7
// characters and the reconcile sweep's own candidate pattern is 6-12 digits, so
// a 7-digit floor costs nothing real and closes the hole.
const MIN_ALIAS_LEN = 7;
function subjectRefTokens(name) {
	const out = [];
	const re = /\d{2,}/g;
	let m;
	while ((m = re.exec(String(name || ""))) !== null) {
		// An 8-digit YYYYMMDD in a subject is a date, not a load.
		if (m[0].length >= MIN_ALIAS_LEN && !/^20\d{6}$/.test(m[0])) out.push(m[0]);
	}
	return out.filter((t, i, a) => a.indexOf(t) === i);
}

// THE canonical "does this Drive file name carry our load id?" predicate.
//
// ⚠️ ONE DEFINITION, because there were three and they disagreed. Step 1 of
// getRateConBytes() strips ALL non-alphanumerics from the id and substring-tests
// the name; the backfill's pending filter used whole-token matching on the
// UNSTRIPPED id. For a punctuated id they give opposite answers — load
// "LD-MP4W4LP1" against file "LD-MP4W4LP1.pdf" is a miss for step 1 and a hit
// for the token test — so the backfill excluded exactly the loads step 1 cannot
// find. This repo's standing hazard is hand-copied rules drifting; both callers
// use this now.
function safeIdToken(loadId) {
	return normLoadId(loadId).replace(/[^A-Za-z0-9]/g, "");
}
function filenameCarriesLoadId(name, loadId) {
	const safe = safeIdToken(loadId);
	return !!safe && String(name || "").includes(safe);
}

function domainOf(email) {
	const m = /@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(String(email || ""));
	return m ? m[1].toLowerCase() : "";
}

// ---------------------------------------------------------------------------
// scoreRateConMatch — does THIS document belong to THIS load?
//
// loadCtx: { loadId, totalRate, brokerEmail, trailerNumber }
//   totalRate — the sheet's "  Payment  " value, as a Number (0 when unknown).
//   brokerEmail — the sheet's Email column (the booking agent's address).
// fileMeta: { id, name, createdTime }
//
// Returns { idHit, corroborations, score, reasons[] }. The caller decides;
// this function only reports what it saw.
// ---------------------------------------------------------------------------
function scoreRateConMatch(loadCtx, pdfText, fileMeta) {
	const reasons = [];
	const id = normLoadId(loadCtx && loadCtx.loadId);
	const text = String(pdfText || "");
	const name = String((fileMeta && fileMeta.name) || "");

	if (id.length < MIN_LOAD_ID_LEN) {
		return { idHit: false, corroborations: 0, score: 0, reasons: ["load-id-too-short"] };
	}

	// --- the gate -----------------------------------------------------------
	const inName = textHasToken(name, id);
	const inText = textHasToken(text, id);
	if (inName) reasons.push("id-in-filename");
	if (inText) reasons.push("id-in-document");
	const idHit = inName || inText;
	if (!idHit) return { idHit: false, corroborations: 0, score: 0, reasons };

	// --- LOAD-SPECIFIC corroboration ---------------------------------------
	// Only facts that distinguish THIS load from the broker's other loads count.
	// See the header: broker domain and trailer are deliberately excluded.
	let corroborations = 0;
	const lower = text.toLowerCase();

	const sheetTotal = Number(loadCtx && loadCtx.totalRate) || 0;
	if (sheetTotal > 0) {
		// Compare in cents — 1800 and 1800.004 are the same money.
		const want = Math.round(sheetTotal * 100);
		if (moneyFigures(text).some((n) => Math.round(n * 100) === want)) {
			corroborations++;
			reasons.push("total-matches-sheet");
		}
	}

	// The lane. A rate-con always names both cities, and the pair is far more
	// load-specific than anything else on the sheet. Matched on CITY, not the
	// whole address string: the sheet stores "3311 EAST LINCOLN WAY, AMES, IA
	// 50010" while the document prints the stop block differently, and the
	// street half never survives the comparison.
	for (const [label, raw] of [["pickup", loadCtx && loadCtx.pickupAddress], ["dropoff", loadCtx && loadCtx.dropoffAddress]]) {
		const city = cityOfAddress(raw);
		if (city && city.length >= 4 && lower.includes(city)) {
			corroborations++;
			reasons.push(`${label}-city-in-document`);
		}
	}

	// --- SUPPORTING signals — scored, never counted as corroboration --------
	let support = 0;
	const dom = domainOf(loadCtx && loadCtx.brokerEmail);
	if (dom && lower.includes(dom)) {
		support++;
		reasons.push("broker-domain-in-document(support)");
	}
	const trailer = String((loadCtx && loadCtx.trailerNumber) || "").trim();
	if (trailer.length >= 4 && textHasToken(text, trailer)) {
		support++;
		reasons.push("trailer-matches-sheet(support)");
	}
	if (inName && inText) {
		support++;
		reasons.push("filename-and-document-agree(support)");
	}

	const score = (inName ? 2 : 0) + (inText ? 2 : 0) + corroborations * 2 + support;
	return { idHit: true, corroborations, support, score, reasons };
}

// The city out of a sheet address cell. "3311 EAST LINCOLN WAY, AMES, IA 50010"
// -> "ames". Takes the second-to-last comma field, which is where the city sits
// in every shape this sheet holds ("CITY, ST ZIP" and "STREET, CITY, ST ZIP").
// Returns "" when the cell has no commas at all rather than guessing where a
// street name ends — the same residual cityStateZip() deliberately leaves alone.
function cityOfAddress(raw) {
	const parts = String(raw || "")
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
	if (parts.length < 2) return "";
	const city = parts[parts.length - 2];
	// Guard against a street landing here ("4528 W ROYAL LN, IRVING, TX") — a
	// city does not start with a house number.
	if (/^\d/.test(city)) return "";
	return city.toLowerCase();
}

// ---------------------------------------------------------------------------
// filesInWindow — bound the scan before any bytes are downloaded.
//
// `centers` are ISO-ish date strings for the load (assigned / pickup /
// delivery). Files are kept when they fall within `days` of ANY of them, then
// ranked by proximity to the nearest center and capped.
//
// A file with no usable createdTime is kept but ranked last — an unparseable
// timestamp must not silently hide the one file we need.
// ---------------------------------------------------------------------------
function filesInWindow(files, centers, opts = {}) {
	const days = Number(opts.windowDays) > 0 ? Number(opts.windowDays) : DEFAULT_WINDOW_DAYS;
	const cap = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : DEFAULT_MAX_FILES;
	const span = days * 86400000;

	// ⚠️ A PARSEABLE ANCHOR CAN STILL BE NONSENSE, and that is worse than an
	// unparseable one. An unformatted sheet cell yields a raw date serial like
	// "45890", which Date.parse() reads as the year 45890 — putting every file
	// outside the window and silently returning ZERO files. The caller then
	// records a scan miss and caches it for 15 minutes, so the retry does not
	// help either. Skew-bound the anchors so junk degrades to the
	// no-anchors path (scan the cap, nearest-first) instead of to nothing.
	const nowMs = Number(opts.nowMs) || Date.now();
	const anchors = (Array.isArray(centers) ? centers : [centers])
		.map((c) => {
			const t = Date.parse(String(c || ""));
			if (!isFinite(t)) return null;
			return Math.abs(t - nowMs) > MAX_ANCHOR_SKEW_MS ? null : t;
		})
		.filter((t) => t !== null);

	const scored = (Array.isArray(files) ? files : []).map((f) => {
		const t = Date.parse(String((f && f.createdTime) || ""));
		if (!isFinite(t)) return { file: f, distance: Infinity, inWindow: true };
		if (!anchors.length) return { file: f, distance: 0, inWindow: true };
		const distance = Math.min(...anchors.map((a) => Math.abs(t - a)));
		return { file: f, distance, inWindow: distance <= span };
	});

	return scored
		.filter((s) => s.inWindow)
		.sort((a, b) => a.distance - b.distance)
		.slice(0, cap)
		.map((s) => s.file);
}

// ---------------------------------------------------------------------------
// pickRateConForLoad — the entry point.
//
// readText(file) -> Promise<string> (the caller downloads + extracts; a throw
// or a null is treated as "unreadable", never as a match).
//
// Returns { accepted[], unconfirmed[], scanned }.
//   accepted    — id hit AND >= 1 independent corroboration. Safe to attach.
//   unconfirmed — id hit, nothing corroborated. Show a human; never attach.
//
// Both are ordered best-first. `accepted` is a LIST, not a winner: a load
// legitimately has several files (the original plus a "Re:" reply or a signed
// scan), and getRateConBytes() already models rate-cons as candidates[].
// ---------------------------------------------------------------------------
async function pickRateConForLoad(loadCtx, files, readText, opts = {}) {
	const accepted = [];
	const unconfirmed = [];
	let scanned = 0;

	const id = normLoadId(loadCtx && loadCtx.loadId);
	if (id.length < MIN_LOAD_ID_LEN) return { accepted, unconfirmed, scanned };

	const centers = [
		loadCtx && loadCtx.assignedDate,
		loadCtx && loadCtx.pickupDate,
		loadCtx && loadCtx.deliveryDate,
	].filter(Boolean);

	// Nothing to corroborate against means every match would be `unconfirmed`
	// anyway, so the scan is guaranteed-futile downloads. Refuse it outright
	// rather than spending 40 Drive reads to reach that conclusion.
	const canCorroborate =
		(Number(loadCtx && loadCtx.totalRate) || 0) > 0 ||
		!!cityOfAddress(loadCtx && loadCtx.pickupAddress) ||
		!!cityOfAddress(loadCtx && loadCtx.dropoffAddress);
	if (!canCorroborate) return { accepted, unconfirmed, scanned, skipped: "no-corroborating-facts" };

	const list = filesInWindow(files, centers, opts);
	const concurrency = Math.max(1, Math.min(16, Number(opts.concurrency) || DEFAULT_CONCURRENCY));
	// ⚠️ TWO empty batches, not one. A load's copies are usually adjacent in
	// time, but "usually" was doing real work here: with one legitimate copy at
	// sorted position 0 and its signed counterpart at position 12, a single
	// empty batch in between ended the scan and lost the second file. That costs
	// the alternate-candidate documentsEmail recovery its input and leaves the
	// second file's subject number un-aliased, so reconcile still alerts on it.
	const EMPTY_BATCHES_BEFORE_STOP = 2;
	let emptyBatches = 0;

	// ⚠️ BATCHED, AND IT STOPS EARLY — both measured, not preference.
	//
	// A sequential scan of a 40-file window took 137 s against the live folder.
	// The bytes are trivial (2.6 MB); it is 40 round trips, one at a time, on a
	// route whose client gives up at 60 s. Batching turns that into 40/N waves.
	//
	// The early stop is what makes the common case cheap. `list` is ordered by
	// proximity to the load's own dates, and a load's rate-cons cluster in time
	// (the original and its "Re:" reply arrive minutes apart), so once a batch
	// has produced matches and the NEXT batch produces none, later files are
	// only further away in time. Keep scanning to the cap when nothing has
	// matched yet — that is the case where the answer is still ahead of us.
	for (let i = 0; i < list.length; i += concurrency) {
		const batch = list.slice(i, i + concurrency);
		const read = await Promise.all(
			batch.map(async (file) => {
				try {
					return { file, text: (await readText(file)) || "" };
				} catch {
					return null; // unreadable is not a match
				}
			}),
		);
		let freshlyAccepted = 0;
		for (const r of read) {
			if (!r) continue;
			scanned++;
			const verdict = scoreRateConMatch(loadCtx, r.text, r.file);
			if (!verdict.idHit) continue;
			if (verdict.corroborations >= MIN_CORROBORATIONS) {
				accepted.push({ file: r.file, ...verdict });
				freshlyAccepted++;
			} else {
				unconfirmed.push({ file: r.file, ...verdict });
			}
		}
		if (accepted.length) {
			emptyBatches = freshlyAccepted ? 0 : emptyBatches + 1;
			if (emptyBatches >= EMPTY_BATCHES_BEFORE_STOP) break;
		}
	}

	const best = (a, b) =>
		b.score - a.score ||
		Date.parse(String((b.file && b.file.createdTime) || 0)) -
			Date.parse(String((a.file && a.file.createdTime) || 0));
	accepted.sort(best);
	unconfirmed.sort(best);

	return { accepted, unconfirmed, scanned };
}

module.exports = {
	MIN_LOAD_ID_LEN,
	MIN_CORROBORATIONS,
	MIN_ALIAS_LEN,
	cityOfAddress,
	DEFAULT_WINDOW_DAYS,
	DEFAULT_MAX_FILES,
	DEFAULT_CONCURRENCY,
	normLoadId,
	textHasToken,
	moneyFigures,
	subjectRefTokens,
	safeIdToken,
	filenameCarriesLoadId,
	domainOf,
	scoreRateConMatch,
	filesInWindow,
	pickRateConForLoad,
};
