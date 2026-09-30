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
 *   §2 THE MESSAGE. The literal is the composed email: To, Subject, the HTML
 *      body byte for byte, and the PDF attachment (name, type, bytes).
 *   §3 FAILURES. A NO to the APPEND rejects "IMAP APPEND failed"; a NO to the
 *      LOGIN rejects "IMAP LOGIN failed" and sends no APPEND; no credentials
 *      rejects before any connection.
 *
 * HOW: tls.connect is replaced for the duration of the run by a stub that
 * returns a plain socket to a fake IMAP server on 127.0.0.1:0, which speaks
 * just enough IMAP for appendGmailDraft(). Nothing leaves the machine.
 *
 * Plain node, no server, no fixtures, no network, never touches app.db.
 * Run: node scripts/test-imap-draft.js
 */
"use strict";
const net = require("net");
const path = require("path");
const tls = require("tls");

const { appendGmailDraft } = require(path.join(__dirname, "..", "lib", "imap-draft.js"));

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
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");

// ---------------------------------------------------------------- fake IMAP
// Greeting, LOGIN, APPEND with a synchronizing literal, LOGOUT; anything else
// is BAD. `answer` picks OK or NO for LOGIN and APPEND. Every connection is
// recorded in `sessions`: the commands in order, the LOGIN arguments, the
// APPEND with its literal, and the raw bytes received.
function unquote(q) { return q.slice(1, -1).replace(/\\(.)/g, "$1"); }
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';
const LOGIN_ARGS = new RegExp(`^(${QUOTED}) (${QUOTED})$`);
const APPEND_ARGS = new RegExp(`^(${QUOTED}) \\(([^)]*)\\) \\{(\\d+)\\}$`);

function fakeImap() {
	const sessions = [];
	const answer = { login: "OK", append: "OK" };
	const server = net.createServer((sock) => {
		const s = { commands: [], login: null, append: null, received: [], appendLineEnd: null };
		s.closed = new Promise((resolve) => sock.on("close", resolve));
		sessions.push(s);
		let buf = Buffer.alloc(0);
		let bytesIn = 0;
		let pending = null; // an APPEND waiting for its literal
		const reply = (line) => sock.write(line + "\r\n");
		sock.on("error", () => {});
		reply("* OK [CAPABILITY IMAP4rev1] fake IMAP ready");
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
					else if (answer.append === "OK") reply(`${t} OK [APPENDUID 1 1] APPEND completed`);
					else reply(`${t} NO [OVERQUOTA] mailbox full`);
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
	return { server, sessions, answer };
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
	const { server, sessions, answer } = fakeImap();
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
	} finally {
		tls.connect = realConnect;
		server.close();
	}
}

// -------------------------------------------------------------------- report
main()
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
