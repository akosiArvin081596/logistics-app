#!/usr/bin/env node
/**
 * Tests for lib/ratecon-drive-index.js — the matcher that decides WHICH
 * archived rate-con belongs to a load when its file name does not say.
 *
 * THE PROPERTY UNDER TEST IS NOT "the right file is found".
 * It is that THE WRONG FILE IS NEVER ACCEPTED. The bytes this module picks get
 * attached to a Gmail draft addressed to the broker, so a false positive mails
 * another customer's rate and lane to a third party. A miss is recoverable —
 * the draft route stops and asks a human for the Order #/PO #. A false positive
 * is not recoverable, because it has already been sent.
 *
 * Every §  below is therefore a way the matcher could wrongly say yes:
 *   §1  a load id that is really a substring of a longer number
 *   §2  a load id short enough to collide with a zip / weight / phone fragment
 *   §3  an id hit with nothing to corroborate it  (-> unconfirmed, not accepted)
 *   §4  ANOTHER LOAD'S rate-con from the SAME broker  (the leak case)
 *   §5  money matching that latches onto a zip code or a weight
 *   §6  a scan that grows without bound as the archive grows
 *
 * The fixtures are the real 2026-08-19 incident: Job Tracking load 30080873,
 * filed in Drive as "Subject: Bison Transport Order #7101850", $1,800.00,
 * tholmes@bisontransport.com. That pair is the regression being locked.
 *
 * Run: node scripts/test-ratecon-drive-index.js
 */
const idx = require("../lib/ratecon-drive-index.js");
const brokerInvoice = require("../lib/broker-invoice.js");
const zlib = require("zlib");

// Build a real PDF around a real content stream, so fixtures go through the
// SAME extractor the route uses. §9 exists because they did not: the original
// §1 asserted textHasToken against hand-written strings, which cannot show what
// harvestPdfStrings() does to a kerned number — and that gap hid a live leak.
function pdfWith(contentStream) {
	const z = zlib.deflateSync(Buffer.from(contentStream, "latin1"));
	return Buffer.concat([
		Buffer.from(`%PDF-1.4\n1 0 obj<</Length ${z.length}/Filter/FlateDecode>>stream\n`, "latin1"),
		z,
		Buffer.from("\nendstream endobj\n%%EOF", "latin1"),
	]);
}
const textOf = (stream) => brokerInvoice.extractPdfText(pdfWith(stream)) || "";

const failures = [];
let pass = 0;
function ok(cond, msg) {
	if (cond) { pass++; return; }
	failures.push(msg);
}

// The real load, as the sheet knows it.
const LOAD = {
	loadId: "30080873",
	totalRate: 1800,
	brokerEmail: "tholmes@bisontransport.com",
	trailerNumber: "24045",
	pickupAddress: "3311 EAST LINCOLN WAY, AMES, IA 50010",
	dropoffAddress: "2930 114TH STREET, GRAND PRAIRIE, TX 75050",
	assignedDate: "2026-08-18",
};

// Our load id appears only INSIDE the document, while the file name carries
// Bison's own order number. That asymmetry is the entire bug.
// Wording taken from the real 2026-08-17 document, including the detail that
// matters most: our load id is the LEG #, flanked by letters, which is why the
// fracture guard in §1 does not cost us this match.
const RATECON_TEXT = [
	"Billing Information: Order #: 7101850 LEG #: 30080873 PO #: 2795482 Move #: 20110086",
	"Trailer: 24045",
	"Total Rate: $1,800.00",
	"Questions: tholmes@bisontransport.com",
	"MURPHY - BARILLA AMES PLANT, AMES, IA 50010",
	"GXO - GRAND PRAIRIE TX 75050",
].join("\n");

const FILE = { id: "drv1", name: "Subject: Bison Transport Order #7101850", createdTime: "2026-08-17T12:04:49Z" };

// ---------------------------------------------------------------- §0 baseline
{
	const v = idx.scoreRateConMatch(LOAD, RATECON_TEXT, FILE);
	ok(v.idHit === true, "§0 the real document is not recognised at all");
	ok(v.corroborations >= 1, "§0 the real document has no corroborating signal");
	ok(v.reasons.includes("id-in-document"), "§0 the id was not found in the document body");
	ok(!v.reasons.includes("id-in-filename"), "§0 CONTROL: the file name must NOT contain our load id — if it did, this fixture is not reproducing the bug");
	ok(v.reasons.includes("total-matches-sheet"), "§0 $1,800.00 did not corroborate");
	ok(v.reasons.includes("pickup-city-in-document"), "§0 AMES did not corroborate");
	ok(v.reasons.includes("dropoff-city-in-document"), "§0 GRAND PRAIRIE did not corroborate");
	ok(v.corroborations >= idx.MIN_CORROBORATIONS, "§0 the real document would not be ACCEPTED");
}

