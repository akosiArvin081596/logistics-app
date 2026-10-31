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
// Verified end-to-end against the company's Gmail mailbox: login OK, APPEND
// to "[Gmail]/Drafts" creates a draft with PDF attachments.
//
// Every rejection carries `err.stage`, where the session stopped, and
// `err.answered` when the server's own answer was NO or BAD. A rejection at
// "literal" without an answer (a timeout or a dropped socket after the message
// was streamed) is the one case where the draft may exist anyway: the automatic
// drafts look for it by its Message-ID (findDraftByMessageId(), in Drafts and in
// Sent Mail, where it is once a person has sent it) before trying again. The
// Draft Invoice button passes no Message-ID and reads only the message. The
// trial report reads Sent Mail with fetchMessages(), read-only.

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
// Where findDraftByMessageId() looks, in order: Drafts, then Sent Mail, where a
// draft goes once a person sends it, so a sent invoice is never taken as absent.
const SEARCH_MAILBOXES = Object.freeze(["[Gmail]/Drafts", "[Gmail]/Sent Mail"]);
// A mailbox name as the code gives one: a single line, so it stays one quoted
// IMAP string.
const MAILBOX_NAME_RE = /^[^\r\n\0]{1,100}$/;

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
				// Once the message has started and no answer came, drop the
				// connection: end() would still flush the rest of the message, so a
				// draft could land after the caller has given up on it.
				if (err && stage === 3 && !err.answered) {
					sock.destroy();
				} else {
					sock.write("aZ LOGOUT\r\n");
					sock.end();
				}
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

// Is there a message with this Message-ID in Gmail? Each mailbox of `mailboxes`
// is opened read-only (EXAMINE) in turn and its headers searched, stopping at the
// first that holds it; nothing is changed. Resolves { found, count, mailbox }
// (mailbox: where it was found, "" when absent from every one); rejects like
// appendGmailDraft(), with `stage` "credentials", "greeting", "login", "examine"
// or "search", so a mailbox that can't be opened is never read as "absent".
//
// opts: { user, pass, messageId, host?='imap.gmail.com', port?=993,
//         mailboxes?=SEARCH_MAILBOXES, timeoutMs?=30000 }
function findDraftByMessageId(opts) {
	const {
		user,
		pass,
		messageId,
		host = "imap.gmail.com",
		port = 993,
		mailboxes = SEARCH_MAILBOXES,
		timeoutMs = 30000,
	} = opts || {};
	if (!user || !pass) return Promise.reject(stagedError("findDraftByMessageId: user/pass required", "credentials"));
	if (!MESSAGE_ID_RE.test(String(messageId || ""))) {
		return Promise.reject(stagedError("findDraftByMessageId: messageId must be <id@domain>", "credentials"));
	}
	if (!Array.isArray(mailboxes) || !mailboxes.length || mailboxes.length > 4 || !mailboxes.every((m) => typeof m === "string" && MAILBOX_NAME_RE.test(m))) {
		return Promise.reject(stagedError("findDraftByMessageId: mailboxes must be a list of mailbox names", "credentials"));
	}
	return new Promise((resolve, reject) => {
		const sock = tls.connect(port, host, { servername: host });
		let stage = 0;
		let acc = "";
		let done = false;
		let tag = 1; // the last command's tag number: a1 is the LOGIN
		let box = 0; // the mailbox being searched
		const tagged = (t) => new RegExp(`(?:^|\\r\\n)a${t} (OK|NO|BAD)`).exec(acc);
		const send = (command) => {
			tag++;
			acc = "";
			sock.write(`a${tag} ${command}\r\n`);
		};
		const examine = () => {
			stage = 2;
			send("EXAMINE " + imapQuote(mailboxes[box]));
		};
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
				} else if (stage === 1 && tagged(1)) {
					if (tagged(1)[1] !== "OK") return finish(stagedError("IMAP LOGIN failed", "login", true));
					examine();
				} else if (stage === 2 && tagged(tag)) {
					if (tagged(tag)[1] !== "OK") return finish(stagedError("IMAP EXAMINE failed: " + acc.trim().slice(-160), "examine", true));
					stage = 3;
					send("SEARCH HEADER Message-ID " + imapQuote(messageId));
				} else if (stage === 3 && tagged(tag)) {
					if (tagged(tag)[1] !== "OK") return finish(stagedError("IMAP SEARCH failed: " + acc.trim().slice(-160), "search", true));
					const line = /(?:^|\r\n)\* SEARCH((?: \d{1,10}){0,10000})\r\n/.exec(acc);
					const count = line ? line[1].trim().split(" ").filter(Boolean).length : 0;
					if (count > 0) return finish(null, { found: true, count, mailbox: mailboxes[box] });
					box++;
					if (box < mailboxes.length) return examine();
					finish(null, { found: false, count: 0, mailbox: "" });
				}
			} catch (e) {
				finish(e);
			}
		});
		sock.on("error", (e) => finish(stagedError("IMAP socket error: " + e.message, SEARCH_STAGES[stage])));
	});
}

