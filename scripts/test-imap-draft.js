#!/usr/bin/env node
/**
 * Locks what lib/imap-draft.js appendGmailDraft() sends to Gmail when it creates
 * the broker invoice draft.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * The draft was APPENDed with the \Draft flag alone, so Gmail stored it unread,
 * and a draft sent unchanged kept that state. The mailbox's filter stars and
 * labels outgoing order mail as well, and the rate-con ingestion picks up
 * unread + starred mail under that label, so an invoice sent straight from its
 * draft came back in as a new rate con. The APPEND now carries (\Draft \Seen).
 *
 *   §1 THE APPEND. The connection goes to imap.gmail.com:993; LOGIN sends the
 *      quoted credentials; the APPEND targets "[Gmail]/Drafts" with BOTH \Draft
 *      and \Seen (and not \Flagged, Gmail's star); the literal's announced size
 *      is exactly the bytes sent before its CRLF; the session ends with LOGOUT.
 *   §2 THE MESSAGE. The literal is the composed email: From (the button's
 *      "LogisX Inc. <user>"), To, Subject, the HTML body byte for byte, the PDF
 *      attachment (name, type, bytes), and a name in the invoice's own shape
 *      ("<Broker> Invoice Order #<n>.pdf") beside the hyphen-only one.
 *   §3 FAILURES. A NO to the APPEND rejects "IMAP APPEND failed"; a NO to the
 *      LOGIN rejects "IMAP LOGIN failed" and sends no APPEND; no credentials
 *      rejects before any connection.
 *   §4 THE AUTOMATIC DRAFTS' ADDITIONS. A messageId given becomes the draft's
 *      Message-ID; none given leaves MailComposer's own (the button's call is
 *      unchanged). Every rejection names its stage, and says when the server
 *      answered: only a timeout after the message was streamed ("literal", no
 *      answer) leaves the draft possibly made. findDraftByMessageId() opens the
 *      Drafts read-only (EXAMINE), searches the header and finds a draft by its
 *      Message-ID, or not; its failures name their stage too. A draft a person
 *      has sent is in Sent Mail, not Drafts: the search opens Sent Mail next
 *      (read-only too) and says where it found the message; a Sent Mail it
 *      can't open is a failure, never "absent".
 *   §5 THE HARNESS'S FAKE GMAIL (scripts/e2e/fake-gmail.cjs), preloaded into a
 *      child process as the browser harness preloads it into the server: drafts
 *      APPENDed through the library are found by their Message-ID with EXAMINE
 *      or SELECT and SEARCH HEADER Message-ID, an unknown one is not, SEARCH
 *      before a mailbox or of another kind is BAD, and readCapturedDrafts()
 *      reports each draft's Message-ID.
 *   §6 THE TRIAL REPORT'S READ (fetchMessages()): Sent Mail opened with EXAMINE,
 *      searched by date and a subject word, each message fetched whole with
 *      BODY.PEEK[] (its literal taken by length, binary and a tagged-answer line
 *      inside included); nothing else is ever sent (no SELECT, STORE, APPEND,
 *      COPY, MOVE or EXPUNGE, also in its source); too many found, a NO, or a
 *      bad argument fails before or instead of a partial answer.
 *
 * HOW: tls.connect is replaced for the duration of the run by a stub that
 * returns a plain socket to a fake IMAP server on 127.0.0.1:0, which speaks
 * just enough IMAP for appendGmailDraft() and findDraftByMessageId(). §5 runs
 * this file again as a child with the harness fake preloaded and a private
 * temp folder for its captures. Nothing leaves the machine.
 *
 * §8 THE READ-ONLY MAILBOX SEARCH AND ITS CLASSIFIER (lib/invoice-mailbox-search.js)
 * has its own fake IMAP server and its notes above mailboxSearchSection().
 *
 * Plain node, no server, no fixtures, no network, never touches app.db.
 * Run: node scripts/test-imap-draft.js
 */
"use strict";
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const tls = require("tls");
const { spawnSync } = require("child_process");

const { appendGmailDraft, findDraftByMessageId } = require(path.join(__dirname, "..", "lib", "imap-draft.js"));
const FAKE_GMAIL = path.join(__dirname, "e2e", "fake-gmail.cjs");
const CHILD_FLAG = "--fake-gmail-child";

// -------------------------------------------------------------------- runner
let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(!!cond, true, label); }
function section(t) { console.log(`\n${t}`); }

// A hang is a failure, not a stuck CI job.
setTimeout(() => {
	console.log("\n✗ the run did not finish within 30 s");
	process.exit(1);
}, 30_000).unref();

// ------------------------------------------------------------------ fixture
const E_ACUTE = String.fromCodePoint(0xe9);
const EM_DASH = String.fromCodePoint(0x2014);
const USER = "info@example.com";
const PASS = 'app "pass" \\ word'; // a quote and a backslash, which LOGIN must escape
const TO = "ap@example.com";
const SUBJECT = "Invoice 12312099-1 for Load 900000020";
// Multi-line, non-ASCII and over 76 columns, so MailComposer quoted-printables it.
const HTML = [
	"<html><body>",
	"<p>Please find attached invoice 12312099-1 for load 900000020.</p>",
	`<p>Total due: $1,234.00 ${EM_DASH} Caf${E_ACUTE} & Co. ${"A line long enough to need a soft break. ".repeat(3)}</p>`,
	"</body></html>",
].join("\n");
const PDF_NAME = "Invoice-12312099-1.pdf";
const INVOICE_NAME = "Acme Freight Invoice Order #1234567.pdf"; // lib/broker-invoice-draft.js's shape
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");

// ---------------------------------------------------------------- fake IMAP
// Greeting, LOGIN, APPEND with a synchronizing literal, LOGOUT; anything else
// is BAD (§4 adds EXAMINE and SEARCH HEADER Message-ID, answered from the
// Message-IDs held in the mailbox examined: the drafts APPENDed so far are in
// [Gmail]/Drafts, and `sent` holds [Gmail]/Sent Mail's). `answer` picks OK or NO
// for LOGIN, APPEND and SEARCH; "HANG" for the greeting or the APPEND sends
// nothing; `answer.examineNo` names a mailbox whose EXAMINE gets NO, and a
// mailbox the server doesn't have gets NO too. Every connection is recorded in
// `sessions`: the commands in order, the LOGIN arguments, the APPEND with its
// literal, the EXAMINE mailboxes, the SEARCH arguments and the raw bytes received.
function unquote(q) { return q.slice(1, -1).replace(/\\(.)/g, "$1"); }
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';
const LOGIN_ARGS = new RegExp(`^(${QUOTED}) (${QUOTED})$`);
const APPEND_ARGS = new RegExp(`^(${QUOTED}) \\(([^)]*)\\) \\{(\\d+)\\}$`);
const EXAMINE_ARGS = new RegExp(`^(${QUOTED})$`);
const SEARCH_ARGS = new RegExp(`^HEADER Message-ID (${QUOTED})$`, "i");
const CRITERIA_ARGS = new RegExp(`^SINCE (\\d{1,2}-[A-Za-z]{3}-\\d{4}) BEFORE (\\d{1,2}-[A-Za-z]{3}-\\d{4})(?: SUBJECT (${QUOTED}))?$`);
const FETCH_ARGS = /^(\d{1,6}(?:,\d{1,6}){0,200}) \(INTERNALDATE BODY\.PEEK\[\]\)$/;
// The top-level Message-ID header of a composed message.
function messageIdOf(literal) {
	const raw = literal.toString("latin1");
	const head = raw.slice(0, Math.max(0, raw.indexOf("\r\n\r\n")));
	const m = /(?:^|\r\n)Message-ID:\s*(<[^>\r\n]{1,300}>)/i.exec(head);
	return m ? m[1] : null;
}

function fakeImap() {
	const sessions = [];
	const answer = { login: "OK", append: "OK", greeting: "OK", search: "OK", examineNo: "", fetch: "OK" };
	const stored = []; // Message-IDs of the drafts appended, in order
	const sent = []; // Message-IDs in Sent Mail
	const sentRaw = []; // Sent Mail's messages for SEARCH by date and subject, and FETCH: { subject, raw }
	const held = { "[Gmail]/Drafts": stored, "[Gmail]/Sent Mail": sent };
	const server = net.createServer((sock) => {
		const s = { commands: [], login: null, append: null, examine: null, examines: [], search: null, received: [], appendLineEnd: null };
		s.closed = new Promise((resolve) => sock.on("close", resolve));
		sessions.push(s);
		let buf = Buffer.alloc(0);
		let bytesIn = 0;
		let pending = null; // an APPEND waiting for its literal
		const reply = (line) => sock.write(line + "\r\n");
		sock.on("error", () => {});
		if (answer.greeting === "OK") reply("* OK [CAPABILITY IMAP4rev1] fake IMAP ready");
		sock.on("data", (chunk) => {
			s.received.push(chunk);
			bytesIn += chunk.length;
			buf = Buffer.concat([buf, chunk]);
			for (;;) {
				if (pending) {
					if (buf.length < pending.size + 2) return;
					const terminated = buf.subarray(pending.size, pending.size + 2).toString("latin1") === "\r\n";
					s.append = { ...pending, literal: Buffer.from(buf.subarray(0, pending.size)), terminated };
					buf = buf.subarray(pending.size + 2);
					const t = pending.tag;
					pending = null;
					if (!terminated) reply(`${t} BAD literal not followed by CRLF`);
					else if (answer.append === "HANG") continue;
					else if (answer.append === "OK") {
						stored.push(messageIdOf(s.append.literal));
						reply(`${t} OK [APPENDUID 1 1] APPEND completed`);
					} else reply(`${t} NO [OVERQUOTA] mailbox full`);
					continue;
				}
				const eol = buf.indexOf("\r\n");
				if (eol < 0) return;
				const line = buf.subarray(0, eol).toString("latin1");
				buf = buf.subarray(eol + 2);
				const [tag, verb = ""] = line.split(" ", 2);
				const args = line.slice(tag.length + verb.length + 2);
				s.commands.push(verb.toUpperCase());
				if (/^LOGIN$/i.test(verb)) {
					const m = LOGIN_ARGS.exec(args);
					s.login = m ? { user: unquote(m[1]), pass: unquote(m[2]) } : { unparsed: args };
					reply(answer.login === "OK" ? `${tag} OK LOGIN completed` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
				} else if (/^APPEND$/i.test(verb)) {
					const m = APPEND_ARGS.exec(args);
					if (!m) { reply(`${tag} BAD malformed APPEND`); continue; }
					pending = { tag, mailbox: unquote(m[1]), flags: m[2].split(" ").filter(Boolean), size: Number(m[3]) };
					s.appendLineEnd = bytesIn - buf.length;
					reply("+ go ahead");
				} else if (/^EXAMINE$/i.test(verb)) {
					const m = EXAMINE_ARGS.exec(args);
					if (!m) { reply(`${tag} BAD malformed EXAMINE`); continue; }
					s.examine = unquote(m[1]);
					s.examines.push(s.examine);
					if (!held[s.examine] || s.examine === answer.examineNo) { reply(`${tag} NO [NONEXISTENT] Unknown Mailbox`); continue; }
					reply(`* ${held[s.examine].length} EXISTS`);
					reply(`${tag} OK [READ-ONLY] EXAMINE completed`);
				} else if (/^SEARCH$/i.test(verb)) {
					const m = SEARCH_ARGS.exec(args);
					const crit = m ? null : CRITERIA_ARGS.exec(args);
					if (crit) {
						s.criteria = args;
						if (answer.search !== "OK") { reply(`${tag} NO [UNAVAILABLE] search failed`); continue; }
						const word = crit[3] ? unquote(crit[3]) : "";
						const hits = s.examine === "[Gmail]/Sent Mail" ? sentRaw.map((x, i) => (!word || x.subject.includes(word) ? i + 1 : 0)).filter(Boolean) : [];
						reply(`* SEARCH${hits.map((n) => ` ${n}`).join("")}`);
						reply(`${tag} OK SEARCH completed`);
						continue;
					}
					s.search = m ? unquote(m[1]) : { unparsed: args };
					if (!m) { reply(`${tag} BAD malformed SEARCH`); continue; }
					if (answer.search !== "OK") { reply(`${tag} NO [UNAVAILABLE] search failed`); continue; }
					const hits = (held[s.examine] || []).map((id, i) => (id === s.search ? i + 1 : 0)).filter(Boolean);
					reply(`* SEARCH${hits.map((n) => ` ${n}`).join("")}`);
					reply(`${tag} OK SEARCH completed`);
				} else if (/^FETCH$/i.test(verb)) {
					s.fetch = args;
					const m = FETCH_ARGS.exec(args);
					if (!m) { reply(`${tag} BAD malformed FETCH`); continue; }
					if (answer.fetch !== "OK") { reply(`${tag} NO [UNAVAILABLE] fetch failed`); continue; }
					for (const n of m[1].split(",").map(Number)) {
						const x = sentRaw[n - 1];
						if (!x) continue;
						sock.write(`* ${n} FETCH (INTERNALDATE "20-Oct-2026 14:00:00 +0000" BODY[] {${x.raw.length}}\r\n`);
						sock.write(x.raw);
						sock.write(")\r\n");
					}
					reply(`${tag} OK FETCH completed`);
				} else if (/^LOGOUT$/i.test(verb)) {
					reply("* BYE logging out");
					reply(`${tag} OK LOGOUT completed`);
					sock.end();
					return;
				} else {
					reply(`${tag} BAD unknown command`);
				}
			}
		});
	});
	return { server, sessions, answer, stored, sent, sentRaw };
}

// The bytes the client sent for the APPEND literal, counted from the raw stream
// without the size it announced: everything between the end of the APPEND line
// and the start of the final line (the LOGOUT), less the CRLF ending the APPEND.
// null when the session has no APPEND or does not end with a LOGOUT line.
function literalBytesSent(s) {
	if (s.appendLineEnd === null) return null;
	const tail = Buffer.concat(s.received).subarray(s.appendLineEnd);
	const end = tail.lastIndexOf("\r\n", tail.length - 3);
	if (end < 0 || !/^\S+ LOGOUT\r\n$/i.test(tail.subarray(end + 2).toString("latin1"))) return null;
	return end;
}

// Settles to { value } or { error }, so a rejection is an assertion, not a crash.
function settle(p) { return p.then((value) => ({ value }), (error) => ({ error })); }
// Waits for `p`, or gives up after `ms` (a session that never closes fails its assertions).
function within(p, ms) { return Promise.race([p, new Promise((r) => setTimeout(r, ms))]); }

// --------------------------------------------------------------------- MIME
// Just enough to read MailComposer's output back: unfolded headers, the leaf
// parts of a multipart body, and each part's transfer encoding undone.
function splitPart(raw) {
	const at = raw.indexOf("\r\n\r\n");
	const head = at < 0 ? raw : raw.slice(0, at);
	const headers = {};
	for (const line of head.replace(/\r\n(?=[ \t])/g, "").split("\r\n")) {
		const c = line.indexOf(":");
		if (c <= 0) continue;
		const k = line.slice(0, c).trim().toLowerCase();
		if (!(k in headers)) headers[k] = line.slice(c + 1).trim();
	}
	return { headers, body: at < 0 ? "" : raw.slice(at + 4) };
}
function leafParts(raw) {
	const part = splitPart(raw);
	const m = /^multipart\/[^;]{1,40};\s{0,10}boundary="?([^";]{1,200})"?/i.exec(part.headers["content-type"] || "");
	if (!m) return [part];
	return ("\r\n" + part.body)
		.split("\r\n--" + m[1])
		.slice(1)
		.filter((chunk) => !chunk.startsWith("--"))
		.flatMap((chunk) => leafParts(chunk.slice(chunk.indexOf("\r\n") + 2)));
}
function decodedBody(part) {
	const cte = (part.headers["content-transfer-encoding"] || "").toLowerCase();
	if (cte === "base64") return Buffer.from(part.body.replace(/[\r\n]/g, ""), "base64");
	if (cte === "quoted-printable") {
		const bytes = part.body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
		return Buffer.from(bytes, "latin1");
	}
	return Buffer.from(part.body, "latin1");
}

