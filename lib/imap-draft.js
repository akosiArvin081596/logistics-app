// ============================================================
// Gmail draft creation via IMAP APPEND
// ============================================================
// LogisX needs to create a Gmail *draft* (not send) for the Bison invoice flow.
// SMTP/nodemailer can only SEND; the Gmail API needs OAuth (which expires —
// Google "testing-mode" refresh tokens die after 7 days). But an app password
// (GMAIL_USER / GMAIL_APP_PASSWORD, already used for nodemailer) works over
// IMAP, and IMAP APPEND to the Drafts mailbox creates a draft. That's
// dependency-light (built-in tls + nodemailer's MailComposer, both already
// present) and never expires.
//
// Verified end-to-end against info@logisx.com on 2026-06-17: login OK, APPEND
// to "[Gmail]/Drafts" creates a draft with PDF attachments.

"use strict";

const tls = require("tls");
const MailComposer = require("nodemailer/lib/mail-composer");

// IMAP quoted-string: wrap in quotes, backslash-escape " and \.
function imapQuote(s) {
	return '"' + String(s == null ? "" : s).replace(/(["\\])/g, "\\$1") + '"';
}

// Build a MIME message (Buffer) from mail options via nodemailer's MailComposer.
function buildMime({ from, to, subject, html, text, attachments = [] }) {
	return new Promise((resolve, reject) => {
		new MailComposer({ from, to, subject, html, text, attachments })
			.compile()
			.build((err, message) => (err ? reject(err) : resolve(message)));
	});
}

// Create a Gmail draft by APPENDing a MIME message to the Drafts mailbox.
//
// opts: { user, pass, from?, to, subject, html, text?, attachments?,
//         host?='imap.gmail.com', port?=993, mailbox?='[Gmail]/Drafts', timeoutMs?=60000 }
// attachments: [{ filename, content (Buffer|string), contentType }]
// Returns Promise<{ ok: true, bytes, mailbox }>; rejects with an Error.
async function appendGmailDraft(opts) {
	const {
		user,
		pass,
		to,
		subject,
		html,
		text,
		attachments = [],
		from = `LogisX Inc. <${user}>`,
		host = "imap.gmail.com",
		port = 993,
		mailbox = "[Gmail]/Drafts",
		timeoutMs = 60000,
	} = opts || {};
	if (!user || !pass) throw new Error("appendGmailDraft: user/pass required");

	let message;
	try {
		message = await buildMime({ from, to, subject, html, text, attachments });
	} catch (e) {
		throw new Error("MIME build failed: " + e.message);
	}

	return new Promise((resolve, reject) => {
		const sock = tls.connect(port, host, { servername: host });
		let stage = 0;
		let acc = "";
		let done = false;
		const finish = (err, val) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				sock.write("aZ LOGOUT\r\n");
				sock.end();
			} catch {
				/* ignore */
			}
			err ? reject(err) : resolve(val);
		};
		const timer = setTimeout(
			() => finish(new Error("IMAP timeout at stage " + stage)),
			timeoutMs,
		);
		sock.on("data", (d) => {
			acc += d.toString("latin1");
			try {
				// 0: server greeting → LOGIN
				if (stage === 0 && /\* OK/.test(acc)) {
					stage = 1;
					acc = "";
					sock.write("a1 LOGIN " + imapQuote(user) + " " + imapQuote(pass) + "\r\n");
				}
				// 1: LOGIN result → APPEND command (announce literal size)
				else if (stage === 1 && /a1 (OK|NO|BAD)/.test(acc)) {
					if (!/a1 OK/.test(acc)) return finish(new Error("IMAP LOGIN failed"));
					stage = 2;
					acc = "";
					sock.write(
						"a2 APPEND " + imapQuote(mailbox) + " (\\Draft) {" + message.length + "}\r\n",
					);
				}
				// 2: continuation "+" → stream the raw MIME, then CRLF to end the command
				else if (stage === 2 && /(^|\n)\+/.test(acc)) {
					stage = 3;
					acc = "";
					sock.write(message);
					sock.write("\r\n");
				}
				// 3: APPEND result
				else if (stage === 3 && /a2 (OK|NO|BAD)/.test(acc)) {
					if (!/a2 OK/.test(acc)) {
						return finish(new Error("IMAP APPEND failed: " + acc.trim().slice(0, 160)));
					}
					finish(null, { ok: true, bytes: message.length, mailbox });
				}
			} catch (e) {
				finish(e);
			}
		});
		sock.on("error", (e) => finish(new Error("IMAP socket error: " + e.message)));
	});
}

module.exports = { appendGmailDraft, buildMime, imapQuote };
