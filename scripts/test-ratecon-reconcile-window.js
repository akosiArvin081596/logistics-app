#!/usr/bin/env node
// Locks the two blind spots closed in lib/ratecon-reconcile.js on 2026-08-11:
//
//   1. the sweep window could not see a gap discovered later than its own
//      fixed lookback (how load 556354570 survived eight weeks), and
//   2. findMissingLoads read the SUBJECT ONLY, so a rate con that names its
//      load in the attachment filename or the body was invisible.
//
// Every assertion here is written to FAIL against the pre-fix module — either
// because the export did not exist, or because the old behaviour is asserted
// against directly (see the MUTANTS section, which re-implements the old rules
// and requires that they fail).
//
// Pure: no network, no database, no mailbox. Run it anywhere.
//
//   node scripts/test-ratecon-reconcile-window.js
"use strict";

const R = require("../lib/ratecon-reconcile.js");

// Run against a PRE-FIX build and every capability assertion below should fail
// on its merits — not crash on the first missing export and hide the other 130.
// These inert stubs are what make "this suite fails against origin/main" a
// countable claim instead of a stack trace.
const STUBS = {
	resolveSweepWindow: () => ({}),
	extractLoadNumbersFromFilenames: () => [],
	extractLoadNumbersFromBody: () => [],
	extractMessageLoadNumbers: () => [],
	needsBodyScan: () => undefined,
	planReconcileAlert: () => ({}),
	parseFetchResponse: () => [],
	attachmentNamesFromBodyStructure: () => [],
	decodeMimeText: () => "<<stub>>",
	createImapReader: () => ({ push() {}, expect: () => new Promise(() => {}), expectGreeting: () => new Promise(() => {}) }),
};
const missingExports = [];
for (const [k, stub] of Object.entries(STUBS)) {
	if (typeof R[k] !== "function") { missingExports.push(k); R[k] = stub; }
}

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
	if (cond) { pass++; return true; }
	fail++;
	failures.push(label + (extra ? "  --> " + extra : ""));
	return false;
}
const eq = (a, b, label) => ok(a === b, label, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const deep = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
function section(name) { console.log("\n" + name); }

const DAY = 86400000;
const NOW = Date.parse("2026-08-11T12:00:00Z");

// ===========================================================================
section("1. resolveSweepWindow — the high-water mark");
// ===========================================================================
ok(typeof R.resolveSweepWindow === "function", "resolveSweepWindow is exported");

{
	// FIRST RUN EVER: no deep sweep on record -> a deep sweep, not a 14-day peek.
	const w = R.resolveSweepWindow({ now: NOW, lastSweepAt: null, lastDeepSweepAt: null });
	eq(w.deep, true, "1.1 first run is a deep sweep");
	eq(w.reason, "first-deep", "1.2 first run reason");
	eq(w.sinceDays, 365, "1.3 first run reads a year, not 14 days");
}
{
	// THE CORE PROPERTY. A gap that arrived 45 days ago is unreachable under a
	// fixed 14-day lookback no matter how often the sweep runs. Under the
	// high-water mark it is reachable as soon as a sweep is missed, and the deep
	// sweep reaches it unconditionally.
	const w = R.resolveSweepWindow({
		now: NOW,
		lastSweepAt: NOW - 40 * DAY,
		lastDeepSweepAt: NOW - 2 * DAY,
	});
	eq(w.deep, false, "1.4 recent deep sweep -> incremental");
	eq(w.reason, "high-water", "1.5 incremental reason");
	ok(w.sinceDays >= 40, "1.6 a 40-day sweep outage produces a >=40-day window", "got " + w.sinceDays);
	ok(w.sinceDays <= 42, "1.7 ...and not wildly more than that", "got " + w.sinceDays);
}
{
	// It can only ever WIDEN: a sweep 10 minutes after the last one still reads
	// the 14-day floor, so this is a strict superset of the shipped behaviour.
	const w = R.resolveSweepWindow({ now: NOW, lastSweepAt: NOW - 600000, lastDeepSweepAt: NOW - DAY });
	eq(w.sinceDays, 14, "1.8 a fresh sweep still reads the 14-day floor (never narrows)");
}
{
	const w = R.resolveSweepWindow({ now: NOW, lastSweepAt: NOW - 5000 * DAY, lastDeepSweepAt: NOW - DAY });
	eq(w.sinceDays, 400, "1.9 an absurd gap is capped at maxDays");
	ok(400 > 60, "1.10 the cap is raised above the old 60-day ceiling");
}
{
	const w = R.resolveSweepWindow({ now: NOW, lastSweepAt: NOW - DAY, lastDeepSweepAt: NOW - 8 * DAY });
	eq(w.deep, true, "1.11 a deep sweep falls due after deepEveryHours");
	eq(w.reason, "deep-due", "1.12 deep-due reason");
}
{
	// Clock skew / restored snapshot: a high-water mark in the FUTURE must not
	// produce a negative or zero window. Failing to the floor = today's behaviour.
	const w = R.resolveSweepWindow({ now: NOW, lastSweepAt: NOW + 10 * DAY, lastDeepSweepAt: NOW - DAY });
	eq(w.sinceDays, 14, "1.13 a future high-water mark falls back to the floor");
	eq(w.reason, "no-high-water", "1.14 ...and says so");
}
{
	const w = R.resolveSweepWindow({ now: NOW, lastSweepAt: "not a date", lastDeepSweepAt: NOW - DAY });
	eq(w.sinceDays, 14, "1.15 an unparseable high-water mark falls back to the floor");
}
{
	const w = R.resolveSweepWindow({ now: NOW, lastSweepAt: new Date(NOW - 30 * DAY), lastDeepSweepAt: new Date(NOW - DAY) });
	ok(w.sinceDays >= 30, "1.16 Date objects are accepted", "got " + w.sinceDays);
	const w2 = R.resolveSweepWindow({ now: NOW, lastSweepAt: new Date(NOW - 30 * DAY).toISOString(), lastDeepSweepAt: new Date(NOW - DAY).toISOString() });
	eq(w2.sinceDays, w.sinceDays, "1.17 ISO strings agree with Date objects");
}
{
	const w = R.resolveSweepWindow({ now: NOW, lastSweepAt: NOW - 20 * DAY, lastDeepSweepAt: NOW - DAY, floorDays: 30 });
	eq(w.sinceDays, 30, "1.18 floorDays is honoured over a shorter elapsed window");
	const w2 = R.resolveSweepWindow({ now: NOW, lastSweepAt: NOW - 100 * DAY, lastDeepSweepAt: NOW - DAY, maxDays: 45 });
	eq(w2.sinceDays, 45, "1.19 maxDays clamps the incremental window");
	const w3 = R.resolveSweepWindow({ now: NOW, lastDeepSweepAt: null, deepDays: 900, maxDays: 400 });
	eq(w3.sinceDays, 400, "1.20 deepDays cannot exceed maxDays");
}
{
	// ⚠️ MUTANT M1 — the shipped 14-day constant. If a "fixed lookback" were
	// still in place this assertion would hold; it must not.
	const fixed14 = () => 14;
	const w = R.resolveSweepWindow({ now: NOW, lastSweepAt: NOW - 60 * DAY, lastDeepSweepAt: NOW - DAY });
	ok(w.sinceDays !== fixed14(), "1.21 MUTANT: a fixed 14-day lookback is dead", "window collapsed back to 14");
	// ⚠️ MUTANT M2 — the shipped 60-day cap.
	const capped60 = Math.max(1, Math.min(60, 365));
	const deepW = R.resolveSweepWindow({ now: NOW, lastDeepSweepAt: null });
	ok(deepW.sinceDays > capped60, "1.22 MUTANT: the 60-day ceiling is raised", "still <= 60");
}

// ===========================================================================
section("2. extractLoadNumbersFromFilenames — named after the load, not merely numeric");
// ===========================================================================
ok(typeof R.extractLoadNumbersFromFilenames === "function", "extractLoadNumbersFromFilenames is exported");

// Real filenames, verbatim from the production RATECONs label.
deep(R.extractLoadNumbersFromFilenames(["406323434.pdf"]), ["406323434"],
	"2.1 a bare <loadid>.pdf is the whole point");
deep(R.extractLoadNumbersFromFilenames(["RateCon_562324759.pdf"]), ["562324759"],
	"2.2 RateCon_<id>.pdf");
deep(R.extractLoadNumbersFromFilenames(["562324759-RateConfirmation.pdf"]), ["562324759"],
	"2.3 <id>-RateConfirmation.pdf");
deep(R.extractLoadNumbersFromFilenames(["Carrier Confirmation 563367203.pdf"]), ["563367203"],
	"2.4 Carrier Confirmation <id>.pdf");

// ⚠️ These are the measured false positives a contains-digits rule pulls. The
// first is verbatim from the label and is the whole argument for the stem rule:
// it is a signed W-9 riding on a carrier-ONBOARDING email from highway.com
// ("You are now connected with CH Robinson"), a message that is not a rate con
// at all — and the digits it offers are IRS form ids.
deep(R.extractLoadNumbersFromFilenames(
	["Executed Tax Form - Form W-9 (Rev. March 2024) - 04-16-2025 (4845614-4698012).pdf"]), [],
	"2.5 a signed W-9 on a carrier-onboarding email is NOT a load");
deep(R.extractLoadNumbersFromFilenames(["CH Robinson & LOGISTICS EXCHANGE INC Executed Contract 2025-04-16.pdf"]), [],
	"2.5b an executed-contract PDF is NOT a load");
deep(R.extractLoadNumbersFromFilenames(["Pickup Report - 233395341.pdf"]), [],
	"2.6 a Steam pickup report is NOT a rate con");
deep(R.extractLoadNumbersFromFilenames(["doc1021273951.pdf"]), [],
	"2.7 Gmail's own doc<digits> attachment id is NOT a load");
deep(R.extractLoadNumbersFromFilenames(["doc1020658902.pdf", "doc1025303474.pdf"]), [],
	"2.8 ...for every doc<digits> in the corpus");
deep(R.extractLoadNumbersFromFilenames(["S1028835-RateConfirmation.pdf"]), [],
	"2.9 a non-numeric broker ref does not become a load number");
deep(R.extractLoadNumbersFromFilenames(["Convoy_nia_734660_rate_confirmation.pdf"]), [],
	"2.10 an embedded ref with word-char neighbours never reaches \\b\\d{6,12}\\b");
deep(R.extractLoadNumbersFromFilenames(["Signature-GetYourELD.png", "logo.png"]), [],
	"2.11 non-PDF attachments are ignored outright");
deep(R.extractLoadNumbersFromFilenames(["562324759.docx"]), [],
	"2.12 ...including a correctly-named non-PDF");
deep(R.extractLoadNumbersFromFilenames(["20250416.pdf"]), [],
	"2.13 an implausible number (YYYYMMDD) is still refused here");
deep(R.extractLoadNumbersFromFilenames(["563367203.pdf", "563367203.PDF"]), ["563367203"],
	"2.14 duplicates collapse, extension case-insensitive");
deep(R.extractLoadNumbersFromFilenames(null), [], "2.15 null attachment list is safe");
{
	// ⚠️ MUTANT M3 — the naive "any digits in any filename" rule. It must
	// disagree with the shipped one on the real onboarding attachment.
	const naive = (names) => [...new Set((names || []).flatMap(
		(f) => [...String(f).matchAll(/\b\d{6,12}\b/g)].map((m) => m[0])))];
	const bad = ["Executed Tax Form - Form W-9 (Rev. March 2024) - 04-16-2025 (4845614-4698012).pdf"];
	deep(naive(bad), ["4845614", "4698012"], "2.16 MUTANT: the naive rule really does fire here");
	eq(R.extractLoadNumbersFromFilenames(bad).length, 0, "2.17 MUTANT: the shipped rule refuses it");
	// ...while still admitting the shape that actually dominates the label: 309
	// of the distinct attachment names in the corpus are bare <loadid>.pdf.
	deep(R.extractLoadNumbersFromFilenames(["513987502.pdf", "515076025.pdf"]), ["513987502", "515076025"],
		"2.18 the dominant real shape is still admitted");
}

// ===========================================================================
section("3. extractLoadNumbersFromBody — anchored on LOAD and nothing else");
// ===========================================================================
ok(typeof R.extractLoadNumbersFromBody === "function", "extractLoadNumbersFromBody is exported");

deep(R.extractLoadNumbersFromBody("Load #511136303"), ["511136303"], "3.1 Load #<id>");
deep(R.extractLoadNumbersFromBody("Load Number: 515762498"), ["515762498"], "3.2 Load Number: <id>");
deep(R.extractLoadNumbersFromBody("Navisphere Carrier Load Confirmation - Load 356990988"), ["356990988"], "3.3 prose form");
deep(R.extractLoadNumbersFromBody("LOAD ID 563367203"), ["563367203"], "3.4 LOAD ID <id>, case-insensitive");
deep(R.extractLoadNumbersFromBody("Booked Load #: 563593554"), ["563593554"], "3.5 Booked Load #: <id>");

// ⚠️ Every one of these is a MEASURED false positive of a wider anchor set.
deep(R.extractLoadNumbersFromBody("CONVOY ID: CHE-205966 REFERENCE ID: 3682042422 PAYOUT"), [],
	"3.6 REFERENCE ID is not a load (0 of 4 correct, measured)");
deep(R.extractLoadNumbersFromBody("RYAN GRAY, 90923050780000 BOL #: 32473287"), [],
	"3.7 BOL # is not a load (0 of 1)");
deep(R.extractLoadNumbersFromBody("PICK-UP# /BOOKING# 8675309, AFTER HOURS# 866-229-6300"), [],
	"3.8 BOOKING# is not a load (0 of 2)");
deep(R.extractLoadNumbersFromBody("minutes left before expiration. Confirmation Number: 736597"), [],
	"3.9 a web-session Confirmation Number is not a load (0 of 1)");
deep(R.extractLoadNumbersFromBody("*NOTES:* *Order #: 0081100815, PO: 6618446422*"), [],
	"3.10 a customer Order #/PO is not a load — the exact class that produced 2787514");
deep(R.extractLoadNumbersFromBody("Pick Up#: 22090839; 22090773; 22090616"), [],
	"3.11 pick-up numbers are not loads");
deep(R.extractLoadNumbersFromBody("DALLAS, TX 752331402 Pick Up Time"), [],
	"3.12 a ZIP+4 is not a load");
deep(R.extractLoadNumbersFromBody("Trailer #: 808331"), [], "3.13 a trailer number is not a load");
deep(R.extractLoadNumbersFromBody("http://mailtrack.convoy.com/track/click/30613466/api.convoy.com"), [],
	"3.14 an id scraped out of a tracking URL is not a load");
deep(R.extractLoadNumbersFromBody("download 562324759 now"), [],
	"3.15 'download' must not anchor — \\bload\\b is a word-boundary match");
deep(R.extractLoadNumbersFromBody("payload 562324759"), [], "3.16 'payload' must not anchor");
deep(R.extractLoadNumbersFromBody("Overload 562324759"), [], "3.17 'Overload' must not anchor");
deep(R.extractLoadNumbersFromBody("Load 5633672039999"), [],
	"3.18 a 13-digit run is refused, not truncated to 12");
deep(R.extractLoadNumbersFromBody("Load 20250416"), [], "3.19 implausible numbers still refused");
deep(R.extractLoadNumbersFromBody("Load #563367203 and Load #563367203"), ["563367203"], "3.20 duplicates collapse");
deep(R.extractLoadNumbersFromBody(""), [], "3.21 empty body is safe");
deep(R.extractLoadNumbersFromBody(null), [], "3.22 null body is safe");
{
	const big = "x".repeat(500000) + " Load #563367203";
	const t0 = Date.now();
	R.extractLoadNumbersFromBody(big);
	ok(Date.now() - t0 < 1000, "3.23 a huge body cannot block the event loop", (Date.now() - t0) + "ms");
}
{
	// ⚠️ MUTANT M4 — the unanchored body scan. 67.4% precision, measured.
	const naive = (s) => [...new Set([...String(s).matchAll(/\b\d{6,12}\b/g)].map((m) => m[0]))];
	const junk = "DALLAS, TX 752331402 Pick Up#: 22090839; 22090773";
	ok(naive(junk).length >= 3, "3.24 MUTANT: the unanchored scan really does fire here");
	eq(R.extractLoadNumbersFromBody(junk).length, 0, "3.25 MUTANT: the shipped rule refuses all of it");
}

// ===========================================================================
section("4. extractMessageLoadNumbers — the staging IS the safety");
// ===========================================================================
ok(typeof R.extractMessageLoadNumbers === "function", "extractMessageLoadNumbers is exported");

{
	// A subject hit STOPS the pipeline. This is what stops the 675 messages the
	// subject already answers from acquiring new false positives out of their
	// own quoted reply chains.
	const em = {
		subject: "Booked Load #: 563367203",
		attachmentNames: ["Pickup Report - 233395341.pdf"],
		bodyText: "Load #999999999 quoted from an older thread",
	};
	deep(R.extractMessageLoadNumbers(em), [{ loadNumber: "563367203", via: "subject" }],
		"4.1 subject wins outright — filename and body are never consulted");
}
{
	const em = { subject: "Booked load", attachmentNames: ["406323434.pdf"], bodyText: "Load #999999999" };
	deep(R.extractMessageLoadNumbers(em), [{ loadNumber: "406323434", via: "filename" }],
		"4.2 filename runs only when the subject is silent, and then stops the body");
}
{
	// ⚠️ THE CASE THAT PROVES THE STAGING EARNS ITS KEEP, verbatim from the label.
	// Trident's subject names the real load (1118122 — a row that exists in
	// production's alert table today), but its attachment is named after an
	// INTERNAL document number. An unstaged filename scan mints "734365", a
	// phantom load no sheet will ever contain, so the alert row sits open
	// forever. Measured: this is the single candidate the staging refuses across
	// all 745 messages.
	const em = { subject: "Trident Transport, LLC Rate Confirmation for order: 1118122",
		attachmentNames: ["734365_Confirmation.pdf"] };
	deep(R.extractMessageLoadNumbers(em), [{ loadNumber: "1118122", via: "subject" }],
		"4.2b the subject's load wins over an internal doc number in the filename");
	deep(R.extractLoadNumbersFromFilenames(em.attachmentNames), ["734365"],
		"4.2c ...and the filename rule alone WOULD have produced the phantom");
}
{
	const em = { subject: "Ratecon", attachmentNames: ["Convoy_nia_734660_rate_confirmation.pdf"], bodyText: "Load #563367203" };
	deep(R.extractMessageLoadNumbers(em), [{ loadNumber: "563367203", via: "body" }],
		"4.3 body runs only when subject AND filename are silent");
}
{
	const em = { subject: "Routemate Order form", attachmentNames: ["Signature-GetYourELD.png"], bodyText: "no numbers here" };
	deep(R.extractMessageLoadNumbers(em), [], "4.4 a non-rate-con message yields nothing at any stage");
}
{
	const em = { subject: "Booked load", attachmentNames: ["406323434.pdf"], bodyText: "Load #563367203" };
	deep(R.extractMessageLoadNumbers(em, { scanFilenames: false }), [{ loadNumber: "563367203", via: "body" }],
		"4.5 scanFilenames:false skips the filename stage");
	deep(R.extractMessageLoadNumbers(em, { scanFilenames: false, scanBody: false }), [],
		"4.6 both off == the old subject-only behaviour");
}
{
	// needsBodyScan drives the phase-2 fetch set: it must be false wherever an
	// earlier stage already answered, or the sweep downloads bodies it will
	// never read.
	ok(R.needsBodyScan({ subject: "Ratecon", attachmentNames: [] }) === true, "4.7 silent message needs a body fetch");
	ok(R.needsBodyScan({ subject: "Booked Load #: 563367203" }) === false, "4.8 subject hit needs no body fetch");
	ok(R.needsBodyScan({ subject: "Booked load", attachmentNames: ["406323434.pdf"] }) === false, "4.9 filename hit needs no body fetch");
	ok(R.needsBodyScan({ subject: "Booked load", attachmentNames: ["406323434.pdf"] }, { scanFilenames: false }) === true,
		"4.10 ...unless filename scanning is off");
}

// ===========================================================================
section("5. findMissingLoads — still a strict superset of the old behaviour");
// ===========================================================================
{
	// The exact shape the old two-argument call site passes.
	const emails = [
		{ subject: "Booked Load #: 563367203", date: "Wed, 5 Aug 2026 08:19:23 -0500" },
		{ subject: "Booked Load #: 111111111", date: "Wed, 5 Aug 2026 09:00:00 -0500" },
	];
	const got = R.findMissingLoads(emails, ["#563367203", "999999999"]);
	eq(got.length, 1, "5.1 only the genuinely absent load is reported");
	eq(got[0]?.loadNumber, "111111111", "5.2 ...and it is the right one");
	eq(got[0]?.via, "subject", "5.3 provenance is recorded");
	ok(!!got[0] && "subject" in got[0] && "date" in got[0], "5.4 the old fields are still present");
}
{
	const emails = [{ subject: "Booked load", attachmentNames: ["406323434.pdf"], date: "x" }];
	eq(R.findMissingLoads(emails, []).length, 1, "5.5 a filename-only load is now visible");
	eq(R.findMissingLoads(emails, [])[0]?.via, "filename", "5.6 ...tagged as such");
	eq(R.findMissingLoads(emails, ["406323434"]).length, 0, "5.7 ...and suppressed once the sheet has it");
	eq(R.findMissingLoads(emails, [], { scanFilenames: false }).length, 0,
		"5.8 MUTANT: with the old subject-only rule it is invisible");
}
{
	// ⚠️ Archive membership. 12 of the 74 gaps a full-history sweep finds are
	// loads that reached the sheet and were later archived, so the caller must
	// be able to pass both id sets — a load in the archive is not a gap.
	const emails = [{ subject: "Navisphere Carrier Load Confirmation - Load 542438640", date: "x" }];
	eq(R.findMissingLoads(emails, []).length, 1, "5.9 absent from the live sheet -> a gap");
	eq(R.findMissingLoads(emails, ["542438640"]).length, 0, "5.10 present in the archived id set -> not a gap");
}
{
	const emails = [
		{ subject: "Booked Load #: 111111111", date: "a" },
		{ subject: "Fwd: Booked Load #: 111111111", date: "b" },
	];
	eq(R.findMissingLoads(emails, []).length, 1, "5.11 one entry per load number, not per message");
}

// ===========================================================================
section("6. planReconcileAlert — the first wide run must not read as a flood");
// ===========================================================================
ok(typeof R.planReconcileAlert === "function", "planReconcileAlert is exported");
{
	const many = Array.from({ length: 62 }, (_, i) => ({
		loadNumber: String(500000000 + i),
		subject: "Booked Load #: " + (500000000 + i),
		date: new Date(NOW - i * 3 * DAY).toUTCString(),
	}));
	const normal = R.planReconcileAlert(many, { baseline: false });
	eq(normal.kind, "normal", "6.1 an ordinary run is not a baseline");
	eq(normal.listed?.length, 62, "6.2 ...and lists everything");
	eq(normal.suppressedCount, 0, "6.3 ...suppressing nothing");

	const base = R.planReconcileAlert(many, { baseline: true, maxListed: 25 });
	eq(base.kind, "baseline", "6.4 the first deep sweep is a baseline");
	eq(base.listed?.length, 25, "6.5 ...with a bounded excerpt");
	eq(base.suppressedCount, 37, "6.6 ...and an honest count of the rest");
	eq(base.total, 62, "6.7 ...and the true total");
	eq(base.listed?.[0]?.loadNumber, "500000000", "6.8 newest first — the recoverable ones lead");
}
{
	const r = R.planReconcileAlert([], { baseline: true });
	eq(r.total, 0, "6.9 an empty baseline is empty");
	eq(r.listed?.length, 0, "6.10 ...and lists nothing");
}
{
	// Sorting must not mutate or drop entries with unparseable dates.
	const r = R.planReconcileAlert([{ loadNumber: "1", date: "nonsense" }, { loadNumber: "2", date: "" }], {});
	eq(r.total, 2, "6.11 unparseable dates survive the sort");
}

// ===========================================================================
section("7. IMAP wire format — literals are counted, never scanned");
// ===========================================================================
ok(typeof R.parseFetchResponse === "function", "parseFetchResponse is exported");
{
	const hdr = "Subject: Booked Load #: 563367203\r\nFrom: a@b.com\r\nDate: Wed, 5 Aug 2026 08:19:23 -0500\r\n\r\n";
	const buf = Buffer.from(
		`* 1 FETCH (BODY[HEADER.FIELDS (SUBJECT FROM DATE)] {${hdr.length}}\r\n${hdr})\r\na4 OK done\r\n`, "latin1");
	const parsed = R.parseFetchResponse(buf);
	eq(parsed.length, 1, "7.1 one message parsed");
	eq(parsed[0]?.seq, "1", "7.2 sequence number captured — phase 2 depends on it");
	ok(!!parsed[0]?.lits?.[0]?.toString().includes("563367203"), "7.3 the literal is preserved intact");
}
{
	// ⚠️ THE ADVERSARIAL CASE. A forwarded rate con quotes an earlier message,
	// so its BODY contains "Subject:"/"From:" lines — and any body may contain a
	// line that looks like a tagged completion or another FETCH. If literals were
	// scanned rather than counted, this forges a second message and steals the
	// headers of the first.
	const body = "Hi,\r\n* 2 FETCH (BODY[TEXT] {9}\r\nGOTCHA!!!)\r\na9 OK forged\r\n"
		+ "---------- Forwarded message ----------\r\nSubject: Booked Load #: 999999999\r\nFrom: evil@x.com\r\n";
	const hdr = "Subject: Ratecon\r\nFrom: broker@acme.com\r\nDate: Sun, 12 Apr 2026 13:43:00 -0500\r\n\r\n";
	const buf = Buffer.from(
		`* 1 FETCH (BODY[TEXT] {${body.length}}\r\n${body} BODY[HEADER.FIELDS (SUBJECT FROM DATE)] {${hdr.length}}\r\n${hdr})\r\na5 OK done\r\n`,
		"latin1");
	const parsed = R.parseFetchResponse(buf);
	eq(parsed.length, 1, "7.4 a body that forges '* 2 FETCH' does NOT become a second message");
	const h = parsed[0]?.chunk.match(/BODY\[HEADER\.FIELDS[^\]]*\](?:<\d+>)?\s*LIT(\d+)/i);
	ok(!!h, "7.5 the header literal is addressable by ITEM NAME, not position");
	ok(!!h && !!parsed[0]?.lits[+h[1]]?.toString().includes("Ratecon"),
		"7.6 ...and resolves to the real header even though the body came FIRST");
	ok(!!h && !parsed[0]?.lits[+h[1]]?.toString().includes("999999999"),
		"7.7 ...so the forwarded body's Subject: line cannot stand in for it");
}
{
	// The reader must not complete a command on a tagged line INSIDE a literal.
	const reader = R.createImapReader();
	const body = "a1 OK not really\r\n";
	let resolved = null;
	reader.expect(/^a1 (OK|NO|BAD)/).then((b) => { resolved = b; });
	reader.push(Buffer.from(`* 1 FETCH (BODY[TEXT] {${body.length}}\r\n${body})\r\n`, "latin1"));
	ok(resolved === null, "7.8 a tagged line inside a literal does not complete the command");
	reader.push(Buffer.from("a1 OK real\r\n", "latin1"));
	setTimeout(() => {
		ok(resolved !== null, "7.9 the REAL tagged line does complete it");
		finishUp();
	}, 0);
}
{
	deep(R.attachmentNamesFromBodyStructure('("NAME" "406323434.pdf")'), ["406323434.pdf"], "7.10 NAME parameter");
	deep(R.attachmentNamesFromBodyStructure('("FILENAME" "RateCon_1.pdf")'), ["RateCon_1.pdf"], "7.11 FILENAME parameter");
	deep(R.attachmentNamesFromBodyStructure('("NAME" "a.pdf") ("FILENAME" "a.pdf")'), ["a.pdf"], "7.12 duplicates collapse");
	deep(R.attachmentNamesFromBodyStructure(""), [], "7.13 empty BODYSTRUCTURE is safe");
	deep(R.attachmentNamesFromBodyStructure('("FILENAME" "quote\\"d.pdf")'), ['quote"d.pdf'], "7.14 escaped quotes survive");
}
{
	// Attachment BYTES must never be scanned: a PDF stream is full of digit runs.
	const mime = 'Content-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nMTIzNDU2Nzg5MDEy\r\n';
	eq(R.decodeMimeText(mime).trim(), "", "7.15 application/* parts are skipped entirely");
}

