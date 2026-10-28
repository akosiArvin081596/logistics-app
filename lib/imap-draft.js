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
//
// Every rejection carries `err.stage`, where the session stopped, and
// `err.answered` when the server's own answer was NO or BAD. A rejection at
// "literal" without an answer (a timeout or a dropped socket after the message
// was streamed) is the one case where the draft may exist anyway: the automatic
// drafts look for it by its Message-ID (findDraftByMessageId()) before trying
// again. The Draft Invoice button passes no Message-ID and reads only the message.

"use strict";

const crypto = require("crypto");
const tls = require("tls");
const MailComposer = require("nodemailer/lib/mail-composer");

// The session's steps, by the numbers the timeout message has always used.
const APPEND_STAGES = Object.freeze(["greeting", "login", "append", "literal"]);
const SEARCH_STAGES = Object.freeze(["greeting", "login", "examine", "search"]);
// A Message-ID the app made itself (newMessageId()): no quote, space or bracket
// inside, so it is one IMAP quoted string and one header value.
const MESSAGE_ID_RE = /^<[A-Za-z0-9._%+=-]{1,128}@[A-Za-z0-9.-]{1,128}>$/;

// IMAP quoted-string: wrap in quotes, backslash-escape " and \.
function imapQuote(s) {
	return '"' + String(s == null ? "" : s).replace(/(["\\])/g, "\\$1") + '"';
}

function stagedError(message, stage, answered = false) {
	const err = new Error(message);
	err.stage = stage;
	if (answered) err.answered = true;
	return err;
}

// A fresh Message-ID on the mailbox's own domain.
function newMessageId(user) {
	const at = String(user || "").lastIndexOf("@");
	const domain = at >= 0 ? String(user).slice(at + 1).toLowerCase() : "";
	return `<${crypto.randomUUID()}.auto-invoice@${/^[a-z0-9.-]{1,128}$/.test(domain) ? domain : "logisx.invalid"}>`;
}

// Build a MIME message (Buffer) from mail options via nodemailer's MailComposer.
// `messageId` is passed on only when given, so a call without one is unchanged.
function buildMime({ from, to, subject, html, text, attachments = [], messageId }) {
	const mail = { from, to, subject, html, text, attachments };
	if (messageId) mail.messageId = messageId;
	return new Promise((resolve, reject) => {
		new MailComposer(mail)
			.compile()
			.build((err, message) => (err ? reject(err) : resolve(message)));
	});
}

// Create a Gmail draft by APPENDing a MIME message to the Drafts mailbox.
//
// opts: { user, pass, from?, to, subject, html, text?, attachments?, messageId?,
//         host?='imap.gmail.com', port?=993, mailbox?='[Gmail]/Drafts', timeoutMs?=60000 }
// attachments: [{ filename, content (Buffer|string), contentType }]
// messageId: "<id@domain>" to set the draft's Message-ID (else MailComposer makes one).
// Returns Promise<{ ok: true, bytes, mailbox }>; rejects with an Error carrying
// `stage` ("credentials", "mime", "greeting", "login", "append", "literal") and
// `answered` when the server said NO or BAD.
async function appendGmailDraft(opts) {
	const {
		user,
		pass,
		to,
		subject,
		html,
		text,
		attachments = [],
		messageId,
		from = `LogisX Inc. <${user}>`,
		host = "imap.gmail.com",
		port = 993,
		mailbox = "[Gmail]/Drafts",
		timeoutMs = 60000,
	} = opts || {};
	if (!user || !pass) throw stagedError("appendGmailDraft: user/pass required", "credentials");
	if (messageId != null && !MESSAGE_ID_RE.test(String(messageId))) {
		throw stagedError("appendGmailDraft: messageId must be <id@domain>", "credentials");
	}

	let message;
	try {
		message = await buildMime({ from, to, subject, html, text, attachments, messageId });
	} catch (e) {
		throw stagedError("MIME build failed: " + e.message, "mime");
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
			if (err && !err.stage) err.stage = APPEND_STAGES[stage];
			err ? reject(err) : resolve(val);
		};
		const timer = setTimeout(
			() => finish(stagedError("IMAP timeout at stage " + stage, APPEND_STAGES[stage])),
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
					if (!/a1 OK/.test(acc)) return finish(stagedError("IMAP LOGIN failed", "login", true));
					stage = 2;
					acc = "";
					// \Seen as well as \Draft: a draft appended unread stays unread when it
					// is sent unchanged, and the mailbox's filter stars and labels outgoing
					// order mail too, so the sent invoice met the rate-con ingestion's
					// unread + starred trigger and came back as a new load. The app's own
					// draft is not new mail.
					sock.write(
						"a2 APPEND " + imapQuote(mailbox) + " (\\Draft \\Seen) {" + message.length + "}\r\n",
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
						return finish(stagedError("IMAP APPEND failed: " + acc.trim().slice(0, 160), "literal", true));
					}
					finish(null, { ok: true, bytes: message.length, mailbox });
				}
			} catch (e) {
				finish(e);
			}
		});
		sock.on("error", (e) => finish(stagedError("IMAP socket error: " + e.message, APPEND_STAGES[stage])));
	});
}