// -------------------------------------------------- §1 whole-token boundaries
{
	ok(idx.textHasToken("Load 30080873 x", "30080873"), "§1 a clean token must match");
	ok(idx.textHasToken("(30080873)", "30080873"), "§1 punctuation must still bound a token");
	ok(idx.textHasToken("30080873", "30080873"), "§1 a bare token at both string edges must match");
	ok(!idx.textHasToken("300808731", "30080873"), "§1 LEAK: matched a longer number with our id as a prefix");
	ok(!idx.textHasToken("130080873", "30080873"), "§1 LEAK: matched a longer number with our id as a suffix");
	// "_" IS a boundary here, on purpose. \b would count it as a word character
	// and refuse "SHIPMENT_30080873", which is an ordinary way to print our id.
	// The dangerous case is digit adjacency, asserted above, and \b buys nothing
	// there because both rules already reject it.
	ok(idx.textHasToken("SHIPMENT_30080873", "30080873"), "§1 an underscore-separated ref was refused — \\b semantics have crept in");
	ok(!/\b30080873\b/.test("SHIPMENT_30080873"), "§1 CONTROL: \\b really would have refused that ref, which is why the rule is hand-written");
	// And the same guarantee through the public scorer, not just the helper.
	const v = idx.scoreRateConMatch(LOAD, "reference 300808731 only", FILE);
	ok(v.idHit === false, "§1 LEAK: scoreRateConMatch accepted a superstring hit");
}

// ------------------------------------------------------- §2 short-id refusal
{
	const short = { ...LOAD, loadId: "1234" };
	const v = idx.scoreRateConMatch(short, "PO 1234 total $1,800.00 bisontransport.com", FILE);
	ok(v.idHit === false, "§2 LEAK: a 4-character load id was allowed to match");
	ok(v.reasons.includes("load-id-too-short"), "§2 the refusal reason was not reported");
	ok(idx.MIN_LOAD_ID_LEN >= 5, "§2 the minimum load-id length floor was lowered");
}

// ------------------------------- §3 an uncorroborated id hit is NOT acceptable
{
	// Our id is present, but nothing else about the load is.
	const lonely = "Load 30080873 appears here and nothing else does.";
	const v = idx.scoreRateConMatch(LOAD, lonely, FILE);
	ok(v.idHit === true, "§3 the id should still be seen");
	ok(v.corroborations === 0, "§3 nothing should have corroborated");
}

// --------------------------------------------- §4 THE LEAK CASE: another load
{
	// A different Bison load, same broker, same folder, same week. The broker
	// domain WILL corroborate — so the load-id gate is the only thing standing
	// between us and mailing this customer's rate to the wrong invoice.
	const otherLoad = [
		"Bison Transport Order # 7086762",
		"PO # 1119988  Trailer: 51237",
		"Load 29997001",
		"Total Rate: $2,450.00",
		"Questions: tholmes@bisontransport.com",
	].join("\n");
	const v = idx.scoreRateConMatch(LOAD, otherLoad, { id: "drv9", name: "Subject: Bison Transport Order #7086762", createdTime: "2026-08-17T09:00:00Z" });
	ok(v.idHit === false, "§4 LEAK: another load's rate-con matched ours");
	ok(v.score === 0, "§4 LEAK: another load's rate-con scored above zero");
	// The corroborating signals alone must never be enough.
	ok(!v.reasons.some((r) => r.startsWith("broker-domain")), "§4 signals were evaluated despite no id hit — they must never stand in for the gate");
}

// ------------------------------------------------------- §5 money discipline
{
	const figs = idx.moneyFigures("zip 50010, 40278.0LBS, 2940.00 PCS, Total Rate: $1,800.00");
	ok(figs.includes(1800), "§5 the real total was not extracted");
	ok(!figs.includes(50010), "§5 LEAK: a zip code was read as money");
	ok(!figs.includes(40278), "§5 LEAK: a weight with one decimal was read as money");
	// "2940.00 PCS" is money-SHAPED, and that is the point of requiring a second
	// signal rather than trusting the total alone.
	ok(figs.includes(2940), "§5 CONTROL: a money-shaped piece count is indistinguishable by shape alone");

	// A total that does not agree must not corroborate.
	const wrong = idx.scoreRateConMatch({ ...LOAD, brokerEmail: "" }, "Load 30080873 Total Rate: $2,450.00", FILE);
	ok(wrong.idHit === true && wrong.corroborations === 0, "§5 LEAK: a mismatched total corroborated anyway");
}

