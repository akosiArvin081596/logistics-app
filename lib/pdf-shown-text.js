// The text a PDF shows, read without a third-party parser: the strings its text
// operators (Tj, TJ, ', ") show on each page, in content order, decoded through
// each font's ToUnicode map.
//
// Why not lib/broker-invoice.js extractPdfText(): that reader harvests literal
// "(...)" strings, which is how rate cons are mostly written. Chromium (the
// app's own PDF renderer) shows every glyph as a hex code ("<0012> Tj") whose
// meaning is only in the font's ToUnicode map, so extractPdfText() reads none of
// the words of an invoice the app renders. This reader decodes both kinds.
//
// The strings are joined with nothing between them: Chromium often shows one
// glyph per operator, so a separator would split words and numbers. Whitespace
// is what the fonts map to spaces.
//
// Pure (zlib only; no network, database or files) and bounded: each document
// gets one work budget, re-reads included (characters and tokens read, bytes
// inflated, map entries set, form draws and depth, pages, text shown), and the
// reader stops at it: a document that reaches any limit reads as "" (unreadable),
// never as a partial text, since what was left unread could be what differs.
// Anything else it can't read (an unknown filter, a broken object) is skipped;
// the answer is "" when nothing could be read. Never throws.
//
// shownTextRead() answers the same text and whether the read was whole: nothing
// skipped, every font found, and every glyph read through a map or a standard
// encoding. A check that must rule something out reads only a whole text.

"use strict";

const zlib = require("zlib");

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_VALUE_DEPTH = 64;
const MAX_MAP_ENTRIES = 65536;
// The rest of the budget. The repo's own 76-page Chromium-made guide uses at most
// about a third of any limit, a one-page invoice about a hundredth.
const LIMITS = Object.freeze({
	chars: 32 * 1024 * 1024, // characters the lexer moves over
	tokens: 2000000, // tokens it reads
	wordChars: 256, // the longest number or keyword
	mapSteps: 4 * 65536, // ToUnicode entries set, overlapping ranges included
	formDraws: 1024, // Form XObjects drawn
	formDepth: 8, // Form XObjects drawn inside one another
	pages: 2000,
	treeDepth: 64, // levels of the page tree
	textChars: 2 * 1024 * 1024, // text shown
});
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

class LimitReached extends Error {}

// Counts one kind of work against its limit; past it (or on a count that isn't a
// number), the document is unreadable.
function spend(work, what, n) {
	work[what] += n;
	if (!(work[what] <= LIMITS[what])) throw new LimitReached(what);
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isRegular = (c) => !WS.has(c) && !DELIM.has(c);
const HEX = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

// A token reader over a latin1 string, from `pos` to `end`, charging `work` for
// every character it moves over and every token it reads.
function lexer(s, pos, end, work) {
	const lex = { pos, end, work, peeked: [] };
	lex.next = () => (lex.peeked.length ? lex.peeked.shift() : read(s, lex));
	lex.peek = (n = 0) => {
		while (lex.peeked.length <= n) lex.peeked.push(read(s, lex));
		return lex.peeked[n];
	};
	return lex;
}

function read(s, lex) {
	const from = lex.pos;
	let i = lex.pos;
	const end = lex.end;
	for (;;) {
		while (i < end && WS.has(s.charCodeAt(i))) i++;
		if (i < end && s.charCodeAt(i) === 0x25) {
			while (i < end && s.charCodeAt(i) !== 0x0a && s.charCodeAt(i) !== 0x0d) i++;
			continue;
		}
		break;
	}
	if (i >= end) {
		lex.pos = end;
		spend(lex.work, "chars", end - from);
		return null;
	}
	const c = s.charCodeAt(i);
	const at = i;
	let tok;
	if (c === 0x28) {
		const r = literalString(s, i + 1, end);
		tok = { t: "str", v: r.bytes };
		i = r.next;
	} else if (c === 0x3c && s.charCodeAt(i + 1) === 0x3c) {
		tok = { t: "<<" };
		i += 2;
	} else if (c === 0x3e && s.charCodeAt(i + 1) === 0x3e) {
		tok = { t: ">>" };
		i += 2;
	} else if (c === 0x3c) {
		let j = i + 1;
		let hex = "";
		while (j < end && s.charCodeAt(j) !== 0x3e) {
			const d = s.charCodeAt(j);
			if (HEX(d)) hex += s[j];
			j++;
		}
		if (hex.length % 2) hex += "0";
		tok = { t: "str", v: Buffer.from(hex, "hex") };
		i = j + 1;
	} else if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
		tok = { t: s[i] };
		i++;
	} else if (c === 0x2f) {
		let j = i + 1;
		while (j < end && isRegular(s.charCodeAt(j))) j++;
		const raw = s.slice(i + 1, j).replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
		tok = { t: "name", v: raw };
		i = j;
	} else if (c === 0x29 || c === 0x3e) {
		tok = { t: "kw", v: s[i] };
		i++;
	} else {
		let j = i;
		while (j < end && isRegular(s.charCodeAt(j))) {
			if (++j - i > LIMITS.wordChars) throw new LimitReached("wordChars");
		}
		const word = s.slice(i, j);
		tok = NUMBER_RE.test(word) ? { t: "num", v: Number(word) } : { t: "kw", v: word };
		i = j;
	}
	tok.at = at;
	lex.pos = i;
	spend(lex.work, "chars", i - from);
	spend(lex.work, "tokens", 1);
	return tok;
}

