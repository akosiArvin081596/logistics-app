// Automatic broker invoice drafts (AUTO_INVOICE_DRAFTS_ENABLED): the rules.
//
// Which completed load the job may draft, which it waits on, which it hands to a
// person ("needs attention") and which it leaves alone, each with a reason code;
// the recipient rule; the off-gap and baseline rules; the "load changed after
// its draft" fingerprint; retry backoff, caps and pauses; the mode settings.
// lib/auto-invoice-job.js applies them to the live sheet and SQLite, and
// scripts/auto-invoice-shadow-report.js to a copy, so both read one rule.
//
// Pure: no network, database or files. Callers pass the rows they read (the SQL
// they read them with is here too, as text, so the job and the report run the
// same queries) and get plain values back. Sheet dates arrive as day keys
// ("YYYY-MM-DD") the caller made with server.js's sheetDayKey().
//
// The client words the codes (client/src/lib/autoInvoiceStatus.js); the two lists
// are pinned equal by scripts/test-auto-invoice-status-client.mjs.

"use strict";

const path = require("path");
const { moneyCents } = require("./cell-compare");

// DISPATCH_COMPLETED_RE in server.js: anchored, so the job is never looser than
// the draft route's own (unanchored) gate.
const COMPLETED_RE = /^(delivered|completed|pod received)$/i;
// CANCELED_STATUS_RE in server.js (excludeDroppedLoads()).
const CANCELLED_RE = /^(cancel|canceled|cancelled)$/i;

const STATES = Object.freeze(["baseline", "waiting", "queued", "working", "drafted", "needs_attention", "skipped"]);
const STAGES = Object.freeze(["", "reserved", "rendered", "appending", "appended", "recorded"]);
const SHADOW_VERDICTS = Object.freeze(["BASELINE", "WOULD_ATTEMPT", "WOULD_WAIT", "WOULD_NEED_ATTENTION", "WOULD_SKIP"]);

// Every reason a claim or a shadow row can carry. "" is "none" (queued, drafted,
// baseline).
const REASON_CODES = Object.freeze([
	// waiting
	"WAITING_POD", "NOT_COMPLETED", "LOAD_DROPPED", "RATECON_MISSING",
	// queued again after a temporary failure
	"RETRY_LATER", "GEMINI_DOWN", "RENDERER_BUSY", "MAILBOX_PAUSED", "SETTINGS_UNREADABLE",
	// skipped
	"ALREADY_DRAFTED", "DRAFTED_BY_HAND", "BROKER_OPTED_OUT",
	// needs attention: free checks
	"NO_BROKER_EMAIL", "CLOSED_MONTH", "MONTH_UNKNOWN", "NO_DELIVERY_DATE", "ADVANCE_LINES",
	"POD_UNREADABLE", "RECIPIENT_UNCONFIGURED", "OFF_GAP",
	// needs attention: found while drafting
	"BROKER_EMAIL_FREEMAIL", "BROKER_DOMAIN_UNCONFIRMED",
	"NO_BILLING_EMAIL", "RECIPIENT_DOMAIN_MISMATCH", "RATECON_BY_CONTENT", "TOTAL_MISMATCH",
	"POD_PAGE_UNREADABLE", "INVOICE_REFS_REQUIRED", "INVOICE_TOTAL_UNKNOWN", "TRAILER_MISMATCH",
	"DRAFT_REFUSED", "DRAFT_FAILED", "MAYBE_IN_GMAIL", "IN_GMAIL_UNRECORDED",
]);

