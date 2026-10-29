// The text on each page of a PDF, and the fonts it embeds: enough to say two
// renders of one document read the same (scripts/test-pdf-cold-start.js).
//
// Text comes from the content streams' text operators (Tj, TJ, ' and "),
// decoded through each font's ToUnicode map, with form XObjects followed. It
// is the glyphs in the order the renderer drew them, whitespace left out:
// Chromium places every run on its own and draws no space glyph, so a layout
// guess would add noise. Two renders that print the same glyphs in the same
// order give the same text.
//
// A font is named by its subtype, its name and a digest of its glyph program.
// Chromium writes web fonts as Type3 fonts, which carry no BaseFont, so the
// name falls back to the descriptor's FontName, then its FontFamily and
// weight; the digest (the embedded font file, or a Type3 font's glyph
// procedures) tells two fonts of one name apart.
//
//   const { pdfReport, compareRenders } = require("./lib/pdf-text");
//   const a = await pdfReport(bytes);   // { pages: [text], fonts: ["Type3 Open Sans 700 #…"], drawing }
//   compareRenders(a, b);               // { pages, text, fonts, drawing }: null where it holds
//
// Pure apart from parsing the bytes it is given (pdf-lib, already a
// dependency of the app).

"use strict";

const crypto = require("crypto");
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } = require("pdf-lib");

const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

// A ToUnicode CMap: code (hex, as written) -> text.
function parseCMap(text) {
	const map = new Map();
	const hexToText = (hex) => {
		let out = "";
		for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
		if (hex.length % 4 === 2) out += String.fromCharCode(parseInt(hex.slice(-2), 16));
		return out;
	};
	for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
		for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(m[1].toLowerCase(), hexToText(m[2]));
	}
	for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
		for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g)) {
			const width = m[1].length;
			const lo = parseInt(m[1], 16);
			const hi = parseInt(m[2], 16);
			const key = (n) => n.toString(16).padStart(width, "0");
			if (m[3].startsWith("[")) {
				const dsts = [...m[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => x[1]);
				for (let n = lo; n <= hi && n - lo < dsts.length; n++) map.set(key(n), hexToText(dsts[n - lo]));
			} else {
				const base = m[3].slice(1, -1);
				const start = parseInt(base.slice(-4) || "0", 16);
				const prefix = base.slice(0, -4);
				for (let n = lo; n <= hi; n++) map.set(key(n), hexToText(prefix + (start + n - lo).toString(16).padStart(4, "0")));
			}
		}
	}
	return map;
}

// The tokens of a content stream: strings (as raw bytes), hex strings,
// arrays, names, numbers and operators. Dictionaries are skipped whole.
function tokenize(src) {
	const tokens = [];
	const stack = [tokens];
	const push = (t) => stack[stack.length - 1].push(t);
	let i = 0;
	const isWhite = (c) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
	const isDelim = (c) => "()<>[]{}/%".includes(c);
	while (i < src.length) {
		const c = src[i];
		if (isWhite(c)) { i++; continue; }
		if (c === "%") { while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
		if (c === "(") {
			let depth = 1;
			let out = "";
			i++;
			while (i < src.length && depth > 0) {
				const d = src[i];
				if (d === "\\") {
					const n = src[i + 1];
					const esc = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
					if (n in esc) { out += esc[n]; i += 2; continue; }
					if (/[0-7]/.test(n)) {
						let oct = "";
						let j = i + 1;
						while (j < src.length && oct.length < 3 && /[0-7]/.test(src[j])) oct += src[j++];
						out += String.fromCharCode(parseInt(oct, 8));
						i = j;
						continue;
					}
					i += 2;
					continue;
				}
				if (d === "(") depth++;
				if (d === ")") { depth--; if (depth === 0) { i++; break; } }
				out += d;
				i++;
			}
			push({ str: out });
			continue;
		}
		if (c === "<" && src[i + 1] === "<") {
			let depth = 0;
			while (i < src.length) {
				if (src[i] === "<" && src[i + 1] === "<") { depth++; i += 2; continue; }
				if (src[i] === ">" && src[i + 1] === ">") { depth--; i += 2; if (depth === 0) break; continue; }
				i++;
			}
			push({ dict: true });
			continue;
		}
		if (c === "<") {
			const end = src.indexOf(">", i);
			push({ hex: src.slice(i + 1, end < 0 ? src.length : end).replace(/\s+/g, "").toLowerCase() });
			i = end < 0 ? src.length : end + 1;
			continue;
		}
		if (c === "[") { const arr = []; push({ arr }); stack.push(arr); i++; continue; }
		if (c === "]") { if (stack.length > 1) stack.pop(); i++; continue; }
		if (c === "/") {
			let j = i + 1;
			while (j < src.length && !isWhite(src[j]) && !isDelim(src[j])) j++;
			push({ name: src.slice(i + 1, j) });
			i = j;
			continue;
		}
		let j = i;
		while (j < src.length && !isWhite(src[j]) && !isDelim(src[j])) j++;
		if (j === i) { i++; continue; }
		const word = src.slice(i, j);
		push(/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) ? { num: Number(word) } : { op: word });
		i = j;
	}
	return tokens;
}

