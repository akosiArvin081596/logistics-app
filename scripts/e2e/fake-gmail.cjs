// A fake Gmail for the browser harness: the server's invoice draft lands in a
// directory instead of a mailbox, and no mail the server tries to send leaves
// the machine. Harness-only: the root install, CI and the deploy never load it,
// and scripts/run-unit-tests.js never runs it.
//
// PRELOAD, in the server under test:
//   E2E_FAKE_GMAIL_DIR=<absolute dir> node --require <abs>/scripts/e2e/fake-gmail.cjs server.js
//   - imap.gmail.com through tls.connect(), in any of its argument forms, reaches
//     a fake IMAP server on 127.0.0.1 inside the same process: LOGIN (any
//     credentials), APPEND and LOGOUT; any other command is answered BAD. Each
//     APPEND is saved as <dir>/append-<ms>-<n>.eml, the raw MIME byte for byte,
//     beside <dir>/append-<ms>-<n>.json: { mailbox, flags: [...], bytes }. The
//     .json is written last, so a draft is complete once its .json exists, and
//     both exist before the APPEND is answered OK.
//   - smtp.gmail.com on any port, through tls.connect(), net.connect() or
//     net.createConnection() (STARTTLS on 587 starts as a plain connection): the
//     socket errors on the next tick and no connection is opened. The name is
//     matched on `host` and on `servername`, because nodemailer looks the name up
//     itself (that DNS query still goes out) and connects to the address,
//     carrying the name as `servername`.
//   - imap.gmail.com by any other route (net.connect(), or a TLS upgrade of an
//     existing socket) errors the same way.
//   - Every other host passes through untouched: the server still reaches the
//     Sheets API. A socket built with new net.Socket() and connected directly is
//     not seen; nothing in server.js, lib/ or nodemailer opens one that way.
//   It refuses to load (throws, so node exits) unless E2E_FAKE_GMAIL_DIR is an
//   absolute path to an existing directory outside every git checkout, owned by
//   this user and closed to group and other (paths.assertPrivateDir(), the rule
//   the work dir is held to). A draft is built from the scratch DB, a copy of
//   real data: keep the directory inside the harness's private work dir. Every
//   file is created exclusively and 0600, never over or through anything already
//   at its name: a temporary sidecar file found already there makes the APPEND
//   answer NO.
//
// MODULE, in the harness:
//   const { readCapturedDrafts } = require("<abs>/scripts/e2e/fake-gmail.cjs");
//   readCapturedDrafts(dir) returns the drafts in <dir>, oldest first:
//     [{ file, mailbox, flags, to, subject, html, attachments: [{ filename, contentType, size }] }]
//   file is the .eml's absolute path; to and subject are the decoded headers
//   (RFC 2047); html is the text/html part with its transfer encoding
//   (quoted-printable or base64) and charset undone, "" when there is none;
//   filename is decoded (RFC 2231 or RFC 2047) and size is the decoded byte count.
//
// PRELOAD OR MODULE: Node loads a file named by --require (NODE_OPTIONS
// included) with a stand-in parent module whose id is "internal/preload"; a
// require() or import from a script has a real parent, or none. The hooks
// install only in the first case, so a harness that requires this file never
// patches its own sockets, whatever its environment holds.
//
// Built-in modules only, and paths.cjs beside it, which is built-in only too.
"use strict";
const fs = require("fs");
const net = require("net");
const path = require("path");
const tls = require("tls");
// Inert when required (see its header), so it is safe to load during the preload.
const paths = require("./paths.cjs");

const TAG = "fake-gmail";
const IMAP_HOST = "imap.gmail.com";
const SMTP_HOST = "smtp.gmail.com";

// ------------------------------------------------------------ reading drafts

// Bytes in a charset; an unknown charset reads as UTF-8. A BOM is kept, so the
// text is exactly what was encoded.
function decodeCharset(bytes, charset) {
	try {
		return new TextDecoder(String(charset || "utf-8").trim(), { ignoreBOM: true }).decode(bytes);
	} catch {
		return bytes.toString("utf8");
	}
}

const hexByte = (_, h) => String.fromCharCode(parseInt(h, 16));

