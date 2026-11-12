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
//     failure, an unanswered send, or loads changed after their send: a third held
//     within a day with AUTO_INVOICE_HOLD_ONE_LOAD on, any one with it off; only
//     scripts/auto-invoice-send-resume.js clears it).
// Such a load waits, neither sent nor drafted, until AUTO_INVOICE_SEND_SETTLE_MINUTES
// (60) after its newest live POD row, so a later POD page goes with it; a POD time
// that can't be read never sends: the load is drafted (sendDecision()).
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

// Why sending stopped, as stored and as a Super Admin reads it. LOAD_CHANGED_AFTER_SEND is
// the stop with AUTO_INVOICE_HOLD_ONE_LOAD off; with it on, a change holds that load alone
// and stops nothing, however many loads change.
const STOP_WORDS = Object.freeze({
	STOPPED_BY_ADMIN: "A Super Admin stopped automatic sending.",
	SMTP_LOGIN_REFUSED: "Gmail refused the mailbox login for sending.",
	SMTP_REFUSED: "Gmail refused an invoice email.",
	SEND_UNANSWERED: "Gmail did not answer an invoice email, so it may have been sent.",
	MAYBE_SENT: "An invoice email may have been sent but was not found in Sent Mail.",
	LOAD_CHANGED_AFTER_SEND: "A load changed after its invoice was sent.",
});
const STOP_REASONS = Object.freeze(Object.keys(STOP_WORDS));

// ── the alert emails (AUTO_INVOICE_ALERT_TO) ─────────────────────────────────

// What the job emails when a sent load is held, or sending stops: load IDs, invoice numbers and
// field names, never an amount, an address or a name, and no attachment. Both subjects are on
// lib/invoice-mailbox-search.js's APP_ALERT_SUBJECTS by their exact shape, so the "already
// billed?" look never reads one as an invoice; the held load's subject never says "invoice".
const STOP_ALERT_SUBJECT = "Automatic invoice sending stopped";
const HELD_ALERT_FIELDS = Object.freeze({ payment: "payment", brokerEmail: "broker email", rateCons: "rate con", trailer: "trailer", pods: "PODs" });