function streamBytes(context, obj) {
	const s = obj instanceof PDFRef ? context.lookup(obj) : obj;
	if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
	if (s && typeof s.getContents === "function") return s.getContents();
	return new Uint8Array();
}

const digest = (parts) => {
	const h = crypto.createHash("sha256");
	for (const p of parts) h.update(p).update("\0");
	return h.digest("hex").slice(0, 12);
};
const withoutSubsetTag = (s) => s.replace(/^[A-Z]{6}\+/, "");
// A PDF name, byte string or number as text ("" when absent).
function textOfValue(v) {
	if (!v) return "";
	if (v instanceof PDFNumber) return String(v.asNumber());
	return typeof v.decodeText === "function" ? v.decodeText() : String(v);
}

// "<Subtype> <name> #<digest>" for one font dictionary.
function fontIdentity(context, font) {
	const subtype = textOfValue(font.lookupMaybe(PDFName.of("Subtype"), PDFName)) || "(no subtype)";
	// A Type0 font's descriptor sits on its descendant font.
	let described = font;
	const descendants = font.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray);
	if (descendants && descendants.size()) described = context.lookup(descendants.get(0), PDFDict) || font;
	const descriptor = described.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
	const fromDescriptor = (key) => (descriptor ? textOfValue(descriptor.lookup(PDFName.of(key))) : "");
	let name = withoutSubsetTag(textOfValue(font.lookupMaybe(PDFName.of("BaseFont"), PDFName)));
	if (!name) name = withoutSubsetTag(fromDescriptor("FontName"));
	if (!name && fromDescriptor("FontFamily")) {
		const angle = Number(fromDescriptor("ItalicAngle") || 0);
		name = [fromDescriptor("FontFamily"), fromDescriptor("FontWeight"), angle ? "italic" : ""].filter(Boolean).join(" ");
	}
	if (!name) name = textOfValue(font.lookupMaybe(PDFName.of("Name"), PDFName)) || "(unnamed)";
	const program = [];
	for (const key of ["FontFile", "FontFile2", "FontFile3"]) {
		const file = descriptor && descriptor.get(PDFName.of(key));
		if (file) program.push(key, Buffer.from(streamBytes(context, file)));
	}
	const procs = font.lookupMaybe(PDFName.of("CharProcs"), PDFDict);
	if (procs) {
		for (const [glyph, ref] of [...procs.entries()].sort(([a], [b]) => (a.decodeText() < b.decodeText() ? -1 : 1))) {
			program.push(glyph.decodeText(), Buffer.from(streamBytes(context, ref)));
		}
	}
	return `${subtype} ${name} #${program.length ? digest(program) : "no-program"}`;
}

function fontsOf(context, resources) {
	const out = new Map();
	const dict = resources && resources.lookupMaybe(PDFName.of("Font"), PDFDict);
	if (!dict) return out;
	for (const [name, ref] of dict.entries()) {
		const font = context.lookup(ref, PDFDict);
		const subtype = font.lookupMaybe(PDFName.of("Subtype"), PDFName);
		const toUnicode = font.get(PDFName.of("ToUnicode"));
		out.set(name.decodeText(), {
			id: fontIdentity(context, font),
			twoByte: subtype ? subtype.decodeText() === "Type0" : false,
			map: toUnicode ? parseCMap(latin1(streamBytes(context, toUnicode))) : new Map(),
		});
	}
	return out;
}

function decodeString(font, raw) {
	if (!font) return "";
	const bytes = raw.hex !== undefined ? raw.hex : Buffer.from(raw.str, "latin1").toString("hex");
	const step = font.twoByte ? 4 : 2;
	let out = "";
	for (let k = 0; k + step <= bytes.length; k += step) {
		const code = bytes.slice(k, k + step);
		out += font.map.has(code) ? font.map.get(code) : font.twoByte ? "" : String.fromCharCode(parseInt(code, 16));
	}
	return out;
}

