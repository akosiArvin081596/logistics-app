"use strict";
// One PDF receipt job, in its own process: started by lib/receipt-pdf.js, the
// only caller, under Node's permission model (it may read only this script and
// the modules it loads; no child processes, workers or file writes), a 256 MB
// heap and an empty environment, and as an unprivileged user when the server
// runs as root. It receives one job over IPC, replies exactly once and exits.
// Anything that goes wrong ends this process, never the server: the parent
// kills it at its deadline and prints the "PDF receipt on file" note instead.
//
// Jobs:
//   { kind: "prepare", bytes, modules, limits }
//     -> { ok: true, pdf, pages, sourcePages } | { ok: false, reason }
//     A stored PDF receipt becomes a new PDF of at most limits.maxPages Letter
//     pages, each holding one source page drawn as a Form XObject under an empty
//     0.4 in strip (the merge writes "Receipt N of M - page x of y" there). The
//     source catalog, trailer, Info, ID, outlines, forms, names and every page
//     key but its boxes, contents, resources and rotation are never copied.
//     Every object the copied resources reach is cleaned (see STRIP_KEYS), JPEG
//     images keep only their JFIF APP0, ICC APP2 and Adobe APP14 segments (EXIF
//     with GPS, XMP, IPTC, every other APPn, comments and bytes after the end
//     are dropped), an image declaring more than limits.maxImagePixels is
//     refused, and the receipt is refused (reason code, never content) for
//     anything this cannot clean.
//     The result is saved, loaded again and scanned (postScan) before it goes back.
//     Every image stream (any stream declaring a /Width or /Height, whatever
//     its /Subtype) is size-capped, and the page tree is walked once under a
//     bound (checkPageTree()) before the pages are listed.
//   { kind: "merge", bytes, inserts, modules, limits }
//     -> { ok: true, pdf, pages, inserted, placement } | { ok: false, reason }
//     The rendered invoice with each receipt's clean pages (prepare's output)
//     inserted after its sheet, labelled "Receipt N of M - page x of y"; at most
//     limits.invoiceMaxPages copied pages, limits.insertMax bytes of receipts
//     and limits.mergeOutputMax bytes out. The written file is loaded again and
//     re-checked (mergeRecheck()): no inserted page has annotations or actions,
//     and the catalog has no open action, JavaScript or attached files.
//   { kind: "selftest", bytes, modules, limits, probes }
//     -> { ok: true, identity, hook, result }
//     Who this process runs as and what it can reach (uid, gid, groups, whether
//     the probe paths are readable: yes/no only, nothing is read), whether the
//     decode cap is in place, and the prepare result for the built-in fixture.
//
// Decode caps: every decoded stream (object streams at load, page contents at
// embed, the streams scanned here) grows through pdf-lib's
// DecodeStream.prototype.ensureBuffer (pdf-lib 1.17.1). The wrapper below
// refuses a buffer over limits.decodeStreamMax and a job whose decoded buffers
// add up to more than limits.decodeTotalMax. A job runs only when the wrapper
// is in place (hookInstalled()).

const HOOK_MARK = Symbol.for("logisx.receiptPdf.decodeCap");

class ReceiptRefusal extends Error {
	constructor(reason) {
		super(reason);
		this.reason = reason;
	}
}
const refuse = (reason) => { throw new ReceiptRefusal(reason); };

// The one job this process runs: its caps and how much it has decoded.
let job = null;

// ---------------------------------------------------------------------------
// Decode and object caps (pdf-lib internals, as in pdf-lib 1.17.1: package.json
// pins that exact version, and lib/receipt-pdf.js refuses to start this child
// with any other, so the self-test fails and pages stay off).

function installDecodeCap(DecodeStream) {
	const proto = DecodeStream && DecodeStream.prototype;
	if (!proto || typeof proto.ensureBuffer !== "function") return false;
	if (proto.ensureBuffer[HOOK_MARK]) return true;
	const original = proto.ensureBuffer;
	const capped = function ensureBuffer(requested) {
		const cap = job;
		if (!cap) throw new ReceiptRefusal("decode_outside_job");
		const want = Number(requested);
		if (!(want >= 0) || want > cap.limits.decodeStreamMax) {
			cap.tripped = cap.tripped || "decode_cap";
			throw new ReceiptRefusal("decode_cap");
		}
		const have = this.buffer ? this.buffer.byteLength : 0;
		if (want > have) {
			// pdf-lib 1.17.1 grows to the first power of two over minBufferLength
			// that holds the request; count what it will allocate before it does.
			let size = this.minBufferLength > 0 ? this.minBufferLength : 512;
			while (size < want) size *= 2;
			if (size > cap.limits.decodeStreamMax) size = want;
			if (cap.decoded + (size - have) > cap.limits.decodeTotalMax) {
				cap.tripped = cap.tripped || "decode_total_cap";
				throw new ReceiptRefusal("decode_total_cap");
			}
			cap.decoded += size - have;
		}
		return original.call(this, requested);
	};
	capped[HOOK_MARK] = true;
	proto.ensureBuffer = capped;
	return true;
}

// The wrapper is there and refuses an over-cap buffer.
function hookInstalled(DecodeStream) {
	const proto = DecodeStream && DecodeStream.prototype;
	if (!proto || typeof proto.ensureBuffer !== "function" || !proto.ensureBuffer[HOOK_MARK]) return false;
	const saved = job;
	job = { limits: { decodeStreamMax: 1024, decodeTotalMax: 1024 }, decoded: 0, tripped: null };
	try {
		const probe = Object.create(proto);
		probe.buffer = new Uint8Array(0);
		probe.minBufferLength = 512;
		probe.ensureBuffer(4096);
		return false;
	} catch (err) {
		return err instanceof ReceiptRefusal && err.reason === "decode_cap";
	} finally {
		job = saved;
	}
}

