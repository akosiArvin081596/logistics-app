// Rate-con reconciliation — the backstop for "a load reached the mailbox but
// never reached the sheet".
//
// WHY THIS EXISTS: on 2026-08-05 two loads were lost in one day. The first
// (561151778) died in a Gemini outage, which at least emailed an alert. The
// second (562787563) died because n8n's `Validate Load ID` was a Filter node —
// one output, rejected items silently discarded — so it produced NO signal at
// all and the execution still reported success. Both were found by hand.
//
// Wiring the reject branch to the alert (done) makes *known* failures loud. It
// cannot cover the ones we haven't seen: an execution that never starts, a
// Gmail filter that doesn't label the mail, an n8n outage, a workflow left
// deactivated. Those still yield zero signal.
//
// This module closes that by asking the only question that actually matters,
// from the outside: for every rate-con email that arrived, is there a load in
// the sheet? It does not care WHY something failed, so it catches failure modes
// nobody has thought of yet.
//
// SAFETY, NON-NEGOTIABLE: this reads the mailbox with EXAMINE (read-only) and
// BODY.PEEK, so it never sets \Seen and never touches \Flagged. n8n's Gmail
// Trigger selects on unread + starred — a sweep that marked mail read would
// silently stop ingestion, i.e. cause the exact outage it is meant to detect.
//
// ONLY INBOUND MAIL IS A SIGNAL (added 2026-08-08). This label is not a
// rate-con inbox: measured on the live 14-day window, 20 of its 68 messages
// were sent BY info@logisx.com. On 2026-08-07 that produced the module's first
// false positive — "Bison Transport Order# 2787514", our own outbound invoice,
// whose customer PO number was read as a missing load.
//
// ⚠️ The tempting alternative — sanity-check the NUMBER instead of the sender —
// does not work here, and narrowing LOAD_NUM_RE to chase it would re-introduce
// a bug that was already fixed once. That PO is 2,787,514. Job Tracking already
// holds real 7-digit loads at 2,214,407 / 2,216,467 / 2,218,094 (Steam) and
// 2,651,585 (MegaCorp): same digit count, same magnitude, and the newest real
// id sits closer to the PO than the oldest real one does. There is no range to
// cut, and these counters climb every week. Its subject line is shaped exactly
// like a genuine Bison rate con too, so no subject heuristic separates them
// either — the ONLY thing that does is who sent the mail. Learning a plausible
// range from the sheet's own ids would be worse than useless: it goes blind
// precisely when a new broker's loads ALL fail to ingest, which is the case
// this module exists to catch.
//
// ============================================================================
// TWO BLIND SPOTS CLOSED 2026-08-11 (measured on the full 745-message label)
// ============================================================================
//
// 1. THE WINDOW COULD NOT SEE A GAP DISCOVERED LATER. `sinceDays` was a fixed
//    14 (capped at 60), so a gap older than the lookback was invisible FOREVER —
//    not "harder to find", structurally unreachable. That is how load 556354570
//    (C.H. Robinson, 16 Jun 2026) survived eight weeks: it matched n8n's trigger
//    selector exactly, no execution ever consumed it, and by the time this
//    module went live on 2026-08-06 the message had already aged out. A fixed
//    lookback also silently shrinks to nothing during an outage — miss four
//    days of sweeps and the 14-day window still only looks back 14 days from
//    *now*, so the days nobody swept are never re-examined.
//
//    Replaced by a HIGH-WATER MARK (resolveSweepWindow): each sweep covers
//    everything since the last successful one, so the window is a function of
//    when we last actually looked, not of a constant. `floorDays` keeps the old
//    14 as a MINIMUM, so this can only ever widen. A periodic DEEP sweep
//    re-reads a year and catches anything the incremental chain dropped.
//
// 2. findMissingLoads READ THE SUBJECT ONLY. 12 of the 687 inbound messages
//    carry no load number in their subject. Now staged: subject, then the PDF
//    attachment name, then the body — each stage runs only where the previous
//    one found nothing. See extractMessageLoadNumbers for why the staging is
//    what makes the extension safe rather than merely wider.
//
// ⚠️ MEASURED, NOT ASSUMED — the numbers that justify the narrow scope below.
// Against the real label (745 messages, 687 inbound) and the real production
// Job Tracking (413 rows) plus the read-only archive (300 rows):
//   * subject-only, the shipped rule ......... 88.3% of candidates are known loads
//   * body anchored on load|order|shipment|
//     pro|confirmation|booking|trip|ref|bol .. adds 7 candidates, 7 of them junk
//   * body with NO anchor .................... 67.4% precision; 70 extra junk
//                                              candidates (ZIP+4s, appointment
//                                              numbers, trailer numbers, ids
//                                              scraped out of tracking URLs)
//   * `reference` 0/4, `booking` 0/2, `bol` 0/1, `confirmation` 0/1 — every one
//     of those anchors is 0% precision on real mail.
// Hence: the body anchor is the word LOAD and nothing else (0 false positives
// across all 745 messages), and a filename must be *named after* the load
// rather than merely contain digits. Do not widen either without re-measuring.

"use strict";

const tls = require("tls");

const DEFAULT_HOST = "imap.gmail.com";
const DEFAULT_PORT = 993;
const DEFAULT_MAILBOX = "RATECONs";
const DEFAULT_TIMEOUT_MS = 60000;

// ---------------------------------------------------------------------------
// Sweep window
// ---------------------------------------------------------------------------
// The old ceiling was 60 days and the old lookback a flat 14. Both are now
// policy inputs rather than the whole policy.
const DEFAULT_FLOOR_DAYS = 14;          // never look back LESS than this
const DEFAULT_MAX_SWEEP_DAYS = 400;     // raised cap (was 60): a year plus slack
const DEFAULT_DEEP_SWEEP_DAYS = 365;
const DEFAULT_DEEP_EVERY_HOURS = 24 * 7;
// The incremental window is re-extended past the high-water mark so a message
// that arrived while a sweep was mid-flight cannot fall between two windows.
// IMAP SINCE has DAY granularity anyway, so this is belt and braces.
const DEFAULT_OVERLAP_HOURS = 6;

