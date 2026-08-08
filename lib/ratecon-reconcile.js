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
// whose customer PO number was read as a missing load id.
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

"use strict";

const tls = require("tls");

const DEFAULT_HOST = "imap.gmail.com";
const DEFAULT_PORT = 993;
const DEFAULT_MAILBOX = "RATECONs";
const DEFAULT_TIMEOUT_MS = 60000;

function imapQuote(s) {
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

// emails: [{ subject, date, from, fromAddress }] ; sheetLoadIds: iterable of raw
// sheet load ids. Returns one entry per load number that appeared in a rate-con
// subject and has no row in the sheet. Feed it the INBOUND half only (see
// splitSelfSent) — it does not look at the sender itself.
function findMissingLoads(emails, sheetLoadIds) {
	const inSheet = new Set();
	for (const id of sheetLoadIds || []) {
		const k = normLoadKey(id);
		if (k) inSheet.add(k);
	}
	const missing = new Map();
	for (const em of emails || []) {
		for (const num of extractLoadNumbers(em.subject)) {
			if (inSheet.has(normLoadKey(num))) continue;
			if (!missing.has(num)) missing.set(num, { loadNumber: num, subject: em.subject, date: em.date || "" });
		}
	}
	return [...missing.values()];
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

// Read-only listing of rate-con subjects. EXAMINE + BODY.PEEK: never marks read.
function fetchRateConSubjects(opts = {}) {
	const {
		user, pass,
		host = DEFAULT_HOST,
		port = DEFAULT_PORT,
		mailbox = DEFAULT_MAILBOX,
		sinceDays = 14,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	} = opts;

	return new Promise((resolve, reject) => {
		if (!user || !pass) return reject(new Error("GMAIL_USER / GMAIL_APP_PASSWORD not configured"));

		const since = imapSinceDate(new Date(Date.now() - sinceDays * 86400000));
		const sock = tls.connect(port, host, { servername: host });
		let buf = "", step = 0, tag = 0, done = false;
		const emails = [];

		const finish = (err, val) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try { sock.end(); } catch {}
			err ? reject(err) : resolve(val);
		};
		const timer = setTimeout(() => finish(new Error("IMAP timeout")), timeoutMs);
		const send = (cmd) => { tag++; buf = ""; sock.write("a" + tag + " " + cmd + "\r\n"); };
		const tagged = () => new RegExp("^a" + tag + " (OK|NO|BAD)", "m").test(buf);

		sock.setEncoding("utf8");
		sock.on("error", (e) => finish(e));
		sock.on("data", () => {});
		sock.on("data", (d) => {
			buf += d;
			if (step === 0 && /^\* OK/.test(buf)) {
				step = 1; send("LOGIN " + imapQuote(user) + " " + imapQuote(pass)); return;
			}
			if (!tagged()) return;
			if (step === 1) {
				if (!new RegExp("^a" + tag + " OK", "m").test(buf)) return finish(new Error("IMAP LOGIN failed"));
				step = 2; send("EXAMINE " + imapQuote(mailbox)); return;       // read-only
			}
			if (step === 2) {
				if (!new RegExp("^a" + tag + " OK", "m").test(buf)) return finish(new Error("mailbox not found: " + mailbox));
				step = 3; send("SEARCH SINCE " + since); return;
			}
			if (step === 3) {
				const ids = ((buf.match(/^\* SEARCH([\d ]*)/m) || ["", ""])[1] || "").trim().split(/\s+/).filter(Boolean);
				if (!ids.length) return finish(null, []);
				// FROM is fetched so the caller can tell a broker's inbound rate con
				// from mail we sent ourselves. MUST stay BODY.PEEK — widening the
				// field list is free, but dropping .PEEK would set \Seen and n8n's
				// Gmail Trigger selects on unread+starred, so the sweep would cause
				// the ingestion outage it exists to detect. See the header comment.
				step = 4; send("FETCH " + ids.join(",") + " (BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])"); return;
			}
			if (step === 4) {
				for (const chunk of buf.split(/\* \d+ FETCH/).slice(1)) {
					const s = (chunk.match(/Subject:\s*([^\r\n]*(?:\r\n[ \t][^\r\n]*)*)/i) || [])[1];
					const dt = (chunk.match(/^Date:\s*([^\r\n]*)/im) || [])[1];
					// Line-anchored so a Resent-From / X-Google-Original-From can never
					// stand in for the envelope author.
					const fr = (chunk.match(/^From:\s*([^\r\n]*(?:\r\n[ \t][^\r\n]*)*)/im) || [])[1];
					if (s) emails.push({
						subject: decodeSubject(s),
						date: (dt || "").trim(),
						from: (fr || "").replace(/\r\n[ \t]+/g, " ").trim(),
						fromAddress: parseFromAddress(fr),
					});
				}
				step = 9; send("LOGOUT"); return;
			}
			if (step === 9) finish(null, emails);
		});
	});
}

module.exports = {
	fetchRateConSubjects,
	extractLoadNumbers,
	findMissingLoads,
	isImplausibleLoadNumber,
	decodeSubject,
	normLoadKey,
	parseFromAddress,
	isSelfSent,
	splitSelfSent,
};