// Engine refusals that mean "a person must look", by the engine's own code.
const ATTENTION_REFUSALS = Object.freeze([
	"NO_BILLING_EMAIL", "RECIPIENT_DOMAIN_MISMATCH", "RECIPIENT_UNCONFIGURED", "RATECON_BY_CONTENT",
	"NO_BROKER_EMAIL", "BROKER_EMAIL_FREEMAIL", "BROKER_DOMAIN_UNCONFIRMED",
	"TOTAL_MISMATCH", "POD_PAGE_UNREADABLE", "ADVANCE_LINES", "NO_DELIVERY_DATE",
	"INVOICE_REFS_REQUIRED", "INVOICE_TOTAL_UNKNOWN", "TRAILER_MISMATCH",
]);
// Engine refusals that mean "not ready yet": the load left Delivered, its POD or
// row went away.
const WAIT_REFUSALS = Object.freeze(["NOT_COMPLETED", "POD_NOT_FOUND", "LOAD_NOT_FOUND"]);

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// A sweep that finds the last on-mode sweep older than this is the first after
// an off gap: loads completed in the gap go to a person (OFF_GAP).
const OFF_GAP_MS = 2 * HOUR_MS;
// A temporary failure retries after each of these; the next failure after the
// last one is DRAFT_FAILED.
const RETRY_DELAYS_MS = Object.freeze([15 * MINUTE_MS, HOUR_MS, 4 * HOUR_MS]);
// No rate con found yet: look again every 2 hours, three times, then a person.
const RATECON_RECHECK_MS = 2 * HOUR_MS;
const RATECON_MAX_CHECKS = 3;
// The engine said "not ready" (no POD, no row, not delivered) while the free
// checks said ready: after this many, a person looks (the two disagree).
const ENGINE_WAIT_MAX = 3;
// Try again on a number reserved longer ago than this reserves a fresh one, so an
// invoice never carries an old day's number and date.
const STALE_RESERVATION_MS = 24 * HOUR_MS;
// Gemini down (or seen down by ingestion this recently): non-Bison loads wait.
const GEMINI_WAIT_MS = 30 * MINUTE_MS;
// IMAP LOGIN refused: pause everything, doubling from 1 h up to 6 h.
const LOGIN_PAUSE_FIRST_MS = HOUR_MS;
const LOGIN_PAUSE_MAX_MS = 6 * HOUR_MS;
const DEFAULT_MAX_PER_HOUR = 12;
const DEFAULT_MAX_PER_DAY = 60;
const MAX_PER_SWEEP = 2;
const OPT_OUT_MAX = 200;

const EMAIL_MAX = 254;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// normalizeEmail() in lib/broker-invoice.js: the address a draft may go to.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const EMAIL_TRAILING_PUNCTUATION = ".,;>)]";

// ── modes and settings ───────────────────────────────────────────────────────

// "off" | "shadow" | "on". Off unless ENABLED is exactly "true"; on (real drafts)
// only when SHADOW is also exactly "false", so a lone ENABLED=true gives shadow.
function readMode(env = {}) {
	if (String((env && env.AUTO_INVOICE_DRAFTS_ENABLED) ?? "").trim() !== "true") return "off";
	return String((env && env.AUTO_INVOICE_DRAFTS_SHADOW) ?? "").trim() === "false" ? "on" : "shadow";
}

// A whole number from 1 to `max`, else the default.
function positiveSetting(v, fallback, max) {
	const s = String(v ?? "").trim();
	if (!/^\d{1,6}$/.test(s)) return fallback;
	const n = Number(s);
	return n >= 1 && n <= max ? n : fallback;
}

function readCaps(env = {}) {
	return {
		maxPerHour: positiveSetting(env && env.AUTO_INVOICE_MAX_PER_HOUR, DEFAULT_MAX_PER_HOUR, 1000),
		maxPerDay: positiveSetting(env && env.AUTO_INVOICE_MAX_PER_DAY, DEFAULT_MAX_PER_DAY, 10000),
		perSweep: MAX_PER_SWEEP,
	};
}

// ── load keys, statuses, emails, domains ─────────────────────────────────────