// Counts the indirect objects a load creates and stops at the cap, so a file
// (or an object stream) naming millions of objects is refused, not built.
function installObjectCap(PDFContext) {
	const proto = PDFContext && PDFContext.prototype;
	if (!proto || typeof proto.assign !== "function") return false;
	if (proto.assign[HOOK_MARK]) return true;
	const original = proto.assign;
	const capped = function assign(ref, object) {
		const cap = job;
		if (cap && cap.loading && this.indirectObjects && !this.indirectObjects.has(ref)) {
			cap.objects += 1;
			if (cap.objects > cap.limits.maxObjects) {
				cap.tripped = cap.tripped || "too_many_objects";
				throw new ReceiptRefusal("too_many_objects");
			}
		}
		return original.call(this, ref, object);
	};
	capped[HOOK_MARK] = true;
	proto.assign = capped;
	return true;
}

// ---------------------------------------------------------------------------
// Names. pdf-lib decodes a "#xx" escape in a name only when the hex is upper
// case; "#6e" stays as the literal characters, and pdf-lib writes that '#' as
// "#23", so a viewer reads from the output exactly the name pdf-lib holds.
// plainName() is that name (asString() with pdf-lib's own escapes undone);
// every key and value comparison here uses it.

const NAME_ESCAPE_RE = /#([0-9a-fA-F]{2})/g;
function plainName(name) {
	const raw = name && typeof name.asString === "function" ? name.asString().slice(1) : String(name || "");
	return raw.replace(NAME_ESCAPE_RE, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Keys deleted from every object the copied resources reach.
const STRIP_KEYS = new Set([
	"Metadata", "PieceInfo", "LastModified", "OPI", "Alternates", "OC", "A", "AA", "JS", "URI",
	// Location and attached files (PDF 2.0): geospatial measure, point data,
	// associated files.
	"Measure", "PtData", "AF",
]);

// The page keys kept on a source page before it is drawn; every other key
// (annotations, actions, thumbnails, metadata, article beads, transitions ...)
// is deleted. Parent stays so the inherited boxes resolve.
const PAGE_KEYS = new Set(["Type", "Parent", "Contents", "Resources", "MediaBox", "CropBox", "Rotate"]);

// Stream filters a receipt may use; anything else (JPX, JBIG2, Crypt, unknown
// or mis-spelt) refuses the receipt. Short forms are the inline-image names.
const FILTERS = new Map([
	["FlateDecode", "flate"], ["Fl", "flate"],
	["LZWDecode", "lzw"], ["LZW", "lzw"],
	["ASCII85Decode", "a85"], ["A85", "a85"],
	["ASCIIHexDecode", "ahx"], ["AHx", "ahx"],
	["RunLengthDecode", "rl"], ["RL", "rl"],
	["CCITTFaxDecode", "ccitt"], ["CCF", "ccitt"],
	["DCTDecode", "dct"], ["DCT", "dct"],
]);
const DECODABLE = new Set(["flate", "lzw", "a85", "ahx", "rl"]);
const REFUSED_CODECS = new Set(["jpxdecode", "jpx", "jbig2decode", "jbig2"]);

// The post-scan refuses any of these as a key anywhere in the output ...
const SCAN_KEYS = new Set([
	"JavaScript", "JS", "OpenAction", "AA", "A", "URI", "Launch", "SubmitForm", "ImportData",
	"GoToR", "GoToE", "EmbeddedFile", "EmbeddedFiles", "RichMedia", "AcroForm", "XFA", "Annots",
	"Metadata", "PieceInfo", "Ref", "OPI", "AF", "EF", "Measure", "PtData",
]);
// ... and any of these as the value of /S, /Type, /Subtype or /Filter.
const SCAN_VALUES = new Set([
	"JavaScript", "Launch", "SubmitForm", "ImportData", "GoToR", "GoToE", "EmbeddedFile",
	"RichMedia", "URI", "JPXDecode", "JBIG2Decode", "Filespec", "PS",
]);
const SCAN_VALUE_KEYS = new Set(["S", "Type", "Subtype", "Filter"]);

// ---------------------------------------------------------------------------

function loadModules(modules) {
	const lib = require(modules.pdfLib);
	const DecodeStream = require(modules.decodeStream).default;
	const { stripImageMetadata } = require(modules.imageMetadata);
	return { lib, DecodeStream, stripImageMetadata };
}

function filtersOf(lib, dict) {
	const { PDFName, PDFArray } = lib;
	const f = dict.lookup(PDFName.of("Filter"));
	if (f === undefined) return [];
	const list = f instanceof PDFName ? [f] : f instanceof PDFArray ? f.asArray().map((x) => dict.context.lookup(x)) : null;
	if (!list) refuse("filter");
	return list.map((n) => {
		if (!(n instanceof PDFName)) refuse("filter");
		const plain = plainName(n);
		if (REFUSED_CODECS.has(plain.toLowerCase())) refuse("image_codec");
		const kind = FILTERS.get(plain);
		if (!kind) refuse("filter");
		return kind;
	});
}

// /DecodeParms for filter i of a stream, or undefined.
function decodeParmsAt(lib, dict, i, count) {
	const { PDFName, PDFArray, PDFDict } = lib;
	const p = dict.lookup(PDFName.of("DecodeParms"));
	if (p === undefined || p === null) return undefined;
	if (p instanceof PDFArray) {
		const v = i < p.size() ? dict.context.lookup(p.get(i)) : undefined;
		return v instanceof PDFDict ? v : undefined;
	}
	if (p instanceof PDFDict) return count === 1 || i === 0 ? p : undefined;
	return undefined;
}

// pdf-lib's decoder ignores predictors; a stream that needs one is refused
// wherever this process has to read it.
function hasPredictor(lib, dict, count) {
	const { PDFName, PDFNumber } = lib;
	for (let i = 0; i < count; i++) {
		const parms = decodeParmsAt(lib, dict, i, count);
		const pred = parms && parms.lookup(PDFName.of("Predictor"));
		if (pred instanceof PDFNumber && pred.asNumber() > 1) return true;
		if (pred !== undefined && !(pred instanceof PDFNumber)) return true;
	}
	return false;
}

// The decoded bytes of a stream whose filters are all decodable here.
function decodeStreamBytes(lib, stream, filterKinds) {
	if (filterKinds.some((k) => !DECODABLE.has(k))) refuse("content_filter");
	if (hasPredictor(lib, stream.dict, filterKinds.length)) refuse("predictor");
	if (filterKinds.length === 0) return stream.contents;
	try {
		return lib.decodePDFRawStream(stream).decode();
	} catch (err) {
		if (err instanceof ReceiptRefusal) throw err;
		return refuse("content_decode");
	}
}

// Inline images: a content stream that opens one (BI) and names a JPEG, JPX or
// JBIG2 filter anywhere is refused. Inline Flate and other lossless images
// carry no metadata and stay. Bounded patterns only.
const DELIM = "\\x00\\t\\n\\f\\r ()<>\\[\\]{}/%";
const BI_RE = new RegExp(`(?:^|[${DELIM}])BI(?=[${DELIM}]|$)`);
const NAME_RE = new RegExp(`/([^${DELIM}]{1,127})`, "g");
const INLINE_REFUSED = new Set(["dct", "dctdecode", "jpx", "jpxdecode", "jbig2", "jbig2decode"]);

function inlineImageRefused(bytes) {
	const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
	if (!BI_RE.test(text)) return false;
	NAME_RE.lastIndex = 0;
	let m;
	while ((m = NAME_RE.exec(text)) !== null) {
		const name = m[1].replace(NAME_ESCAPE_RE, (_, hex) => String.fromCharCode(parseInt(hex, 16))).toLowerCase();
		if (INLINE_REFUSED.has(name)) return true;
	}
	return false;
}

// A JPEG left with only its JFIF APP0, ICC APP2 and Adobe APP14 segments: no
// APP1 (EXIF with GPS, XMP, orientation), APP13 (IPTC), other APPn, comment or
// bytes after the end.
function cleanJpeg(stripImageMetadata, bytes) {
	const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const stripped = stripImageMetadata(buf);
	if (!stripped.ok || stripped.type !== "jpeg") return null;
	// stripImageMetadata keeps the orientation as a new APP1; a PDF viewer
	// ignores EXIF orientation, so here it goes too.
	const out = dropApp1(stripped.buf);
	const check = out && stripImageMetadata(out);
	if (!check || !check.ok || check.removed.length !== 0 || check.orientation !== 1) return null;
	return out;
}

// Removes APP1 segments ahead of the first scan (where stripImageMetadata
// writes its orientation block); null when the header cannot be walked.
function dropApp1(buf) {
	if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
	const parts = [buf.subarray(0, 2)];
	let i = 2;
	while (i + 4 <= buf.length) {
		if (buf[i] !== 0xFF) return null;
		const marker = buf[i + 1];
		if (marker === 0xDA || marker === 0xD9) { parts.push(buf.subarray(i)); return Buffer.concat(parts); }
		if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { parts.push(buf.subarray(i, i + 2)); i += 2; continue; }
		const len = buf.readUInt16BE(i + 2);
		if (len < 2 || i + 2 + len > buf.length) return null;
		if (marker !== 0xE1) parts.push(buf.subarray(i, i + 2 + len));
		i += 2 + len;
	}
	return null;
}

// ---------------------------------------------------------------------------
// The cleaning walk over everything a page's resources reach.

function cleanResources(ctx, lib, stripImageMetadata, roots, contentRefs) {
	const { PDFDict, PDFArray, PDFRef, PDFName, PDFNumber, PDFRawStream, PDFStream } = lib;
	const context = ctx.context;
	const seen = new Set();
	const stack = roots.slice();
	let visits = 0;
	const markContent = (value) => {
		if (value instanceof PDFRef) contentRefs.add(value);
		else if (value instanceof PDFStream) refuse("direct_stream");
	};
	while (stack.length) {
		const item = stack.pop();
		if (++visits > ctx.limits.maxWalk) refuse("resource_graph");
		let obj = item;
		let ref = null;
		if (item instanceof PDFRef) {
			if (seen.has(item)) continue;
			seen.add(item);
			ref = item;
			obj = context.lookup(item);
			if (obj === undefined) continue;
			// An object that is only a reference to another object is refused.
			if (obj instanceof PDFRef) refuse("resource_graph");
		} else if (seen.has(item)) {
			continue;
		} else if (item instanceof PDFDict || item instanceof PDFArray || item instanceof PDFStream) {
			seen.add(item);
		}
		if (obj instanceof PDFArray) {
			for (const v of obj.asArray()) stack.push(v);
			continue;
		}
		if (obj instanceof PDFStream) {
			if (!(obj instanceof PDFRawStream) || !ref) refuse("direct_stream");
			obj = cleanStream(ctx, lib, stripImageMetadata, ref, obj);
			stack.push(obj.dict);
			continue;
		}
		if (!(obj instanceof PDFDict)) continue;
		const type = obj.lookup(PDFName.of("Type"));
		if (type instanceof PDFName && ["Catalog", "Pages", "Page", "Annot"].includes(plainName(type))) refuse("resource_graph");
		for (const key of obj.keys()) {
			if (STRIP_KEYS.has(plainName(key))) obj.delete(key);
		}
		for (const [key, value] of obj.entries()) {
			const k = plainName(key);
			const target = value instanceof PDFRef ? context.lookup(value) : value;
			if (k === "XObject" && target instanceof PDFDict) {
				for (const [name, xo] of target.entries()) {
					const s = xo instanceof PDFRef ? context.lookup(xo) : xo;
					if (s instanceof PDFRef) refuse("resource_graph");
					if (s instanceof PDFStream) {
						const sub = s.dict.lookup(PDFName.of("Subtype"));
						const subName = sub instanceof PDFName ? plainName(sub) : "";
						if (subName === "PS" || s.dict.keys().some((kk) => plainName(kk) === "Ref")) {
							target.delete(name);
							continue;
						}
						if (subName !== "Image") markContent(xo);
					}
				}
			} else if (k === "CharProcs" && target instanceof PDFDict) {
				for (const [, proc] of target.entries()) markContent(proc);
			} else if (k === "Pattern" && target instanceof PDFDict) {
				for (const [, pat] of target.entries()) {
					const s = pat instanceof PDFRef ? context.lookup(pat) : pat;
					if (s instanceof PDFRef) refuse("resource_graph");
					if (s instanceof PDFStream) markContent(pat);
				}
			} else if (k === "SMask" && target instanceof PDFDict) {
				const g = target.get(PDFName.of("G"));
				if (g !== undefined) markContent(g);
			}
			if (value instanceof PDFNumber || value instanceof PDFName) continue;
			stack.push(value);
		}
	}
}

// Checks one stream reached from the resources and returns the stream now
// stored under its ref (a JPEG is replaced by its cleaned copy).
function cleanStream(ctx, lib, stripImageMetadata, ref, stream) {
	const { PDFName, PDFNumber, PDFRawStream } = lib;
	const dict = stream.dict;
	for (const key of dict.keys()) {
		const k = plainName(key);
		if (k === "F" || k === "FFilter" || k === "FDecodeParms") refuse("external_stream");
	}
	// Every image stream must declare a size within the pixel cap: one whose
	// /Subtype is /Image, and any stream that declares a /Width or a /Height
	// whatever its /Subtype says (soft masks need none), each named once.
	const declared = { Width: [], Height: [] };
	for (const [key, value] of dict.entries()) {
		const k = plainName(key);
		if (k === "Width" || k === "Height") declared[k].push(dict.context.lookup(value));
	}
	const subtype = dict.lookup(PDFName.of("Subtype"));
	const isImage = subtype instanceof PDFName && plainName(subtype) === "Image";
	if (isImage || declared.Width.length || declared.Height.length) {
		const [w, h] = [declared.Width, declared.Height].map((list) => (list.length === 1 && list[0] instanceof PDFNumber ? list[0].asNumber() : NaN));
		if (!(w >= 1 && h >= 1 && w * h <= ctx.limits.maxImagePixels)) refuse("image_size");
	}
	const kinds = filtersOf(lib, dict);
	const dctAt = kinds.indexOf("dct");
	if (dctAt === -1) return stream;
	if (dctAt !== kinds.length - 1 || kinds.filter((k) => k === "dct").length !== 1) refuse("image_filter_chain");
	let jpegBytes = stream.contents;
	const parms = decodeParmsAt(lib, dict, dctAt, kinds.length);
	if (dctAt > 0) {
		// [... /DCTDecode]: decode the filters ahead of the JPEG under the caps.
		const head = kinds.slice(0, dctAt);
		if (head.some((k) => !DECODABLE.has(k))) refuse("image_filter_chain");
		if (hasPredictor(lib, dict, dctAt)) refuse("image_filter_chain");
		const filterArray = dict.lookup(PDFName.of("Filter"));
		const headDict = dict.context.obj({});
		headDict.set(PDFName.of("Filter"), dict.context.obj(filterArray.asArray().slice(0, dctAt)));
		const parmsAll = dict.lookup(PDFName.of("DecodeParms"));
		if (parmsAll !== undefined && typeof parmsAll.asArray === "function") {
			headDict.set(PDFName.of("DecodeParms"), dict.context.obj(parmsAll.asArray().slice(0, dctAt)));
		}
		try {
			jpegBytes = lib.decodePDFRawStream({ dict: headDict, contents: stream.contents }).decode();
		} catch (err) {
			if (err instanceof ReceiptRefusal) throw err;
			refuse("image_filter_chain");
		}
	}
	const clean = cleanJpeg(stripImageMetadata, jpegBytes);
	if (!clean) refuse("image_metadata");
	const newDict = dict.clone(dict.context);
	newDict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
	newDict.delete(PDFName.of("DecodeParms"));
	if (parms) newDict.set(PDFName.of("DecodeParms"), parms);
	newDict.delete(PDFName.of("Length"));
	const replaced = PDFRawStream.of(newDict, new Uint8Array(clean.buffer, clean.byteOffset, clean.byteLength));
	dict.context.assign(ref, replaced);
	ctx.jpegs += 1;
	return replaced;
}

// ---------------------------------------------------------------------------
// The post-scan: every indirect object of the output, orphans included.

function postScan(lib, stripImageMetadata, doc, limits) {
	const { PDFDict, PDFArray, PDFName, PDFRef, PDFStream, PDFRawStream } = lib;
	let visits = 0;
	const checkDict = (dict, isStream) => {
		for (const [key, value] of dict.entries()) {
			const k = plainName(key);
			if (SCAN_KEYS.has(k)) return `key:${k}`;
			if (isStream && (k === "F" || k === "FFilter" || k === "FDecodeParms")) return "external_stream";
			if (SCAN_VALUE_KEYS.has(k)) {
				const vals = value instanceof PDFArray ? value.asArray() : [value];
				for (const v of vals) if (v instanceof PDFName && SCAN_VALUES.has(plainName(v))) return `value:${plainName(v)}`;
			}
		}
		return null;
	};
	for (const [, top] of doc.context.enumerateIndirectObjects()) {
		// An object that is only a reference to another object is refused.
		if (top instanceof PDFRef) return "indirect_reference";
		const stack = [top];
		while (stack.length) {
			const obj = stack.pop();
			if (++visits > limits.maxWalk) return "post_scan_size";
			if (obj instanceof PDFStream) {
				if (!(obj instanceof PDFRawStream)) return "post_scan_stream";
				const bad = checkDict(obj.dict, true);
				if (bad) return bad;
				let kinds;
				try { kinds = filtersOf(lib, obj.dict); } catch (err) { return err.reason || "filter"; }
				if (kinds.includes("dct")) {
					if (kinds.length !== 1) return "image_filter_chain";
					const buf = Buffer.from(obj.contents.buffer, obj.contents.byteOffset, obj.contents.byteLength);
					const r = stripImageMetadata(buf);
					if (!r.ok || r.removed.length !== 0 || r.orientation !== 1) return "image_metadata";
				}
				for (const [, v] of obj.dict.entries()) stack.push(v);
			} else if (obj instanceof PDFDict) {
				const bad = checkDict(obj, false);
				if (bad) return bad;
				for (const [, v] of obj.entries()) stack.push(v);
			} else if (obj instanceof PDFArray) {
				for (const v of obj.asArray()) stack.push(v);
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------

const NEWLINE = Uint8Array.of(0x0A);

// The bytes of one content stream as a viewer draws them. pdf-lib's own
// wrapping streams (q / Q, added around a page's content) are taken as they are.
function contentBytes(lib, s, pageLevel) {
	if (pageLevel && s instanceof lib.PDFContentStream) return s.getUnencodedContents();
	if (!(s instanceof lib.PDFRawStream)) refuse("content_stream");
	for (const key of s.dict.keys()) {
		const k = plainName(key);
		if (k === "F" || k === "FFilter" || k === "FDecodeParms") refuse("external_stream");
	}
	return decodeStreamBytes(lib, s, filtersOf(lib, s.dict));
}

// Page content counts toward the job's total whether or not it is compressed.
function countContent(limits, n) {
	job.content += n;
	if (job.decoded + job.content > limits.decodeTotalMax) {
		job.tripped = job.tripped || "decode_total_cap";
		refuse("decode_total_cap");
	}
}

const LETTER = [612, 792];
const MARGIN = 18;            // 0.25 in
const STRIP = 28.8;           // 0.4 in, left empty for the merge's label
const MAX_UPSCALE = 2;
const LOAD_OPTIONS = { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false };

function boxOf(lib, leaf, key) {
	const { PDFName, PDFArray, PDFNumber } = lib;
	const v = leaf.context.lookup(leaf.getInheritableAttribute(PDFName.of(key)));
	if (!(v instanceof PDFArray) || v.size() !== 4) return null;
	const n = v.asArray().map((x) => leaf.context.lookup(x));
	if (!n.every((x) => x instanceof PDFNumber)) return null;
	const [a, b, c, d] = n.map((x) => x.asNumber());
	const box = { left: Math.min(a, c), bottom: Math.min(b, d), right: Math.max(a, c), top: Math.max(b, d) };
	return Object.values(box).every(Number.isFinite) ? box : null;
}

// The page tree, walked once under a bound before pdf-lib lists the pages (its
// own walk follows every /Kids entry with no memory of where it has been): each
// node an indirect object reached once (a cycle or a shared node is refused),
// at most limits.maxPageTreeNodes nodes and maxLeaves pages.
function checkPageTree(lib, doc, limits, maxLeaves) {
	const { PDFArray, PDFName, PDFRef, PDFPageTree, PDFPageLeaf } = lib;
	const seen = new Set();
	const stack = [doc.catalog.get(PDFName.of("Pages"))];
	let leaves = 0;
	while (stack.length) {
		const ref = stack.pop();
		if (!(ref instanceof PDFRef) || seen.has(ref)) refuse("page_tree");
		seen.add(ref);
		if (seen.size > limits.maxPageTreeNodes) refuse("page_tree");
		const node = doc.context.lookup(ref);
		if (node instanceof PDFPageLeaf) {
			leaves += 1;
			if (leaves > maxLeaves) refuse("too_many_source_pages");
			continue;
		}
		if (!(node instanceof PDFPageTree)) refuse("page_tree");
		const kids = node.lookup(PDFName.of("Kids"));
		if (!(kids instanceof PDFArray) || kids.size() > limits.maxPageTreeNodes) refuse("page_tree");
		for (let i = kids.size() - 1; i >= 0; i--) stack.push(kids.get(i));
	}
	return leaves;
}

async function prepare(modules, bytes, limits) {
	const { lib, stripImageMetadata } = modules;
	const { PDFDocument, PDFName, PDFNumber, PDFObjectCopier, ParseSpeeds } = lib;
	const ops = lib;

	job.loading = true;
	let src;
	try {
		src = await PDFDocument.load(bytes, { ...LOAD_OPTIONS, parseSpeed: ParseSpeeds.Fastest });
	} catch (err) {
		if (job.tripped) refuse(job.tripped);
		// pdf-lib's EncryptedPDFError is compiled to ES5 and fails instanceof.
		if (err && /\bis encrypted\b/.test(String(err.message).slice(0, 200))) refuse("encrypted");
		if (err instanceof RangeError) refuse("nesting");
		refuse("unparseable");
	} finally {
		job.loading = false;
	}
	if (job.tripped) refuse(job.tripped);
	if (src.context.enumerateIndirectObjects().length > limits.maxObjects) refuse("too_many_objects");

	checkPageTree(lib, src, limits, limits.maxSourcePages);
	const pages = src.getPages();
	if (pages.length === 0) refuse("no_pages");
	if (pages.length > limits.maxSourcePages) refuse("too_many_source_pages");
	if (pages.length > limits.maxPages) refuse("too_many_pages");

	const ctx = { context: src.context, limits, jpegs: 0 };
	const out = await PDFDocument.create({ updateMetadata: false });
	const copier = PDFObjectCopier.for(src.context, out.context);

	for (const page of pages) {
		const leaf = page.node;
		const listed = leaf.context.lookup(leaf.get(PDFName.of("Contents")));
		if (listed instanceof lib.PDFRef) refuse("resource_graph");
		if (listed instanceof lib.PDFArray && listed.size() > limits.maxContentStreams) refuse("page_contents");
		leaf.normalize();
		for (const key of leaf.keys()) {
			if (!PAGE_KEYS.has(plainName(key))) leaf.delete(key);
		}
		const media = boxOf(lib, leaf, "MediaBox");
		if (!media) refuse("page_box");
		const crop = boxOf(lib, leaf, "CropBox");
		const box = crop
			? { left: Math.max(media.left, crop.left), bottom: Math.max(media.bottom, crop.bottom), right: Math.min(media.right, crop.right), top: Math.min(media.top, crop.top) }
			: media;
		const w = box.right - box.left;
		const h = box.top - box.bottom;
		if (!(w >= 1 && h >= 1 && w <= 14400 && h <= 14400)) refuse("page_box");
		const rotObj = leaf.context.lookup(leaf.getInheritableAttribute(PDFName.of("Rotate")));
		let rotate = rotObj instanceof PDFNumber ? rotObj.asNumber() : 0;
		rotate = ((Math.round(rotate) % 360) + 360) % 360;
		if (rotate % 90 !== 0) rotate = 0;

		// Clean everything the resources reach, then scan every content stream
		// (the page's own and every form, pattern and glyph procedure) for
		// inline images.
		const contentRefs = new Set();
		const resources = leaf.get(PDFName.of("Resources"));
		cleanResources(ctx, lib, stripImageMetadata, resources === undefined ? [] : [resources], contentRefs);
		const contents = leaf.Contents();
		if (!contents || typeof contents.asArray !== "function") refuse("page_contents");
		// The page's content streams are scanned together, as they are drawn:
		// pdf-lib joins them with a newline. Forms, patterns and glyph procedures
		// are each drawn on their own and are scanned one by one.
		const pageParts = [];
		for (const c of contents.asArray()) {
			const bytes = contentBytes(lib, leaf.context.lookup(c), true);
			countContent(limits, bytes.byteLength + 1);
			pageParts.push(bytes, NEWLINE);
		}
		if (inlineImageRefused(Buffer.concat(pageParts))) refuse("inline_image");
		for (const r of contentRefs) {
			const bytes = contentBytes(lib, leaf.context.lookup(r), false);
			countContent(limits, bytes.byteLength);
			if (inlineImageRefused(bytes)) refuse("inline_image");
		}

		const embedded = await src.embedPage(page, box);
		await embedded.embed();
		const formRef = copier.copy(embedded.ref);

		const outPage = out.addPage(LETTER);
		const availW = LETTER[0] - 2 * MARGIN;
		const availH = LETTER[1] - STRIP - MARGIN;
		const dw = rotate % 180 === 0 ? w : h;
		const dh = rotate % 180 === 0 ? h : w;
		const s = Math.min(availW / dw, availH / dh, MAX_UPSCALE);
		const tx = MARGIN + (availW - dw * s) / 2;
		const ty = MARGIN + availH - dh * s;
		// Clockwise page rotation, as a viewer would show the page.
		const rot = rotate === 90 ? [0, -1, 1, 0, 0, w]
			: rotate === 180 ? [-1, 0, 0, -1, w, h]
			: rotate === 270 ? [0, 1, -1, 0, h, 0]
			: [1, 0, 0, 1, 0, 0];
		const m = [s * rot[0], s * rot[1], s * rot[2], s * rot[3], s * rot[4] + tx, s * rot[5] + ty];
		// The page's XObject dictionary is new and holds only this entry.
		outPage.node.setXObject(PDFName.of("RcptPage"), formRef);
		const name = "RcptPage";
		outPage.pushOperators(
			ops.pushGraphicsState(),
			ops.concatTransformationMatrix(...m),
			ops.drawObject(name),
			ops.popGraphicsState(),
		);
		// pdf-lib adds an empty /Annots to every page it draws on; the output
		// carries none.
		outPage.node.delete(PDFName.of("Annots"));
	}

	const saved = await out.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
	if (saved.byteLength > limits.outputMax) refuse("output_too_large");
	const again = await PDFDocument.load(saved, LOAD_OPTIONS);
	if (again.getPageCount() !== pages.length) refuse("post_scan_pages");
	const bad = postScan(lib, stripImageMetadata, again, limits);
	if (bad) refuse("post_scan");
	return { pdf: saved, pages: pages.length, sourcePages: pages.length };
}

// ---------------------------------------------------------------------------
// The merge: the rendered invoice (Chrome's output) and the receipts' clean
// pages (prepare's output, from the cache), both our own bytes, still loaded
// here under the same caps.

const RECEIPT_ANCHOR_RE = /^receipt-([1-9][0-9]{0,2})$/;
const LABEL_SIZE = 9;

// The text of a PDF string or hex string; "" for anything else.
function textOf(lib, v) {
	return v instanceof lib.PDFString || v instanceof lib.PDFHexString ? v.decodeText() : "";
}

// The page a destination points at: [page ...] or << /D [page ...] >>.
function destPage(lib, context, value) {
	let d = context.lookup(value);
	if (d instanceof lib.PDFDict) d = context.lookup(d.get(lib.PDFName.of("D")));
	if (!(d instanceof lib.PDFArray) || d.size() < 1) return null;
	const page = d.get(0);
	return page instanceof lib.PDFRef ? page : null;
}

// The receipt anchors' named destinations, Map(anchor -> page ref), from the
// catalog's /Dests dictionary and its /Names /Dests name tree (walked under a
// bound). Only "receipt-N" names are read.
function receiptDestinations(lib, doc, limits) {
	const { PDFDict, PDFArray, PDFName, PDFRef } = lib;
	const context = doc.context;
	const out = new Map();
	const dests = doc.catalog.lookup(PDFName.of("Dests"));
	if (dests instanceof PDFDict) {
		for (const [key, value] of dests.entries()) {
			const name = plainName(key);
			if (RECEIPT_ANCHOR_RE.test(name)) {
				const page = destPage(lib, context, value);
				if (page) out.set(name, page);
			}
		}
	}
	const names = doc.catalog.lookup(PDFName.of("Names"));
	const tree = names instanceof PDFDict ? names.get(PDFName.of("Dests")) : undefined;
	const seen = new Set();
	const stack = tree === undefined ? [] : [tree];
	while (stack.length) {
		const item = stack.pop();
		if (item instanceof PDFRef) {
			if (seen.has(item)) continue;
			seen.add(item);
		}
		if (seen.size > limits.maxPageTreeNodes || ++job.walk > limits.maxWalk) refuse("merge_destinations");
		const node = context.lookup(item);
		if (!(node instanceof PDFDict)) continue;
		const pairs = node.lookup(PDFName.of("Names"));
		if (pairs instanceof PDFArray) {
			for (let i = 0; i + 1 < pairs.size(); i += 2) {
				const name = textOf(lib, context.lookup(pairs.get(i)));
				if (RECEIPT_ANCHOR_RE.test(name) && !out.has(name)) {
					const page = destPage(lib, context, pairs.get(i + 1));
					if (page) out.set(name, page);
				}
			}
		}
		const kids = node.lookup(PDFName.of("Kids"));
		if (kids instanceof PDFArray) for (const k of kids.asArray()) stack.push(k);
	}
	return out;
}

// The final re-check, on the merged file as it was written: no inserted page
// carries annotations or actions, and the catalog no open action, catalog
// action, JavaScript or attached files. The reason, or null.
function mergeRecheck(lib, doc, insertedIndices) {
	const { PDFDict, PDFName } = lib;
	const pages = doc.getPages();
	for (const i of insertedIndices) {
		const node = pages[i] && pages[i].node;
		if (!(node instanceof PDFDict)) return "merge_recheck";
		if (node.keys().some((k) => ["Annots", "AA"].includes(plainName(k)))) return "merge_recheck";
	}
	if (doc.catalog.keys().some((k) => ["OpenAction", "AA"].includes(plainName(k)))) return "merge_recheck";
	const names = doc.catalog.lookup(PDFName.of("Names"));
	if (names instanceof PDFDict && names.keys().some((k) => ["JavaScript", "EmbeddedFiles"].includes(plainName(k)))) return "merge_recheck";
	return null;
}

// inserts: [{ anchor: "receipt-N", index: N, total: M, pdf }] (M receipt sheets
// on the invoice, images included). Each receipt's pages go right after its
// sheet: found by its named destination; else, when the invoice has more
// pages than sheets, the sheets are its last M pages; else at the end. Each
// copied page gets "Receipt N of M - page x of y" in the strip prepare left.
async function merge(modules, bytes, inserts, limits) {
	const { lib } = modules;
	const { PDFDocument, PDFName, PDFArray, StandardFonts, rgb, ParseSpeeds } = lib;
	const list = Array.isArray(inserts) ? inserts : [];
	if (!list.length || list.length > limits.mergeMaxInserts) refuse("merge_inserts");
	const anchors = new Set();
	let insertBytes = 0;
	for (const ins of list) {
		const m = ins && RECEIPT_ANCHOR_RE.exec(String(ins.anchor || ""));
		if (!m || Number(m[1]) !== ins.index || !Number.isInteger(ins.total) || ins.index > ins.total
			|| ins.total !== list[0].total || ins.total > limits.mergeMaxInserts || anchors.has(ins.anchor)
			|| !(ins.pdf instanceof Uint8Array)) refuse("merge_inserts");
		anchors.add(ins.anchor);
		insertBytes += ins.pdf.byteLength;
	}
	if (insertBytes > limits.insertMax) refuse("merge_size_cap");

	job.limits = { ...limits, maxObjects: limits.mergeMaxObjects };
	const load = async (input) => {
		let loaded = null;
		job.loading = true;
		try {
			loaded = await PDFDocument.load(input, { ...LOAD_OPTIONS, parseSpeed: ParseSpeeds.Fastest });
		} catch {
			if (job.tripped) refuse(job.tripped);
			refuse("merge_unparseable");
		} finally {
			job.loading = false;
		}
		if (!(loaded.catalog instanceof lib.PDFDict)) refuse("merge_unparseable");
		return loaded;
	};
	const doc = await load(bytes);
	const sheetCount = checkPageTree(lib, doc, limits, limits.mergeMaxSourcePages);
	const receipts = [];
	let copiedPages = 0;
	for (const ins of list) {
		const src = await load(ins.pdf);
		const n = checkPageTree(lib, src, limits, limits.maxPages);
		if (n < 1) refuse("merge_inserts");
		copiedPages += n;
		receipts.push({ ins, src, n });
	}
	if (job.tripped) refuse(job.tripped);
	if (copiedPages > limits.invoiceMaxPages) refuse("merge_page_cap");

	const pageRefs = doc.getPages().map((p) => p.ref);
	if (pageRefs.length !== sheetCount) refuse("merge_unparseable");
	const total = list[0].total;
	const named = receiptDestinations(lib, doc, limits);
	let placement = "named";
	const after = new Map();
	for (const { ins } of receipts) {
		const at = named.has(ins.anchor) ? pageRefs.indexOf(named.get(ins.anchor)) : -1;
		if (at < 0 || [...after.values()].includes(at)) { placement = null; break; }
		after.set(ins.anchor, at);
	}
	if (!placement) {
		placement = pageRefs.length > total ? "last" : "end";
		for (const { ins } of receipts) after.set(ins.anchor, placement === "last" ? pageRefs.length - total + ins.index - 1 : pageRefs.length - 1);
	}

	const font = await doc.embedFont(StandardFonts.Helvetica);
	// Last sheet first, so an earlier sheet's position never moves; for one
	// position (all at the end) the higher receipt number first, so they end up
	// in order.
	const order = receipts.slice().sort((a, b) => after.get(b.ins.anchor) - after.get(a.ins.anchor) || b.ins.index - a.ins.index);
	const insertedRefs = new Set();
	for (const { ins, src, n } of order) {
		const copied = await doc.copyPages(src, src.getPageIndices());
		copied.forEach((page, k) => {
			if (page.node.keys().some((key) => ["Annots", "AA"].includes(plainName(key)))) refuse("merge_recheck");
			doc.insertPage(after.get(ins.anchor) + 1 + k, page);
			page.drawText(`Receipt ${ins.index} of ${ins.total} - page ${k + 1} of ${n}`, {
				x: MARGIN, y: LETTER[1] - STRIP + 10, size: LABEL_SIZE, font, color: rgb(0.2, 0.2, 0.2),
			});
			// Drawing may add an empty /Annots; anything else stays for the re-check.
			const annots = page.node.lookup(PDFName.of("Annots"));
			if (annots instanceof PDFArray && annots.size() === 0) page.node.delete(PDFName.of("Annots"));
			insertedRefs.add(page.ref);
		});
	}
	const insertedIndices = doc.getPages().map((p, i) => (insertedRefs.has(p.ref) ? i : -1)).filter((i) => i >= 0);
	const saved = await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
	if (saved.byteLength > limits.mergeOutputMax) refuse("merge_too_large");
	const again = await load(saved);
	const pages = again.getPageCount();
	if (pages !== pageRefs.length + copiedPages || insertedIndices.length !== copiedPages) refuse("merge_recheck");
	const bad = mergeRecheck(lib, again, insertedIndices);
	if (bad) refuse(bad);
	return { pdf: saved, pages, inserted: copiedPages, placement };
}

// Who this process is and what it can reach. Probe paths are tested for read
// access only (yes/no, or "unset" when none is given); nothing is opened or read.
function identity(probes) {
	const fs = require("fs");
	const readable = (p) => {
		if (typeof p !== "string" || !p) return "unset";
		try { fs.accessSync(p, fs.constants.R_OK); return "yes"; } catch { return "no"; }
	};
	const perm = process.permission;
	let permission = "off";
	if (perm && typeof perm.has === "function") {
		permission = !perm.has("child") && !perm.has("worker") && !perm.has("fs.write") ? "on" : "partial";
	}
	return {
		uid: typeof process.getuid === "function" ? process.getuid() : -1,
		gid: typeof process.getgid === "function" ? process.getgid() : -1,
		groups: typeof process.getgroups === "function" ? process.getgroups().slice(0, 64) : [],
		env: readable(probes && probes.env),
		db: readable(probes && probes.db),
		permission,
	};
}

const DEFAULT_LIMITS = Object.freeze({
	decodeStreamMax: 8 * 1024 * 1024,
	decodeTotalMax: 32 * 1024 * 1024,
	maxObjects: 10_000,
	maxSourcePages: 50,
	maxPages: 6,
	outputMax: 5 * 1024 * 1024,
	maxWalk: 500_000,
	maxContentStreams: 256,
	maxImagePixels: 40_000_000,
	maxPageTreeNodes: 512,
	invoiceMaxPages: 15,
	insertMax: 5 * 1024 * 1024,
	mergeOutputMax: 20 * 1024 * 1024,
	mergeMaxObjects: 100_000,
	mergeMaxSourcePages: 200,
	mergeMaxInserts: 10,
});

function limitsFrom(given) {
	const out = { ...DEFAULT_LIMITS };
	for (const k of Object.keys(DEFAULT_LIMITS)) {
		const v = given && given[k];
		if (Number.isInteger(v) && v > 0) out[k] = v;
	}
	return out;
}

async function runJob(message) {
	const limits = limitsFrom(message && message.limits);
	job = { limits, decoded: 0, content: 0, objects: 0, walk: 0, loading: false, tripped: null };
	let modules;
	try {
		modules = loadModules(message.modules);
	} catch {
		return { ok: false, reason: "modules" };
	}
	const hook = installDecodeCap(modules.DecodeStream) && installObjectCap(modules.lib.PDFContext) && hookInstalled(modules.DecodeStream);
	const bytes = message.bytes instanceof Uint8Array ? message.bytes : null;
	const run = async () => {
		if (!hook) return { ok: false, reason: "decode_hook" };
		if (!bytes) return { ok: false, reason: "no_bytes" };
		try {
			const r = message.kind === "merge"
				? await merge(modules, bytes, message.inserts, limits)
				: await prepare(modules, bytes, limits);
			return { ok: true, ...r };
		} catch (err) {
			if (err instanceof ReceiptRefusal) return { ok: false, reason: job.tripped || err.reason };
			if (job.tripped) return { ok: false, reason: job.tripped };
			if (err instanceof RangeError) return { ok: false, reason: "nesting" };
			return { ok: false, reason: "error" };
		}
	};
	if (message.kind === "selftest") {
		const id = identity(message.probes);
		const result = await run();
		return { ok: true, identity: id, hook, result };
	}
	if (message.kind === "prepare" || message.kind === "merge") return run();
	return { ok: false, reason: "kind" };
}

let replied = false;
function reply(message) {
	if (replied) return;
	replied = true;
	try {
		process.send(message, () => process.exit(0));
	} catch {
		process.exit(1);
	}
}

if (require.main === module) {
	process.once("message", (message) => {
		runJob(message).then(reply, () => reply({ ok: false, reason: "error" }));
	});
	// The server went away (restart, deploy): nobody is waiting for an answer.
	process.on("disconnect", () => process.exit(0));
}

// For the runner: the pure checks, run on made-up input.
module.exports = { inlineImageRefused, plainName, cleanJpeg, postScan, mergeRecheck, installDecodeCap, hookInstalled, STRIP_KEYS, SCAN_KEYS, DEFAULT_LIMITS };