// ----------------------------------------------------------- §6 bounded scan
{
	const many = Array.from({ length: 400 }, (_, i) => ({
		id: `f${i}`,
		name: `file ${i}`,
		createdTime: new Date(Date.parse("2026-08-18") - i * 86400000).toISOString(),
	}));
	const win = idx.filesInWindow(many, ["2026-08-18"], { windowDays: 21, maxFiles: 40 });
	ok(win.length <= 40, "§6 the file cap did not hold");
	ok(win.length <= 22, "§6 the date window did not hold (one file/day, 21 days each side of the newest)");
	ok(win[0].id === "f0", "§6 the nearest file must be scanned first");

	// A file with an unreadable timestamp must be KEPT, ranked last — dropping
	// it would silently hide the one file we need.
	const withJunk = idx.filesInWindow(
		[{ id: "junk", name: "x", createdTime: "not-a-date" }, { id: "near", name: "y", createdTime: "2026-08-18T00:00:00Z" }],
		["2026-08-18"], {},
	);
	ok(withJunk.some((f) => f.id === "junk"), "§6 a file with an unparseable createdTime was dropped");
	ok(withJunk[0].id === "near", "§6 an unparseable createdTime must rank last, not first");

	// No anchors at all (a load with no usable dates) must not empty the scan.
	ok(idx.filesInWindow(many, [], { maxFiles: 5 }).length === 5, "§6 a load with no dates scanned nothing");
}