// normLoadKey() in server.js: trimmed, lower case, one leading "#" dropped.
function loadKey(v) {
	return String(v == null ? "" : v).trim().toLowerCase().replace(/^#/, "");
}

function isCompletedStatus(s) {
	return COMPLETED_RE.test(String(s == null ? "" : s).trim());
}

function isCancelledStatus(s) {
	return CANCELLED_RE.test(String(s == null ? "" : s).trim());
}

// The address as normalizeEmail() keeps it, or "".
function normalizeEmail(v) {
	const raw = String(v == null ? "" : v).trim();
	if (raw.length > EMAIL_MAX + 8) return "";
	let end = raw.length;
	while (end > 0 && EMAIL_TRAILING_PUNCTUATION.includes(raw[end - 1])) end--;
	const s = raw.slice(0, end);
	return s.length <= EMAIL_MAX && EMAIL_RE.test(s) ? s : "";
}

// The part after the "@", lower case, when the whole is an address with a
// readable domain; "" otherwise.
function emailDomain(v) {
	const email = normalizeEmail(v);
	if (!email) return "";
	const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
	return DOMAIN_RE.test(domain) ? domain : "";
}

// isBisonLoad() in lib/broker-invoice.js, on the sheet's broker Email.
function isBisonEmail(email) {
	return /bisontransport\.com$/i.test(String(email == null ? "" : email).trim().toLowerCase());
}

// An opted-out domain covers its subdomains: opting out only ever drafts less.
function domainOptedOut(domain, optOutDomains) {
	const d = String(domain || "").toLowerCase();
	if (!d) return false;
	for (const o of optOutDomains || []) {
		if (d === o || d.endsWith("." + o)) return true;
	}
	return false;
}

// The opt-out list as stored: lower-case domains, each once, sorted. A list that
// isn't one is refused whole, never trimmed to fit.
function normalizeOptOutDomains(list) {
	if (!Array.isArray(list)) return { ok: false, code: "OPT_OUT_INVALID", error: "optOutDomains must be a list of domains." };
	if (list.length > OPT_OUT_MAX) return { ok: false, code: "OPT_OUT_TOO_MANY", error: `At most ${OPT_OUT_MAX} domains can be opted out.` };
	const out = new Set();
	for (const item of list) {
		const d = typeof item === "string" ? item.trim().toLowerCase().replace(/^@/, "") : "";
		if (!DOMAIN_RE.test(d)) return { ok: false, code: "OPT_OUT_INVALID", error: "Each opted-out entry must be a domain, such as example.com." };
		out.add(d);
	}
	return { ok: true, domains: [...out].sort() };
}

// Mail providers anyone can sign up to: a broker Email on one of these says
// nothing about who may bill that broker, so it never confirms a recipient. A
// domain listed here, or a subdomain of one, counts.
const FREEMAIL_DOMAINS = Object.freeze([
	"gmail.com", "googlemail.com",
	"outlook.com", "hotmail.com", "hotmail.co.uk", "hotmail.ca", "live.com", "live.ca", "msn.com", "passport.com",
	"yahoo.com", "yahoo.ca", "yahoo.co.uk", "ymail.com", "rocketmail.com",
	"aol.com", "aim.com",
	"icloud.com", "me.com", "mac.com",
	"proton.me", "protonmail.com", "protonmail.ch", "pm.me",
	"gmx.com", "gmx.net", "gmx.us", "gmx.de",
	"mail.com", "email.com", "usa.com",
	"zoho.com", "zohomail.com",
	"yandex.com", "yandex.ru",
	"tutanota.com", "tuta.io", "fastmail.com", "hushmail.com", "inbox.com",
	"att.net", "sbcglobal.net", "bellsouth.net", "comcast.net", "verizon.net", "cox.net", "charter.net", "earthlink.net",
]);

function isFreemailDomain(domain) {
	const d = String(domain || "").toLowerCase();
	return Boolean(d) && FREEMAIL_DOMAINS.some((f) => d === f || d.endsWith("." + f));
}

// The confirmed broker domains as stored: like the opt-out list, and a free-mail
// domain is refused (it can never vouch for a recipient).
function normalizeConfirmedDomains(list) {
	if (!Array.isArray(list)) return { ok: false, code: "CONFIRMED_DOMAINS_INVALID", error: "confirmedBrokerDomains must be a list of domains." };
	if (list.length > OPT_OUT_MAX) return { ok: false, code: "CONFIRMED_DOMAINS_TOO_MANY", error: `At most ${OPT_OUT_MAX} domains can be confirmed.` };
	const out = new Set();
	for (const item of list) {
		const d = typeof item === "string" ? item.trim().toLowerCase().replace(/^@/, "") : "";
		if (!DOMAIN_RE.test(d)) return { ok: false, code: "CONFIRMED_DOMAINS_INVALID", error: "Each confirmed entry must be a domain, such as example.com." };
		if (isFreemailDomain(d)) return { ok: false, code: "CONFIRMED_DOMAIN_FREEMAIL", error: `${d} is a free-mail domain and can't be confirmed for automatic drafts.` };
		out.add(d);
	}
	return { ok: true, domains: [...out].sort() };
}

// ── the recipient rule ───────────────────────────────────────────────────────

// Whom an automatic draft may go to. Rate-con text never chooses a recipient on
// its own, and the default inbox is never used.
//   - Bison: only the configured AP inbox.
//   - Any other broker: the rate con's documents email only when its domain is
//     exactly the sheet broker Email's domain (lower case; a subdomain or a sister
//     domain is a mismatch), that domain is not free mail, and a person has
//     confirmed it (`confirmedDomains`, the settings' confirmedBrokerDomains).
function recipientRule({ brokerEmail, bisonRecipient, documentsEmail, confirmedDomains = [] } = {}) {
	if (isBisonEmail(brokerEmail)) {
		const to = normalizeEmail(bisonRecipient);
		return to ? { ok: true, to, source: "bison" } : { ok: false, code: "RECIPIENT_UNCONFIGURED" };
	}
	const brokerDomain = emailDomain(brokerEmail);
	if (!brokerDomain) return { ok: false, code: "NO_BROKER_EMAIL" };
	if (isFreemailDomain(brokerDomain)) return { ok: false, code: "BROKER_EMAIL_FREEMAIL" };
	if (!(confirmedDomains || []).includes(brokerDomain)) return { ok: false, code: "BROKER_DOMAIN_UNCONFIRMED" };
	const doc = normalizeEmail(documentsEmail);
	if (!doc) return { ok: false, code: "NO_BILLING_EMAIL" };
	if (emailDomain(doc) !== brokerDomain) return { ok: false, code: "RECIPIENT_DOMAIN_MISMATCH" };
	return { ok: true, to: doc, source: "ratecon" };
}

// ── Job Tracking columns ─────────────────────────────────────────────────────

function findCol(headers, re) {
	return (headers || []).find((h) => re.test(h)) || null;
}

// The columns the job reads, by the same regexes the draft route and
// excludeDroppedLoads() use, so both read the same cells.
function jobColumns(headers) {
	const list = Array.isArray(headers) ? headers : [];
	const trimmed = (re) => list.find((h) => re.test(String(h == null ? "" : h).trim())) ?? null;
	return {
		loadIdCol: findCol(list, /load.?id|job.?id/i),
		statusCol: findCol(list, /^(job[\s._-]?)?status$/i) || findCol(list, /status/i),
		emailCol: findCol(list, /^email$/i) || findCol(list, /broker.*email|email/i),
		completionCol: findCol(list, /completion.*date/i),
		deliveryDateCol: list.find((h) => /status.*update.*date|completion.*date/i.test(h))
			|| list.find((h) => /drop.?off.*date|drop.?off.*appoint|deliv.*date|deliv.*appoint/i.test(h))
			|| null,
		paymentCol: trimmed(/^payment$/i) ?? trimmed(/payment/i),
		trailerCol: findCol(list, /trailer/i),
	};
}

function cell(row, col) {
	return col && row ? String(row[col] == null ? "" : row[col]).trim() : "";
}

// ── local records (documents, drafts, advance lines, soft deletes) ───────────

const POD_TYPES = Object.freeze(["POD"]);
// RATECON_DOC_TYPES in server.js: what counts as a rate con on file.
const RATECON_TYPES = Object.freeze(["RATECON", "RATE CON", "RATE_CON"]);

// The read-only queries both the job and the report run. `documents` needs the
// table's deleted_at column; `documentsNoSoftDelete` is for a copy older than it.
// Advance lines are read through their own module (lib/auto-invoice-ledger.js
// activeAdvanceLines()), never by a query here.
const RECORD_SQL = Object.freeze({
	documents: "SELECT id, load_id, type, file_name, drive_file_id, drive_url, uploaded_at FROM documents " +
		"WHERE deleted_at IS NULL AND UPPER(type) IN ('POD', 'RATECON', 'RATE CON', 'RATE_CON') ORDER BY uploaded_at, id",
	documentsNoSoftDelete: "SELECT id, load_id, type, file_name, drive_file_id, drive_url, uploaded_at FROM documents " +
		"WHERE UPPER(type) IN ('POD', 'RATECON', 'RATE CON', 'RATE_CON') ORDER BY uploaded_at, id",
	drafts: "SELECT id, load_id, invoice_id, recipient, recipient_source, edited, edited_fields, via, created_at FROM load_invoice_drafts ORDER BY id",
	deletedLoads: "SELECT load_id FROM deleted_loads",
});

// The local name fetchDocumentBytes() reads a document from, inside `uploadsRoot`,
// or null when it has none or it would leave that folder.
function documentLocalPath(uploadsRoot, doc) {
	if (!uploadsRoot || !doc) return null;
	const url = String(doc.drive_url || "");
	const name = url.startsWith("/uploads/") ? url.replace("/uploads/", "") : String(doc.file_name || "");
	if (!name) return null;
	const root = path.resolve(uploadsRoot);
	const full = path.join(root, name);
	return full.startsWith(root + path.sep) ? full : null;
}

// Every record, grouped by load key: { pods, rateCons, drafts, deleted }.
function indexRecords({ documents = [], drafts = [], deletedLoads = [] } = {}) {
	const byKey = new Map();
	const get = (k) => {
		let e = byKey.get(k);
		if (!e) {
			e = { pods: [], rateCons: [], drafts: [], deleted: false };
			byKey.set(k, e);
		}
		return e;
	};
	for (const d of documents) {
		const k = loadKey(d.load_id);
		if (!k) continue;
		const type = String(d.type || "").toUpperCase();
		if (POD_TYPES.includes(type)) get(k).pods.push(d);
		else if (RATECON_TYPES.includes(type)) get(k).rateCons.push(d);
	}
	for (const d of drafts) {
		const k = loadKey(d.load_id);
		if (k) get(k).drafts.push(d);
	}
	for (const d of deletedLoads) {
		const k = loadKey(d.load_id);
		if (k) get(k).deleted = true;
	}
	return byKey;
}

const EMPTY_RECORDS = Object.freeze({ pods: [], rateCons: [], drafts: [], deleted: false });

// What the free checks know about one load. `row` may be null (the load is no
// longer on the sheet). `podReadable(doc)` answers true, false, or null when it
// can't tell (a copy without its uploads): null counts as readable.
// `activeAdvanceLines`: the load's advance lines not voided. `confirmedDomains`:
// the broker domains a person has confirmed (settings, confirmedBrokerDomains).
function loadFacts({ row, cols, records, optOutDomains = [], confirmedDomains = [], bisonRecipientConfigured = false, closedMonths, completionDay = "", podReadable = null, activeAdvanceLines = 0 } = {}) {
	const rec = records || EMPTY_RECORDS;
	const status = cell(row, cols && cols.statusCol);
	const brokerEmail = cell(row, cols && cols.emailCol);
	const brokerDomain = emailDomain(brokerEmail);
	const unreadable = rec.pods.filter((d) => {
		const r = typeof podReadable === "function" ? podReadable(d) : null;
		return r === false;
	}).length;
	return {
		loadId: cell(row, cols && cols.loadIdCol),
		onSheet: Boolean(row),
		status,
		completed: Boolean(row) && isCompletedStatus(status),
		live: Boolean(row) && !rec.deleted && !isCancelledStatus(status),
		brokerEmail: normalizeEmail(brokerEmail).toLowerCase(),
		brokerDomain,
		isBison: isBisonEmail(brokerEmail),
		optedOut: domainOptedOut(brokerDomain, optOutDomains),
		brokerEmailFreemail: isFreemailDomain(brokerDomain),
		brokerDomainConfirmed: Boolean(brokerDomain) && (confirmedDomains || []).includes(brokerDomain),
		closedMonths,
		hasDeliveryDate: Boolean(cell(row, cols && cols.deliveryDateCol)),
		completionDay: completionDay || "",
		pods: rec.pods.length,
		podsUnreadable: unreadable,
		podIds: rec.pods.map((d) => Number(d.id)).sort((a, b) => a - b),
		rateConIds: rec.rateCons.map((d) => Number(d.id)).sort((a, b) => a - b),
		drafts: rec.drafts.length,
		activeAdvanceLines: Number(activeAdvanceLines) || 0,
		bisonRecipientConfigured: Boolean(bisonRecipientConfigured),
		paymentCents: moneyCents(cell(row, cols && cols.paymentCol)),
		trailer: normTrailer(cell(row, cols && cols.trailerCol)),
	};
}

function normTrailer(v) {
	return String(v == null ? "" : v).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 40);
}