// Is there a message with this Message-ID in the Drafts mailbox? Opens it
// read-only (EXAMINE) and asks the server to search the header; nothing is
// changed. Resolves { found, count }; rejects like appendGmailDraft(), with
// `stage` "credentials", "greeting", "login", "examine" or "search".
//
// opts: { user, pass, messageId, host?='imap.gmail.com', port?=993,
//         mailbox?='[Gmail]/Drafts', timeoutMs?=30000 }
function findDraftByMessageId(opts) {
	const {
		user,
		pass,
		messageId,
		host = "imap.gmail.com",
		port = 993,
		mailbox = "[Gmail]/Drafts",
		timeoutMs = 30000,
	} = opts || {};
	if (!user || !pass) return Promise.reject(stagedError("findDraftByMessageId: user/pass required", "credentials"));
	if (!MESSAGE_ID_RE.test(String(messageId || ""))) {
		return Promise.reject(stagedError("findDraftByMessageId: messageId must be <id@domain>", "credentials"));
	}
	return new Promise((resolve, reject) => {
		const sock = tls.connect(port, host, { servername: host });
		let stage = 0;
		let acc = "";
		let done = false;
		const tagged = (tag) => new RegExp(`(?:^|\\r\\n)${tag} (OK|NO|BAD)`).exec(acc);
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
			if (err && !err.stage) err.stage = SEARCH_STAGES[stage];
			err ? reject(err) : resolve(val);
		};
		const timer = setTimeout(
			() => finish(stagedError("IMAP timeout at search stage " + stage, SEARCH_STAGES[stage])),
			timeoutMs,
		);
		sock.on("data", (d) => {
			acc += d.toString("latin1");
			try {
				if (stage === 0 && /\* OK/.test(acc)) {
					stage = 1;
					acc = "";
					sock.write("a1 LOGIN " + imapQuote(user) + " " + imapQuote(pass) + "\r\n");
				} else if (stage === 1 && tagged("a1")) {
					if (tagged("a1")[1] !== "OK") return finish(stagedError("IMAP LOGIN failed", "login", true));
					stage = 2;
					acc = "";
					sock.write("a2 EXAMINE " + imapQuote(mailbox) + "\r\n");
				} else if (stage === 2 && tagged("a2")) {
					if (tagged("a2")[1] !== "OK") return finish(stagedError("IMAP EXAMINE failed: " + acc.trim().slice(-160), "examine", true));
					stage = 3;
					acc = "";
					sock.write("a3 SEARCH HEADER Message-ID " + imapQuote(messageId) + "\r\n");
				} else if (stage === 3 && tagged("a3")) {
					if (tagged("a3")[1] !== "OK") return finish(stagedError("IMAP SEARCH failed: " + acc.trim().slice(-160), "search", true));
					const line = /(?:^|\r\n)\* SEARCH((?: \d{1,10}){0,10000})\r\n/.exec(acc);
					const count = line ? line[1].trim().split(" ").filter(Boolean).length : 0;
					finish(null, { found: count > 0, count });
				}
			} catch (e) {
				finish(e);
			}
		});
		sock.on("error", (e) => finish(stagedError("IMAP socket error: " + e.message, SEARCH_STAGES[stage])));
	});
}

module.exports = { appendGmailDraft, findDraftByMessageId, newMessageId, buildMime, imapQuote, MESSAGE_ID_RE };