// `seen` collects every font met, and `drawing` hashes every content stream
// drawn, form XObjects included. A form XObject can use its parent's fonts.
function textOf(context, contentBytes, resources, seen, drawing, depth, inherited = new Map()) {
	const ownFonts = new Map([...inherited, ...fontsOf(context, resources)]);
	for (const v of ownFonts.values()) seen.add(v.id);
	drawing.update(Buffer.from(contentBytes)).update("\0");
	const tokens = tokenize(latin1(contentBytes));
	let current = null;
	let out = "";
	const operands = [];
	for (const t of tokens) {
		if (t.op === undefined) { operands.push(t); continue; }
		const op = t.op;
		if (op === "Tf") {
			const name = operands.find((o) => o.name !== undefined);
			current = name ? ownFonts.get(name.name) || null : null;
		} else if (op === "Tj" || op === "'" || op === "\"") {
			const s = [...operands].reverse().find((o) => o.str !== undefined || o.hex !== undefined);
			if (s) out += decodeString(current, s);
		} else if (op === "TJ") {
			const a = operands.find((o) => o.arr);
			if (a) for (const part of a.arr) if (part.str !== undefined || part.hex !== undefined) out += decodeString(current, part);
		} else if (op === "Do" && depth < 8) {
			const name = operands.find((o) => o.name !== undefined);
			const xobjects = resources && resources.lookupMaybe(PDFName.of("XObject"), PDFDict);
			const ref = name && xobjects ? xobjects.get(PDFName.of(name.name)) : null;
			const xo = ref ? context.lookup(ref) : null;
			if (xo instanceof PDFRawStream) {
				const sub = xo.dict.lookupMaybe(PDFName.of("Subtype"), PDFName);
				if (sub && sub.decodeText() === "Form") {
					const xoResources = xo.dict.lookupMaybe(PDFName.of("Resources"), PDFDict) || resources;
					out += textOf(context, decodePDFRawStream(xo).decode(), xoResources, seen, drawing, depth + 1, ownFonts);
				}
			}
		}
		operands.length = 0;
	}
	return out;
}

async function pdfReport(bytes) {
	const doc = await PDFDocument.load(bytes, { updateMetadata: false });
	const context = doc.context;
	const pages = [];
	const seen = new Set();
	const drawing = crypto.createHash("sha256");
	for (const page of doc.getPages()) {
		const node = page.node;
		const resources = node.Resources();
		const contents = node.get(PDFName.of("Contents"));
		const parts = [];
		const resolved = contents instanceof PDFRef ? context.lookup(contents) : contents;
		if (resolved instanceof PDFArray) for (let k = 0; k < resolved.size(); k++) parts.push(streamBytes(context, resolved.get(k)));
		else if (resolved) parts.push(streamBytes(context, resolved));
		const text = parts.map((b) => textOf(context, b, resources, seen, drawing, 0)).join("");
		drawing.update("\f");
		pages.push(text.replace(/\s+/g, ""));
	}
	return { pages, fonts: [...seen].sort(), drawing: drawing.digest("hex").slice(0, 16) };
}

// Whether two renders of one document read the same. Each field is null when
// it holds, or says why not. Nothing holds by being empty: no page fails, text
// read with no font read fails (the reader missed one), and fonts with no text
// read fail (the text reader missed it). Only a document with neither text nor
// fonts is compared by what its pages draw instead.
function compareRenders(a, b) {
	const out = { pages: null, text: null, fonts: null, drawing: null };
	if (!a.pages.length || a.pages.length !== b.pages.length) out.pages = `${a.pages.length} page(s) against ${b.pages.length}`;
	const anyText = [...a.pages, ...b.pages].some((t) => t.length > 0);
	const anyFont = a.fonts.length > 0 || b.fonts.length > 0;
	const differs = a.pages.findIndex((t, i) => t !== b.pages[i]);
	if (differs >= 0) out.text = `page ${differs + 1} differs`;
	else if (!anyText && anyFont) out.text = "fonts were read but no text: the text reader missed it";
	if (JSON.stringify(a.fonts) !== JSON.stringify(b.fonts)) out.fonts = `${a.fonts.join(", ") || "none"} against ${b.fonts.join(", ") || "none"}`;
	else if (anyText && !anyFont) out.fonts = "text was read but no font: the font reader missed one";
	if (!anyText && !anyFont && a.drawing !== b.drawing) out.drawing = "neither text nor fonts, and the pages draw differently";
	return out;
}

module.exports = { pdfReport, compareRenders, fontIdentity, parseCMap, tokenize };