// ── verdicts ─────────────────────────────────────────────────────────────────

const v = (state, code = "") => ({ state, code });

// The free checks on a load already claimed, or past the baseline, off-gap and
// opt-out questions. `checkMonth: false` skips the closed-month check (the retro
// report: a month closed today was open when the load was delivered);
// `checkDrafted: false` asks what the job would do had nobody drafted it;
// `assumeConfirmed: true`, what it would do once the broker's domain (not free
// mail) is confirmed (the retro report's second split).
function freeVerdict(facts, { checkMonth = true, checkDrafted = true, assumeConfirmed = false } = {}) {
	const f = facts || {};
	if (!f.live) return v("waiting", "LOAD_DROPPED");
	if (!f.completed) return v("waiting", "NOT_COMPLETED");
	if (checkDrafted && f.drafts > 0) return v("skipped", "ALREADY_DRAFTED");
	if (f.optedOut) return v("skipped", "BROKER_OPTED_OUT");
	if (!f.brokerDomain) return v("needs_attention", "NO_BROKER_EMAIL");
	if (!f.isBison) {
		if (f.brokerEmailFreemail) return v("needs_attention", "BROKER_EMAIL_FREEMAIL");
		if (!f.brokerDomainConfirmed && !assumeConfirmed) return v("needs_attention", "BROKER_DOMAIN_UNCONFIRMED");
	}
	if (checkMonth) {
		if (!Array.isArray(f.closedMonths)) return v("needs_attention", "MONTH_UNKNOWN");
		if (f.closedMonths.length) return v("needs_attention", "CLOSED_MONTH");
	}
	if (!f.hasDeliveryDate) return v("needs_attention", "NO_DELIVERY_DATE");
	if (f.activeAdvanceLines > 0) return v("needs_attention", "ADVANCE_LINES");
	if (f.isBison && !f.bisonRecipientConfigured) return v("needs_attention", "RECIPIENT_UNCONFIGURED");
	if (!f.pods) return v("waiting", "WAITING_POD");
	if (f.podsUnreadable > 0) return v("needs_attention", "POD_UNREADABLE");
	return v("queued");
}

