"use strict";
// The email an account gets after its password changes (B21), whoever changed
// it: an administrator through PUT /api/users/:id, or the account itself
// through POST /api/auth/change-password (or a Super Admin editing their own
// account on the Users page, which is "you" as well).
//
//   "Your LogisX password was changed on October 15, 2026 at 1:40 PM EDT by an
//    administrator. If this wasn't you, contact <ADMIN_NOTIFY_EMAIL, else
//    "your administrator">."
//
// It never carries the password: nothing here is ever handed one. The time is
// the business clock (APP_TIMEZONE, US Eastern unless set), never the server's.
//
// Delivery never decides the change. The routes call this AFTER the new hash is
// committed and do not wait for it: no address, an unusable one, mail switched
// off (replica mode, or GMAIL_USER / GMAIL_APP_PASSWORD missing, both decided
// by server.js's sendEmail) or a failed send are logged by account id and the
// change stands. It never throws and its promise never rejects.
//
// No network, database or filesystem: the sender is passed in.

const NOTICE_SUBJECT = "Your LogisX password was changed";
const NOTICE_HEADING = "Your password was changed";
const NO_CONTACT = "your administrator";
// An address this notice will try: one "@", no whitespace or control
// characters, at most 254 characters. Anything else is reported as no usable
// address instead of being handed to the mailer. Checked with a character walk,
// not a pattern.
const MAX_ADDRESS = 254;

function usableAddress(value) {
	if (typeof value !== "string") return "";
	const a = value.trim();
	if (!a || a.length > MAX_ADDRESS) return "";
	let at = -1;
	for (let i = 0; i < a.length; i++) {
		const c = a.charCodeAt(i);
		if (c <= 0x20 || c === 0x7f) return "";
		if (c === 0x40) {
			if (at !== -1) return "";
			at = i;
		}
	}
	if (at <= 0 || at === a.length - 1) return "";
	return a;
}

// Each usable address once (letter case aside), in the order given.
function noticeRecipients(addresses) {
	const seen = new Set();
	const out = [];
	for (const raw of Array.isArray(addresses) ? addresses : [addresses]) {
		const a = usableAddress(raw);
		if (!a || seen.has(a.toLowerCase())) continue;
		seen.add(a.toLowerCase());
		out.push(a);
	}
	return out;
}

// "October 15, 2026 at 1:40 PM EDT": the instant's wall clock in `timeZone`,
// with that zone's own abbreviation (EST or EDT for US Eastern).
function changedAtText(instant, timeZone) {
	const parts = {};
	const f = new Intl.DateTimeFormat("en-US", {
		timeZone, year: "numeric", month: "long", day: "numeric",
		hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
	});
	for (const p of f.formatToParts(instant)) parts[p.type] = p.value;
	return `${parts.month} ${parts.day}, ${parts.year} at ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
}

function contactText(adminEmail) {
	const a = typeof adminEmail === "string" ? adminEmail.trim() : "";
	return a || NO_CONTACT;
}

function escapeHtml(s) {
	let out = "";
	for (const ch of String(s)) {
		if (ch === "&") out += "&amp;";
		else if (ch === "<") out += "&lt;";
		else if (ch === ">") out += "&gt;";
		else if (ch === "\"") out += "&quot;";
		else if (ch === "'") out += "&#39;";
		else out += ch;
	}
	return out;
}

// The notice itself: the sentence as plain text, and the same sentence as the
// HTML body server.js wraps in the house email template.
function buildPasswordChangeNotice({ when = new Date(), byAdmin, adminEmail, timeZone }) {
	const at = changedAtText(when, timeZone);
	const by = byAdmin ? "an administrator" : "you";
	const contact = contactText(adminEmail);
	const text = `Your LogisX password was changed on ${at} by ${by}. If this wasn't you, contact ${contact}.`;
	const bodyHtml = `<p style="margin:0 0 12px;line-height:1.6;color:#334155">${escapeHtml(text)}</p>`;
	return { subject: NOTICE_SUBJECT, heading: NOTICE_HEADING, text, bodyHtml };
}

// Sends the notice to each usable address. `send(to, notice)` is the mailer:
// it answers true only when the message was handed over (server.js's
// sendEmail contract). Resolves { recipients, sent }; never rejects.
async function sendPasswordChangeNotice({ userId, addresses, byAdmin, adminEmail, timeZone, now = new Date(), send, logger = console }) {
	const who = `user ${Number.isInteger(Number(userId)) ? Number(userId) : "?"}`;
	try {
		const to = noticeRecipients(addresses);
		if (to.length === 0) {
			logger.warn(`[password-notice] ${who} has no usable email address on file; no password-change notice was sent.`);
			return { recipients: 0, sent: 0 };
		}
		const notice = buildPasswordChangeNotice({ when: now, byAdmin, adminEmail, timeZone });
		let sent = 0;
		for (const address of to) {
			let delivered = false;
			try {
				delivered = (await send(address, notice)) === true;
			} catch (err) {
				logger.error(`[password-notice] sending the password-change notice for ${who} threw: ${err && err.message ? err.message : err}`);
			}
			if (delivered) sent++;
			else logger.error(`[password-notice] the password-change notice for ${who} was not sent (mail is off or not configured, or the send failed). The password change itself is saved.`);
		}
		return { recipients: to.length, sent };
	} catch (err) {
		logger.error(`[password-notice] the password-change notice for ${who} failed: ${err && err.message ? err.message : err}`);
		return { recipients: 0, sent: 0 };
	}
}

module.exports = {
	NOTICE_SUBJECT,
	NOTICE_HEADING,
	NO_CONTACT,
	usableAddress,
	noticeRecipients,
	changedAtText,
	buildPasswordChangeNotice,
	sendPasswordChangeNotice,
};