// RFC 2047 encoded words: "=?UTF-8?Q?Caf=C3=A9_?= =?UTF-8?Q?=26_Co?=" reads
// "Café & Co". The space between two encoded words is dropped (section 6.2), and
// the bytes of adjacent words in one charset are joined before they are decoded,
// so a character split across two words survives.
function decodeWords(text) {
	const WORD = /=\?([^?\s]{1,64})\?([BbQq])\?([^?\s]{0,1000})\?=/g;
	let out = "";
	let last = 0;
	let run = null; // adjacent encoded words not yet decoded: { charset, chunks }
	const flush = () => {
		if (run) out += decodeCharset(Buffer.concat(run.chunks), run.charset);
		run = null;
	};
	for (const m of text.matchAll(WORD)) {
		const between = text.slice(last, m.index);
		const charset = m[1].split("*")[0]; // drops an RFC 2231 language suffix
		const bytes = /b/i.test(m[2])
			? Buffer.from(m[3], "base64")
			: Buffer.from(m[3].replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, hexByte), "latin1");
		if (run && /^\s*$/.test(between)) {
			if (run.charset.toLowerCase() !== charset.toLowerCase()) {
				flush();
				run = { charset, chunks: [] };
			}
		} else {
			flush();
			out += between;
			run = { charset, chunks: [] };
		}
		run.chunks.push(bytes);
		last = m.index + m[0].length;
	}
	flush();
	return out + text.slice(last);
}