// A completed load the job sees for the first time (no claim row).
//   - before the first on-mode baseline, or completed on a day before it: baseline;
//   - drafted already (any source): skipped, checked before the off gap;
//   - opted out: skipped (an off gap never asks a person to draft one by hand);
//   - first sweep after an off gap: a person drafts it (OFF_GAP);
//   - otherwise the free checks.
function newClaimVerdict(facts, { baselineDone = false, baselineDay = "", offGap = false, checkMonth = true } = {}) {
	const f = facts || {};
	if (!baselineDone) return v("baseline");
	if (f.completionDay && baselineDay && f.completionDay < baselineDay) return v("baseline");
	if (f.drafts > 0) return v("skipped", "ALREADY_DRAFTED");
	if (f.optedOut) return v("skipped", "BROKER_OPTED_OUT");
	if (offGap) return v("needs_attention", "OFF_GAP");
	return freeVerdict(f, { checkMonth });
}

// Is this sweep the first after an off gap? `lastOnSweepAt` is an ISO instant or
// "" (none since the baseline: a gap).
function isOffGap(lastOnSweepAt, nowMs, gapMs = OFF_GAP_MS) {
	const last = Date.parse(String(lastOnSweepAt || ""));
	if (!Number.isFinite(last)) return true;
	return nowMs - last > gapMs;
}

