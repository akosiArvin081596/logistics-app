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
 *
 * HOW: tls.connect is replaced for the duration of the run by a stub that
 * returns a plain socket to a fake IMAP server on 127.0.0.1:0, which speaks
 * just enough IMAP for appendGmailDraft() and findDraftByMessageId(). §5 runs
 * this file again as a child with the harness fake preloaded and a private
 * temp folder for its captures. Nothing leaves the machine.
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
const SUBJECT = "Invoice 09302026-1 for Load 30080873";
// Multi-line, non-ASCII and over 76 columns, so MailComposer quoted-printables it.
const HTML = [
	"<html><body>",
	"<p>Please find attached invoice 09302026-1 for load 30080873.</p>",
	`<p>Total due: $1,234.00 ${EM_DASH} Caf${E_ACUTE} & Co. ${"A line long enough to need a soft break. ".repeat(3)}</p>`,
	"</body></html>",
].join("\n");
const PDF_NAME = "Invoice-09302026-1.pdf";
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
// The top-level Message-ID header of a composed message.
function messageIdOf(literal) {
	const raw = literal.toString("latin1");
	const head = raw.slice(0, Math.max(0, raw.indexOf("\r\n\r\n")));
	const m = /(?:^|\r\n)Message-ID:\s*(<[^>\r\n]{1,300}>)/i.exec(head);
	return m ? m[1] : null;
}

function fakeImap() {
	const sessions = [];
	const answer = { login: "OK", append: "OK", greeting: "OK", search: "OK", examineNo: "" };
	const stored = []; // Message-IDs of the drafts appended, in order
	const sent = []; // Message-IDs in Sent Mail
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
					s.search = m ? unquote(m[1]) : { unparsed: args };
					if (!m) { reply(`${tag} BAD malformed SEARCH`); continue; }
					if (answer.search !== "OK") { reply(`${tag} NO [UNAVAILABLE] search failed`); continue; }
					const hits = (held[s.examine] || []).map((id, i) => (id === s.search ? i + 1 : 0)).filter(Boolean);
					reply(`* SEARCH${hits.map((n) => ` ${n}`).join("")}`);
					reply(`${tag} OK SEARCH completed`);
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
	return { server, sessions, answer, stored, sent };
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
	const { server, sessions, answer, sent } = fakeImap();
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

// -------------------------------------------------------------------- report
if (process.argv.includes(CHILD_FLAG)) {
	fakeGmailChild().then(
		() => process.exit(0),
		(e) => { console.error(e && e.stack); process.exit(1); },
	);
} else main()
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