// ===========================================================================
section("8. the shipped safety properties are unchanged");
// ===========================================================================
{
	const src = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "ratecon-reconcile.js"), "utf8");
	ok(/EXAMINE/.test(src) && !/\bSELECT\s+"\s*\+/.test(src), "8.1 the mailbox is opened with EXAMINE");
	// ⚠️ Judge the COMMANDS WE SEND, not every occurrence of the token — the
	// response parser legitimately matches on `BODY[TEXT]` / `BODY[HEADER...`
	// because that is what the server writes back, and the comments describe both.
	// Only a double-quoted string inside fetchRateConSubjects becomes a command.
	const fetchFn = src.slice(src.indexOf("function fetchRateConSubjects"), src.indexOf("module.exports"));
	const noComments = fetchFn.replace(/^\s*\/\/.*$/gm, "");
	const cmdStrings = [...noComments.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((x) => /BODY/.test(x));
	ok(cmdStrings.length >= 2, "8.2a both fetch commands were located for inspection", JSON.stringify(cmdStrings));
	ok(cmdStrings.every((c) => !/BODY\[/.test(c)),
		"8.2 every FETCH command uses BODY.PEEK — a bare BODY[ would set \\Seen",
		JSON.stringify(cmdStrings));
	eq((src.match(/BODY\.PEEK/g) || []).length >= 2, true, "8.3 both fetch phases use BODY.PEEK");
	ok(!/\bSTORE\b|\bEXPUNGE\b|\bAPPEND\b|\bMOVE\b|\bCOPY\b/.test(src), "8.4 no STORE / EXPUNGE / APPEND / MOVE / COPY");
	ok(/\\Seen/.test(src), "8.5 the \\Seen hazard is still documented in-file");
}
{
	// The sender filter and the number rules are untouched by this change.
	eq(R.parseFromAddress('"billing <info@logisx.com>" <broker@acme.com>'), "broker@acme.com",
		"8.6 last angle-addr wins — a forged display name cannot suppress a real rate con");
	eq(R.isSelfSent({ fromAddress: "info@logisx.com" }, "info@logisx.com"), true, "8.7 self-sent detection");
	eq(R.isSelfSent({ fromAddress: "broker@acme.com" }, "info@logisx.com"), false, "8.8 inbound kept");
	eq(R.isSelfSent({ fromAddress: "broker@acme.com" }, ""), false, "8.9 unset GMAIL_USER filters nothing");
	deep(R.extractLoadNumbers("Steam Logistics Order #2214407"), ["2214407"], "8.10 7-digit ids still match");
	deep(R.extractLoadNumbers("Bison Transport Order #7086762"), ["7086762"], "8.11 ...for every broker");
	eq(R.isImplausibleLoadNumber("2026"), true, "8.12 a bare year is still refused");
	eq(R.isImplausibleLoadNumber("2787514"), false, "8.13 ⚠️ the PO is NOT range-refused — sender is the only discriminator");
}

// ===========================================================================
section("9. hostile input — the 2026-08-11 security review findings");
// ===========================================================================
// ⚠️ ALL OF THIS IS ATTACKER-INFLUENCED. Anyone who can get mail into the label
// controls the subject, the From header, the attachment filenames, the
// BODYSTRUCTURE and the body bytes. server.js is ONE Express process, so a
// blocked event loop here also stops the dashboard, the driver app, the public
// tracker, the n8n callbacks and the Linxup GPS webhook — i.e. a slow regex in
// the detector causes a worse outage than the one it detects.
{
	// C1 — ReDoS. The first draft used three unbounded [\s]* runs separated by
	// optional tokens; measured cubic: 160 spaces 59 ms, 640 1.2 s, 1000 5.6 s,
	// 1500 16 s. At the 16 KB body-fetch cap that extrapolates to hours.
	// ⚠️ Sizes chosen so this REPORTS against pre-fix code rather than appearing
	// to hang. At the pre-fix cubic cost 1,500 spaces was ~3.5 s (a clean
	// failure) but 4,000 would be ~70 s and 20,000 about two hours — a suite that
	// hangs teaches people to skip it. 1,500 is the load-bearing size; the larger
	// ones are guarded by a wall-clock budget that trips long before that.
	for (const n of [1500, 4000, 20000]) {
		const t0 = Date.now();
		R.extractLoadNumbersFromBody("Load" + " ".repeat(n) + "x");
		const ms = Date.now() - t0;
		ok(ms < 250, `9.1/${n} a ${n}-space run after the anchor stays linear`, ms + "ms");
		if (ms > 2000) { failures.push("9.1 aborted the larger sizes — pre-fix cost detected"); break; }
	}
}
{
	// C1's ACCIDENTAL trigger — no attacker needed. decodeMimeText replaces every
	// HTML tag with a space, so ordinary broker markup BECOMES the whitespace
	// run. Measured against the pre-fix regex, a 7.2 KB / 400-tag email blocked
	// the loop for 28 SECONDS.
	for (const tags of [200, 400, 1200]) {
		const html = "Content-Type: text/html\r\n\r\n<td>Load</td>" + "<tr><td></td></tr>".repeat(tags) + "<b>x</b>";
		const t0 = Date.now();
		R.extractLoadNumbersFromBody(R.decodeMimeText(html));
		const ms = Date.now() - t0;
		ok(ms < 400, `9.2/${tags} an ordinary ${tags}-tag HTML email does not stall the loop`, ms + "ms");
	}
}
{
	// Collapsing whitespace must not cost recall — it gains a little, because
	// HTML-stripped mail routinely separates the label from its number.
	deep(R.extractLoadNumbersFromBody("Load\r\n   Number:\r\n   563367203"), ["563367203"],
		"9.3 a newline between the anchor and the number still matches");
	deep(R.extractLoadNumbersFromBody(R.decodeMimeText("Content-Type: text/html\r\n\r\n<p>Load #</p><p>563367203</p>")),
		["563367203"], "9.4 ...including across stripped HTML tags");
	deep(R.extractLoadNumbersFromBody("download 562324759"), [], "9.5 ...and 'download' still does not anchor");
}
{
	// M3 — quadratic rescan on an unterminated <style>/<script>: 2.6 s at 24 KB,
	// times up to maxBodyFetch messages per sweep.
	// The case that actually reaches production: a 16 KB fetch prefix that is
	// almost entirely markup. Measured 11.8 s before this pass, 1.4 ms after.
	{
		const html = "Content-Type: text/html\r\n\r\n<td>Load</td>" + "<tr><td>x</td></tr>".repeat(860);
		const t0 = Date.now();
		R.extractLoadNumbersFromBody(R.decodeMimeText(html));
		const ms = Date.now() - t0;
		ok(ms < 150, `9.6 a realistic all-markup 16KB body decodes and scans fast`, ms + "ms");
	}
	// The adversarial shape, at and beyond the input cap. Bounded, not fast —
	// the point is that it cannot grow without limit.
	for (const kb of [12, 256]) {
		const body = "Content-Type: text/html\r\n\r\n" + "<style".repeat(Math.floor(kb * 1024 / 6));
		const t0 = Date.now();
		R.decodeMimeText(body);
		const ms = Date.now() - t0;
		ok(ms < 2000, `9.6b/${kb} an unterminated <style> at ${kb}KB stays bounded`, ms + "ms");
	}
	{
		const src2 = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "ratecon-reconcile.js"), "utf8");
		ok(/MAX_MIME_TEXT_BYTES/.test(src2), "9.6c decodeMimeText caps its own input length");
		// ⚠️ The previous form of this assertion tested for `<[^>]+>` — with a PLUS
		// — while the idiom actually used was `<[^>]*>` with a STAR. It passed
		// pre-fix, passes post-fix, and would still pass if someone restored the
		// exact mutant it named. Assert the positive property instead: the strip
		// is a linear scan and NO regex form of it survives.
		ok(/function stripHtmlTags/.test(src2), "9.6d the tag strip is a linear scan");
		// ⚠️ Judge CODE, not prose. The comments above stripHtmlTags name all three
		// retired regex forms on purpose — that is the record of why they are
		// gone — so a naive grep matches the explanation and fails forever.
		const code2 = src2.replace(/^\s*\/\/.*$/gm, "");
		ok(!/<\[\^>\]\*>/.test(code2) && !/<\[\^>\]\+>/.test(code2) && !/<\[\^>\]\{1,\d+\}>/.test(code2),
			"9.6e MUTANT: no regex tag strip survives in code, bounded or not");
	}
	ok(!/<style/i.test(R.decodeMimeText("Content-Type: text/html\r\n\r\n<style>a{}</style>Load #563367203")),
		"9.7 a well-formed <style> block is still removed");
}
{
	// M1 — BODYSTRUCTURE is inline PROTOCOL text, not a literal, so an attachment
	// FILENAME can contain "* 9 FETCH". Lifting literals does not stop that; the
	// line anchor does. Unfixed, ONE server message parsed as THREE and the
	// survivor carried an ATTACKER-CHOSEN sequence number — which then keys bySeq
	// and the phase-2 body fetch, evicting an innocent broker's message from the
	// body-scan set and silencing exactly the stage this change adds.
	const hdr = "Subject: Ratecon\r\nFrom: evil@x.com\r\nDate: Sun, 12 Apr 2026 13:43:00 -0500\r\n\r\n";
	const bs = '(BODYSTRUCTURE (("APPLICATION" "PDF" ("NAME" "* 9 FETCH ratecon.pdf") NIL NIL "BASE64" 100) "MIXED")';
	const buf = Buffer.from(
		`* 1 FETCH ${bs} BODY[HEADER.FIELDS (SUBJECT FROM DATE)] {${hdr.length}}\r\n${hdr})\r\na5 OK done\r\n`, "latin1");
	const parsed = R.parseFetchResponse(buf);
	eq(parsed.length, 1, "9.8 an attachment named '* 9 FETCH …' does NOT split one message into three");
	eq(parsed[0]?.seq, "1", "9.9 ...and the sequence number stays the server's, not the sender's");
}
{
	// M2 — U+0001 is a legal TEXT-CHAR in an IMAP quoted string, so the LIT
	// sentinel was forgeable from a filename. `lits` is ONE array shared by every
	// message in the batch, so a forged index reaches ACROSS messages: unfixed,
	// message 2 resolved to message 1's header literal and message 2's real load
	// number silently never reached findMissingLoads.
	const SENT = "";
	const h1 = "Subject: Booked Load #: 111111111\r\nFrom: a@b.com\r\nDate: x\r\n\r\n";
	const h2 = "Subject: Booked Load #: 222222222\r\nFrom: c@d.com\r\nDate: y\r\n\r\n";
	const evilName = "BODY[HEADER.FIELDS ]" + SENT + "LIT0" + SENT + "x.pdf";
	const evil = `(BODYSTRUCTURE (("APPLICATION" "PDF" ("NAME" "${evilName}") NIL NIL "BASE64" 9) "MIXED")`;
	const buf = Buffer.from(
		`* 1 FETCH (BODY[HEADER.FIELDS (SUBJECT FROM DATE)] {${h1.length}}\r\n${h1})\r\n` +
		`* 2 FETCH ${evil} BODY[HEADER.FIELDS (SUBJECT FROM DATE)] {${h2.length}}\r\n${h2})\r\n` +
		`a6 OK done\r\n`, "latin1");
	const parsed = R.parseFetchResponse(buf);
	eq(parsed.length, 2, "9.10 both messages parse");
	const subjOf = (pp) => {
		const m = pp && pp.chunk.match(new RegExp("BODY\\[HEADER\\.FIELDS[^\\]]*\\](?:<\\d+>)?\\s*" + SENT + "LIT(\\d+)" + SENT, "i"));
		return m && pp.lits[+m[1]] ? String(pp.lits[+m[1]]) : "";
	};
	ok(subjOf(parsed[1]).includes("222222222"),
		"9.11 a forged LIT sentinel does NOT redirect message 2 to message 1's literal",
		JSON.stringify(subjOf(parsed[1]).slice(0, 60)));
	ok(!subjOf(parsed[1]).includes("111111111"), "9.12 ...so message 2 keeps its own load number");
}
{
	const src = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "ratecon-reconcile.js"), "utf8");
	// L2 — the value is concatenated straight into an IMAP command line.
	ok(/illegal character in IMAP argument/.test(src), "9.13 imapQuote refuses CR/LF/NUL (L2)");
	// M4 — acc grows until a tagged line arrives, over a now-400-day window.
	ok(/MAX_READER_BYTES/.test(src), "9.14 the reader has a hard byte ceiling (M4)");
	// C1's second guard: bounded quantifiers, so the property does not rest on
	// one caller remembering to normalize.
	ok(!/\\bload\\b\[\\s\]\*/.test(src), "9.15 no unbounded whitespace run survives in the body anchor");
}
{
	// The staged extractor must inherit the bound, not just the leaf function.
	const em = { subject: "Ratecon", attachmentNames: [], bodyText: "Load" + " ".repeat(30000) + "x" };
	const t0 = Date.now();
	R.extractMessageLoadNumbers(em);
	ok(Date.now() - t0 < 400, "9.16 the staged extractor inherits the linear bound", (Date.now() - t0) + "ms");
}