function shadowVerdictOf(state) {
	switch (state) {
		case "baseline": return "BASELINE";
		case "queued": return "WOULD_ATTEMPT";
		case "waiting": return "WOULD_WAIT";
		case "needs_attention": return "WOULD_NEED_ATTENTION";
		default: return "WOULD_SKIP";
	}
}

// What a refusal from the engine's prepare() means for the claim:
//   { kind: "temporary" | "wait" | "attention" | "ratecon_missing", code, countsAttempt }.
// While Gemini is down every refusal is temporary and costs no attempt.
function classifyRefusal({ code = "", http = 0, geminiUnavailable = false } = {}) {
	const c = String(code || "");
	if (geminiUnavailable) return { kind: "temporary", code: "GEMINI_DOWN", countsAttempt: false };
	if (c === "RENDERER_BUSY") return { kind: "temporary", code: "RENDERER_BUSY", countsAttempt: false };
	if (c === "RATECON_MISSING") return { kind: "ratecon_missing", code: c, countsAttempt: false };
	if (WAIT_REFUSALS.includes(c)) return { kind: "wait", code: c === "NOT_COMPLETED" ? c : c === "POD_NOT_FOUND" ? "WAITING_POD" : "LOAD_DROPPED", countsAttempt: false };
	if (ATTENTION_REFUSALS.includes(c)) return { kind: "attention", code: c, countsAttempt: false };
	const status = Number(http) || 0;
	if (!status || status >= 500) return { kind: "temporary", code: "RETRY_LATER", countsAttempt: true };
	return { kind: "attention", code: "DRAFT_REFUSED", countsAttempt: false };
}

