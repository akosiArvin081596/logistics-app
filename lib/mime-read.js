// One email message (RFC 5322 with MIME) read into the parts a comparison needs,
// in memory and without a third-party parser: the To, Cc and Bcc addresses, the
// Subject (encoded words decoded), the Date, the Message-ID, the HTML and plain
// text bodies, and each attachment's name, type and decoded bytes.
//
// Used by scripts/auto-invoice-send-trial-report.js on the Sent Mail copies it
// fetches, and by the runners on what a fake IMAP server received, so a Sent copy
// and a draft are read the same way.
//
// Pure: no network, database or files. Bounded: at most MAX_PARTS parts,
// MAX_DEPTH levels of nesting, and header blocks of MAX_HEADER_BYTES. Never
// throws: a part it can't read is left out.

"use strict";

const MAX_PARTS = 200;
const MAX_DEPTH = 12;
const MAX_HEADER_BYTES = 256 * 1024;

function decoderFor(charset) {
	const cs = String(charset || "").trim().toLowerCase();
	if (!cs || cs === "us-ascii" || cs === "ascii") return (b) => b.toString("latin1");
	if (cs === "utf-8" || cs === "utf8") return (b) => b.toString("utf8");
	if (cs === "iso-8859-1" || cs === "latin1" || cs === "latin-1") return (b) => b.toString("latin1");
	try {
		const td = new TextDecoder(cs);
		return (b) => td.decode(b);
	} catch {
		return (b) => b.toString("latin1");
	}
}

// RFC 2047 encoded words ("=?utf-8?Q?...?=" and "=?utf-8?B?...?="); whitespace
// between two encoded words is dropped, as the RFC says.
function decodeWords(value) {
	const s = String(value == null ? "" : value);
	return s
		.replace(/(=\?[^?\s]{1,40}\?[BbQq]\?[^?\s]{0,4000}\?=)[ \t\r\n]{1,40}(?==\?[^?\s]{1,40}\?[BbQq]\?)/g, "$1")
		.replace(/=\?([^?\s]{1,40})\?([BbQq])\?([^?\s]{0,4000})\?=/g, (all, charset, enc, text) => {
			let bytes;
			if (enc.toUpperCase() === "B") bytes = Buffer.from(text, "base64");
			else bytes = Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
			return decoderFor(charset.split("*")[0])(bytes);
		});
}

// A header block (latin1 text) as a map: lower-case name -> list of unfolded values.
function parseHeaders(head) {
	const out = new Map();
	const lines = head.slice(0, MAX_HEADER_BYTES).replace(/\r?\n(?=[ \t])/g, "").split(/\r?\n/);
	for (const line of lines) {
		const c = line.indexOf(":");
		if (c <= 0) continue;
		const name = line.slice(0, c).trim().toLowerCase();
		const list = out.get(name) || [];
		list.push(line.slice(c + 1).trim());
		out.set(name, list);
	}
	return out;
}