// ------------------------------------------------------------------- the run
async function main() {
	const { server, sessions, answer, sent, sentRaw } = fakeImap();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;

	const realConnect = tls.connect;
	const dials = [];
	tls.connect = (...args) => {
		dials.push(args);
		return net.connect(port, "127.0.0.1");
	};
	const draft = (over = {}) =>
		settle(appendGmailDraft({
			user: USER,
			pass: PASS,
			to: TO,
			subject: SUBJECT,
			html: HTML,
			attachments: [{ filename: PDF_NAME, content: PDF, contentType: "application/pdf" }],
			timeoutMs: 5000,
			...over,
		}));

	try {
		section("§1  the APPEND, against a fake IMAP server");
		const r = await draft();
		const s = sessions[0] || {};
		await within(s.closed, 3000);
		const a = s.append || {};
		console.log(`  fake IMAP saw: ${(s.commands || []).join(", ")}; APPEND "${a.mailbox}" (${(a.flags || []).join(" ")}) {${a.size}}`);
		eq(r.error ? r.error.message : null, null, "§1 appendGmailDraft resolves");
		eq(dials[0], [993, "imap.gmail.com", { servername: "imap.gmail.com" }], "§1 it connects to imap.gmail.com:993 over TLS");
		eq(s.login, { user: USER, pass: PASS }, "§1 LOGIN carries the credentials, quoted and escaped");
		eq(a.mailbox, "[Gmail]/Drafts", "§1 the APPEND targets [Gmail]/Drafts");
		ok((a.flags || []).includes("\\Draft"), "§1 the APPEND flags include \\Draft");
		ok((a.flags || []).includes("\\Seen"), "§1 the APPEND flags include \\Seen (the draft is not unread)");
		ok(!(a.flags || []).includes("\\Flagged"), "§1 the APPEND flags exclude \\Flagged (the draft is not starred)");
		ok(Number.isInteger(a.size) && a.size > 0, "§1 the APPEND announces a literal size");
		eq(s.received ? literalBytesSent(s) : null, a.size, "§1 the bytes received for the literal equal its announced size");
		eq(a.terminated, true, "§1 the literal is followed by the CRLF that ends the command");
		eq(r.value && r.value.bytes, a.size, "§1 the resolved byte count is the announced size");
		eq(r.value && r.value.mailbox, "[Gmail]/Drafts", "§1 the resolved mailbox is [Gmail]/Drafts");
		eq(s.commands, ["LOGIN", "APPEND", "LOGOUT"], "§1 the session is LOGIN, APPEND, LOGOUT and nothing else");

		section("§2  the message inside the literal");
		const raw = a.literal ? a.literal.toString("latin1") : "";
		const top = splitPart(raw);
		eq(top.headers.to, TO, "§2 To");
		eq(top.headers.subject, SUBJECT, "§2 Subject");
		const leaves = leafParts(raw);
		const html = leaves.find((p) => /^text\/html/i.test(p.headers["content-type"] || ""));
		eq(html ? decodedBody(html).toString("utf8") : null, HTML, "§2 the HTML body, decoded, is the HTML given, byte for byte");
		const pdf = leaves.find((p) => /^application\/pdf/i.test(p.headers["content-type"] || ""));
		const disposition = (pdf && pdf.headers["content-disposition"]) || "";
		eq(/^attachment;/i.test(disposition), true, "§2 the PDF is an attachment");
		eq((/filename="?([^";]{1,200})"?/i.exec(disposition) || [])[1], PDF_NAME, "§2 the attachment's file name");
		eq(pdf ? decodedBody(pdf).equals(PDF) : false, true, "§2 the attachment's bytes are the PDF given");
		// Read back as a name and an address, so a change in how the header is
		// written still passes while a change in what it says fails.
		const from = /^"?([^"<]*?)"?\s*<([^<>\s]+)>$/.exec(top.headers.from || "");
		eq(from && [from[1], from[2]], ["LogisX Inc.", USER], "§2 From: the button's LogisX Inc. <user> reads back as that name and address");
		const named = await draft({
			attachments: [
				{ filename: PDF_NAME, content: PDF, contentType: "application/pdf" },
				{ filename: INVOICE_NAME, content: PDF, contentType: "application/pdf" },
			],
		});
		const namedSession = sessions[sessions.length - 1];
		await within(namedSession.closed, 3000);
		const namedRaw = namedSession.append ? namedSession.append.literal.toString("latin1") : "";
		const names = leafParts(namedRaw)
			.filter((p) => /^application\/pdf/i.test(p.headers["content-type"] || ""))
			.map((p) => (/filename="?([^";]{1,200})"?/i.exec(p.headers["content-disposition"] || "") || [])[1]);
		eq([named.error ? named.error.message : null, names], [null, [PDF_NAME, INVOICE_NAME]],
			"§2 two attachments keep their names: the hyphen-only one and \"<Broker> Invoice Order #<n>.pdf\" (spaces and #)");

		section("§3  failures");
		answer.append = "NO";
		const noAppend = await draft();
		eq(/^IMAP APPEND failed/.test(noAppend.error && noAppend.error.message), true, "§3 a NO to the APPEND rejects with \"IMAP APPEND failed\"");
		answer.append = "OK";

		answer.login = "NO";
		const noLogin = await draft();
		const loginSession = sessions[sessions.length - 1];
		await within(loginSession.closed, 3000);
		eq(noLogin.error && noLogin.error.message, "IMAP LOGIN failed", "§3 a NO to the LOGIN rejects with \"IMAP LOGIN failed\"");
		eq(loginSession.commands.includes("APPEND"), false, "§3 after a failed LOGIN no APPEND is sent");
		answer.login = "OK";

		const dialsBefore = dials.length;
		const noCreds = await draft({ pass: "" });
		eq(noCreds.error && noCreds.error.message, "appendGmailDraft: user/pass required", "§3 no credentials rejects");
		eq(dials.length, dialsBefore, "§3 no credentials opens no connection");

		section("§4  Message-ID, stages and the search");
		const ID = "<made-up-0001.auto-invoice@example.com>";
		const withId = await draft({ messageId: ID });
		const idSession = sessions[sessions.length - 1];
		await within(idSession.closed, 3000);
		eq(withId.error ? withId.error.message : null, null, "§4 a draft with a messageId resolves");
		eq(idSession.append && messageIdOf(idSession.append.literal), ID, "§4 the messageId given is the draft's Message-ID");
		eq(idSession.commands, ["LOGIN", "APPEND", "LOGOUT"], "§4 with a messageId the session is still LOGIN, APPEND, LOGOUT");
		const own = messageIdOf((sessions[0].append || {}).literal || Buffer.alloc(0));
		ok(own && own !== ID && /^<[^<>@\s]+@example\.com>$/.test(own), "§4 without one (the button) the Message-ID is MailComposer's own");
		const dialsBeforeBadId = dials.length;
		const badId = await draft({ messageId: 'x" BYE' });
		eq([badId.error && badId.error.stage, dials.length], ["credentials", dialsBeforeBadId], "§4 a malformed messageId is refused before any connection");

		eq([noCreds.error.stage, noCreds.error.answered], ["credentials", undefined], "§4 no credentials: stage credentials");
		eq([noLogin.error.stage, noLogin.error.answered], ["login", true], "§4 a NO to the LOGIN: stage login, answered");
		eq([noAppend.error.stage, noAppend.error.answered], ["literal", true], "§4 a NO to the APPEND: stage literal, answered (no draft was made)");

		answer.append = "HANG";
		const hung = await draft({ messageId: ID, timeoutMs: 300 });
		eq(hung.error && [hung.error.message, hung.error.stage, hung.error.answered], ["IMAP timeout at stage 3", "literal", undefined],
			"§4 no answer after the message was streamed: stage literal, unanswered (the draft may exist)");
		const hungSession = sessions[sessions.length - 1];
		await within(hungSession.closed, 3000);
		eq(hungSession.commands, ["LOGIN", "APPEND"], "§4 then the connection is dropped (destroy), not ended with a LOGOUT that flushes the rest");
		answer.append = "OK";
		answer.greeting = "HANG";
		const silent = await draft({ timeoutMs: 300 });
		eq(silent.error && [silent.error.message, silent.error.stage], ["IMAP timeout at stage 0", "greeting"], "§4 no greeting: stage greeting");
		answer.greeting = "OK";

		const find = (over = {}) => settle(findDraftByMessageId({ user: USER, pass: PASS, messageId: ID, timeoutMs: 3000, ...over }));
		const found = await find();
		const findSession = sessions[sessions.length - 1];
		await within(findSession.closed, 3000);
		eq(found.value, { found: true, count: 1, mailbox: "[Gmail]/Drafts" }, "§4 the draft appended with that Message-ID is found, in Drafts");
		eq(findSession.commands, ["LOGIN", "EXAMINE", "SEARCH", "LOGOUT"], "§4 found in Drafts: LOGIN, EXAMINE (read-only), SEARCH, LOGOUT; Sent Mail is not opened");
		eq([findSession.login && findSession.login.user, findSession.examines, findSession.search], [USER, ["[Gmail]/Drafts"], ID], "§4 it opens the Drafts and searches the Message-ID header");
		const unknown = await find({ messageId: "<made-up-9999.auto-invoice@example.com>" });
		const unknownSession = sessions[sessions.length - 1];
		await within(unknownSession.closed, 3000);
		eq(unknown.value, { found: false, count: 0, mailbox: "" }, "§4 an unknown Message-ID is not found");
		eq([unknownSession.commands, unknownSession.examines], [["LOGIN", "EXAMINE", "SEARCH", "EXAMINE", "SEARCH", "LOGOUT"], ["[Gmail]/Drafts", "[Gmail]/Sent Mail"]],
			"§4 ...after Drafts and then Sent Mail were searched, each opened read-only");

		// A draft a person sent from Drafts lives in Sent Mail.
		const SENT_ID = "<made-up-0002.auto-invoice@example.com>";
		sent.push(SENT_ID);
		const inSent = await find({ messageId: SENT_ID });
		const sentSession = sessions[sessions.length - 1];
		await within(sentSession.closed, 3000);
		eq(inSent.value, { found: true, count: 1, mailbox: "[Gmail]/Sent Mail" }, "§4 a draft a person has sent is found in Sent Mail, and says so");
		eq(sentSession.commands, ["LOGIN", "EXAMINE", "SEARCH", "EXAMINE", "SEARCH", "LOGOUT"], "§4 ...Drafts first, then Sent Mail: EXAMINE and SEARCH only, never SELECT, STORE or APPEND");
		eq(sentSession.examines, ["[Gmail]/Drafts", "[Gmail]/Sent Mail"], "§4 ...both opened with EXAMINE (read-only)");
		eq((await find({ messageId: SENT_ID, mailboxes: ["[Gmail]/Drafts"] })).value, { found: false, count: 0, mailbox: "" }, "§4 a search asked for Drafts alone looks nowhere else");
		answer.examineNo = "[Gmail]/Sent Mail";
		const noSent = await find({ messageId: "<made-up-9998.auto-invoice@example.com>" });
		eq(noSent.error && [noSent.error.stage, noSent.error.answered, noSent.value], ["examine", true, undefined],
			"§4 a Sent Mail that can't be opened rejects (stage examine): \"absent\" is never said without both searches");
		answer.examineNo = "";
		const dialsBeforeBoxes = dials.length;
		const badBoxes = await Promise.all([[], ["[Gmail]/Drafts\r\na9 SELECT x"], "[Gmail]/Drafts", [""]].map((mailboxes) => find({ mailboxes })));
		eq([badBoxes.map((r) => r.error && r.error.stage), dials.length], [["credentials", "credentials", "credentials", "credentials"], dialsBeforeBoxes],
			"§4 a mailbox list that is empty, not a list, or holds a line break is refused before any connection");
		answer.search = "NO";
		const searchNo = await find();
		eq(searchNo.error && [searchNo.error.stage, searchNo.error.answered], ["search", true], "§4 a NO to the SEARCH rejects: stage search");
		answer.search = "OK";
		answer.login = "NO";
		const findNoLogin = await find();
		eq(findNoLogin.error && [findNoLogin.error.message, findNoLogin.error.stage], ["IMAP LOGIN failed", "login"], "§4 a NO to the search's LOGIN: stage login");
		answer.login = "OK";
		answer.greeting = "HANG";
		const findSilent = await find({ timeoutMs: 300 });
		eq(findSilent.error && findSilent.error.stage, "greeting", "§4 no greeting to the search: stage greeting");
		answer.greeting = "OK";
		const dialsBeforeFind = dials.length;
		const findBad = await find({ messageId: "not an id" });
		const findNoPass = await find({ pass: "" });
		eq([findBad.error && findBad.error.stage, findNoPass.error && findNoPass.error.stage, dials.length], ["credentials", "credentials", dialsBeforeFind],
			"§4 a malformed Message-ID or no credentials is refused before any connection");

		section("§6  fetchMessages(): Sent Mail read with EXAMINE and BODY.PEEK only");
		const { fetchMessages } = require(path.join(__dirname, "..", "lib", "imap-draft.js"));
		ok(typeof fetchMessages === "function", "§6 FAILS ON THE OLD CODE: lib/imap-draft.js exports fetchMessages()");
		if (typeof fetchMessages === "function") {
			// The second message's body holds a line shaped like the command's own
			// tagged answer, and every byte value: a literal is taken by its length.
			const msgA = Buffer.from("Subject: Example Broker Order #123456789\r\nTo: billing@example-broker.test\r\n\r\nmade-up body A\r\n", "latin1");
			const msgB = Buffer.concat([Buffer.from("Subject: Re: Example Broker Order #123456789\r\n\r\nline\r\na5 OK FETCH completed\r\n", "latin1"),
				Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from("\r\nend\r\n", "latin1")]);
			sentRaw.push({ subject: "Example Broker Order #123456789", raw: msgA }, { subject: "Example Broker Order #999", raw: Buffer.from("Subject: other\r\n\r\nx\r\n") },
				{ subject: "Re: Example Broker Order #123456789", raw: msgB });
			const since = new Date("2026-10-20T00:00:00Z");
			const before = new Date("2026-11-03T00:00:00Z");
			const fetch = (over = {}) => settle(fetchMessages({ user: USER, pass: PASS, since, before, subject: "123456789", timeoutMs: 3000, ...over }));
			const got = await fetch();
			const fs6 = sessions[sessions.length - 1];
			await within(fs6.closed, 3000);
			eq(got.error ? got.error.message : null, null, "§6 it resolves");
			eq(got.value && got.value.messages.map((m) => [m.seq, m.internalDate]), [[1, "20-Oct-2026 14:00:00 +0000"], [3, "20-Oct-2026 14:00:00 +0000"]], "§6 the two messages the search found, with their INTERNALDATE");
			ok(got.value && got.value.messages[0].raw.equals(msgA) && got.value.messages[1].raw.equals(msgB), "§6 each message's bytes exactly, a tagged-answer line and every byte value inside included");
			eq(fs6.commands, ["LOGIN", "EXAMINE", "SEARCH", "FETCH", "LOGOUT"], "§6 the session is LOGIN, EXAMINE, SEARCH, FETCH, LOGOUT and nothing else");
			eq(fs6.examines, ["[Gmail]/Sent Mail"], "§6 Sent Mail opened read-only (EXAMINE)");
			eq(fs6.criteria, "SINCE 20-Oct-2026 BEFORE 3-Nov-2026 SUBJECT \"123456789\"", "§6 searched by date and the subject word");
			ok(/BODY\.PEEK\[\]/.test(fs6.fetch || "") && !/BODY\[/.test(String(fs6.fetch || "").replace(/BODY\.PEEK\[/g, "")), "§6 fetched with BODY.PEEK[] (never marks a message read), never BODY[]");
			ok(!fs6.commands.some((c) => /^(SELECT|STORE|APPEND|COPY|MOVE|EXPUNGE|UID)$/.test(c)), "§6 never SELECT, STORE, APPEND, COPY, MOVE, EXPUNGE or UID");
			const none = await fetch({ subject: "777" });
			const fsNone = sessions[sessions.length - 1];
			await within(fsNone.closed, 3000);
			eq([none.value, fsNone.commands], [{ messages: [], count: 0 }, ["LOGIN", "EXAMINE", "SEARCH", "LOGOUT"]], "§6 nothing found: no FETCH");
			const many = await fetch({ maxMessages: 1 });
			eq(many.error && many.error.stage, "search", "§6 more found than maxMessages: a failure (stage search), never a partial answer");
			answer.fetch = "NO";
			const fetchNo = await fetch();
			eq(fetchNo.error && [fetchNo.error.stage, fetchNo.error.answered], ["fetch", true], "§6 a NO to the FETCH: stage fetch");
			answer.fetch = "OK";
			const dialsBefore6 = dials.length;
			const refused = await Promise.all([{ since: null }, { before: since }, { subject: "two words" }, { subject: "x\"y" }, { mailbox: "[Gmail]/Sent Mail\r\na9 SELECT x" }, { pass: "" }].map((o) => fetch(o)));
			eq([refused.map((r) => r.error && r.error.stage), dials.length], [["credentials", "credentials", "credentials", "credentials", "credentials", "credentials"], dialsBefore6],
				"§6 no dates, dates out of order, a subject that isn't one plain word, a mailbox with a line break or no password: refused before any connection");
			// Its IMAP command strings, read from the source: the read-only four only.
			const SRC = fs.readFileSync(path.join(__dirname, "..", "lib", "imap-draft.js"), "utf8");
			const at = SRC.indexOf("const FETCH_STAGES");
			const fetchSrc = at < 0 ? "" : SRC.slice(at, SRC.indexOf("module.exports", at));
			ok(/"EXAMINE "/.test(fetchSrc) && /BODY\.PEEK\[\]/.test(fetchSrc), "§6 its source sends EXAMINE and BODY.PEEK[]");
			eq((fetchSrc.match(/\b(SELECT|STORE|APPEND|COPY|MOVE|EXPUNGE)\b/g) || []), [], "§6 ...and names no SELECT, STORE, APPEND, COPY, MOVE or EXPUNGE");
		}
	} finally {
		tls.connect = realConnect;
		server.close();
	}

	section("§5  the harness's fake Gmail answers EXAMINE, SELECT and SEARCH");
	const captures = fs.mkdtempSync(path.join(os.tmpdir(), "imap-draft-fake-gmail-"));
	try {
		const child = spawnSync(process.execPath, ["--require", FAKE_GMAIL, __filename, CHILD_FLAG], {
			encoding: "utf8",
			timeout: 20_000,
			env: { ...process.env, E2E_FAKE_GMAIL_DIR: captures },
		});
		let got = null;
		try { got = JSON.parse(child.stdout); } catch { /* asserted below */ }
		eq(child.status, 0, `§5 the child ran (stderr: ${String(child.stderr || "").trim().split("\n").slice(-1)[0] || "none"})`);
		const g = got || {};
		eq(g.appended, [true, true, true], "§5 three drafts appended through the library");
		eq(g.findA, { found: true, count: 1, mailbox: "[Gmail]/Drafts" }, "§5 findDraftByMessageId() finds the first draft by its Message-ID");
		eq(g.findB, { found: true, count: 1, mailbox: "[Gmail]/Drafts" }, "§5 and the second");
		eq(g.findUnknown, { found: false, count: 0, mailbox: "" }, "§5 an unknown Message-ID is not found (Drafts and Sent Mail both answer)");
		eq(g.raw, [
			"a1 OK", "a2 BAD", "* 3 EXISTS", "a3 OK", "* SEARCH 2", "a4 OK", "* SEARCH", "a5 OK", "a6 BAD", "a7 OK",
		], "§5 raw: LOGIN; SEARCH before a mailbox BAD; SELECT counts 3; SEARCH finds #2; an unknown id finds none; SEARCH ALL is BAD");
		const drafts = readDrafts(captures);
		eq(drafts.map((dr) => dr.messageId).slice(0, 2), [CHILD_IDS.a, CHILD_IDS.b], "§5 readCapturedDrafts() reports each draft's Message-ID");
		ok(drafts[2] && /^<[^<>@\s]+@example\.com>$/.test(drafts[2].messageId), "§5 a draft appended without one has MailComposer's");
	} finally {
		fs.rmSync(captures, { recursive: true, force: true });
	}
}