// ===========================================================================
section("10. the security RE-review follow-ups (behavioural, not greps)");
// ===========================================================================
{
	// M4 — the first fix only cleared accBytes when a waiter carried a `reject`,
	// but expectGreeting armed one WITHOUT. An overflow during the greeting left
	// accBytes over the cap forever and every later pump() short-circuited: the
	// reader wedged permanently, escapable only by timeoutMs (up to 20 min on a
	// deep sweep, holding the in-flight flag the whole time).
	const done = [];
	const g = R.createImapReader({ maxBytes: 4096 });
	g.expectGreeting().then(() => done.push("g:resolved"), () => done.push("g:rejected"));
	g.push(Buffer.from("x".repeat(9000)));                     // no CRLF, blows the cap
	const e = R.createImapReader({ maxBytes: 4096 });
	e.expect(/^a1 OK/).then(() => done.push("e:resolved"), () => done.push("e:rejected"));
	e.push(Buffer.from("x".repeat(9000)));
	setTimeout(() => {
		ok(done.includes("g:rejected"), "10.1 an overflow during the GREETING rejects instead of wedging", JSON.stringify(done));
		ok(done.includes("e:rejected"), "10.2 ...and so does one during a command", JSON.stringify(done));
		// A healthy reader is unaffected.
		const h = R.createImapReader();
		let okd = false;
		h.expect(/^a1 (OK|NO|BAD)/).then(() => { okd = true; });
		h.push(Buffer.from("* 1 FETCH (x)\r\na1 OK done\r\n", "latin1"));
		setTimeout(() => {
			ok(okd, "10.3 a normal exchange still completes");
			finishUp();
		}, 5);
	}, 5);
}
{
	// The bounded `<[^>]{1,500}>` strip left an over-long tag head unstripped, so
	// its attribute text reached the body scan — a >500-char tracking URL
	// containing "/load-560303758/" minted a PHANTOM load, i.e. an alert row no
	// sheet can ever resolve. The linear scan strips a tag of any length.
	const long = '<a href="https://t.example.com/' + "x".repeat(600) + '/load-560303758/go">click</a>';
	const short = '<a href="https://t.example.com/load-560303758/go">click</a>';
	const scan = (h) => R.extractLoadNumbersFromBody(R.decodeMimeText("Content-Type: text/html\r\n\r\n" + h));
	deep(scan(long), [], "10.4 a >500-char tracking URL does not leak a phantom load");
	deep(scan(short), [], "10.5 ...nor does a short one");
	// ...while a genuine load number in the visible text still reads.
	deep(scan("<td>Load Number:</td><td>563367203</td>"), ["563367203"], "10.6 recall across tags is preserved");
	deep(scan("<style>.a{color:red}</style><p>Load 563367203</p>"), ["563367203"], "10.7 ...beside a style block");
	deep(scan('<p>Load #563367203</p><div class="x'), ["563367203"], "10.8 ...and with an unterminated final tag");
}
{
	// Per-sweep worst case: maxBodyFetch (200) crafted 16 KB bodies. Measured
	// 24-27 s with the bounded regex; the linear scan must keep this trivial.
	const crafted = "Content-Type: text/html\r\n\r\n" + "<style>".repeat(Math.floor(16 * 1024 / 7));
	const t0 = Date.now();
	for (let i = 0; i < 200; i++) R.extractLoadNumbersFromBody(R.decodeMimeText(crafted));
	const ms = Date.now() - t0;
	ok(ms < 2000, "10.9 a full 200-message sweep of crafted bodies stays off the event loop", ms + "ms");
}


let finished = false;
function finishUp() {
	if (finished) return;
	finished = true;
	console.log("\n" + "=".repeat(64));
	if (missingExports.length) {
		console.log("  ⚠️  PRE-FIX BUILD — these exports do not exist:");
		console.log("      " + missingExports.join(", "));
	}
	console.log(`  ${pass} passed, ${fail} failed`);
	if (fail) {
		console.log("\nFAILURES:");
		for (const f of failures) console.log("  ✗ " + f);
	}
	console.log("=".repeat(64));
	process.exit(fail ? 1 : 0);
}
// Backstop: the async literal-reader check calls finishUp on its own timer, but
// the summary must print even if that block never runs.
setTimeout(finishUp, 250).unref?.();
