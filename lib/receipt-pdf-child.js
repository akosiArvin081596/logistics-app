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
//   { kind: "prepare", bytes, modules, limits, allowPages }
//     -> { ok: true, pdf, pages, sourcePages } | { ok: false, reason }
//     A stored PDF receipt becomes a new PDF of at most limits.maxPages Letter
//     pages, each holding one source page drawn as a Form XObject under an empty
//     0.4 in strip (the merge writes "Receipt N of M - page x of y" there). The
//     source catalog, trailer, Info, ID, outlines, forms, names and every page
//     key but its boxes, contents, resources and rotation are never copied.
//     allowPages (1-based, driver privacy): only those pages are copied. Each
//     copied page's resources, and those of every form, soft mask group,
//     tiling pattern and Type3 font it draws, are cut down to what their
//     content uses (a resource dictionary the pages share would otherwise
//     carry every page's images and forms along), and the job is refused
//     (page_isolation) if the copy holds a page's content, an image, a form, a
//     pattern or a Type3 font (or glyph) that no copied page draws.
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
//     -> { ok: true, pdf, pages, inserted, placement, positions } | { ok: false, reason }
//     The rendered invoice with each receipt's clean pages (prepare's output)
//     inserted after its sheet, labelled "Receipt N of M - page x of y"; at most
//     limits.invoiceMaxPages copied pages, limits.insertMax bytes of receipts
//     and limits.mergeOutputMax bytes out. Each receipt's pages are scanned
//     again (postScan) before they are copied. The written file is loaded again and
//     re-checked (mergeRecheck()): no inserted page has annotations or actions,
//     and the catalog has no open action, JavaScript or attached files.
//     positions: [{ anchor, sheet, at }] (0-based page indexes of each
//     receipt's sheet and of its copied pages in the result).
//   { kind: "text", bytes, scope, modules, limits }
//     -> { ok: true, pageCount, pages: [{ text, unmapped, truncated }] } | { ok: false, reason }
//     Each page's text, as lines in reading order (top to bottom, left to
//     right), from its content streams and the forms they draw, under the same
//     load caps. unmapped: some of the page's text is drawn in a font this
//     cannot map to characters (no ToUnicode map and no known encoding), shown
//     as {hex} codes. scope "receipt" refuses a file of more than
//     limits.maxPages pages (it is never copied); scope "invoice" reads an
//     invoice this server rendered (the pages-only check).
//   { kind: "rebuild", bytes, plan, modules, limits }
//     -> { ok: true, pdf, pages, positions } | { ok: false, reason }
//     The pages-only path (driver privacy D10): a stored invoice keeps every
//     page but plan.remove (its copied receipt pages) as the same objects, not
//     drawn again; what only the removed pages reached is dropped from the file;
//     then each receipt's pages (prepare's output, or a notice page when none is
//     released) go in after its sheet, labelled. A receipt with no sheet (the
//     invoice was drawn before any of its pages was released: "PDF receipt on
//     file") has its pages added at the end, after every other page, labelled
//     with its line; none released, nothing. At most limits.invoiceMaxPages
//     copied pages, notice pages counted apart.
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

// ---------------------------------------------------------------------------
// Content streams, read (driver privacy): a bounded byte scanner, no regular
// expressions. Operands are kept only as far as the operators read here need.