const toMs = (v) => {
	if (v == null || v === "") return null;
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
	const t = Date.parse(String(v));
	return Number.isNaN(t) ? null : t;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Decide how far back this sweep should read.
//
// ⚠️ THE POINT IS THAT THE WINDOW IS A FUNCTION OF WHEN WE LAST LOOKED, not of
// a constant. A fixed lookback has the property that a gap discovered later than
// the lookback can never be found — which is not a tuning problem that a bigger
// constant fixes, because the same argument applies to any constant. Only a
// high-water mark removes the property.
//
// Returns { sinceDays, deep, reason }. `deep` is advisory for the caller's
// bookkeeping (it is what makes the first-run baseline possible); the sweep
// itself behaves identically either way.
function resolveSweepWindow(opts = {}) {
	const {
		now = Date.now(),
		lastSweepAt = null,
		lastDeepSweepAt = null,
		floorDays = DEFAULT_FLOOR_DAYS,
		maxDays = DEFAULT_MAX_SWEEP_DAYS,
		deepDays = DEFAULT_DEEP_SWEEP_DAYS,
		deepEveryHours = DEFAULT_DEEP_EVERY_HOURS,
		overlapHours = DEFAULT_OVERLAP_HOURS,
	} = opts;

	const nowMs = toMs(now) ?? Date.now();
	const floor = Math.max(1, Math.floor(floorDays) || DEFAULT_FLOOR_DAYS);
	const cap = Math.max(floor, Math.floor(maxDays) || DEFAULT_MAX_SWEEP_DAYS);
	const deepWindow = clamp(Math.floor(deepDays) || DEFAULT_DEEP_SWEEP_DAYS, floor, cap);

	const lastDeep = toMs(lastDeepSweepAt);
	const last = toMs(lastSweepAt);

	// No deep sweep on record — including the very first run after this ships.
	if (lastDeep == null) return { sinceDays: deepWindow, deep: true, reason: "first-deep" };
	if (nowMs - lastDeep >= Math.max(1, deepEveryHours) * 3600000) {
		return { sinceDays: deepWindow, deep: true, reason: "deep-due" };
	}
	// A deep sweep is on record but no ordinary one is — or the clock moved
	// backwards (NTP step, restored snapshot). Both mean the high-water mark
	// cannot be trusted, so fall back to the floor rather than to a negative or
	// absurd window. Failing to the FLOOR is deliberate: it is exactly today's
	// behaviour, so the worst case of a bad clock is the status quo.
	if (last == null || last > nowMs) return { sinceDays: floor, deep: false, reason: "no-high-water" };

	const elapsedMs = (nowMs - last) + Math.max(0, overlapHours) * 3600000;
	return {
		sinceDays: clamp(Math.ceil(elapsedMs / 86400000), floor, cap),
		deep: false,
		reason: "high-water",
	};
}

function imapQuote(s) {
	// A CR or LF here is IMAP command injection: the value is concatenated
	// straight into a command line. Only env-supplied values reach this today
	// (credentials, mailbox name), so it is not sender-reachable — but a mailbox
	// name is exactly the sort of value that later becomes configurable from a UI,
	// and refusing costs nothing.
	if (/[\r\n\u0000]/.test(String(s))) throw new Error("illegal character in IMAP argument");
	return '"' + String(s).replace(/(["\\])/g, "\\$1") + '"';
}

// IMAP SINCE wants "DD-Mon-YYYY". Built from UTC parts so it cannot drift with
// the server's local zone (the VPS runs UTC, the business runs Houston).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function imapSinceDate(d) {
	return `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

// Load numbers as they appear in real rate-con subjects:
//   "Navisphere Carrier Load Confirmation - Load 561151778"
//   "Booked Load #: 563367203"
//   "Bison Transport Order #7086762"      <- 7 digits
//   "Steam Logistics Order #2214407"      <- 7 digits
// 6-12 digits covers every broker seen. A too-narrow bound is how an earlier
// hand-check missed 2218094: it matched 8-10 digits and skipped the 7-digit
// Steam Logistics ids entirely.
const LOAD_NUM_RE = /\b\d{6,12}\b/g;

// Numbers that appear in these subjects but are never load ids. Years and
// 6-digit dates would otherwise generate phantom "missing load" alerts, and an
// alert channel that cries wolf gets muted — which would defeat the purpose.
function isImplausibleLoadNumber(n) {
	if (/^(19|20)\d{2}$/.test(n)) return true;           // a bare year
	if (/^(19|20)\d{6}$/.test(n)) return true;           // YYYYMMDD
	if (/^\d{6}$/.test(n) && /^(0[1-9]|1[0-2])/.test(n)) return true; // MMDDYY-ish
	return false;
}

function extractLoadNumbers(subject) {
	const out = [];
	const seen = new Set();
	for (const m of String(subject || "").matchAll(LOAD_NUM_RE)) {
		const n = m[0];
		if (seen.has(n) || isImplausibleLoadNumber(n)) continue;
		seen.add(n);
		out.push(n);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Attachment filenames
// ---------------------------------------------------------------------------
// A rate con is a PDF, and the commonest way a broker names it is after the load
// ("406323434.pdf", "RateCon_562324759.pdf", "562324759-RateConfirmation.pdf").
//
// ⚠️ THE RULE IS "THE FILE IS NAMED AFTER THE LOAD", NOT "THE NAME CONTAINS
// DIGITS", and that distinction is the whole of its precision. Measured on the
// real label, a contains-digits rule pulls:
//   "CH Robinson & LOGISTICS EXCHANGE INC Executed Contract 2025-04-16.pdf"
//        -> 4845614, 4698012   (document ids on a carrier-ONBOARDING email from
//                               highway.com, a message that is not a rate con at
//                               all and never should have produced a candidate)
//   "Pickup Report - 233395341.pdf"
//        -> 233395341          (a Steam pickup report, not a confirmation)
// Requiring the whole stem to be the number — bar a rate-con-ish affix — refuses
// all three while still admitting the one genuine shape in the corpus.
//
// Non-PDF attachments are ignored outright: signatures, logos and tracking
// pixels ride along on plenty of these messages and none of them is a rate con.
const FILENAME_AFFIX = "(?:rate[ _\\-]?con(?:firmation)?|ratecon|carrier[ _\\-]?con(?:firmation)?|load|booked|order|confirmation|doc(?:ument)?)";
const FILENAME_STEM_RE = new RegExp(
	`^${FILENAME_AFFIX}?[\\s_\\-#.]*(\\d{6,12})[\\s_\\-#.]*${FILENAME_AFFIX}?$`, "i");

function extractLoadNumbersFromFilenames(names) {
	const out = [];
	const seen = new Set();
	for (const raw of names || []) {
		const name = String(raw || "").trim();
		if (!/\.pdf$/i.test(name)) continue;
		const stem = name.replace(/\.pdf$/i, "").trim();
		const m = stem.match(FILENAME_STEM_RE);
		if (!m) continue;
		const n = m[1];
		// ⚠️ "doc" is in the affix list so "document_562324759.pdf" is admitted,
		// but "doc1021273951.pdf" must NOT be: that is Gmail's own attachment id
		// on a forwarded message, not a load. The separator requirement below is
		// what splits them — an affix glued straight onto the digits is the
		// machine-generated shape, an affix with a separator is the human one.
		if (/^doc(?:ument)?\d/i.test(stem)) continue;
		if (seen.has(n) || isImplausibleLoadNumber(n)) continue;
		seen.add(n);
		out.push(n);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Body text
// ---------------------------------------------------------------------------
// ⚠️ THE ANCHOR IS THE WORD "LOAD" AND NOTHING ELSE. Every wider vocabulary was
// measured against the real label and every one of them is worse:
//   reference    0 of 4 correct   ("CONVOY ID: CHE-205966 REFERENCE ID: 3682042422")
//   booking      0 of 2           ("PICK-UP# /BOOKING# 8675309")
//   bol          0 of 1           ("BOL #: 32473287")
//   confirmation 0 of 1           ("...minutes left before expiration.
//                                   Confirmation Number: 736597" — a web session)
//   order        3 wrong, and the wrong ones are the exact class this module was
//                already burned by: "*Order #: 0081100815, PO: 6618446422*" is a
//                customer purchase order sitting inside a real rate con whose
//                own reference is the non-numeric "DMF-8657".
// With the anchor restricted to `load`, the body stage produces ZERO false
// positives across all 745 messages. That is the number to protect.
//
// It also must be a WORD boundary match: "download 562324759" and "payload"
// must not anchor, and \bload\b is what stops them.
//
// ⚠️⚠️ THE QUANTIFIERS ARE BOUNDED, AND THAT IS A DENIAL-OF-SERVICE CONTROL, NOT
// TIDINESS. The first draft used three unbounded `[\s]*` runs separated by
// optional tokens. Two adjacent stars separated by something that can match
// empty is ambiguous, so the engine enumerates every way of splitting a
// whitespace run between them — measured cubic:
//     160 spaces -> 59 ms | 640 -> 1.2 s | 1000 -> 5.6 s | 1500 -> 16 s
// and this is NOT an adversarial-only shape. `decodeMimeText` replaces every
// HTML tag with a space, so ordinary broker markup *becomes* the whitespace run:
// a 7.2 KB HTML email with 400 nested table tags blocked the event loop for
// **28 seconds**, measured end to end through decodeMimeText. server.js is a
// single Express process, so that stalls the dashboard, the driver app, the
// public tracker, the n8n callbacks and the Linxup GPS webhook at once — i.e.
// the sweep would cause a worse outage than the one it detects, unattended, on
// the 6-hourly timer, with no attacker required.
//
// Two independent guards, because either alone is one edit away from regressing:
// the input is whitespace-collapsed first (exactly as decodeSubject already
// does), AND the separators are hard-bounded so the partition search is capped
// even if a future caller forgets to normalize.
// Same reasoning as `cityStateZip()`'s `[\s,]*` note in CLAUDE.md — that one was
// 9.4 s of blocked loop at 5,000 chars. Do not restore an unbounded `\s*` here
// without re-measuring.
const BODY_LOAD_ANCHOR_RE =
	/\bload\b[ \t]{0,8}(?:#|№|no\.?|number|num\.?|id)?[ \t]{0,8}[:#\-–]?[ \t]{0,8}(\d{6,12})(?!\d)/gi;

function extractLoadNumbersFromBody(text) {
	const out = [];
	const seen = new Set();
	// Bounded input: body text arrives from a partial fetch and is attacker-ish
	// (any broker, plus anything quoted into a reply chain). Collapsing runs of
	// whitespace to a single space is what makes the scan linear; it also
	// slightly IMPROVES recall, because HTML-stripped mail routinely separates
	// "Load" from its number with a newline plus a dozen spaces.
	const s = String(text || "").slice(0, 262144).replace(/\s+/g, " ");
	const re = new RegExp(BODY_LOAD_ANCHOR_RE.source, "gi");
	let m;
	while ((m = re.exec(s))) {
		const n = m[1];
		if (seen.has(n) || isImplausibleLoadNumber(n)) continue;
		seen.add(n);
		out.push(n);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Staged extraction
// ---------------------------------------------------------------------------
// Subject -> filename -> body, and each stage runs ONLY where the previous one
// came up empty.
//
// ⚠️ THE STAGING IS THE SAFETY, NOT AN OPTIMISATION. Running the body scan on
// every message would re-read 675 subjects' worth of numbers out of quoted reply
// chains and signature blocks, which is precisely where the junk lives; running
// it only on the residue means the 675 messages the subject already answers
// cannot acquire a single new false positive. Measured: the residue is 10 of
// 687 messages (1.5%), so it is also ~65x cheaper over IMAP — but if the two
// ever conflicted, precision is the reason, not cost.
//
// Returns [{ loadNumber, via }] where via is "subject" | "filename" | "body".
function extractMessageLoadNumbers(email, opts = {}) {
	const { scanFilenames = true, scanBody = true } = opts;
	const em = email || {};
	const fromSubject = extractLoadNumbers(em.subject);
	if (fromSubject.length) return fromSubject.map((n) => ({ loadNumber: n, via: "subject" }));
	if (scanFilenames) {
		const fromFile = extractLoadNumbersFromFilenames(em.attachmentNames);
		if (fromFile.length) return fromFile.map((n) => ({ loadNumber: n, via: "filename" }));
	}
	if (scanBody) {
		const fromBody = extractLoadNumbersFromBody(em.bodyText);
		if (fromBody.length) return fromBody.map((n) => ({ loadNumber: n, via: "body" }));
	}
	return [];
}

// True when this message still has no load number after every enabled stage —
// i.e. its body is worth fetching. Used to build the phase-2 fetch set.
function needsBodyScan(email, opts = {}) {
	const { scanFilenames = true } = opts;
	const em = email || {};
	if (extractLoadNumbers(em.subject).length) return false;
	if (scanFilenames && extractLoadNumbersFromFilenames(em.attachmentNames).length) return false;
	return true;
}

// Sheet ids are not written consistently ("513987502" vs "#513987502"), so
// compare on a normalized key rather than raw equality.
const normLoadKey = (id) => String(id || "").trim().toLowerCase().replace(/^#/, "");

// "Info LogisX <info@logisx.com>" -> "info@logisx.com". Returns "" when the
// header does not parse, which the caller must treat as "keep this mail": a
// detector that drops what it cannot read stops detecting.
//
// Compares on the parsed addr-spec, never a substring of the raw header. The
// display name is sender-controlled free text and our own address routinely
// appears inside a quoted reply chain, so `raw.includes(GMAIL_USER)` would
// match plenty of mail we did not send.
//
// Takes the LAST angle-addr, which is what RFC 5322's `display-name angle-addr`
// means and is also the safe direction: a crafted
//     "billing <info@logisx.com>" <broker@acme.com>
// resolves to the broker, so a forged display name can never make us skip — and
// so silently ignore — a real broker's rate con.
//
// Encoded-words are deliberately NOT decoded here (unlike decodeSubject). RFC
// 2047 permits them only in the display name, never in an addr-spec, so
// decoding could only ever import sender-chosen "<...>" into the parse.
function parseFromAddress(raw) {
	const s = String(raw || "").replace(/\r\n[ \t]+/g, " ").trim();
	if (!s) return "";
	const angles = [...s.matchAll(/<([^<>]*)>/g)];
	const addr = angles.length
		? angles[angles.length - 1][1].trim()
		: s.replace(/\([^()]*\)/g, " ").replace(/["']/g, " ").trim();   // legacy `user@host (Comment)` form
	// Anything that is not a plain addr-spec fails here and yields "" -> kept.
	if (!/^[^\s@,;:<>"]+@[^\s@,;:<>"]+\.[^\s@,;:<>"]+$/.test(addr)) return "";
	return addr.toLowerCase();
}

// Did WE send this? An outbound invoice filed under the same label is not an
// ingestion signal, and its PO number is not a load id — that is exactly how
// "Bison Invoice PO 2787514" was alerted as a missing load on 2026-08-07.
function isSelfSent(email, selfAddress) {
	const self = parseFromAddress(selfAddress);
	if (!self) return false;                        // unset/unparseable config -> filter nothing
	const from = (email && email.fromAddress) || parseFromAddress(email && email.from);
	return !!from && from === self;
}

// Split a fetched batch into mail that arrived and mail we sent. Kept separate
// from findMissingLoads so the caller can report both halves — a sweep that
// silently discarded messages would be indistinguishable from an empty label.
function splitSelfSent(emails, selfAddress) {
	const inbound = [], selfSent = [];
	for (const em of emails || []) (isSelfSent(em, selfAddress) ? selfSent : inbound).push(em);
	return { inbound, selfSent };
}

// emails: [{ subject, date, from, fromAddress, attachmentNames?, bodyText? }] ;
// sheetLoadIds: iterable of raw sheet load ids. Returns one entry per load
// number that a rate-con email produced and that has no row in the sheet. Feed
// it the INBOUND half only (see splitSelfSent) — it does not look at the sender
// itself.
//
// ⚠️ Pass EVERY sheet a load can legitimately live in. A load that was moved to
// the read-only archive did reach the sheet; reporting it as an ingestion gap is
// a false positive, and a measurable one — 12 of the 74 gaps a full-history
// sweep turns up are archived loads, not lost ones.
//
// `opts.scanFilenames` / `opts.scanBody` default ON but only ever apply to a
// message whose subject yielded nothing, so the default is still a strict
// superset of the subject-only behaviour: every load this found before, it
// still finds, with `via: "subject"`.
function findMissingLoads(emails, sheetLoadIds, opts = {}) {
	const inSheet = new Set();
	for (const id of sheetLoadIds || []) {
		const k = normLoadKey(id);
		if (k) inSheet.add(k);
	}
	const missing = new Map();
	for (const em of emails || []) {
		for (const { loadNumber, via } of extractMessageLoadNumbers(em, opts)) {
			if (inSheet.has(normLoadKey(loadNumber))) continue;
			if (!missing.has(loadNumber)) {
				missing.set(loadNumber, { loadNumber, subject: em.subject, date: em.date || "", via });
			}
		}
	}
	return [...missing.values()];
}

// ---------------------------------------------------------------------------
// Alert batching
// ---------------------------------------------------------------------------
// ⚠️ WIDENING THE WINDOW MUST NOT RE-ALERT HISTORY. The once-per-load-id
// contract (ratecon_reconcile_alerts, PRIMARY KEY load_id, skip when alerted_at
// is set) already guarantees no load is ever named twice, so the danger is not
// repetition — it is the FIRST wide run, which sees every historical gap at
// once. Measured on production: a first full-history sweep finds 74 gaps, or 62
// once archived loads are excluded, against 0 in the shipped 14-day window.
//
// 62 rows in one table is not 62 emails (the sender already batches), but it is
// still a wall of year-old loads landing in a channel whose whole value is that
// someone reads it — and this repo's own cautionary tale is the 13 "needs a
// manual check" emails that went unread. So the first deep sweep is labelled as
// a BASELINE: the rows are still recorded and still alerted exactly once, but
// they are presented as a one-time review list with a bounded excerpt, not as
// "62 things went wrong just now".
function planReconcileAlert(missing, opts = {}) {
	const { baseline = false, maxListed = 25 } = opts;
	const all = [...(missing || [])];
	// Newest first: on a baseline run the recent gaps are the ones still worth
	// recovering, and the year-old ones are context.
	all.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
	const listed = baseline ? all.slice(0, Math.max(1, maxListed)) : all;
	return {
		kind: baseline ? "baseline" : "normal",
		listed,
		suppressedCount: all.length - listed.length,
		total: all.length,
	};
}

// Decode the RFC2047 encoded-words Gmail uses for non-ASCII subjects, enough to
// keep digits and the gist readable in an alert.
function decodeSubject(raw) {
	return String(raw || "")
		.replace(/\r\n[ \t]+/g, " ")
		.replace(/=\?[^?]+\?[Qq]\?([^?]*)\?=/g, (_, b) =>
			b.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))))
		.replace(/=\?[^?]+\?[Bb]\?([^?]*)\?=/g, (_, b) => {
			try { return Buffer.from(b, "base64").toString("utf8"); } catch { return b; }
		})
		.replace(/\s+/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// IMAP wire format
// ---------------------------------------------------------------------------
// ⚠️⚠️ LITERALS MUST BE LIFTED OUT BEFORE ANYTHING IS SPLIT OR REGEXED, and
// this became load-bearing the moment message BODIES entered the fetch.
//
// An IMAP literal is `{N}\r\n` followed by exactly N raw octets which are NOT
// protocol — they are message content. The previous reader scanned the raw
// stream for /^aN (OK|NO|BAD)/m and split on /\* \d+ FETCH/, which is safe only
// while the sole literal is a header block: a header block contains no such
// lines. A message body does. A forwarded rate con quoting an earlier thread
// contains "Subject:" and "From:" lines, and any body may contain a line
// beginning "a1 OK" or "* 12 FETCH" — the first ends the command early and
// silently truncates the response, the second forges an extra message.
//
// This is not hypothetical. The read-only probe that produced the measurements
// in this file hit exactly that: 62 of 745 messages parsed, every body empty,
// and the "headers" it did find came out of forwarded-mail text.
//
// So: count literal octets, never scan them. Everything below reads the stream
// as protocol lines plus opaque literal payloads.
// ⚠️ The ceiling is a memory control, not a tuning knob. `acc` grows until a
// tagged completion line arrives, and phase 1 fetches BODYSTRUCTURE for
// `batchSize` messages at a time — a size that is a function of the sender's own
// MIME part count and filename lengths. parseFetchResponse then makes several
// more full copies. Unbounded, one crafted mailbox could exhaust a process that
// also serves the dashboard and the GPS webhook. Exceeding it is a clean error,
// which for this sweep means "no run marker written", so the next sweep simply
// re-covers the same period.
const MAX_READER_BYTES = 64 * 1024 * 1024;

function createImapReader(opts = {}) {
	// Floor is deliberately small (4 KB, one IMAP line's worth) rather than the
	// 1 MB it started at: a floor above any testable value makes the ceiling
	// unverifiable, and an unverified limit is a comment. Production never passes
	// this — it gets MAX_READER_BYTES.
	const maxBytes = Math.max(4096, opts.maxBytes || MAX_READER_BYTES);
	let pend = Buffer.alloc(0);
	let litLeft = 0;
	let acc = [];
	let accBytes = 0;
	let waiter = null;
	let overflow = null;

	const pump = () => {
		for (;;) {
			// ⚠️ RESET UNCONDITIONALLY. The first version only cleared accBytes when a
			// waiter with a reject was armed — but expectGreeting arms one WITHOUT a
			// reject, so an overflow during the greeting left accBytes over the cap
			// forever and every later pump() short-circuited here. The reader wedged
			// permanently and only timeoutMs escaped, which on a deep sweep is 15
			// minutes with the in-flight flag held the whole time.
			if (accBytes + pend.length > maxBytes) {
				overflow = overflow || new Error(`IMAP response exceeded ${maxBytes} bytes`);
				const w = waiter;
				waiter = null; acc = []; accBytes = 0; pend = Buffer.alloc(0);
				if (w && w.reject) w.reject(overflow);
				return;
			}
			if (litLeft > 0) {
				const take = Math.min(litLeft, pend.length);
				if (!take) return;
				acc.push(pend.subarray(0, take)); accBytes += take;
				pend = pend.subarray(take);
				litLeft -= take;
				continue;
			}
			const nl = pend.indexOf("\r\n");
			if (nl === -1) return;
			const line = pend.subarray(0, nl + 2);
			acc.push(line); accBytes += line.length;
			pend = pend.subarray(nl + 2);
			const s = line.toString("latin1");
			// A literal introducer is only ever the LAST token on a line.
			const lit = s.match(/\{(\d+)\}\r\n$/);
			if (lit) { litLeft = parseInt(lit[1], 10); continue; }
			if (waiter && waiter.re.test(s)) {
				const w = waiter;
				waiter = null;
				const out = Buffer.concat(acc);
				acc = []; accBytes = 0;
				w.resolve(out);
			}
		}
	};

	return {
		push(chunk) { pend = Buffer.concat([pend, chunk]); pump(); },
		expect(re) {
			return new Promise((resolve, reject) => { acc = []; accBytes = 0; waiter = { re, resolve, reject }; pump(); });
		},
		// Greeting arrives unsolicited, so it needs the waiter armed with no reset.
		expectGreeting() {
			return new Promise((resolve, reject) => { waiter = { re: /^\* OK/, resolve, reject }; pump(); });
		},
	};
}

// Split a FETCH response into per-message chunks with their literals keyed by
// the item that introduced them.
//
// ⚠️ KEY LITERALS BY ITEM NAME, NEVER BY POSITION. Gmail answers FETCH items in
// its own order, not the order they were requested — measured: BODYSTRUCTURE and
// BODY[TEXT] come back BEFORE BODY[HEADER.FIELDS]. Taking literal[0] as "the
// headers" reads the message body as headers, which is the same failure as not
// lifting literals at all, arrived at by a different route.
function parseFetchResponse(buf) {
	const lits = [];
	const parts = [];
	// ⚠️ THE SENTINEL MUST BE UNFORGEABLE, SO IT IS STRIPPED FROM PROTOCOL TEXT
	// FIRST. U+0001 is a legal TEXT-CHAR in an IMAP quoted string (RFC 3501), and
	// BODYSTRUCTURE carries attacker-chosen NAME/FILENAME parameters — so an
	// attachment named `BODY[HEADER.FIELDS ]<0x01>LIT0<0x01>x.pdf` makes litFor()
	// resolve to ANOTHER message's literal, and that message's real subject (and
	// its load number) then silently never reaches findMissingLoads. `lits` is one
	// array shared across every message in the batch, which is what lets a forged
	// index reach across. Stripping the byte here kills the whole class by
	// construction, rather than by trusting Gmail to sanitize a filename.
	const proto = (b) => b.toString("latin1").replace(/\u0001/g, " ");
	let i = 0;
	while (i < buf.length) {
		const open = buf.indexOf("{", i);
		if (open === -1) { parts.push(proto(buf.subarray(i))); break; }
		const close = buf.indexOf("}\r\n", open);
		const numTxt = close === -1 ? "" : buf.subarray(open + 1, close).toString("latin1");
		if (close === -1 || !/^\d+$/.test(numTxt)) {
			parts.push(proto(buf.subarray(i, open + 1)));
			i = open + 1;
			continue;
		}
		const n = parseInt(numTxt, 10);
		const start = close + 3;
		if (start + n > buf.length) { parts.push(proto(buf.subarray(i))); break; }
		parts.push(proto(buf.subarray(i, open)));
		parts.push(`\u0001LIT${lits.length}\u0001`);
		lits.push(buf.subarray(start, start + n));
		i = start + n;
	}
	// With one capture group, split() interleaves [seq, chunk, seq, chunk, ...].
	// The sequence number is what pairs a FETCH item back to its message, and it
	// is required: the phase-2 body fetch has to land on the right email.
	const text = parts.join("");
	//
	// ⚠️ THE BOUNDARY IS ANCHORED TO A LINE START, and that is the second half of
	// the forgery defence. Lifting literals stops a message BODY from forging
	// `* 9 FETCH`, but BODYSTRUCTURE is inline PROTOCOL text, so an attachment
	// literally named `* 9 FETCH ratecon.pdf` split ONE server message into three
	// and handed the survivor an attacker-chosen sequence number — which then keys
	// bySeq and the phase-2 fetch, EVICTING an innocent broker's message from the
	// body-scan set. That silences exactly the stage this change adds. An IMAP
	// quoted string cannot contain a raw CRLF and a literal is already lifted out,
	// so requiring the marker to BEGIN A LINE makes it unforgeable from any
	// attacker-supplied value. `^` (no /m flag) matches only at buffer start.
	const pieces = text.split(/(?:^|\r\n)\* (\d+) FETCH/).slice(1);
	const out = [];
	for (let k = 0; k + 1 < pieces.length; k += 2) {
		out.push({ seq: pieces[k], chunk: pieces[k + 1], lits });
	}
	return out;
}

const litFor = (chunk, lits, re) => {
	const m = chunk.match(re);
	return m && lits[+m[1]] ? lits[+m[1]] : null;
};

// Attachment filenames out of a BODYSTRUCTURE. Both the `("NAME" "x.pdf")` body
// parameter and the `("FILENAME" "x.pdf")` disposition parameter are used in the
// wild, often on the same message.
function attachmentNamesFromBodyStructure(bs) {
	const names = [];
	const re = /"(?:FILENAME|NAME)"\s+"((?:[^"\\]|\\.)*)"/gi;
	let m;
	while ((m = re.exec(String(bs || "")))) names.push(m[1].replace(/\\(.)/g, "$1"));
	return [...new Set(names)];
}

// Remove HTML tags in ONE forward pass. No regex, so no backtracking and no
// bound to tune: everything from a `<` up to and including the next `>` goes.
// An unterminated final tag keeps its text (matching what the old `<[^>]*>`
// did by simply not matching), so this can never LOSE a load number.
function stripHtmlTags(s) {
	let out = "";
	let i = 0;
	for (;;) {
		const lt = s.indexOf("<", i);
		if (lt === -1) { out += s.slice(i); break; }
		out += s.slice(i, lt);
		const gt = s.indexOf(">", lt + 1);
		if (gt === -1) { out += " " + s.slice(lt + 1); break; }   // unterminated: keep the text
		out += " ";
		i = gt + 1;
	}
	return out;
}

// Aligned with what the sweep can actually hand it: phase 2 fetches a bounded
// prefix (`bodyBytes`, default 16 KB), so 64 KB is 4x headroom. Belt and braces
// now that stripHtmlTags is linear — the cost here is O(length) with no
// backtracking — but the bound belongs on an exported function whose cost is a
// function of its input, not only on the one caller that happens to exist today.
//
// Measured end to end after this pass: a realistic 16 KB all-markup email
// decodes and scans in 2.5 ms; 256 KB of `<style>` in 4.7 ms; a full sweep of
// 200 crafted 16 KB bodies (maxBodyFetch) in 64 ms, against 24-27 s for the
// bounded-regex version this replaced and minutes for the unbounded one.
const MAX_MIME_TEXT_BYTES = 64 * 1024;

// Very small MIME-to-text pass over a partial body fetch. Everything tolerates a
// truncated tail, because a partial fetch is the normal case.
function decodeMimeText(raw) {
	// Bounded before any regex touches it. Callers already fetch a bounded prefix
	// (bodyBytes, default 16 KB), but this function is exported and the cost of
	// every rule below is a function of length — so the bound belongs here too,
	// not only in the caller that happens to exist today.
	const s = String(raw || "").slice(0, MAX_MIME_TEXT_BYTES);
	const out = [];
	const boundary = (s.match(/boundary="?([^";\r\n]+)"?/i) || [])[1];
	const parts = boundary
		? s.split(new RegExp("--" + boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
		: [s];
	for (const p of parts) {
		const sep = p.indexOf("\r\n\r\n");
		const head = sep === -1 ? "" : p.slice(0, sep);
		const body = sep === -1 ? p : p.slice(sep + 4);
		const cte = ((head.match(/Content-Transfer-Encoding:\s*([^\r\n;]+)/i) || [])[1] || "").trim().toLowerCase();
		const ctype = ((head.match(/Content-Type:\s*([^\r\n;]+)/i) || [])[1] || "").trim().toLowerCase();
		// Never scan attachment bytes: a PDF's raw stream is full of 6-12 digit
		// runs and none of them is a load number.
		if (/^(image|application|audio|video)\//.test(ctype)) continue;
		let t = body;
		if (cte === "base64") {
			try { t = Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64").toString("utf8"); } catch { t = ""; }
		} else if (cte === "quoted-printable") {
			t = body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
		}
		if (/html/.test(ctype) || /<html|<body|<div|<table/i.test(t.slice(0, 400))) {
			// ⚠️ THE TAG STRIP IS A LINEAR SCAN, NOT A REGEX, AND THAT IS THE FIX.
			// Three regex shapes were tried here and each traded one pathology for
			// another. `<[^>]*>` is O(n²) on input with many `<` and no `>` — 6.6 s
			// over 64 KB of `<`, and a truncated fetch prefix produces exactly that.
			// Bounding it to `<[^>]{1,500}>` fixed that shape (222 ms) but created two
			// new problems: a tag head over the bound is no longer stripped at all, so
			// a >500-char tracking URL containing `/load-560303758/` leaks a PHANTOM
			// load number into the body scan — measured — and the bound is a constant
			// someone must keep re-justifying. And `[\s\S]{0,20000}?` for the
			// style/script bodies is INERT at the production fetch size (bodyBytes is
			// 16 KB, under the bound) while being 2-3x SLOWER than the unbounded lazy
			// form at every size the input cap permits, because V8 compiles `*?` to a
			// tight loop and `{0,N}?` needs a per-iteration counter.
			//
			// splitTags does one pass, allocates no backtracking state, needs no
			// bound, and strips a tag of ANY length — so it is faster than all three
			// AND removes the false-positive path the bounded version introduced.
			// Measured: 64 KB of `<style>` 968 ms -> 3 ms; 64 KB of `<` 222 ms -> 2 ms.
			//
			// The dedicated <style>/<script> BODY rules are deliberately gone with it.
			// They were the dominant cost and they buy nothing here: stripping the
			// tags leaves CSS/JS text behind, which is harmless to a `\bload\b`-anchored
			// digit scan (`.load1234567` has no word boundary after "load", so it
			// cannot anchor).
			t = stripHtmlTags(t)
				.replace(/&nbsp;/gi, " ")
				.replace(/&amp;/gi, "&")
				.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
		}
		out.push(t);
	}
	return out.join("\n");
}

// Read-only listing of rate-con messages. EXAMINE + BODY.PEEK: never marks read.
//
// Phase 1 fetches headers (+ BODYSTRUCTURE when filenames are wanted, which is
// how attachment names arrive without downloading a byte of attachment).
// Phase 2 fetches a bounded BODY.PEEK[TEXT] prefix for ONLY the messages that
// still have no load number — 10 of 687 on the real label.
function fetchRateConSubjects(opts = {}) {
	const {
		user, pass,
		host = DEFAULT_HOST,
		port = DEFAULT_PORT,
		mailbox = DEFAULT_MAILBOX,
		sinceDays = 14,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		scanFilenames = false,
		scanBody = false,
		bodyBytes = 16384,
		maxBodyFetch = 200,
		batchSize = 60,
		maxReaderBytes = MAX_READER_BYTES,
	} = opts;

	return new Promise((resolve, reject) => {
		if (!user || !pass) return reject(new Error("GMAIL_USER / GMAIL_APP_PASSWORD not configured"));

		const since = imapSinceDate(new Date(Date.now() - sinceDays * 86400000));
		const reader = createImapReader({ maxBytes: maxReaderBytes });
		const sock = tls.connect(port, host, { servername: host });
		let tag = 0, done = false;

		const finish = (err, val) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try { sock.end(); } catch { /* socket already gone */ }
			err ? reject(err) : resolve(val);
		};
		const timer = setTimeout(() => finish(new Error("IMAP timeout")), timeoutMs);

		sock.on("error", (e) => finish(e));
		sock.on("data", (d) => reader.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));

		// Each command resolves on ITS OWN tag. The reader hands back everything
		// received up to and including that tagged line, so the completion status
		// is the last protocol line — never a /^a\d+ OK/m scan of the whole buffer,
		// which is the literal-blind test this rewrite exists to remove.
		const send = (cmd) => {
			tag++;
			const t = "a" + tag;
			const p = reader.expect(new RegExp("^" + t + " (OK|NO|BAD)")).then((buf) => {
				const lines = buf.toString("latin1").split("\r\n").filter(Boolean);
				const last = lines[lines.length - 1] || "";
				return { buf, ok: new RegExp("^" + t + " OK").test(last) };
			});
			sock.write(t + " " + cmd + "\r\n");
			return p;
		};

		(async () => {
			await reader.expectGreeting();
			if (!(await send("LOGIN " + imapQuote(user) + " " + imapQuote(pass))).ok) {
				throw new Error("IMAP LOGIN failed");
			}
			// EXAMINE, never SELECT: read-only, so nothing can set \Seen.
			if (!(await send("EXAMINE " + imapQuote(mailbox))).ok) {
				throw new Error("mailbox not found: " + mailbox);
			}
			const sr = (await send("SEARCH SINCE " + since)).buf.toString("latin1");
			const ids = ((sr.match(/^\* SEARCH([\d ]*)/m) || ["", ""])[1] || "").trim().split(/\s+/).filter(Boolean);
			if (!ids.length) return [];

			// ---- phase 1: headers (+ BODYSTRUCTURE for attachment names) -------
			// FROM is fetched so the caller can tell a broker's inbound rate con
			// from mail we sent ourselves. MUST stay BODY.PEEK — widening the field
			// list is free, but dropping .PEEK would set \Seen and n8n's Gmail
			// Trigger selects on unread+starred, so the sweep would cause the
			// ingestion outage it exists to detect. See the header comment.
			const items = "BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)]" + (scanFilenames ? " BODYSTRUCTURE" : "");
			const bySeq = new Map();
			const emails = [];
			for (let i = 0; i < ids.length; i += batchSize) {
				const slice = ids.slice(i, i + batchSize);
				const { buf } = await send("FETCH " + slice.join(",") + " (" + items + ")");
				for (const { seq, chunk, lits } of parseFetchResponse(buf)) {
					const hdrBuf = litFor(chunk, lits, /BODY\[HEADER\.FIELDS[^\]]*\](?:<\d+>)?\s*\u0001LIT(\d+)\u0001/i);
					const hdr = hdrBuf ? hdrBuf.toString("utf8") : "";
					if (!hdr) continue;
					const s = (hdr.match(/^Subject:\s*([^\r\n]*(?:\r\n[ \t][^\r\n]*)*)/im) || [])[1];
					const dt = (hdr.match(/^Date:\s*([^\r\n]*)/im) || [])[1];
					// Line-anchored so a Resent-From / X-Google-Original-From can never
					// stand in for the envelope author.
					const fr = (hdr.match(/^From:\s*([^\r\n]*(?:\r\n[ \t][^\r\n]*)*)/im) || [])[1];
					if (!s) continue;
					const em = {
						subject: decodeSubject(s),
						date: (dt || "").trim(),
						from: (fr || "").replace(/\r\n[ \t]+/g, " ").trim(),
						fromAddress: parseFromAddress(fr),
						attachmentNames: scanFilenames
							? attachmentNamesFromBodyStructure(chunk.replace(/\u0001LIT\d+\u0001/g, ""))
							: [],
						bodyText: "",
					};
					emails.push(em);
					bySeq.set(String(seq), em);
				}
			}

			// ---- phase 2: bodies, for the residue only --------------------------
			if (scanBody) {
				const residue = [];
				for (const [seq, em] of bySeq) if (needsBodyScan(em, { scanFilenames })) residue.push(seq);
				// Bounded: a mailbox where every subject is silent must not turn one
				// sweep into a full-label body download.
				const take = residue.slice(0, Math.max(0, maxBodyFetch));
				for (let i = 0; i < take.length; i += batchSize) {
					const slice = take.slice(i, i + batchSize);
					const { buf } = await send(
						"FETCH " + slice.join(",") + " (BODY.PEEK[TEXT]<0." + Math.max(1024, bodyBytes) + ">)");
					for (const { seq, chunk, lits } of parseFetchResponse(buf)) {
						const em = bySeq.get(String(seq));
						if (!em) continue;
						const b = litFor(chunk, lits, /BODY\[TEXT\](?:<\d+>)?\s*\u0001LIT(\d+)\u0001/i);
						if (b) em.bodyText = decodeMimeText(b.toString("latin1"));
					}
				}
			}

			await send("LOGOUT");
			return emails;
		})().then((v) => finish(null, v), (e) => finish(e));
	});
}

module.exports = {
	fetchRateConSubjects,
	extractLoadNumbers,
	extractLoadNumbersFromFilenames,
	extractLoadNumbersFromBody,
	extractMessageLoadNumbers,
	needsBodyScan,
	findMissingLoads,
	isImplausibleLoadNumber,
	decodeSubject,
	normLoadKey,
	parseFromAddress,
	isSelfSent,
	splitSelfSent,
	resolveSweepWindow,
	planReconcileAlert,
	attachmentNamesFromBodyStructure,
	decodeMimeText,
	parseFetchResponse,
	createImapReader,
	DEFAULT_FLOOR_DAYS,
	DEFAULT_MAX_SWEEP_DAYS,
	DEFAULT_DEEP_SWEEP_DAYS,
	DEFAULT_DEEP_EVERY_HOURS,
};