function readDrafts(dir) {
	try {
		return require(FAKE_GMAIL).readCapturedDrafts(dir);
	} catch (e) {
		failures.push(`§5 readCapturedDrafts threw: ${e.message}`);
		return [];
	}
}

// ------------------------------------------------------- the §5 child process
// Runs with fake-gmail.cjs preloaded: imap.gmail.com is its fake IMAP server.
const CHILD_IDS = { a: "<made-up-a.auto-invoice@example.com>", b: "<made-up-b.auto-invoice@example.com>" };
async function fakeGmailChild() {
	const common = {
		user: USER, pass: "made-up", to: TO, subject: SUBJECT, html: HTML, timeoutMs: 5000,
		attachments: [{ filename: PDF_NAME, content: PDF, contentType: "application/pdf" }],
	};
	const appended = [];
	for (const messageId of [CHILD_IDS.a, CHILD_IDS.b, undefined]) {
		appended.push(Boolean((await appendGmailDraft({ ...common, messageId })).ok));
	}
	const search = (messageId) => findDraftByMessageId({ user: USER, pass: "made-up", messageId, timeoutMs: 5000 });
	const out = {
		appended,
		findA: await search(CHILD_IDS.a),
		findB: await search(CHILD_IDS.b),
		findUnknown: await search("<made-up-none.auto-invoice@example.com>"),
	};
	out.raw = await rawSession([
		'a1 LOGIN "u" "p"',
		`a2 SEARCH HEADER Message-ID "${CHILD_IDS.b}"`,
		'a3 SELECT "[Gmail]/Drafts"',
		`a4 SEARCH HEADER Message-ID "${CHILD_IDS.b}"`,
		'a5 SEARCH HEADER Message-ID "<made-up-none@example.com>"',
		"a6 SEARCH ALL",
		"a7 LOGOUT",
	]);
	process.stdout.write(JSON.stringify(out));
}

