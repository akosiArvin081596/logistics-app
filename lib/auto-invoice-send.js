// Automatic broker invoice SENDS (AUTO_INVOICE_SEND_ENABLED): when the automatic
// invoice job (lib/auto-invoice-job.js) sends a load's invoice email by SMTP
// instead of leaving a Gmail draft, the last check on the outgoing message, the
// SMTP sender, and the Draft Invoice button's refusal for a load the job sent.
//
// A load is sent only when all of these hold, else it is drafted as before:
//   - AUTO_INVOICE_SEND_ENABLED is exactly "true", never in a replica, and the job
//     makes real drafts (mode "on");
//   - the recipient's domain is exactly on AUTO_INVOICE_SEND_DOMAINS (a server-only
//     list; a subdomain of a listed domain is not on it);
//   - sending isn't stopped (a Super Admin's Stop, or an automatic stop after an SMTP
//     failure, an unanswered send or a load changed after its send; only
//     scripts/auto-invoice-send-resume.js clears it).
// The message is the one the draft would have been (buildMessage()): the invoice
// PDF, every POD and the rate con, as they are, to the one recipient the job's
// recipient rule allows. Right before the SMTP call the job runs outgoingCheck()
// and then, in one transaction, the hand-draft check, the stop and the factoring
// marker (lib/auto-invoice-ledger.js beginSend()); a marker that can't be read
// counts as factored. A send whose answer was lost is never sent again: Sent Mail
// is searched for its Message-ID instead.
//
// Pure except createSmtpSender(), which is handed nodemailer and opens a
// connection only when its sender is called.

"use strict";

const rules = require("./auto-invoice-rules");
const factoring = require("./factoring-store");

const MINUTE_MS = 60 * 1000;
// Where Gmail keeps what the mailbox sent by SMTP.
const SENT_MAILBOX = "[Gmail]/Sent Mail";
// After a send with no answer, Sent Mail is searched at once, then this long
// after the send; still not found after the last one, a person checks
// (MAYBE_SENT).
const SEARCH_AFTER_MS = Object.freeze([0, 15 * MINUTE_MS, 60 * MINUTE_MS]);
// Short enough that a hung connection ends well inside the claim's 15-minute lease.
const SMTP_TIMEOUTS = Object.freeze({ connectionTimeout: 30 * 1000, greetingTimeout: 30 * 1000, socketTimeout: 2 * MINUTE_MS });
const DOMAINS_MAX = 50;

// Why sending stopped, as stored and as a Super Admin reads it.
const STOP_WORDS = Object.freeze({
	STOPPED_BY_ADMIN: "A Super Admin stopped automatic sending.",
	SMTP_LOGIN_REFUSED: "Gmail refused the mailbox login for sending.",
	SMTP_REFUSED: "Gmail refused an invoice email.",
	SEND_UNANSWERED: "Gmail did not answer an invoice email, so it may have been sent.",
	MAYBE_SENT: "An invoice email may have been sent but was not found in Sent Mail.",
	LOAD_CHANGED_AFTER_SEND: "A load changed after its invoice was sent.",
});
const STOP_REASONS = Object.freeze(Object.keys(STOP_WORDS));

// ── settings ─────────────────────────────────────────────────────────────────

// { enabled, domains, refused }. `domains`: each entry of AUTO_INVOICE_SEND_DOMAINS
// (commas or spaces between) that the confirmed-domain rule accepts, lower case,
// sorted; `refused`: how many it didn't (free mail, not a domain). Nothing listed
// sends nothing.
function readSettings(env = {}, { replica = false } = {}) {
	const e = env || {};
	const enabled = replica !== true && String(e.AUTO_INVOICE_SEND_ENABLED ?? "").trim() === "true";
	const entries = String(e.AUTO_INVOICE_SEND_DOMAINS ?? "").split(/[\s,]+/).filter(Boolean).slice(0, DOMAINS_MAX);
	const domains = new Set();
	let refused = 0;
	for (const entry of entries) {
		const one = rules.normalizeConfirmedDomains([entry]);
		if (one.ok) one.domains.forEach((d) => domains.add(d));
		else refused++;
	}
	return { enabled, domains: [...domains].sort(), refused };
}

// ── the gate ─────────────────────────────────────────────────────────────────

// Send this message, or draft it? { send: true } or { send: false, why }.
// `settings` as readSettings() gives them, `on` the job is in real-draft mode,
// `stopped` a stop is set, `to` the recipient the render resolved.
function gate({ settings, on = false, stopped = false, to = "" } = {}) {
	if (!settings || settings.enabled !== true || on !== true) return { send: false, why: "OFF" };
	if (stopped) return { send: false, why: "STOPPED" };
	const domain = rules.emailDomain(to);
	if (!domain || !(settings.domains || []).includes(domain)) return { send: false, why: "DOMAIN_NOT_LISTED" };
	return { send: true };
}

// ── the last check on the outgoing message ───────────────────────────────────

const MESSAGE_KEYS = Object.freeze(["attachments", "html", "subject", "to"]);
const INVOICE_ORDER_RE = /Invoice Order #([^\\/]{1,80})\.pdf$/;