function escHtml(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
const listed = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const alertHtml = (sentences) => sentences.map((s) => `<p>${escHtml(s)}</p>`).join("\n");

// A sent load held: { subject, text, html }. `continues`: other loads keep sending (sending is on
// and not stopped). A load set back from Delivered, cancelled or deleted gets no Mark checked line.
function heldAlert({ loadId = "", invoiceId = "", fields = [], continues = false } = {}) {
	const names = fields.filter((f) => HELD_ALERT_FIELDS[f]).map((f) => HELD_ALERT_FIELDS[f]);
	const undone = fields.includes("removed") ? "the load was cancelled or removed" : fields.includes("status") ? "the load was set back from Delivered" : "";
	const what = [undone, names.length ? `its ${listed(names)} changed` : ""].filter(Boolean).join(" and ");
	const sentences = [`Invoice ${invoiceId} already went to the broker.`, `After that, ${what}.`];
	if (continues) sentences.push("Other loads keep sending.");
	if (!undone) sentences.push("Check whether the broker needs a corrected invoice, then press Mark checked on the load.");
	return { subject: `Load ${String(loadId).replace(/\s+/g, " ").trim()}: changed after sending, needs a check`, text: sentences.join(" "), html: alertHtml(sentences) };
}

// Sending stopped: { subject, text, html }, its reason's words first.
function stopAlert(reason) {
	const sentences = [STOP_WORDS[reason] || "Automatic sending stopped.", "New invoices become Gmail drafts for a person to send until sending is resumed on the server.",
		"Drafts made during the stop stay drafts afterwards."];
	return { subject: STOP_ALERT_SUBJECT, text: sentences.join(" "), html: alertHtml(sentences) };
}

// ── settings ─────────────────────────────────────────────────────────────────

// { enabled, domains, refused, settleMinutes }. `domains`: each entry of
// AUTO_INVOICE_SEND_DOMAINS (commas or spaces between) that the confirmed-domain
// rule accepts, lower case, sorted; `refused`: how many it didn't (free mail, not a
// domain). Nothing listed sends nothing. `settleMinutes`: settleMinutesOf().
function readSettings(env = {}, { replica = false } = {}) {
	const e = env || {};
	// Read through `env` so the replica export's reader finds the flag (lib/replica-rules.js namesReadBy).
	const enabled = replica !== true && String(env?.AUTO_INVOICE_SEND_ENABLED ?? "").trim() === "true";
	const entries = String(e.AUTO_INVOICE_SEND_DOMAINS ?? "").split(/[\s,]+/).filter(Boolean).slice(0, DOMAINS_MAX);
	const domains = new Set();
	let refused = 0;
	for (const entry of entries) {
		const one = rules.normalizeConfirmedDomains([entry]);
		if (one.ok) one.domains.forEach((d) => domains.add(d));
		else refused++;
	}
	return { enabled, domains: [...domains].sort(), refused, settleMinutes: settleMinutesOf(env?.AUTO_INVOICE_SEND_SETTLE_MINUTES) };
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

// ── the settle window ────────────────────────────────────────────────────────

// How long a send waits after the load's newest live POD row:
// AUTO_INVOICE_SEND_SETTLE_MINUTES, a whole number from 0 to 1440 (a day). Unset, or
// anything else (a sign, a fraction, more than a day), is 60.
const SETTLE_MINUTES_DEFAULT = 60;
const SETTLE_MINUTES_MAX = 24 * 60;
function settleMinutesOf(value) {
	const s = String(value ?? "").trim();
	if (!/^\d{1,4}$/.test(s)) return SETTLE_MINUTES_DEFAULT;
	const n = Number(s);
	return n <= SETTLE_MINUTES_MAX ? n : SETTLE_MINUTES_DEFAULT;
}

// A POD row's time as the ledger reads it (lib/auto-invoice-ledger.js
// livePodTimes()): SQLite's own reading of the stored UTC stamp, to the second.
const POD_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// A POD time later than the server's clock by more than this can't end a wait.
const POD_TIME_AHEAD_MS = 5 * MINUTE_MS;

// { settled, untilMs }: the load may go from untilMs, settleMinutes after its newest
// live POD time. { settled: false, unknown: true } when no time proves the wait is
// over: no POD time, one that can't be read, or one ahead of the clock.
function settleState({ podTimes = [], nowMs = NaN, settleMinutes } = {}) {
	const now = Number(nowMs);
	const times = (Array.isArray(podTimes) ? podTimes : []).map((t) => (typeof t === "string" && POD_TIME_RE.test(t) ? Date.parse(t) : NaN));
	if (!Number.isFinite(now) || !times.length || times.some((t) => !Number.isFinite(t) || t > now + POD_TIME_AHEAD_MS)) return { settled: false, unknown: true };
	const untilMs = Math.max(...times) + settleMinutesOf(settleMinutes) * MINUTE_MS;
	return { settled: now >= untilMs, untilMs };
}

// gate(), then the settle window, whose POD times (`podTimes()`) are read only for a
// message gate() would send: { send: true }, { send: false, why } to draft it (also
// POD_TIME_UNKNOWN), or { send: false, why: "SETTLING", untilMs }: it waits.
function sendDecision({ settings, on = false, stopped = false, to = "", podTimes = () => [], nowMs = NaN } = {}) {
	const g = gate({ settings, on, stopped, to });
	if (!g.send) return g;
	const s = settleState({ podTimes: podTimes(), nowMs, settleMinutes: settings.settleMinutes });
	if (s.settled) return g;
	return s.unknown ? { send: false, why: "POD_TIME_UNKNOWN" } : { send: false, why: "SETTLING", untilMs: s.untilMs };
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

// The setup timeouts nodemailer names (timeoutType): connecting, the greeting, the
// TLS upgrade. A socket timeout can come after the message, so it isn't one.
const SETUP_TIMEOUTS = new Set(["CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT"]);

// What an SMTP failure means for the message: "login" (the login was refused),
// "refused" (provably before the message's body was sent: nothing delivered) or
// "unknown" (it may have been delivered: never sent again). `phase` "verify" is
// the connect-and-login that carries no message. In "send", nodemailer tags a
// dropped connection or a timeout "CONN" at any stage, after the body included,
// so only codes that place the failure before the body count.
function smtpOutcome(e, phase = "send") {
	const code = String((e && e.code) || "");
	if (code === "EAUTH" || code === "ENOAUTH") return "login";
	if (phase === "verify") return "refused";
	if (code === "SEND_SETUP" || code === "EENVELOPE" || code === "EREQUIRETLS" || code === "EDNS") return "refused";
	const command = String((e && e.command) || "");
	if (code === "EMESSAGE" && (command === "API" || command === "MAIL FROM")) return "refused";
	if (code === "ETIMEDOUT" && SETUP_TIMEOUTS.has(String((e && e.timeoutType) || ""))) return "refused";
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
		let phase = "verify";
		try {
			// Connect and log in on a connection that carries no message, so a
			// failure there is known to come before it.
			await transport.verify();
			phase = "send";
			await transport.sendMail({
				from, to, subject, html, attachments, messageId,
				// Exactly one recipient on the envelope, whatever the headers say.
				envelope: { from: user, to: [to] },
				disableFileAccess: true,
				disableUrlAccess: true,
			});
			return { ok: true };
		} catch (e) {
			throw Object.assign(new Error("invoice send failed"), { code: safeCode(e), outcome: smtpOutcome(e, phase) });
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
	STOP_ALERT_SUBJECT,
	heldAlert,
	stopAlert,
	SETTLE_MINUTES_DEFAULT,
	SETTLE_MINUTES_MAX,
	readSettings,
	gate,
	settleMinutesOf,
	settleState,
	sendDecision,
	outgoingCheck,
	smtpOutcome,
	createSmtpSender,
	claimSent,
	buttonRefusal,
};