// A header value and its parameters: 'text/html; charset="utf-8"' reads
// { value: "text/html", params: { charset: "utf-8" } }. RFC 2231 parameters
// (name*=charset'lang'%XX, name*0*=..., name*1=...) are joined and decoded; an
// RFC 2047 word inside a plain value is decoded too.
function parseParams(header) {
	const s = header || "";
	let i = 0;
	const until = (stops) => {
		const from = i;
		while (i < s.length && !stops.includes(s[i])) i++;
		return s.slice(from, i);
	};
	const value = until(";").trim().toLowerCase();
	const raw = {};
	while (i < s.length) {
		i++; // the ";"
		const key = until("=;").trim().toLowerCase();
		if (s[i] !== "=") continue;
		i++;
		while (s[i] === " " || s[i] === "\t") i++;
		let v = "";
		if (s[i] === '"') {
			for (i++; i < s.length && s[i] !== '"'; i++) {
				if (s[i] === "\\" && i + 1 < s.length) i++;
				v += s[i];
			}
			i++;
			until(";");
		} else {
			v = until(";").trim();
		}
		if (key) raw[key] = v;
	}
	const params = {};
	const segments = {};
	for (const [key, v] of Object.entries(raw)) {
		const m = /^([^*]{1,100})\*(\d{1,3})?(\*)?$/.exec(key);
		if (!m) {
			params[key] = decodeWords(v);
			continue;
		}
		const encoded = m[2] === undefined || m[3] === "*";
		(segments[m[1]] = segments[m[1]] || []).push({ n: Number(m[2] || 0), v, encoded });
	}
	for (const [name, segs] of Object.entries(segments)) {
		segs.sort((a, b) => a.n - b.n);
		let charset = "utf-8";
		const chunks = segs.map((seg, k) => {
			let v = seg.v;
			if (!seg.encoded) return Buffer.from(v, "latin1");
			const prefixed = k === 0 && /^([^']{0,64})'[^']{0,64}'([^]*)$/.exec(v);
			if (prefixed) {
				charset = prefixed[1] || charset;
				v = prefixed[2];
			}
			return Buffer.from(v.replace(/%([0-9A-Fa-f]{2})/g, hexByte), "latin1");
		});
		params[name] = decodeCharset(Buffer.concat(chunks), charset);
	}
	return { value, params };
}

// A header block and a body, split at the first blank line. Headers are
// unfolded (RFC 5322: the line break goes, the space stays) and keyed
// lowercase; the first occurrence wins.
function parsePart(raw, nl) {
	let head = "";
	let body = raw;
	if (!raw.startsWith(nl)) {
		const at = raw.indexOf(nl + nl);
		head = at < 0 ? raw : raw.slice(0, at);
		body = at < 0 ? "" : raw.slice(at + 2 * nl.length);
	} else {
		body = raw.slice(nl.length);
	}
	const lines = [];
	for (const line of head.split(nl)) {
		if ((line[0] === " " || line[0] === "\t") && lines.length) lines[lines.length - 1] += line;
		else lines.push(line);
	}
	const headers = {};
	for (const line of lines) {
		const c = line.indexOf(":");
		if (c <= 0) continue;
		const key = line.slice(0, c).trim().toLowerCase();
		if (!(key in headers)) headers[key] = line.slice(c + 1).trim();
	}
	return { headers, body };
}

// The leaf parts of a message, depth first. A multipart body is split on its
// boundary, which counts only at the start of a line and followed by "--" or by
// optional spaces and the line end (RFC 2046); the preamble and epilogue are
// skipped.
function leafParts(raw, nl, depth = 0) {
	const part = parsePart(raw, nl);
	part.type = parseParams(part.headers["content-type"] || "text/plain");
	const boundary = part.type.params.boundary;
	if (!part.type.value.startsWith("multipart/") || !boundary || depth > 20) return [part];
	const text = nl + part.body;
	const delimiter = nl + "--" + boundary;
	const out = [];
	let start = -1;
	for (let i = text.indexOf(delimiter); i >= 0; i = text.indexOf(delimiter, i + 1)) {
		let j = i + delimiter.length;
		const close = text.startsWith("--", j);
		if (!close) {
			while (text[j] === " " || text[j] === "\t") j++;
			if (!text.startsWith(nl, j)) continue;
		}
		if (start >= 0) out.push(...leafParts(text.slice(start, i), nl, depth + 1));
		if (close) break;
		start = j + nl.length;
	}
	return out;
}

// A part's body with its transfer encoding undone.
function bodyBytes(part) {
	const encoding = (part.headers["content-transfer-encoding"] || "").trim().toLowerCase();
	if (encoding === "base64") return Buffer.from(part.body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
	if (encoding === "quoted-printable") {
		return Buffer.from(part.body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, hexByte), "latin1");
	}
	return Buffer.from(part.body, "latin1");
}

function readMessage(bytes) {
	const raw = bytes.toString("latin1");
	const nl = raw.includes("\r\n") ? "\r\n" : "\n";
	const top = parsePart(raw, nl);
	let html = null;
	const attachments = [];
	for (const leaf of leafParts(raw, nl)) {
		const disposition = parseParams(leaf.headers["content-disposition"] || "");
		const filename = disposition.params.filename || leaf.type.params.name || "";
		if (disposition.value === "attachment" || filename) {
			attachments.push({ filename, contentType: leaf.type.value, size: bodyBytes(leaf).length });
		} else if (html === null && leaf.type.value === "text/html") {
			html = decodeCharset(bodyBytes(leaf), leaf.type.params.charset);
		}
	}
	return {
		to: decodeWords(top.headers.to || ""),
		subject: decodeWords(top.headers.subject || ""),
		html: html === null ? "" : html,
		attachments,
	};
}

const CAPTURE_NAME = /^append-(\d{1,16})-(\d{1,10})\.json$/;

function readCapturedDrafts(dir) {
	if (typeof dir !== "string" || !path.isAbsolute(dir)) {
		throw new Error(`${TAG}: readCapturedDrafts needs an absolute directory, got ${JSON.stringify(dir)}`);
	}
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		throw new Error(`${TAG}: cannot read the capture directory ${dir}: ${e.message}`);
	}
	return names
		.map((name) => CAPTURE_NAME.exec(name))
		.filter(Boolean)
		.sort((a, b) => Number(a[1]) - Number(b[1]) || Number(a[2]) - Number(b[2]))
		.map((m) => {
			const base = m[0].slice(0, -".json".length);
			const meta = JSON.parse(fs.readFileSync(path.join(dir, m[0]), "utf8"));
			const file = path.join(dir, `${base}.eml`);
			return { file, mailbox: meta.mailbox, flags: meta.flags, ...readMessage(fs.readFileSync(file)) };
		});
}

// -------------------------------------------------------------------- hooks

// The directory E2E_FAKE_GMAIL_DIR names, or a refusal: an absolute path to an
// existing directory with no .git at or above it, owned by this user and closed
// to group and other. The last two are paths.assertPrivateDir(), the rule the
// work dir is held to, in its one copy.
function captureDir() {
	const refuse = (why) => {
		throw new Error(`${TAG}: refusing to load: ${why}`);
	};
	const dir = process.env.E2E_FAKE_GMAIL_DIR;
	if (!dir) refuse("E2E_FAKE_GMAIL_DIR is not set");
	if (!path.isAbsolute(dir)) refuse(`E2E_FAKE_GMAIL_DIR must be an absolute path, got ${dir}`);
	let real = "";
	try {
		real = fs.realpathSync(dir);
	} catch {
		refuse(`E2E_FAKE_GMAIL_DIR does not exist: ${dir}`);
	}
	const st = fs.statSync(real);
	if (!st.isDirectory()) refuse(`E2E_FAKE_GMAIL_DIR is not a directory: ${real}`);
	for (let d = real; ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, ".git"))) {
			refuse(`E2E_FAKE_GMAIL_DIR ${real} is inside the git checkout ${d}; use a directory outside every checkout`);
		}
		if (path.dirname(d) === d) break;
	}
	try {
		paths.assertPrivateDir(real, "E2E_FAKE_GMAIL_DIR", "E2E_FAKE_GMAIL_DIR");
	} catch (e) {
		refuse(e.message);
	}
	return real;
}