// "type/sub; a=1; b*=utf-8''x%20y; c*0=..; c*1=.." -> { value, params } with the
// RFC 2231 continuations and charsets joined and decoded.
function parseParams(header) {
	const s = String(header || "");
	const semi = s.indexOf(";");
	const value = (semi < 0 ? s : s.slice(0, semi)).trim().toLowerCase();
	const raw = {};
	let i = semi < 0 ? s.length : semi + 1;
	while (i < s.length) {
		while (i < s.length && /[\s;]/.test(s[i])) i++;
		let j = i;
		while (j < s.length && s[j] !== "=" && s[j] !== ";") j++;
		const key = s.slice(i, j).trim().toLowerCase();
		if (s[j] !== "=") {
			i = j + 1;
			continue;
		}
		j++;
		while (j < s.length && /[ \t]/.test(s[j])) j++;
		let val = "";
		if (s[j] === "\"") {
			j++;
			while (j < s.length && s[j] !== "\"") {
				if (s[j] === "\\" && j + 1 < s.length) j++;
				val += s[j++];
			}
			j++;
		} else {
			const k = s.indexOf(";", j);
			val = s.slice(j, k < 0 ? s.length : k).trim();
			j = k < 0 ? s.length : k;
		}
		if (key) raw[key] = val;
		i = j;
	}
	const params = {};
	const pieces = {};
	for (const [key, val] of Object.entries(raw)) {
		const m = /^([^*]+)(?:\*(\d{1,3}))?(\*)?$/.exec(key);
		if (!m) continue;
		const base = m[1];
		if (m[2] === undefined && !m[3]) {
			params[base] = val;
			continue;
		}
		(pieces[base] = pieces[base] || []).push({ n: Number(m[2] || 0), encoded: Boolean(m[3]), val });
	}
	for (const [base, list] of Object.entries(pieces)) {
		list.sort((a, b) => a.n - b.n);
		let charset = "";
		const bytes = [];
		list.forEach((p, idx) => {
			let v = p.val;
			if (p.encoded && idx === 0) {
				const q = v.split("'");
				if (q.length >= 3) {
					charset = q[0];
					v = q.slice(2).join("'");
				}
			}
			if (p.encoded) bytes.push(Buffer.from(v.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1"));
			else bytes.push(Buffer.from(v, "latin1"));
		});
		params[base] = decoderFor(charset || "utf-8")(Buffer.concat(bytes));
	}
	return { value, params };
}

function decodeTransfer(body, cte) {
	const enc = String(cte || "").trim().toLowerCase();
	if (enc === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
	if (enc === "quoted-printable") {
		const bytes = body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
		return Buffer.from(bytes, "latin1");
	}
	return Buffer.from(body, "latin1");
}

// Each address of an address header, lower case, in order.
function parseAddresses(values) {
	const out = [];
	for (const value of values || []) {
		const s = decodeWords(value);
		let part = "";
		let quoted = false;
		let angle = 0;
		const flush = () => {
			const a = /<\s*([^<>\s]{1,320})\s*>/.exec(part);
			const addr = a ? a[1] : (/[^\s<>",;]{1,320}@[^\s<>",;]{1,320}/.exec(part) || [""])[0];
			if (addr && addr.includes("@")) out.push(addr.toLowerCase());
			part = "";
		};
		for (const ch of s) {
			if (ch === "\"") quoted = !quoted;
			else if (ch === "<" && !quoted) angle++;
			else if (ch === ">" && !quoted && angle) angle--;
			if (ch === "," && !quoted && !angle) flush();
			else part += ch;
		}
		flush();
	}
	return out;
}

function splitHeadBody(s) {
	const crlf = s.indexOf("\r\n\r\n");
	const lf = s.indexOf("\n\n");
	if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { head: s.slice(0, crlf), body: s.slice(crlf + 4) };
	if (lf >= 0) return { head: s.slice(0, lf), body: s.slice(lf + 2) };
	return { head: s, body: "" };
}

function walk(s, depth, out) {
	if (depth > MAX_DEPTH || out.parts >= MAX_PARTS) return;
	out.parts++;
	const { head, body } = splitHeadBody(s);
	const headers = parseHeaders(head);
	const first = (name) => (headers.get(name) || [""])[0];
	const type = parseParams(first("content-type") || "text/plain");
	if (type.value.startsWith("multipart/") && type.params.boundary) {
		// A delimiter line is "--boundary" alone (or "--boundary--"), so a longer
		// boundary that starts with this one never splits it.
		const delim = `--${type.params.boundary}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const chunks = (`\r\n${body}`).split(new RegExp(`\\r?\\n${delim}(?=--|[ \\t]{0,80}\\r?\\n|$)`));
		for (const chunk of chunks.slice(1)) {
			if (chunk.startsWith("--")) break;
			const nl = chunk.indexOf("\n");
			walk(nl < 0 ? "" : chunk.slice(nl + 1), depth + 1, out);
		}
		return;
	}
	const disposition = parseParams(first("content-disposition"));
	const filename = decodeWords(disposition.params.filename || type.params.name || "");
	const bytes = decodeTransfer(body, first("content-transfer-encoding"));
	const isText = type.value === "text/html" || type.value === "text/plain";
	if (isText && disposition.value !== "attachment" && !filename) {
		const text = decoderFor(type.params.charset)(bytes);
		if (type.value === "text/html" && out.html === null) out.html = text;
		else if (type.value === "text/plain" && out.text === null) out.text = text;
		return;
	}
	out.attachments.push({ filename, contentType: type.value, content: bytes });
}

function parseMessage(raw) {
	const empty = { to: [], cc: [], bcc: [], subject: "", date: null, messageId: "", html: null, text: null, attachments: [] };
	try {
		const s = Buffer.isBuffer(raw) ? raw.toString("latin1") : String(raw == null ? "" : raw);
		const { head } = splitHeadBody(s);
		const headers = parseHeaders(head);
		const first = (name) => (headers.get(name) || [""])[0];
		const out = { html: null, text: null, attachments: [], parts: 0 };
		walk(s, 0, out);
		const date = Date.parse(first("date"));
		const subjectRaw = Buffer.from(first("subject"), "latin1").toString("utf8");
		return {
			to: parseAddresses(headers.get("to")),
			cc: parseAddresses(headers.get("cc")),
			bcc: parseAddresses(headers.get("bcc")),
			subject: decodeWords(subjectRaw),
			date: Number.isFinite(date) ? date : null,
			messageId: (/<[^<>\s]{1,300}>/.exec(first("message-id")) || [""])[0],
			html: out.html,
			text: out.text,
			attachments: out.attachments,
		};
	} catch {
		return empty;
	}
}

module.exports = { parseMessage, decodeWords, parseParams, parseAddresses };