// One IMAP session, a command at a time: each waits for its tagged answer. The
// result is the tagged answers' tag and status, with the untagged EXISTS and
// SEARCH lines between them.
function rawSession(commands) {
	return new Promise((resolve, reject) => {
		const sock = tls.connect(993, "imap.gmail.com", { servername: "imap.gmail.com" });
		const seen = [];
		let acc = "";
		let next = 0;
		const send = () => sock.write(commands[next] + "\r\n");
		const timer = setTimeout(() => reject(new Error(`raw session stalled at ${commands[next]}`)), 5000);
		sock.on("error", reject);
		sock.on("data", (d) => {
			acc += d.toString("latin1");
			let eol;
			while ((eol = acc.indexOf("\r\n")) >= 0) {
				const line = acc.slice(0, eol);
				acc = acc.slice(eol + 2);
				if (/^\* OK /.test(line) && next === 0 && !seen.length) { send(); continue; }
				if (/^\* (\d+ EXISTS|SEARCH\b)/.test(line)) { seen.push(line.trim()); continue; }
				const t = /^(a\d+) (OK|NO|BAD)\b/.exec(line);
				if (!t) continue;
				seen.push(`${t[1]} ${t[2]}`);
				next++;
				if (next < commands.length) send();
				else { clearTimeout(timer); sock.end(); resolve(seen); }
			}
		});
	});
}

// ------------------------------------------------------------ §8 the fake mailbox
// LOGIN, CAPABILITY, EXAMINE, SEARCH X-GM-RAW, SEARCH SUBJECT, FETCH of the header
// fields and BODYSTRUCTURE, LOGOUT; anything else is BAD. A mailbox holds made-up
// messages: { subject, date, to, cc, bcc, names, text, lagging, rawHeaders, structure }.
// Gmail's web search finds a term in the subject, the attachment names or the text
// (body or PDF), leaves Trash out unless asked with in:trash, and misses a `lagging`
// message; SEARCH SUBJECT reads subjects only. FETCH answers the items in Gmail's own
// order, BODYSTRUCTURE first, and only the header fields asked for.
// `script.get(VERB)` answers instead when it returns a list: strings are lines, a Buffer is
// raw bytes, MAILBOX_DROP closes the connection, an empty list hangs.
const MAILBOX_DROP = Symbol("drop");
const FETCH_ASK = /^(\d{1,6}(?:,\d{1,6}){0,60}) \(BODY\.PEEK\[HEADER\.FIELDS \(([A-Z ]{1,40})\)\] BODYSTRUCTURE\)$/;
function fakeMailbox() {
	const sessions = [];
	const boxes = { "[Gmail]/Drafts": [], "[Gmail]/Sent Mail": [], "[Gmail]/Trash": [] };
	const script = new Map();
	const opts = { greeting: "* OK Gimap ready", capability: "IMAP4rev1 IDLE UIDPLUS X-GM-EXT-1 CHILDREN", headerFirst: false, inPieces: false };
	const server = net.createServer((sock) => {
		const s = { commands: [], lines: [], examines: [], searches: [], fetches: [] };
		s.closed = new Promise((resolve) => sock.on("close", resolve));
		sessions.push(s);
		let buf = "";
		let box = null;
		const reply = (line) => sock.write(line + "\r\n");
		sock.on("error", () => {});
		if (opts.greeting) reply(opts.greeting);
		sock.on("data", (chunk) => {
			buf += chunk.toString("latin1");
			let eol;
			while ((eol = buf.indexOf("\r\n")) >= 0) {
				const line = buf.slice(0, eol);
				buf = buf.slice(eol + 2);
				s.lines.push(line);
				const [tag, word = ""] = line.split(" ", 2);
				const verb = word.toUpperCase();
				const args = line.slice(tag.length + word.length + 2);
				s.commands.push(verb);
				const scriptedAnswer = script.get(verb);
				let scripted = null;
				if (typeof scriptedAnswer === "function") scripted = scriptedAnswer(tag, args, s);
				if (scripted) {
					for (const x of scripted) {
						if (x === MAILBOX_DROP) { sock.destroy(); return; }
						if (Buffer.isBuffer(x)) sock.write(x);
						else reply(x);
					}
					continue;
				}
				if (verb === "LOGIN") {
					reply(`${tag} OK ${unquote(args.split(" ")[0])} authenticated (Success)`);
				} else if (verb === "CAPABILITY") {
					reply(`* CAPABILITY ${opts.capability}`);
					reply(`${tag} OK Success`);
				} else if (verb === "EXAMINE") {
					const name = /^"[^"]*"$/.test(args) ? unquote(args) : "";
					s.examines.push(name);
					if (!boxes[name]) { reply(`${tag} NO [NONEXISTENT] Unknown Mailbox`); continue; }
					box = name;
					reply(`* ${boxes[box].length} EXISTS`);
					reply("* OK [PERMANENTFLAGS ()] Flags permitted.");
					reply(`${tag} OK [READ-ONLY] ${box} selected. (Success)`);
				} else if (verb === "SEARCH") {
					s.searches.push(args);
					const raw = new RegExp(`^X-GM-RAW (${QUOTED})$`, "i").exec(args);
					const plain = new RegExp(`^SUBJECT (${QUOTED})$`, "i").exec(args);
					const web = raw && /^(in:trash )?"([^"]{1,80})"$/.exec(unquote(raw[1]));
					if (!box || (!web && !plain)) { reply(`${tag} BAD Could not parse command`); continue; }
					const term = (web ? web[2] : unquote(plain[1])).toLowerCase();
					const inWeb = (m) => !m.lagging && (box !== "[Gmail]/Trash" || web[1]) && [m.subject, ...(m.names || []), m.text].some((t) => String(t || "").toLowerCase().includes(term));
					const inSubject = (m) => String(m.subject || "").toLowerCase().includes(term);
					const hits = boxes[box].map((m, i) => ((web ? inWeb(m) : inSubject(m)) ? i + 1 : 0)).filter(Boolean);
					reply(`* SEARCH${hits.map((n) => ` ${n}`).join("")}`);
					reply(`${tag} OK SEARCH completed (Success)`);
				} else if (verb === "FETCH") {
					s.fetches.push(args);
					const ask = FETCH_ASK.exec(args);
					if (!box || !ask) { reply(`${tag} BAD Could not parse command`); continue; }
					const fields = ask[2].split(" ");
					const pieces = ask[1].split(",").map(Number).filter((n) => boxes[box][n - 1]).map((n) => {
						const m = boxes[box][n - 1];
						const block = m.rawHeaders !== undefined ? m.rawHeaders : `${fields.map((f) => {
							const v = { SUBJECT: m.subject, DATE: m.date, TO: m.to, CC: m.cc, BCC: m.bcc }[f];
							return v ? `${f[0]}${f.slice(1).toLowerCase()}: ${v}\r\n` : "";
						}).join("")}\r\n`;
						const parts = (m.names || []).map((x) => `("APPLICATION" "PDF" ("NAME" "${x.replace(/(["\\])/g, "\\$1")}") NIL NIL "BASE64" 10 NIL ("ATTACHMENT" ("FILENAME" "${x.replace(/(["\\])/g, "\\$1")}")) NIL)`).join("");
						const structure = m.structure || (parts ? `(("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1 NIL NIL NIL)${parts} "MIXED")` : '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1 NIL NIL NIL)');
						const bytes = Buffer.from(block, "utf8").toString("latin1");
						const head = `BODY[HEADER.FIELDS (${ask[2]})] {${bytes.length}}\r\n${bytes}`;
						return opts.headerFirst
							? `* ${n} FETCH (${head} BODYSTRUCTURE ${structure})\r\n`
							: `* ${n} FETCH (BODYSTRUCTURE ${structure} ${head})\r\n`;
					});
					const answer = Buffer.from(`${pieces.join("")}${tag} OK Success\r\n`, "latin1");
					if (opts.inPieces) {
						sock.write(answer.subarray(0, answer.length >> 1));
						setTimeout(() => sock.write(answer.subarray(answer.length >> 1)), 5);
					} else sock.write(answer);
				} else if (verb === "LOGOUT") {
					reply("* BYE LOGOUT Requested");
					reply(`${tag} OK 73 good day (Success)`);
					sock.end();
					return;
				} else {
					reply(`${tag} BAD Could not parse command`);
				}
			}
		});
	});
	return { server, sessions, boxes, script, opts };
}