// Where a connect() call is headed, from any of its argument forms: (options),
// (port[, host]) or (path), each with an optional options object and callback.
// tls.connect() also reads host and servername from an options object in second
// or third place; net.connect() does not.
function target(args, isTls) {
	const [a, b, c] = args;
	const isObject = (x) => x !== null && typeof x === "object";
	const t = { host: "", servername: "", port: "", socket: false, callback: args.find((x) => typeof x === "function") };
	const take = (o) => {
		if (o.host != null) t.host = String(o.host);
		if (o.servername != null) t.servername = String(o.servername);
		if (o.port != null) t.port = String(o.port);
		if (o.socket) t.socket = true;
	};
	if (isObject(a)) {
		take(a);
	} else {
		if (typeof a === "number" || /^\d{1,5}$/.test(String(a))) {
			t.port = String(a);
			if (typeof b === "string") t.host = b;
		}
		if (isTls && isObject(b)) take(b);
		else if (isTls && isObject(c)) take(c);
	}
	return t;
}

const hostIs = (t, name) =>
	[t.host, t.servername].some((h) => String(h).trim().toLowerCase().replace(/\.$/, "") === name);

// A socket that errors on the next tick, before any connection is opened; the
// caller's 'error' listener receives it, as it would a refused connection.
function refused(t, via) {
	const where = `${t.servername || t.host}${t.port ? `:${t.port}` : ""}`;
	console.error(`${TAG}: blocked a connection to ${where} (${via}); nothing was sent`);
	const sock = new net.Socket();
	sock.destroy(Object.assign(new Error(`${TAG}: ${where} is blocked in the browser harness`), { code: "ECONNREFUSED" }));
	return sock;
}

// Saves one APPEND: the .eml, then its .json through a temporary file and a
// rename, so a reader never sees a partial sidecar. Both files are created
// exclusively (O_EXCL), so nothing already at their names, a symlink included,
// is written over or through. An .eml name already taken moves on to the next
// name; a temporary file already there was put there by something else, so the
// APPEND is refused and its .eml removed.
let saved = 0;
function saveAppend(dir, literal, meta) {
	for (;;) {
		const base = `append-${Date.now()}-${++saved}`;
		const eml = path.join(dir, `${base}.eml`);
		try {
			fs.writeFileSync(eml, literal, { flag: "wx", mode: 0o600 });
		} catch (e) {
			if (e.code === "EEXIST") continue;
			throw e;
		}
		const tmp = path.join(dir, `.${base}.json.tmp`);
		try {
			fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		} catch (e) {
			fs.rmSync(eml, { force: true });
			throw e.code === "EEXIST" ? new Error(`refusing to write ${tmp}: something is already there`) : e;
		}
		fs.renameSync(tmp, path.join(dir, `${base}.json`));
		return base;
	}
}

// APPEND <mailbox> [(<flags>)] [<date-time>] {<size>}: a quoted or atom
// mailbox and a synchronizing literal.
const APPEND_ARGS = /^(?:"((?:[^"\\]|\\.){0,1000})"|([^\s"(){}]{1,1000}))(?: \(([^)]{0,1000})\))?(?: "[^"]{0,64}")? \{(\d{1,10})\}$/;