// The messages a search finds in one mailbox, read without changing anything, for
// scripts/auto-invoice-send-trial-report.js: the mailbox is opened read-only
// (EXAMINE), searched by date and, optionally, a subject word, and each message
// found is fetched whole with BODY.PEEK[], which never marks it read. These four
// commands, LOGIN and LOGOUT are the session's only ones.
// Resolves { messages: [{ seq, internalDate, raw }], count }; rejects like
// findDraftByMessageId(), with `stage` "credentials", "greeting", "login",
// "examine", "search" or "fetch". More than `maxMessages` found, or more than
// `maxBytes` in all, is a failure, never a partial answer.
//
// opts: { user, pass, mailbox?='[Gmail]/Sent Mail', since: Date, before: Date,
//         subject?, host?='imap.gmail.com', port?=993, timeoutMs?=60000,
//         maxMessages?=50, maxBytes?=64 MB }
const FETCH_STAGES = Object.freeze(["greeting", "login", "examine", "search", "fetch"]);
const SEARCH_WORD_RE = /^[A-Za-z0-9#._-]{1,80}$/;
const IMAP_MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
const imapDay = (d) => `${d.getUTCDate()}-${IMAP_MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

function fetchMessages(opts) {
	const {
		user,
		pass,
		mailbox = "[Gmail]/Sent Mail",
		since,
		before,
		subject = "",
		host = "imap.gmail.com",
		port = 993,
		timeoutMs = 60000,
		maxMessages = 50,
		maxBytes = 64 * 1024 * 1024,
	} = opts || {};
	const validDate = (d) => d instanceof Date && Number.isFinite(d.getTime());
	if (!user || !pass) return Promise.reject(stagedError("fetchMessages: user/pass required", "credentials"));
	if (typeof mailbox !== "string" || !MAILBOX_NAME_RE.test(mailbox)) return Promise.reject(stagedError("fetchMessages: mailbox must be one mailbox name", "credentials"));
	if (!validDate(since) || !validDate(before) || before <= since) return Promise.reject(stagedError("fetchMessages: since and before must be dates, since first", "credentials"));
	if (subject && !SEARCH_WORD_RE.test(String(subject))) return Promise.reject(stagedError("fetchMessages: subject must be one plain word", "credentials"));
	const criteria = `SINCE ${imapDay(since)} BEFORE ${imapDay(before)}${subject ? ` SUBJECT ${imapQuote(subject)}` : ""}`;
	return new Promise((resolve, reject) => {
		const sock = tls.connect(port, host, { servername: host });
		let stage = 0;
		let acc = "";
		let done = false;
		let tag = 1;
		const fetched = { pos: 0, messages: [], current: null, need: 0, bytes: 0, tagLine: null };
		const tagged = (t) => new RegExp(`(?:^|\\r\\n)a${t} (OK|NO|BAD)`).exec(acc);
		const send = (command) => {
			tag++;
			acc = "";
			sock.write(`a${tag} ${command}\r\n`);
		};
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
			if (err && !err.stage) err.stage = FETCH_STAGES[stage];
			err ? reject(err) : resolve(val);
		};
		const timer = setTimeout(() => finish(stagedError("IMAP timeout at fetch stage " + stage, FETCH_STAGES[stage])), timeoutMs);
		sock.on("data", (d) => {
			acc += d.toString("latin1");
			try {
				if (stage === 0 && /\* OK/.test(acc)) {
					stage = 1;
					acc = "";
					sock.write("a1 LOGIN " + imapQuote(user) + " " + imapQuote(pass) + "\r\n");
				} else if (stage === 1 && tagged(1)) {
					if (tagged(1)[1] !== "OK") return finish(stagedError("IMAP LOGIN failed", "login", true));
					stage = 2;
					send("EXAMINE " + imapQuote(mailbox));
				} else if (stage === 2 && tagged(tag)) {
					if (tagged(tag)[1] !== "OK") return finish(stagedError("IMAP EXAMINE failed: " + acc.trim().slice(-160), "examine", true));
					stage = 3;
					send("SEARCH " + criteria);
				} else if (stage === 3 && tagged(tag)) {
					if (tagged(tag)[1] !== "OK") return finish(stagedError("IMAP SEARCH failed: " + acc.trim().slice(-160), "search", true));
					const line = /(?:^|\r\n)\* SEARCH((?: \d{1,10}){0,10000})\r\n/.exec(acc);
					const seqs = line ? line[1].trim().split(" ").filter(Boolean) : [];
					if (!seqs.length) return finish(null, { messages: [], count: 0 });
					if (seqs.length > maxMessages) return finish(stagedError(`IMAP SEARCH found ${seqs.length} messages, more than ${maxMessages}`, "search"));
					stage = 4;
					send(`FETCH ${seqs.join(",")} (INTERNALDATE BODY.PEEK[])`);
				} else if (stage === 4) {
					readFetched(acc, fetched, tag, maxBytes);
					if (fetched.tagLine === null) return;
					if (!/ OK/.test(fetched.tagLine)) return finish(stagedError("IMAP FETCH failed: " + fetched.tagLine.slice(0, 160), "fetch", true));
					finish(null, { messages: fetched.messages, count: fetched.messages.length });
				}
			} catch (e) {
				finish(e);
			}
		});
		sock.on("error", (e) => finish(stagedError("IMAP socket error: " + e.message, FETCH_STAGES[stage])));
	});
}

// The FETCH answers read so far, line by line, with each literal ("{n}" then n
// bytes) taken whole: a message's bytes are never searched for a tagged line.
// Sets `st.tagLine` once the command's tagged answer arrives.
function readFetched(acc, st, tag, maxBytes) {
	for (;;) {
		if (st.need) {
			if (acc.length - st.pos < st.need) return;
			const raw = Buffer.from(acc.slice(st.pos, st.pos + st.need), "latin1");
			st.pos += st.need;
			st.need = 0;
			if (st.current && st.current.wantBody) {
				st.current.raw = raw;
				st.current.wantBody = false;
			}
			continue;
		}
		const eol = acc.indexOf("\r\n", st.pos);
		if (eol < 0) return;
		const line = acc.slice(st.pos, eol);
		st.pos = eol + 2;
		const start = /^\* (\d{1,10}) FETCH \(/.exec(line);
		if (start) st.current = { seq: Number(start[1]), internalDate: "", raw: null, wantBody: false };
		if (st.current) {
			const date = /INTERNALDATE "([^"]{1,64})"/.exec(line);
			if (date) st.current.internalDate = date[1];
		}
		const literal = /\{(\d{1,10})\}$/.exec(line);
		if (literal) {
			st.need = Number(literal[1]);
			st.bytes += st.need;
			if (st.bytes > maxBytes) throw stagedError(`IMAP FETCH answered more than ${maxBytes} bytes`, "fetch");
			if (st.current && /BODY\[\] \{\d{1,10}\}$/.test(line)) st.current.wantBody = true;
			continue;
		}
		if (st.current && line.endsWith(")")) {
			st.messages.push({ seq: st.current.seq, internalDate: st.current.internalDate, raw: st.current.raw });
			st.current = null;
			continue;
		}
		if (new RegExp(`^a${tag} (OK|NO|BAD)\\b`).test(line)) {
			st.tagLine = line;
			return;
		}
	}
}

module.exports = { appendGmailDraft, findDraftByMessageId, fetchMessages, newMessageId, buildMime, imapQuote, MESSAGE_ID_RE, SEARCH_MAILBOXES };