// Right before the SMTP call: the message's own To is the single planned
// recipient, its domain is on the list, there is no Cc or Bcc, and the
// attachments are the render's own: the invoice PDF first, then the POD files,
// then the rate con, named for the invoice's own order number (the engine's auto
// mode finds the rate con by file name, never by reading Drive). null when all
// hold, else which failed: "RECIPIENT", "HEADERS" or "ATTACHMENTS".
function outgoingCheck({ message, rendered, planned = "", domains = [] } = {}) {
	const m = message || {};
	const to = typeof m.to === "string" ? m.to : "";
	if (!to || rules.normalizeEmail(to) !== to || to.toLowerCase() !== String(planned || "").toLowerCase()) return "RECIPIENT";
	if (!(domains || []).includes(rules.emailDomain(to))) return "RECIPIENT";
	if (JSON.stringify(Object.keys(m).sort()) !== JSON.stringify(MESSAGE_KEYS)) return "HEADERS";
	if (typeof m.subject !== "string" || !m.subject || typeof m.html !== "string" || !m.html) return "HEADERS";
	const atts = m.attachments;
	if (!rendered || !Array.isArray(atts) || atts !== rendered.attachments || atts.length < 3) return "ATTACHMENTS";
	const names = atts.map((a) => (a && typeof a.filename === "string" ? a.filename : ""));
	if (!atts.every((a, i) => names[i] && a && Buffer.isBuffer(a.content) && a.content.length > 0)) return "ATTACHMENTS";
	if (rules.invoiceAttachmentIndex(names) !== 0) return "ATTACHMENTS";
	const order = INVOICE_ORDER_RE.exec(names[0]);
	if (!order) return "ATTACHMENTS";
	const rateCon = `${order[1]}.pdf`;
	if (names[names.length - 1] !== rateCon || names.indexOf(rateCon) !== names.length - 1) return "ATTACHMENTS";
	return null;
}

// ── SMTP ─────────────────────────────────────────────────────────────────────

// What an SMTP failure means for the message: "login" (refused before anything
// was sent), "refused" (the server answered no, or never connected: nothing was
// delivered) or "unknown" (it may have been delivered: never sent again).
function smtpOutcome(e) {
	const code = String((e && e.code) || "");
	if (code === "EAUTH" || code === "ENOAUTH") return "login";
	if (code === "EENVELOPE" || code === "EMESSAGE" || code === "EREQUIRETLS" || code === "EDNS") return "refused";
	if (String((e && e.command) || "") === "CONN") return "refused";
	return "unknown";
}

const safeCode = (e) => {
	const c = e && e.code;
	return typeof c === "string" && /^[A-Za-z0-9_]{1,40}$/.test(c) ? c : "ERROR";
};

// The sender the job is given: one message, one recipient, through Gmail's SMTP
// with the mailbox's own login (Gmail keeps the copy in Sent Mail). Resolves {
// ok: true }; rejects with { code, outcome } (smtpOutcome()), never the server's
// text, which can carry an address.
function createSmtpSender({ nodemailer } = {}) {
	return async function sendInvoiceMail({ user, pass, from, to, subject, html, attachments, messageId } = {}) {
		if (!nodemailer || !user || !pass || !to || !messageId) {
			throw Object.assign(new Error("invoice send not set up"), { code: "SEND_SETUP", outcome: "refused" });
		}
		const transport = nodemailer.createTransport({ service: "gmail", auth: { user, pass }, ...SMTP_TIMEOUTS });
		try {
			await transport.sendMail({
				from, to, subject, html, attachments, messageId,
				// Exactly one recipient on the envelope, whatever the headers say.
				envelope: { from: user, to: [to] },
				disableFileAccess: true,
				disableUrlAccess: true,
			});
			return { ok: true };
		} catch (e) {
			throw Object.assign(new Error("invoice send failed"), { code: safeCode(e), outcome: smtpOutcome(e) });
		} finally {
			try {
				transport.close();
			} catch {
				// closing a transport that never opened
			}
		}
	};
}

// ── the Draft Invoice button ─────────────────────────────────────────────────

// The job's claim was sent, or may have been: a send was started (stage
// appending or later, delivery 'send').
const claimSent = (c) => Boolean(c && c.delivery === "send" && ["appending", "appended", "recorded"].includes(c.stage));

// Before anything is read or minted for a press. `claim` the load's automatic
// claim (or null); `sendEnabled` sending is on; `body` the request. null (go on),
// { ok: true, reissue: { invoiceId, reason } } (a re-issue confirmed with a
// reason), or a refusal { ok: false, http, code, error, invoiceId? }. A claim
// sent stays refused with sending off too: the invoice already went out.
function buttonRefusal({ claim, sendEnabled = false, body = {} } = {}) {
	if (!claim) return null;
	if (claimSent(claim)) {
		const b = body && typeof body === "object" ? body : {};
		const reason = factoring.cleanReason(b.reissueReason);
		if (b.confirmReissue === true && reason) return { ok: true, reissue: { invoiceId: claim.invoice_id, reason } };
		const maybe = claim.stage === "appending";
		return {
			ok: false, http: 409, code: "INVOICE_ALREADY_SENT", invoiceId: claim.invoice_id,
			error: maybe
				? `Invoice #${claim.invoice_id} for this load may already have been sent to the broker automatically. Check Gmail Sent Mail. To issue another invoice anyway, confirm a re-issue with a reason.`
				: `Invoice #${claim.invoice_id} for this load was already sent to the broker automatically. To issue another invoice, confirm a re-issue with a reason.`,
		};
	}
	if (sendEnabled === true && claim.state === "working") {
		return { ok: false, http: 409, code: "AUTO_INVOICE_IN_FLIGHT", error: factoring.WORDS.AUTO_INVOICE_IN_FLIGHT };
	}
	return null;
}

module.exports = {
	SENT_MAILBOX,
	SEARCH_AFTER_MS,
	SMTP_TIMEOUTS,
	STOP_WORDS,
	STOP_REASONS,
	readSettings,
	gate,
	outgoingCheck,
	smtpOutcome,
	createSmtpSender,
	claimSent,
	buttonRefusal,
};