// ---------------------------------------- §7 pickRateConForLoad end-to-end
(async () => {
	const OTHER = { id: "drv9", name: "Subject: Bison Transport Order #7086762", createdTime: "2026-08-17T09:00:00Z" };
	const REPLY = { id: "drv2", name: "Subject: RE: Bison Transport Order #7101850", createdTime: "2026-08-17T12:10:45Z" };
	const UNREADABLE = { id: "drv3", name: "Subject: scanned copy", createdTime: "2026-08-17T13:00:00Z" };

	const texts = {
		drv1: RATECON_TEXT,
		drv2: RATECON_TEXT,
		drv9: "Bison Transport Order # 7086762\nLoad 29997001\nTotal Rate: $2,450.00\ntholmes@bisontransport.com",
		drv3: null,
	};
	const readText = async (f) => {
		if (f.id === "drv3") throw new Error("unreadable");
		return texts[f.id];
	};

	const out = await idx.pickRateConForLoad(LOAD, [FILE, REPLY, OTHER, UNREADABLE], readText, { windowDays: 21 });
	ok(out.accepted.length === 2, `§7 expected both copies of OUR rate-con, got ${out.accepted.length}`);
	ok(out.accepted.every((a) => a.file.id !== "drv9"), "§7 LEAK: another load's rate-con was accepted");
	ok(out.unconfirmed.length === 0, "§7 nothing should be merely unconfirmed here");
	ok(out.scanned === 3, `§7 the unreadable file should be scanned-and-skipped, not fatal (scanned=${out.scanned})`);
	// Newest-first among equals, matching getRateConBytes()'s existing ordering.
	ok(out.accepted[0].file.id === "drv2", "§7 candidates are not ordered newest-first among equal scores");

	// A document that names our load but agrees with nothing about it: reported,
	// never attached. The load DOES carry corroborating facts (otherwise the scan
	// is skipped outright, see below) — they simply are not in this document.
	const lonely = await idx.pickRateConForLoad(LOAD, [FILE], async () => "LEG #: 30080873 and nothing else", {});
	ok(lonely.accepted.length === 0, "§7 LEAK: an uncorroborated match was accepted for attachment");
	ok(lonely.unconfirmed.length === 1, "§7 an uncorroborated match must still be surfaced to a human");

	// One corroboration is not enough — MIN_CORROBORATIONS is 2 because any single
	// signal coincides: two loads a month can share a rate, and a lane repeats a
	// pickup city for weeks.
	const oneOnly = await idx.pickRateConForLoad(
		LOAD, [FILE],
		async () => "LEG #: 30080873 Total Rate: $1,800.00",
		{},
	);
	ok(oneOnly.accepted.length === 0, "§7 LEAK: a SINGLE corroboration was enough to attach");
	ok(oneOnly.unconfirmed.length === 1, "§7 the single-signal match should still be surfaced");

	// A load with NOTHING to check a match against must not spend the downloads
	// at all — every result would be unconfirmed by construction.
	const blind = await idx.pickRateConForLoad(
		{ loadId: "30080873", totalRate: 0, brokerEmail: "", trailerNumber: "" },
		[FILE], async () => { throw new Error("must not be called"); }, {},
	);
	ok(blind.scanned === 0 && blind.skipped === "no-corroborating-facts",
		"§7 a load with no corroborating facts still spent Drive downloads");

	// A readText that always throws must yield nothing, not crash.
	const dead = await idx.pickRateConForLoad(LOAD, [FILE, REPLY], async () => { throw new Error("drive down"); }, {});
	ok(dead.accepted.length === 0 && dead.scanned === 0, "§7 a total read failure must degrade to no match");

	// ------------------------------------- §8 the scan is batched and stops early
	// A sequential 40-file scan measured 137 s against the live folder, on a
	// route whose client gives up at 60 s. Two properties keep it inside that:
	// downloads overlap, and the scan stops once a batch adds nothing new.
	{
		const near = Array.from({ length: 30 }, (_, i) => ({
			id: `n${i}`, name: `file ${i}`,
			createdTime: new Date(Date.parse("2026-08-18") - i * 3600000).toISOString(),
		}));
		// Only the first two files are ours.
		const textFor = (f) => (f.id === "n0" || f.id === "n1"
			? RATECON_TEXT
			: "unrelated load 99887766 total $99.00");

		let inFlight = 0, peak = 0, reads = 0;
		const readText = async (f) => {
			inFlight++; peak = Math.max(peak, inFlight); reads++;
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return textFor(f);
		};
		const out = await idx.pickRateConForLoad(LOAD, near, readText, { concurrency: 6, maxFiles: 40 });
		ok(out.accepted.length === 2, `§8 both of our files should still be found (got ${out.accepted.length})`);
		ok(peak > 1, "§8 downloads ran strictly one at a time — the 137 s regression is back");
		ok(peak <= 6, `§8 concurrency exceeded the requested limit (peak ${peak})`);
		// 6 (the batch with both matches) + 6 + 6 = 18 before the second empty batch
		// trips the stop. Not 12: one empty batch is deliberately NOT enough — see
		// the gap case below for what that bought.
		ok(reads <= 18, `§8 the scan did not stop early: read ${reads} of 30 files after the matches were already in hand`);
	}
	{
		// ⚠️ THE CASE ONE EMPTY BATCH LOST. Two legitimate copies of the same
		// rate-con at sorted positions 0 and 12 — the original and its signed
		// counterpart — with an empty batch between them. Stopping after a single
		// barren batch ended the scan at 12 reads and dropped the second file,
		// which costs the alternate-candidate recipient recovery its input and
		// leaves that file's subject number un-aliased for reconcile.
		const files = Array.from({ length: 20 }, (_, i) => ({
			id: `g${i}`, name: `file ${i}`,
			createdTime: new Date(Date.parse("2026-08-18") - i * 3600000).toISOString(),
		}));
		const out = await idx.pickRateConForLoad(
			LOAD, files,
			async (f) => (f.id === "g0" || f.id === "g12" ? RATECON_TEXT : "unrelated 99887766"),
			{ concurrency: 6, maxFiles: 40 },
		);
		ok(out.accepted.length === 2, `§8 the second copy across a barren batch was dropped (got ${out.accepted.length})`);
		ok(out.accepted.some((a) => a.file.id === "g12"), "§8 specifically, the far copy g12 was lost");
	}
	{
		// The other half of the rule: when NOTHING has matched, keep going to the
		// cap. Stopping early there would abandon the search before reaching the
		// file we came for.
		const many = Array.from({ length: 25 }, (_, i) => ({
			id: `m${i}`, name: `file ${i}`,
			createdTime: new Date(Date.parse("2026-08-18") - i * 3600000).toISOString(),
		}));
		let reads = 0;
		const out = await idx.pickRateConForLoad(
			LOAD, many,
			async (f) => { reads++; return f.id === "m20" ? RATECON_TEXT : "nothing here"; },
			{ concurrency: 6, maxFiles: 40 },
		);
		ok(out.accepted.length === 1, "§8 a match late in the window was abandoned by the early stop");
		ok(reads >= 21, `§8 the scan gave up before reaching the only matching file (read ${reads})`);
	}

	// ---------------- §9 THROUGH THE REAL EXTRACTOR — the gap that hid a leak
	//
	// Every § above this point feeds scoreRateConMatch hand-written strings. The
	// route does not: it feeds it brokerInvoice.extractPdfText() output, and that
	// function harvests each `(...)` literal and SPACE-JOINS them. PDF kerning
	// splits numbers across literals routinely — real files in this corpus
	// extract with runs like "2216467 0", "54406 1", "3575 7" — so a longer
	// number arrives pre-fractured and a pure boundary test reports a hit for a
	// load the document never mentioned. That is a mailed data leak, and it
	// passed 47 green assertions because none of them went through the extractor.
	{
		// The document's only number is 300808731. NOT our load 30080873.
		const fractured = textOf(
			"BT [(Order # )-2(30080873)-140(1)] TJ (Total Rate: $1,800.00) Tj " +
			"(AMES IA and GRAND PRAIRIE TX) Tj (tholmes@bisontransport.com) Tj ET",
		);
		ok(/30080873 1/.test(fractured),
			"§9 CONTROL: the extractor no longer fractures kerned digits — if this fails, re-derive the guard rather than deleting it");
		ok(!idx.textHasToken(fractured, "30080873"),
			"§9 LEAK: a kerned 300808731 was read as our load 30080873");
		const v = idx.scoreRateConMatch(LOAD, fractured, { id: "x", name: "Subject: someone else" });
		ok(v.idHit === false, "§9 LEAK: the fractured document matched through the scorer");
		ok(v.corroborations === 0, "§9 LEAK: it even corroborated — every load-specific fact was present but the load was not");
	}
	{
		// And the true document must still survive the same path. Our id is the
		// LEG #, flanked by letters, exactly as Bison prints it.
		const real = textOf(
			"BT (Billing Information: Order #: 7101850 LEG #: 30080873 PO #: 2795482) Tj " +
			"(Total Rate: $1,800.00) Tj (AMES, IA 50010) Tj (GRAND PRAIRIE, TX 75050) Tj ET",
		);
		ok(idx.textHasToken(real, "30080873"), "§9 the REAL document stopped matching — the fracture guard is too strict");
		const v = idx.scoreRateConMatch(LOAD, real, FILE);
		ok(v.idHit && v.corroborations >= idx.MIN_CORROBORATIONS,
			`§9 the REAL document would no longer be attached (corroborations=${v.corroborations})`);
	}

	// ------------------------------------------ §10 aliases must not blind us
	// An alias permanently suppresses a reconcileRateCons() gap alert, so a wrong
	// one is a monitoring hole with no expiry.
	{
		const t = idx.subjectRefTokens("Subject: FW: Rate Confirmation 7101850 - AMES IA 50010 - PU 20260818");
		ok(t.includes("7101850"), "§10 the real reference was not recorded as an alias");
		ok(!t.includes("50010"), "§10 LEAK: a 5-digit ZIP was recorded as a load alias");
		ok(!t.includes("20260818"), "§10 LEAK: a YYYYMMDD date was recorded as a load alias");
		ok(idx.MIN_ALIAS_LEN >= 7, "§10 the alias floor dropped back to zip-code length");
	}

	// -------------------------- §11 one definition of "the name carries our id"
	// There were three, and they disagreed: a punctuated id is a MISS for the
	// Drive lookup (which strips punctuation and substring-matches) and a HIT for
	// whole-token matching — so the backfill skipped exactly the loads the lookup
	// could not find.
	{
		// A clean numeric id behaves the obvious way.
		ok(idx.filenameCarriesLoadId("Subject: Booked Load #: 563367203", "563367203") === true,
			"§11 the predicate stopped matching an ordinary file name");
		// A PUNCTUATED id does not — the id is stripped to "LDMP4W4LP1" while the
		// name keeps its hyphen, so "LD-MP4W4LP1.pdf" is a miss. That is not a
		// wart to paper over: it is exactly what the Drive query itself does
		// (`name contains 'LDMP4W4LP1'`), and the backfill MUST agree with it.
		// When they disagreed, the backfill treated such loads as already-linked
		// and skipped the very loads the lookup cannot find. Reporting the miss
		// honestly sends them to the by-content scan, which reads them instead.
		ok(idx.filenameCarriesLoadId("LD-MP4W4LP1.pdf", "LD-MP4W4LP1") === false,
			"§11 the predicate diverged from the Drive query it has to mirror");
		ok(idx.filenameCarriesLoadId("Subject: Bison Transport Order #7101850", "30080873") === false,
			"§11 the predicate claims the incident file carries our load id, which is the whole bug");
		ok(idx.safeIdToken("#LD-MP4W4LP1") === "LDMP4W4LP1", "§11 id sanitisation drifted from the Drive query's");
	}

	// ------------------------------------------------------------------ report
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
})();