function serveImap(sock, dir) {
	let chunks = [];
	let held = 0; // bytes in chunks
	let authenticated = false;
	let pending = null; // an APPEND waiting for its literal: { tag, mailbox, flags, size }
	const reply = (line) => {
		if (!sock.destroyed) sock.write(line + "\r\n");
	};
	sock.on("error", () => {});
	reply("* OK [CAPABILITY IMAP4rev1] fake-gmail IMAP ready");
	sock.on("data", (chunk) => {
		chunks.push(chunk);
		held += chunk.length;
		// A literal (a draft with its PDFs can run to megabytes) is gathered
		// without copying, and joined once all of it has arrived.
		if (pending && held < pending.size + 2) return;
		let buf = Buffer.concat(chunks, held);
		chunks = [];
		held = 0;
		const keep = () => {
			chunks = [buf];
			held = buf.length;
		};
		for (;;) {
			if (pending) {
				if (buf.length < pending.size + 2) return keep();
				const literal = Buffer.from(buf.subarray(0, pending.size));
				const terminated = buf[pending.size] === 13 && buf[pending.size + 1] === 10;
				buf = buf.subarray(pending.size + 2);
				const { tag, mailbox, flags } = pending;
				pending = null;
				if (!terminated) {
					reply(`${tag} BAD the literal is not followed by CRLF`);
					sock.end();
					return;
				}
				try {
					const base = saveAppend(dir, literal, { mailbox, flags, bytes: literal.length });
					console.error(`${TAG}: saved ${base}.eml (${literal.length} bytes) to ${mailbox} with (${flags.join(" ")})`);
					reply(`${tag} OK [APPENDUID 1 ${saved}] APPEND completed`);
				} catch (e) {
					console.error(`${TAG}: could not save an APPEND: ${e.message}`);
					reply(`${tag} NO [SERVERBUG] fake-gmail could not save the message`);
				}
				continue;
			}
			const eol = buf.indexOf("\r\n");
			if (eol < 0) return keep();
			const line = buf.subarray(0, eol).toString("latin1");
			buf = buf.subarray(eol + 2);
			const [tag, word = ""] = line.split(" ", 2);
			const verb = word.toUpperCase();
			const args = line.slice(tag.length + word.length + 2);
			if (verb === "LOGIN") {
				authenticated = true;
				reply(`${tag} OK LOGIN completed`);
			} else if (verb === "APPEND" && !authenticated) {
				reply(`${tag} BAD not authenticated`);
			} else if (verb === "APPEND") {
				const m = APPEND_ARGS.exec(args);
				if (!m) {
					reply(`${tag} BAD fake-gmail reads APPEND <mailbox> [(<flags>)] {<size>}`);
					continue;
				}
				const mailbox = m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2];
				pending = { tag, mailbox, flags: (m[3] || "").split(" ").filter(Boolean), size: Number(m[4]) };
				reply("+ go ahead");
			} else if (verb === "LOGOUT") {
				reply("* BYE fake-gmail logging out");
				reply(`${tag} OK LOGOUT completed`);
				sock.end();
				return;
			} else {
				reply(`${tag} BAD unknown command`);
			}
		}
	});
}

function installHooks(dir) {
	const server = net.createServer((sock) => serveImap(sock, dir));
	server.on("error", (e) => console.error(`${TAG}: the fake IMAP server failed: ${e.message}`));
	server.listen(0, "127.0.0.1", () => {
		console.error(`${TAG}: ${IMAP_HOST} goes to a fake IMAP server on 127.0.0.1:${server.address().port}, ` +
			`saving to ${dir}; ${SMTP_HOST} is blocked`);
	});
	server.unref();

	// A plain socket to the fake. A TLS caller waits for 'secureConnect', so the
	// socket emits it once connected, and a tls.connect() callback listens for it.
	const toFake = (callback) => {
		const sock = new net.Socket();
		const dial = () => sock.connect(server.address().port, "127.0.0.1");
		if (server.listening) dial();
		else server.once("listening", dial);
		sock.once("connect", () => sock.emit("secureConnect"));
		if (callback) sock.once("secureConnect", callback);
		return sock;
	};

	const realTlsConnect = tls.connect;
	tls.connect = function connect(...args) {
		const t = target(args, true);
		if (hostIs(t, SMTP_HOST)) return refused(t, "tls.connect");
		if (hostIs(t, IMAP_HOST)) return t.socket ? refused(t, "tls.connect on an existing socket") : toFake(t.callback);
		return realTlsConnect.apply(this, args);
	};
	const guardNet = (real, via) =>
		function connect(...args) {
			const t = target(args, false);
			if (hostIs(t, SMTP_HOST) || hostIs(t, IMAP_HOST)) return refused(t, via);
			return real.apply(this, args);
		};
	net.connect = guardNet(net.connect, "net.connect");
	net.createConnection = guardNet(net.createConnection, "net.createConnection");
}

module.exports = { readCapturedDrafts };

if (module.parent && module.parent.id === "internal/preload") installHooks(captureDir());