// The code a claim goes to a person with once the engine has refused it as "not
// ready" ENGINE_WAIT_MAX times: the engine couldn't read a POD the free checks see.
function waitAttentionCode(code) {
	return code === "WAITING_POD" ? "POD_UNREADABLE" : String(code || "DRAFT_REFUSED");
}

// After `failures` temporary failures (1, 2, …): the wait before the next try,
// or null when the claim goes to a person (DRAFT_FAILED).
function retryDelayMs(failures) {
	const n = Number(failures) || 0;
	return n >= 1 && n <= RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[n - 1] : null;
}

// The pause after an IMAP LOGIN refusal, given the last one (0 when none).
function loginPauseMs(previousMs) {
	const prev = Number(previousMs) || 0;
	return prev <= 0 ? LOGIN_PAUSE_FIRST_MS : Math.min(prev * 2, LOGIN_PAUSE_MAX_MS);
}

// May another draft start? One in flight, `perSweep` per sweep, the hourly and
// daily caps.
function capsAllow({ inFlight = 0, startedThisSweep = 0, draftedLastHour = 0, draftedLastDay = 0, caps } = {}) {
	const c = caps || readCaps({});
	if (inFlight > 0) return false;
	if (startedThisSweep >= c.perSweep) return false;
	if (draftedLastHour >= c.maxPerHour) return false;
	return draftedLastDay < c.maxPerDay;
}

// ── "draft made, load changed" ───────────────────────────────────────────────

// What a draft was made from, as the sweep can see it for free.
function fingerprint(facts) {
	const f = facts || {};
	return {
		completed: Boolean(f.completed),
		live: Boolean(f.live),
		paymentCents: f.paymentCents ?? null,
		brokerEmail: String(f.brokerEmail || ""),
		trailer: String(f.trailer || ""),
		podIds: [...(f.podIds || [])],
		rateConIds: [...(f.rateConIds || [])],
	};
}

const FINGERPRINT_FIELDS = Object.freeze([
	["status", (x) => x.completed],
	["removed", (x) => x.live],
	["payment", (x) => x.paymentCents],
	["brokerEmail", (x) => x.brokerEmail],
	["trailer", (x) => x.trailer],
	["pods", (x) => (x.podIds || []).join(",")],
	["rateCons", (x) => (x.rateConIds || []).join(",")],
]);

// The fields that differ between the saved fingerprint and now, in a fixed order.
function fingerprintDiff(saved, now) {
	if (!saved || !now) return [];
	return FINGERPRINT_FIELDS.filter(([, get]) => get(saved) !== get(now)).map(([name]) => name);
}

module.exports = {
	COMPLETED_RE,
	CANCELLED_RE,
	STATES,
	STAGES,
	SHADOW_VERDICTS,
	REASON_CODES,
	ATTENTION_REFUSALS,
	WAIT_REFUSALS,
	OFF_GAP_MS,
	RETRY_DELAYS_MS,
	RATECON_RECHECK_MS,
	RATECON_MAX_CHECKS,
	ENGINE_WAIT_MAX,
	STALE_RESERVATION_MS,
	GEMINI_WAIT_MS,
	LOGIN_PAUSE_FIRST_MS,
	LOGIN_PAUSE_MAX_MS,
	RECORD_SQL,
	POD_TYPES,
	RATECON_TYPES,
	readMode,
	readCaps,
	loadKey,
	isCompletedStatus,
	isCancelledStatus,
	normalizeEmail,
	emailDomain,
	isBisonEmail,
	domainOptedOut,
	normalizeOptOutDomains,
	FREEMAIL_DOMAINS,
	isFreemailDomain,
	normalizeConfirmedDomains,
	recipientRule,
	jobColumns,
	documentLocalPath,
	indexRecords,
	loadFacts,
	normTrailer,
	freeVerdict,
	newClaimVerdict,
	isOffGap,
	shadowVerdictOf,
	classifyRefusal,
	waitAttentionCode,
	retryDelayMs,
	loginPauseMs,
	capsAllow,
	fingerprint,
	fingerprintDiff,
};