const WS_BYTES = new Uint8Array(256);
for (const b of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS_BYTES[b] = 1;
const DELIM_BYTES = new Uint8Array(256);
for (const b of [0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]) DELIM_BYTES[b] = 1;
const OPERANDS_MAX = 64;
const ARRAY_ITEMS_MAX = 8192;
const ARRAY_DEPTH_MAX = 8;
const INLINE_DICT_TOKENS_MAX = 256;
const CONTENT_OPS_MAX = 2_000_000;
const FORM_DEPTH_MAX = 8;
const FORMS_MAX = 64;
const isRegular = (b) => !WS_BYTES[b] && !DELIM_BYTES[b];

function nameText(buf, a, b) {
	return buf.toString("latin1", a, Math.min(b, a + 127)).replace(NAME_ESCAPE_RE, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// A number token, or null. By hand: a pattern with two digit runs backtracks
// on a long run of digits.
function numberOf(word) {
	if (word.length > 40) return null;
	let digits = 0;
	let dot = false;
	for (let k = word[0] === "+" || word[0] === "-" ? 1 : 0; k < word.length; k++) {
		const ch = word.charCodeAt(k);
		if (ch >= 48 && ch <= 57) digits++;
		else if (ch === 46 && !dot) dot = true;
		else return null;
	}
	return digits ? Number(word) : null;
}

// A literal string from its "(" to the ")" that closes it: { bytes, end }.
function readLiteral(buf, start) {
	const out = Buffer.allocUnsafe(Math.max(0, buf.length - start));
	let o = 0;
	let depth = 1;
	let i = start + 1;
	while (i < buf.length) {
		const c = buf[i];
		if (c === 0x5c) {
			const n = buf[i + 1];
			i += 2;
			if (n === undefined) break;
			if (n === 0x6e) out[o++] = 0x0a;
			else if (n === 0x72) out[o++] = 0x0d;
			else if (n === 0x74) out[o++] = 0x09;
			else if (n === 0x62) out[o++] = 0x08;
			else if (n === 0x66) out[o++] = 0x0c;
			else if (n === 0x0d) { if (buf[i] === 0x0a) i++; }
			else if (n === 0x0a) { /* a line continuation */ }
			else if (n >= 0x30 && n <= 0x37) {
				let v = n - 0x30;
				for (let k = 0; k < 2 && buf[i] >= 0x30 && buf[i] <= 0x37; k++, i++) v = v * 8 + (buf[i] - 0x30);
				out[o++] = v & 0xff;
			} else out[o++] = n;
			continue;
		}
		if (c === 0x28) depth++;
		else if (c === 0x29 && --depth === 0) return { bytes: out.subarray(0, o), end: i + 1 };
		out[o++] = c;
		i++;
	}
	return { bytes: out.subarray(0, o), end: buf.length };
}

function hexNibble(c) {
	if (c >= 0x30 && c <= 0x39) return c - 0x30;
	if (c >= 0x41 && c <= 0x46) return c - 0x37;
	if (c >= 0x61 && c <= 0x66) return c - 0x57;
	return -1;
}

// A hex string from its "<" to its ">": { bytes, end }.
function readHex(buf, start) {
	const out = Buffer.allocUnsafe(Math.max(0, (buf.length - start) >> 1) + 1);
	let o = 0;
	let hi = -1;
	let i = start + 1;
	for (; i < buf.length && buf[i] !== 0x3e; i++) {
		const v = hexNibble(buf[i]);
		if (v < 0) continue;
		if (hi < 0) hi = v;
		else { out[o++] = (hi << 4) | v; hi = -1; }
	}
	if (hi >= 0) out[o++] = hi << 4;
	return { bytes: out.subarray(0, o), end: Math.min(buf.length, i + 1) };
}

// Past a "<< ... >>" (strings inside it skipped whole): the index after it.
function skipDict(buf, start) {
	let depth = 0;
	let i = start;
	while (i < buf.length) {
		const c = buf[i];
		if (c === 0x3c && buf[i + 1] === 0x3c) { depth++; i += 2; continue; }
		if (c === 0x3e && buf[i + 1] === 0x3e) { depth--; i += 2; if (depth <= 0) return i; continue; }
		if (c === 0x28) { i = readLiteral(buf, i).end; continue; }
		if (c === 0x3c) { i = readHex(buf, i).end; continue; }
		i++;
	}
	return buf.length;
}

// From after "BI" past its "EI": the names in its dictionary (a colour space
// may be one) and where the content goes on.
function readInlineImage(buf, start) {
	const names = [];
	let i = start;
	let tokens = 0;
	while (i < buf.length && tokens < INLINE_DICT_TOKENS_MAX) {
		const c = buf[i];
		if (WS_BYTES[c]) { i++; continue; }
		if (c === 0x2f) {
			let j = i + 1;
			while (j < buf.length && isRegular(buf[j])) j++;
			names.push(nameText(buf, i + 1, j));
			i = j;
			tokens++;
			continue;
		}
		if (c === 0x28) { i = readLiteral(buf, i).end; tokens++; continue; }
		if (c === 0x3c) { i = buf[i + 1] === 0x3c ? skipDict(buf, i) : readHex(buf, i).end; tokens++; continue; }
		if (!isRegular(c)) { i++; continue; }
		let j = i;
		while (j < buf.length && isRegular(buf[j])) j++;
		const word = buf.toString("latin1", i, j);
		i = j;
		tokens++;
		if (word === "ID") {
			let k = i + 1;
			for (;;) {
				const at = buf.indexOf("EI", k, "latin1");
				if (at < 0) return { names, end: buf.length };
				if (WS_BYTES[buf[at - 1]] && (at + 2 >= buf.length || WS_BYTES[buf[at + 2]])) return { names, end: at + 2 };
				k = at + 1;
			}
		}
	}
	return { names, end: buf.length };
}

// Calls onOp(operator, operands) for every operator of a content stream.
// budget: { ops } shared by everything one job reads.
function lexContent(buf, onOp, budget) {
	const n = buf.length;
	let i = 0;
	const operands = [];
	const arrays = [];
	const put = (v) => {
		if (arrays.length) {
			const a = arrays[arrays.length - 1];
			if (a.length < ARRAY_ITEMS_MAX) a.push(v);
		} else if (operands.length < OPERANDS_MAX) operands.push(v);
	};
	while (i < n) {
		const c = buf[i];
		if (WS_BYTES[c]) { i++; continue; }
		if (c === 0x25) { while (i < n && buf[i] !== 0x0a && buf[i] !== 0x0d) i++; continue; }
		if (c === 0x2f) {
			let j = i + 1;
			while (j < n && isRegular(buf[j])) j++;
			put({ name: nameText(buf, i + 1, j) });
			i = j;
			continue;
		}
		if (c === 0x28) { const s = readLiteral(buf, i); put({ str: s.bytes }); i = s.end; continue; }
		if (c === 0x3c) {
			if (buf[i + 1] === 0x3c) { i = skipDict(buf, i); put({ dict: true }); continue; }
			const s = readHex(buf, i);
			put({ str: s.bytes });
			i = s.end;
			continue;
		}
		if (c === 0x5b) {
			if (arrays.length >= ARRAY_DEPTH_MAX) refuse("content_nesting");
			arrays.push([]);
			i++;
			continue;
		}
		if (c === 0x5d) { const a = arrays.pop(); if (a) put({ arr: a }); i++; continue; }
		if (!isRegular(c)) { i++; continue; }
		let j = i;
		while (j < n && isRegular(buf[j])) j++;
		const word = buf.toString("latin1", i, Math.min(j, i + 64));
		i = j;
		const num = numberOf(word);
		if (num !== null) { put({ num }); continue; }
		if (word === "true" || word === "false" || word === "null") { put({ kw: word }); continue; }
		if (++budget.ops > CONTENT_OPS_MAX) refuse("content_ops");
		if (word === "BI") {
			const r = readInlineImage(buf, i);
			i = r.end;
			onOp("BI", [{ names: r.names }]);
		} else {
			onOp(word, operands);
		}
		operands.length = 0;
		arrays.length = 0;
	}
}

// ---------------------------------------------------------------------------
// A copied page's resources, cut down to what it draws (driver privacy): a
// resource dictionary several pages share would otherwise carry every page's
// images and forms into a copy that holds only some of the pages.

const RESOURCE_KINDS = ["XObject", "Font", "ExtGState", "Pattern", "Shading", "ColorSpace", "Properties"];
// Glyph procedures read per job (a Type3 font is copied whole, every glyph).
const GLYPHS_MAX = 2048;

function usedNames(buf, budget) {
	const used = Object.fromEntries(RESOURCE_KINDS.map((k) => [k, new Set()]));
	const lastName = (ops) => {
		for (let k = ops.length - 1; k >= 0; k--) if (ops[k].name !== undefined) return ops[k].name;
		return null;
	};
	const add = (kind, name) => { if (name) used[kind].add(name); };
	lexContent(buf, (op, ops) => {
		switch (op) {
			case "Do": add("XObject", lastName(ops)); break;
			case "Tf": add("Font", ops.length >= 2 ? ops[ops.length - 2].name : null); break;
			case "gs": add("ExtGState", lastName(ops)); break;
			case "sh": add("Shading", lastName(ops)); break;
			case "cs": case "CS": add("ColorSpace", lastName(ops)); break;
			case "scn": case "SCN": add("Pattern", lastName(ops)); break;
			case "BDC": case "DP": add("Properties", ops.length >= 2 ? ops[1].name : null); break;
			case "BI": for (const nm of ops[0].names) used.ColorSpace.add(nm); break;
			default: break;
		}
	}, budget);
	return used;
}

function entryNamed(lib, dict, name) {
	if (!(dict instanceof lib.PDFDict)) return undefined;
	for (const [key, value] of dict.entries()) if (plainName(key) === name) return value;
	return undefined;
}

function subtypeOf(lib, dict) {
	const s = dict && dict.lookup(lib.PDFName.of("Subtype"));
	return s instanceof lib.PDFName ? plainName(s) : "";
}

// A new resource dictionary holding, of each kind, only the names `used`
// lists, and the ProcSet; any other key is left out. Font, XObject and
// ExtGState are always there (pdf-lib's embedder reads them).
function prunedResources(lib, context, resources, used) {
	const { PDFDict, PDFName } = lib;
	const res = context.lookup(resources);
	const out = context.obj({});
	if (res instanceof PDFDict) {
		for (const [key, value] of res.entries()) {
			const k = plainName(key);
			if (k === "ProcSet") { out.set(key, value); continue; }
			if (!RESOURCE_KINDS.includes(k)) continue;
			const sub = context.lookup(value);
			const kept = context.obj({});
			if (sub instanceof PDFDict) for (const [name, v] of sub.entries()) if (used[k].has(plainName(name))) kept.set(name, v);
			out.set(PDFName.of(k), kept);
		}
	}
	for (const k of ["Font", "XObject", "ExtGState"]) if (!out.get(PDFName.of(k))) out.set(PDFName.of(k), context.obj({}));
	return out;
}

const noNames = () => Object.fromEntries(RESOURCE_KINDS.map((k) => [k, new Set()]));

// The names a content stream uses against `resources`, through everything it
// draws. A form (Do), a soft mask's group form (gs), a tiling pattern (scn) and
// a Type3 font's glyphs (Tf) are drawn with their own /Resources, cut down here
// in place to what their content uses (it is the same whoever draws it); one
// with none borrows the drawing context's, so its names count here. Every
// image, form, pattern and Type3 font (and glyph) reached is recorded in
// state.drawn: the copy may hold no other (prepare()'s page_isolation check).
function namesDrawn(lib, context, contentBuf, resources, state) {
	const used = noNames();
	const res = context.lookup(resources);
	const queue = [];
	const add = (names) => {
		for (const k of RESOURCE_KINDS) {
			for (const nm of names[k]) {
				if (used[k].has(nm)) continue;
				used[k].add(nm);
				queue.push([k, nm]);
			}
		}
	};
	add(usedNames(contentBuf, state.budget));
	while (queue.length) {
		const [kind, name] = queue.shift();
		const entry = entryNamed(lib, context.lookup(entryNamed(lib, res, kind)), name);
		for (const borrowed of resourceDraws(lib, context, kind, entry, state)) add(borrowed);
	}
	return used;
}

// What one named resource draws when content uses it, recorded in state.drawn;
// the names of what it draws with no /Resources of its own come back.
function resourceDraws(lib, context, kind, entry, state) {
	const { PDFRef, PDFDict, PDFRawStream, PDFName } = lib;
	const value = context.lookup(entry);
	if (kind === "XObject") {
		if (!(entry instanceof PDFRef) || !(value instanceof PDFRawStream)) return [];
		state.drawn.add(entry);
		if (subtypeOf(lib, value.dict) === "Form") return ownContent(lib, context, entry, value, state);
		// An image draws its masks with it.
		for (const k of ["SMask", "Mask"]) {
			const m = value.dict.get(PDFName.of(k));
			if (m instanceof PDFRef) state.drawn.add(m);
		}
		return [];
	}
	if (kind === "ExtGState") return value instanceof PDFDict ? stateDraws(lib, context, value, state) : [];
	if (kind === "Pattern") {
		if (value instanceof PDFRawStream && entry instanceof PDFRef) {
			state.drawn.add(entry);
			return ownContent(lib, context, entry, value, state);
		}
		// A shading pattern: its graphics state may hold a soft mask.
		const gs = value instanceof PDFDict ? context.lookup(value.get(PDFName.of("ExtGState"))) : undefined;
		return gs instanceof PDFDict ? stateDraws(lib, context, gs, state) : [];
	}
	if (kind === "Font") return fontDraws(lib, context, entry, state);
	return [];
}

// A graphics state's soft mask group and its /Font, drawn when it is set.
function stateDraws(lib, context, gs, state) {
	const { PDFRef, PDFDict, PDFArray, PDFRawStream, PDFName } = lib;
	const out = [];
	const mask = context.lookup(gs.get(PDFName.of("SMask")));
	const g = mask instanceof PDFDict ? mask.get(PDFName.of("G")) : undefined;
	const group = context.lookup(g);
	if (g instanceof PDFRef && group instanceof PDFRawStream) {
		state.drawn.add(g);
		out.push(...ownContent(lib, context, g, group, state));
	}
	const font = context.lookup(gs.get(PDFName.of("Font")));
	if (font instanceof PDFArray && font.size() >= 1) out.push(...fontDraws(lib, context, font.get(0), state));
	return out;
}

// A form, soft mask group or tiling pattern's content: with its own
// /Resources, read once and those cut down in place; without, its names come
// back to count in the drawing context.
function ownContent(lib, context, ref, stream, state) {
	const own = stream.dict.get(lib.PDFName.of("Resources"));
	if (own !== undefined && state.pruned.has(ref)) return [];
	if (++state.forms > FORMS_MAX) refuse("form_count");
	const bytes = contentBytes(lib, stream, false);
	countContent(state.limits, bytes.byteLength);
	const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (own === undefined) return [usedNames(buf, state.budget)];
	state.pruned.add(ref);
	if (state.depth >= FORM_DEPTH_MAX) refuse("form_depth");
	state.depth++;
	const inner = namesDrawn(lib, context, buf, own, state);
	state.depth--;
	stream.dict.set(lib.PDFName.of("Resources"), prunedResources(lib, context, own, inner));
	return [];
}

// A Type3 font's glyph procedures, every one (the font is copied whole): with
// the font's own /Resources, cut down in place to what any glyph uses; without,
// the glyphs' names come back to count in the drawing context.
function fontDraws(lib, context, entry, state) {
	const { PDFRef, PDFDict, PDFRawStream, PDFName } = lib;
	const font = context.lookup(entry);
	if (!(font instanceof PDFDict) || subtypeOf(lib, font) !== "Type3") return [];
	if (entry instanceof PDFRef) state.drawn.add(entry);
	const own = font.get(PDFName.of("Resources"));
	const key = entry instanceof PDFRef ? entry : font;
	if (own !== undefined) {
		if (state.pruned.has(key)) return [];
		state.pruned.add(key);
	}
	const procs = context.lookup(font.get(PDFName.of("CharProcs")));
	const union = noNames();
	const borrowed = [];
	if (procs instanceof PDFDict) {
		for (const [, p] of procs.entries()) {
			const glyph = context.lookup(p);
			if (!(p instanceof PDFRef) || !(glyph instanceof PDFRawStream)) continue;
			state.drawn.add(p);
			if (++state.glyphs > GLYPHS_MAX) refuse("glyph_count");
			const bytes = contentBytes(lib, glyph, false);
			countContent(state.limits, bytes.byteLength);
			const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			if (own === undefined) {
				borrowed.push(usedNames(buf, state.budget));
				continue;
			}
			if (state.depth >= FORM_DEPTH_MAX) refuse("form_depth");
			state.depth++;
			const inner = namesDrawn(lib, context, buf, own, state);
			state.depth--;
			for (const k of RESOURCE_KINDS) for (const nm of inner[k]) union[k].add(nm);
		}
	}
	if (own !== undefined) font.set(PDFName.of("Resources"), prunedResources(lib, context, own, union));
	return borrowed;
}

// A stream that draws on its own: an image (or anything sized like one), a
// form, a tiling pattern; never a halftone, function or shading.
function drawsOnItsOwn(lib, dict) {
	let sized = false;
	let support = false;
	for (const key of dict.keys()) {
		const k = plainName(key);
		if (k === "Width" || k === "Height" || k === "BBox" || k === "PatternType" || k === "FormType") sized = true;
		else if (k === "HalftoneType" || k === "FunctionType" || k === "ShadingType") support = true;
	}
	const type = dict.lookup(lib.PDFName.of("Type"));
	if (type instanceof lib.PDFName && plainName(type) === "XObject") return true;
	return ["Image", "Form", "PS"].includes(subtypeOf(lib, dict)) || (sized && !support);
}

// Every object of a source that draws something (bounded walk, before anything
// changes): each page's content streams, every stream drawsOnItsOwn() names,
// and every Type3 font with its glyph procedures, nested or not.
function drawingObjects(lib, src, pages, limits) {
	const { PDFDict, PDFArray, PDFRef, PDFName, PDFStream } = lib;
	const context = src.context;
	const out = new Set();
	let visits = 0;
	for (const [ref, obj] of context.enumerateIndirectObjects()) {
		if (obj instanceof PDFStream && drawsOnItsOwn(lib, obj.dict)) out.add(ref);
		const stack = [obj instanceof PDFStream ? obj.dict : obj];
		while (stack.length) {
			const v = stack.pop();
			if (++visits > limits.maxWalk) refuse("resource_graph");
			if (v instanceof PDFDict) {
				if (subtypeOf(lib, v) === "Type3") {
					if (v === obj) out.add(ref);
					const procs = context.lookup(v.get(PDFName.of("CharProcs")));
					if (procs instanceof PDFDict) for (const [, p] of procs.entries()) if (p instanceof PDFRef) out.add(p);
				}
				for (const [, x] of v.entries()) if (x instanceof PDFDict || x instanceof PDFArray) stack.push(x);
			} else if (v instanceof PDFArray) {
				for (const x of v.asArray()) if (x instanceof PDFDict || x instanceof PDFArray) stack.push(x);
			}
		}
	}
	for (const page of pages) {
		const c = page.node.get(PDFName.of("Contents"));
		if (c instanceof PDFRef) out.add(c);
		const list = context.lookup(c);
		if (list instanceof PDFArray) for (const x of list.asArray()) if (x instanceof PDFRef) out.add(x);
	}
	return out;
}

// Every indirect object reachable from `roots` (bounded).
function reachable(lib, context, roots, limits) {
	const { PDFRef, PDFDict, PDFArray, PDFStream } = lib;
	const seen = new Set();
	const stack = roots.slice();
	let visits = 0;
	while (stack.length) {
		const v = stack.pop();
		if (++visits > limits.maxWalk) refuse("resource_graph");
		if (v instanceof PDFRef) {
			if (seen.has(v)) continue;
			seen.add(v);
			const o = context.lookup(v);
			if (o !== undefined) stack.push(o);
		} else if (v instanceof PDFDict) {
			for (const [, x] of v.entries()) stack.push(x);
		} else if (v instanceof PDFArray) {
			for (const x of v.asArray()) stack.push(x);
		} else if (v instanceof PDFStream) {
			for (const [, x] of v.dict.entries()) stack.push(x);
		}
	}
	return seen;
}

// ---------------------------------------------------------------------------
// Fonts, read: the characters a show-text string draws and how far it moves.
// A code this cannot map (no ToUnicode entry and no known encoding) is shown
// as {hex} and marks the page unmapped: mis-decoded text never reads as text.

const WIN_ANSI_HIGH = {
	0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
	0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
	0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
	0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
const ENCODINGS = new Map();
function encodingTable(name) {
	if (ENCODINGS.has(name)) return ENCODINGS.get(name);
	let t = null;
	if (name === "WinAnsiEncoding" || name === "StandardEncoding" || name === "MacRomanEncoding") {
		t = new Array(256).fill(null);
		for (let c = 0x20; c <= 0x7e; c++) t[c] = String.fromCharCode(c);
		if (name === "WinAnsiEncoding") {
			for (const [c, u] of Object.entries(WIN_ANSI_HIGH)) t[Number(c)] = String.fromCharCode(u);
			for (let c = 0xa0; c <= 0xff; c++) t[c] = String.fromCharCode(c);
			t[0xa0] = " ";
			t[0xad] = "-";
		} else if (name === "StandardEncoding") {
			t[0x27] = "’";
			t[0x60] = "‘";
		}
	}
	ENCODINGS.set(name, t);
	return t;
}

const GLYPH_NAMES = (() => {
	const m = new Map();
	for (let c = 0x41; c <= 0x5a; c++) m.set(String.fromCharCode(c), String.fromCharCode(c));
	for (let c = 0x61; c <= 0x7a; c++) m.set(String.fromCharCode(c), String.fromCharCode(c));
	["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].forEach((n, i) => m.set(n, String(i)));
	const punct = {
		space: " ", exclam: "!", quotedbl: "\"", numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'",
		quoteright: "’", quoteleft: "‘", parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",",
		hyphen: "-", minus: "-", period: ".", slash: "/", colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">",
		question: "?", at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_",
		grave: "`", braceleft: "{", bar: "|", braceright: "}", asciitilde: "~", endash: "–", emdash: "—",
		bullet: "•", degree: "°", quotedblleft: "“", quotedblright: "”", ellipsis: "…",
		nbspace: " ", sfthyphen: "-", periodcentered: "·",
	};
	for (const [k, v] of Object.entries(punct)) m.set(k, v);
	return m;
})();
function glyphUnicode(name) {
	const base = String(name || "").split(".")[0];
	if (GLYPH_NAMES.has(base)) return GLYPH_NAMES.get(base);
	if (base.length === 7 && base.startsWith("uni")) {
		const cp = parseInt(base.slice(3), 16);
		return Number.isInteger(cp) && /^[0-9A-F]{4}$/.test(base.slice(3)) ? String.fromCharCode(cp) : null;
	}
	if (base.length >= 5 && base.length <= 7 && base[0] === "u" && /^[0-9A-F]+$/.test(base.slice(1))) {
		const cp = parseInt(base.slice(1), 16);
		return cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
	}
	return null;
}

const STANDARD_14 = new Map([
	["Helvetica", "Helvetica"], ["Helvetica-Bold", "Helvetica-Bold"], ["Helvetica-Oblique", "Helvetica-Oblique"],
	["Helvetica-BoldOblique", "Helvetica-BoldOblique"], ["Times-Roman", "Times-Roman"], ["Times-Bold", "Times-Bold"],
	["Times-Italic", "Times-Italic"], ["Times-BoldItalic", "Times-BoldItalic"], ["Courier", "Courier"],
	["Courier-Bold", "Courier-Bold"], ["Courier-Oblique", "Courier-Oblique"], ["Courier-BoldOblique", "Courier-BoldOblique"],
	["Arial", "Helvetica"], ["Arial,Bold", "Helvetica-Bold"], ["ArialMT", "Helvetica"], ["Arial-BoldMT", "Helvetica-Bold"],
	["TimesNewRoman", "Times-Roman"], ["TimesNewRomanPSMT", "Times-Roman"], ["CourierNew", "Courier"], ["CourierNewPSMT", "Courier"],
]);
const FONT_ENTRIES_MAX = 65_536;

// ToUnicode CMap: bfchar and bfrange entries, Map("<bytes>.<code>" -> text).
function parseToUnicode(buf) {
	const map = new Map();
	const lens = new Set();
	let mode = "";
	let pending = [];
	let i = 0;
	const n = buf.length;
	const flushRange = (lo, hi, dst) => {
		const L = lo.length;
		const a = lo.readUIntBE(0, Math.min(L, 4));
		const b = hi.readUIntBE(0, Math.min(hi.length, 4));
		if (L > 4 || b < a || b - a > FONT_ENTRIES_MAX || map.size + (b - a) > FONT_ENTRIES_MAX) return false;
		for (let c = a; c <= b; c++) {
			let text = null;
			if (Array.isArray(dst)) text = dst[c - a] ? utf16(dst[c - a]) : null;
			else if (dst && dst.length >= 2) {
				const units = [];
				for (let k = 0; k + 1 < dst.length; k += 2) units.push(dst.readUInt16BE(k));
				units[units.length - 1] += c - a;
				text = String.fromCharCode(...units);
			}
			if (text !== null) map.set(`${L}.${c}`, text);
		}
		return true;
	};
	const utf16 = (d) => {
		const units = [];
		for (let k = 0; k + 1 < d.length; k += 2) units.push(d.readUInt16BE(k));
		if (d.length % 2) units.push(d[d.length - 1]);
		return String.fromCharCode(...units);
	};
	let arr = null;
	while (i < n) {
		const c = buf[i];
		if (WS_BYTES[c]) { i++; continue; }
		if (c === 0x25) { while (i < n && buf[i] !== 0x0a && buf[i] !== 0x0d) i++; continue; }
		if (c === 0x3c && buf[i + 1] !== 0x3c) {
			const s = readHex(buf, i);
			i = s.end;
			if (arr) { if (arr.length < 512) arr.push(s.bytes); } else pending.push(s.bytes);
			continue;
		}
		if (c === 0x5b) { arr = []; i++; continue; }
		if (c === 0x5d) { if (arr) pending.push(arr); arr = null; i++; continue; }
		if (c === 0x28) { i = readLiteral(buf, i).end; continue; }
		if (c === 0x3c) { i = skipDict(buf, i); continue; }
		if (!isRegular(c)) { i++; continue; }
		let j = i;
		while (j < n && isRegular(buf[j])) j++;
		const word = buf.toString("latin1", i, Math.min(j, i + 40));
		i = j;
		if (word === "begincodespacerange" || word === "beginbfchar" || word === "beginbfrange") { mode = word; pending = []; continue; }
		if (word === "endcodespacerange") { for (let k = 0; k + 1 < pending.length; k += 2) if (Buffer.isBuffer(pending[k])) lens.add(pending[k].length); mode = ""; continue; }
		if (word === "endbfchar" && mode === "beginbfchar") {
			for (let k = 0; k + 1 < pending.length; k += 2) {
				const src = pending[k];
				const dst = pending[k + 1];
				if (!Buffer.isBuffer(src) || !Buffer.isBuffer(dst) || src.length > 4 || map.size >= FONT_ENTRIES_MAX) continue;
				map.set(`${src.length}.${src.readUIntBE(0, src.length || 1)}`, utf16(dst));
				lens.add(src.length);
			}
			mode = "";
			continue;
		}
		if (word === "endbfrange" && mode === "beginbfrange") {
			for (let k = 0; k + 2 < pending.length; k += 3) {
				const [lo, hi, dst] = [pending[k], pending[k + 1], pending[k + 2]];
				if (!Buffer.isBuffer(lo) || !Buffer.isBuffer(hi) || !lo.length) continue;
				if (!flushRange(lo, hi, dst)) return null;
				lens.add(lo.length);
			}
			mode = "";
		}
	}
	return { map, lens: [...lens].filter((l) => l >= 1 && l <= 4).sort((a, b) => a - b) };
}

// /W of a CIDFont: Map(cid -> width).
function cidWidths(lib, context, wArray) {
	const out = new Map();
	const w = context.lookup(wArray);
	if (!(w instanceof lib.PDFArray)) return out;
	const items = w.asArray().map((x) => context.lookup(x));
	for (let k = 0; k < items.length && out.size < FONT_ENTRIES_MAX;) {
		const first = items[k];
		if (!(first instanceof lib.PDFNumber)) break;
		const next = items[k + 1];
		if (next instanceof lib.PDFArray) {
			next.asArray().forEach((v, j) => { const x = context.lookup(v); if (x instanceof lib.PDFNumber) out.set(first.asNumber() + j, x.asNumber()); });
			k += 2;
		} else if (next instanceof lib.PDFNumber && items[k + 2] instanceof lib.PDFNumber) {
			const [a, b, wd] = [first.asNumber(), next.asNumber(), items[k + 2].asNumber()];
			if (b - a > FONT_ENTRIES_MAX) break;
			for (let c = a; c <= b && out.size < FONT_ENTRIES_MAX; c++) out.set(c, wd);
			k += 3;
		} else break;
	}
	return out;
}

// A font as the reader uses it: decode(bytes) -> [{ code, len, text|null, width }]
// (width in 1/1000 of the font size).
function fontReader(lib, context, fontDict, state) {
	const { PDFDict, PDFName, PDFArray, PDFNumber, PDFRawStream } = lib;
	const look = (d, k) => (d instanceof PDFDict ? d.lookup(PDFName.of(k)) : undefined);
	const sub = subtypeOf(lib, fontDict);
	let toUnicode = null;
	const tu = look(fontDict, "ToUnicode");
	if (tu instanceof PDFRawStream) {
		const bytes = contentBytes(lib, tu, false);
		countContent(state.limits, bytes.byteLength);
		toUnicode = parseToUnicode(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
	}
	if (sub === "Type0") {
		const desc = look(fontDict, "DescendantFonts");
		const cid = desc instanceof PDFArray ? context.lookup(desc.get(0)) : undefined;
		const dw = look(cid, "DW");
		const widths = cid instanceof PDFDict ? cidWidths(lib, context, cid.get(PDFName.of("W"))) : new Map();
		const defaultWidth = dw instanceof PDFNumber ? dw.asNumber() : 1000;
		const lens = toUnicode && toUnicode.lens.length ? toUnicode.lens : [2];
		return {
			decode(bytes) {
				const out = [];
				for (let i = 0; i < bytes.length;) {
					let hit = null;
					for (const L of lens) {
						if (i + L > bytes.length) break;
						const code = bytes.readUIntBE(i, L);
						const text = toUnicode ? toUnicode.map.get(`${L}.${code}`) : undefined;
						if (text !== undefined) { hit = { code, len: L, text }; break; }
					}
					if (!hit) {
						const L = Math.min(lens[lens.length - 1], bytes.length - i);
						hit = { code: bytes.readUIntBE(i, L || 1), len: L || 1, text: null };
					}
					hit.width = widths.has(hit.code) ? widths.get(hit.code) : defaultWidth;
					out.push(hit);
					i += hit.len;
				}
				return out;
			},
		};
	}
	// Simple fonts (Type1, TrueType, MMType1, Type3).
	const base = look(fontDict, "BaseFont");
	const baseName = base instanceof PDFName ? plainName(base).replace(/^[A-Z]{6}\+/, "") : "";
	const desc = look(fontDict, "FontDescriptor");
	const flags = look(desc, "Flags");
	const symbolic = flags instanceof PDFNumber && (flags.asNumber() & 4) !== 0;
	const enc = look(fontDict, "Encoding");
	let table = null;
	if (enc instanceof PDFName) table = encodingTable(plainName(enc));
	else if (enc instanceof PDFDict) {
		const be = look(enc, "BaseEncoding");
		table = (encodingTable(be instanceof PDFName ? plainName(be) : "StandardEncoding") || []).slice();
		const diff = look(enc, "Differences");
		if (diff instanceof PDFArray) {
			let code = 0;
			for (const item of diff.asArray().slice(0, 1024)) {
				const v = context.lookup(item);
				if (v instanceof PDFNumber) code = v.asNumber();
				else if (v instanceof PDFName && code >= 0 && code <= 255) table[code++] = glyphUnicode(plainName(v));
			}
		}
	} else if (sub !== "Type3" && !symbolic && baseName !== "Symbol" && baseName !== "ZapfDingbats") {
		// No /Encoding on a non-symbolic font: its standard encoding.
		table = encodingTable("StandardEncoding");
	}
	const firstChar = look(fontDict, "FirstChar");
	const widthsArr = look(fontDict, "Widths");
	const first = firstChar instanceof PDFNumber ? firstChar.asNumber() : 0;
	const widthList = widthsArr instanceof PDFArray ? widthsArr.asArray().slice(0, 256).map((x) => { const v = context.lookup(x); return v instanceof PDFNumber ? v.asNumber() : null; }) : null;
	const matrix = look(fontDict, "FontMatrix");
	const scale = sub === "Type3" && matrix instanceof PDFArray && context.lookup(matrix.get(0)) instanceof PDFNumber ? context.lookup(matrix.get(0)).asNumber() * 1000 : 1;
	let std = null;
	if (!widthList && STANDARD_14.has(baseName) && typeof lib.StandardFontEmbedder === "function") {
		try { std = lib.StandardFontEmbedder.for(STANDARD_14.get(baseName)); } catch { std = null; }
	}
	const missing = look(desc, "MissingWidth");
	const missingWidth = missing instanceof PDFNumber ? missing.asNumber() : 500;
	const stdWidths = new Map();
	return {
		decode(bytes) {
			const out = [];
			for (let i = 0; i < bytes.length; i++) {
				const code = bytes[i];
				let text = null;
				if (toUnicode) {
					const t = toUnicode.map.get(`1.${code}`);
					if (t !== undefined) text = t;
				}
				if (text === null && table) text = table[code] || null;
				let width = missingWidth;
				if (widthList && code - first >= 0 && code - first < widthList.length && widthList[code - first] !== null) width = widthList[code - first] * scale;
				else if (std && text) {
					if (!stdWidths.has(code)) {
						let wd = missingWidth;
						try { wd = std.widthOfTextAtSize(text, 1000); } catch { wd = missingWidth; }
						stdWidths.set(code, wd);
					}
					width = stdWidths.get(code);
				}
				out.push({ code, len: 1, text, width });
			}
			return out;
		},
	};
}

// ---------------------------------------------------------------------------
// One page's text: every show-text operator, placed in user space, grouped
// into lines top to bottom and left to right.

const PAGE_TEXT_MAX = 200_000;
const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
	m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
	m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
	m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const nums = (ops, k) => ops.slice(-k).map((o) => (typeof o.num === "number" ? o.num : 0));

function readPageText(lib, context, contents, resources, state) {
	const env = { chunks: [], chars: 0, unmapped: false, truncated: false };
	const fonts = new Map();
	const fontFor = (res, name) => {
		const fdict = entryNamed(lib, context.lookup(entryNamed(lib, context.lookup(res), "Font")), name);
		const key = fdict instanceof lib.PDFRef ? fdict : null;
		if (key && fonts.has(key)) return fonts.get(key);
		const dict = context.lookup(fdict);
		const reader = dict instanceof lib.PDFDict ? fontReader(lib, context, dict, state) : null;
		if (key) fonts.set(key, reader);
		return reader;
	};
	const run = (buf, res, ctm, depth) => {
		let gs = { ctm, font: null, size: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, rise: 0 };
		const saved = [];
		let tm = IDENTITY;
		let lm = IDENTITY;
		const show = (bytes) => {
			if (env.truncated) return;
			const reader = gs.font;
			const glyphs = reader ? reader.decode(Buffer.from(bytes)) : [...bytes].map((code) => ({ code, len: 1, text: null, width: 500 }));
			let text = "";
			let advance = 0;
			for (const g of glyphs) {
				if (g.text === null) {
					env.unmapped = true;
					text += `{${g.code.toString(16).padStart(g.len * 2, "0")}}`;
				} else text += g.text;
				advance += (g.width / 1000 * gs.size + gs.Tc + (g.len === 1 && g.code === 32 ? gs.Tw : 0)) * gs.Th;
			}
			const m = mul(mul([1, 0, 0, 1, 0, gs.rise], tm), gs.ctm);
			const end = mul(mul([1, 0, 0, 1, advance, gs.rise], tm), gs.ctm);
			const size = Math.abs(gs.size) * Math.hypot(m[2], m[3]) || 1;
			env.chunks.push({ x: m[4], y: m[5], endX: end[4], size, text });
			env.chars += text.length;
			if (env.chars > PAGE_TEXT_MAX) env.truncated = true;
			tm = mul([1, 0, 0, 1, advance, 0], tm);
		};
		const moveLine = (tx, ty) => { lm = mul([1, 0, 0, 1, tx, ty], lm); tm = lm; };
		lexContent(buf, (op, ops) => {
			switch (op) {
				case "q": if (saved.length < 256) saved.push({ ...gs }); break;
				case "Q": if (saved.length) gs = saved.pop(); break;
				case "cm": { const [a, b, c, d, e, f] = nums(ops, 6); gs.ctm = mul([a, b, c, d, e, f], gs.ctm); break; }
				case "BT": tm = IDENTITY; lm = IDENTITY; break;
				case "Tf": {
					const name = ops.length >= 2 ? ops[ops.length - 2].name : null;
					gs.font = name ? fontFor(res, name) : null;
					gs.size = nums(ops, 1)[0];
					break;
				}
				case "Tc": gs.Tc = nums(ops, 1)[0]; break;
				case "Tw": gs.Tw = nums(ops, 1)[0]; break;
				case "Tz": gs.Th = nums(ops, 1)[0] / 100; break;
				case "TL": gs.TL = nums(ops, 1)[0]; break;
				case "Ts": gs.rise = nums(ops, 1)[0]; break;
				case "Td": { const [tx, ty] = nums(ops, 2); moveLine(tx, ty); break; }
				case "TD": { const [tx, ty] = nums(ops, 2); gs.TL = -ty; moveLine(tx, ty); break; }
				case "Tm": { const [a, b, c, d, e, f] = nums(ops, 6); tm = [a, b, c, d, e, f]; lm = tm; break; }
				case "T*": moveLine(0, -gs.TL); break;
				case "Tj": { const s = ops[ops.length - 1]; if (s && s.str) show(s.str); break; }
				case "'": { moveLine(0, -gs.TL); const s = ops[ops.length - 1]; if (s && s.str) show(s.str); break; }
				case "\"": {
					const [aw, ac] = nums(ops.slice(0, -1), 2);
					gs.Tw = aw;
					gs.Tc = ac;
					moveLine(0, -gs.TL);
					const s = ops[ops.length - 1];
					if (s && s.str) show(s.str);
					break;
				}
				case "TJ": {
					const a = ops[ops.length - 1];
					if (!a || !a.arr) break;
					for (const item of a.arr) {
						if (item.str) show(item.str);
						else if (typeof item.num === "number") tm = mul([1, 0, 0, 1, -item.num / 1000 * gs.size * gs.Th, 0], tm);
					}
					break;
				}
				case "Do": {
					const name = ops.length ? ops[ops.length - 1].name : null;
					const ref = name ? entryNamed(lib, context.lookup(entryNamed(lib, context.lookup(res), "XObject")), name) : undefined;
					const x = ref instanceof lib.PDFRef ? context.lookup(ref) : undefined;
					if (!(x instanceof lib.PDFRawStream) || subtypeOf(lib, x.dict) !== "Form") break;
					if (depth >= FORM_DEPTH_MAX || ++state.forms > FORMS_MAX) refuse("form_depth");
					const bytes = contentBytes(lib, x, false);
					countContent(state.limits, bytes.byteLength);
					const fm = context.lookup(x.dict.get(lib.PDFName.of("Matrix")));
					const matrix = fm instanceof lib.PDFArray && fm.size() === 6
						? fm.asArray().map((v) => { const n = context.lookup(v); return n instanceof lib.PDFNumber ? n.asNumber() : 0; }) : IDENTITY;
					const own = x.dict.get(lib.PDFName.of("Resources"));
					run(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), own === undefined ? res : own, mul(matrix, gs.ctm), depth + 1);
					break;
				}
				default: break;
			}
		}, state.budget);
	};
	run(contents, resources, IDENTITY, 0);
	// Lines: top to bottom, then left to right; a gap wider than a fifth of the
	// text size is a space.
	const chunks = env.chunks.slice().sort((a, b) => b.y - a.y || a.x - b.x);
	const lines = [];
	let current = null;
	for (const ch of chunks) {
		if (!current || Math.abs(ch.y - current.y) > 0.4 * Math.max(ch.size, current.size, 1)) {
			current = { y: ch.y, size: ch.size, parts: [] };
			lines.push(current);
		}
		current.parts.push(ch);
	}
	const text = lines.map((l) => {
		l.parts.sort((a, b) => a.x - b.x);
		let s = "";
		let prev = null;
		for (const p of l.parts) {
			if (prev && p.x - prev.endX > 0.2 * Math.max(p.size, 1) && !s.endsWith(" ") && !p.text.startsWith(" ")) s += " ";
			s += p.text;
			prev = p;
		}
		return s;
	}).join("\n");
	return { text: text.slice(0, PAGE_TEXT_MAX), unmapped: env.unmapped, truncated: env.truncated };
}

// The "text" job.
async function pageTexts(modules, bytes, limits, scope) {
	const { lib } = modules;
	const { PDFDocument, ParseSpeeds } = lib;
	const invoice = scope === "invoice";
	const caps = invoice ? { ...limits, maxObjects: limits.mergeMaxObjects } : limits;
	job.limits = caps;
	job.loading = true;
	let src;
	try {
		src = await PDFDocument.load(bytes, { ...LOAD_OPTIONS, parseSpeed: ParseSpeeds.Fastest });
	} catch (err) {
		if (job.tripped) refuse(job.tripped);
		if (err && /\bis encrypted\b/.test(String(err.message).slice(0, 200))) refuse("encrypted");
		refuse("unparseable");
	} finally {
		job.loading = false;
	}
	if (job.tripped) refuse(job.tripped);
	const count = checkPageTree(lib, src, caps, invoice ? caps.mergeMaxSourcePages : caps.maxSourcePages);
	if (count === 0) refuse("no_pages");
	if (!invoice && count > caps.maxPages) refuse("too_many_pages");
	const state = { limits: caps, budget: { ops: 0 }, forms: 0 };
	const out = [];
	for (const page of src.getPages()) {
		const leaf = page.node;
		const contents = leaf.Contents();
		const parts = [];
		const list = !contents ? [] : contents instanceof lib.PDFArray ? contents.asArray() : [leaf.get(lib.PDFName.of("Contents"))];
		for (const c of list) {
			const s = src.context.lookup(c);
			if (!s) continue;
			const b = contentBytes(lib, s, true);
			countContent(caps, b.byteLength + 1);
			parts.push(Buffer.from(b.buffer, b.byteOffset, b.byteLength), Buffer.from("\n"));
		}
		const resources = leaf.getInheritableAttribute(lib.PDFName.of("Resources"));
		out.push(readPageText(lib, src.context, Buffer.concat(parts), resources, state));
	}
	if (job.tripped) refuse(job.tripped);
	return { pageCount: count, pages: out };
}

async function prepare(modules, bytes, limits, allowPages) {
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
	const allow = allowList(allowPages, pages.length);

	// With an allowlist, every object of the file that draws something is
	// listed before anything is changed: the copy may hold only those a copied
	// page draws (drawState.drawn).
	const drawing = allow ? drawingObjects(lib, src, pages, limits) : null;

	const ctx = { context: src.context, limits, jpegs: 0 };
	const out = await PDFDocument.create({ updateMetadata: false });
	const copier = PDFObjectCopier.for(src.context, out.context);
	const drawState = { limits, budget: { ops: 0 }, forms: 0, glyphs: 0, pruned: new Set(), depth: 0, drawn: new Set() };
	const copiedLeaves = [];

	for (const [pageIndex, page] of pages.entries()) {
		if (allow && !allow.has(pageIndex)) continue;
		const leaf = page.node;
		copiedLeaves.push(leaf);
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

		// The page's content streams are scanned together, as they are drawn:
		// pdf-lib joins them with a newline. Forms, patterns and glyph procedures
		// are each drawn on their own and are scanned one by one.
		const contents = leaf.Contents();
		if (!contents || typeof contents.asArray !== "function") refuse("page_contents");
		const pageParts = [];
		for (const c of contents.asArray()) {
			const bytes = contentBytes(lib, leaf.context.lookup(c), true);
			countContent(limits, bytes.byteLength + 1);
			pageParts.push(bytes, NEWLINE);
		}
		const pageContent = Buffer.concat(pageParts);
		if (allow) {
			// Only what this page draws goes with it.
			const own = leaf.get(PDFName.of("Resources"));
			const used = namesDrawn(lib, src.context, pageContent, own, drawState);
			leaf.set(PDFName.of("Resources"), prunedResources(lib, src.context, own, used));
		}
		// Clean everything the resources reach, then scan every content stream
		// (the page's own and every form, pattern and glyph procedure) for
		// inline images.
		const contentRefs = new Set();
		const resources = leaf.get(PDFName.of("Resources"));
		cleanResources(ctx, lib, stripImageMetadata, resources === undefined ? [] : [resources], contentRefs);
		if (inlineImageRefused(pageContent)) refuse("inline_image");
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

	if (drawing) {
		// Fail closed: the copy holds no page content, image, form, pattern or
		// Type3 font (or glyph) of the file that a copied page does not draw,
		// however it was reached.
		for (const key of copier.traversedObjects.keys()) {
			if (key instanceof lib.PDFRef && drawing.has(key) && !drawState.drawn.has(key)) refuse("page_isolation");
		}
	}

	const saved = await out.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
	if (saved.byteLength > limits.outputMax) refuse("output_too_large");
	const again = await PDFDocument.load(saved, LOAD_OPTIONS);
	if (again.getPageCount() !== copiedLeaves.length) refuse("post_scan_pages");
	const bad = postScan(lib, stripImageMetadata, again, limits);
	if (bad) refuse("post_scan");
	return { pdf: saved, pages: copiedLeaves.length, sourcePages: pages.length };
}

// The 0-based pages an allowlist keeps: null for every page (no list, or one
// naming every page); a list that is not 1-based, sorted, unique and inside
// the file is refused.
function allowList(allowPages, count) {
	if (allowPages === undefined || allowPages === null) return null;
	if (!Array.isArray(allowPages) || !allowPages.length || allowPages.length > count) refuse("allow_pages");
	let prev = 0;
	for (const p of allowPages) {
		if (!Number.isInteger(p) || p <= prev || p > count) refuse("allow_pages");
		prev = p;
	}
	return allowPages.length === count ? null : new Set(allowPages.map((p) => p - 1));
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
	const { PDFDocument, StandardFonts, ParseSpeeds } = lib;
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
		// prepare's output, read back from the cache: scanned again before a page of it is copied.
		if (postScan(lib, modules.stripImageMetadata, src, limits)) refuse("merge_recheck");
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
	const byAnchor = new Map();
	for (const { ins, src, n } of order) {
		const copied = await doc.copyPages(src, src.getPageIndices());
		const refs = [];
		copied.forEach((page, k) => {
			if (page.node.keys().some((key) => ["Annots", "AA"].includes(plainName(key)))) refuse("merge_recheck");
			doc.insertPage(after.get(ins.anchor) + 1 + k, page);
			labelPage(lib, page, `Receipt ${ins.index} of ${ins.total} - page ${k + 1} of ${n}`, font);
			insertedRefs.add(page.ref);
			refs.push(page.ref);
		});
		byAnchor.set(ins.anchor, refs);
	}
	const finalRefs = doc.getPages().map((p) => p.ref);
	const insertedIndices = finalRefs.map((r, i) => (insertedRefs.has(r) ? i : -1)).filter((i) => i >= 0);
	const positions = receipts.map(({ ins }) => ({
		anchor: ins.anchor,
		sheet: finalRefs.indexOf(pageRefs[after.get(ins.anchor)]),
		at: byAnchor.get(ins.anchor).map((r) => finalRefs.indexOf(r)),
	}));
	const saved = await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
	if (saved.byteLength > limits.mergeOutputMax) refuse("merge_too_large");
	const again = await load(saved);
	const pages = again.getPageCount();
	if (pages !== pageRefs.length + copiedPages || insertedIndices.length !== copiedPages) refuse("merge_recheck");
	const bad = mergeRecheck(lib, again, insertedIndices);
	if (bad) refuse(bad);
	return { pdf: saved, pages, inserted: copiedPages, placement, positions };
}

// The label in the strip prepare left at the top of a copied page.
function labelPage(lib, page, text, font) {
	const { PDFName, PDFArray, rgb } = lib;
	page.drawText(text, { x: MARGIN, y: LETTER[1] - STRIP + 10, size: LABEL_SIZE, font, color: rgb(0.2, 0.2, 0.2) });
	// Drawing may add an empty /Annots; anything else stays for the re-check.
	const annots = page.node.lookup(PDFName.of("Annots"));
	if (annots instanceof PDFArray && annots.size() === 0) page.node.delete(PDFName.of("Annots"));
}

const officeText = (n) => `${n} ${n === 1 ? "page" : "pages"} of this statement ${n === 1 ? "is" : "are"} kept by the office`;

// A receipt with no sheet (rule D): its pages go at the end of the invoice.
const END_ANCHOR_RE = /^end-([1-9][0-9]{0,2})$/;

// "PDF receipt on file: <its invoice line> - page x of y", the line cut short
// to fit the strip; printable ASCII only (the label font is WinAnsi).
function endLabel(font, line, k, n, withheld) {
	const tail = ` - page ${k} of ${n}${withheld ? ` - ${officeText(withheld)}` : ""}`;
	const room = LETTER[0] - 2 * MARGIN;
	const full = String(line || "").slice(0, 400).normalize("NFKD").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 160) || "this receipt";
	let middle = full;
	const text = () => `PDF receipt on file: ${middle}${middle === full ? "" : "..."}${tail}`;
	while (middle.length > 8 && font.widthOfTextAtSize(text(), LABEL_SIZE) > room) middle = middle.slice(0, -1).trimEnd();
	return text();
}

// Deletes every indirect object the trailer's Root and Info no longer reach:
// a removed page's content, forms and images leave the file with it.
function dropUnreachable(lib, doc, limits) {
	const t = doc.context.trailerInfo || {};
	const keep = reachable(lib, doc.context, [t.Root, t.Info].filter((r) => r !== undefined), limits);
	for (const [ref] of doc.context.enumerateIndirectObjects()) if (!keep.has(ref)) doc.context.delete(ref);
}

// The pages-only path (driver privacy D10). plan: { remove: [page indexes of
// the stored invoice's copied receipt pages], receipts: [{ anchor, index,
// total, sheet (index of its sheet in the stored invoice), pdf (prepare's
// output, or null: none of its pages is released), withheld }, or for a
// receipt with no sheet { anchor: "end-K", sheet: -1, label (its invoice
// line), pdf, withheld }] }. Every other page stays as the same object, never
// drawn again.
async function rebuild(modules, bytes, plan, limits) {
	const { lib } = modules;
	const { PDFDocument, StandardFonts, ParseSpeeds } = lib;
	job.limits = { ...limits, maxObjects: limits.mergeMaxObjects };
	const load = async (input) => {
		let loaded = null;
		job.loading = true;
		try {
			loaded = await PDFDocument.load(input, { ...LOAD_OPTIONS, parseSpeed: ParseSpeeds.Fastest });
		} catch {
			if (job.tripped) refuse(job.tripped);
			refuse("rebuild_unparseable");
		} finally {
			job.loading = false;
		}
		if (!(loaded.catalog instanceof lib.PDFDict)) refuse("rebuild_unparseable");
		return loaded;
	};
	const doc = await load(bytes);
	const count = checkPageTree(lib, doc, limits, limits.mergeMaxSourcePages);
	const p = plan && typeof plan === "object" ? plan : {};
	const remove = Array.isArray(p.remove) ? p.remove : null;
	const list = Array.isArray(p.receipts) ? p.receipts : null;
	if (!remove || !list || !list.length || list.length > 2 * limits.mergeMaxInserts) refuse("rebuild_plan");
	if (new Set(remove).size !== remove.length || remove.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) refuse("rebuild_plan");
	const removed = new Set(remove);
	const receipts = [];
	const anchors = new Set();
	const sheets = new Set();
	let copiedPages = 0;
	let noticePages = 0;
	let insertBytes = 0;
	for (const r of list) {
		const end = !!r && r.sheet === -1;
		const m = r && (end ? END_ANCHOR_RE : RECEIPT_ANCHOR_RE).exec(String(r.anchor || ""));
		if (!m || anchors.has(r.anchor) || !Number.isInteger(r.withheld) || r.withheld < 0 || r.withheld > limits.maxSourcePages
			|| (r.pdf !== null && !(r.pdf instanceof Uint8Array))) refuse("rebuild_plan");
		if (end ? typeof r.label !== "string"
			: Number(m[1]) !== r.index || !Number.isInteger(r.total) || r.index > r.total
				|| !Number.isInteger(r.sheet) || r.sheet < 0 || r.sheet >= count || removed.has(r.sheet) || sheets.has(r.sheet)) refuse("rebuild_plan");
		anchors.add(r.anchor);
		if (!end) sheets.add(r.sheet);
		let src = null;
		let n = 0;
		if (r.pdf) {
			insertBytes += r.pdf.byteLength;
			src = await load(r.pdf);
			n = checkPageTree(lib, src, limits, limits.maxPages);
			if (n < 1) refuse("rebuild_plan");
			if (postScan(lib, modules.stripImageMetadata, src, limits)) refuse("merge_recheck");
		} else if (!end) {
			noticePages += 1;
		}
		copiedPages += n;
		receipts.push({ r, src, n, end });
	}
	if (insertBytes > limits.insertMax) refuse("merge_size_cap");
	// The invoice's copied pages count against its cap; the notice pages apart.
	if (copiedPages > limits.invoiceMaxPages || noticePages > limits.mergeMaxInserts) refuse("merge_page_cap");
	if (job.tripped) refuse(job.tripped);

	const pageRefs = doc.getPages().map((pg) => pg.ref);
	if (pageRefs.length !== count) refuse("rebuild_unparseable");
	for (const i of [...remove].sort((a, b) => b - a)) doc.removePage(i);
	// pdf-lib 1.17.1's removePage() leaves its page list stale.
	if (doc.pageCache && typeof doc.pageCache.invalidate === "function") doc.pageCache.invalidate();
	dropUnreachable(lib, doc, limits);
	const keptRefs = doc.getPages().map((pg) => pg.ref);
	if (keptRefs.length !== count - remove.length || keptRefs.some((r) => removed.has(pageRefs.indexOf(r)))) refuse("rebuild_unparseable");

	const font = await doc.embedFont(StandardFonts.Helvetica);
	const sheetRef = (r) => pageRefs[r.sheet];
	const order = receipts.filter((x) => !x.end).sort((a, b) => keptRefs.indexOf(sheetRef(b.r)) - keptRefs.indexOf(sheetRef(a.r)));
	const insertedRefs = new Set();
	const byAnchor = new Map();
	for (const { r, src, n } of order) {
		const at = doc.getPages().findIndex((pg) => pg.ref === sheetRef(r));
		if (at < 0) refuse("rebuild_unparseable");
		const refs = [];
		const tail = r.withheld ? ` - ${officeText(r.withheld)}` : "";
		if (src) {
			const copied = await doc.copyPages(src, src.getPageIndices());
			copied.forEach((page, k) => {
				if (page.node.keys().some((key) => ["Annots", "AA"].includes(plainName(key)))) refuse("merge_recheck");
				doc.insertPage(at + 1 + k, page);
				labelPage(lib, page, `Receipt ${r.index} of ${r.total} - page ${k + 1} of ${n}${tail}`, font);
				refs.push(page.ref);
			});
		} else {
			const page = doc.insertPage(at + 1, LETTER);
			labelPage(lib, page, `Receipt ${r.index} of ${r.total} - ${officeText(Math.max(1, r.withheld))}`, font);
			refs.push(page.ref);
		}
		for (const ref of refs) insertedRefs.add(ref);
		byAnchor.set(r.anchor, refs);
	}
	// Receipts with no sheet last, after every other page, in plan order.
	for (const { r, src, n } of receipts.filter((x) => x.end)) {
		const refs = [];
		if (src) {
			const copied = await doc.copyPages(src, src.getPageIndices());
			copied.forEach((page, k) => {
				if (page.node.keys().some((key) => ["Annots", "AA"].includes(plainName(key)))) refuse("merge_recheck");
				doc.addPage(page);
				labelPage(lib, page, endLabel(font, r.label, k + 1, n, r.withheld), font);
				refs.push(page.ref);
			});
		}
		for (const ref of refs) insertedRefs.add(ref);
		byAnchor.set(r.anchor, refs);
	}
	const finalRefs = doc.getPages().map((pg) => pg.ref);
	const insertedIndices = finalRefs.map((r, i) => (insertedRefs.has(r) ? i : -1)).filter((i) => i >= 0);
	const positions = receipts.map(({ r, end }) => ({ anchor: r.anchor, sheet: end ? -1 : finalRefs.indexOf(sheetRef(r)), at: byAnchor.get(r.anchor).map((x) => finalRefs.indexOf(x)) }));
	const saved = await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
	if (saved.byteLength > limits.mergeOutputMax) refuse("merge_too_large");
	const again = await load(saved);
	const pages = again.getPageCount();
	if (pages !== keptRefs.length + insertedRefs.size || insertedIndices.length !== insertedRefs.size) refuse("merge_recheck");
	const bad = mergeRecheck(lib, again, insertedIndices);
	if (bad) refuse(bad);
	return { pdf: saved, pages, positions };
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
			const r = message.kind === "merge" ? await merge(modules, bytes, message.inserts, limits)
				: message.kind === "text" ? await pageTexts(modules, bytes, limits, message.scope)
					: message.kind === "rebuild" ? await rebuild(modules, bytes, message.plan, limits)
						: await prepare(modules, bytes, limits, message.allowPages);
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
	if (["prepare", "merge", "text", "rebuild"].includes(message.kind)) return run();
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
module.exports = { inlineImageRefused, plainName, cleanJpeg, postScan, mergeRecheck, installDecodeCap, hookInstalled, STRIP_KEYS, SCAN_KEYS, DEFAULT_LIMITS, lexContent, parseToUnicode, numberOf };
