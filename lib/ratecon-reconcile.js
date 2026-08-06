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

// emails: [{ subject, date }] ; sheetLoadIds: iterable of raw sheet load ids.
// Returns one entry per load number that appeared in a rate-con subject and has
// no row in the sheet.
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
				step = 4; send("FETCH " + ids.join(",") + " (BODY.PEEK[HEADER.FIELDS (SUBJECT DATE)])"); return;
			}
			if (step === 4) {
				for (const chunk of buf.split(/\* \d+ FETCH/).slice(1)) {
					const s = (chunk.match(/Subject:\s*([^\r\n]*(?:\r\n[ \t][^\r\n]*)*)/i) || [])[1];
					const dt = (chunk.match(/^Date:\s*([^\r\n]*)/im) || [])[1];
					if (s) emails.push({ subject: decodeSubject(s), date: (dt || "").trim() });
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
};