// A literal string's bytes, from just after its "(": balanced parentheses and
// the escapes of the PDF reference.
function literalString(s, i, end) {
	const out = [];
	let depth = 1;
	while (i < end) {
		const c = s.charCodeAt(i);
		if (c === 0x5c) {
			const d = s.charCodeAt(i + 1);
			i += 2;
			if (d === 0x6e) out.push(0x0a);
			else if (d === 0x72) out.push(0x0d);
			else if (d === 0x74) out.push(0x09);
			else if (d === 0x62) out.push(0x08);
			else if (d === 0x66) out.push(0x0c);
			else if (d >= 0x30 && d <= 0x37) {
				let oct = String.fromCharCode(d);
				while (oct.length < 3 && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x37) oct += s[i++];
				out.push(parseInt(oct, 8) & 0xff);
			} else if (d === 0x0d) {
				if (s.charCodeAt(i) === 0x0a) i++;
			} else if (d !== 0x0a && !Number.isNaN(d)) out.push(d);
			continue;
		}
		if (c === 0x28) depth++;
		if (c === 0x29 && --depth === 0) return { bytes: Buffer.from(out), next: i + 1 };
		out.push(c & 0xff);
		i++;
	}
	return { bytes: Buffer.from(out), next: end };
}

// One value at the lexer's position: a number, a name, a string, an array, a
// dictionary (keys without their "/") or a reference { ref }.
function parseValue(lex, depth = 0) {
	const tok = lex.next();
	if (!tok) return undefined;
	if (depth > MAX_VALUE_DEPTH) return undefined;
	if (tok.t === "num") {
		const a = lex.peek(0);
		const b = lex.peek(1);
		if (Number.isInteger(tok.v) && a && a.t === "num" && Number.isInteger(a.v) && b && b.t === "kw" && b.v === "R") {
			lex.next();
			lex.next();
			return { ref: tok.v };
		}
		return tok.v;
	}
	if (tok.t === "name") return `/${tok.v}`;
	if (tok.t === "str") return tok.v;
	if (tok.t === "[") {
		const arr = [];
		for (;;) {
			const p = lex.peek();
			if (!p) return arr;
			if (p.t === "]") {
				lex.next();
				return arr;
			}
			arr.push(parseValue(lex, depth + 1));
		}
	}
	if (tok.t === "<<") {
		const dict = {};
		for (;;) {
			const p = lex.next();
			if (!p || p.t === ">>") return dict;
			if (p.t !== "name") continue;
			const nxt = lex.peek();
			if (!nxt || nxt.t === ">>") return dict;
			dict[p.v] = parseValue(lex, depth + 1);
		}
	}
	return { kw: tok.v };
}

const isDict = (v) => v && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v) && v.ref === undefined && v.kw === undefined;