// ---------------------------------------------------------- §8 the search and classifier
// lib/invoice-mailbox-search.js, the read-only search and the classifier. Made-up data.
//   THE CLASSIFIER. One case per row of the table: Invoice needs a recipient outside, the
//   load named as a whole token, no reply prefix, and the word invoice or `Order #<n>`.
//   Ignored has to be proven: a To, every recipient on the mailbox's domain, no invoice
//   look. The app's own mail reads Ignored by shape: its alerts whatever the To, its mail
//   to itself only when sent to this mailbox alone. Anything else is a Mention.
//   THE SESSION. Exactly LOGIN, CAPABILITY, EXAMINE, SEARCH, FETCH, LOGOUT; a term failing
//   the shape is never sent; a NO, BAD, BYE, throttle, unreadable answer, dropped
//   connection or missing X-GM-EXT-1 rejects, never "nothing found"; no server text in an
//   error; To, Cc, Bcc and Subject never leave the function.
async function mailboxSearchSection() {
	section("§8  the read-only mailbox search and its classifier");
	const LIB_FILE = path.join(__dirname, "..", "lib", "invoice-mailbox-search.js");
	let lib = null;
	try { lib = require(LIB_FILE); } catch { /* asserted next */ }
	ok(lib, "§8 FAILS ON THE OLD CODE: lib/invoice-mailbox-search.js exists");
	if (!lib) return;
	const { searchMailboxForLoad, classifyHit, searchTerm, searchTermsFor, parseAddressList, KIND, CLEAN, MAILBOXES } = lib;
	const OWN = "info@example.test";
	const COLLEAGUE = "dispatch@example.test";
	const BROKER = "billing@example-broker.test";
	const LOAD = "900000019";
	const ORDER = "7000001";
	const INV = "12312099-3";
	const ENGINE_SUBJECT = `Example Broker Order #${LOAD}`;
	const ENGINE_FILE = `Example Broker Invoice Order #${LOAD}.pdf`;
	const WEEK = "2026-10-24 to 2026-10-30";
	const EM = "\u2014";
	const DOT = "\u00b7";
	const WARN = "\u26a0\ufe0f";
	const ctx = { ownAddress: OWN, terms: [LOAD, ORDER, INV] };
	const read = (hit, over = {}) => classifyHit(hit, { ...ctx, ...over }).kind;

	// -------------------------------------------------- the classifier, row by row
	const { INVOICE, MENTION, IGNORED } = KIND;
	for (const [label, hit, want] of [
		// Invoice: outside, names it, not a reply, says invoice or ends Order #<that number>.
		["the engine's own send: <Broker> Order #<n>, to the broker", { subject: ENGINE_SUBJECT, to: BROKER, attachmentNames: [ENGINE_FILE] }, INVOICE],
		["the subject ends Order #<n> and no attachment says invoice", { subject: ENGINE_SUBJECT, to: BROKER }, INVOICE],
		["a Bison invoice: Order #<the row's order number>, not the load number", { subject: `Example Transport Order #${ORDER}`, to: BROKER }, INVOICE],
		["the subject says invoice and names the load", { subject: `Invoice for load ${LOAD}`, to: BROKER }, INVOICE],
		["only an attachment says invoice and names the load", { subject: "Paperwork", to: BROKER, attachmentNames: [`Invoice_${LOAD}.pdf`] }, INVOICE],
		["the subject says invoice, a POD file names the load", { subject: "Your invoice", to: BROKER, attachmentNames: [`POD_1_of_2_${LOAD}.pdf`] }, INVOICE],
		["by the row's invoice number", { subject: `Invoice ${INV}`, to: BROKER }, INVOICE],
		["a Cc outside the company counts as outside", { subject: ENGINE_SUBJECT, to: COLLEAGUE, cc: BROKER }, INVOICE],
		["To on the company's domain, the broker on Bcc, reads Invoice", { subject: ENGINE_SUBJECT, to: COLLEAGUE, bcc: BROKER, attachmentNames: [ENGINE_FILE] }, INVOICE],
		["INV-<n>.pdf says invoice", { subject: "Paperwork", to: BROKER, attachmentNames: [`INV-${LOAD}.pdf`] }, INVOICE],
		// Mention: anything that can't be placed.
		["a draft with a blank To, the engine's subject and invoice file is never Ignored", { subject: ENGINE_SUBJECT, to: "", attachmentNames: [ENGINE_FILE] }, MENTION],
		["a blank To with no invoice look is not proven internal either", { subject: `Load ${LOAD} notes`, to: "" }, MENTION],
		["an internal subject ending Order #<n> has an invoice look", { subject: ENGINE_SUBJECT, to: COLLEAGUE }, MENTION],
		["an internal note with an invoice-named attachment", { subject: `Load ${LOAD} paperwork`, to: COLLEAGUE, attachmentNames: ["Invoice draft.pdf"] }, MENTION],
		["an internal subject saying invoice that names no load", { subject: "Invoice question", to: COLLEAGUE }, MENTION],
		["an internal subject that says invoice and names the load", { subject: `Invoice for ${LOAD}?`, to: COLLEAGUE }, MENTION],
		["a Re: to the broker", { subject: `Re: Invoice for load ${LOAD}`, to: BROKER }, MENTION],
		["a Fw: to the broker", { subject: `Fw: ${ENGINE_SUBJECT}`, to: BROKER }, MENTION],
		["a Fwd: to the broker", { subject: `FWD: ${ENGINE_SUBJECT}`, to: BROKER }, MENTION],
		["a numbered reply to the broker", { subject: `RE[2]: ${ENGINE_SUBJECT}`, to: BROKER }, MENTION],
		["outside and says invoice, but names no load", { subject: "Invoice for last week", to: BROKER, attachmentNames: ["inv.pdf"] }, MENTION],
		["outside and names the load, but no invoice word", { subject: `Load ${LOAD} pickup update`, to: BROKER }, MENTION],
		["a longer number holding the load number is not a token", { subject: `Invoice ${LOAD}0`, to: BROKER }, MENTION],
		["letters glued to the load number are not a token", { subject: `Invoice CHR${LOAD}`, to: BROKER }, MENTION],
		["Order #<another number> outside is no invoice for this load", { subject: "Example Broker Order #123456789", to: BROKER }, MENTION],
		["...even with a POD file naming this load beside it", { subject: "Example Broker Order #123456789", to: BROKER, attachmentNames: [`POD_${LOAD}.pdf`] }, MENTION],
		["a blank subject outside is a hit, and doubt", { subject: "", to: BROKER }, MENTION],
		["a header block too long to read is a hit, and doubt", { unreadable: true, attachmentNames: [] }, MENTION],
		["a group address can't be read, so not internal", { subject: `Load ${LOAD} notes`, to: "undisclosed-recipients:;" }, MENTION],
		["one unreadable Cc among internal recipients", { subject: `Load ${LOAD} notes`, to: COLLEAGUE, cc: "not an address" }, MENTION],
		["one unreadable Bcc among internal recipients", { subject: `Load ${LOAD} notes`, to: COLLEAGUE, bcc: "not an address" }, MENTION],
		["an unterminated quote can hide a recipient", { subject: `Load ${LOAD} notes`, to: `"a <${COLLEAGUE}>, ${BROKER}` }, MENTION],
		["two angle-addrs with no comma can hide a recipient", { subject: `Load ${LOAD} notes`, to: `<${BROKER}> <${COLLEAGUE}>` }, MENTION],
		["an unterminated comment can hide a recipient", { subject: `Load ${LOAD} notes`, to: `x (y <${BROKER}>, <${COLLEAGUE}>` }, MENTION],
		["an unterminated angle-addr can hide a recipient", { subject: `Load ${LOAD} notes`, to: `"a <${COLLEAGUE}>" <${BROKER}` }, MENTION],
		["Order #<n> in the middle of a subject isn't its ending", { subject: `${ENGINE_SUBJECT} pickup update`, to: BROKER }, MENTION],
		// Ignored: proven internal with no invoice look, or the app's own shape.
		["an internal note naming the load, no invoice look", { subject: `Load ${LOAD} notes`, to: COLLEAGUE }, IGNORED],
		["an internal reply, no invoice look", { subject: `Re: Load ${LOAD} notes`, to: COLLEAGUE, cc: OWN }, IGNORED],
		["a blank subject, proven internal", { subject: "", to: COLLEAGUE }, IGNORED],
		["the app's unusable-address alert to itself", { subject: `${WARN} Load ${LOAD} ingested with an unusable address`, to: OWN }, IGNORED],
		["the mailbox's own domain, any case", { subject: `Load ${LOAD} notes`, to: "Dispatch@EXAMPLE.Test" }, IGNORED],
		// The app's mail to itself, whose subjects say invoice.
		["Weekly Invoices, action needed", { subject: `Weekly Invoices ${EM} ACTION NEEDED ${EM} ${WEEK}`, to: OWN }, IGNORED],
		["Weekly Invoices, plain", { subject: `Weekly Invoices ${EM} ${WEEK}`, to: OWN }, IGNORED],
		["the weekly run's sheet alert", { subject: `Weekly invoices ${EM} ACTION NEEDED ${DOT} ${WEEK}`, to: OWN }, IGNORED],
		["New Invoice, with the driver's PDF", { subject: "New Invoice: INV-MD-2026W43 - Made Up Driver", to: `"LogisX Inc." <${OWN}>`, attachmentNames: ["INV-MD-2026W43.pdf"] }, IGNORED],
		["the digest of completed loads no weekly invoice will bill", { subject: `${WARN} 3 completed loads no weekly invoice will bill`, to: OWN }, IGNORED],
		["...its one-load form", { subject: `${WARN} 1 completed load no weekly invoice will bill`, to: OWN }, IGNORED],
		// The alerts to the notify address, which may be outside.
		["the re-issue alert, To outside the company", { subject: `Load ${LOAD}: a re-issued rate con was held`, to: "owner@elsewhere.test" }, IGNORED],
		["the re-issue alert's other form, To outside", { subject: `Load ${LOAD}: a re-issued rate con changed fields`, to: "owner@elsewhere.test" }, IGNORED],
		["the kept-date alert, To outside", { subject: `Load ${LOAD}: a later rate con did not replace a corrected date`, to: "owner@elsewhere.test" }, IGNORED],
		["the re-issue alert, To inside", { subject: `Load ${LOAD}: a re-issued rate con was held`, to: COLLEAGUE }, IGNORED],
		["the daily integrity digest, To outside", { subject: "LogisX integrity check (Nov 5, 2026): 2 issues", to: "owner@elsewhere.test" }, IGNORED],
		// The shapes are tight: a near miss is at least a Mention.
		["a reply to the re-issue alert", { subject: `Re: Load ${LOAD}: a re-issued rate con was held`, to: "owner@elsewhere.test" }, MENTION],
		["a re-issue alert shape carrying an attachment", { subject: `Load ${LOAD}: a re-issued rate con was held`, to: "owner@elsewhere.test", attachmentNames: ["notes.pdf"] }, MENTION],
		["a re-issue alert shape carrying an invoice for the load", { subject: `Load ${LOAD}: a re-issued rate con was held`, to: BROKER, attachmentNames: [`Invoice ${LOAD}.pdf`] }, INVOICE],
		["Weekly Invoices forwarded to a colleague", { subject: `Weekly Invoices ${EM} ${WEEK}`, to: COLLEAGUE }, MENTION],
		["Weekly Invoices with a Cc", { subject: `Weekly Invoices ${EM} ${WEEK}`, to: OWN, cc: COLLEAGUE }, MENTION],
		["Weekly Invoices with a Bcc", { subject: `Weekly Invoices ${EM} ${WEEK}`, to: OWN, bcc: COLLEAGUE }, MENTION],
		["Weekly Invoices carrying an attachment", { subject: `Weekly Invoices ${EM} ${WEEK}`, to: OWN, attachmentNames: ["x.pdf"] }, MENTION],
		["a reply to Weekly Invoices", { subject: `Re: Weekly Invoices ${EM} ${WEEK}`, to: OWN }, MENTION],
		["New Invoice to a colleague", { subject: "New Invoice: INV-MD-2026W43 - Made Up Driver", to: COLLEAGUE }, MENTION],
		["New Invoice with two attachments", { subject: "New Invoice: INV-MD-2026W43 - Made Up Driver", to: OWN, attachmentNames: ["a.pdf", "b.pdf"] }, MENTION],
		["New Invoice to the broker, naming the load, is an invoice", { subject: `New Invoice: ${LOAD} - Example Broker`, to: BROKER }, INVOICE],
		["New Invoice with no driver part", { subject: "New Invoice: 123", to: OWN }, MENTION],
	]) {
		eq(read(hit), want, `§8 classifier: ${label}: ${want}`);
	}

	// Addresses: the parsed address decides, never a display name.
	for (const [label, to, want] of [
		["a display name naming the company can't hide the broker", `"${OWN}" <${BROKER}>`, INVOICE],
		["a display name naming the broker doesn't make it outside", `"${BROKER}" <${COLLEAGUE}>`, MENTION],
		["a quoted angle-addr can't hide the broker", `"x <${COLLEAGUE}>" <${BROKER}>`, INVOICE],
		["a comma inside a display name doesn't split it", `"Billing, AP" <${BROKER}>, ${COLLEAGUE}`, INVOICE],
		["a comment naming the company can't hide the broker", `${BROKER} (${OWN})`, INVOICE],
		["a subdomain isn't the company", "x@mail.example.test", INVOICE],
		["a lookalike domain isn't the company", "x@example.test.example-broker.test", INVOICE],
		["a longer domain isn't the company", "x@notexample.test", INVOICE],
	]) {
		eq(read({ subject: ENGINE_SUBJECT, to }), want, `§8 classifier: ${label}`);
	}
	eq(parseAddressList(`"A, B" <A@Example.TEST>, c@example-broker.test; (x) d@example.test`), { addresses: ["a@example.test", "c@example-broker.test", "d@example.test"], unreadable: false },
		"§8 parseAddressList(): lower case, split only outside quotes and comments");
	eq(parseAddressList(["a@example.test", "b@example.test"]), { addresses: ["a@example.test", "b@example.test"], unreadable: false }, "§8 parseAddressList(): a header given twice is both");
	eq(parseAddressList("").addresses, [], "§8 parseAddressList(): blank is no address");
	eq(parseAddressList(`${"x".repeat(2000)}@example.test`).unreadable, true, "§8 parseAddressList(): an over-long entry is unreadable");
	eq(read({ subject: ENGINE_SUBJECT, to: BROKER }, { ownAddress: "" }), MENTION, "§8 classifier: no mailbox address to compare with: doubt");
	eq(read({ subject: "=?UTF-8?Q?Weekly_Invoices_=E2=80=94_ACTION_NEEDED_=E2=80=94_2026-10-24_to_2026-10-30?=", to: OWN }), IGNORED, "§8 classifier: Weekly Invoices as MailComposer encodes it");
	const facts = classifyHit({ subject: `Load ${LOAD}: a re-issued rate con was held`, to: "owner@elsewhere.test" }, ctx);
	eq(facts, { kind: IGNORED, namesIt: true, invoiceLook: false, invoiceFile: false, outside: true }, "§8 classifier: the answer is the kind and four facts, no address or subject");

	// ----------------------------------------------------------------- the terms
	eq(searchTerm(`#${LOAD}`), LOAD, "§8 terms: a leading # is dropped");
	eq(searchTerm(` ${LOAD} `), LOAD, "§8 terms: spaces around it are dropped");
	eq(searchTerm(INV), INV, "§8 terms: an invoice number passes");
	eq(searchTerm("ABC-1234"), "ABC-1234", "§8 terms: a load number with letters passes");
	eq(searchTerm("LD_TEST.0007"), "LD_TEST.0007", "§8 terms: . and _ pass");
	const BAD_TERMS = [`${LOAD}" OR "x`, "9000 0019", "in:trash", "OR", "AROUND", `${LOAD}\r\na9 STORE 1 +FLAGS (\\Seen)`, "{5}", "12", "#", "##900000019", "(900000019)", `-${LOAD}`, `${LOAD}-`, "x".repeat(70) + "1", `"${LOAD}"`, "1234*"];
	eq(BAD_TERMS.map(searchTerm), BAD_TERMS.map(() => ""), "§8 terms: quotes, spaces, operators, line breaks, no digit, too short or too long: refused");
	eq(searchTermsFor({ loadNumber: `#${LOAD}`, invoiceNumbers: [INV, "", null], orderNumbers: [LOAD, ORDER] }), { terms: [LOAD, INV, ORDER], unsearchable: 0 },
		"§8 terms: the load number, then each row's numbers; a blank row value and a repeat are dropped");
	eq(searchTermsFor({ loadNumber: LOAD, invoiceNumbers: ["bad term"] }).unsearchable, 1, "§8 terms: a bad row value counts as unsearchable");
	eq(searchTermsFor({ loadNumber: "" }).unsearchable, 1, "§8 terms: no load number counts as unsearchable");
	const MANY_NUMBERS = Array.from({ length: 13 }, (_, i) => `12312099-${i + 1}`);
	const tooMany = searchTermsFor({ loadNumber: LOAD, invoiceNumbers: MANY_NUMBERS });
	eq([tooMany.terms.length, tooMany.unsearchable], [12, 2], "§8 terms: more numbers than a search takes count as unsearchable, so none goes unsearched quietly");
	eq(searchTermsFor({ loadNumber: LOAD, invoiceNumbers: MANY_NUMBERS.slice(0, 11) }), { terms: [LOAD, ...MANY_NUMBERS.slice(0, 11)], unsearchable: 0 }, "§8 terms: exactly 12 is fine");

	// ---------------------------------------------------------------- the session
	const fake = fakeMailbox();
	await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
	const port = fake.server.address().port;
	const realConnect = tls.connect;
	const dials = [];
	tls.connect = (...args) => {
		dials.push(args);
		return net.connect(port, "127.0.0.1");
	};
	const DATE = "Wed, 04 Nov 2026 15:00:00 +0000";
	const mail = (over = {}) => ({ subject: "", date: DATE, to: "", cc: "", bcc: "", names: [], text: "", ...over });
	const clearBoxes = () => { for (const k of Object.keys(fake.boxes)) fake.boxes[k].length = 0; };
	const SENT = fake.boxes[MAILBOXES.sent];
	const DRAFTS = fake.boxes[MAILBOXES.drafts];
	const TRASH = fake.boxes[MAILBOXES.trash];
	const noScript = () => fake.script.clear();
	const run = async (over = {}) => {
		const before = fake.sessions.length;
		const r = await settle(searchMailboxForLoad({ user: OWN, pass: "made-up-pass", loadNumber: LOAD, timeoutMs: 2000, ...over }));
		const s = fake.sessions.length > before ? fake.sessions[fake.sessions.length - 1] : null;
		if (s) await within(s.closed, 2500);
		return { value: r.value, error: r.error, s };
	};
	const EMPTY_BOX = { hits: 0, invoice: 0, mention: 0, ignored: 0, ignoredNamed: 0, overCap: 0, firstInvoiceDate: null };
	const q = (term) => `X-GM-RAW "\\"${term}\\""`;

	try {
		const clean = await run();
		eq(clean.value, { verdict: CLEAN, mailboxes: { drafts: EMPTY_BOX, sent: EMPTY_BOX } }, "§8 FAILS ON THE OLD CODE: both mailboxes answered with nothing: clean");
		eq(clean.s.commands, ["LOGIN", "CAPABILITY", "EXAMINE", "SEARCH", "EXAMINE", "SEARCH", "LOGOUT"], "§8 nothing found: LOGIN, CAPABILITY, EXAMINE, SEARCH per mailbox, LOGOUT, no FETCH");
		eq(dials[dials.length - 1], [993, "imap.gmail.com", { servername: "imap.gmail.com" }], "§8 it connects to imap.gmail.com:993 over TLS");
		eq(clean.s.lines.slice(0, 4), ['a1 LOGIN "info@example.test" "made-up-pass"', "a2 CAPABILITY", 'a3 EXAMINE "[Gmail]/Drafts"', `a4 SEARCH ${q(LOAD)}`], "§8 the commands, word for word: EXAMINE, never SELECT; the term is one quoted phrase");

		SENT.push(mail({ subject: ENGINE_SUBJECT, to: BROKER, names: [ENGINE_FILE] }));
		DRAFTS.push(mail({ subject: `Re: Load ${LOAD} tracking`, to: BROKER }));
		const both = await run();
		eq(both.s.commands, ["LOGIN", "CAPABILITY", "EXAMINE", "SEARCH", "FETCH", "EXAMINE", "SEARCH", "FETCH", "LOGOUT"], "§8 FAILS ON THE OLD CODE: exactly the listed commands: LOGIN, CAPABILITY, EXAMINE, SEARCH, FETCH, LOGOUT");
		eq(both.s.fetches, ["1 (BODY.PEEK[HEADER.FIELDS (SUBJECT DATE TO CC BCC)] BODYSTRUCTURE)", "1 (BODY.PEEK[HEADER.FIELDS (SUBJECT DATE TO CC BCC)] BODYSTRUCTURE)"], "§8 FETCH reads headers and BODYSTRUCTURE with BODY.PEEK, Bcc included, never a body");
		eq(both.s.examines, ["[Gmail]/Drafts", "[Gmail]/Sent Mail"], "§8 Drafts and Sent Mail, each opened read-only; Trash isn't opened");
		eq(both.value, { verdict: INVOICE, mailboxes: { drafts: { ...EMPTY_BOX, hits: 1, mention: 1 }, sent: { ...EMPTY_BOX, hits: 1, invoice: 1, firstInvoiceDate: "2026-11-04T15:00:00.000Z" } } }, "§8 the answer: an invoice in Sent Mail, a mention in Drafts, the invoice's date");

		// The answer holds no address, subject or file name, nor do the console or an error.
		const printed = [];
		const realLog = { log: console.log, warn: console.warn, error: console.error, info: console.info };
		for (const k of Object.keys(realLog)) console[k] = (...a) => printed.push(a.join(" "));
		let quiet;
		try { quiet = await run(); } finally { Object.assign(console, realLog); }
		const leaked = JSON.stringify(quiet.value);
		ok(quiet.value && !/@|example-broker|Example Broker|Order|tracking|Re:|\.pdf/.test(leaked), "§8 To never leaves: no address, subject or file name in the answer");
		eq(Object.keys(quiet.value), ["verdict", "mailboxes"], "§8 To never leaves: the answer is the verdict and the mailboxes");
		eq(Object.keys(quiet.value.mailboxes.sent), Object.keys(EMPTY_BOX), "§8 To never leaves: a mailbox's answer is counts and a date");
		eq(printed, [], "§8 To never leaves: nothing on the console");

		// The app's own mail, whose body or PDF names the load, doesn't count.
		clearBoxes();
		SENT.push(mail({ subject: `Weekly Invoices ${EM} ACTION NEEDED ${EM} ${WEEK}`, to: OWN, text: `Undated loads: ${LOAD}` }));
		SENT.push(mail({ subject: "New Invoice: INV-MD-2026W43 - Made Up Driver", to: OWN, names: ["INV-MD-2026W43.pdf"], text: `Day grid: ${LOAD}` }));
		SENT.push(mail({ subject: `${WARN} 2 completed loads no weekly invoice will bill`, to: OWN, text: `Load ${LOAD}` }));
		SENT.push(mail({ subject: `Load ${LOAD}: a re-issued rate con was held`, to: "owner@elsewhere.test" }));
		const own = await run();
		eq([own.value.verdict, own.value.mailboxes.sent], [CLEAN, { ...EMPTY_BOX, hits: 4, ignored: 4, ignoredNamed: 2 }], "§8 an unbilled load named only by the app's own mail reads clean; ignoredNamed counts the two naming a load or carrying an invoice-named file");

		// A real invoice through the whole session: never clean.
		clearBoxes();
		DRAFTS.push(mail({ subject: ENGINE_SUBJECT, names: [ENGINE_FILE] }));
		const blankTo = await run();
		eq([blankTo.value.verdict, blankTo.value.mailboxes.drafts.mention], [MENTION, 1], "§8 a draft with a blank To and an invoice file: a mention, never clean");
		clearBoxes();
		SENT.push(mail({ subject: ENGINE_SUBJECT, to: COLLEAGUE, bcc: BROKER, names: [ENGINE_FILE] }));
		const onBcc = await run();
		eq([onBcc.value.verdict, onBcc.value.mailboxes.sent.invoice], [INVOICE, 1], "§8 the broker on Bcc reaches the classifier: an invoice");
		clearBoxes();
		SENT.push(mail({ subject: `Load ${LOAD}: a re-issued rate con changed fields`, to: "owner@elsewhere.test" }));
		const alertOutside = await run();
		eq(alertOutside.value.verdict, CLEAN, "§8 the re-issue alert to an outside address: clean, so Try again isn't refused on a re-issued load");

		// A blank subject is a hit, not a line to skip.
		clearBoxes();
		SENT.push(mail({ subject: "", to: BROKER, text: LOAD }));
		const blankSubject = await run();
		eq([blankSubject.value.verdict, blankSubject.value.mailboxes.sent.mention], [MENTION, 1], "§8 a hit with a blank subject is a mention, not skipped");
		clearBoxes();
		SENT.push(mail({ rawHeaders: "\r\n", text: LOAD }));
		const blankHeaders = await run();
		eq(blankHeaders.value.verdict, MENTION, "§8 a hit with no headers at all is a mention");
		for (const [label, item] of [["NIL", "NIL"], ["an empty string", '""']]) {
			fake.script.set("FETCH", (t) => [`* 1 FETCH (BODYSTRUCTURE ("TEXT" "HTML" NIL NIL NIL "7BIT" 1 1) BODY[HEADER.FIELDS (SUBJECT DATE TO CC BCC)] ${item})`, `${t} OK Success`]);
			const r = await run();
			noScript();
			eq(r.value && r.value.verdict, MENTION, `§8 a header item answered as ${label} is a mention`);
		}

		// Every search term, in every mailbox.
		clearBoxes();
		const terms = await run({ loadNumber: `#${LOAD}`, invoiceNumbers: [INV, null], orderNumbers: [ORDER, LOAD] });
		eq(terms.s.searches, [q(LOAD), q(INV), q(ORDER), q(LOAD), q(INV), q(ORDER)], "§8 the load number, each row's invoice and order number, in each mailbox");
		SENT.push(mail({ subject: `Example Transport Order #${ORDER}`, to: BROKER, text: "no load number here" }));
		const byOrder = await run({ orderNumbers: [ORDER] });
		eq(byOrder.value.verdict, INVOICE, "§8 a Bison invoice with only the order number is found and reads as an invoice");

		// A term failing the shape is never sent, and nothing connects.
		const dialsBefore = dials.length;
		const sessionsBefore = fake.sessions.length;
		for (const [label, over] of [
			["a load number with a quote", { loadNumber: `${LOAD}" OR "x` }],
			["a load number with a space", { loadNumber: "9000 0019" }],
			["a load number with a line break", { loadNumber: `${LOAD}\r\na9 STORE 1 +FLAGS (\\Seen)` }],
			["an operator as the load number", { loadNumber: "in:anywhere" }],
			["no load number", { loadNumber: "" }],
			["a bad invoice number on a row", { invoiceNumbers: ['1" OR "x'] }],
			["a bad order number on a row", { orderNumbers: ["70 001"] }],
			["more numbers than a search takes", { invoiceNumbers: MANY_NUMBERS }],
		]) {
			const refused = await run(over);
			eq(refused.error && [refused.error.stage, refused.value], ["terms", undefined], `§8 refused before any connection: ${label}`);
		}
		eq([dials.length, fake.sessions.length], [dialsBefore, sessionsBefore], "§8 ...no connection opened, so no such term is ever sent");
		for (const [label, over] of [["no password", { pass: "" }], ["no user", { user: "" }], ["a user with no domain", { user: "info" }], ["a line break in the password", { pass: "x\r\ny" }]]) {
			const refused = await run(over);
			eq(refused.error && refused.error.stage, "credentials", `§8 refused before any connection: ${label}`);
		}
		eq(dials.length, dialsBefore, "§8 ...no connection opened");

		// Any refusal, at any stage, ends the run. Never "nothing found", never server text.
		const SERVER_TEXT = "made-up-server-text-q7";
		const noLeak = (r) => r.error && !JSON.stringify([r.error.message, Object.values(r.error)]).includes(SERVER_TEXT) && !String(r.error.stack).includes(SERVER_TEXT);
		clearBoxes();
		SENT.push(mail({ subject: ENGINE_SUBJECT, to: BROKER }));
		const STAGES = [["LOGIN", "login"], ["CAPABILITY", "capability"], ["EXAMINE", "examine"], ["SEARCH", "search"], ["FETCH", "fetch"]];
		const ANSWERS = [
			["NO", (t) => [`${t} NO [CANNOT] ${SERVER_TEXT}`], { answered: true }],
			["BAD", (t) => [`${t} BAD ${SERVER_TEXT}`], { answered: true }],
			["an untagged NO", (t) => [`* NO ${SERVER_TEXT}`, `${t} OK Success`], { answered: true }],
			["an untagged BAD", (t) => [`* BAD ${SERVER_TEXT}`, `${t} OK Success`], { answered: true }],
			["a BYE before the tagged answer", (t) => [`* BYE ${SERVER_TEXT}`, `${t} OK Success`], { answered: true }],
			["a throttle in the tagged OK", (t) => [`${t} OK Success [THROTTLED]`], { answered: true, throttled: true }],
			["a throttle alert", (t) => [`* OK [ALERT] ${SERVER_TEXT}`, `${t} OK Success`], { answered: true, throttled: true }],
			["a BYE and a dropped connection", () => [`* BYE ${SERVER_TEXT}`, MAILBOX_DROP], {}],
			["a dropped connection", () => [MAILBOX_DROP], {}],
		];
		for (const [verb, stage] of STAGES) {
			for (const [label, answer, want] of ANSWERS) {
				fake.script.set(verb, (t) => answer(t));
				const r = await run();
				noScript();
				eq(r.error ? [r.error.stage, Boolean(r.error.answered), Boolean(r.error.throttled)] : ["resolved", r.value && r.value.verdict],
					[stage, Boolean(want.answered), Boolean(want.throttled)], `§8 ${verb}: ${label}: rejects at ${stage}`);
				ok(noLeak(r), `§8 ${verb}: ${label}: no server text in the error`);
			}
		}
		fake.opts.greeting = `* BYE ${SERVER_TEXT}`;
		const byeHello = await run();
		eq(byeHello.error && [byeHello.error.stage, byeHello.error.answered], ["greeting", true], "§8 a BYE for a greeting rejects at greeting");
		ok(noLeak(byeHello), "§8 ...with no server text");
		fake.opts.greeting = "";
		const silent = await run({ timeoutMs: 150 });
		eq(silent.error && silent.error.stage, "greeting", "§8 no greeting: a timeout, at greeting");
		fake.opts.greeting = "* OK Gimap ready";
		fake.opts.greeting = "* OK [THROTTLED] slow down";
		const throttledHello = await run();
		fake.opts.greeting = "* OK Gimap ready";
		eq(throttledHello.error && [throttledHello.error.stage, throttledHello.error.answered, throttledHello.error.throttled], ["greeting", true, true], "§8 a throttle in the greeting rejects at greeting");
		eq(throttledHello.s.commands, ["LOGOUT"], "§8 ...and no LOGIN is sent");
		fake.script.set("SEARCH", () => []);
		const hang = await run({ timeoutMs: 150 });
		noScript();
		eq(hang.error && hang.error.stage, "search", "§8 no answer to a SEARCH: a timeout, at search, never nothing found");
		fake.script.set("SEARCH", () => [MAILBOX_DROP]);
		const droppedAt = Date.now();
		const dropped = await run({ timeoutMs: 20000 });
		noScript();
		eq(dropped.error && dropped.error.stage, "search", "§8 a dropped connection rejects at its stage");
		ok(Date.now() - droppedAt < 5000, "§8 ...at once, not at the time limit");
		// A socket error is a rejection, never an uncaught exception in the server's process.
		const closedServer = net.createServer();
		await new Promise((resolve) => closedServer.listen(0, "127.0.0.1", resolve));
		const closedPort = closedServer.address().port;
		await new Promise((resolve) => closedServer.close(resolve));
		const stubbedConnect = tls.connect;
		tls.connect = () => net.connect(closedPort, "127.0.0.1");
		const connRefused = await settle(searchMailboxForLoad({ user: OWN, pass: "made-up-pass", loadNumber: LOAD, timeoutMs: 2000 }));
		tls.connect = stubbedConnect;
		eq(connRefused.error && connRefused.error.stage, "greeting", "§8 a socket error, a refused connection, rejects at greeting");
		// A refusal in Sent Mail after a clean Drafts is still a failure.
		clearBoxes();
		fake.script.set("EXAMINE", (t, args) => (args.includes("Sent Mail") ? [`${t} NO [NONEXISTENT] ${SERVER_TEXT}`] : null));
		const noSent = await run();
		noScript();
		eq(noSent.error && [noSent.error.stage, noSent.value], ["examine", undefined], "§8 Drafts clean but Sent Mail won't open: rejects, never clean");
		fake.script.set("SEARCH", (t) => [`${t} OK Success [THROTTLED]`]);
		const throttled = await run();
		noScript();
		eq(throttled.s.commands.filter((c) => c === "SEARCH"), ["SEARCH"], "§8 a throttle ends the run: no further command but the LOGOUT");
		eq(throttled.s.commands[throttled.s.commands.length - 1], "LOGOUT", "§8 ...the session still ends with a LOGOUT");
		for (const [label, answer] of [
			["too many", (t) => ["* OK Too many simultaneous connections", `${t} OK Success`]],
			["exceeded", (t) => [`${t} OK Account exceeded command or bandwidth limits`]],
			["throttled", (t) => ["* OK throttled, slow down", `${t} OK Success`]],
			["[OVERQUOTA]", (t) => [`${t} OK [OVERQUOTA] made-up`]],
			["[LIMIT]", (t) => ["* OK [LIMIT] made-up", `${t} OK Success`]],
			["[UNAVAILABLE]", (t) => [`${t} OK [UNAVAILABLE] made-up`]],
		]) {
			fake.script.set("SEARCH", answer);
			const r = await run();
			noScript();
			eq(r.error && [r.error.stage, r.error.answered, r.error.throttled], ["search", true, true], `§8 a throttle in an OK or untagged line, by its word: ${label}: rejects at search`);
		}

		// X-GM-EXT-1.
		for (const [label, capability] of [["not advertised", "IMAP4rev1 IDLE UIDPLUS"], ["only a longer name", "IMAP4rev1 X-GM-EXT-10 X-GM-EXT-1X"]]) {
			fake.opts.capability = capability;
			const r = await run();
			eq(r.error && [r.error.stage, r.s.commands], ["capability", ["LOGIN", "CAPABILITY", "LOGOUT"]], `§8 X-GM-EXT-1 ${label}: rejects at capability, and no search runs`);
		}
		fake.opts.capability = "IMAP4rev1 IDLE UIDPLUS X-GM-EXT-1 CHILDREN";
		fake.script.set("CAPABILITY", (t) => [`${t} OK Success`]);
		const noCaps = await run();
		noScript();
		eq(noCaps.error && noCaps.error.stage, "capability", "§8 no CAPABILITY line at all: rejects at capability");

		// Unreadable answers.
		const UNREADABLE = [
			["SEARCH", "search", "no * SEARCH line in an OK answer", (t) => [`${t} OK SEARCH completed`]],
			["SEARCH", "search", "a garbled * SEARCH line", (t) => ["* SEARCH 1 two", `${t} OK SEARCH completed`]],
			["SEARCH", "search", "a zero in a * SEARCH line", (t) => ["* SEARCH 0", `${t} OK SEARCH completed`]],
			["SEARCH", "search", "an EXPUNGE, which moves the numbers", (t) => ["* 1 EXPUNGE", "* SEARCH", `${t} OK SEARCH completed`]],
			["FETCH", "fetch", "an OK answer with no message", (t) => [`${t} OK Success`]],
			["FETCH", "fetch", "an answer with no header item", (t) => ['* 1 FETCH (BODYSTRUCTURE ("TEXT" "HTML" NIL NIL NIL "7BIT" 1 1))', `${t} OK Success`]],
			["FETCH", "fetch", "an answer with no BODYSTRUCTURE", (t) => [Buffer.from('* 1 FETCH (BODY[HEADER.FIELDS (SUBJECT)] {4}\r\n\r\n\r\n)\r\n', "latin1"), `${t} OK Success`]],
			["FETCH", "fetch", "an answer for another message", (t) => [Buffer.from('* 9 FETCH (BODYSTRUCTURE ("TEXT" "HTML") BODY[HEADER.FIELDS (SUBJECT)] {4}\r\n\r\n\r\n)\r\n', "latin1"), `${t} OK Success`]],
		];
		clearBoxes();
		DRAFTS.push(mail({ subject: `Load ${LOAD} notes`, to: COLLEAGUE }));
		for (const [verb, stage, label, answer] of UNREADABLE) {
			fake.script.set(verb, answer);
			const r = await run();
			noScript();
			eq(r.error ? r.error.stage : `resolved ${r.value && r.value.verdict}`, stage, `§8 unreadable: ${label}: rejects at ${stage}, never nothing found`);
		}
		DRAFTS.push(mail({ subject: `Load ${LOAD} more notes`, to: COLLEAGUE }));
		fake.script.set("FETCH", (t) => [Buffer.from('* 1 FETCH (BODYSTRUCTURE ("TEXT" "HTML") BODY[HEADER.FIELDS (SUBJECT)] {4}\r\n\r\n\r\n)\r\n', "latin1"), `${t} OK Success`]);
		const oneMissing = await run();
		noScript();
		eq(oneMissing.error && oneMissing.error.stage, "fetch", "§8 unreadable: one of two hits missing from the answer: rejects at fetch");
		const fits = await run({ maxReaderBytes: 4096 });
		ok(fits.value, "§8 (control) a small answer fits the reader's smallest limit");
		SENT.length = 0;
		for (let i = 0; i < 20; i++) SENT.push(mail({ subject: `Load ${LOAD} ${"x".repeat(400)}`, to: COLLEAGUE }));
		const overflow = await run({ maxReaderBytes: 4096 });
		eq(overflow.error && overflow.error.stage, "fetch", "§8 an answer past the reader's limit rejects at fetch");

		// The 20-hit cap: the newest 20 are read, the rest are doubt.
		clearBoxes();
		for (let i = 1; i <= 25; i++) SENT.push(mail({ subject: `Load ${LOAD} note ${i}`, to: COLLEAGUE }));
		const capped = await run();
		eq(capped.s.fetches, [`${Array.from({ length: 20 }, (_, i) => i + 6).join(",")} (BODY.PEEK[HEADER.FIELDS (SUBJECT DATE TO CC BCC)] BODYSTRUCTURE)`], "§8 25 hits: the newest 20 fetched, in one command");
		eq([capped.value.verdict, capped.value.mailboxes.sent], [MENTION, { ...EMPTY_BOX, hits: 25, ignored: 20, ignoredNamed: 20, overCap: 5 }], "§8 ...every one read Ignored, but 5 went unread: a mention, never clean");
		clearBoxes();
		for (let i = 1; i <= 20; i++) SENT.push(mail({ subject: `Load ${LOAD} note ${i}`, to: COLLEAGUE }));
		const atCap = await run();
		eq([atCap.value.verdict, atCap.value.mailboxes.sent.overCap], [CLEAN, 0], "§8 exactly 20 hits, all Ignored: clean");
		clearBoxes();
		for (let i = 1; i <= 21; i++) SENT.push(mail({ subject: `Load ${LOAD} note ${i}`, to: COLLEAGUE }));
		SENT[20] = mail({ subject: ENGINE_SUBJECT, to: BROKER });
		const capInvoice = await run();
		eq(capInvoice.value.verdict, INVOICE, "§8 over the cap with an invoice among the newest: an invoice");

		// Trash, only when asked, by in:trash.
		clearBoxes();
		TRASH.push(mail({ subject: ENGINE_SUBJECT, to: BROKER }));
		const noTrash = await run();
		eq([noTrash.value.verdict, noTrash.s.examines], [CLEAN, ["[Gmail]/Drafts", "[Gmail]/Sent Mail"]], "§8 Trash isn't searched unless asked");
		const withTrash = await run({ includeTrash: true });
		eq([withTrash.value.verdict, withTrash.s.examines, withTrash.s.searches[2]], [INVOICE, ["[Gmail]/Drafts", "[Gmail]/Sent Mail", "[Gmail]/Trash"], `X-GM-RAW "in:trash \\"${LOAD}\\""`],
			"§8 includeTrash: Trash opened read-only and searched with in:trash, which the web search needs");
		eq([withTrash.value.mailboxes.trash.invoice, Object.keys(withTrash.value.mailboxes)], [1, ["drafts", "sent", "trash"]], "§8 ...and answered for by name");

		// The send's last check: a message the web search hasn't indexed yet.
		clearBoxes();
		SENT.push(mail({ subject: ENGINE_SUBJECT, to: BROKER, lagging: true }));
		const lagging = await run();
		eq([lagging.value.verdict, lagging.s.searches], [CLEAN, [q(LOAD), q(LOAD)]], "§8 without lastCheck: the web search alone, which misses a just-sent message");
		const lastCheck = await run({ lastCheck: true, orderNumbers: [ORDER] });
		eq(lastCheck.s.searches, [q(LOAD), `SUBJECT "${LOAD}"`, q(ORDER), `SUBJECT "${ORDER}"`, q(LOAD), `SUBJECT "${LOAD}"`, q(ORDER), `SUBJECT "${ORDER}"`], "§8 lastCheck: a plain SEARCH SUBJECT beside each web search");
		eq([lastCheck.value.verdict, lastCheck.s.commands.filter((c) => c === "FETCH").length], [INVOICE, 1], "§8 ...which finds it: an invoice");
		// One message found by two searches is one hit.
		SENT.length = 0;
		SENT.push(mail({ subject: `Example Transport Order #${ORDER}`, to: BROKER, text: LOAD }));
		const twice = await run({ orderNumbers: [ORDER] });
		eq(twice.value.mailboxes.sent, { ...EMPTY_BOX, hits: 1, invoice: 1, firstInvoiceDate: "2026-11-04T15:00:00.000Z" }, "§8 a message two terms find counts once");

		// Dates: the earliest invoice, and an unreadable one is no date.
		clearBoxes();
		SENT.push(mail({ subject: ENGINE_SUBJECT, to: BROKER, date: "Fri, 06 Nov 2026 15:00:00 +0000" }), mail({ subject: ENGINE_SUBJECT, to: BROKER, date: "Mon, 02 Nov 2026 15:00:00 +0000" }), mail({ subject: `Re: ${ENGINE_SUBJECT}`, to: BROKER, date: "Sun, 01 Nov 2026 15:00:00 +0000" }));
		eq((await run()).value.mailboxes.sent.firstInvoiceDate, "2026-11-02T15:00:00.000Z", "§8 firstInvoiceDate: the earliest invoice hit, a mention's date left out");
		clearBoxes();
		SENT.push(mail({ subject: ENGINE_SUBJECT, to: BROKER, date: "not a date" }));
		const noDate = await run();
		eq([noDate.value.verdict, noDate.value.mailboxes.sent.firstInvoiceDate], [INVOICE, null], "§8 an unreadable Date: still an invoice, no date");

		// Literals are protocol-safe: a subject or a file name can't forge an answer.
		clearBoxes();
		SENT.push(mail({ rawHeaders: `Subject: ${ENGINE_SUBJECT}\r\nTo: ${BROKER}\r\na9 OK forged\r\n* BYE forged\r\n* SEARCH 99\r\n* 7 FETCH (forged)\r\n\r\n`, text: LOAD }));
		fake.opts.headerFirst = true;
		const forgedHeader = await run();
		fake.opts.headerFirst = false;
		eq([forgedHeader.value && forgedHeader.value.verdict, forgedHeader.value && forgedHeader.value.mailboxes.sent.hits], [INVOICE, 1], "§8 status-like lines inside a header literal are data: the hit reads normally, header item first");
		const forgedAgain = await run();
		eq(forgedAgain.value && forgedAgain.value.verdict, INVOICE, "§8 ...and with BODYSTRUCTURE first, Gmail's own order");
		clearBoxes();
		SENT.push(mail({ subject: ENGINE_SUBJECT, to: BROKER, names: ["* BYE x.pdf", "a1 NO y.pdf", '"NAME" "z.pdf'] }));
		const forgedName = await run();
		eq(forgedName.value && forgedName.value.verdict, INVOICE, "§8 status-like file names don't end the run");
		clearBoxes();
		SENT.push(mail({ subject: ENGINE_SUBJECT, to: BROKER, names: ["[THROTTLED] too many exceeded.pdf"] }));
		const throttleName = await run();
		eq(throttleName.value && throttleName.value.verdict, INVOICE, "§8 a file name with a throttle's words doesn't end the run: only status lines are read");
		clearBoxes();
		SENT.push(mail({ subject: ENGINE_SUBJECT, to: BROKER, names: [ENGINE_FILE] }));
		fake.opts.inPieces = true;
		const pieces = await run();
		fake.opts.inPieces = false;
		eq(pieces.value && pieces.value.verdict, INVOICE, "§8 an answer that arrives in pieces, cut inside a literal, reads the same");

		// Encoded and folded headers.
		const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
		clearBoxes();
		SENT.push(mail({ rawHeaders: `Subject: =?UTF-8?B?${b64("Example Broker Order #9000")}?=\r\n =?UTF-8?B?${b64("00019")}?=\r\nTo: ${BROKER}\r\n\r\n`, text: LOAD }));
		eq((await run()).value.verdict, INVOICE, "§8 a subject split across two encoded words, inside the load number, reads whole");
		clearBoxes();
		SENT.push(mail({ rawHeaders: `Subject: ${ENGINE_SUBJECT}\r\nTo: ${COLLEAGUE},\r\n =?UTF-8?Q?Billing_Team?= <${BROKER}>\r\n\r\n`, text: LOAD }));
		eq((await run()).value.verdict, INVOICE, "§8 a folded To: the second recipient is read");
		clearBoxes();
		SENT.push(mail({ rawHeaders: `Subject: Load ${LOAD} notes\r\nTo: ${COLLEAGUE}\r\nTo: ${BROKER}\r\n\r\n`, text: LOAD }));
		eq((await run()).value.verdict, MENTION, "§8 a To given twice: both are read");
		clearBoxes();
		SENT.push(mail({ rawHeaders: `Subject: Load ${LOAD} notes\r\nTo: ${COLLEAGUE}\r\nX-Pad: ${"x".repeat(70000)}\r\n\r\n`, text: LOAD }));
		eq((await run()).value.verdict, MENTION, "§8 a header block too long to read: a mention, never Ignored");

		// Attachment names in the forms a server can send them.
		const NAME_FORMS = [
			["RFC 2231, in pieces", `("APPLICATION" "PDF" NIL NIL NIL "BASE64" 10 NIL ("ATTACHMENT" ("FILENAME*0*" "utf-8''Example%20Broker%20Inv" "FILENAME*1*" "oice%20Order%20%23${LOAD}.pdf")) NIL)`],
			["RFC 2231, one piece", `("APPLICATION" "PDF" NIL NIL NIL "BASE64" 10 NIL ("ATTACHMENT" ("FILENAME*" "utf-8''Invoice%20${LOAD}.pdf")) NIL)`],
			["an encoded word", `("APPLICATION" "PDF" ("NAME" "=?UTF-8?B?${b64(`Invoice ${LOAD}.pdf`)}?=") NIL NIL "BASE64" 10 NIL NIL NIL)`],
			["a literal", `("APPLICATION" "PDF" ("NAME" {${`Invoice ${LOAD}.pdf`.length}}\r\nInvoice ${LOAD}.pdf) NIL NIL "BASE64" 10 NIL NIL NIL)`],
			["a literal in RFC 2231 form", `("APPLICATION" "PDF" ("NAME*" {${`utf-8''Invoice%20${LOAD}.pdf`.length}}\r\nutf-8''Invoice%20${LOAD}.pdf) NIL NIL "BASE64" 10 NIL NIL NIL)`],
		];
		for (const [label, structure] of NAME_FORMS) {
			clearBoxes();
			SENT.push(mail({ subject: "Paperwork", to: BROKER, text: LOAD, structure }));
			const asInvoice = await run();
			eq(asInvoice.value && asInvoice.value.verdict, INVOICE, `§8 an attachment name as ${label}: says invoice and names the load`);
			clearBoxes();
			SENT.push(mail({ subject: "Paperwork", to: COLLEAGUE, text: LOAD, structure }));
			const internal = await run();
			eq(internal.value && internal.value.verdict, MENTION, `§8 ...and on internal mail it's an invoice look, so not Ignored`);
		}
		clearBoxes();
		SENT.push(mail({ subject: "Paperwork", to: BROKER, text: LOAD, structure: `(("APPLICATION" "PDF" NIL NIL NIL "BASE64" 10 NIL ("ATTACHMENT" ("FILENAME*0*" "utf-8''Inv" "FILENAME*1*" "oice%20${LOAD}.pdf")) NIL)("APPLICATION" "PDF" NIL NIL NIL "BASE64" 10 NIL ("ATTACHMENT" ("FILENAME*0*" "utf-8''Rate%20con" "FILENAME*1*" ".pdf")) NIL) "MIXED")` }));
		eq((await run()).value.verdict, INVOICE, "§8 two RFC 2231 names stay two names: the later one doesn't replace the invoice");

		// Nothing else can be sent: the source's commands are the listed ones.
		const SRC = fs.readFileSync(LIB_FILE, "utf8");
		const verbs = [...new Set([...SRC.matchAll(/\bsend\([`"]([A-Z][A-Z-]+)/g)].map((m) => m[1]))].sort();
		eq(verbs, ["CAPABILITY", "EXAMINE", "FETCH", "LOGIN", "SEARCH"], "§8 the source sends only LOGIN, CAPABILITY, EXAMINE, SEARCH and FETCH (and its LOGOUT)");
		eq([...SRC.matchAll(/\brequire\("([^"]+)"\)/g)].map((m) => m[1]).sort(), ["./mime-read", "./ratecon-reconcile", "tls"], "§8 it requires only tls, the IMAP reader and the MIME reader: no mail sender, database or file");
		ok(!/\bprocess\b|\bconsole\b|\bdb\b|\bfs\b|sendMail|nodemailer/.test(SRC), "§8 it reads no setting, logs nothing, and touches no database, file or mail sender");
		ok(/BODY\.PEEK\[/.test(SRC) && !/[^.]BODY\[HEADER\.FIELDS \(/.test(SRC), "§8 its FETCH is BODY.PEEK, never BODY[");
	} finally {
		tls.connect = realConnect;
		fake.server.close();
	}
}

// -------------------------------------------------------------------- report
if (process.argv.includes(CHILD_FLAG)) {
	fakeGmailChild().then(
		() => process.exit(0),
		(e) => { console.error(e && e.stack); process.exit(1); },
	);
} else main()
	.then(() => mailboxSearchSection())
	.catch((e) => failures.push(`the run threw: ${e && e.stack}`))
	.then(() => {
		console.log(`\n${"=".repeat(64)}`);
		if (failures.length) {
			console.log(`FAILURES (${failures.length}):`);
			failures.forEach((f) => console.log(`  ✗ ${f}`));
			console.log(`\n${pass} passed, ${failures.length} failed`);
			process.exit(1);
		}
		console.log(`✓ ${pass} assertions passed`);
		process.exit(0);
	});