// A simple font with no ToUnicode map is read by its bytes, which is its text only under
// one of these encodings (or a standard font's own, with no /Encoding).
const STANDARD_ENCODINGS = new Set(["/WinAnsiEncoding", "/MacRomanEncoding", "/StandardEncoding"]);
const STANDARD_TEXT_FONT_RE = /^\/(?:[A-Z]{6}\+)?(?:Helvetica|Times|Courier)(?:-[A-Za-z]{1,20})?$/;
// The printable ASCII codes' glyph names, so an /Encoding /Differences entry can be told
// apart from one that moves a letter to another code.
const ASCII_GLYPH = (() => {
	const names = new Map();
	const punct = ["space", "exclam", "quotedbl", "numbersign", "dollar", "percent", "ampersand", "quotesingle", "parenleft", "parenright", "asterisk",
		"plus", "comma", "hyphen", "period", "slash"];
	punct.forEach((n, i) => names.set(0x20 + i, n));
	["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].forEach((n, i) => names.set(0x30 + i, n));
	["colon", "semicolon", "less", "equal", "greater", "question", "at"].forEach((n, i) => names.set(0x3a + i, n));
	for (let c = 0x41; c <= 0x5a; c++) names.set(c, String.fromCharCode(c));
	["bracketleft", "backslash", "bracketright", "asciicircum", "underscore", "grave"].forEach((n, i) => names.set(0x5b + i, n));
	for (let c = 0x61; c <= 0x7a; c++) names.set(c, String.fromCharCode(c));
	["braceleft", "bar", "braceright", "asciitilde"].forEach((n, i) => names.set(0x7b + i, n));
	return { nameOf: names, codeOf: new Map([...names].map(([code, name]) => [name, code])) };
})();

// Does a /Differences array keep every printable ASCII code on its own glyph, and put
// no ASCII glyph at another code? Anything else reads as other text than it shows.
function differencesKeepAscii(diffs) {
	if (!Array.isArray(diffs)) return false;
	let code = -1;
	for (const v of diffs) {
		if (typeof v === "number") { code = v; continue; }
		if (typeof v !== "string" || !v.startsWith("/") || code < 0) return false;
		const name = v.slice(1);
		const at = ASCII_GLYPH.codeOf.get(name);
		if (code >= 0x20 && code <= 0x7e ? ASCII_GLYPH.nameOf.get(code) !== name : at !== undefined) return false;
		code++;
	}
	return true;
}

function shownText(buffer, opts = {}) {
	try {
		return readDocument(buffer, opts).text;
	} catch {
		return "";
	}
}

// { text, whole }: the text as shownText() answers it, and whether nothing was skipped.
function shownTextRead(buffer, opts = {}) {
	try {
		const r = readDocument(buffer, opts);
		return { text: r.text, whole: r.whole && r.text !== "" };
	} catch {
		return { text: "", whole: false };
	}
}

function readDocument(buffer, opts) {
	if (!Buffer.isBuffer(buffer) || !buffer.length) return { text: "", whole: false };
	const work = {
		inflateLeft: opts && Number.isFinite(opts.maxInflatedBytes) && opts.maxInflatedBytes > 0 ? opts.maxInflatedBytes : DEFAULT_MAX_BYTES,
		chars: 0,
		tokens: 0,
		mapSteps: 0,
		formDraws: 0,
		textChars: 0,
		// Set once anything the pages show was skipped or read by a guess.
		partial: false,
	};
	const s = buffer.toString("latin1");
	const objects = indexObjects(s, buffer, work);

	const resolve = (v, hops = 0) => {
		let x = v;
		while (x && typeof x === "object" && x.ref !== undefined && hops++ < 32) {
			const o = objects.get(x.ref);
			x = o ? o.value : undefined;
		}
		return x;
	};
	const streamText = (ref) => {
		const o = objects.get(ref);
		if (!o || !o.stream) {
			work.partial = true;
			return "";
		}
		if (o.text === undefined) o.text = decodeStream(o, resolve, work);
		return o.text;
	};

	// A simple font read by its bytes reads as it shows only under a standard encoding,
	// with no ASCII glyph moved by /Differences.
	const bytesReadAsShown = (dict) => {
		if (dict.Subtype !== "/Type1" && dict.Subtype !== "/TrueType" && dict.Subtype !== "/MMType1") return false;
		const enc = resolve(dict.Encoding);
		if (enc === undefined) return typeof dict.BaseFont === "string" && STANDARD_TEXT_FONT_RE.test(dict.BaseFont);
		if (typeof enc === "string") return STANDARD_ENCODINGS.has(enc);
		if (!isDict(enc)) return false;
		const base = resolve(enc.BaseEncoding);
		if (base === undefined ? !(typeof dict.BaseFont === "string" && STANDARD_TEXT_FONT_RE.test(dict.BaseFont)) : !STANDARD_ENCODINGS.has(base)) return false;
		const diffs = resolve(enc.Differences);
		return diffs === undefined || differencesKeepAscii(Array.isArray(diffs) ? diffs.map((d) => resolve(d)) : diffs);
	};

	const fonts = new Map();
	const fontFor = (ref) => {
		if (!ref || ref.ref === undefined) return null;
		if (fonts.has(ref.ref)) return fonts.get(ref.ref);
		const dict = resolve(ref);
		let font = null;
		if (isDict(dict)) {
			const type0 = dict.Subtype === "/Type0";
			const tu = dict.ToUnicode;
			const cmap = tu && tu.ref !== undefined ? parseCMap(streamText(tu.ref), work) : null;
			// A map named but unread leaves its codes unknown, whatever the bytes look like.
			const plainOk = tu === undefined && !type0 && bytesReadAsShown(dict);
			font = { width: cmap && cmap.width ? cmap.width : type0 ? 2 : 1, map: cmap ? cmap.map : null, plainOk };
		}
		fonts.set(ref.ref, font);
		return font;
	};

	const out = { parts: [] };
	const emit = (str) => {
		if (!str) return;
		spend(work, "textChars", str.length);
		out.parts.push(str);
	};
	const decode = (font, bytes) => {
		if (!Buffer.isBuffer(bytes) || !bytes.length) return "";
		if (!font || !font.map) {
			if (!font || !font.plainOk) work.partial = true;
			return font && font.width === 2 ? "�".repeat(bytes.length >> 1) : bytes.toString("latin1");
		}
		let str = "";
		for (let i = 0; i + font.width <= bytes.length; i += font.width) {
			const code = font.width === 2 ? bytes.readUInt16BE(i) : bytes[i];
			const u = font.map.get(code);
			if (u === undefined) work.partial = true;
			str += u === undefined ? "�" : u;
		}
		return str;
	};

	function run(text, resources, depth) {
		const res = resolve(resources);
		const fontRes = isDict(res) ? resolve(res.Font) : null;
		const xobjRes = isDict(res) ? resolve(res.XObject) : null;
		const lex = lexer(text, 0, text.length, work);
		const stack = [];
		let font = null;
		let operands = [];
		for (;;) {
			const tok = lex.peek();
			if (!tok) break;
			if (tok.t !== "kw") {
				operands.push(parseValue(lex));
				if (operands.length > 64) operands = operands.slice(-16);
				continue;
			}
			lex.next();
			const op = tok.v;
			if (op === "q") stack.push(font);
			else if (op === "Q") font = stack.length ? stack.pop() : font;
			else if (op === "Tf") {
				const name = operands[operands.length - 2];
				font = typeof name === "string" && isDict(fontRes) ? fontFor(fontRes[name.slice(1)]) : null;
			} else if (op === "Tj" || op === "'") emit(decode(font, operands[operands.length - 1]));
			else if (op === "\"") emit(decode(font, operands[operands.length - 1]));
			else if (op === "TJ") {
				const arr = operands[operands.length - 1];
				if (Array.isArray(arr)) for (const el of arr) if (Buffer.isBuffer(el)) emit(decode(font, el));
			} else if (op === "Do") {
				const name = operands[operands.length - 1];
				const ref = typeof name === "string" && isDict(xobjRes) ? xobjRes[name.slice(1)] : null;
				const xo = ref && ref.ref !== undefined ? objects.get(ref.ref) : null;
				if (xo && isDict(xo.value) && xo.value.Subtype === "/Form") {
					// Each draw reads the form's content again, so draws and depth both count.
					if (depth >= LIMITS.formDepth) throw new LimitReached("formDepth");
					spend(work, "formDraws", 1);
					run(streamText(ref.ref), xo.value.Resources || res, depth + 1);
				} else if (!(xo && isDict(xo.value) && xo.value.Subtype === "/Image")) {
					// An object drawn that isn't found, or isn't an image: it may hold text.
					work.partial = true;
				}
			} else if (op === "BI") {
				// An inline image: its data runs from ID to EI, and is no text.
				const id = text.indexOf("ID", lex.pos);
				const ei = id < 0 ? -1 : text.indexOf("EI", id + 2);
				const next = ei < 0 ? text.length : ei + 2;
				spend(work, "chars", next - lex.pos);
				lex.pos = next;
				lex.peeked = [];
			}
			operands = [];
		}
	}

	for (const page of pagesOf(objects, s, resolve, work)) {
		// One content stream, or a list of them (given directly or by reference).
		const contents = resolve(page.dict.Contents);
		const refs = Array.isArray(contents) ? contents : page.dict.Contents !== undefined ? [page.dict.Contents] : [];
		const texts = refs.map((r) => {
			if (r && r.ref !== undefined) return streamText(r.ref);
			work.partial = true;
			return "";
		});
		// The lexer reads every character of them, pages and entries sharing one
		// stream included, so a page past the budget stops before they are joined.
		if (texts.reduce((n, t) => n + t.length + 1, work.chars) > LIMITS.chars) throw new LimitReached("chars");
		run(texts.join("\n"), page.resources, 0);
	}
	return { text: out.parts.join(""), whole: !work.partial };
}

// Every "N G obj" in file order, each with its value and, for a stream, where its
// bytes are. A stream's /Length (when given directly) skips its bytes, so a
// header-shaped run inside binary data is never taken for an object.
function indexObjects(s, buffer, work) {
	const objects = new Map();
	const re = /(\d{1,10})[ \t\r\n\f\0]{1,8}(\d{1,5})[ \t\r\n\f\0]{1,8}obj\b/g;
	let m;
	while ((m = re.exec(s))) {
		const num = Number(m[1]);
		const lex = lexer(s, m.index + m[0].length, s.length, work);
		const value = parseValue(lex);
		const after = lex.peek();
		const entry = { value, stream: null };
		if (after && after.t === "kw" && after.v === "stream") {
			let start = after.at + 6;
			if (s.charCodeAt(start) === 0x0d) start++;
			if (s.charCodeAt(start) === 0x0a) start++;
			const len = isDict(value) && Number.isInteger(value.Length) && value.Length >= 0 ? value.Length : -1;
			let end = len >= 0 && start + len <= s.length ? start + len : s.indexOf("endstream", start);
			if (end < 0) end = s.length;
			entry.stream = { start, end, buffer };
			re.lastIndex = Math.max(re.lastIndex, end);
		} else {
			re.lastIndex = Math.max(re.lastIndex, lex.pos);
		}
		objects.set(num, entry);
	}
	return objects;
}

// A stream's bytes as latin1 text: inflated when its filter is FlateDecode, as
// stored when it has none, "" for any other filter (images and fonts are no text)
// or a stream that won't inflate; past the byte budget, the document is unreadable.
const tooLarge = (e) => Boolean(e) && e.code === "ERR_BUFFER_TOO_LARGE";
function decodeStream(o, resolve, work) {
	const dict = isDict(o.value) ? o.value : {};
	const raw = o.stream.buffer.subarray(o.stream.start, o.stream.end);
	const filter = resolve(dict.Filter);
	const filters = Array.isArray(filter) ? filter.map((f) => resolve(f)) : filter ? [filter] : [];
	if (!filters.length) {
		if (raw.length > work.inflateLeft) throw new LimitReached("inflatedBytes");
		work.inflateLeft -= raw.length;
		return raw.toString("latin1");
	}
	if (filters.length !== 1 || filters[0] !== "/FlateDecode") {
		work.partial = true;
		return "";
	}
	if (work.inflateLeft <= 0) throw new LimitReached("inflatedBytes");
	const zopts = { maxOutputLength: work.inflateLeft, windowBits: zlib.constants.Z_DEFAULT_WINDOWBITS };
	let out = null;
	try {
		out = zlib.inflateSync(raw, zopts);
	} catch (e) {
		if (tooLarge(e)) throw new LimitReached("inflatedBytes");
		try {
			out = zlib.inflateRawSync(raw, zopts);
		} catch (e2) {
			if (tooLarge(e2)) throw new LimitReached("inflatedBytes");
			out = null;
		}
	}
	if (!out) {
		work.partial = true;
		return "";
	}
	work.inflateLeft -= out.length;
	return out.toString("latin1");
}

// The pages in order, from the trailer's catalog down its page tree, each with
// the resources it has or inherits. Without a usable trailer, the catalog is
// looked for among the objects.
function pagesOf(objects, s, resolve, work) {
	let root = null;
	const t = s.lastIndexOf("trailer");
	if (t >= 0) {
		const lex = lexer(s, t + 7, s.length, work);
		const d = parseValue(lex);
		if (isDict(d) && d.Root && d.Root.ref !== undefined) root = d.Root;
	}
	if (!root) {
		for (const [num, o] of objects) {
			if (isDict(o.value) && (o.value.Type === "/Catalog" || (o.value.Type === "/XRef" && o.value.Root))) {
				root = o.value.Type === "/Catalog" ? { ref: num } : o.value.Root;
				break;
			}
		}
	}
	const catalog = resolve(root);
	const pages = [];
	const seen = new Set();
	const walk = (ref, inherited, depth) => {
		if (!ref || ref.ref === undefined || seen.has(ref.ref)) return;
		if (depth > LIMITS.treeDepth) throw new LimitReached("treeDepth");
		seen.add(ref.ref);
		const node = resolve(ref);
		if (!isDict(node)) return;
		const resources = node.Resources !== undefined ? node.Resources : inherited;
		if (node.Type === "/Pages" || Array.isArray(node.Kids)) {
			for (const kid of resolve(node.Kids) || []) walk(kid, resources, depth + 1);
		} else {
			if (pages.length >= LIMITS.pages) throw new LimitReached("pages");
			pages.push({ dict: node, resources });
		}
	};
	if (isDict(catalog)) walk(catalog.Pages, null, 0);
	return pages;
}

// A ToUnicode CMap: the code width (from its first codespace range) and the
// codes it maps, to the UTF-16 text each stands for. Every entry set counts
// against the budget, so ranges that overlap cost what they do.
function parseCMap(text, work) {
	if (!text) return null;
	const map = new Map();
	let width = 0;
	const hexOf = (b) => (Buffer.isBuffer(b) ? b : Buffer.alloc(0));
	const utf16 = (b) => {
		const buf = hexOf(b);
		let str = "";
		for (let i = 0; i + 1 < buf.length; i += 2) str += String.fromCharCode(buf.readUInt16BE(i));
		return str;
	};
	// A character code is one to four bytes; a longer one is no code (and its
	// number wouldn't count exactly).
	const isCode = (b) => Buffer.isBuffer(b) && b.length >= 1 && b.length <= 4;
	const codeOf = (buf) => {
		let n = 0;
		for (const byte of buf) n = n * 256 + byte;
		return n;
	};
	const lex = lexer(text, 0, text.length, work);
	let mode = "";
	const args = [];
	for (;;) {
		const tok = lex.peek();
		if (!tok) break;
		if (tok.t === "kw" && /^(begin|end)(codespacerange|bfchar|bfrange)$/.test(tok.v)) {
			lex.next();
			mode = tok.v.startsWith("begin") ? tok.v.slice(5) : "";
			args.length = 0;
			continue;
		}
		const v = parseValue(lex);
		if (!mode) continue;
		args.push(v);
		if (mode === "codespacerange" && args.length === 2) {
			if (!width && Buffer.isBuffer(args[0])) width = args[0].length;
			args.length = 0;
		} else if (mode === "bfchar" && args.length === 2) {
			if (map.size < MAX_MAP_ENTRIES && isCode(args[0])) {
				spend(work, "mapSteps", 1);
				map.set(codeOf(args[0]), utf16(args[1]));
			}
			args.length = 0;
		} else if (mode === "bfrange" && args.length === 3) {
			const [lo, hi, dst] = args;
			if (isCode(lo) && isCode(hi)) {
				const a = codeOf(lo);
				const b = Math.min(codeOf(hi), a + MAX_MAP_ENTRIES);
				if (b >= a) spend(work, "mapSteps", b - a + 1);
				if (Array.isArray(dst)) {
					for (let c = a; c <= b && map.size < MAX_MAP_ENTRIES; c++) map.set(c, utf16(dst[c - a]));
				} else if (Buffer.isBuffer(dst) && dst.length >= 2) {
					const base = Buffer.from(dst);
					for (let c = a; c <= b && map.size < MAX_MAP_ENTRIES; c++) {
						const unit = Buffer.from(base);
						unit.writeUInt16BE((base.readUInt16BE(base.length - 2) + (c - a)) & 0xffff, base.length - 2);
						map.set(c, utf16(unit));
					}
				}
			}
			args.length = 0;
		}
	}
	return { width: width === 1 || width === 2 ? width : 0, map };
}

module.exports = { shownText, shownTextRead, DEFAULT_MAX_BYTES };
